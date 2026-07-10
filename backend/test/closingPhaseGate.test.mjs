import test from 'node:test'
import assert from 'node:assert/strict'
import {
  closingPhaseGateApplies,
  requireClosingPhasesIfNeeded,
  CLOSING_ARC_PHASES
} from '../src/agents/conversational/closingPhaseGate.js'

const longMsg = (t) => ({ role: 'user', content: t })

test('el candado de fases aplica sólo a persuasión media/alta', () => {
  assert.equal(closingPhaseGateApplies({ persuasionLevel: 'low' }), false)
  assert.equal(closingPhaseGateApplies({ persuasionLevel: 'medium' }), true)
  assert.equal(closingPhaseGateApplies({ persuasionLevel: 'high' }), true)
  assert.equal(closingPhaseGateApplies({}), false)
  assert.equal(closingPhaseGateApplies({ persuasionLevel: 'HIGH' }), true)
})

test('persuasión baja (Anfitrión) no pone candado de fases: deja cerrar', async () => {
  const ctx = { conversationMessages: [longMsg('cuánto cuesta')], aiRuntime: null }
  const result = await requireClosingPhasesIfNeeded({ persuasionLevel: 'low' }, ctx)
  assert.equal(result, null)
})

test('piso determinista: conversación corta (pregunta de precio) NO deja cerrar en media/alta', async () => {
  // Sólo una pregunta de precio: no hay plática suficiente para el arco.
  const ctx = { conversationMessages: [longMsg('cuánto cuesta la cita?')], aiRuntime: null }
  const result = await requireClosingPhasesIfNeeded({ persuasionLevel: 'medium' }, ctx)
  assert.ok(result)
  assert.equal(result.ok, false)
  assert.equal(result.phaseGate, true)
  assert.match(result.error, /no ha habido plática suficiente|arco/i)
})

test('traspaso humano con contexto real y aceptación no se convierte en interrogatorio infinito', async () => {
  const ctx = {
    conversationMessages: [
      longMsg('hola, quiero más información'),
      { role: 'assistant', content: 'cuéntame qué necesitas revisar y desde cuándo te pasa?' },
      longMsg('traigo un problema desde hace varios meses y ya me afecta al comer y trabajar'),
      { role: 'assistant', content: 'si gustas, te ayudo a dejarlo listo para que el equipo revise tu caso?' },
      longMsg('sí, está bien')
    ],
    aiRuntime: null
  }

  const result = await requireClosingPhasesIfNeeded({
    persuasionLevel: 'medium',
    objective: 'citas',
    successAction: 'ready_for_human'
  }, ctx)

  assert.equal(result, null)
})

test('con plática mínima y sin runtime de validación: fail-open (no rompe el cierre)', async () => {
  const ctx = {
    conversationMessages: [
      longMsg('hola, me duele la rodilla desde hace meses'),
      longMsg('me afecta para caminar y trabajar'),
      longMsg('sí, quiero que me ayuden con eso')
    ],
    aiRuntime: null // sin validador disponible -> el piso ya corrió, no bloqueamos
  }
  const result = await requireClosingPhasesIfNeeded({ persuasionLevel: 'high' }, ctx)
  assert.equal(result, null)
})

test('las 6 fases del arco están definidas con id y criterio', () => {
  assert.equal(CLOSING_ARC_PHASES.length, 6)
  for (const p of CLOSING_ARC_PHASES) {
    assert.ok(p.id && typeof p.id === 'string')
    assert.ok(p.name && typeof p.name === 'string')
    assert.ok(p.criterion && p.criterion.length > 20)
  }
  const ids = CLOSING_ARC_PHASES.map((p) => p.id)
  assert.deepEqual(ids, ['problema_contexto', 'reto', 'consecuencia', 'invitacion', 'objeciones', 'decision'])
})
