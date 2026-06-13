import express from 'express'
import { chat, deleteConfig, getConfig, getRunTrace, listAgents, saveBusinessContextAnswer, saveConfig, transcribeVoice } from '../controllers/aiAgentController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = express.Router()
const rawAudioBody = express.raw({
  limit: '25mb',
  type: (req) => Boolean(req.is('audio/*') || req.is('video/webm') || req.is('application/octet-stream'))
})

router.use(requireAuth)
router.use(requireModuleAccess('ai_agent'))

router.get('/config', getConfig)
router.post('/config', saveConfig)
router.delete('/config', deleteConfig)
router.post('/business-context-answer', saveBusinessContextAnswer)
router.get('/agents', listAgents)
router.get('/runs/:traceId', getRunTrace)
router.post('/transcribe', rawAudioBody, transcribeVoice)
router.post('/chat', chat)

export default router
