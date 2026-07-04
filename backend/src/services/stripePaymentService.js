import Stripe from 'stripe'
import { DateTime } from 'luxon'
import { db, setAppConfig } from '../config/database.js'
import { decrypt, encrypt, isEncrypted } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'
import { updateSingleContactStats } from '../utils/updateContactsStats.js'
import { getAccountCurrency } from '../utils/accountLocale.js'
import { getPaymentPlanAuditSummary, hardDeleteTestPaymentPlan } from './paymentRecordSafetyService.js'
import { calculatePaymentTax, getPaymentGatewayMode, getPaymentSettings, getPublicPaymentSettings } from './paymentSettingsService.js'
import { queuePaymentAutomationMessage } from './paymentAutomationsService.js'
import { registerGigstackPaymentForTransactionInBackground } from './gigstackInvoiceService.js'
import { dispatchProductPostWebhooksForPaymentInBackground } from './productPostWebhookService.js'
import { sendPaymentNotification } from './pushNotificationsService.js'
import { mapGatewayPaymentStatus } from './paymentGatewayStatusPolicy.js'
import {
  buildMetaPublicPurchasePixelEvent,
  triggerMetaPaymentPurchaseEvent
} from './metaConversionEventsService.js'
import { createPublicPaymentId, createRistakPaymentEntityId } from '../utils/idGenerator.js'
import {
  DEFAULT_TIMEZONE as ACCOUNT_DEFAULT_TIMEZONE,
  assertDateOnlyNotInPast,
  assertLocalDateTimeNotInPast,
  businessTodayDateOnly,
  getAccountTimezone,
  normalizeDateOnlyInTimezone,
  normalizeToUtcIso,
  resolveTimezone
} from '../utils/dateUtils.js'

const CONFIG_KEYS = {
  enabled: 'stripe_enabled',
  mode: 'stripe_mode',
  publishableKey: 'stripe_publishable_key',
  secretKey: 'stripe_secret_key_encrypted',
  webhookSecret: 'stripe_webhook_secret_encrypted',
  manualModeConnections: 'stripe_manual_mode_connections',
  defaultCurrency: 'stripe_default_currency',
  accountLabel: 'stripe_account_label',
  disconnectedAt: 'stripe_disconnected_at'
}

const MASKED_PREFIX = '***'
const DEFAULT_CURRENCY = 'MXN'
const STRIPE_MODES = ['test', 'live']
const STRIPE_WEBHOOK_EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'payment_intent.processing',
  'payment_intent.requires_action',
  'checkout.session.completed',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'charge.refunded',
  'refund.created'
]
const STRIPE_WEBHOOK_DESCRIPTION = 'Ristak - Pagos'
const STRIPE_WEBHOOK_METADATA = { ristak: 'payment_webhook' }
const isPostgresRuntime = Boolean(process.env.DATABASE_URL)
const DEFAULT_PAYMENT_TIMEZONE = ACCOUNT_DEFAULT_TIMEZONE
const STRIPE_PLAN_STATES = {
  DRAFT: 'draft',
  FIRST_PAYMENT_PENDING: 'first_payment_pending',
  WAITING_CARD_AUTHORIZATION: 'waiting_card_authorization',
  CARD_AUTHORIZED: 'card_authorized',
  INSTALLMENT_PLAN_CREATED: 'installment_plan_created',
  INSTALLMENT_PLAN_ACTIVE: 'installment_plan_active',
  PAUSED: 'paused',
  DELETED: 'deleted',
  CANCELLED: 'cancelled'
}
const FIRST_PAYMENT_PLAN_TRIGGERS = new Set(['first_payment', 'first_payment_saved_card'])
const CARD_SETUP_PLAN_TRIGGERS = new Set(['card_setup', 'card_setup_authorization'])
const SUCCESSFUL_PAYMENT_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'captured'])
const LOCKED_PLAN_PAYMENT_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'refunded', 'void', 'deleted', 'cancelled', 'canceled'])
const AUTOMATIC_PLAN_PAYMENT_METHODS = new Set(['', 'stripe_auto', 'stripe_saved_card', 'stripe_pending_card', 'stripe_scheduled_card', 'card', 'payment_link', 'direct_card', 'saved_card'])
const MANUAL_PLAN_PAYMENT_METHODS = new Set(['cash', 'bank_transfer', 'transfer', 'deposit', 'check', 'other', 'manual', 'offline'])
const TIMED_PLAN_FREQUENCY = 'scheduled_time'
const TIMED_PLAN_FREQUENCY_ALIASES = new Set([TIMED_PLAN_FREQUENCY, 'scheduled-time', 'scheduledat', 'scheduled_at', 'timed', 'datetime'])
const PLAN_FREQUENCIES = new Set(['custom', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly', TIMED_PLAN_FREQUENCY])
const STRIPE_INSTALLMENT_MIN_AMOUNT = 300
const STRIPE_INSTALLMENT_COUNTS = [3, 6, 9, 12, 18, 24]
const STRIPE_INSTALLMENT_COUNT_SET = new Set(STRIPE_INSTALLMENT_COUNTS)
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf',
  'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'
])

let stripeFactoryForTest = null

export function setStripeFactoryForTest(factory) {
  stripeFactoryForTest = typeof factory === 'function' ? factory : null
}

function cleanString(value) {
  return String(value || '').trim()
}

function normalizeWebhookUrl(value) {
  const clean = cleanString(value).replace(/\/+$/, '')
  if (!clean) return ''
  try {
    const parsed = new URL(clean)
    if (parsed.protocol !== 'https:') return ''
    const host = parsed.hostname.toLowerCase()
    if (['localhost', '127.0.0.1', '::1'].includes(host) || host.endsWith('.local')) return ''
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function sameEventSet(left = [], right = []) {
  const leftSet = new Set((left || []).map(cleanString).filter(Boolean))
  const rightSet = new Set((right || []).map(cleanString).filter(Boolean))
  if (leftSet.size !== rightSet.size) return false
  for (const item of leftSet) {
    if (!rightSet.has(item)) return false
  }
  return true
}

function shouldIgnorePendingWebhookRegression(payment = {}, nextStatus = '') {
  if (nextStatus !== 'pending') return false
  const currentStatus = cleanString(payment.status).toLowerCase()
  return SUCCESSFUL_PAYMENT_STATUSES.has(currentStatus) || Boolean(payment.paid_at)
}

function shouldSendStripeReceiptEmail(paymentSettings = {}) {
  if (paymentSettings.automations?.receiptDeliveryEnabled === false) return false
  const channel = cleanString(paymentSettings.automations?.receiptDeliveryChannel || 'email').toLowerCase()
  return channel === 'email' || channel === 'both'
}

function getStripeInstance(secretKey) {
  return stripeFactoryForTest ? stripeFactoryForTest(secretKey) : new Stripe(secretKey)
}

function timestampPlaceholder() {
  return isPostgresRuntime ? '?::timestamp' : '?'
}

function dateOnlySql(expression) {
  return isPostgresRuntime ? `(${expression})::date` : `DATE(${expression})`
}

function dateOnlyPlaceholder() {
  return isPostgresRuntime ? '?::date' : 'DATE(?)'
}

function timestampSql(expression) {
  return isPostgresRuntime ? expression : `datetime(${expression})`
}

function timestampComparisonPlaceholder() {
  return isPostgresRuntime ? '?::timestamp' : 'datetime(?)'
}

function staleProcessingSql(column) {
  return isPostgresRuntime
    ? `${column} < CURRENT_TIMESTAMP - INTERVAL '10 minutes'`
    : `${column} < datetime('now', '-10 minutes')`
}

function stripeRequestOptionsWithIdempotency(requestOptions, idempotencyKey) {
  return {
    ...(requestOptions || {}),
    idempotencyKey
  }
}

function normalizeCurrency(value) {
  const currency = cleanString(value || DEFAULT_CURRENCY).toUpperCase()
  return /^[A-Z]{3}$/.test(currency) ? currency : DEFAULT_CURRENCY
}

async function getConfiguredCurrency() {
  try {
    return normalizeCurrency(await getAccountCurrency())
  } catch {
    return DEFAULT_CURRENCY
  }
}

function normalizeMode(value) {
  return value === 'live' ? 'live' : 'test'
}

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase())
}

function normalizeDateOnly(value, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  return normalizeDateOnlyInTimezone(value, timezone)
}

function todayDateOnly(timezone = DEFAULT_PAYMENT_TIMEZONE) {
  return businessTodayDateOnly(timezone)
}

function isDueTodayOrPast(value, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  return normalizeDateOnly(value, timezone) <= todayDateOnly(timezone)
}

