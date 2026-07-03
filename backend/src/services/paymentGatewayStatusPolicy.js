const GATEWAY_PAYMENT_RESULTS = Object.freeze({
  PAID: 'paid',
  PENDING: 'pending',
  FAILED: 'failed',
  REFUNDED: 'refunded',
  VOID: 'void'
})

const DEFAULT_PAID_STATUSES = new Set([
  'paid',
  'succeeded',
  'completed',
  'complete',
  'fulfilled',
  'success',
  'captured',
  'approved',
  'accredited'
])

const DEFAULT_PENDING_STATUSES = new Set([
  '',
  'sent',
  'pending',
  'pending_payment',
  'processing',
  'requires_action',
  'requires_confirmation',
  'requires_payment_method',
  'authorized',
  'in_process',
  'in_mediation',
  'created',
  'open',
  'draft',
  'initiated',
  'incomplete',
  'incomplete_expired',
  'expired',
  'abandoned',
  'canceled',
  'cancelled',
  'canceled_by_user',
  'cancelled_by_user'
])

const DEFAULT_FAILED_STATUSES = new Set([
  'failed',
  'failure',
  'error',
  'declined',
  'rejected',
  'payment_failed',
  'payment_declined',
  'card_declined',
  'denied'
])

const DEFAULT_REFUNDED_STATUSES = new Set([
  'refunded',
  'refund',
  'partially_refunded'
])

const DEFAULT_VOID_STATUSES = new Set([
  'void',
  'voided'
])

export function normalizeGatewayPaymentStatus(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function buildStatusSet(defaultStatuses, extraStatuses = []) {
  const result = new Set(defaultStatuses)
  for (const status of extraStatuses || []) {
    result.add(normalizeGatewayPaymentStatus(status))
  }
  return result
}

export function mapGatewayPaymentStatus(status, options = {}) {
  const normalized = normalizeGatewayPaymentStatus(status)
  const paidStatuses = buildStatusSet(DEFAULT_PAID_STATUSES, options.paidStatuses)
  const refundedStatuses = buildStatusSet(DEFAULT_REFUNDED_STATUSES, options.refundedStatuses)
  const voidStatuses = buildStatusSet(DEFAULT_VOID_STATUSES, options.voidStatuses)
  const failedStatuses = buildStatusSet(DEFAULT_FAILED_STATUSES, options.failedStatuses)
  const pendingStatuses = buildStatusSet(DEFAULT_PENDING_STATUSES, options.pendingStatuses)

  if (paidStatuses.has(normalized)) return GATEWAY_PAYMENT_RESULTS.PAID
  if (refundedStatuses.has(normalized)) return GATEWAY_PAYMENT_RESULTS.REFUNDED
  if (voidStatuses.has(normalized)) return GATEWAY_PAYMENT_RESULTS.VOID
  if (failedStatuses.has(normalized)) return GATEWAY_PAYMENT_RESULTS.FAILED
  if (pendingStatuses.has(normalized)) return GATEWAY_PAYMENT_RESULTS.PENDING

  return options.unknownStatus || GATEWAY_PAYMENT_RESULTS.PENDING
}

export function isGatewayPaymentFailureStatus(status, options = {}) {
  return mapGatewayPaymentStatus(status, options) === GATEWAY_PAYMENT_RESULTS.FAILED
}

export { GATEWAY_PAYMENT_RESULTS }
