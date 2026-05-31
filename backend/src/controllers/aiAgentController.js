import { logger } from '../utils/logger.js'
import {
  createAgentReply,
  deleteAIAgentConfig,
  getAIAgentStatus,
  getOpenAIApiKey,
  saveAIAgentConfig,
  transcribeVoiceAudio,
  verifyOpenAIApiKey
} from '../services/aiAgentService.js'

export async function getConfig(req, res) {
  try {
    const status = await getAIAgentStatus()

    res.json({
      success: true,
      data: status
    })
  } catch (error) {
    logger.error('Error obteniendo configuración del agente AI:', error)
    res.status(500).json({
      success: false,
      error: 'Error al obtener la configuración del agente AI'
    })
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
      apiKey: apiKey || null,
      businessContext: req.body?.businessContext,
      marketContext: req.body?.marketContext,
      idealCustomer: req.body?.idealCustomer,
      locationContext: req.body?.locationContext,
      competitorsContext: req.body?.competitorsContext,
      brandVoice: req.body?.brandVoice,
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
    await deleteAIAgentConfig()

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

    if (!lastMessage?.content || typeof lastMessage.content !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Envía un mensaje para el agente'
      })
    }

    const result = await createAgentReply({
      apiKey,
      messages,
      viewContext: req.body?.viewContext || {}
    })

    res.json({
      success: true,
      data: result
    })
  } catch (error) {
    logger.error('Error en chat del agente AI:', error)
    res.status(500).json({
      success: false,
      error: error.message || 'Error al generar respuesta del agente AI'
    })
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
    res.status(500).json({
      success: false,
      error: error.message || 'Error al transcribir el audio'
    })
  }
}
