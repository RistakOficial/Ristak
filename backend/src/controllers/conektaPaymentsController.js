import {
  createConektaPaymentLink,
  createConektaPaymentPlan,
  createConektaSavedCardPayment,
  createPublicConektaCardPayment,
  createPublicConektaSubscription,
  deleteConektaPaymentConfig,
  getConektaPaymentConfig,
  getConektaSavedPaymentSources,
  getPublicConektaPayment,
  reconcileConektaWebhookEvent,
  saveConektaPaymentConfig,
  testConektaPaymentConfig,
  verifyConektaWebhookSignature
} from '../services/conektaPaymentService.js'
import { getAppConfig } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { syncRegisteredIntegrationCronsForProvider } from '../jobs/integrationCronRegistry.js'
import { runIdempotentPaymentPlanCreation } from '../services/paymentPlanSafetyService.js'
import { runIdempotentSavedCardPayment } from '../services/savedCardPaymentSafetyService.js'

const CONEKTA_WEBHOOK_PATH = '/api/conekta/webhook'

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

  const url = `${normalized}${CONEKTA_WEBHOOK_PATH}`
  const key = url.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)

  items.push({ source, label, description, url })
}

async function buildConektaWebhookEndpoints(req) {
  const endpoints = []
  const seen = new Set()

  addWebhookEndpoint(
    endpoints,
    seen,
    'render',
    'Render',
    'Endpoint del servicio publicado en Render.',
    process.env.RENDER_EXTERNAL_URL
  )

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
    addWebhookEndpoint(
      endpoints,
      seen,
      'app_domain',
      'Dominio de la app',
      'Endpoint del dominio conectado para abrir Ristak.',
      appDomain
    )
  }

  addWebhookEndpoint(
    endpoints,
    seen,
    'current_request',
    'URL detectada',
    'Endpoint detectado desde esta sesión actual.',
    getRequestBaseUrl(req)
  )

  return endpoints
}

function isPublicWebhookEndpointUrl(url) {
  try {
    const parsed = new URL(cleanString(url))
    const host = parsed.hostname.toLowerCase()
    return parsed.protocol === 'https:' &&
      !['localhost', '127.0.0.1', '::1'].includes(host) &&
      !host.endsWith('.local')
  } catch {
    return false
  }
}

async function getPreferredConektaWebhookUrl(req) {
  const endpoints = await buildConektaWebhookEndpoints(req)
  return endpoints.find((endpoint) => isPublicWebhookEndpointUrl(endpoint.url))?.url || ''
}

async function withConektaWebhookEndpoints(req, config) {
  return {
    ...config,
    webhookEndpointPath: CONEKTA_WEBHOOK_PATH,
    webhookEndpoints: await buildConektaWebhookEndpoints(req)
  }
}

function sendConektaError(res, error, fallback = 'No se pudo procesar Conekta') {
  const status = error.status || error.statusCode || 500
  res.status(status).json({
    success: false,
    error: cleanString(error.message) || fallback
  })
}

// Los estados financieros sólo se reconcilian con firma criptográfica del proveedor.
// Si la instalación no tiene llave pública, se rechaza: nunca hacemos fail-open con dinero.
export async function handleConektaWebhookView(req, res) {
  try {
    const rawBody = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body || {})
    const signature = await verifyConektaWebhookSignature(rawBody, req.get('DIGEST') || req.get('digest') || '')

    if (!signature.configured) {
      logger.error('[Conekta webhook] Rechazado: no hay llave pública de firma configurada por Conekta.')
      return res.status(503).json({ success: false, error: 'Webhook no verificable' })
    }
    if (!signature.verified) {
      return res.status(401).json({ success: false, error: 'Firma de webhook inválida' })
    }

    const result = await reconcileConektaWebhookEvent(req.body || {})
    // Siempre 200 para que Conekta no reintente en bucle; el resultado va en el body.
    return res.json({ success: true, ...result })
  } catch (error) {
    logger.error(`[Conekta webhook] Error: ${error.message}`)
    return res.status(200).json({ success: false, error: 'No se pudo procesar el webhook' })
  }
}

export async function getConektaConfigView(req, res) {
  try {
    const config = await getConektaPaymentConfig()
    res.json({ success: true, data: await withConektaWebhookEndpoints(req, config) })
  } catch (error) {
    logger.error(`Error obteniendo configuración Conekta: ${error.message}`)
    sendConektaError(res, error, 'No se pudo obtener la configuración de Conekta')
  }
}

