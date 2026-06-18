import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import { subscribeChatLiveEvents } from '../services/chatLiveEventsService.js'

const router = express.Router()

router.get('/stream', requireAuth, requireModuleAccess('contacts'), (req, res) => {
  subscribeChatLiveEvents(req, res)
})

export default router
