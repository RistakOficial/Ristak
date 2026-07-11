import crypto from 'crypto'
import { db } from '../config/database.js'

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/
const CONVERSATIONAL_V2_SLOT_KEY_PREFIX = 'conv-v2-slot:'
const CONVERSATIONAL_V2_APPOINTMENT_KEY_PREFIX = 'conv-v2-appointment:'
const CONVERSATIONAL_V2_ATTEMPT_KEY_PREFIX = 'conv-v2-attempt:'
const APPOINTMENT_CREATION_PROCESSING_LEASE_MS = 2 * 60 * 1000
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

function normalizeErrorStatus(error) {
  const status = Number(error?.status || error?.statusCode || 500)
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500
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
    throw createHttpError(
      row.error_message || 'Este intento quedó bloqueado para evitar una cita duplicada. Revisa el calendario antes de iniciar otra.',
      Number(row.error_status || 409)
    )
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
    endTime: appointment?.end_time || appointment?.start_time || null
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
            start_time, end_time, deleted_at
     FROM appointments
     WHERE id = ?`,
    [appointmentId]
  )
}

async function findAppointmentCreatedForRequest(payload = {}) {
  const calendarId = String(payload.calendarId || payload.calendar_id || '').trim()
  const contactId = String(payload.contactId || payload.contact_id || '').trim()
  const startTime = payload.startTime || payload.start_time
  const endTime = payload.endTime || payload.end_time
  if (!calendarId || !contactId || normalizeComparableInstant(startTime) === null) return null

  const candidates = await db.all(
    `SELECT id, calendar_id, contact_id, title, appointment_status, status,
            start_time, end_time, deleted_at
     FROM appointments
     WHERE calendar_id = ? AND contact_id = ?
     ORDER BY COALESCE(date_updated, date_added, start_time) DESC
     LIMIT 20`,
    [calendarId, contactId]
  )
  return (candidates || []).find((appointment) => sameAppointmentResource(appointment, {
    calendarId,
    startTime,
    endTime
  })) || null
}

async function resetCreationRequestToProcessing({ row, hash, processingToken, nowIso }) {
  const update = await db.run(
    `UPDATE appointment_creation_requests
     SET request_hash = ?, status = 'processing', processing_token = ?, appointment_id = NULL,
         response_json = NULL, error_status = NULL, error_message = NULL, updated_at = ?
     WHERE client_request_id = ? AND request_hash = ? AND status = ?`,
    [hash, processingToken, nowIso, row.client_request_id, row.request_hash, row.status]
  )
  if (Number(update?.changes || 0) === 1) return { created: true }
  const raced = await loadCreationRequestForUpdate(row.client_request_id)
  if (!raced) throw createHttpError('No se pudo confirmar la nueva reserva segura del horario. Intenta de nuevo.', 503)
  return { created: false, row: raced }
}

/**
 * Reconcilia las llaves conversacionales con la cita canónica. Las llaves nuevas
 * representan un intento (mensaje+contacto+slot); el candado físico vive en el
 * calendario. Las llaves conv-v2-slot antiguas aún se reciclan para no dejar
 * horarios atrapados durante la migración.
 */
async function reconcileConversationalAppointmentRequest({
  clientRequestId,
  hash,
  payload,
  processingToken,
  nowIso
}) {
  if (!isConversationalV2Request(clientRequestId)) return null

  return db.transaction(async () => {
    const row = await loadCreationRequestForUpdate(clientRequestId)
    if (!row) throw createHttpError('No se pudo confirmar la reserva segura de la cita. Intenta de nuevo.', 503)

    if (row.status === 'failed') {
      if (row.request_hash !== hash && !isLegacyConversationalSlotRequest(clientRequestId)) {
        return { created: false, row }
      }
      return resetCreationRequestToProcessing({ row, hash, processingToken, nowIso })
    }

    if (row.status === 'processing') {
      if (!processingLeaseExpired(row, nowIso)) return { created: false, row }

      const recoveredAppointment = await loadCanonicalAppointment(row.appointment_id)
        || (row.request_hash === hash ? await findAppointmentCreatedForRequest(payload) : null)
      if (recoveredAppointment) {
        const state = appointmentReplayState(recoveredAppointment, payload)
        const response = canonicalAppointmentResponse(row, recoveredAppointment, state)
        const completed = await db.run(
          `UPDATE appointment_creation_requests
           SET status = 'completed', processing_token = NULL, appointment_id = ?, response_json = ?,
               error_status = NULL, error_message = NULL, updated_at = ?
           WHERE client_request_id = ? AND status = 'processing'`,
          [recoveredAppointment.id, JSON.stringify(response), nowIso, clientRequestId]
        )
        if (Number(completed?.changes || 0) === 1) return { replay: response }
        const raced = await loadCreationRequestForUpdate(clientRequestId)
        return { created: false, row: raced }
      }

      if (row.request_hash !== hash && !isLegacyConversationalSlotRequest(clientRequestId)) {
        return { created: false, row }
      }
      return resetCreationRequestToProcessing({ row, hash, processingToken, nowIso })
    }

    if (row.status !== 'completed' || !row.appointment_id) return { created: false, row }

    const appointment = await loadCanonicalAppointment(row.appointment_id)
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
       SET status = 'completed', processing_token = NULL, appointment_id = ?, response_json = ?, updated_at = ?
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
               appointment_id = ?, response_json = ?, error_status = NULL, error_message = NULL,
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
    const errorStatus = normalizeErrorStatus(error)
    if (error && typeof error === 'object') error.status = errorStatus
    const failed = await db.run(
      `UPDATE appointment_creation_requests
       SET status = 'failed', processing_token = NULL, error_status = ?, error_message = ?, updated_at = ?
       WHERE client_request_id = ? AND request_hash = ? AND status = 'processing' AND processing_token = ?`,
      [
        errorStatus,
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
