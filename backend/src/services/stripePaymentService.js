import Stripe from 'stripe'
import { randomBytes } from 'crypto'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { decrypt, encrypt, isEncrypted } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'
import { updateSingleContactStats } from '../utils/updateContactsStats.js'

const CONFIG_KEYS = {
  enabled: 'stripe_enabled',
  mode: 'stripe_mode',
  publishableKey: 'stripe_publishable_key',
  secretKey: 'stripe_secret_key_encrypted',
  webhookSecret: 'stripe_webhook_secret_encrypted',
  defaultCurrency: 'stripe_default_currency',
  accountLabel: 'stripe_account_label'
}

const MASKED_PREFIX = '***'
const DEFAULT_CURRENCY = 'MXN'
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf',
  'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'
])

function cleanString(value) {
  return String(value || '').trim()
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

function buildPaymentUrl(baseUrl, publicPaymentId) {
  const cleanBase = cleanString(baseUrl).replace(/\/+$/, '')
  return `${cleanBase}/pay/${encodeURIComponent(publicPaymentId)}`
}

async function readRawConfig() {
  const rows = await db.all(
    `SELECT config_key, config_value FROM app_config
     WHERE config_key IN (?, ?, ?, ?, ?, ?, ?)`,
    [
      CONFIG_KEYS.enabled,
      CONFIG_KEYS.mode,
      CONFIG_KEYS.publishableKey,
      CONFIG_KEYS.secretKey,
      CONFIG_KEYS.webhookSecret,
      CONFIG_KEYS.defaultCurrency,
      CONFIG_KEYS.accountLabel
    ]
  )

  const values = {}
  for (const row of rows || []) {
    values[row.config_key] = row.config_value
  }
  return values
}

export async function getStripePaymentConfig({ includeSecrets = false } = {}) {
  const raw = await readRawConfig()
  const publishableKey = cleanString(raw[CONFIG_KEYS.publishableKey])
  const secretKey = raw[CONFIG_KEYS.secretKey] ? decryptSecret(raw[CONFIG_KEYS.secretKey]) : ''
  const webhookSecret = raw[CONFIG_KEYS.webhookSecret] ? decryptSecret(raw[CONFIG_KEYS.webhookSecret]) : ''
  const mode = normalizeMode(raw[CONFIG_KEYS.mode])
  const enabled = normalizeBoolean(raw[CONFIG_KEYS.enabled], true)
  const configured = Boolean(enabled && publishableKey && secretKey)

  return {
    enabled,
    configured,
    mode,
    defaultCurrency: normalizeCurrency(raw[CONFIG_KEYS.defaultCurrency]),
    accountLabel: cleanString(raw[CONFIG_KEYS.accountLabel]),
    publishableKey,
    hasSecretKey: Boolean(secretKey),
    secretKeyPreview: maskSecret(secretKey),
    hasWebhookSecret: Boolean(webhookSecret),
    webhookSecretPreview: maskSecret(webhookSecret),
    ...(includeSecrets ? { secretKey, webhookSecret } : {})
  }
}

export async function saveStripePaymentConfig(input = {}) {
  const current = await getStripePaymentConfig({ includeSecrets: true })
  const publishableKey = assertStripePublishableKey(input.publishableKey ?? current.publishableKey)
  const nextSecretKey = isMaskedSecret(input.secretKey)
    ? current.secretKey
    : assertStripeSecret(input.secretKey ?? current.secretKey)
  const nextWebhookSecret = isMaskedSecret(input.webhookSecret)
    ? current.webhookSecret
    : cleanString(input.webhookSecret ?? current.webhookSecret)

  await setAppConfig(CONFIG_KEYS.enabled, normalizeBoolean(input.enabled, true) ? '1' : '0')
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
  await db.run(
    `DELETE FROM app_config WHERE config_key IN (?, ?, ?, ?, ?, ?, ?)`,
    [
      CONFIG_KEYS.enabled,
      CONFIG_KEYS.mode,
      CONFIG_KEYS.publishableKey,
      CONFIG_KEYS.secretKey,
      CONFIG_KEYS.webhookSecret,
      CONFIG_KEYS.defaultCurrency,
      CONFIG_KEYS.accountLabel
    ]
  )
  return getStripePaymentConfig()
}

export async function getStripeClient() {
  const config = await getStripePaymentConfig({ includeSecrets: true })
  if (!config.configured || !config.secretKey) {
    const error = new Error('Stripe no está configurado todavía.')
    error.status = 400
    throw error
  }

  return {
    config,
    stripe: new Stripe(config.secretKey)
  }
}

export async function testStripePaymentConfig(input = null) {
  const current = await getStripePaymentConfig({ includeSecrets: true })
  const secretKey = input && !isMaskedSecret(input.secretKey)
    ? cleanString(input.secretKey)
    : current.secretKey
  const stripe = new Stripe(assertStripeSecret(secretKey))
  const balance = await stripe.balance.retrieve()
  return {
    ok: true,
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
      c.phone AS contact_phone
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
    publishableKey: config?.publishableKey || ''
  }
}

export async function createStripePaymentLink(input = {}, { baseUrl } = {}) {
  const { config } = await getStripeClient()
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
  const metadata = {
    contactName: cleanString(input.contactName),
    contactEmail: cleanString(input.email),
    contactPhone: cleanString(input.phone),
    source: cleanString(input.source || 'ristak'),
    lineItems: Array.isArray(input.lineItems) ? input.lineItems : []
  }

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, reference, title, description, date, due_date, sent_at,
      public_payment_id, payment_url, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      id,
      cleanString(input.contactId) || null,
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

export async function createStripePaymentIntent(publicPaymentId) {
  const { stripe, config } = await getStripeClient()
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

  if (row.stripe_payment_intent_id) {
    const existing = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id)
    if (['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing'].includes(existing.status)) {
      return {
        clientSecret: existing.client_secret,
        publishableKey: config.publishableKey,
        status: existing.status
      }
    }
  }

  const currency = normalizeCurrency(row.currency || config.defaultCurrency)
  const metadata = {
    ristak_payment_id: row.id,
    public_payment_id: publicPaymentId,
    contact_id: row.contact_id || ''
  }

  const intent = await stripe.paymentIntents.create({
    amount: toStripeAmount(row.amount, currency),
    currency: currency.toLowerCase(),
    automatic_payment_methods: { enabled: true },
    description: row.title || row.description || 'Pago Ristak',
    receipt_email: row.contact_email || undefined,
    metadata
  })

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
    status: intent.status
  }
}

