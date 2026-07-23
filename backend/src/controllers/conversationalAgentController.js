import { logger } from '../utils/logger.js'
import {
  getConversationalAgentConfig,
  getConversationState,
  getManualConversationAgentAssignment,
  listConversationStatesForContact,
  setConversationStatus,
  assignAgentToContactManually,
  setManualConversationAgentStatus,
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
import {
  buildConversationalAgentTestRuntimeEventContext,
  buildConversationalAgentTestTurnRequestHash,
  cleanupConversationalAgentTestRun,
  executeConversationalAgentTestTurn,
  getConversationalAgentTestVerifiedPaymentEvidence,
  isConversationalAgentTestMaterializationTerminal,
  listConversationalAgentTestEffects,
  listRecentConversationalAgentTestRuns,
  normalizeConversationalAgentTestEffects,
  prepareConversationalAgentTestRun,
  replayCompletedConversationalAgentTestTurn,
  reconcileConversationalAgentPreviewResult,
  recordConversationalAgentPreviewEffects
} from '../services/conversationalAgentTestService.js'
import { hasUserAccess } from '../utils/userAccess.js'
import { resolveConversationalAgentPreventiveMeasuresForContact } from '../services/conversationalAgentSafetyService.js'
import {
  buildConversationalAppointmentPreviewExecutionId,
  buildConversationalAppointmentPreviewScopeId
} from '../services/conversationalAppointmentPreviewOfferService.js'

function assertConversationalTesterAccess(user, effects) {
  if (!effects?.enabled) return
  if (!hasUserAccess(user, 'contacts', 'read')) {
    const error = new Error('Necesitas acceso a Contactos para registrar acciones aisladas de esta prueba.')
    error.statusCode = 403
    error.code = 'test_contacts_access_required'
    throw error
  }
  if (effects.assignUser && !hasUserAccess(user, 'contacts', 'write')) {
    const error = new Error('Necesitas permiso para editar Contactos antes de probar una asignación temporal.')
    error.statusCode = 403
    error.code = 'test_contacts_write_required'
    throw error
  }
  if (effects.scheduleAppointment && !hasUserAccess(user, 'appointments', 'write')) {
    const error = new Error('Necesitas permiso para editar Citas antes de registrar una cita de prueba.')
    error.statusCode = 403
    error.code = 'test_appointments_write_required'
    throw error
  }
  if (effects.collectPayment && !hasUserAccess(user, 'payments', 'write')) {
    const error = new Error('Necesitas permiso para editar Pagos antes de preparar un cobro de prueba.')
    error.statusCode = 403
    error.code = 'test_payments_write_required'
    throw error
  }
}

export function lockConversationalTesterConfigOverride(configOverride, persistedAgent) {
  return {
    ...(configOverride && typeof configOverride === 'object' ? configOverride : {}),
    id: persistedAgent.id,
    capabilitiesConfig: persistedAgent.capabilitiesConfig,
    defaultCalendarId: persistedAgent.defaultCalendarId,
    goalWorkflow: persistedAgent.goalWorkflow
  }
}

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

/**
 * El runtime conserva una fila por canal, pero el contrato de includeAll es una
 * lista de agentes para controlar en la UI. Entrega como máximo una asignación
 * viva por agentId y conserva aparte estados terminales/señales de auditoría.
 */
export function collapseAssignedAgentStatesForPresentation(states = []) {
  const source = Array.isArray(states) ? states : []
  const winnerByAgentId = new Map()

  for (const state of source) {
    const agentId = String(state?.agentId || '').trim()
    const status = String(state?.status || '').trim().toLowerCase()
    if (!agentId || !['active', 'paused'].includes(status)) continue

    const current = winnerByAgentId.get(agentId)
    if (!current) {
      winnerByAgentId.set(agentId, state)
      continue
    }

    const currentStatus = String(current.status || '').trim().toLowerCase()
    const candidateWinsByStatus = currentStatus !== 'active' && status === 'active'
    const candidateWinsByRecency = currentStatus === status &&
      String(state.updatedAt || '') > String(current.updatedAt || '')
    if (candidateWinsByStatus || candidateWinsByRecency) {
      winnerByAgentId.set(agentId, state)
    }
  }

  return source.filter((state) => {
    const agentId = String(state?.agentId || '').trim()
    const status = String(state?.status || '').trim().toLowerCase()
    if (!agentId || !['active', 'paused'].includes(status)) return true
    return winnerByAgentId.get(agentId) === state
  })
}

export async function getState(req, res) {
  try {
    const includeAll = ['1', 'true', 'yes'].includes(String(req.query?.includeAll || '').trim().toLowerCase())
    if (includeAll) {
      const states = await listConversationStatesForContact(req.params?.contactId)
      return res.json({
        success: true,
        data: collapseAssignedAgentStatesForPresentation(states)
      })
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

    // Reactivar/reanudar es la salida humana visible de una cuarentena
    // preventiva. Se resuelve primero: si la auditoría falla, no dejamos la UI
    // diciendo "activo" mientras el runtime todavía mantiene el hilo mudo.
    if (action === 'activate' || action === 'resume') {
      await resolveConversationalAgentPreventiveMeasuresForContact({
        contactId,
        resolvedBy: String(req.user?.userId || 'authenticated_user'),
        reason: action === 'activate'
          ? 'El usuario reactivó manualmente el agente para este contacto.'
          : 'El usuario reanudó manualmente la conversación.'
      })
    }

    if (action === 'activate' && agentId) {
      const state = await assignAgentToContactManually(contactId, agentId, {
        channel: req.body?.channel || null,
        updatedBy: 'user'
      })
      return res.json({ success: true, data: state })
    }

    const manualAssignment = await getManualConversationAgentAssignment(contactId)
    const manualAgentId = String(manualAssignment?.agentId || '').trim()
    let state = manualAgentId && (!agentId || manualAgentId === agentId)
      ? await setManualConversationAgentStatus(contactId, mapped.status, {
          agentId: manualAgentId,
          pausedUntilAt: req.body?.pausedUntilAt || null,
          clearSignal: mapped.clearSignal,
          updatedBy: 'user',
          channel: req.body?.channel || null
        })
      : null

    if (!state) {
      state = await setConversationStatus(contactId, mapped.status, {
        updatedBy: 'user',
        clearSignal: mapped.clearSignal,
        pausedUntilAt: req.body?.pausedUntilAt || null,
        activationSource: 'manual',
        agentId: agentId || null,
        channel: req.body?.channel || null
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
    const requestedEffects = normalizeConversationalAgentTestEffects(req.body?.effects)
    assertConversationalTesterAccess(req.user, requestedEffects)
    const agentId = String(req.body?.agentId || '').trim()
    let runContext = null
    let configOverride = req.body?.config || null

    if (requestedEffects.enabled) {
      if (!agentId) {
        return res.status(400).json({ success: false, error: 'Guarda el agente antes de registrar acciones de prueba.' })
      }
      const clientRequestHash = buildConversationalAgentTestTurnRequestHash({
        schemaVersion: 1,
        messages: req.body?.messages || [],
        configOverride: req.body?.config || null,
        agentId,
        contactId: req.body?.contactId || null,
        effects: requestedEffects
      })
      const completedReplay = await replayCompletedConversationalAgentTestTurn({
        testRunId: req.body?.testSessionId,
        testMessageId: req.body?.testMessageId,
        requestedByUserId: req.user?.userId,
        clientRequestHash
      })
      if (completedReplay) {
        return res.json({ success: true, data: completedReplay })
      }
      const persistedAgent = await getConversationalAgent(agentId)
      if (!persistedAgent) {
        return res.status(404).json({ success: false, error: 'El agente de esta prueba ya no existe.' })
      }
      // En una prueba con efectos, el texto editable puede venir de la pantalla,
      // pero calendario, producto, precio, monto y dueño de agenda siempre salen
      // de la versión guardada en servidor.
      configOverride = lockConversationalTesterConfigOverride(configOverride, persistedAgent)
      runContext = await prepareConversationalAgentTestRun({
        testRunId: req.body?.testSessionId,
        testMessageId: req.body?.testMessageId,
        agentId,
        requestedByUserId: req.user?.userId,
        contactId: req.body?.contactId,
        effects: requestedEffects,
        messages: req.body?.messages,
        configOverride,
        clientRequestHash
      })
    }

    const previewScopeId = buildConversationalAppointmentPreviewScopeId({
      testSessionId: req.body?.testSessionId,
      requestedByUserId: req.user?.userId,
      agentId
    })
    const previewExecutionId = runContext?.executionId || buildConversationalAppointmentPreviewExecutionId({
      previewScopeId,
      testMessageId: req.body?.testMessageId
    })
    const createPreview = async () => {
      const runtimeEventContext = runContext
        ? await buildConversationalAgentTestRuntimeEventContext({ runContext })
        : ''
      const testVerifiedPaymentEvidence = runContext
        ? await getConversationalAgentTestVerifiedPaymentEvidence({ runContext })
        : null
      return runConversationalAgentPreview({
        messages: req.body?.messages,
        configOverride,
        agentId: agentId || null,
        previewContact: runContext?.contact || null,
        executionId: previewExecutionId,
        previewScopeId,
        testVerifiedPaymentEvidence,
        runtimeEventContext
      })
    }
    const materializePreview = async (result) => {
      const testEffects = runContext
        ? await recordConversationalAgentPreviewEffects({ runContext, actions: result.actions })
        : []
      const reconciledResult = runContext
        ? reconcileConversationalAgentPreviewResult({ result, testEffects })
        : result
      const paymentLinks = testEffects
        .filter((effect) => effect?.type === 'payment' && /^https?:\/\//i.test(effect?.payload?.paymentUrl || ''))
        .map((effect) => effect.payload.paymentUrl)
      const uniquePaymentLinks = [...new Set(paymentLinks)]
      const testPaymentMessages = uniquePaymentLinks.map((url) => `Aquí está el enlace sandbox de esta prueba: ${url}`)
      const visibleResult = testPaymentMessages.length
        ? {
            ...reconciledResult,
            reply: [reconciledResult.reply, ...testPaymentMessages].filter(Boolean).join('\n\n'),
            replyParts: [...(Array.isArray(reconciledResult.replyParts) ? reconciledResult.replyParts : [reconciledResult.reply].filter(Boolean)), ...testPaymentMessages],
            replyPartDelaysMs: [
              ...(Array.isArray(reconciledResult.replyPartDelaysMs) ? reconciledResult.replyPartDelaysMs : []),
              ...testPaymentMessages.map(() => 0)
            ]
          }
        : reconciledResult
      return {
        kind: 'conversational_agent_test_turn_materialization',
        terminal: isConversationalAgentTestMaterializationTerminal(testEffects),
        response: {
          ...visibleResult,
          ...(runContext ? {
            testRunId: runContext.id,
            testContactId: runContext.contact.id,
            testContactEmail: runContext.contact.email,
            testEffects
          } : {})
        }
      }
    }

    const data = runContext
      ? (await executeConversationalAgentTestTurn({
          runContext,
          requestHash: runContext.requestHash || buildConversationalAgentTestTurnRequestHash({
            schemaVersion: 1,
            messages: req.body?.messages || [],
            configOverride,
            agentId,
            contactId: runContext.contact?.id || req.body?.contactId || null,
            effects: runContext.effects
          }),
          createPreview,
          materializePreview
        })).response
      : (await materializePreview(await createPreview())).response

    res.json({ success: true, data })
  } catch (error) {
    logger.error('Error en prueba del agente conversacional:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      code: error.code,
      error: error.message || 'Error al probar el agente conversacional'
    })
  }
}

export async function getTestRunEffects(req, res) {
  try {
    const effects = await listConversationalAgentTestEffects({
      testRunId: req.params?.testRunId,
      requestedByUserId: req.user?.userId
    })
    res.json({ success: true, data: effects })
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, code: error.code, error: error.message })
  }
}

export async function listAgentTestRuns(req, res) {
  try {
    const runs = await listRecentConversationalAgentTestRuns({
      agentId: req.params?.agentId,
      requestedByUserId: req.user?.userId,
      limit: req.query?.limit
    })
    res.json({ success: true, data: runs })
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, code: error.code, error: error.message })
  }
}

export async function cleanupTestRun(req, res) {
  try {
    const result = await cleanupConversationalAgentTestRun({
      testRunId: req.params?.testRunId,
      requestedByUserId: req.user?.userId
    })
    res.json({ success: true, data: result })
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, code: error.code, error: error.message })
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
