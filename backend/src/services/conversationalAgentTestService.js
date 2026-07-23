import { createHash, randomUUID } from 'node:crypto'
import { db } from '../config/database.js'
import { createInternalNotification } from './notificationsService.js'
import { getLocalFreeSlots } from './localCalendarService.js'
import {
  getConversationalCapability
} from '../agents/conversational/nativeRuntimeConfig.js'
import { invokeController, toToolResult } from '../agents/invokeController.js'
import { runBoundedAppointmentControllerRequest } from './appointmentControllerRetryService.js'
import {
  TEST_APPOINTMENT_CHECKPOINT_INTERRUPTED_FAILURE_KIND,
  TEST_APPOINTMENT_PROVIDER_SYNC_FAILURE_KIND,
  inspectAppointmentCreationRequestRecoveryState
} from './appointmentCreationSafetyService.js'
import { createAppointment } from '../controllers/calendarsController.js'
import {
  cleanupConversationalAgentTestPaymentLink,
  createConversationalAgentTestPaymentLink,
  syncConversationalAgentTestPaymentLink
} from './conversationalAgentTestPaymentService.js'
import { cleanupConversationalTestAppointment } from './conversationalAppointmentTestCleanupService.js'
import {
  assignConversationalAgentTestContact,
  cleanupConversationalAgentTestAssignment
} from './conversationalAgentTestAssignmentService.js'
import { withConversationalAgentTestMutationLock } from './conversationalAgentTestMutationLockService.js'
import { resolveConversationalAgentTestContact } from './conversationalAgentTestContactService.js'
import { getAccountTimezone, normalizeDateOnlyInTimezone } from '../utils/dateUtils.js'
import { getAccountCurrency } from '../utils/accountLocale.js'
import { logger } from '../utils/logger.js'
import {
  CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT,
  CONVERSATIONAL_APPOINTMENT_SELECTION_PROGRESS_EVENT,
  buildConversationalAppointmentPreviewOfferEventId,
  buildConversationalAppointmentPreviewScopeId,
  cleanupConversationalAppointmentPreviewOffers
} from './conversationalAppointmentPreviewOfferService.js'

const TEST_RUN_ID_PATTERN = /^[A-Za-z0-9_-]{12,160}$/
const TEST_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{8,160}$/
const TEST_RUN_TTL_MS = 2 * 60 * 60 * 1000
// Debe exceder holgadamente los timeouts de las pasarelas/calendarios. El claim
// se toma dentro del candado distribuido, así que un retry no puede robarlo
// mientras el efecto externo legítimo sigue en vuelo.
const TEST_EFFECT_LEASE_MS = 10 * 60 * 1000
const TEST_NOTIFICATION_STALE_MS = 5 * 60 * 1000
const TEST_APPOINTMENT_EFFECT_LOCK_WAIT_MS = 20 * 1000
const TEST_APPOINTMENT_EFFECT_LOCK_RETRY_MS = 50
const TEST_TURN_LEASE_MS = 60 * 1000
const TEST_TURN_HEARTBEAT_MS = 10 * 1000
const TEST_TURN_WAIT_MS = TEST_TURN_LEASE_MS + 15 * 1000
const TEST_TURN_POLL_MS = 75
const TEST_TURN_MATERIALIZATION_WAIT_MS = 60 * 1000
const TEST_APPOINTMENT_PROGRESS_TTL_MS = 24 * 60 * 60 * 1000
const TEST_SLOT_NO_LONGER_FREE_CODE = 'test_slot_no_longer_free'
const TEST_APPOINTMENT_SELECTION_EVENT = 'appointment_slot_selection_verified'
const TEST_TURN_LEASE_VALUE_SQL = process.env.DATABASE_URL
  ? "CURRENT_TIMESTAMP + INTERVAL '60 seconds'"
  : "DATETIME(CURRENT_TIMESTAMP, '+60 seconds')"
const TEST_TURN_LEASE_EXPIRED_SQL = process.env.DATABASE_URL
  ? 'lease_until_at <= CURRENT_TIMESTAMP'
  : 'DATETIME(lease_until_at) <= CURRENT_TIMESTAMP'
const TERMINAL_TEST_EFFECT_FAILURE_CODES = new Set([
  TEST_SLOT_NO_LONGER_FREE_CODE,
  'test_appointment_checkpoint_interrupted',
  'test_appointment_provider_sync_failed'
])
const RETRYABLE_TEST_EFFECT_FAILURE_CODES = new Set([
  'test_effect_claim_lost',
  'test_appointment_offer_materialize_failed',
  'test_appointment_offer_materialize_race',
  'test_appointment_progress_materialize_race',
  'test_payment_creation_in_progress',
  'test_payment_creation_race',
  'test_payment_claim_lost',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'DATABASE_CONNECTION_LOST',
  'DATABASE_OPERATION_TIMEOUT'
])
const RETRYABLE_TEST_EFFECT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
const RETRYABLE_TEST_EFFECT_NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT'
])
const TERMINAL_TEST_EFFECT_STATUSES = new Set([
  'recorded',
  'prepared',
  'paid_test',
  'cleaned',
  'retained_paid_test'
])

let createAppointmentControllerImpl = createAppointment

function cleanString(value) {
  return String(value ?? '').trim()
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  if (typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function mutationCount(result) {
  return Number(result?.changes ?? result?.rowCount ?? 0)
}

function testError(message, statusCode = 400, code = 'invalid_test_run') {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex')
}

function normalizeIdentifier(value, pattern, label) {
  const normalized = cleanString(value)
  if (!pattern.test(normalized)) {
    throw testError(`${label} no es válido. Reinicia la prueba e inténtalo otra vez.`, 400, 'invalid_test_identity')
  }
  return normalized
}

function toIso(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value)
  return date.toISOString()
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nullableBoolean(value) {
  if (value === null || value === undefined || value === '') return null
  if (value === true || value === 1 || value === '1') return true
  if (value === false || value === 0 || value === '0') return false
  return null
}

function isRetryableTestEffectError(error) {
  if (typeof error?.retryable === 'boolean') return error.retryable
  const code = cleanString(error?.code || error?.cause?.code)
  if (TERMINAL_TEST_EFFECT_FAILURE_CODES.has(code)) return false
  if (RETRYABLE_TEST_EFFECT_FAILURE_CODES.has(code) || RETRYABLE_TEST_EFFECT_NETWORK_CODES.has(code.toUpperCase())) {
    return true
  }
  const statusCode = Number(error?.statusCode ?? error?.status)
  if (RETRYABLE_TEST_EFFECT_HTTP_STATUSES.has(statusCode)) return true
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) return false
  // Las validaciones de negocio creadas por este servicio siempre traen 4xx.
  // Un error sin clasificación suele venir de DB/red/proveedor y se conserva
  // recuperable para no congelar como definitivo un side effect ambiguo.
  return true
}

function isTerminalFailedTestEffectRow(effect) {
  if (cleanString(effect?.status).toLowerCase() !== 'failed') return false
  const persistedRetryable = nullableBoolean(effect?.error_retryable)
  if (persistedRetryable !== null) return persistedRetryable === false
  if (cleanString(effect?.error_code) === TEST_SLOT_NO_LONGER_FREE_CODE) {
    return parseJson(effect?.payload_json, {}).appointmentDateRestored === true
  }
  return false
}

export function isConversationalAgentTestMaterializationTerminal(testEffects = []) {
  return !(Array.isArray(testEffects) ? testEffects : []).some((effect) => {
    const status = cleanString(effect?.status).toLowerCase()
    if (['processing', 'pending'].includes(status)) return true
    return status === 'failed' && effect?.retryable === true
  })
}

function stableJsonStringify(value) {
  const ancestors = new WeakSet()
  const normalize = (current) => {
    if (!current || typeof current !== 'object') return current
    if (ancestors.has(current)) {
      throw testError('La solicitud de prueba contiene una referencia circular.', 400, 'invalid_test_turn_payload')
    }
    ancestors.add(current)
    const normalized = Array.isArray(current)
      ? current.map((item) => normalize(item))
      : Object.keys(current).sort().reduce((result, key) => {
          if (current[key] !== undefined) result[key] = normalize(current[key])
          return result
        }, {})
    ancestors.delete(current)
    return normalized
  }
  return JSON.stringify(normalize(value))
}

export function buildConversationalAgentTestTurnRequestHash(value = {}) {
  return sha256(stableJsonStringify(value))
}

function parseTurnObject(value) {
  const parsed = parseJson(value, null)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
}

export async function replayCompletedConversationalAgentTestTurn({
  testRunId,
  testMessageId,
  requestedByUserId,
  clientRequestHash
} = {}) {
  const runId = normalizeIdentifier(testRunId, TEST_RUN_ID_PATTERN, 'La sesión de prueba')
  const messageId = normalizeIdentifier(testMessageId, TEST_MESSAGE_ID_PATTERN, 'El mensaje de prueba')
  const normalizedClientHash = cleanString(clientRequestHash).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(normalizedClientHash)) {
    throw testError('La identidad del request de prueba no es válida.', 400, 'invalid_test_turn_hash')
  }
  const row = await db.get(
    `SELECT t.status, t.response_json, t.client_request_hash,
            r.requested_by_user_id, r.status AS run_status, r.expires_at
     FROM conversational_agent_test_turns t
     INNER JOIN conversational_agent_test_runs r ON r.id = t.run_id
     WHERE t.run_id = ? AND t.message_id = ?`,
    [runId, messageId]
  )
  if (!row) return null
  if (cleanString(row.requested_by_user_id) !== cleanString(requestedByUserId)) {
    throw testError('Esta prueba ya no existe o pertenece a otro usuario.', 404, 'test_run_not_found')
  }
  if (cleanString(row.run_status).toLowerCase() !== 'active' || Date.parse(row.expires_at || '') <= Date.now()) {
    return null
  }
  const storedClientHash = cleanString(row.client_request_hash).toLowerCase()
  if (!storedClientHash) return null
  if (storedClientHash && storedClientHash !== normalizedClientHash) {
    throw testError(
      'Este mensaje de prueba ya fue usado con otro contenido. Reinicia la prueba para evitar respuestas cruzadas.',
      409,
      'test_turn_payload_mismatch'
    )
  }
  if (cleanString(row.status).toLowerCase() !== 'completed') return null
  const response = parseTurnObject(row.response_json)
  // El executor sabe invalidar por CAS una respuesta rota y retomar el preview
  // durable. El fast-path no debe adelantarse con un 500 que impida llegar a
  // esa recuperación.
  if (!response) return null
  return response
}

/**
 * Ejecuta preview, efectos y respuesta como una sola unidad idempotente. El
 * claim con lease evita dos dueños vivos sin reservar una conexión mientras la
 * IA responde. preview_result_json permite retomar un proceso muerto sin volver
 * a consultar al modelo ni cambiar sus acciones.
 */
export async function executeConversationalAgentTestTurn({
  runContext,
  requestHash,
  createPreview,
  materializePreview
} = {}) {
  const normalizedRequestHash = cleanString(requestHash).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(normalizedRequestHash)) {
    throw testError('La identidad del contenido de esta prueba no es válida.', 400, 'invalid_test_turn_hash')
  }
  if (typeof createPreview !== 'function' || typeof materializePreview !== 'function') {
    throw testError('El pipeline del turno de prueba está incompleto.', 500, 'invalid_test_turn_pipeline')
  }

  const runId = normalizeIdentifier(runContext?.id, TEST_RUN_ID_PATTERN, 'La sesión de prueba')
  const messageId = normalizeIdentifier(runContext?.messageId, TEST_MESSAGE_ID_PATTERN, 'El mensaje de prueba')
  const turnId = `catt_${sha256(`${runId}\u0000${messageId}`).slice(0, 48)}`
  const initialClaimToken = randomUUID()
  const inserted = await db.run(
    `INSERT INTO conversational_agent_test_turns (
       id, run_id, message_id, request_hash, status, attempt_count,
       claim_token, lease_until_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'processing', 1, ?, ${TEST_TURN_LEASE_VALUE_SQL}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO NOTHING`,
    [turnId, runId, messageId, normalizedRequestHash, initialClaimToken]
  )
  let claimToken = mutationCount(inserted) === 1 ? initialClaimToken : ''
  let row = null
  const waitDeadline = Date.now() + TEST_TURN_WAIT_MS
  let claimPollAttempt = 0

  while (!claimToken) {
    row = await db.get(
      `SELECT *, CASE WHEN lease_until_at IS NULL OR ${TEST_TURN_LEASE_EXPIRED_SQL}
         THEN 1 ELSE 0 END AS lease_expired
       FROM conversational_agent_test_turns WHERE run_id = ? AND message_id = ?`,
      [runId, messageId]
    )
    if (!row || cleanString(row.id) !== turnId) {
      throw testError('No se pudo recuperar la identidad durable del turno de prueba.', 500, 'test_turn_identity_missing')
    }
    if (cleanString(row.request_hash).toLowerCase() !== normalizedRequestHash) {
      throw testError(
        'Este mensaje de prueba ya fue usado con otro contenido. Reinicia la prueba para evitar respuestas cruzadas.',
        409,
        'test_turn_payload_mismatch'
      )
    }

    const status = cleanString(row.status).toLowerCase()
    if (status === 'completed') {
      const storedResponse = parseTurnObject(row.response_json)
      if (storedResponse) return { response: storedResponse, replayed: true, recovered: false }
      const invalidated = await db.run(
        `UPDATE conversational_agent_test_turns
         SET status = 'failed', error_code = 'test_turn_response_corrupt', last_error = ?,
             claim_token = NULL, lease_until_at = NULL, completed_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'completed' AND request_hash = ?
           AND COALESCE(response_json, '') = ?`,
        [
          'La respuesta final guardada no era legible; se retomará desde el preview durable.',
          turnId,
          normalizedRequestHash,
          row.response_json ?? ''
        ]
      )
      if (mutationCount(invalidated) !== 1) continue
      row.status = 'failed'
    }

    const currentStatus = cleanString(row.status).toLowerCase()
    const leaseExpired = Number(row.lease_expired) === 1 || row.lease_expired === true
    if (currentStatus === 'pending' || currentStatus === 'failed' || (currentStatus === 'processing' && leaseExpired)) {
      const nextClaimToken = randomUUID()
      const claimed = currentStatus === 'pending'
        ? await db.run(
            `UPDATE conversational_agent_test_turns
             SET status = 'processing', claim_token = ?, lease_until_at = ${TEST_TURN_LEASE_VALUE_SQL},
                 attempt_count = attempt_count + 1, error_code = NULL, last_error = NULL,
                 completed_at = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND request_hash = ? AND status = 'pending'`,
            [nextClaimToken, turnId, normalizedRequestHash]
          )
        : currentStatus === 'failed'
        ? await db.run(
            `UPDATE conversational_agent_test_turns
             SET status = 'processing', claim_token = ?, lease_until_at = ${TEST_TURN_LEASE_VALUE_SQL},
                 attempt_count = attempt_count + 1, error_code = NULL, last_error = NULL,
                 completed_at = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND request_hash = ? AND status = 'failed'`,
            [nextClaimToken, turnId, normalizedRequestHash]
          )
        : await db.run(
            `UPDATE conversational_agent_test_turns
             SET claim_token = ?, lease_until_at = ${TEST_TURN_LEASE_VALUE_SQL}, attempt_count = attempt_count + 1,
                 error_code = NULL, last_error = NULL, completed_at = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND request_hash = ? AND status = 'processing'
               AND COALESCE(claim_token, '') = ? AND (lease_until_at IS NULL OR ${TEST_TURN_LEASE_EXPIRED_SQL})`,
            [nextClaimToken, turnId, normalizedRequestHash, cleanString(row.claim_token)]
          )
      if (mutationCount(claimed) === 1) {
        claimToken = nextClaimToken
        break
      }
      continue
    }
    if (currentStatus !== 'processing') {
      throw testError('El turno de prueba quedó en un estado desconocido.', 500, 'test_turn_state_invalid')
    }
    if (Date.now() >= waitDeadline) {
      throw testError(
        'Este mismo mensaje de prueba todavía se está procesando. Conserva el mensaje y vuelve a consultar en un momento.',
        503,
        'test_turn_processing'
      )
    }
    const pollDelay = Math.min(1_000, Math.round(TEST_TURN_POLL_MS * (1.35 ** claimPollAttempt)))
    claimPollAttempt += 1
    await wait(pollDelay + Math.floor(Math.random() * 50))
  }

  row = await db.get('SELECT * FROM conversational_agent_test_turns WHERE id = ?', [turnId])
  if (!row || cleanString(row.claim_token) !== claimToken || cleanString(row.status) !== 'processing') {
    throw testError('Se perdió el dueño antes de iniciar el turno de prueba.', 409, 'test_turn_claim_lost')
  }

  let heartbeatStopped = false
  let heartbeatLost = false
  let heartbeatPromise = null
  const pulseHeartbeat = async ({ required = false } = {}) => {
    if (heartbeatStopped || heartbeatLost) {
      if (required) throw testError('Se perdió el dueño del turno de prueba.', 409, 'test_turn_claim_lost')
      return false
    }
    if (heartbeatPromise) {
      const activeResult = await heartbeatPromise
      if (required && !activeResult) {
        throw testError('No se pudo renovar el dueño del turno de prueba.', 503, 'test_turn_heartbeat_failed')
      }
      return activeResult
    }
    heartbeatPromise = (async () => {
      try {
        const renewed = await db.run(
          `UPDATE conversational_agent_test_turns
           SET lease_until_at = ${TEST_TURN_LEASE_VALUE_SQL}, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND request_hash = ? AND status = 'processing' AND claim_token = ?`,
          [turnId, normalizedRequestHash, claimToken]
        )
        if (mutationCount(renewed) !== 1) {
          heartbeatLost = true
          return false
        }
        return true
      } catch (error) {
        if (required) throw error
        logger.warn(`[Tester agente] No se pudo renovar el turno ${turnId}: ${error.message}`)
        return false
      }
    })()
    try {
      const result = await heartbeatPromise
      if (required && !result) {
        throw testError('No se pudo renovar el dueño del turno de prueba.', 503, 'test_turn_heartbeat_failed')
      }
      return result
    } finally {
      heartbeatPromise = null
    }
  }
  const heartbeatTimer = setInterval(() => {
    void pulseHeartbeat().catch((error) => {
      logger.warn(`[Tester agente] Falló el heartbeat en segundo plano para ${turnId}: ${error.message}`)
    })
  }, TEST_TURN_HEARTBEAT_MS)
  heartbeatTimer.unref?.()

  let previewResult = parseTurnObject(row.preview_result_json)
  const recovered = Boolean(previewResult)
  try {
    if (!previewResult) {
      previewResult = await createPreview()
      const previewJson = JSON.stringify(previewResult)
      previewResult = parseTurnObject(previewJson)
      if (!previewResult) {
        throw testError('La IA no devolvió un preview durable válido.', 502, 'test_turn_preview_invalid')
      }
      const checkpointed = await db.run(
        `UPDATE conversational_agent_test_turns
         SET preview_result_json = ?, lease_until_at = ${TEST_TURN_LEASE_VALUE_SQL}, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'processing' AND claim_token = ? AND request_hash = ?`,
        [previewJson, turnId, claimToken, normalizedRequestHash]
      )
      if (mutationCount(checkpointed) !== 1) {
        throw testError('Se perdió el dueño antes de guardar el preview de prueba.', 409, 'test_turn_claim_lost')
      }
    }

    const materializationDeadline = Date.now() + TEST_TURN_MATERIALIZATION_WAIT_MS
    let response = null
    let materializationPollAttempt = 0
    while (!response) {
      await pulseHeartbeat({ required: true })
      const materialized = await materializePreview(previewResult)
      const isEnvelope = cleanString(materialized?.kind) === 'conversational_agent_test_turn_materialization'
      const terminal = !isEnvelope || materialized.terminal === true
      const candidate = isEnvelope ? materialized.response : materialized
      if (terminal) {
        const responseJson = JSON.stringify(candidate)
        response = parseTurnObject(responseJson)
        if (!response) {
          throw testError('El turno no produjo una respuesta final durable.', 502, 'test_turn_response_invalid')
        }
        const completed = await db.run(
          `UPDATE conversational_agent_test_turns
           SET status = 'completed', response_json = ?, claim_token = NULL, lease_until_at = NULL,
               error_code = NULL, last_error = NULL, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'processing' AND claim_token = ? AND request_hash = ?`,
          [responseJson, turnId, claimToken, normalizedRequestHash]
        )
        if (mutationCount(completed) !== 1) {
          const current = await db.get('SELECT * FROM conversational_agent_test_turns WHERE id = ?', [turnId])
          const storedResponse = cleanString(current?.status) === 'completed'
            ? parseTurnObject(current?.response_json)
            : null
          if (storedResponse) return { response: storedResponse, replayed: true, recovered }
          throw testError('Se perdió el dueño antes de cerrar el turno de prueba.', 409, 'test_turn_claim_lost')
        }
        return { response, replayed: false, recovered }
      }
      if (Date.now() >= materializationDeadline) {
        throw testError(
          'El efecto de este mensaje sigue procesándose y aún no tiene un resultado final.',
          503,
          'test_turn_effect_processing'
        )
      }
      const retryDelay = Math.min(1_000, Math.round(250 * (1.35 ** materializationPollAttempt)))
      materializationPollAttempt += 1
      await wait(retryDelay + Math.floor(Math.random() * 75))
    }
  } catch (error) {
    await db.run(
      `UPDATE conversational_agent_test_turns
       SET status = 'failed', claim_token = NULL, lease_until_at = NULL,
           error_code = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'processing' AND claim_token = ?`,
      [
        cleanString(error?.code).slice(0, 160) || 'test_turn_failed',
        cleanString(error?.message || error).slice(0, 1200),
        turnId,
        claimToken
      ]
    ).catch(() => undefined)
    throw error
  } finally {
    heartbeatStopped = true
    clearInterval(heartbeatTimer)
  }
}

