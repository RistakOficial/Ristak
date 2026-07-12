import { Agent, Runner } from '@openai/agents'
import { db } from '../../config/database.js'
import { logger } from '../../utils/logger.js'
import { DEFAULT_TIMEZONE, getAccountTimezone } from '../../utils/dateUtils.js'
import { getAccountLocaleSettings } from '../../utils/accountLocale.js'
import {
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
  recordConversationalAgentEvent,
  getConversationalAgent,
  listConversationalAgents,
  matchAgentForMessage,
  assignAgentToConversation,
  releaseAgentFromConversation,
  setConversationStatus,
  buildRuleContext,
  entryRulesMatch,
  exitRulesMatch,
  contactIsOutOfScopeForAgent,
  isUnverifiedConversationAssignment,
  claimConversationInboundMessage,
  completeConversationInboundMessage,
  failConversationInboundMessage,
  getConversationalReplyDeliveryPlan,
  getOrCreateConversationalReplyDeliveryPlan,
  claimConversationalReplyDelivery,
  checkpointConversationalReplyDelivery,
  settleConversationalReplyDelivery,
  recoverPendingConversationalPaymentSourceBindings,
  recoverPendingConversationalPaymentReconciliations,
  runWithConversationStateChannel,
  normalizeConversationalAgentModel,
  getAgentResponseDelayMs,
  getAgentFollowUpSteps,
  getAgentFollowUpStepDelayMs,
  normalizeAgentFollowUp,
  MAX_FOLLOW_UP_DELAY_MINUTES,
  getAgentReplyDeliveryPartDelayMs,
  normalizeAgentReplyDelivery
} from '../../services/conversationalAgentService.js'
import {
  normalizeConversationalAIProvider,
  resolveConversationalAIRuntime
} from '../../services/conversationalAIProviderService.js'
import { DEFAULT_OPENAI_MODEL } from '../../config/openAIModels.js'
// (AI-002) Gate de licencia: el runtime del agente conversacional debe respetar
// la feature premium incluso cuando se dispara desde los servicios de mensajería.
import { hasFeature } from '../../services/licenseService.js'
import { createConversationalTools } from './tools.js'
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
import { retrieveRelevantBusinessKnowledge } from './intelligence/knowledge.js'
import {
  buildConversationalCapabilityManifest,
  getConversationalCapabilitiesConfig,
  getConversationalNativeRuntimeValidationErrors,
  getConversationalPromptConfig
} from './nativeRuntimeConfig.js'
import { buildNativeConversationalInstructions } from './nativePrompt.js'
import {
  getActiveConversationalAgentPreventiveMeasure,
  withConversationalAgentSafetyLock
} from '../../services/conversationalAgentSafetyService.js'

const HISTORY_LIMIT = 20
export const TOOL_CALLING_V2_HISTORY_BYTE_BUDGET = 64 * 1024
export const TOOL_CALLING_V2_HISTORY_PAGE_SIZE = 100
export const TOOL_CALLING_V2_HISTORY_TOOL_PAGE_LIMIT = 30
export const TOOL_CALLING_V2_HISTORY_TOOL_BYTE_BUDGET = 16 * 1024
export const TOOL_CALLING_V2_STORED_MEDIA_BYTE_RESERVE = 16 * 1024
const MAX_TURNS = 10
const PREVENTIVE_DELIVERY_INTERRUPTION_ID = 'preventive_measure'
const DEFAULT_MODEL = process.env.OPENAI_CONVERSATIONAL_AGENT_MODEL || DEFAULT_OPENAI_MODEL
const MAX_REPLY_CHARS = 1000
const DEBOUNCE_MS = 4000
const PENDING_INBOUND_LIMIT = 8
const PENDING_INBOUND_SCAN_LIMIT = 30
const PENDING_RECOVERY_PAGE_SIZE = 80
const PENDING_RECOVERY_MAX_AGE_MS = Number(process.env.CONVERSATIONAL_AGENT_PENDING_RECOVERY_MAX_AGE_MS || 60 * 60 * 1000)
const FOLLOW_UP_WINDOW_MS = MAX_FOLLOW_UP_DELAY_MINUTES * 60 * 1000
const MAX_TIMER_MS = 2_147_483_647
export const TOOL_CALLING_V2_RUNTIME_MODE = 'tool_calling_v2'
export const CONVERSATIONAL_PREVIEW_CONTACT_ID = 'ristak-preview-contact'
export const CONVERSATIONAL_PREVIEW_CONTACT_NAME = 'Contacto de prueba'
export const TOOL_CALLING_V2_MODEL_SETTINGS = Object.freeze({
  parallelToolCalls: false
})
const LIVE_MUTATION_TERMINAL_TOOLS = new Set([
  'apply_safety_measure',
  'book_appointment',
  'request_human_booking',
  'mark_ready_to_advance',
  'create_payment_link',
  'send_goal_url',
  'send_to_human',
  'register_deposit_payment_proof'
])

function stopAfterCommittedLiveMutation(_runContext, toolResults = []) {
  const mustStop = (Array.isArray(toolResults) ? toolResults : []).some((result) => {
    const toolName = String(result?.tool?.name || '').trim()
    if (toolName === 'apply_safety_measure') {
      return result?.output?.suppressReply === true &&
        result?.output?.terminal === true
    }
    return LIVE_MUTATION_TERMINAL_TOOLS.has(toolName) && result?.output?.actionCompleted === true
  })
  return mustStop
    ? { isFinalOutput: true, isInterrupted: undefined, finalOutput: '' }
    : { isFinalOutput: false, isInterrupted: undefined }
}
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

// Identificadores internos que jamás deben llegar al cliente final.
const TOOL_CALLING_V2_INTERNAL_IDENTIFIER_PATTERN = /\b(ready_for_human|ready_to_schedule|ready_to_buy|purchase_completed|mark_ready_to_advance|send_to_human|discard_conversation|stay_silent|book_appointment|request_human_booking|create_payment_link|send_goal_url|send_trigger_link|get_free_slots|get_business_profile|list_products|get_contact_profile|get_conversation_history|save_contact_data|apply_safety_measure|update_closing_context|register_deposit_payment_proof)\b/gi

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

export function sanitizeToolCallingV2Reply(text) {
  let reply = String(text || '').trim()
  if (!reply) return ''
  // Redacción literal de identificadores internos; no analiza intención, tono ni
  // contenido natural y por eso no rompe palabras como "agendar" ni sus URLs.
  reply = reply
    .replace(TOOL_CALLING_V2_INTERNAL_IDENTIFIER_PATTERN, 'la acción solicitada')
    .replace(/\[[^\]]*(?:herramienta|tool call)[^\]]*\]/gi, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if ((reply.startsWith('"') && reply.endsWith('"')) || (reply.startsWith('“') && reply.endsWith('”'))) {
    reply = reply.slice(1, -1).trim()
  }
  if (reply.length > MAX_REPLY_CHARS) {
    reply = `${reply.slice(0, MAX_REPLY_CHARS - 1).trim()}…`
  }
  return reply
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

function getAccountRegionalLocaleTag(accountLocale = {}) {
  const countryCode = String(accountLocale?.countryCode || accountLocale?.country || '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(countryCode) ? `es-${countryCode}` : 'es-419'
}

function getChannelLabel(channel = 'whatsapp') {
  const normalized = normalizeConversationalChannel(channel)
  return {
    whatsapp: 'WhatsApp',
    instagram: 'Instagram',
    messenger: 'Messenger',
    webchat: 'Chat web',
    sms: 'SMS',
    email: 'Correo',
    facebook_comment: 'Comentario de Facebook',
    instagram_comment: 'Comentario de Instagram'
  }[normalized] || 'chat'
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

function hasToolCallingV2HistoryContent(message = {}) {
  const hasText = typeof message.content === 'string' && message.content.trim()
  const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0
  const hasStoredMedia = Boolean(message.media_url || message.mediaUrl)
  return Boolean(hasText || hasAttachments || hasStoredMedia)
}

function normalizeHistoryByteBudget(value, fallback = TOOL_CALLING_V2_HISTORY_BYTE_BUDGET) {
  const parsed = Math.trunc(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function byteLength(value = '') {
  return Buffer.byteLength(String(value || ''), 'utf8')
}

/**
 * Estimación provider-neutral del peso del mensaje que entra al contexto. No
 * intenta adivinar tokens de un proveedor concreto: cuenta bytes UTF-8 y la
 * representación de sus adjuntos. Un mensaje se conserva entero o no entra.
 */
export function estimateToolCallingV2HistoryMessageBytes(message = {}) {
  let total = 48 + byteLength(message.role) + byteLength(message.content)
  if (message.selectedClarificationOption?.value) {
    total += byteLength(message.selectedClarificationOption.value) + 32
  }

  const attachments = Array.isArray(message.attachments) ? message.attachments : []
  for (const attachment of attachments) {
    total += 96
    total += byteLength(attachment?.kind)
    total += byteLength(attachment?.name)
    total += byteLength(attachment?.mimeType)
    total += byteLength(attachment?.text)
    total += byteLength(attachment?.dataUrl)
    total += byteLength(attachment?.thumbnailDataUrl)
  }

  if (message.media_url || message.mediaUrl) {
    // El binario remoto se hidrata después de armar el sobre. Reservamos un
    // costo conservador para que cien URLs cortas no parezcan cien mensajes
    // baratos y después exploten el contexto al convertirse en adjuntos.
    total += TOOL_CALLING_V2_STORED_MEDIA_BYTE_RESERVE
    total += byteLength(message.message_type || message.messageType)
    total += byteLength(message.media_mime_type || message.mediaMimeType)
    total += byteLength(message.media_filename || message.mediaFilename)
  }
  return total
}

function selectToolCallingV2HistoryTail(messages = [], byteBudget = TOOL_CALLING_V2_HISTORY_BYTE_BUDGET) {
  const eligible = (Array.isArray(messages) ? messages : []).filter(hasToolCallingV2HistoryContent)
  const budget = normalizeHistoryByteBudget(byteBudget)
  let start = eligible.length
  let includedBytes = 0
  let latestMessageBytes = 0

  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    const messageBytes = estimateToolCallingV2HistoryMessageBytes(eligible[index])
    if (index === eligible.length - 1) latestMessageBytes = messageBytes
    // El mensaje más reciente nunca se trunca ni se elimina, aun si por sí solo
    // rebasa el presupuesto. El exceso queda visible en telemetría.
    if (start === eligible.length || includedBytes + messageBytes <= budget) {
      start = index
      includedBytes += messageBytes
      continue
    }
    // El sobre es una cola cronológica continua. No brincamos un mensaje largo
    // para rescatar otros más viejos y fabricar un hilo con huecos invisibles.
    break
  }

  return {
    allMessages: eligible,
    messages: eligible.slice(start),
    includedBytes,
    latestMessageBytes,
    byteBudget: budget
  }
}

function selectToolCallingV2HistoryHead(messages = [], byteBudget = TOOL_CALLING_V2_HISTORY_TOOL_BYTE_BUDGET) {
  const eligible = (Array.isArray(messages) ? messages : []).filter(hasToolCallingV2HistoryContent)
  const budget = normalizeHistoryByteBudget(byteBudget, TOOL_CALLING_V2_HISTORY_TOOL_BYTE_BUDGET)
  const selected = []
  let includedBytes = 0
  let firstMessageBytes = 0

  for (const message of eligible) {
    const messageBytes = estimateToolCallingV2HistoryMessageBytes(message)
    if (!selected.length) firstMessageBytes = messageBytes
    if (!selected.length || includedBytes + messageBytes <= budget) {
      selected.push(message)
      includedBytes += messageBytes
      continue
    }
    break
  }

  return {
    allMessages: eligible,
    messages: selected,
    includedBytes,
    latestMessageBytes: firstMessageBytes,
    byteBudget: budget
  }
}

function safeHistoryAttachmentSummary(message = {}) {
  const summaries = []
  const storedKind = String(message.message_type || message.messageType || '').trim().toLowerCase()
  if (message.media_url || message.mediaUrl) {
    const label = {
      audio: 'audio',
      image: 'imagen',
      video: 'video',
      document: 'documento',
      file: 'archivo'
    }[storedKind] || 'archivo'
    const rawMime = String(message.media_mime_type || message.mediaMimeType || '').trim().slice(0, 120)
    const mime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(rawMime) ? rawMime : ''
    summaries.push([`Adjunto: ${label}`, mime ? `tipo ${mime}` : ''].filter(Boolean).join(', '))
  }

  for (const attachment of Array.isArray(message.attachments) ? message.attachments.slice(0, 8) : []) {
    const rawKind = String(attachment?.kind || '').trim().toLowerCase()
    const kind = {
      audio: 'audio',
      image: 'imagen',
      video: 'video',
      pdf: 'documento PDF',
      document: 'documento',
      text: 'archivo de texto',
      file: 'archivo'
    }[rawKind] || 'archivo'
    const rawMime = String(attachment?.mimeType || '').trim().slice(0, 120)
    const mime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(rawMime) ? rawMime : ''
    summaries.push([`Adjunto: ${kind}`, mime ? `tipo ${mime}` : ''].filter(Boolean).join(', '))
  }
  return summaries.length ? summaries.join('\n') : null
}

function safeHistoryToolMessage(message = {}) {
  return {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    text: typeof message.content === 'string' && message.content.trim() ? message.content.trim() : null,
    sentAt: message.messageTimestamp || message.message_timestamp || message.createdAt || message.created_at || null,
    attachmentSummary: safeHistoryAttachmentSummary(message)
  }
}

function normalizeHistoryPageLimit(value) {
  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed)) return TOOL_CALLING_V2_HISTORY_TOOL_PAGE_LIMIT
  return Math.max(1, Math.min(TOOL_CALLING_V2_HISTORY_TOOL_PAGE_LIMIT, parsed))
}

function normalizeHistoryAccessMode(value) {
  const mode = String(value || '').trim().toLowerCase()
  return ['previous', 'oldest', 'offset', 'search'].includes(mode) ? mode : 'previous'
}

function buildHistoryCursor(mode, position) {
  return `${normalizeHistoryAccessMode(mode)}:${Math.max(0, Math.trunc(Number(position) || 0))}`
}

function normalizeHistoryCursorPosition(cursor, mode, fallbackPosition = 0) {
  const minimum = Math.max(0, Math.trunc(Number(fallbackPosition) || 0))
  const raw = String(cursor ?? '').trim()
  if (!raw) return minimum
  const prefixed = raw.match(/^([a-z]+):(\d+)$/i)
  if (prefixed) {
    const cursorMode = String(prefixed[1]).toLowerCase()
    if (!['previous', 'oldest', 'offset', 'search'].includes(cursorMode)) return minimum
    if (cursorMode !== normalizeHistoryAccessMode(mode)) return minimum
    const parsed = Number(prefixed[2])
    return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : minimum
  }
  // Compatibilidad interna con cursores numéricos emitidos por la primera
  // versión. La tool pública siempre recibe desde ahora cursores con modo.
  const parsed = Math.trunc(Number(raw))
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : minimum
}

function normalizeHistorySearchQuery(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 200)
}

