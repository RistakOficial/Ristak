import { createHash, randomUUID, timingSafeEqual } from 'crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Agent, Runner, OpenAIProvider } from '@openai/agents'
import { db } from '../config/database.js'
import { PUBLIC_URL } from '../config/constants.js'
import { CHEAPEST_OPENAI_MODEL } from '../config/openAIModels.js'
import { logger } from '../utils/logger.js'
import { DEFAULT_TIMEZONE, getAccountTimezone } from '../utils/dateUtils.js'
import { getAccountCurrency } from '../utils/accountLocale.js'
import { coalescedTimestampSortExpression } from '../utils/sqlTimestampSort.js'
import { buildTagMatchKeys, resolveTagIds, tagNamesForIds } from './contactTagsService.js'
import { getOpenAIApiKey } from './aiAgentService.js'
import {
  DEFAULT_CONVERSATIONAL_AI_PROVIDER,
  getDefaultConversationalModelForProvider,
  normalizeConversationalAIProvider
} from './conversationalAIProviderService.js'
import { getConversationalAgentMaxAgents } from './licenseService.js'
import { normalizeConversationIntelligenceState } from '../agents/conversational/intelligence/contracts.js'

/**
 * Servicio del agente conversacional: runtime interno, estado por
 * conversación (contacto) y bitácora de eventos auditables.
 *
 * Estados por conversación:
 * - active:    el agente atiende la conversación
 * - paused:    pausado manualmente en esa conversación
 * - human:     un humano tomó la conversación (el agente no responde)
 * - skipped:   chatbot omitido para ese contacto
 * - completed: el agente cumplió el objetivo (dejó señal interna)
 * - discarded: conversación descartada (spam, acoso, fuera de contexto)
 *
 * Señales internas (signal): ready_for_human | ready_to_schedule |
 * ready_to_buy | appointment_booked | purchase_completed | discarded
 */

export const CONVERSATIONAL_OBJECTIVES = [
  { id: 'citas', label: 'Cerrar citas' },
  { id: 'ventas', label: 'Cerrar ventas' },
  { id: 'datos', label: 'Conseguir datos específicos' },
  { id: 'filtrar', label: 'Filtrar curiosos' },
  { id: 'custom', label: 'Objetivo personalizado' }
]

export const SUCCESS_ACTIONS = [
  { id: 'ready_for_human', label: 'Pasar a un humano' },
  { id: 'book_appointment', label: 'Agendar con IA' },
  { id: 'ready_to_buy', label: 'Enviar link de pago' },
  { id: 'send_goal_url', label: 'Enviar enlace con confirmación automática' },
  { id: 'send_trigger_link', label: 'Enviar enlace de disparo' }
]

const VALID_OBJECTIVES = new Set(CONVERSATIONAL_OBJECTIVES.map((item) => item.id))
const VALID_SUCCESS_ACTIONS = new Set(SUCCESS_ACTIONS.map((item) => item.id))
const VALID_AGENT_IDENTITY_MODES = new Set(['business', 'user', 'custom', 'agent'])
// Persuasión: qué tanto empuja al cierre (alto = guion de fábrica completo).
// Lenguaje: registro con el que habla (intermedio = calibración natural por defecto).
const VALID_PERSUASION_LEVELS = new Set(['low', 'medium', 'high'])
const VALID_LANGUAGE_LEVELS = new Set(['professional', 'intermediate', 'colloquial'])
const DEFAULT_PERSUASION_LEVEL = 'medium'
const DEFAULT_LANGUAGE_LEVEL = 'intermediate'

export function normalizeConversationalPersuasionLevel(value, fallback = DEFAULT_PERSUASION_LEVEL) {
  const normalized = String(value || '').trim().toLowerCase()
  if (VALID_PERSUASION_LEVELS.has(normalized)) return normalized
  return VALID_PERSUASION_LEVELS.has(fallback) ? fallback : DEFAULT_PERSUASION_LEVEL
}

export function normalizeConversationalLanguageLevel(value, fallback = DEFAULT_LANGUAGE_LEVEL) {
  const normalized = String(value || '').trim().toLowerCase()
  if (VALID_LANGUAGE_LEVELS.has(normalized)) return normalized
  return VALID_LANGUAGE_LEVELS.has(fallback) ? fallback : DEFAULT_LANGUAGE_LEVEL
}

// Alcance de contactos: 'all' = atiende a todos (comportamiento histórico); 'new_only' =
// solo contactos creados a partir del corte (medida de seguridad para no mezclar a los
// clientes que ya existían cuando se creó/configuró el agente).
export function normalizeContactScope(value) {
  return String(value || '').trim().toLowerCase() === 'new_only' ? 'new_only' : 'all'
}

export function buildNewContactScopeCutoffAt({ referenceDate = new Date() } = {}) {
  const date = referenceDate instanceof Date ? referenceDate : new Date(referenceDate)
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString()
}

const DEFAULT_SUCCESS_ACTION = 'ready_for_human'
const VALID_STATUSES = new Set(['active', 'paused', 'human', 'skipped', 'completed', 'discarded'])
const CONVERSATION_PAUSE_DURATION_MS = 24 * 60 * 60 * 1000
export const CONVERSATIONAL_INBOUND_PROCESSING_LEASE_MS = 10 * 60 * 1000
const EXPLICIT_ASSIGNMENT_SOURCES = new Set(['automatic', 'manual'])
const CONVERSATION_STATE_CHANNEL_ALIASES = new Map([
  ['wa', 'whatsapp'],
  ['ig', 'instagram'],
  ['fb', 'messenger'],
  ['facebook', 'messenger'],
  ['mail', 'email']
])
const conversationStateChannelContext = new AsyncLocalStorage()
const DEFAULT_CONVERSATIONAL_AGENT_MODEL = getDefaultConversationalModelForProvider(DEFAULT_CONVERSATIONAL_AI_PROVIDER)
const AI_MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/
const COMPLETION_SUMMARY_MODEL = CHEAPEST_OPENAI_MODEL
export const CONVERSATIONAL_AGENT_ENTRY_CONFLICT_CODE = 'CONVERSATIONAL_AGENT_ENTRY_CONFLICT'
export const CONVERSATIONAL_AGENT_LIMIT_REACHED_CODE = 'CONVERSATIONAL_AGENT_LIMIT_REACHED'
const RESPONSE_DELAY_MODES = new Set(['none', 'fixed', 'random'])
const RESPONSE_DELAY_UNITS = new Set(['seconds', 'minutes'])
const MAX_RESPONSE_DELAY_SECONDS = 60 * 60
const DEFAULT_RESPONSE_DELAY_CONFIG = {
  mode: 'none',
  fixedValue: 10,
  fixedUnit: 'seconds',
  minValue: 1,
  maxValue: 10,
  rangeUnit: 'minutes'
}
const REPLY_DELIVERY_MODES = new Set(['single', 'split'])
const DEFAULT_REPLY_DELIVERY_CONFIG = {
  mode: 'split',
  splitMessagesEnabled: true,
  minMessageLengthToSplit: 120,
  maxBubbles: 6,
  minBubbleLength: 20,
  maxBubbleLength: 350,
  targetChars: 350,
  randomizeSplitting: true,
  delayBetweenBubblesEnabled: true,
  minDelaySeconds: 2,
  maxDelaySeconds: 7
}
const FOLLOW_UP_UNITS = new Set(['minutes', 'hours'])
export const MAX_FOLLOW_UP_DELAY_MINUTES = 23 * 60
export const DEFAULT_FOLLOW_UP_STRATEGY = [
  'Lee el historial y el contexto actual antes de escribir.',
  'Abre la conversación con un solo mensaje natural, corto y contextual.',
  'No menciones que es seguimiento automático ni que pasó cierto tiempo.',
  'Retoma el último punto útil que dejó la persona y deja una razón clara para responder.',
  'No cobres, no agendes y no ejecutes acciones de avance en este mensaje.'
].join(' ')
const DEFAULT_FOLLOW_UP_CONFIG = {
  enabled: false,
  first: {
    enabled: true,
    value: 30,
    unit: 'minutes'
  },
  second: {
    enabled: false,
    value: 2,
    unit: 'hours'
  },
  strategy: DEFAULT_FOLLOW_UP_STRATEGY
}
export const ADVANCED_CLOSING_CONTEXT_FIELDS = [
  { key: 'arrivalSource', label: 'De donde llego' },
  { key: 'contactReason', label: 'Por que contacto' },
  { key: 'whyNow', label: 'Por que ahora' },
  { key: 'surfaceProblem', label: 'Problema superficial' },
  { key: 'realProblem', label: 'Problema real' },
  { key: 'problemMagnitudeAwareness', label: 'Conciencia de magnitud del problema' },
  { key: 'attemptedBefore', label: 'Que intento antes' },
  { key: 'impact', label: 'Como le afecta' },
  { key: 'consequenceIfNoAction', label: 'Consecuencia si no hace nada' },
  { key: 'desiredOutcome', label: 'Resultado deseado' },
  { key: 'scenarioToAvoid', label: 'Escenario que quiere evitar' },
  { key: 'urgencyLevel', label: 'Urgencia detectada' },
  { key: 'objection', label: 'Objecion principal' },
  { key: 'decisionSignal', label: 'Senal de decision' },
  { key: 'goalIntentQuality', label: 'Calidad de intencion de meta' },
  { key: 'goalMotivation', label: 'Motivacion real de meta' },
  { key: 'appointmentIntentQuality', label: 'Calidad de intencion de agenda' },
  { key: 'priceShoppingRisk', label: 'Riesgo de solo comparar precio' },
  { key: 'productInterest', label: 'Producto o servicio de interes' },
  { key: 'valueQuestion', label: 'Pregunta sobre valor' },
  { key: 'timingPreference', label: 'Tiempo o disponibilidad deseada' },
  { key: 'nextUsefulQuestion', label: 'Siguiente pregunta util' },
  { key: 'notes', label: 'Notas internas' }
]
const ADVANCED_CLOSING_CONTEXT_KEYS = new Set(ADVANCED_CLOSING_CONTEXT_FIELDS.map((field) => field.key))
const ADVANCED_CLOSING_URGENCY_LEVELS = new Set(['baja', 'media', 'alta', 'desconocida'])

let completionSummaryGeneratorForTest = null

export function setConversationalCompletionSummaryGeneratorForTest(generator) {
  completionSummaryGeneratorForTest = typeof generator === 'function' ? generator : null
}

function toBoolean(value) {
  return [true, 1, '1', 'true'].includes(value)
}

export function normalizeConversationalAgentModel(value, provider = DEFAULT_CONVERSATIONAL_AI_PROVIDER) {
  const model = String(value || '').trim().slice(0, 100)
  return AI_MODEL_ID_PATTERN.test(model) ? model : getDefaultConversationalModelForProvider(provider)
}

export function normalizeConversationalSuccessAction(value = DEFAULT_SUCCESS_ACTION) {
  const action = String(value || '').trim()
  return VALID_SUCCESS_ACTIONS.has(action) ? action : DEFAULT_SUCCESS_ACTION
}

function mapConfigRow(row) {
  if (!row) {
    return {
      enabled: false,
      aiProvider: DEFAULT_CONVERSATIONAL_AI_PROVIDER,
      model: DEFAULT_CONVERSATIONAL_AGENT_MODEL,
      objective: 'citas',
      customObjective: '',
      successAction: DEFAULT_SUCCESS_ACTION,
      requiredData: '',
      handoffRules: '',
      extraInstructions: '',
      allowEmojis: false,
      hideAttended: false,
      hideAttendedNotifications: false,
      defaultCalendarId: null,
      closingStrategyMode: 'system',
      closingStrategyCustom: '',
      persuasionLevel: DEFAULT_PERSUASION_LEVEL,
      languageLevel: DEFAULT_LANGUAGE_LEVEL,
      updatedAt: null
    }
  }

  const legacyHideAttended = toBoolean(row.hide_attended)
  const hideAttendedNotifications = row.hide_attended_notifications === null || row.hide_attended_notifications === undefined
    ? legacyHideAttended
    : (toBoolean(row.hide_attended_notifications) || legacyHideAttended)

  return {
    enabled: toBoolean(row.enabled),
    aiProvider: normalizeConversationalAIProvider(row.ai_provider),
    model: normalizeConversationalAgentModel(row.model, row.ai_provider),
    objective: VALID_OBJECTIVES.has(row.objective) ? row.objective : 'citas',
    customObjective: row.custom_objective || '',
    successAction: VALID_SUCCESS_ACTIONS.has(row.success_action) ? row.success_action : DEFAULT_SUCCESS_ACTION,
    requiredData: row.required_data || '',
    handoffRules: row.handoff_rules || '',
    extraInstructions: row.extra_instructions || '',
    allowEmojis: toBoolean(row.allow_emojis),
    hideAttended: false,
    hideAttendedNotifications,
    defaultCalendarId: row.default_calendar_id || null,
    closingStrategyMode: 'system',
    closingStrategyCustom: '',
    persuasionLevel: normalizeConversationalPersuasionLevel(row.persuasion_level),
    languageLevel: normalizeConversationalLanguageLevel(row.language_level),
    updatedAt: row.updated_at || null
  }
}

export async function getConversationalAgentConfig() {
  const row = await db.get('SELECT * FROM conversational_agent_config WHERE id = 1')
  return mapConfigRow(row)
}

