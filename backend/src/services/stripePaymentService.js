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
const DEFAULT_PAYMENT_TIMEZONE = 'America/Mexico_City'
const STRIPE_PLAN_STATES = {
  DRAFT: 'draft',
  FIRST_PAYMENT_PENDING: 'first_payment_pending',
  WAITING_CARD_AUTHORIZATION: 'waiting_card_authorization',
  CARD_AUTHORIZED: 'card_authorized',
  INSTALLMENT_PLAN_CREATED: 'installment_plan_created',
  INSTALLMENT_PLAN_ACTIVE: 'installment_plan_active',
  CANCELLED: 'cancelled'
}
const FIRST_PAYMENT_PLAN_TRIGGERS = new Set(['first_payment', 'first_payment_saved_card'])
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
      savedMethod = await rememberStripePaymentMethodFromIntent(context.stripe, intent, row, context.config)
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
    const intent = await stripe.paymentIntents.create({
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
    })

    await updatePaymentFromIntent(intent, { stripe, config })
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
    lineItems: Array.isArray(input.invoicePayload?.items) ? input.invoicePayload.items : [],
    invoicePayload: input.invoicePayload || {},
    paymentMethodId: cleanString(input.paymentMethodId),
    source: cleanString(input.source || 'record_payment_modal_stripe_plan')
  }
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
    const firstPaymentStatus = paymentRow.status === 'paid'
      ? 'paid'
      : paymentRow.status === 'failed'
        ? 'failed'
        : paymentRow.status === 'void'
          ? 'void'
          : 'pending'

    await db.run(
      `UPDATE payment_flows
       SET first_payment_status = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND first_payment_invoice_id = ?`,
      [firstPaymentStatus, flowId, paymentRow.id]
    )
  }

  if (paymentRow.status === 'paid' && savedMethod && isFirstPlanPayment) {
    await activateStripePaymentPlan(flowId, savedMethod, config)
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
    await chargeStripePaymentRowWithSavedMethod({
      stripe,
      config,
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
  const { stripe, config } = await getStripeClient()
  const plan = validateStripePaymentPlanPayload(input)
  const savedMethod = plan.paymentMethodId
    ? await resolveStripeSavedMethod(plan.contact.id, plan.paymentMethodId, config)
    : await resolveStripeSavedMethod(plan.contact.id, '', config)
  const hasSavedCard = Boolean(savedMethod)
  const firstPaymentIsCard = plan.firstPayment.enabled && ['card', 'payment_link', 'direct_card', 'saved_card'].includes(plan.firstPayment.method)
  const firstPaymentIsOffline = plan.firstPayment.enabled && ['cash', 'bank_transfer', 'transfer', 'deposit', 'manual', 'offline', 'check', 'other'].includes(plan.firstPayment.method)

  if (!hasSavedCard && !firstPaymentIsCard) {
    const error = new Error('Para activar cobros automáticos con Stripe necesitas una tarjeta guardada o que el primer pago sea con tarjeta/link de Stripe.')
    error.status = 400
    throw error
  }

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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'partial', ?, ?, ?, ?, ?, ?, 1, ?, 0, 'stripe', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        firstPaymentLinkRequired: !hasSavedCard && firstPaymentIsCard
      })
    ]
  )

  const response = {
    flowId,
    currentState: flowState,
    paymentMode: config.mode,
    firstPaymentLink: null,
    firstPaymentPaymentId: null,
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
        hasSavedCard ? `Programado para cobrarse con ${cardLabel}` : 'Esperando que el primer pago guarde una tarjeta en Stripe.'
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

  return response
}

export async function processDueStripePaymentPlanCharges({ limit = 25 } = {}) {
  const { stripe, config } = await getStripeClient()
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
