import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { decrypt, encrypt, isEncrypted } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'
import { updateSingleContactStats } from '../utils/updateContactsStats.js'
import { getAccountCurrency } from '../utils/accountLocale.js'
import {
  claimCentralOAuthHandoff,
  createCentralMercadoPagoConnectUrl,
  disconnectCentralMercadoPago,
  isLicenseEnforced,
  refreshCentralMercadoPagoToken
} from './licenseService.js'
import { calculatePaymentTax, getPaymentGatewayMode, getPublicPaymentSettings } from './paymentSettingsService.js'
import { registerGigstackPaymentForTransactionInBackground } from './gigstackInvoiceService.js'
import { dispatchProductPostWebhooksForPaymentInBackground } from './productPostWebhookService.js'
import { resolvePaymentContactForGatewayPayment } from './paymentContactLinkService.js'
import { sendPaymentNotification } from './pushNotificationsService.js'
import { publishPaymentChangedEvent, publishSubscriptionChangedEvent } from './paymentLiveEventsService.js'
// (PAY2-003) Encolar el comprobante automático tras un pago de Mercado Pago (igual que Conekta).
import { queuePaymentAutomationMessage } from './paymentAutomationsService.js'
import { mapGatewayPaymentStatus } from './paymentGatewayStatusPolicy.js'
import {
  buildMetaPublicPurchasePixelEvent,
  triggerMetaPaymentPurchaseEvent
} from './metaConversionEventsService.js'
import { getPaymentPlanAuditSummary, hardDeleteTestPaymentPlan, shouldSuppressProductionPaymentEffects } from './paymentRecordSafetyService.js'
import {
  assertPlanCanChangeState,
  markOverduePaymentPlanChargesForReview,
  withPaymentPlanEditState
} from './paymentPlanSafetyService.js'
import { createPublicPaymentId, createRistakPaymentEntityId } from '../utils/idGenerator.js'
import {
  DEFAULT_TIMEZONE as ACCOUNT_DEFAULT_TIMEZONE,
  assertDateOnlyNotInPast,
  businessTodayDateOnly,
  getAccountTimezone,
  normalizeDateOnlyInTimezone
} from '../utils/dateUtils.js'

const CONFIG_KEYS = {
  enabled: 'mercadopago_enabled',
  mode: 'mercadopago_mode',
  defaultCurrency: 'mercadopago_default_currency',
  accountLabel: 'mercadopago_account_label',
  publicKey: 'mercadopago_public_key',
  userId: 'mercadopago_user_id',
  scope: 'mercadopago_scope',
  tokenType: 'mercadopago_token_type',
  livemode: 'mercadopago_livemode',
  accessToken: 'mercadopago_access_token_encrypted',
  refreshToken: 'mercadopago_refresh_token_encrypted',
  webhookSecret: 'mercadopago_webhook_secret_encrypted',
  webhookUrl: 'mercadopago_webhook_url',
  tokenExpiresAt: 'mercadopago_token_expires_at',
  connectedAt: 'mercadopago_connected_at',
  disconnectedAt: 'mercadopago_disconnected_at',
  managedByPortal: 'mercadopago_managed_by_portal',
  modeConnections: 'mercadopago_mode_connections',
  subscriptionTestPublicKey: 'mercadopago_subscription_test_public_key',
  subscriptionTestAccessToken: 'mercadopago_subscription_test_access_token_encrypted',
  subscriptionTestWebhookSecret: 'mercadopago_subscription_test_webhook_secret_encrypted'
}

const DEFAULT_CURRENCY = 'MXN'
const MERCADOPAGO_API_BASE = 'https://api.mercadopago.com'
const MERCADOPAGO_WEBHOOK_PATH = '/api/mercadopago/webhook'
const TOKEN_SYNC_WINDOW_MS = 15 * 60 * 1000
const MERCADOPAGO_SUBSCRIPTION_START_BUFFER_MS = 10 * 60 * 1000
const MERCADOPAGO_TEST_CARD_HELP = 'Mercado Pago rechazó el pago de prueba. En el link de pago abre la ayuda de pruebas, usa una tarjeta de esa tabla, cualquier correo válido y el nombre del titular que simula el resultado: APRO para aprobar, FUND para fondos insuficientes u otro escenario disponible.'
const MERCADOPAGO_SUBSCRIPTION_TEST_USER_HELP = 'Mercado Pago rechazó la suscripción de prueba porque el vendedor y el pagador deben ser usuarios del mismo tipo. Si conectaste una cuenta test, el email del contacto debe ser un comprador test de Mercado Pago del mismo país que el vendedor test, no un cliente real ni el mismo vendedor. Cambia el email del contacto por el usuario comprador test o cambia Mercado Pago a modo en vivo para clientes reales.'
const MERCADOPAGO_SUBSCRIPTION_INTERNAL_ERROR_HELP = 'Mercado Pago devolvió un error interno al crear la suscripción. En modo prueba usa el email del comprador test de Mercado Pago del mismo país que el vendedor; APRO aplica al nombre de tarjeta en el checkout, no al contacto de la suscripción. Si el comprador test ya es correcto, intenta crear el link nuevamente.'
const MERCADOPAGO_SUBSCRIPTION_UNAUTHORIZED_HELP = 'Mercado Pago no autorizó crear la suscripción con la cuenta conectada. Reconecta Mercado Pago y asegúrate de usar una cuenta vendedora con suscripciones activas; en modo prueba usa un vendedor test y un comprador test del mismo país.'
const MERCADOPAGO_SUBSCRIPTION_TEST_CREDENTIALS_HELP = 'Mercado Pago no puede autorizar suscripciones de prueba con credenciales TEST. Para links de suscripción en modo prueba conecta o configura las credenciales de producción del usuario vendedor test (APP_USR). Las credenciales TEST siguen sirviendo para pagos únicos con tarjeta, pero el checkout hospedado de suscripciones necesita APP_USR.'
const DEFAULT_PAYMENT_TIMEZONE = ACCOUNT_DEFAULT_TIMEZONE
const MP_PLAN_STATES = {
  ACTIVE: 'mercadopago_plan_active',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  DELETED: 'deleted'
}
const SUCCESSFUL_PAYMENT_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'approved', 'accredited'])
const LOCKED_PLAN_PAYMENT_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'refunded', 'void', 'deleted', 'cancelled', 'canceled'])
const MERCADOPAGO_CHECKOUT_METHODS = new Set(['', 'mercadopago', 'mercadopago_checkout', 'payment_link', 'checkout', 'card', 'auto'])
const MERCADOPAGO_PAYMENT_LINK_INSTALLMENT_CHOICES = new Set([1, 2, 3, 6, 9, 12, 18, 24])
const MANUAL_PLAN_PAYMENT_METHODS = new Set(['cash', 'bank_transfer', 'transfer', 'deposit', 'check', 'other', 'manual', 'offline'])

let mercadoPagoFetchForTest = null

export function setMercadoPagoFetchForTest(fetchImpl) {
  mercadoPagoFetchForTest = typeof fetchImpl === 'function' ? fetchImpl : null
}

function cleanString(value) {
  return String(value || '').trim()
}

function shouldIgnorePendingWebhookRegression(payment = {}, nextStatus = '') {
  if (nextStatus !== 'pending') return false
  const currentStatus = cleanString(payment.status).toLowerCase()
  return SUCCESSFUL_PAYMENT_STATUSES.has(currentStatus) || Boolean(payment.paid_at)
}

function mercadoPagoFetch() {
  return mercadoPagoFetchForTest || fetch
}

function normalizeMode(value) {
  return value === 'live' ? 'live' : 'test'
}

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase())
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

