import crypto from 'crypto'
import { db } from '../config/database.js'

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/
const CONVERSATIONAL_V2_SLOT_KEY_PREFIX = 'conv-v2-slot:'
const CONVERSATIONAL_V2_APPOINTMENT_KEY_PREFIX = 'conv-v2-appointment:'
const CONVERSATIONAL_V2_ATTEMPT_KEY_PREFIX = 'conv-v2-attempt:'
const CONVERSATIONAL_TEST_KEY_PREFIX = 'conv-test:'
export const TEST_APPOINTMENT_PROVIDER_SYNC_FAILURE_KIND = 'test_provider_sync_failed'
export const TEST_APPOINTMENT_CHECKPOINT_INTERRUPTED_FAILURE_KIND = 'test_checkpoint_interrupted'
const APPOINTMENT_CREATION_PROCESSING_LEASE_MS = 2 * 60 * 1000
const RETRYABLE_APPOINTMENT_CREATION_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
const RETRYABLE_APPOINTMENT_CREATION_NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT'
])
const OMITTED_HASH_KEYS = new Set([
  'accessToken',
  'access_token',
  'clientRequestId',
  'client_request_id'
])

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value).sort().reduce((result, key) => {
    if (!OMITTED_HASH_KEYS.has(key)) result[key] = stableValue(value[key])
    return result
  }, {})
}

function requestHash(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(payload || {})))
    .digest('hex')
}

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : undefined
  } catch {
    return undefined
  }
}

function createHttpError(message, status) {
  const error = new Error(message)
  error.status = status
  return error
}

export function markTestAppointmentProviderSyncFailure(error, {
  provider = 'external',
  appointmentId = null
} = {}) {
  const cleanProvider = String(provider || 'external').trim().toLowerCase() || 'external'
  const failure = error instanceof Error
    ? error
    : new Error(String(error || 'El calendario externo no confirmó el espejo de la cita de prueba.'))
  const status = normalizeErrorStatus(failure)
  if (!failure.status && !failure.statusCode) failure.status = status === 500 ? 502 : status
  if (!failure.code) failure.code = `test_appointment_${cleanProvider}_mirror_failed`
  failure.appointmentCreationFailureKind = TEST_APPOINTMENT_PROVIDER_SYNC_FAILURE_KIND
  failure.data = {
    ...(failure.data && typeof failure.data === 'object' && !Array.isArray(failure.data) ? failure.data : {}),
    providerSync: {
      provider: cleanProvider,
      status: 'failed',
      appointmentId: String(appointmentId || '').trim() || null
    }
  }
  return failure
}

function normalizeErrorStatus(error) {
  const status = Number(error?.status || error?.statusCode || 500)
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500
}

function isRetryableAppointmentCreationFailure(error) {
  const explicitStatus = Number(error?.status ?? error?.statusCode)
  if (Number.isInteger(explicitStatus) && RETRYABLE_APPOINTMENT_CREATION_STATUSES.has(explicitStatus)) {
    return true
  }
  const networkCode = String(error?.code || error?.cause?.code || '').trim().toUpperCase()
  return RETRYABLE_APPOINTMENT_CREATION_NETWORK_CODES.has(networkCode)
}

export function normalizeAppointmentClientRequestId(value) {
  const key = String(value || '').trim()
  if (!CLIENT_REQUEST_ID_PATTERN.test(key)) {
    throw createHttpError(
      'La llave de seguridad de la cita no es válida. Cierra este formulario y vuelve a intentarlo.',
      400
    )
  }
  return key
}

function replayAppointmentCreation(row, expectedHash) {
  if (row.request_hash !== expectedHash) {
    throw createHttpError(
      'La llave de seguridad ya se usó con datos distintos. Abre una cita nueva antes de volver a intentar.',
      409
    )
  }

  if (row.status === 'completed') {
    const response = parseJson(row.response_json)
    if (response !== undefined) return response
    throw createHttpError(
      'La cita ya se creó, pero su respuesta guardada no se pudo leer. Revisa el calendario antes de intentar otra vez.',
      500
    )
  }

  if (row.status === 'failed') {
    const error = createHttpError(
      row.error_message || 'Este intento quedó bloqueado para evitar una cita duplicada. Revisa el calendario antes de iniciar otra.',
      Number(row.error_status || 409)
    )
    if (row.failure_kind === TEST_APPOINTMENT_PROVIDER_SYNC_FAILURE_KIND) {
      error.code = 'test_appointment_provider_sync_failed'
    } else if (row.failure_kind === TEST_APPOINTMENT_CHECKPOINT_INTERRUPTED_FAILURE_KIND) {
      error.code = 'test_appointment_checkpoint_interrupted'
    }
    throw error
  }

  throw createHttpError(
    'Esta cita ya está en proceso. Espera un momento y actualiza el calendario antes de volver a intentar.',
    409
  )
}

