import {
  confirmPublicRebillPayment,
  createRebillPaymentLink,
  createRebillPaymentPlan,
  deleteRebillPaymentConfig,
  getPublicRebillPayment,
  getRebillPaymentConfig,
  handleRebillWebhookEvent,
  REBILL_WEBHOOK_ENDPOINT_PATH,
  saveRebillPaymentConfig,
  testRebillPaymentConfig
} from '../services/rebillPaymentService.js'
import { getAppConfig } from '../config/database.js'
import { syncRegisteredIntegrationCronsForProvider } from '../jobs/integrationCronRegistry.js'
import { logger } from '../utils/logger.js'

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
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
  const host = forwardedHost || req.headers.host
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const protocol = forwardedProto || req.protocol || 'https'
  if (host) return `${protocol}://${host}`.replace(/\/+$/, '')

  const configured = process.env.PUBLIC_APP_URL || process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL || process.env.RENDER_EXTERNAL_URL
  return configured ? String(configured).replace(/\/+$/, '') : ''
}

function addWebhookEndpoint(items, seen, source, label, description, baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl)
  if (!normalized) return

  const url = `${normalized}${REBILL_WEBHOOK_ENDPOINT_PATH}`
  const key = url.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)

  items.push({ source, label, description, url })
}

async function buildRebillWebhookEndpoints(req) {
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

async function withRebillWebhookEndpoints(req, config) {
  return {
    ...config,
    webhookEndpointPath: REBILL_WEBHOOK_ENDPOINT_PATH,
    webhookEndpoints: await buildRebillWebhookEndpoints(req)
  }
}

function sendRebillError(res, error, fallback = 'No se pudo procesar Rebill') {
  const status = error.status || error.statusCode || 500
  res.status(status).json({
    success: false,
    error: cleanString(error.message) || fallback
  })
}

export async function getRebillConfigView(req, res) {
  try {
    const config = await getRebillPaymentConfig()
    res.json({ success: true, data: await withRebillWebhookEndpoints(req, config) })
  } catch (error) {
    logger.error(`Error obteniendo configuración Rebill: ${error.message}`)
    sendRebillError(res, error, 'No se pudo obtener la configuración de Rebill')
  }
}

export async function saveRebillConfigView(req, res) {
  try {
    const config = await saveRebillPaymentConfig(req.body || {}, {
      baseUrl: getRequestBaseUrl(req)
    })
    await syncRegisteredIntegrationCronsForProvider('rebill', { reason: 'rebill-connected' })
    res.json({ success: true, data: await withRebillWebhookEndpoints(req, config) })
  } catch (error) {
    logger.error(`Error guardando configuración Rebill: ${error.message}`)
    sendRebillError(res, error, 'No se pudo guardar la configuración de Rebill')
  }
}

export async function deleteRebillConfigView(req, res) {
  try {
    const config = await deleteRebillPaymentConfig()
    await syncRegisteredIntegrationCronsForProvider('rebill', { reason: 'rebill-disconnected' })
    res.json({ success: true, data: await withRebillWebhookEndpoints(req, config) })
  } catch (error) {
    logger.error(`Error desconectando Rebill: ${error.message}`)
    sendRebillError(res, error, 'No se pudo desconectar Rebill')
  }
}

export async function testRebillConfigView(req, res) {
  try {
    const result = await testRebillPaymentConfig(req.body && Object.keys(req.body).length > 0 ? req.body : null)
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error probando configuración Rebill: ${error.message}`)
    sendRebillError(res, error, 'No se pudo probar la conexión con Rebill')
  }
}

export async function createRebillPaymentLinkView(req, res) {
  try {
    const result = await createRebillPaymentLink(req.body || {}, {
      baseUrl: getRequestBaseUrl(req)
    })
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error creando link Rebill: ${error.message}`)
    sendRebillError(res, error, 'No se pudo crear el link de pago con Rebill')
  }
}

export async function createRebillPaymentPlanView(req, res) {
  try {
    const result = await createRebillPaymentPlan(req.body || {}, {
      baseUrl: getRequestBaseUrl(req)
    })
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error creando plan Rebill: ${error.message}`)
    sendRebillError(res, error, 'No se pudo crear el plan de pagos con Rebill')
  }
}

export async function getPublicRebillPaymentView(req, res) {
  try {
    const payment = await getPublicRebillPayment(req.params.publicPaymentId, {
      baseUrl: getRequestBaseUrl(req)
    })

    if (!payment) {
      return res.status(404).json({ success: false, error: 'Pago no encontrado' })
    }

    res.json({ success: true, data: payment })
  } catch (error) {
    logger.error(`Error obteniendo pago público Rebill: ${error.message}`)
    sendRebillError(res, error, 'No se pudo abrir el pago')
  }
}

export async function confirmPublicRebillPaymentView(req, res) {
  try {
    const result = await confirmPublicRebillPayment(req.params.publicPaymentId, req.body || {}, {
      baseUrl: getRequestBaseUrl(req)
    })
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error confirmando pago Rebill: ${error.message}`)
    sendRebillError(res, error, 'No se pudo confirmar el pago con Rebill')
  }
}

export async function rebillWebhookView(req, res) {
  try {
    const result = await handleRebillWebhookEvent(req.body || {})
    res.json({ success: true, ...result })
  } catch (error) {
    logger.error(`Webhook Rebill falló: ${error.message}`)
    sendRebillError(res, error, 'No se pudo procesar el webhook de Rebill')
  }
}
