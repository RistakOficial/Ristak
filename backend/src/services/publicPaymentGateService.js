import { db, getAppConfig } from '../config/database.js'
import { createStripePaymentLink } from './stripePaymentService.js'
import { createConektaPaymentLink } from './conektaPaymentService.js'
import { createMercadoPagoPaymentLink } from './mercadoPagoPaymentService.js'

const PAYMENT_GATEWAYS = new Set(['stripe', 'conekta', 'mercadopago'])
const PAID_STATUSES = new Set(['paid', 'succeeded', 'success', 'completed', 'complete', 'fulfilled'])

function cleanString(value, maxLength = 300) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function normalizePublicBaseUrl(value = '') {
  const raw = cleanString(value, 2000).replace(/\/+$/, '')
  if (!raw) return ''

  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    if (!['http:', 'https:'].includes(parsed.protocol)) return ''
    if (!parsed.hostname) return ''
    return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

async function resolvePaymentBaseUrl(fallbackBaseUrl = '') {
  const envBaseUrl = normalizePublicBaseUrl(
    process.env.PUBLIC_APP_URL ||
    process.env.APP_PUBLIC_URL ||
    process.env.FRONTEND_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    process.env.PUBLIC_URL ||
    process.env.APP_URL
  )
  if (envBaseUrl) return envBaseUrl

  const appDomain = normalizePublicBaseUrl(await getAppConfig('sites_app_domain'))
  const appDomainVerified = ['1', 'true', 'yes'].includes(
    cleanString(await getAppConfig('sites_app_domain_verified'), 20).toLowerCase()
  )
  if (appDomain && appDomainVerified) return appDomain

  return normalizePublicBaseUrl(fallbackBaseUrl)
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

function normalizeBoolean(value) {
  if (value === true || value === 1) return true
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    return ['1', 'true', 'yes', 'si', 'sí', 'on', 'enabled'].includes(text)
  }
  return false
}

function normalizeGateway(value) {
  const gateway = cleanString(value, 40).toLowerCase()
  return PAYMENT_GATEWAYS.has(gateway) ? gateway : 'stripe'
}

function normalizeCurrency(value) {
  const currency = cleanString(value || 'MXN', 3).toUpperCase()
  return /^[A-Z]{3}$/.test(currency) ? currency : 'MXN'
}

function normalizeAmount(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return 0
  return Math.round(amount * 100) / 100
}

export function normalizePaymentGateConfig(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value.paymentGate && typeof value.paymentGate === 'object'
      ? value.paymentGate
      : value.bookingPayment && typeof value.bookingPayment === 'object'
        ? value.bookingPayment
        : value
    : {}

  const amount = normalizeAmount(source.amount || source.price || source.total)
  const productName = cleanString(
    source.productName ||
    source.product_name ||
    source.title ||
    source.name ||
    'Pago requerido',
    140
  )

  return {
    enabled: normalizeBoolean(source.enabled || source.required),
    gateway: normalizeGateway(source.gateway || source.provider),
    amount,
    currency: normalizeCurrency(source.currency),
    productName,
    description: cleanString(source.description || productName || 'Pago requerido', 300),
    buttonText: cleanString(source.buttonText || source.button_text || 'Completar pago', 80) || 'Completar pago',
    pendingMessage: cleanString(
      source.pendingMessage ||
      source.pending_message ||
      'Para continuar, completa el pago y deja esta página abierta.',
      220
    ),
    paidMessage: cleanString(
      source.paidMessage ||
      source.paid_message ||
      'Pago confirmado. Continuamos con tu solicitud.',
      220
    )
  }
}

export function isPaymentGateEnabled(config = {}) {
  const normalized = normalizePaymentGateConfig(config)
  return Boolean(normalized.enabled && normalized.amount > 0 && PAYMENT_GATEWAYS.has(normalized.gateway))
}

export async function createPaymentGateLink(configInput = {}, {
  baseUrl = '',
  contact = {},
  metadata = {},
  source = 'ristak_payment_gate'
} = {}) {
  const config = normalizePaymentGateConfig(configInput)
  if (!isPaymentGateEnabled(config)) {
    const error = new Error('Configura un monto mayor a 0 y una pasarela para solicitar cobro.')
    error.status = 400
    throw error
  }

  const payload = {
    amount: config.amount,
    currency: config.currency,
    title: config.productName,
    description: config.description || config.productName,
    contactId: cleanString(contact.contactId || contact.id, 160),
    contactName: cleanString(contact.contactName || contact.name || contact.fullName, 180),
    email: cleanString(contact.email, 180),
    phone: cleanString(contact.phone, 80),
    source,
    lineItems: [
      {
        name: config.productName,
        description: config.description,
        amount: config.amount,
        quantity: 1,
        currency: config.currency
      }
    ],
    metadata: {
      ...(metadata && typeof metadata === 'object' ? metadata : {}),
      paymentGate: {
        ...(metadata?.paymentGate && typeof metadata.paymentGate === 'object' ? metadata.paymentGate : {}),
        source,
        gateway: config.gateway,
        amount: config.amount,
        currency: config.currency,
        productName: config.productName
      }
    }
  }

  const paymentBaseUrl = await resolvePaymentBaseUrl(baseUrl)

  if (config.gateway === 'conekta') {
    return createConektaPaymentLink(payload, { baseUrl: paymentBaseUrl })
  }
  if (config.gateway === 'mercadopago') {
    return createMercadoPagoPaymentLink(payload, { baseUrl: paymentBaseUrl })
  }
  return createStripePaymentLink(payload, { baseUrl: paymentBaseUrl })
}

export async function getPaymentGateStatus(publicPaymentId) {
  const id = cleanString(publicPaymentId, 160)
  if (!id) return null

  const row = await db.get(
    `SELECT id, amount, currency, status, payment_provider, public_payment_id, payment_url,
            paid_at, metadata_json, updated_at, created_at
       FROM payments
      WHERE public_payment_id = ?
      LIMIT 1`,
    [id]
  )
  if (!row) return null

  const status = cleanString(row.status, 40).toLowerCase()
  const metadata = parseJson(row.metadata_json, {})
  return {
    id: row.id,
    publicPaymentId: row.public_payment_id,
    paymentUrl: row.payment_url || '',
    provider: row.payment_provider || '',
    amount: Number(row.amount) || 0,
    currency: row.currency || 'MXN',
    status,
    paid: PAID_STATUSES.has(status) || Boolean(row.paid_at),
    paidAt: row.paid_at || null,
    metadata,
    updatedAt: row.updated_at || row.created_at || null
  }
}

export function paymentGateMatches(status, expected = {}) {
  if (!status) return false
  const gate = status.metadata?.paymentGate && typeof status.metadata.paymentGate === 'object'
    ? status.metadata.paymentGate
    : {}

  for (const [key, value] of Object.entries(expected || {})) {
    const cleanExpected = cleanString(value, 220)
    if (!cleanExpected) continue
    if (cleanString(gate[key], 220) !== cleanExpected && cleanString(status.metadata?.[key], 220) !== cleanExpected) {
      return false
    }
  }

  return true
}

export async function assertPaidPaymentGate(publicPaymentId, expected = {}) {
  const status = await getPaymentGateStatus(publicPaymentId)
  return Boolean(status?.paid && paymentGateMatches(status, expected)) ? status : null
}