async function reserveAppointmentCreation(clientRequestId, hash, processingToken, nowIso) {
  try {
    const result = await db.run(
      `INSERT INTO appointment_creation_requests (
        client_request_id, request_hash, status, processing_token, created_at, updated_at
      ) VALUES (?, ?, 'processing', ?, ?, ?)
      ON CONFLICT(client_request_id) DO NOTHING`,
      [clientRequestId, hash, processingToken, nowIso, nowIso]
    )

    if (Number(result?.changes || 0) === 1) {
      return { created: true }
    }
  } catch (error) {
    const raced = await db.get(
      'SELECT * FROM appointment_creation_requests WHERE client_request_id = ?',
      [clientRequestId]
    ).catch(() => null)
    if (!raced) throw error
    return { created: false, row: raced }
  }

  const existing = await db.get(
    'SELECT * FROM appointment_creation_requests WHERE client_request_id = ?',
    [clientRequestId]
  )
  if (!existing) {
    throw createHttpError('No se pudo confirmar la reserva segura de la cita. Intenta de nuevo.', 503)
  }
  return { created: false, row: existing }
}

function appointmentNoLongerOccupiesSlot(appointment) {
  if (!appointment) return true
  if (appointment.deleted_at) return true
  const status = String(appointment.appointment_status || appointment.status || '').trim().toLowerCase()
  return ['cancelled', 'canceled', 'deleted'].includes(status)
}

function isConversationalV2Request(clientRequestId) {
  return [
    CONVERSATIONAL_V2_SLOT_KEY_PREFIX,
    CONVERSATIONAL_V2_APPOINTMENT_KEY_PREFIX,
    CONVERSATIONAL_V2_ATTEMPT_KEY_PREFIX
  ].some((prefix) => clientRequestId.startsWith(prefix))
}

function isRecoverableConversationalRequest(clientRequestId) {
  return isConversationalV2Request(clientRequestId) ||
    clientRequestId.startsWith(CONVERSATIONAL_TEST_KEY_PREFIX)
}

function isConversationalTestRequest(clientRequestId) {
  return clientRequestId.startsWith(CONVERSATIONAL_TEST_KEY_PREFIX)
}

function testEffectIdFromClientRequestId(clientRequestId) {
  if (!isConversationalTestRequest(clientRequestId)) return ''
  return clientRequestId.slice(CONVERSATIONAL_TEST_KEY_PREFIX.length).trim()
}

function isLegacyConversationalSlotRequest(clientRequestId) {
  return clientRequestId.startsWith(CONVERSATIONAL_V2_SLOT_KEY_PREFIX)
}

function normalizeComparableInstant(value) {
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}

function sameAppointmentResource(appointment, payload = {}) {
  if (!appointment) return false
  const expectedCalendarId = String(payload.calendarId || payload.calendar_id || '').trim()
  const actualCalendarId = String(appointment.calendar_id || appointment.calendarId || '').trim()
  const expectedStart = normalizeComparableInstant(payload.startTime || payload.start_time)
  const actualStart = normalizeComparableInstant(appointment.start_time || appointment.startTime)
  const expectedEnd = normalizeComparableInstant(payload.endTime || payload.end_time)
  const actualEnd = normalizeComparableInstant(appointment.end_time || appointment.endTime)
  return Boolean(expectedCalendarId) && actualCalendarId === expectedCalendarId &&
    expectedStart !== null && actualStart === expectedStart &&
    expectedEnd !== null && actualEnd === expectedEnd
}

