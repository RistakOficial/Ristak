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
const isPostgresRuntime = Boolean(process.env.DATABASE_URL)
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf',
  'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'
])

function cleanString(value) {
  return String(value || '').trim()
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
    publishableKey: config?.publishableKey || ''
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

async function ensureStripeCustomerForContact(stripe, contactId, fallback = {}) {
  const contact = await getStripeContact(contactId)
  if (!contact) return null

  const existingCustomerId = cleanString(contact.stripe_customer_id)
  if (existingCustomerId) {
    try {
      await stripe.customers.retrieve(existingCustomerId)
      return existingCustomerId
    } catch (error) {
      if (error?.statusCode !== 404) throw error
    }
  }

  const customer = await stripe.customers.create({
    name: buildContactName(contact, fallback),
    email: cleanString(contact.email || fallback.email || fallback.contactEmail) || undefined,
    phone: cleanString(contact.phone || fallback.phone || fallback.contactPhone) || undefined,
    metadata: {
      ristak_contact_id: contact.id
    }
  })

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

async function upsertStripePaymentMethod({ stripe, contactId, customerId, paymentMethodId, mode, makeDefault = true }) {
  const cleanPaymentMethodId = cleanString(paymentMethodId)
  const cleanCustomerId = extractStripeObjectId(customerId)
  if (!stripe || !cleanPaymentMethodId || !cleanCustomerId) return null

  const paymentMethod = await stripe.paymentMethods.retrieve(cleanPaymentMethodId)
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

async function rememberStripePaymentMethodFromIntent(stripe, intent, paymentRow, config) {
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
    mode: config?.mode
  })
}

export async function createStripePaymentLink(input = {}, { baseUrl } = {}) {
  const { stripe, config } = await getStripeClient()
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
    ? await ensureStripeCustomerForContact(stripe, contactId, input)
    : null
  const metadata = {
    contactName: cleanString(input.contactName),
    contactEmail: cleanString(input.email),
    contactPhone: cleanString(input.phone),
    stripeCustomerId: stripeCustomerId || '',
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

  const savePaymentMethod = normalizeBoolean(options.savePaymentMethod, true)
  const stripeCustomerId = row.contact_id
    ? await ensureStripeCustomerForContact(stripe, row.contact_id, {
        contactName: row.contact_name,
        contactEmail: row.contact_email,
        contactPhone: row.contact_phone
      })
    : cleanString(row.contact_stripe_customer_id)

  if (row.stripe_payment_intent_id) {
    const existing = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id)
    if (['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing'].includes(existing.status)) {
      if (savePaymentMethod && stripeCustomerId && existing.status === 'requires_payment_method') {
        const updated = await stripe.paymentIntents.update(existing.id, {
          customer: stripeCustomerId,
          setup_future_usage: 'off_session',
          metadata: {
            ...existing.metadata,
            save_payment_method: '1',
            stripe_customer_id: stripeCustomerId,
            payment_method_authorization: 'public_invoice_payment'
          }
        })
        return {
          clientSecret: updated.client_secret,
          publishableKey: config.publishableKey,
          status: updated.status
        }
      }

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
    contact_id: row.contact_id || '',
    stripe_customer_id: stripeCustomerId || '',
    save_payment_method: savePaymentMethod && stripeCustomerId ? '1' : '0',
    payment_method_authorization: savePaymentMethod && stripeCustomerId ? 'public_invoice_payment' : ''
  }

  const intent = await stripe.paymentIntents.create({
    amount: toStripeAmount(row.amount, currency),
    currency: currency.toLowerCase(),
    automatic_payment_methods: { enabled: true },
    ...(stripeCustomerId ? { customer: stripeCustomerId } : {}),
    ...(savePaymentMethod && stripeCustomerId ? { setup_future_usage: 'off_session' } : {}),
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
    `SELECT p.contact_id, c.stripe_customer_id
     FROM payments p
     LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE p.${whereColumn} = ?`,
    [whereValue]
  )
  if (row?.contact_id && nextStatus === 'paid') {
    updateSingleContactStats(row.contact_id).catch((error) => {
      logger.warn(`No se pudieron actualizar stats del contacto por pago Stripe ${whereValue}: ${error.message}`)
    })

    try {
      const context = stripeContext || await getStripeClient()
      await rememberStripePaymentMethodFromIntent(context.stripe, intent, row, context.config)
    } catch (error) {
      logger.warn(`No se pudo guardar la tarjeta Stripe del pago ${whereValue}: ${error.message}`)
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
  const { stripe, config } = await getStripeClient()
  const contact = await getStripeContact(contactId)
  if (!contact) {
    const error = new Error('Contacto no encontrado.')
    error.status = 404
    throw error
  }

  const stripeCustomerId = cleanString(contact.stripe_customer_id)
  if (!stripeCustomerId) return []

  try {
    const methods = await stripe.paymentMethods.list({
      customer: stripeCustomerId,
      type: 'card',
      limit: 20
    })

    for (const method of methods.data || []) {
      await upsertStripePaymentMethod({
        stripe,
        contactId: contact.id,
        customerId: stripeCustomerId,
        paymentMethodId: method.id,
        mode: config.mode,
        makeDefault: false
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

export async function createStripeSavedCardPayment(input = {}) {
  const { stripe, config } = await getStripeClient()
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
    const intent = await stripe.paymentIntents.create({
      amount: toStripeAmount(amount, currency),
      currency: currency.toLowerCase(),
      customer: savedMethod.stripe_customer_id,
      payment_method: savedMethod.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      payment_method_types: ['card'],
      description,
      receipt_email: cleanString(input.email || savedMethod.contact_email) || undefined,
      metadata: {
        ristak_payment_id: id,
        contact_id: contactId,
        stripe_customer_id: savedMethod.stripe_customer_id,
        stripe_payment_method_id: savedMethod.stripe_payment_method_id,
        source: 'ristak_saved_card'
      }
    })

    await updatePaymentFromIntent(intent, { stripe, config })
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
      [failedStatus, intent?.id || null, intent?.id || null, id]
    )

    if (error?.code === 'authentication_required' || intent?.status === 'requires_action') {
      const authError = new Error('La tarjeta requiere autenticación del cliente. Envíale un link de Stripe para que confirme el pago.')
      authError.status = 402
      throw authError
    }

    throw error
  }

  const row = await db.get('SELECT * FROM payments WHERE id = ?', [id])
  return { payment: mapSavedCardPayment(row) }
}

export async function refreshStripePaymentFromIntent(paymentIntentId) {
  const context = await getStripeClient()
  const { stripe } = context
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId)
  return updatePaymentFromIntent(intent, context)
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
    await updatePaymentFromIntent(object, { stripe, config })
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
