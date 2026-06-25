import {
  createConektaPaymentLink,
  createConektaPaymentPlan,
  createConektaSavedCardPayment,
  createPublicConektaCardPayment,
  deleteConektaPaymentConfig,
  getConektaPaymentConfig,
  getConektaSavedPaymentSources,
  getPublicConektaPayment,
  reconcileConektaOrderFromWebhook,
  saveConektaPaymentConfig,
  testConektaPaymentConfig
} from '../services/conektaPaymentService.js'
import { logger } from '../utils/logger.js'

function cleanString(value) {
  return String(value || '').trim()
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

function sendConektaError(res, error, fallback = 'No se pudo procesar Conekta') {
  const status = error.status || error.statusCode || 500
  res.status(status).json({
    success: false,
    error: cleanString(error.message) || fallback
  })
}

// (PAY2-002) Webhook de Conekta para reconciliar pagos pendientes (3DS/OXXO/SPEI) que
// quedaban "pending" para siempre. Rollout seguro: si hay CONEKTA_WEBHOOK_SECRET, se exige;
// si no, se acepta + warn para no romper la integración mientras se configura.
// NOTA (verificar en QA): confirmar contra el payload real de tu cuenta Conekta que el id
// de la orden viaja en data.object.id (la estructura documentada es { type, data:{ object } }).
export async function handleConektaWebhookView(req, res) {
  try {
    const secret = cleanString(process.env.CONEKTA_WEBHOOK_SECRET)
    if (secret) {
      const provided = cleanString(req.get('x-conekta-webhook-secret') || req.query?.secret || '')
      if (provided !== secret) {
        return res.status(401).json({ success: false, error: 'Firma de webhook inválida' })
      }
    } else {
      logger.warn('[Conekta webhook] Aceptado SIN verificación: configura CONEKTA_WEBHOOK_SECRET para protegerlo.')
    }

    const result = await reconcileConektaOrderFromWebhook(req.body || {})
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
    res.json({ success: true, data: config })
  } catch (error) {
    logger.error(`Error obteniendo configuración Conekta: ${error.message}`)
    sendConektaError(res, error, 'No se pudo obtener la configuración de Conekta')
  }
}

export async function saveConektaConfigView(req, res) {
  try {
    const config = await saveConektaPaymentConfig(req.body || {})
    res.json({ success: true, data: config })
  } catch (error) {
    logger.error(`Error guardando configuración Conekta: ${error.message}`)
    sendConektaError(res, error, 'No se pudo guardar la configuración de Conekta')
  }
}

export async function deleteConektaConfigView(req, res) {
  try {
    const config = await deleteConektaPaymentConfig()
    res.json({ success: true, data: config })
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
    const result = await createConektaPaymentPlan(req.body || {}, {
      baseUrl: getRequestBaseUrl(req)
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
    const result = await createConektaSavedCardPayment(req.body || {})
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error cobrando tarjeta guardada Conekta: ${error.message}`)
    sendConektaError(res, error, 'No se pudo cobrar la tarjeta guardada')
  }
}
