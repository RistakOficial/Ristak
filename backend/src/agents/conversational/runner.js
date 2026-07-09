import { Agent, Runner } from '@openai/agents'
import { db } from '../../config/database.js'
import { logger } from '../../utils/logger.js'
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
  setConversationStatus,
  buildRuleContext,
  exitRulesMatch,
  contactIsOutOfScopeForAgent,
  isStaleInheritedConversationStateForAgent,
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
  getAccountRegionalLocaleTag,
  getClosingChannelLabel
} from './prompt.js'
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

const HISTORY_LIMIT = 20
const MAX_TURNS = 10
const DEFAULT_MODEL = process.env.OPENAI_CONVERSATIONAL_AGENT_MODEL || DEFAULT_OPENAI_MODEL
const MAX_REPLY_CHARS = 1000
const DEBOUNCE_MS = 4000
const PENDING_INBOUND_LIMIT = 8
const PENDING_INBOUND_SCAN_LIMIT = 30
const PENDING_RECOVERY_SCAN_LIMIT = 80
const PENDING_RECOVERY_SCHEDULE_LIMIT = 10
const PENDING_RECOVERY_MAX_AGE_MS = Number(process.env.CONVERSATIONAL_AGENT_PENDING_RECOVERY_MAX_AGE_MS || 60 * 60 * 1000)
const FOLLOW_UP_RECOVERY_SCAN_LIMIT = 80
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
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
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
  const messageMs = toTimestampMs(
    latestMessage.message_timestamp ||
    latestMessage.messageTimestamp ||
    latestMessage.created_at ||
    latestMessage.createdAt
  )
  if (!messageMs) return false
  if (maxAgeMs > 0 && nowMs - messageMs > maxAgeMs) return false
  if (state?.status && state.status !== 'active') return false
  if (state?.lastAnsweredInboundMessageId === latestMessage.id || state?.last_answered_inbound_message_id === latestMessage.id) {
    return false
  }

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

function buildRuntimeBusinessContext(rawContext = '', businessProfile = null) {
  const parts = []
  const profileSummary = compactText(businessProfile?.summary, 2400)
  if (businessProfile?.configured && profileSummary) {
    parts.push(`Perfil estructurado del negocio:\n${profileSummary}`)
  }
  const cleanRawContext = compactText(rawContext, 4000)
  if (cleanRawContext) {
    parts.push(`Contexto original guardado por el negocio:\n${cleanRawContext}`)
  }
  return parts.join('\n\n').trim()
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
	      'SELECT closing_context_json FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ? LIMIT 1',
	      [contactId, config?.id || null]
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

async function loadRecentInboundMessagesForRecovery(channel = 'whatsapp', limit = PENDING_RECOVERY_SCAN_LIMIT) {
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
      LIMIT ?
    `, [platform, limit]).catch(() => [])
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
      LIMIT ?
    `, [normalizedChannel, limit]).catch(() => [])
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
      LIMIT ?
    `, [limit]).catch(() => [])
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
    LIMIT ?
  `, [limit]).catch(() => [])
  return rows.map((row) => ({ ...rowToConversationalMessage(row, normalizedChannel), contact_id: row.contact_id }))
}

async function buildAgentForRun({ config, conversationModel, contactId, contactName, dryRun, channel = 'whatsapp', ruleContext = null, followUpContext = null }) {
  const [aiConfig, timezone, businessProfile, accountLocale] = await Promise.all([
    getAIAgentConfig({}),
    getAccountTimezone().catch(() => DEFAULT_TIMEZONE),
    getBusinessProfileSnapshot().catch(() => null),
    getAccountLocaleSettings().catch(() => ({ countryCode: 'MX', currency: 'MXN', dialCode: '52' }))
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

  const ctx = { contactId, config, dryRun, followUpMode: Boolean(followUpContext), accountLocale, actions: [], suppressReply: false }
  const tools = createConversationalTools(ctx)
  const runtimeBusinessContext = buildRuntimeBusinessContext(aiConfig?.business_context || '', businessProfile)
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
    followUpContext
  })

  const agent = new Agent({
    name: 'Ristak · Agente conversacional',
    model,
    instructions,
    tools
  })

  return { agent, ctx, model, aiProvider }
}

