import { db, getAppConfig } from '../config/database.js'
import { createStripePaymentLink, createStripePaymentIntent, getStripePaymentConfig } from './stripePaymentService.js'
// Re-exporta helpers públicos de Stripe para que sitesService consuma Stripe por este
// hub de pasarelas, igual que createPaymentGateLink/Charge.
export { createStripePaymentIntent, preparePublicStripeInstallmentPlans } from './stripePaymentService.js'
import { createConektaPaymentLink, getPublicConektaPayment, getConektaPaymentConfig, createPublicConektaCardPayment } from './conektaPaymentService.js'
import { createMercadoPagoPaymentLink, getPublicMercadoPagoPayment, getMercadoPagoPaymentConfig, createPublicMercadoPagoCardPayment } from './mercadoPagoPaymentService.js'
import { createClipPaymentLink, getPublicClipPayment, getClipPaymentConfig, createPublicClipCardPayment } from './clipPaymentService.js'
import { createRebillPaymentLink, getPublicRebillPayment, getRebillPaymentConfig, confirmPublicRebillPayment } from './rebillPaymentService.js'
import {
  PAYMENT_GATEWAYS,
  MSI_INSTALLMENT_CHOICES,
  MSI_LINK_GATEWAYS,
  STRIPE_MSI_MIN_AMOUNT,
  CLIP_MSI_MIN_AMOUNT
} from '../../../shared/sites/paymentGateContract.js'

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
  const gateway = cleanString(value, 80).toLowerCase()
  if (PAYMENT_GATEWAYS.has(gateway)) return gateway
  const compact = gateway
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
  if (compact.startsWith('clip')) return 'clip'
  if (compact.startsWith('rebill')) return 'rebill'
  if (compact.startsWith('conekta')) return 'conekta'
  if (compact.startsWith('mercadopago') || compact === 'mp') return 'mercadopago'
  if (compact.startsWith('stripe')) return 'stripe'
  return 'stripe'
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

// Meses sin intereses: Conekta, Mercado Pago y CLIP soportan diferido a meses en
// el cobro simple. Stripe se valida aparte porque lo muestra dentro del Payment
// Element y solo aplica en MXN con monto minimo.
// Constantes en el contrato compartido (shared/sites/paymentGateContract.js) para
// que backend, runtime publicado y preview del editor usen la misma lista.
const MSI_GATEWAYS = MSI_LINK_GATEWAYS

// Modo por bloque SEGURO: un bloque solo puede FORZAR 'test' (para probar sin cobrar
// aunque la plataforma esté en live). Nunca puede forzar 'live'. Cualquier otro valor
// = 'inherit' (hereda el modo global de la plataforma). Esto hace imposible un cobro
// real por accidente desde un bloque marcado como prueba.
function normalizeGateMode(value) {
  return cleanString(value, 20).toLowerCase() === 'test' ? 'test' : 'inherit'
}

function normalizeGateMsi(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const enabled = normalizeBoolean(source.enabled || source.required)
  const requested = Number(source.maxInstallments || source.max_installments || source.months || 0)
  if (!enabled || !Number.isFinite(requested) || requested <= 1) {
    return { enabled: false, maxInstallments: 0 }
  }
  const allowed = MSI_INSTALLMENT_CHOICES.filter(months => months <= requested)
  const maxInstallments = allowed.length ? allowed[allowed.length - 1] : MSI_INSTALLMENT_CHOICES[0]
  return { enabled: true, maxInstallments }
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
    ),
    mode: normalizeGateMode(source.mode),
    msi: normalizeGateMsi(source.msi || source.installments)
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

  // Modo forzado por el bloque: '' = hereda el global (comportamiento por defecto),
  // 'test' = fuerza modo prueba. Nunca puede forzar live (lo garantiza normalizeGateMode).
  const forcedMode = config.mode === 'test' ? 'test' : ''

  // MSI: Conekta / Mercado Pago lo aceptan siempre (normalizeConektaInstallmentOptions /
  // normalizeMercadoPagoInstallmentOptions). Stripe también lo soporta vía Payment Element,
  // pero SOLO en MXN y con monto >= 300 (STRIPE_INSTALLMENT_MIN_AMOUNT); fuera de eso su
  // normalizador lanza error. Guardamos ese caso para que un bloque mal configurado NUNCA
  // rompa el cobro: si no aplica, simplemente se cobra de contado.
  const msiRequested = config.msi?.enabled && config.msi.maxInstallments > 1
  const stripeMsiEligible = config.gateway === 'stripe'
    && String(config.currency || '').toUpperCase() === 'MXN'
    && Number(config.amount) >= STRIPE_MSI_MIN_AMOUNT
  const clipMsiEligible = config.gateway === 'clip'
    && String(config.currency || '').toUpperCase() === 'MXN'
    && Number(config.amount) >= CLIP_MSI_MIN_AMOUNT
  const installments = msiRequested && (
    (MSI_GATEWAYS.has(config.gateway) && config.gateway !== 'clip') ||
    stripeMsiEligible ||
    clipMsiEligible
  )
    ? { enabled: true, maxInstallments: config.msi.maxInstallments }
    : null

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
    ...(installments ? { installments } : {}),
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
        productName: config.productName,
        mode: config.mode,
        ...(installments ? { msi: installments } : {})
      }
    }
  }

  const paymentBaseUrl = await resolvePaymentBaseUrl(baseUrl)

  if (config.gateway === 'conekta') {
    return createConektaPaymentLink(payload, { baseUrl: paymentBaseUrl, mode: forcedMode })
  }
  if (config.gateway === 'mercadopago') {
    return createMercadoPagoPaymentLink(payload, { baseUrl: paymentBaseUrl, mode: forcedMode })
  }
  if (config.gateway === 'clip') {
    return createClipPaymentLink(payload, { baseUrl: paymentBaseUrl, mode: forcedMode })
  }
  if (config.gateway === 'rebill') {
    return createRebillPaymentLink(payload, { baseUrl: paymentBaseUrl, mode: forcedMode })
  }
  return createStripePaymentLink(payload, { baseUrl: paymentBaseUrl, mode: forcedMode })
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

