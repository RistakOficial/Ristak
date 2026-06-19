import Stripe from 'stripe'
import { randomBytes } from 'crypto'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { decrypt, encrypt, isEncrypted } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'
import { updateSingleContactStats } from '../utils/updateContactsStats.js'
import {
  createCentralStripeConnectUrl,
  disconnectCentralStripeConnect,
  getCentralStripeConnectStatus,
  isLicenseEnforced
} from './licenseService.js'

const CONFIG_KEYS = {
  enabled: 'stripe_enabled',
  connectionType: 'stripe_connection_type',
  mode: 'stripe_mode',
  publishableKey: 'stripe_publishable_key',
  secretKey: 'stripe_secret_key_encrypted',
  webhookSecret: 'stripe_webhook_secret_encrypted',
  defaultCurrency: 'stripe_default_currency',
  accountLabel: 'stripe_account_label',
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
  connectOauthState: 'stripe_connect_oauth_state'
}

const MASKED_PREFIX = '***'
const DEFAULT_CURRENCY = 'MXN'
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
  'invoice.payment_failed'
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

function normalizeCurrency(value) {
  const currency = cleanString(value || DEFAULT_CURRENCY).toUpperCase()
  return /^[A-Z]{3}$/.test(currency) ? currency : DEFAULT_CURRENCY
}

function normalizeMode(value) {
  return value === 'live' ? 'live' : 'test'
}

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase())
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
  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000).toISOString()
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

export async function getStripePaymentConfig({ includeSecrets = false } = {}) {
  const raw = await readRawConfig()
  const mode = normalizeMode(raw[CONFIG_KEYS.mode])
  const connectionType = normalizeConnectionType(raw[CONFIG_KEYS.connectionType])
  const managedByPortal = normalizeBoolean(raw[CONFIG_KEYS.connectManagedByPortal], false) || isLicenseEnforced()
  const platform = getStripeConnectPlatformConfig(mode)
  const connectedAccountId = cleanString(raw[CONFIG_KEYS.connectAccountId])
  const connectAccessToken = raw[CONFIG_KEYS.connectAccessToken] ? decryptSecret(raw[CONFIG_KEYS.connectAccessToken]) : ''
  const connectRefreshToken = raw[CONFIG_KEYS.connectRefreshToken] ? decryptSecret(raw[CONFIG_KEYS.connectRefreshToken]) : ''
  const publishableKey = connectionType === 'connect'
    ? cleanString(raw[CONFIG_KEYS.connectPublishableKey] || platform.publishableKey || raw[CONFIG_KEYS.publishableKey])
    : cleanString(raw[CONFIG_KEYS.publishableKey])
  const secretKey = raw[CONFIG_KEYS.secretKey] ? decryptSecret(raw[CONFIG_KEYS.secretKey]) : ''
  const webhookSecret = raw[CONFIG_KEYS.webhookSecret] ? decryptSecret(raw[CONFIG_KEYS.webhookSecret]) : ''
  const enabled = normalizeBoolean(raw[CONFIG_KEYS.enabled], true)
  const connectReady = Boolean(
    connectedAccountId &&
    (connectAccessToken || platform.secretKey) &&
    publishableKey
  )
  const manualReady = Boolean(publishableKey && secretKey)
  const configured = Boolean(enabled && (connectionType === 'connect' ? connectReady : manualReady))
  const oauthReadyByMode = {
    test: managedByPortal || getStripeConnectPlatformConfig('test').missing.length === 0,
    live: managedByPortal || getStripeConnectPlatformConfig('live').missing.length === 0
  }
  const connectUsesAccessToken = Boolean(connectionType === 'connect' && connectAccessToken)
  const connectUsesPlatformAccountHeader = Boolean(connectionType === 'connect' && !connectAccessToken && platform.secretKey && connectedAccountId)

  return {
    enabled,
    configured,
    connectionType,
    mode,
    defaultCurrency: normalizeCurrency(raw[CONFIG_KEYS.defaultCurrency]),
    accountLabel: cleanString(raw[CONFIG_KEYS.accountLabel]),
    publishableKey,
    hasSecretKey: connectionType === 'manual' ? Boolean(secretKey) : Boolean(connectAccessToken || platform.secretKey),
    secretKeyPreview: connectionType === 'manual' ? maskSecret(secretKey) : '',
    hasWebhookSecret: Boolean(webhookSecret),
    webhookSecretPreview: maskSecret(webhookSecret),
    connectedAccountId,
    connectedAccountPreview: connectedAccountId ? `${connectedAccountId.slice(0, 8)}...${connectedAccountId.slice(-4)}` : '',
    connectScope: cleanString(raw[CONFIG_KEYS.connectScope]),
    connectLivemode: normalizeBoolean(raw[CONFIG_KEYS.connectLivemode], mode === 'live'),
    connectReady,
    connectManagedByPortal: managedByPortal,
    connectUsesAccessToken,
    connectUsesPlatformAccountHeader,
    connectOauthReady: oauthReadyByMode[mode],
    connectOauthReadyByMode: oauthReadyByMode,
    connectMissingEnv: managedByPortal ? [] : platform.missing,
    connectAccountEmail: cleanString(raw[CONFIG_KEYS.connectAccountEmail]),
    connectChargesEnabled: normalizeBoolean(raw[CONFIG_KEYS.connectChargesEnabled], false),
    connectPayoutsEnabled: normalizeBoolean(raw[CONFIG_KEYS.connectPayoutsEnabled], false),
    connectDetailsSubmitted: normalizeBoolean(raw[CONFIG_KEYS.connectDetailsSubmitted], false),
    connectWebhookEndpointId: cleanString(raw[CONFIG_KEYS.connectWebhookEndpointId]),
    connectWebhookUrl: cleanString(raw[CONFIG_KEYS.connectWebhookUrl]),
    connectWebhookStatus: cleanString(raw[CONFIG_KEYS.connectWebhookStatus]),
    connectWebhookLastError: cleanString(raw[CONFIG_KEYS.connectWebhookLastError]),
    connectConnectedAt: cleanString(raw[CONFIG_KEYS.connectConnectedAt]),
    hasConnectAccessToken: Boolean(connectAccessToken),
    hasConnectRefreshToken: Boolean(connectRefreshToken),
    ...(includeSecrets
      ? {
          secretKey: connectionType === 'connect' ? (connectAccessToken || platform.secretKey) : secretKey,
          webhookSecret,
          connectAccessToken,
          connectRefreshToken
        }
      : {})
  }
}

