import { randomBytes } from 'crypto'
import fetch from 'node-fetch'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { decrypt, encrypt, isEncrypted } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'
import { updateSingleContactStats } from '../utils/updateContactsStats.js'
import { getAccountCurrency } from '../utils/accountLocale.js'
import { calculatePaymentTax, getPublicPaymentSettings } from './paymentSettingsService.js'
import { queuePaymentAutomationMessage } from './paymentAutomationsService.js'
import { registerGigstackPaymentForTransactionInBackground } from './gigstackInvoiceService.js'

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
  return `${prefix}_${Date.now()}_${randomBytes(6).toString('hex')}`
}

function createPublicId() {
  return `pay_${randomBytes(18).toString('base64url')}`
}

function buildPaymentUrl(baseUrl, publicPaymentId) {
  const cleanBase = cleanString(baseUrl).replace(/\/+$/, '')
  return cleanBase ? `${cleanBase}/pay/${encodeURIComponent(publicPaymentId)}` : ''
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
    updatedAt: cleanString(value.updatedAt || value.updated_at)
  }
}

function serializeModeConnection(connection = {}) {
  const privateKey = cleanString(connection.privateKey)
  return {
    mode: normalizeMode(connection.mode),
    publicKey: cleanString(connection.publicKey),
    privateKey: privateKey ? encrypt(privateKey) : '',
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

  return {
    mode,
    publicKey: nextPublicKey,
    privateKey: nextPrivateKey,
    configured: Boolean(nextPublicKey && nextPrivateKey),
    updatedAt: new Date().toISOString()
  }
}

function chooseMode(connections = {}, preferred = 'live') {
  const preferredMode = normalizeMode(preferred)
  if (connections[preferredMode]?.configured || (connections[preferredMode]?.publicKey && connections[preferredMode]?.privateKey)) return preferredMode
  if (connections.live?.configured || (connections.live?.publicKey && connections.live?.privateKey)) return 'live'
  if (connections.test?.configured || (connections.test?.publicKey && connections.test?.privateKey)) return 'test'
  return preferredMode
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
      updatedAt: ''
    }
  }

  return connections
}

export async function getConektaPaymentConfig(options = {}) {
  const raw = await readRawConfig()
  const modeConnections = await getStoredModeConnections(raw, options)
  const activeMode = normalizeMode(options.mode || raw[CONFIG_KEYS.mode] || chooseMode(modeConnections, 'live'))
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
    manualModes: {
      test: modeConnections.test,
      live: modeConnections.live
    }
  }
}

export async function saveConektaPaymentConfig(input = {}) {
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
  const nextModes = {
    test: buildModeConnectionFromInput('test', manualInput.test, currentModes.test),
    live: buildModeConnectionFromInput('live', manualInput.live, currentModes.live)
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

async function conektaApiRequest(path, { method = 'GET', body = null, config: providedConfig = null } = {}) {
  const config = providedConfig || await getConektaPaymentConfig({ includeSecrets: true })
  if (!config.configured || !config.privateKey) {
    const error = new Error('Conekta no está configurado todavía. Guarda las llaves primero.')
    error.status = 400
    throw error
  }

  const response = await conektaFetch()(`${CONEKTA_API_BASE}${path}`, {
    method,
    headers: getConektaAuthHeaders(config),
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
    tax,
    settings: settings || null
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
      name: cleanString(sourceItems[0].name || sourceItems[0].title || label).slice(0, 250) || label,
      description: cleanString(sourceItems[0].description || description).slice(0, 250) || description,
      quantity: Number(sourceItems[0].quantity || 1) || 1,
      unit_price: toConektaAmount(row.amount)
    }]
  }

  return [{
    name: cleanString(label).slice(0, 250) || 'Pago Ristak',
    description: cleanString(description).slice(0, 250) || 'Pago Ristak',
    quantity: 1,
    unit_price: toConektaAmount(row.amount)
  }]
}

function buildCustomerInfo(row, customerId = '') {
  if (customerId) return { customer_id: customerId }
  const customerInfo = {
    name: cleanString(row.contact_name) || cleanString(parseJson(row.metadata_json, {}).contactName) || 'Cliente Ristak',
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
  }

  return updated
}

async function createOrderForPayment(row, options = {}) {
  const { payload, config } = await conektaApiRequest('/orders', {
    method: 'POST',
    body: buildOrderPayload(row, options)
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
  return mapPublicPayment(row, config, baseUrl, paymentSettings)
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

  const savePaymentSource = row.contact_id && normalizeBoolean(input.savePaymentSource, true)
  let customerId = cleanString(row.contact_conekta_customer_id || parseJson(row.metadata_json, {}).conektaCustomerId)
  let paymentSource = null
  let paymentSourceId = ''
  let config = await getConektaPaymentConfig({ includeSecrets: true, mode: row.payment_mode || '' })

  if (savePaymentSource) {
    if (!customerId) customerId = await ensureConektaCustomerForContact(row.contact_id, row)
    const sourceResult = await createPaymentSource(customerId, tokenId)
    paymentSource = sourceResult.paymentSource
    config = sourceResult.config
    paymentSourceId = cleanString(paymentSource?.id)
    await upsertConektaPaymentSource({
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
  const paymentSettings = await getPublicPaymentSettings()

  return {
    payment: mapPublicPayment(refreshed, config, baseUrl, paymentSettings),
    conektaOrderId: cleanString(result.order?.id),
    conektaChargeId: cleanString(extractCharge(result.order)?.id),
    conektaPaymentSourceId: paymentSourceId,
    status: mapOrderStatus(result.order),
    savedPaymentSource: paymentSource ? mapPaymentSource({
      ...(await db.get('SELECT * FROM conekta_payment_sources WHERE conekta_payment_source_id = ?', [paymentSourceId]) || {})
    }) : null
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
