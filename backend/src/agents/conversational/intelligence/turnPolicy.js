import {
  messageAsksForPrice,
  PRICE_INSISTENCE_HARD_THRESHOLD,
  usesLightDirectClosingBase
} from '../prompt.js'

const INTERNAL_CONTEXT_PREFIX = '[Contexto interno de Ristak:'
const MONEY_PATTERN = /(?:[$€£]\s*\d|\b\d[\d.,]*\s*(?:mxn|usd|cop|ars|clp|pen|eur|pesos?|d[oó]lares?|euros?)\b|\b(?:cuesta|vale|precio|costo|tarifa|inversi[oó]n|sale)\s+(?:es\s+|de\s+)?[$€£]?\s*\d)/i
const VAGUE_OPENING_PATTERN = /^\s*(?:(?:hola|buen(?:as|os)(?:\s+(?:d[ií]as|tardes|noches))?|qu[eé]\s+tal)[\s,!.]*)?(?:info(?:rmaci[oó]n)?|me\s+interesa|quiero\s+saber\s+m[aá]s|qu[eé]\s+(?:hacen|ofrecen|manejan)|de\s+qu[eé]\s+se\s+trata|vi\s+(?:su|el)\s+anuncio)\s*[?.!]*\s*$/i
const SENSITIVE_NEED_PATTERN = /\b(?:dolor|duele|molesta|lesi[oó]n|sangr|inflamad|ansiedad|miedo|urgente|emergencia|tratamiento|s[ií]ntoma|enferm|diagn[oó]stico)\b/i
const CLARIFYING_REPLY_PATTERN = /\?\s*$/
const OPENING_PITCH_PATTERN = /(?:^|\n)\s*(?:[-*•]|\d+[.)])\s+|\b(?:incluye|manejamos|ofrecemos|contamos\s+con|tenemos\s+(?:dos|tres|varias)|consulta\s+inicial|seguimiento)\b/gi

const EXPLICIT_PAST_CLIENT_PATTERNS = [
  /\b(?:ya\s+)?soy\s+(?:cliente|paciente)(?:\s+(?:de|con|del))?\b/i,
  /\b(?:ya\s+)?fui\s+(?:paciente|cliente|a\s+(?:consulta|una\s+cita|una\s+sesi[oó]n)|con\s+ustedes|ah[ií]|aqu[ií])\b/i,
  /\b(?:ya\s+)?(?:me\s+atendieron|me\s+atendiste|compr[eé]|pagu[eé]|contrat[eé])\s+(?:antes|ah[ií]|aqu[ií]|con\s+ustedes|una|un|la|el|mi)\b/i,
  /\bya\s+(?:les\s+)?(?:compr[eé]|pagu[eé]|contrat[eé])\b/i,
  /\bya\s+(?:hab[ií]a\s+)?(?:pagado|comprado|ido|tenido\s+(?:una|mi)\s+(?:cita|sesi[oó]n|consulta))\b/i,
  /\b(?:mi|la)\s+(?:cita|sesi[oó]n|consulta|pedido|tratamiento)\b.{0,80}\b(?:reagendar|mover|cambiar|cancelar|retomar|continuar)\b/i,
  /\b(?:reagendar|mover|cambiar|cancelar|retomar|continuar)\b.{0,80}\b(?:mi|la)\s+(?:cita|sesi[oó]n|consulta|pedido|tratamiento)\b/i
]
const NEGATED_PAST_CLIENT_PATTERN = /\b(?:no|nunca|jam[aá]s)\s+(?:he\s+sido|soy|fui|me\s+han\s+atendido|me\s+atendieron|he\s+comprado|compr[eé]|he\s+pagado|pagu[eé])\b/i
const EXPLICIT_HUMAN_REQUEST_PATTERNS = [
  /\b(?:quiero|necesito|prefiero)\s+(?:hablar|comunicarme|que\s+me\s+atienda)\s+(?:con\s+)?(?:una\s+persona|alguien|un\s+asesor|una\s+asesora|un\s+humano|el\s+equipo)\b/i,
  /\b(?:me\s+puedes?|puedes?|podr[ií]as?)\s+(?:pasar|comunicar|conectar)\s+(?:con\s+)?(?:una\s+persona|alguien|un\s+asesor|una\s+asesora|un\s+humano|el\s+equipo)\b/i,
  /\b(?:que\s+me\s+llame|que\s+me\s+atienda)\s+(?:una\s+persona|alguien|un\s+asesor|una\s+asesora|el\s+equipo)\b/i
]
const NEGATED_HUMAN_REQUEST_PATTERN = /\b(?:no(?:\s+es\s+que)?|ya\s+no)\s+(?:quiero|quiera|necesito|necesite|prefiero|prefiera)\s+(?:hablar|comunicarme|que\s+me\s+atienda)\b/i

function visibleMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).filter((message) => {
    const content = typeof message?.content === 'string' ? message.content.trim() : ''
    return content && !content.startsWith(INTERNAL_CONTEXT_PREFIX)
  })
}