function buildSafeHistoryPageResult(rows = [], {
  position,
  totalMessages = null,
  byteBudget = TOOL_CALLING_V2_HISTORY_TOOL_BYTE_BUDGET,
  mode = 'previous',
  direction = 'tail',
  hasMore = null
} = {}) {
  const normalizedMode = normalizeHistoryAccessMode(mode)
  const selected = direction === 'head'
    ? selectToolCallingV2HistoryHead(rows, byteBudget)
    : selectToolCallingV2HistoryTail(rows, byteBudget)
  const returnedMessages = selected.messages
  const nextPosition = Math.max(0, Number(position) || 0) + returnedMessages.length
  const hasKnownTotal = totalMessages !== null && totalMessages !== undefined && Number.isFinite(Number(totalMessages))
  const remainingMessages = hasKnownTotal
    ? Math.max(0, Number(totalMessages) - nextPosition)
    : null
  const pageHasMore = typeof hasMore === 'boolean'
    ? hasMore
    : Boolean(remainingMessages > 0)
  return {
    ok: true,
    mode: normalizedMode,
    messages: returnedMessages.map(safeHistoryToolMessage),
    returnedMessages: returnedMessages.length,
    includedBytes: selected.includedBytes,
    remainingMessages,
    hasMore: pageHasMore,
    nextCursor: pageHasMore ? buildHistoryCursor(normalizedMode, nextPosition) : null
  }
}

function createInMemoryHistoryPageLoader(allMessages, includedMessages) {
  const totalMessages = allMessages.length
  const minimumOffset = includedMessages
  if (minimumOffset >= totalMessages) return null
  const omittedMessages = allMessages.slice(0, totalMessages - includedMessages)

  return async ({
    mode = 'previous',
    cursor = null,
    offset = null,
    query = null,
    limit = TOOL_CALLING_V2_HISTORY_TOOL_PAGE_LIMIT
  } = {}) => {
    const accessMode = normalizeHistoryAccessMode(mode)
    const boundedLimit = normalizeHistoryPageLimit(limit)
    if (accessMode === 'previous') {
      const position = normalizeHistoryCursorPosition(cursor, accessMode, minimumOffset)
      const endExclusive = Math.max(0, totalMessages - position)
      const start = Math.max(0, endExclusive - boundedLimit)
      const rows = allMessages.slice(start, endExclusive)
      return buildSafeHistoryPageResult(rows, { position, totalMessages, mode: accessMode })
    }

    if (accessMode === 'search') {
      const cleanQuery = normalizeHistorySearchQuery(query)
      if (!cleanQuery) return { ok: false, mode: accessMode, error: 'Escribe el texto que necesitas buscar en el historial anterior.' }
      const needle = cleanQuery.toLowerCase()
      const matches = omittedMessages.filter((message) => {
        const searchable = [message.content, safeHistoryAttachmentSummary(message)].filter(Boolean).join('\n').toLowerCase()
        return searchable.includes(needle)
      })
      const position = normalizeHistoryCursorPosition(cursor, accessMode, 0)
      const endExclusive = Math.max(0, matches.length - position)
      const start = Math.max(0, endExclusive - boundedLimit)
      const rows = matches.slice(start, endExclusive)
      return buildSafeHistoryPageResult(rows, {
        position,
        totalMessages: matches.length,
        mode: accessMode
      })
    }

    const requestedOffset = accessMode === 'offset'
      ? Math.max(0, Math.trunc(Number(offset) || 0))
      : 0
    const position = normalizeHistoryCursorPosition(cursor, accessMode, requestedOffset)
    const start = Math.min(omittedMessages.length, position)
    const rows = omittedMessages.slice(start, start + boundedLimit)
    return buildSafeHistoryPageResult(rows, {
      position: start,
      totalMessages: omittedMessages.length,
      mode: accessMode,
      direction: 'head'
    })
  }
}

/**
 * Constructor único del sobre v2 para preview, pruebas y cualquier caller que
 * ya tenga mensajes en memoria. Conserva el hilo entero cuando cabe y, cuando
 * no, deja una pagina factual accesible a la misma instancia del agente.
 */
export function buildToolCallingV2HistoryEnvelope(messages = [], {
  byteBudget = TOOL_CALLING_V2_HISTORY_BYTE_BUDGET,
  source = 'memory'
} = {}) {
  const selected = selectToolCallingV2HistoryTail(messages, byteBudget)
  const totalMessages = selected.allMessages.length
  const includedMessages = selected.messages.length
  const omittedMessages = Math.max(0, totalMessages - includedMessages)
  const telemetry = {
    source,
    totalMessages,
    includedMessages,
    omittedMessages,
    includedBytes: selected.includedBytes,
    byteBudget: selected.byteBudget,
    latestMessageBytes: selected.latestMessageBytes,
    overBudget: selected.includedBytes > selected.byteBudget
  }
  return {
    messages: selected.messages,
    telemetry,
    loadOlderPage: createInMemoryHistoryPageLoader(selected.allMessages, includedMessages)
  }
}

async function loadConversationRows(contactId, channel = 'whatsapp', {
  inboundOnly = false,
  limit = HISTORY_LIMIT,
  offset = 0,
  contentOnly = false
} = {}) {
  const normalizedChannel = normalizeConversationalChannel(channel)
  const boundedLimit = Math.max(1, Math.trunc(Number(limit) || HISTORY_LIMIT))
  const boundedOffset = Math.max(0, Math.trunc(Number(offset) || 0))
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
        ${contentOnly ? "AND (TRIM(COALESCE(message_text, '')) <> '' OR TRIM(COALESCE(media_url, '')) <> '')" : ''}
      ORDER BY COALESCE(message_timestamp, created_at) DESC, id DESC
      LIMIT ? OFFSET ?
    `, [contactId, platform, boundedLimit, boundedOffset])
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
        ${contentOnly ? "AND (TRIM(COALESCE(message_text, '')) <> '' OR TRIM(COALESCE(media_url, '')) <> '')" : ''}
      ORDER BY COALESCE(message_timestamp, created_at) DESC, id DESC
      LIMIT ? OFFSET ?
    `, [contactId, normalizedChannel, boundedLimit, boundedOffset])
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
        ${contentOnly ? "AND (TRIM(COALESCE(message_text, '')) <> '' OR TRIM(COALESCE(subject, '')) <> '')" : ''}
      ORDER BY COALESCE(message_timestamp, created_at) DESC, id DESC
      LIMIT ? OFFSET ?
    `, [contactId, boundedLimit, boundedOffset])
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
      ${contentOnly ? "AND (TRIM(COALESCE(message_text, '')) <> '' OR TRIM(COALESCE(media_url, '')) <> '')" : ''}
    ORDER BY COALESCE(message_timestamp, created_at) DESC, id DESC
    LIMIT ? OFFSET ?
  `, [contactId, boundedLimit, boundedOffset])
  return rows.reverse().map((row) => rowToConversationalMessage(row, normalizedChannel))
}