function hasExplicitPlanTime(value) {
  const clean = cleanString(value)
  const match = clean.match(/[T ](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!match) return false
  return !(match[1] === '00' && match[2] === '00' && (!match[3] || match[3] === '00'))
}

function getCurrentBusinessPlanTime(timezone = DEFAULT_PAYMENT_TIMEZONE, referenceDate = new Date()) {
  return DateTime.fromJSDate(referenceDate instanceof Date ? referenceDate : new Date(referenceDate), {
    zone: resolveTimezone(timezone)
  })
    .set({ millisecond: 0 })
    .toFormat('HH:mm:ss')
}

function withDefaultPlanTime(value, timezone = DEFAULT_PAYMENT_TIMEZONE, referenceDate = new Date()) {
  if (value === null || value === undefined || value === '') return value
  if (hasExplicitPlanTime(value)) return value
  const date = normalizeDateOnly(value, timezone)
  return `${date}T${getCurrentBusinessPlanTime(timezone, referenceDate)}`
}

function shouldUseExactPlanTime(value, frequency) {
  return isTimedPlanFrequency(frequency) || hasExplicitPlanTime(value)
}

function isPlanChargeDueNow(value, frequency, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  if (!value) return false
  if (!shouldUseExactPlanTime(value, frequency)) {
    return isDueTodayOrPast(value, timezone)
  }

  const utcIso = normalizeToUtcIso(value, timezone)
  const timestamp = Date.parse(utcIso)
  return Number.isFinite(timestamp) && timestamp <= Date.now()
}

function assertDateNotInPast(value, message, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  return assertDateOnlyNotInPast(value, timezone, message)
}

function normalizePlanFrequency(value, fallback = 'custom') {
  const normalized = cleanString(value || fallback).toLowerCase().replace(/[\s-]+/g, '_')
  if (TIMED_PLAN_FREQUENCY_ALIASES.has(normalized)) return TIMED_PLAN_FREQUENCY
  return PLAN_FREQUENCIES.has(normalized) ? normalized : fallback
}

function isTimedPlanFrequency(value) {
  return normalizePlanFrequency(value) === TIMED_PLAN_FREQUENCY
}

function assertPlanDueDateNotInPast(value, frequency, message, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  const dueValue = withDefaultPlanTime(value, timezone)
  if (!shouldUseExactPlanTime(dueValue, frequency)) return assertDateNotInPast(dueValue, message, timezone)
  return assertLocalDateTimeNotInPast(dueValue, timezone, message)
}

function normalizePlanDueDate(value, frequency, timezone = DEFAULT_PAYMENT_TIMEZONE, referenceDate = new Date()) {
  const dueValue = withDefaultPlanTime(value, timezone, referenceDate)
  if (shouldUseExactPlanTime(dueValue, frequency)) return normalizeToUtcIso(dueValue, timezone)
  return normalizeDateOnly(dueValue, timezone)
}

function hasStoredExplicitPlanTimeSql(expression) {
  if (isPostgresRuntime) {
    const textExpression = `COALESCE((${expression})::text, '')`
    return `(${textExpression} ~ '[ T][0-9]{2}:[0-9]{2}' AND ${textExpression} !~ '[ T]00:00(?::00(?:\\.0+)?)?$')`
  }
  return `COALESCE(time(${expression}), '00:00:00') <> '00:00:00'`
}

function duePlanInstallmentCondition(alias = 'i') {
  const frequencySql = `LOWER(COALESCE(${alias}.frequency, 'custom'))`
  const timedFrequencySql = `(${frequencySql} = '${TIMED_PLAN_FREQUENCY}' OR ${hasStoredExplicitPlanTimeSql(`${alias}.due_date`)})`
  const timedDueSql = `${timestampSql(`${alias}.due_date`)} <= ${timestampComparisonPlaceholder()}`
  const dateDueSql = `${dateOnlySql(`${alias}.due_date`)} <= ${dateOnlyPlaceholder()}`
  return `((${timedFrequencySql} AND ${timedDueSql}) OR (NOT ${timedFrequencySql} AND ${dateDueSql}))`
}

function duePlanFirstPaymentCondition(expression) {
  const hasExplicitTimeSql = hasStoredExplicitPlanTimeSql(expression)
  const timedDueSql = `${timestampSql(expression)} <= ${timestampComparisonPlaceholder()}`
  const dateDueSql = `${dateOnlySql(expression)} <= ${dateOnlyPlaceholder()}`
  return `((${hasExplicitTimeSql} AND ${timedDueSql}) OR (NOT ${hasExplicitTimeSql} AND ${dateDueSql}))`
}

function isMaskedSecret(value) {
  return cleanString(value).startsWith(MASKED_PREFIX)
}

function maskSecret(value) {
  const clean = cleanString(value)
  if (!clean) return ''
  return `${MASKED_PREFIX}${clean.slice(-8)}`
}

function createId(prefix) {
  return createRistakPaymentEntityId(prefix)
}

function createPublicId() {
  return createPublicPaymentId()
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function getPublicSubscriptionStart(metadata = {}) {
  const start = metadata?.subscriptionStart && typeof metadata.subscriptionStart === 'object'
    ? metadata.subscriptionStart
    : null
  const subscriptionId = cleanString(start?.subscriptionId || metadata?.ristakSubscriptionId || metadata?.ristak_subscription_id)
  if (!subscriptionId) return null

  return {
    subscriptionId,
    paymentProvider: cleanString(start?.paymentProvider),
    paymentMethod: cleanString(start?.paymentMethod),
    intervalType: cleanString(start?.intervalType),
    intervalCount: Number.parseInt(start?.intervalCount, 10) || 1,
    startDate: cleanString(start?.startDate) || null,
    nextRunAt: cleanString(start?.nextRunAt) || null,
    cancelAt: cleanString(start?.cancelAt) || null
  }
}

function decryptSecret(value) {
  const clean = cleanString(value)
  if (!clean) return ''
  return isEncrypted(clean) ? decrypt(clean) : clean
}

function encryptOptionalSecret(value) {
  const clean = cleanString(value)
  return clean ? encrypt(clean) : ''
}

function assertStripeSecret(secretKey) {
  const clean = cleanString(secretKey)
  if (!clean) return ''
  if (!/^sk_(test|live)_/.test(clean)) {
    const error = new Error('La Secret key de Stripe debe empezar con sk_test_ o sk_live_.')
    error.status = 400
    throw error
  }
  return clean
}

function assertStripePublishableKey(publishableKey) {
  const clean = cleanString(publishableKey)
  if (!clean) return ''
  if (!/^pk_(test|live)_/.test(clean)) {
    const error = new Error('La Publishable key de Stripe debe empezar con pk_test_ o pk_live_.')
    error.status = 400
    throw error
  }
  return clean
}

function toStripeAmount(amount, currency) {
  const normalized = Number(amount)
  if (!Number.isFinite(normalized) || normalized <= 0) {
    const error = new Error('El monto debe ser mayor a 0.')
    error.status = 400
    throw error
  }

  const code = normalizeCurrency(currency).toLowerCase()
  return ZERO_DECIMAL_CURRENCIES.has(code)
    ? Math.round(normalized)
    : Math.round(normalized * 100)
}

function toStripeFutureTimestamp(value, label = 'La fecha final de la suscripción') {
  const cleaned = cleanString(value)
  if (!cleaned) return null

  const date = new Date(cleaned)
  if (Number.isNaN(date.getTime())) {
    const error = new Error(`${label} no es válida.`)
    error.status = 400
    throw error
  }

  const timestamp = Math.floor(date.getTime() / 1000)
  if (timestamp <= Math.floor(Date.now() / 1000)) {
    const error = new Error(`${label} debe estar en el futuro.`)
    error.status = 400
    throw error
  }

  return timestamp
}

function fromStripeAmount(amount, currency) {
  const value = Number(amount || 0)
  const code = normalizeCurrency(currency).toLowerCase()
  return ZERO_DECIMAL_CURRENCIES.has(code) ? value : Math.round(value) / 100
}

function normalizePositiveAmount(value, fallback = 25) {
  const amount = Number(value)
  if (Number.isFinite(amount) && amount > 0) return Math.round(amount * 100) / 100
  return Math.round(Number(fallback || 25) * 100) / 100
}

function normalizeStripeInstallmentCount(value, fallback = 24) {
  const parsed = Math.trunc(Number(value || fallback))
  const source = Number.isFinite(parsed) ? parsed : fallback
  const allowed = STRIPE_INSTALLMENT_COUNTS.filter((count) => count <= source)
  return allowed.length ? allowed[allowed.length - 1] : STRIPE_INSTALLMENT_COUNTS[0]
}

function normalizeStripeInstallmentOptions(input, { amount = null, currency = DEFAULT_CURRENCY, emptyAsNull = false } = {}) {
  if (input === undefined || input === null || input === '' || input === false) {
    return emptyAsNull ? null : {
      enabled: false,
      label: 'Pago de contado'
    }
  }

  const source = typeof input === 'object' && !Array.isArray(input)
    ? input
    : { enabled: true }
  const enabled = normalizeBoolean(source.enabled, true)

  if (!enabled) {
    return emptyAsNull ? null : {
      enabled: false,
      label: 'Pago de contado'
    }
  }

  const normalizedCurrency = normalizeCurrency(currency)
  if (normalizedCurrency !== 'MXN') {
    const error = new Error('Stripe sólo permite meses sin intereses en pagos con moneda MXN.')
    error.status = 400
    throw error
  }

  const parsedAmount = Number(amount)
  if (Number.isFinite(parsedAmount) && parsedAmount < STRIPE_INSTALLMENT_MIN_AMOUNT) {
    const error = new Error(`Para ofrecer meses sin intereses en Stripe, el monto mínimo es ${STRIPE_INSTALLMENT_MIN_AMOUNT} MXN.`)
    error.status = 400
    throw error
  }

  const maxInstallments = normalizeStripeInstallmentCount(
    source.maxInstallments || source.max_installments || source.months || source.count || source.installments,
    24
  )

  return {
    enabled: true,
    minAmount: STRIPE_INSTALLMENT_MIN_AMOUNT,
    maxInstallments,
    allowedCounts: STRIPE_INSTALLMENT_COUNTS.filter((count) => count <= maxInstallments),
    label: 'Meses sin intereses',
    provider: 'stripe',
    selectionMode: 'stripe_controlled_installments'
  }
}

function normalizeStripeAvailableInstallmentPlans(plans, stripeInstallments = null) {
  const maxInstallments = normalizeStripeInstallmentCount(stripeInstallments?.maxInstallments || 24, 24)
  return (Array.isArray(plans) ? plans : [])
    .map((plan) => ({
      type: cleanString(plan?.type || 'fixed_count') || 'fixed_count',
      interval: cleanString(plan?.interval || 'month') || 'month',
      count: Math.trunc(Number(plan?.count || 0))
    }))
    .filter((plan) => (
      plan.type === 'fixed_count' &&
      plan.interval === 'month' &&
      STRIPE_INSTALLMENT_COUNT_SET.has(plan.count) &&
      plan.count <= maxInstallments
    ))
    .sort((left, right) => left.count - right.count)
}

function getStripeIntentAvailablePlans(intent, stripeInstallments = null) {
  return normalizeStripeAvailableInstallmentPlans(
    intent?.payment_method_options?.card?.installments?.available_plans,
    stripeInstallments
  )
}

function extractStripeObjectId(value) {
  if (!value) return ''
  if (typeof value === 'string') return cleanString(value)
  return cleanString(value.id)
}

function extractInvoicePaymentIntentId(invoice) {
  const directPaymentIntentId = extractStripeObjectId(invoice?.payment_intent)
  if (directPaymentIntentId) return directPaymentIntentId

  const invoicePayments = Array.isArray(invoice?.payments?.data) ? invoice.payments.data : []
  for (const invoicePayment of invoicePayments) {
    const paymentIntentId = extractStripeObjectId(invoicePayment?.payment_intent)
      || extractStripeObjectId(invoicePayment?.payment?.payment_intent)

    if (paymentIntentId) return paymentIntentId

    if (invoicePayment?.payment?.type === 'payment_intent') {
      const paymentId = extractStripeObjectId(invoicePayment.payment)
      if (paymentId.startsWith('pi_')) return paymentId
    }
  }

  return ''
}

function timestampToIso(timestamp) {
  if (timestamp instanceof Date) {
    return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString()
  }

  if (typeof timestamp === 'string') {
    const clean = timestamp.trim()
    if (!clean) return null

    const numeric = Number(clean)
    if (Number.isFinite(numeric) && numeric > 0) {
      const milliseconds = numeric > 9999999999 ? numeric : numeric * 1000
      return new Date(milliseconds).toISOString()
    }

    const parsed = new Date(clean)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }

  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const milliseconds = seconds > 9999999999 ? seconds : seconds * 1000
  return new Date(milliseconds).toISOString()
}

function buildPaymentUrl(baseUrl, publicPaymentId) {
  const cleanBase = cleanString(baseUrl).replace(/\/+$/, '')
  return `${cleanBase}/pay/${encodeURIComponent(publicPaymentId)}`
}

function getConfiguredBaseUrl() {
  return cleanString(
    process.env.PUBLIC_APP_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    process.env.PUBLIC_URL ||
    process.env.APP_URL
  )
}

function buildSubscriptionReturnUrl(baseUrl, result, publicPaymentId = '') {
  const cleanBase = cleanString(baseUrl || getConfiguredBaseUrl()).replace(/\/+$/, '') || 'https://www.ristak.com'
  const cleanPublicPaymentId = cleanString(publicPaymentId)
  if (cleanPublicPaymentId) {
    return `${cleanBase}/pay/${encodeURIComponent(cleanPublicPaymentId)}?payment=success&stripe_subscription=${encodeURIComponent(result)}&session_id={CHECKOUT_SESSION_ID}`
  }
  const checkoutSessionParam = result === 'success' ? '&session_id={CHECKOUT_SESSION_ID}' : ''
  return `${cleanBase}/pay/success?provider=stripe&type=subscription&result=${encodeURIComponent(result)}${checkoutSessionParam}`
}

async function readRawConfig() {
  const configKeys = Object.values(CONFIG_KEYS)
  const rows = await db.all(
    `SELECT config_key, config_value FROM app_config
     WHERE config_key IN (${configKeys.map(() => '?').join(', ')})`,
    configKeys
  )

  const values = {}
  for (const row of rows || []) {
    values[row.config_key] = row.config_value
  }
  return values
}

function normalizeStoredManualConnection(value = {}, mode = 'test') {
  if (!value || typeof value !== 'object') {
    return {
      mode: normalizeMode(mode),
      publishableKey: '',
      secretKey: '',
      webhookSecret: '',
      webhookEndpointId: '',
      webhookUrl: '',
      webhookStatus: '',
      webhookSyncedAt: '',
      webhookLastError: ''
    }
  }

  return {
    mode: normalizeMode(value.mode || mode),
    publishableKey: cleanString(value.publishableKey || value.publishable_key),
    secretKey: value.secretKey || value.secret_key ? decryptSecret(value.secretKey || value.secret_key) : '',
    webhookSecret: value.webhookSecret || value.webhook_secret ? decryptSecret(value.webhookSecret || value.webhook_secret) : '',
    webhookEndpointId: cleanString(value.webhookEndpointId || value.webhook_endpoint_id),
    webhookUrl: cleanString(value.webhookUrl || value.webhook_url),
    webhookStatus: cleanString(value.webhookStatus || value.webhook_status),
    webhookSyncedAt: cleanString(value.webhookSyncedAt || value.webhook_synced_at),
    webhookLastError: cleanString(value.webhookLastError || value.webhook_last_error),
    updatedAt: cleanString(value.updatedAt || value.updated_at)
  }
}

function legacyManualConnectionFromRaw(raw = {}, mode = 'test') {
  const normalizedMode = normalizeMode(raw[CONFIG_KEYS.mode] || mode)
  return normalizeStoredManualConnection({
    mode: normalizedMode,
    publishableKey: cleanString(raw[CONFIG_KEYS.publishableKey]),
    secretKey: raw[CONFIG_KEYS.secretKey] ? decryptSecret(raw[CONFIG_KEYS.secretKey]) : '',
    webhookSecret: raw[CONFIG_KEYS.webhookSecret] ? decryptSecret(raw[CONFIG_KEYS.webhookSecret]) : ''
  }, normalizedMode)
}

function readManualModeConnections(raw = {}) {
  const parsed = parseJson(raw[CONFIG_KEYS.manualModeConnections], {})
  const connections = {
    test: normalizeStoredManualConnection(parsed.test, 'test'),
    live: normalizeStoredManualConnection(parsed.live, 'live')
  }

  const legacy = legacyManualConnectionFromRaw(raw, raw[CONFIG_KEYS.mode])
  if ((legacy.publishableKey || legacy.secretKey || legacy.webhookSecret) && !connections[legacy.mode].publishableKey && !connections[legacy.mode].secretKey) {
    connections[legacy.mode] = legacy
  }

  return connections
}

function summarizeManualModeConnection(connection = {}, includeSecrets = false) {
  const publishableKey = cleanString(connection.publishableKey)
  const secretKey = cleanString(connection.secretKey)
  const webhookSecret = cleanString(connection.webhookSecret)

  return {
    mode: normalizeMode(connection.mode),
    configured: Boolean(publishableKey && secretKey),
    publishableKey,
    hasSecretKey: Boolean(secretKey),
    secretKeyPreview: maskSecret(secretKey),
    hasWebhookSecret: Boolean(webhookSecret),
    webhookSecretPreview: maskSecret(webhookSecret),
    webhookEndpointId: cleanString(connection.webhookEndpointId),
    webhookUrl: cleanString(connection.webhookUrl),
    webhookStatus: cleanString(connection.webhookStatus || (webhookSecret ? 'configured' : 'pending')),
    webhookSyncedAt: cleanString(connection.webhookSyncedAt),
    webhookLastError: cleanString(connection.webhookLastError),
    webhookConfigured: Boolean(webhookSecret && (connection.webhookEndpointId || connection.webhookUrl)),
    updatedAt: cleanString(connection.updatedAt),
    ...(includeSecrets ? { secretKey, webhookSecret } : {})
  }
}

function getManualModeInputValue(raw = {}, key, currentValue = '') {
  if (Object.prototype.hasOwnProperty.call(raw, key)) return cleanString(raw[key])
  return cleanString(currentValue)
}

function buildManualModeConnectionFromInput(mode, rawInput = {}, currentConnection = {}) {
  const normalizedMode = normalizeMode(mode)
  const publishableKey = assertStripePublishableKey(
    getManualModeInputValue(rawInput, 'publishableKey', currentConnection.publishableKey)
  )
  const secretInput = getManualModeInputValue(rawInput, 'secretKey', currentConnection.secretKey)
  const secretKey = isMaskedSecret(secretInput)
    ? cleanString(currentConnection.secretKey)
    : assertStripeSecret(secretInput)
  const webhookInput = getManualModeInputValue(rawInput, 'webhookSecret', currentConnection.webhookSecret)
  const webhookSecret = isMaskedSecret(webhookInput)
    ? cleanString(currentConnection.webhookSecret)
    : cleanString(webhookInput)
  const hasAny = Boolean(publishableKey || secretKey || webhookSecret)

  if (publishableKey && !publishableKey.startsWith(`pk_${normalizedMode}_`)) {
    const error = new Error(`La Publishable key de modo ${normalizedMode === 'live' ? 'en vivo' : 'prueba'} debe empezar con pk_${normalizedMode}_.`)
    error.status = 400
    throw error
  }

  if (secretKey && !secretKey.startsWith(`sk_${normalizedMode}_`)) {
    const error = new Error(`La Secret key de modo ${normalizedMode === 'live' ? 'en vivo' : 'prueba'} debe empezar con sk_${normalizedMode}_.`)
    error.status = 400
    throw error
  }

  if (hasAny && (!publishableKey || !secretKey)) {
    const error = new Error(`Completa Publishable key y Secret key en modo ${normalizedMode === 'live' ? 'en vivo' : 'prueba'}.`)
    error.status = 400
    throw error
  }

  return {
    mode: normalizedMode,
    publishableKey,
    secretKey,
    webhookSecret,
    webhookEndpointId: hasAny ? cleanString(currentConnection.webhookEndpointId) : '',
    webhookUrl: hasAny ? cleanString(currentConnection.webhookUrl) : '',
    webhookStatus: hasAny ? cleanString(currentConnection.webhookStatus) : '',
    webhookSyncedAt: hasAny ? cleanString(currentConnection.webhookSyncedAt) : '',
    webhookLastError: hasAny ? cleanString(currentConnection.webhookLastError) : '',
    updatedAt: hasAny ? new Date().toISOString() : ''
  }
}

function serializeManualModeConnection(connection = {}) {
  return {
    mode: normalizeMode(connection.mode),
    publishableKey: cleanString(connection.publishableKey),
    secretKey: encryptOptionalSecret(connection.secretKey),
    webhookSecret: encryptOptionalSecret(connection.webhookSecret),
    webhookEndpointId: cleanString(connection.webhookEndpointId),
    webhookUrl: cleanString(connection.webhookUrl),
    webhookStatus: cleanString(connection.webhookStatus),
    webhookSyncedAt: cleanString(connection.webhookSyncedAt),
    webhookLastError: cleanString(connection.webhookLastError),
    updatedAt: cleanString(connection.updatedAt)
  }
}

function chooseManualMode(connections = {}, preferredMode = '') {
  const normalizedPreferred = normalizeMode(preferredMode)
  if (connections[normalizedPreferred]?.publishableKey && connections[normalizedPreferred]?.secretKey) {
    return normalizedPreferred
  }
  if (connections.live?.publishableKey && connections.live?.secretKey) return 'live'
  if (connections.test?.publishableKey && connections.test?.secretKey) return 'test'
  return normalizedPreferred
}

async function syncStripeWebhookForConnection(connection = {}, webhookUrl = '') {
  const normalizedUrl = normalizeWebhookUrl(webhookUrl)
  if (!connection.publishableKey || !connection.secretKey) return connection

  if (!normalizedUrl) {
    return {
      ...connection,
      webhookStatus: connection.webhookSecret ? 'configured' : 'pending_public_url',
      webhookLastError: ''
    }
  }

  const stripe = getStripeInstance(assertStripeSecret(connection.secretKey))
  const existingList = await stripe.webhookEndpoints.list({ limit: 100 })
  const endpoints = existingList?.data || []
  const sameUrl = (endpoint) => cleanString(endpoint?.url).replace(/\/+$/, '').toLowerCase() === normalizedUrl.toLowerCase()
  const sameRistakWebhook = (endpoint) => (
    endpoint?.metadata?.ristak === STRIPE_WEBHOOK_METADATA.ristak &&
    endpoint?.metadata?.mode === normalizeMode(connection.mode)
  )
  const existing = endpoints.find((endpoint) => cleanString(endpoint?.id) === cleanString(connection.webhookEndpointId)) ||
    endpoints.find((endpoint) => sameUrl(endpoint) && sameRistakWebhook(endpoint)) ||
    (connection.webhookSecret ? endpoints.find(sameUrl) : null)

  if (existing?.id) {
    const needsEventUpdate = !sameEventSet(existing.enabled_events, STRIPE_WEBHOOK_EVENTS)
    const needsUrlUpdate = cleanString(existing.url).replace(/\/+$/, '') !== normalizedUrl
    const needsMetadataUpdate = !sameRistakWebhook(existing)
    if (needsEventUpdate || needsUrlUpdate || existing.description !== STRIPE_WEBHOOK_DESCRIPTION || needsMetadataUpdate) {
      await stripe.webhookEndpoints.update(existing.id, {
        url: normalizedUrl,
        enabled_events: STRIPE_WEBHOOK_EVENTS,
        disabled: false,
        description: STRIPE_WEBHOOK_DESCRIPTION,
        metadata: {
          ...STRIPE_WEBHOOK_METADATA,
          mode: normalizeMode(connection.mode)
        }
      })
    }

    return {
      ...connection,
      webhookEndpointId: existing.id,
      webhookUrl: normalizedUrl,
      webhookStatus: existing.status || 'enabled',
      webhookSyncedAt: new Date().toISOString(),
      webhookLastError: ''
    }
  }

  const created = await stripe.webhookEndpoints.create({
    url: normalizedUrl,
    enabled_events: STRIPE_WEBHOOK_EVENTS,
    description: STRIPE_WEBHOOK_DESCRIPTION,
    metadata: {
      ...STRIPE_WEBHOOK_METADATA,
      mode: normalizeMode(connection.mode)
    }
  })

  return {
    ...connection,
    webhookSecret: cleanString(created?.secret) || connection.webhookSecret,
    webhookEndpointId: cleanString(created?.id),
    webhookUrl: normalizedUrl,
    webhookStatus: cleanString(created?.status || 'enabled'),
    webhookSyncedAt: new Date().toISOString(),
    webhookLastError: ''
  }
}

async function syncStripeWebhooksForConnections(connections = {}, webhookUrl = '') {
  const next = { ...connections }

  for (const mode of STRIPE_MODES) {
    const connection = next[mode]
    if (!connection?.publishableKey || !connection?.secretKey) continue
    next[mode] = await syncStripeWebhookForConnection(connection, webhookUrl)
  }

  return next
}

export async function getStripePaymentConfig({ includeSecrets = false, mode: modeOverride = '' } = {}) {
  const raw = await readRawConfig()
  const accountCurrency = await getConfiguredCurrency()
  const manualModeConnections = readManualModeConnections(raw)
  const preferredMode = modeOverride || await getPaymentGatewayMode()
  const mode = modeOverride
    ? normalizeMode(modeOverride)
    : normalizeMode(preferredMode)
  const selectedManualConnection = manualModeConnections[mode] || normalizeStoredManualConnection({}, mode)
  const publishableKey = cleanString(selectedManualConnection.publishableKey)
  const secretKey = cleanString(selectedManualConnection.secretKey)
  const webhookSecret = cleanString(selectedManualConnection.webhookSecret)
  const enabled = normalizeBoolean(raw[CONFIG_KEYS.enabled], true)
  const configured = Boolean(enabled && publishableKey && secretKey)
  const configurationStatus = configured
    ? 'configured_manually'
    : cleanString(raw[CONFIG_KEYS.disconnectedAt])
      ? 'disconnected'
      : 'not_configured'

  return {
    enabled,
    configured,
    connectionType: 'manual',
    configurationStatus,
    mode,
    defaultCurrency: accountCurrency,
    accountLabel: cleanString(raw[CONFIG_KEYS.accountLabel] || 'Stripe'),
    publishableKey,
    hasSecretKey: Boolean(secretKey),
    secretKeyPreview: maskSecret(secretKey),
    hasWebhookSecret: Boolean(webhookSecret),
    webhookSecretPreview: maskSecret(webhookSecret),
    webhookEndpointId: cleanString(selectedManualConnection.webhookEndpointId),
    webhookUrl: cleanString(selectedManualConnection.webhookUrl),
    webhookStatus: cleanString(selectedManualConnection.webhookStatus || (webhookSecret ? 'configured' : 'pending')),
    webhookSyncedAt: cleanString(selectedManualConnection.webhookSyncedAt),
    webhookLastError: cleanString(selectedManualConnection.webhookLastError),
    webhookConfigured: Boolean(webhookSecret && (selectedManualConnection.webhookEndpointId || selectedManualConnection.webhookUrl)),
    manualModes: {
      test: summarizeManualModeConnection(manualModeConnections.test, includeSecrets),
      live: summarizeManualModeConnection(manualModeConnections.live, includeSecrets)
    },
    ...(includeSecrets
      ? {
          secretKey,
          webhookSecret
        }
      : {})
  }
}

export async function saveStripePaymentConfig(input = {}, options = {}) {
  const current = await getStripePaymentConfig({ includeSecrets: true })
  const accountCurrency = await getConfiguredCurrency()
  const manualInput = input.manualModes && typeof input.manualModes === 'object'
    ? input.manualModes
    : {
        [normalizeMode(input.mode)]: {
          publishableKey: input.publishableKey,
          secretKey: input.secretKey,
          webhookSecret: input.webhookSecret
        }
      }
  const currentManualModes = current.manualModes || {
    test: normalizeStoredManualConnection({}, 'test'),
    live: normalizeStoredManualConnection({}, 'live')
  }
  let nextManualModes = {
    test: buildManualModeConnectionFromInput('test', manualInput.test, currentManualModes.test),
    live: buildManualModeConnectionFromInput('live', manualInput.live, currentManualModes.live)
  }

  if (Object.prototype.hasOwnProperty.call(options, 'webhookUrl')) {
    nextManualModes = await syncStripeWebhooksForConnections(nextManualModes, options.webhookUrl)
  }

  const activeMode = chooseManualMode(nextManualModes, input.mode || 'live')
  const activeConnection = nextManualModes[activeMode]

  if (!activeConnection.publishableKey || !activeConnection.secretKey) {
    const error = new Error('Agrega al menos las llaves de prueba o las llaves en vivo de Stripe.')
    error.status = 400
    throw error
  }

  await setAppConfig(CONFIG_KEYS.enabled, normalizeBoolean(input.enabled, true) ? '1' : '0')
  await setAppConfig(CONFIG_KEYS.mode, activeMode)
  await setAppConfig(CONFIG_KEYS.publishableKey, activeConnection.publishableKey)
  await setAppConfig(CONFIG_KEYS.defaultCurrency, accountCurrency)
  await setAppConfig(CONFIG_KEYS.accountLabel, cleanString(input.accountLabel || current.accountLabel || 'Stripe'))
  await setAppConfig(CONFIG_KEYS.manualModeConnections, JSON.stringify({
    test: serializeManualModeConnection(nextManualModes.test),
    live: serializeManualModeConnection(nextManualModes.live)
  }))
  await db.run('DELETE FROM app_config WHERE config_key = ?', [CONFIG_KEYS.disconnectedAt])

  if (activeConnection.secretKey) {
    await setAppConfig(CONFIG_KEYS.secretKey, encrypt(activeConnection.secretKey))
  } else {
    await db.run('DELETE FROM app_config WHERE config_key = ?', [CONFIG_KEYS.secretKey])
  }

  if (activeConnection.webhookSecret) {
    await setAppConfig(CONFIG_KEYS.webhookSecret, encrypt(activeConnection.webhookSecret))
  } else {
    await db.run('DELETE FROM app_config WHERE config_key = ?', [CONFIG_KEYS.webhookSecret])
  }

  return getStripePaymentConfig()
}

export async function deleteStripePaymentConfig() {
  const configKeys = Object.values(CONFIG_KEYS)
  await db.run(
    `DELETE FROM app_config WHERE config_key IN (${configKeys.map(() => '?').join(', ')})`,
    configKeys
  )
  await setAppConfig(CONFIG_KEYS.disconnectedAt, new Date().toISOString())
  return getStripePaymentConfig()
}

export async function getStripeClient(mode = '') {
  const config = await getStripePaymentConfig({ includeSecrets: true, mode })
  if (!config.configured || !config.secretKey) {
    const error = new Error('Stripe no está configurado todavía. Guarda las llaves de Stripe primero.')
    error.status = 400
    throw error
  }

  return {
    config,
    stripe: getStripeInstance(config.secretKey),
    requestOptions: undefined
  }
}

export async function testStripePaymentConfig(input = null) {
  const current = await getStripePaymentConfig({ includeSecrets: true })
  if (input?.manualModes && typeof input.manualModes === 'object') {
    const currentManualModes = current.manualModes || {
      test: normalizeStoredManualConnection({}, 'test'),
      live: normalizeStoredManualConnection({}, 'live')
    }
    const nextManualModes = {
      test: buildManualModeConnectionFromInput('test', input.manualModes.test, currentManualModes.test),
      live: buildManualModeConnectionFromInput('live', input.manualModes.live, currentManualModes.live)
    }
    const results = {}

    for (const mode of STRIPE_MODES) {
      const connection = nextManualModes[mode]
      if (!connection.publishableKey && !connection.secretKey && !connection.webhookSecret) continue
      if (!connection.publishableKey || !connection.secretKey) continue

      const stripe = getStripeInstance(assertStripeSecret(connection.secretKey))
      const balance = await stripe.balance.retrieve()
      results[mode] = {
        ok: true,
        livemode: Boolean(balance.livemode),
        available: Array.isArray(balance.available) ? balance.available.length : 0
      }
    }

    const activeMode = chooseManualMode(nextManualModes, input.mode || 'live')
    if (!Object.keys(results).length) {
      const error = new Error('Agrega al menos una Secret key de Stripe para probar la conexión.')
      error.status = 400
      throw error
    }

    return {
      ok: true,
      mode: activeMode,
      connectionType: 'manual',
      livemode: Boolean(results[activeMode]?.livemode),
      available: results[activeMode]?.available || 0,
      modes: results
    }
  }

  const secretKey = input && !isMaskedSecret(input.secretKey)
    ? cleanString(input.secretKey)
    : current.secretKey
  const stripe = getStripeInstance(assertStripeSecret(secretKey))
  const balance = await stripe.balance.retrieve()
  return {
    ok: true,
    connectionType: 'manual',
    livemode: Boolean(balance.livemode),
    available: Array.isArray(balance.available) ? balance.available.length : 0
  }
}

async function findPaymentByPublicId(publicPaymentId) {
  return db.get(
    `SELECT
      p.*,
      c.full_name AS contact_name,
      c.email AS contact_email,
      c.phone AS contact_phone,
      c.stripe_customer_id AS contact_stripe_customer_id
     FROM payments p
     LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE p.public_payment_id = ?`,
    [publicPaymentId]
  )
}

function mapPublicPayment(row, config, baseUrl = '', settings = null, paymentPlan = null, timezone = ACCOUNT_DEFAULT_TIMEZONE) {
  if (!row) return null
  const metadata = parseJson(row.metadata_json, {})
  const tax = metadata.tax && typeof metadata.tax === 'object' ? metadata.tax : null
  const stripeInstallments = normalizeStripeInstallmentOptions(metadata.stripeInstallments, {
    amount: row.amount,
    currency: row.currency || config?.defaultCurrency || DEFAULT_CURRENCY,
    emptyAsNull: true
  })
  const subscriptionStart = getPublicSubscriptionStart(metadata)
  const publicPaymentId = row.public_payment_id
  return {
    id: row.id,
    publicPaymentId,
    paymentUrl: publicPaymentId && baseUrl ? buildPaymentUrl(baseUrl, publicPaymentId) : row.payment_url || '',
    status: row.status || 'pending',
    amount: Number(row.amount || 0),
    currency: row.currency || config?.defaultCurrency || DEFAULT_CURRENCY,
    title: row.title || 'Pago',
    description: row.description || '',
    dueDate: row.due_date || null,
    sentAt: row.sent_at || null,
    paidAt: row.paid_at || null,
    timezone,
    timeZone: timezone,
    paymentMode: row.payment_mode || config?.mode || 'test',
    provider: row.payment_provider || 'stripe',
    contact: {
      id: row.contact_id || '',
      name: row.contact_name || metadata.contactName || '',
      email: row.contact_email || metadata.contactEmail || '',
      phone: row.contact_phone || metadata.contactPhone || ''
    },
    stripePaymentIntentId: row.stripe_payment_intent_id || null,
    publishableKey: config?.publishableKey || '',
    stripeAccountId: '',
    stripeInstallments,
    subscriptionStart,
    tax,
    paymentPlan,
    settings: settings || null
  }
}

async function attachMetaPublicPurchaseEvent(publicPayment, row) {
  if (!publicPayment || !row) return publicPayment
  const metaPurchaseEvent = await buildMetaPublicPurchasePixelEvent({
    ...row,
    amount: publicPayment.amount,
    currency: publicPayment.currency,
    status: publicPayment.status,
    paymentUrl: publicPayment.paymentUrl,
    eventSourceUrl: publicPayment.paymentUrl
  })
  return metaPurchaseEvent ? { ...publicPayment, metaPurchaseEvent } : publicPayment
}

function normalizePublicPaymentPlanInstallment(installment = {}, addedIds = new Set()) {
  const id = cleanString(installment.id || installment.installmentId)
  return {
    id,
    sequence: Number(installment.sequence || 0),
    amount: Number(installment.amount || 0),
    percentage: installment.percentage ?? null,
    dueDate: installment.dueDate || null,
    status: installment.status || null,
    paymentId: installment.paymentId || null,
    paymentMethod: installment.paymentMethod || null,
    changeType: id && addedIds.has(id) ? 'added' : null
  }
}

async function buildPublicPaymentPlanSummary(row) {
  const metadata = parseJson(row?.metadata_json, {})
  const paymentPlanMetadata = metadata.paymentPlan && typeof metadata.paymentPlan === 'object'
    ? metadata.paymentPlan
    : null
  const flowId = cleanString(paymentPlanMetadata?.flowId)
  if (!flowId) return null

  let mirror = null
  try {
    mirror = await persistStripePaymentPlanMirror(flowId)
  } catch (error) {
    logger.warn(`No se pudo refrescar resumen público del plan Stripe ${flowId}: ${error.message}`)
  }
  if (!mirror) {
    mirror = await db.get('SELECT * FROM payment_plans WHERE id = ?', [flowId])
  }
  if (!mirror) return null

  const schedule = parseJson(mirror.schedule_json, {})
  const raw = parseJson(mirror.raw_json, {})
  const addedInstallments = Array.isArray(raw.addedInstallments) ? raw.addedInstallments : []
  const addedIds = new Set(addedInstallments.map((installment) => (
    cleanString(installment.id || installment.installmentId)
  )).filter(Boolean))
  const installments = Array.isArray(schedule.installments)
    ? schedule.installments.map((installment) => normalizePublicPaymentPlanInstallment(installment, addedIds))
    : []
  const firstPayment = schedule.firstPayment && Number(schedule.firstPayment.amount || 0) > 0
    ? {
        amount: Number(schedule.firstPayment.amount || 0),
        date: schedule.firstPayment.date || null,
        method: schedule.firstPayment.method || null,
        status: schedule.firstPayment.status || null,
        paymentId: schedule.firstPayment.paymentId || null
      }
    : null
  const addedInstallmentCount = Number(raw.addedInstallmentCount || addedInstallments.length || 0)

  return {
    provider: 'stripe',
    flowId,
    trigger: cleanString(paymentPlanMetadata.trigger),
    title: mirror.title || mirror.name || 'Plan de pagos',
    description: mirror.description || '',
    status: mirror.status || null,
    total: Number(mirror.total || 0),
    currency: mirror.currency || row.currency || DEFAULT_CURRENCY,
    remainingFrequency: schedule.remainingFrequency || null,
    recurrenceLabel: mirror.recurrence_label || getStripePlanRecurrenceLabel(schedule.remainingFrequency || 'custom'),
    cardSetupRequired: Boolean(schedule.cardSetupRequired),
    cardSetupStatus: schedule.cardSetupStatus || null,
    cardSetupAmount: Number(schedule.cardSetupAmount || 0),
    stripePaymentMethodLabel: schedule.stripePaymentMethodLabel || null,
    firstPayment,
    installments,
    changeSummary: addedInstallmentCount > 0
      ? {
          type: 'added_installments',
          label: `${addedInstallmentCount} ${addedInstallmentCount === 1 ? 'pago agregado' : 'pagos agregados'}`,
          addedInstallmentCount
        }
      : null
  }
}

function buildContactName(contact = {}, fallback = {}) {
  return cleanString(contact.full_name)
    || cleanString(`${contact.first_name || ''} ${contact.last_name || ''}`)
    || cleanString(fallback.contactName)
    || cleanString(fallback.name)
    || cleanString(contact.email)
    || cleanString(contact.phone)
    || 'Cliente Ristak'
}

async function getStripeContact(contactId) {
  const id = cleanString(contactId)
  if (!id) return null

  return db.get(
    `SELECT id, full_name, first_name, last_name, email, phone, stripe_customer_id
     FROM contacts
     WHERE id = ?`,
    [id]
  )
}

async function getStoredStripePaymentMethodRows(contactId, mode) {
  const cleanContactId = cleanString(contactId)
  if (!cleanContactId) return []

  return db.all(
    `SELECT *
     FROM stripe_payment_methods
     WHERE contact_id = ? AND mode = ?
     ORDER BY is_default DESC, updated_at DESC`,
    [cleanContactId, normalizeMode(mode)]
  )
}

async function getPreferredStripeCustomerIdForMode(contactId, mode) {
  const rows = await getStoredStripePaymentMethodRows(contactId, mode)
  return cleanString(rows[0]?.stripe_customer_id)
}

async function ensureStripeCustomerForContact(stripe, contactId, fallback = {}, requestOptions = undefined) {
  const contact = await getStripeContact(contactId)
  if (!contact) return null

  const stripeMode = normalizeMode(fallback.stripeMode || fallback.mode)
  const modeCustomerId = await getPreferredStripeCustomerIdForMode(contact.id, stripeMode)
  const existingCustomerId = modeCustomerId || cleanString(contact.stripe_customer_id)
  if (existingCustomerId) {
    try {
      await stripe.customers.retrieve(existingCustomerId, requestOptions)
      return existingCustomerId
    } catch (error) {
      if (error?.statusCode !== 404) throw error
    }
  }

  const customer = await stripe.customers.create(
    {
      name: buildContactName(contact, fallback),
      email: cleanString(contact.email || fallback.email || fallback.contactEmail) || undefined,
      phone: cleanString(contact.phone || fallback.phone || fallback.contactPhone) || undefined,
      metadata: {
        ristak_contact_id: contact.id
      }
    },
    requestOptions
  )

  await db.run(
    `UPDATE contacts
     SET stripe_customer_id = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [customer.id, contact.id]
  )

  return customer.id
}

function mapStripePaymentMethod(row) {
  if (!row) return null
  const brand = cleanString(row.brand).toUpperCase()
  const last4 = cleanString(row.last4)
  const expMonth = Number(row.exp_month || 0)
  const expYear = Number(row.exp_year || 0)

  return {
    id: row.id,
    contactId: row.contact_id || '',
    stripeCustomerId: row.stripe_customer_id,
    stripePaymentMethodId: row.stripe_payment_method_id,
    brand,
    last4,
    expMonth,
    expYear,
    funding: row.funding || '',
    country: row.country || '',
    mode: normalizeMode(row.mode),
    isDefault: Boolean(Number(row.is_default || 0)),
    label: `${brand || 'Tarjeta'} •••• ${last4 || '----'}`,
    expiresLabel: expMonth && expYear ? `${String(expMonth).padStart(2, '0')}/${String(expYear).slice(-2)}` : ''
  }
}

async function upsertStripePaymentMethod({ stripe, contactId, customerId, paymentMethodId, mode, makeDefault = true, requestOptions = undefined }) {
  const cleanPaymentMethodId = cleanString(paymentMethodId)
  const cleanCustomerId = extractStripeObjectId(customerId)
  if (!stripe || !cleanPaymentMethodId || !cleanCustomerId) return null

  const paymentMethod = await stripe.paymentMethods.retrieve(cleanPaymentMethodId, requestOptions)
  if (paymentMethod?.type !== 'card' || !paymentMethod.card) return null

  const existing = await db.get(
    'SELECT id FROM stripe_payment_methods WHERE stripe_payment_method_id = ?',
    [paymentMethod.id]
  )
  const id = existing?.id || createId('stripe_pm')
  const cleanContactId = cleanString(contactId) || null
  const normalizedMode = normalizeMode(mode)

  if (cleanContactId && makeDefault) {
    await db.run(
      `UPDATE stripe_payment_methods
       SET is_default = 0,
           updated_at = CURRENT_TIMESTAMP
       WHERE contact_id = ? AND mode = ?`,
      [cleanContactId, normalizedMode]
    )
  }

  await db.run(
    `INSERT INTO stripe_payment_methods (
      id, contact_id, stripe_customer_id, stripe_payment_method_id,
      brand, last4, exp_month, exp_year, funding, country, mode, is_default,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(stripe_payment_method_id) DO UPDATE SET
      contact_id = COALESCE(?, stripe_payment_methods.contact_id),
      stripe_customer_id = ?,
      brand = ?,
      last4 = ?,
      exp_month = ?,
      exp_year = ?,
      funding = ?,
      country = ?,
      mode = ?,
      is_default = CASE
        WHEN ? = 1 THEN ?
        ELSE stripe_payment_methods.is_default
      END,
      updated_at = CURRENT_TIMESTAMP`,
    [
      id,
      cleanContactId,
      cleanCustomerId,
      paymentMethod.id,
      cleanString(paymentMethod.card.brand),
      cleanString(paymentMethod.card.last4),
      Number(paymentMethod.card.exp_month || 0),
      Number(paymentMethod.card.exp_year || 0),
      cleanString(paymentMethod.card.funding),
      cleanString(paymentMethod.card.country),
      normalizedMode,
      makeDefault ? 1 : 0,
      cleanContactId,
      cleanCustomerId,
      cleanString(paymentMethod.card.brand),
      cleanString(paymentMethod.card.last4),
      Number(paymentMethod.card.exp_month || 0),
      Number(paymentMethod.card.exp_year || 0),
      cleanString(paymentMethod.card.funding),
      cleanString(paymentMethod.card.country),
      normalizedMode,
      makeDefault ? 1 : 0,
      makeDefault ? 1 : 0
    ]
  )

  return db.get('SELECT * FROM stripe_payment_methods WHERE stripe_payment_method_id = ?', [paymentMethod.id])
}

async function rememberStripePaymentMethodFromIntent(stripe, intent, paymentRow, config, requestOptions = undefined) {
  const paymentMethodId = extractStripeObjectId(intent?.payment_method)
  const customerId = extractStripeObjectId(intent?.customer) || cleanString(paymentRow?.stripe_customer_id)
  const contactId = cleanString(paymentRow?.contact_id)
  if (!contactId || !paymentMethodId || !customerId) return null

  await db.run(
    `UPDATE contacts
     SET stripe_customer_id = COALESCE(stripe_customer_id, ?),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [customerId, contactId]
  )

  return upsertStripePaymentMethod({
    stripe,
    contactId,
    customerId,
    paymentMethodId,
    mode: config?.mode,
    requestOptions
  })
}

async function resolveStripeCardSetupAmount(inputAmount) {
  const parsed = Number(inputAmount)
  if (Number.isFinite(parsed) && parsed > 0) return normalizePositiveAmount(parsed)

  try {
    const row = await db.get('SELECT card_setup_amount FROM highlevel_config LIMIT 1')
    return normalizePositiveAmount(row?.card_setup_amount, 25)
  } catch {
    return 25
  }
}

export async function createStripePaymentLink(input = {}, { baseUrl, mode = '' } = {}) {
  const { stripe, config, requestOptions } = await getStripeClient(mode)
  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error('El monto debe ser mayor a 0.')
    error.status = 400
    throw error
  }

  const paymentSettings = await getPublicPaymentSettings()
  const shouldApplyTax = input.applyTax !== false
  const taxSettings = {
    ...paymentSettings.taxes,
    enabled: Boolean(paymentSettings.taxes?.enabled && shouldApplyTax),
    calculationMode: ['exclusive', 'inclusive'].includes(input.taxCalculationMode)
      ? input.taxCalculationMode
      : paymentSettings.taxes?.calculationMode
  }
  const tax = calculatePaymentTax(amount, taxSettings)
  const chargeAmount = tax?.totalAmount || Math.round(amount * 100) / 100
  const publicPaymentId = createPublicId()
  const id = createId('stripe_payment')
  const currency = await getConfiguredCurrency()
  const stripeInstallments = normalizeStripeInstallmentOptions(input.installments || input.stripeInstallments, {
    amount: chargeAmount,
    currency,
    emptyAsNull: true
  })
  const now = new Date().toISOString()
  const paymentUrl = buildPaymentUrl(baseUrl, publicPaymentId)
  const contactId = cleanString(input.contactId) || null
  const stripeCustomerId = contactId
    ? await ensureStripeCustomerForContact(stripe, contactId, { ...input, stripeMode: config.mode }, requestOptions)
    : null
  const metadata = {
    contactName: cleanString(input.contactName),
    contactEmail: cleanString(input.email),
    contactPhone: cleanString(input.phone),
    stripeCustomerId: stripeCustomerId || '',
    source: cleanString(input.source || 'ristak'),
    lineItems: Array.isArray(input.lineItems) ? input.lineItems : [],
    ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
    ...(stripeInstallments ? { stripeInstallments } : {}),
    ...(tax ? { tax } : {})
  }

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, reference, title, description, date, due_date, sent_at,
      public_payment_id, payment_url, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      id,
      contactId,
      chargeAmount,
      currency,
      'sent',
      'stripe',
      config.mode,
      'stripe',
      publicPaymentId,
      cleanString(input.title) || 'Pago',
      cleanString(input.description) || cleanString(input.title) || 'Pago',
      now,
      input.dueDate || null,
      now,
      publicPaymentId,
      paymentUrl,
      JSON.stringify(metadata)
    ]
  )

  return {
    payment: mapPublicPayment(await findPaymentByPublicId(publicPaymentId), config, baseUrl, paymentSettings),
    paymentUrl,
    publicPaymentId
  }
}

