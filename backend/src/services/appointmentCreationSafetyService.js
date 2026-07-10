import crypto from 'crypto'
import { db } from '../config/database.js'

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/
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

async function reserveAppointmentCreation(clientRequestId, hash, nowIso) {
  try {
    const result = await db.run(
      `INSERT INTO appointment_creation_requests (
        client_request_id, request_hash, status, created_at, updated_at
      ) VALUES (?, ?, 'processing', ?, ?)
      ON CONFLICT(client_request_id) DO NOTHING`,
      [clientRequestId, hash, nowIso, nowIso]
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
  const reservation = await reserveAppointmentCreation(cleanKey, hash, new Date().toISOString())

  if (!reservation.created) return replayAppointmentCreation(reservation.row, hash)

  try {
    const result = await create()
    const appointmentId = String(result?.id || result?.appointment?.id || '').trim()
    await db.run(
      `UPDATE appointment_creation_requests
       SET status = 'completed', appointment_id = ?, response_json = ?, updated_at = ?
       WHERE client_request_id = ? AND status = 'processing'`,
      [appointmentId || null, JSON.stringify(result ?? null), new Date().toISOString(), cleanKey]
    )
    return result
  } catch (error) {
    const errorStatus = normalizeErrorStatus(error)
    if (error && typeof error === 'object') error.status = errorStatus
    await db.run(
      `UPDATE appointment_creation_requests
       SET status = 'failed', error_status = ?, error_message = ?, updated_at = ?
       WHERE client_request_id = ? AND status = 'processing'`,
      [
        errorStatus,
        String(error?.message || 'No se pudo completar la creación de la cita.'),
        new Date().toISOString(),
        cleanKey
      ]
    ).catch(() => {})
    throw error
  }
}
