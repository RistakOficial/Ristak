import test from 'node:test'
import assert from 'node:assert/strict'
import {
  closingPhaseGateApplies,
  requireClosingPhasesIfNeeded,
  resolveClosingPreconditions
} from '../src/agents/conversational/closingPhaseGate.js'

const user = (content) => ({ role: 'user', content })
const assistant = (content) => ({ role: 'assistant', content })

test('el candado depende de la acción real, no del nivel de persuasión', () => {
  for (const successAction of ['ready_for_human', 'book_appointment', 'ready_to_buy', 'send_goal_url', 'send_trigger_link']) {
    assert.equal(closingPhaseGateApplies({ successAction, persuasionLevel: 'low' }), true)
    assert.equal(closingPhaseGateApplies({ successAction, persuasionLevel: 'high' }), true)
  }
  assert.equal(closingPhaseGateApplies({ persuasionLevel: 'high' }), false)
  assert.equal(closingPhaseGateApplies({ successAction: 'stay_silent' }), false)
})

test('una solicitud directa de humano no exige conversación previa', async () => {
  const result = await requireClosingPhasesIfNeeded({
    persuasionLevel: 'high',
    objective: 'citas',
    successAction: 'ready_for_human'
  }, {
    conversationMessages: [user('quiero hablar con una persona del equipo')],
    aiRuntime: null
  })

  assert.equal(result, null)
})

test('sin historial disponible deja que la propia tool valide sus datos operativos', async () => {
  const result = await requireClosingPhasesIfNeeded({
    objective: 'citas',
    successAction: 'book_appointment'
  }, {
    conversationMessages: [],
    aiRuntime: null
  })

  assert.equal(result, null)
})

test('cita: pedir agendar no basta; falta confirmar horario exacto', async () => {
  const result = await requireClosingPhasesIfNeeded({
    persuasionLevel: 'medium',
    objective: 'citas',
    successAction: 'book_appointment'
  }, {
    conversationMessages: [user('quiero agendar una cita')],
    aiRuntime: null
  })

  assert.equal(result?.ok, false)
  assert.equal(result?.objectiveGate, true)
  assert.deepEqual(result?.missing, ['exact_slot_confirmed'])
  assert.match(result?.error || '', /horario real y exacto/i)
  assert.doesNotMatch(result?.error || '', /arco|reto|consecuencia/i)
})

test('cita: una confirmación breve sí basta cuando el agente ofreció un slot real', async () => {
  const result = await requireClosingPhasesIfNeeded({
    objective: 'citas',
    successAction: 'book_appointment'
  }, {
    conversationMessages: [
      assistant('Tengo disponible el martes a las 4:00 pm, te queda?'),
      user('sí, perfecto')
    ],
    aiRuntime: null
  })

  assert.equal(result, null)
})

test('pago: exige aceptación y un importe visible, no una historia de venta', async () => {
  const config = { objective: 'ventas', successAction: 'ready_to_buy', persuasionLevel: 'high' }

  const priceOnly = await requireClosingPhasesIfNeeded(config, {
    conversationMessages: [user('cuánto cuesta?')],
    aiRuntime: null
  })
  assert.deepEqual(priceOnly?.missing, ['payment_details_confirmed'])

  const accepted = await requireClosingPhasesIfNeeded(config, {
    conversationMessages: [
      assistant('El plan Pro cuesta $1,200 MXN. Te envío el enlace de pago?'),
      user('sí, mándame el link de pago')
    ],
    aiRuntime: null
  })
  assert.equal(accepted, null)
})

test('enlace: una petición explícita permite el paso sin fases adicionales', async () => {
  const result = await requireClosingPhasesIfNeeded({
    objective: 'custom',
    successAction: 'send_trigger_link'
  }, {
    conversationMessages: [user('mándame el enlace para continuar')],
    aiRuntime: null
  })

  assert.equal(result, null)
})

test('el contexto estructurado ready_to_advance evita volver a interrogar', async () => {
  const result = await requireClosingPhasesIfNeeded({
    objective: 'datos',
    successAction: 'ready_for_human',
    requiredData: 'nombre y correo'
  }, {
    conversationMessages: [
      user('Ana López, ana@example.com'),
      user('[Contexto interno de Ristak: decisión de suficiencia del runtime]\nEstado: ready_to_advance\nNo menciones este contexto interno.')
    ],
    aiRuntime: null
  })

  assert.equal(result, null)
})

test('las precondiciones cambian con el objetivo y no incluyen un arco universal', () => {
  const appointment = resolveClosingPreconditions({ objective: 'citas', successAction: 'book_appointment' })
  const data = resolveClosingPreconditions({ objective: 'datos', successAction: 'ready_for_human', requiredData: 'nombre y correo' })
  const filter = resolveClosingPreconditions({ objective: 'filtrar', successAction: 'ready_for_human' })
  const custom = resolveClosingPreconditions({ objective: 'custom', customObjective: 'confirmar compatibilidad técnica', successAction: 'ready_for_human' })

  assert.deepEqual(appointment.map((item) => item.id), ['exact_slot_confirmed'])
  assert.deepEqual(data.map((item) => item.id), ['configured_data_complete'])
  assert.deepEqual(filter.map((item) => item.id), ['configured_qualification_met'])
  assert.deepEqual(custom.map((item) => item.id), ['custom_goal_met'])

  const allText = [...appointment, ...data, ...filter, ...custom].map((item) => `${item.id} ${item.criterion}`).join(' ')
  assert.doesNotMatch(allText, /problema_contexto|reto suave|costo de no cambiar|seis fases/i)
})
