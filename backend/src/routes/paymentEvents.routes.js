import express from 'express'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import { subscribePaymentLiveEvents } from '../services/paymentLiveEventsService.js'

const router = express.Router()

router.get('/stream', requireModuleAccess('payments'), (req, res) => {
  subscribePaymentLiveEvents(req, res)
})

export default router
