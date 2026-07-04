import fetch from 'node-fetch'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { decrypt, encrypt, isEncrypted } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'
import { updateSingleContactStats } from '../utils/updateContactsStats.js'
import { getAccountCurrency } from '../utils/accountLocale.js'
import { calculatePaymentTax, getPaymentGatewayMode, getPublicPaymentSettings } from './paymentSettingsService.js'
import { registerGigstackPaymentForTransactionInBackground } from './gigstackInvoiceService.js'
import { dispatchProductPostWebhooksForPaymentInBackground } from './productPostWebhookService.js'
import { sendPaymentNotification } from './pushNotificationsService.js'
import { queuePaymentAutomationMessage } from './paymentAutomationsService.js'
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
  normalizeToUtcIso
} from '../utils/dateUtils.js'

const CONFIG_KEYS = {
  enabled: 'rebill_enabled',
  mode: 'rebill_mode',
  defaultCurrency: 'rebill_default_currency',
  accountLabel: 'rebill_account_label',
  publicKey: 'rebill_public_key',
  secretKey: 'rebill_secret_key_encrypted',
  modeConnections: 'rebill_mode_connections',
  disconnectedAt: 'rebill_disconnected_at'
}

const DEFAULT_CURRENCY = 'USD'
const REBILL_API_BASE = 'https://api.rebill.com'
const REBILL_WEBHOOK_PATH = '/api/rebill/webhook'
const REBILL_WEBHOOK_EVENTS = ['payment.created', 'payment.updated']
const REBILL_SUPPORTED_CURRENCIES = new Set(['ARS', 'BRL', 'CLP', 'COP', 'MXN', 'USD'])
const SUCCESSFUL_PAYMENT_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'approved'])
const CLOSED_PAYMENT_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'approved', 'refunded', 'void', 'deleted', 'chargeback'])
const REBILL_PLAN_STATES = {
  ACTIVE: 'installment_plan_active',
  COMPLETED: 'completed',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
  DELETED: 'deleted'
}
const MANUAL_PLAN_PAYMENT_METHODS = new Set(['cash', 'bank_transfer', 'transfer', 'deposit', 'manual', 'offline', 'check', 'other'])
const REBILL_CHECKOUT_METHODS = new Set(['card', 'payment_link', 'direct_card', 'rebill', 'rebill_checkout', 'checkout'])
const TIMED_PLAN_FREQUENCY = 'scheduled_time'
const PLAN_FREQUENCIES = new Set(['custom', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly', TIMED_PLAN_FREQUENCY])
const TIMED_PLAN_FREQUENCY_ALIASES = new Set([TIMED_PLAN_FREQUENCY, 'scheduled-time', 'scheduledat', 'scheduled_at', 'timed', 'datetime'])
const isPostgresRuntime = Boolean(process.env.DATABASE_URL)

let rebillFetchForTest = null

export function setRebillFetchForTest(fetchImpl) {
  rebillFetchForTest = typeof fetchImpl === 'function' ? fetchImpl : null
}

function rebillFetch() {
  return rebillFetchForTest || fetch
}

function cleanString(value, maxLength = 1000) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeMode(value) {
  return cleanString(value, 20).toLowerCase() === 'live' ? 'live' : 'test'
}

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return !['0', 'false', 'off', 'no'].includes(cleanString(value, 20).toLowerCase())
}

function normalizeCurrency(value) {
  const currency = cleanString(value || DEFAULT_CURRENCY, 3).toUpperCase()
  return /^[A-Z]{3}$/.test(currency) ? currency : DEFAULT_CURRENCY
}

function timestampSql(expression) {
  return isPostgresRuntime ? expression : `datetime(${expression})`
}

function timestampComparisonPlaceholder() {
  return isPostgresRuntime ? '?::timestamp' : 'datetime(?)'
}

function dateOnlySql(expression) {
  return isPostgresRuntime ? `(${expression})::date` : `DATE(${expression})`
}

function dateOnlyPlaceholder() {
  return isPostgresRuntime ? '?::date' : 'DATE(?)'
}

function staleProcessingSql(column) {
  return isPostgresRuntime
    ? `${column} < CURRENT_TIMESTAMP - INTERVAL '10 minutes'`
    : `${column} < datetime('now', '-10 minutes')`
}

function normalizeDateOnly(value, timezone = ACCOUNT_DEFAULT_TIMEZONE) {
  return normalizeDateOnlyInTimezone(value, timezone)
}

function todayDateOnly(timezone = ACCOUNT_DEFAULT_TIMEZONE) {
  return businessTodayDateOnly(timezone)
}

function assertDateNotInPast(value, message, timezone = ACCOUNT_DEFAULT_TIMEZONE) {
  return assertDateOnlyNotInPast(value, timezone, message)
}

function normalizePlanFrequency(value, fallback = 'custom') {
  const normalized = cleanString(value || fallback, 40).toLowerCase().replace(/[\s-]+/g, '_')
  if (TIMED_PLAN_FREQUENCY_ALIASES.has(normalized)) return TIMED_PLAN_FREQUENCY
  return PLAN_FREQUENCIES.has(normalized) ? normalized : fallback
}

function isTimedPlanFrequency(value) {
  return normalizePlanFrequency(value) === TIMED_PLAN_FREQUENCY
}

function hasExplicitPlanTime(value) {
  const clean = cleanString(value, 120)
  const match = clean.match(/[T ](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!match) return false
  return !(match[1] === '00' && match[2] === '00' && (!match[3] || match[3] === '00'))
}

function shouldUseExactPlanTime(value, frequency) {
  return isTimedPlanFrequency(frequency) || hasExplicitPlanTime(value)
}

function assertPlanDueDateNotInPast(value, frequency, message, timezone = ACCOUNT_DEFAULT_TIMEZONE) {
  if (shouldUseExactPlanTime(value, frequency)) return assertLocalDateTimeNotInPast(value, timezone, message)
  return assertDateNotInPast(value, message, timezone)
}

function normalizePlanDueDate(value, frequency, timezone = ACCOUNT_DEFAULT_TIMEZONE) {
  if (value === null || value === undefined || value === '') return null
  if (shouldUseExactPlanTime(value, frequency)) return normalizeToUtcIso(value, timezone)
  return normalizeDateOnly(value, timezone)
}

function isPlanChargeDueNow(value, frequency, timezone = ACCOUNT_DEFAULT_TIMEZONE) {
  if (!value) return false
  if (!shouldUseExactPlanTime(value, frequency)) return normalizeDateOnly(value, timezone) <= todayDateOnly(timezone)
  const utcIso = normalizeToUtcIso(value, timezone)
  const timestamp = Date.parse(utcIso)
  return Number.isFinite(timestamp) && timestamp <= Date.now()
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

function assertRebillCurrency(value) {
  const currency = normalizeCurrency(value)
  if (!REBILL_SUPPORTED_CURRENCIES.has(currency)) {
    const error = new Error('Rebill SDK acepta ARS, BRL, CLP, COP, MXN o USD para checkout instantaneo. Cambia la moneda de la cuenta o usa otra pasarela.')
    error.status = 400
    throw error
  }
  return currency
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

function normalizePositiveAmount(value, fallback = 25) {
  const amount = Number(value)
  if (Number.isFinite(amount) && amount > 0) return Math.round(amount * 100) / 100
  return Math.round(Number(fallback || 25) * 100) / 100
}

function buildPaymentUrl(baseUrl, publicPaymentId) {
  const cleanBase = cleanString(baseUrl, 2000).replace(/\/+$/, '')
  return cleanBase ? `${cleanBase}/pay/${encodeURIComponent(publicPaymentId)}` : ''
}

function normalizeWebhookBaseUrl(value) {
  const clean = cleanString(value, 2000).replace(/\/+$/, '')
  if (!clean) return ''
  try {
    const parsed = new URL(clean)
    const host = parsed.hostname.toLowerCase()
    if (parsed.protocol !== 'https:') return ''
    if (['localhost', '127.0.0.1', '::1'].includes(host) || host.endsWith('.local')) return ''
    return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function buildWebhookUrl(baseUrl) {
  const normalized = normalizeWebhookBaseUrl(baseUrl)
  return normalized ? `${normalized}${REBILL_WEBHOOK_PATH}` : ''
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function decryptSecret(value) {
  const clean = cleanString(value, 5000)
  if (!clean) return ''
  return isEncrypted(clean) ? decrypt(clean) : clean
}

function encryptOptionalSecret(value) {
  const clean = cleanString(value, 5000)
  return clean ? encrypt(clean) : ''
}

function previewSecret(value = '') {
  const clean = cleanString(value, 5000)
  if (!clean) return ''
  if (clean.length <= 10) return '****'
  return `${clean.slice(0, 6)}****${clean.slice(-4)}`
}

function isMaskedSecret(value = '') {
  const clean = cleanString(value, 5000)
  return Boolean(clean && (clean.includes('•') || clean.includes('*') || /^x+$/i.test(clean)))
}

function looksLikeRebillPublicKey(value = '') {
  const clean = cleanString(value, 5000)
  return !isMaskedSecret(clean) && /^pk_[a-z0-9_ -]{16,}$/i.test(clean)
}

function looksLikeRebillSecretKey(value = '') {
  const clean = cleanString(value, 5000)
  return !isMaskedSecret(clean) && /^sk_[a-z0-9_ -]{16,}$/i.test(clean)
}

function normalizeStoredConnection(value = {}, mode = 'test', { includeSecrets = false } = {}) {
  if (!value || typeof value !== 'object') {
    return {
      mode: normalizeMode(mode),
      configured: false,
      accountLabel: '',
      publicKey: '',
      secretKey: includeSecrets ? '' : undefined,
      hasPublicKey: false,
      hasSecretKey: false,
      secretKeyPreview: '',
      webhookId: '',
      webhookUrl: '',
      webhookConfigured: false,
      webhookStatus: '',
      webhookLastError: '',
      webhookSyncedAt: '',
      connectedAt: '',
      updatedAt: ''
    }
  }

  const publicKey = cleanString(value.publicKey || value.public_key, 5000)
  const secretKey = decryptSecret(value.secretKey || value.secret_key)
  const webhookStatus = cleanString(value.webhookStatus || value.webhook_status, 80)

  return {
    mode: normalizeMode(value.mode || mode),
    configured: Boolean(publicKey && secretKey),
    accountLabel: cleanString(value.accountLabel || value.account_label, 180),
    publicKey,
    secretKey: includeSecrets ? secretKey : undefined,
    hasPublicKey: Boolean(publicKey),
    hasSecretKey: Boolean(secretKey),
    secretKeyPreview: previewSecret(secretKey),
    webhookId: cleanString(value.webhookId || value.webhook_id, 180),
    webhookUrl: cleanString(value.webhookUrl || value.webhook_url, 2000),
    webhookConfigured: Boolean(value.webhookConfigured || value.webhook_configured || webhookStatus === 'configured'),
    webhookStatus,
    webhookLastError: cleanString(value.webhookLastError || value.webhook_last_error, 500),
    webhookSyncedAt: cleanString(value.webhookSyncedAt || value.webhook_synced_at, 80),
    connectedAt: cleanString(value.connectedAt || value.connected_at, 80),
    updatedAt: cleanString(value.updatedAt || value.updated_at, 80)
  }
}

function readModeConnections(raw = {}) {
  const parsed = parseJson(raw[CONFIG_KEYS.modeConnections], {})
  return {
    test: normalizeStoredConnection(parsed.test, 'test', { includeSecrets: true }),
    live: normalizeStoredConnection(parsed.live, 'live', { includeSecrets: true })
  }
}

function getModeConnection(raw = {}, mode = 'test') {
  const normalizedMode = normalizeMode(mode)
  const connections = readModeConnections(raw)
  if (connections[normalizedMode]?.configured) return connections[normalizedMode]

  const legacyMode = normalizeMode(raw[CONFIG_KEYS.mode])
  const legacyPublicKey = cleanString(raw[CONFIG_KEYS.publicKey], 5000)
  const legacySecretKey = decryptSecret(raw[CONFIG_KEYS.secretKey])
  if (legacyMode === normalizedMode && legacyPublicKey && legacySecretKey) {
    return normalizeStoredConnection({
      mode: normalizedMode,
      accountLabel: raw[CONFIG_KEYS.accountLabel],
      publicKey: legacyPublicKey,
      secretKey: raw[CONFIG_KEYS.secretKey]
    }, normalizedMode, { includeSecrets: true })
  }

  return normalizeStoredConnection(null, normalizedMode, { includeSecrets: true })
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

function summarizeModeConnection(raw = {}, mode = 'test') {
  const connection = getModeConnection(raw, mode)
  return {
    mode: normalizeMode(mode),
    connected: Boolean(connection?.configured),
    configured: Boolean(connection?.configured),
    accountLabel: cleanString(connection?.accountLabel, 180),
    publicKey: cleanString(connection?.publicKey, 5000),
    hasPublicKey: Boolean(connection?.hasPublicKey),
    hasSecretKey: Boolean(connection?.hasSecretKey),
    secretKeyPreview: cleanString(connection?.secretKeyPreview, 80),
    webhookId: cleanString(connection?.webhookId, 180) || null,
    webhookUrl: cleanString(connection?.webhookUrl, 2000) || null,
    webhookConfigured: Boolean(connection?.webhookConfigured),
    webhookStatus: cleanString(connection?.webhookStatus, 80) || null,
    webhookLastError: cleanString(connection?.webhookLastError, 500) || null,
    webhookSyncedAt: cleanString(connection?.webhookSyncedAt, 80) || null,
    connectedAt: cleanString(connection?.connectedAt, 80) || null,
    updatedAt: cleanString(connection?.updatedAt, 80) || null
  }
}

function mapConfig(raw = {}, { includeSecrets = false, mode: modeOverride = '' } = {}) {
  const mode = normalizeMode(modeOverride || raw[CONFIG_KEYS.mode])
  const selected = getModeConnection(raw, mode)
  const publicKey = cleanString(selected?.publicKey, 5000)
  const secretKey = cleanString(selected?.secretKey, 5000)
  const enabled = normalizeBoolean(raw[CONFIG_KEYS.enabled], true)
  const configured = Boolean(enabled && publicKey && secretKey)

  return {
    enabled,
    configured,
    mode,
    defaultCurrency: normalizeCurrency(raw[CONFIG_KEYS.defaultCurrency] || DEFAULT_CURRENCY),
    accountLabel: cleanString(selected?.accountLabel || raw[CONFIG_KEYS.accountLabel], 180),
    publicKey,
    hasPublicKey: Boolean(publicKey),
    hasSecretKey: Boolean(secretKey),
    secretKeyPreview: previewSecret(secretKey),
    connectedAt: cleanString(selected?.connectedAt, 80) || null,
    disconnectedAt: raw[CONFIG_KEYS.disconnectedAt] || null,
    webhookId: cleanString(selected?.webhookId, 180) || null,
    webhookUrl: cleanString(selected?.webhookUrl, 2000) || null,
    webhookConfigured: Boolean(selected?.webhookConfigured),
    webhookStatus: cleanString(selected?.webhookStatus, 80) || null,
    webhookLastError: cleanString(selected?.webhookLastError, 500) || null,
    webhookSyncedAt: cleanString(selected?.webhookSyncedAt, 80) || null,
    modeConnections: {
      test: summarizeModeConnection(raw, 'test'),
      live: summarizeModeConnection(raw, 'live')
    },
    ...(includeSecrets ? { secretKey } : {})
  }
}

export async function getRebillPaymentConfig({ includeSecrets = false, mode: modeOverride = '' } = {}) {
  const raw = await readRawConfig()
  const mode = modeOverride || await getPaymentGatewayMode()
  return mapConfig(raw, { includeSecrets, mode })
}

async function rebillApiRequest(path, { method = 'GET', body = null, apiKey = '', config: configOverride = null } = {}) {
  const config = configOverride || await getRebillClientConfig()
  const secretKey = cleanString(apiKey || config.secretKey, 5000)
  const url = path.startsWith('http') ? path : `${REBILL_API_BASE}${path}`
  const headers = {
    Accept: 'application/json',
    'x-api-key': secretKey
  }
  if (body !== null && body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await rebillFetch()(url, {
    method,
    headers,
    body: body !== null && body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await response.text().catch(() => '')
  let payload = {}
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    payload = text ? { message: text } : {}
  }

  if (!response.ok) {
    const message = cleanString(payload.message || payload.error || payload.error_message || payload.detail, 500) ||
      'Rebill no pudo completar la solicitud.'
    const error = new Error(message)
    error.status = response.status || 502
    error.payload = payload
    throw error
  }

  return { payload, config }
}

async function validateRebillSecretKey(secretKey) {
  const { payload } = await rebillApiRequest('/v3/organizations/me', { apiKey: secretKey, config: { secretKey } })
  return payload
}

function normalizeWebhookEvents(events = []) {
  const normalized = Array.isArray(events) ? events.map((event) => cleanString(event, 80)) : []
  return REBILL_WEBHOOK_EVENTS.every((event) => normalized.includes(event)) && normalized.length >= REBILL_WEBHOOK_EVENTS.length
}

async function findExistingWebhook(config, webhookUrl) {
  if (config.webhookId) {
    try {
      const { payload } = await rebillApiRequest(`/v3/webhooks/${encodeURIComponent(config.webhookId)}`, { config })
      if (payload?.id) return payload
    } catch (error) {
      if (Number(error.status) !== 404) throw error
    }
  }

  const { payload } = await rebillApiRequest('/v3/webhooks/search', {
    method: 'POST',
    body: { limit: 100 },
    config
  })
  const records = Array.isArray(payload?.records) ? payload.records : []
  return records.find((record) => cleanString(record?.url, 2000).replace(/\/+$/, '') === webhookUrl) || null
}

async function ensureRebillWebhookConfigured(config, baseUrl = '') {
  const webhookUrl = buildWebhookUrl(baseUrl)
  if (!webhookUrl) {
    return {
      webhookId: cleanString(config.webhookId, 180),
      webhookUrl: cleanString(config.webhookUrl, 2000),
      webhookConfigured: false,
      webhookStatus: 'pending_public_url',
      webhookLastError: '',
      webhookSyncedAt: ''
    }
  }

  try {
    const existing = await findExistingWebhook(config, webhookUrl)
    const needsUpdate = existing?.id && (
      cleanString(existing.url, 2000).replace(/\/+$/, '') !== webhookUrl ||
      existing.active !== true ||
      !normalizeWebhookEvents(existing.events)
    )
    const webhook = existing?.id
      ? needsUpdate
        ? (await rebillApiRequest(`/v3/webhooks/${encodeURIComponent(existing.id)}`, {
            method: 'PATCH',
            body: { url: webhookUrl, events: REBILL_WEBHOOK_EVENTS, active: true },
            config
          })).payload
        : existing
      : (await rebillApiRequest('/v3/webhooks', {
          method: 'POST',
          body: { url: webhookUrl, events: REBILL_WEBHOOK_EVENTS },
          config
        })).payload

    return {
      webhookId: cleanString(webhook?.id, 180),
      webhookUrl,
      webhookConfigured: Boolean(webhook?.id),
      webhookStatus: webhook?.active === false ? 'inactive' : 'configured',
      webhookLastError: '',
      webhookSyncedAt: new Date().toISOString()
    }
  } catch (error) {
    logger.warn(`No se pudo configurar webhook Rebill: ${error.message}`)
    return {
      webhookId: cleanString(config.webhookId, 180),
      webhookUrl,
      webhookConfigured: false,
      webhookStatus: 'error',
      webhookLastError: cleanString(error.message, 500),
      webhookSyncedAt: ''
    }
  }
}

function resolveCredentialInput(input = {}, previous = {}) {
  const submittedPublicKey = cleanString(input.publicKey || input.public_key, 5000)
  const submittedSecretKey = cleanString(input.secretKey || input.secret_key, 5000)

  return {
    publicKey: submittedPublicKey && !isMaskedSecret(submittedPublicKey)
      ? submittedPublicKey
      : cleanString(previous.publicKey, 5000),
    secretKey: submittedSecretKey && !isMaskedSecret(submittedSecretKey)
      ? submittedSecretKey
      : cleanString(previous.secretKey, 5000),
    accountLabel: cleanString(input.accountLabel || input.account_label || previous.accountLabel, 180)
  }
}

export async function saveRebillPaymentConfig(input = {}, { baseUrl = '' } = {}) {
  const raw = await readRawConfig()
  const requestedMode = normalizeMode(input.mode || await getPaymentGatewayMode())
  const enabled = normalizeBoolean(input.enabled, true)
  const now = new Date().toISOString()
  const storedConnections = parseJson(raw[CONFIG_KEYS.modeConnections], {})
  const connections = {
    test: storedConnections.test || null,
    live: storedConnections.live || null
  }

  if (input.disconnectMode || input.disconnect_mode) {
    connections[requestedMode] = null
    const otherMode = requestedMode === 'live' ? 'test' : 'live'
    const otherConnection = normalizeStoredConnection(connections[otherMode], otherMode, { includeSecrets: true })
    const nextMode = otherConnection.configured ? otherMode : requestedMode

    await setAppConfig(CONFIG_KEYS.enabled, otherConnection.configured ? '1' : '0')
    await setAppConfig(CONFIG_KEYS.mode, nextMode)
    await setAppConfig(CONFIG_KEYS.defaultCurrency, normalizeCurrency(raw[CONFIG_KEYS.defaultCurrency] || DEFAULT_CURRENCY))
    await setAppConfig(CONFIG_KEYS.accountLabel, otherConnection.accountLabel || '')
    await setAppConfig(CONFIG_KEYS.publicKey, otherConnection.publicKey || '')
    await setAppConfig(CONFIG_KEYS.secretKey, otherConnection.secretKey ? encryptOptionalSecret(otherConnection.secretKey) : '')
    await setAppConfig(CONFIG_KEYS.modeConnections, JSON.stringify({ test: connections.test, live: connections.live }))
    if (!otherConnection.configured) await setAppConfig(CONFIG_KEYS.disconnectedAt, now)

    return getRebillPaymentConfig({ mode: nextMode })
  }

  const previous = getModeConnection(raw, requestedMode)
  const credentials = resolveCredentialInput(input, previous)
  const publicKey = cleanString(credentials.publicKey, 5000)
  const secretKey = cleanString(credentials.secretKey, 5000)

  if (enabled && (!publicKey || !secretKey)) {
    const error = new Error('Agrega la public key pk_ y secret key sk_ de Rebill para conectar esta pasarela.')
    error.status = 400
    throw error
  }
  if (publicKey && !looksLikeRebillPublicKey(publicKey)) {
    const error = new Error('La public key de Rebill debe empezar con pk_.')
    error.status = 400
    throw error
  }
  if (secretKey && !looksLikeRebillSecretKey(secretKey)) {
    const error = new Error('La secret key de Rebill debe empezar con sk_.')
    error.status = 400
    throw error
  }

  const organization = secretKey ? await validateRebillSecretKey(secretKey) : null
  const accountLabel = credentials.accountLabel ||
    cleanString(organization?.name || organization?.alias, 180) ||
    (requestedMode === 'live' ? 'Rebill en vivo' : 'Rebill prueba')
  const baseConnection = {
    mode: requestedMode,
    accountLabel,
    publicKey,
    secretKey,
    webhookId: previous.webhookId,
    webhookUrl: previous.webhookUrl,
    webhookConfigured: previous.webhookConfigured,
    webhookStatus: previous.webhookStatus,
    webhookLastError: previous.webhookLastError,
    webhookSyncedAt: previous.webhookSyncedAt,
    connectedAt: previous.connectedAt || now,
    updatedAt: now
  }
  const webhook = await ensureRebillWebhookConfigured(baseConnection, baseUrl)

  connections[requestedMode] = {
    ...baseConnection,
    secretKey: secretKey ? encryptOptionalSecret(secretKey) : '',
    ...webhook
  }

  const defaultCurrency = normalizeCurrency(input.defaultCurrency || input.default_currency || raw[CONFIG_KEYS.defaultCurrency] || await getConfiguredCurrency())
  await setAppConfig(CONFIG_KEYS.enabled, enabled ? '1' : '0')
  await setAppConfig(CONFIG_KEYS.mode, requestedMode)
  await setAppConfig(CONFIG_KEYS.defaultCurrency, defaultCurrency)
  await setAppConfig(CONFIG_KEYS.accountLabel, accountLabel)
  await setAppConfig(CONFIG_KEYS.publicKey, publicKey)
  await setAppConfig(CONFIG_KEYS.secretKey, secretKey ? encryptOptionalSecret(secretKey) : '')
  await setAppConfig(CONFIG_KEYS.modeConnections, JSON.stringify({ test: connections.test, live: connections.live }))

  return getRebillPaymentConfig({ mode: requestedMode })
}

export async function deleteRebillPaymentConfig() {
  await db.run(
    `DELETE FROM app_config
     WHERE config_key IN (${Object.values(CONFIG_KEYS).map(() => '?').join(', ')})`,
    Object.values(CONFIG_KEYS)
  )
  return getRebillPaymentConfig()
}

async function getRebillClientConfig(mode = '') {
  const config = await getRebillPaymentConfig({ includeSecrets: true, mode })
  if (!config.configured || !config.publicKey || !config.secretKey) {
    const error = new Error('Rebill no está configurado.')
    error.status = 400
    throw error
  }
  return config
}

export async function testRebillPaymentConfig(input = null) {
  const mode = normalizeMode(input?.mode || await getPaymentGatewayMode())
  const previous = await getRebillPaymentConfig({ includeSecrets: true, mode })
  const credentials = resolveCredentialInput(input || {}, previous)
  const publicKey = cleanString(credentials.publicKey, 5000)
  const secretKey = cleanString(credentials.secretKey, 5000)

  if (!publicKey || !secretKey) {
    const error = new Error('Agrega la public key pk_ y secret key sk_ de Rebill para validar la conexión.')
    error.status = 400
    throw error
  }
  if (!looksLikeRebillPublicKey(publicKey) || !looksLikeRebillSecretKey(secretKey)) {
    const error = new Error('Las llaves de Rebill deben empezar con pk_ y sk_.')
    error.status = 400
    throw error
  }

  const organization = await validateRebillSecretKey(secretKey)
  return {
    ok: true,
    mode,
    accountLabel: cleanString(credentials.accountLabel || organization?.name || organization?.alias, 180),
    publicKeyPreview: previewSecret(publicKey),
    secretKeyPreview: previewSecret(secretKey),
    organization: {
      id: cleanString(organization?.id, 180),
      name: cleanString(organization?.name, 180),
      alias: cleanString(organization?.alias, 180),
      status: cleanString(organization?.status, 80),
      environment: cleanString(organization?.environment, 80)
    },
    message: 'Rebill respondió correctamente con esta secret key.'
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

async function findPaymentByRebillPaymentId(rebillPaymentId) {
  return db.get(
    `SELECT
      p.*,
      c.full_name AS contact_name,
      c.email AS contact_email,
      c.phone AS contact_phone
     FROM payments p
     LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE p.rebill_payment_id = ?`,
    [rebillPaymentId]
  )
}

function timestampToIso(value) {
  const clean = cleanString(value, 120)
  if (!clean) return null
  const timestamp = Date.parse(clean)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : clean
}

function sanitizeLocalizedText(value, fallback = 'Pago Ristak', maxLength = 180) {
  const raw = cleanString(value || fallback, maxLength).replace(/\s+/g, ' ').trim()
  return raw || fallback
}

function buildInstantProduct(row, metadata = {}) {
  const title = sanitizeLocalizedText(row.title || metadata.title || 'Pago Ristak', 'Pago Ristak', 140)
  const description = sanitizeLocalizedText(row.description || title, title, 300)
  return {
    name: [{ language: 'es', text: title }],
    description: description ? [{ language: 'es', text: description }] : [],
    amount: normalizePositiveAmount(row.amount),
    currency: assertRebillCurrency(row.currency),
    metadata: {
      ristakPaymentId: cleanString(row.id, 180),
      publicPaymentId: cleanString(row.public_payment_id, 180),
      provider: 'rebill',
      source: cleanString(metadata.source || 'ristak', 120)
    }
  }
}

function buildCustomerInformation(row, metadata = {}) {
  const fullName = cleanString(row.contact_name || metadata.contactName, 120)
  const email = cleanString(row.contact_email || metadata.contactEmail, 180)
  const phone = cleanString(row.contact_phone || metadata.contactPhone, 80)
  const customer = {}
  if (email) customer.email = email
  if (fullName && !/\d/.test(fullName)) customer.fullName = fullName
  if (phone) {
    customer.phoneNumber = {
      number: phone.replace(/[^\d+]/g, ''),
      countryCode: ''
    }
  }
  return Object.keys(customer).length ? customer : null
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

function isManualPlanPaymentMethod(method) {
  return MANUAL_PLAN_PAYMENT_METHODS.has(cleanString(method, 80).toLowerCase())
}

function normalizeManualPaymentMethod(method) {
  const normalized = cleanString(method, 80).toLowerCase()
  if (normalized === 'transfer') return 'bank_transfer'
  if (normalized === 'offline') return 'other'
  return normalized || 'other'
}

function normalizeRebillPlanPaymentMethod(value) {
  const method = cleanString(value || 'rebill_checkout', 80).toLowerCase()
  if (REBILL_CHECKOUT_METHODS.has(method)) {
    return {
      automatic: 1,
      installmentMethod: 'rebill_checkout',
      paymentMethod: 'rebill_checkout',
      status: 'scheduled',
      paymentStatus: 'scheduled',
      notes: 'Ristak liberará el link de Rebill cuando llegue la fecha programada.'
    }
  }

  if (!MANUAL_PLAN_PAYMENT_METHODS.has(method)) {
    const error = new Error('Forma de cobro inválida para la parcialidad Rebill.')
    error.status = 400
    throw error
  }

  const manualMethod = normalizeManualPaymentMethod(method)
  return {
    automatic: 0,
    installmentMethod: manualMethod,
    paymentMethod: manualMethod,
    status: 'pending',
    paymentStatus: 'pending',
    notes: 'Pago manual dentro del plan.'
  }
}

function normalizeRebillFirstPaymentMethod(value, dueNow = true) {
  const method = cleanString(value || 'rebill_checkout', 80).toLowerCase()
  if (REBILL_CHECKOUT_METHODS.has(method)) {
    return {
      flowMethod: 'payment_link',
      paymentMethod: 'rebill_checkout',
      flowStatus: dueNow ? 'pending' : 'scheduled',
      paymentStatus: dueNow ? 'sent' : 'scheduled',
      linkAvailable: dueNow
    }
  }

  if (!MANUAL_PLAN_PAYMENT_METHODS.has(method)) {
    const error = new Error('Forma de cobro inválida para el primer pago Rebill.')
    error.status = 400
    throw error
  }

  const manualMethod = normalizeManualPaymentMethod(method)
  return {
    flowMethod: manualMethod,
    paymentMethod: manualMethod,
    flowStatus: 'registered',
    paymentStatus: 'paid',
    linkAvailable: false
  }
}

function getRebillPlanRecurrenceLabel(value) {
  const frequency = normalizePlanFrequency(value || 'custom')
  if (frequency === TIMED_PLAN_FREQUENCY) return 'Hora programada'
  if (frequency === 'weekly') return 'Semanal'
  if (frequency === 'biweekly') return 'Quincenal'
  if (frequency === 'monthly') return 'Mensual'
  if (frequency === 'daily') return 'Diaria'
  if (frequency === 'yearly') return 'Anual'
  return 'Personalizada'
}

function getRebillPlanMirrorStatus(flow = {}) {
  const state = cleanString(flow.current_state, 80).toLowerCase()
  if (state === REBILL_PLAN_STATES.COMPLETED) return 'completed'
  if (state === REBILL_PLAN_STATES.DELETED || state === 'deleted') return 'deleted'
  if (state === REBILL_PLAN_STATES.PAUSED || state === 'paused') return 'paused'
  if (state === REBILL_PLAN_STATES.CANCELLED || ['cancelled', 'canceled', 'void'].includes(state)) return 'cancelled'
  return 'active'
}

function getVisiblePlanPaymentNumber(sequence, hasFirstPayment) {
  const normalizedSequence = Number(sequence || 1)
  const safeSequence = Number.isFinite(normalizedSequence) && normalizedSequence > 0 ? normalizedSequence : 1
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
  const safePaymentNumber = Number.isFinite(normalizedPaymentNumber) && normalizedPaymentNumber > 0 ? normalizedPaymentNumber : 1
  const safeTotal = normalizePlanPaymentTotal(totalPayments, safePaymentNumber)
  return `${cleanString(baseTitle, 140) || 'Plan de pagos'} - Pago ${safePaymentNumber}/${safeTotal}`
}

function buildPlanFirstPaymentTitle(baseTitle, totalPayments) {
  return buildPlanPaymentTitle(baseTitle, 1, totalPayments)
}

function buildPlanInstallmentPaymentTitle(baseTitle, sequence, hasFirstPayment, totalPayments) {
  return buildPlanPaymentTitle(baseTitle, getVisiblePlanPaymentNumber(sequence, hasFirstPayment), totalPayments)
}

function validateRebillPaymentPlanPayload(input = {}, timezone = ACCOUNT_DEFAULT_TIMEZONE) {
  const contact = input.contact || {}
  if (!cleanString(contact.id, 180)) {
    const error = new Error('Selecciona un contacto para el plan de pagos Rebill.')
    error.status = 400
    throw error
  }

  const totalAmount = normalizePositiveAmount(input.totalAmount, 0)
  if (totalAmount <= 0) {
    const error = new Error('El total del plan debe ser mayor a 0.')
    error.status = 400
    throw error
  }

  const remainingPayments = Array.isArray(input.remainingPayments) ? input.remainingPayments : []
  if (!remainingPayments.length) {
    const error = new Error('Agrega al menos una parcialidad programada.')
    error.status = 400
    throw error
  }

  const currency = assertRebillCurrency(input.currency || DEFAULT_CURRENCY)
  const remainingFrequency = normalizePlanFrequency(input.remainingFrequency || 'custom')
  const firstPaymentEnabled = input.firstPayment?.enabled !== false && Number(input.firstPayment?.amount || 0) > 0
  const firstPaymentFrequency = normalizePlanFrequency(input.firstPayment?.frequency || remainingFrequency)
  const firstPaymentAmount = firstPaymentEnabled ? normalizePositiveAmount(input.firstPayment?.amount, 0) : 0
  const firstPaymentMethod = firstPaymentEnabled ? cleanString(input.firstPayment?.method || 'rebill_checkout', 80).toLowerCase() : 'none'
  const firstPaymentDate = firstPaymentEnabled
    ? normalizePlanDueDate(input.firstPayment?.date || todayDateOnly(timezone), firstPaymentFrequency, timezone)
    : null

  if (firstPaymentEnabled && !isManualPlanPaymentMethod(firstPaymentMethod)) {
    assertPlanDueDateNotInPast(firstPaymentDate, firstPaymentFrequency, 'El primer pago Rebill no puede programarse en una fecha pasada.', timezone)
  }

  const normalizedRemaining = remainingPayments.map((payment, index) => {
    const frequency = normalizePlanFrequency(payment.frequency || remainingFrequency)
    const dueDate = normalizePlanDueDate(payment.dueDate || payment.date || payment.scheduledAt, frequency, timezone)
    const amount = normalizePositiveAmount(payment.amount, 0)
    if (amount <= 0) {
      const error = new Error(`La parcialidad ${index + 1} necesita un monto mayor a 0.`)
      error.status = 400
      throw error
    }
    assertPlanDueDateNotInPast(dueDate, frequency, 'Los pagos futuros de Rebill no pueden programarse en fechas pasadas.', timezone)

    return {
      sequence: Number(payment.sequence || index + 1),
      amount,
      percentage: payment.percentage === null || payment.percentage === undefined ? null : Number(payment.percentage),
      dueDate,
      frequency,
      paymentMethod: cleanString(payment.paymentMethod || payment.method || 'rebill_checkout', 80)
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
      id: cleanString(contact.id, 180),
      name: cleanString(contact.name || contact.fullName || contact.contactName, 180),
      email: cleanString(contact.email, 180),
      phone: cleanString(contact.phone, 80)
    },
    totalAmount: Math.round(totalAmount * 100) / 100,
    currency,
    title: cleanString(input.title || input.invoicePayload?.title || input.invoicePayload?.name || input.description || 'Plan de pagos', 180),
    description: cleanString(input.description || input.concept || input.title || 'Plan de pagos', 500),
    firstPayment: {
      enabled: firstPaymentEnabled,
      amount: Math.round(firstPaymentAmount * 100) / 100,
      date: firstPaymentDate,
      method: firstPaymentMethod,
      frequency: firstPaymentFrequency
    },
    remainingPayments: normalizedRemaining,
    remainingFrequency,
    timezone,
    lineItems: Array.isArray(input.invoicePayload?.items) ? input.invoicePayload.items : Array.isArray(input.lineItems) ? input.lineItems : [],
    invoicePayload: input.invoicePayload || {},
    source: cleanString(input.source || 'record_payment_modal_rebill_plan', 120)
  }
}

function buildRebillPlanPaymentMetadata(flow, installment, sequence, paymentMode, source = 'rebill_payment_plan_installment') {
  return {
    rebillMode: paymentMode || 'test',
    paymentMode: paymentMode || 'test',
    source,
    contactName: flow.contact_name,
    contactEmail: flow.contact_email,
    contactPhone: flow.contact_phone,
    paymentPlan: {
      flowId: flow.id,
      installmentId: installment?.id || null,
      sequence,
      trigger: installment?.trigger || 'scheduled_installment'
    }
  }
}

async function createRebillPlanPaymentRow({
  contact = {},
  amount,
  currency,
  status = 'scheduled',
  paymentMethod = 'rebill_checkout',
  title = 'Pago',
  description = 'Pago',
  dueDate = null,
  metadata = {},
  baseUrl = '',
  mode = ''
} = {}) {
  const config = await getRebillClientConfig(mode)
  const publicPaymentId = createPublicId()
  const id = createId('rebill_plan_payment')
  const now = new Date().toISOString()
  const paymentUrl = buildPaymentUrl(baseUrl, publicPaymentId)
  const linkAvailable = status !== 'scheduled' && REBILL_CHECKOUT_METHODS.has(cleanString(paymentMethod, 80).toLowerCase())

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, reference, title, description, date, due_date, sent_at,
      public_payment_id, payment_url, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'rebill', ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      id,
      cleanString(contact.id, 180) || null,
      normalizePositiveAmount(amount, 0),
      assertRebillCurrency(currency || config.defaultCurrency),
      status,
      paymentMethod,
      config.mode,
      publicPaymentId,
      cleanString(title, 180) || 'Pago',
      cleanString(description, 500) || cleanString(title, 180) || 'Pago',
      now,
      dueDate || null,
      linkAvailable ? now : null,
      publicPaymentId,
      linkAvailable ? paymentUrl : '',
      JSON.stringify(metadata)
    ]
  )

  return {
    payment: await findPaymentById(id),
    publicPaymentId,
    paymentUrl: linkAvailable ? paymentUrl : ''
  }
}

async function releaseRebillPlanPaymentLink(paymentId, { baseUrl = '', notes = '' } = {}) {
  const cleanPaymentId = cleanString(paymentId, 180)
  if (!cleanPaymentId) return null
  const row = await findPaymentById(cleanPaymentId)
  if (!row || row.payment_provider !== 'rebill') return null
  const paymentUrl = buildPaymentUrl(baseUrl, row.public_payment_id) || row.payment_url || ''
  if (!paymentUrl) {
    const error = new Error('No hay URL pública configurada para liberar el link Rebill programado.')
    error.status = 400
    throw error
  }

  await db.run(
    `UPDATE payments
     SET status = CASE WHEN status = 'scheduled' THEN 'sent' ELSE status END,
         payment_url = COALESCE(NULLIF(?, ''), payment_url),
         sent_at = COALESCE(sent_at, ?),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [paymentUrl, new Date().toISOString(), cleanPaymentId]
  )

  await db.run(
    `UPDATE installment_payments
     SET status = CASE
           WHEN LOWER(COALESCE(status, '')) IN ('scheduled', 'pending', 'processing') THEN 'sent'
           ELSE status
         END,
         notes = COALESCE(NULLIF(?, ''), notes),
         updated_at = CURRENT_TIMESTAMP
     WHERE payment_id = ?`,
    [cleanString(notes, 500), cleanPaymentId]
  )

  return findPaymentById(cleanPaymentId)
}

async function persistRebillPaymentPlanMirror(flowId, extra = {}) {
  const cleanFlowId = cleanString(flowId, 180)
  if (!cleanFlowId) return null

  const flow = await db.get('SELECT * FROM payment_flows WHERE id = ?', [cleanFlowId])
  if (!flow || flow.payment_provider !== 'rebill') return null

  const installments = await db.all(
    `SELECT *
     FROM installment_payments
     WHERE flow_id = ?
     ORDER BY sequence ASC`,
    [cleanFlowId]
  )
  const metadata = parseJson(flow.metadata, {})
  const visibleInstallments = (installments || []).filter((installment) => (
    !['cancelled', 'canceled', 'deleted', 'void'].includes(cleanString(installment.status, 80).toLowerCase())
  ))
  const nextInstallment = visibleInstallments.find((installment) => (
    !['paid', 'cancelled', 'canceled', 'deleted'].includes(cleanString(installment.status, 80).toLowerCase())
  )) || visibleInstallments[0] || null
  const lastInstallment = visibleInstallments[Math.max(0, visibleInstallments.length - 1)] || null
  const startDate = flow.first_payment_date || visibleInstallments[0]?.due_date || flow.created_at
  const nextRunAt = nextInstallment?.due_date || flow.first_payment_date || flow.created_at
  const itemCount = (Number(flow.first_payment_amount || 0) > 0 ? 1 : 0) + visibleInstallments.length
  const scheduleJson = {
    provider: 'rebill',
    flowId: cleanFlowId,
    remainingFrequency: metadata.remainingFrequency || 'custom',
    checkoutProvider: 'rebill',
    clockOwner: 'ristak',
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
      rebillPaymentId: installment.rebill_payment_id || null
    }))
  }
  const rawJson = {
    id: cleanFlowId,
    provider: 'rebill',
    paymentFlow: {
      id: cleanFlowId,
      state: flow.current_state,
      contactId: flow.contact_id,
      clockOwner: 'ristak'
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
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'rebill', CURRENT_TIMESTAMP, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
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
      source = 'rebill',
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
      getRebillPlanMirrorStatus(flow),
      Number(flow.total_amount || 0),
      flow.currency || DEFAULT_CURRENCY,
      flow.concept || 'Plan de pagos',
      getRebillPlanRecurrenceLabel(metadata.remainingFrequency),
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

function mapPublicPayment(row, config, baseUrl = '', settings = null, timezone = ACCOUNT_DEFAULT_TIMEZONE) {
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
    timezone,
    timeZone: timezone,
    paymentMode: row.payment_mode || config?.mode || 'test',
    provider: 'rebill',
    contact: {
      id: row.contact_id || '',
      name: row.contact_name || metadata.contactName || '',
      email: row.contact_email || metadata.contactEmail || '',
      phone: row.contact_phone || metadata.contactPhone || ''
    },
    publicKey: config?.publicKey || '',
    rebillPaymentId: row.rebill_payment_id || metadata.rebill?.paymentId || null,
    rebillSubscriptionId: row.rebill_subscription_id || metadata.rebill?.subscriptionId || null,
    instantProduct: buildInstantProduct(row, metadata),
    customerInformation: buildCustomerInformation(row, metadata),
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

export async function createRebillPaymentLink(input = {}, { baseUrl, mode = '' } = {}) {
  const config = await getRebillClientConfig(mode)
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
  const currency = assertRebillCurrency(input.currency || await getConfiguredCurrency())
  const publicPaymentId = createPublicId()
  const id = createId('rebill_payment')
  const now = new Date().toISOString()
  const paymentUrl = buildPaymentUrl(baseUrl, publicPaymentId)
  const contact = {
    id: cleanString(input.contactId, 160),
    name: cleanString(input.contactName, 180),
    email: cleanString(input.email, 180),
    phone: cleanString(input.phone, 80)
  }
  const metadata = {
    contactName: contact.name,
    contactEmail: contact.email,
    contactPhone: contact.phone,
    source: cleanString(input.source || 'ristak', 120),
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
      contact.id || null,
      normalizePositiveAmount(chargeAmount),
      currency,
      'sent',
      'rebill_checkout',
      config.mode,
      'rebill',
      publicPaymentId,
      cleanString(input.title, 180) || 'Pago',
      cleanString(input.description, 500) || cleanString(input.title, 180) || 'Pago',
      now,
      input.dueDate || null,
      now,
      publicPaymentId,
      paymentUrl,
      JSON.stringify(metadata)
    ]
  )

  const row = await findPaymentById(id)
  return {
    payment: mapPublicPayment(row, config, baseUrl, paymentSettings),
    paymentUrl,
    publicPaymentId
  }
}

export async function createRebillPaymentPlan(input = {}, { baseUrl, mode = '' } = {}) {
  const config = await getRebillClientConfig(mode)
  const accountCurrency = await getConfiguredCurrency()
  const accountTimezone = await getAccountTimezone().catch(() => ACCOUNT_DEFAULT_TIMEZONE)
  const plan = validateRebillPaymentPlanPayload({ ...input, currency: input.currency || accountCurrency }, accountTimezone)
  const flowId = createId('rebill_flow')
  const now = new Date().toISOString()

  await db.run(
    `INSERT INTO payment_flows (
      id, contact_id, contact_name, contact_email, contact_phone,
      total_amount, currency, concept, payment_type,
      first_payment_amount, first_payment_type, first_payment_value,
      first_payment_date, first_payment_method, first_payment_status,
      remaining_automatic, card_setup_required, card_setup_amount,
      payment_provider, current_state, state_history,
      installment_plan_created_at, installment_plan_active_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'partial', ?, ?, ?, ?, ?, ?, 1, 0, 0, 'rebill', ?, ?, ?, ?, ?)`,
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
      plan.firstPayment.enabled ? 'pending' : 'not_required',
      REBILL_PLAN_STATES.ACTIVE,
      JSON.stringify(addPlanState([], REBILL_PLAN_STATES.ACTIVE)),
      now,
      now,
      JSON.stringify({
        source: plan.source,
        rebillMode: config.mode,
        paymentMode: config.mode,
        timezone: accountTimezone,
        remainingFrequency: plan.remainingFrequency,
        lineItems: plan.lineItems,
        checkoutProvider: 'rebill',
        clockOwner: 'ristak'
      })
    ]
  )

  const response = {
    flowId,
    currentState: REBILL_PLAN_STATES.ACTIVE,
    paymentMode: config.mode,
    firstPaymentLink: null,
    firstPaymentPaymentId: null,
    scheduledPayments: []
  }
  const planPaymentTotal = getPlanPaymentTotal(plan.firstPayment.enabled, plan.remainingPayments.length)
  const firstPaymentTitle = buildPlanFirstPaymentTitle(plan.title, planPaymentTotal)
  const firstPaymentDescription = buildPlanFirstPaymentTitle(plan.description, planPaymentTotal)

  if (plan.firstPayment.enabled) {
    const firstPaymentDueNow = isPlanChargeDueNow(plan.firstPayment.date, plan.firstPayment.frequency || plan.remainingFrequency, accountTimezone)
    const method = normalizeRebillFirstPaymentMethod(plan.firstPayment.method, firstPaymentDueNow)
    const first = await createRebillPlanPaymentRow({
      contact: plan.contact,
      amount: plan.firstPayment.amount,
      currency: plan.currency,
      status: method.paymentStatus,
      paymentMethod: method.paymentMethod,
      title: firstPaymentTitle,
      description: firstPaymentDescription,
      dueDate: plan.firstPayment.date,
      metadata: {
        rebillMode: config.mode,
        paymentMode: config.mode,
        source: method.linkAvailable ? 'rebill_payment_plan_first_link' : 'rebill_payment_plan_first_scheduled',
        contactName: plan.contact.name,
        contactEmail: plan.contact.email,
        contactPhone: plan.contact.phone,
        paymentPlan: {
          flowId,
          trigger: method.linkAvailable ? 'first_payment' : 'first_payment_scheduled'
        }
      },
      baseUrl,
      mode: config.mode
    })

    await db.run(
      `UPDATE payment_flows
       SET first_payment_status = ?,
           first_payment_invoice_id = ?,
           card_setup_payment_link = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [method.flowStatus, first.payment?.id || null, first.paymentUrl || null, flowId]
    )
    response.firstPaymentPaymentId = first.payment?.id || null
    response.firstPaymentLink = first.paymentUrl || null

    if (method.paymentStatus === 'paid') {
      updateSingleContactStats(plan.contact.id).catch((error) => {
        logger.warn(`No se pudieron actualizar stats del contacto por primer pago Rebill ${first.payment?.id}: ${error.message}`)
      })
    }
  }

  const flow = await db.get('SELECT * FROM payment_flows WHERE id = ?', [flowId])
  for (const payment of plan.remainingPayments) {
    const installmentId = createId('rebill_installment')
    const title = buildPlanInstallmentPaymentTitle(plan.title, payment.sequence, plan.firstPayment.enabled, planPaymentTotal)
    const method = normalizeRebillPlanPaymentMethod(payment.paymentMethod)
    const scheduled = await createRebillPlanPaymentRow({
      contact: plan.contact,
      amount: payment.amount,
      currency: plan.currency,
      status: method.paymentStatus,
      paymentMethod: method.paymentMethod,
      title,
      description: buildPlanInstallmentPaymentTitle(plan.description, payment.sequence, plan.firstPayment.enabled, planPaymentTotal),
      dueDate: payment.dueDate,
      metadata: buildRebillPlanPaymentMetadata(
        flow,
        { id: installmentId },
        payment.sequence,
        config.mode,
        'rebill_payment_plan_installment'
      ),
      baseUrl,
      mode: config.mode
    })

    await db.run(
      `INSERT INTO installment_payments (
        id, flow_id, sequence, amount, percentage, due_date, frequency,
        payment_method, automatic, status, payment_id, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        installmentId,
        flowId,
        payment.sequence,
        payment.amount,
        payment.percentage,
        payment.dueDate,
        payment.frequency,
        method.installmentMethod,
        method.automatic,
        method.status,
        scheduled.payment?.id || null,
        method.notes
      ]
    )

    response.scheduledPayments.push({
      installmentId,
      paymentId: scheduled.payment?.id || null,
      sequence: payment.sequence,
      amount: payment.amount,
      currency: plan.currency,
      dueDate: payment.dueDate,
      status: method.status
    })
  }

  await persistRebillPaymentPlanMirror(flowId, { response })
  return response
}

export async function processDueRebillPaymentPlanCharges({ limit = 25, baseUrl = '' } = {}) {
  await getRebillClientConfig()
  const accountTimezone = await getAccountTimezone().catch(() => ACCOUNT_DEFAULT_TIMEZONE)
  const dueDate = todayDateOnly(accountTimezone)
  const dueTimestamp = new Date().toISOString()
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 25, 100))
  const resolvedBaseUrl = cleanString(baseUrl, 2000) || cleanString(process.env.PUBLIC_APP_URL || process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL || process.env.RENDER_EXTERNAL_URL || '', 2000)
  const firstPaymentDueExpression = 'COALESCE(f.first_payment_date, p.due_date, p.date)'
  const firstPaymentDueSql = duePlanFirstPaymentCondition(firstPaymentDueExpression)
  const installmentDueSql = duePlanInstallmentCondition('i')
  const staleFirstPaymentSql = staleProcessingSql('f.updated_at')
  const staleInstallmentSql = staleProcessingSql('i.updated_at')

  const firstPaymentRows = await db.all(
    `SELECT
       f.id AS flow_id,
       f.first_payment_invoice_id AS payment_id,
       f.first_payment_date,
       f.metadata,
       p.status AS payment_status,
       p.due_date AS payment_due_date,
       p.date AS payment_date
     FROM payment_flows f
     JOIN payments p ON p.id = f.first_payment_invoice_id
     WHERE f.payment_provider = 'rebill'
       AND f.current_state = ?
       AND f.first_payment_invoice_id IS NOT NULL
       AND f.first_payment_method IN ('payment_link', 'card', 'rebill_checkout')
       AND (
         f.first_payment_status = 'scheduled'
         OR (f.first_payment_status = 'processing' AND ${staleFirstPaymentSql})
       )
       AND ${firstPaymentDueSql}
       AND p.status IN ('scheduled', 'pending', 'sent')
     ORDER BY COALESCE(f.first_payment_date, p.due_date, p.date) ASC
     LIMIT ?`,
    [REBILL_PLAN_STATES.ACTIVE, dueTimestamp, dueDate, normalizedLimit]
  )

  const rows = await db.all(
    `SELECT
       i.id AS installment_id,
       i.payment_id,
       i.due_date,
       i.frequency,
       i.status AS installment_status,
       f.id AS flow_id,
       p.status AS payment_status,
       p.payment_url
     FROM installment_payments i
     JOIN payment_flows f ON f.id = i.flow_id
     LEFT JOIN payments p ON p.id = i.payment_id
     WHERE f.payment_provider = 'rebill'
       AND f.current_state = ?
       AND i.automatic = 1
       AND i.payment_id IS NOT NULL
       AND (
         i.status IN ('scheduled', 'pending')
         OR (i.status = 'processing' AND ${staleInstallmentSql})
       )
       AND p.status IN ('scheduled', 'pending', 'sent')
       AND ${installmentDueSql}
     ORDER BY i.due_date ASC, i.sequence ASC
     LIMIT ?`,
    [REBILL_PLAN_STATES.ACTIVE, dueTimestamp, dueDate, normalizedLimit]
  )

  const results = []
  const touchedFlowIds = new Set()

  for (const row of firstPaymentRows || []) {
    const metadata = parseJson(row.metadata, {})
    const firstPaymentDueValue = row.first_payment_date || row.payment_due_date || row.payment_date
    if (!isPlanChargeDueNow(firstPaymentDueValue, metadata.remainingFrequency, accountTimezone)) continue

    touchedFlowIds.add(row.flow_id)
    try {
      const released = await releaseRebillPlanPaymentLink(row.payment_id, {
        baseUrl: resolvedBaseUrl,
        notes: 'Link de Rebill liberado automáticamente por fecha programada.'
      })
      await db.run(
        `UPDATE payment_flows
         SET first_payment_status = CASE WHEN first_payment_status = 'scheduled' THEN 'pending' ELSE first_payment_status END,
             card_setup_payment_link = COALESCE(NULLIF(?, ''), card_setup_payment_link),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [released?.payment_url || '', row.flow_id]
      )
      results.push({ type: 'first_payment', flowId: row.flow_id, paymentId: row.payment_id, generated: true, paymentUrl: released?.payment_url || '' })
    } catch (error) {
      logger.error(`[Rebill Planes] Error liberando primer pago ${row.payment_id}: ${error.message}`)
      if (!/No hay URL pública configurada/i.test(error.message || '')) {
        await db.run(
          `UPDATE payment_flows
           SET first_payment_status = 'failed',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [row.flow_id]
        )
      }
      results.push({ type: 'first_payment', flowId: row.flow_id, paymentId: row.payment_id, error: error.message })
    }
  }

  for (const row of rows || []) {
    touchedFlowIds.add(row.flow_id)
    try {
      const claim = await db.run(
        `UPDATE installment_payments
         SET status = 'processing',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND status IN ('scheduled', 'pending', 'processing')`,
        [row.installment_id]
      )
      if (!(Number(claim?.changes || 0) > 0)) continue

      const released = await releaseRebillPlanPaymentLink(row.payment_id, {
        baseUrl: resolvedBaseUrl,
        notes: 'Link de Rebill liberado automáticamente por fecha programada.'
      })
      results.push({ type: 'installment', flowId: row.flow_id, installmentId: row.installment_id, paymentId: row.payment_id, generated: true, paymentUrl: released?.payment_url || '' })
    } catch (error) {
      logger.error(`[Rebill Planes] Error liberando parcialidad ${row.installment_id}: ${error.message}`)
      const keepScheduled = /No hay URL pública configurada/i.test(error.message || '')
      await db.run(
        `UPDATE installment_payments
         SET status = ?,
             notes = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [keepScheduled ? (row.installment_status || 'scheduled') : 'failed', error.message || 'Rebill no pudo liberar el link.', row.installment_id]
      )
      results.push({ type: 'installment', flowId: row.flow_id, installmentId: row.installment_id, paymentId: row.payment_id, error: error.message })
    }
  }

  for (const flowId of touchedFlowIds) {
    await persistRebillPaymentPlanMirror(flowId)
  }

  return results
}

export async function getPublicRebillPayment(publicPaymentId, { baseUrl } = {}) {
  const row = await findPaymentByPublicId(publicPaymentId)
  if (!row || row.payment_provider !== 'rebill') return null

  const config = await getRebillPaymentConfig({ includeSecrets: true, mode: row.payment_mode || '' })
  const paymentSettings = await getPublicPaymentSettings()
  const timezone = await getAccountTimezone().catch(() => ACCOUNT_DEFAULT_TIMEZONE)
  return attachMetaPublicPurchaseEvent(
    mapPublicPayment(row, config, baseUrl, paymentSettings, timezone),
    row
  )
}

export function mapRebillStatus(status) {
  const normalized = cleanString(status, 80).toLowerCase()
  return mapGatewayPaymentStatus(normalized, {
    paidStatuses: ['approved', 'paid', 'succeeded', 'success', 'completed', 'complete', 'fulfilled'],
    pendingStatuses: ['pending', 'processing', 'in_process', 'authorized', 'pending_customer_charge', 'cancelled', 'canceled', 'expired'],
    failedStatuses: ['rejected', 'failed', 'failure', 'declined', 'error'],
    refundedStatuses: ['refunded', 'partially_refunded', 'chargeback'],
    voidStatuses: ['void', 'voided']
  })
}

function shouldIgnoreRegression(payment = {}, nextStatus = '') {
  if (nextStatus === 'paid' || nextStatus === 'refunded') return false
  const currentStatus = cleanString(payment.status, 80).toLowerCase()
  return SUCCESSFUL_PAYMENT_STATUSES.has(currentStatus) || Boolean(payment.paid_at)
}

function extractRebillMetadata(rebillPayment = {}) {
  const customer = rebillPayment.customer && typeof rebillPayment.customer === 'object'
    ? rebillPayment.customer
    : {}
  const card = rebillPayment.card && typeof rebillPayment.card === 'object'
    ? rebillPayment.card
    : {}

  return {
    paymentId: cleanString(rebillPayment.id, 180),
    subscriptionId: cleanString(rebillPayment.subscriptionId || rebillPayment.subscription_id, 180),
    customerId: cleanString(customer.id || rebillPayment.customerId || rebillPayment.customer_id, 180),
    cardId: cleanString(card.id || rebillPayment.cardId || rebillPayment.card_id, 180),
    status: cleanString(rebillPayment.status, 80),
    paymentMethodType: cleanString(rebillPayment.paymentMethodType || rebillPayment.payment_method_type, 80),
    installments: rebillPayment.installments || null,
    country: cleanString(rebillPayment.country, 2),
    processingMode: cleanString(rebillPayment.processingMode || rebillPayment.processing_mode, 80),
    traceId: cleanString(rebillPayment.traceId || rebillPayment.trace_id, 180),
    card: card.id
      ? {
          id: cleanString(card.id, 180),
          brand: cleanString(card.brand, 80),
          type: cleanString(card.type, 80),
          lastFourDigits: cleanString(card.lastFourDigits || card.last_four_digits, 12),
          name: cleanString(card.name, 180)
        }
      : null,
    rawUpdatedAt: new Date().toISOString()
  }
}

async function syncRebillPaymentPlanFromLocalPayment(payment) {
  if (!payment?.id) return
  const status = cleanString(payment.status, 80)
  const touchedRows = await db.all(
    `SELECT flow_id FROM installment_payments WHERE payment_id = ?
     UNION
     SELECT id AS flow_id FROM payment_flows WHERE first_payment_invoice_id = ?`,
    [payment.id, payment.id]
  ).catch(() => [])

  await db.run(
    `UPDATE installment_payments
     SET status = ?,
         rebill_payment_id = COALESCE(?, rebill_payment_id),
         updated_at = CURRENT_TIMESTAMP
     WHERE payment_id = ?`,
    [status === 'paid' ? 'paid' : status || 'pending', payment.rebill_payment_id || null, payment.id]
  ).catch(() => undefined)

  await db.run(
    `UPDATE payment_flows
     SET first_payment_status = CASE
           WHEN first_payment_invoice_id = ? THEN ?
           ELSE first_payment_status
         END,
         updated_at = CURRENT_TIMESTAMP
     WHERE first_payment_invoice_id = ?`,
    [payment.id, status === 'paid' ? 'paid' : status || 'pending', payment.id]
  ).catch(() => undefined)

  for (const row of touchedRows || []) {
    if (row?.flow_id) await persistRebillPaymentPlanMirror(row.flow_id).catch(() => undefined)
  }
}

async function updatePaymentFromRebillPayment(rebillPayment = {}) {
  const rebillPaymentId = cleanString(rebillPayment?.id, 180)
  if (!rebillPaymentId) return null

  let row = await findPaymentByRebillPaymentId(rebillPaymentId)
  const metadata = rebillPayment.metadata && typeof rebillPayment.metadata === 'object' ? rebillPayment.metadata : {}
  const publicPaymentId = cleanString(metadata.publicPaymentId || metadata.public_payment_id, 180)
  if (!row && publicPaymentId) row = await findPaymentByPublicId(publicPaymentId)
  if (!row) return null

  const amount = Number(rebillPayment.amount || row.amount)
  const currency = assertRebillCurrency(rebillPayment.currency || row.currency)
  const nextStatus = mapRebillStatus(rebillPayment.status)
  const ignoreRegression = shouldIgnoreRegression(row, nextStatus)
  const persistedStatus = ignoreRegression ? cleanString(row.status, 80) || 'paid' : nextStatus
  const paidAt = nextStatus === 'paid'
    ? timestampToIso(rebillPayment.approvedAt || rebillPayment.approved_at || rebillPayment.paidAt || rebillPayment.paid_at || rebillPayment.createdAt || rebillPayment.created_at || rebillPayment.updatedAt || rebillPayment.updated_at)
      || new Date().toISOString()
    : null
  const previousStatus = cleanString(row.status, 80).toLowerCase()
  const wasPaid = SUCCESSFUL_PAYMENT_STATUSES.has(previousStatus) || Boolean(row.paid_at)
  const becamePaid = nextStatus === 'paid' && !wasPaid
  const rebillMetadata = extractRebillMetadata(rebillPayment)
  const nextMetadata = {
    ...parseJson(row.metadata_json, {}),
    rebill: rebillMetadata
  }

  await db.run(
    `UPDATE payments
     SET amount = COALESCE(?, amount),
         currency = COALESCE(?, currency),
         status = ?,
         payment_method = 'rebill_checkout',
         payment_provider = 'rebill',
         reference = COALESCE(?, reference),
         rebill_payment_id = COALESCE(?, rebill_payment_id),
         rebill_subscription_id = COALESCE(?, rebill_subscription_id),
         rebill_customer_id = COALESCE(?, rebill_customer_id),
         rebill_card_id = COALESCE(?, rebill_card_id),
         paid_at = COALESCE(?, paid_at),
         date = COALESCE(?, date),
         metadata_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      Number.isFinite(amount) ? amount : null,
      currency,
      persistedStatus,
      rebillPaymentId || null,
      rebillPaymentId || null,
      rebillMetadata.subscriptionId || null,
      rebillMetadata.customerId || null,
      rebillMetadata.cardId || null,
      paidAt,
      paidAt,
      JSON.stringify(nextMetadata),
      row.id
    ]
  )

  const updated = await findPaymentById(row.id)
  if (updated?.id && !ignoreRegression) {
    dispatchProductPostWebhooksForPaymentInBackground(updated.id, {
      status: persistedStatus,
      previousStatus: row.status || ''
    })
    if (previousStatus !== cleanString(persistedStatus, 80).toLowerCase()) {
      sendPaymentNotification({ ...updated, status: persistedStatus, previousStatus: row.status || '' }).catch((error) => {
        logger.warn(`No se pudo enviar push de pago Rebill ${updated.id}: ${error.message}`)
      })
    }
  }

  await syncRebillPaymentPlanFromLocalPayment(updated)

  if (updated?.contact_id && becamePaid) {
    registerGigstackPaymentForTransactionInBackground(updated.id)
    updateSingleContactStats(updated.contact_id).catch((error) => {
      logger.warn(`No se pudieron actualizar stats del contacto por pago Rebill ${row.id}: ${error.message}`)
    })
    Promise.resolve(queuePaymentAutomationMessage('receipt', { ...updated, status: nextStatus }))
      .catch((error) => {
        logger.warn(`No se pudo encolar comprobante por pago Rebill ${updated.id}: ${error.message}`)
      })
    triggerMetaPaymentPurchaseEvent(updated.contact_id, { ...updated, status: nextStatus })
      .catch((error) => {
        logger.warn(`No se pudo enviar Purchase a Meta para pago Rebill ${updated.id}: ${error.message}`)
      })
  }

  if (ignoreRegression) {
    logger.info(`[Rebill webhook] Ignorado estado tardio ${nextStatus} para pago ya cerrado ${updated?.id || row.id} (payment ${rebillPaymentId})`)
  }

  return updated
}

export async function refreshRebillPayment(rebillPaymentId, { mode = '' } = {}) {
  const paymentId = cleanString(rebillPaymentId, 180)
  if (!paymentId) return null
  const existing = await findPaymentByRebillPaymentId(paymentId)
  const config = await getRebillClientConfig(existing?.payment_mode || mode)
  const { payload } = await rebillApiRequest(`/v3/payments/${encodeURIComponent(paymentId)}`, { config })
  return updatePaymentFromRebillPayment(payload)
}

export async function confirmPublicRebillPayment(publicPaymentId, input = {}, { baseUrl } = {}) {
  const row = await findPaymentByPublicId(publicPaymentId)
  if (!row || row.payment_provider !== 'rebill') {
    const error = new Error('Pago no encontrado.')
    error.status = 404
    throw error
  }

  if (CLOSED_PAYMENT_STATUSES.has(cleanString(row.status, 80).toLowerCase()) && row.rebill_payment_id) {
    const paymentSettings = await getPublicPaymentSettings()
    const config = await getRebillPaymentConfig({ includeSecrets: true, mode: row.payment_mode || '' })
    return {
      payment: mapPublicPayment(row, config, baseUrl, paymentSettings),
      rebillPaymentId: row.rebill_payment_id,
      status: row.status
    }
  }

  const rebillPaymentId = cleanString(input.rebillPaymentId || input.rebill_payment_id || input.paymentId || input.payment_id, 180)
  if (!rebillPaymentId) {
    const error = new Error('Rebill no devolvio un paymentId para confirmar.')
    error.status = 400
    throw error
  }

  const config = await getRebillClientConfig(row.payment_mode)
  const { payload } = await rebillApiRequest(`/v3/payments/${encodeURIComponent(rebillPaymentId)}`, { config })
  const payloadMetadata = payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}
  const payloadPublicPaymentId = cleanString(payloadMetadata.publicPaymentId || payloadMetadata.public_payment_id, 180)
  const updated = await updatePaymentFromRebillPayment({
    ...payload,
    metadata: {
      ...payloadMetadata,
      publicPaymentId: payloadPublicPaymentId || row.public_payment_id
    }
  })
  const paymentSettings = await getPublicPaymentSettings()

  return {
    payment: mapPublicPayment(updated || await findPaymentById(row.id), config, baseUrl, paymentSettings),
    rebillPaymentId: cleanString(payload?.id || rebillPaymentId, 180),
    status: cleanString(payload?.status, 80),
    statusDetail: payload?.errorDetail || payload?.errorType || null
  }
}

function extractPaymentIdFromWebhook(body = {}) {
  const candidates = [
    body.id,
    body.paymentId,
    body.payment_id,
    body.data?.id,
    body.data?.paymentId,
    body.data?.payment_id,
    body.data?.object?.id,
    body.data?.payment?.id,
    body.data?.result?.paymentId,
    body.data?.result?.payment_id,
    body.payment?.id,
    body.result?.paymentId,
    body.result?.payment_id
  ]
  return candidates
    .map((value) => cleanString(value, 180))
    .find((value) => /^pay_/i.test(value) || /^test_pay_/i.test(value)) || ''
}

export async function handleRebillWebhookEvent(body = {}) {
  const eventType = cleanString(body.event || body.type || body.event_type, 120)
  const paymentId = extractPaymentIdFromWebhook(body)
  if (!paymentId) {
    return { received: true, ignored: true, eventType }
  }

  const updated = await refreshRebillPayment(paymentId)
  return {
    received: true,
    eventType,
    rebillPaymentId: paymentId,
    paymentId: updated?.id || null,
    status: updated?.status || null
  }
}

export const REBILL_WEBHOOK_ENDPOINT_PATH = REBILL_WEBHOOK_PATH
