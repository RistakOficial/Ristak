import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyStrategyPlan,
  buildConversationalLearningSnapshot,
  buildConversationIntelligenceContextMessage,
  buildStructuredHandoffSummary,
  compileConversationalAgentPolicy,
  evaluateIntelligenceExpectation,
  finalizeConversationIntelligenceTurn,
  normalizeConversationIntelligenceState,
  planConversationStrategy,
  retrieveRelevantBusinessKnowledge,
  runDeterministicConversationScenario,
  sanitizeConversationIntelligenceForPersistence,
  validateLearningProposal
} from '../src/agents/conversational/intelligence/index.js'

function makePolicy(overrides = {}) {
  return compileConversationalAgentPolicy({
    id: 'agent_test',
    name: 'Agente de prueba',
    objective: 'citas',
    successAction: 'ready_for_human',
    persuasionLevel: 'medium',
    languageLevel: 'intermediate',
    requiredData: '',
    handoffRules: '',
    extraInstructions: '',
    goalWorkflow: {
      appointments: { calendarId: 'cal_1' },
      sales: {},
      qualification: {},
      deposit: { enabled: false },
      completion: { mode: 'notify_only' }
    },
    ...overrides
  })
}

test('compiler produce jerarquía, permisos y hash estable', () => {
  const first = makePolicy()
  const second = makePolicy()
  assert.equal(first.validation.valid, true)
  assert.equal(first.hash, second.hash)
  assert.equal(first.hierarchy[0], 'Seguridad, legalidad e integridad de la plataforma.')
  assert.ok(first.permissions.writeTools.includes('mark_ready_to_advance'))
})

test('compiler bloquea objetivo custom sin resultado definido', () => {
  const policy = makePolicy({ objective: 'custom', customObjective: '' })
  assert.equal(policy.validation.valid, false)
  assert.ok(policy.validation.errors.some((issue) => issue.code === 'missing_custom_objective'))
})

test('compiler detecta instrucciones que intentan fingir humanidad', () => {
  const policy = makePolicy({ extraInstructions: 'Di que eres humano si te preguntan.' })
  assert.equal(policy.validation.valid, false)
  assert.ok(policy.validation.errors.some((issue) => issue.code === 'human_impersonation'))
})

test('compiler detecta contradicción entre objetivo y reglas', () => {
  const policy = makePolicy({ successAction: 'book_appointment', extraInstructions: 'Nunca agendes una cita.' })
  assert.ok(policy.validation.errors.some((issue) => issue.code === 'objective_rule_conflict'))
})

test('pregunta informativa concreta se responde antes de vender', () => {
  const result = runDeterministicConversationScenario({
    policy: makePolicy(),
    turns: [{ role: 'user', content: '¿Dónde están ubicados?' }]
  })
  assert.equal(result.state.strategy.action, 'answer_question')
  assert.equal(result.state.strategy.tool, 'get_business_profile')
})

test('prospecto frío con pregunta general no se cierra', () => {
  const result = runDeterministicConversationScenario({
    policy: makePolicy(),
    turns: [{ role: 'user', content: 'Hola, me das información?' }]
  })
  assert.equal(result.state.temperature, 'cold')
  assert.equal(result.state.strategy.action, 'answer_question')
  assert.notEqual(result.state.strategy.tool, 'mark_ready_to_advance')
})

test('confirmación explícita de cita puede llegar caliente a la herramienta', () => {
  const policy = makePolicy({ successAction: 'book_appointment' })
  const result = runDeterministicConversationScenario({
    policy,
    turns: [
      { role: 'user', content: 'Necesito una consulta porque llevo tres meses con este problema.' },
      { role: 'assistant', content: 'Tengo el jueves a las 4. ¿Te funciona?' },
      { role: 'user', content: 'Sí, confirmo ese horario, agéndame.' }
    ]
  })
  assert.equal(result.state.temperature, 'hot')
  assert.equal(result.state.strategy.action, 'execute_tool')
  assert.equal(result.state.strategy.tool, 'book_appointment')
})