export async function getPublicStripePayment(publicPaymentId, { baseUrl, sync = false, checkoutSessionId = '' } = {}) {
  let row = await findPaymentByPublicId(publicPaymentId)
  if (!row || row.payment_provider !== 'stripe') return null
  const config = await getStripePaymentConfig({ mode: row.payment_mode || '' })

  if (sync && row.stripe_payment_intent_id && !['paid', 'refunded', 'void', 'deleted'].includes(row.status)) {
    await refreshStripePaymentFromIntent(row.stripe_payment_intent_id, row.payment_mode || '')
    row = await findPaymentByPublicId(publicPaymentId)
  }

  const cleanCheckoutSessionId = cleanString(checkoutSessionId)
  if (sync && cleanCheckoutSessionId && !['paid', 'refunded', 'void', 'deleted'].includes(cleanString(row.status).toLowerCase())) {
    const context = await getStripeClient(row.payment_mode || '')
    if (context.stripe?.checkout?.sessions?.retrieve) {
      const session = await context.stripe.checkout.sessions.retrieve(cleanCheckoutSessionId, {}, context.requestOptions)
      await updateSubscriptionFromStripeCheckoutSession(session, context)
      row = await findPaymentByPublicId(publicPaymentId)
    }
  }

  const paymentSettings = await getPublicPaymentSettings()
  const paymentPlan = await buildPublicPaymentPlanSummary(row)
  const timezone = await getAccountTimezone().catch(() => ACCOUNT_DEFAULT_TIMEZONE)
  return attachMetaPublicPurchaseEvent(
    mapPublicPayment(row, config, baseUrl, paymentSettings, paymentPlan, timezone),
    row
  )
}

export async function createStripePaymentIntent(publicPaymentId, options = {}) {
  const row = await findPaymentByPublicId(publicPaymentId)
  if (!row || row.payment_provider !== 'stripe') {
    const error = new Error('Pago no encontrado.')
    error.status = 404
    throw error
  }
  const { stripe, config, requestOptions } = await getStripeClient(row.payment_mode || '')

  if (['paid', 'refunded', 'void', 'deleted'].includes(row.status)) {
    const error = new Error('Este pago ya no acepta nuevos cobros.')
    error.status = 409
    throw error
  }

  const savePaymentMethod = normalizeBoolean(options.savePaymentMethod, true)
  const stripeCustomerId = row.contact_id
    ? await ensureStripeCustomerForContact(stripe, row.contact_id, {
        contactName: row.contact_name,
        contactEmail: row.contact_email,
        contactPhone: row.contact_phone,
        stripeMode: config.mode
      }, requestOptions)
    : cleanString(row.contact_stripe_customer_id)

  let replacePaymentIntentId = ''
  if (row.stripe_payment_intent_id) {
    const existing = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id, requestOptions)
    const existingStatus = cleanString(existing.status).toLowerCase()
    if (['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing'].includes(existingStatus)) {
      if (savePaymentMethod && stripeCustomerId && existing.status === 'requires_payment_method') {
        const updated = await stripe.paymentIntents.update(
          existing.id,
          {
            customer: stripeCustomerId,
            setup_future_usage: 'off_session',
              metadata: {
                ...existing.metadata,
                save_payment_method: '1',
                stripe_customer_id: stripeCustomerId,
                payment_method_setup_source: 'public_payment_link'
              }
            },
          requestOptions
        )
        return {
          paymentIntentId: updated.id,
          clientSecret: updated.client_secret,
          publishableKey: config.publishableKey,
          stripeAccountId: '',
          status: updated.status
        }
      }

      return {
        paymentIntentId: existing.id,
        clientSecret: existing.client_secret,
        publishableKey: config.publishableKey,
        stripeAccountId: '',
        status: existing.status
      }
    }
    if (['canceled', 'cancelled'].includes(existingStatus)) {
      replacePaymentIntentId = cleanString(existing.id || row.stripe_payment_intent_id)
    }
  }

  const currency = normalizeCurrency(row.currency || config.defaultCurrency)
  const rowMetadata = parseJson(row.metadata_json, {})
  const stripeInstallments = normalizeStripeInstallmentOptions(rowMetadata.stripeInstallments, {
    amount: row.amount,
    currency,
    emptyAsNull: true
  })
  const paymentSettings = await getPaymentSettings()
  const shouldSendReceipt = shouldSendStripeReceiptEmail(paymentSettings)
  const paymentPlanMetadata = rowMetadata.paymentPlan && typeof rowMetadata.paymentPlan === 'object'
    ? rowMetadata.paymentPlan
    : null
  const metadata = {
    ristak_payment_id: row.id,
    public_payment_id: publicPaymentId,
    contact_id: row.contact_id || '',
    stripe_customer_id: stripeCustomerId || '',
    save_payment_method: savePaymentMethod && stripeCustomerId ? '1' : '0',
    payment_method_setup_source: savePaymentMethod && stripeCustomerId ? 'public_payment_link' : '',
    ...(paymentPlanMetadata?.flowId ? { ristak_flow_id: cleanString(paymentPlanMetadata.flowId) } : {}),
    ...(paymentPlanMetadata?.installmentId ? { ristak_installment_id: cleanString(paymentPlanMetadata.installmentId) } : {}),
    ...(paymentPlanMetadata?.trigger ? { ristak_plan_trigger: cleanString(paymentPlanMetadata.trigger) } : {})
  }

  // (PAY-009) Llave idempotente determinista para el create del PaymentIntent público.
  // Sin ella, un doble-submit del formulario (o un reintento de red) crea DOS intents
  // huérfanos antes de que se persista el id. La llave incluye monto+moneda+bucket-diario:
  // un reintento del mismo día reutiliza el mismo intent; si cambia el monto (admin edita
  // la factura) o pasa el día (expira el cache 24h de Stripe), se crea uno nuevo limpio.
  const createIntentTimezone = await getAccountTimezone().catch(() => DEFAULT_PAYMENT_TIMEZONE)
  const createIntentDayBucket = businessTodayDateOnly(createIntentTimezone)
  const createIntentIdempotencyKey =
    `ristak:${row.id}:create-intent:${toStripeAmount(row.amount, currency)}:${currency}:${createIntentDayBucket}${replacePaymentIntentId ? `:replace:${replacePaymentIntentId}` : ''}`

  const intent = await stripe.paymentIntents.create(
    {
      amount: toStripeAmount(row.amount, currency),
      currency: currency.toLowerCase(),
      automatic_payment_methods: { enabled: true },
      ...(stripeInstallments
        ? {
            payment_method_options: {
              card: {
                installments: {
                  enabled: true
                }
              }
            }
          }
        : {}),
      ...(stripeCustomerId ? { customer: stripeCustomerId } : {}),
      ...(savePaymentMethod && stripeCustomerId ? { setup_future_usage: 'off_session' } : {}),
      description: row.title || row.description || 'Pago Ristak',
      receipt_email: shouldSendReceipt ? row.contact_email || undefined : undefined,
      metadata
    },
    stripeRequestOptionsWithIdempotency(requestOptions, createIntentIdempotencyKey)
  )

  await db.run(
    `UPDATE payments
     SET stripe_payment_intent_id = ?,
         status = CASE WHEN status = 'sent' THEN 'pending' ELSE status END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [intent.id, row.id]
  )

  return {
    paymentIntentId: intent.id,
    clientSecret: intent.client_secret,
    publishableKey: config.publishableKey,
    stripeAccountId: '',
    status: intent.status
  }
}

function assertPublicStripePaymentCanCharge(row) {
  if (!row || row.payment_provider !== 'stripe') {
    const error = new Error('Pago no encontrado.')
    error.status = 404
    throw error
  }

  if (['paid', 'refunded', 'void', 'deleted'].includes(cleanString(row.status).toLowerCase())) {
    const error = new Error('Este pago ya no acepta nuevos cobros.')
    error.status = 409
    throw error
  }
}

function getStripeInstallmentsForPaymentRow(row, config) {
  const currency = normalizeCurrency(row.currency || config?.defaultCurrency)
  const metadata = parseJson(row.metadata_json, {})
  return normalizeStripeInstallmentOptions(metadata.stripeInstallments, {
    amount: row.amount,
    currency,
    emptyAsNull: true
  })
}

function normalizeStripeReturnUrl(value) {
  const clean = cleanString(value)
  if (!clean) return ''
  try {
    const parsed = new URL(clean)
    if (!['http:', 'https:'].includes(parsed.protocol)) return ''
    return parsed.toString()
  } catch {
    return ''
  }
}

function normalizeStripeSelectedInstallmentCount(value) {
  if (value === undefined || value === null || value === '' || value === false || value === 'single') return null
  const parsed = Math.trunc(Number(value))
  return STRIPE_INSTALLMENT_COUNT_SET.has(parsed) ? parsed : NaN
}

async function ensurePublicStripeCustomer(stripe, row, config, requestOptions, savePaymentMethod = true) {
  if (row.contact_id) {
    return ensureStripeCustomerForContact(stripe, row.contact_id, {
      contactName: row.contact_name,
      contactEmail: row.contact_email,
      contactPhone: row.contact_phone,
      stripeMode: config.mode
    }, requestOptions)
  }

  return savePaymentMethod ? cleanString(row.contact_stripe_customer_id) : ''
}

function buildPublicStripePaymentIntentMetadata(row, publicPaymentId, stripeCustomerId, savePaymentMethod) {
  const rowMetadata = parseJson(row.metadata_json, {})
  const paymentPlanMetadata = rowMetadata.paymentPlan && typeof rowMetadata.paymentPlan === 'object'
    ? rowMetadata.paymentPlan
    : null

  return {
    ristak_payment_id: row.id,
    public_payment_id: publicPaymentId,
    contact_id: row.contact_id || '',
    stripe_customer_id: stripeCustomerId || '',
    save_payment_method: savePaymentMethod && stripeCustomerId ? '1' : '0',
    payment_method_setup_source: savePaymentMethod && stripeCustomerId ? 'public_payment_link' : '',
    ...(paymentPlanMetadata?.flowId ? { ristak_flow_id: cleanString(paymentPlanMetadata.flowId) } : {}),
    ...(paymentPlanMetadata?.installmentId ? { ristak_installment_id: cleanString(paymentPlanMetadata.installmentId) } : {}),
    ...(paymentPlanMetadata?.trigger ? { ristak_plan_trigger: cleanString(paymentPlanMetadata.trigger) } : {})
  }
}

export async function preparePublicStripeInstallmentPlans(publicPaymentId, options = {}) {
  const row = await findPaymentByPublicId(publicPaymentId)
  assertPublicStripePaymentCanCharge(row)

  const { stripe, config, requestOptions } = await getStripeClient(row.payment_mode || '')
  const stripeInstallments = getStripeInstallmentsForPaymentRow(row, config)
  if (!stripeInstallments?.enabled) {
    const error = new Error('Este link de Stripe no tiene meses sin intereses habilitados.')
    error.status = 400
    throw error
  }

  const paymentMethodId = cleanString(options.paymentMethodId || options.payment_method_id)
  if (!paymentMethodId) {
    const error = new Error('Falta la tarjeta segura de Stripe para consultar los meses disponibles.')
    error.status = 400
    throw error
  }

  const savePaymentMethod = normalizeBoolean(options.savePaymentMethod, true)
  const stripeCustomerId = await ensurePublicStripeCustomer(stripe, row, config, requestOptions, savePaymentMethod)
  const currency = normalizeCurrency(row.currency || config.defaultCurrency)
  const paymentSettings = await getPaymentSettings()
  const shouldSendReceipt = shouldSendStripeReceiptEmail(paymentSettings)
  const metadata = buildPublicStripePaymentIntentMetadata(row, publicPaymentId, stripeCustomerId, savePaymentMethod)
  const createIntentTimezone = await getAccountTimezone().catch(() => DEFAULT_PAYMENT_TIMEZONE)
  const createIntentDayBucket = businessTodayDateOnly(createIntentTimezone)
  let replacePaymentIntentId = ''
  if (row.stripe_payment_intent_id) {
    const existing = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id, requestOptions)
    const existingStatus = cleanString(existing.status).toLowerCase()
    if (['canceled', 'cancelled'].includes(existingStatus)) {
      replacePaymentIntentId = cleanString(existing.id || row.stripe_payment_intent_id)
    }
  }
  const createIntentIdempotencyKey =
    `ristak:${row.id}:prepare-msi:${paymentMethodId}:${toStripeAmount(row.amount, currency)}:${currency}:${createIntentDayBucket}${replacePaymentIntentId ? `:replace:${replacePaymentIntentId}` : ''}`

  const intent = await stripe.paymentIntents.create(
    {
      amount: toStripeAmount(row.amount, currency),
      currency: currency.toLowerCase(),
      payment_method: paymentMethodId,
      payment_method_types: ['card'],
      payment_method_options: {
        card: {
          installments: {
            enabled: true
          }
        }
      },
      ...(stripeCustomerId ? { customer: stripeCustomerId } : {}),
      ...(savePaymentMethod && stripeCustomerId ? { setup_future_usage: 'off_session' } : {}),
      description: row.title || row.description || 'Pago Ristak',
      receipt_email: shouldSendReceipt ? row.contact_email || undefined : undefined,
      metadata
    },
    stripeRequestOptionsWithIdempotency(requestOptions, createIntentIdempotencyKey)
  )

  await db.run(
    `UPDATE payments
     SET stripe_payment_intent_id = ?,
         status = CASE WHEN status = 'sent' THEN 'pending' ELSE status END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [intent.id, row.id]
  )

  return {
    paymentIntentId: intent.id,
    clientSecret: intent.client_secret,
    publishableKey: config.publishableKey,
    stripeAccountId: '',
    status: intent.status,
    maxInstallments: stripeInstallments.maxInstallments,
    availablePlans: getStripeIntentAvailablePlans(intent, stripeInstallments)
  }
}

export async function confirmPublicStripeInstallmentPayment(publicPaymentId, options = {}) {
  const row = await findPaymentByPublicId(publicPaymentId)
  assertPublicStripePaymentCanCharge(row)

  const { stripe, config, requestOptions } = await getStripeClient(row.payment_mode || '')
  const stripeInstallments = getStripeInstallmentsForPaymentRow(row, config)
  if (!stripeInstallments?.enabled) {
    const error = new Error('Este link de Stripe no tiene meses sin intereses habilitados.')
    error.status = 400
    throw error
  }

  const paymentIntentId = cleanString(options.paymentIntentId || options.payment_intent_id || row.stripe_payment_intent_id)
  if (!paymentIntentId || paymentIntentId !== cleanString(row.stripe_payment_intent_id)) {
    const error = new Error('El intento de pago no corresponde a este link.')
    error.status = 409
    throw error
  }

  const selectedCount = normalizeStripeSelectedInstallmentCount(
    options.selectedInstallments ??
    options.installments ??
    options.selectedPlan?.count ??
    options.plan?.count
  )
  if (Number.isNaN(selectedCount)) {
    const error = new Error('Selecciona un plazo válido de meses sin intereses.')
    error.status = 400
    throw error
  }

  const intent = await stripe.paymentIntents.retrieve(paymentIntentId, requestOptions)
  const availablePlans = getStripeIntentAvailablePlans(intent, stripeInstallments)
  if (selectedCount && !availablePlans.some((plan) => plan.count === selectedCount)) {
    const error = new Error(`Este link permite máximo ${stripeInstallments.maxInstallments} meses y la tarjeta no ofrece el plazo seleccionado.`)
    error.status = 400
    throw error
  }

  const returnUrl = normalizeStripeReturnUrl(options.returnUrl || options.return_url)
  const confirmParams = {
    ...(returnUrl ? { return_url: returnUrl } : {}),
    ...(selectedCount
      ? {
          payment_method_options: {
            card: {
              installments: {
                plan: {
                  type: 'fixed_count',
                  interval: 'month',
                  count: selectedCount
                }
              }
            }
          }
        }
      : {})
  }
  const confirmed = await stripe.paymentIntents.confirm(
    paymentIntentId,
    confirmParams,
    stripeRequestOptionsWithIdempotency(
      requestOptions,
      `ristak:${row.id}:confirm-msi:${paymentIntentId}:${selectedCount || 'single'}`
    )
  )

  await updatePaymentFromIntent(confirmed, { stripe, config, requestOptions })

  return {
    paymentIntentId: confirmed.id,
    clientSecret: confirmed.client_secret || intent.client_secret,
    publishableKey: config.publishableKey,
    stripeAccountId: '',
    status: confirmed.status,
    selectedPlan: selectedCount
      ? { type: 'fixed_count', interval: 'month', count: selectedCount }
      : null,
    availablePlans
  }
}

function hasStripePaymentAttemptFailure(intent = {}, stripeContext = null) {
  if (cleanString(stripeContext?.eventType).toLowerCase() === 'payment_intent.payment_failed') return true

  const error = intent?.last_payment_error
  if (!error || typeof error !== 'object') return false

  return Boolean(
    cleanString(error.code) ||
    cleanString(error.decline_code) ||
    cleanString(error.message) ||
    cleanString(error.type)
  )
}

export function mapStripePaymentIntentStatus(intent = {}, stripeContext = null) {
  const status = cleanString(intent?.status).toLowerCase()
  if (status === 'requires_payment_method') {
    return hasStripePaymentAttemptFailure(intent, stripeContext) ? 'failed' : 'pending'
  }
  return mapGatewayPaymentStatus(status, {
    paidStatuses: ['succeeded'],
    pendingStatuses: ['processing', 'requires_action', 'requires_confirmation', 'canceled', 'cancelled'],
    voidStatuses: ['void', 'voided']
  })
}

