import { logger } from '../utils/logger.js'
import {
  getConversationalAgentConfig,
  getConversationState,
  listConversationStatesForContact,
  setConversationStatus,
  assignAgentToConversation,
  clearConversationSignal,
  listConversationStates,
  listConversationalAgentEvents,
  listConversationalAgents,
  getConversationalAgent,
  getConversationalAgentMetrics,
  createConversationalAgent,
  updateConversationalAgent,
  deleteConversationalAgent,
  resetConversationalAgentSkippedContacts,
  listAgentFilterOptions,
  completeConversationGoalLinkFromWebhook
} from '../services/conversationalAgentService.js'
import {
  connectConversationalAIProvider,
  deleteConversationalAIProvider,
  listConversationalAIProviders
} from '../services/conversationalAIProviderService.js'
import { runConversationalAgentPreview } from '../agents/conversational/runner.js'

export async function getConfig(req, res) {
  try {
    const [config, aiProviders] = await Promise.all([
      getConversationalAgentConfig(),
      listConversationalAIProviders()
    ])
    res.json({
      success: true,
      data: {
        ...config,
        aiProviders
      }
    })
  } catch (error) {
    logger.error('Error obteniendo configuración del agente conversacional:', error)
    res.status(500).json({ success: false, error: 'Error al obtener la configuración del agente conversacional' })
  }
}

export async function listAIProviders(req, res) {
  try {
    const providers = await listConversationalAIProviders()
    res.json({ success: true, data: providers })
  } catch (error) {
    logger.error('Error listando IAs del agente conversacional:', error)
    res.status(500).json({ success: false, error: 'Error al cargar las IAs del agente conversacional' })
  }
}

export async function connectAIProvider(req, res) {
  try {
    const providers = await connectConversationalAIProvider(req.params?.providerId, req.body?.apiKey)
    res.json({ success: true, data: providers })
  } catch (error) {
    logger.error('Error conectando IA del agente conversacional:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al conectar la IA del agente conversacional'
    })
  }
}

export async function deleteAIProvider(req, res) {
  try {
    const providers = await deleteConversationalAIProvider(req.params?.providerId)
    res.json({ success: true, data: providers })
  } catch (error) {
    logger.error('Error eliminando IA del agente conversacional:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al eliminar la IA del agente conversacional'
    })
  }
}

export async function handleGoalWebhook(req, res) {
  try {
    const confirmationToken = String(
      req.get?.('x-ristak-goal-token') || ''
    ).trim()
    const result = await completeConversationGoalLinkFromWebhook({
      ...(req.body || {}),
      ...(req.query || {}),
      ...(req.params || {})
    }, { confirmationToken })

    res.json({
      success: true,
      data: {
        goalId: result.id,
        contactId: result.contactId,
        agentId: result.agentId,
        objective: result.objective,
        signal: result.signal,
        externalSource: result.externalSource,
        externalObjectId: result.externalObjectId,
        alreadyCompleted: Boolean(result.alreadyCompleted)
      }
    })
  } catch (error) {
    logger.warn(`Webhook de objetivo conversacional rechazado: ${error.message}`)
    res.status(error.statusCode || 400).json({
      success: false,
      error: error.message || 'No se pudo procesar el webhook del objetivo'
    })
  }
}

export async function completeExternalConversationGoal(req, res) {
  try {
    const requestId = String(req.get?.('idempotency-key') || '').trim()
    if (!requestId) {
      return res.status(400).json({
        success: false,
        error: 'Falta el header Idempotency-Key para confirmar la meta'
      })
    }
    const actorId = String(req.apiUser?.id || req.user?.userId || '').trim()
    if (!actorId) {
      return res.status(401).json({ success: false, error: 'Integración no autenticada' })
    }

    const result = await completeConversationGoalLinkFromWebhook({
      ...(req.body || {}),
      goalId: req.params?.goalId
    }, {
      authorization: {
        type: 'external_api',
        actorId,
        requestId
      }
    })

    return res.json({
      success: true,
      data: {
        goalId: result.id,
        contactId: result.contactId,
        agentId: result.agentId,
        objective: result.objective,
        signal: result.signal,
        externalSource: result.externalSource,
        externalObjectId: result.externalObjectId,
        alreadyCompleted: Boolean(result.alreadyCompleted),
        effectsPending: Boolean(result.effectsPending)
      }
    })
  } catch (error) {
    logger.warn(`Confirmación externa de meta conversacional rechazada: ${error.message}`)
    return res.status(error.statusCode || 400).json({
      success: false,
      retryable: Boolean(error.retryable),
      error: error.message || 'No se pudo confirmar la meta conversacional'
    })
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
    const includeAll = ['1', 'true', 'yes'].includes(String(req.query?.includeAll || '').trim().toLowerCase())
    if (includeAll) {
      const states = await listConversationStatesForContact(req.params?.contactId)
      return res.json({ success: true, data: states })
    }
    const state = await getConversationState(req.params?.contactId, { agentId: req.query?.agentId || null })
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
      const state = await clearConversationSignal(contactId, { updatedBy: 'user', agentId: req.body?.agentId || null })
      return res.json({ success: true, data: state })
    }

    const mapped = STATE_ACTIONS[action]
    if (!mapped) {
      return res.status(400).json({ success: false, error: `Acción inválida: ${action}` })
    }

    const agentId = String(req.body?.agentId || '').trim()
    if (action === 'activate' && agentId) {
      const agent = await getConversationalAgent(agentId)
      if (!agent) {
        return res.status(404).json({ success: false, error: 'Agente no encontrado' })
      }
      if (!agent.enabled) {
        return res.status(400).json({ success: false, error: 'Este agente está pausado' })
      }
    }

    let state = await setConversationStatus(contactId, mapped.status, {
      updatedBy: 'user',
      clearSignal: mapped.clearSignal,
      pausedUntilAt: req.body?.pausedUntilAt || null,
      activationSource: 'manual',
      agentId: agentId || null
    })

    if (action === 'activate' && agentId) {
      state = await assignAgentToConversation(contactId, agentId, {
        activationSource: 'manual',
        updatedBy: 'user'
      })
    }

    res.json({ success: true, data: state })
  } catch (error) {
    logger.error('Error actualizando estado de conversación:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al actualizar el estado',
      code: error.code
    })
  }
}