async function countConversationRows(contactId, channel = 'whatsapp', { contentOnly = false } = {}) {
  const normalizedChannel = normalizeConversationalChannel(channel)
  if (COMMENT_CHAT_CHANNELS.has(normalizedChannel)) {
    const platform = commentChannelToPlatform(normalizedChannel)
    const row = await db.get(`
      SELECT COUNT(*) AS total
      FROM meta_social_messages
      WHERE contact_id = ? AND platform = ?
        AND message_type IN ('comment', 'comment_reply_public', 'comment_reply_private')
        ${contentOnly ? "AND (TRIM(COALESCE(message_text, '')) <> '' OR TRIM(COALESCE(media_url, '')) <> '')" : ''}
    `, [contactId, platform])
    return Math.max(0, Number(row?.total) || 0)
  }
  if (SOCIAL_CHAT_CHANNELS.has(normalizedChannel)) {
    const row = await db.get(`
      SELECT COUNT(*) AS total
      FROM meta_social_messages
      WHERE contact_id = ? AND platform = ?
        AND message_type NOT IN ('comment', 'comment_reply_public', 'comment_reply_private')
        ${contentOnly ? "AND (TRIM(COALESCE(message_text, '')) <> '' OR TRIM(COALESCE(media_url, '')) <> '')" : ''}
    `, [contactId, normalizedChannel])
    return Math.max(0, Number(row?.total) || 0)
  }
  if (normalizedChannel === EMAIL_CONVERSATIONAL_CHANNEL) {
    const row = await db.get(`
      SELECT COUNT(*) AS total
      FROM email_messages
      WHERE contact_id = ?
        ${contentOnly ? "AND (TRIM(COALESCE(message_text, '')) <> '' OR TRIM(COALESCE(subject, '')) <> '')" : ''}
    `, [contactId])
    return Math.max(0, Number(row?.total) || 0)
  }

  const row = await db.get(`
    SELECT COUNT(*) AS total
    FROM whatsapp_api_messages
    WHERE contact_id = ?
      ${phoneMessageTransportFilter(normalizedChannel)}
      ${contentOnly ? "AND (TRIM(COALESCE(message_text, '')) <> '' OR TRIM(COALESCE(media_url, '')) <> '')" : ''}
  `, [contactId])
  return Math.max(0, Number(row?.total) || 0)
}

function escapeHistoryLikeQuery(value) {
  return normalizeHistorySearchQuery(value).toLowerCase().replace(/[\\%_]/g, '\\$&')
}

function buildHistorySearchBoundary(beforeMessage = {}) {
  const timestamp = String(
    beforeMessage.messageTimestamp ||
    beforeMessage.message_timestamp ||
    beforeMessage.createdAt ||
    beforeMessage.created_at ||
    ''
  ).trim()
  const id = String(beforeMessage.id || '').trim()
  return timestamp && id ? { timestamp, id } : null
}

/**
 * Búsqueda literal server-side limitada al tramo omitido del mismo contacto y
 * canal. El ID de frontera sólo participa dentro del closure/SQL y jamás sale
 * en el resultado visible para el modelo.
 */