function appointmentReplayState(appointment, payload = {}) {
  if (!appointment || appointment.deleted_at) return 'appointment_deleted'
  const status = String(appointment.appointment_status || appointment.status || '').trim().toLowerCase()
  if (['cancelled', 'canceled', 'deleted'].includes(status)) return 'appointment_cancelled'
  if (!sameAppointmentResource(appointment, payload)) return 'appointment_rescheduled'
  return 'appointment_current'
}

function canonicalAppointmentResponse(row, appointment, state) {
  const stored = parseJson(row?.response_json)
  const response = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {}
  const status = String(appointment?.appointment_status || appointment?.status || '').trim() || 'confirmed'
  const canonical = {
    id: appointment?.id || row?.appointment_id || null,
    calendarId: appointment?.calendar_id || null,
    contactId: appointment?.contact_id || null,
    title: appointment?.title || response.title || 'Cita',
    status,
    appointmentStatus: status,
    startTime: appointment?.start_time || null,
    endTime: appointment?.end_time || appointment?.start_time || null,
    isTest: Number(appointment?.is_test || 0) === 1,
    testRunId: appointment?.test_run_id || null,
    testEffectId: appointment?.test_effect_id || null,
    testExpiresAt: appointment?.test_expires_at || null
  }
  const next = response.appointment && typeof response.appointment === 'object'
    ? { ...response, appointment: { ...response.appointment, ...canonical } }
    : { ...response, ...canonical }
  return {
    ...next,
    idempotencyReplay: {
      replayed: true,
      canonicalChanged: state !== 'appointment_current',
      state
    }
  }
}

function parseDatabaseInstant(value) {
  const clean = String(value || '').trim()
  if (!clean) return null
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(clean)
    ? `${clean.replace(' ', 'T')}Z`
    : clean
  const timestamp = new Date(normalized).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}

function processingLeaseExpired(row, nowIso) {
  const updatedAt = parseDatabaseInstant(row?.updated_at || row?.created_at)
  const now = normalizeComparableInstant(nowIso)
  return updatedAt === null || now === null || now - updatedAt >= APPOINTMENT_CREATION_PROCESSING_LEASE_MS
}

export async function inspectAppointmentCreationRequestRecoveryState(clientRequestId, {
  nowIso = new Date().toISOString()
} = {}) {
  const cleanKey = normalizeAppointmentClientRequestId(clientRequestId)
  const row = await db.get(
    `SELECT client_request_id, status, appointment_id, failure_kind, created_at, updated_at
     FROM appointment_creation_requests WHERE client_request_id = ?`,
    [cleanKey]
  )
  if (!row) {
    return {
      exists: false,
      status: 'missing',
      appointmentId: null,
      failureKind: null,
      processingLeaseExpired: true
    }
  }
  return {
    exists: true,
    status: String(row.status || '').trim(),
    appointmentId: String(row.appointment_id || '').trim() || null,
    failureKind: String(row.failure_kind || '').trim() || null,
    processingLeaseExpired: row.status === 'processing'
      ? processingLeaseExpired(row, nowIso)
      : true
  }
}

async function loadCreationRequestForUpdate(clientRequestId) {
  const lockSuffix = process.env.DATABASE_URL ? ' FOR UPDATE' : ''
  return db.get(
    `SELECT * FROM appointment_creation_requests WHERE client_request_id = ?${lockSuffix}`,
    [clientRequestId]
  )
}

async function loadCanonicalAppointment(appointmentId) {
  if (!appointmentId) return null
  return db.get(
    `SELECT id, calendar_id, contact_id, title, appointment_status, status,
            start_time, end_time, deleted_at, is_test, test_run_id,
            test_effect_id, test_expires_at, ghl_appointment_id,
            sync_status, sync_error, google_event_id,
            google_sync_status, google_sync_error
     FROM appointments
     WHERE id = ?`,
    [appointmentId]
  )
}