async function updatePaymentFromIntent(intent, stripeContext = null) {
  const paymentId = cleanString(intent?.metadata?.ristak_payment_id)
  const publicPaymentId = cleanString(intent?.metadata?.public_payment_id)
  const whereColumn = paymentId ? 'id' : 'public_payment_id'
  const whereValue = paymentId || publicPaymentId
  if (!whereValue) return null

  const currency = normalizeCurrency(intent.currency)
  const amount = fromStripeAmount(intent.amount_received || intent.amount, currency)
  const nextStatus = mapStripePaymentIntentStatus(intent, stripeContext)
  const existingRow = await db.get(`SELECT * FROM payments WHERE ${whereColumn} = ?`, [whereValue])
  const ignorePendingRegression = shouldIgnorePendingWebhookRegression(existingRow, nextStatus)
  const persistedStatus = ignorePendingRegression ? cleanString(existingRow?.status) || 'paid' : nextStatus
  const statusChanged = cleanString(existingRow?.status).toLowerCase() !== cleanString(persistedStatus).toLowerCase()
  const paidAt = intent.status === 'succeeded' ? new Date().toISOString() : null
  const latestChargeId = typeof intent.latest_charge === 'string'
    ? intent.latest_charge
    : intent.latest_charge?.id || null

  await db.run(
    `UPDATE payments
     SET amount = COALESCE(?, amount),
         currency = COALESCE(?, currency),
         status = ?,
         payment_method = CASE
           WHEN payment_method = 'stripe_saved_card' THEN payment_method
           WHEN payment_method = 'stripe_scheduled_card' THEN payment_method
           ELSE 'stripe'
         END,
         payment_provider = 'stripe',
         reference = COALESCE(?, reference),
         stripe_payment_intent_id = ?,
         stripe_charge_id = COALESCE(?, stripe_charge_id),
         paid_at = COALESCE(${timestampPlaceholder()}, paid_at),
         date = COALESCE(${timestampPlaceholder()}, date),
         updated_at = CURRENT_TIMESTAMP
     WHERE ${whereColumn} = ?`,
    [
      amount,
      currency,
      persistedStatus,
      intent.id,
      intent.id,
      latestChargeId,
      paidAt,
      paidAt,
      whereValue
    ]
  )

  const row = await db.get(
    `SELECT p.*, c.full_name AS contact_name, c.email AS contact_email, c.phone AS contact_phone, c.stripe_customer_id
     FROM payments p
     LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE p.${whereColumn} = ?`,
    [whereValue]
  )
  if (row?.id && !ignorePendingRegression && statusChanged) {
    dispatchProductPostWebhooksForPaymentInBackground(row.id, {
      status: persistedStatus,
      previousStatus: existingRow?.status || ''
    })
    sendPaymentNotification({ ...row, status: persistedStatus, previousStatus: existingRow?.status || '' }).catch((error) => {
      logger.warn(`No se pudo enviar push de pago Stripe ${row.id}: ${error.message}`)
    })
  }
  if (row?.contact_id && nextStatus === 'paid') {
    updateSingleContactStats(row.contact_id).catch((error) => {
      logger.warn(`No se pudieron actualizar stats del contacto por pago Stripe ${whereValue}: ${error.message}`)
    })

    let savedMethod = null
    try {
      const context = stripeContext || await getStripeClient()
      savedMethod = await rememberStripePaymentMethodFromIntent(
        context.stripe,
        intent,
        row,
        context.config,
        context.requestOptions
      )
      await syncStripePlanFromPayment(
        { ...row, status: nextStatus, stripe_payment_intent_id: intent.id },
        savedMethod,
        context.config
      )
      if (savedMethod) {
        await activateStripeSubscriptionFromStartPayment(
          { ...row, status: nextStatus, stripe_payment_intent_id: intent.id, paid_at: paidAt || row.paid_at },
          savedMethod
        )
      }
    } catch (error) {
      logger.warn(`No se pudo guardar la tarjeta Stripe del pago ${whereValue}: ${error.message}`)
    }
  } else if (row?.contact_id) {
    try {
      const context = stripeContext || await getStripeClient()
      await syncStripePlanFromPayment(
        { ...row, status: persistedStatus, stripe_payment_intent_id: intent.id },
        null,
        context.config
      )
    } catch (error) {
      logger.warn(`No se pudo sincronizar el plan Stripe del pago ${whereValue}: ${error.message}`)
    }
  }

  if (row?.contact_id && nextStatus === 'paid') {
    registerGigstackPaymentForTransactionInBackground(row.id)
    queuePaymentAutomationMessage('receipt', { ...row, status: nextStatus, stripe_payment_intent_id: intent.id })
    triggerMetaPaymentPurchaseEvent(row.contact_id, {
      ...row,
      status: nextStatus,
      stripe_payment_intent_id: intent.id,
      stripe_charge_id: latestChargeId || row.stripe_charge_id
    }).catch((error) => {
      logger.warn(`No se pudo enviar Purchase a Meta para pago Stripe ${row.id}: ${error.message}`)
    })
  }

  if (ignorePendingRegression) {
    logger.info(`[Stripe webhook] Ignorado estado pending tardío para pago ya pagado ${row?.id || whereValue} (intent ${intent.id})`)
  } else if (cleanString(intent.status).toLowerCase() === 'requires_payment_method' && persistedStatus === 'pending') {
    logger.info(`[Stripe payment] Intent pendiente sin intento fallido para pago ${row?.id || whereValue} (intent ${intent.id})`)
  }

  return persistedStatus
}

async function updatePaymentFromInvoice(invoice, nextStatus) {
  const paymentIntentId = extractInvoicePaymentIntentId(invoice)
  if (paymentIntentId) {
    return refreshStripePaymentFromIntent(paymentIntentId)
  }

  const paymentId = cleanString(invoice?.metadata?.ristak_payment_id)
  const publicPaymentId = cleanString(invoice?.metadata?.public_payment_id)
  const whereColumn = paymentId ? 'id' : 'public_payment_id'
  const whereValue = paymentId || publicPaymentId
  if (!whereValue) return null

  const currency = normalizeCurrency(invoice.currency)
  const invoiceAmount = nextStatus === 'paid'
    ? invoice.amount_paid || invoice.amount_due || invoice.total
    : invoice.amount_due || invoice.total || invoice.amount_paid
  const amount = fromStripeAmount(invoiceAmount, currency)
  const paidAt = nextStatus === 'paid' ? timestampToIso(invoice.status_transitions?.paid_at) || new Date().toISOString() : null
  const reference = extractStripeObjectId(invoice?.payment_intent) || cleanString(invoice.id)
  const existingRow = await db.get(
    `SELECT status FROM payments WHERE ${whereColumn} = ?`,
    [whereValue]
  ).catch(() => null)

  await db.run(
    `UPDATE payments
     SET amount = COALESCE(?, amount),
         currency = COALESCE(?, currency),
         status = ?,
         payment_method = 'stripe',
         payment_provider = 'stripe',
         reference = COALESCE(?, reference),
         stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id),
         paid_at = COALESCE(${timestampPlaceholder()}, paid_at),
         date = COALESCE(${timestampPlaceholder()}, date),
         updated_at = CURRENT_TIMESTAMP
     WHERE ${whereColumn} = ?`,
    [
      amount,
      currency,
      nextStatus,
      reference,
      paymentIntentId || null,
      paidAt,
      paidAt,
      whereValue
    ]
  )

  const row = await db.get(
    `SELECT p.*, c.full_name AS contact_name, c.email AS contact_email, c.phone AS contact_phone
     FROM payments p
     LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE p.${whereColumn} = ?`,
    [whereValue]
  )
  if (row?.id) {
    dispatchProductPostWebhooksForPaymentInBackground(row.id, {
      status: nextStatus,
      previousStatus: existingRow?.status || ''
    })
    if (cleanString(existingRow?.status).toLowerCase() !== cleanString(nextStatus).toLowerCase()) {
      sendPaymentNotification({ ...row, status: nextStatus, previousStatus: existingRow?.status || '' }).catch((error) => {
        logger.warn(`No se pudo enviar push de invoice Stripe ${row.id}: ${error.message}`)
      })
    }
  }
  if (row?.contact_id && nextStatus === 'paid') {
    updateSingleContactStats(row.contact_id).catch((error) => {
      logger.warn(`No se pudieron actualizar stats del contacto por invoice Stripe ${whereValue}: ${error.message}`)
    })
  }

  if (row?.contact_id && nextStatus === 'paid') {
    queuePaymentAutomationMessage('receipt', { ...row, status: nextStatus, stripe_payment_intent_id: paymentIntentId || row.stripe_payment_intent_id })
    triggerMetaPaymentPurchaseEvent(row.contact_id, {
      ...row,
      status: nextStatus,
      stripe_payment_intent_id: paymentIntentId || row.stripe_payment_intent_id
    }).catch((error) => {
      logger.warn(`No se pudo enviar Purchase a Meta para invoice Stripe ${row.id}: ${error.message}`)
    })
  }

  return nextStatus
}

function getRistakSubscriptionIdFromStripeSubscription(subscription = {}) {
  return cleanString(subscription?.metadata?.ristak_subscription_id)
}

function getRistakSubscriptionIdFromInvoice(invoice = {}) {
  return cleanString(invoice?.metadata?.ristak_subscription_id)
    || cleanString(invoice?.subscription_details?.metadata?.ristak_subscription_id)
    || cleanString(invoice?.parent?.subscription_details?.metadata?.ristak_subscription_id)
}

function extractInvoiceSubscriptionId(invoice = {}) {
  return extractStripeObjectId(invoice?.subscription)
    || extractStripeObjectId(invoice?.parent?.subscription_details?.subscription)
}

function mapStripeSubscriptionStatus(status, fallback = 'active') {
  const normalized = cleanString(status).toLowerCase()
  if (normalized === 'active') return 'active'
  if (normalized === 'trialing') return 'trialing'
  if (normalized === 'past_due' || normalized === 'unpaid') return 'past_due'
  if (normalized === 'paused') return 'paused'
  if (normalized === 'canceled' || normalized === 'cancelled') return 'cancelled'
  if (normalized === 'incomplete' || normalized === 'incomplete_expired') return 'incomplete'
  return fallback
}

function addSubscriptionMonths(date, months) {
  const next = new Date(date)
  const originalDay = next.getDate()
  next.setMonth(next.getMonth() + months)
  if (next.getDate() !== originalDay) next.setDate(0)
  return next
}

function addSubscriptionInterval(date, intervalType, intervalCount) {
  const next = new Date(date)
  const count = Math.max(1, Number.parseInt(intervalCount, 10) || 1)
  const interval = cleanString(intervalType || 'monthly').toLowerCase()

  if (interval === 'daily') {
    next.setDate(next.getDate() + count)
    return next
  }

  if (interval === 'weekly') {
    next.setDate(next.getDate() + (7 * count))
    return next
  }

  if (interval === 'yearly') return addSubscriptionMonths(next, 12 * count)
  return addSubscriptionMonths(next, count)
}

function getSubscriptionStartMetadata(paymentRow = {}) {
  const metadata = parseJson(paymentRow.metadata_json, {})
  const start = metadata.subscriptionStart && typeof metadata.subscriptionStart === 'object'
    ? metadata.subscriptionStart
    : {}
  return {
    metadata,
    subscriptionId: cleanString(start.subscriptionId || metadata.ristakSubscriptionId || metadata.ristak_subscription_id),
    provider: cleanString(start.paymentProvider || paymentRow.payment_provider),
    method: cleanString(start.paymentMethod || paymentRow.payment_method)
  }
}

async function activateStripeSubscriptionFromStartPayment(paymentRow = {}, savedMethod = null) {
  const { subscriptionId, provider } = getSubscriptionStartMetadata(paymentRow)
  if (!subscriptionId || provider !== 'stripe' || !savedMethod) return null

  const subscription = await db.get(
    `SELECT *
     FROM subscriptions
     WHERE id = ?
     LIMIT 1`,
    [subscriptionId]
  )

  if (!subscription || subscription.stripe_subscription_id) return null

  const paidAt = paymentRow.paid_at || new Date().toISOString()
  const baseDate = new Date(paidAt)
  const nextStart = addSubscriptionInterval(
    Number.isNaN(baseDate.getTime()) ? new Date() : baseDate,
    subscription.interval_type,
    subscription.interval_count
  ).toISOString()

  const stripeSubscription = await createStripeRecurringSubscription({
    ristakSubscriptionId: subscription.id,
    contactId: subscription.contact_id,
    name: subscription.name,
    description: subscription.description,
    amount: subscription.amount,
    currency: subscription.currency,
    intervalType: subscription.interval_type,
    intervalCount: subscription.interval_count,
    startDate: nextStart,
    cancelAt: subscription.cancel_at,
    paymentMethodId: savedMethod.stripe_payment_method_id,
    contactName: subscription.contact_name,
    contactEmail: subscription.contact_email,
    contactPhone: subscription.contact_phone
  })

  const metadata = parseJson(subscription.metadata_json, {})
  const raw = parseJson(subscription.raw_json, {})
  await db.run(
    `UPDATE subscriptions
     SET status = ?,
         payment_method = 'stripe_saved_card',
         payment_provider = 'stripe',
         payment_mode = ?,
         stripe_customer_id = ?,
         stripe_subscription_id = ?,
         stripe_product_id = ?,
         stripe_price_id = ?,
         stripe_payment_method_id = ?,
         current_period_start = ?,
         current_period_end = ?,
         next_run_at = ?,
         metadata_json = ?,
         raw_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      stripeSubscription.status || 'active',
      stripeSubscription.paymentMode || subscription.payment_mode,
      stripeSubscription.stripeCustomerId || subscription.stripe_customer_id,
      stripeSubscription.stripeSubscriptionId || subscription.stripe_subscription_id,
      stripeSubscription.stripeProductId || subscription.stripe_product_id,
      stripeSubscription.stripePriceId || subscription.stripe_price_id,
      stripeSubscription.stripePaymentMethodId || savedMethod.stripe_payment_method_id,
      stripeSubscription.currentPeriodStart || subscription.current_period_start,
      stripeSubscription.currentPeriodEnd || subscription.current_period_end,
      stripeSubscription.nextRunAt || nextStart,
      JSON.stringify({
        ...metadata,
        subscriptionStartPayment: {
          ...(metadata.subscriptionStartPayment && typeof metadata.subscriptionStartPayment === 'object' ? metadata.subscriptionStartPayment : {}),
          paymentId: paymentRow.id,
          publicPaymentId: paymentRow.public_payment_id,
          status: 'paid',
          activatedAt: new Date().toISOString()
        }
      }),
      JSON.stringify({
        ...raw,
        stripeSubscriptionStart: stripeSubscription.raw || stripeSubscription
      }),
      subscription.id
    ]
  )

  return db.get('SELECT * FROM subscriptions WHERE id = ?', [subscription.id])
}

function getInvoiceLinePeriod(invoice = {}) {
  const line = Array.isArray(invoice?.lines?.data) ? invoice.lines.data[0] : null
  return {
    start: timestampToIso(line?.period?.start),
    end: timestampToIso(line?.period?.end)
  }
}

function getSubscriptionPeriod(subscription = {}) {
  const item = Array.isArray(subscription?.items?.data) ? subscription.items.data[0] : null
  return {
    start: timestampToIso(subscription.current_period_start) || timestampToIso(item?.current_period_start),
    end: timestampToIso(subscription.current_period_end) || timestampToIso(item?.current_period_end)
  }
}

async function insertSubscriptionPaymentFromInvoice(invoice, subscriptionRow, nextStatus) {
  if (!subscriptionRow || nextStatus !== 'paid') return null

  const paymentIntentId = extractInvoicePaymentIntentId(invoice)
  const invoiceId = cleanString(invoice?.id)
  if (!paymentIntentId && !invoiceId) return null

  const existing = await db.get(
    `SELECT id
     FROM payments
     WHERE (stripe_payment_intent_id IS NOT NULL AND stripe_payment_intent_id = ?)
        OR (reference IS NOT NULL AND reference = ?)
     LIMIT 1`,
    [paymentIntentId || '', invoiceId || '']
  )
  if (existing) return existing.id

  const currency = normalizeCurrency(invoice.currency || subscriptionRow.currency)
  const amount = fromStripeAmount(invoice.amount_paid || invoice.amount_due || invoice.total || 0, currency)
  const paidAt = timestampToIso(invoice.status_transitions?.paid_at) || new Date().toISOString()
  const paymentId = createId('stripe_subscription_payment')
  const metadata = {
    source: 'stripe_subscription_invoice',
    ristakSubscriptionId: subscriptionRow.id,
    stripeSubscriptionId: subscriptionRow.stripe_subscription_id || extractInvoiceSubscriptionId(invoice),
    stripeInvoiceId: invoiceId,
    stripeCustomerId: subscriptionRow.stripe_customer_id || extractStripeObjectId(invoice.customer)
  }

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, reference, title, description, public_payment_id, payment_url,
      stripe_payment_intent_id, paid_at, metadata_json, date, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      paymentId,
      subscriptionRow.contact_id || null,
      amount,
      currency,
      'paid',
      'stripe_subscription',
      subscriptionRow.payment_mode || 'test',
      'stripe',
      invoiceId || paymentIntentId,
      subscriptionRow.name || 'Suscripción',
      `Cobro recurrente de ${subscriptionRow.name || 'suscripción'}`,
      null,
      invoice.hosted_invoice_url || null,
      paymentIntentId || null,
      paidAt,
      JSON.stringify(metadata),
      paidAt
    ]
  )

  if (subscriptionRow.contact_id) {
    updateSingleContactStats(subscriptionRow.contact_id).catch((error) => {
      logger.warn(`No se pudieron actualizar stats del contacto por suscripción Stripe ${subscriptionRow.id}: ${error.message}`)
    })
  }

  return paymentId
}

async function updateSubscriptionFromInvoice(invoice, nextStatus) {
  const ristakSubscriptionId = getRistakSubscriptionIdFromInvoice(invoice)
  const stripeSubscriptionId = extractInvoiceSubscriptionId(invoice)
  if (!ristakSubscriptionId && !stripeSubscriptionId) return null

  const period = getInvoiceLinePeriod(invoice)
  const status = nextStatus === 'paid' ? 'active' : 'past_due'
  const filters = []
  const params = []

  if (ristakSubscriptionId) {
    filters.push('id = ?')
    params.push(ristakSubscriptionId)
  }

  if (stripeSubscriptionId) {
    filters.push('stripe_subscription_id = ?')
    params.push(stripeSubscriptionId)
  }

  const existing = await db.get(
    `SELECT *
     FROM subscriptions
     WHERE ${filters.join(' OR ')}
     LIMIT 1`,
    params
  )
  if (!existing) return null

  await db.run(
    `UPDATE subscriptions
     SET status = ?,
         stripe_subscription_id = COALESCE(?, stripe_subscription_id),
         current_period_start = COALESCE(?, current_period_start),
         current_period_end = COALESCE(?, current_period_end),
         next_run_at = COALESCE(?, next_run_at),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      status,
      stripeSubscriptionId || null,
      period.start,
      period.end,
      period.end,
      existing.id
    ]
  )

  await insertSubscriptionPaymentFromInvoice(invoice, {
    ...existing,
    status,
    stripe_subscription_id: stripeSubscriptionId || existing.stripe_subscription_id
  }, nextStatus)

  return status
}

export async function syncStripeSubscriptionInvoicePayment(invoice, nextStatus = 'paid') {
  if (!invoice || invoice.object !== 'invoice') return null

  await updateSubscriptionFromInvoice(invoice, nextStatus)
  await updatePaymentFromInvoice(invoice, nextStatus)
  return { synced: true, invoiceId: cleanString(invoice.id), status: nextStatus }
}

async function updateSubscriptionFromStripeCheckoutSession(session, { stripe, requestOptions } = {}) {
  const metadata = session?.metadata && typeof session.metadata === 'object' ? session.metadata : {}
  const ristakSubscriptionId = cleanString(metadata.ristak_subscription_id)
  const stripeSubscriptionId = extractStripeObjectId(session?.subscription)
  if (!ristakSubscriptionId && !stripeSubscriptionId) return null

  const filters = []
  const params = []
  if (ristakSubscriptionId) {
    filters.push('id = ?')
    params.push(ristakSubscriptionId)
  }
  if (stripeSubscriptionId) {
    filters.push('stripe_subscription_id = ?')
    params.push(stripeSubscriptionId)
  }

  const existing = await db.get(
    `SELECT id, cancel_at, metadata_json
     FROM subscriptions
     WHERE ${filters.join(' OR ')}
     LIMIT 1`,
    params
  )
  if (!existing) return null

  if (stripeSubscriptionId && stripe?.subscriptions?.update && existing.cancel_at) {
    const cancelAtTimestamp = toStripeFutureTimestamp(existing.cancel_at)
    if (cancelAtTimestamp) {
      await stripe.subscriptions.update(
        stripeSubscriptionId,
        { cancel_at: cancelAtTimestamp },
        requestOptions
      )
    }
  }

  const nextStatus = session?.payment_status === 'paid' ? 'active' : 'incomplete'
  const existingMetadata = parseJson(existing.metadata_json, {})
  const subscriptionStartPayment = existingMetadata.subscriptionStartPayment && typeof existingMetadata.subscriptionStartPayment === 'object'
    ? existingMetadata.subscriptionStartPayment
    : {}
  const completedAt = new Date().toISOString()
  await db.run(
    `UPDATE subscriptions
     SET status = CASE WHEN status = 'incomplete' THEN ? ELSE status END,
         stripe_subscription_id = COALESCE(?, stripe_subscription_id),
         stripe_customer_id = COALESCE(?, stripe_customer_id),
         metadata_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      nextStatus,
      stripeSubscriptionId || null,
      extractStripeObjectId(session?.customer) || null,
      JSON.stringify({
        ...existingMetadata,
        stripeCheckout: {
          ...(existingMetadata.stripeCheckout && typeof existingMetadata.stripeCheckout === 'object' ? existingMetadata.stripeCheckout : {}),
          id: cleanString(session?.id),
          sessionId: cleanString(session?.id),
          paymentStatus: cleanString(session?.payment_status),
          completedAt
        },
        subscriptionStartPayment: {
          ...subscriptionStartPayment,
          status: nextStatus === 'active' ? 'paid' : 'pending',
          stripeCheckoutSessionId: cleanString(session?.id),
          completedAt
        }
      }),
      existing.id
    ]
  )

  if (subscriptionStartPayment.paymentId) {
    await db.run(
      `UPDATE payments
       SET status = ?,
           payment_method = 'stripe_subscription',
           payment_provider = 'stripe',
           reference = COALESCE(?, reference),
           paid_at = CASE WHEN ? = 'active' THEN COALESCE(paid_at, ?) ELSE paid_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        nextStatus === 'active' ? 'paid' : 'pending',
        cleanString(session?.id) || null,
        nextStatus,
        completedAt,
        subscriptionStartPayment.paymentId
      ]
    )
  }

  return nextStatus
}

