import { createVerify, randomBytes } from 'crypto'
import fetch from 'node-fetch'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { decrypt, encrypt, isEncrypted } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'
import { updateSingleContactStats } from '../utils/updateContactsStats.js'
import { getAccountCurrency } from '../utils/accountLocale.js'
import { calculatePaymentTax, getPaymentGatewayMode, getPublicPaymentSettings } from './paymentSettingsService.js'
import { queuePaymentAutomationMessage } from './paymentAutomationsService.js'
import { registerGigstackPaymentForTransactionInBackground } from './gigstackInvoiceService.js'
import { getPaymentPlanAuditSummary, hardDeleteTestPaymentPlan } from './paymentRecordSafetyService.js'
import { buildMetaPublicPurchasePixelEvent } from './metaConversionEventsService.js'

const CONFIG_KEYS = {
  enabled: 'conekta_enabled',
  mode: 'conekta_mode',
  defaultCurrency: 'conekta_default_currency',
  accountLabel: 'conekta_account_label',
  publicKey: 'conekta_public_key',
  privateKey: 'conekta_private_key_encrypted',
  modeConnections: 'conekta_mode_connections',
  disconnectedAt: 'conekta_disconnected_at'
}

const CONEKTA_MODES = ['test', 'live']
const DEFAULT_CURRENCY = 'MXN'
const CONEKTA_API_BASE = 'https://api.conekta.io'
const CONEKTA_API_ACCEPT = 'application/vnd.conekta-v2.2.0+json'
const CONEKTA_WEBHOOK_EVENTS = [
  'order.paid',
  'order.pending_payment',
  'order.declined',
  'order.canceled',
  'order.expired',
  'order.charged_back',
  'order.refunded',
  'subscription.created',
  'subscription.paused',
  'subscription.resumed',
  'subscription.canceled',
  'subscription.paid',
  'subscription.payment_failed',
  'subscription.updated'
]
const DEFAULT_PAYMENT_TIMEZONE = 'America/Mexico_City'
const isPostgresRuntime = Boolean(process.env.DATABASE_URL)
const CONEKTA_PLAN_STATES = {
  WAITING_CARD_AUTHORIZATION: 'waiting_card_authorization',
  INSTALLMENT_PLAN_ACTIVE: 'installment_plan_active',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
  DELETED: 'deleted'
}
const MANUAL_PLAN_PAYMENT_METHODS = new Set(['cash', 'bank_transfer', 'transfer', 'deposit', 'manual', 'offline', 'check', 'other'])
const CARD_PLAN_PAYMENT_METHODS = new Set(['card', 'payment_link', 'direct_card', 'saved_card', 'conekta', 'conekta_saved_card'])
const AUTOMATIC_PLAN_PAYMENT_METHODS = new Set(['', 'conekta_auto', 'conekta_saved_card', 'conekta_pending_card', 'conekta_scheduled_card', ...CARD_PLAN_PAYMENT_METHODS])
const FIRST_PAYMENT_PLAN_TRIGGERS = new Set(['first_payment', 'first_payment_saved_card'])
const CARD_SETUP_PLAN_TRIGGERS = new Set(['card_setup', 'card_setup_authorization'])
const SUCCESSFUL_PAYMENT_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'captured'])
const LOCKED_PLAN_PAYMENT_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'refunded', 'void', 'deleted', 'cancelled', 'canceled'])
const TIMED_PLAN_FREQUENCY = 'scheduled_time'
const TIMED_PLAN_FREQUENCY_ALIASES = new Set([TIMED_PLAN_FREQUENCY, 'scheduled-time', 'scheduledat', 'scheduled_at', 'timed', 'datetime'])
const PLAN_FREQUENCIES = new Set(['custom', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly', TIMED_PLAN_FREQUENCY])

let conektaFetchForTest = null

export function setConektaFetchForTest(fetchImpl) {
  conektaFetchForTest = typeof fetchImpl === 'function' ? fetchImpl : null
}

function conektaFetch() {
  return conektaFetchForTest || fetch
}

function cleanString(value) {
  return String(value || '').trim()
}

function normalizeWebhookUrl(value) {
  const clean = cleanString(value).replace(/\/+$/, '')
  if (!clean) return ''
  try {
    const parsed = new URL(clean)
    const host = parsed.hostname.toLowerCase()
    if (parsed.protocol !== 'https:') return ''
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

function sanitizeConektaText(value, fallback = 'Ristak', maxLength = 250) {
  const fallbackText = cleanString(fallback) || 'Ristak'
  const raw = cleanString(value) || fallbackText
  const ascii = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  const sanitized = ascii
    .replace(/[^a-zA-Z0-9 .-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return (sanitized || fallbackText).slice(0, maxLength)
}

function sanitizeConektaName(value, fallback = 'Cliente Ristak', maxLength = 120) {
  const fallbackText = sanitizeConektaText(fallback, 'Cliente Ristak', maxLength)
  const raw = cleanString(value) || fallbackText
  const ascii = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  const sanitized = ascii
    .replace(/[^a-zA-Z .-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return (sanitized || fallbackText).slice(0, maxLength)
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

async function getConfiguredCurrency() {
  try {
    return normalizeCurrency(await getAccountCurrency())
  } catch {
    return DEFAULT_CURRENCY
  }
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${randomBytes(6).toString('hex')}`
}

function createPublicId() {
  return `pay_${randomBytes(18).toString('base64url')}`
}

function buildPaymentUrl(baseUrl, publicPaymentId) {
  const cleanBase = cleanString(baseUrl).replace(/\/+$/, '')
  return cleanBase ? `${cleanBase}/pay/${encodeURIComponent(publicPaymentId)}` : ''
}

function getConfiguredBaseUrl() {
  return cleanString(
    process.env.PUBLIC_APP_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    process.env.PUBLIC_URL ||
    process.env.APP_URL
  )
}

function buildConektaSubscriptionReturnUrl(baseUrl, result, publicPaymentId = '') {
  const cleanBase = cleanString(baseUrl || getConfiguredBaseUrl()).replace(/\/+$/, '') || 'https://www.ristak.com'
  const cleanPublicPaymentId = cleanString(publicPaymentId)
  if (cleanPublicPaymentId) {
    return `${cleanBase}/pay/${encodeURIComponent(cleanPublicPaymentId)}?payment=return&conekta_subscription=${encodeURIComponent(result)}`
  }
  return `${cleanBase}/transactions/subscriptions?conekta_subscription=${encodeURIComponent(result)}`
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

function previewSecret(value) {
  const clean = cleanString(value)
  if (!clean) return ''
  if (clean.length <= 8) return '••••'
  return `${clean.slice(0, 4)}••••${clean.slice(-4)}`
}

function isMaskedSecret(value) {
  const clean = cleanString(value)
  if (!clean) return false
  return clean.includes('•') || /^\*+$/.test(clean) || /^x+$/i.test(clean)
}

function normalizePositiveAmount(value, fallback = 25) {
  const amount = Number(value)
  if (Number.isFinite(amount) && amount > 0) return Math.round(amount * 100) / 100
  return Math.round(Number(fallback || 25) * 100) / 100
}

function toConektaAmount(value) {
  return Math.round(normalizePositiveAmount(value) * 100)
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

function normalizeStoredModeConnection(value = {}, mode = 'test', { includeSecrets = false } = {}) {
  if (!value || typeof value !== 'object') {
    return {
      mode,
      configured: false,
      publicKey: '',
      privateKey: includeSecrets ? '' : undefined,
      hasPrivateKey: false,
      privateKeyPreview: '',
      webhookId: '',
      webhookUrl: '',
      webhookStatus: '',
      webhookSyncedAt: '',
      webhookLastError: '',
      webhookKeyId: '',
      webhookPublicKey: '',
      webhookConfigured: false,
      webhookKeyConfigured: false,
      updatedAt: ''
    }
  }

  const privateKey = decryptSecret(value.privateKey || value.private_key)
  const publicKey = cleanString(value.publicKey || value.public_key)
  const configured = Boolean(publicKey && privateKey)

  return {
    mode: normalizeMode(value.mode || mode),
    configured,
    publicKey,
    ...(includeSecrets ? { privateKey } : {}),
    hasPrivateKey: Boolean(privateKey),
    privateKeyPreview: privateKey ? previewSecret(privateKey) : '',
    webhookId: cleanString(value.webhookId || value.webhook_id),
    webhookUrl: cleanString(value.webhookUrl || value.webhook_url),
    webhookStatus: cleanString(value.webhookStatus || value.webhook_status),
    webhookSyncedAt: cleanString(value.webhookSyncedAt || value.webhook_synced_at),
    webhookLastError: cleanString(value.webhookLastError || value.webhook_last_error),
    webhookKeyId: cleanString(value.webhookKeyId || value.webhook_key_id),
    webhookPublicKey: cleanString(value.webhookPublicKey || value.webhook_public_key),
    webhookConfigured: Boolean(cleanString(value.webhookId || value.webhook_id) && cleanString(value.webhookUrl || value.webhook_url)),
    webhookKeyConfigured: Boolean(cleanString(value.webhookPublicKey || value.webhook_public_key)),
    updatedAt: cleanString(value.updatedAt || value.updated_at)
  }
}

function serializeModeConnection(connection = {}) {
  const privateKey = cleanString(connection.privateKey)
  return {
    mode: normalizeMode(connection.mode),
    publicKey: cleanString(connection.publicKey),
    privateKey: privateKey ? encrypt(privateKey) : '',
    webhookId: cleanString(connection.webhookId),
    webhookUrl: cleanString(connection.webhookUrl),
    webhookStatus: cleanString(connection.webhookStatus),
    webhookSyncedAt: cleanString(connection.webhookSyncedAt),
    webhookLastError: cleanString(connection.webhookLastError),
    webhookKeyId: cleanString(connection.webhookKeyId),
    webhookPublicKey: cleanString(connection.webhookPublicKey),
    updatedAt: cleanString(connection.updatedAt || new Date().toISOString())
  }
}

function buildModeConnectionFromInput(mode, input = {}, current = {}) {
  const normalizedCurrent = normalizeStoredModeConnection(current, mode, { includeSecrets: true })
  if (!input || typeof input !== 'object') return normalizedCurrent

  const publicKeyProvided = Object.prototype.hasOwnProperty.call(input, 'publicKey')
    || Object.prototype.hasOwnProperty.call(input, 'public_key')
  const privateKeyProvided = Object.prototype.hasOwnProperty.call(input, 'privateKey')
    || Object.prototype.hasOwnProperty.call(input, 'private_key')

  const nextPublicKey = publicKeyProvided
    ? cleanString(input.publicKey || input.public_key)
    : normalizedCurrent.publicKey
  const rawPrivateKey = cleanString(input.privateKey || input.private_key)
  const nextPrivateKey = privateKeyProvided
    ? (isMaskedSecret(rawPrivateKey) ? normalizedCurrent.privateKey : rawPrivateKey)
    : normalizedCurrent.privateKey
  const configured = Boolean(nextPublicKey && nextPrivateKey)

  return {
    mode,
    publicKey: nextPublicKey,
    privateKey: nextPrivateKey,
    configured,
    webhookId: configured ? cleanString(normalizedCurrent.webhookId) : '',
    webhookUrl: configured ? cleanString(normalizedCurrent.webhookUrl) : '',
    webhookStatus: configured ? cleanString(normalizedCurrent.webhookStatus) : '',
    webhookSyncedAt: configured ? cleanString(normalizedCurrent.webhookSyncedAt) : '',
    webhookLastError: configured ? cleanString(normalizedCurrent.webhookLastError) : '',
    webhookKeyId: configured ? cleanString(normalizedCurrent.webhookKeyId) : '',
    webhookPublicKey: configured ? cleanString(normalizedCurrent.webhookPublicKey) : '',
    webhookConfigured: configured ? Boolean(normalizedCurrent.webhookConfigured) : false,
    webhookKeyConfigured: configured ? Boolean(normalizedCurrent.webhookKeyConfigured) : false,
    updatedAt: configured ? new Date().toISOString() : ''
  }
}

function chooseMode(connections = {}, preferred = 'live') {
  const preferredMode = normalizeMode(preferred)
  if (connections[preferredMode]?.configured || (connections[preferredMode]?.publicKey && connections[preferredMode]?.privateKey)) return preferredMode
  if (connections.live?.configured || (connections.live?.publicKey && connections.live?.privateKey)) return 'live'
  if (connections.test?.configured || (connections.test?.publicKey && connections.test?.privateKey)) return 'test'
  return preferredMode
}

function getConnectionApiConfig(connection = {}) {
  return {
    configured: Boolean(connection.publicKey && connection.privateKey),
    mode: normalizeMode(connection.mode),
    publicKey: cleanString(connection.publicKey),
    privateKey: cleanString(connection.privateKey),
    accountLabel: 'Conekta'
  }
}

function extractConektaCollection(payload = {}) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

function normalizeConektaWebhookStatus(webhook = {}) {
  if (cleanString(webhook.status)) return cleanString(webhook.status)
  if (webhook.active === false) return 'disabled'
  return 'active'
}

function getDigestCandidates(header = '') {
  return cleanString(header)
    .split(',')
    .map((part) => {
      const clean = part.trim()
      if (!clean) return ''
      const equalIndex = clean.indexOf('=')
      const digestPrefix = equalIndex > 0 ? clean.slice(0, equalIndex).trim() : ''
      if (equalIndex === -1 || equalIndex > 24 || !/^[a-z0-9_-]+$/i.test(digestPrefix)) return clean
      return clean.slice(equalIndex + 1).trim()
    })
    .map((value) => value.replace(/^"|"$/g, ''))
    .filter(Boolean)
}

function verifyConektaRawBody(rawBody = '', digestHeader = '', publicKey = '') {
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '')
  const key = cleanString(publicKey)
  if (!body || !key) return false

  for (const digest of getDigestCandidates(digestHeader)) {
    try {
      const verifier = createVerify('RSA-SHA256')
      verifier.update(body, 'utf8')
      verifier.end()
      if (verifier.verify(key, Buffer.from(digest, 'base64'))) return true
    } catch {
      // Intencional: probamos el siguiente formato/candidato de DIGEST.
    }
  }

  return false
}

async function ensureConektaWebhookKey(connection = {}) {
  if (cleanString(connection.webhookPublicKey)) return connection

  const { payload } = await conektaApiRequest('/webhook_keys', {
    method: 'POST',
    body: { active: true },
    config: getConnectionApiConfig(connection)
  })

  const publicKey = cleanString(payload?.public_key || payload?.publicKey)
  if (!publicKey) {
    const error = new Error('Conekta no devolvió la llave pública del webhook.')
    error.status = 502
    throw error
  }

  return {
    ...connection,
    webhookKeyId: cleanString(payload?.id || connection.webhookKeyId),
    webhookPublicKey: publicKey,
    webhookKeyConfigured: true
  }
}

async function syncConektaWebhookForConnection(connection = {}, webhookUrl = '') {
  const normalizedUrl = normalizeWebhookUrl(webhookUrl)
  if (!connection.publicKey || !connection.privateKey) return connection

  if (!normalizedUrl) {
    return {
      ...connection,
      webhookStatus: connection.webhookId ? 'configured' : 'pending_public_url',
      webhookLastError: ''
    }
  }

  const keyedConnection = await ensureConektaWebhookKey(connection)
  const { payload: listPayload } = await conektaApiRequest('/webhooks?limit=250', {
    config: getConnectionApiConfig(keyedConnection)
  })
  const webhooks = extractConektaCollection(listPayload)
  const sameUrl = (webhook) => cleanString(webhook?.url).replace(/\/+$/, '').toLowerCase() === normalizedUrl.toLowerCase()
  const existing = webhooks.find((webhook) => cleanString(webhook?.id) === cleanString(keyedConnection.webhookId)) ||
    webhooks.find(sameUrl)

  const body = {
    url: normalizedUrl,
    subscribed_events: CONEKTA_WEBHOOK_EVENTS,
    active: true
  }

  if (existing?.id) {
    if (!sameUrl(existing) || !sameEventSet(existing.subscribed_events, CONEKTA_WEBHOOK_EVENTS) || existing.active === false) {
      await conektaApiRequest(`/webhooks/${encodeURIComponent(existing.id)}`, {
        method: 'PUT',
        body,
        config: getConnectionApiConfig(keyedConnection)
      })
    }

    return {
      ...keyedConnection,
      webhookId: cleanString(existing.id),
      webhookUrl: normalizedUrl,
      webhookStatus: normalizeConektaWebhookStatus(existing),
      webhookSyncedAt: new Date().toISOString(),
      webhookLastError: '',
      webhookConfigured: true
    }
  }

  const { payload: created } = await conektaApiRequest('/webhooks', {
    method: 'POST',
    body,
    config: getConnectionApiConfig(keyedConnection)
  })

  return {
    ...keyedConnection,
    webhookId: cleanString(created?.id),
    webhookUrl: normalizedUrl,
    webhookStatus: normalizeConektaWebhookStatus(created),
    webhookSyncedAt: new Date().toISOString(),
    webhookLastError: '',
    webhookConfigured: Boolean(created?.id)
  }
}

async function syncConektaWebhooksForConnections(connections = {}, webhookUrl = '') {
  const next = { ...connections }

  for (const mode of CONEKTA_MODES) {
    const connection = next[mode]
    if (!connection?.publicKey || !connection?.privateKey) continue
    next[mode] = await syncConektaWebhookForConnection(connection, webhookUrl)
  }

  return next
}

async function getConektaWebhookVerificationKeys() {
  const config = await getConektaPaymentConfig({ includeSecrets: true })
  return CONEKTA_MODES
    .map((mode) => ({
      mode,
      publicKey: cleanString(config.manualModes?.[mode]?.webhookPublicKey)
    }))
    .filter((item) => item.publicKey)
}

export async function verifyConektaWebhookSignature(rawBody = '', digestHeader = '') {
  const keys = await getConektaWebhookVerificationKeys()
  if (keys.length === 0) return { configured: false, verified: false, mode: '' }
  if (!cleanString(digestHeader)) return { configured: true, verified: false, mode: '' }

  for (const key of keys) {
    if (verifyConektaRawBody(rawBody, digestHeader, key.publicKey)) {
      return { configured: true, verified: true, mode: key.mode }
    }
  }

  return { configured: true, verified: false, mode: '' }
}

async function getStoredModeConnections(raw = null, options = {}) {
  const values = raw || await readRawConfig()
  const stored = parseJson(values[CONFIG_KEYS.modeConnections], {})
  const legacyMode = normalizeMode(values[CONFIG_KEYS.mode])
  const connections = {
    test: normalizeStoredModeConnection(stored.test, 'test', options),
    live: normalizeStoredModeConnection(stored.live, 'live', options)
  }

  if (!connections[legacyMode]?.configured && values[CONFIG_KEYS.publicKey]) {
    const legacyPrivateKey = decryptSecret(values[CONFIG_KEYS.privateKey])
    connections[legacyMode] = {
      mode: legacyMode,
      configured: Boolean(values[CONFIG_KEYS.publicKey] && legacyPrivateKey),
      publicKey: cleanString(values[CONFIG_KEYS.publicKey]),
      ...(options.includeSecrets ? { privateKey: legacyPrivateKey } : {}),
      hasPrivateKey: Boolean(legacyPrivateKey),
      privateKeyPreview: legacyPrivateKey ? previewSecret(legacyPrivateKey) : '',
      webhookId: '',
      webhookUrl: '',
      webhookStatus: '',
      webhookSyncedAt: '',
      webhookLastError: '',
      webhookKeyId: '',
      webhookPublicKey: '',
      webhookConfigured: false,
      webhookKeyConfigured: false,
      updatedAt: ''
    }
  }

  return connections
}

export async function getConektaPaymentConfig(options = {}) {
  const raw = await readRawConfig()
  const modeConnections = await getStoredModeConnections(raw, options)
  const activeMode = normalizeMode(options.mode || await getPaymentGatewayMode())
  const active = modeConnections[activeMode] || modeConnections.test
  const enabled = normalizeBoolean(raw[CONFIG_KEYS.enabled], true)
  const configured = Boolean(enabled && active?.configured)

  return {
    enabled,
    configured,
    mode: activeMode,
    defaultCurrency: normalizeCurrency(raw[CONFIG_KEYS.defaultCurrency] || await getConfiguredCurrency()),
    accountLabel: cleanString(raw[CONFIG_KEYS.accountLabel] || 'Conekta'),
    publicKey: active?.publicKey || '',
    ...(options.includeSecrets ? { privateKey: active?.privateKey || '' } : {}),
    hasPrivateKey: Boolean(active?.hasPrivateKey),
    privateKeyPreview: active?.privateKeyPreview || '',
    webhookId: active?.webhookId || '',
    webhookUrl: active?.webhookUrl || '',
    webhookStatus: active?.webhookStatus || '',
    webhookSyncedAt: active?.webhookSyncedAt || '',
    webhookLastError: active?.webhookLastError || '',
    webhookKeyConfigured: Boolean(active?.webhookKeyConfigured || active?.webhookPublicKey),
    webhookConfigured: Boolean(active?.webhookConfigured || (active?.webhookId && active?.webhookUrl)),
    manualModes: {
      test: modeConnections.test,
      live: modeConnections.live
    }
  }
}

export async function saveConektaPaymentConfig(input = {}, options = {}) {
  const current = await getConektaPaymentConfig({ includeSecrets: true })
  const currentModes = current.manualModes || {
    test: normalizeStoredModeConnection({}, 'test', { includeSecrets: true }),
    live: normalizeStoredModeConnection({}, 'live', { includeSecrets: true })
  }
  const manualInput = input.manualModes && typeof input.manualModes === 'object'
    ? input.manualModes
    : {
        [normalizeMode(input.mode)]: {
          publicKey: input.publicKey,
          privateKey: input.privateKey
        }
      }
  let nextModes = {
    test: buildModeConnectionFromInput('test', manualInput.test, currentModes.test),
    live: buildModeConnectionFromInput('live', manualInput.live, currentModes.live)
  }

  if (Object.prototype.hasOwnProperty.call(options, 'webhookUrl')) {
    nextModes = await syncConektaWebhooksForConnections(nextModes, options.webhookUrl)
  }

  const activeMode = chooseMode(nextModes, input.mode || 'live')
  const active = nextModes[activeMode]

  if (!active.publicKey || !active.privateKey) {
    const error = new Error('Agrega al menos las llaves de prueba o en vivo de Conekta.')
    error.status = 400
    throw error
  }

  const accountCurrency = await getConfiguredCurrency()
  await setAppConfig(CONFIG_KEYS.enabled, normalizeBoolean(input.enabled, true) ? '1' : '0')
  await setAppConfig(CONFIG_KEYS.mode, activeMode)
  await setAppConfig(CONFIG_KEYS.defaultCurrency, accountCurrency)
  await setAppConfig(CONFIG_KEYS.accountLabel, cleanString(input.accountLabel || current.accountLabel || 'Conekta'))
  await setAppConfig(CONFIG_KEYS.publicKey, active.publicKey)
  await setAppConfig(CONFIG_KEYS.privateKey, encrypt(active.privateKey))
  await setAppConfig(CONFIG_KEYS.modeConnections, JSON.stringify({
    test: serializeModeConnection(nextModes.test),
    live: serializeModeConnection(nextModes.live)
  }))
  await db.run('DELETE FROM app_config WHERE config_key = ?', [CONFIG_KEYS.disconnectedAt])

  return getConektaPaymentConfig()
}

export async function deleteConektaPaymentConfig() {
  const configKeys = Object.values(CONFIG_KEYS).filter((key) => key !== CONFIG_KEYS.disconnectedAt)
  await db.run(
    `DELETE FROM app_config WHERE config_key IN (${configKeys.map(() => '?').join(', ')})`,
    configKeys
  )
  await setAppConfig(CONFIG_KEYS.disconnectedAt, new Date().toISOString())
  return getConektaPaymentConfig()
}

function getConektaAuthHeaders(config) {
  return {
    Accept: CONEKTA_API_ACCEPT,
    'Accept-Language': 'es',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.privateKey}`
  }
}

async function conektaApiRequest(path, { method = 'GET', body = null, config: providedConfig = null, idempotencyKey = null } = {}) {
  const config = providedConfig || await getConektaPaymentConfig({ includeSecrets: true })
  if (!config.configured || !config.privateKey) {
    const error = new Error('Conekta no está configurado todavía. Guarda las llaves primero.')
    error.status = 400
    throw error
  }

  // (PAY2-001 / CRON-001) Idempotency-Key estable para cobros: si dos ejecuciones
  // concurrentes alcanzan a llamar /orders para la misma parcialidad, Conekta dedupe
  // por esta clave y NO genera un segundo cargo a la tarjeta.
  const headers = getConektaAuthHeaders(config)
  const cleanIdempotencyKey = cleanString(idempotencyKey)
  if (cleanIdempotencyKey) {
    headers['Idempotency-Key'] = cleanIdempotencyKey
  }

  const response = await conektaFetch()(`${CONEKTA_API_BASE}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const payload = await response.json().catch(() => ({}))

  if (!response.ok) {
    const details = Array.isArray(payload?.details)
      ? payload.details.map((detail) => detail?.message || detail?.debug_message).filter(Boolean).join(' ')
      : ''
    const message = cleanString(payload?.message || payload?.error || details) || 'Conekta no pudo completar la operación.'
    const error = new Error(message)
    error.status = response.status || 500
    error.payload = payload
    throw error
  }

  return { payload, config }
}

export async function testConektaPaymentConfig(input = null) {
  let config = null
  if (input?.manualModes && typeof input.manualModes === 'object') {
    const current = await getConektaPaymentConfig({ includeSecrets: true })
    const currentModes = current.manualModes || {}
    const nextModes = {
      test: buildModeConnectionFromInput('test', input.manualModes.test, currentModes.test),
      live: buildModeConnectionFromInput('live', input.manualModes.live, currentModes.live)
    }
    const activeMode = chooseMode(nextModes, input.mode || 'live')
    const active = nextModes[activeMode]
    config = {
      ...current,
      configured: Boolean(active.publicKey && active.privateKey),
      mode: activeMode,
      publicKey: active.publicKey,
      privateKey: active.privateKey
    }
  } else if (input?.privateKey || input?.publicKey) {
    const current = await getConektaPaymentConfig({ includeSecrets: true })
    config = {
      ...current,
      configured: Boolean(input.publicKey || current.publicKey) && Boolean(input.privateKey || current.privateKey),
      mode: normalizeMode(input.mode || current.mode),
      publicKey: cleanString(input.publicKey || current.publicKey),
      privateKey: cleanString(isMaskedSecret(input.privateKey) ? current.privateKey : input.privateKey || current.privateKey)
    }
  } else {
    config = await getConektaPaymentConfig({ includeSecrets: true })
  }

  const { payload } = await conektaApiRequest('/customers?limit=1', { config })
  return {
    ok: true,
    mode: config.mode,
    publicKey: config.publicKey,
    accountLabel: config.accountLabel || 'Conekta',
    customersAvailable: Array.isArray(payload?.data) ? payload.data.length : Number(payload?.total || 0)
  }
}

async function findPaymentByPublicId(publicPaymentId) {
  return db.get(
    `SELECT
      p.*,
      c.full_name AS contact_name,
      c.email AS contact_email,
      c.phone AS contact_phone,
      c.conekta_customer_id AS contact_conekta_customer_id
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
      c.phone AS contact_phone,
      c.conekta_customer_id AS contact_conekta_customer_id
     FROM payments p
     LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE p.id = ?`,
    [paymentId]
  )
}

function mapPublicPayment(row, config, baseUrl = '', settings = null) {
  if (!row) return null
  const metadata = parseJson(row.metadata_json, {})
  const tax = metadata.tax && typeof metadata.tax === 'object' ? metadata.tax : null
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
    paymentMode: row.payment_mode || config?.mode || 'test',
    provider: 'conekta',
    contact: {
      id: row.contact_id || '',
      name: row.contact_name || metadata.contactName || '',
      email: row.contact_email || metadata.contactEmail || '',
      phone: row.contact_phone || metadata.contactPhone || ''
    },
    conektaOrderId: row.conekta_order_id || null,
    conektaChargeId: row.conekta_charge_id || null,
    publicKey: config?.publicKey || '',
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

function buildContactName(contact = {}, fallback = {}) {
  const name = cleanString(contact.full_name)
    || cleanString(`${contact.first_name || ''} ${contact.last_name || ''}`)
    || cleanString(fallback.contactName)
    || cleanString(fallback.name)
    || cleanString(contact.email)
    || cleanString(contact.phone)
    || 'Cliente Ristak'

  return sanitizeConektaName(name, 'Cliente Ristak', 120)
}

async function getConektaContact(contactId) {
  const id = cleanString(contactId)
  if (!id) return null

  return db.get(
    `SELECT id, full_name, first_name, last_name, email, phone, conekta_customer_id
     FROM contacts
     WHERE id = ?`,
    [id]
  )
}

async function ensureConektaCustomerForContact(contactId, fallback = {}) {
  const contact = await getConektaContact(contactId)
  if (!contact) {
    const error = new Error('Contacto no encontrado.')
    error.status = 404
    throw error
  }

  if (cleanString(contact.conekta_customer_id)) return cleanString(contact.conekta_customer_id)

  const body = {
    name: buildContactName(contact, fallback),
    email: cleanString(contact.email || fallback.email || fallback.contactEmail),
    phone: cleanString(contact.phone || fallback.phone || fallback.contactPhone),
    custom_reference: contact.id
  }
  Object.keys(body).forEach((key) => {
    if (!body[key]) delete body[key]
  })

  const { payload } = await conektaApiRequest('/customers', {
    method: 'POST',
    body
  })
  const customerId = cleanString(payload?.id)
  if (!customerId) {
    const error = new Error('Conekta no devolvió el customer_id.')
    error.status = 502
    throw error
  }

  await db.run(
    `UPDATE contacts
     SET conekta_customer_id = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [customerId, contact.id]
  )

  return customerId
}

function extractCharge(order = {}) {
  const charges = order?.charges
  if (Array.isArray(charges)) return charges[0] || null
  if (Array.isArray(charges?.data)) return charges.data[0] || null
  return charges || null
}

function mapOrderStatus(order = {}) {
  const charge = extractCharge(order)
  const status = cleanString(order.payment_status || charge?.status || order.status).toLowerCase()
  if (['paid', 'succeeded', 'completed', 'captured'].includes(status)) return 'paid'
  if (['declined', 'failed', 'payment_failed', 'charged_back', 'canceled', 'cancelled'].includes(status)) return 'failed'
  if (['void', 'refunded'].includes(status)) return status
  return 'pending'
}

function extractConektaSubscriptionFromEvent(event = {}) {
  const dataObject = event?.data?.object
  if (dataObject && typeof dataObject === 'object' && cleanString(dataObject.object).toLowerCase() === 'subscription') {
    return dataObject
  }

  const directObject = event?.object
  if (directObject && typeof directObject === 'object' && cleanString(directObject.object).toLowerCase() === 'subscription') {
    return directObject
  }

  if (cleanString(event?.object).toLowerCase() === 'subscription') {
    return event
  }

  return null
}

function isConektaSubscriptionWebhook(event = {}) {
  return cleanString(event?.type).toLowerCase().startsWith('subscription.')
    || Boolean(extractConektaSubscriptionFromEvent(event))
}

function getConektaSubscriptionEventStatus(eventType, subscription = {}) {
  const normalizedType = cleanString(eventType).toLowerCase()
  if (normalizedType === 'subscription.payment_failed') return 'past_due'
  if (normalizedType === 'subscription.canceled') return 'cancelled'
  if (normalizedType === 'subscription.paused') return 'paused'
  if (normalizedType === 'subscription.resumed' || normalizedType === 'subscription.paid') return 'active'
  return mapConektaSubscriptionStatus(subscription?.status)
}

function getConektaSubscriptionPeriod(subscription = {}) {
  const nextRunAt = toIsoFromConektaTimestamp(
    subscription.next_billing_at
    || subscription.billing_cycle_end
    || subscription.current_period_end
    || subscription.trial_end
  )
  const currentPeriodStart = toIsoFromConektaTimestamp(
    subscription.billing_cycle_start
    || subscription.current_period_start
    || subscription.subscription_start
    || subscription.created_at
  )
  const currentPeriodEnd = toIsoFromConektaTimestamp(
    subscription.billing_cycle_end
    || subscription.current_period_end
    || subscription.charged_through
  )

  return {
    nextRunAt,
    currentPeriodStart,
    currentPeriodEnd
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
    publicPaymentId: cleanString(payment.publicPaymentId || legacy.publicPaymentId)
  }
}

async function findConektaSubscriptionForWebhook(subscription = {}) {
  const conektaSubscriptionId = cleanString(subscription.id)
  const conektaPlanId = cleanString(subscription.plan_id)
  const conektaCustomerId = cleanString(subscription.customer_id)
  const conektaCardId = cleanString(subscription.card_id)

  if (conektaSubscriptionId) {
    const match = await db.get(
      `SELECT *
       FROM subscriptions
       WHERE conekta_subscription_id = ?
       LIMIT 1`,
      [conektaSubscriptionId]
    )
    if (match?.id) return match
  }

  if (conektaPlanId) {
    const match = await db.get(
      `SELECT *
       FROM subscriptions
       WHERE conekta_plan_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
      [conektaPlanId]
    )
    if (match?.id) return match
  }

  if (conektaCustomerId && conektaCardId) {
    const match = await db.get(
      `SELECT *
       FROM subscriptions
       WHERE conekta_customer_id = ?
         AND conekta_payment_source_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
      [conektaCustomerId, conektaCardId]
    )
    if (match?.id) return match
  }

  return null
}

async function syncConektaSubscriptionPaymentFromWebhook(subscription = {}, subscriptionRow = {}, event = {}) {
  if (cleanString(event?.type).toLowerCase() !== 'subscription.paid') return null

  const chargeId = cleanString(subscription.charge_id)
  const orderId = cleanString(subscription.last_billing_cycle_order_id || subscription.order_id)
  if (!chargeId && !orderId) return null

  const existing = await db.get(
    `SELECT id
     FROM payments
     WHERE (conekta_charge_id IS NOT NULL AND conekta_charge_id = ?)
        OR (conekta_order_id IS NOT NULL AND conekta_order_id = ?)
     ORDER BY created_at DESC
     LIMIT 1`,
    [chargeId || '', orderId || '']
  )
  if (existing?.id) return { paymentId: existing.id, created: false, existing: true }

  const metadata = parseJson(subscriptionRow.metadata_json, {})
  const startPayment = getSubscriptionStartPaymentFromMetadata(metadata)
  const paidAt = toIsoFromConektaTimestamp(event.created_at) || new Date().toISOString()
  const cardId = cleanString(subscription.card_id)

  if (startPayment.paymentId) {
    const startPaymentRow = await db.get(
      `SELECT id, conekta_order_id, conekta_charge_id
       FROM payments
       WHERE id = ?
       LIMIT 1`,
      [startPayment.paymentId]
    )

    if (startPaymentRow?.id && !startPaymentRow.conekta_order_id && !startPaymentRow.conekta_charge_id) {
      await db.run(
        `UPDATE payments
         SET status = 'paid',
             payment_method = 'conekta_subscription',
             payment_provider = 'conekta',
             reference = COALESCE(?, reference),
             conekta_order_id = COALESCE(?, conekta_order_id),
             conekta_charge_id = COALESCE(?, conekta_charge_id),
             conekta_payment_source_id = COALESCE(?, conekta_payment_source_id),
             paid_at = COALESCE(paid_at, ?),
             date = COALESCE(date, ?),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          orderId || chargeId || null,
          orderId || null,
          chargeId || null,
          cardId || subscriptionRow.conekta_payment_source_id || null,
          paidAt,
          paidAt,
          startPaymentRow.id
        ]
      )

      if (subscriptionRow.contact_id) {
        updateSingleContactStats(subscriptionRow.contact_id).catch((error) => {
          logger.warn(`No se pudieron actualizar stats del contacto por suscripción Conekta ${subscriptionRow.id}: ${error.message}`)
        })
      }

      return { paymentId: startPaymentRow.id, created: false, updatedStartPayment: true }
    }
  }

  const paymentId = createId('conekta_subscription_payment')
  const currency = normalizeCurrency(subscriptionRow.currency || DEFAULT_CURRENCY)
  const amount = Number(subscriptionRow.amount || 0)
  const paymentMetadata = {
    source: 'conekta_subscription_webhook',
    ristakSubscriptionId: subscriptionRow.id,
    conektaSubscriptionId: cleanString(subscription.id),
    conektaPlanId: cleanString(subscription.plan_id),
    conektaCustomerId: cleanString(subscription.customer_id),
    conektaChargeId: chargeId,
    conektaOrderId: orderId
  }

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, reference, title, description, conekta_order_id,
      conekta_charge_id, conekta_payment_source_id, paid_at, metadata_json, date,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      paymentId,
      subscriptionRow.contact_id || null,
      Number.isFinite(amount) ? amount : 0,
      currency,
      'paid',
      'conekta_subscription',
      subscriptionRow.payment_mode || 'test',
      'conekta',
      orderId || chargeId,
      subscriptionRow.name || 'Suscripción',
      `Cobro recurrente de ${subscriptionRow.name || 'suscripción'}`,
      orderId || null,
      chargeId || null,
      cardId || subscriptionRow.conekta_payment_source_id || null,
      paidAt,
      JSON.stringify(paymentMetadata),
      paidAt
    ]
  )

  if (subscriptionRow.contact_id) {
    updateSingleContactStats(subscriptionRow.contact_id).catch((error) => {
      logger.warn(`No se pudieron actualizar stats del contacto por suscripción Conekta ${subscriptionRow.id}: ${error.message}`)
    })
  }

  return { paymentId, created: true }
}

export async function reconcileConektaSubscriptionFromWebhook(event = {}) {
  const subscription = extractConektaSubscriptionFromEvent(event)
  const conektaSubscriptionId = cleanString(subscription?.id)
  if (!subscription || !conektaSubscriptionId) return { matched: false, reason: 'sin_subscription_id' }

  const existing = await findConektaSubscriptionForWebhook(subscription)
  if (!existing?.id) return { matched: false, reason: 'suscripcion_no_encontrada' }

  const eventType = cleanString(event?.type).toLowerCase()
  const nextStatus = getConektaSubscriptionEventStatus(eventType, subscription)
  const period = getConektaSubscriptionPeriod(subscription)
  const cancelledAt = toIsoFromConektaTimestamp(subscription.canceled_at)
  const metadata = parseJson(existing.metadata_json, {})
  const raw = parseJson(existing.raw_json, {})
  const receivedAt = new Date().toISOString()
  const cardId = cleanString(subscription.card_id)
  const planId = cleanString(subscription.plan_id)
  const customerId = cleanString(subscription.customer_id)

  const changed = cleanString(existing.status).toLowerCase() !== nextStatus
    || (period.nextRunAt && period.nextRunAt !== existing.next_run_at)
    || (period.currentPeriodStart && period.currentPeriodStart !== existing.current_period_start)
    || (period.currentPeriodEnd && period.currentPeriodEnd !== existing.current_period_end)
    || (planId && planId !== existing.conekta_plan_id)
    || (customerId && customerId !== existing.conekta_customer_id)
    || (cardId && cardId !== existing.conekta_payment_source_id)

  await db.run(
    `UPDATE subscriptions
     SET status = ?,
         payment_method = 'conekta_subscription',
         payment_provider = 'conekta',
         conekta_subscription_id = COALESCE(?, conekta_subscription_id),
         conekta_customer_id = COALESCE(?, conekta_customer_id),
         conekta_plan_id = COALESCE(?, conekta_plan_id),
         conekta_payment_source_id = COALESCE(?, conekta_payment_source_id),
         conekta_next_billing_at = COALESCE(?, conekta_next_billing_at),
         current_period_start = COALESCE(?, current_period_start),
         current_period_end = COALESCE(?, current_period_end),
         next_run_at = COALESCE(?, next_run_at),
         cancelled_at = CASE
           WHEN ? = 'cancelled' THEN COALESCE(?, cancelled_at, CURRENT_TIMESTAMP)
           ELSE cancelled_at
         END,
         metadata_json = ?,
         raw_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      nextStatus,
      conektaSubscriptionId || null,
      customerId || null,
      planId || null,
      cardId || null,
      period.nextRunAt,
      period.currentPeriodStart,
      period.currentPeriodEnd,
      period.nextRunAt,
      nextStatus,
      cancelledAt,
      JSON.stringify({
        ...metadata,
        conektaSubscriptionWebhook: {
          type: eventType || null,
          eventId: cleanString(event?.id),
          receivedAt,
          status: nextStatus,
          conektaSubscriptionId,
          conektaChargeId: cleanString(subscription.charge_id),
          conektaOrderId: cleanString(subscription.last_billing_cycle_order_id || subscription.order_id)
        }
      }),
      JSON.stringify({
        ...raw,
        conektaSubscriptionWebhook: {
          type: eventType || null,
          eventId: cleanString(event?.id),
          receivedAt,
          subscription
        }
      }),
      existing.id
    ]
  )

  const refreshed = await db.get('SELECT * FROM subscriptions WHERE id = ?', [existing.id])
  const paymentSync = await syncConektaSubscriptionPaymentFromWebhook(subscription, refreshed || existing, event)

  if (changed) {
    logger.info(`[Conekta webhook] Suscripción ${existing.id} reconciliada: ${existing.status} -> ${nextStatus} (${conektaSubscriptionId})`)
  }

  return {
    matched: true,
    changed,
    subscriptionId: existing.id,
    conektaSubscriptionId,
    status: nextStatus,
    paymentSynced: Boolean(paymentSync?.paymentId),
    paymentCreated: Boolean(paymentSync?.created),
    paymentId: paymentSync?.paymentId || null
  }
}

export async function reconcileConektaWebhookEvent(event = {}) {
  if (isConektaSubscriptionWebhook(event)) {
    return reconcileConektaSubscriptionFromWebhook(event)
  }

  return reconcileConektaOrderFromWebhook(event)
}

function shouldIgnorePendingWebhookRegression(payment = {}, nextStatus = '') {
  if (nextStatus !== 'pending') return false
  const currentStatus = cleanString(payment.status).toLowerCase()
  return SUCCESSFUL_PAYMENT_STATUSES.has(currentStatus) || Boolean(payment.paid_at)
}

// (PAY2-002) Reconcilia un pago de Conekta a partir del payload de un webhook. Conekta
// envía { type, data: { object: <order> } } para eventos como order.paid / order.expired /
// charge.paid. Buscamos el pago local por conekta_order_id (o conekta_charge_id) y
// actualizamos su estado de forma idempotente (solo si cambió). Así los pagos 3DS/OXXO/SPEI
// que quedaban "pending" sí se reconcilian cuando Conekta confirma.
export async function reconcileConektaOrderFromWebhook(event = {}) {
  const order = event?.data?.object || event?.object || event || {}
  const orderId = cleanString(order?.id)
  const charge = extractCharge(order)
  const chargeId = cleanString(charge?.id)
  if (!orderId && !chargeId) return { matched: false, reason: 'sin_id' }

  let matchedPayment = null
  if (orderId) {
    matchedPayment = await db.get('SELECT id FROM payments WHERE conekta_order_id = ? ORDER BY created_at DESC LIMIT 1', [orderId])
  }
  if (!matchedPayment?.id && chargeId) {
    matchedPayment = await db.get('SELECT id FROM payments WHERE conekta_charge_id = ? ORDER BY created_at DESC LIMIT 1', [chargeId])
  }
  if (!matchedPayment?.id) return { matched: false, reason: 'pago_no_encontrado' }

  const payment = await findPaymentById(matchedPayment.id)
  if (!payment?.id) return { matched: false, reason: 'pago_no_encontrado' }

  const newStatus = mapOrderStatus(order)
  const currentStatus = cleanString(payment.status).toLowerCase()
  const ignorePendingRegression = shouldIgnorePendingWebhookRegression(payment, newStatus)
  const changed = !ignorePendingRegression && currentStatus !== newStatus
  const config = await getConektaPaymentConfig({ mode: payment.payment_mode || '' })
  const nextPayment = changed
    ? await updatePaymentFromOrder(order, payment)
    : payment

  const planSyncResult = await syncConektaPlanFromPayment(nextPayment, null, config)

  if (changed) {
    logger.info(`[Conekta webhook] Pago ${payment.id} reconciliado: ${payment.status} -> ${newStatus} (order ${orderId || chargeId})`)
  } else if (ignorePendingRegression) {
    logger.info(`[Conekta webhook] Ignorado estado pending tardío para pago ya pagado ${payment.id} (order ${orderId || chargeId})`)
  }

  return {
    matched: true,
    changed,
    paymentId: payment.id,
    status: nextPayment.status || newStatus,
    planSynced: Boolean(planSyncResult?.id)
  }
}

function getPaymentSourceCard(source = {}) {
  return source.card && typeof source.card === 'object' ? source.card : source
}

function mapPaymentSource(row = {}) {
  if (!row) return null
  const expMonth = Number(row.exp_month || 0)
  const expYear = Number(row.exp_year || 0)
  const brand = cleanString(row.brand) || 'card'
  const last4 = cleanString(row.last4)
  const expiresLabel = expMonth && expYear
    ? `${String(expMonth).padStart(2, '0')}/${String(expYear).slice(-2)}`
    : ''

  return {
    id: row.id,
    contactId: row.contact_id,
    conektaCustomerId: row.conekta_customer_id,
    conektaPaymentSourceId: row.conekta_payment_source_id,
    brand,
    last4,
    expMonth,
    expYear,
    name: cleanString(row.name),
    mode: normalizeMode(row.mode),
    isDefault: Boolean(row.is_default),
    label: `${brand.toUpperCase()} •••• ${last4 || '----'}`,
    expiresLabel
  }
}

async function upsertConektaPaymentSource({
  contactId,
  customerId,
  paymentSource,
  mode,
  makeDefault = true
}) {
  const sourceId = cleanString(paymentSource?.id)
  if (!contactId || !customerId || !sourceId) return null
  const card = getPaymentSourceCard(paymentSource)

  if (makeDefault) {
    await db.run(
      `UPDATE conekta_payment_sources
       SET is_default = 0,
           updated_at = CURRENT_TIMESTAMP
       WHERE contact_id = ? AND mode = ?`,
      [contactId, normalizeMode(mode)]
    )
  }

  const id = createId('conekta_source')
  await db.run(
    `INSERT INTO conekta_payment_sources (
      id, contact_id, conekta_customer_id, conekta_payment_source_id,
      brand, last4, exp_month, exp_year, name, mode, is_default,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(conekta_payment_source_id) DO UPDATE SET
      contact_id = excluded.contact_id,
      conekta_customer_id = excluded.conekta_customer_id,
      brand = excluded.brand,
      last4 = excluded.last4,
      exp_month = excluded.exp_month,
      exp_year = excluded.exp_year,
      name = excluded.name,
      mode = excluded.mode,
      is_default = CASE WHEN excluded.is_default = 1 THEN 1 ELSE conekta_payment_sources.is_default END,
      updated_at = CURRENT_TIMESTAMP`,
    [
      id,
      contactId,
      customerId,
      sourceId,
      cleanString(card?.brand || card?.card_brand || paymentSource?.brand),
      cleanString(card?.last4 || card?.last_4 || paymentSource?.last4),
      Number(card?.exp_month || card?.expMonth || paymentSource?.exp_month || 0),
      Number(card?.exp_year || card?.expYear || paymentSource?.exp_year || 0),
      cleanString(card?.name || paymentSource?.name),
      normalizeMode(mode),
      makeDefault ? 1 : 0
    ]
  )

  return db.get('SELECT * FROM conekta_payment_sources WHERE conekta_payment_source_id = ?', [sourceId])
}

async function findConektaSavedSourceForPayment(paymentRow, config = null) {
  const sourceId = cleanString(paymentRow?.conekta_payment_source_id)
  if (!sourceId) return null

  const mode = normalizeMode(config?.mode || paymentRow?.payment_mode || 'test')
  if (paymentRow?.contact_id) {
    const scoped = await db.get(
      `SELECT *
       FROM conekta_payment_sources
       WHERE contact_id = ?
         AND conekta_payment_source_id = ?
         AND mode = ?
       LIMIT 1`,
      [paymentRow.contact_id, sourceId, mode]
    )
    if (scoped) return scoped
  }

  return db.get('SELECT * FROM conekta_payment_sources WHERE conekta_payment_source_id = ? LIMIT 1', [sourceId])
}

async function createPaymentSource(customerId, tokenId) {
  const { payload, config } = await conektaApiRequest(`/customers/${encodeURIComponent(customerId)}/payment_sources`, {
    method: 'POST',
    body: {
      type: 'card',
      token_id: tokenId
    }
  })
  return { paymentSource: payload, config }
}

function buildOrderLineItems(row) {
  const metadata = parseJson(row.metadata_json, {})
  const sourceItems = Array.isArray(metadata.lineItems) ? metadata.lineItems : []
  const label = row.title || row.description || 'Pago Ristak'
  const description = row.description || row.title || 'Pago Ristak'

  if (sourceItems.length === 1) {
    return [{
      name: sanitizeConektaText(sourceItems[0].name || sourceItems[0].title || label, 'Pago Ristak'),
      description: sanitizeConektaText(sourceItems[0].description || description, 'Pago Ristak'),
      quantity: Number(sourceItems[0].quantity || 1) || 1,
      unit_price: toConektaAmount(row.amount)
    }]
  }

  return [{
    name: sanitizeConektaText(label, 'Pago Ristak'),
    description: sanitizeConektaText(description, 'Pago Ristak'),
    quantity: 1,
    unit_price: toConektaAmount(row.amount)
  }]
}

function buildCustomerInfo(row, customerId = '') {
  if (customerId) return { customer_id: customerId }
  const customerInfo = {
    name: sanitizeConektaName(
      cleanString(row.contact_name) || cleanString(parseJson(row.metadata_json, {}).contactName),
      'Cliente Ristak',
      120
    ),
    email: cleanString(row.contact_email) || cleanString(parseJson(row.metadata_json, {}).contactEmail),
    phone: cleanString(row.contact_phone) || cleanString(parseJson(row.metadata_json, {}).contactPhone)
  }
  Object.keys(customerInfo).forEach((key) => {
    if (!customerInfo[key]) delete customerInfo[key]
  })
  return customerInfo
}

function buildOrderPayload(row, { tokenId = '', paymentSourceId = '', customerId = '' } = {}) {
  const paymentMethod = {
    type: 'card',
    ...(paymentSourceId ? { payment_source_id: paymentSourceId } : { token_id: tokenId })
  }

  return {
    currency: normalizeCurrency(row.currency),
    customer_info: buildCustomerInfo(row, customerId),
    line_items: buildOrderLineItems(row),
    charges: [{ payment_method: paymentMethod }],
    metadata: {
      ristak_payment_id: row.id,
      public_payment_id: row.public_payment_id || '',
      contact_id: row.contact_id || '',
      source: cleanString(parseJson(row.metadata_json, {}).source || 'ristak_conekta')
    }
  }
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

async function activateConektaSubscriptionFromStartPayment(paymentRow = {}, savedSource = null) {
  const { subscriptionId, provider } = getSubscriptionStartMetadata(paymentRow)
  if (!subscriptionId || provider !== 'conekta' || !savedSource) return null

  const subscription = await db.get(
    `SELECT *
     FROM subscriptions
     WHERE id = ?
     LIMIT 1`,
    [subscriptionId]
  )

  if (!subscription || subscription.conekta_subscription_id) return null

  const paidAt = paymentRow.paid_at || new Date().toISOString()
  const baseDate = new Date(paidAt)
  const nextStart = addSubscriptionInterval(
    Number.isNaN(baseDate.getTime()) ? new Date() : baseDate,
    subscription.interval_type,
    subscription.interval_count
  ).toISOString()

  const conektaSubscription = await createConektaRecurringSubscription({
    ristakSubscriptionId: subscription.id,
    contactId: subscription.contact_id,
    name: subscription.name,
    description: subscription.description,
    amount: subscription.amount,
    currency: subscription.currency,
    intervalType: subscription.interval_type,
    intervalCount: subscription.interval_count,
    startDate: nextStart,
    paymentMethodId: savedSource.conekta_payment_source_id,
    contactName: subscription.contact_name,
    contactEmail: subscription.contact_email,
    contactPhone: subscription.contact_phone
  })

  const metadata = parseJson(subscription.metadata_json, {})
  const raw = parseJson(subscription.raw_json, {})
  await db.run(
    `UPDATE subscriptions
     SET status = ?,
         payment_method = 'conekta_subscription',
         payment_provider = 'conekta',
         payment_mode = ?,
         conekta_customer_id = ?,
         conekta_plan_id = ?,
         conekta_subscription_id = ?,
         conekta_payment_source_id = ?,
         conekta_next_billing_at = ?,
         current_period_start = ?,
         current_period_end = ?,
         next_run_at = ?,
         metadata_json = ?,
         raw_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      conektaSubscription.status || 'active',
      conektaSubscription.paymentMode || subscription.payment_mode,
      conektaSubscription.conektaCustomerId || subscription.conekta_customer_id,
      conektaSubscription.conektaPlanId || subscription.conekta_plan_id,
      conektaSubscription.conektaSubscriptionId || subscription.conekta_subscription_id,
      conektaSubscription.conektaPaymentSourceId || savedSource.conekta_payment_source_id,
      conektaSubscription.nextRunAt || nextStart,
      conektaSubscription.currentPeriodStart || subscription.current_period_start,
      conektaSubscription.currentPeriodEnd || subscription.current_period_end,
      conektaSubscription.nextRunAt || nextStart,
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
        conektaSubscriptionStart: conektaSubscription.raw || conektaSubscription
      }),
      subscription.id
    ]
  )

  return db.get('SELECT * FROM subscriptions WHERE id = ?', [subscription.id])
}

async function updatePaymentFromOrder(order, row, { paymentSourceId = '' } = {}) {
  const nextStatus = mapOrderStatus(order)
  const charge = extractCharge(order)
  const paidAt = nextStatus === 'paid' ? new Date().toISOString() : null
  const chargeId = cleanString(charge?.id)
  const orderId = cleanString(order?.id)
  const sourceId = cleanString(paymentSourceId || charge?.payment_method?.payment_source_id)

  await db.run(
    `UPDATE payments
     SET status = ?,
         payment_provider = 'conekta',
         reference = COALESCE(?, reference),
         conekta_order_id = COALESCE(?, conekta_order_id),
         conekta_charge_id = COALESCE(?, conekta_charge_id),
         conekta_payment_source_id = COALESCE(?, conekta_payment_source_id),
         paid_at = COALESCE(?, paid_at),
         date = COALESCE(?, date),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      nextStatus,
      orderId || chargeId || null,
      orderId || null,
      chargeId || null,
      sourceId || null,
      paidAt,
      paidAt,
      row.id
    ]
  )

  const updated = await findPaymentById(row.id)
  if (updated?.contact_id && nextStatus === 'paid') {
    updateSingleContactStats(updated.contact_id).catch((error) => {
      logger.warn(`No se pudieron actualizar stats del contacto por pago Conekta ${updated.id}: ${error.message}`)
    })
    registerGigstackPaymentForTransactionInBackground(updated.id)
    Promise.resolve(queuePaymentAutomationMessage('receipt', { ...updated, status: nextStatus }))
      .catch((error) => {
        logger.warn(`No se pudo encolar comprobante por pago Conekta ${updated.id}: ${error.message}`)
      })
    try {
      const savedSource = await findConektaSavedSourceForPayment(updated)
      await activateConektaSubscriptionFromStartPayment(updated, savedSource)
    } catch (error) {
      logger.warn(`No se pudo activar la suscripción Conekta desde el pago ${updated.id}: ${error.message}`)
    }
  }

  return updated
}

async function createOrderForPayment(row, options = {}) {
  const { payload, config } = await conektaApiRequest('/orders', {
    method: 'POST',
    body: buildOrderPayload(row, options),
    // (PAY2-001 / CRON-001) Propagamos la clave de idempotencia (cuando se provee)
    // hacia el POST /orders para evitar doble cobro en cobros automáticos.
    idempotencyKey: options.idempotencyKey || null
  })
  const updated = await updatePaymentFromOrder(payload, row, options)
  return { order: payload, payment: updated, config }
}

export async function createConektaPaymentLink(input = {}, { baseUrl } = {}) {
  const config = await getConektaPaymentConfig()
  if (!config.configured) {
    const error = new Error('Conekta no está configurado todavía. Guarda las llaves primero.')
    error.status = 400
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
  const publicPaymentId = createPublicId()
  const id = createId('conekta_payment')
  const currency = normalizeCurrency(input.currency || await getConfiguredCurrency())
  const now = new Date().toISOString()
  const paymentUrl = buildPaymentUrl(baseUrl, publicPaymentId)
  const contactId = cleanString(input.contactId) || null
  const conektaCustomerId = contactId
    ? await ensureConektaCustomerForContact(contactId, input)
    : null
  const metadata = {
    contactName: cleanString(input.contactName),
    contactEmail: cleanString(input.email),
    contactPhone: cleanString(input.phone),
    conektaCustomerId: conektaCustomerId || '',
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
      'conekta',
      config.mode,
      'conekta',
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

export async function getPublicConektaPayment(publicPaymentId, { baseUrl } = {}) {
  const row = await findPaymentByPublicId(publicPaymentId)
  if (!row || row.payment_provider !== 'conekta') return null
  const config = await getConektaPaymentConfig({ mode: row.payment_mode || '' })
  const paymentSettings = await getPublicPaymentSettings()
  return attachMetaPublicPurchaseEvent(
    mapPublicPayment(row, config, baseUrl, paymentSettings),
    row
  )
}

export async function createPublicConektaCardPayment(publicPaymentId, input = {}, { baseUrl } = {}) {
  const row = await findPaymentByPublicId(publicPaymentId)
  if (!row || row.payment_provider !== 'conekta') {
    const error = new Error('Pago no encontrado.')
    error.status = 404
    throw error
  }

  if (['paid', 'succeeded', 'completed', 'refunded', 'void', 'deleted'].includes(cleanString(row.status).toLowerCase())) {
    const error = new Error('Este pago ya no acepta nuevos cobros.')
    error.status = 409
    throw error
  }

  const tokenId = cleanString(input.tokenId || input.token_id || input.token)
  if (!tokenId) {
    const error = new Error('Conekta no devolvió un token de tarjeta.')
    error.status = 400
    throw error
  }

  const metadata = parseJson(row.metadata_json, {})
  const planMetadata = metadata.paymentPlan && typeof metadata.paymentPlan === 'object' ? metadata.paymentPlan : {}
  const planTrigger = cleanString(planMetadata.trigger)
  const planRequiresSavedSource = FIRST_PAYMENT_PLAN_TRIGGERS.has(planTrigger) || CARD_SETUP_PLAN_TRIGGERS.has(planTrigger)
  // En pagos normales sigue siendo opt-in. En pagos de plan, guardar la tarjeta es parte
  // de la autorización: sin payment_source guardada el plan no puede cobrarse después.
  const savePaymentSource = row.contact_id && (planRequiresSavedSource || normalizeBoolean(input.savePaymentSource, false))
  let customerId = cleanString(row.contact_conekta_customer_id || parseJson(row.metadata_json, {}).conektaCustomerId)
  let paymentSource = null
  let paymentSourceId = ''
  let savedSourceRow = null
  let config = await getConektaPaymentConfig({ includeSecrets: true, mode: row.payment_mode || '' })

  if (savePaymentSource) {
    if (!customerId) customerId = await ensureConektaCustomerForContact(row.contact_id, row)
    const sourceResult = await createPaymentSource(customerId, tokenId)
    paymentSource = sourceResult.paymentSource
    config = sourceResult.config
    paymentSourceId = cleanString(paymentSource?.id)
    savedSourceRow = await upsertConektaPaymentSource({
      contactId: row.contact_id,
      customerId,
      paymentSource,
      mode: config.mode,
      makeDefault: true
    })
  }

  const result = await createOrderForPayment(row, {
    tokenId: savePaymentSource ? '' : tokenId,
    paymentSourceId,
    customerId: savePaymentSource ? customerId : ''
  })
  const refreshed = result.payment || await findPaymentById(row.id)
  await syncConektaPlanFromPayment(refreshed, savedSourceRow, config)
  const paymentSettings = await getPublicPaymentSettings()

  return {
    payment: mapPublicPayment(refreshed, config, baseUrl, paymentSettings),
    conektaOrderId: cleanString(result.order?.id),
    conektaChargeId: cleanString(extractCharge(result.order)?.id),
    conektaPaymentSourceId: paymentSourceId,
    status: mapOrderStatus(result.order),
    savedPaymentSource: paymentSource ? mapPaymentSource(savedSourceRow || {
      ...(await db.get('SELECT * FROM conekta_payment_sources WHERE conekta_payment_source_id = ?', [paymentSourceId]) || {})
    }) : null
  }
}

export async function createPublicConektaSubscription(publicPaymentId, input = {}, { baseUrl } = {}) {
  const row = await findPaymentByPublicId(publicPaymentId)
  if (!row || row.payment_provider !== 'conekta') {
    const error = new Error('Link de suscripción no encontrado.')
    error.status = 404
    throw error
  }

  if (['paid', 'succeeded', 'completed', 'refunded', 'void', 'deleted'].includes(cleanString(row.status).toLowerCase())) {
    const error = new Error('Este link de suscripción ya no acepta nuevas autorizaciones.')
    error.status = 409
    throw error
  }

  const metadata = parseJson(row.metadata_json, {})
  const subscriptionStart = getPublicSubscriptionStart(metadata)
  if (!subscriptionStart?.subscriptionId || subscriptionStart.paymentProvider !== 'conekta') {
    const error = new Error('Este link no corresponde a una suscripción de Conekta.')
    error.status = 400
    throw error
  }

  const tokenId = cleanString(input.tokenId || input.token_id || input.token)
  if (!tokenId) {
    const error = new Error('Conekta no devolvió un token de tarjeta.')
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

  if (subscription.conekta_subscription_id) {
    const config = await getConektaPaymentConfig({ mode: row.payment_mode || '' })
    const paymentSettings = await getPublicPaymentSettings()
    return {
      payment: mapPublicPayment(row, config, baseUrl, paymentSettings),
      status: subscription.status || 'active',
      subscriptionId: subscription.id,
      alreadyActive: true
    }
  }

  const config = await getConektaPaymentConfig({ includeSecrets: true, mode: row.payment_mode || '' })
  if (!config.configured) {
    const error = new Error('Conekta no está configurado todavía. Guarda las llaves primero.')
    error.status = 400
    throw error
  }

  let customerId = cleanString(row.contact_conekta_customer_id || metadata.conektaCustomerId || subscription.conekta_customer_id)
  if (!customerId) customerId = await ensureConektaCustomerForContact(row.contact_id, row)

  const sourceResult = await createPaymentSource(customerId, tokenId)
  const paymentSource = sourceResult.paymentSource
  const paymentSourceId = cleanString(paymentSource?.id)
  const savedSourceRow = await upsertConektaPaymentSource({
    contactId: row.contact_id,
    customerId,
    paymentSource,
    mode: sourceResult.config?.mode || config.mode,
    makeDefault: true
  })

  const conektaSubscription = await createConektaRecurringSubscription({
    ristakSubscriptionId: subscription.id,
    contactId: subscription.contact_id,
    name: subscription.name,
    description: subscription.description,
    amount: subscription.amount,
    currency: subscription.currency,
    intervalType: subscription.interval_type,
    intervalCount: subscription.interval_count,
    startDate: subscription.start_date,
    paymentMethodId: paymentSourceId,
    contactName: subscription.contact_name,
    contactEmail: subscription.contact_email,
    contactPhone: subscription.contact_phone
  })

  const subscriptionMetadata = parseJson(subscription.metadata_json, {})
  const raw = parseJson(subscription.raw_json, {})
  const authorizedAt = new Date().toISOString()
  await db.run(
    `UPDATE subscriptions
     SET status = ?,
         payment_method = 'conekta_subscription',
         payment_provider = 'conekta',
         payment_mode = ?,
         conekta_customer_id = ?,
         conekta_plan_id = ?,
         conekta_subscription_id = ?,
         conekta_payment_source_id = ?,
         conekta_next_billing_at = ?,
         current_period_start = ?,
         current_period_end = ?,
         next_run_at = ?,
         metadata_json = ?,
         raw_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      conektaSubscription.status || 'active',
      conektaSubscription.paymentMode || config.mode,
      conektaSubscription.conektaCustomerId || customerId,
      conektaSubscription.conektaPlanId || subscription.conekta_plan_id,
      conektaSubscription.conektaSubscriptionId || subscription.conekta_subscription_id,
      conektaSubscription.conektaPaymentSourceId || paymentSourceId,
      conektaSubscription.nextRunAt || subscription.next_run_at,
      conektaSubscription.currentPeriodStart || subscription.current_period_start,
      conektaSubscription.currentPeriodEnd || subscription.current_period_end,
      conektaSubscription.nextRunAt || subscription.next_run_at,
      JSON.stringify({
        ...subscriptionMetadata,
        subscriptionStartPayment: {
          ...(subscriptionMetadata.subscriptionStartPayment && typeof subscriptionMetadata.subscriptionStartPayment === 'object' ? subscriptionMetadata.subscriptionStartPayment : {}),
          paymentId: row.id,
          publicPaymentId: row.public_payment_id,
          status: 'paid',
          provider: 'conekta',
          conektaPaymentSourceId: paymentSourceId,
          activatedAt: authorizedAt
        }
      }),
      JSON.stringify({
        ...raw,
        conektaSubscriptionStart: conektaSubscription.raw || conektaSubscription
      }),
      subscription.id
    ]
  )

  await db.run(
    `UPDATE payments
     SET status = 'paid',
         payment_method = 'conekta_subscription',
         payment_provider = 'conekta',
         conekta_payment_source_id = COALESCE(?, conekta_payment_source_id),
         paid_at = COALESCE(paid_at, ?),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [paymentSourceId || null, authorizedAt, row.id]
  )

  const refreshed = await findPaymentById(row.id)
  const paymentSettings = await getPublicPaymentSettings()
  return {
    payment: mapPublicPayment(refreshed, sourceResult.config || config, baseUrl, paymentSettings),
    conektaPaymentSourceId: paymentSourceId,
    conektaSubscriptionId: conektaSubscription.conektaSubscriptionId,
    status: conektaSubscription.status || 'active',
    savedPaymentSource: mapPaymentSource(savedSourceRow || {
      ...(await db.get('SELECT * FROM conekta_payment_sources WHERE conekta_payment_source_id = ?', [paymentSourceId]) || {})
    })
  }
}

export async function getConektaSavedPaymentSources(contactId) {
  const config = await getConektaPaymentConfig()
  if (!config.configured) {
    const error = new Error('Conekta no está configurado todavía.')
    error.status = 400
    throw error
  }

  const contact = await getConektaContact(contactId)
  if (!contact) {
    const error = new Error('Contacto no encontrado.')
    error.status = 404
    throw error
  }

  const rows = await db.all(
    `SELECT *
     FROM conekta_payment_sources
     WHERE contact_id = ? AND mode = ?
     ORDER BY is_default DESC, updated_at DESC`,
    [contact.id, config.mode]
  )

  return (rows || []).map(mapPaymentSource).filter(Boolean)
}

function mapSavedCardPayment(row) {
  if (!row) return null
  return {
    id: row.id,
    contactId: row.contact_id,
    amount: Number(row.amount || 0),
    currency: row.currency || DEFAULT_CURRENCY,
    status: row.status || 'pending',
    paymentMethod: row.payment_method,
    paymentProvider: row.payment_provider,
    reference: row.reference || '',
    title: row.title || 'Pago',
    description: row.description || '',
    conektaOrderId: row.conekta_order_id || null,
    conektaChargeId: row.conekta_charge_id || null,
    paidAt: row.paid_at || null
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

function getConektaSavedCardLabelFromRow(source = {}) {
  const brand = cleanString(source.brand).toUpperCase() || 'Tarjeta'
  const last4 = cleanString(source.last4) || '----'
  return `${brand} •••• ${last4}`
}

async function resolveConektaSavedSource(contactId, paymentSourceId = '', config = null) {
  const cleanContactId = cleanString(contactId)
  const cleanPaymentSourceId = cleanString(paymentSourceId)
  if (!cleanContactId) return null
  const activeConfig = config || await getConektaPaymentConfig()

  let query = `
    SELECT cps.*, c.full_name AS contact_name, c.email AS contact_email, c.phone AS contact_phone
    FROM conekta_payment_sources cps
    LEFT JOIN contacts c ON c.id = cps.contact_id
    WHERE cps.contact_id = ?
      AND cps.mode = ?`
  const params = [cleanContactId, activeConfig.mode]

  if (cleanPaymentSourceId) {
    query += ' AND (cps.id = ? OR cps.conekta_payment_source_id = ?)'
    params.push(cleanPaymentSourceId, cleanPaymentSourceId)
  }

  query += ' ORDER BY cps.is_default DESC, cps.updated_at DESC LIMIT 1'
  return db.get(query, params)
}

async function createConektaPlanPaymentRow({
  contact,
  amount,
  currency,
  status,
  paymentMethod,
  title,
  description,
  dueDate,
  metadata,
  provider = 'conekta'
}) {
  const id = createId('conekta_plan_payment')
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
      normalizeCurrency(currency),
      status,
      paymentMethod,
      metadata?.paymentMode || metadata?.conektaMode || (provider === 'conekta' ? 'test' : 'live'),
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

function normalizeConektaPaymentPlanPayload(input = {}) {
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
    source: cleanString(input.source || 'record_payment_modal_conekta_plan')
  }
}

function getConektaPlanRecurrenceLabel(frequency) {
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

function getConektaPlanMirrorStatus(flow = {}) {
  const state = cleanString(flow.current_state).toLowerCase()
  if (state === CONEKTA_PLAN_STATES.DELETED) return 'deleted'
  if (state === CONEKTA_PLAN_STATES.CANCELLED) return 'cancelled'
  if (state === CONEKTA_PLAN_STATES.PAUSED) return 'paused'
  if (state === CONEKTA_PLAN_STATES.WAITING_CARD_AUTHORIZATION) return 'pending'
  if (state === CONEKTA_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE) return 'active'
  return 'scheduled'
}

function getPlanTriggerStatusFromPaymentStatus(status) {
  const normalized = cleanString(status).toLowerCase()
  if (normalized === 'paid') return 'paid'
  if (normalized === 'failed') return 'failed'
  if (['void', 'deleted', 'cancelled', 'canceled'].includes(normalized)) return 'void'
  return 'pending'
}

function buildConektaPlanInstallmentPaymentMetadata(flow, installment, sequence, paymentMode, source = 'conekta_payment_plan_installment') {
  return {
    conektaMode: paymentMode || 'test',
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

async function persistConektaPaymentPlanMirror(flowId, extra = {}) {
  const cleanFlowId = cleanString(flowId)
  if (!cleanFlowId) return null

  const flow = await db.get('SELECT * FROM payment_flows WHERE id = ?', [cleanFlowId])
  if (!flow || flow.payment_provider !== 'conekta') return null

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
  const cardLabel = flow.conekta_payment_source_label || metadata.conektaPaymentSourceLabel || null
  const scheduleJson = {
    provider: 'conekta',
    flowId: cleanFlowId,
    remainingFrequency: metadata.remainingFrequency || 'custom',
    cardSetupRequired: Boolean(flow.card_setup_required),
    cardSetupStatus: flow.card_setup_status || null,
    cardSetupAmount: Number(flow.card_setup_amount || 0),
    cardSetupPaymentLink: flow.card_setup_payment_link || null,
    conektaPaymentSourceLabel: cardLabel,
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
    provider: 'conekta',
    paymentFlow: {
      id: cleanFlowId,
      state: flow.current_state,
      contactId: flow.contact_id,
      cardSetupAmount: Number(flow.card_setup_amount || 0),
      cardSetupPaymentLink: flow.card_setup_payment_link || null,
      conektaPaymentSourceLabel: cardLabel
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
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'conekta', CURRENT_TIMESTAMP, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
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
      source = 'conekta',
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
      getConektaPlanMirrorStatus(flow),
      Number(flow.total_amount || 0),
      flow.currency || DEFAULT_CURRENCY,
      flow.concept || 'Plan de pagos',
      getConektaPlanRecurrenceLabel(metadata.remainingFrequency),
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

export async function refreshConektaPaymentPlanMirrors() {
  const flows = await db.all(
    `SELECT id
     FROM payment_flows
     WHERE payment_provider = 'conekta'
     ORDER BY updated_at DESC`
  )

  let refreshed = 0
  for (const flow of flows || []) {
    const mirror = await persistConektaPaymentPlanMirror(flow.id)
    if (mirror) refreshed += 1
  }

  return refreshed
}

async function activateConektaPaymentPlan(flowId, savedSource, config) {
  const cleanFlowId = cleanString(flowId)
  if (!cleanFlowId || !savedSource) return null

  const flow = await db.get('SELECT * FROM payment_flows WHERE id = ?', [cleanFlowId])
  if (!flow || flow.payment_provider !== 'conekta') return null

  const stateHistory = addPlanState(flow.state_history, CONEKTA_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE)
  const now = new Date().toISOString()
  const cardLabel = getConektaSavedCardLabelFromRow(savedSource)
  const metadata = parseJson(flow.metadata, {})

  await db.run(
    `UPDATE payment_flows
     SET current_state = ?,
         conekta_customer_id = COALESCE(?, conekta_customer_id),
         conekta_payment_source_id = COALESCE(?, conekta_payment_source_id),
         conekta_payment_source_label = COALESCE(?, conekta_payment_source_label),
         card_authorized_at = COALESCE(card_authorized_at, ?),
         installment_plan_created_at = COALESCE(installment_plan_created_at, ?),
         installment_plan_active_at = COALESCE(installment_plan_active_at, ?),
         state_history = ?,
         metadata = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      CONEKTA_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE,
      savedSource.conekta_customer_id,
      savedSource.conekta_payment_source_id,
      cardLabel,
      now,
      now,
      now,
      JSON.stringify(stateHistory),
      JSON.stringify({
        ...metadata,
        conektaMode: config?.mode || metadata.conektaMode || 'test',
        conektaCustomerId: savedSource.conekta_customer_id,
        conektaPaymentSourceId: savedSource.conekta_payment_source_id,
        conektaPaymentSourceLabel: cardLabel
      }),
      cleanFlowId
    ]
  )

  await db.run(
    `UPDATE installment_payments
     SET status = 'scheduled',
         payment_method = 'conekta_saved_card',
         updated_at = CURRENT_TIMESTAMP
     WHERE flow_id = ?
       AND automatic = 1
       AND status IN ('waiting_card_authorization', 'pending_card', 'pending')`,
    [cleanFlowId]
  )

  await db.run(
    `UPDATE payments
     SET status = 'scheduled',
         conekta_payment_source_id = COALESCE(?, conekta_payment_source_id),
         updated_at = CURRENT_TIMESTAMP
     WHERE id IN (
       SELECT payment_id
       FROM installment_payments
       WHERE flow_id = ?
         AND payment_id IS NOT NULL
     )
       AND status IN ('pending', 'waiting_card_authorization')`,
    [savedSource.conekta_payment_source_id, cleanFlowId]
  )

  await persistConektaPaymentPlanMirror(cleanFlowId)

  return db.get('SELECT * FROM payment_flows WHERE id = ?', [cleanFlowId])
}

async function syncConektaPlanFromPayment(paymentRow, savedSource, config) {
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
           conekta_order_id = COALESCE(?, conekta_order_id),
           conekta_charge_id = COALESCE(?, conekta_charge_id),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        paymentRow.status === 'paid' ? 'paid' : paymentRow.status || 'pending',
        paymentRow.conekta_order_id || null,
        paymentRow.conekta_charge_id || null,
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

  let planSavedSource = savedSource
  if (!planSavedSource && paymentRow.status === 'paid' && (isFirstPlanPayment || isCardSetupPayment)) {
    planSavedSource = await findConektaSavedSourceForPayment(paymentRow, config)
  }

  if (paymentRow.status === 'paid' && planSavedSource && (isFirstPlanPayment || isCardSetupPayment)) {
    return activateConektaPaymentPlan(flowId, planSavedSource, config)
  }

  return persistConektaPaymentPlanMirror(flowId)
}

async function chargeConektaPaymentRowWithSavedSource({
  paymentId,
  savedSource,
  source = 'conekta_payment_plan',
  extraMetadata = {}
}) {
  const row = await findPaymentById(paymentId)
  if (!row) {
    const error = new Error('No encontramos el pago programado.')
    error.status = 404
    throw error
  }

  if (row.status === 'paid') return row

  const metadata = parseJson(row.metadata_json, {})
  const nextMetadata = {
    ...metadata,
    source,
    conektaCustomerId: savedSource.conekta_customer_id,
    conektaPaymentSourceId: savedSource.conekta_payment_source_id,
    ...extraMetadata
  }

  await db.run(
    `UPDATE payments
     SET status = 'processing',
         metadata_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [JSON.stringify(nextMetadata), row.id]
  )

  try {
    const latest = await findPaymentById(row.id)
    // (PAY2-001 / CRON-001) Clave de idempotencia estable derivada de la identidad de
    // la parcialidad/primer pago (installment_id cuando existe, si no el payment id).
    // Garantiza que reintentos o ejecuciones solapadas del cron NO cobren dos veces.
    const idempotencySeed = cleanString(extraMetadata?.ristak_installment_id) || row.id
    const result = await createOrderForPayment(latest, {
      paymentSourceId: savedSource.conekta_payment_source_id,
      customerId: savedSource.conekta_customer_id,
      idempotencyKey: `ristak_conekta_charge_${idempotencySeed}`
    })
    await syncConektaPlanFromPayment(result.payment, savedSource, result.config)
    return result.payment || await findPaymentById(row.id)
  } catch (error) {
    await db.run(
      `UPDATE payments
       SET status = 'failed',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [row.id]
    )

    const planMetadata = metadata.paymentPlan && typeof metadata.paymentPlan === 'object' ? metadata.paymentPlan : {}
    if (planMetadata.installmentId) {
      await db.run(
        `UPDATE installment_payments
         SET status = 'failed',
             notes = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [error?.message || 'Conekta no pudo procesar el cobro programado.', planMetadata.installmentId]
      )
    }

    throw error
  }
}

export async function createConektaPaymentPlan(input = {}, { baseUrl } = {}) {
  const config = await getConektaPaymentConfig({ includeSecrets: true })
  if (!config.configured) {
    const error = new Error('Conekta no está configurado todavía. Guarda las llaves primero.')
    error.status = 400
    throw error
  }

  const accountCurrency = await getConfiguredCurrency()
  const plan = normalizeConektaPaymentPlanPayload({ ...input, currency: accountCurrency })
  const savedSource = plan.paymentMethodId
    ? await resolveConektaSavedSource(plan.contact.id, plan.paymentMethodId, config)
    : null
  const hasSavedCard = Boolean(savedSource)
  const firstPaymentIsCard = plan.firstPayment.enabled && CARD_PLAN_PAYMENT_METHODS.has(cleanString(plan.firstPayment.method).toLowerCase())
  const firstPaymentIsOffline = plan.firstPayment.enabled && MANUAL_PLAN_PAYMENT_METHODS.has(cleanString(plan.firstPayment.method).toLowerCase())
  const needsSeparateCardSetup = !hasSavedCard && !firstPaymentIsCard
  const cardSetupAmount = needsSeparateCardSetup ? plan.cardSetupAmount : (firstPaymentIsCard ? plan.firstPayment.amount : 0)

  const flowId = createId('conekta_flow')
  const flowState = hasSavedCard
    ? CONEKTA_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE
    : CONEKTA_PLAN_STATES.WAITING_CARD_AUTHORIZATION
  const stateHistory = addPlanState([], flowState)
  const now = new Date().toISOString()
  const cardLabel = hasSavedCard ? getConektaSavedCardLabelFromRow(savedSource) : ''

  await db.run(
    `INSERT INTO payment_flows (
      id, contact_id, contact_name, contact_email, contact_phone,
      total_amount, currency, concept, payment_type,
      first_payment_amount, first_payment_type, first_payment_value,
      first_payment_date, first_payment_method, first_payment_status,
      remaining_automatic, card_setup_required, card_setup_amount,
      payment_provider, conekta_customer_id, conekta_payment_source_id, conekta_payment_source_label,
      current_state, state_history, card_authorized_at,
      installment_plan_created_at, installment_plan_active_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'partial', ?, ?, ?, ?, ?, ?, 1, ?, ?, 'conekta', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      savedSource?.conekta_customer_id || null,
      savedSource?.conekta_payment_source_id || null,
      cardLabel || null,
      flowState,
      JSON.stringify(stateHistory),
      hasSavedCard ? now : null,
      hasSavedCard ? now : null,
      hasSavedCard ? now : null,
      JSON.stringify({
        source: plan.source,
        conektaMode: config.mode,
        remainingFrequency: plan.remainingFrequency,
        lineItems: plan.lineItems,
        firstPaymentLinkRequired: !hasSavedCard && firstPaymentIsCard,
        cardSetupLinkRequired: needsSeparateCardSetup,
        conektaCustomerId: savedSource?.conekta_customer_id || '',
        conektaPaymentSourceId: savedSource?.conekta_payment_source_id || '',
        conektaPaymentSourceLabel: cardLabel || ''
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
    savedPaymentSource: hasSavedCard ? mapPaymentSource(savedSource) : null,
    scheduledPayments: []
  }

  if (plan.firstPayment.enabled && firstPaymentIsOffline) {
    const paymentId = await createConektaPlanPaymentRow({
      contact: plan.contact,
      amount: plan.firstPayment.amount,
      currency: plan.currency,
      status: 'paid',
      paymentMethod: plan.firstPayment.method === 'transfer' ? 'bank_transfer' : plan.firstPayment.method,
      provider: 'manual',
      title: `${plan.title} - primer pago`,
      description: `${plan.description} - primer pago`,
      dueDate: plan.firstPayment.date,
      metadata: {
        paymentMode: config.mode,
        source: 'conekta_payment_plan_first_offline',
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
    const paymentId = await createConektaPlanPaymentRow({
      contact: plan.contact,
      amount: plan.firstPayment.amount,
      currency: plan.currency,
      status: isDueTodayOrPast(plan.firstPayment.date) ? 'pending' : 'scheduled',
      paymentMethod: 'conekta_saved_card',
      title: `${plan.title} - primer pago`,
      description: `${plan.description} - primer pago`,
      dueDate: plan.firstPayment.date,
      metadata: {
        conektaMode: config.mode,
        source: 'conekta_payment_plan_first_saved_card',
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
      await chargeConektaPaymentRowWithSavedSource({
        paymentId,
        savedSource,
        source: 'conekta_payment_plan_first_saved_card',
        extraMetadata: { ristak_flow_id: flowId, ristak_plan_trigger: 'first_payment_saved_card' }
      })
    }
  }

  if (plan.firstPayment.enabled && firstPaymentIsCard && !hasSavedCard) {
    const firstPaymentLink = await createConektaPaymentLink({
      contactId: plan.contact.id,
      contactName: plan.contact.name,
      email: plan.contact.email,
      phone: plan.contact.phone,
      amount: plan.firstPayment.amount,
      currency: plan.currency,
      title: `${plan.title} - primer pago`,
      description: `${plan.description} - primer pago`,
      dueDate: plan.firstPayment.date,
      source: 'conekta_payment_plan_first_link',
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
    const setupLink = await createConektaPaymentLink({
      contactId: plan.contact.id,
      contactName: plan.contact.name,
      email: plan.contact.email,
      phone: plan.contact.phone,
      amount: plan.cardSetupAmount,
      currency: plan.currency,
      title: `${plan.title} - domiciliación de tarjeta`,
      description: `Domiciliación de tarjeta para ${plan.description}`,
      dueDate: todayDateOnly(),
      source: 'conekta_payment_plan_card_setup',
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
    const installmentId = createId('conekta_installment')
    const status = hasSavedCard ? 'scheduled' : 'waiting_card_authorization'
    const paymentId = await createConektaPlanPaymentRow({
      contact: plan.contact,
      amount: payment.amount,
      currency: plan.currency,
      status: hasSavedCard ? 'scheduled' : 'pending',
      paymentMethod: 'conekta_scheduled_card',
      title: `${plan.title} - pago ${payment.sequence}`,
      description: `${plan.description} - pago ${payment.sequence}`,
      dueDate: payment.dueDate,
      metadata: {
        conektaMode: config.mode,
        source: 'conekta_payment_plan_installment',
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
        hasSavedCard ? 'conekta_saved_card' : 'conekta_pending_card',
        status,
        paymentId,
        hasSavedCard ? `Programado para cobrarse con ${cardLabel}` : 'Esperando domiciliación de tarjeta en Conekta.'
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

  await persistConektaPaymentPlanMirror(flowId, { response })

  return response
}

export async function processDueConektaPaymentPlanCharges({ limit = 25 } = {}) {
  const config = await getConektaPaymentConfig({ includeSecrets: true })
  if (!config.configured) {
    const error = new Error('Conekta no está configurado todavía. Guarda las llaves primero.')
    error.status = 400
    throw error
  }

  const dueDate = todayDateOnly()
  const dueTimestamp = new Date().toISOString()
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 25, 100))
  const firstPaymentDueDateSql = dateOnlySql('COALESCE(f.first_payment_date, p.due_date, p.date)')
  const installmentDueSql = duePlanInstallmentCondition('i')
  const dueDatePlaceholder = dateOnlyPlaceholder()
  const staleFirstPaymentSql = staleProcessingSql('f.updated_at')
  const staleInstallmentSql = staleProcessingSql('i.updated_at')
  const staleFirstPaymentClaimSql = staleProcessingSql('updated_at')
  const staleInstallmentClaimSql = staleProcessingSql('updated_at')
  const firstPaymentRows = await db.all(
    `SELECT
       f.id AS flow_id,
       f.contact_id,
       f.first_payment_invoice_id AS payment_id,
       f.conekta_payment_source_id,
       p.status AS payment_status
     FROM payment_flows f
     JOIN payments p ON p.id = f.first_payment_invoice_id
     WHERE f.payment_provider = 'conekta'
       AND f.current_state = ?
       AND f.first_payment_invoice_id IS NOT NULL
       AND (
         f.first_payment_status IN ('pending', 'scheduled')
         OR (f.first_payment_status = 'processing' AND ${staleFirstPaymentSql})
       )
       AND f.first_payment_method IN ('card', 'payment_link', 'direct_card', 'saved_card', 'conekta', 'conekta_saved_card')
       AND f.conekta_payment_source_id IS NOT NULL
       AND ${firstPaymentDueDateSql} <= ${dueDatePlaceholder}
       AND p.status IN ('pending', 'scheduled', 'processing')
     ORDER BY COALESCE(f.first_payment_date, p.due_date, p.date) ASC
     LIMIT ?`,
    [CONEKTA_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE, dueDate, normalizedLimit]
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
       f.conekta_payment_source_id,
       f.conekta_customer_id,
       p.status AS payment_status
     FROM installment_payments i
     JOIN payment_flows f ON f.id = i.flow_id
     LEFT JOIN payments p ON p.id = i.payment_id
     WHERE f.payment_provider = 'conekta'
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
    [CONEKTA_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE, dueTimestamp, dueDate, normalizedLimit]
  )

  const results = []
  const touchedFlowIds = new Set()
  for (const row of firstPaymentRows || []) {
    touchedFlowIds.add(row.flow_id)
    try {
      // (PAY2-001 / CRON-001) Claim atómico ANTES de cobrar el primer pago programado:
      // solo cobramos si ganamos la transición a 'processing'. Replica el filtro del
      // SELECT (pending/scheduled, o processing-pero-stale) dentro del UPDATE para
      // evitar el doble cobro ante ejecuciones concurrentes (solape de deploy/trigger).
      const claim = await db.run(
        `UPDATE payment_flows
         SET first_payment_status = 'processing',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND (first_payment_status IN ('pending', 'scheduled') OR (first_payment_status = 'processing' AND ${staleFirstPaymentClaimSql}))`,
        [row.flow_id]
      )
      if (!(Number(claim?.changes || 0) > 0)) {
        // Otra ejecución ya reclamó este primer pago; lo saltamos sin cobrar.
        continue
      }

      const savedSource = await resolveConektaSavedSource(row.contact_id, row.conekta_payment_source_id, config)
      if (!savedSource) {
        throw new Error('No encontramos la tarjeta guardada para el primer pago programado.')
      }

      const charged = await chargeConektaPaymentRowWithSavedSource({
        paymentId: row.payment_id,
        savedSource,
        source: 'conekta_payment_plan_first_scheduled_charge',
        extraMetadata: {
          ristak_flow_id: row.flow_id,
          ristak_plan_trigger: 'first_payment_saved_card'
        }
      })

      await db.run(
        `UPDATE payment_flows
         SET first_payment_status = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [charged?.status === 'paid' ? 'paid' : charged?.status || 'pending', row.flow_id]
      )

      results.push({ type: 'first_payment', flowId: row.flow_id, paymentId: row.payment_id, status: charged?.status || 'pending' })
    } catch (error) {
      await db.run(
        `UPDATE payment_flows
         SET first_payment_status = 'failed',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [row.flow_id]
      )
      results.push({ type: 'first_payment', flowId: row.flow_id, paymentId: row.payment_id, status: 'failed', error: error.message })
    }
  }

  for (const row of rows || []) {
    touchedFlowIds.add(row.flow_id)
    try {
      // (PAY2-001 / CRON-001) Claim atómico ANTES de cobrar: solo procesamos esta
      // parcialidad si ganamos la transición a 'processing'. Replica el filtro del
      // SELECT (scheduled, o processing-pero-stale) dentro del UPDATE para que dos
      // ejecuciones concurrentes no cobren la misma parcialidad dos veces.
      const claim = await db.run(
        `UPDATE installment_payments
         SET status = 'processing',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND (status = 'scheduled' OR (status = 'processing' AND ${staleInstallmentClaimSql}))`,
        [row.installment_id]
      )
      if (!(Number(claim?.changes || 0) > 0)) {
        // Otra ejecución ya reclamó esta parcialidad; la saltamos sin cobrar.
        continue
      }

      const savedSource = await resolveConektaSavedSource(row.contact_id, row.conekta_payment_source_id, config)
      if (!savedSource) {
        throw new Error('No encontramos la tarjeta guardada para esta parcialidad.')
      }

      const charged = await chargeConektaPaymentRowWithSavedSource({
        paymentId: row.payment_id,
        savedSource,
        source: 'conekta_payment_plan_installment',
        extraMetadata: {
          ristak_flow_id: row.flow_id,
          ristak_installment_id: row.installment_id
        }
      })

      await db.run(
        `UPDATE installment_payments
         SET status = ?,
             conekta_order_id = COALESCE(?, conekta_order_id),
             conekta_charge_id = COALESCE(?, conekta_charge_id),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          charged?.status === 'paid' ? 'paid' : charged?.status || 'pending',
          charged?.conekta_order_id || null,
          charged?.conekta_charge_id || null,
          row.installment_id
        ]
      )

      results.push({ type: 'installment', flowId: row.flow_id, installmentId: row.installment_id, paymentId: row.payment_id, status: charged?.status || 'pending' })
    } catch (error) {
      await db.run(
        `UPDATE installment_payments
         SET status = 'failed',
             notes = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [error.message || 'Conekta no pudo completar el cobro.', row.installment_id]
      )
      results.push({ type: 'installment', flowId: row.flow_id, installmentId: row.installment_id, paymentId: row.payment_id, status: 'failed', error: error.message })
    }
  }

  for (const flowId of touchedFlowIds) {
    await persistConektaPaymentPlanMirror(flowId)
  }

  return {
    processed: results.length,
    succeeded: results.filter((result) => ['paid', 'succeeded'].includes(result.status)).length,
    failed: results.filter((result) => result.status === 'failed').length,
    results
  }
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
      installmentMethod: hasSavedCard ? 'conekta_saved_card' : 'conekta_pending_card',
      paymentMethod: 'conekta_scheduled_card'
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
      paymentMethod: hasSavedCard ? 'conekta_saved_card' : 'conekta_pending_card',
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
  if (flowState === CONEKTA_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE && flowHasSavedCard) return 'scheduled'
  return 'waiting_card_authorization'
}

async function createConektaPaymentPlanCardSetupLink(flow, { baseUrl } = {}) {
  if (!flow || flow.payment_provider !== 'conekta') {
    const error = new Error('Plan Conekta no encontrado.')
    error.status = 404
    throw error
  }

  const currentState = cleanString(flow.current_state).toLowerCase()
  if ([CONEKTA_PLAN_STATES.CANCELLED, CONEKTA_PLAN_STATES.DELETED].includes(currentState)) {
    const error = new Error('No se puede cambiar la tarjeta de un plan cancelado o eliminado.')
    error.status = 409
    throw error
  }

  const now = new Date().toISOString()
  const metadata = parseJson(flow.metadata, {})
  const concept = cleanString(flow.concept) || 'Plan de pagos'
  const currency = normalizeCurrency(flow.currency || DEFAULT_CURRENCY)
  const cardSetupAmount = normalizePositiveAmount(flow.card_setup_amount || metadata.cardSetupAmount, 25)
  const setupLink = await createConektaPaymentLink({
    contactId: flow.contact_id,
    contactName: flow.contact_name,
    email: flow.contact_email,
    phone: flow.contact_phone,
    amount: cardSetupAmount,
    currency,
    title: `${concept} - cambiar tarjeta domiciliada`,
    description: `Domiciliación de nueva tarjeta para ${concept}`,
    dueDate: todayDateOnly(),
    source: 'conekta_payment_plan_card_update',
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

  const hasSavedCard = Boolean(cleanString(flow.conekta_payment_source_id))
  const nextState = hasSavedCard
    ? cleanString(flow.current_state) || CONEKTA_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE
    : CONEKTA_PLAN_STATES.WAITING_CARD_AUTHORIZATION
  const nextStateHistory = hasSavedCard
    ? parseJson(flow.state_history, [])
    : addPlanState(flow.state_history, CONEKTA_PLAN_STATES.WAITING_CARD_AUTHORIZATION)

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

export async function updateConektaPaymentPlanSchedule(flowId, input = {}) {
  const cleanFlowId = cleanString(flowId)
  if (!cleanFlowId) {
    const error = new Error('Plan Conekta requerido.')
    error.status = 400
    throw error
  }

  const flow = await db.get('SELECT * FROM payment_flows WHERE id = ?', [cleanFlowId])
  if (!flow || flow.payment_provider !== 'conekta') {
    const error = new Error('Plan Conekta no encontrado.')
    error.status = 404
    throw error
  }

  const metadata = parseJson(flow.metadata, {})
  const hasSavedCard = Boolean(cleanString(flow.conekta_payment_source_id))
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
    const installmentId = existing?.id || createId('conekta_installment')
    const paymentId = existing?.payment_id || createId('conekta_plan_payment')
    const paymentMode = existing?.payment_mode || metadata.conektaMode || metadata.paymentMode || 'test'
    const title = `${nextConcept} - pago ${nextSequence}`
    const notes = method.automatic
      ? hasSavedCard
        ? `Programado para cobrarse con ${flow.conekta_payment_source_label || 'tarjeta guardada'}`
        : 'Esperando domiciliación de tarjeta en Conekta.'
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
        payment_provider, title, description, date, due_date, conekta_payment_source_id, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'conekta', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
        payment_provider = 'conekta',
        title = excluded.title,
        description = excluded.description,
        date = excluded.date,
        due_date = excluded.due_date,
        conekta_payment_source_id = excluded.conekta_payment_source_id,
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
        hasSavedCard ? flow.conekta_payment_source_id : null,
        JSON.stringify(buildConektaPlanInstallmentPaymentMetadata(flow, { id: installmentId }, nextSequence, paymentMode))
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
      const firstPaymentMethodInput = cleanString(firstPayment.method || firstPayment.paymentMethod || firstPaymentMethod || 'conekta_auto').toLowerCase()
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
        firstPaymentPaymentId = await createConektaPlanPaymentRow({
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
            conektaMode: metadata.conektaMode || metadata.paymentMode || 'test',
            source: hasSavedCard ? 'conekta_payment_plan_first_saved_card' : 'conekta_payment_plan_first_link',
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

  return persistConektaPaymentPlanMirror(cleanFlowId, {
    localAction: 'update_schedule',
    actionedAt: new Date().toISOString()
  })
}

export async function applyConektaPaymentPlanAction(flowId, action, options = {}) {
  const cleanFlowId = cleanString(flowId)
  const normalizedAction = cleanString(action).toLowerCase()
  if (!cleanFlowId) {
    const error = new Error('Plan Conekta requerido.')
    error.status = 400
    throw error
  }

  const flow = await db.get('SELECT * FROM payment_flows WHERE id = ?', [cleanFlowId])
  if (!flow || flow.payment_provider !== 'conekta') {
    const error = new Error('Plan Conekta no encontrado.')
    error.status = 404
    throw error
  }

  const now = new Date().toISOString()
  const stateHistory = (nextState) => addPlanState(flow.state_history, nextState)

  if (['change_card', 'change-card', 'change_payment_method', 'replace_card'].includes(normalizedAction)) {
    const cardSetup = await createConektaPaymentPlanCardSetupLink(flow, options)
    return persistConektaPaymentPlanMirror(cleanFlowId, {
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
    const hasSavedCard = Boolean(cleanString(flow.conekta_payment_source_id))
    const nextState = hasSavedCard
      ? CONEKTA_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE
      : CONEKTA_PLAN_STATES.WAITING_CARD_AUTHORIZATION

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
        CONEKTA_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE,
        now,
        nextState,
        CONEKTA_PLAN_STATES.INSTALLMENT_PLAN_ACTIVE,
        now,
        JSON.stringify(stateHistory(nextState)),
        cleanFlowId
      ]
    )

    if (hasSavedCard) {
      await db.run(
        `UPDATE installment_payments
         SET status = 'scheduled',
             payment_method = 'conekta_saved_card',
             updated_at = CURRENT_TIMESTAMP
         WHERE flow_id = ?
           AND automatic = 1
           AND status IN ('waiting_card_authorization', 'pending_card', 'pending')`,
        [cleanFlowId]
      )
    }

    return persistConektaPaymentPlanMirror(cleanFlowId, { localAction: normalizedAction, actionedAt: now })
  }

  if (normalizedAction === 'pause') {
    await db.run(
      `UPDATE payment_flows
       SET current_state = ?,
           state_history = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        CONEKTA_PLAN_STATES.PAUSED,
        JSON.stringify(stateHistory(CONEKTA_PLAN_STATES.PAUSED)),
        cleanFlowId
      ]
    )

    return persistConektaPaymentPlanMirror(cleanFlowId, { localAction: normalizedAction, actionedAt: now })
  }

  if (!['cancel', 'delete'].includes(normalizedAction)) {
    const error = new Error('Acción inválida para plan Conekta.')
    error.status = 400
    throw error
  }

  if (normalizedAction === 'delete') {
    const audit = await getPaymentPlanAuditSummary(cleanFlowId)
    if (audit.isTestMode || (audit.isDeletedRecord && !audit.hasLedgerActivity)) {
      await hardDeleteTestPaymentPlan(cleanFlowId)
      return {
        id: cleanFlowId,
        status: CONEKTA_PLAN_STATES.DELETED,
        source: 'conekta',
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
    ? CONEKTA_PLAN_STATES.DELETED
    : CONEKTA_PLAN_STATES.CANCELLED
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

  const mirrored = await persistConektaPaymentPlanMirror(cleanFlowId, {
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

function mapConektaSubscriptionStatus(status) {
  const normalized = cleanString(status).toLowerCase()
  if (['active', 'in_trial', 'trialing'].includes(normalized)) return 'active'
  if (['paused'].includes(normalized)) return 'paused'
  if (['past_due', 'payment_pending'].includes(normalized)) return 'past_due'
  if (['canceled', 'cancelled'].includes(normalized)) return 'cancelled'
  if (['pending', 'incomplete'].includes(normalized)) return 'incomplete'
  return normalized || 'active'
}

function toIsoFromConektaTimestamp(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  if (Number.isFinite(number) && number > 0) {
    const milliseconds = number > 9999999999 ? number : number * 1000
    const date = new Date(milliseconds)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function mapConektaInterval(intervalType) {
  const normalized = cleanString(intervalType || 'monthly').toLowerCase()
  if (normalized === 'weekly') return 'week'
  if (normalized === 'monthly') return 'month'
  if (normalized === 'yearly') return 'year'

  const error = new Error('Conekta soporta suscripciones semanales, mensuales o anuales. Para cobros diarios usa un plan de pagos.')
  error.status = 400
  throw error
}

function buildConektaPlanId(ristakSubscriptionId) {
  const base = cleanString(ristakSubscriptionId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 42) || 'ristak_subscription'
  return `${base}_${Date.now()}`
}

function mapConektaRecurringSubscriptionResponse({
  config,
  savedSource,
  plan,
  subscription
}) {
  const nextRunAt = toIsoFromConektaTimestamp(
    subscription?.next_billing_at
    || subscription?.billing_cycle_end
    || subscription?.current_period_end
    || subscription?.trial_end
  )
  const currentPeriodStart = toIsoFromConektaTimestamp(
    subscription?.billing_cycle_start
    || subscription?.current_period_start
    || subscription?.created_at
  )
  const currentPeriodEnd = toIsoFromConektaTimestamp(
    subscription?.billing_cycle_end
    || subscription?.current_period_end
    || subscription?.charged_through
  )

  return {
    conektaCustomerId: savedSource?.conekta_customer_id || '',
    conektaPlanId: cleanString(plan?.id),
    conektaSubscriptionId: cleanString(subscription?.id),
    conektaPaymentSourceId: savedSource?.conekta_payment_source_id || '',
    paymentMode: config?.mode || 'test',
    status: mapConektaSubscriptionStatus(subscription?.status),
    nextRunAt,
    currentPeriodStart,
    currentPeriodEnd,
    raw: {
      plan,
      subscription
    }
  }
}

async function createConektaPlanForSubscription(input = {}, config) {
  const name = sanitizeConektaText(input.name, 'Suscripcion', 120)
  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error('El monto de la suscripción debe ser mayor a 0.')
    error.status = 400
    throw error
  }

  const body = {
    id: buildConektaPlanId(input.ristakSubscriptionId),
    name,
    amount: toConektaAmount(amount),
    currency: normalizeCurrency(input.currency || await getConfiguredCurrency()),
    frequency: Math.max(1, Number.parseInt(input.intervalCount, 10) || 1),
    interval: mapConektaInterval(input.intervalType),
    max_retries: 3,
    retry_delay_hours: 48
  }

  const { payload } = await conektaApiRequest('/plans', {
    method: 'POST',
    body,
    config
  })

  return payload
}

export async function createConektaSubscriptionCheckoutLink(input = {}, { baseUrl = '' } = {}) {
  const config = await getConektaPaymentConfig({ includeSecrets: true })
  if (!config.configured) {
    const error = new Error('Conekta no está configurado todavía. Guarda las llaves primero.')
    error.status = 400
    throw error
  }

  const contactId = cleanString(input.contactId)
  const contactEmail = cleanString(input.contactEmail || input.email)
  const contactPhone = cleanString(input.contactPhone || input.phone)
  const contactName = sanitizeConektaName(input.contactName, 'Cliente Ristak')
  const name = sanitizeConektaText(input.name, 'Suscripcion', 120)
  const amount = Number(input.amount)
  const currency = normalizeCurrency(input.currency || await getConfiguredCurrency())
  const ristakSubscriptionId = cleanString(input.ristakSubscriptionId || input.subscriptionId)
  const subscriptionStartPaymentId = cleanString(input.subscriptionStartPaymentId || input.ristakPaymentId || input.paymentId)
  const subscriptionStartPublicPaymentId = cleanString(input.subscriptionStartPublicPaymentId || input.publicPaymentId)

  if (!contactId) {
    const error = new Error('Selecciona un contacto para crear el link de suscripción de Conekta.')
    error.status = 400
    throw error
  }

  if (!contactEmail) {
    const error = new Error('Conekta necesita el email del contacto para crear el link de suscripción.')
    error.status = 422
    throw error
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error('El monto de la suscripción debe ser mayor a 0.')
    error.status = 400
    throw error
  }

  const plan = await createConektaPlanForSubscription(input, config)
  const conektaPlanId = cleanString(plan?.id)
  if (!conektaPlanId) {
    const error = new Error('Conekta no devolvió el plan de la suscripción.')
    error.status = 502
    throw error
  }

  const metadata = {
    ristakSubscriptionId,
    ristak_subscription_id: ristakSubscriptionId,
    ristakPaymentId: subscriptionStartPaymentId,
    ristak_payment_id: subscriptionStartPaymentId,
    publicPaymentId: subscriptionStartPublicPaymentId,
    public_payment_id: subscriptionStartPublicPaymentId,
    contactId,
    source: 'ristak_conekta_subscription_checkout'
  }

  const orderTemplate = {
    line_items: [
      {
        name,
        description: sanitizeConektaText(input.description || name, name, 250),
        unit_price: toConektaAmount(amount),
        quantity: 1
      }
    ],
    currency,
    customer_info: {
      name: contactName,
      email: contactEmail,
      ...(contactPhone ? { phone: contactPhone } : {})
    },
    metadata
  }

  const body = {
    name,
    type: 'PaymentLink',
    recurrent: false,
    expires_at: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    allowed_payment_methods: ['card'],
    plan_ids: [conektaPlanId],
    needs_shipping_contact: false,
    success_url: buildConektaSubscriptionReturnUrl(baseUrl, 'success', subscriptionStartPublicPaymentId),
    failure_url: buildConektaSubscriptionReturnUrl(baseUrl, 'cancelled', subscriptionStartPublicPaymentId),
    order_template: orderTemplate,
    metadata
  }

  const { payload: checkout } = await conektaApiRequest('/checkouts', {
    method: 'POST',
    body,
    config
  })
  const checkoutUrl = cleanString(checkout?.url)
  if (!checkoutUrl) {
    const error = new Error('Conekta no devolvió el enlace hospedado de la suscripción.')
    error.status = 502
    error.payload = checkout
    throw error
  }

  return {
    conektaPlanId,
    conektaCheckoutId: cleanString(checkout?.id),
    conektaCheckoutUrl: checkoutUrl,
    paymentMode: config.mode,
    status: 'incomplete',
    raw: {
      plan,
      checkout
    }
  }
}

export async function createConektaRecurringSubscription(input = {}) {
  const config = await getConektaPaymentConfig({ includeSecrets: true })
  if (!config.configured) {
    const error = new Error('Conekta no está configurado todavía. Guarda las llaves primero.')
    error.status = 400
    throw error
  }

  const contactId = cleanString(input.contactId)
  if (!contactId) {
    const error = new Error('Selecciona un contacto para crear una suscripción automática en Conekta.')
    error.status = 400
    throw error
  }

  const savedSource = await resolveConektaSavedSource(contactId, input.paymentMethodId || input.conektaPaymentSourceId, config)
  if (!savedSource) {
    const error = new Error('Este contacto no tiene una tarjeta guardada de Conekta para activar la suscripción automática.')
    error.status = 422
    throw error
  }

  const plan = await createConektaPlanForSubscription(input, config)
  const startDate = cleanString(input.startDate)
  const startTimestamp = startDate ? Math.floor(new Date(startDate).getTime() / 1000) : 0
  const nowTimestamp = Math.floor(Date.now() / 1000)
  const subscriptionBody = {
    plan_id: cleanString(plan?.id),
    card_id: savedSource.conekta_payment_source_id
  }

  if (Number.isFinite(startTimestamp) && startTimestamp > nowTimestamp + 300) {
    subscriptionBody.trial_end = startTimestamp
  }

  const { payload: subscription } = await conektaApiRequest(
    `/customers/${encodeURIComponent(savedSource.conekta_customer_id)}/subscriptions`,
    {
      method: 'POST',
      body: subscriptionBody,
      config
    }
  )

  return mapConektaRecurringSubscriptionResponse({
    config,
    savedSource,
    plan,
    subscription
  })
}

export async function updateConektaRecurringSubscription(input = {}) {
  const config = await getConektaPaymentConfig({ includeSecrets: true })
  const conektaCustomerId = cleanString(input.conektaCustomerId)
  const conektaSubscriptionId = cleanString(input.conektaSubscriptionId)
  const conektaPaymentSourceId = cleanString(input.conektaPaymentSourceId)
  if (!conektaCustomerId || !conektaSubscriptionId) {
    const error = new Error('No se encontró la suscripción de Conekta.')
    error.status = 400
    throw error
  }

  const savedSource = await resolveConektaSavedSource(input.contactId, conektaPaymentSourceId, config)
  const plan = await createConektaPlanForSubscription(input, config)
  const body = {
    plan_id: cleanString(plan?.id),
    ...(conektaPaymentSourceId ? { card_id: conektaPaymentSourceId } : {})
  }

  const { payload: subscription } = await conektaApiRequest(
    `/customers/${encodeURIComponent(conektaCustomerId)}/subscriptions/${encodeURIComponent(conektaSubscriptionId)}`,
    {
      method: 'PUT',
      body,
      config
    }
  )

  return mapConektaRecurringSubscriptionResponse({
    config,
    savedSource: savedSource || {
      conekta_customer_id: conektaCustomerId,
      conekta_payment_source_id: conektaPaymentSourceId
    },
    plan,
    subscription
  })
}

async function callConektaSubscriptionAction(customerId, subscriptionId, action) {
  const cleanCustomerId = cleanString(customerId)
  const cleanSubscriptionId = cleanString(subscriptionId)
  if (!cleanCustomerId || !cleanSubscriptionId) {
    const error = new Error('No se encontró la suscripción de Conekta.')
    error.status = 400
    throw error
  }

  const { payload, config } = await conektaApiRequest(
    `/customers/${encodeURIComponent(cleanCustomerId)}/subscriptions/${encodeURIComponent(cleanSubscriptionId)}/${action}`,
    { method: 'POST' }
  )

  return { payload, config }
}

export async function pauseConektaRecurringSubscription(customerId, subscriptionId) {
  return callConektaSubscriptionAction(customerId, subscriptionId, 'pause')
}

export async function resumeConektaRecurringSubscription(customerId, subscriptionId) {
  return callConektaSubscriptionAction(customerId, subscriptionId, 'resume')
}

export async function cancelConektaRecurringSubscription(customerId, subscriptionId) {
  return callConektaSubscriptionAction(customerId, subscriptionId, 'cancel')
}

export async function createConektaSavedCardPayment(input = {}) {
  const config = await getConektaPaymentConfig({ includeSecrets: true })
  if (!config.configured) {
    const error = new Error('Conekta no está configurado todavía. Guarda las llaves primero.')
    error.status = 400
    throw error
  }

  const contactId = cleanString(input.contactId)
  const selectedSourceId = cleanString(input.paymentSourceId || input.conektaPaymentSourceId)
  const amount = Number(input.amount)

  if (!contactId) {
    const error = new Error('Selecciona un contacto.')
    error.status = 400
    throw error
  }

  if (!selectedSourceId) {
    const error = new Error('Selecciona una tarjeta guardada.')
    error.status = 400
    throw error
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error('El monto debe ser mayor a 0.')
    error.status = 400
    throw error
  }

  const savedSource = await db.get(
    `SELECT cps.*, c.full_name AS contact_name, c.email AS contact_email, c.phone AS contact_phone
     FROM conekta_payment_sources cps
     LEFT JOIN contacts c ON c.id = cps.contact_id
     WHERE cps.contact_id = ?
       AND cps.mode = ?
       AND (cps.id = ? OR cps.conekta_payment_source_id = ?)
     LIMIT 1`,
    [contactId, config.mode, selectedSourceId, selectedSourceId]
  )

  if (!savedSource) {
    const error = new Error('No encontramos esa tarjeta guardada para este contacto.')
    error.status = 404
    throw error
  }

  const id = createId('conekta_saved_payment')
  const currency = normalizeCurrency(input.currency || await getConfiguredCurrency())
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
    source: cleanString(input.source || 'ristak_conekta_saved_card'),
    contactName: cleanString(input.contactName || savedSource.contact_name),
    contactEmail: cleanString(input.email || savedSource.contact_email),
    contactPhone: cleanString(input.phone || savedSource.contact_phone),
    conektaCustomerId: savedSource.conekta_customer_id,
    conektaPaymentSourceId: savedSource.conekta_payment_source_id,
    savedPaymentSource: {
      brand: savedSource.brand || '',
      last4: savedSource.last4 || '',
      expMonth: savedSource.exp_month || null,
      expYear: savedSource.exp_year || null
    },
    lineItems: Array.isArray(input.lineItems) ? input.lineItems : [],
    ...(tax ? { tax } : {})
  }

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, reference, title, description, date, due_date, sent_at,
      metadata_json, conekta_payment_source_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      id,
      contactId,
      chargeAmount,
      currency,
      'pending',
      'conekta_saved_card',
      config.mode,
      'conekta',
      null,
      title,
      description,
      now,
      input.dueDate || null,
      now,
      JSON.stringify(metadata),
      savedSource.conekta_payment_source_id
    ]
  )

  const row = await findPaymentById(id)
  await createOrderForPayment(row, {
    paymentSourceId: savedSource.conekta_payment_source_id,
    customerId: savedSource.conekta_customer_id
  })

  const updated = await findPaymentById(id)
  return { payment: mapSavedCardPayment(updated) }
}
