import express from 'express'
import {
  createOfflinePaymentPlanView,
  getPublicOfflinePaymentView
} from '../controllers/offlinePaymentsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireFeature } from '../middleware/licenseMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = express.Router()

router.get('/public/payments/:publicPaymentId', getPublicOfflinePaymentView)
router.post(
  '/payment-plans',
  requireAuth,
  requireModuleAccess('payments'),
  requireFeature('payment_plans'),
  createOfflinePaymentPlanView
)

export default router
