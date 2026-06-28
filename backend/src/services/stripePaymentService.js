import Stripe from 'stripe'
import { randomBytes } from 'crypto'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { decrypt, encrypt, isEncrypted } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'
import { updateSingleContactStats } from '../utils/updateContactsStats.js'
import { getAccountCurrency } from '../utils/accountLocale.js'
import { getPaymentPlanAuditSummary, hardDeleteTestPaymentPlan } from './paymentRecordSafetyService.js'
import {
  claimCentralOAuthHandoff,
  createCentralStripeConnectUrl,
  disconnectCentralStripeConnect,
  isLicenseEnforced
} from './licenseService.js'
import { calculatePaymentTax, getPaymentGatewayMode, getPaymentSettings, getPublicPaymentSettings, savePaymentSettings } from './paymentSettingsService.js'
import { queuePaymentAutomationMessage } from './paymentAutomationsService.js'
import { registerGigstackPaymentForTransactionInBackground } from './gigstackInvoiceService.js'
import { buildMetaPublicPurchasePixelEvent } from './metaConversionEventsService.js'

const CONFIG_KEYS = {
  enabled: 'stripe_enabled',
  connectionType: 'stripe_connection_type',
  mode: 'stripe_mode',
  publishableKey: 'stripe_publishable_key',
  secretKey: 'stripe_secret_key_encrypted',
  webhookSecret: 'stripe_webhook_secret_encrypted',
  manualModeConnections: 'stripe_manual_mode_connections',
  defaultCurrency: 'stripe_default_currency',
  accountLabel: 'stripe_account_label',
  disconnectedAt: 'stripe_disconnected_at',
  connectAccountId: 'stripe_connect_account_id',
  connectScope: 'stripe_connect_scope',
  connectLivemode: 'stripe_connect_livemode',
  connectTokenType: 'stripe_connect_token_type',
  connectAccessToken: 'stripe_connect_access_token_encrypted',
  connectRefreshToken: 'stripe_connect_refresh_token_encrypted',
  connectPublishableKey: 'stripe_connect_publishable_key',
  connectAccountEmail: 'stripe_connect_account_email',
  connectChargesEnabled: 'stripe_connect_charges_enabled',
  connectPayoutsEnabled: 'stripe_connect_payouts_enabled',
  connectDetailsSubmitted: 'stripe_connect_details_submitted',
  connectWebhookEndpointId: 'stripe_connect_webhook_endpoint_id',
  connectWebhookUrl: 'stripe_connect_webhook_url',
  connectWebhookStatus: 'stripe_connect_webhook_status',
  connectWebhookLastError: 'stripe_connect_webhook_last_error',
  connectConnectedAt: 'stripe_connect_connected_at',
  connectDisconnectedAt: 'stripe_connect_disconnected_at',
  connectManagedByPortal: 'stripe_connect_managed_by_portal',
  connectOauthState: 'stripe_connect_oauth_state',
  connectModeConnections: 'stripe_connect_mode_connections'
}

const MASKED_PREFIX = '***'
const DEFAULT_CURRENCY = 'MXN'
const STRIPE_MODES = ['test', 'live']
const STRIPE_CONNECT_SCOPE = 'read_write'
const STRIPE_CONNECT_AUTHORIZE_URL = 'https://connect.stripe.com/oauth/authorize'
const STRIPE_CONNECT_TOKEN_URL = 'https://connect.stripe.com/oauth/token'
const STRIPE_CONNECT_DEAUTHORIZE_URL = 'https://connect.stripe.com/oauth/deauthorize'
const STRIPE_WEBHOOK_EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.refunded',
  'refund.created',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted'
]
const isPostgresRuntime = Boolean(process.env.DATABASE_URL)
const DEFAULT_PAYMENT_TIMEZONE = 'America/Mexico_City'
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
const LOCKED_PLAN_PAYMENT_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'refunded', 'void', 'deleted', 'cancelled', 'canceled'])
const AUTOMATIC_PLAN_PAYMENT_METHODS = new Set(['', 'stripe_auto', 'stripe_saved_card', 'stripe_pending_card', 'stripe_scheduled_card', 'card', 'payment_link', 'direct_card', 'saved_card'])
const MANUAL_PLAN_PAYMENT_METHODS = new Set(['cash', 'bank_transfer', 'transfer', 'deposit', 'check', 'other', 'manual', 'offline'])
const TIMED_PLAN_FREQUENCY = 'scheduled_time'
const TIMED_PLAN_FREQUENCY_ALIASES = new Set([TIMED_PLAN_FREQUENCY, 'scheduled-time', 'scheduledat', 'scheduled_at', 'timed', 'datetime'])
const PLAN_FREQUENCIES = new Set(['custom', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly', TIMED_PLAN_FREQUENCY])
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf',
  'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'
])

let stripeFetchForTest = null
let stripeFactoryForTest = null

export function setStripeConnectFetchForTest(fetchImpl) {
  stripeFetchForTest = typeof fetchImpl === 'function' ? fetchImpl : null
}

export function setStripeFactoryForTest(factory) {
  stripeFactoryForTest = typeof factory === 'function' ? factory : null
}

function cleanString(value) {
  return String(value || '').trim()
}

function shouldSendStripeReceiptEmail(paymentSettings = {}) {
  if (paymentSettings.automations?.receiptDeliveryEnabled === false) return false
  const channel = cleanString(paymentSettings.automations?.receiptDeliveryChannel || 'email').toLowerCase()
  return channel === 'email' || channel === 'both'
}

function getEnvValue(names = []) {
  for (const name of names) {
    const value = cleanString(process.env[name])
    if (value) return value
  }
  return ''
}

function getModeEnvNames(mode, suffix) {
  const normalized = normalizeMode(mode)
  const upper = normalized.toUpperCase()
  return [
    `STRIPE_CONNECT_${upper}_${suffix}`,
    `STRIPE_CONNECT_${suffix}_${upper}`,
    `STRIPE_${upper}_CONNECT_${suffix}`,
    `STRIPE_${upper}_${suffix}`,
    ...(normalized === 'live'
      ? [`STRIPE_CONNECT_LIVE_${suffix}`, `STRIPE_LIVE_${suffix}`]
      : [`STRIPE_CONNECT_TEST_${suffix}`, `STRIPE_TEST_${suffix}`]),
    `STRIPE_CONNECT_${suffix}`,
    `STRIPE_${suffix}`
  ]
}

function normalizeConnectionType(value) {
  return value === 'connect' ? 'connect' : 'manual'
}

function getStripeInstance(secretKey) {
  return stripeFactoryForTest ? stripeFactoryForTest(secretKey) : new Stripe(secretKey)
}

function getStripeFetch() {
  return stripeFetchForTest || fetch
}

function getStripeConnectPlatformConfig(mode, requirements = {}) {
  const normalizedMode = normalizeMode(mode)
  const clientId = getEnvValue(getModeEnvNames(normalizedMode, 'CLIENT_ID'))
  const secretKey = getEnvValue(getModeEnvNames(normalizedMode, 'SECRET_KEY'))
  const publishableKey = getEnvValue(getModeEnvNames(normalizedMode, 'PUBLISHABLE_KEY'))
  const missing = []

  if (requirements.clientId && !clientId) missing.push(`STRIPE_CONNECT_${normalizedMode.toUpperCase()}_CLIENT_ID`)
  if (requirements.secretKey && !secretKey) missing.push(`STRIPE_CONNECT_${normalizedMode.toUpperCase()}_SECRET_KEY`)
  if (requirements.publishableKey && !publishableKey) missing.push(`STRIPE_CONNECT_${normalizedMode.toUpperCase()}_PUBLISHABLE_KEY`)

  if (missing.length) {
    const error = new Error(`Faltan variables de entorno de Stripe Connect: ${missing.join(', ')}.`)
    error.status = 400
    error.missing = missing
    throw error
  }

  return {
    mode: normalizedMode,
    clientId,
    secretKey,
    publishableKey,
    missing: [
      ...(!clientId ? [`STRIPE_CONNECT_${normalizedMode.toUpperCase()}_CLIENT_ID`] : []),
      ...(!secretKey ? [`STRIPE_CONNECT_${normalizedMode.toUpperCase()}_SECRET_KEY`] : []),
      ...(!publishableKey ? [`STRIPE_CONNECT_${normalizedMode.toUpperCase()}_PUBLISHABLE_KEY`] : [])
    ]
  }
}

function getStripeRequestOptions(config = {}) {
  if (config.connectionType !== 'connect' || !config.connectedAccountId) return undefined
  if (config.connectUsesAccessToken) return undefined
  return { stripeAccount: config.connectedAccountId }
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

export function isStripeConnectOAuthEnabled() {
  return normalizeBoolean(process.env.STRIPE_CONNECT_OAUTH_ENABLED, false)
}

function assertStripeConnectOAuthEnabled() {
  if (isStripeConnectOAuthEnabled()) return
  const error = new Error('Stripe OAuth no está disponible. Configura Stripe manualmente con tu Secret key.')
  error.status = 404
  throw error
}

function normalizeDateOnly(value) {
  if (!value) return new Date().toISOString().slice(0, 10)
  const text = String(value).trim()
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/)
  if (match) return match[1]

  const date = new Date(text)
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10)
  return new Date().toISOString().slice(0, 10)
}

