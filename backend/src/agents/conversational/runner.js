import { Agent, Runner } from '@openai/agents'
import { db } from '../../config/database.js'
import { logger } from '../../utils/logger.js'
import { enforceComplianceGuard } from './complianceGuard.js'
import { DEFAULT_TIMEZONE, getAccountTimezone } from '../../utils/dateUtils.js'
import { getAccountLocaleSettings } from '../../utils/accountLocale.js'
import {
  buildBusinessProfilePromptParameters,
  getAIAgentConfig,
  getOpenAIApiKey,
  getBusinessProfileSnapshot
} from '../../services/aiAgentService.js'
import {
  startAgentRun,
  updateAgentRun,
  recordAgentStep,
  completeAgentRun
} from '../../services/agentExecutionLedgerService.js'
import {
  getConversationalAgentConfig,
  getConversationState,
  listConversationStatesForContact,
  buildConversationalAgentRuntimeConfig,
  ensureConversationalAgentRuntimeEnabledForPublishedAgents,
  recordConversationalAgentEvent,
  getConversationalAgent,
  listConversationalAgents,
  matchAgentForMessage,
  assignAgentToConversation,
  releaseAgentFromConversation,
  setConversationSignal,
  setConversationStatus,
  applyAgentCompletionAction,
  applyAgentSuccessExtras,
  buildRuleContext,
  entryRulesMatch,
  exitRulesMatch,
  contactIsOutOfScopeForAgent,
  isUnverifiedConversationAssignment,
  claimConversationInboundMessage,
  completeConversationInboundMessage,
  failConversationInboundMessage,
  runWithConversationStateChannel,
  normalizeConversationalPersuasionLevel,
  normalizeConversationalAgentModel,
  getAgentResponseDelayMs,
  getAgentFollowUpSteps,
  getAgentFollowUpStepDelayMs,
  normalizeAgentFollowUp,
  MAX_FOLLOW_UP_DELAY_MINUTES,
  getAgentReplyDeliveryPartDelayMs,
  normalizeAgentReplyDelivery,
  ADVANCED_CLOSING_CONTEXT_FIELDS
} from '../../services/conversationalAgentService.js'
import {
  normalizeConversationalAIProvider,
  resolveConversationalAIRuntime
} from '../../services/conversationalAIProviderService.js'
import { DEFAULT_OPENAI_MODEL } from '../../config/openAIModels.js'
import { tagNamesForIds } from '../../services/contactTagsService.js'
// (AI-002) Gate de licencia: el runtime del agente conversacional debe respetar
// la feature premium incluso cuando se dispara desde los servicios de mensajería.
import { hasFeature } from '../../services/licenseService.js'
import {
  buildClosingStrategyTemplateParameters,
  buildConversationalInstructions,
  countPriceInsistence,
  countSchedulingInsistence,
  getAccountRegionalLocaleTag,
  getClosingChannelLabel,
  hasConfiguredPriceDisclosureGate,
  PRICE_INSISTENCE_HARD_THRESHOLD
} from './prompt.js'
import { createConversationalTools } from './tools.js'
import { NON_LIVE_PAYMENT_MODES, SUCCESS_PAYMENT_STATUSES } from './actionEvidence.js'
import { buildInputItems } from '../runner.js'
import {
  splitMessageIntoBubbles,
  splitMessageIntoBubblesFallback
} from './messageSplitter.js'
import {
  buildConversationalMediaSummary,
  hydrateConversationalMessagesMedia,
  hydrateConversationalPreviewMessagesMedia
} from './mediaContext.js'
import {
  buildConversationDecisionContextMessage,
  evaluateConversationalGoalReadiness
} from './decisionState.js'
import {
  analyzeConversationIntelligence,
  applyStrategyPlan,
  buildApprovedLearningContextMessage,
  buildConversationIntelligenceContextMessage,
  compileConversationalAgentPolicy,
  finalizeConversationIntelligenceTurn,
  getApprovedConversationalLearning,
  loadConversationIntelligenceState,
  planConversationStrategy,
  retrieveRelevantBusinessKnowledge,
  saveConversationIntelligenceState
} from './intelligence/index.js'
import { sendConversationalAgentPriorityNotification } from '../../services/pushNotificationsService.js'

const HISTORY_LIMIT = 20
const MAX_TURNS = 10
const DEFAULT_MODEL = process.env.OPENAI_CONVERSATIONAL_AGENT_MODEL || DEFAULT_OPENAI_MODEL
const MAX_REPLY_CHARS = 1000
const DEBOUNCE_MS = 4000
const PENDING_INBOUND_LIMIT = 8
const PENDING_INBOUND_SCAN_LIMIT = 30
const PENDING_RECOVERY_PAGE_SIZE = 80
const PENDING_RECOVERY_MAX_AGE_MS = Number(process.env.CONVERSATIONAL_AGENT_PENDING_RECOVERY_MAX_AGE_MS || 60 * 60 * 1000)
const FOLLOW_UP_WINDOW_MS = MAX_FOLLOW_UP_DELAY_MINUTES * 60 * 1000
const MAX_TIMER_MS = 2_147_483_647
// Conversaciones que el agente está procesando ahora mismo (instancia única).
const runningContacts = new Set()
const pendingContactReruns = new Map()
const followUpTimers = new Map()

const CHAT_CONVERSATIONAL_CHANNELS = new Set(['whatsapp', 'instagram', 'messenger', 'sms', 'webchat', 'facebook_comment', 'instagram_comment'])
const SOCIAL_CHAT_CHANNELS = new Set(['instagram', 'messenger'])
// Canales de COMENTARIO (FB/IG): el agente responde con sendMetaSocialCommentReply,
// no con un DM. Se mantienen distintos de los canales de DM a propósito.
const COMMENT_CHAT_CHANNELS = new Set(['facebook_comment', 'instagram_comment'])
function commentChannelToPlatform(channel) {
  return channel === 'instagram_comment' ? 'instagram' : 'messenger'
}
function normalizeCommentReplyMode(value) {
  const v = String(value || '').trim().toLowerCase()
  return v === 'public' || v === 'private' || v === 'public_then_private' ? v : 'private'
}
// Extrae el modo de respuesta a comentarios de la condición de ingreso del agente
// que empató este canal de comentario (param.replyMode en la condición 'channel').
// Default 'private' (lo más seguro: mueve la conversación a DM).
function getCommentReplyModeForAgent(agentConfig, channel) {
  const groups = agentConfig?.filters?.entry?.groups || []
  for (const group of groups) {
    for (const cond of group?.conditions || []) {
      if (cond?.category !== 'channel') continue
      for (const param of cond?.params || []) {
        if (String(param?.value || '').trim().toLowerCase() === channel) {
          return normalizeCommentReplyMode(param.replyMode)
        }
      }
    }
  }
  return 'private'
}
const HIGHLEVEL_CHAT_CHANNELS = new Set(['instagram', 'messenger', 'sms', 'webchat'])
const HIGHLEVEL_WHATSAPP_TRANSPORTS = new Set(['ghl_whatsapp'])
const HIGHLEVEL_WHATSAPP_CHANNEL_ALIASES = new Set(['ghl_whatsapp'])
const SMS_TRANSPORTS = ['ghl_sms', 'sms', 'sms_qr', 'mms']
const WEBCHAT_TRANSPORTS = ['ghl_webchat', 'webchat', 'web_chat', 'chat_web', 'website_chat', 'site_chat']
const EMAIL_CONVERSATIONAL_CHANNEL = 'email'
const CONVERSATIONAL_CHANNEL_ALIASES = new Map([
  ['wa', 'whatsapp'],
  ['whatsapp_api', 'whatsapp'],
  ['api', 'whatsapp'],
  ['ghl_whatsapp', 'whatsapp'],
  ['fb', 'messenger'],
  ['facebook', 'messenger'],
  ['facebook_messenger', 'messenger'],
  ['ig', 'instagram'],
  ['instagram_dm', 'instagram'],
  ['sms_qr', 'sms'],
  ['ghl_sms', 'sms'],
  ['mms', 'sms'],
  ['ghl_webchat', 'webchat'],
  ['web_chat', 'webchat'],
  ['chat_web', 'webchat'],
  ['website_chat', 'webchat'],
  ['site_chat', 'webchat'],
  ['correo', 'email'],
  ['mail', 'email'],
  ['e-mail', 'email']
])
export const RECOVERABLE_CONVERSATIONAL_CHANNELS = ['whatsapp', 'instagram', 'messenger', 'sms', 'webchat', 'email']

// Palabras internas que jamás deben llegar al cliente final.
const INTERNAL_TOKEN_PATTERN = /\b(AGENDAR|SALTAR|ready_for_human|ready_to_schedule|ready_to_buy|purchase_completed|mark_ready_to_advance|send_to_human|discard_conversation|stay_silent|book_appointment|create_payment_link|send_goal_url|send_trigger_link)\b/gi
const INTERNAL_REASONING_LABEL_PATTERN = /^\s*(?:[-*]\s*)?(?:\*\*)?\s*(?:lectura|movimiento|textura|energ[ií]a|intenci[oó]n|an[aá]lisis|razonamiento|objetivo|decisi[oó]n|criterio|checklist|paso\s+[a-z0-9]+)\s*[:：-]\s*(?:\*\*)?/i
const INTERNAL_REASONING_MARKER_PATTERN = /(?:\*\*)?\s*(?:lectura|movimiento|textura|energ[ií]a|intenci[oó]n|an[aá]lisis|razonamiento|criterio|checklist)\s*[:：-]\s*(?:\*\*)?/i
const VISIBLE_REPLY_PREFIX_PATTERN = /^\s*(?:[-*]\s*)?(?:\*\*)?\s*(?:respuesta|mensaje)\s+(?:visible|final)\s*[:：-]\s*(?:\*\*)?\s*/i
const HARD_INTERNAL_META_PHRASES = [
  /\b(?:tengo|ya tengo|cuento con)\s+(?:el\s+)?contexto\s+del\s+negocio\b/i,
  /\bel contacto es (?:nuevo|fr[ií]o|tibio|caliente|neutral)\b/i,
  /\bahora voy a responder\b/i,
  /\bno voy a\b.*\b(?:soltar|dar|explicar|responder|valores|pitch)\b/i
]
const SOFT_INTERNAL_META_PHRASES = [
  /\bvoy a (?:regresar|devolver|soltar|aplicar|usar|espejear|mantener)\b/i,
  /\b(?:primer|siguiente) mensaje\b/i,
  /\b(?:la persona|el contacto) (?:est[aá]|viene|llega|dijo|no dijo|trae|se siente|pregunt[oó]|pidi[oó])\b/i,
  /\b(?:prospecto|interlocutor|estatus|pitch|pull|push|rebote|desarmad[oa]|sin ser mam[oó]n|registro profesional|registro alto|registro medio|registro bajo)\b/i,
  /\b(?:espejeo|espejear|espeja)\b/i,
  /\bsu sequedad\b/i,
  /\bvalores (?:de golpe|concretos)\b/i,
  /\bpregunta espec[ií]fica\b/i
]
const HUMAN_HANDOFF_ACTION_TYPES = new Set(['mark_ready_to_advance', 'send_to_human'])
const PRICE_DISCLOSURE_PATTERN = /(?:[$€£]\s*\d|\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?\s*(?:mxn|usd|d[oó]lares?|pesos?|euros?)\b|\b(?:cuesta|vale|valor|precio|costo|sale)\s+(?:es\s+)?(?:de\s+)?[$€£]?\s*\d)/i
const PRICE_QUALIFICATION_PATTERN = /\b(?:cu[eé]ntame|dime|comp[aá]rteme|para\s+(?:ubicar|darte|no\s+darte|cotizar|pasarte)|antes\s+de\s+(?:darte|pasarte)|qu[eé]\s+(?:buscas|necesitas|te\s+pasa|situaci[oó]n|quieres\s+resolver)|desde\s+cu[aá]ndo|c[oó]mo\s+te\s+(?:afecta|molesta|urge))\b/i
const HUMAN_HANDOFF_PROMISE_PATTERNS = [
  /\bte\s+paso\s+(?:con|al|a\s+un|a\s+una|para\s+(?:que|la\s+valoraci[oó]n|la\s+cita|agendar|confirmar|seguir))/i,
  /\b(?:pasarte|canalizarte|derivarte)\s+(?:con|al|a\s+un|a\s+una|para\s+(?:que|agendar|confirmar|seguir))/i,
  /\bte\s+(?:ayudan|apoyan|atienden|contactan|llaman|confirman|revisan)\b/i,
  /\b(?:el|nuestro|mi)\s+equipo\s+(?:te\s+)?(?:ayuda|apoya|atiende|contacta|llama|confirma|revisa|sigue|seguir[aá])\b/i,
  /\b(?:un|una)\s+(?:asesor|humano|persona|especialista|ejecutivo)\b.{0,80}\b(?:te\s+)?(?:ayuda|contacta|atiende|llama|confirma|revisa|sigue|seguir[aá])\b/i,
  /\b(?:queda|lo\s+dejo|lo\s+dejamos)\s+(?:pendiente\s+)?(?:con|para)\s+(?:el\s+)?(?:equipo|humano|asesor|persona)\b/i,
  /\b(?:seguir|continuar)\s+el\s+(?:agendado|proceso|tr[aá]mite)\b/i
]
const SCHEDULING_OR_PROCESS_QUESTION_PATTERNS = [
  /\b(?:queda|qued[oó]|est[aá])\s+(?:ya\s+)?(?:agendada|agendado|confirmada|confirmado)\b/i,
  /\b(?:cita|agenda|agendar|horario|hora|disponibilidad|turno|valoraci[oó]n)\b[^.!?]{0,120}\?/i,
  /\b(?:hoy|mañana|lunes|martes|mi[eé]rcoles|miercoles|jueves|viernes|s[aá]bado|sabado|domingo)\b[^.!?]{0,80}\b(?:\d{1,2}|am|pm|a\s+la|a\s+las|cita|hora)\b/i,
  /\b(?:a\s+la|a\s+las)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i,
  /\b(?:c[oó]mo\s+(?:la\s+)?solicito|d[oó]nde\s+me\s+recomienda|no\s+entiendo|me\s+revisar[aá]n\s+primero|primero\s+la\s+revisi[oó]n)\b/i
]

export function normalizeConversationalChannel(value = 'whatsapp') {
  const raw = String(value || '').trim().toLowerCase()
  const compact = raw.replace(/[\s-]+/g, '_')
  const channel = CONVERSATIONAL_CHANNEL_ALIASES.get(raw) || CONVERSATIONAL_CHANNEL_ALIASES.get(compact) || compact || 'whatsapp'
  return CHAT_CONVERSATIONAL_CHANNELS.has(channel) || channel === EMAIL_CONVERSATIONAL_CHANNEL ? channel : 'whatsapp'
}

function isEmailConversationalChannel(channel) {
  return normalizeConversationalChannel(channel) === EMAIL_CONVERSATIONAL_CHANNEL
}

function getRunKey(contactId, channel = 'whatsapp') {
  return `${normalizeConversationalChannel(channel)}:${contactId}`
}

