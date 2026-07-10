const INTERNAL_CONTEXT_PREFIX = '[Contexto interno de Ristak:'

const COLD_INTEREST_ONLY_PATTERN = /^(?:hola|buen[oa]s?|info|informaci[oó]n|me interesa|quiero (?:info|informaci[oó]n|cita|agendar)|cu[aá]nto (?:cuesta|sale|vale)|costos?|precios?|precio|cotizaci[oó]n|agenda|cita|quiero comprar|quiero pagar)[\s.!?¿¡]*$/i
const ACK_ONLY_PATTERN = /^(?:s[ií]+|si|ok|okay|va|sale|dale|claro|correcto|perfecto|est[aá] bien|de acuerdo|me parece|adelante|por favor|listo|as[ií] es|bueno)[\s.!?¿¡]*$/i
const ADVANCE_INTENT_PATTERN = /\b(?:s[ií]|ok|va|dale|est[aá]\s+bien|de acuerdo|me parece|adelante|por favor|quiero\s+(?:agendar|avanzar|empezar|comprar|pagar|cita|hablar)|ag[eé]ndame|agendar|agenda(?:r)?|cita|pagar|comprar|m[aá]ndame\s+(?:el\s+)?link|hablar\s+con\s+(?:alguien|un|una)|que\s+me\s+(?:llamen|contacten|atiendan)|pas[ae]me\s+con)\b/i
const NEXT_STEP_INVITATION_PATTERN = /\b(?:te\s+(?:ayudo|apoyo|gustar[ií]a|parece|late|sirve)|si\s+(?:gustas|quieres)|quieres\s+que|te\s+interesa\s+que|dejarl[oa]\s+(?:list[oa]|en)|dejarte\s+list[oa]|siguiente\s+paso|avanzar|agendar|agenda|cita|valoraci[oó]n|revisi[oó]n|diagn[oó]stico|consulta|llamada|hablar\s+con|pasarte\s+con|te\s+paso\s+con|equipo|asesor|humano|especialista|persona)\b/i
const REAL_CONTEXT_PATTERN = /\b(?:tengo|traigo|me\s+(?:duele|molesta|afecta|urge|pasa|interesa|preocupa)|necesito|busco|quiero\s+resolver|problema|dolor|molestia|inflam|trabajo|tratamiento|servicio|producto|proyecto|negocio|clientes|leads|ventas|desde|hace|llevo|mes(?:es)?|a[nñ]o(?:s)?|semana(?:s)?|d[ií]a(?:s)?|no\s+(?:puedo|termin[eé]|he\s+podido)|ya\s+(?:me|nos|lo|la|le)|antes|pendiente|urgente|constante|mucho|complic|resolver|soluci[oó]n)\b/i
const TIME_OR_DURATION_PATTERN = /\b(?:desde|hace|llevo|durante|mes(?:es)?|a[nñ]o(?:s)?|semana(?:s)?|d[ií]a(?:s)?|tiempo|rato|ayer|hoy|mañana|constante|siempre|varios?)\b/i
const IMPACT_PATTERN = /\b(?:me\s+(?:duele|molesta|afecta|urge|preocupa|limita|impide)|no\s+puedo|batallo|pierdo|perdiendo|molesto|dolor|inflam|complic|problema|riesgo|urgente|constante|mucho|necesito)\b/i
const LIKELY_FULL_NAME_PATTERN = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+(?:\s+[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+){1,5}$/
const LIKELY_CAPITALIZED_FULL_NAME_PATTERN = /^[A-ZÁÉÍÓÚÜÑ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+(?:\s+[A-ZÁÉÍÓÚÜÑ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+){1,5}$/
const NAME_REQUEST_PATTERN = /\b(?:nombre\s+completo|tu\s+nombre|me\s+confirmas\s+(?:tu\s+)?nombre|c[oó]mo\s+te\s+llamas|a\s+nombre\s+de\s+qui[eé]n)\b/i

function cleanText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function messageText(message = {}) {
  return cleanText(typeof message?.content === 'string' ? message.content : message?.message_text || message?.text || '')
}

function isInternalContext(message = {}) {
  return messageText(message).startsWith(INTERNAL_CONTEXT_PREFIX)
}

export function visibleConversationMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .filter((message) => !isInternalContext(message))
    .map((message) => ({ role: message.role, content: messageText(message) }))
    .filter((message) => message.content)
}

function isColdInterestOnly(text = '') {
  const clean = cleanText(text)
  return !clean || COLD_INTEREST_ONLY_PATTERN.test(clean)
}

function isAckOnly(text = '') {
  return ACK_ONLY_PATTERN.test(cleanText(text))
}

function isSubstantiveUserText(text = '') {
  const clean = cleanText(text)
  if (clean.length < 18) return false
  if (isColdInterestOnly(clean) || isAckOnly(clean)) return false
  return true
}

function hasRequiredName(config = {}) {
  return /\b(?:nombre|name)\b/i.test(String(config?.requiredData || ''))
}

function hasLikelyFullName(messages = [], contactName = '') {
  if (LIKELY_FULL_NAME_PATTERN.test(cleanText(contactName))) return true
  return messages.some((message, index) => {
    if (message.role !== 'user') return false
    const text = cleanText(message.content)
    if (!LIKELY_FULL_NAME_PATTERN.test(text)) return false
    const recentAssistantAskedName = messages
      .slice(Math.max(0, index - 3), index)
      .some((item) => item.role === 'assistant' && NAME_REQUEST_PATTERN.test(item.content))
    return recentAssistantAskedName || LIKELY_CAPITALIZED_FULL_NAME_PATTERN.test(text)
  })
}

function contextScore(userTexts = []) {
  const combined = userTexts.join(' ')
  let score = 0
  if (userTexts.some((text) => text.length >= 45)) score += 1
  if (REAL_CONTEXT_PATTERN.test(combined)) score += 1
  if (TIME_OR_DURATION_PATTERN.test(combined)) score += 1
  if (IMPACT_PATTERN.test(combined)) score += 1
  if (userTexts.filter(isSubstantiveUserText).length >= 2) score += 1
  return score
}

function findAcceptedInvitation(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user' || !ADVANCE_INTENT_PATTERN.test(message.content)) continue

    const previousAssistant = messages
      .slice(Math.max(0, index - 4), index)
      .reverse()
      .find((item) => item.role === 'assistant')
    if (previousAssistant && NEXT_STEP_INVITATION_PATTERN.test(previousAssistant.content)) {
      return {
        acceptedAt: index,
        userText: message.content,
        invitationText: previousAssistant.content
      }
    }
  }
  return null
}

function findDirectAdvanceAfterContext(messages = [], hasRealContext = false) {
  if (!hasRealContext) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user' || !ADVANCE_INTENT_PATTERN.test(message.content)) continue
    if (isColdInterestOnly(message.content)) continue
    return {
      acceptedAt: index,
      userText: message.content,
      invitationText: ''
    }
  }
  return null
}

