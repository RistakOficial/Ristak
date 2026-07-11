import test from 'node:test'
import assert from 'node:assert/strict'

import {
  detectExplicitHumanRequest,
  detectExplicitPastClientDisclosure,
  enforceOpeningConversationPolicy,
  evaluateTurnPolicy,
  normalizeVisibleChatStyle
} from '../src/agents/conversational/intelligence/turnPolicy.js'
import { compileConversationalAgentPolicy } from '../src/agents/conversational/intelligence/configCompiler.js'
import { planConversationStrategy } from '../src/agents/conversational/intelligence/strategyPlanner.js'
import { applyConversationalRuntimeReplyGuard } from '../src/agents/conversational/runner.js'

function criterioConfig(overrides = {}) {
  return {
    objective: 'citas',
    successAction: 'ready_for_human',
    persuasionLevel: 'high',
    closingStrategyMode: 'system',
    goalWorkflow: {
      attention: { pastClientsToHuman: false },
      appointments: { owner: 'human', calendarId: 'cal_test' }
    },
    ...overrides
  }
}

test('reescribe la fuga real de precio y menú en la primera respuesta', () => {
  const observedReply = '¡Hola! Para necesitas una cita previa y manejamos dos cosas: consulta inicial: $1,200 MXN. Seguimiento: $800 MXN. ¿Para qué zona es el dolor?'
  const result = enforceOpeningConversationPolicy({
    reply: observedReply,
    messages: [{ role: 'user', content: 'Hola, vi su anuncio y me interesa. ¿Qué hacen y cuánto cuesta agendar?' }],
    latestText: 'Hola, vi su anuncio y me interesa. ¿Qué hacen y cuánto cuesta agendar?',
    config: criterioConfig(),
    priceInsistenceCount: 1,
    channel: 'whatsapp'
  })

  assert.equal(result.changed, true)
  assert.equal(result.reason, 'opening_price_disclosure')
  assert.equal(result.reply, 'claro, para ubicarte bien, qué estás buscando resolver?')
  assert.doesNotMatch(result.reply, /\$|MXN|consulta inicial|seguimiento/i)
})

test('una apertura vaga recibe una sola pregunta y no un pitch', () => {
  const result = enforceOpeningConversationPolicy({
    reply: 'Ofrecemos fisioterapia, rehabilitación, consulta inicial y seguimiento para distintos problemas.',
    messages: [{ role: 'user', content: 'Hola, info' }],
    latestText: 'Hola, info',
    config: criterioConfig()
  })

  assert.equal(result.reply, 'claro, qué fue lo que te llamó la atención del anuncio?')
  assert.equal((result.reply.match(/\?/g) || []).length, 1)
})

test('la estrategia directa de Anfitrión conserva la respuesta de precio', () => {
  const reply = 'La consulta cuesta $800. ¿Te gustaría agendar?'
  const result = enforceOpeningConversationPolicy({
    reply,
    messages: [{ role: 'user', content: '¿Cuánto cuesta?' }],
    latestText: '¿Cuánto cuesta?',
    config: criterioConfig({ persuasionLevel: 'low' }),
    priceInsistenceCount: 1
  })

  assert.equal(result.reply, 'La consulta cuesta $800. Te gustaría agendar?')
  assert.equal(result.reason, '')
})

test('normaliza signos de apertura sólo en canales de chat', () => {
  assert.equal(normalizeVisibleChatStyle('¡Hola! ¿Cómo te ayudo?', { channel: 'whatsapp' }), 'Hola! Cómo te ayudo?')
  assert.equal(normalizeVisibleChatStyle('¡Hola! ¿Cómo te ayudo?', { channel: 'email' }), '¡Hola! ¿Cómo te ayudo?')
})

