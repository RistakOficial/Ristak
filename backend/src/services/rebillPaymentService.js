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
import {
  buildMetaPublicPurchasePixelEvent,
  triggerMetaPaymentPurchaseEvent
} from './metaConversionEventsService.js'
import { createPublicPaymentId, createRistakPaymentEntityId } from '../utils/idGenerator.js'
import {
  DEFAULT_TIMEZONE as ACCOUNT_DEFAULT_TIMEZONE,
  getAccountTimezone
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

function mapRebillStatus(status) {
  const normalized = cleanString(status, 80).toLowerCase()
  if (['approved', 'paid', 'succeeded', 'success', 'completed', 'complete', 'fulfilled'].includes(normalized)) return 'paid'
  if (['pending', 'processing', 'in_process', 'authorized', 'pending_customer_charge'].includes(normalized)) return 'pending'
  if (['rejected', 'failed', 'failure', 'declined', 'error'].includes(normalized)) return 'failed'
  if (['cancelled', 'canceled', 'expired'].includes(normalized)) return 'void'
  if (['refunded', 'partially_refunded', 'chargeback'].includes(normalized)) return 'refunded'
  return normalized || 'pending'
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
