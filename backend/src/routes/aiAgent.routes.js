import express from 'express'
import { chat, deleteConfig, getConfig, getRunTrace, saveBusinessContextAnswer, saveConfig, transcribeVoice } from '../controllers/aiAgentController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()
const rawAudioBody = express.raw({
  limit: '25mb',
  type: (req) => Boolean(req.is('audio/*') || req.is('video/webm') || req.is('application/octet-stream'))
})

router.use(requireAuth)

router.get('/config', getConfig)
router.post('/config', saveConfig)
router.delete('/config', deleteConfig)
router.post('/business-context-answer', saveBusinessContextAnswer)
router.get('/runs/:traceId', getRunTrace)
router.post('/transcribe', rawAudioBody, transcribeVoice)
router.post('/chat', chat)

export default router
