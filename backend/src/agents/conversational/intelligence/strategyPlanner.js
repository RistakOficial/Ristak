import { normalizeConversationIntelligenceState } from './contracts.js'

const SUCCESS_TOOL_BY_ACTION = {
  book_appointment: 'book_appointment',
  ready_to_buy: 'create_payment_link',
  ready_for_human: 'mark_ready_to_advance',
  send_goal_url: 'send_goal_url',
  send_trigger_link: 'send_trigger_link',
  internal_signal: 'mark_ready_to_advance',
  none: 'none'
}
const DIRECT_QUESTION_PATTERN = /\?|^(?:cu[aá]nto|qu[eé]|c[oó]mo|cu[aá]ndo|d[oó]nde|cu[aá]l|tienen|hacen|incluye|aceptan|puedo)\b/i
const PRICE_PATTERN = /\b(?:precio|costo|valor|cu[aá]nto|tarifa|mensualidad|anticipo|pago)\b/i
const SCHEDULE_PATTERN = /\b(?:horario|disponibilidad|agenda|cita|fecha|hora)\b/i
const BUSINESS_INFO_PATTERN = /\b(?:direcci[oó]n|ubicaci[oó]n|d[oó]nde est[aá]n|horario de atenci[oó]n|qu[eé] hacen|servicios?)\b/i
const EXPLICIT_CONFIRMATION_PATTERN = /\b(?:confirmo|s[ií],? (?:quiero|vamos|ese|esa)|me quedo con|ag[eé]ndame|m[aá]ndame el link|quiero pagar|quiero comprar|ese horario|esa hora)\b/i

function cleanText(value, maxLength = 700) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function allowedTool(policy = {}, tool = 'none') {
  if (!tool || tool === 'none') return true
  const reads = Array.isArray(policy?.permissions?.readTools) ? policy.permissions.readTools : []
  const writes = Array.isArray(policy?.permissions?.writeTools) ? policy.permissions.writeTools : []
  return reads.includes(tool) || writes.includes(tool)
}

function readToolForQuestion(text = '') {
  if (PRICE_PATTERN.test(text)) return 'list_products'
  if (SCHEDULE_PATTERN.test(text)) return 'get_free_slots'
  if (BUSINESS_INFO_PATTERN.test(text)) return 'get_business_profile'
  return 'none'
}

function plan(action, reason, { tool = 'none', primaryQuestion = '', shouldReply = true, candidates = [] } = {}) {
  return {
    action,
    reason: cleanText(reason),
    primaryQuestion: cleanText(primaryQuestion, 500),
    tool,
    shouldReply,
    candidates: [...new Set(candidates.filter(Boolean))].slice(0, 5)
  }
}

