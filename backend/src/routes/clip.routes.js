import express from 'express'
import {
  clipWebhookView,
  createClipPaymentLinkView,
  createPublicClipCardPaymentView,
  deleteClipConfigView,
  getClipConfigView,
  getPublicClipPaymentView,
  refreshPublicClipPaymentView,
  saveClipConfigView,
  testClipConfigView
} from '../controllers/clipPaymentsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = express.Router()

router.post('/webhook', clipWebhookView)
router.get('/public/payments/:publicPaymentId', getPublicClipPaymentView)
router.post('/public/payments/:publicPaymentId/card', createPublicClipCardPaymentView)
router.post('/public/payments/:publicPaymentId/refresh', refreshPublicClipPaymentView)

router.use(requireAuth)

router.get('/config', requireModuleAccess('settings_payments'), getClipConfigView)
router.post('/config', requireModuleAccess('settings_payments'), saveClipConfigView)
router.delete('/config', requireModuleAccess('settings_payments'), deleteClipConfigView)
router.post('/config/test', requireModuleAccess('settings_payments'), testClipConfigView)
router.post('/payment-links', requireModuleAccess('payments'), createClipPaymentLinkView)

export default router