export function normalizeConversationalAgentTestEffects(value = {}) {
  const scheduleAppointment = value?.scheduleAppointment === true
  const collectPayment = value?.collectPayment === true
  const assignUser = value?.assignUser === true
  const enabled = value?.enabled === true && (scheduleAppointment || collectPayment || assignUser)
  const configRevision = cleanString(value?.configRevision).slice(0, 64)
  return {
    enabled,
    scheduleAppointment: enabled && scheduleAppointment,
    collectPayment: enabled && collectPayment,
    assignUser: enabled && assignUser,
    notifyOwner: enabled && value?.notifyOwner === true,
    ...(configRevision ? { configRevision } : {})
  }
}

function effectAllowed(effects, effectType) {
  if (!effects?.enabled) return false
  if (effectType === 'appointment') return effects.scheduleAppointment === true
  if (effectType === 'payment') return effects.collectPayment === true
  if (effectType === 'assignment') return effects.assignUser === true
  return false
}

function capabilityTestModeEnabled(capability) {
  return capability?.enabled === true && capability?.testMode?.enabled === true
}

function publicEffect(row = {}) {
  const payload = parseJson(row.payload_json, {})
  return {
    id: row.id,
    runId: row.run_id,
    messageId: row.message_id,
    type: row.effect_type,
    status: row.status,
    code: cleanString(row.error_code) || null,
    retryable: nullableBoolean(row.error_retryable),
    lastError: cleanString(row.last_error) || null,
    appointmentDateRestored: payload.appointmentDateRestored === true,
    appointmentDateRestoreError: cleanString(payload.appointmentDateRestoreError) || null,
    summary: cleanString(payload.summary) || null,
    message: cleanString(payload.message) || null,
    notificationStatus: row.notification_status || null,
    notificationError: row.notification_error || null,
    entityId: row.entity_id || null,
    payload,
    cleanupStatus: row.cleanup_status || null,
    cleanupError: row.cleanup_error || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    cleanedAt: row.cleaned_at || null
  }
}

async function loadOwnedRun(testRunId, requestedByUserId, { active = true } = {}) {
  const run = await db.get(
    `SELECT * FROM conversational_agent_test_runs
     WHERE id = ? AND requested_by_user_id = ?`,
    [testRunId, cleanString(requestedByUserId)]
  )
  if (!run) throw testError('Esta prueba ya no existe o pertenece a otro usuario.', 404, 'test_run_not_found')
  if (active && run.status !== 'active') {
    throw testError('Esta prueba ya fue cerrada. Inicia una nueva para registrar acciones.', 409, 'test_run_closed')
  }
  if (active && Date.parse(run.expires_at || '') <= Date.now()) {
    await db.run(
      `UPDATE conversational_agent_test_runs
       SET status = 'expired', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'active'`,
      [run.id]
    ).catch(() => undefined)
    throw testError('La prueba expiró por seguridad. Reiníciala para registrar acciones.', 409, 'test_run_expired')
  }
  return run
}

