import crypto from 'crypto'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { priceRowToApi, productRowToApi } from './localProductService.js'

const PRODUCT_POST_WEBHOOK_TIMEOUT_MS = 8000
const MAX_DELIVERY_LOG_ENTRIES = 80

const PAYMENT_PROVIDER_METADATA_PREFIXES = {
  stripe: ['stripe'],
  mercadopago: ['mercadopago'],
  conekta: ['conekta'],
  clip: ['clip'],
  rebill: ['rebill'],
  highlevel: ['highlevel', 'ghl']
}

const INTERNAL_PAYMENT_METADATA_KEYS = new Set([
  'productpostwebhookdeliveries'
])

function cleanString(value) {
  return String(value ?? '').trim()
}

function parseJson(value, fallback = {}) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function normalizePaymentProvider(value) {
  const normalized = cleanString(value).toLowerCase().replace(/[^a-z0-9]/g, '')
  if (normalized.startsWith('stripe')) return 'stripe'
  if (normalized.startsWith('mercadopago')) return 'mercadopago'
  if (normalized.startsWith('conekta')) return 'conekta'
  if (normalized.startsWith('clip')) return 'clip'
  if (normalized.startsWith('rebill')) return 'rebill'
  if (normalized.startsWith('highlevel') || normalized.startsWith('ghl')) return 'highlevel'
  if (normalized.startsWith('manual')) return 'manual'
  return normalized
}

function paymentProviderForMetadataKey(key) {
  const normalizedKey = cleanString(key).toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!normalizedKey) return ''

  for (const [provider, prefixes] of Object.entries(PAYMENT_PROVIDER_METADATA_PREFIXES)) {
    if (prefixes.some(prefix => normalizedKey.startsWith(prefix))) return provider
  }

  return ''
}

function compactWebhookValue(value, options = {}, depth = 0) {
  if (value === undefined || value === null || typeof value === 'function' || typeof value === 'symbol') {
    return undefined
  }
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const normalized = value.trim()
    return normalized || undefined
  }
  if (Array.isArray(value)) {
    if (depth >= 8) return undefined
    const normalized = value
      .map(item => compactWebhookValue(item, options, depth + 1))
      .filter(item => item !== undefined)
    return normalized.length ? normalized : undefined
  }
  if (isPlainObject(value)) {
    if (depth >= 8) return undefined
    const normalized = Object.entries(value).reduce((acc, [key, item]) => {
      const normalizedKey = cleanString(key).toLowerCase().replace(/[^a-z0-9]/g, '')
      if (!normalizedKey || options.omitInternalMetadata && INTERNAL_PAYMENT_METADATA_KEYS.has(normalizedKey)) {
        return acc
      }

      if (options.filterProviderMetadata) {
        const keyProvider = paymentProviderForMetadataKey(key)
        if (keyProvider && keyProvider !== options.paymentProvider) return acc
      }

      const compacted = compactWebhookValue(item, options, depth + 1)
      if (compacted !== undefined) acc[key] = compacted
      return acc
    }, {})
    return Object.keys(normalized).length ? normalized : undefined
  }
  const normalized = cleanString(value)
  return normalized || undefined
}

function normalizeWebhookBodyValue(value, depth = 0) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return value.trim().slice(0, 5000)
  if (Array.isArray(value)) {
    if (depth >= 4) return undefined
    return value
      .slice(0, 50)
      .map((item) => normalizeWebhookBodyValue(item, depth + 1))
      .filter((item) => item !== undefined)
  }
  if (isPlainObject(value)) {
    if (depth >= 4) return undefined
    return Object.entries(value).slice(0, 40).reduce((acc, [rawKey, rawValue]) => {
      const key = cleanString(rawKey).replace(/[\r\n]/g, '').slice(0, 120)
      const normalized = normalizeWebhookBodyValue(rawValue, depth + 1)
      if (key && normalized !== undefined) acc[key] = normalized
      return acc
    }, {})
  }
  return cleanString(value).slice(0, 5000)
}

