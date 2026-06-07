import express from 'express'
import {
  cancelScheduledChatMessageView,
  connectWhatsAppApiView,
  connectWhatsAppQrView,
  disconnectWhatsAppApiView,
  disconnectWhatsAppQrView,
  getWhatsAppApiConnectionStatus,
  getWhatsAppApiTemplatesView,
  getWhatsAppQrView,
  previewWhatsAppApiPhoneNumbersView,
  refreshWhatsAppApiView,
  resetWhatsAppApiCredentialsView,
  listScheduledChatMessagesView,
  scheduleChatMessageView,
  sendWhatsAppApiAudioMessageView,
  sendWhatsAppApiDocumentMessageView,
  sendWhatsAppApiImageMessageView,
  sendWhatsAppApiTemplateMessageView,
  sendWhatsAppApiTextMessageView,
  setWhatsAppApiDefaultPhoneNumberView
} from '../controllers/whatsappApiController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.use(requireAuth)

router.get('/status', getWhatsAppApiConnectionStatus)
router.post('/connect', connectWhatsAppApiView)
router.post('/phone-numbers/preview', previewWhatsAppApiPhoneNumbersView)
router.post('/phone-numbers/default', setWhatsAppApiDefaultPhoneNumberView)
router.post('/refresh', refreshWhatsAppApiView)
router.post('/disconnect', disconnectWhatsAppApiView)
router.post('/reset', resetWhatsAppApiCredentialsView)
router.get('/qr', getWhatsAppQrView)
router.post('/qr/connect', connectWhatsAppQrView)
router.post('/qr/disconnect', disconnectWhatsAppQrView)
router.get('/messages/scheduled', listScheduledChatMessagesView)
router.post('/messages/scheduled', scheduleChatMessageView)
router.delete('/messages/scheduled/:id', cancelScheduledChatMessageView)
router.post('/messages/text', sendWhatsAppApiTextMessageView)
router.post('/messages/image', sendWhatsAppApiImageMessageView)
router.post('/messages/document', sendWhatsAppApiDocumentMessageView)
router.post('/messages/audio', sendWhatsAppApiAudioMessageView)
router.get('/templates', getWhatsAppApiTemplatesView)
router.post('/templates/send', sendWhatsAppApiTemplateMessageView)

export default router
