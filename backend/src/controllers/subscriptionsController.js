import {
  actionSubscription,
  createSubscription,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  updateSubscription
} from '../services/subscriptionsService.js'
import { logger } from '../utils/logger.js'

function sendError(res, error, fallback = 'No se pudo procesar la suscripción.') {
  logger.error(fallback, error)
  res.status(400).json({
    success: false,
    error: error instanceof Error ? error.message : fallback
  })
}

export async function listSubscriptionsView(req, res) {
  try {
    const data = await listSubscriptions({ status: req.query.status })
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
    const subscription = await createSubscription(req.body || {})
    res.status(201).json({ success: true, data: subscription })
  } catch (error) {
    sendError(res, error, 'No se pudo crear la suscripción.')
  }
}

export async function updateSubscriptionView(req, res) {
  try {
    const subscription = await updateSubscription(req.params.subscriptionId, req.body || {})
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