function todayDateOnly() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_PAYMENT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date())
}

function isDueTodayOrPast(value) {
  return normalizeDateOnly(value) <= todayDateOnly()
}

function assertDateNotInPast(value, message) {
  const date = normalizeDateOnly(value)
  if (date < todayDateOnly()) {
    const error = new Error(message)
    error.status = 400
    throw error
  }
  return date
}

function normalizePlanFrequency(value, fallback = 'custom') {
  const normalized = cleanString(value || fallback).toLowerCase().replace(/[\s-]+/g, '_')
  if (TIMED_PLAN_FREQUENCY_ALIASES.has(normalized)) return TIMED_PLAN_FREQUENCY
  return PLAN_FREQUENCIES.has(normalized) ? normalized : fallback
}

function isTimedPlanFrequency(value) {
  return normalizePlanFrequency(value) === TIMED_PLAN_FREQUENCY
}

function assertPlanDueDateNotInPast(value, frequency, message) {
  if (!isTimedPlanFrequency(frequency)) return assertDateNotInPast(value, message)

  const date = new Date(cleanString(value))
  if (Number.isNaN(date.getTime())) {
    const error = new Error('La fecha y hora de cobro no es válida.')
    error.status = 400
    throw error
  }

  if (date.getTime() < Date.now() - 60_000) {
    const error = new Error(message)
    error.status = 400
    throw error
  }

  return date.toISOString()
}

function duePlanInstallmentCondition(alias = 'i') {
  const frequencySql = `LOWER(COALESCE(${alias}.frequency, 'custom'))`
  const timedFrequencySql = `${frequencySql} = '${TIMED_PLAN_FREQUENCY}'`
  const timedDueSql = `${timestampSql(`${alias}.due_date`)} <= ${timestampComparisonPlaceholder()}`
  const dateDueSql = `${dateOnlySql(`${alias}.due_date`)} <= ${dateOnlyPlaceholder()}`
  return `((${timedFrequencySql} AND ${timedDueSql}) OR (${frequencySql} <> '${TIMED_PLAN_FREQUENCY}' AND ${dateDueSql}))`
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
  return `${prefix}_${Date.now()}_${randomBytes(6).toString('hex')}`
}

function createPublicId() {
  return `pay_${randomBytes(18).toString('base64url')}`
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

function decryptSecret(value) {
  const clean = cleanString(value)
  if (!clean) return ''
  return isEncrypted(clean) ? decrypt(clean) : clean
}

async function getSecretConfig(key) {
  const value = await getAppConfig(key)
  return value ? decryptSecret(value) : ''
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
      webhookSecret: ''
    }
  }

  return {
    mode: normalizeMode(value.mode || mode),
    publishableKey: cleanString(value.publishableKey || value.publishable_key),
    secretKey: value.secretKey || value.secret_key ? decryptSecret(value.secretKey || value.secret_key) : '',
    webhookSecret: value.webhookSecret || value.webhook_secret ? decryptSecret(value.webhookSecret || value.webhook_secret) : '',
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
    updatedAt: hasAny ? new Date().toISOString() : ''
  }
}

