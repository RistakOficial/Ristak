import express from 'express'
import { chat, deleteConfig, deleteToken, getConfig, getRunTrace, listAgents, saveBusinessContextAnswer, saveConfig, transcribeVoice } from '../controllers/aiAgentController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireOpenAIConfigured } from '../middleware/openAIConfigMiddleware.js'
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
router.delete('/config/token', deleteToken)
router.delete('/config', deleteConfig)
router.post('/business-context-answer', requireOpenAIConfigured, saveBusinessContextAnswer)
router.get('/agents', requireOpenAIConfigured, listAgents)
router.get('/runs/:traceId', requireOpenAIConfigured, getRunTrace)
router.post('/transcribe', requireOpenAIConfigured, rawAudioBody, transcribeVoice)
router.post('/chat', requireOpenAIConfigured, chat)

export default router
