import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import { updateState } from '../src/controllers/conversationalAgentController.js'
import {
  assignAgentToConversation,
  buildRuleContext,
  createConversationalAgent,
  getConversationState,
  isStaleInheritedConversationStateForAgent,
  listConversationStates,
  listConversationalAgentEvents,
  matchAgentForMessage,
  resetConversationalAgentSkippedContacts,
  setConversationStatus,
  setConversationSignal
} from '../src/services/conversationalAgentService.js'
import { resolveInboundAgentForContact } from '../src/agents/conversational/runner.js'

const READY_BUSINESS_PROFILE = {
  businessName: 'Clínica Test',
  industry: 'servicios médicos',
  businessType: 'service',
  description: 'Atiende pacientes con seguimiento humano y citas programadas.',
  conversationAdaptation: {
    narrativeFrame: 'Guía al paciente con claridad clínica y contraste tranquilo.',
    customerPerception: 'Debe sentirse como orientación profesional, no como venta.',
    languageGuidance: 'Habla de síntomas, seguimiento, citas y claridad del siguiente paso.',
    contrastFrame: 'Contrasta seguir esperando contra revisar una ruta de atención.',
    discoveryAngles: ['qué cambió ahora', 'qué le preocupa', 'qué resultado busca'],
    safeValueLanguage: 'Habla de revisar si tiene sentido agendar.',
    forbiddenSalesLanguage: 'Evita compra, oferta, pago e inversión.'
  }
}

const READY_PROMPT_PARAMETERS = {
  NOMBRE_DEL_NEGOCIO: 'Clínica Test',
  INDUSTRIA: 'servicios médicos',
  PRODUCTO_O_SERVICIO: 'seguimiento médico y citas',
  INFO_GENERAL_DEL_NEGOCIO: READY_BUSINESS_PROFILE.description,
  VALOR: 'atención médica con seguimiento claro',
  UBICACION_O_MODALIDAD: 'modalidad configurada por el negocio',
  DISPONIBILIDAD: 'consulta disponibilidad real antes de confirmar horarios',
  CONDICIONES_IMPORTANTES: 'sin condiciones adicionales configuradas',
  ADAPTACION_CONVERSACIONAL_DEL_NEGOCIO: 'Adapta la conversación a servicios médicos: guía con autoridad tranquila, explora síntomas, urgencia y consecuencia de esperar sin empujar.',
  LENGUAJE_DEL_NEGOCIO: 'Habla de pacientes, citas, seguimiento y claridad clínica.',
  NARRATIVA_DE_CONTRASTE_DEL_NEGOCIO: 'Contrasta quedarse esperando contra revisar una ruta de atención.',
  PERCEPCION_DEL_CLIENTE: 'Orientación profesional y cercana.',
  PREGUNTAS_DE_DESCUBRIMIENTO_DEL_NEGOCIO: 'qué cambió ahora, qué le preocupa, qué resultado busca',
  RIESGO_VERBAL_A_EVITAR: 'compra, oferta, pago e inversión'
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    }
  }
}

async function getStoredBusinessProfileRow() {
  return db.get('SELECT * FROM ai_business_profile WHERE id = 1').catch(() => null)
}

async function restoreBusinessProfileRow(row) {
  await db.run('DELETE FROM ai_business_profile WHERE id = 1').catch(() => undefined)
  if (!row) return

  const columns = Object.keys(row)
  const placeholders = columns.map(() => '?').join(', ')
  await db.run(
    `INSERT INTO ai_business_profile (${columns.join(', ')}) VALUES (${placeholders})`,
    columns.map((column) => row[column])
  )
}

