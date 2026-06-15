import express from 'express'
import {
  cancelScheduledChatMessageView,
  completeMetaDirectConnectionView,
  connectWhatsAppApiView,
  connectWhatsAppQrView,
  disconnectWhatsAppApiView,
  disconnectMetaDirectConnectionView,
  disconnectWhatsAppQrView,
  getWhatsAppApiConnectionStatus,
  getMetaDirectConnectUrlView,
  getMetaDirectSetupPrefillView,
  getWhatsAppApiTemplatesView,
  getWhatsAppQrView,
  previewWhatsAppApiPhoneNumbersView,
  handleMetaDirectWebhookRelayView,
  refreshWhatsAppApiView,
  resetWhatsAppApiCredentialsView,
  listScheduledChatMessagesView,
  scheduleChatMessageView,
  sendWhatsAppApiAudioMessageView,
  sendWhatsAppApiDocumentMessageView,
  sendWhatsAppApiImageMessageView,
  sendWhatsAppApiTemplateMessageView,
  sendWhatsAppApiTextMessageView,
  sendMetaDirectTestMessageView,
  setWhatsAppActiveProviderView,
  setWhatsAppApiDefaultPhoneNumberView,
  syncMetaDirectHistoryView,
  testMetaDirectConnectionView,
  rerouteWhatsAppPhoneNumberContactsView,
  restoreWhatsAppPhoneNumberContactsView
} from '../controllers/whatsappApiController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.post('/meta/connect/complete', completeMetaDirectConnectionView)
router.post('/meta/setup-prefill', getMetaDirectSetupPrefillView)
router.post('/meta/webhook-relay', handleMetaDirectWebhookRelayView)

router.use(requireAuth)

router.get('/status', getWhatsAppApiConnectionStatus)
router.get('/meta/connect-url', getMetaDirectConnectUrlView)
router.post('/meta/provider', setWhatsAppActiveProviderView)
router.post('/meta/test', testMetaDirectConnectionView)
router.post('/meta/messages/test', sendMetaDirectTestMessageView)
router.post('/meta/sync-history', syncMetaDirectHistoryView)
router.post('/meta/disconnect', disconnectMetaDirectConnectionView)
router.post('/connect', connectWhatsAppApiView)
router.post('/phone-numbers/preview', previewWhatsAppApiPhoneNumbersView)
router.post('/phone-numbers/default', setWhatsAppApiDefaultPhoneNumberView)
router.post('/phone-numbers/:id/reroute', rerouteWhatsAppPhoneNumberContactsView)
router.post('/phone-numbers/:id/restore', restoreWhatsAppPhoneNumberContactsView)
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
