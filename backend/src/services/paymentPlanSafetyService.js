import crypto from 'crypto'
import { DateTime } from 'luxon'
import { db } from '../config/database.js'
import { businessTodayDateOnly, getAccountTimezone, normalizeDateOnlyInTimezone, normalizeToUtcIso } from '../utils/dateUtils.js'

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/
const IDEMPOTENCY_REUSE_WINDOW_MS = 15 * 60 * 1000
const ZERO_DECIMAL_CURRENCIES = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'])

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value).sort().reduce((result, key) => {
    if (!['idempotencyKey', 'clientRequestId'].includes(key)) result[key] = stableValue(value[key])
    return result
  }, {})
}

function requestHash(provider, payload) {
  return crypto.createHash('sha256')
    .update(`${provider}:${JSON.stringify(stableValue(payload || {}))}`)
    .digest('hex')
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

async function acquireCreationHashGuard(provider, hash, idempotencyKey) {
  const now = new Date()
  const nowIso = now.toISOString()
  const expiresAt = new Date(now.getTime() + IDEMPOTENCY_REUSE_WINDOW_MS).toISOString()
  await db.run(
    'DELETE FROM payment_plan_creation_hash_guards WHERE expires_at <= ?',
    [nowIso]
  )
  try {
    await db.run(
      `INSERT INTO payment_plan_creation_hash_guards (
        provider, request_hash, idempotency_key, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
      [provider, hash, idempotencyKey, expiresAt, nowIso]
    )
    return
  } catch (error) {
    const guard = await db.get(
      `SELECT idempotency_key FROM payment_plan_creation_hash_guards
       WHERE provider = ? AND request_hash = ? AND expires_at > ?`,
      [provider, hash, nowIso]
    )
    if (!guard) throw error
    const guardedRequest = await db.get(
      'SELECT * FROM payment_plan_creation_requests WHERE provider = ? AND idempotency_key = ?',
      [provider, guard.idempotency_key]
    )
    if (guardedRequest) return replayCreationRequest(guardedRequest, hash)
    throw createHttpError('Este mismo plan ya se está creando. Espera unos segundos y consulta el resultado; no lo envíes otra vez.', 409)
  }
}

async function releaseCreationHashGuard(provider, hash, idempotencyKey) {
  await db.run(
    `DELETE FROM payment_plan_creation_hash_guards
     WHERE provider = ? AND request_hash = ? AND idempotency_key = ?`,
    [provider, hash, idempotencyKey]
  )
}

export function normalizePaymentPlanIdempotencyKey(value) {
  const key = String(value || '').trim()
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw createHttpError('Falta una llave de seguridad válida para crear el plan. Recarga la pantalla e inténtalo otra vez.', 400)
  }
  return key
}

/**
 * Una creación de plan sólo puede ejecutarse una vez. Si la respuesta se pierde,
 * el mismo intento recibe exactamente el resultado guardado; jamás vuelve a cobrar.
 */
export async function runIdempotentPaymentPlanCreation({ provider, idempotencyKey, payload, create }) {
  const cleanProvider = String(provider || '').trim().toLowerCase()
  const hash = requestHash(cleanProvider, payload)
  const suppliedKey = String(idempotencyKey || '').trim()
  // Compatibilidad con versiones móviles anteriores: si aún no mandan header,
  // se usa una llave determinista por día de negocio + payload. Es más
  // conservadora (puede deduplicar dos altas idénticas el mismo día), pero nunca
  // sacrifica seguridad anti-doble-cobro durante el rollout.
  const cleanKey = suppliedKey
    ? normalizePaymentPlanIdempotencyKey(suppliedKey)
    : `legacy:${cleanProvider}:${businessTodayDateOnly(await getAccountTimezone())}:${hash.slice(0, 32)}`
  if (payload && typeof payload === 'object' && !payload.idempotencyKey) payload.idempotencyKey = cleanKey
  const nowIso = new Date().toISOString()

  const existing = await db.get(
    'SELECT * FROM payment_plan_creation_requests WHERE provider = ? AND idempotency_key = ?',
    [cleanProvider, cleanKey]
  )
  if (existing) return replayCreationRequest(existing, hash)

  // Segunda barrera: un cliente que accidentalmente regenere la llave no puede
  // repetir el mismo plan durante la ventana crítica de envío/respuesta.
  const recent = await db.get(
    `SELECT * FROM payment_plan_creation_requests
     WHERE provider = ? AND request_hash = ? AND created_at >= ?
     ORDER BY created_at DESC LIMIT 1`,
    [cleanProvider, hash, new Date(Date.now() - IDEMPOTENCY_REUSE_WINDOW_MS).toISOString()]
  )
  if (recent) return replayCreationRequest(recent, hash)

  const guardedReplay = await acquireCreationHashGuard(cleanProvider, hash, cleanKey)
  if (guardedReplay !== undefined) return guardedReplay

  try {
    await db.run(
      `INSERT INTO payment_plan_creation_requests (
        provider, idempotency_key, request_hash, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'processing', ?, ?)`,
      [cleanProvider, cleanKey, hash, nowIso, nowIso]
    )
  } catch (error) {
    const raced = await db.get(
      'SELECT * FROM payment_plan_creation_requests WHERE provider = ? AND idempotency_key = ?',
      [cleanProvider, cleanKey]
    )
    if (raced) return replayCreationRequest(raced, hash)
    await releaseCreationHashGuard(cleanProvider, hash, cleanKey).catch(() => {})
    throw error
  }

  try {
    const result = await create()
    await db.run(
      `UPDATE payment_plan_creation_requests
       SET status = 'completed', flow_id = ?, response_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE provider = ? AND idempotency_key = ?`,
      [String(result?.flowId || result?.id || ''), JSON.stringify(result ?? null), cleanProvider, cleanKey]
    )
    return result
  } catch (error) {
    const errorStatus = Number(error?.status || error?.statusCode || 500)
    const quarantinedCount = await quarantineIncompletePaymentPlanCreation(cleanProvider, cleanKey).catch(() => 0)
    const validationOnly = quarantinedCount === 0
      && errorStatus >= 400
      && errorStatus < 500
      && ![402, 408, 409, 425, 429].includes(errorStatus)
    if (validationOnly) {
      await db.run(
        'DELETE FROM payment_plan_creation_requests WHERE provider = ? AND idempotency_key = ?',
        [cleanProvider, cleanKey]
      ).catch(() => {})
      await releaseCreationHashGuard(cleanProvider, hash, cleanKey).catch(() => {})
    } else {
      await db.run(
        `UPDATE payment_plan_creation_requests
         SET status = 'failed', error_status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
         WHERE provider = ? AND idempotency_key = ?`,
        [errorStatus, String(error?.message || 'No se pudo crear el plan.'), cleanProvider, cleanKey]
      ).catch(() => {})
    }
    throw error
  }
}

async function quarantineIncompletePaymentPlanCreation(provider, idempotencyKey) {
  const candidates = await db.all(
    'SELECT id, metadata FROM payment_flows WHERE payment_provider = ?',
    [provider]
  )
  const rows = (candidates || []).filter((row) => parseJson(row.metadata, {})?.creationRequestKey === idempotencyKey)
  for (const row of rows || []) {
    await db.run(
      `UPDATE payment_flows
       SET current_state = 'creation_failed_review',
           first_payment_status = CASE WHEN first_payment_status IN ('scheduled', 'pending') THEN 'overdue_review' ELSE first_payment_status END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [row.id]
    )
    await db.run(
      `UPDATE installment_payments
       SET status = CASE WHEN status IN ('scheduled', 'pending', 'waiting_card_authorization') THEN 'overdue_review' ELSE status END,
           notes = 'La creación no terminó. Se bloqueó cualquier cobro automático para revisión.',
           updated_at = CURRENT_TIMESTAMP
       WHERE flow_id = ?`,
      [row.id]
    )
    await db.run(
      `UPDATE payments SET status = 'overdue', updated_at = CURRENT_TIMESTAMP
       WHERE status IN ('scheduled', 'pending') AND id IN (
         SELECT payment_id FROM installment_payments WHERE flow_id = ? AND payment_id IS NOT NULL
         UNION SELECT first_payment_invoice_id FROM payment_flows WHERE id = ? AND first_payment_invoice_id IS NOT NULL
       )`,
      [row.id, row.id]
    )
  }
  return (rows || []).length
}

function replayCreationRequest(row, expectedHash) {
  if (row.request_hash !== expectedHash) {
    throw createHttpError('La llave de seguridad ya se usó con datos distintos. Recarga la pantalla antes de crear otro plan.', 409)
  }
  if (row.status === 'completed') return parseJson(row.response_json, null)
  if (row.status === 'failed') {
    throw createHttpError(row.error_message || 'Este intento no se completó y quedó bloqueado para evitar un cobro duplicado. Crea un plan nuevo después de revisar los movimientos.', Number(row.error_status || 409))
  }
  throw createHttpError('Este plan ya se está creando. Espera unos segundos y vuelve a consultar; no lo envíes otra vez.', 409)
}

export function currencyMinorUnits(currency) {
  return ZERO_DECIMAL_CURRENCIES.has(String(currency || '').trim().toUpperCase()) ? 0 : 2
}

export function moneyToMinorUnits(value, currency) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return null
  return Math.round(amount * (10 ** currencyMinorUnits(currency)))
}

