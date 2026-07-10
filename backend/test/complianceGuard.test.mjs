import test from 'node:test'
import assert from 'node:assert/strict'
import {
  complianceGuardApplies,
  ensureCorrectedGuardReply,
  replyMightViolate,
  enforceComplianceGuard
} from '../src/agents/conversational/complianceGuard.js'

test('el guardián sólo aplica cuando el negocio configuró una condición explícita', () => {
  assert.equal(complianceGuardApplies({ persuasionLevel: 'high', languageLevel: 'colloquial' }), false)
  assert.equal(complianceGuardApplies({
    persuasionLevel: 'low',
    languageLevel: 'professional',
    extraInstructions: 'No des precios hasta que la persona confirme qué plan busca.'
  }), true)
  assert.equal(complianceGuardApplies({
    closingStrategyMode: 'custom',
    closingStrategyCustom: 'No menciones el costo antes de validar su presupuesto.'
  }), true)
  assert.equal(complianceGuardApplies({
    extraInstructions: 'No reveles el valor hasta que confirme el servicio.'
  }), true)
  assert.equal(complianceGuardApplies({
    extraInstructions: 'Responde los precios con claridad cuando te los pregunten.'
  }), false)
})

test('el pre-filtro sólo detecta importes; una explicación larga ya no se castiga', () => {
  assert.equal(replyMightViolate('claro, para qué la necesitas?'), false)
  assert.equal(replyMightViolate('a'.repeat(250)), false)
  assert.equal(replyMightViolate('ofrecemos consultas y seguimiento personalizado'), false)
  assert.equal(replyMightViolate('la consulta cuesta $1,200'), true)
  assert.equal(replyMightViolate('son 800 pesos por sesión'), true)
})

test('la corrección conserva una respuesta útil y sólo usa fallback si aún revela dinero', () => {
  assert.equal(
    ensureCorrectedGuardReply('sí manejamos esa opción; necesito confirmar qué plan buscas.'),
    'sí manejamos esa opción; necesito confirmar qué plan buscas.'
  )
  assert.equal(
    ensureCorrectedGuardReply('la consulta cuesta $1,200'),
    'para darte el dato que sí aplica, qué opción estás considerando?'
  )
  assert.equal(
    ensureCorrectedGuardReply(''),
    'para darte el dato que sí aplica, qué opción estás considerando?'
  )
})

test('sin condición configurada deja pasar el precio aunque exista runtime', async () => {
  const out = await enforceComplianceGuard({
    reply: 'la consulta cuesta $1,200',
    messages: [{ role: 'user', content: 'cuánto cuesta la consulta?' }],
    config: { persuasionLevel: 'high', languageLevel: 'intermediate' },
    runtime: { modelProvider: {} }
  })
  assert.equal(out.changed, false)
  assert.match(out.reply, /1,200/)
})

test('con condición explícita pero sin runtime conserva fail-open', async () => {
  const out = await enforceComplianceGuard({
    reply: 'la consulta cuesta $1,200',
    messages: [{ role: 'user', content: 'cuánto cuesta?' }],
    config: { extraInstructions: 'No des precios hasta confirmar qué servicio busca.' },
    runtime: null
  })
  assert.equal(out.changed, false)
  assert.match(out.reply, /1,200/)
})
