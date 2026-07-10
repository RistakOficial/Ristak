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

function parseJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
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

export function normalizeSavedCardIdempotencyKey(value) {
  const key = String(value || '').trim()
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw createHttpError('La llave de seguridad del cobro no es válida. Recarga la pantalla e inténtalo otra vez.', 400)
  }
  return key
}

export function createSavedCardProviderIdempotencyKey(provider, idempotencyKey) {
  const cleanProvider = String(provider || '').trim().toLowerCase()
  const cleanKey = normalizeSavedCardIdempotencyKey(idempotencyKey)
  return `ristak:saved-card:${cleanProvider}:${hashValue(cleanKey).slice(0, 40)}`
}

function replaySavedCardRequest(row, expectedHash) {
  if (row.request_hash !== expectedHash) {
    throw createHttpError('La llave de seguridad ya se usó con datos distintos. Inicia un cobro nuevo antes de volver a intentar.', 409)
  }

  if (row.status === 'completed') {
    return parseJson(row.response_json, null)
  }

  if (row.status === 'failed') {
    throw createHttpError(
      row.error_message || 'Este intento quedó bloqueado para evitar un cargo duplicado. Revisa el historial de pagos antes de iniciar otro cobro.',
      Number(row.error_status || 409)
    )
  }

  throw createHttpError('Este cobro ya está en proceso. Revisa el historial de pagos antes de volver a intentarlo.', 409)
}

async function reserveSavedCardRequest(provider, idempotencyKey, hash, nowIso) {
  const insertReservation = async (adapter) => {
    const existing = await adapter.get(
      'SELECT * FROM saved_card_payment_requests WHERE provider = ? AND idempotency_key = ?',
      [provider, idempotencyKey]
    )
    if (existing) return { created: false, row: existing }

    await adapter.run(
      `INSERT INTO saved_card_payment_requests (
        provider, idempotency_key, request_hash, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'processing', ?, ?)`,
      [provider, idempotencyKey, hash, nowIso, nowIso]
    )

    return {
      created: true,
      row: {
        provider,
        idempotency_key: idempotencyKey,
        request_hash: hash,
        status: 'processing',
        created_at: nowIso,
        updated_at: nowIso
      }
    }
  }

  try {
    // PostgreSQL usa una transacción corta. SQLite comparte una sola conexión:
    // ahí el INSERT con PK ya es atómico y evita el error de transacciones
    // anidadas cuando llegan dos requests simultáneos.
    return process.env.DATABASE_URL
      ? await db.transaction(insertReservation)
      : await insertReservation(db)
  } catch (error) {
    // Dos procesos pueden intentar reservar la misma llave al mismo tiempo. La
    // PK decide cuál gana; el perdedor siempre reproduce/bloquea desde la fila.
    const raced = await db.get(
      'SELECT * FROM saved_card_payment_requests WHERE provider = ? AND idempotency_key = ?',
      [provider, idempotencyKey]
    )
    if (raced) return { created: false, row: raced }
    throw error
  }
}

/**
 * Ejecuta una mutación de tarjeta guardada una sola vez por llave del cliente.
 *
 * - Una respuesta completada se reproduce desde DB sin llamar al proveedor.
 * - Un intento en proceso o ambiguamente fallido queda bloqueado; nunca se
 *   vuelve a cobrar a ciegas.
 * - La llave derivada de proveedor es estable y se propaga a Stripe, Conekta o
 *   Rebill como segunda barrera contra dobles cargos.
 *
 * Durante el rollout, clientes antiguos sin llave conservan el comportamiento
 * anterior. Los clientes nuevos deben mandar `Idempotency-Key` o
 * `clientRequestId` estable durante toda la vida del intento.
 */
export async function runIdempotentSavedCardPayment({ provider, idempotencyKey, payload, create }) {
  const cleanProvider = String(provider || '').trim().toLowerCase()
  const suppliedKey = String(idempotencyKey || '').trim()

  if (!suppliedKey) {
    return create({ providerIdempotencyKey: '' })
  }

  const cleanKey = normalizeSavedCardIdempotencyKey(suppliedKey)
  const hash = requestHash(cleanProvider, payload)
  const nowIso = new Date().toISOString()
  const reservation = await reserveSavedCardRequest(cleanProvider, cleanKey, hash, nowIso)

  if (!reservation.created) {
    return replaySavedCardRequest(reservation.row, hash)
  }

  try {
    const result = await create({
      providerIdempotencyKey: createSavedCardProviderIdempotencyKey(cleanProvider, cleanKey)
    })
    const paymentId = String(result?.payment?.id || result?.paymentId || result?.id || '').trim()
    await db.run(
      `UPDATE saved_card_payment_requests
       SET status = 'completed', payment_id = ?, response_json = ?, updated_at = ?
       WHERE provider = ? AND idempotency_key = ?`,
      [paymentId || null, JSON.stringify(result ?? null), new Date().toISOString(), cleanProvider, cleanKey]
    )
    return result
  } catch (error) {
    const errorStatus = normalizeErrorStatus(error)
    await db.run(
      `UPDATE saved_card_payment_requests
       SET status = 'failed', error_status = ?, error_message = ?, updated_at = ?
       WHERE provider = ? AND idempotency_key = ?`,
      [
        errorStatus,
        String(error?.message || 'No se pudo completar el cobro con tarjeta guardada.'),
        new Date().toISOString(),
        cleanProvider,
        cleanKey
      ]
    ).catch(() => {})
    throw error
  }
}
