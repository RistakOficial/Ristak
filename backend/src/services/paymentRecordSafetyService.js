import { db } from '../config/database.js'

const SUCCESS_PAYMENT_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success'])
const TEST_PAYMENT_MODES = new Set(['test', 'sandbox'])
const LEDGER_PAYMENT_STATUSES = new Set([
  ...SUCCESS_PAYMENT_STATUSES,
  'partial',
  'partially_paid',
  'refunded',
  'partially_refunded',
  'refund',
  'void',
  'voided',
  'failed',
  'failure',
  'declined',
  'requires_action',
  'processing'
])

const cleanString = (value) => String(value || '').trim()

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function normalizeMode(value) {
  return cleanString(value).toLowerCase()
}

function isExplicitTestMode(value) {
  return TEST_PAYMENT_MODES.has(normalizeMode(value))
}

function hasTestModeSignal(value) {
  const metadata = parseJson(value, {})
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false

  const modeFields = [
    metadata.paymentMode,
    metadata.payment_mode,
    metadata.mode,
    metadata.stripeMode,
    metadata.stripe_mode,
    metadata.conektaMode,
    metadata.conekta_mode,
    metadata.mercadoPagoMode,
    metadata.mercadopagoMode,
    metadata.mercadopago_mode
  ]

  if (modeFields.some(isExplicitTestMode)) return true
  if (metadata.livemode === false || metadata.liveMode === false || metadata.live_mode === false) return true

  return false
}

export function normalizePaymentStatus(status) {
  const normalized = cleanString(status).toLowerCase()
  return normalized === 'succeeded' ? 'paid' : normalized
}

export function isSuccessfulPaymentStatus(status) {
  return SUCCESS_PAYMENT_STATUSES.has(normalizePaymentStatus(status))
}

export function isTestPaymentRecord(payment = {}) {
  return Boolean(
    isExplicitTestMode(payment.payment_mode) ||
    hasTestModeSignal(payment.metadata_json)
  )
}

export function paymentHasLedgerActivity(payment = {}) {
  const status = normalizePaymentStatus(payment.status)
  const metadata = parseJson(payment.metadata_json, {})
  return Boolean(
    LEDGER_PAYMENT_STATUSES.has(status) ||
    cleanString(payment.paid_at) ||
    cleanString(payment.stripe_payment_intent_id) ||
    cleanString(payment.stripe_charge_id) ||
    cleanString(payment.mercadopago_payment_id) ||
    cleanString(payment.mercadopago_preference_id) ||
    cleanString(metadata.stripePaymentIntentId) ||
    cleanString(metadata.stripeChargeId) ||
    cleanString(metadata.mercadoPagoPaymentId)
  )
}

export function paymentHasExternalArtifact(payment = {}) {
  const provider = cleanString(payment.payment_provider).toLowerCase()
  const method = cleanString(payment.payment_method).toLowerCase()
  return Boolean(
    cleanString(payment.public_payment_id) ||
    cleanString(payment.payment_url) ||
    cleanString(payment.ghl_invoice_id) ||
    cleanString(payment.invoice_number) ||
    cleanString(payment.stripe_payment_intent_id) ||
    cleanString(payment.stripe_charge_id) ||
    cleanString(payment.mercadopago_payment_id) ||
    cleanString(payment.mercadopago_preference_id) ||
    ['stripe', 'highlevel', 'mercadopago'].includes(provider) ||
    method.startsWith('stripe') ||
    method.startsWith('mercadopago')
  )
}

export async function getPaymentPlanLinksForPayment(paymentId) {
  const cleanPaymentId = cleanString(paymentId)
  if (!cleanPaymentId) return []

  const rows = await db.all(
    `SELECT DISTINCT f.id, f.current_state, f.payment_provider, 'first_payment' AS role
     FROM payment_flows f
     WHERE f.first_payment_invoice_id = ?
     UNION
     SELECT DISTINCT f.id, f.current_state, f.payment_provider, 'card_setup' AS role
     FROM payment_flows f
     WHERE f.card_setup_invoice_id = ?
     UNION
     SELECT DISTINCT f.id, f.current_state, f.payment_provider, 'installment' AS role
     FROM installment_payments i
     JOIN payment_flows f ON f.id = i.flow_id
     WHERE i.payment_id = ?`,
    [cleanPaymentId, cleanPaymentId, cleanPaymentId]
  )

  return rows || []
}