function getSubscriptionStartPaymentFromMetadata(metadata = {}) {
  const payment = metadata?.subscriptionStartPayment && typeof metadata.subscriptionStartPayment === 'object'
    ? metadata.subscriptionStartPayment
    : {}
  const legacy = metadata?.publicPaymentLink && typeof metadata.publicPaymentLink === 'object'
    ? metadata.publicPaymentLink
    : {}
  return {
    paymentId: cleanString(payment.paymentId || legacy.paymentId),
    publicPaymentId: cleanString(payment.publicPaymentId || legacy.publicPaymentId),
    paymentUrl: cleanString(payment.paymentUrl || legacy.paymentUrl),
    provider: cleanString(payment.provider || legacy.provider),
    status: cleanString(payment.status || legacy.status)
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

function maskSecret(value = '') {
  const clean = cleanString(value)
  if (!clean) return ''
  if (clean.length <= 10) return '****'
  return `${clean.slice(0, 8)}****${clean.slice(-6)}`
}

function isMaskedSecret(value = '') {
  return /[•*]/.test(String(value || ''))
}

function normalizePositiveAmount(value, fallback = 25) {
  const amount = Number(value)
  if (Number.isFinite(amount) && amount > 0) return Math.round(amount * 100) / 100
  return Math.round(Number(fallback || 25) * 100) / 100
}

function normalizeDateOnly(value, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  return normalizeDateOnlyInTimezone(value, timezone)
}

function todayDateOnly(timezone = DEFAULT_PAYMENT_TIMEZONE) {
  return businessTodayDateOnly(timezone)
}

function assertDateNotInPast(value, message, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  return assertDateOnlyNotInPast(value, timezone, message)
}

function dateOnlySql(expression) {
  return process.env.DATABASE_URL ? `(${expression})::date` : `DATE(${expression})`
}

function dateOnlyPlaceholder() {
  return process.env.DATABASE_URL ? '?::date' : 'DATE(?)'
}

function buildPaymentUrl(baseUrl, publicPaymentId) {
  const cleanBase = cleanString(baseUrl).replace(/\/+$/, '')
  return cleanBase ? `${cleanBase}/pay/${encodeURIComponent(publicPaymentId)}` : ''
}

function isMercadoPagoCheckoutUrl(value) {
  try {
    const hostname = new URL(cleanString(value)).hostname.toLowerCase()
    return hostname.includes('mercadopago.')
  } catch {
    return false
  }
}

function getStoredMercadoPagoCheckout(row = {}, config = {}) {
  const metadata = parseJson(row.metadata_json, {})
  const checkout = metadata.mercadoPagoCheckout && typeof metadata.mercadoPagoCheckout === 'object'
    ? metadata.mercadoPagoCheckout
    : {}
  const mode = normalizeMode(row.payment_mode || config.mode)
  const modeUrl = mode === 'test'
    ? cleanString(checkout.sandboxInitPoint || checkout.paymentUrl)
    : cleanString(checkout.initPoint || checkout.paymentUrl)
  const fallbackUrl = cleanString(checkout.paymentUrl || checkout.checkoutUrl || checkout.initPoint || checkout.sandboxInitPoint)
  const legacyUrl = isMercadoPagoCheckoutUrl(row.payment_url) ? cleanString(row.payment_url) : ''

  return {
    preferenceId: cleanString(checkout.preferenceId || row.mercadopago_preference_id),
    checkoutUrl: modeUrl || fallbackUrl || legacyUrl,
    initPoint: cleanString(checkout.initPoint),
    sandboxInitPoint: cleanString(checkout.sandboxInitPoint),
    mode
  }
}

function withMercadoPagoCheckoutMetadata(row = {}, payload = {}, config = {}, checkoutUrl = '') {
  const metadata = parseJson(row.metadata_json, {})
  return JSON.stringify({
    ...metadata,
    mercadoPagoCheckout: {
      ...(metadata.mercadoPagoCheckout && typeof metadata.mercadoPagoCheckout === 'object'
        ? metadata.mercadoPagoCheckout
        : {}),
      preferenceId: cleanString(payload.id),
      initPoint: cleanString(payload.init_point),
      sandboxInitPoint: cleanString(payload.sandbox_init_point),
      paymentUrl: cleanString(checkoutUrl),
      mode: normalizeMode(config.mode),
      updatedAt: new Date().toISOString()
    }
  })
}

function getConfiguredBaseUrl() {
  return cleanString(
    process.env.PUBLIC_APP_URL ||
    process.env.APP_PUBLIC_URL ||
    process.env.FRONTEND_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    process.env.APP_URL
  ).replace(/\/+$/, '')
}

async function readRawConfig() {
  const configKeys = Object.values(CONFIG_KEYS)
  const rows = await db.all(
    `SELECT config_key, config_value FROM app_config
     WHERE config_key IN (${configKeys.map(() => '?').join(', ')})`,
    configKeys
  )

  const values = {}
  for (const row of rows || []) values[row.config_key] = row.config_value
  return values
}

function shouldSyncToken(raw = {}) {
  const expiresAt = raw[CONFIG_KEYS.tokenExpiresAt]
  if (!expiresAt) return false
  const expires = new Date(expiresAt).getTime()
  return Number.isFinite(expires) && expires - Date.now() <= TOKEN_SYNC_WINDOW_MS
}

function normalizeStoredMercadoPagoConnection(value = {}, mode = 'test') {
  if (!value || typeof value !== 'object') return null
  const normalizedMode = normalizeMode(value.mode || mode)
  const userId = cleanString(value.userId || value.user_id)
  if (!userId) return null

  return {
    mode: normalizedMode,
    accountLabel: cleanString(value.accountLabel || value.account_label),
    userId,
    publicKey: cleanString(value.publicKey || value.public_key),
    scope: cleanString(value.scope),
    tokenType: cleanString(value.tokenType || value.token_type || 'bearer'),
    livemode: normalizeBoolean(value.livemode, normalizedMode === 'live'),
    accessToken: cleanString(value.accessToken || value.access_token),
    refreshToken: cleanString(value.refreshToken || value.refresh_token),
    webhookSecret: cleanString(value.webhookSecret || value.webhook_secret),
    webhookUrl: cleanString(value.webhookUrl || value.webhook_url),
    tokenExpiresAt: cleanString(value.tokenExpiresAt || value.token_expires_at),
    connectedAt: cleanString(value.connectedAt || value.connected_at),
    managedByPortal: normalizeBoolean(value.managedByPortal ?? value.managed_by_portal, false)
  }
}

function readMercadoPagoModeConnections(raw = {}) {
  const parsed = parseJson(raw[CONFIG_KEYS.modeConnections], {})
  return {
    test: normalizeStoredMercadoPagoConnection(parsed.test, 'test'),
    live: normalizeStoredMercadoPagoConnection(parsed.live, 'live')
  }
}

function legacyMercadoPagoConnectionFromRaw(raw = {}, mode = 'test') {
  const userId = cleanString(raw[CONFIG_KEYS.userId])
  if (!userId) return null
  const normalizedMode = normalizeMode(raw[CONFIG_KEYS.mode] || mode)
  return normalizeStoredMercadoPagoConnection({
    mode: normalizedMode,
    accountLabel: raw[CONFIG_KEYS.accountLabel],
    userId,
    publicKey: raw[CONFIG_KEYS.publicKey],
    scope: raw[CONFIG_KEYS.scope],
    tokenType: raw[CONFIG_KEYS.tokenType],
    livemode: raw[CONFIG_KEYS.livemode],
    accessToken: raw[CONFIG_KEYS.accessToken],
    refreshToken: raw[CONFIG_KEYS.refreshToken],
    webhookSecret: raw[CONFIG_KEYS.webhookSecret],
    webhookUrl: raw[CONFIG_KEYS.webhookUrl],
    tokenExpiresAt: raw[CONFIG_KEYS.tokenExpiresAt],
    connectedAt: raw[CONFIG_KEYS.connectedAt],
    managedByPortal: raw[CONFIG_KEYS.managedByPortal]
  }, normalizedMode)
}

function getMercadoPagoModeConnection(raw = {}, mode = 'test') {
  const normalizedMode = normalizeMode(mode)
  const connections = readMercadoPagoModeConnections(raw)
  if (connections[normalizedMode]) return connections[normalizedMode]

  const legacy = legacyMercadoPagoConnectionFromRaw(raw, normalizedMode)
  return legacy?.mode === normalizedMode ? legacy : null
}

function decryptStoredMercadoPagoConnection(connection = null) {
  if (!connection) return null
  return {
    ...connection,
    accessToken: decryptSecret(connection.accessToken),
    refreshToken: decryptSecret(connection.refreshToken),
    webhookSecret: decryptSecret(connection.webhookSecret)
  }
}

function summarizeMercadoPagoModeConnection(raw = {}, mode = 'test') {
  const normalizedMode = normalizeMode(mode)
  const connection = getMercadoPagoModeConnection(raw, normalizedMode)

  return {
    mode: normalizedMode,
    connected: Boolean(cleanString(connection?.userId) && cleanString(connection?.accessToken)),
    accountLabel: cleanString(connection?.accountLabel),
    userId: cleanString(connection?.userId),
    publicKey: cleanString(connection?.publicKey),
    livemode: normalizeBoolean(connection?.livemode, normalizedMode === 'live'),
    hasAccessToken: Boolean(cleanString(connection?.accessToken)),
    hasRefreshToken: Boolean(cleanString(connection?.refreshToken)),
    hasWebhookSecret: Boolean(cleanString(connection?.webhookSecret)),
    webhookUrl: cleanString(connection?.webhookUrl),
    connectedAt: cleanString(connection?.connectedAt),
    managedByPortal: normalizeBoolean(connection?.managedByPortal, false)
  }
}

async function saveMercadoPagoModeConnection(mode, connection) {
  const raw = await readRawConfig()
  const connections = readMercadoPagoModeConnections(raw)
  connections[normalizeMode(mode)] = normalizeStoredMercadoPagoConnection(connection, mode)

  await setAppConfig(CONFIG_KEYS.modeConnections, JSON.stringify({
    test: connections.test,
    live: connections.live
  }))
}

async function writeActiveMercadoPagoConnection(mode, connection) {
  const normalizedMode = normalizeMode(mode)
  const cleanConnection = normalizeStoredMercadoPagoConnection(connection, normalizedMode)
  if (!cleanConnection) {
    const error = new Error(`Mercado Pago no está conectado en modo ${normalizedMode === 'live' ? 'en vivo' : 'prueba'}.`)
    error.status = 400
    throw error
  }

  await setAppConfig(CONFIG_KEYS.enabled, '1')
  await setAppConfig(CONFIG_KEYS.mode, normalizedMode)
  await setAppConfig(CONFIG_KEYS.defaultCurrency, await getConfiguredCurrency())
  await setAppConfig(CONFIG_KEYS.accountLabel, cleanConnection.accountLabel)
  await setAppConfig(CONFIG_KEYS.publicKey, cleanConnection.publicKey)
  await setAppConfig(CONFIG_KEYS.userId, cleanConnection.userId)
  await setAppConfig(CONFIG_KEYS.scope, cleanConnection.scope)
  await setAppConfig(CONFIG_KEYS.tokenType, cleanConnection.tokenType)
  await setAppConfig(CONFIG_KEYS.livemode, cleanConnection.livemode ? '1' : '0')
  await setAppConfig(CONFIG_KEYS.webhookUrl, cleanConnection.webhookUrl)
  await setAppConfig(CONFIG_KEYS.tokenExpiresAt, cleanConnection.tokenExpiresAt)
  await setAppConfig(CONFIG_KEYS.connectedAt, cleanConnection.connectedAt || new Date().toISOString())
  await setAppConfig(CONFIG_KEYS.managedByPortal, cleanConnection.managedByPortal ? '1' : '0')

  if (cleanConnection.accessToken) await setAppConfig(CONFIG_KEYS.accessToken, cleanConnection.accessToken)
  if (cleanConnection.refreshToken) await setAppConfig(CONFIG_KEYS.refreshToken, cleanConnection.refreshToken)
  if (cleanConnection.webhookSecret) await setAppConfig(CONFIG_KEYS.webhookSecret, cleanConnection.webhookSecret)
}

function mapConfig(raw = {}, { includeSecrets = false, mode: modeOverride = '' } = {}) {
  const mode = normalizeMode(modeOverride || raw[CONFIG_KEYS.mode])
  const selectedConnection = decryptStoredMercadoPagoConnection(getMercadoPagoModeConnection(raw, mode))
  const legacyMatchesMode = normalizeMode(raw[CONFIG_KEYS.mode]) === mode
  const accessToken = cleanString(selectedConnection?.accessToken) || (legacyMatchesMode && raw[CONFIG_KEYS.accessToken] ? decryptSecret(raw[CONFIG_KEYS.accessToken]) : '')
  const refreshToken = cleanString(selectedConnection?.refreshToken) || (legacyMatchesMode && raw[CONFIG_KEYS.refreshToken] ? decryptSecret(raw[CONFIG_KEYS.refreshToken]) : '')
  const webhookSecret = cleanString(selectedConnection?.webhookSecret) || (legacyMatchesMode && raw[CONFIG_KEYS.webhookSecret] ? decryptSecret(raw[CONFIG_KEYS.webhookSecret]) : '')
  const enabled = normalizeBoolean(raw[CONFIG_KEYS.enabled], true)
  const configured = Boolean(enabled && accessToken && cleanString(selectedConnection?.userId || (legacyMatchesMode ? raw[CONFIG_KEYS.userId] : '')))
  const subscriptionTestAccessToken = raw[CONFIG_KEYS.subscriptionTestAccessToken] ? decryptSecret(raw[CONFIG_KEYS.subscriptionTestAccessToken]) : ''
  const subscriptionTestPublicKey = cleanString(raw[CONFIG_KEYS.subscriptionTestPublicKey])
  const subscriptionTestWebhookSecret = raw[CONFIG_KEYS.subscriptionTestWebhookSecret] ? decryptSecret(raw[CONFIG_KEYS.subscriptionTestWebhookSecret]) : ''

  return {
    enabled,
    configured,
    mode,
    defaultCurrency: normalizeCurrency(raw[CONFIG_KEYS.defaultCurrency] || DEFAULT_CURRENCY),
    accountLabel: cleanString(selectedConnection?.accountLabel || (legacyMatchesMode ? raw[CONFIG_KEYS.accountLabel] : '')),
    userId: cleanString(selectedConnection?.userId || (legacyMatchesMode ? raw[CONFIG_KEYS.userId] : '')),
    publicKey: cleanString(selectedConnection?.publicKey || (legacyMatchesMode ? raw[CONFIG_KEYS.publicKey] : '')),
    scope: cleanString(selectedConnection?.scope || (legacyMatchesMode ? raw[CONFIG_KEYS.scope] : '')),
    tokenType: cleanString(selectedConnection?.tokenType || (legacyMatchesMode ? raw[CONFIG_KEYS.tokenType] : '') || 'bearer'),
    livemode: normalizeBoolean(selectedConnection?.livemode ?? (legacyMatchesMode ? raw[CONFIG_KEYS.livemode] : undefined), mode === 'live'),
    webhookUrl: cleanString(selectedConnection?.webhookUrl || (legacyMatchesMode ? raw[CONFIG_KEYS.webhookUrl] : '')),
    hasWebhookSecret: Boolean(webhookSecret),
    tokenExpiresAt: selectedConnection?.tokenExpiresAt || (legacyMatchesMode ? raw[CONFIG_KEYS.tokenExpiresAt] : '') || null,
    connectedAt: selectedConnection?.connectedAt || (legacyMatchesMode ? raw[CONFIG_KEYS.connectedAt] : '') || null,
    disconnectedAt: raw[CONFIG_KEYS.disconnectedAt] || null,
    managedByPortal: normalizeBoolean(selectedConnection?.managedByPortal ?? raw[CONFIG_KEYS.managedByPortal], false) || isLicenseEnforced(),
    hasAccessToken: Boolean(accessToken),
    hasRefreshToken: Boolean(refreshToken),
    modeConnections: {
      test: summarizeMercadoPagoModeConnection(raw, 'test'),
      live: summarizeMercadoPagoModeConnection(raw, 'live')
    },
    subscriptionTestCredentials: {
      configured: Boolean(subscriptionTestPublicKey && subscriptionTestAccessToken && subscriptionTestWebhookSecret),
      publicKey: subscriptionTestPublicKey,
      hasAccessToken: Boolean(subscriptionTestAccessToken),
      accessTokenPreview: maskSecret(subscriptionTestAccessToken),
      hasWebhookSecret: Boolean(subscriptionTestWebhookSecret),
      webhookSecretPreview: maskSecret(subscriptionTestWebhookSecret)
    },
    ...(includeSecrets ? { accessToken, refreshToken, webhookSecret, subscriptionTestWebhookSecret } : {})
  }
}

async function writeCentralConnection(connection = {}) {
  const connected = Boolean(connection.connected && connection.access_token && connection.user_id)
  if (!connected) {
    const error = new Error('Mercado Pago no está conectado en el portal central.')
    error.status = 400
    throw error
  }

  const mode = normalizeMode(connection.mode)
  const storedConnection = {
    mode,
    accountLabel: cleanString(connection.account_label || connection.account_email || connection.user_id),
    userId: cleanString(connection.user_id),
    publicKey: cleanString(connection.public_key),
    scope: cleanString(connection.scope),
    tokenType: cleanString(connection.token_type || 'bearer'),
    livemode: Boolean(connection.livemode) || mode === 'live',
    accessToken: encryptOptionalSecret(connection.access_token),
    refreshToken: connection.refresh_token ? encryptOptionalSecret(connection.refresh_token) : '',
    webhookSecret: connection.webhook_secret ? encryptOptionalSecret(connection.webhook_secret) : '',
    webhookUrl: cleanString(connection.webhook_url),
    tokenExpiresAt: cleanString(connection.token_expires_at),
    connectedAt: cleanString(connection.connected_at || new Date().toISOString()),
    managedByPortal: true
  }

  await saveMercadoPagoModeConnection(mode, storedConnection)
  await writeActiveMercadoPagoConnection(mode, storedConnection)
}

async function refreshMercadoPagoLocalToken(raw = {}) {
  const current = mapConfig(raw, { includeSecrets: true })
  if (!current.refreshToken) {
    const error = new Error('Mercado Pago necesita reconexión porque no hay refresh token local.')
    error.status = 400
    throw error
  }

  const token = await refreshCentralMercadoPagoToken({
    mode: current.mode,
    refreshToken: current.refreshToken
  })

  await writeCentralConnection({
    connected: true,
    mode: current.mode,
    user_id: current.userId,
    account_label: current.accountLabel,
    public_key: token.public_key || current.publicKey,
    scope: token.scope || current.scope,
    token_type: token.token_type || current.tokenType,
    livemode: token.livemode ?? current.livemode,
    webhook_url: current.webhookUrl,
    token_expires_at: token.token_expires_at || current.tokenExpiresAt,
    connected_at: current.connectedAt || new Date().toISOString(),
    access_token: token.access_token,
    refresh_token: token.refresh_token || current.refreshToken,
    webhook_secret: current.webhookSecret
  })
}

export async function getMercadoPagoPaymentConfig({ includeSecrets = false, mode: modeOverride = '' } = {}) {
  let raw = await readRawConfig()
  const current = mapConfig(raw, { includeSecrets: true, mode: modeOverride })
  if (current.managedByPortal && current.accessToken && shouldSyncToken(raw)) {
    try {
      await refreshMercadoPagoLocalToken(raw)
      raw = await readRawConfig()
    } catch (error) {
      logger.warn(`No se pudo refrescar Mercado Pago con el broker central: ${error.message}`)
    }
  }
  const mode = modeOverride || await getPaymentGatewayMode()
  return mapConfig(raw, { includeSecrets, mode })
}

export async function saveMercadoPagoSubscriptionTestCredentials(input = {}) {
  const raw = await readRawConfig()
  const previousAccessToken = raw[CONFIG_KEYS.subscriptionTestAccessToken] ? decryptSecret(raw[CONFIG_KEYS.subscriptionTestAccessToken]) : ''
  const previousWebhookSecret = raw[CONFIG_KEYS.subscriptionTestWebhookSecret] ? decryptSecret(raw[CONFIG_KEYS.subscriptionTestWebhookSecret]) : ''
  const publicKey = cleanString(input.publicKey || input.public_key)
  const submittedAccessToken = cleanString(input.accessToken || input.access_token)
  const submittedWebhookSecret = cleanString(input.webhookSecret || input.webhook_secret)
  const accessToken = submittedAccessToken && !isMaskedSecret(submittedAccessToken)
    ? submittedAccessToken
    : previousAccessToken
  const webhookSecret = submittedWebhookSecret && !isMaskedSecret(submittedWebhookSecret)
    ? submittedWebhookSecret
    : previousWebhookSecret

  if (!publicKey || !publicKey.startsWith('APP_USR-')) {
    const error = new Error('La Public Key de suscripciones test debe ser una credencial APP_USR del vendedor test de Mercado Pago.')
    error.status = 400
    throw error
  }

  if (!accessToken || !accessToken.startsWith('APP_USR-')) {
    const error = new Error('El Access Token de suscripciones test debe ser una credencial APP_USR del vendedor test de Mercado Pago.')
    error.status = 400
    throw error
  }

  if (!webhookSecret) {
    const error = new Error('Falta la clave secreta del webhook de la aplicación test de Mercado Pago.')
    error.status = 400
    throw error
  }

  const { payload } = await mercadoPagoApiRequest('/users/me', {
    config: {
      ...(await getMercadoPagoPaymentConfig({ includeSecrets: true, mode: 'test' })),
      mode: 'test',
      publicKey,
      accessToken
    }
  })

  await setAppConfig(CONFIG_KEYS.subscriptionTestPublicKey, publicKey)
  await setAppConfig(CONFIG_KEYS.subscriptionTestAccessToken, encryptOptionalSecret(accessToken))
  await setAppConfig(CONFIG_KEYS.subscriptionTestWebhookSecret, encryptOptionalSecret(webhookSecret))

  const config = await getMercadoPagoPaymentConfig({ mode: 'test' })
  return {
    ...config,
    subscriptionTestCredentials: {
      ...(config.subscriptionTestCredentials || {}),
      configured: true,
      publicKey,
      hasAccessToken: true,
      accessTokenPreview: maskSecret(accessToken),
      hasWebhookSecret: true,
      webhookSecretPreview: maskSecret(webhookSecret),
      userId: cleanString(payload?.id),
      accountLabel: cleanString(payload?.nickname || payload?.email || payload?.id)
    }
  }
}

export async function deleteMercadoPagoSubscriptionTestCredentials() {
  await db.run(
    `DELETE FROM app_config
     WHERE config_key IN (?, ?, ?)`,
    [CONFIG_KEYS.subscriptionTestPublicKey, CONFIG_KEYS.subscriptionTestAccessToken, CONFIG_KEYS.subscriptionTestWebhookSecret]
  )
  return getMercadoPagoPaymentConfig({ mode: 'test' })
}

export async function createMercadoPagoOAuthUrl({ mode = '', appUrl = '', returnPath = '/settings/payments/mercadopago' } = {}) {
  const requestedMode = mode || await getPaymentGatewayMode()
  const result = await createCentralMercadoPagoConnectUrl({
    mode: requestedMode,
    appUrl,
    returnPath
  })
  return result
}

export async function syncMercadoPagoFromCentral({ handoffToken = '' } = {}) {
  if (!cleanString(handoffToken)) {
    const error = new Error('Falta el handoff de Mercado Pago. Intenta conectar otra vez desde el botón de Mercado Pago.')
    error.status = 400
    throw error
  }

  const handoff = await claimCentralOAuthHandoff({
    provider: 'mercadopago',
    handoffToken
  })
  const connection = handoff?.payload?.connection || {}
  await writeCentralConnection(connection)
  return getMercadoPagoPaymentConfig({ mode: connection.mode })
}

export async function setMercadoPagoActiveMode(mode = 'live') {
  const normalizedMode = normalizeMode(mode)
  const raw = await readRawConfig()
  const connection = getMercadoPagoModeConnection(raw, normalizedMode)
  if (!connection) {
    const error = new Error(`Reconecta Mercado Pago en modo ${normalizedMode === 'live' ? 'en vivo' : 'prueba'} para usar ese token.`)
    error.status = 400
    throw error
  }

  await writeActiveMercadoPagoConnection(normalizedMode, connection)
  return getMercadoPagoPaymentConfig()
}

export async function deleteMercadoPagoPaymentConfig() {
  const current = await getMercadoPagoPaymentConfig({ includeSecrets: true })
  if (current.managedByPortal) {
    try {
      await disconnectCentralMercadoPago()
    } catch (error) {
      logger.warn(`No se pudo desconectar Mercado Pago central: ${error.message}`)
    }
  }

  await db.run(
    `DELETE FROM app_config
     WHERE config_key IN (${Object.values(CONFIG_KEYS).map(() => '?').join(', ')})`,
    Object.values(CONFIG_KEYS)
  )
  return getMercadoPagoPaymentConfig()
}

async function getMercadoPagoClientConfig(mode = '') {
  let config = await getMercadoPagoPaymentConfig({ includeSecrets: true, mode })

  if (!config.configured || !config.accessToken) {
    const error = new Error('Mercado Pago no está configurado.')
    error.status = 400
    throw error
  }

  return config
}

async function getMercadoPagoSubscriptionClientConfig() {
  const config = await getMercadoPagoClientConfig()
  if (config.mode !== 'test') return config

  const usesTestCredentials = cleanString(config.accessToken).startsWith('TEST-')
    || cleanString(config.publicKey).startsWith('TEST-')
  if (!usesTestCredentials) return config

  const raw = await readRawConfig()
  const subscriptionAccessToken = decryptSecret(raw[CONFIG_KEYS.subscriptionTestAccessToken])
  const subscriptionPublicKey = cleanString(raw[CONFIG_KEYS.subscriptionTestPublicKey])

  if (subscriptionAccessToken && subscriptionPublicKey) {
    return {
      ...config,
      accessToken: subscriptionAccessToken,
      publicKey: subscriptionPublicKey
    }
  }

  const error = new Error(MERCADOPAGO_SUBSCRIPTION_TEST_CREDENTIALS_HELP)
  error.status = 400
  throw error
}

function normalizeMercadoPagoErrorMessage(payload = {}, options = {}) {
  const message = cleanString(payload?.message || payload?.error)
  const causes = Array.isArray(payload?.cause) ? payload.cause : []
  const path = cleanString(options.path)
  const hasInvalidTestUserEmailCause = causes.some((cause) => (
    Number(cause?.code) === 2198 ||
    /invalid test user email/i.test(cleanString(cause?.description || cause?.message))
  ))
  const hasInvalidUsersCause = causes.some((cause) => (
    Number(cause?.code) === 2034 ||
    /invalid users involved|both payer and collector must be real or test users/i.test(cleanString(cause?.description || cause?.message))
  ))

  if (
    /invalid test user email/i.test(message) ||
    /invalid users involved/i.test(message) ||
    /both payer and collector must be real or test users/i.test(message) ||
    hasInvalidTestUserEmailCause ||
    hasInvalidUsersCause
  ) {
    if (path.includes('/preapproval')) return MERCADOPAGO_SUBSCRIPTION_TEST_USER_HELP
    return MERCADOPAGO_TEST_CARD_HELP
  }

  if (path.includes('/preapproval') && /internal server error/i.test(message)) {
    return MERCADOPAGO_SUBSCRIPTION_INTERNAL_ERROR_HELP
  }

  if (path.includes('/preapproval') && /policy returned unauthorized|unauthorized/i.test(message)) {
    return MERCADOPAGO_SUBSCRIPTION_UNAUTHORIZED_HELP
  }

  return message || 'Mercado Pago no pudo completar la solicitud.'
}

async function mercadoPagoApiRequest(path, { method = 'GET', body = null, idempotencyKey = '', config: configOverride = null } = {}) {
  const config = configOverride || await getMercadoPagoClientConfig()
  const url = path.startsWith('http') ? path : `${MERCADOPAGO_API_BASE}${path}`
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${config.accessToken}`
  }
  if (body) headers['Content-Type'] = 'application/json'
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey

  const response = await mercadoPagoFetch()(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  })
  const payload = await response.json().catch(() => ({}))

  if (!response.ok) {
    const error = new Error(normalizeMercadoPagoErrorMessage(payload, { path }))
    error.status = response.status || 502
    error.payload = payload
    throw error
  }

  return { payload, config }
}

async function mercadoPagoSubscriptionApiRequest(path, options = {}) {
  const config = await getMercadoPagoSubscriptionClientConfig()
  return mercadoPagoApiRequest(path, { ...options, config })
}

export async function testMercadoPagoPaymentConfig() {
  const { payload } = await mercadoPagoApiRequest('/users/me')
  return {
    ok: true,
    userId: cleanString(payload.id),
    accountLabel: cleanString(payload.nickname || payload.email || payload.id),
    email: cleanString(payload.email)
  }
}

async function findPaymentByPublicId(publicPaymentId) {
  return db.get(
    `SELECT
      p.*,
      c.full_name AS contact_name,
      c.email AS contact_email,
      c.phone AS contact_phone
     FROM payments p
     LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE p.public_payment_id = ?`,
    [publicPaymentId]
  )
}

async function findPaymentById(paymentId) {
  return db.get(
    `SELECT
      p.*,
      c.full_name AS contact_name,
      c.email AS contact_email,
      c.phone AS contact_phone
     FROM payments p
     LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE p.id = ?`,
    [paymentId]
  )
}

function mapPublicPayment(row, config, baseUrl = '', settings = null, timezone = ACCOUNT_DEFAULT_TIMEZONE) {
  if (!row) return null
  const metadata = parseJson(row.metadata_json, {})
  const tax = metadata.tax && typeof metadata.tax === 'object' ? metadata.tax : null
  const mercadoPagoInstallments = normalizeMercadoPagoInstallmentOptions(metadata.mercadoPagoInstallments, { emptyAsNull: true })
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
    provider: 'mercadopago',
    contact: {
      id: row.contact_id || '',
      name: row.contact_name || metadata.contactName || '',
      email: row.contact_email || metadata.contactEmail || '',
      phone: row.contact_phone || metadata.contactPhone || ''
    },
    mercadoPagoPaymentId: row.mercadopago_payment_id || null,
    mercadoPagoPreferenceId: row.mercadopago_preference_id || null,
    publicKey: config?.publicKey || '',
    mercadoPagoInstallments,
    subscriptionStart,
    tax,
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

function buildPreferencePayload(row, { baseUrl = '' } = {}) {
  const metadata = parseJson(row.metadata_json, {})
  const mercadoPagoInstallments = normalizeMercadoPagoInstallmentOptions(metadata.mercadoPagoInstallments, { emptyAsNull: true })
  const publicPaymentId = row.public_payment_id
  const paymentPageUrl = buildPaymentUrl(baseUrl, publicPaymentId)
  const returnUrl = paymentPageUrl ? `${paymentPageUrl}?mercadopago=return` : ''
  const notificationUrl = cleanString(baseUrl) ? `${cleanString(baseUrl).replace(/\/+$/, '')}${MERCADOPAGO_WEBHOOK_PATH}` : ''
  const testMarker = metadata.conversationalAgentTest && typeof metadata.conversationalAgentTest === 'object'
    ? metadata.conversationalAgentTest
    : {}
  const cleanupDueAt = cleanString(testMarker.cleanupDueAt || metadata.cleanupDueAt)
  const cleanupDueAtMs = Date.parse(cleanupDueAt)
  const isExpiringTestPreference = normalizeMode(row.payment_mode) === 'test' && Number.isFinite(cleanupDueAtMs)
  if (isExpiringTestPreference && cleanupDueAtMs <= Date.now()) {
    const error = new Error('Este enlace sandbox ya venció. Inicia una nueva prueba.')
    error.status = 410
    throw error
  }
  const expirationFrom = isExpiringTestPreference
    ? new Date().toISOString()
    : ''

  return {
    items: [
      {
        id: row.id,
        title: row.title || 'Pago Ristak',
        description: row.description || row.title || 'Pago Ristak',
        quantity: 1,
        unit_price: Number(row.amount || 0),
        currency_id: normalizeCurrency(row.currency)
      }
    ],
    payer: {
      name: row.contact_name || metadata.contactName || undefined,
      email: row.contact_email || metadata.contactEmail || undefined,
      phone: row.contact_phone || metadata.contactPhone
        ? { number: row.contact_phone || metadata.contactPhone }
        : undefined
    },
    external_reference: row.id,
    notification_url: notificationUrl || undefined,
    back_urls: returnUrl ? {
      success: returnUrl,
      pending: returnUrl,
      failure: returnUrl
    } : undefined,
    auto_return: 'approved',
    binary_mode: false,
    ...(isExpiringTestPreference
      ? {
          expires: true,
          expiration_date_from: expirationFrom,
          expiration_date_to: new Date(cleanupDueAtMs).toISOString()
        }
      : {}),
    ...(mercadoPagoInstallments
      ? {
          payment_methods: {
            installments: mercadoPagoInstallments.maxInstallments
          }
        }
      : {}),
    metadata: {
      ristak_payment_id: row.id,
      public_payment_id: publicPaymentId,
      source: metadata.source || 'ristak',
      ...(mercadoPagoInstallments ? { mercado_pago_installments: mercadoPagoInstallments } : {}),
      ...(metadata.paymentPlan ? { payment_plan: metadata.paymentPlan } : {})
    }
  }
}

function normalizeMercadoPagoInstallmentOptions(value, { emptyAsNull = false } = {}) {
  if (!value || typeof value !== 'object') {
    return emptyAsNull ? null : {
      enabled: false,
      maxInstallments: 1,
      label: 'Pago de contado'
    }
  }

  const enabled = value.enabled === true || value.enabled === 'true' || value.enabled === 1
  const requestedMax = Number(value.maxInstallments || value.max_installments || value.installments)
  const maxInstallments = Number.isFinite(requestedMax)
    ? Math.max(1, Math.min(Math.trunc(requestedMax), 60))
    : 1

  if (!enabled || maxInstallments <= 1) {
    return {
      enabled: false,
      maxInstallments: 1,
      label: 'Pago de contado'
    }
  }

  return {
    enabled: true,
    maxInstallments,
    label: MERCADOPAGO_PAYMENT_LINK_INSTALLMENT_CHOICES.has(maxInstallments)
      ? `Hasta ${maxInstallments} meses`
      : `Hasta ${maxInstallments} cuotas`
  }
}

function normalizeInstallments(value) {
  const installments = Number(value)
  if (!Number.isFinite(installments) || installments <= 0) return 1
  return Math.max(1, Math.min(Math.trunc(installments), 60))
}

function normalizeIdempotencyKey(value, fallbackSeed) {
  const clean = cleanString(value)
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .slice(0, 120)

  if (clean.length >= 8) return clean
  return `ristak-mp-card-${fallbackSeed}-${randomBytes(8).toString('hex')}`.slice(0, 120)
}

function splitPayerName(value) {
  const clean = cleanString(value)
  if (!clean) return { firstName: '', lastName: '' }
  const parts = clean.split(/\s+/).filter(Boolean)
  if (parts.length <= 1) return { firstName: clean, lastName: '' }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' ')
  }
}

function buildCardPaymentPayer(row, metadata, input = {}) {
  const payerInput = input && typeof input === 'object' ? input : {}
  const email = cleanString(payerInput.email || row.contact_email || metadata.contactEmail).toLowerCase()
  if (!email) {
    const error = new Error('El correo del pagador es requerido para Mercado Pago.')
    error.status = 400
    throw error
  }

  const fallbackName = splitPayerName(row.contact_name || metadata.contactName)
  const firstName = cleanString(payerInput.firstName || payerInput.first_name || fallbackName.firstName)
  const lastName = cleanString(payerInput.lastName || payerInput.last_name || fallbackName.lastName)
  const identificationInput = payerInput.identification && typeof payerInput.identification === 'object'
    ? payerInput.identification
    : {}
  const identificationType = cleanString(
    identificationInput.type ||
    identificationInput.identificationType ||
    payerInput.identificationType ||
    payerInput.identification_type
  )
  const identificationNumber = cleanString(
    identificationInput.number ||
    identificationInput.identificationNumber ||
    payerInput.identificationNumber ||
    payerInput.identification_number
  )

  return {
    email,
    ...(firstName ? { first_name: firstName } : {}),
    ...(lastName ? { last_name: lastName } : {}),
    ...(identificationType && identificationNumber
      ? { identification: { type: identificationType, number: identificationNumber } }
      : {})
  }
}

function buildCardPaymentPayload(row, input = {}, { baseUrl = '' } = {}) {
  const metadata = parseJson(row.metadata_json, {})
  const token = cleanString(input.token)
  const paymentMethodId = cleanString(input.paymentMethodId || input.payment_method_id)
  const issuerId = cleanString(input.issuerId || input.issuer_id)
  const amount = Number(row.amount)

  if (!token) {
    const error = new Error('Mercado Pago no devolvió el token de la tarjeta.')
    error.status = 400
    throw error
  }

  if (!paymentMethodId) {
    const error = new Error('Mercado Pago no devolvió el método de pago.')
    error.status = 400
    throw error
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error('El monto del pago no es válido.')
    error.status = 400
    throw error
  }

  const cleanBaseUrl = cleanString(baseUrl).replace(/\/+$/, '')
  const notificationUrl = cleanBaseUrl ? `${cleanBaseUrl}${MERCADOPAGO_WEBHOOK_PATH}` : ''
  const description = cleanString(row.description || row.title || 'Pago Ristak').slice(0, 255)
  const installmentOptions = normalizeMercadoPagoInstallmentOptions(metadata.mercadoPagoInstallments, { emptyAsNull: true })
  const requestedInstallments = normalizeInstallments(input.installments)

  // MSI OFF (sin opciones MSI persistidas en la fila) => se cobra SIEMPRE de contado,
  // aunque el Brick o un request forjado manden meses. Este es el candado REAL del bug de
  // "meses cuando no los pedimos": no depende del comportamiento del Brick en el front.
  // MSI ON => se rechaza pedir MÁS de N cuotas (manipulación) y se clampa por seguridad.
  const maxAllowedInstallments = installmentOptions ? installmentOptions.maxInstallments : 1
  if (installmentOptions && requestedInstallments > maxAllowedInstallments) {
    const error = new Error(`Este link permite máximo ${maxAllowedInstallments} ${maxAllowedInstallments === 1 ? 'cuota' : 'cuotas'} en Mercado Pago.`)
    error.status = 400
    throw error
  }
  const finalInstallments = Math.min(requestedInstallments, maxAllowedInstallments)

  return {
    transaction_amount: Math.round(amount * 100) / 100,
    token,
    description,
    installments: finalInstallments,
    payment_method_id: paymentMethodId,
    ...(issuerId ? { issuer_id: issuerId } : {}),
    payer: buildCardPaymentPayer(row, metadata, input.payer),
    external_reference: row.id,
    notification_url: notificationUrl || undefined,
    metadata: {
      ristak_payment_id: row.id,
      public_payment_id: row.public_payment_id,
      source: metadata.source || 'ristak_card_brick',
      ...(metadata.paymentPlan ? { payment_plan: metadata.paymentPlan } : {})
    }
  }
}

async function createPreferenceForPayment(row, { baseUrl = '' } = {}) {
  const rowConfig = await getMercadoPagoClientConfig(row.payment_mode || '')
  const { payload, config } = await mercadoPagoApiRequest('/checkout/preferences', {
    method: 'POST',
    idempotencyKey: `ristak-mp-pref-${row.id}`,
    body: buildPreferencePayload(row, { baseUrl }),
    config: rowConfig
  })

  const checkoutUrl = config.mode === 'test'
    ? cleanString(payload.sandbox_init_point || payload.init_point)
    : cleanString(payload.init_point || payload.sandbox_init_point)
  const publicPaymentUrl = buildPaymentUrl(baseUrl, row.public_payment_id) || (isMercadoPagoCheckoutUrl(row.payment_url) ? '' : row.payment_url)

  await db.run(
    `UPDATE payments
     SET payment_url = COALESCE(?, payment_url),
         mercadopago_preference_id = COALESCE(?, mercadopago_preference_id),
         metadata_json = ?,
         status = CASE WHEN status = 'scheduled' THEN 'sent' ELSE status END,
         sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      publicPaymentUrl || null,
      cleanString(payload.id) || null,
      withMercadoPagoCheckoutMetadata(row, payload, config, checkoutUrl),
      row.id
    ]
  )

  await syncMercadoPagoInstallmentPreference({
    paymentId: row.id,
    preferenceId: cleanString(payload.id),
    notes: 'Link de Mercado Pago generado para la parcialidad.'
  })

  return {
    preferenceId: cleanString(payload.id),
    paymentUrl: publicPaymentUrl || row.payment_url || checkoutUrl,
    checkoutUrl,
    raw: payload
  }
}