function normalizeWebhookBodyObject(value) {
  const parsed = parseJson(value, value)
  const source = isPlainObject(parsed) ? parsed : {}

  return Object.entries(source).slice(0, 40).reduce((acc, [rawKey, rawValue]) => {
    const key = cleanString(rawKey).replace(/[\r\n]/g, '').slice(0, 120)
    const normalized = normalizeWebhookBodyValue(rawValue)
    if (key && normalized !== undefined) acc[key] = normalized
    return acc
  }, {})
}

function normalizeStatus(status = '') {
  const normalized = cleanString(status).toLowerCase()
  if (['succeeded', 'complete', 'completed', 'fulfilled', 'success'].includes(normalized)) return 'paid'
  if (['rejected', 'declined', 'error', 'failure'].includes(normalized)) return 'failed'
  if (['refund', 'charged_back', 'chargeback', 'partially_refunded'].includes(normalized)) return 'refunded'
  if (['cancelled', 'canceled', 'voided'].includes(normalized)) return 'void'
  return normalized || 'updated'
}

function eventNameForStatus(status = '') {
  const normalized = normalizeStatus(status)
  return `payment.${normalized}`
}

function hashWebhookConfig(webhook = {}) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      url: webhook.url || '',
      authorization: webhook.authorization || '',
      headers: webhook.headers || {},
      body: webhook.body || {}
    }))
    .digest('hex')
    .slice(0, 16)
}

