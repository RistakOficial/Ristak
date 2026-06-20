import express from 'express'
import {
  actionSubscriptionView,
  createSubscriptionView,
  deleteSubscriptionView,
  getSubscriptionView,
  listSubscriptionsView,
  updateSubscriptionView
} from '../controllers/subscriptionsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = express.Router()

router.use(requireAuth)
router.use(requireModuleAccess('payments'))

router.get('/', listSubscriptionsView)
router.post('/', createSubscriptionView)
router.get('/:subscriptionId', getSubscriptionView)
router.put('/:subscriptionId', updateSubscriptionView)
router.post('/:subscriptionId/action', actionSubscriptionView)
router.delete('/:subscriptionId', deleteSubscriptionView)

export default router