function serializeManualModeConnection(connection = {}) {
  return {
    mode: normalizeMode(connection.mode),
    publishableKey: cleanString(connection.publishableKey),
    secretKey: encryptOptionalSecret(connection.secretKey),
    webhookSecret: encryptOptionalSecret(connection.webhookSecret),
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

function normalizeStoredConnectConnection(value = {}, mode = 'test') {
  if (!value || typeof value !== 'object') return null
  const normalizedMode = normalizeMode(value.mode || mode)
  const accountId = cleanString(value.accountId || value.account_id || value.connectedAccountId)
  if (!accountId) return null

  return {
    mode: normalizedMode,
    accountId,
    accountLabel: cleanString(value.accountLabel || value.account_label),
    scope: cleanString(value.scope || STRIPE_CONNECT_SCOPE),
    livemode: normalizeBoolean(value.livemode, normalizedMode === 'live'),
    tokenType: cleanString(value.tokenType || value.token_type || 'bearer'),
    accessToken: cleanString(value.accessToken || value.access_token),
    refreshToken: cleanString(value.refreshToken || value.refresh_token),
    publishableKey: cleanString(value.publishableKey || value.publishable_key),
    accountEmail: cleanString(value.accountEmail || value.account_email),
    chargesEnabled: normalizeBoolean(value.chargesEnabled ?? value.charges_enabled, false),
    payoutsEnabled: normalizeBoolean(value.payoutsEnabled ?? value.payouts_enabled, false),
    detailsSubmitted: normalizeBoolean(value.detailsSubmitted ?? value.details_submitted, false),
    webhookEndpointId: cleanString(value.webhookEndpointId || value.webhook_endpoint_id),
    webhookUrl: cleanString(value.webhookUrl || value.webhook_url),
    webhookStatus: cleanString(value.webhookStatus || value.webhook_status),
    webhookLastError: cleanString(value.webhookLastError || value.webhook_last_error),
    webhookSecret: cleanString(value.webhookSecret || value.webhook_secret),
    connectedAt: cleanString(value.connectedAt || value.connected_at),
    managedByPortal: normalizeBoolean(value.managedByPortal ?? value.managed_by_portal, false)
  }
}

function readConnectModeConnections(raw = {}) {
  const parsed = parseJson(raw[CONFIG_KEYS.connectModeConnections], {})
  return {
    test: normalizeStoredConnectConnection(parsed.test, 'test'),
    live: normalizeStoredConnectConnection(parsed.live, 'live')
  }
}

function legacyConnectConnectionFromRaw(raw = {}, mode = 'test') {
  const accountId = cleanString(raw[CONFIG_KEYS.connectAccountId])
  if (!accountId) return null

  const normalizedMode = normalizeMode(raw[CONFIG_KEYS.mode] || mode)
  return normalizeStoredConnectConnection({
    mode: normalizedMode,
    accountId,
    accountLabel: cleanString(raw[CONFIG_KEYS.accountLabel]),
    scope: cleanString(raw[CONFIG_KEYS.connectScope]),
    livemode: normalizeBoolean(raw[CONFIG_KEYS.connectLivemode], normalizedMode === 'live'),
    tokenType: cleanString(raw[CONFIG_KEYS.connectTokenType]),
    accessToken: cleanString(raw[CONFIG_KEYS.connectAccessToken]),
    refreshToken: cleanString(raw[CONFIG_KEYS.connectRefreshToken]),
    publishableKey: cleanString(raw[CONFIG_KEYS.connectPublishableKey] || raw[CONFIG_KEYS.publishableKey]),
    accountEmail: cleanString(raw[CONFIG_KEYS.connectAccountEmail]),
    chargesEnabled: normalizeBoolean(raw[CONFIG_KEYS.connectChargesEnabled], false),
    payoutsEnabled: normalizeBoolean(raw[CONFIG_KEYS.connectPayoutsEnabled], false),
    detailsSubmitted: normalizeBoolean(raw[CONFIG_KEYS.connectDetailsSubmitted], false),
    webhookEndpointId: cleanString(raw[CONFIG_KEYS.connectWebhookEndpointId]),
    webhookUrl: cleanString(raw[CONFIG_KEYS.connectWebhookUrl]),
    webhookStatus: cleanString(raw[CONFIG_KEYS.connectWebhookStatus]),
    webhookLastError: cleanString(raw[CONFIG_KEYS.connectWebhookLastError]),
    webhookSecret: cleanString(raw[CONFIG_KEYS.webhookSecret]),
    connectedAt: cleanString(raw[CONFIG_KEYS.connectConnectedAt]),
    managedByPortal: normalizeBoolean(raw[CONFIG_KEYS.connectManagedByPortal], false)
  }, normalizedMode)
}

function getConnectModeConnection(raw = {}, mode = 'test') {
  const normalizedMode = normalizeMode(mode)
  const connections = readConnectModeConnections(raw)
  if (connections[normalizedMode]) return connections[normalizedMode]

  const legacy = legacyConnectConnectionFromRaw(raw, normalizedMode)
  return legacy?.mode === normalizedMode ? legacy : null
}

function decryptStoredConnection(connection = null) {
  if (!connection) return null

  return {
    ...connection,
    accessToken: decryptSecret(connection.accessToken),
    refreshToken: decryptSecret(connection.refreshToken),
    webhookSecret: decryptSecret(connection.webhookSecret)
  }
}

function summarizeConnectModeConnection(raw = {}, mode = 'test') {
  const connection = getConnectModeConnection(raw, mode)
  const platform = getStripeConnectPlatformConfig(mode)
  const publishableKey = cleanString(connection?.publishableKey || platform.publishableKey)
  const hasToken = Boolean(connection?.accessToken)
  const connected = Boolean(connection?.accountId && publishableKey && (hasToken || platform.secretKey))

  return {
    connected,
    mode: normalizeMode(mode),
    accountId: connection?.accountId || '',
    accountPreview: connection?.accountId ? `${connection.accountId.slice(0, 8)}...${connection.accountId.slice(-4)}` : '',
    accountEmail: connection?.accountEmail || '',
    accountLabel: connection?.accountLabel || '',
    webhookStatus: connection?.webhookStatus || '',
    webhookUrl: connection?.webhookUrl || '',
    connectedAt: connection?.connectedAt || '',
    livemode: connection?.livemode ?? mode === 'live'
  }
}

async function saveConnectModeConnection(mode, connection) {
  const raw = await readRawConfig()
  const connections = readConnectModeConnections(raw)
  connections[normalizeMode(mode)] = normalizeStoredConnectConnection(connection, mode)

  await setAppConfig(CONFIG_KEYS.connectModeConnections, JSON.stringify({
    test: connections.test,
    live: connections.live
  }))
}

async function writeActiveConnectConnection(mode, connection) {
  const normalizedMode = normalizeMode(mode)
  const cleanConnection = normalizeStoredConnectConnection(connection, normalizedMode)
  if (!cleanConnection) {
    const error = new Error(`Stripe no está conectado en modo ${normalizedMode === 'live' ? 'en vivo' : 'prueba'}.`)
    error.status = 400
    throw error
  }

  await setAppConfig(CONFIG_KEYS.enabled, '1')
  await setAppConfig(CONFIG_KEYS.connectionType, 'connect')
  await setAppConfig(CONFIG_KEYS.mode, normalizedMode)
  await setAppConfig(CONFIG_KEYS.accountLabel, cleanConnection.accountLabel)
  await setAppConfig(CONFIG_KEYS.publishableKey, cleanConnection.publishableKey || getStripeConnectPlatformConfig(normalizedMode).publishableKey)
  await setAppConfig(CONFIG_KEYS.connectAccountId, cleanConnection.accountId)
  await setAppConfig(CONFIG_KEYS.connectScope, cleanConnection.scope)
  await setAppConfig(CONFIG_KEYS.connectLivemode, cleanConnection.livemode ? '1' : '0')
  await setAppConfig(CONFIG_KEYS.connectTokenType, cleanConnection.tokenType)
  await setAppConfig(CONFIG_KEYS.connectPublishableKey, cleanConnection.publishableKey)
  await setAppConfig(CONFIG_KEYS.connectAccountEmail, cleanConnection.accountEmail)
  await setAppConfig(CONFIG_KEYS.connectChargesEnabled, cleanConnection.chargesEnabled ? '1' : '0')
  await setAppConfig(CONFIG_KEYS.connectPayoutsEnabled, cleanConnection.payoutsEnabled ? '1' : '0')
  await setAppConfig(CONFIG_KEYS.connectDetailsSubmitted, cleanConnection.detailsSubmitted ? '1' : '0')
  await setAppConfig(CONFIG_KEYS.connectWebhookEndpointId, cleanConnection.webhookEndpointId)
  await setAppConfig(CONFIG_KEYS.connectWebhookUrl, cleanConnection.webhookUrl)
  await setAppConfig(CONFIG_KEYS.connectWebhookStatus, cleanConnection.webhookStatus)
  await setAppConfig(CONFIG_KEYS.connectWebhookLastError, cleanConnection.webhookLastError)
  await setAppConfig(CONFIG_KEYS.connectConnectedAt, cleanConnection.connectedAt || new Date().toISOString())
  await setAppConfig(CONFIG_KEYS.connectManagedByPortal, cleanConnection.managedByPortal ? '1' : '0')

  if (cleanConnection.accessToken) {
    await setAppConfig(CONFIG_KEYS.connectAccessToken, cleanConnection.accessToken)
  } else {
    await db.run('DELETE FROM app_config WHERE config_key = ?', [CONFIG_KEYS.connectAccessToken])
  }

  if (cleanConnection.refreshToken) {
    await setAppConfig(CONFIG_KEYS.connectRefreshToken, cleanConnection.refreshToken)
  } else {
    await db.run('DELETE FROM app_config WHERE config_key = ?', [CONFIG_KEYS.connectRefreshToken])
  }

  if (cleanConnection.webhookSecret) {
    await setAppConfig(CONFIG_KEYS.webhookSecret, cleanConnection.webhookSecret)
  } else {
    await db.run('DELETE FROM app_config WHERE config_key = ?', [CONFIG_KEYS.webhookSecret])
  }

  await db.run('DELETE FROM app_config WHERE config_key = ?', [CONFIG_KEYS.secretKey])
}

export async function getStripePaymentConfig({ includeSecrets = false, mode: modeOverride = '' } = {}) {
  const raw = await readRawConfig()
  const accountCurrency = await getConfiguredCurrency()
  const manualModeConnections = readManualModeConnections(raw)
  const preferredMode = modeOverride || await getPaymentGatewayMode()
  const mode = modeOverride
    ? normalizeMode(modeOverride)
    : normalizeMode(preferredMode)
  const stripeConnectOAuthEnabled = isStripeConnectOAuthEnabled()
  const storedConnectionType = normalizeConnectionType(raw[CONFIG_KEYS.connectionType])
  const legacyConnectDisabled = storedConnectionType === 'connect' && !stripeConnectOAuthEnabled
  const connectionType = stripeConnectOAuthEnabled ? storedConnectionType : 'manual'
  const selectedManualConnection = manualModeConnections[mode] || normalizeStoredManualConnection({}, mode)
  const selectedStoredConnection = stripeConnectOAuthEnabled && connectionType === 'connect'
    ? decryptStoredConnection(getConnectModeConnection(raw, mode))
    : null
  const legacyConnectMatchesMode = normalizeMode(raw[CONFIG_KEYS.mode]) === mode
  const managedByPortal = stripeConnectOAuthEnabled
    ? normalizeBoolean(selectedStoredConnection?.managedByPortal ?? (legacyConnectMatchesMode ? raw[CONFIG_KEYS.connectManagedByPortal] : undefined), false) || isLicenseEnforced()
    : false
  const platform = stripeConnectOAuthEnabled && connectionType === 'connect'
    ? getStripeConnectPlatformConfig(mode)
    : { mode, clientId: '', secretKey: '', publishableKey: '', missing: [] }
  const connectedAccountId = cleanString(selectedStoredConnection?.accountId || (legacyConnectMatchesMode ? raw[CONFIG_KEYS.connectAccountId] : ''))
  const connectAccessToken = cleanString(selectedStoredConnection?.accessToken)
    || (legacyConnectMatchesMode && raw[CONFIG_KEYS.connectAccessToken] ? decryptSecret(raw[CONFIG_KEYS.connectAccessToken]) : '')
  const connectRefreshToken = cleanString(selectedStoredConnection?.refreshToken)
    || (legacyConnectMatchesMode && raw[CONFIG_KEYS.connectRefreshToken] ? decryptSecret(raw[CONFIG_KEYS.connectRefreshToken]) : '')
  const publishableKey = connectionType === 'connect'
    ? cleanString(selectedStoredConnection?.publishableKey || (legacyConnectMatchesMode ? raw[CONFIG_KEYS.connectPublishableKey] || raw[CONFIG_KEYS.publishableKey] : '') || platform.publishableKey)
    : cleanString(selectedManualConnection.publishableKey)
  const secretKey = connectionType === 'manual'
    ? cleanString(selectedManualConnection.secretKey)
    : (legacyConnectMatchesMode && raw[CONFIG_KEYS.secretKey] ? decryptSecret(raw[CONFIG_KEYS.secretKey]) : '')
  const webhookSecret = cleanString(selectedStoredConnection?.webhookSecret)
    || (connectionType === 'manual'
      ? cleanString(selectedManualConnection.webhookSecret)
      : (legacyConnectMatchesMode && raw[CONFIG_KEYS.webhookSecret] ? decryptSecret(raw[CONFIG_KEYS.webhookSecret]) : ''))
  const enabled = normalizeBoolean(raw[CONFIG_KEYS.enabled], true)
  const connectReady = Boolean(
    stripeConnectOAuthEnabled &&
    connectedAccountId &&
    (connectAccessToken || platform.secretKey) &&
    publishableKey
  )
  const manualReady = Boolean(publishableKey && secretKey)
  const configured = Boolean(enabled && (connectionType === 'connect' ? connectReady : manualReady))
  const oauthReadyByMode = {
    test: stripeConnectOAuthEnabled && (managedByPortal || getStripeConnectPlatformConfig('test').missing.length === 0),
    live: stripeConnectOAuthEnabled && (managedByPortal || getStripeConnectPlatformConfig('live').missing.length === 0)
  }
  const connectUsesAccessToken = Boolean(connectionType === 'connect' && connectAccessToken)
  const connectUsesPlatformAccountHeader = Boolean(connectionType === 'connect' && !connectAccessToken && platform.secretKey && connectedAccountId)
  const configurationStatus = configured
    ? 'configured_manually'
    : legacyConnectDisabled || cleanString(raw[CONFIG_KEYS.disconnectedAt]) || cleanString(raw[CONFIG_KEYS.connectDisconnectedAt])
      ? 'disconnected'
      : 'not_configured'

  return {
    enabled,
    configured,
    connectionType,
    configurationStatus,
    stripeConnectOAuthEnabled,
    mode,
    defaultCurrency: accountCurrency,
    accountLabel: connectionType === 'connect'
      ? cleanString(selectedStoredConnection?.accountLabel || raw[CONFIG_KEYS.accountLabel])
      : cleanString(raw[CONFIG_KEYS.accountLabel] || 'Stripe'),
    publishableKey,
    hasSecretKey: connectionType === 'manual' ? Boolean(secretKey) : Boolean(connectAccessToken || platform.secretKey),
    secretKeyPreview: connectionType === 'manual' ? maskSecret(secretKey) : '',
    hasWebhookSecret: Boolean(webhookSecret),
    webhookSecretPreview: maskSecret(webhookSecret),
    manualModes: {
      test: summarizeManualModeConnection(manualModeConnections.test, includeSecrets),
      live: summarizeManualModeConnection(manualModeConnections.live, includeSecrets)
    },
    connectedAccountId: stripeConnectOAuthEnabled ? connectedAccountId : '',
    connectedAccountPreview: stripeConnectOAuthEnabled && connectedAccountId ? `${connectedAccountId.slice(0, 8)}...${connectedAccountId.slice(-4)}` : '',
    connectScope: stripeConnectOAuthEnabled ? cleanString(selectedStoredConnection?.scope || raw[CONFIG_KEYS.connectScope]) : '',
    connectLivemode: stripeConnectOAuthEnabled ? normalizeBoolean(selectedStoredConnection?.livemode ?? raw[CONFIG_KEYS.connectLivemode], mode === 'live') : false,
    connectReady,
    connectManagedByPortal: managedByPortal,
    connectUsesAccessToken,
    connectUsesPlatformAccountHeader,
    connectOauthReady: oauthReadyByMode[mode],
    connectOauthReadyByMode: oauthReadyByMode,
    connectMissingEnv: stripeConnectOAuthEnabled && !managedByPortal ? platform.missing : [],
    connectModes: stripeConnectOAuthEnabled
      ? {
          test: summarizeConnectModeConnection(raw, 'test'),
          live: summarizeConnectModeConnection(raw, 'live')
        }
      : undefined,
    connectAccountEmail: stripeConnectOAuthEnabled ? cleanString(selectedStoredConnection?.accountEmail || raw[CONFIG_KEYS.connectAccountEmail]) : '',
    connectChargesEnabled: stripeConnectOAuthEnabled ? normalizeBoolean(selectedStoredConnection?.chargesEnabled ?? raw[CONFIG_KEYS.connectChargesEnabled], false) : false,
    connectPayoutsEnabled: stripeConnectOAuthEnabled ? normalizeBoolean(selectedStoredConnection?.payoutsEnabled ?? raw[CONFIG_KEYS.connectPayoutsEnabled], false) : false,
    connectDetailsSubmitted: stripeConnectOAuthEnabled ? normalizeBoolean(selectedStoredConnection?.detailsSubmitted ?? raw[CONFIG_KEYS.connectDetailsSubmitted], false) : false,
    connectWebhookEndpointId: stripeConnectOAuthEnabled ? cleanString(selectedStoredConnection?.webhookEndpointId || raw[CONFIG_KEYS.connectWebhookEndpointId]) : '',
    connectWebhookUrl: stripeConnectOAuthEnabled ? cleanString(selectedStoredConnection?.webhookUrl || raw[CONFIG_KEYS.connectWebhookUrl]) : '',
    connectWebhookStatus: stripeConnectOAuthEnabled ? cleanString(selectedStoredConnection?.webhookStatus || raw[CONFIG_KEYS.connectWebhookStatus]) : '',
    connectWebhookLastError: stripeConnectOAuthEnabled ? cleanString(selectedStoredConnection?.webhookLastError || raw[CONFIG_KEYS.connectWebhookLastError]) : '',
    connectConnectedAt: stripeConnectOAuthEnabled ? cleanString(selectedStoredConnection?.connectedAt || raw[CONFIG_KEYS.connectConnectedAt]) : '',
    hasConnectAccessToken: stripeConnectOAuthEnabled ? Boolean(connectAccessToken) : false,
    hasConnectRefreshToken: stripeConnectOAuthEnabled ? Boolean(connectRefreshToken) : false,
    ...(includeSecrets
      ? {
          secretKey: connectionType === 'connect' && stripeConnectOAuthEnabled ? (connectAccessToken || platform.secretKey) : secretKey,
          webhookSecret,
          connectAccessToken: stripeConnectOAuthEnabled ? connectAccessToken : '',
          connectRefreshToken: stripeConnectOAuthEnabled ? connectRefreshToken : ''
        }
      : {})
  }
}

export async function saveStripePaymentConfig(input = {}) {
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
  const nextManualModes = {
    test: buildManualModeConnectionFromInput('test', manualInput.test, currentManualModes.test),
    live: buildManualModeConnectionFromInput('live', manualInput.live, currentManualModes.live)
  }
  const activeMode = chooseManualMode(nextManualModes, input.mode || 'live')
  const activeConnection = nextManualModes[activeMode]

  if (!activeConnection.publishableKey || !activeConnection.secretKey) {
    const error = new Error('Agrega al menos las llaves de prueba o las llaves en vivo de Stripe.')
    error.status = 400
    throw error
  }

  await setAppConfig(CONFIG_KEYS.enabled, normalizeBoolean(input.enabled, true) ? '1' : '0')
  await setAppConfig(CONFIG_KEYS.connectionType, 'manual')
  await setAppConfig(CONFIG_KEYS.mode, activeMode)
  await setAppConfig(CONFIG_KEYS.publishableKey, activeConnection.publishableKey)
  await setAppConfig(CONFIG_KEYS.defaultCurrency, accountCurrency)
  await setAppConfig(CONFIG_KEYS.accountLabel, cleanString(input.accountLabel || current.accountLabel || 'Stripe'))
  await setAppConfig(CONFIG_KEYS.manualModeConnections, JSON.stringify({
    test: serializeManualModeConnection(nextManualModes.test),
    live: serializeManualModeConnection(nextManualModes.live)
  }))
  await db.run('DELETE FROM app_config WHERE config_key IN (?, ?)', [CONFIG_KEYS.disconnectedAt, CONFIG_KEYS.connectDisconnectedAt])

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
  const current = await getStripePaymentConfig({ includeSecrets: true })
  if (current.connectionType === 'connect' && current.connectedAccountId) {
    if (current.connectManagedByPortal && isLicenseEnforced()) {
      await disconnectCentralStripeConnect().catch((error) => {
        logger.warn(`No se pudo revocar Stripe Connect central antes de borrar configuración: ${error.message}`)
      })
    } else {
      await disconnectStripeConnectAccount(current).catch((error) => {
        logger.warn(`No se pudo revocar Stripe Connect antes de borrar configuración: ${error.message}`)
      })
    }
  }

  const configKeys = Object.values(CONFIG_KEYS).filter((key) => key !== CONFIG_KEYS.connectOauthState)
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
    const detail = config.connectionType === 'connect'
      ? 'Conecta Stripe y verifica que el webhook automático quede listo.'
      : 'Guarda las llaves de Stripe primero.'
    const error = new Error(`Stripe no está configurado todavía. ${detail}`)
    error.status = 400
    throw error
  }

  return {
    config,
    stripe: getStripeInstance(config.secretKey),
    requestOptions: getStripeRequestOptions(config)
  }
}

export async function testStripePaymentConfig(input = null) {
  const current = await getStripePaymentConfig({ includeSecrets: true })
  if (!input && current.connectionType === 'connect') {
    const { stripe, config, requestOptions } = await getStripeClient()
    const balance = requestOptions
      ? await stripe.balance.retrieve({}, requestOptions)
      : await stripe.balance.retrieve()
    return {
      ok: true,
      mode: config.mode,
      connectionType: 'connect',
      connectedAccountId: config.connectedAccountId,
      livemode: Boolean(balance.livemode),
      available: Array.isArray(balance.available) ? balance.available.length : 0
    }
  }

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

function sanitizeStripeReturnPath(value) {
  const clean = cleanString(value)
  if (!clean || !clean.startsWith('/settings/payments/stripe')) return '/settings/payments/stripe'
  return clean.slice(0, 300)
}

function normalizeStripeAppBaseUrl(value) {
  const clean = cleanString(value).replace(/\/+$/, '')
  if (!clean) return ''

  const withProtocol = /^https?:\/\//i.test(clean) ? clean : `https://${clean}`
  try {
    const parsed = new URL(withProtocol)
    if (!['http:', 'https:'].includes(parsed.protocol)) return ''
    return parsed.origin
  } catch {
    return ''
  }
}

function buildStripeOAuthRedirectUri(baseUrl) {
  const cleanBaseUrl = cleanString(baseUrl).replace(/\/+$/, '')
  if (!cleanBaseUrl) {
    const error = new Error('No se pudo detectar la URL pública para regresar desde Stripe.')
    error.status = 400
    throw error
  }
  return `${cleanBaseUrl}/api/stripe/connect/callback`
}

async function callStripeOAuthEndpoint(url, secretKey, params) {
  const body = new URLSearchParams(params)
  const response = await getStripeFetch()(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data?.error_description || data?.error || 'Stripe no pudo completar la conexión.')
    error.status = response.status || 400
    throw error
  }
  return data
}

async function readStripeOAuthState() {
  return parseJson(await getAppConfig(CONFIG_KEYS.connectOauthState), null)
}

function mapStripeAccountForConfig(account = {}) {
  const businessName = cleanString(account.business_profile?.name)
  const dashboardName = cleanString(account.settings?.dashboard?.display_name)
  const email = cleanString(account.email)
  const label = businessName || dashboardName || email || cleanString(account.id) || 'Stripe Connect'

  return {
    label,
    email,
    chargesEnabled: normalizeBoolean(account.charges_enabled, false),
    payoutsEnabled: normalizeBoolean(account.payouts_enabled, false),
    detailsSubmitted: normalizeBoolean(account.details_submitted, false)
  }
}

async function ensureStripeConnectWebhookEndpoint({
  stripe,
  connectedAccountId,
  webhookUrl,
  currentEndpointId = '',
  currentSecret = '',
  listenToConnectedAccountEvents = false
}) {
  const cleanUrl = cleanString(webhookUrl)
  if (!cleanUrl) return { status: 'missing_url', endpointId: '', webhookUrl: '', webhookSecret: currentSecret, error: 'No se detectó URL pública.' }

  try {
    const endpointPayload = {
      enabled_events: STRIPE_WEBHOOK_EVENTS,
      description: 'Ristak payments webhook',
      metadata: {
        ristak_integration: 'stripe_connect',
        stripe_account_id: connectedAccountId
      }
    }
    const connectPayload = listenToConnectedAccountEvents ? { connect: true } : {}

    if (currentEndpointId) {
      try {
        const endpoint = await stripe.webhookEndpoints.update(
          currentEndpointId,
          {
            url: cleanUrl,
            ...endpointPayload,
            ...connectPayload,
            disabled: false
          }
        )
        return {
          status: currentSecret ? 'active' : 'needs_secret',
          endpointId: endpoint.id,
          webhookUrl: endpoint.url,
          webhookSecret: currentSecret,
          error: currentSecret ? '' : 'Stripe no vuelve a mostrar el signing secret de endpoints existentes.'
        }
      } catch (error) {
        logger.warn(`No se pudo actualizar webhook Stripe Connect ${currentEndpointId}; se creará uno nuevo: ${error.message}`)
      }
    }

    const created = await stripe.webhookEndpoints.create(
      {
        url: cleanUrl,
        ...endpointPayload,
        ...connectPayload
      }
    )

    return {
      status: created.secret ? 'active' : 'needs_secret',
      endpointId: created.id,
      webhookUrl: created.url,
      webhookSecret: created.secret || currentSecret,
      error: created.secret ? '' : 'Stripe creó el endpoint, pero no devolvió signing secret.'
    }
  } catch (error) {
    return {
      status: 'failed',
      endpointId: currentEndpointId,
      webhookUrl: cleanUrl,
      webhookSecret: currentSecret,
      error: error.message || 'No se pudo crear el webhook automático.'
    }
  }
}

async function saveStripeConnectConnection({
  mode,
  oauthData,
  account,
  webhook
}) {
  const normalizedMode = normalizeMode(mode)
  const accountCurrency = await getConfiguredCurrency()
  const accountDetails = mapStripeAccountForConfig(account)
  const connectedAccountId = cleanString(oauthData.stripe_user_id)
  const scope = cleanString(oauthData.scope || STRIPE_CONNECT_SCOPE)
  const livemode = normalizeBoolean(oauthData.livemode, normalizedMode === 'live')
  const connectPublishableKey = cleanString(oauthData.stripe_publishable_key)

  await setAppConfig(CONFIG_KEYS.enabled, '1')
  await setAppConfig(CONFIG_KEYS.connectionType, 'connect')
  await setAppConfig(CONFIG_KEYS.mode, livemode ? 'live' : 'test')
  await setAppConfig(CONFIG_KEYS.defaultCurrency, accountCurrency)
  await setAppConfig(CONFIG_KEYS.accountLabel, accountDetails.label)
  await setAppConfig(CONFIG_KEYS.publishableKey, connectPublishableKey || getStripeConnectPlatformConfig(livemode ? 'live' : 'test').publishableKey)
  await setAppConfig(CONFIG_KEYS.connectAccountId, connectedAccountId)
  await setAppConfig(CONFIG_KEYS.connectScope, scope)
  await setAppConfig(CONFIG_KEYS.connectLivemode, livemode ? '1' : '0')
  await setAppConfig(CONFIG_KEYS.connectTokenType, cleanString(oauthData.token_type || 'bearer'))
  await setAppConfig(CONFIG_KEYS.connectPublishableKey, connectPublishableKey)
  await setAppConfig(CONFIG_KEYS.connectAccountEmail, accountDetails.email)
  await setAppConfig(CONFIG_KEYS.connectChargesEnabled, accountDetails.chargesEnabled ? '1' : '0')
  await setAppConfig(CONFIG_KEYS.connectPayoutsEnabled, accountDetails.payoutsEnabled ? '1' : '0')
  await setAppConfig(CONFIG_KEYS.connectDetailsSubmitted, accountDetails.detailsSubmitted ? '1' : '0')
  await setAppConfig(CONFIG_KEYS.connectWebhookEndpointId, cleanString(webhook.endpointId))
  await setAppConfig(CONFIG_KEYS.connectWebhookUrl, cleanString(webhook.webhookUrl))
  await setAppConfig(CONFIG_KEYS.connectWebhookStatus, cleanString(webhook.status))
  await setAppConfig(CONFIG_KEYS.connectWebhookLastError, cleanString(webhook.error))
  await setAppConfig(CONFIG_KEYS.connectConnectedAt, new Date().toISOString())
  await setAppConfig(CONFIG_KEYS.connectManagedByPortal, '0')

  const encryptedAccessToken = oauthData.access_token ? encryptOptionalSecret(oauthData.access_token) : ''
  const encryptedRefreshToken = oauthData.refresh_token ? encryptOptionalSecret(oauthData.refresh_token) : ''
  const encryptedWebhookSecret = webhook.webhookSecret ? encrypt(webhook.webhookSecret) : ''

  if (oauthData.access_token) {
    await setAppConfig(CONFIG_KEYS.connectAccessToken, encryptedAccessToken)
  }
  if (oauthData.refresh_token) {
    await setAppConfig(CONFIG_KEYS.connectRefreshToken, encryptedRefreshToken)
  }
  if (webhook.webhookSecret) {
    await setAppConfig(CONFIG_KEYS.webhookSecret, encryptedWebhookSecret)
  }

  await saveConnectModeConnection(livemode ? 'live' : 'test', {
    mode: livemode ? 'live' : 'test',
    accountId: connectedAccountId,
    accountLabel: accountDetails.label,
    scope,
    livemode,
    tokenType: cleanString(oauthData.token_type || 'bearer'),
    accessToken: encryptedAccessToken,
    refreshToken: encryptedRefreshToken,
    publishableKey: connectPublishableKey || getStripeConnectPlatformConfig(livemode ? 'live' : 'test').publishableKey,
    accountEmail: accountDetails.email,
    chargesEnabled: accountDetails.chargesEnabled,
    payoutsEnabled: accountDetails.payoutsEnabled,
    detailsSubmitted: accountDetails.detailsSubmitted,
    webhookEndpointId: cleanString(webhook.endpointId),
    webhookUrl: cleanString(webhook.webhookUrl),
    webhookStatus: cleanString(webhook.status),
    webhookLastError: cleanString(webhook.error),
    webhookSecret: encryptedWebhookSecret,
    connectedAt: new Date().toISOString(),
    managedByPortal: false
  })

  await db.run('DELETE FROM app_config WHERE config_key = ?', [CONFIG_KEYS.secretKey])
  await db.run('DELETE FROM app_config WHERE config_key = ?', [CONFIG_KEYS.connectDisconnectedAt])
  await db.run('DELETE FROM app_config WHERE config_key = ?', [CONFIG_KEYS.connectOauthState])

  return getStripePaymentConfig({ mode: livemode ? 'live' : 'test' })
}

export async function createStripeConnectOAuthUrl({ mode = 'test', baseUrl = '', appUrl = '', returnPath = '/settings/payments/stripe' } = {}) {
  assertStripeConnectOAuthEnabled()
  const normalizedMode = normalizeMode(mode)
  const installedAppUrl = normalizeStripeAppBaseUrl(appUrl) || normalizeStripeAppBaseUrl(baseUrl)
  if (isLicenseEnforced()) {
    return createCentralStripeConnectUrl({
      mode: normalizedMode,
      returnPath: sanitizeStripeReturnPath(returnPath),
      appUrl: installedAppUrl
    })
  }

  const platform = getStripeConnectPlatformConfig(normalizedMode, {
    clientId: true,
    secretKey: true,
    publishableKey: true
  })
  const redirectUri = buildStripeOAuthRedirectUri(installedAppUrl || baseUrl)
  const state = `st_${randomBytes(24).toString('base64url')}`
  const payload = {
    state,
    mode: normalizedMode,
    returnPath: sanitizeStripeReturnPath(returnPath),
    redirectUri,
    createdAt: new Date().toISOString()
  }

  await setAppConfig(CONFIG_KEYS.connectOauthState, JSON.stringify(payload))

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: platform.clientId,
    scope: STRIPE_CONNECT_SCOPE,
    state,
    redirect_uri: redirectUri,
    'stripe_user[currency]': (await getConfiguredCurrency()).toLowerCase()
  })

  return {
    url: `${STRIPE_CONNECT_AUTHORIZE_URL}?${params.toString()}`,
    mode: normalizedMode,
    redirectUri,
    scope: STRIPE_CONNECT_SCOPE
  }
}