async function seedReadyBusinessProfile() {
  await db.run(`
    INSERT INTO ai_business_profile (
      id,
      source_context,
      source_hash,
      profile_json,
      prompt_parameters_json,
      profile_summary,
      business_name,
      industry,
      business_type,
      offerings_summary,
      pricing_summary,
      location_summary,
      payment_summary,
      contact_summary,
      extraction_status,
      extraction_error,
      extracted_at,
      updated_at
    )
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      source_context = excluded.source_context,
      source_hash = excluded.source_hash,
      profile_json = excluded.profile_json,
      prompt_parameters_json = excluded.prompt_parameters_json,
      profile_summary = excluded.profile_summary,
      business_name = excluded.business_name,
      industry = excluded.industry,
      business_type = excluded.business_type,
      offerings_summary = excluded.offerings_summary,
      pricing_summary = excluded.pricing_summary,
      location_summary = excluded.location_summary,
      payment_summary = excluded.payment_summary,
      contact_summary = excluded.contact_summary,
      extraction_status = excluded.extraction_status,
      extraction_error = excluded.extraction_error,
      extracted_at = excluded.extracted_at,
      updated_at = CURRENT_TIMESTAMP
  `, [
    'Clínica Test atiende pacientes con seguimiento humano y citas programadas.',
    `test-ready-${randomUUID()}`,
    JSON.stringify(READY_BUSINESS_PROFILE),
    JSON.stringify(READY_PROMPT_PARAMETERS),
    'Clínica Test atiende pacientes con seguimiento humano y citas programadas.',
    READY_BUSINESS_PROFILE.businessName,
    READY_BUSINESS_PROFILE.industry,
    READY_BUSINESS_PROFILE.businessType,
    'seguimiento médico y citas',
    '',
    '',
    '',
    '',
    'ready',
    null
  ])
}

async function cleanup(contactId, agentId) {
  await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  if (agentId) {
    await db.run('DELETE FROM conversational_agent_events WHERE detail_json LIKE ?', [`%${agentId}%`]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => undefined)
  }
}