/**
 * Expira una preferencia creada en sandbox. El payment_mode de la fila es la
 * autoridad: jamás usa la conexión activa ni acepta una fila live.
 */
export async function expireMercadoPagoTestPreference(payment, { now = new Date().toISOString() } = {}) {
  const row = typeof payment === 'string'
    ? await findPaymentById(cleanString(payment))
    : payment
  if (!row?.id || cleanString(row.payment_provider).toLowerCase() !== 'mercadopago') {
    return { expired: false, reason: 'payment_not_found' }
  }
  if (normalizeMode(row.payment_mode) !== 'test') {
    const error = new Error('Se bloqueó la expiración porque el pago no está en modo test.')
    error.status = 409
    throw error
  }
  const preferenceId = cleanString(row.mercadopago_preference_id)
  if (!preferenceId) return { expired: false, reason: 'preference_missing' }

  const expirationDate = timestampToIso(now) || new Date().toISOString()
  const expirationDateMs = Date.parse(expirationDate)
  const expirationFrom = new Date(Math.min(Date.now(), expirationDateMs - 1000)).toISOString()
  const config = await getMercadoPagoClientConfig('test')
  await mercadoPagoApiRequest(`/checkout/preferences/${encodeURIComponent(preferenceId)}`, {
    method: 'PUT',
    config,
    body: {
      expires: true,
      expiration_date_from: expirationFrom,
      expiration_date_to: expirationDate
    }
  })
  return { expired: true, preferenceId, paymentId: row.id, paymentMode: 'test' }
}

async function syncMercadoPagoInstallmentPreference({ paymentId, preferenceId = '', notes = '' } = {}) {
  const cleanPaymentId = cleanString(paymentId)
  if (!cleanPaymentId) return

  const installments = await db.all(
    'SELECT id, flow_id FROM installment_payments WHERE payment_id = ?',
    [cleanPaymentId]
  )
  if (!installments.length) return

  await db.run(
    `UPDATE installment_payments
     SET status = CASE
           WHEN LOWER(COALESCE(status, '')) IN ('scheduled', 'pending') THEN 'sent'
           ELSE status
         END,
         mercadopago_preference_id = COALESCE(NULLIF(?, ''), mercadopago_preference_id),
         notes = COALESCE(NULLIF(?, ''), notes),
         updated_at = CURRENT_TIMESTAMP
     WHERE payment_id = ?`,
    [cleanString(preferenceId), cleanString(notes), cleanPaymentId]
  )

  const touchedFlowIds = new Set(installments.map(row => row.flow_id).filter(Boolean))
  for (const flowId of touchedFlowIds) {
    await persistMercadoPagoPaymentPlanMirror(flowId)
  }
}

