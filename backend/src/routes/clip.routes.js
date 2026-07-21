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
import { requireFeature } from '../middleware/licenseMiddleware.js'

const router = express.Router()
const requirePaymentGatewaysFeature = requireFeature('payment_gateways')
const requirePaymentLinksFeature = requireFeature('payment_links')

router.post('/webhook', clipWebhookView)
router.get('/public/payments/:publicPaymentId', getPublicClipPaymentView)
router.post('/public/payments/:publicPaymentId/card', createPublicClipCardPaymentView)
router.post('/public/payments/:publicPaymentId/refresh', refreshPublicClipPaymentView)

router.use(requireAuth)

router.get('/config', requireModuleAccess('settings_payments'), requirePaymentGatewaysFeature, getClipConfigView)
router.post('/config', requireModuleAccess('settings_payments'), requirePaymentGatewaysFeature, saveClipConfigView)
router.delete('/config', requireModuleAccess('settings_payments'), requirePaymentGatewaysFeature, deleteClipConfigView)
router.post('/config/test', requireModuleAccess('settings_payments'), requirePaymentGatewaysFeature, testClipConfigView)
router.post('/payment-links', requireModuleAccess('payments'), requirePaymentLinksFeature, createClipPaymentLinkView)

export default router
