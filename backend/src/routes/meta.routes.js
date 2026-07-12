import express from 'express'
import {
  saveConfig,
  getConfig,
  revealMetaToken,
  getMetaWebhookInfo,
  syncAds,
  getSyncProgressEndpoint,
  updateRecent,
  getCreativePreview,
  getAdCreativeMedia,
  getCampaigns,
  getSpendOverTime,
  getSyncStatus,
  getContactsByType,
  verifyToken,
  getLeadsOverTime,
  getAppointmentsOverTime,
  getVisitorsOverTime,
  getFunnelMetrics,
  syncFromHighLevel,
  getMetaCustomValues,
  saveAndSyncMeta,
  getAdAccounts,
  getPixels,
  getPages,
  getSocialProfiles,
  deleteMetaConfig,
  sendMetaTestEvent,
  createMetaPixelTestLink,
  subscribeMetaSocialMessaging,
  getMetaSocialMessagingSubscription,
  getMetaSocialMessagingSetup,
  saveMetaMessengerUserToken
} from '../controllers/metaController.js'
import {
  createCampaignBuilderDraft,
  executeCampaignBuilderDraft,
  getCampaignBuilderCapabilities,
  getCampaignBuilderDraft,
  getCampaignBuilderDraftLogs,
  getCampaignBuilderTemplate,
  getCampaignBuilderTemplates,
  previewCampaignBuilderDraft
} from '../controllers/metaCampaignBuilderController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import {
  completeMetaOAuth,
  createMetaOAuthConnectUrl,
  disconnectMetaOAuth,
  finalizeMetaOAuth,
  getMetaOAuthStatus
} from '../controllers/metaOAuthController.js'

const router = express.Router()

router.use(requireAuth)
router.use(requireModuleAccess('campaigns'))

// Facebook Login for Business (BISU) administrado por Ristak Installer.
router.get('/oauth/:integrationKind/status', getMetaOAuthStatus)
router.post('/oauth/:integrationKind/connect-url', createMetaOAuthConnectUrl)
router.post('/oauth/:integrationKind/complete', completeMetaOAuth)
router.post('/oauth/:integrationKind/finalize', finalizeMetaOAuth)
router.post('/oauth/:integrationKind/disconnect', disconnectMetaOAuth)

// Aliases legacy del OAuth combinado. No se usan para conexiones nuevas.
router.get('/oauth/status', getMetaOAuthStatus)
router.post('/oauth/connect-url', createMetaOAuthConnectUrl)
router.post('/oauth/complete', completeMetaOAuth)
router.post('/oauth/finalize', finalizeMetaOAuth)
router.post('/oauth/disconnect', disconnectMetaOAuth)

// Configuración
router.post('/config', saveConfig)
router.get('/config', getConfig)
router.delete('/config', deleteMetaConfig)
router.get('/config/reveal/access_token', revealMetaToken)
router.get('/webhook-info', getMetaWebhookInfo)
router.get('/verify-token', verifyToken)
// Suscribir la Página al webhook de mensajería (Messenger/Instagram DM)
router.post('/social/messaging/subscribe', subscribeMetaSocialMessaging)
router.get('/social/messaging/subscription', getMetaSocialMessagingSubscription)
router.get('/social/messaging/setup', getMetaSocialMessagingSetup)
router.post('/social/messaging/user-token', saveMetaMessengerUserToken)
router.post('/test-event', sendMetaTestEvent)
router.post('/pixel-test/link', createMetaPixelTestLink)

// Obtener datos de Meta para dropdowns
router.get('/ad-accounts', getAdAccounts)
router.get('/pixels', getPixels)
router.get('/pages', getPages)
router.get('/social-profiles', getSocialProfiles)

// Custom Values de HighLevel
router.get('/custom-values', getMetaCustomValues)
router.post('/save-and-sync', saveAndSyncMeta)

// Sincronización
router.post('/sync', syncAds)
router.post('/sync-from-highlevel', syncFromHighLevel)
router.get('/sync/progress', getSyncProgressEndpoint)
router.get('/sync/status', getSyncStatus)
router.post('/update-recent', updateRecent)

// Datos
router.get('/campaigns', getCampaigns)
router.get('/creative-preview/:creativeId', getCreativePreview)
router.get('/ad-creative-media/:adId', getAdCreativeMedia)
router.get('/spend-over-time', getSpendOverTime)
router.get('/contacts', getContactsByType)
router.get('/leads-over-time', getLeadsOverTime)
router.get('/appointments-over-time', getAppointmentsOverTime)
router.get('/visitors-over-time', getVisitorsOverTime)
router.get('/funnel-metrics', getFunnelMetrics)

// Campaign Builder con Meta Ads MCP
router.get('/campaign-builder/capabilities', getCampaignBuilderCapabilities)
router.get('/campaign-builder/templates', getCampaignBuilderTemplates)
router.get('/campaign-builder/templates/:templateId', getCampaignBuilderTemplate)
router.post('/campaign-builder/drafts', createCampaignBuilderDraft)
router.get('/campaign-builder/drafts/:draftId', getCampaignBuilderDraft)
router.post('/campaign-builder/drafts/:draftId/preview', previewCampaignBuilderDraft)
router.post('/campaign-builder/drafts/:draftId/execute', executeCampaignBuilderDraft)
router.get('/campaign-builder/drafts/:draftId/logs', getCampaignBuilderDraftLogs)

export default router
