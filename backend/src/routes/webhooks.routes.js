import express from 'express'
import {
  handleYCloudWhatsAppApiWebhook
} from '../controllers/whatsappApiController.js'
import {
  handleContactWebhook,
  handlePaymentWebhook,
  handleRefundWebhook,
  handleAppointmentWebhook,
  handleAppointmentShowedWebhook,
  handlePaymentPlanWebhook,
  handleWhatsAppAttributionWebhook,
  handleInvoiceWebhook,
  handleConversationWebhook,
  handleMetaSocialWebhook,
  verifyMetaSocialWebhook
} from '../controllers/webhooksController.js'

const router = express.Router()

router.post('/contact', handleContactWebhook)
router.post('/payment', handlePaymentWebhook)
router.post('/payment-plan', handlePaymentPlanWebhook)
router.post('/payment-plans', handlePaymentPlanWebhook)
router.post('/refund', handleRefundWebhook)
router.post('/appointment', handleAppointmentWebhook)
router.post('/appointment/showed', handleAppointmentShowedWebhook)
router.post('/whatsapp/attribution', handleWhatsAppAttributionWebhook)
router.post('/conversation', handleConversationWebhook)
router.post('/whatsapp-api/ycloud', handleYCloudWhatsAppApiWebhook)
router.post('/invoice', handleInvoiceWebhook)
router.get('/meta', verifyMetaSocialWebhook)
router.post('/meta', handleMetaSocialWebhook)

export default router