// Descriptor para MONTAR el checkout embebido inline en la página publicada.
// Devuelve exactamente lo que el runtime necesita para arrancar el SDK del proveedor
// (Stripe Elements necesita clientSecret; Conekta/MP solo la llave pública + MSI).
// El monto/estado siguen viniendo del registro persistido — nunca del cliente.
export async function getPaymentGateCheckoutDescriptor(publicPaymentId, { baseUrl = '' } = {}) {
  const status = await getPaymentGateStatus(publicPaymentId)
  if (!status) return null

  const base = {
    publicPaymentId: status.publicPaymentId,
    provider: status.provider,
    status: status.status,
    paid: status.paid,
    amount: status.amount,
    currency: status.currency
  }

  // Si ya está pagado no montamos SDK: el runtime salta directo a la acción de éxito.
  if (status.paid) return base

  if (status.provider === 'stripe') {
    // El checkout de sitio SI guarda la tarjeta (Stripe activa setup_future_usage
    // 'off_session' al haber Customer) para poder cobrar despues off-session, igual
    // que un enlace de pago de primera vez. El runtime embebido declara
    // setupFutureUsage:'off_session' en Stripe Elements cuando se captura identidad,
    // para que cliente y servidor coincidan (flujo diferido mode:'payment').
    const intent = await createStripePaymentIntent(publicPaymentId, {})
    return {
      ...base,
      provider: 'stripe',
      publishableKey: intent?.publishableKey || '',
      clientSecret: intent?.clientSecret || '',
      status: intent?.status || base.status
    }
  }

  if (status.provider === 'conekta') {
    const payment = await getPublicConektaPayment(publicPaymentId, { baseUrl })
    return {
      ...base,
      provider: 'conekta',
      publicKey: payment?.publicKey || '',
      paymentMode: payment?.paymentMode || '',
      installments: payment?.conektaInstallments || null
    }
  }

  if (status.provider === 'mercadopago') {
    const payment = await getPublicMercadoPagoPayment(publicPaymentId, { baseUrl })
    return {
      ...base,
      provider: 'mercadopago',
      publicKey: payment?.publicKey || '',
      paymentMode: payment?.paymentMode || '',
      installments: payment?.mercadoPagoInstallments || null
    }
  }

  if (status.provider === 'clip') {
    const payment = await getPublicClipPayment(publicPaymentId, { baseUrl })
    return {
      ...base,
      provider: 'clip',
      apiKey: payment?.apiKey || '',
      paymentMode: payment?.paymentMode || '',
      pendingAction: payment?.pendingAction || null
    }
  }

  if (status.provider === 'rebill') {
    const payment = await getPublicRebillPayment(publicPaymentId, { baseUrl })
    return {
      ...base,
      provider: 'rebill',
      publicKey: payment?.publicKey || '',
      paymentMode: payment?.paymentMode || '',
      instantProduct: payment?.instantProduct || null,
      customerInformation: payment?.customerInformation || null
    }
  }

  return base
}