export async function syncStripeConnectFromCentral({ handoffToken = '' } = {}) {
  assertStripeConnectOAuthEnabled()
  if (!isLicenseEnforced()) {
    const error = new Error('Esta instalación no está conectada al portal central.')
    error.status = 400
    throw error
  }

  if (!cleanString(handoffToken)) {
    const error = new Error('Falta el handoff de Stripe. Intenta conectar otra vez desde el botón de Stripe.')
    error.status = 400
    throw error
  }

  const handoff = await claimCentralOAuthHandoff({
    provider: 'stripe_connect',
    handoffToken
  })
  const connection = handoff?.payload?.connection || {}
  if (!connection?.connected || !connection.account_id || !connection.access_token) {
    const error = new Error('Stripe todavía no quedó conectado en el Installer. Intenta conectar otra vez.')
    error.status = 409
    throw error
  }

  const mode = connection.mode === 'live' || connection.livemode ? 'live' : 'test'
  const accountLabel = cleanString(connection.account_label)
    || cleanString(connection.account_email)
    || cleanString(connection.account_id)
    || 'Stripe Connect'

  await setAppConfig(CONFIG_KEYS.enabled, '1')
  await setAppConfig(CONFIG_KEYS.connectionType, 'connect')
  await setAppConfig(CONFIG_KEYS.mode, mode)
  await setAppConfig(CONFIG_KEYS.defaultCurrency, await getConfiguredCurrency())
  await setAppConfig(CONFIG_KEYS.accountLabel, accountLabel)
  await setAppConfig(CONFIG_KEYS.publishableKey, assertStripePublishableKey(connection.publishable_key || ''))
  await setAppConfig(CONFIG_KEYS.connectAccountId, cleanString(connection.account_id))
  await setAppConfig(CONFIG_KEYS.connectScope, cleanString(connection.scope || STRIPE_CONNECT_SCOPE))
  await setAppConfig(CONFIG_KEYS.connectLivemode, connection.livemode ? '1' : '0')
  await setAppConfig(CONFIG_KEYS.connectTokenType, cleanString(connection.token_type || 'bearer'))
  await setAppConfig(CONFIG_KEYS.connectPublishableKey, cleanString(connection.publishable_key))
  await setAppConfig(CONFIG_KEYS.connectAccountEmail, cleanString(connection.account_email))
  await setAppConfig(CONFIG_KEYS.connectChargesEnabled, connection.charges_enabled ? '1' : '0')
  await setAppConfig(CONFIG_KEYS.connectPayoutsEnabled, connection.payouts_enabled ? '1' : '0')
  await setAppConfig(CONFIG_KEYS.connectDetailsSubmitted, connection.details_submitted ? '1' : '0')
  await setAppConfig(CONFIG_KEYS.connectWebhookEndpointId, cleanString(connection.webhook_endpoint_id))
  await setAppConfig(CONFIG_KEYS.connectWebhookUrl, cleanString(connection.webhook_url))
  await setAppConfig(CONFIG_KEYS.connectWebhookStatus, cleanString(connection.webhook_status))
  await setAppConfig(CONFIG_KEYS.connectWebhookLastError, cleanString(connection.webhook_last_error))
  await setAppConfig(CONFIG_KEYS.connectConnectedAt, cleanString(connection.connected_at) || new Date().toISOString())
  await setAppConfig(CONFIG_KEYS.connectManagedByPortal, '1')
  const encryptedAccessToken = encryptOptionalSecret(connection.access_token)
  const encryptedRefreshToken = connection.refresh_token ? encryptOptionalSecret(connection.refresh_token) : ''
  const encryptedWebhookSecret = connection.webhook_secret ? encrypt(connection.webhook_secret) : ''

  await setAppConfig(CONFIG_KEYS.connectAccessToken, encryptedAccessToken)

  if (connection.refresh_token) {
    await setAppConfig(CONFIG_KEYS.connectRefreshToken, encryptedRefreshToken)
  }
  if (connection.webhook_secret) {
    await setAppConfig(CONFIG_KEYS.webhookSecret, encryptedWebhookSecret)
  }

  await saveConnectModeConnection(mode, {
    mode,
    accountId: cleanString(connection.account_id),
    accountLabel,
    scope: cleanString(connection.scope || STRIPE_CONNECT_SCOPE),
    livemode: connection.livemode ? true : mode === 'live',
    tokenType: cleanString(connection.token_type || 'bearer'),
    accessToken: encryptedAccessToken,
    refreshToken: encryptedRefreshToken,
    publishableKey: cleanString(connection.publishable_key),
    accountEmail: cleanString(connection.account_email),
    chargesEnabled: Boolean(connection.charges_enabled),
    payoutsEnabled: Boolean(connection.payouts_enabled),
    detailsSubmitted: Boolean(connection.details_submitted),
    webhookEndpointId: cleanString(connection.webhook_endpoint_id),
    webhookUrl: cleanString(connection.webhook_url),
    webhookStatus: cleanString(connection.webhook_status),
    webhookLastError: cleanString(connection.webhook_last_error),
    webhookSecret: encryptedWebhookSecret,
    connectedAt: cleanString(connection.connected_at) || new Date().toISOString(),
    managedByPortal: true
  })

  await db.run('DELETE FROM app_config WHERE config_key IN (?, ?)', [CONFIG_KEYS.secretKey, CONFIG_KEYS.connectOauthState])
  return getStripePaymentConfig({ mode })
}

