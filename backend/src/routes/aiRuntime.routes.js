import express from 'express'
import multer from 'multer'
import { getConfig, transcribeVoice } from '../controllers/aiRuntimeController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireOpenAIConfigured } from '../middleware/openAIConfigMiddleware.js'
import { requireAnyModuleAccess } from '../middleware/userAccessMiddleware.js'

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
router.use(requireAnyModuleAccess(['ai_agent', 'sites', 'appointments']))
router.get('/config', getConfig)
router.post('/transcribe', requireOpenAIConfigured, transcribeAudioBody, transcribeVoice)

export default router
