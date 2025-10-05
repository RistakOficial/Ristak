import express from 'express'
import {
  handleContactWebhook,
  handlePaymentWebhook,
  handleRefundWebhook,
  handleAppointmentWebhook,
  handleWhatsAppAttributionWebhook
} from '../controllers/webhooksController.js'

const router = express.Router()

router.post('/contact', handleContactWebhook)
router.post('/payment', handlePaymentWebhook)
router.post('/refund', handleRefundWebhook)
router.post('/appointment', handleAppointmentWebhook)
router.post('/whatsapp/attribution', handleWhatsAppAttributionWebhook)

export default router