export async function saveConversationalAgentConfig(input = {}) {
  const current = await getConversationalAgentConfig()

  const next = {
    enabled: input.enabled === undefined ? current.enabled : toBoolean(input.enabled),
    aiProvider: input.aiProvider === undefined ? current.aiProvider : normalizeConversationalAIProvider(input.aiProvider),
    model: input.model === undefined
      ? (input.aiProvider === undefined
        ? normalizeConversationalAgentModel(current.model, current.aiProvider)
        : getDefaultConversationalModelForProvider(input.aiProvider))
      : normalizeConversationalAgentModel(input.model, input.aiProvider === undefined ? current.aiProvider : input.aiProvider),
    objective: VALID_OBJECTIVES.has(input.objective) ? input.objective : current.objective,
    customObjective: input.customObjective === undefined ? current.customObjective : String(input.customObjective || '').slice(0, 2000),
    successAction: normalizeConversationalSuccessAction(input.successAction === undefined ? current.successAction : input.successAction),
    requiredData: input.requiredData === undefined ? current.requiredData : String(input.requiredData || '').slice(0, 2000),
    handoffRules: input.handoffRules === undefined ? current.handoffRules : String(input.handoffRules || '').slice(0, 4000),
    extraInstructions: input.extraInstructions === undefined ? current.extraInstructions : String(input.extraInstructions || '').slice(0, 8000),
    allowEmojis: input.allowEmojis === undefined ? current.allowEmojis : toBoolean(input.allowEmojis),
    hideAttended: false,
    hideAttendedNotifications: input.hideAttendedNotifications === undefined
      ? (current.hideAttendedNotifications || toBoolean(input.hideAttended))
      : (toBoolean(input.hideAttendedNotifications) || toBoolean(input.hideAttended)),
    defaultCalendarId: input.defaultCalendarId === undefined ? current.defaultCalendarId : (String(input.defaultCalendarId || '').trim() || null),
    closingStrategyMode: 'system',
    closingStrategyCustom: '',
    persuasionLevel: input.persuasionLevel === undefined
      ? current.persuasionLevel
      : normalizeConversationalPersuasionLevel(input.persuasionLevel),
    languageLevel: input.languageLevel === undefined
      ? current.languageLevel
      : normalizeConversationalLanguageLevel(input.languageLevel)
  }

  const existing = await db.get('SELECT id FROM conversational_agent_config WHERE id = 1')
  if (existing) {
    await db.run(`
      UPDATE conversational_agent_config
      SET enabled = ?, ai_provider = ?, model = ?, objective = ?, custom_objective = ?, success_action = ?,
          required_data = ?, handoff_rules = ?, extra_instructions = ?,
          allow_emojis = ?, hide_attended = ?, hide_attended_notifications = ?, default_calendar_id = ?,
          closing_strategy_mode = ?, closing_strategy_custom = ?,
          persuasion_level = ?, language_level = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `, [
      next.enabled ? 1 : 0, next.aiProvider, next.model, next.objective, next.customObjective, next.successAction,
      next.requiredData, next.handoffRules, next.extraInstructions,
      next.allowEmojis ? 1 : 0, 0, next.hideAttendedNotifications ? 1 : 0, next.defaultCalendarId,
      next.closingStrategyMode, next.closingStrategyCustom,
      next.persuasionLevel, next.languageLevel
    ])
  } else {
    await db.run(`
      INSERT INTO conversational_agent_config (
        id, enabled, ai_provider, model, objective, custom_objective, success_action,
        required_data, handoff_rules, extra_instructions,
        allow_emojis, hide_attended, hide_attended_notifications, default_calendar_id,
        closing_strategy_mode, closing_strategy_custom,
        persuasion_level, language_level
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      next.enabled ? 1 : 0, next.aiProvider, next.model, next.objective, next.customObjective, next.successAction,
      next.requiredData, next.handoffRules, next.extraInstructions,
      next.allowEmojis ? 1 : 0, 0, next.hideAttendedNotifications ? 1 : 0, next.defaultCalendarId,
      next.closingStrategyMode, next.closingStrategyCustom,
      next.persuasionLevel, next.languageLevel
    ])
  }

  await recordConversationalAgentEvent({
    contactId: null,
    eventType: 'config_updated',
    detail: { enabled: next.enabled, aiProvider: next.aiProvider, model: next.model, objective: next.objective, successAction: next.successAction }
  })

  return getConversationalAgentConfig()
}

// ---------------------------------------------------------------------------
// Varios agentes conversacionales (contenedores con filtros de entrada)
// ---------------------------------------------------------------------------

function parseJsonField(text, fallback) {
  if (!text) return fallback
  try {
    const parsed = JSON.parse(text)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

function cleanAdvancedClosingContextValue(value, maxLength = 700) {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) {
    return value
      .map((item) => cleanAdvancedClosingContextValue(item, maxLength))
      .filter(Boolean)
      .join('; ')
      .slice(0, maxLength)
  }
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return raw.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

export function normalizeAdvancedClosingContext(input = {}) {
  const raw = input && typeof input === 'object' ? input : {}
  const next = {}

  for (const key of ADVANCED_CLOSING_CONTEXT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    const clean = cleanAdvancedClosingContextValue(raw[key])
    if (!clean) continue
    next[key] = key === 'urgencyLevel'
      ? (ADVANCED_CLOSING_URGENCY_LEVELS.has(clean.toLowerCase()) ? clean.toLowerCase() : 'desconocida')
      : clean
  }

  return next
}

function normalizeStoredAdvancedClosingContext(raw) {
  const parsed = raw && typeof raw === 'object' ? raw : parseJsonField(raw, {})
  const normalized = normalizeAdvancedClosingContext(parsed)
  const updatedAt = cleanAdvancedClosingContextValue(parsed?.updatedAt, 80)
  const updatedBy = cleanAdvancedClosingContextValue(parsed?.updatedBy, 80)
  return {
    ...normalized,
    ...(updatedAt ? { updatedAt } : {}),
    ...(updatedBy ? { updatedBy } : {})
  }
}

function hasAdvancedClosingContext(context = {}) {
  return ADVANCED_CLOSING_CONTEXT_FIELDS.some((field) => Boolean(context?.[field.key]))
}

function cleanCompletionDisplayText(value = '') {
  if (value === null || value === undefined) return ''
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return raw.replace(/\s+/g, ' ').trim()
}

function cleanCompletionTranscriptText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function getCompletionMessageSpeaker(direction = '') {
  const clean = String(direction || '').trim().toLowerCase()
  if (clean === 'outbound' || clean === 'business_echo') return 'Agente'
  if (clean === 'inbound') return 'Contacto'
  return 'Mensaje'
}

function getCompletionMessageText(row = {}) {
  const subject = cleanCompletionTranscriptText(row.subject)
  const text = cleanCompletionTranscriptText(row.message_text)
  if (subject && text) return `Asunto: ${subject}. ${text}`
  if (subject) return `Asunto: ${subject}`
  if (text) return text
  const type = cleanCompletionTranscriptText(row.message_type || 'archivo')
  return `[${type || 'archivo'} sin texto]`
}

function normalizeCompletionSummaryChannel(value = 'whatsapp') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (['email', 'mail', 'correo', 'e_mail'].includes(normalized)) return 'email'
  if (['instagram', 'instagram_dm', 'ig'].includes(normalized)) return 'instagram'
  if (['messenger', 'facebook', 'facebook_messenger', 'fb'].includes(normalized)) return 'messenger'
  if (['sms', 'sms_qr', 'ghl_sms', 'mms'].includes(normalized)) return 'sms'
  if (['webchat', 'web_chat', 'chat_web', 'website_chat', 'site_chat', 'ghl_webchat'].includes(normalized)) return 'webchat'
  return 'whatsapp'
}

const COMPLETION_SMS_TRANSPORTS = ['ghl_sms', 'sms', 'sms_qr', 'mms']
const COMPLETION_WEBCHAT_TRANSPORTS = ['ghl_webchat', 'webchat', 'web_chat', 'chat_web', 'website_chat', 'site_chat']

function completionPhoneTransportFilter(channel = 'whatsapp') {
  if (channel === 'sms') {
    return `AND LOWER(COALESCE(transport, '')) IN (${COMPLETION_SMS_TRANSPORTS.map((item) => `'${item}'`).join(', ')})`
  }
  if (channel === 'webchat') {
    return `AND LOWER(COALESCE(transport, '')) IN (${COMPLETION_WEBCHAT_TRANSPORTS.map((item) => `'${item}'`).join(', ')})`
  }
  return `AND LOWER(COALESCE(transport, '')) NOT IN (${[...COMPLETION_SMS_TRANSPORTS, ...COMPLETION_WEBCHAT_TRANSPORTS].map((item) => `'${item}'`).join(', ')})`
}

async function loadCompletionSummaryMessages(contactId, channel = 'whatsapp') {
  const cleanContactId = String(contactId || '').trim()
  if (!cleanContactId) return []
  const normalizedChannel = normalizeCompletionSummaryChannel(channel)

  if (normalizedChannel === 'instagram' || normalizedChannel === 'messenger') {
    const rows = await db.all(`
      SELECT id, direction, message_type, message_text, NULL AS subject, message_timestamp, created_at
      FROM meta_social_messages
      WHERE contact_id = ? AND platform = ?
      ORDER BY COALESCE(message_timestamp, created_at) ASC
    `, [cleanContactId, normalizedChannel]).catch(() => [])

    return rows.map((row) => ({
      id: row.id,
      speaker: getCompletionMessageSpeaker(row.direction),
      direction: row.direction || '',
      text: getCompletionMessageText(row),
      timestamp: row.message_timestamp || row.created_at || null,
      channel: normalizedChannel
    })).filter((message) => message.text)
  }

  if (normalizedChannel === 'email') {
    const rows = await db.all(`
      SELECT id, direction, 'email' AS message_type, message_text, subject, message_timestamp, created_at
      FROM email_messages
      WHERE contact_id = ?
      ORDER BY COALESCE(message_timestamp, created_at) ASC
    `, [cleanContactId]).catch(() => [])

    return rows.map((row) => ({
      id: row.id,
      speaker: getCompletionMessageSpeaker(row.direction),
      direction: row.direction || '',
      text: getCompletionMessageText(row),
      timestamp: row.message_timestamp || row.created_at || null,
      channel: normalizedChannel
    })).filter((message) => message.text)
  }

  const rows = await db.all(`
    SELECT id, direction, message_type, message_text, NULL AS subject, message_timestamp, created_at
    FROM whatsapp_api_messages
    WHERE contact_id = ?
      ${completionPhoneTransportFilter(normalizedChannel)}
    ORDER BY COALESCE(message_timestamp, created_at) ASC
  `, [cleanContactId]).catch(() => [])

  return rows.map((row) => ({
    id: row.id,
    speaker: getCompletionMessageSpeaker(row.direction),
    direction: row.direction || '',
    text: getCompletionMessageText(row),
    timestamp: row.message_timestamp || row.created_at || null,
    channel: normalizedChannel
  })).filter((message) => message.text)
}

function formatCompletionSummaryTranscript(messages = []) {
  return messages.map((message, index) => {
    const speaker = message.speaker || `Mensaje ${index + 1}`
    const timestamp = message.timestamp ? ` (${message.timestamp})` : ''
    return `${index + 1}. ${speaker}${timestamp}: ${message.text}`
  }).join('\n')
}

function extractCompletionSummaryFromOutput(output = '') {
  const text = String(output || '').trim()
  if (!text) return ''

  const jsonMatch = text.match(/\{[\s\S]*?\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0])
      return cleanCompletionDisplayText(parsed.summary || parsed.resumen || '')
    } catch {
      return ''
    }
  }

  return cleanCompletionDisplayText(text)
}

async function generateCompletionSummaryWithInternalAgent({ contactId, signal, reason = '', actionSummary = '', fallbackSummary = '', channel = 'whatsapp' } = {}) {
  const messages = await loadCompletionSummaryMessages(contactId, channel)
  if (!messages.length) return ''

  if (completionSummaryGeneratorForTest) {
    return cleanCompletionDisplayText(await completionSummaryGeneratorForTest({
      contactId,
      signal,
      reason,
      actionSummary,
      fallbackSummary,
      channel,
      messages
    }))
  }

  const apiKey = await getOpenAIApiKey().catch(() => null)
  if (!apiKey) return ''

  const transcript = formatCompletionSummaryTranscript(messages)
  const instructions = `Eres el creador interno de resúmenes de Ristak. No hablas con el cliente y no continúas la conversación.

Tu única tarea es leer la conversación completa y resumir por qué se concretó la meta.

Reglas:
- Máximo 35 palabras.
- Una sola frase completa.
- Sin listas, sin etiquetas, sin IDs técnicos y sin puntos suspensivos.
- No repitas la cita, el pago o la acción si ya aparece en "Acción mostrada"; enfócate en situación, motivo, molestias, motivaciones, creencias, objeciones o razón de compra.
- Si la conversación no trae contexto útil, usa una frase breve con lo poco disponible.

Responde únicamente JSON válido:
{"summary":"texto"}`

  const prompt = `Señal concretada: ${signal || 'desconocida'}
Acción mostrada por Ristak: ${actionSummary || 'sin accion'}
Motivo técnico: ${reason || 'sin motivo'}
Resumen de respaldo, si existe: ${fallbackSummary || 'sin respaldo'}

Conversación completa:
${transcript}`

  const agent = new Agent({
    name: 'Ristak · Creador de resumen de meta',
    model: COMPLETION_SUMMARY_MODEL,
    instructions
  })

  try {
    const runner = new Runner({
      modelProvider: new OpenAIProvider({ apiKey }),
      tracingDisabled: true
    })
    const result = await runner.run(agent, [{ role: 'user', content: prompt }], {
      maxTurns: 3,
      context: { category: 'conversational_completion_summary', contactId, channel }
    })
    return extractCompletionSummaryFromOutput(result.finalOutput)
  } catch (error) {
    logger.warn(`[Agente conversacional] Resumidor interno de cierre falló: ${error.message}`)
    return ''
  }
}

function conciseCompletionPhrase(value, maxLength = 130) {
  const clean = cleanAdvancedClosingContextValue(value, 700)
  if (!clean || clean.length <= maxLength) return clean

  const naturalBoundary = clean
    .slice(0, maxLength + 1)
    .split(/(?<=[.!?])\s+|[;|]\s+|\s+-\s+/)
    .find((part) => part && part.trim().length >= 28)
  if (naturalBoundary) return naturalBoundary.trim().replace(/[.,;:!?-]+$/g, '')

  const words = clean.split(/\s+/)
  let output = ''
  for (const word of words) {
    const next = output ? `${output} ${word}` : word
    if (next.length > maxLength) break
    output = next
  }
  return (output || clean.slice(0, maxLength)).trim().replace(/[.,;:!?-]+$/g, '')
}

function formatHumanDateTimeFromSummary(summary, timezone = DEFAULT_TIMEZONE) {
  const match = String(summary || '').match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/)
  if (!match) return ''
  const date = new Date(match[0])
  if (Number.isNaN(date.getTime())) return ''

  try {
    const parts = new Intl.DateTimeFormat('es-MX', {
      timeZone: timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).formatToParts(date)
    const get = (type) => parts.find((part) => part.type === type)?.value || ''
    const weekday = get('weekday')
    const day = get('day')
    const month = get('month')
    const hour = get('hour')
    const minute = get('minute')
    const dayPeriod = get('dayPeriod').replace(/\s+/g, '').toLowerCase()
    if (!day || !month || !hour || !minute) return ''
    const clock = minute === '00' ? `${hour} ${dayPeriod}` : `${hour}:${minute} ${dayPeriod}`
    return `el ${weekday ? `${weekday} ` : ''}${day} de ${month} a las ${clock}`
  } catch {
    return ''
  }
}

function formatCompactMoney(amount, currency = '') {
  const numeric = Number(amount)
  const cleanCurrency = String(currency || '').trim().toUpperCase()
  if (!Number.isFinite(numeric) || numeric <= 0) return ''
  const rounded = numeric % 1 === 0 ? numeric.toFixed(0) : numeric.toFixed(2)
  const formatted = Number(rounded).toLocaleString('es-MX')
  return cleanCurrency ? `$${formatted} ${cleanCurrency}` : `$${formatted}`
}

function parsePaymentSummary(summary = '') {
  const text = String(summary || '')
  const amountMatch = text.match(/(?:^|[·\s])([0-9]+(?:[.,][0-9]+)?)\s*([A-Z]{3})?\s*$/)
  const amount = amountMatch ? Number(amountMatch[1].replace(',', '.')) : null
  const currency = amountMatch?.[2] || ''
  return { amount, currency }
}

function buildCompletionActionSummary({ signal, summary = '', reason = '', closingContext = {}, timezone = DEFAULT_TIMEZONE } = {}) {
  const cleanSignal = String(signal || '').trim()
  const baseSummary = cleanAdvancedClosingContextValue(summary, 500)
  const baseReason = cleanAdvancedClosingContextValue(reason, 280)

  if (cleanSignal === 'appointment_booked') {
    const humanDate = formatHumanDateTimeFromSummary(baseSummary, timezone)
    if (humanDate) return `Agendó cita para ${humanDate}`
    if (closingContext.timingPreference) return `Agendó cita para ${conciseCompletionPhrase(closingContext.timingPreference, 120)}`
    return 'Agendó una cita'
  }

  if (cleanSignal === 'purchase_completed') {
    const { amount, currency } = parsePaymentSummary(baseSummary)
    const money = formatCompactMoney(amount, currency)
    return money ? `Pagó ${money}` : 'Pago completado'
  }

  if (cleanSignal === 'ready_to_buy') return 'Quedó listo para pagar'
  if (cleanSignal === 'ready_to_schedule') return 'Quedó listo para agendar'
  if (cleanSignal === 'ready_for_human') return baseReason || 'Objetivo concretado'
  return baseSummary || baseReason || 'Objetivo concretado'
}

async function buildCompletionSummaryFromClosingContext({
  contactId = '',
  signal,
  summary = '',
  reason = '',
  actionSummarySource = '',
  closingContext = {},
  timezone = DEFAULT_TIMEZONE,
  channel = 'whatsapp',
  allowInternalSummary = false
} = {}) {
  const cleanSignal = String(signal || '').trim()
  const baseSummary = cleanCompletionDisplayText(summary)
  const baseReason = cleanCompletionDisplayText(reason)
  const actionSource = cleanCompletionDisplayText(actionSummarySource) || baseSummary
  const normalizedContext = normalizeStoredAdvancedClosingContext(closingContext)
  const actionSummary = buildCompletionActionSummary({ signal, summary: actionSource, reason: baseReason, closingContext: normalizedContext, timezone })
  const hidesMissingSummary = ['appointment_booked', 'purchase_completed'].includes(cleanSignal)
  const generatedSummary = allowInternalSummary && CONVERSATIONAL_AGENT_COMPLETION_SIGNALS.has(cleanSignal)
    ? await generateCompletionSummaryWithInternalAgent({
      contactId,
      signal: cleanSignal,
      reason: baseReason,
      actionSummary,
      fallbackSummary: baseSummary,
      channel
    })
    : ''
  const summaryText = generatedSummary || baseSummary || (hidesMissingSummary ? '' : baseReason)
  const stateSummary = [
    actionSummary,
    summaryText && summaryText !== actionSummary ? `Resumen: ${summaryText}` : ''
  ].filter(Boolean).join('\n')

  return {
    actionSummary,
    summary: summaryText,
    summarySource: generatedSummary ? 'internal_summary_agent' : (baseSummary ? 'tool_fallback' : (summaryText ? 'reason_fallback' : 'empty')),
    stateSummary: stateSummary || actionSummary || summaryText
  }
}

export function mergeAdvancedClosingContext(current = {}, patch = {}, { updatedBy = 'agent', nowIso = new Date().toISOString() } = {}) {
  const normalizedCurrent = normalizeStoredAdvancedClosingContext(current)
  const normalizedPatch = normalizeAdvancedClosingContext(patch)
  const changedKeys = Object.keys(normalizedPatch).filter((key) => normalizedCurrent[key] !== normalizedPatch[key])

  if (!changedKeys.length) {
    return { context: normalizedCurrent, changedKeys: [] }
  }

  return {
    context: {
      ...normalizedCurrent,
      ...normalizedPatch,
      updatedAt: nowIso,
      updatedBy: cleanAdvancedClosingContextValue(updatedBy, 80) || 'agent'
    },
    changedKeys
  }
}

/**
 * Constructor de condiciones del agente. Las condiciones se agrupan en bloques:
 * dentro de un bloque todas deben cumplirse (Y) y entre bloques basta uno (O).
 *
 *   filters = {
 *     entry: { groups: [ { conditions: [cond, ...] }, ... ] },  // (A∧B) ∨ (C∧D)
 *     exit:  { groups: [ ... ] }
 *   }
 *
 * Modelo jerárquico (estilo disparadores de workflow): la categoría SOLA ya
 * dispara con su significado base ("agendó una cita", "vino de anuncio") y
 * cada parámetro agregado la afina de forma opcional y apilable:
 *
 *   cond = { category, params: [ { field, operator, ...valores }, ... ] }
 *
 * En Citas y Pagos los parámetros se evalúan EN CONJUNTO: "calendario es X" +
 * "estado confirmada" exige UNA MISMA cita que cumpla ambos.
 */
export const CONDITION_SCHEMA = {
  // base: llegó un mensaje (siempre cierto al evaluar un mensaje entrante)
  channel: {
    channel: ['is', 'is_not']
  },
  // base: recibió un mensaje
  message: {
    text: ['contains', 'not_contains', 'contains_any', 'contains_all', 'starts_with', 'ends_with', 'equals'],
    business_phone: ['is', 'is_not']
  },
  // base: tiene alguna etiqueta
  tags: {
    tag: ['has', 'not_has', 'has_any', 'has_all', 'has_none']
  },
  // base: es un contacto (siempre cierto); los parámetros afinan su perfil
  contact: {
    name: ['contains', 'not_contains', 'is', 'is_not', 'starts_with', 'ends_with', 'not_empty', 'empty'],
    first_name: ['contains', 'not_contains', 'is', 'is_not', 'starts_with', 'ends_with', 'not_empty', 'empty'],
    last_name: ['contains', 'not_contains', 'is', 'is_not', 'starts_with', 'ends_with', 'not_empty', 'empty'],
    email: ['contains', 'not_contains', 'is', 'is_not', 'starts_with', 'ends_with', 'has', 'no_has'],
    phone: ['contains', 'not_contains', 'is', 'is_not', 'starts_with', 'ends_with', 'not_empty', 'empty'],
    source: ['contains', 'not_contains', 'is', 'is_not', 'starts_with', 'ends_with', 'not_empty', 'empty'],
    attribution_source: ['contains', 'not_contains', 'is', 'is_not', 'starts_with', 'ends_with', 'not_empty', 'empty'],
    attribution_medium: ['contains', 'not_contains', 'is', 'is_not', 'starts_with', 'ends_with', 'not_empty', 'empty'],
    attribution_ad: ['contains', 'not_contains', 'is', 'is_not', 'starts_with', 'ends_with', 'not_empty', 'empty'],
    visitor_id: ['contains', 'not_contains', 'is', 'is_not', 'starts_with', 'ends_with', 'not_empty', 'empty'],
    ghl_contact_id: ['contains', 'not_contains', 'is', 'is_not', 'starts_with', 'ends_with', 'not_empty', 'empty'],
    preferred_phone: ['is', 'is_not', 'not_empty', 'empty'],
    customer: ['is_customer', 'not_customer'],
    created: ['within', 'older_than', 'before', 'after', 'between'],
    updated: ['within', 'older_than', 'before', 'after', 'between'],
    last_purchase: ['within', 'older_than', 'before', 'after', 'between'],
    assigned: ['to', 'not_to', 'any', 'none'],
    custom_field: ['is', 'is_not', 'contains', 'not_contains', 'starts_with', 'ends_with', 'has_value', 'empty']
  },
  // base: agendó/tiene una cita (presence cambia el sentido a "no tiene")
  appointments: {
    presence: ['has', 'none'],
    calendar: ['is', 'is_not'],
    status: ['confirmed', 'pending', 'cancelled', 'showed', 'noshow'],
    timing: ['upcoming', 'past_due', 'today'],
    date: ['is', 'not', 'before', 'after', 'between'],
    window: ['before', 'after']
  },
  // base: tiene algún pago
  payments: {
    presence: ['has', 'none'],
    status: ['received', 'pending', 'failed', 'refunded'],
    product: ['is', 'is_not', 'contains', 'not_contains'],
    amount: ['eq', 'gt', 'lt', 'between']
  },
  // base: vino de un anuncio (clic CTWA de WhatsApp)
  ads: {
    presence: ['exists', 'not_exists', 'from_ad', 'not_from_ad'],
    ad: ['is', 'is_not', 'contains', 'not_contains', 'starts_with', 'ends_with']
  },
  // base: siempre cierto; los parámetros acotan hora/día actuales del negocio
  schedule: {
    time: ['between', 'outside'],
    day: ['is']
  }
}

const CHAT_CONDITION_CHANNELS = new Set(['whatsapp', 'instagram', 'messenger', 'webchat', 'sms'])
// facebook_comment / instagram_comment son canales de COMENTARIO (el agente
// responde en el comentario o por DM según el replyMode de la condición de ingreso).
const CONDITION_CHANNELS = new Set(['chat', ...CHAT_CONDITION_CHANNELS, 'email', 'facebook_comment', 'instagram_comment'])
const COMMENT_CONDITION_CHANNELS = new Set(['facebook_comment', 'instagram_comment'])
const COMMENT_REPLY_MODES = new Set(['public', 'private', 'public_then_private'])
const OFFSET_UNITS = new Set(['minutes', 'hours', 'days'])
const WEEKDAY_KEYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])

function cleanTime(value) {
  const text = String(value || '').trim()
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : ''
}

function cleanValueList(input) {
  if (!Array.isArray(input)) return []
  return input.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 20)
}

function cleanDate(value) {
  const text = String(value || '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : ''
}

function normalizeParam(category, param) {
  if (!param || typeof param !== 'object') return null
  const fields = CONDITION_SCHEMA[category]
  if (!fields) return null
  const field = String(param.field || '')
  const operators = fields[field]
  if (!operators) return null
  let rawOperator = String(param.operator || '')
  if (category === 'ads' && field === 'presence') {
    if (rawOperator === 'from_ad') rawOperator = 'exists'
    if (rawOperator === 'not_from_ad') rawOperator = 'not_exists'
  }
  const operator = operators.includes(rawOperator) ? rawOperator : operators[0]

  const base = { field, operator }

  const wantsList = (
    (field === 'text' && (operator === 'contains_any' || operator === 'contains_all')) ||
    (field === 'tag' && (operator === 'has_any' || operator === 'has_all' || operator === 'has_none')) ||
    (field === 'day')
  )
  if (wantsList) {
    base.values = cleanValueList(param.values)
    if (field === 'day') base.values = base.values.map((day) => day.toLowerCase()).filter((day) => WEEKDAY_KEYS.has(day))
    return base
  }

  if (field === 'channel') {
    base.value = CONDITION_CHANNELS.has(param.value) ? param.value : 'chat'
    // Canal de comentario: preservar el modo de respuesta del agente (público /
    // privado / público-luego-privado) y la publicación específica (opcional).
    if (COMMENT_CONDITION_CHANNELS.has(base.value)) {
      base.replyMode = COMMENT_REPLY_MODES.has(param.replyMode) ? param.replyMode : 'private'
      if (param.postId) base.postId = String(param.postId).trim()
      if (param.postName) base.postName = String(param.postName).trim()
    }
  } else if (field === 'date') {
    base.date = cleanDate(param.date)
    if (operator === 'between') base.dateEnd = cleanDate(param.dateEnd)
  } else if (field === 'window' || (CONTACT_DATE_FIELDS.has(field) && (operator === 'within' || operator === 'older_than'))) {
    base.offsetValue = Math.min(Math.max(Number(param.offsetValue) || 0, 0), 100000)
    base.offsetUnit = OFFSET_UNITS.has(param.offsetUnit) ? param.offsetUnit : (field === 'created' ? 'days' : 'minutes')
    if (CONTACT_DATE_FIELDS.has(field)) base.offsetUnit = OFFSET_UNITS.has(param.offsetUnit) ? param.offsetUnit : 'days'
  } else if (CONTACT_DATE_FIELDS.has(field)) {
    base.date = cleanDate(param.date)
    if (operator === 'between') base.dateEnd = cleanDate(param.dateEnd)
  } else if (field === 'amount') {
    base.amount = Number(param.amount) || 0
    if (operator === 'between') base.amountMax = Number(param.amountMax) || 0
  } else if (field === 'time') {
    base.timeStart = cleanTime(param.timeStart) || '09:00'
    base.timeEnd = cleanTime(param.timeEnd) || '18:00'
  } else if (field === 'custom_field') {
    base.fieldKey = String(param.fieldKey || '').trim().slice(0, 160)
    base.value = String(param.value || '').trim().slice(0, 400)
  } else {
    base.value = String(param.value || '').trim().slice(0, 240)
  }
  return base
}

function normalizeCondition(condition) {
  if (!condition || typeof condition !== 'object') return null
  const category = String(condition.category || '')
  if (!CONDITION_SCHEMA[category]) {
    // Compatibilidad: categorías retiradas del formato anterior
    const converted = legacyConditionToParams(condition)
    return converted ? normalizeCondition(converted) : null
  }

  // Formato anterior (category + operator plano) → params
  if (condition.operator && !Array.isArray(condition.params)) {
    const converted = legacyConditionToParams(condition)
    return converted ? normalizeCondition(converted) : null
  }

  const params = (Array.isArray(condition.params) ? condition.params : [])
    .map((param) => normalizeParam(category, param))
    .filter(Boolean)
    .slice(0, 10)

  return { category, params }
}

/** Convierte una condición del formato anterior (operator plano) a params. */
function legacyConditionToParams(cond) {
  const { category, operator } = cond
  if (category === 'channel') {
    return { category: 'channel', params: [{ field: 'channel', operator, value: cond.value }] }
  }
  if (category === 'message') {
    return { category: 'message', params: [{ field: 'text', operator, value: cond.value, values: cond.values }] }
  }
  if (category === 'business_phone') {
    return { category: 'message', params: [{ field: 'business_phone', operator, value: cond.value }] }
  }
  if (category === 'tags') {
    return { category: 'tags', params: [{ field: 'tag', operator, value: cond.value, values: cond.values }] }
  }
  if (category === 'assignee') {
    const map = { assigned_to: 'to', not_assigned_to: 'not_to', has_assignee: 'any', no_assignee: 'none' }
    return { category: 'contact', params: [{ field: 'assigned', operator: map[operator] || 'any', value: cond.value }] }
  }
  if (category === 'contact') {
    const map = {
      is_customer: { field: 'customer', operator: 'is_customer' },
      not_customer: { field: 'customer', operator: 'not_customer' },
      has_email: { field: 'email', operator: 'has' },
      no_email: { field: 'email', operator: 'no_has' },
      source_is: { field: 'source', operator: 'is', value: cond.value },
      source_contains: { field: 'source', operator: 'contains', value: cond.value },
      created_within: { field: 'created', operator: 'within', offsetValue: cond.offsetValue, offsetUnit: cond.offsetUnit }
    }
    return map[operator] ? { category: 'contact', params: [map[operator]] } : null
  }
  if (category === 'appointments') {
    const map = {
      has_appointment: [],
      no_appointment: [{ field: 'presence', operator: 'none' }],
      has_upcoming: [{ field: 'timing', operator: 'upcoming' }],
      no_upcoming: [{ field: 'presence', operator: 'none' }, { field: 'timing', operator: 'upcoming' }],
      has_past_due: [{ field: 'timing', operator: 'past_due' }],
      has_cancelled: [{ field: 'status', operator: 'cancelled' }],
      has_confirmed: [{ field: 'status', operator: 'confirmed' }],
      in_calendar: [{ field: 'calendar', operator: 'is', value: cond.calendarId }],
      not_in_calendar: [{ field: 'presence', operator: 'none' }, { field: 'calendar', operator: 'is', value: cond.calendarId }],
      date_is: [{ field: 'date', operator: 'is', date: cond.date }],
      date_not: [{ field: 'date', operator: 'not', date: cond.date }],
      date_before: [{ field: 'date', operator: 'before', date: cond.date }],
      date_after: [{ field: 'date', operator: 'after', date: cond.date }],
      date_between: [{ field: 'date', operator: 'between', date: cond.date, dateEnd: cond.dateEnd }],
      time_before: [{ field: 'window', operator: 'before', offsetValue: cond.offsetValue, offsetUnit: cond.offsetUnit }],
      time_after: [{ field: 'window', operator: 'after', offsetValue: cond.offsetValue, offsetUnit: cond.offsetUnit }]
    }
    return map[operator] ? { category: 'appointments', params: map[operator] } : null
  }
  if (category === 'payments') {
    const statusMap = { payment_received: 'received', payment_pending: 'pending', payment_failed: 'failed', payment_refunded: 'refunded' }
    if (statusMap[operator]) {
      return { category: 'payments', params: [{ field: 'status', operator: statusMap[operator] }] }
    }
    if (operator.startsWith('product_')) {
      const opMap = { product_is: 'is', product_not: 'is_not', product_contains: 'contains', product_not_contains: 'not_contains' }
      return { category: 'payments', params: [{ field: 'product', operator: opMap[operator], value: cond.value }] }
    }
    if (operator.startsWith('amount_')) {
      return { category: 'payments', params: [{ field: 'amount', operator: operator.replace('amount_', ''), amount: cond.amount, amountMax: cond.amountMax }] }
    }
    return null
  }
  if (category === 'ads') {
    const map = {
      from_ad: [{ field: 'presence', operator: 'exists' }],
      not_from_ad: [{ field: 'presence', operator: 'not_exists' }],
      ad_is: [{ field: 'ad', operator: 'is', value: cond.value }],
      ad_is_not: [{ field: 'ad', operator: 'is_not', value: cond.value }],
      ad_contains: [{ field: 'ad', operator: 'contains', value: cond.value }],
      ad_not_contains: [{ field: 'ad', operator: 'not_contains', value: cond.value }]
    }
    return map[operator] ? { category: 'ads', params: map[operator] } : null
  }
  if (category === 'schedule') {
    const map = {
      time_between: [{ field: 'time', operator: 'between', timeStart: cond.timeStart, timeEnd: cond.timeEnd }],
      time_outside: [{ field: 'time', operator: 'outside', timeStart: cond.timeStart, timeEnd: cond.timeEnd }],
      day_is: [{ field: 'day', operator: 'is', values: cond.values }]
    }
    return map[operator] ? { category: 'schedule', params: map[operator] } : null
  }
  return null
}

function normalizeGroups(input) {
  if (!Array.isArray(input)) return []
  return input
    .map((group) => ({
      conditions: Array.isArray(group?.conditions)
        ? group.conditions.map(normalizeCondition).filter(Boolean).slice(0, 20)
        : []
    }))
    .filter((group) => group.conditions.length > 0)
    .slice(0, 10)
}

/** Convierte la regla plana del formato anterior a una condición. */
function legacyRuleToCondition(rule) {
  switch (rule?.type) {
    case 'channel':
      return { category: 'channel', operator: 'is', value: rule.channel }
    case 'message_contains': {
      const operator = rule.match === 'exact' ? 'equals' : rule.match === 'starts_with' ? 'starts_with' : 'contains'
      return { category: 'message', operator, value: rule.phrase }
    }
    case 'has_tag':
      return { category: 'tags', operator: 'has', value: rule.tag }
    case 'not_has_tag':
      return { category: 'tags', operator: 'not_has', value: rule.tag }
    case 'has_upcoming_appointment':
      return { category: 'appointments', operator: 'has_upcoming' }
    case 'no_upcoming_appointment':
      return { category: 'appointments', operator: 'no_upcoming' }
    case 'has_appointment_in_calendar':
      return { category: 'appointments', operator: 'in_calendar', calendarId: rule.calendarId }
    default:
      return null
  }
}

function legacySideToGroups(rules) {
  const conditions = (Array.isArray(rules) ? rules : []).map(legacyRuleToCondition).filter(Boolean)
  return conditions.length ? [{ conditions }] : []
}

/** Convierte el formato más viejo de filtros fijos a condiciones. */
function legacyFixedFiltersToGroups(raw) {
  const conditions = []
  if (raw.channel && raw.channel !== 'any') {
    conditions.push({ category: 'channel', operator: 'is', value: raw.channel })
  }
  for (const keyword of Array.isArray(raw.keywords) ? raw.keywords : []) {
    const phrase = String(keyword || '').trim()
    if (phrase) {
      const operator = raw.match === 'exact' ? 'equals' : raw.match === 'starts_with' ? 'starts_with' : 'contains'
      conditions.push({ category: 'message', operator, value: phrase })
    }
  }
  for (const tag of Array.isArray(raw.tags) ? raw.tags : []) {
    const clean = String(tag || '').trim()
    if (clean) conditions.push({ category: 'tags', operator: 'has', value: clean })
  }
  if (raw.calendarId) {
    conditions.push({ category: 'appointments', operator: 'in_calendar', calendarId: String(raw.calendarId).trim() })
  }
  return conditions.length ? [{ conditions }] : []
}

function normalizeAgentFilters(input) {
  const raw = input && typeof input === 'object' ? input : {}

  // Formato actual: { entry: { groups }, exit: { groups } }
  if (raw.entry?.groups !== undefined || raw.exit?.groups !== undefined) {
    return {
      entry: { groups: normalizeGroups(raw.entry?.groups) },
      exit: { groups: normalizeGroups(raw.exit?.groups) }
    }
  }

  // Formato anterior: { entry: [reglas], exit: [reglas] }
  if (Array.isArray(raw.entry) || Array.isArray(raw.exit)) {
    return {
      entry: { groups: normalizeGroups(legacySideToGroups(raw.entry)) },
      exit: { groups: normalizeGroups(legacySideToGroups(raw.exit)) }
    }
  }

  // Formato más viejo: { channel, keywords, match, tags, calendarId }
  return {
    entry: { groups: normalizeGroups(legacyFixedFiltersToGroups(raw)) },
    exit: { groups: [] }
  }
}

const SUCCESS_EXTRA_TYPES = new Set(['add_tag', 'remove_tag', 'set_custom_field'])
const GOAL_WORKFLOW_OWNERS = new Set(['human', 'ai', 'url'])
const GOAL_WORKFLOW_DEPOSIT_MODES = new Set(['fixed', 'range'])
const GOAL_WORKFLOW_SALES_PAYMENT_MODES = new Set(['full_payment', 'deposit'])
const GOAL_WORKFLOW_COMPLETION_MODES = new Set(['notify_only', 'assign_user'])
export const CONVERSATIONAL_AGENT_GOAL_WEBHOOK_PATH = '/webhook/conversational-agent/goal'
export const DEFAULT_GOAL_TRACKING_PARAM = 'ristak_goal_id'
export const CONVERSATIONAL_GOAL_TOKEN_QUERY_PARAM = 'ristak_goal_token'
const SUCCESSFUL_GOAL_STATUSES = {
  citas: new Set(['scheduled', 'confirmed', 'booked', 'completed', 'complete']),
  ventas: new Set(['paid', 'approved', 'succeeded', 'successful', 'settled', 'completed', 'complete']),
  custom: new Set(['approved', 'confirmed', 'succeeded', 'successful', 'completed', 'complete'])
}

const DEFAULT_GOAL_WORKFLOW_CONFIG = {
  appointments: {
    owner: 'human',
    calendarId: null,
    url: '',
    trackingParam: DEFAULT_GOAL_TRACKING_PARAM,
    allowOverlappingAppointments: false
  },
  sales: {
    owner: 'human',
    productId: '',
    priceId: '',
    productName: '',
    priceName: '',
    amount: null,
    currency: '',
    paymentMode: 'full_payment',
    url: '',
    trackingParam: DEFAULT_GOAL_TRACKING_PARAM
  },
  data: {
    afterComplete: 'human'
  },
  qualification: {
    questions: '',
    qualifies: '',
    disqualifies: ''
  },
  triggerLink: {
    triggerLinkId: '',
    triggerLinkPublicId: '',
    triggerLinkName: '',
    triggerLinkUrl: ''
  },
  deposit: {
    enabled: false,
    mode: 'fixed',
    amount: null,
    minAmount: null,
    maxAmount: null,
    currency: ''
  },
  completion: {
    mode: 'notify_only',
    userId: '',
    userName: ''
  }
}

function normalizeSuccessExtras(input) {
  if (!Array.isArray(input)) return []
  return input
    .filter((extra) => extra && SUCCESS_EXTRA_TYPES.has(extra.type))
    .map((extra) => ({
      type: extra.type,
      tag: String(extra.tag || '').trim().slice(0, 120),
      tagId: String(extra.tagId || '').trim().slice(0, 180),
      tagName: String(extra.tagName || '').trim().slice(0, 120),
      field: String(extra.field || '').trim().slice(0, 120),
      value: String(extra.value || '').trim().slice(0, 400)
    }))
    .filter((extra) => (extra.type === 'set_custom_field' ? Boolean(extra.field) : Boolean(extra.tag || extra.tagId)))
    .slice(0, 12)
}

function normalizeConversationGoalCompletionEffectPlanPayload(input = {}) {
  const workflow = normalizeAgentGoalWorkflow({ completion: input.completion })
  const completion = workflow.completion || DEFAULT_GOAL_WORKFLOW_CONFIG.completion
  return {
    version: 1,
    agentId: String(input.agentId || '').trim().slice(0, 180),
    agentUpdatedAt: String(input.agentUpdatedAt || '').trim().slice(0, 80),
    completion: {
      mode: completion.mode,
      userId: String(completion.userId || '').trim().slice(0, 160),
      userName: String(completion.userName || '').trim().slice(0, 160)
    },
    successExtras: normalizeSuccessExtras(input.successExtras)
  }
}

function hashConversationGoalCompletionEffectPlan(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

async function buildConversationGoalCompletionEffectPlan(agent) {
  const workflow = normalizeAgentGoalWorkflow(agent?.goalWorkflow)
  const completion = workflow.completion || DEFAULT_GOAL_WORKFLOW_CONFIG.completion
  const extras = normalizeSuccessExtras(agent?.successExtras)
  const canonicalExtras = []
  for (const extra of extras) {
    if (extra.type !== 'add_tag' && extra.type !== 'remove_tag') {
      canonicalExtras.push(extra)
      continue
    }
    const [tagId] = await resolveTagIds([extra.tag], { createMissing: false })
    const [tagName] = tagId ? await tagNamesForIds([tagId]) : [extra.tag]
    canonicalExtras.push({
      ...extra,
      tag: tagId || extra.tag,
      tagId: tagId || '',
      tagName: tagName || extra.tag
    })
  }
  const payload = normalizeConversationGoalCompletionEffectPlanPayload({
    agentId: String(agent?.id || '').trim().slice(0, 180),
    agentUpdatedAt: agent?.updatedAt,
    completion: {
      mode: completion.mode,
      userId: String(completion.userId || '').trim().slice(0, 160),
      userName: String(completion.userName || '').trim().slice(0, 160)
    },
    successExtras: canonicalExtras
  })
  return { ...payload, planHash: hashConversationGoalCompletionEffectPlan(payload) }
}

function conversationGoalEffectAgentFromMetadata(metadata) {
  const plan = metadata?.completionEffectPlan
  if (!plan || Number(plan.version) !== 1) {
    throw new Error('La meta no tiene un plan inmutable de efectos para recuperarse de forma segura')
  }
  const payload = normalizeConversationGoalCompletionEffectPlanPayload(plan)
  const expectedHash = hashConversationGoalCompletionEffectPlan(payload)
  if (!/^[a-f0-9]{64}$/.test(String(plan.planHash || '')) || plan.planHash !== expectedHash) {
    throw new Error('El plan inmutable de efectos de la meta no pasó su verificación de integridad')
  }
  return {
    id: payload.agentId || null,
    goalWorkflow: {
      completion: payload.completion
    },
    successExtras: payload.successExtras
  }
}

function normalizeAgentIdentityMode(value, fallback = 'business') {
  const mode = String(value || '').trim()
  if (VALID_AGENT_IDENTITY_MODES.has(mode)) return mode
  return VALID_AGENT_IDENTITY_MODES.has(fallback) ? fallback : 'business'
}

function normalizeAgentIdentityText(value, maxLength = 160) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeAgentIdentity(input = {}, base = {}) {
  const mode = normalizeAgentIdentityMode(
    input.identityMode === undefined ? base.identityMode : input.identityMode,
    base.identityMode
  )
  const userId = input.identityUserId === undefined ? base.identityUserId : input.identityUserId
  const userName = input.identityUserName === undefined ? base.identityUserName : input.identityUserName
  const customName = input.identityCustomName === undefined ? base.identityCustomName : input.identityCustomName

  return {
    identityMode: mode,
    identityUserId: mode === 'user' ? normalizeAgentIdentityText(userId) : '',
    identityUserName: mode === 'user' ? normalizeAgentIdentityText(userName) : '',
    identityCustomName: mode === 'custom' ? normalizeAgentIdentityText(customName) : ''
  }
}

function normalizeGoalOwner(value, fallback = 'human') {
  const owner = String(value || '').trim()
  return GOAL_WORKFLOW_OWNERS.has(owner) ? owner : fallback
}

function normalizeDepositMode(value, fallback = 'fixed') {
  const mode = String(value || '').trim()
  return GOAL_WORKFLOW_DEPOSIT_MODES.has(mode) ? mode : fallback
}

function normalizeSalesPaymentMode(value, fallback = 'full_payment') {
  const mode = String(value || '').trim()
  return GOAL_WORKFLOW_SALES_PAYMENT_MODES.has(mode) ? mode : fallback
}

function normalizeCompletionMode(value, fallback = 'notify_only') {
  const mode = String(value || '').trim()
  return GOAL_WORKFLOW_COMPLETION_MODES.has(mode) ? mode : fallback
}

function normalizeTrackingParam(value) {
  const param = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
  return param || DEFAULT_GOAL_TRACKING_PARAM
}

function normalizeGoalUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith('/')
    ? raw
    : `https://${raw}`
  const base = `${String(process.env.RENDER_EXTERNAL_URL || PUBLIC_URL || 'http://localhost:3002').replace(/\/+$/, '')}/`
  try {
    return new URL(withProtocol, base).toString()
  } catch {
    return ''
  }
}

function normalizeNullableAmount(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return null
  return Math.round(amount * 100) / 100
}

export function normalizeAgentGoalWorkflow(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const appointments = raw.appointments && typeof raw.appointments === 'object' ? raw.appointments : {}
  const sales = raw.sales && typeof raw.sales === 'object' ? raw.sales : {}
  const qualification = raw.qualification && typeof raw.qualification === 'object' ? raw.qualification : {}
  const triggerLink = raw.triggerLink && typeof raw.triggerLink === 'object' ? raw.triggerLink : {}
  const deposit = raw.deposit && typeof raw.deposit === 'object' ? raw.deposit : {}
  const completion = raw.completion && typeof raw.completion === 'object' ? raw.completion : {}
  const legacyDepositEnabled = toBoolean(deposit.enabled)
  const salesPaymentMode = normalizeSalesPaymentMode(
    sales.paymentMode || sales.payment_mode,
    legacyDepositEnabled ? 'deposit' : DEFAULT_GOAL_WORKFLOW_CONFIG.sales.paymentMode
  )

  return {
    appointments: {
      owner: normalizeGoalOwner(appointments.owner, DEFAULT_GOAL_WORKFLOW_CONFIG.appointments.owner),
      calendarId: String(appointments.calendarId || '').trim() || null,
      url: normalizeGoalUrl(appointments.url),
      trackingParam: normalizeTrackingParam(appointments.trackingParam),
      allowOverlappingAppointments: toBoolean(
        appointments.allowOverlappingAppointments ??
        appointments.allow_overlapping_appointments ??
        appointments.allowOverlaps ??
        appointments.allow_overlaps
      )
    },
    sales: {
      owner: normalizeGoalOwner(sales.owner, DEFAULT_GOAL_WORKFLOW_CONFIG.sales.owner),
      productId: String(sales.productId || '').trim().slice(0, 160),
      priceId: String(sales.priceId || '').trim().slice(0, 160),
      productName: String(sales.productName || '').trim().slice(0, 240),
      priceName: String(sales.priceName || '').trim().slice(0, 160),
      amount: normalizeNullableAmount(sales.amount),
      currency: String(sales.currency || '').trim().slice(0, 12).toUpperCase(),
      paymentMode: salesPaymentMode,
      url: normalizeGoalUrl(sales.url),
      trackingParam: normalizeTrackingParam(sales.trackingParam)
    },
    data: {
      afterComplete: 'human'
    },
    qualification: {
      questions: String(qualification.questions || '').slice(0, 2000),
      qualifies: String(qualification.qualifies || '').slice(0, 2000),
      disqualifies: String(qualification.disqualifies || '').slice(0, 2000)
    },
    triggerLink: {
      triggerLinkId: String(triggerLink.triggerLinkId || triggerLink.id || '').trim().slice(0, 180),
      triggerLinkPublicId: String(triggerLink.triggerLinkPublicId || triggerLink.publicId || '').trim().slice(0, 120),
      triggerLinkName: String(triggerLink.triggerLinkName || triggerLink.name || '').trim().slice(0, 160),
      triggerLinkUrl: normalizeGoalUrl(triggerLink.triggerLinkUrl || triggerLink.publicUrl || triggerLink.url)
    },
    deposit: {
      enabled: toBoolean(deposit.enabled),
      mode: normalizeDepositMode(deposit.mode, DEFAULT_GOAL_WORKFLOW_CONFIG.deposit.mode),
      amount: normalizeNullableAmount(deposit.amount),
      minAmount: normalizeNullableAmount(deposit.minAmount),
      maxAmount: normalizeNullableAmount(deposit.maxAmount),
      currency: String(deposit.currency || sales.currency || DEFAULT_GOAL_WORKFLOW_CONFIG.deposit.currency).trim().slice(0, 12).toUpperCase()
    },
    completion: {
      mode: normalizeCompletionMode(completion.mode, DEFAULT_GOAL_WORKFLOW_CONFIG.completion.mode),
      userId: String(completion.userId || completion.user_id || '').trim().slice(0, 120),
      userName: String(completion.userName || completion.user_name || '').trim().slice(0, 180)
    }
  }
}

function getPublicWebhookBaseUrl() {
  return String(process.env.RENDER_EXTERNAL_URL || PUBLIC_URL || 'http://localhost:3002').replace(/\/+$/, '')
}

export function getConversationalGoalWebhookUrl(goalId = '') {
  const cleanGoalId = String(goalId || '').trim()
  const url = new URL(
    cleanGoalId
      ? `${CONVERSATIONAL_AGENT_GOAL_WEBHOOK_PATH}/${encodeURIComponent(cleanGoalId)}`
      : CONVERSATIONAL_AGENT_GOAL_WEBHOOK_PATH,
    `${getPublicWebhookBaseUrl()}/`
  )
  return url.toString()
}

function hashConversationGoalToken(token) {
  return createHash('sha256').update(String(token || ''), 'utf8').digest('hex')
}

function conversationGoalTokenMatches(storedHash, suppliedToken) {
  const cleanStoredHash = String(storedHash || '').trim().toLowerCase()
  const cleanSuppliedToken = String(suppliedToken || '').trim()
  if (!/^[a-f0-9]{64}$/.test(cleanStoredHash) || !cleanSuppliedToken || cleanSuppliedToken.length > 256) {
    return false
  }

  const expected = Buffer.from(cleanStoredHash, 'hex')
  const received = Buffer.from(hashConversationGoalToken(cleanSuppliedToken), 'hex')
  return expected.length === received.length && timingSafeEqual(expected, received)
}

function normalizeGoalLinkParams(params = {}) {
  if (!params || typeof params !== 'object') return {}
  return Object.entries(params).reduce((acc, [key, value]) => {
    const cleanKey = normalizeTrackingParam(key)
    const cleanValue = String(value || '').trim()
    if (cleanKey && cleanValue) acc[cleanKey] = cleanValue.slice(0, 240)
    return acc
  }, {})
}

function buildTrackedGoalUrl(targetUrl, trackingParam, goalId, linkParams = {}) {
  const cleanTargetUrl = normalizeGoalUrl(targetUrl)
  if (!cleanTargetUrl) {
    throw Object.assign(new Error('Configura un enlace válido para mandar este objetivo'), { statusCode: 400 })
  }
  const parsed = new URL(cleanTargetUrl)
  parsed.searchParams.set(normalizeTrackingParam(trackingParam), goalId)
  for (const [key, value] of Object.entries(normalizeGoalLinkParams(linkParams))) {
    parsed.searchParams.set(key, value)
  }
  return parsed.toString()
}

function normalizeGoalLinkObjective(value) {
  const objective = String(value || '').trim()
  if (objective === 'ventas' || objective === 'citas') return objective
  return 'custom'
}

function compactExpectedGoalReference(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const amount = normalizeNullableAmount(source.amount)
  return {
    calendarId: String(source.calendarId || '').trim().slice(0, 160),
    productId: String(source.productId || '').trim().slice(0, 160),
    priceId: String(source.priceId || '').trim().slice(0, 160),
    productName: String(source.productName || '').trim().slice(0, 240),
    priceName: String(source.priceName || '').trim().slice(0, 160),
    amount,
    currency: String(source.currency || '').trim().slice(0, 12).toUpperCase()
  }
}

async function resolveGoalLinkMetadata({ agentId, objective, metadata }) {
  const source = metadata && typeof metadata === 'object' ? metadata : {}
  const suppliedExpected = compactExpectedGoalReference(source.expected)
  let configuredExpected = {}

  if (agentId) {
    // Una falla de DB no puede degradar silenciosamente la validación de la
    // evidencia. Si la lectura falla, crear el enlace también falla cerrado.
    const agent = await getConversationalAgent(String(agentId))
    if (agent?.goalWorkflow) {
      if (objective === 'citas') {
        configuredExpected = {
          calendarId: agent.goalWorkflow.appointments?.calendarId || agent.defaultCalendarId || ''
        }
      } else if (objective === 'ventas') {
        const sales = agent.goalWorkflow.sales || {}
        configuredExpected = {
          productId: sales.productId,
          priceId: sales.priceId,
          productName: sales.productName,
          priceName: sales.priceName,
          amount: sales.amount,
          currency: sales.currency || await getAccountCurrency()
        }
      }
    }
  }

  const normalizedConfigured = compactExpectedGoalReference(configuredExpected)
  const presentEntries = (value) => Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== '' && entry !== null && entry !== undefined)
  )
  const expected = {
    ...presentEntries(suppliedExpected),
    ...presentEntries(normalizedConfigured)
  }

  return {
    ...source,
    expected
  }
}

