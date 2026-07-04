const SUCCESSFUL_PAYMENT_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'captured'])

const PAYMENT_CHANNEL_LABELS = {
  ristak: 'Ristak',
  manual: 'Ristak',
  highlevel: 'HighLevel',
  ghl: 'HighLevel',
  stripe: 'Stripe',
  conekta: 'Conekta',
  mercadopago: 'Mercado Pago',
  clip: 'CLIP',
  openpay: 'Openpay',
  rebill: 'Rebill',
  gigstack: 'Gigstack'
}

const CHANNEL_ALIASES = {
  'mercado_pago': 'mercadopago',
  mercado_pago: 'mercadopago',
  mp: 'mercadopago',
  gohighlevel: 'highlevel',
  high_level: 'highlevel',
  ghl: 'highlevel',
  local: 'ristak',
  offline: 'ristak',
  manual: 'ristak'
}

const PAYMENT_METHOD_LABELS = {
  credit_card: 'Tarjeta de crédito',
  debit_card: 'Tarjeta de débito',
  prepaid_card: 'Tarjeta prepagada',
  card: 'Tarjeta',
  cash: 'Efectivo',
  deposit: 'Depósito',
  bank_transfer: 'Transferencia bancaria',
  spei: 'SPEI',
  check: 'Cheque',
  paypal: 'PayPal',
  wallet: 'Billetera digital',
  account_money: 'Saldo Mercado Pago',
  pending_selection: 'Pendiente de selección',
  unspecified: 'Método no especificado',
  other: 'Otro'
}

const METHOD_ALIASES = {
  credit: 'credit_card',
  debit: 'debit_card',
  prepaid: 'prepaid_card',
  credit_card: 'credit_card',
  debit_card: 'debit_card',
  prepaid_card: 'prepaid_card',
  card: 'card',
  direct_card: 'card',
  saved_card: 'card',
  stripe: 'card',
  stripe_saved_card: 'card',
  stripe_scheduled_card: 'card',
  stripe_subscription: 'card',
  conekta: 'card',
  conekta_auto: 'card',
  conekta_saved_card: 'card',
  conekta_scheduled_card: 'card',
  conekta_subscription: 'card',
  clip: 'card',
  clip_card: 'card',
  rebill: 'card',
  rebill_checkout: 'card',
  rebill_saved_card: 'card',
  rebill_scheduled_card: 'card',
  cash: 'cash',
  efectivo: 'cash',
  oxxo: 'cash',
  ticket: 'cash',
  atm: 'cash',
  deposit: 'deposit',
  deposito: 'deposit',
  bank_transfer: 'bank_transfer',
  transfer: 'bank_transfer',
  transfer_bank: 'bank_transfer',
  wire_transfer: 'bank_transfer',
  bank_account: 'bank_transfer',
  spei: 'spei',
  check: 'check',
  cheque: 'check',
  paypal: 'paypal',
  account_money: 'account_money',
  digital_wallet: 'wallet',
  wallet: 'wallet',
  mercado_pago_wallet: 'wallet',
  other: 'other',
  manual: 'other',
  offline: 'other'
}

const LINK_METHODS = new Set([
  'payment_link',
  'stripe_link',
  'stripe_payment_link',
  'mercadopago',
  'mercadopago_checkout',
  'clip_link',
  'clip_payment_link',
  'conekta_link'
])

const CARD_DEFAULT_CHANNELS = new Set(['stripe', 'conekta', 'clip', 'rebill'])
const MSI_CHANNELS = new Set(['stripe', 'conekta', 'mercadopago', 'clip'])

const cleanString = (value) => String(value || '').trim()

const normalizeToken = (value) => cleanString(value)
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')

