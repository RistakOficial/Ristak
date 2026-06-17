import { Agent, Runner } from '@openai/agents'
import { db } from '../../config/database.js'
import { logger } from '../../utils/logger.js'
import { getAccountTimezone } from '../../utils/dateUtils.js'
import { getAccountLocaleSettings } from '../../utils/accountLocale.js'
import {
  buildBusinessProfilePromptParameters,
  getAIAgentConfig,
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
  ensureConversationState,
  recordConversationalAgentEvent,
  getConversationalAgent,
  listConversationalAgents,
  matchAgentForMessage,
  assignAgentToConversation,
  buildRuleContext,
  exitRulesMatch,
  normalizeConversationalAgentModel,
  getAgentResponseDelayMs,
  getAgentReplyDeliveryPartDelayMs,
  normalizeAgentReplyDelivery,
  ADVANCED_CLOSING_CONTEXT_FIELDS
} from '../../services/conversationalAgentService.js'
import {
  normalizeConversationalAIProvider,
  resolveConversationalAIRuntime
} from '../../services/conversationalAIProviderService.js'
import { tagNamesForIds } from '../../services/contactTagsService.js'
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

const HISTORY_LIMIT = 20
const MAX_TURNS = 10
const DEFAULT_MODEL = process.env.OPENAI_CONVERSATIONAL_AGENT_MODEL || 'gpt-5.4-nano'
const MAX_REPLY_CHARS = 1000
const DEBOUNCE_MS = 4000
const PENDING_INBOUND_LIMIT = 8
const PENDING_INBOUND_SCAN_LIMIT = 30
const PENDING_RECOVERY_SCAN_LIMIT = 80
const PENDING_RECOVERY_SCHEDULE_LIMIT = 10
const PENDING_RECOVERY_MAX_AGE_MS = Number(process.env.CONVERSATIONAL_AGENT_PENDING_RECOVERY_MAX_AGE_MS || 60 * 60 * 1000)
// Conversaciones que el agente está procesando ahora mismo (instancia única).
const runningContacts = new Set()
const pendingContactReruns = new Map()

// Palabras internas que jamás deben llegar al cliente final.
const INTERNAL_TOKEN_PATTERN = /\b(AGENDAR|SALTAR|ready_for_human|ready_to_schedule|ready_to_buy|mark_ready_to_advance|send_to_human|discard_conversation|stay_silent|book_appointment|create_payment_link)\b/gi

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
  reply = reply.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if ((reply.startsWith('"') && reply.endsWith('"')) || (reply.startsWith('“') && reply.endsWith('”'))) {
    reply = reply.slice(1, -1).trim()
  }
  if (reply.length > MAX_REPLY_CHARS) {
    reply = `${reply.slice(0, MAX_REPLY_CHARS - 1).trim()}…`
  }
  return reply
}