export async function prepareConversationalAgentTestRun({
  testRunId,
  testMessageId,
  agentId,
  requestedByUserId,
  contactId,
  effects,
  messages = [],
  configOverride = null,
  clientRequestHash = ''
} = {}) {
  const normalizedEffects = normalizeConversationalAgentTestEffects(effects)
  if (!normalizedEffects.enabled) return null

  const runId = normalizeIdentifier(testRunId, TEST_RUN_ID_PATTERN, 'La sesión de prueba')
  const messageId = normalizeIdentifier(testMessageId, TEST_MESSAGE_ID_PATTERN, 'El mensaje de prueba')
  const cleanAgentId = cleanString(agentId)
  const cleanUserId = cleanString(requestedByUserId)
  let cleanContactId = cleanString(contactId)
  if (!cleanAgentId || !cleanUserId) {
    throw testError('No se pudo identificar al agente o al usuario de esta prueba.', 400, 'test_run_identity_required')
  }

  const agent = await db.get(
    'SELECT id, name, capabilities_config FROM conversational_agents WHERE id = ?',
    [cleanAgentId]
  )
  if (!agent) throw testError('El agente de esta prueba ya no existe.', 404, 'test_agent_not_found')

  const contact = cleanContactId
    ? await db.get(
        'SELECT id, full_name, first_name, last_name, phone, email FROM contacts WHERE id = ? AND deleted_at IS NULL',
        [cleanContactId]
      )
    : await resolveConversationalAgentTestContact()
  if (!contact) throw testError('El contacto de prueba ya no existe.', 404, 'test_contact_not_found')
  cleanContactId = cleanString(contact.id)

  const persistedCapabilitiesConfig = parseJson(agent.capabilities_config, {})
  const persistedConfig = { capabilitiesConfig: persistedCapabilitiesConfig }
  const scheduleCapability = getConversationalCapability(persistedConfig, 'schedule_appointment')
  const paymentCapability = getConversationalCapability(persistedConfig, 'collect_payment')
  if (normalizedEffects.scheduleAppointment && !capabilityTestModeEnabled(scheduleCapability)) {
    throw testError('Activa y guarda Modo test dentro de Agendar cita antes de crear citas reales desde el tester.', 409, 'test_schedule_mode_not_enabled')
  }
  if (normalizedEffects.collectPayment && !capabilityTestModeEnabled(paymentCapability)) {
    throw testError('Activa y guarda Modo test dentro de Cobrar antes de crear un cobro real desde el tester.', 409, 'test_payment_mode_not_enabled')
  }
  const assignmentUserId = cleanString(
    scheduleCapability?.bookingOwner === 'human' ? scheduleCapability.handoffUserId : ''
  )
  if (normalizedEffects.assignUser && !assignmentUserId) {
    throw testError('Selecciona una persona responsable antes de probar la asignación.', 409, 'test_assignment_user_required')
  }
  if (normalizedEffects.assignUser && !capabilityTestModeEnabled(scheduleCapability)) {
    throw testError('Activa y guarda Modo test dentro de Agendar cita antes de probar la entrega a una persona.', 409, 'test_schedule_mode_not_enabled')
  }

  const requestedTestModes = [
    ...(normalizedEffects.scheduleAppointment || normalizedEffects.assignUser ? [scheduleCapability?.testMode] : []),
    ...(normalizedEffects.collectPayment ? [paymentCapability?.testMode] : [])
  ].filter(Boolean)

  const authoritativeEffects = {
    ...normalizedEffects,
    notifyOwner: requestedTestModes.some((testMode) => testMode.notify !== false),
    configRevision: sha256(agent.capabilities_config || '{}')
  }

  const effectsJson = JSON.stringify(authoritativeEffects)
  const expiresAt = toIso(Date.now() + TEST_RUN_TTL_MS)
  const requestHash = buildConversationalAgentTestTurnRequestHash({
    schemaVersion: 1,
    messages: Array.isArray(messages) ? messages : [],
    configOverride,
    agentId: cleanAgentId,
    contactId: cleanContactId,
    effects: authoritativeEffects
  })
  const normalizedClientRequestHash = cleanString(clientRequestHash).toLowerCase() || requestHash
  if (!/^[a-f0-9]{64}$/.test(normalizedClientRequestHash)) {
    throw testError('La identidad del request de prueba no es válida.', 400, 'invalid_test_turn_hash')
  }
  const turnId = `catt_${sha256(`${runId}\u0000${messageId}`).slice(0, 48)}`

  // Reserva primero la identidad inmutable del turno y sólo después renueva la
  // autoridad de la corrida. Un reuse malicioso/accidental del mismo messageId
  // con otro payload no puede cambiar effects_json antes de ser rechazado.
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO conversational_agent_test_runs (
         id, agent_id, requested_by_user_id, contact_id, effects_json, status,
         created_at, updated_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
       ON CONFLICT(id) DO NOTHING`,
      [runId, cleanAgentId, cleanUserId, cleanContactId, effectsJson, expiresAt]
    )

    const run = await db.get(
      `SELECT * FROM conversational_agent_test_runs WHERE id = ?${process.env.DATABASE_URL ? ' FOR UPDATE' : ''}`,
      [runId]
    )
    if (
      !run ||
      cleanString(run.agent_id) !== cleanAgentId ||
      cleanString(run.requested_by_user_id) !== cleanUserId ||
      cleanString(run.contact_id) !== cleanContactId
    ) {
      throw testError('La identidad de esta prueba cambió. Reiníciala antes de continuar.', 409, 'test_run_identity_mismatch')
    }
    if (run.status !== 'active') {
      throw testError('Esta prueba ya no acepta acciones. Reiníciala para continuar.', 409, 'test_run_closed')
    }

    await db.run(
      `INSERT INTO conversational_agent_test_turns (
         id, run_id, message_id, request_hash, client_request_hash, status, attempt_count,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO NOTHING`,
      [turnId, runId, messageId, requestHash, normalizedClientRequestHash]
    )
    const reservedTurn = await db.get(
      `SELECT id, request_hash, client_request_hash FROM conversational_agent_test_turns
       WHERE run_id = ? AND message_id = ?${process.env.DATABASE_URL ? ' FOR UPDATE' : ''}`,
      [runId, messageId]
    )
    if (!reservedTurn || cleanString(reservedTurn.id) !== turnId) {
      throw testError('No se pudo reservar la identidad durable del turno.', 500, 'test_turn_identity_missing')
    }
    if (cleanString(reservedTurn.request_hash).toLowerCase() !== requestHash) {
      throw testError(
        'Este mensaje de prueba ya fue usado con otro contenido. Reinicia la prueba para evitar respuestas cruzadas.',
        409,
        'test_turn_payload_mismatch'
      )
    }
    const storedClientRequestHash = cleanString(reservedTurn.client_request_hash).toLowerCase()
    if (storedClientRequestHash && storedClientRequestHash !== normalizedClientRequestHash) {
      throw testError(
        'Este mensaje de prueba ya fue usado con otro contenido. Reinicia la prueba para evitar respuestas cruzadas.',
        409,
        'test_turn_payload_mismatch'
      )
    }
    if (!storedClientRequestHash) {
      await db.run(
        `UPDATE conversational_agent_test_turns SET client_request_hash = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND client_request_hash IS NULL`,
        [normalizedClientRequestHash, turnId]
      )
    }

    const updated = await db.run(
      `UPDATE conversational_agent_test_runs
       SET effects_json = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND requested_by_user_id = ? AND status = 'active'`,
      [effectsJson, expiresAt, runId, cleanUserId]
    )
    if (mutationCount(updated) !== 1) {
      throw testError('La corrida cambió antes de reservar el turno.', 409, 'test_run_closed')
    }
  })

  return {
    id: runId,
    messageId,
    agent,
    contact,
    effects: authoritativeEffects,
    requestedByUserId: cleanUserId,
    executionId: `test:${sha256(`${runId}\u0000${messageId}`).slice(0, 48)}`,
    expiresAt,
    requestHash,
    clientRequestHash: normalizedClientRequestHash
  }
}

async function assertCurrentTestRunAuthority(run, effectType = '') {
  const cleanEffectType = cleanString(effectType)
  const currentRun = await db.get(
    'SELECT * FROM conversational_agent_test_runs WHERE id = ?',
    [cleanString(run?.id)]
  )
  if (!currentRun) {
    throw testError('Esta prueba ya no existe.', 404, 'test_run_not_found')
  }
  const identityChanged = [
    ['agent_id', run?.agent_id],
    ['requested_by_user_id', run?.requested_by_user_id],
    ['contact_id', run?.contact_id]
  ].some(([field, expected]) => cleanString(expected) && cleanString(currentRun[field]) !== cleanString(expected))
  if (identityChanged) {
    throw testError('La identidad de esta prueba cambió. Reiníciala antes de continuar.', 409, 'test_run_identity_mismatch')
  }
  if (currentRun.status !== 'active') {
    throw testError('Esta prueba ya fue cerrada. No se ejecutó ninguna acción real.', 409, 'test_run_closed')
  }
  if (Date.parse(currentRun.expires_at || '') <= Date.now()) {
    await db.run(
      `UPDATE conversational_agent_test_runs
       SET status = 'expired', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'active'`,
      [currentRun.id]
    )
    throw testError('La prueba expiró por seguridad. Reiníciala para registrar acciones.', 409, 'test_run_expired')
  }
  const row = await db.get(
    'SELECT id, capabilities_config FROM conversational_agents WHERE id = ?',
    [cleanString(currentRun.agent_id)]
  )
  if (!row) throw testError('El agente de esta prueba ya no existe.', 404, 'test_agent_not_found')
  const storedEffects = normalizeConversationalAgentTestEffects(parseJson(currentRun.effects_json, {}))
  const currentRevision = sha256(row.capabilities_config || '{}')
  const capabilitiesConfig = parseJson(row.capabilities_config, {})
  const revisionMatches = Boolean(storedEffects.configRevision) && storedEffects.configRevision === currentRevision
  if (!revisionMatches) {
    await db.run(
      `UPDATE conversational_agent_test_runs
       SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'active'`,
      [currentRun.id]
    )
    throw testError(
      'Modo test o la configuración del agente cambió durante la prueba. No se ejecutó ninguna acción real; reinicia el tester.',
      409,
      'test_run_config_revoked'
    )
  }

  const schedule = getConversationalCapability({ capabilitiesConfig }, 'schedule_appointment')
  const payment = getConversationalCapability({ capabilitiesConfig }, 'collect_payment')
  if (cleanEffectType === 'appointment' && !capabilityTestModeEnabled(schedule)) {
    throw testError('Modo test de Agendar cita ya no está activo.', 409, 'test_schedule_mode_not_enabled')
  }
  if (cleanEffectType === 'payment' && !capabilityTestModeEnabled(payment)) {
    throw testError('Modo test de Cobrar ya no está activo.', 409, 'test_payment_mode_not_enabled')
  }
  if (cleanEffectType === 'assignment') {
    const assignmentUserId = cleanString(
      schedule?.bookingOwner === 'human' ? schedule.handoffUserId : ''
    )
    if (!assignmentUserId) {
      throw testError('La asignación de prueba ya no tiene una persona responsable.', 409, 'test_assignment_user_required')
    }
    if (!capabilityTestModeEnabled(schedule)) {
      throw testError('Modo test de Agendar cita ya no está activo.', 409, 'test_schedule_mode_not_enabled')
    }
  }
  return capabilitiesConfig
}

export async function beginConversationalAgentTestEffect({
  testRunId,
  testMessageId,
  requestedByUserId,
  effectType,
  request,
  exclusiveMutationLockHeld = false
} = {}) {
  const runId = normalizeIdentifier(testRunId, TEST_RUN_ID_PATTERN, 'La sesión de prueba')
  const messageId = normalizeIdentifier(testMessageId, TEST_MESSAGE_ID_PATTERN, 'El mensaje de prueba')
  const cleanEffectType = cleanString(effectType)
  if (!['appointment', 'payment', 'assignment'].includes(cleanEffectType)) {
    throw testError('El efecto solicitado no está permitido en el tester.', 400, 'test_effect_not_allowed')
  }
  const run = await loadOwnedRun(runId, requestedByUserId)
  await assertCurrentTestRunAuthority(run, cleanEffectType)
  const effects = normalizeConversationalAgentTestEffects(parseJson(run.effects_json, {}))
  if (!effectAllowed(effects, cleanEffectType)) {
    throw testError('Este efecto no fue habilitado para la prueba actual.', 403, 'test_effect_not_enabled')
  }

  const requestJson = JSON.stringify(request || {})
  const requestHash = sha256(requestJson)
  const effectId = `catfx_${sha256(`${runId}\u0000${messageId}\u0000${cleanEffectType}`).slice(0, 48)}`
  const claimToken = randomUUID()
  const leaseUntilAt = toIso(Date.now() + TEST_EFFECT_LEASE_MS)
  await db.run(
    `INSERT INTO conversational_agent_test_effects (
       id, run_id, message_id, effect_type, request_hash, status, payload_json,
       attempt_count, claim_token, lease_until_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'processing', ?, 1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO NOTHING`,
    [effectId, runId, messageId, cleanEffectType, requestHash, requestJson, claimToken, leaseUntilAt]
  )

  let effect = await db.get('SELECT * FROM conversational_agent_test_effects WHERE id = ?', [effectId])
  if (!effect || effect.request_hash !== requestHash) {
    throw testError('Este mensaje ya intentó registrar otros datos. Reinicia la prueba para evitar duplicados.', 409, 'test_effect_payload_mismatch')
  }
  if (TERMINAL_TEST_EFFECT_STATUSES.has(effect.status)) {
    return { claimed: false, reused: true, inProgress: false, effect: publicEffect(effect), run, effects }
  }
  if (isTerminalFailedTestEffectRow(effect)) {
    return { claimed: false, reused: true, inProgress: false, effect: publicEffect(effect), run, effects }
  }
  if (effect.claim_token === claimToken) {
    return { claimed: true, reused: false, inProgress: false, claimToken, effect: publicEffect(effect), run, effects }
  }

  const leaseExpired = !effect.lease_until_at || Date.parse(effect.lease_until_at) <= Date.now()
  // recordPreviewEffect sólo activa esta recuperación después de adquirir el
  // advisory lock del agente. Si una fila sigue processing bajo ese candado,
  // el dueño anterior ya no conserva la exclusión y el request idempotente se
  // puede reanudar sin esperar diez minutos a que venza la lease. La excepción
  // es un controller de cita que todavía conserva su propia lease fresca: el
  // contender no la cancela ni inventa un resultado final mientras ese trabajo
  // puede seguir cerrando providers/checkpoints.
  const appointmentRequestState = (
    exclusiveMutationLockHeld === true &&
    cleanEffectType === 'appointment' &&
    effect.status === 'processing'
  )
    ? await inspectAppointmentCreationRequestRecoveryState(`conv-test:${effectId}`)
    : null
  const appointmentControllerStillProcessing = Boolean(
    appointmentRequestState?.status === 'processing' &&
    appointmentRequestState.processingLeaseExpired === false
  )
  const recoverAbandonedProcessing = exclusiveMutationLockHeld === true &&
    effect.status === 'processing' &&
    !appointmentControllerStillProcessing
  if (effect.status === 'processing' && !leaseExpired && !recoverAbandonedProcessing) {
    return { claimed: false, reused: false, inProgress: true, effect: publicEffect(effect), run, effects }
  }

  const claimed = await db.run(
    `UPDATE conversational_agent_test_effects
     SET status = 'processing', attempt_count = attempt_count + 1,
         claim_token = ?, lease_until_at = ?, last_error = NULL, error_code = NULL,
         error_retryable = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND request_hash = ?
       AND (status = 'failed' OR lease_until_at IS NULL OR lease_until_at <= ?
            OR (? = 1 AND status = 'processing'))`,
    [claimToken, leaseUntilAt, effectId, requestHash, toIso(), recoverAbandonedProcessing ? 1 : 0]
  )
  if (mutationCount(claimed) !== 1) {
    effect = await db.get('SELECT * FROM conversational_agent_test_effects WHERE id = ?', [effectId])
    return {
      claimed: false,
      reused: TERMINAL_TEST_EFFECT_STATUSES.has(effect?.status) || isTerminalFailedTestEffectRow(effect),
      inProgress: effect?.status === 'processing',
      effect: publicEffect(effect || {}),
      run,
      effects
    }
  }
  effect = await db.get('SELECT * FROM conversational_agent_test_effects WHERE id = ?', [effectId])
  return { claimed: true, reused: false, inProgress: false, claimToken, effect: publicEffect(effect), run, effects }
}

export async function completeConversationalAgentTestEffect({
  effectId,
  claimToken,
  status = 'recorded',
  entityId = null,
  payload = {},
  notify = true
} = {}) {
  const result = await db.run(
    `UPDATE conversational_agent_test_effects
     SET status = ?, entity_id = ?, payload_json = ?, claim_token = NULL,
         lease_until_at = NULL, last_error = NULL, error_code = NULL,
         error_retryable = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'processing' AND claim_token = ?`,
    [cleanString(status) || 'recorded', cleanString(entityId) || null, JSON.stringify(payload || {}), cleanString(effectId), cleanString(claimToken)]
  )
  if (mutationCount(result) !== 1) {
    const existing = await db.get('SELECT * FROM conversational_agent_test_effects WHERE id = ?', [cleanString(effectId)])
    if (existing && TERMINAL_TEST_EFFECT_STATUSES.has(existing.status)) return publicEffect(existing)
    throw testError('No se pudo cerrar de forma segura el efecto de prueba.', 409, 'test_effect_claim_lost')
  }
  const row = await db.get('SELECT * FROM conversational_agent_test_effects WHERE id = ?', [cleanString(effectId)])
  if (notify && row?.effect_type !== 'assignment') {
    await dispatchConversationalAgentTestEffectNotification(row).catch((error) => {
      logger.warn(`[Tester agente] No se pudo notificar el efecto ${effectId}: ${error.message}`)
    })
  }
  return publicEffect(await db.get('SELECT * FROM conversational_agent_test_effects WHERE id = ?', [cleanString(effectId)]))
}

export async function failConversationalAgentTestEffect({ effectId, claimToken, error } = {}) {
  const current = await db.get(
    'SELECT payload_json FROM conversational_agent_test_effects WHERE id = ? AND status = ? AND claim_token = ?',
    [cleanString(effectId), 'processing', cleanString(claimToken)]
  )
  const payload = {
    ...parseJson(current?.payload_json, {}),
    appointmentDateRestored: error?.appointmentDateRestored === true,
    appointmentDateRestoreError: cleanString(error?.appointmentDateRestoreError) || null
  }
  const retryable = isRetryableTestEffectError(error)
  await db.run(
    `UPDATE conversational_agent_test_effects
     SET status = 'failed', claim_token = NULL, lease_until_at = NULL,
         last_error = ?, error_code = ?, error_retryable = ?, payload_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'processing' AND claim_token = ?`,
    [
      cleanString(error?.message || error).slice(0, 1200),
      cleanString(error?.code).slice(0, 160) || null,
      retryable ? 1 : 0,
      JSON.stringify(payload),
      cleanString(effectId),
      cleanString(claimToken)
    ]
  )
}

function previewActionSucceeded(action = {}) {
  const status = cleanString(action?.outcome?.status).toLowerCase()
  return status === 'simulated' || status === 'ok' || status === 'success' || status === 'completed'
}

async function loadPersistedCapabilities(run) {
  const agentId = cleanString(run?.agent_id || run?.agent?.id)
  const row = await db.get(
    'SELECT id, capabilities_config FROM conversational_agents WHERE id = ?',
    [agentId]
  )
  if (!row) throw testError('El agente de esta prueba ya no existe.', 404, 'test_agent_not_found')
  return parseJson(row.capabilities_config, {})
}

async function verifyTestAppointmentAction(action, scheduleCapability, { allowCanonicalReplay = false } = {}) {
  const calendarId = cleanString(action?.calendarId)
  const startTime = cleanString(action?.startTime)
  const start = new Date(startTime)
  const confirmationEvidence = action?.confirmationEvidence && typeof action.confirmationEvidence === 'object'
    ? action.confirmationEvidence
    : null
  const serverOwnedTestPaymentResume = Boolean(
    confirmationEvidence?.reusedForTestPaymentResume === true &&
    cleanString(confirmationEvidence?.offerEventId) &&
    cleanString(confirmationEvidence?.testPaymentEffectId)
  )
  const selectionVerified = Boolean(
    confirmationEvidence?.evidenceVerified === true &&
    confirmationEvidence?.nativeToolDecision === true &&
    cleanString(confirmationEvidence?.selectedStartTime) === startTime &&
    (cleanString(confirmationEvidence?.customerQuote) || serverOwnedTestPaymentResume)
  )
  if (!selectionVerified) {
    throw testError(
      'La conversación de prueba no contiene una selección verificable de ese día y hora. No se creó ninguna cita; ofrece horarios y espera a que la persona elija uno.',
      409,
      'test_appointment_selection_required'
    )
  }
  const configuredCalendarId = cleanString(scheduleCapability?.calendarId)
  const calendar = configuredCalendarId
    ? await db.get(
        `SELECT id, ghl_calendar_id, is_active
         FROM calendars
         WHERE id = ? OR ghl_calendar_id = ?
         LIMIT 1`,
        [configuredCalendarId, configuredCalendarId]
      )
    : null
  const calendarMatches = Boolean(
    calendar &&
    !['0', 'false', 'off'].includes(String(calendar.is_active ?? '1').trim().toLowerCase()) &&
    [calendar.id, calendar.ghl_calendar_id].filter(Boolean).map(String).includes(calendarId)
  )
  if (
    !scheduleCapability?.enabled ||
    !calendarId ||
    !calendarMatches ||
    Number.isNaN(start.getTime())
  ) {
    throw testError('La acción ya no coincide con el calendario guardado del agente.', 409, 'test_appointment_authority_changed')
  }

  const expectedAction = scheduleCapability.bookingOwner === 'human'
    ? 'request_human_booking'
    : 'book_appointment'
  if (cleanString(action?.type) !== expectedAction) {
    throw testError('Cambió quién termina de agendar. Vuelve a enviar el mensaje para probar la configuración vigente.', 409, 'test_booking_owner_changed')
  }

  if (allowCanonicalReplay) return

  const timezone = await getAccountTimezone()
  const windowStart = normalizeDateOnlyInTimezone(
    new Date(start.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    timezone
  )
  const windowEnd = normalizeDateOnlyInTimezone(
    new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    timezone
  )
  const availability = await getLocalFreeSlots(calendarId, windowStart, windowEnd, timezone, {
    allowDefaultOpenHours: false,
    // La política persistida del calendario manda también en el tester:
    // sin empalmes el cupo es uno; con empalmes el slot sigue disponible.
    ignoreAppointmentConflicts: false
  })
  const stillFree = (Array.isArray(availability) ? availability : [])
    .flatMap((day) => Array.isArray(day?.slots) ? day.slots : [])
    .some((slot) => Math.abs(new Date(slot).getTime() - start.getTime()) < 60_000)
  if (!stillFree) {
    throw testError('Ese horario dejó de estar libre. No se registró la cita de prueba; vuelve a consultar espacios.', 409, 'test_slot_no_longer_free')
  }
}

async function hasCanonicalTestAppointmentReplay({ effectId, runContext, request } = {}) {
  const clientRequestId = `conv-test:${cleanString(effectId)}`
  const requestState = await inspectAppointmentCreationRequestRecoveryState(clientRequestId)
  const row = await db.get(`
    SELECT
      a.id, a.calendar_id, a.contact_id, a.start_time, a.end_time,
      a.status, a.appointment_status, a.deleted_at, a.is_test,
      a.test_run_id, a.test_effect_id,
      r.status AS request_status, r.appointment_id AS request_appointment_id
    FROM appointments a
    INNER JOIN appointment_creation_requests r ON r.client_request_id = ?
    WHERE a.test_effect_id = ?
    LIMIT 1
  `, [clientRequestId, cleanString(effectId)])
  if (!row) return false
  const durableInterruptedFailure = requestState.status === 'failed' && [
    TEST_APPOINTMENT_CHECKPOINT_INTERRUPTED_FAILURE_KIND,
    TEST_APPOINTMENT_PROVIDER_SYNC_FAILURE_KIND
  ].includes(requestState.failureKind)
  const requestReadyForReplay = requestState.status === 'completed' || (
    requestState.status === 'processing' && requestState.processingLeaseExpired === true
  ) || durableInterruptedFailure
  const inactive = row.deleted_at || ['cancelled', 'canceled', 'deleted'].includes(
    cleanString(row.appointment_status || row.status).toLowerCase()
  )
  const requestAppointmentId = cleanString(row.request_appointment_id)
  return Boolean(
    !inactive &&
    Number(row.is_test || 0) === 1 &&
    cleanString(row.test_effect_id) === cleanString(effectId) &&
    cleanString(row.test_run_id) === cleanString(runContext?.id) &&
    cleanString(row.contact_id) === cleanString(runContext?.contact?.id) &&
    cleanString(row.calendar_id) === cleanString(request?.calendarId) &&
    Math.abs(new Date(row.start_time).getTime() - new Date(request?.startTime).getTime()) < 60_000 &&
    Math.abs(new Date(row.end_time).getTime() - new Date(request?.endTime).getTime()) < 60_000 &&
    requestReadyForReplay &&
    cleanString(row.request_status) === requestState.status &&
    (!requestAppointmentId || requestAppointmentId === cleanString(row.id))
  )
}

async function withConversationalAppointmentTestEffectLock(lockInput, operation) {
  const deadline = Date.now() + TEST_APPOINTMENT_EFFECT_LOCK_WAIT_MS
  while (true) {
    try {
      return await withConversationalAgentTestMutationLock(lockInput, operation)
    } catch (error) {
      if (error?.code !== 'test_mutation_lock_busy' || Date.now() >= deadline) throw error
      await wait(TEST_APPOINTMENT_EFFECT_LOCK_RETRY_MS)
    }
  }
}

async function restorePreviewAppointmentDateAfterSlotConflict({ runContext, request, effectId } = {}) {
  const previewScopeId = buildConversationalAppointmentPreviewScopeId({
    testSessionId: runContext?.id,
    requestedByUserId: runContext?.requestedByUserId,
    agentId: runContext?.agent?.id
  })
  const offerEventId = buildConversationalAppointmentPreviewOfferEventId(previewScopeId)
  const contactId = cleanString(runContext?.contact?.id)
  const agentId = cleanString(runContext?.agent?.id)
  const executionId = cleanString(runContext?.executionId)
  if (!offerEventId || !contactId || !agentId || !executionId) {
    throw testError(
      'La prueba perdió la identidad necesaria para conservar la fecha.',
      409,
      'test_appointment_restore_identity_missing'
    )
  }

  return db.transaction(async () => {
    const offer = await db.get(
      `SELECT id, contact_id, agent_id, event_type, detail_json
       FROM conversational_agent_events WHERE id = ?${process.env.DATABASE_URL ? ' FOR UPDATE' : ''}`,
      [offerEventId]
    )
    const detail = parseJson(offer?.detail_json, {})
    const acceptedByExecution = cleanString(detail.status) === 'accepted' &&
      cleanString(detail.acceptedExecutionId) === executionId
    const materializedByExecution = cleanString(detail.status) === 'materializing' &&
      cleanString(detail.materializationExecutionId) === executionId &&
      cleanString(detail.materializationEffectId) === cleanString(effectId)
    const identityMatches = Boolean(
      offer?.event_type === CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT &&
      cleanString(offer?.contact_id) === contactId &&
      cleanString(offer?.agent_id) === agentId &&
      cleanString(detail.previewScopeId) === previewScopeId &&
      cleanString(detail.calendarId) === cleanString(request?.calendarId) &&
      cleanString(detail.startTime) === cleanString(request?.startTime) &&
      (acceptedByExecution || materializedByExecution)
    )
    if (!identityMatches) {
      throw testError(
        'La oferta cambió antes de conservar la fecha del horario perdido.',
        409,
        'test_appointment_restore_offer_mismatch'
      )
    }

    const selectedDate = normalizeDateOnlyInTimezone(detail.startTime, detail.timezone)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
      throw testError(
        'La oferta perdió su fecha de negocio antes de restaurarse.',
        409,
        'test_appointment_restore_date_invalid'
      )
    }
    const progressRows = await db.all(
      `SELECT id, contact_id, agent_id, event_type, detail_json
       FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = ?${process.env.DATABASE_URL ? ' FOR UPDATE' : ''}`,
      [contactId, agentId, CONVERSATIONAL_APPOINTMENT_SELECTION_PROGRESS_EVENT]
    )
    const progress = (progressRows || []).find((row) => (
      cleanString(parseJson(row.detail_json, {}).previewScopeId) === previewScopeId
    ))
    const progressDetail = parseJson(progress?.detail_json, {})
    const channel = cleanString(detail.channel).toLowerCase()
    const progressEventId = channel
      ? `cae_appointment_progress_${sha256([
          agentId,
          contactId,
          channel,
          previewScopeId
        ].join('\u0000')).slice(0, 48)}`
      : ''
    const selection = cleanString(detail.selectionEventId)
      ? await db.get(
          `SELECT id, contact_id, agent_id, event_type, detail_json
           FROM conversational_agent_events WHERE id = ?${process.env.DATABASE_URL ? ' FOR UPDATE' : ''}`,
          [cleanString(detail.selectionEventId)]
        )
      : null
    const selectionDetail = parseJson(selection?.detail_json, {})
    const selectionMatches = !selection
      ? !cleanString(detail.selectionEventId)
      : Boolean(
          selection.event_type === TEST_APPOINTMENT_SELECTION_EVENT &&
          cleanString(selection.contact_id) === contactId &&
          cleanString(selection.agent_id) === agentId &&
          cleanString(selectionDetail.status) === 'active' &&
          cleanString(selectionDetail.offerEventId) === offerEventId &&
          cleanString(selectionDetail.executionId) === executionId
        )
    if (
      !progressEventId ||
      (progress && (
        cleanString(progress.id) !== progressEventId ||
        cleanString(progress.contact_id) !== contactId ||
        cleanString(progress.agent_id) !== agentId ||
        cleanString(progressDetail.calendarId) !== cleanString(detail.calendarId)
      )) ||
      !selectionMatches
    ) {
      throw testError(
        'La selección aceptada ya no coincide con la oferta que perdió el horario.',
        409,
        'test_appointment_restore_selection_mismatch'
      )
    }

    const resolvedAt = toIso()
    const rejectedStartTimes = [...new Set([
      ...(Array.isArray(detail.rejectedStartTimes) ? detail.rejectedStartTimes : []),
      cleanString(detail.startTime)
    ].filter(Boolean))].slice(-64)
    const nextOfferDetail = {
      ...detail,
      status: 'superseded',
      phase: 'resolved',
      resolution: TEST_SLOT_NO_LONGER_FREE_CODE,
      resolvedAt,
      resolvedExecutionId: executionId,
      rejectedStartTimes
    }
    const nextProgressDetail = {
      ...progressDetail,
      schemaVersion: 1,
      agentId,
      contactId,
      channel,
      previewScopeId,
      calendarId: cleanString(detail.calendarId),
      selectedCalendar: cleanString(detail.calendarId),
      purpose: cleanString(detail.purpose) === 'reschedule' ? 'reschedule' : 'book',
      appointmentId: cleanString(detail.purpose) === 'reschedule'
        ? cleanString(detail.appointmentId) || null
        : null,
      selectedDate,
      selectedTime: null,
      selectedStartTime: null,
      previouslyShownRanges: [],
      availabilityCheckedAt: null,
      availabilityVerificationRequired: false,
      lastError: { code: TEST_SLOT_NO_LONGER_FREE_CODE, at: resolvedAt },
      appointmentStatus: 'collecting_time',
      missingFields: ['time'],
      selectedTimezone: cleanString(detail.timezone),
      sourceExecutionId: executionId,
      updatedAt: resolvedAt,
      expiresAt: toIso(Date.now() + TEST_APPOINTMENT_PROGRESS_TTL_MS)
    }
    const offerUpdate = await db.run(
      `UPDATE conversational_agent_events SET detail_json = ?
       WHERE id = ? AND event_type = ? AND detail_json = ?`,
      [JSON.stringify(nextOfferDetail), offer.id, CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT, offer.detail_json]
    )
    if (mutationCount(offerUpdate) !== 1) {
      throw testError(
        'La oferta cambió mientras se restauraba su fecha.',
        409,
        'test_appointment_restore_offer_race'
      )
    }
    const progressUpdate = progress
      ? await db.run(
          `UPDATE conversational_agent_events SET detail_json = ?
           WHERE id = ? AND event_type = ? AND detail_json = ?`,
          [
            JSON.stringify(nextProgressDetail),
            progress.id,
            CONVERSATIONAL_APPOINTMENT_SELECTION_PROGRESS_EVENT,
            progress.detail_json
          ]
        )
      : await db.run(
          `INSERT INTO conversational_agent_events
            (id, contact_id, agent_id, event_type, detail_json)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
          [
            progressEventId,
            contactId,
            agentId,
            CONVERSATIONAL_APPOINTMENT_SELECTION_PROGRESS_EVENT,
            JSON.stringify(nextProgressDetail)
          ]
        )
    if (mutationCount(progressUpdate) !== 1) {
      throw testError(
        'La fecha de la oferta que perdió el horario cambió antes de restaurarse.',
        409,
        'test_appointment_progress_restore_race'
      )
    }
    if (selection) {
      const selectionUpdate = await db.run(
        `UPDATE conversational_agent_events SET detail_json = ?
         WHERE id = ? AND event_type = ? AND detail_json = ?`,
        [
          JSON.stringify({
            ...selectionDetail,
            status: 'superseded',
            supersededAt: resolvedAt,
            supersededReason: TEST_SLOT_NO_LONGER_FREE_CODE
          }),
          selection.id,
          TEST_APPOINTMENT_SELECTION_EVENT,
          selection.detail_json
        ]
      )
      if (mutationCount(selectionUpdate) !== 1) {
        throw testError(
          'La selección aceptada cambió antes de restaurar la fecha del horario perdido.',
          409,
          'test_appointment_selection_restore_race'
        )
      }
    }
    return true
  })
}