function normalizeTransportKey(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function isHighLevelMessageSource(message = {}) {
  const provider = normalizeTransportKey(message?.provider)
  const source = normalizeTransportKey(message?.source)
  const transport = normalizeTransportKey(message?.transport)
  return provider === 'highlevel' || source === 'conversations_sync' || transport.startsWith('ghl_')
}

export function shouldSendConversationalReplyThroughHighLevel({ channel = 'whatsapp', latest = {} } = {}) {
  const rawChannel = normalizeTransportKey(channel || latest?.channel)
  const normalizedChannel = normalizeConversationalChannel(channel || latest?.channel)
  if (HIGHLEVEL_CHAT_CHANNELS.has(normalizedChannel)) {
    return isHighLevelMessageSource(latest) || rawChannel.startsWith('ghl_')
  }
  return normalizedChannel === 'whatsapp' && (
    HIGHLEVEL_WHATSAPP_TRANSPORTS.has(normalizeTransportKey(latest?.transport)) ||
    HIGHLEVEL_WHATSAPP_CHANNEL_ALIASES.has(rawChannel)
  )
}

function getHighLevelReplyChannel({ channel = 'whatsapp', latest = {} } = {}) {
  const normalizedChannel = normalizeConversationalChannel(channel || latest?.channel)
  if (normalizedChannel === 'sms') return 'sms_qr'
  if (normalizedChannel === 'whatsapp') return 'whatsapp_api'
  return normalizedChannel
}

function getEmailSubjectForReply(latest = {}) {
  const cleanSubject = String(latest.subject || '').trim()
  if (!cleanSubject) return 'Seguimiento'
  return /^re:/i.test(cleanSubject) ? cleanSubject : `Re: ${cleanSubject}`
}

function formatEmailMessageText(row = {}) {
  const subject = String(row.subject || '').trim()
  const text = String(row.message_text || row.content || '').trim()
  if (subject && text) return `Asunto: ${subject}\n${text}`
  if (subject) return `Asunto: ${subject}`
  return text
}

function phoneMessageTransportFilter(channel = 'whatsapp') {
  const normalizedChannel = normalizeConversationalChannel(channel)
  if (normalizedChannel === 'sms') {
    return `AND LOWER(COALESCE(transport, '')) IN (${SMS_TRANSPORTS.map((item) => `'${item}'`).join(', ')})`
  }
  if (normalizedChannel === 'webchat') {
    return `AND LOWER(COALESCE(transport, '')) IN (${WEBCHAT_TRANSPORTS.map((item) => `'${item}'`).join(', ')})`
  }
  return `AND LOWER(COALESCE(transport, '')) NOT IN (${[...SMS_TRANSPORTS, ...WEBCHAT_TRANSPORTS].map((item) => `'${item}'`).join(', ')})`
}

export function shouldIncludeConversationalBinaryMedia({ runtime } = {}) {
  return runtime?.supportsMultimodalInputs === true
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// (AI-009) Helpers de persistencia del debounce/delay de reruns. pendingContactReruns
// es un Map volátil: si el proceso reinicia mientras hay un rerun encolado se perdía.
// Reflejamos cada alta/baja en la tabla ai_agent_pending_reruns (migración 012) para
// reconstruirlo al boot. Tolerante a fallos: nunca tumba el flujo principal del agente.
function nowSqlTimestamp() {
  return new Date().toISOString()
}

async function persistPendingRerun(runKey, entry = {}) {
  if (!runKey) return
  try {
    const contactId = entry.contactId != null ? String(entry.contactId) : null
    const channel = entry.channel ? normalizeConversationalChannel(entry.channel) : null
    const scheduledFor = entry.scheduledFor || nowSqlTimestamp()
    const payload = JSON.stringify({
      contactId,
      channel,
      phone: entry.phone || null,
      messageId: entry.messageId != null ? String(entry.messageId) : null
    })
    await db.run(`
      INSERT INTO ai_agent_pending_reruns (run_key, contact_id, channel, scheduled_for, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_key) DO UPDATE SET
        contact_id = excluded.contact_id,
        channel = excluded.channel,
        scheduled_for = excluded.scheduled_for,
        payload = excluded.payload
    `, [runKey, contactId, channel, scheduledFor, payload, nowSqlTimestamp()])
  } catch (error) {
    logger.warn(`[Agente conversacional] No se pudo persistir rerun pendiente (${runKey}): ${error.message}`)
  }
}

async function deletePendingRerun(runKey) {
  if (!runKey) return
  try {
    await db.run('DELETE FROM ai_agent_pending_reruns WHERE run_key = ?', [runKey])
  } catch (error) {
    logger.warn(`[Agente conversacional] No se pudo borrar rerun pendiente (${runKey}): ${error.message}`)
  }
}

function toTimestampMs(value) {
  if (!value) return 0
  if (value instanceof Date) return value.getTime()
  const raw = String(value).trim()
  if (!raw) return 0
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : 0
}

export function shouldRecoverPendingInbound(latestMessage, state, {
  nowMs = Date.now(),
  maxAgeMs = PENDING_RECOVERY_MAX_AGE_MS
} = {}) {
  if (!latestMessage?.id) return false
  if (state?.status && state.status !== 'active') return false
  if (state?.lastAnsweredInboundMessageId === latestMessage.id || state?.last_answered_inbound_message_id === latestMessage.id) {
    return false
  }

  const processingMessageId = state?.inboundProcessingMessageId || state?.inbound_processing_message_id || null
  const processingStatus = state?.inboundProcessingStatus || state?.inbound_processing_status || null
  const processingLeaseUntilMs = toTimestampMs(
    state?.inboundProcessingLeaseUntilAt || state?.inbound_processing_lease_until_at
  )
  if (processingStatus === 'processing' && processingLeaseUntilMs > nowMs) return false
  if (processingMessageId === latestMessage.id && processingStatus === 'completed') return false
  if (
    processingMessageId === latestMessage.id &&
    (processingStatus === 'failed' || (processingStatus === 'processing' && processingLeaseUntilMs <= nowMs))
  ) {
    return true
  }

  const messageMs = toTimestampMs(
    latestMessage.message_timestamp ||
    latestMessage.messageTimestamp ||
    latestMessage.created_at ||
    latestMessage.createdAt
  )
  if (!messageMs) return false
  if (maxAgeMs > 0 && nowMs - messageMs > maxAgeMs) return false

  const lastReplyMs = toTimestampMs(state?.lastReplyAt || state?.last_reply_at)
  return !lastReplyMs || messageMs > lastReplyMs
}

export function sanitizeAgentReply(text) {
  let reply = String(text || '').trim()
  if (!reply) return ''
  reply = reply.replace(INTERNAL_TOKEN_PATTERN, '').replace(/\[[^\]]*herramienta[^\]]*\]/gi, '')
  reply = removeInternalReasoningBlocks(reply)
  reply = reply.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if ((reply.startsWith('"') && reply.endsWith('"')) || (reply.startsWith('“') && reply.endsWith('”'))) {
    reply = reply.slice(1, -1).trim()
  }
  if (reply.length > MAX_REPLY_CHARS) {
    reply = `${reply.slice(0, MAX_REPLY_CHARS - 1).trim()}…`
  }
  return reply
}

function normalizeActionType(action = {}) {
  return String(action?.type || action?.name || '').trim()
}

function hasActionType(actions = [], types = HUMAN_HANDOFF_ACTION_TYPES) {
  return Array.isArray(actions) && actions.some((action) => types.has(normalizeActionType(action)))
}

export function replySuggestsHumanHandoff(reply = '') {
  const text = String(reply || '').trim()
  if (!text) return false
  return HUMAN_HANDOFF_PROMISE_PATTERNS.some((pattern) => pattern.test(text))
}

function runtimePriceGuardApplies(config = {}) {
  return hasConfiguredPriceDisclosureGate(
    config?.extraInstructions,
    config?.closingStrategyMode === 'custom' ? config?.closingStrategyCustom : ''
  )
}

export function rewritePrematurePriceDisclosure(reply = '', config = {}, { priceInsistenceCount = 0 } = {}) {
  const text = String(reply || '').trim()
  if (!text || !runtimePriceGuardApplies(config)) return text
  // Regla de la casa: a la tercera petición de precio ya no se torea al contacto;
  // soltar el dato deja de ser "prematuro" y este guard no debe borrarlo.
  if (Number(priceInsistenceCount) >= PRICE_INSISTENCE_HARD_THRESHOLD) return text
  if (!PRICE_DISCLOSURE_PATTERN.test(text) || !PRICE_QUALIFICATION_PATTERN.test(text)) return text
  return 'Claro, para darte un valor que sí aplique, cuéntame tantito qué estás buscando resolver?'
}

export function shouldEscalateSilentSchedulingQuestion(latestText = '', actions = []) {
  if (!hasActionType(actions, new Set(['stay_silent']))) return false
  const text = String(latestText || '').trim()
  if (!text) return false
  return SCHEDULING_OR_PROCESS_QUESTION_PATTERNS.some((pattern) => pattern.test(text))
}

export function applyConversationalRuntimeReplyGuard({
  reply = '',
  latestText = '',
  actions = [],
  config = {},
  readiness = null,
  suppressReply = false,
  priceInsistenceCount = 0
} = {}) {
  let nextReply = String(reply || '').trim()
  let nextSuppressReply = Boolean(suppressReply)
  const events = []
  // [Fase 0 — anti-ghosting] Se retiraron los traspasos a humano FORZADOS por heurística:
  //  1) readiness "suficiente" (marcaba objetivo cumplido + silencio antes de tiempo),
  //  2) pregunta de agenda con stay_silent (mandaba "te paso con el equipo" + mute),
  //  3) la regex replySuggestsHumanHandoff (frases normales como "te ayudan a agendar" o
  //     "te confirman" forzaban un pase que dejaba al bot MUDO para siempre).
  // Todos disparaban falsos positivos y ghosting en el momento de convertir. El traspaso
  // ahora SOLO lo decide el modelo con sus tools explícitas (send_to_human /
  // mark_ready_to_advance). La señal de readiness sigue llegando al modelo como HINT
  // (buildConversationDecisionContextMessage), no como acción terminal.
  const priceGuardReply = rewritePrematurePriceDisclosure(nextReply, config, { priceInsistenceCount })
  if (priceGuardReply !== nextReply) {
    nextReply = priceGuardReply
    events.push({ type: 'runtime_price_guard_rewrite' })
  }

  return {
    reply: nextReply,
    suppressReply: nextSuppressReply,
    forceHumanHandoff: null,
    events
  }
}

async function recordRuntimeReplyGuardEvents({ contactId, latest, agentConfig, channel, events = [], forceHumanHandoff = null } = {}) {
  if (!contactId || !events.length) return
  await recordConversationalAgentEvent({
    contactId,
    eventType: 'runtime_reply_guard',
    detail: {
      messageId: latest?.id || null,
      agentId: agentConfig?.id || null,
      channel: normalizeConversationalChannel(channel || latest?.channel),
      events: events.map((event) => event.type),
      forcedHuman: Boolean(forceHumanHandoff),
      source: forceHumanHandoff?.source || null
    }
  }).catch((error) => {
    logger.warn(`[Agente conversacional] No se pudo registrar runtime_reply_guard: ${error.message}`)
  })
}

async function forceRuntimeHumanHandoff({ contactId, agentConfig, latest, channel, ctx, handoff } = {}) {
  if (!contactId || !handoff) return null
  const reason = String(handoff.reason || 'El runtime detecto que el caso requiere humano.').trim()
  const summary = String(handoff.summary || '').trim()
  const signal = 'ready_for_human'
  const completeObjective = handoff.completeObjective === true
  const action = {
    type: completeObjective ? 'runtime_mark_ready_to_advance' : 'runtime_send_to_human',
    motivo: reason,
    source: handoff.source || 'runtime_guard',
    effect: {
      liveEffect: completeObjective
        ? 'MARCA el objetivo como cumplido por suficiencia de contexto y pasa el chat a humano.'
        : 'Pasa el chat a humano por candado de runtime. NO marca el objetivo como cumplido.',
      marksObjectiveCompleted: completeObjective
    }
  }
  if (Array.isArray(ctx?.actions)) ctx.actions.push(action)

  await setConversationSignal(contactId, signal, {
    reason,
    summary,
    status: completeObjective ? 'completed' : 'human',
    agentId: agentConfig?.id || '',
    channel: normalizeConversationalChannel(channel || latest?.channel)
  })
  if (completeObjective) {
    await applyAgentCompletionAction(agentConfig || {}, contactId)
  }

  try {
    const result = await sendConversationalAgentPriorityNotification({ contactId, reason, summary, signal })
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'priority_push_notification',
      detail: { signal, sent: result?.sent || 0, skipped: Boolean(result?.skipped), reason: result?.reason || null, source: 'runtime_guard' }
    })
  } catch (error) {
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'priority_push_notification_failed',
      detail: { signal, error: error.message, source: 'runtime_guard' }
    })
  }

  await recordConversationalAgentEvent({
    contactId,
    eventType: 'runtime_human_handoff_forced',
    detail: {
      messageId: latest?.id || null,
      agentId: agentConfig?.id || null,
      channel: normalizeConversationalChannel(channel || latest?.channel),
      reason,
      source: handoff.source || 'runtime_guard'
    }
  })
  if (completeObjective) {
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'objective_completed',
      detail: {
        agentId: agentConfig?.id || null,
        signal,
        kind: 'ready_for_human',
        intencionDetectada: reason,
        urgencia: null,
        siguientePaso: null,
        source: handoff.source || 'runtime_guard'
      }
    })
    await applyAgentSuccessExtras(agentConfig || {}, contactId)
  }
  return action
}

function buildRuntimeReadyToAdvanceReply() {
  return 'Perfecto, ya con eso te paso con el equipo para que te confirmen el siguiente paso.'
}

export async function waitForConversationalResponseWindow({
  contactId,
  latest,
  agentConfig,
  channel = 'whatsapp',
  delayMs = 0,
  wait = sleep,
  loadLatest = loadLatestInboundMessage,
  recordEvent = recordConversationalAgentEvent,
  onNewerInbound = null
} = {}) {
  const normalizedChannel = normalizeConversationalChannel(channel || latest?.channel)
  const ms = Math.max(0, Number(delayMs || 0))
  if (!latest?.id || ms <= 0) {
    return { latest: latest || null, delayed: false, absorbedNewerInbound: false }
  }

  await recordEvent({
    contactId,
    eventType: 'reply_wait_started',
    detail: {
      messageId: latest.id,
      agentId: agentConfig?.id || null,
      channel: normalizedChannel,
      delayMs: ms,
      phase: 'before_agent_run'
    }
  })
  await wait(ms)

  const nextLatest = await loadLatest(contactId, normalizedChannel)
  if (!nextLatest) return { latest: null, delayed: true, absorbedNewerInbound: false }
  if (nextLatest.id === latest.id) {
    return { latest, delayed: true, absorbedNewerInbound: false }
  }

  if (typeof onNewerInbound === 'function') {
    await onNewerInbound(nextLatest)
  }
  await recordEvent({
    contactId,
    eventType: 'reply_wait_collected_inbound',
    detail: {
      originalMessageId: latest.id,
      messageId: nextLatest.id,
      agentId: agentConfig?.id || null,
      channel: normalizedChannel,
      delayMs: ms
    }
  })
  return { latest: nextLatest, delayed: true, absorbedNewerInbound: true }
}

function isInternalReasoningBlock(value) {
  const block = String(value || '').trim()
  if (!block) return false
  if (INTERNAL_REASONING_LABEL_PATTERN.test(block) || INTERNAL_REASONING_MARKER_PATTERN.test(block)) return true
  if (HARD_INTERNAL_META_PHRASES.some((pattern) => pattern.test(block))) return true
  let score = 0
  for (const pattern of SOFT_INTERNAL_META_PHRASES) {
    if (pattern.test(block)) score += 1
  }
  return score >= 2
}

function cleanVisibleReplyBlock(value) {
  const block = String(value || '').trim()
  if (!block) return ''
  const visibleMatch = block.match(VISIBLE_REPLY_PREFIX_PATTERN)
  if (visibleMatch) return block.slice(visibleMatch[0].length).trim()
  if (isInternalReasoningBlock(block)) return ''
  return block
}

function removeInternalReasoningBlocks(text) {
  const blocks = String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{1,}/)
    .map((block) => cleanVisibleReplyBlock(block))
    .filter(Boolean)

  return blocks.join('\n').trim()
}

function cleanMessageText(row) {
  const text = String(row?.message_text || row?.content || '').trim()
  const mediaSummary = buildConversationalMediaSummary(row)
  if (text && mediaSummary) return `${text}\n${mediaSummary}`
  return text ||
    mediaSummary ||
    (row?.message_type && row.message_type !== 'text' ? `[${row.message_type} sin texto]` : '') ||
    '(mensaje vacío)'
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

function compactText(value, maxLength = 600) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function formatMoney(amount, currency = 'MXN') {
  const numeric = Number(amount)
  if (!Number.isFinite(numeric)) return ''
  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: String(currency || 'MXN').toUpperCase(),
      maximumFractionDigits: 2
    }).format(numeric)
  } catch {
    return `${numeric} ${currency || 'MXN'}`
  }
}

function firstText(...values) {
  return values.map((value) => compactText(value)).find(Boolean) || ''
}

function getChannelLabel(channel = 'whatsapp') {
  return getClosingChannelLabel(channel)
}

function summarizeProducts(rows = []) {
  const products = []
  const seen = new Set()
  for (const row of rows) {
    const name = compactText(row.name, 80)
    if (!name || seen.has(row.id || name)) continue
    seen.add(row.id || name)
    const value = row.amount !== null && row.amount !== undefined
      ? ` (${formatMoney(row.amount, row.currency)})`
      : ''
    products.push(`${name}${value}`)
  }
  return products.slice(0, 6).join(', ')
}

function summarizeLocation(location = {}) {
  const parts = [
    location?.address,
    location?.city,
    location?.state,
    location?.country
  ].map((item) => compactText(item, 80)).filter(Boolean)
  return parts.join(', ')
}

function summarizeBusinessInfo({ businessContext, businessName, location, productSummary, businessProfile = null }) {
  const profileSummary = compactText(businessProfile?.summary, 1800)
  const parts = [
    businessName ? `Negocio: ${businessName}` : '',
    profileSummary ? `Perfil estructurado: ${profileSummary}` : '',
    productSummary ? `Servicios/productos: ${productSummary}` : '',
    summarizeLocation(location) ? `Ubicación: ${summarizeLocation(location)}` : '',
    compactText(businessContext, 1000)
  ].filter(Boolean)
  return parts.join(' · ')
}