function mapGoalLinkRow(row) {
  if (!row) return null
  return {
    id: row.id,
    contactId: row.contact_id,
    agentId: row.agent_id || null,
    objective: row.objective,
    status: row.status,
    targetUrl: row.target_url,
    sentUrl: row.sent_url,
    trackingParam: row.tracking_param || DEFAULT_GOAL_TRACKING_PARAM,
    confirmationExpiresAt: row.confirmation_expires_at || null,
    confirmationUsedAt: row.confirmation_used_at || null,
    completionAuthMethod: row.completion_auth_method || null,
    completionEffectsStatus: row.completion_effects_status || null,
    externalSource: row.external_source || null,
    externalObjectId: row.external_object_id || null,
    externalStatus: row.external_status || null,
    metadata: parseJsonField(row.metadata_json, {}),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    completedAt: row.completed_at || null
  }
}

function normalizeGoalLinkIdempotencyKey(value) {
  const clean = String(value || '').trim()
  if (!clean) return null
  return createHash('sha256').update(clean.slice(0, 1000)).digest('hex')
}

function mapReusableGoalLink(row, linkParams = {}) {
  return {
    ...mapGoalLinkRow(row),
    linkParams,
    confirmationMode: 'trusted_integration',
    idempotent: true
  }
}

function assertReusableGoalLink(row, { contactId, agentId, objective, targetUrl, trackingParam, linkParams }) {
  const sameAgent = String(row.agent_id || '') === String(agentId || '')
  const expectedSentUrl = buildTrackedGoalUrl(targetUrl, trackingParam, row.id, linkParams)
  const matches = String(row.contact_id || '') === String(contactId || '') &&
    sameAgent &&
    String(row.objective || '') === String(objective || '') &&
    String(row.target_url || '') === String(targetUrl || '') &&
    String(row.tracking_param || DEFAULT_GOAL_TRACKING_PARAM) === String(trackingParam || DEFAULT_GOAL_TRACKING_PARAM) &&
    String(row.sent_url || '') === expectedSentUrl
  if (!matches) {
    throw Object.assign(new Error('La llave idempotente ya pertenece a otro enlace de objetivo'), { statusCode: 409 })
  }
  return row
}

export async function createConversationGoalLink({
  contactId,
  agentId = null,
  objective = 'custom',
  targetUrl,
  trackingParam = DEFAULT_GOAL_TRACKING_PARAM,
  linkParams = {},
  metadata = {},
  idempotencyKey = ''
} = {}) {
  const cleanContactId = String(contactId || '').trim()
  if (!cleanContactId) {
    throw Object.assign(new Error('Falta el contacto para crear el enlace de objetivo'), { statusCode: 400 })
  }

  const cleanObjective = normalizeGoalLinkObjective(objective)
  const cleanTrackingParam = normalizeTrackingParam(trackingParam)
  const cleanTargetUrl = normalizeGoalUrl(targetUrl)
  const cleanLinkParams = normalizeGoalLinkParams(linkParams)
  const cleanAgentId = agentId ? String(agentId).trim() : null
  const cleanIdempotencyKey = normalizeGoalLinkIdempotencyKey(idempotencyKey)
  if (cleanIdempotencyKey) {
    const existing = await db.get(
      'SELECT * FROM conversational_agent_goal_links WHERE idempotency_key = ?',
      [cleanIdempotencyKey]
    ).catch(() => null)
    if (existing) {
      assertReusableGoalLink(existing, {
        contactId: cleanContactId,
        agentId: cleanAgentId,
        objective: cleanObjective,
        targetUrl: cleanTargetUrl,
        trackingParam: cleanTrackingParam,
        linkParams: cleanLinkParams
      })
      return mapReusableGoalLink(existing, cleanLinkParams)
    }
  }

  const id = `goal_${randomUUID()}`
  const sentUrl = buildTrackedGoalUrl(cleanTargetUrl, cleanTrackingParam, id, cleanLinkParams)
  const cleanMetadata = await resolveGoalLinkMetadata({
    agentId: cleanAgentId,
    objective: cleanObjective,
    metadata
  })
  try {
    const registered = await db.run(`
      INSERT INTO conversational_agent_goal_links (
        id, contact_id, agent_id, objective, status, target_url, sent_url,
        tracking_param, idempotency_key, completion_auth_method, metadata_json
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, 'trusted_integration', ?)
    `, [
      id,
      cleanContactId,
      cleanAgentId,
      cleanObjective,
      cleanTargetUrl,
      sentUrl,
      cleanTrackingParam,
      cleanIdempotencyKey,
      JSON.stringify(cleanMetadata)
    ])
    if (Number(registered?.changes || registered?.rowCount || 0) !== 1) {
      throw new Error('No se pudo guardar el enlace del objetivo')
    }
  } catch (error) {
    if (cleanIdempotencyKey) {
      const existing = await db.get(
        'SELECT * FROM conversational_agent_goal_links WHERE idempotency_key = ?',
        [cleanIdempotencyKey]
      ).catch(() => null)
      if (existing) {
        assertReusableGoalLink(existing, {
          contactId: cleanContactId,
          agentId: cleanAgentId,
          objective: cleanObjective,
          targetUrl: cleanTargetUrl,
          trackingParam: cleanTrackingParam,
          linkParams: cleanLinkParams
        })
        return mapReusableGoalLink(existing, cleanLinkParams)
      }
    }
    throw error
  }

  await recordConversationalAgentEvent({
    contactId: cleanContactId,
    eventType: 'goal_url_created',
    detail: {
      goalId: id,
      agentId: cleanAgentId,
      objective: cleanObjective,
      trackingParam: cleanTrackingParam,
      targetUrl: cleanTargetUrl,
      linkParams: cleanLinkParams,
      confirmationMode: 'trusted_integration'
    }
  })

  return {
    id,
    contactId: cleanContactId,
    agentId: cleanAgentId,
    objective: cleanObjective,
    status: 'pending',
    targetUrl: cleanTargetUrl,
    sentUrl,
    trackingParam: cleanTrackingParam,
    linkParams: cleanLinkParams,
    confirmationMode: 'trusted_integration',
    idempotent: false
  }
}

export async function getConversationGoalLink(goalId) {
  const cleanGoalId = String(goalId || '').trim()
  if (!cleanGoalId) return null
  return mapGoalLinkRow(await db.get('SELECT * FROM conversational_agent_goal_links WHERE id = ?', [cleanGoalId]))
}

function conversationSignalForGoalObjective(objective) {
  if (objective === 'ventas') {
    return {
      signal: 'purchase_completed',
      reason: 'Compra confirmada desde enlace de pedido',
      objectLabel: 'compra'
    }
  }
  if (objective === 'citas') {
    return {
      signal: 'appointment_booked',
      reason: 'Cita confirmada desde enlace de calendario',
      objectLabel: 'cita'
    }
  }
  return {
    signal: 'ready_for_human',
    reason: 'Objetivo confirmado desde enlace',
    objectLabel: 'objetivo'
  }
}

function normalizeExactGoalReference(value) {
  return String(value || '').trim()
}

function assertSuccessfulGoalStatus(objective, externalStatus) {
  const cleanStatus = String(externalStatus || '').trim().toLowerCase()
  const allowed = SUCCESSFUL_GOAL_STATUSES[objective] || SUCCESSFUL_GOAL_STATUSES.custom
  if (!cleanStatus || !allowed.has(cleanStatus)) {
    throw Object.assign(
      new Error('La confirmación no trae un estado exitoso permitido para este objetivo'),
      { statusCode: 409 }
    )
  }
  return cleanStatus
}

function throwExpectedGoalReferenceError(label, missing = false) {
  const feminine = label === 'moneda'
  const expectedLabel = `${feminine ? 'la' : 'el'} ${label} esperad${feminine ? 'a' : 'o'}`
  throw Object.assign(
    new Error(missing
      ? `La confirmación no incluyó ${expectedLabel}`
      : `La confirmación no corresponde a ${expectedLabel}`),
    { statusCode: 409 }
  )
}

function validateExpectedGoalReference(expected = {}, received = {}) {
  const checks = [
    ['calendarId', 'calendario'],
    ['productId', 'producto'],
    ['priceId', 'precio']
  ]
  for (const [key, label] of checks) {
    const expectedValue = normalizeExactGoalReference(expected[key])
    const receivedValue = normalizeExactGoalReference(received[key])
    if (!expectedValue) continue
    if (!receivedValue) throwExpectedGoalReferenceError(label, true)
    if (expectedValue !== receivedValue) throwExpectedGoalReferenceError(label)
  }

  const expectedAmount = normalizeNullableAmount(expected.amount)
  if (expectedAmount !== null) {
    const receivedAmount = normalizeNullableAmount(received.amount)
    if (receivedAmount === null) throwExpectedGoalReferenceError('importe', true)
    if (Math.abs(expectedAmount - receivedAmount) > 0.000001) {
      throwExpectedGoalReferenceError('importe')
    }
  }

  const expectedCurrency = String(expected.currency || '').trim().toUpperCase()
  if (expectedCurrency) {
    const receivedCurrency = String(received.currency || '').trim().toUpperCase()
    if (!receivedCurrency) throwExpectedGoalReferenceError('moneda', true)
    if (expectedCurrency !== receivedCurrency) throwExpectedGoalReferenceError('moneda')
  }
}

const CONVERSATION_GOAL_EFFECTS_LEASE_MS = 2 * 60 * 1000

function normalizeCompletionRequestId(value) {
  const clean = String(value || '').trim()
  if (clean.length > 1000) {
    throw Object.assign(new Error('Idempotency-Key excede el máximo de 1000 caracteres'), { statusCode: 400 })
  }
  return clean ? createHash('sha256').update(clean).digest('hex') : ''
}

function authorizeConversationGoalCompletion(row, confirmationToken, authorization = {}) {
  const type = String(authorization?.type || '').trim()
  if (type === 'external_api') {
    const actorId = String(authorization.actorId || '').trim().slice(0, 160)
    const requestId = normalizeCompletionRequestId(authorization.requestId)
    if (!actorId || !requestId) {
      throw Object.assign(new Error('La integración debe enviar actor e Idempotency-Key'), { statusCode: 400 })
    }
    return { method: 'external_api', actorId, requestId }
  }

  if (!row.confirmation_token_hash || !conversationGoalTokenMatches(row.confirmation_token_hash, confirmationToken)) {
    throw Object.assign(new Error('La confirmación del objetivo no está autorizada'), { statusCode: 401 })
  }
  const expirationMs = new Date(row.confirmation_expires_at).getTime()
  if (!Number.isFinite(expirationMs) || Date.now() >= expirationMs) {
    throw Object.assign(new Error('La confirmación del objetivo expiró; genera y envía un enlace nuevo'), { statusCode: 410 })
  }
  return {
    method: 'legacy_token',
    actorId: '',
    requestId: row.confirmation_token_hash
  }
}

function normalizeBoundedGoalReference(value, label, maxLength) {
  const clean = String(value || '').trim()
  if (clean.length > maxLength) {
    throw Object.assign(new Error(`${label} excede el máximo de ${maxLength} caracteres`), { statusCode: 400 })
  }
  return clean
}

function normalizeReceivedGoalAmount(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const numeric = Number(value)
  const rounded = Math.round(numeric * 100) / 100
  if (!Number.isFinite(numeric) || numeric <= 0 || !Number.isFinite(rounded)) {
    throw Object.assign(new Error('amount debe ser un número finito mayor que cero'), { statusCode: 400 })
  }
  return rounded
}

function normalizeReceivedGoalReference({ calendarId, productId, priceId, amount, currency } = {}) {
  return {
    calendarId: normalizeBoundedGoalReference(calendarId, 'calendarId', 160),
    productId: normalizeBoundedGoalReference(productId, 'productId', 160),
    priceId: normalizeBoundedGoalReference(priceId, 'priceId', 160),
    amount: normalizeReceivedGoalAmount(amount),
    currency: normalizeBoundedGoalReference(currency, 'currency', 12).toUpperCase()
  }
}

function normalizeExternalEvidenceSource(value, objective, { required = false } = {}) {
  const fallback = required ? '' : `legacy:${String(objective || 'custom').trim().toLowerCase() || 'custom'}`
  const clean = String(value || fallback).trim().toLowerCase()
  if (!clean) {
    throw Object.assign(new Error('La confirmación requiere externalSource para identificar el sistema de origen'), { statusCode: 400 })
  }
  if (!/^[a-z0-9][a-z0-9._:-]{0,79}$/.test(clean)) {
    throw Object.assign(new Error('externalSource debe ser un identificador estable de hasta 80 caracteres'), { statusCode: 400 })
  }
  return clean
}

function buildExternalEvidenceKey(externalSource, externalObjectId) {
  return createHash('sha256')
    .update(`${String(externalSource || '')}\0${normalizeExactGoalReference(externalObjectId)}`)
    .digest('hex')
}

function buildConversationGoalConfirmationFingerprint({
  externalSource,
  externalObjectId,
  externalStatus,
  receivedReference
}) {
  return createHash('sha256').update(JSON.stringify({
    externalSource: String(externalSource || ''),
    externalObjectId: normalizeExactGoalReference(externalObjectId),
    externalStatus: String(externalStatus || '').trim().toLowerCase(),
    receivedReference: normalizeReceivedGoalReference(receivedReference)
  })).digest('hex')
}

function conversationGoalEvidenceClaimMatches(claim, expected) {
  return String(claim?.goal_id || '') === String(expected.goalId || '') &&
    String(claim?.external_evidence_key || '') === String(expected.externalEvidenceKey || '') &&
    String(claim?.external_source || '') === String(expected.externalSource || '') &&
    String(claim?.confirmation_fingerprint || '') === String(expected.confirmationFingerprint || '') &&
    String(claim?.completion_auth_method || '') === String(expected.authorization?.method || '') &&
    String(claim?.completion_actor_id || '') === String(expected.authorization?.actorId || '') &&
    String(claim?.completion_request_id || '') === String(expected.authorization?.requestId || '')
}

async function claimConversationGoalEvidence(tx, expected) {
  const legacyWildcard = await tx.get(`
    SELECT goal_id
    FROM conversational_agent_goal_evidence_claims
    WHERE external_source = 'legacy:wildcard'
      AND legacy_external_object_id = ?
    LIMIT 1
  `, [expected.externalObjectId])
  if (legacyWildcard && String(legacyWildcard.goal_id || '') !== String(expected.goalId || '')) {
    throw Object.assign(new Error('Esa evidencia coincide con una confirmación legacy y no puede reutilizarse'), { statusCode: 409 })
  }

  const inserted = await tx.run(`
    INSERT INTO conversational_agent_goal_evidence_claims (
      external_evidence_key, external_source, confirmation_fingerprint,
      goal_id, completion_auth_method, completion_actor_id, completion_request_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `, [
    expected.externalEvidenceKey,
    expected.externalSource,
    expected.confirmationFingerprint,
    expected.goalId,
    expected.authorization.method,
    expected.authorization.actorId || '',
    expected.authorization.requestId
  ])
  if (databaseChangeCount(inserted) === 1) return { created: true }

  const evidenceOwner = await tx.get(
    'SELECT * FROM conversational_agent_goal_evidence_claims WHERE external_evidence_key = ?',
    [expected.externalEvidenceKey]
  )
  if (evidenceOwner) {
    if (conversationGoalEvidenceClaimMatches(evidenceOwner, expected)) return { created: false, idempotent: true }
    if (String(evidenceOwner.goal_id || '') === String(expected.goalId || '')) {
      throw Object.assign(new Error('Esa evidencia externa ya fue usada con datos o autorización distintos'), { statusCode: 409 })
    }
    throw Object.assign(new Error('Esa evidencia externa ya confirmó otra meta'), { statusCode: 409 })
  }

  const requestOwner = await tx.get(`
    SELECT *
    FROM conversational_agent_goal_evidence_claims
    WHERE completion_auth_method = ?
      AND completion_actor_id = ?
      AND completion_request_id = ?
  `, [
    expected.authorization.method,
    expected.authorization.actorId || '',
    expected.authorization.requestId
  ])
  if (requestOwner) {
    throw Object.assign(new Error('Ese Idempotency-Key ya fue usado para confirmar otra meta o evidencia'), { statusCode: 409 })
  }

  const goalOwner = await tx.get(
    'SELECT * FROM conversational_agent_goal_evidence_claims WHERE goal_id = ?',
    [expected.goalId]
  )
  if (goalOwner) {
    throw Object.assign(new Error('Esta meta ya fue reclamada con otra evidencia o autorización'), { statusCode: 409 })
  }
  throw Object.assign(new Error('No se pudo reclamar la evidencia externa de forma exclusiva'), { statusCode: 409 })
}

function goalReferencesMatch(left = {}, right = {}) {
  return normalizeExactGoalReference(left.calendarId) === normalizeExactGoalReference(right.calendarId) &&
    normalizeExactGoalReference(left.productId) === normalizeExactGoalReference(right.productId) &&
    normalizeExactGoalReference(left.priceId) === normalizeExactGoalReference(right.priceId) &&
    normalizeNullableAmount(left.amount) === normalizeNullableAmount(right.amount) &&
    String(left.currency || '').trim().toUpperCase() === String(right.currency || '').trim().toUpperCase()
}

function completedGoalRequestMatches(row, authorization, externalSource, externalObjectId, externalStatus, receivedReference) {
  const storedMetadata = parseJsonField(row.metadata_json, {})
  const storedReference = storedMetadata.receivedReference && typeof storedMetadata.receivedReference === 'object'
    ? storedMetadata.receivedReference
    : {}
  const sameRequest = String(row.completion_request_id || '') === String(authorization.requestId || '')
  const sameMethod = String(row.completion_auth_method || '') === String(authorization.method || '')
  const sameActor = String(row.completion_actor_id || '') === String(authorization.actorId || '')
  return sameRequest && sameMethod && sameActor &&
    String(row.external_source || '') === String(externalSource || '') &&
    normalizeExactGoalReference(row.external_object_id) === normalizeExactGoalReference(externalObjectId) &&
    String(row.external_status || '').trim().toLowerCase() === String(externalStatus || '').trim().toLowerCase() &&
    goalReferencesMatch(storedReference, receivedReference)
}

const GOAL_EFFECT_CHECKPOINT_COLUMNS = new Set([
  'completion_signal_applied_at',
  'completion_action_applied_at',
  'completion_extras_applied_at',
  'completion_event_recorded_at'
])

function databaseChangeCount(result) {
  return Number(result?.changes || result?.rowCount || 0)
}

function lostConversationGoalEffectsClaimError() {
  const error = new Error('Otro worker tomó la recuperación de esta meta')
  error.code = 'CONVERSATIONAL_GOAL_EFFECTS_CLAIM_LOST'
  return error
}

function goalEffectEventId(goalId, effect) {
  const fingerprint = createHash('sha256').update(String(goalId || '')).digest('hex').slice(0, 40)
  return `cae_goal_${fingerprint}_${String(effect || 'effect').slice(0, 32)}`
}

async function renewConversationGoalEffectsLease(goalId, claimToken) {
  const now = new Date()
  const leaseUntil = new Date(now.getTime() + CONVERSATION_GOAL_EFFECTS_LEASE_MS).toISOString()
  const renewed = await db.run(`
    UPDATE conversational_agent_goal_links
    SET completion_effects_lease_until_at = ?,
        completion_effects_updated_at = ?
    WHERE id = ?
      AND completion_effects_status = 'processing'
      AND completion_effects_claim_token = ?
  `, [leaseUntil, now.toISOString(), goalId, claimToken])
  if (databaseChangeCount(renewed) !== 1) throw lostConversationGoalEffectsClaimError()
  return leaseUntil
}

async function markConversationGoalEffectApplied(goalId, claimToken, column) {
  if (!GOAL_EFFECT_CHECKPOINT_COLUMNS.has(column)) {
    throw new Error(`Checkpoint de meta no permitido: ${column}`)
  }
  const appliedAt = new Date().toISOString()
  const result = await db.run(`
    UPDATE conversational_agent_goal_links
    SET ${column} = COALESCE(${column}, ?),
        completion_effects_updated_at = ?
    WHERE id = ?
      AND completion_effects_status = 'processing'
      AND completion_effects_claim_token = ?
  `, [appliedAt, appliedAt, goalId, claimToken])
  if (databaseChangeCount(result) !== 1) throw lostConversationGoalEffectsClaimError()
  return appliedAt
}

async function claimConversationGoalNotification(goalId, claimToken) {
  const claimedAt = new Date().toISOString()
  const result = await db.run(`
    UPDATE conversational_agent_goal_links
    SET completion_notification_status = 'claimed',
        completion_notification_claim_token = ?,
        completion_notification_claimed_at = COALESCE(completion_notification_claimed_at, ?),
        completion_notification_last_error = NULL,
        completion_effects_updated_at = ?
    WHERE id = ?
      AND completion_effects_status = 'processing'
      AND completion_effects_claim_token = ?
      AND completion_notification_claimed_at IS NULL
      AND (completion_notification_status IS NULL OR completion_notification_status = 'pending')
  `, [claimToken, claimedAt, claimedAt, goalId, claimToken])
  if (databaseChangeCount(result) !== 1) throw lostConversationGoalEffectsClaimError()
  return claimedAt
}

async function finishConversationGoalNotification(goalId, claimToken, status, errorMessage = '') {
  const finishedAt = new Date().toISOString()
  const result = await db.run(`
    UPDATE conversational_agent_goal_links
    SET completion_notification_status = ?,
        completion_notification_claim_token = NULL,
        completion_notification_sent_at = COALESCE(completion_notification_sent_at, ?),
        completion_notification_last_error = ?,
        completion_effects_updated_at = ?
    WHERE id = ?
      AND completion_effects_status = 'processing'
      AND completion_effects_claim_token = ?
      AND completion_notification_status = 'claimed'
      AND completion_notification_claim_token = ?
  `, [status, finishedAt, errorMessage || null, finishedAt, goalId, claimToken, claimToken])
  if (databaseChangeCount(result) !== 1) throw lostConversationGoalEffectsClaimError()
  return finishedAt
}

async function resetConversationGoalNotificationClaim(goalId, claimToken, errorMessage = '') {
  const updatedAt = new Date().toISOString()
  const result = await db.run(`
    UPDATE conversational_agent_goal_links
    SET completion_notification_status = 'pending',
        completion_notification_claim_token = NULL,
        completion_notification_claimed_at = NULL,
        completion_notification_last_error = ?,
        completion_effects_updated_at = ?
    WHERE id = ?
      AND completion_effects_status = 'processing'
      AND completion_effects_claim_token = ?
      AND completion_notification_status = 'claimed'
      AND completion_notification_claim_token = ?
  `, [errorMessage || null, updatedAt, goalId, claimToken, claimToken])
  if (databaseChangeCount(result) !== 1) throw lostConversationGoalEffectsClaimError()
}

async function finishUnknownConversationGoalNotification(goalId, claimToken, contactId, signal) {
  const finishedAt = new Date().toISOString()
  await recordConversationalAgentEvent({
    eventId: goalEffectEventId(goalId, 'notification_unknown'),
    contactId,
    eventType: 'priority_push_notification_unknown',
    detail: {
      signal,
      reason: 'dispatcher_claim_recovered_without_durable_ack',
      deliveryPolicy: 'at_most_once'
    },
    throwOnError: true
  })
  const result = await db.run(`
    UPDATE conversational_agent_goal_links
    SET completion_notification_status = 'unknown',
        completion_notification_claim_token = NULL,
        completion_notification_sent_at = COALESCE(completion_notification_sent_at, completion_notification_claimed_at, ?),
        completion_notification_last_error = COALESCE(completion_notification_last_error, 'El proceso terminó sin ACK durable; no se reenvió para evitar duplicados'),
        completion_effects_updated_at = ?
    WHERE id = ?
      AND completion_effects_status = 'processing'
      AND completion_effects_claim_token = ?
      AND completion_notification_status IN ('claimed', 'unknown')
  `, [finishedAt, finishedAt, goalId, claimToken])
  if (databaseChangeCount(result) !== 1) throw lostConversationGoalEffectsClaimError()
  return finishedAt
}