async function claimPreviewAppointmentOfferForTestEffect({ runContext, request, effectId } = {}) {
  const previewScopeId = buildConversationalAppointmentPreviewScopeId({
    testSessionId: runContext?.id,
    requestedByUserId: runContext?.requestedByUserId,
    agentId: runContext?.agent?.id
  })
  const expectedEventId = buildConversationalAppointmentPreviewOfferEventId(previewScopeId)
  const evidenceEventId = cleanString(request?.confirmationEvidence?.offerEventId)
  if (!expectedEventId || evidenceEventId !== expectedEventId) {
    throw testError(
      'La cita de prueba perdió el vínculo con la oferta confirmada. No se creó ninguna cita.',
      409,
      'test_appointment_offer_binding_missing'
    )
  }
  const row = await db.get(
    `SELECT id, contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?`,
    [expectedEventId]
  )
  const detail = parseJson(row?.detail_json, {})
  const baseIdentityMatches = Boolean(
    row?.event_type === CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT &&
    cleanString(row?.contact_id) === cleanString(runContext?.contact?.id) &&
    cleanString(row?.agent_id) === cleanString(runContext?.agent?.id) &&
    cleanString(detail.previewScopeId) === previewScopeId &&
    cleanString(detail.calendarId) === cleanString(request?.calendarId) &&
    cleanString(detail.startTime) === cleanString(request?.startTime) &&
    cleanString(request?.confirmationEvidence?.selectedStartTime) === cleanString(request?.startTime)
  )
  const materializationReplay = Boolean(
    baseIdentityMatches &&
    ['materializing', 'materialized'].includes(cleanString(detail.status)) &&
    cleanString(detail.materializationEffectId) === cleanString(effectId) &&
    cleanString(detail.materializationExecutionId) === cleanString(runContext?.executionId)
  )
  if (materializationReplay) return detail

  let verifiedPaymentEvidence = null
  const acceptedByCurrentTurn = Boolean(
    baseIdentityMatches &&
    cleanString(detail.status) === 'accepted' &&
    cleanString(detail.acceptedExecutionId) === cleanString(runContext?.executionId)
  )
  if (
    baseIdentityMatches &&
    cleanString(detail.status) === 'accepted' &&
    !acceptedByCurrentTurn &&
    request?.confirmationEvidence?.reusedForTestPaymentResume === true
  ) {
    verifiedPaymentEvidence = await getConversationalAgentTestVerifiedPaymentEvidence({ runContext })
  }
  const acceptedByVerifiedTestPayment = Boolean(
    verifiedPaymentEvidence &&
    cleanString(verifiedPaymentEvidence.paymentMode).toLowerCase() === 'test' &&
    cleanString(verifiedPaymentEvidence.paymentPurpose) === 'appointment_deposit' &&
    cleanString(verifiedPaymentEvidence.testRunId) === cleanString(runContext?.id) &&
    cleanString(verifiedPaymentEvidence.previewScopeId) === previewScopeId &&
    cleanString(verifiedPaymentEvidence.appointmentOfferEventId) === expectedEventId &&
    cleanString(verifiedPaymentEvidence.appointmentOfferFingerprint) === sha256(row?.detail_json || '') &&
    cleanString(verifiedPaymentEvidence.calendarId) === cleanString(detail.calendarId) &&
    cleanString(verifiedPaymentEvidence.startTime) === cleanString(detail.startTime) &&
    cleanString(verifiedPaymentEvidence.bookingOwner) === cleanString(detail.bookingOwner) &&
    cleanString(verifiedPaymentEvidence.terminalToolName) === cleanString(detail.terminalToolName) &&
    cleanString(verifiedPaymentEvidence.testEffectId)
  )
  const identityMatches = baseIdentityMatches && (acceptedByCurrentTurn || acceptedByVerifiedTestPayment)
  if (!identityMatches) {
    throw testError(
      'La oferta cambió antes de materializar la cita de prueba. No se creó ninguna cita ni se tocó la oferta nueva.',
      409,
      'test_appointment_offer_changed'
    )
  }
  if (cleanString(detail.status) !== 'accepted') {
    throw testError(
      'La oferta ya fue consumida por otra acción de prueba. No se creó otra cita.',
      409,
      'test_appointment_offer_claimed'
    )
  }
  const claimedDetail = {
    ...detail,
    status: 'materializing',
    materializationEffectId: cleanString(effectId),
    materializationExecutionId: cleanString(runContext?.executionId),
    ...(acceptedByVerifiedTestPayment
      ? { materializationPaymentEffectId: cleanString(verifiedPaymentEvidence.testEffectId) }
      : {}),
    materializationClaimedAt: toIso()
  }
  const claimed = await db.run(
    `UPDATE conversational_agent_events SET detail_json = ?
     WHERE id = ? AND event_type = ? AND detail_json = ?`,
    [JSON.stringify(claimedDetail), expectedEventId, CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT, row.detail_json]
  )
  if (mutationCount(claimed) !== 1) {
    throw testError(
      'Otra acción cambió la oferta mientras se registraba la cita de prueba. No se creó ninguna cita.',
      409,
      'test_appointment_offer_claim_race'
    )
  }
  return claimedDetail
}

