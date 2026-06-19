import {
  createStripePaymentIntent,
  createStripePaymentLink,
  deleteStripePaymentConfig,
  getPublicStripePayment,
  getStripePaymentConfig,
  handleStripeWebhookEvent,
  saveStripePaymentConfig,
  testStripePaymentConfig
} from '../services/stripePaymentService.js'
import { logger } from '../utils/logger.js'

function getRequestBaseUrl(req) {
  const configured = process.env.PUBLIC_APP_URL || process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL
  if (configured) return String(configured).replace(/\/+$/, '')

  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
  const host = forwardedHost || req.headers.host
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const protocol = forwardedProto || req.protocol || 'https'
  return `${protocol}://${host}`
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
    res.json({ success: true, data: config })
  } catch (error) {
    logger.error(`Error obteniendo configuración Stripe: ${error.message}`)
    sendStripeError(res, error, 'No se pudo obtener la configuración de Stripe')
  }
}

export async function saveStripeConfigView(req, res) {
  try {
    const config = await saveStripePaymentConfig(req.body || {})
    res.json({ success: true, data: config })
  } catch (error) {
    logger.error(`Error guardando configuración Stripe: ${error.message}`)
    sendStripeError(res, error, 'No se pudo guardar la configuración de Stripe')
  }
}

export async function deleteStripeConfigView(req, res) {
  try {
    const config = await deleteStripePaymentConfig()
    res.json({ success: true, data: config })
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
    const result = await createStripePaymentIntent(req.params.publicPaymentId)
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error creando PaymentIntent público Stripe: ${error.message}`)
    sendStripeError(res, error, 'No se pudo iniciar el pago con Stripe')
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