export async function setStripeConnectActiveMode(mode = 'live') {
  assertStripeConnectOAuthEnabled()
  const normalizedMode = normalizeMode(mode)
  const raw = await readRawConfig()
  const connectionType = normalizeConnectionType(raw[CONFIG_KEYS.connectionType])
  if (connectionType !== 'connect') {
    const error = new Error('Stripe Connect no está activo todavía.')
    error.status = 400
    throw error
  }

  const connection = getConnectModeConnection(raw, normalizedMode)
  if (!connection) {
    const error = new Error(`Conecta Stripe en modo ${normalizedMode === 'live' ? 'en vivo' : 'prueba'} antes de cambiar el switch.`)
    error.status = 400
    throw error
  }

  const platform = getStripeConnectPlatformConfig(normalizedMode)
  if (!cleanString(connection.publishableKey || platform.publishableKey) || (!connection.accessToken && !platform.secretKey)) {
    const error = new Error(`La conexión de Stripe en modo ${normalizedMode === 'live' ? 'en vivo' : 'prueba'} está incompleta.`)
    error.status = 400
    throw error
  }

  await writeActiveConnectConnection(normalizedMode, connection)
  await savePaymentSettings({ paymentMode: normalizedMode })
  return getStripePaymentConfig({ mode: normalizedMode })
}