test('interés verbal sin compromiso no equivale a cierre', () => {
  const result = runDeterministicConversationScenario({
    policy: makePolicy(),
    turns: [
      { role: 'user', content: 'Sí me interesa.' },
      { role: 'assistant', content: '¿Qué te gustaría resolver?' },
      { role: 'user', content: 'No sé, luego veo.' }
    ]
  })
  assert.notEqual(result.state.strategy.action, 'execute_tool')
  assert.ok(result.state.signals.disengagement >= 0.18)
})

test('objeción de precio se atiende sin inventar otra objeción', () => {
  const result = runDeterministicConversationScenario({
    policy: makePolicy(),
    turns: [{ role: 'user', content: 'Se me hace muy caro para mi presupuesto.' }]
  })
  assert.equal(result.state.strategy.action, 'resolve_objection')
  assert.equal(result.state.objections[0].category, 'price')
  assert.equal(result.state.objections[0].status, 'expressed')
})

test('desconfianza favorece construir confianza', () => {
  const result = runDeterministicConversationScenario({
    policy: makePolicy(),
    turns: [{ role: 'user', content: '¿Cómo sé que esto es real y funciona?' }]
  })
  assert.equal(result.state.strategy.action, 'answer_question')
  assert.ok(result.state.objections.some((item) => item.category === 'trust'))
})

test('mensaje ambiguo y corto pide aclaración, no adivina', () => {
  const result = runDeterministicConversationScenario({
    policy: makePolicy(),
    turns: [{ role: 'user', content: 'eso' }]
  })
  assert.equal(result.state.strategy.action, 'ask_clarifying_question')
  assert.ok(result.state.intent.confidence < 0.6)
})

test('solicitud explícita de humano genera handoff', () => {
  const result = runDeterministicConversationScenario({
    policy: makePolicy(),
    turns: [{ role: 'user', content: 'Quiero hablar con una persona real, por favor.' }]
  })
  assert.equal(result.state.strategy.action, 'handoff')
  assert.equal(result.state.strategy.tool, 'send_to_human')
  assert.equal(result.state.handoff.recommended, true)
})

test('frustración eleva urgencia de handoff', () => {
  const result = runDeterministicConversationScenario({
    policy: makePolicy(),
    turns: [{ role: 'user', content: 'Ya te dije tres veces y no entiendes, estoy frustrado.' }]
  })
  assert.equal(result.state.handoff.recommended, true)
  assert.equal(result.state.handoff.urgency, 'high')
})

test('comparación se registra como señal, no como certeza sobre conducta', () => {
  const result = runDeterministicConversationScenario({
    policy: makePolicy(),
    turns: [{ role: 'user', content: 'Estoy cotizando y comparando con otros lugares.' }]
  })
  assert.ok(result.state.signals.comparisonShopping >= 0.8)
  assert.ok(result.state.objections.some((item) => item.category === 'comparison'))
})

test('dato requerido faltante conduce a recopilar sólo ese dato', () => {
  const policy = makePolicy({ requiredData: 'correo electrónico' })
  const result = runDeterministicConversationScenario({
    policy,
    turns: [{ role: 'user', content: 'Quiero avanzar con la valoración.' }]
  })
  assert.equal(result.state.strategy.action, 'collect_required_data')
  assert.deepEqual(result.state.missingInformation, ['correo electrónico'])
})

test('email explícito se conserva como hecho confirmado con evidencia', () => {
  const result = runDeterministicConversationScenario({
    policy: makePolicy(),
    turns: [{ id: 'in_1', role: 'user', content: 'Mi correo es ana@example.com.' }]
  })
  const fact = result.state.story.confirmedFacts.find((item) => item.key === 'email')
  assert.equal(fact?.value, 'ana@example.com')
  assert.equal(fact?.messageId, 'in_1')
  assert.equal(fact?.confidence, 1)
})

