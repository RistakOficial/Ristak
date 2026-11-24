import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import {
  createConversationalAgent,
  getConversationalAgent,
  updateConversationalAgent
} from '../src/services/conversationalAgentService.js'
import { runToolCallingV2Turn } from '../src/agents/conversational/runner.js'
import { createConversationalTools } from '../src/agents/conversational/tools.js'

async function removeAgent(agentId) {
  if (!agentId) return
  await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId])
}

async function withBusinessContext(description, callback, { profileSource = description, brandVoice = '' } = {}) {
  const savedConfig = await db.get('SELECT * FROM ai_agent_config WHERE id = 1')
  const savedProfile = await db.get('SELECT * FROM ai_business_profile WHERE id = 1')
  try {
    await db.run('DELETE FROM ai_agent_config WHERE id = 1')
    await db.run('DELETE FROM ai_business_profile WHERE id = 1')
    await db.run('INSERT INTO ai_agent_config (id, business_context, brand_voice) VALUES (1, ?, ?)', [description, brandVoice])
    if (profileSource !== null) {
      await db.run(`
        INSERT INTO ai_business_profile (id, source_context, profile_json, profile_summary, extraction_status)
        VALUES (1, ?, ?, ?, 'ready')
      `, [profileSource, JSON.stringify({ description: profileSource.slice(0, 80) }), profileSource.slice(0, 80)])
    }
    await callback()
  } finally {
    for (const [table, row] of [['ai_agent_config', savedConfig], ['ai_business_profile', savedProfile]]) {
      await db.run(`DELETE FROM ${table} WHERE id = 1`)
      if (row) {
        const columns = Object.keys(row)
        await db.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, Object.values(row))
      }
    }
  }
}

// Ejecuta el armado real del turno y sus herramientas. Se detiene únicamente
// en la frontera del proveedor: estas pruebas verifican configuración, no la
// calidad de una respuesta generada por un modelo ni una integración externa.
async function inspectTurn(config, { message = 'Hola', followUpContext = null } = {}) {
  return runToolCallingV2Turn({
    config,
    runtime: {},
    dryRun: true,
    messages: [{ role: 'user', content: message }],
    traceMessage: message,
    contactId: `configuration-test-${randomUUID()}`,
    followUpContext
  }, {
    executeAgent: async () => 'Respuesta de prueba de configuración.'
  })
}

function agentConfig(promptConfig = {}) {
  return {
    enabled: false,
    promptConfig: { strategyText: 'Primero entiende la necesidad.', personalityText: 'Habla claro.', ...promptConfig },
    capabilitiesConfig: { items: [], safetyPolicy: { enabled: false } }
  }
}

test('excluir la descripción también retira su herramienta en respuestas y seguimientos', async () => {
  await withBusinessContext('CONTEXTO_GLOBAL_EXCLUIDO: ofrecemos tratamientos.', async () => {
    for (const followUpContext of [null, { index: 1, strategy: 'Retoma la conversación.' }]) {
      const turn = await inspectTurn(agentConfig({ includeBusinessDescription: false, personalityText: '' }), { followUpContext })
      assert.doesNotMatch(turn.agent.instructions, /CONTEXTO_GLOBAL_EXCLUIDO|VOZ_GLOBAL_EXCLUIDA/)
      assert.equal(turn.tools.some((item) => item.name === 'get_business_profile'), false)
      assert.ok(turn.tools.some((item) => item.name === 'get_contact_profile'))
      assert.ok(turn.tools.some((item) => item.name === 'list_products'))
    }
  }, { brandVoice: 'VOZ_GLOBAL_EXCLUIDA: usa emojis en cada respuesta.' })
})

test('la descripción completa llega al turno aunque el mensaje no coincida con sus palabras', async () => {
  const description = `${'Información general del establecimiento. '.repeat(1000)}REGLA_AL_FINAL: sólo ofrecemos valoración presencial.`
  assert.ok(description.length > 30_000 && description.length < 50_000)
  await withBusinessContext(description, async () => {
    const turn = await inspectTurn(agentConfig(), { message: 'Va, perfecto' })
    assert.ok(turn.agent.instructions.includes(description))
    const profileTool = turn.tools.find((item) => item.name === 'get_business_profile')
    const result = await profileTool.invoke({}, '{}')
    assert.equal(result.business.description, description)
  })
})