async function markPreviewAppointmentOfferMaterialized({ runContext, effectId } = {}) {
  const previewScopeId = buildConversationalAppointmentPreviewScopeId({
    testSessionId: runContext?.id,
    requestedByUserId: runContext?.requestedByUserId,
    agentId: runContext?.agent?.id
  })
  const eventId = buildConversationalAppointmentPreviewOfferEventId(previewScopeId)
  if (!eventId) return false

  return db.transaction(async () => {
    const row = await db.get(
      `SELECT contact_id, agent_id, detail_json FROM conversational_agent_events
       WHERE id = ? AND event_type = ?${process.env.DATABASE_URL ? ' FOR UPDATE' : ''}`,
      [eventId, CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT]
    )
    const detail = parseJson(row?.detail_json, {})
    const alreadyMaterialized = cleanString(detail.status) === 'materialized' &&
      cleanString(detail.materializationEffectId) === cleanString(effectId)
    if (!alreadyMaterialized && (
      cleanString(detail.status) !== 'materializing' ||
      cleanString(detail.materializationEffectId) !== cleanString(effectId)
    )) return false

    const materializedAt = toIso()
    if (!alreadyMaterialized) {
      const offerUpdate = await db.run(
        `UPDATE conversational_agent_events SET detail_json = ?
         WHERE id = ? AND event_type = ? AND detail_json = ?`,
        [
          JSON.stringify({ ...detail, status: 'materialized', materializedAt }),
          eventId,
          CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT,
          row.detail_json
        ]
      )
      if (mutationCount(offerUpdate) !== 1) {
        throw testError('La oferta cambió antes de cerrar su materialización.', 409, 'test_appointment_offer_materialize_race')
      }
    }

    const progressRows = await db.all(
      `SELECT id, contact_id, agent_id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = ?${process.env.DATABASE_URL ? ' FOR UPDATE' : ''}`,
      [row.contact_id, row.agent_id, CONVERSATIONAL_APPOINTMENT_SELECTION_PROGRESS_EVENT]
    )
    const progress = (progressRows || []).find((candidate) => (
      cleanString(parseJson(candidate.detail_json, {}).previewScopeId) === previewScopeId
    ))
    if (!progress) return true
    const progressDetail = parseJson(progress.detail_json, {})
    if (
      cleanString(progressDetail.appointmentStatus) === 'materialized' &&
      cleanString(progressDetail.materializedEffectId) === cleanString(effectId) &&
      cleanString(progressDetail.calendarId) === cleanString(detail.calendarId) &&
      cleanString(progressDetail.selectedStartTime) === cleanString(detail.startTime)
    ) return true
    // A estas alturas la cita canónica ya fue creada con la oferta aceptada y
    // el effectId idempotente. Si el progreso parcial quedó viejo o apuntando a
    // otro calendario, volver a fallar jamás converge: cada retry recuperaría
    // la misma cita y chocaría con el mismo JSON. La oferta materializada es la
    // autoridad final y repara ese registro dentro del mismo COMMIT.
    const selectedDate = normalizeDateOnlyInTimezone(detail.startTime, detail.timezone)
    const progressUpdate = await db.run(
      `UPDATE conversational_agent_events SET detail_json = ?
       WHERE id = ? AND event_type = ? AND detail_json = ?`,
      [
        JSON.stringify({
          ...progressDetail,
          schemaVersion: 1,
          agentId: cleanString(row.agent_id),
          contactId: cleanString(row.contact_id),
          channel: cleanString(detail.channel).toLowerCase(),
          previewScopeId,
          calendarId: cleanString(detail.calendarId),
          selectedCalendar: cleanString(detail.calendarId),
          purpose: cleanString(detail.purpose) === 'reschedule' ? 'reschedule' : 'book',
          appointmentId: cleanString(detail.purpose) === 'reschedule'
            ? cleanString(detail.appointmentId) || null
            : null,
          selectedDate: /^\d{4}-\d{2}-\d{2}$/.test(selectedDate) ? selectedDate : null,
          selectedTime: null,
          appointmentStatus: 'materialized',
          selectedStartTime: cleanString(detail.startTime) || progressDetail.selectedStartTime || null,
          selectedTimezone: cleanString(detail.timezone) || progressDetail.selectedTimezone || null,
          previouslyShownRanges: [],
          availabilityCheckedAt: progressDetail.availabilityCheckedAt || materializedAt,
          missingFields: [],
          availabilityVerificationRequired: false,
          lastError: null,
          materializedEffectId: cleanString(effectId),
          materializedAt,
          sourceExecutionId: cleanString(runContext?.executionId),
          updatedAt: materializedAt,
          expiresAt: progressDetail.expiresAt || toIso(Date.now() + TEST_APPOINTMENT_PROGRESS_TTL_MS)
        }),
        progress.id,
        CONVERSATIONAL_APPOINTMENT_SELECTION_PROGRESS_EVENT,
        progress.detail_json
      ]
    )
    if (mutationCount(progressUpdate) !== 1) {
      throw testError('El estado progresivo cambió antes de cerrarse.', 409, 'test_appointment_progress_materialize_race')
    }
    return true
  })
}

async function finalizeConversationalAppointmentTestEffect({
  runContext,
  effectId,
  claimToken,
  entityId = null,
  payload
} = {}) {
  const completed = await db.transaction(async () => {
    const effect = await completeConversationalAgentTestEffect({
      effectId,
      claimToken,
      status: 'recorded',
      entityId,
      payload,
      // La notificación puede hacer I/O externo. Debe salir sólo después del
      // COMMIT que cierra effect + offer + progress, nunca dentro de la tx.
      notify: false
    })
    const offerClosed = await markPreviewAppointmentOfferMaterialized({ runContext, effectId })
    if (!offerClosed) {
      throw testError(
        'No se pudo cerrar la oferta después de materializar la cita de prueba.',
        409,
        'test_appointment_offer_materialize_failed'
      )
    }
    return effect
  })

  await ensureConversationalAgentTestEffectNotification(effectId).catch((error) => {
    logger.warn(`[Tester agente] La cita quedó cerrada, pero su notificación se reintentará: ${error.message}`)
  })
  const refreshed = await db.get('SELECT * FROM conversational_agent_test_effects WHERE id = ?', [effectId])
  return publicEffect(refreshed || completed || {})
}

function currencyFractionDigits(currency) {
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits
    return Number.isInteger(digits) ? digits : 2
  } catch {
    return 2
  }
}

function normalizeMoney(value, currency) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return 0
  const factor = 10 ** currencyFractionDigits(currency)
  return Math.round((amount + Number.EPSILON) * factor) / factor
}

function normalizeTestPaymentPurpose(action, usesDeposit) {
  const requestedPurpose = cleanString(action?.paymentPurpose)
  const allowedPurposes = usesDeposit
    ? new Set(['deposit', 'appointment_deposit'])
    : new Set(['purchase'])
  const paymentPurpose = requestedPurpose || (usesDeposit ? 'deposit' : 'purchase')
  if (!allowedPurposes.has(paymentPurpose)) {
    throw testError('El propósito de este cobro ya no coincide con la configuración guardada.', 409, 'test_payment_purpose_changed')
  }
  return paymentPurpose
}

function publicTestReceiptAnalysis(value) {
  const analysis = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const currency = cleanString(analysis.currency).toUpperCase()
  const amount = Number(analysis.amount)
  const confidence = Number(analysis.confidence)
  return {
    ok: analysis.ok === true,
    isPaymentReceipt: analysis.isPaymentReceipt === true,
    ...(Number.isFinite(amount) && amount > 0 ? { amount } : {}),
    ...(/^[A-Z]{3}$/.test(currency) ? { currency } : {}),
    ...(cleanString(analysis.reference) ? { reference: cleanString(analysis.reference).slice(0, 200) } : {}),
    ...(cleanString(analysis.bank) ? { bank: cleanString(analysis.bank).slice(0, 200) } : {}),
    ...(cleanString(analysis.date) ? { date: cleanString(analysis.date).slice(0, 80) } : {}),
    ...(cleanString(analysis.reason) ? { reason: cleanString(analysis.reason).slice(0, 160) } : {}),
    ...(Number.isFinite(confidence) ? { confidence: Math.max(0, Math.min(1, confidence)) } : {})
  }
}

async function verifyTestPaymentAction(action, paymentCapability, { collectionMethod = 'payment_link' } = {}) {
  const accountCurrency = cleanString(await getAccountCurrency()).toUpperCase()
  const currency = cleanString(action?.currency).toUpperCase()
  const amount = normalizeMoney(action?.amount, currency)
  const quantity = Number(action?.quantity || 1)
  const expectedCollectionMethod = collectionMethod === 'bank_transfer' ? 'bank_transfer' : 'payment_link'
  const pendingTransferReview = expectedCollectionMethod === 'bank_transfer'
  if (
    !paymentCapability?.enabled ||
    paymentCapability?.collectionMethod !== expectedCollectionMethod ||
    !/^[A-Z]{3}$/.test(accountCurrency) ||
    currency !== accountCurrency ||
    (!pendingTransferReview && !amount) ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 100
  ) {
    throw testError('El monto o la moneda del cobro ya no coinciden con la configuración guardada.', 409, 'test_payment_authority_changed')
  }

  const usesDeposit = paymentCapability.paymentMode === 'deposit' || paymentCapability.deposit?.enabled === true
  const paymentPurpose = normalizeTestPaymentPurpose(action, usesDeposit)
  if (usesDeposit) {
    const deposit = paymentCapability.deposit || {}
    const depositCurrency = cleanString(deposit.currency || accountCurrency).toUpperCase()
    const fixed = normalizeMoney(deposit.amount, accountCurrency)
    const min = normalizeMoney(deposit.minAmount, accountCurrency)
    const max = normalizeMoney(deposit.maxAmount, accountCurrency)
    const rangeConfigured = deposit.mode === 'range' && Boolean(min || max) && (!min || !max || min <= max)
    const validAmount = deposit.mode === 'range'
      ? rangeConfigured && amount > 0 && (!min || amount >= min) && (!max || amount <= max)
      : fixed > 0 && amount === fixed
    const configuredAuthorityValid = deposit.mode === 'range' ? rangeConfigured : fixed > 0
    if (quantity !== 1 || depositCurrency !== accountCurrency || !configuredAuthorityValid || (!pendingTransferReview && !validAmount)) {
      throw testError('El anticipo de prueba ya no coincide con el monto blindado del agente.', 409, 'test_payment_authority_changed')
    }
    const expectedPayment = {
      mode: deposit.mode === 'range' ? 'range' : 'fixed',
      amount: deposit.mode === 'range' ? null : fixed,
      minAmount: deposit.mode === 'range' && min > 0 ? min : null,
      maxAmount: deposit.mode === 'range' && max > 0 ? max : null,
      currency: accountCurrency
    }
    return {
      amount: pendingTransferReview
        ? (deposit.mode === 'range' ? (validAmount ? amount : null) : fixed)
        : amount,
      currency,
      quantity: 1,
      concept: cleanString(action?.concept) || 'Anticipo',
      collectionMethod: expectedCollectionMethod,
      paymentPurpose,
      expectedPayment,
      gateway: cleanString(paymentCapability.gateway).toLowerCase(),
      installments: paymentCapability.installments || { enabled: false, maxInstallments: 0 },
      afterPayment: paymentCapability.afterPayment === 'handoff' ? 'handoff' : 'continue'
    }
  }

  if (paymentCapability.chargeType === 'direct') {
    const direct = paymentCapability.direct || {}
    const directCurrency = cleanString(direct.currency || accountCurrency).toUpperCase()
    const expectedAmount = normalizeMoney(direct.amount, directCurrency)
    const expectedConcept = cleanString(direct.concept)
    if (
      quantity !== 1 ||
      directCurrency !== accountCurrency ||
      !expectedAmount ||
      (!pendingTransferReview && amount !== expectedAmount) ||
      !expectedConcept ||
      (expectedCollectionMethod === 'payment_link' && cleanString(action?.catalogEvidence?.source) !== 'capability_direct')
    ) {
      throw testError('El cobro directo ya no coincide con el monto y concepto blindados del agente.', 409, 'test_payment_authority_changed')
    }
    return {
      amount: pendingTransferReview ? expectedAmount : amount,
      currency,
      quantity: 1,
      unitAmount: expectedAmount,
      concept: expectedConcept,
      description: cleanString(direct.description),
      collectionMethod: expectedCollectionMethod,
      paymentPurpose,
      expectedPayment: {
        mode: 'fixed',
        amount: expectedAmount,
        minAmount: null,
        maxAmount: null,
        currency: accountCurrency
      },
      gateway: cleanString(paymentCapability.gateway).toLowerCase(),
      installments: paymentCapability.installments || { enabled: false, maxInstallments: 0 },
      afterPayment: paymentCapability.afterPayment === 'handoff' ? 'handoff' : 'continue'
    }
  }

  const productId = cleanString(paymentCapability.productId)
  const priceId = cleanString(paymentCapability.priceId)
  const row = await db.get(
    `SELECT p.id AS product_id, p.ghl_product_id, p.currency AS product_currency,
            pp.id AS price_id, pp.ghl_price_id, pp.amount, pp.currency AS price_currency
     FROM products p
     INNER JOIN product_prices pp ON pp.product_id = p.id
     WHERE p.is_active = 1
       AND (p.id = ? OR p.ghl_product_id = ?)
       AND (pp.id = ? OR pp.ghl_price_id = ?)
     LIMIT 1`,
    [productId, productId, priceId, priceId]
  )
  const catalogCurrency = cleanString(row?.price_currency || row?.product_currency).toUpperCase()
  const unitAmount = normalizeMoney(row?.amount, catalogCurrency)
  const expectedAmount = normalizeMoney(unitAmount * quantity, accountCurrency)
  const actionProductId = cleanString(action?.catalogEvidence?.productId)
  const actionPriceId = cleanString(action?.catalogEvidence?.priceId)
  if (
    !row ||
    catalogCurrency !== accountCurrency ||
    !unitAmount ||
    (!pendingTransferReview && amount !== expectedAmount) ||
    (expectedCollectionMethod === 'payment_link' && actionProductId !== cleanString(row.product_id)) ||
    (expectedCollectionMethod === 'payment_link' && actionPriceId !== cleanString(row.price_id))
  ) {
    throw testError('El producto, precio o monto del cobro cambió. Vuelve a enviar el mensaje para probar el valor vigente.', 409, 'test_payment_authority_changed')
  }
  return {
    amount: pendingTransferReview ? expectedAmount : amount,
    currency,
    quantity,
    unitAmount,
    concept: cleanString(action?.concept) || 'Pago',
    collectionMethod: expectedCollectionMethod,
    paymentPurpose,
    expectedPayment: {
      mode: 'fixed',
      amount: expectedAmount,
      minAmount: null,
      maxAmount: null,
      currency: accountCurrency
    },
    gateway: cleanString(paymentCapability.gateway).toLowerCase(),
    installments: paymentCapability.installments || { enabled: false, maxInstallments: 0 },
    afterPayment: paymentCapability.afterPayment === 'handoff' ? 'handoff' : 'continue'
  }
}

function testReceiptMatchesVerifiedPayment(receiptAnalysis, verifiedPayment) {
  if (!receiptAnalysis?.ok || !receiptAnalysis?.isPaymentReceipt) return false
  const expected = verifiedPayment?.expectedPayment || {}
  const detectedCurrency = cleanString(receiptAnalysis.currency).toUpperCase()
  const expectedCurrency = cleanString(expected.currency || verifiedPayment?.currency).toUpperCase()
  if (detectedCurrency && detectedCurrency !== expectedCurrency) return false
  const detectedAmount = normalizeMoney(receiptAnalysis.amount, expectedCurrency)
  if (!detectedAmount) return false
  if (expected.mode === 'range') {
    const min = normalizeMoney(expected.minAmount, expectedCurrency)
    const max = normalizeMoney(expected.maxAmount, expectedCurrency)
    return (!min || detectedAmount >= min) && (!max || detectedAmount <= max)
  }
  return detectedAmount === normalizeMoney(expected.amount ?? verifiedPayment?.amount, expectedCurrency)
}

