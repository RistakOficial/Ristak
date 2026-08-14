import { logger } from '../utils/logger.js'
import {
  AI_RUNTIME_BUSINESS_CONTEXT_MAX_LENGTH,
  getAIRuntimeStatus,
  isAIRuntimeCredentialError,
  isAIRuntimeOpenAIRequiredError,
  requireOpenAIApiKey,
  saveAIRuntimeBusinessProfile,
  transcribeVoiceAudio
} from '../services/aiRuntimeService.js'

function sendRuntimeError(res, error, fallback, statusCode = 500) {
  if (isAIRuntimeOpenAIRequiredError(error)) {
    return res.status(error.statusCode || 409).json({
      success: false,
      error: error.message,
      code: error.code,
      needsOpenAIConfig: true
    })
  }

  if (isAIRuntimeCredentialError(error)) {
    return res.status(error.statusCode || 409).json({
      success: false,
      error: error.message,
      code: error.code,
      needsReconnect: true
    })
  }

  return res.status(statusCode).json({
    success: false,
    error: error.message || fallback
  })
}

export async function getConfig(req, res) {
  try {
    const status = await getAIRuntimeStatus({ userId: req.user?.userId })
    res.json({ success: true, data: status })
  } catch (error) {
    logger.error('Error obteniendo configuración compartida de IA:', error)
    sendRuntimeError(res, error, 'Error al obtener la configuración de IA')
  }
}

export async function saveBusinessProfile(req, res) {
  try {
    if (typeof req.body?.businessContext !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Envía una descripción válida del negocio.'
      })
    }

    if (req.body.businessContext.length > AI_RUNTIME_BUSINESS_CONTEXT_MAX_LENGTH) {
      return res.status(400).json({
        success: false,
        error: `La descripción no puede superar ${AI_RUNTIME_BUSINESS_CONTEXT_MAX_LENGTH.toLocaleString('es-MX')} caracteres.`
      })
    }

    const status = await saveAIRuntimeBusinessProfile({
      userId: req.user?.userId,
      businessContext: req.body.businessContext
    })

    res.json({
      success: true,
      message: 'Descripción del negocio guardada.',
      data: status
    })
  } catch (error) {
    logger.error('Error guardando el perfil compartido del negocio:', error)
    sendRuntimeError(res, error, 'Error al guardar la descripción del negocio')
  }
}

export async function transcribeVoice(req, res) {
  try {
    const apiKey = req.openAIApiKey || await requireOpenAIApiKey()
    const uploadedAudio = req.file
    const audioBuffer = uploadedAudio?.buffer?.length
      ? uploadedAudio.buffer
      : Buffer.isBuffer(req.body)
        ? req.body
        : null

    if (!audioBuffer?.length) {
      return res.status(400).json({
        success: false,
        error: 'Envía audio para transcribir'
      })
    }

    const result = await transcribeVoiceAudio({
      apiKey,
      audioBuffer,
      mimeType: uploadedAudio?.mimetype || req.headers['content-type'] || 'audio/webm'
    })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error('Error transcribiendo audio con la configuración compartida de IA:', error)
    sendRuntimeError(res, error, 'Error al transcribir el audio')
  }
}