async function executeAgent({ agent, modelProvider, messages, contactId, model, aiProvider = 'openai', channel = 'whatsapp', traceMessage = '' }) {
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

async function loadNewerInboundMessage(contactId, handledMessageId, channel = 'whatsapp') {
  const latest = await loadLatestInboundMessage(contactId, channel)
  return latest && latest.id !== handledMessageId ? latest : null
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
    `, [contactId, agentId]).catch(() => {})
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
  `, [latest.id, contactId, agentId])

  const state = await getConversationState(contactId, { agentId }).catch(() => null)
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
      await sendMetaSocialCommentReply({ contactId, platform, message: text, replyType: 'public', externalId })
        .catch((error) => { logger.warn(`[Agente] Respuesta pública a comentario falló: ${error.message}`) })
      return sendMetaSocialCommentReply({ contactId, platform, message: text, replyType: 'private', externalId })
    }
    return sendMetaSocialCommentReply({
      contactId,
      platform,
      message: text,
      replyType: mode === 'public' ? 'public' : 'private',
      externalId
    })
  }

  if (normalizedChannel === EMAIL_CONVERSATIONAL_CHANNEL) {
    const { sendEmailToContact } = await import('../../services/emailService.js')
    return sendEmailToContact({
      contactId,
      to: latest.from_email || latest.to_email || undefined,
      subject: getEmailSubjectForReply(latest),
      text,
      externalId
    })
  }

  if (shouldSendConversationalReplyThroughHighLevel({ channel: normalizedChannel, latest })) {
    const { sendHighLevelConversationMessageCore } = await import('../../controllers/highlevelController.js')
    return sendHighLevelConversationMessageCore({
      contactId,
      channel: getHighLevelReplyChannel({ channel: normalizedChannel, latest }),
      message: text,
      toNumber: phone || latest.phone || undefined,
      externalId
    }, { markHumanTakeover: false })
  }

  if (SOCIAL_CHAT_CHANNELS.has(normalizedChannel)) {
    const { sendMetaSocialTextMessage } = await import('../../services/metaSocialMessagingService.js')
    return sendMetaSocialTextMessage({
      contactId,
      platform: normalizedChannel,
      message: text,
      externalId
    })
  }

  const { sendWhatsAppApiTextMessage } = await import('../../services/whatsappApiService.js')
  return sendWhatsAppApiTextMessage({
    to: phone || latest.phone,
    from: latest.business_phone || undefined,
    phoneNumberId: latest.business_phone_number_id || undefined,
    text,
    externalId
  })
}