async function searchConversationRows(contactId, channel = 'whatsapp', {
  query,
  limit = TOOL_CALLING_V2_HISTORY_TOOL_PAGE_LIMIT,
  offset = 0,
  beforeMessage = null
} = {}) {
  const normalizedChannel = normalizeConversationalChannel(channel)
  const cleanQuery = escapeHistoryLikeQuery(query)
  if (!cleanQuery) return []
  const pattern = `%${cleanQuery}%`
  const boundedLimit = Math.max(1, Math.min(TOOL_CALLING_V2_HISTORY_TOOL_PAGE_LIMIT + 1, Math.trunc(Number(limit) || TOOL_CALLING_V2_HISTORY_TOOL_PAGE_LIMIT)))
  const boundedOffset = Math.max(0, Math.trunc(Number(offset) || 0))
  const boundary = buildHistorySearchBoundary(beforeMessage)
  if (!boundary) return []
  const boundarySql = `AND (
    COALESCE(message_timestamp, created_at) < ? OR
    (COALESCE(message_timestamp, created_at) = ? AND id < ?)
  )`
  const boundaryParams = [boundary.timestamp, boundary.timestamp, boundary.id]

  if (COMMENT_CHAT_CHANNELS.has(normalizedChannel)) {
    const platform = commentChannelToPlatform(normalizedChannel)
    const rows = await db.all(`
      SELECT id, direction, message_type, message_text, media_url, media_mime_type,
             NULL AS media_filename, NULL AS media_duration_ms, message_timestamp, created_at,
             platform, raw_payload_json
      FROM meta_social_messages
      WHERE contact_id = ? AND platform = ?
        AND message_type IN ('comment', 'comment_reply_public', 'comment_reply_private')
        AND (TRIM(COALESCE(message_text, '')) <> '' OR TRIM(COALESCE(media_url, '')) <> '')
        ${boundarySql}
        AND LOWER(COALESCE(message_text, '')) LIKE ? ESCAPE '\\'
      ORDER BY COALESCE(message_timestamp, created_at) DESC, id DESC
      LIMIT ? OFFSET ?
    `, [contactId, platform, ...boundaryParams, pattern, boundedLimit, boundedOffset])
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
        AND (TRIM(COALESCE(message_text, '')) <> '' OR TRIM(COALESCE(media_url, '')) <> '')
        ${boundarySql}
        AND LOWER(COALESCE(message_text, '')) LIKE ? ESCAPE '\\'
      ORDER BY COALESCE(message_timestamp, created_at) DESC, id DESC
      LIMIT ? OFFSET ?
    `, [contactId, normalizedChannel, ...boundaryParams, pattern, boundedLimit, boundedOffset])
    return rows.reverse().map((row) => rowToConversationalMessage(row, normalizedChannel))
  }

  if (normalizedChannel === EMAIL_CONVERSATIONAL_CHANNEL) {
    const rows = await db.all(`
      SELECT id, direction, 'email' AS message_type, message_text, NULL AS media_url,
             NULL AS media_mime_type, NULL AS media_filename, NULL AS media_duration_ms,
             subject, from_email, to_email, reply_to, message_timestamp, created_at, raw_payload_json
      FROM email_messages
      WHERE contact_id = ?
        AND (TRIM(COALESCE(message_text, '')) <> '' OR TRIM(COALESCE(subject, '')) <> '')
        ${boundarySql}
        AND LOWER(COALESCE(subject, '') || ' ' || COALESCE(message_text, '')) LIKE ? ESCAPE '\\'
      ORDER BY COALESCE(message_timestamp, created_at) DESC, id DESC
      LIMIT ? OFFSET ?
    `, [contactId, ...boundaryParams, pattern, boundedLimit, boundedOffset])
    return rows.reverse().map((row) => rowToConversationalMessage(row, normalizedChannel))
  }

  const rows = await db.all(`
    SELECT id, direction, message_type, message_text, media_url, media_mime_type,
           media_filename, media_duration_ms, phone, business_phone, business_phone_number_id,
           NULL AS subject, transport, message_timestamp, created_at, raw_payload_json
    FROM whatsapp_api_messages
    WHERE contact_id = ?
      ${phoneMessageTransportFilter(normalizedChannel)}
      AND (TRIM(COALESCE(message_text, '')) <> '' OR TRIM(COALESCE(media_url, '')) <> '')
      ${boundarySql}
      AND LOWER(COALESCE(message_text, '')) LIKE ? ESCAPE '\\'
    ORDER BY COALESCE(message_timestamp, created_at) DESC, id DESC
    LIMIT ? OFFSET ?
  `, [contactId, ...boundaryParams, pattern, boundedLimit, boundedOffset])
  return rows.reverse().map((row) => rowToConversationalMessage(row, normalizedChannel))
}

/**
 * Carga el historial vivo desde la fuente canónica en páginas, empezando por
 * lo más reciente y deteniéndose al llenar el presupuesto. Un COUNT separado
 * permite reportar cuántos mensajes quedaron fuera sin leer todo el hilo.
 */
export async function loadToolCallingV2ConversationEnvelope({
  contactId,
  channel = 'whatsapp',
  byteBudget = TOOL_CALLING_V2_HISTORY_BYTE_BUDGET,
  pageSize = TOOL_CALLING_V2_HISTORY_PAGE_SIZE
} = {}, dependencies = {}) {
  const loadRows = dependencies.loadRows || loadConversationRows
  const countRows = dependencies.countRows || countConversationRows
  const searchRows = dependencies.searchRows || searchConversationRows
  const normalizedChannel = normalizeConversationalChannel(channel)
  const budget = normalizeHistoryByteBudget(byteBudget)
  const boundedPageSize = Math.max(1, Math.trunc(Number(pageSize) || TOOL_CALLING_V2_HISTORY_PAGE_SIZE))
  const totalMessages = await countRows(contactId, normalizedChannel, { contentOnly: true })
  const newestFirst = []
  let includedBytes = 0
  let latestMessageBytes = 0
  let offset = 0
  let pagesLoaded = 0
  let full = totalMessages === 0

  while (offset < totalMessages) {
    const page = await loadRows(contactId, normalizedChannel, {
      limit: boundedPageSize,
      offset,
      contentOnly: true
    })
    pagesLoaded += 1
    if (!page.length) {
      full = true
      break
    }

    let budgetReached = false
    for (let index = page.length - 1; index >= 0; index -= 1) {
      const message = page[index]
      if (!hasToolCallingV2HistoryContent(message)) continue
      const messageBytes = estimateToolCallingV2HistoryMessageBytes(message)
      if (!newestFirst.length) latestMessageBytes = messageBytes
      if (!newestFirst.length || includedBytes + messageBytes <= budget) {
        newestFirst.push(message)
        includedBytes += messageBytes
        continue
      }
      budgetReached = true
      break
    }

    offset += page.length
    if (budgetReached) break
    if (page.length < boundedPageSize || offset >= totalMessages) {
      full = true
      break
    }
  }

  const messages = newestFirst.reverse()
  const includedMessages = messages.length
  const omittedMessages = Math.max(0, totalMessages - includedMessages)
  const telemetry = {
    source: 'database',
    totalMessages,
    includedMessages,
    omittedMessages,
    includedBytes,
    byteBudget: budget,
    latestMessageBytes,
    overBudget: includedBytes > budget,
    pagesLoaded,
    historyComplete: omittedMessages === 0 && full
  }

  const loadOlderPage = omittedMessages > 0
    ? async ({
        mode = 'previous',
        cursor = null,
        offset: requestedOffset = null,
        query = null,
        limit = TOOL_CALLING_V2_HISTORY_TOOL_PAGE_LIMIT
      } = {}) => {
        const accessMode = normalizeHistoryAccessMode(mode)
        const boundedLimit = normalizeHistoryPageLimit(limit)
        if (accessMode === 'previous') {
          const position = normalizeHistoryCursorPosition(cursor, accessMode, includedMessages)
          const rows = await loadRows(contactId, normalizedChannel, {
            limit: boundedLimit,
            offset: position,
            contentOnly: true
          })
          return buildSafeHistoryPageResult(rows, {
            position,
            totalMessages,
            mode: accessMode
          })
        }

        if (accessMode === 'search') {
          const cleanQuery = normalizeHistorySearchQuery(query)
          if (!cleanQuery) return { ok: false, mode: accessMode, error: 'Escribe el texto que necesitas buscar en el historial anterior.' }
          const position = normalizeHistoryCursorPosition(cursor, accessMode, 0)
          const fetchedRows = await searchRows(contactId, normalizedChannel, {
            query: cleanQuery,
            limit: boundedLimit + 1,
            offset: position,
            beforeMessage: messages[0]
          })
          const rows = fetchedRows.length > boundedLimit ? fetchedRows.slice(-boundedLimit) : fetchedRows
          const result = buildSafeHistoryPageResult(rows, {
            position,
            totalMessages: null,
            mode: accessMode
          })
          const pageHasMore = fetchedRows.length > result.returnedMessages
          return {
            ...result,
            hasMore: pageHasMore,
            nextCursor: pageHasMore
              ? buildHistoryCursor(accessMode, position + result.returnedMessages)
              : null
          }
        }

        const omittedTotal = omittedMessages
        const initialPosition = accessMode === 'offset'
          ? Math.max(0, Math.trunc(Number(requestedOffset) || 0))
          : 0
        const position = Math.min(
          omittedTotal,
          normalizeHistoryCursorPosition(cursor, accessMode, initialPosition)
        )
        const endExclusive = Math.min(omittedTotal, position + boundedLimit)
        const rowCount = Math.max(0, endExclusive - position)
        const newestOffset = Math.max(includedMessages, totalMessages - endExclusive)
        const rows = rowCount > 0
          ? await loadRows(contactId, normalizedChannel, {
              limit: rowCount,
              offset: newestOffset,
              contentOnly: true
            })
          : []
        return buildSafeHistoryPageResult(rows, {
          position,
          totalMessages: omittedTotal,
          mode: accessMode,
          direction: 'head'
        })
      }
    : null

  return { messages, telemetry, loadOlderPage }
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
function nativeActionSucceeded(action = {}) {
  const outcome = action?.outcome || {}
  if (outcome.simulated === true || outcome.status === 'simulated') return false
  return outcome.ok === true || outcome.status === 'ok' || action?.ok === true
}

function nativeActionFailed(action = {}) {
  const outcome = action?.outcome || {}
  return outcome.status === 'error' || outcome.ok === false || action?.ok === false || Boolean(action?.error || outcome?.error)
}

function nativeActionVisibleUrl(action = {}) {
  const candidates = [
    action?.outcome?.sentUrl,
    action?.outcome?.paymentLink,
    action?.sentUrl,
    action?.paymentLink
  ]
  for (const value of candidates) {
    const clean = String(value || '').trim()
    if (/^https?:\/\/\S+$/i.test(clean)) return clean
  }
  return ''
}

export function ensureToolCallingV2VisibleReply(reply = '', actions = []) {
  const preventiveSuppression = (Array.isArray(actions) ? actions : []).some((action) => (
    action?.type === 'apply_safety_measure' &&
    action?.outcome?.suppressReply === true &&
    action?.outcome?.terminal === true
  ))
  if (preventiveSuppression) return ''
  let visible = sanitizeToolCallingV2Reply(reply)
  const contactIdentityUnavailable = (Array.isArray(actions) ? actions : [])
    .some((action) => action?.type === 'contact_identity_unavailable')
  if (contactIdentityUnavailable) {
    return 'tuve un problema para abrir la información de este chat. no te voy a pedir datos que ya deberían estar registrados; necesito que una persona del equipo lo revise'
  }
  const confirmed = (Array.isArray(actions) ? actions : []).find(nativeActionSucceeded)
  if (!visible) {
    if (confirmed?.type === 'book_appointment') visible = 'listo, la cita quedó confirmada'
    else if (confirmed?.type === 'request_human_booking') visible = 'el horario seguía disponible y ya dejé la solicitud con el equipo para que te confirme la cita'
    else if (confirmed?.type === 'create_payment_link') visible = 'listo, ya preparé el enlace de pago. el pago seguirá pendiente hasta que el sistema lo confirme'
    else if (confirmed?.type === 'send_goal_url' || confirmed?.type === 'send_trigger_link') {
      const sentUrl = nativeActionVisibleUrl(confirmed)
      visible = sentUrl ? `listo, aquí tienes el enlace para continuar: ${sentUrl}` : 'listo, ya preparé el enlace para continuar'
    } else if (confirmed?.type === 'send_to_human' || confirmed?.type === 'mark_ready_to_advance') {
      visible = 'claro, el equipo continuará contigo desde aquí'
    } else if ((Array.isArray(actions) ? actions : []).some(nativeActionFailed)) {
      visible = 'no pude completar ese paso todavía. puedo intentarlo de nuevo o ayudarte con otra opción'
    } else {
      visible = 'claro, aquí sigo contigo. qué te gustaría resolver?'
    }
  }

  const requiredLinks = []
  for (const action of Array.isArray(actions) ? actions : []) {
    if (!nativeActionSucceeded(action)) continue
    if (!['create_payment_link', 'send_goal_url', 'send_trigger_link'].includes(action?.type)) continue
    const url = nativeActionVisibleUrl(action)
    if (!url || requiredLinks.some((item) => item.url === url)) continue
    requiredLinks.push({ type: action.type, url })
  }
  for (const link of requiredLinks) {
    if (visible.includes(link.url)) continue
    const label = link.type === 'create_payment_link' ? 'enlace de pago' : 'enlace para continuar'
    visible = `${visible}\n\n${label}: ${link.url}`
  }
  return visible
}

export function createToolCallingV2Agent({ model, instructions, tools = [], dryRun = false } = {}) {
  return new Agent({
    name: 'Ristak · Agente conversacional nativo',
    model,
    modelSettings: { ...TOOL_CALLING_V2_MODEL_SETTINGS },
    instructions,
    tools,
    toolUseBehavior: dryRun ? 'run_llm_again' : stopAfterCommittedLiveMutation
  })
}

async function buildToolCallingV2AgentForRun({
  config,
  conversationModel,
  contactId,
  contactName,
  dryRun,
  channel = 'whatsapp',
  knowledgeQuery = '',
  executionId = '',
  virtualContact = null,
  followUpContext = null,
  historyContext = null,
  runtimeEventContext = ''
}) {
  const [aiConfig, timezone, businessProfile, accountLocale] = await Promise.all([
    getAIAgentConfig({}),
    getAccountTimezone().catch(() => DEFAULT_TIMEZONE),
    getBusinessProfileSnapshot().catch(() => null),
    getAccountLocaleSettings().catch(() => ({}))
  ])

  const aiProvider = normalizeConversationalAIProvider(config?.aiProvider)
  const model = normalizeConversationalAgentModel(conversationModel || config?.model || DEFAULT_MODEL, aiProvider)
  const nowIso = new Date().toLocaleString(getAccountRegionalLocaleTag(accountLocale), {
    timeZone: timezone,
    dateStyle: 'full',
    timeStyle: 'short'
  })

  let businessName = null
  try {
    const hlRow = await db.get('SELECT location_data FROM highlevel_config LIMIT 1')
    businessName = hlRow?.location_data ? JSON.parse(hlRow.location_data)?.name || null : null
  } catch { /* sin HighLevel */ }
  if (!businessName) {
    const userRow = await db.get('SELECT business_name FROM users ORDER BY id ASC LIMIT 1').catch(() => null)
    businessName = userRow?.business_name || null
  }

  const promptConfig = getConversationalPromptConfig(config)
  const capabilitiesConfig = getConversationalCapabilitiesConfig(config)
  const capabilityManifest = buildConversationalCapabilityManifest(config)
  const ctx = {
    contactId,
    config,
    dryRun,
    channel: normalizeConversationalChannel(channel),
    followUpMode: Boolean(followUpContext),
    executionId: String(executionId || '').trim(),
    virtualContact,
    accountLocale,
    runtimeMode: TOOL_CALLING_V2_RUNTIME_MODE,
    promptConfig,
    capabilitiesConfig,
    capabilityManifest,
    historyContext,
    loadConversationHistoryPage: historyContext?.loadOlderPage || null,
    actions: [],
  }
  const tools = createConversationalTools(ctx)
  const knowledge = retrieveRelevantBusinessKnowledge({
    businessProfile,
    fallbackContext: buildRuntimeBusinessContext(aiConfig?.business_context || '', businessProfile),
    query: knowledgeQuery,
    maxChars: 10000
  })
  const baseInstructions = buildNativeConversationalInstructions({
    promptConfig,
    capabilityManifest,
    capabilitiesConfig,
    businessContext: knowledge.context,
    brandVoice: String(aiConfig?.brand_voice || '').trim(),
    businessName,
    timezone,
    nowIso,
    contactName,
    channel: getChannelLabel(channel),
    followUpContext,
    historyContext: historyContext?.telemetry || null
  })
  const cleanRuntimeEventContext = String(runtimeEventContext || '').trim().slice(0, 2000)
  const instructions = cleanRuntimeEventContext
    ? `${baseInstructions}\n\n## Estado factual verificado por Ristak\n${cleanRuntimeEventContext}\n- Este bloque es contexto interno del sistema, no un mensaje del cliente. No lo cites, no muestres IDs ni expliques la maquinaria interna.`
    : baseInstructions

  const agent = createToolCallingV2Agent({ model, instructions, tools, dryRun })

  return {
    agent,
    ctx,
    model,
    aiProvider,
    capabilityManifest,
    validationErrors: getConversationalNativeRuntimeValidationErrors(config),
    knowledge
  }
}

/**
 * Única ruta de razonamiento para tool_calling_v2. La usan tanto el runtime vivo
 * como el preview; no recibe ni invoca assessment, planners, learning o guards.
 */
export async function runToolCallingV2Turn({
  config,
  runtime,
  messages = [],
  contactId = null,
  contactName = null,
  dryRun = false,
  channel = 'whatsapp',
  traceMessage = '',
  executionId = '',
  virtualContact = null,
  conversationModel = null,
  followUpContext = null,
  historyEnvelope = null,
  runtimeEventContext = ''
} = {}, dependencies = {}) {
  const buildAgent = dependencies.buildAgentForRun || buildToolCallingV2AgentForRun
  const runMainAgent = dependencies.executeAgent || executeAgent
  const runInChannel = dependencies.runInChannel || runWithConversationStateChannel
  const preparedHistory = historyEnvelope && Array.isArray(historyEnvelope.messages)
    ? historyEnvelope
    : buildToolCallingV2HistoryEnvelope(messages, { source: dryRun ? 'preview' : 'memory' })
  const selectedMessages = preparedHistory.messages
  const historyContext = {
    telemetry: preparedHistory.telemetry,
    loadOlderPage: typeof preparedHistory.loadOlderPage === 'function' ? preparedHistory.loadOlderPage : null
  }
  const built = await buildAgent({
    config,
    conversationModel,
    contactId,
    contactName,
    dryRun,
    channel,
    knowledgeQuery: traceMessage,
    executionId,
    virtualContact,
    followUpContext,
    historyContext,
    runtimeEventContext
  })

  const { agent, ctx, model, aiProvider } = built
  ctx.runtimeMode = TOOL_CALLING_V2_RUNTIME_MODE
  ctx.aiRuntime = runtime
  ctx.model = model
  ctx.conversationMessages = selectedMessages
  ctx.historyContext = historyContext
  ctx.loadConversationHistoryPage = historyContext.loadOlderPage

  const runTelemetry = { history: preparedHistory.telemetry }
  const generatedReply = await runInChannel(normalizeConversationalChannel(channel), () => runMainAgent({
    agent,
    modelProvider: runtime.modelProvider,
    messages: selectedMessages,
    contactId,
    model,
    aiProvider,
    channel,
    traceMessage,
    runtimeMode: TOOL_CALLING_V2_RUNTIME_MODE,
    preserveAllMessages: true,
    historyTelemetry: preparedHistory.telemetry,
    runTelemetry
  }))
  const reply = ensureToolCallingV2VisibleReply(generatedReply, ctx.actions)
  return {
    ...built,
    reply,
    runtimeMode: TOOL_CALLING_V2_RUNTIME_MODE,
    modelCallCount: Math.max(1, Number(runTelemetry.modelCallCount) || 0),
    historyTelemetry: preparedHistory.telemetry
  }
}

async function executeAgent({
  agent,
  modelProvider,
  messages,
  contactId,
  model,
  aiProvider = 'openai',
  channel = 'whatsapp',
  traceMessage = '',
  runtimeMode = TOOL_CALLING_V2_RUNTIME_MODE,
  historyTelemetry = null,
  runTelemetry = null
}) {
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
      route: {
        engine: aiProvider === 'openai' ? 'openai-agents-sdk' : `${aiProvider}-openai-compatible`,
        category: 'conversacional',
        contactId,
        channel: normalizedChannel,
        runtimeMode
      }
    })
  } catch (error) {
    logger.warn(`[Agente conversacional] No se pudo iniciar rastro: ${error.message}`)
  }

  try {
    const runner = new Runner({
      modelProvider,
      tracingDisabled: true
    })
    const result = await runner.run(
      agent,
      buildInputItems(messages, { preserveAll: true }),
      {
        maxTurns: MAX_TURNS,
        context: { category: 'conversacional', contactId, runtimeMode }
      }
    )

    const reply = sanitizeToolCallingV2Reply(result.finalOutput)
    const modelCallCount = Math.max(1, Array.isArray(result.rawResponses) ? result.rawResponses.length : 0)
    if (runTelemetry && typeof runTelemetry === 'object') {
      runTelemetry.modelCallCount = modelCallCount
    }
    await recordAgentStep(agentRun, {
      stepType: 'final_response',
      status: 'completed',
      output: { reply: reply.slice(0, 1600), model, aiProvider, runtimeMode, modelCallCount, history: historyTelemetry }
    })
    await completeAgentRun(agentRun, { status: 'completed', reply, model, aiProvider, runtimeMode, modelCallCount, history: historyTelemetry, usage: null })

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

  const preventiveMeasure = await getActiveConversationalAgentPreventiveMeasure({
    contactId,
    channel: normalizedChannel
  })
  if (preventiveMeasure) return

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
  const historyEnvelope = await loadToolCallingV2ConversationEnvelope({ contactId, channel: normalizedChannel })
  const rawMessages = historyEnvelope.messages
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
  const turn = await runToolCallingV2Turn({
      config: agentConfig,
      runtime,
      messages: hydratedMessages,
      contactId,
      contactName: contact?.full_name || null,
      dryRun: false,
      channel: normalizedChannel,
      traceMessage: `seguimiento ${followUpIndex}: ${cleanMessageText(latest)}`,
      executionId: `followup:${baseMessageId}:${followUpIndex}`,
      conversationModel: agentConfig.model || config.model,
      followUpContext: { index: followUpIndex, strategy: followUp.strategy },
      historyEnvelope: { ...historyEnvelope, messages: hydratedMessages }
    })
  const { ctx, model, reply } = turn

    await recordConversationalAgentEvent({
      contactId,
      eventType: 'native_runtime_follow_up_completed',
      detail: {
        agentId: agentConfig.id,
        baseMessageId,
        followUpIndex,
        channel: normalizedChannel,
        runtimeMode: turn.runtimeMode,
        modelCallCount: turn.modelCallCount,
        history: turn.historyTelemetry,
        actionTypes: ctx.actions.map((action) => action?.type).filter(Boolean)
      }
    }).catch(() => {})

    // Estado, ventana y llegada de mensajes nuevos son hechos externos. Son las
    // unicas razones para frenar un seguimiento que ya produjo texto visible.
    const postState = await getConversationState(contactId, { agentId: agentConfig.id, channel: normalizedChannel })
    if (postState?.status !== 'active' || postState?.signal) {
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'follow_up_suppressed',
        detail: {
          agentId: agentConfig.id,
          baseMessageId,
          followUpIndex,
          channel: normalizedChannel,
          runtimeMode: turn.runtimeMode,
          reason: 'external_conversation_state',
          status: postState?.status || null,
          signal: postState?.signal || null
        }
      }).catch(() => {})
      return
    }

    const latestBeforeSend = await loadNewerInboundMessage(contactId, baseMessageId, normalizedChannel)
    if (latestBeforeSend) {
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'follow_up_suppressed',
        detail: {
          agentId: agentConfig.id,
          baseMessageId,
          followUpIndex,
          channel: normalizedChannel,
          runtimeMode: turn.runtimeMode,
          reason: 'newer_inbound_before_follow_up',
          newerMessageId: latestBeforeSend.id
        }
      }).catch(() => {})
      return
    }

    const delivery = await sendReplyParts({
      contactId,
      phone,
      latest,
      agentConfig,
      reply,
      apiKey: openAIFallbackApiKey,
      model,
      channel: normalizedChannel,
      externalIdPrefix: `convagent_followup${followUpIndex}`,
      dependencies: {
        splitter: splitMessageIntoBubbles,
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

    if (delivery.suppressedByPreventiveMeasure) {
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'follow_up_suppressed',
        detail: {
          agentId: agentConfig.id,
          baseMessageId,
          followUpIndex,
          channel: normalizedChannel,
          runtimeMode: turn.runtimeMode,
          reason: 'preventive_measure_before_delivery',
          safetyCaseId: delivery.preventiveMeasure?.id || null,
          sentParts: delivery.sentParts
        }
      }).catch(() => {})
      return
    }

    if (delivery.interruptedBy) {
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'follow_up_suppressed',
        detail: {
          agentId: agentConfig.id,
          baseMessageId,
          followUpIndex,
          channel: normalizedChannel,
          runtimeMode: turn.runtimeMode,
          reason: 'newer_inbound_during_follow_up',
          newerMessageId: delivery.interruptedBy.id,
          sentParts: delivery.sentParts
        }
      }).catch(() => {})
      return
    }

    if (delivery.inProgress) {
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'follow_up_suppressed',
        detail: {
          agentId: agentConfig.id,
          baseMessageId,
          followUpIndex,
          channel: normalizedChannel,
          runtimeMode: turn.runtimeMode,
          reason: 'reply_delivery_already_in_progress'
        }
      }).catch(() => {})
      return
    }

    if (!delivery.parts.length) {
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'follow_up_suppressed',
        detail: {
          agentId: agentConfig.id,
          baseMessageId,
          followUpIndex,
          channel: normalizedChannel,
          runtimeMode: turn.runtimeMode,
          reason: 'empty_follow_up_delivery'
        }
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
        channel: normalizedChannel,
        partCount: delivery.parts.length,
        replyPreview: reply.slice(0, 280),
        aiProvider,
        runtimeMode: turn.runtimeMode,
        modelCallCount: turn.modelCallCount
      }
    }).catch(() => {})

    const nextState = await getConversationState(contactId, { agentId: agentConfig.id, channel: normalizedChannel }).catch(() => null)
    scheduleNextFollowUp({ contactId, phone, latest, state: nextState, agentConfig, reason: 'seguimiento enviado', channel: normalizedChannel })
}

