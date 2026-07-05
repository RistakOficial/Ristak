import fetch from 'node-fetch'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { decrypt, encrypt, isEncrypted } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'
import { updateSingleContactStats } from '../utils/updateContactsStats.js'
import { getAccountCurrency } from '../utils/accountLocale.js'
import { calculatePaymentTax, getPaymentGatewayMode, getPublicPaymentSettings } from './paymentSettingsService.js'
import { registerGigstackPaymentForTransactionInBackground } from './gigstackInvoiceService.js'
import { dispatchProductPostWebhooksForPaymentInBackground } from './productPostWebhookService.js'
import { resolvePaymentContactForGatewayPayment } from './paymentContactLinkService.js'
import { sendPaymentNotification } from './pushNotificationsService.js'
import { publishSubscriptionChangedEvent } from './paymentLiveEventsService.js'
import { queuePaymentAutomationMessage } from './paymentAutomationsService.js'
import { mapGatewayPaymentStatus } from './paymentGatewayStatusPolicy.js'
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
  enabled: 'clip_enabled',
  mode: 'clip_mode',
  defaultCurrency: 'clip_default_currency',
  accountLabel: 'clip_account_label',
  apiKey: 'clip_api_key_encrypted',
  modeConnections: 'clip_mode_connections',
  disconnectedAt: 'clip_disconnected_at'
}

const DEFAULT_CURRENCY = 'MXN'
const CLIP_API_BASE = 'https://api.payclip.com'
const CLIP_SDK_SCRIPT_URL = 'https://sdk.clip.mx/js/clip-sdk.js'
const CLIP_WEBHOOK_PATH = '/api/clip/webhook'
const CLIP_INSTALLMENT_MONTHS = new Set([3, 6, 9, 12, 18, 24])
const CLIP_INSTALLMENT_MIN_AMOUNT = 300
const SUCCESSFUL_PAYMENT_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'approved'])
const CLOSED_PAYMENT_STATUSES = new Set(['paid', 'succeeded', 'completed', 'refunded', 'void', 'deleted'])

let clipFetchForTest = null

export function setClipFetchForTest(fetchImpl) {
  clipFetchForTest = typeof fetchImpl === 'function' ? fetchImpl : null
}

function clipFetch() {
  return clipFetchForTest || fetch
}

