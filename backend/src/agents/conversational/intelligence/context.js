import { normalizeConversationIntelligenceState } from './contracts.js'
import { buildStructuredHandoffSummary } from './handoff.js'

const COMPLETION_ACTIONS = new Set([
  'book_appointment',
  'mark_ready_to_advance',
  'appointment_booked',
  'purchase_completed'
])

const PENDING_ACTIONS = new Set([
  'create_payment_link',
  'send_goal_url',
  'send_trigger_link'
])

function cleanText(value, maxLength = 800) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function list(items, formatter, maxItems = 8) {
  return (Array.isArray(items) ? items : []).slice(0, maxItems).map(formatter).filter(Boolean).join(' | ')
}

export function buildConversationIntelligenceContextMessage(intelligenceState = {}, policy = {}) {
  const state = normalizeConversationIntelligenceState(intelligenceState, {
    objective: policy?.objective?.type || 'custom'
  })
  const facts = list(state.story.confirmedFacts, (item) => `${item.key}=${item.value}`)
  const hypotheses = list(state.story.hypotheses, (item) => `${item.key}≈${item.value} (${Math.round(item.confidence * 100)}%)`)
  const objections = list(state.objections, (item) => `${item.category}:${item.status}`)
  const contradictions = list(state.story.contradictions, (item) => `${item.key}: ${item.previousValue} → ${item.currentValue}`)
  const lines = [
    '[Contexto interno de Ristak: assessment y estrategia conversacional]',
    `Etapa: ${state.stage}. Temperatura orientativa: ${state.temperature}.`,
    state.summary ? `Historia resumida: ${state.summary}` : '',
    state.intent.explicit ? `Intención explícita: ${state.intent.explicit}` : '',
    state.intent.implicit ? `Hipótesis de intención: ${state.intent.implicit} (confianza ${Math.round(state.intent.confidence * 100)}%).` : '',
    facts ? `Hechos confirmados: ${facts}` : 'Hechos confirmados: ninguno todavía.',
    hypotheses ? `Hipótesis (NO tratarlas como hechos): ${hypotheses}` : '',
    contradictions ? `Contradicciones a confirmar con tacto: ${contradictions}` : '',
    objections ? `Objeciones: ${objections}` : '',
    state.missingInformation.length ? `Información realmente faltante: ${state.missingInformation.join(' | ')}` : '',
    `Siguiente acción elegida: ${state.strategy.action}. Motivo: ${state.strategy.reason}`,
    state.strategy.tool !== 'none' ? `Herramienta candidata: ${state.strategy.tool}. Debe validar sus propias precondiciones y resultado real.` : '',
    state.strategy.primaryQuestion ? `Pregunta principal sugerida: ${state.strategy.primaryQuestion}` : '',
    state.handoff.recommended ? `Traspaso recomendado: ${state.handoff.reason}` : '',
    'Reglas de uso: responde primero cualquier pregunta concreta; una sola pregunta principal; no repitas datos; No menciones temperaturas, probabilidades, assessment ni estrategia; no afirmes una acción hasta que la herramienta la confirme; una hipótesis sólo sirve para preguntar mejor, nunca para etiquetar o juzgar.'
  ].filter(Boolean)

  return { role: 'user', content: lines.join('\n') }
}

function actionResult(action = {}) {
  const ok = action.ok ?? action.outcome?.ok ?? action.result?.ok ?? action.data?.ok
  const simulated = action.simulated === true || action.outcome?.simulated === true
  return {
    type: cleanText(action.type, 160),
    ok: ok === true && !simulated,
    simulated,
    failed: ok === false || Boolean(action.error),
    error: cleanText(action.error || action.outcome?.error || action.result?.error || action.data?.error, 500)
  }
}

export function finalizeConversationIntelligenceTurn({
  intelligenceState = {},
  actions = [],
  reply = '',
  suppressed = false,
  contact = null,
  now = new Date()
} = {}) {
  const state = normalizeConversationIntelligenceState(intelligenceState)
  const results = (Array.isArray(actions) ? actions : []).map(actionResult).filter((item) => item.type)
  const confirmed = results.find((item) => item.ok && COMPLETION_ACTIONS.has(item.type))
  const pending = results.find((item) => item.ok && PENDING_ACTIONS.has(item.type))
  const failed = results.find((item) => item.failed)
  const handedOff = results.find((item) => item.ok && item.type === 'send_to_human')
  const discarded = results.find((item) => item.ok && item.type === 'discard_conversation')

  const outcome = confirmed
    ? { status: 'completed', evidence: [`Herramienta confirmada: ${confirmed.type}`], lastAction: confirmed.type, toolConfirmed: true }
    : pending
      ? { status: 'pending', evidence: [`Acción pendiente confirmada: ${pending.type}`], lastAction: pending.type, toolConfirmed: true }
      : failed
        ? { status: 'failed', evidence: [failed.error || `Falló ${failed.type}`], lastAction: failed.type, toolConfirmed: false }
        : discarded
          ? { status: 'disqualified', evidence: ['Conversación descartada por política.'], lastAction: discarded.type, toolConfirmed: true }
          : state.outcome

  const next = normalizeConversationIntelligenceState({
    ...state,
    stage: confirmed ? 'completed' : handedOff ? 'handoff' : state.stage,
    outcome,
    strategy: {
      ...state.strategy,
      shouldReply: !suppressed && Boolean(cleanText(reply, 4000))
    },
    handoff: handedOff
      ? {
          recommended: true,
          reason: state.handoff.reason || 'La conversación fue transferida a una persona.',
          urgency: state.handoff.urgency,
          summary: buildStructuredHandoffSummary({
            intelligenceState: state,
            contact: contact || {},
            actions,
            reason: state.handoff.reason
          })
        }
      : state.handoff,
    updatedAt: now.toISOString()
  })

  return { state: next, actionResults: results }
}
