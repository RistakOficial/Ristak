import { createHash } from 'node:crypto'

const CRITICAL_RULE_PATTERN = /\b(?:price|pricing|amount|currency|policy|permission|secret|token|password|legal|safety|precio|monto|moneda|pol[ií]tica|permiso|contrase[nñ]a|seguridad)\b/i

function cleanText(value, maxLength = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function parseDetail(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return {} }
}

function eventType(row = {}) {
  return cleanText(row.eventType || row.event_type, 160)
}

function eventAgentId(row = {}) {
  const detail = parseDetail(row.detail || row.detail_json)
  return cleanText(row.agentId || row.agent_id || detail.agentId, 180)
}

function percentage(value, total) {
  if (!total) return 0
  return Math.round((Number(value || 0) / total) * 10000) / 100
}

export function aggregateConversationalLearningMetrics({ events = [], states = [], agentId = '' } = {}) {
  // Fail-closed por agente: un evento legado sin agentId no se usa para entrenar
  // ningún agente concreto, porque podría pertenecer a otro flujo de la cuenta.
  const filteredEvents = (Array.isArray(events) ? events : []).filter((row) => !agentId || eventAgentId(row) === agentId)
  const filteredStates = (Array.isArray(states) ? states : []).filter((row) => !agentId || String(row.agentId || row.agent_id || '') === agentId)
  const counts = {}
  for (const row of filteredEvents) {
    const type = eventType(row)
    if (type) counts[type] = (counts[type] || 0) + 1
  }

  const outcomeEvents = (counts.objective_completed || 0) + (counts.appointment_booked || 0) + (counts.purchase_completed || 0) + (counts.goal_url_completed || 0)
  const attempts = outcomeEvents + (counts.agent_error || 0) + (counts.discarded || 0) + (counts.payment_link_failed || 0)
  const toolFailures = Object.entries(counts)
    .filter(([type]) => /(?:failed|error)$/.test(type))
    .reduce((sum, [, count]) => sum + count, 0)
  const replies = counts.reply_sent || 0
  const handoffs = (counts.objective_completed || 0) + (counts.runtime_human_handoff_forced || 0)

  return {
    conversations: filteredStates.length,
    events: filteredEvents.length,
    replies,
    outcomes: outcomeEvents,
    handoffs,
    discarded: filteredStates.filter((row) => row.status === 'discarded').length,
    paused: filteredStates.filter((row) => row.status === 'paused').length,
    toolFailures,
    successRate: percentage(outcomeEvents, attempts),
    toolFailureRate: percentage(toolFailures, Math.max(1, replies + toolFailures)),
    eventCounts: counts
  }
}

function proposeFromMetrics(metrics = {}) {
  const proposals = []
  if (metrics.toolFailureRate >= 10) {
    proposals.push({
      kind: 'configuration_review',
      title: 'Revisar herramientas con más fallos',
      rationale: `${metrics.toolFailureRate}% de las ejecuciones observables terminaron en error.`,
      suggestedChange: 'Revisar calendarios, catálogo, permisos y conexiones antes de cambiar el discurso.',
      risk: 'low'
    })
  }
  if (metrics.handoffs > 0 && metrics.outcomes > 0 && metrics.handoffs / metrics.outcomes >= 0.7) {
    proposals.push({
      kind: 'handoff_review',
      title: 'Revisar por qué la mayoría de resultados terminan en humano',
      rationale: 'El agente está escalando gran parte de los avances; puede ser correcto o indicar permisos incompletos.',
      suggestedChange: 'Comparar motivos de traspaso y habilitar sólo las acciones repetitivas que sean seguras.',
      risk: 'medium'
    })
  }
  if ((metrics.eventCounts.follow_up_sent || 0) > 0 && (metrics.eventCounts.follow_up_suppressed || 0) > (metrics.eventCounts.follow_up_sent || 0)) {
    proposals.push({
      kind: 'follow_up_review',
      title: 'Ajustar condiciones de seguimiento',
      rationale: 'Se suprimieron más seguimientos de los que se enviaron.',
      suggestedChange: 'Revisar tiempos, canal, opt-out y motivo válido antes de ampliar intentos.',
      risk: 'low'
    })
  }
  return proposals
}

export function buildConversationalLearningSnapshot({ agentId = '', events = [], states = [], previousVersion = 0, now = new Date() } = {}) {
  const metrics = aggregateConversationalLearningMetrics({ events, states, agentId })
  const proposals = proposeFromMetrics(metrics)
  const base = {
    schemaVersion: 1,
    version: Math.max(0, Number(previousVersion) || 0) + 1,
    agentId: cleanText(agentId, 180) || null,
    status: 'proposed',
    metrics,
    proposals,
    source: {
      eventCount: metrics.events,
      conversationCount: metrics.conversations,
      generatedAt: now.toISOString()
    }
  }
  return {
    ...base,
    hash: createHash('sha256').update(JSON.stringify(base)).digest('hex')
  }
}

export function validateLearningProposal(proposal = {}) {
  const text = [proposal.kind, proposal.title, proposal.suggestedChange].map((value) => cleanText(value, 1200)).join(' ')
  if (CRITICAL_RULE_PATTERN.test(text)) {
    return {
      valid: false,
      requiresHumanReview: true,
      reason: 'Las propuestas de aprendizaje no pueden modificar automáticamente precios, políticas, permisos, seguridad ni secretos.'
    }
  }
  return {
    valid: Boolean(cleanText(proposal.title) && cleanText(proposal.suggestedChange)),
    requiresHumanReview: true,
    reason: 'Toda mejora se propone y se revisa antes de activarse; nunca cambia reglas críticas por sí sola.'
  }
}
