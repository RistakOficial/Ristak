import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import { subscribeChatLiveEvents } from '../services/chatLiveEventsService.js'
import { touchPresence } from '../services/presenceService.js'

const router = express.Router()

// (ACL-001) El stream de eventos de chat debe exigir el módulo 'chat', no
// 'contacts': un empleado con chat:'none' y contacts:'read' no debe ver el live de chat.
router.get('/stream', requireAuth, requireModuleAccess('chat'), (req, res) => {
  subscribeChatLiveEvents(req, res)
})

// Presencia: el cliente reporta qué contacto tiene ABIERTO y si la app está al
// frente. Con esto no mandamos push a quien ya está viendo el chat (solo a ese
// usuario). contactId vacío o foreground=false => deja de suprimir.
router.post('/viewing', requireAuth, requireModuleAccess('chat'), (req, res) => {
  const userId = req.user?.userId
  const contactId = String(req.body?.contactId ?? '').trim()
  const foreground = req.body?.foreground !== false
  touchPresence(userId, { contactId, foreground })
  res.status(204).end()
})

export default router
