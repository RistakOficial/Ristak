import express from 'express'
import {
  confirmPublicRebillPaymentView,
  createRebillPaymentLinkView,
  createRebillPaymentPlanView,
  deleteRebillConfigView,
  getPublicRebillPaymentView,
  getRebillConfigView,
  rebillWebhookView,
  saveRebillConfigView,
  testRebillConfigView
} from '../controllers/rebillPaymentsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import { requireFeature } from '../middleware/licenseMiddleware.js'

const router = express.Router()
const requirePaymentPlansFeature = requireFeature('payment_plans')

router.post('/webhook', rebillWebhookView)
router.get('/public/payments/:publicPaymentId', getPublicRebillPaymentView)
router.post('/public/payments/:publicPaymentId/confirm', confirmPublicRebillPaymentView)

router.use(requireAuth)

router.get('/config', requireModuleAccess('settings_payments'), getRebillConfigView)
router.post('/config', requireModuleAccess('settings_payments'), saveRebillConfigView)
router.delete('/config', requireModuleAccess('settings_payments'), deleteRebillConfigView)
router.post('/config/test', requireModuleAccess('settings_payments'), testRebillConfigView)
router.post('/payment-links', requireModuleAccess('payments'), createRebillPaymentLinkView)
router.post('/payment-plans', requireModuleAccess('payments'), requirePaymentPlansFeature, createRebillPaymentPlanView)

export default router
