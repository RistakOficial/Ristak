import { createHash, randomUUID } from 'node:crypto'
import { db } from '../config/database.js'
import {
  createPaymentGateLink,
  normalizePaymentGateConfig
} from './publicPaymentGateService.js'
import {
  hardDeleteTestPaymentRecord,
  isTestPaymentRecord,
  scrubTestPaymentRecordForCleanup
} from './paymentRecordSafetyService.js'
import { expireMercadoPagoTestPreference } from './mercadoPagoPaymentService.js'
import { hasFeature } from './licenseService.js'

const TEST_PAYMENT_TTL_MS = 5 * 60 * 1000
const CREATION_LEASE_MS = 2 * 60 * 1000
const CLEANUP_LEASE_MS = 2 * 60 * 1000
const SUCCESS_STATUSES = new Set(['paid', 'succeeded', 'success', 'completed', 'complete', 'fulfilled', 'approved', 'accredited'])
const TEST_LINK_GATEWAYS = new Set(['stripe', 'conekta', 'mercadopago', 'clip', 'rebill'])
const REUSABLE_STATUSES = new Set(['ready', 'paid_test'])
const CLEANUP_CANDIDATE_STATUSES = new Set(['creating', 'failed', 'ready', 'paid_test', 'cleanup_failed'])

let createPaymentGateLinkImpl = createPaymentGateLink
let hardDeleteTestPaymentRecordImpl = hardDeleteTestPaymentRecord
let scrubTestPaymentRecordForCleanupImpl = scrubTestPaymentRecordForCleanup
let expireMercadoPagoTestPreferenceImpl = expireMercadoPagoTestPreference

function cleanString(value, maxLength = 500) {
  return String(value ?? '').trim().slice(0, maxLength)
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

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableObject(value[key])])
  )
}

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex')
}

function mutationCount(result) {
  return Number(result?.changes ?? result?.rowCount ?? 0)
}

function toIso(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw serviceError('La fecha interna del modo test no es válida.', 500, 'invalid_test_clock')
  return date.toISOString()
}

function serviceError(message, statusCode = 400, code = 'invalid_test_payment') {
  const error = new Error(message)
  error.status = statusCode
  error.statusCode = statusCode
  error.code = code
  return error
}

function assertIdentifier(value, label) {
  const normalized = cleanString(value, 180)
  if (!normalized || !/^[A-Za-z0-9:_-]+$/.test(normalized)) {
    throw serviceError(`${label} no es válido. Reinicia la prueba.`, 400, 'invalid_test_payment_identity')
  }
  return normalized
}

function normalizeCurrency(value) {
  const currency = cleanString(value, 3).toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw serviceError('La moneda del cobro de prueba no es válida.', 409, 'invalid_test_payment_currency')
  }
  return currency
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
  if (!Number.isFinite(amount) || amount <= 0) {
    throw serviceError('El monto del cobro de prueba debe ser mayor a cero.', 409, 'invalid_test_payment_amount')
  }
  const factor = 10 ** currencyFractionDigits(currency)
  const normalized = Math.round((amount + Number.EPSILON) * factor) / factor
  const expectedMinor = Math.round(normalized * factor)
  if (Math.round(Math.fround(normalized) * factor) !== expectedMinor) {
    throw serviceError(
      'El monto de prueba es demasiado grande para conservar todos sus decimales de forma segura.',
      409,
      'test_payment_amount_precision_unsafe'
    )
  }
  return normalized
}

function publicLedger(row = {}) {
  const metadata = parseJson(row.metadata_json, {})
  return {
    effectId: row.effect_id || '',
    testRunId: row.test_run_id || '',
    agentId: row.agent_id || '',
    paymentId: row.payment_id || '',
    publicPaymentId: row.public_payment_id || '',
    url: row.payment_url || '',
    provider: row.provider || '',
    amount: Number(row.amount) || 0,
    currency: row.currency || '',
    paymentMode: row.payment_mode || '',
    status: row.status || '',
    paid: row.status === 'paid_test' || Boolean(row.paid_at),
    paidAt: row.paid_at || null,
    cleanupDueAt: row.cleanup_due_at || null,
    cleanedAt: row.cleaned_at || null,
    invalidationStatus: row.invalidation_status || null,
    invalidationError: row.invalidation_error || null,
    lastError: row.last_error || null,
    metadata
  }
}

function getTestMarker(metadata = {}) {
  const marker = metadata.conversationalAgentTest
  return marker && typeof marker === 'object' && !Array.isArray(marker) ? marker : {}
}

