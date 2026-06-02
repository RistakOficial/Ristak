import express from 'express'
import {
  handleContactWebhook,
  handlePaymentWebhook,
  handleRefundWebhook,
  handleAppointmentWebhook,
  handleAppointmentShowedWebhook,
  handleWhatsAppAttributionWebhook,
  handleInvoiceWebhook
} from '../controllers/webhooksController.js'

const router = express.Router()

router.post('/contact', handleContactWebhook)
router.post('/payment', handlePaymentWebhook)
router.post('/refund', handleRefundWebhook)
router.post('/appointment', handleAppointmentWebhook)
router.post('/appointment/showed', handleAppointmentShowedWebhook)
router.post('/whatsapp/attribution', handleWhatsAppAttributionWebhook)
router.post('/invoice', handleInvoiceWebhook)

export default router