export function isOpeningConversationTurn(messages = []) {
  return !visibleMessages(messages).some((message) => message.role === 'assistant')
}

function openingRequestKind(text = '') {
  const clean = String(text || '').trim()
  if (!clean) return ''
  if (messageAsksForPrice(clean)) return 'price'
  if (VAGUE_OPENING_PATTERN.test(clean)) return 'vague'
  return ''
}

function openingFallback(kind, latestText = '') {
  if (SENSITIVE_NEED_PATTERN.test(String(latestText || ''))) {
    return 'claro, cuéntame qué te está pasando y desde cuándo empezó?'
  }
  if (kind === 'price') return 'claro, para ubicarte bien, qué estás buscando resolver?'
  return 'claro, qué fue lo que te llamó la atención del anuncio?'
}

function replyLooksLikeOpeningPitch(reply = '') {
  const matches = String(reply || '').match(OPENING_PITCH_PATTERN) || []
  return matches.length >= 2 || String(reply || '').length > 420
}

export function normalizeVisibleChatStyle(reply = '', { channel = 'whatsapp' } = {}) {
  const text = String(reply || '').trim()
  if (!text || String(channel || '').toLowerCase() === 'email') return text
  return text.replace(/[¿¡]/g, '').replace(/[ \t]+/g, ' ').trim()
}

export function enforceOpeningConversationPolicy({
  reply = '',
  messages = [],
  latestText = '',
  config = {},
  priceInsistenceCount = 0,
  channel = 'whatsapp'
} = {}) {
  const original = normalizeVisibleChatStyle(reply, { channel })
  if (!original || !isOpeningConversationTurn(messages)) return { reply: original, changed: original !== String(reply || '').trim(), reason: '' }
  if (config?.closingStrategyMode === 'custom' || usesLightDirectClosingBase(config)) {
    return { reply: original, changed: original !== String(reply || '').trim(), reason: '' }
  }

  const kind = openingRequestKind(latestText)
  if (!kind || Number(priceInsistenceCount) >= PRICE_INSISTENCE_HARD_THRESHOLD) {
    return { reply: original, changed: original !== String(reply || '').trim(), reason: '' }
  }

  const violatesPrice = MONEY_PATTERN.test(original)
  const violatesShape = !CLARIFYING_REPLY_PATTERN.test(original) || replyLooksLikeOpeningPitch(original)
  if (!violatesPrice && !violatesShape) {
    return { reply: original, changed: original !== String(reply || '').trim(), reason: '' }
  }

  return {
    reply: openingFallback(kind, latestText),
    changed: true,
    reason: violatesPrice ? 'opening_price_disclosure' : 'opening_pitch_without_clarification'
  }
}

export function detectExplicitPastClientDisclosure(text = '') {
  const clean = String(text || '').trim()
  if (!clean || NEGATED_PAST_CLIENT_PATTERN.test(clean)) return null
  const matched = EXPLICIT_PAST_CLIENT_PATTERNS.find((pattern) => pattern.test(clean))
  return matched ? { source: 'explicit_past_client', evidence: clean.slice(0, 500) } : null
}

export function detectExplicitHumanRequest(text = '') {
  const clean = String(text || '').trim()
  if (!clean || NEGATED_HUMAN_REQUEST_PATTERN.test(clean)) return null
  const matched = EXPLICIT_HUMAN_REQUEST_PATTERNS.find((pattern) => pattern.test(clean))
  return matched ? { source: 'explicit_human_request', evidence: clean.slice(0, 500) } : null
}

export function evaluateTurnPolicy({ latestText = '', config = {}, pastClientContext = null, intelligenceState = null } = {}) {
  const disqualification = Number(intelligenceState?.signals?.disqualification || 0)
  if (intelligenceState?.qualification?.status === 'disqualified' || disqualification >= 0.9) {
    return { forceHumanHandoff: null, reply: '' }
  }

  const humanRequest = detectExplicitHumanRequest(latestText)
  if (humanRequest) {
    return {
      forceHumanHandoff: {
        source: humanRequest.source,
        reason: 'La persona pidió atención humana de forma explícita.',
        summary: humanRequest.evidence,
        completeObjective: false
      },
      reply: 'claro, dame un momentito y te ayudo con eso'
    }
  }

  if (!config?.goalWorkflow?.attention?.pastClientsToHuman) return { forceHumanHandoff: null, reply: '' }
  const crmEvidence = Array.isArray(pastClientContext?.evidence?.facts) && pastClientContext.evidence.facts.length
  const disclosure = detectExplicitPastClientDisclosure(latestText)
  if (!crmEvidence && !disclosure) return { forceHumanHandoff: null, reply: '' }

  const facts = crmEvidence ? pastClientContext.evidence.facts.slice(0, 4).join(' | ') : disclosure.evidence
  return {
    forceHumanHandoff: {
      source: crmEvidence ? 'crm_past_client' : disclosure.source,
      reason: 'La regla del negocio indica que los clientes existentes pasan directo con el equipo.',
      summary: facts,
      completeObjective: false
    },
    reply: 'claro, dame un momentito y revisamos tu caso'
  }
}