function normalizeProductWebhooks(value) {
  const list = parseJson(value, [])
  if (!Array.isArray(list)) return []

  return list
    .map((webhook, index) => {
      if (!webhook || typeof webhook !== 'object') return null
      const url = cleanString(webhook.url)
      if (!url || webhook.enabled === false) return null
      return {
        id: cleanString(webhook.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || `webhook_${index + 1}`,
        url,
        authorization: cleanString(webhook.authorization || webhook.auth || ''),
        headers: webhook.headers && typeof webhook.headers === 'object' && !Array.isArray(webhook.headers)
          ? webhook.headers
          : {},
        body: normalizeWebhookBodyObject(webhook.body)
      }
    })
    .filter(Boolean)
}

function getLineItems(payment = {}, metadata = {}) {
  const sources = [
    payment.lineItems,
    payment.line_items,
    metadata.lineItems,
    metadata.line_items,
    metadata.items,
    metadata.invoicePayload?.items
  ]
  return sources.find(source => Array.isArray(source) && source.length > 0) ||
    sources.find(Array.isArray) ||
    []
}

function productCandidatesFromLineItem(item = {}) {
  return [
    item.localProductId,
    item.local_product_id,
    item.productId,
    item.product_id,
    item.product,
    item.ghlProductId,
    item.ghl_product_id
  ].map(cleanString).filter(Boolean)
}

function priceCandidatesFromLineItem(item = {}) {
  return [
    item.localPriceId,
    item.local_price_id,
    item.priceId,
    item.price_id,
    item.price,
    item.ghlPriceId,
    item.ghl_price_id
  ].map(cleanString).filter(Boolean)
}

async function findProductForLineItem(item = {}) {
  const productCandidates = productCandidatesFromLineItem(item)
  for (const productId of productCandidates) {
    const product = await db.get(
      'SELECT * FROM products WHERE id = ? OR ghl_product_id = ? LIMIT 1',
      [productId, productId]
    )
    if (product?.id) return { product, price: null }
  }

  const priceCandidates = priceCandidatesFromLineItem(item)
  for (const priceId of priceCandidates) {
    const price = await db.get(
      'SELECT * FROM product_prices WHERE id = ? OR ghl_price_id = ? LIMIT 1',
      [priceId, priceId]
    )
    if (!price?.product_id) continue

    const product = await db.get('SELECT * FROM products WHERE id = ? LIMIT 1', [price.product_id])
    if (product?.id) return { product, price }
  }

  return { product: null, price: null }
}

async function getProductPrices(productId) {
  const rows = await db.all(
    'SELECT * FROM product_prices WHERE product_id = ? ORDER BY name ASC, amount ASC',
    [productId]
  )
  return rows.map(priceRowToApi)
}

function sanitizeProduct(product, prices = []) {
  const apiProduct = productRowToApi(product, prices)
  const { postWebhooks, ...safeProduct } = apiProduct
  return safeProduct
}

function serializePayment(row = {}, metadata = {}) {
  const paymentProvider = normalizePaymentProvider(row.payment_provider || row.payment_method)
  const providerFields = {
    stripe: {
      stripePaymentIntentId: row.stripe_payment_intent_id,
      stripeChargeId: row.stripe_charge_id
    },
    mercadopago: {
      mercadoPagoPaymentId: row.mercadopago_payment_id,
      mercadoPagoPreferenceId: row.mercadopago_preference_id
    },
    conekta: {
      conektaOrderId: row.conekta_order_id,
      conektaChargeId: row.conekta_charge_id
    },
    clip: {
      clipPaymentId: row.clip_payment_id,
      clipReceiptNo: row.clip_receipt_no
    },
    rebill: {
      rebillPaymentId: row.rebill_payment_id,
      rebillSubscriptionId: row.rebill_subscription_id,
      rebillCustomerId: row.rebill_customer_id,
      rebillCardId: row.rebill_card_id
    }
  }
  const safeMetadata = compactWebhookValue(metadata, {
    filterProviderMetadata: true,
    omitInternalMetadata: true,
    paymentProvider
  })

  return compactWebhookValue({
    id: row.id,
    contactId: row.contact_id,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    paymentMethod: row.payment_method,
    paymentMode: row.payment_mode,
    paymentProvider: row.payment_provider || paymentProvider,
    reference: row.reference,
    title: row.title,
    description: row.description,
    date: row.date,
    dueDate: row.due_date,
    sentAt: row.sent_at,
    paidAt: row.paid_at,
    publicPaymentId: row.public_payment_id,
    paymentUrl: row.payment_url,
    invoiceId: row.ghl_invoice_id,
    invoiceNumber: row.invoice_number,
    ...(providerFields[paymentProvider] || {}),
    metadata: safeMetadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }) || {}
}

function serializeContact(row = {}) {
  if (!row?.id) return null
  return compactWebhookValue({
    id: row.id,
    ghlContactId: row.ghl_contact_id,
    name: row.name || row.full_name,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone
  }) || null
}

function buildPayload({ event, status, previousStatus, payment, contact, metadata, lineItems, lineItem, product, price, webhook }) {
  const payload = compactWebhookValue({
    event,
    eventType: 'payment',
    status,
    previousStatus,
    occurredAt: new Date().toISOString(),
    payment: serializePayment(payment, metadata),
    contact: serializeContact(contact),
    product,
    price,
    lineItem,
    lineItems,
    webhook: {
      id: webhook.id,
      productId: product.localId || product.id || ''
    },
    source: {
      app: 'ristak',
      feature: 'product_post_webhooks'
    }
  }) || {}

  return Object.keys(webhook.body || {}).length
    ? { ...webhook.body, ...payload }
    : payload
}

function buildHeaders(webhook = {}, event = '', paymentId = '') {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Ristak-Product-Webhook/1.0',
    'X-Ristak-Event': event,
    'X-Ristak-Payment-Id': paymentId,
    ...webhook.headers
  }

  if (webhook.authorization && !headers.Authorization && !headers.authorization) {
    headers.Authorization = webhook.authorization
  }

  return headers
}

