import express from 'express'
import {
  connectWhatsAppApiView,
  disconnectWhatsAppApiView,
  getWhatsAppApiConnectionStatus,
  getWhatsAppApiTemplatesView,
  previewWhatsAppApiPhoneNumbersView,
  refreshWhatsAppApiView,
  resetWhatsAppApiCredentialsView,
  sendWhatsAppApiTemplateMessageView,
  sendWhatsAppApiTextMessageView
} from '../controllers/whatsappApiController.js'

const router = express.Router()

router.get('/status', getWhatsAppApiConnectionStatus)
router.post('/connect', connectWhatsAppApiView)
router.post('/phone-numbers/preview', previewWhatsAppApiPhoneNumbersView)
router.post('/refresh', refreshWhatsAppApiView)
router.post('/disconnect', disconnectWhatsAppApiView)
router.post('/reset', resetWhatsAppApiCredentialsView)
router.post('/messages/text', sendWhatsAppApiTextMessageView)
router.get('/templates', getWhatsAppApiTemplatesView)
router.post('/templates/send', sendWhatsAppApiTemplateMessageView)

export default router
