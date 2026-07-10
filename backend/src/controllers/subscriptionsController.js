import {
  actionSubscription,
  createSubscription,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  updateSubscription
} from '../services/subscriptionsService.js'
import { runIdempotentSubscriptionCreation } from '../services/subscriptionCreationSafetyService.js'
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
  const configured = process.env.PUBLIC_APP_URL || process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL || process.env.RENDER_EXTERNAL_URL
  if (configured) return normalizeBaseUrl(configured)

  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
  const host = forwardedHost || req.headers.host
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const protocol = forwardedProto || req.protocol || 'https'
  return normalizeBaseUrl(host ? `${protocol}://${host}` : '')
}

function sendError(res, error, fallback = 'No se pudo procesar la suscripción.') {
  logger.error(fallback, error)
  const requestedStatus = Number(error?.status || error?.statusCode || 400)
  const status = Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus <= 599
    ? requestedStatus
    : 500
  res.status(status).json({
    success: false,
    error: error instanceof Error ? error.message : fallback
  })
}

export async function listSubscriptionsView(req, res) {
  try {
    const data = await listSubscriptions({
      status: req.query.status,
      refresh: ['1', 'true', 'yes'].includes(cleanString(req.query.refresh).toLowerCase())
    })
    res.json({ success: true, data })
  } catch (error) {
    sendError(res, error, 'No se pudieron cargar las suscripciones.')
  }
}

export async function getSubscriptionView(req, res) {
  try {
    const subscription = await getSubscription(req.params.subscriptionId)
    if (!subscription) {
      res.status(404).json({ success: false, error: 'Suscripción no encontrada.' })
      return
    }

    res.json({ success: true, data: subscription })
  } catch (error) {
    sendError(res, error, 'No se pudo cargar la suscripción.')
  }
}

export async function createSubscriptionView(req, res) {
  try {
    const requestPayload = req.body || {}
    const idempotencyKey = req.get?.('Idempotency-Key')
      || req.headers?.['idempotency-key']
      || requestPayload.idempotencyKey
      || requestPayload.clientRequestId
    const provider = cleanString(requestPayload.paymentProvider || requestPayload.payment_provider).toLowerCase() || 'stripe'
    const subscription = await runIdempotentSubscriptionCreation({
      provider,
      idempotencyKey,
      payload: requestPayload,
      create: () => createSubscription({
        ...requestPayload,
        baseUrl: getRequestBaseUrl(req)
      })
    })
    res.status(201).json({ success: true, data: subscription })
  } catch (error) {
    sendError(res, error, 'No se pudo crear la suscripción.')
  }
}

export async function updateSubscriptionView(req, res) {
  try {
    const subscription = await updateSubscription(req.params.subscriptionId, {
      ...(req.body || {}),
      baseUrl: getRequestBaseUrl(req)
    })
    if (!subscription) {
      res.status(404).json({ success: false, error: 'Suscripción no encontrada.' })
      return
    }

    res.json({ success: true, data: subscription })
  } catch (error) {
    sendError(res, error, 'No se pudo actualizar la suscripción.')
  }
}

export async function actionSubscriptionView(req, res) {
  try {
    const subscription = await actionSubscription(
      req.params.subscriptionId,
      req.body?.action,
      req.body?.payload || {}
    )

    if (!subscription) {
      res.status(404).json({ success: false, error: 'Suscripción no encontrada.' })
      return
    }

    res.json({ success: true, data: subscription })
  } catch (error) {
    sendError(res, error, 'No se pudo actualizar la suscripción.')
  }
}

export async function deleteSubscriptionView(req, res) {
  try {
    const deleted = await deleteSubscription(req.params.subscriptionId)
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Suscripción no encontrada.' })
      return
    }

    res.status(204).send()
  } catch (error) {
    sendError(res, error, 'No se pudo eliminar la suscripción.')
  }
}
