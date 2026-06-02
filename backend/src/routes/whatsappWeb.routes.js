import express from 'express'
import {
  connectWhatsAppWeb,
  disconnectWhatsAppWeb,
  getWhatsAppWebConnectionStatus,
  getWhatsAppWebMessages
} from '../controllers/whatsappWebController.js'

const router = express.Router()

router.get('/status', getWhatsAppWebConnectionStatus)
router.post('/connect', connectWhatsAppWeb)
router.post('/disconnect', disconnectWhatsAppWeb)
router.get('/messages', getWhatsAppWebMessages)

export default router