async function resolveTestAppointmentOfferBinding(runContext, capabilitiesConfig, action) {
  if (cleanString(action?.paymentPurpose) !== 'appointment_deposit') return null
  const schedule = getConversationalCapability({ capabilitiesConfig }, 'schedule_appointment')
  const payment = getConversationalCapability({ capabilitiesConfig }, 'collect_payment')
  const usesAppointmentDeposit = Boolean(
    schedule?.enabled &&
    payment?.enabled &&
    (payment.paymentMode === 'deposit' || payment.deposit?.enabled === true)
  )
  if (!usesAppointmentDeposit) return null

  const previewScopeId = buildConversationalAppointmentPreviewScopeId({
    testSessionId: runContext?.id,
    requestedByUserId: runContext?.requestedByUserId,
    agentId: runContext?.agent?.id
  })
  const offerEventId = buildConversationalAppointmentPreviewOfferEventId(previewScopeId)
  const offer = offerEventId
    ? await db.get(
        `SELECT id, contact_id, agent_id, event_type, detail_json
         FROM conversational_agent_events WHERE id = ?`,
        [offerEventId]
      )
    : null
  const detail = parseJson(offer?.detail_json, {})
  const configuredBookingOwner = schedule?.bookingOwner === 'human' ? 'human' : 'ai'
  const configuredTerminalToolName = configuredBookingOwner === 'human'
    ? 'request_human_booking'
    : 'book_appointment'
  const terminalBindingMatches = Boolean(
    cleanString(detail.bookingOwner) === configuredBookingOwner &&
    cleanString(detail.terminalToolName) === configuredTerminalToolName
  )
  const configuredCalendarId = cleanString(schedule?.calendarId)
  const calendar = configuredCalendarId
    ? await db.get(
        `SELECT id, ghl_calendar_id, is_active FROM calendars
         WHERE id = ? OR ghl_calendar_id = ? LIMIT 1`,
        [configuredCalendarId, configuredCalendarId]
      )
    : null
  const calendarMatches = Boolean(
    calendar &&
    !['0', 'false', 'off'].includes(String(calendar.is_active ?? '1').trim().toLowerCase()) &&
    [calendar.id, calendar.ghl_calendar_id].filter(Boolean).map(String).includes(cleanString(detail.calendarId))
  )
  const identityMatches = Boolean(
    offer?.event_type === CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT &&
    cleanString(offer?.contact_id) === cleanString(runContext?.contact?.id) &&
    cleanString(offer?.agent_id) === cleanString(runContext?.agent?.id) &&
    cleanString(detail.previewScopeId) === previewScopeId &&
    cleanString(detail.status) === 'accepted' &&
    cleanString(detail.acceptedExecutionId) === cleanString(runContext?.executionId) &&
    Number.isFinite(Date.parse(detail.startTime || '')) &&
    calendarMatches &&
    terminalBindingMatches
  )
  if (!identityMatches) {
    throw testError(
      terminalBindingMatches
        ? 'El anticipo de prueba no conserva una selección exacta de horario en esta sesión. Vuelve a ofrecer un horario y confírmalo antes de crear el link.'
        : 'Cambió quién debe terminar de agendar durante la prueba. No se creó otro cobro; reinicia el tester.',
      409,
      terminalBindingMatches ? 'test_payment_appointment_offer_missing' : 'test_payment_terminal_config_changed'
    )
  }
  return {
    previewScopeId,
    offerEventId: offer.id,
    offerFingerprint: sha256(offer.detail_json),
    calendarId: cleanString(detail.calendarId),
    startTime: cleanString(detail.startTime),
    acceptedExecutionId: cleanString(detail.acceptedExecutionId),
    bookingOwner: configuredBookingOwner,
    terminalToolName: configuredTerminalToolName
  }
}

function actionForEffect(actions, effectType) {
  const acceptedTypes = effectType === 'appointment'
    ? new Set(['book_appointment', 'request_human_booking'])
    : effectType === 'payment'
      ? new Set(['create_payment_link', 'register_deposit_payment_proof'])
      : new Set(['request_human_booking'])
  return (Array.isArray(actions) ? actions : []).find((action) => (
    acceptedTypes.has(cleanString(action?.type)) && previewActionSucceeded(action)
  )) || null
}

async function recordPreviewEffect({ runContext, actions, effectType, capabilitiesConfig }) {
  const action = actionForEffect(actions, effectType)
  if (!action) return null

  // El modelo pudo tardar varios segundos. La configuración guardada vuelve a
  // comprobarse después de su respuesta y no se confía en el snapshot previo.
  capabilitiesConfig = await assertCurrentTestRunAuthority({
    id: runContext.id,
    agent_id: runContext.agent.id,
    effects_json: JSON.stringify(runContext.effects)
  }, effectType)
  const appointmentOfferBinding = effectType === 'payment'
    ? await resolveTestAppointmentOfferBinding(runContext, capabilitiesConfig, action)
    : null

  const scheduleForAssignment = getConversationalCapability({ capabilitiesConfig }, 'schedule_appointment')
  const assignmentTargetUserId = cleanString(scheduleForAssignment?.handoffUserId)
  const assignmentTargetUserName = cleanString(scheduleForAssignment?.handoffUserName)

  const request = effectType === 'appointment'
    ? {
        calendarId: cleanString(action.calendarId),
        startTime: cleanString(action.startTime),
        endTime: cleanString(action.endTime),
        title: cleanString(action.title),
        bookingOwner: cleanString(action.type) === 'request_human_booking' ? 'human' : 'ai',
        confirmationEvidence: action.confirmationEvidence,
        participants: Array.isArray(action.participants) ? action.participants : []
      }
    : effectType === 'payment'
      ? {
        amount: Number.isFinite(Number(action.amount)) && Number(action.amount) > 0 ? Number(action.amount) : null,
        unitAmount: Number.isFinite(Number(action.unitAmount)) && Number(action.unitAmount) > 0 ? Number(action.unitAmount) : null,
        quantity: Number(action.quantity || 1),
        currency: cleanString(action.currency).toUpperCase(),
        concept: cleanString(action.concept),
        productId: cleanString(action.catalogEvidence?.productId),
        priceId: cleanString(action.catalogEvidence?.priceId),
        collectionMethod: cleanString(action.type) === 'register_deposit_payment_proof' ? 'bank_transfer' : 'payment_link',
        paymentPurpose: cleanString(action.paymentPurpose),
        afterPayment: action.afterPayment === 'handoff' ? 'handoff' : 'continue',
        ...(cleanString(action.type) === 'register_deposit_payment_proof'
          ? {
              receiptAnalysis: publicTestReceiptAnalysis(action.outcome?.analysis || action.analysis),
              expectedMode: cleanString(action.outcome?.expectedMode) === 'range' ? 'range' : 'fixed',
              expectedAmount: Number.isFinite(Number(action.outcome?.expectedAmount)) && Number(action.outcome.expectedAmount) > 0
                ? Number(action.outcome.expectedAmount)
                : null,
              expectedMinAmount: Number.isFinite(Number(action.outcome?.expectedMinAmount)) && Number(action.outcome.expectedMinAmount) > 0
                ? Number(action.outcome.expectedMinAmount)
                : null,
              expectedMaxAmount: Number.isFinite(Number(action.outcome?.expectedMaxAmount)) && Number(action.outcome.expectedMaxAmount) > 0
                ? Number(action.outcome.expectedMaxAmount)
                : null,
              expectedCurrency: cleanString(action.outcome?.expectedCurrency || action.currency).toUpperCase(),
              manualReviewRequired: true,
              paymentConfirmed: false
            }
          : {}),
        ...(appointmentOfferBinding ? { appointmentOfferBinding } : {})
      }
      : {
          actionType: cleanString(action.type),
          targetUserId: assignmentTargetUserId,
          targetUserName: assignmentTargetUserName,
          reason: cleanString(action.motivo || action.reason || 'Transferencia confirmada en el tester'),
          startTime: cleanString(action.startTime)
        }

  const lockInput = {
    agentId: runContext.agent.id,
    purpose: `test_effect:${runContext.id}:${effectType}`
  }
  const materializeEffect = async () => {
    const claim = await beginConversationalAgentTestEffect({
      testRunId: runContext.id,
      testMessageId: runContext.messageId,
      requestedByUserId: runContext.requestedByUserId,
      effectType,
      request,
      exclusiveMutationLockHeld: true
    })
    if (!claim.claimed) {
      if (claim.reused && claim.effect?.id) {
        if (
          claim.effect.type !== 'assignment' &&
          TERMINAL_TEST_EFFECT_STATUSES.has(cleanString(claim.effect.status))
        ) {
          await ensureConversationalAgentTestEffectNotification(claim.effect.id).catch((error) => {
            logger.warn(`[Tester agente] No se pudo reintentar la notificación ${claim.effect.id}: ${error.message}`)
          })
        }
        const refreshed = await db.get('SELECT * FROM conversational_agent_test_effects WHERE id = ?', [claim.effect.id])
        return publicEffect(refreshed || {})
      }
      return claim.effect
    }

    try {
      capabilitiesConfig = await assertCurrentTestRunAuthority(claim.run, effectType)
      if (effectType === 'payment' && appointmentOfferBinding) {
        const currentBinding = await resolveTestAppointmentOfferBinding(runContext, capabilitiesConfig, action)
        if (JSON.stringify(currentBinding) !== JSON.stringify(appointmentOfferBinding)) {
          throw testError(
            'La oferta de la cita cambió mientras se preparaba el anticipo de prueba. No se registró el cobro de prueba.',
            409,
            'test_payment_appointment_offer_changed'
          )
        }
      }
      if (effectType === 'assignment') {
        await assertCurrentTestRunAuthority(claim.run, 'assignment')
        if (!assignmentTargetUserId) {
          throw testError('La acción eligió pasar el caso, pero no hay una persona responsable configurada.', 409, 'test_assignment_user_required')
        }
        const assignment = await assignConversationalAgentTestContact({
          effectId: claim.effect.id,
          testRunId: runContext.id,
          agentId: runContext.agent.id,
          requestedByUserId: runContext.requestedByUserId,
          contactId: runContext.contact.id,
          targetUserId: assignmentTargetUserId
        })
        return await completeConversationalAgentTestEffect({
          effectId: claim.effect.id,
          claimToken: claim.claimToken,
          status: 'recorded',
          entityId: runContext.contact.id,
          payload: {
            ...request,
            contactId: runContext.contact.id,
            contactName: runContext.contact.full_name || runContext.contact.first_name || 'Contacto de prueba',
            assignmentActive: true,
            assignedUserId: assignment.targetUserId,
            previousAssignedUserId: assignment.previousUserId,
            cleanupDueAt: assignment.cleanupDueAt,
            notificationStatus: assignment.notificationStatus,
            safeTestRecord: true,
            summary: `Contacto asignado temporalmente a ${assignmentTargetUserName || 'la persona configurada'}. La notificación de prueba se envió y el responsable anterior se restaurará en cinco minutos.`
          }
        })
      }

      if (effectType === 'appointment') {
        capabilitiesConfig = await assertCurrentTestRunAuthority(claim.run, 'appointment')
        const schedule = getConversationalCapability({ capabilitiesConfig }, 'schedule_appointment')
        const humanBooking = action.type === 'request_human_booking'
        const canonicalReplay = !humanBooking && await hasCanonicalTestAppointmentReplay({
          effectId: claim.effect.id,
          runContext,
          request
        })
        await verifyTestAppointmentAction(action, schedule, { allowCanonicalReplay: canonicalReplay })
        await claimPreviewAppointmentOfferForTestEffect({
          runContext,
          request,
          effectId: claim.effect.id
        })
        if (humanBooking) {
          const humanTargetLabel = cleanString(schedule?.handoffUserName)
            ? `a ${cleanString(schedule.handoffUserName)}`
            : 'al equipo sin asignar una persona'
          const payload = {
            ...request,
            contactId: runContext.contact.id,
            contactName: runContext.contact.full_name || runContext.contact.first_name || 'Contacto de prueba',
            safeTestRecord: true,
            appointmentCreated: false,
            summary: `El horario real sigue libre. La solicitud quedó registrada para entregarse ${humanTargetLabel} y se solicitó la notificación de prueba; no se creó ni prometió una cita.`
          }
          return finalizeConversationalAppointmentTestEffect({
            runContext,
            effectId: claim.effect.id,
            claimToken: claim.claimToken,
            entityId: null,
            payload
          })
        }

        const testExpiresAt = toIso(Date.now() + 5 * 60 * 1000)
        await assertCurrentTestRunAuthority(claim.run, 'appointment')
        const appointmentControllerRequest = {
          body: {
            calendarId: request.calendarId,
            contactId: runContext.contact.id,
            title: `[PRUEBA] ${request.title || 'Cita del agente'}`,
            notes: 'Cita temporal creada por el Modo test del agente. Se elimina automáticamente después de cinco minutos.',
            startTime: request.startTime,
            endTime: request.endTime,
            clientRequestId: `conv-test:${claim.effect.id}`,
            strictAvailabilityCheck: true,
            ignoreAppointmentConflicts: false,
            source: 'conversational_agent_test',
            isTest: true,
            testRunId: runContext.id,
            testEffectId: claim.effect.id,
            testExpiresAt,
            participants: request.participants
          },
          user: { userId: runContext.requestedByUserId },
          internalContext: { conversationalAgentTestAppointment: true }
        }
        const controllerExecution = await runBoundedAppointmentControllerRequest({
          invoke: () => invokeController(createAppointmentControllerImpl, appointmentControllerRequest)
        })
        const controllerResult = toToolResult(controllerExecution.result)
        if (!controllerResult.ok || !controllerResult.data?.id) {
          const controllerFailureCode = cleanString(controllerExecution.result?.payload?.code)
          const controllerStatusCode = Number(controllerResult.statusCode) || 502
          const slotNoLongerFree = controllerStatusCode === 409 && [
            'slot_unavailable',
            'appointment_slot_unavailable'
          ].includes(controllerFailureCode)
          // El primer error de mirror conserva el código específico del
          // provider; los replays usan el código canónico. El ledger durable es
          // la fuente de verdad para que ambos turnos muestren el mismo estado.
          const durableRequestState = await inspectAppointmentCreationRequestRecoveryState(
            `conv-test:${claim.effect.id}`
          ).catch(() => null)
          const interruptedCheckpoint = controllerFailureCode === 'test_appointment_checkpoint_interrupted' ||
            durableRequestState?.failureKind === TEST_APPOINTMENT_CHECKPOINT_INTERRUPTED_FAILURE_KIND
          const providerSyncFailed = controllerFailureCode === 'test_appointment_provider_sync_failed' ||
            durableRequestState?.failureKind === TEST_APPOINTMENT_PROVIDER_SYNC_FAILURE_KIND
          throw testError(
            controllerResult.error || 'El calendario no confirmó la cita temporal.',
            controllerStatusCode,
            slotNoLongerFree
              ? TEST_SLOT_NO_LONGER_FREE_CODE
              : interruptedCheckpoint
                ? 'test_appointment_checkpoint_interrupted'
                : providerSyncFailed
                  ? 'test_appointment_provider_sync_failed'
                  : 'test_appointment_creation_failed'
          )
        }
        const appointment = controllerResult.data
        const automationExecution = appointment.testAutomationExecution || appointment.testAutomationPreview || null
        const automationMatches = [
          ...(automationExecution?.booked?.execution?.matched || automationExecution?.booked?.preview?.matched || []),
          ...(automationExecution?.status?.execution?.matched || automationExecution?.status?.preview?.matched || [])
        ]
        const uniqueAutomationNames = [...new Set(
          automationMatches.map((item) => cleanString(item?.name)).filter(Boolean)
        )]
        const automationRealActionCount = Number(automationExecution?.booked?.execution?.realActionCount || 0) +
          Number(automationExecution?.status?.execution?.realActionCount || 0)
        const automationSimulatedActionCount = Number(automationExecution?.booked?.execution?.simulatedActionCount || 0) +
          Number(automationExecution?.status?.execution?.simulatedActionCount || 0)
        const reminderNotificationCount = Number(automationExecution?.reminders?.sentCount || 0)
        const payload = {
          ...request,
          contactId: runContext.contact.id,
          contactName: runContext.contact.full_name || runContext.contact.first_name || 'Contacto de prueba',
          safeTestRecord: true,
          appointmentCreated: true,
          appointmentId: appointment.id,
          controllerAttempts: controllerExecution.attempts,
          retried: controllerExecution.retried,
          testExpiresAt,
          cleanupDueAt: testExpiresAt,
          automationExecution,
          automationPreview: automationExecution,
          summary: `Cita de prueba creada de verdad. Se enviaron las notificaciones seguras${automationRealActionCount ? ` y ${automationRealActionCount} acción(es) real(es) aislada(s)` : ''}${reminderNotificationCount ? `, incluyendo ${reminderNotificationCount} recordatorio(s) al dueño de la prueba` : ''}${uniqueAutomationNames.length ? `; se recorrieron ${uniqueAutomationNames.length} automatización(es)` : ''}${automationSimulatedActionCount ? ` y ${automationSimulatedActionCount} efecto(s) irreversible(s) quedaron simulados` : ''}. La cita se eliminará automáticamente después de cinco minutos.`
        }
        return finalizeConversationalAppointmentTestEffect({
          runContext,
          effectId: claim.effect.id,
          claimToken: claim.claimToken,
          entityId: appointment.id,
          payload
        })
      }

      capabilitiesConfig = await assertCurrentTestRunAuthority(claim.run, 'payment')
      const payment = getConversationalCapability({ capabilitiesConfig }, 'collect_payment')
      const bankTransferProof = cleanString(action.type) === 'register_deposit_payment_proof'
      const verifiedPayment = await verifyTestPaymentAction(action, payment, {
        collectionMethod: bankTransferProof ? 'bank_transfer' : 'payment_link'
      })
      await assertCurrentTestRunAuthority(claim.run, 'payment')
      if (bankTransferProof) {
        const receiptAnalysis = publicTestReceiptAnalysis(action.outcome?.analysis || action.analysis)
        const detectedAmount = normalizeMoney(receiptAnalysis.amount, receiptAnalysis.currency || verifiedPayment.currency)
        const receiptMatchesConfiguredPayment = testReceiptMatchesVerifiedPayment(receiptAnalysis, verifiedPayment)
        return await completeConversationalAgentTestEffect({
          effectId: claim.effect.id,
          claimToken: claim.claimToken,
          status: 'recorded',
          entityId: null,
          payload: {
            ...request,
            ...verifiedPayment,
            contactId: runContext.contact.id,
            contactName: runContext.contact.full_name || runContext.contact.first_name || 'Contacto de prueba',
            safeTestRecord: true,
            paymentCreated: false,
            paymentConfirmed: false,
            linkSent: false,
            manualReviewRequired: true,
            wouldRegisterPendingReview: true,
            receiptAnalyzed: true,
            receiptMatchesConfiguredPayment,
            receiptAnalysis,
            paymentMode: 'test',
            summary: receiptMatchesConfiguredPayment
              ? `Comprobante analizado en Modo test: coincide con ${detectedAmount} ${verifiedPayment.currency}. En vivo quedaría pendiente de revisión; no se creó ni confirmó ningún pago.`
              : 'La imagen se analizó en Modo test y en vivo quedaría pendiente de revisión humana. No se creó ni confirmó ningún pago.'
          }
        })
      }
      const link = await createConversationalAgentTestPaymentLink({
        effectId: claim.effect.id,
        testRunId: runContext.id,
        agentId: runContext.agent.id,
        requestedByUserId: runContext.requestedByUserId,
        contact: {
          id: runContext.contact.id,
          name: runContext.contact.full_name || runContext.contact.first_name || 'Contacto de prueba',
          email: runContext.contact.email || '',
          phone: runContext.contact.phone || ''
        },
        paymentGateConfig: {
          gateway: verifiedPayment.gateway,
          billingType: 'single',
          amount: verifiedPayment.amount,
          currency: verifiedPayment.currency,
          productName: verifiedPayment.concept || request.concept || 'Pago de prueba',
          description: verifiedPayment.description || verifiedPayment.concept || request.concept || 'Pago de prueba',
          msi: verifiedPayment.installments || { enabled: false, maxInstallments: 0 }
        }
      })
      return await completeConversationalAgentTestEffect({
        effectId: claim.effect.id,
        claimToken: claim.claimToken,
        status: 'prepared',
        entityId: link.paymentId,
        payload: {
          ...request,
          ...verifiedPayment,
          contactId: runContext.contact.id,
          contactName: runContext.contact.full_name || runContext.contact.first_name || 'Contacto de prueba',
          safeTestRecord: true,
          paymentCreated: true,
          paymentConfirmed: false,
          paymentId: link.paymentId,
          publicPaymentId: link.publicPaymentId,
          provider: link.provider,
          paymentMode: 'test',
          paymentUrl: link.url,
          cleanupDueAt: link.cleanupDueAt,
          linkSent: true,
          summary: `Enlace sandbox creado por ${request.amount} ${request.currency}. El webhook puede confirmarlo y se eliminará automáticamente después de cinco minutos.`
        }
      })
    } catch (error) {
      if (effectType === 'appointment' && error?.code === TEST_SLOT_NO_LONGER_FREE_CODE) {
        try {
          error.appointmentDateRestored = await restorePreviewAppointmentDateAfterSlotConflict({
            runContext,
            request,
            effectId: claim.effect.id
          })
        } catch (restoreError) {
          error.appointmentDateRestored = false
          error.appointmentDateRestoreError = cleanString(restoreError?.code || restoreError?.message)
          logger.error(`[Tester agente] No se pudo conservar la fecha después de perder el slot: ${restoreError.message}`)
        }
        // El conflicto de slot sólo es una salida terminal cuando el progreso
        // quedó reparado y conserva el día. Si la reparación falló, el mismo
        // efecto debe volver a intentarla; cachearlo recrearía el loop original.
        error.retryable = error.appointmentDateRestored !== true
      }
      await failConversationalAgentTestEffect({
        effectId: claim.effect.id,
        claimToken: claim.claimToken,
        error
      })
      throw error
    }
  }
  return effectType === 'appointment'
    ? withConversationalAppointmentTestEffectLock(lockInput, materializeEffect)
    : withConversationalAgentTestMutationLock(lockInput, materializeEffect)
}

