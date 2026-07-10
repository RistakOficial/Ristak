import crypto from 'crypto'
import { db } from '../config/database.js'

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/
const OMITTED_HASH_KEYS = new Set([
  'idempotencyKey',
  'idempotency_key',
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

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex')
}

function requestHash(provider, payload) {
  return hashValue(`${provider}:${JSON.stringify(stableValue(payload || {}))}`)
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

export function normalizeSubscriptionIdempotencyKey(value) {
  const key = String(value || '').trim()
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw createHttpError('La llave de seguridad de la suscripción no es válida. Cierra este formulario y vuelve a intentarlo.', 400)
  }
  return key
}

function replaySubscriptionCreation(row, expectedHash) {
  if (row.request_hash !== expectedHash) {
    throw createHttpError('La llave de seguridad ya se usó con datos distintos. Inicia una suscripción nueva antes de volver a intentar.', 409)
  }

  if (row.status === 'completed') {
    const response = parseJson(row.response_json)
    if (response !== undefined) return response
    throw createHttpError('La suscripción ya se creó, pero su respuesta guardada no se pudo leer. Revisa la lista antes de intentar otra vez.', 500)
  }

  if (row.status === 'failed') {
    throw createHttpError(
      row.error_message || 'Este intento quedó bloqueado para evitar una suscripción duplicada. Revisa la lista antes de iniciar otra.',
      Number(row.error_status || 409)
    )
  }

  throw createHttpError('Esta suscripción ya está en proceso. Revisa la lista antes de volver a intentarlo.', 409)
}

async function reserveSubscriptionCreation(provider, idempotencyKey, hash, nowIso) {
  const insertReservation = async (adapter) => {
    const existing = await adapter.get(
      'SELECT * FROM subscription_creation_requests WHERE idempotency_key = ?',
      [idempotencyKey]
    )
    if (existing) return { created: false, row: existing }

    await adapter.run(
      `INSERT INTO subscription_creation_requests (
        idempotency_key, provider, request_hash, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'processing', ?, ?)`,
      [idempotencyKey, provider, hash, nowIso, nowIso]
    )

    return {
      created: true,
      row: {
        idempotency_key: idempotencyKey,
        provider,
        request_hash: hash,
        status: 'processing',
        created_at: nowIso,
        updated_at: nowIso
      }
    }
  }

  try {
    // PostgreSQL usa una transacción corta. SQLite comparte una conexión, así
    // que el INSERT protegido por la PK es la reserva atómica.
    return process.env.DATABASE_URL
      ? await db.transaction(insertReservation)
      : await insertReservation(db)
  } catch (error) {
    // Si dos instancias chocan, la PK elige una ganadora. La otra siempre lee
    // la reserva durable y reproduce o bloquea; jamás crea otra suscripción.
    const raced = await db.get(
      'SELECT * FROM subscription_creation_requests WHERE idempotency_key = ?',
      [idempotencyKey]
    )
    if (raced) return { created: false, row: raced }
    throw error
  }
}

/**
 * Ejecuta la creación de una suscripción una sola vez por intento del cliente.
 *
 * Una respuesta completada se reproduce desde la base. Un intento en proceso o
 * fallido queda bloqueado porque la pasarela pudo haber alcanzado a crear el
 * objeto remoto aunque su respuesta se haya perdido. Los clientes legacy que
 * todavía no envían llave conservan temporalmente el comportamiento anterior.
 */
export async function runIdempotentSubscriptionCreation({ provider, idempotencyKey, payload, create }) {
  const cleanProvider = String(provider || '').trim().toLowerCase() || 'stripe'
  const suppliedKey = String(idempotencyKey || '').trim()

  if (!suppliedKey) return create()

  const cleanKey = normalizeSubscriptionIdempotencyKey(suppliedKey)
  const hash = requestHash(cleanProvider, payload)
  const nowIso = new Date().toISOString()
  const reservation = await reserveSubscriptionCreation(cleanProvider, cleanKey, hash, nowIso)

  if (!reservation.created) return replaySubscriptionCreation(reservation.row, hash)

  try {
    const result = await create()
    const subscriptionId = String(result?.id || result?.subscriptionId || '').trim()
    await db.run(
      `UPDATE subscription_creation_requests
       SET status = 'completed', subscription_id = ?, response_json = ?, updated_at = ?
       WHERE idempotency_key = ? AND status = 'processing'`,
      [subscriptionId || null, JSON.stringify(result ?? null), new Date().toISOString(), cleanKey]
    )
    return result
  } catch (error) {
    const errorStatus = normalizeErrorStatus(error)
    if (error && typeof error === 'object') {
      // Los errores desconocidos (DB, serializacion o runtime) son 500. No deben
      // degradarse al 400 generico del controller. También copiamos statusCode
      // (forma usada por Stripe) a status para que el móvil no rote la llave de
      // un 409/429/5xx y repita una mutación cuyo resultado quedó ambiguo.
      error.status = errorStatus
    }
    await db.run(
      `UPDATE subscription_creation_requests
       SET status = 'failed', error_status = ?, error_message = ?, updated_at = ?
       WHERE idempotency_key = ? AND status = 'processing'`,
      [
        errorStatus,
        String(error?.message || 'No se pudo completar la creación de la suscripción.'),
        new Date().toISOString(),
        cleanKey
      ]
    ).catch(() => {})
    throw error
  }
}