async function cleanupAgent(agentId) {
  if (!agentId) return
  await db.run('DELETE FROM conversational_agent_events WHERE detail_json LIKE ?', [`%${agentId}%`]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_state WHERE agent_id = ?', [agentId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => undefined)
}

async function seedContact(contactId, { createdAt = null } = {}) {
  const timestamp = createdAt || new Date().toISOString()
  const phoneSuffix = String(contactId || randomUUID()).replace(/\D/g, '').slice(-10).padStart(10, '0')
  await db.run(`
    INSERT INTO contacts (id, full_name, first_name, phone, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [contactId, 'Contacto Test', 'Contacto', `+52${phoneSuffix}`, 'test', timestamp, timestamp])
}

test('activar una conversación con agentId asigna ese agente al estado', async () => {
  const contactId = `conversation_agent_state_${randomUUID()}`
  const previousBusinessProfile = await getStoredBusinessProfileRow()
  let agentId = ''

  try {
    await seedReadyBusinessProfile()
    const agent = await createConversationalAgent({
      name: 'Agente test desktop',
      enabled: true,
      objective: 'citas'
    })
    agentId = agent.id

    const res = createMockResponse()
    await updateState({
      params: { contactId },
      body: { action: 'activate', agentId }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.body?.success, true)
    assert.equal(res.body?.data?.status, 'active')
    assert.equal(res.body?.data?.agentId, agentId)
    assert.ok(res.body?.data?.activatedAt)
    assert.equal(res.body?.data?.activationSource, 'manual')
    assert.equal(res.body?.data?.activatedBy, 'user')
  } finally {
    await cleanup(contactId, agentId)
    await restoreBusinessProfileRow(previousBusinessProfile)
  }
})

test('la asignación automática marca la conversación como activada por el agente', async () => {
  const contactId = `conversation_agent_auto_state_${randomUUID()}`
  let agentId = ''

  try {
    const agent = await createConversationalAgent({
      name: 'Agente automático test',
      enabled: true,
      objective: 'citas'
    })
    agentId = agent.id

    await assignAgentToConversation(contactId, agentId, {
      activationSource: 'automatic',
      updatedBy: 'agent'
    })

    const state = await getConversationState(contactId)
    assert.equal(state?.status, 'active')
    assert.equal(state?.agentId, agentId)
    assert.ok(state?.activatedAt)
    assert.equal(state?.activationSource, 'automatic')
    assert.equal(state?.activatedBy, 'agent')
  } finally {
    await cleanup(contactId, agentId)
  }
})

test('omitir una conversación conserva el estado en la lista de omitidos', async () => {
  const contactId = `conversation_agent_skipped_state_${randomUUID()}`

  try {
    const res = createMockResponse()
    await updateState({
      params: { contactId },
      body: { action: 'skip' }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.body?.success, true)
    assert.equal(res.body?.data?.status, 'skipped')
    assert.ok(res.body?.data?.activatedAt)
    assert.equal(res.body?.data?.activationSource, 'manual')

    const skippedStates = await listConversationStates({ statuses: ['skipped'] })
    const skipped = skippedStates.find((state) => state.contactId === contactId)
    assert.equal(skipped?.status, 'skipped')
    assert.equal(skipped?.activationSource, 'manual')
  } finally {
    await cleanup(contactId)
  }
})

test('un agente nuevo catch-all no hereda omisiones legacy anteriores', async () => {
  const contactId = `conversation_agent_legacy_skip_${randomUUID()}`
  let agentId = ''

  try {
    await seedContact(contactId)
    await db.run(`
      INSERT INTO conversational_agent_state (
        id, contact_id, status, updated_by, activated_at, activation_source, activated_by, created_at, updated_at
      ) VALUES (?, ?, 'skipped', 'user', '2026-01-01 00:00:00', 'manual', 'user', '2026-01-01 00:00:00', '2026-01-01 00:00:00')
    `, [`cas_${randomUUID()}`, contactId])

    const agent = await createConversationalAgent({
      name: 'Agente nuevo todos los chats',
      enabled: true,
      objective: 'citas'
    })
    agentId = agent.id

    const legacyState = await db.get(
      'SELECT agent_id, status FROM conversational_agent_state WHERE contact_id = ?',
      [contactId]
    )
    assert.equal(legacyState?.status, 'skipped')
    assert.equal(legacyState?.agent_id, null)

    const matched = await matchAgentForMessage({ contactId, messageText: 'Costos', channel: 'whatsapp' })
    assert.equal(matched?.id, agentId)
  } finally {
    await cleanup(contactId, agentId)
  }
})

test('un bloqueo heredado más viejo que el agente se suelta antes del matching automático', async () => {
  const contactId = `conversation_agent_stale_skip_${randomUUID()}`
  let agentId = ''

  try {
    await seedContact(contactId)
    const agent = await createConversationalAgent({
      name: 'Agente nuevo desbloquea legacy',
      enabled: true,
      objective: 'citas'
    })
    agentId = agent.id

    await db.run(`
      INSERT INTO conversational_agent_state (
        id, contact_id, agent_id, status, updated_by, activated_at, activation_source, activated_by, created_at, updated_at
      ) VALUES (?, ?, ?, 'skipped', 'user', '2026-01-01 00:00:00', 'manual', 'user', '2026-01-01 00:00:00', '2026-01-01 00:00:00')
    `, [`cas_${randomUUID()}`, contactId, agentId])

    const staleState = await getConversationState(contactId, { agentId })
    assert.equal(isStaleInheritedConversationStateForAgent(staleState, agent), true)

    const ruleContext = await buildRuleContext({ contactId, messageText: 'Costos', channel: 'whatsapp' })
    const resolved = await resolveInboundAgentForContact({
      contactId,
      messageText: 'Costos',
      channel: 'whatsapp',
      ruleContext
    })

    assert.equal(resolved.agentConfig?.id, agentId)
    assert.equal(resolved.assigned, true)
    assert.equal(resolved.state?.status, 'active')

    const activeState = await getConversationState(contactId, { agentId })
    assert.equal(activeState?.status, 'active')
    assert.equal(activeState?.activationSource, 'automatic')

    const events = await listConversationalAgentEvents({ contactId })
    assert.ok(events.some((event) => (
      event.eventType === 'agent_released' &&
      event.detail?.reason === 'stale_inherited_state' &&
      event.detail?.agentId === agentId
    )))
  } finally {
    await cleanup(contactId, agentId)
  }
})

test('un estado pausado de otro agente no bloquea a un agente nuevo', async () => {
  const contactId = `conversation_agent_isolated_pause_${randomUUID()}`
  const latestMessageId = `waapi_msg_isolated_${randomUUID()}`
  let oldAgentId = ''
  let newAgentId = ''

  try {
    await seedContact(contactId)
    const oldAgent = await createConversationalAgent({
      name: 'Agente viejo pausado',
      enabled: false,
      objective: 'citas'
    })
    oldAgentId = oldAgent.id

    await assignAgentToConversation(contactId, oldAgentId, {
      activationSource: 'automatic',
      updatedBy: 'agent'
    })
    await setConversationStatus(contactId, 'paused', { updatedBy: 'user', agentId: oldAgentId })

    const newAgent = await createConversationalAgent({
      name: 'Agente nuevo independiente',
      enabled: true,
      objective: 'citas'
    })
    newAgentId = newAgent.id

    const ruleContext = await buildRuleContext({ contactId, messageText: 'Costos', channel: 'whatsapp' })
    const resolved = await resolveInboundAgentForContact({
      contactId,
      messageText: 'Costos',
      channel: 'whatsapp',
      ruleContext,
      latestMessageId
    })

    assert.equal(resolved.agentConfig?.id, newAgentId)
    assert.equal(resolved.assigned, true)

    const oldState = await getConversationState(contactId, { agentId: oldAgentId })
    const newState = await getConversationState(contactId, { agentId: newAgentId })
    assert.equal(oldState?.status, 'paused')
    assert.equal(newState?.status, 'active')
    assert.equal(newState?.activationSource, 'automatic')
  } finally {
    await cleanup(contactId, oldAgentId)
    await cleanupAgent(newAgentId)
  }
})

test('un agente solo para contactos nuevos respeta su corte al hacer matching real', async () => {
  const oldContactId = `conversation_agent_scope_old_${randomUUID()}`
  const newContactId = `conversation_agent_scope_new_${randomUUID()}`
  let agentId = ''

  try {
    const agent = await createConversationalAgent({
      name: 'Agente solo nuevos',
      enabled: true,
      objective: 'citas',
      contactScope: 'new_only'
    })
    agentId = agent.id
    const cutoffMs = Date.parse(agent.contactScopeCutoffAt)
    assert.equal(Number.isFinite(cutoffMs), true)

    await seedContact(oldContactId, { createdAt: new Date(cutoffMs - 1000).toISOString() })
    await seedContact(newContactId, { createdAt: new Date(cutoffMs + 1000).toISOString() })

    const oldMatch = await matchAgentForMessage({ contactId: oldContactId, messageText: 'Costos', channel: 'whatsapp' })
    const newMatch = await matchAgentForMessage({ contactId: newContactId, messageText: 'Costos', channel: 'whatsapp' })

    assert.equal(oldMatch, null)
    assert.equal(newMatch?.id, agentId)
  } finally {
    await cleanup(oldContactId, agentId)
    await cleanup(newContactId)
  }
})

test('pausar una conversación desde el controller guarda la ventana enviada por la UI', async () => {
  const contactId = `conversation_agent_pause_state_${randomUUID()}`
  const pausedUntilAt = new Date(Date.now() + (24 * 60 * 60 * 1000)).toISOString()

  try {
    const res = createMockResponse()
    await updateState({
      params: { contactId },
      body: { action: 'pause', pausedUntilAt }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.body?.success, true)
    assert.equal(res.body?.data?.status, 'paused')
    assert.equal(res.body?.data?.pausedUntilAt, pausedUntilAt)
    assert.equal(res.body?.data?.updatedBy, 'user')

    const stored = await db.get('SELECT status, paused_until_at, updated_by FROM conversational_agent_state WHERE contact_id = ?', [contactId])
    assert.equal(stored.status, 'paused')
    assert.equal(stored.paused_until_at, pausedUntilAt)
    assert.equal(stored.updated_by, 'user')
  } finally {
    await cleanup(contactId)
  }
})

test('reinicia las omisiones de contactos de un agente sin tocar otros estados', async () => {
  const skippedContactA = `conversation_agent_reset_skipped_a_${randomUUID()}`
  const skippedContactB = `conversation_agent_reset_skipped_b_${randomUUID()}`
  const pausedContact = `conversation_agent_reset_paused_${randomUUID()}`
  const otherAgentContact = `conversation_agent_reset_other_${randomUUID()}`
  let agentId = ''
  let otherAgentId = ''

  try {
    const agent = await createConversationalAgent({
      name: 'Agente omisiones test',
      enabled: false,
      objective: 'citas'
    })
    const otherAgent = await createConversationalAgent({
      name: 'Agente omisiones externo',
      enabled: false,
      objective: 'ventas'
    })
    agentId = agent.id
    otherAgentId = otherAgent.id

    await assignAgentToConversation(skippedContactA, agentId, { activationSource: 'automatic', updatedBy: 'agent' })
    await assignAgentToConversation(skippedContactB, agentId, { activationSource: 'automatic', updatedBy: 'agent' })
    await assignAgentToConversation(pausedContact, agentId, { activationSource: 'automatic', updatedBy: 'agent' })
    await assignAgentToConversation(otherAgentContact, otherAgentId, { activationSource: 'automatic', updatedBy: 'agent' })
    await setConversationStatus(skippedContactA, 'skipped', { updatedBy: 'user' })
    await setConversationStatus(skippedContactB, 'skipped', { updatedBy: 'user' })
    await setConversationStatus(pausedContact, 'paused', { updatedBy: 'user' })
    await setConversationStatus(otherAgentContact, 'skipped', { updatedBy: 'user' })

    const result = await resetConversationalAgentSkippedContacts(agentId, { updatedBy: 'user' })

    assert.deepEqual(result, { agentId, resetCount: 2 })
    assert.equal((await getConversationState(skippedContactA))?.status, 'active')
    assert.equal((await getConversationState(skippedContactB))?.status, 'active')
    assert.equal((await getConversationState(pausedContact))?.status, 'paused')
    assert.equal((await getConversationState(otherAgentContact))?.status, 'skipped')

    const events = await listConversationalAgentEvents({ contactId: skippedContactA })
    assert.ok(events.some((event) => (
      event.eventType === 'status_changed' &&
      event.detail?.reason === 'agent_skips_reset' &&
      event.detail?.agentId === agentId
    )))
  } finally {
    await cleanup(skippedContactA, agentId)
    await cleanup(skippedContactB)
    await cleanup(pausedContact)
    await cleanup(otherAgentContact, otherAgentId)
  }
})

test('reiniciar omisiones opera por agente aunque el contacto tenga otro agente activo', async () => {
  const contactId = `conversation_agent_reset_same_contact_${randomUUID()}`
  let skippedAgentId = ''
  let activeAgentId = ''

  try {
    await seedContact(contactId)
    const skippedAgent = await createConversationalAgent({
      name: 'Agente omitido del mismo contacto',
      enabled: false,
      objective: 'citas'
    })
    const activeAgent = await createConversationalAgent({
      name: 'Agente activo del mismo contacto',
      enabled: false,
      objective: 'ventas'
    })
    skippedAgentId = skippedAgent.id
    activeAgentId = activeAgent.id

    await assignAgentToConversation(contactId, skippedAgentId, { activationSource: 'automatic', updatedBy: 'agent' })
    await assignAgentToConversation(contactId, activeAgentId, { activationSource: 'automatic', updatedBy: 'agent' })
    await setConversationStatus(contactId, 'skipped', { updatedBy: 'user', agentId: skippedAgentId })

    const result = await resetConversationalAgentSkippedContacts(skippedAgentId, { updatedBy: 'user' })
    assert.deepEqual(result, { agentId: skippedAgentId, resetCount: 1 })

    const skippedAgentState = await getConversationState(contactId, { agentId: skippedAgentId })
    const activeAgentState = await getConversationState(contactId, { agentId: activeAgentId })
    assert.equal(skippedAgentState?.status, 'active')
    assert.equal(activeAgentState?.status, 'active')
    assert.equal(activeAgentState?.agentId, activeAgentId)
  } finally {
    await cleanup(contactId, skippedAgentId)
    await cleanupAgent(activeAgentId)
  }
})

test('un mensaje nuevo reabre una conversación completada con acción concreta no-handoff', async () => {
  const contactId = `conversation_agent_reopen_completed_${randomUUID()}`
  const answeredMessageId = `waapi_msg_answered_${randomUUID()}`
  const newMessageId = `waapi_msg_new_${randomUUID()}`
  let agentId = ''

  try {
    await seedContact(contactId)
    const agent = await createConversationalAgent({
      name: 'Agente reapertura test',
      enabled: true,
      objective: 'citas'
    })
    agentId = agent.id

    await assignAgentToConversation(contactId, agentId, {
      activationSource: 'automatic',
      updatedBy: 'agent'
    })
    await setConversationSignal(contactId, 'appointment_booked', {
      reason: 'Cita agendada por el agente',
      actionSummarySource: 'Cita test',
      summary: 'El contacto ya tenía una cita creada.',
      status: 'completed',
      agentId
    })
    await db.run(`
      UPDATE conversational_agent_state
      SET last_inbound_message_id = ?, last_answered_inbound_message_id = ?, last_reply_at = CURRENT_TIMESTAMP
      WHERE contact_id = ? AND agent_id = ?
    `, [answeredMessageId, answeredMessageId, contactId, agentId])

    const answeredRuleContext = await buildRuleContext({ contactId, messageText: 'Costos', channel: 'whatsapp' })
    const alreadyAnswered = await resolveInboundAgentForContact({
      contactId,
      messageText: 'Costos',
      channel: 'whatsapp',
      ruleContext: answeredRuleContext,
      latestMessageId: answeredMessageId
    })
    assert.equal(alreadyAnswered.agentConfig, null)

    const newRuleContext = await buildRuleContext({ contactId, messageText: 'Costos otra vez', channel: 'whatsapp' })
    const reopened = await resolveInboundAgentForContact({
      contactId,
      messageText: 'Costos otra vez',
      channel: 'whatsapp',
      ruleContext: newRuleContext,
      latestMessageId: newMessageId
    })

    assert.equal(reopened.agentConfig?.id, agentId)
    assert.equal(reopened.assigned, false)
    assert.equal(reopened.state?.status, 'active')
    assert.equal(reopened.state?.signal, null)

    const activeState = await getConversationState(contactId, { agentId })
    assert.equal(activeState?.status, 'active')
    assert.equal(activeState?.signal, null)

    const events = await listConversationalAgentEvents({ contactId })
    assert.ok(events.some((event) => (
      event.eventType === 'agent_reopened' &&
      event.detail?.reason === 'new_inbound_after_completion' &&
      event.detail?.messageId === newMessageId &&
      event.detail?.agentId === agentId
    )))
  } finally {
    await cleanup(contactId, agentId)
  }
})

test('un handoff completado no se reabre solo con mensajes nuevos', async () => {
  const contactId = `conversation_agent_no_reopen_handoff_${randomUUID()}`
  const answeredMessageId = `waapi_msg_answered_${randomUUID()}`
  const newMessageId = `waapi_msg_new_${randomUUID()}`
  let agentId = ''

  try {
    await seedContact(contactId)
    const agent = await createConversationalAgent({
      name: 'Agente handoff terminal test',
      enabled: true,
      objective: 'citas',
      successAction: 'ready_for_human'
    })
    agentId = agent.id

    await assignAgentToConversation(contactId, agentId, {
      activationSource: 'automatic',
      updatedBy: 'agent'
    })
    await setConversationSignal(contactId, 'ready_for_human', {
      reason: 'El contacto aceptó pasar con el equipo',
      summary: 'El humano debe confirmar el siguiente paso.',
      status: 'completed',
      agentId
    })
    await db.run(`
      UPDATE conversational_agent_state
      SET last_inbound_message_id = ?, last_answered_inbound_message_id = ?, last_reply_at = CURRENT_TIMESTAMP
      WHERE contact_id = ? AND agent_id = ?
    `, [answeredMessageId, answeredMessageId, contactId, agentId])

    const ruleContext = await buildRuleContext({ contactId, messageText: 'Quedo pendiente', channel: 'whatsapp' })
    const resolved = await resolveInboundAgentForContact({
      contactId,
      messageText: 'Quedo pendiente',
      channel: 'whatsapp',
      ruleContext,
      latestMessageId: newMessageId
    })

    assert.equal(resolved.agentConfig, null)

    const state = await getConversationState(contactId, { agentId })
    assert.equal(state?.status, 'completed')
    assert.equal(state?.signal, 'ready_for_human')

    const events = await listConversationalAgentEvents({ contactId })
    assert.equal(events.some((event) => event.eventType === 'agent_reopened'), false)
  } finally {
    await cleanup(contactId, agentId)
  }
})

test('los resúmenes de cierre solo salen cuando el agente asignado completa el objetivo', async () => {
  const assignedContactId = `conversation_agent_completed_${randomUUID()}`
  const unassignedContactId = `conversation_agent_unassigned_completion_${randomUUID()}`
  const humanContactId = `conversation_agent_human_signal_${randomUUID()}`
  let agentId = ''

  try {
    const agent = await createConversationalAgent({
      name: 'Agente resumen test',
      enabled: true,
      objective: 'citas'
    })
    agentId = agent.id

    await assignAgentToConversation(assignedContactId, agentId, {
      activationSource: 'automatic',
      updatedBy: 'agent'
    })
    await setConversationSignal(assignedContactId, 'ready_to_schedule', {
      reason: 'Quiere agendar esta semana',
      summary: 'El contacto quiere una cita esta semana.',
      status: 'completed',
      agentId
    })

    await setConversationSignal(unassignedContactId, 'ready_to_schedule', {
      reason: 'Señal sin agente asignado',
      summary: 'No debe contar como cierre del agente.',
      status: 'completed'
    })

    await assignAgentToConversation(humanContactId, agentId, {
      activationSource: 'automatic',
      updatedBy: 'agent'
    })
    await setConversationSignal(humanContactId, 'ready_for_human', {
      reason: 'Necesita humano',
      summary: 'El contacto pidió hablar con una persona.',
      status: 'human',
      agentId
    })

    const completedEvents = await listConversationalAgentEvents({ contactId: assignedContactId, kind: 'completion' })
    assert.equal(completedEvents.length, 1)
    assert.equal(completedEvents[0].detail?.status, 'completed')
    assert.equal(completedEvents[0].detail?.agentId, agentId)
    assert.equal(completedEvents[0].detail?.objectiveCompleted, true)

    const unassignedEvents = await listConversationalAgentEvents({ contactId: unassignedContactId, kind: 'completion' })
    assert.equal(unassignedEvents.length, 0)

    const humanEvents = await listConversationalAgentEvents({ contactId: humanContactId, kind: 'completion' })
    assert.equal(humanEvents.length, 0)
  } finally {
    await cleanup(assignedContactId, agentId)
    await cleanup(unassignedContactId)
    await cleanup(humanContactId)
  }
})

test('bloquea activar una conversación con agente cuando el prompt interno no está listo', async () => {
  const contactId = `conversation_agent_state_blocked_${randomUUID()}`
  const previousBusinessProfile = await getStoredBusinessProfileRow()
  let agentId = ''

  try {
    await db.run('DELETE FROM ai_business_profile WHERE id = 1')
    const agent = await createConversationalAgent({
      name: 'Agente test bloqueado',
      enabled: true,
      objective: 'citas'
    })
    agentId = agent.id

    const res = createMockResponse()
    await updateState({
      params: { contactId },
      body: { action: 'activate', agentId }
    }, res)

    assert.equal(res.statusCode, 409)
    assert.equal(res.body?.success, false)
    assert.equal(res.body?.code, 'CONVERSATIONAL_BUSINESS_PROMPT_NOT_READY')
  } finally {
    await cleanup(contactId, agentId)
    await restoreBusinessProfileRow(previousBusinessProfile)
  }
})
