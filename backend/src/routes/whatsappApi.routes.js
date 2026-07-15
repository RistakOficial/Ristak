import express from 'express'
import {
  cancelScheduledChatMessageView,
  completeMetaDirectConnectionView,
  completeMetaDirectEmbeddedSignupView,
  connectWhatsAppApiView,
  connectWhatsAppQrView,
  createWhatsAppQrPhoneNumberView,
  disconnectWhatsAppApiView,
  disconnectMetaDirectConnectionView,
  disconnectWhatsAppPhoneNumberView,
  disconnectWhatsAppQrView,
  deleteWhatsAppQrPhoneNumberView,
  getWhatsAppApiConnectionStatus,
  getMetaDirectConnectUrlView,
  prepareMetaDirectEmbeddedSignupView,
  getMetaDirectSetupPrefillView,
  getWhatsAppMetaBusinessAccountView,
  getWhatsAppApiTemplatesView,
  getWhatsAppQrDripSettingsView,
  getWhatsAppQrView,
  previewWhatsAppApiPhoneNumbersView,
  handleMetaDirectWebhookRelayView,
  refreshWhatsAppApiView,
  repairDefaultWhatsAppApiTemplatesView,
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
  sendMetaSocialAudioMessageView,
  sendMetaSocialAttachmentMessageView,
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
import { requireFeature } from '../middleware/licenseMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = express.Router()
const requireChatAccess = requireModuleAccess('chat')

function requireFeatureAndModule(feature, moduleKey) {
  const featureGate = requireFeature(feature)
  const moduleGate = requireModuleAccess(moduleKey)
  return (req, res, next) => featureGate(req, res, (error) => {
    if (error) return next(error)
    return moduleGate(req, res, next)
  })
}

const requireWhatsAppApiAccess = requireFeature('whatsapp_api')
const requireWhatsAppApiChatAccess = requireFeatureAndModule('whatsapp_api', 'chat')
const requireWhatsAppTemplatesChatAccess = requireFeatureAndModule('whatsapp_templates', 'chat')
const requireMetaSocialChatAccess = requireFeatureAndModule('campaigns', 'chat')

function requireWhatsAppMessageTransportAccess(req, res, next) {
  if (String(req.body?.transport || '').trim().toLowerCase() === 'qr') {
    return requireChatAccess(req, res, next)
  }

  return requireWhatsAppApiChatAccess(req, res, next)
}

function requireScheduledChatMessageAccess(req, res, next) {
  const provider = String(req.body?.provider || '').trim().toLowerCase()
  const messageType = String(req.body?.messageType || '').trim().toLowerCase()
  const hasTemplate = messageType === 'template' || Boolean(req.body?.templateId || req.body?.templateName)

  if (hasTemplate) return requireWhatsAppTemplatesChatAccess(req, res, next)
  if (provider === 'highlevel') return requireFeatureAndModule('highlevel_integration', 'chat')(req, res, next)
  return requireWhatsAppMessageTransportAccess(req, res, next)
}

router.post('/meta/connect/complete', requireWhatsAppApiAccess, completeMetaDirectConnectionView)
router.post('/meta/setup-prefill', requireWhatsAppApiAccess, getMetaDirectSetupPrefillView)
router.post('/meta/webhook-relay', requireWhatsAppApiAccess, handleMetaDirectWebhookRelayView)

router.use(requireAuth)

router.get('/status', getWhatsAppApiConnectionStatus)
router.get('/meta/business-account', requireWhatsAppApiAccess, getWhatsAppMetaBusinessAccountView)
router.get('/meta/connect-url', requireWhatsAppApiAccess, getMetaDirectConnectUrlView)
router.get('/meta/signup-session', requireWhatsAppApiAccess, prepareMetaDirectEmbeddedSignupView)
router.post('/meta/signup-complete', requireWhatsAppApiAccess, completeMetaDirectEmbeddedSignupView)
router.post('/meta/provider', requireWhatsAppApiAccess, setWhatsAppActiveProviderView)
router.post('/meta/test', requireWhatsAppApiAccess, testMetaDirectConnectionView)
router.post('/meta/messages/test', requireWhatsAppApiAccess, sendMetaDirectTestMessageView)
router.post('/meta/social/messages/text', requireMetaSocialChatAccess, sendMetaSocialTextMessageView)
router.post('/meta/social/messages/audio', requireMetaSocialChatAccess, sendMetaSocialAudioMessageView)
router.post('/meta/social/messages/attachment', requireMetaSocialChatAccess, sendMetaSocialAttachmentMessageView)
router.post('/meta/social/messages/reaction', requireMetaSocialChatAccess, sendMetaSocialReactionMessageView)
router.post('/meta/social/comments/reply', requireMetaSocialChatAccess, sendMetaSocialCommentReplyView)
router.get('/meta/social/posts', requireFeature('campaigns'), listMetaSocialPostsView)
router.post('/meta/sync-history', requireWhatsAppApiAccess, syncMetaDirectHistoryView)
router.post('/meta/disconnect', requireWhatsAppApiAccess, disconnectMetaDirectConnectionView)
router.post('/connect', requireWhatsAppApiAccess, connectWhatsAppApiView)
router.post('/phone-numbers/preview', requireWhatsAppApiAccess, previewWhatsAppApiPhoneNumbersView)
router.post('/phone-numbers/default', requireWhatsAppApiAccess, setWhatsAppApiDefaultPhoneNumberView)
router.post('/phone-numbers/:id/disconnect', disconnectWhatsAppPhoneNumberView)
router.post('/phone-numbers/:id/reroute', requireWhatsAppApiAccess, rerouteWhatsAppPhoneNumberContactsView)
router.post('/phone-numbers/:id/restore', requireWhatsAppApiAccess, restoreWhatsAppPhoneNumberContactsView)
router.post('/refresh', requireWhatsAppApiAccess, refreshWhatsAppApiView)
router.post('/contacts/profile-pictures/backfill', requireWhatsAppApiAccess, requireModuleAccess('settings_whatsapp'), backfillWhatsAppContactProfilePicturesView)
router.post('/disconnect', requireWhatsAppApiAccess, disconnectWhatsAppApiView)
router.post('/reset', requireWhatsAppApiAccess, resetWhatsAppApiCredentialsView)
router.get('/qr/drip-settings', getWhatsAppQrDripSettingsView)
router.put('/qr/drip-settings', updateWhatsAppQrDripSettingsView)
router.get('/qr', getWhatsAppQrView)
router.post('/qr/phone-numbers', createWhatsAppQrPhoneNumberView)
router.delete('/qr/phone-numbers/:id', deleteWhatsAppQrPhoneNumberView)
router.post('/qr/connect', connectWhatsAppQrView)
router.post('/qr/disconnect', disconnectWhatsAppQrView)
router.get('/messages/scheduled', requireChatAccess, listScheduledChatMessagesView)
router.post('/messages/scheduled', requireScheduledChatMessageAccess, scheduleChatMessageView)
router.delete('/messages/scheduled/:id', requireChatAccess, cancelScheduledChatMessageView)
router.post('/messages/text', requireWhatsAppMessageTransportAccess, sendWhatsAppApiTextMessageView)
router.post('/messages/reaction', requireWhatsAppMessageTransportAccess, sendWhatsAppApiReactionMessageView)
router.post('/messages/location', requireWhatsAppMessageTransportAccess, sendWhatsAppApiLocationMessageView)
router.post('/messages/interactive', requireWhatsAppMessageTransportAccess, sendWhatsAppApiInteractiveMessageView)
router.post('/messages/image', requireWhatsAppMessageTransportAccess, sendWhatsAppApiImageMessageView)
router.post('/messages/document', requireWhatsAppMessageTransportAccess, sendWhatsAppApiDocumentMessageView)
router.post('/messages/video', requireWhatsAppMessageTransportAccess, sendWhatsAppApiVideoMessageView)
router.post('/messages/audio', requireWhatsAppMessageTransportAccess, sendWhatsAppApiAudioMessageView)
router.get('/templates', requireFeature('whatsapp_templates'), getWhatsAppApiTemplatesView)
router.post('/templates/repair-defaults', requireWhatsAppApiAccess, requireModuleAccess('settings_whatsapp'), repairDefaultWhatsAppApiTemplatesView)
router.post('/templates/send', requireWhatsAppTemplatesChatAccess, sendWhatsAppApiTemplateMessageView)

export default router