export async function getPaymentSubscriptionLinksForPayment(payment = {}) {
  const metadata = parseJson(payment.metadata_json, {})
  const ids = [
    cleanString(metadata.ristakSubscriptionId),
    cleanString(metadata.ristak_subscription_id),
    cleanString(metadata.stripeSubscriptionId),
    cleanString(metadata.stripe_subscription_id)
  ].filter(Boolean)

  const links = []
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(', ')
    const rows = await db.all(
      `SELECT id, status, stripe_subscription_id
       FROM subscriptions
       WHERE id IN (${placeholders})
          OR stripe_subscription_id IN (${placeholders})`,
      [...ids, ...ids]
    )
    links.push(...(rows || []))
  }

  if (!links.length && cleanString(payment.payment_method).toLowerCase() === 'stripe_subscription') {
    links.push({
      id: cleanString(metadata.ristakSubscriptionId) || cleanString(metadata.ristak_subscription_id) || '',
      status: '',
      stripe_subscription_id: cleanString(metadata.stripeSubscriptionId) || cleanString(metadata.stripe_subscription_id) || ''
    })
  }

  return links
}

export async function getPaymentDeletionGuard(payment = {}) {
  const planLinks = await getPaymentPlanLinksForPayment(payment.id)
  const subscriptionLinks = await getPaymentSubscriptionLinksForPayment(payment)
  const hasLedgerActivity = paymentHasLedgerActivity(payment)
  const hasExternalArtifact = paymentHasExternalArtifact(payment)
  const isTestMode = isTestPaymentRecord(payment)

  return {
    planLinks,
    subscriptionLinks,
    hasPlanLink: planLinks.length > 0,
    hasSubscriptionLink: subscriptionLinks.length > 0,
    hasLedgerActivity,
    hasExternalArtifact,
    isTestMode,
    canHardDelete: isTestMode || (!planLinks.length && !subscriptionLinks.length && !hasLedgerActivity && !hasExternalArtifact),
    shouldArchive: !isTestMode && !planLinks.length && !subscriptionLinks.length && !hasLedgerActivity && hasExternalArtifact
  }
}

export async function getPaymentPlanAuditSummary(flowId) {
  const cleanFlowId = cleanString(flowId)
  if (!cleanFlowId) return { payments: [], hasLedgerActivity: false, isTestMode: false }

  const flow = await db.get('SELECT * FROM payment_flows WHERE id = ?', [cleanFlowId])

  const payments = await db.all(
    `SELECT DISTINCT p.*
     FROM payments p
     WHERE p.id IN (
       SELECT payment_id
       FROM installment_payments
       WHERE flow_id = ?
         AND payment_id IS NOT NULL
       UNION
       SELECT first_payment_invoice_id
       FROM payment_flows
       WHERE id = ?
         AND first_payment_invoice_id IS NOT NULL
       UNION
       SELECT card_setup_invoice_id
       FROM payment_flows
       WHERE id = ?
         AND card_setup_invoice_id IS NOT NULL
     )`,
    [cleanFlowId, cleanFlowId, cleanFlowId]
  )
  const protectedPayments = (payments || []).filter(paymentHasLedgerActivity)
  const metadata = parseJson(flow?.metadata, {})
  const hasLinkedPayments = (payments || []).length > 0
  const isTestMode = Boolean(
    hasTestModeSignal(metadata) ||
    (hasLinkedPayments && (payments || []).every(isTestPaymentRecord))
  )

  return {
    flow,
    payments: payments || [],
    protectedPayments,
    hasLedgerActivity: protectedPayments.length > 0,
    isTestMode
  }
}

