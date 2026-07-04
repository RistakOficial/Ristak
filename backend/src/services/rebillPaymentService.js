import fetch from 'node-fetch'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { decrypt, encrypt, isEncrypted } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'
import { updateSingleContactStats } from '../utils/updateContactsStats.js'
import { COUNTRY_OPTIONS, getAccountCurrency } from '../utils/accountLocale.js'
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
  WAITING_CARD_AUTHORIZATION: 'waiting_card_authorization',
  ACTIVE: 'installment_plan_active',
  COMPLETED: 'completed',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
  DELETED: 'deleted'
}
const MANUAL_PLAN_PAYMENT_METHODS = new Set(['cash', 'bank_transfer', 'transfer', 'deposit', 'manual', 'offline', 'check', 'other'])
const REBILL_CHECKOUT_METHODS = new Set(['card', 'payment_link', 'direct_card', 'rebill', 'rebill_checkout', 'checkout'])
const REBILL_STORED_CARD_METHODS = new Set(['saved_card', 'stored_card', 'rebill_saved_card'])
const REBILL_AUTOMATIC_PLAN_METHODS = new Set([...REBILL_CHECKOUT_METHODS, ...REBILL_STORED_CARD_METHODS])
const TIMED_PLAN_FREQUENCY = 'scheduled_time'
const PLAN_FREQUENCIES = new Set(['custom', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly', TIMED_PLAN_FREQUENCY])
const TIMED_PLAN_FREQUENCY_ALIASES = new Set([TIMED_PLAN_FREQUENCY, 'scheduled-time', 'scheduledat', 'scheduled_at', 'timed', 'datetime'])
const isPostgresRuntime = Boolean(process.env.DATABASE_URL)
const PHONE_COUNTRIES_BY_DIAL_CODE = [...COUNTRY_OPTIONS]
  .sort((left, right) => String(right.dialCode || '').length - String(left.dialCode || '').length)

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

function normalizeRebillSelectedInstallments(value) {
  const source = value && typeof value === 'object'
    ? value.installments ?? value.installment ?? value.selectedInstallments ?? value.months ?? value.count ?? value.value
    : value
  const installments = Math.trunc(Number(source))
  return Number.isFinite(installments) && installments > 1 && installments <= 36 ? installments : null
}

function normalizeRebillInstallmentOptions(input = {}) {
  const raw = input.installments ?? input.rebillInstallments ?? input.rebill_installments
  if (raw === undefined || raw === null || raw === '') return null

  if (typeof raw === 'boolean') {
    return {
      enabled: raw,
      selectionMode: 'rebill_checkout_automatic'
    }
  }

  if (typeof raw !== 'object') return null

  const selectedInstallments = normalizeRebillSelectedInstallments(raw)
  return {
    enabled: normalizeBoolean(raw.enabled ?? raw.requested ?? raw.msi, false),
    selectionMode: cleanString(raw.selectionMode || raw.selection_mode || 'rebill_checkout_automatic', 80),
    ...(selectedInstallments ? { selectedInstallments } : {})
  }
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

async function rebillApiRequest(path, { method = 'GET', body = null, apiKey = '', config: configOverride = null, idempotencyKey = '' } = {}) {
  const config = configOverride || await getRebillClientConfig()
  const secretKey = cleanString(apiKey || config.secretKey, 5000)
  const url = path.startsWith('http') ? path : `${REBILL_API_BASE}${path}`
  const headers = {
    Accept: 'application/json',
    'x-api-key': secretKey
  }
  if (body !== null && body !== undefined) headers['Content-Type'] = 'application/json'
  if (cleanString(idempotencyKey, 200)) headers['x-idempotency-key'] = cleanString(idempotencyKey, 200)

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
    const errorPayload = payload.error && typeof payload.error === 'object' ? payload.error : {}
    const message = cleanString(
      payload.message ||
      errorPayload.rawMessage ||
      errorPayload.message ||
      payload.error_message ||
      payload.detail ||
      errorPayload.type ||
      payload.error,
      500
    ) ||
      'Rebill no pudo completar la solicitud.'
    const error = new Error(message)
    error.status = response.status || 502
    error.payload = payload
    error.rebillType = cleanString(errorPayload.type || payload.type, 120)
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
    accountLabel: cleanString(input.accountLabel || input.account_label, 180)
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
  const rebillInstallments = metadata.rebillInstallments && typeof metadata.rebillInstallments === 'object'
    ? metadata.rebillInstallments
    : null
  return {
    name: [{ language: 'es', text: title }],
    description: description ? [{ language: 'es', text: description }] : [],
    amount: normalizePositiveAmount(row.amount),
    currency: assertRebillCurrency(row.currency),
    metadata: {
      ristakPaymentId: cleanString(row.id, 180),
      publicPaymentId: cleanString(row.public_payment_id, 180),
      provider: 'rebill',
      source: cleanString(metadata.source || 'ristak', 120),
      ...(rebillInstallments
        ? {
            rebillInstallmentsRequested: Boolean(rebillInstallments.enabled),
            rebillInstallmentsMode: cleanString(rebillInstallments.selectionMode || 'rebill_checkout_automatic', 80)
          }
        : {})
    }
  }
}

function getRebillPhoneInformation(value = '') {
  const raw = cleanString(value, 80)
  const digits = raw.replace(/\D/g, '').replace(/^00/, '')
  if (digits.length < 7) return null

  if ((digits.startsWith('521') && digits.length >= 13) || (digits.startsWith('52') && digits.length >= 12)) {
    return {
      number: digits.slice(-10),
      countryCode: 'MX'
    }
  }

  const country = PHONE_COUNTRIES_BY_DIAL_CODE.find((option) => {
    const dialCode = cleanString(option.dialCode, 4).replace(/\D/g, '')
    return dialCode && digits.startsWith(dialCode) && digits.length > dialCode.length + 5
  })

  if (country) {
    return {
      number: digits.slice(String(country.dialCode || '').replace(/\D/g, '').length),
      countryCode: country.value
    }
  }

  return {
    number: digits,
    countryCode: 'MX'
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
    const phoneNumber = getRebillPhoneInformation(phone)
    if (phoneNumber) customer.phoneNumber = phoneNumber
  }
  return Object.keys(customer).length ? customer : null
}

function getRebillCardLast4(card = {}, fallback = '') {
  return cleanString(
    card.lastFourDigits ||
    card.last_four_digits ||
    card.lastFour ||
    card.last4 ||
    card.cardLastFour ||
    card.card_last_four ||
    fallback,
    12
  )
}

function getRebillSavedCardLabelFromRow(row = {}) {
  const brand = cleanString(row.brand || row.card_brand, 80)
  const last4 = cleanString(row.last4 || row.last_four || row.cardLastFour, 12)
  return `${brand ? brand.toUpperCase() : 'Rebill'} •••• ${last4 || '----'}`
}

function mapRebillPaymentSource(row = null) {
  if (!row) return null
  return {
    id: cleanString(row.id, 180),
    contactId: cleanString(row.contact_id, 180),
    rebillCustomerId: cleanString(row.rebill_customer_id, 180),
    rebillCardId: cleanString(row.rebill_card_id, 180),
    brand: cleanString(row.brand, 80),
    last4: cleanString(row.last4, 12),
    name: cleanString(row.name, 180),
    mode: normalizeMode(row.mode),
    isDefault: Boolean(row.is_default),
    label: getRebillSavedCardLabelFromRow(row),
    expiresLabel: ''
  }
}

async function upsertRebillPaymentSource({
  contactId,
  customerId,
  cardId,
  card = {},
  mode = '',
  makeDefault = true
} = {}) {
  const cleanContactId = cleanString(contactId, 180)
  const cleanCustomerId = cleanString(customerId, 180)
  const cleanCardId = cleanString(cardId, 180)
  if (!cleanContactId || !cleanCustomerId || !cleanCardId) return null

  const normalizedMode = normalizeMode(mode)
  if (makeDefault) {
    await db.run(
      `UPDATE rebill_payment_sources
       SET is_default = 0,
           updated_at = CURRENT_TIMESTAMP
       WHERE contact_id = ? AND mode = ?`,
      [cleanContactId, normalizedMode]
    )
  }

  const existing = await db.get(
    'SELECT id FROM rebill_payment_sources WHERE rebill_card_id = ?',
    [cleanCardId]
  )
  const id = existing?.id || createId('rebill_source')
  const brand = cleanString(card.brand || card.card_brand || card.type, 80)
  const last4 = getRebillCardLast4(card)
  const name = cleanString(card.name || card.cardholderName || card.card_holder_name, 180)

  await db.run(
    `INSERT INTO rebill_payment_sources (
      id, contact_id, rebill_customer_id, rebill_card_id,
      brand, last4, name, mode, is_default, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(rebill_card_id) DO UPDATE SET
      contact_id = COALESCE(?, rebill_payment_sources.contact_id),
      rebill_customer_id = ?,
      brand = COALESCE(NULLIF(?, ''), rebill_payment_sources.brand),
      last4 = COALESCE(NULLIF(?, ''), rebill_payment_sources.last4),
      name = COALESCE(NULLIF(?, ''), rebill_payment_sources.name),
      mode = ?,
      is_default = CASE
        WHEN ? = 1 THEN 1
        ELSE rebill_payment_sources.is_default
      END,
      updated_at = CURRENT_TIMESTAMP`,
    [
      id,
      cleanContactId,
      cleanCustomerId,
      cleanCardId,
      brand,
      last4,
      name,
      normalizedMode,
      makeDefault ? 1 : 0,
      cleanContactId,
      cleanCustomerId,
      brand,
      last4,
      name,
      normalizedMode,
      makeDefault ? 1 : 0
    ]
  )

  return db.get('SELECT * FROM rebill_payment_sources WHERE rebill_card_id = ?', [cleanCardId])
}

async function resolveRebillSavedSource(contactId, paymentMethodId = '', config = null) {
  const cleanContactId = cleanString(contactId, 180)
  const cleanPaymentMethodId = cleanString(paymentMethodId, 180)
  const mode = normalizeMode(config?.mode || await getPaymentGatewayMode())

  if (cleanContactId && cleanPaymentMethodId) {
    const scoped = await db.get(
      `SELECT *
       FROM rebill_payment_sources
       WHERE contact_id = ?
         AND mode = ?
         AND (id = ? OR rebill_card_id = ?)
       ORDER BY is_default DESC, updated_at DESC, created_at DESC
       LIMIT 1`,
      [cleanContactId, mode, cleanPaymentMethodId, cleanPaymentMethodId]
    )
    if (scoped) return scoped
  }

  if (cleanContactId && !cleanPaymentMethodId) {
    return db.get(
      `SELECT *
       FROM rebill_payment_sources
       WHERE contact_id = ?
         AND mode = ?
       ORDER BY is_default DESC, updated_at DESC, created_at DESC
       LIMIT 1`,
      [cleanContactId, mode]
    )
  }

  if (cleanPaymentMethodId) {
    return db.get(
      `SELECT *
       FROM rebill_payment_sources
       WHERE id = ? OR rebill_card_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
      [cleanPaymentMethodId, cleanPaymentMethodId]
    )
  }

  return null
}

export async function listRebillSavedPaymentSources(contactId, { mode = '' } = {}) {
  const cleanContactId = cleanString(contactId, 180)
  if (!cleanContactId) return []
  const config = await getRebillPaymentConfig({ mode })
  const rows = await db.all(
    `SELECT *
     FROM rebill_payment_sources
     WHERE contact_id = ?
       AND mode = ?
     ORDER BY is_default DESC, updated_at DESC, created_at DESC`,
    [cleanContactId, normalizeMode(config.mode)]
  )
  return (rows || []).map(mapRebillPaymentSource)
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

function normalizeRebillPlanPaymentMethod(value, hasSavedCard = false, cardLabel = '') {
  const method = cleanString(value || 'rebill_checkout', 80).toLowerCase()
  if (REBILL_AUTOMATIC_PLAN_METHODS.has(method)) {
    return {
      automatic: 1,
      installmentMethod: hasSavedCard ? 'rebill_saved_card' : 'rebill_pending_card',
      paymentMethod: 'rebill_scheduled_card',
      status: hasSavedCard ? 'scheduled' : REBILL_PLAN_STATES.WAITING_CARD_AUTHORIZATION,
      paymentStatus: hasSavedCard ? 'scheduled' : 'pending',
      notes: hasSavedCard
        ? `Programado para cobrarse con ${cardLabel || 'tarjeta guardada Rebill'}.`
        : 'Esperando autorización de tarjeta en Rebill.'
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
  if (REBILL_AUTOMATIC_PLAN_METHODS.has(method)) {
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
    paymentMethodId: cleanString(input.paymentMethodId || input.payment_method_id || input.rebillCardId || input.rebill_card_id, 180),
    cardSetupAmount: normalizePositiveAmount(input.cardSetupAmount || input.card_setup_amount, 25),
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

function buildRebillCheckoutTransaction(row, metadata = {}) {
  const product = buildInstantProduct(row, metadata)
  return {
    amount: product.amount,
    currency: product.currency,
    quantity: 1,
    name: product.name,
    ...(product.description?.length ? { description: product.description } : {})
  }
}

function isValidEmail(value = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanString(value, 180))
}

function sanitizeRebillCustomerNamePart(value = '', fallback = 'Cliente') {
  const clean = cleanString(value, 80).replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim()
  return clean || fallback
}

function deriveRebillCustomerName(fullName = '', email = '') {
  const cleanFullName = cleanString(fullName, 140).replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim()
  const parts = cleanFullName.split(/\s+/).filter(Boolean)
  if (parts.length > 1) {
    return {
      firstName: sanitizeRebillCustomerNamePart(parts[0], 'Cliente'),
      lastName: sanitizeRebillCustomerNamePart(parts.slice(1).join(' '), 'Ristak')
    }
  }

  if (parts.length === 1) {
    return {
      firstName: sanitizeRebillCustomerNamePart(parts[0], 'Cliente'),
      lastName: 'Ristak'
    }
  }

  const emailName = cleanString(email.split('@')[0], 80)
    .replace(/[._-]+/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    firstName: sanitizeRebillCustomerNamePart(emailName, 'Cliente'),
    lastName: 'Ristak'
  }
}

function buildRebillCheckoutCustomer(row = {}, metadata = {}, sourceRow = {}) {
  const email = cleanString(row.contact_email || metadata.contactEmail || metadata.email, 180).toLowerCase()
  if (!isValidEmail(email)) {
    const error = new Error('El contacto necesita un email válido para cobrar con tarjeta guardada de Rebill.')
    error.status = 400
    throw error
  }

  const { firstName, lastName } = deriveRebillCustomerName(
    row.contact_name || metadata.contactName || sourceRow.name,
    email
  )
  const customer = { firstName, lastName, email }
  const phone = cleanString(row.contact_phone || metadata.contactPhone || metadata.phone, 80)
  const phoneNumber = getRebillPhoneInformation(phone)
  if (phoneNumber) customer.phone = phoneNumber
  return customer
}

function normalizeRebillCheckoutResult(payload = {}, row = {}, savedSource = {}) {
  const result = payload?.result && typeof payload.result === 'object' ? payload.result : payload
  const paymentId = cleanString(result.paymentId || result.payment_id || result.id, 180)
  const customerId = cleanString(result.customerId || result.customer_id || savedSource.rebill_customer_id || row.rebill_customer_id, 180)
  const cardId = cleanString(result.cardId || result.card_id || savedSource.rebill_card_id || row.rebill_card_id, 180)
  const cardLastFour = cleanString(result.cardLastFour || result.card_last_four || savedSource.last4, 12)

  return {
    id: paymentId,
    status: cleanString(result.status || 'processing', 80),
    amount: Number(row.amount || result.amount || 0),
    currency: row.currency || result.currency || DEFAULT_CURRENCY,
    customerId,
    cardId,
    card: cardId
      ? {
          id: cardId,
          brand: cleanString(savedSource.brand || result.cardBrand || result.card_brand, 80),
          lastFourDigits: cardLastFour,
          name: cleanString(savedSource.name || result.cardName || result.card_name, 180)
        }
      : null,
    approvedAt: payload.date || result.approvedAt || result.approved_at || result.createdAt || result.created_at,
    metadata: {
      ...parseJson(row.metadata_json, {}),
      localPaymentId: row.id,
      publicPaymentId: row.public_payment_id
    },
    traceId: cleanString(payload.traceId || result.traceId || result.trace_id, 180),
    statusDetail: result.statusDetail || result.status_detail || null,
    errorType: result.errorType || result.error_type || null
  }
}

async function chargeRebillPaymentRowWithSavedSource({
  paymentId,
  savedSource,
  source = 'rebill_saved_card_charge',
  extraMetadata = {}
} = {}) {
  const row = await findPaymentById(paymentId)
  if (!row) {
    const error = new Error('Pago Rebill no encontrado para cobrar tarjeta guardada.')
    error.status = 404
    throw error
  }

  if (SUCCESSFUL_PAYMENT_STATUSES.has(cleanString(row.status, 80).toLowerCase()) || row.paid_at) {
    return row
  }

  const sourceRow = savedSource || await resolveRebillSavedSource(row.contact_id, row.rebill_card_id, { mode: row.payment_mode })
  if (!sourceRow?.rebill_customer_id || !sourceRow?.rebill_card_id) {
    const error = new Error('No encontramos la tarjeta guardada de Rebill para este cobro.')
    error.status = 400
    throw error
  }

  const config = await getRebillClientConfig(row.payment_mode || sourceRow.mode)
  const amount = normalizePositiveAmount(row.amount, 0)
  const currency = assertRebillCurrency(row.currency || config.defaultCurrency)
  const currentMetadata = parseJson(row.metadata_json, {})
  const nextMetadata = {
    ...currentMetadata,
    rebill: {
      ...(currentMetadata.rebill || {}),
      savedCardCharge: true,
      source,
      idempotencyKey: `ristak:rebill:${row.id}`
    },
    paymentPlan: {
      ...(currentMetadata.paymentPlan || {}),
      ...extraMetadata
    }
  }

  await db.run(
    `UPDATE payments
     SET status = 'processing',
         payment_method = 'rebill_saved_card',
         payment_provider = 'rebill',
         rebill_customer_id = COALESCE(?, rebill_customer_id),
         rebill_card_id = COALESCE(?, rebill_card_id),
         metadata_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      sourceRow.rebill_customer_id,
      sourceRow.rebill_card_id,
      JSON.stringify(nextMetadata),
      row.id
    ]
  )

  const chargeRow = await findPaymentById(row.id)
  try {
    const { payload } = await rebillApiRequest('/v3/checkout', {
      method: 'POST',
      config,
      idempotencyKey: `ristak:rebill:${row.id}:${sourceRow.rebill_card_id}:${amount}:${currency}`,
      body: {
        transaction: buildRebillCheckoutTransaction({
          ...chargeRow,
          amount,
          currency
        }, nextMetadata),
        customer: buildRebillCheckoutCustomer(chargeRow, nextMetadata, sourceRow),
        cardId: sourceRow.rebill_card_id
      }
    })

    const normalized = normalizeRebillCheckoutResult(payload, {
      ...chargeRow,
      amount,
      currency,
      metadata_json: JSON.stringify(nextMetadata)
    }, sourceRow)
    return updatePaymentFromRebillPayment(normalized)
  } catch (error) {
    const failedStatus = Number(error.status) === 417 ? 'requires_action' : 'failed'
    await db.run(
      `UPDATE payments
       SET status = ?,
           metadata_json = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        failedStatus,
        JSON.stringify({
          ...nextMetadata,
          rebill: {
            ...(nextMetadata.rebill || {}),
            savedCardChargeError: error.message,
            savedCardChargeErrorType: error.rebillType || ''
          }
        }),
        row.id
      ]
    )
    throw error
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
    savedPaymentSource: flow.rebill_card_id
      ? {
          customerId: flow.rebill_customer_id || null,
          cardId: flow.rebill_card_id || null,
          label: flow.rebill_card_label || null
        }
      : null,
    firstPayment: {
      amount: Number(flow.first_payment_amount || 0),
      date: flow.first_payment_date || null,
      method: flow.first_payment_method || null,
      status: flow.first_payment_status || null,
      paymentId: flow.first_payment_invoice_id || null,
      paymentLink: flow.card_setup_payment_link || null
    },
    cardSetup: {
      required: Boolean(flow.card_setup_required),
      amount: Number(flow.card_setup_amount || 0),
      status: flow.card_setup_status || null,
      paymentId: flow.card_setup_invoice_id || null,
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
    rebillInstallments: metadata.rebillInstallments && typeof metadata.rebillInstallments === 'object' ? metadata.rebillInstallments : null,
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
  const rebillInstallments = normalizeRebillInstallmentOptions(input)
  const metadata = {
    contactName: contact.name,
    contactEmail: contact.email,
    contactPhone: contact.phone,
    source: cleanString(input.source || 'ristak', 120),
    lineItems: Array.isArray(input.lineItems) ? input.lineItems : [],
    ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
    ...(rebillInstallments ? { rebillInstallments } : {}),
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

export async function createRebillSavedCardPayment(input = {}, { mode = '' } = {}) {
  const config = await getRebillClientConfig(mode)
  const contactId = cleanString(input.contactId || input.contact_id, 180)
  const sourceId = cleanString(input.paymentSourceId || input.payment_source_id || input.rebillCardId || input.rebill_card_id || input.paymentMethodId || input.payment_method_id, 180)
  const savedSource = await resolveRebillSavedSource(contactId, sourceId, config)
  if (!savedSource) {
    const error = new Error('No encontramos la tarjeta guardada de Rebill para este contacto.')
    error.status = 404
    throw error
  }

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
  const id = createId('rebill_saved_payment')
  const now = new Date().toISOString()
  const metadata = {
    contactName: cleanString(input.contactName, 180),
    contactEmail: cleanString(input.email, 180),
    contactPhone: cleanString(input.phone, 80),
    source: cleanString(input.source || 'ristak_rebill_saved_card', 120),
    lineItems: Array.isArray(input.lineItems) ? input.lineItems : [],
    rebill: {
      savedCardCharge: true,
      sourceId: savedSource.rebill_card_id
    },
    ...(tax ? { tax } : {})
  }

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, reference, title, description, date, due_date, sent_at,
      public_payment_id, payment_url, rebill_customer_id, rebill_card_id,
      metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', 'rebill_saved_card', ?, 'rebill', ?, ?, ?, ?, ?, NULL, NULL, '', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      id,
      contactId || null,
      normalizePositiveAmount(chargeAmount),
      currency,
      config.mode,
      id,
      cleanString(input.title, 180) || 'Pago',
      cleanString(input.description, 500) || cleanString(input.title, 180) || 'Pago',
      now,
      input.dueDate || null,
      savedSource.rebill_customer_id,
      savedSource.rebill_card_id,
      JSON.stringify(metadata)
    ]
  )

  const charged = await chargeRebillPaymentRowWithSavedSource({
    paymentId: id,
    savedSource,
    source: 'rebill_saved_card_payment'
  })

  return {
    payment: mapPublicPayment(charged || await findPaymentById(id), config, '', paymentSettings)
  }
}

export async function createRebillPaymentPlan(input = {}, { baseUrl, mode = '' } = {}) {
  const config = await getRebillClientConfig(mode)
  const accountCurrency = await getConfiguredCurrency()
  const accountTimezone = await getAccountTimezone().catch(() => ACCOUNT_DEFAULT_TIMEZONE)
  const plan = validateRebillPaymentPlanPayload({ ...input, currency: input.currency || accountCurrency }, accountTimezone)
  const savedSource = plan.paymentMethodId
    ? await resolveRebillSavedSource(plan.contact.id, plan.paymentMethodId, config)
    : null
  const hasSavedCard = Boolean(savedSource)
  const firstPaymentIsCard = plan.firstPayment.enabled && REBILL_AUTOMATIC_PLAN_METHODS.has(cleanString(plan.firstPayment.method, 80).toLowerCase())
  const firstPaymentIsOffline = plan.firstPayment.enabled && isManualPlanPaymentMethod(plan.firstPayment.method)
  const needsSeparateCardSetup = !hasSavedCard && !firstPaymentIsCard
  const cardSetupAmount = needsSeparateCardSetup ? plan.cardSetupAmount : (firstPaymentIsCard ? plan.firstPayment.amount : 0)
  const flowId = createId('rebill_flow')
  const flowState = hasSavedCard
    ? REBILL_PLAN_STATES.ACTIVE
    : REBILL_PLAN_STATES.WAITING_CARD_AUTHORIZATION
  const stateHistory = addPlanState([], flowState)
  const now = new Date().toISOString()
  const cardLabel = hasSavedCard ? getRebillSavedCardLabelFromRow(savedSource) : ''
  const firstPaymentDueNow = plan.firstPayment.enabled
    ? isPlanChargeDueNow(plan.firstPayment.date, plan.firstPayment.frequency || plan.remainingFrequency, accountTimezone)
    : false

  await db.run(
    `INSERT INTO payment_flows (
      id, contact_id, contact_name, contact_email, contact_phone,
      total_amount, currency, concept, payment_type,
      first_payment_amount, first_payment_type, first_payment_value,
      first_payment_date, first_payment_method, first_payment_status,
      remaining_automatic, card_setup_required, card_setup_amount,
      payment_provider, rebill_customer_id, rebill_card_id, rebill_card_label,
      current_state, state_history, card_authorized_at,
      installment_plan_created_at, installment_plan_active_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'partial', ?, ?, ?, ?, ?, ?, 1, ?, ?, 'rebill', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      savedSource?.rebill_customer_id || null,
      savedSource?.rebill_card_id || null,
      cardLabel || null,
      flowState,
      JSON.stringify(stateHistory),
      hasSavedCard ? now : null,
      now,
      hasSavedCard ? now : null,
      JSON.stringify({
        source: plan.source,
        rebillMode: config.mode,
        paymentMode: config.mode,
        timezone: accountTimezone,
        remainingFrequency: plan.remainingFrequency,
        lineItems: plan.lineItems,
        checkoutProvider: 'rebill',
        clockOwner: 'ristak',
        firstPaymentLinkRequired: !hasSavedCard && firstPaymentIsCard,
        cardSetupLinkRequired: needsSeparateCardSetup,
        rebillCustomerId: savedSource?.rebill_customer_id || '',
        rebillCardId: savedSource?.rebill_card_id || '',
        rebillCardLabel: cardLabel || ''
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
    savedPaymentSource: hasSavedCard ? mapRebillPaymentSource(savedSource) : null,
    scheduledPayments: []
  }
  const planPaymentTotal = getPlanPaymentTotal(plan.firstPayment.enabled, plan.remainingPayments.length)
  const firstPaymentTitle = buildPlanFirstPaymentTitle(plan.title, planPaymentTotal)
  const firstPaymentDescription = buildPlanFirstPaymentTitle(plan.description, planPaymentTotal)

  if (plan.firstPayment.enabled && firstPaymentIsOffline) {
    const first = await createRebillPlanPaymentRow({
      contact: plan.contact,
      amount: plan.firstPayment.amount,
      currency: plan.currency,
      status: 'paid',
      paymentMethod: normalizeManualPaymentMethod(plan.firstPayment.method),
      title: firstPaymentTitle,
      description: firstPaymentDescription,
      dueDate: plan.firstPayment.date,
      metadata: {
        rebillMode: config.mode,
        paymentMode: config.mode,
        source: 'rebill_payment_plan_first_offline',
        contactName: plan.contact.name,
        contactEmail: plan.contact.email,
        contactPhone: plan.contact.phone,
        paymentPlan: {
          flowId,
          trigger: 'first_payment_offline'
        }
      },
      baseUrl,
      mode: config.mode
    })

    await db.run(
      `UPDATE payment_flows
       SET first_payment_status = ?,
           first_payment_invoice_id = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      ['registered', first.payment?.id || null, flowId]
    )
    response.firstPaymentPaymentId = first.payment?.id || null
    updateSingleContactStats(plan.contact.id).catch((error) => {
      logger.warn(`No se pudieron actualizar stats del contacto por primer pago Rebill ${first.payment?.id}: ${error.message}`)
    })
  }

  if (plan.firstPayment.enabled && firstPaymentIsCard && hasSavedCard) {
    const first = await createRebillPlanPaymentRow({
      contact: plan.contact,
      amount: plan.firstPayment.amount,
      currency: plan.currency,
      status: firstPaymentDueNow ? 'pending' : 'scheduled',
      paymentMethod: 'rebill_saved_card',
      title: firstPaymentTitle,
      description: firstPaymentDescription,
      dueDate: plan.firstPayment.date,
      metadata: {
        rebillMode: config.mode,
        paymentMode: config.mode,
        source: 'rebill_payment_plan_first_saved_card',
        contactName: plan.contact.name,
        contactEmail: plan.contact.email,
        contactPhone: plan.contact.phone,
        paymentPlan: {
          flowId,
          trigger: 'first_payment_saved_card'
        }
      },
      baseUrl,
      mode: config.mode
    })

    await db.run(
      `UPDATE payment_flows
       SET first_payment_invoice_id = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [first.payment?.id || null, flowId]
    )
    response.firstPaymentPaymentId = first.payment?.id || null

    if (firstPaymentDueNow) {
      try {
        const charged = await chargeRebillPaymentRowWithSavedSource({
          paymentId: first.payment?.id,
          savedSource,
          source: 'rebill_payment_plan_first_saved_card',
          extraMetadata: { flowId, trigger: 'first_payment_saved_card' }
        })
        await db.run(
          `UPDATE payment_flows
           SET first_payment_status = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [charged?.status === 'paid' ? 'paid' : charged?.status || 'pending', flowId]
        )
      } catch (error) {
        await db.run(
          `UPDATE payment_flows
           SET first_payment_status = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [Number(error.status) === 417 ? 'requires_action' : 'failed', flowId]
        )
        throw error
      }
    }
  }

  if (plan.firstPayment.enabled && firstPaymentIsCard && !hasSavedCard) {
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
  }

  if (needsSeparateCardSetup) {
    const setup = await createRebillPlanPaymentRow({
      contact: plan.contact,
      amount: plan.cardSetupAmount,
      currency: plan.currency,
      status: 'sent',
      paymentMethod: 'rebill_checkout',
      title: `${plan.title} - domiciliación de tarjeta`,
      description: `Domiciliación de tarjeta para ${plan.description}`,
      dueDate: todayDateOnly(accountTimezone),
      metadata: {
        rebillMode: config.mode,
        paymentMode: config.mode,
        source: 'rebill_payment_plan_card_setup',
        contactName: plan.contact.name,
        contactEmail: plan.contact.email,
        contactPhone: plan.contact.phone,
        paymentPlan: {
          flowId,
          trigger: 'card_setup'
        }
      },
      baseUrl,
      mode: config.mode
    })

    await db.run(
      `UPDATE payment_flows
       SET card_setup_status = 'pending',
           card_setup_invoice_id = ?,
           card_setup_payment_link = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [setup.payment?.id || null, setup.paymentUrl || null, flowId]
    )
    response.cardSetupPaymentId = setup.payment?.id || null
    response.cardSetupLink = setup.paymentUrl || null
  }

  const flow = await db.get('SELECT * FROM payment_flows WHERE id = ?', [flowId])
  for (const payment of plan.remainingPayments) {
    const installmentId = createId('rebill_installment')
    const title = buildPlanInstallmentPaymentTitle(plan.title, payment.sequence, plan.firstPayment.enabled, planPaymentTotal)
    const method = normalizeRebillPlanPaymentMethod(payment.paymentMethod, hasSavedCard, cardLabel)
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
  const staleFirstPaymentClaimSql = staleProcessingSql('updated_at')
  const staleInstallmentClaimSql = staleProcessingSql('updated_at')

  const firstPaymentRows = await db.all(
    `SELECT
       f.id AS flow_id,
       f.contact_id,
       f.first_payment_invoice_id AS payment_id,
       f.first_payment_date,
       f.first_payment_status,
       f.metadata,
       f.current_state,
       f.rebill_customer_id,
       f.rebill_card_id,
       p.status AS payment_status,
       p.due_date AS payment_due_date,
       p.date AS payment_date,
       p.payment_url
     FROM payment_flows f
     JOIN payments p ON p.id = f.first_payment_invoice_id
     WHERE f.payment_provider = 'rebill'
       AND f.current_state IN (?, ?)
       AND f.first_payment_invoice_id IS NOT NULL
       AND f.first_payment_method IN ('payment_link', 'card', 'rebill_checkout', 'saved_card', 'rebill_saved_card')
       AND (
         f.first_payment_status IN ('pending', 'scheduled')
         OR (f.first_payment_status = 'processing' AND ${staleFirstPaymentSql})
       )
       AND ${firstPaymentDueSql}
       AND p.status IN ('scheduled', 'pending', 'sent', 'processing')
     ORDER BY COALESCE(f.first_payment_date, p.due_date, p.date) ASC
     LIMIT ?`,
    [REBILL_PLAN_STATES.ACTIVE, REBILL_PLAN_STATES.WAITING_CARD_AUTHORIZATION, dueTimestamp, dueDate, normalizedLimit]
  )

  const rows = await db.all(
    `SELECT
       i.id AS installment_id,
       i.payment_id,
       i.due_date,
       i.frequency,
       i.status AS installment_status,
       f.id AS flow_id,
       f.contact_id,
       f.rebill_customer_id,
       f.rebill_card_id,
       p.status AS payment_status,
       p.payment_url
     FROM installment_payments i
     JOIN payment_flows f ON f.id = i.flow_id
     LEFT JOIN payments p ON p.id = i.payment_id
     WHERE f.payment_provider = 'rebill'
       AND f.current_state = ?
       AND f.rebill_card_id IS NOT NULL
       AND i.automatic = 1
       AND i.payment_id IS NOT NULL
       AND (
         i.status = 'scheduled'
         OR (i.status = 'processing' AND ${staleInstallmentSql})
       )
       AND p.status IN ('scheduled', 'pending', 'processing')
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
    const hasSavedCard = Boolean(row.rebill_card_id && row.current_state === REBILL_PLAN_STATES.ACTIVE)

    if (hasSavedCard) {
      try {
        const claim = await db.run(
          `UPDATE payment_flows
           SET first_payment_status = 'processing',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?
             AND (first_payment_status IN ('pending', 'scheduled') OR (first_payment_status = 'processing' AND ${staleFirstPaymentClaimSql}))`,
          [row.flow_id]
        )
        if (!(Number(claim?.changes || 0) > 0)) continue

        const savedSource = await resolveRebillSavedSource(row.contact_id, row.rebill_card_id, { mode: metadata.paymentMode || metadata.rebillMode })
        if (!savedSource) {
          throw new Error('No encontramos la tarjeta guardada de Rebill para el primer pago programado.')
        }

        const charged = await chargeRebillPaymentRowWithSavedSource({
          paymentId: row.payment_id,
          savedSource,
          source: 'rebill_payment_plan_first_scheduled_charge',
          extraMetadata: {
            flowId: row.flow_id,
            trigger: 'first_payment_saved_card'
          }
        })

        await db.run(
          `UPDATE payment_flows
           SET first_payment_status = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [charged?.status === 'paid' ? 'paid' : charged?.status || 'pending', row.flow_id]
        )
        results.push({ type: 'first_payment', flowId: row.flow_id, paymentId: row.payment_id, charged: charged?.status === 'paid', status: charged?.status })
      } catch (error) {
        logger.error(`[Rebill Planes] Error cobrando primer pago ${row.payment_id}: ${error.message}`)
        await db.run(
          `UPDATE payment_flows
           SET first_payment_status = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [Number(error.status) === 417 ? 'requires_action' : 'failed', row.flow_id]
        )
        results.push({ type: 'first_payment', flowId: row.flow_id, paymentId: row.payment_id, error: error.message })
      }
      continue
    }

    if (cleanString(row.first_payment_status, 80) !== 'scheduled' && !(cleanString(row.first_payment_status, 80) === 'processing')) {
      continue
    }

    try {
      const claim = await db.run(
        `UPDATE payment_flows
         SET first_payment_status = 'processing',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND (first_payment_status = 'scheduled' OR (first_payment_status = 'processing' AND ${staleFirstPaymentClaimSql}))`,
        [row.flow_id]
      )
      if (!(Number(claim?.changes || 0) > 0)) continue

      const released = await releaseRebillPlanPaymentLink(row.payment_id, {
        baseUrl: resolvedBaseUrl,
        notes: 'Link de Rebill liberado automáticamente por fecha programada.'
      })
      await db.run(
        `UPDATE payment_flows
         SET first_payment_status = 'pending',
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
    if (row.payment_status === 'paid') {
      await db.run(
        `UPDATE installment_payments
         SET status = 'paid',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [row.installment_id]
      )
      results.push({ type: 'installment', flowId: row.flow_id, installmentId: row.installment_id, paymentId: row.payment_id, skipped: true, reason: 'already_paid' })
      continue
    }

    try {
      const claim = await db.run(
        `UPDATE installment_payments
         SET status = 'processing',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND (status = 'scheduled' OR (status = 'processing' AND ${staleInstallmentClaimSql}))`,
        [row.installment_id]
      )
      if (!(Number(claim?.changes || 0) > 0)) continue

      const savedSource = await resolveRebillSavedSource(row.contact_id, row.rebill_card_id)
      if (!savedSource) {
        throw new Error('No encontramos la tarjeta guardada de Rebill para esta parcialidad.')
      }

      const charged = await chargeRebillPaymentRowWithSavedSource({
        paymentId: row.payment_id,
        savedSource,
        source: 'rebill_payment_plan_installment',
        extraMetadata: {
          flowId: row.flow_id,
          installmentId: row.installment_id
        }
      })

      await db.run(
        `UPDATE installment_payments
         SET status = ?,
             rebill_payment_id = COALESCE(?, rebill_payment_id),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          charged?.status === 'paid' ? 'paid' : (charged?.status || 'processing'),
          charged?.rebill_payment_id || null,
          row.installment_id
        ]
      )

      results.push({ type: 'installment', flowId: row.flow_id, installmentId: row.installment_id, paymentId: row.payment_id, charged: charged?.status === 'paid', status: charged?.status })
    } catch (error) {
      logger.error(`[Rebill Planes] Error cobrando parcialidad ${row.installment_id}: ${error.message}`)
      await db.run(
        `UPDATE installment_payments
         SET status = ?,
             notes = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [Number(error.status) === 417 ? 'requires_action' : 'failed', error.message || 'Rebill no pudo completar el cobro.', row.installment_id]
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
  const cardId = cleanString(card.id || rebillPayment.cardId || rebillPayment.card_id, 180)
  const cardLast4 = getRebillCardLast4(card, rebillPayment.cardLastFour || rebillPayment.card_last_four)

  return {
    paymentId: cleanString(rebillPayment.id, 180),
    subscriptionId: cleanString(rebillPayment.subscriptionId || rebillPayment.subscription_id, 180),
    customerId: cleanString(customer.id || rebillPayment.customerId || rebillPayment.customer_id, 180),
    cardId,
    status: cleanString(rebillPayment.status, 80),
    paymentMethodType: cleanString(rebillPayment.paymentMethodType || rebillPayment.payment_method_type, 80),
    installments: rebillPayment.installments || null,
    country: cleanString(rebillPayment.country, 2),
    processingMode: cleanString(rebillPayment.processingMode || rebillPayment.processing_mode, 80),
    traceId: cleanString(rebillPayment.traceId || rebillPayment.trace_id, 180),
    card: cardId
      ? {
          id: cardId,
          brand: cleanString(card.brand, 80),
          type: cleanString(card.type, 80),
          lastFourDigits: cardLast4,
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
     SELECT id AS flow_id FROM payment_flows WHERE card_setup_invoice_id = ?
     UNION
     SELECT id AS flow_id FROM payment_flows WHERE first_payment_invoice_id = ?`,
    [payment.id, payment.id, payment.id]
  ).catch(() => [])
  const rebillMetadata = parseJson(payment.metadata_json, {})?.rebill || {}
  const savedSource = status === 'paid'
    ? await upsertRebillPaymentSource({
        contactId: payment.contact_id,
        customerId: payment.rebill_customer_id || rebillMetadata.customerId,
        cardId: payment.rebill_card_id || rebillMetadata.cardId,
        card: rebillMetadata.card || {},
        mode: payment.payment_mode
      }).catch((error) => {
        logger.warn(`No se pudo guardar tarjeta Rebill para pago ${payment.id}: ${error.message}`)
        return null
      })
    : null
  const cardLabel = savedSource ? getRebillSavedCardLabelFromRow(savedSource) : ''

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
    if (!row?.flow_id) continue

    if (savedSource && status === 'paid') {
      const flow = await db.get('SELECT * FROM payment_flows WHERE id = ?', [row.flow_id]).catch(() => null)
      if (flow?.payment_provider === 'rebill') {
        const history = addPlanState(parseJson(flow.state_history, []), REBILL_PLAN_STATES.ACTIVE)
        await db.run(
          `UPDATE payment_flows
           SET rebill_customer_id = ?,
               rebill_card_id = ?,
               rebill_card_label = ?,
               card_authorized_at = COALESCE(card_authorized_at, ?),
               installment_plan_active_at = COALESCE(installment_plan_active_at, ?),
               current_state = ?,
               state_history = ?,
               card_setup_required = 0,
               card_setup_status = CASE
                 WHEN card_setup_invoice_id = ? THEN 'paid'
                 ELSE card_setup_status
               END,
               first_payment_status = CASE
                 WHEN first_payment_invoice_id = ? THEN 'paid'
                 ELSE first_payment_status
               END,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [
            savedSource.rebill_customer_id,
            savedSource.rebill_card_id,
            cardLabel,
            new Date().toISOString(),
            new Date().toISOString(),
            REBILL_PLAN_STATES.ACTIVE,
            JSON.stringify(history),
            payment.id,
            payment.id,
            row.flow_id
          ]
        ).catch(() => undefined)

        await db.run(
          `UPDATE installment_payments
           SET status = 'scheduled',
               payment_method = 'rebill_saved_card',
               notes = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE flow_id = ?
             AND automatic = 1
             AND status IN (?, 'pending')`,
          [
            `Programado para cobrarse con ${cardLabel}.`,
            row.flow_id,
            REBILL_PLAN_STATES.WAITING_CARD_AUTHORIZATION
          ]
        ).catch(() => undefined)

        await db.run(
          `UPDATE payments
           SET status = CASE WHEN status IN (?, 'pending') THEN 'scheduled' ELSE status END,
               payment_method = CASE WHEN payment_method = 'rebill_scheduled_card' THEN 'rebill_scheduled_card' ELSE payment_method END,
               updated_at = CURRENT_TIMESTAMP
           WHERE id IN (
             SELECT payment_id
             FROM installment_payments
             WHERE flow_id = ?
               AND automatic = 1
               AND payment_id IS NOT NULL
           )`,
          [REBILL_PLAN_STATES.WAITING_CARD_AUTHORIZATION, row.flow_id]
        ).catch(() => undefined)
      }
    }

    await persistRebillPaymentPlanMirror(row.flow_id).catch(() => undefined)
  }
}

async function updatePaymentFromRebillPayment(rebillPayment = {}) {
  const rebillPaymentId = cleanString(rebillPayment?.id, 180)
  if (!rebillPaymentId) return null

  let row = await findPaymentByRebillPaymentId(rebillPaymentId)
  const metadata = rebillPayment.metadata && typeof rebillPayment.metadata === 'object' ? rebillPayment.metadata : {}
  const localPaymentId = cleanString(metadata.localPaymentId || metadata.local_payment_id || metadata.paymentId || metadata.payment_id, 180)
  const publicPaymentId = cleanString(metadata.publicPaymentId || metadata.public_payment_id, 180)
  if (!row && localPaymentId) row = await findPaymentById(localPaymentId)
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
  const currentMetadata = parseJson(row.metadata_json, {})
  const selectedInstallments = normalizeRebillSelectedInstallments(rebillPayment.installments)
  const currentInstallments = currentMetadata.rebillInstallments && typeof currentMetadata.rebillInstallments === 'object'
    ? currentMetadata.rebillInstallments
    : null
  const nextRebillInstallments = currentInstallments || selectedInstallments
    ? {
        ...(currentInstallments || {}),
        ...(selectedInstallments ? { selectedInstallments } : {})
      }
    : null
  const nextMetadata = {
    ...currentMetadata,
    ...(nextRebillInstallments ? { rebillInstallments: nextRebillInstallments } : {}),
    rebill: rebillMetadata
  }
  const nextPaymentMethod = REBILL_STORED_CARD_METHODS.has(cleanString(row.payment_method, 80).toLowerCase()) ||
    cleanString(row.payment_method, 80).toLowerCase() === 'rebill_scheduled_card'
    ? 'rebill_saved_card'
    : 'rebill_checkout'

  await db.run(
    `UPDATE payments
     SET amount = COALESCE(?, amount),
         currency = COALESCE(?, currency),
         status = ?,
         payment_method = ?,
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
      nextPaymentMethod,
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
  const selectedInstallments = normalizeRebillSelectedInstallments(input.installments || input.selectedInstallments || input.selected_installments)
  const updated = await updatePaymentFromRebillPayment({
    ...payload,
    installments: payload?.installments || selectedInstallments || undefined,
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