// Llaves PÚBLICAS del proveedor para montar el checkout SIN crear ningún registro de pago.
// Así abrir la página no genera pagos incompletos: la fila se crea solo al cobrar (pay).
export async function getPaymentGateCheckoutKeys(gateway, mode = '') {
  const g = normalizeGateway(gateway)
  if (g === 'conekta') {
    const config = await getConektaPaymentConfig({ mode })
    return { provider: 'conekta', publicKey: config.publicKey || '', paymentMode: config.mode || '', configured: Boolean(config.configured) }
  }
  if (g === 'mercadopago') {
    const config = await getMercadoPagoPaymentConfig({ mode })
    return { provider: 'mercadopago', publicKey: config.publicKey || '', paymentMode: config.mode || '', configured: Boolean(config.configured) }
  }
  if (g === 'clip') {
    const config = await getClipPaymentConfig({ includeSecrets: true, mode })
    return { provider: 'clip', apiKey: config.apiKey || '', paymentMode: config.mode || '', configured: Boolean(config.configured) }
  }
  if (g === 'rebill') {
    const config = await getRebillPaymentConfig({ mode })
    return { provider: 'rebill', publicKey: config.publicKey || '', paymentMode: config.mode || '', configured: Boolean(config.configured) }
  }
  const config = await getStripePaymentConfig({ mode })
  return { provider: 'stripe', publishableKey: config.publishableKey || '', paymentMode: config.mode || '', configured: Boolean(config.configured) }
}

// Cobra un pago ya creado (fila existente). Stripe: crea el PaymentIntent y devuelve el
// clientSecret para confirmar del lado del cliente. Conekta/MP: cobran con el token recibido.
export async function createPaymentGateCharge(publicPaymentId, gateway, chargeInput = {}, { baseUrl = '' } = {}) {
  const g = normalizeGateway(gateway)
  if (g === 'stripe') {
    // El checkout de sitio SI guarda la tarjeta (Stripe activa setup_future_usage
    // 'off_session' al haber Customer) para poder cobrar despues off-session, igual
    // que un enlace de pago de primera vez. El runtime embebido declara
    // setupFutureUsage:'off_session' en Stripe Elements cuando se captura identidad,
    // para que cliente y servidor coincidan (flujo diferido mode:'payment').
    const intent = await createStripePaymentIntent(publicPaymentId, {})
    return {
      provider: 'stripe',
      publicPaymentId,
      clientSecret: intent?.clientSecret || '',
      publishableKey: intent?.publishableKey || '',
      status: intent?.status || 'pending'
    }
  }
  if (g === 'conekta') {
    const res = await createPublicConektaCardPayment(publicPaymentId, {
      tokenId: chargeInput.tokenId,
      installments: chargeInput.installments
    }, { baseUrl })
    return { provider: 'conekta', publicPaymentId, status: cleanString(res?.payment?.status || res?.status) }
  }
  if (g === 'mercadopago') {
    const res = await createPublicMercadoPagoCardPayment(publicPaymentId, {
      token: chargeInput.token,
      paymentMethodId: chargeInput.paymentMethodId,
      issuerId: chargeInput.issuerId,
      installments: chargeInput.installments,
      payer: chargeInput.payer
    }, { baseUrl })
    return { provider: 'mercadopago', publicPaymentId, status: cleanString(res?.payment?.status || res?.status), statusDetail: cleanString(res?.statusDetail) }
  }
  if (g === 'clip') {
    const payer = chargeInput.payer && typeof chargeInput.payer === 'object' ? chargeInput.payer : {}
    const res = await createPublicClipCardPayment(publicPaymentId, {
      tokenId: chargeInput.tokenId || chargeInput.token || chargeInput.cardTokenId,
      email: cleanString(chargeInput.email || payer.email),
      phone: cleanString(chargeInput.phone || payer.phone),
      customerName: cleanString(chargeInput.customerName || payer.name || payer.fullName),
      installments: chargeInput.installments
    }, { baseUrl })
    return {
      provider: 'clip',
      publicPaymentId,
      status: cleanString(res?.payment?.status || res?.status),
      statusDetail: cleanString(res?.statusDetail),
      clipPaymentId: cleanString(res?.clipPaymentId),
      pendingAction: res?.pendingAction || null
    }
  }
  if (g === 'rebill') {
    const res = await confirmPublicRebillPayment(publicPaymentId, {
      rebillPaymentId: chargeInput.rebillPaymentId || chargeInput.rebill_payment_id || chargeInput.paymentId || chargeInput.payment_id
    }, { baseUrl })
    return {
      provider: 'rebill',
      publicPaymentId,
      status: cleanString(res?.payment?.status || res?.status),
      statusDetail: res?.statusDetail || null,
      rebillPaymentId: cleanString(res?.rebillPaymentId)
    }
  }
  const error = new Error('Pasarela no soportada.')
  error.status = 400
  throw error
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