// [Fase 2 — base de conocimiento] La info del negocio es UN solo texto libre que el dueño
// llena en configuración (el campo "información del negocio" del chatbot). Esa es la única
// fuente de verdad; NO dependemos de extraer campos estructurados ni de un formulario aparte.
// Se inyecta con la regla anti-invención: el bot responde dirección/horarios/precios/pagos SOLO
// si están en ese texto, y para lo que no aparezca, ofrece confirmarlo en vez de inventarlo.
// Genérico para cualquier giro.
function buildBusinessInfoGroundingRule() {
  return [
    'INFORMACIÓN DEL NEGOCIO (tu única fuente de verdad para datos).',
    'Todo lo que sabes del negocio sale ÚNICAMENTE del texto de abajo: dirección, horarios, precios, formas de pago, servicios, requisitos, promociones, cobertura, lo que sea.',
    'Si te preguntan un dato que SÍ está en este texto, respóndelo tal cual. Si te preguntan algo que NO aparece aquí, NO lo inventes ni lo supongas: dile a la persona que se lo confirmas en un momento.'
  ].join('\n')
}

export function buildRuntimeBusinessContext(rawContext = '', businessProfile = null) {
  const primary = compactText(businessProfile?.sourceContext, 5000) || compactText(rawContext, 5000)
  const summary = businessProfile?.configured ? compactText(businessProfile?.summary, 2000) : ''
  const parts = []
  if (primary) parts.push(primary)
  if (summary && (!primary || !primary.includes(summary))) parts.push(`Resumen del negocio:\n${summary}`)
  const infoText = parts.join('\n\n').trim()
  if (!infoText) return ''
  return `${buildBusinessInfoGroundingRule()}\n\n${infoText}`
}

async function loadAdvancedClosingRuntimeContext({
  contactId,
  config,
  businessName,
  businessContext,
  businessProfile = null,
  timezone,
  nowIso,
  accountLocale = {},
  channel = 'whatsapp',
  ruleContext = null
} = {}) {
  if (config?.closingStrategyMode === 'custom') return { enabled: false }

  const [contact, state, products, calendars, hlRow] = await Promise.all([
    contactId ? db.get(`
      SELECT id, full_name, first_name, last_name, phone, email, source, tags,
             purchases_count, total_paid, created_at, updated_at,
             attribution_session_source, attribution_medium, attribution_ad_name,
             attribution_ad_id, visitor_id, ghl_contact_id, preferred_whatsapp_phone_number_id
      FROM contacts WHERE id = ?
    `, [contactId]).catch(() => null) : null,
	    contactId ? db.get(
	      `SELECT closing_context_json
	       FROM conversational_agent_state
	       WHERE contact_id = ? AND agent_id = ?
	         AND COALESCE(NULLIF(channel, ''), 'whatsapp') = ?
	       LIMIT 1`,
	      [contactId, config?.id || null, normalizeConversationalChannel(channel)]
	    ).catch(() => null) : null,
    db.all(`
      SELECT p.id, p.name, pp.amount, pp.currency
      FROM products p
      LEFT JOIN product_prices pp ON pp.product_id = p.id
      WHERE p.is_active = 1
      ORDER BY p.name ASC
      LIMIT 40
    `).catch(() => []),
    db.all('SELECT id, name FROM calendars WHERE is_active = 1 ORDER BY name ASC LIMIT 10').catch(() => []),
    db.get('SELECT location_data FROM highlevel_config LIMIT 1').catch(() => null)
  ])

  let location = null
  try {
    location = hlRow?.location_data ? JSON.parse(hlRow.location_data) : null
  } catch { /* sin perfil */ }

  const storedTags = safeJsonParse(contact?.tags, [])
  const tagNames = Array.isArray(storedTags) && storedTags.length
    ? await tagNamesForIds(storedTags).catch(() => storedTags)
    : []
  const learned = safeJsonParse(state?.closing_context_json, {})
  const productSummary = summarizeProducts(products)
  const locationSummary = summarizeLocation(location)
  const profileParameters = businessProfile?.configured
    ? buildBusinessProfilePromptParameters(businessProfile.profile, businessProfile.promptParameters)
    : {}
  const profileBusinessName = firstText(profileParameters.NOMBRE_DEL_NEGOCIO, businessProfile?.businessName)
  const profileIndustry = firstText(profileParameters.INDUSTRIA, businessProfile?.industry)
  const profileOffering = firstText(profileParameters.PRODUCTO_O_SERVICIO, businessProfile?.offeringsSummary)
  const profileValue = firstText(profileParameters.VALOR, businessProfile?.pricingSummary)
  const profileLocation = firstText(profileParameters.UBICACION_O_MODALIDAD, businessProfile?.locationSummary)
  const profileAvailability = firstText(profileParameters.DISPONIBILIDAD)
  const profileConditions = firstText(profileParameters.CONDICIONES_IMPORTANTES, businessProfile?.paymentSummary, businessProfile?.contactSummary)
  const channelLabel = getChannelLabel(channel)
  const cameFromAd = ruleContext?.cameFromAd || Boolean(contact?.attribution_ad_name || contact?.attribution_ad_id)
  const arrivalSource = firstText(
    learned.arrivalSource,
    contact?.source,
    contact?.attribution_session_source,
    cameFromAd ? 'anuncio de Meta/WhatsApp' : '',
    channelLabel
  )
  const personType = Number(contact?.purchases_count || 0) > 0 || Number(contact?.total_paid || 0) > 0
    ? 'cliente'
    : 'prospecto'
  const conditions = [
    config?.requiredData ? `Datos minimos: ${config.requiredData}` : '',
    config?.handoffRules ? `Reglas de humano: ${config.handoffRules}` : '',
    config?.extraInstructions ? `Instrucciones extra: ${config.extraInstructions}` : ''
  ].map((item) => compactText(item, 700)).filter(Boolean).join(' · ')
  const availability = calendars.length
    ? `consulta disponibilidad real con list_calendars/get_free_slots; calendarios activos: ${calendars.map((calendar) => calendar.name || calendar.id).filter(Boolean).slice(0, 5).join(', ')}`
    : 'consulta disponibilidad real con list_calendars/get_free_slots antes de proponer horarios'

  const businessInfoSummary = summarizeBusinessInfo({
    businessContext,
    businessName: firstText(profileBusinessName, businessName),
    location,
    productSummary: firstText(profileOffering, productSummary),
    businessProfile
  })
  const adaptationPromptParameters = businessProfile?.configured
    ? profileParameters
    : buildBusinessProfilePromptParameters({
      businessName: firstText(profileBusinessName, businessName),
      industry: profileIndustry,
      description: businessInfoSummary || businessContext,
      offerings: firstText(profileOffering, productSummary) ? [{ name: firstText(profileOffering, productSummary) }] : [],
      locations: firstText(profileLocation, locationSummary) ? [{ modality: firstText(profileLocation, locationSummary) }] : [],
      hours: profileAvailability ? { summary: profileAvailability } : {},
      payments: profileConditions ? { summary: profileConditions } : {},
      importantConditions: profileConditions
    })
  const businessConditions = [
    profileConditions,
    conditions
  ].map((item) => compactText(item, 900)).filter(Boolean).join(' · ')
  const fullAvailability = [
    profileAvailability,
    availability
  ].map((item) => compactText(item, 700)).filter(Boolean).join(' · ')

  const parameters = buildClosingStrategyTemplateParameters({
    profileParameters,
    adaptationParameters: adaptationPromptParameters,
    config,
    businessName: firstText(profileBusinessName, businessName, 'este negocio'),
    industry: firstText(profileIndustry, businessContext ? 'la industria descrita en el perfil estructurado del negocio' : 'no especificada'),
    offering: firstText(learned.productInterest, profileOffering, productSummary, 'los servicios del negocio'),
    personType,
    channelLabel,
    businessInfo: businessInfoSummary || 'consulta get_business_profile y list_products para información real del negocio',
    value: firstText(profileValue, productSummary, 'consulta list_products antes de hablar de valor'),
    location: firstText(profileLocation, locationSummary, 'modalidad no especificada; consulta get_business_profile si hace falta'),
    availability: fullAvailability || availability,
    conditions: businessConditions || 'sin condiciones adicionales configuradas',
    learned,
    contact,
    tagNames,
    arrivalSource,
    accountLocale
  })

  const systemFacts = [
    `Canal detectado: ${channelLabel}`,
    contact?.created_at ? `Contacto registrado: ${contact.created_at}` : '',
    contact?.full_name ? `Nombre registrado: ${contact.full_name}` : '',
    contact?.phone ? `Teléfono registrado: ${contact.phone}` : '',
    contact?.email ? `Email registrado: ${contact.email}` : '',
    tagNames.length ? `Etiquetas: ${tagNames.join(', ')}` : '',
    contact?.source ? `Fuente del contacto: ${contact.source}` : '',
    contact?.attribution_session_source ? `Atribucion/source: ${contact.attribution_session_source}` : '',
    contact?.attribution_medium ? `Atribucion/medium: ${contact.attribution_medium}` : '',
    contact?.attribution_ad_name || contact?.attribution_ad_id ? `Anuncio detectado: ${[contact.attribution_ad_name, contact.attribution_ad_id].filter(Boolean).join(' / ')}` : '',
    ruleContext?.businessPhoneNumberId ? `Número de WhatsApp del negocio: ${ruleContext.businessPhoneNumberId}` : '',
    productSummary ? `Productos/servicios activos: ${productSummary}` : '',
    businessProfile?.summary ? `Perfil estructurado del negocio: ${businessProfile.summary}` : '',
    locationSummary ? `Ubicación registrada: ${locationSummary}` : '',
    parameters.PAIS_CUENTA ? `País/región textual de la cuenta: ${parameters.PAIS_CUENTA}` : '',
    `Zona horaria: ${timezone}`,
    `Fecha/hora para interpretar relativos: ${nowIso}`
  ].map((item) => compactText(item, 700)).filter(Boolean)

  const missingFields = ADVANCED_CLOSING_CONTEXT_FIELDS
    .map((field) => field.key)
    .filter((key) => !compactText(learned?.[key]))

  return {
    enabled: true,
    parameters,
    systemFacts,
    learned,
    missingFields
  }
}

export function splitReplyIntoParts(reply, deliveryInput = {}) {
  return splitMessageIntoBubblesFallback({
    text: reply,
    settings: deliveryInput?.replyDelivery || deliveryInput
  }).messages
}

export function buildReplyPartDelaySchedule(parts = [], agentConfig = {}) {
  const count = Array.isArray(parts) ? parts.length : 0
  return Array.from({ length: count }, (_, index) => {
    return index === 0 ? 0 : getAgentReplyDeliveryPartDelayMs(agentConfig)
  })
}

export function buildPendingReplyContextMessage(pendingMessages = []) {
  const lines = (Array.isArray(pendingMessages) ? pendingMessages : [])
    .map((message, index) => {
      const text = cleanMessageText(message).slice(0, 700)
      return `${index + 1}. ${text}`
    })
    .filter(Boolean)

  if (!lines.length) return null

  return {
    role: 'user',
    content: [
      '[Contexto interno de Ristak: mensajes entrantes pendientes sin respuesta completa]',
      'Estos mensajes todavía deben tomarse en cuenta como parte de la siguiente respuesta visible del agente.',
      'Responde considerando TODOS, no sólo el último. Si el último mensaje corrige o agrega información, prioriza lo más reciente.',
      'Si ya existe una respuesta parcial del agente en el historial, continúa de forma natural sin repetirla literal.',
      'No menciones este contexto interno.',
      ...lines
    ].join('\n')
  }
}

function rowToConversationalMessage(row, channel = 'whatsapp') {
  const normalizedChannel = normalizeConversationalChannel(channel)
  const direction = String(row.direction || '').toLowerCase()
  const rawPayload = safeJsonParse(row.raw_payload_json, {})
  const provider = String(row.provider || rawPayload?.provider || '').trim()
  const source = String(row.source || rawPayload?.source || '').trim()
  const transport = String(
    row.transport ||
    rawPayload?.transport ||
    ((provider === 'highlevel' || source === 'conversations_sync') ? `ghl_${normalizedChannel}` : '')
  ).trim()
  const role = direction === 'outbound' || direction === 'business_echo' || direction === 'sent'
    ? 'assistant'
    : 'user'
  const content = normalizedChannel === EMAIL_CONVERSATIONAL_CHANNEL
    ? formatEmailMessageText(row)
    : String(row.message_text || row.content || '').trim()

  return {
    id: row.id,
    role,
    content,
    message_type: row.message_type || (normalizedChannel === EMAIL_CONVERSATIONAL_CHANNEL ? 'email' : 'text'),
    media_url: row.media_url,
    media_mime_type: row.media_mime_type,
    media_filename: row.media_filename,
    media_duration_ms: row.media_duration_ms,
    subject: row.subject || null,
    provider: provider || null,
    source: source || null,
    transport: transport || null,
    phone: row.phone || null,
    business_phone: row.business_phone || null,
    business_phone_number_id: row.business_phone_number_id || null,
    from_email: row.from_email || null,
    to_email: row.to_email || null,
    reply_to: row.reply_to || null,
    channel: normalizedChannel,
    message_timestamp: row.message_timestamp || null,
    messageTimestamp: row.message_timestamp || row.created_at || null,
    created_at: row.created_at || null,
    createdAt: row.created_at || null,
    timestamp: row.message_timestamp || row.created_at || null
  }
}

async function loadConversationRows(contactId, channel = 'whatsapp', { inboundOnly = false, limit = HISTORY_LIMIT } = {}) {
  const normalizedChannel = normalizeConversationalChannel(channel)
  if (COMMENT_CHAT_CHANNELS.has(normalizedChannel)) {
    const platform = commentChannelToPlatform(normalizedChannel)
    const rows = await db.all(`
      SELECT id, direction, message_type, message_text, media_url, media_mime_type,
             NULL AS media_filename, NULL AS media_duration_ms, message_timestamp, created_at,
             platform, raw_payload_json
      FROM meta_social_messages
      WHERE contact_id = ? AND platform = ?
        AND message_type IN ('comment', 'comment_reply_public', 'comment_reply_private')
        ${inboundOnly ? "AND LOWER(COALESCE(direction, 'inbound')) = 'inbound'" : ''}
      ORDER BY COALESCE(message_timestamp, created_at) DESC
      LIMIT ?
    `, [contactId, platform, limit])
    return rows.reverse().map((row) => rowToConversationalMessage(row, normalizedChannel))
  }
  if (SOCIAL_CHAT_CHANNELS.has(normalizedChannel)) {
    const rows = await db.all(`
      SELECT id, direction, message_type, message_text, media_url, media_mime_type,
             NULL AS media_filename, NULL AS media_duration_ms, message_timestamp, created_at,
             platform, raw_payload_json
      FROM meta_social_messages
      WHERE contact_id = ? AND platform = ?
        AND message_type NOT IN ('comment', 'comment_reply_public', 'comment_reply_private')
        ${inboundOnly ? "AND LOWER(COALESCE(direction, 'inbound')) = 'inbound'" : ''}
      ORDER BY COALESCE(message_timestamp, created_at) DESC
      LIMIT ?
    `, [contactId, normalizedChannel, limit])
    return rows.reverse().map((row) => rowToConversationalMessage(row, normalizedChannel))
  }

  if (normalizedChannel === EMAIL_CONVERSATIONAL_CHANNEL) {
    const rows = await db.all(`
      SELECT id, direction, 'email' AS message_type, message_text, NULL AS media_url,
             NULL AS media_mime_type, NULL AS media_filename, NULL AS media_duration_ms,
             subject, from_email, to_email, reply_to, message_timestamp, created_at, raw_payload_json
      FROM email_messages
      WHERE contact_id = ?
        ${inboundOnly ? "AND LOWER(COALESCE(direction, 'inbound')) = 'inbound'" : ''}
      ORDER BY COALESCE(message_timestamp, created_at) DESC
      LIMIT ?
    `, [contactId, limit])
    return rows.reverse().map((row) => rowToConversationalMessage(row, normalizedChannel))
  }

  const rows = await db.all(`
    SELECT id, direction, message_type, message_text, media_url, media_mime_type,
           media_filename, media_duration_ms, phone, business_phone, business_phone_number_id,
           NULL AS subject, transport, message_timestamp, created_at, raw_payload_json
    FROM whatsapp_api_messages
    WHERE contact_id = ?
      ${inboundOnly ? "AND LOWER(COALESCE(direction, 'inbound')) = 'inbound'" : ''}
      ${phoneMessageTransportFilter(normalizedChannel)}
    ORDER BY COALESCE(message_timestamp, created_at) DESC
    LIMIT ?
  `, [contactId, limit])
  return rows.reverse().map((row) => rowToConversationalMessage(row, normalizedChannel))
}

async function loadConversationHistory(contactId, channel = 'whatsapp') {
  return loadConversationRows(contactId, channel, { limit: HISTORY_LIMIT })
}