async function updateSubscriptionFromStripeSubscription(subscription) {
  const ristakSubscriptionId = getRistakSubscriptionIdFromStripeSubscription(subscription)
  const stripeSubscriptionId = extractStripeObjectId(subscription?.id)
  if (!ristakSubscriptionId && !stripeSubscriptionId) return null

  const filters = []
  const params = []

  if (ristakSubscriptionId) {
    filters.push('id = ?')
    params.push(ristakSubscriptionId)
  }

  if (stripeSubscriptionId) {
    filters.push('stripe_subscription_id = ?')
    params.push(stripeSubscriptionId)
  }

  const existing = await db.get(
    `SELECT id
     FROM subscriptions
     WHERE ${filters.join(' OR ')}
     LIMIT 1`,
    params
  )
  if (!existing) return null

  const nextStatus = mapStripeSubscriptionStatus(subscription.status)
  const period = getSubscriptionPeriod(subscription)
  await db.run(
    `UPDATE subscriptions
     SET status = ?,
         stripe_subscription_id = COALESCE(?, stripe_subscription_id),
         current_period_start = COALESCE(?, current_period_start),
         current_period_end = COALESCE(?, current_period_end),
         next_run_at = COALESCE(?, next_run_at),
         cancelled_at = CASE WHEN ? = 'cancelled' THEN COALESCE(cancelled_at, CURRENT_TIMESTAMP) ELSE cancelled_at END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      nextStatus,
      stripeSubscriptionId || null,
      period.start,
      period.end,
      period.end,
      nextStatus,
      existing.id
    ]
  )

  return nextStatus
}

export async function createStripeSubscriptionCheckoutLink(input = {}, { baseUrl = '' } = {}) {
  const { stripe, config, requestOptions } = await getStripeClient()
  const contactId = cleanString(input.contactId)
  const contactEmail = cleanString(input.contactEmail || input.email)
  const name = cleanString(input.name) || 'Suscripción'
  const amount = Number(input.amount)
  const currency = await getConfiguredCurrency()
  const interval = cleanString(input.intervalType || 'monthly').toLowerCase()
  const intervalCount = Number.parseInt(input.intervalCount, 10) || 1
  const ristakSubscriptionId = cleanString(input.ristakSubscriptionId)
  const subscriptionStartPaymentId = cleanString(input.subscriptionStartPaymentId || input.ristakPaymentId || input.paymentId)
  const subscriptionStartPublicPaymentId = cleanString(input.subscriptionStartPublicPaymentId || input.publicPaymentId)

  if (!contactId) {
    const error = new Error('Selecciona un contacto para crear el link de suscripción de Stripe.')
    error.status = 400
    throw error
  }

  if (!contactEmail) {
    const error = new Error('Stripe necesita el email del contacto para enviarle un link de suscripción.')
    error.status = 422
    throw error
  }

  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(interval)) {
    const error = new Error('Frecuencia de suscripción no soportada por Stripe.')
    error.status = 400
    throw error
  }

  const stripeCustomerId = await ensureStripeCustomerForContact(
    stripe,
    contactId,
    { ...input, stripeMode: config.mode, email: contactEmail },
    requestOptions
  )

  const metadata = {
    ristak_subscription_id: ristakSubscriptionId,
    ristak_payment_id: subscriptionStartPaymentId,
    public_payment_id: subscriptionStartPublicPaymentId,
    ristak_contact_id: contactId,
    source: 'ristak_subscription_checkout'
  }

  const product = await stripe.products.create(
    {
      name,
      description: cleanString(input.description) || undefined,
      metadata
    },
    requestOptions
  )

  const price = await stripe.prices.create(
    {
      currency: currency.toLowerCase(),
      unit_amount: toStripeAmount(amount, currency),
      recurring: {
        interval: {
          daily: 'day',
          weekly: 'week',
          monthly: 'month',
          yearly: 'year'
        }[interval],
        interval_count: Math.max(1, intervalCount)
      },
      product: product.id,
      metadata
    },
    requestOptions
  )

  const startDate = cleanString(input.startDate)
  const startTimestamp = startDate ? Math.floor(new Date(startDate).getTime() / 1000) : 0
  const nowTimestamp = Math.floor(Date.now() / 1000)
  const subscriptionData = { metadata }
  if (Number.isFinite(startTimestamp) && startTimestamp > nowTimestamp + 300) {
    subscriptionData.trial_end = startTimestamp
  }

  const session = await stripe.checkout.sessions.create(
    {
      mode: 'subscription',
      customer: stripeCustomerId || undefined,
      customer_email: stripeCustomerId ? undefined : contactEmail,
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: buildSubscriptionReturnUrl(baseUrl, 'success', subscriptionStartPublicPaymentId),
      cancel_url: buildSubscriptionReturnUrl(baseUrl, 'cancelled', subscriptionStartPublicPaymentId),
      subscription_data: subscriptionData,
      metadata
    },
    requestOptions
  )

  return {
    stripeCustomerId,
    stripeProductId: product.id,
    stripePriceId: price.id,
    stripeCheckoutSessionId: cleanString(session?.id),
    stripeCheckoutUrl: cleanString(session?.url),
    paymentMode: config.mode,
    status: 'incomplete',
    raw: {
      checkoutSession: session
    }
  }
}

export async function createPublicStripeSubscriptionCheckout(publicPaymentId, { baseUrl = '' } = {}) {
  const row = await findPaymentByPublicId(publicPaymentId)
  if (!row || row.payment_provider !== 'stripe') {
    const error = new Error('Link de suscripción no encontrado.')
    error.status = 404
    throw error
  }

  if (['paid', 'refunded', 'void', 'deleted'].includes(cleanString(row.status).toLowerCase())) {
    const error = new Error('Este link de suscripción ya no acepta nuevas autorizaciones.')
    error.status = 409
    throw error
  }

  const paymentMetadata = parseJson(row.metadata_json, {})
  const subscriptionStart = getPublicSubscriptionStart(paymentMetadata)
  if (!subscriptionStart?.subscriptionId || subscriptionStart.paymentProvider !== 'stripe') {
    const error = new Error('Este link no corresponde a una suscripción de Stripe.')
    error.status = 400
    throw error
  }

  const subscription = await db.get(
    `SELECT *
     FROM subscriptions
     WHERE id = ?
     LIMIT 1`,
    [subscriptionStart.subscriptionId]
  )

  if (!subscription) {
    const error = new Error('No encontramos la suscripción asociada a este link.')
    error.status = 404
    throw error
  }

  const subscriptionMetadata = parseJson(subscription.metadata_json, {})
  const existingCheckout = subscriptionMetadata.stripeCheckout && typeof subscriptionMetadata.stripeCheckout === 'object'
    ? subscriptionMetadata.stripeCheckout
    : {}
  const existingCheckoutUrl = cleanString(existingCheckout.url || existingCheckout.checkoutUrl)
  if (existingCheckoutUrl && !subscription.stripe_subscription_id) {
    return {
      checkoutUrl: existingCheckoutUrl,
      stripeCheckoutSessionId: cleanString(existingCheckout.sessionId || existingCheckout.id),
      status: subscription.status || 'incomplete',
      subscriptionId: subscription.id
    }
  }

  if (subscription.stripe_subscription_id) {
    return {
      checkoutUrl: '',
      stripeCheckoutSessionId: '',
      status: subscription.status || 'active',
      subscriptionId: subscription.id,
      alreadyActive: true
    }
  }

  const checkout = await createStripeSubscriptionCheckoutLink({
    ristakSubscriptionId: subscription.id,
    contactId: subscription.contact_id,
    contactEmail: subscription.contact_email,
    email: subscription.contact_email,
    contactName: subscription.contact_name,
    contactPhone: subscription.contact_phone,
    name: subscription.name,
    description: subscription.description,
    amount: subscription.amount,
    currency: subscription.currency,
    intervalType: subscription.interval_type,
    intervalCount: subscription.interval_count,
    startDate: subscription.start_date,
    cancelAt: subscription.cancel_at,
    subscriptionStartPaymentId: row.id,
    subscriptionStartPublicPaymentId: row.public_payment_id,
    publicPaymentId: row.public_payment_id
  }, { baseUrl })

  const checkoutMetadata = {
    id: checkout.stripeCheckoutSessionId,
    sessionId: checkout.stripeCheckoutSessionId,
    url: checkout.stripeCheckoutUrl,
    checkoutUrl: checkout.stripeCheckoutUrl,
    createdAt: new Date().toISOString()
  }
  const raw = parseJson(subscription.raw_json, {})

  await db.run(
    `UPDATE subscriptions
     SET status = 'incomplete',
         payment_method = 'stripe_link',
         payment_provider = 'stripe',
         payment_mode = ?,
         stripe_customer_id = COALESCE(?, stripe_customer_id),
         stripe_product_id = COALESCE(?, stripe_product_id),
         stripe_price_id = COALESCE(?, stripe_price_id),
         metadata_json = ?,
         raw_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      checkout.paymentMode || subscription.payment_mode,
      checkout.stripeCustomerId || null,
      checkout.stripeProductId || null,
      checkout.stripePriceId || null,
      JSON.stringify({
        ...subscriptionMetadata,
        stripeCheckout: checkoutMetadata,
        subscriptionStartPayment: {
          ...(subscriptionMetadata.subscriptionStartPayment && typeof subscriptionMetadata.subscriptionStartPayment === 'object' ? subscriptionMetadata.subscriptionStartPayment : {}),
          status: 'pending_checkout',
          stripeCheckoutSessionId: checkout.stripeCheckoutSessionId,
          updatedAt: new Date().toISOString()
        }
      }),
      JSON.stringify({
        ...raw,
        stripeCheckout: checkout.raw || checkout
      }),
      subscription.id
    ]
  )

  await db.run(
    `UPDATE payments
     SET status = CASE WHEN status = 'sent' THEN 'pending' ELSE status END,
         reference = COALESCE(?, reference),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [checkout.stripeCheckoutSessionId || null, row.id]
  )

  return {
    checkoutUrl: checkout.stripeCheckoutUrl,
    stripeCheckoutSessionId: checkout.stripeCheckoutSessionId,
    status: 'incomplete',
    subscriptionId: subscription.id
  }
}

export async function createStripeRecurringSubscription(input = {}) {
  const { stripe, config, requestOptions } = await getStripeClient()
  const contactId = cleanString(input.contactId)
  const name = cleanString(input.name) || 'Suscripción'
  const amount = Number(input.amount)
  const currency = await getConfiguredCurrency()
  const interval = cleanString(input.intervalType || 'monthly').toLowerCase()
  const intervalCount = Number.parseInt(input.intervalCount, 10) || 1
  const ristakSubscriptionId = cleanString(input.ristakSubscriptionId)

  if (!contactId) {
    const error = new Error('Selecciona un contacto para crear una suscripción automática en Stripe.')
    error.status = 400
    throw error
  }

  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(interval)) {
    const error = new Error('Frecuencia de suscripción no soportada por Stripe.')
    error.status = 400
    throw error
  }

  const savedMethod = await resolveStripeSavedMethod(contactId, input.paymentMethodId, config)
  if (!savedMethod) {
    const error = new Error('Este contacto no tiene una tarjeta guardada para activar la suscripción automática.')
    error.status = 422
    throw error
  }

  const stripeCustomerId = cleanString(savedMethod.stripe_customer_id)
    || await ensureStripeCustomerForContact(stripe, contactId, { ...input, stripeMode: config.mode }, requestOptions)
  if (!stripeCustomerId) {
    const error = new Error('No encontramos el cliente de Stripe para esta tarjeta guardada.')
    error.status = 422
    throw error
  }
  const metadata = {
    ristak_subscription_id: ristakSubscriptionId,
    ristak_contact_id: contactId,
    source: 'ristak_subscription'
  }

  await stripe.customers.update(
    stripeCustomerId,
    {
      invoice_settings: {
        default_payment_method: savedMethod.stripe_payment_method_id
      }
    },
    requestOptions
  )

  const product = await stripe.products.create(
    {
      name,
      description: cleanString(input.description) || undefined,
      metadata
    },
    requestOptions
  )

  const price = await stripe.prices.create(
    {
      currency: currency.toLowerCase(),
      unit_amount: toStripeAmount(amount, currency),
      recurring: {
        interval: {
          daily: 'day',
          weekly: 'week',
          monthly: 'month',
          yearly: 'year'
        }[interval],
        interval_count: Math.max(1, intervalCount)
      },
      product: product.id,
      metadata
    },
    requestOptions
  )

  const startDate = cleanString(input.startDate)
  const startTimestamp = startDate ? Math.floor(new Date(startDate).getTime() / 1000) : 0
  const nowTimestamp = Math.floor(Date.now() / 1000)
  const cancelAtTimestamp = toStripeFutureTimestamp(input.cancelAt)
  const subscriptionParams = {
    customer: stripeCustomerId,
    items: [{ price: price.id }],
    default_payment_method: savedMethod.stripe_payment_method_id,
    collection_method: 'charge_automatically',
    metadata,
    payment_settings: {
      save_default_payment_method: 'on_subscription'
    },
    expand: ['latest_invoice']
  }

  if (Number.isFinite(startTimestamp) && startTimestamp > nowTimestamp + 300) {
    subscriptionParams.trial_end = startTimestamp
  }
  if (cancelAtTimestamp) {
    subscriptionParams.cancel_at = cancelAtTimestamp
  }

  const subscription = await stripe.subscriptions.create(subscriptionParams, requestOptions)
  const period = getSubscriptionPeriod(subscription)

  return {
    stripeCustomerId,
    stripeSubscriptionId: subscription.id,
    stripeProductId: product.id,
    stripePriceId: price.id,
    stripePaymentMethodId: savedMethod.stripe_payment_method_id,
    paymentMode: config.mode,
    status: mapStripeSubscriptionStatus(subscription.status),
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    nextRunAt: period.end,
    initialInvoice: subscription.latest_invoice?.object === 'invoice' ? subscription.latest_invoice : null
  }
}

export async function updateStripeRecurringSubscription(input = {}) {
  const { stripe, config, requestOptions } = await getStripeClient()
  const stripeSubscriptionId = extractStripeObjectId(input.stripeSubscriptionId)
  const name = cleanString(input.name) || 'Suscripción'
  const amount = Number(input.amount)
  const currency = await getConfiguredCurrency()
  const interval = cleanString(input.intervalType || 'monthly').toLowerCase()
  const intervalCount = Number.parseInt(input.intervalCount, 10) || 1
  const ristakSubscriptionId = cleanString(input.ristakSubscriptionId)

  if (!stripeSubscriptionId) {
    const error = new Error('No se encontró la suscripción de Stripe.')
    error.status = 400
    throw error
  }

  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(interval)) {
    const error = new Error('Frecuencia de suscripción no soportada por Stripe.')
    error.status = 400
    throw error
  }

  const subscription = await stripe.subscriptions.retrieve(
    stripeSubscriptionId,
    {
      expand: ['items.data.price.product']
    },
    requestOptions
  )
  const item = subscription.items?.data?.[0]
  if (!item?.id) {
    const error = new Error('La suscripción de Stripe no tiene un precio editable.')
    error.status = 422
    throw error
  }

  const metadata = {
    ristak_subscription_id: ristakSubscriptionId,
    ristak_contact_id: cleanString(input.contactId),
    source: 'ristak_subscription'
  }
  const currentProductId = extractStripeObjectId(item.price?.product)
  let productId = currentProductId

  if (productId) {
    await stripe.products.update(
      productId,
      {
        name,
        description: cleanString(input.description) || undefined,
        metadata
      },
      requestOptions
    )
  } else {
    const product = await stripe.products.create(
      {
        name,
        description: cleanString(input.description) || undefined,
        metadata
      },
      requestOptions
    )
    productId = product.id
  }

  const price = await stripe.prices.create(
    {
      currency: currency.toLowerCase(),
      unit_amount: toStripeAmount(amount, currency),
      recurring: {
        interval: {
          daily: 'day',
          weekly: 'week',
          monthly: 'month',
          yearly: 'year'
        }[interval],
        interval_count: Math.max(1, intervalCount)
      },
      product: productId,
      metadata
    },
    requestOptions
  )

  const cancelAtTimestamp = toStripeFutureTimestamp(input.cancelAt)
  const subscriptionUpdateParams = {
    items: [
      {
        id: item.id,
        price: price.id
      }
    ],
    proration_behavior: 'none',
    metadata
  }

  if (cancelAtTimestamp) {
    subscriptionUpdateParams.cancel_at = cancelAtTimestamp
  } else if (input.clearCancelAt) {
    subscriptionUpdateParams.cancel_at = ''
    subscriptionUpdateParams.cancel_at_period_end = false
  }

  const updated = await stripe.subscriptions.update(
    stripeSubscriptionId,
    subscriptionUpdateParams,
    requestOptions
  )
  const period = getSubscriptionPeriod(updated)

  return {
    stripeSubscriptionId: updated.id,
    stripeProductId: productId,
    stripePriceId: price.id,
    paymentMode: config.mode,
    status: mapStripeSubscriptionStatus(updated.status),
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    nextRunAt: period.end
  }
}

export async function pauseStripeRecurringSubscription(stripeSubscriptionId) {
  const { stripe, requestOptions } = await getStripeClient()
  const cleanSubscriptionId = extractStripeObjectId(stripeSubscriptionId)
  if (!cleanSubscriptionId) return null

  await stripe.subscriptions.update(
    cleanSubscriptionId,
    {
      pause_collection: {
        behavior: 'void'
      }
    },
    requestOptions
  )

  return 'paused'
}

export async function resumeStripeRecurringSubscription(stripeSubscriptionId) {
  const { stripe, requestOptions } = await getStripeClient()
  const cleanSubscriptionId = extractStripeObjectId(stripeSubscriptionId)
  if (!cleanSubscriptionId) return null

  const subscription = await stripe.subscriptions.update(
    cleanSubscriptionId,
    {
      pause_collection: null
    },
    requestOptions
  )

  return mapStripeSubscriptionStatus(subscription.status)
}

export async function cancelStripeRecurringSubscription(stripeSubscriptionId) {
  const { stripe, requestOptions } = await getStripeClient()
  const cleanSubscriptionId = extractStripeObjectId(stripeSubscriptionId)
  if (!cleanSubscriptionId) return null

  const subscription = await stripe.subscriptions.cancel(cleanSubscriptionId, {}, requestOptions)
  return mapStripeSubscriptionStatus(subscription.status, 'cancelled')
}

async function markStripePaymentAsRefunded({ paymentIntentId, chargeId, sourceLabel, amountRefunded, chargeAmount }) {
  const filters = []
  const params = []

  if (paymentIntentId) {
    filters.push('stripe_payment_intent_id = ?')
    params.push(paymentIntentId)
  }

  if (chargeId) {
    filters.push('stripe_charge_id = ?')
    params.push(chargeId)
  }

  if (!filters.length) return null

  const payment = await db.get(
    `SELECT id, contact_id, amount, currency FROM payments WHERE ${filters.join(' OR ')} LIMIT 1`,
    params
  )

  if (!payment) return null

  // (PAY-002) Distinguir reembolso parcial de total. Stripe dispara charge.refunded
  // también en reembolsos parciales; antes se marcaba todo como 'refunded' ocultando
  // el monto completo. Comparamos el monto reembolsado contra el total cobrado.
  const refundedCents = Number(amountRefunded)
  let totalCents = Number(chargeAmount)
  // Si el evento no trae el total del cargo (caso refund.created), lo derivamos del
  // monto del pago almacenado, convertido a la unidad mínima de Stripe (centavos).
  if (!Number.isFinite(totalCents) || totalCents <= 0) {
    try {
      totalCents = toStripeAmount(payment.amount, payment.currency)
    } catch {
      totalCents = NaN
    }
  }

  let nextStatus = 'refunded'
  if (
    Number.isFinite(refundedCents) && refundedCents > 0 &&
    Number.isFinite(totalCents) && totalCents > 0 &&
    refundedCents < totalCents
  ) {
    nextStatus = 'partially_refunded'
  }

  await db.run(
    `UPDATE payments
     SET status = ?,
         payment_method = 'stripe',
         payment_provider = 'stripe',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [nextStatus, payment.id]
  )

  if (payment.contact_id) {
    updateSingleContactStats(payment.contact_id).catch((error) => {
      logger.warn(`No se pudieron actualizar stats del contacto por ${sourceLabel} Stripe ${payment.id}: ${error.message}`)
    })
  }

  return nextStatus
}

async function updatePaymentFromRefund(refund) {
  return markStripePaymentAsRefunded({
    paymentIntentId: extractStripeObjectId(refund?.payment_intent),
    chargeId: extractStripeObjectId(refund?.charge),
    sourceLabel: 'refund',
    // (PAY-002) refund.created trae el monto de ESTE reembolso; el total del cargo no
    // viaja aquí, así que markStripePaymentAsRefunded lo deriva del pago almacenado.
    amountRefunded: refund?.amount
  })
}

async function updatePaymentFromRefundedCharge(charge) {
  return markStripePaymentAsRefunded({
    paymentIntentId: extractStripeObjectId(charge?.payment_intent),
    chargeId: extractStripeObjectId(charge?.id),
    sourceLabel: 'charge.refunded',
    // (PAY-002) charge.refunded trae el acumulado reembolsado y el total del cargo.
    amountRefunded: charge?.amount_refunded,
    chargeAmount: charge?.amount
  })
}

export async function getStripeSavedPaymentMethods(contactId) {
  const { stripe, config, requestOptions } = await getStripeClient()
  const contact = await getStripeContact(contactId)
  if (!contact) {
    const error = new Error('Contacto no encontrado.')
    error.status = 404
    throw error
  }

  const storedRows = await getStoredStripePaymentMethodRows(contact.id, config.mode)
  const customerIds = [
    ...new Set([
      ...storedRows.map((row) => cleanString(row.stripe_customer_id)),
      cleanString(contact.stripe_customer_id)
    ].filter(Boolean))
  ]

  for (const stripeCustomerId of customerIds) {
    try {
      const methods = await stripe.paymentMethods.list(
        {
          customer: stripeCustomerId,
          type: 'card',
          limit: 20
        },
        requestOptions
      )

      for (const method of methods.data || []) {
        await upsertStripePaymentMethod({
          stripe,
          contactId: contact.id,
          customerId: stripeCustomerId,
          paymentMethodId: method.id,
          mode: config.mode,
          makeDefault: false,
          requestOptions
        })
      }
    } catch (error) {
      if (error?.statusCode !== 404) throw error
    }
  }

  const rows = await getStoredStripePaymentMethodRows(contact.id, config.mode)

  return (rows || []).map(mapStripePaymentMethod).filter(Boolean)
}

function mapSavedCardPayment(row) {
  if (!row) return null
  return {
    id: row.id,
    contactId: row.contact_id || '',
    amount: Number(row.amount || 0),
    currency: row.currency || DEFAULT_CURRENCY,
    status: row.status || 'pending',
    method: row.payment_method || 'stripe_saved_card',
    provider: row.payment_provider || 'stripe',
    reference: row.reference || '',
    title: row.title || '',
    description: row.description || '',
    paidAt: row.paid_at || null,
    stripePaymentIntentId: row.stripe_payment_intent_id || null,
    stripeChargeId: row.stripe_charge_id || null
  }
}

function addPlanState(history, state) {
  const parsed = Array.isArray(history) ? history : parseJson(history, [])
  if (parsed.some((entry) => entry?.state === state)) return parsed
  return [
    ...parsed,
    {
      state,
      at: new Date().toISOString()
    }
  ]
}

function getSavedCardLabelFromRow(method = {}) {
  const brand = cleanString(method.brand).toUpperCase() || 'Tarjeta'
  const last4 = cleanString(method.last4) || '----'
  return `${brand} •••• ${last4}`
}

async function resolveStripeSavedMethod(contactId, paymentMethodId, config) {
  const cleanContactId = cleanString(contactId)
  const cleanPaymentMethodId = cleanString(paymentMethodId)
  if (!cleanContactId) return null

  let query = `
    SELECT spm.*, c.full_name AS contact_name, c.email AS contact_email, c.phone AS contact_phone
    FROM stripe_payment_methods spm
    LEFT JOIN contacts c ON c.id = spm.contact_id
    WHERE spm.contact_id = ?
      AND spm.mode = ?`
  const params = [cleanContactId, config.mode]

  if (cleanPaymentMethodId) {
    query += ' AND (spm.id = ? OR spm.stripe_payment_method_id = ?)'
    params.push(cleanPaymentMethodId, cleanPaymentMethodId)
  }

  query += ' ORDER BY spm.is_default DESC, spm.updated_at DESC LIMIT 1'
  let method = await db.get(query, params)

  if (!method) {
    await getStripeSavedPaymentMethods(cleanContactId)
    method = await db.get(query, params)
  }

  return method || null
}

async function createStripePlanPaymentRow({
  contact,
  amount,
  currency,
  status,
  paymentMethod,
  title,
  description,
  dueDate,
  metadata,
  provider = 'stripe'
}) {
  const id = createId('stripe_plan_payment')
  const date = dueDate || new Date().toISOString()

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, reference, title, description, date, due_date, sent_at,
      metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      id,
      contact.id,
      Math.round(Number(amount || 0) * 100) / 100,
      currency,
      status,
      paymentMethod,
      metadata?.paymentMode || metadata?.stripeMode || (provider === 'stripe' ? 'test' : 'live'),
      provider,
      null,
      title,
      description,
      date,
      dueDate || null,
      status === 'sent' ? new Date().toISOString() : null,
      JSON.stringify(metadata || {})
    ]
  )

  return id
}