test('un dato ya compartido satisface el requisito y no se vuelve a pedir', () => {
  const policy = makePolicy({ requiredData: 'correo electrónico' })
  const result = runDeterministicConversationScenario({
    policy,
    turns: [{ role: 'user', content: 'Quiero avanzar. Mi correo es ana@example.com.' }]
  })
  assert.deepEqual(result.state.missingInformation, [])
  assert.notEqual(result.state.strategy.action, 'collect_required_data')
})

test('si el contacto cambia un dato confirmado queda una contradicción auditable', () => {
  const policy = makePolicy()
  const first = runDeterministicConversationScenario({
    policy,
    turns: [{ role: 'user', content: 'Mi correo es ana@example.com.' }]
  })
  const changed = runDeterministicConversationScenario({
    policy,
    initialState: first.state,
    turns: [{ role: 'user', content: 'Mejor usa ana.nueva@example.com.' }]
  })
  assert.ok(changed.state.story.contradictions.some((item) => (
    item.key === 'email' && item.previousValue === 'ana@example.com' && item.currentValue === 'ana.nueva@example.com'
  )))
})

test('un criterio de descalificación configurado se aplica sin inventar criterios', () => {
  const policy = makePolicy({
    objective: 'filtrar',
    goalWorkflow: {
      appointments: { calendarId: 'cal_1' },
      sales: {},
      qualification: { disqualifies: ['menor de edad'] },
      deposit: { enabled: false },
      completion: { mode: 'notify_only' }
    }
  })
  const result = runDeterministicConversationScenario({
    policy,
    turns: [{ role: 'user', content: 'Soy menor de edad y sólo estoy preguntando.' }]
  })
  assert.equal(result.state.qualification.status, 'disqualified')
  assert.equal(result.state.strategy.action, 'disqualify')
  assert.deepEqual(result.state.qualification.disqualifiers, ['menor de edad'])
})

test('una aceptación tentativa de cita eleva riesgo y no se trata como confirmación sólida', () => {
  const result = runDeterministicConversationScenario({
    policy: makePolicy({ successAction: 'book_appointment' }),
    turns: [{ role: 'user', content: 'Creo que sí puedo ir a la cita, a ver si alcanzo.' }]
  })
  assert.ok(result.state.signals.cancellation >= 0.65)
  assert.ok(result.state.signals.attendance < 0.5)
  assert.notEqual(result.state.strategy.action, 'execute_tool')
})

test('normalización elimina hipótesis sobre atributos sensibles', () => {
  const state = normalizeConversationIntelligenceState({
    story: {
      hypotheses: [
        { key: 'salud mental', value: 'ansiedad', confidence: 0.8, evidence: 'responde corto' },
        { key: 'objeción oculta', value: 'falta de confianza', confidence: 0.5, evidence: 'pide evidencia' }
      ]
    }
  })
  assert.equal(state.story.hypotheses.length, 1)
  assert.equal(state.story.hypotheses[0].key, 'objeción oculta')
})

test('la memoria persistida no duplica hechos ni resúmenes sensibles', () => {
  const state = normalizeConversationIntelligenceState({
    summary: 'La persona cuenta que tiene ansiedad y dolor persistente.',
    intent: { explicit: 'Quiero tratar mi lesión', implicit: '', confidence: 0.9 },
    story: {
      confirmedFacts: [
        { key: 'email', value: 'ana@example.com', evidence: 'Mi correo es ana@example.com', source: 'contact' },
        { key: 'salud', value: 'ansiedad', evidence: 'Tengo ansiedad', source: 'contact' }
      ]
    }
  })
  const persisted = sanitizeConversationIntelligenceForPersistence(state)
  assert.equal(persisted.story.confirmedFacts.some((item) => item.key === 'salud'), false)
  assert.equal(persisted.story.confirmedFacts.some((item) => item.key === 'email'), true)
  assert.doesNotMatch(persisted.summary, /ansiedad|dolor/i)
  assert.doesNotMatch(persisted.intent.explicit, /lesi[oó]n/i)
})

