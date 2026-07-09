import test from 'node:test'
import assert from 'node:assert/strict'
import {
  complianceGuardApplies,
  replyMightViolate,
  enforceComplianceGuard
} from '../src/agents/conversational/complianceGuard.js'

test('el guardián aplica sólo cuando la biblia pesada está activa', () => {
  // Biblia pesada = persuasión media/alta + lenguaje Cómplice/Callejero.
  assert.equal(complianceGuardApplies({ persuasionLevel: 'medium', languageLevel: 'intermediate' }), true)
  assert.equal(complianceGuardApplies({ persuasionLevel: 'high', languageLevel: 'colloquial' }), true)
  // Guion ligero = Anfitrión (baja) o Ejecutivo (professional): NO aplica (dar precio es por diseño).
  assert.equal(complianceGuardApplies({ persuasionLevel: 'low', languageLevel: 'intermediate' }), false)
  assert.equal(complianceGuardApplies({ persuasionLevel: 'high', languageLevel: 'professional' }), false)
  assert.equal(complianceGuardApplies({ persuasionLevel: 'medium', languageLevel: 'professional' }), false)
  // Guion custom: no aplica (no es la biblia).
  assert.equal(complianceGuardApplies({ persuasionLevel: 'high', languageLevel: 'colloquial', closingStrategyMode: 'custom' }), false)
})

test('pre-filtro determinista: una pregunta corta sin precio no gasta IA', () => {
  assert.equal(replyMightViolate('claro, para qué la necesitas?'), false)
  assert.equal(replyMightViolate('a ver, cuéntame qué te está pasando'), false)
  assert.equal(replyMightViolate(''), false)
  // Con precio / dinero: sí podría violar.
  assert.equal(replyMightViolate('la consulta cuesta $1,200'), true)
  assert.equal(replyMightViolate('son 800 pesos por sesión'), true)
  // Texto largo (posible pitch): sí podría violar.
  assert.equal(replyMightViolate('a'.repeat(250)), true)
})

test('sin runtime de validación: fail-open (no reescribe, deja pasar)', async () => {
  const out = await enforceComplianceGuard({
    reply: 'la consulta cuesta $1,200 y el seguimiento $800',
    messages: [{ role: 'user', content: 'costos' }],
    config: { persuasionLevel: 'medium', languageLevel: 'intermediate' },
    runtime: null
  })
  assert.equal(out.changed, false)
  assert.match(out.reply, /1,200/)
})

test('config de guion ligero: el guardián no toca la respuesta aunque traiga precio', async () => {
  const out = await enforceComplianceGuard({
    reply: 'la consulta cuesta $1,200',
    messages: [{ role: 'user', content: 'costos' }],
    config: { persuasionLevel: 'low', languageLevel: 'intermediate' }, // Anfitrión: da precios por diseño
    runtime: { modelProvider: {} }
  })
  assert.equal(out.changed, false)
})