async function finalizeConversationGoalCompletionEffects(goalId) {
  const cleanGoalId = String(goalId || '').trim()
  const claimToken = randomUUID()
  const now = new Date()
  const nowIso = now.toISOString()
  const leaseUntil = new Date(now.getTime() + CONVERSATION_GOAL_EFFECTS_LEASE_MS).toISOString()
  const claim = await db.run(`
    UPDATE conversational_agent_goal_links
    SET completion_effects_status = 'processing',
        completion_effects_attempts = COALESCE(completion_effects_attempts, 0) + 1,
        completion_effects_claim_token = ?,
        completion_effects_lease_until_at = ?,
        completion_effects_updated_at = ?,
        completion_effects_last_error = NULL,
        completion_effects_next_retry_at = NULL
    WHERE id = ?
      AND status = 'completed'
      AND (
        completion_effects_status = 'pending' OR
        (completion_effects_status = 'failed' AND (completion_effects_next_retry_at IS NULL OR completion_effects_next_retry_at <= ?)) OR
        (completion_effects_status = 'processing' AND (completion_effects_lease_until_at IS NULL OR completion_effects_lease_until_at <= ?))
      )
  `, [claimToken, leaseUntil, nowIso, cleanGoalId, nowIso, nowIso])

  if (databaseChangeCount(claim) !== 1) {
    const current = await db.get(
      'SELECT completion_effects_status FROM conversational_agent_goal_links WHERE id = ?',
      [cleanGoalId]
    ).catch(() => null)
    return { completed: current?.completion_effects_status === 'completed', pending: current?.completion_effects_status === 'processing' }
  }

  try {
    const row = await db.get('SELECT * FROM conversational_agent_goal_links WHERE id = ?', [cleanGoalId])
    if (!row) throw new Error('No se encontró la meta al finalizar sus efectos')
    const mapped = conversationSignalForGoalObjective(row.objective)
    const storedMetadata = parseJsonField(row.metadata_json, {})
    const receivedReference = storedMetadata.receivedReference || {}
    // La asignación y los extras se fijan cuando se acepta la confirmación.
    // Recovery nunca vuelve a leer la configuración viva del agente: editarlo
    // después no puede cambiar los efectos de una meta ya confirmada.
    const effectAgent = conversationGoalEffectAgentFromMetadata(storedMetadata)
    const technicalSummary = row.external_object_id
      ? `ID de ${mapped.objectLabel}: ${row.external_object_id}`
      : `Confirmación recibida para ${mapped.objectLabel}`
    const conversationSummary = cleanCompletionDisplayText(storedMetadata.resumen || storedMetadata.summary || '')

    if (!row.completion_signal_applied_at) {
      await renewConversationGoalEffectsLease(cleanGoalId, claimToken)
      await setConversationSignal(row.contact_id, mapped.signal, {
        reason: mapped.reason,
        summary: conversationSummary,
        actionSummarySource: technicalSummary,
        originalSummary: technicalSummary,
        status: 'completed',
        agentId: row.agent_id || '',
        eventId: goalEffectEventId(cleanGoalId, 'signal'),
        strictEvent: true
      })
      row.completion_signal_applied_at = await markConversationGoalEffectApplied(
        cleanGoalId,
        claimToken,
        'completion_signal_applied_at'
      )
    }

    if (!row.completion_action_applied_at) {
      await renewConversationGoalEffectsLease(cleanGoalId, claimToken)
      await applyAgentCompletionAction(effectAgent, row.contact_id, {
        eventId: goalEffectEventId(cleanGoalId, 'assignment'),
        strict: true
      })
      row.completion_action_applied_at = await markConversationGoalEffectApplied(
        cleanGoalId,
        claimToken,
        'completion_action_applied_at'
      )
    }

    if (!row.completion_extras_applied_at) {
      await renewConversationGoalEffectsLease(cleanGoalId, claimToken)
      await applyAgentSuccessExtras(effectAgent, row.contact_id, {
        eventId: goalEffectEventId(cleanGoalId, 'extras'),
        strict: true
      })
      row.completion_extras_applied_at = await markConversationGoalEffectApplied(
        cleanGoalId,
        claimToken,
        'completion_extras_applied_at'
      )
    }

    if (!row.completion_notification_sent_at) {
      await renewConversationGoalEffectsLease(cleanGoalId, claimToken)
      const notificationStatus = String(row.completion_notification_status || '').trim()
      if (row.completion_notification_claimed_at || notificationStatus === 'claimed' || notificationStatus === 'unknown') {
        row.completion_notification_sent_at = await finishUnknownConversationGoalNotification(
          cleanGoalId,
          claimToken,
          row.contact_id,
          mapped.signal
        )
      } else {
        row.completion_notification_claimed_at = await claimConversationGoalNotification(cleanGoalId, claimToken)
        try {
          const notificationResult = await notifyConversationalCompletion({
            contactId: row.contact_id,
            reason: mapped.reason,
            summary: conversationSummary || technicalSummary,
            signal: mapped.signal,
            eventId: goalEffectEventId(cleanGoalId, 'notification'),
            throwOnFailure: true
          })
          row.completion_notification_sent_at = await finishConversationGoalNotification(
            cleanGoalId,
            claimToken,
            notificationResult?.skipped ? 'skipped' : 'dispatched'
          )
        } catch (error) {
          if (error?.notificationDeliveryAttempted === false) {
            await resetConversationGoalNotificationClaim(cleanGoalId, claimToken, error.message)
          } else {
            await finishConversationGoalNotification(cleanGoalId, claimToken, 'unknown', error.message)
          }
          throw error
        }
      }
    }

    if (!row.completion_event_recorded_at) {
      await renewConversationGoalEffectsLease(cleanGoalId, claimToken)
      await recordConversationalAgentEvent({
        eventId: goalEffectEventId(cleanGoalId, 'completed'),
        contactId: row.contact_id,
        eventType: 'goal_url_completed',
        detail: {
          goalId: cleanGoalId,
          agentId: row.agent_id || null,
          objective: row.objective,
          signal: mapped.signal,
          externalSource: row.external_source || null,
          externalObjectId: row.external_object_id || null,
          externalStatus: row.external_status || null,
          receivedReference
        },
        throwOnError: true
      })
      row.completion_event_recorded_at = await markConversationGoalEffectApplied(
        cleanGoalId,
        claimToken,
        'completion_event_recorded_at'
      )
    }

    const completedAt = new Date().toISOString()
    const finalized = await db.run(`
      UPDATE conversational_agent_goal_links
      SET completion_effects_status = 'completed',
          completion_effects_claim_token = NULL,
          completion_effects_lease_until_at = NULL,
          completion_effects_next_retry_at = NULL,
          completion_effects_updated_at = ?,
          completion_effects_last_error = NULL
      WHERE id = ?
        AND completion_effects_status = 'processing'
        AND completion_effects_claim_token = ?
    `, [completedAt, cleanGoalId, claimToken])
    if (databaseChangeCount(finalized) !== 1) throw lostConversationGoalEffectsClaimError()
    return { completed: true, pending: false }
  } catch (error) {
    const failedAt = new Date().toISOString()
    const nextRetryAt = new Date(Date.now() + 30_000).toISOString()
    await db.run(`
      UPDATE conversational_agent_goal_links
      SET completion_effects_status = 'failed',
          completion_effects_claim_token = NULL,
          completion_effects_lease_until_at = NULL,
          completion_effects_next_retry_at = ?,
          completion_effects_updated_at = ?,
          completion_effects_last_error = ?
      WHERE id = ?
        AND completion_effects_status = 'processing'
        AND completion_effects_claim_token = ?
    `, [nextRetryAt, failedAt, String(error?.message || error).slice(0, 1000), cleanGoalId, claimToken]).catch(() => undefined)
    throw Object.assign(new Error('La meta se confirmó, pero sus efectos internos quedaron pendientes de reintento'), {
      statusCode: 503,
      retryable: true,
      cause: error
    })
  }
}

export async function recoverPendingConversationGoalCompletionEffects({ limit = 5000, batchSize = 100 } = {}) {
  const cleanLimit = Math.max(1, Math.min(20_000, Number(limit) || 5000))
  const cleanBatchSize = Math.max(1, Math.min(500, Number(batchSize) || 100))
  const recoveryCutoff = new Date().toISOString()
  let scanned = 0
  let completed = 0
  let failed = 0
  while (scanned < cleanLimit) {
    const nowIso = new Date().toISOString()
    const rows = await db.all(`
      SELECT id
      FROM conversational_agent_goal_links
      WHERE status = 'completed'
        AND COALESCE(completion_effects_updated_at, completed_at, updated_at, created_at) <= ?
        AND (
          completion_effects_status = 'pending' OR
          (completion_effects_status = 'failed' AND (completion_effects_next_retry_at IS NULL OR completion_effects_next_retry_at <= ?)) OR
          (completion_effects_status = 'processing' AND (completion_effects_lease_until_at IS NULL OR completion_effects_lease_until_at <= ?))
        )
      ORDER BY COALESCE(completion_effects_updated_at, completed_at, updated_at, created_at) ASC
      LIMIT ?
    `, [recoveryCutoff, nowIso, nowIso, Math.min(cleanBatchSize, cleanLimit - scanned)])
    if (!rows.length) break

    scanned += rows.length
    for (const row of rows) {
      try {
        const result = await finalizeConversationGoalCompletionEffects(row.id)
        if (result.completed) completed += 1
      } catch {
        failed += 1
      }
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { scanned, completed, failed }
}

let conversationGoalEffectsRecoveryTimer = null
let conversationGoalEffectsRecoveryRunning = false

export function startConversationGoalEffectsRecoveryScheduler(intervalMs = 60_000) {
  if (conversationGoalEffectsRecoveryTimer) return conversationGoalEffectsRecoveryTimer
  const cleanInterval = Math.max(15_000, Number(intervalMs) || 60_000)
  conversationGoalEffectsRecoveryTimer = setInterval(() => {
    if (conversationGoalEffectsRecoveryRunning) return
    conversationGoalEffectsRecoveryRunning = true
    recoverPendingConversationGoalCompletionEffects()
      .catch((error) => logger.error(`[Agente conversacional] Falló recovery periódico de metas: ${error.message}`))
      .finally(() => { conversationGoalEffectsRecoveryRunning = false })
  }, cleanInterval)
  conversationGoalEffectsRecoveryTimer.unref?.()
  logger.info(`[Agente conversacional] Recovery de metas activo cada ${Math.round(cleanInterval / 1000)}s`)
  return conversationGoalEffectsRecoveryTimer
}

export async function completeConversationGoalLink(goalId, {
  confirmationToken = '',
  externalSource = '',
  externalObjectId = '',
  externalStatus = '',
  calendarId = '',
  productId = '',
  priceId = '',
  amount = null,
  currency = '',
  metadata = {}
} = {}, authorization = {}) {
  const cleanGoalId = String(goalId || '').trim()
  if (!cleanGoalId) {
    throw Object.assign(new Error('Falta el ID de seguimiento del objetivo'), { statusCode: 400 })
  }

  const row = await db.get('SELECT * FROM conversational_agent_goal_links WHERE id = ?', [cleanGoalId])
  if (!row) {
    throw Object.assign(new Error('No encontramos ese objetivo pendiente'), { statusCode: 404 })
  }

  const approvedAuthorization = authorizeConversationGoalCompletion(row, confirmationToken, authorization)
  const cleanExternalSource = normalizeExternalEvidenceSource(externalSource, row.objective, {
    required: approvedAuthorization.method === 'external_api'
  })
  const cleanExternalObjectId = String(externalObjectId || '').trim()
  if (!cleanExternalObjectId) {
    throw Object.assign(new Error('La confirmación requiere un ID externo real'), { statusCode: 400 })
  }
  if (cleanExternalObjectId.length > 240) {
    throw Object.assign(new Error('externalObjectId excede el máximo de 240 caracteres'), { statusCode: 400 })
  }
  const cleanExternalStatus = assertSuccessfulGoalStatus(row.objective, externalStatus).slice(0, 120)
  const externalEvidenceKey = buildExternalEvidenceKey(cleanExternalSource, cleanExternalObjectId)
  const cleanMetadata = metadata && typeof metadata === 'object' ? metadata : {}
  const previousMetadata = parseJsonField(row.metadata_json, {})
  const expected = previousMetadata.expected && typeof previousMetadata.expected === 'object'
    ? previousMetadata.expected
    : {}
  const receivedReference = normalizeReceivedGoalReference({ calendarId, productId, priceId, amount, currency })
  validateExpectedGoalReference(expected, receivedReference)

  if (row.status === 'completed') {
    if (!completedGoalRequestMatches(row, approvedAuthorization, cleanExternalSource, cleanExternalObjectId, cleanExternalStatus, receivedReference)) {
      throw Object.assign(new Error('Esta meta ya fue confirmada por otra solicitud o con datos distintos'), { statusCode: 409 })
    }
    const effects = await finalizeConversationGoalCompletionEffects(cleanGoalId)
    return {
      ...(await getConversationGoalLink(cleanGoalId)),
      signal: conversationSignalForGoalObjective(row.objective).signal,
      alreadyCompleted: true,
      effectsPending: !effects.completed
    }
  }
  if (row.status !== 'pending') {
    throw Object.assign(new Error('Esta confirmación ya no está disponible'), { statusCode: 409 })
  }

  const completionAgent = row.agent_id ? await getConversationalAgent(row.agent_id) : null
  const completionEffectPlan = await buildConversationGoalCompletionEffectPlan(completionAgent)
  const nextMetadata = {
    ...previousMetadata,
    confirmation: cleanMetadata,
    receivedReference,
    completionEffectPlan
  }
  const confirmationFingerprint = buildConversationGoalConfirmationFingerprint({
    externalSource: cleanExternalSource,
    externalObjectId: cleanExternalObjectId,
    externalStatus: cleanExternalStatus,
    receivedReference
  })

  const completedAt = new Date().toISOString()
  let alreadyCompleted = false
  try {
    alreadyCompleted = await db.transaction(async (tx) => {
      const current = await tx.get('SELECT * FROM conversational_agent_goal_links WHERE id = ?', [cleanGoalId])
      if (!current) {
        throw Object.assign(new Error('No encontramos ese objetivo pendiente'), { statusCode: 404 })
      }
      const currentAuthorization = authorizeConversationGoalCompletion(current, confirmationToken, authorization)
      if (
        currentAuthorization.method !== approvedAuthorization.method ||
        currentAuthorization.actorId !== approvedAuthorization.actorId ||
        currentAuthorization.requestId !== approvedAuthorization.requestId
      ) {
        throw Object.assign(new Error('La autorización de la confirmación cambió antes de completarse'), { statusCode: 409 })
      }
      const currentMetadata = parseJsonField(current.metadata_json, {})
      validateExpectedGoalReference(
        currentMetadata.expected && typeof currentMetadata.expected === 'object' ? currentMetadata.expected : {},
        receivedReference
      )

      const evidenceClaim = await claimConversationGoalEvidence(tx, {
        goalId: cleanGoalId,
        externalEvidenceKey,
        externalSource: cleanExternalSource,
        externalObjectId: cleanExternalObjectId,
        confirmationFingerprint,
        authorization: approvedAuthorization
      })
      if (evidenceClaim.idempotent) {
        // En PostgreSQL el INSERT ... ON CONFLICT puede esperar a que otro
        // callback confirme la misma evidencia. `current` fue leído antes de
        // esa espera; se relee bajo READ COMMITTED para no decidir con un
        // snapshot stale ni devolver 409 a un retry realmente idempotente.
        const claimedCurrent = await tx.get('SELECT * FROM conversational_agent_goal_links WHERE id = ?', [cleanGoalId])
        if (claimedCurrent?.status === 'completed' && completedGoalRequestMatches(
          claimedCurrent,
          approvedAuthorization,
          cleanExternalSource,
          cleanExternalObjectId,
          cleanExternalStatus,
          receivedReference
        )) {
          return true
        }
        throw Object.assign(new Error('La evidencia ya quedó reclamada y la meta no está en un estado idempotente válido'), { statusCode: 409 })
      }

      const update = await tx.run(`
        UPDATE conversational_agent_goal_links
        SET status = 'completed',
          external_source = ?,
          external_evidence_key = ?,
          external_object_id = ?,
          external_status = ?,
          metadata_json = ?,
          confirmation_used_at = ?,
          completion_auth_method = ?,
          completion_actor_id = ?,
          completion_request_id = ?,
          completion_effects_status = 'pending',
          completion_effects_attempts = 0,
          completion_effects_last_error = NULL,
          completion_effects_next_retry_at = NULL,
          completion_effects_updated_at = ?,
          completion_effects_claim_token = NULL,
          completion_effects_lease_until_at = NULL,
          completion_signal_applied_at = NULL,
          completion_action_applied_at = NULL,
          completion_extras_applied_at = NULL,
          completion_notification_claimed_at = NULL,
          completion_notification_sent_at = NULL,
          completion_notification_status = 'pending',
          completion_notification_claim_token = NULL,
          completion_notification_last_error = NULL,
          completion_event_recorded_at = NULL,
          completed_at = ?,
          updated_at = ?
        WHERE id = ?
          AND status = 'pending'
      `, [
        cleanExternalSource,
        externalEvidenceKey,
        cleanExternalObjectId,
        cleanExternalStatus,
        JSON.stringify(nextMetadata),
        approvedAuthorization.method === 'legacy_token' ? completedAt : null,
        approvedAuthorization.method,
        approvedAuthorization.actorId || null,
        approvedAuthorization.requestId,
        completedAt,
        completedAt,
        completedAt,
        cleanGoalId
      ])
      if (databaseChangeCount(update) === 1) return false

      const latest = await tx.get('SELECT * FROM conversational_agent_goal_links WHERE id = ?', [cleanGoalId])
      if (!latest || latest.status !== 'completed' || !completedGoalRequestMatches(
        latest,
        approvedAuthorization,
        cleanExternalSource,
        cleanExternalObjectId,
        cleanExternalStatus,
        receivedReference
      )) {
        throw Object.assign(new Error('Esta confirmación ya no está disponible'), { statusCode: 409 })
      }
      return true
    })
  } catch (error) {
    if (/unique|duplicate/i.test(String(error?.message || ''))) {
      throw Object.assign(new Error('Ese Idempotency-Key ya fue usado para confirmar otra meta'), { statusCode: 409 })
    }
    throw error
  }
  const effects = await finalizeConversationGoalCompletionEffects(cleanGoalId)
  return {
    ...(await getConversationGoalLink(cleanGoalId)),
    signal: conversationSignalForGoalObjective(row.objective).signal,
    alreadyCompleted,
    effectsPending: !effects.completed
  }
}

function extractPayloadValue(payload, keys, seen = new Set()) {
  if (!payload || typeof payload !== 'object' || seen.has(payload)) return ''
  seen.add(payload)

  for (const key of keys) {
    const value = payload[key]
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim()
  }

  for (const value of Object.values(payload)) {
    if (!value || typeof value !== 'object') continue
    const nested = extractPayloadValue(value, keys, seen)
    if (nested) return nested
  }

  return ''
}

function extractGoalIdValue(payload, seen = new Set()) {
  if (payload === null || payload === undefined) return ''
  if (typeof payload !== 'object') {
    const value = String(payload || '').trim()
    return /^goal_[a-f0-9-]{12,}$/i.test(value) ? value : ''
  }
  if (seen.has(payload)) return ''
  seen.add(payload)

  for (const value of Object.values(payload)) {
    const nested = extractGoalIdValue(value, seen)
    if (nested) return nested
  }
  return ''
}

const GOAL_ID_WEBHOOK_KEYS = [
  DEFAULT_GOAL_TRACKING_PARAM,
  'goalId',
  'goal_id',
  'trackingId',
  'tracking_id',
  'ristakGoalId',
  'ristak_goal_id'
]

const EXTERNAL_OBJECT_WEBHOOK_KEYS = [
  'objectId',
  'object_id',
  'externalObjectId',
  'external_object_id',
  'appointmentId',
  'appointment_id',
  'bookingId',
  'booking_id',
  'purchaseId',
  'purchase_id',
  'paymentId',
  'payment_id',
  'orderId',
  'order_id',
  'invoiceId',
  'invoice_id'
]

const EXTERNAL_STATUS_WEBHOOK_KEYS = ['status', 'state', 'eventStatus', 'event_status', 'paymentStatus', 'payment_status']
const EXTERNAL_SOURCE_WEBHOOK_KEYS = ['externalSource', 'external_source', 'source', 'provider', 'integration']

const CALENDAR_WEBHOOK_KEYS = ['calendarId', 'calendar_id', 'calendar', 'calendarRef', 'calendar_ref']
const PRODUCT_WEBHOOK_KEYS = ['productId', 'product_id', 'product', 'productRef', 'product_ref', 'itemId', 'item_id', 'sku']
const PRICE_WEBHOOK_KEYS = ['priceId', 'price_id', 'priceRef', 'price_ref', 'variantId', 'variant_id']
const AMOUNT_WEBHOOK_KEYS = ['amount', 'total', 'paidAmount', 'paid_amount', 'amountPaid', 'amount_paid', 'priceAmount', 'price_amount']
const CURRENCY_WEBHOOK_KEYS = ['currency', 'currencyCode', 'currency_code']
const GOAL_TOKEN_WEBHOOK_KEYS = [
  CONVERSATIONAL_GOAL_TOKEN_QUERY_PARAM,
  'confirmationToken',
  'confirmation_token',
  'goalToken',
  'goal_token',
  'token'
]
const GOAL_TOKEN_WEBHOOK_KEY_SET = new Set(GOAL_TOKEN_WEBHOOK_KEYS.map((key) => key.toLowerCase()))

function extractTopLevelGoalWebhookValue(payload, keys) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
  for (const key of keys) {
    const value = payload[key]
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim()
  }
  return ''
}

function extractCanonicalExternalGoalValue(payload, canonicalKey, aliases = []) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
  const canonical = payload[canonicalKey]
  const cleanCanonical = canonical === undefined || canonical === null ? '' : String(canonical).trim()
  for (const alias of aliases) {
    const candidate = payload[alias]
    const cleanCandidate = candidate === undefined || candidate === null ? '' : String(candidate).trim()
    if (cleanCandidate && cleanCandidate !== cleanCanonical) {
      throw Object.assign(
        new Error(`El body trae valores conflictivos para ${canonicalKey}; usa únicamente el campo canónico ${canonicalKey}`),
        { statusCode: 400 }
      )
    }
  }
  return cleanCanonical
}

function extractStrictExternalGoalPayload(payload) {
  return {
    externalSource: extractCanonicalExternalGoalValue(payload, 'externalSource', EXTERNAL_SOURCE_WEBHOOK_KEYS.filter((key) => key !== 'externalSource')),
    externalObjectId: extractCanonicalExternalGoalValue(payload, 'externalObjectId', EXTERNAL_OBJECT_WEBHOOK_KEYS.filter((key) => key !== 'externalObjectId')),
    externalStatus: extractCanonicalExternalGoalValue(payload, 'status', EXTERNAL_STATUS_WEBHOOK_KEYS.filter((key) => key !== 'status')),
    calendarId: extractCanonicalExternalGoalValue(payload, 'calendarId', CALENDAR_WEBHOOK_KEYS.filter((key) => key !== 'calendarId')),
    productId: extractCanonicalExternalGoalValue(payload, 'productId', PRODUCT_WEBHOOK_KEYS.filter((key) => key !== 'productId')),
    priceId: extractCanonicalExternalGoalValue(payload, 'priceId', PRICE_WEBHOOK_KEYS.filter((key) => key !== 'priceId')),
    amount: extractCanonicalExternalGoalValue(payload, 'amount', AMOUNT_WEBHOOK_KEYS.filter((key) => key !== 'amount')),
    currency: extractCanonicalExternalGoalValue(payload, 'currency', CURRENCY_WEBHOOK_KEYS.filter((key) => key !== 'currency'))
  }
}

function sanitizeGoalWebhookMetadata(value, seen = new Set(), depth = 0) {
  if (value === null || value === undefined) return value
  if (depth > 12) return null
  if (Array.isArray(value)) {
    if (seen.has(value)) return null
    seen.add(value)
    const clean = value.map((entry) => sanitizeGoalWebhookMetadata(entry, seen, depth + 1))
    seen.delete(value)
    return clean
  }
  if (typeof value !== 'object') return value
  if (seen.has(value)) return null

  seen.add(value)
  const clean = {}
  for (const [key, entry] of Object.entries(value)) {
    if (GOAL_TOKEN_WEBHOOK_KEY_SET.has(String(key).toLowerCase())) continue
    clean[key] = sanitizeGoalWebhookMetadata(entry, seen, depth + 1)
  }
  seen.delete(value)
  return clean
}

export async function completeConversationGoalLinkFromWebhook(payload = {}, { confirmationToken = '', authorization = {} } = {}) {
  const source = payload && typeof payload === 'object' ? payload : {}
  const strictExternalPayload = String(authorization?.type || '').trim() === 'external_api'
  const goalId = strictExternalPayload
    ? extractTopLevelGoalWebhookValue(source, ['goalId'])
    : (extractPayloadValue(source, GOAL_ID_WEBHOOK_KEYS) || extractGoalIdValue(source))
  if (!goalId) {
    throw Object.assign(new Error(`Falta ${DEFAULT_GOAL_TRACKING_PARAM} en la confirmación automática`), { statusCode: 400 })
  }

  const extracted = strictExternalPayload
    ? extractStrictExternalGoalPayload(source)
    : {
        externalSource: extractTopLevelGoalWebhookValue(source, EXTERNAL_SOURCE_WEBHOOK_KEYS),
        externalObjectId: extractPayloadValue(source, EXTERNAL_OBJECT_WEBHOOK_KEYS),
        externalStatus: extractPayloadValue(source, EXTERNAL_STATUS_WEBHOOK_KEYS),
        calendarId: extractPayloadValue(source, CALENDAR_WEBHOOK_KEYS),
        productId: extractPayloadValue(source, PRODUCT_WEBHOOK_KEYS),
        priceId: extractPayloadValue(source, PRICE_WEBHOOK_KEYS),
        amount: extractPayloadValue(source, AMOUNT_WEBHOOK_KEYS),
        currency: extractPayloadValue(source, CURRENCY_WEBHOOK_KEYS)
      }

  return completeConversationGoalLink(goalId, {
    confirmationToken: String(confirmationToken || '').trim(),
    ...extracted,
    metadata: sanitizeGoalWebhookMetadata(source)
  }, authorization)
}

export async function completeConversationalAgentSalePaymentFromInvoice({
  contactId = '',
  invoiceId = '',
  paymentId = '',
  amount = null,
  currency = '',
  status = '',
  reference = ''
} = {}) {
  const cleanContactId = String(contactId || '').trim()
  const invoiceCandidates = [...new Set([
    String(invoiceId || '').trim(),
    String(paymentId || '').trim()
  ].filter(Boolean))]

  if (!cleanContactId || !invoiceCandidates.length) {
    return { matched: false, reason: 'missing_contact_or_invoice' }
  }

  const rows = await db.all(
    `SELECT contact_id, detail_json
     FROM conversational_agent_events
     WHERE contact_id = ? AND event_type = 'payment_link_created'
     ORDER BY created_at DESC
     LIMIT 80`,
    [cleanContactId]
  )

  let matchedDetail = null
  for (const row of rows) {
    const detail = parseJsonField(row.detail_json, {})
    const storedInvoiceId = String(detail.invoiceId || detail.invoice_id || '').trim()
    if (storedInvoiceId && invoiceCandidates.includes(storedInvoiceId)) {
      matchedDetail = detail
      break
    }
  }

  if (!matchedDetail) return { matched: false, reason: 'invoice_not_created_by_conversational_agent' }

  const matchedAgentId = String(matchedDetail.agentId || matchedDetail.agent_id || '').trim()
  const state = matchedAgentId
    ? await getConversationState(cleanContactId, { agentId: matchedAgentId })
    : await getConversationState(cleanContactId)
  const agentId = matchedAgentId || state?.agentId || null
  const agent = agentId ? await getConversationalAgent(agentId).catch(() => null) : null
  const cleanCurrency = String(currency || matchedDetail.currency || '').trim().toUpperCase()
  const paidAmount = Number(amount ?? matchedDetail.amount)
  const cleanInvoiceId = invoiceCandidates[0]
  const technicalSummary = Number.isFinite(paidAmount) && paidAmount > 0
    ? `Invoice ${cleanInvoiceId} · ${paidAmount} ${cleanCurrency || ''}`.trim()
    : `Invoice ${cleanInvoiceId}`
  const conversationSummary = cleanCompletionDisplayText(matchedDetail.resumen || matchedDetail.summary || '')
  const reason = 'Pago confirmado del link enviado por el agente'

  await setConversationSignal(cleanContactId, 'purchase_completed', {
    reason,
    summary: conversationSummary,
    actionSummarySource: technicalSummary,
    originalSummary: technicalSummary,
    status: 'completed',
    agentId: agentId || ''
  })

  if (agent) {
    await applyAgentCompletionAction(agent, cleanContactId)
    await applyAgentSuccessExtras(agent, cleanContactId)
  }

  await notifyConversationalCompletion({
    contactId: cleanContactId,
    reason,
    summary: conversationSummary || technicalSummary,
    signal: 'purchase_completed'
  })

  await recordConversationalAgentEvent({
    contactId: cleanContactId,
    eventType: 'payment_link_goal_completed',
    detail: {
      agentId: agent?.id || agentId || null,
      invoiceId: cleanInvoiceId,
      paymentId: paymentId || null,
      amount: Number.isFinite(paidAmount) ? paidAmount : null,
      currency: cleanCurrency || null,
      status: status || null,
      reference: reference || null
    }
  })

  return {
    matched: true,
    signal: 'purchase_completed',
    agentId: agent?.id || agentId || null,
    invoiceId: cleanInvoiceId
  }
}

function clampDelayValue(value, unit, fallback) {
  const max = unit === 'minutes' ? 60 : MAX_RESPONSE_DELAY_SECONDS
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(Math.max(Math.round(numeric), 0), max)
}

function delayToSeconds(value, unit) {
  return unit === 'minutes' ? value * 60 : value
}

export function normalizeAgentResponseDelay(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const mode = RESPONSE_DELAY_MODES.has(raw.mode) ? raw.mode : DEFAULT_RESPONSE_DELAY_CONFIG.mode
  const fixedUnit = RESPONSE_DELAY_UNITS.has(raw.fixedUnit) ? raw.fixedUnit : DEFAULT_RESPONSE_DELAY_CONFIG.fixedUnit
  const rangeUnit = RESPONSE_DELAY_UNITS.has(raw.rangeUnit) ? raw.rangeUnit : DEFAULT_RESPONSE_DELAY_CONFIG.rangeUnit
  let minValue = clampDelayValue(raw.minValue, rangeUnit, DEFAULT_RESPONSE_DELAY_CONFIG.minValue)
  let maxValue = clampDelayValue(raw.maxValue, rangeUnit, DEFAULT_RESPONSE_DELAY_CONFIG.maxValue)

  if (minValue > maxValue) {
    const swap = minValue
    minValue = maxValue
    maxValue = swap
  }

  return {
    mode,
    fixedValue: clampDelayValue(raw.fixedValue, fixedUnit, DEFAULT_RESPONSE_DELAY_CONFIG.fixedValue),
    fixedUnit,
    minValue,
    maxValue,
    rangeUnit
  }
}

export function getAgentResponseDelayMs(agentConfig = {}) {
  const delay = normalizeAgentResponseDelay(agentConfig.responseDelay)
  if (delay.mode === 'fixed') {
    return Math.min(delayToSeconds(delay.fixedValue, delay.fixedUnit), MAX_RESPONSE_DELAY_SECONDS) * 1000
  }
  if (delay.mode === 'random') {
    const minSeconds = Math.min(delayToSeconds(delay.minValue, delay.rangeUnit), MAX_RESPONSE_DELAY_SECONDS)
    const maxSeconds = Math.min(delayToSeconds(delay.maxValue, delay.rangeUnit), MAX_RESPONSE_DELAY_SECONDS)
    const min = Math.min(minSeconds, maxSeconds)
    const max = Math.max(minSeconds, maxSeconds)
    return Math.round((min + Math.random() * (max - min)) * 1000)
  }
  return 0
}

function clampInteger(value, min, max, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(Math.max(Math.round(numeric), min), max)
}

export function normalizeAgentReplyDelivery(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const requestedMode = REPLY_DELIVERY_MODES.has(raw.mode) ? raw.mode : DEFAULT_REPLY_DELIVERY_CONFIG.mode
  const splitMessagesEnabled = raw.splitMessagesEnabled === undefined
    ? requestedMode === 'split'
    : toBoolean(raw.splitMessagesEnabled)
  const mode = splitMessagesEnabled ? 'split' : 'single'
  const maxBubbleLength = clampInteger(
    raw.maxBubbleLength === undefined ? raw.targetChars : raw.maxBubbleLength,
    80,
    1000,
    DEFAULT_REPLY_DELIVERY_CONFIG.maxBubbleLength
  )
  const minBubbleLength = clampInteger(
    raw.minBubbleLength,
    1,
    Math.min(200, maxBubbleLength),
    DEFAULT_REPLY_DELIVERY_CONFIG.minBubbleLength
  )
  let minDelaySeconds = clampInteger(raw.minDelaySeconds, 0, 60, DEFAULT_REPLY_DELIVERY_CONFIG.minDelaySeconds)
  let maxDelaySeconds = clampInteger(raw.maxDelaySeconds, 0, 60, DEFAULT_REPLY_DELIVERY_CONFIG.maxDelaySeconds)

  if (minDelaySeconds > maxDelaySeconds) {
    const swap = minDelaySeconds
    minDelaySeconds = maxDelaySeconds
    maxDelaySeconds = swap
  }

  return {
    mode,
    splitMessagesEnabled,
    minMessageLengthToSplit: clampInteger(
      raw.minMessageLengthToSplit,
      0,
      2000,
      DEFAULT_REPLY_DELIVERY_CONFIG.minMessageLengthToSplit
    ),
    maxBubbles: clampInteger(raw.maxBubbles, 1, 10, DEFAULT_REPLY_DELIVERY_CONFIG.maxBubbles),
    minBubbleLength,
    maxBubbleLength,
    targetChars: clampInteger(raw.targetChars === undefined ? maxBubbleLength : raw.targetChars, 80, 1000, maxBubbleLength),
    randomizeSplitting: raw.randomizeSplitting === undefined
      ? DEFAULT_REPLY_DELIVERY_CONFIG.randomizeSplitting
      : toBoolean(raw.randomizeSplitting),
    delayBetweenBubblesEnabled: raw.delayBetweenBubblesEnabled === undefined
      ? DEFAULT_REPLY_DELIVERY_CONFIG.delayBetweenBubblesEnabled
      : toBoolean(raw.delayBetweenBubblesEnabled),
    minDelaySeconds,
    maxDelaySeconds
  }
}

