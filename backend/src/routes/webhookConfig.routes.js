import express from 'express'
import {
  updateWebhooks,
  checkWebhooks,
  cleanupWebhooks
} from '../controllers/webhookConfigController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.use(requireAuth)

// Verificar estado de webhooks
router.get('/check', checkWebhooks)

// Actualizar webhooks con URL correcta
router.post('/update', updateWebhooks)

// Limpiar webhooks duplicados/obsoletos
router.post('/cleanup', cleanupWebhooks)

export default router
