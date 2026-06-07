export const PAYMENT_MODE_LIVE = 'live'
export const PAYMENT_MODE_TEST = 'test'
export const SUCCESS_PAYMENT_STATUSES = [
  'succeeded',
  'paid',
  'completed',
  'complete',
  'fulfilled',
  'success'
]

const TEST_MODE_VALUES = new Set(['test', 'testing', 'sandbox', 'demo'])
const LIVE_MODE_VALUES = new Set(['live', 'production', 'prod'])
const TRUE_VALUES = new Set(['true', '1', 'yes'])
const FALSE_VALUES = new Set(['false', '0', 'no'])

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '')
}

export function normalizePaymentMode(value, fallback = PAYMENT_MODE_LIVE) {
  if (typeof value === 'boolean') {
    return value ? PAYMENT_MODE_LIVE : PAYMENT_MODE_TEST
  }

  if (value === undefined || value === null || value === '') {
    return fallback === PAYMENT_MODE_TEST ? PAYMENT_MODE_TEST : PAYMENT_MODE_LIVE
  }

  const normalized = String(value).trim().toLowerCase()

  if (FALSE_VALUES.has(normalized) || TEST_MODE_VALUES.has(normalized) || normalized.includes('test')) {
    return PAYMENT_MODE_TEST
  }

  if (TRUE_VALUES.has(normalized) || LIVE_MODE_VALUES.has(normalized)) {
    return PAYMENT_MODE_LIVE
  }

  return fallback === PAYMENT_MODE_TEST ? PAYMENT_MODE_TEST : PAYMENT_MODE_LIVE
}

function normalizeTestModeSignal(value, fallback = PAYMENT_MODE_LIVE) {
  if (typeof value === 'boolean') {
    return value ? PAYMENT_MODE_TEST : PAYMENT_MODE_LIVE
  }

  const normalized = String(value ?? '').trim().toLowerCase()

  if (TRUE_VALUES.has(normalized) || TEST_MODE_VALUES.has(normalized) || normalized.includes('test')) {
    return PAYMENT_MODE_TEST
  }

  if (FALSE_VALUES.has(normalized) || LIVE_MODE_VALUES.has(normalized)) {
    return PAYMENT_MODE_LIVE
  }

  return normalizePaymentMode(value, fallback)
}

export function getInvoicePaymentMode(invoice = {}, fallback = PAYMENT_MODE_LIVE) {
  const liveMode = firstDefined(
    invoice.liveMode,
    invoice.live_mode,
    invoice.livemode,
    invoice.isLiveMode,
    invoice.is_live_mode
  )

  if (liveMode !== undefined) {
    return normalizePaymentMode(liveMode, fallback)
  }

  const testMode = firstDefined(
    invoice.testMode,
    invoice.test_mode,
    invoice.isTestMode,
    invoice.is_test_mode
  )

  if (testMode !== undefined) {
    return normalizeTestModeSignal(testMode, fallback)
  }

  return normalizePaymentMode(
    firstDefined(
      testMode,
      invoice.environment,
      invoice.env,
      invoice.mode
    ),
    fallback
  )
}

export function getWebhookPaymentMode(data = {}, payment = {}, fallback = PAYMENT_MODE_LIVE) {
  const invoice = payment.invoice || data.invoice || data.invoiceData || data.data?.invoice || {}
  const sourceMeta = payment.entitySourceMeta || payment.entity_source_meta || data.entitySourceMeta || data.entity_source_meta || {}

  const liveMode = firstDefined(
    payment.liveMode,
    payment.live_mode,
    payment.livemode,
    payment.isLiveMode,
    payment.is_live_mode,
    data.liveMode,
    data.live_mode,
    data.livemode,
    invoice.liveMode,
    invoice.live_mode,
    invoice.livemode,
    sourceMeta.liveMode,
    sourceMeta.live_mode
  )

  if (liveMode !== undefined) {
    return normalizePaymentMode(liveMode, fallback)
  }

  const testMode = firstDefined(
    payment.testMode,
    payment.test_mode,
    payment.isTestMode,
    payment.is_test_mode,
    data.testMode,
    data.test_mode,
    invoice.testMode,
    invoice.test_mode,
    sourceMeta.testMode,
    sourceMeta.test_mode
  )

  if (testMode !== undefined) {
    return normalizeTestModeSignal(testMode, fallback)
  }

  return normalizePaymentMode(
    firstDefined(
      testMode,
      payment.environment,
      data.environment,
      invoice.environment,
      sourceMeta.environment,
      payment.mode,
      data.mode,
      invoice.mode,
      sourceMeta.mode
    ),
    fallback
  )
}

export function nonTestPaymentCondition(alias = '') {
  const prefix = alias ? `${alias}.` : ''
  return `COALESCE(${prefix}payment_mode, '${PAYMENT_MODE_LIVE}') != '${PAYMENT_MODE_TEST}'`
}

export function successfulPaymentStatusCondition(alias = '') {
  const prefix = alias ? `${alias}.` : ''
  const placeholders = SUCCESS_PAYMENT_STATUSES.map(() => '?').join(', ')

  return {
    sql: `LOWER(${prefix}status) IN (${placeholders})`,
    params: [...SUCCESS_PAYMENT_STATUSES]
  }
}