async function loadPendingInboundMessages(contactId, state = {}, channel = 'whatsapp') {
  const rows = await loadConversationRows(contactId, channel, {
    inboundOnly: true,
    limit: PENDING_INBOUND_SCAN_LIMIT
  })

  const ordered = rows
  const answeredIndex = state?.lastAnsweredInboundMessageId
    ? ordered.findIndex((row) => row.id === state.lastAnsweredInboundMessageId)
    : -1

  let pending = answeredIndex >= 0 ? ordered.slice(answeredIndex + 1) : ordered
  if (answeredIndex < 0 && state?.lastReplyAt) {
    pending = ordered.filter((row) => {
      const messageTime = row.message_timestamp || row.created_at || ''
      const createdTime = row.created_at || ''
      return messageTime > state.lastReplyAt || createdTime > state.lastReplyAt
    })
  }

  return pending.slice(-PENDING_INBOUND_LIMIT)
}

async function loadLatestInboundMessage(contactId, channel = 'whatsapp') {
  const rows = await loadConversationRows(contactId, channel, {
    inboundOnly: true,
    limit: 1
  })
  return rows[0] || null
}

async function loadInboundMessageById(contactId, messageId, channel = 'whatsapp') {
  const normalizedChannel = normalizeConversationalChannel(channel)
  if (COMMENT_CHAT_CHANNELS.has(normalizedChannel)) {
    const platform = commentChannelToPlatform(normalizedChannel)
    const row = await db.get(`
      SELECT id, direction, message_type, message_text, media_url, media_mime_type,
             NULL AS media_filename, NULL AS media_duration_ms, message_timestamp, created_at,
             platform, raw_payload_json
      FROM meta_social_messages
      WHERE id = ? AND contact_id = ? AND platform = ?
      LIMIT 1
    `, [messageId, contactId, platform])
    return row ? rowToConversationalMessage(row, normalizedChannel) : null
  }
  if (SOCIAL_CHAT_CHANNELS.has(normalizedChannel)) {
    const row = await db.get(`
      SELECT id, direction, message_type, message_text, media_url, media_mime_type,
             NULL AS media_filename, NULL AS media_duration_ms, message_timestamp, created_at,
             platform, raw_payload_json
      FROM meta_social_messages
      WHERE id = ? AND contact_id = ? AND platform = ?
      LIMIT 1
    `, [messageId, contactId, normalizedChannel])
    return row ? rowToConversationalMessage(row, normalizedChannel) : null
  }

  if (normalizedChannel === EMAIL_CONVERSATIONAL_CHANNEL) {
    const row = await db.get(`
      SELECT id, direction, 'email' AS message_type, message_text, NULL AS media_url,
             NULL AS media_mime_type, NULL AS media_filename, NULL AS media_duration_ms,
             subject, from_email, to_email, reply_to, message_timestamp, created_at, raw_payload_json
      FROM email_messages
      WHERE id = ? AND contact_id = ?
      LIMIT 1
    `, [messageId, contactId])
    return row ? rowToConversationalMessage(row, normalizedChannel) : null
  }

  const row = await db.get(`
    SELECT id, direction, message_type, message_text, media_url, media_mime_type,
           media_filename, media_duration_ms, phone, business_phone, business_phone_number_id,
           NULL AS subject, transport, message_timestamp, created_at, raw_payload_json
    FROM whatsapp_api_messages
    WHERE id = ? AND contact_id = ?
      ${phoneMessageTransportFilter(normalizedChannel)}
    LIMIT 1
  `, [messageId, contactId])
  return row ? rowToConversationalMessage(row, normalizedChannel) : null
}

