import express from 'express'
import {
  cancelScheduledChatMessageView,
  completeMetaDirectConnectionView,
  connectWhatsAppApiView,
  connectWhatsAppQrView,
  createWhatsAppQrPhoneNumberView,
  disconnectWhatsAppApiView,
  disconnectMetaDirectConnectionView,
  disconnectWhatsAppQrView,
  deleteWhatsAppQrPhoneNumberView,
  getWhatsAppApiConnectionStatus,
  getMetaDirectConnectUrlView,
  getMetaDirectSetupPrefillView,
  getWhatsAppMetaBusinessAccountView,
  getWhatsAppApiTemplatesView,
  getWhatsAppQrDripSettingsView,
  getWhatsAppQrView,
  previewWhatsAppApiPhoneNumbersView,
  handleMetaDirectWebhookRelayView,
  refreshWhatsAppApiView,
  resetWhatsAppApiCredentialsView,
  backfillWhatsAppContactProfilePicturesView,
  listScheduledChatMessagesView,
  scheduleChatMessageView,
  sendWhatsAppApiAudioMessageView,
  sendWhatsAppApiDocumentMessageView,
  sendWhatsAppApiImageMessageView,
  sendWhatsAppApiInteractiveMessageView,
  sendWhatsAppApiLocationMessageView,
  sendWhatsAppApiReactionMessageView,
  sendWhatsAppApiTemplateMessageView,
  sendWhatsAppApiTextMessageView,
  sendWhatsAppApiVideoMessageView,
  sendMetaDirectTestMessageView,
  sendMetaSocialTextMessageView,
  sendMetaSocialReactionMessageView,
  sendMetaSocialCommentReplyView,
  listMetaSocialPostsView,
  setWhatsAppActiveProviderView,
  setWhatsAppApiDefaultPhoneNumberView,
  syncMetaDirectHistoryView,
  testMetaDirectConnectionView,
  updateWhatsAppQrDripSettingsView,
  rerouteWhatsAppPhoneNumberContactsView,
  restoreWhatsAppPhoneNumberContactsView
} from '../controllers/whatsappApiController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = express.Router()

router.post('/meta/connect/complete', completeMetaDirectConnectionView)
router.post('/meta/setup-prefill', getMetaDirectSetupPrefillView)
router.post('/meta/webhook-relay', handleMetaDirectWebhookRelayView)

router.use(requireAuth)

router.get('/status', getWhatsAppApiConnectionStatus)
router.get('/meta/business-account', getWhatsAppMetaBusinessAccountView)
router.get('/meta/connect-url', getMetaDirectConnectUrlView)
router.post('/meta/provider', setWhatsAppActiveProviderView)
router.post('/meta/test', testMetaDirectConnectionView)
router.post('/meta/messages/test', sendMetaDirectTestMessageView)
router.post('/meta/social/messages/text', sendMetaSocialTextMessageView)
router.post('/meta/social/messages/reaction', sendMetaSocialReactionMessageView)
router.post('/meta/social/comments/reply', sendMetaSocialCommentReplyView)
router.get('/meta/social/posts', listMetaSocialPostsView)
router.post('/meta/sync-history', syncMetaDirectHistoryView)
router.post('/meta/disconnect', disconnectMetaDirectConnectionView)
router.post('/connect', connectWhatsAppApiView)
router.post('/phone-numbers/preview', previewWhatsAppApiPhoneNumbersView)
router.post('/phone-numbers/default', setWhatsAppApiDefaultPhoneNumberView)
router.post('/phone-numbers/:id/reroute', rerouteWhatsAppPhoneNumberContactsView)
router.post('/phone-numbers/:id/restore', restoreWhatsAppPhoneNumberContactsView)
router.post('/refresh', refreshWhatsAppApiView)
router.post('/contacts/profile-pictures/backfill', requireModuleAccess('settings_whatsapp'), backfillWhatsAppContactProfilePicturesView)
router.post('/disconnect', disconnectWhatsAppApiView)
router.post('/reset', resetWhatsAppApiCredentialsView)
router.get('/qr/drip-settings', getWhatsAppQrDripSettingsView)
router.put('/qr/drip-settings', updateWhatsAppQrDripSettingsView)
router.get('/qr', getWhatsAppQrView)
router.post('/qr/phone-numbers', createWhatsAppQrPhoneNumberView)
router.delete('/qr/phone-numbers/:id', deleteWhatsAppQrPhoneNumberView)
router.post('/qr/connect', connectWhatsAppQrView)
router.post('/qr/disconnect', disconnectWhatsAppQrView)
router.get('/messages/scheduled', listScheduledChatMessagesView)
router.post('/messages/scheduled', scheduleChatMessageView)
router.delete('/messages/scheduled/:id', cancelScheduledChatMessageView)
router.post('/messages/text', sendWhatsAppApiTextMessageView)
router.post('/messages/reaction', sendWhatsAppApiReactionMessageView)
router.post('/messages/location', sendWhatsAppApiLocationMessageView)
router.post('/messages/interactive', sendWhatsAppApiInteractiveMessageView)
router.post('/messages/image', sendWhatsAppApiImageMessageView)
router.post('/messages/document', sendWhatsAppApiDocumentMessageView)
router.post('/messages/video', sendWhatsAppApiVideoMessageView)
router.post('/messages/audio', sendWhatsAppApiAudioMessageView)
router.get('/templates', getWhatsAppApiTemplatesView)
router.post('/templates/send', sendWhatsAppApiTemplateMessageView)

export default router