export async function hardDeleteTestPaymentRecord(paymentId) {
  const cleanPaymentId = cleanString(paymentId)
  if (!cleanPaymentId) return { deleted: false, paymentIds: [] }

  const payment = await db.get('SELECT * FROM payments WHERE id = ?', [cleanPaymentId])
  if (!payment || !isTestPaymentRecord(payment)) return { deleted: false, paymentIds: [] }

  return db.transaction(async (tx) => {
    await tx.run('DELETE FROM payment_automation_dispatches WHERE payment_id = ?', [cleanPaymentId]).catch(() => undefined)
    await tx.run(
      `UPDATE installment_payments
       SET payment_id = NULL,
           status = 'deleted',
           updated_at = CURRENT_TIMESTAMP
       WHERE payment_id = ?`,
      [cleanPaymentId]
    )
    await tx.run(
      `UPDATE payment_flows
       SET first_payment_invoice_id = NULL,
           first_payment_status = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE first_payment_invoice_id = ?`,
      [cleanPaymentId]
    )
    await tx.run(
      `UPDATE payment_flows
       SET card_setup_invoice_id = NULL,
           card_setup_status = NULL,
           card_setup_payment_link = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE card_setup_invoice_id = ?`,
      [cleanPaymentId]
    )
    const deleted = await tx.run('DELETE FROM payments WHERE id = ?', [cleanPaymentId])

    return {
      deleted: Number(deleted?.changes || 0) > 0,
      paymentIds: [cleanPaymentId]
    }
  })
}

export async function hardDeleteTestPaymentPlan(flowId) {
  const cleanFlowId = cleanString(flowId)
  if (!cleanFlowId) return { deleted: false, paymentIds: [] }

  const audit = await getPaymentPlanAuditSummary(cleanFlowId)
  if (!audit.isTestMode) return { deleted: false, paymentIds: [] }

  return db.transaction(async (tx) => {
    const linkedPayments = await tx.all(
      `SELECT DISTINCT payment_id AS id
       FROM installment_payments
       WHERE flow_id = ?
         AND payment_id IS NOT NULL
       UNION
       SELECT first_payment_invoice_id AS id
       FROM payment_flows
       WHERE id = ?
         AND first_payment_invoice_id IS NOT NULL
       UNION
       SELECT card_setup_invoice_id AS id
       FROM payment_flows
       WHERE id = ?
         AND card_setup_invoice_id IS NOT NULL`,
      [cleanFlowId, cleanFlowId, cleanFlowId]
    )
    const paymentIds = (linkedPayments || []).map((row) => cleanString(row.id)).filter(Boolean)

    for (const paymentId of paymentIds) {
      await tx.run('DELETE FROM payment_automation_dispatches WHERE payment_id = ?', [paymentId]).catch(() => undefined)
    }

    await tx.run('DELETE FROM payment_plans WHERE id = ? OR ghl_schedule_id = ?', [cleanFlowId, cleanFlowId])
    await tx.run('DELETE FROM installment_payments WHERE flow_id = ?', [cleanFlowId])
    await tx.run('DELETE FROM payment_flows WHERE id = ?', [cleanFlowId])

    for (const paymentId of paymentIds) {
      await tx.run('DELETE FROM payments WHERE id = ?', [paymentId])
    }

    return {
      deleted: true,
      paymentIds
    }
  })
}

export async function getSubscriptionAuditSummary(subscriptionId) {
  const cleanSubscriptionId = cleanString(subscriptionId)
  if (!cleanSubscriptionId) return { payments: [], hasPayments: false }

  const subscription = await db.get(
    'SELECT id, contact_id, stripe_subscription_id FROM subscriptions WHERE id = ? LIMIT 1',
    [cleanSubscriptionId]
  )
  if (!subscription) return { payments: [], hasPayments: false }

  const patterns = [
    `%${subscription.id}%`,
    subscription.stripe_subscription_id ? `%${subscription.stripe_subscription_id}%` : ''
  ].filter(Boolean)

  if (!patterns.length) return { payments: [], hasPayments: false }

  const where = patterns.map(() => 'metadata_json LIKE ?').join(' OR ')
  const payments = await db.all(
    `SELECT *
     FROM payments
     WHERE ${where}`,
    patterns
  )

  return {
    payments: payments || [],
    hasPayments: Boolean((payments || []).length)
  }
}
