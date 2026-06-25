import express from 'express'
import {
  handleYCloudWhatsAppApiWebhook
} from '../controllers/whatsappApiController.js'
import { automationWebhookSampleHandler } from '../controllers/automationsController.js'
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
  verifyMetaSocialWebhook,
  handleAutomationIncomingWebhook,
  // (SEC-002 / WA-004) Verificación de firma/token para webhooks de ingreso sin firma nativa.
  verifyInboundWebhookSignature
} from '../controllers/webhooksController.js'
import { handleGoalWebhook as handleConversationalAgentGoalWebhook } from '../controllers/conversationalAgentController.js'

const router = express.Router()

router.post('/automation/:endpointId', handleAutomationIncomingWebhook)
router.all('/automations/:endpointId', automationWebhookSampleHandler)
// (SEC-002 / WA-004) Estos webhooks de ingreso llegan sin firma nativa (HighLevel
// custom webhooks). Se protegen con un secreto compartido vía verifyInboundWebhookSignature
// (rollout seguro: solo rechaza 401 cuando ya hay secreto configurado).
router.post('/contact', verifyInboundWebhookSignature, handleContactWebhook)
router.post('/payment', verifyInboundWebhookSignature, handlePaymentWebhook)
router.post('/payment-plan', verifyInboundWebhookSignature, handlePaymentPlanWebhook)
router.post('/payment-plans', verifyInboundWebhookSignature, handlePaymentPlanWebhook)
router.post('/refund', verifyInboundWebhookSignature, handleRefundWebhook)
router.post('/appointment', verifyInboundWebhookSignature, handleAppointmentWebhook)
router.post('/appointment/showed', verifyInboundWebhookSignature, handleAppointmentShowedWebhook)
router.post('/whatsapp/attribution', verifyInboundWebhookSignature, handleWhatsAppAttributionWebhook)
router.post('/conversation', verifyInboundWebhookSignature, handleConversationWebhook)
router.post('/conversational-agent/goal', handleConversationalAgentGoalWebhook)
router.post('/conversational-agent/goal/:goalId', (req, res, next) => {
  req.query.goalId = req.params.goalId
  return handleConversationalAgentGoalWebhook(req, res, next)
})
router.post('/whatsapp-api/ycloud', handleYCloudWhatsAppApiWebhook)
router.post('/invoice', verifyInboundWebhookSignature, handleInvoiceWebhook)
router.get('/meta', verifyMetaSocialWebhook)
router.post('/meta', handleMetaSocialWebhook)

export default router