export async function recordConversationalAgentPreviewEffects({ runContext, actions = [] } = {}) {
  if (!runContext?.effects?.enabled) return []
  const capabilitiesConfig = await loadPersistedCapabilities(runContext)
  const requested = []
  if (runContext.effects.scheduleAppointment) requested.push('appointment')
  if (runContext.effects.collectPayment) requested.push('payment')
  if (runContext.effects.assignUser) requested.push('assignment')

  const results = []
  for (const effectType of requested) {
    try {
      const recorded = await recordPreviewEffect({ runContext, actions, effectType, capabilitiesConfig })
      if (recorded) results.push(recorded)
    } catch (error) {
      const effectStillProcessing = cleanString(error?.code) === 'test_mutation_lock_busy'
      const retryable = effectStillProcessing || isRetryableTestEffectError(error)
      results.push({
        type: effectType,
        // El timeout del contender no cancela al dueño del advisory lock. Puede
        // seguir materializando; exponerlo como failed/no-creado sería inventar
        // un estado final que todavía no conocemos.
        status: effectStillProcessing ? 'processing' : 'failed',
        code: cleanString(error?.code) || 'test_effect_failed',
        retryable,
        statusCode: Number(error?.statusCode) || 500,
        appointmentDateRestored: error?.appointmentDateRestored === true,
        appointmentDateRestoreError: cleanString(error?.appointmentDateRestoreError) || null,
        summary: error.message || 'No se pudo registrar esta acción de prueba.'
      })
    }
  }
  return results
}

/**
 * El texto del preview sólo puede prometer una cita después de materializar el
 * efecto real. Si la materialización falla, sustituye cualquier confirmación
 * redactada por el modelo y marca la acción devuelta como fallida. Pagos y
 * asignaciones conservan intacto su resultado.
 */
export function reconcileConversationalAgentPreviewResult({ result, testEffects = [] } = {}) {
  const source = result && typeof result === 'object' ? result : {}
  const effects = Array.isArray(testEffects) ? testEffects : []
  const sourceActions = Array.isArray(source.actions) ? source.actions : []
  const appointmentActions = sourceActions.filter((action) => (
    ['book_appointment', 'request_human_booking'].includes(cleanString(action?.type))
  ))
  if (!appointmentActions.length) return source

  const appointmentEffect = effects.find((effect) => cleanString(effect?.type) === 'appointment') || null
  const assignmentEffect = effects.find((effect) => cleanString(effect?.type) === 'assignment') || null
  const appointmentStatus = cleanString(appointmentEffect?.status).toLowerCase()
  const assignmentStatus = cleanString(assignmentEffect?.status).toLowerCase()
  const humanBooking = appointmentActions.some((action) => cleanString(action?.type) === 'request_human_booking')
  const appointmentRecorded = appointmentStatus === 'recorded' &&
    appointmentEffect?.payload?.safeTestRecord === true &&
    (humanBooking
      ? appointmentEffect?.payload?.appointmentCreated === false
      : appointmentEffect?.payload?.appointmentCreated === true && Boolean(cleanString(appointmentEffect?.entityId)))
  const assignmentRecorded = !assignmentEffect || (
    assignmentStatus === 'recorded' &&
    assignmentEffect?.payload?.assignmentActive === true &&
    Boolean(cleanString(assignmentEffect?.entityId))
  )
  const fullyRecorded = appointmentRecorded && assignmentRecorded

  const appointmentProcessing = ['processing', 'pending'].includes(appointmentStatus)
  const assignmentProcessing = Boolean(assignmentEffect) && ['processing', 'pending'].includes(assignmentStatus)
  const appointmentCleaned = appointmentStatus === 'cleaned'
  const assignmentCleaned = assignmentStatus === 'cleaned'
  const slotNoLongerFree = cleanString(appointmentEffect?.code) === TEST_SLOT_NO_LONGER_FREE_CODE
  const interruptedCheckpoint = cleanString(appointmentEffect?.code) === 'test_appointment_checkpoint_interrupted'
  const providerSyncFailed = cleanString(appointmentEffect?.code) === 'test_appointment_provider_sync_failed'
  const restoredDate = appointmentEffect?.appointmentDateRestored === true
  const appointmentCode = cleanString(appointmentEffect?.code) || (
    appointmentProcessing
      ? 'test_appointment_effect_processing'
      : appointmentCleaned
        ? 'test_appointment_effect_cleaned'
        : appointmentEffect
          ? 'test_appointment_effect_unverified'
          : 'test_appointment_effect_missing'
  )
  const assignmentCode = cleanString(assignmentEffect?.code) || (
    assignmentProcessing
      ? 'test_assignment_effect_processing'
      : assignmentCleaned
        ? 'test_assignment_effect_cleaned'
        : 'test_assignment_effect_unverified'
  )

  let reply
  if (fullyRecorded) {
    reply = humanBooking
      ? (assignmentEffect
          ? 'Listo, la solicitud de cita de prueba quedó registrada y la asignación temporal quedó preparada.'
          : 'Listo, la solicitud de cita de prueba quedó registrada para entregarse al equipo.')
      : 'Listo, la cita de prueba quedó confirmada.'
  } else if (!appointmentRecorded) {
    reply = appointmentProcessing
      ? 'La cita de prueba sigue procesándose. Todavía no puedo confirmarla; espera un momento y vuelve a intentarlo.'
      : appointmentCleaned
        ? 'Esa cita de prueba ya terminó su limpieza automática; no hay una cita de prueba activa.'
        : slotNoLongerFree
          ? (restoredDate
              ? 'Ese horario ya no está disponible. Conservé el día; ¿qué otra hora te funciona?'
              : 'Ese horario ya no está disponible. Dime qué fecha u hora quieres revisar.')
          : interruptedCheckpoint
            ? 'La prueba se interrumpió después de guardar una cita temporal. No la des por confirmada; el sistema la retirará automáticamente. Vuelve a probar cuando termine la limpieza.'
            : providerSyncFailed
              ? 'El proveedor externo no confirmó todos los efectos de esta cita temporal. No la des por agendada; el sistema la retirará automáticamente.'
          : 'No pude confirmar el resultado de esa cita de prueba. No la des por agendada; vuelve a intentarlo o revisa la bitácora.'
    if (assignmentEffect && assignmentRecorded) {
      reply += ' La asignación temporal del contacto sí quedó registrada.'
    } else if (assignmentProcessing) {
      reply += ' La asignación temporal también sigue procesándose.'
    }
  } else if (assignmentProcessing) {
    reply = 'La solicitud de cita de prueba sí quedó registrada, pero la asignación temporal todavía se está procesando.'
  } else if (assignmentCleaned) {
    reply = 'La solicitud de cita de prueba ya se procesó y la asignación temporal ya terminó su limpieza automática.'
  } else {
    reply = 'La solicitud de cita de prueba sí quedó registrada, pero no pude completar la asignación temporal del contacto.'
  }

  const actions = sourceActions.map((action) => {
    const actionType = cleanString(action?.type)
    if (!['book_appointment', 'request_human_booking'].includes(actionType)) return action
    const originalOutcome = action?.outcome && typeof action.outcome === 'object' ? action.outcome : {}
    const sharedAssignmentSucceeded = actionType === 'request_human_booking' && assignmentEffect && assignmentRecorded
    const appointmentState = appointmentRecorded
      ? 'recorded'
      : appointmentProcessing
        ? 'processing'
        : appointmentCleaned
          ? 'cleaned'
          : 'failed'
    const assignmentState = !assignmentEffect
      ? 'not_requested'
      : assignmentRecorded
        ? 'recorded'
        : assignmentProcessing
          ? 'processing'
          : assignmentCleaned
            ? 'cleaned'
            : 'failed'
    const partialSuccess = (appointmentRecorded && !assignmentRecorded) || (!appointmentRecorded && sharedAssignmentSucceeded)
    return {
      ...action,
      outcome: {
        ...originalOutcome,
        status: fullyRecorded
          ? 'recorded'
          : partialSuccess
            ? 'partial'
            : (appointmentProcessing || assignmentProcessing ? 'pending' : 'error'),
        ok: fullyRecorded,
        simulated: false,
        actionCompleted: fullyRecorded || partialSuccess,
        materialized: fullyRecorded,
        appointmentMaterialized: appointmentRecorded,
        assignmentMaterialized: assignmentEffect ? assignmentRecorded : false,
        appointmentEffectStatus: appointmentState,
        assignmentEffectStatus: assignmentState,
        code: fullyRecorded ? null : (appointmentRecorded ? assignmentCode : appointmentCode),
        error: fullyRecorded
          ? null
          : !appointmentRecorded
            ? (cleanString(appointmentEffect?.summary) || reply)
            : (cleanString(assignmentEffect?.summary) || reply),
        ...(cleanString(appointmentEffect?.id) ? { appointmentEffectId: appointmentEffect.id } : {}),
        ...(cleanString(appointmentEffect?.entityId) ? { appointmentId: appointmentEffect.entityId } : {})
      }
    }
  })
  return {
    ...source,
    reply,
    replyParts: [reply],
    replyPartDelaysMs: [],
    actions
  }
}

async function dispatchConversationalAgentTestEffectNotification(effectRow) {
  if (!effectRow?.id) return { skipped: true, reason: 'effect_missing' }
  if (effectRow.status === 'cleaned' || effectRow.cleanup_status === 'cleaned') {
    return { skipped: true, reason: 'effect_cleaned' }
  }
  if (effectRow.effect_type === 'assignment') return { skipped: true, reason: 'assignment_notified_by_target_service' }
  const run = await db.get('SELECT * FROM conversational_agent_test_runs WHERE id = ?', [effectRow.run_id])
  const effects = normalizeConversationalAgentTestEffects(parseJson(run?.effects_json, {}))
  if (!run || effects.notifyOwner !== true) return { skipped: true, reason: 'disabled' }

  const staleBefore = toIso(Date.now() - TEST_NOTIFICATION_STALE_MS)
  const claimedAt = toIso()
  const claimed = await db.run(
    `UPDATE conversational_agent_test_effects
     SET notification_status = 'dispatching', notification_error = NULL,
         updated_at = ?
     WHERE id = ? AND (
       notification_status = 'pending' OR
       (notification_status = 'dispatching' AND updated_at <= ?)
     )`,
    [claimedAt, effectRow.id, staleBefore]
  )
  if (mutationCount(claimed) !== 1) return { skipped: true, reason: 'already_notified' }

  const payload = parseJson(effectRow.payload_json, {})
  const isAppointment = effectRow.effect_type === 'appointment'
  const isPayment = effectRow.effect_type === 'payment'
  const isTransferReview = isPayment && payload.collectionMethod === 'bank_transfer'
  const title = isAppointment
      ? (payload.appointmentCreated
        ? 'Modo test · cita temporal creada'
        : 'Modo test · horario entregado al equipo')
    : isTransferReview
      ? 'Modo test · comprobante analizado'
      : isPayment
      ? 'Modo test · enlace sandbox creado'
      : 'Modo test · contacto asignado temporalmente'
  const message = isAppointment
    ? `${payload.startTime || 'Horario validado'} · ${payload.contactName || 'Contacto de prueba'} · se limpia en 5 minutos`
    : isTransferReview
      ? `${payload.amount ?? ''} ${payload.currency || ''} · ${payload.contactName || 'Contacto de prueba'} · pendiente de revisión, sin confirmar pago`.trim()
      : isPayment
      ? `${payload.amount ?? ''} ${payload.currency || ''} · ${payload.contactName || 'Contacto de prueba'} · sandbox`.trim()
      : `${payload.contactName || 'Contacto de prueba'} · asignación temporal de 5 minutos`
  try {
    const notification = await createInternalNotification({
      recipientUserIds: [run.requested_by_user_id],
      source: 'Tester del agente',
      severity: 'info',
      title,
      message,
      actionUrl: `/ai-agent/conversational/${run.agent_id}`,
      actionLabel: 'Abrir prueba',
      category: 'conversational_agent_test',
      contactId: run.contact_id,
      metadata: { testRunId: run.id, testEffectId: effectRow.id, testEffectType: effectRow.effect_type }
    })
    await db.run(
      `UPDATE conversational_agent_test_effects
       SET notification_status = 'sent', notification_sent_at = CURRENT_TIMESTAMP,
           notification_error = NULL, updated_at = ?
       WHERE id = ? AND notification_status = 'dispatching'`,
      [toIso(), effectRow.id]
    )
    return notification
  } catch (error) {
    await db.run(
      `UPDATE conversational_agent_test_effects
       SET notification_status = 'pending', notification_error = ?,
           updated_at = ?
       WHERE id = ? AND notification_status = 'dispatching'`,
      [cleanString(error.message).slice(0, 1200), toIso(), effectRow.id]
    ).catch(() => undefined)
    throw error
  }
}

