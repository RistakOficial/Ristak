import { logger } from '../utils/logger.js'
import {
  CONVERSATIONAL_OBJECTIVES,
  SUCCESS_ACTIONS,
  getConversationalAgentConfig,
  saveConversationalAgentConfig,
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
  buildConversationalAgentRuntimeConfig,
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
import {
  buildBusinessProfilePromptParameters,
  getBusinessProfileSnapshot
} from '../services/aiAgentService.js'
import { getAccountLocaleSettings } from '../utils/accountLocale.js'
import { runConversationalAgentPreview } from '../agents/conversational/runner.js'
import {
  buildClosingStrategyTemplateParameters
} from '../agents/conversational/prompt.js'
import { isToolCallingV2 } from '../agents/conversational/nativeRuntimeConfig.js'
import {
  compileConversationalAgentPolicy,
  generateConversationalLearningVersion,
  getConversationalPolicyVersion,
  listConversationalLearningVersions,
  listConversationalPolicyVersions,
  recordConversationalPolicyVersion,
  reviewConversationalLearningVersion,
  summarizeCompiledPolicy
} from '../agents/conversational/intelligence/index.js'

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
  // El perfil fallback construido desde la descripción libre también es utilizable.
  // OpenAI mejora la extracción, pero no puede ser un requisito global si el agente
  // usa Claude, Gemini o DeepSeek.
  const ready = Boolean(
    businessProfile?.configured &&
    ['ready', 'needs_openai'].includes(extractionStatus) &&
    visibleParameters.ADAPTACION_CONVERSACIONAL_DEL_NEGOCIO
  )
  return {
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

async function assertBusinessPromptReady() {
  const promptState = await getBusinessPromptState()
  if (promptState.businessPromptStatus.ready) return promptState

  const error = new Error('Primero termina la descripción del negocio para preparar el prompt interno del agente conversacional.')
  error.statusCode = 409
  error.code = 'CONVERSATIONAL_BUSINESS_PROMPT_NOT_READY'
  error.businessPromptStatus = promptState.businessPromptStatus
  throw error
}

async function assertBusinessPromptReadyForConfig(effectiveConfig = {}, { enabled = true } = {}) {
  if (!enabled || isToolCallingV2(effectiveConfig)) return
  await assertBusinessPromptReady()
}

async function compileAgentPolicyWithConfig(input = {}, base = {}) {
  const [businessProfile, effectiveConfig] = await Promise.all([
    getBusinessProfileSnapshot().catch(() => null),
    Promise.resolve(buildConversationalAgentRuntimeConfig(input, base))
  ])
  return {
    effectiveConfig,
    policy: compileConversationalAgentPolicy(effectiveConfig, { businessProfile })
  }
}

async function compileAgentPolicy(input = {}, base = {}) {
  const compiled = await compileAgentPolicyWithConfig(input, base)
  return compiled.policy
}

export function assertCompiledPolicyValid(policy, { enabled = true, effectiveConfig = {} } = {}) {
  if (!enabled || isToolCallingV2(effectiveConfig) || policy?.validation?.valid !== false) return
  const error = new Error(policy.validation.errors[0]?.message || 'La configuración del agente tiene reglas incompletas o contradictorias.')
  error.statusCode = 400
  error.code = 'CONVERSATIONAL_AGENT_POLICY_INVALID'
  error.policyValidation = policy.validation
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

export async function saveConfig(req, res) {
  try {
    if (req.body?.enabled === true) {
      // El switch global se enciende como consecuencia de publicar un agente.
      // El agentId se resuelve del lado servidor para que un cliente no pueda
      // fingir runtimeMode=v2 y saltarse la compuerta de un agente legacy.
      const publishingAgentId = String(req.body?.agentId || '').trim()
      const publishingAgent = publishingAgentId
        ? await getConversationalAgent(publishingAgentId)
        : null
      await assertBusinessPromptReadyForConfig(publishingAgent || {}, { enabled: true })
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
      await assertBusinessPromptReadyForConfig(agent, { enabled: true })
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
    const candidate = await compileAgentPolicyWithConfig(req.body || {})
    const effectiveEnabled = candidate.effectiveConfig.enabled !== false
    await assertBusinessPromptReadyForConfig(candidate.effectiveConfig, {
      enabled: effectiveEnabled
    })
    assertCompiledPolicyValid(candidate.policy, {
      enabled: effectiveEnabled,
      effectiveConfig: candidate.effectiveConfig
    })
    const agent = await createConversationalAgent(req.body || {})
    const policy = await compileAgentPolicy(agent)
    const policyVersion = await recordConversationalPolicyVersion({
      agentId: agent.id,
      configSnapshot: agent,
      compiledPolicy: policy,
      source: 'form'
    })
    res.status(201).json({
      success: true,
      data: { ...agent, compiledPolicy: summarizeCompiledPolicy(policy), policyVersion: policyVersion.version }
    })
  } catch (error) {
    logger.error('Error creando agente conversacional:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al crear el agente',
      code: error.code,
      businessPromptStatus: error.businessPromptStatus,
      policyValidation: error.policyValidation,
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
    const candidate = await compileAgentPolicyWithConfig(req.body || {}, current)
    const effectiveEnabled = candidate.effectiveConfig.enabled !== false
    const publishesLegacyRuntime = effectiveEnabled && (
      req.body?.enabled === true ||
      (isToolCallingV2(current) && !isToolCallingV2(candidate.effectiveConfig))
    )
    await assertBusinessPromptReadyForConfig(candidate.effectiveConfig, {
      enabled: publishesLegacyRuntime
    })
    assertCompiledPolicyValid(candidate.policy, {
      enabled: effectiveEnabled,
      effectiveConfig: candidate.effectiveConfig
    })
    const agent = await updateConversationalAgent(req.params?.agentId, req.body || {})
    const persistedPolicy = await compileAgentPolicy(agent)
    const policyVersion = await recordConversationalPolicyVersion({
      agentId: agent.id,
      configSnapshot: agent,
      compiledPolicy: persistedPolicy,
      source: 'form'
    })
    res.json({
      success: true,
      data: { ...agent, compiledPolicy: summarizeCompiledPolicy(persistedPolicy), policyVersion: policyVersion.version }
    })
  } catch (error) {
    logger.error('Error actualizando agente conversacional:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al actualizar el agente',
      code: error.code,
      businessPromptStatus: error.businessPromptStatus,
      policyValidation: error.policyValidation,
      nativeRuntimeValidation: error.nativeRuntimeValidation,
      nativeRuntimeResourceValidation: error.nativeRuntimeResourceValidation,
      conflicts: error.conflicts
    })
  }
}

export async function getAgentGovernance(req, res) {
  try {
    const agent = await getConversationalAgent(req.params?.agentId)
    if (!agent) return res.status(404).json({ success: false, error: 'Agente conversacional no encontrado' })
    const [policyVersions, learningVersions] = await Promise.all([
      listConversationalPolicyVersions(agent.id),
      listConversationalLearningVersions(agent.id)
    ])
    res.json({ success: true, data: { agentId: agent.id, policyVersions, learningVersions } })
  } catch (error) {
    logger.error('Error cargando gobernanza del agente conversacional:', error)
    res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Error al cargar versiones del agente' })
  }
}

export async function generateAgentLearning(req, res) {
  try {
    const agent = await getConversationalAgent(req.params?.agentId)
    if (!agent) return res.status(404).json({ success: false, error: 'Agente conversacional no encontrado' })
    const activePolicy = (await listConversationalPolicyVersions(agent.id, { limit: 1 }))[0]
    const learning = await generateConversationalLearningVersion({
      agentId: agent.id,
      basePolicyHash: activePolicy?.policyHash || ''
    })
    res.status(201).json({ success: true, data: learning })
  } catch (error) {
    logger.error('Error generando aprendizaje conversacional:', error)
    res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Error al analizar el aprendizaje del agente', code: error.code })
  }
}

export async function reviewAgentLearning(req, res) {
  try {
    const learning = await reviewConversationalLearningVersion({
      agentId: req.params?.agentId,
      learningId: req.params?.learningId,
      decision: req.body?.decision,
      reviewedBy: req.user?.id || req.user?.userId || null
    })
    res.json({ success: true, data: learning })
  } catch (error) {
    logger.error('Error revisando aprendizaje conversacional:', error)
    res.status(error.statusCode || 500).json({ success: false, error: error.message || 'Error al revisar el aprendizaje del agente', code: error.code })
  }
}

export async function rollbackAgentPolicy(req, res) {
  try {
    const agentId = req.params?.agentId
    const current = await getConversationalAgent(agentId)
    if (!current) return res.status(404).json({ success: false, error: 'Agente conversacional no encontrado' })
    const target = await getConversationalPolicyVersion(agentId, req.params?.versionId)
    if (!target) return res.status(404).json({ success: false, error: 'Versión de política no encontrada' })

    const candidate = await compileAgentPolicyWithConfig(target.configSnapshot || {}, current)
    const effectiveEnabled = candidate.effectiveConfig.enabled !== false
    await assertBusinessPromptReadyForConfig(candidate.effectiveConfig, {
      enabled: effectiveEnabled
    })
    assertCompiledPolicyValid(candidate.policy, {
      enabled: effectiveEnabled,
      effectiveConfig: candidate.effectiveConfig
    })
    const agent = await updateConversationalAgent(agentId, target.configSnapshot || {})
    const policy = await compileAgentPolicy(agent)
    const policyVersion = await recordConversationalPolicyVersion({
      agentId,
      configSnapshot: agent,
      compiledPolicy: policy,
      source: 'rollback'
    })
    res.json({
      success: true,
      data: { ...agent, compiledPolicy: summarizeCompiledPolicy(policy), policyVersion: policyVersion.version, rolledBackFrom: target.version }
    })
  } catch (error) {
    logger.error('Error revirtiendo la política conversacional:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Error al revertir la configuración del agente',
      code: error.code,
      policyValidation: error.policyValidation,
      nativeRuntimeValidation: error.nativeRuntimeValidation,
      nativeRuntimeResourceValidation: error.nativeRuntimeResourceValidation
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