test('el texto guardado manda mientras el perfil extraído todavía conserva una versión vieja', async () => {
  const description = 'DESCRIPCION_ACTUAL: atendemos únicamente en sucursal Norte.'
  await withBusinessContext(description, async () => {
    const turn = await inspectTurn(agentConfig(), { message: '¿Dónde están?' })
    assert.ok(turn.agent.instructions.includes(description))
    assert.doesNotMatch(turn.agent.instructions, /DESCRIPCION_ANTERIOR/)
    const result = await turn.tools.find((item) => item.name === 'get_business_profile').invoke({}, '{}')
    assert.equal(result.business.description, description)
    assert.doesNotMatch(JSON.stringify(result), /DESCRIPCION_ANTERIOR/)
  }, { profileSource: 'DESCRIPCION_ANTERIOR: atendemos únicamente en sucursal Sur.' })
})

test('borrar la descripción no la resucita desde una extracción anterior', async () => {
  await withBusinessContext('', async () => {
    const turn = await inspectTurn(agentConfig())
    assert.doesNotMatch(turn.agent.instructions, /DESCRIPCION_BORRADA/)
    const result = await turn.tools.find((item) => item.name === 'get_business_profile').invoke({}, '{}')
    assert.doesNotMatch(JSON.stringify(result), /DESCRIPCION_BORRADA/)
  }, { profileSource: 'DESCRIPCION_BORRADA: datos que el dueño ya eliminó.' })
})

test('sin perfil extraído se conserva también el final de la descripción guardada', async () => {
  const description = `${'Detalle del negocio. '.repeat(900)}FINAL_SIN_EXTRACCION: no ofrecemos entrega a domicilio.`
  await withBusinessContext(description, async () => {
    const turn = await inspectTurn(agentConfig(), { message: 'ok' })
    assert.ok(turn.agent.instructions.includes(description))
  }, { profileSource: null })
})

test('el seguimiento recibe toda la estrategia guardada, después de los primeros 500 caracteres', async () => {
  let agent
  const strategy = `${'Retoma con calma el tema de la conversación. '.repeat(70)}REGLA_FINAL_SEGUIMIENTO: no ofrezcas descuentos.`
  try {
    agent = await createConversationalAgent({
      name: 'Seguimiento completo',
      ...agentConfig({ includeBusinessDescription: false }),
      followUp: { enabled: true, first: { value: 5, unit: 'minutes' }, strategy }
    })
    const saved = await getConversationalAgent(agent.id)
    assert.equal(saved.followUp.strategy, strategy)
    const turn = await inspectTurn(saved, { followUpContext: { index: 1, strategy: saved.followUp.strategy } })
    assert.ok(turn.agent.instructions.includes(strategy))
  } finally {
    await removeAgent(agent?.id)
  }
})

test('editar estrategia con el texto legacy sin regenerar no descarta la edición ni la personalidad', async () => {
  let agent
  try {
    agent = await createConversationalAgent({ name: 'Edición parcial', ...agentConfig() })
    const updated = await updateConversationalAgent(agent.id, {
      promptConfig: { ...agent.promptConfig, strategyText: 'ESTRATEGIA_NUEVA: pregunta primero el motivo.' }
    })
    assert.equal(updated.promptConfig.strategyText, 'ESTRATEGIA_NUEVA: pregunta primero el motivo.')
    assert.equal(updated.promptConfig.personalityText, agent.promptConfig.personalityText)
    const turn = await inspectTurn(await getConversationalAgent(agent.id))
    assert.match(turn.agent.instructions, /ESTRATEGIA_NUEVA/)
  } finally {
    await removeAgent(agent?.id)
  }
})

test('reenviar editableText sin cambios no impide actualizar la preferencia de descripción', async () => {
  let agent
  try {
    agent = await createConversationalAgent({ name: 'Preferencia de memoria', ...agentConfig() })
    const updated = await updateConversationalAgent(agent.id, {
      promptConfig: { editableText: agent.promptConfig.editableText, includeBusinessDescription: false }
    })
    assert.equal(updated.promptConfig.includeBusinessDescription, false)
    assert.equal(updated.promptConfig.strategyText, agent.promptConfig.strategyText)
    assert.equal(updated.promptConfig.personalityText, agent.promptConfig.personalityText)
  } finally {
    await removeAgent(agent?.id)
  }
})

