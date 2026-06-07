import express from 'express'
import {
  saveConfig,
  getConfig,
  revealMetaToken,
  revealMetaPixelApiToken,
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
  savePixelToken
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

const router = express.Router()

router.use(requireAuth)

// Configuración
router.post('/config', saveConfig)
router.get('/config', getConfig)
router.delete('/config', deleteMetaConfig)
router.get('/config/reveal/access_token', revealMetaToken)
router.get('/config/reveal/pixel_api_token', revealMetaPixelApiToken)
router.get('/webhook-info', getMetaWebhookInfo)
router.get('/verify-token', verifyToken)

// Obtener datos de Meta para dropdowns
router.get('/ad-accounts', getAdAccounts)
router.get('/pixels', getPixels)
router.get('/pages', getPages)
router.get('/social-profiles', getSocialProfiles)

// Custom Values de HighLevel
router.get('/custom-values', getMetaCustomValues)
router.post('/save-and-sync', saveAndSyncMeta)
router.post('/save-pixel-token', savePixelToken)

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
