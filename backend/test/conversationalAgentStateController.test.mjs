import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import { updateState } from '../src/controllers/conversationalAgentController.js'
import {
  assignAgentToConversation,
  createConversationalAgent,
  getConversationState,
  listConversationStates,
  listConversationalAgentEvents,
  setConversationSignal
} from '../src/services/conversationalAgentService.js'

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
  if (agentId) {
    await db.run('DELETE FROM conversational_agent_events WHERE detail_json LIKE ?', [`%${agentId}%`]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => undefined)
  }
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
