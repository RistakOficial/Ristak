import {
  createMercadoPagoOAuthUrl,
  createMercadoPagoPaymentLink,
  createMercadoPagoPaymentPlan,
  createPublicMercadoPagoCardPayment,
  deleteMercadoPagoPaymentConfig,
  ensurePublicMercadoPagoPreference,
  getMercadoPagoPaymentConfig,
  getPublicMercadoPagoPayment,
  handleMercadoPagoWebhookEvent,
  setMercadoPagoActiveMode,
  syncMercadoPagoFromCentral,
  testMercadoPagoPaymentConfig
} from '../services/mercadoPagoPaymentService.js'
import { getAppConfig } from '../config/database.js'
import { logger } from '../utils/logger.js'

const MERCADOPAGO_WEBHOOK_PATH = '/api/mercadopago/webhook'

function cleanString(value) {
  return String(value || '').trim()
}

function normalizeBaseUrl(value) {
  const clean = cleanString(value).replace(/\/+$/, '')
  if (!clean) return ''

  const withProtocol = /^https?:\/\//i.test(clean) ? clean : `https://${clean}`
  try {
    const parsed = new URL(withProtocol)
    return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function getRequestBaseUrl(req) {
  const configured = process.env.PUBLIC_APP_URL || process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL || process.env.RENDER_EXTERNAL_URL
  if (configured) return String(configured).replace(/\/+$/, '')

  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
  const host = forwardedHost || req.headers.host
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const protocol = forwardedProto || req.protocol || 'https'
  return `${protocol}://${host}`
}

function addWebhookEndpoint(items, seen, source, label, description, baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl)
  if (!normalized) return

  const url = `${normalized}${MERCADOPAGO_WEBHOOK_PATH}`
  const key = url.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)

  items.push({ source, label, description, url })
}

async function buildMercadoPagoWebhookEndpoints(req) {
  const endpoints = []
  const seen = new Set()

  addWebhookEndpoint(endpoints, seen, 'render', 'Render', 'Endpoint del servicio publicado en Render.', process.env.RENDER_EXTERNAL_URL)
  addWebhookEndpoint(
    endpoints,
    seen,
    'configured',
    'URL pública configurada',
    'Endpoint tomado de la URL pública configurada para esta instalación.',
    process.env.PUBLIC_APP_URL || process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL || process.env.APP_URL
  )

  const appDomain = cleanString(await getAppConfig('sites_app_domain'))
  const appDomainVerified = ['1', 'true', 'yes'].includes(cleanString(await getAppConfig('sites_app_domain_verified')).toLowerCase())
  if (appDomain && appDomainVerified) {
    addWebhookEndpoint(endpoints, seen, 'app_domain', 'Dominio de la app', 'Endpoint del dominio conectado para abrir Ristak.', appDomain)
  }

  addWebhookEndpoint(endpoints, seen, 'current_request', 'URL detectada', 'Endpoint detectado desde esta sesión actual.', getRequestBaseUrl(req))
  return endpoints
}

async function withMercadoPagoWebhookEndpoints(req, config) {
  return {
    ...config,
    webhookEndpointPath: MERCADOPAGO_WEBHOOK_PATH,
    webhookEndpoints: await buildMercadoPagoWebhookEndpoints(req)
  }
}

function sendMercadoPagoError(res, error, fallback = 'No se pudo procesar Mercado Pago') {
  const status = error.status || error.statusCode || 500
  res.status(status).json({
    success: false,
    error: error.message || fallback
  })
}

export async function getMercadoPagoConfigView(req, res) {
  try {
    const config = await getMercadoPagoPaymentConfig()
    res.json({ success: true, data: await withMercadoPagoWebhookEndpoints(req, config) })
  } catch (error) {
    logger.error(`Error obteniendo configuración Mercado Pago: ${error.message}`)
    sendMercadoPagoError(res, error, 'No se pudo obtener la configuración de Mercado Pago')
  }
}