async function insertPaymentRow({
  contact = {},
  amount,
  currency,
  status = 'sent',
  paymentMethod = 'mercadopago_checkout',
  title = 'Pago',
  description = 'Pago',
  dueDate = null,
  metadata = {},
  createPreference = true,
  baseUrl = '',
  mode = '',
  paymentLinkRequestKey = ''
} = {}) {
  const config = await getMercadoPagoClientConfig(mode)
  const publicPaymentId = createPublicId()
  const id = createId('mp_payment')
  const now = new Date().toISOString()
  const paymentUrl = buildPaymentUrl(baseUrl, publicPaymentId)
  const conversationalTestEffectId = cleanString(metadata?.source) === 'conversational_agent_test'
    ? cleanString(metadata?.conversationalAgentTest?.testEffectId) || null
    : null

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, reference, title, description, date, due_date, sent_at,
      public_payment_id, payment_url, payment_link_request_key, conversational_test_effect_id,
      metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      id,
      cleanString(contact.id) || null,
      normalizePositiveAmount(amount),
      normalizeCurrency(currency || config.defaultCurrency),
      status,
      paymentMethod,
      config.mode,
      'mercadopago',
      publicPaymentId,
      cleanString(title) || 'Pago',
      cleanString(description) || cleanString(title) || 'Pago',
      now,
      dueDate || null,
      status === 'scheduled' ? null : now,
      publicPaymentId,
      createPreference ? paymentUrl : '',
      cleanString(paymentLinkRequestKey, 180) || null,
      conversationalTestEffectId,
      JSON.stringify(metadata)
    ]
  )

  let row = await findPaymentById(id)
  let preference = null
  if (createPreference) {
    preference = await createPreferenceForPayment(row, { baseUrl })
    row = await findPaymentById(id)
  }

  return {
    payment: row,
    preference,
    publicPaymentId,
    paymentUrl: paymentUrl || row.payment_url || preference?.paymentUrl || ''
  }
}

export async function createMercadoPagoPaymentLink(input = {}, { baseUrl, mode = '' } = {}) {
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
  const currency = normalizeCurrency(input.currency || await getConfiguredCurrency())
  const contact = {
    id: cleanString(input.contactId),
    name: cleanString(input.contactName),
    email: cleanString(input.email),
    phone: cleanString(input.phone)
  }
  const mercadoPagoInstallments = normalizeMercadoPagoInstallmentOptions(input.installments || input.mercadoPagoInstallments, { emptyAsNull: true })
  const metadata = {
    contactName: contact.name,
    contactEmail: contact.email,
    contactPhone: contact.phone,
    source: cleanString(input.source || 'ristak'),
    lineItems: Array.isArray(input.lineItems) ? input.lineItems : [],
    ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
    ...(mercadoPagoInstallments ? { mercadoPagoInstallments } : {}),
    ...(tax ? { tax } : {})
  }

  const result = await insertPaymentRow({
    contact,
    amount: chargeAmount,
    currency,
    status: 'sent',
    title: cleanString(input.title) || 'Pago',
    description: cleanString(input.description) || cleanString(input.title) || 'Pago',
    dueDate: input.dueDate || null,
    metadata,
    createPreference: true,
    baseUrl,
    mode,
    paymentLinkRequestKey: input.paymentLinkRequestKey
  })

  const config = await getMercadoPagoPaymentConfig({ mode })
  return {
    payment: mapPublicPayment(await findPaymentById(result.payment.id), config, baseUrl, paymentSettings),
    paymentUrl: result.paymentUrl,
    publicPaymentId: result.publicPaymentId,
    preferenceId: result.preference?.preferenceId || ''
  }
}

export async function getPublicMercadoPagoPayment(publicPaymentId, { baseUrl } = {}) {
  const row = await findPaymentByPublicId(publicPaymentId)
  if (!row || row.payment_provider !== 'mercadopago') return null
  const config = await getMercadoPagoPaymentConfig({ mode: row.payment_mode || '' })

  const paymentSettings = await getPublicPaymentSettings()
  const timezone = await getAccountTimezone().catch(() => ACCOUNT_DEFAULT_TIMEZONE)
  return attachMetaPublicPurchaseEvent(
    mapPublicPayment(row, config, baseUrl, paymentSettings, timezone),
    row
  )
}

export async function ensurePublicMercadoPagoPreference(publicPaymentId, { baseUrl } = {}) {
  const row = await findPaymentByPublicId(publicPaymentId)
  if (!row || row.payment_provider !== 'mercadopago') {
    const error = new Error('Pago no encontrado.')
    error.status = 404
    throw error
  }
  if (['paid', 'refunded', 'void', 'deleted'].includes(cleanString(row.status).toLowerCase())) {
    const error = new Error('Este pago ya no acepta nuevos cobros.')
    error.status = 409
    throw error
  }

  if (row.payment_url && row.mercadopago_preference_id) {
    const storedCheckout = getStoredMercadoPagoCheckout(row)
    if (!storedCheckout.checkoutUrl && !isMercadoPagoCheckoutUrl(row.payment_url)) {
      const preference = await createPreferenceForPayment(row, { baseUrl })
      return {
        paymentUrl: preference.checkoutUrl || preference.paymentUrl,
        checkoutUrl: preference.checkoutUrl || '',
        preferenceId: preference.preferenceId
      }
    }

    await syncMercadoPagoInstallmentPreference({
      paymentId: row.id,
      preferenceId: row.mercadopago_preference_id,
      notes: 'Link de Mercado Pago disponible para la parcialidad.'
    })

    return {
      paymentUrl: storedCheckout.checkoutUrl || row.payment_url,
      checkoutUrl: storedCheckout.checkoutUrl || '',
      preferenceId: row.mercadopago_preference_id
    }
  }

  const preference = await createPreferenceForPayment(row, { baseUrl })
  return {
    paymentUrl: preference.checkoutUrl || preference.paymentUrl,
    checkoutUrl: preference.checkoutUrl || '',
    preferenceId: preference.preferenceId
  }
}

export async function createPublicMercadoPagoCardPayment(publicPaymentId, input = {}, { baseUrl } = {}) {
  const row = await findPaymentByPublicId(publicPaymentId)
  if (!row || row.payment_provider !== 'mercadopago') {
    const error = new Error('Pago no encontrado.')
    error.status = 404
    throw error
  }

  if (['paid', 'succeeded', 'completed', 'refunded', 'void', 'deleted'].includes(cleanString(row.status).toLowerCase())) {
    const error = new Error('Este pago ya no acepta nuevos cobros.')
    error.status = 409
    throw error
  }

  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey || input.idempotency_key, row.id)
  const paymentPayload = buildCardPaymentPayload(row, input, { baseUrl })
  const rowConfig = await getMercadoPagoClientConfig(row.payment_mode || '')
  const { payload, config } = await mercadoPagoApiRequest('/v1/payments', {
    method: 'POST',
    idempotencyKey,
    body: paymentPayload,
    config: rowConfig
  })

  const referencedPayload = {
    ...payload,
    external_reference: cleanString(payload?.external_reference) || row.id,
    metadata: {
      ...(payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}),
      ristak_payment_id: row.id,
      public_payment_id: row.public_payment_id
    }
  }
  const updated = await updatePaymentFromMercadoPagoPayment(referencedPayload, { mode: config.mode })
  const refreshed = updated || await findPaymentById(row.id)
  const paymentSettings = await getPublicPaymentSettings()

  return {
    payment: mapPublicPayment(refreshed, config, baseUrl, paymentSettings),
    mercadoPagoPaymentId: cleanString(payload?.id),
    status: cleanString(payload?.status),
    statusDetail: cleanString(payload?.status_detail),
    paymentMethodId: cleanString(payload?.payment_method_id),
    paymentTypeId: cleanString(payload?.payment_type_id)
  }
}

function validatePlanPayload(input = {}, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  const totalAmount = normalizePositiveAmount(input.totalAmount)
  const contact = input.contact || {}
  if (!cleanString(contact.id)) {
    const error = new Error('Selecciona un contacto para el plan de pagos.')
    error.status = 400
    throw error
  }

  const remainingPayments = Array.isArray(input.remainingPayments) ? input.remainingPayments : []
  if (!remainingPayments.length) {
    const error = new Error('Agrega al menos una parcialidad programada.')
    error.status = 400
    throw error
  }

  const firstPaymentEnabled = input.firstPayment?.enabled !== false && Number(input.firstPayment?.amount || 0) > 0
  const firstPaymentMethod = firstPaymentEnabled ? cleanString(input.firstPayment?.method || 'mercadopago') : 'none'
  const firstPaymentDate = firstPaymentEnabled ? normalizeDateOnly(input.firstPayment?.date, timezone) : null

  if (firstPaymentDate && !MANUAL_PLAN_PAYMENT_METHODS.has(firstPaymentMethod)) {
    assertDateNotInPast(firstPaymentDate, 'El primer pago automático no puede programarse en una fecha pasada.', timezone)
  }

  return {
    contact: {
      id: cleanString(contact.id),
      name: cleanString(contact.name),
      email: cleanString(contact.email),
      phone: cleanString(contact.phone)
    },
    totalAmount,
    currency: normalizeCurrency(input.currency || DEFAULT_CURRENCY),
    title: cleanString(input.title || input.description || 'Plan de pago'),
    description: cleanString(input.description || input.title || 'Plan de pago'),
    source: cleanString(input.source || 'ristak'),
    lineItems: Array.isArray(input.lineItems) ? input.lineItems : [],
    remainingFrequency: cleanString(input.remainingFrequency || 'custom'),
    firstPayment: {
      enabled: firstPaymentEnabled,
      amount: normalizePositiveAmount(input.firstPayment?.amount || 0, 0),
      date: firstPaymentDate,
      method: firstPaymentMethod
    },
    remainingPayments: remainingPayments.map((payment, index) => ({
      sequence: Number(payment.sequence || index + 1),
      amount: normalizePositiveAmount(payment.amount),
      percentage: payment.percentage === null || payment.percentage === undefined ? null : Number(payment.percentage),
      dueDate: assertDateNotInPast(payment.dueDate, 'Los pagos futuros automáticos no pueden programarse en fechas pasadas.', timezone),
      frequency: cleanString(payment.frequency || input.remainingFrequency || 'custom')
    }))
  }
}

function addPlanState(history = [], state) {
  return [
    ...history,
    {
      state,
      at: new Date().toISOString()
    }
  ]
}

function getMercadoPagoPlanRecurrenceLabel(value) {
  const frequency = cleanString(value || 'custom')
  if (frequency === 'weekly') return 'Semanal'
  if (frequency === 'biweekly') return 'Quincenal'
  if (frequency === 'monthly') return 'Mensual'
  if (frequency === 'daily') return 'Diaria'
  if (frequency === 'yearly') return 'Anual'
  return 'Personalizada'
}

function getMercadoPagoPlanMirrorStatus(flow = {}) {
  const state = cleanString(flow.current_state).toLowerCase()
  if (state === MP_PLAN_STATES.COMPLETED) return 'completed'
  if (state === MP_PLAN_STATES.DELETED || state === 'deleted') return 'deleted'
  if (state === MP_PLAN_STATES.PAUSED || state === 'paused') return 'paused'
  if (state === MP_PLAN_STATES.CANCELLED || ['cancelled', 'canceled', 'void'].includes(state)) return 'cancelled'
  return 'active'
}