export async function completeStripeConnectOAuth({ code = '', state = '', baseUrl = '' } = {}) {
  assertStripeConnectOAuthEnabled()
  const cleanCode = cleanString(code)
  const cleanState = cleanString(state)
  const savedState = await readStripeOAuthState()
  if (!cleanCode) {
    const error = new Error('Stripe no regresó un código de autorización.')
    error.status = 400
    throw error
  }
  if (!savedState?.state || savedState.state !== cleanState) {
    const error = new Error('La sesión de conexión con Stripe expiró o no coincide.')
    error.status = 400
    throw error
  }

  const createdAt = new Date(savedState.createdAt || 0).getTime()
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > 15 * 60 * 1000) {
    await db.run('DELETE FROM app_config WHERE config_key = ?', [CONFIG_KEYS.connectOauthState])
    const error = new Error('La sesión de conexión con Stripe expiró. Intenta conectar de nuevo.')
    error.status = 400
    throw error
  }

  const requestedMode = normalizeMode(savedState.mode)
  const platform = getStripeConnectPlatformConfig(requestedMode, {
    secretKey: true,
    publishableKey: true
  })
  const oauthData = await callStripeOAuthEndpoint(STRIPE_CONNECT_TOKEN_URL, platform.secretKey, {
    grant_type: 'authorization_code',
    code: cleanCode
  })
  const connectedAccountId = cleanString(oauthData.stripe_user_id)
  if (!connectedAccountId) {
    const error = new Error('Stripe no regresó la cuenta conectada.')
    error.status = 400
    throw error
  }

  const finalMode = normalizeBoolean(oauthData.livemode, requestedMode === 'live') ? 'live' : 'test'
  const finalPlatform = finalMode === requestedMode
    ? platform
    : getStripeConnectPlatformConfig(finalMode, { secretKey: true, publishableKey: true })
  const stripe = getStripeInstance(finalPlatform.secretKey)
  const account = await stripe.accounts.retrieve(connectedAccountId)
  const raw = await readRawConfig()
  const currentModeConnection = decryptStoredConnection(getConnectModeConnection(raw, finalMode))
  const webhookUrl = `${cleanString(baseUrl || savedState.redirectUri).replace(/\/api\/stripe\/connect\/callback$/, '').replace(/\/+$/, '')}/api/stripe/webhook`
  const oauthAccessToken = cleanString(oauthData.access_token)
  const webhookStripe = oauthAccessToken ? getStripeInstance(oauthAccessToken) : stripe
  const webhook = await ensureStripeConnectWebhookEndpoint({
    stripe: webhookStripe,
    connectedAccountId,
    webhookUrl,
    currentEndpointId: currentModeConnection?.webhookEndpointId || '',
    currentSecret: currentModeConnection?.webhookSecret || '',
    listenToConnectedAccountEvents: !oauthAccessToken
  })

  const config = await saveStripeConnectConnection({
    mode: finalMode,
    oauthData,
    account,
    webhook
  })

  return {
    config,
    returnPath: savedState.returnPath || '/settings/payments/stripe',
    webhook
  }
}

