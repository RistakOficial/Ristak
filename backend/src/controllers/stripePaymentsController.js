import {
  createStripePaymentPlan,
  createStripeSavedCardPayment,
  createStripePaymentIntent,
  createStripePaymentLink,
  deleteStripePaymentConfig,
  getPublicStripePayment,
  getStripePaymentConfig,
  getStripeSavedPaymentMethods,
  handleStripeWebhookEvent,
  saveStripePaymentConfig,
  testStripePaymentConfig
} from '../services/stripePaymentService.js'
import { getAppConfig } from '../config/database.js'
import { logger } from '../utils/logger.js'

const STRIPE_WEBHOOK_PATH = '/api/stripe/webhook'

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

  const url = `${normalized}${STRIPE_WEBHOOK_PATH}`
  const key = url.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)

  items.push({ source, label, description, url })
}

async function buildStripeWebhookEndpoints(req) {
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

async function withStripeWebhookEndpoints(req, config) {
  return {
    ...config,
    webhookEndpointPath: STRIPE_WEBHOOK_PATH,
    webhookEndpoints: await buildStripeWebhookEndpoints(req)
  }
}

function sendStripeError(res, error, fallback = 'No se pudo procesar Stripe') {
  const status = error.status || error.statusCode || 500
  res.status(status).json({
    success: false,
    error: error.message || fallback
  })
}

export async function getStripeConfigView(req, res) {
  try {
    const config = await getStripePaymentConfig()
    res.json({ success: true, data: await withStripeWebhookEndpoints(req, config) })
  } catch (error) {
    logger.error(`Error obteniendo configuración Stripe: ${error.message}`)
    sendStripeError(res, error, 'No se pudo obtener la configuración de Stripe')
  }
}

export async function saveStripeConfigView(req, res) {
  try {
    const config = await saveStripePaymentConfig(req.body || {})
    res.json({ success: true, data: await withStripeWebhookEndpoints(req, config) })
  } catch (error) {
    logger.error(`Error guardando configuración Stripe: ${error.message}`)
    sendStripeError(res, error, 'No se pudo guardar la configuración de Stripe')
  }
}

export async function deleteStripeConfigView(req, res) {
  try {
    const config = await deleteStripePaymentConfig()
    res.json({ success: true, data: await withStripeWebhookEndpoints(req, config) })
  } catch (error) {
    logger.error(`Error desconectando Stripe: ${error.message}`)
    sendStripeError(res, error, 'No se pudo desconectar Stripe')
  }
}

export async function testStripeConfigView(req, res) {
  try {
    const result = await testStripePaymentConfig(req.body && Object.keys(req.body).length > 0 ? req.body : null)
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error probando configuración Stripe: ${error.message}`)
    sendStripeError(res, error, 'No se pudo probar la conexión con Stripe')
  }
}

export async function createStripePaymentLinkView(req, res) {
  try {
    const result = await createStripePaymentLink(req.body || {}, {
      baseUrl: getRequestBaseUrl(req)
    })
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error creando link de pago Stripe: ${error.message}`)
    sendStripeError(res, error, 'No se pudo crear el link de pago con Stripe')
  }
}

export async function createStripePaymentPlanView(req, res) {
  try {
    const result = await createStripePaymentPlan(req.body || {}, {
      baseUrl: getRequestBaseUrl(req)
    })
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error creando plan de pagos Stripe: ${error.message}`)
    sendStripeError(res, error, 'No se pudo crear el plan de pagos con Stripe')
  }
}

export async function getPublicStripePaymentView(req, res) {
  try {
    const payment = await getPublicStripePayment(req.params.publicPaymentId, {
      baseUrl: getRequestBaseUrl(req),
      sync: String(req.query?.sync || '').toLowerCase() === 'true'
    })

    if (!payment) {
      return res.status(404).json({ success: false, error: 'Pago no encontrado' })
    }

    res.json({ success: true, data: payment })
  } catch (error) {
    logger.error(`Error obteniendo pago público Stripe: ${error.message}`)
    sendStripeError(res, error, 'No se pudo cargar el pago')
  }
}

export async function createPublicStripePaymentIntentView(req, res) {
  try {
    const result = await createStripePaymentIntent(req.params.publicPaymentId, req.body || {})
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error creando PaymentIntent público Stripe: ${error.message}`)
    sendStripeError(res, error, 'No se pudo iniciar el pago con Stripe')
  }
}

export async function getStripeSavedPaymentMethodsView(req, res) {
  try {
    const methods = await getStripeSavedPaymentMethods(req.params.contactId)
    res.json({ success: true, data: methods })
  } catch (error) {
    logger.error(`Error obteniendo tarjetas guardadas Stripe: ${error.message}`)
    sendStripeError(res, error, 'No se pudieron obtener las tarjetas guardadas')
  }
}

export async function createStripeSavedCardPaymentView(req, res) {
  try {
    const result = await createStripeSavedCardPayment(req.body || {})
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error cobrando tarjeta guardada Stripe: ${error.message}`)
    sendStripeError(res, error, 'No se pudo cobrar la tarjeta guardada')
  }
}

export async function stripeWebhookView(req, res) {
  try {
    const signature = req.headers['stripe-signature']
    if (!signature) {
      return res.status(400).json({ success: false, error: 'Falta Stripe-Signature' })
    }

    const result = await handleStripeWebhookEvent(req.rawBody || '', signature)
    res.json(result)
  } catch (error) {
    logger.error(`Error procesando webhook de Stripe: ${error.message}`)
    sendStripeError(res, error, 'No se pudo procesar el webhook de Stripe')
  }
}
