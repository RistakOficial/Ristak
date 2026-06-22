import { logger } from '../utils/logger.js'
import {
  CONVERSATIONAL_OBJECTIVES,
  SUCCESS_ACTIONS,
  getConversationalAgentConfig,
  saveConversationalAgentConfig,
  getConversationState,
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
  listAgentFilterOptions,
  completeConversationGoalLinkFromWebhook
} from '../services/conversationalAgentService.js'
import {
  connectConversationalAIProvider,
  deleteConversationalAIProvider,
  listConversationalAIProviders
} from '../services/conversationalAIProviderService.js'
import {
  buildBusinessProfilePromptParameters,
  getBusinessProfileSnapshot
} from '../services/aiAgentService.js'
import { getAccountLocaleSettings } from '../utils/accountLocale.js'
import { runConversationalAgentPreview } from '../agents/conversational/runner.js'
import {
  DEFAULT_CLOSING_STRATEGY,
  buildClosingStrategyTemplateParameters,
  buildBusinessAdaptiveClosingSection,
  renderClosingStrategyTemplate
} from '../agents/conversational/prompt.js'

function buildBusinessPromptStateFromProfile(businessProfile, agentConfig = {}, accountLocale = {}) {
  const promptParameters = businessProfile?.configured
    ? buildBusinessProfilePromptParameters(businessProfile.profile, businessProfile.promptParameters)
    : {}
  const extractionStatus = businessProfile?.extractionStatus || businessProfile?.status || 'empty'
  const statusBusinessName = businessProfile?.businessName || businessProfile?.profile?.businessName || promptParameters.NOMBRE_DEL_NEGOCIO || null
  const statusIndustry = businessProfile?.industry || businessProfile?.profile?.industry || promptParameters.INDUSTRIA || null
  const businessName = statusBusinessName || 'este negocio'
  const industry = statusIndustry || 'industria no especificada'
  const conditions = [
    businessProfile?.paymentSummary,
    businessProfile?.contactSummary
  ].filter(Boolean).join(' · ')
  const visibleParameters = buildClosingStrategyTemplateParameters({
    profileParameters: promptParameters,
    adaptationParameters: promptParameters,
    config: agentConfig,
    businessName,
    industry,
    offering: businessProfile?.offeringsSummary || promptParameters.PRODUCTO_O_SERVICIO,
    personType: 'prospecto',
    channelLabel: 'WhatsApp',
    businessInfo: businessProfile?.summary || businessProfile?.sourceContext || promptParameters.INFO_GENERAL_DEL_NEGOCIO,
    value: businessProfile?.pricingSummary || promptParameters.VALOR,
    location: businessProfile?.locationSummary || promptParameters.UBICACION_O_MODALIDAD,
    availability: promptParameters.DISPONIBILIDAD,
    conditions: businessProfile?.importantConditions || conditions || promptParameters.CONDICIONES_IMPORTANTES,
    accountLocale
  })
  const ready = Boolean(
    businessProfile?.configured &&
    extractionStatus === 'ready' &&
    visibleParameters.ADAPTACION_CONVERSACIONAL_DEL_NEGOCIO
  )
  const renderedStrategy = renderClosingStrategyTemplate(DEFAULT_CLOSING_STRATEGY, visibleParameters, {
    replaceMissing: true
  })
  const adaptedStrategy = [
    renderedStrategy,
    ready ? buildBusinessAdaptiveClosingSection({ enabled: true, parameters: visibleParameters }) : ''
  ].filter(Boolean).join('\n\n')

  return {
    systemClosingStrategy: adaptedStrategy,
    businessPromptStatus: {
      ready,
      status: extractionStatus,
      extractionStatus,
      extractionError: businessProfile?.extractionError || null,
      businessName: statusBusinessName,
      industry: statusIndustry,
      updatedAt: businessProfile?.updatedAt || businessProfile?.extractedAt || null,
      summary: businessProfile?.summary || null
    }
  }
}

async function getBusinessPromptState(agentConfig = {}) {
  const [businessProfile, accountLocale] = await Promise.all([
    getBusinessProfileSnapshot().catch(() => null),
    getAccountLocaleSettings().catch(() => ({ countryCode: 'MX', currency: 'MXN', dialCode: '52' }))
  ])
  return buildBusinessPromptStateFromProfile(businessProfile, agentConfig, accountLocale)
}

function withVisibleStrategy(agent, businessProfile, accountLocale = {}) {
  const promptState = buildBusinessPromptStateFromProfile(businessProfile, agent, accountLocale)
  return {
    ...agent,
    systemClosingStrategy: promptState.systemClosingStrategy
  }
}