async function preserveInterruptedTestCheckpoint({ row, appointment, nowIso }) {
  const update = await db.run(
    `UPDATE appointment_creation_requests
     SET status = 'failed', processing_token = NULL, appointment_id = ?, error_status = 503,
         error_retryable = 0, failure_kind = ?, error_message = ?, updated_at = ?
     WHERE client_request_id = ? AND request_hash = ?
       AND status = 'processing' AND (appointment_id IS NULL OR appointment_id = ?)`,
    [
      appointment.id,
      TEST_APPOINTMENT_CHECKPOINT_INTERRUPTED_FAILURE_KIND,
      'La cita de prueba quedó guardada, pero la ejecución se interrumpió antes de confirmar todos sus efectos. No se creó otra cita; reinicia la prueba.',
      nowIso,
      row.client_request_id,
      row.request_hash,
      appointment.id
    ]
  )
  if (Number(update?.changes || 0) === 1) return loadCreationRequestForUpdate(row.client_request_id)
  return loadCreationRequestForUpdate(row.client_request_id)
}

function appointmentMatchesRequestIdentity(appointment, clientRequestId) {
  if (!appointment) return false
  if (isConversationalTestRequest(clientRequestId)) {
    const effectId = testEffectIdFromClientRequestId(clientRequestId)
    return Boolean(effectId) && Number(appointment.is_test || 0) === 1 &&
      String(appointment.test_effect_id || '').trim() === effectId
  }
  return Number(appointment.is_test || 0) !== 1
}

async function findTestAppointmentByRequestIdentity(clientRequestId) {
  const testEffectId = testEffectIdFromClientRequestId(clientRequestId)
  if (!testEffectId) return null
  const appointment = await db.get(
    `SELECT id, calendar_id, contact_id, title, appointment_status, status,
            start_time, end_time, deleted_at, is_test, test_run_id,
            test_effect_id, test_expires_at
     FROM appointments
     WHERE is_test = 1 AND test_effect_id = ?
     ORDER BY COALESCE(date_updated, date_added, start_time) DESC
     LIMIT 1`,
    [testEffectId]
  )
  return appointmentMatchesRequestIdentity(appointment, clientRequestId) ? appointment : null
}

async function resetCreationRequestToProcessing({ row, hash, processingToken, nowIso }) {
  const update = await db.run(
    `UPDATE appointment_creation_requests
     SET request_hash = ?, status = 'processing', processing_token = ?, appointment_id = NULL,
         response_json = NULL, error_status = NULL, error_retryable = 0,
         failure_kind = NULL, error_message = NULL, updated_at = ?
     WHERE client_request_id = ? AND request_hash = ? AND status = ?`,
    [hash, processingToken, nowIso, row.client_request_id, row.request_hash, row.status]
  )
  if (Number(update?.changes || 0) === 1) return { created: true }
  const raced = await loadCreationRequestForUpdate(row.client_request_id)
  if (!raced) throw createHttpError('No se pudo confirmar la nueva reserva segura del horario. Intenta de nuevo.', 503)
  return { created: false, row: raced }
}

/**
 * Reconcilia las llaves conversacionales con la cita canónica. Incluye las
 * citas temporales del tester porque su retry acotado usa exactamente la misma
 * llave `conv-test:`. Sólo reabre fallos transitorios clasificados y guardados
 * explícitamente; un 400/409 permanece definitivo. Las llaves nuevas representan un intento
 * (mensaje+contacto+slot); el candado físico vive en el calendario. Las llaves
 * conv-v2-slot antiguas aún se reciclan para no dejar horarios atrapados durante
 * la migración.
 */
