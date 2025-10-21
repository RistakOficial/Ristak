import express from 'express'
import {
  saveConfig,
  getConfig,
  revealMetaToken,
  syncAds,
  getSyncProgressEndpoint,
  updateRecent,
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
  getPixels
} from '../controllers/metaController.js'

const router = express.Router()

// Configuración
router.post('/config', saveConfig)
router.get('/config', getConfig)
router.get('/config/reveal/access_token', revealMetaToken)
router.get('/verify-token', verifyToken)

// Obtener datos de Meta para dropdowns
router.get('/ad-accounts', getAdAccounts)
router.get('/pixels', getPixels)

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
router.get('/spend-over-time', getSpendOverTime)
router.get('/contacts', getContactsByType)
router.get('/leads-over-time', getLeadsOverTime)
router.get('/appointments-over-time', getAppointmentsOverTime)
router.get('/visitors-over-time', getVisitorsOverTime)
router.get('/funnel-metrics', getFunnelMetrics)

export default router
