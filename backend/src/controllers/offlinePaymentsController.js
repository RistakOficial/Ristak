import { logger } from '../utils/logger.js'
import {
  createOfflinePaymentPlan,
  getPublicOfflinePayment
} from '../services/offlinePaymentPlanService.js'
import { runIdempotentPaymentPlanCreation } from '../services/paymentPlanSafetyService.js'
import { queuePaymentAutomationMessage } from '../services/paymentAutomationsService.js'
import { updateSingleContactStats } from '../utils/updateContactsStats.js'

function cleanString(value) {
  return String(value || '').trim()
}

function getRequestBaseUrl(req) {
  const forwardedHost = cleanString(req.headers['x-forwarded-host']).split(',')[0]
  const host = forwardedHost || cleanString(req.headers.host)
  const forwardedProto = cleanString(req.headers['x-forwarded-proto']).split(',')[0]
  const protocol = forwardedProto || req.protocol || 'https'
  return host ? `${protocol}://${host}`.replace(/\/+$/, '') : ''
}

function sendError(res, error, fallback) {
  const status = Number(error?.status || error?.statusCode || 500)
  res.status(status >= 400 && status <= 599 ? status : 500).json({
    success: false,
    error: error?.message || fallback
  })
}

export async function createOfflinePaymentPlanView(req, res) {
  try {
    const payload = req.body && typeof req.body === 'object' ? req.body : {}
    const idempotencyKey = cleanString(req.get('Idempotency-Key') || payload.idempotencyKey)
    const result = await runIdempotentPaymentPlanCreation({
      provider: 'offline',
      idempotencyKey,
      payload,
      create: () => createOfflinePaymentPlan(payload, { baseUrl: getRequestBaseUrl(req) })
    })
    if (result.firstPaymentPaymentId) {
      await updateSingleContactStats(payload.contact?.id || payload.contactId)
      queuePaymentAutomationMessage('receipt', result.firstPaymentPaymentId)
    }
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error creando plan offline: ${error.message}`)
    sendError(res, error, 'No se pudo crear el plan offline.')
  }
}

export async function getPublicOfflinePaymentView(req, res) {
  try {
    const payment = await getPublicOfflinePayment(req.params.publicPaymentId, {
      baseUrl: getRequestBaseUrl(req)
    })
    if (!payment) {
      return res.status(404).json({ success: false, error: 'Aviso de pago no encontrado.' })
    }
    return res.json({ success: true, data: payment })
  } catch (error) {
    logger.error(`Error leyendo aviso offline público: ${error.message}`)
    return sendError(res, error, 'No se pudo abrir el aviso de pago.')
  }
}