async function reconcileConversationalAppointmentRequest({
  clientRequestId,
  hash,
  payload,
  processingToken,
  nowIso
}) {
  if (!isRecoverableConversationalRequest(clientRequestId)) return null

  return db.transaction(async () => {
    const row = await loadCreationRequestForUpdate(clientRequestId)
    if (!row) throw createHttpError('No se pudo confirmar la reserva segura de la cita. Intenta de nuevo.', 503)

    if (row.status === 'failed') {
      if (row.request_hash !== hash && !isLegacyConversationalSlotRequest(clientRequestId)) {
        return { created: false, row }
      }
      const checkpointCandidate = await loadCanonicalAppointment(row.appointment_id)
      const checkpointedAppointment = appointmentMatchesRequestIdentity(checkpointCandidate, clientRequestId)
        ? checkpointCandidate
        : (isConversationalTestRequest(clientRequestId) && row.request_hash === hash
            ? await findTestAppointmentByRequestIdentity(clientRequestId)
            : null)
      // Un intento test que ya falló y dejó cita local nunca se convierte a
      // éxito por reconciliación. Sólo `create()` puede cerrar completed tras
      // terminar providers, automatizaciones y validaciones del tester.
      if (checkpointedAppointment?.id && isConversationalTestRequest(clientRequestId)) {
        return { created: false, row }
      }
      if (checkpointedAppointment?.id) {
        const state = appointmentReplayState(checkpointedAppointment, payload)
        const response = canonicalAppointmentResponse(row, checkpointedAppointment, state)
        const completed = await db.run(
          `UPDATE appointment_creation_requests
           SET status = 'completed', processing_token = NULL, response_json = ?,
               error_status = NULL, error_retryable = 0, failure_kind = NULL,
               error_message = NULL, updated_at = ?
           WHERE client_request_id = ? AND request_hash = ? AND status = 'failed'
             AND appointment_id = ?`,
          [JSON.stringify(response), nowIso, clientRequestId, row.request_hash, checkpointedAppointment.id]
        )
        if (Number(completed?.changes || 0) === 1) return { replay: response }
        const raced = await loadCreationRequestForUpdate(clientRequestId)
        return { created: false, row: raced }
      }
      if (Number(row.error_retryable || 0) !== 1) return { created: false, row }
      return resetCreationRequestToProcessing({ row, hash, processingToken, nowIso })
    }

    if (row.status === 'processing') {
      if (!processingLeaseExpired(row, nowIso)) return { created: false, row }
      if (row.request_hash !== hash && !isLegacyConversationalSlotRequest(clientRequestId)) {
        return { created: false, row }
      }

      const checkpointCandidate = await loadCanonicalAppointment(row.appointment_id)
      const checkpointedAppointment = appointmentMatchesRequestIdentity(checkpointCandidate, clientRequestId)
        ? checkpointCandidate
        : null
      const recoveredAppointment = checkpointedAppointment
        || (
          isConversationalTestRequest(clientRequestId) && row.request_hash === hash
            ? await findTestAppointmentByRequestIdentity(clientRequestId)
            : null
        )
      if (recoveredAppointment) {
        // Para conv-test, un checkpoint processing vencido prueba que el
        // proceso murió antes de guardar la respuesta final. Adoptar la cita
        // como completed inventaría éxito aunque el crash ocurriera antes del
        // primer mirror o después de un fallo del provider. Se conserva la cita
        // para cleanup, se bloquea cualquier duplicado y se exige nueva prueba.
        if (isConversationalTestRequest(clientRequestId)) {
          const failedRow = await preserveInterruptedTestCheckpoint({
            row,
            appointment: recoveredAppointment,
            nowIso
          })
          return { created: false, row: failedRow || row }
        }
        const state = appointmentReplayState(recoveredAppointment, payload)
        const response = canonicalAppointmentResponse(row, recoveredAppointment, state)
        const completed = await db.run(
          `UPDATE appointment_creation_requests
           SET status = 'completed', processing_token = NULL, appointment_id = ?, response_json = ?,
               error_status = NULL, error_retryable = 0, failure_kind = NULL,
               error_message = NULL, updated_at = ?
           WHERE client_request_id = ? AND status = 'processing'`,
          [recoveredAppointment.id, JSON.stringify(response), nowIso, clientRequestId]
        )
        if (Number(completed?.changes || 0) === 1) return { replay: response }
        const raced = await loadCreationRequestForUpdate(clientRequestId)
        return { created: false, row: raced }
      }

      return resetCreationRequestToProcessing({ row, hash, processingToken, nowIso })
    }

    if (row.status !== 'completed' || !row.appointment_id) return { created: false, row }

    const appointment = await loadCanonicalAppointment(row.appointment_id)
    if (!appointmentMatchesRequestIdentity(appointment, clientRequestId)) {
      throw createHttpError(
        'La comprobación guardada no pertenece a la identidad exacta de esta cita. Reinicia la prueba antes de continuar.',
        409
      )
    }
    const state = appointmentReplayState(appointment, payload)
    const released = appointmentNoLongerOccupiesSlot(appointment)
    const moved = state === 'appointment_rescheduled'

    if (row.request_hash === hash && (moved || (!isLegacyConversationalSlotRequest(clientRequestId) && released))) {
      return { replay: canonicalAppointmentResponse(row, appointment, state) }
    }

    if (isLegacyConversationalSlotRequest(clientRequestId) && (released || moved)) {
      return resetCreationRequestToProcessing({ row, hash, processingToken, nowIso })
    }

    return { created: false, row }
  })
}