async function chargeStripePaymentRowWithSavedMethod({
  stripe,
  config,
  requestOptions,
  paymentId,
  savedMethod,
  source = 'stripe_payment_plan',
  extraMetadata = {}
}) {
  const row = await db.get('SELECT * FROM payments WHERE id = ?', [paymentId])
  if (!row) {
    const error = new Error('No encontramos el pago programado.')
    error.status = 404
    throw error
  }

  if (row.status === 'paid') {
    return row
  }

  // (PAY-004) Token DETERMINISTA por día (UTC), NO aleatorio. Stripe cachea el
  // resultado de una idempotencyKey 24h: una llave estática bloquea reintentar un
  // cargo fallido, pero una llave 100% ALEATORIA es peligrosa (un cargo que sí pasó
  // pero perdió la respuesta se volvería a cobrar en el siguiente tick = DOBLE COBRO).
  // El bucket diario mantiene la idempotencia dentro de la ventana de cobro (reintentos
  // del mismo día NO re-cobran) y a la vez permite reintentar un cargo fallido al día
  // siguiente, cuando ya expiró el cache de 24h de Stripe.
  const chargeAttemptTimezone = await getAccountTimezone().catch(() => DEFAULT_PAYMENT_TIMEZONE)
  const chargeAttemptToken = businessTodayDateOnly(chargeAttemptTimezone)

  const currency = normalizeCurrency(row.currency || config.defaultCurrency)
  const metadata = parseJson(row.metadata_json, {})
  const planMetadata = metadata.paymentPlan && typeof metadata.paymentPlan === 'object'
    ? metadata.paymentPlan
    : {}
  const paymentSettings = await getPaymentSettings()
  const shouldSendReceipt = shouldSendStripeReceiptEmail(paymentSettings)
  const description = cleanString(row.description || row.title || 'Pago Ristak')

  try {
    const intent = await stripe.paymentIntents.create(
      {
        amount: toStripeAmount(row.amount, currency),
        currency: currency.toLowerCase(),
        customer: savedMethod.stripe_customer_id,
        payment_method: savedMethod.stripe_payment_method_id,
        off_session: true,
        confirm: true,
        payment_method_types: ['card'],
        description,
        receipt_email: shouldSendReceipt ? cleanString(metadata.contactEmail || savedMethod.contact_email) || undefined : undefined,
        metadata: {
          ristak_payment_id: row.id,
          contact_id: row.contact_id || '',
          stripe_customer_id: savedMethod.stripe_customer_id,
          stripe_payment_method_id: savedMethod.stripe_payment_method_id,
          source,
          ...(planMetadata.flowId ? { ristak_flow_id: cleanString(planMetadata.flowId) } : {}),
          ...(planMetadata.installmentId ? { ristak_installment_id: cleanString(planMetadata.installmentId) } : {}),
          ...(planMetadata.sequence !== undefined ? { ristak_installment_sequence: String(planMetadata.sequence) } : {}),
          ...extraMetadata
        }
      },
      // (PAY-004) Llave por intento (no estática) para no quedar bloqueados por el resultado cacheado 24h de Stripe en reintentos.
      stripeRequestOptionsWithIdempotency(requestOptions, `ristak:${row.id}:off-session-charge:${chargeAttemptToken}`)
    )

    await updatePaymentFromIntent(intent, { stripe, config, requestOptions })
    return db.get('SELECT * FROM payments WHERE id = ?', [paymentId])
  } catch (error) {
    const intent = error?.payment_intent
    const failedStatus = intent?.status === 'requires_action' ? 'pending' : 'failed'
    await db.run(
      `UPDATE payments
       SET status = ?,
           reference = COALESCE(?, reference),
           stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [failedStatus, intent?.id || null, intent?.id || null, row.id]
    )

    if (planMetadata.installmentId) {
      await db.run(
        `UPDATE installment_payments
         SET status = ?,
             stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id),
             notes = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          intent?.status === 'requires_action' ? 'requires_action' : 'failed',
          intent?.id || null,
          error?.message || 'Stripe no pudo procesar el cobro programado.',
          planMetadata.installmentId
        ]
      )
    }

    if (error?.code === 'authentication_required' || intent?.status === 'requires_action') {
      const authError = new Error('La tarjeta requiere autenticación del cliente. Envíale un link de Stripe para que confirme el pago.')
      authError.status = 402
      throw authError
    }

    throw error
  }
}

function validateStripePaymentPlanPayload(input = {}, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  const contact = input.contact || {}
  const totalAmount = Number(input.totalAmount || input.amount)
  const currency = normalizeCurrency(input.currency || DEFAULT_CURRENCY)
  const firstPayment = input.firstPayment || {}
  const firstPaymentEnabled = normalizeBoolean(firstPayment.enabled, true)
  const firstPaymentAmount = firstPaymentEnabled ? Number(firstPayment.amount || 0) : 0
  const firstPaymentMethod = firstPaymentEnabled ? cleanString(firstPayment.method || 'card') : 'none'
  const remainingPayments = Array.isArray(input.remainingPayments) ? input.remainingPayments : []
  const remainingFrequency = normalizePlanFrequency(input.remainingFrequency || 'custom')
  const firstPaymentFrequency = normalizePlanFrequency(firstPayment.frequency || remainingFrequency)
  const planCreatedAt = new Date()
  const firstPaymentDate = firstPaymentEnabled
    ? normalizePlanDueDate(firstPayment.date || todayDateOnly(timezone), firstPaymentFrequency, timezone, planCreatedAt)
    : null
  const cardSetupAmount = normalizePositiveAmount(input.cardSetupAmount, 25)

  if (!cleanString(contact.id)) {
    const error = new Error('Selecciona un contacto.')
    error.status = 400
    throw error
  }

  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    const error = new Error('El total del plan debe ser mayor a 0.')
    error.status = 400
    throw error
  }

  if (firstPaymentEnabled && (!Number.isFinite(firstPaymentAmount) || firstPaymentAmount <= 0)) {
    const error = new Error('Configura un primer pago mayor a 0.')
    error.status = 400
    throw error
  }

  if (!remainingPayments.length) {
    const error = new Error('Agrega al menos un pago futuro.')
    error.status = 400
    throw error
  }

  const normalizedRemaining = remainingPayments.map((payment, index) => {
    const amount = Number(payment.amount || 0)
    if (!Number.isFinite(amount) || amount <= 0 || !payment.dueDate) {
      const error = new Error('Todos los pagos futuros necesitan monto y fecha.')
      error.status = 400
      throw error
    }

    const frequency = normalizePlanFrequency(payment.frequency || input.remainingFrequency || 'custom')
    const dueDate = normalizePlanDueDate(payment.dueDate, frequency, timezone, planCreatedAt)
    assertPlanDueDateNotInPast(dueDate, frequency, 'Los pagos futuros automáticos no pueden programarse en fechas pasadas.', timezone)

    return {
      sequence: Number(payment.sequence || index + 1),
      amount: Math.round(amount * 100) / 100,
      percentage: payment.percentage ?? null,
      dueDate,
      frequency
    }
  })

  if (firstPaymentEnabled && !MANUAL_PLAN_PAYMENT_METHODS.has(firstPaymentMethod)) {
    assertPlanDueDateNotInPast(firstPaymentDate, firstPaymentFrequency, 'El primer pago automático no puede programarse en una fecha pasada.', timezone)
  }

  const remainingTotal = normalizedRemaining.reduce((sum, payment) => sum + payment.amount, 0)
  const planTotal = Math.round((remainingTotal + firstPaymentAmount) * 100) / 100
  if (Math.abs(planTotal - totalAmount) > 0.5) {
    const error = new Error(`Las parcialidades suman ${planTotal.toFixed(2)} ${currency}, pero el total es ${totalAmount.toFixed(2)} ${currency}.`)
    error.status = 400
    throw error
  }

  return {
    contact: {
      id: cleanString(contact.id),
      name: cleanString(contact.name || contact.fullName || contact.contactName),
      email: cleanString(contact.email),
      phone: cleanString(contact.phone)
    },
    totalAmount: Math.round(totalAmount * 100) / 100,
    currency,
    description: cleanString(input.description || input.concept || 'Plan de pagos'),
    title: cleanString(input.title || input.invoicePayload?.title || input.invoicePayload?.name || 'Plan de pagos'),
    firstPayment: {
      enabled: firstPaymentEnabled,
      amount: Math.round(firstPaymentAmount * 100) / 100,
      date: firstPaymentDate,
      method: firstPaymentMethod
    },
    remainingPayments: normalizedRemaining,
    remainingFrequency,
    cardSetupAmount,
    timezone,
    lineItems: Array.isArray(input.invoicePayload?.items) ? input.invoicePayload.items : [],
    invoicePayload: input.invoicePayload || {},
    paymentMethodId: cleanString(input.paymentMethodId),
    source: cleanString(input.source || 'record_payment_modal_stripe_plan')
  }
}

function getStripePlanRecurrenceLabel(frequency) {
  const labels = {
    scheduled_time: 'Hora programada',
    daily: 'Diario',
    weekly: 'Semanal',
    biweekly: 'Quincenal',
    monthly: 'Mensual',
    yearly: 'Anual',
    custom: 'Personalizado'
  }

  return labels[cleanString(frequency).toLowerCase()] || 'Personalizado'
}

function getStripePlanMirrorStatus(flow = {}) {
  const state = cleanString(flow.current_state).toLowerCase()
  if (state === STRIPE_PLAN_STATES.DRAFT) return 'draft'
  if (state === STRIPE_PLAN_STATES.DELETED) return 'deleted'
  if (state === STRIPE_PLAN_STATES.CANCELLED) return 'cancelled'
  if (state === STRIPE_PLAN_STATES.PAUSED) return 'paused'
  if (state === STRIPE_PLAN_STATES.FIRST_PAYMENT_PENDING) return 'pending'
  if (state === STRIPE_PLAN_STATES.WAITING_CARD_AUTHORIZATION) return 'pending'
  if (state === STRIPE_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE) return 'active'
  if (state === STRIPE_PLAN_STATES.INSTALLMENT_PLAN_CREATED) return 'scheduled'
  if (state === STRIPE_PLAN_STATES.CARD_AUTHORIZED) return 'scheduled'
  return 'scheduled'
}

function getPlanTriggerStatusFromPaymentStatus(status) {
  const normalized = cleanString(status).toLowerCase()
  if (normalized === 'paid') return 'paid'
  if (normalized === 'failed') return 'failed'
  if (['void', 'deleted', 'cancelled', 'canceled'].includes(normalized)) return 'void'
  return 'pending'
}

function normalizePlanEditableAmount(value, fieldLabel = 'monto') {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) {
    const error = new Error(`El ${fieldLabel} debe ser un número válido.`)
    error.status = 400
    throw error
  }

  return Math.round(amount * 100) / 100
}

function normalizePlanEditablePaymentMethod(value, hasSavedCard) {
  const method = cleanString(value).toLowerCase()
  if (AUTOMATIC_PLAN_PAYMENT_METHODS.has(method)) {
    return {
      automatic: 1,
      installmentMethod: hasSavedCard ? 'stripe_saved_card' : 'stripe_pending_card',
      paymentMethod: 'stripe_scheduled_card'
    }
  }

  if (!MANUAL_PLAN_PAYMENT_METHODS.has(method)) {
    const error = new Error('Forma de cobro inválida para la parcialidad.')
    error.status = 400
    throw error
  }

  const normalizedManualMethod = method === 'transfer' ? 'bank_transfer' : method === 'offline' ? 'other' : method
  return {
    automatic: 0,
    installmentMethod: normalizedManualMethod,
    paymentMethod: normalizedManualMethod
  }
}

function normalizePlanEditableFirstPaymentMethod(value, hasSavedCard) {
  const method = cleanString(value).toLowerCase()
  if (AUTOMATIC_PLAN_PAYMENT_METHODS.has(method)) {
    return {
      flowMethod: hasSavedCard ? 'saved_card' : 'payment_link',
      paymentMethod: hasSavedCard ? 'stripe_saved_card' : 'stripe_pending_card',
      flowStatus: hasSavedCard ? 'scheduled' : 'pending'
    }
  }

  if (!MANUAL_PLAN_PAYMENT_METHODS.has(method)) {
    const error = new Error('Forma de cobro inválida para el primer pago.')
    error.status = 400
    throw error
  }

  const normalizedManualMethod = method === 'transfer' ? 'bank_transfer' : method === 'offline' ? 'other' : method
  return {
    flowMethod: normalizedManualMethod,
    paymentMethod: normalizedManualMethod,
    flowStatus: 'pending'
  }
}

function resolveEditableInstallmentStatus({ currentStatus, automatic, flowHasSavedCard, flowState }) {
  const normalizedStatus = cleanString(currentStatus).toLowerCase()
  if (LOCKED_PLAN_PAYMENT_STATUSES.has(normalizedStatus)) return normalizedStatus
  if (!automatic) return normalizedStatus === 'failed' ? 'failed' : 'pending'
  if (flowState === STRIPE_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE && flowHasSavedCard) return 'scheduled'
  return 'waiting_card_authorization'
}

function buildPlanInstallmentPaymentMetadata(flow, installment, sequence, paymentMode, source = 'stripe_payment_plan_installment') {
  return {
    stripeMode: paymentMode || 'test',
    source,
    contactName: flow.contact_name,
    contactEmail: flow.contact_email,
    contactPhone: flow.contact_phone,
    paymentPlan: {
      flowId: flow.id,
      installmentId: installment.id,
      sequence,
      trigger: 'scheduled_installment'
    }
  }
}

function getVisiblePlanPaymentNumber(sequence, hasFirstPayment) {
  const normalizedSequence = Number(sequence || 1)
  const safeSequence = Number.isFinite(normalizedSequence) && normalizedSequence > 0
    ? normalizedSequence
    : 1
  return safeSequence + (hasFirstPayment ? 1 : 0)
}

function getPlanPaymentTotal(hasFirstPayment, installmentCount) {
  const normalizedCount = Math.trunc(Number(installmentCount || 0))
  const safeCount = Number.isFinite(normalizedCount) && normalizedCount > 0 ? normalizedCount : 0
  const total = safeCount + (hasFirstPayment ? 1 : 0)
  return total > 0 ? total : 1
}

function normalizePlanPaymentTotal(totalPayments, fallbackPaymentNumber = 1) {
  const normalizedTotal = Math.trunc(Number(totalPayments || 0))
  if (Number.isFinite(normalizedTotal) && normalizedTotal > 0) return normalizedTotal
  return fallbackPaymentNumber > 0 ? fallbackPaymentNumber : 1
}

function buildPlanPaymentTitle(baseTitle, paymentNumber, totalPayments) {
  const normalizedPaymentNumber = Math.trunc(Number(paymentNumber || 1))
  const safePaymentNumber = Number.isFinite(normalizedPaymentNumber) && normalizedPaymentNumber > 0
    ? normalizedPaymentNumber
    : 1
  const safeTotal = normalizePlanPaymentTotal(totalPayments, safePaymentNumber)
  return `${cleanString(baseTitle) || 'Plan de pagos'} - Pago ${safePaymentNumber}/${safeTotal}`
}

function buildPlanFirstPaymentTitle(baseTitle, totalPayments) {
  return buildPlanPaymentTitle(baseTitle, 1, totalPayments)
}

function buildPlanInstallmentPaymentTitle(baseTitle, sequence, hasFirstPayment, totalPayments) {
  return buildPlanPaymentTitle(
    baseTitle,
    getVisiblePlanPaymentNumber(sequence, hasFirstPayment),
    totalPayments
  )
}