export async function createMercadoPagoConnectUrlView(req, res) {
  try {
    const requestBaseUrl = getRequestBaseUrl(req)
    const result = await createMercadoPagoOAuthUrl({
      mode: req.body?.mode || req.query?.mode || 'test',
      appUrl: req.body?.appUrl || req.body?.app_url || req.headers.origin || requestBaseUrl,
      returnPath: req.body?.returnPath || '/settings/payments/mercadopago'
    })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error creando URL OAuth Mercado Pago: ${error.message}`)
    sendMercadoPagoError(res, error, 'No se pudo iniciar Mercado Pago')
  }
}

export async function syncMercadoPagoConnectView(req, res) {
  try {
    const config = await syncMercadoPagoFromCentral({
      handoffToken: req.body?.handoffToken || req.body?.handoff_token || ''
    })
    res.json({ success: true, data: await withMercadoPagoWebhookEndpoints(req, config) })
  } catch (error) {
    logger.error(`Error sincronizando Mercado Pago central: ${error.message}`)
    sendMercadoPagoError(res, error, 'No se pudo sincronizar Mercado Pago')
  }
}

export async function setMercadoPagoModeView(req, res) {
  try {
    const config = await setMercadoPagoActiveMode(req.body?.mode || 'live')
    res.json({ success: true, data: await withMercadoPagoWebhookEndpoints(req, config) })
  } catch (error) {
    logger.error(`Error cambiando modo Mercado Pago: ${error.message}`)
    sendMercadoPagoError(res, error, 'No se pudo cambiar el modo de Mercado Pago')
  }
}

export async function deleteMercadoPagoConfigView(req, res) {
  try {
    const config = await deleteMercadoPagoPaymentConfig()
    res.json({ success: true, data: await withMercadoPagoWebhookEndpoints(req, config) })
  } catch (error) {
    logger.error(`Error desconectando Mercado Pago: ${error.message}`)
    sendMercadoPagoError(res, error, 'No se pudo desconectar Mercado Pago')
  }
}

export async function testMercadoPagoConfigView(req, res) {
  try {
    const result = await testMercadoPagoPaymentConfig()
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error probando Mercado Pago: ${error.message}`)
    sendMercadoPagoError(res, error, 'No se pudo probar la conexión con Mercado Pago')
  }
}

export async function createMercadoPagoPaymentLinkView(req, res) {
  try {
    const result = await createMercadoPagoPaymentLink(req.body || {}, {
      baseUrl: getRequestBaseUrl(req)
    })
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error creando link Mercado Pago: ${error.message}`)
    sendMercadoPagoError(res, error, 'No se pudo crear el link de pago con Mercado Pago')
  }
}

export async function createMercadoPagoPaymentPlanView(req, res) {
  try {
    const result = await createMercadoPagoPaymentPlan(req.body || {}, {
      baseUrl: getRequestBaseUrl(req)
    })
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error creando plan Mercado Pago: ${error.message}`)
    sendMercadoPagoError(res, error, 'No se pudo crear el plan de pagos con Mercado Pago')
  }
}

export async function getPublicMercadoPagoPaymentView(req, res) {
  try {
    const payment = await getPublicMercadoPagoPayment(req.params.publicPaymentId, {
      baseUrl: getRequestBaseUrl(req)
    })

    if (!payment) {
      return res.status(404).json({ success: false, error: 'Pago no encontrado' })
    }

    res.json({ success: true, data: payment })
  } catch (error) {
    logger.error(`Error obteniendo pago público Mercado Pago: ${error.message}`)
    sendMercadoPagoError(res, error, 'No se pudo abrir el pago')
  }
}

export async function ensurePublicMercadoPagoPreferenceView(req, res) {
  try {
    const result = await ensurePublicMercadoPagoPreference(req.params.publicPaymentId, {
      baseUrl: getRequestBaseUrl(req)
    })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error preparando preferencia Mercado Pago: ${error.message}`)
    sendMercadoPagoError(res, error, 'No se pudo preparar el pago')
  }
}

export async function createPublicMercadoPagoCardPaymentView(req, res) {
  try {
    const result = await createPublicMercadoPagoCardPayment(req.params.publicPaymentId, req.body || {}, {
      baseUrl: getRequestBaseUrl(req)
    })
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error cobrando tarjeta Mercado Pago: ${error.message}`)
    sendMercadoPagoError(res, error, 'No se pudo cobrar la tarjeta con Mercado Pago')
  }
}

export async function mercadoPagoWebhookView(req, res) {
  try {
    const result = await handleMercadoPagoWebhookEvent(req.body || {}, req.headers || {}, req.query || {})
    res.json(result)
  } catch (error) {
    logger.error(`Webhook Mercado Pago falló: ${error.message}`)
    sendMercadoPagoError(res, error, 'No se pudo procesar el webhook de Mercado Pago')
  }
}