async function disconnectStripeConnectAccount(config = {}) {
  const mode = normalizeMode(config.mode)
  const platform = getStripeConnectPlatformConfig(mode, {
    clientId: true,
    secretKey: true
  })
  const stripe = getStripeInstance(platform.secretKey)
  if (config.connectWebhookEndpointId && config.connectedAccountId) {
    await stripe.webhookEndpoints.del(config.connectWebhookEndpointId).catch((error) => {
      logger.warn(`No se pudo borrar webhook Stripe Connect ${config.connectWebhookEndpointId}: ${error.message}`)
    })
  }

  await callStripeOAuthEndpoint(STRIPE_CONNECT_DEAUTHORIZE_URL, platform.secretKey, {
    client_id: platform.clientId,
    stripe_user_id: config.connectedAccountId
  })
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

function mapPublicPayment(row, config, baseUrl = '', settings = null, paymentPlan = null) {
  if (!row) return null
  const metadata = parseJson(row.metadata_json, {})
  const tax = metadata.tax && typeof metadata.tax === 'object' ? metadata.tax : null
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
    stripeAccountId: config?.connectUsesPlatformAccountHeader ? config.connectedAccountId || '' : '',
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

export async function createStripePaymentLink(input = {}, { baseUrl } = {}) {
  const { stripe, config, requestOptions } = await getStripeClient()
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

export async function getPublicStripePayment(publicPaymentId, { baseUrl, sync = false } = {}) {
  let row = await findPaymentByPublicId(publicPaymentId)
  if (!row || row.payment_provider !== 'stripe') return null
  const config = await getStripePaymentConfig({ mode: row.payment_mode || '' })

  if (sync && row.stripe_payment_intent_id && !['paid', 'refunded', 'void', 'deleted'].includes(row.status)) {
    await refreshStripePaymentFromIntent(row.stripe_payment_intent_id, row.payment_mode || '')
    row = await findPaymentByPublicId(publicPaymentId)
  }

  const paymentSettings = await getPublicPaymentSettings()
  const paymentPlan = await buildPublicPaymentPlanSummary(row)
  return attachMetaPublicPurchaseEvent(
    mapPublicPayment(row, config, baseUrl, paymentSettings, paymentPlan),
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

  if (row.stripe_payment_intent_id) {
    const existing = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id, requestOptions)
    if (['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing'].includes(existing.status)) {
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
              payment_method_authorization: 'public_invoice_payment'
            }
          },
          requestOptions
        )
        return {
          clientSecret: updated.client_secret,
          publishableKey: config.publishableKey,
          stripeAccountId: config.connectUsesPlatformAccountHeader ? config.connectedAccountId : '',
          status: updated.status
        }
      }

      return {
        clientSecret: existing.client_secret,
        publishableKey: config.publishableKey,
        stripeAccountId: config.connectUsesPlatformAccountHeader ? config.connectedAccountId : '',
        status: existing.status
      }
    }
  }

  const currency = normalizeCurrency(row.currency || config.defaultCurrency)
  const rowMetadata = parseJson(row.metadata_json, {})
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
    payment_method_authorization: savePaymentMethod && stripeCustomerId ? 'public_invoice_payment' : '',
    ...(paymentPlanMetadata?.flowId ? { ristak_flow_id: cleanString(paymentPlanMetadata.flowId) } : {}),
    ...(paymentPlanMetadata?.installmentId ? { ristak_installment_id: cleanString(paymentPlanMetadata.installmentId) } : {}),
    ...(paymentPlanMetadata?.trigger ? { ristak_plan_trigger: cleanString(paymentPlanMetadata.trigger) } : {})
  }

  // (PAY-009) Llave idempotente determinista para el create del PaymentIntent público.
  // Sin ella, un doble-submit del formulario (o un reintento de red) crea DOS intents
  // huérfanos antes de que se persista el id. La llave incluye monto+moneda+bucket-diario:
  // un reintento del mismo día reutiliza el mismo intent; si cambia el monto (admin edita
  // la factura) o pasa el día (expira el cache 24h de Stripe), se crea uno nuevo limpio.
  const createIntentDayBucket = new Date().toISOString().slice(0, 10)
  const createIntentIdempotencyKey =
    `ristak:${row.id}:create-intent:${toStripeAmount(row.amount, currency)}:${currency}:${createIntentDayBucket}`

  const intent = await stripe.paymentIntents.create(
    {
      amount: toStripeAmount(row.amount, currency),
      currency: currency.toLowerCase(),
      automatic_payment_methods: { enabled: true },
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
    clientSecret: intent.client_secret,
    publishableKey: config.publishableKey,
    stripeAccountId: config.connectUsesPlatformAccountHeader ? config.connectedAccountId : '',
    status: intent.status
  }
}

