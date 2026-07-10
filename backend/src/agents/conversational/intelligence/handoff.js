import { normalizeConversationIntelligenceState } from './contracts.js'

function cleanText(value, maxLength = 900) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}
function actionSummary(action = {}) {
  const type = cleanText(action.type, 120)
  if (!type) return null
  const ok = action.ok ?? action.result?.ok ?? action.data?.ok
  return {
    type,
    status: ok === true ? 'confirmed' : ok === false ? 'failed' : 'attempted',
    detail: cleanText(action.error || action.reason || action.motivo || action.effect?.liveEffect, 500)
  }
}

export function buildStructuredHandoffSummary({
  intelligenceState = {},
  contact = {},
  actions = [],
  reason = '',
  recommendedAction = ''
} = {}) {
  const state = normalizeConversationIntelligenceState(intelligenceState)
  const confirmedFacts = state.story.confirmedFacts.map((fact) => ({
    key: fact.key,
    value: fact.value,
    evidence: fact.evidence,
    messageId: fact.messageId
  }))
  const hypotheses = state.story.hypotheses.map((hypothesis) => ({
    key: hypothesis.key,
    value: hypothesis.value,
    confidence: hypothesis.confidence,
    evidence: hypothesis.evidence
  }))
  const actionRows = (Array.isArray(actions) ? actions : []).map(actionSummary).filter(Boolean)

  return {
    contact: {
      id: cleanText(contact.id || contact.contactId, 160) || null,
      name: cleanText(contact.fullName || contact.full_name || contact.name, 200) || null,
      phone: cleanText(contact.phone, 120) || null,
      email: cleanText(contact.email, 240) || null
    },
    need: cleanText(state.intent.explicit || state.summary, 900),
    conversationSummary: cleanText(state.summary, 1400),
    stage: state.stage,
    temperature: state.temperature,
    qualification: state.qualification,
    confirmedFacts,
    hypotheses,
    contradictions: state.story.contradictions,
    objections: state.objections,
    actions: actionRows,
    pending: [...new Set([
      ...state.missingInformation,
      ...state.qualification.missing,
      state.outcome.status === 'pending' ? state.outcome.lastAction : ''
    ].filter(Boolean))],
    transferReason: cleanText(reason || state.handoff.reason, 700),
    recommendedAction: cleanText(recommendedAction || state.strategy.reason, 700)
  }
}

export function formatHandoffSummaryForPrompt(summary = {}) {
  const facts = (summary.confirmedFacts || []).slice(0, 10).map((fact) => `${fact.key}: ${fact.value}`).join('; ')
  const hypotheses = (summary.hypotheses || []).slice(0, 6).map((item) => `${item.key}: ${item.value} (${Math.round(Number(item.confidence || 0) * 100)}%)`).join('; ')
  const objections = (summary.objections || []).slice(0, 6).map((item) => `${item.category}: ${item.status}`).join('; ')
  const pending = (summary.pending || []).slice(0, 8).join('; ')
  return [
    summary.conversationSummary ? `Resumen: ${summary.conversationSummary}` : '',
    summary.need ? `Necesidad: ${summary.need}` : '',
    facts ? `Hechos confirmados: ${facts}` : '',
    hypotheses ? `Hipótesis (no son hechos): ${hypotheses}` : '',
    objections ? `Objeciones: ${objections}` : '',
    pending ? `Pendiente: ${pending}` : '',
    summary.transferReason ? `Motivo del traspaso: ${summary.transferReason}` : '',
    summary.recommendedAction ? `Acción recomendada: ${summary.recommendedAction}` : ''
  ].filter(Boolean).join('\n')
}
