import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import { subscribeChatLiveEvents } from '../services/chatLiveEventsService.js'

const router = express.Router()

// (ACL-001) El stream de eventos de chat debe exigir el módulo 'chat', no
// 'contacts': un empleado con chat:'none' y contacts:'read' no debe ver el live de chat.
router.get('/stream', requireAuth, requireModuleAccess('chat'), (req, res) => {
  subscribeChatLiveEvents(req, res)
})

export default router