function paymentMatchesEffect(payment, effectId, testRunId) {
  if (!payment || !isTestPaymentRecord(payment)) return false
  const metadata = parseJson(payment.metadata_json, {})
  const marker = getTestMarker(metadata)
  const indexedEffectId = cleanString(payment.conversational_test_effect_id, 180)
  const metadataEffectId = cleanString(marker.testEffectId || metadata.testEffectId, 180)
  const metadataRunId = cleanString(marker.testRunId || metadata.testRunId, 180)

  if (indexedEffectId) {
    // La columna sólo la escriben los factories server-side del tester y es
    // UNIQUE. Permite recuperar aun si metadata_json quedó truncado/corrupto.
    return indexedEffectId === effectId && (!metadataRunId || metadataRunId === testRunId)
  }
  return metadataEffectId === effectId && metadataRunId === testRunId
}

async function loadPaymentByEffect(effectId, testRunId) {
  // Ruta normal y recuperable tras crash: cada proveedor persiste este marcador
  // en la MISMA inserción que crea el pago. El índice único evita dos artefactos
  // locales para un mismo efecto incluso si el proceso cae antes de ligar el ledger.
  const indexed = await db.get(
    `SELECT * FROM payments
     WHERE conversational_test_effect_id = ?
     LIMIT 1`,
    [effectId]
  ).catch(() => null)
  if (indexed && paymentMatchesEffect(indexed, effectId, testRunId)) return indexed

  // Compatibilidad de rolling deploy: una instancia anterior pudo alcanzar a
  // insertar metadata antes de que existiera la columna dedicada. Se conserva
  // este fallback sólo para rescatar y limpiar ese artefacto, nunca como autoridad.
  const candidates = await db.all(
    `SELECT * FROM payments
     WHERE metadata_json LIKE ?
     ORDER BY created_at DESC
     LIMIT 250`,
    [`%${effectId}%`]
  )
  return (candidates || []).find((row) => paymentMatchesEffect(row, effectId, testRunId)) || null
}

async function loadPaymentFromResult(result = {}) {
  const paymentId = cleanString(result?.payment?.id || result?.paymentId, 180)
  const publicPaymentId = cleanString(
    result?.publicPaymentId || result?.payment?.publicPaymentId || result?.payment?.public_payment_id,
    180
  )
  if (paymentId) {
    const byId = await db.get('SELECT * FROM payments WHERE id = ?', [paymentId])
    if (byId) return byId
  }
  if (publicPaymentId) return db.get('SELECT * FROM payments WHERE public_payment_id = ?', [publicPaymentId])
  return null
}

async function assertOwnedEffect({ effectId, testRunId, agentId, requestedByUserId, contactId }) {
  const row = await db.get(
    `SELECT e.id, e.run_id, e.effect_type,
            r.agent_id, r.requested_by_user_id, r.contact_id
     FROM conversational_agent_test_effects e
     INNER JOIN conversational_agent_test_runs r ON r.id = e.run_id
     WHERE e.id = ?`,
    [effectId]
  )
  if (!row || row.effect_type !== 'payment') {
    throw serviceError('El efecto de cobro de prueba ya no existe.', 404, 'test_payment_effect_not_found')
  }
  if (
    cleanString(row.run_id, 180) !== testRunId ||
    cleanString(row.agent_id, 180) !== agentId ||
    cleanString(row.requested_by_user_id, 180) !== requestedByUserId ||
    cleanString(row.contact_id, 180) !== contactId
  ) {
    throw serviceError('La identidad del cobro de prueba cambió. Reinicia la prueba.', 409, 'test_payment_identity_mismatch')
  }
}