async function updatePaymentFromIntent(intent, stripeContext = null) {
  const paymentId = cleanString(intent?.metadata?.ristak_payment_id)
  const publicPaymentId = cleanString(intent?.metadata?.public_payment_id)
  const whereColumn = paymentId ? 'id' : 'public_payment_id'
  const whereValue = paymentId || publicPaymentId
  if (!whereValue) return null

  const currency = normalizeCurrency(intent.currency)
  const amount = fromStripeAmount(intent.amount_received || intent.amount, currency)
  const statusMap = {
    succeeded: 'paid',
    processing: 'pending',
    requires_payment_method: 'failed',
    requires_action: 'pending',
    canceled: 'void'
  }
  const nextStatus = statusMap[intent.status] || 'pending'
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
      nextStatus,
      intent.id,
      intent.id,
      latestChargeId,
      paidAt,
      paidAt,
      whereValue
    ]
  )

  const row = await db.get(
    `SELECT p.*, c.stripe_customer_id
     FROM payments p
     LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE p.${whereColumn} = ?`,
    [whereValue]
  )
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
    } catch (error) {
      logger.warn(`No se pudo guardar la tarjeta Stripe del pago ${whereValue}: ${error.message}`)
    }
  } else if (row?.contact_id) {
    try {
      const context = stripeContext || await getStripeClient()
      await syncStripePlanFromPayment(
        { ...row, status: nextStatus, stripe_payment_intent_id: intent.id },
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
  }

  return nextStatus
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

  const row = await db.get(`SELECT * FROM payments WHERE ${whereColumn} = ?`, [whereValue])
  if (row?.contact_id && nextStatus === 'paid') {
    updateSingleContactStats(row.contact_id).catch((error) => {
      logger.warn(`No se pudieron actualizar stats del contacto por invoice Stripe ${whereValue}: ${error.message}`)
    })
  }

  if (row?.contact_id && nextStatus === 'paid') {
    queuePaymentAutomationMessage('receipt', { ...row, status: nextStatus, stripe_payment_intent_id: paymentIntentId || row.stripe_payment_intent_id })
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
      provider === 'stripe' ? metadata?.stripeMode || 'test' : 'live',
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
  const chargeAttemptToken = new Date().toISOString().slice(0, 10)

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

function validateStripePaymentPlanPayload(input = {}) {
  const contact = input.contact || {}
  const totalAmount = Number(input.totalAmount || input.amount)
  const currency = normalizeCurrency(input.currency || DEFAULT_CURRENCY)
  const firstPayment = input.firstPayment || {}
  const firstPaymentEnabled = normalizeBoolean(firstPayment.enabled, true)
  const firstPaymentAmount = firstPaymentEnabled ? Number(firstPayment.amount || 0) : 0
  const firstPaymentMethod = firstPaymentEnabled ? cleanString(firstPayment.method || 'card') : 'none'
  const firstPaymentDate = firstPaymentEnabled ? normalizeDateOnly(firstPayment.date) : null
  const remainingPayments = Array.isArray(input.remainingPayments) ? input.remainingPayments : []
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
    const dueDate = assertPlanDueDateNotInPast(payment.dueDate, frequency, 'Los pagos futuros automáticos no pueden programarse en fechas pasadas.')

    return {
      sequence: Number(payment.sequence || index + 1),
      amount: Math.round(amount * 100) / 100,
      percentage: payment.percentage ?? null,
      dueDate,
      frequency
    }
  })

  if (firstPaymentEnabled && !MANUAL_PLAN_PAYMENT_METHODS.has(firstPaymentMethod)) {
    assertDateNotInPast(firstPaymentDate, 'El primer pago automático no puede programarse en una fecha pasada.')
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
    remainingFrequency: normalizePlanFrequency(input.remainingFrequency || 'custom'),
    cardSetupAmount,
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
  const hasSavedCard = Boolean(cleanString(flow.stripe_payment_method_id))
  const nextConcept = cleanString(input.name || input.title || input.description || input.concept || flow.concept || 'Plan de pagos')
  const nextFrequency = normalizePlanFrequency(input.remainingFrequency || input.frequency || metadata.remainingFrequency || 'custom')
  const submittedInstallments = Array.isArray(input.installments)
    ? input.installments
    : Array.isArray(input.remainingPayments)
      ? input.remainingPayments
      : []

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
      'Las parcialidades automáticas no pueden programarse en fechas pasadas.'
    )
    if (!dueDate) {
      const error = new Error('Cada parcialidad futura necesita fecha de cobro.')
      error.status = 400
      throw error
    }

    const method = normalizePlanEditablePaymentMethod(submitted.paymentMethod || submitted.method, hasSavedCard)
    if (method.automatic && !isTimedPlanFrequency(nextFrequency)) {
      assertDateNotInPast(dueDate, 'Las parcialidades automáticas no pueden programarse en fechas pasadas.')
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
    const title = `${nextConcept} - pago ${nextSequence}`
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

  const hasFirstPaymentInput = Object.prototype.hasOwnProperty.call(input, 'firstPayment')
  const firstPayment = hasFirstPaymentInput && input.firstPayment && typeof input.firstPayment === 'object' ? input.firstPayment : null
  let firstPaymentAmount = Number(flow.first_payment_amount || 0)
  let firstPaymentDate = flow.first_payment_date || null
  let firstPaymentMethod = flow.first_payment_method || null
  const firstPaymentStatus = cleanString(flow.first_payment_status).toLowerCase()
  const firstPaymentLocked = LOCKED_PLAN_PAYMENT_STATUSES.has(firstPaymentStatus) || ['registered', 'paid'].includes(firstPaymentStatus)

  if (hasFirstPaymentInput && !firstPaymentLocked) {
    const firstPaymentInputAmount = firstPayment
      ? normalizePlanEditableAmount(firstPayment.amount, 'monto del primer pago')
      : 0
    const shouldRemoveFirstPayment = !firstPayment || firstPayment.remove === true || firstPaymentInputAmount <= 0

    if (shouldRemoveFirstPayment) {
      firstPaymentAmount = 0
      firstPaymentDate = null
      firstPaymentMethod = null

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
      firstPaymentDate = normalizeDateOnly(firstPayment.dueDate || firstPayment.date || firstPaymentDate)
      const firstPaymentMethodInput = cleanString(firstPayment.method || firstPayment.paymentMethod || firstPaymentMethod || 'stripe_auto').toLowerCase()
      const normalizedFirstPaymentMethod = normalizePlanEditableFirstPaymentMethod(
        firstPaymentMethodInput,
        hasSavedCard
      )
      if (AUTOMATIC_PLAN_PAYMENT_METHODS.has(firstPaymentMethodInput)) {
        assertDateNotInPast(firstPaymentDate, 'El primer pago automático no puede programarse en una fecha pasada.')
      }

      firstPaymentMethod = normalizedFirstPaymentMethod.flowMethod
      const nextFirstPaymentStatus = firstPaymentStatus && firstPaymentStatus !== 'not_required'
        ? firstPaymentStatus
        : normalizedFirstPaymentMethod.flowStatus
      let firstPaymentPaymentId = flow.first_payment_invoice_id || null

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
          title: `${nextConcept} - primer pago`,
          description: `${nextConcept} - primer pago`,
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
    dueDate: todayDateOnly(),
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
  const plan = validateStripePaymentPlanPayload({ ...input, currency: accountCurrency })
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
      plan.firstPayment.enabled ? (hasSavedCard && firstPaymentIsCard && isDueTodayOrPast(plan.firstPayment.date) ? 'processing' : 'pending') : 'not_required',
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

  if (plan.firstPayment.enabled && firstPaymentIsOffline) {
    const paymentId = await createStripePlanPaymentRow({
      contact: plan.contact,
      amount: plan.firstPayment.amount,
      currency: plan.currency,
      status: 'paid',
      paymentMethod: plan.firstPayment.method,
      provider: 'manual',
      title: `${plan.title} - primer pago`,
      description: `${plan.description} - primer pago`,
      dueDate: plan.firstPayment.date,
      metadata: {
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
      status: isDueTodayOrPast(plan.firstPayment.date) ? 'pending' : 'scheduled',
      paymentMethod: 'stripe_saved_card',
      title: `${plan.title} - primer pago`,
      description: `${plan.description} - primer pago`,
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

    if (isDueTodayOrPast(plan.firstPayment.date)) {
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
      title: `${plan.title} - primer pago`,
      description: `${plan.description} - primer pago`,
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
      dueDate: new Date().toISOString().slice(0, 10),
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
      title: `${plan.title} - pago ${payment.sequence}`,
      description: `${plan.description} - pago ${payment.sequence}`,
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
  const dueDate = todayDateOnly()
  const dueTimestamp = new Date().toISOString()
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 25, 100))
  const firstPaymentDueDateSql = dateOnlySql('COALESCE(f.first_payment_date, p.due_date, p.date)')
  const installmentDueSql = duePlanInstallmentCondition('i')
  const dueDatePlaceholder = dateOnlyPlaceholder()
  const staleFirstPaymentSql = staleProcessingSql('f.updated_at')
  const staleInstallmentSql = staleProcessingSql('i.updated_at')
  const firstPaymentRows = await db.all(
    `SELECT
       f.id AS flow_id,
       f.contact_id,
       f.first_payment_invoice_id AS payment_id,
       f.stripe_payment_method_id,
       p.status AS payment_status
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
       AND ${firstPaymentDueDateSql} <= ${dueDatePlaceholder}
       AND p.status IN ('pending', 'scheduled', 'processing')
     ORDER BY COALESCE(f.first_payment_date, p.due_date, p.date) ASC
     LIMIT ?`,
    [STRIPE_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE, dueDate, normalizedLimit]
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

  if (activeContext.config.connectionType === 'manual') {
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
      logger.warn(`No se pudo preparar webhook manual de Stripe en modo ${otherMode}: ${error.message}`)
    }

    return contexts
  }

  if (!activeContext.config.connectModes?.[otherMode]?.connected) return contexts

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
  if (config.connectionType === 'connect' && event.account && event.account !== config.connectedAccountId) {
    return { received: true, ignored: true, type: event.type, account: event.account }
  }

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
    await updatePaymentFromIntent(object, { stripe, config, requestOptions })
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