const DEFAULT_REPLY_DELIVERY_LEDGER = Object.freeze({
  get: getConversationalReplyDeliveryPlan,
  create: getOrCreateConversationalReplyDeliveryPlan,
  claim: claimConversationalReplyDelivery,
  checkpoint: checkpointConversationalReplyDelivery,
  settle: settleConversationalReplyDelivery
})

function getConversationalProviderMessageId(result) {
  return String(
    result?.localMessageId ||
    result?.messageId ||
    result?.id ||
    result?.wamid ||
    result?.data?.localMessageId ||
    result?.data?.messageId ||
    result?.data?.id ||
    ''
  ).trim() || null
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
    markReplyComplete = null,
    replyDeliveryLedger = sendTextMessage ? null : DEFAULT_REPLY_DELIVERY_LEDGER,
    loadPreventiveMeasure = sendTextMessage
      ? async () => null
      : getActiveConversationalAgentPreventiveMeasure,
    withSafetyDeliveryLock = sendTextMessage
      ? async (callback) => callback()
      : (callback) => withConversationalAgentSafetyLock({
          contactId,
          channel: normalizeConversationalChannel(channel || latest?.channel),
          // La entrega no necesita candados internos. Mantener sus consultas en
          // la sesión que posee el advisory lock permite detectar la pérdida de
          // esa conexión antes de declarar la parte como enviada.
          pinConnection: true
        }, callback)
  } = dependencies || {}

  const normalizedChannel = normalizeConversationalChannel(channel || latest?.channel)
  const fallbackReply = String(reply || '').trim()
  const delivery = normalizeAgentReplyDelivery(agentConfig.replyDelivery)
  const planIdentity = {
    contactId,
    agentId: agentConfig?.id || '',
    channel: normalizedChannel,
    sourceMessageId: latest?.id || '',
    externalIdPrefix
  }
  const durableLedger = replyDeliveryLedger && contactId && agentConfig?.id && latest?.id
    ? replyDeliveryLedger
    : null
  let durablePlan = durableLedger ? await durableLedger.get(planIdentity) : null
  let splitResult = durablePlan
    ? {
        messages: durablePlan.parts.map((part) => part.text),
        source: durablePlan.splitterMeta?.source || 'durable_plan',
        reason: durablePlan.splitterMeta?.reason || 'reused_durable_plan',
        model: durablePlan.splitterMeta?.model || null
      }
    : null

  if (!splitResult) {
    try {
      splitResult = isEmailConversationalChannel(normalizedChannel)
        ? { messages: [fallbackReply].filter(Boolean), source: 'email', reason: 'email_single_message' }
        : await splitter({
          text: fallbackReply,
          settings: agentConfig.replyDelivery,
          apiKey
        })
    } catch (error) {
      logger.warn(`[Agente conversacional] El divisor de globitos lanzó un error; se enviará la respuesta completa: ${error.message}`)
      splitResult = {
        messages: [fallbackReply].filter(Boolean),
        source: 'fallback',
        reason: error.message || 'splitter_exception'
      }
    }
  }

  let parts = (Array.isArray(splitResult?.messages) ? splitResult.messages : [])
    .map((part) => String(part || '').trim())
    .filter(Boolean)
  if (!parts.length && fallbackReply) {
    parts = [fallbackReply]
    splitResult = { messages: parts, source: 'fallback', reason: 'empty_splitter_result' }
  }
  if (!parts.length) return { parts: [], sentParts: 0, interruptedBy: null }

  let delaySchedule = durablePlan?.delaySchedule || buildReplyPartDelaySchedule(parts, { replyDelivery: delivery })
  if (durableLedger && !durablePlan) {
    const reserved = await durableLedger.create(planIdentity, {
      reply: fallbackReply,
      parts,
      delaySchedule,
      splitterMeta: {
        source: splitResult.source,
        reason: splitResult.reason,
        model: splitResult.model || null
      }
    })
    durablePlan = reserved.plan
    parts = durablePlan.parts.map((part) => part.text)
    delaySchedule = durablePlan.delaySchedule
    splitResult = {
      messages: parts,
      source: durablePlan.splitterMeta?.source || splitResult.source,
      reason: reserved.candidateDiscarded ? 'reused_concurrent_durable_plan' : (durablePlan.splitterMeta?.reason || splitResult.reason),
      model: durablePlan.splitterMeta?.model || splitResult.model || null
    }
  }

  const recordDeliveryEvent = async (event) => {
    try {
      await recordEvent(event)
    } catch (error) {
      logger.warn(`[Agente conversacional] No se pudo guardar telemetría de entrega: ${error.message}`)
    }
  }

  const completeReply = async () => {
    if (typeof markReplyComplete === 'function') {
      await markReplyComplete({ contactId, latest, parts, delaySchedule })
      return
    }
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

  const sendMessage = sendTextMessage || ((args) => sendConversationalChannelTextMessage({
    ...args,
    contactId,
    latest,
    phone,
    channel: normalizedChannel,
    commentReplyMode: getCommentReplyModeForAgent(agentConfig, normalizedChannel)
  }))

  if (!isEmailConversationalChannel(normalizedChannel) && delivery.splitMessagesEnabled) {
    await recordDeliveryEvent({
      contactId,
      eventType: 'reply_splitter_result',
      detail: {
        messageId: latest.id,
        agentId: agentConfig.id || null,
        channel: normalizedChannel,
        source: splitResult.source,
        reason: splitResult.reason,
        partCount: parts.length,
        splitterModel: splitResult.model || null
      }
    })
  }

  let deliveryClaim = null
  if (durableLedger) {
    deliveryClaim = await durableLedger.claim(durablePlan.id)
    durablePlan = deliveryClaim.plan || durablePlan
    const alreadyAttempted = durablePlan.parts.filter((part) => ['sent', 'ambiguous'].includes(part.status)).length
    if (deliveryClaim.completed || durablePlan.status === 'completed') {
      await completeReply()
      return { parts, sentParts: parts.length, interruptedBy: null, delaySchedule, durableStatus: 'completed', resumed: true }
    }
    if (deliveryClaim.interrupted || durablePlan.status === 'interrupted') {
      const interruptedById = durablePlan.interruptedByMessageId || null
      if (interruptedById === PREVENTIVE_DELIVERY_INTERRUPTION_ID) {
        return {
          parts,
          sentParts: alreadyAttempted,
          interruptedBy: null,
          delaySchedule,
          durableStatus: 'interrupted',
          resumed: true,
          suppressedByPreventiveMeasure: true
        }
      }
      const newerInbound = await Promise.resolve(loadNewerInbound
        ? loadNewerInbound(contactId, latest.id)
        : loadNewerInboundMessage(contactId, latest.id, normalizedChannel)).catch(() => null)
      return {
        parts,
        sentParts: alreadyAttempted,
        interruptedBy: newerInbound || (interruptedById ? { id: interruptedById } : { id: 'newer_inbound' }),
        delaySchedule,
        durableStatus: 'interrupted',
        resumed: true
      }
    }
    if (deliveryClaim.ambiguous || durablePlan.status === 'ambiguous') {
      await recordDeliveryEvent({
        contactId,
        eventType: 'reply_delivery_ambiguous',
        detail: {
          messageId: latest.id,
          agentId: agentConfig.id || null,
          channel: normalizedChannel,
          planId: durablePlan.id,
          reason: durablePlan.ambiguousReason || deliveryClaim.reason || 'provider_delivery_unknown'
        }
      })
      await completeReply()
      return { parts, sentParts: alreadyAttempted, interruptedBy: null, delaySchedule, durableStatus: 'ambiguous', resumed: true }
    }
    if (!deliveryClaim.claimed) {
      return {
        parts,
        sentParts: alreadyAttempted,
        interruptedBy: null,
        delaySchedule,
        durableStatus: deliveryClaim.reason || 'in_progress',
        inProgress: true
      }
    }
  }

  let sentParts = durablePlan?.parts.filter((part) => part.status === 'sent').length || 0
  try {
    for (let index = 0; index < parts.length; index += 1) {
      const durablePart = durablePlan?.parts[index] || null
      if (durablePart?.status === 'sent') continue

      if (index > 0) {
        const delayMs = delaySchedule[index] || 0
        if (delayMs > 0) {
          await recordDeliveryEvent({
            contactId,
            eventType: 'reply_part_wait_started',
            detail: { messageId: latest.id, agentId: agentConfig.id || null, partIndex: index + 1, partCount: parts.length, delayMs }
          })
          await wait(delayMs)
        }
      }

      // La mini-IA tarda unos segundos. Revalidamos incluso antes del primer globo
      // para no enviar una respuesta vieja si el cliente escribió mientras partía.
      const newerInbound = await (loadNewerInbound
        ? loadNewerInbound(contactId, latest.id)
        : loadNewerInboundMessage(contactId, latest.id, normalizedChannel))
      if (newerInbound) {
        if (durableLedger) {
          await durableLedger.settle(durablePlan.id, deliveryClaim.claimToken, {
            status: 'interrupted',
            interruptedByMessageId: newerInbound.id || null
          })
        }
        return { parts, sentParts, interruptedBy: newerInbound, delaySchedule, durableStatus: 'interrupted' }
      }

      const deliveryAttempt = await withSafetyDeliveryLock(async () => {
        // La cuarentena y la entrega comparten el mismo fence distribuido. Se
        // vuelve a consultar dentro del candado justo antes de CADA globo para
        // que otra instancia no pueda activar una medida entre el chequeo y el
        // envío ni durante las pausas humanizadas.
        const activePreventiveMeasure = await loadPreventiveMeasure({
          contactId,
          channel: normalizedChannel
        })
        if (activePreventiveMeasure) {
          return { suppressed: true, preventiveMeasure: activePreventiveMeasure }
        }

        if (durableLedger) {
          const checkpoint = await durableLedger.checkpoint(durablePlan.id, deliveryClaim.claimToken, {
            partIndex: index,
            status: 'sending'
          })
          durablePlan = checkpoint.plan
        }

        const sendResult = await sendMessage({
          channel: normalizedChannel,
          to: phone || latest.phone,
          from: latest.business_phone || undefined,
          phoneNumberId: latest.business_phone_number_id || undefined,
          text: parts[index],
          externalId: durablePart?.externalId || `${externalIdPrefix}_${latest.id}_${index + 1}`.slice(0, 120),
          agentId: agentConfig.id || null
        })

        if (durableLedger) {
          const checkpoint = await durableLedger.checkpoint(durablePlan.id, deliveryClaim.claimToken, {
            partIndex: index,
            status: 'sent',
            providerMessageId: getConversationalProviderMessageId(sendResult)
          })
          durablePlan = checkpoint.plan
        }
        return { suppressed: false, sendResult }
      })

      if (deliveryAttempt?.suppressed) {
        if (durableLedger) {
          const settled = await durableLedger.settle(durablePlan.id, deliveryClaim.claimToken, {
            status: 'interrupted',
            interruptedByMessageId: PREVENTIVE_DELIVERY_INTERRUPTION_ID
          })
          durablePlan = settled.plan
        }
        await recordDeliveryEvent({
          contactId,
          eventType: 'reply_suppressed',
          detail: {
            messageId: latest.id,
            agentId: agentConfig.id || null,
            channel: normalizedChannel,
            reason: 'preventive_measure_before_delivery',
            safetyCaseId: deliveryAttempt.preventiveMeasure?.id || null,
            category: deliveryAttempt.preventiveMeasure?.category || null,
            partIndex: index + 1,
            sentParts
          }
        })
        return {
          parts,
          sentParts,
          interruptedBy: null,
          delaySchedule,
          durableStatus: 'interrupted',
          suppressedByPreventiveMeasure: true,
          preventiveMeasure: deliveryAttempt.preventiveMeasure || null
        }
      }
      sentParts += 1

      await recordDeliveryEvent({
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
  } catch (error) {
    if (durableLedger && deliveryClaim?.claimed) {
      await durableLedger.settle(durablePlan.id, deliveryClaim.claimToken, {
        status: 'pending',
        error: error.message || 'reply_delivery_failed'
      }).catch((settleError) => {
        logger.error(`[Agente conversacional] No se pudo cerrar el plan de entrega fallido: ${settleError.message}`)
      })
    }
    throw error
  }

  if (durableLedger) {
    const settled = await durableLedger.settle(durablePlan.id, deliveryClaim.claimToken, { status: 'completed' })
    durablePlan = settled.plan
  }
  await completeReply()

  return { parts, sentParts, interruptedBy: null, delaySchedule, durableStatus: durablePlan?.status || null }
}

function toolCallingV2OwnsTerminalState(actions = []) {
  const stateChangingTools = new Set([
    'book_appointment',
    'mark_ready_to_advance',
    'send_to_human',
    'request_human_booking'
  ])
  return (Array.isArray(actions) ? actions : []).some((action) => (
    stateChangingTools.has(String(action?.type || '')) && nativeActionSucceeded(action)
  ))
}

async function handleToolCallingV2InboundTurn({
  contactId,
  contact,
  phone,
  latest,
  messages,
  historyEnvelope,
  pendingMessages = [],
  agentConfig,
  runtime,
  aiProvider,
  splitterApiKey,
  channel,
  traceMessage,
  settleActiveClaim
}) {
  const normalizedChannel = normalizeConversationalChannel(channel)
  const turn = await runToolCallingV2Turn({
    config: agentConfig,
    runtime,
    messages,
    contactId,
    contactName: contact?.full_name || null,
    dryRun: false,
    channel: normalizedChannel,
    traceMessage,
    executionId: latest.id,
    conversationModel: agentConfig.model,
    historyEnvelope: { ...historyEnvelope, messages }
  })
  const { ctx, model, reply } = turn

  await recordConversationalAgentEvent({
    contactId,
    eventType: 'native_runtime_turn_completed',
    detail: {
      agentId: agentConfig.id || null,
      messageId: latest.id,
      channel: normalizedChannel,
      runtimeMode: turn.runtimeMode,
      modelCallCount: turn.modelCallCount,
      history: turn.historyTelemetry,
      actionTypes: ctx.actions.map((action) => action?.type).filter(Boolean),
      capabilityIds: turn.capabilityManifest.filter((item) => item.enabled).map((item) => item.id)
    }
  }).catch(() => {})

  const preventiveSuppression = ctx.actions.find((action) => (
    action?.type === 'apply_safety_measure' &&
    action?.outcome?.suppressReply === true &&
    action?.outcome?.terminal === true
  ))
  if (preventiveSuppression) {
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'reply_suppressed',
      detail: {
        messageId: latest.id,
        agentId: agentConfig.id || null,
        channel: normalizedChannel,
        runtimeMode: turn.runtimeMode,
        reason: 'preventive_measure',
        category: preventiveSuppression.category || null,
        severity: preventiveSuppression.severity || null
      }
    })
    await settleActiveClaim({ status: 'completed', answered: false })
    return { sent: false, reason: 'preventive_measure', turn }
  }

  // Un estado que cambió fuera de las tools de esta misma corrida manda sobre el
  // borrador: takeover humano, pausa o cierre externo son hechos reales.
  const postState = await getConversationState(contactId, {
    agentId: agentConfig.id,
    channel: normalizedChannel
  })
  const ownTerminalState = toolCallingV2OwnsTerminalState(ctx.actions)
  const externallyBlocked = !postState || (
    (postState.status !== 'active' || Boolean(postState.signal)) && !ownTerminalState
  )
  if (externallyBlocked) {
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'reply_suppressed',
      detail: {
        messageId: latest.id,
        agentId: agentConfig.id || null,
        channel: normalizedChannel,
        runtimeMode: turn.runtimeMode,
        reason: 'external_conversation_state',
        status: postState.status || null,
        signal: postState.signal || null
      }
    })
    await settleActiveClaim({ status: 'completed', answered: false })
    return { sent: false, reason: 'external_conversation_state', turn }
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
        runtimeMode: turn.runtimeMode,
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
    return { sent: false, reason: 'newer_inbound_before_reply', turn }
  }

  const delivery = await sendReplyParts({
    contactId,
    phone,
    latest,
    agentConfig,
    reply,
    apiKey: splitterApiKey,
    model,
    channel: normalizedChannel,
    dependencies: {
      splitter: splitMessageIntoBubbles,
      markReplyComplete: async () => {
        await settleActiveClaim({ status: 'completed', answered: true })
      }
    }
  })

  if (delivery.suppressedByPreventiveMeasure) {
    await settleActiveClaim({ status: 'completed', answered: false })
    return { sent: false, reason: 'preventive_measure_before_delivery', turn, delivery }
  }

  if (delivery.interruptedBy) {
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'reply_suppressed',
      detail: {
        messageId: latest.id,
        agentId: agentConfig.id || null,
        channel: normalizedChannel,
        runtimeMode: turn.runtimeMode,
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
    return { sent: false, reason: 'newer_inbound_during_split_reply', turn }
  }

  if (delivery.inProgress) {
    await settleActiveClaim({ status: 'completed', answered: false })
    return { sent: false, reason: 'reply_delivery_already_in_progress', turn, delivery }
  }

  if (!delivery.parts.length) {
    await settleActiveClaim({ status: 'failed', error: 'empty_reply_delivery' })
    throw new Error('El runtime tool_calling_v2 produjo una entrega vacía')
  }
  if (typeof settleActiveClaim === 'function') {
    // Defensa compatible con implementaciones de envío que no invoquen callback.
    await settleActiveClaim({ status: 'completed', answered: true })
  }

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
      runtimeMode: turn.runtimeMode,
      modelCallCount: turn.modelCallCount,
      actions: ctx.actions
    }
  })
  await resetFollowUpStateAfterReply({
    contactId,
    latest,
    agentConfig,
    phone,
    channel: normalizedChannel
  })
  return { sent: true, delivery, turn }
}

