import express from 'express'
import {
  saveConfig,
  getConfig,
  syncAds,
  getSyncProgressEndpoint,
  updateRecent,
  getCampaigns,
  getSpendOverTime,
  getSyncStatus,
  getContactsByType
} from '../controllers/metaController.js'

const router = express.Router()

router.post('/config', saveConfig)
router.get('/config', getConfig)
router.post('/sync', syncAds)
router.get('/sync/progress', getSyncProgressEndpoint)
router.get('/sync/status', getSyncStatus)
router.post('/update-recent', updateRecent)
router.get('/campaigns', getCampaigns)
router.get('/spend-over-time', getSpendOverTime)
router.get('/contacts', getContactsByType)

export default router