export async function saveStripePaymentConfig(input = {}) {
  const current = await getStripePaymentConfig({ includeSecrets: true })
  const currentSecretKey = current.connectionType === 'manual' ? current.secretKey : ''
  const currentWebhookSecret = current.connectionType === 'manual' ? current.webhookSecret : ''
  const publishableKey = assertStripePublishableKey(input.publishableKey ?? '')
  const nextSecretKey = isMaskedSecret(input.secretKey)
    ? currentSecretKey
    : assertStripeSecret(input.secretKey ?? currentSecretKey)
  const nextWebhookSecret = isMaskedSecret(input.webhookSecret)
    ? currentWebhookSecret
    : cleanString(input.webhookSecret ?? currentWebhookSecret)

  await setAppConfig(CONFIG_KEYS.enabled, normalizeBoolean(input.enabled, true) ? '1' : '0')
  await setAppConfig(CONFIG_KEYS.connectionType, 'manual')
  await setAppConfig(CONFIG_KEYS.mode, normalizeMode(input.mode))
  await setAppConfig(CONFIG_KEYS.publishableKey, publishableKey)
  await setAppConfig(CONFIG_KEYS.defaultCurrency, normalizeCurrency(input.defaultCurrency || current.defaultCurrency))
  await setAppConfig(CONFIG_KEYS.accountLabel, cleanString(input.accountLabel || current.accountLabel))

  if (nextSecretKey) {
    await setAppConfig(CONFIG_KEYS.secretKey, encrypt(nextSecretKey))
  }

  if (nextWebhookSecret) {
    await setAppConfig(CONFIG_KEYS.webhookSecret, encrypt(nextWebhookSecret))
  } else if (input.webhookSecret === '') {
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
  return getStripePaymentConfig()
}

export async function getStripeClient() {
  const config = await getStripePaymentConfig({ includeSecrets: true })
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
    const error = new Error(data?.error_description || data?.error || 'Stripe no pudo completar OAuth.')
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

async function ensureStripeConnectWebhookEndpoint({ stripe, connectedAccountId, webhookUrl, currentEndpointId = '', currentSecret = '' }) {
  const cleanUrl = cleanString(webhookUrl)
  if (!cleanUrl) return { status: 'missing_url', endpointId: '', webhookUrl: '', webhookSecret: currentSecret, error: 'No se detectó URL pública.' }

  try {
    const requestOptions = { stripeAccount: connectedAccountId }
    const endpointPayload = {
      enabled_events: STRIPE_WEBHOOK_EVENTS,
      description: 'Ristak payments webhook',
      metadata: {
        ristak_integration: 'stripe_connect',
        stripe_account_id: connectedAccountId
      }
    }

    if (currentEndpointId) {
      const endpoint = await stripe.webhookEndpoints.update(
        currentEndpointId,
        {
          url: cleanUrl,
          ...endpointPayload,
          disabled: false
        },
        requestOptions
      )
      return {
        status: currentSecret ? 'active' : 'needs_secret',
        endpointId: endpoint.id,
        webhookUrl: endpoint.url,
        webhookSecret: currentSecret,
        error: currentSecret ? '' : 'Stripe no vuelve a mostrar el signing secret de endpoints existentes.'
      }
    }

    const created = await stripe.webhookEndpoints.create(
      {
        url: cleanUrl,
        ...endpointPayload
      },
      requestOptions
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
  webhook,
  defaultCurrency = DEFAULT_CURRENCY
}) {
  const normalizedMode = normalizeMode(mode)
  const accountDetails = mapStripeAccountForConfig(account)
  const connectedAccountId = cleanString(oauthData.stripe_user_id)
  const scope = cleanString(oauthData.scope || STRIPE_CONNECT_SCOPE)
  const livemode = normalizeBoolean(oauthData.livemode, normalizedMode === 'live')
  const connectPublishableKey = cleanString(oauthData.stripe_publishable_key)

  await setAppConfig(CONFIG_KEYS.enabled, '1')
  await setAppConfig(CONFIG_KEYS.connectionType, 'connect')
  await setAppConfig(CONFIG_KEYS.mode, livemode ? 'live' : 'test')
  await setAppConfig(CONFIG_KEYS.defaultCurrency, normalizeCurrency(defaultCurrency))
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

  if (oauthData.access_token) {
    await setAppConfig(CONFIG_KEYS.connectAccessToken, encryptOptionalSecret(oauthData.access_token))
  }
  if (oauthData.refresh_token) {
    await setAppConfig(CONFIG_KEYS.connectRefreshToken, encryptOptionalSecret(oauthData.refresh_token))
  }
  if (webhook.webhookSecret) {
    await setAppConfig(CONFIG_KEYS.webhookSecret, encrypt(webhook.webhookSecret))
  }

  await db.run('DELETE FROM app_config WHERE config_key = ?', [CONFIG_KEYS.secretKey])
  await db.run('DELETE FROM app_config WHERE config_key = ?', [CONFIG_KEYS.connectDisconnectedAt])
  await db.run('DELETE FROM app_config WHERE config_key = ?', [CONFIG_KEYS.connectOauthState])

  return getStripePaymentConfig()
}

export async function createStripeConnectOAuthUrl({ mode = 'test', baseUrl = '', returnPath = '/settings/payments/stripe' } = {}) {
  const normalizedMode = normalizeMode(mode)
  if (isLicenseEnforced()) {
    return createCentralStripeConnectUrl({
      mode: normalizedMode,
      returnPath: sanitizeStripeReturnPath(returnPath)
    })
  }

  const platform = getStripeConnectPlatformConfig(normalizedMode, {
    clientId: true,
    secretKey: true,
    publishableKey: true
  })
  const redirectUri = buildStripeOAuthRedirectUri(baseUrl)
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
    'stripe_user[currency]': normalizeCurrency((await getAppConfig(CONFIG_KEYS.defaultCurrency)) || DEFAULT_CURRENCY).toLowerCase()
  })

  return {
    url: `${STRIPE_CONNECT_AUTHORIZE_URL}?${params.toString()}`,
    mode: normalizedMode,
    redirectUri,
    scope: STRIPE_CONNECT_SCOPE
  }
}

export async function syncStripeConnectFromCentral() {
  if (!isLicenseEnforced()) {
    const error = new Error('Esta instalación no está conectada al portal central.')
    error.status = 400
    throw error
  }

  const connection = await getCentralStripeConnectStatus()
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
  await setAppConfig(CONFIG_KEYS.defaultCurrency, normalizeCurrency(await getAppConfig(CONFIG_KEYS.defaultCurrency) || DEFAULT_CURRENCY))
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
  await setAppConfig(CONFIG_KEYS.connectAccessToken, encryptOptionalSecret(connection.access_token))

  if (connection.refresh_token) {
    await setAppConfig(CONFIG_KEYS.connectRefreshToken, encryptOptionalSecret(connection.refresh_token))
  }
  if (connection.webhook_secret) {
    await setAppConfig(CONFIG_KEYS.webhookSecret, encrypt(connection.webhook_secret))
  }

  await db.run('DELETE FROM app_config WHERE config_key IN (?, ?)', [CONFIG_KEYS.secretKey, CONFIG_KEYS.connectOauthState])
  return getStripePaymentConfig()
}

export async function completeStripeConnectOAuth({ code = '', state = '', baseUrl = '' } = {}) {
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
  const current = await getStripePaymentConfig({ includeSecrets: true })
  const webhookUrl = `${cleanString(baseUrl || savedState.redirectUri).replace(/\/api\/stripe\/connect\/callback$/, '').replace(/\/+$/, '')}/api/stripe/webhook`
  const webhook = await ensureStripeConnectWebhookEndpoint({
    stripe,
    connectedAccountId,
    webhookUrl,
    currentEndpointId: current.connectWebhookEndpointId,
    currentSecret: current.webhookSecret
  })

  const config = await saveStripeConnectConnection({
    mode: finalMode,
    oauthData,
    account,
    webhook,
    defaultCurrency: await getAppConfig(CONFIG_KEYS.defaultCurrency)
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
    await stripe.webhookEndpoints.del(config.connectWebhookEndpointId, {
      stripeAccount: config.connectedAccountId
    }).catch((error) => {
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

function mapPublicPayment(row, config, baseUrl = '') {
  if (!row) return null
  const metadata = parseJson(row.metadata_json, {})
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
    stripeAccountId: config?.connectUsesPlatformAccountHeader ? config.connectedAccountId || '' : ''
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

async function ensureStripeCustomerForContact(stripe, contactId, fallback = {}, requestOptions = undefined) {
  const contact = await getStripeContact(contactId)
  if (!contact) return null

  const existingCustomerId = cleanString(contact.stripe_customer_id)
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

  const publicPaymentId = createPublicId()
  const id = createId('stripe_payment')
  const currency = normalizeCurrency(input.currency || config.defaultCurrency)
  const now = new Date().toISOString()
  const paymentUrl = buildPaymentUrl(baseUrl, publicPaymentId)
  const contactId = cleanString(input.contactId) || null
  const stripeCustomerId = contactId
    ? await ensureStripeCustomerForContact(stripe, contactId, input, requestOptions)
    : null
  const metadata = {
    contactName: cleanString(input.contactName),
    contactEmail: cleanString(input.email),
    contactPhone: cleanString(input.phone),
    stripeCustomerId: stripeCustomerId || '',
    source: cleanString(input.source || 'ristak'),
    lineItems: Array.isArray(input.lineItems) ? input.lineItems : [],
    ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {})
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
      Math.round(amount * 100) / 100,
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
    payment: mapPublicPayment(await findPaymentByPublicId(publicPaymentId), config, baseUrl),
    paymentUrl,
    publicPaymentId
  }
}

export async function getPublicStripePayment(publicPaymentId, { baseUrl, sync = false } = {}) {
  const config = await getStripePaymentConfig()
  let row = await findPaymentByPublicId(publicPaymentId)
  if (!row || row.payment_provider !== 'stripe') return null

  if (sync && row.stripe_payment_intent_id && !['paid', 'refunded', 'void', 'deleted'].includes(row.status)) {
    await refreshStripePaymentFromIntent(row.stripe_payment_intent_id)
    row = await findPaymentByPublicId(publicPaymentId)
  }

  return mapPublicPayment(row, config, baseUrl)
}

export async function createStripePaymentIntent(publicPaymentId, options = {}) {
  const { stripe, config, requestOptions } = await getStripeClient()
  const row = await findPaymentByPublicId(publicPaymentId)
  if (!row || row.payment_provider !== 'stripe') {
    const error = new Error('Pago no encontrado.')
    error.status = 404
    throw error
  }

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
        contactPhone: row.contact_phone
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

  const intent = await stripe.paymentIntents.create(
    {
      amount: toStripeAmount(row.amount, currency),
      currency: currency.toLowerCase(),
      automatic_payment_methods: { enabled: true },
      ...(stripeCustomerId ? { customer: stripeCustomerId } : {}),
      ...(savePaymentMethod && stripeCustomerId ? { setup_future_usage: 'off_session' } : {}),
      description: row.title || row.description || 'Pago Ristak',
      receipt_email: row.contact_email || undefined,
      metadata
    },
    requestOptions
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

  const row = await db.get(`SELECT contact_id FROM payments WHERE ${whereColumn} = ?`, [whereValue])
  if (row?.contact_id && nextStatus === 'paid') {
    updateSingleContactStats(row.contact_id).catch((error) => {
      logger.warn(`No se pudieron actualizar stats del contacto por invoice Stripe ${whereValue}: ${error.message}`)
    })
  }

  return nextStatus
}

async function markStripePaymentAsRefunded({ paymentIntentId, chargeId, sourceLabel }) {
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
    `SELECT id, contact_id FROM payments WHERE ${filters.join(' OR ')} LIMIT 1`,
    params
  )

  if (!payment) return null

  await db.run(
    `UPDATE payments
     SET status = 'refunded',
         payment_method = 'stripe',
         payment_provider = 'stripe',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [payment.id]
  )

  if (payment.contact_id) {
    updateSingleContactStats(payment.contact_id).catch((error) => {
      logger.warn(`No se pudieron actualizar stats del contacto por ${sourceLabel} Stripe ${payment.id}: ${error.message}`)
    })
  }

  return 'refunded'
}

async function updatePaymentFromRefund(refund) {
  return markStripePaymentAsRefunded({
    paymentIntentId: extractStripeObjectId(refund?.payment_intent),
    chargeId: extractStripeObjectId(refund?.charge),
    sourceLabel: 'refund'
  })
}

async function updatePaymentFromRefundedCharge(charge) {
  return markStripePaymentAsRefunded({
    paymentIntentId: extractStripeObjectId(charge?.payment_intent),
    chargeId: extractStripeObjectId(charge?.id),
    sourceLabel: 'charge.refunded'
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

  const stripeCustomerId = cleanString(contact.stripe_customer_id)
  if (!stripeCustomerId) return []

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
    if (error?.statusCode === 404) return []
    throw error
  }

  const rows = await db.all(
    `SELECT *
     FROM stripe_payment_methods
     WHERE contact_id = ? AND mode = ?
     ORDER BY is_default DESC, updated_at DESC`,
    [contact.id, config.mode]
  )

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

  const currency = normalizeCurrency(row.currency || config.defaultCurrency)
  const metadata = parseJson(row.metadata_json, {})
  const planMetadata = metadata.paymentPlan && typeof metadata.paymentPlan === 'object'
    ? metadata.paymentPlan
    : {}
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
        receipt_email: cleanString(metadata.contactEmail || savedMethod.contact_email) || undefined,
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
      requestOptions
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

    return {
      sequence: Number(payment.sequence || index + 1),
      amount: Math.round(amount * 100) / 100,
      percentage: payment.percentage ?? null,
      dueDate: normalizeDateOnly(payment.dueDate),
      frequency: cleanString(payment.frequency || input.remainingFrequency || 'custom') || 'custom'
    }
  })

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
      date: firstPaymentEnabled ? normalizeDateOnly(firstPayment.date) : null,
      method: firstPaymentEnabled ? cleanString(firstPayment.method || 'card') : 'none'
    },
    remainingPayments: normalizedRemaining,
    remainingFrequency: cleanString(input.remainingFrequency || 'custom') || 'custom',
    cardSetupAmount,
    lineItems: Array.isArray(input.invoicePayload?.items) ? input.invoicePayload.items : [],
    invoicePayload: input.invoicePayload || {},
    paymentMethodId: cleanString(input.paymentMethodId),
    source: cleanString(input.source || 'record_payment_modal_stripe_plan')
  }
}

function getStripePlanRecurrenceLabel(frequency) {
  const labels = {
    weekly: 'Semanal',
    biweekly: 'Quincenal',
    monthly: 'Mensual',
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
    ...(extra && Object.keys(extra).length ? extra : {})
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
  const nextFrequency = cleanString(input.remainingFrequency || input.frequency || metadata.remainingFrequency || 'custom') || 'custom'
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

    const dueDate = normalizeDateOnly(submitted.dueDate || submitted.date || submitted.scheduledAt)
    if (!dueDate) {
      const error = new Error('Cada parcialidad futura necesita fecha de cobro.')
      error.status = 400
      throw error
    }

    const method = normalizePlanEditablePaymentMethod(submitted.paymentMethod || submitted.method, hasSavedCard)
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
      const normalizedFirstPaymentMethod = normalizePlanEditableFirstPaymentMethod(
        firstPayment.method || firstPayment.paymentMethod || firstPaymentMethod || 'stripe_auto',
        hasSavedCard
      )
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
    actionedAt: new Date().toISOString()
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

export async function applyStripePaymentPlanAction(flowId, action) {
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

  if (normalizedAction === 'activate') {
    const hasSavedCard = Boolean(cleanString(flow.stripe_payment_method_id))
    const nextState = hasSavedCard
      ? STRIPE_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE
      : STRIPE_PLAN_STATES.WAITING_CARD_AUTHORIZATION

    await db.run(
      `UPDATE payment_flows
       SET current_state = ?,
           installment_plan_created_at = CASE WHEN ? = ? THEN COALESCE(installment_plan_created_at, ?) ELSE installment_plan_created_at END,
           installment_plan_active_at = CASE WHEN ? = ? THEN COALESCE(installment_plan_active_at, ?) ELSE installment_plan_active_at END,
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
  const currency = normalizeCurrency(input.currency || config.defaultCurrency)
  const now = new Date().toISOString()
  const title = cleanString(input.title) || 'Pago'
  const description = cleanString(input.description) || title
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
    lineItems: Array.isArray(input.lineItems) ? input.lineItems : []
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
      Math.round(amount * 100) / 100,
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
  const plan = validateStripePaymentPlanPayload(input)
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
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 25, 100))
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
       AND f.first_payment_status IN ('pending', 'scheduled')
       AND f.first_payment_method IN ('card', 'payment_link', 'direct_card', 'saved_card')
       AND f.stripe_payment_method_id IS NOT NULL
       AND substr(COALESCE(f.first_payment_date, p.due_date, p.date), 1, 10) <= ?
       AND p.status IN ('pending', 'scheduled')
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
       AND i.status = 'scheduled'
       AND i.payment_id IS NOT NULL
       AND substr(i.due_date, 1, 10) <= ?
     ORDER BY i.due_date ASC, i.sequence ASC
     LIMIT ?`,
    [STRIPE_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE, dueDate, normalizedLimit]
  )

  const results = []
  for (const row of firstPaymentRows || []) {
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

  return results
}

export async function refreshStripePaymentFromIntent(paymentIntentId) {
  const context = await getStripeClient()
  const { stripe, requestOptions } = context
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId, requestOptions)
  return updatePaymentFromIntent(intent, context)
}

export async function handleStripeWebhookEvent(rawBody, signature) {
  const { stripe, config, requestOptions } = await getStripeClient()
  if (!config.webhookSecret) {
    const error = new Error('Configura el webhook secret de Stripe antes de recibir eventos.')
    error.status = 400
    throw error
  }

  const event = stripe.webhooks.constructEvent(rawBody, signature, config.webhookSecret)
  if (config.connectionType === 'connect' && event.account && event.account !== config.connectedAccountId) {
    return { received: true, ignored: true, type: event.type, account: event.account }
  }
  const object = event?.data?.object

  if (object?.object === 'payment_intent') {
    await updatePaymentFromIntent(object, { stripe, config, requestOptions })
  } else if (event.type === 'invoice.payment_succeeded' && object?.object === 'invoice') {
    await updatePaymentFromInvoice(object, 'paid')
  } else if (event.type === 'invoice.payment_failed' && object?.object === 'invoice') {
    await updatePaymentFromInvoice(object, 'failed')
  } else if (event.type === 'charge.refunded' && object?.object === 'charge') {
    await updatePaymentFromRefundedCharge(object)
  } else if (event.type === 'refund.created' && object?.object === 'refund') {
    await updatePaymentFromRefund(object)
  }

  return { received: true, type: event.type }
}