export function planConversationStrategy({
  intelligenceState = {},
  policy = {},
  latestMessage = '',
  followUpMode = false,
  toolFailures = []
} = {}) {
  const state = normalizeConversationIntelligenceState(intelligenceState, {
    objective: policy?.objective?.type || 'custom'
  })
  const latest = cleanText(latestMessage, 1200)
  const signals = state.signals
  const requestedTool = SUCCESS_TOOL_BY_ACTION[policy?.objective?.successAction] || 'none'
  const expressedObjection = state.objections.find((objection) => objection.status === 'expressed')

  if (state.followUp.stop) {
    return plan('wait', 'La persona pidió espacio o no debe recibir más seguimiento.', { shouldReply: false })
  }

  if (followUpMode) {
    if (state.handoff.recommended || signals.humanNeeded >= 0.8) {
      return plan('handoff', state.handoff.reason || 'El caso requiere intervención humana.', { tool: 'send_to_human' })
    }
    return plan('follow_up', state.followUp.reason || 'Retomar el punto abierto con un mensaje contextual.', {
      candidates: ['follow_up', 'wait']
    })
  }

  if (Array.isArray(toolFailures) && toolFailures.length) {
    const critical = toolFailures.some((failure) => failure?.critical !== false)
    if (critical) {
      return plan('handoff', 'Una acción necesaria falló y no existe una alternativa automática confirmada.', {
        tool: 'send_to_human',
        candidates: ['handoff', 'answer_question']
      })
    }
  }

  if (state.handoff.recommended || signals.humanNeeded >= 0.8) {
    return plan('handoff', state.handoff.reason || 'La intervención humana tiene mejor probabilidad de resolver el caso.', {
      tool: allowedTool(policy, 'send_to_human') ? 'send_to_human' : 'none'
    })
  }

  if (state.qualification.status === 'disqualified' || signals.disqualification >= 0.85) {
    return plan('disqualify', 'El contacto no cumple los criterios configurados o pidió finalizar.', {
      candidates: ['disqualify', 'close_respectfully', 'handoff']
    })
  }

  if (DIRECT_QUESTION_PATTERN.test(latest)) {
    const tool = readToolForQuestion(latest)
    return plan('answer_question', 'La persona hizo una pregunta concreta; debe recibir respuesta antes de cualquier intento de avance.', {
      tool: allowedTool(policy, tool) ? tool : 'none',
      candidates: ['answer_question', 'ask_clarifying_question']
    })
  }

  if (state.missingInformation.length || state.qualification.missing.length) {
    const missing = state.missingInformation[0] || state.qualification.missing[0]
    return plan('collect_required_data', `Falta un dato necesario para cumplir el objetivo: ${missing}.`, {
      primaryQuestion: `Confirma ${missing}.`,
      candidates: ['collect_required_data', 'answer_question']
    })
  }

  if (expressedObjection) {
    return plan(
      expressedObjection.category === 'trust' ? 'build_trust' : 'resolve_objection',
      `Hay una objeción expresada de ${expressedObjection.category}; primero hay que entenderla o resolverla sin introducir objeciones nuevas.`,
      { candidates: ['resolve_objection', 'ask_clarifying_question', 'handoff'] }
    )
  }

  const explicitlyConfirmed = EXPLICIT_CONFIRMATION_PATTERN.test(latest)
  const readyForAction = explicitlyConfirmed && signals.proposalReadiness >= 0.72 && signals.advance >= 0.72
  if (readyForAction && requestedTool !== 'none') {
    if (!allowedTool(policy, requestedTool)) {
      return plan('handoff', 'La persona está lista, pero el agente no tiene permiso para ejecutar la acción requerida.', {
        tool: allowedTool(policy, 'send_to_human') ? 'send_to_human' : 'none'
      })
    }
    return plan('execute_tool', 'La persona confirmó el siguiente paso y las precondiciones conversacionales están cubiertas; la herramienta todavía debe validar el resultado real.', {
      tool: requestedTool,
      candidates: ['execute_tool', 'handoff']
    })
  }

  if (state.temperature === 'hot' || signals.proposalReadiness >= 0.65) {
    return plan('propose_next_step', 'Hay señales suficientes para facilitar un siguiente paso pequeño y concreto, sin seguir interrogando.', {
      candidates: ['propose_next_step', 'answer_question', 'handoff']
    })
  }

  if (signals.trust < 0.35) {
    return plan('build_trust', 'La conversación necesita claridad o confianza antes de proponer un cierre.', {
      candidates: ['build_trust', 'answer_question', 'ask_clarifying_question']
    })
  }

  if (state.temperature === 'warm') {
    return plan('explore_outcome', 'Existe interés, pero todavía falta entender el obstáculo o resultado principal.', {
      candidates: ['explore_outcome', 'qualify', 'answer_question']
    })
  }

  return plan(
    state.intent.confidence < 0.45 ? 'ask_clarifying_question' : 'explore_need',
    state.intent.confidence < 0.45
      ? 'La intención todavía es ambigua; conviene confirmar con una sola pregunta breve.'
      : 'La persona está explorando; conviene comprender su situación sin presionar.',
    { candidates: ['ask_clarifying_question', 'explore_need', 'answer_question'] }
  )
}

export function applyStrategyPlan(intelligenceState = {}, strategy = {}) {
  return normalizeConversationIntelligenceState({
    ...intelligenceState,
    strategy
  }, {
    objective: intelligenceState?.objective || 'custom',
    channel: intelligenceState?.channel || 'chat'
  })
}