test('un parche parcial sin cambios conserva la personalidad aunque incluya la copia legacy', async () => {
  let agent
  try {
    agent = await createConversationalAgent({ name: 'Parche parcial', ...agentConfig() })
    const updated = await updateConversationalAgent(agent.id, {
      promptConfig: { strategyText: agent.promptConfig.strategyText, editableText: agent.promptConfig.editableText, includeBusinessDescription: false }
    })
    assert.equal(updated.promptConfig.includeBusinessDescription, false)
    assert.equal(updated.promptConfig.strategyText, agent.promptConfig.strategyText)
    assert.equal(updated.promptConfig.personalityText, agent.promptConfig.personalityText)
    const editedPersonality = await updateConversationalAgent(agent.id, {
      promptConfig: { ...updated.promptConfig, personalityText: 'PERSONALIDAD_NUEVA: sin emojis.' }
    })
    assert.equal(editedPersonality.promptConfig.strategyText, agent.promptConfig.strategyText)
    assert.equal(editedPersonality.promptConfig.personalityText, 'PERSONALIDAD_NUEVA: sin emojis.')
  } finally {
    await removeAgent(agent?.id)
  }
})

test('un agente sin acciones habilitadas no expone herramientas operativas', () => {
  const tools = createConversationalTools({ config: agentConfig(), dryRun: true, actions: [] })
  assert.deepEqual(tools.map((item) => item.name).sort(), ['get_business_profile', 'get_contact_profile', 'list_products'])
})

test('el turno de una clínica que atiende urgencias conserva la orientación inmediata y la ruta real de agenda', async () => {
  const config = agentConfig({
    includeBusinessDescription: false,
    strategyText: 'El especialista atiende urgencias maxilofaciales. Ofrécele valoración al paciente.'
  })
  config.capabilitiesConfig.items = [{ id: 'schedule_appointment', enabled: true, calendarId: 'calendar-clinica' }]
  const turn = await inspectTurn(config, { message: 'no puedo abrir la boca es urgente' })
  const { instructions } = turn.agent

  assert.ok(instructions.includes(config.promptConfig.strategyText))
  assert.match(instructions, /atención inmediata[^\n]*acuda ahora a urgencias/i)
  assert.match(instructions, /en paralelo[^\n]*sin demorar la atención/i)
  assert.match(instructions, /conserva visible esta orientación[^\n]*ofrecer un horario[^\n]*transferir el chat/i)
  assert.match(instructions, /urgencias directamente o por teléfono[^\n]*datos verificados/i)
  assert.match(instructions, /valoración urgente[^\n]*get_free_slots desde hoy/i)
  assert.match(instructions, /varias opciones oportunas[^\n]*offer_appointment_options[^\n]*maxDays=1[^\n]*una sola[^\n]*offer_appointment_slot/i)
  assert.match(instructions, /urgencia no confirma una reserva/i)
  assert.match(instructions, /no hay un horario oportuno o la consulta falla[^\n]*sin sugerir que espere/i)
  const tools = turn.tools.map((item) => item.name)
  for (const name of ['get_free_slots', 'offer_appointment_slot', 'offer_appointment_options']) {
    assert.ok(tools.includes(name), name)
  }
})

test('la orientación urgente respeta los servicios declarados y las herramientas disponibles en cada vuelta', async () => {
  const config = agentConfig({
    includeBusinessDescription: false,
    strategyText: 'El consultorio sólo ofrece consultas de rutina.'
  })
  const message = 'Necesito atención, me cuesta respirar'
  const searchUrgently = /valoración urgente[^\n]*get_free_slots desde hoy/i
  for (const calendar of [null, { id: 'schedule_appointment', enabled: true }]) {
    config.capabilitiesConfig.items = calendar ? [calendar] : []
    const turn = await inspectTurn(config, { message })
    assert.ok(turn.agent.instructions.includes(config.promptConfig.strategyText))
    assert.match(turn.agent.instructions, /atención propia sólo si[^\n]*expresamente[^\n]*si no consta/i)
    assert.match(turn.agent.instructions, /atención inmediata[^\n]*acuda ahora a urgencias/i)
    assert.doesNotMatch(turn.agent.instructions, searchUrgently)
    assert.equal(turn.tools.some((item) => item.name === 'get_free_slots'), false)
  }
  config.capabilitiesConfig.items = [{ id: 'schedule_appointment', enabled: true, calendarId: 'calendar-clinica' }]
  const followUp = await inspectTurn(config, { message, followUpContext: { index: 1, strategy: 'Retoma la conversación.' } })
  assert.doesNotMatch(followUp.agent.instructions, /Solicitudes de atención médica urgente/i)
  assert.doesNotMatch(followUp.agent.instructions, searchUrgently)
  assert.equal(followUp.tools.some((item) => item.name === 'get_free_slots'), false)
})