test('opt-out detiene seguimiento', () => {
  const result = runDeterministicConversationScenario({
    policy: makePolicy(),
    followUpMode: true,
    turns: [{ role: 'user', content: 'Ya no me interesa, no me escriban.' }]
  })
  assert.equal(result.state.followUp.stop, true)
  assert.equal(result.state.strategy.action, 'wait')
  assert.equal(result.state.strategy.shouldReply, false)
})

test('seguimiento contextual no ejecuta herramientas de cierre', () => {
  const result = runDeterministicConversationScenario({
    policy: makePolicy(),
    followUpMode: true,
    turns: [{ role: 'user', content: 'Quedé de revisar la propuesta.' }]
  })
  assert.equal(result.state.strategy.action, 'follow_up')
  assert.equal(result.state.strategy.tool, 'none')
})

test('fallo crítico de herramienta cambia la estrategia a handoff', () => {
  const policy = makePolicy()
  const base = runDeterministicConversationScenario({
    policy,
    turns: [{ role: 'user', content: 'Sí, quiero avanzar.' }]
  }).state
  const strategy = planConversationStrategy({
    intelligenceState: base,
    policy,
    latestMessage: 'Sí, quiero avanzar.',
    toolFailures: [{ tool: 'get_free_slots', critical: true, error: 'Calendario no disponible' }]
  })
  assert.equal(strategy.action, 'handoff')
  assert.equal(strategy.tool, 'send_to_human')
})

test('resumen de handoff separa hechos de hipótesis y pendientes', () => {
  const state = normalizeConversationIntelligenceState({
    summary: 'Ana busca una consulta.',
    intent: { explicit: 'Quiere agendar', implicit: '', confidence: 1 },
    story: {
      confirmedFacts: [{ key: 'motivo', value: 'consulta', evidence: 'quiero consulta', messageId: 'm1', source: 'contact' }],
      hypotheses: [{ key: 'objeción oculta', value: 'precio', confidence: 0.4, evidence: 'preguntó costo', source: 'contact' }]
    },
    missingInformation: ['horario'],
    handoff: { recommended: true, reason: 'Pidió humano', urgency: 'normal' }
  })
  const summary = buildStructuredHandoffSummary({ intelligenceState: state, contact: { id: 'c1', name: 'Ana' } })
  assert.equal(summary.confirmedFacts[0].value, 'consulta')
  assert.equal(summary.hypotheses[0].confidence, 0.4)
  assert.deepEqual(summary.pending, ['horario'])
})

test('resultado de tool confirmado marca outcome completo', () => {
  const finalized = finalizeConversationIntelligenceTurn({
    intelligenceState: normalizeConversationIntelligenceState({ stage: 'action' }),
    actions: [{ type: 'book_appointment', ok: true }],
    reply: 'Listo, quedó confirmada.'
  })
  assert.equal(finalized.state.outcome.status, 'completed')
  assert.equal(finalized.state.outcome.toolConfirmed, true)
  assert.equal(finalized.state.stage, 'completed')
})

test('link de pago queda pendiente, no se registra como compra completada', () => {
  const finalized = finalizeConversationIntelligenceTurn({
    intelligenceState: normalizeConversationIntelligenceState({ stage: 'action' }),
    actions: [{ type: 'create_payment_link', ok: true }],
    reply: 'Aquí está el enlace.'
  })
  assert.equal(finalized.state.outcome.status, 'pending')
  assert.equal(finalized.state.outcome.lastAction, 'create_payment_link')
})