function cleanMessageText(row) {
  return String(row?.message_text || '').trim() ||
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
    contactId ? db.get('SELECT closing_context_json FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => null) : null,
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

async function loadConversationHistory(contactId) {
  const rows = await db.all(`
    SELECT id, direction, message_type, message_text, message_timestamp, created_at
    FROM whatsapp_api_messages
    WHERE contact_id = ?
    ORDER BY COALESCE(message_timestamp, created_at) DESC
    LIMIT ?
  `, [contactId, HISTORY_LIMIT])

  return rows.reverse().map((row) => {
    return {
      id: row.id,
      role: row.direction === 'outbound' ? 'assistant' : 'user',
      content: cleanMessageText(row),
      timestamp: row.message_timestamp || row.created_at || null
    }
  })
}

async function loadPendingInboundMessages(contactId, state = {}) {
  const rows = await db.all(`
    SELECT id, message_text, message_type, message_timestamp, created_at
    FROM whatsapp_api_messages
    WHERE contact_id = ? AND direction = 'inbound'
    ORDER BY COALESCE(message_timestamp, created_at) DESC
    LIMIT ?
  `, [contactId, PENDING_INBOUND_SCAN_LIMIT])

  const ordered = rows.reverse()
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

async function loadLatestInboundMessage(contactId) {
  return db.get(`
    SELECT id, message_text, message_type, phone, business_phone, business_phone_number_id
    FROM whatsapp_api_messages
    WHERE contact_id = ? AND direction = 'inbound'
    ORDER BY COALESCE(message_timestamp, created_at) DESC
    LIMIT 1
  `, [contactId])
}

async function buildAgentForRun({ config, conversationModel, contactId, contactName, dryRun, channel = 'whatsapp', ruleContext = null }) {
  const [aiConfig, timezone, businessProfile, accountLocale] = await Promise.all([
    getAIAgentConfig({}),
    getAccountTimezone().catch(() => 'America/Mexico_City'),
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

  const ctx = { contactId, config, dryRun, actions: [], suppressReply: false }
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
    advancedClosingContext,
    accountLocale
  })

  const agent = new Agent({
    name: 'Ristak · Agente conversacional',
    model,
    instructions,
    tools
  })

  return { agent, ctx, model, aiProvider }
}

async function executeAgent({ agent, modelProvider, messages, contactId, model, aiProvider = 'openai', traceMessage = '' }) {
  let agentRun = null
  try {
    agentRun = await startAgentRun({
      userId: null,
      latestUserMessage: traceMessage || [...messages].reverse().find((m) => m.role === 'user')?.content || '',
      viewContext: { path: '/chat', title: 'Agente conversacional' }
    })
    await updateAgentRun(agentRun, {
      domain: 'conversacional',
      action: 'whatsapp_reply',
      model,
      route: { engine: aiProvider === 'openai' ? 'openai-agents-sdk' : `${aiProvider}-openai-compatible`, category: 'conversacional', contactId }
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

function scheduleConversationalAgentRerun({ contactId, phone, latestMessage, reason }) {
  if (!latestMessage?.id) return
  pendingContactReruns.delete(contactId)
  setTimeout(() => {
    handleInboundMessageForConversationalAgent({
      contactId,
      phone: latestMessage.phone || phone,
      messageId: latestMessage.id
    }).catch((error) => {
      logger.error(`[Agente conversacional] Error reintentando tras ${reason}: ${error.message}`)
    })
  }, 0)
}

async function schedulePendingContactRerun(contactId, phone, reason) {
  const latest = await loadLatestInboundMessage(contactId).catch(() => null)
  if (!latest) return
  scheduleConversationalAgentRerun({ contactId, phone, latestMessage: latest, reason })
}

async function loadNewerInboundMessage(contactId, handledMessageId) {
  const latest = await loadLatestInboundMessage(contactId)
  return latest && latest.id !== handledMessageId ? latest : null
}

export async function sendReplyParts({
  contactId,
  phone,
  latest,
  agentConfig,
  reply,
  apiKey,
  model,
  dependencies = {}
}) {
  const {
    splitter = splitMessageIntoBubbles,
    sendTextMessage = null,
    wait = sleep,
    loadNewerInbound = loadNewerInboundMessage,
    recordEvent = recordConversationalAgentEvent,
    markReplyComplete = null
  } = dependencies || {}

  const splitResult = await splitter({
    text: reply,
    settings: agentConfig.replyDelivery,
    apiKey
  })
  const parts = splitResult.messages
  if (!parts.length) return { parts: [], sentParts: 0, interruptedBy: null }

  const sendMessage = sendTextMessage || (await import('../../services/whatsappApiService.js')).sendWhatsAppApiTextMessage

  const delivery = normalizeAgentReplyDelivery(agentConfig.replyDelivery)
  const delaySchedule = buildReplyPartDelaySchedule(parts, { replyDelivery: delivery })
  if (delivery.splitMessagesEnabled) {
    await recordEvent({
      contactId,
      eventType: 'reply_splitter_result',
      detail: {
        messageId: latest.id,
        agentId: agentConfig.id || null,
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

      const newerInbound = await loadNewerInbound(contactId, latest.id)
      if (newerInbound) {
        return { parts, sentParts: index, interruptedBy: newerInbound, delaySchedule }
      }
    }

    await sendMessage({
      to: phone || latest.phone,
      from: latest.business_phone || undefined,
      phoneNumberId: latest.business_phone_number_id || undefined,
      text: parts[index],
      externalId: `convagent_${latest.id}${parts.length > 1 ? `_${index + 1}` : ''}`.slice(0, 120)
    })

    await recordEvent({
      contactId,
      eventType: parts.length > 1 ? 'reply_part_sent' : 'reply_single_sent',
      detail: {
        messageId: latest.id,
        agentId: agentConfig.id || null,
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
          updated_at = CURRENT_TIMESTAMP
      WHERE contact_id = ?
    `, [latest.id, contactId])
  }

  return { parts, sentParts: parts.length, interruptedBy: null, delaySchedule }
}

/**
 * Punto de entrada desde el webhook de mensajes entrantes de WhatsApp.
 * Es fire-and-forget: nunca lanza, solo registra errores.
 */
export async function handleInboundMessageForConversationalAgent({ contactId, phone, messageId }) {
  try {
    if (!contactId || !messageId) return

    const config = await getConversationalAgentConfig()
    if (!config.enabled) return

    const state = await ensureConversationState(contactId)
    if (!state || state.status !== 'active') return

    if (runningContacts.has(contactId)) {
      pendingContactReruns.set(contactId, { contactId, phone, messageId })
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'run_rerun_queued',
        detail: { messageId, reason: 'already_running' }
      }).catch(() => {})
      return
    }
    runningContacts.add(contactId)

    try {
      // Pequeña espera para agrupar ráfagas de mensajes: si después de la
      // espera ya hay un mensaje más nuevo, esa ejecución posterior atiende.
      await sleep(DEBOUNCE_MS)

      const latest = await loadLatestInboundMessage(contactId)
      if (!latest) return

      const freshState = await getConversationState(contactId)
      if (!freshState || freshState.status !== 'active') return
      if (freshState.lastInboundMessageId === latest.id && freshState.lastAnsweredInboundMessageId === latest.id) return

      // Reclama el mensaje antes de correr para evitar respuestas duplicadas.
      await db.run(`
        UPDATE conversational_agent_state
        SET last_inbound_message_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE contact_id = ?
      `, [latest.id, contactId])

      // Resolver qué agente atiende esta conversación: el ya asignado o el
      // primero cuyas reglas de entrada coincidan con el mensaje/contacto.
      const ruleContext = await buildRuleContext({
        contactId,
        messageText: latest.message_text || '',
        channel: 'whatsapp'
      })

      let agentConfig = freshState.agentId ? await getConversationalAgent(freshState.agentId) : null
      let releasedAgentId = null

      // Reglas de salida: si alguna se cumple, este agente suelta el contacto.
      if (agentConfig && exitRulesMatch(agentConfig, ruleContext)) {
        releasedAgentId = agentConfig.id
        await assignAgentToConversation(contactId, null)
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'agent_released',
          detail: { agentId: agentConfig.id, name: agentConfig.name, reason: 'exit_rules' }
        })
        agentConfig = null
      }

      if (!agentConfig || !agentConfig.enabled) {
        agentConfig = await matchAgentForMessage({
          contactId,
          messageText: latest.message_text || '',
          channel: 'whatsapp',
          excludeAgentId: releasedAgentId,
          ruleContext
        })
        if (agentConfig) {
          await assignAgentToConversation(contactId, agentConfig.id)
          await recordConversationalAgentEvent({
            contactId,
            eventType: 'agent_assigned',
            detail: { agentId: agentConfig.id, name: agentConfig.name }
          })
        }
      }
      if (!agentConfig) {
        // Ningún agente aplica a esta conversación: no responder.
        return
      }

      const aiProvider = normalizeConversationalAIProvider(agentConfig.aiProvider || config.aiProvider)
      const runtime = await resolveConversationalAIRuntime(aiProvider)
      agentConfig = { ...agentConfig, aiProvider }

      const contact = await db.get('SELECT full_name FROM contacts WHERE id = ?', [contactId]).catch(() => null)
      const messages = await loadConversationHistory(contactId)
      if (!messages.length) return
      const pendingMessages = await loadPendingInboundMessages(contactId, freshState)
      const pendingContextMessage = buildPendingReplyContextMessage(pendingMessages)
      const messagesForAgent = pendingContextMessage ? [...messages, pendingContextMessage] : messages
      const traceMessage = cleanMessageText(pendingMessages[pendingMessages.length - 1] || latest)

      const { agent, ctx, model } = await buildAgentForRun({
        config: agentConfig,
        conversationModel: agentConfig.model || config.model,
        contactId,
        contactName: contact?.full_name || null,
        dryRun: false,
        channel: 'whatsapp',
        ruleContext
      })

      const reply = await executeAgent({
        agent,
        modelProvider: runtime.modelProvider,
        messages: messagesForAgent,
        contactId,
        model,
        aiProvider,
        traceMessage
      })

      const responseDelayMs = getAgentResponseDelayMs(agentConfig)
      if (responseDelayMs > 0) {
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'reply_wait_started',
          detail: { messageId: latest.id, agentId: agentConfig.id || null, delayMs: responseDelayMs }
        })
        await sleep(responseDelayMs)

        const latestAfterDelay = await loadNewerInboundMessage(contactId, latest.id)
        if (latestAfterDelay) {
          await recordConversationalAgentEvent({
            contactId,
            eventType: 'reply_suppressed',
            detail: {
              messageId: latest.id,
              agentId: agentConfig.id || null,
              reason: 'newer_inbound_during_response_delay',
              newerMessageId: latestAfterDelay.id
            }
          })
          scheduleConversationalAgentRerun({
            contactId,
            phone,
            latestMessage: latestAfterDelay,
            reason: 'pausa de respuesta'
          })
          return
        }
      }

      // El estado pudo cambiar durante la ejecución o la espera (descartada, humano, etc.)
      const postState = await getConversationState(contactId)
      const blockedStatuses = new Set(['discarded', 'paused', 'skipped', 'human'])
      if (ctx.suppressReply || !reply || blockedStatuses.has(postState?.status)) {
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'reply_suppressed',
          detail: { messageId: latest.id, actions: ctx.actions, status: postState?.status || null }
        })
        return
      }

      const latestBeforeSend = await loadNewerInboundMessage(contactId, latest.id)
      if (latestBeforeSend) {
        await recordConversationalAgentEvent({
          contactId,
          eventType: 'reply_suppressed',
          detail: {
            messageId: latest.id,
            agentId: agentConfig.id || null,
            reason: 'newer_inbound_before_reply',
            newerMessageId: latestBeforeSend.id
          }
        })
        scheduleConversationalAgentRerun({
          contactId,
          phone,
          latestMessage: latestBeforeSend,
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
          replyPreview: reply.slice(0, 280),
          partCount: delivery.parts.length,
          pendingInboundCount: pendingMessages.length,
          aiProvider,
          actions: ctx.actions
        }
      })
    } finally {
      runningContacts.delete(contactId)
      const pending = pendingContactReruns.get(contactId)
      if (pending) {
        pendingContactReruns.delete(contactId)
        await schedulePendingContactRerun(
          contactId,
          pending.phone || phone,
          'mensaje entrante durante ejecución'
        )
      }
    }
  } catch (error) {
    runningContacts.delete(contactId)
    logger.error(`[Agente conversacional] Error atendiendo mensaje entrante: ${error.message}`)
    await recordConversationalAgentEvent({
      contactId: contactId || null,
      eventType: 'error',
      detail: { message: error.message }
    }).catch(() => {})
  }
}

export async function recoverPendingConversationalAgentConversations({
  nowMs = Date.now(),
  maxAgeMs = PENDING_RECOVERY_MAX_AGE_MS
} = {}) {
  const config = await getConversationalAgentConfig()
  if (!config.enabled) return { scanned: 0, scheduled: 0 }

  const rows = await db.all(`
    SELECT id, contact_id, message_text, message_type, phone, business_phone,
           business_phone_number_id, message_timestamp, created_at
    FROM whatsapp_api_messages
    WHERE direction = 'inbound' AND contact_id IS NOT NULL
    ORDER BY COALESCE(message_timestamp, created_at) DESC
    LIMIT ?
  `, [PENDING_RECOVERY_SCAN_LIMIT])

  const latestByContact = new Map()
  for (const row of rows) {
    if (!row?.contact_id || latestByContact.has(row.contact_id)) continue
    latestByContact.set(row.contact_id, row)
  }

  let scheduled = 0
  for (const latest of latestByContact.values()) {
    if (scheduled >= PENDING_RECOVERY_SCHEDULE_LIMIT) break
    const state = await getConversationState(latest.contact_id).catch(() => null)
    if (!shouldRecoverPendingInbound(latest, state, { nowMs, maxAgeMs })) continue

    await recordConversationalAgentEvent({
      contactId: latest.contact_id,
      eventType: 'pending_recovery_scheduled',
      detail: { messageId: latest.id, maxAgeMs }
    }).catch(() => {})

    scheduleConversationalAgentRerun({
      contactId: latest.contact_id,
      phone: latest.phone,
      latestMessage: latest,
      reason: 'recuperación de pendientes al arrancar'
    })
    scheduled += 1
  }

  if (scheduled) {
    logger.info(`[Agente conversacional] ${scheduled} conversación(es) pendiente(s) recuperadas al arrancar`)
  }

  return { scanned: latestByContact.size, scheduled }
}

/**
 * Conversación simulada para probar el agente antes de activarlo.
 * No envía WhatsApp, no toca estados ni crea citas: las acciones internas
 * se devuelven como lista para mostrarlas en la prueba.
 */
export async function runConversationalAgentPreview({ messages = [], configOverride = null, agentId = null }) {
  const globalConfig = await getConversationalAgentConfig()
  let baseConfig = agentId ? await getConversationalAgent(agentId) : null
  if (!baseConfig) {
    baseConfig = (await listConversationalAgents())[0] || null
  }
  if (!baseConfig) {
    baseConfig = {
      name: 'Agente', objective: 'citas', customObjective: '', successAction: 'ready_for_human',
      successExtras: [], requiredData: '', handoffRules: '', extraInstructions: '',
      allowEmojis: false, aiProvider: globalConfig.aiProvider, model: globalConfig.model, defaultCalendarId: null, closingStrategyMode: 'system', closingStrategyCustom: '',
      responseDelay: { mode: 'none', fixedValue: 10, fixedUnit: 'seconds', minValue: 1, maxValue: 10, rangeUnit: 'minutes' },
      replyDelivery: { mode: 'single', targetChars: 280, minDelaySeconds: 2, maxDelaySeconds: 6 }
    }
  }
  const config = configOverride ? { ...baseConfig, ...configOverride } : baseConfig
  const aiProvider = normalizeConversationalAIProvider(config.aiProvider || globalConfig.aiProvider)
  const runtime = await resolveConversationalAIRuntime(aiProvider)
  const runtimeConfig = { ...config, aiProvider }

  const cleanMessages = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.trim() }))
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
    channel: 'whatsapp',
    ruleContext: null
  })

  const reply = await executeAgent({
    agent,
    modelProvider: runtime.modelProvider,
    messages: cleanMessages,
    contactId: null,
    model,
    aiProvider
  })

  const splitResult = ctx.suppressReply
    ? { messages: [] }
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

  return {
    reply: ctx.suppressReply ? '' : reply,
    replyParts,
    replyPartDelaysMs,
    suppressed: ctx.suppressReply,
    actions: ctx.actions,
    aiProvider,
    model
  }
}