export async function testAgent(req, res) {
  try {
    const result = await runConversationalAgentPreview({
      messages: req.body?.messages,
      configOverride: req.body?.config || null,
      agentId: req.body?.agentId || null
    })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error('Error en prueba del agente conversacional:', error)
    res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Error al probar el agente conversacional' })
  }
}

export async function getFilterOptions(req, res) {
  try {
    const options = await listAgentFilterOptions()
    res.json({ success: true, data: options })
  } catch (error) {
    logger.error('Error listando catálogos de filtros del agente conversacional:', error)
    res.status(500).json({ success: false, error: 'Error al cargar los catálogos de filtros' })
  }
}

export async function listAgents(req, res) {
  try {
    const agents = await listConversationalAgents()
    res.json({ success: true, data: agents })
  } catch (error) {
    logger.error('Error listando agentes conversacionales:', error)
    res.status(500).json({ success: false, error: 'Error al listar los agentes conversacionales' })
  }
}

export async function getMetrics(req, res) {
  try {
    const metrics = await getConversationalAgentMetrics()
    res.json({ success: true, data: metrics })
  } catch (error) {
    logger.error('Error obteniendo métricas del agente conversacional:', error)
    res.status(500).json({ success: false, error: 'Error al cargar las métricas del agente' })
  }
}

export async function createAgent(req, res) {
  try {
    const agent = await createConversationalAgent(req.body || {})
    res.status(201).json({
      success: true,
      data: agent
    })
  } catch (error) {
    logger.error('Error creando agente conversacional:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al crear el agente',
      code: error.code,
      nativeRuntimeValidation: error.nativeRuntimeValidation,
      nativeRuntimeResourceValidation: error.nativeRuntimeResourceValidation,
      conflicts: error.conflicts,
      limit: error.limit
    })
  }
}

export async function updateAgent(req, res) {
  try {
    const current = await getConversationalAgent(req.params?.agentId)
    if (!current) {
      return res.status(404).json({ success: false, error: 'Agente conversacional no encontrado' })
    }
    const agent = await updateConversationalAgent(req.params?.agentId, req.body || {})
    res.json({
      success: true,
      data: agent
    })
  } catch (error) {
    logger.error('Error actualizando agente conversacional:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al actualizar el agente',
      code: error.code,
      nativeRuntimeValidation: error.nativeRuntimeValidation,
      nativeRuntimeResourceValidation: error.nativeRuntimeResourceValidation,
      conflicts: error.conflicts
    })
  }
}

export async function deleteAgent(req, res) {
  try {
    const removed = await deleteConversationalAgent(req.params?.agentId)
    if (!removed) {
      return res.status(404).json({ success: false, error: 'Agente conversacional no encontrado' })
    }
    res.json({ success: true })
  } catch (error) {
    logger.error('Error eliminando agente conversacional:', error)
    res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Error al eliminar el agente' })
  }
}

export async function resetAgentSkippedContacts(req, res) {
  try {
    const result = await resetConversationalAgentSkippedContacts(req.params?.agentId, { updatedBy: 'user' })
    if (!result) {
      return res.status(404).json({ success: false, error: 'Agente conversacional no encontrado' })
    }
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error('Error reiniciando omisiones del agente conversacional:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al reiniciar las omisiones del agente'
    })
  }
}

export async function listEvents(req, res) {
  try {
    const events = await listConversationalAgentEvents({
      contactId: String(req.query?.contactId || '').trim() || null,
      limit: req.query?.limit,
      kind: String(req.query?.kind || '').trim() || null
    })
    res.json({ success: true, data: events })
  } catch (error) {
    logger.error('Error listando eventos del agente conversacional:', error)
    res.status(500).json({ success: false, error: 'Error al listar los eventos del agente' })
  }
}
