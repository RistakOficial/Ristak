import express from 'express'
import {
  createOutgoingWebhookDestination,
  deleteOutgoingWebhookDestinationView,
  getOutgoingWebhooksOverview,
  listOutgoingWebhookAttemptsView,
  listOutgoingWebhookDeliveriesView,
  retryOutgoingWebhookDeliveryView,
  sendOutgoingWebhookTestView,
  updateOutgoingWebhookDestination
} from '../controllers/outgoingWebhooksController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.use(requireAuth)

router.get('/', getOutgoingWebhooksOverview)
router.post('/', createOutgoingWebhookDestination)
router.put('/:id', updateOutgoingWebhookDestination)
router.delete('/:id', deleteOutgoingWebhookDestinationView)
router.post('/:id/test', sendOutgoingWebhookTestView)

router.get('/deliveries/history', listOutgoingWebhookDeliveriesView)
router.get('/deliveries/:deliveryId/attempts', listOutgoingWebhookAttemptsView)
router.post('/deliveries/:deliveryId/retry', retryOutgoingWebhookDeliveryView)

export default router
