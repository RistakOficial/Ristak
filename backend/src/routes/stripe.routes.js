import express from 'express'
import {
  createPublicStripePaymentIntentView,
  createPublicStripeSubscriptionCheckoutView,
  createStripePaymentPlanView,
  createStripeSavedCardPaymentView,
  createStripePaymentLinkView,
  deleteStripeConfigView,
  getPublicStripePaymentView,
  getStripeConfigView,
  getStripeSavedPaymentMethodsView,
  refreshStripeSavedPaymentMethodsView,
  confirmPublicStripeInstallmentPaymentView,
  preparePublicStripeInstallmentPlansView,
  saveStripeConfigView,
  stripeWebhookView,
  testStripeConfigView
} from '../controllers/stripePaymentsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import { requireFeature } from '../middleware/licenseMiddleware.js'

const router = express.Router()
const requirePaymentPlansFeature = requireFeature('payment_plans')
const requireSubscriptionsFeature = requireFeature('subscriptions')

router.post('/webhook', stripeWebhookView)
router.get('/public/payments/:publicPaymentId', getPublicStripePaymentView)
router.post('/public/payments/:publicPaymentId/intent', createPublicStripePaymentIntentView)
router.post('/public/payments/:publicPaymentId/installment-plans', preparePublicStripeInstallmentPlansView)
router.post('/public/payments/:publicPaymentId/installment-confirm', confirmPublicStripeInstallmentPaymentView)
router.post('/public/payments/:publicPaymentId/subscription-checkout', requireSubscriptionsFeature, createPublicStripeSubscriptionCheckoutView)

router.use(requireAuth)

router.get('/config', requireModuleAccess('settings_payments'), getStripeConfigView)
router.post('/config', requireModuleAccess('settings_payments'), saveStripeConfigView)
router.delete('/config', requireModuleAccess('settings_payments'), deleteStripeConfigView)
router.post('/config/test', requireModuleAccess('settings_payments'), testStripeConfigView)
router.post('/payment-links', requireModuleAccess('payments'), createStripePaymentLinkView)
router.post('/payment-plans', requireModuleAccess('payments'), requirePaymentPlansFeature, createStripePaymentPlanView)
router.get('/contacts/:contactId/payment-methods', requireModuleAccess('payments'), getStripeSavedPaymentMethodsView)
router.post('/contacts/:contactId/payment-methods/refresh', requireModuleAccess('payments'), refreshStripeSavedPaymentMethodsView)
router.post('/saved-card-payments', requireModuleAccess('payments'), createStripeSavedCardPaymentView)

export default router
