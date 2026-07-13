import { db } from '../config/database.js'
import { createHash } from 'node:crypto'
import {
  createPaymentGateLink,
  getPaymentGateCheckoutKeys,
  normalizePaymentGateConfig
} from './publicPaymentGateService.js'
import {
  conversationalPaymentRequestHash,
  createSinglePaymentLink,
  getHighLevelPaymentLinkMode,
  runIdempotentConversationalPaymentLinkCreation
} from './paymentFlowService.js'
import { businessTodayDateOnly, getAccountTimezone } from '../utils/dateUtils.js'
import { msiEligibility } from '../../../shared/sites/paymentGateContract.js'

const LIVE_GATEWAYS = new Set(['highlevel', 'stripe', 'conekta', 'mercadopago', 'clip', 'rebill'])
const COMPLETED_PAYMENT_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'success', 'fulfilled'])
const REUSABLE_PAYMENT_STATUSES = new Set([
  'draft',
  'created',
  'sent',
  'pending',
  'processing',
  'requires_action',
  'requires_payment_method',
  'open',
  'unpaid',
  'in_process'
])
const REUSABLE_SOURCE_EVENT_TYPES = new Set(['payment_link_created', 'payment_link_reused'])
const CLOSED_PROVIDER_PAYMENT_STATUSES = new Set([
  'paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'captured', 'approved', 'accredited',
  'cancelled', 'canceled', 'cancelled_by_user', 'canceled_by_user', 'expired', 'incomplete_expired', 'abandoned',
  'void', 'voided', 'refunded', 'refund', 'partially_refunded', 'chargeback', 'charged_back',
  'failed', 'failure', 'error', 'declined', 'rejected', 'payment_failed', 'payment_declined', 'card_declined', 'denied'
])
const PAYMENT_SEMANTIC_WAIT_ATTEMPTS = 80
const PAYMENT_SEMANTIC_WAIT_MS = 50
const PAYMENT_SEMANTIC_ORPHAN_LEASE_MS = 30_000

function serviceError(message, status = 409, code = 'conversational_live_payment_invalid') {
  const error = new Error(message)
  error.status = status
  error.statusCode = status
  error.code = code
  return error
}

function cleanString(value, maxLength = 500) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function normalizeCurrency(value) {
  const currency = cleanString(value, 3).toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw serviceError('La moneda autorizada para este cobro no es válida.', 409, 'live_payment_currency_invalid')
  }
  return currency
}

function currencyFractionDigits(currency) {
  try {
    const digits = new Intl.NumberFormat('en', {
      style: 'currency',
      currency
    }).resolvedOptions().maximumFractionDigits
    return Number.isInteger(digits) && digits >= 0 && digits <= 6 ? digits : 2
  } catch {
    return 2
  }
}

export function paymentAmountInMinorUnits(value, currency) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return null
  return Math.round(amount * (10 ** currencyFractionDigits(currency)))
}

function normalizeAmount(value, currency) {
  const minor = paymentAmountInMinorUnits(value, currency)
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw serviceError('El monto autorizado para este cobro no es válido.', 409, 'live_payment_amount_invalid')
  }
  const normalized = minor / (10 ** currencyFractionDigits(currency))
  if (paymentAmountInMinorUnits(Math.fround(normalized), currency) !== minor) {
    throw serviceError(
      'El monto es demasiado grande para conservar todos sus decimales de forma segura. Usa un importe menor o pasa el cobro a revisión humana.',
      409,
      'live_payment_amount_precision_unsafe'
    )
  }
  return normalized
}

export function getConversationalPaymentProviderRawStatus(ledger = {}) {
  const metadata = parseJsonObject(ledger?.metadata_json) || {}
  const provider = cleanString(ledger?.payment_provider, 80).toLowerCase()
  const candidates = provider === 'stripe'
    ? [metadata?.stripe?.status]
    : provider === 'conekta'
      ? [metadata?.conekta?.paymentStatus, metadata?.conekta?.status, metadata?.conekta?.chargeStatus]
      : provider === 'mercadopago'
        ? [metadata?.mercadoPago?.status]
        : provider === 'clip'
          ? [metadata?.clip?.status]
          : provider === 'rebill'
            ? [metadata?.rebill?.status]
            : []
  return cleanString(candidates.find((value) => cleanString(value, 80)), 80)
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

export function conversationalPaymentProviderStatusIsClosed(ledger = {}) {
  const rawStatus = getConversationalPaymentProviderRawStatus(ledger)
  return Boolean(rawStatus && CLOSED_PROVIDER_PAYMENT_STATUSES.has(rawStatus))
}

export function conversationalPaymentStatusIsReusable(value) {
  return REUSABLE_PAYMENT_STATUSES.has(cleanString(value, 40).toLowerCase())
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = value ? JSON.parse(value) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key])
    return result
  }, {})
}

function stableJson(value) {
  return JSON.stringify(stableValue(value ?? null))
}