/**
 * Lectura rápida para que la tool pueda reconocer un retry exacto antes de
 * volver a validar el slot antiguo. Sólo devuelve algo cuando la cita canónica
 * cambió; nunca reserva, recicla ni crea datos.
 */
export async function inspectChangedAppointmentCreationReplay({ clientRequestId, payload }) {
  const suppliedKey = String(clientRequestId || '').trim()
  if (!suppliedKey || !isConversationalV2Request(suppliedKey)) return null
  const cleanKey = normalizeAppointmentClientRequestId(suppliedKey)
  const hash = requestHash(payload)
  const row = await db.get(
    'SELECT * FROM appointment_creation_requests WHERE client_request_id = ?',
    [cleanKey]
  )
  if (!row || row.status !== 'completed' || row.request_hash !== hash || !row.appointment_id) return null
  const appointment = await loadCanonicalAppointment(row.appointment_id)
  const state = appointmentReplayState(appointment, payload)
  return state === 'appointment_current' ? null : canonicalAppointmentResponse(row, appointment, state)
}

/**
 * Ejecuta una creación de cita una sola vez por intento del cliente.
 *
 * La reserva se decide por una PK durable antes de crear la cita local o hablar
 * con calendarios externos. Los clientes legacy sin clientRequestId conservan
 * temporalmente el contrato anterior.
 */