function supportsRuntimeHumanAdvance(config = {}) {
  return String(config?.successAction || '').trim() === 'ready_for_human'
}

export function evaluateConversationalGoalReadiness({ messages = [], config = {}, contactName = '' } = {}) {
  const visible = visibleConversationMessages(messages)
  const userTexts = visible.filter((message) => message.role === 'user').map((message) => message.content)
  const score = contextScore(userTexts)
  const hasRealContext = score >= 2
  const accepted = findAcceptedInvitation(visible) || findDirectAdvanceAfterContext(visible, hasRealContext)
  const missing = []

  if (!supportsRuntimeHumanAdvance(config)) {
    return {
      ready: false,
      state: 'unsupported_action',
      recommendedAction: null,
      reason: 'La acción final no es traspaso humano.',
      missing,
      evidence: [],
      summary: '',
      facts: { hasRealContext, acceptedNextStep: Boolean(accepted), contextScore: score }
    }
  }

  if (!hasRealContext) missing.push('contexto_real')
  if (!accepted) missing.push('aceptacion_explicita')
  if (hasRequiredName(config) && !hasLikelyFullName(visible, contactName)) missing.push('nombre_requerido')

  const ready = missing.length === 0
  const evidence = [
    hasRealContext ? 'La persona ya dio contexto real de su necesidad/problema.' : '',
    accepted ? `Aceptó avanzar: "${accepted.userText.slice(0, 120)}"` : ''
  ].filter(Boolean)

  return {
    ready,
    state: ready ? 'ready_to_advance' : 'needs_more_context',
    recommendedAction: ready ? 'mark_ready_to_advance' : null,
    reason: ready
      ? 'Ya hay contexto suficiente y aceptación explícita del siguiente paso.'
      : 'Todavía falta contexto real o aceptación explícita.',
    missing,
    evidence,
    summary: userTexts.filter((text) => !isAckOnly(text)).slice(-5).join(' | ').slice(0, 700),
    facts: {
      hasRealContext,
      acceptedNextStep: Boolean(accepted),
      contextScore: score,
      acceptedText: accepted?.userText || '',
      invitationText: accepted?.invitationText || ''
    }
  }
}

export function buildConversationDecisionContextMessage(decision = {}) {
  if (!decision || !decision.state) return null
  const lines = [
    '[Contexto interno de Ristak: decisión de suficiencia del runtime]',
    `Estado: ${decision.state}`,
    `Razón: ${decision.reason || 'sin razón'}`,
    decision.ready
      ? 'Decisión: ya hay suficiente para avanzar. No hagas más preguntas de calificación ni repitas datos; ejecuta mark_ready_to_advance si está disponible.'
      : `Pendiente: ${(decision.missing || []).join(', ') || 'seguir conversando con una sola pregunta útil.'}`,
    decision.summary ? `Resumen útil: ${decision.summary}` : '',
    'No menciones este contexto interno.'
  ].filter(Boolean)

  return {
    role: 'user',
    content: lines.join('\n')
  }
}