export async function ensureConversationalAgentTestEffectNotification(effectId) {
  const row = await db.get(
    'SELECT * FROM conversational_agent_test_effects WHERE id = ?',
    [cleanString(effectId)]
  )
  if (!row) throw testError('El efecto de prueba ya no existe.', 404, 'test_effect_not_found')
  return dispatchConversationalAgentTestEffectNotification(row)
}

async function syncPaymentEffects(rows, requestedByUserId) {
  for (const row of rows || []) {
    if (row.effect_type !== 'payment' || row.status === 'cleaned') continue
    const ledger = await db.get(
      'SELECT effect_id FROM conversational_agent_test_payment_links WHERE effect_id = ?',
      [row.id]
    ).catch(() => null)
    if (!ledger) continue
    await syncConversationalAgentTestPaymentLink({
      effectId: row.id,
      requestedByUserId
    }).catch((error) => {
      logger.warn(`[Tester agente] No se pudo sincronizar el pago sandbox ${row.id}: ${error.message}`)
    })
  }
}

export async function buildConversationalAgentTestRuntimeEventContext({ runContext } = {}) {
  if (!runContext?.id || !runContext?.requestedByUserId) return ''
  let rows = await db.all(
    `SELECT * FROM conversational_agent_test_effects
     WHERE run_id = ? ORDER BY created_at ASC, id ASC`,
    [runContext.id]
  )
  await syncPaymentEffects(rows, runContext.requestedByUserId)
  rows = await db.all(
    `SELECT * FROM conversational_agent_test_effects
     WHERE run_id = ? ORDER BY created_at ASC, id ASC`,
    [runContext.id]
  )

  const facts = []
  for (const row of rows) {
    const payload = parseJson(row.payload_json, {})
    // cleanup_status es la autoridad operativa de los jobs de expiración. La
    // doble comprobación evita que un registro legacy con status viejo haga que
    // la IA afirme que una cita ya eliminada sigue creada.
    if (row.status === 'cleaned' || row.cleanup_status === 'cleaned') continue
    if (row.effect_type === 'payment' && row.status === 'paid_test') {
      facts.push(payload.afterPayment === 'handoff'
        ? `- El pago sandbox por ${payload.amount || ''} ${payload.currency || ''} fue confirmado por webhook. En vivo, Ristak pasaría el chat al equipo en este punto. No ejecutes ni prometas otro objetivo después de este pago dentro de la prueba.`
        : `- El pago sandbox por ${payload.amount || ''} ${payload.currency || ''} fue confirmado por webhook. Trátalo como confirmado sólo dentro de esta prueba y continúa con el siguiente objetivo configurado.`)
    } else if (
      row.effect_type === 'payment' &&
      row.status === 'recorded' &&
      payload.collectionMethod === 'bank_transfer'
    ) {
      facts.push('- El comprobante de transferencia ya fue analizado en esta prueba y quedó representado como pendiente de revisión humana. No existe un pago confirmado ni un enlace sandbox; no afirmes que ya se pagó.')
    } else if (row.effect_type === 'payment' && ['prepared', 'recorded'].includes(row.status)) {
      facts.push('- Ya existe un enlace sandbox pendiente para esta prueba. No crees otro salvo que la persona pida explícitamente reemplazarlo.')
    } else if (
      row.effect_type === 'appointment' &&
      payload.appointmentCreated === true &&
      payload.appointmentCleaned !== true
    ) {
      facts.push(`- La cita temporal de prueba ya fue creada para ${payload.startTime || 'el horario confirmado'} y las notificaciones reales de prueba ya se enviaron. No vuelvas a agendarla.`)
    } else if (row.effect_type === 'assignment' && row.status === 'recorded') {
      facts.push('- El contacto de prueba ya fue asignado temporalmente y la notificación de prueba ya se envió. No repitas la transferencia.')
    }
  }
  return facts.join('\n').slice(0, 2000)
}

export async function getConversationalAgentTestVerifiedPaymentEvidence({ runContext } = {}) {
  if (!runContext?.id || !runContext?.requestedByUserId || !runContext?.agent?.id || !runContext?.contact?.id) return null
  let rows = await db.all(
    `SELECT * FROM conversational_agent_test_effects
     WHERE run_id = ? AND effect_type = 'payment'
     ORDER BY created_at DESC, id DESC`,
    [runContext.id]
  )
  await syncPaymentEffects(rows, runContext.requestedByUserId)
  rows = await db.all(
    `SELECT * FROM conversational_agent_test_effects
     WHERE run_id = ? AND effect_type = 'payment' AND status = 'paid_test'
       AND COALESCE(cleanup_status, '') != 'cleaned'
     ORDER BY created_at DESC, id DESC`,
    [runContext.id]
  )
  for (const row of rows || []) {
    const payload = parseJson(row.payload_json, {})
    const binding = payload.appointmentOfferBinding && typeof payload.appointmentOfferBinding === 'object'
      ? payload.appointmentOfferBinding
      : null
    if (
      payload.paymentConfirmed !== true ||
      cleanString(payload.paymentMode).toLowerCase() !== 'test' ||
      !binding?.offerEventId ||
      !binding?.offerFingerprint
    ) continue
    const offer = await db.get(
      `SELECT id, contact_id, agent_id, event_type, detail_json
       FROM conversational_agent_events WHERE id = ?`,
      [cleanString(binding.offerEventId)]
    )
    const detail = parseJson(offer?.detail_json, {})
    const valid = Boolean(
      offer?.event_type === CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT &&
      cleanString(offer?.contact_id) === cleanString(runContext.contact.id) &&
      cleanString(offer?.agent_id) === cleanString(runContext.agent.id) &&
      cleanString(detail.previewScopeId) === cleanString(binding.previewScopeId) &&
      cleanString(detail.calendarId) === cleanString(binding.calendarId) &&
      cleanString(detail.startTime) === cleanString(binding.startTime) &&
      cleanString(detail.status) === 'accepted' &&
      cleanString(detail.acceptedExecutionId) === cleanString(binding.acceptedExecutionId) &&
      cleanString(detail.bookingOwner) === cleanString(binding.bookingOwner) &&
      cleanString(detail.terminalToolName) === cleanString(binding.terminalToolName) &&
      sha256(offer.detail_json) === cleanString(binding.offerFingerprint)
    )
    if (!valid) continue
    return {
      testRunId: runContext.id,
      testEffectId: row.id,
      paymentMode: 'test',
      paymentPurpose: 'appointment_deposit',
      amount: Number(payload.amount),
      currency: cleanString(payload.currency).toUpperCase(),
      previewScopeId: cleanString(binding.previewScopeId),
      appointmentOfferEventId: offer.id,
      appointmentOfferFingerprint: cleanString(binding.offerFingerprint),
      calendarId: cleanString(binding.calendarId),
      startTime: cleanString(binding.startTime),
      bookingOwner: cleanString(binding.bookingOwner),
      terminalToolName: cleanString(binding.terminalToolName)
    }
  }
  return null
}

export async function listConversationalAgentTestEffects({ testRunId, requestedByUserId } = {}) {
  const runId = normalizeIdentifier(testRunId, TEST_RUN_ID_PATTERN, 'La sesión de prueba')
  await loadOwnedRun(runId, requestedByUserId, { active: false })
  let rows = await db.all(
    `SELECT * FROM conversational_agent_test_effects
     WHERE run_id = ? ORDER BY created_at ASC, id ASC`,
    [runId]
  )
  await syncPaymentEffects(rows, requestedByUserId)
  rows = await db.all(
    `SELECT * FROM conversational_agent_test_effects
     WHERE run_id = ? ORDER BY created_at ASC, id ASC`,
    [runId]
  )
  for (const row of rows) {
    if (TERMINAL_TEST_EFFECT_STATUSES.has(row.status) && row.notification_status === 'pending' && row.notification_error) {
      await dispatchConversationalAgentTestEffectNotification(row).catch(() => undefined)
    }
  }
  rows = await db.all(
    `SELECT * FROM conversational_agent_test_effects
     WHERE run_id = ? ORDER BY created_at ASC, id ASC`,
    [runId]
  )
  return rows.map(publicEffect)
}

export async function listRecentConversationalAgentTestRuns({
  agentId,
  requestedByUserId,
  limit = 10
} = {}) {
  const cleanAgentId = cleanString(agentId)
  const cleanUserId = cleanString(requestedByUserId)
  if (!cleanAgentId || !cleanUserId) {
    throw testError('No se pudo identificar el historial de pruebas solicitado.', 400, 'invalid_test_history_identity')
  }
  const safeLimit = Math.min(20, Math.max(1, Number(limit) || 10))
  const runs = await db.all(
    `SELECT id, agent_id, contact_id, status, created_at, updated_at, expires_at, cleaned_at
     FROM conversational_agent_test_runs
     WHERE agent_id = ? AND requested_by_user_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [cleanAgentId, cleanUserId, safeLimit]
  )
  if (!runs.length) return []

  const runIds = runs.map((run) => run.id)
  const placeholders = runIds.map(() => '?').join(', ')
  let effects = await db.all(
    `SELECT * FROM conversational_agent_test_effects
     WHERE run_id IN (${placeholders})
     ORDER BY created_at ASC, id ASC`,
    runIds
  )
  await syncPaymentEffects(effects, cleanUserId)
  effects = await db.all(
    `SELECT * FROM conversational_agent_test_effects
     WHERE run_id IN (${placeholders})
     ORDER BY created_at ASC, id ASC`,
    runIds
  )
  const effectsByRun = new Map(runIds.map((runId) => [runId, []]))
  for (const effect of effects) {
    effectsByRun.get(effect.run_id)?.push(publicEffect(effect))
  }
  return runs.map((run) => ({
    id: run.id,
    agentId: run.agent_id,
    contactId: run.contact_id,
    status: run.status,
    createdAt: run.created_at || null,
    updatedAt: run.updated_at || null,
    expiresAt: run.expires_at || null,
    cleanedAt: run.cleaned_at || null,
    effects: effectsByRun.get(run.id) || []
  }))
}

export async function cleanupConversationalAgentTestRun({ testRunId, requestedByUserId } = {}) {
  const runId = normalizeIdentifier(testRunId, TEST_RUN_ID_PATTERN, 'La sesión de prueba')
  const run = await loadOwnedRun(runId, requestedByUserId, { active: false })
  if (run.status === 'cleaned') {
    return { runId, cleaned: true, effects: await listConversationalAgentTestEffects({ testRunId: runId, requestedByUserId }) }
  }
  // `cleaning` puede quedar durable si el proceso muere después de cerrar la
  // corrida y antes de terminar sus artefactos. El candado por agente impide
  // dos limpiezas simultáneas, así que permitir retomarla es seguro y evita una
  // sesión imposible de recuperar.
  if (!['active', 'expired', 'cleaning', 'cleanup_failed'].includes(run.status)) {
    throw testError('Esta prueba no se puede limpiar en su estado actual.', 409, 'test_run_cleanup_blocked')
  }

  return withConversationalAgentTestMutationLock({
    agentId: run.agent_id,
    purpose: `test_run_cleanup:${runId}`
  }, async () => {
    const lockedRun = await loadOwnedRun(runId, requestedByUserId, { active: false })
    if (lockedRun.status === 'cleaned') {
      return { runId, cleaned: true, effects: await listConversationalAgentTestEffects({ testRunId: runId, requestedByUserId }) }
    }
    if (!['active', 'expired', 'cleaning', 'cleanup_failed'].includes(lockedRun.status)) {
      throw testError('Esta prueba no se puede limpiar en su estado actual.', 409, 'test_run_cleanup_blocked')
    }

    const closed = await db.run(
      `UPDATE conversational_agent_test_runs
       SET status = 'cleaning', updated_at = ?
       WHERE id = ? AND requested_by_user_id = ? AND status IN ('active', 'expired', 'cleaning', 'cleanup_failed')`,
      [toIso(), runId, cleanString(requestedByUserId)]
    )
    if (mutationCount(closed) !== 1) {
      throw testError('La prueba cambió mientras se cerraba. Intenta limpiarla otra vez.', 409, 'test_run_cleanup_race')
    }

    try {
      const rows = await db.all('SELECT * FROM conversational_agent_test_effects WHERE run_id = ? ORDER BY created_at ASC', [runId])
      const cleanupFailures = []
      for (const row of rows) {
        const payload = parseJson(row.payload_json, {})
        try {
          if (row.effect_type === 'appointment' && payload.appointmentCreated === true && row.entity_id) {
            const result = await cleanupConversationalTestAppointment({
              appointmentId: row.entity_id,
              testEffectId: row.id,
              mutationLockHeld: true
            })
            if (!['cleaned'].includes(result?.status)) {
              throw testError('La cita temporal todavía está pendiente de borrarse en un calendario externo.', 503, 'test_appointment_cleanup_pending')
            }
          } else if (row.effect_type === 'payment' && payload.paymentCreated === true) {
            await cleanupConversationalAgentTestPaymentLink({
              effectId: row.id,
              requestedByUserId,
              force: true
            })
          } else if (row.effect_type === 'assignment') {
            const assignment = await db.get(
              'SELECT effect_id FROM conversational_agent_test_assignments WHERE effect_id = ?',
              [row.id]
            )
            if (assignment) {
              await cleanupConversationalAgentTestAssignment({
                effectId: row.id,
                requestedByUserId
              })
            }
          }

          await db.run(
            `UPDATE conversational_agent_test_effects
             SET cleanup_status = 'cleaned', cleanup_error = NULL, cleaned_at = CURRENT_TIMESTAMP,
                 status = 'cleaned', updated_at = ?
             WHERE id = ?`,
            [toIso(), row.id]
          )
        } catch (error) {
          cleanupFailures.push({ effectId: row.id, error })
          await db.run(
            `UPDATE conversational_agent_test_effects
             SET cleanup_status = 'failed', cleanup_error = ?, updated_at = ?
             WHERE id = ?`,
            [cleanString(error?.message || error).slice(0, 1200), toIso(), row.id]
          ).catch(() => undefined)
        }
      }
      if (cleanupFailures.length) {
        const error = testError(
          `No se pudieron limpiar ${cleanupFailures.length} efecto(s) de prueba. El sistema seguirá reintentando sin tocar datos reales.`,
          503,
          'test_run_cleanup_incomplete'
        )
        error.cleanupFailures = cleanupFailures
        throw error
      }
      await cleanupConversationalAppointmentPreviewOffers({
        previewScopeId: buildConversationalAppointmentPreviewScopeId({
          testSessionId: runId,
          requestedByUserId,
          agentId: lockedRun.agent_id
        }),
        agentId: lockedRun.agent_id
      })
      await db.run(
        `UPDATE conversational_agent_test_runs
         SET status = 'cleaned', cleaned_at = CURRENT_TIMESTAMP, updated_at = ?
         WHERE id = ? AND requested_by_user_id = ? AND status = 'cleaning'`,
        [toIso(), runId, cleanString(requestedByUserId)]
      )
    } catch (error) {
      await db.run(
        `UPDATE conversational_agent_test_runs
         SET status = 'cleanup_failed', updated_at = ?
         WHERE id = ? AND requested_by_user_id = ? AND status = 'cleaning'`,
        [toIso(), runId, cleanString(requestedByUserId)]
      ).catch(() => undefined)
      throw error
    }
    return {
      runId,
      cleaned: true,
      effects: await listConversationalAgentTestEffects({ testRunId: runId, requestedByUserId })
    }
  })
}

export const __conversationalAgentTestServiceTestHooks = Object.freeze({
  TEST_RUN_ID_PATTERN,
  TEST_MESSAGE_ID_PATTERN,
  publicEffect
})

export function setConversationalAgentTestServiceDependenciesForTests(overrides = null) {
  createAppointmentControllerImpl = overrides?.createAppointment || createAppointment
}