async function updatePaymentFromIntent(intent) {
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
         payment_method = 'stripe',
         payment_provider = 'stripe',
         reference = COALESCE(?, reference),
         stripe_payment_intent_id = ?,
         stripe_charge_id = COALESCE(?, stripe_charge_id),
         paid_at = COALESCE(?, paid_at),
         date = CASE WHEN ? IS NOT NULL THEN ? ELSE date END,
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
      paidAt,
      whereValue
    ]
  )

  const row = await db.get(`SELECT contact_id FROM payments WHERE ${whereColumn} = ?`, [whereValue])
  if (row?.contact_id && nextStatus === 'paid') {
    updateSingleContactStats(row.contact_id).catch((error) => {
      logger.warn(`No se pudieron actualizar stats del contacto por pago Stripe ${whereValue}: ${error.message}`)
    })
  }

  return nextStatus
}

export async function refreshStripePaymentFromIntent(paymentIntentId) {
  const { stripe } = await getStripeClient()
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId)
  return updatePaymentFromIntent(intent)
}

export async function handleStripeWebhookEvent(rawBody, signature) {
  const { stripe, config } = await getStripeClient()
  if (!config.webhookSecret) {
    const error = new Error('Configura el webhook secret de Stripe antes de recibir eventos.')
    error.status = 400
    throw error
  }

  const event = stripe.webhooks.constructEvent(rawBody, signature, config.webhookSecret)
  const object = event?.data?.object

  if (object?.object === 'payment_intent') {
    await updatePaymentFromIntent(object)
  }

  return { received: true, type: event.type }
}