export function assertExactPaymentPlanTotal({ totalAmount, firstPaymentAmount = 0, remainingPayments = [], currency }) {
  const expected = moneyToMinorUnits(totalAmount, currency)
  const actual = moneyToMinorUnits(firstPaymentAmount, currency) + remainingPayments.reduce((sum, payment) => {
    return sum + (moneyToMinorUnits(payment?.amount, currency) ?? Number.NaN)
  }, 0)
  if (!Number.isFinite(expected) || !Number.isFinite(actual) || expected !== actual) {
    const units = currencyMinorUnits(currency)
    const actualAmount = Number.isFinite(actual) ? actual / (10 ** units) : 0
    throw createHttpError(`Las parcialidades suman ${actualAmount.toFixed(units)} ${currency}, pero el total es ${Number(totalAmount).toFixed(units)} ${currency}.`, 400)
  }
}

export async function getPaymentPlanDueSafety(value, timezone = '') {
  const zone = timezone || await getAccountTimezone()
  const dueDate = normalizeDateOnlyInTimezone(value, zone)
  const today = businessTodayDateOnly(zone)
  return {
    dueDate,
    today,
    overdue: dueDate < today,
    todayOrFuture: dueDate >= today
  }
}

export async function markOverduePaymentPlanChargesForReview(provider) {
  const timezone = await getAccountTimezone()
  const today = businessTodayDateOnly(timezone)
  const todayStartUtc = normalizeToUtcIso(`${today}T00:00:00`, timezone)
  const activeState = provider === 'mercadopago' ? 'mercadopago_plan_active' : 'installment_plan_active'
  const eligibleStates = provider === 'mercadopago'
    ? [activeState]
    : [activeState, 'waiting_card_authorization']
  const flows = await db.all(
    `SELECT f.id, f.first_payment_invoice_id, COALESCE(f.first_payment_date, p.due_date, p.date) AS due_value
     FROM payment_flows f
     LEFT JOIN payments p ON p.id = f.first_payment_invoice_id
     WHERE f.payment_provider = ?
       AND f.current_state IN (${eligibleStates.map(() => '?').join(', ')})
       AND f.first_payment_status IN ('pending', 'scheduled')
       AND f.first_payment_invoice_id IS NOT NULL
       AND COALESCE(f.first_payment_date, p.due_date, p.date) < ?`,
    [provider, ...eligibleStates, todayStartUtc]
  )
  for (const flow of flows || []) {
    if (normalizeDateOnlyInTimezone(flow.due_value, timezone) >= today) continue
    await db.run(
      `UPDATE payment_flows SET first_payment_status = 'overdue_review', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND first_payment_status IN ('pending', 'scheduled')`,
      [flow.id]
    )
    await db.run(
      `UPDATE payments SET status = 'overdue', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status IN ('pending', 'scheduled')`,
      [flow.first_payment_invoice_id]
    )
    await db.run(
      `UPDATE payment_flows SET current_state = 'paused', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND current_state IN (${eligibleStates.map(() => '?').join(', ')})`,
      [flow.id, ...eligibleStates]
    )
  }

  const installments = await db.all(
    `SELECT i.id, i.payment_id, i.due_date
     FROM installment_payments i
     JOIN payment_flows f ON f.id = i.flow_id
     WHERE f.payment_provider = ?
       AND f.current_state = ?
       AND i.automatic = 1 AND i.status = 'scheduled'
       AND i.due_date < ?`,
    [provider, activeState, todayStartUtc]
  )
  for (const installment of installments || []) {
    if (normalizeDateOnlyInTimezone(installment.due_date, timezone) >= today) continue
    await db.run(
      `UPDATE installment_payments SET status = 'overdue_review', notes = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'scheduled'`,
      ['No se cobró automáticamente porque la fecha ya había pasado. Requiere revisión y reprogramación.', installment.id]
    )
    await db.run(
      `UPDATE payments SET status = 'overdue', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status IN ('pending', 'scheduled')`,
      [installment.payment_id]
    )
    await db.run(
      `UPDATE payment_flows SET current_state = 'paused', updated_at = CURRENT_TIMESTAMP
       WHERE id = (SELECT flow_id FROM installment_payments WHERE id = ?)
         AND current_state = ?`,
      [installment.id, activeState]
    )
  }
}