function reusablePaymentIdentity(payload = {}) {
  const currency = cleanString(payload.currency, 3).toUpperCase()
  const amountMinor = /^[A-Z]{3}$/.test(currency)
    ? paymentAmountInMinorUnits(payload.amount, currency)
    : null
  const productId = cleanString(payload.productId, 180)
  const priceId = cleanString(payload.priceId, 180)
  const concept = cleanString(payload.concept, 300)
  const identity = {
    agentId: cleanString(payload.agentId, 180),
    contactId: cleanString(payload.contactId, 180),
    gateway: cleanString(payload.gateway, 80).toLowerCase(),
    amountMinor,
    currency,
    channel: cleanString(payload.channel, 40).toLowerCase(),
    paymentPurpose: cleanString(payload.paymentPurpose, 80).toLowerCase(),
    afterPayment: payload.afterPayment === 'handoff' ? 'handoff' : 'continue',
    productId,
    priceId,
    // Un producto/precio tiene identidad propia. Los cobros directos y anticipos
    // sin catálogo necesitan también el concepto para no mezclar dos motivos.
    directConcept: productId || priceId ? '' : concept,
    installments: stableJson(payload.installments || { enabled: false, maxInstallments: 0 }),
    appointmentSelectionEventId: cleanString(payload.appointmentSelectionEventId, 180),
    appointmentSelectionCalendarId: cleanString(payload.appointmentSelectionCalendarId, 180),
    appointmentSelectionStartTime: cleanString(payload.appointmentSelectionStartTime, 100),
    appointmentSelectionRequestDraftHash: cleanString(payload.appointmentSelectionRequestDraftHash, 180),
    appointmentSelectionBookingOwner: cleanString(payload.appointmentSelectionBookingOwner, 40).toLowerCase(),
    appointmentSelectionTerminalToolName: cleanString(payload.appointmentSelectionTerminalToolName, 80),
    appointmentDepositIntentEventId: cleanString(payload.appointmentDepositIntentEventId, 180)
  }
  if (
    !identity.agentId ||
    !identity.contactId ||
    !LIVE_GATEWAYS.has(identity.gateway) ||
    !Number.isSafeInteger(identity.amountMinor) ||
    identity.amountMinor <= 0 ||
    !identity.currency ||
    !identity.paymentPurpose ||
    (!identity.productId && !identity.priceId && !identity.directConcept)
  ) {
    return null
  }
  if (Boolean(identity.productId) !== Boolean(identity.priceId)) return null
  return identity
}

function reusablePaymentIdentitiesMatch(left, right) {
  if (!left || !right) return false
  return Object.keys(left).every((key) => left[key] === right[key])
}

export async function conversationalPaymentLinkIsStillValid(dueDate, now = Date.now()) {
  const value = cleanString(dueDate, 100)
  if (!value) return false
  const nowMs = now instanceof Date ? now.getTime() : Number(now)
  if (!Number.isFinite(nowMs)) return false
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const timezone = await getAccountTimezone().catch(() => '')
    if (!timezone) return false
    return value >= businessTodayDateOnly(timezone, new Date(nowMs))
  }
  const normalizedInstant = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const expirationMs = Date.parse(normalizedInstant)
  return Number.isFinite(expirationMs) && expirationMs > nowMs
}

function buildReusablePaymentResult({ row, request, payload, gateway } = {}) {
  const externalIdentity = gateway === 'highlevel'
    ? cleanString(row.ghl_invoice_id, 180)
    : cleanString(row.public_payment_id, 180)
  return {
    ledgerPaymentId: cleanString(row.id, 180),
    invoiceId: externalIdentity,
    publicPaymentId: cleanString(row.public_payment_id, 180) || null,
    paymentLink: cleanString(row.payment_url, 2000),
    amount: Number(row.amount),
    currency: cleanString(row.currency, 3).toUpperCase(),
    status: cleanString(row.status, 40).toLowerCase(),
    provider: gateway,
    paymentMode: 'live',
    expiresAt: cleanString(row.due_date, 100),
    sendMethod: 'chat_reply',
    paymentConfirmed: false,
    reused: true,
    durableReplay: true,
    crossTurnReuse: true,
    canonicalPaymentLinkRequestKey: cleanString(row.idempotency_key, 180),
    canonicalBindingEventId: cleanString(row.binding_event_id, 180),
    expirationMinutes: Number(request.expirationMinutes) || null,
    installments: request.installments || { enabled: false, maxInstallments: 0 },
    // Un link reutilizado conserva el contrato durable con el que fue creado.
    // Nunca dejamos que el borrador actual cambie qué ocurre después de pagar.
    afterPayment: request.afterPayment === 'handoff' ? 'handoff' : 'continue'
  }
}

async function inspectReusablePaymentRow({ row, expectedIdentity, gateway, payload, now = Date.now() } = {}) {
  const request = parseJsonObject(row?.request_json)
  const eventDetail = parseJsonObject(row?.event_detail_json)
  if (!request || !eventDetail) return { state: 'invalid' }
  if (conversationalPaymentRequestHash(request) !== row.request_hash) return { state: 'invalid' }
  if (!reusablePaymentIdentitiesMatch(expectedIdentity, reusablePaymentIdentity(request))) return { state: 'invalid' }

  const rowCurrency = cleanString(row.currency, 3).toUpperCase()
  const rowStatus = cleanString(row.status, 40).toLowerCase()
  const externalIdentity = gateway === 'highlevel'
    ? cleanString(row.ghl_invoice_id, 180)
    : cleanString(row.public_payment_id, 180)
  const eventAmountMinor = paymentAmountInMinorUnits(eventDetail.amount, rowCurrency)
  const exactLedger = Boolean(
    cleanString(row.contact_id, 180) === expectedIdentity.contactId &&
    cleanString(row.event_contact_id, 180) === expectedIdentity.contactId &&
    cleanString(row.event_agent_id, 180) === expectedIdentity.agentId &&
    REUSABLE_SOURCE_EVENT_TYPES.has(cleanString(row.event_type, 80)) &&
    cleanString(row.payment_link_request_key, 180) === cleanString(row.idempotency_key, 180) &&
    cleanString(row.payment_provider, 80).toLowerCase() === gateway &&
    cleanString(row.payment_mode, 40).toLowerCase() === 'live' &&
    rowCurrency === expectedIdentity.currency &&
    paymentAmountInMinorUnits(row.amount, rowCurrency) === expectedIdentity.amountMinor &&
    cleanString(eventDetail.ledgerPaymentId, 180) === cleanString(row.id, 180) &&
    cleanString(eventDetail.paymentProvider, 80).toLowerCase() === gateway &&
    cleanString(eventDetail.paymentEnvironment, 40).toLowerCase() === 'live' &&
    cleanString(eventDetail.paymentPurpose, 80).toLowerCase() === expectedIdentity.paymentPurpose &&
    (eventDetail.afterPayment === 'handoff' ? 'handoff' : 'continue') === expectedIdentity.afterPayment &&
    cleanString(eventDetail.currency, 3).toUpperCase() === rowCurrency &&
    eventAmountMinor === expectedIdentity.amountMinor &&
    externalIdentity &&
    cleanString(row.payment_url, 2000)
  )
  if (!exactLedger) return { state: 'invalid' }
  if (
    !conversationalPaymentStatusIsReusable(rowStatus) ||
    conversationalPaymentProviderStatusIsClosed(row) ||
    !(await conversationalPaymentLinkIsStillValid(row.due_date, now))
  ) return { state: 'closed' }
  return {
    state: 'reusable',
    reusable: buildReusablePaymentResult({ row, request, payload, gateway })
  }
}