test('tool fallida queda como failed y no confirma resultado', () => {
  const finalized = finalizeConversationIntelligenceTurn({
    intelligenceState: normalizeConversationIntelligenceState({ stage: 'action' }),
    actions: [{ type: 'book_appointment', ok: false, error: 'Sin disponibilidad' }],
    reply: 'Voy a pedir apoyo.'
  })
  assert.equal(finalized.state.outcome.status, 'failed')
  assert.equal(finalized.state.outcome.toolConfirmed, false)
})

test('el outcome sellado por la tool es evidencia y una simulación no completa nada', () => {
  const completed = finalizeConversationIntelligenceTurn({
    intelligenceState: normalizeConversationIntelligenceState({ stage: 'action' }),
    actions: [{ type: 'book_appointment', outcome: { status: 'ok', ok: true, simulated: false } }],
    reply: 'Tu cita quedó confirmada.'
  })
  const simulated = finalizeConversationIntelligenceTurn({
    intelligenceState: normalizeConversationIntelligenceState({ stage: 'action' }),
    actions: [{ type: 'book_appointment', outcome: { status: 'simulated', ok: true, simulated: true } }],
    reply: 'Simulación.'
  })
  assert.equal(completed.state.outcome.status, 'completed')
  assert.equal(simulated.state.outcome.status, 'open')
  assert.equal(simulated.actionResults[0].simulated, true)
})

test('contexto interno prohíbe exponer scores y afirmar acciones no confirmadas', () => {
  const message = buildConversationIntelligenceContextMessage(normalizeConversationIntelligenceState({
    summary: 'Busca una cita.',
    signals: { advance: 0.8 },
    strategy: { action: 'propose_next_step', reason: 'Está listo', tool: 'none', shouldReply: true }
  }), makePolicy())
  assert.match(message.content, /No menciones temperaturas, probabilidades/)
  assert.match(message.content, /no afirmes una acción hasta que la herramienta la confirme/)
  assert.equal(message.role, 'user')
})

test('temperatura puede subir y bajar según comportamiento reciente', () => {
  const policy = makePolicy({ successAction: 'book_appointment' })
  const hot = runDeterministicConversationScenario({
    policy,
    turns: [
      { role: 'user', content: 'Necesito resolver esto y quiero agendar.' },
      { role: 'assistant', content: 'Tengo mañana a las 10.' },
      { role: 'user', content: 'Sí, confirmo ese horario, agéndame.' }
    ]
  })
  assert.equal(hot.state.temperature, 'hot')

  const cooled = runDeterministicConversationScenario({
    policy,
    initialState: hot.state,
    turns: [{ role: 'user', content: 'Ya no quiero, no me escriban.' }]
  })
  assert.equal(cooled.state.temperature, 'cold')
})

test('políticas de dos negocios producen hashes y reglas aisladas', () => {
  const clinic = makePolicy({ id: 'clinic', extraInstructions: 'Atiende con lenguaje clínico y no prometas resultados.' })
  const school = makePolicy({ id: 'school', objective: 'datos', extraInstructions: 'Explica modalidades del curso.' })
  assert.notEqual(clinic.hash, school.hash)
  assert.doesNotMatch(clinic.business.rules, /modalidades del curso/)
  assert.doesNotMatch(school.business.rules, /lenguaje clínico/)
})

test('conocimiento recupera sólo material relevante del negocio actual', () => {
  const clinic = retrieveRelevantBusinessKnowledge({
    businessProfile: {
      configured: true,
      summary: 'Clínica Horizonte.',
      profile: { services: ['Consulta dental', 'Ortodoncia'] },
      sourceContext: 'La consulta dental cuesta lo indicado en catálogo.\n\nLa clínica abre de lunes a viernes.'
    },
    query: '¿Qué horario tiene la clínica?'
  })
  const school = retrieveRelevantBusinessKnowledge({
    businessProfile: {
      configured: true,
      summary: 'Academia Norte.',
      profile: { services: ['Curso de inglés'] },
      sourceContext: 'Las clases pueden ser sabatinas.'
    },
    query: '¿Qué horario tiene la clínica?'
  })
  assert.match(clinic.context, /lunes a viernes/)
  assert.doesNotMatch(clinic.context, /Curso de inglés/)
  assert.doesNotMatch(school.context, /Consulta dental/)
  assert.equal(clinic.found, true)
})

