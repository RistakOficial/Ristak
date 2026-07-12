import { createHash, randomUUID } from 'node:crypto'
import { db } from '../config/database.js'
import { createInternalNotification } from './notificationsService.js'
import { getLocalFreeSlots } from './localCalendarService.js'
import {
  getConversationalCapability,
  getConversationalTestMode
} from '../agents/conversational/nativeRuntimeConfig.js'
import { invokeController, toToolResult } from '../agents/invokeController.js'
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
import { getAccountTimezone, normalizeDateOnlyInTimezone } from '../utils/dateUtils.js'
import { getAccountCurrency } from '../utils/accountLocale.js'
import { logger } from '../utils/logger.js'

const TEST_RUN_ID_PATTERN = /^[A-Za-z0-9_-]{12,160}$/
const TEST_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{8,160}$/
const TEST_RUN_TTL_MS = 2 * 60 * 60 * 1000
// Debe exceder holgadamente los timeouts de las pasarelas/calendarios. El claim
// se toma dentro del candado distribuido, así que un retry no puede robarlo
// mientras el efecto externo legítimo sigue en vuelo.
const TEST_EFFECT_LEASE_MS = 10 * 60 * 1000
const TEST_NOTIFICATION_STALE_MS = 5 * 60 * 1000
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

function publicEffect(row = {}) {
  const payload = parseJson(row.payload_json, {})
  return {
    id: row.id,
    runId: row.run_id,
    messageId: row.message_id,
    type: row.effect_type,
    status: row.status,
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
  effects
} = {}) {
  const normalizedEffects = normalizeConversationalAgentTestEffects(effects)
  if (!normalizedEffects.enabled) return null

  const runId = normalizeIdentifier(testRunId, TEST_RUN_ID_PATTERN, 'La sesión de prueba')
  const messageId = normalizeIdentifier(testMessageId, TEST_MESSAGE_ID_PATTERN, 'El mensaje de prueba')
  const cleanAgentId = cleanString(agentId)
  const cleanUserId = cleanString(requestedByUserId)
  const cleanContactId = cleanString(contactId)
  if (!cleanAgentId || !cleanUserId || !cleanContactId) {
    throw testError('Selecciona un contacto de prueba antes de registrar citas o cobros.', 400, 'test_contact_required')
  }

  const [agent, contact] = await Promise.all([
    db.get('SELECT id, name, capabilities_config FROM conversational_agents WHERE id = ?', [cleanAgentId]),
    db.get('SELECT id, full_name, first_name, last_name, phone, email FROM contacts WHERE id = ? AND deleted_at IS NULL', [cleanContactId])
  ])
  if (!agent) throw testError('El agente de esta prueba ya no existe.', 404, 'test_agent_not_found')
  if (!contact) throw testError('El contacto de prueba ya no existe.', 404, 'test_contact_not_found')

  const persistedCapabilitiesConfig = parseJson(agent.capabilities_config, {})
  const persistedConfig = { capabilitiesConfig: persistedCapabilitiesConfig }
  const persistedTestMode = getConversationalTestMode(persistedConfig)
  if (!persistedTestMode.enabled) {
    throw testError('Activa y guarda Modo test antes de ejecutar acciones reales desde el tester.', 409, 'test_mode_not_enabled')
  }

  const scheduleCapability = getConversationalCapability(persistedConfig, 'schedule_appointment')
  const paymentCapability = getConversationalCapability(persistedConfig, 'collect_payment')
  const handoffCapability = getConversationalCapability(persistedConfig, 'handoff_human')
  if (normalizedEffects.scheduleAppointment && !scheduleCapability?.enabled) {
    throw testError('La capacidad de agenda ya no está activa. Guarda la configuración y reinicia la prueba.', 409, 'test_schedule_not_enabled')
  }
  if (normalizedEffects.collectPayment && !paymentCapability?.enabled) {
    throw testError('La capacidad de cobro ya no está activa. Guarda la configuración y reinicia la prueba.', 409, 'test_payment_not_enabled')
  }
  const assignmentUserId = cleanString(
    (scheduleCapability?.bookingOwner === 'human' ? scheduleCapability.handoffUserId : '') ||
    handoffCapability?.userId
  )
  if (normalizedEffects.assignUser && !assignmentUserId) {
    throw testError('Selecciona una persona responsable antes de probar la asignación.', 409, 'test_assignment_user_required')
  }

  const authoritativeEffects = {
    ...normalizedEffects,
    notifyOwner: persistedTestMode.notify !== false,
    configRevision: sha256(agent.capabilities_config || '{}')
  }

  const effectsJson = JSON.stringify(authoritativeEffects)
  const expiresAt = toIso(Date.now() + TEST_RUN_TTL_MS)
  await db.run(
    `INSERT INTO conversational_agent_test_runs (
       id, agent_id, requested_by_user_id, contact_id, effects_json, status,
       created_at, updated_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(id) DO NOTHING`,
    [runId, cleanAgentId, cleanUserId, cleanContactId, effectsJson, expiresAt]
  )

  const run = await db.get('SELECT * FROM conversational_agent_test_runs WHERE id = ?', [runId])
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
    `UPDATE conversational_agent_test_runs
     SET effects_json = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND requested_by_user_id = ? AND status = 'active'`,
    [effectsJson, expiresAt, runId, cleanUserId]
  )

  return {
    id: runId,
    messageId,
    agent,
    contact,
    effects: authoritativeEffects,
    requestedByUserId: cleanUserId,
    executionId: `test:${sha256(`${runId}\u0000${messageId}`).slice(0, 48)}`,
    expiresAt
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
  const testMode = getConversationalTestMode({ capabilitiesConfig })
  const revisionMatches = Boolean(storedEffects.configRevision) && storedEffects.configRevision === currentRevision
  if (!testMode.enabled || !revisionMatches) {
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
  const handoff = getConversationalCapability({ capabilitiesConfig }, 'handoff_human')
  if (cleanEffectType === 'appointment' && !schedule?.enabled) {
    throw testError('La capacidad de agenda ya no está activa.', 409, 'test_schedule_not_enabled')
  }
  if (cleanEffectType === 'payment' && !payment?.enabled) {
    throw testError('La capacidad de cobro ya no está activa.', 409, 'test_payment_not_enabled')
  }
  if (cleanEffectType === 'assignment') {
    const assignmentUserId = cleanString(
      (schedule?.bookingOwner === 'human' ? schedule.handoffUserId : '') || handoff?.userId
    )
    if (!assignmentUserId) {
      throw testError('La asignación de prueba ya no tiene una persona responsable.', 409, 'test_assignment_user_required')
    }
  }
  return capabilitiesConfig
}

export async function beginConversationalAgentTestEffect({
  testRunId,
  testMessageId,
  requestedByUserId,
  effectType,
  request
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
  if (effect.claim_token === claimToken) {
    return { claimed: true, reused: false, inProgress: false, claimToken, effect: publicEffect(effect), run, effects }
  }

  const leaseExpired = !effect.lease_until_at || Date.parse(effect.lease_until_at) <= Date.now()
  if (effect.status === 'processing' && !leaseExpired) {
    return { claimed: false, reused: false, inProgress: true, effect: publicEffect(effect), run, effects }
  }

  const claimed = await db.run(
    `UPDATE conversational_agent_test_effects
     SET status = 'processing', attempt_count = attempt_count + 1,
         claim_token = ?, lease_until_at = ?, last_error = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND request_hash = ?
       AND (status = 'failed' OR lease_until_at IS NULL OR lease_until_at <= ?)`,
    [claimToken, leaseUntilAt, effectId, requestHash, toIso()]
  )
  if (mutationCount(claimed) !== 1) {
    effect = await db.get('SELECT * FROM conversational_agent_test_effects WHERE id = ?', [effectId])
    return { claimed: false, reused: TERMINAL_TEST_EFFECT_STATUSES.has(effect?.status), inProgress: effect?.status === 'processing', effect: publicEffect(effect || {}), run, effects }
  }
  effect = await db.get('SELECT * FROM conversational_agent_test_effects WHERE id = ?', [effectId])
  return { claimed: true, reused: false, inProgress: false, claimToken, effect: publicEffect(effect), run, effects }
}

export async function completeConversationalAgentTestEffect({
  effectId,
  claimToken,
  status = 'recorded',
  entityId = null,
  payload = {}
} = {}) {
  const result = await db.run(
    `UPDATE conversational_agent_test_effects
     SET status = ?, entity_id = ?, payload_json = ?, claim_token = NULL,
         lease_until_at = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'processing' AND claim_token = ?`,
    [cleanString(status) || 'recorded', cleanString(entityId) || null, JSON.stringify(payload || {}), cleanString(effectId), cleanString(claimToken)]
  )
  if (mutationCount(result) !== 1) {
    const existing = await db.get('SELECT * FROM conversational_agent_test_effects WHERE id = ?', [cleanString(effectId)])
    if (existing && TERMINAL_TEST_EFFECT_STATUSES.has(existing.status)) return publicEffect(existing)
    throw testError('No se pudo cerrar de forma segura el efecto de prueba.', 409, 'test_effect_claim_lost')
  }
  const row = await db.get('SELECT * FROM conversational_agent_test_effects WHERE id = ?', [cleanString(effectId)])
  if (row?.effect_type !== 'assignment') {
    await dispatchConversationalAgentTestEffectNotification(row).catch((error) => {
      logger.warn(`[Tester agente] No se pudo notificar el efecto ${effectId}: ${error.message}`)
    })
  }
  return publicEffect(await db.get('SELECT * FROM conversational_agent_test_effects WHERE id = ?', [cleanString(effectId)]))
}

export async function failConversationalAgentTestEffect({ effectId, claimToken, error } = {}) {
  await db.run(
    `UPDATE conversational_agent_test_effects
     SET status = 'failed', claim_token = NULL, lease_until_at = NULL,
         last_error = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'processing' AND claim_token = ?`,
    [cleanString(error?.message || error).slice(0, 1200), cleanString(effectId), cleanString(claimToken)]
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

async function verifyTestAppointmentAction(action, scheduleCapability) {
  const calendarId = cleanString(action?.calendarId)
  const startTime = cleanString(action?.startTime)
  const start = new Date(startTime)
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
    ignoreAppointmentConflicts: false,
    appointmentLimit: 1
  })
  const stillFree = (Array.isArray(availability) ? availability : [])
    .flatMap((day) => Array.isArray(day?.slots) ? day.slots : [])
    .some((slot) => Math.abs(new Date(slot).getTime() - start.getTime()) < 60_000)
  if (!stillFree) {
    throw testError('Ese horario dejó de estar libre. No se registró la cita de prueba; vuelve a consultar espacios.', 409, 'test_slot_no_longer_free')
  }
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

async function verifyTestPaymentAction(action, paymentCapability) {
  const accountCurrency = cleanString(await getAccountCurrency()).toUpperCase()
  const currency = cleanString(action?.currency).toUpperCase()
  const amount = normalizeMoney(action?.amount, currency)
  const quantity = Number(action?.quantity || 1)
  if (
    !paymentCapability?.enabled ||
    !/^[A-Z]{3}$/.test(accountCurrency) ||
    currency !== accountCurrency ||
    !amount ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 100
  ) {
    throw testError('El monto o la moneda del cobro ya no coinciden con la configuración guardada.', 409, 'test_payment_authority_changed')
  }

  const usesDeposit = paymentCapability.paymentMode === 'deposit' || paymentCapability.deposit?.enabled === true
  if (usesDeposit) {
    const deposit = paymentCapability.deposit || {}
    const depositCurrency = cleanString(deposit.currency || accountCurrency).toUpperCase()
    const fixed = normalizeMoney(deposit.amount, accountCurrency)
    const min = normalizeMoney(deposit.minAmount, accountCurrency)
    const max = normalizeMoney(deposit.maxAmount, accountCurrency)
    const validAmount = deposit.mode === 'range'
      ? (!min || amount >= min) && (!max || amount <= max)
      : fixed > 0 && amount === fixed
    if (quantity !== 1 || depositCurrency !== accountCurrency || !validAmount) {
      throw testError('El anticipo de prueba ya no coincide con el monto blindado del agente.', 409, 'test_payment_authority_changed')
    }
    return {
      amount,
      currency,
      quantity: 1,
      concept: cleanString(action?.concept) || 'Anticipo',
      gateway: cleanString(paymentCapability.gateway).toLowerCase(),
      installments: paymentCapability.installments || { enabled: false, maxInstallments: 0 }
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
      amount !== expectedAmount ||
      !expectedConcept ||
      cleanString(action?.catalogEvidence?.source) !== 'capability_direct'
    ) {
      throw testError('El cobro directo ya no coincide con el monto y concepto blindados del agente.', 409, 'test_payment_authority_changed')
    }
    return {
      amount,
      currency,
      quantity: 1,
      unitAmount: amount,
      concept: expectedConcept,
      description: cleanString(direct.description),
      gateway: cleanString(paymentCapability.gateway).toLowerCase(),
      installments: paymentCapability.installments || { enabled: false, maxInstallments: 0 }
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
    amount !== expectedAmount ||
    actionProductId !== cleanString(row.product_id) ||
    actionPriceId !== cleanString(row.price_id)
  ) {
    throw testError('El producto, precio o monto del cobro cambió. Vuelve a enviar el mensaje para probar el valor vigente.', 409, 'test_payment_authority_changed')
  }
  return {
    amount,
    currency,
    quantity,
    unitAmount,
    concept: cleanString(action?.concept) || 'Pago',
    gateway: cleanString(paymentCapability.gateway).toLowerCase(),
    installments: paymentCapability.installments || { enabled: false, maxInstallments: 0 }
  }
}

function actionForEffect(actions, effectType) {
  const acceptedTypes = effectType === 'appointment'
    ? new Set(['book_appointment', 'request_human_booking'])
    : effectType === 'payment'
      ? new Set(['create_payment_link'])
      : new Set(['request_human_booking', 'send_to_human', 'mark_ready_to_advance'])
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

  const scheduleForAssignment = getConversationalCapability({ capabilitiesConfig }, 'schedule_appointment')
  const handoffForAssignment = getConversationalCapability({ capabilitiesConfig }, 'handoff_human')
  const assignmentTargetUserId = cleanString(action.type) === 'request_human_booking'
    ? cleanString(scheduleForAssignment?.handoffUserId)
    : cleanString(handoffForAssignment?.userId)
  const assignmentTargetUserName = cleanString(action.type) === 'request_human_booking'
    ? cleanString(scheduleForAssignment?.handoffUserName)
    : cleanString(handoffForAssignment?.userName)

  const request = effectType === 'appointment'
    ? {
        calendarId: cleanString(action.calendarId),
        startTime: cleanString(action.startTime),
        endTime: cleanString(action.endTime),
        title: cleanString(action.title),
        bookingOwner: cleanString(action.type) === 'request_human_booking' ? 'human' : 'ai',
        participants: Array.isArray(action.participants) ? action.participants : []
      }
    : effectType === 'payment'
      ? {
        amount: Number(action.amount),
        unitAmount: Number(action.unitAmount),
        quantity: Number(action.quantity || 1),
        currency: cleanString(action.currency).toUpperCase(),
        concept: cleanString(action.concept),
        productId: cleanString(action.catalogEvidence?.productId),
        priceId: cleanString(action.catalogEvidence?.priceId)
      }
      : {
          actionType: cleanString(action.type),
          targetUserId: assignmentTargetUserId,
          targetUserName: assignmentTargetUserName,
          reason: cleanString(action.motivo || action.reason || 'Transferencia confirmada en el tester'),
          startTime: cleanString(action.startTime)
        }

  return withConversationalAgentTestMutationLock({
    agentId: runContext.agent.id,
    purpose: `test_effect:${runContext.id}:${effectType}`
  }, async () => {
    const claim = await beginConversationalAgentTestEffect({
      testRunId: runContext.id,
      testMessageId: runContext.messageId,
      requestedByUserId: runContext.requestedByUserId,
      effectType,
      request
    })
    if (!claim.claimed) {
      if (claim.reused && claim.effect?.id) {
        if (claim.effect.type !== 'assignment') {
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
        await verifyTestAppointmentAction(action, schedule)
        const humanBooking = action.type === 'request_human_booking'
        if (humanBooking) {
          return await completeConversationalAgentTestEffect({
            effectId: claim.effect.id,
            claimToken: claim.claimToken,
            status: 'recorded',
            entityId: null,
            payload: {
              ...request,
              contactId: runContext.contact.id,
              contactName: runContext.contact.full_name || runContext.contact.first_name || 'Contacto de prueba',
              safeTestRecord: true,
              appointmentCreated: false,
              summary: 'El horario real sigue libre. La solicitud se entregará a la persona configurada en una prueba temporal de asignación.'
            }
          })
        }

        const testExpiresAt = toIso(Date.now() + 5 * 60 * 1000)
        await assertCurrentTestRunAuthority(claim.run, 'appointment')
        const controllerResult = toToolResult(await invokeController(createAppointmentControllerImpl, {
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
        }))
        if (!controllerResult.ok || !controllerResult.data?.id) {
          throw testError(
            controllerResult.error || 'El calendario no confirmó la cita temporal.',
            Number(controllerResult.statusCode) || 502,
            'test_appointment_creation_failed'
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
        return await completeConversationalAgentTestEffect({
          effectId: claim.effect.id,
          claimToken: claim.claimToken,
          status: 'recorded',
          entityId: appointment.id,
          payload: {
            ...request,
            contactId: runContext.contact.id,
            contactName: runContext.contact.full_name || runContext.contact.first_name || 'Contacto de prueba',
            safeTestRecord: true,
            appointmentCreated: true,
            appointmentId: appointment.id,
            testExpiresAt,
            cleanupDueAt: testExpiresAt,
            automationExecution,
            automationPreview: automationExecution,
            summary: `Cita de prueba creada de verdad. Se enviaron las notificaciones seguras${automationRealActionCount ? ` y ${automationRealActionCount} acción(es) real(es) aislada(s)` : ''}${reminderNotificationCount ? `, incluyendo ${reminderNotificationCount} recordatorio(s) al dueño de la prueba` : ''}${uniqueAutomationNames.length ? `; se recorrieron ${uniqueAutomationNames.length} automatización(es)` : ''}${automationSimulatedActionCount ? ` y ${automationSimulatedActionCount} efecto(s) irreversible(s) quedaron simulados` : ''}. La cita se eliminará automáticamente después de cinco minutos.`
          }
        })
      }

      capabilitiesConfig = await assertCurrentTestRunAuthority(claim.run, 'payment')
      const payment = getConversationalCapability({ capabilitiesConfig }, 'collect_payment')
      const verifiedPayment = await verifyTestPaymentAction(action, payment)
      await assertCurrentTestRunAuthority(claim.run, 'payment')
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
      await failConversationalAgentTestEffect({
        effectId: claim.effect.id,
        claimToken: claim.claimToken,
        error
      })
      throw error
    }
  })
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
      results.push({
        type: effectType,
        status: 'failed',
        summary: error.message || 'No se pudo registrar esta acción de prueba.'
      })
    }
  }
  return results
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
  const title = isAppointment
    ? (payload.appointmentCreated
        ? 'Modo test · cita temporal creada'
        : 'Modo test · horario entregado a una persona')
    : isPayment
      ? 'Modo test · enlace sandbox creado'
      : 'Modo test · contacto asignado temporalmente'
  const message = isAppointment
    ? `${payload.startTime || 'Horario validado'} · ${payload.contactName || 'Contacto de prueba'} · se limpia en 5 minutos`
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
      facts.push(`- El pago sandbox por ${payload.amount || ''} ${payload.currency || ''} fue confirmado por webhook. Trátalo como confirmado sólo dentro de esta prueba y continúa con el siguiente objetivo configurado.`)
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
          } else if (row.effect_type === 'payment') {
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
