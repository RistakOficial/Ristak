import express from 'express'
import {
  createMercadoPagoConnectUrlView,
  createMercadoPagoPaymentLinkView,
  createMercadoPagoPaymentPlanView,
  deleteMercadoPagoConfigView,
  ensurePublicMercadoPagoPreferenceView,
  getMercadoPagoConfigView,
  getPublicMercadoPagoPaymentView,
  mercadoPagoWebhookView,
  setMercadoPagoModeView,
  syncMercadoPagoConnectView,
  testMercadoPagoConfigView
} from '../controllers/mercadoPagoPaymentsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = express.Router()

router.post('/webhook', mercadoPagoWebhookView)
router.get('/public/payments/:publicPaymentId', getPublicMercadoPagoPaymentView)
router.post('/public/payments/:publicPaymentId/preference', ensurePublicMercadoPagoPreferenceView)

router.use(requireAuth)

router.get('/config', requireModuleAccess('settings_payments'), getMercadoPagoConfigView)
router.delete('/config', requireModuleAccess('settings_payments'), deleteMercadoPagoConfigView)
router.post('/config/test', requireModuleAccess('settings_payments'), testMercadoPagoConfigView)
router.post('/connect/url', requireModuleAccess('settings_payments'), createMercadoPagoConnectUrlView)
router.post('/connect/sync', requireModuleAccess('settings_payments'), syncMercadoPagoConnectView)
router.post('/connect/mode', requireModuleAccess('settings_payments'), setMercadoPagoModeView)
router.post('/payment-links', requireModuleAccess('payments'), createMercadoPagoPaymentLinkView)
router.post('/payment-plans', requireModuleAccess('payments'), createMercadoPagoPaymentPlanView)

export default router
