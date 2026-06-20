import express from 'express'
import {
  createStripeConnectUrlView,
  createPublicStripePaymentIntentView,
  createStripePaymentPlanView,
  createStripeSavedCardPaymentView,
  createStripePaymentLinkView,
  deleteStripeConfigView,
  getPublicStripePaymentView,
  getStripeConfigView,
  getStripeSavedPaymentMethodsView,
  saveStripeConfigView,
  setStripeConnectModeView,
  stripeConnectCallbackView,
  stripeWebhookView,
  syncStripeConnectView,
  testStripeConfigView
} from '../controllers/stripePaymentsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = express.Router()

router.post('/webhook', stripeWebhookView)
router.get('/connect/callback', stripeConnectCallbackView)
router.get('/public/payments/:publicPaymentId', getPublicStripePaymentView)
router.post('/public/payments/:publicPaymentId/intent', createPublicStripePaymentIntentView)

router.use(requireAuth)

router.get('/config', requireModuleAccess('settings_payments'), getStripeConfigView)
router.post('/config', requireModuleAccess('settings_payments'), saveStripeConfigView)
router.delete('/config', requireModuleAccess('settings_payments'), deleteStripeConfigView)
router.post('/config/test', requireModuleAccess('settings_payments'), testStripeConfigView)
router.post('/connect/url', requireModuleAccess('settings_payments'), createStripeConnectUrlView)
router.post('/connect/sync', requireModuleAccess('settings_payments'), syncStripeConnectView)
router.post('/connect/mode', requireModuleAccess('settings_payments'), setStripeConnectModeView)
router.post('/payment-links', requireModuleAccess('payments'), createStripePaymentLinkView)
router.post('/payment-plans', requireModuleAccess('payments'), createStripePaymentPlanView)
router.get('/contacts/:contactId/payment-methods', requireModuleAccess('payments'), getStripeSavedPaymentMethodsView)
router.post('/saved-card-payments', requireModuleAccess('payments'), createStripeSavedCardPaymentView)

export default router
