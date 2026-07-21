import express from 'express'
import {
  createConektaPaymentLinkView,
  createConektaPaymentPlanView,
  createConektaSavedCardPaymentView,
  createPublicConektaCardPaymentView,
  createPublicConektaSubscriptionView,
  deleteConektaConfigView,
  getConektaConfigView,
  getConektaSavedPaymentSourcesView,
  getPublicConektaPaymentView,
  handleConektaWebhookView,
  saveConektaConfigView,
  testConektaConfigView
} from '../controllers/conektaPaymentsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import { requireFeature } from '../middleware/licenseMiddleware.js'

const router = express.Router()
const requirePaymentGatewaysFeature = requireFeature('payment_gateways')
const requirePaymentLinksFeature = requireFeature('payment_links')
const requireSavedPaymentMethodsFeature = requireFeature('saved_payment_methods')
const requirePaymentPlansFeature = requireFeature('payment_plans')
const requireSubscriptionsFeature = requireFeature('subscriptions')

router.get('/public/payments/:publicPaymentId', getPublicConektaPaymentView)
router.post('/public/payments/:publicPaymentId/card', createPublicConektaCardPaymentView)
router.post('/public/payments/:publicPaymentId/subscription', requireSubscriptionsFeature, createPublicConektaSubscriptionView)
// (PAY2-002) Webhook público de Conekta (reconcilia pagos pendientes 3DS/OXXO/SPEI).
router.post('/webhook', handleConektaWebhookView)

router.use(requireAuth)

router.get('/config', requireModuleAccess('settings_payments'), requirePaymentGatewaysFeature, getConektaConfigView)
router.post('/config', requireModuleAccess('settings_payments'), requirePaymentGatewaysFeature, saveConektaConfigView)
router.delete('/config', requireModuleAccess('settings_payments'), requirePaymentGatewaysFeature, deleteConektaConfigView)
router.post('/config/test', requireModuleAccess('settings_payments'), requirePaymentGatewaysFeature, testConektaConfigView)
router.post('/payment-links', requireModuleAccess('payments'), requirePaymentLinksFeature, createConektaPaymentLinkView)
router.post('/payment-plans', requireModuleAccess('payments'), requirePaymentPlansFeature, createConektaPaymentPlanView)
router.get('/contacts/:contactId/payment-sources', requireModuleAccess('payments'), requireSavedPaymentMethodsFeature, getConektaSavedPaymentSourcesView)
router.post('/saved-card-payments', requireModuleAccess('payments'), requireSavedPaymentMethodsFeature, createConektaSavedCardPaymentView)

export default router