test('conocimiento nunca arrastra llaves o tokens incluidos por error en el perfil', () => {
  const result = retrieveRelevantBusinessKnowledge({
    businessProfile: {
      configured: true,
      summary: 'Negocio de prueba.',
      profile: { faq: 'Atendemos con cita.', apiKey: 'secreto-no-visible', nested: { accessToken: 'otro-secreto' } }
    },
    query: '¿Atienden con cita?'
  })
  assert.match(result.context, /Atendemos con cita/)
  assert.doesNotMatch(result.context, /secreto-no-visible|otro-secreto/)
})

test('si la capacitación no contiene la respuesta, conocimiento falla cerrado', () => {
  const result = retrieveRelevantBusinessKnowledge({
    businessProfile: {
      configured: true,
      summary: 'Academia de idiomas.',
      profile: { services: ['Inglés básico'] },
      sourceContext: 'Las clases duran una hora.'
    },
    query: '¿Tienen certificación aeronáutica internacional?'
  })
  assert.equal(result.found, false)
  assert.equal(result.confidence, 0)
  assert.equal(result.context, '')
})

test('evaluador reproduce criterios de aceptación sin depender del modelo', () => {
  const result = runDeterministicConversationScenario({
    policy: makePolicy(),
    turns: [{ role: 'user', content: 'Pásame con una asesora.' }]
  })
  const evaluation = evaluateIntelligenceExpectation(result.state, {
    action: 'handoff',
    tool: 'send_to_human',
    handoff: true,
    maxHypotheses: 0
  })
  assert.equal(evaluation.passed, true, JSON.stringify(evaluation.checks))
})

test('applyStrategyPlan conserva memoria y cambia sólo la decisión', () => {
  const state = normalizeConversationIntelligenceState({
    summary: 'Contexto existente',
    story: { confirmedFacts: [{ key: 'motivo', value: 'agenda', evidence: 'quiero cita', source: 'contact' }] }
  })
  const next = applyStrategyPlan(state, {
    action: 'propose_next_step',
    reason: 'Hay suficiente contexto.',
    primaryQuestion: '',
    tool: 'none',
    shouldReply: true
  })
  assert.equal(next.summary, 'Contexto existente')
  assert.equal(next.story.confirmedFacts.length, 1)
  assert.equal(next.strategy.action, 'propose_next_step')
})

test('aprendizaje genera propuesta versionada sin cambiar configuración', () => {
  const snapshot = buildConversationalLearningSnapshot({
    agentId: 'agent_1',
    previousVersion: 2,
    events: [
      { eventType: 'reply_sent', detail: { agentId: 'agent_1' } },
      { eventType: 'payment_link_failed', detail: { agentId: 'agent_1' } },
      { eventType: 'payment_link_failed', detail: { agentId: 'agent_1' } }
    ],
    states: [{ agentId: 'agent_1', status: 'active' }]
  })
  assert.equal(snapshot.version, 3)
  assert.equal(snapshot.status, 'proposed')
  assert.ok(snapshot.proposals.some((proposal) => proposal.kind === 'configuration_review'))
  assert.equal(typeof snapshot.hash, 'string')
})

test('aprendizaje nunca autoriza cambios críticos automáticos', () => {
  const verdict = validateLearningProposal({
    title: 'Cambiar precio',
    suggestedChange: 'Subir el monto de todos los productos automáticamente.'
  })
  assert.equal(verdict.valid, false)
  assert.equal(verdict.requiresHumanReview, true)
})