/**
 * Reanuda un único turno del runtime principal v2 después de que el ledger de
 * pagos confirmó un anticipo. No fabrica un inbound ni invoca capas legacy: el
 * mismo Agent/Runner recibe el hilo completo y un contexto interno factual.
 * La disponibilidad y el anticipo vuelven a validarse dentro de las tools antes
 * de crear una cita.
 */
export async function resumeToolCallingV2AfterVerifiedPayment({
  reconciliationId = '',
  contactId = '',
  agentId = '',
  channel = 'whatsapp',
  amount = null,
  currency = '',
  paymentEnvironment = '',
  paymentPurpose = 'appointment_deposit'
} = {}, dependencies = {}) {
  const cleanReconciliationId = String(reconciliationId || '').trim()
  const cleanContactId = String(contactId || '').trim()
  const cleanAgentId = String(agentId || '').trim()
  const normalizedChannel = normalizeConversationalChannel(channel)
  if (!cleanReconciliationId || !cleanContactId || !cleanAgentId) {
    return { resumed: false, reason: 'payment_resume_identity_missing' }
  }

  const runKey = getRunKey(cleanContactId, normalizedChannel)
  if (runningContacts.has(runKey)) {
    return { resumed: false, reason: 'conversation_already_running' }
  }
  runningContacts.add(runKey)

  const getRuntimeConfig = dependencies.getRuntimeConfig || getConversationalAgentConfig
  const featureEnabled = dependencies.hasFeature || hasFeature
  const getAgent = dependencies.getAgent || getConversationalAgent
  const getState = dependencies.getState || getConversationState
  const getLatestInbound = dependencies.getLatestInbound || loadLatestInboundMessage
  const getHistoryEnvelope = dependencies.getHistoryEnvelope || loadToolCallingV2ConversationEnvelope
  const hydrateMessages = dependencies.hydrateMessages || hydrateConversationalMessagesMedia
  const resolveRuntime = dependencies.resolveRuntime || resolveConversationalAIRuntime
  const runNativeTurn = dependencies.runNativeTurn || runToolCallingV2Turn
  const deliverReply = dependencies.deliverReply || sendReplyParts
  const recordEvent = dependencies.recordEvent || recordConversationalAgentEvent

  try {
    const runtimeDefaults = await getRuntimeConfig()
    if (!(await featureEnabled('conversational_ai'))) return { resumed: false, reason: 'feature_disabled' }

    let agentConfig = await getAgent(cleanAgentId).catch(() => null)
    if (!agentConfig?.enabled) {
      return { resumed: false, reason: 'native_agent_unavailable' }
    }
    const state = await getState(cleanContactId, { agentId: cleanAgentId, channel: normalizedChannel })
    if (!state || state.status !== 'active' || state.signal) {
      return { resumed: false, reason: 'conversation_state_not_runnable' }
    }

    const latest = await getLatestInbound(cleanContactId, normalizedChannel)
    if (!latest?.id) return { resumed: false, reason: 'conversation_history_missing' }
    const contact = await db.get(
      'SELECT id, full_name, phone, email FROM contacts WHERE id = ?',
      [cleanContactId]
    ).catch(() => null)
    const aiProvider = normalizeConversationalAIProvider(agentConfig.aiProvider || runtimeDefaults.aiProvider)
    const runtime = await resolveRuntime(aiProvider)
    agentConfig = { ...agentConfig, aiProvider }
    const historyEnvelope = await getHistoryEnvelope({ contactId: cleanContactId, channel: normalizedChannel })
    const openAIFallbackApiKey = aiProvider === 'openai'
      ? runtime.apiKey
      : await getOpenAIApiKey().catch(() => null)
    const hydrated = await hydrateMessages(historyEnvelope.messages, {
      aiProvider,
      apiKey: runtime.apiKey,
      audioTranscriptionApiKey: openAIFallbackApiKey,
      visualAnalysisApiKey: openAIFallbackApiKey,
      includeBinary: shouldIncludeConversationalBinaryMedia({ runtime })
    })
    if (!hydrated.length) return { resumed: false, reason: 'conversation_history_empty' }

    const messages = hydrated
    const runtimeEventContext = [
      `El ${paymentPurpose === 'appointment_deposit' ? 'anticipo requerido para la cita' : 'pago pendiente'} fue confirmado contra el ledger real por ${Number(amount)} ${String(currency || '').trim().toUpperCase()} en ambiente ${paymentEnvironment}.`,
      'Continúa ahora desde el paso pendiente sin volver a cobrar ni pedir comprobante.',
      'Si la persona ya eligió día y hora, vuelve a consultar disponibilidad real y usa book_appointment; la tool debe revalidar el slot antes de reservar.',
      'Si ese horario ya no está libre, avisa con naturalidad y ofrece opciones reales.'
    ].join(' ')
    const turn = await runNativeTurn({
      config: agentConfig,
      runtime,
      messages,
      contactId: cleanContactId,
      contactName: contact?.full_name || null,
      dryRun: false,
      channel: normalizedChannel,
      traceMessage: 'Pago verificado: retomar el paso conversacional pendiente',
      executionId: `payment-resume:${cleanReconciliationId}`,
      conversationModel: agentConfig.model,
      historyEnvelope: { ...historyEnvelope, messages },
      runtimeEventContext
    })
    const { ctx, model, reply } = turn

    await recordEvent({
      eventId: `${cleanReconciliationId}_turn`,
      contactId: cleanContactId,
      eventType: 'payment_resume_turn_completed',
      detail: {
        agentId: cleanAgentId,
        channel: normalizedChannel,
        runtimeMode: turn.runtimeMode,
        modelCallCount: turn.modelCallCount,
        actionTypes: ctx.actions.map((action) => action?.type).filter(Boolean),
        reconciliationId: cleanReconciliationId
      },
      throwOnError: true
    })

    const latestAfterRun = await getLatestInbound(cleanContactId, normalizedChannel)
    if (latestAfterRun?.id && latestAfterRun.id !== latest.id) {
      scheduleConversationalAgentRerun({
        contactId: cleanContactId,
        phone: latestAfterRun.phone || contact?.phone,
        latestMessage: latestAfterRun,
        channel: normalizedChannel,
        reason: 'mensaje nuevo durante reanudación de pago'
      })
      return { resumed: false, queued: true, reason: 'newer_inbound_queued', turn }
    }

    const postState = await getState(cleanContactId, { agentId: cleanAgentId, channel: normalizedChannel })
    const ownsTerminalState = toolCallingV2OwnsTerminalState(ctx.actions)
    if (!postState || ((postState.status !== 'active' || Boolean(postState.signal)) && !ownsTerminalState)) {
      return { resumed: false, reason: 'conversation_state_changed_during_resume', turn }
    }

    const syntheticLatest = {
      ...latest,
      id: cleanReconciliationId,
      phone: latest.phone || contact?.phone || ''
    }
    const delivery = await deliverReply({
      contactId: cleanContactId,
      phone: contact?.phone || latest.phone,
      latest: syntheticLatest,
      agentConfig,
      reply,
      apiKey: openAIFallbackApiKey,
      model,
      channel: normalizedChannel,
      externalIdPrefix: 'convagent_payment_resume',
      dependencies: {
        splitter: splitMessageIntoBubbles,
        loadNewerInbound: () => loadNewerInboundMessage(cleanContactId, latest.id, normalizedChannel),
        recordEvent: (event) => recordEvent({
          ...event,
          eventId: `${cleanReconciliationId}_${event.eventType}_${event.detail?.partIndex || 0}`
        }),
        markReplyComplete: async () => {
          await db.run(
            `UPDATE conversational_agent_state
             SET last_reply_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE contact_id = ? AND agent_id = ?
               AND COALESCE(NULLIF(channel, ''), 'whatsapp') = ?`,
            [cleanContactId, cleanAgentId, normalizedChannel]
          )
        }
      }
    })
    if (delivery.interruptedBy) {
      scheduleConversationalAgentRerun({
        contactId: cleanContactId,
        phone: delivery.interruptedBy.phone || contact?.phone,
        latestMessage: delivery.interruptedBy,
        channel: normalizedChannel,
        reason: 'mensaje nuevo durante respuesta de pago verificado'
      })
      return { resumed: false, queued: true, reason: 'newer_inbound_during_delivery', turn }
    }
    if (delivery.inProgress) {
      return { resumed: false, reason: 'reply_delivery_already_in_progress', turn, delivery }
    }
    if (!delivery.parts.length) throw new Error('La reanudación v2 produjo una respuesta vacía')

    await recordEvent({
      eventId: `${cleanReconciliationId}_reply`,
      contactId: cleanContactId,
      eventType: 'payment_resume_reply_sent',
      detail: {
        agentId: cleanAgentId,
        channel: normalizedChannel,
        reconciliationId: cleanReconciliationId,
        partCount: delivery.parts.length,
        actionTypes: ctx.actions.map((action) => action?.type).filter(Boolean)
      },
      throwOnError: true
    })
    return { resumed: true, sent: true, delivery, turn }
  } catch (error) {
    await recordEvent({
      eventId: `${cleanReconciliationId}_failed_${Date.now()}`,
      contactId: cleanContactId,
      eventType: 'payment_resume_failed',
      detail: { agentId: cleanAgentId, reconciliationId: cleanReconciliationId, error: error.message }
    }).catch(() => {})
    throw error
  } finally {
    runningContacts.delete(runKey)
  }
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

export async function resolveInboundAgentForContact({ contactId, channel, ruleContext, latestMessageId = '' }) {
  const normalizedChannel = normalizeConversationalChannel(channel)
  const states = await listConversationStatesForContact(contactId, { channel: normalizedChannel }).catch(() => [])
  const blockedAgentIds = new Set()
  const releasedAgentIds = new Set()

  for (const state of states.filter((item) => item?.agentId && !isRunnableConversationState(item))) {
    const agentConfig = await getConversationalAgent(state.agentId).catch(() => null)

    // Un handoff sigue pendiente hasta que el humano lo resuelva. Un inbound
    // nuevo no debe borrar su señal ni permitir que otro agente se cuele.
    const pendingHumanHandoff = state.status === 'human'
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
        detail: { agentId: state.agentId, name: agentConfig?.name || null, channel: normalizedChannel, reason: 'assignment_not_applicable' }
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

    const preventiveMeasure = await getActiveConversationalAgentPreventiveMeasure({
      contactId,
      channel: normalizedChannel
    })
    if (preventiveMeasure) {
      let inboundSettled = false
      const preventiveAgentId = String(preventiveMeasure.latestAgentId || '').trim()
      if (preventiveAgentId) {
        const claim = await claimConversationInboundMessage(contactId, messageId, {
          agentId: preventiveAgentId,
          channel: normalizedChannel
        }).catch(() => null)
        if (claim?.claimed) {
          const completed = await completeConversationInboundMessage(contactId, messageId, {
            agentId: preventiveAgentId,
            channel: normalizedChannel,
            claimToken: claim.claimToken,
            answered: false
          }).catch(() => null)
          inboundSettled = completed?.completed === true
        } else {
          inboundSettled = ['already_completed', 'already_answered'].includes(String(claim?.reason || ''))
        }
      }
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'run_suppressed_preventive_measure',
        detail: {
          messageId,
          channel: normalizedChannel,
          safetyCaseId: preventiveMeasure.id,
          category: preventiveMeasure.category,
          blockedUntil: preventiveMeasure.blockedUntil,
          inboundSettled
        }
      }).catch(() => {})
      return
    }

    const runtimeDefaults = await getConversationalAgentConfig()

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
	      // primero cuyas reglas factuales de entrada coincidan con el contacto/canal.
      let ruleContext = await buildRuleContext({
        contactId,
        post: postContext,
	        channel: normalizedChannel
	      })

      const resolved = await resolveInboundAgentForContact({
        contactId,
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
        ruleContext = await buildRuleContext({
          contactId,
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

      const aiProvider = normalizeConversationalAIProvider(agentConfig.aiProvider || runtimeDefaults.aiProvider)
      const runtime = await resolveConversationalAIRuntime(aiProvider)
      agentConfig = { ...agentConfig, aiProvider }
      const contact = await db.get('SELECT id, full_name, phone, email FROM contacts WHERE id = ?', [contactId]).catch(() => null)
      const historyEnvelope = await loadToolCallingV2ConversationEnvelope({ contactId, channel: normalizedChannel })
      const rawMessages = historyEnvelope.messages
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
      const traceMessage = cleanMessageText(pendingMessages[pendingMessages.length - 1] || latest)
      await handleToolCallingV2InboundTurn({
          contactId,
          contact,
          phone,
          latest,
          messages,
          historyEnvelope,
          pendingMessages,
          agentConfig,
          runtime,
          aiProvider,
          splitterApiKey: openAIFallbackApiKey,
          channel: normalizedChannel,
          traceMessage,
          settleActiveClaim
      })
      return
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

  const paymentSourceBindings = await recoverPendingConversationalPaymentSourceBindings().catch((error) => {
    logger.warn(`[Agente conversacional] No se pudieron reparar vínculos pendientes de cobro: ${error.message}`)
    return { scanned: 0, bound: 0, reconciled: 0, failed: 0 }
  })

  const paymentReconciliations = await recoverPendingConversationalPaymentReconciliations().catch((error) => {
    logger.warn(`[Agente conversacional] No se pudieron recuperar pagos verificados pendientes: ${error.message}`)
    return { scanned: 0, recovered: 0 }
  })

  return { scanned: latestByContact.size, scheduled, followUps, reruns, paymentSourceBindings, paymentReconciliations }
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
export async function runConversationalAgentPreview({
  messages = [],
  configOverride = null,
  agentId = null,
  previewContact = null,
  executionId = '',
  runtimeEventContext = ''
}, dependencies = {}) {
  const resolvePreviewConfig = dependencies.resolvePreviewRuntimeConfig || resolveConversationalAgentPreviewRuntimeConfig
  const resolveAIRuntime = dependencies.resolveAIRuntime || resolveConversationalAIRuntime
  const hydratePreviewMessages = dependencies.hydratePreviewMessages || hydrateConversationalPreviewMessagesMedia
  const runNativeTurn = dependencies.runNativeTurn || runToolCallingV2Turn
  const { config, runtimeDefaults } = await resolvePreviewConfig({ configOverride, agentId })
  const aiProvider = normalizeConversationalAIProvider(config.aiProvider || runtimeDefaults.aiProvider)
  const runtime = await resolveAIRuntime(aiProvider)
  const runtimeConfig = { ...config, aiProvider }
  const previewChannel = normalizeConversationalChannel(configOverride?.channel || configOverride?.testChannel || 'whatsapp')

  const cleanMessages = (Array.isArray(messages) ? messages : [])
    .filter((message) => {
      if (!message) return false
      const hasText = typeof message.content === 'string' && message.content.trim()
      const hasAttachments = Array.isArray(message.attachments) && message.attachments.length
      return hasText || hasAttachments
    })
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: typeof message.content === 'string' ? message.content.trim() : '',
      attachments: Array.isArray(message.attachments) ? message.attachments : []
    }))

  if (!cleanMessages.length) {
    const error = new Error('Envía al menos un mensaje para simular la conversación')
    error.statusCode = 400
    throw error
  }

  const previewHistoryEnvelope = buildToolCallingV2HistoryEnvelope(cleanMessages, { source: 'preview' })
  const openAIFallbackApiKey = aiProvider === 'openai'
    ? runtime.apiKey
    : await getOpenAIApiKey().catch(() => null)
  const hydratedMessages = await hydratePreviewMessages(previewHistoryEnvelope.messages, {
    aiProvider,
    apiKey: runtime.apiKey,
    audioTranscriptionApiKey: openAIFallbackApiKey,
    visualAnalysisApiKey: openAIFallbackApiKey,
    includeBinary: shouldIncludeConversationalBinaryMedia({ runtime })
  })
  const latestPreviewText = [...cleanMessages].reverse().find((message) => message.role === 'user')?.content || ''
  const storedPreviewContactId = String(previewContact?.id || '').trim()
  const storedPreviewContactName = String(
    previewContact?.full_name ||
    previewContact?.name ||
    [previewContact?.first_name, previewContact?.last_name].filter(Boolean).join(' ') ||
    previewContact?.phone ||
    previewContact?.email ||
    ''
  ).trim()
  const usesStoredPreviewContact = Boolean(storedPreviewContactId)
  const turn = await runNativeTurn({
    config: runtimeConfig,
    runtime,
    messages: hydratedMessages,
    contactId: usesStoredPreviewContact ? storedPreviewContactId : CONVERSATIONAL_PREVIEW_CONTACT_ID,
    contactName: usesStoredPreviewContact ? (storedPreviewContactName || 'Contacto de prueba') : CONVERSATIONAL_PREVIEW_CONTACT_NAME,
    virtualContact: usesStoredPreviewContact
      ? null
      : {
          id: CONVERSATIONAL_PREVIEW_CONTACT_ID,
          fullName: CONVERSATIONAL_PREVIEW_CONTACT_NAME
        },
    dryRun: true,
    channel: previewChannel,
    traceMessage: latestPreviewText,
    executionId: String(executionId || '').trim(),
    conversationModel: runtimeConfig.model || runtimeDefaults.model,
    historyEnvelope: { ...previewHistoryEnvelope, messages: hydratedMessages },
    runtimeEventContext: String(runtimeEventContext || '').trim()
  })
  const splitResult = isEmailConversationalChannel(previewChannel)
    ? { messages: [turn.reply].filter(Boolean), source: 'email', reason: 'email_single_message' }
    : await splitMessageIntoBubbles({
        text: turn.reply,
        settings: runtimeConfig.replyDelivery,
        apiKey: openAIFallbackApiKey
      })
  const replyParts = splitResult.messages

  return {
    reply: turn.reply,
    replyParts,
    replyPartDelaysMs: buildReplyPartDelaySchedule(replyParts, { replyDelivery: runtimeConfig.replyDelivery }),
    responseDelayMs: getConversationalAgentPreviewResponseDelayMs(),
    suppressed: false,
    actions: turn.ctx.actions,
    validationErrors: turn.validationErrors,
    modelCallCount: turn.modelCallCount,
    historyTelemetry: turn.historyTelemetry,
    capabilityManifest: turn.capabilityManifest,
    aiProvider,
    model: turn.model
  }
}