async function loadRecentInboundMessagesForRecovery(channel = 'whatsapp', {
  limit = PENDING_RECOVERY_PAGE_SIZE,
  offset = 0
} = {}) {
  const normalizedChannel = normalizeConversationalChannel(channel)
  if (COMMENT_CHAT_CHANNELS.has(normalizedChannel)) {
    const platform = commentChannelToPlatform(normalizedChannel)
    const rows = await db.all(`
      SELECT id, contact_id, direction, message_type, message_text, media_url, media_mime_type,
             NULL AS media_filename, NULL AS media_duration_ms, message_timestamp, created_at,
             platform, raw_payload_json
      FROM meta_social_messages
      WHERE platform = ?
        AND message_type = 'comment'
        AND LOWER(COALESCE(direction, 'inbound')) = 'inbound'
        AND contact_id IS NOT NULL
      ORDER BY COALESCE(message_timestamp, created_at) DESC
      LIMIT ? OFFSET ?
    `, [platform, limit, offset]).catch(() => [])
    return rows.map((row) => ({ ...rowToConversationalMessage(row, normalizedChannel), contact_id: row.contact_id }))
  }
  if (SOCIAL_CHAT_CHANNELS.has(normalizedChannel)) {
    const rows = await db.all(`
      SELECT id, contact_id, direction, message_type, message_text, media_url, media_mime_type,
             NULL AS media_filename, NULL AS media_duration_ms, message_timestamp, created_at,
             platform, raw_payload_json
      FROM meta_social_messages
      WHERE platform = ?
        AND LOWER(COALESCE(direction, 'inbound')) = 'inbound'
        AND contact_id IS NOT NULL
      ORDER BY COALESCE(message_timestamp, created_at) DESC
      LIMIT ? OFFSET ?
    `, [normalizedChannel, limit, offset]).catch(() => [])
    return rows.map((row) => ({ ...rowToConversationalMessage(row, normalizedChannel), contact_id: row.contact_id }))
  }

  if (normalizedChannel === EMAIL_CONVERSATIONAL_CHANNEL) {
    const rows = await db.all(`
      SELECT id, contact_id, direction, 'email' AS message_type, message_text, NULL AS media_url,
             NULL AS media_mime_type, NULL AS media_filename, NULL AS media_duration_ms,
             subject, from_email, to_email, reply_to, message_timestamp, created_at, raw_payload_json
      FROM email_messages
      WHERE LOWER(COALESCE(direction, 'inbound')) = 'inbound'
        AND contact_id IS NOT NULL
      ORDER BY COALESCE(message_timestamp, created_at) DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]).catch(() => [])
    return rows.map((row) => ({ ...rowToConversationalMessage(row, normalizedChannel), contact_id: row.contact_id }))
  }

  const rows = await db.all(`
    SELECT id, contact_id, direction, message_type, message_text, media_url, media_mime_type,
           media_filename, media_duration_ms, phone, business_phone,
           business_phone_number_id, NULL AS subject, transport, message_timestamp, created_at, raw_payload_json
    FROM whatsapp_api_messages
    WHERE direction = 'inbound' AND contact_id IS NOT NULL
      ${phoneMessageTransportFilter(normalizedChannel)}
    ORDER BY COALESCE(message_timestamp, created_at) DESC
    LIMIT ? OFFSET ?
  `, [limit, offset]).catch(() => [])
  return rows.map((row) => ({ ...rowToConversationalMessage(row, normalizedChannel), contact_id: row.contact_id }))
}

async function loadInboundMessagesForRecoveryWindow(channel, {
  nowMs = Date.now(),
  maxAgeMs = PENDING_RECOVERY_MAX_AGE_MS,
  pageSize = PENDING_RECOVERY_PAGE_SIZE
} = {}) {
  const rows = []
  let offset = 0
  while (true) {
    const page = await loadRecentInboundMessagesForRecovery(channel, { limit: pageSize, offset })
    if (!page.length) break
    let reachedAgeBoundary = false
    for (const row of page) {
      const timestampMs = messageTimestampMs(row)
      if (maxAgeMs > 0 && timestampMs > 0 && nowMs - timestampMs > maxAgeMs) {
        reachedAgeBoundary = true
        break
      }
      rows.push(row)
    }
    if (reachedAgeBoundary || page.length < pageSize) break
    offset += page.length
  }
  return rows
}

// Evidencia de "cliente existente" para la regla opcional de mandarlos con el
// equipo: pagos exitosos reales o citas pasadas no canceladas ANTERIORES al
// arranque de esta conversación (para no confundir un anticipo pagado en este
// mismo chat con un cliente previo).
export async function detectPastClientEvidence(contactId, { beforeIso = null } = {}) {
  const cleanContactId = String(contactId || '').trim()
  if (!cleanContactId) return { isPastClient: false, facts: [] }
  const cutoffMs = (() => {
    const parsed = new Date(beforeIso || '')
    return Number.isNaN(parsed.getTime()) ? Date.now() : parsed.getTime()
  })()

  const [payments, appointments] = await Promise.all([
    db.all(`
      SELECT amount, currency, status, payment_mode, COALESCE(paid_at, date, created_at) AS paid_ts
      FROM payments
      WHERE contact_id = ?
      ORDER BY COALESCE(paid_at, date, created_at) DESC
      LIMIT 50
    `, [cleanContactId]).catch(() => []),
    db.all(`
      SELECT start_time, COALESCE(appointment_status, status, '') AS appointment_state
      FROM appointments
      WHERE contact_id = ? AND deleted_at IS NULL AND start_time < ?
      ORDER BY start_time DESC
      LIMIT 20
    `, [cleanContactId, new Date().toISOString()]).catch(() => [])
  ])

  const facts = []
  for (const payment of payments || []) {
    const status = String(payment.status || '').trim().toLowerCase()
    const mode = String(payment.payment_mode || '').trim().toLowerCase()
    const paidMs = new Date(payment.paid_ts || '').getTime()
    if (!SUCCESS_PAYMENT_STATUSES.has(status) || NON_LIVE_PAYMENT_MODES.has(mode)) continue
    if (!Number.isFinite(paidMs) || paidMs >= cutoffMs) continue
    facts.push(`Pago registrado de ${payment.amount} ${String(payment.currency || '').toUpperCase()} el ${String(payment.paid_ts).slice(0, 10)}`)
    if (facts.length >= 2) break
  }
  for (const appointment of appointments || []) {
    const state = String(appointment.appointment_state || '').trim().toLowerCase()
    const startMs = new Date(appointment.start_time || '').getTime()
    if (['cancelled', 'noshow'].includes(state)) continue
    if (!Number.isFinite(startMs) || startMs >= cutoffMs) continue
    facts.push(`Cita previa el ${String(appointment.start_time).slice(0, 10)}${state ? ` (${state})` : ''}`)
    if (facts.length >= 4) break
  }

  return { isPastClient: facts.length > 0, facts }
}

function pastClientHandoffEnabled(config = {}) {
  return Boolean(config?.goalWorkflow?.attention?.pastClientsToHuman)
}

async function buildPastClientRuntimeContext({ config, contactId, agentState = null, dryRun = false }) {
  if (!pastClientHandoffEnabled(config)) return null
  if (dryRun || !contactId) {
    // El tester no tiene contacto real: la regla conversacional sigue activa.
    return { enabled: true, evidence: null }
  }
  const beforeIso = agentState?.activated_at || agentState?.created_at || null
  const evidence = await detectPastClientEvidence(contactId, { beforeIso }).catch(() => ({ isPastClient: false, facts: [] }))
  return { enabled: true, evidence: evidence.isPastClient ? evidence : null }
}

async function buildAgentForRun({ config, conversationModel, contactId, contactName, dryRun, channel = 'whatsapp', ruleContext = null, followUpContext = null, knowledgeQuery = '', executionId = '', priceInsistenceCount = 0, schedulingInsistenceCount = 0, pastClientContext = null }) {
  const [aiConfig, timezone, businessProfile, accountLocale, approvedLearning] = await Promise.all([
    getAIAgentConfig({}),
    getAccountTimezone().catch(() => DEFAULT_TIMEZONE),
    getBusinessProfileSnapshot().catch(() => null),
    getAccountLocaleSettings().catch(() => ({ countryCode: 'MX', currency: 'MXN', dialCode: '52' })),
    config?.id ? getApprovedConversationalLearning(config.id).catch(() => null) : Promise.resolve(null)
  ])

  const aiProvider = normalizeConversationalAIProvider(config?.aiProvider)
  const model = normalizeConversationalAgentModel(conversationModel || config?.model || DEFAULT_MODEL, aiProvider)
  const nowIso = new Date().toLocaleString(getAccountRegionalLocaleTag(accountLocale), { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' })

  let businessName = null
  try {
    const hlRow = await db.get('SELECT location_data FROM highlevel_config LIMIT 1')
    businessName = hlRow?.location_data ? JSON.parse(hlRow.location_data)?.name || null : null
  } catch { /* sin HighLevel */ }
  if (!businessName) {
    const userRow = await db.get('SELECT business_name FROM users ORDER BY id ASC LIMIT 1').catch(() => null)
    businessName = userRow?.business_name || null
  }

  const ctx = { contactId, config, dryRun, channel: normalizeConversationalChannel(channel), followUpMode: Boolean(followUpContext), executionId: String(executionId || '').trim(), accountLocale, actions: [], suppressReply: false }
  const tools = createConversationalTools(ctx)
  const knowledge = retrieveRelevantBusinessKnowledge({
    businessProfile,
    fallbackContext: buildRuntimeBusinessContext(aiConfig?.business_context || '', businessProfile),
    query: knowledgeQuery,
    maxChars: 6000
  })
  const runtimeBusinessContext = knowledge.context
  const compiledPolicy = compileConversationalAgentPolicy(config, { businessProfile })
  const advancedClosingContext = await loadAdvancedClosingRuntimeContext({
    contactId,
    config,
    businessName,
    businessContext: runtimeBusinessContext.slice(0, 6000),
    businessProfile,
    timezone,
    nowIso,
    accountLocale,
    channel,
    ruleContext
  })

  const instructions = buildConversationalInstructions({
    config,
    businessContext: runtimeBusinessContext.slice(0, 6000),
    brandVoice: String(aiConfig?.brand_voice || '').trim().slice(0, 2000),
    businessName,
    timezone,
    nowIso,
    contactName,
    channel,
    advancedClosingContext,
    accountLocale,
    followUpContext,
    priceInsistenceCount,
    schedulingInsistenceCount,
    pastClientContext
  })

  const agent = new Agent({
    name: 'Ristak · Agente conversacional',
    model,
    instructions,
    tools
  })

  return { agent, ctx, model, aiProvider, compiledPolicy, approvedLearning, knowledge }
}

async function executeAgent({ agent, modelProvider, messages, contactId, model, aiProvider = 'openai', channel = 'whatsapp', traceMessage = '', intelligenceTrace = null }) {
  const normalizedChannel = normalizeConversationalChannel(channel)
  let agentRun = null
  try {
    agentRun = await startAgentRun({
      userId: null,
      latestUserMessage: traceMessage || [...messages].reverse().find((m) => m.role === 'user')?.content || '',
      viewContext: { path: '/chat', title: 'Agente conversacional' }
    })
    await updateAgentRun(agentRun, {
      domain: 'conversacional',
      action: normalizedChannel === EMAIL_CONVERSATIONAL_CHANNEL ? 'email_reply' : 'chat_reply',
      model,
      route: { engine: aiProvider === 'openai' ? 'openai-agents-sdk' : `${aiProvider}-openai-compatible`, category: 'conversacional', contactId, channel: normalizedChannel }
    })
    if (intelligenceTrace) {
      await recordAgentStep(agentRun, {
        stepType: 'conversation_assessment',
        status: 'completed',
        output: intelligenceTrace
      })
    }
  } catch (error) {
    logger.warn(`[Agente conversacional] No se pudo iniciar rastro: ${error.message}`)
  }

  try {
    const runner = new Runner({
      modelProvider,
      tracingDisabled: true
    })
    const result = await runner.run(agent, buildInputItems(messages), {
      maxTurns: MAX_TURNS,
      context: { category: 'conversacional', contactId }
    })

    const reply = sanitizeAgentReply(result.finalOutput)
    await recordAgentStep(agentRun, {
      stepType: 'final_response',
      status: 'completed',
      output: { reply: reply.slice(0, 1600), model, aiProvider }
    })
    await completeAgentRun(agentRun, { status: 'completed', reply, model, aiProvider, usage: null })

    return reply
  } catch (error) {
    await recordAgentStep(agentRun, { stepType: 'error', status: 'failed', error: error.message })
    await completeAgentRun(agentRun, { status: 'failed', error: error.message })
    throw error
  }
}

function scheduleConversationalAgentRerun({ contactId, phone, latestMessage, reason, channel = 'whatsapp' }) {
  if (!latestMessage?.id) return
  const normalizedChannel = normalizeConversationalChannel(channel || latestMessage.channel)
  const runKey = getRunKey(contactId, normalizedChannel)
  pendingContactReruns.delete(runKey)
  // (AI-009) El rerun ya se está disparando: limpia su copia persistida.
  deletePendingRerun(runKey).catch(() => {})
  setTimeout(() => {
    handleInboundConversationalChatMessage({
      contactId,
      phone: latestMessage.phone || phone,
      messageId: latestMessage.id,
      channel: normalizedChannel
    }).catch((error) => {
      logger.error(`[Agente conversacional] Error reintentando tras ${reason}: ${error.message}`)
    })
  }, 0)
}

async function schedulePendingContactRerun(contactId, phone, reason, channel = 'whatsapp') {
  const normalizedChannel = normalizeConversationalChannel(channel)
  const latest = await loadLatestInboundMessage(contactId, normalizedChannel).catch(() => null)
  if (!latest) return
  scheduleConversationalAgentRerun({ contactId, phone, latestMessage: latest, reason, channel: normalizedChannel })
}

// [Fase 0] Tipos de entrante que NO deben abortar ni reiniciar una respuesta en curso:
// una reacción o un sticker son ruido (un 🙏🏽 o una carita no cambian el hilo) y hoy
// disparaban reply_suppressed dejando al paciente sin respuesta (casos viWyCup1 / j3GRLcmg).
const NON_SUBSTANTIVE_INBOUND_TYPES = new Set(['reaction', 'sticker'])

function isSubstantiveInboundMessage(message) {
  if (!message) return false
  const type = String(message.message_type || '').toLowerCase()
  return !NON_SUBSTANTIVE_INBOUND_TYPES.has(type)
}

async function loadNewerInboundMessage(contactId, handledMessageId, channel = 'whatsapp') {
  // Cargamos una ventana corta de entrantes (viejo -> nuevo) y devolvemos el más reciente
  // que sea SUSTANTIVO (texto, imagen, audio, documento...). Así una reacción/sticker que
  // llega mientras el bot responde ya no cancela el envío.
  const rows = await loadConversationRows(contactId, channel, { inboundOnly: true, limit: 8 })
  const handledIdx = rows.findIndex((row) => row.id === handledMessageId)
  const newerRows = handledIdx >= 0
    ? rows.slice(handledIdx + 1)
    : rows.filter((row) => row.id !== handledMessageId)
  for (let i = newerRows.length - 1; i >= 0; i--) {
    if (isSubstantiveInboundMessage(newerRows[i])) return newerRows[i]
  }
  return null
}

function clearFollowUpTimer(contactId) {
  const key = String(contactId || '')
  const keys = key.includes(':')
    ? [key]
    : ['whatsapp', 'instagram', 'messenger', 'sms', 'webchat', 'email'].map((channel) => getRunKey(key, channel))

  for (const timerKey of keys) {
    const timer = followUpTimers.get(timerKey)
    if (timer) {
      clearTimeout(timer)
      followUpTimers.delete(timerKey)
    }
  }
}

function messageTimestampMs(message = {}) {
  return toTimestampMs(message.message_timestamp || message.messageTimestamp || message.created_at || message.createdAt)
}

function getNextFollowUpStep(agentConfig = {}, sentCount = 0) {
  const steps = getAgentFollowUpSteps(agentConfig)
  const index = Math.max(0, Number(sentCount) || 0)
  const step = steps[index] || null
  return step ? { step, index: index + 1, total: steps.length } : null
}

function getFollowUpDueAtMs(latest, step) {
  const baseMs = messageTimestampMs(latest)
  if (!baseMs) return 0
  return baseMs + getAgentFollowUpStepDelayMs(step)
}

async function resetFollowUpStateAfterReply({ contactId, latest, agentConfig, phone, channel = 'whatsapp' }) {
  const normalizedChannel = normalizeConversationalChannel(channel || latest?.channel)
  clearFollowUpTimer(getRunKey(contactId, normalizedChannel))
  const followUp = normalizeAgentFollowUp(agentConfig.followUp)
  const agentId = agentConfig?.id || null
  if (!followUp.enabled || !latest?.id || isEmailConversationalChannel(normalizedChannel)) {
    await db.run(`
      UPDATE conversational_agent_state
      SET follow_up_base_message_id = NULL,
          follow_up_sent_count = 0,
          follow_up_last_sent_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE contact_id = ?
        AND agent_id = ?
        AND COALESCE(NULLIF(channel, ''), 'whatsapp') = ?
    `, [contactId, agentId, normalizedChannel]).catch(() => {})
    return
  }

  await db.run(`
    UPDATE conversational_agent_state
    SET follow_up_base_message_id = ?,
        follow_up_sent_count = 0,
        follow_up_last_sent_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE contact_id = ?
      AND agent_id = ?
      AND COALESCE(NULLIF(channel, ''), 'whatsapp') = ?
  `, [latest.id, contactId, agentId, normalizedChannel])

  const state = await getConversationState(contactId, { agentId, channel: normalizedChannel }).catch(() => null)
  scheduleNextFollowUp({ contactId, phone, latest, state, agentConfig, reason: 'respuesta enviada', channel: normalizedChannel })
}

function scheduleNextFollowUp({ contactId, phone, latest, state, agentConfig, reason = 'programado', channel = 'whatsapp' }) {
  const normalizedChannel = normalizeConversationalChannel(channel || latest?.channel || state?.channel)
  const runKey = getRunKey(contactId, normalizedChannel)
  clearFollowUpTimer(runKey)
  if (!contactId || !latest?.id || !agentConfig?.id) return false
  if (!state || state.status !== 'active' || state.signal) return false
  if (state.followUpBaseMessageId && state.followUpBaseMessageId !== latest.id) return false
  if (isEmailConversationalChannel(normalizedChannel)) return false

  const next = getNextFollowUpStep(agentConfig, state.followUpSentCount)
  if (!next) return false

  const dueAtMs = getFollowUpDueAtMs(latest, next.step)
  const baseMs = messageTimestampMs(latest)
  if (!dueAtMs || !baseMs) return false
  const nowMs = Date.now()
  if (dueAtMs - baseMs > FOLLOW_UP_WINDOW_MS || nowMs - baseMs > FOLLOW_UP_WINDOW_MS) return false

  const delayMs = Math.max(0, Math.min(dueAtMs - nowMs, MAX_TIMER_MS))
  const timer = setTimeout(() => {
    followUpTimers.delete(runKey)
    runScheduledFollowUp({ contactId, phone, baseMessageId: latest.id, followUpIndex: next.index, channel: normalizedChannel, agentId: agentConfig.id }).catch((error) => {
      logger.error(`[Agente conversacional] Error ejecutando seguimiento: ${error.message}`)
    })
  }, delayMs)
  followUpTimers.set(runKey, timer)

  recordConversationalAgentEvent({
    contactId,
    eventType: 'follow_up_scheduled',
    detail: {
      agentId: agentConfig.id,
      baseMessageId: latest.id,
      channel: normalizedChannel,
      followUpIndex: next.index,
      dueAt: new Date(dueAtMs).toISOString(),
      delayMs,
      reason
    }
  }).catch(() => {})
  return true
}

function buildFollowUpContextMessage({ followUpIndex, strategy }) {
  return {
    role: 'user',
    content: [
      `[Contexto interno de Ristak: disparo de seguimiento ${followUpIndex}]`,
      'El contacto no respondió después del último mensaje visible.',
      'Escribe sólo el mensaje que reabrirá la conversación.',
      'No menciones este contexto interno.',
      strategy ? `Estrategia de seguimiento: ${strategy}` : ''
    ].filter(Boolean).join('\n')
  }
}

async function sendConversationalChannelTextMessage({
  channel = 'whatsapp',
  contactId,
  latest = {},
  phone,
  text,
  externalId,
  agentId,
  commentReplyMode = 'private'
} = {}) {
  const normalizedChannel = normalizeConversationalChannel(channel || latest.channel)

  // Canal de COMENTARIO: el agente responde con sendMetaSocialCommentReply, no un DM.
  // 'public_then_private' responde público en el post Y manda el mismo texto por DM.
  if (COMMENT_CHAT_CHANNELS.has(normalizedChannel)) {
    const platform = commentChannelToPlatform(normalizedChannel)
    const { sendMetaSocialCommentReply } = await import('../../services/metaSocialMessagingService.js')
    const mode = normalizeCommentReplyMode(commentReplyMode)
    if (mode === 'public_then_private') {
      await sendMetaSocialCommentReply({ contactId, platform, message: text, replyType: 'public', externalId, agentId })
        .catch((error) => { logger.warn(`[Agente] Respuesta pública a comentario falló: ${error.message}`) })
      return sendMetaSocialCommentReply({ contactId, platform, message: text, replyType: 'private', externalId, agentId })
    }
    return sendMetaSocialCommentReply({
      contactId,
      platform,
      message: text,
      replyType: mode === 'public' ? 'public' : 'private',
      externalId,
      agentId
    })
  }

  if (normalizedChannel === EMAIL_CONVERSATIONAL_CHANNEL) {
    const { sendEmailToContact } = await import('../../services/emailService.js')
    return sendEmailToContact({
      contactId,
      to: latest.from_email || latest.to_email || undefined,
      subject: getEmailSubjectForReply(latest),
      text,
      externalId,
      agentId
    })
  }

  if (shouldSendConversationalReplyThroughHighLevel({ channel: normalizedChannel, latest })) {
    const { sendHighLevelConversationMessageCore } = await import('../../controllers/highlevelController.js')
    return sendHighLevelConversationMessageCore({
      contactId,
      channel: getHighLevelReplyChannel({ channel: normalizedChannel, latest }),
      message: text,
      toNumber: phone || latest.phone || undefined,
      externalId,
      agentId
    }, { markHumanTakeover: false })
  }

  if (SOCIAL_CHAT_CHANNELS.has(normalizedChannel)) {
    const { sendMetaSocialTextMessage } = await import('../../services/metaSocialMessagingService.js')
    return sendMetaSocialTextMessage({
      contactId,
      platform: normalizedChannel,
      message: text,
      externalId,
      agentId
    })
  }

  const { sendWhatsAppApiTextMessage } = await import('../../services/whatsappApiService.js')
  return sendWhatsAppApiTextMessage({
    to: phone || latest.phone,
    from: latest.business_phone || undefined,
    phoneNumberId: latest.business_phone_number_id || undefined,
    text,
    externalId,
    agentId
  })
}

async function runScheduledFollowUp({ contactId, phone, baseMessageId, followUpIndex, channel = 'whatsapp', agentId = null }) {
  const normalizedChannel = normalizeConversationalChannel(channel)
  // El runtime base es compatibilidad interna: si quedó apagado por legado,
  // se repara cuando existe un agente publicado que pueda atender.
  let config = await getConversationalAgentConfig()
  if (!config.enabled) {
    config = await ensureConversationalAgentRuntimeEnabledForPublishedAgents({
      reason: 'follow_up_with_published_agent'
    })
  }
  if (!config.enabled) return

  // (AI-002) Los seguimientos también ejecutan el responder (consume tokens):
  // sin entitlement de 'conversational_ai' no deben dispararse.
  if (!(await hasFeature('conversational_ai'))) return

  const state = await getConversationState(contactId, { agentId, channel: normalizedChannel })
  if (!state || state.status !== 'active' || state.signal) return
  if (state.followUpBaseMessageId !== baseMessageId) return

  let agentConfig = state.agentId ? await getConversationalAgent(state.agentId) : null
  if (!agentConfig?.enabled) return
  const next = getNextFollowUpStep(agentConfig, state.followUpSentCount)
  if (!next || next.index !== followUpIndex) return

  const latest = await loadLatestInboundMessage(contactId, normalizedChannel)
  if (!latest || latest.id !== baseMessageId) return
  const latestMs = messageTimestampMs(latest)
  if (!latestMs || Date.now() - latestMs > FOLLOW_UP_WINDOW_MS) {
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'follow_up_suppressed',
      detail: { agentId: agentConfig.id, baseMessageId, followUpIndex, channel: normalizedChannel, reason: 'chat_reply_window_expired' }
    }).catch(() => {})
    return
  }

  const aiProvider = normalizeConversationalAIProvider(agentConfig.aiProvider || config.aiProvider)
  const runtime = await resolveConversationalAIRuntime(aiProvider)
  agentConfig = { ...agentConfig, aiProvider }
  const contact = await db.get('SELECT full_name FROM contacts WHERE id = ?', [contactId]).catch(() => null)
  const rawMessages = await loadConversationHistory(contactId, normalizedChannel)
  const openAIFallbackApiKey = aiProvider === 'openai'
    ? runtime.apiKey
    : await getOpenAIApiKey().catch(() => null)
  const includeBinaryMedia = shouldIncludeConversationalBinaryMedia({ runtime })
  const hydratedMessages = await hydrateConversationalMessagesMedia(rawMessages, {
    aiProvider,
    apiKey: runtime.apiKey,
    audioTranscriptionApiKey: openAIFallbackApiKey,
    visualAnalysisApiKey: openAIFallbackApiKey,
    includeBinary: includeBinaryMedia
  })
  if (!hydratedMessages.length) return

  const followUp = normalizeAgentFollowUp(agentConfig.followUp)
  const { agent, ctx, model, compiledPolicy, approvedLearning } = await buildAgentForRun({
    config: agentConfig,
    conversationModel: agentConfig.model || config.model,
    contactId,
    contactName: contact?.full_name || null,
    dryRun: false,
    channel: normalizedChannel,
    ruleContext: null,
    followUpContext: { index: followUpIndex, strategy: followUp.strategy },
    knowledgeQuery: cleanMessageText(latest)
  })

  const previousIntelligence = await loadConversationIntelligenceState({
    stateId: state.id,
    objective: compiledPolicy.objective.type,
    channel: normalizedChannel
  })
  const assessed = await analyzeConversationIntelligence({
    messages: hydratedMessages,
    policy: compiledPolicy,
    previousState: previousIntelligence,
    runtime,
    model,
    channel: normalizedChannel,
    followUpMode: true
  })
  const strategy = planConversationStrategy({
    intelligenceState: assessed.state,
    policy: compiledPolicy,
    latestMessage: cleanMessageText(latest),
    followUpMode: true
  })
  let intelligenceState = applyStrategyPlan(assessed.state, strategy)
  await saveConversationIntelligenceState({
    stateId: state.id,
    intelligenceState,
    policyHash: compiledPolicy.hash,
    source: assessed.source
  })

  if (intelligenceState.followUp.stop || strategy.action === 'wait' || strategy.shouldReply === false) {
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'follow_up_suppressed',
      detail: {
        agentId: agentConfig.id,
        baseMessageId,
        followUpIndex,
        channel: normalizedChannel,
        reason: 'intelligence_stop',
        policyHash: compiledPolicy.hash,
        stateRevision: intelligenceState.revision,
        strategy: strategy.action
      }
    }).catch(() => {})
    return
  }

  const intelligenceContextMessage = buildConversationIntelligenceContextMessage(intelligenceState, compiledPolicy)
  const learningContextMessage = buildApprovedLearningContextMessage(approvedLearning)
  const messagesForAgent = [
    ...hydratedMessages,
    buildFollowUpContextMessage({ followUpIndex, strategy: followUp.strategy }),
    ...(learningContextMessage ? [learningContextMessage] : []),
    intelligenceContextMessage
  ]
  ctx.conversationMessages = messagesForAgent
  ctx.aiRuntime = runtime
  ctx.model = model
  ctx.intelligenceState = intelligenceState
  ctx.compiledPolicy = compiledPolicy

  const reply = await runWithConversationStateChannel(normalizedChannel, () => executeAgent({
    agent,
    modelProvider: runtime.modelProvider,
    messages: messagesForAgent,
    contactId,
    model,
    aiProvider,
    channel: normalizedChannel,
    traceMessage: `seguimiento ${followUpIndex}`,
    intelligenceTrace: {
      policyHash: compiledPolicy.hash,
      policyVersion: compiledPolicy.version,
      stateRevision: intelligenceState.revision,
      source: assessed.source,
      stage: intelligenceState.stage,
      temperature: intelligenceState.temperature,
      strategy: intelligenceState.strategy,
      intent: intelligenceState.intent,
      signalSummary: intelligenceState.signals,
      followUpIndex
    }
  }))

  const postState = await getConversationState(contactId, { agentId: agentConfig.id, channel: normalizedChannel })
  intelligenceState = finalizeConversationIntelligenceTurn({
    intelligenceState,
    actions: ctx.actions,
    reply,
    suppressed: ctx.suppressReply || postState?.status !== 'active' || Boolean(postState?.signal)
  }).state
  await saveConversationIntelligenceState({
    stateId: state.id,
    intelligenceState,
    policyHash: compiledPolicy.hash,
    source: assessed.source
  })
  if (ctx.suppressReply || !reply || postState?.status !== 'active' || postState?.signal) {
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'follow_up_suppressed',
      detail: { agentId: agentConfig.id, baseMessageId, followUpIndex, actions: ctx.actions, status: postState?.status || null }
    }).catch(() => {})
    return
  }

  const latestBeforeSend = await loadNewerInboundMessage(contactId, baseMessageId, normalizedChannel)
  if (latestBeforeSend) {
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'follow_up_suppressed',
      detail: { agentId: agentConfig.id, baseMessageId, followUpIndex, reason: 'newer_inbound_before_follow_up', newerMessageId: latestBeforeSend.id }
    }).catch(() => {})
    return
  }

  const delivery = await sendReplyParts({
    contactId,
    phone,
    latest,
    agentConfig,
    reply,
    apiKey: runtime.apiKey,
    model,
    channel: normalizedChannel,
    externalIdPrefix: `convagent_followup${followUpIndex}`,
    dependencies: {
      splitter: runtime.supportsAISplitting ? splitMessageIntoBubbles : splitMessageIntoBubblesFallback,
      markReplyComplete: async ({ contactId: doneContactId, latest: doneLatest }) => {
        await db.run(`
          UPDATE conversational_agent_state
          SET last_reply_at = CURRENT_TIMESTAMP,
              last_answered_inbound_message_id = ?,
              follow_up_sent_count = ?,
              follow_up_last_sent_at = CURRENT_TIMESTAMP,
              activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP),
              activation_source = COALESCE(activation_source, 'automatic'),
              activated_by = COALESCE(activated_by, 'agent'),
              updated_at = CURRENT_TIMESTAMP
          WHERE contact_id = ?
            AND agent_id = ?
            AND COALESCE(NULLIF(channel, ''), 'whatsapp') = ?
        `, [doneLatest.id, followUpIndex, doneContactId, agentConfig.id, normalizedChannel])
      }
    }
  })

  if (delivery.interruptedBy) {
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'follow_up_suppressed',
      detail: {
        agentId: agentConfig.id,
        baseMessageId,
        followUpIndex,
        reason: 'newer_inbound_during_follow_up',
        newerMessageId: delivery.interruptedBy.id,
        sentParts: delivery.sentParts
      }
    }).catch(() => {})
    return
  }

  if (!delivery.parts.length) {
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'follow_up_suppressed',
      detail: { agentId: agentConfig.id, baseMessageId, followUpIndex, reason: 'empty_follow_up_reply' }
    }).catch(() => {})
    return
  }

  await recordConversationalAgentEvent({
    contactId,
    eventType: 'follow_up_sent',
    detail: {
      agentId: agentConfig.id,
      baseMessageId,
      followUpIndex,
      partCount: delivery.parts.length,
      replyPreview: reply.slice(0, 280),
      aiProvider
    }
  }).catch(() => {})

  const nextState = await getConversationState(contactId, { agentId: agentConfig.id, channel: normalizedChannel }).catch(() => null)
  scheduleNextFollowUp({ contactId, phone, latest, state: nextState, agentConfig, reason: 'seguimiento enviado', channel: normalizedChannel })
}

export async function sendReplyParts({
  contactId,
  phone,
  latest,
  agentConfig,
  reply,
  apiKey,
  model,
  channel = 'whatsapp',
  externalIdPrefix = 'convagent',
  dependencies = {}
}) {
  const {
    splitter = splitMessageIntoBubbles,
    sendTextMessage = null,
    wait = sleep,
    loadNewerInbound = null,
    recordEvent = recordConversationalAgentEvent,
    markReplyComplete = null
  } = dependencies || {}

  const normalizedChannel = normalizeConversationalChannel(channel || latest?.channel)
  const splitResult = isEmailConversationalChannel(normalizedChannel)
    ? { messages: [reply].filter(Boolean), source: 'email', reason: 'email_single_message' }
    : await splitter({
      text: reply,
      settings: agentConfig.replyDelivery,
      apiKey
    })
  const parts = splitResult.messages
  if (!parts.length) return { parts: [], sentParts: 0, interruptedBy: null }

  const sendMessage = sendTextMessage || ((args) => sendConversationalChannelTextMessage({
    ...args,
    contactId,
    latest,
    phone,
    channel: normalizedChannel,
    commentReplyMode: getCommentReplyModeForAgent(agentConfig, normalizedChannel)
  }))

  const delivery = normalizeAgentReplyDelivery(agentConfig.replyDelivery)
  const delaySchedule = buildReplyPartDelaySchedule(parts, { replyDelivery: delivery })
  if (!isEmailConversationalChannel(normalizedChannel) && delivery.splitMessagesEnabled) {
    await recordEvent({
      contactId,
      eventType: 'reply_splitter_result',
      detail: {
        messageId: latest.id,
        agentId: agentConfig.id || null,
        channel: normalizedChannel,
        source: splitResult.source,
        reason: splitResult.reason,
        partCount: parts.length
      }
    })
  }

  for (let index = 0; index < parts.length; index += 1) {
    if (index > 0) {
      const delayMs = delaySchedule[index] || 0
      if (delayMs > 0) {
        await recordEvent({
          contactId,
          eventType: 'reply_part_wait_started',
          detail: { messageId: latest.id, agentId: agentConfig.id || null, partIndex: index + 1, partCount: parts.length, delayMs }
        })
        await wait(delayMs)
      }

      const newerInbound = await (loadNewerInbound
        ? loadNewerInbound(contactId, latest.id)
        : loadNewerInboundMessage(contactId, latest.id, normalizedChannel))
      if (newerInbound) {
        return { parts, sentParts: index, interruptedBy: newerInbound, delaySchedule }
      }
    }

    await sendMessage({
      channel: normalizedChannel,
      to: phone || latest.phone,
      from: latest.business_phone || undefined,
      phoneNumberId: latest.business_phone_number_id || undefined,
      text: parts[index],
      externalId: `${externalIdPrefix}_${latest.id}${parts.length > 1 ? `_${index + 1}` : ''}`.slice(0, 120),
      agentId: agentConfig.id || null
    })

    await recordEvent({
      contactId,
      eventType: parts.length > 1 ? 'reply_part_sent' : 'reply_single_sent',
      detail: {
        messageId: latest.id,
        agentId: agentConfig.id || null,
        channel: normalizedChannel,
        partIndex: index + 1,
        partCount: parts.length,
        replyPreview: parts[index].slice(0, 180)
      }
    })
  }

  if (typeof markReplyComplete === 'function') {
    await markReplyComplete({ contactId, latest, parts, delaySchedule })
  } else {
    await db.run(`
      UPDATE conversational_agent_state
      SET last_reply_at = CURRENT_TIMESTAMP,
          last_answered_inbound_message_id = ?,
          activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP),
          activation_source = COALESCE(activation_source, 'automatic'),
          activated_by = COALESCE(activated_by, 'agent'),
          updated_at = CURRENT_TIMESTAMP
      WHERE contact_id = ?
        AND agent_id = ?
        AND COALESCE(NULLIF(channel, ''), 'whatsapp') = ?
    `, [latest.id, contactId, agentConfig?.id || null, normalizedChannel])
  }

  return { parts, sentParts: parts.length, interruptedBy: null, delaySchedule }
}

function isRunnableConversationState(state) {
  return Boolean(state?.agentId && state.status === 'active' && !state.signal)
}

function getStateLastAnsweredInboundMessageId(state) {
  return state?.lastAnsweredInboundMessageId || state?.last_answered_inbound_message_id || null
}

function shouldReopenCompletedConversationState(state, latestMessageId) {
  if (!state?.agentId || state.status !== 'completed') return false
  const cleanLatestMessageId = String(latestMessageId || '').trim()
  if (!cleanLatestMessageId) return false
  return getStateLastAnsweredInboundMessageId(state) !== cleanLatestMessageId
}

export async function resolveInboundAgentForContact({ contactId, messageText, channel, ruleContext, latestMessageId = '' }) {
  const normalizedChannel = normalizeConversationalChannel(channel)
  const states = await listConversationStatesForContact(contactId, { channel: normalizedChannel }).catch(() => [])
  const blockedAgentIds = new Set()
  const releasedAgentIds = new Set()

  for (const state of states.filter((item) => item?.agentId && !isRunnableConversationState(item))) {
    const agentConfig = await getConversationalAgent(state.agentId).catch(() => null)

    // Un handoff sigue pendiente hasta que el humano lo resuelva. Un inbound
    // nuevo no debe borrar su señal ni permitir que otro agente se cuele.
    const pendingHumanHandoff = state.status === 'human' || (
      state.signal === 'ready_for_human' && agentConfig?.successAction === 'ready_for_human'
    )
    if (pendingHumanHandoff) {
      return { agentConfig: null, state, assigned: false }
    }

    if (agentConfig?.enabled && shouldReopenCompletedConversationState(state, latestMessageId)) {
      if (!entryRulesMatch(agentConfig, ruleContext)) {
        releasedAgentIds.add(agentConfig.id)
        await releaseAgentFromConversation(contactId, agentConfig.id, { updatedBy: 'agent', channel: normalizedChannel })
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'agent_released',
          detail: { agentId: agentConfig.id, name: agentConfig.name, channel: normalizedChannel, reason: 'entry_rules_no_longer_match' }
        })
        continue
      }
      if (exitRulesMatch(agentConfig, ruleContext)) {
        releasedAgentIds.add(agentConfig.id)
        await releaseAgentFromConversation(contactId, agentConfig.id, { updatedBy: 'agent', channel: normalizedChannel })
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'agent_released',
          detail: { agentId: agentConfig.id, name: agentConfig.name, channel: normalizedChannel, reason: 'exit_rules' }
        })
        continue
      }
      if (contactIsOutOfScopeForAgent(agentConfig, ruleContext)) {
        releasedAgentIds.add(agentConfig.id)
        await releaseAgentFromConversation(contactId, agentConfig.id, { updatedBy: 'agent', channel: normalizedChannel })
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'agent_released',
          detail: { agentId: agentConfig.id, name: agentConfig.name, channel: normalizedChannel, reason: 'contact_out_of_scope' }
        })
        continue
      }

      const reopenedState = await setConversationStatus(contactId, 'active', {
        updatedBy: 'agent',
        clearSignal: true,
        activationSource: 'automatic',
        agentId: agentConfig.id,
        channel: normalizedChannel
      })
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'agent_reopened',
        detail: {
          agentId: agentConfig.id,
          name: agentConfig.name,
          reason: 'new_inbound_after_completion',
          messageId: latestMessageId,
          channel: normalizedChannel
        }
      })
      return { agentConfig, state: reopenedState, assigned: false }
    }
    blockedAgentIds.add(state.agentId)
  }

  for (const state of states.filter(isRunnableConversationState)) {
    const agentConfig = await getConversationalAgent(state.agentId).catch(() => null)
    if (isUnverifiedConversationAssignment(state)) {
      const assignmentStillApplies = Boolean(
        agentConfig?.enabled &&
        entryRulesMatch(agentConfig, ruleContext) &&
        !exitRulesMatch(agentConfig, ruleContext) &&
        !contactIsOutOfScopeForAgent(agentConfig, ruleContext)
      )
      if (assignmentStillApplies) {
        const verifiedState = await assignAgentToConversation(contactId, agentConfig.id, {
          activationSource: 'automatic',
          assignmentSource: 'automatic',
          updatedBy: 'agent',
          channel: normalizedChannel
        })
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'agent_assignment_verified',
          detail: { agentId: agentConfig.id, name: agentConfig.name, channel: normalizedChannel, previousSource: state.assignmentSource || null }
        }).catch(() => {})
        return { agentConfig, state: verifiedState, assigned: false }
      }

      releasedAgentIds.add(state.agentId)
      await releaseAgentFromConversation(contactId, state.agentId, { updatedBy: 'agent', channel: normalizedChannel })
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'agent_released',
        detail: { agentId: state.agentId, name: agentConfig?.name || null, channel: normalizedChannel, reason: 'legacy_assignment_not_applicable' }
      })
      continue
    }

    if (!agentConfig?.enabled) continue

    if (exitRulesMatch(agentConfig, ruleContext)) {
      releasedAgentIds.add(agentConfig.id)
      await releaseAgentFromConversation(contactId, agentConfig.id, { updatedBy: 'agent', channel: normalizedChannel })
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'agent_released',
        detail: { agentId: agentConfig.id, name: agentConfig.name, channel: normalizedChannel, reason: 'exit_rules' }
      })
      continue
    }

    // Seguridad: si el agente pasó a "solo nuevos" y este contacto ya existía antes del
    // corte, suéltalo aunque tuviera asignación pegajosa (no lo dejes grandfathered).
    if (contactIsOutOfScopeForAgent(agentConfig, ruleContext)) {
      releasedAgentIds.add(agentConfig.id)
      await releaseAgentFromConversation(contactId, agentConfig.id, { updatedBy: 'agent', channel: normalizedChannel })
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'agent_released',
        detail: { agentId: agentConfig.id, name: agentConfig.name, channel: normalizedChannel, reason: 'contact_out_of_scope' }
      })
      continue
    }

    return { agentConfig, state, assigned: false }
  }

  const agentConfig = await matchAgentForMessage({
    contactId,
    messageText,
    channel: normalizedChannel,
    excludeAgentIds: [...blockedAgentIds, ...releasedAgentIds],
    ruleContext
  })

  if (!agentConfig) return { agentConfig: null, state: states[0] || null, assigned: false }

  const state = await assignAgentToConversation(contactId, agentConfig.id, {
    activationSource: 'automatic',
    assignmentSource: 'automatic',
    updatedBy: 'agent',
    channel: normalizedChannel
  })
  await recordConversationalAgentEvent({
    contactId,
    eventType: 'agent_assigned',
    detail: { agentId: agentConfig.id, name: agentConfig.name, channel: normalizedChannel }
  })

  return { agentConfig, state, assigned: true }
}

/**
 * Punto de entrada genérico para conversaciones atendidas por el agente.
 * Los chats y el correo comparten cerebro, pero cada canal conserva su entrega.
 */
export async function handleInboundConversationalMessage({ contactId, phone, messageId, channel = 'whatsapp', postContext = null }) {
  const normalizedChannel = normalizeConversationalChannel(channel)
  const runKey = getRunKey(contactId, normalizedChannel)
  let activeClaim = null
  const settleActiveClaim = async ({ status, answered = false, error = '' } = {}) => {
    if (!activeClaim) return false
    const claim = activeClaim
    activeClaim = null
    if (status === 'failed') {
      const result = await failConversationInboundMessage(contactId, claim.messageId, {
        agentId: claim.agentId,
        channel: claim.channel,
        claimToken: claim.claimToken,
        error
      })
      return result.failed
    }
    const result = await completeConversationInboundMessage(contactId, claim.messageId, {
      agentId: claim.agentId,
      channel: claim.channel,
      claimToken: claim.claimToken,
      answered
    })
    return result.completed
  }
  try {
    if (!contactId || !messageId) return

    // El runtime base es compatibilidad interna: si quedó apagado por legado,
    // se repara cuando existe un agente publicado que pueda atender.
    let config = await getConversationalAgentConfig()
    if (!config.enabled) {
      config = await ensureConversationalAgentRuntimeEnabledForPublishedAgents({
        reason: 'incoming_message_with_published_agent'
      })
    }
    if (!config.enabled) {
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'run_skipped_runtime_disabled',
        detail: { messageId, channel: normalizedChannel }
      }).catch(() => {})
      return
    }

    // (AI-002) Sin entitlement de 'conversational_ai' (downgrade/impago) el
    // agente no debe responder ni consumir tokens. hasFeature es fail-closed.
    if (!(await hasFeature('conversational_ai'))) {
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'run_skipped_feature_disabled',
        detail: { messageId, channel: normalizedChannel, feature: 'conversational_ai' }
      }).catch(() => {})
      return
    }

    clearFollowUpTimer(runKey)

	    if (runningContacts.has(runKey)) {
	      const pendingEntry = { contactId, phone, messageId, channel: normalizedChannel }
	      pendingContactReruns.set(runKey, pendingEntry)
	      // (AI-009) Espeja el rerun encolado en DB para sobrevivir reinicios.
	      await persistPendingRerun(runKey, pendingEntry)
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'run_rerun_queued',
        detail: { messageId, channel: normalizedChannel, reason: 'already_running' }
      }).catch(() => {})
      return
    }
    runningContacts.add(runKey)

    try {
      // Pequeña espera técnica para agrupar ráfagas inmediatas de webhooks.
      await sleep(DEBOUNCE_MS)

      let latest = await loadLatestInboundMessage(contactId, normalizedChannel)
      if (!latest) return

	      // Resolver qué agente atiende esta conversación: el ya asignado o el
	      // primero cuyas reglas de entrada coincidan con el mensaje/contacto.
	      let latestMessageText = cleanMessageText(latest)
      let ruleContext = await buildRuleContext({
        contactId,
        messageText: latestMessageText,
        post: postContext,
	        channel: normalizedChannel
	      })

      const resolved = await resolveInboundAgentForContact({
        contactId,
        messageText: latestMessageText,
        channel: normalizedChannel,
        ruleContext,
        latestMessageId: latest.id
      })
	      let agentConfig = resolved.agentConfig
	      let agentState = resolved.state
	      if (!agentConfig) {
	        // Ningún agente aplica a esta conversación: no responder.
	        await recordConversationalAgentEvent({
          contactId,
          eventType: 'agent_not_matched',
          detail: { messageId: latest.id, channel: normalizedChannel }
	        }).catch(() => {})
	        return
	      }
	      agentState = await getConversationState(contactId, { agentId: agentConfig.id, channel: normalizedChannel })
	      if (!agentState || agentState.status !== 'active' || agentState.signal) return
	      if (agentState.lastInboundMessageId === latest.id && agentState.lastAnsweredInboundMessageId === latest.id) return

      // La espera configurada simula tiempo humano ANTES de llamar a OpenAI.
      // Si el contacto manda más mensajes durante esa ventana, esta misma corrida
      // absorbe el último inbound y arma el contexto completo; no genera una
      // respuesta vieja para luego cancelarla.
      const responseDelayMs = getAgentResponseDelayMs(agentConfig)
      const waitResult = await waitForConversationalResponseWindow({
        contactId,
        latest,
        agentConfig,
        channel: normalizedChannel,
        delayMs: responseDelayMs,
        onNewerInbound: async () => {
          pendingContactReruns.delete(runKey)
          await deletePendingRerun(runKey).catch(() => {})
        }
      })
      if (!waitResult.latest) return
      if (waitResult.latest.id !== latest.id) {
        latest = waitResult.latest
        latestMessageText = cleanMessageText(latest)
        ruleContext = await buildRuleContext({
          contactId,
          messageText: latestMessageText,
          post: postContext,
          channel: normalizedChannel
        })
        if (exitRulesMatch(agentConfig, ruleContext)) {
          await releaseAgentFromConversation(contactId, agentConfig.id, { updatedBy: 'agent', channel: normalizedChannel })
          await recordConversationalAgentEvent({
            contactId,
            eventType: 'agent_released',
            detail: { agentId: agentConfig.id, name: agentConfig.name, reason: 'exit_rules_after_response_wait' }
          })
          return
        }
        if (contactIsOutOfScopeForAgent(agentConfig, ruleContext)) {
          await releaseAgentFromConversation(contactId, agentConfig.id, { updatedBy: 'agent', channel: normalizedChannel })
          await recordConversationalAgentEvent({
            contactId,
            eventType: 'agent_released',
            detail: { agentId: agentConfig.id, name: agentConfig.name, reason: 'contact_out_of_scope_after_response_wait' }
          })
          return
        }
        agentState = await getConversationState(contactId, { agentId: agentConfig.id, channel: normalizedChannel })
        if (!agentState || agentState.status !== 'active' || agentState.signal) return
        if (agentState.lastInboundMessageId === latest.id && agentState.lastAnsweredInboundMessageId === latest.id) return
      }

	      // Claim recuperable: el lease bloquea ejecuciones concurrentes, pero un
	      // error deja el mismo mensaje en estado failed para que pueda reintentarse.
	      const claim = await claimConversationInboundMessage(contactId, latest.id, {
	        agentId: agentConfig.id,
	        channel: normalizedChannel
	      })
	      if (!claim.claimed) {
	        await recordConversationalAgentEvent({
	          contactId,
	          eventType: 'run_skipped_already_claimed',
	          detail: { messageId: latest.id, channel: normalizedChannel, reason: claim.reason }
	        }).catch(() => {})
	        return
	      }
	      activeClaim = {
	        messageId: latest.id,
	        agentId: agentConfig.id,
	        channel: normalizedChannel,
	        claimToken: claim.claimToken
	      }
	      agentState = claim.state || agentState

      const aiProvider = normalizeConversationalAIProvider(agentConfig.aiProvider || config.aiProvider)
      const runtime = await resolveConversationalAIRuntime(aiProvider)
      agentConfig = { ...agentConfig, aiProvider }

      const contact = await db.get('SELECT id, full_name, phone, email FROM contacts WHERE id = ?', [contactId]).catch(() => null)
      const rawMessages = await loadConversationHistory(contactId, normalizedChannel)
      const openAIFallbackApiKey = aiProvider === 'openai'
        ? runtime.apiKey
        : await getOpenAIApiKey().catch(() => null)
      const includeBinaryMedia = shouldIncludeConversationalBinaryMedia({ runtime })
      const messages = await hydrateConversationalMessagesMedia(rawMessages, {
        aiProvider,
        apiKey: runtime.apiKey,
        audioTranscriptionApiKey: openAIFallbackApiKey,
        visualAnalysisApiKey: openAIFallbackApiKey,
        includeBinary: includeBinaryMedia
      })
      if (!messages.length) {
        await settleActiveClaim({ status: 'failed', error: 'conversation_history_empty' })
        return
      }
	      const pendingMessages = await loadPendingInboundMessages(contactId, agentState, normalizedChannel)
      const pendingContextMessage = buildPendingReplyContextMessage(pendingMessages)
      const baseMessagesForAgent = pendingContextMessage ? [...messages, pendingContextMessage] : messages
      const conversationDecision = evaluateConversationalGoalReadiness({
        messages: baseMessagesForAgent,
        config: agentConfig,
        contactName: contact?.full_name || ''
      })
      const decisionContextMessage = buildConversationDecisionContextMessage(conversationDecision)
      const traceMessage = cleanMessageText(pendingMessages[pendingMessages.length - 1] || latest)
      const priceInsistenceCount = countPriceInsistence(baseMessagesForAgent)
      const schedulingInsistenceCount = countSchedulingInsistence(baseMessagesForAgent)
      const pastClientContext = await buildPastClientRuntimeContext({
        config: agentConfig,
        contactId,
        agentState,
        dryRun: false
      })

      const { agent, ctx, model, compiledPolicy, approvedLearning } = await buildAgentForRun({
        config: agentConfig,
        conversationModel: agentConfig.model || config.model,
        contactId,
        contactName: contact?.full_name || null,
        dryRun: false,
      channel: normalizedChannel,
      ruleContext,
      executionId: latest.id,
      knowledgeQuery: traceMessage,
      priceInsistenceCount,
      schedulingInsistenceCount,
      pastClientContext
      })
      const previousIntelligence = await loadConversationIntelligenceState({
        stateId: agentState.id,
        objective: compiledPolicy.objective.type,
        channel: normalizedChannel
      })
      const assessed = await analyzeConversationIntelligence({
        messages: baseMessagesForAgent,
        policy: compiledPolicy,
        previousState: previousIntelligence,
        runtime,
        model,
        channel: normalizedChannel
      })
      const strategy = planConversationStrategy({
        intelligenceState: assessed.state,
        policy: compiledPolicy,
        latestMessage: traceMessage
      })
      let intelligenceState = applyStrategyPlan(assessed.state, strategy)
      await saveConversationIntelligenceState({
        stateId: agentState.id,
        intelligenceState,
        policyHash: compiledPolicy.hash,
        source: assessed.source
      })
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'conversation_intelligence_updated',
        detail: {
          agentId: agentConfig.id,
          stateId: agentState.id,
          channel: normalizedChannel,
          messageId: latest.id,
          policyHash: compiledPolicy.hash,
          revision: intelligenceState.revision,
          stage: intelligenceState.stage,
          temperature: intelligenceState.temperature,
          strategy: intelligenceState.strategy.action,
          tool: intelligenceState.strategy.tool,
          source: assessed.source,
          confirmedFacts: intelligenceState.story.confirmedFacts.length,
          hypotheses: intelligenceState.story.hypotheses.length
        }
      })
      const intelligenceContextMessage = buildConversationIntelligenceContextMessage(intelligenceState, compiledPolicy)
      const learningContextMessage = buildApprovedLearningContextMessage(approvedLearning)
      const messagesForAgent = [
        ...baseMessagesForAgent,
        ...(decisionContextMessage ? [decisionContextMessage] : []),
        ...(learningContextMessage ? [learningContextMessage] : []),
        intelligenceContextMessage
      ]

      // El generador recibe estado y estrategia tipados; sigue siendo la tool la que
      // valida y confirma cualquier efecto real.
      ctx.conversationMessages = messagesForAgent
      ctx.aiRuntime = runtime
      ctx.model = model
      ctx.intelligenceState = intelligenceState
      ctx.compiledPolicy = compiledPolicy

      let reply = await runWithConversationStateChannel(normalizedChannel, () => executeAgent({
        agent,
        modelProvider: runtime.modelProvider,
        messages: messagesForAgent,
        contactId,
        model,
        aiProvider,
        channel: normalizedChannel,
        traceMessage,
        intelligenceTrace: {
          policyHash: compiledPolicy.hash,
          policyVersion: compiledPolicy.version,
          stateRevision: intelligenceState.revision,
          source: assessed.source,
          stage: intelligenceState.stage,
          temperature: intelligenceState.temperature,
          strategy: intelligenceState.strategy,
          intent: intelligenceState.intent,
          signalSummary: intelligenceState.signals
        }
      }))
      // Guardián de cumplimiento: revisa las reglas de apertura de la biblia sobre la
      // respuesta visible y la reescribe si las rompe (precio/pitch antes de calificar).
      if (reply && !ctx.suppressReply) {
        const guarded = await enforceComplianceGuard({ reply, messages: messagesForAgent, config: agentConfig, runtime, model, priceInsistenceCount })
        if (guarded.changed) {
          reply = guarded.reply
          ctx.actions.push({ type: 'compliance_rewrite', rules: guarded.violation?.rules || [], reason: guarded.violation?.reason || '', effect: { liveEffect: 'REESCRIBIÓ el mensaje para cumplir la biblia (no soltar precio/pitch antes de calificar)', marksObjectiveCompleted: false } })
        }
      }

      let allowReplyAfterRuntimeHandoff = false
      const runtimeGuard = applyConversationalRuntimeReplyGuard({
        reply,
        latestText: traceMessage,
        actions: ctx.actions,
        config: agentConfig,
        readiness: conversationDecision,
        suppressReply: ctx.suppressReply,
        priceInsistenceCount
      })
      reply = runtimeGuard.reply
      ctx.suppressReply = runtimeGuard.suppressReply
      await recordRuntimeReplyGuardEvents({
        contactId,
        latest,
        agentConfig,
        channel: normalizedChannel,
        events: runtimeGuard.events,
        forceHumanHandoff: runtimeGuard.forceHumanHandoff
      })
      if (runtimeGuard.forceHumanHandoff) {
        await forceRuntimeHumanHandoff({
          contactId,
          agentConfig,
          latest,
          channel: normalizedChannel,
          ctx,
          handoff: runtimeGuard.forceHumanHandoff
        })
        allowReplyAfterRuntimeHandoff = Boolean(reply)
      }

      // El estado posterior es evidencia más fuerte que cualquier intención del modelo.
      const postState = await getConversationState(contactId, { agentId: agentConfig.id, channel: normalizedChannel })
      const stateConfirmedAction = postState?.signal === 'appointment_booked'
        ? 'book_appointment'
        : postState?.signal === 'purchase_completed'
          ? 'purchase_completed'
          : postState?.signal === 'discarded'
            ? 'discard_conversation'
            : postState?.status === 'human'
              ? 'send_to_human'
              : postState?.status === 'completed' && postState?.signal
                ? 'mark_ready_to_advance'
                : ''
      const intelligenceActions = stateConfirmedAction
        ? [...ctx.actions, { type: stateConfirmedAction, ok: true, source: 'persisted_conversation_state' }]
        : ctx.actions
      const finalizedIntelligence = finalizeConversationIntelligenceTurn({
        intelligenceState,
        actions: intelligenceActions,
        reply,
        suppressed: ctx.suppressReply,
        contact,
        now: new Date()
      })
      intelligenceState = finalizedIntelligence.state
      ctx.intelligenceState = intelligenceState
      await saveConversationIntelligenceState({
        stateId: agentState.id,
        intelligenceState,
        policyHash: compiledPolicy.hash,
        source: assessed.source
      })
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'conversation_strategy_executed',
        detail: {
          agentId: agentConfig.id,
          stateId: agentState.id,
          channel: normalizedChannel,
          messageId: latest.id,
          policyHash: compiledPolicy.hash,
          revision: intelligenceState.revision,
          strategy: intelligenceState.strategy.action,
          outcome: intelligenceState.outcome,
          actionResults: finalizedIntelligence.actionResults
        }
      })

      // El estado pudo cambiar durante la ejecución o la espera (descartada, humano, etc.)
      const blockedStatuses = new Set(['discarded', 'paused', 'skipped', 'human'])
      const blockedByStatus = blockedStatuses.has(postState?.status)
      const allowedRuntimeHumanReply = allowReplyAfterRuntimeHandoff && postState?.status === 'human'
      if (ctx.suppressReply || !reply || (blockedByStatus && !allowedRuntimeHumanReply)) {
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'reply_suppressed',
          detail: { messageId: latest.id, channel: normalizedChannel, actions: ctx.actions, status: postState?.status || null }
        })
        await settleActiveClaim({ status: 'completed', answered: false })
        return
      }

      const latestBeforeSend = await loadNewerInboundMessage(contactId, latest.id, normalizedChannel)
      if (latestBeforeSend) {
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'reply_suppressed',
          detail: {
            messageId: latest.id,
            agentId: agentConfig.id || null,
            channel: normalizedChannel,
            reason: 'newer_inbound_before_reply',
            newerMessageId: latestBeforeSend.id
          }
        })
        scheduleConversationalAgentRerun({
          contactId,
          phone,
          latestMessage: latestBeforeSend,
          channel: normalizedChannel,
          reason: 'mensaje nuevo antes de enviar'
        })
        await settleActiveClaim({ status: 'completed', answered: false })
        return
      }

      const delivery = await sendReplyParts({
        contactId,
        phone,
        latest,
        agentConfig,
        reply,
        apiKey: runtime.apiKey,
        model,
        channel: normalizedChannel,
        dependencies: {
          splitter: runtime.supportsAISplitting ? splitMessageIntoBubbles : splitMessageIntoBubblesFallback,
          markReplyComplete: async () => {
            await settleActiveClaim({ status: 'completed', answered: true })
          }
        }
      })
      if (delivery.interruptedBy) {
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'reply_suppressed',
          detail: {
            messageId: latest.id,
            agentId: agentConfig.id || null,
            channel: normalizedChannel,
            reason: 'newer_inbound_during_split_reply',
            newerMessageId: delivery.interruptedBy.id,
            sentParts: delivery.sentParts,
            partCount: delivery.parts.length
          }
        })
        scheduleConversationalAgentRerun({
          contactId,
          phone,
          latestMessage: delivery.interruptedBy,
          channel: normalizedChannel,
          reason: 'envío en partes'
        })
        await settleActiveClaim({ status: 'completed', answered: false })
        return
      }

      if (!delivery.parts.length) {
        await settleActiveClaim({ status: 'failed', error: 'empty_reply_delivery' })
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'reply_suppressed',
          detail: { messageId: latest.id, agentId: agentConfig.id || null, channel: normalizedChannel, reason: 'empty_reply_delivery' }
        }).catch(() => {})
        return
      }

      // Defensa por compatibilidad si una implementación de envío no invocó el
      // callback de confirmación aunque sí reportó partes enviadas.
      if (activeClaim) await settleActiveClaim({ status: 'completed', answered: true })

      await recordConversationalAgentEvent({
        contactId,
        eventType: 'reply_sent',
        detail: {
          messageId: latest.id,
          agentId: agentConfig.id || null,
          channel: normalizedChannel,
          replyPreview: reply.slice(0, 280),
          partCount: delivery.parts.length,
          pendingInboundCount: pendingMessages.length,
          aiProvider,
          actions: ctx.actions
        }
      })
      await resetFollowUpStateAfterReply({ contactId, latest, agentConfig, phone, channel: normalizedChannel })
    } finally {
      runningContacts.delete(runKey)
      const pending = pendingContactReruns.get(runKey)
      if (pending) {
        pendingContactReruns.delete(runKey)
        // (AI-009) Se va a re-disparar de inmediato: limpia la copia persistida.
        await deletePendingRerun(runKey)
        await schedulePendingContactRerun(
          contactId,
          pending.phone || phone,
          'mensaje entrante durante ejecución',
          pending.channel || normalizedChannel
        )
      }
    }
  } catch (error) {
    runningContacts.delete(runKey)
    await settleActiveClaim({ status: 'failed', error: error.message }).catch(() => {})
    logger.error(`[Agente conversacional] Error atendiendo mensaje entrante: ${error.message}`)
    await recordConversationalAgentEvent({
      contactId: contactId || null,
      eventType: 'error',
      detail: { message: error.message, channel: normalizedChannel }
    }).catch(() => {})
  }
}

export async function handleInboundConversationalChatMessage({ contactId, phone, messageId, channel = 'whatsapp', postContext = null }) {
  return handleInboundConversationalMessage({ contactId, phone, messageId, channel, postContext })
}

export async function handleInboundConversationalEmailMessage({ contactId, messageId }) {
  return handleInboundConversationalMessage({
    contactId,
    messageId,
    channel: EMAIL_CONVERSATIONAL_CHANNEL
  })
}

export async function handleInboundMessageForConversationalAgent({ contactId, phone, messageId, channel = 'whatsapp' }) {
  return handleInboundConversationalChatMessage({ contactId, phone, messageId, channel })
}

async function recoverScheduledFollowUps() {
  const rows = await db.all(`
    SELECT
      s.contact_id,
      s.agent_id,
      s.channel,
      s.follow_up_base_message_id,
      s.follow_up_sent_count
    FROM conversational_agent_state s
    WHERE s.status = 'active'
      AND s.agent_id IS NOT NULL
      AND s.agent_id <> ''
      AND s.follow_up_base_message_id IS NOT NULL
    ORDER BY COALESCE(s.follow_up_last_sent_at, s.last_reply_at, s.updated_at) ASC
  `).catch(() => [])

  let scheduled = 0
  for (const row of rows) {
    const agentConfig = await getConversationalAgent(row.agent_id).catch(() => null)
    if (!agentConfig?.enabled) continue
    const state = {
      status: 'active',
      signal: null,
      followUpBaseMessageId: row.follow_up_base_message_id,
      followUpSentCount: Math.max(0, Number(row.follow_up_sent_count) || 0),
      channel: row.channel || 'whatsapp'
    }
    const channel = normalizeConversationalChannel(row.channel || 'whatsapp')
    if (isEmailConversationalChannel(channel)) continue
    const latest = await loadInboundMessageById(row.contact_id, row.follow_up_base_message_id, channel).catch(() => null)
    if (!latest) continue
    if (scheduleNextFollowUp({
      contactId: row.contact_id,
      phone: latest.phone,
      latest,
      state,
      agentConfig,
      reason: 'recuperación de seguimientos al arrancar',
      channel
    })) {
      scheduled += 1
    }
  }
  return { scanned: rows.length, scheduled }
}

// (AI-009) Reconstruye al boot los reruns que quedaron encolados en memoria antes de
// un reinicio. Para cada fila persistida en ai_agent_pending_reruns que siga vigente
// (mensaje entrante aún sin responder) volvemos a
// disparar el rerun por la vía normal; scheduleConversationalAgentRerun ya borra la copia
// persistida, así que la operación es idempotente. Las filas viejas/inválidas se purgan.
async function recoverPendingReruns({ nowMs = Date.now() } = {}) {
  const rows = await db.all(`
    SELECT run_key, contact_id, channel, scheduled_for, payload, created_at
    FROM ai_agent_pending_reruns
    ORDER BY scheduled_for ASC
  `).catch(() => [])

  let scheduled = 0
  for (const row of rows) {
    const runKey = row?.run_key
    if (!runKey) continue
    let payload = {}
    try { payload = row.payload ? JSON.parse(row.payload) : {} } catch { payload = {} }
    const contactId = payload.contactId || (row.contact_id != null ? String(row.contact_id) : null)
    const channel = normalizeConversationalChannel(payload.channel || row.channel || 'whatsapp')

    if (!contactId) {
      await deletePendingRerun(runKey)
      continue
    }

    // El último entrante de ese contacto/canal: si ya fue respondido o quedó fuera de
    // la ventana de recuperación, el rerun ya no aplica y solo limpiamos la copia.
    const latest = await loadLatestInboundMessage(contactId, channel).catch(() => null)
    if (!latest) {
      await deletePendingRerun(runKey)
      continue
    }
    const states = await listConversationStatesForContact(contactId, { channel }).catch(() => [])
    const alreadyAnswered = states.some((state) => (
      state?.lastAnsweredInboundMessageId === latest.id ||
      state?.last_answered_inbound_message_id === latest.id
    ))
    const recoveryState = states.find(isRunnableConversationState) || null
    // Una fila explícitamente persistida no caduca por edad: se borra únicamente
    // cuando ya fue respondida o dejó de ser ejecutable.
    if (alreadyAnswered || !shouldRecoverPendingInbound(latest, recoveryState, { nowMs, maxAgeMs: 0 })) {
      await deletePendingRerun(runKey)
      continue
    }

    // scheduleConversationalAgentRerun borra la fila persistida y re-dispara la atención.
    scheduleConversationalAgentRerun({
      contactId,
      phone: payload.phone || latest.phone,
      latestMessage: latest,
      channel,
      reason: 'rerun encolado recuperado al arrancar'
    })
    scheduled += 1
  }

  if (scheduled) {
    logger.info(`[Agente conversacional] ${scheduled} rerun(s) encolado(s) recuperado(s) al arrancar`)
  }
  return { scanned: rows.length, scheduled }
}

async function loadRecoverableProcessingMessages({ nowMs = Date.now() } = {}) {
  const nowIso = new Date(nowMs).toISOString()
  const rows = await db.all(`
    SELECT contact_id, agent_id, channel, inbound_processing_message_id
    FROM conversational_agent_state
    WHERE status = 'active'
      AND agent_id IS NOT NULL
      AND agent_id <> ''
      AND inbound_processing_message_id IS NOT NULL
      AND inbound_processing_message_id <> ''
      AND (
        inbound_processing_status = 'failed'
        OR (
          inbound_processing_status = 'processing'
          AND (
            inbound_processing_lease_until_at IS NULL
            OR inbound_processing_lease_until_at <= ?
          )
        )
      )
    ORDER BY COALESCE(inbound_processing_started_at, updated_at, created_at) ASC
  `, [nowIso]).catch(() => [])

  const messages = []
  for (const row of rows) {
    const channel = normalizeConversationalChannel(row.channel || 'whatsapp')
    const message = await loadInboundMessageById(
      row.contact_id,
      row.inbound_processing_message_id,
      channel
    ).catch(() => null)
    if (!message) continue
    messages.push({
      ...message,
      contact_id: row.contact_id,
      channel,
      recovery_agent_id: row.agent_id,
      processing_recovery: true
    })
  }
  return messages
}

export async function recoverPendingConversationalAgentConversations({
  nowMs = Date.now(),
  maxAgeMs = PENDING_RECOVERY_MAX_AGE_MS
} = {}) {
  // El runtime base es compatibilidad interna: si quedó apagado por legado,
  // se repara antes de recuperar conversaciones de agentes publicados.
  let config = await getConversationalAgentConfig()
  if (!config.enabled) {
    config = await ensureConversationalAgentRuntimeEnabledForPublishedAgents({
      reason: 'pending_recovery_with_published_agent'
    })
  }
  if (!config.enabled) return { scanned: 0, scheduled: 0 }

  // (AI-002) No recuperar pendientes si la feature premium está revocada.
  if (!(await hasFeature('conversational_ai'))) return { scanned: 0, scheduled: 0 }

  // Recorre por páginas toda la ventana configurada. El límite es tamaño de
  // página, no un tope terminal: un contacto ya no queda enterrado detrás de
  // los 80 mensajes más nuevos. Claims failed/vencidos se recuperan sin edad.
  const [rowsByChannel, processingRows] = await Promise.all([
    Promise.all(RECOVERABLE_CONVERSATIONAL_CHANNELS.map((recoverableChannel) => (
      loadInboundMessagesForRecoveryWindow(recoverableChannel, { nowMs, maxAgeMs })
    ))),
    loadRecoverableProcessingMessages({ nowMs })
  ])
  const rows = [...rowsByChannel.flat(), ...processingRows]
    .sort((left, right) => messageTimestampMs(right) - messageTimestampMs(left))

  const latestByContact = new Map()
  for (const row of rows) {
    const key = getRunKey(row?.contact_id, row?.channel)
    if (!row?.contact_id) continue
    const current = latestByContact.get(key)
    if (!current || messageTimestampMs(row) > messageTimestampMs(current)) {
      latestByContact.set(key, row)
      continue
    }
    if (current.id === row.id && row.processing_recovery) {
      latestByContact.set(key, { ...current, ...row, processing_recovery: true })
    }
  }

  let scheduled = 0
  for (const latest of latestByContact.values()) {
    const latestChannel = normalizeConversationalChannel(latest.channel || 'whatsapp')
    const states = await listConversationStatesForContact(latest.contact_id, { channel: latestChannel }).catch(() => [])
    const runnableStates = states.filter(isRunnableConversationState)
    const alreadyAnswered = states.some((state) => (
      state?.lastAnsweredInboundMessageId === latest.id ||
      state?.last_answered_inbound_message_id === latest.id
    ))
    if (alreadyAnswered) continue
    const recoveryState = runnableStates.find((state) => (
      state.inboundProcessingMessageId === latest.id ||
      (latest.recovery_agent_id && state.agentId === latest.recovery_agent_id)
    )) || runnableStates[0] || null
    if (!shouldRecoverPendingInbound(latest, recoveryState, { nowMs, maxAgeMs })) continue

    await recordConversationalAgentEvent({
      contactId: latest.contact_id,
      eventType: 'pending_recovery_scheduled',
      detail: {
        messageId: latest.id,
        channel: latestChannel,
        maxAgeMs,
        processingRecovery: Boolean(latest.processing_recovery)
      }
    }).catch(() => {})

    scheduleConversationalAgentRerun({
      contactId: latest.contact_id,
      phone: latest.phone,
      latestMessage: latest,
      channel: latestChannel,
      reason: 'recuperación de pendientes al arrancar'
    })
    scheduled += 1
  }

  if (scheduled) {
    logger.info(`[Agente conversacional] ${scheduled} conversación(es) pendiente(s) recuperadas al arrancar`)
  }

  const followUps = await recoverScheduledFollowUps()
  if (followUps.scheduled) {
    logger.info(`[Agente conversacional] ${followUps.scheduled} seguimiento(s) recuperado(s) al arrancar`)
  }

  // (AI-009) Reconstruye los reruns que quedaron encolados en memoria antes del reinicio.
  const reruns = await recoverPendingReruns({ nowMs }).catch((error) => {
    logger.warn(`[Agente conversacional] No se pudieron recuperar reruns encolados: ${error.message}`)
    return { scanned: 0, scheduled: 0 }
  })

  return { scanned: latestByContact.size, scheduled, followUps, reruns }
}

export async function resolveConversationalAgentPreviewRuntimeConfig({ configOverride = null, agentId = null } = {}) {
  const runtimeDefaults = await getConversationalAgentConfig()
  const hasConfigOverride = configOverride && typeof configOverride === 'object' && Object.keys(configOverride).length > 0
  let baseConfig = agentId ? await getConversationalAgent(agentId) : null

  if (!baseConfig && !hasConfigOverride) {
    baseConfig = (await listConversationalAgents())[0] || null
  }

  const fallbackBase = buildConversationalAgentRuntimeConfig({}, {
    aiProvider: runtimeDefaults.aiProvider,
    model: runtimeDefaults.model
  })

  const config = hasConfigOverride
    ? buildConversationalAgentRuntimeConfig(configOverride, baseConfig || fallbackBase)
    : (baseConfig || fallbackBase)

  return { config, runtimeDefaults }
}

export function getConversationalAgentPreviewResponseDelayMs() {
  return 0
}

/**
 * Conversación simulada para probar el agente antes de activarlo.
 * No envía mensajes reales, no toca estados ni crea citas: las acciones internas
 * se devuelven como lista para mostrarlas en la prueba.
 */
export async function runConversationalAgentPreview({ messages = [], configOverride = null, agentId = null }) {
  const { config, runtimeDefaults } = await resolveConversationalAgentPreviewRuntimeConfig({ configOverride, agentId })
  const aiProvider = normalizeConversationalAIProvider(config.aiProvider || runtimeDefaults.aiProvider)
  const runtime = await resolveConversationalAIRuntime(aiProvider)
  const runtimeConfig = { ...config, aiProvider }
  const previewChannel = normalizeConversationalChannel(configOverride?.channel || configOverride?.testChannel || 'whatsapp')

  const cleanMessages = (Array.isArray(messages) ? messages : [])
    .filter((m) => {
      if (!m) return false
      const hasText = typeof m.content === 'string' && m.content.trim()
      const hasAttachments = Array.isArray(m.attachments) && m.attachments.length
      return hasText || hasAttachments
    })
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string' ? m.content.trim() : '',
      attachments: Array.isArray(m.attachments) ? m.attachments : []
    }))
    .slice(-HISTORY_LIMIT)

  if (!cleanMessages.length) {
    const error = new Error('Envía al menos un mensaje para simular la conversación')
    error.statusCode = 400
    throw error
  }

  const previewPriceInsistenceCount = countPriceInsistence(cleanMessages)
  const previewSchedulingInsistenceCount = countSchedulingInsistence(cleanMessages)
  const previewPastClientContext = await buildPastClientRuntimeContext({
    config: runtimeConfig,
    contactId: null,
    agentState: null,
    dryRun: true
  })
  const { agent, ctx, model, compiledPolicy, approvedLearning } = await buildAgentForRun({
    config: runtimeConfig,
    conversationModel: runtimeConfig.model || runtimeDefaults.model,
    contactId: null,
    contactName: null,
    dryRun: true,
    channel: previewChannel,
    ruleContext: null,
    knowledgeQuery: cleanMessages.map((message) => message.content).join(' ').slice(-4000),
    priceInsistenceCount: previewPriceInsistenceCount,
    schedulingInsistenceCount: previewSchedulingInsistenceCount,
    pastClientContext: previewPastClientContext
  })

  const openAIFallbackApiKey = aiProvider === 'openai'
    ? runtime.apiKey
    : await getOpenAIApiKey().catch(() => null)
  const includeBinaryMedia = shouldIncludeConversationalBinaryMedia({ runtime })
  const hydratedMessages = await hydrateConversationalPreviewMessagesMedia(cleanMessages, {
    aiProvider,
    apiKey: runtime.apiKey,
    audioTranscriptionApiKey: openAIFallbackApiKey,
    visualAnalysisApiKey: openAIFallbackApiKey,
    includeBinary: includeBinaryMedia
  })
  const assessed = await analyzeConversationIntelligence({
    messages: hydratedMessages,
    policy: compiledPolicy,
    previousState: null,
    runtime,
    model,
    channel: previewChannel
  })
  const latestPreviewText = [...cleanMessages].reverse().find((message) => message.role === 'user')?.content || ''
  const strategy = planConversationStrategy({
    intelligenceState: assessed.state,
    policy: compiledPolicy,
    latestMessage: latestPreviewText
  })
  let intelligenceState = applyStrategyPlan(assessed.state, strategy)
  const intelligenceContextMessage = buildConversationIntelligenceContextMessage(intelligenceState, compiledPolicy)
  const learningContextMessage = buildApprovedLearningContextMessage(approvedLearning)
  const messagesForAgent = [
    ...hydratedMessages,
    ...(learningContextMessage ? [learningContextMessage] : []),
    intelligenceContextMessage
  ]

  // Preview y runtime vivo comparten exactamente assessment, estrategia, prompt y tools.
  ctx.conversationMessages = messagesForAgent
  ctx.aiRuntime = runtime
  ctx.model = model
  ctx.intelligenceState = intelligenceState
  ctx.compiledPolicy = compiledPolicy

  let reply = await executeAgent({
    agent,
    modelProvider: runtime.modelProvider,
    messages: messagesForAgent,
    contactId: null,
    model,
    aiProvider,
    channel: previewChannel,
    intelligenceTrace: {
      policyHash: compiledPolicy.hash,
      policyVersion: compiledPolicy.version,
      stateRevision: intelligenceState.revision,
      source: assessed.source,
      stage: intelligenceState.stage,
      temperature: intelligenceState.temperature,
      strategy: intelligenceState.strategy,
      intent: intelligenceState.intent,
      signalSummary: intelligenceState.signals
    }
  })

  // Guardián de cumplimiento (mismo que en vivo, para que el tester lo refleje 1:1).
  if (reply && !ctx.suppressReply) {
    const guarded = await enforceComplianceGuard({ reply, messages: messagesForAgent, config: runtimeConfig, runtime, model, priceInsistenceCount: previewPriceInsistenceCount })
    if (guarded.changed) {
      reply = guarded.reply
      ctx.actions.push({ type: 'compliance_rewrite', rules: guarded.violation?.rules || [], reason: guarded.violation?.reason || '', effect: { liveEffect: 'REESCRIBIÓ el mensaje para cumplir la biblia (no soltar precio/pitch antes de calificar)', marksObjectiveCompleted: false } })
    }
  }

  intelligenceState = finalizeConversationIntelligenceTurn({
    intelligenceState,
    actions: ctx.actions,
    reply,
    suppressed: ctx.suppressReply
  }).state

  const splitResult = ctx.suppressReply
    ? { messages: [] }
    : isEmailConversationalChannel(previewChannel)
      ? { messages: [reply].filter(Boolean), source: 'email', reason: 'email_single_message' }
      : runtime.supportsAISplitting
      ? await splitMessageIntoBubbles({
        text: reply,
        settings: runtimeConfig.replyDelivery,
        apiKey: runtime.apiKey,
        model
      })
      : splitMessageIntoBubblesFallback({
        text: reply,
        settings: runtimeConfig.replyDelivery
      })
  const replyParts = splitResult.messages
  const replyPartDelaysMs = buildReplyPartDelaySchedule(replyParts, { replyDelivery: runtimeConfig.replyDelivery })
  const responseDelayMs = getConversationalAgentPreviewResponseDelayMs()

  return {
    reply: ctx.suppressReply ? '' : reply,
    replyParts,
    replyPartDelaysMs,
    responseDelayMs,
    suppressed: ctx.suppressReply,
    actions: ctx.actions,
    intelligence: intelligenceState,
    policyValidation: compiledPolicy.validation,
    policyHash: compiledPolicy.hash,
    assessmentSource: assessed.source,
    aiProvider,
    model
  }
}
