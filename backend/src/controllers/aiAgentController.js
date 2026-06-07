import { logger } from '../utils/logger.js'
import {
  createAgentReply,
  deleteAIAgentConfig,
  getAIAgentStatus,
  getOpenAIApiKey,
  isAIAgentCredentialError,
  saveRefinedAIAgentBusinessContextAnswer,
  saveAIAgentConfig,
  transcribeVoiceAudio,
  verifyOpenAIApiKey
} from '../services/aiAgentService.js'
import { getAgentRunTrace } from '../services/agentExecutionLedgerService.js'

function sendAIAgentError(res, error, fallback, statusCode = 500) {
  if (isAIAgentCredentialError(error)) {
    return res.status(error.statusCode || 409).json({
      success: false,
      error: error.message,
      code: error.code,
      needsReconnect: true,
      ...(error.agentTrace ? { trace: error.agentTrace } : {})
    })
  }

  return res.status(statusCode).json({
    success: false,
    error: error.message || fallback,
    ...(error.agentTrace ? { trace: error.agentTrace } : {})
  })
}

export async function getConfig(req, res) {
  try {
    const status = await getAIAgentStatus({ userId: req.user?.userId })

    res.json({
      success: true,
      data: status
    })
  } catch (error) {
    logger.error('Error obteniendo configuración del agente AI:', error)
    sendAIAgentError(res, error, 'Error al obtener la configuración del agente AI')
  }
}

export async function saveConfig(req, res) {
  try {
    const apiKey = String(req.body?.apiKey || '').trim()

    if (apiKey && !apiKey.startsWith('sk-')) {
      return res.status(400).json({
        success: false,
        error: 'El API Token de OpenAI no tiene un formato válido'
      })
    }

    if (apiKey) {
      const validation = await verifyOpenAIApiKey(apiKey)

      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          error: validation.error || 'API Token de OpenAI inválido'
        })
      }
    }

    const status = await saveAIAgentConfig({
      userId: req.user?.userId,
      apiKey: apiKey || null,
      businessContext: req.body?.businessContext,
      marketContext: req.body?.marketContext,
      idealCustomer: req.body?.idealCustomer,
      locationContext: req.body?.locationContext,
      competitorsContext: req.body?.competitorsContext,
      brandVoice: req.body?.brandVoice,
      actionCustomizations: req.body?.actionCustomizations,
      researchDomains: req.body?.researchDomains,
      model: req.body?.model,
      responseStyle: req.body?.responseStyle,
      recommendationMode: req.body?.recommendationMode,
      webSearchEnabled: Boolean(req.body?.webSearchEnabled)
    })

    res.json({
      success: true,
      message: 'Agente AI configurado correctamente',
      data: status
    })
  } catch (error) {
    logger.error('Error guardando configuración del agente AI:', error)
    res.status(500).json({
      success: false,
      error: error.message || 'Error al guardar la configuración del agente AI'
    })
  }
}

export async function deleteConfig(req, res) {
  try {
    await deleteAIAgentConfig({ userId: req.user?.userId })

    res.json({
      success: true,
      message: 'Agente AI desconectado correctamente'
    })
  } catch (error) {
    logger.error('Error eliminando configuración del agente AI:', error)
    res.status(500).json({
      success: false,
      error: 'Error al desconectar el agente AI'
    })
  }
}

export async function saveBusinessContextAnswer(req, res) {
  try {
    const result = await saveRefinedAIAgentBusinessContextAnswer({
      field: req.body?.field,
      answer: req.body?.answer
    })

    res.json({
      success: true,
      message: 'Contexto del negocio redactado y guardado',
      data: result
    })
  } catch (error) {
    logger.error('Error guardando respuesta de contexto del agente AI:', error)
    if (isAIAgentCredentialError(error)) {
      return sendAIAgentError(res, error, 'OpenAI necesita reconectarse')
    }

    const statusCode = error.message?.includes('API Key')
      ? 409
      : error.message?.includes('no válido') || error.message?.includes('respuesta')
        ? 400
        : 500

    sendAIAgentError(res, error, 'Error al guardar el contexto del negocio', statusCode)
  }
}

export async function chat(req, res) {
  try {
    const apiKey = await getOpenAIApiKey()

    if (!apiKey) {
      return res.status(409).json({
        success: false,
        error: 'Primero configura una API Key válida de OpenAI'
      })
    }

    const messages = Array.isArray(req.body?.messages) ? req.body.messages : []
    const lastMessage = messages[messages.length - 1]
    const hasMessageText = Boolean(lastMessage?.content && typeof lastMessage.content === 'string')
    const hasAttachments = Array.isArray(lastMessage?.attachments) && lastMessage.attachments.length > 0

    if (!hasMessageText && !hasAttachments) {
      return res.status(400).json({
        success: false,
        error: 'Envía un mensaje o archivo para el agente'
      })
    }

    const result = await createAgentReply({
      apiKey,
      messages,
      viewContext: req.body?.viewContext || {},
      userId: req.user?.userId
    })

    res.json({
      success: true,
      data: result
    })
  } catch (error) {
    logger.error('Error en chat del agente AI:', error)
    sendAIAgentError(res, error, 'Error al generar respuesta del agente AI')
  }
}

export async function getRunTrace(req, res) {
  try {
    const trace = await getAgentRunTrace(req.params?.traceId, {
      userId: req.user?.userId
    })

    if (!trace) {
      return res.status(404).json({
        success: false,
        error: 'No encontré ese rastro del agente'
      })
    }

    res.json({
      success: true,
      data: trace
    })
  } catch (error) {
    logger.error('Error obteniendo rastro del agente AI:', error)
    sendAIAgentError(res, error, 'Error al obtener el rastro del agente AI')
  }
}

export async function transcribeVoice(req, res) {
  try {
    const apiKey = await getOpenAIApiKey()

    if (!apiKey) {
      return res.status(409).json({
        success: false,
        error: 'Primero configura una API Key válida de OpenAI'
      })
    }

    const audioBuffer = Buffer.isBuffer(req.body) ? req.body : null

    if (!audioBuffer?.length) {
      return res.status(400).json({
        success: false,
        error: 'Envía audio para transcribir'
      })
    }

    const result = await transcribeVoiceAudio({
      apiKey,
      audioBuffer,
      mimeType: req.headers['content-type'] || 'audio/webm'
    })

    res.json({
      success: true,
      data: result
    })
  } catch (error) {
    logger.error('Error transcribiendo voz del agente AI:', error)
    sendAIAgentError(res, error, 'Error al transcribir el audio')
  }
}