async function updatePlanPaymentTitle(paymentId, title, description = title) {
  const cleanPaymentId = cleanString(paymentId)
  if (!cleanPaymentId) return

  await db.run(
    `UPDATE payments
     SET title = ?,
         description = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [title, description, cleanPaymentId]
  )
}

async function persistStripePaymentPlanMirror(flowId, extra = {}) {
  const cleanFlowId = cleanString(flowId)
  if (!cleanFlowId) return null

  const flow = await db.get('SELECT * FROM payment_flows WHERE id = ?', [cleanFlowId])
  if (!flow || flow.payment_provider !== 'stripe') return null

  const installments = await db.all(
    `SELECT *
     FROM installment_payments
     WHERE flow_id = ?
     ORDER BY sequence ASC`,
    [cleanFlowId]
  )
  const previousMirror = await db.get('SELECT raw_json FROM payment_plans WHERE id = ?', [cleanFlowId])
  const previousRawJson = parseJson(previousMirror?.raw_json, {})
  const metadata = parseJson(flow.metadata, {})
  const visibleInstallments = (installments || []).filter((installment) => (
    !['cancelled', 'canceled', 'deleted', 'void'].includes(cleanString(installment.status).toLowerCase())
  ))
  const nextInstallment = visibleInstallments.find((installment) => (
    !['paid', 'cancelled', 'canceled', 'deleted'].includes(cleanString(installment.status).toLowerCase())
  )) || visibleInstallments[0] || null
  const lastInstallment = visibleInstallments[Math.max(0, visibleInstallments.length - 1)] || null
  const startDate = flow.first_payment_date || visibleInstallments[0]?.due_date || flow.created_at
  const nextRunAt = nextInstallment?.due_date || flow.first_payment_date || flow.created_at
  const itemCount = (Number(flow.first_payment_amount || 0) > 0 ? 1 : 0) + visibleInstallments.length
  const scheduleJson = {
    provider: 'stripe',
    flowId: cleanFlowId,
    remainingFrequency: metadata.remainingFrequency || 'custom',
    cardSetupRequired: Boolean(flow.card_setup_required),
    cardSetupStatus: flow.card_setup_status || null,
    cardSetupAmount: Number(flow.card_setup_amount || 0),
    cardSetupPaymentLink: flow.card_setup_payment_link || null,
    stripePaymentMethodLabel: flow.stripe_payment_method_label || null,
    firstPayment: {
      amount: Number(flow.first_payment_amount || 0),
      date: flow.first_payment_date || null,
      method: flow.first_payment_method || null,
      status: flow.first_payment_status || null,
      paymentId: flow.first_payment_invoice_id || null
    },
    installments: visibleInstallments.map((installment) => ({
      id: installment.id,
      sequence: installment.sequence,
      amount: Number(installment.amount || 0),
      percentage: installment.percentage ?? null,
      dueDate: installment.due_date || null,
      status: installment.status || null,
      paymentId: installment.payment_id || null,
      paymentMethod: installment.payment_method || null
    }))
  }
  const hasExtra = extra && Object.keys(extra).length > 0
  const preservedChangeSummary = hasExtra
    ? {}
    : {
        ...(Array.isArray(previousRawJson.addedInstallments) ? { addedInstallments: previousRawJson.addedInstallments } : {}),
        ...(previousRawJson.addedInstallmentCount ? { addedInstallmentCount: previousRawJson.addedInstallmentCount } : {})
      }
  const rawJson = {
    id: cleanFlowId,
    provider: 'stripe',
    paymentFlow: {
      id: cleanFlowId,
      state: flow.current_state,
      contactId: flow.contact_id,
      cardSetupAmount: Number(flow.card_setup_amount || 0),
      cardSetupPaymentLink: flow.card_setup_payment_link || null,
      stripePaymentMethodLabel: flow.stripe_payment_method_label || null
    },
    schedule: scheduleJson,
    ...preservedChangeSummary,
    ...(hasExtra ? extra : {})
  }

  await db.run(
    `INSERT INTO payment_plans (
      id, ghl_schedule_id, contact_id, contact_name, email, phone,
      name, title, status, total, currency, description, recurrence_label,
      start_date, next_run_at, end_date, live_mode, item_count,
      schedule_json, raw_json, source, last_synced_at, created_at, updated_at
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'stripe', CURRENT_TIMESTAMP, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      ghl_schedule_id = NULL,
      contact_id = excluded.contact_id,
      contact_name = excluded.contact_name,
      email = excluded.email,
      phone = excluded.phone,
      name = excluded.name,
      title = excluded.title,
      status = excluded.status,
      total = excluded.total,
      currency = excluded.currency,
      description = excluded.description,
      recurrence_label = excluded.recurrence_label,
      start_date = excluded.start_date,
      next_run_at = excluded.next_run_at,
      end_date = excluded.end_date,
      live_mode = excluded.live_mode,
      item_count = excluded.item_count,
      schedule_json = excluded.schedule_json,
      raw_json = excluded.raw_json,
      source = 'stripe',
      last_synced_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP`,
    [
      cleanFlowId,
      flow.contact_id,
      flow.contact_name || null,
      flow.contact_email || null,
      flow.contact_phone || null,
      flow.concept || 'Plan de pagos',
      flow.concept || 'Plan de pagos',
      getStripePlanMirrorStatus(flow),
      Number(flow.total_amount || 0),
      flow.currency || DEFAULT_CURRENCY,
      flow.concept || 'Plan de pagos',
      getStripePlanRecurrenceLabel(metadata.remainingFrequency),
      startDate || null,
      nextRunAt || null,
      lastInstallment?.due_date || null,
      itemCount,
      JSON.stringify(scheduleJson),
      JSON.stringify(rawJson),
      flow.created_at || null
    ]
  )

  return db.get('SELECT * FROM payment_plans WHERE id = ?', [cleanFlowId])
}

export async function refreshStripePaymentPlanMirrors() {
  const flows = await db.all(
    `SELECT id
     FROM payment_flows
     WHERE payment_provider = 'stripe'
     ORDER BY updated_at DESC`
  )

  let refreshed = 0
  for (const flow of flows || []) {
    const mirror = await persistStripePaymentPlanMirror(flow.id)
    if (mirror) refreshed += 1
  }

  return refreshed
}

export async function updateStripePaymentPlanSchedule(flowId, input = {}) {
  const cleanFlowId = cleanString(flowId)
  if (!cleanFlowId) {
    const error = new Error('Plan Stripe requerido.')
    error.status = 400
    throw error
  }

  const flow = await db.get('SELECT * FROM payment_flows WHERE id = ?', [cleanFlowId])
  if (!flow || flow.payment_provider !== 'stripe') {
    const error = new Error('Plan Stripe no encontrado.')
    error.status = 404
    throw error
  }

  const metadata = parseJson(flow.metadata, {})
  const accountTimezone = await getAccountTimezone()
  const hasSavedCard = Boolean(cleanString(flow.stripe_payment_method_id))
  const nextConcept = cleanString(input.name || input.title || input.description || input.concept || flow.concept || 'Plan de pagos')
  const nextFrequency = normalizePlanFrequency(input.remainingFrequency || input.frequency || metadata.remainingFrequency || 'custom')
  const submittedInstallments = Array.isArray(input.installments)
    ? input.installments
    : Array.isArray(input.remainingPayments)
      ? input.remainingPayments
      : []
  const hasFirstPaymentInput = Object.prototype.hasOwnProperty.call(input, 'firstPayment')
  const firstPayment = hasFirstPaymentInput && input.firstPayment && typeof input.firstPayment === 'object' ? input.firstPayment : null
  const firstPaymentStatus = cleanString(flow.first_payment_status).toLowerCase()
  const firstPaymentLocked = LOCKED_PLAN_PAYMENT_STATUSES.has(firstPaymentStatus) || ['registered', 'paid'].includes(firstPaymentStatus)
  const existingFirstPaymentForNumbering = Number(flow.first_payment_amount || 0) > 0 && firstPaymentStatus !== 'not_required'
  const submittedFirstPaymentForNumbering = Boolean(firstPayment && firstPayment.remove !== true && Number(firstPayment.amount || 0) > 0)
  const hasFirstPaymentForNumbering = firstPaymentLocked
    ? existingFirstPaymentForNumbering
    : hasFirstPaymentInput
      ? submittedFirstPaymentForNumbering
      : existingFirstPaymentForNumbering

  const existingInstallments = await db.all(
    `SELECT i.*, p.status AS payment_status, p.payment_mode AS payment_mode
     FROM installment_payments i
     LEFT JOIN payments p ON p.id = i.payment_id
     WHERE i.flow_id = ?
       AND LOWER(COALESCE(i.status, 'pending')) NOT IN ('deleted', 'cancelled', 'canceled', 'void')
     ORDER BY i.sequence ASC`,
    [cleanFlowId]
  )
  const existingById = new Map((existingInstallments || []).map(installment => [installment.id, installment]))
  const submittedExistingIdValues = new Set(
    submittedInstallments
      .map(installment => cleanString(installment?.id))
      .filter(Boolean)
  )
  const lockedUnsubmittedInstallmentCount = (existingInstallments || []).filter((installment) => {
    if (submittedExistingIdValues.has(installment.id)) return false
    const status = cleanString(installment.status || installment.payment_status).toLowerCase()
    return LOCKED_PLAN_PAYMENT_STATUSES.has(status)
  }).length
  const planPaymentTotalForNumbering = getPlanPaymentTotal(
    hasFirstPaymentForNumbering,
    submittedInstallments.length + lockedUnsubmittedInstallmentCount
  )
  const submittedExistingIds = new Set()
  const addedInstallments = []
  let nextSequence = 1
  let remainingTotal = 0

  for (const submitted of submittedInstallments) {
    const existingId = cleanString(submitted.id)
    const existing = existingId ? existingById.get(existingId) : null
    const existingStatus = cleanString(existing?.status || existing?.payment_status).toLowerCase()

    if (existing?.id) submittedExistingIds.add(existing.id)

    if (LOCKED_PLAN_PAYMENT_STATUSES.has(existingStatus)) {
      await updatePlanPaymentTitle(
        existing?.payment_id,
        buildPlanInstallmentPaymentTitle(nextConcept, nextSequence, hasFirstPaymentForNumbering, planPaymentTotalForNumbering),
        buildPlanInstallmentPaymentTitle(nextConcept, nextSequence, hasFirstPaymentForNumbering, planPaymentTotalForNumbering)
      )
      remainingTotal += Number(existing.amount || 0)
      nextSequence += 1
      continue
    }

    const amount = normalizePlanEditableAmount(submitted.amount, 'monto de la parcialidad')
    if (amount <= 0) {
      const error = new Error('Cada parcialidad futura debe tener un monto mayor a 0.')
      error.status = 400
      throw error
    }

    const dueDate = assertPlanDueDateNotInPast(
      submitted.dueDate || submitted.date || submitted.scheduledAt,
      nextFrequency,
      'Las parcialidades automáticas no pueden programarse en fechas pasadas.',
      accountTimezone
    )
    if (!dueDate) {
      const error = new Error('Cada parcialidad futura necesita fecha de cobro.')
      error.status = 400
      throw error
    }

    const method = normalizePlanEditablePaymentMethod(submitted.paymentMethod || submitted.method, hasSavedCard)
    if (method.automatic && !isTimedPlanFrequency(nextFrequency)) {
      assertDateNotInPast(dueDate, 'Las parcialidades automáticas no pueden programarse en fechas pasadas.', accountTimezone)
    }

    const status = resolveEditableInstallmentStatus({
      currentStatus: existingStatus,
      automatic: method.automatic,
      flowHasSavedCard: hasSavedCard,
      flowState: flow.current_state
    })
    const installmentId = existing?.id || createId('stripe_installment')
    const paymentId = existing?.payment_id || createId('stripe_plan_payment')
    const paymentMode = existing?.payment_mode || metadata.stripeMode || metadata.paymentMode || 'test'
    const title = buildPlanInstallmentPaymentTitle(nextConcept, nextSequence, hasFirstPaymentForNumbering, planPaymentTotalForNumbering)
    const notes = method.automatic
      ? hasSavedCard
        ? `Programado para cobrarse con ${flow.stripe_payment_method_label || 'tarjeta guardada'}`
        : 'Esperando domiciliación de tarjeta en Stripe.'
      : 'Pago manual dentro del plan.'

    if (existing) {
      await db.run(
        `UPDATE installment_payments
         SET sequence = ?,
             amount = ?,
             percentage = ?,
             due_date = ?,
             frequency = ?,
             payment_method = ?,
             automatic = ?,
             status = ?,
             payment_id = ?,
             notes = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          nextSequence,
          amount,
          submitted.percentage ?? null,
          dueDate,
          nextFrequency,
          method.installmentMethod,
          method.automatic,
          status,
          paymentId,
          notes,
          existing.id
        ]
      )
    } else {
      await db.run(
        `INSERT INTO installment_payments (
          id, flow_id, sequence, amount, percentage, due_date, frequency,
          payment_method, automatic, status, payment_id, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          installmentId,
          cleanFlowId,
          nextSequence,
          amount,
          submitted.percentage ?? null,
          dueDate,
          nextFrequency,
          method.installmentMethod,
          method.automatic,
          status,
          paymentId,
          notes
        ]
      )

      addedInstallments.push({
        id: installmentId,
        sequence: nextSequence,
        amount,
        dueDate,
        paymentMethod: method.installmentMethod
      })
    }

    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        payment_provider, title, description, date, due_date, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'stripe', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        contact_id = excluded.contact_id,
        amount = excluded.amount,
        currency = excluded.currency,
        status = CASE
          WHEN payments.status IN ('paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success') THEN payments.status
          ELSE excluded.status
        END,
        payment_method = excluded.payment_method,
        payment_mode = excluded.payment_mode,
        payment_provider = 'stripe',
        title = excluded.title,
        description = excluded.description,
        date = excluded.date,
        due_date = excluded.due_date,
        metadata_json = excluded.metadata_json,
        updated_at = CURRENT_TIMESTAMP`,
      [
        paymentId,
        flow.contact_id,
        amount,
        flow.currency || DEFAULT_CURRENCY,
        status === 'waiting_card_authorization' ? 'pending' : status,
        method.paymentMethod,
        paymentMode,
        title,
        title,
        dueDate,
        dueDate,
        JSON.stringify(buildPlanInstallmentPaymentMetadata(flow, { id: installmentId }, nextSequence, paymentMode))
      ]
    )

    remainingTotal += amount
    nextSequence += 1
  }

  for (const existing of existingInstallments || []) {
    if (submittedExistingIds.has(existing.id)) continue
    const existingStatus = cleanString(existing.status || existing.payment_status).toLowerCase()

    if (LOCKED_PLAN_PAYMENT_STATUSES.has(existingStatus)) {
      await updatePlanPaymentTitle(
        existing.payment_id,
        buildPlanInstallmentPaymentTitle(nextConcept, existing.sequence, hasFirstPaymentForNumbering, planPaymentTotalForNumbering),
        buildPlanInstallmentPaymentTitle(nextConcept, existing.sequence, hasFirstPaymentForNumbering, planPaymentTotalForNumbering)
      )
      remainingTotal += Number(existing.amount || 0)
      continue
    }

    await db.run(
      `UPDATE installment_payments
       SET status = 'deleted',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [existing.id]
    )

    if (existing.payment_id) {
      await db.run(
        `UPDATE payments
         SET status = 'deleted',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND LOWER(COALESCE(status, 'pending')) NOT IN ('paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'refunded', 'void', 'deleted')`,
        [existing.payment_id]
      )
    }
  }

  let firstPaymentAmount = Number(flow.first_payment_amount || 0)
  let firstPaymentDate = flow.first_payment_date || null
  let firstPaymentMethod = flow.first_payment_method || null
  let firstPaymentPaymentIdForLabel = hasFirstPaymentForNumbering ? flow.first_payment_invoice_id : null

  if (hasFirstPaymentInput && !firstPaymentLocked) {
    const firstPaymentInputAmount = firstPayment
      ? normalizePlanEditableAmount(firstPayment.amount, 'monto del primer pago')
      : 0
    const shouldRemoveFirstPayment = !firstPayment || firstPayment.remove === true || firstPaymentInputAmount <= 0

    if (shouldRemoveFirstPayment) {
      firstPaymentAmount = 0
      firstPaymentDate = null
      firstPaymentMethod = null
      firstPaymentPaymentIdForLabel = null

      await db.run(
        `UPDATE payment_flows
         SET first_payment_amount = 0,
             first_payment_value = 0,
             first_payment_date = NULL,
             first_payment_method = NULL,
             first_payment_status = NULL,
             first_payment_invoice_id = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND LOWER(COALESCE(first_payment_status, 'pending')) NOT IN ('paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'refunded', 'void', 'deleted')`,
        [cleanFlowId]
      )

      if (flow.first_payment_invoice_id) {
        await db.run(
          `UPDATE payments
           SET status = 'deleted',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?
             AND LOWER(COALESCE(status, 'pending')) NOT IN ('paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'refunded', 'void', 'deleted')`,
          [flow.first_payment_invoice_id]
        )
      }
    } else {
      firstPaymentAmount = firstPaymentInputAmount
      firstPaymentDate = normalizeDateOnly(firstPayment.dueDate || firstPayment.date || firstPaymentDate, accountTimezone)
      const firstPaymentMethodInput = cleanString(firstPayment.method || firstPayment.paymentMethod || firstPaymentMethod || 'stripe_auto').toLowerCase()
      const normalizedFirstPaymentMethod = normalizePlanEditableFirstPaymentMethod(
        firstPaymentMethodInput,
        hasSavedCard
      )
      if (AUTOMATIC_PLAN_PAYMENT_METHODS.has(firstPaymentMethodInput)) {
        assertDateNotInPast(firstPaymentDate, 'El primer pago automático no puede programarse en una fecha pasada.', accountTimezone)
      }

      firstPaymentMethod = normalizedFirstPaymentMethod.flowMethod
      const nextFirstPaymentStatus = firstPaymentStatus && firstPaymentStatus !== 'not_required'
        ? firstPaymentStatus
        : normalizedFirstPaymentMethod.flowStatus
      let firstPaymentPaymentId = flow.first_payment_invoice_id || null
      const firstPaymentTitle = buildPlanFirstPaymentTitle(nextConcept, planPaymentTotalForNumbering)

      if (!firstPaymentPaymentId) {
        firstPaymentPaymentId = await createStripePlanPaymentRow({
          contact: {
            id: flow.contact_id,
            name: flow.contact_name,
            email: flow.contact_email,
            phone: flow.contact_phone
          },
          amount: firstPaymentAmount,
          currency: flow.currency || DEFAULT_CURRENCY,
          status: nextFirstPaymentStatus,
          paymentMethod: normalizedFirstPaymentMethod.paymentMethod,
          title: firstPaymentTitle,
          description: firstPaymentTitle,
          dueDate: firstPaymentDate,
          metadata: {
            stripeMode: metadata.stripeMode || metadata.paymentMode || 'test',
            source: hasSavedCard ? 'stripe_payment_plan_first_saved_card' : 'stripe_payment_plan_first_link',
            contactName: flow.contact_name,
            contactEmail: flow.contact_email,
            contactPhone: flow.contact_phone,
            paymentPlan: {
              flowId: cleanFlowId,
              trigger: hasSavedCard ? 'first_payment_saved_card' : 'first_payment'
            }
          }
        })
      }
      firstPaymentPaymentIdForLabel = firstPaymentPaymentId

      await db.run(
        `UPDATE payment_flows
         SET first_payment_amount = ?,
             first_payment_value = ?,
             first_payment_date = ?,
             first_payment_method = ?,
             first_payment_status = ?,
             first_payment_invoice_id = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          firstPaymentAmount,
          firstPaymentAmount,
          firstPaymentDate,
          firstPaymentMethod,
          nextFirstPaymentStatus,
          firstPaymentPaymentId,
          cleanFlowId
        ]
      )

      if (firstPaymentPaymentId) {
        await db.run(
          `UPDATE payments
           SET amount = ?,
               payment_method = ?,
               status = CASE
                 WHEN payments.status IN ('paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success') THEN payments.status
                 ELSE ?
               END,
               date = COALESCE(?, date),
               due_date = COALESCE(?, due_date),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?
             AND LOWER(COALESCE(status, 'pending')) NOT IN ('paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'refunded', 'void', 'deleted')`,
          [
            firstPaymentAmount,
            normalizedFirstPaymentMethod.paymentMethod,
            nextFirstPaymentStatus,
            firstPaymentDate,
            firstPaymentDate,
            firstPaymentPaymentId
          ]
        )
      }
    }
  }

  if (hasFirstPaymentForNumbering && firstPaymentPaymentIdForLabel) {
    const firstPaymentTitle = buildPlanFirstPaymentTitle(nextConcept, planPaymentTotalForNumbering)
    await updatePlanPaymentTitle(firstPaymentPaymentIdForLabel, firstPaymentTitle, firstPaymentTitle)
  }

  const nextTotal = Math.round((remainingTotal + Number(firstPaymentAmount || 0)) * 100) / 100
  await db.run(
    `UPDATE payment_flows
     SET total_amount = ?,
         concept = ?,
         metadata = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      nextTotal,
      nextConcept,
      JSON.stringify({
        ...metadata,
        remainingFrequency: nextFrequency
      }),
      cleanFlowId
    ]
  )

  const mirrored = await persistStripePaymentPlanMirror(cleanFlowId, {
    localAction: 'update_schedule',
    actionedAt: new Date().toISOString(),
    addedInstallmentCount: addedInstallments.length,
    addedInstallments
  })

  return mirrored
}

async function activateStripePaymentPlan(flowId, savedMethod, config) {
  const cleanFlowId = cleanString(flowId)
  if (!cleanFlowId || !savedMethod) return null

  const flow = await db.get('SELECT * FROM payment_flows WHERE id = ?', [cleanFlowId])
  if (!flow || flow.payment_provider !== 'stripe') return null

  const stateHistory = addPlanState(addPlanState(flow.state_history, STRIPE_PLAN_STATES.CARD_AUTHORIZED), STRIPE_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE)
  const now = new Date().toISOString()

  await db.run(
    `UPDATE payment_flows
     SET current_state = ?,
         stripe_customer_id = COALESCE(?, stripe_customer_id),
         stripe_payment_method_id = COALESCE(?, stripe_payment_method_id),
         stripe_payment_method_label = COALESCE(?, stripe_payment_method_label),
         card_authorized_at = COALESCE(card_authorized_at, ?),
         installment_plan_created_at = COALESCE(installment_plan_created_at, ?),
         installment_plan_active_at = COALESCE(installment_plan_active_at, ?),
         state_history = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      STRIPE_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE,
      savedMethod.stripe_customer_id,
      savedMethod.stripe_payment_method_id,
      getSavedCardLabelFromRow(savedMethod),
      now,
      now,
      now,
      JSON.stringify(stateHistory),
      cleanFlowId
    ]
  )

  await db.run(
    `UPDATE installment_payments
     SET status = 'scheduled',
         payment_method = 'stripe_saved_card',
         updated_at = CURRENT_TIMESTAMP
     WHERE flow_id = ?
       AND automatic = 1
       AND status IN ('waiting_card_authorization', 'pending_card', 'pending')`,
    [cleanFlowId]
  )

  await db.run(
    `UPDATE payments
     SET status = 'scheduled',
         updated_at = CURRENT_TIMESTAMP
     WHERE id IN (
       SELECT payment_id
       FROM installment_payments
       WHERE flow_id = ?
         AND payment_id IS NOT NULL
     )
       AND status IN ('pending', 'waiting_card_authorization')`,
    [cleanFlowId]
  )

  await persistStripePaymentPlanMirror(cleanFlowId)

  return db.get('SELECT * FROM payment_flows WHERE id = ?', [cleanFlowId])
}

async function syncStripePlanFromPayment(paymentRow, savedMethod, config) {
  const metadata = parseJson(paymentRow?.metadata_json, {})
  const plan = metadata.paymentPlan && typeof metadata.paymentPlan === 'object'
    ? metadata.paymentPlan
    : {}
  const flowId = cleanString(plan.flowId)
  if (!flowId) return

  const trigger = cleanString(plan.trigger)
  const isFirstPlanPayment = FIRST_PAYMENT_PLAN_TRIGGERS.has(trigger) || (!trigger && !plan.installmentId)
  const isCardSetupPayment = CARD_SETUP_PLAN_TRIGGERS.has(trigger)

  if (plan.installmentId) {
    await db.run(
      `UPDATE installment_payments
       SET status = ?,
           stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        paymentRow.status === 'paid' ? 'paid' : paymentRow.status || 'pending',
        paymentRow.stripe_payment_intent_id || null,
        plan.installmentId
      ]
    )
  }

  if (isFirstPlanPayment && paymentRow.status) {
    const firstPaymentStatus = getPlanTriggerStatusFromPaymentStatus(paymentRow.status)

    await db.run(
      `UPDATE payment_flows
       SET first_payment_status = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND first_payment_invoice_id = ?`,
      [firstPaymentStatus, flowId, paymentRow.id]
    )
  }

  if (isCardSetupPayment && paymentRow.status) {
    const cardSetupStatus = getPlanTriggerStatusFromPaymentStatus(paymentRow.status)

    await db.run(
      `UPDATE payment_flows
       SET card_setup_status = ?,
           card_setup_invoice_id = COALESCE(card_setup_invoice_id, ?),
           card_setup_payment_link = COALESCE(card_setup_payment_link, ?),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [cardSetupStatus, paymentRow.id || null, paymentRow.payment_url || null, flowId]
    )
  }

  if (paymentRow.status === 'paid' && savedMethod && isFirstPlanPayment) {
    await activateStripePaymentPlan(flowId, savedMethod, config)
    return
  }

  if (paymentRow.status === 'paid' && savedMethod && isCardSetupPayment) {
    await activateStripePaymentPlan(flowId, savedMethod, config)
    return
  }

  await persistStripePaymentPlanMirror(flowId)
}

export async function syncStripePaymentPlanFromLocalPayment(paymentId) {
  const cleanPaymentId = cleanString(paymentId)
  if (!cleanPaymentId) return null

  const paymentRow = await db.get('SELECT * FROM payments WHERE id = ?', [cleanPaymentId])
  if (!paymentRow) return null

  await syncStripePlanFromPayment(paymentRow, null, null)

  const metadata = parseJson(paymentRow.metadata_json, {})
  const flowId = cleanString(metadata?.paymentPlan?.flowId)
  if (!flowId) return null

  return db.get('SELECT * FROM payment_plans WHERE id = ?', [flowId])
}

