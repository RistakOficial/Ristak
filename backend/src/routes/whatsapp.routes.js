import express from 'express'
import {
  connectCloudApi,
  disconnectCloudApi,
  getConfig,
  refreshStatus,
  saveConfig
} from '../controllers/whatsappController.js'

const router = express.Router()

router.get('/config', getConfig)
router.post('/config', saveConfig)
router.post('/cloud-api/connect', connectCloudApi)
router.post('/cloud-api/disconnect', disconnectCloudApi)
router.post('/status/refresh', refreshStatus)

export default router