function cleanString(value) {
  return String(value || '').trim()
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

function assertClipCurrency(currency) {
  const normalized = normalizeCurrency(currency)
  if (normalized !== 'MXN') {
    const error = new Error('CLIP Checkout Transparente solo acepta MXN. Cambia la moneda de la cuenta a MXN o usa otra pasarela para este cobro.')
    error.status = 400
    throw error
  }
  return normalized
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

function buildPaymentUrl(baseUrl, publicPaymentId) {
  const cleanBase = cleanString(baseUrl).replace(/\/+$/, '')
  return cleanBase ? `${cleanBase}/pay/${encodeURIComponent(publicPaymentId)}` : ''
}

function normalizeWebhookUrl(value) {
  const clean = cleanString(value).replace(/\/+$/, '')
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
  const normalized = normalizeWebhookUrl(baseUrl)
  return normalized ? `${normalized}${CLIP_WEBHOOK_PATH}` : ''
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
  const clean = cleanString(value)
  if (!clean) return ''
  return isEncrypted(clean) ? decrypt(clean) : clean
}

function encryptOptionalSecret(value) {
  const clean = cleanString(value)
  return clean ? encrypt(clean) : ''
}

function previewSecret(value = '') {
  const clean = cleanString(value)
  if (!clean) return ''
  if (clean.length <= 10) return '****'
  return `${clean.slice(0, 6)}****${clean.slice(-4)}`
}

function isMaskedSecret(value = '') {
  const clean = cleanString(value)
  return Boolean(clean && (clean.includes('•') || clean.includes('*') || /^x+$/i.test(clean)))
}

function looksLikeClipSdkApiKey(value = '') {
  const clean = cleanString(value)
  if (!clean || isMaskedSecret(clean)) return false
  return /^(test|live)_[a-z0-9-]{16,}$/i.test(clean) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean)
}

function resolveClipCredentialInput(input = {}, previous = {}, requestedMode = 'test') {
  const submittedAccountLabel = cleanString(input.accountLabel || input.account_label)
  const submittedApiKey = cleanString(input.apiKey || input.api_key)
  const accountLabelLooksLikeApiKey = looksLikeClipSdkApiKey(submittedAccountLabel)
  const apiKeyLooksLikeApiKey = looksLikeClipSdkApiKey(submittedApiKey)
  const apiKeyFromLabel = accountLabelLooksLikeApiKey && !apiKeyLooksLikeApiKey
  const usableSubmittedApiKey = submittedApiKey && !isMaskedSecret(submittedApiKey) ? submittedApiKey : ''
  const apiKey = apiKeyFromLabel
    ? submittedAccountLabel
    : usableSubmittedApiKey || cleanString(previous.apiKey)
  const accountLabel = apiKeyFromLabel
    ? cleanString(previous.accountLabel) || (normalizeMode(requestedMode) === 'live' ? 'CLIP en vivo' : 'CLIP prueba')
    : cleanString(submittedAccountLabel || previous.accountLabel)

  return {
    apiKey,
    accountLabel
  }
}

function normalizePositiveAmount(value, fallback = 25) {
  const amount = Number(value)
  if (Number.isFinite(amount) && amount > 0) return Math.round(amount * 100) / 100
  return Math.round(Number(fallback || 25) * 100) / 100
}

function timestampToIso(value) {
  const clean = cleanString(value)
  if (!clean) return null
  const timestamp = Date.parse(clean)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : clean
}

function readModeConnections(raw = {}) {
  const parsed = parseJson(raw[CONFIG_KEYS.modeConnections], {})
  return {
    test: normalizeStoredConnection(parsed.test, 'test', { includeSecrets: true }),
    live: normalizeStoredConnection(parsed.live, 'live', { includeSecrets: true })
  }
}

function normalizeStoredConnection(value = {}, mode = 'test', { includeSecrets = false } = {}) {
  if (!value || typeof value !== 'object') {
    return {
      mode: normalizeMode(mode),
      configured: false,
      accountLabel: '',
      apiKey: includeSecrets ? '' : undefined,
      hasApiKey: false,
      apiKeyPreview: '',
      connectedAt: '',
      updatedAt: ''
    }
  }

  const apiKey = decryptSecret(value.apiKey || value.api_key)
  return {
    mode: normalizeMode(value.mode || mode),
    configured: Boolean(apiKey),
    accountLabel: cleanString(value.accountLabel || value.account_label),
    apiKey: includeSecrets ? apiKey : undefined,
    hasApiKey: Boolean(apiKey),
    apiKeyPreview: previewSecret(apiKey),
    connectedAt: cleanString(value.connectedAt || value.connected_at),
    updatedAt: cleanString(value.updatedAt || value.updated_at)
  }
}

function getModeConnection(raw = {}, mode = 'test') {
  const normalizedMode = normalizeMode(mode)
  const connections = readModeConnections(raw)
  if (connections[normalizedMode]?.configured) return connections[normalizedMode]

  const legacyMode = normalizeMode(raw[CONFIG_KEYS.mode])
  const legacyApiKey = decryptSecret(raw[CONFIG_KEYS.apiKey])
  if (legacyMode === normalizedMode && legacyApiKey) {
    return normalizeStoredConnection({
      mode: normalizedMode,
      accountLabel: raw[CONFIG_KEYS.accountLabel],
      apiKey: raw[CONFIG_KEYS.apiKey],
      connectedAt: raw[CONFIG_KEYS.mode] ? '' : null
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
    accountLabel: cleanString(connection?.accountLabel),
    hasApiKey: Boolean(connection?.hasApiKey),
    apiKeyPreview: cleanString(connection?.apiKeyPreview),
    connectedAt: cleanString(connection?.connectedAt) || null,
    updatedAt: cleanString(connection?.updatedAt) || null
  }
}

function mapConfig(raw = {}, { includeSecrets = false, mode: modeOverride = '' } = {}) {
  const mode = normalizeMode(modeOverride || raw[CONFIG_KEYS.mode])
  const selected = getModeConnection(raw, mode)
  const apiKey = cleanString(selected?.apiKey)
  const enabled = normalizeBoolean(raw[CONFIG_KEYS.enabled], true)
  const configured = Boolean(enabled && apiKey)

  return {
    enabled,
    configured,
    mode,
    defaultCurrency: normalizeCurrency(raw[CONFIG_KEYS.defaultCurrency] || DEFAULT_CURRENCY),
    accountLabel: cleanString(selected?.accountLabel || raw[CONFIG_KEYS.accountLabel]),
    hasApiKey: Boolean(apiKey),
    apiKeyPreview: previewSecret(apiKey),
    connectedAt: cleanString(selected?.connectedAt) || null,
    disconnectedAt: raw[CONFIG_KEYS.disconnectedAt] || null,
    modeConnections: {
      test: summarizeModeConnection(raw, 'test'),
      live: summarizeModeConnection(raw, 'live')
    },
    ...(includeSecrets ? { apiKey } : {})
  }
}

export async function getClipPaymentConfig({ includeSecrets = false, mode: modeOverride = '' } = {}) {
  const raw = await readRawConfig()
  const mode = modeOverride || await getPaymentGatewayMode()
  return mapConfig(raw, { includeSecrets, mode })
}

export async function saveClipPaymentConfig(input = {}) {
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
    await setAppConfig(CONFIG_KEYS.defaultCurrency, DEFAULT_CURRENCY)
    await setAppConfig(CONFIG_KEYS.accountLabel, otherConnection.accountLabel || '')
    await setAppConfig(CONFIG_KEYS.apiKey, otherConnection.apiKey ? encryptOptionalSecret(otherConnection.apiKey) : '')
    await setAppConfig(CONFIG_KEYS.modeConnections, JSON.stringify({
      test: connections.test,
      live: connections.live
    }))
    if (!otherConnection.configured) await setAppConfig(CONFIG_KEYS.disconnectedAt, now)

    return getClipPaymentConfig({ mode: nextMode })
  }

  const previous = getModeConnection(raw, requestedMode)
  const credentialInput = resolveClipCredentialInput(input, previous, requestedMode)
  const apiKey = cleanString(credentialInput.apiKey)

  if (enabled && !apiKey) {
    const error = new Error('Agrega la Clave API visible de CLIP para conectar el SDK de Checkout Transparente.')
    error.status = 400
    throw error
  }

  connections[requestedMode] = {
    mode: requestedMode,
    accountLabel: cleanString(credentialInput.accountLabel),
    apiKey: apiKey ? encryptOptionalSecret(apiKey) : '',
    connectedAt: previous.connectedAt || now,
    updatedAt: now
  }

  await setAppConfig(CONFIG_KEYS.enabled, enabled ? '1' : '0')
  await setAppConfig(CONFIG_KEYS.mode, requestedMode)
  await setAppConfig(CONFIG_KEYS.defaultCurrency, DEFAULT_CURRENCY)
  await setAppConfig(CONFIG_KEYS.accountLabel, connections[requestedMode].accountLabel)
  if (apiKey) await setAppConfig(CONFIG_KEYS.apiKey, encryptOptionalSecret(apiKey))
  await setAppConfig(CONFIG_KEYS.modeConnections, JSON.stringify({
    test: connections.test,
    live: connections.live
  }))

  return getClipPaymentConfig({ mode: requestedMode })
}

export async function deleteClipPaymentConfig() {
  await db.run(
    `DELETE FROM app_config
     WHERE config_key IN (${Object.values(CONFIG_KEYS).map(() => '?').join(', ')})`,
    Object.values(CONFIG_KEYS)
  )
  return getClipPaymentConfig()
}

async function getClipClientConfig(mode = '') {
  const config = await getClipPaymentConfig({ includeSecrets: true, mode })
  if (!config.configured || !config.apiKey) {
    const error = new Error('CLIP no está configurado.')
    error.status = 400
    throw error
  }
  return config
}

function normalizeClipErrorMessage(payload = {}) {
  const message = cleanString(payload.message || payload.error || payload.error_message)
  const code = cleanString(payload.code || payload.error_code)
  if (message && code) return `${message} (${code})`
  return message || 'CLIP no pudo completar la solicitud.'
}

async function clipApiRequest(path, { method = 'GET', body = null, config: configOverride = null } = {}) {
  const config = configOverride || await getClipClientConfig()
  const url = path.startsWith('http') ? path : `${CLIP_API_BASE}${path}`
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`
  }

  const response = await clipFetch()(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  })
  const payload = await response.json().catch(() => ({}))

  if (!response.ok) {
    const error = new Error(normalizeClipErrorMessage(payload))
    error.status = response.status || 502
    error.payload = payload
    throw error
  }

  return { payload, config }
}

export async function testClipPaymentConfig(input = null) {
  const mode = normalizeMode(input?.mode || await getPaymentGatewayMode())
  const previous = await getClipPaymentConfig({ includeSecrets: true, mode })
  const credentialInput = resolveClipCredentialInput(input || {}, previous, mode)
  const apiKey = cleanString(credentialInput.apiKey)

  if (!apiKey) {
    const error = new Error('Agrega la Clave API visible de CLIP para validar el SDK de Checkout Transparente.')
    error.status = 400
    throw error
  }

  return {
    ok: true,
    mode,
    accountLabel: cleanString(credentialInput.accountLabel || previous.accountLabel),
    apiKeyPreview: previewSecret(apiKey),
    validationMode: 'sdk_credentials',
    sdkScriptUrl: CLIP_SDK_SCRIPT_URL,
    message: 'Clave API lista para inicializar el SDK de Checkout Transparente de CLIP.'
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

async function findPaymentByClipPaymentId(clipPaymentId) {
  return db.get(
    `SELECT
      p.*,
      c.full_name AS contact_name,
      c.email AS contact_email,
      c.phone AS contact_phone
     FROM payments p
     LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE p.clip_payment_id = ?`,
    [clipPaymentId]
  )
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

function mapPublicPayment(row, config, baseUrl = '', settings = null, timezone = ACCOUNT_DEFAULT_TIMEZONE) {
  if (!row) return null
  const metadata = parseJson(row.metadata_json, {})
  const tax = metadata.tax && typeof metadata.tax === 'object' ? metadata.tax : null
  const subscriptionStart = getPublicSubscriptionStart(metadata)
  const publicPaymentId = row.public_payment_id
  const clipInstallments = normalizeClipInstallmentOptions(metadata.clipInstallments, {
    amount: row.amount,
    emptyAsNull: true
  })

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
    provider: 'clip',
    contact: {
      id: row.contact_id || '',
      name: row.contact_name || metadata.contactName || '',
      email: row.contact_email || metadata.contactEmail || '',
      phone: row.contact_phone || metadata.contactPhone || ''
    },
    clipPaymentId: row.clip_payment_id || metadata.clip?.paymentId || null,
    clipReceiptNo: row.clip_receipt_no || metadata.clip?.receiptNo || null,
    pendingAction: metadata.clip?.pendingAction || null,
    apiKey: config?.apiKey || '',
    subscriptionStart,
    clipInstallments,
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

export async function createClipPaymentLink(input = {}, { baseUrl, mode = '' } = {}) {
  await getClipClientConfig(mode)
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
  const currency = assertClipCurrency(input.currency || await getConfiguredCurrency())
  const publicPaymentId = createPublicId()
  const id = createId('clip_payment')
  const now = new Date().toISOString()
  const paymentUrl = buildPaymentUrl(baseUrl, publicPaymentId)
  const config = await getClipClientConfig(mode)
  const contact = {
    id: cleanString(input.contactId),
    name: cleanString(input.contactName),
    email: cleanString(input.email),
    phone: cleanString(input.phone)
  }
  if (!contact.email || !contact.phone) {
    const error = new Error('CLIP requiere email y teléfono del cliente para crear el link de pago.')
    error.status = 400
    throw error
  }
  const clipInstallments = normalizeClipInstallmentOptions(input.installments || input.clipInstallments, {
    amount: chargeAmount,
    emptyAsNull: true
  })
  const metadata = {
    contactName: contact.name,
    contactEmail: contact.email,
    contactPhone: contact.phone,
    source: cleanString(input.source || 'ristak'),
    lineItems: Array.isArray(input.lineItems) ? input.lineItems : [],
    ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
    ...(clipInstallments ? { clipInstallments } : {}),
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
      'clip_card',
      config.mode,
      'clip',
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

  const row = await findPaymentById(id)
  return {
    payment: mapPublicPayment(row, config, baseUrl, paymentSettings),
    paymentUrl,
    publicPaymentId
  }
}

export async function getPublicClipPayment(publicPaymentId, { baseUrl } = {}) {
  const row = await findPaymentByPublicId(publicPaymentId)
  if (!row || row.payment_provider !== 'clip') return null

  const config = await getClipPaymentConfig({ includeSecrets: true, mode: row.payment_mode })
  const paymentSettings = await getPublicPaymentSettings()
  const timezone = await getAccountTimezone().catch(() => ACCOUNT_DEFAULT_TIMEZONE)
  return attachMetaPublicPurchaseEvent(
    mapPublicPayment(row, config, baseUrl, paymentSettings, timezone),
    row
  )
}

function sanitizeClipText(value, fallback = 'Pago Ristak', maxLength = 255) {
  const fallbackText = cleanString(fallback) || 'Pago Ristak'
  const raw = cleanString(value) || fallbackText
  const withoutEmoji = raw.replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
  const sanitized = withoutEmoji
    .replace(/\s+/g, ' ')
    .trim()
  return (sanitized || fallbackText).slice(0, maxLength)
}

function sanitizeExternalReference(value) {
  const clean = cleanString(value)
    .replace(/\s+/g, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 36)
  return clean || `rstk_${Date.now().toString(36)}`.slice(0, 36)
}

function splitName(value) {
  const clean = cleanString(value)
  if (!clean) return { firstName: 'Cliente', lastName: 'Ristak' }
  const parts = clean.split(/\s+/).filter(Boolean)
  if (parts.length <= 1) return { firstName: parts[0], lastName: 'Ristak' }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' ')
  }
}

function normalizeClipInstallments(value) {
  const parsed = Math.trunc(Number(value || 1))
  if (!Number.isFinite(parsed) || parsed <= 1) return 1
  if (CLIP_INSTALLMENT_MONTHS.has(parsed)) return parsed
  const error = new Error('CLIP solo acepta meses sin intereses a 3, 6, 9, 12, 18 o 24 meses.')
  error.status = 400
  throw error
}

function normalizeClipInstallmentOptions(input, { amount = null, emptyAsNull = false } = {}) {
  if (input === undefined || input === null || input === '' || input === false) {
    return emptyAsNull ? null : {
      enabled: false,
      maxInstallments: 1,
      minAmount: CLIP_INSTALLMENT_MIN_AMOUNT,
      options: []
    }
  }

  const source = typeof input === 'object' && !Array.isArray(input)
    ? input
    : { enabled: true, maxInstallments: input }
  const enabled = normalizeBoolean(source.enabled, Boolean(source.maxInstallments || source.months || source.installments))

  if (!enabled) {
    return emptyAsNull ? null : {
      enabled: false,
      maxInstallments: 1,
      minAmount: CLIP_INSTALLMENT_MIN_AMOUNT,
      options: []
    }
  }

  const months = normalizeClipInstallments(source.maxInstallments || source.months || source.installments || 24)
  if (months <= 1) {
    return emptyAsNull ? null : {
      enabled: false,
      maxInstallments: 1,
      minAmount: CLIP_INSTALLMENT_MIN_AMOUNT,
      options: []
    }
  }

  const parsedAmount = Number(amount)
  if (Number.isFinite(parsedAmount) && parsedAmount < CLIP_INSTALLMENT_MIN_AMOUNT) {
    const error = new Error(`Para ofrecer meses sin intereses en CLIP, el monto mínimo es ${CLIP_INSTALLMENT_MIN_AMOUNT} MXN.`)
    error.status = 400
    throw error
  }

  return {
    enabled: true,
    maxInstallments: months,
    minAmount: CLIP_INSTALLMENT_MIN_AMOUNT,
    label: 'Meses sin intereses en CLIP',
    options: [...CLIP_INSTALLMENT_MONTHS]
      .filter((available) => available <= months)
      .map((available) => ({
        months: available,
        minAmount: CLIP_INSTALLMENT_MIN_AMOUNT
      }))
  }
}

function normalizeClipChargeInstallments(input, configuredOptions = null) {
  const parsed = normalizeClipInstallments(input)
  if (parsed <= 1) return 1

  if (!configuredOptions?.enabled) {
    const error = new Error('Este cobro de CLIP no tiene meses sin intereses habilitados.')
    error.status = 400
    throw error
  }

  if (parsed > Number(configuredOptions.maxInstallments || 1)) {
    const error = new Error(`Este cobro de CLIP permite hasta ${configuredOptions.maxInstallments} meses sin intereses.`)
    error.status = 400
    throw error
  }

  return parsed
}

function buildClipPaymentPayload(row, input = {}, { baseUrl = '' } = {}) {
  const metadata = parseJson(row.metadata_json, {})
  const token = cleanString(input.token || input.cardTokenId || input.card_token_id || input.tokenId || input.token_id)
  const amount = Number(row.amount)
  const currency = assertClipCurrency(row.currency)
  const clipInstallments = normalizeClipInstallmentOptions(metadata.clipInstallments, {
    amount,
    emptyAsNull: true
  })

  if (!token) {
    const error = new Error('CLIP no devolvió el token de la tarjeta.')
    error.status = 400
    throw error
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error('El monto del pago no es válido.')
    error.status = 400
    throw error
  }

  const customerName = row.contact_name || metadata.contactName || input.customerName || input.customer_name
  const customerEmail = cleanString(input.email || input.customer?.email || row.contact_email || metadata.contactEmail).toLowerCase()
  const customerPhone = cleanString(input.phone || input.customer?.phone || row.contact_phone || metadata.contactPhone)
  if (!customerEmail || !customerPhone) {
    const error = new Error('CLIP requiere email y teléfono del cliente para procesar el pago.')
    error.status = 400
    throw error
  }

  const { firstName, lastName } = splitName(customerName)
  const webhookUrl = buildWebhookUrl(baseUrl)

  return {
    amount: Math.round(amount * 100) / 100,
    currency,
    description: sanitizeClipText(row.description || row.title || 'Pago Ristak'),
    external_reference: sanitizeExternalReference(row.public_payment_id || row.id),
    capture_method: 'automatic',
    installments: normalizeClipChargeInstallments(input.installments, clipInstallments),
    payment_method: {
      token
    },
    customer: {
      first_name: sanitizeClipText(firstName, 'Cliente', 80),
      last_name: sanitizeClipText(lastName, 'Ristak', 80),
      email: customerEmail,
      phone: customerPhone
    },
    ...(webhookUrl ? { webhook_url: webhookUrl } : {})
  }
}

export function mapClipStatus(status) {
  const normalized = cleanString(status).toLowerCase()
  return mapGatewayPaymentStatus(normalized, {
    paidStatuses: ['approved'],
    pendingStatuses: ['authorized', 'pending', 'cancelled', 'canceled', 'expired'],
    refundedStatuses: ['refunded'],
    failedStatuses: ['rejected'],
    voidStatuses: ['void', 'voided']
  })
}

function shouldIgnorePendingRegression(payment = {}, nextStatus = '') {
  if (nextStatus !== 'pending') return false
  const currentStatus = cleanString(payment.status).toLowerCase()
  return SUCCESSFUL_PAYMENT_STATUSES.has(currentStatus) || Boolean(payment.paid_at)
}

async function activateSubscriptionStartIfNeeded(payment, nextStatus) {
  const metadata = parseJson(payment?.metadata_json, {})
  const subscriptionStart = getPublicSubscriptionStart(metadata)
  if (!subscriptionStart?.subscriptionId) return

  const subscription = await db.get(
    `SELECT id, status, next_run_at, metadata_json
     FROM subscriptions
     WHERE id = ?
     LIMIT 1`,
    [subscriptionStart.subscriptionId]
  ).catch(() => null)
  if (!subscription?.id) return

  const subscriptionMetadata = parseJson(subscription.metadata_json, {})
  const currentStartPayment = subscriptionMetadata.subscriptionStartPayment && typeof subscriptionMetadata.subscriptionStartPayment === 'object'
    ? subscriptionMetadata.subscriptionStartPayment
    : {}
  const updatedMetadata = {
    ...subscriptionMetadata,
    subscriptionStartPayment: {
      ...currentStartPayment,
      paymentId: payment.id,
      publicPaymentId: payment.public_payment_id,
      paymentUrl: payment.payment_url,
      provider: 'clip',
      status: nextStatus,
      clipPaymentId: payment.clip_payment_id || '',
      clipReceiptNo: payment.clip_receipt_no || '',
      paidAt: nextStatus === 'paid' ? payment.paid_at || new Date().toISOString() : currentStartPayment.paidAt || null,
      updatedAt: new Date().toISOString()
    }
  }

  if (nextStatus === 'paid') {
    await db.run(
      `UPDATE subscriptions
       SET status = CASE
             WHEN COALESCE(status, '') IN ('', 'draft', 'incomplete', 'past_due') THEN 'active'
             ELSE status
           END,
           current_period_start = COALESCE(current_period_start, ?),
           next_run_at = COALESCE(next_run_at, ?),
           payment_mode = COALESCE(?, payment_mode),
           metadata_json = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        payment.paid_at || new Date().toISOString(),
        cleanString(subscriptionStart.nextRunAt) || null,
        payment.payment_mode || null,
        JSON.stringify(updatedMetadata),
        subscription.id
      ]
    )
    const updated = await db.get('SELECT * FROM subscriptions WHERE id = ?', [subscription.id]).catch(() => null)
    publishSubscriptionChangedEvent(updated || {
      ...subscription,
      status: subscription.status === 'active' ? subscription.status : 'active'
    }, { previousStatus: subscription.status })
    return
  }

  await db.run(
    `UPDATE subscriptions
     SET metadata_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [JSON.stringify(updatedMetadata), subscription.id]
  )
  const updated = await db.get('SELECT * FROM subscriptions WHERE id = ?', [subscription.id]).catch(() => null)
  publishSubscriptionChangedEvent(updated || subscription, { previousStatus: subscription.status })
}

async function syncClipPaymentPlanFromLocalPayment(payment) {
  if (!payment?.id) return
  const status = cleanString(payment.status)

  await db.run(
    `UPDATE installment_payments
     SET status = ?,
         clip_payment_id = COALESCE(?, clip_payment_id),
         updated_at = CURRENT_TIMESTAMP
     WHERE payment_id = ?`,
    [status === 'paid' ? 'paid' : status || 'pending', payment.clip_payment_id || null, payment.id]
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

async function updatePaymentFromClipPayment(clipPayment) {
  const clipPaymentId = cleanString(clipPayment?.id)
  const externalReference = cleanString(clipPayment?.external_reference)
  if (!clipPaymentId && !externalReference) return null

  let row = clipPaymentId ? await findPaymentByClipPaymentId(clipPaymentId) : null
  if (!row && externalReference) row = await findPaymentByPublicId(externalReference)
  if (!row) return null

  const amount = Number(clipPayment.amount || clipPayment.paid_amount || row.amount)
  const currency = assertClipCurrency(clipPayment.currency || row.currency)
  const nextStatus = mapClipStatus(clipPayment.status)
  const ignorePendingRegression = shouldIgnorePendingRegression(row, nextStatus)
  const persistedStatus = ignorePendingRegression ? cleanString(row.status) || 'paid' : nextStatus
  const paidAt = nextStatus === 'paid'
    ? timestampToIso(clipPayment.approved_at || clipPayment.paid_at || clipPayment.created_at || clipPayment.updated_at || clipPayment.date)
      || new Date().toISOString()
    : null
  const metadata = {
    ...parseJson(row.metadata_json, {}),
    clip: {
      paymentId: clipPaymentId,
      receiptNo: cleanString(clipPayment.receipt_no),
      status: cleanString(clipPayment.status),
      statusDetail: clipPayment.status_detail || null,
      pendingAction: clipPayment.pending_action || null,
      installments: clipPayment.installments || null,
      paymentMethod: clipPayment.payment_method || null,
      rawUpdatedAt: new Date().toISOString()
    }
  }

  await db.run(
    `UPDATE payments
     SET amount = COALESCE(?, amount),
         currency = COALESCE(?, currency),
         status = ?,
         payment_method = 'clip_card',
         payment_provider = 'clip',
         reference = COALESCE(?, reference),
         clip_payment_id = COALESCE(?, clip_payment_id),
         clip_receipt_no = COALESCE(?, clip_receipt_no),
         paid_at = COALESCE(?, paid_at),
         date = COALESCE(?, date),
         metadata_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      Number.isFinite(amount) ? amount : null,
      currency,
      persistedStatus,
      clipPaymentId || null,
      clipPaymentId || null,
      cleanString(clipPayment.receipt_no) || null,
      paidAt,
      paidAt,
      JSON.stringify(metadata),
      row.id
    ]
  )

  let updated = await findPaymentById(row.id)
  const linkedContactId = await resolvePaymentContactForGatewayPayment(updated, {
    provider: 'clip',
    providerPayload: clipPayment
  })
  if (linkedContactId && !updated?.contact_id) {
    updated = await findPaymentById(row.id)
  }
  if (updated?.id && !ignorePendingRegression) {
    dispatchProductPostWebhooksForPaymentInBackground(updated.id, {
      status: persistedStatus,
      previousStatus: row.status || ''
    })
    if (cleanString(row.status).toLowerCase() !== cleanString(persistedStatus).toLowerCase()) {
      sendPaymentNotification({ ...updated, status: persistedStatus, previousStatus: row.status || '' }).catch((error) => {
        logger.warn(`No se pudo enviar push de pago CLIP ${updated.id}: ${error.message}`)
      })
    }
  }

  await activateSubscriptionStartIfNeeded(updated, persistedStatus)
  await syncClipPaymentPlanFromLocalPayment(updated)

  if (updated?.contact_id && nextStatus === 'paid') {
    registerGigstackPaymentForTransactionInBackground(updated.id)
    updateSingleContactStats(updated.contact_id).catch((error) => {
      logger.warn(`No se pudieron actualizar stats del contacto por pago CLIP ${row.id}: ${error.message}`)
    })
    Promise.resolve(queuePaymentAutomationMessage('receipt', { ...updated, status: nextStatus }))
      .catch((error) => {
        logger.warn(`No se pudo encolar comprobante por pago CLIP ${updated.id}: ${error.message}`)
      })
    triggerMetaPaymentPurchaseEvent(updated.contact_id, { ...updated, status: nextStatus })
      .catch((error) => {
        logger.warn(`No se pudo enviar Purchase a Meta para pago CLIP ${updated.id}: ${error.message}`)
      })
  }

  if (ignorePendingRegression) {
    logger.info(`[CLIP webhook] Ignorado estado pending tardío para pago ya pagado ${updated?.id || row.id} (payment ${clipPaymentId})`)
  }

  return updated
}