async function createStripePaymentPlanCardSetupLink(flow, { baseUrl } = {}) {
  if (!flow || flow.payment_provider !== 'stripe') {
    const error = new Error('Plan Stripe no encontrado.')
    error.status = 404
    throw error
  }

  const currentState = cleanString(flow.current_state).toLowerCase()
  if ([STRIPE_PLAN_STATES.CANCELLED, STRIPE_PLAN_STATES.DELETED].includes(currentState)) {
    const error = new Error('No se puede cambiar la tarjeta de un plan cancelado o eliminado.')
    error.status = 409
    throw error
  }

  const now = new Date().toISOString()
  const metadata = parseJson(flow.metadata, {})
  const concept = cleanString(flow.concept) || 'Plan de pagos'
  const currency = normalizeCurrency(flow.currency || DEFAULT_CURRENCY)
  const accountTimezone = await getAccountTimezone()
  const cardSetupAmount = await resolveStripeCardSetupAmount(flow.card_setup_amount || metadata.cardSetupAmount)
  const setupLink = await createStripePaymentLink({
    contactId: flow.contact_id,
    contactName: flow.contact_name,
    email: flow.contact_email,
    phone: flow.contact_phone,
    amount: cardSetupAmount,
    currency,
    title: `${concept} - cambiar tarjeta domiciliada`,
    description: `Domiciliación de nueva tarjeta para ${concept}`,
    dueDate: todayDateOnly(accountTimezone),
    source: 'stripe_payment_plan_card_update',
    lineItems: [
      {
        name: 'Cambio de tarjeta domiciliada',
        description: `Autorización para usar una nueva tarjeta en el plan ${concept}`,
        quantity: 1,
        amount: cardSetupAmount,
        currency
      }
    ],
    metadata: {
      paymentPlan: {
        flowId: flow.id,
        trigger: 'card_setup',
        reason: 'card_update'
      }
    }
  }, { baseUrl })

  const hasSavedCard = Boolean(cleanString(flow.stripe_payment_method_id))
  const nextState = hasSavedCard
    ? cleanString(flow.current_state) || STRIPE_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE
    : STRIPE_PLAN_STATES.WAITING_CARD_AUTHORIZATION
  const nextStateHistory = hasSavedCard
    ? parseJson(flow.state_history, [])
    : addPlanState(flow.state_history, STRIPE_PLAN_STATES.WAITING_CARD_AUTHORIZATION)

  await db.run(
    `UPDATE payment_flows
     SET card_setup_required = 1,
         card_setup_amount = ?,
         card_setup_status = 'pending',
         card_setup_invoice_id = ?,
         card_setup_payment_link = ?,
         current_state = ?,
         state_history = ?,
         metadata = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      cardSetupAmount,
      setupLink.payment?.id || null,
      setupLink.paymentUrl,
      nextState,
      JSON.stringify(nextStateHistory),
      JSON.stringify({
        ...metadata,
        cardSetupLinkRequired: true,
        cardUpdateRequestedAt: now,
        cardUpdatePaymentId: setupLink.payment?.id || null
      }),
      flow.id
    ]
  )

  return {
    cardSetupLink: setupLink.paymentUrl,
    cardSetupPaymentId: setupLink.payment?.id || null,
    cardSetupAmount,
    actionedAt: now
  }
}

export async function applyStripePaymentPlanAction(flowId, action, options = {}) {
  const cleanFlowId = cleanString(flowId)
  const normalizedAction = cleanString(action).toLowerCase()
  if (!cleanFlowId) {
    const error = new Error('Plan Stripe requerido.')
    error.status = 400
    throw error
  }

  const flow = await db.get('SELECT * FROM payment_flows WHERE id = ?', [cleanFlowId])
  if (!flow || flow.payment_provider !== 'stripe') {
    const error = new Error('Plan Stripe no encontrado.')
    error.status = 404
    throw error
  }

  const now = new Date().toISOString()
  const stateHistory = (nextState) => addPlanState(flow.state_history, nextState)

  if (['change_card', 'change-card', 'change_payment_method', 'replace_card'].includes(normalizedAction)) {
    const cardSetup = await createStripePaymentPlanCardSetupLink(flow, options)
    return persistStripePaymentPlanMirror(cleanFlowId, {
      localAction: 'change_card',
      actionedAt: cardSetup.actionedAt,
      response: {
        cardSetupLink: cardSetup.cardSetupLink,
        cardSetupPaymentId: cardSetup.cardSetupPaymentId,
        cardSetupAmount: cardSetup.cardSetupAmount
      }
    })
  }

  if (normalizedAction === 'activate') {
    const hasSavedCard = Boolean(cleanString(flow.stripe_payment_method_id))
    const nextState = hasSavedCard
      ? STRIPE_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE
      : STRIPE_PLAN_STATES.WAITING_CARD_AUTHORIZATION

    await db.run(
      `UPDATE payment_flows
       SET current_state = ?,
           installment_plan_created_at = CASE WHEN CAST(? AS TEXT) = ? THEN COALESCE(installment_plan_created_at, ?) ELSE installment_plan_created_at END,
           installment_plan_active_at = CASE WHEN CAST(? AS TEXT) = ? THEN COALESCE(installment_plan_active_at, ?) ELSE installment_plan_active_at END,
           state_history = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        nextState,
        nextState,
        STRIPE_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE,
        now,
        nextState,
        STRIPE_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE,
        now,
        JSON.stringify(stateHistory(nextState)),
        cleanFlowId
      ]
    )

    if (hasSavedCard) {
      await db.run(
        `UPDATE installment_payments
         SET status = 'scheduled',
             payment_method = 'stripe_saved_card',
             updated_at = CURRENT_TIMESTAMP
         WHERE flow_id = ?
           AND automatic = 1
           AND status IN ('waiting_card_authorization', 'pending_card', 'pending')`,
        [cleanFlowId]
      )
    }

    return persistStripePaymentPlanMirror(cleanFlowId, { localAction: normalizedAction, actionedAt: now })
  }

  if (normalizedAction === 'pause') {
    await db.run(
      `UPDATE payment_flows
       SET current_state = ?,
           state_history = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        STRIPE_PLAN_STATES.PAUSED,
        JSON.stringify(stateHistory(STRIPE_PLAN_STATES.PAUSED)),
        cleanFlowId
      ]
    )

    return persistStripePaymentPlanMirror(cleanFlowId, { localAction: normalizedAction, actionedAt: now })
  }

  if (!['cancel', 'delete'].includes(normalizedAction)) {
    const error = new Error('Acción inválida para plan Stripe.')
    error.status = 400
    throw error
  }

  if (normalizedAction === 'delete') {
    const audit = await getPaymentPlanAuditSummary(cleanFlowId)
    if (audit.isTestMode || (audit.isDeletedRecord && !audit.hasLedgerActivity)) {
      await hardDeleteTestPaymentPlan(cleanFlowId)
      return {
        id: cleanFlowId,
        status: STRIPE_PLAN_STATES.DELETED,
        source: 'stripe',
        deleted: true
      }
    }

    if (audit.hasLedgerActivity) {
      const error = new Error('Este plan ya tiene pagos, intentos, anulaciones o reembolsos registrados. No se puede eliminar; cancélalo para conservar el historial.')
      error.status = 422
      throw error
    }
  }

  const finalState = normalizedAction === 'delete'
    ? STRIPE_PLAN_STATES.DELETED
    : STRIPE_PLAN_STATES.CANCELLED
  const finalPaymentStatus = normalizedAction === 'delete' ? 'deleted' : 'void'
  const finalInstallmentStatus = normalizedAction === 'delete' ? 'deleted' : 'cancelled'

  await db.run(
    `UPDATE payment_flows
     SET current_state = ?,
         state_history = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      finalState,
      JSON.stringify(stateHistory(finalState)),
      cleanFlowId
    ]
  )

  await db.run(
    `UPDATE installment_payments
     SET status = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE flow_id = ?
       AND LOWER(COALESCE(status, 'pending')) NOT IN ('paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'refunded', 'void', 'deleted', 'cancelled', 'canceled')`,
    [finalInstallmentStatus, cleanFlowId]
  )

  await db.run(
    `UPDATE payments
     SET status = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id IN (
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
     )
       AND LOWER(COALESCE(status, 'pending')) NOT IN ('paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'refunded', 'void', 'deleted')`,
    [finalPaymentStatus, cleanFlowId, cleanFlowId, cleanFlowId]
  )

  const mirrored = await persistStripePaymentPlanMirror(cleanFlowId, {
    localAction: normalizedAction,
    actionedAt: now
  })

  if (normalizedAction === 'delete') {
    await db.run(
      `UPDATE payment_plans
       SET status = 'deleted',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [cleanFlowId]
    )
  }

  return mirrored
}

export async function createStripeSavedCardPayment(input = {}) {
  const { stripe, config, requestOptions } = await getStripeClient()
  const contactId = cleanString(input.contactId)
  const selectedPaymentMethodId = cleanString(input.paymentMethodId)
  const amount = Number(input.amount)

  if (!contactId) {
    const error = new Error('Selecciona un contacto.')
    error.status = 400
    throw error
  }

  if (!selectedPaymentMethodId) {
    const error = new Error('Selecciona una tarjeta guardada.')
    error.status = 400
    throw error
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error('El monto debe ser mayor a 0.')
    error.status = 400
    throw error
  }

  let savedMethod = await db.get(
    `SELECT spm.*, c.full_name AS contact_name, c.email AS contact_email, c.phone AS contact_phone
     FROM stripe_payment_methods spm
     LEFT JOIN contacts c ON c.id = spm.contact_id
     WHERE spm.contact_id = ?
       AND spm.mode = ?
       AND (spm.id = ? OR spm.stripe_payment_method_id = ?)
     LIMIT 1`,
    [contactId, config.mode, selectedPaymentMethodId, selectedPaymentMethodId]
  )

  if (!savedMethod) {
    await getStripeSavedPaymentMethods(contactId)
    savedMethod = await db.get(
      `SELECT spm.*, c.full_name AS contact_name, c.email AS contact_email, c.phone AS contact_phone
       FROM stripe_payment_methods spm
       LEFT JOIN contacts c ON c.id = spm.contact_id
       WHERE spm.contact_id = ?
         AND spm.mode = ?
         AND (spm.id = ? OR spm.stripe_payment_method_id = ?)
       LIMIT 1`,
      [contactId, config.mode, selectedPaymentMethodId, selectedPaymentMethodId]
    )
  }

  if (!savedMethod) {
    const error = new Error('No encontramos esa tarjeta guardada para este contacto.')
    error.status = 404
    throw error
  }

  const id = createId('stripe_saved_payment')
  const currency = await getConfiguredCurrency()
  const now = new Date().toISOString()
  const title = cleanString(input.title) || 'Pago'
  const description = cleanString(input.description) || title
  const paymentSettings = await getPublicPaymentSettings()
  const shouldApplyTax = input.applyTax !== false
  const taxSettings = {
    ...paymentSettings.taxes,
    enabled: Boolean(paymentSettings.taxes?.enabled && shouldApplyTax),
    calculationMode: ['exclusive', 'inclusive'].includes(input.taxCalculationMode)
      ? input.taxCalculationMode
      : paymentSettings.taxes?.calculationMode
  }
  const tax = calculatePaymentTax(amount, taxSettings)
  const chargeAmount = tax?.totalAmount || Math.round(amount * 100) / 100
  const metadata = {
    source: cleanString(input.source || 'ristak_saved_card'),
    contactName: cleanString(input.contactName || savedMethod.contact_name),
    contactEmail: cleanString(input.email || savedMethod.contact_email),
    contactPhone: cleanString(input.phone || savedMethod.contact_phone),
    stripeCustomerId: savedMethod.stripe_customer_id,
    stripePaymentMethodId: savedMethod.stripe_payment_method_id,
    savedPaymentMethod: {
      brand: savedMethod.brand || '',
      last4: savedMethod.last4 || '',
      expMonth: savedMethod.exp_month || null,
      expYear: savedMethod.exp_year || null
    },
    lineItems: Array.isArray(input.lineItems) ? input.lineItems : [],
    ...(tax ? { tax } : {})
  }

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, reference, title, description, date, due_date, sent_at,
      metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      id,
      contactId,
      chargeAmount,
      currency,
      'pending',
      'stripe_saved_card',
      config.mode,
      'stripe',
      null,
      title,
      description,
      now,
      input.dueDate || null,
      now,
      JSON.stringify(metadata)
    ]
  )

  try {
    await chargeStripePaymentRowWithSavedMethod({
      stripe,
      config,
      requestOptions,
      paymentId: id,
      savedMethod,
      source: 'ristak_saved_card'
    })
  } catch (error) {
    throw error
  }

  const row = await db.get('SELECT * FROM payments WHERE id = ?', [id])
  return { payment: mapSavedCardPayment(row) }
}

export async function createStripePaymentPlan(input = {}, { baseUrl } = {}) {
  const { stripe, config, requestOptions } = await getStripeClient()
  const accountCurrency = await getConfiguredCurrency()
  const accountTimezone = await getAccountTimezone()
  const plan = validateStripePaymentPlanPayload({ ...input, currency: accountCurrency }, accountTimezone)
  plan.cardSetupAmount = await resolveStripeCardSetupAmount(input.cardSetupAmount)
  const savedMethod = plan.paymentMethodId
    ? await resolveStripeSavedMethod(plan.contact.id, plan.paymentMethodId, config)
    : null
  const hasSavedCard = Boolean(savedMethod)
  const firstPaymentIsCard = plan.firstPayment.enabled && ['card', 'payment_link', 'direct_card', 'saved_card'].includes(plan.firstPayment.method)
  const firstPaymentIsOffline = plan.firstPayment.enabled && ['cash', 'bank_transfer', 'transfer', 'deposit', 'manual', 'offline', 'check', 'other'].includes(plan.firstPayment.method)
  const needsSeparateCardSetup = !hasSavedCard && !firstPaymentIsCard
  const cardSetupAmount = needsSeparateCardSetup ? plan.cardSetupAmount : (firstPaymentIsCard ? plan.firstPayment.amount : 0)

  const flowId = createId('stripe_flow')
  const stateHistory = addPlanState([], hasSavedCard ? STRIPE_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE : STRIPE_PLAN_STATES.WAITING_CARD_AUTHORIZATION)
  const flowState = hasSavedCard
    ? STRIPE_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE
    : STRIPE_PLAN_STATES.WAITING_CARD_AUTHORIZATION
  const now = new Date().toISOString()
  const cardLabel = hasSavedCard ? getSavedCardLabelFromRow(savedMethod) : ''
  const firstPaymentDueNow = plan.firstPayment.enabled
    ? isPlanChargeDueNow(plan.firstPayment.date, plan.remainingFrequency, accountTimezone)
    : false

  await db.run(
    `INSERT INTO payment_flows (
      id, contact_id, contact_name, contact_email, contact_phone,
      total_amount, currency, concept, payment_type,
      first_payment_amount, first_payment_type, first_payment_value,
      first_payment_date, first_payment_method, first_payment_status,
      remaining_automatic, card_setup_required, card_setup_amount,
      payment_provider, stripe_customer_id, stripe_payment_method_id, stripe_payment_method_label,
      current_state, state_history, card_authorized_at,
      installment_plan_created_at, installment_plan_active_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'partial', ?, ?, ?, ?, ?, ?, 1, ?, ?, 'stripe', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      flowId,
      plan.contact.id,
      plan.contact.name || null,
      plan.contact.email || null,
      plan.contact.phone || null,
      plan.totalAmount,
      plan.currency,
      plan.description,
      plan.firstPayment.amount,
      plan.firstPayment.enabled ? 'amount' : 'none',
      plan.firstPayment.amount,
      plan.firstPayment.date,
      plan.firstPayment.method,
      plan.firstPayment.enabled ? (hasSavedCard && firstPaymentIsCard && firstPaymentDueNow ? 'processing' : 'pending') : 'not_required',
      hasSavedCard ? 0 : 1,
      cardSetupAmount,
      savedMethod?.stripe_customer_id || null,
      savedMethod?.stripe_payment_method_id || null,
      cardLabel || null,
      flowState,
      JSON.stringify(stateHistory),
      hasSavedCard ? now : null,
      hasSavedCard ? now : null,
      hasSavedCard ? now : null,
      JSON.stringify({
        source: plan.source,
        timezone: accountTimezone,
        remainingFrequency: plan.remainingFrequency,
        lineItems: plan.lineItems,
        firstPaymentLinkRequired: !hasSavedCard && firstPaymentIsCard,
        cardSetupLinkRequired: needsSeparateCardSetup
      })
    ]
  )

  const response = {
    flowId,
    currentState: flowState,
    paymentMode: config.mode,
    firstPaymentLink: null,
    firstPaymentPaymentId: null,
    cardSetupLink: null,
    cardSetupPaymentId: null,
    cardSetupAmount: needsSeparateCardSetup ? plan.cardSetupAmount : 0,
    savedPaymentMethod: hasSavedCard ? mapStripePaymentMethod(savedMethod) : null,
    scheduledPayments: []
  }
  const planPaymentTotal = getPlanPaymentTotal(plan.firstPayment.enabled, plan.remainingPayments.length)
  const firstPaymentTitle = buildPlanFirstPaymentTitle(plan.title, planPaymentTotal)
  const firstPaymentDescription = buildPlanFirstPaymentTitle(plan.description, planPaymentTotal)

  if (plan.firstPayment.enabled && firstPaymentIsOffline) {
    const paymentId = await createStripePlanPaymentRow({
      contact: plan.contact,
      amount: plan.firstPayment.amount,
      currency: plan.currency,
      status: 'paid',
      paymentMethod: plan.firstPayment.method,
      provider: 'manual',
      title: firstPaymentTitle,
      description: firstPaymentDescription,
      dueDate: plan.firstPayment.date,
      metadata: {
        paymentMode: config.mode,
        source: 'stripe_payment_plan_first_offline',
        contactName: plan.contact.name,
        contactEmail: plan.contact.email,
        contactPhone: plan.contact.phone,
        paymentPlan: {
          flowId,
          trigger: 'first_payment_offline'
        }
      }
    })

    await db.run(
      `UPDATE payment_flows
       SET first_payment_status = 'registered',
           first_payment_invoice_id = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [paymentId, flowId]
    )
    response.firstPaymentPaymentId = paymentId
    updateSingleContactStats(plan.contact.id).catch((error) => {
      logger.warn(`No se pudieron actualizar stats del contacto por primer pago ${paymentId}: ${error.message}`)
    })
  }

  if (plan.firstPayment.enabled && firstPaymentIsCard && hasSavedCard) {
    const paymentId = await createStripePlanPaymentRow({
      contact: plan.contact,
      amount: plan.firstPayment.amount,
      currency: plan.currency,
      status: firstPaymentDueNow ? 'pending' : 'scheduled',
      paymentMethod: 'stripe_saved_card',
      title: firstPaymentTitle,
      description: firstPaymentDescription,
      dueDate: plan.firstPayment.date,
      metadata: {
        stripeMode: config.mode,
        source: 'stripe_payment_plan_first_saved_card',
        contactName: plan.contact.name,
        contactEmail: plan.contact.email,
        contactPhone: plan.contact.phone,
        paymentPlan: {
          flowId,
          trigger: 'first_payment_saved_card'
        }
      }
    })

    await db.run(
      `UPDATE payment_flows
       SET first_payment_invoice_id = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [paymentId, flowId]
    )
    response.firstPaymentPaymentId = paymentId

    if (firstPaymentDueNow) {
      try {
        await chargeStripePaymentRowWithSavedMethod({
          stripe,
          config,
          requestOptions,
          paymentId,
          savedMethod,
          source: 'stripe_payment_plan_first_saved_card',
          extraMetadata: { ristak_flow_id: flowId, ristak_plan_trigger: 'first_payment_saved_card' }
        })
      } catch (error) {
        await db.run(
          `UPDATE payment_flows
           SET first_payment_status = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [error.status === 402 ? 'requires_action' : 'failed', flowId]
        )
        throw error
      }
    }
  }

  if (plan.firstPayment.enabled && firstPaymentIsCard && !hasSavedCard) {
    const firstPaymentLink = await createStripePaymentLink({
      contactId: plan.contact.id,
      contactName: plan.contact.name,
      email: plan.contact.email,
      phone: plan.contact.phone,
      amount: plan.firstPayment.amount,
      currency: plan.currency,
      title: firstPaymentTitle,
      description: firstPaymentDescription,
      dueDate: plan.firstPayment.date,
      source: 'stripe_payment_plan_first_link',
      lineItems: plan.lineItems,
      metadata: {
        paymentPlan: {
          flowId,
          trigger: 'first_payment'
        }
      }
    }, { baseUrl })

    await db.run(
      `UPDATE payment_flows
       SET first_payment_invoice_id = ?,
           card_setup_payment_link = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [firstPaymentLink.payment?.id || null, firstPaymentLink.paymentUrl, flowId]
    )

    response.firstPaymentPaymentId = firstPaymentLink.payment?.id || null
    response.firstPaymentLink = firstPaymentLink.paymentUrl
  }

  if (needsSeparateCardSetup) {
    const setupLink = await createStripePaymentLink({
      contactId: plan.contact.id,
      contactName: plan.contact.name,
      email: plan.contact.email,
      phone: plan.contact.phone,
      amount: plan.cardSetupAmount,
      currency: plan.currency,
      title: `${plan.title} - domiciliación de tarjeta`,
      description: `Domiciliación de tarjeta para ${plan.description}`,
      dueDate: businessTodayDateOnly(accountTimezone),
      source: 'stripe_payment_plan_card_setup',
      lineItems: [
        {
          name: 'Domiciliación de tarjeta',
          description: `Autorización para cobros automáticos del plan ${plan.title}`,
          quantity: 1,
          amount: plan.cardSetupAmount,
          currency: plan.currency
        }
      ],
      metadata: {
        paymentPlan: {
          flowId,
          trigger: 'card_setup'
        }
      }
    }, { baseUrl })

    await db.run(
      `UPDATE payment_flows
       SET card_setup_status = 'pending',
           card_setup_invoice_id = ?,
           card_setup_payment_link = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [setupLink.payment?.id || null, setupLink.paymentUrl, flowId]
    )

    response.cardSetupPaymentId = setupLink.payment?.id || null
    response.cardSetupLink = setupLink.paymentUrl
  }

  for (const payment of plan.remainingPayments) {
    const installmentId = createId('stripe_installment')
    const status = hasSavedCard ? 'scheduled' : 'waiting_card_authorization'
    const paymentId = await createStripePlanPaymentRow({
      contact: plan.contact,
      amount: payment.amount,
      currency: plan.currency,
      status: hasSavedCard ? 'scheduled' : 'pending',
      paymentMethod: 'stripe_scheduled_card',
      title: buildPlanInstallmentPaymentTitle(plan.title, payment.sequence, plan.firstPayment.enabled, planPaymentTotal),
      description: buildPlanInstallmentPaymentTitle(plan.description, payment.sequence, plan.firstPayment.enabled, planPaymentTotal),
      dueDate: payment.dueDate,
      metadata: {
        stripeMode: config.mode,
        source: 'stripe_payment_plan_installment',
        contactName: plan.contact.name,
        contactEmail: plan.contact.email,
        contactPhone: plan.contact.phone,
        paymentPlan: {
          flowId,
          installmentId,
          sequence: payment.sequence,
          trigger: 'scheduled_installment'
        }
      }
    })

    await db.run(
      `INSERT INTO installment_payments (
        id, flow_id, sequence, amount, percentage, due_date, frequency,
        payment_method, automatic, status, payment_id, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        installmentId,
        flowId,
        payment.sequence,
        payment.amount,
        payment.percentage,
        payment.dueDate,
        payment.frequency,
        hasSavedCard ? 'stripe_saved_card' : 'stripe_pending_card',
        status,
        paymentId,
        hasSavedCard ? `Programado para cobrarse con ${cardLabel}` : 'Esperando domiciliación de tarjeta en Stripe.'
      ]
    )

    response.scheduledPayments.push({
      installmentId,
      paymentId,
      sequence: payment.sequence,
      amount: payment.amount,
      currency: plan.currency,
      dueDate: payment.dueDate,
      status
    })
  }

  await persistStripePaymentPlanMirror(flowId, {
    response
  })

  return response
}

export async function processDueStripePaymentPlanCharges({ limit = 25 } = {}) {
  const { stripe, config, requestOptions } = await getStripeClient()
  const accountTimezone = await getAccountTimezone()
  const dueDate = todayDateOnly(accountTimezone)
  const dueTimestamp = new Date().toISOString()
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 25, 100))
  const firstPaymentDueExpression = 'COALESCE(f.first_payment_date, p.due_date, p.date)'
  const firstPaymentDueSql = duePlanFirstPaymentCondition(firstPaymentDueExpression)
  const installmentDueSql = duePlanInstallmentCondition('i')
  const staleFirstPaymentSql = staleProcessingSql('f.updated_at')
  const staleInstallmentSql = staleProcessingSql('i.updated_at')
  const firstPaymentRows = await db.all(
    `SELECT
       f.id AS flow_id,
       f.contact_id,
       f.first_payment_invoice_id AS payment_id,
       f.first_payment_date,
       f.metadata,
       f.stripe_payment_method_id,
       p.status AS payment_status,
       p.due_date AS payment_due_date,
       p.date AS payment_date
     FROM payment_flows f
     JOIN payments p ON p.id = f.first_payment_invoice_id
     WHERE f.payment_provider = 'stripe'
       AND f.current_state = ?
       AND f.first_payment_invoice_id IS NOT NULL
       AND (
         f.first_payment_status IN ('pending', 'scheduled')
         OR (f.first_payment_status = 'processing' AND ${staleFirstPaymentSql})
       )
       AND f.first_payment_method IN ('card', 'payment_link', 'direct_card', 'saved_card')
       AND f.stripe_payment_method_id IS NOT NULL
       AND ${firstPaymentDueSql}
       AND p.status IN ('pending', 'scheduled', 'processing')
     ORDER BY COALESCE(f.first_payment_date, p.due_date, p.date) ASC
     LIMIT ?`,
    [STRIPE_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE, dueTimestamp, dueDate, normalizedLimit]
  )
  const rows = await db.all(
    `SELECT
       i.id AS installment_id,
       i.payment_id,
       i.amount AS installment_amount,
       i.due_date,
       i.status AS installment_status,
       f.id AS flow_id,
       f.contact_id,
       f.stripe_payment_method_id,
       f.stripe_customer_id,
       p.status AS payment_status
     FROM installment_payments i
     JOIN payment_flows f ON f.id = i.flow_id
     LEFT JOIN payments p ON p.id = i.payment_id
     WHERE f.payment_provider = 'stripe'
       AND f.current_state = ?
       AND i.automatic = 1
       AND (
         i.status = 'scheduled'
         OR (i.status = 'processing' AND ${staleInstallmentSql})
       )
       AND i.payment_id IS NOT NULL
       AND ${installmentDueSql}
     ORDER BY i.due_date ASC, i.sequence ASC
     LIMIT ?`,
    [STRIPE_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE, dueTimestamp, dueDate, normalizedLimit]
  )

  const results = []
  const touchedFlowIds = new Set()
  for (const row of firstPaymentRows || []) {
    const rowMetadata = parseJson(row.metadata, {})
    const firstPaymentDueValue = row.first_payment_date || row.payment_due_date || row.payment_date
    if (!isPlanChargeDueNow(firstPaymentDueValue, rowMetadata.remainingFrequency, accountTimezone)) {
      continue
    }

    touchedFlowIds.add(row.flow_id)
    try {
      const savedMethod = await resolveStripeSavedMethod(row.contact_id, row.stripe_payment_method_id, config)
      if (!savedMethod) {
        throw new Error('No encontramos la tarjeta guardada para el primer pago programado.')
      }

      await db.run(
        `UPDATE payment_flows
         SET first_payment_status = 'processing',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [row.flow_id]
      )

      const charged = await chargeStripePaymentRowWithSavedMethod({
        stripe,
        config,
        requestOptions,
        paymentId: row.payment_id,
        savedMethod,
        source: 'stripe_payment_plan_first_scheduled_charge',
        extraMetadata: {
          ristak_flow_id: row.flow_id,
          ristak_plan_trigger: 'first_payment_saved_card'
        }
      })

      if (charged?.status === 'paid') {
        await db.run(
          `UPDATE payment_flows
           SET first_payment_status = 'paid',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [row.flow_id]
        )
      }

      results.push({ flowId: row.flow_id, paymentId: row.payment_id, firstPayment: true, charged: charged?.status === 'paid', status: charged?.status })
    } catch (error) {
      logger.error(`[Stripe Planes] Error cobrando primer pago programado ${row.payment_id}: ${error.message}`)
      await db.run(
        `UPDATE payment_flows
         SET first_payment_status = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [error.status === 402 ? 'requires_action' : 'failed', row.flow_id]
      )
      results.push({ flowId: row.flow_id, paymentId: row.payment_id, firstPayment: true, error: error.message })
    }
  }

  for (const row of rows || []) {
    touchedFlowIds.add(row.flow_id)
    if (row.payment_status === 'paid') {
      await db.run(
        `UPDATE installment_payments
         SET status = 'paid',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [row.installment_id]
      )
      results.push({ installmentId: row.installment_id, paymentId: row.payment_id, skipped: true, reason: 'already_paid' })
      continue
    }

    try {
      const savedMethod = await resolveStripeSavedMethod(row.contact_id, row.stripe_payment_method_id, config)
      if (!savedMethod) {
        throw new Error('No encontramos la tarjeta guardada para este plan.')
      }

      await db.run(
        `UPDATE installment_payments
         SET status = 'processing',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [row.installment_id]
      )

      const charged = await chargeStripePaymentRowWithSavedMethod({
        stripe,
        config,
        requestOptions,
        paymentId: row.payment_id,
        savedMethod,
        source: 'stripe_payment_plan_scheduled_charge',
        extraMetadata: {
          ristak_flow_id: row.flow_id,
          ristak_installment_id: row.installment_id
        }
      })

      await db.run(
        `UPDATE installment_payments
         SET status = ?,
             stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          charged?.status === 'paid' ? 'paid' : (charged?.status || 'processing'),
          charged?.stripe_payment_intent_id || null,
          row.installment_id
        ]
      )

      results.push({ installmentId: row.installment_id, paymentId: row.payment_id, charged: charged?.status === 'paid', status: charged?.status })
    } catch (error) {
      logger.error(`[Stripe Planes] Error cobrando parcialidad ${row.installment_id}: ${error.message}`)
      await db.run(
        `UPDATE installment_payments
         SET status = ?,
             notes = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [error.status === 402 ? 'requires_action' : 'failed', error.message, row.installment_id]
      )
      results.push({ installmentId: row.installment_id, paymentId: row.payment_id, error: error.message })
    }
  }

  for (const flowId of touchedFlowIds) {
    await persistStripePaymentPlanMirror(flowId)
  }

  return results
}

export async function refreshStripePaymentFromIntent(paymentIntentId, mode = '') {
  const context = await getStripeClient(mode)
  const { stripe, requestOptions } = context
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId, requestOptions)
  return updatePaymentFromIntent(intent, context)
}

async function getStripeWebhookContexts() {
  const activeContext = await getStripeClient()
  const contexts = [activeContext]
  const activeMode = normalizeMode(activeContext.config.mode)
  const otherMode = activeMode === 'live' ? 'test' : 'live'

  if (!activeContext.config.manualModes?.[otherMode]?.configured) return contexts

  try {
    const otherContext = await getStripeClient(otherMode)
    if (
      otherContext.config.webhookSecret &&
      otherContext.config.webhookSecret !== activeContext.config.webhookSecret
    ) {
      contexts.push(otherContext)
    }
  } catch (error) {
    logger.warn(`No se pudo preparar webhook de Stripe en modo ${otherMode}: ${error.message}`)
  }

  return contexts
}

export async function handleStripeWebhookEvent(rawBody, signature) {
  const contexts = await getStripeWebhookContexts()
  if (!contexts.some((context) => context.config.webhookSecret)) {
    const error = new Error('Configura el webhook secret de Stripe antes de recibir eventos.')
    error.status = 400
    throw error
  }

  let verified = null
  let lastError = null
  for (const context of contexts) {
    const { stripe, config } = context
    if (!config.webhookSecret) continue
    try {
      const event = stripe.webhooks.constructEvent(rawBody, signature, config.webhookSecret)
      verified = { ...context, event }
      break
    } catch (error) {
      lastError = error
    }
  }

  if (!verified) {
    throw lastError || new Error('No se pudo verificar la firma del webhook de Stripe.')
  }

  const { stripe, config, requestOptions, event } = verified

  // (PAY-005) Dedupe por event.id: Stripe reintenta entregas; reclamamos el id de forma
  // atómica para no re-procesar el mismo evento (doble registro de pago/reembolso).
  // Fail-open: ante cualquier problema con la tabla, seguimos procesando.
  if (event?.id) {
    try {
      const claim = await db.run(
        'INSERT INTO stripe_webhook_events (event_id, type) VALUES (?, ?) ON CONFLICT DO NOTHING',
        [String(event.id), event.type || null]
      )
      if (Number(claim?.changes || 0) === 0) {
        return { received: true, duplicate: true, type: event.type }
      }
    } catch (error) {
      logger.warn(`[Stripe webhook] No se pudo deduplicar el evento ${event.id}: ${error.message}`)
    }
  }

  const object = event?.data?.object

  if (object?.object === 'payment_intent') {
    await updatePaymentFromIntent(object, { stripe, config, requestOptions, eventType: event.type })
  } else if (event.type === 'checkout.session.completed' && object?.object === 'checkout.session') {
    await updateSubscriptionFromStripeCheckoutSession(object, { stripe, requestOptions })
  } else if (event.type === 'invoice.payment_succeeded' && object?.object === 'invoice') {
    await updateSubscriptionFromInvoice(object, 'paid')
    await updatePaymentFromInvoice(object, 'paid')
  } else if (event.type === 'invoice.payment_failed' && object?.object === 'invoice') {
    await updateSubscriptionFromInvoice(object, 'failed')
    await updatePaymentFromInvoice(object, 'failed')
  } else if (
    (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') &&
    object?.object === 'subscription'
  ) {
    await updateSubscriptionFromStripeSubscription(object)
  } else if (event.type === 'charge.refunded' && object?.object === 'charge') {
    await updatePaymentFromRefundedCharge(object)
  } else if (event.type === 'refund.created' && object?.object === 'refund') {
    await updatePaymentFromRefund(object)
  }

  return { received: true, type: event.type }
}