export async function assertPlanCanChangeState(flowId, { activating = false } = {}) {
  const processing = await db.get(
    `SELECT
       (SELECT COUNT(*) FROM installment_payments WHERE flow_id = ? AND status = 'processing') AS installment_count,
       (SELECT COUNT(*) FROM payment_flows WHERE id = ? AND first_payment_status = 'processing') AS first_count`,
    [flowId, flowId]
  )
  if (Number(processing?.installment_count || 0) + Number(processing?.first_count || 0) > 0) {
    throw createHttpError('Hay un cobro en proceso. Espera a que termine antes de pausar, cancelar o modificar el plan.', 409)
  }
  if (!activating) return
  const timezone = await getAccountTimezone()
  const today = businessTodayDateOnly(timezone)
  const datedRows = await db.all(
    `SELECT id, due_date FROM installment_payments
     WHERE flow_id = ? AND automatic = 1 AND status IN ('scheduled', 'pending', 'waiting_card_authorization')`,
    [flowId]
  )
  const expiredRows = (datedRows || []).filter((row) => normalizeDateOnlyInTimezone(row.due_date, timezone) < today)
  for (const row of expiredRows) {
    await db.run(
      `UPDATE installment_payments SET status = 'overdue_review', notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ['No se cobró automáticamente porque la fecha ya había pasado. Requiere reprogramación.', row.id]
    )
  }
  const first = await db.get(
    `SELECT f.first_payment_status, COALESCE(f.first_payment_date, p.due_date, p.date) AS due_value
     FROM payment_flows f LEFT JOIN payments p ON p.id = f.first_payment_invoice_id WHERE f.id = ?`,
    [flowId]
  )
  if (first?.due_value && ['scheduled', 'pending'].includes(String(first.first_payment_status || '').toLowerCase()) && normalizeDateOnlyInTimezone(first.due_value, timezone) < today) {
    await db.run(`UPDATE payment_flows SET first_payment_status = 'overdue_review', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [flowId])
  }
  const overdue = await db.get(
    `SELECT
       (SELECT COUNT(*) FROM installment_payments WHERE flow_id = ? AND status IN ('overdue_review', 'overdue')) AS installment_count,
       (SELECT COUNT(*) FROM payment_flows WHERE id = ? AND first_payment_status IN ('overdue_review', 'overdue')) AS first_count`,
    [flowId, flowId]
  )
  if (Number(overdue?.installment_count || 0) + Number(overdue?.first_count || 0) > 0) {
    throw createHttpError('Este plan tiene cobros vencidos. Reprograma esas fechas antes de activarlo; Ristak no cobrará atrasos automáticamente.', 409)
  }
}