export async function saveConektaConfigView(req, res) {
  try {
    const config = await saveConektaPaymentConfig(req.body || {}, {
      webhookUrl: await getPreferredConektaWebhookUrl(req)
    })
    await syncRegisteredIntegrationCronsForProvider('conekta', { reason: 'conekta-connected' })
    res.json({ success: true, data: await withConektaWebhookEndpoints(req, config) })
  } catch (error) {
    logger.error(`Error guardando configuración Conekta: ${error.message}`)
    sendConektaError(res, error, 'No se pudo guardar la configuración de Conekta')
  }
}

export async function deleteConektaConfigView(req, res) {
  try {
    const config = await deleteConektaPaymentConfig()
    await syncRegisteredIntegrationCronsForProvider('conekta', { reason: 'conekta-disconnected' })
    res.json({ success: true, data: await withConektaWebhookEndpoints(req, config) })
  } catch (error) {
    logger.error(`Error desconectando Conekta: ${error.message}`)
    sendConektaError(res, error, 'No se pudo desconectar Conekta')
  }
}

export async function testConektaConfigView(req, res) {
  try {
    const result = await testConektaPaymentConfig(req.body && Object.keys(req.body).length > 0 ? req.body : null)
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error probando configuración Conekta: ${error.message}`)
    sendConektaError(res, error, 'No se pudo probar la conexión con Conekta')
  }
}

export async function createConektaPaymentLinkView(req, res) {
  try {
    const result = await createConektaPaymentLink(req.body || {}, {
      baseUrl: getRequestBaseUrl(req)
    })
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error creando link de pago Conekta: ${error.message}`)
    sendConektaError(res, error, 'No se pudo crear el link de pago con Conekta')
  }
}

export async function createConektaPaymentPlanView(req, res) {
  try {
    const requestPayload = req.body || {}
    const idempotencyKey = req.get('Idempotency-Key') || requestPayload.idempotencyKey || requestPayload.clientRequestId
    const payload = { ...requestPayload, idempotencyKey }
    const result = await runIdempotentPaymentPlanCreation({
      provider: 'conekta',
      idempotencyKey,
      payload,
      create: () => createConektaPaymentPlan(payload, {
        baseUrl: getRequestBaseUrl(req)
      })
    })
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error creando plan de pagos Conekta: ${error.message}`)
    sendConektaError(res, error, 'No se pudo crear el plan de pagos con Conekta')
  }
}

export async function getPublicConektaPaymentView(req, res) {
  try {
    const payment = await getPublicConektaPayment(req.params.publicPaymentId, {
      baseUrl: getRequestBaseUrl(req)
    })

    if (!payment) {
      return res.status(404).json({ success: false, error: 'Pago no encontrado' })
    }

    res.json({ success: true, data: payment })
  } catch (error) {
    logger.error(`Error obteniendo pago público Conekta: ${error.message}`)
    sendConektaError(res, error, 'No se pudo cargar el pago')
  }
}

export async function createPublicConektaCardPaymentView(req, res) {
  try {
    const result = await createPublicConektaCardPayment(req.params.publicPaymentId, req.body || {}, {
      baseUrl: getRequestBaseUrl(req)
    })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error creando pago público Conekta: ${error.message}`)
    sendConektaError(res, error, 'No se pudo iniciar el pago con Conekta')
  }
}

export async function createPublicConektaSubscriptionView(req, res) {
  try {
    const result = await createPublicConektaSubscription(req.params.publicPaymentId, req.body || {}, {
      baseUrl: getRequestBaseUrl(req)
    })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error creando suscripción pública Conekta: ${error.message}`)
    sendConektaError(res, error, 'No se pudo iniciar la suscripción con Conekta')
  }
}

export async function getConektaSavedPaymentSourcesView(req, res) {
  try {
    const sources = await getConektaSavedPaymentSources(req.params.contactId)
    res.json({ success: true, data: sources })
  } catch (error) {
    logger.error(`Error obteniendo tarjetas guardadas Conekta: ${error.message}`)
    sendConektaError(res, error, 'No se pudieron obtener las tarjetas guardadas')
  }
}

export async function createConektaSavedCardPaymentView(req, res) {
  try {
    const requestPayload = req.body || {}
    const idempotencyKey = req.get('Idempotency-Key') || requestPayload.idempotencyKey || requestPayload.clientRequestId
    const payload = { ...requestPayload, idempotencyKey }
    const result = await runIdempotentSavedCardPayment({
      provider: 'conekta',
      idempotencyKey,
      payload,
      create: ({ providerIdempotencyKey }) => createConektaSavedCardPayment(payload, { providerIdempotencyKey })
    })
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error cobrando tarjeta guardada Conekta: ${error.message}`)
    sendConektaError(res, error, 'No se pudo cobrar la tarjeta guardada')
  }
}