async function findReusableConversationalLivePaymentLink({
  contactId,
  gateway,
  idempotencyKey,
  payload,
  now = Date.now()
} = {}) {
  const expectedIdentity = reusablePaymentIdentity(payload)
  const cleanContactId = cleanString(contactId, 180)
  const cleanGateway = cleanString(gateway, 80).toLowerCase()
  const cleanCurrentKey = cleanString(idempotencyKey, 180)
  if (!expectedIdentity || !cleanContactId || cleanContactId !== expectedIdentity.contactId || cleanGateway !== expectedIdentity.gateway) {
    return null
  }

  const candidates = await db.all(
    `SELECT r.idempotency_key, r.request_hash, r.request_json, r.binding_event_id,
            e.contact_id AS event_contact_id, e.agent_id AS event_agent_id,
            e.event_type, e.detail_json AS event_detail_json,
            p.id, p.contact_id, p.amount, p.currency, p.status, p.payment_mode,
            p.payment_provider, p.ghl_invoice_id, p.public_payment_id,
            p.payment_url, p.payment_link_request_key, p.due_date, p.sent_at,
            p.metadata_json
       FROM conversational_payment_link_requests r
       INNER JOIN conversational_agent_events e ON e.id = r.binding_event_id
       INNER JOIN payments p ON p.payment_link_request_key = r.idempotency_key
      WHERE r.contact_id = ?
        AND r.idempotency_key <> ?
        AND r.status = 'completed'
        AND r.binding_status = 'bound'
      ORDER BY COALESCE(r.bound_at, r.updated_at, r.created_at) DESC
      LIMIT 80`,
    [cleanContactId, cleanCurrentKey]
  )

  for (const row of candidates) {
    const inspected = await inspectReusablePaymentRow({ row, expectedIdentity, gateway: cleanGateway, payload, now })
    if (inspected.state === 'reusable') return inspected.reusable
  }
  return null
}

