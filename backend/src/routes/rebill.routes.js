import express from 'express'
import {
  confirmPublicRebillPaymentView,
  createRebillPaymentLinkView,
  createRebillPaymentPlanView,
  createRebillSavedCardPaymentView,
  deleteRebillConfigView,
  getPublicRebillPaymentView,
  getRebillSavedPaymentSourcesView,
  getRebillConfigView,
  rebillWebhookView,
  saveRebillConfigView,
  testRebillConfigView
} from '../controllers/rebillPaymentsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import { requireFeature } from '../middleware/licenseMiddleware.js'

const router = express.Router()
const requirePaymentGatewaysFeature = requireFeature('payment_gateways')
const requirePaymentLinksFeature = requireFeature('payment_links')
const requireSavedPaymentMethodsFeature = requireFeature('saved_payment_methods')
const requirePaymentPlansFeature = requireFeature('payment_plans')

router.post('/webhook', rebillWebhookView)
router.get('/public/payments/:publicPaymentId', getPublicRebillPaymentView)
router.post('/public/payments/:publicPaymentId/confirm', confirmPublicRebillPaymentView)

router.use(requireAuth)

router.get('/config', requireModuleAccess('settings_payments'), requirePaymentGatewaysFeature, getRebillConfigView)
router.post('/config', requireModuleAccess('settings_payments'), requirePaymentGatewaysFeature, saveRebillConfigView)
router.delete('/config', requireModuleAccess('settings_payments'), requirePaymentGatewaysFeature, deleteRebillConfigView)
router.post('/config/test', requireModuleAccess('settings_payments'), requirePaymentGatewaysFeature, testRebillConfigView)
router.post('/payment-links', requireModuleAccess('payments'), requirePaymentLinksFeature, createRebillPaymentLinkView)
router.get('/contacts/:contactId/payment-sources', requireModuleAccess('payments'), requireSavedPaymentMethodsFeature, getRebillSavedPaymentSourcesView)
router.post('/saved-card-payments', requireModuleAccess('payments'), requireSavedPaymentMethodsFeature, createRebillSavedCardPaymentView)
router.post('/payment-plans', requireModuleAccess('payments'), requirePaymentPlansFeature, createRebillPaymentPlanView)

export default router