async function assertBusinessPromptReady() {
  const promptState = await getBusinessPromptState()
  if (promptState.businessPromptStatus.ready) return promptState

  const error = new Error('Primero termina la descripción del negocio para preparar el prompt interno del agente conversacional.')
  error.statusCode = 409
  error.code = 'CONVERSATIONAL_BUSINESS_PROMPT_NOT_READY'
  error.businessPromptStatus = promptState.businessPromptStatus
  throw error
}

export async function getConfig(req, res) {
  try {
    const [config, aiProviders] = await Promise.all([
      getConversationalAgentConfig(),
      listConversationalAIProviders()
    ])
    const promptState = await getBusinessPromptState(config)
    res.json({
      success: true,
      data: {
        ...config,
        aiProviders,
        objectives: CONVERSATIONAL_OBJECTIVES,
        successActions: SUCCESS_ACTIONS,
        ...promptState
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
    const result = await completeConversationGoalLinkFromWebhook({
      ...(req.query || {}),
      ...(req.body || {})
    })

    res.json({
      success: true,
      data: {
        goalId: result.id,
        contactId: result.contactId,
        agentId: result.agentId,
        objective: result.objective,
        signal: result.signal,
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

export async function saveConfig(req, res) {
  try {
    if (req.body?.enabled === true) {
      await assertBusinessPromptReady()
    }
    const config = await saveConversationalAgentConfig(req.body || {})
    const promptState = await getBusinessPromptState(config)
    res.json({
      success: true,
      message: 'Agente conversacional guardado',
      data: { ...config, ...promptState }
    })
  } catch (error) {
    logger.error('Error guardando configuración del agente conversacional:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al guardar la configuración',
      code: error.code,
      businessPromptStatus: error.businessPromptStatus
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

    const agentId = String(req.body?.agentId || '').trim()
    if (action === 'activate' && agentId) {
      const agent = await getConversationalAgent(agentId)
      if (!agent) {
        return res.status(404).json({ success: false, error: 'Agente no encontrado' })
      }
      if (!agent.enabled) {
        return res.status(400).json({ success: false, error: 'Este agente está pausado' })
      }
      await assertBusinessPromptReady()
    }

    let state = await setConversationStatus(contactId, mapped.status, {
      updatedBy: 'user',
      clearSignal: mapped.clearSignal,
      activationSource: 'manual'
    })

    if (action === 'activate' && agentId) {
      await assignAgentToConversation(contactId, agentId, {
        activationSource: 'manual',
        updatedBy: 'user'
      })
      state = await getConversationState(contactId)
    }

    res.json({ success: true, data: state })
  } catch (error) {
    logger.error('Error actualizando estado de conversación:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al actualizar el estado',
      code: error.code,
      businessPromptStatus: error.businessPromptStatus
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
    const [businessProfile, accountLocale] = await Promise.all([
      getBusinessProfileSnapshot().catch(() => null),
      getAccountLocaleSettings().catch(() => ({ countryCode: 'MX', currency: 'MXN', dialCode: '52' }))
    ])
    const agents = await listConversationalAgents()
    res.json({ success: true, data: agents.map((agent) => withVisibleStrategy(agent, businessProfile, accountLocale)) })
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
    if (req.body?.enabled !== false) {
      await assertBusinessPromptReady()
    }
    const [businessProfile, accountLocale] = await Promise.all([
      getBusinessProfileSnapshot().catch(() => null),
      getAccountLocaleSettings().catch(() => ({ countryCode: 'MX', currency: 'MXN', dialCode: '52' }))
    ])
    const agent = await createConversationalAgent(req.body || {})
    res.status(201).json({ success: true, data: withVisibleStrategy(agent, businessProfile, accountLocale) })
  } catch (error) {
    logger.error('Error creando agente conversacional:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al crear el agente',
      code: error.code,
      businessPromptStatus: error.businessPromptStatus
    })
  }
}

export async function updateAgent(req, res) {
  try {
    if (req.body?.enabled === true) {
      await assertBusinessPromptReady()
    }
    const [businessProfile, accountLocale] = await Promise.all([
      getBusinessProfileSnapshot().catch(() => null),
      getAccountLocaleSettings().catch(() => ({ countryCode: 'MX', currency: 'MXN', dialCode: '52' }))
    ])
    const agent = await updateConversationalAgent(req.params?.agentId, req.body || {})
    res.json({ success: true, data: withVisibleStrategy(agent, businessProfile, accountLocale) })
  } catch (error) {
    logger.error('Error actualizando agente conversacional:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al actualizar el agente',
      code: error.code,
      businessPromptStatus: error.businessPromptStatus
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
