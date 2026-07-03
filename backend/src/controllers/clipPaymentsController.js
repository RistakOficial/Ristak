import {
  CLIP_WEBHOOK_ENDPOINT_PATH,
  createClipPaymentLink,
  createPublicClipCardPayment,
  deleteClipPaymentConfig,
  getClipPaymentConfig,
  getPublicClipPayment,
  handleClipWebhookEvent,
  refreshPublicClipPayment,
  saveClipPaymentConfig,
  testClipPaymentConfig
} from '../services/clipPaymentService.js'
import { getAppConfig } from '../config/database.js'
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

  const url = `${normalized}${CLIP_WEBHOOK_ENDPOINT_PATH}`
  const key = url.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)

  items.push({ source, label, description, url })
}

async function buildClipWebhookEndpoints(req) {
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

async function withClipWebhookEndpoints(req, config) {
  return {
    ...config,
    webhookEndpointPath: CLIP_WEBHOOK_ENDPOINT_PATH,
    webhookEndpoints: await buildClipWebhookEndpoints(req)
  }
}

function sendClipError(res, error, fallback = 'No se pudo procesar CLIP') {
  const status = error.status || error.statusCode || 500
  res.status(status).json({
    success: false,
    error: cleanString(error.message) || fallback
  })
}

export async function getClipConfigView(req, res) {
  try {
    const config = await getClipPaymentConfig()
    res.json({ success: true, data: await withClipWebhookEndpoints(req, config) })
  } catch (error) {
    logger.error(`Error obteniendo configuración CLIP: ${error.message}`)
    sendClipError(res, error, 'No se pudo obtener la configuración de CLIP')
  }
}

export async function saveClipConfigView(req, res) {
  try {
    const config = await saveClipPaymentConfig(req.body || {})
    res.json({ success: true, data: await withClipWebhookEndpoints(req, config) })
  } catch (error) {
    logger.error(`Error guardando configuración CLIP: ${error.message}`)
    sendClipError(res, error, 'No se pudo guardar la configuración de CLIP')
  }
}

export async function deleteClipConfigView(req, res) {
  try {
    const config = await deleteClipPaymentConfig()
    res.json({ success: true, data: await withClipWebhookEndpoints(req, config) })
  } catch (error) {
    logger.error(`Error desconectando CLIP: ${error.message}`)
    sendClipError(res, error, 'No se pudo desconectar CLIP')
  }
}

export async function testClipConfigView(req, res) {
  try {
    const result = await testClipPaymentConfig(req.body && Object.keys(req.body).length > 0 ? req.body : null)
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error probando configuración CLIP: ${error.message}`)
    sendClipError(res, error, 'No se pudo probar la conexión con CLIP')
  }
}

export async function createClipPaymentLinkView(req, res) {
  try {
    const result = await createClipPaymentLink(req.body || {}, {
      baseUrl: getRequestBaseUrl(req)
    })
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error creando link CLIP: ${error.message}`)
    sendClipError(res, error, 'No se pudo crear el link de pago con CLIP')
  }
}

export async function getPublicClipPaymentView(req, res) {
  try {
    const payment = await getPublicClipPayment(req.params.publicPaymentId, {
      baseUrl: getRequestBaseUrl(req)
    })

    if (!payment) {
      return res.status(404).json({ success: false, error: 'Pago no encontrado' })
    }

    res.json({ success: true, data: payment })
  } catch (error) {
    logger.error(`Error obteniendo pago público CLIP: ${error.message}`)
    sendClipError(res, error, 'No se pudo abrir el pago')
  }
}

export async function createPublicClipCardPaymentView(req, res) {
  try {
    const result = await createPublicClipCardPayment(req.params.publicPaymentId, req.body || {}, {
      baseUrl: getRequestBaseUrl(req)
    })
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error cobrando tarjeta CLIP: ${error.message}`)
    sendClipError(res, error, 'No se pudo cobrar la tarjeta con CLIP')
  }
}

export async function refreshPublicClipPaymentView(req, res) {
  try {
    const result = await refreshPublicClipPayment(req.params.publicPaymentId, req.body?.clipPaymentId || req.body?.clip_payment_id || '', {
      baseUrl: getRequestBaseUrl(req)
    })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error refrescando pago CLIP: ${error.message}`)
    sendClipError(res, error, 'No se pudo refrescar el pago con CLIP')
  }
}

export async function clipWebhookView(req, res) {
  try {
    const result = await handleClipWebhookEvent(req.body || {})
    res.json({ success: true, ...result })
  } catch (error) {
    logger.error(`Webhook CLIP falló: ${error.message}`)
    sendClipError(res, error, 'No se pudo procesar el webhook de CLIP')
  }
}