export async function runIdempotentAppointmentCreation({ clientRequestId, payload, create }) {
  const suppliedKey = String(clientRequestId || '').trim()
  if (!suppliedKey) return create()

  const cleanKey = normalizeAppointmentClientRequestId(suppliedKey)
  const hash = requestHash(payload)
  const processingToken = crypto.randomUUID()
  const nowIso = new Date().toISOString()
  let reservation = await reserveAppointmentCreation(cleanKey, hash, processingToken, nowIso)

  if (!reservation.created) {
    const reconciled = await reconcileConversationalAppointmentRequest({
      clientRequestId: cleanKey,
      hash,
      payload,
      processingToken,
      nowIso
    })
    if (reconciled?.replay !== undefined) return reconciled.replay
    if (reconciled) reservation = reconciled
  }

  if (!reservation.created) return replayAppointmentCreation(reservation.row, hash)

  try {
    const result = await create()
    const appointmentId = String(result?.id || result?.appointment?.id || '').trim()
    const completedAt = new Date().toISOString()
    const completed = await db.run(
      `UPDATE appointment_creation_requests
       SET status = 'completed', processing_token = NULL, appointment_id = ?, response_json = ?,
           failure_kind = NULL, updated_at = ?
       WHERE client_request_id = ? AND request_hash = ? AND status = 'processing' AND processing_token = ?`,
      [appointmentId || null, JSON.stringify(result ?? null), completedAt, cleanKey, hash, processingToken]
    )
    if (Number(completed?.changes || 0) !== 1) {
      return db.transaction(async () => {
        const row = await loadCreationRequestForUpdate(cleanKey)
        if (!row) {
          throw createHttpError('La cita se creó, pero no se pudo guardar su comprobación idempotente. Revisa el calendario antes de intentar otra.', 500)
        }
        if (row.status === 'completed') {
          return row.request_hash === hash ? replayAppointmentCreation(row, hash) : result
        }

        // La cita real es la fuente de verdad. Si una lease venció mientras la
        // creación original seguía viva, el primer resultado real recupera el
        // checkpoint y el segundo intento chocará contra disponibilidad.
        const recovered = await db.run(
          `UPDATE appointment_creation_requests
           SET request_hash = ?, status = 'completed', processing_token = NULL,
               appointment_id = ?, response_json = ?, error_status = NULL, error_retryable = 0,
               failure_kind = NULL, error_message = NULL,
               updated_at = ?
           WHERE client_request_id = ? AND status IN ('processing', 'failed')`,
          [hash, appointmentId || null, JSON.stringify(result ?? null), completedAt, cleanKey]
        )
        if (Number(recovered?.changes || 0) !== 1) {
          const raced = await loadCreationRequestForUpdate(cleanKey)
          if (raced?.status === 'completed') {
            return raced.request_hash === hash ? replayAppointmentCreation(raced, hash) : result
          }
          throw createHttpError('La cita se creó, pero no se pudo confirmar su registro seguro. Revisa el calendario antes de intentar otra.', 500)
        }
        return result
      })
    }
    return result
  } catch (error) {
    // El controller puede haber confirmado ya la cita local y guardado su ID
    // antes de que falle un espejo, automatización o efecto posterior. En ese
    // caso la cita local manda: cerramos la idempotencia con esa misma cita en
    // vez de convertir el intento en fallido y arriesgar una segunda alta.
    const checkpoint = await db.get(
      `SELECT * FROM appointment_creation_requests
       WHERE client_request_id = ? AND request_hash = ?
         AND status = 'processing' AND processing_token = ?`,
      [cleanKey, hash, processingToken]
    ).catch(() => null)
    const checkpointedAppointment = checkpoint?.appointment_id
      ? await loadCanonicalAppointment(checkpoint.appointment_id).catch(() => null)
      : null
    const failureKind = (
      checkpointedAppointment?.id &&
      appointmentMatchesRequestIdentity(checkpointedAppointment, cleanKey) &&
      error?.appointmentCreationFailureKind === TEST_APPOINTMENT_PROVIDER_SYNC_FAILURE_KIND
    )
      ? TEST_APPOINTMENT_PROVIDER_SYNC_FAILURE_KIND
      : null
    if (
      checkpointedAppointment?.id &&
      appointmentMatchesRequestIdentity(checkpointedAppointment, cleanKey) &&
      !failureKind
    ) {
      const state = appointmentReplayState(checkpointedAppointment, payload)
      const response = canonicalAppointmentResponse(checkpoint, checkpointedAppointment, state)
      const completedAt = new Date().toISOString()
      const recovered = await db.run(
        `UPDATE appointment_creation_requests
         SET status = 'completed', processing_token = NULL,
             response_json = ?, error_status = NULL, error_retryable = 0,
             failure_kind = NULL, error_message = NULL,
             updated_at = ?
         WHERE client_request_id = ? AND request_hash = ?
           AND status = 'processing' AND processing_token = ? AND appointment_id = ?`,
        [
          JSON.stringify(response),
          completedAt,
          cleanKey,
          hash,
          processingToken,
          checkpointedAppointment.id
        ]
      ).catch(() => null)
      if (Number(recovered?.changes || 0) === 1) return response
      const raced = await db.get(
        'SELECT * FROM appointment_creation_requests WHERE client_request_id = ?',
        [cleanKey]
      ).catch(() => null)
      if (raced?.status === 'completed' && raced.request_hash === hash) {
        return replayAppointmentCreation(raced, hash)
      }
    }

    const errorStatus = normalizeErrorStatus(error)
    const errorRetryable = failureKind ? false : isRetryableAppointmentCreationFailure(error)
    if (error && typeof error === 'object') error.status = errorStatus
    const failed = await db.run(
      `UPDATE appointment_creation_requests
       SET status = 'failed', processing_token = NULL, error_status = ?, error_retryable = ?,
           failure_kind = ?, error_message = ?, updated_at = ?
       WHERE client_request_id = ? AND request_hash = ? AND status = 'processing' AND processing_token = ?`,
      [
        errorStatus,
        errorRetryable ? 1 : 0,
        failureKind,
        String(error?.message || 'No se pudo completar la creación de la cita.'),
        new Date().toISOString(),
        cleanKey,
        hash,
        processingToken
      ]
    ).catch(() => {})
    if (Number(failed?.changes || 0) !== 1) {
      const current = await db.get(
        'SELECT * FROM appointment_creation_requests WHERE client_request_id = ?',
        [cleanKey]
      ).catch(() => null)
      if (current?.status === 'completed' && current.request_hash === hash) {
        return replayAppointmentCreation(current, hash)
      }
    }
    throw error
  }
}