export async function createPublicClipCardPayment(publicPaymentId, input = {}, { baseUrl } = {}) {
  const row = await findPaymentByPublicId(publicPaymentId)
  if (!row || row.payment_provider !== 'clip') {
    const error = new Error('Pago no encontrado.')
    error.status = 404
    throw error
  }

  if (CLOSED_PAYMENT_STATUSES.has(cleanString(row.status).toLowerCase())) {
    const error = new Error('Este pago ya no acepta nuevos cobros.')
    error.status = 409
    throw error
  }

  const config = await getClipClientConfig(row.payment_mode)
  const paymentPayload = buildClipPaymentPayload(row, input, { baseUrl })
  const { payload } = await clipApiRequest('/payments', {
    method: 'POST',
    body: paymentPayload,
    config
  })

  const referencedPayload = {
    ...payload,
    external_reference: cleanString(payload?.external_reference) || row.public_payment_id
  }
  const updated = await updatePaymentFromClipPayment(referencedPayload)
  const refreshed = updated || await findPaymentById(row.id)
  const paymentSettings = await getPublicPaymentSettings()

  return {
    payment: mapPublicPayment(refreshed, config, baseUrl, paymentSettings),
    clipPaymentId: cleanString(payload?.id),
    clipReceiptNo: cleanString(payload?.receipt_no),
    status: cleanString(payload?.status),
    statusDetail: payload?.status_detail || null,
    pendingAction: payload?.pending_action || null
  }
}

