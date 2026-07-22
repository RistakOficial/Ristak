import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { db } from '../src/config/database.js'
import {
  getState,
  updateState
} from '../src/controllers/conversationalAgentController.js'
import {
  assignAgentToConversation,
  buildRuleContext,
  claimConversationInboundMessage,
  completeConversationInboundMessage,
  createConversationalAgent,
  failConversationInboundMessage,
  getConversationState,
  getManualConversationAgentAssignment,
  listConversationStates,
  listConversationStatesForContact,
  listConversationalAgentEvents,
  matchAgentForMessage,
  resetConversationalAgentSkippedContacts,
  runWithConversationStateChannel,
  setConversationStatus,
  setConversationSignal,
  updateConversationalAgent
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

test('crear un agente sin alcance explicito persiste el default de contactos nuevos', async () => {
  let agentId = ''

  try {
    const before = Date.now()
    const agent = await createConversationalAgent({
      name: 'Agente default contactos nuevos',
      enabled: false
    })
    const after = Date.now()
    agentId = agent.id
    const cutoffMs = Date.parse(agent.contactScopeCutoffAt)

    assert.equal(agent.contactScope, 'new_only')
    assert.equal(Number.isFinite(cutoffMs), true)
    assert.equal(cutoffMs >= before && cutoffMs <= after, true)
  } finally {
    await cleanupAgent(agentId)
  }
})

test('activar una conversación con agentId asigna ese agente al estado', async () => {
  const contactId = `conversation_agent_state_${randomUUID()}`
  const previousBusinessProfile = await getStoredBusinessProfileRow()
  let agentId = ''

  try {
    await seedContact(contactId)
    await seedReadyBusinessProfile()
    const agent = await createConversationalAgent({
      defaultCalendarId: 'cal_state_test',
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

    const manualAssignment = await getManualConversationAgentAssignment(contactId)
    assert.equal(manualAssignment?.agentId, agentId)
    assert.equal(manualAssignment?.status, 'active')
  } finally {
    await cleanup(contactId, agentId)
    await restoreBusinessProfileRow(previousBusinessProfile)
  }
})

test('la asignación manual aplica en todos los canales y vence el alcance solo nuevos', async () => {
  const contactId = `conversation_agent_manual_all_channels_${randomUUID()}`
  const previousBusinessProfile = await getStoredBusinessProfileRow()
  let agentId = ''

  try {
    await seedContact(contactId, { createdAt: '2025-01-01T00:00:00.000Z' })
    await seedReadyBusinessProfile()
    const agent = await createConversationalAgent({
      defaultCalendarId: 'cal_manual_all_channels',
      name: 'Agente manual multicanal',
      enabled: true,
      objective: 'citas',
      contactScope: 'new_only'
    })
    agentId = agent.id

    const automaticMatch = await matchAgentForMessage({
      contactId,
      messageText: 'Hola',
      channel: 'messenger'
    })
    assert.equal(automaticMatch, null)

    const res = createMockResponse()
    await updateState({
      params: { contactId },
      body: { action: 'activate', agentId }
    }, res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body?.success, true)

    for (const channel of ['messenger', 'instagram']) {
      const ruleContext = await buildRuleContext({
        contactId,
        messageText: `Mensaje por ${channel}`,
        channel
      })
      const resolved = await resolveInboundAgentForContact({
        contactId,
        channel,
        ruleContext,
        latestMessageId: `msg_${channel}_${randomUUID()}`
      })

      assert.equal(resolved.agentConfig?.id, agentId)
      assert.equal(resolved.assigned, false)
      assert.equal(resolved.state?.channel, channel)
      assert.equal(resolved.state?.assignmentSource, 'manual')
    }

    const states = await listConversationStatesForContact(contactId)
    const statesByChannel = new Map(states.map((state) => [state.channel, state]))
    assert.equal(statesByChannel.get('whatsapp')?.assignmentSource, 'manual')
    assert.equal(statesByChannel.get('messenger')?.assignmentSource, 'manual')
    assert.equal(statesByChannel.get('instagram')?.assignmentSource, 'manual')
    assert.equal(new Set(states.map((state) => state.id)).size, 3)
  } finally {
    await cleanup(contactId, agentId)
    await restoreBusinessProfileRow(previousBusinessProfile)
  }
})

test('la migración recupera asignaciones manuales anteriores como política multicanal', async () => {
  const contactId = `conversation_agent_manual_backfill_${randomUUID()}`
  let agentId = ''

  try {
    await seedContact(contactId)
    const agent = await createConversationalAgent({
      name: 'Agente manual para backfill',
      enabled: false
    })
    agentId = agent.id
    await assignAgentToConversation(contactId, agentId, {
      activationSource: 'manual',
      assignmentSource: 'manual',
      updatedBy: 'user',
      channel: 'whatsapp'
    })
    await db.run('DELETE FROM conversational_agent_manual_assignments WHERE contact_id = ?', [contactId])

    const migrationSql = await readFile(
      new URL('../migrations/versioned/124_conversational_manual_assignment_all_channels.sqlite.sql', import.meta.url),
      'utf8'
    )
    await db.exec(migrationSql)

    const manualAssignment = await getManualConversationAgentAssignment(contactId)
    assert.equal(manualAssignment?.agentId, agentId)
    assert.equal(manualAssignment?.status, 'active')
    assert.equal(manualAssignment?.assignedBy, 'user')
  } finally {
    await cleanup(contactId, agentId)
  }
})

test('la asignación automática marca la conversación como activada por el agente', async () => {
  const contactId = `conversation_agent_auto_state_${randomUUID()}`
  let agentId = ''

  try {
    await seedContact(contactId)
    const agent = await createConversationalAgent({
      defaultCalendarId: 'cal_state_test',
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
    await seedContact(contactId)
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
      defaultCalendarId: 'cal_state_test',
      name: 'Agente nuevo todos los chats',
      enabled: true,
      objective: 'citas',
      contactScope: 'all'
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

    const ruleContext = await buildRuleContext({ contactId, messageText: 'Costos', channel: 'whatsapp' })
    const resolved = await resolveInboundAgentForContact({
      contactId,
      messageText: 'Costos',
      channel: 'whatsapp',
      ruleContext,
      latestMessageId: `waapi_msg_legacy_skip_${randomUUID()}`
    })
    assert.equal(resolved.agentConfig?.id, agentId)
    assert.equal(resolved.assigned, true)
    assert.equal(resolved.state?.status, 'active')

    const legacyManualSkip = await db.get(`
      SELECT agent_id, status
      FROM conversational_agent_state
      WHERE contact_id = ? AND status = 'skipped'
    `, [contactId])
    assert.equal(legacyManualSkip?.agent_id, null)
    assert.equal(legacyManualSkip?.status, 'skipped')
  } finally {
    await cleanup(contactId, agentId)
  }
})

test('una omisión manual conserva la asignación aunque sus timestamps sean anteriores al agente', async () => {
  const contactId = `conversation_agent_stale_skip_${randomUUID()}`
  let agentId = ''

  try {
    await seedContact(contactId)
    const agent = await createConversationalAgent({
      defaultCalendarId: 'cal_state_test',
      name: 'Agente nuevo desbloquea legacy',
      enabled: true,
      objective: 'citas'
    })
    agentId = agent.id

    await db.run(`
      INSERT INTO conversational_agent_state (
        id, contact_id, agent_id, channel, status, updated_by,
        activated_at, activation_source, activated_by,
        assignment_source, assigned_at, assigned_by,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'whatsapp', 'skipped', 'user',
        '2026-01-01 00:00:00', 'manual', 'user',
        'manual', '2026-01-01 00:00:00', 'user',
        '2026-01-01 00:00:00', '2026-01-01 00:00:00')
    `, [`cas_${randomUUID()}`, contactId, agentId])

    const ruleContext = await buildRuleContext({ contactId, messageText: 'Costos', channel: 'whatsapp' })
    const resolved = await resolveInboundAgentForContact({
      contactId,
      messageText: 'Costos',
      channel: 'whatsapp',
      ruleContext
    })

    assert.equal(resolved.agentConfig, null)
    assert.equal(resolved.assigned, false)
    assert.equal(resolved.state?.status, 'skipped')

    const skippedState = await getConversationState(contactId, { agentId, channel: 'whatsapp' })
    assert.equal(skippedState?.status, 'skipped')
    assert.equal(skippedState?.assignmentSource, 'manual')

    const events = await listConversationalAgentEvents({ contactId })
    assert.equal(events.some((event) => event.eventType === 'agent_released'), false)
  } finally {
    await cleanup(contactId, agentId)
  }
})

test('una asignación legacy activa se revalida por reglas y guarda procedencia explícita', async () => {
  const contactId = `conversation_agent_legacy_assignment_${randomUUID()}`
  let agentId = ''

  try {
    await seedContact(contactId)
    const agent = await createConversationalAgent({
      defaultCalendarId: 'cal_state_test',
      name: 'Agente revalida asignación legacy',
      enabled: true,
      objective: 'citas',
      contactScope: 'all'
    })
    agentId = agent.id

    await db.run(`
      INSERT INTO conversational_agent_state (
        id, contact_id, agent_id, channel, status,
        assignment_source, assigned_at, assigned_by, created_at, updated_at
      ) VALUES (?, ?, ?, 'whatsapp', 'active', 'legacy', ?, 'system', ?, ?)
    `, [
      `cas_${randomUUID()}`,
      contactId,
      agentId,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    ])

    const ruleContext = await buildRuleContext({ contactId, messageText: 'Quiero información', channel: 'whatsapp' })
    const resolved = await resolveInboundAgentForContact({
      contactId,
      messageText: 'Quiero información',
      channel: 'whatsapp',
      ruleContext,
      latestMessageId: `msg_${randomUUID()}`
    })

    assert.equal(resolved.agentConfig?.id, agentId)
    assert.equal(resolved.assigned, false)
    assert.equal(resolved.state?.assignmentSource, 'automatic')

    const events = await listConversationalAgentEvents({ contactId })
    assert.equal(events.some((event) => event.eventType === 'agent_assignment_verified'), true)
    assert.equal(events.some((event) => event.detail?.reason === 'stale_inherited_state'), false)
  } finally {
    await cleanup(contactId, agentId)
  }
})

test('el estado del mismo contacto y agente queda aislado por canal', async () => {
  const contactId = `conversation_agent_channel_scope_${randomUUID()}`
  const agentId = `agent_channel_scope_${randomUUID()}`

  try {
    await seedContact(contactId)
    const whatsappState = await assignAgentToConversation(contactId, agentId, {
      activationSource: 'automatic',
      updatedBy: 'agent',
      channel: 'whatsapp'
    })
    const instagramState = await assignAgentToConversation(contactId, agentId, {
      activationSource: 'automatic',
      updatedBy: 'agent',
      channel: 'instagram'
    })

    assert.notEqual(whatsappState?.id, instagramState?.id)
    await setConversationStatus(contactId, 'skipped', {
      updatedBy: 'user',
      agentId,
      channel: 'whatsapp'
    })

    const skippedWhatsapp = await getConversationState(contactId, { agentId, channel: 'whatsapp' })
    const activeInstagram = await getConversationState(contactId, { agentId, channel: 'instagram' })
    assert.equal(skippedWhatsapp?.status, 'skipped')
    assert.equal(activeInstagram?.status, 'active')

    await runWithConversationStateChannel('instagram', () => setConversationStatus(contactId, 'paused', {
      updatedBy: 'user',
      agentId
    }))
    assert.equal((await getConversationState(contactId, { agentId, channel: 'whatsapp' }))?.status, 'skipped')
    assert.equal((await getConversationState(contactId, { agentId, channel: 'instagram' }))?.status, 'paused')

    const whatsappRows = await listConversationStatesForContact(contactId, { channel: 'whatsapp' })
    const instagramRows = await listConversationStatesForContact(contactId, { channel: 'instagram' })
    assert.deepEqual(whatsappRows.map((state) => state.id), [whatsappState.id])
    assert.deepEqual(instagramRows.map((state) => state.id), [instagramState.id])
  } finally {
    await cleanup(contactId)
  }
})

test('una acción humana sin canal actualiza al mismo agente en todos sus canales', async () => {
  const contactId = `conversation_agent_all_channels_${randomUUID()}`
  const agentId = `agent_all_channels_${randomUUID()}`

  try {
    await seedContact(contactId)
    await assignAgentToConversation(contactId, agentId, {
      activationSource: 'automatic',
      updatedBy: 'agent',
      channel: 'whatsapp'
    })
    await assignAgentToConversation(contactId, agentId, {
      activationSource: 'automatic',
      updatedBy: 'agent',
      channel: 'sms'
    })

    const beforeResponse = createMockResponse()
    await getState({
      params: { contactId },
      query: { includeAll: '1' }
    }, beforeResponse)
    assert.equal(beforeResponse.statusCode, 200)
    assert.equal(beforeResponse.body?.data?.length, 1)
    assert.equal(beforeResponse.body?.data?.[0]?.agentId, agentId)

    await setConversationStatus(contactId, 'skipped', {
      updatedBy: 'user',
      agentId
    })

    const states = (await listConversationStatesForContact(contactId))
      .filter(state => state.agentId === agentId)
    assert.equal(states.length, 2)
    assert.deepEqual(new Set(states.map(state => state.channel)), new Set(['whatsapp', 'sms']))
    assert.equal(states.every(state => state.status === 'skipped'), true)
  } finally {
    await cleanup(contactId)
  }
})

test('el claim inbound bloquea concurrencia y permite reintentar el mismo mensaje tras error o lease vencido', async () => {
  const contactId = `conversation_agent_claim_${randomUUID()}`
  const agentId = `agent_claim_${randomUUID()}`
  const messageId = `message_claim_${randomUUID()}`
  const secondMessageId = `message_claim_lease_${randomUUID()}`
  const nowMs = Date.parse('2026-07-10T18:00:00.000Z')

  try {
    await seedContact(contactId)
    await assignAgentToConversation(contactId, agentId, {
      activationSource: 'automatic',
      updatedBy: 'agent',
      channel: 'whatsapp'
    })

    const [first, concurrent] = await Promise.all([
      claimConversationInboundMessage(contactId, messageId, {
        agentId,
        channel: 'whatsapp',
        nowMs,
        leaseMs: 60_000,
        claimToken: 'claim_first'
      }),
      claimConversationInboundMessage(contactId, messageId, {
        agentId,
        channel: 'whatsapp',
        nowMs,
        leaseMs: 60_000,
        claimToken: 'claim_concurrent'
      })
    ])
    const winner = first.claimed ? first : concurrent
    const loser = first.claimed ? concurrent : first
    assert.equal(winner.claimed, true)
    assert.equal(loser.claimed, false)
    assert.equal(loser.reason, 'lease_active')

    const failed = await failConversationInboundMessage(contactId, messageId, {
      agentId,
      channel: 'whatsapp',
      claimToken: winner.claimToken,
      error: 'falló una herramienta después del claim'
    })
    assert.equal(failed.failed, true)
    assert.equal(failed.state?.inboundProcessingStatus, 'failed')

    const retried = await claimConversationInboundMessage(contactId, messageId, {
      agentId,
      channel: 'whatsapp',
      nowMs: nowMs + 1000,
      leaseMs: 60_000,
      claimToken: 'claim_retry'
    })
    assert.equal(retried.claimed, true)
    assert.equal(retried.state?.inboundProcessingAttemptCount, 2)

    const completed = await completeConversationInboundMessage(contactId, messageId, {
      agentId,
      channel: 'whatsapp',
      claimToken: retried.claimToken,
      answered: true
    })
    assert.equal(completed.completed, true)
    assert.equal(completed.state?.lastAnsweredInboundMessageId, messageId)

    const duplicate = await claimConversationInboundMessage(contactId, messageId, {
      agentId,
      channel: 'whatsapp',
      nowMs: nowMs + 2000,
      claimToken: 'claim_duplicate'
    })
    assert.equal(duplicate.claimed, false)
    assert.equal(duplicate.reason, 'already_answered')

    const abandoned = await claimConversationInboundMessage(contactId, secondMessageId, {
      agentId,
      channel: 'whatsapp',
      nowMs,
      leaseMs: 1000,
      claimToken: 'claim_abandoned'
    })
    assert.equal(abandoned.claimed, true)
    const beforeExpiry = await claimConversationInboundMessage(contactId, secondMessageId, {
      agentId,
      channel: 'whatsapp',
      nowMs: nowMs + 999,
      leaseMs: 1000,
      claimToken: 'claim_before_expiry'
    })
    assert.equal(beforeExpiry.claimed, false)
    assert.equal(beforeExpiry.reason, 'lease_active')
    const afterExpiry = await claimConversationInboundMessage(contactId, secondMessageId, {
      agentId,
      channel: 'whatsapp',
      nowMs: nowMs + 1001,
      leaseMs: 1000,
      claimToken: 'claim_after_expiry'
    })
    assert.equal(afterExpiry.claimed, true)
    assert.equal(afterExpiry.state?.inboundProcessingAttemptCount, 2)
  } finally {
    await cleanup(contactId)
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
      defaultCalendarId: 'cal_state_test',
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
      defaultCalendarId: 'cal_state_test',
      name: 'Agente nuevo independiente',
      enabled: true,
      objective: 'citas',
      contactScope: 'all'
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
      defaultCalendarId: 'cal_state_test',
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

test('un agente solo para contactos existentes respeta su corte al hacer matching real', async () => {
  const oldContactId = `conversation_agent_scope_exist_old_${randomUUID()}`
  const newContactId = `conversation_agent_scope_exist_new_${randomUUID()}`
  let agentId = ''

  try {
    const agent = await createConversationalAgent({
      defaultCalendarId: 'cal_state_test',
      name: 'Agente solo existentes',
      enabled: true,
      objective: 'citas',
      contactScope: 'existing_only'
    })
    agentId = agent.id
    assert.equal(agent.contactScope, 'existing_only')
    const cutoffMs = Date.parse(agent.contactScopeCutoffAt)
    assert.equal(Number.isFinite(cutoffMs), true)

    await seedContact(oldContactId, { createdAt: new Date(cutoffMs - 1000).toISOString() })
    await seedContact(newContactId, { createdAt: new Date(cutoffMs + 1000).toISOString() })

    const oldMatch = await matchAgentForMessage({ contactId: oldContactId, messageText: 'Hola', channel: 'whatsapp' })
    const newMatch = await matchAgentForMessage({ contactId: newContactId, messageText: 'Hola', channel: 'whatsapp' })

    assert.equal(oldMatch?.id, agentId)
    assert.equal(newMatch, null)
  } finally {
    await cleanup(oldContactId, agentId)
    await cleanup(newContactId)
  }
})

test('el alcance de contactos y los filtros de condiciones filtran JUNTOS en el matching', async () => {
  const oldContactId = `conversation_agent_scope_filter_old_${randomUUID()}`
  const newContactId = `conversation_agent_scope_filter_new_${randomUUID()}`
  let agentId = ''

  try {
    const agent = await createConversationalAgent({
      defaultCalendarId: 'cal_state_test',
      name: 'Agente existentes con filtro',
      enabled: true,
      objective: 'citas',
      contactScope: 'existing_only',
      filters: {
        entry: {
          groups: [{
            conditions: [{
              category: 'contact',
              params: [{ field: 'source', operator: 'is', value: 'test' }]
            }]
          }]
        },
        exit: { groups: [] }
      }
    })
    agentId = agent.id
    const cutoffMs = Date.parse(agent.contactScopeCutoffAt)
    await seedContact(oldContactId, { createdAt: new Date(cutoffMs - 1000).toISOString() })
    await seedContact(newContactId, { createdAt: new Date(cutoffMs + 1000).toISOString() })

    // Contacto existente + dato factual que cumple la condición → entra.
    const matching = await matchAgentForMessage({ contactId: oldContactId, messageText: 'Vi su promo de julio', channel: 'whatsapp' })
    assert.equal(matching?.id, agentId)

    // Contacto existente pero su fuente real ya no cumple → el filtro manda.
    await db.run('UPDATE contacts SET source = ? WHERE id = ?', ['otro', oldContactId])
    const wrongSource = await matchAgentForMessage({ contactId: oldContactId, messageText: 'Hola, info', channel: 'whatsapp' })
    assert.equal(wrongSource, null)

    // Mensaje cumple pero el contacto es nuevo → el alcance manda.
    const wrongScope = await matchAgentForMessage({ contactId: newContactId, messageText: 'Vi su promo de julio', channel: 'whatsapp' })
    assert.equal(wrongScope, null)
  } finally {
    await cleanup(oldContactId, agentId)
    await cleanup(newContactId)
  }
})

test('alcances disjuntos (nuevos vs existentes) conviven sin conflicto de entrada', async () => {
  let newOnlyId = ''
  let existingOnlyId = ''
  let duplicateId = ''

  try {
    const existingOnly = await createConversationalAgent({
      defaultCalendarId: 'cal_state_test',
      name: 'Base existente',
      enabled: true,
      objective: 'citas',
      contactScope: 'existing_only'
    })
    existingOnlyId = existingOnly.id

    // Catch-all para NUEVOS contactos: universo disjunto → debe poder publicarse.
    const newOnly = await createConversationalAgent({
      defaultCalendarId: 'cal_state_test',
      name: 'Leads nuevos',
      enabled: true,
      objective: 'citas',
      contactScope: 'new_only'
    })
    newOnlyId = newOnly.id
    assert.ok(newOnlyId)

    // Mismo alcance catch-all otra vez → ese SÍ es conflicto real.
    await assert.rejects(
      createConversationalAgent({
        defaultCalendarId: 'cal_state_test',
        name: 'Base existente duplicada',
        enabled: true,
        objective: 'citas',
        contactScope: 'existing_only'
      }).then((created) => {
        duplicateId = created?.id || ''
        return created
      }),
      (error) => error.code === 'CONVERSATIONAL_AGENT_ENTRY_CONFLICT'
    )

    // Cambiar el alcance re-sella el corte y volver a 'all' lo limpia.
    const switched = await updateConversationalAgent(existingOnlyId, { contactScope: 'new_only', enabled: false })
    assert.equal(switched.contactScope, 'new_only')
    assert.ok(switched.contactScopeCutoffAt)
    const cleared = await updateConversationalAgent(existingOnlyId, { contactScope: 'all' })
    assert.equal(cleared.contactScope, 'all')
    assert.equal(cleared.contactScopeCutoffAt, null)
  } finally {
    for (const id of [newOnlyId, existingOnlyId, duplicateId]) {
      if (id) await db.run('DELETE FROM conversational_agents WHERE id = ?', [id]).catch(() => undefined)
    }
  }
})

test('pausar una conversación desde el controller guarda la ventana enviada por la UI', async () => {
  const contactId = `conversation_agent_pause_state_${randomUUID()}`
  const pausedUntilAt = new Date(Date.now() + (24 * 60 * 60 * 1000)).toISOString()

  try {
    await seedContact(contactId)
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
    await seedContact(skippedContactA)
    await seedContact(skippedContactB)
    await seedContact(pausedContact)
    await seedContact(otherAgentContact)
    const agent = await createConversationalAgent({
      defaultCalendarId: 'cal_state_test',
      name: 'Agente omisiones test',
      enabled: false,
      objective: 'citas'
    })
    const otherAgent = await createConversationalAgent({
      defaultCalendarId: 'cal_state_test',
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
      defaultCalendarId: 'cal_state_test',
      name: 'Agente omitido del mismo contacto',
      enabled: false,
      objective: 'citas'
    })
    const activeAgent = await createConversationalAgent({
      defaultCalendarId: 'cal_state_test',
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
      defaultCalendarId: 'cal_state_test',
      name: 'Agente reapertura test',
      enabled: true,
      objective: 'citas',
      contactScope: 'all'
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

test('una conversación completada no reabre si el agente está apagado o ya no cumple entrada', async () => {
  const contactId = `conversation_agent_reopen_rules_${randomUUID()}`
  const answeredMessageId = `waapi_msg_rules_answered_${randomUUID()}`
  let agentId = ''

  try {
    await seedContact(contactId)
    const agent = await createConversationalAgent({
      defaultCalendarId: 'cal_state_test',
      name: 'Agente reapertura con reglas',
      enabled: true,
      objective: 'citas',
      filters: {
        entry: {
          groups: [{
            conditions: [{
              category: 'contact',
              params: [{ field: 'source', operator: 'is', value: 'test' }]
            }]
          }]
        },
        exit: { groups: [] }
      }
    })
    agentId = agent.id

    await assignAgentToConversation(contactId, agentId, {
      activationSource: 'automatic',
      updatedBy: 'agent',
      channel: 'whatsapp'
    })
    await setConversationSignal(contactId, 'appointment_booked', {
      reason: 'Cita agendada',
      summary: 'La cita ya quedó creada.',
      status: 'completed',
      agentId,
      channel: 'whatsapp'
    })
    await db.run(`
      UPDATE conversational_agent_state
      SET last_inbound_message_id = ?, last_answered_inbound_message_id = ?
      WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'
    `, [answeredMessageId, answeredMessageId, contactId, agentId])

    await db.run('UPDATE conversational_agents SET enabled = 0 WHERE id = ?', [agentId])
    const enabledRuleContext = await buildRuleContext({ contactId, messageText: 'Otra cita', channel: 'whatsapp' })
    const disabledResult = await resolveInboundAgentForContact({
      contactId,
      messageText: 'Otra cita',
      channel: 'whatsapp',
      ruleContext: enabledRuleContext,
      latestMessageId: `waapi_msg_disabled_${randomUUID()}`
    })
    assert.equal(disabledResult.agentConfig, null)
    const preserved = await getConversationState(contactId, { agentId, channel: 'whatsapp' })
    assert.equal(preserved?.status, 'completed')
    assert.equal(preserved?.signal, 'appointment_booked')

    await db.run('UPDATE conversational_agents SET enabled = 1 WHERE id = ?', [agentId])
    await db.run('UPDATE contacts SET source = ? WHERE id = ?', ['otro', contactId])
    const mismatchedRuleContext = await buildRuleContext({ contactId, messageText: 'Solo quiero precio', channel: 'whatsapp' })
    const mismatchedResult = await resolveInboundAgentForContact({
      contactId,
      messageText: 'Solo quiero precio',
      channel: 'whatsapp',
      ruleContext: mismatchedRuleContext,
      latestMessageId: `waapi_msg_mismatch_${randomUUID()}`
    })
    assert.equal(mismatchedResult.agentConfig, null)

    const stored = await db.get(`
      SELECT agent_id, status, signal
      FROM conversational_agent_state
      WHERE contact_id = ? AND channel = 'whatsapp'
      ORDER BY updated_at DESC
      LIMIT 1
    `, [contactId])
    assert.equal(stored?.agent_id, null)
    assert.equal(stored?.status, 'completed')
    assert.equal(stored?.signal, 'appointment_booked')
  } finally {
    await cleanup(contactId, agentId)
  }
})

test('un handoff pendiente no se borra ni se reabre por un mensaje nuevo', async () => {
  const contactId = `conversation_agent_reopen_handoff_${randomUUID()}`
  const answeredMessageId = `waapi_msg_answered_${randomUUID()}`
  const newMessageId = `waapi_msg_new_${randomUUID()}`
  let agentId = ''

  try {
    await seedContact(contactId)
    const agent = await createConversationalAgent({
      defaultCalendarId: 'cal_state_test',
      name: 'Agente handoff terminal test',
      enabled: true,
      objective: 'citas'
    })
    agentId = agent.id

    await assignAgentToConversation(contactId, agentId, {
      activationSource: 'automatic',
      updatedBy: 'agent'
    })
    await setConversationSignal(contactId, 'ready_for_human', {
      reason: 'El contacto aceptó pasar con el equipo',
      summary: 'El humano debe confirmar el siguiente paso.',
      status: 'human',
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
    assert.equal(resolved.assigned, false)

    const state = await getConversationState(contactId, { agentId })
    assert.equal(state?.status, 'human')
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
    await seedContact(assignedContactId)
    await seedContact(unassignedContactId)
    await seedContact(humanContactId)
    const agent = await createConversationalAgent({
      defaultCalendarId: 'cal_state_test',
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

test('activar manualmente una conversación nativa funciona con la plantilla por defecto', async () => {
  const contactId = `conversation_agent_state_v2_${randomUUID()}`
  const previousBusinessProfile = await getStoredBusinessProfileRow()
  let agentId = ''

  try {
    await db.run('DELETE FROM ai_business_profile WHERE id = 1')
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto activación v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    const agent = await createConversationalAgent({
      name: 'Agente nativo activación manual',
      enabled: false,
      capabilitiesConfig: { schemaVersion: 1, items: [] }
    })
    agentId = agent.id
    await db.run('UPDATE conversational_agents SET enabled = 1 WHERE id = ?', [agentId])

    const res = createMockResponse()
    await updateState({
      params: { contactId },
      body: { action: 'activate', agentId }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.body?.success, true)
    assert.equal(res.body?.data?.agentId, agentId)
  } finally {
    await cleanup(contactId, agentId)
    await restoreBusinessProfileRow(previousBusinessProfile)
  }
})