async function validateCreatedPayment({ payment, result, config, effectId, testRunId }) {
  if (!payment || !paymentMatchesEffect(payment, effectId, testRunId)) {
    throw serviceError('La pasarela no devolvió evidencia del cobro de prueba.', 502, 'test_payment_evidence_missing')
  }

  const mode = cleanString(payment.payment_mode, 20).toLowerCase()
  if (mode !== 'test' && mode !== 'sandbox') {
    throw serviceError('La pasarela intentó crear un cobro fuera de sandbox. El link fue bloqueado.', 409, 'test_payment_live_mode_blocked')
  }

  const provider = cleanString(payment.payment_provider, 80).toLowerCase()
  const publicPaymentId = cleanString(payment.public_payment_id, 180)
  const url = cleanString(result?.paymentUrl || result?.payment?.paymentUrl || payment.payment_url, 2000)
  const currency = normalizeCurrency(payment.currency)
  const amount = normalizeMoney(payment.amount, currency)

  if (provider !== config.gateway || currency !== config.currency || amount !== config.amount) {
    throw serviceError('La pasarela devolvió datos distintos al monto, moneda o proveedor autorizados.', 409, 'test_payment_contract_mismatch')
  }
  if (!cleanString(payment.id, 180) || !publicPaymentId || !/^https?:\/\//i.test(url)) {
    throw serviceError('La pasarela no devolvió un link público completo.', 502, 'test_payment_link_incomplete')
  }

  return {
    paymentId: cleanString(payment.id, 180),
    publicPaymentId,
    url,
    provider,
    amount,
    currency,
    paymentMode: 'test'
  }
}

async function reserveCreation({
  effectId,
  testRunId,
  agentId,
  requestedByUserId,
  requestHash,
  cleanupDueAt,
  claimToken,
  leaseUntilAt
}) {
  await db.run(
    `INSERT INTO conversational_agent_test_payment_links (
       effect_id, test_run_id, agent_id, requested_by_user_id, request_hash,
       status, payment_mode, cleanup_due_at, claim_token, lease_until_at,
       metadata_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'creating', 'test', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(effect_id) DO NOTHING`,
    [
      effectId,
      testRunId,
      agentId,
      requestedByUserId,
      requestHash,
      cleanupDueAt,
      claimToken,
      leaseUntilAt,
      JSON.stringify({ testRunId, testEffectId: effectId, agentId, requestedByUserId })
    ]
  )

  let row = await db.get('SELECT * FROM conversational_agent_test_payment_links WHERE effect_id = ?', [effectId])
  if (!row || row.request_hash !== requestHash) {
    throw serviceError('Este efecto ya intentó crear otro cobro. Reinicia la prueba para evitar duplicados.', 409, 'test_payment_payload_mismatch')
  }
  if (row.claim_token === claimToken) return { claimed: true, row }
  if (REUSABLE_STATUSES.has(row.status)) return { claimed: false, reused: true, row }
  if (row.status === 'cleaned') {
    throw serviceError('Este link de prueba ya fue eliminado.', 410, 'test_payment_already_cleaned')
  }

  const leaseExpired = !row.lease_until_at || Date.parse(row.lease_until_at) <= Date.now()
  if (row.status === 'creating' && !leaseExpired) {
    throw serviceError('El link de prueba se está creando. Intenta de nuevo en unos segundos.', 409, 'test_payment_creation_in_progress')
  }

  const claimed = await db.run(
    `UPDATE conversational_agent_test_payment_links
     SET status = 'creating', claim_token = ?, lease_until_at = ?,
         last_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE effect_id = ? AND request_hash = ?
       AND (status = 'failed' OR (status = 'creating' AND (lease_until_at IS NULL OR lease_until_at <= ?)))`,
    [claimToken, leaseUntilAt, effectId, requestHash, toIso()]
  )
  if (mutationCount(claimed) !== 1) {
    row = await db.get('SELECT * FROM conversational_agent_test_payment_links WHERE effect_id = ?', [effectId])
    if (REUSABLE_STATUSES.has(row?.status)) return { claimed: false, reused: true, row }
    throw serviceError('El link de prueba cambió mientras se preparaba. Intenta de nuevo.', 409, 'test_payment_creation_race')
  }
  row = await db.get('SELECT * FROM conversational_agent_test_payment_links WHERE effect_id = ?', [effectId])
  return { claimed: true, row }
}

