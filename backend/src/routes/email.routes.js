import express from 'express'
import {
  connectEmailView,
  detectEmailProviderView,
  disconnectEmailView,
  getEmailSignatureView,
  getEmailStatusView,
  saveEmailSignatureView,
  sendEmailView,
  sendTestEmailView,
  syncInboundEmailView,
  testInboundEmailView
} from '../controllers/emailController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.use(requireAuth)

router.get('/status', getEmailStatusView)
router.post('/detect', detectEmailProviderView)
router.post('/connect', connectEmailView)
router.post('/send', sendEmailView)
router.post('/test', sendTestEmailView)
router.post('/inbound/test', testInboundEmailView)
router.post('/inbound/sync', syncInboundEmailView)
router.get('/signature', getEmailSignatureView)
router.post('/signature', saveEmailSignatureView)
router.post('/disconnect', disconnectEmailView)

export default router