async function runScheduledFollowUp({ contactId, phone, baseMessageId, followUpIndex, channel = 'whatsapp', agentId = null }) {
  const normalizedChannel = normalizeConversationalChannel(channel)
  // (AI-007) Kill switch real: si el toggle global está apagado, el agente no
  // dispara seguimientos aunque existan agentes publicados.
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

  const state = await getConversationState(contactId, { agentId })
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
  const { agent, ctx, model } = await buildAgentForRun({
    config: agentConfig,
    conversationModel: agentConfig.model || config.model,
    contactId,
    contactName: contact?.full_name || null,
    dryRun: false,
    channel: normalizedChannel,
    ruleContext: null,
    followUpContext: { index: followUpIndex, strategy: followUp.strategy }
  })

  const reply = await executeAgent({
    agent,
    modelProvider: runtime.modelProvider,
    messages: [...hydratedMessages, buildFollowUpContextMessage({ followUpIndex, strategy: followUp.strategy })],
    contactId,
    model,
    aiProvider,
    channel: normalizedChannel,
    traceMessage: `seguimiento ${followUpIndex}`
  })

  const postState = await getConversationState(contactId, { agentId: agentConfig.id })
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
        `, [doneLatest.id, followUpIndex, doneContactId, agentConfig.id])
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

  const nextState = await getConversationState(contactId, { agentId: agentConfig.id }).catch(() => null)
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
      externalId: `${externalIdPrefix}_${latest.id}${parts.length > 1 ? `_${index + 1}` : ''}`.slice(0, 120)
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
    `, [latest.id, contactId, agentConfig?.id || null])
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
  const states = await listConversationStatesForContact(contactId).catch(() => [])
  const blockedAgentIds = new Set()
  const releasedAgentIds = new Set()

  for (const state of states.filter((item) => item?.agentId && !isRunnableConversationState(item))) {
    const agentConfig = await getConversationalAgent(state.agentId).catch(() => null)
    if (agentConfig && isStaleInheritedConversationStateForAgent(state, agentConfig)) {
      await releaseAgentFromConversation(contactId, agentConfig.id, { updatedBy: 'agent' })
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'agent_released',
        detail: { agentId: agentConfig.id, name: agentConfig.name, reason: 'stale_inherited_state' }
      })
      continue
    }
    if (agentConfig && shouldReopenCompletedConversationState(state, latestMessageId)) {
      if (exitRulesMatch(agentConfig, ruleContext)) {
        releasedAgentIds.add(agentConfig.id)
        await releaseAgentFromConversation(contactId, agentConfig.id, { updatedBy: 'agent' })
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'agent_released',
          detail: { agentId: agentConfig.id, name: agentConfig.name, reason: 'exit_rules' }
        })
        continue
      }
      if (contactIsOutOfScopeForAgent(agentConfig, ruleContext)) {
        releasedAgentIds.add(agentConfig.id)
        await releaseAgentFromConversation(contactId, agentConfig.id, { updatedBy: 'agent' })
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'agent_released',
          detail: { agentId: agentConfig.id, name: agentConfig.name, reason: 'contact_out_of_scope' }
        })
        continue
      }

      const reopenedState = await setConversationStatus(contactId, 'active', {
        updatedBy: 'agent',
        clearSignal: true,
        activationSource: 'automatic',
        agentId: agentConfig.id
      })
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'agent_reopened',
        detail: {
          agentId: agentConfig.id,
          name: agentConfig.name,
          reason: 'new_inbound_after_completion',
          messageId: latestMessageId
        }
      })
      return { agentConfig, state: reopenedState, assigned: false }
    }
    blockedAgentIds.add(state.agentId)
  }

  for (const state of states.filter(isRunnableConversationState)) {
    const agentConfig = await getConversationalAgent(state.agentId).catch(() => null)
    if (!agentConfig?.enabled) continue

    if (exitRulesMatch(agentConfig, ruleContext)) {
      releasedAgentIds.add(agentConfig.id)
      await releaseAgentFromConversation(contactId, agentConfig.id, { updatedBy: 'agent' })
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'agent_released',
        detail: { agentId: agentConfig.id, name: agentConfig.name, reason: 'exit_rules' }
      })
      continue
    }

    // Seguridad: si el agente pasó a "solo nuevos" y este contacto ya existía antes del
    // corte, suéltalo aunque tuviera asignación pegajosa (no lo dejes grandfathered).
    if (contactIsOutOfScopeForAgent(agentConfig, ruleContext)) {
      releasedAgentIds.add(agentConfig.id)
      await releaseAgentFromConversation(contactId, agentConfig.id, { updatedBy: 'agent' })
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'agent_released',
        detail: { agentId: agentConfig.id, name: agentConfig.name, reason: 'contact_out_of_scope' }
      })
      continue
    }

    return { agentConfig, state, assigned: false }
  }

  const agentConfig = await matchAgentForMessage({
    contactId,
    messageText,
    channel,
    excludeAgentIds: [...blockedAgentIds, ...releasedAgentIds],
    ruleContext
  })

  if (!agentConfig) return { agentConfig: null, state: states[0] || null, assigned: false }

  const state = await assignAgentToConversation(contactId, agentConfig.id, {
    activationSource: 'automatic',
    updatedBy: 'agent'
  })
  await recordConversationalAgentEvent({
    contactId,
    eventType: 'agent_assigned',
    detail: { agentId: agentConfig.id, name: agentConfig.name, channel }
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
  try {
    if (!contactId || !messageId) return

    // (AI-007) Kill switch real: antes de procesar/responder verificamos el
    // toggle global. Si está apagado, el agente NO actúa aunque existan agentes
    // publicados (la antigua re-habilitación silenciosa del runtime queda anulada).
    let config = await getConversationalAgentConfig()
    if (!config.enabled) {
      config = await ensureConversationalAgentRuntimeEnabledForPublishedAgents({
        reason: 'incoming_message_with_published_agent'
      })
    }
    if (!config.enabled) {
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'run_skipped_global_disabled',
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
      // Pequeña espera para agrupar ráfagas de mensajes: si después de la
      // espera ya hay un mensaje más nuevo, esa ejecución posterior atiende.
      await sleep(DEBOUNCE_MS)

      const latest = await loadLatestInboundMessage(contactId, normalizedChannel)
      if (!latest) return

	      // Resolver qué agente atiende esta conversación: el ya asignado o el
	      // primero cuyas reglas de entrada coincidan con el mensaje/contacto.
	      const latestMessageText = cleanMessageText(latest)
      const ruleContext = await buildRuleContext({
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
	      agentState = await getConversationState(contactId, { agentId: agentConfig.id })
	      if (!agentState || agentState.status !== 'active' || agentState.signal) return
	      if (agentState.lastInboundMessageId === latest.id && agentState.lastAnsweredInboundMessageId === latest.id) return

	      // (AI-001/CRON-007) Claim atómico compare-and-set: reclama el mensaje
	      // antes de correr para evitar respuestas/acciones duplicadas entre
	      // instancias o ante reenvío de webhook. Solo procede si esta instancia
	      // ganó el claim (changes>0); si otra ya lo reclamó, aborta sin responder.
	      const claimRes = await db.run(`
	        UPDATE conversational_agent_state
	        SET last_inbound_message_id = ?, channel = ?, updated_at = CURRENT_TIMESTAMP
	        WHERE id = ?
	          AND (last_inbound_message_id IS NULL OR last_inbound_message_id <> ?)
	      `, [latest.id, normalizedChannel, agentState.id, latest.id])
	      if (!(Number(claimRes?.changes || 0) > 0)) {
	        await recordConversationalAgentEvent({
	          contactId,
	          eventType: 'run_skipped_already_claimed',
	          detail: { messageId: latest.id, channel: normalizedChannel, reason: 'inbound_already_claimed' }
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
      const messages = await hydrateConversationalMessagesMedia(rawMessages, {
        aiProvider,
        apiKey: runtime.apiKey,
        audioTranscriptionApiKey: openAIFallbackApiKey,
        visualAnalysisApiKey: openAIFallbackApiKey,
        includeBinary: includeBinaryMedia
      })
      if (!messages.length) return
	      const pendingMessages = await loadPendingInboundMessages(contactId, agentState, normalizedChannel)
      const pendingContextMessage = buildPendingReplyContextMessage(pendingMessages)
      const messagesForAgent = pendingContextMessage ? [...messages, pendingContextMessage] : messages
      const traceMessage = cleanMessageText(pendingMessages[pendingMessages.length - 1] || latest)

      const { agent, ctx, model } = await buildAgentForRun({
        config: agentConfig,
        conversationModel: agentConfig.model || config.model,
        contactId,
        contactName: contact?.full_name || null,
        dryRun: false,
        channel: normalizedChannel,
        ruleContext
      })
      // Contexto para el candado de fases de cierre (validador que lee la conversación).
      ctx.conversationMessages = messagesForAgent
      ctx.aiRuntime = runtime
      ctx.model = model

      const reply = await executeAgent({
        agent,
        modelProvider: runtime.modelProvider,
        messages: messagesForAgent,
        contactId,
        model,
        aiProvider,
        channel: normalizedChannel,
        traceMessage
      })

      const responseDelayMs = getAgentResponseDelayMs(agentConfig)
      if (responseDelayMs > 0) {
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'reply_wait_started',
          detail: { messageId: latest.id, agentId: agentConfig.id || null, channel: normalizedChannel, delayMs: responseDelayMs }
        })
        await sleep(responseDelayMs)

        const latestAfterDelay = await loadNewerInboundMessage(contactId, latest.id, normalizedChannel)
        if (latestAfterDelay) {
          await recordConversationalAgentEvent({
            contactId,
            eventType: 'reply_suppressed',
            detail: {
              messageId: latest.id,
              agentId: agentConfig.id || null,
              channel: normalizedChannel,
              reason: 'newer_inbound_during_response_delay',
              newerMessageId: latestAfterDelay.id
            }
          })
          scheduleConversationalAgentRerun({
            contactId,
            phone,
            latestMessage: latestAfterDelay,
            channel: normalizedChannel,
            reason: 'pausa de respuesta'
          })
          return
        }
      }

      // El estado pudo cambiar durante la ejecución o la espera (descartada, humano, etc.)
	      const postState = await getConversationState(contactId, { agentId: agentConfig.id })
      const blockedStatuses = new Set(['discarded', 'paused', 'skipped', 'human'])
      if (ctx.suppressReply || !reply || blockedStatuses.has(postState?.status)) {
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'reply_suppressed',
          detail: { messageId: latest.id, channel: normalizedChannel, actions: ctx.actions, status: postState?.status || null }
        })
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
          splitter: runtime.supportsAISplitting ? splitMessageIntoBubbles : splitMessageIntoBubblesFallback
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
        return
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

async function recoverScheduledFollowUps({ limit = FOLLOW_UP_RECOVERY_SCAN_LIMIT } = {}) {
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
    LIMIT ?
  `, [limit]).catch(() => [])

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
// (mensaje entrante aún sin responder y dentro de la ventana de recuperación) volvemos a
// disparar el rerun por la vía normal; scheduleConversationalAgentRerun ya borra la copia
// persistida, así que la operación es idempotente. Las filas viejas/inválidas se purgan.
async function recoverPendingReruns({ nowMs = Date.now(), maxAgeMs = PENDING_RECOVERY_MAX_AGE_MS } = {}) {
  const rows = await db.all(`
    SELECT run_key, contact_id, channel, scheduled_for, payload, created_at
    FROM ai_agent_pending_reruns
    ORDER BY scheduled_for ASC
    LIMIT ?
  `, [PENDING_RECOVERY_SCAN_LIMIT]).catch(() => [])

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
    const states = await listConversationStatesForContact(contactId).catch(() => [])
    const alreadyAnswered = states.some((state) => (
      state?.lastAnsweredInboundMessageId === latest.id ||
      state?.last_answered_inbound_message_id === latest.id
    ))
    if (alreadyAnswered || !shouldRecoverPendingInbound(latest, null, { nowMs, maxAgeMs })) {
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

export async function recoverPendingConversationalAgentConversations({
  nowMs = Date.now(),
  maxAgeMs = PENDING_RECOVERY_MAX_AGE_MS
} = {}) {
  // (AI-007) Kill switch real: si el toggle global está apagado, no recuperamos
  // ni reprogramamos conversaciones pendientes aunque existan agentes publicados.
  let config = await getConversationalAgentConfig()
  if (!config.enabled) {
    config = await ensureConversationalAgentRuntimeEnabledForPublishedAgents({
      reason: 'pending_recovery_with_published_agent'
    })
  }
  if (!config.enabled) return { scanned: 0, scheduled: 0 }

  // (AI-002) No recuperar pendientes si la feature premium está revocada.
  if (!(await hasFeature('conversational_ai'))) return { scanned: 0, scheduled: 0 }

  const rowsByChannel = await Promise.all(
    RECOVERABLE_CONVERSATIONAL_CHANNELS.map((channel) => loadRecentInboundMessagesForRecovery(channel, PENDING_RECOVERY_SCAN_LIMIT))
  )
  const rows = rowsByChannel.flat()
    .sort((left, right) => messageTimestampMs(right) - messageTimestampMs(left))
    .slice(0, PENDING_RECOVERY_SCAN_LIMIT)

  const latestByContact = new Map()
  for (const row of rows) {
    const key = getRunKey(row?.contact_id, row?.channel)
    if (!row?.contact_id || latestByContact.has(key)) continue
    latestByContact.set(key, row)
  }

	  let scheduled = 0
	  for (const latest of latestByContact.values()) {
	    if (scheduled >= PENDING_RECOVERY_SCHEDULE_LIMIT) break
	    const states = await listConversationStatesForContact(latest.contact_id).catch(() => [])
	    const runnableStates = states.filter(isRunnableConversationState)
	    const alreadyAnswered = states.some((state) => (
	      state?.lastAnsweredInboundMessageId === latest.id ||
	      state?.last_answered_inbound_message_id === latest.id
	    ))
	    if (alreadyAnswered) continue
	    const recoveryState = runnableStates[0] || null
	    if (recoveryState && !shouldRecoverPendingInbound(latest, recoveryState, { nowMs, maxAgeMs })) continue
	    if (!recoveryState && !shouldRecoverPendingInbound(latest, null, { nowMs, maxAgeMs })) continue

	    await recordConversationalAgentEvent({
      contactId: latest.contact_id,
      eventType: 'pending_recovery_scheduled',
      detail: { messageId: latest.id, channel: latest.channel || 'whatsapp', maxAgeMs }
    }).catch(() => {})

    scheduleConversationalAgentRerun({
      contactId: latest.contact_id,
      phone: latest.phone,
      latestMessage: latest,
      channel: latest.channel || 'whatsapp',
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
  const reruns = await recoverPendingReruns({ nowMs, maxAgeMs }).catch((error) => {
    logger.warn(`[Agente conversacional] No se pudieron recuperar reruns encolados: ${error.message}`)
    return { scanned: 0, scheduled: 0 }
  })

  return { scanned: latestByContact.size, scheduled, followUps, reruns }
}

export async function resolveConversationalAgentPreviewRuntimeConfig({ configOverride = null, agentId = null } = {}) {
  const globalConfig = await getConversationalAgentConfig()
  const hasConfigOverride = configOverride && typeof configOverride === 'object' && Object.keys(configOverride).length > 0
  let baseConfig = agentId ? await getConversationalAgent(agentId) : null

  if (!baseConfig && !hasConfigOverride) {
    baseConfig = (await listConversationalAgents())[0] || null
  }

  const fallbackBase = buildConversationalAgentRuntimeConfig({}, {
    aiProvider: globalConfig.aiProvider,
    model: globalConfig.model
  })

  const config = hasConfigOverride
    ? buildConversationalAgentRuntimeConfig(configOverride, baseConfig || fallbackBase)
    : (baseConfig || fallbackBase)

  return { config, globalConfig }
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
  const { config, globalConfig } = await resolveConversationalAgentPreviewRuntimeConfig({ configOverride, agentId })
  const aiProvider = normalizeConversationalAIProvider(config.aiProvider || globalConfig.aiProvider)
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

  const { agent, ctx, model } = await buildAgentForRun({
    config: runtimeConfig,
    conversationModel: runtimeConfig.model || globalConfig.model,
    contactId: null,
    contactName: null,
    dryRun: true,
    channel: previewChannel,
    ruleContext: null
  })

  const openAIFallbackApiKey = aiProvider === 'openai'
    ? runtime.apiKey
    : await getOpenAIApiKey().catch(() => null)
  const includeBinaryMedia = shouldIncludeConversationalBinaryMedia({ runtime })
  const messagesForAgent = await hydrateConversationalPreviewMessagesMedia(cleanMessages, {
    aiProvider,
    apiKey: runtime.apiKey,
    audioTranscriptionApiKey: openAIFallbackApiKey,
    visualAnalysisApiKey: openAIFallbackApiKey,
    includeBinary: includeBinaryMedia
  })
  // Contexto para el candado de fases de cierre (mismo validador que en vivo, para
  // que el tester refleje 1:1 si el arco se cumplió o no).
  ctx.conversationMessages = messagesForAgent
  ctx.aiRuntime = runtime
  ctx.model = model

  const reply = await executeAgent({
    agent,
    modelProvider: runtime.modelProvider,
    messages: messagesForAgent,
    contactId: null,
    model,
    aiProvider,
    channel: previewChannel
  })

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
    aiProvider,
    model
  }
}
