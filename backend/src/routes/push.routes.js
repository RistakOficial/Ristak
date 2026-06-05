import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
import {
  disableSubscription,
  getPushPublicKey,
  saveSubscription
} from '../controllers/pushController.js'

const router = express.Router()

router.get('/public-key', getPushPublicKey)
router.post('/subscriptions', requireAuth, saveSubscription)
router.delete('/subscriptions', requireAuth, disableSubscription)

export default router