test('detecta declaraciones explícitas de cliente previo sin confundir negaciones o preguntas generales', () => {
  assert.ok(detectExplicitPastClientDisclosure('Yo ya soy paciente y ya pagué una sesión, quiero reagendar'))
  assert.ok(detectExplicitPastClientDisclosure('Necesito mover mi cita del viernes'))
  assert.equal(detectExplicitPastClientDisclosure('No soy paciente, apenas vi el anuncio'), null)
  assert.equal(detectExplicitPastClientDisclosure('¿Atienden pacientes que ya fueron con otro doctor?'), null)
  assert.equal(detectExplicitPastClientDisclosure('Fui a otra clínica y no me resolvieron'), null)
})

test('detecta una solicitud inequívoca de humano y respeta su negación', () => {
  assert.ok(detectExplicitHumanRequest('Quiero hablar con una persona'))
  assert.ok(detectExplicitHumanRequest('Me puedes pasar con un asesor?'))
  assert.equal(detectExplicitHumanRequest('No quiero hablar con una persona, aquí está bien'), null)
  assert.equal(detectExplicitHumanRequest('No es que quiera hablar con una persona, sólo tengo una duda'), null)
})

test('la regla de clientes previos fuerza send_to_human sin marcar el objetivo', () => {
  const config = criterioConfig({
    goalWorkflow: {
      attention: { pastClientsToHuman: true },
      appointments: { owner: 'human', calendarId: 'cal_test' }
    }
  })
  const decision = evaluateTurnPolicy({
    latestText: 'Yo ya soy paciente y ya pagué una sesión, quiero reagendar',
    config,
    pastClientContext: { enabled: true, evidence: null }
  })

  assert.equal(decision.forceHumanHandoff.source, 'explicit_past_client')
  assert.equal(decision.forceHumanHandoff.completeObjective, false)

  const guarded = applyConversationalRuntimeReplyGuard({
    reply: 'Perfecto, qué fecha y hora quieres?',
    latestText: 'Yo ya soy paciente y ya pagué una sesión, quiero reagendar',
    messages: [{ role: 'user', content: 'Yo ya soy paciente y ya pagué una sesión, quiero reagendar' }],
    config,
    pastClientContext: { enabled: true, evidence: null },
    preflightDecision: decision
  })

  assert.equal(guarded.reply, 'claro, dame un momentito y revisamos tu caso')
  assert.equal(guarded.suppressReply, false)
  assert.equal(guarded.forceHumanHandoff.completeObjective, false)
  assert.deepEqual(guarded.events.map((event) => event.type), ['runtime_policy_handoff'])
})

test('una descalificación fuerte conserva la prioridad de seguridad sobre el handoff', () => {
  const decision = evaluateTurnPolicy({
    latestText: 'Quiero hablar con una persona',
    config: criterioConfig(),
    intelligenceState: {
      qualification: { status: 'disqualified' },
      signals: { disqualification: 1 }
    }
  })

  assert.equal(decision.forceHumanHandoff, null)
})

test('el planeador no sugiere list_products en la primera pregunta de precio', () => {
  const policy = compileConversationalAgentPolicy(criterioConfig())
  const strategy = planConversationStrategy({
    intelligenceState: {},
    policy,
    latestMessage: 'Hola, cuánto cuesta la consulta?',
    isOpeningTurn: true,
    priceInsistenceCount: 1
  })

  assert.equal(strategy.action, 'ask_clarifying_question')
  assert.equal(strategy.tool, 'none')
  assert.doesNotMatch(strategy.reason, /responder antes/i)
})

test('el planeador vuelve a responder precio al superar la insistencia dura', () => {
  const policy = compileConversationalAgentPolicy(criterioConfig())
  const strategy = planConversationStrategy({
    intelligenceState: {},
    policy,
    latestMessage: 'Ya te pregunté tres veces, cuánto cuesta?',
    isOpeningTurn: true,
    priceInsistenceCount: 3
  })

  assert.equal(strategy.action, 'answer_question')
  assert.equal(strategy.tool, 'list_products')
})
