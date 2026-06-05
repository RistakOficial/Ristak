import express from 'express'
import {
  connectWhatsAppApiView,
  disconnectWhatsAppApiView,
  getWhatsAppApiConnectionStatus,
  refreshWhatsAppApiView,
  resetWhatsAppApiCredentialsView,
  sendWhatsAppApiTextMessageView
} from '../controllers/whatsappApiController.js'

const router = express.Router()

router.get('/status', getWhatsAppApiConnectionStatus)
router.post('/connect', connectWhatsAppApiView)
router.post('/refresh', refreshWhatsAppApiView)
router.post('/disconnect', disconnectWhatsAppApiView)
router.post('/reset', resetWhatsAppApiCredentialsView)
router.post('/messages/text', sendWhatsAppApiTextMessageView)

export default router