async function postWebhook(webhook, payload, event, paymentId) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PRODUCT_POST_WEBHOOK_TIMEOUT_MS)

  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: buildHeaders(webhook, event, paymentId),
      body: JSON.stringify(payload),
      signal: controller.signal
    })

    const text = await response.text().catch(() => '')
    return {
      ok: response.ok,
      statusCode: response.status,
      response: text.slice(0, 500)
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function mergeDeliveryLog(paymentId, updates = {}) {
  const row = await db.get('SELECT metadata_json FROM payments WHERE id = ?', [paymentId])
  const metadata = parseJson(row?.metadata_json, {})
  const current = metadata.productPostWebhookDeliveries && typeof metadata.productPostWebhookDeliveries === 'object'
    ? metadata.productPostWebhookDeliveries
    : {}

  const mergedEntries = Object.entries({ ...current, ...updates }).slice(-MAX_DELIVERY_LOG_ENTRIES)
  metadata.productPostWebhookDeliveries = Object.fromEntries(mergedEntries)

  await db.run(
    'UPDATE payments SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [JSON.stringify(metadata), paymentId]
  )
}

export async function dispatchProductPostWebhooksForPayment(paymentId, options = {}) {
  const cleanPaymentId = cleanString(paymentId)
  if (!cleanPaymentId) return { sent: 0, skipped: true, reason: 'missing_payment_id' }

  const payment = await db.get('SELECT * FROM payments WHERE id = ?', [cleanPaymentId])
  if (!payment?.id) return { sent: 0, skipped: true, reason: 'payment_not_found' }

  const metadata = parseJson(payment.metadata_json, {})
  const lineItems = getLineItems(payment, metadata)
  if (!lineItems.length) return { sent: 0, skipped: true, reason: 'no_line_items' }

  const status = normalizeStatus(options.status || payment.status)
  const previousStatus = options.previousStatus ? normalizeStatus(options.previousStatus) : ''
  const event = options.event || eventNameForStatus(status)
  const deliveryLog = metadata.productPostWebhookDeliveries && typeof metadata.productPostWebhookDeliveries === 'object'
    ? metadata.productPostWebhookDeliveries
    : {}
  const contact = payment.contact_id
    ? await db.get('SELECT * FROM contacts WHERE id = ? LIMIT 1', [payment.contact_id])
    : null
  const deliveryUpdates = {}
  let sent = 0
  let failed = 0

  for (const [index, lineItem] of lineItems.entries()) {
    if (!lineItem || typeof lineItem !== 'object') continue

    const { product, price } = await findProductForLineItem(lineItem)
    const webhooks = normalizeProductWebhooks(product?.post_webhooks)
    if (!product?.id || !webhooks.length) continue

    const prices = await getProductPrices(product.id)
    const safeProduct = sanitizeProduct(product, prices)
    const safePrice = price ? priceRowToApi(price) : null

    for (const webhook of webhooks) {
      const configHash = hashWebhookConfig(webhook)
      const deliveryKey = `${status}:${product.id}:${webhook.id}:${configHash}`
      if (deliveryLog[deliveryKey]?.attemptedAt || deliveryUpdates[deliveryKey]?.attemptedAt) continue

      const payload = buildPayload({
        event,
        status,
        previousStatus,
        payment: { ...payment, status },
        contact,
        metadata,
        lineItems,
        lineItem: { ...lineItem, index },
        product: safeProduct,
        price: safePrice,
        webhook
      })
      const attemptedAt = new Date().toISOString()

      try {
        const result = await postWebhook(webhook, payload, event, payment.id)
        deliveryUpdates[deliveryKey] = {
          webhookId: webhook.id,
          productId: product.id,
          status,
          event,
          attemptedAt,
          ok: result.ok,
          statusCode: result.statusCode
        }

        if (result.ok) {
          sent += 1
        } else {
          failed += 1
          deliveryUpdates[deliveryKey].error = `HTTP ${result.statusCode}`
          if (result.response) deliveryUpdates[deliveryKey].response = result.response
        }
      } catch (error) {
        failed += 1
        deliveryUpdates[deliveryKey] = {
          webhookId: webhook.id,
          productId: product.id,
          status,
          event,
          attemptedAt,
          ok: false,
          error: error?.name === 'AbortError' ? 'timeout' : cleanString(error?.message || error).slice(0, 500)
        }
      }
    }
  }

  if (Object.keys(deliveryUpdates).length) {
    await mergeDeliveryLog(payment.id, deliveryUpdates)
  }

  return { sent, failed, attempted: Object.keys(deliveryUpdates).length }
}

export function dispatchProductPostWebhooksForPaymentInBackground(paymentId, options = {}) {
  Promise.resolve()
    .then(() => dispatchProductPostWebhooksForPayment(paymentId, options))
    .catch((error) => {
      logger.warn(`No se pudieron enviar webhooks POST de producto para pago ${paymentId}: ${error.message}`)
    })
}