function followUpDelayMinutes(step = {}) {
  const unit = FOLLOW_UP_UNITS.has(step.unit) ? step.unit : 'minutes'
  const value = Math.max(1, Number(step.value) || 1)
  return unit === 'hours' ? value * 60 : value
}

function normalizeFollowUpStep(input, fallback) {
  const raw = input && typeof input === 'object' ? input : {}
  const unit = FOLLOW_UP_UNITS.has(raw.unit) ? raw.unit : fallback.unit
  const maxValue = unit === 'hours' ? 23 : MAX_FOLLOW_UP_DELAY_MINUTES
  const value = clampInteger(raw.value, 1, maxValue, fallback.value)
  return {
    enabled: raw.enabled === undefined ? Boolean(fallback.enabled) : toBoolean(raw.enabled),
    value,
    unit
  }
}

export function normalizeAgentFollowUp(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const enabled = raw.enabled === undefined ? DEFAULT_FOLLOW_UP_CONFIG.enabled : toBoolean(raw.enabled)
  const first = normalizeFollowUpStep(raw.first, DEFAULT_FOLLOW_UP_CONFIG.first)
  const second = normalizeFollowUpStep(raw.second, DEFAULT_FOLLOW_UP_CONFIG.second)
  const strategy = String(raw.strategy === undefined ? DEFAULT_FOLLOW_UP_CONFIG.strategy : raw.strategy || '')
    .trim()
    .slice(0, 5000)

  return {
    enabled,
    first: {
      ...first,
      enabled: true
    },
    second: {
      ...second,
      enabled: enabled && toBoolean(second.enabled)
    },
    strategy: strategy || DEFAULT_FOLLOW_UP_CONFIG.strategy
  }
}

export function getAgentFollowUpSteps(agentConfig = {}) {
  const followUp = normalizeAgentFollowUp(agentConfig.followUp)
  if (!followUp.enabled) return []
  const steps = [followUp.first]
  if (followUp.second.enabled) steps.push(followUp.second)
  return steps
}

export function getAgentFollowUpStepDelayMs(step = {}) {
  return Math.min(followUpDelayMinutes(step), MAX_FOLLOW_UP_DELAY_MINUTES) * 60 * 1000
}

function buildAgentConfigError(message, code = 'CONVERSATIONAL_AGENT_INVALID_CONFIG') {
  return Object.assign(new Error(message), { statusCode: 400, code })
}

function assertDelayRange(minValue, maxValue, message) {
  const min = Number(minValue)
  const max = Number(maxValue)
  if (Number.isFinite(min) && Number.isFinite(max) && min > max) {
    throw buildAgentConfigError(message)
  }
}

function readFollowUpDelayMinutes(rawStep = {}, fallback = {}) {
  const unit = FOLLOW_UP_UNITS.has(rawStep.unit) ? rawStep.unit : fallback.unit || 'minutes'
  const value = Number(rawStep.value === undefined ? fallback.value : rawStep.value)
  if (!Number.isFinite(value)) return followUpDelayMinutes(fallback)
  return value * (unit === 'hours' ? 60 : 1)
}

function assertAgentTimingInput(input = {}) {
  if (input.responseDelay !== undefined) {
    const raw = input.responseDelay && typeof input.responseDelay === 'object' ? input.responseDelay : {}
    if (raw.mode === 'random') {
      assertDelayRange(raw.minValue, raw.maxValue, 'Revisa el rango de espera.')
    }
  }

  if (input.replyDelivery !== undefined) {
    const raw = input.replyDelivery && typeof input.replyDelivery === 'object' ? input.replyDelivery : {}
    const splitEnabled = raw.splitMessagesEnabled === undefined ? raw.mode === 'split' : toBoolean(raw.splitMessagesEnabled)
    if (splitEnabled) {
      assertDelayRange(raw.minDelaySeconds, raw.maxDelaySeconds, 'Revisa el rango de pausa entre globos.')
    }
  }

  if (input.followUp !== undefined) {
    const raw = input.followUp && typeof input.followUp === 'object' ? input.followUp : {}
    const followUp = normalizeAgentFollowUp(raw)
    if (!followUp.enabled) return
    const rawFirstDelay = readFollowUpDelayMinutes(raw.first || {}, DEFAULT_FOLLOW_UP_CONFIG.first)
    if (rawFirstDelay > MAX_FOLLOW_UP_DELAY_MINUTES) {
      throw buildAgentConfigError('El seguimiento no puede pasar de 23 horas.')
    }
    const firstDelay = followUpDelayMinutes(followUp.first)
    if (followUp.second.enabled) {
      const rawSecondDelay = readFollowUpDelayMinutes(raw.second || {}, DEFAULT_FOLLOW_UP_CONFIG.second)
      if (rawSecondDelay > MAX_FOLLOW_UP_DELAY_MINUTES) {
        throw buildAgentConfigError('El segundo seguimiento no puede pasar de 23 horas.')
      }
      const secondDelay = followUpDelayMinutes(followUp.second)
      if (secondDelay <= firstDelay) {
        throw buildAgentConfigError('Revisa el orden de los seguimientos.')
      }
    }
    if (!String(input.followUp?.strategy || '').trim()) {
      throw buildAgentConfigError('Falta la estrategia de seguimiento.')
    }
  }
}

function normalizeAgentReplyDeliveryForConfig(input) {
  const delivery = normalizeAgentReplyDelivery(input)
  return {
    ...delivery,
    minMessageLengthToSplit: DEFAULT_REPLY_DELIVERY_CONFIG.minMessageLengthToSplit,
    maxBubbles: DEFAULT_REPLY_DELIVERY_CONFIG.maxBubbles,
    minBubbleLength: DEFAULT_REPLY_DELIVERY_CONFIG.minBubbleLength,
    maxBubbleLength: DEFAULT_REPLY_DELIVERY_CONFIG.maxBubbleLength,
    targetChars: DEFAULT_REPLY_DELIVERY_CONFIG.targetChars,
    randomizeSplitting: true,
    delayBetweenBubblesEnabled: true
  }
}

export function getAgentReplyDeliveryPartDelayMs(agentConfig = {}) {
  const delivery = normalizeAgentReplyDelivery(agentConfig.replyDelivery)
  if (delivery.mode !== 'split' || !delivery.delayBetweenBubblesEnabled) return 0
  const minMs = delivery.minDelaySeconds * 1000
  const maxMs = delivery.maxDelaySeconds * 1000
  if (maxMs <= minMs) return minMs
  return Math.round(minMs + Math.random() * (maxMs - minMs))
}

