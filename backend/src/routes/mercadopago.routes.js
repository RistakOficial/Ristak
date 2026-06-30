import express from 'express'
import {
  createMercadoPagoConnectUrlView,
  createMercadoPagoPaymentLinkView,
  createMercadoPagoPaymentPlanView,
  createPublicMercadoPagoCardPaymentView,
  deleteMercadoPagoConfigView,
  deleteMercadoPagoSubscriptionTestCredentialsView,
  ensurePublicMercadoPagoPreferenceView,
  getMercadoPagoConfigView,
  getPublicMercadoPagoPaymentView,
  mercadoPagoSubscriptionReturnView,
  mercadoPagoWebhookView,
  saveMercadoPagoSubscriptionTestCredentialsView,
  setMercadoPagoModeView,
  syncMercadoPagoConnectView,
  testMercadoPagoConfigView
} from '../controllers/mercadoPagoPaymentsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import { requireFeature } from '../middleware/licenseMiddleware.js'

const router = express.Router()
const requirePaymentPlansFeature = requireFeature('payment_plans')

router.post('/webhook', mercadoPagoWebhookView)
router.get('/subscriptions/return', mercadoPagoSubscriptionReturnView)
router.get('/public/payments/:publicPaymentId', getPublicMercadoPagoPaymentView)
router.post('/public/payments/:publicPaymentId/preference', ensurePublicMercadoPagoPreferenceView)
router.post('/public/payments/:publicPaymentId/card', createPublicMercadoPagoCardPaymentView)

router.use(requireAuth)

router.get('/config', requireModuleAccess('settings_payments'), getMercadoPagoConfigView)
router.delete('/config', requireModuleAccess('settings_payments'), deleteMercadoPagoConfigView)
router.post('/config/test', requireModuleAccess('settings_payments'), testMercadoPagoConfigView)
router.post('/config/subscription-test-credentials', requireModuleAccess('settings_payments'), saveMercadoPagoSubscriptionTestCredentialsView)
router.delete('/config/subscription-test-credentials', requireModuleAccess('settings_payments'), deleteMercadoPagoSubscriptionTestCredentialsView)
router.post('/connect/url', requireModuleAccess('settings_payments'), createMercadoPagoConnectUrlView)
router.post('/connect/sync', requireModuleAccess('settings_payments'), syncMercadoPagoConnectView)
router.post('/connect/mode', requireModuleAccess('settings_payments'), setMercadoPagoModeView)
router.post('/payment-links', requireModuleAccess('payments'), createMercadoPagoPaymentLinkView)
router.post('/payment-plans', requireModuleAccess('payments'), requirePaymentPlansFeature, createMercadoPagoPaymentPlanView)

export default router
