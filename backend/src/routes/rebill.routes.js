import express from 'express'
import {
  confirmPublicRebillPaymentView,
  createRebillPaymentLinkView,
  deleteRebillConfigView,
  getPublicRebillPaymentView,
  getRebillConfigView,
  rebillWebhookView,
  saveRebillConfigView,
  testRebillConfigView
} from '../controllers/rebillPaymentsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = express.Router()

router.post('/webhook', rebillWebhookView)
router.get('/public/payments/:publicPaymentId', getPublicRebillPaymentView)
router.post('/public/payments/:publicPaymentId/confirm', confirmPublicRebillPaymentView)

router.use(requireAuth)

router.get('/config', requireModuleAccess('settings_payments'), getRebillConfigView)
router.post('/config', requireModuleAccess('settings_payments'), saveRebillConfigView)
router.delete('/config', requireModuleAccess('settings_payments'), deleteRebillConfigView)
router.post('/config/test', requireModuleAccess('settings_payments'), testRebillConfigView)
router.post('/payment-links', requireModuleAccess('payments'), createRebillPaymentLinkView)

export default router
