import express from 'express'
import multer from 'multer'
import { chat, deleteConfig, deleteToken, getConfig, getRunTrace, listAgents, saveBusinessContextAnswer, saveConfig, transcribeVoice } from '../controllers/aiAgentController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireOpenAIConfigured } from '../middleware/openAIConfigMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = express.Router()
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024
  }
})
const rawAudioBody = express.raw({
  limit: '25mb',
  type: (req) => Boolean(req.is('audio/*') || req.is('video/webm') || req.is('application/octet-stream'))
})

function transcribeAudioBody(req, res, next) {
  if (req.is('multipart/form-data')) {
    audioUpload.single('audio')(req, res, (error) => {
      if (!error) {
        next()
        return
      }
      const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
      res.status(tooLarge ? 413 : 400).json({
        success: false,
        error: tooLarge ? 'El audio es demasiado pesado.' : 'No pude leer el audio.'
      })
    })
    return
  }
  rawAudioBody(req, res, next)
}

router.use(requireAuth)
router.use(requireModuleAccess('ai_agent'))

router.get('/config', getConfig)
router.post('/config', saveConfig)
router.delete('/config/token', deleteToken)
router.delete('/config', deleteConfig)
router.post('/business-context-answer', requireOpenAIConfigured, saveBusinessContextAnswer)
router.get('/agents', requireOpenAIConfigured, listAgents)
router.get('/runs/:traceId', requireOpenAIConfigured, getRunTrace)
router.post('/transcribe', requireOpenAIConfigured, transcribeAudioBody, transcribeVoice)
router.post('/chat', requireOpenAIConfigured, chat)

export default router
