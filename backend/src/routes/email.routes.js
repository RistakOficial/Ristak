import express from 'express'
import {
  connectEmailView,
  disconnectEmailView,
  getEmailStatusView,
  sendTestEmailView
} from '../controllers/emailController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.use(requireAuth)

router.get('/status', getEmailStatusView)
router.post('/connect', connectEmailView)
router.post('/test', sendTestEmailView)
router.post('/disconnect', disconnectEmailView)

export default router