function mapAgentRow(row) {
  if (!row) return null
  const aiProvider = normalizeConversationalAIProvider(row.ai_provider)
  const identity = normalizeAgentIdentity({
    identityMode: row.identity_mode,
    identityUserId: row.identity_user_id,
    identityUserName: row.identity_user_name,
    identityCustomName: row.identity_custom_name
  }, DEFAULT_AGENT_BASE)
  const legacyHideAttended = toBoolean(row.hide_attended)
  const hideAttendedNotifications = row.hide_attended_notifications === null || row.hide_attended_notifications === undefined
    ? legacyHideAttended
    : (toBoolean(row.hide_attended_notifications) || legacyHideAttended)
  return {
    id: row.id,
    name: row.name || 'Agente',
    enabled: toBoolean(row.enabled),
    aiProvider,
    model: normalizeConversationalAgentModel(row.model, aiProvider),
    ...identity,
    position: Number(row.position) || 0,
    objective: VALID_OBJECTIVES.has(row.objective) ? row.objective : 'citas',
    customObjective: row.custom_objective || '',
    successAction: VALID_SUCCESS_ACTIONS.has(row.success_action) ? row.success_action : DEFAULT_SUCCESS_ACTION,
    successExtras: normalizeSuccessExtras(parseJsonField(row.success_extras, [])),
    requiredData: row.required_data || '',
    handoffRules: row.handoff_rules || '',
    extraInstructions: row.extra_instructions || '',
    allowEmojis: toBoolean(row.allow_emojis),
    hideAttended: false,
    hideAttendedNotifications,
    defaultCalendarId: row.default_calendar_id || null,
    closingStrategyMode: 'system',
    closingStrategyCustom: '',
    persuasionLevel: normalizeConversationalPersuasionLevel(row.persuasion_level),
    languageLevel: normalizeConversationalLanguageLevel(row.language_level),
    contactScope: normalizeContactScope(row.contact_scope),
    contactScopeCutoffAt: row.contact_scope_cutoff_at || null,
    responseDelay: normalizeAgentResponseDelay(parseJsonField(row.response_delay_config, null)),
    replyDelivery: normalizeAgentReplyDeliveryForConfig(parseJsonField(row.reply_delivery_config, null)),
    followUp: normalizeAgentFollowUp(parseJsonField(row.follow_up_config, null)),
    goalWorkflow: normalizeAgentGoalWorkflow(parseJsonField(row.goal_workflow_config, null)),
    filters: normalizeAgentFilters(parseJsonField(row.entry_filters, null)),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

function hasText(value) {
  return String(value || '').trim().length > 0
}

export function shouldMigrateLegacyConversationalAgentConfig(legacy) {
  if (!legacy) return false

  return (
    (VALID_OBJECTIVES.has(legacy.objective) && legacy.objective !== 'citas') ||
    hasText(legacy.custom_objective) ||
    (VALID_SUCCESS_ACTIONS.has(legacy.success_action) && legacy.success_action !== DEFAULT_SUCCESS_ACTION) ||
    hasText(legacy.required_data) ||
    hasText(legacy.handoff_rules) ||
    hasText(legacy.extra_instructions) ||
    toBoolean(legacy.allow_emojis) ||
    toBoolean(legacy.hide_attended) ||
    toBoolean(legacy.hide_attended_notifications) ||
    hasText(legacy.default_calendar_id) ||
    legacy.closing_strategy_mode === 'custom' ||
    hasText(legacy.closing_strategy_custom)
  )
}

/**
 * Si todavía no hay agentes pero la config legacy vieja (de un solo agente)
 * tiene reglas reales, crea el "Agente principal" a partir de ella.
 * La config default vacía no se migra, así una cuenta nueva empieza sin agentes.
 */
async function backfillLegacyConversationStatesToPrimaryAgent({ includeHistoricalStates = false } = {}) {
  // Excluye agentes 'new_only': no deben adoptar conversaciones legacy de contactos viejos
  // (eso saltaría el corte de seguridad, porque la adopción ocurre antes de matchAgentForMessage).
  const primaryAgent = await db.get(`
    SELECT id, created_at FROM conversational_agents
    WHERE COALESCE(contact_scope, 'all') <> 'new_only'
    ORDER BY position ASC, created_at ASC LIMIT 1
  `).catch(() => null)
  if (!primaryAgent?.id) return
  await db.run(`
    UPDATE conversational_agent_state
    SET agent_id = ?,
        assignment_source = COALESCE(NULLIF(assignment_source, ''), 'legacy'),
        assigned_at = COALESCE(assigned_at, activated_at, created_at, updated_at, CURRENT_TIMESTAMP),
        assigned_by = COALESCE(assigned_by, updated_by, 'migration'),
        activated_at = COALESCE(activated_at, created_at, updated_at, CURRENT_TIMESTAMP),
        activation_source = COALESCE(activation_source, 'automatic'),
        activated_by = COALESCE(activated_by, updated_by, 'system'),
        updated_at = CURRENT_TIMESTAMP
    WHERE (agent_id IS NULL OR agent_id = '')
      AND (assignment_source IS NULL OR assignment_source = '' OR assignment_source = 'legacy')
      AND COALESCE(activation_source, '') <> 'manual'
      AND COALESCE(updated_by, '') NOT IN ('user', 'human', 'manual')
      AND (
        signal IS NOT NULL
        OR last_reply_at IS NOT NULL
        OR last_answered_inbound_message_id IS NOT NULL
        OR status IN ('paused', 'skipped', 'human', 'completed', 'discarded')
      )
      AND (
        ? = 1
        OR (
          created_at IS NOT NULL
          AND ? IS NOT NULL
          AND created_at >= ?
        )
      )
  `, [
    primaryAgent.id,
    includeHistoricalStates ? 1 : 0,
    primaryAgent.created_at || null,
    primaryAgent.created_at || null
  ]).catch(() => undefined)
}

export async function ensureAgentsMigration() {
  const existing = await db.get('SELECT COUNT(*) AS total FROM conversational_agents')
  if (Number(existing?.total) > 0) {
    await backfillLegacyConversationStatesToPrimaryAgent()
    return
  }
  const legacy = await db.get('SELECT * FROM conversational_agent_config WHERE id = 1')
  if (!legacy) return
  if (!shouldMigrateLegacyConversationalAgentConfig(legacy)) return
  await db.run(`
    INSERT INTO conversational_agents (
      id, name, enabled, ai_provider, model, identity_mode, identity_user_id, identity_user_name, identity_custom_name,
      position, objective, custom_objective, success_action,
      success_extras, required_data, handoff_rules, extra_instructions,
      allow_emojis, hide_attended, hide_attended_notifications,
      default_calendar_id, closing_strategy_mode, closing_strategy_custom,
      response_delay_config, reply_delivery_config, follow_up_config, goal_workflow_config, entry_filters
    ) VALUES (?, ?, 1, ?, ?, 'business', '', '', '', 0, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    `cagent_${randomUUID()}`,
    'Agente principal',
    normalizeConversationalAIProvider(legacy.ai_provider),
    normalizeConversationalAgentModel(legacy.model, legacy.ai_provider),
    VALID_OBJECTIVES.has(legacy.objective) ? legacy.objective : 'citas',
    legacy.custom_objective || '',
    DEFAULT_SUCCESS_ACTION,
    legacy.required_data || '',
    legacy.handoff_rules || '',
    legacy.extra_instructions || '',
    toBoolean(legacy.allow_emojis) ? 1 : 0,
    0,
    legacy.hide_attended_notifications === null || legacy.hide_attended_notifications === undefined
      ? (toBoolean(legacy.hide_attended) ? 1 : 0)
      : ((toBoolean(legacy.hide_attended_notifications) || toBoolean(legacy.hide_attended)) ? 1 : 0),
    legacy.default_calendar_id || null,
    legacy.closing_strategy_mode === 'custom' ? 'custom' : 'system',
    legacy.closing_strategy_custom || '',
    JSON.stringify(DEFAULT_RESPONSE_DELAY_CONFIG),
    JSON.stringify(DEFAULT_REPLY_DELIVERY_CONFIG),
    JSON.stringify(DEFAULT_FOLLOW_UP_CONFIG),
    JSON.stringify(DEFAULT_GOAL_WORKFLOW_CONFIG),
    JSON.stringify({ entry: [], exit: [] })
  ])
  logger.info('[Agente conversacional] Config previa migrada al contenedor "Agente principal"')
  await backfillLegacyConversationStatesToPrimaryAgent({ includeHistoricalStates: true })
}

export async function listConversationalAgents() {
  await ensureAgentsMigration()
  const rows = await db.all('SELECT * FROM conversational_agents ORDER BY position ASC, created_at ASC')
  return rows.map(mapAgentRow)
}

async function enableConversationalAgentRuntime({ reason = 'agent_published', agentId = null } = {}) {
  const config = await getConversationalAgentConfig()
  if (config.enabled) return config

  const next = await saveConversationalAgentConfig({ enabled: true })
  await recordConversationalAgentEvent({
    contactId: null,
    eventType: 'runtime_enabled',
    detail: { reason, agentId }
  }).catch(() => {})
  return next
}

export async function ensureConversationalAgentRuntimeEnabledForPublishedAgents({ reason = 'published_agent_present' } = {}) {
  // El runtime base es solo compatibilidad interna: la verdad operativa es que
  // exista al menos un agente individual publicado.
  await ensureAgentsMigration()
  const config = await getConversationalAgentConfig()
  if (config.enabled) return config

  const publishedAgent = await db.get('SELECT id FROM conversational_agents WHERE enabled = 1 LIMIT 1')
  if (!publishedAgent?.id) return config

  return enableConversationalAgentRuntime({ reason, agentId: publishedAgent.id })
}

function toMetricNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function stateLastActivity(row) {
  return row?.updated_at || row?.last_reply_at || row?.signal_at || null
}

function isCompletedAgentState(row) {
  // Una señal de handoff puede ser ready_for_human con status=human; eso es una
  // transferencia, no una meta cumplida. El estado explícito es la fuente de verdad.
  return row?.status === 'completed'
}

function isDiscardedAgentState(row) {
  return row?.status === 'discarded' || row?.signal === 'discarded'
}

function buildEmptyAgentMetric(agent) {
  return {
    agentId: agent.id,
    name: agent.name,
    enabled: Boolean(agent.enabled),
    aiProvider: agent.aiProvider || DEFAULT_CONVERSATIONAL_AI_PROVIDER,
    model: agent.model,
    assignedConversations: 0,
    completedConversations: 0,
    pausedConversations: 0,
    humanTakeovers: 0,
    skippedConversations: 0,
    discardedConversations: 0,
    totalConversations: 0,
    lastActivityAt: null
  }
}

export function buildConversationalAgentMetrics({ agents = [], stateRows = [], eventSummary = {} } = {}) {
  const metricsByAgent = new Map(agents.map((agent) => [agent.id, buildEmptyAgentMetric(agent)]))
  const assignedAgentIds = new Set()
  const totals = {
    totalAgents: agents.length,
    activeAgents: agents.filter((agent) => agent.enabled).length,
    assignedConversations: 0,
    agentsWithAssignedConversations: 0,
    completedConversations: 0,
    pausedConversations: 0,
    humanTakeovers: 0,
    skippedConversations: 0,
    discardedConversations: 0,
    totalTrackedConversations: 0,
    totalEvents: toMetricNumber(eventSummary.total_events),
    successEvents: toMetricNumber(eventSummary.success_events),
    errorEvents: toMetricNumber(eventSummary.error_events),
    assignedEvents: toMetricNumber(eventSummary.assigned_events),
    replyEvents: toMetricNumber(eventSummary.reply_events),
    appointmentEvents: toMetricNumber(eventSummary.appointment_events),
    paymentLinkEvents: toMetricNumber(eventSummary.payment_link_events),
    goalCompletionEvents: toMetricNumber(eventSummary.goal_completion_events),
    followUpSentEvents: toMetricNumber(eventSummary.follow_up_sent_events),
    followUpSuppressedEvents: toMetricNumber(eventSummary.follow_up_suppressed_events),
    humanHandoffEvents: toMetricNumber(eventSummary.human_handoff_events),
    toolFailureEvents: toMetricNumber(eventSummary.tool_failure_events),
    intelligenceAssessmentEvents: toMetricNumber(eventSummary.intelligence_assessment_events),
    responseRate: 0,
    toolFailureRate: 0,
    successRate: 0,
    byAgent: []
  }

  for (const row of stateRows || []) {
    const agentId = row?.agent_id
    if (!agentId) continue
    if (!metricsByAgent.has(agentId)) {
      metricsByAgent.set(agentId, {
        ...buildEmptyAgentMetric({
          id: agentId,
          name: 'Agente eliminado',
          enabled: false,
          aiProvider: DEFAULT_CONVERSATIONAL_AI_PROVIDER,
          model: DEFAULT_CONVERSATIONAL_AGENT_MODEL
        })
      })
    }

    const agentMetric = metricsByAgent.get(agentId)
    agentMetric.totalConversations += 1
    totals.totalTrackedConversations += 1

    if (row.status === 'active' && !row.signal) {
      agentMetric.assignedConversations += 1
      totals.assignedConversations += 1
      assignedAgentIds.add(agentId)
    }
    if (isCompletedAgentState(row)) {
      agentMetric.completedConversations += 1
      totals.completedConversations += 1
    }
    if (row.status === 'paused') {
      agentMetric.pausedConversations += 1
      totals.pausedConversations += 1
    }
    if (row.status === 'human') {
      agentMetric.humanTakeovers += 1
      totals.humanTakeovers += 1
    }
    if (row.status === 'skipped') {
      agentMetric.skippedConversations += 1
      totals.skippedConversations += 1
    }
    if (isDiscardedAgentState(row)) {
      agentMetric.discardedConversations += 1
      totals.discardedConversations += 1
    }

    const activity = stateLastActivity(row)
    if (activity && (!agentMetric.lastActivityAt || activity > agentMetric.lastActivityAt)) {
      agentMetric.lastActivityAt = activity
    }
  }

  totals.agentsWithAssignedConversations = assignedAgentIds.size
  const closedConversations = totals.completedConversations + totals.discardedConversations + totals.errorEvents
  totals.successRate = closedConversations > 0
    ? Math.round((totals.completedConversations / closedConversations) * 100)
    : 0
  const answeredConversations = (stateRows || []).filter((row) => Boolean(row.last_reply_at)).length
  totals.responseRate = totals.totalTrackedConversations > 0
    ? Math.round((answeredConversations / totals.totalTrackedConversations) * 100)
    : 0
  totals.toolFailureRate = totals.replyEvents + totals.toolFailureEvents > 0
    ? Math.round((totals.toolFailureEvents / (totals.replyEvents + totals.toolFailureEvents)) * 100)
    : 0
  totals.byAgent = Array.from(metricsByAgent.values())
    .sort((a, b) => (b.assignedConversations - a.assignedConversations) || (b.completedConversations - a.completedConversations))

  return totals
}

export async function getConversationalAgentMetrics() {
  await ensureAgentsMigration()
  await expirePausedConversationStates()
  const [agentRows, stateRows, eventSummary] = await Promise.all([
    db.all('SELECT * FROM conversational_agents ORDER BY position ASC, created_at ASC'),
    db.all(`
      SELECT agent_id, status, signal, signal_at, last_reply_at, updated_at
      FROM conversational_agent_state
      WHERE agent_id IS NOT NULL AND agent_id <> ''
    `),
    db.get(`
      SELECT
        COUNT(*) AS total_events,
        SUM(CASE WHEN event_type = 'signal_set' THEN 1 ELSE 0 END) AS success_events,
        SUM(CASE WHEN event_type = 'agent_assigned' THEN 1 ELSE 0 END) AS assigned_events,
        SUM(CASE WHEN event_type = 'reply_sent' THEN 1 ELSE 0 END) AS reply_events,
        SUM(CASE WHEN event_type = 'appointment_booked' THEN 1 ELSE 0 END) AS appointment_events,
        SUM(CASE WHEN event_type IN ('payment_link_created', 'payment_link_reused') THEN 1 ELSE 0 END) AS payment_link_events,
        SUM(CASE WHEN event_type IN ('goal_url_completed', 'purchase_completed') THEN 1 ELSE 0 END) AS goal_completion_events,
        SUM(CASE WHEN event_type = 'follow_up_sent' THEN 1 ELSE 0 END) AS follow_up_sent_events,
        SUM(CASE WHEN event_type = 'follow_up_suppressed' THEN 1 ELSE 0 END) AS follow_up_suppressed_events,
        SUM(CASE WHEN event_type IN ('human_handoff', 'runtime_human_handoff_forced') THEN 1 ELSE 0 END) AS human_handoff_events,
        SUM(CASE
          WHEN LOWER(event_type) LIKE '%tool%failed%'
            OR LOWER(event_type) LIKE '%calendar%error%'
            OR event_type = 'payment_link_failed'
          THEN 1 ELSE 0
        END) AS tool_failure_events,
        SUM(CASE WHEN event_type = 'conversation_intelligence_updated' THEN 1 ELSE 0 END) AS intelligence_assessment_events,
        SUM(CASE
          WHEN event_type = 'error'
            OR LOWER(event_type) LIKE '%error%'
            OR LOWER(event_type) LIKE '%failed%'
            OR LOWER(event_type) LIKE '%failure%'
          THEN 1 ELSE 0
        END) AS error_events
      FROM conversational_agent_events
    `)
  ])

  return buildConversationalAgentMetrics({
    agents: agentRows.map(mapAgentRow),
    stateRows,
    eventSummary
  })
}

export async function getConversationalAgent(agentId) {
  if (!agentId) return null
  const row = await db.get('SELECT * FROM conversational_agents WHERE id = ?', [agentId])
  return mapAgentRow(row)
}

async function refreshAssignedConversationStatesForAgent(agentId, { updatedBy = 'agent_config' } = {}) {
  const cleanAgentId = String(agentId || '').trim()
  if (!cleanAgentId) return 0
  const result = await db.run(`
    UPDATE conversational_agent_state
    SET updated_by = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE agent_id = ?
      AND status = 'active'
      AND (signal IS NULL OR signal = '')
  `, [updatedBy, cleanAgentId]).catch(() => null)
  return Number(result?.changes || result?.rowCount || 0)
}

function agentInputToRowValues(input, base) {
  assertAgentTimingInput(input)
  const identity = normalizeAgentIdentity(input, base)
  const next = {
    name: input.name === undefined ? base.name : String(input.name || 'Agente').trim().slice(0, 120) || 'Agente',
    enabled: input.enabled === undefined ? base.enabled : toBoolean(input.enabled),
    aiProvider: input.aiProvider === undefined ? normalizeConversationalAIProvider(base.aiProvider) : normalizeConversationalAIProvider(input.aiProvider),
    model: input.model === undefined
      ? (input.aiProvider === undefined
        ? normalizeConversationalAgentModel(base.model, base.aiProvider)
        : getDefaultConversationalModelForProvider(input.aiProvider))
      : normalizeConversationalAgentModel(input.model, input.aiProvider === undefined ? base.aiProvider : input.aiProvider),
    ...identity,
    position: input.position === undefined ? base.position : Number(input.position) || 0,
    objective: VALID_OBJECTIVES.has(input.objective) ? input.objective : base.objective,
    customObjective: input.customObjective === undefined ? base.customObjective : String(input.customObjective || '').slice(0, 2000),
    successAction: normalizeConversationalSuccessAction(input.successAction === undefined ? base.successAction : input.successAction),
    successExtras: input.successExtras === undefined ? base.successExtras : normalizeSuccessExtras(input.successExtras),
    requiredData: input.requiredData === undefined ? base.requiredData : String(input.requiredData || '').slice(0, 2000),
    handoffRules: input.handoffRules === undefined ? base.handoffRules : String(input.handoffRules || '').slice(0, 4000),
    extraInstructions: input.extraInstructions === undefined ? base.extraInstructions : String(input.extraInstructions || '').slice(0, 8000),
    allowEmojis: input.allowEmojis === undefined ? base.allowEmojis : toBoolean(input.allowEmojis),
    hideAttended: false,
    hideAttendedNotifications: input.hideAttendedNotifications === undefined
      ? (base.hideAttendedNotifications || toBoolean(input.hideAttended))
      : (toBoolean(input.hideAttendedNotifications) || toBoolean(input.hideAttended)),
    defaultCalendarId: input.defaultCalendarId === undefined ? base.defaultCalendarId : (String(input.defaultCalendarId || '').trim() || null),
    closingStrategyMode: 'system',
    closingStrategyCustom: '',
    persuasionLevel: input.persuasionLevel === undefined
      ? normalizeConversationalPersuasionLevel(base.persuasionLevel)
      : normalizeConversationalPersuasionLevel(input.persuasionLevel),
    languageLevel: input.languageLevel === undefined
      ? normalizeConversationalLanguageLevel(base.languageLevel)
      : normalizeConversationalLanguageLevel(input.languageLevel),
    contactScope: input.contactScope === undefined
      ? normalizeContactScope(base.contactScope)
      : normalizeContactScope(input.contactScope),
    // El corte se SELLA en el instante exacto en que el agente queda configurado como
    // 'new_only'; al volver a 'all' se limpia y al editar/reactivar se conserva.
    contactScopeCutoffAt: (() => {
      const nextScope = input.contactScope === undefined
        ? normalizeContactScope(base.contactScope)
        : normalizeContactScope(input.contactScope)
      if (nextScope !== 'new_only') return null
      if (normalizeContactScope(base.contactScope) === 'new_only' && base.contactScopeCutoffAt) {
        return base.contactScopeCutoffAt
      }
      return buildNewContactScopeCutoffAt()
    })(),
    responseDelay: input.responseDelay === undefined
      ? normalizeAgentResponseDelay(base.responseDelay)
      : normalizeAgentResponseDelay(input.responseDelay),
    replyDelivery: input.replyDelivery === undefined
      ? normalizeAgentReplyDeliveryForConfig(base.replyDelivery)
      : normalizeAgentReplyDeliveryForConfig(input.replyDelivery),
    followUp: input.followUp === undefined
      ? normalizeAgentFollowUp(base.followUp)
      : normalizeAgentFollowUp(input.followUp),
    goalWorkflow: input.goalWorkflow === undefined
      ? normalizeAgentGoalWorkflow(base.goalWorkflow)
      : normalizeAgentGoalWorkflow(input.goalWorkflow),
    filters: input.filters === undefined ? base.filters : normalizeAgentFilters(input.filters)
  }
  return next
}

const ACTIVE_AGENT_RUNTIME_CONFIG_KEYS = new Set([
  'enabled',
  'aiProvider',
  'model',
  'identityMode',
  'identityUserId',
  'identityUserName',
  'identityCustomName',
  'objective',
  'customObjective',
  'successAction',
  'successExtras',
  'requiredData',
  'handoffRules',
  'extraInstructions',
  'allowEmojis',
  'hideAttended',
  'hideAttendedNotifications',
  'defaultCalendarId',
  'persuasionLevel',
  'languageLevel',
  'contactScope',
  'responseDelay',
  'replyDelivery',
  'followUp',
  'goalWorkflow',
  'filters'
])

const DEFAULT_AGENT_BASE = {
  name: 'Agente',
  enabled: true,
  aiProvider: DEFAULT_CONVERSATIONAL_AI_PROVIDER,
  model: DEFAULT_CONVERSATIONAL_AGENT_MODEL,
  identityMode: 'business',
  identityUserId: '',
  identityUserName: '',
  identityCustomName: '',
  position: 0,
  objective: 'citas',
  customObjective: '',
  successAction: DEFAULT_SUCCESS_ACTION,
  successExtras: [],
  requiredData: '',
  handoffRules: '',
  extraInstructions: '',
  allowEmojis: false,
  hideAttended: false,
  hideAttendedNotifications: false,
  defaultCalendarId: null,
  closingStrategyMode: 'system',
  closingStrategyCustom: '',
  persuasionLevel: DEFAULT_PERSUASION_LEVEL,
  languageLevel: DEFAULT_LANGUAGE_LEVEL,
  contactScope: 'all',
  contactScopeCutoffAt: null,
  responseDelay: DEFAULT_RESPONSE_DELAY_CONFIG,
  replyDelivery: DEFAULT_REPLY_DELIVERY_CONFIG,
  followUp: DEFAULT_FOLLOW_UP_CONFIG,
  goalWorkflow: DEFAULT_GOAL_WORKFLOW_CONFIG,
  filters: { entry: [], exit: [] }
}

export function buildConversationalAgentRuntimeConfig(input = {}, base = {}) {
  return agentInputToRowValues(input || {}, {
    ...DEFAULT_AGENT_BASE,
    ...(base || {})
  })
}

const ENTRY_CONFLICT_CATEGORY_LABELS = {
  channel: 'canal',
  message: 'mensaje',
  tags: 'etiquetas',
  contact: 'contacto',
  appointments: 'citas',
  payments: 'pagos',
  ads: 'anuncios',
  schedule: 'horario'
}

const ENTRY_CONFLICT_NEGATIVE_OPERATORS = new Set([
  'is_not',
  'not_contains',
  'not_has',
  'has_none',
  'none',
  'not_exists',
  'not_from_ad',
  'empty',
  'no_has',
  'not_customer'
])

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function cleanEntryAnchorValue(value) {
  return normalizeMatchText(value)
}

function addEntryAnchor(target, key, label) {
  if (!key) return
  target.set(key, label)
}

function entryAnchorLabel(category, field, value = '') {
  const categoryLabel = ENTRY_CONFLICT_CATEGORY_LABELS[category] || category
  if (category === 'channel' && field === 'canal') return `mismo canal: ${value || 'chat'}`
  if (category === 'message' && field === 'texto') return `mismo texto de entrada: ${value || 'cualquier texto'}`
  if (category === 'message' && field === 'numero') return `mismo número de entrada: ${value}`
  if (category === 'tags' && field === 'etiqueta') return `misma etiqueta: ${value || 'cualquier etiqueta'}`
  if (category === 'ads' && field === 'anuncio') return `mismo anuncio: ${value}`
  if (field === 'cualquier valor') return `misma categoría de entrada: ${categoryLabel}`
  return [categoryLabel, field, value].map((part) => String(part || '').trim()).filter(Boolean).join(' · ')
}

function entryParamValues(param) {
  if (Array.isArray(param.values) && param.values.length) return param.values
  if (param.value !== undefined && param.value !== null && param.value !== '') return [param.value]
  if (param.date || param.dateEnd) return [[param.date, param.dateEnd].filter(Boolean).join('..')]
  if (param.timeStart || param.timeEnd) return [[param.timeStart || '09:00', param.timeEnd || '18:00'].join('..')]
  if (param.amount !== undefined || param.amountMax !== undefined) return [[param.amount, param.amountMax].filter((item) => item !== undefined && item !== null).join('..')]
  if (param.offsetValue !== undefined || param.offsetUnit) return [[param.offsetValue || 0, param.offsetUnit || 'minutes'].join(' ')]
  if (param.fieldKey) return [param.fieldKey]
  return ['*']
}

function isNegativeEntryParam(category, param) {
  if (!param) return false
  if (category === 'appointments' && param.field === 'presence' && param.operator === 'none') return true
  if (category === 'payments' && param.field === 'presence' && param.operator === 'none') return true
  if (category === 'ads' && param.field === 'presence' && ['not_exists', 'not_from_ad'].includes(param.operator)) return true
  return ENTRY_CONFLICT_NEGATIVE_OPERATORS.has(param.operator)
}

function addEntryParamAnchors(category, param, anchors, blockers) {
  const field = String(param?.field || '').trim() || 'base'
  const operator = String(param?.operator || '').trim()
  const negative = isNegativeEntryParam(category, param)
  const target = negative ? blockers : anchors

  if (category === 'channel' && field === 'channel') {
    const value = cleanEntryAnchorValue(param.value || 'chat') || 'chat'
    addEntryAnchor(target, `channel:${value}`, entryAnchorLabel(category, 'canal', value))
    return
  }

  if (category === 'message' && field === 'text') {
    for (const value of entryParamValues(param)) {
      const clean = cleanEntryAnchorValue(value)
      if (clean) addEntryAnchor(target, `message:text:${clean}`, entryAnchorLabel(category, 'texto', clean))
    }
    return
  }

  if (category === 'message' && field === 'business_phone') {
    const value = cleanEntryAnchorValue(param.value)
    if (value) addEntryAnchor(target, `message:business_phone:${value}`, entryAnchorLabel(category, 'numero', value))
    return
  }

  if (category === 'tags' && field === 'tag') {
    for (const value of entryParamValues(param)) {
      const clean = cleanEntryAnchorValue(value)
      if (clean) addEntryAnchor(target, `tags:tag:${clean}`, entryAnchorLabel(category, 'etiqueta', clean))
    }
    return
  }

  if (category === 'ads' && field === 'presence') {
    addEntryAnchor(target, 'ads:presence', entryAnchorLabel(category, 'origen'))
    return
  }

  if (category === 'ads' && field === 'ad') {
    for (const value of entryParamValues(param)) {
      const clean = cleanEntryAnchorValue(value)
      if (clean) addEntryAnchor(target, `ads:ad:${clean}`, entryAnchorLabel(category, 'anuncio', clean))
    }
    return
  }

  for (const value of entryParamValues(param)) {
    const clean = cleanEntryAnchorValue(value)
    const keyValue = clean || `${operator || 'base'}:*`
    addEntryAnchor(target, `${category}:${field}:${operator || 'base'}:${keyValue}`, entryAnchorLabel(category, field, clean))
  }
}

function buildEntryGroupScope(group = null) {
  if (!group) {
    return {
      catchAll: true,
      anchors: new Map([['catch_all', 'cualquier chat']]),
      blockers: new Map(),
      label: 'cualquier chat',
      fingerprint: 'catch_all'
    }
  }

  const anchors = new Map()
  const blockers = new Map()
  const labels = []
  const conditions = Array.isArray(group.conditions) ? group.conditions : []
  for (const condition of conditions) {
    const category = String(condition?.category || '').trim()
    if (!CONDITION_SCHEMA[category]) continue
    const categoryLabel = ENTRY_CONFLICT_CATEGORY_LABELS[category] || category
    const params = Array.isArray(condition.params) ? condition.params : []
    labels.push(categoryLabel)
    if (!params.length) {
      addEntryAnchor(anchors, `${category}:any`, entryAnchorLabel(category, 'cualquier valor'))
      continue
    }
    for (const param of params) {
      addEntryParamAnchors(category, param, anchors, blockers)
    }
  }

  return {
    catchAll: false,
    anchors,
    blockers,
    label: labels.length ? labels.join(' + ') : 'entrada amplia',
    fingerprint: stableJson(conditions)
  }
}

function buildEntryScopes(agent = {}) {
  const filters = normalizeAgentFilters(agent.filters)
  const groups = filters.entry?.groups || []
  if (!groups.length) return [buildEntryGroupScope(null)]
  return groups.map(buildEntryGroupScope)
}

function entryScopesContradict(left, right) {
  for (const key of left.anchors.keys()) {
    if (right.blockers.has(key)) return true
  }
  for (const key of right.anchors.keys()) {
    if (left.blockers.has(key)) return true
  }
  return false
}

function findEntryScopeCollision(candidateScope, existingScope) {
  if (candidateScope.catchAll || existingScope.catchAll) {
    return candidateScope.catchAll && existingScope.catchAll
      ? { anchor: 'catch_all', label: 'ambos entran con cualquier chat' }
      : null
  }
  if (entryScopesContradict(candidateScope, existingScope)) return null

  for (const [key, label] of candidateScope.anchors.entries()) {
    if (existingScope.anchors.has(key)) {
      return { anchor: key, label: label || existingScope.anchors.get(key) || 'misma entrada' }
    }
  }

  if (
    candidateScope.fingerprint &&
    existingScope.fingerprint &&
    candidateScope.fingerprint === existingScope.fingerprint
  ) {
    return { anchor: 'same_fingerprint', label: 'misma combinacion de condiciones' }
  }

  return null
}

export function findConversationalAgentEntryConflicts(candidateAgent = {}, activeAgents = []) {
  if (!candidateAgent?.enabled) return []

  const candidateScopes = buildEntryScopes(candidateAgent)
  const candidateId = String(candidateAgent.id || '').trim()
  const conflicts = []

  for (const agent of activeAgents || []) {
    if (!agent?.enabled) continue
    if (candidateId && String(agent.id || '').trim() === candidateId) continue

    const existingScopes = buildEntryScopes(agent)
    for (const candidateScope of candidateScopes) {
      for (const existingScope of existingScopes) {
        const collision = findEntryScopeCollision(candidateScope, existingScope)
        if (!collision) continue
        conflicts.push({
          agentId: agent.id,
          agentName: agent.name || 'Agente activo',
          candidateName: candidateAgent.name || 'Agente nuevo',
          candidateEntry: candidateScope.label,
          existingEntry: existingScope.label,
          reason: collision.label
        })
        break
      }
      if (conflicts.some((conflict) => conflict.agentId === agent.id)) break
    }
  }

  return conflicts
}

async function assertConversationalAgentEntryDoesNotConflict(candidateAgent, { excludeAgentId = null } = {}) {
  if (!candidateAgent?.enabled) return
  const rows = await db.all(`
    SELECT *
    FROM conversational_agents
    WHERE enabled = 1
      ${excludeAgentId ? 'AND id <> ?' : ''}
    ORDER BY position ASC, created_at ASC
  `, excludeAgentId ? [excludeAgentId] : [])
  const conflicts = findConversationalAgentEntryConflicts(candidateAgent, rows.map(mapAgentRow))
  if (!conflicts.length) return

  const firstConflict = conflicts[0]
  const error = new Error(`No se puede publicar este agente porque sus condiciones de entrada se pisan con "${firstConflict.agentName}". Cambia las condiciones de entrada para que sólo un agente pueda tomar ese chat.`)
  error.statusCode = 409
  error.code = CONVERSATIONAL_AGENT_ENTRY_CONFLICT_CODE
  error.conflicts = conflicts
  throw error
}

async function assertConversationalAgentPlanLimitAllowsCreate() {
  const maxAgents = await getConversationalAgentMaxAgents()
  if (maxAgents === null) return

  const existing = await db.get('SELECT COUNT(*) AS total FROM conversational_agents')
  const currentTotal = Number(existing?.total || 0)
  if (currentTotal < maxAgents) return

  const error = new Error(`Tu plan actual permite máximo ${maxAgents} agente conversacional${maxAgents === 1 ? '' : 'es'}. Elimina uno existente o actualiza tu plan para crear otro.`)
  error.statusCode = 403
  error.code = CONVERSATIONAL_AGENT_LIMIT_REACHED_CODE
  error.limit = {
    maxAgents,
    currentTotal
  }
  throw error
}

export async function createConversationalAgent(input = {}) {
  await ensureAgentsMigration()
  await assertConversationalAgentPlanLimitAllowsCreate()
  const maxPosition = await db.get('SELECT COALESCE(MAX(position), -1) AS max_pos FROM conversational_agents')
  const next = agentInputToRowValues(input, { ...DEFAULT_AGENT_BASE, position: Number(maxPosition?.max_pos ?? -1) + 1 })
  const id = `cagent_${randomUUID()}`
  await assertConversationalAgentEntryDoesNotConflict({ ...next, id })
  await db.run(`
    INSERT INTO conversational_agents (
      id, name, enabled, ai_provider, model, identity_mode, identity_user_id, identity_user_name, identity_custom_name,
      position, objective, custom_objective, success_action,
      success_extras, required_data, handoff_rules, extra_instructions,
      allow_emojis, hide_attended, hide_attended_notifications,
      default_calendar_id, closing_strategy_mode, closing_strategy_custom,
      persuasion_level, language_level, contact_scope, contact_scope_cutoff_at,
      response_delay_config, reply_delivery_config, follow_up_config, goal_workflow_config, entry_filters
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id, next.name, next.enabled ? 1 : 0, next.aiProvider, next.model,
    next.identityMode, next.identityUserId, next.identityUserName, next.identityCustomName,
    next.position, next.objective, next.customObjective,
    next.successAction, JSON.stringify(next.successExtras), next.requiredData, next.handoffRules,
    next.extraInstructions, next.allowEmojis ? 1 : 0,
    0, next.hideAttendedNotifications ? 1 : 0, next.defaultCalendarId,
    next.closingStrategyMode, next.closingStrategyCustom,
    next.persuasionLevel, next.languageLevel, next.contactScope, next.contactScopeCutoffAt,
    JSON.stringify(next.responseDelay), JSON.stringify(next.replyDelivery), JSON.stringify(next.followUp), JSON.stringify(next.goalWorkflow), JSON.stringify(next.filters)
  ])
  await recordConversationalAgentEvent({ eventType: 'agent_created', detail: { agentId: id, name: next.name } })
  if (next.enabled) {
    await enableConversationalAgentRuntime({ reason: 'agent_created_enabled', agentId: id })
  }
  return getConversationalAgent(id)
}

export async function updateConversationalAgent(agentId, input = {}) {
  const current = await getConversationalAgent(agentId)
  if (!current) {
    throw Object.assign(new Error('Agente conversacional no encontrado'), { statusCode: 404 })
  }
  const next = agentInputToRowValues(input, current)
  const shouldRefreshAssignedStates = Object.keys(input || {}).some((key) => ACTIVE_AGENT_RUNTIME_CONFIG_KEYS.has(key))
  const shouldValidateEntry = next.enabled && (!current.enabled || input.enabled === true || input.filters !== undefined)
  if (shouldValidateEntry) {
    await assertConversationalAgentEntryDoesNotConflict({ ...next, id: agentId }, { excludeAgentId: agentId })
  }
  await db.run(`
    UPDATE conversational_agents
    SET name = ?, enabled = ?, ai_provider = ?, model = ?,
        identity_mode = ?, identity_user_id = ?, identity_user_name = ?, identity_custom_name = ?,
        position = ?, objective = ?, custom_objective = ?,
        success_action = ?, success_extras = ?, required_data = ?, handoff_rules = ?,
        extra_instructions = ?, allow_emojis = ?, hide_attended = ?, hide_attended_notifications = ?,
        default_calendar_id = ?,
        closing_strategy_mode = ?, closing_strategy_custom = ?,
        persuasion_level = ?, language_level = ?,
        contact_scope = ?, contact_scope_cutoff_at = ?, response_delay_config = ?,
        reply_delivery_config = ?, follow_up_config = ?, goal_workflow_config = ?, entry_filters = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    next.name, next.enabled ? 1 : 0, next.aiProvider, next.model,
    next.identityMode, next.identityUserId, next.identityUserName, next.identityCustomName,
    next.position, next.objective, next.customObjective,
    next.successAction, JSON.stringify(next.successExtras), next.requiredData, next.handoffRules,
    next.extraInstructions, next.allowEmojis ? 1 : 0,
    0, next.hideAttendedNotifications ? 1 : 0, next.defaultCalendarId,
    next.closingStrategyMode, next.closingStrategyCustom,
    next.persuasionLevel, next.languageLevel,
    next.contactScope, next.contactScopeCutoffAt,
    JSON.stringify(next.responseDelay), JSON.stringify(next.replyDelivery), JSON.stringify(next.followUp), JSON.stringify(next.goalWorkflow), JSON.stringify(next.filters),
    agentId
  ])
  if (next.enabled) {
    await enableConversationalAgentRuntime({ reason: 'agent_updated_enabled', agentId })
  }
  if (shouldRefreshAssignedStates) {
    const refreshedCount = await refreshAssignedConversationStatesForAgent(agentId)
    if (refreshedCount > 0) {
      await recordConversationalAgentEvent({
        eventType: 'agent_config_applied_to_active_conversations',
        detail: {
          agentId,
          refreshedCount,
          hideAttendedNotifications: next.hideAttendedNotifications,
          aiProvider: next.aiProvider,
          model: next.model
        }
      })
    }
  }
  return getConversationalAgent(agentId)
}

export async function deleteConversationalAgent(agentId) {
  const current = await getConversationalAgent(agentId)
  if (!current) return false
  await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId])
  await db.run(`
    UPDATE conversational_agent_state
    SET agent_id = NULL,
        assignment_source = 'released',
        assigned_by = 'agent_deleted',
        updated_by = 'agent_deleted',
        updated_at = CURRENT_TIMESTAMP
    WHERE agent_id = ?
  `, [agentId]).catch(() => {})
  await recordConversationalAgentEvent({ eventType: 'agent_deleted', detail: { agentId, name: current.name } })
  return true
}

export async function resetConversationalAgentSkippedContacts(agentId, { updatedBy = 'user' } = {}) {
  const cleanAgentId = String(agentId || '').trim()
  if (!cleanAgentId) {
    throw Object.assign(new Error('Agente conversacional inválido'), { statusCode: 400 })
  }

  await ensureAgentsMigration()
  const agent = await getConversationalAgent(cleanAgentId)
  if (!agent) return null

  const rows = await db.all(`
    SELECT contact_id
    FROM conversational_agent_state
    WHERE agent_id = ?
      AND status = 'skipped'
  `, [cleanAgentId])
  const contactIds = rows.map((row) => row.contact_id).filter(Boolean)
  if (!contactIds.length) {
    return { agentId: cleanAgentId, resetCount: 0 }
  }

  const cleanUpdatedBy = String(updatedBy || 'user').trim() || 'user'
  await db.run(`
    UPDATE conversational_agent_state
    SET status = 'active',
        paused_until_at = NULL,
        updated_by = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE agent_id = ?
      AND status = 'skipped'
  `, [cleanUpdatedBy, cleanAgentId])

  await Promise.all(contactIds.map((contactId) => recordConversationalAgentEvent({
    contactId,
    eventType: 'status_changed',
    detail: {
      status: 'active',
      previousStatus: 'skipped',
      updatedBy: cleanUpdatedBy,
      reason: 'agent_skips_reset',
      agentId: cleanAgentId
    }
  }).catch(() => undefined)))

  await recordConversationalAgentEvent({
    eventType: 'agent_skips_reset',
    detail: { agentId: cleanAgentId, name: agent.name, resetCount: contactIds.length, updatedBy: cleanUpdatedBy }
  }).catch(() => undefined)

  return { agentId: cleanAgentId, resetCount: contactIds.length }
}

function normalizeMatchText(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()
}

const CANCELLED_STATUSES = new Set(['cancelled', 'canceled'])
const PAYMENT_STATUS_MAP = {
  payment_received: new Set(['succeeded', 'paid', 'completed', 'success']),
  payment_pending: new Set(['pending', 'sent', 'processing']),
  payment_failed: new Set(['failed', 'declined', 'error']),
  payment_refunded: new Set(['refunded', 'refund', 'partially_refunded'])
}
const OFFSET_MS = { minutes: 60000, hours: 3600000, days: 86400000 }
const CONTACT_DATE_FIELDS = new Set(['created', 'updated', 'last_purchase'])

/**
 * Construye una sola vez el contexto que necesitan las condiciones (etiquetas,
 * citas, pagos y asignados del contacto) para evaluar varios agentes sin
 * repetir consultas.
 */
export async function buildRuleContext({ contactId = null, messageText = '', channel = 'whatsapp', post = null } = {}) {
  const nowIso = new Date().toISOString()

  const [contact, appointmentRows, paymentRows, adRows, latestInbound, timezone] = await Promise.all([
    contactId ? db.get(`
      SELECT id, tags, full_name, first_name, last_name, phone, email, source,
             purchases_count, total_paid, last_purchase_date, visitor_id,
             attribution_session_source, attribution_medium, attribution_ad_name,
             attribution_ad_id, preferred_whatsapp_phone_number_id, ghl_contact_id,
             created_at, updated_at, custom_fields
      FROM contacts WHERE id = ?
    `, [contactId]).catch(() => null) : null,
    contactId ? db.all(`
      SELECT calendar_id, start_time, end_time, appointment_status, status, assigned_user_id
      FROM appointments
      WHERE contact_id = ? AND deleted_at IS NULL
      ORDER BY start_time ASC
    `, [contactId]).catch(() => []) : [],
    contactId ? db.all(`
      SELECT amount, status, title, description
      FROM payments
      WHERE contact_id = ?
      ORDER BY ${coalescedTimestampSortExpression('date', 'created_at')} DESC
      LIMIT 100
    `, [contactId]).catch(() => []) : [],
    // Atribución de anuncios: clics CTWA y anuncios detectados en sus mensajes
    contactId ? db.all(`
      SELECT DISTINCT
        m.detected_ctwa_clid,
        m.detected_source_id,
        (
          SELECT MAX(a.ad_name)
          FROM meta_ads a
          WHERE a.ad_id = m.detected_source_id
        ) AS ad_name,
        (
          SELECT MAX(a.campaign_name)
          FROM meta_ads a
          WHERE a.ad_id = m.detected_source_id
        ) AS campaign_name
      FROM whatsapp_api_messages m
      WHERE m.contact_id = ? AND m.direction = 'inbound'
        AND (COALESCE(m.detected_ctwa_clid, '') != '' OR COALESCE(m.detected_source_id, '') != '')
      LIMIT 50
    `, [contactId]).catch(() => []) : [],
    contactId ? db.get(`
      SELECT business_phone_number_id
      FROM whatsapp_api_messages
      WHERE contact_id = ? AND direction = 'inbound'
      ORDER BY COALESCE(message_timestamp, created_at) DESC
      LIMIT 1
    `, [contactId]).catch(() => null) : null,
    getAccountTimezone().catch(() => DEFAULT_TIMEZONE)
  ])

  // Hora local del negocio (para condiciones de horario y día de la semana)
  let localMinutes = 0
  let localWeekday = 'mon'
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false
    }).formatToParts(new Date())
    const get = (type) => parts.find((part) => part.type === type)?.value || ''
    localMinutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'))
    localWeekday = get('weekday').slice(0, 3).toLowerCase()
  } catch { /* zona inválida: se queda el default */ }

  // Claves de coincidencia de etiquetas: IDs del catálogo, nombres (las reglas
  // viejas guardaban el nombre) y etiquetas internas calculadas (Cliente,
  // Cita agendada, Prospecto).
  const contactTags = parseJsonField(contact?.tags, [])
  const tagKeys = await buildTagMatchKeys(contactId, Array.isArray(contactTags) ? contactTags : [])
    .catch(() => new Set((Array.isArray(contactTags) ? contactTags : []).map(normalizeMatchText)))
  const tags = [...tagKeys].map(normalizeMatchText)

  const appointments = appointmentRows.map((row) => ({
    calendarId: String(row.calendar_id || ''),
    startTime: row.start_time,
    endTime: row.end_time,
    status: normalizeMatchText(row.appointment_status || row.status || ''),
    assignedUserId: String(row.assigned_user_id || '')
  }))

  // Nombres de los usuarios asignados a citas del contacto (para "Contacto asignado")
  const assigneeIds = [...new Set(appointments.map((appt) => appt.assignedUserId).filter(Boolean))]
  let assigneeNames = []
  if (assigneeIds.length) {
    const placeholders = assigneeIds.map(() => '?').join(', ')
    const users = await db.all(
      `SELECT id, first_name, last_name, business_name, email FROM users WHERE CAST(id AS TEXT) IN (${placeholders})`,
      assigneeIds
    ).catch(() => [])
    assigneeNames = users.map((user) => normalizeMatchText(
      [user.first_name, user.last_name].filter(Boolean).join(' ') || user.business_name || user.email || ''
    )).filter(Boolean)
  }

  const contactAdValues = [
    contact?.attribution_ad_name,
    contact?.attribution_ad_id
  ].map((value) => String(value || '').trim()).filter(Boolean)
  const adSourceIds = [...new Set([
    ...adRows.map((row) => String(row.detected_source_id || '').trim()).filter(Boolean),
    String(contact?.attribution_ad_id || '').trim()
  ].filter(Boolean))]
  const adSourceValues = [...new Set([
    ...adSourceIds,
    ...adRows.flatMap((row) => [row.ad_name, row.campaign_name]),
    ...contactAdValues
  ].map(normalizeMatchText).filter(Boolean))]

  return {
    now: Date.now(),
    nowIso,
    channel,
    postId: String(post?.postId || '').trim(),
    mediaId: String(post?.mediaId || '').trim(),
    postPermalink: String(post?.permalink || '').trim(),
    text: normalizeMatchText(messageText),
    tags,
    appointments,
    payments: paymentRows.map((row) => ({
      amount: Number(row.amount) || 0,
      status: normalizeMatchText(row.status || ''),
      product: normalizeMatchText([row.title, row.description].filter(Boolean).join(' '))
    })),
    assigneeIds: assigneeIds.map(normalizeMatchText),
    assigneeNames,
    cameFromAd: adRows.some((row) => String(row.detected_ctwa_clid || '').trim() || String(row.detected_source_id || '').trim()) || contactAdValues.length > 0,
    adSourceIds,
    adSourceValues,
    businessPhoneNumberId: String(latestInbound?.business_phone_number_id || ''),
    contactInfo: contact ? {
      name: normalizeMatchText(contact.full_name || ''),
      firstName: normalizeMatchText(contact.first_name || ''),
      lastName: normalizeMatchText(contact.last_name || ''),
      phone: String(contact.phone || '').trim(),
      email: String(contact.email || '').trim(),
      source: normalizeMatchText(contact.source || ''),
      attributionSource: normalizeMatchText(contact.attribution_session_source || ''),
      attributionMedium: normalizeMatchText(contact.attribution_medium || ''),
      attributionAd: normalizeMatchText([contact.attribution_ad_name, contact.attribution_ad_id].filter(Boolean).join(' ')),
      visitorId: normalizeMatchText(contact.visitor_id || ''),
      ghlContactId: normalizeMatchText(contact.ghl_contact_id || ''),
      preferredPhone: String(contact.preferred_whatsapp_phone_number_id || '').trim(),
      purchasesCount: Number(contact.purchases_count) || 0,
      totalPaid: Number(contact.total_paid) || 0,
      createdAt: contact.created_at || null,
      updatedAt: contact.updated_at || null,
      lastPurchaseDate: contact.last_purchase_date || null
    } : null,
    customFields: normalizeCustomFieldsMap(parseJsonField(contact?.custom_fields, null)),
    localMinutes,
    localWeekday
  }
}

/**
 * Mapa de campos personalizados con claves normalizadas. contacts.custom_fields
 * puede ser objeto {clave: valor} o lista [{key/field_key, value}].
 */
function normalizeCustomFieldsMap(raw) {
  const map = {}
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const key = String(item?.key || item?.field_key || item?.id || '').trim()
      if (key) map[normalizeMatchText(key)] = String(item?.value ?? '')
    }
  } else if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      map[normalizeMatchText(key)] = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')
    }
  }
  return map
}

function activeAppointments(ctx) {
  return ctx.appointments.filter((appt) => !CANCELLED_STATUSES.has(appt.status))
}

function upcomingAppointments(ctx) {
  return activeAppointments(ctx).filter((appt) => Date.parse(appt.startTime) > ctx.now)
}

function nextAppointment(ctx) {
  return upcomingAppointments(ctx)[0] || null
}

function textMatches(operator, ctx, param) {
  const single = normalizeMatchText(param.value)
  const list = (param.values || []).map(normalizeMatchText).filter(Boolean)
  switch (operator) {
    case 'contains': return !single || ctx.text.includes(single)
    case 'not_contains': return !single || !ctx.text.includes(single)
    case 'contains_any': return !list.length || list.some((phrase) => ctx.text.includes(phrase))
    case 'contains_all': return !list.length || list.every((phrase) => ctx.text.includes(phrase))
    case 'starts_with': return !single || ctx.text.startsWith(single)
    case 'ends_with': return !single || ctx.text.endsWith(single)
    case 'equals': return !single || ctx.text === single
    default: return false
  }
}

function textValueMatches(rawValue, operator, expectedValue) {
  const actual = normalizeMatchText(rawValue)
  const expected = normalizeMatchText(expectedValue)
  if (operator === 'empty' || operator === 'no_has') return !actual
  if (operator === 'not_empty' || operator === 'has' || operator === 'has_value') return Boolean(actual)
  if (!expected) return true
  if (operator === 'is') return actual === expected
  if (operator === 'is_not') return actual !== expected
  if (operator === 'not_contains') return !actual.includes(expected)
  if (operator === 'starts_with') return actual.startsWith(expected)
  if (operator === 'ends_with') return actual.endsWith(expected)
  return actual.includes(expected)
}

function anyTextValueMatches(rawValues, operator, expectedValue) {
  const values = rawValues.map(normalizeMatchText).filter(Boolean)
  if (operator === 'empty' || operator === 'no_has') return values.length === 0
  if (operator === 'not_empty' || operator === 'has' || operator === 'has_value') return values.length > 0
  if (operator === 'is_not' || operator === 'not_contains') {
    return values.every((value) => textValueMatches(value, operator, expectedValue))
  }
  return values.some((value) => textValueMatches(value, operator, expectedValue))
}

function dateValueMatches(rawDate, param, ctx) {
  if (!rawDate) return false
  const parsed = Date.parse(rawDate)
  if (!Number.isFinite(parsed)) return false
  if (param.operator === 'within' || param.operator === 'older_than') {
    const offset = (param.offsetValue || 0) * (OFFSET_MS[param.offsetUnit] || OFFSET_MS.days)
    return param.operator === 'older_than'
      ? ctx.now - parsed > offset
      : ctx.now - parsed <= offset
  }
  if (!param.date) return true
  const actualDate = String(rawDate || '').slice(0, 10)
  if (param.operator === 'before') return actualDate < param.date
  if (param.operator === 'after') return actualDate > param.date
  if (param.operator === 'between') return Boolean(param.dateEnd) && actualDate >= param.date && actualDate <= param.dateEnd
  return actualDate === param.date
}

/**
 * Citas: los parámetros filtran un MISMO conjunto de citas candidatas
 * ("calendario X" + "confirmada" exige una cita que cumpla ambos) y el
 * parámetro presence decide si debe existir alguna (has) o ninguna (none).
 */
function appointmentsConditionMatches(params, ctx) {
  const presence = params.find((param) => param.field === 'presence')?.operator || 'has'
  const wantsCancelled = params.some((param) => param.field === 'status' && param.operator === 'cancelled')

  let candidates = wantsCancelled ? ctx.appointments : activeAppointments(ctx)

  for (const param of params) {
    if (param.field === 'calendar') {
      if (!param.calendarId && !param.value) continue
      const calendarId = param.calendarId || param.value
      candidates = param.operator === 'is_not'
        ? candidates.filter((appt) => appt.calendarId !== calendarId)
        : candidates.filter((appt) => appt.calendarId === calendarId)
    } else if (param.field === 'status') {
      const wanted = param.operator
      candidates = candidates.filter((appt) => (
        wanted === 'cancelled' ? CANCELLED_STATUSES.has(appt.status) : appt.status === wanted
      ))
    } else if (param.field === 'timing') {
      if (param.operator === 'upcoming') {
        candidates = candidates.filter((appt) => Date.parse(appt.startTime) > ctx.now)
      } else if (param.operator === 'past_due') {
        candidates = candidates.filter((appt) => Date.parse(appt.endTime || appt.startTime) < ctx.now)
      } else if (param.operator === 'today') {
        const today = ctx.nowIso.slice(0, 10)
        candidates = candidates.filter((appt) => String(appt.startTime || '').slice(0, 10) === today)
      }
    } else if (param.field === 'date') {
      if (!param.date) continue
      candidates = candidates.filter((appt) => {
        const apptDate = String(appt.startTime || '').slice(0, 10)
        if (param.operator === 'is') return apptDate === param.date
        if (param.operator === 'not') return apptDate !== param.date
        if (param.operator === 'before') return apptDate < param.date
        if (param.operator === 'after') return apptDate > param.date
        return Boolean(param.dateEnd) && apptDate >= param.date && apptDate <= param.dateEnd
      })
    } else if (param.field === 'window') {
      const offset = (param.offsetValue || 0) * (OFFSET_MS[param.offsetUnit] || OFFSET_MS.minutes)
      candidates = candidates.filter((appt) => {
        if (param.operator === 'before') {
          const start = Date.parse(appt.startTime)
          return ctx.now >= start - offset && ctx.now < start
        }
        const end = Date.parse(appt.endTime || appt.startTime)
        return ctx.now >= end && ctx.now <= end + offset
      })
    }
  }

  return presence === 'none' ? candidates.length === 0 : candidates.length > 0
}

/** Pagos: misma mecánica conjunta que las citas. */
function paymentsConditionMatches(params, ctx) {
  const presence = params.find((param) => param.field === 'presence')?.operator || 'has'
  let candidates = ctx.payments

  for (const param of params) {
    if (param.field === 'status') {
      const statusSet = PAYMENT_STATUS_MAP[`payment_${param.operator}`]
      if (statusSet) candidates = candidates.filter((payment) => statusSet.has(payment.status))
    } else if (param.field === 'product') {
      const value = normalizeMatchText(param.value)
      if (!value) continue
      candidates = candidates.filter((payment) => {
        if (param.operator === 'is') return payment.product === value
        if (param.operator === 'is_not') return payment.product !== value
        if (param.operator === 'contains') return payment.product.includes(value)
        return !payment.product.includes(value)
      })
    } else if (param.field === 'amount') {
      candidates = candidates.filter((payment) => {
        if (param.operator === 'eq') return payment.amount === (param.amount || 0)
        if (param.operator === 'gt') return payment.amount > (param.amount || 0)
        if (param.operator === 'lt') return payment.amount > 0 && payment.amount < (param.amount || 0)
        return payment.amount >= (param.amount || 0) && payment.amount <= (param.amountMax || 0)
      })
    }
  }

  return presence === 'none' ? candidates.length === 0 : candidates.length > 0
}

function contactParamMatches(param, ctx) {
  const info = ctx.contactInfo
  if (!info) return false
  const value = normalizeMatchText(param.value)
  switch (param.field) {
    case 'name':
      return textValueMatches(info.name, param.operator, value)
    case 'first_name':
      return textValueMatches(info.firstName, param.operator, value)
    case 'last_name':
      return textValueMatches(info.lastName, param.operator, value)
    case 'email':
      return textValueMatches(info.email, param.operator, value)
    case 'phone':
      return textValueMatches(info.phone, param.operator, value)
    case 'source':
      return anyTextValueMatches([info.source, info.attributionSource], param.operator, value)
    case 'attribution_source':
      return textValueMatches(info.attributionSource, param.operator, value)
    case 'attribution_medium':
      return textValueMatches(info.attributionMedium, param.operator, value)
    case 'attribution_ad':
      return textValueMatches(info.attributionAd, param.operator, value)
    case 'visitor_id':
      return textValueMatches(info.visitorId, param.operator, value)
    case 'ghl_contact_id':
      return textValueMatches(info.ghlContactId, param.operator, value)
    case 'preferred_phone':
      return textValueMatches(info.preferredPhone, param.operator, param.value)
    case 'customer':
      return param.operator === 'is_customer'
        ? (info.purchasesCount > 0 || info.totalPaid > 0)
        : (info.purchasesCount === 0 && info.totalPaid === 0)
    case 'created':
      return dateValueMatches(info.createdAt, param, ctx)
    case 'updated':
      return dateValueMatches(info.updatedAt, param, ctx)
    case 'last_purchase':
      return dateValueMatches(info.lastPurchaseDate, param, ctx)
    case 'assigned': {
      const matchesValue = Boolean(value) && (ctx.assigneeNames.some((name) => name.includes(value)) || ctx.assigneeIds.includes(value))
      if (param.operator === 'to') return matchesValue
      if (param.operator === 'not_to') return !value || !matchesValue
      if (param.operator === 'any') return ctx.assigneeIds.length > 0
      return ctx.assigneeIds.length === 0
    }
    case 'custom_field': {
      if (!param.fieldKey) return true
      const fieldValue = normalizeMatchText(ctx.customFields[normalizeMatchText(param.fieldKey)] ?? ctx.customFields[param.fieldKey] ?? '')
      return textValueMatches(fieldValue, param.operator, value)
    }
    default:
      return false
  }
}

function scheduleParamMatches(param, ctx) {
  if (param.field === 'day') {
    const days = (param.values || []).map((day) => String(day).toLowerCase())
    return !days.length || days.includes(ctx.localWeekday)
  }
  const [startHour, startMinute] = String(param.timeStart || '09:00').split(':').map(Number)
  const [endHour, endMinute] = String(param.timeEnd || '18:00').split(':').map(Number)
  const start = startHour * 60 + (startMinute || 0)
  const end = endHour * 60 + (endMinute || 0)
  // Soporta rangos que cruzan medianoche (ej. 22:00 a 06:00)
  const inside = start <= end
    ? ctx.localMinutes >= start && ctx.localMinutes <= end
    : ctx.localMinutes >= start || ctx.localMinutes <= end
  return param.operator === 'outside' ? !inside : inside
}

// Compara la publicación configurada en una condición de comentario contra el
// post/media del comentario entrante (postId FB / mediaId IG / permalink). Vacío
// = cualquiera. Tolerante como postMatches del motor de automatizaciones.
function commentPostMatches(wanted, ctx) {
  const target = String(wanted || '').trim().toLowerCase()
  if (!target) return true
  const candidates = [ctx.postId, ctx.mediaId, ctx.postPermalink]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
  return candidates.some((c) => (
    c === target ||
    (target.length >= 6 && c.includes(target)) ||
    (c.length >= 6 && target.includes(c))
  ))
}

function conditionMatches(condition, ctx) {
  const { category } = condition
  const params = condition.params || []

  if (category === 'channel') {
    return params.every((param) => {
      const targetChannel = String(param.value || '').trim().toLowerCase()
      const currentChannel = String(ctx.channel || '').trim().toLowerCase()
      let matches = targetChannel === 'chat'
        ? CHAT_CONDITION_CHANNELS.has(currentChannel)
        : targetChannel === currentChannel
      // Canal de comentario con publicación específica: además el comentario debe
      // ser de esa publicación. Vacío ("Todas") = cualquiera.
      if (matches && COMMENT_CONDITION_CHANNELS.has(targetChannel) && param.postId) {
        matches = commentPostMatches(param.postId, ctx)
      }
      return param.operator === 'is_not' ? !matches : matches
    })
  }

  if (category === 'message') {
    // Base: llegó un mensaje (cierto al evaluar); los parámetros lo afinan
    return params.every((param) => {
      if (param.field === 'text') return textMatches(param.operator, ctx, param)
      if (param.field === 'business_phone') {
        const matches = Boolean(param.value) && ctx.businessPhoneNumberId === param.value
        return param.operator === 'is_not' ? (!param.value || !matches) : matches
      }
      return false
    })
  }

  if (category === 'tags') {
    // Base: tiene alguna etiqueta
    if (!params.length) return ctx.tags.length > 0
    return params.every((param) => {
      const single = normalizeMatchText(param.value)
      const list = (param.values || []).map(normalizeMatchText).filter(Boolean)
      switch (param.operator) {
        case 'has': return Boolean(single) && ctx.tags.includes(single)
        case 'not_has': return !single || !ctx.tags.includes(single)
        case 'has_any': return !list.length || list.some((tag) => ctx.tags.includes(tag))
        case 'has_all': return !list.length || list.every((tag) => ctx.tags.includes(tag))
        case 'has_none': return !list.length || !list.some((tag) => ctx.tags.includes(tag))
        default: return false
      }
    })
  }

  if (category === 'contact') {
    if (!ctx.contactInfo) return false
    return params.every((param) => contactParamMatches(param, ctx))
  }

  if (category === 'appointments') {
    return appointmentsConditionMatches(params, ctx)
  }

  if (category === 'payments') {
    return paymentsConditionMatches(params, ctx)
  }

  if (category === 'ads') {
    const presence = params.find((param) => param.field === 'presence')?.operator || 'exists'
    if (presence === 'not_exists' || presence === 'not_from_ad') return !ctx.cameFromAd
    if (!ctx.cameFromAd) return false
    const adValues = [...new Set([
      ...(Array.isArray(ctx.adSourceValues) ? ctx.adSourceValues : []),
      ...(Array.isArray(ctx.adSourceIds) ? ctx.adSourceIds : [])
    ].map(normalizeMatchText).filter(Boolean))]
    return params.every((param) => {
      if (param.field !== 'ad') return true
      const expected = normalizeMatchText(param.value)
      if (!expected) return true
      const matches = adValues.some((value) => textValueMatches(value, param.operator, expected))
      if (param.operator === 'is_not' || param.operator === 'not_contains') {
        return adValues.every((value) => textValueMatches(value, param.operator, expected))
      }
      return matches
    })
  }

  if (category === 'schedule') {
    return params.every((param) => scheduleParamMatches(param, ctx))
  }

  return false
}

function groupsMatch(groups, ctx) {
  return groups.some((group) => group.conditions.every((condition) => conditionMatches(condition, ctx)))
}

/** Entrada: basta UN grupo (O) donde se cumplan TODAS sus condiciones (Y). Sin grupos = pasa. */
export function entryRulesMatch(agent, ctx) {
  const groups = agent.filters?.entry?.groups || []
  if (!groups.length) return true
  return groupsMatch(groups, ctx)
}

/** Salida: el agente suelta la conversación si algún grupo se cumple completo. Sin grupos = nunca. */
export function exitRulesMatch(agent, ctx) {
  const groups = agent.filters?.exit?.groups || []
  if (!groups.length) return false
  return groupsMatch(groups, ctx)
}

/**
 * Encuentra el primer agente habilitado (en orden de posición) cuyas reglas de
 * entrada se cumplen y cuyas reglas de salida NO aplican ya de inicio.
 */
// Parsea timestamps de forma determinista. SQLite devuelve CURRENT_TIMESTAMP como
// "YYYY-MM-DD HH:MM:SS" SIN zona; Date.parse lo leería como hora LOCAL y desfasaría el
// corte. Aquí ese formato se interpreta como UTC (igual que el cutoff, que es toISOString).
function parseTimestampMsUtc(value) {
  if (value == null) return NaN
  if (value instanceof Date) return value.getTime()
  let s = String(value).trim()
  if (!s) return NaN
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s) && !/(z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    s = `${s.replace(' ', 'T')}Z`
  }
  return Date.parse(s)
}

// Medida de seguridad: un agente con contactScope 'new_only' NO debe tomar contactos
// que ya existían cuando se selló su corte. Fail-open: si falta el corte o la fecha del
// contacto, NO bloquea (preferimos atender de más que silenciar al agente por un dato faltante).
export function contactIsOutOfScopeForAgent(agent, ctx) {
  if (normalizeContactScope(agent?.contactScope) !== 'new_only') return false
  const cutoff = agent?.contactScopeCutoffAt
  const createdAt = ctx?.contactInfo?.createdAt
  if (!cutoff || !createdAt) return false
  const created = parseTimestampMsUtc(createdAt)
  const cut = parseTimestampMsUtc(cutoff)
  if (!Number.isFinite(created) || !Number.isFinite(cut)) return false
  return created < cut // el contacto nació ANTES del corte → este agente lo ignora
}

export function isUnverifiedConversationAssignment(state) {
  if (!state?.agentId) return false
  const source = String(state.assignmentSource || '').trim().toLowerCase()
  return !EXPLICIT_ASSIGNMENT_SOURCES.has(source)
}

export async function matchAgentForMessage({ contactId, messageText = '', channel = 'whatsapp', excludeAgentId = null, excludeAgentIds = [], ruleContext = null } = {}) {
  const agents = (await listConversationalAgents()).filter((agent) => agent.enabled)
  if (!agents.length) return null

  const ctx = ruleContext || await buildRuleContext({ contactId, messageText, channel })
  const excluded = new Set([
    ...(Array.isArray(excludeAgentIds) ? excludeAgentIds : []),
    excludeAgentId
  ].map((item) => String(item || '').trim()).filter(Boolean))

  for (const agent of agents) {
    if (excluded.has(agent.id)) continue
    if (!entryRulesMatch(agent, ctx)) continue
    if (contactIsOutOfScopeForAgent(agent, ctx)) continue
    if (exitRulesMatch(agent, ctx)) continue
    return agent
  }

  return null
}

/**
 * Catálogos para el constructor de condiciones: anuncios de Meta con su nombre
 * real (no solo el ID) y números de WhatsApp del negocio.
 */
export async function listAgentFilterOptions() {
  const [metaAds, detectedRows, phoneRows, customFieldRows] = await Promise.all([
    db.all(`
      SELECT ad_id, MAX(ad_name) AS ad_name, MAX(campaign_name) AS campaign_name, MAX(date) AS last_date
      FROM meta_ads
      WHERE COALESCE(ad_id, '') != ''
      GROUP BY ad_id
      ORDER BY last_date DESC
      LIMIT 300
    `).catch(() => []),
    db.all(`
      SELECT DISTINCT detected_source_id AS id
      FROM whatsapp_api_messages
      WHERE COALESCE(detected_source_id, '') != ''
      LIMIT 200
    `).catch(() => []),
    db.all(`
      SELECT id, label, verified_name, display_phone_number, phone_number
      FROM whatsapp_api_phone_numbers
      ORDER BY is_default_sender DESC, created_at ASC
    `).catch(() => []),
    db.all(`
      SELECT field_key, label
      FROM contact_custom_field_definitions
      WHERE archived = 0
        AND COALESCE(source_type, 'manual') != 'system'
      ORDER BY label ASC
      LIMIT 300
    `).catch(() => [])
  ])

  const adNameById = new Map()
  for (const row of metaAds) {
    adNameById.set(String(row.ad_id), {
      name: row.ad_name || `Anuncio ${row.ad_id}`,
      campaign: row.campaign_name || null
    })
  }

  // Primero los anuncios ya detectados en mensajes (son los accionables);
  // después el resto del catálogo de Meta.
  const ads = []
  const seen = new Set()
  for (const row of detectedRows) {
    const id = String(row.id)
    const meta = adNameById.get(id)
    ads.push({ id, name: meta?.name || `Anuncio ${id}`, campaign: meta?.campaign || null, detected: true })
    seen.add(id)
  }
  for (const [id, meta] of adNameById) {
    if (seen.has(id)) continue
    ads.push({ id, name: meta.name, campaign: meta.campaign, detected: false })
  }

  return {
    ads,
    businessPhones: phoneRows.map((row) => ({
      id: row.id,
      label: row.label || row.verified_name || row.display_phone_number || row.phone_number || row.id
    })),
    customFields: customFieldRows.map((row) => ({
      key: row.field_key,
      label: row.label || row.field_key
    }))
  }
}

/**
 * Aplica las acciones extra configuradas al cumplir el objetivo:
 * agregar/quitar etiqueta y cambiar campos personalizados del contacto.
 */
export async function applyAgentSuccessExtras(agent, contactId, {
  eventId = '',
  strict = false
} = {}) {
  const extras = normalizeSuccessExtras(agent?.successExtras)
  if (!extras.length || !contactId) return []

  const applied = []
  const failures = []
  for (const extra of extras) {
    try {
      if (extra.type === 'add_tag' || extra.type === 'remove_tag') {
        // extra.tag puede ser un ID del catálogo (configs nuevas) o un nombre
        // (configs viejas); se resuelve a ID y se guarda siempre el ID.
        let tagId = ''
        if (extra.tagId) {
          const storedTag = await db.get('SELECT id FROM contact_tags WHERE id = ?', [extra.tagId])
          if (storedTag?.id) {
            tagId = storedTag.id
          } else if (extra.type === 'add_tag') {
            [tagId] = await resolveTagIds([extra.tagName || extra.tag], { createMissing: true })
          } else {
            // Una etiqueta borrada puede seguir en datos legacy del contacto;
            // quitar por el ID capturado mantiene el efecto original.
            tagId = extra.tagId
          }
        } else {
          [tagId] = await resolveTagIds([extra.tag], { createMissing: extra.type === 'add_tag' })
        }
        const row = await db.get('SELECT tags FROM contacts WHERE id = ?', [contactId])
        const tags = parseJsonField(row?.tags, [])
        const list = Array.isArray(tags) ? tags : []
        const next = extra.type === 'remove_tag'
          ? list.filter((candidate) => candidate !== tagId && normalizeMatchText(candidate) !== normalizeMatchText(extra.tag))
          : [...new Set([...list, tagId].filter(Boolean))]
        await db.run('UPDATE contacts SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [JSON.stringify(next), contactId])
        const [resolvedTagName] = tagId ? await tagNamesForIds([tagId]) : [extra.tagName || extra.tag]
        applied.push({ type: extra.type, tag: resolvedTagName || extra.tagName || extra.tag })
      } else if (extra.type === 'set_custom_field') {
        const row = await db.get('SELECT custom_fields FROM contacts WHERE id = ?', [contactId])
        const fields = parseJsonField(row?.custom_fields, {})
        const map = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {}
        map[extra.field] = extra.value
        await db.run('UPDATE contacts SET custom_fields = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [JSON.stringify(map), contactId])
        applied.push({ type: extra.type, field: extra.field, value: extra.value })
      }
    } catch (error) {
      logger.warn(`[Agente conversacional] No se pudo aplicar acción extra ${extra.type}: ${error.message}`)
      failures.push(error)
    }
  }

  if (strict && failures.length) {
    throw failures[0]
  }

  if (applied.length) {
    await recordConversationalAgentEvent({
      eventId,
      contactId,
      eventType: 'success_extras_applied',
      detail: { agentId: agent?.id || null, applied },
      throwOnError: strict
    })
  }
  return applied
}

export async function applyAgentCompletionAction(agent, contactId, {
  eventId = '',
  strict = false
} = {}) {
  if (!agent || !contactId) return null
  const workflow = normalizeAgentGoalWorkflow(agent.goalWorkflow)
  const completion = workflow.completion || DEFAULT_GOAL_WORKFLOW_CONFIG.completion
  if (completion.mode !== 'assign_user') return { mode: 'notify_only' }

  const configuredUserId = String(completion.userId || '').trim()
  if (!configuredUserId) return { mode: 'assign_user', skipped: true, reason: 'missing_user' }

  let user = null
  try {
    user = await db.get(
      `SELECT id, username, email, full_name, first_name, last_name, phone
       FROM users
       WHERE id = ? AND is_active = 1`,
      [configuredUserId]
    )
  } catch (error) {
    if (strict) throw error
  }

  const assignedUserId = String(user?.id || configuredUserId)
  const assignedUserName = String(
    user?.full_name ||
    [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
    user?.email ||
    user?.phone ||
    user?.username ||
    completion.userName ||
    ''
  ).trim().slice(0, 180)

  const row = await db.get('SELECT custom_fields FROM contacts WHERE id = ?', [contactId])
  const fields = parseJsonField(row?.custom_fields, {})
  const customFields = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {}
  customFields.assignedUser = assignedUserId
  if (assignedUserName) customFields.assignedUserName = assignedUserName

  await db.run(`UPDATE contacts SET custom_fields = ${process.env.DATABASE_URL ? '?::jsonb' : '?'}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
    JSON.stringify(customFields),
    contactId
  ])

  await recordConversationalAgentEvent({
    eventId,
    contactId,
    eventType: 'completion_user_assigned',
    detail: {
      agentId: agent.id || null,
      assignedUserId,
      assignedUserName: assignedUserName || null
    },
    throwOnError: strict
  })

  return { mode: 'assign_user', userId: assignedUserId, userName: assignedUserName || null }
}

const COMPLETION_NOTIFICATION_DEDUP_MS = 10 * 60 * 1000

async function notifyConversationalCompletion({
  contactId,
  reason = '',
  summary = '',
  signal = 'ready_for_human',
  eventId = '',
  throwOnFailure = false
} = {}) {
  if (!contactId) return { sent: 0, skipped: true, reason: 'missing_contact' }
  // [Fase 1 — nunca fantasma] Idempotencia: como ahora una conversación cumplida se reabre
  // para seguir contestando (ver shouldReopenCompletedConversationState), el modelo podría
  // volver a marcar el objetivo en un follow-up. No re-avisamos a un humano si ya le avisamos
  // de este contacto hace poco. Cutoff en JS + comparación de string para que sirva igual en
  // SQLite (dev) y Postgres (clientes).
  const since = new Date(Date.now() - COMPLETION_NOTIFICATION_DEDUP_MS).toISOString().slice(0, 19).replace('T', ' ')
  let recentNotification = null
  try {
    recentNotification = await db.get(
      `SELECT id FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'priority_push_notification' AND created_at > ?
       ORDER BY created_at DESC LIMIT 1`,
      [contactId, since]
    )
  } catch (error) {
    if (throwOnFailure) {
      error.notificationDeliveryAttempted = false
      throw error
    }
  }
  if (recentNotification) {
    try {
      await recordConversationalAgentEvent({
        eventId: eventId ? `${eventId}_deduped` : '',
        contactId,
        eventType: 'priority_push_notification_deduped',
        detail: { signal, reason: 'recent_notification_within_window', windowMs: COMPLETION_NOTIFICATION_DEDUP_MS },
        throwOnError: throwOnFailure
      })
    } catch (error) {
      error.notificationDeliveryAttempted = false
      throw error
    }
    return { sent: 0, skipped: true, reason: 'deduped_recent_notification' }
  }
  let deliveryAttempted = false
  try {
    const { sendConversationalAgentPriorityNotification } = await import('./pushNotificationsService.js')
    deliveryAttempted = true
    const result = await sendConversationalAgentPriorityNotification({ contactId, reason, summary, signal })
    await recordConversationalAgentEvent({
      eventId,
      contactId,
      eventType: 'priority_push_notification',
      detail: { signal, sent: result?.sent || 0, skipped: Boolean(result?.skipped), reason: result?.reason || null },
      throwOnError: throwOnFailure
    })
    return result
  } catch (error) {
    await recordConversationalAgentEvent({
      eventId: eventId ? `${eventId}_failed` : '',
      contactId,
      eventType: 'priority_push_notification_failed',
      detail: { signal, error: error.message }
    })
    if (throwOnFailure) {
      error.notificationDeliveryAttempted = deliveryAttempted
      throw error
    }
    return { sent: 0, skipped: true, reason: error.message }
  }
}

function mapStateRow(row) {
  if (!row) return null
  const hasAgentEnabled = row.agent_enabled !== undefined && row.agent_enabled !== null
  const hasAgentHideAttendedNotifications = row.agent_hide_attended_notifications !== undefined ||
    row.agent_hide_attended !== undefined
  return {
    id: row.id || null,
    contactId: row.contact_id,
    status: row.status,
    pausedUntilAt: row.paused_until_at || null,
    signal: row.signal || null,
    signalReason: row.signal_reason || null,
    signalSummary: row.signal_summary || null,
    signalAt: row.signal_at || null,
    channel: row.channel || 'whatsapp',
    lastInboundMessageId: row.last_inbound_message_id || null,
    lastAnsweredInboundMessageId: row.last_answered_inbound_message_id || null,
    lastReplyAt: row.last_reply_at || null,
    inboundProcessingMessageId: row.inbound_processing_message_id || null,
    inboundProcessingStatus: row.inbound_processing_status || null,
    inboundProcessingClaimToken: row.inbound_processing_claim_token || null,
    inboundProcessingLeaseUntilAt: row.inbound_processing_lease_until_at || null,
    inboundProcessingStartedAt: row.inbound_processing_started_at || null,
    inboundProcessingAttemptCount: Math.max(0, Number(row.inbound_processing_attempt_count) || 0),
    inboundProcessingLastError: row.inbound_processing_last_error || null,
    followUpBaseMessageId: row.follow_up_base_message_id || null,
    followUpSentCount: Math.max(0, Number(row.follow_up_sent_count) || 0),
    followUpLastSentAt: row.follow_up_last_sent_at || null,
    activatedAt: row.activated_at || null,
    activationSource: row.activation_source || null,
    activatedBy: row.activated_by || null,
    assignmentSource: row.assignment_source || null,
    assignedAt: row.assigned_at || null,
    assignedBy: row.assigned_by || null,
    updatedBy: row.updated_by || null,
    agentId: row.agent_id || null,
    agentName: row.agent_name || null,
    agentCreatedAt: row.agent_created_at || null,
    agentEnabled: hasAgentEnabled ? toBoolean(row.agent_enabled) : null,
    agentHideAttendedNotifications: hasAgentHideAttendedNotifications
      ? (toBoolean(row.agent_hide_attended_notifications) || toBoolean(row.agent_hide_attended))
      : null,
    closingContext: normalizeStoredAdvancedClosingContext(row.closing_context_json || '{}'),
    intelligence: normalizeConversationIntelligenceState(parseJsonField(row.intelligence_state_json, {}), {
      objective: row.agent_objective || 'custom',
      channel: row.channel || 'whatsapp'
    }),
    intelligencePolicyHash: row.intelligence_policy_hash || null,
    intelligenceSource: row.intelligence_source || null,
    intelligenceUpdatedAt: row.intelligence_updated_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

function normalizeConversationStateAgentId(agentId) {
  const clean = String(agentId || '').trim()
  return clean || null
}

function normalizeConversationStateChannel(channel, fallback = 'whatsapp') {
  const raw = String(channel || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!raw) return fallback
  return CONVERSATION_STATE_CHANNEL_ALIASES.get(raw) || raw
}

function normalizeOptionalConversationStateChannel(channel) {
  if (channel === null || channel === undefined || String(channel).trim() === '') {
    const contextualChannel = conversationStateChannelContext.getStore()?.channel
    return contextualChannel ? normalizeConversationStateChannel(contextualChannel) : null
  }
  return normalizeConversationStateChannel(channel)
}

export function runWithConversationStateChannel(channel, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('runWithConversationStateChannel requiere una función')
  }
  return conversationStateChannelContext.run({
    channel: normalizeConversationStateChannel(channel)
  }, callback)
}

function conversationStateSortSql() {
  return `
    CASE
      WHEN s.status = 'active' AND COALESCE(s.agent_id, '') <> '' THEN 0
      WHEN s.signal IS NOT NULL AND s.signal <> '' THEN 1
      WHEN COALESCE(s.agent_id, '') <> '' THEN 2
      ELSE 3
    END ASC,
    COALESCE(s.signal_at, s.activated_at, s.last_reply_at, s.updated_at, s.created_at) DESC
  `
}

async function loadConversationStateRow(contactId, { agentId = null, channel = null } = {}) {
  if (!contactId) return null
  const cleanAgentId = normalizeConversationStateAgentId(agentId)
  const cleanChannel = normalizeOptionalConversationStateChannel(channel)
  const channelFilter = cleanChannel
    ? " AND COALESCE(NULLIF(s.channel, ''), 'whatsapp') = ?"
    : ''
  if (cleanAgentId) {
    return db.get(`
      SELECT s.*, a.name AS agent_name, a.enabled AS agent_enabled,
             a.created_at AS agent_created_at,
             a.hide_attended AS agent_hide_attended,
             a.hide_attended_notifications AS agent_hide_attended_notifications
      FROM conversational_agent_state s
      LEFT JOIN conversational_agents a ON a.id = s.agent_id
      WHERE s.contact_id = ? AND s.agent_id = ?${channelFilter}
      LIMIT 1
    `, [contactId, cleanAgentId, ...(cleanChannel ? [cleanChannel] : [])])
  }

  return db.get(`
    SELECT s.*, a.name AS agent_name, a.enabled AS agent_enabled,
           a.created_at AS agent_created_at,
           a.hide_attended AS agent_hide_attended,
           a.hide_attended_notifications AS agent_hide_attended_notifications
    FROM conversational_agent_state s
    LEFT JOIN conversational_agents a ON a.id = s.agent_id
    WHERE s.contact_id = ?${channelFilter}
    ORDER BY ${conversationStateSortSql()}
    LIMIT 1
  `, [contactId, ...(cleanChannel ? [cleanChannel] : [])])
}

async function loadConversationStateRowById(stateId) {
  if (!stateId) return null
  return db.get(`
    SELECT s.*, a.name AS agent_name, a.enabled AS agent_enabled,
           a.created_at AS agent_created_at,
           a.hide_attended AS agent_hide_attended,
           a.hide_attended_notifications AS agent_hide_attended_notifications
    FROM conversational_agent_state s
    LEFT JOIN conversational_agents a ON a.id = s.agent_id
    WHERE s.id = ?
    LIMIT 1
  `, [stateId])
}

function normalizeConversationActivationSource(source = '', updatedBy = 'system') {
  const cleanSource = String(source || '').trim().toLowerCase()
  if (cleanSource === 'manual' || cleanSource === 'automatic') return cleanSource
  const actor = String(updatedBy || '').trim().toLowerCase()
  if (actor === 'user' || actor === 'human' || actor === 'manual') return 'manual'
  return 'automatic'
}

function shouldMarkConversationActivated({ status = '', updatedBy = 'system', activationSource = '' } = {}) {
  if (activationSource) return true
  const actor = String(updatedBy || '').trim().toLowerCase()
  if (actor === 'user' || actor === 'human' || actor === 'agent' || actor === 'manual') return true
  return status && status !== 'active'
}

function appendActivationAssignments(assignments, params, { activationSource = '', updatedBy = 'system' } = {}) {
  assignments.push(
    'activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP)',
    'activation_source = COALESCE(activation_source, ?)',
    'activated_by = COALESCE(activated_by, ?)'
  )
  params.push(
    normalizeConversationActivationSource(activationSource, updatedBy),
    String(updatedBy || 'system').trim() || 'system'
  )
}

function normalizePauseUntilAt(value) {
  if (!value) return new Date(Date.now() + CONVERSATION_PAUSE_DURATION_MS).toISOString()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return new Date(Date.now() + CONVERSATION_PAUSE_DURATION_MS).toISOString()
  return date.toISOString()
}

function isExpiredPausedStateRow(row, nowMs = Date.now()) {
  if (!row || row.status !== 'paused' || !row.paused_until_at) return false
  const pauseUntilMs = Date.parse(row.paused_until_at)
  return Number.isFinite(pauseUntilMs) && pauseUntilMs <= nowMs
}

async function activateExpiredPause(row) {
  if (!row?.id) return
  await db.run(`
    UPDATE conversational_agent_state
    SET status = 'active',
        paused_until_at = NULL,
        updated_by = 'system',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = 'paused'
  `, [row.id])

  await recordConversationalAgentEvent({
    contactId: row.contact_id,
    eventType: 'status_changed',
    detail: { status: 'active', updatedBy: 'system', reason: 'pause_expired', agentId: row.agent_id || null }
  })
}

async function expirePausedConversationStates() {
  const nowIso = new Date().toISOString()
  const rows = await db.all(`
    SELECT id, contact_id, agent_id
    FROM conversational_agent_state
    WHERE status = 'paused'
      AND paused_until_at IS NOT NULL
      AND paused_until_at <= ?
    LIMIT 500
  `, [nowIso]).catch(() => [])
  if (!rows.length) return 0
  const stateIds = rows.map((row) => row.id).filter(Boolean)
  if (!stateIds.length) return 0
  const placeholders = stateIds.map(() => '?').join(', ')

  await db.run(`
    UPDATE conversational_agent_state
    SET status = 'active',
        paused_until_at = NULL,
        updated_by = 'system',
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'paused'
      AND id IN (${placeholders})
  `, stateIds)

  await Promise.all(rows.map((row) => recordConversationalAgentEvent({
    contactId: row.contact_id,
    eventType: 'status_changed',
    detail: { status: 'active', updatedBy: 'system', reason: 'pause_expired', agentId: row.agent_id || null }
  }).catch(() => undefined)))

  return stateIds.length
}

export async function assignAgentToConversation(contactId, agentId, {
  activationSource = 'automatic',
  assignmentSource = activationSource,
  updatedBy = 'system',
  channel = null
} = {}) {
  const cleanAgentId = normalizeConversationStateAgentId(agentId)
  const cleanChannel = normalizeOptionalConversationStateChannel(channel)
  if (cleanAgentId) {
    const state = await ensureConversationState(contactId, { agentId: cleanAgentId, channel: cleanChannel })
    const cleanAssignmentSource = normalizeConversationActivationSource(assignmentSource, updatedBy)
    const assignments = [
      'agent_id = ?',
      "status = 'active'",
      'paused_until_at = NULL',
      'assignment_source = ?',
      'assigned_at = CURRENT_TIMESTAMP',
      'assigned_by = ?',
      'updated_by = ?'
    ]
    const params = [cleanAgentId, cleanAssignmentSource, String(updatedBy || 'system').trim() || 'system', updatedBy]
    if (cleanChannel) {
      assignments.push('channel = ?')
      params.push(cleanChannel)
    }
    appendActivationAssignments(assignments, params, { activationSource, updatedBy })
    assignments.push('updated_at = CURRENT_TIMESTAMP')
    params.push(state.id)
    await db.run(`
      UPDATE conversational_agent_state
      SET ${assignments.join(', ')}
      WHERE id = ?
    `, params)
    return getConversationState(contactId, { agentId: cleanAgentId, channel: cleanChannel })
  }

  const state = await getConversationState(contactId, { channel: cleanChannel })
  if (!state?.id) return null
  await db.run(`
    UPDATE conversational_agent_state
    SET agent_id = NULL,
        assignment_source = 'released',
        assigned_by = ?,
        updated_by = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [String(updatedBy || 'system').trim() || 'system', updatedBy, state.id])
  return getConversationState(contactId, { channel: cleanChannel })
}

export async function releaseAgentFromConversation(contactId, agentId, { updatedBy = 'agent', channel = null } = {}) {
  const cleanAgentId = normalizeConversationStateAgentId(agentId)
  const cleanChannel = normalizeOptionalConversationStateChannel(channel)
  if (!contactId || !cleanAgentId) return null
  const state = await getConversationState(contactId, { agentId: cleanAgentId, channel: cleanChannel })
  if (!state?.id) return null

  await db.run(`
    UPDATE conversational_agent_state
    SET agent_id = NULL,
        assignment_source = 'released',
        assigned_by = ?,
        updated_by = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [String(updatedBy || 'agent').trim() || 'agent', updatedBy, state.id])

  return getConversationState(contactId, { channel: cleanChannel })
}

export async function getConversationState(contactId, { agentId = null, channel = null } = {}) {
  if (!contactId) return null
  const row = await loadConversationStateRow(contactId, { agentId, channel })
  if (isExpiredPausedStateRow(row)) {
    await activateExpiredPause(row)
    const nextRow = await loadConversationStateRowById(row.id)
    return mapStateRow(nextRow)
  }
  return mapStateRow(row)
}

export async function listConversationStatesForContact(contactId, { channel = null } = {}) {
  if (!contactId) return []
  await expirePausedConversationStates()
  const cleanChannel = normalizeOptionalConversationStateChannel(channel)
  const channelFilter = cleanChannel
    ? " AND COALESCE(NULLIF(s.channel, ''), 'whatsapp') = ?"
    : ''
  const rows = await db.all(`
    SELECT s.*, a.name AS agent_name, a.enabled AS agent_enabled,
           a.created_at AS agent_created_at,
           a.hide_attended AS agent_hide_attended,
           a.hide_attended_notifications AS agent_hide_attended_notifications
    FROM conversational_agent_state s
    LEFT JOIN conversational_agents a ON a.id = s.agent_id
    WHERE s.contact_id = ?${channelFilter}
    ORDER BY ${conversationStateSortSql()}
  `, [contactId, ...(cleanChannel ? [cleanChannel] : [])]).catch(() => [])
  return rows.map(mapStateRow)
}

export async function updateConversationClosingContext(contactId, patch = {}, { updatedBy = 'agent', agentId = null } = {}) {
  if (!contactId) {
    return { context: normalizeAdvancedClosingContext(patch), changedKeys: Object.keys(normalizeAdvancedClosingContext(patch)) }
  }

  const state = await ensureConversationState(contactId, { agentId })
  const row = state?.id
    ? await db.get('SELECT closing_context_json FROM conversational_agent_state WHERE id = ?', [state.id])
    : null
  const { context, changedKeys } = mergeAdvancedClosingContext(row?.closing_context_json || '{}', patch, { updatedBy })

  if (!changedKeys.length) {
    return { context, changedKeys }
  }

  await db.run(`
    UPDATE conversational_agent_state
    SET closing_context_json = ?,
        activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP),
        activation_source = COALESCE(activation_source, ?),
        activated_by = COALESCE(activated_by, ?),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    JSON.stringify(context),
    normalizeConversationActivationSource('', updatedBy),
    String(updatedBy || 'agent').trim() || 'agent',
    state.id
  ])

  await recordConversationalAgentEvent({
    contactId,
    eventType: 'closing_context_updated',
    detail: { updatedBy, changedKeys, agentId: state.agentId || agentId || null }
  })

  return { context, changedKeys }
}

export async function ensureConversationState(contactId, { agentId = null, channel = null } = {}) {
  if (!contactId) return null
  const cleanAgentId = normalizeConversationStateAgentId(agentId)
  const cleanChannel = normalizeOptionalConversationStateChannel(channel)
  const stateChannel = cleanChannel || 'whatsapp'
  const existing = await getConversationState(contactId, { agentId: cleanAgentId, channel: cleanChannel })
  if (existing) return existing
  if (cleanAgentId) {
    const channelFilter = cleanChannel
      ? " AND COALESCE(NULLIF(s.channel, ''), 'whatsapp') = ?"
      : ''
    const claimableLegacyState = await db.get(`
      SELECT id, channel
      FROM conversational_agent_state s
      WHERE s.contact_id = ?
        AND s.agent_id IS NULL
        AND s.status = 'active'
        ${channelFilter}
      ORDER BY ${conversationStateSortSql()}
      LIMIT 1
    `, [contactId, ...(cleanChannel ? [cleanChannel] : [])]).catch(() => null)
    if (claimableLegacyState?.id) {
      const adoptedChannel = cleanChannel || normalizeConversationStateChannel(claimableLegacyState.channel)
      await db.run(`
        UPDATE conversational_agent_state
        SET agent_id = ?,
            channel = ?,
            assignment_source = COALESCE(assignment_source, 'legacy'),
            assigned_at = COALESCE(assigned_at, CURRENT_TIMESTAMP),
            assigned_by = COALESCE(assigned_by, 'system'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND agent_id IS NULL
      `, [cleanAgentId, adoptedChannel, claimableLegacyState.id])
      return getConversationState(contactId, { agentId: cleanAgentId, channel: cleanChannel })
    }
  }
  const id = `cas_${randomUUID()}`
  await db.run(`
    INSERT INTO conversational_agent_state (
      id, contact_id, agent_id, channel, status,
      assignment_source, assigned_at, assigned_by,
      activated_at, activation_source, activated_by
    )
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
  `, [
    id,
    contactId,
    cleanAgentId,
    stateChannel,
    cleanAgentId ? 'legacy' : null,
    null,
    cleanAgentId ? 'system' : null,
    null,
    null,
    null
  ]).catch(async (error) => {
    const duplicate = /unique|duplicate|constraint/i.test(String(error?.message || ''))
    if (!duplicate) throw error
  })
  return getConversationState(contactId, { agentId: cleanAgentId, channel: cleanChannel })
}

function dbMutationCount(result) {
  return Math.max(0, Number(result?.changes ?? result?.rowCount) || 0)
}

function processingLeaseIso({ nowMs = Date.now(), leaseMs = CONVERSATIONAL_INBOUND_PROCESSING_LEASE_MS } = {}) {
  const cleanNowMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
  const cleanLeaseMs = Math.max(1000, Number(leaseMs) || CONVERSATIONAL_INBOUND_PROCESSING_LEASE_MS)
  return {
    nowMs: cleanNowMs,
    nowIso: new Date(cleanNowMs).toISOString(),
    leaseUntilIso: new Date(cleanNowMs + cleanLeaseMs).toISOString()
  }
}

/**
 * Reclama un inbound con compare-and-set. Un claim vivo bloquea a otras
 * instancias; un claim fallido o con lease vencido puede tomarlo de nuevo.
 */
export async function claimConversationInboundMessage(contactId, messageId, {
  agentId = null,
  channel = 'whatsapp',
  nowMs = Date.now(),
  leaseMs = CONVERSATIONAL_INBOUND_PROCESSING_LEASE_MS,
  claimToken = `caic_${randomUUID()}`
} = {}) {
  const cleanMessageId = String(messageId || '').trim()
  const cleanAgentId = normalizeConversationStateAgentId(agentId)
  const cleanChannel = normalizeConversationStateChannel(channel)
  const cleanClaimToken = String(claimToken || '').trim() || `caic_${randomUUID()}`
  if (!contactId || !cleanMessageId || !cleanAgentId) {
    return { claimed: false, reason: 'missing_identity', claimToken: null, state: null }
  }

  const state = await ensureConversationState(contactId, { agentId: cleanAgentId, channel: cleanChannel })
  if (!state?.id) return { claimed: false, reason: 'missing_state', claimToken: null, state: null }
  const lease = processingLeaseIso({ nowMs, leaseMs })
  const result = await db.run(`
    UPDATE conversational_agent_state
    SET last_inbound_message_id = ?,
        inbound_processing_message_id = ?,
        inbound_processing_status = 'processing',
        inbound_processing_claim_token = ?,
        inbound_processing_lease_until_at = ?,
        inbound_processing_started_at = ?,
        inbound_processing_attempt_count = CASE
          WHEN inbound_processing_message_id = ?
            THEN COALESCE(inbound_processing_attempt_count, 0) + 1
          ELSE 1
        END,
        inbound_processing_last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = 'active'
      AND (signal IS NULL OR signal = '')
      AND (last_answered_inbound_message_id IS NULL OR last_answered_inbound_message_id <> ?)
      AND NOT (
        COALESCE(inbound_processing_message_id, '') = ?
        AND COALESCE(inbound_processing_status, '') = 'completed'
      )
      AND (
        inbound_processing_status IS NULL
        OR inbound_processing_status = ''
        OR inbound_processing_status = 'failed'
        OR (
          inbound_processing_status = 'processing'
          AND (
            inbound_processing_lease_until_at IS NULL
            OR inbound_processing_lease_until_at <= ?
          )
        )
        OR (
          inbound_processing_status = 'completed'
          AND (inbound_processing_message_id IS NULL OR inbound_processing_message_id <> ?)
        )
      )
  `, [
    cleanMessageId,
    cleanMessageId,
    cleanClaimToken,
    lease.leaseUntilIso,
    lease.nowIso,
    cleanMessageId,
    state.id,
    cleanMessageId,
    cleanMessageId,
    lease.nowIso,
    cleanMessageId
  ])

  const nextState = await getConversationState(contactId, { agentId: cleanAgentId, channel: cleanChannel })
  if (dbMutationCount(result) > 0) {
    return {
      claimed: true,
      reason: 'claimed',
      claimToken: cleanClaimToken,
      leaseUntilAt: lease.leaseUntilIso,
      state: nextState
    }
  }

  let reason = 'claim_conflict'
  if (!nextState || nextState.status !== 'active' || nextState.signal) reason = 'state_not_runnable'
  else if (nextState.lastAnsweredInboundMessageId === cleanMessageId) reason = 'already_answered'
  else if (
    nextState.inboundProcessingMessageId === cleanMessageId &&
    nextState.inboundProcessingStatus === 'completed'
  ) reason = 'already_completed'
  else if (nextState.inboundProcessingStatus === 'processing') {
    const leaseUntilMs = Date.parse(nextState.inboundProcessingLeaseUntilAt || '')
    if (Number.isFinite(leaseUntilMs) && leaseUntilMs > lease.nowMs) reason = 'lease_active'
  }

  return { claimed: false, reason, claimToken: null, state: nextState }
}

export async function completeConversationInboundMessage(contactId, messageId, {
  agentId = null,
  channel = 'whatsapp',
  claimToken = '',
  answered = false
} = {}) {
  const cleanMessageId = String(messageId || '').trim()
  const cleanClaimToken = String(claimToken || '').trim()
  const cleanAgentId = normalizeConversationStateAgentId(agentId)
  const cleanChannel = normalizeConversationStateChannel(channel)
  if (!contactId || !cleanMessageId || !cleanClaimToken || !cleanAgentId) {
    return { completed: false, state: null }
  }
  const state = await getConversationState(contactId, { agentId: cleanAgentId, channel: cleanChannel })
  if (!state?.id) return { completed: false, state: null }

  const replyAssignments = answered
    ? `,
        last_answered_inbound_message_id = ?,
        last_reply_at = CURRENT_TIMESTAMP,
        activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP),
        activation_source = COALESCE(activation_source, 'automatic'),
        activated_by = COALESCE(activated_by, 'agent')`
    : ''
  const params = answered ? [cleanMessageId] : []
  params.push(state.id, cleanMessageId, cleanClaimToken)
  const result = await db.run(`
    UPDATE conversational_agent_state
    SET inbound_processing_status = 'completed',
        inbound_processing_claim_token = NULL,
        inbound_processing_lease_until_at = NULL,
        inbound_processing_last_error = NULL${replyAssignments},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND inbound_processing_message_id = ?
      AND inbound_processing_claim_token = ?
      AND inbound_processing_status = 'processing'
  `, params)

  return {
    completed: dbMutationCount(result) > 0,
    state: await getConversationState(contactId, { agentId: cleanAgentId, channel: cleanChannel })
  }
}

export async function failConversationInboundMessage(contactId, messageId, {
  agentId = null,
  channel = 'whatsapp',
  claimToken = '',
  error = ''
} = {}) {
  const cleanMessageId = String(messageId || '').trim()
  const cleanClaimToken = String(claimToken || '').trim()
  const cleanAgentId = normalizeConversationStateAgentId(agentId)
  const cleanChannel = normalizeConversationStateChannel(channel)
  if (!contactId || !cleanMessageId || !cleanClaimToken || !cleanAgentId) {
    return { failed: false, state: null }
  }
  const state = await getConversationState(contactId, { agentId: cleanAgentId, channel: cleanChannel })
  if (!state?.id) return { failed: false, state: null }
  const cleanError = String(error || 'processing_failed').trim().slice(0, 2000) || 'processing_failed'
  const result = await db.run(`
    UPDATE conversational_agent_state
    SET inbound_processing_status = 'failed',
        inbound_processing_claim_token = NULL,
        inbound_processing_lease_until_at = NULL,
        inbound_processing_last_error = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND inbound_processing_message_id = ?
      AND inbound_processing_claim_token = ?
      AND inbound_processing_status = 'processing'
  `, [cleanError, state.id, cleanMessageId, cleanClaimToken])
  return {
    failed: dbMutationCount(result) > 0,
    state: await getConversationState(contactId, { agentId: cleanAgentId, channel: cleanChannel })
  }
}

export async function setConversationStatus(contactId, status, {
  updatedBy = 'system',
  clearSignal = false,
  pausedUntilAt = null,
  activationSource = '',
  agentId = null,
  channel = null
} = {}) {
  if (!VALID_STATUSES.has(status)) {
    throw Object.assign(new Error(`Estado de conversación inválido: ${status}`), { statusCode: 400 })
  }
  const cleanChannel = normalizeOptionalConversationStateChannel(channel)
  const state = await ensureConversationState(contactId, { agentId, channel: cleanChannel })
  if (!state?.id) return null
  const nextPausedUntilAt = status === 'paused' ? normalizePauseUntilAt(pausedUntilAt) : null
  const assignments = [
    'status = ?',
    'paused_until_at = ?',
    'updated_by = ?'
  ]
  const params = [status, nextPausedUntilAt, updatedBy]
  if (shouldMarkConversationActivated({ status, updatedBy, activationSource })) {
    appendActivationAssignments(assignments, params, { activationSource, updatedBy })
  }
  const cleanUpdatedBy = String(updatedBy || '').trim().toLowerCase()
  if (state.agentId && ['user', 'human', 'manual'].includes(cleanUpdatedBy)) {
    assignments.push(
      "assignment_source = 'manual'",
      'assigned_at = COALESCE(assigned_at, CURRENT_TIMESTAMP)',
      'assigned_by = ?'
    )
    params.push(String(updatedBy || 'user').trim() || 'user')
  }
  if (clearSignal) {
    assignments.push('signal = NULL', 'signal_reason = NULL', 'signal_summary = NULL', 'signal_at = NULL')
  }
  assignments.push('updated_at = CURRENT_TIMESTAMP')
  params.push(state.id)

  await db.run(`
    UPDATE conversational_agent_state
    SET ${assignments.join(', ')}
    WHERE id = ?
  `, params)

  await recordConversationalAgentEvent({
    contactId,
    eventType: 'status_changed',
    detail: { status, updatedBy, clearSignal, pausedUntilAt: nextPausedUntilAt, agentId: state.agentId || agentId || null }
  })

  return getConversationState(contactId, {
    agentId: state.agentId || agentId || null,
    channel: cleanChannel
  })
}

export async function setConversationSignal(contactId, signal, {
  reason = '',
  summary = '',
  status = 'completed',
  actionSummarySource = '',
  originalSummary = '',
  agentId = '',
  channel = null,
  eventId = '',
  strictEvent = false
} = {}) {
  const cleanChannel = normalizeOptionalConversationStateChannel(channel)
  const state = await ensureConversationState(contactId, { agentId, channel: cleanChannel })
  const currentState = state?.id
    ? await db.get('SELECT id, closing_context_json, channel, agent_id FROM conversational_agent_state WHERE id = ?', [state.id]).catch(() => null)
    : null
  const closingContext = normalizeStoredAdvancedClosingContext(currentState?.closing_context_json || '{}')
  const cleanStatus = String(status || 'completed').trim() || 'completed'
  const effectiveAgentId = String(agentId || currentState?.agent_id || '').trim() || null
  const objectiveCompleted = cleanStatus === 'completed' && Boolean(effectiveAgentId)
  const timezone = await getAccountTimezone().catch(() => DEFAULT_TIMEZONE)
  const completionSummary = await buildCompletionSummaryFromClosingContext({
    contactId,
    signal,
    summary,
    reason,
    actionSummarySource,
    closingContext,
    timezone,
    channel: currentState?.channel || 'whatsapp',
    allowInternalSummary: objectiveCompleted
  })
  const cleanReason = cleanCompletionDisplayText(reason)
  const cleanActionSummary = cleanCompletionDisplayText(completionSummary.actionSummary)
  const cleanSummary = cleanCompletionDisplayText(completionSummary.summary)
  const cleanStateSummary = cleanCompletionDisplayText(completionSummary.stateSummary || cleanSummary || cleanActionSummary)
  await db.run(`
    UPDATE conversational_agent_state
    SET signal = ?, signal_reason = ?, signal_summary = ?, signal_at = CURRENT_TIMESTAMP,
        status = ?, updated_by = 'agent',
        activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP),
        activation_source = COALESCE(activation_source, 'automatic'),
        activated_by = COALESCE(activated_by, 'agent'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [signal, cleanReason, cleanStateSummary, cleanStatus, currentState.id])

  const cleanOriginalSummary = cleanCompletionDisplayText(originalSummary || actionSummarySource)
  const detail = {
    signal,
    reason: cleanReason,
    summary: cleanSummary,
    actionSummary: cleanActionSummary,
    status: cleanStatus,
    summarySource: completionSummary.summarySource,
    agentId: effectiveAgentId,
    objectiveCompleted
  }
  if (cleanOriginalSummary && ![cleanSummary, cleanActionSummary, cleanStateSummary].includes(cleanOriginalSummary)) {
    detail.originalSummary = cleanOriginalSummary
  }

  await recordConversationalAgentEvent({
    eventId,
    contactId,
    eventType: 'signal_set',
    detail,
    throwOnError: strictEvent
  })

  return getConversationState(contactId, { agentId: effectiveAgentId, channel: cleanChannel })
}

export async function clearConversationSignal(contactId, { updatedBy = 'user', agentId = null, channel = null } = {}) {
  const cleanChannel = normalizeOptionalConversationStateChannel(channel)
  const state = await ensureConversationState(contactId, { agentId, channel: cleanChannel })
  if (!state?.id) return null
  // [Fase 0 — anti-ghosting] Al limpiar la señal, REACTIVAMOS el bot si había quedado
  // congelado por un cierre/pase automático (status 'completed' o 'human'). Antes se borraba
  // la señal pero el status seguía en terminal, así que el gate de arranque
  // (status !== 'active') mantenía al bot mudo para siempre aunque el staff limpiara la señal
  // (caso oQ9XMb9R: ~10 mensajes del paciente al vacío). No tocamos estados deliberados como
  // 'discarded', 'paused' o 'skipped'.
  const reactivated = state.status === 'completed' || state.status === 'human'
  await db.run(`
    UPDATE conversational_agent_state
    SET signal = NULL, signal_reason = NULL, signal_summary = NULL, signal_at = NULL,
        status = CASE WHEN status IN ('completed', 'human') THEN 'active' ELSE status END,
        updated_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [updatedBy, state.id])

  await recordConversationalAgentEvent({
    contactId,
    eventType: 'signal_cleared',
    detail: { updatedBy, agentId: state.agentId || agentId || null, reactivated }
  })

  return getConversationState(contactId, {
    agentId: state.agentId || agentId || null,
    channel: cleanChannel
  })
}

/**
 * Marca que un humano tomó la conversación (envío manual desde la app).
 * Solo cambia el estado si el agente la tenía activa, para no pisar
 * estados explícitos (skipped, discarded, etc.).
 */
export async function markHumanTakeoverIfActive(contactId, { updatedBy = 'human' } = {}) {
  if (!contactId) return null
  const config = await getConversationalAgentConfig()
  if (!config.enabled) return null
  const states = await listConversationStatesForContact(contactId)
  const activeStates = states.filter((state) => state.status === 'active')
  if (!activeStates.length) return states[0] || null
  logger.info(`[Agente conversacional] Humano tomó la conversación de ${contactId}; el agente deja de responder`)
  const updatedStates = []
  for (const state of activeStates) {
    updatedStates.push(await setConversationStatus(contactId, 'human', {
      updatedBy,
      agentId: state.agentId || null,
      channel: state.channel || 'whatsapp'
    }))
  }
  return updatedStates[0] || states[0] || null
}

export async function shouldSuppressChatNotificationForConversationalAgent(contactId) {
  if (!contactId) return false
  const config = await getConversationalAgentConfig()
  if (!config.enabled) return false
  const states = await listConversationStatesForContact(contactId)
  for (const state of states) {
    if (!state?.agentId || state.status !== 'active' || state.signal) continue
    if (state.agentEnabled !== null && state.agentHideAttendedNotifications !== null) {
      if (state.agentEnabled && state.agentHideAttendedNotifications) return true
      continue
    }
    const agent = await getConversationalAgent(state.agentId)
    if (agent?.enabled && agent.hideAttendedNotifications) return true
  }
  return false
}

function triggerLinkMatchesWorkflow(configured = {}, payload = {}) {
  const expectedId = String(configured.triggerLinkId || '').trim()
  const expectedPublicId = String(configured.triggerLinkPublicId || '').trim()
  const expectedName = normalizeMatchText(configured.triggerLinkName)
  const actualId = String(payload.triggerLinkId || payload.trigger_link_id || '').trim()
  const actualPublicId = String(payload.triggerLinkPublicId || payload.publicId || payload.public_id || '').trim()
  const actualName = normalizeMatchText(payload.triggerLinkName || payload.name)

  if (expectedId) return actualId === expectedId
  if (expectedPublicId) return actualPublicId === expectedPublicId
  if (expectedName) return Boolean(actualName && actualName === expectedName)
  return false
}

export async function handleConversationalAgentTriggerLinkClick(payload = {}) {
  const contactId = String(payload.contactId || payload.contact_id || payload.query?.contact_id || payload.query?.contactId || '').trim()
  if (!contactId) return { matched: false, reason: 'missing_contact' }

  const triggerSentEvent = await db.get(
    "SELECT detail_json FROM conversational_agent_events WHERE contact_id = ? AND event_type = 'trigger_link_sent' ORDER BY created_at DESC LIMIT 1",
    [contactId]
  ).catch(() => null)
  const triggerSentDetail = triggerSentEvent?.detail_json ? safeParse(triggerSentEvent.detail_json) : null
  const sentAgentId = String(triggerSentDetail?.agentId || triggerSentDetail?.agent_id || '').trim()

  const state = await getConversationState(contactId, { agentId: sentAgentId || null })
  if (!state?.agentId) return { matched: false, reason: 'missing_agent' }
  if (state.signal || !['active', 'paused'].includes(state.status)) {
    return { matched: false, reason: 'conversation_closed' }
  }

  const agent = await getConversationalAgent(state.agentId)
  if (!agent?.enabled || agent.successAction !== 'send_trigger_link') {
    return { matched: false, reason: 'agent_not_waiting_for_trigger_link' }
  }

  const configured = agent.goalWorkflow?.triggerLink || {}
  if (!triggerLinkMatchesWorkflow(configured, payload)) {
    return { matched: false, reason: 'trigger_link_mismatch' }
  }

  const triggerLinkName = configured.triggerLinkName || payload.triggerLinkName || 'Enlace de disparo'
  const sentTriggerId = String(triggerSentDetail?.triggerLinkId || '').trim()
  const sentTriggerPublicId = String(triggerSentDetail?.triggerLinkPublicId || '').trim()
  const matchesSentTrigger = (!sentTriggerId || !configured.triggerLinkId || sentTriggerId === configured.triggerLinkId)
    && (!sentTriggerPublicId || !configured.triggerLinkPublicId || sentTriggerPublicId === configured.triggerLinkPublicId)
  const conversationSummary = matchesSentTrigger
    ? cleanCompletionDisplayText(triggerSentDetail?.resumen || triggerSentDetail?.summary || '')
    : ''
  const nextState = await setConversationSignal(contactId, 'ready_for_human', {
    reason: `Tocó el enlace de disparo: ${triggerLinkName}`,
    summary: conversationSummary,
    status: 'completed',
    agentId: state.agentId || ''
  })
  await applyAgentCompletionAction(agent, contactId)
  await applyAgentSuccessExtras(agent, contactId)
  await notifyConversationalCompletion({
    contactId,
    reason: `Tocó el enlace de disparo: ${triggerLinkName}`,
    summary: conversationSummary || `Tocó el enlace de disparo: ${triggerLinkName}`,
    signal: 'ready_for_human'
  })
  await recordConversationalAgentEvent({
    contactId,
    eventType: 'trigger_link_goal_completed',
    detail: {
      agentId: agent.id,
      triggerLinkId: configured.triggerLinkId || payload.triggerLinkId || null,
      triggerLinkPublicId: configured.triggerLinkPublicId || payload.triggerLinkPublicId || null,
      eventId: payload.eventId || null
    }
  })

  return { matched: true, state: nextState, agentId: agent.id }
}

/**
 * Igual que markHumanTakeoverIfActive pero partiendo del teléfono destino
 * (los envíos manuales desde la app solo traen el número).
 */
export async function markHumanTakeoverByPhone(phone, { updatedBy = 'human' } = {}) {
  const digits = String(phone || '').replace(/\D/g, '')
  if (digits.length < 8) return null
  const suffix = digits.slice(-10)
  const contact = await db.get(
    "SELECT id FROM contacts WHERE phone LIKE ? ORDER BY updated_at DESC LIMIT 1",
    [`%${suffix}`]
  ).catch(() => null)
  if (!contact?.id) return null
  return markHumanTakeoverIfActive(contact.id, { updatedBy })
}

export async function listConversationStates({ signal = null, statuses = null } = {}) {
  await expirePausedConversationStates()

  const where = []
  const params = []
  if (signal) {
    where.push('s.signal = ?')
    params.push(signal)
  }
  if (Array.isArray(statuses) && statuses.length) {
    where.push(`s.status IN (${statuses.map(() => '?').join(', ')})`)
    params.push(...statuses)
  }

	  const rows = await db.all(`
	    SELECT s.*, c.full_name AS contact_name, c.phone AS contact_phone,
             a.name AS agent_name, a.enabled AS agent_enabled,
             a.hide_attended AS agent_hide_attended,
             a.hide_attended_notifications AS agent_hide_attended_notifications
	    FROM conversational_agent_state s
	    LEFT JOIN contacts c ON c.id = s.contact_id
	    LEFT JOIN conversational_agents a ON a.id = s.agent_id
	    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
	    ORDER BY COALESCE(s.signal_at, s.activated_at, s.updated_at) DESC
	    LIMIT 500
  `, params)

  return rows.map((row) => ({
    ...mapStateRow(row),
    contactName: row.contact_name || null,
    contactPhone: row.contact_phone || null
  }))
}

// (AI-005) ¿Ya ocurrió hace poco una acción del agente (mismo contacto + tipo de evento)?
// Permite que las acciones reales de envío sean idempotentes: si ya se hizo en la ventana,
// no se repite el efecto. Fecha en formato 'YYYY-MM-DD HH:MM:SS' para comparar bien en
// SQLite (texto) y Postgres (timestamp).
export async function hasRecentConversationalAgentEvent({ contactId = null, eventType, withinMs = 180000 } = {}) {
  if (!contactId || !eventType) return false
  try {
    const since = new Date(Date.now() - Math.max(1000, withinMs)).toISOString().slice(0, 19).replace('T', ' ')
    const row = await db.get(
      `SELECT id FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = ? AND created_at >= ?
       ORDER BY created_at DESC LIMIT 1`,
      [String(contactId), String(eventType), since]
    )
    return !!row?.id
  } catch {
    // Fail-open: ante cualquier problema, no bloqueamos la acción.
    return false
  }
}

export async function recordConversationalAgentEvent({
  eventId = '',
  contactId = null,
  eventType,
  detail = null,
  throwOnError = false
}) {
  try {
    const detailJson = detail ? JSON.stringify(detail) : null
    const storedDetailJson = eventType === 'signal_set' ? detailJson : detailJson?.slice(0, 4000)
    const agentId = String(detail?.agentId || detail?.agent_id || '').trim() || null
    const cleanEventId = String(eventId || '').trim().slice(0, 180) || `cae_${randomUUID()}`
    await db.run(`
      INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `, [cleanEventId, contactId, agentId, eventType, storedDetailJson || null])
  } catch (error) {
    logger.warn(`[Agente conversacional] No se pudo registrar evento ${eventType}: ${error.message}`)
    if (throwOnError) throw error
  }
}

const CONVERSATIONAL_AGENT_COMPLETION_SIGNALS = new Set([
  'ready_for_human',
  'ready_to_schedule',
  'ready_to_buy',
  'appointment_booked',
  'purchase_completed'
])

function isCompletionSignalEvent(row) {
  if (row?.event_type !== 'signal_set') return false
  const detail = row.detail_json ? safeParse(row.detail_json) : null
  if (!detail || typeof detail !== 'object') return false
  const signal = String(detail.signal || '').trim()
  if (!CONVERSATIONAL_AGENT_COMPLETION_SIGNALS.has(signal)) return false

  const status = String(detail.status || '').trim()
  const agentId = String(detail.agentId || detail.agent_id || '').trim()
  const objectiveCompleted = detail.objectiveCompleted === true
  return status === 'completed' && Boolean(agentId) && objectiveCompleted
}

function mapConversationalAgentEventRow(row) {
  return {
    id: row.id,
    contactId: row.contact_id,
    eventType: row.event_type,
    detail: row.detail_json ? safeParse(row.detail_json) : null,
    createdAt: row.created_at
  }
}

export async function listConversationalAgentEvents({ contactId = null, limit = 100, kind = null } = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500)
  const params = []
  const where = []
  if (contactId) {
    where.push('contact_id = ?')
    params.push(contactId)
  }
  if (kind === 'completion') {
    where.push("event_type = 'signal_set'")
  }

  let sql = 'SELECT * FROM conversational_agent_events'
  if (where.length) {
    sql += ` WHERE ${where.join(' AND ')}`
  }
  sql += ' ORDER BY created_at DESC LIMIT ?'
  params.push(kind === 'completion' ? Math.min(normalizedLimit * 4, 500) : normalizedLimit)

  const rows = await db.all(sql, params)
  const filteredRows = kind === 'completion' ? rows.filter(isCompletionSignalEvent).slice(0, normalizedLimit) : rows
  return filteredRows.map(mapConversationalAgentEventRow)
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
