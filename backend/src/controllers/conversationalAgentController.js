import { logger } from '../utils/logger.js'
import {
  CONVERSATIONAL_OBJECTIVES,
  SUCCESS_ACTIONS,
  getConversationalAgentConfig,
  saveConversationalAgentConfig,
  getConversationState,
  setConversationStatus,
  clearConversationSignal,
  listConversationStates,
  listConversationalAgentEvents
} from '../services/conversationalAgentService.js'
import { runConversationalAgentPreview } from '../agents/conversational/runner.js'
import { DEFAULT_CLOSING_STRATEGY } from '../agents/conversational/prompt.js'

export async function getConfig(req, res) {
  try {
    const config = await getConversationalAgentConfig()
    res.json({
      success: true,
      data: {
        ...config,
        objectives: CONVERSATIONAL_OBJECTIVES,
        successActions: SUCCESS_ACTIONS,
        systemClosingStrategy: DEFAULT_CLOSING_STRATEGY
      }
    })
  } catch (error) {
    logger.error('Error obteniendo configuración del agente conversacional:', error)
    res.status(500).json({ success: false, error: 'Error al obtener la configuración del agente conversacional' })
  }
}

export async function saveConfig(req, res) {
  try {
    const config = await saveConversationalAgentConfig(req.body || {})
    res.json({
      success: true,
      message: 'Agente conversacional guardado',
      data: { ...config, systemClosingStrategy: DEFAULT_CLOSING_STRATEGY }
    })
  } catch (error) {
    logger.error('Error guardando configuración del agente conversacional:', error)
    res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Error al guardar la configuración' })
  }
}

export async function listStates(req, res) {
  try {
    const signal = String(req.query?.signal || '').trim() || null
    const statuses = String(req.query?.statuses || '').trim()
    const states = await listConversationStates({
      signal,
      statuses: statuses ? statuses.split(',').map((s) => s.trim()).filter(Boolean) : null
    })
    res.json({ success: true, data: states })
  } catch (error) {
    logger.error('Error listando estados del agente conversacional:', error)
    res.status(500).json({ success: false, error: 'Error al listar los estados de conversaciones' })
  }
}

export async function getState(req, res) {
  try {
    const state = await getConversationState(req.params?.contactId)
    res.json({ success: true, data: state })
  } catch (error) {
    logger.error('Error obteniendo estado de conversación:', error)
    res.status(500).json({ success: false, error: 'Error al obtener el estado de la conversación' })
  }
}

const STATE_ACTIONS = {
  pause: { status: 'paused', clearSignal: false },
  resume: { status: 'active', clearSignal: false },
  take_over: { status: 'human', clearSignal: false },
  skip: { status: 'skipped', clearSignal: false },
  activate: { status: 'active', clearSignal: true }
}

export async function updateState(req, res) {
  try {
    const contactId = req.params?.contactId
    const action = String(req.body?.action || '').trim()

    if (!contactId) {
      return res.status(400).json({ success: false, error: 'Falta el contacto' })
    }

    if (action === 'clear_signal') {
      const state = await clearConversationSignal(contactId, { updatedBy: 'user' })
      return res.json({ success: true, data: state })
    }

    const mapped = STATE_ACTIONS[action]
    if (!mapped) {
      return res.status(400).json({ success: false, error: `Acción inválida: ${action}` })
    }

    const state = await setConversationStatus(contactId, mapped.status, {
      updatedBy: 'user',
      clearSignal: mapped.clearSignal
    })
    res.json({ success: true, data: state })
  } catch (error) {
    logger.error('Error actualizando estado de conversación:', error)
    res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Error al actualizar el estado' })
  }
}

export async function testAgent(req, res) {
  try {
    const result = await runConversationalAgentPreview({
      messages: req.body?.messages,
      configOverride: req.body?.config || null
    })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error('Error en prueba del agente conversacional:', error)
    res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Error al probar el agente conversacional' })
  }
}

export async function listEvents(req, res) {
  try {
    const events = await listConversationalAgentEvents({
      contactId: String(req.query?.contactId || '').trim() || null,
      limit: req.query?.limit
    })
    res.json({ success: true, data: events })
  } catch (error) {
    logger.error('Error listando eventos del agente conversacional:', error)
    res.status(500).json({ success: false, error: 'Error al listar los eventos del agente' })
  }
}