async function ensureConversationalPaymentSemanticClaims() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS conversational_payment_semantic_claims (
      semantic_key TEXT PRIMARY KEY,
      identity_hash TEXT NOT NULL,
      owner_request_key TEXT NOT NULL,
      canonical_request_key TEXT,
      status TEXT NOT NULL DEFAULT 'processing',
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_conversational_payment_semantic_claim_owner
    ON conversational_payment_semantic_claims(owner_request_key, status)
  `)
}

function semanticPaymentClaimIdentity(payload = {}) {
  const identity = reusablePaymentIdentity(payload)
  if (!identity) {
    throw serviceError('El cobro no conserva identidad suficiente para reservarlo de forma segura.', 409, 'live_payment_semantic_identity_invalid')
  }
  const identityHash = createHash('sha256').update(stableJson(identity)).digest('hex')
  return {
    identity,
    identityHash,
    semanticKey: `conv-payment-semantic:${identityHash}`
  }
}

async function loadCanonicalSemanticPaymentRow(canonicalRequestKey) {
  return db.get(
    `SELECT r.idempotency_key, r.request_hash, r.request_json, r.binding_event_id,
            e.contact_id AS event_contact_id, e.agent_id AS event_agent_id,
            e.event_type, e.detail_json AS event_detail_json,
            p.id, p.contact_id, p.amount, p.currency, p.status, p.payment_mode,
            p.payment_provider, p.ghl_invoice_id, p.public_payment_id,
            p.payment_url, p.payment_link_request_key, p.due_date, p.sent_at,
            p.metadata_json
       FROM conversational_payment_link_requests r
       INNER JOIN conversational_agent_events e ON e.id = r.binding_event_id
       INNER JOIN payments p ON p.payment_link_request_key = r.idempotency_key
      WHERE r.idempotency_key = ?
        AND r.status = 'completed'
        AND r.binding_status = 'bound'
      LIMIT 1`,
    [cleanString(canonicalRequestKey, 180)]
  )
}

async function inspectCanonicalSemanticPayment({ canonicalRequestKey, payload, gateway, now = Date.now() } = {}) {
  const expectedIdentity = reusablePaymentIdentity(payload)
  if (!expectedIdentity) return { state: 'invalid' }
  const row = await loadCanonicalSemanticPaymentRow(canonicalRequestKey)
  if (!row) return { state: 'invalid' }
  return inspectReusablePaymentRow({
    row,
    expectedIdentity,
    gateway: cleanString(gateway, 80).toLowerCase(),
    payload,
    now
  })
}

async function sealConversationalPaymentSemanticClaim({ claim, canonicalRequestKey } = {}) {
  const nowIso = new Date().toISOString()
  const updated = await db.run(
    `UPDATE conversational_payment_semantic_claims
        SET canonical_request_key = ?, status = 'bound', error_message = NULL, updated_at = ?
      WHERE semantic_key = ? AND identity_hash = ? AND status IN ('processing', 'bound')`,
    [cleanString(canonicalRequestKey, 180), nowIso, claim.semanticKey, claim.identityHash]
  )
  if (Number(updated?.changes ?? updated?.rowCount ?? 0) !== 1) {
    throw serviceError('La reserva financiera cambió antes de sellar el link canónico.', 409, 'live_payment_semantic_claim_changed')
  }
}

async function failConversationalPaymentSemanticClaim({ claim, requestKey, error } = {}) {
  const message = cleanString(error?.message || error || 'El intento financiero quedó bloqueado.', 1200)
  await db.run(
    `UPDATE conversational_payment_semantic_claims
        SET status = 'failed', error_message = ?, updated_at = ?
      WHERE semantic_key = ? AND identity_hash = ? AND owner_request_key = ? AND status = 'processing'`,
    [message, new Date().toISOString(), claim.semanticKey, claim.identityHash, requestKey]
  ).catch(() => {})
}

async function releaseUnusedConversationalPaymentSemanticClaim({ claim, requestKey } = {}) {
  const request = await db.get(
    'SELECT status FROM conversational_payment_link_requests WHERE idempotency_key = ?',
    [requestKey]
  )
  if (request) return false
  const deleted = await db.run(
    `DELETE FROM conversational_payment_semantic_claims
      WHERE semantic_key = ? AND identity_hash = ? AND owner_request_key = ? AND status = 'processing'`,
    [claim.semanticKey, claim.identityHash, requestKey]
  )
  return Number(deleted?.changes ?? deleted?.rowCount ?? 0) === 1
}

async function assertConversationalPaymentSemanticClaimOwner({ claim, requestKey } = {}) {
  const stored = await db.get(
    `SELECT owner_request_key, status
     FROM conversational_payment_semantic_claims
     WHERE semantic_key = ? AND identity_hash = ?`,
    [claim.semanticKey, claim.identityHash]
  )
  if (
    !stored ||
    stored.status !== 'processing' ||
    cleanString(stored.owner_request_key, 180) !== cleanString(requestKey, 180)
  ) {
    throw serviceError(
      'Otro intento seguro tomó el control de este mismo cobro. No se llamó a la pasarela desde este intento.',
      409,
      'live_payment_semantic_claim_lost'
    )
  }
}

async function reserveConversationalPaymentSemanticClaim({ payload, requestKey, gateway, now = Date.now() } = {}) {
  const claim = semanticPaymentClaimIdentity(payload)
  await ensureConversationalPaymentSemanticClaims()
  const createdAt = new Date().toISOString()
  const inserted = await db.run(
    `INSERT INTO conversational_payment_semantic_claims (
       semantic_key, identity_hash, owner_request_key, status, created_at, updated_at
     ) VALUES (?, ?, ?, 'processing', ?, ?)
     ON CONFLICT(semantic_key) DO NOTHING`,
    [claim.semanticKey, claim.identityHash, requestKey, createdAt, createdAt]
  )
  if (Number(inserted?.changes ?? inserted?.rowCount ?? 0) === 1) {
    return { ...claim, owner: true, reusable: null }
  }

  for (let attempt = 0; attempt < PAYMENT_SEMANTIC_WAIT_ATTEMPTS; attempt += 1) {
    const stored = await db.get(
      `SELECT semantic_key, identity_hash, owner_request_key, canonical_request_key,
              status, error_message, created_at, updated_at
       FROM conversational_payment_semantic_claims WHERE semantic_key = ?`,
      [claim.semanticKey]
    )
    if (!stored || stored.identity_hash !== claim.identityHash) {
      throw serviceError('La reserva semántica del cobro perdió su identidad.', 503, 'live_payment_semantic_claim_invalid')
    }
    if (stored.owner_request_key === requestKey && ['processing', 'bound'].includes(stored.status)) {
      return { ...claim, owner: true, reusable: null }
    }
    if (stored.status === 'failed') {
      throw serviceError(
        stored.error_message || 'Un intento equivalente quedó bloqueado para evitar un segundo cobro.',
        409,
        'live_payment_semantic_previous_attempt_failed'
      )
    }

    let canonicalRequestKey = cleanString(stored.canonical_request_key, 180)
    if (!canonicalRequestKey) {
      const ownerRequest = await db.get(
        `SELECT status, binding_status FROM conversational_payment_link_requests
         WHERE idempotency_key = ?`,
        [stored.owner_request_key]
      )
      if (!ownerRequest) {
        const updatedAtMs = Date.parse(stored.updated_at || stored.created_at || '')
        if (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs >= PAYMENT_SEMANTIC_ORPHAN_LEASE_MS) {
          const rotated = await db.run(
            `UPDATE conversational_payment_semantic_claims
                SET owner_request_key = ?, canonical_request_key = NULL, status = 'processing',
                    error_message = NULL, updated_at = ?
              WHERE semantic_key = ? AND identity_hash = ?
                AND owner_request_key = ? AND status = 'processing' AND updated_at = ?`,
            [
              requestKey,
              new Date().toISOString(),
              claim.semanticKey,
              claim.identityHash,
              stored.owner_request_key,
              stored.updated_at
            ]
          )
          if (Number(rotated?.changes ?? rotated?.rowCount ?? 0) === 1) {
            return { ...claim, owner: true, reusable: null, recoveredOrphan: true }
          }
          continue
        }
      }
      if (ownerRequest?.status === 'failed' || ownerRequest?.binding_status === 'failed') {
        await failConversationalPaymentSemanticClaim({ claim, requestKey: stored.owner_request_key, error: 'El intento canónico equivalente falló y quedó bloqueado.' })
        continue
      }
      if (ownerRequest?.status === 'completed' && ownerRequest?.binding_status === 'bound') {
        canonicalRequestKey = cleanString(stored.owner_request_key, 180)
      }
    }

    if (canonicalRequestKey) {
      const inspected = await inspectCanonicalSemanticPayment({ canonicalRequestKey, payload, gateway, now })
      if (inspected.state === 'reusable') {
        await sealConversationalPaymentSemanticClaim({ claim, canonicalRequestKey })
        return { ...claim, owner: false, reusable: inspected.reusable }
      }
      if (inspected.state === 'closed') {
        const rotated = await db.run(
          `UPDATE conversational_payment_semantic_claims
              SET owner_request_key = ?, canonical_request_key = NULL, status = 'processing',
                  error_message = NULL, updated_at = ?
            WHERE semantic_key = ? AND identity_hash = ?
              AND owner_request_key = ? AND status IN ('processing', 'bound')`,
          [requestKey, new Date().toISOString(), claim.semanticKey, claim.identityHash, stored.owner_request_key]
        )
        if (Number(rotated?.changes ?? rotated?.rowCount ?? 0) === 1) {
          return { ...claim, owner: true, reusable: null }
        }
        continue
      }
      throw serviceError('El cobro canónico equivalente perdió su ledger verificable.', 503, 'live_payment_semantic_canonical_invalid')
    }

    await new Promise((resolve) => setTimeout(resolve, PAYMENT_SEMANTIC_WAIT_MS))
  }

  throw serviceError(
    'Ya se está preparando un cobro equivalente. No se creará otro link; vuelve a consultar el mismo cobro en un momento.',
    409,
    'live_payment_semantic_claim_in_progress'
  )
}

async function recordCrossTurnConversationalPaymentReuse({
  idempotencyKey,
  payload,
  reusable,
  now = Date.now()
} = {}) {
  const cleanKey = cleanString(idempotencyKey, 180)
  const canonicalBindingEventId = cleanString(reusable?.canonicalBindingEventId, 180)
  const canonicalRequestKey = cleanString(reusable?.canonicalPaymentLinkRequestKey, 180)
  if (!cleanKey || !canonicalBindingEventId || !canonicalRequestKey || cleanKey === canonicalRequestKey) {
    throw serviceError('El link reutilizable no conserva una identidad durable válida.', 503, 'live_payment_reuse_identity_invalid')
  }

  const gateway = cleanString(payload?.gateway, 80).toLowerCase()
  const before = await inspectCanonicalSemanticPayment({ canonicalRequestKey, payload, gateway, now })
  if (before.state !== 'reusable') {
    throw serviceError('El link canónico cambió de estado o venció antes de reutilizarse.', 409, 'live_payment_reuse_no_longer_valid')
  }
  reusable = before.reusable

  const result = await dependencies.runIdempotentConversationalPaymentLinkCreation({
    idempotencyKey: cleanKey,
    payload,
    create: async () => ({ ...reusable, reused: true, durableReplay: true, crossTurnReuse: true })
  })
  if (result?.crossTurnReuse !== true) return result

  const boundAt = new Date().toISOString()
  await db.run(
    `UPDATE conversational_payment_link_requests
        SET binding_event_id = ?, binding_status = 'bound', binding_error = NULL,
            bound_at = COALESCE(bound_at, ?), updated_at = ?
      WHERE idempotency_key = ? AND status = 'completed'`,
    [canonicalBindingEventId, boundAt, boundAt, cleanKey]
  )
  const alias = await db.get(
    `SELECT request_hash, request_json, status, binding_event_id, binding_status
       FROM conversational_payment_link_requests WHERE idempotency_key = ?`,
    [cleanKey]
  )
  const aliasRequest = parseJsonObject(alias?.request_json)
  if (
    !alias ||
    alias.status !== 'completed' ||
    alias.binding_status !== 'bound' ||
    cleanString(alias.binding_event_id, 180) !== canonicalBindingEventId ||
    !aliasRequest ||
    conversationalPaymentRequestHash(aliasRequest) !== alias.request_hash ||
    !reusablePaymentIdentitiesMatch(reusablePaymentIdentity(aliasRequest), reusablePaymentIdentity(payload))
  ) {
    throw serviceError('No se pudo sellar la reutilización segura del link.', 503, 'live_payment_reuse_ledger_invalid')
  }
  const after = await inspectCanonicalSemanticPayment({ canonicalRequestKey, payload, gateway, now })
  if (after.state !== 'reusable') {
    throw serviceError('El link canónico cambió de estado o venció antes de sellar su reutilización.', 409, 'live_payment_reuse_no_longer_valid')
  }
  return result
}

function normalizeInstallments(value = {}) {
  const enabled = value?.enabled === true
  const maxInstallments = Math.trunc(Number(value?.maxInstallments || 0))
  if (!enabled || maxInstallments <= 1) return { enabled: false, maxInstallments: 0 }
  if (![3, 6, 9, 12, 18, 24].includes(maxInstallments)) {
    throw serviceError('La configuración de meses sin intereses no es válida.', 409, 'live_payment_installments_invalid')
  }
  return { enabled: true, maxInstallments }
}

function normalizeExpirationMinutes(value) {
  const parsed = Math.round(Number(value))
  if (!Number.isFinite(parsed) || parsed < 5 || parsed > 7 * 24 * 60) {
    throw serviceError('La vigencia configurada para el enlace no es válida.', 409, 'live_payment_expiration_invalid')
  }
  return parsed
}

function buildExpirationIso(expirationMinutes, now = Date.now()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now)
  if (!Number.isFinite(nowMs)) {
    throw serviceError('No se pudo calcular la vigencia segura del enlace.', 500, 'live_payment_clock_invalid')
  }
  return new Date(nowMs + expirationMinutes * 60 * 1000).toISOString()
}

async function loadExactPaymentLedger({
  contactId,
  gateway,
  idempotencyKey,
  result
} = {}) {
  const cleanContactId = cleanString(contactId, 180)
  const cleanRequestKey = cleanString(idempotencyKey, 180)
  if (gateway === 'highlevel') {
    const invoiceId = cleanString(result?.invoiceId, 180)
    if (!invoiceId) return null
    return db.get(
      `SELECT id, contact_id, amount, currency, status, payment_mode, payment_provider,
              ghl_invoice_id, public_payment_id, payment_url, payment_link_request_key,
              due_date, sent_at, metadata_json
       FROM payments
       WHERE contact_id = ?
         AND payment_link_request_key = ?
         AND (id = ? OR ghl_invoice_id = ?)
       LIMIT 1`,
      [cleanContactId, cleanRequestKey, invoiceId, invoiceId]
    )
  }

  const publicPaymentId = cleanString(result?.publicPaymentId || result?.payment?.publicPaymentId, 180)
  if (!publicPaymentId) return null
  return db.get(
    `SELECT id, contact_id, amount, currency, status, payment_mode, payment_provider,
            ghl_invoice_id, public_payment_id, payment_url, payment_link_request_key,
            due_date, sent_at, metadata_json
     FROM payments
     WHERE contact_id = ?
       AND payment_link_request_key = ?
       AND public_payment_id = ?
     LIMIT 1`,
    [cleanContactId, cleanRequestKey, publicPaymentId]
  )
}

let dependencies = {
  createPaymentGateLink,
  getPaymentGateCheckoutKeys,
  normalizePaymentGateConfig,
  createSinglePaymentLink,
  getHighLevelPaymentLinkMode,
  runIdempotentConversationalPaymentLinkCreation,
  loadExactPaymentLedger,
  findReusableConversationalLivePaymentLink,
  recordCrossTurnConversationalPaymentReuse
}

function assertExactLiveLedger({
  ledger,
  result,
  contactId,
  gateway,
  amount,
  currency,
  idempotencyKey,
  expiresAt
} = {}) {
  if (!ledger?.id) {
    throw serviceError(
      'El proveedor respondió, pero no existe el registro exacto del cobro. No se entregará el enlace.',
      503,
      'live_payment_ledger_missing'
    )
  }

  const resultPaymentId = cleanString(result?.payment?.id, 180)
  const resultPublicPaymentId = cleanString(result?.publicPaymentId || result?.payment?.publicPaymentId, 180)
  const ledgerProvider = cleanString(ledger.payment_provider, 80).toLowerCase()
  const ledgerCurrency = cleanString(ledger.currency, 3).toUpperCase()
  const ledgerMode = cleanString(ledger.payment_mode, 40).toLowerCase()
  const expectedMinor = paymentAmountInMinorUnits(amount, currency)
  const ledgerMinor = paymentAmountInMinorUnits(ledger.amount, ledgerCurrency)
  const expirationMatches = gateway === 'highlevel'
    ? Boolean(cleanString(ledger.due_date, 80)) && Number.isFinite(Date.parse(ledger.due_date))
    : Number.isFinite(Date.parse(ledger.due_date)) && Date.parse(ledger.due_date) === Date.parse(expiresAt)
  const exact = Boolean(
    cleanString(ledger.contact_id, 180) === cleanString(contactId, 180) &&
    cleanString(ledger.payment_link_request_key, 180) === cleanString(idempotencyKey, 180) &&
    ledgerProvider === gateway &&
    ledgerCurrency === currency &&
    Number.isSafeInteger(expectedMinor) &&
    ledgerMinor === expectedMinor &&
    ledgerMode === 'live' &&
    cleanString(ledger.payment_url, 2000) &&
    expirationMatches &&
    (!resultPaymentId || resultPaymentId === cleanString(ledger.id, 180)) &&
    (gateway === 'highlevel'
      ? cleanString(result?.invoiceId, 180) === cleanString(ledger.ghl_invoice_id || ledger.id, 180)
      : resultPublicPaymentId && resultPublicPaymentId === cleanString(ledger.public_payment_id, 180))
  )

  if (!exact) {
    throw serviceError(
      'El registro creado no coincide exactamente con la pasarela, monto, moneda o modo en vivo autorizados. No se entregará el enlace.',
      503,
      'live_payment_ledger_mismatch'
    )
  }

  return {
    ledgerPaymentId: cleanString(ledger.id, 180),
    invoiceId: gateway === 'highlevel'
      ? cleanString(ledger.ghl_invoice_id || ledger.id, 180)
      : cleanString(ledger.public_payment_id, 180),
    publicPaymentId: cleanString(ledger.public_payment_id, 180) || null,
    paymentLink: cleanString(ledger.payment_url, 2000),
    amount: Number(ledger.amount),
    currency: ledgerCurrency,
    status: cleanString(ledger.status, 40).toLowerCase() || 'sent',
    provider: ledgerProvider,
    paymentMode: ledgerMode,
    expiresAt: gateway === 'highlevel' ? cleanString(ledger.due_date, 80) || expiresAt : expiresAt,
    sendMethod: gateway === 'highlevel'
      ? (cleanString(result?.sendMethod, 40) || 'none')
      : 'chat_reply',
    paymentConfirmed: COMPLETED_PAYMENT_STATUSES.has(cleanString(ledger.status, 40).toLowerCase())
  }
}

async function assertGatewayReadyForLive(gateway) {
  if (gateway === 'highlevel') {
    const mode = cleanString(await dependencies.getHighLevelPaymentLinkMode(), 40).toLowerCase()
    if (mode !== 'live') {
      throw serviceError(
        'HighLevel está en modo prueba. El agente en vivo no puede crear ni entregar ese cobro.',
        409,
        'live_payment_gateway_not_live'
      )
    }
    return
  }

  const config = await dependencies.getPaymentGateCheckoutKeys(gateway)
  if (cleanString(config?.provider, 80).toLowerCase() !== gateway) {
    throw serviceError('La pasarela respondió con otra identidad. No se creó ningún cobro.', 503, 'live_payment_gateway_identity_mismatch')
  }
  if (!config?.configured) {
    throw serviceError('La pasarela elegida no está conectada. No se creó ningún cobro.', 409, 'live_payment_gateway_not_configured')
  }
  if (cleanString(config?.paymentMode, 40).toLowerCase() !== 'live') {
    throw serviceError(
      'La pasarela elegida está en modo prueba. El agente en vivo no puede crear ni entregar ese cobro.',
      409,
      'live_payment_gateway_not_live'
    )
  }
}

export async function createConversationalAgentLivePaymentLink({
  contact = {},
  gateway,
  amount,
  currency,
  concept = 'Pago',
  installments = {},
  expirationMinutes = 60,
  afterPayment = 'continue',
  idempotencyKey,
  idempotencyPayload = {},
  reuseOnly = false,
  source = 'conversational_agent_v2',
  channels = {},
  now = Date.now()
} = {}) {
  const selectedGateway = cleanString(gateway, 80).toLowerCase()
  if (!LIVE_GATEWAYS.has(selectedGateway)) {
    throw serviceError('La pasarela seleccionada no es compatible con el cobro del agente.', 409, 'live_payment_gateway_invalid')
  }
  const contactId = cleanString(contact?.id, 180)
  if (!contactId) {
    throw serviceError('No existe el contacto interno del chat para crear el cobro.', 409, 'live_payment_contact_missing')
  }
  const normalizedCurrency = normalizeCurrency(currency)
  const normalizedAmount = normalizeAmount(amount, normalizedCurrency)
  const normalizedInstallments = normalizeInstallments(installments)
  const normalizedExpirationMinutes = normalizeExpirationMinutes(expirationMinutes)
  // HighLevel necesita la fecha antes de entrar a su flujo propio. Para las
  // demás pasarelas, sólo el ganador de la reserva idempotente la calcula; los
  // reintentos recuperan el vencimiento canónico ya guardado en el resultado.
  const expiresAt = selectedGateway === 'highlevel'
    ? buildExpirationIso(normalizedExpirationMinutes, now)
    : null
  const requestKey = cleanString(idempotencyKey, 180)
  if (!requestKey) {
    throw serviceError('Falta la llave durable de este cobro.', 400, 'live_payment_idempotency_missing')
  }

  if (selectedGateway === 'highlevel' && normalizedInstallments.enabled) {
    throw serviceError(
      'HighLevel no permite fijar un máximo real de meses sin intereses en su API de invoices. Elige otra pasarela o desactiva MSI antes de cobrar.',
      409,
      'live_payment_highlevel_msi_unsupported'
    )
  }
  if (selectedGateway === 'highlevel' && normalizedExpirationMinutes < 24 * 60) {
    throw serviceError(
      'HighLevel maneja el vencimiento por fecha. Configura al menos 24 horas antes de crear la invoice.',
      409,
      'live_payment_highlevel_expiration_unsupported'
    )
  }
  if (selectedGateway !== 'highlevel' && normalizedInstallments.enabled) {
    const eligibility = msiEligibility({
      gateway: selectedGateway,
      currency: normalizedCurrency,
      amount: normalizedAmount,
      msi: normalizedInstallments
    })
    const supported = Boolean(
      eligibility.insideElement ||
      eligibility.insideBrick ||
      eligibility.hostedRedirect ||
      eligibility.standaloneMonths?.length
    ) && (
      selectedGateway !== 'conekta' ||
      eligibility.standaloneMonths?.includes(normalizedInstallments.maxInstallments)
    )
    if (!supported) {
      throw serviceError(
        'La pasarela, moneda o monto elegidos no permiten los meses configurados. No se creará un link sin MSI en silencio.',
        409,
        'live_payment_msi_not_eligible'
      )
    }
  }

  const durablePayload = {
    ...idempotencyPayload,
    contactId,
    gateway: selectedGateway,
    amount: normalizedAmount,
    currency: normalizedCurrency,
    concept: cleanString(concept, 300) || 'Pago',
    installments: normalizedInstallments,
    expirationMinutes: normalizedExpirationMinutes,
    afterPayment: afterPayment === 'handoff' ? 'handoff' : 'continue'
  }

  const semanticClaim = await reserveConversationalPaymentSemanticClaim({
    payload: durablePayload,
    requestKey,
    gateway: selectedGateway,
    now
  })
  let result = null
  let reusable = semanticClaim.reusable
  if (!reusable) {
    try {
      reusable = await dependencies.findReusableConversationalLivePaymentLink({
        contactId,
        gateway: selectedGateway,
        idempotencyKey: requestKey,
        payload: durablePayload,
        now
      })
    } catch (error) {
      if (semanticClaim.owner) await releaseUnusedConversationalPaymentSemanticClaim({ claim: semanticClaim, requestKey }).catch(() => {})
      throw error
    }
  }
  if (reusable) {
    result = await dependencies.recordCrossTurnConversationalPaymentReuse({
      idempotencyKey: requestKey,
      payload: durablePayload,
      reusable,
      now
    })
    if (result?.crossTurnReuse === true) {
      await sealConversationalPaymentSemanticClaim({
        claim: semanticClaim,
        canonicalRequestKey: result.canonicalPaymentLinkRequestKey
      })
      return result
    }
  }

  if (!result && reuseOnly === true) {
    if (semanticClaim.owner) await releaseUnusedConversationalPaymentSemanticClaim({ claim: semanticClaim, requestKey }).catch(() => {})
    throw serviceError(
      'El anticipo ya está ligado a un cobro anterior, pero ese link dejó de ser reutilizable. No se creará otro cobro sin volver a confirmar el horario.',
      409,
      'live_payment_reusable_link_not_found'
    )
  }

  if (!result) {
    try {
      await assertGatewayReadyForLive(selectedGateway)
      if (selectedGateway === 'highlevel') {
        result = await dependencies.createSinglePaymentLink({
          contact,
          amount: normalizedAmount,
          currency: normalizedCurrency,
          description: durablePayload.concept,
          concept: durablePayload.concept,
          title: durablePayload.concept,
          dueDate: expiresAt,
          channels,
          source,
          idempotencyKey: requestKey,
          idempotencyPayload: durablePayload,
          beforeCreate: () => assertConversationalPaymentSemanticClaimOwner({ claim: semanticClaim, requestKey })
        })
      } else {
        result = await dependencies.runIdempotentConversationalPaymentLinkCreation({
          idempotencyKey: requestKey,
          payload: durablePayload,
          beforeCreate: () => assertConversationalPaymentSemanticClaimOwner({ claim: semanticClaim, requestKey }),
          create: async () => {
            const canonicalExpiresAt = buildExpirationIso(normalizedExpirationMinutes, now)
            const gateConfig = dependencies.normalizePaymentGateConfig({
              enabled: true,
              gateway: selectedGateway,
              billingType: 'single',
              amount: normalizedAmount,
              currency: normalizedCurrency,
              productName: durablePayload.concept,
              description: durablePayload.concept,
              mode: 'inherit',
              msi: normalizedInstallments
            })
            if (gateConfig.gateway !== selectedGateway || gateConfig.billingType !== 'single') {
              throw serviceError('La pasarela normalizada no coincide con la autorizada.', 503, 'live_payment_gateway_normalization_mismatch')
            }
            const created = await dependencies.createPaymentGateLink(gateConfig, {
              contact: {
                id: contactId,
                contactId,
                name: cleanString(contact.name || contact.full_name, 180),
                contactName: cleanString(contact.name || contact.full_name, 180),
                email: cleanString(contact.email, 180),
                phone: cleanString(contact.phone, 80)
              },
              source,
              applyTax: false,
              paymentLinkRequestKey: requestKey,
              expiresAt: canonicalExpiresAt,
              metadata: {
                paymentMode: 'live',
                conversationalAgent: {
                  idempotencyKey: requestKey,
                  afterPayment: durablePayload.afterPayment,
                  expiresAt: canonicalExpiresAt
                }
              }
            })
            const publicPaymentId = cleanString(created?.publicPaymentId || created?.payment?.publicPaymentId, 180)
            return {
              ...created,
              invoiceId: publicPaymentId,
              ledgerPaymentId: cleanString(created?.payment?.id, 180) || null,
              provider: selectedGateway,
              paymentMode: cleanString(created?.payment?.paymentMode, 40).toLowerCase(),
              amount: Number(created?.payment?.amount),
              currency: cleanString(created?.payment?.currency, 3).toUpperCase(),
              expiresAt: canonicalExpiresAt
            }
          }
        })
      }
    } catch (error) {
      const request = await db.get(
        'SELECT status FROM conversational_payment_link_requests WHERE idempotency_key = ?',
        [requestKey]
      ).catch(() => null)
      if (request?.status === 'failed') {
        await failConversationalPaymentSemanticClaim({ claim: semanticClaim, requestKey, error })
      } else if (!request) {
        await releaseUnusedConversationalPaymentSemanticClaim({ claim: semanticClaim, requestKey }).catch(() => {})
      }
      throw error
    }
  }

  const ledger = await dependencies.loadExactPaymentLedger({
    contactId,
    gateway: selectedGateway,
    idempotencyKey: requestKey,
    result
  })
  const replayExpiresAt = Number.isFinite(Date.parse(result?.expiresAt || ''))
    ? result.expiresAt
    : expiresAt
  return {
    ...assertExactLiveLedger({
      ledger,
      result,
      contactId,
      gateway: selectedGateway,
      amount: normalizedAmount,
      currency: normalizedCurrency,
      idempotencyKey: requestKey,
      expiresAt: replayExpiresAt
    }),
    reused: result?.reused === true,
    durableReplay: result?.durableReplay === true,
    expirationMinutes: normalizedExpirationMinutes,
    installments: normalizedInstallments,
    afterPayment: durablePayload.afterPayment
  }
}

export function setConversationalAgentLivePaymentDependenciesForTests(overrides = null) {
  dependencies = overrides
    ? { ...dependencies, ...overrides }
    : {
        createPaymentGateLink,
        getPaymentGateCheckoutKeys,
        normalizePaymentGateConfig,
        createSinglePaymentLink,
        getHighLevelPaymentLinkMode,
        runIdempotentConversationalPaymentLinkCreation,
        loadExactPaymentLedger,
        findReusableConversationalLivePaymentLink,
        recordCrossTurnConversationalPaymentReuse
      }
}

export const __conversationalAgentLivePaymentTestHooks = Object.freeze({
  assertExactLiveLedger,
  buildExpirationIso,
  findReusableConversationalLivePaymentLink,
  recordCrossTurnConversationalPaymentReuse,
  reserveConversationalPaymentSemanticClaim,
  semanticPaymentClaimIdentity
})