const parseJson = (value, fallback = {}) => {
  if (!value) return fallback
  if (typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

const getPath = (source, path) => {
  if (!source || typeof source !== 'object') return undefined
  return path.split('.').reduce((current, key) => {
    if (!current || typeof current !== 'object') return undefined
    return current[key]
  }, source)
}

const firstClean = (...values) => {
  for (const value of values) {
    if (typeof value === 'object' && value !== null) continue
    const clean = cleanString(value)
    if (clean) return clean
  }
  return ''
}

const positiveIntFrom = (value) => {
  if (value && typeof value === 'object') {
    return firstPositiveInt(
      value.selectedInstallments,
      value.selected_installments,
      value.selectedCount,
      value.selected_count,
      value.monthlyInstallments,
      value.monthly_installments,
      value.months,
      value.installments,
      value.count,
      value.value,
      getPath(value, 'plan.count')
    )
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  const count = Math.trunc(parsed)
  return count > 1 ? count : 0
}

function firstPositiveInt(...values) {
  for (const value of values) {
    const count = positiveIntFrom(value)
    if (count > 1) return count
  }
  return 0
}

const isSuccessfulPayment = (row = {}) => SUCCESSFUL_PAYMENT_STATUSES.has(normalizeToken(row.status))

const normalizeChannelId = (value) => {
  const token = normalizeToken(value)
  if (!token) return ''
  return CHANNEL_ALIASES[token] || token
}

const getPaymentMetadata = (row = {}) => parseJson(
  row.metadata_json ?? row.metadataJson ?? row.metadata,
  {}
)

export function getPaymentChannelLabel(channelId = '') {
  const normalized = normalizeChannelId(channelId) || 'ristak'
  return PAYMENT_CHANNEL_LABELS[normalized] || cleanString(channelId) || 'Ristak'
}

export function resolvePaymentChannelId(row = {}, metadata = getPaymentMetadata(row)) {
  const provider = normalizeChannelId(firstClean(
    row.payment_provider,
    row.paymentProvider,
    metadata.paymentProvider,
    metadata.payment_provider,
    metadata.provider,
    metadata.gateway,
    metadata.processor
  ))

  if (provider && provider !== 'manual') return provider

  const method = normalizeToken(row.payment_method || row.method)
  if (method.startsWith('stripe')) return 'stripe'
  if (method.startsWith('conekta')) return 'conekta'
  if (method.startsWith('mercadopago') || method.startsWith('mercado_pago')) return 'mercadopago'
  if (method.startsWith('clip')) return 'clip'
  if (method.startsWith('rebill')) return 'rebill'
  if (method.startsWith('gigstack')) return 'gigstack'
  if (method.startsWith('ghl') || method.startsWith('highlevel')) return 'highlevel'

  if (row.ghl_invoice_id || row.invoiceId) return 'highlevel'
  if (row.stripe_payment_intent_id || row.stripePaymentIntentId || row.stripe_charge_id || row.stripeChargeId) return 'stripe'
  if (row.mercadopago_payment_id || row.mercadoPagoPaymentId || row.mercadopago_preference_id || row.mercadoPagoPreferenceId) return 'mercadopago'
  if (row.conekta_order_id || row.conektaOrderId || row.conekta_charge_id || row.conektaChargeId) return 'conekta'
  if (row.clip_payment_id || row.clipPaymentId) return 'clip'
  if (row.rebill_payment_id || row.rebillPaymentId || row.rebill_subscription_id || row.rebillSubscriptionId) return 'rebill'

  return 'ristak'
}

const resolvePaymentMethodCategoryId = (row = {}, metadata = getPaymentMetadata(row), channelId = resolvePaymentChannelId(row, metadata)) => {
  const method = normalizeToken(row.payment_method || row.method)
  const metadataMethod = normalizeToken(firstClean(
    metadata.paymentMethodCategory,
    metadata.payment_method_category,
    metadata.cardFunding,
    metadata.funding,
    metadata.paymentTypeId,
    metadata.payment_type_id,
    metadata.paymentMethodType,
    metadata.payment_method_type,
    getPath(metadata, 'stripe.cardFunding'),
    getPath(metadata, 'stripe.funding'),
    getPath(metadata, 'stripe.paymentMethodType'),
    getPath(metadata, 'mercadoPago.paymentTypeId'),
    getPath(metadata, 'mercadoPago.paymentMethodId'),
    getPath(metadata, 'clip.paymentMethod.type'),
    getPath(metadata, 'clip.paymentMethod'),
    getPath(metadata, 'conekta.paymentMethodType'),
    getPath(metadata, 'conekta.paymentMethod'),
    getPath(metadata, 'rebill.cardFunding'),
    getPath(metadata, 'rebill.paymentMethodType')
  ))

  const metadataAlias = METHOD_ALIASES[metadataMethod]
  if (metadataAlias) return metadataAlias

  if (LINK_METHODS.has(method) && !isSuccessfulPayment(row)) return 'pending_selection'

  const methodAlias = METHOD_ALIASES[method]
  if (methodAlias) return methodAlias

  if ((method === '' || method === 'auto' || method === 'checkout') && CARD_DEFAULT_CHANNELS.has(channelId)) {
    return 'card'
  }

  if (method.startsWith('stripe') || method.startsWith('conekta') || method.startsWith('clip') || method.startsWith('rebill')) {
    return 'card'
  }

  if (method.startsWith('mercadopago') || method.startsWith('mercado_pago')) {
    return isSuccessfulPayment(row) ? 'unspecified' : 'pending_selection'
  }

  return method ? 'other' : 'unspecified'
}

const hasSubscriptionSignal = (row = {}, metadata = {}) => {
  const method = normalizeToken(row.payment_method || row.method)
  const source = normalizeToken(firstClean(
    metadata.source,
    getPath(metadata, 'stripe.source'),
    getPath(metadata, 'mercadoPago.source'),
    getPath(metadata, 'conekta.source'),
    getPath(metadata, 'clip.source'),
    getPath(metadata, 'rebill.source')
  ))

  return Boolean(
    method.includes('subscription') ||
    source.includes('subscription') ||
    row.rebill_subscription_id ||
    row.rebillSubscriptionId ||
    metadata.ristakSubscriptionId ||
    metadata.ristak_subscription_id ||
    metadata.subscriptionStart ||
    metadata.subscriptionStartPayment
  )
}

const hasCardSetupSignal = (row = {}, metadata = {}) => {
  const source = normalizeToken(firstClean(metadata.source, getPath(metadata, 'paymentPlan.trigger'), getPath(metadata, 'paymentPlan.source')))
  const method = normalizeToken(row.payment_method || row.method)
  return source.includes('card_setup') || method.includes('card_setup')
}

const hasDeferredPaymentSignal = (row = {}, metadata = {}) => {
  const method = normalizeToken(row.payment_method || row.method)
  const source = normalizeToken(firstClean(metadata.source, getPath(metadata, 'paymentPlan.source'), getPath(metadata, 'paymentPlan.trigger')))

  return Boolean(
    normalizeToken(row.status) === 'scheduled' ||
    method.includes('scheduled') ||
    method.includes('pending_card') ||
    source.includes('payment_plan') ||
    source.includes('scheduled_installment') ||
    metadata.paymentPlan ||
    metadata.payment_plan ||
    row.payment_plan_id ||
    row.paymentPlanId
  )
}

const getInstallmentCount = (row = {}, metadata = {}) => firstPositiveInt(
  metadata.selectedInstallments,
  metadata.selected_installments,
  metadata.installments,
  getPath(metadata, 'stripe.selectedInstallments'),
  getPath(metadata, 'stripe.installments'),
  getPath(metadata, 'stripe.installments.plan'),
  getPath(metadata, 'mercadoPago.installments'),
  getPath(metadata, 'mercadoPago.selectedInstallments'),
  getPath(metadata, 'clip.installments'),
  getPath(metadata, 'clip.selectedInstallments'),
  getPath(metadata, 'conekta.monthlyInstallments'),
  getPath(metadata, 'conekta.monthly_installments'),
  getPath(metadata, 'conekta.installments'),
  getPath(metadata, 'rebillInstallments.selectedInstallments'),
  getPath(metadata, 'rebill.installments'),
  row.installments,
  row.monthly_installments,
  row.monthlyInstallments
)

const hasMsiSignal = (metadata = {}) => {
  const msiFlag = firstClean(
    metadata.msi,
    metadata.isMsi,
    metadata.is_msi,
    metadata.interestFree,
    metadata.interest_free,
    metadata.noInterest,
    metadata.no_interest,
    getPath(metadata, 'installments.msi'),
    getPath(metadata, 'installments.interestFree'),
    getPath(metadata, 'installments.interest_free'),
    getPath(metadata, 'stripe.installments.msi'),
    getPath(metadata, 'stripe.installments.interestFree'),
    getPath(metadata, 'mercadoPago.installments.msi'),
    getPath(metadata, 'mercadoPago.installments.interestFree'),
    getPath(metadata, 'conekta.installments.msi'),
    getPath(metadata, 'conekta.installments.interestFree'),
    getPath(metadata, 'clip.installments.msi'),
    getPath(metadata, 'clip.installments.interestFree')
  )
  const msiMode = normalizeToken(firstClean(
    metadata.installmentMode,
    metadata.installment_mode,
    metadata.installmentType,
    metadata.installment_type,
    metadata.selectionMode,
    metadata.selection_mode,
    getPath(metadata, 'installments.mode'),
    getPath(metadata, 'installments.type'),
    getPath(metadata, 'stripe.installments.mode'),
    getPath(metadata, 'stripe.installments.type'),
    getPath(metadata, 'mercadoPago.installments.mode'),
    getPath(metadata, 'mercadoPago.installments.type'),
    getPath(metadata, 'conekta.installments.mode'),
    getPath(metadata, 'conekta.installments.type'),
    getPath(metadata, 'clip.installments.mode'),
    getPath(metadata, 'clip.installments.type')
  ))

  return ['1', 'true', 'yes', 'si', 'msi', 'interest_free', 'no_interest', 'sin_intereses', 'meses_sin_intereses'].includes(normalizeToken(msiFlag)) ||
    ['msi', 'interest_free', 'no_interest', 'sin_intereses', 'meses_sin_intereses'].includes(msiMode) ||
    msiMode.includes('msi') ||
    msiMode.includes('interest_free') ||
    msiMode.includes('sin_intereses')
}

const buildInstallmentPaymentType = (count, channelId, metadata = {}) => {
  if (MSI_CHANNELS.has(channelId) || hasMsiSignal(metadata)) return `${count} MSI`
  return `${count} pagos`
}

const resolvePaymentTypeLabel = (row = {}, metadata = getPaymentMetadata(row), channelId = resolvePaymentChannelId(row, metadata)) => {
  if (hasSubscriptionSignal(row, metadata)) return 'Suscripción'
  if (hasCardSetupSignal(row, metadata)) return 'Autorización de tarjeta'

  const installmentCount = getInstallmentCount(row, metadata)
  if (installmentCount > 1) return buildInstallmentPaymentType(installmentCount, channelId, metadata)

  if (hasDeferredPaymentSignal(row, metadata)) return 'Pago diferido'

  return 'Pago único'
}

export function buildPaymentDisplay(row = {}) {
  const metadata = getPaymentMetadata(row)
  const paymentChannelId = resolvePaymentChannelId(row, metadata)
  const paymentMethodCategoryId = resolvePaymentMethodCategoryId(row, metadata, paymentChannelId)
  const paymentMethodCategory = PAYMENT_METHOD_LABELS[paymentMethodCategoryId] || PAYMENT_METHOD_LABELS.unspecified
  const paymentType = resolvePaymentTypeLabel(row, metadata, paymentChannelId)

  return {
    paymentMethodCategoryId,
    paymentMethodCategory,
    paymentType,
    paymentChannelId,
    paymentChannel: getPaymentChannelLabel(paymentChannelId)
  }
}
