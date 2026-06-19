import express from 'express'
import {
  createPublicStripePaymentIntentView,
  createStripePaymentLinkView,
  deleteStripeConfigView,
  getPublicStripePaymentView,
  getStripeConfigView,
  saveStripeConfigView,
  stripeWebhookView,
  testStripeConfigView
} from '../controllers/stripePaymentsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = express.Router()

router.post('/webhook', stripeWebhookView)
router.get('/public/payments/:publicPaymentId', getPublicStripePaymentView)
router.post('/public/payments/:publicPaymentId/intent', createPublicStripePaymentIntentView)

router.use(requireAuth)

router.get('/config', requireModuleAccess('settings_payments'), getStripeConfigView)
router.post('/config', requireModuleAccess('settings_payments'), saveStripeConfigView)
router.delete('/config', requireModuleAccess('settings_payments'), deleteStripeConfigView)
router.post('/config/test', requireModuleAccess('settings_payments'), testStripeConfigView)
router.post('/payment-links', requireModuleAccess('payments'), createStripePaymentLinkView)

export default router
