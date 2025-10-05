import express from 'express'
import {
  updateWebhooks,
  checkWebhooks,
  cleanupWebhooks
} from '../controllers/webhookConfigController.js'

const router = express.Router()

// Verificar estado de webhooks
router.get('/check', checkWebhooks)

// Actualizar webhooks con URL correcta
router.post('/update', updateWebhooks)

// Limpiar webhooks duplicados/obsoletos
router.post('/cleanup', cleanupWebhooks)

export default router