export async function refreshPublicClipPayment(publicPaymentId, clipPaymentId = '', { baseUrl } = {}) {
  const row = await findPaymentByPublicId(publicPaymentId)
  if (!row || row.payment_provider !== 'clip') {
    const error = new Error('Pago no encontrado.')
    error.status = 404
    throw error
  }

  const paymentId = cleanString(clipPaymentId || row.clip_payment_id)
  if (!paymentId) {
    const error = new Error('CLIP no devolvió un identificador de pago para consultar.')
    error.status = 400
    throw error
  }

  const config = await getClipClientConfig(row.payment_mode)
  const { payload } = await clipApiRequest(`/payments/${encodeURIComponent(paymentId)}`, { config })
  const updated = await updatePaymentFromClipPayment({
    ...payload,
    external_reference: cleanString(payload?.external_reference) || row.public_payment_id
  })
  const paymentSettings = await getPublicPaymentSettings()

  return {
    payment: mapPublicPayment(updated || await findPaymentById(row.id), config, baseUrl, paymentSettings),
    clipPaymentId: cleanString(payload?.id),
    status: cleanString(payload?.status),
    statusDetail: payload?.status_detail || null,
    pendingAction: payload?.pending_action || null
  }
}

export async function refreshClipPayment(clipPaymentId, { mode = '' } = {}) {
  const paymentId = cleanString(clipPaymentId)
  if (!paymentId) return null
  const existing = await findPaymentByClipPaymentId(paymentId)
  const config = await getClipClientConfig(existing?.payment_mode || mode)
  const { payload } = await clipApiRequest(`/payments/${encodeURIComponent(paymentId)}`, { config })
  return updatePaymentFromClipPayment(payload)
}

export async function handleClipWebhookEvent(body = {}) {
  const paymentId = cleanString(body.id || body.payment_id || body.data?.id || body.data?.object?.id)
  const eventType = cleanString(body.event_type || body.type || body.event)
  if (!paymentId) {
    return { received: true, ignored: true, eventType }
  }

  const updated = await refreshClipPayment(paymentId)
  return {
    received: true,
    eventType,
    paymentId: updated?.id || null,
    status: updated?.status || null
  }
}

export const CLIP_WEBHOOK_ENDPOINT_PATH = CLIP_WEBHOOK_PATH