async function persistMercadoPagoPaymentPlanMirror(flowId, extra = {}) {
  const cleanFlowId = cleanString(flowId)
  if (!cleanFlowId) return null

  const flow = await db.get('SELECT * FROM payment_flows WHERE id = ?', [cleanFlowId])
  if (!flow || flow.payment_provider !== 'mercadopago') return null

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
    provider: 'mercadopago',
    flowId: cleanFlowId,
    remainingFrequency: metadata.remainingFrequency || 'custom',
    checkoutProvider: 'mercadopago',
    firstPayment: {
      amount: Number(flow.first_payment_amount || 0),
      date: flow.first_payment_date || null,
      method: flow.first_payment_method || null,
      status: flow.first_payment_status || null,
      paymentId: flow.first_payment_invoice_id || null,
      paymentLink: flow.card_setup_payment_link || null
    },
    installments: visibleInstallments.map((installment) => ({
      id: installment.id,
      sequence: installment.sequence,
      amount: Number(installment.amount || 0),
      percentage: installment.percentage ?? null,
      dueDate: installment.due_date || null,
      status: installment.status || null,
      paymentId: installment.payment_id || null,
      paymentMethod: installment.payment_method || null,
      preferenceId: installment.mercadopago_preference_id || null
    }))
  }
  const rawJson = {
    id: cleanFlowId,
    provider: 'mercadopago',
    paymentFlow: {
      id: cleanFlowId,
      state: flow.current_state,
      contactId: flow.contact_id,
      mercadoPagoUserId: flow.mercadopago_user_id || null
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
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'mercadopago', CURRENT_TIMESTAMP, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
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
      source = 'mercadopago',
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
      getMercadoPagoPlanMirrorStatus(flow),
      Number(flow.total_amount || 0),
      flow.currency || DEFAULT_CURRENCY,
      flow.concept || 'Plan de pagos',
      getMercadoPagoPlanRecurrenceLabel(metadata.remainingFrequency),
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

function isOfflinePaymentMethod(method) {
  return ['cash', 'bank_transfer', 'transfer', 'deposit', 'manual', 'offline', 'check', 'other'].includes(cleanString(method))
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

function normalizeManualPaymentMethod(method) {
  const normalized = cleanString(method).toLowerCase()
  if (normalized === 'transfer') return 'bank_transfer'
  if (normalized === 'offline') return 'other'
  return normalized
}

function normalizeMercadoPagoPlanPaymentMethod(value) {
  const method = cleanString(value).toLowerCase()
  if (MERCADOPAGO_CHECKOUT_METHODS.has(method)) {
    return {
      automatic: 1,
      installmentMethod: 'mercadopago_checkout',
      paymentMethod: 'mercadopago_checkout',
      status: 'scheduled',
      notes: 'Mercado Pago generará el link cuando llegue la fecha programada.'
    }
  }

  if (!MANUAL_PLAN_PAYMENT_METHODS.has(method)) {
    const error = new Error('Forma de cobro inválida para la parcialidad.')
    error.status = 400
    throw error
  }

  const manualMethod = normalizeManualPaymentMethod(method)
  return {
    automatic: 0,
    installmentMethod: manualMethod,
    paymentMethod: manualMethod,
    status: 'pending',
    notes: 'Pago manual dentro del plan.'
  }
}

function normalizeMercadoPagoFirstPaymentMethod(value) {
  const method = cleanString(value).toLowerCase()
  if (MERCADOPAGO_CHECKOUT_METHODS.has(method)) {
    return {
      flowMethod: 'payment_link',
      paymentMethod: 'mercadopago_checkout',
      flowStatus: 'pending',
      createPreference: true
    }
  }

  if (!MANUAL_PLAN_PAYMENT_METHODS.has(method)) {
    const error = new Error('Forma de cobro inválida para el primer pago.')
    error.status = 400
    throw error
  }

  const manualMethod = normalizeManualPaymentMethod(method)
  return {
    flowMethod: manualMethod,
    paymentMethod: manualMethod,
    flowStatus: 'pending',
    createPreference: false
  }
}

function isMercadoPagoInstallmentLocked(installment = {}) {
  const status = cleanString(installment.status || installment.payment_status).toLowerCase()
  return LOCKED_PLAN_PAYMENT_STATUSES.has(status) || Boolean(cleanString(installment.mercadopago_preference_id))
}

function buildPlanInstallmentPaymentMetadata(flow, installment, sequence, paymentMode, source = 'mercadopago_payment_plan_installment') {
  return {
    mercadoPagoMode: paymentMode || 'test',
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

export async function updateMercadoPagoPaymentPlanSchedule(flowId, input = {}, options = {}) {
  const cleanFlowId = cleanString(flowId)
  await assertPlanCanChangeState(cleanFlowId)
  const result = await withPaymentPlanEditState(cleanFlowId, 'mercadopago', () => (
    updateMercadoPagoPaymentPlanScheduleLocked(cleanFlowId, input, options)
  ))
  await persistMercadoPagoPaymentPlanMirror(cleanFlowId, {
    localAction: 'update_schedule',
    actionedAt: new Date().toISOString()
  })
  return result
}

async function updateMercadoPagoPaymentPlanScheduleLocked(flowId, input = {}, { baseUrl = '' } = {}) {
  const cleanFlowId = cleanString(flowId)
  if (!cleanFlowId) {
    const error = new Error('Plan Mercado Pago requerido.')
    error.status = 400
    throw error
  }

  const flow = await db.get('SELECT * FROM payment_flows WHERE id = ?', [cleanFlowId])
  if (!flow || flow.payment_provider !== 'mercadopago') {
    const error = new Error('Plan Mercado Pago no encontrado.')
    error.status = 404
    throw error
  }

  const metadata = parseJson(flow.metadata, {})
  const accountTimezone = await getAccountTimezone()
  const nextConcept = cleanString(input.name || input.title || input.description || input.concept || flow.concept || 'Plan de pagos')
  const nextFrequency = cleanString(input.remainingFrequency || input.frequency || metadata.remainingFrequency || 'custom') || 'custom'
  const submittedInstallments = Array.isArray(input.installments)
    ? input.installments
    : Array.isArray(input.remainingPayments)
      ? input.remainingPayments
      : []
  const hasFirstPaymentInput = Object.prototype.hasOwnProperty.call(input, 'firstPayment')
  const firstPayment = hasFirstPaymentInput && input.firstPayment && typeof input.firstPayment === 'object' ? input.firstPayment : null
  let firstPaymentLink = flow.card_setup_payment_link || null
  const firstPaymentStatus = cleanString(flow.first_payment_status).toLowerCase()
  const firstPaymentRow = flow.first_payment_invoice_id
    ? await db.get('SELECT * FROM payments WHERE id = ?', [flow.first_payment_invoice_id])
    : null
  const firstPaymentLocked = LOCKED_PLAN_PAYMENT_STATUSES.has(firstPaymentStatus)
    || Boolean(cleanString(firstPaymentRow?.mercadopago_preference_id))
  const existingFirstPaymentForNumbering = Number(flow.first_payment_amount || 0) > 0 && firstPaymentStatus !== 'not_required'
  const submittedFirstPaymentForNumbering = Boolean(firstPayment && firstPayment.remove !== true && Number(firstPayment.amount || 0) > 0)
  const hasFirstPaymentForNumbering = firstPaymentLocked
    ? existingFirstPaymentForNumbering
    : hasFirstPaymentInput
      ? submittedFirstPaymentForNumbering
      : existingFirstPaymentForNumbering

  const existingInstallments = await db.all(
    `SELECT i.*, p.status AS payment_status, p.payment_mode, p.mercadopago_preference_id, p.payment_url
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
  const lockedUnsubmittedInstallmentCount = (existingInstallments || []).filter((installment) => (
    !submittedExistingIdValues.has(installment.id) && isMercadoPagoInstallmentLocked(installment)
  )).length
  const planPaymentTotalForNumbering = getPlanPaymentTotal(
    hasFirstPaymentForNumbering,
    submittedInstallments.length + lockedUnsubmittedInstallmentCount
  )
  const submittedExistingIds = new Set()
  let nextSequence = 1
  let remainingTotal = 0

  for (const submitted of submittedInstallments) {
    const existingId = cleanString(submitted.id)
    const existing = existingId ? existingById.get(existingId) : null

    if (existing?.id) submittedExistingIds.add(existing.id)

    if (isMercadoPagoInstallmentLocked(existing)) {
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

    const dueDate = normalizeDateOnly(submitted.dueDate || submitted.date || submitted.scheduledAt, accountTimezone)
    if (!dueDate) {
      const error = new Error('Cada parcialidad futura necesita fecha de cobro.')
      error.status = 400
      throw error
    }

    const method = normalizeMercadoPagoPlanPaymentMethod(submitted.paymentMethod || submitted.method)
    if (method.automatic) {
      assertDateNotInPast(dueDate, 'Las parcialidades automáticas no pueden programarse en fechas pasadas.', accountTimezone)
    }

    const installmentId = existing?.id || createId('mp_installment')
    const paymentId = existing?.payment_id || createId('mp_plan_payment')
    const paymentMode = existing?.payment_mode || metadata.mercadoPagoMode || metadata.paymentMode || 'test'
    const title = buildPlanInstallmentPaymentTitle(nextConcept, nextSequence, hasFirstPaymentForNumbering, planPaymentTotalForNumbering)

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
          method.status,
          paymentId,
          method.notes,
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
          method.status,
          paymentId,
          method.notes
        ]
      )
    }

    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        payment_provider, title, description, date, due_date, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'mercadopago', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
        payment_provider = 'mercadopago',
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
        method.status,
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

    if (isMercadoPagoInstallmentLocked(existing)) {
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
      firstPaymentLink = null
      firstPaymentPaymentIdForLabel = null

      await db.run(
        `UPDATE payment_flows
         SET first_payment_amount = 0,
             first_payment_value = 0,
             first_payment_date = NULL,
             first_payment_method = NULL,
             first_payment_status = NULL,
             first_payment_invoice_id = NULL,
             card_setup_payment_link = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
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
      const firstPaymentMethodInput = cleanString(firstPayment.method || firstPayment.paymentMethod || firstPaymentMethod || 'mercadopago').toLowerCase()
      const normalizedFirstPaymentMethod = normalizeMercadoPagoFirstPaymentMethod(
        firstPaymentMethodInput
      )
      if (MERCADOPAGO_CHECKOUT_METHODS.has(firstPaymentMethodInput)) {
        assertDateNotInPast(firstPaymentDate, 'El primer pago automático no puede programarse en una fecha pasada.', accountTimezone)
      }

      firstPaymentMethod = normalizedFirstPaymentMethod.flowMethod
      let firstPaymentPaymentId = flow.first_payment_invoice_id || null
      let firstPaymentStatusNext = firstPaymentStatus && firstPaymentStatus !== 'not_required'
        ? firstPaymentStatus
        : normalizedFirstPaymentMethod.flowStatus
      const firstPaymentTitle = buildPlanFirstPaymentTitle(nextConcept, planPaymentTotalForNumbering)

      if (!firstPaymentPaymentId) {
        const created = await insertPaymentRow({
          contact: {
            id: flow.contact_id,
            name: flow.contact_name,
            email: flow.contact_email,
            phone: flow.contact_phone
          },
          amount: firstPaymentAmount,
          currency: flow.currency || DEFAULT_CURRENCY,
          status: normalizedFirstPaymentMethod.createPreference ? 'sent' : firstPaymentStatusNext,
          paymentMethod: normalizedFirstPaymentMethod.paymentMethod,
          title: firstPaymentTitle,
          description: firstPaymentTitle,
          dueDate: firstPaymentDate,
          metadata: {
            mercadoPagoMode: metadata.mercadoPagoMode || metadata.paymentMode || 'test',
            source: normalizedFirstPaymentMethod.createPreference ? 'mercadopago_payment_plan_first_link' : 'mercadopago_payment_plan_first_manual',
            contactName: flow.contact_name,
            contactEmail: flow.contact_email,
            contactPhone: flow.contact_phone,
            paymentPlan: {
              flowId: cleanFlowId,
              trigger: normalizedFirstPaymentMethod.createPreference ? 'first_payment' : 'first_payment_manual'
            }
          },
          createPreference: normalizedFirstPaymentMethod.createPreference,
          baseUrl
        })
        firstPaymentPaymentId = created.payment?.id || null
        firstPaymentLink = created.paymentUrl || null
        firstPaymentStatusNext = normalizedFirstPaymentMethod.createPreference ? 'pending' : firstPaymentStatusNext
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
             card_setup_payment_link = COALESCE(?, card_setup_payment_link),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          firstPaymentAmount,
          firstPaymentAmount,
          firstPaymentDate,
          firstPaymentMethod,
          firstPaymentStatusNext,
          firstPaymentPaymentId,
          firstPaymentLink,
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
            normalizedFirstPaymentMethod.createPreference ? 'sent' : firstPaymentStatusNext,
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

  return persistMercadoPagoPaymentPlanMirror(cleanFlowId, {
    localAction: 'update_schedule',
    actionedAt: new Date().toISOString()
  })
}

export async function applyMercadoPagoPaymentPlanAction(flowId, action) {
  const cleanFlowId = cleanString(flowId)
  const normalizedAction = cleanString(action).toLowerCase()
  if (!cleanFlowId) {
    const error = new Error('Plan Mercado Pago requerido.')
    error.status = 400
    throw error
  }

  const flow = await db.get('SELECT * FROM payment_flows WHERE id = ?', [cleanFlowId])
  if (!flow || flow.payment_provider !== 'mercadopago') {
    const error = new Error('Plan Mercado Pago no encontrado.')
    error.status = 404
    throw error
  }

  const now = new Date().toISOString()
  const stateHistory = (nextState) => addPlanState(flow.state_history, nextState)

  if (['activate', 'pause', 'cancel', 'delete'].includes(normalizedAction)) {
    await assertPlanCanChangeState(cleanFlowId, { activating: normalizedAction === 'activate' })
  }

  if (normalizedAction === 'activate') {
    const activationResult = await db.run(
      `UPDATE payment_flows
       SET current_state = ?,
           installment_plan_created_at = COALESCE(installment_plan_created_at, ?),
           installment_plan_active_at = COALESCE(installment_plan_active_at, ?),
           state_history = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM installment_payments i WHERE i.flow_id = payment_flows.id AND i.status = 'processing')`,
      [
        MP_PLAN_STATES.ACTIVE,
        now,
        now,
        JSON.stringify(stateHistory(MP_PLAN_STATES.ACTIVE)),
        cleanFlowId
      ]
    )
    if (Number(activationResult?.changes || 0) !== 1) {
      const error = new Error('La generación de un enlace comenzó justo antes de activar. Espera a que termine y vuelve a intentarlo.')
      error.status = 409
      throw error
    }

    return persistMercadoPagoPaymentPlanMirror(cleanFlowId, { localAction: normalizedAction, actionedAt: now })
  }

  if (normalizedAction === 'pause') {
    const pauseResult = await db.run(
      `UPDATE payment_flows
       SET current_state = ?,
           state_history = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM installment_payments i WHERE i.flow_id = payment_flows.id AND i.status = 'processing')`,
      [
        MP_PLAN_STATES.PAUSED,
        JSON.stringify(stateHistory(MP_PLAN_STATES.PAUSED)),
        cleanFlowId
      ]
    )
    if (Number(pauseResult?.changes || 0) !== 1) {
      const error = new Error('La generación de un enlace comenzó justo antes de pausar. Espera a que termine y vuelve a intentarlo.')
      error.status = 409
      throw error
    }

    return persistMercadoPagoPaymentPlanMirror(cleanFlowId, { localAction: normalizedAction, actionedAt: now })
  }

  if (!['cancel', 'delete'].includes(normalizedAction)) {
    const error = new Error('Acción inválida para plan Mercado Pago.')
    error.status = 400
    throw error
  }

  if (normalizedAction === 'delete') {
    const audit = await getPaymentPlanAuditSummary(cleanFlowId)
    if (audit.isTestMode || (audit.isDeletedRecord && !audit.hasLedgerActivity)) {
      await hardDeleteTestPaymentPlan(cleanFlowId)
      return {
        id: cleanFlowId,
        status: MP_PLAN_STATES.DELETED,
        source: 'mercadopago',
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
    ? MP_PLAN_STATES.DELETED
    : MP_PLAN_STATES.CANCELLED
  const finalPaymentStatus = normalizedAction === 'delete' ? 'deleted' : 'void'
  const finalInstallmentStatus = normalizedAction === 'delete' ? 'deleted' : 'cancelled'

  const closeResult = await db.run(
    `UPDATE payment_flows
     SET current_state = ?,
         state_history = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND NOT EXISTS (SELECT 1 FROM installment_payments i WHERE i.flow_id = payment_flows.id AND i.status = 'processing')`,
    [
      finalState,
      JSON.stringify(stateHistory(finalState)),
      cleanFlowId
    ]
  )
  if (Number(closeResult?.changes || 0) !== 1) {
    const error = new Error('La generación de un enlace comenzó justo antes de cerrar el plan. Espera a que termine y vuelve a intentarlo.')
    error.status = 409
    throw error
  }

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
     )
       AND LOWER(COALESCE(status, 'pending')) NOT IN ('paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'refunded', 'void', 'deleted')`,
    [finalPaymentStatus, cleanFlowId, cleanFlowId]
  )

  const mirrored = await persistMercadoPagoPaymentPlanMirror(cleanFlowId, {
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

export async function createMercadoPagoPaymentPlan(input = {}, { baseUrl } = {}) {
  const error = new Error('Mercado Pago no está disponible para planes de pago en Ristak. Usa Stripe o Conekta para parcialidades; Mercado Pago queda disponible para links de pago y suscripciones.')
  error.status = 422
  throw error

  const config = await getMercadoPagoClientConfig()
  const accountTimezone = await getAccountTimezone()
  const plan = validatePlanPayload({ ...input, currency: input.currency || await getConfiguredCurrency() }, accountTimezone)
  const flowId = createId('mp_flow')
  const now = new Date().toISOString()
  const firstPaymentIsOffline = plan.firstPayment.enabled && isOfflinePaymentMethod(plan.firstPayment.method)

  await db.run(
    `INSERT INTO payment_flows (
      id, contact_id, contact_name, contact_email, contact_phone,
      total_amount, currency, concept, payment_type,
      first_payment_amount, first_payment_type, first_payment_value,
      first_payment_date, first_payment_method, first_payment_status,
      remaining_automatic, card_setup_required, card_setup_amount,
      payment_provider, mercadopago_user_id, current_state, state_history,
      installment_plan_created_at, installment_plan_active_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'partial', ?, ?, ?, ?, ?, ?, 1, 0, 0, 'mercadopago', ?, ?, ?, ?, ?, ?)`,
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
      plan.firstPayment.enabled ? (firstPaymentIsOffline ? 'registered' : 'pending') : 'not_required',
      config.userId || null,
      MP_PLAN_STATES.ACTIVE,
      JSON.stringify(addPlanState([], MP_PLAN_STATES.ACTIVE)),
      now,
      now,
      JSON.stringify({
        source: plan.source,
        remainingFrequency: plan.remainingFrequency,
        lineItems: plan.lineItems,
        checkoutProvider: 'mercadopago'
      })
    ]
  )

  const response = {
    flowId,
    currentState: MP_PLAN_STATES.ACTIVE,
    paymentMode: config.mode,
    firstPaymentLink: null,
    firstPaymentPaymentId: null,
    scheduledPayments: []
  }
  const planPaymentTotal = getPlanPaymentTotal(plan.firstPayment.enabled, plan.remainingPayments.length)
  const firstPaymentTitle = buildPlanFirstPaymentTitle(plan.title, planPaymentTotal)
  const firstPaymentDescription = buildPlanFirstPaymentTitle(plan.description, planPaymentTotal)

  if (plan.firstPayment.enabled) {
    if (firstPaymentIsOffline) {
      const first = await insertPaymentRow({
        contact: plan.contact,
        amount: plan.firstPayment.amount,
        currency: plan.currency,
        status: 'paid',
        paymentMethod: plan.firstPayment.method,
        title: firstPaymentTitle,
        description: firstPaymentDescription,
        dueDate: plan.firstPayment.date,
        metadata: {
          source: 'mercadopago_payment_plan_first_offline',
          contactName: plan.contact.name,
          contactEmail: plan.contact.email,
          contactPhone: plan.contact.phone,
          paymentPlan: { flowId, trigger: 'first_payment_offline' }
        },
        createPreference: false,
        baseUrl
      })
      await db.run(
        `UPDATE payment_flows
         SET first_payment_invoice_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [first.payment.id, flowId]
      )
      response.firstPaymentPaymentId = first.payment.id
      updateSingleContactStats(plan.contact.id).catch((error) => {
        logger.warn(`No se pudieron actualizar stats del contacto por primer pago Mercado Pago ${first.payment.id}: ${error.message}`)
      })
    } else {
      const first = await createMercadoPagoPaymentLink({
        contactId: plan.contact.id,
        contactName: plan.contact.name,
        email: plan.contact.email,
        phone: plan.contact.phone,
        amount: plan.firstPayment.amount,
        currency: plan.currency,
        title: firstPaymentTitle,
        description: firstPaymentDescription,
        dueDate: plan.firstPayment.date,
        source: 'mercadopago_payment_plan_first_link',
        lineItems: plan.lineItems,
        metadata: {
          paymentPlan: { flowId, trigger: 'first_payment' }
        }
      }, { baseUrl })
      await db.run(
        `UPDATE payment_flows
         SET first_payment_invoice_id = ?,
             card_setup_payment_link = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [first.payment?.id || null, first.paymentUrl, flowId]
      )
      response.firstPaymentPaymentId = first.payment?.id || null
      response.firstPaymentLink = first.paymentUrl
    }
  }

  for (const payment of plan.remainingPayments) {
    const installmentId = createId('mp_installment')
    const scheduled = await insertPaymentRow({
      contact: plan.contact,
      amount: payment.amount,
      currency: plan.currency,
      status: 'scheduled',
      paymentMethod: 'mercadopago_checkout',
      title: buildPlanInstallmentPaymentTitle(plan.title, payment.sequence, plan.firstPayment.enabled, planPaymentTotal),
      description: buildPlanInstallmentPaymentTitle(plan.description, payment.sequence, plan.firstPayment.enabled, planPaymentTotal),
      dueDate: payment.dueDate,
      metadata: {
        mercadoPagoMode: config.mode,
        source: 'mercadopago_payment_plan_installment',
        contactName: plan.contact.name,
        contactEmail: plan.contact.email,
        contactPhone: plan.contact.phone,
        paymentPlan: {
          flowId,
          installmentId,
          sequence: payment.sequence,
          trigger: 'scheduled_installment'
        }
      },
      createPreference: false,
      baseUrl
    })

    await db.run(
      `INSERT INTO installment_payments (
        id, flow_id, sequence, amount, percentage, due_date, frequency,
        payment_method, automatic, status, payment_id, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'mercadopago_checkout', 1, 'scheduled', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        installmentId,
        flowId,
        payment.sequence,
        payment.amount,
        payment.percentage,
        payment.dueDate,
        payment.frequency,
        scheduled.payment.id,
        'Mercado Pago generará el link cuando llegue la fecha programada.'
      ]
    )

    response.scheduledPayments.push({
      installmentId,
      paymentId: scheduled.payment.id,
      sequence: payment.sequence,
      amount: payment.amount,
      currency: plan.currency,
      dueDate: payment.dueDate,
      status: 'scheduled'
    })
  }

  await persistMercadoPagoPaymentPlanMirror(flowId, {
    response
  })

  return response
}

export async function processDueMercadoPagoPaymentPlanCharges({ limit = 25, baseUrl = '', isLeaseValid = () => true } = {}) {
  await markOverduePaymentPlanChargesForReview('mercadopago')
  await getMercadoPagoClientConfig()
  const accountTimezone = await getAccountTimezone()
  const dueDate = todayDateOnly(accountTimezone)
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 25, 100))
  const resolvedBaseUrl = cleanString(baseUrl) || getConfiguredBaseUrl()
  const dueDateSql = dateOnlySql('i.due_date')
  const dueDateParam = dateOnlyPlaceholder()
  const rows = await db.all(
    `SELECT
       i.id AS installment_id,
       i.payment_id,
       i.due_date,
       f.id AS flow_id,
       p.status AS payment_status,
       p.payment_url,
       p.mercadopago_preference_id
     FROM installment_payments i
     JOIN payment_flows f ON f.id = i.flow_id
     JOIN payments p ON p.id = i.payment_id
     WHERE f.payment_provider = 'mercadopago'
       AND f.current_state = ?
       AND i.automatic = 1
       AND i.status IN ('scheduled', 'pending')
       AND p.status IN ('scheduled', 'pending')
       AND (p.mercadopago_preference_id IS NULL OR p.mercadopago_preference_id = '')
       AND ${dueDateSql} = ${dueDateParam}
     ORDER BY i.due_date ASC, i.sequence ASC
     LIMIT ?`,
    [MP_PLAN_STATES.ACTIVE, dueDate, normalizedLimit]
  )

  const results = []
  const touchedFlowIds = new Set()
  for (const row of rows || []) {
    if (!isLeaseValid()) break
    touchedFlowIds.add(row.flow_id)
    try {
      const claim = await db.run(
        `UPDATE installment_payments
         SET status = 'processing', updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status IN ('scheduled', 'pending')
           AND EXISTS (
             SELECT 1 FROM payment_flows f
             WHERE f.id = installment_payments.flow_id AND f.current_state = ?
           )
           AND EXISTS (
             SELECT 1 FROM payments p
             WHERE p.id = installment_payments.payment_id
               AND p.status IN ('scheduled', 'pending')
               AND (p.mercadopago_preference_id IS NULL OR p.mercadopago_preference_id = '')
           )`,
        [row.installment_id, MP_PLAN_STATES.ACTIVE]
      )
      if (Number(claim?.changes || 0) !== 1) continue
      const payment = await findPaymentById(row.payment_id)
      const preference = await createPreferenceForPayment(payment, { baseUrl: resolvedBaseUrl })
      await db.run(
        `UPDATE installment_payments
         SET status = 'sent',
             mercadopago_preference_id = ?,
             notes = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          preference.preferenceId || null,
          'Link de Mercado Pago generado automáticamente por fecha programada.',
          row.installment_id
        ]
      )
      results.push({
        installmentId: row.installment_id,
        paymentId: row.payment_id,
        generated: true,
        paymentUrl: preference.paymentUrl
      })
    } catch (error) {
      logger.error(`[Mercado Pago Planes] Error generando link ${row.installment_id}: ${error.message}`)
      await db.run(
        `UPDATE installment_payments
         SET status = 'failed',
             notes = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [error.message, row.installment_id]
      )
      results.push({ installmentId: row.installment_id, paymentId: row.payment_id, error: error.message })
    }
  }

  for (const flowId of touchedFlowIds) {
    await persistMercadoPagoPaymentPlanMirror(flowId)
  }

  return results
}

function parseMercadoPagoSignature(value) {
  return String(value || '').split(',').reduce((acc, part) => {
    const [key, raw] = part.split('=')
    if (key && raw) acc[key.trim()] = raw.trim()
    return acc
  }, {})
}

function validateWebhookSignature({ signatureHeader, requestId, dataId, secret }) {
  const cleanSecret = cleanString(secret)
  if (!cleanSecret) return true
  const signature = parseMercadoPagoSignature(signatureHeader)
  const ts = cleanString(signature.ts)
  const v1 = cleanString(signature.v1)
  if (!ts || !v1 || !requestId || !dataId) return false

  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`
  const expected = createHmac('sha256', cleanSecret).update(manifest).digest('hex')
  const expectedBuffer = Buffer.from(expected, 'hex')
  const receivedBuffer = Buffer.from(v1, 'hex')
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer)
}

function getWebhookDataId(body = {}, query = {}) {
  return cleanString(body?.data?.id)
    || cleanString(query?.['data.id'])
    || cleanString(query?.id)
    || cleanString(body?.id)
}

export function mapMercadoPagoStatus(status) {
  const normalized = cleanString(status).toLowerCase()
  return mapGatewayPaymentStatus(normalized, {
    paidStatuses: ['approved', 'accredited'],
    pendingStatuses: ['pending', 'in_process', 'in_mediation', 'authorized', 'cancelled', 'canceled', 'expired'],
    refundedStatuses: ['refunded', 'charged_back'],
    failedStatuses: ['rejected'],
    voidStatuses: ['void', 'voided']
  })
}

function mapMercadoPagoPreapprovalStatus(status) {
  const normalized = cleanString(status).toLowerCase()
  if (normalized === 'authorized') return 'active'
  if (normalized === 'paused') return 'paused'
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled'
  if (normalized === 'pending') return 'incomplete'
  return normalized || 'incomplete'
}

function buildMercadoPagoAutoRecurring({
  amount,
  currency,
  intervalType,
  intervalCount,
  startDate,
  endDate,
  includeStartDate = true
} = {}) {
  const normalizedInterval = cleanString(intervalType || 'monthly').toLowerCase()
  const count = Math.max(1, Number.parseInt(intervalCount, 10) || 1)
  const autoRecurring = {
    frequency: count,
    frequency_type: 'months',
    transaction_amount: normalizePositiveAmount(amount),
    currency_id: normalizeCurrency(currency)
  }

  if (normalizedInterval === 'daily') {
    autoRecurring.frequency_type = 'days'
  } else if (normalizedInterval === 'weekly') {
    autoRecurring.frequency = count * 7
    autoRecurring.frequency_type = 'days'
  } else if (normalizedInterval === 'yearly') {
    autoRecurring.frequency = count * 12
    autoRecurring.frequency_type = 'months'
  }

  const cleanStartDate = includeStartDate ? normalizeMercadoPagoSubscriptionStartDate(startDate) : null
  const cleanEndDate = timestampToIso(endDate)
  if (cleanStartDate) autoRecurring.start_date = cleanStartDate
  if (cleanEndDate) autoRecurring.end_date = cleanEndDate

  return autoRecurring
}

function getMercadoPagoSubscriptionBackUrl(baseUrl = '', subscriptionId = '', publicPaymentId = '') {
  const cleanBase = cleanString(baseUrl || getConfiguredBaseUrl()).replace(/\/+$/, '')
  const url = new URL(`${cleanBase || 'https://www.ristak.com'}/api/mercadopago/subscriptions/return`)
  const cleanSubscriptionId = cleanString(subscriptionId)
  if (cleanSubscriptionId) url.searchParams.set('subscription_id', cleanSubscriptionId)
  const cleanPublicPaymentId = cleanString(publicPaymentId)
  if (cleanPublicPaymentId) url.searchParams.set('public_payment_id', cleanPublicPaymentId)
  return url.toString()
}

function getMercadoPagoWebhookUrl(baseUrl = '') {
  const cleanBase = cleanString(baseUrl || getConfiguredBaseUrl()).replace(/\/+$/, '')
  return cleanBase ? `${cleanBase}${MERCADOPAGO_WEBHOOK_PATH}` : ''
}

function mapMercadoPagoSubscriptionResponse(payload = {}, fallback = {}) {
  const autoRecurring = payload.auto_recurring && typeof payload.auto_recurring === 'object'
    ? payload.auto_recurring
    : {}
  const mode = payload.livemode === true ? 'live' : fallback.paymentMode || fallback.mode || 'test'
  const initPoint = cleanString(payload.init_point)
  const sandboxInitPoint = cleanString(payload.sandbox_init_point)
  const nextPaymentDate = timestampToIso(payload.next_payment_date)

  return {
    status: mapMercadoPagoPreapprovalStatus(payload.status),
    mercadoPagoPreapprovalId: cleanString(payload.id),
    mercadoPagoPreapprovalPlanId: cleanString(payload.preapproval_plan_id),
    mercadoPagoInitPoint: initPoint,
    mercadoPagoSandboxInitPoint: sandboxInitPoint,
    mercadoPagoPayerId: cleanString(payload.payer_id),
    mercadoPagoCardId: cleanString(payload.card_id),
    mercadoPagoPaymentMethodId: cleanString(payload.payment_method_id),
    mercadoPagoNextPaymentDate: nextPaymentDate,
    nextRunAt: nextPaymentDate || fallback.nextRunAt || null,
    currentPeriodEnd: nextPaymentDate || fallback.currentPeriodEnd || null,
    paymentMode: normalizeMode(mode),
    raw: {
      provider: 'mercadopago',
      preapproval: payload,
      autoRecurring
    }
  }
}

function mapMercadoPagoSubscriptionPlanResponse(payload = {}, fallback = {}) {
  const mode = payload.livemode === true ? 'live' : fallback.paymentMode || fallback.mode || 'test'
  const initPoint = cleanString(payload.init_point)
  const sandboxInitPoint = cleanString(payload.sandbox_init_point)

  return {
    status: 'incomplete',
    mercadoPagoPreapprovalId: '',
    mercadoPagoPreapprovalPlanId: cleanString(payload.id || payload.preapproval_plan_id),
    mercadoPagoInitPoint: initPoint,
    mercadoPagoSandboxInitPoint: sandboxInitPoint,
    mercadoPagoPayerId: '',
    mercadoPagoCardId: '',
    mercadoPagoPaymentMethodId: '',
    mercadoPagoNextPaymentDate: null,
    paymentMode: normalizeMode(mode),
    raw: {
      provider: 'mercadopago',
      preapprovalPlan: payload
    }
  }
}

export async function createMercadoPagoSubscriptionPlanLink(input = {}, { baseUrl = '' } = {}) {
  const subscriptionId = cleanString(input.ristakSubscriptionId || input.subscriptionId)
  if (!subscriptionId) {
    const error = new Error('Falta el ID local de la suscripción para Mercado Pago.')
    error.status = 422
    throw error
  }

  const publicPaymentId = cleanString(input.subscriptionStartPublicPaymentId || input.publicPaymentId)
  const notificationUrl = getMercadoPagoWebhookUrl(baseUrl)
  const body = {
    reason: cleanString(input.name || input.reason || 'Suscripción Ristak'),
    external_reference: subscriptionId,
    auto_recurring: buildMercadoPagoAutoRecurring({
      amount: input.amount,
      currency: input.currency,
      intervalType: input.intervalType,
      intervalCount: input.intervalCount,
      startDate: input.startDate,
      endDate: input.cancelAt || input.endDate,
      includeStartDate: false
    }),
    back_url: getMercadoPagoSubscriptionBackUrl(baseUrl, subscriptionId, publicPaymentId)
  }
  if (notificationUrl) body.notification_url = notificationUrl

  const { payload, config } = await mercadoPagoSubscriptionApiRequest('/preapproval_plan', {
    method: 'POST',
    body,
    idempotencyKey: `rstk-subscription-plan-${subscriptionId}`
  })

  return mapMercadoPagoSubscriptionPlanResponse(payload, {
    paymentMode: config.mode
  })
}

export async function createMercadoPagoRecurringSubscription(input = {}, { baseUrl = '' } = {}) {
  const payerEmail = cleanString(input.contactEmail || input.email || input.payerEmail)
  if (!payerEmail) {
    const error = new Error('Mercado Pago necesita el email del contacto para crear la suscripción.')
    error.status = 422
    throw error
  }

  const subscriptionId = cleanString(input.ristakSubscriptionId || input.subscriptionId)
  if (!subscriptionId) {
    const error = new Error('Falta el ID local de la suscripción para Mercado Pago.')
    error.status = 422
    throw error
  }

  const publicPaymentId = cleanString(input.subscriptionStartPublicPaymentId || input.publicPaymentId)
  const body = {
    reason: cleanString(input.name || input.reason || 'Suscripción Ristak'),
    external_reference: subscriptionId,
    payer_email: payerEmail,
    auto_recurring: buildMercadoPagoAutoRecurring({
      amount: input.amount,
      currency: input.currency,
      intervalType: input.intervalType,
      intervalCount: input.intervalCount,
      startDate: input.startDate,
      endDate: input.cancelAt || input.endDate,
      includeStartDate: false
    }),
    back_url: getMercadoPagoSubscriptionBackUrl(baseUrl, subscriptionId, publicPaymentId),
    status: 'pending'
  }

  const { payload, config } = await mercadoPagoSubscriptionApiRequest('/preapproval', {
    method: 'POST',
    body,
    idempotencyKey: `rstk-subscription-${subscriptionId}`
  })

  return mapMercadoPagoSubscriptionResponse(payload, {
    paymentMode: config.mode,
    nextRunAt: input.nextRunAt
  })
}

export async function updateMercadoPagoRecurringSubscription(input = {}) {
  const preapprovalId = cleanString(input.mercadoPagoPreapprovalId || input.preapprovalId)
  if (!preapprovalId) {
    const error = new Error('Falta el ID de suscripción de Mercado Pago.')
    error.status = 422
    throw error
  }

  const body = {
    reason: cleanString(input.name || input.reason || 'Suscripción Ristak'),
    external_reference: cleanString(input.ristakSubscriptionId || input.subscriptionId),
    auto_recurring: {
      transaction_amount: normalizePositiveAmount(input.amount),
      currency_id: normalizeCurrency(input.currency)
    }
  }

  const cleanEndDate = timestampToIso(input.cancelAt || input.endDate)
  if (cleanEndDate) body.auto_recurring.end_date = cleanEndDate

  const { payload, config } = await mercadoPagoSubscriptionApiRequest(`/preapproval/${encodeURIComponent(preapprovalId)}`, {
    method: 'PUT',
    body
  })

  return mapMercadoPagoSubscriptionResponse(payload, {
    paymentMode: config.mode,
    nextRunAt: input.nextRunAt
  })
}

async function setMercadoPagoRecurringSubscriptionStatus(preapprovalId, status) {
  const cleanPreapprovalId = cleanString(preapprovalId)
  if (!cleanPreapprovalId) {
    const error = new Error('Falta el ID de suscripción de Mercado Pago.')
    error.status = 422
    throw error
  }

  const { payload, config } = await mercadoPagoSubscriptionApiRequest(`/preapproval/${encodeURIComponent(cleanPreapprovalId)}`, {
    method: 'PUT',
    body: { status }
  })

  return mapMercadoPagoSubscriptionResponse(payload, { paymentMode: config.mode })
}

export async function pauseMercadoPagoRecurringSubscription(preapprovalId) {
  return setMercadoPagoRecurringSubscriptionStatus(preapprovalId, 'paused')
}

export async function resumeMercadoPagoRecurringSubscription(preapprovalId) {
  return setMercadoPagoRecurringSubscriptionStatus(preapprovalId, 'authorized')
}

export async function cancelMercadoPagoRecurringSubscription(preapprovalId) {
  return setMercadoPagoRecurringSubscriptionStatus(preapprovalId, 'canceled')
}

export async function cancelMercadoPagoSubscriptionPlan(preapprovalPlanId) {
  const cleanPreapprovalPlanId = cleanString(preapprovalPlanId)
  if (!cleanPreapprovalPlanId) {
    const error = new Error('Falta el ID de plan de suscripción de Mercado Pago.')
    error.status = 422
    throw error
  }

  const { payload, config } = await mercadoPagoSubscriptionApiRequest(`/preapproval_plan/${encodeURIComponent(cleanPreapprovalPlanId)}`, {
    method: 'PUT',
    body: { status: 'cancelled' },
    idempotencyKey: `rstk-subscription-plan-cancel-${cleanPreapprovalPlanId}`
  })

  return mapMercadoPagoSubscriptionPlanResponse(payload, { paymentMode: config.mode })
}

function timestampToIso(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizeMercadoPagoSubscriptionStartDate(value) {
  const cleanStartDate = timestampToIso(value)
  if (!cleanStartDate) return null

  const parsed = new Date(cleanStartDate)
  const minimumStartAt = Date.now() + MERCADOPAGO_SUBSCRIPTION_START_BUFFER_MS
  if (parsed.getTime() >= minimumStartAt) return cleanStartDate

  return new Date(minimumStartAt).toISOString()
}

async function syncMercadoPagoPaymentPlanFromLocalPayment(payment) {
  if (!payment?.id) return
  const status = cleanString(payment.status)
  const touchedRows = await db.all(
    `SELECT flow_id FROM installment_payments WHERE payment_id = ?
     UNION
     SELECT id AS flow_id FROM payment_flows WHERE first_payment_invoice_id = ?`,
    [payment.id, payment.id]
  )

  await db.run(
    `UPDATE installment_payments
     SET status = ?,
         mercadopago_payment_id = COALESCE(?, mercadopago_payment_id),
         updated_at = CURRENT_TIMESTAMP
     WHERE payment_id = ?`,
    [status === 'paid' ? 'paid' : status || 'pending', payment.mercadopago_payment_id || null, payment.id]
  )

  await db.run(
    `UPDATE payment_flows
     SET first_payment_status = CASE
           WHEN first_payment_invoice_id = ? THEN ?
           ELSE first_payment_status
         END,
         updated_at = CURRENT_TIMESTAMP
     WHERE first_payment_invoice_id = ?`,
    [payment.id, status === 'paid' ? 'paid' : status || 'pending', payment.id]
  )

  for (const row of touchedRows || []) {
    await persistMercadoPagoPaymentPlanMirror(row.flow_id)
  }
}

async function updatePaymentFromMercadoPagoPayment(mpPayment, { mode = '' } = {}) {
  const paymentId = cleanString(mpPayment?.external_reference)
    || cleanString(mpPayment?.metadata?.ristak_payment_id)
  const mercadoPagoPaymentId = cleanString(mpPayment?.id)
  if (!paymentId && !mercadoPagoPaymentId) return null

  const row = paymentId
    ? await findPaymentById(paymentId)
    : await db.get('SELECT * FROM payments WHERE mercadopago_payment_id = ?', [mercadoPagoPaymentId])
  if (!row) return null

  const rowMode = normalizeMode(row.payment_mode)
  const requestedMode = cleanString(mode) ? normalizeMode(mode) : ''
  const payloadMode = mpPayment?.live_mode === false
    ? 'test'
    : mpPayment?.live_mode === true
      ? 'live'
      : ''
  if ((requestedMode && rowMode !== requestedMode) || (payloadMode && rowMode !== payloadMode)) {
    const error = new Error('El webhook de Mercado Pago no coincide con el modo del pago local.')
    error.status = 409
    throw error
  }

  const amount = Number(mpPayment.transaction_amount || mpPayment.transaction_details?.total_paid_amount || row.amount)
  const currency = normalizeCurrency(mpPayment.currency_id || row.currency)
  const nextStatus = mapMercadoPagoStatus(mpPayment.status)
  const ignorePendingRegression = shouldIgnorePendingWebhookRegression(row, nextStatus)
  const persistedStatus = ignorePendingRegression ? cleanString(row.status) || 'paid' : nextStatus
  const paidAt = nextStatus === 'paid'
    ? timestampToIso(mpPayment.date_approved || mpPayment.money_release_date || mpPayment.date_last_updated) || new Date().toISOString()
    : null
  const paymentMethod = cleanString(mpPayment.payment_type_id || mpPayment.payment_method_id || 'mercadopago')
  const metadata = {
    ...parseJson(row.metadata_json, {}),
    mercadoPago: {
      paymentId: mercadoPagoPaymentId,
      status: cleanString(mpPayment.status),
      statusDetail: cleanString(mpPayment.status_detail),
      paymentMethodId: cleanString(mpPayment.payment_method_id),
      paymentTypeId: cleanString(mpPayment.payment_type_id),
      installments: Number(mpPayment.installments || 0) > 1 ? Math.trunc(Number(mpPayment.installments)) : null,
      preferenceId: cleanString(mpPayment.preference_id)
    }
  }

  await db.run(
    `UPDATE payments
     SET amount = COALESCE(?, amount),
         currency = COALESCE(?, currency),
         status = ?,
         payment_method = ?,
         payment_provider = 'mercadopago',
         reference = COALESCE(?, reference),
         mercadopago_payment_id = COALESCE(?, mercadopago_payment_id),
         mercadopago_preference_id = COALESCE(?, mercadopago_preference_id),
         paid_at = COALESCE(?, paid_at),
         date = COALESCE(?, date),
         metadata_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      Number.isFinite(amount) ? amount : null,
      currency,
      persistedStatus,
      paymentMethod,
      mercadoPagoPaymentId || null,
      mercadoPagoPaymentId || null,
      cleanString(mpPayment.preference_id) || null,
      paidAt,
      paidAt,
      JSON.stringify(metadata),
      row.id
    ]
  )

  let updated = await findPaymentById(row.id)
  const suppressProductionEffects = shouldSuppressProductionPaymentEffects(updated || row)
  const linkedContactId = await resolvePaymentContactForGatewayPayment(updated, {
    provider: 'mercadopago',
    providerPayload: mpPayment
  })
  if (linkedContactId && !updated?.contact_id) {
    updated = await findPaymentById(row.id)
  }
  if (updated?.id && !ignorePendingRegression && !suppressProductionEffects) {
    dispatchProductPostWebhooksForPaymentInBackground(updated.id, {
      status: persistedStatus,
      previousStatus: row.status || ''
    })
    if (cleanString(row.status).toLowerCase() !== cleanString(persistedStatus).toLowerCase()) {
      sendPaymentNotification({ ...updated, status: persistedStatus, previousStatus: row.status || '' }).catch((error) => {
        logger.warn(`No se pudo enviar push de pago Mercado Pago ${updated.id}: ${error.message}`)
      })
    }
  }
  if (updated?.contact_id && nextStatus === 'paid' && !suppressProductionEffects) {
    registerGigstackPaymentForTransactionInBackground(updated.id)
    updateSingleContactStats(updated.contact_id).catch((error) => {
      logger.warn(`No se pudieron actualizar stats del contacto por pago Mercado Pago ${row.id}: ${error.message}`)
    })
    // (PAY2-003) Encolar el comprobante automático igual que Conekta para que el cliente lo reciba.
    Promise.resolve(queuePaymentAutomationMessage('receipt', { ...updated, status: nextStatus }))
      .catch((error) => {
        logger.warn(`No se pudo encolar comprobante por pago Mercado Pago ${updated.id}: ${error.message}`)
      })
    triggerMetaPaymentPurchaseEvent(updated.contact_id, { ...updated, status: nextStatus })
      .catch((error) => {
        logger.warn(`No se pudo enviar Purchase a Meta para pago Mercado Pago ${updated.id}: ${error.message}`)
      })
  }
  await syncMercadoPagoPaymentPlanFromLocalPayment(updated)

  if (ignorePendingRegression) {
    logger.info(`[Mercado Pago webhook] Ignorado estado pending tardío para pago ya pagado ${updated?.id || row.id} (payment ${mercadoPagoPaymentId})`)
  }

  return updated
}

async function findSubscriptionForMercadoPagoPreapproval(preapproval = {}) {
  const subscriptionId = cleanString(preapproval.external_reference)
  const preapprovalId = cleanString(preapproval.id || preapproval.preapproval_id)
  const preapprovalPlanId = cleanString(preapproval.preapproval_plan_id)
  const filters = []
  const params = []

  if (subscriptionId) {
    filters.push('id = ?')
    params.push(subscriptionId)
  }

  if (preapprovalId) {
    filters.push('mercadopago_preapproval_id = ?')
    params.push(preapprovalId)
  }

  if (preapprovalPlanId) {
    filters.push('mercadopago_preapproval_plan_id = ?')
    params.push(preapprovalPlanId)
  }

  if (!filters.length) return null

  return db.get(
    `SELECT *
     FROM subscriptions
     WHERE ${filters.join(' OR ')}
     LIMIT 1`,
    params
  )
}

async function updateSubscriptionFromMercadoPagoPreapproval(preapproval = {}) {
  const existing = await findSubscriptionForMercadoPagoPreapproval(preapproval)
  if (!existing) return null

  const mapped = mapMercadoPagoSubscriptionResponse(preapproval, {
    paymentMode: existing.payment_mode,
    nextRunAt: existing.next_run_at,
    currentPeriodEnd: existing.current_period_end
  })
  const raw = {
    ...parseJson(existing.raw_json, {}),
    mercadoPago: mapped.raw
  }
  const metadata = parseJson(existing.metadata_json, {})
  const startPayment = getSubscriptionStartPaymentFromMetadata(metadata)
  const syncedAt = new Date().toISOString()
  const startPaymentStatus = mapped.status === 'active'
    ? 'paid'
    : mapped.status === 'cancelled'
      ? 'cancelled'
      : 'pending_checkout'

  await db.run(
    `UPDATE subscriptions
     SET status = ?,
         payment_provider = 'mercadopago',
         payment_method = 'mercadopago_subscription',
         payment_mode = COALESCE(?, payment_mode),
         mercadopago_preapproval_id = COALESCE(?, mercadopago_preapproval_id),
         mercadopago_preapproval_plan_id = COALESCE(?, mercadopago_preapproval_plan_id),
         mercadopago_init_point = COALESCE(?, mercadopago_init_point),
         mercadopago_sandbox_init_point = COALESCE(?, mercadopago_sandbox_init_point),
         mercadopago_payer_id = COALESCE(?, mercadopago_payer_id),
         mercadopago_card_id = COALESCE(?, mercadopago_card_id),
         mercadopago_payment_method_id = COALESCE(?, mercadopago_payment_method_id),
         mercadopago_next_payment_date = COALESCE(?, mercadopago_next_payment_date),
         next_run_at = COALESCE(?, next_run_at),
         current_period_end = COALESCE(?, current_period_end),
         cancelled_at = CASE WHEN ? = 'cancelled' THEN COALESCE(cancelled_at, CURRENT_TIMESTAMP) ELSE cancelled_at END,
         metadata_json = ?,
         raw_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      mapped.status,
      mapped.paymentMode || null,
      mapped.mercadoPagoPreapprovalId || null,
      mapped.mercadoPagoPreapprovalPlanId || null,
      mapped.mercadoPagoInitPoint || null,
      mapped.mercadoPagoSandboxInitPoint || null,
      mapped.mercadoPagoPayerId || null,
      mapped.mercadoPagoCardId || null,
      mapped.mercadoPagoPaymentMethodId || null,
      mapped.mercadoPagoNextPaymentDate || null,
      mapped.nextRunAt || null,
      mapped.currentPeriodEnd || null,
      mapped.status,
      JSON.stringify({
        ...metadata,
        subscriptionStartPayment: {
          ...(metadata.subscriptionStartPayment && typeof metadata.subscriptionStartPayment === 'object' ? metadata.subscriptionStartPayment : {}),
          status: startPaymentStatus,
          provider: 'mercadopago',
          mercadoPagoPreapprovalId: mapped.mercadoPagoPreapprovalId || existing.mercadopago_preapproval_id || '',
          mercadoPagoPreapprovalPlanId: mapped.mercadoPagoPreapprovalPlanId || existing.mercadopago_preapproval_plan_id || '',
          syncedAt
        }
      }),
      JSON.stringify(raw),
      existing.id
    ]
  )

  const updated = await db.get('SELECT * FROM subscriptions WHERE id = ?', [existing.id])
  if (startPayment.paymentId) {
    const previousStartPayment = await db.get('SELECT status FROM payments WHERE id = ?', [startPayment.paymentId])
    await db.run(
      `UPDATE payments
       SET status = ?,
           payment_method = 'mercadopago_subscription',
           payment_provider = 'mercadopago',
           reference = COALESCE(?, reference),
           mercadopago_payment_id = COALESCE(?, mercadopago_payment_id),
           paid_at = CASE WHEN ? = 'paid' THEN COALESCE(paid_at, ?) ELSE paid_at END,
           date = CASE WHEN ? = 'paid' THEN COALESCE(date, ?) ELSE date END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        startPaymentStatus === 'paid' ? 'paid' : 'pending',
        mapped.mercadoPagoPreapprovalId || mapped.mercadoPagoPreapprovalPlanId || null,
        null,
        startPaymentStatus,
        syncedAt,
        startPaymentStatus,
        syncedAt,
        startPayment.paymentId
      ]
    )
    dispatchProductPostWebhooksForPaymentInBackground(startPayment.paymentId, {
      status: startPaymentStatus === 'paid' ? 'paid' : 'pending',
      previousStatus: previousStartPayment?.status || ''
    })
    const updatedPayment = await findPaymentById(startPayment.paymentId).catch(() => null)
    publishPaymentChangedEvent(updatedPayment || {
      id: startPayment.paymentId,
      status: startPaymentStatus === 'paid' ? 'paid' : 'pending',
      previousStatus: previousStartPayment?.status || '',
      payment_method: 'mercadopago_subscription',
      payment_provider: 'mercadopago'
    })
  }

  publishSubscriptionChangedEvent(updated || {
    ...existing,
    status: mapped.status
  }, { previousStatus: existing.status })
  return updated
}

async function insertSubscriptionPaymentFromMercadoPagoAuthorizedPayment(authorizedPayment = {}, subscriptionRow = null) {
  if (!subscriptionRow) return null

  const authorizedPaymentId = cleanString(authorizedPayment.id)
  const paymentIdFromMercadoPago = cleanString(authorizedPayment.payment?.id)
  const reference = authorizedPaymentId ? `mp_authorized_payment:${authorizedPaymentId}` : paymentIdFromMercadoPago
  if (!reference && !paymentIdFromMercadoPago) return null

  const existing = await db.get(
    `SELECT id
     FROM payments
     WHERE (reference IS NOT NULL AND reference = ?)
        OR (mercadopago_payment_id IS NOT NULL AND mercadopago_payment_id = ?)
     LIMIT 1`,
    [reference || '', paymentIdFromMercadoPago || '']
  )

  const currency = normalizeCurrency(authorizedPayment.currency_id || subscriptionRow.currency)
  const amount = normalizePositiveAmount(authorizedPayment.transaction_amount || subscriptionRow.amount)
  const statusSource = authorizedPayment.payment?.status || authorizedPayment.summarized || authorizedPayment.status
  const nextStatus = mapMercadoPagoStatus(statusSource)
  const paidAt = nextStatus === 'paid'
    ? timestampToIso(authorizedPayment.payment?.date_approved || authorizedPayment.last_modified || authorizedPayment.debit_date) || new Date().toISOString()
    : null
  const metadata = {
    source: 'mercadopago_subscription_authorized_payment',
    ristakSubscriptionId: subscriptionRow.id,
    mercadoPagoPreapprovalId: cleanString(authorizedPayment.preapproval_id) || subscriptionRow.mercadopago_preapproval_id || '',
    mercadoPagoAuthorizedPaymentId: authorizedPaymentId,
    mercadoPagoPaymentId: paymentIdFromMercadoPago,
    mercadoPagoStatus: cleanString(authorizedPayment.status),
    mercadoPagoSummarized: cleanString(authorizedPayment.summarized)
  }

  const subscriptionMetadata = parseJson(subscriptionRow.metadata_json, {})
  const startPayment = getSubscriptionStartPaymentFromMetadata(subscriptionMetadata)
  if (!existing?.id && startPayment.paymentId) {
    const startPaymentRow = await db.get(
      `SELECT id, metadata_json
       FROM payments
       WHERE id = ?
       LIMIT 1`,
      [startPayment.paymentId]
    )

    if (startPaymentRow?.id) {
      await db.run(
        `UPDATE payments
         SET amount = ?,
             currency = ?,
             status = ?,
             payment_method = 'mercadopago_subscription',
             payment_mode = ?,
             payment_provider = 'mercadopago',
             reference = COALESCE(?, reference),
             mercadopago_payment_id = COALESCE(?, mercadopago_payment_id),
             paid_at = COALESCE(?, paid_at),
             date = COALESCE(?, date),
             metadata_json = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          amount,
          currency,
          nextStatus,
          subscriptionRow.payment_mode || 'test',
          reference || paymentIdFromMercadoPago || null,
          paymentIdFromMercadoPago || null,
          paidAt,
          paidAt || timestampToIso(authorizedPayment.debit_date),
          JSON.stringify({
            ...parseJson(startPaymentRow.metadata_json, {}),
            mercadoPago: metadata
          }),
          startPaymentRow.id
        ]
      )

      if (subscriptionRow.contact_id && nextStatus === 'paid') {
        registerGigstackPaymentForTransactionInBackground(startPaymentRow.id)
        dispatchProductPostWebhooksForPaymentInBackground(startPaymentRow.id, {
          status: nextStatus,
          previousStatus: ''
        })
        updateSingleContactStats(subscriptionRow.contact_id).catch((error) => {
          logger.warn(`No se pudieron actualizar stats del contacto por suscripción Mercado Pago ${subscriptionRow.id}: ${error.message}`)
        })
      }

      const updatedPayment = await findPaymentById(startPaymentRow.id).catch(() => null)
      publishPaymentChangedEvent(updatedPayment || {
        id: startPaymentRow.id,
        contact_id: subscriptionRow.contact_id || null,
        status: nextStatus,
        payment_method: 'mercadopago_subscription',
        payment_provider: 'mercadopago',
        metadata_json: JSON.stringify(metadata)
      })

      return startPaymentRow.id
    }
  }

  if (existing?.id) {
    await db.run(
      `UPDATE payments
       SET amount = ?,
           currency = ?,
           status = ?,
           payment_method = 'mercadopago_subscription',
           payment_mode = ?,
           payment_provider = 'mercadopago',
           mercadopago_payment_id = COALESCE(?, mercadopago_payment_id),
           paid_at = COALESCE(?, paid_at),
           date = COALESCE(?, date),
           metadata_json = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        amount,
        currency,
        nextStatus,
        subscriptionRow.payment_mode || 'test',
        paymentIdFromMercadoPago || null,
        paidAt,
        paidAt || timestampToIso(authorizedPayment.debit_date),
        JSON.stringify(metadata),
        existing.id
      ]
    )
    const updatedPayment = await findPaymentById(existing.id).catch(() => null)
    publishPaymentChangedEvent(updatedPayment || {
      id: existing.id,
      contact_id: subscriptionRow.contact_id || null,
      status: nextStatus,
      payment_method: 'mercadopago_subscription',
      payment_provider: 'mercadopago',
      metadata_json: JSON.stringify(metadata)
    })
    return existing.id
  }

  const localPaymentId = createId('mercadopago_subscription_payment')
  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, reference, title, description, public_payment_id, payment_url,
      mercadopago_payment_id, paid_at, metadata_json, date, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      localPaymentId,
      subscriptionRow.contact_id || null,
      amount,
      currency,
      nextStatus,
      'mercadopago_subscription',
      subscriptionRow.payment_mode || 'test',
      'mercadopago',
      reference || paymentIdFromMercadoPago,
      subscriptionRow.name || 'Suscripción',
      `Cobro recurrente de ${subscriptionRow.name || 'suscripción'}`,
      null,
      null,
      paymentIdFromMercadoPago || null,
      paidAt,
      JSON.stringify(metadata),
      paidAt || timestampToIso(authorizedPayment.debit_date) || new Date().toISOString()
    ]
  )

  if (subscriptionRow.contact_id && nextStatus === 'paid') {
    registerGigstackPaymentForTransactionInBackground(localPaymentId)
    updateSingleContactStats(subscriptionRow.contact_id).catch((error) => {
      logger.warn(`No se pudieron actualizar stats del contacto por suscripción Mercado Pago ${subscriptionRow.id}: ${error.message}`)
    })
    // (PAY2-003) Encolar el comprobante automático también para los cobros recurrentes de Mercado Pago.
    Promise.resolve(findPaymentById(localPaymentId))
      .then((paymentRow) => {
        if (paymentRow) return queuePaymentAutomationMessage('receipt', { ...paymentRow, status: nextStatus })
      })
      .catch((error) => {
        logger.warn(`No se pudo encolar comprobante por suscripción Mercado Pago ${localPaymentId}: ${error.message}`)
      })
  }

  const inserted = await findPaymentById(localPaymentId).catch(() => null)
  publishPaymentChangedEvent(inserted || {
    id: localPaymentId,
    contact_id: subscriptionRow.contact_id || null,
    status: nextStatus,
    payment_method: 'mercadopago_subscription',
    payment_provider: 'mercadopago',
    metadata_json: JSON.stringify(metadata)
  })

  return localPaymentId
}

function getMercadoPagoPreapprovalSearchResults(payload = {}) {
  if (Array.isArray(payload.results)) return payload.results
  if (Array.isArray(payload.elements)) return payload.elements
  if (Array.isArray(payload.data)) return payload.data
  return []
}

function pickMercadoPagoPreapproval(results = []) {
  const valid = results.filter((item) => cleanString(item?.id))
  if (!valid.length) return null

  const statusPriority = {
    authorized: 0,
    pending: 1,
    paused: 2,
    cancelled: 3,
    canceled: 3
  }

  return [...valid].sort((a, b) => {
    const statusA = statusPriority[cleanString(a.status).toLowerCase()] ?? 9
    const statusB = statusPriority[cleanString(b.status).toLowerCase()] ?? 9
    if (statusA !== statusB) return statusA - statusB
    return new Date(b.last_modified || b.date_created || 0).getTime() - new Date(a.last_modified || a.date_created || 0).getTime()
  })[0]
}

async function listMercadoPagoAuthorizedPayments(preapprovalId) {
  const cleanPreapprovalId = cleanString(preapprovalId)
  if (!cleanPreapprovalId) return []

  const query = new URLSearchParams({ preapproval_id: cleanPreapprovalId })
  const { payload } = await mercadoPagoSubscriptionApiRequest(`/authorized_payments/search?${query.toString()}`)
  return getMercadoPagoPreapprovalSearchResults(payload)
}

async function syncMercadoPagoAuthorizedPaymentsForSubscription(preapprovalId, subscriptionRow = null) {
  const cleanPreapprovalId = cleanString(preapprovalId)
  if (!cleanPreapprovalId || !subscriptionRow?.id) return []
  const authorizedPayments = await listMercadoPagoAuthorizedPayments(cleanPreapprovalId)
  const paymentIds = []

  for (const authorizedPayment of authorizedPayments) {
    const paymentId = await insertSubscriptionPaymentFromMercadoPagoAuthorizedPayment(authorizedPayment, subscriptionRow)
    if (paymentId) paymentIds.push(paymentId)
  }

  return paymentIds
}

export async function refreshMercadoPagoSubscription(preapprovalId) {
  const cleanPreapprovalId = cleanString(preapprovalId)
  if (!cleanPreapprovalId) return null
  const { payload } = await mercadoPagoSubscriptionApiRequest(`/preapproval/${encodeURIComponent(cleanPreapprovalId)}`)
  const updated = await updateSubscriptionFromMercadoPagoPreapproval(payload)
  if (updated?.id) {
    await syncMercadoPagoAuthorizedPaymentsForSubscription(cleanPreapprovalId, updated).catch((error) => {
      logger.warn(`No se pudieron sincronizar cobros autorizados de Mercado Pago para ${updated.id}: ${error.message}`)
    })
  }
  return updated
}

export async function syncMercadoPagoSubscriptionPlan(preapprovalPlanId) {
  const cleanPreapprovalPlanId = cleanString(preapprovalPlanId)
  if (!cleanPreapprovalPlanId) return null

  const query = new URLSearchParams({
    preapproval_plan_id: cleanPreapprovalPlanId,
    limit: '20'
  })
  const { payload } = await mercadoPagoSubscriptionApiRequest(`/preapproval/search?${query.toString()}`)
  const preapproval = pickMercadoPagoPreapproval(getMercadoPagoPreapprovalSearchResults(payload))
  if (!preapproval?.id) return null

  const updated = await updateSubscriptionFromMercadoPagoPreapproval(preapproval)
  if (updated?.id) {
    await syncMercadoPagoAuthorizedPaymentsForSubscription(preapproval.id, updated).catch((error) => {
      logger.warn(`No se pudieron sincronizar cobros autorizados de Mercado Pago para ${updated.id}: ${error.message}`)
    })
  }
  return updated
}

export async function syncMercadoPagoSubscriptionReturn(input = {}) {
  const subscriptionId = cleanString(input.subscriptionId || input.subscription_id || input.external_reference)
  const preapprovalId = cleanString(input.preapprovalId || input.preapproval_id)
  let preapprovalPlanId = cleanString(input.preapprovalPlanId || input.preapproval_plan_id)

  if (preapprovalId) {
    return refreshMercadoPagoSubscription(preapprovalId)
  }

  if (!preapprovalPlanId && subscriptionId) {
    const row = await db.get(
      `SELECT mercadopago_preapproval_plan_id
       FROM subscriptions
       WHERE id = ?
       LIMIT 1`,
      [subscriptionId]
    )
    preapprovalPlanId = cleanString(row?.mercadopago_preapproval_plan_id)
  }

  if (preapprovalPlanId) {
    return syncMercadoPagoSubscriptionPlan(preapprovalPlanId)
  }

  return null
}

export async function syncPendingMercadoPagoSubscriptions({ limit = 20 } = {}) {
  const rows = await db.all(
    `SELECT *
     FROM subscriptions
     WHERE payment_provider = 'mercadopago'
       AND payment_method = 'mercadopago_subscription'
       AND mercadopago_preapproval_plan_id IS NOT NULL
       AND COALESCE(status, '') NOT IN ('active', 'cancelled', 'deleted')
     ORDER BY updated_at DESC
     LIMIT ?`,
    [Math.max(1, Math.min(Number(limit) || 20, 50))]
  )

  const result = {
    checked: rows.length,
    updated: 0,
    payments: 0
  }

  for (const row of rows) {
    const beforePaymentCount = await db.get(
      `SELECT COUNT(*) AS count
       FROM payments
       WHERE metadata_json LIKE ?`,
      [`%${row.id}%`]
    )
    const updated = await syncMercadoPagoSubscriptionPlan(row.mercadopago_preapproval_plan_id).catch((error) => {
      logger.warn(`No se pudo sincronizar suscripción Mercado Pago ${row.id}: ${error.message}`)
      return null
    })
    if (updated?.id) result.updated += 1
    const afterPaymentCount = await db.get(
      `SELECT COUNT(*) AS count
       FROM payments
       WHERE metadata_json LIKE ?`,
      [`%${row.id}%`]
    )
    result.payments += Math.max(0, Number(afterPaymentCount?.count || 0) - Number(beforePaymentCount?.count || 0))
  }

  return result
}

export async function refreshMercadoPagoAuthorizedPayment(authorizedPaymentId) {
  const cleanAuthorizedPaymentId = cleanString(authorizedPaymentId)
  if (!cleanAuthorizedPaymentId) return null
  const { payload } = await mercadoPagoSubscriptionApiRequest(`/authorized_payments/${encodeURIComponent(cleanAuthorizedPaymentId)}`)

  let subscription = await findSubscriptionForMercadoPagoPreapproval({
    id: payload?.preapproval_id,
    external_reference: payload?.external_reference
  })

  if (!subscription && payload?.preapproval_id) {
    subscription = await refreshMercadoPagoSubscription(payload.preapproval_id)
  }

  if (subscription?.id) {
    await insertSubscriptionPaymentFromMercadoPagoAuthorizedPayment(payload, subscription)
  }

  return {
    authorizedPaymentId: cleanAuthorizedPaymentId,
    subscriptionId: subscription?.id || null,
    status: cleanString(payload?.payment?.status || payload?.summarized || payload?.status) || null
  }
}

export async function refreshMercadoPagoPayment(mercadoPagoPaymentId, { useSubscriptionClient = false, mode = '' } = {}) {
  const paymentId = cleanString(mercadoPagoPaymentId)
  if (!paymentId) return null
  if (useSubscriptionClient) {
    const { payload, config } = await mercadoPagoSubscriptionApiRequest(`/v1/payments/${encodeURIComponent(paymentId)}`)
    return updatePaymentFromMercadoPagoPayment(payload, { mode: mode || config.mode })
  }

  const localPayment = await db.get(
    'SELECT payment_mode FROM payments WHERE mercadopago_payment_id = ? LIMIT 1',
    [paymentId]
  )
  const resolvedMode = cleanString(mode) || cleanString(localPayment?.payment_mode)
  const config = await getMercadoPagoClientConfig(resolvedMode)
  const { payload } = await mercadoPagoApiRequest(`/v1/payments/${encodeURIComponent(paymentId)}`, { config })
  return updatePaymentFromMercadoPagoPayment(payload, { mode: config.mode })
}

export async function handleMercadoPagoWebhookEvent(body = {}, headers = {}, query = {}) {
  const dataId = getWebhookDataId(body, query)
  const requestId = cleanString(headers['x-request-id'])
  const signatureHeader = cleanString(headers['x-signature'])
  const type = cleanString(body.type || body.topic || query.topic || query.type)
  const action = cleanString(body.action)
  const isSubscriptionWebhook = type.includes('subscription') || action.includes('preapproval') || action.includes('authorized_payment')
  const isTestWebhook = body.live_mode === false || cleanString(body.live_mode || query.live_mode).toLowerCase() === 'false'
  const webhookModeHint = isTestWebhook
    ? 'test'
    : body.live_mode === true || cleanString(body.live_mode || query.live_mode).toLowerCase() === 'true'
      ? 'live'
      : ''
  const [testConfig, liveConfig] = await Promise.all([
    getMercadoPagoPaymentConfig({ includeSecrets: true, mode: 'test' }),
    getMercadoPagoPaymentConfig({ includeSecrets: true, mode: 'live' })
  ])
  const acceptedSecrets = [
    { secret: cleanString(testConfig.webhookSecret), useSubscriptionClient: false, mode: 'test' },
    { secret: cleanString(liveConfig.webhookSecret), useSubscriptionClient: false, mode: 'live' },
    ...((isSubscriptionWebhook || isTestWebhook)
      ? [{ secret: cleanString(testConfig.subscriptionTestWebhookSecret), useSubscriptionClient: true, mode: 'test' }]
      : [])
  ].filter((item, index, values) => item.secret && values.findIndex((candidate) => (
    candidate.secret === item.secret &&
    candidate.useSubscriptionClient === item.useSubscriptionClient &&
    candidate.mode === item.mode
  )) === index)
  let useSubscriptionClientForPaymentWebhook = false
  let webhookMode = webhookModeHint

  // (PAY2-005) Rollout seguro: si YA hay secret configurado, exigir firma válida (401 si falla);
  // si todavía no hay secret provisionado, aceptar pero dejar constancia para no romper la integración viva.
  if (acceptedSecrets.length) {
    const matchingSecrets = acceptedSecrets.filter((item) => validateWebhookSignature({
      signatureHeader,
      requestId,
      dataId,
      secret: item.secret
    }))
    const matchedSecret = matchingSecrets.find((item) => item.mode === webhookModeHint) || matchingSecrets[0]

    if (!matchedSecret) {
      const error = new Error('No se pudo verificar la firma del webhook de Mercado Pago.')
      error.status = 401
      throw error
    }

    useSubscriptionClientForPaymentWebhook = matchedSecret.useSubscriptionClient
    webhookMode = matchedSecret.mode || webhookMode
  } else {
    logger.warn('Webhook de Mercado Pago aceptado sin verificar firma porque no hay secret configurado. Configura el secret para exigir firma.')
  }

  if (dataId && (type.includes('subscription_preapproval_plan') || action.includes('preapproval_plan'))) {
    const updated = await syncMercadoPagoSubscriptionPlan(dataId)
    return {
      received: true,
      type,
      action,
      subscriptionId: updated?.id || null,
      status: updated?.status || null
    }
  }

  if (dataId && (type.includes('subscription_preapproval') || action.includes('preapproval'))) {
    const updated = await refreshMercadoPagoSubscription(dataId)
    return {
      received: true,
      type,
      action,
      subscriptionId: updated?.id || null,
      status: updated?.status || null
    }
  }

  if (dataId && (type.includes('subscription_authorized_payment') || action.includes('authorized_payment'))) {
    const updated = await refreshMercadoPagoAuthorizedPayment(dataId)
    return {
      received: true,
      type,
      action,
      subscriptionId: updated?.subscriptionId || null,
      status: updated?.status || null
    }
  }

  if (!dataId || !(type.includes('payment') || action.includes('payment'))) {
    return { received: true, ignored: true, type, action }
  }

  const updated = await refreshMercadoPagoPayment(dataId, {
    useSubscriptionClient: useSubscriptionClientForPaymentWebhook,
    mode: webhookMode
  })
  return {
    received: true,
    type,
    action,
    paymentId: updated?.id || null,
    status: updated?.status || null
  }
}