export async function withPaymentPlanEditState(flowId, provider, edit) {
  const flow = await db.get('SELECT current_state FROM payment_flows WHERE id = ? AND payment_provider = ?', [flowId, provider])
  if (!flow) throw createHttpError('Plan de pago no encontrado.', 404)
  const originalState = String(flow.current_state || '')
  const claim = await db.run(
    `UPDATE payment_flows SET current_state = 'editing', updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND payment_provider = ? AND current_state = ?
       AND COALESCE(first_payment_status, '') <> 'processing'
       AND NOT EXISTS (SELECT 1 FROM installment_payments i WHERE i.flow_id = payment_flows.id AND i.status = 'processing')`,
    [flowId, provider, originalState]
  )
  if (!(Number(claim?.changes || 0) > 0)) {
    throw createHttpError('Hay un cobro en proceso o el plan cambió mientras lo editabas. Actualiza y vuelve a intentarlo.', 409)
  }
  try {
    const result = await edit(originalState)
    const restore = await db.run(
      `UPDATE payment_flows SET current_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND current_state = 'editing'`,
      [originalState, flowId]
    )
    if (Number(restore?.changes || 0) !== 1) {
      await db.run(
        `UPDATE payment_flows SET current_state = 'paused', updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND payment_provider = ? AND current_state NOT IN ('cancelled', 'deleted')`,
        [flowId, provider]
      ).catch(() => {})
      throw createHttpError('El plan cambió mientras se guardaba. Quedó pausado para evitar un cobro con datos incompletos.', 409)
    }
    return result
  } catch (error) {
    await db.run(
      `UPDATE payment_flows SET current_state = 'paused', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND current_state = 'editing'`,
      [flowId]
    ).catch(() => {})
    throw error
  }
}

export function defaultPlanChargeTime(value, timezone, fallbackTime = '10:00:00') {
  const text = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return value
  const parsed = DateTime.fromISO(`${text}T${fallbackTime}`, { zone: timezone })
  return parsed.isValid ? parsed.toUTC().toISO() : value
}
