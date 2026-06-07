import { logger } from '../utils/logger.js'
import {
  OUTGOING_WEBHOOK_EVENT_OPTIONS,
  deleteOutgoingWebhookDestination,
  getOutgoingWebhookDestination,
  listOutgoingWebhookAttempts,
  listOutgoingWebhookDeliveries,
  listOutgoingWebhookDestinations,
  listOutgoingWebhookScopes,
  retryOutgoingWebhookDelivery,
  saveOutgoingWebhookDestination,
  sendOutgoingWebhookTest
} from '../services/outgoingWebhooksService.js'

function getRequestUserId(req) {
  return req.user?.userId || req.user?.id || null
}

function sendError(res, error, fallback = 'No se pudo procesar la solicitud') {
  res.status(error.status || 500).json({
    success: false,
    error: error.message || fallback
  })
}

export async function getOutgoingWebhooksOverview(req, res) {
  try {
    const [destinations, deliveries, scopes] = await Promise.all([
      listOutgoingWebhookDestinations(),
      listOutgoingWebhookDeliveries({ limit: 50 }),
      listOutgoingWebhookScopes()
    ])

    res.json({
      success: true,
      data: {
        destinations,
        deliveries,
        eventOptions: OUTGOING_WEBHOOK_EVENT_OPTIONS,
        scopes
      }
    })
  } catch (error) {
    logger.error(`Error listando webhooks salientes: ${error.message}`)
    sendError(res, error, 'No se pudieron cargar los webhooks salientes')
  }
}

export async function createOutgoingWebhookDestination(req, res) {
  try {
    const destination = await saveOutgoingWebhookDestination(req.body || {}, getRequestUserId(req))
    res.status(201).json({
      success: true,
      data: destination
    })
  } catch (error) {
    logger.error(`Error creando webhook saliente: ${error.message}`)
    sendError(res, error, 'No se pudo crear el webhook saliente')
  }
}

export async function updateOutgoingWebhookDestination(req, res) {
  try {
    const existing = await getOutgoingWebhookDestination(req.params.id)
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'Destino no encontrado'
      })
    }

    const destination = await saveOutgoingWebhookDestination(req.body || {}, getRequestUserId(req), req.params.id)
    res.json({
      success: true,
      data: destination
    })
  } catch (error) {
    logger.error(`Error actualizando webhook saliente ${req.params.id}: ${error.message}`)
    sendError(res, error, 'No se pudo actualizar el webhook saliente')
  }
}

export async function deleteOutgoingWebhookDestinationView(req, res) {
  try {
    const destination = await deleteOutgoingWebhookDestination(req.params.id)
    if (!destination) {
      return res.status(404).json({
        success: false,
        error: 'Destino no encontrado'
      })
    }

    res.json({
      success: true,
      data: destination
    })
  } catch (error) {
    logger.error(`Error eliminando webhook saliente ${req.params.id}: ${error.message}`)
    sendError(res, error, 'No se pudo eliminar el webhook saliente')
  }
}

export async function sendOutgoingWebhookTestView(req, res) {
  try {
    const delivery = await sendOutgoingWebhookTest(req.params.id)
    if (!delivery) {
      return res.status(404).json({
        success: false,
        error: 'Destino no encontrado'
      })
    }

    res.json({
      success: true,
      data: delivery
    })
  } catch (error) {
    logger.error(`Error enviando prueba de webhook saliente ${req.params.id}: ${error.message}`)
    sendError(res, error, 'No se pudo enviar la prueba')
  }
}

export async function listOutgoingWebhookDeliveriesView(req, res) {
  try {
    const deliveries = await listOutgoingWebhookDeliveries({
      limit: req.query?.limit,
      status: req.query?.status
    })

    res.json({
      success: true,
      data: deliveries
    })
  } catch (error) {
    logger.error(`Error listando entregas de webhooks salientes: ${error.message}`)
    sendError(res, error, 'No se pudo cargar el historial')
  }
}

export async function listOutgoingWebhookAttemptsView(req, res) {
  try {
    const attempts = await listOutgoingWebhookAttempts(req.params.deliveryId)
    res.json({
      success: true,
      data: attempts
    })
  } catch (error) {
    logger.error(`Error listando intentos de webhook saliente ${req.params.deliveryId}: ${error.message}`)
    sendError(res, error, 'No se pudieron cargar los intentos')
  }
}

export async function retryOutgoingWebhookDeliveryView(req, res) {
  try {
    const delivery = await retryOutgoingWebhookDelivery(req.params.deliveryId)
    if (!delivery) {
      return res.status(404).json({
        success: false,
        error: 'Envío no encontrado'
      })
    }

    res.json({
      success: true,
      data: delivery
    })
  } catch (error) {
    logger.error(`Error reintentando webhook saliente ${req.params.deliveryId}: ${error.message}`)
    sendError(res, error, 'No se pudo reintentar el envío')
  }
}
