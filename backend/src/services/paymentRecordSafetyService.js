import { db } from '../config/database.js'

const SUCCESS_PAYMENT_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success'])
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

export function normalizePaymentStatus(status) {
  const normalized = cleanString(status).toLowerCase()
  return normalized === 'succeeded' ? 'paid' : normalized
}

export function isSuccessfulPaymentStatus(status) {
  return SUCCESS_PAYMENT_STATUSES.has(normalizePaymentStatus(status))
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

  return {
    planLinks,
    subscriptionLinks,
    hasPlanLink: planLinks.length > 0,
    hasSubscriptionLink: subscriptionLinks.length > 0,
    hasLedgerActivity,
    hasExternalArtifact,
    canHardDelete: !planLinks.length && !subscriptionLinks.length && !hasLedgerActivity && !hasExternalArtifact,
    shouldArchive: !planLinks.length && !subscriptionLinks.length && !hasLedgerActivity && hasExternalArtifact
  }
}

export async function getPaymentPlanAuditSummary(flowId) {
  const cleanFlowId = cleanString(flowId)
  if (!cleanFlowId) return { payments: [], hasLedgerActivity: false }

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

  return {
    payments: payments || [],
    protectedPayments,
    hasLedgerActivity: protectedPayments.length > 0
  }
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
