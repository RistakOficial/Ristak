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

const router = express.Router()

router.get('/public/payments/:publicPaymentId', getPublicConektaPaymentView)
router.post('/public/payments/:publicPaymentId/card', createPublicConektaCardPaymentView)
router.post('/public/payments/:publicPaymentId/subscription', createPublicConektaSubscriptionView)
// (PAY2-002) Webhook público de Conekta (reconcilia pagos pendientes 3DS/OXXO/SPEI).
router.post('/webhook', handleConektaWebhookView)

router.use(requireAuth)

router.get('/config', requireModuleAccess('settings_payments'), getConektaConfigView)
router.post('/config', requireModuleAccess('settings_payments'), saveConektaConfigView)
router.delete('/config', requireModuleAccess('settings_payments'), deleteConektaConfigView)
router.post('/config/test', requireModuleAccess('settings_payments'), testConektaConfigView)
router.post('/payment-links', requireModuleAccess('payments'), createConektaPaymentLinkView)
router.post('/payment-plans', requireModuleAccess('payments'), createConektaPaymentPlanView)
router.get('/contacts/:contactId/payment-sources', requireModuleAccess('payments'), getConektaSavedPaymentSourcesView)
router.post('/saved-card-payments', requireModuleAccess('payments'), createConektaSavedCardPaymentView)

export default router