export async function createConversationalAgentTestPaymentLink({
  effectId,
  testRunId,
  agentId,
  requestedByUserId,
  contact = {},
  paymentGateConfig = {},
  baseUrl = '',
  now = Date.now()
} = {}) {
  if (!(await hasFeature('payment_links'))) {
    throw serviceError('Los enlaces de pago están disponibles en el plan Profesional.', 403, 'feature_not_available')
  }
  const cleanEffectId = assertIdentifier(effectId, 'El efecto de pago')
  const cleanTestRunId = assertIdentifier(testRunId, 'La sesión de prueba')
  const cleanAgentId = assertIdentifier(agentId, 'El agente')
  const cleanRequestedByUserId = assertIdentifier(requestedByUserId, 'El usuario')
  const cleanContactId = assertIdentifier(contact.id || contact.contactId, 'El contacto de prueba')
  const requestedGateway = cleanString(paymentGateConfig.gateway || paymentGateConfig.provider, 80).toLowerCase()
  if (!TEST_LINK_GATEWAYS.has(requestedGateway)) {
    throw serviceError('La configuración validada debe incluir una pasarela compatible.', 409, 'test_payment_gateway_required')
  }
  const normalized = normalizePaymentGateConfig({
    ...paymentGateConfig,
    enabled: true,
    mode: 'test'
  })
  if (!cleanString(paymentGateConfig.currency, 3)) {
    throw serviceError('La configuración validada debe incluir la moneda de la cuenta.', 409, 'test_payment_currency_required')
  }
  normalized.currency = normalizeCurrency(paymentGateConfig.currency)
  normalized.amount = normalizeMoney(paymentGateConfig.amount ?? normalized.amount, normalized.currency)
  normalized.mode = 'test'
  if (normalized.gateway !== requestedGateway || normalized.billingType !== 'single') {
    throw serviceError('El tester sólo crea enlaces sandbox de pago único.', 409, 'test_payment_type_not_supported')
  }

  await assertOwnedEffect({
    effectId: cleanEffectId,
    testRunId: cleanTestRunId,
    agentId: cleanAgentId,
    requestedByUserId: cleanRequestedByUserId,
    contactId: cleanContactId
  })

  const createdAt = toIso(now)
  const cleanupDueAt = toIso(new Date(createdAt).getTime() + TEST_PAYMENT_TTL_MS)
  const requestHash = sha256(JSON.stringify(stableObject({
    effectId: cleanEffectId,
    testRunId: cleanTestRunId,
    agentId: cleanAgentId,
    requestedByUserId: cleanRequestedByUserId,
    contactId: cleanContactId,
    config: normalized
  })))
  const claimToken = randomUUID()
  const leaseUntilAt = toIso(new Date(createdAt).getTime() + CREATION_LEASE_MS)
  const reservation = await reserveCreation({
    effectId: cleanEffectId,
    testRunId: cleanTestRunId,
    agentId: cleanAgentId,
    requestedByUserId: cleanRequestedByUserId,
    requestHash,
    cleanupDueAt,
    claimToken,
    leaseUntilAt
  })
  if (reservation.reused) return publicLedger(reservation.row)

  let payment = null
  try {
    payment = await loadPaymentByEffect(cleanEffectId, cleanTestRunId)
    let result = {}
    if (!payment) {
      result = await createPaymentGateLinkImpl(normalized, {
        baseUrl,
        contact: {
          id: cleanContactId,
          contactId: cleanContactId,
          name: cleanString(contact.name || contact.fullName, 180),
          contactName: cleanString(contact.name || contact.fullName, 180),
          email: cleanString(contact.email, 180),
          phone: cleanString(contact.phone, 80)
        },
        source: 'conversational_agent_test',
        forceTestMode: true,
        applyTax: false,
        metadata: {
          paymentMode: 'test',
          suppressProductionEffects: true,
          conversationalAgentTest: {
            testRunId: cleanTestRunId,
            testEffectId: cleanEffectId,
            agentId: cleanAgentId,
            requestedByUserId: cleanRequestedByUserId,
            cleanupDueAt
          }
        }
      })
      payment = await loadPaymentFromResult(result) || await loadPaymentByEffect(cleanEffectId, cleanTestRunId)
    } else {
      result = { payment, paymentUrl: payment.payment_url, publicPaymentId: payment.public_payment_id }
    }

    const validated = await validateCreatedPayment({
      payment,
      result,
      config: normalized,
      effectId: cleanEffectId,
      testRunId: cleanTestRunId
    })
    const completed = await db.run(
      `UPDATE conversational_agent_test_payment_links
       SET status = 'ready', payment_id = ?, public_payment_id = ?, provider = ?,
           amount = ?, currency = ?, payment_mode = 'test', payment_url = ?,
           claim_token = NULL, lease_until_at = NULL, last_error = NULL,
           metadata_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE effect_id = ? AND status = 'creating' AND claim_token = ?`,
      [
        validated.paymentId,
        validated.publicPaymentId,
        validated.provider,
        validated.amount,
        validated.currency,
        validated.url,
        JSON.stringify({
          testRunId: cleanTestRunId,
          testEffectId: cleanEffectId,
          agentId: cleanAgentId,
          requestedByUserId: cleanRequestedByUserId,
          cleanupDueAt,
          paymentCreated: true
        }),
        cleanEffectId,
        claimToken
      ]
    )
    if (mutationCount(completed) !== 1) {
      throw serviceError('Se perdió la reserva del link de prueba antes de guardarlo.', 409, 'test_payment_claim_lost')
    }
    return publicLedger(await db.get('SELECT * FROM conversational_agent_test_payment_links WHERE effect_id = ?', [cleanEffectId]))
  } catch (error) {
    payment = payment || await loadPaymentByEffect(cleanEffectId, cleanTestRunId).catch(() => null)
    if (payment?.id) {
      const paymentMetadata = parseJson(payment.metadata_json, {})
      const marker = getTestMarker(paymentMetadata)
      if (cleanString(marker.testEffectId, 180) === cleanEffectId) {
        // Si un proveedor ignorara el override y devolviera live, no borramos a
        // ciegas un artefacto financiero real. Sí apagamos inmediatamente el
        // checkout local y jamás entregamos su URL.
        await db.run(
          `UPDATE payments
           SET status = 'deleted', payment_url = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [payment.id]
        ).catch(() => undefined)
        await db.run(
          `UPDATE conversational_agent_test_payment_links
           SET payment_id = COALESCE(payment_id, ?),
               public_payment_id = COALESCE(public_payment_id, ?),
               provider = COALESCE(provider, ?), amount = COALESCE(amount, ?),
               currency = COALESCE(currency, ?), payment_url = NULL,
               invalidation_status = 'local_checkout_blocked',
               updated_at = CURRENT_TIMESTAMP
           WHERE effect_id = ?`,
          [
            cleanString(payment.id, 180) || null,
            cleanString(payment.public_payment_id, 180) || null,
            cleanString(payment.payment_provider, 80) || null,
            Number(payment.amount) || null,
            cleanString(payment.currency, 3) || null,
            cleanEffectId
          ]
        ).catch(() => undefined)
      }
    }
    await db.run(
      `UPDATE conversational_agent_test_payment_links
       SET status = 'failed', claim_token = NULL, lease_until_at = NULL,
           last_error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE effect_id = ? AND status = 'creating' AND claim_token = ?`,
      [cleanString(error?.message || error, 1200), cleanEffectId, claimToken]
    ).catch(() => undefined)
    throw error
  }
}

async function markTestEffectPaid(ledger, payment) {
  const effect = await db.get('SELECT payload_json, status FROM conversational_agent_test_effects WHERE id = ?', [ledger.effect_id])
  if (!effect || effect.status === 'cleaned') return
  const payload = parseJson(effect.payload_json, {})
  await db.run(
    `UPDATE conversational_agent_test_effects
     SET status = 'paid_test', payload_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status IN ('processing', 'prepared', 'recorded', 'paid_test')`,
    [
      JSON.stringify({
        ...payload,
        paymentCreated: true,
        paymentConfirmed: true,
        paymentId: ledger.payment_id,
        publicPaymentId: ledger.public_payment_id,
        provider: ledger.provider,
        paymentMode: 'test',
        paidAt: payment.paid_at || toIso(),
        cleanupDueAt: ledger.cleanup_due_at
      }),
      ledger.effect_id
    ]
  )
}

export async function syncConversationalAgentTestPaymentLink({ effectId, requestedByUserId = '' } = {}) {
  const cleanEffectId = assertIdentifier(effectId, 'El efecto de pago')
  let ledger = await db.get('SELECT * FROM conversational_agent_test_payment_links WHERE effect_id = ?', [cleanEffectId])
  if (!ledger) throw serviceError('El link de prueba no existe.', 404, 'test_payment_link_not_found')
  if (requestedByUserId && cleanString(ledger.requested_by_user_id, 180) !== cleanString(requestedByUserId, 180)) {
    throw serviceError('Este link de prueba pertenece a otro usuario.', 403, 'test_payment_link_forbidden')
  }
  if (!ledger.payment_id || ledger.status === 'cleaned') return publicLedger(ledger)

  const payment = await db.get('SELECT * FROM payments WHERE id = ?', [ledger.payment_id])
  if (!payment) return publicLedger(ledger)
  if (!isTestPaymentRecord(payment) || cleanString(payment.payment_mode, 20).toLowerCase() !== 'test') {
    throw serviceError('La evidencia del proveedor dejó de ser sandbox.', 409, 'test_payment_mode_mismatch')
  }

  const paymentStatus = cleanString(payment.status, 40).toLowerCase()
  const paid = SUCCESS_STATUSES.has(paymentStatus) || Boolean(payment.paid_at)
  if (paid && ledger.status !== 'paid_test') {
    await db.run(
      `UPDATE conversational_agent_test_payment_links
       SET status = 'paid_test', paid_at = COALESCE(?, paid_at),
           last_error = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE effect_id = ? AND status IN ('ready', 'paid_test')`,
      [payment.paid_at || toIso(), cleanEffectId]
    )
    ledger = await db.get('SELECT * FROM conversational_agent_test_payment_links WHERE effect_id = ?', [cleanEffectId])
    await markTestEffectPaid(ledger, payment)
  }
  return publicLedger(ledger)
}

async function claimCleanup(effectId, nowIso, claimToken) {
  const leaseUntilAt = toIso(Date.parse(nowIso) + CLEANUP_LEASE_MS)
  const result = await db.run(
    `UPDATE conversational_agent_test_payment_links
     SET status = 'cleanup_claimed', claim_token = ?, lease_until_at = ?,
         cleanup_attempt_count = cleanup_attempt_count + 1,
         last_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE effect_id = ? AND cleanup_due_at <= ?
       AND (
         status IN ('creating', 'failed', 'ready', 'paid_test', 'cleanup_failed') OR
         (status = 'cleanup_claimed' AND (lease_until_at IS NULL OR lease_until_at <= ?))
       )`,
    [claimToken, leaseUntilAt, effectId, nowIso, nowIso]
  )
  return mutationCount(result) === 1
}

async function blockTestPaymentLocallyWhileProviderCleanupRetries(payment, {
  effectId,
  errorMessage,
  nowIso
} = {}) {
  const metadata = parseJson(payment?.metadata_json, {})
  await db.run(`
    UPDATE payments
    SET status = 'deleted', payment_url = NULL,
        metadata_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND LOWER(COALESCE(payment_mode, '')) IN ('test', 'sandbox')
  `, [
    JSON.stringify({
      ...metadata,
      testPaymentCleanupPending: {
        effectId,
        blockedLocallyAt: nowIso,
        reason: cleanString(errorMessage, 1200)
      }
    }),
    payment.id
  ])
  await db.run(`
    UPDATE conversational_agent_test_payment_links
    SET payment_url = NULL,
        invalidation_status = 'provider_expiration_failed',
        invalidation_error = ?, updated_at = CURRENT_TIMESTAMP
    WHERE effect_id = ?
  `, [cleanString(errorMessage, 1200), effectId])
}

export async function cleanupConversationalAgentTestPaymentLink({
  effectId,
  requestedByUserId = '',
  now = Date.now(),
  force = false,
  claimToken = ''
} = {}) {
  const cleanEffectId = assertIdentifier(effectId, 'El efecto de pago')
  const nowIso = toIso(now)
  let ledger = await db.get('SELECT * FROM conversational_agent_test_payment_links WHERE effect_id = ?', [cleanEffectId])
  if (!ledger) return { cleaned: true, missing: true, effectId: cleanEffectId }
  if (requestedByUserId && cleanString(ledger.requested_by_user_id, 180) !== cleanString(requestedByUserId, 180)) {
    throw serviceError('Este link de prueba pertenece a otro usuario.', 403, 'test_payment_link_forbidden')
  }
  if (ledger.status === 'cleaned') return { cleaned: true, ...publicLedger(ledger) }

  let activeClaimToken = cleanString(claimToken, 180)
  if (!activeClaimToken) {
    activeClaimToken = randomUUID()
    const effectiveNow = force && Date.parse(ledger.cleanup_due_at) > Date.parse(nowIso)
      ? ledger.cleanup_due_at
      : nowIso
    if (!(await claimCleanup(cleanEffectId, effectiveNow, activeClaimToken))) {
      ledger = await db.get('SELECT * FROM conversational_agent_test_payment_links WHERE effect_id = ?', [cleanEffectId])
      if (ledger?.status === 'cleaned') return { cleaned: true, ...publicLedger(ledger) }
      if (!force && Date.parse(ledger?.cleanup_due_at || '') > Date.parse(nowIso)) {
        return { cleaned: false, due: false, ...publicLedger(ledger) }
      }
      throw serviceError('Otro proceso está limpiando este link de prueba.', 409, 'test_payment_cleanup_in_progress')
    }
  } else if (ledger.status !== 'cleanup_claimed' || ledger.claim_token !== activeClaimToken) {
    throw serviceError('Se perdió la reserva de limpieza del link.', 409, 'test_payment_cleanup_claim_lost')
  }

  ledger = await db.get('SELECT * FROM conversational_agent_test_payment_links WHERE effect_id = ?', [cleanEffectId])
  try {
    let invalidationStatus = 'not_needed'
    let invalidationError = ''
    let payment = ledger.payment_id
      ? await db.get('SELECT * FROM payments WHERE id = ?', [ledger.payment_id])
      : null

    // Un crash puede ocurrir después de que el proveedor/servicio inserta el
    // pago pero antes de guardar payment_id en el ledger. Nunca declaramos limpio
    // un efecto sin intentar recuperar ese artefacto durable por su marcador.
    if (!payment) {
      payment = await loadPaymentByEffect(cleanEffectId, ledger.test_run_id)
      if (payment) {
        const rebound = await db.run(
          `UPDATE conversational_agent_test_payment_links
           SET payment_id = ?, public_payment_id = ?, provider = ?, amount = ?,
               currency = ?, payment_url = COALESCE(payment_url, ?),
               invalidation_status = 'artifact_recovered', updated_at = CURRENT_TIMESTAMP
           WHERE effect_id = ? AND status = 'cleanup_claimed' AND claim_token = ?`,
          [
            cleanString(payment.id, 180),
            cleanString(payment.public_payment_id, 180) || null,
            cleanString(payment.payment_provider, 80) || null,
            Number(payment.amount) || null,
            cleanString(payment.currency, 3) || null,
            cleanString(payment.payment_url, 2000) || null,
            cleanEffectId,
            activeClaimToken
          ]
        )
        if (mutationCount(rebound) !== 1) {
          throw serviceError('Se perdió la autorización mientras se recuperaba el pago de prueba.', 409, 'test_payment_cleanup_claim_lost')
        }
        ledger = await db.get('SELECT * FROM conversational_agent_test_payment_links WHERE effect_id = ?', [cleanEffectId])
      }
    }

    if (payment) {
      if (!isTestPaymentRecord(payment) || cleanString(payment.payment_mode, 20).toLowerCase() !== 'test') {
        // Nunca borramos un registro sin evidencia sandbox, pero sí apagamos el
        // checkout local ligado inequívocamente a este efecto para que no cobre.
        if (paymentMatchesEffect(payment, cleanEffectId, ledger.test_run_id)) {
          await db.run(
            `UPDATE payments
             SET status = 'deleted', payment_url = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [payment.id]
          ).catch(() => undefined)
        }
        throw serviceError('Se bloqueó la limpieza porque la fila no demuestra modo test.', 409, 'test_payment_cleanup_live_blocked')
      }

      if (cleanString(payment.payment_provider, 80).toLowerCase() === 'mercadopago' && payment.mercadopago_preference_id) {
        try {
          const expiration = await expireMercadoPagoTestPreferenceImpl(payment, { now: nowIso })
          invalidationStatus = expiration?.expired ? 'provider_expired' : 'provider_not_needed'
        } catch (error) {
          invalidationStatus = 'provider_expiration_failed'
          invalidationError = cleanString(error?.message || error, 1200)
          // El checkout local se apaga de inmediato, pero conservamos preference_id,
          // payment_id y el ledger para reintentar. Declarar cleaned aquí dejaría una
          // preferencia sandbox cobrable sin ninguna referencia durable para borrarla.
          await blockTestPaymentLocallyWhileProviderCleanupRetries(payment, {
            effectId: cleanEffectId,
            errorMessage: invalidationError,
            nowIso
          })
          throw serviceError(
            'Mercado Pago todavía no confirmó la expiración del enlace sandbox; la URL local quedó bloqueada y la limpieza se reintentará.',
            503,
            'test_payment_provider_cleanup_pending'
          )
        }
      }

      const scrubbed = await scrubTestPaymentRecordForCleanupImpl(payment.id, {
        reason: 'conversational_agent_test_cleanup',
        cleanedAt: nowIso
      })
      const deleted = await hardDeleteTestPaymentRecordImpl(payment.id)
      if (deleted?.deleted) {
        invalidationStatus = invalidationStatus === 'provider_expiration_failed' ? invalidationStatus : 'deleted'
      } else if (scrubbed?.scrubbed) {
        invalidationStatus = invalidationStatus === 'provider_expiration_failed' ? invalidationStatus : 'scrubbed'
      } else {
        throw serviceError('No se pudo invalidar la fila local del pago de prueba.', 500, 'test_payment_cleanup_failed')
      }
    }

    await db.run(
      `UPDATE conversational_agent_test_payment_links
       SET status = 'cleaned', payment_url = NULL, cleaned_at = ?,
           claim_token = NULL, lease_until_at = NULL, last_error = NULL,
           invalidation_status = ?, invalidation_error = ?,
           metadata_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE effect_id = ? AND status = 'cleanup_claimed' AND claim_token = ?`,
      [
        nowIso,
        invalidationStatus,
        invalidationError || null,
        JSON.stringify({
          testRunId: ledger.test_run_id,
          testEffectId: ledger.effect_id,
          agentId: ledger.agent_id,
          paymentMode: 'test',
          paymentConfirmed: ledger.status === 'paid_test' || Boolean(ledger.paid_at),
          cleanedAt: nowIso
        }),
        cleanEffectId,
        activeClaimToken
      ]
    )

    const effect = await db.get('SELECT payload_json FROM conversational_agent_test_effects WHERE id = ?', [cleanEffectId])
    if (effect) {
      await db.run(
        `UPDATE conversational_agent_test_effects
         SET status = 'cleaned', cleanup_status = 'cleaned', cleanup_error = NULL,
             cleaned_at = COALESCE(cleaned_at, ?), payload_json = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          nowIso,
          JSON.stringify({
            ...parseJson(effect.payload_json, {}),
            paymentCreated: false,
            linkActive: false,
            paymentMode: 'test',
            cleanedAt: nowIso
          }),
          cleanEffectId
        ]
      )
    }

    return { cleaned: true, ...publicLedger(await db.get('SELECT * FROM conversational_agent_test_payment_links WHERE effect_id = ?', [cleanEffectId])) }
  } catch (error) {
    await db.run(
      `UPDATE conversational_agent_test_payment_links
       SET status = 'cleanup_failed', claim_token = NULL, lease_until_at = NULL,
           last_error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE effect_id = ? AND status = 'cleanup_claimed' AND claim_token = ?`,
      [cleanString(error?.message || error, 1200), cleanEffectId, activeClaimToken]
    ).catch(() => undefined)
    throw error
  }
}

export async function cleanupDueConversationalAgentTestPaymentLinks({ now = Date.now(), limit = 50 } = {}) {
  const nowIso = toIso(now)
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 200))
  const rows = await db.all(
    `SELECT effect_id, status
     FROM conversational_agent_test_payment_links
     WHERE cleanup_due_at <= ?
       AND status IN ('creating', 'failed', 'ready', 'paid_test', 'cleanup_failed', 'cleanup_claimed')
     ORDER BY cleanup_due_at ASC, effect_id ASC
     LIMIT ?`,
    [nowIso, safeLimit]
  )
  const results = []
  for (const row of rows || []) {
    if (!CLEANUP_CANDIDATE_STATUSES.has(row.status) && row.status !== 'cleanup_claimed') continue
    const claimToken = randomUUID()
    if (!(await claimCleanup(row.effect_id, nowIso, claimToken))) continue
    try {
      results.push(await cleanupConversationalAgentTestPaymentLink({
        effectId: row.effect_id,
        now,
        claimToken
      }))
    } catch (error) {
      results.push({ cleaned: false, effectId: row.effect_id, error: cleanString(error?.message || error, 1200) })
    }
  }
  return {
    scanned: (rows || []).length,
    cleaned: results.filter((result) => result.cleaned).length,
    failed: results.filter((result) => !result.cleaned).length,
    results
  }
}

export function setConversationalAgentTestPaymentDependenciesForTests(overrides = null) {
  createPaymentGateLinkImpl = overrides?.createPaymentGateLink || createPaymentGateLink
  hardDeleteTestPaymentRecordImpl = overrides?.hardDeleteTestPaymentRecord || hardDeleteTestPaymentRecord
  scrubTestPaymentRecordForCleanupImpl = overrides?.scrubTestPaymentRecordForCleanup || scrubTestPaymentRecordForCleanup
  expireMercadoPagoTestPreferenceImpl = overrides?.expireMercadoPagoTestPreference || expireMercadoPagoTestPreference
}

export const CONVERSATIONAL_AGENT_TEST_PAYMENT_TTL_MS = TEST_PAYMENT_TTL_MS
