import { createHash, randomUUID, timingSafeEqual } from 'crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { databaseDialect, db } from '../config/database.js'
import { PUBLIC_URL } from '../config/constants.js'
import { logger } from '../utils/logger.js'
import { DEFAULT_TIMEZONE, getAccountTimezone } from '../utils/dateUtils.js'
import { getAccountCurrency } from '../utils/accountLocale.js'
import { coalescedTimestampSortExpression } from '../utils/sqlTimestampSort.js'
import { buildTagMatchKeys } from './contactTagsService.js'
import {
  DEFAULT_CONVERSATIONAL_AI_PROVIDER,
  getDefaultConversationalModelForProvider,
  normalizeConversationalAIProvider
} from './conversationalAIProviderService.js'
import { getConversationalAgentMaxAgents } from './licenseService.js'
import {
  conversationalPaymentRequestHash,
  getHighLevelPaymentLinkMode,
  recoverProcessingConversationalPaymentRequest
} from './paymentFlowService.js'
import {
  buildConversationalCapabilityManifest,
  buildLegacyConversationalEditableText,
  getConversationalCapabilitiesConfig,
  getEnabledConversationalCapabilities,
  getConversationalNativeRuntimeValidationErrors,
  getConversationalPromptConfig,
  normalizeConversationalCapabilitiesConfig,
  normalizeConversationalPromptConfig
} from '../agents/conversational/nativeRuntimeConfig.js'
import { getPaymentGateCheckoutKeys } from './publicPaymentGateService.js'
import { withConversationalAgentTestMutationLock } from './conversationalAgentTestMutationLockService.js'
import { CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT } from './conversationalAppointmentPreviewOfferService.js'
import { loadConversationalAgentMetricAggregates } from './conversationalAgentMetricsProjectionService.js'
import { isHighLevelConnected } from './integrationConnectionStateService.js'
import { msiEligibility } from '../../../shared/sites/paymentGateContract.js'

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
 *
 * Señales internas (signal): ready_for_human | ready_to_schedule |
 * ready_to_buy | appointment_booked | purchase_completed
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

// Alcance de contactos ("¿A quién puede atender?"):
// - 'all' = todos los mensajes nuevos desde ahora, sin importar cuándo nació el
//   contacto (comportamiento histórico).
// - 'new_only' = solo contactos CREADOS a partir del corte (leads nuevos).
// - 'existing_only' = solo contactos que YA existían antes del corte (la base
//   actual; útil para agentes de reactivación/recuperación).
// El corte se sella al configurar el alcance y se re-sella al cambiar de alcance.
const SCOPED_CONTACT_SCOPES = new Set(['new_only', 'existing_only'])
const DEFAULT_CONTACT_SCOPE = 'new_only'

export function normalizeContactScope(value) {
  const scope = String(value || '').trim().toLowerCase()
  return SCOPED_CONTACT_SCOPES.has(scope) ? scope : 'all'
}

export function buildNewContactScopeCutoffAt({ referenceDate = new Date() } = {}) {
  const date = referenceDate instanceof Date ? referenceDate : new Date(referenceDate)
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString()
}

const DEFAULT_SUCCESS_ACTION = 'ready_for_human'
const VALID_STATUSES = new Set(['active', 'paused', 'human', 'skipped', 'completed'])
const CONVERSATION_PAUSE_DURATION_MS = 24 * 60 * 60 * 1000
export const CONVERSATIONAL_INBOUND_PROCESSING_LEASE_MS = 10 * 60 * 1000
export const CONVERSATIONAL_REPLY_DELIVERY_EVENT_TYPE = 'reply_delivery_plan_v1'
export const CONVERSATIONAL_REPLY_DELIVERY_LEASE_MS = 10 * 60 * 1000
export const CONVERSATIONAL_REPLY_DELIVERY_MAX_DETAIL_BYTES = 32 * 1024
const CONVERSATIONAL_REPLY_PREVENTIVE_INTERRUPTION_ID = 'preventive_measure'
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

export async function getConversationalAgentConfig() {
  return {
    aiProvider: DEFAULT_CONVERSATIONAL_AI_PROVIDER,
    model: DEFAULT_CONVERSATIONAL_AGENT_MODEL,
    updatedAt: null
  }
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

function cleanCompletionDisplayText(value = '') {
  if (value === null || value === undefined) return ''
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return raw.replace(/\s+/g, ' ').trim()
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

function buildCompletionActionSummary({ signal, summary = '', reason = '', timezone = DEFAULT_TIMEZONE } = {}) {
  const cleanSignal = String(signal || '').trim()
  const baseSummary = cleanCompletionDisplayText(summary).slice(0, 500)
  const baseReason = cleanCompletionDisplayText(reason).slice(0, 280)

  if (cleanSignal === 'appointment_booked') {
    const humanDate = formatHumanDateTimeFromSummary(baseSummary, timezone)
    if (humanDate) return `Agendó cita para ${humanDate}`
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
  signal,
  summary = '',
  reason = '',
  actionSummarySource = '',
  timezone = DEFAULT_TIMEZONE
} = {}) {
  const cleanSignal = String(signal || '').trim()
  const baseSummary = cleanCompletionDisplayText(summary)
  const baseReason = cleanCompletionDisplayText(reason)
  const actionSource = cleanCompletionDisplayText(actionSummarySource) || baseSummary
  const actionSummary = buildCompletionActionSummary({ signal, summary: actionSource, reason: baseReason, timezone })
  const hidesMissingSummary = ['appointment_booked', 'purchase_completed'].includes(cleanSignal)
  const summaryText = baseSummary || (hidesMissingSummary ? '' : baseReason)
  const stateSummary = [
    actionSummary,
    summaryText && summaryText !== actionSummary ? `Resumen: ${summaryText}` : ''
  ].filter(Boolean).join('\n')

  return {
    actionSummary,
    summary: summaryText,
    summarySource: baseSummary ? 'tool_fallback' : (summaryText ? 'reason_fallback' : 'empty'),
    stateSummary: stateSummary || actionSummary || summaryText
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
  if (!CONDITION_SCHEMA[category] || !Array.isArray(condition.params)) return null

  const sourceParams = condition.params
  const params = sourceParams
    .map((param) => normalizeParam(category, param))
    .filter(Boolean)
    .slice(0, 10)

  // Nunca conviertas una condición vieja o inválida en una regla vacía más
  // amplia. Por ejemplo, al retirar los filtros por texto del mensaje, un
  // antiguo `message.text contains ...` debe desaparecer completo; si quedara
  // como `message` sin parámetros empataría cualquier mensaje.
  if (sourceParams.length > 0 && params.length === 0) return null

  return { category, params }
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

function normalizeAgentFilters(input) {
  const raw = input && typeof input === 'object' ? input : {}
  return {
    entry: { groups: normalizeGroups(raw.entry?.groups) },
    exit: { groups: normalizeGroups(raw.exit?.groups) }
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
    currency: '',
    methods: {
      paymentLink: true,
      bankTransfer: false
    },
    bankTransferDetails: ''
  },
  completion: {
    mode: 'notify_only',
    userId: '',
    userName: ''
  },
  attention: {
    // Clientes existentes (con historial o que dicen serlo) van directo con
    // un humano en cuanto el agente los detecta.
    pastClientsToHuman: false
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
      currency: String(deposit.currency || sales.currency || DEFAULT_GOAL_WORKFLOW_CONFIG.deposit.currency).trim().slice(0, 12).toUpperCase(),
      methods: (() => {
        const methods = deposit.methods && typeof deposit.methods === 'object' ? deposit.methods : {}
        return {
          // paymentLink default true para no cambiar el comportamiento de configs previas.
          paymentLink: methods.paymentLink === undefined ? true : toBoolean(methods.paymentLink),
          bankTransfer: toBoolean(methods.bankTransfer)
        }
      })(),
      bankTransferDetails: String(deposit.bankTransferDetails || '').trim().slice(0, 1200)
    },
    completion: {
      mode: normalizeCompletionMode(completion.mode, DEFAULT_GOAL_WORKFLOW_CONFIG.completion.mode),
      userId: String(completion.userId || completion.user_id || '').trim().slice(0, 120),
      userName: String(completion.userName || completion.user_name || '').trim().slice(0, 180)
    },
    attention: {
      pastClientsToHuman: toBoolean(
        (raw.attention && typeof raw.attention === 'object' ? raw.attention : {}).pastClientsToHuman ??
        (raw.attention && typeof raw.attention === 'object' ? raw.attention : {}).past_clients_to_human
      )
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
    const capabilities = getConversationalCapabilitiesConfig(agent)
    if (objective === 'citas') {
      const schedule = capabilities.items.find((item) => item.id === 'schedule_appointment' && item.enabled)
      configuredExpected = { calendarId: schedule?.calendarId || '' }
    } else if (objective === 'ventas') {
      const payment = capabilities.items.find((item) => item.id === 'collect_payment' && item.enabled)
      configuredExpected = {
        productId: payment?.productId,
        priceId: payment?.priceId,
        amount: payment?.amount,
        currency: payment?.currency || await getAccountCurrency()
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
      row.completion_action_applied_at = await markConversationGoalEffectApplied(
        cleanGoalId,
        claimToken,
        'completion_action_applied_at'
      )
    }

    if (!row.completion_extras_applied_at) {
      await renewConversationGoalEffectsLease(cleanGoalId, claimToken)
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

  const nextMetadata = {
    ...previousMetadata,
    confirmation: cleanMetadata,
    receivedReference
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

const VERIFIED_CONVERSATIONAL_PAYMENT_STATUSES = new Set([
  'paid',
  'succeeded',
  'completed',
  'complete',
  'fulfilled',
  'success',
  'captured',
  'approved',
  'accredited',
  'settled'
])
const CONVERSATIONAL_PAYMENT_RECONCILIATION_EVENT = 'payment_reconciliation_v2'
const CONVERSATIONAL_PAYMENT_RECONCILIATION_LEASE_MS = 10 * 60 * 1000
const CONVERSATIONAL_APPOINTMENT_DEPOSIT_RESERVATION_LEASE_MS = 10 * 60 * 1000
let conversationalPaymentResumeHandlerForTest = null
let conversationalPaymentAfterStateInspectionHookForTest = null
let conversationalPaymentTerminalReplyHandlerForTest = null
let conversationalPriorityNotificationSenderForTest = null

export function setConversationalPaymentResumeHandlerForTest(handler) {
  conversationalPaymentResumeHandlerForTest = typeof handler === 'function' ? handler : null
}

export function setConversationalPaymentAfterStateInspectionHookForTest(handler) {
  conversationalPaymentAfterStateInspectionHookForTest = typeof handler === 'function' ? handler : null
}

export function setConversationalPaymentTerminalReplyHandlerForTest(handler) {
  conversationalPaymentTerminalReplyHandlerForTest = typeof handler === 'function' ? handler : null
}

export function setConversationalPriorityNotificationSenderForTest(sender) {
  conversationalPriorityNotificationSenderForTest = typeof sender === 'function' ? sender : null
}

function normalizeVerifiedPaymentStatus(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function normalizeVerifiedPaymentEnvironment(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (['live', 'production', 'prod'].includes(normalized)) return 'live'
  if (['test', 'testing', 'sandbox', 'demo'].includes(normalized)) return 'test'
  return ''
}

function normalizeVerifiedCurrency(value) {
  const currency = String(value || '').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(currency) ? currency : ''
}

function normalizeAppointmentTerminalBinding(value = {}) {
  const bookingOwner = String(value?.bookingOwner || '').trim().toLowerCase()
  const terminalToolName = String(value?.terminalToolName || '').trim()
  const expectedToolName = bookingOwner === 'human'
    ? 'request_human_booking'
    : bookingOwner === 'ai'
      ? 'book_appointment'
      : ''
  return expectedToolName && terminalToolName === expectedToolName
    ? { bookingOwner, terminalToolName }
    : null
}

async function inspectAppointmentDepositSourceBinding({
  sourceEvent,
  sourceDetail = {},
  contactId = '',
  agentId = ''
} = {}) {
  const selectionEventId = String(sourceDetail.appointmentSelectionEventId || '').trim()
  const sourceTerminal = normalizeAppointmentTerminalBinding({
    bookingOwner: sourceDetail.appointmentSelectionBookingOwner,
    terminalToolName: sourceDetail.appointmentSelectionTerminalToolName
  })
  if (
    !selectionEventId ||
    !String(sourceDetail.appointmentSelectionCalendarId || '').trim() ||
    !String(sourceDetail.appointmentSelectionStartTime || '').trim() ||
    !String(sourceDetail.appointmentSelectionVerifiedAt || '').trim() ||
    !String(sourceDetail.appointmentSelectionRequestDraftHash || '').trim() ||
    !sourceTerminal
  ) {
    return { ok: false, reason: 'appointment_source_binding_missing' }
  }
  const selection = await db.get(
    `SELECT id, contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?`,
    [selectionEventId]
  )
  const detail = parseJsonField(selection?.detail_json, {})
  const draft = detail.appointmentRequestDraft
  const draftValid = draft && typeof draft === 'object' && !Array.isArray(draft)
  const draftHash = draftValid
    ? createHash('sha256').update(JSON.stringify(draft)).digest('hex')
    : ''
  const selectionTerminal = normalizeAppointmentTerminalBinding(detail)
  const valid = Boolean(
    ['payment_link_created', 'payment_link_reused', 'deposit_transfer_pending_review'].includes(sourceEvent?.event_type) &&
    String(sourceEvent?.contact_id || '') === String(contactId || '').trim() &&
    String(sourceEvent?.agent_id || '') === String(agentId || '').trim() &&
    selection?.event_type === 'appointment_slot_selection_verified' &&
    String(selection?.contact_id || '') === String(contactId || '').trim() &&
    String(selection?.agent_id || '') === String(agentId || '').trim() &&
    String(detail.status || '') === 'active' &&
    String(detail.calendarId || '') === String(sourceDetail.appointmentSelectionCalendarId || '') &&
    String(detail.startTime || '') === String(sourceDetail.appointmentSelectionStartTime || '') &&
    Number.isFinite(Date.parse(detail.startTime || '')) &&
    String(detail.verifiedAt || '') === String(sourceDetail.appointmentSelectionVerifiedAt || '') &&
    String(detail.appointmentRequestDraftHash || '') === String(sourceDetail.appointmentSelectionRequestDraftHash || '') &&
    draftHash === String(detail.appointmentRequestDraftHash || '') &&
    selectionTerminal &&
    selectionTerminal.bookingOwner === sourceTerminal.bookingOwner &&
    selectionTerminal.terminalToolName === sourceTerminal.terminalToolName
  )
  return valid
    ? { ok: true, selection, selectionDetail: detail, terminalBinding: sourceTerminal }
    : { ok: false, reason: 'appointment_source_selection_mismatch' }
}

function currencyFractionDigits(currency) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits
  } catch {
    return null
  }
}

function amountInCurrencyMinorUnits(value, currency) {
  const amount = Number(value)
  const digits = currencyFractionDigits(currency)
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(digits) || digits < 0 || digits > 6) return null
  const minorUnits = Math.round(amount * (10 ** digits))
  return Number.isSafeInteger(minorUnits) ? minorUnits : null
}

export async function bindConversationalPaymentSourceEvent({
  eventId = '',
  contactId = '',
  eventType = 'payment_link_created',
  detail = {}
} = {}) {
  const cleanEventId = String(eventId || '').trim()
  const cleanContactId = String(contactId || '').trim()
  const cleanAgentId = String(detail.agentId || '').trim()
  const ledgerPaymentId = String(detail.ledgerPaymentId || '').trim()
  const paymentPurpose = String(detail.paymentPurpose || '').trim().toLowerCase()
  const paymentMode = String(detail.paymentMode || '').trim().toLowerCase()
  const appointmentDepositIntentEventId = String(detail.appointmentDepositIntentEventId || '').trim()
  const appointmentDepositIntentClaimKey = String(detail.appointmentDepositIntentClaimKey || '').trim()
  const appointmentDepositIntentClaimToken = String(detail.appointmentDepositIntentClaimToken || '').trim()
  const appointmentSelectionRequestDraftHash = String(detail.appointmentSelectionRequestDraftHash || '').trim()
  const appointmentTerminalBinding = normalizeAppointmentTerminalBinding({
    bookingOwner: detail.appointmentSelectionBookingOwner,
    terminalToolName: detail.appointmentSelectionTerminalToolName
  })
  const purposeConsistent = (
    paymentPurpose === 'appointment_deposit'
      ? paymentMode === 'deposit' && detail.appointmentDeposit === true
      : paymentPurpose === 'deposit'
        ? paymentMode === 'deposit' && detail.appointmentDeposit === false
        : paymentPurpose === 'purchase'
          ? paymentMode === 'full_payment' && detail.appointmentDeposit === false
          : false
  )
  const allowedEventTypes = new Set(['payment_link_created', 'payment_link_reused'])
  if (
    !cleanEventId || !cleanContactId || !cleanAgentId || !ledgerPaymentId ||
    !allowedEventTypes.has(eventType) || !purposeConsistent ||
    (detail.appointmentDeposit === true && (
      !appointmentDepositIntentEventId ||
      !appointmentDepositIntentClaimKey ||
      !appointmentDepositIntentClaimToken ||
      !appointmentSelectionRequestDraftHash ||
      !appointmentTerminalBinding ||
      appointmentDepositIntentClaimKey !== cleanEventId
    ))
  ) {
    throw new Error('Falta la identidad durable del cobro conversacional')
  }

  return db.transaction(async () => {
    let appointmentDepositIntent = null
    let appointmentDepositIntentDetail = null
    if (detail.appointmentDeposit === true) {
      appointmentDepositIntent = await db.get(
        `SELECT id, contact_id, agent_id, event_type, detail_json
         FROM conversational_agent_events WHERE id = ?`,
        [appointmentDepositIntentEventId]
      )
      appointmentDepositIntentDetail = parseJsonField(appointmentDepositIntent?.detail_json, {})
      const intentCollecting = (
        String(appointmentDepositIntentDetail.status || '') === 'collecting' &&
        String(appointmentDepositIntentDetail.collectionMethod || '') === 'paymentLink' &&
        String(appointmentDepositIntentDetail.claimKey || '') === cleanEventId &&
        String(appointmentDepositIntentDetail.claimToken || '') === appointmentDepositIntentClaimToken
      )
      const intentAlreadyBound = (
        String(appointmentDepositIntentDetail.status || '') === 'source_bound' &&
        String(appointmentDepositIntentDetail.sourceEventId || '') === cleanEventId
      )
      if (
        appointmentDepositIntent?.event_type !== 'appointment_deposit_intent_pending' ||
        String(appointmentDepositIntent?.contact_id || '') !== cleanContactId ||
        String(appointmentDepositIntent?.agent_id || '') !== cleanAgentId ||
        String(appointmentDepositIntentDetail.selectionEventId || '') !== String(detail.appointmentSelectionEventId || '') ||
        String(appointmentDepositIntentDetail.selectionRequestDraftHash || '') !== appointmentSelectionRequestDraftHash ||
        String(appointmentDepositIntentDetail.selectionBookingOwner || '') !== appointmentTerminalBinding.bookingOwner ||
        String(appointmentDepositIntentDetail.selectionTerminalToolName || '') !== appointmentTerminalBinding.terminalToolName ||
        !intentCollecting && !intentAlreadyBound
      ) {
        throw new Error('El intento durable del anticipo no coincide con el link')
      }
    }
    const ledger = await db.get(
      `SELECT id, contact_id, amount, currency, payment_mode, payment_provider,
              ghl_invoice_id, public_payment_id
       FROM payments WHERE id = ? AND contact_id = ?`,
      [ledgerPaymentId, cleanContactId]
    )
    const expectedCurrency = normalizeVerifiedCurrency(detail.currency)
    const ledgerCurrency = normalizeVerifiedCurrency(ledger?.currency)
    const expectedProvider = String(detail.paymentProvider || 'highlevel').trim().toLowerCase()
    const ledgerProvider = String(ledger?.payment_provider || '').trim().toLowerCase()
    const ledgerExternalId = expectedProvider === 'highlevel'
      ? String(ledger?.ghl_invoice_id || '')
      : String(ledger?.public_payment_id || '')
    if (
      !ledger ||
      ledgerProvider !== expectedProvider ||
      ledgerExternalId !== String(detail.invoiceId || '') ||
      amountInCurrencyMinorUnits(ledger.amount, ledgerCurrency) !== amountInCurrencyMinorUnits(detail.amount, expectedCurrency) ||
      ledgerCurrency !== expectedCurrency ||
      normalizeVerifiedPaymentEnvironment(ledger.payment_mode) !== normalizeVerifiedPaymentEnvironment(detail.paymentEnvironment)
    ) {
      throw new Error('El ledger del cobro no coincide con el vínculo conversacional')
    }

    const storedDetailJson = JSON.stringify(detail).slice(0, 4000)
    await db.run(
      `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [cleanEventId, cleanContactId, cleanAgentId, eventType, storedDetailJson]
    )
    const stored = await db.get(
      `SELECT contact_id, agent_id, event_type, detail_json
       FROM conversational_agent_events WHERE id = ?`,
      [cleanEventId]
    )
    const storedDetail = parseJsonField(stored?.detail_json, {})
    const comparableKeys = [
      'agentId',
      'invoiceId',
      'ledgerPaymentId',
      'amount',
      'currency',
      'channel',
      'paymentMode',
      'runtimeMode',
      'paymentEnvironment',
      'paymentPurpose',
      'afterPayment',
      'appointmentDeposit',
      'executionId',
      'productId',
      'priceId',
      'paymentProvider',
      'publicPaymentId',
      'appointmentSelectionEventId',
      'appointmentSelectionCalendarId',
      'appointmentSelectionStartTime',
      'appointmentSelectionVerifiedAt',
      'appointmentSelectionRequestDraftHash',
      'appointmentSelectionBookingOwner',
      'appointmentSelectionTerminalToolName',
      'appointmentDepositIntentEventId',
      'appointmentDepositIntentClaimKey',
      'appointmentDepositIntentClaimToken'
    ]
    const mismatch = comparableKeys.some((key) => {
      if (key === 'amount') return Number(storedDetail[key]) !== Number(detail[key])
      if (key === 'currency') return normalizeVerifiedCurrency(storedDetail[key]) !== normalizeVerifiedCurrency(detail[key])
      if (key === 'paymentEnvironment') {
        return normalizeVerifiedPaymentEnvironment(storedDetail[key]) !== normalizeVerifiedPaymentEnvironment(detail[key])
      }
      if (key === 'afterPayment') {
        return normalizeConversationalAfterPayment(storedDetail[key]) !== normalizeConversationalAfterPayment(detail[key])
      }
      return String(storedDetail[key] ?? '') !== String(detail[key] ?? '')
    })
    const storedPurpose = String(storedDetail.paymentPurpose || '').trim().toLowerCase()
    const storedPaymentMode = String(storedDetail.paymentMode || '').trim().toLowerCase()
    const storedPurposeConsistent = storedPurpose === 'appointment_deposit'
      ? storedPaymentMode === 'deposit' && storedDetail.appointmentDeposit === true
      : storedPurpose === 'deposit'
        ? storedPaymentMode === 'deposit' && storedDetail.appointmentDeposit === false
        : storedPurpose === 'purchase'
          ? storedPaymentMode === 'full_payment' && storedDetail.appointmentDeposit === false
          : false
    if (
      !stored ||
      String(stored.contact_id || '') !== cleanContactId ||
      String(stored.agent_id || '') !== cleanAgentId ||
      !allowedEventTypes.has(stored.event_type) ||
      !storedPurposeConsistent ||
      mismatch
    ) {
      throw Object.assign(new Error('El mensaje ya está ligado a otro cobro'), { statusCode: 409 })
    }
    const request = await db.get(
      `SELECT idempotency_key, request_json, status, binding_status
       FROM conversational_payment_link_requests
       WHERE binding_event_id = ?`,
      [cleanEventId]
    )
    const requestDetail = parseJsonField(request?.request_json, {})
    if (
      !request ||
      request.status !== 'completed' ||
      String(requestDetail.agentId || '') !== cleanAgentId ||
      String(requestDetail.contactId || '') !== cleanContactId ||
      String(requestDetail.executionId || '') !== String(detail.executionId || '') ||
      String(requestDetail.paymentPurpose || '') !== String(detail.paymentPurpose || '') ||
      normalizeConversationalAfterPayment(requestDetail.afterPayment) !== normalizeConversationalAfterPayment(detail.afterPayment) ||
      String(requestDetail.appointmentSelectionEventId || '') !== String(detail.appointmentSelectionEventId || '') ||
      String(requestDetail.appointmentSelectionCalendarId || '') !== String(detail.appointmentSelectionCalendarId || '') ||
      String(requestDetail.appointmentSelectionStartTime || '') !== String(detail.appointmentSelectionStartTime || '') ||
      String(requestDetail.appointmentSelectionVerifiedAt || '') !== String(detail.appointmentSelectionVerifiedAt || '') ||
      String(requestDetail.appointmentSelectionRequestDraftHash || '') !== String(detail.appointmentSelectionRequestDraftHash || '') ||
      String(requestDetail.appointmentSelectionBookingOwner || '') !== String(detail.appointmentSelectionBookingOwner || '') ||
      String(requestDetail.appointmentSelectionTerminalToolName || '') !== String(detail.appointmentSelectionTerminalToolName || '') ||
      String(requestDetail.appointmentDepositIntentEventId || '') !== String(detail.appointmentDepositIntentEventId || '') ||
      String(requestDetail.appointmentDepositIntentClaimKey || '') !== String(detail.appointmentDepositIntentClaimKey || '') ||
      String(requestDetail.appointmentDepositIntentClaimToken || '') !== String(detail.appointmentDepositIntentClaimToken || '') ||
      Number(requestDetail.amount) !== Number(detail.amount) ||
      normalizeVerifiedCurrency(requestDetail.currency) !== normalizeVerifiedCurrency(detail.currency)
    ) {
      throw new Error('El ledger durable del link no coincide con su vínculo conversacional')
    }
    const boundAt = new Date().toISOString()
    await db.run(
      `UPDATE conversational_payment_link_requests
       SET binding_status = 'bound', binding_error = NULL, bound_at = COALESCE(bound_at, ?), updated_at = ?
       WHERE binding_event_id = ? AND status = 'completed'`,
      [boundAt, boundAt, cleanEventId]
    )
    // La llave por inbound evita repetir una llamada concreta; la reserva
    // semántica evita que dos mensajes distintos creen el mismo cobro. Ambas
    // quedan cerradas dentro de la misma transacción que liga el evento real,
    // para que ningún proceso observe un link "canónico" todavía huérfano.
    await db.run(
      `UPDATE conversational_payment_semantic_claims
       SET canonical_request_key = ?, status = 'bound', error_message = NULL, updated_at = ?
       WHERE owner_request_key = ? AND status = 'processing'`,
      [request.idempotency_key, boundAt, request.idempotency_key]
    )
    if (appointmentDepositIntent && String(appointmentDepositIntentDetail.status || '') === 'collecting') {
      const nextIntentDetail = {
        ...appointmentDepositIntentDetail,
        status: 'source_bound',
        sourceEventId: cleanEventId,
        sourceBoundAt: boundAt
      }
      const closed = await db.run(
        `UPDATE conversational_agent_events SET detail_json = ?
         WHERE id = ? AND detail_json = ?`,
        [JSON.stringify(nextIntentDetail), appointmentDepositIntentEventId, appointmentDepositIntent.detail_json]
      )
      if (Number(closed?.changes ?? closed?.rowCount ?? 0) !== 1) {
        throw new Error('El intento durable del anticipo cambió antes de sellar el link')
      }
    }
    return { bound: true, eventType: stored.event_type, detail: storedDetail }
  })
}

export async function recoverPendingConversationalPaymentSourceBindings({
  limit = 80,
  contactId = '',
  invoiceId = '',
  reconcilePaid = true
} = {}) {
  const cleanContactId = String(contactId || '').trim()
  const cleanInvoiceId = String(invoiceId || '').trim()
  const rows = await db.all(
    `SELECT * FROM conversational_payment_link_requests
     WHERE status IN ('completed', 'processing') AND COALESCE(binding_status, 'pending') != 'bound'
       AND (? = '' OR contact_id = ?)
       AND (? = '' OR invoice_id = ? OR idempotency_key IN (
         SELECT payment_link_request_key FROM payments WHERE ghl_invoice_id = ? OR public_payment_id = ?
       ))
     ORDER BY updated_at ASC
     LIMIT ?`,
    [
      cleanContactId,
      cleanContactId,
      cleanInvoiceId,
      cleanInvoiceId,
      cleanInvoiceId,
      cleanInvoiceId,
      Math.min(Math.max(Number(limit) || 80, 1), 500)
    ]
  ).catch(() => [])
  let bound = 0
  let reconciled = 0
  let failed = 0

  for (const candidate of rows) {
    let row = candidate
    let request = parseJsonField(row.request_json, {})
    if (!request || conversationalPaymentRequestHash(request) !== row.request_hash) {
      const message = 'El payload durable del cobro no coincide con su hash original; el vínculo quedó bloqueado para revisión humana.'
      await db.run(
        `UPDATE conversational_payment_link_requests
         SET status = 'failed', binding_status = 'failed', error_status = 409,
             error_message = ?, binding_error = ?, updated_at = ?
         WHERE idempotency_key = ? AND COALESCE(binding_status, 'pending') != 'bound'`,
        [message, message, new Date().toISOString(), row.idempotency_key]
      ).catch(() => {})
      failed += 1
      continue
    }
    if (row.status === 'processing') {
      try {
        const recovered = await recoverProcessingConversationalPaymentRequest(db, row, row.request_hash)
        if (!recovered) {
          const rawUpdatedAt = String(row.updated_at || row.created_at || '').trim()
          const normalizedUpdatedAt = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(rawUpdatedAt)
            ? `${rawUpdatedAt.replace(' ', 'T')}Z`
            : rawUpdatedAt
          const updatedAtMs = Date.parse(normalizedUpdatedAt)
          const stale = !Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs >= 5 * 60 * 1000
          if (stale) {
            const message = 'El proceso no conserva un invoice canónico; quedó bloqueado para revisión humana y no se volverá a llamar al proveedor.'
            await db.run(
              `UPDATE conversational_payment_link_requests
               SET status = 'failed', binding_status = 'failed', error_status = 503,
                   error_message = ?, binding_error = ?, updated_at = ?
               WHERE idempotency_key = ? AND status = 'processing'`,
              [message, message, new Date().toISOString(), row.idempotency_key]
            )
            failed += 1
          }
          continue
        }
        row = await db.get(
          'SELECT * FROM conversational_payment_link_requests WHERE idempotency_key = ?',
          [row.idempotency_key]
        )
        request = parseJsonField(row?.request_json, {})
      } catch (error) {
        const message = String(error.message || error).slice(0, 1200)
        await db.run(
          `UPDATE conversational_payment_link_requests
           SET status = 'failed', binding_status = 'failed', error_status = 503,
               error_message = ?, binding_error = ?, updated_at = ?
           WHERE idempotency_key = ? AND status = 'processing'`,
          [message, message, new Date().toISOString(), row.idempotency_key]
        ).catch(() => {})
        failed += 1
        continue
      }
    }
    const response = parseJsonField(row?.response_json, {})
    const requestContactId = String(request.contactId || '').trim()
    const responseInvoiceId = String(response.invoiceId || '').trim()
    if (cleanContactId && requestContactId !== cleanContactId) continue
    if (cleanInvoiceId && responseInvoiceId !== cleanInvoiceId) continue

    try {
      const paymentPurpose = String(request.paymentPurpose || '').trim().toLowerCase()
      const appointmentDeposit = paymentPurpose === 'appointment_deposit'
      const paymentMode = appointmentDeposit || paymentPurpose === 'deposit' ? 'deposit' : 'full_payment'
      if (!requestContactId || !request.agentId || !request.executionId || !responseInvoiceId || !response.paymentLink) {
        throw new Error('El ledger pendiente no conserva todos los datos para reparar su vínculo')
      }
      const ledgers = await db.all(
        `SELECT id, contact_id, amount, currency, status, payment_mode, payment_provider,
                ghl_invoice_id, public_payment_id
         FROM payments
         WHERE contact_id = ? AND (id = ? OR ghl_invoice_id = ? OR public_payment_id = ?)
         ORDER BY CASE WHEN id = ? THEN 0 WHEN ghl_invoice_id = ? THEN 1 ELSE 2 END
         LIMIT 2`,
        [
          requestContactId,
          response.ledgerPaymentId || responseInvoiceId,
          responseInvoiceId,
          response.publicPaymentId || responseInvoiceId,
          response.ledgerPaymentId || responseInvoiceId,
          responseInvoiceId
        ]
      )
      if (ledgers.length !== 1) throw new Error('El invoice pendiente no tiene un único ledger canónico')
      const ledger = ledgers[0]
      const eventId = String(row.binding_event_id || '').trim() ||
        `cae_payment_${createHash('sha256').update(String(row.idempotency_key || '')).digest('hex').slice(0, 48)}`
      if (!String(row.binding_event_id || '').trim()) {
        await db.run(
          `UPDATE conversational_payment_link_requests
           SET binding_event_id = ?, binding_status = COALESCE(binding_status, 'pending'), updated_at = ?
           WHERE idempotency_key = ? AND (binding_event_id IS NULL OR binding_event_id = '')`,
          [eventId, new Date().toISOString(), row.idempotency_key]
        )
      }
      const detail = {
        agentId: String(request.agentId),
        invoiceId: responseInvoiceId,
        amount: Number(response.amount ?? request.amount),
        currency: String(response.currency || request.currency || '').trim().toUpperCase(),
        channel: String(request.channel || '').trim().toLowerCase(),
        paymentMode,
        runtimeMode: 'tool_calling_v2',
        ledgerPaymentId: ledger.id,
        paymentEnvironment: normalizeVerifiedPaymentEnvironment(ledger.payment_mode),
        paymentProvider: String(ledger.payment_provider || request.gateway || 'highlevel').trim().toLowerCase(),
        publicPaymentId: ledger.public_payment_id || null,
        productId: request.productId || null,
        priceId: request.priceId || null,
        paymentPurpose,
        appointmentDeposit,
        afterPayment: request.afterPayment === 'handoff' ? 'handoff' : 'continue',
        appointmentSelectionEventId: request.appointmentSelectionEventId || null,
        appointmentSelectionCalendarId: request.appointmentSelectionCalendarId || null,
        appointmentSelectionStartTime: request.appointmentSelectionStartTime || null,
        appointmentSelectionVerifiedAt: request.appointmentSelectionVerifiedAt || null,
        appointmentSelectionRequestDraftHash: request.appointmentSelectionRequestDraftHash || null,
        appointmentSelectionBookingOwner: request.appointmentSelectionBookingOwner || null,
        appointmentSelectionTerminalToolName: request.appointmentSelectionTerminalToolName || null,
        appointmentDepositIntentEventId: request.appointmentDepositIntentEventId || null,
        appointmentDepositIntentClaimKey: request.appointmentDepositIntentClaimKey || null,
        appointmentDepositIntentClaimToken: request.appointmentDepositIntentClaimToken || null,
        executionId: String(request.executionId),
        status: response.status || null,
        recoveredBinding: true
      }
      await bindConversationalPaymentSourceEvent({
        eventId,
        contactId: requestContactId,
        eventType: 'payment_link_created',
        detail
      })
      bound += 1

      if (
        reconcilePaid &&
        VERIFIED_CONVERSATIONAL_PAYMENT_STATUSES.has(normalizeVerifiedPaymentStatus(ledger.status)) &&
        normalizeVerifiedPaymentEnvironment(ledger.payment_mode) === 'live'
      ) {
        const result = await completeConversationalAgentSalePaymentFromInvoice({
          contactId: requestContactId,
          invoiceId: responseInvoiceId,
          paymentId: ledger.id,
          amount: ledger.amount,
          currency: ledger.currency,
          status: ledger.status,
          paymentMode: ledger.payment_mode
        })
        if (result?.matched) reconciled += 1
      }
    } catch (error) {
      failed += 1
      await db.run(
        `UPDATE conversational_payment_link_requests
         SET binding_status = 'failed', binding_error = ?, updated_at = ?
         WHERE idempotency_key = ? AND COALESCE(binding_status, 'pending') != 'bound'`,
        [String(error.message || error).slice(0, 1200), new Date().toISOString(), row.idempotency_key]
      ).catch(() => {})
    }
  }
  return { scanned: rows.length, bound, reconciled, failed }
}

function paymentReconciliationEventId({ contactId, agentId, sourceEventId, ledgerPaymentId }) {
  const digest = createHash('sha256')
    .update([contactId, agentId, sourceEventId, ledgerPaymentId].map((value) => String(value || '').trim()).join('|'))
    .digest('hex')
  return `carec_${digest.slice(0, 48)}`
}

async function rejectConversationalPaymentReconciliation({ contactId, agentId, sourceEventId, reason, detail = {} }) {
  const digest = createHash('sha256')
    .update([contactId, agentId, sourceEventId, reason].map((value) => String(value || '')).join('|'))
    .digest('hex')
  await recordConversationalAgentEvent({
    eventId: `carej_${digest.slice(0, 48)}`,
    contactId,
    eventType: 'payment_reconciliation_rejected',
    detail: { agentId: agentId || null, sourceEventId: sourceEventId || null, reason, ...detail }
  }).catch(() => {})
  return { matched: false, reason }
}

async function claimConversationalPaymentReconciliation({ eventId, contactId, agentId, detail }) {
  await recordConversationalAgentEvent({
    eventId,
    contactId,
    eventType: CONVERSATIONAL_PAYMENT_RECONCILIATION_EVENT,
    detail: {
      ...detail,
      agentId,
      status: 'pending',
      attempts: 0,
      claimToken: null,
      leaseUntilAt: null,
      lastError: null
    },
    throwOnError: true
  })

  const row = await db.get(
    'SELECT id, detail_json FROM conversational_agent_events WHERE id = ? AND event_type = ?',
    [eventId, CONVERSATIONAL_PAYMENT_RECONCILIATION_EVENT]
  )
  if (!row) throw new Error('No se pudo crear el ledger de reconciliación del pago')
  const stored = parseJsonField(row.detail_json, {})
  if (
    stored.sourceEventId !== detail.sourceEventId ||
    stored.ledgerPaymentId !== detail.ledgerPaymentId ||
    Number(stored.amount) !== Number(detail.amount) ||
    normalizeVerifiedCurrency(stored.currency) !== normalizeVerifiedCurrency(detail.currency) ||
    normalizeVerifiedPaymentEnvironment(stored.paymentEnvironment) !== normalizeVerifiedPaymentEnvironment(detail.paymentEnvironment) ||
    String(stored.paymentPurpose || '').trim() !== String(detail.paymentPurpose || '').trim() ||
    stored.appointmentDeposit !== detail.appointmentDeposit ||
    String(stored.appointmentSelectionEventId || '') !== String(detail.appointmentSelectionEventId || '') ||
    String(stored.appointmentSelectionCalendarId || '') !== String(detail.appointmentSelectionCalendarId || '') ||
    String(stored.appointmentSelectionStartTime || '') !== String(detail.appointmentSelectionStartTime || '') ||
    String(stored.appointmentSelectionVerifiedAt || '') !== String(detail.appointmentSelectionVerifiedAt || '') ||
    String(stored.appointmentSelectionRequestDraftHash || '') !== String(detail.appointmentSelectionRequestDraftHash || '') ||
    String(stored.appointmentSelectionBookingOwner || '') !== String(detail.appointmentSelectionBookingOwner || '') ||
    String(stored.appointmentSelectionTerminalToolName || '') !== String(detail.appointmentSelectionTerminalToolName || '')
  ) {
    throw Object.assign(new Error('El ledger de reconciliación ya existe con otra evidencia'), { statusCode: 409 })
  }
  if (stored.status === 'completed') {
    return { claimed: false, completed: true, result: stored.result || null }
  }

  const nowMs = Date.now()
  const leaseUntilMs = Date.parse(stored.leaseUntilAt || '')
  if (stored.status === 'processing' && Number.isFinite(leaseUntilMs) && leaseUntilMs > nowMs) {
    return { claimed: false, completed: false, processing: true }
  }

  const claimToken = `capr_${randomUUID()}`
  const next = {
    ...stored,
    status: 'processing',
    attempts: Math.max(0, Number(stored.attempts) || 0) + 1,
    claimToken,
    leaseUntilAt: new Date(nowMs + CONVERSATIONAL_PAYMENT_RECONCILIATION_LEASE_MS).toISOString(),
    lastError: null
  }
  const update = await db.run(
    `UPDATE conversational_agent_events
     SET detail_json = ?
     WHERE id = ? AND event_type = ? AND detail_json = ?`,
    [JSON.stringify(next), eventId, CONVERSATIONAL_PAYMENT_RECONCILIATION_EVENT, row.detail_json]
  )
  return dbMutationCount(update) === 1
    ? { claimed: true, claimToken, detail: next }
    : { claimed: false, completed: false, processing: true }
}

async function settleConversationalPaymentReconciliation(eventId, claimToken, { result = null, error = null } = {}) {
  const row = await db.get(
    'SELECT detail_json FROM conversational_agent_events WHERE id = ? AND event_type = ?',
    [eventId, CONVERSATIONAL_PAYMENT_RECONCILIATION_EVENT]
  )
  if (!row) return false
  const stored = parseJsonField(row.detail_json, {})
  if (stored.status !== 'processing' || stored.claimToken !== claimToken) return false
  const next = error
    ? {
        ...stored,
        status: 'pending',
        claimToken: null,
        leaseUntilAt: null,
        lastError: String(error?.message || error || 'reconciliation_failed').slice(0, 1200)
      }
    : {
        ...stored,
        status: 'completed',
        claimToken: null,
        leaseUntilAt: null,
        lastError: null,
        completedAt: new Date().toISOString(),
        result
      }
  const update = await db.run(
    `UPDATE conversational_agent_events
     SET detail_json = ?
     WHERE id = ? AND event_type = ? AND detail_json = ?`,
    [JSON.stringify(next), eventId, CONVERSATIONAL_PAYMENT_RECONCILIATION_EVENT, row.detail_json]
  )
  return dbMutationCount(update) === 1
}

async function checkpointConversationalPaymentReconciliation(eventId, claimToken, patch = {}) {
  const row = await db.get(
    'SELECT detail_json FROM conversational_agent_events WHERE id = ? AND event_type = ?',
    [eventId, CONVERSATIONAL_PAYMENT_RECONCILIATION_EVENT]
  )
  if (!row) throw new Error('Se perdió el ledger de reconciliación durante el pago')
  const stored = parseJsonField(row.detail_json, {})
  if (stored.status !== 'processing' || stored.claimToken !== claimToken) {
    throw new Error('Otro proceso tomó la reconciliación del pago')
  }
  const renewedAt = new Date()
  const next = {
    ...stored,
    leaseUntilAt: new Date(renewedAt.getTime() + CONVERSATIONAL_PAYMENT_RECONCILIATION_LEASE_MS).toISOString(),
    leaseRenewedAt: renewedAt.toISOString(),
    heartbeatCount: Math.max(0, Number(stored.heartbeatCount) || 0) + 1,
    ...patch
  }
  const update = await db.run(
    `UPDATE conversational_agent_events
     SET detail_json = ?
     WHERE id = ? AND event_type = ? AND detail_json = ?`,
    [JSON.stringify(next), eventId, CONVERSATIONAL_PAYMENT_RECONCILIATION_EVENT, row.detail_json]
  )
  if (dbMutationCount(update) !== 1) throw new Error('No se pudo guardar el avance durable de la reconciliación')
  return next
}

export async function assertConversationalPaymentReconciliationClaim({
  reconciliationId = '',
  claimToken = '',
  contactId = '',
  agentId = ''
} = {}) {
  const cleanReconciliationId = String(reconciliationId || '').trim()
  const cleanClaimToken = String(claimToken || '').trim()
  const cleanContactId = String(contactId || '').trim()
  const cleanAgentId = String(agentId || '').trim()
  if (!cleanReconciliationId || !cleanClaimToken || !cleanContactId || !cleanAgentId) {
    throw Object.assign(new Error('Falta el claim durable para entregar la confirmación del pago'), {
      code: 'payment_reconciliation_claim_missing'
    })
  }
  const row = await db.get(
    `SELECT contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?`,
    [cleanReconciliationId]
  )
  const detail = parseJsonField(row?.detail_json, {})
  const leaseUntilMs = Date.parse(detail.leaseUntilAt || '')
  if (
    row?.event_type !== CONVERSATIONAL_PAYMENT_RECONCILIATION_EVENT ||
    String(row?.contact_id || '') !== cleanContactId ||
    String(row?.agent_id || '') !== cleanAgentId ||
    detail.status !== 'processing' ||
    detail.claimToken !== cleanClaimToken ||
    !Number.isFinite(leaseUntilMs) ||
    leaseUntilMs <= Date.now()
  ) {
    throw Object.assign(new Error('La reconciliación perdió autoridad antes de entregar la confirmación'), {
      code: 'payment_reconciliation_claim_lost'
    })
  }
  return { valid: true, detail }
}

async function renewConversationalPaymentReconciliationLease(eventId, claimToken) {
  return checkpointConversationalPaymentReconciliation(eventId, claimToken)
}

async function withConversationalPaymentReconciliationHeartbeat(eventId, claimToken, callback) {
  await renewConversationalPaymentReconciliationLease(eventId, claimToken)
  const intervalMs = Math.max(1000, Math.floor(CONVERSATIONAL_PAYMENT_RECONCILIATION_LEASE_MS / 3))
  let heartbeatError = null
  let heartbeatInFlight = null
  const renew = () => {
    if (heartbeatInFlight || heartbeatError) return
    heartbeatInFlight = renewConversationalPaymentReconciliationLease(eventId, claimToken)
      .catch((error) => {
        heartbeatError = error
      })
      .finally(() => {
        heartbeatInFlight = null
      })
  }
  const timer = setInterval(renew, intervalMs)
  timer.unref?.()
  try {
    const result = await callback()
    if (heartbeatInFlight) await heartbeatInFlight
    if (heartbeatError) throw heartbeatError
    return result
  } finally {
    clearInterval(timer)
    if (heartbeatInFlight) await heartbeatInFlight.catch(() => {})
  }
}

function resolveConversationalPaymentPurpose(matchedDetail = {}) {
  const paymentPurpose = String(matchedDetail.paymentPurpose || '').trim().toLowerCase()
  if (paymentPurpose === 'appointment_deposit') {
    return {
      paymentPurpose,
      paymentMode: 'deposit',
      appointmentDeposit: true,
      autoResumeAllowed: matchedDetail.autoResumeAllowed !== false,
      manualReviewOnly: matchedDetail.manualReviewOnly === true
    }
  }
  if (paymentPurpose === 'deposit') {
    return { paymentPurpose, paymentMode: 'deposit', appointmentDeposit: false }
  }
  if (paymentPurpose === 'purchase') {
    return { paymentPurpose, paymentMode: 'full_payment', appointmentDeposit: false }
  }
  return null
}

function normalizeConversationalAfterPayment(value) {
  return String(value || '').trim().toLowerCase() === 'handoff' ? 'handoff' : 'continue'
}

async function applyVerifiedPaymentHandoff({
  reconciliationId,
  contactId,
  agentId,
  channel = 'whatsapp',
  invoiceId,
  amount,
  currency,
  sourceEventId,
  notify = true,
  allowCompletedAppointmentState = false,
  allowActiveState = true,
  allowStateMutation = true
} = {}) {
  const technicalSummary = `Pago confirmado · ${Number(amount)} ${normalizeVerifiedCurrency(currency)}`
  const reason = 'Pago confirmado; la conversación quedó en manos del equipo'
  const cleanAgentId = String(agentId || '').trim()
  const cleanChannel = normalizeConversationStateChannel(channel || 'whatsapp')
  const handoffSignalEventId = `${reconciliationId}_after_payment_handoff_signal`
  const transition = await db.transaction(async (tx) => {
    // El cobro queda ligado al agente y canal que crearon su fuente durable.
    // Nunca hacemos fallback al estado "más activo" del contacto: un webhook
    // tardío de un agente eliminado no puede tomar el chat de otro agente.
    if (!allowStateMutation || !cleanAgentId) {
      return {
        handoffCompleted: false,
        alreadyHuman: false,
        statePreserved: true,
        preserveReason: cleanAgentId ? 'source_agent_unavailable' : 'source_agent_identity_missing'
      }
    }
    const state = await getConversationState(contactId, {
      agentId: cleanAgentId,
      channel: cleanChannel
    }).catch(() => null)

    const alreadyHuman = state?.status === 'human' || state?.signal === 'ready_for_human'
    if (alreadyHuman) {
      const ownSignalEvent = await tx.get(
        `SELECT id FROM conversational_agent_events
         WHERE id = ? AND contact_id = ? AND agent_id = ? AND event_type = 'signal_set'
         LIMIT 1`,
        [handoffSignalEventId, contactId, cleanAgentId]
      ).catch(() => null)
      return {
        handoffCompleted: true,
        alreadyHuman: true,
        statePreserved: true,
        handoffOwnedByReconciliation: Boolean(ownSignalEvent?.id)
      }
    }
    // Un pago nunca puede pisar una pausa, un takeover, un cierre o una señal
    // que apareció mientras el cliente estaba fuera pagando. La única terminal
    // adicional permitida es appointment_booked cuando ESTA reconciliación ya
    // terminó de crear la cita y ahora debe cumplir afterPayment=handoff.
    const activeSource = allowActiveState && state?.status === 'active' && !state?.signal
    const completedAppointmentSource = Boolean(
      allowCompletedAppointmentState &&
      state?.status === 'completed' &&
      state?.signal === 'appointment_booked'
    )
    if (!state?.id || (!activeSource && !completedAppointmentSource)) {
      return {
        handoffCompleted: false,
        alreadyHuman: false,
        statePreserved: Boolean(state),
        preserveReason: state ? 'conversation_state_changed' : 'conversation_state_missing'
      }
    }

    const authorityToken = `conv_payment_handoff_${createHash('sha256')
      .update([reconciliationId, contactId, state.id].join('\u0000'))
      .digest('hex')
      .slice(0, 48)}`
    const previousUpdatedBy = String(state.updatedBy || '')
    const expectedStatus = completedAppointmentSource ? 'completed' : 'active'
    const expectedSignal = completedAppointmentSource ? 'appointment_booked' : null
    const claimed = await tx.run(
      `UPDATE conversational_agent_state
       SET updated_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND agent_id = ?
         AND COALESCE(NULLIF(channel, ''), 'whatsapp') = ?
         AND status = ?
         AND ${expectedSignal === null ? 'signal IS NULL' : 'signal = ?'}
         AND COALESCE(updated_by, '') = ?`,
      [
        authorityToken,
        state.id,
        cleanAgentId,
        cleanChannel,
        expectedStatus,
        ...(expectedSignal === null ? [] : [expectedSignal]),
        previousUpdatedBy
      ]
    )
    if (dbMutationCount(claimed) !== 1) {
      const refreshed = await getConversationState(contactId, {
        agentId: cleanAgentId,
        channel: cleanChannel
      }).catch(() => null)
      if (refreshed?.status === 'human' || refreshed?.signal === 'ready_for_human') {
        const ownSignalEvent = await tx.get(
          `SELECT id FROM conversational_agent_events
           WHERE id = ? AND contact_id = ? AND agent_id = ? AND event_type = 'signal_set'
           LIMIT 1`,
          [handoffSignalEventId, contactId, cleanAgentId]
        ).catch(() => null)
        return {
          handoffCompleted: true,
          alreadyHuman: true,
          statePreserved: true,
          handoffOwnedByReconciliation: Boolean(ownSignalEvent?.id)
        }
      }
      return {
        handoffCompleted: false,
        alreadyHuman: false,
        statePreserved: true,
        preserveReason: 'conversation_state_changed'
      }
    }
    await setConversationSignal(contactId, 'ready_for_human', {
      reason,
      summary: technicalSummary,
      actionSummarySource: technicalSummary,
      status: 'human',
      agentId: cleanAgentId,
      channel: cleanChannel,
      eventId: handoffSignalEventId,
      strictEvent: true,
      expectedUpdatedBy: authorityToken,
      expectedStatus,
      expectedSignal
    })
    return {
      handoffCompleted: true,
      alreadyHuman: false,
      statePreserved: false,
      handoffOwnedByReconciliation: true
    }
  })

  // Sólo avisamos si esta reconciliación hizo el handoff. Si el chat ya estaba
  // en humano antes del webhook, o si una pausa/toma humana bloqueó la mutación,
  // no mandamos el mensaje falso de que "quedó" en manos del equipo.
  const shouldNotify = Boolean(
    notify &&
    transition.handoffCompleted &&
    transition.handoffOwnedByReconciliation
  )
  const notification = shouldNotify
    ? await notifyConversationalCompletion({
        contactId,
        reason,
        summary: technicalSummary,
        signal: 'ready_for_human',
        eventId: `${reconciliationId}_after_payment_handoff_notification`,
        throwOnFailure: true,
        eventScopedDedupe: true
      })
    : null

  await recordConversationalAgentEvent({
    eventId: transition.handoffCompleted
      ? `${reconciliationId}_after_payment_handoff`
      : `${reconciliationId}_after_payment_handoff_preserved`,
    contactId,
    eventType: transition.handoffCompleted
      ? 'payment_after_action_completed'
      : 'payment_after_action_preserved',
    detail: {
      agentId: cleanAgentId || null,
      invoiceId: invoiceId || null,
      amount: Number(amount),
      currency: normalizeVerifiedCurrency(currency),
      sourceEventId: sourceEventId || null,
      afterPayment: 'handoff',
      alreadyHuman: transition.alreadyHuman === true,
      handoffCompleted: transition.handoffCompleted === true,
      handoffOwnedByReconciliation: transition.handoffOwnedByReconciliation === true,
      statePreserved: transition.statePreserved === true,
      preserveReason: transition.preserveReason || null,
      notificationSent: Boolean(notification),
      reconciliationId
    },
    throwOnError: true
  })

  return { ...transition, notification }
}

async function resumeConversationalAppointmentAfterVerifiedPayment(payload) {
  if (conversationalPaymentResumeHandlerForTest) {
    return conversationalPaymentResumeHandlerForTest(payload)
  }
  const { resumeToolCallingV2AfterVerifiedPayment } = await import('../agents/conversational/runner.js')
  return resumeToolCallingV2AfterVerifiedPayment(payload)
}

async function deliverConversationalPaymentTerminalReply(payload) {
  if (conversationalPaymentTerminalReplyHandlerForTest) {
    return conversationalPaymentTerminalReplyHandlerForTest(payload)
  }
  const { deliverVerifiedPaymentTerminalReply } = await import('../agents/conversational/runner.js')
  return deliverVerifiedPaymentTerminalReply(payload)
}

async function applyManualReviewSignalOnce({
  reconciliationId,
  contactId,
  agentId,
  conversationAgentId,
  channel = 'whatsapp',
  summary,
  preserveExistingState = false
} = {}) {
  const signalEventId = `${String(reconciliationId || '').trim()}_manual_review_signal`
  const effectiveAgentId = conversationAgentId === undefined ? agentId : conversationAgentId
  return db.transaction(async (tx) => {
    const existingEvent = await tx.get(
      `SELECT contact_id, event_type, detail_json
       FROM conversational_agent_events WHERE id = ?`,
      [signalEventId]
    )
    let state = await getConversationState(contactId, {
      agentId: effectiveAgentId || null,
      channel
    }).catch(() => null)
    if (!state && effectiveAgentId) {
      state = await getConversationState(contactId, { channel }).catch(() => null)
    }
    // El fallback sin agentId sólo existe para encontrar un estado legacy que
    // quedó liberado. Si devuelve un estado ya asignado a otro agente, jamás
    // debe heredarlo un webhook tardío del agente fuente (exista o ya se haya
    // eliminado).
    if (state?.agentId && state.agentId !== effectiveAgentId) {
      return {
        applied: false,
        preserved: true,
        reason: 'conversation_reassigned_to_another_agent'
      }
    }
    if (existingEvent) {
      const detail = parseJsonField(existingEvent.detail_json, {})
      if (
        existingEvent.event_type !== 'signal_set' ||
        String(existingEvent.contact_id || '') !== String(contactId || '').trim() ||
        detail.signal !== 'ready_for_human' ||
        detail.status !== 'human'
      ) {
        throw new Error('La identidad durable de revisión manual pertenece a otro cambio de estado')
      }
      if (state?.status === 'active' && !state.signal && String(state.updatedBy || '').startsWith('conv_manual_review_')) {
        throw new Error('La señal durable de revisión no coincide con el estado de la conversación')
      }
      return { applied: false, preserved: true, reason: 'signal_already_applied' }
    }
    if (preserveExistingState) return { applied: false, preserved: true, reason: 'preserve_requested' }
    if (!state?.id || state.status !== 'active' || state.signal) {
      return { applied: false, preserved: true, reason: 'conversation_state_changed' }
    }
    const authorityToken = `conv_manual_review_${createHash('sha256')
      .update([reconciliationId, contactId, state.id].join('\u0000'))
      .digest('hex')
      .slice(0, 48)}`
    const previousUpdatedBy = String(state.updatedBy || '')
    const claimed = await tx.run(
      `UPDATE conversational_agent_state
       SET updated_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'active' AND signal IS NULL
         AND COALESCE(updated_by, '') = ?`,
      [authorityToken, state.id, previousUpdatedBy]
    )
    if (dbMutationCount(claimed) !== 1) {
      return { applied: false, preserved: true, reason: 'conversation_state_changed' }
    }
    await setConversationSignal(contactId, 'ready_for_human', {
      reason: 'El anticipo ya fue confirmado y la cita requiere revisión humana',
      summary,
      status: 'human',
      agentId: effectiveAgentId,
      channel,
      eventId: signalEventId,
      strictEvent: true,
      expectedUpdatedBy: authorityToken
    })
    return { applied: true, preserved: false, reason: 'signal_applied' }
  })
}

async function routeVerifiedAppointmentDepositToHumanReview({
  reconciliationId,
  reconciliationClaimToken,
  contactId,
  agentId,
  channel = 'whatsapp',
  sourceEventId,
  ledgerPaymentId,
  amount,
  currency,
  conversationAgentId,
  reason = 'appointment_deposit_manual_review_required',
  preserveExistingState = false
} = {}) {
  const summary = `Anticipo confirmado por ${Number(amount)} ${normalizeVerifiedCurrency(currency)}; la cita necesita revisión humana antes de continuar.`
  await recordConversationalAgentEvent({
    eventId: `${reconciliationId}_manual_review`,
    contactId,
    eventType: 'appointment_deposit_manual_review_required',
    detail: {
      agentId,
      sourceEventId,
      ledgerPaymentId,
      amount: Number(amount),
      currency: normalizeVerifiedCurrency(currency),
      reconciliationId,
      autoResumeAllowed: false,
      needsNewSlot: true,
      reason
    },
    throwOnError: true
  })
  const signalResult = await applyManualReviewSignalOnce({
    reconciliationId,
    contactId,
    agentId,
    conversationAgentId,
    channel,
    summary,
    preserveExistingState
  })
  const notification = await notifyConversationalCompletion({
    contactId,
    reason: 'Anticipo confirmado; revisar la cita manualmente',
    summary,
    signal: 'ready_for_human',
    eventId: `${reconciliationId}_manual_review_notification`,
    throwOnFailure: true,
    eventScopedDedupe: true
  })
  // La confirmación automática sólo sale si esta reconciliación puso la señal
  // o si está recuperando exactamente su propia señal durable. Si el chat ya
  // estaba pausado, tomado por humano o reasignado, preservamos también el
  // silencio del bot; la notificación interna del pago sí queda registrada.
  const ownsManualReviewTransition = Boolean(
    String(agentId || '').trim() &&
    (signalResult?.applied || signalResult?.reason === 'signal_already_applied')
  )
  const reply = ownsManualReviewTransition
    ? await deliverConversationalPaymentTerminalReply({
        reconciliationId,
        reconciliationClaimToken,
        contactId,
        agentId,
        channel,
        terminalType: 'manual_review'
      })
    : {
        sent: false,
        suppressed: true,
        reason: signalResult?.reason || 'conversation_state_preserved'
      }
  return { signalResult, notification, reply }
}

export async function notifyConversationalHumanBookingDeposit({
  reconciliationId,
  contactId,
  title,
  startTime
} = {}) {
  const cleanReconciliationId = String(reconciliationId || '').trim()
  const cleanContactId = String(contactId || '').trim()
  const cleanTitle = String(title || '').trim()
  const cleanStartTime = String(startTime || '').trim()
  if (!cleanReconciliationId || !cleanContactId || !cleanTitle || !cleanStartTime) {
    throw new Error('La notificación de la cita humana no conserva su identidad durable completa')
  }
  return notifyConversationalCompletion({
    contactId: cleanContactId,
    reason: 'Horario elegido pendiente de confirmación humana',
    summary: `${cleanTitle}: ${cleanStartTime}`,
    signal: 'ready_for_human',
    eventId: `${cleanReconciliationId}_human_booking_notification`,
    throwOnFailure: true,
    eventScopedDedupe: true
  })
}

export async function notifyConversationalAiBookingDeposit({
  reconciliationId,
  contactId,
  title,
  startTime
} = {}) {
  const cleanReconciliationId = String(reconciliationId || '').trim()
  const cleanContactId = String(contactId || '').trim()
  const cleanTitle = String(title || '').trim()
  const cleanStartTime = String(startTime || '').trim()
  if (!cleanReconciliationId || !cleanContactId || !cleanTitle || !cleanStartTime) {
    throw new Error('La notificación de la cita automática no conserva su identidad durable completa')
  }
  return notifyConversationalCompletion({
    contactId: cleanContactId,
    reason: 'Cita agendada por el agente',
    summary: `${cleanTitle}: ${cleanStartTime}`,
    signal: 'appointment_booked',
    eventId: `${cleanReconciliationId}_ai_booking_notification`,
    throwOnFailure: true,
    eventScopedDedupe: true
  })
}

async function inspectCompletedHumanBookingDepositTerminal({
  reconciliationId,
  contactId,
  agentId,
  paymentId,
  reconciliationDetail = {}
} = {}) {
  if (
    reconciliationDetail.appointmentSelectionBookingOwner !== 'human' ||
    reconciliationDetail.appointmentSelectionTerminalToolName !== 'request_human_booking'
  ) return { ok: false, reason: 'not_human_terminal' }
  const consumption = await db.get(
    `SELECT contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?`,
    [`${reconciliationId}_consumed`]
  )
  const consumed = parseJsonField(consumption?.detail_json, {})
  const sourceMessageId = `payment-resume:${reconciliationId}`
  const consumptionValid = Boolean(
    consumption?.event_type === 'deposit_payment_consumed' &&
    String(consumption?.contact_id || '') === String(contactId || '').trim() &&
    String(consumption?.agent_id || '') === String(agentId || '').trim() &&
    consumed.status === 'consumed' &&
    consumed.consumptionType === 'human_booking_request' &&
    consumed.reconciliationId === String(reconciliationId || '').trim() &&
    consumed.ledgerPaymentId === String(paymentId || '').trim() &&
    consumed.bookingOwner === 'human' &&
    consumed.terminalToolName === 'request_human_booking' &&
    consumed.calendarId === String(reconciliationDetail.appointmentSelectionCalendarId || '') &&
    consumed.startTime === String(reconciliationDetail.appointmentSelectionStartTime || '') &&
    consumed.selectionRequestDraftHash === String(reconciliationDetail.appointmentSelectionRequestDraftHash || '') &&
    consumed.sourceMessageId === sourceMessageId &&
    String(consumed.humanBookingEventId || '').startsWith('cae_human_booking_')
  )
  if (!consumptionValid) return { ok: false, reason: 'human_consumption_missing_or_invalid' }
  const humanEvent = await db.get(
    `SELECT contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?`,
    [consumed.humanBookingEventId]
  )
  const human = parseJsonField(humanEvent?.detail_json, {})
  const humanValid = Boolean(
    humanEvent?.event_type === 'human_booking_requested' &&
    String(humanEvent?.contact_id || '') === String(contactId || '').trim() &&
    String(humanEvent?.agent_id || '') === String(agentId || '').trim() &&
    human.bookingOwner === 'human' &&
    human.terminalToolName === 'request_human_booking' &&
    human.depositReconciliationId === String(reconciliationId || '').trim() &&
    human.depositPaymentId === String(paymentId || '').trim() &&
    human.calendarId === consumed.calendarId &&
    human.startTime === consumed.startTime &&
    human.selectionRequestDraftHash === consumed.selectionRequestDraftHash &&
    human.sourceMessageId === sourceMessageId &&
    human.appointmentCreated === false
  )
  return humanValid
    ? { ok: true, consumption: consumed, humanEvent: human }
    : { ok: false, reason: 'human_booking_event_missing_or_invalid' }
}

async function inspectCompletedAiBookingDepositTerminal({
  reconciliationId,
  contactId,
  agentId,
  paymentId,
  reconciliationDetail = {}
} = {}) {
  if (
    reconciliationDetail.appointmentSelectionBookingOwner !== 'ai' ||
    reconciliationDetail.appointmentSelectionTerminalToolName !== 'book_appointment'
  ) return { ok: false, reason: 'not_ai_terminal' }
  const cleanReconciliationId = String(reconciliationId || '').trim()
  const cleanContactId = String(contactId || '').trim()
  const cleanAgentId = String(agentId || '').trim()
  const cleanPaymentId = String(paymentId || '').trim()
  return db.transaction(async (tx) => {
    const rowLock = process.env.DATABASE_URL ? ' FOR UPDATE' : ''
    const consumption = await tx.get(
      `SELECT contact_id, agent_id, event_type, detail_json
       FROM conversational_agent_events WHERE id = ?${rowLock}`,
      [`${cleanReconciliationId}_consumed`]
    )
    const consumed = parseJsonField(consumption?.detail_json, {})
    const consumptionValid = Boolean(
      consumption?.event_type === 'deposit_payment_consumed' &&
      String(consumption?.contact_id || '') === cleanContactId &&
      String(consumption?.agent_id || '') === cleanAgentId &&
      consumed.status === 'consumed' &&
      consumed.reconciliationId === cleanReconciliationId &&
      consumed.ledgerPaymentId === cleanPaymentId &&
      consumed.bookingOwner === 'ai' &&
      consumed.terminalToolName === 'book_appointment' &&
      consumed.calendarId === String(reconciliationDetail.appointmentSelectionCalendarId || '') &&
      consumed.startTime === String(reconciliationDetail.appointmentSelectionStartTime || '') &&
      consumed.selectionRequestDraftHash === String(reconciliationDetail.appointmentSelectionRequestDraftHash || '') &&
      String(consumed.appointmentRequestId || '').trim() &&
      String(consumed.appointmentId || '').trim()
    )
    if (!consumptionValid) return { ok: false, reason: 'ai_consumption_missing_or_invalid' }

    const request = await tx.get(
      `SELECT status, appointment_id, response_json
       FROM appointment_creation_requests WHERE client_request_id = ?${rowLock}`,
      [consumed.appointmentRequestId]
    )
    const appointment = await tx.get(
      `SELECT id, contact_id, calendar_id, title, start_time, end_time,
              appointment_status, status, deleted_at
       FROM appointments WHERE id = ?${rowLock}`,
      [consumed.appointmentId]
    )
    const appointmentStatus = normalizeVerifiedPaymentStatus(
      appointment?.appointment_status || appointment?.status
    )
    const expectedStartMs = Date.parse(consumed.startTime || '')
    const actualStartMs = Date.parse(appointment?.start_time || '')
    const appointmentBelongsToContact = Boolean(
      appointment?.id &&
      String(appointment.contact_id || '') === cleanContactId
    )
    const appointmentActive = Boolean(
      appointmentBelongsToContact &&
      !appointment.deleted_at &&
      !['cancelled', 'canceled', 'deleted'].includes(appointmentStatus)
    )
    const requestCanBeRepaired = Boolean(
      request &&
      ['processing', 'failed'].includes(String(request.status || '')) &&
      (!request.appointment_id || String(request.appointment_id) === String(consumed.appointmentId))
    )
    if (!appointmentActive) {
      if (requestCanBeRepaired) {
        const tombstoneResponse = {
          id: consumed.appointmentId,
          calendarId: appointment?.calendar_id || consumed.calendarId,
          contactId: cleanContactId,
          title: appointment?.title || 'Cita',
          status: appointment?.appointment_status || appointment?.status || 'cancelled',
          appointmentStatus: appointment?.appointment_status || appointment?.status || 'cancelled',
          startTime: appointment?.start_time || consumed.startTime,
          endTime: appointment?.end_time || appointment?.start_time || consumed.startTime,
          idempotencyReplay: {
            replayed: true,
            canonicalChanged: true,
            state: appointment?.id ? 'appointment_cancelled' : 'appointment_missing'
          }
        }
        const tombstoned = await tx.run(
          `UPDATE appointment_creation_requests
           SET status = 'completed', processing_token = NULL, appointment_id = ?,
               response_json = ?, error_status = NULL,
               error_message = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE client_request_id = ? AND status IN ('processing', 'failed')
             AND (appointment_id IS NULL OR appointment_id = ?)`,
          [
            consumed.appointmentId,
            JSON.stringify(tombstoneResponse),
            consumed.appointmentRequestId,
            consumed.appointmentId
          ]
        )
        if (dbMutationCount(tombstoned) !== 1) {
          throw new Error('Otro proceso cambió la solicitud idempotente mientras se bloqueaba la cita inactiva')
        }
      }
      return {
        ok: false,
        manualReviewRequired: true,
        terminalConsumed: true,
        reason: appointment?.id
          ? 'canonical_ai_appointment_inactive_or_reassigned'
          : 'canonical_ai_appointment_missing'
      }
    }

    const canonicalChanged = Boolean(
      String(appointment.calendar_id || '') !== String(consumed.calendarId || '') ||
      !Number.isFinite(expectedStartMs) ||
      !Number.isFinite(actualStartMs) ||
      actualStartMs !== expectedStartMs
    )

    let requestRepaired = false
    if (requestCanBeRepaired) {
      const canonicalResponse = {
        id: appointment.id,
        calendarId: appointment.calendar_id,
        contactId: appointment.contact_id,
        title: appointment.title || 'Cita',
        status: appointment.appointment_status || appointment.status || 'confirmed',
        appointmentStatus: appointment.appointment_status || appointment.status || 'confirmed',
        startTime: appointment.start_time,
        endTime: appointment.end_time || appointment.start_time
      }
      const repaired = await tx.run(
        `UPDATE appointment_creation_requests
         SET status = 'completed', processing_token = NULL, appointment_id = ?,
             response_json = ?, error_status = NULL, error_message = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE client_request_id = ? AND status IN ('processing', 'failed')
           AND (appointment_id IS NULL OR appointment_id = ?)`,
        [
          appointment.id,
          JSON.stringify(canonicalResponse),
          consumed.appointmentRequestId,
          appointment.id
        ]
      )
      if (dbMutationCount(repaired) !== 1) {
        throw new Error('Otro proceso cambió la solicitud idempotente mientras se reparaba la cita pagada')
      }
      request.status = 'completed'
      request.appointment_id = appointment.id
      requestRepaired = true
    }
    if (
      request?.status !== 'completed' ||
      String(request?.appointment_id || '') !== String(consumed.appointmentId || '')
    ) {
      return {
        ok: false,
        manualReviewRequired: true,
        terminalConsumed: true,
        reason: 'ai_appointment_request_not_completed'
      }
    }

    return { ok: true, consumption: consumed, appointment, requestRepaired, canonicalChanged }
  })
}

async function repairCompletedAiBookingConversationState({
  contactId,
  agentId,
  channel = 'whatsapp',
  appointment
} = {}) {
  const state = await getConversationState(contactId, { agentId, channel }).catch(() => null)
  if (!state || state.status !== 'active' || state.signal) {
    return { repaired: false, preserved: true, state }
  }
  const expectedUpdatedBy = String(state.updatedBy || '').trim()
  if (!expectedUpdatedBy.startsWith('conv_terminal_')) {
    return { repaired: false, preserved: true, state }
  }
  try {
    const repaired = await setConversationSignal(contactId, 'appointment_booked', {
      reason: 'Cita agendada por el agente',
      actionSummarySource: `${appointment?.title || 'Cita'} · ${appointment?.start_time || ''}`,
      status: 'completed',
      agentId,
      channel,
      eventId: `cae_appointment_signal_recovery_${createHash('sha256')
        .update([contactId, agentId, appointment?.id || ''].join('\u0000'))
        .digest('hex')
        .slice(0, 48)}`,
      strictEvent: true,
      expectedUpdatedBy
    })
    return { repaired: true, preserved: false, state: repaired }
  } catch (error) {
    if (error?.code !== 'conversational_terminal_authority_lost') throw error
    return {
      repaired: false,
      preserved: true,
      state: await getConversationState(contactId, { agentId, channel }).catch(() => null)
    }
  }
}

async function completeDurableAppointmentPaymentTerminalEffects({
  reconciliationId,
  reconciliationClaimToken,
  contactId,
  agentId,
  paymentId,
  channel = 'whatsapp',
  reconciliationDetail = {}
} = {}) {
  const bookingOwner = String(reconciliationDetail.appointmentSelectionBookingOwner || '')
  const terminal = bookingOwner === 'ai'
    ? await inspectCompletedAiBookingDepositTerminal({
        reconciliationId,
        contactId,
        agentId,
        paymentId,
        reconciliationDetail
      })
    : bookingOwner === 'human'
      ? await inspectCompletedHumanBookingDepositTerminal({
          reconciliationId,
          contactId,
          agentId,
          paymentId,
          reconciliationDetail
        })
      : { ok: false, reason: 'appointment_terminal_binding_missing' }
  if (!terminal.ok) return terminal

  const terminalType = bookingOwner
  const ai = terminalType === 'ai' ? terminal : null
  const human = terminalType === 'human' ? terminal : null
  const stateRepair = ai
    ? await repairCompletedAiBookingConversationState({
        contactId,
        agentId,
        channel,
        appointment: ai.appointment
      })
    : null
  if (ai) {
    const appointmentEventDigest = createHash('sha256')
      .update([contactId, agentId, ai.appointment.id].join('\u0000'))
      .digest('hex')
      .slice(0, 48)
    await recordConversationalAgentEvent({
      eventId: `cae_appointment_booked_${appointmentEventDigest}`,
      contactId,
      eventType: 'appointment_booked',
      detail: {
        agentId,
        appointmentId: ai.appointment.id,
        startTime: ai.appointment.start_time,
        calendarId: ai.appointment.calendar_id,
        recoveredFromPaymentReconciliation: true
      },
      throwOnError: true
    })
  }
  const notification = ai
    ? await notifyConversationalAiBookingDeposit({
        reconciliationId,
        contactId,
        title: ai.appointment.title || 'Cita',
        startTime: ai.appointment.start_time
      })
    : await notifyConversationalHumanBookingDeposit({
        reconciliationId,
        contactId,
        title: human.humanEvent.title || 'Cita',
        startTime: human.humanEvent.startTime
      })
  const reply = await deliverConversationalPaymentTerminalReply({
    reconciliationId,
    reconciliationClaimToken,
    contactId,
    agentId,
    channel,
    terminalType
  })
  return {
    ok: true,
    terminalType,
    terminal,
    stateRepair,
    notification,
    reply,
    reason: ai ? 'appointment_already_booked' : 'human_booking_already_requested'
  }
}

export async function claimConversationalTerminalMutationAuthority({
  contactId = '',
  agentId = '',
  channel = 'whatsapp',
  authorityToken = '',
  database = db
} = {}) {
  const cleanContactId = String(contactId || '').trim()
  const cleanAgentId = String(agentId || '').trim()
  const cleanChannel = normalizeConversationStateChannel(channel)
  const cleanAuthorityToken = String(authorityToken || '').trim().slice(0, 180)
  if (!cleanContactId || !cleanAgentId || !cleanAuthorityToken) {
    throw Object.assign(new Error('Falta la autoridad durable para ejecutar la terminal'), {
      statusCode: 409,
      code: 'conversational_terminal_authority_missing'
    })
  }
  const rowLock = process.env.DATABASE_URL ? ' FOR UPDATE' : ''
  const state = await database.get(
    `SELECT id, status, signal, agent_id, channel
     FROM conversational_agent_state
     WHERE contact_id = ? AND agent_id = ?
       AND COALESCE(NULLIF(channel, ''), 'whatsapp') = ?${rowLock}
     LIMIT 1`,
    [cleanContactId, cleanAgentId, cleanChannel]
  )
  if (!state?.id || state.status !== 'active' || state.signal) {
    throw Object.assign(new Error('La conversación ya no está bajo control ejecutable del agente'), {
      statusCode: 409,
      code: 'conversational_terminal_authority_lost'
    })
  }
  const claimed = await database.run(
    `UPDATE conversational_agent_state
     SET updated_by = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'active' AND signal IS NULL`,
    [cleanAuthorityToken, state.id]
  )
  if (dbMutationCount(claimed) !== 1) {
    throw Object.assign(new Error('Un humano cambió la conversación antes de ejecutar la terminal'), {
      statusCode: 409,
      code: 'conversational_terminal_authority_lost'
    })
  }
  return { stateId: state.id, authorityToken: cleanAuthorityToken }
}

async function assertConversationalAppointmentDepositEvidence({
  reconciliationId = '',
  contactId = '',
  agentId = '',
  paymentId = '',
  reconciliationClaimToken = '',
  database = db,
  lockRows = false
} = {}) {
  const cleanReconciliationId = String(reconciliationId || '').trim()
  const cleanContactId = String(contactId || '').trim()
  const cleanAgentId = String(agentId || '').trim()
  const cleanPaymentId = String(paymentId || '').trim()
  const cleanReconciliationClaimToken = String(reconciliationClaimToken || '').trim()
  if (!cleanReconciliationId || !cleanContactId || !cleanAgentId || !cleanPaymentId) {
    throw new Error('Falta la identidad durable del anticipo de la cita')
  }

  const rowLock = lockRows && process.env.DATABASE_URL ? ' FOR UPDATE' : ''
  // El orden es intencional y debe conservarse en reserve/consume: primero la
  // reconciliacion y luego el ledger. En PostgreSQL ambos quedan bloqueados
  // hasta el commit para que un refund/void concurrente no invalide el pago
  // entre la comprobacion y la reserva/consumo del anticipo. SQLite ya toma el
  // writer lock con BEGIN IMMEDIATE y no acepta FOR UPDATE.
  const reconciliation = await database.get(
    `SELECT contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?${rowLock}`,
    [cleanReconciliationId]
  )
  const ledger = await database.get(
    `SELECT id, contact_id, amount, currency, status, payment_mode
     FROM payments WHERE id = ? AND contact_id = ?${rowLock}`,
    [cleanPaymentId, cleanContactId]
  )
  const reconciliationDetail = parseJsonField(reconciliation?.detail_json, {})
  const validStatus = cleanReconciliationClaimToken
    ? (
        reconciliationDetail.status === 'processing' &&
        reconciliationDetail.verifiedEventAppliedAt &&
        reconciliationDetail.claimToken === cleanReconciliationClaimToken &&
        Date.parse(reconciliationDetail.leaseUntilAt || '') > Date.now()
      )
    : reconciliationDetail.status === 'completed'
  if (
    reconciliation?.event_type !== CONVERSATIONAL_PAYMENT_RECONCILIATION_EVENT ||
    String(reconciliation?.contact_id || '') !== cleanContactId ||
    String(reconciliation?.agent_id || '') !== cleanAgentId ||
    reconciliationDetail.paymentPurpose !== 'appointment_deposit' ||
    reconciliationDetail.appointmentDeposit !== true ||
    reconciliationDetail.autoResumeAllowed === false ||
    String(reconciliationDetail.ledgerPaymentId || '') !== cleanPaymentId ||
    !ledger ||
    !VERIFIED_CONVERSATIONAL_PAYMENT_STATUSES.has(normalizeVerifiedPaymentStatus(ledger.status)) ||
    normalizeVerifiedPaymentEnvironment(ledger.payment_mode) !== 'live' ||
    normalizeVerifiedCurrency(ledger.currency) !== normalizeVerifiedCurrency(reconciliationDetail.currency) ||
    amountInCurrencyMinorUnits(ledger.amount, ledger.currency) !== amountInCurrencyMinorUnits(reconciliationDetail.amount, reconciliationDetail.currency) ||
    !validStatus
  ) {
    throw new Error('El anticipo ya no coincide con la cita que intenta consumirlo')
  }
  return { reconciliationDetail, ledger }
}

async function inspectRecoverableDepositReservationAttempt(database, appointmentRequestId, { lockRows = false } = {}) {
  const cleanRequestId = String(appointmentRequestId || '').trim()
  if (!cleanRequestId) return { recoverable: false, reason: 'appointment_request_id_missing' }
  const rowLock = lockRows && process.env.DATABASE_URL ? ' FOR UPDATE' : ''
  const request = await database.get(
    `SELECT status, appointment_id
     FROM appointment_creation_requests
     WHERE client_request_id = ?${rowLock}`,
    [cleanRequestId]
  )
  // Este es el único crash inequívocamente anterior a la cita: la reserva del
  // anticipo existe, pero el ledger idempotente de creación nunca nació.
  if (!request) return { recoverable: true, reason: 'appointment_request_missing' }

  const appointmentId = String(request.appointment_id || '').trim()
  if (request.status !== 'completed' || !appointmentId) {
    return { recoverable: false, reason: `appointment_request_${String(request.status || 'unknown')}` }
  }
  const appointment = await database.get(
    `SELECT id, appointment_status, status, deleted_at
     FROM appointments WHERE id = ?${rowLock}`,
    [appointmentId]
  )
  if (!appointment) return { recoverable: false, reason: 'canonical_appointment_missing' }
  const status = normalizeVerifiedPaymentStatus(appointment.appointment_status || appointment.status)
  const inactive = Boolean(appointment.deleted_at) || ['cancelled', 'canceled', 'deleted'].includes(status)
  return inactive
    ? { recoverable: true, reason: 'canonical_appointment_inactive', appointmentId }
    : { recoverable: false, reason: 'canonical_appointment_active', appointmentId }
}

export async function canRecoverConversationalAppointmentDepositReservation({
  reconciliationId = '',
  contactId = '',
  agentId = '',
  appointmentRequestId = ''
} = {}) {
  const eventId = `${String(reconciliationId || '').trim()}_consumed`
  const row = await db.get(
    `SELECT contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?`,
    [eventId]
  ).catch(() => null)
  const detail = parseJsonField(row?.detail_json, {})
  const leaseUntilMs = Date.parse(detail.leaseUntilAt || '')
  if (
    row?.event_type !== 'deposit_payment_consumed' ||
    String(row?.contact_id || '') !== String(contactId || '').trim() ||
    String(row?.agent_id || '') !== String(agentId || '').trim() ||
    detail.status !== 'reserved' ||
    detail.reconciliationId !== String(reconciliationId || '').trim() ||
    detail.appointmentRequestId === String(appointmentRequestId || '').trim() ||
    !Number.isFinite(leaseUntilMs) ||
    leaseUntilMs > Date.now()
  ) return false
  const recovery = await inspectRecoverableDepositReservationAttempt(db, detail.appointmentRequestId)
  return recovery.recoverable === true
}

export async function assertConversationalAppointmentDepositReservationFence({
  eventId = '',
  claimToken = '',
  appointmentRequestId = '',
  contactId = '',
  agentId = '',
  calendarId = '',
  startTime = '',
  selectionRequestDraftHash = '',
  bookingOwner = 'ai',
  terminalToolName = 'book_appointment',
  database = db
} = {}) {
  const cleanEventId = String(eventId || '').trim()
  const cleanClaimToken = String(claimToken || '').trim()
  const cleanAppointmentRequestId = String(appointmentRequestId || '').trim()
  const cleanContactId = String(contactId || '').trim()
  const cleanAgentId = String(agentId || '').trim()
  const cleanCalendarId = String(calendarId || '').trim()
  const cleanStartTime = String(startTime || '').trim()
  const cleanDraftHash = String(selectionRequestDraftHash || '').trim()
  const cleanBookingOwner = String(bookingOwner || '').trim()
  const cleanTerminalToolName = String(terminalToolName || '').trim()
  if (
    !cleanEventId || !cleanClaimToken || !cleanAppointmentRequestId || !cleanContactId || !cleanAgentId ||
    !cleanCalendarId || !Number.isFinite(Date.parse(cleanStartTime)) ||
    !/^[a-f0-9]{64}$/i.test(cleanDraftHash) || cleanBookingOwner !== 'ai' ||
    cleanTerminalToolName !== 'book_appointment'
  ) {
    throw Object.assign(new Error('Falta el fencing token del anticipo'), { status: 409, code: 'deposit_fence_missing' })
  }

  // Lectura sin lock para descubrir la evidencia; luego bloqueamos siempre en
  // el mismo orden que reserve/consume: reconciliación, payment y reservation.
  const preliminary = await database.get(
    `SELECT contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?`,
    [cleanEventId]
  )
  const preliminaryDetail = parseJsonField(preliminary?.detail_json, {})
  await assertConversationalAppointmentDepositEvidence({
    reconciliationId: preliminaryDetail.reconciliationId,
    contactId: cleanContactId,
    agentId: cleanAgentId,
    paymentId: preliminaryDetail.ledgerPaymentId,
    reconciliationClaimToken: preliminaryDetail.reconciliationClaimToken,
    database,
    lockRows: true
  })
  const rowLock = process.env.DATABASE_URL ? ' FOR UPDATE' : ''
  const stored = await database.get(
    `SELECT contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?${rowLock}`,
    [cleanEventId]
  )
  const detail = parseJsonField(stored?.detail_json, {})
  if (
    stored?.event_type !== 'deposit_payment_consumed' ||
    String(stored?.contact_id || '') !== cleanContactId ||
    String(stored?.agent_id || '') !== cleanAgentId ||
    detail.status !== 'reserved' ||
    detail.appointmentRequestId !== cleanAppointmentRequestId ||
    detail.calendarId !== cleanCalendarId ||
    detail.startTime !== cleanStartTime ||
    detail.selectionRequestDraftHash !== cleanDraftHash ||
    detail.bookingOwner !== cleanBookingOwner ||
    detail.terminalToolName !== cleanTerminalToolName ||
    detail.claimToken !== cleanClaimToken ||
    Date.parse(detail.leaseUntilAt || '') <= Date.now()
  ) {
    throw Object.assign(new Error('La reserva del anticipo perdió su lease o fue tomada por otro intento'), {
      status: 409,
      code: 'deposit_fence_lost'
    })
  }
  return {
    ok: true,
    reconciliationId: detail.reconciliationId,
    reconciliationClaimToken: detail.reconciliationClaimToken,
    paymentId: detail.ledgerPaymentId
  }
}

export async function reserveConversationalAppointmentDepositEvidence({
  reconciliationId = '',
  contactId = '',
  agentId = '',
  paymentId = '',
  reconciliationClaimToken = '',
  appointmentRequestId = '',
  calendarId = '',
  startTime = '',
  selectionRequestDraftHash = '',
  bookingOwner = '',
  terminalToolName = ''
} = {}) {
  const cleanReconciliationId = String(reconciliationId || '').trim()
  const cleanContactId = String(contactId || '').trim()
  const cleanAgentId = String(agentId || '').trim()
  const cleanPaymentId = String(paymentId || '').trim()
  const cleanReconciliationClaimToken = String(reconciliationClaimToken || '').trim()
  const cleanAppointmentRequestId = String(appointmentRequestId || '').trim()
  const cleanCalendarId = String(calendarId || '').trim()
  const cleanStartTime = String(startTime || '').trim()
  const cleanDraftHash = String(selectionRequestDraftHash || '').trim()
  const cleanBookingOwner = String(bookingOwner || '').trim()
  const cleanTerminalToolName = String(terminalToolName || '').trim()
  if (!cleanAppointmentRequestId.startsWith('conv-v2-attempt:')) {
    throw new Error('Falta la llave durable del intento de cita')
  }
  if (
    !cleanCalendarId ||
    !cleanStartTime ||
    Number.isNaN(new Date(cleanStartTime).getTime()) ||
    !/^[a-f0-9]{64}$/i.test(cleanDraftHash) ||
    cleanBookingOwner !== 'ai' ||
    cleanTerminalToolName !== 'book_appointment'
  ) {
    throw Object.assign(new Error('La reserva no conserva el contrato exacto de la cita pagada'), {
      statusCode: 409,
      code: 'appointment_deposit_binding_missing'
    })
  }

  const eventId = `${cleanReconciliationId}_consumed`
  return db.transaction(async (tx) => {
    const { reconciliationDetail } = await assertConversationalAppointmentDepositEvidence({
      reconciliationId: cleanReconciliationId,
      contactId: cleanContactId,
      agentId: cleanAgentId,
      paymentId: cleanPaymentId,
      reconciliationClaimToken: cleanReconciliationClaimToken,
      database: tx,
      lockRows: true
    })
    const paymentBindingMatches = Boolean(
      String(reconciliationDetail.appointmentSelectionCalendarId || '') === cleanCalendarId &&
      String(reconciliationDetail.appointmentSelectionStartTime || '') === cleanStartTime &&
      String(reconciliationDetail.appointmentSelectionRequestDraftHash || '') === cleanDraftHash &&
      String(reconciliationDetail.appointmentSelectionBookingOwner || '') === cleanBookingOwner &&
      String(reconciliationDetail.appointmentSelectionTerminalToolName || '') === cleanTerminalToolName
    )
    if (!paymentBindingMatches) {
      throw Object.assign(new Error('El anticipo pertenece a otro horario, borrador o terminal de cita'), {
        statusCode: 409,
        code: 'appointment_deposit_binding_mismatch'
      })
    }
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const claimToken = `cadr_${randomUUID()}`
    const detail = {
      status: 'reserved',
      agentId: cleanAgentId,
      reconciliationId: cleanReconciliationId,
      ledgerPaymentId: cleanPaymentId,
      reconciliationClaimToken: cleanReconciliationClaimToken || null,
      appointmentRequestId: cleanAppointmentRequestId,
      appointmentId: null,
      paymentPurpose: 'appointment_deposit',
      calendarId: cleanCalendarId,
      startTime: cleanStartTime,
      selectionRequestDraftHash: cleanDraftHash,
      bookingOwner: cleanBookingOwner,
      terminalToolName: cleanTerminalToolName,
      claimToken,
      leaseUntilAt: new Date(nowMs + CONVERSATIONAL_APPOINTMENT_DEPOSIT_RESERVATION_LEASE_MS).toISOString(),
      reservedAt: nowIso,
      attempts: 1
    }
    const inserted = await tx.run(
      `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, 'deposit_payment_consumed', ?)
       ON CONFLICT(id) DO NOTHING`,
      [eventId, cleanContactId, cleanAgentId, JSON.stringify(detail)]
    )
    if (dbMutationCount(inserted) === 1) {
      return {
        reserved: true,
        replayed: false,
        eventId,
        claimToken,
        leaseUntilAt: detail.leaseUntilAt
      }
    }

    const rowLock = process.env.DATABASE_URL ? ' FOR UPDATE' : ''
    const stored = await tx.get(
      `SELECT contact_id, agent_id, event_type, detail_json
       FROM conversational_agent_events WHERE id = ?${rowLock}`,
      [eventId]
    )
    const storedDetail = parseJsonField(stored?.detail_json, {})
    const sameEvidence = stored?.event_type === 'deposit_payment_consumed' &&
      String(stored?.contact_id || '') === cleanContactId &&
      String(stored?.agent_id || '') === cleanAgentId &&
      storedDetail.reconciliationId === cleanReconciliationId &&
      storedDetail.ledgerPaymentId === cleanPaymentId &&
      storedDetail.calendarId === cleanCalendarId &&
      storedDetail.startTime === cleanStartTime &&
      storedDetail.selectionRequestDraftHash === cleanDraftHash &&
      storedDetail.bookingOwner === cleanBookingOwner &&
      storedDetail.terminalToolName === cleanTerminalToolName
    if (!sameEvidence) throw Object.assign(new Error('El anticipo ya está ligado a otra operación'), { statusCode: 409 })
    if (storedDetail.status === 'consumed' && storedDetail.appointmentRequestId === cleanAppointmentRequestId) {
      return {
        reserved: false,
        consumed: true,
        replayed: true,
        appointmentId: storedDetail.appointmentId || null,
        eventId
      }
    }
    if (storedDetail.status === 'reserved' && storedDetail.appointmentRequestId === cleanAppointmentRequestId) {
      const reconciliationClaimChanged = Boolean(
        cleanReconciliationClaimToken &&
        String(storedDetail.reconciliationClaimToken || '') !== cleanReconciliationClaimToken
      )
      const renewed = {
        ...storedDetail,
        reconciliationClaimToken: cleanReconciliationClaimToken || storedDetail.reconciliationClaimToken || null,
        claimToken: reconciliationClaimChanged ? claimToken : (storedDetail.claimToken || claimToken),
        leaseUntilAt: detail.leaseUntilAt,
        lastRenewedAt: nowIso
      }
      const update = await tx.run(
        `UPDATE conversational_agent_events SET detail_json = ?
         WHERE id = ? AND event_type = 'deposit_payment_consumed' AND detail_json = ?`,
        [JSON.stringify(renewed), eventId, stored.detail_json]
      )
      if (dbMutationCount(update) !== 1) {
        throw Object.assign(new Error('Otro intento tomó el anticipo para una cita'), { statusCode: 409 })
      }
      return {
        reserved: true,
        consumed: false,
        replayed: true,
        eventId,
        claimToken: renewed.claimToken,
        leaseUntilAt: renewed.leaseUntilAt
      }
    }

    let recovery = null
    if (storedDetail.status === 'reserved') {
      const leaseUntilMs = Date.parse(storedDetail.leaseUntilAt || '')
      if (Number.isFinite(leaseUntilMs) && leaseUntilMs > nowMs) {
        throw Object.assign(new Error('El anticipo ya está reservado para otra cita'), { statusCode: 409 })
      }
      recovery = await inspectRecoverableDepositReservationAttempt(
        tx,
        storedDetail.appointmentRequestId,
        { lockRows: true }
      )
      if (!recovery.recoverable) {
        throw Object.assign(
          new Error('La reserva anterior del anticipo tiene una cita activa o un estado incierto; requiere revisión humana'),
          { statusCode: 409, code: recovery.reason }
        )
      }
    } else if (storedDetail.status !== 'released') {
      throw Object.assign(new Error('El anticipo ya está reservado para otra cita'), { statusCode: 409 })
    }

    const next = {
      ...detail,
      attempts: Math.max(0, Number(storedDetail.attempts) || 0) + 1,
      ...(recovery
        ? {
            recoveredAt: nowIso,
            recoveryReason: recovery.reason,
            previousAppointmentRequestId: storedDetail.appointmentRequestId || null,
            previousAppointmentId: recovery.appointmentId || storedDetail.appointmentId || null
          }
        : {})
    }
    const updated = await tx.run(
      `UPDATE conversational_agent_events SET detail_json = ?
       WHERE id = ? AND event_type = 'deposit_payment_consumed' AND detail_json = ?`,
      [JSON.stringify(next), eventId, stored.detail_json]
    )
    if (dbMutationCount(updated) !== 1) {
      throw Object.assign(new Error('Otro intento tomó el anticipo para una cita'), { statusCode: 409 })
    }
    return {
      reserved: true,
      replayed: false,
      recovered: Boolean(recovery),
      eventId,
      claimToken,
      leaseUntilAt: next.leaseUntilAt
    }
  })
}

export async function consumeConversationalAppointmentDepositForHumanBooking({
  reconciliationId = '',
  contactId = '',
  agentId = '',
  paymentId = '',
  reconciliationClaimToken = '',
  humanBookingEventId = '',
  calendarId = '',
  startTime = '',
  selectionRequestDraftHash = '',
  sourceMessageId = ''
} = {}) {
  const cleanReconciliationId = String(reconciliationId || '').trim()
  const cleanContactId = String(contactId || '').trim()
  const cleanAgentId = String(agentId || '').trim()
  const cleanPaymentId = String(paymentId || '').trim()
  const cleanReconciliationClaimToken = String(reconciliationClaimToken || '').trim()
  const cleanHumanBookingEventId = String(humanBookingEventId || '').trim()
  const cleanCalendarId = String(calendarId || '').trim()
  const cleanStartTime = String(startTime || '').trim()
  const cleanDraftHash = String(selectionRequestDraftHash || '').trim()
  const cleanSourceMessageId = String(sourceMessageId || '').trim()
  if (
    !cleanReconciliationId ||
    !cleanContactId ||
    !cleanAgentId ||
    !cleanPaymentId ||
    !cleanReconciliationClaimToken ||
    !cleanHumanBookingEventId.startsWith('cae_human_booking_') ||
    !cleanCalendarId ||
    !Number.isFinite(Date.parse(cleanStartTime)) ||
    !/^[a-f0-9]{64}$/i.test(cleanDraftHash) ||
    cleanSourceMessageId !== `payment-resume:${cleanReconciliationId}`
  ) {
    throw Object.assign(new Error('Falta la identidad durable de la solicitud humana ligada al anticipo'), {
      statusCode: 409,
      code: 'human_booking_deposit_identity_missing'
    })
  }

  const eventId = `${cleanReconciliationId}_consumed`
  return db.transaction(async (tx) => {
    const { reconciliationDetail } = await assertConversationalAppointmentDepositEvidence({
      reconciliationId: cleanReconciliationId,
      contactId: cleanContactId,
      agentId: cleanAgentId,
      paymentId: cleanPaymentId,
      reconciliationClaimToken: cleanReconciliationClaimToken,
      database: tx,
      lockRows: true
    })
    if (
      reconciliationDetail.appointmentSelectionBookingOwner !== 'human' ||
      reconciliationDetail.appointmentSelectionTerminalToolName !== 'request_human_booking' ||
      String(reconciliationDetail.appointmentSelectionCalendarId || '') !== cleanCalendarId ||
      String(reconciliationDetail.appointmentSelectionStartTime || '') !== cleanStartTime ||
      String(reconciliationDetail.appointmentSelectionRequestDraftHash || '') !== cleanDraftHash
    ) {
      throw Object.assign(new Error('El anticipo no pertenece a esta solicitud humana de cita'), {
        statusCode: 409,
        code: 'human_booking_deposit_contract_mismatch'
      })
    }
    const detail = {
      status: 'consumed',
      consumptionType: 'human_booking_request',
      agentId: cleanAgentId,
      reconciliationId: cleanReconciliationId,
      ledgerPaymentId: cleanPaymentId,
      reconciliationClaimToken: cleanReconciliationClaimToken,
      humanBookingEventId: cleanHumanBookingEventId,
      calendarId: cleanCalendarId,
      startTime: cleanStartTime,
      selectionRequestDraftHash: cleanDraftHash,
      bookingOwner: 'human',
      terminalToolName: 'request_human_booking',
      sourceMessageId: cleanSourceMessageId,
      appointmentId: null,
      consumedAt: new Date().toISOString()
    }
    const inserted = await tx.run(
      `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, 'deposit_payment_consumed', ?)
       ON CONFLICT(id) DO NOTHING`,
      [eventId, cleanContactId, cleanAgentId, JSON.stringify(detail)]
    )
    if (dbMutationCount(inserted) === 1) {
      return { consumed: true, replayed: false, eventId, detail }
    }
    const rowLock = process.env.DATABASE_URL ? ' FOR UPDATE' : ''
    const stored = await tx.get(
      `SELECT contact_id, agent_id, event_type, detail_json
       FROM conversational_agent_events WHERE id = ?${rowLock}`,
      [eventId]
    )
    const storedDetail = parseJsonField(stored?.detail_json, {})
    const sameContract = stored?.event_type === 'deposit_payment_consumed' &&
      String(stored?.contact_id || '') === cleanContactId &&
      String(stored?.agent_id || '') === cleanAgentId &&
      storedDetail.status === 'consumed' &&
      storedDetail.consumptionType === 'human_booking_request' &&
      storedDetail.reconciliationId === cleanReconciliationId &&
      storedDetail.ledgerPaymentId === cleanPaymentId &&
      storedDetail.reconciliationClaimToken === cleanReconciliationClaimToken &&
      storedDetail.humanBookingEventId === cleanHumanBookingEventId &&
      storedDetail.calendarId === cleanCalendarId &&
      storedDetail.startTime === cleanStartTime &&
      storedDetail.selectionRequestDraftHash === cleanDraftHash &&
      storedDetail.bookingOwner === 'human' &&
      storedDetail.terminalToolName === 'request_human_booking' &&
      storedDetail.sourceMessageId === cleanSourceMessageId
    if (!sameContract) {
      throw Object.assign(new Error('El anticipo ya fue consumido por otra operación'), {
        statusCode: 409,
        code: 'human_booking_deposit_consumption_conflict'
      })
    }
    return { consumed: true, replayed: true, eventId, detail: storedDetail }
  })
}

export async function consumeConversationalAppointmentDepositEvidence({
  reconciliationId = '',
  contactId = '',
  agentId = '',
  paymentId = '',
  reconciliationClaimToken = '',
  reservationClaimToken = '',
  appointmentRequestId = '',
  appointmentId = '',
  allowProcessingAppointmentRequest = false,
  database = db
} = {}) {
  const cleanReconciliationId = String(reconciliationId || '').trim()
  const cleanContactId = String(contactId || '').trim()
  const cleanAgentId = String(agentId || '').trim()
  const cleanPaymentId = String(paymentId || '').trim()
  const cleanReconciliationClaimToken = String(reconciliationClaimToken || '').trim()
  const cleanReservationClaimToken = String(reservationClaimToken || '').trim()
  const cleanAppointmentRequestId = String(appointmentRequestId || '').trim()
  const cleanAppointmentId = String(appointmentId || '').trim()
  if (!cleanAppointmentRequestId || !cleanAppointmentId) {
    throw new Error('Falta la cita canónica para consumir el anticipo')
  }
  if (cleanReconciliationClaimToken && !cleanReservationClaimToken) {
    throw Object.assign(new Error('Falta el fencing token de la reserva del anticipo'), {
      statusCode: 409,
      code: 'appointment_deposit_consume_fence_missing'
    })
  }

  return database.transaction(async (tx) => {
    // Revalidar el ledger dentro de la misma transaccion que consume la
    // evidencia. La validacion inicial del Runner no basta: el pago pudo ser
    // reembolsado o anulado mientras se creaba la cita.
    await assertConversationalAppointmentDepositEvidence({
      reconciliationId: cleanReconciliationId,
      contactId: cleanContactId,
      agentId: cleanAgentId,
      paymentId: cleanPaymentId,
      reconciliationClaimToken: cleanReconciliationClaimToken,
      database: tx,
      lockRows: true
    })

    const rowLock = process.env.DATABASE_URL ? ' FOR UPDATE' : ''
    const appointmentRequest = await tx.get(
      `SELECT status, appointment_id
       FROM appointment_creation_requests WHERE client_request_id = ?${rowLock}`,
      [cleanAppointmentRequestId]
    )
    const appointment = await tx.get(
      `SELECT id, contact_id, appointment_status, status, deleted_at
       FROM appointments WHERE id = ?${rowLock}`,
      [cleanAppointmentId]
    )
    const appointmentStatus = normalizeVerifiedPaymentStatus(appointment?.appointment_status || appointment?.status)
    const appointmentRequestMatches = appointmentRequest?.status === 'completed'
      ? String(appointmentRequest?.appointment_id || '') === cleanAppointmentId
      : allowProcessingAppointmentRequest === true && appointmentRequest?.status === 'processing'
    if (
      !appointmentRequestMatches ||
      !appointment ||
      String(appointment.contact_id || '') !== cleanContactId ||
      appointment.deleted_at ||
      ['cancelled', 'canceled', 'deleted'].includes(appointmentStatus)
    ) {
      throw new Error('La cita canónica no existe o ya no está activa; el anticipo no se consumió')
    }

    const eventId = `${cleanReconciliationId}_consumed`
    const stored = await tx.get(
      `SELECT contact_id, agent_id, event_type, detail_json
       FROM conversational_agent_events WHERE id = ?${rowLock}`,
      [eventId]
    )
    const storedDetail = parseJsonField(stored?.detail_json, {})
    if (
      stored?.event_type !== 'deposit_payment_consumed' ||
      String(stored?.contact_id || '') !== cleanContactId ||
      String(stored?.agent_id || '') !== cleanAgentId ||
      storedDetail.reconciliationId !== cleanReconciliationId ||
      storedDetail.ledgerPaymentId !== cleanPaymentId ||
      storedDetail.appointmentRequestId !== cleanAppointmentRequestId ||
      (cleanReservationClaimToken && storedDetail.claimToken !== cleanReservationClaimToken) ||
      (cleanReconciliationClaimToken && storedDetail.reconciliationClaimToken !== cleanReconciliationClaimToken)
    ) {
      throw Object.assign(new Error('El anticipo no está reservado para este intento de cita'), { statusCode: 409 })
    }
    if (storedDetail.status === 'consumed') {
      if (storedDetail.appointmentId !== cleanAppointmentId) {
        throw Object.assign(new Error('El anticipo ya fue consumido por otra cita'), { statusCode: 409 })
      }
      return { consumed: true, replayed: true, eventId }
    }
    if (storedDetail.status !== 'reserved') {
      throw Object.assign(new Error('La reserva del anticipo ya no está activa'), { statusCode: 409 })
    }
    const next = {
      ...storedDetail,
      status: 'consumed',
      appointmentId: cleanAppointmentId,
      consumedAt: new Date().toISOString()
    }
    const updated = await tx.run(
      `UPDATE conversational_agent_events SET detail_json = ?
       WHERE id = ? AND event_type = 'deposit_payment_consumed' AND detail_json = ?`,
      [JSON.stringify(next), eventId, stored.detail_json]
    )
    if (dbMutationCount(updated) !== 1) {
      throw Object.assign(new Error('No se pudo consumir el anticipo de forma exclusiva'), { statusCode: 409 })
    }
    return { consumed: true, replayed: false, eventId }
  })
}

export async function releaseConversationalAppointmentDepositEvidence({
  reconciliationId = '',
  contactId = '',
  agentId = '',
  paymentId = '',
  appointmentRequestId = '',
  reservationClaimToken = '',
  reconciliationClaimToken = '',
  reason = 'appointment_not_created'
} = {}) {
  const eventId = `${String(reconciliationId || '').trim()}_consumed`
  const stored = await db.get(
    `SELECT contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events WHERE id = ?`,
    [eventId]
  )
  if (!stored) return { released: false, missing: true }
  const detail = parseJsonField(stored.detail_json, {})
  const cleanReservationClaimToken = String(reservationClaimToken || '').trim()
  const cleanReconciliationClaimToken = String(reconciliationClaimToken || '').trim()
  const sameReservation = stored.event_type === 'deposit_payment_consumed' &&
    String(stored.contact_id || '') === String(contactId || '').trim() &&
    String(stored.agent_id || '') === String(agentId || '').trim() &&
    detail.ledgerPaymentId === String(paymentId || '').trim() &&
    detail.appointmentRequestId === String(appointmentRequestId || '').trim() &&
    cleanReservationClaimToken &&
    detail.claimToken === cleanReservationClaimToken &&
    (!cleanReconciliationClaimToken || detail.reconciliationClaimToken === cleanReconciliationClaimToken)
  if (!sameReservation) throw Object.assign(new Error('No se puede liberar el anticipo de otra cita'), { statusCode: 409 })
  if (detail.status === 'released') return { released: true, replayed: true }
  if (detail.status !== 'reserved') return { released: false, consumed: detail.status === 'consumed' }
  const next = {
    ...detail,
    status: 'released',
    releasedAt: new Date().toISOString(),
    releaseReason: String(reason || 'appointment_not_created').slice(0, 240)
  }
  const updated = await db.run(
    `UPDATE conversational_agent_events SET detail_json = ?
     WHERE id = ? AND event_type = 'deposit_payment_consumed' AND detail_json = ?`,
    [JSON.stringify(next), eventId, stored.detail_json]
  )
  return { released: dbMutationCount(updated) === 1, replayed: false }
}

export async function completeConversationalAgentSalePaymentFromInvoice({
  contactId = '',
  invoiceId = '',
  paymentId = '',
  amount = null,
  currency = '',
  status = '',
  paymentMode = '',
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

  let rows = await db.all(
    `SELECT id, contact_id, agent_id, event_type, detail_json
     FROM conversational_agent_events
     WHERE contact_id = ? AND event_type IN (
       'payment_link_created',
       'payment_link_reused',
       'deposit_transfer_pending_review'
     )
     ORDER BY created_at DESC
     LIMIT 80`,
    [cleanContactId]
  )

  let matchedDetail = null
  let matchedSourceEvent = null
  for (const row of rows) {
    const detail = parseJsonField(row.detail_json, {})
    const storedInvoiceId = String(
      detail.ledgerPaymentId || detail.invoiceId || detail.invoice_id || detail.paymentId || detail.payment_id || ''
    ).trim()
    const alternateInvoiceId = String(detail.invoiceId || detail.invoice_id || detail.paymentId || detail.payment_id || '').trim()
    if (storedInvoiceId && (invoiceCandidates.includes(storedInvoiceId) || invoiceCandidates.includes(alternateInvoiceId))) {
      matchedDetail = detail
      matchedSourceEvent = row
      break
    }
  }

  if (!matchedDetail) {
    await recoverPendingConversationalPaymentSourceBindings({
      limit: 80,
      contactId: cleanContactId,
      reconcilePaid: false
    }).catch(() => {})
    rows = await db.all(
      `SELECT id, contact_id, agent_id, event_type, detail_json
       FROM conversational_agent_events
       WHERE contact_id = ? AND event_type IN (
         'payment_link_created',
         'payment_link_reused',
         'deposit_transfer_pending_review'
       )
       ORDER BY created_at DESC
       LIMIT 80`,
      [cleanContactId]
    )
    for (const row of rows) {
      const detail = parseJsonField(row.detail_json, {})
      const storedInvoiceId = String(
        detail.ledgerPaymentId || detail.invoiceId || detail.invoice_id || detail.paymentId || detail.payment_id || ''
      ).trim()
      const alternateInvoiceId = String(detail.invoiceId || detail.invoice_id || detail.paymentId || detail.payment_id || '').trim()
      if (storedInvoiceId && (invoiceCandidates.includes(storedInvoiceId) || invoiceCandidates.includes(alternateInvoiceId))) {
        matchedDetail = detail
        matchedSourceEvent = row
        break
      }
    }
  }

  if (!matchedDetail) return { matched: false, reason: 'invoice_not_created_by_conversational_agent' }

  const detailAgentId = String(matchedDetail.agentId || matchedDetail.agent_id || '').trim()
  const rowAgentId = String(matchedSourceEvent?.agent_id || '').trim()
  if (detailAgentId && rowAgentId && detailAgentId !== rowAgentId) {
    return rejectConversationalPaymentReconciliation({
      contactId: cleanContactId,
      agentId: detailAgentId,
      sourceEventId: matchedSourceEvent?.id,
      reason: 'payment_source_agent_mismatch'
    })
  }
  // La identidad del agente debe venir de la fuente durable del cobro. El
  // estado actual del contacto sólo sirve para decidir si se preserva; jamás
  // para adjudicarle un webhook legacy al agente que hoy atiende el chat.
  const matchedAgentId = detailAgentId || rowAgentId
  const paymentChannel = normalizeConversationStateChannel(matchedDetail.channel || 'whatsapp')
  const state = matchedAgentId
    ? await getConversationState(cleanContactId, { agentId: matchedAgentId, channel: paymentChannel })
    : await getConversationState(cleanContactId, { channel: paymentChannel })
  const agentId = matchedAgentId || null
  const agent = agentId ? await getConversationalAgent(agentId).catch(() => null) : null
  const agentMissing = !agent
  const cleanCurrency = normalizeVerifiedCurrency(currency || matchedDetail.currency || '')
  const cleanInvoiceId = String(matchedDetail.invoiceId || matchedDetail.paymentId || invoiceCandidates[0]).trim()

    const reportedStatus = normalizeVerifiedPaymentStatus(status)
    if (!reportedStatus || !VERIFIED_CONVERSATIONAL_PAYMENT_STATUSES.has(reportedStatus)) {
      return rejectConversationalPaymentReconciliation({
        contactId: cleanContactId,
        agentId,
        sourceEventId: matchedSourceEvent?.id,
        reason: reportedStatus ? 'payment_status_not_successful' : 'payment_status_missing'
      })
    }

    const expectedCurrency = normalizeVerifiedCurrency(matchedDetail.currency)
    const expectedAmountMinor = amountInCurrencyMinorUnits(matchedDetail.amount, expectedCurrency)
    const reportedAmountMinor = amountInCurrencyMinorUnits(amount, cleanCurrency)
    if (!expectedCurrency || expectedAmountMinor === null || !cleanCurrency || reportedAmountMinor === null) {
      return rejectConversationalPaymentReconciliation({
        contactId: cleanContactId,
        agentId,
        sourceEventId: matchedSourceEvent?.id,
        reason: 'payment_amount_or_currency_missing'
      })
    }
    if (cleanCurrency !== expectedCurrency || reportedAmountMinor !== expectedAmountMinor) {
      return rejectConversationalPaymentReconciliation({
        contactId: cleanContactId,
        agentId,
        sourceEventId: matchedSourceEvent?.id,
        reason: cleanCurrency !== expectedCurrency ? 'payment_currency_mismatch' : 'payment_amount_mismatch'
      })
    }

    const expectedLedgerPaymentId = String(
      matchedDetail.ledgerPaymentId || matchedDetail.invoiceId || matchedDetail.paymentId || ''
    ).trim()
    const ledgerRows = expectedLedgerPaymentId
      ? await db.all(
          `SELECT * FROM payments
           WHERE contact_id = ? AND (id = ? OR ghl_invoice_id = ?)
           ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
           LIMIT 2`,
          [cleanContactId, expectedLedgerPaymentId, expectedLedgerPaymentId, expectedLedgerPaymentId]
        )
      : []
    if (ledgerRows.length !== 1) {
      return rejectConversationalPaymentReconciliation({
        contactId: cleanContactId,
        agentId,
        sourceEventId: matchedSourceEvent?.id,
        reason: ledgerRows.length ? 'payment_ledger_ambiguous' : 'payment_ledger_missing'
      })
    }
    const ledger = ledgerRows[0]
    const ledgerStatus = normalizeVerifiedPaymentStatus(ledger.status)
    const ledgerCurrency = normalizeVerifiedCurrency(ledger.currency)
    const ledgerAmountMinor = amountInCurrencyMinorUnits(ledger.amount, ledgerCurrency)
    const expectedProvider = String(matchedDetail.paymentProvider || '').trim().toLowerCase()
    const ledgerProvider = String(ledger.payment_provider || '').trim().toLowerCase()
    const expectedEnvironment = normalizeVerifiedPaymentEnvironment(matchedDetail.paymentEnvironment)
    const reportedEnvironment = normalizeVerifiedPaymentEnvironment(paymentMode)
    const ledgerEnvironment = normalizeVerifiedPaymentEnvironment(ledger.payment_mode)
    if (!VERIFIED_CONVERSATIONAL_PAYMENT_STATUSES.has(ledgerStatus)) {
      return rejectConversationalPaymentReconciliation({
        contactId: cleanContactId,
        agentId,
        sourceEventId: matchedSourceEvent?.id,
        reason: 'payment_ledger_not_paid'
      })
    }
    if (
      ledgerCurrency !== expectedCurrency ||
      ledgerAmountMinor === null ||
      ledgerAmountMinor !== expectedAmountMinor
    ) {
      return rejectConversationalPaymentReconciliation({
        contactId: cleanContactId,
        agentId,
        sourceEventId: matchedSourceEvent?.id,
        reason: ledgerCurrency !== expectedCurrency ? 'payment_ledger_currency_mismatch' : 'payment_ledger_amount_mismatch'
      })
    }
    if (expectedProvider && ledgerProvider !== expectedProvider) {
      return rejectConversationalPaymentReconciliation({
        contactId: cleanContactId,
        agentId,
        sourceEventId: matchedSourceEvent?.id,
        reason: 'payment_provider_mismatch'
      })
    }
    if (!expectedEnvironment || !reportedEnvironment || !ledgerEnvironment) {
      return rejectConversationalPaymentReconciliation({
        contactId: cleanContactId,
        agentId,
        sourceEventId: matchedSourceEvent?.id,
        reason: 'payment_environment_missing'
      })
    }
    if (expectedEnvironment !== reportedEnvironment || expectedEnvironment !== ledgerEnvironment) {
      return rejectConversationalPaymentReconciliation({
        contactId: cleanContactId,
        agentId,
        sourceEventId: matchedSourceEvent?.id,
        reason: 'payment_environment_mismatch'
      })
    }
    if (expectedEnvironment !== 'live') {
      return rejectConversationalPaymentReconciliation({
        contactId: cleanContactId,
        agentId,
        sourceEventId: matchedSourceEvent?.id,
        reason: 'payment_environment_not_live'
      })
    }

    const purpose = resolveConversationalPaymentPurpose(matchedDetail)
    if (!purpose) {
      return rejectConversationalPaymentReconciliation({
        contactId: cleanContactId,
        agentId,
        sourceEventId: matchedSourceEvent?.id,
        reason: 'payment_purpose_missing_or_invalid'
      })
    }
    // La acción posterior queda sellada en la fuente durable del cobro. No se
    // vuelve a leer del borrador actual del agente porque pudo cambiar mientras
    // el cliente estaba pagando.
    const afterPayment = normalizeConversationalAfterPayment(matchedDetail.afterPayment)
    const appointmentSourceBinding = purpose.appointmentDeposit
      ? await inspectAppointmentDepositSourceBinding({
          sourceEvent: matchedSourceEvent,
          sourceDetail: matchedDetail,
          contactId: cleanContactId,
          agentId
        })
      : { ok: true, terminalBinding: null }
    const appointmentTerminalBinding = appointmentSourceBinding.terminalBinding || null
    const appointmentSourceBindingInvalid = purpose.appointmentDeposit && !appointmentSourceBinding.ok
    const reconciliationId = paymentReconciliationEventId({
      contactId: cleanContactId,
      agentId,
      sourceEventId: matchedSourceEvent.id,
      ledgerPaymentId: ledger.id
    })
    const claim = await claimConversationalPaymentReconciliation({
      eventId: reconciliationId,
      contactId: cleanContactId,
      agentId,
      detail: {
        sourceEventId: matchedSourceEvent.id,
        ledgerPaymentId: ledger.id,
        invoiceId: cleanInvoiceId,
        amount: Number(ledger.amount),
        currency: ledgerCurrency,
        paymentEnvironment: ledgerEnvironment,
        paymentPurpose: purpose.paymentPurpose,
        afterPayment,
        appointmentDeposit: purpose.appointmentDeposit,
        autoResumeAllowed: purpose.autoResumeAllowed !== false && !appointmentSourceBindingInvalid && !agentMissing,
        manualReviewOnly: purpose.manualReviewOnly === true || appointmentSourceBindingInvalid || agentMissing,
        appointmentSelectionEventId: appointmentSourceBinding.ok ? matchedDetail.appointmentSelectionEventId : null,
        appointmentSelectionCalendarId: appointmentSourceBinding.ok ? matchedDetail.appointmentSelectionCalendarId : null,
        appointmentSelectionStartTime: appointmentSourceBinding.ok ? matchedDetail.appointmentSelectionStartTime : null,
        appointmentSelectionVerifiedAt: appointmentSourceBinding.ok ? matchedDetail.appointmentSelectionVerifiedAt : null,
        appointmentSelectionRequestDraftHash: appointmentSourceBinding.ok ? matchedDetail.appointmentSelectionRequestDraftHash : null,
        appointmentSelectionBookingOwner: appointmentTerminalBinding?.bookingOwner || null,
        appointmentSelectionTerminalToolName: appointmentTerminalBinding?.terminalToolName || null,
        channel: paymentChannel,
        reportedStatus
      }
    })
    if (claim.completed) {
      return { ...(claim.result || {}), matched: true, alreadyCompleted: true }
    }
    if (!claim.claimed) {
      return { matched: true, processing: true, agentId, invoiceId: cleanInvoiceId }
    }

    try {
      let progress = claim.detail
      if (purpose.appointmentDeposit) {
        if (
          progress.autoResumeAllowed === false ||
          progress.manualReviewOnly === true ||
          purpose.autoResumeAllowed === false ||
          purpose.manualReviewOnly === true ||
          appointmentSourceBindingInvalid ||
          agentMissing
        ) {
          if (!progress.manualReviewEventAppliedAt) {
            progress = await checkpointConversationalPaymentReconciliation(reconciliationId, claim.claimToken, {
              autoResumeAllowed: false,
              manualReviewOnly: true
            })
            const review = await routeVerifiedAppointmentDepositToHumanReview({
              reconciliationId,
              reconciliationClaimToken: claim.claimToken,
              contactId: cleanContactId,
              agentId,
              channel: paymentChannel,
              sourceEventId: matchedSourceEvent.id,
              ledgerPaymentId: ledger.id,
              amount: Number(ledger.amount),
              currency: ledgerCurrency,
              ...(agentMissing ? { conversationAgentId: null } : {}),
              reason: agentMissing
                ? 'native_agent_missing_or_changed'
                : appointmentSourceBindingInvalid
                  ? appointmentSourceBinding.reason
                  : 'payment_source_requires_manual_review'
            })
            progress = await checkpointConversationalPaymentReconciliation(reconciliationId, claim.claimToken, {
              autoResumeAllowed: false,
              manualReviewOnly: true,
              manualReviewEventAppliedAt: new Date().toISOString(),
              manualReviewNotification: review.notification || null
            })
          }
          const result = {
            matched: true,
            signal: 'appointment_deposit_manual_review_required',
            objectiveCompleted: false,
            resumed: false,
            queued: false,
            manualReviewRequired: true,
            needsNewSlot: true,
            agentId,
            invoiceId: cleanInvoiceId
          }
          await settleConversationalPaymentReconciliation(reconciliationId, claim.claimToken, { result })
          return result
        }
        const currentAppointmentState = await getConversationState(
          cleanContactId,
          { agentId, channel: paymentChannel }
        ).catch(() => null)
        const recoveredTerminal = await completeDurableAppointmentPaymentTerminalEffects({
          reconciliationId,
          reconciliationClaimToken: claim.claimToken,
          contactId: cleanContactId,
          agentId,
          paymentId: ledger.id,
          channel: paymentChannel,
          reconciliationDetail: progress
        })
        const terminalAppointmentAction = recoveredTerminal.ok === true || recoveredTerminal.terminalConsumed === true
        if (!progress.resumeCompletedAt && recoveredTerminal.ok) {
          progress = await checkpointConversationalPaymentReconciliation(reconciliationId, claim.claimToken, {
            conversationActivatedAt: progress.conversationActivatedAt || new Date().toISOString(),
            verifiedEventAppliedAt: progress.verifiedEventAppliedAt || new Date().toISOString(),
            resumeCompletedAt: new Date().toISOString(),
            resumeResult: {
              resumed: true,
              queued: false,
              recoveredFromDurableEvent: true,
              reason: recoveredTerminal.reason,
              terminalType: recoveredTerminal.terminalType,
              notification: recoveredTerminal.notification || null,
              replyDelivered: recoveredTerminal.reply?.sent === true
            }
          })
        }
        if (!progress.resumeCompletedAt && recoveredTerminal.manualReviewRequired) {
          progress = await checkpointConversationalPaymentReconciliation(reconciliationId, claim.claimToken, {
            autoResumeAllowed: false,
            manualReviewOnly: true
          })
          const review = await routeVerifiedAppointmentDepositToHumanReview({
            reconciliationId,
            reconciliationClaimToken: claim.claimToken,
            contactId: cleanContactId,
            agentId,
            channel: paymentChannel,
            sourceEventId: matchedSourceEvent.id,
            ledgerPaymentId: ledger.id,
            amount: Number(ledger.amount),
            currency: ledgerCurrency,
            reason: recoveredTerminal.reason || 'durable_appointment_requires_manual_review',
            preserveExistingState: Boolean(
              !currentAppointmentState ||
              currentAppointmentState.status !== 'active' ||
              currentAppointmentState.signal
            )
          })
          progress = await checkpointConversationalPaymentReconciliation(reconciliationId, claim.claimToken, {
            autoResumeAllowed: false,
            manualReviewOnly: true,
            manualReviewEventAppliedAt: new Date().toISOString(),
            manualReviewNotification: review.notification || null,
            resumeCompletedAt: new Date().toISOString(),
            resumeResult: {
              resumed: false,
              queued: false,
              manualReviewRequired: true,
              reason: recoveredTerminal.reason,
              notification: review.notification || null,
              replyDelivered: review.reply?.sent === true
            }
          })
        }
        const preexistingStateBlocksResume = Boolean(
          !progress.resumeCompletedAt &&
          !terminalAppointmentAction &&
          (
            !currentAppointmentState ||
            currentAppointmentState.status !== 'active' ||
            Boolean(currentAppointmentState.signal)
          )
        )
        if (preexistingStateBlocksResume) {
          progress = await checkpointConversationalPaymentReconciliation(reconciliationId, claim.claimToken, {
            autoResumeAllowed: false,
            manualReviewOnly: true
          })
          const review = await routeVerifiedAppointmentDepositToHumanReview({
            reconciliationId,
            reconciliationClaimToken: claim.claimToken,
            contactId: cleanContactId,
            agentId,
            channel: paymentChannel,
            sourceEventId: matchedSourceEvent.id,
            ledgerPaymentId: ledger.id,
            amount: Number(ledger.amount),
            currency: ledgerCurrency,
            reason: 'conversation_state_not_runnable_before_payment_resume',
            preserveExistingState: true
          })
          progress = await checkpointConversationalPaymentReconciliation(reconciliationId, claim.claimToken, {
            autoResumeAllowed: false,
            manualReviewOnly: true,
            manualReviewEventAppliedAt: new Date().toISOString(),
            manualReviewNotification: review.notification || null,
            resumeCompletedAt: new Date().toISOString(),
            resumeResult: {
              resumed: false,
              queued: false,
              manualReviewRequired: true,
              reason: 'conversation_state_not_runnable_before_payment_resume',
              notification: review.notification || null
            }
          })
        }
        if (
          !progress.resumeCompletedAt &&
          !preexistingStateBlocksResume &&
          conversationalPaymentAfterStateInspectionHookForTest
        ) {
          await conversationalPaymentAfterStateInspectionHookForTest({
            reconciliationId,
            contactId: cleanContactId,
            agentId,
            channel: paymentChannel,
            inspectedState: currentAppointmentState
          })
        }
        if (!progress.conversationActivatedAt && !progress.resumeCompletedAt) {
          // No escribimos el estado aquí. Ya se observó active/null y el Runner
          // lo vuelve a validar; reactivarlo abriría una carrera capaz de pisar
          // un takeover o una pausa humana ocurridos después de la lectura.
          progress = await checkpointConversationalPaymentReconciliation(reconciliationId, claim.claimToken, {
            conversationActivatedAt: new Date().toISOString()
          })
        }
        if (!progress.verifiedEventAppliedAt) {
          await recordConversationalAgentEvent({
            eventId: `${reconciliationId}_verified`,
            contactId: cleanContactId,
            eventType: 'deposit_payment_verified',
            detail: {
              agentId,
              amount: Number(ledger.amount),
              currency: ledgerCurrency,
              paymentEnvironment: ledgerEnvironment,
              ledgerPaymentId: ledger.id,
              sourceEventId: matchedSourceEvent.id,
              paymentPurpose: purpose.paymentPurpose,
              appointmentDeposit: purpose.appointmentDeposit,
              appointmentSelectionBookingOwner: appointmentTerminalBinding.bookingOwner,
              appointmentSelectionTerminalToolName: appointmentTerminalBinding.terminalToolName,
              reconciliationId
            },
            throwOnError: true
          })
          progress = await checkpointConversationalPaymentReconciliation(reconciliationId, claim.claimToken, {
            verifiedEventAppliedAt: new Date().toISOString()
          })
        }
        let resumed = progress.resumeResult || null
        if (!progress.resumeCompletedAt) {
          resumed = await withConversationalPaymentReconciliationHeartbeat(
            reconciliationId,
            claim.claimToken,
            () => resumeConversationalAppointmentAfterVerifiedPayment({
              reconciliationId,
              reconciliationClaimToken: claim.claimToken,
              contactId: cleanContactId,
              agentId,
              channel: paymentChannel,
              amount: Number(ledger.amount),
              currency: ledgerCurrency,
              paymentEnvironment: ledgerEnvironment,
              paymentPurpose: 'appointment_deposit',
              bookingOwner: appointmentTerminalBinding.bookingOwner,
              terminalToolName: appointmentTerminalBinding.terminalToolName
            })
          )
          const durableAfterRun = await completeDurableAppointmentPaymentTerminalEffects({
            reconciliationId,
            reconciliationClaimToken: claim.claimToken,
            contactId: cleanContactId,
            agentId,
            paymentId: ledger.id,
            channel: paymentChannel,
            reconciliationDetail: progress
          })
          if (durableAfterRun.ok) {
            resumed = {
              resumed: true,
              queued: false,
              recoveredFromDurableEvent: true,
              reason: durableAfterRun.reason,
              terminalType: durableAfterRun.terminalType,
              notification: durableAfterRun.notification || null,
              replyDelivered: durableAfterRun.reply?.sent === true
            }
          } else if (durableAfterRun.manualReviewRequired || resumed?.manualReviewRequired) {
            progress = await checkpointConversationalPaymentReconciliation(reconciliationId, claim.claimToken, {
              autoResumeAllowed: false,
              manualReviewOnly: true
            })
            const stateBeforeReview = await getConversationState(
              cleanContactId,
              { agentId, channel: paymentChannel }
            ).catch(() => null)
            const review = await routeVerifiedAppointmentDepositToHumanReview({
              reconciliationId,
              reconciliationClaimToken: claim.claimToken,
              contactId: cleanContactId,
              agentId,
              channel: paymentChannel,
              sourceEventId: matchedSourceEvent.id,
              ledgerPaymentId: ledger.id,
              amount: Number(ledger.amount),
              currency: ledgerCurrency,
              reason: durableAfterRun.reason || resumed?.reason || 'appointment_terminal_configuration_changed',
              preserveExistingState: Boolean(
                !stateBeforeReview ||
                stateBeforeReview.status !== 'active' ||
                stateBeforeReview.signal
              )
            })
            resumed = {
              resumed: false,
              queued: false,
              manualReviewRequired: true,
              reason: durableAfterRun.reason || resumed?.reason || 'appointment_terminal_configuration_changed',
              notification: review.notification || null
            }
          } else if (!resumed?.resumed && !resumed?.queued) {
            throw new Error(resumed?.reason || 'No se pudo reanudar la cita después de verificar el anticipo')
          } else if (!(conversationalPaymentResumeHandlerForTest && resumed?.resumed && resumed?.sent)) {
            throw new Error('La terminal reportó éxito sin conservar una cita o solicitud humana durable')
          }
          progress = await checkpointConversationalPaymentReconciliation(reconciliationId, claim.claimToken, {
            ...(resumed?.manualReviewRequired
              ? { autoResumeAllowed: false, manualReviewOnly: true }
              : {}),
            resumeCompletedAt: new Date().toISOString(),
            resumeResult: {
              resumed: Boolean(resumed?.resumed),
              queued: Boolean(resumed?.queued),
              reason: resumed?.reason || null,
              manualReviewRequired: resumed?.manualReviewRequired === true,
              notification: resumed?.notification || null
            }
          })
          resumed = progress.resumeResult
        }
        let postPaymentHandoff = progress.afterPaymentActionResult || null
        if (
          afterPayment === 'handoff' &&
          !resumed?.manualReviewRequired &&
          !progress.afterPaymentActionCompletedAt
        ) {
          postPaymentHandoff = await applyVerifiedPaymentHandoff({
            reconciliationId,
            contactId: cleanContactId,
            agentId,
            channel: paymentChannel,
            invoiceId: cleanInvoiceId,
            amount: Number(ledger.amount),
            currency: ledgerCurrency,
            sourceEventId: matchedSourceEvent.id,
            // La terminal de agenda ya generó su notificación durable. Sólo
            // cambiamos la propiedad del chat para no mandar dos avisos.
            notify: false,
            allowCompletedAppointmentState: true,
            allowActiveState: false
          })
          if (postPaymentHandoff?.handoffCompleted) {
            progress = await checkpointConversationalPaymentReconciliation(reconciliationId, claim.claimToken, {
              afterPaymentActionCompletedAt: new Date().toISOString(),
              afterPaymentActionResult: postPaymentHandoff
            })
          }
        }
        const result = {
          matched: true,
          signal: resumed?.manualReviewRequired
            ? 'appointment_deposit_manual_review_required'
            : (postPaymentHandoff?.handoffCompleted ? 'ready_for_human' : 'deposit_payment_verified'),
          objectiveCompleted: postPaymentHandoff?.handoffCompleted === true,
          resumed: Boolean(resumed?.resumed),
          queued: Boolean(resumed?.queued),
          manualReviewRequired: resumed?.manualReviewRequired === true,
          afterPayment,
          handoffCompleted: postPaymentHandoff?.handoffCompleted === true,
          agentId,
          invoiceId: cleanInvoiceId
        }
        await settleConversationalPaymentReconciliation(reconciliationId, claim.claimToken, { result })
        return result
      }

      const technicalSummary = `Invoice ${cleanInvoiceId} · ${Number(ledger.amount)} ${ledgerCurrency}`
      const conversationSummary = cleanCompletionDisplayText(matchedDetail.resumen || matchedDetail.summary || '')
      const reason = 'Pago confirmado del link enviado por el agente'
      let result = null

      if (afterPayment === 'handoff') {
        let handoff = progress.afterPaymentActionResult || null
        if (!progress.afterPaymentActionCompletedAt) {
          handoff = await applyVerifiedPaymentHandoff({
            reconciliationId,
            contactId: cleanContactId,
            // La identidad durable de la fuente manda. Si el agente ya no existe
            // o un evento legacy no la conserva, verificamos el pago pero jamás
            // mutamos el estado de un agente que hoy atiende el mismo contacto.
            agentId: matchedAgentId,
            channel: paymentChannel,
            invoiceId: cleanInvoiceId,
            amount: Number(ledger.amount),
            currency: ledgerCurrency,
            sourceEventId: matchedSourceEvent.id,
            notify: true,
            allowStateMutation: Boolean(matchedAgentId) && !agentMissing
          })
          if (handoff?.handoffCompleted) {
            progress = await checkpointConversationalPaymentReconciliation(reconciliationId, claim.claimToken, {
              afterPaymentActionCompletedAt: new Date().toISOString(),
              afterPaymentActionResult: handoff,
              notificationAppliedAt: new Date().toISOString()
            })
          }
        }
        result = {
          matched: true,
          signal: handoff?.handoffCompleted ? 'ready_for_human' : 'payment_confirmed_state_preserved',
          objectiveCompleted: handoff?.handoffCompleted === true,
          handoffCompleted: handoff?.handoffCompleted === true,
          statePreserved: handoff?.statePreserved === true,
          afterPayment,
          agentId,
          invoiceId: cleanInvoiceId
        }
      } else {
        let currentPaymentState = agentId
          ? await getConversationState(cleanContactId, {
              agentId,
              channel: paymentChannel
            }).catch(() => null)
          : await getConversationState(cleanContactId, {
              channel: paymentChannel
            }).catch(() => null)
        if (!currentPaymentState && agentId) {
          currentPaymentState = await getConversationState(cleanContactId, {
            channel: paymentChannel
          }).catch(() => null)
        }
        const stateBelongsToAgent = Boolean(
          currentPaymentState &&
          (!currentPaymentState.agentId || currentPaymentState.agentId === agentId)
        )
        const shouldContinueWithAgent = Boolean(
          agent?.enabled &&
          stateBelongsToAgent &&
          currentPaymentState?.status === 'active' &&
          !currentPaymentState?.signal
        )

        if (shouldContinueWithAgent) {
          if (!progress.verifiedEventAppliedAt) {
            await recordConversationalAgentEvent({
              eventId: `${reconciliationId}_verified`,
              contactId: cleanContactId,
              eventType: 'payment_verified_for_conversation',
              detail: {
                agentId,
                invoiceId: cleanInvoiceId,
                amount: Number(ledger.amount),
                currency: ledgerCurrency,
                paymentEnvironment: ledgerEnvironment,
                paymentPurpose: purpose.paymentPurpose,
                afterPayment,
                sourceEventId: matchedSourceEvent.id,
                reconciliationId
              },
              throwOnError: true
            })
            progress = await checkpointConversationalPaymentReconciliation(reconciliationId, claim.claimToken, {
              verifiedEventAppliedAt: new Date().toISOString()
            })
          }
          let resumed = progress.resumeResult || null
          if (!progress.resumeCompletedAt) {
            resumed = await withConversationalPaymentReconciliationHeartbeat(
              reconciliationId,
              claim.claimToken,
              () => resumeConversationalAppointmentAfterVerifiedPayment({
                reconciliationId,
                reconciliationClaimToken: claim.claimToken,
                contactId: cleanContactId,
                agentId,
                channel: paymentChannel,
                amount: Number(ledger.amount),
                currency: ledgerCurrency,
                paymentEnvironment: ledgerEnvironment,
                paymentPurpose: purpose.paymentPurpose
              })
            )
            if (!resumed?.resumed && !resumed?.queued) {
              throw new Error(resumed?.reason || 'No se pudo continuar la conversación después de confirmar el pago')
            }
            progress = await checkpointConversationalPaymentReconciliation(reconciliationId, claim.claimToken, {
              resumeCompletedAt: new Date().toISOString(),
              resumeResult: {
                resumed: Boolean(resumed?.resumed),
                queued: Boolean(resumed?.queued),
                reason: resumed?.reason || null
              }
            })
            resumed = progress.resumeResult
          }
          result = {
            matched: true,
            signal: 'payment_confirmed',
            objectiveCompleted: true,
            resumed: Boolean(resumed?.resumed),
            queued: Boolean(resumed?.queued),
            afterPayment,
            agentId,
            invoiceId: cleanInvoiceId
          }
        } else if (
          (agentMissing || !agent?.enabled) &&
          stateBelongsToAgent &&
          currentPaymentState?.id &&
          currentPaymentState.status === 'active' &&
          !currentPaymentState.signal
        ) {
          // Compatibilidad histórica para un agente eliminado: cerramos sólo si
          // logramos reclamar exactamente el estado active que observamos. Si
          // alguien lo pausó o tomó el chat entre ambas operaciones, se conserva.
          let historicalClose = false
          if (!progress.signalAppliedAt) {
            const authorityToken = `conv_payment_close_${createHash('sha256')
              .update([reconciliationId, cleanContactId, currentPaymentState.id].join('\u0000'))
              .digest('hex')
              .slice(0, 48)}`
            const claimedState = await db.run(
              `UPDATE conversational_agent_state
               SET updated_by = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ? AND status = 'active' AND signal IS NULL
                 AND COALESCE(updated_by, '') = ?`,
              [authorityToken, currentPaymentState.id, String(currentPaymentState.updatedBy || '')]
            )
            if (dbMutationCount(claimedState) === 1) {
              await setConversationSignal(cleanContactId, 'purchase_completed', {
                reason,
                summary: conversationSummary,
                actionSummarySource: technicalSummary,
                originalSummary: technicalSummary,
                status: 'completed',
                agentId: agentMissing ? null : agentId,
                channel: paymentChannel,
                eventId: `${reconciliationId}_signal`,
                strictEvent: true,
                expectedUpdatedBy: authorityToken
              })
              historicalClose = true
              progress = await checkpointConversationalPaymentReconciliation(reconciliationId, claim.claimToken, {
                signalAppliedAt: new Date().toISOString()
              })
            }
          } else {
            historicalClose = true
          }
          result = {
            matched: true,
            signal: historicalClose ? 'purchase_completed' : 'payment_confirmed_state_preserved',
            objectiveCompleted: true,
            afterPayment,
            historicalClose,
            statePreserved: !historicalClose,
            agentId,
            invoiceId: cleanInvoiceId
          }
        } else {
          // Pago sí confirmado, pero el chat ya está pausado, en humano,
          // terminado, asignado a otro agente o todavía sin un estado runnable.
          // Registramos/notificamos el dinero sin tocar esa decisión humana.
          result = {
            matched: true,
            signal: 'payment_confirmed_state_preserved',
            objectiveCompleted: true,
            afterPayment,
            statePreserved: true,
            preservedStatus: currentPaymentState?.status || null,
            preservedSignal: currentPaymentState?.signal || null,
            agentId,
            invoiceId: cleanInvoiceId
          }
        }

        if (!progress.notificationAppliedAt) {
          await notifyConversationalCompletion({
            contactId: cleanContactId,
            reason,
            summary: conversationSummary || technicalSummary,
            signal: 'purchase_completed',
            eventId: `${reconciliationId}_notification`,
            throwOnFailure: true,
            eventScopedDedupe: true
          })
          progress = await checkpointConversationalPaymentReconciliation(reconciliationId, claim.claimToken, {
            notificationAppliedAt: new Date().toISOString()
          })
        }
      }
      if (!progress.completionEventAppliedAt) {
        await recordConversationalAgentEvent({
          eventId: `${reconciliationId}_completed`,
          contactId: cleanContactId,
          eventType: 'payment_link_goal_completed',
          detail: {
            agentId,
            invoiceId: cleanInvoiceId,
            amount: Number(ledger.amount),
            currency: ledgerCurrency,
            status: ledgerStatus,
            paymentEnvironment: ledgerEnvironment,
            paymentPurpose: purpose.paymentPurpose,
            afterPayment,
            resultSignal: result.signal,
            resumed: result.resumed === true,
            queued: result.queued === true,
            handoffCompleted: result.handoffCompleted === true,
            historicalClose: result.historicalClose === true,
            statePreserved: result.statePreserved === true,
            preservedStatus: result.preservedStatus || null,
            preservedSignal: result.preservedSignal || null,
            reference: reference || null,
            reconciliationId
          },
          throwOnError: true
        })
        progress = await checkpointConversationalPaymentReconciliation(reconciliationId, claim.claimToken, {
          completionEventAppliedAt: new Date().toISOString()
        })
      }
      await settleConversationalPaymentReconciliation(reconciliationId, claim.claimToken, { result })
      return result
    } catch (error) {
      await settleConversationalPaymentReconciliation(reconciliationId, claim.claimToken, { error }).catch(() => {})
      throw error
    }
}

export async function recoverPendingConversationalPaymentReconciliations({ limit = 50 } = {}) {
  const rows = await db.all(
    `SELECT id, contact_id, detail_json
     FROM conversational_agent_events
     WHERE event_type = ?
       AND (
         detail_json LIKE '%"status":"pending"%'
         OR detail_json LIKE '%"status":"processing"%'
       )
     ORDER BY created_at ASC
     LIMIT ?`,
    [CONVERSATIONAL_PAYMENT_RECONCILIATION_EVENT, Math.min(Math.max(Number(limit) || 50, 1), 200)]
  ).catch(() => [])
  let recovered = 0
  for (const row of rows) {
    const detail = parseJsonField(row.detail_json, {})
    const leaseUntilMs = Date.parse(detail.leaseUntilAt || '')
    const recoverable = detail.status === 'pending' || (
      detail.status === 'processing' && (!Number.isFinite(leaseUntilMs) || leaseUntilMs <= Date.now())
    )
    if (!recoverable) continue
    const result = await completeConversationalAgentSalePaymentFromInvoice({
      contactId: row.contact_id,
      invoiceId: detail.invoiceId,
      paymentId: detail.ledgerPaymentId,
      amount: detail.amount,
      currency: detail.currency,
      status: detail.reportedStatus || 'paid',
      paymentMode: detail.paymentEnvironment
    }).catch(() => null)
    if (result?.matched && !result?.processing) recovered += 1
  }
  return { scanned: rows.length, recovered }
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

// Requisitos duros al crear/actualizar un agente publicado. Las capacidades
// blindadas son la única fuente de verdad; los borradores apagados sí pueden
// guardarse incompletos.
export function assertAgentGoalRequirements(next = {}) {
  if (!next.enabled) return

  const nativeRuntimeErrors = getConversationalNativeRuntimeValidationErrors(next)
  if (nativeRuntimeErrors.length > 0) {
    const first = nativeRuntimeErrors[0]
    const error = buildAgentConfigError(first.message, first.code)
    error.nativeRuntimeValidation = nativeRuntimeErrors
    throw error
  }
}

function isStoredRecordActive(value) {
  if (value === false || value === 0) return false
  const clean = String(value ?? '1').trim().toLowerCase()
  return clean !== '0' && clean !== 'false' && clean !== 'off'
}

function isStoredFlagEnabled(value) {
  if (value === null || value === undefined || value === false || value === 0) return false
  const clean = String(value).trim().toLowerCase()
  return Boolean(clean) && clean !== '0' && clean !== 'false' && clean !== 'off'
}

function isSafeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim())
    return ['http:', 'https:'].includes(parsed.protocol) && Boolean(parsed.hostname)
  } catch {
    return false
  }
}

function nativeResourceValidationItem(code, capabilityId, field, message) {
  return { code, capabilityId, field, message }
}

export async function getConversationalNativeRuntimeResourceValidationErrors(next = {}) {
  if (!next.enabled) return []

  const capabilities = getEnabledConversationalCapabilities(next)
  const errors = []

  const schedule = capabilities.find((item) => item.id === 'schedule_appointment')
  if (schedule?.calendarId) {
    const calendar = await db.get(
      'SELECT id, ghl_calendar_id, is_active FROM calendars WHERE id = ? OR ghl_calendar_id = ? LIMIT 1',
      [schedule.calendarId, schedule.calendarId]
    )
    if (!calendar) {
      errors.push(nativeResourceValidationItem(
        'CONVERSATIONAL_CAPABILITY_SCHEDULE_CALENDAR_NOT_FOUND',
        'schedule_appointment',
        'capabilitiesConfig.items.schedule_appointment.calendarId',
        'El calendario seleccionado ya no existe. Elige un calendario activo antes de publicar.'
      ))
    } else if (!isStoredRecordActive(calendar.is_active)) {
      errors.push(nativeResourceValidationItem(
        'CONVERSATIONAL_CAPABILITY_SCHEDULE_CALENDAR_INACTIVE',
        'schedule_appointment',
        'capabilitiesConfig.items.schedule_appointment.calendarId',
        'El calendario seleccionado está apagado. Actívalo o elige otro antes de publicar.'
      ))
    }
  }
  if (schedule?.bookingOwner === 'human' && schedule.handoffUserId) {
    const assignedUser = await db.get(
      'SELECT id, is_active FROM users WHERE CAST(id AS TEXT) = ? LIMIT 1',
      [schedule.handoffUserId]
    )
    if (!assignedUser) {
      errors.push(nativeResourceValidationItem(
        'CONVERSATIONAL_CAPABILITY_SCHEDULE_HANDOFF_USER_NOT_FOUND',
        'schedule_appointment',
        'capabilitiesConfig.items.schedule_appointment.handoffUserId',
        'La persona elegida para terminar de agendar ya no existe. Elige un usuario activo o deja la entrega al equipo.'
      ))
    } else if (!isStoredRecordActive(assignedUser.is_active)) {
      errors.push(nativeResourceValidationItem(
        'CONVERSATIONAL_CAPABILITY_SCHEDULE_HANDOFF_USER_INACTIVE',
        'schedule_appointment',
        'capabilitiesConfig.items.schedule_appointment.handoffUserId',
        'La persona elegida para terminar de agendar está desactivada. Actívala, elige otra o deja la entrega al equipo.'
      ))
    }
  }

  const payment = capabilities.find((item) => item.id === 'collect_payment')
  if (payment) {
    const usesDeposit = payment.chargeType === 'deposit' || payment.paymentMode === 'deposit' || payment.deposit?.enabled
    if (usesDeposit) {
      const deposit = payment.deposit || {}
      const validFixedAmount = deposit.mode !== 'range' && Number(deposit.amount) > 0
      const validRangeAmount = deposit.mode === 'range' &&
        Number(deposit.minAmount) > 0 &&
        Number(deposit.maxAmount) >= Number(deposit.minAmount)
      if (!validFixedAmount && !validRangeAmount) {
        errors.push(nativeResourceValidationItem(
          'CONVERSATIONAL_CAPABILITY_DEPOSIT_AMOUNT_INVALID',
          'collect_payment',
          'capabilitiesConfig.items.collect_payment.deposit',
          'El monto del anticipo no es válido. Configura un importe positivo o un rango completo antes de publicar.'
        ))
      }
      const accountCurrency = String(await getAccountCurrency() || '').trim().toUpperCase()
      const depositCurrency = String(deposit.currency || payment.currency || '').trim().toUpperCase()
      if (!depositCurrency) {
        errors.push(nativeResourceValidationItem(
          'CONVERSATIONAL_CAPABILITY_DEPOSIT_CURRENCY_REQUIRED',
          'collect_payment',
          'capabilitiesConfig.items.collect_payment.deposit.currency',
          `Define la moneda del anticipo. Debe coincidir con la moneda de la cuenta${accountCurrency ? ` (${accountCurrency})` : ''}.`
        ))
      } else if (accountCurrency && depositCurrency !== accountCurrency) {
        errors.push(nativeResourceValidationItem(
          'CONVERSATIONAL_CAPABILITY_DEPOSIT_CURRENCY_MISMATCH',
          'collect_payment',
          'capabilitiesConfig.items.collect_payment.deposit.currency',
          `La moneda del anticipo es ${depositCurrency}, pero la cuenta cobra en ${accountCurrency}. Corrígela antes de publicar.`
        ))
      }
    } else if (payment.chargeType === 'direct') {
      const accountCurrency = String(await getAccountCurrency() || '').trim().toUpperCase()
      const directAmount = Number(payment.direct?.amount)
      const directCurrency = String(payment.direct?.currency || '').trim().toUpperCase()
      if (!(directAmount > 0)) {
        errors.push(nativeResourceValidationItem(
          'CONVERSATIONAL_CAPABILITY_DIRECT_PAYMENT_AMOUNT_INVALID',
          'collect_payment',
          'capabilitiesConfig.items.collect_payment.direct.amount',
          'El cobro directo necesita un monto mayor a cero.'
        ))
      }
      if (!String(payment.direct?.concept || '').trim()) {
        errors.push(nativeResourceValidationItem(
          'CONVERSATIONAL_CAPABILITY_DIRECT_PAYMENT_CONCEPT_REQUIRED',
          'collect_payment',
          'capabilitiesConfig.items.collect_payment.direct.concept',
          'Escribe el concepto del cobro directo antes de publicar.'
        ))
      }
      if (accountCurrency && directCurrency !== accountCurrency) {
        errors.push(nativeResourceValidationItem(
          'CONVERSATIONAL_CAPABILITY_DIRECT_PAYMENT_CURRENCY_MISMATCH',
          'collect_payment',
          'capabilitiesConfig.items.collect_payment.direct.currency',
          `El cobro directo usa ${directCurrency || 'una moneda inválida'}, pero la cuenta cobra en ${accountCurrency}.`
        ))
      }
    } else if (payment.productId && payment.priceId) {
      const product = await db.get(
        'SELECT * FROM products WHERE id = ? OR ghl_product_id = ? LIMIT 1',
        [payment.productId, payment.productId]
      )
      if (!product) {
        errors.push(nativeResourceValidationItem(
          'CONVERSATIONAL_CAPABILITY_PAYMENT_PRODUCT_NOT_FOUND',
          'collect_payment',
          'capabilitiesConfig.items.collect_payment.productId',
          'El producto seleccionado ya no existe. Elige un producto activo antes de publicar.'
        ))
      } else if (!isStoredRecordActive(product.is_active)) {
        errors.push(nativeResourceValidationItem(
          'CONVERSATIONAL_CAPABILITY_PAYMENT_PRODUCT_INACTIVE',
          'collect_payment',
          'capabilitiesConfig.items.collect_payment.productId',
          'El producto seleccionado está apagado. Actívalo o elige otro antes de publicar.'
        ))
      }

      const price = await db.get(
        'SELECT * FROM product_prices WHERE id = ? OR ghl_price_id = ? LIMIT 1',
        [payment.priceId, payment.priceId]
      )
      if (!price) {
        errors.push(nativeResourceValidationItem(
          'CONVERSATIONAL_CAPABILITY_PAYMENT_PRICE_NOT_FOUND',
          'collect_payment',
          'capabilitiesConfig.items.collect_payment.priceId',
          'El precio seleccionado ya no existe. Elige un precio real antes de publicar.'
        ))
      } else if (product) {
        const belongsByLocalId = String(price.product_id || '') === String(product.id || '')
        const belongsByRemoteId = Boolean(price.ghl_product_id && product.ghl_product_id) &&
          String(price.ghl_product_id) === String(product.ghl_product_id)
        if (!belongsByLocalId && !belongsByRemoteId) {
          errors.push(nativeResourceValidationItem(
            'CONVERSATIONAL_CAPABILITY_PAYMENT_PRICE_PRODUCT_MISMATCH',
            'collect_payment',
            'capabilitiesConfig.items.collect_payment.priceId',
            'El precio seleccionado no pertenece al producto configurado. Vuelve a elegir producto y precio.'
          ))
        }
      }
      if (
        price &&
        Object.prototype.hasOwnProperty.call(price, 'is_active') &&
        !isStoredRecordActive(price.is_active)
      ) {
        errors.push(nativeResourceValidationItem(
          'CONVERSATIONAL_CAPABILITY_PAYMENT_PRICE_INACTIVE',
          'collect_payment',
          'capabilitiesConfig.items.collect_payment.priceId',
          'El precio seleccionado está apagado. Actívalo o elige otro antes de publicar.'
        ))
      }
      if (product && price) {
        const unitAmount = Number(price.amount)
        const normalizedUnitAmount = Number.isFinite(unitAmount)
          ? Math.round(unitAmount * 100) / 100
          : 0
        if (normalizedUnitAmount <= 0) {
          errors.push(nativeResourceValidationItem(
            'CONVERSATIONAL_CAPABILITY_PAYMENT_PRICE_AMOUNT_INVALID',
            'collect_payment',
            'capabilitiesConfig.items.collect_payment.priceId',
            'El precio guardado no tiene un monto cobrable mayor a cero. Corrígelo antes de publicar.'
          ))
        }

        const accountCurrency = String(await getAccountCurrency() || '').trim().toUpperCase()
        const effectiveCurrency = String(price.currency || product.currency || accountCurrency).trim().toUpperCase()
        if (accountCurrency && effectiveCurrency !== accountCurrency) {
          errors.push(nativeResourceValidationItem(
            'CONVERSATIONAL_CAPABILITY_PAYMENT_CURRENCY_MISMATCH',
            'collect_payment',
            'capabilitiesConfig.items.collect_payment.priceId',
            `El precio guardado usa ${effectiveCurrency || 'una moneda inválida'}, pero la cuenta cobra en ${accountCurrency}. Corrige el catálogo antes de publicar.`
          ))
        }
      }
    }

    const usesBankTransfer = payment.collectionMethod === 'bank_transfer'
    const bankTransferDetails = String(payment.bankTransfer?.details || payment.deposit?.bankTransferDetails || '').trim()
    if (usesBankTransfer && !bankTransferDetails) {
      errors.push(nativeResourceValidationItem(
        'CONVERSATIONAL_CAPABILITY_PAYMENT_BANK_TRANSFER_DETAILS_REQUIRED',
        'collect_payment',
        'capabilitiesConfig.items.collect_payment.bankTransfer.details',
        'Escribe los datos bancarios que la IA compartirá para recibir la transferencia o depósito.'
      ))
    }
    if (!usesBankTransfer) {
    const gateway = String(payment.gateway || 'stripe').trim().toLowerCase()
    const paymentTestModeEnabled = payment.testMode?.enabled === true
    const installmentsEnabled = payment.installments?.enabled === true && Number(payment.installments?.maxInstallments) > 1
    if (installmentsEnabled) {
      if (usesDeposit) {
        errors.push(nativeResourceValidationItem(
          'CONVERSATIONAL_CAPABILITY_PAYMENT_DEPOSIT_MSI_UNSUPPORTED',
          'collect_payment',
          'capabilitiesConfig.items.collect_payment.installments',
          'Los meses sin intereses no se aplican a anticipos. Desactívalos o cambia el tipo de cobro.'
        ))
      } else if (gateway === 'highlevel') {
        errors.push(nativeResourceValidationItem(
          'CONVERSATIONAL_CAPABILITY_PAYMENT_HIGHLEVEL_MSI_UNSUPPORTED',
          'collect_payment',
          'capabilitiesConfig.items.collect_payment.installments',
          'HighLevel no permite fijar un máximo real de meses sin intereses en sus invoices. Desactívalos o elige otra pasarela.'
        ))
      } else {
        const accountCurrency = String(await getAccountCurrency() || '').trim().toUpperCase()
        let configuredAmount = 0
        let configuredCurrency = accountCurrency
        if (payment.chargeType === 'direct') {
          configuredAmount = Number(payment.direct?.amount) || 0
          configuredCurrency = String(payment.direct?.currency || accountCurrency).trim().toUpperCase()
        } else if (payment.priceId) {
          const configuredPrice = await db.get(
            `SELECT pp.amount, pp.currency AS price_currency, p.currency AS product_currency
             FROM product_prices pp
             LEFT JOIN products p ON p.id = pp.product_id OR p.ghl_product_id = pp.ghl_product_id
             WHERE pp.id = ? OR pp.ghl_price_id = ?
             LIMIT 1`,
            [payment.priceId, payment.priceId]
          )
          configuredAmount = Number(configuredPrice?.amount) || 0
          configuredCurrency = String(
            configuredPrice?.price_currency || configuredPrice?.product_currency || accountCurrency
          ).trim().toUpperCase()
        }
        if (configuredAmount > 0 && configuredCurrency) {
          const eligibility = msiEligibility({
            gateway,
            currency: configuredCurrency,
            amount: configuredAmount,
            msi: payment.installments
          })
          const supported = Boolean(
            eligibility.insideElement ||
            eligibility.insideBrick ||
            eligibility.hostedRedirect ||
            eligibility.standaloneMonths?.length
          ) && (
            gateway !== 'conekta' ||
            eligibility.standaloneMonths?.includes(Number(payment.installments?.maxInstallments))
          )
          if (!supported) {
            errors.push(nativeResourceValidationItem(
              'CONVERSATIONAL_CAPABILITY_PAYMENT_MSI_NOT_ELIGIBLE',
              'collect_payment',
              'capabilitiesConfig.items.collect_payment.installments',
              `La pasarela ${gateway}, el monto o la moneda configurados no permiten esos meses sin intereses.`
            ))
          }
        }
      }
    }
    if (gateway === 'highlevel') {
      const highLevelConnected = await isHighLevelConnected().catch(() => false)
      if (!highLevelConnected) {
        errors.push(nativeResourceValidationItem(
          'CONVERSATIONAL_CAPABILITY_PAYMENT_GATEWAY_NOT_CONFIGURED',
          'collect_payment',
          'capabilitiesConfig.items.collect_payment.gateway',
          'HighLevel no está conectado para crear invoices. Conéctalo o elige otra pasarela.'
        ))
      }
      const highLevelMode = await getHighLevelPaymentLinkMode().catch(() => '')
      if (highLevelConnected && highLevelMode !== 'live') {
        errors.push(nativeResourceValidationItem(
          'CONVERSATIONAL_CAPABILITY_PAYMENT_GATEWAY_NOT_LIVE',
          'collect_payment',
          'capabilitiesConfig.items.collect_payment.gateway',
          'HighLevel está en modo prueba. Cámbialo a vivo antes de publicar el agente.'
        ))
      }
      if (Number(payment.expirationMinutes) < 24 * 60) {
        errors.push(nativeResourceValidationItem(
          'CONVERSATIONAL_CAPABILITY_PAYMENT_HIGHLEVEL_EXPIRATION_INVALID',
          'collect_payment',
          'capabilitiesConfig.items.collect_payment.expirationMinutes',
          'HighLevel maneja vencimiento por fecha, no por minutos. Elige 24 horas o 7 días.'
        ))
      }
      if (paymentTestModeEnabled) {
        errors.push(nativeResourceValidationItem(
          'CONVERSATIONAL_CAPABILITY_PAYMENT_TEST_GATEWAY_UNSUPPORTED',
          'collect_payment',
          'capabilitiesConfig.items.collect_payment.gateway',
          'HighLevel no puede forzar sandbox por una sola prueba. Elige Stripe, Conekta, Mercado Pago, CLIP o Rebill, o apaga Modo test.'
        ))
      }
    } else {
      try {
        const liveConfig = await getPaymentGateCheckoutKeys(gateway)
        if (!liveConfig?.configured) {
          errors.push(nativeResourceValidationItem(
            'CONVERSATIONAL_CAPABILITY_PAYMENT_GATEWAY_NOT_CONFIGURED',
            'collect_payment',
            'capabilitiesConfig.items.collect_payment.gateway',
            `La pasarela ${gateway} no está conectada para crear enlaces de pago.`
          ))
        } else if (String(liveConfig.paymentMode || '').trim().toLowerCase() !== 'live') {
          errors.push(nativeResourceValidationItem(
            'CONVERSATIONAL_CAPABILITY_PAYMENT_GATEWAY_NOT_LIVE',
            'collect_payment',
            'capabilitiesConfig.items.collect_payment.gateway',
            `La pasarela ${gateway} está en modo prueba. Cámbiala a vivo antes de publicar el agente.`
          ))
        }
        if (paymentTestModeEnabled) {
          const testConfig = await getPaymentGateCheckoutKeys(gateway, 'test')
          if (!testConfig?.configured || String(testConfig.paymentMode || '').toLowerCase() !== 'test') {
            errors.push(nativeResourceValidationItem(
              'CONVERSATIONAL_CAPABILITY_PAYMENT_TEST_GATEWAY_NOT_CONFIGURED',
              'collect_payment',
              'capabilitiesConfig.items.collect_payment.gateway',
              `Conecta las credenciales de prueba de ${gateway} antes de publicar con Modo test activo.`
            ))
          }
        }
      } catch (error) {
        errors.push(nativeResourceValidationItem(
          'CONVERSATIONAL_CAPABILITY_PAYMENT_GATEWAY_UNAVAILABLE',
          'collect_payment',
          'capabilitiesConfig.items.collect_payment.gateway',
          `No se pudo validar la pasarela ${gateway}: ${String(error.message || 'configuración no disponible')}`
        ))
      }
    }
    }
  }

  const sendLink = capabilities.find((item) => item.id === 'send_link')
  if (sendLink) {
    if (sendLink.linkKind === 'trigger' && sendLink.triggerLinkId) {
      const triggerLink = await db.get(
        'SELECT id, public_id, destination_url, active, archived FROM trigger_links WHERE id = ? OR public_id = ? LIMIT 1',
        [sendLink.triggerLinkId, sendLink.triggerLinkId]
      )
      if (!triggerLink) {
        errors.push(nativeResourceValidationItem(
          'CONVERSATIONAL_CAPABILITY_TRIGGER_LINK_NOT_FOUND',
          'send_link',
          'capabilitiesConfig.items.send_link.triggerLinkId',
          'El enlace de disparo seleccionado ya no existe. Elige uno activo antes de publicar.'
        ))
      } else if (!isStoredRecordActive(triggerLink.active) || isStoredFlagEnabled(triggerLink.archived)) {
        errors.push(nativeResourceValidationItem(
          'CONVERSATIONAL_CAPABILITY_TRIGGER_LINK_INACTIVE',
          'send_link',
          'capabilitiesConfig.items.send_link.triggerLinkId',
          'El enlace de disparo seleccionado está apagado o archivado. Actívalo o elige otro.'
        ))
      } else if (!isSafeHttpUrl(triggerLink.destination_url)) {
        errors.push(nativeResourceValidationItem(
          'CONVERSATIONAL_CAPABILITY_LINK_URL_INVALID',
          'send_link',
          'capabilitiesConfig.items.send_link.triggerLinkId',
          'El destino real del enlace debe comenzar con http:// o https:// antes de publicar.'
        ))
      }
    } else if (sendLink.url && !isSafeHttpUrl(sendLink.url)) {
      errors.push(nativeResourceValidationItem(
        'CONVERSATIONAL_CAPABILITY_LINK_URL_INVALID',
        'send_link',
        'capabilitiesConfig.items.send_link.url',
        'El enlace debe ser una URL web válida que comience con http:// o https://.'
      ))
    }
  }

  const handoff = capabilities.find((item) => item.id === 'handoff_human')
  if (handoff?.userId) {
    const assignedUser = await db.get(
      'SELECT id, is_active FROM users WHERE id = ? LIMIT 1',
      [handoff.userId]
    )
    if (!assignedUser) {
      errors.push(nativeResourceValidationItem(
        'CONVERSATIONAL_CAPABILITY_HANDOFF_USER_NOT_FOUND',
        'handoff_human',
        'capabilitiesConfig.items.handoff_human.userId',
        'La persona asignada para recibir la conversación ya no existe. Elige un usuario activo.'
      ))
    } else if (!isStoredRecordActive(assignedUser.is_active)) {
      errors.push(nativeResourceValidationItem(
        'CONVERSATIONAL_CAPABILITY_HANDOFF_USER_INACTIVE',
        'handoff_human',
        'capabilitiesConfig.items.handoff_human.userId',
        'La persona asignada para recibir la conversación está desactivada. Actívala o elige otra.'
      ))
    }
  }

  return errors
}

export async function assertConversationalNativeRuntimeResources(next = {}) {
  const resourceErrors = await getConversationalNativeRuntimeResourceValidationErrors(next)
  if (resourceErrors.length === 0) return
  const first = resourceErrors[0]
  const error = buildAgentConfigError(first.message, first.code)
  error.nativeRuntimeResourceValidation = resourceErrors
  throw error
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
      if (firstDelay + secondDelay > MAX_FOLLOW_UP_DELAY_MINUTES) {
        throw buildAgentConfigError('Los dos seguimientos juntos no pueden pasar de 23 horas.')
      }
    }
    if (!String(input.followUp?.strategy || '').trim()) {
      throw buildAgentConfigError('Falta la estrategia de seguimiento.')
    }
  }
}

function normalizeAgentReplyDeliveryForConfig(input) {
  // La configuración visible es el contrato: si el dueño decide cuántos
  // globos usar, su tamaño, aleatoriedad o pausas, el runtime debe conservarlo.
  // Antes estos campos se aceptaban en la API y luego se pisaban en silencio
  // con defaults, por lo que el panel aparentaba guardar algo que nunca corría.
  return normalizeAgentReplyDelivery(input)
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
  const parsedPromptConfig = row.prompt_config === null || row.prompt_config === undefined
    ? null
    : parseJsonField(row.prompt_config, null)
  const storedPromptConfig = parsedPromptConfig === null
    ? null
    : normalizeConversationalPromptConfig(parsedPromptConfig)
  const parsedCapabilitiesConfig = row.capabilities_config === null || row.capabilities_config === undefined
    ? null
    : parseJsonField(row.capabilities_config, null)
  const storedCapabilitiesConfig = parsedCapabilitiesConfig === null
    ? null
    : normalizeConversationalCapabilitiesConfig(parsedCapabilitiesConfig)
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
  const mapped = {
    id: row.id,
    name: row.name || 'Agente',
    enabled: toBoolean(row.enabled),
    aiProvider,
    model: normalizeConversationalAgentModel(row.model, aiProvider),
    promptConfig: storedPromptConfig,
    capabilitiesConfig: storedCapabilitiesConfig,
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
  mapped.promptConfig = getConversationalPromptConfig(mapped)
  mapped.capabilitiesConfig = getConversationalCapabilitiesConfig(mapped)
  mapped.capabilityManifest = buildConversationalCapabilityManifest(mapped)
  return mapped
}

export async function listConversationalAgents() {
  const rows = await db.all('SELECT * FROM conversational_agents ORDER BY position ASC, created_at ASC')
  return rows.map(mapAgentRow)
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

export function buildConversationalAgentMetrics({
  agents = [],
  stateRows = [],
  stateSummaryRows = null,
  eventSummary = {}
} = {}) {
  const metricsByAgent = new Map(agents.map((agent) => [agent.id, buildEmptyAgentMetric(agent)]))
  const assignedAgentIds = new Set()
  let answeredConversations = 0
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
    responseRate: 0,
    toolFailureRate: 0,
    successRate: 0,
    byAgent: []
  }

  const ensureMetricForAgent = (agentId) => {
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
    return metricsByAgent.get(agentId)
  }

  if (Array.isArray(stateSummaryRows)) {
    for (const row of stateSummaryRows) {
      const agentId = row?.agent_id
      if (!agentId) continue
      const agentMetric = ensureMetricForAgent(agentId)
      const totalConversations = toMetricNumber(row.total_conversations)
      const assignedConversations = toMetricNumber(row.assigned_conversations)
      const completedConversations = toMetricNumber(row.completed_conversations)
      const pausedConversations = toMetricNumber(row.paused_conversations)
      const humanTakeovers = toMetricNumber(row.human_takeovers)
      const skippedConversations = toMetricNumber(row.skipped_conversations)
      const discardedConversations = toMetricNumber(row.discarded_conversations)

      agentMetric.totalConversations += totalConversations
      agentMetric.assignedConversations += assignedConversations
      agentMetric.completedConversations += completedConversations
      agentMetric.pausedConversations += pausedConversations
      agentMetric.humanTakeovers += humanTakeovers
      agentMetric.skippedConversations += skippedConversations
      agentMetric.discardedConversations += discardedConversations

      totals.totalTrackedConversations += totalConversations
      totals.assignedConversations += assignedConversations
      totals.completedConversations += completedConversations
      totals.pausedConversations += pausedConversations
      totals.humanTakeovers += humanTakeovers
      totals.skippedConversations += skippedConversations
      totals.discardedConversations += discardedConversations
      answeredConversations += toMetricNumber(row.answered_conversations)
      if (assignedConversations > 0) assignedAgentIds.add(agentId)

      const activity = row.last_activity_at || null
      if (activity && (!agentMetric.lastActivityAt || activity > agentMetric.lastActivityAt)) {
        agentMetric.lastActivityAt = activity
      }
    }
  } else for (const row of stateRows || []) {
    const agentId = row?.agent_id
    if (!agentId) continue
    const agentMetric = ensureMetricForAgent(agentId)
    agentMetric.totalConversations += 1
    totals.totalTrackedConversations += 1
    if (row.last_reply_at) answeredConversations += 1

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
  const [agentRows, metricAggregates] = await Promise.all([
    db.all('SELECT * FROM conversational_agents ORDER BY position ASC, created_at ASC'),
    loadConversationalAgentMetricAggregates()
  ])

  const metrics = buildConversationalAgentMetrics({
    agents: agentRows.map(mapAgentRow),
    stateSummaryRows: metricAggregates.stateSummaryRows,
    eventSummary: metricAggregates.eventSummary
  })
  return {
    ...metrics,
    projection: {
      status: metricAggregates.projectionStatus || (metricAggregates.projectionReady ? 'ready' : 'warming'),
      complete: Boolean(metricAggregates.projectionReady)
    }
  }
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

function normalizeAgentPromptPatch(promptInput, basePrompt) {
  const normalizedBase = normalizeConversationalPromptConfig(basePrompt, { materializeDefault: true })
  if (promptInput === undefined || promptInput === null) return normalizedBase
  if (!promptInput || typeof promptInput !== 'object' || Array.isArray(promptInput)) {
    return normalizeConversationalPromptConfig(promptInput, { materializeDefault: true })
  }

  const hasStrategyText = Object.prototype.hasOwnProperty.call(promptInput, 'strategyText')
  const hasPersonalityText = Object.prototype.hasOwnProperty.call(promptInput, 'personalityText')
  const hasLegacyEditableText = Object.prototype.hasOwnProperty.call(promptInput, 'editableText')

  // Los clientes nuevos pueden parchear un campo sin borrar el otro. Un
  // cliente anterior que sólo envía editableText conserva su semántica: ese
  // texto completo pasa a estrategia y personalidad queda vacía.
  if (hasStrategyText || hasPersonalityText) {
    // Un bundle anterior puede haber recibido los campos schema 2, conservarlos
    // al hacer spread y editar únicamente editableText. Si el texto legacy ya
    // no coincide con esos campos, ésa es la edición real del cliente viejo.
    const splitLegacyText = buildLegacyConversationalEditableText(
      promptInput.strategyText,
      promptInput.personalityText
    )
    const legacyEditableText = String(promptInput.editableText ?? '').replace(/\r\n?/g, '\n')
    if (hasLegacyEditableText && legacyEditableText !== splitLegacyText) {
      return normalizeConversationalPromptConfig({
        schemaVersion: 1,
        templateVersion: promptInput.templateVersion,
        editableText: promptInput.editableText
      }, { materializeDefault: true })
    }
    return normalizeConversationalPromptConfig({ ...normalizedBase, ...promptInput }, { materializeDefault: true })
  }
  if (hasLegacyEditableText) {
    const legacyEditableText = String(promptInput.editableText ?? '').replace(/\r\n?/g, '\n')
    // La app móvil nativa anterior reenvía editableText aunque el usuario sólo
    // cambie el nombre o el modelo. Si el valor sigue idéntico, conservar los
    // dos campos schema 2 en vez de colapsarlos de nuevo a uno solo.
    if (legacyEditableText === normalizedBase.editableText) return normalizedBase
    return normalizeConversationalPromptConfig(promptInput, { materializeDefault: true })
  }
  return normalizeConversationalPromptConfig({ ...normalizedBase, ...promptInput }, { materializeDefault: true })
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
    // El corte se SELLA en el instante exacto en que el agente queda configurado con
    // un alcance acotado ('new_only' o 'existing_only'); al volver a 'all' se limpia,
    // al editar/reactivar con el MISMO alcance se conserva, y al cambiar de un alcance
    // acotado a otro se re-sella (el "ahora" del nuevo alcance es el del cambio).
    contactScopeCutoffAt: (() => {
      const nextScope = input.contactScope === undefined
        ? normalizeContactScope(base.contactScope)
        : normalizeContactScope(input.contactScope)
      if (!SCOPED_CONTACT_SCOPES.has(nextScope)) return null
      if (normalizeContactScope(base.contactScope) === nextScope && base.contactScopeCutoffAt) {
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
  next.runtimeMode = 'tool_calling_v2'

  // Los dos campos admiten borrado intencional con ''. No se recortan y un
  // patch parcial nunca debe borrar el campo hermano.
  next.promptConfig = normalizeAgentPromptPatch(input.promptConfig, base.promptConfig)

  // Las capacidades sólo nacen del constructor nativo. Campos históricos como
  // successAction o goalWorkflow nunca pueden volver a habilitar herramientas.
  const capabilitiesSource = input.capabilitiesConfig === undefined || input.capabilitiesConfig === null
    ? base.capabilitiesConfig
    : input.capabilitiesConfig
  next.capabilitiesConfig = capabilitiesSource === null || capabilitiesSource === undefined
    ? normalizeConversationalCapabilitiesConfig(null)
    : normalizeConversationalCapabilitiesConfig(capabilitiesSource)
  return next
}

const ACTIVE_AGENT_RUNTIME_CONFIG_KEYS = new Set([
  'enabled',
  'aiProvider',
  'model',
  'promptConfig',
  'capabilitiesConfig',
  'hideAttendedNotifications',
  'contactScope',
  'responseDelay',
  'replyDelivery',
  'followUp',
  'filters'
])

const DEFAULT_AGENT_BASE = {
  name: 'Agente',
  enabled: true,
  aiProvider: DEFAULT_CONVERSATIONAL_AI_PROVIDER,
  model: DEFAULT_CONVERSATIONAL_AGENT_MODEL,
  runtimeMode: 'tool_calling_v2',
  promptConfig: null,
  capabilitiesConfig: { schemaVersion: 1, items: [] },
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
  // Un agente nuevo nace protegiendo la base existente: sólo toma contactos
  // creados desde el instante en que se guarda. Los agentes ya persistidos
  // conservan su alcance actual mediante mapAgentRow/normalizeContactScope.
  contactScope: DEFAULT_CONTACT_SCOPE,
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

// Dos alcances acotados pueden ser universos DISJUNTOS de contactos: un agente
// 'new_only' (creados desde su corte) y uno 'existing_only' (creados antes del
// suyo) no compiten por el mismo chat cuando el corte de existentes es anterior
// o igual al corte de nuevos. En ese caso no hay conflicto de entrada aunque
// sus condiciones se traslapen.
function contactScopesAreDisjoint(left = {}, right = {}) {
  const leftScope = normalizeContactScope(left.contactScope)
  const rightScope = normalizeContactScope(right.contactScope)
  if (leftScope === rightScope || leftScope === 'all' || rightScope === 'all') return false
  const newOnlyAgent = leftScope === 'new_only' ? left : right
  const existingOnlyAgent = leftScope === 'existing_only' ? left : right
  const newCut = parseTimestampMsUtc(newOnlyAgent.contactScopeCutoffAt)
  const existingCut = parseTimestampMsUtc(existingOnlyAgent.contactScopeCutoffAt)
  if (!Number.isFinite(newCut) || !Number.isFinite(existingCut)) return false
  // 'new_only' atiende creados >= newCut; 'existing_only' atiende creados < existingCut.
  return existingCut <= newCut
}

export function findConversationalAgentEntryConflicts(candidateAgent = {}, activeAgents = []) {
  if (!candidateAgent?.enabled) return []

  const candidateScopes = buildEntryScopes(candidateAgent)
  const candidateId = String(candidateAgent.id || '').trim()
  const conflicts = []

  for (const agent of activeAgents || []) {
    if (!agent?.enabled) continue
    if (candidateId && String(agent.id || '').trim() === candidateId) continue
    if (contactScopesAreDisjoint(candidateAgent, agent)) continue

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
  await assertConversationalAgentPlanLimitAllowsCreate()
  const maxPosition = await db.get('SELECT COALESCE(MAX(position), -1) AS max_pos FROM conversational_agents')
  const next = agentInputToRowValues(input, { ...DEFAULT_AGENT_BASE, position: Number(maxPosition?.max_pos ?? -1) + 1 })
  assertAgentGoalRequirements(next)
  await assertConversationalNativeRuntimeResources(next)
  const id = `cagent_${randomUUID()}`
  await assertConversationalAgentEntryDoesNotConflict({ ...next, id })
  await db.run(`
    INSERT INTO conversational_agents (
      id, name, enabled, ai_provider, model, runtime_mode, prompt_config, capabilities_config,
      identity_mode, identity_user_id, identity_user_name, identity_custom_name,
      position, objective, custom_objective, success_action,
      success_extras, required_data, handoff_rules, extra_instructions,
      allow_emojis, hide_attended, hide_attended_notifications,
      default_calendar_id, closing_strategy_mode, closing_strategy_custom,
      persuasion_level, language_level, contact_scope, contact_scope_cutoff_at,
      response_delay_config, reply_delivery_config, follow_up_config, goal_workflow_config, entry_filters
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id, next.name, next.enabled ? 1 : 0, next.aiProvider, next.model,
    next.runtimeMode,
    next.promptConfig ? JSON.stringify(next.promptConfig) : null,
    next.capabilitiesConfig ? JSON.stringify(next.capabilitiesConfig) : null,
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
  return getConversationalAgent(id)
}

export async function updateConversationalAgent(agentId, input = {}) {
  const current = await getConversationalAgent(agentId)
  if (!current) {
    throw Object.assign(new Error('Agente conversacional no encontrado'), { statusCode: 404 })
  }
  const next = agentInputToRowValues(input, current)
  assertAgentGoalRequirements(next)
  await assertConversationalNativeRuntimeResources(next)
  const shouldRefreshAssignedStates = Object.keys(input || {}).some((key) => ACTIVE_AGENT_RUNTIME_CONFIG_KEYS.has(key))
  const shouldValidateEntry = next.enabled && (!current.enabled || input.enabled === true || input.filters !== undefined)
  if (shouldValidateEntry) {
    await assertConversationalAgentEntryDoesNotConflict({ ...next, id: agentId }, { excludeAgentId: agentId })
  }
  const persistAgentUpdate = async () => db.transaction(async () => {
    await db.run(`
    UPDATE conversational_agents
    SET name = ?, enabled = ?, ai_provider = ?, model = ?,
        runtime_mode = ?, prompt_config = ?, capabilities_config = ?,
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
    next.runtimeMode,
    next.promptConfig ? JSON.stringify(next.promptConfig) : null,
    next.capabilitiesConfig ? JSON.stringify(next.capabilitiesConfig) : null,
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
    if (input?.capabilitiesConfig !== undefined) {
      // Un run conserva la revisión exacta con la que empezó. Cualquier cambio
      // de capacidades —incluido apagar Modo test— lo revoca antes de que una
      // respuesta lenta del modelo pueda ejecutar efectos reales obsoletos.
      await db.run(
        `UPDATE conversational_agent_test_runs
         SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
         WHERE agent_id = ? AND status = 'active'`,
        [agentId]
      )
    }
  })
  if (input?.capabilitiesConfig !== undefined) {
    await withConversationalAgentTestMutationLock({
      agentId,
      purpose: 'agent_capabilities_update'
    }, persistAgentUpdate)
  } else {
    await persistAgentUpdate()
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
          model: next.model,
          runtimeMode: next.runtimeMode
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
export async function buildRuleContext({ contactId = null, channel = 'whatsapp', post = null } = {}) {
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

// Medida de seguridad del alcance: un agente 'new_only' NO debe tomar contactos que ya
// existían cuando se selló su corte, y un agente 'existing_only' NO debe tomar contactos
// nacidos DESPUÉS de su corte (su universo es la base que ya existía). Fail-open: si
// falta el corte o la fecha del contacto, NO bloquea (preferimos atender de más que
// silenciar al agente por un dato faltante).
export function contactIsOutOfScopeForAgent(agent, ctx) {
  const scope = normalizeContactScope(agent?.contactScope)
  if (!SCOPED_CONTACT_SCOPES.has(scope)) return false
  const cutoff = agent?.contactScopeCutoffAt
  const createdAt = ctx?.contactInfo?.createdAt
  if (!cutoff || !createdAt) return false
  const created = parseTimestampMsUtc(createdAt)
  const cut = parseTimestampMsUtc(cutoff)
  if (!Number.isFinite(created) || !Number.isFinite(cut)) return false
  if (scope === 'new_only') {
    return created < cut // el contacto nació ANTES del corte → este agente lo ignora
  }
  return created >= cut // 'existing_only': el contacto nació DESPUÉS del corte → lo ignora
}

export function isUnverifiedConversationAssignment(state) {
  if (!state?.agentId) return false
  const source = String(state.assignmentSource || '').trim().toLowerCase()
  return !EXPLICIT_ASSIGNMENT_SOURCES.has(source)
}

export async function matchAgentForMessage({ contactId, channel = 'whatsapp', excludeAgentId = null, excludeAgentIds = [], ruleContext = null } = {}) {
  const agents = (await listConversationalAgents()).filter((agent) => agent.enabled)
  if (!agents.length) return null

  const ctx = ruleContext || await buildRuleContext({ contactId, channel })
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

const COMPLETION_NOTIFICATION_DEDUP_MS = 10 * 60 * 1000
const EVENT_SCOPED_NOTIFICATION_LEASE_MS = 60 * 1000

function criticalNotificationIdentityMatches(row, { contactId, signal, reason, summary } = {}) {
  const detail = parseJsonField(row?.detail_json, {})
  return Boolean(
    row?.event_type === 'priority_push_notification_pending' &&
    String(row?.contact_id || '') === String(contactId || '') &&
    String(detail.signal || '') === String(signal || '') &&
    String(detail.reason || '') === String(reason || '')
  )
}

async function claimCriticalConversationalNotification({
  eventId,
  contactId,
  signal,
  reason,
  summary,
  nowMs = Date.now(),
  leaseMs = EVENT_SCOPED_NOTIFICATION_LEASE_MS
} = {}) {
  const pendingEventId = `${eventId}_pending`
  const initialDetail = {
    version: 1,
    status: 'pending',
    signal,
    reason,
    summary,
    attempts: 0,
    claimToken: null,
    leaseUntilAt: null,
    lastError: null
  }
  await recordConversationalAgentEvent({
    eventId: pendingEventId,
    contactId,
    eventType: 'priority_push_notification_pending',
    detail: initialDetail,
    throwOnError: true
  })

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [row, completed] = await Promise.all([
      db.get(
        `SELECT contact_id, event_type, detail_json
         FROM conversational_agent_events WHERE id = ?`,
        [pendingEventId]
      ),
      db.get(
        `SELECT contact_id, event_type, detail_json
         FROM conversational_agent_events WHERE id = ?`,
        [eventId]
      )
    ])
    if (!criticalNotificationIdentityMatches(row, { contactId, signal, reason, summary })) {
      throw new Error('La identidad durable de la notificación crítica ya pertenece a otro evento')
    }
    const detail = parseJsonField(row.detail_json, {})
    if (completed) {
      const completedDetail = parseJsonField(completed.detail_json, {})
      if (
        completed.event_type !== 'priority_push_notification' ||
        String(completed.contact_id || '') !== String(contactId || '') ||
        String(completedDetail.signal || '') !== String(signal || '')
      ) {
        throw new Error('La identidad final de la notificación crítica pertenece a otro evento')
      }
      if (detail.status !== 'sent') {
        await db.run(
          `UPDATE conversational_agent_events SET detail_json = ?
           WHERE id = ? AND event_type = 'priority_push_notification_pending' AND detail_json = ?`,
          [JSON.stringify({
            ...detail,
            version: 1,
            status: 'sent',
            claimToken: null,
            leaseUntilAt: null,
            sentAt: detail.sentAt || new Date(nowMs).toISOString(),
            lastError: null
          }), pendingEventId, row.detail_json]
        ).catch(() => {})
      }
      return { claimed: false, completed: true, reason: 'deduped_event_id', detail }
    }
    if (detail.status === 'sent') {
      return { claimed: false, completed: true, reason: 'deduped_event_id', detail }
    }
    const leaseUntilMs = Date.parse(detail.leaseUntilAt || '')
    const activeLease = detail.status === 'processing' &&
      Number.isFinite(leaseUntilMs) && leaseUntilMs > nowMs
    if (activeLease) {
      return { claimed: false, processing: true, reason: 'notification_delivery_in_progress' }
    }
    const status = String(detail.status || 'pending')
    if (!['pending', 'processing', 'failed'].includes(status)) {
      throw new Error(`Estado durable inválido de la notificación crítica: ${status}`)
    }
    const claimToken = `canp_${randomUUID()}`
    const next = {
      ...detail,
      version: 1,
      status: 'processing',
      attempts: Math.max(0, Number(detail.attempts) || 0) + 1,
      claimToken,
      claimedAt: new Date(nowMs).toISOString(),
      leaseUntilAt: new Date(nowMs + leaseMs).toISOString(),
      lastError: null
    }
    const updated = await db.run(
      `UPDATE conversational_agent_events SET detail_json = ?
       WHERE id = ? AND event_type = 'priority_push_notification_pending' AND detail_json = ?`,
      [JSON.stringify(next), pendingEventId, row.detail_json]
    )
    if (dbMutationCount(updated) === 1) {
      return { claimed: true, claimToken, pendingEventId, detail: next }
    }
  }
  return { claimed: false, processing: true, reason: 'notification_claim_conflict' }
}

async function settleCriticalConversationalNotification({
  pendingEventId,
  claimToken,
  status,
  error = ''
} = {}) {
  const row = await db.get(
    `SELECT detail_json FROM conversational_agent_events
     WHERE id = ? AND event_type = 'priority_push_notification_pending'`,
    [pendingEventId]
  )
  const detail = parseJsonField(row?.detail_json, {})
  if (detail.status !== 'processing' || detail.claimToken !== claimToken) return false
  const next = {
    ...detail,
    status,
    claimToken: null,
    leaseUntilAt: null,
    ...(status === 'sent'
      ? { sentAt: new Date().toISOString(), lastError: null }
      : { failedAt: new Date().toISOString(), lastError: String(error || '').slice(0, 1200) })
  }
  const updated = await db.run(
    `UPDATE conversational_agent_events SET detail_json = ?
     WHERE id = ? AND event_type = 'priority_push_notification_pending' AND detail_json = ?`,
    [JSON.stringify(next), pendingEventId, row.detail_json]
  )
  return dbMutationCount(updated) === 1
}

async function notifyConversationalCompletion({
  contactId,
  reason = '',
  summary = '',
  signal = 'ready_for_human',
  eventId = '',
  throwOnFailure = false,
  eventScopedDedupe = false
} = {}) {
  if (!contactId) return { sent: 0, skipped: true, reason: 'missing_contact' }
  const cleanEventId = String(eventId || '').trim()
  let criticalClaim = null
  if (eventScopedDedupe) {
    if (!cleanEventId) {
      const error = new Error('La notificación crítica requiere una identidad durable')
      if (throwOnFailure) throw error
      return { sent: 0, skipped: true, reason: 'notification_event_id_missing' }
    }
    criticalClaim = await claimCriticalConversationalNotification({
      eventId: cleanEventId,
      contactId,
      signal,
      reason,
      summary
    })
    if (criticalClaim.completed) {
      return { sent: 0, skipped: true, reason: criticalClaim.reason }
    }
    if (!criticalClaim.claimed) {
      const error = new Error('La notificación crítica sigue en proceso de entrega')
      error.notificationDeliveryAttempted = false
      if (throwOnFailure) throw error
      return { sent: 0, skipped: true, inProgress: true, reason: criticalClaim.reason }
    }
  }
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
  if (recentNotification && !eventScopedDedupe) {
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
    const deliveryReason = criticalClaim?.detail?.reason ?? reason
    const deliverySummary = criticalClaim?.detail?.summary ?? summary
    const sender = conversationalPriorityNotificationSenderForTest ||
      (await import('./pushNotificationsService.js')).sendConversationalAgentPriorityNotification
    deliveryAttempted = true
    const result = await sender({ contactId, reason: deliveryReason, summary: deliverySummary, signal })
    await recordConversationalAgentEvent({
      eventId,
      contactId,
      eventType: 'priority_push_notification',
      detail: {
        signal,
        requestedReason: deliveryReason,
        requestedSummary: deliverySummary,
        sent: result?.sent || 0,
        skipped: Boolean(result?.skipped),
        reason: result?.reason || null
      },
      throwOnError: throwOnFailure || eventScopedDedupe
    })
    if (criticalClaim?.claimed) {
      await settleCriticalConversationalNotification({
        pendingEventId: criticalClaim.pendingEventId,
        claimToken: criticalClaim.claimToken,
        status: 'sent'
      })
    }
    return result
  } catch (error) {
    if (criticalClaim?.claimed) {
      await settleCriticalConversationalNotification({
        pendingEventId: criticalClaim.pendingEventId,
        claimToken: criticalClaim.claimToken,
        status: 'failed',
        error: error.message
      }).catch(() => {})
    }
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
  if (!row?.id) return false
  const nowIso = new Date().toISOString()
  return db.transaction(async (transaction) => {
    const result = await transaction.run(`
      UPDATE conversational_agent_state
      SET status = 'active',
          paused_until_at = NULL,
          updated_by = 'system',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status = 'paused'
        AND paused_until_at IS NOT NULL
        AND paused_until_at <= ?
    `, [row.id, nowIso])
    if (dbMutationCount(result) !== 1) return false

    await recordExpiredPauseEvents([row], transaction)
    return true
  })
}

async function recordExpiredPauseEvents(rows = [], database = db) {
  const chunkSize = 100
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize)
    const params = []
    const values = chunk.map((row) => {
      const detail = {
        status: 'active',
        updatedBy: 'system',
        reason: 'pause_expired',
        agentId: row.agent_id || null
      }
      params.push(
        `cae_${randomUUID()}`,
        row.contact_id,
        String(row.agent_id || '').trim() || null,
        'status_changed',
        JSON.stringify(detail)
      )
      return '(?, ?, ?, ?, ?)'
    })
    await database.run(`
      INSERT INTO conversational_agent_events (
        id, contact_id, agent_id, event_type, detail_json
      ) VALUES ${values.join(', ')}
      ON CONFLICT(id) DO NOTHING
    `, params)
  }
}

export async function expirePausedConversationStates({
  database = db,
  nowIso = new Date().toISOString(),
  limit = 500
} = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 500))
  return database.transaction(async (transaction) => {
    // PostgreSQL reclama cada lote con row locks; SQLite entra a la transaccion
    // con BEGIN IMMEDIATE. En ambos dialectos una pausa solo puede generar un
    // status_changed aunque varios procesos ejecuten el job al mismo tiempo.
    const rowLock = databaseDialect === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : ''
    const rows = await transaction.all(`
      SELECT id, contact_id, agent_id
      FROM conversational_agent_state
      WHERE status = 'paused'
        AND paused_until_at IS NOT NULL
        AND paused_until_at <= ?
      ORDER BY paused_until_at ASC, id ASC
      LIMIT ?${rowLock}
    `, [nowIso, safeLimit])
    if (!rows.length) return 0

    const stateIds = rows.map((row) => row.id).filter(Boolean)
    if (!stateIds.length) return 0
    const placeholders = stateIds.map(() => '?').join(', ')
    const result = await transaction.run(`
      UPDATE conversational_agent_state
      SET status = 'active',
          paused_until_at = NULL,
          updated_by = 'system',
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'paused'
        AND paused_until_at IS NOT NULL
        AND paused_until_at <= ?
        AND id IN (${placeholders})
    `, [nowIso, ...stateIds])
    if (dbMutationCount(result) !== stateIds.length) {
      throw new Error('El claim de pausas vencidas cambio dentro de la transaccion')
    }

    await recordExpiredPauseEvents(rows, transaction)
    return stateIds.length
  })
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

function mapManualConversationAgentAssignment(row) {
  if (!row) return null
  return {
    contactId: row.contact_id,
    agentId: row.agent_id,
    status: row.status || 'active',
    pausedUntilAt: row.paused_until_at || null,
    assignedAt: row.assigned_at || null,
    assignedBy: row.assigned_by || null,
    updatedBy: row.updated_by || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

/**
 * La asignacion manual es una politica del contacto completo. No sustituye los
 * estados por canal: el runtime materializa uno independiente cuando ese canal
 * recibe actividad para conservar claims, pausas y cierres aislados.
 */
export async function getManualConversationAgentAssignment(contactId) {
  if (!contactId) return null
  let row = await db.get(`
    SELECT *
    FROM conversational_agent_manual_assignments
    WHERE contact_id = ?
    LIMIT 1
  `, [contactId])
  if (!row) return null

  if (isExpiredPausedStateRow(row)) {
    const nowIso = new Date().toISOString()
    await db.run(`
      UPDATE conversational_agent_manual_assignments
      SET status = 'active',
          paused_until_at = NULL,
          updated_by = 'system',
          updated_at = CURRENT_TIMESTAMP
      WHERE contact_id = ?
        AND status = 'paused'
        AND paused_until_at IS NOT NULL
        AND paused_until_at <= ?
    `, [contactId, nowIso])
    row = await db.get(`
      SELECT *
      FROM conversational_agent_manual_assignments
      WHERE contact_id = ?
      LIMIT 1
    `, [contactId])
  }

  return mapManualConversationAgentAssignment(row)
}

async function upsertManualConversationAgentAssignment(contactId, agentId, {
  status = 'active',
  pausedUntilAt = null,
  updatedBy = 'user'
} = {}) {
  const cleanAgentId = normalizeConversationStateAgentId(agentId)
  if (!contactId || !cleanAgentId) return null
  if (!VALID_STATUSES.has(status)) {
    throw Object.assign(new Error(`Estado de asignacion manual invalido: ${status}`), { statusCode: 400 })
  }

  await db.run(`
    INSERT INTO conversational_agent_manual_assignments (
      contact_id, agent_id, status, paused_until_at,
      assigned_at, assigned_by, updated_by, updated_at
    ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(contact_id) DO UPDATE SET
      agent_id = excluded.agent_id,
      status = excluded.status,
      paused_until_at = excluded.paused_until_at,
      assigned_at = CURRENT_TIMESTAMP,
      assigned_by = excluded.assigned_by,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `, [
    contactId,
    cleanAgentId,
    status,
    pausedUntilAt,
    String(updatedBy || 'user').trim() || 'user',
    updatedBy
  ])

  return getManualConversationAgentAssignment(contactId)
}

export async function assignAgentToContactManually(contactId, agentId, {
  channel = null,
  updatedBy = 'user'
} = {}) {
  const cleanAgentId = normalizeConversationStateAgentId(agentId)
  const cleanChannel = normalizeOptionalConversationStateChannel(channel)
  if (!contactId || !cleanAgentId) return null

  await upsertManualConversationAgentAssignment(contactId, cleanAgentId, {
    status: 'active',
    pausedUntilAt: null,
    updatedBy
  })

  // Una asignacion manual es autoritativa: evita que un agente automatico o
  // una asignacion manual anterior siga compitiendo en alguno de los canales.
  await db.run(`
    UPDATE conversational_agent_state
    SET agent_id = NULL,
        assignment_source = 'released',
        assigned_by = ?,
        updated_by = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE contact_id = ?
      AND agent_id IS NOT NULL
      AND agent_id <> ?
  `, [String(updatedBy || 'user').trim() || 'user', updatedBy, contactId, cleanAgentId])

  await assignAgentToConversation(contactId, cleanAgentId, {
    activationSource: 'manual',
    assignmentSource: 'manual',
    updatedBy,
    channel: cleanChannel
  })

  // Reactivar manualmente significa reactivar al agente para el contacto
  // completo. Cada fila conserva su canal y por tanto su propio claim.
  await db.run(`
    UPDATE conversational_agent_state
    SET status = 'active',
        signal = NULL,
        signal_reason = NULL,
        signal_summary = NULL,
        signal_at = NULL,
        paused_until_at = NULL,
        assignment_source = 'manual',
        assigned_at = CURRENT_TIMESTAMP,
        assigned_by = ?,
        updated_by = ?,
        activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP),
        activation_source = 'manual',
        activated_by = COALESCE(activated_by, ?),
        updated_at = CURRENT_TIMESTAMP
    WHERE contact_id = ? AND agent_id = ?
  `, [updatedBy, updatedBy, updatedBy, contactId, cleanAgentId])

  const state = await getConversationState(contactId, {
    agentId: cleanAgentId,
    channel: cleanChannel
  })
  await recordConversationalAgentEvent({
    contactId,
    eventType: 'status_changed',
    detail: {
      status: 'active',
      updatedBy,
      clearSignal: true,
      pausedUntilAt: null,
      agentId: cleanAgentId,
      channel: 'all'
    }
  })
  return state
}

export async function setManualConversationAgentStatus(contactId, status, {
  agentId = null,
  pausedUntilAt = null,
  clearSignal = false,
  updatedBy = 'user',
  channel = null
} = {}) {
  if (!VALID_STATUSES.has(status)) {
    throw Object.assign(new Error(`Estado de asignacion manual invalido: ${status}`), { statusCode: 400 })
  }
  const current = await getManualConversationAgentAssignment(contactId)
  const cleanAgentId = normalizeConversationStateAgentId(agentId || current?.agentId)
  if (!current || !cleanAgentId || current.agentId !== cleanAgentId) return null
  const nextPausedUntilAt = status === 'paused' ? normalizePauseUntilAt(pausedUntilAt) : null

  await upsertManualConversationAgentAssignment(contactId, cleanAgentId, {
    status,
    pausedUntilAt: nextPausedUntilAt,
    updatedBy
  })

  const signalAssignments = clearSignal
    ? ', signal = NULL, signal_reason = NULL, signal_summary = NULL, signal_at = NULL'
    : ''
  await db.run(`
    UPDATE conversational_agent_state
    SET status = ?,
        paused_until_at = ?,
        updated_by = ?,
        assignment_source = 'manual',
        updated_at = CURRENT_TIMESTAMP
        ${signalAssignments}
    WHERE contact_id = ? AND agent_id = ?
  `, [status, nextPausedUntilAt, updatedBy, contactId, cleanAgentId])

  await recordConversationalAgentEvent({
    contactId,
    eventType: 'status_changed',
    detail: {
      status,
      updatedBy,
      clearSignal,
      pausedUntilAt: nextPausedUntilAt,
      agentId: cleanAgentId,
      channel: 'all'
    }
  })

  return getConversationState(contactId, {
    agentId: cleanAgentId,
    channel: normalizeOptionalConversationStateChannel(channel)
  })
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

const CONVERSATIONAL_REPLY_DELIVERY_TERMINAL_STATUSES = new Set([
  'completed',
  'interrupted',
  'ambiguous'
])
const CONVERSATIONAL_REPLY_DELIVERY_SETTLE_STATUSES = new Set([
  'completed',
  'interrupted',
  'pending',
  'ambiguous'
])

function conversationalReplyDeliveryError(message, {
  statusCode = 409,
  code = 'CONVERSATIONAL_REPLY_DELIVERY_CONFLICT'
} = {}) {
  return Object.assign(new Error(message), { statusCode, code })
}

function normalizeConversationalReplyDeliveryIdentity({
  contactId = '',
  agentId = '',
  channel = 'whatsapp',
  sourceMessageId = '',
  externalIdPrefix = 'convagent'
} = {}) {
  const identity = {
    contactId: String(contactId || '').trim(),
    agentId: String(agentId || '').trim(),
    channel: normalizeConversationStateChannel(channel),
    sourceMessageId: String(sourceMessageId || '').trim(),
    externalIdPrefix: String(externalIdPrefix || '').trim() || 'convagent'
  }
  if (!identity.contactId || !identity.agentId || !identity.sourceMessageId) {
    throw conversationalReplyDeliveryError('Falta la identidad durable de la respuesta conversacional', {
      statusCode: 400,
      code: 'CONVERSATIONAL_REPLY_DELIVERY_IDENTITY_MISSING'
    })
  }
  return identity
}

export function buildConversationalReplyDeliveryPlanId(identity = {}) {
  const normalized = normalizeConversationalReplyDeliveryIdentity(identity)
  const digest = createHash('sha256')
    .update([
      normalized.contactId,
      normalized.agentId,
      normalized.channel,
      normalized.sourceMessageId,
      normalized.externalIdPrefix
    ].join('\0'))
    .digest('hex')
  return `cae_reply_delivery_${digest.slice(0, 48)}`
}

function serializeConversationalReplyDeliveryDetail(detail) {
  let detailJson
  try {
    detailJson = JSON.stringify(detail)
  } catch {
    throw conversationalReplyDeliveryError('El plan durable de respuesta no se puede serializar', {
      statusCode: 400,
      code: 'CONVERSATIONAL_REPLY_DELIVERY_INVALID_PLAN'
    })
  }
  if (Buffer.byteLength(detailJson, 'utf8') > CONVERSATIONAL_REPLY_DELIVERY_MAX_DETAIL_BYTES) {
    throw conversationalReplyDeliveryError('El plan durable de respuesta excede el límite seguro', {
      statusCode: 413,
      code: 'CONVERSATIONAL_REPLY_DELIVERY_PLAN_TOO_LARGE'
    })
  }
  return detailJson
}

function mapConversationalReplyDeliveryPlan(row, detailOverride = null) {
  if (!row) return null
  const detail = detailOverride || parseJsonField(row.detail_json, null)
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    throw conversationalReplyDeliveryError('El plan durable de respuesta está corrupto', {
      code: 'CONVERSATIONAL_REPLY_DELIVERY_PLAN_CORRUPT'
    })
  }
  return {
    id: row.id,
    contactId: row.contact_id,
    agentId: row.agent_id,
    eventType: row.event_type,
    createdAt: row.created_at || null,
    ...detail
  }
}

async function readConversationalReplyDeliveryPlanRow(planId) {
  return db.get(
    `SELECT id, contact_id, agent_id, event_type, detail_json, created_at
     FROM conversational_agent_events WHERE id = ?`,
    [String(planId || '').trim()]
  )
}

function assertConversationalReplyDeliveryPlanRow(row, identity = null) {
  if (!row) return
  if (row.event_type !== CONVERSATIONAL_REPLY_DELIVERY_EVENT_TYPE) {
    throw conversationalReplyDeliveryError('La identidad durable ya pertenece a otro tipo de evento')
  }
  const plan = mapConversationalReplyDeliveryPlan(row)
  if (!Array.isArray(plan.parts) || plan.version !== 1) {
    throw conversationalReplyDeliveryError('El plan durable de respuesta tiene una versión inválida', {
      code: 'CONVERSATIONAL_REPLY_DELIVERY_PLAN_CORRUPT'
    })
  }
  if (identity && (
    String(row.contact_id || '') !== identity.contactId ||
    String(row.agent_id || '') !== identity.agentId ||
    String(plan.contactId || '') !== identity.contactId ||
    String(plan.agentId || '') !== identity.agentId ||
    String(plan.channel || '') !== identity.channel ||
    String(plan.sourceMessageId || '') !== identity.sourceMessageId ||
    String(plan.externalIdPrefix || '') !== identity.externalIdPrefix
  )) {
    throw conversationalReplyDeliveryError('El plan durable ya existe con otra identidad')
  }
}

/**
 * Lee el plan por su ID o por la misma identidad usada para construirlo. Permite
 * consultar antes de llamar al splitter: si ya existe, su corte guardado manda.
 */
export async function getConversationalReplyDeliveryPlan(planIdOrIdentity = {}) {
  const identity = typeof planIdOrIdentity === 'string'
    ? null
    : normalizeConversationalReplyDeliveryIdentity(planIdOrIdentity)
  const planId = typeof planIdOrIdentity === 'string'
    ? String(planIdOrIdentity || '').trim()
    : buildConversationalReplyDeliveryPlanId(identity)
  if (!planId) return null
  const row = await readConversationalReplyDeliveryPlanRow(planId)
  if (!row) return null
  assertConversationalReplyDeliveryPlanRow(row, identity)
  return mapConversationalReplyDeliveryPlan(row)
}

function normalizeConversationalReplyDeliveryParts(parts, planId) {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 20) {
    throw conversationalReplyDeliveryError('El plan durable requiere entre 1 y 20 partes', {
      statusCode: 400,
      code: 'CONVERSATIONAL_REPLY_DELIVERY_INVALID_PARTS'
    })
  }
  const digest = String(planId).replace(/^cae_reply_delivery_/, '')
  return parts.map((value, index) => {
    const text = String(value ?? '')
    if (!text.trim()) {
      throw conversationalReplyDeliveryError('El plan durable contiene una parte vacía', {
        statusCode: 400,
        code: 'CONVERSATIONAL_REPLY_DELIVERY_INVALID_PARTS'
      })
    }
    return {
      index,
      text,
      externalId: `convreply_${digest}_${index + 1}`,
      status: 'pending',
      attempts: 0,
      sendingAt: null,
      sentAt: null,
      providerMessageId: null,
      lastError: null
    }
  })
}

function normalizeConversationalReplyDeliveryDelaySchedule(delaySchedule, partCount) {
  if (delaySchedule === undefined || delaySchedule === null) {
    return Array.from({ length: partCount }, () => 0)
  }
  if (!Array.isArray(delaySchedule) || delaySchedule.length !== partCount) {
    throw conversationalReplyDeliveryError('Los tiempos del plan durable no coinciden con sus partes', {
      statusCode: 400,
      code: 'CONVERSATIONAL_REPLY_DELIVERY_INVALID_DELAYS'
    })
  }
  return delaySchedule.map((value) => {
    const delayMs = Number(value)
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 60 * 60 * 1000) {
      throw conversationalReplyDeliveryError('El plan durable contiene un tiempo de espera inválido', {
        statusCode: 400,
        code: 'CONVERSATIONAL_REPLY_DELIVERY_INVALID_DELAYS'
      })
    }
    return Math.round(delayMs)
  })
}

function normalizeConversationalReplyDeliverySplitterMeta(value = {}) {
  const meta = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    source: String(meta.source || '').trim().slice(0, 120) || null,
    reason: String(meta.reason || '').trim().slice(0, 1200) || null,
    model: String(meta.model || '').trim().slice(0, 160) || null
  }
}

/**
 * Reserva el corte una sola vez. Dos procesos pueden calcular candidatos a la
 * vez, pero ON CONFLICT hace que ambos terminen usando exactamente el primero.
 * Se escribe directo para no sufrir el recorte de telemetría de 4,000 chars.
 */
export async function getOrCreateConversationalReplyDeliveryPlan(identityInput = {}, candidateInput = null) {
  const identity = normalizeConversationalReplyDeliveryIdentity(identityInput)
  const candidate = candidateInput && typeof candidateInput === 'object'
    ? candidateInput
    : identityInput
  const planId = buildConversationalReplyDeliveryPlanId(identity)
  const parts = normalizeConversationalReplyDeliveryParts(candidate.parts, planId)
  const delaySchedule = normalizeConversationalReplyDeliveryDelaySchedule(candidate.delaySchedule, parts.length)
  const reply = String(candidate.reply ?? parts.map((part) => part.text).join(''))
  const lease = processingLeaseIso({ nowMs: candidate.nowMs, leaseMs: CONVERSATIONAL_REPLY_DELIVERY_LEASE_MS })
  const detail = {
    version: 1,
    status: 'pending',
    contactId: identity.contactId,
    agentId: identity.agentId,
    channel: identity.channel,
    sourceMessageId: identity.sourceMessageId,
    externalIdPrefix: identity.externalIdPrefix,
    replyHash: createHash('sha256').update(reply).digest('hex'),
    splitterMeta: normalizeConversationalReplyDeliverySplitterMeta(candidate.splitterMeta || candidate),
    delaySchedule,
    parts,
    attempts: 0,
    claimToken: null,
    leaseUntilAt: null,
    lastError: null,
    plannedAt: lease.nowIso
  }
  const detailJson = serializeConversationalReplyDeliveryDetail(detail)
  const insert = await db.run(
    `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    [planId, identity.contactId, identity.agentId, CONVERSATIONAL_REPLY_DELIVERY_EVENT_TYPE, detailJson]
  )
  const row = await readConversationalReplyDeliveryPlanRow(planId)
  if (!row) throw new Error('No se pudo crear el plan durable de respuesta')
  assertConversationalReplyDeliveryPlanRow(row, identity)
  const plan = mapConversationalReplyDeliveryPlan(row)
  return {
    created: dbMutationCount(insert) === 1,
    candidateDiscarded: plan.replyHash !== detail.replyHash,
    plan
  }
}

async function compareAndSetConversationalReplyDeliveryPlan(row, nextDetail) {
  const nextJson = serializeConversationalReplyDeliveryDetail(nextDetail)
  const result = await db.run(
    `UPDATE conversational_agent_events
     SET detail_json = ?
     WHERE id = ? AND event_type = ? AND detail_json = ?`,
    [nextJson, row.id, CONVERSATIONAL_REPLY_DELIVERY_EVENT_TYPE, row.detail_json]
  )
  return dbMutationCount(result) === 1
}

export async function recoverInterruptedConversationalPaymentReplyDelivery(identityInput = {}) {
  const identity = normalizeConversationalReplyDeliveryIdentity(identityInput)
  if (identity.externalIdPrefix !== 'convagent_payment_resume') {
    return { recovered: false, reason: 'not_payment_resume_delivery' }
  }
  const planId = buildConversationalReplyDeliveryPlanId(identity)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await readConversationalReplyDeliveryPlanRow(planId)
    if (!row) return { recovered: false, reason: 'missing_plan' }
    assertConversationalReplyDeliveryPlanRow(row, identity)
    const detail = parseJsonField(row.detail_json, {})
    const plan = mapConversationalReplyDeliveryPlan(row)
    if (plan.status !== 'interrupted') {
      return { recovered: false, reason: plan.status, plan }
    }
    if (plan.interruptedByMessageId === CONVERSATIONAL_REPLY_PREVENTIVE_INTERRUPTION_ID) {
      return { recovered: false, reason: 'preventive_measure', plan }
    }
    if (plan.parts.some((part) => part?.status !== 'pending')) {
      return { recovered: false, reason: 'delivery_already_attempted', plan }
    }
    const next = {
      ...detail,
      status: 'pending',
      claimToken: null,
      leaseUntilAt: null,
      interruptedAt: null,
      interruptedByMessageId: null,
      lastError: null,
      recoveredFromInboundInterruptionAt: new Date().toISOString()
    }
    if (await compareAndSetConversationalReplyDeliveryPlan(row, next)) {
      return { recovered: true, reason: 'inbound_interruption_cleared', plan: mapConversationalReplyDeliveryPlan(row, next) }
    }
  }
  return { recovered: false, reason: 'claim_conflict' }
}

function terminalConversationalReplyDeliveryClaim(plan) {
  if (!CONVERSATIONAL_REPLY_DELIVERY_TERMINAL_STATUSES.has(plan.status)) return null
  return {
    claimed: false,
    reason: plan.status,
    completed: plan.status === 'completed',
    interrupted: plan.status === 'interrupted',
    ambiguous: plan.status === 'ambiguous',
    claimToken: null,
    plan
  }
}

/**
 * Reclama el envío con CAS. Si el lease expiró después de marcar una parte como
 * `sending`, falla cerrado: el proveedor pudo aceptarla antes del crash y no se
 * debe mandar otra vez a ciegas.
 */
export async function claimConversationalReplyDelivery(planId, {
  nowMs = Date.now(),
  leaseMs = CONVERSATIONAL_REPLY_DELIVERY_LEASE_MS,
  claimToken = `card_${randomUUID()}`
} = {}) {
  const cleanPlanId = String(planId || '').trim()
  const cleanClaimToken = String(claimToken || '').trim() || `card_${randomUUID()}`
  if (!cleanPlanId) {
    return { claimed: false, reason: 'missing_plan_id', claimToken: null, plan: null }
  }
  const lease = processingLeaseIso({ nowMs, leaseMs })

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const row = await readConversationalReplyDeliveryPlanRow(cleanPlanId)
    if (!row) return { claimed: false, reason: 'missing_plan', claimToken: null, plan: null }
    assertConversationalReplyDeliveryPlanRow(row)
    const detail = parseJsonField(row.detail_json, {})
    const plan = mapConversationalReplyDeliveryPlan(row)
    const terminal = terminalConversationalReplyDeliveryClaim(plan)
    if (terminal) return terminal

    const leaseUntilMs = Date.parse(plan.leaseUntilAt || '')
    const leaseActive = plan.status === 'processing' && Number.isFinite(leaseUntilMs) && leaseUntilMs > lease.nowMs
    if (leaseActive) {
      return { claimed: false, reason: 'lease_active', processing: true, claimToken: null, plan }
    }

    const sendingParts = plan.parts.filter((part) => part?.status === 'sending')
    if (sendingParts.length) {
      const next = {
        ...detail,
        status: 'ambiguous',
        parts: plan.parts.map((part) => part?.status === 'sending'
          ? {
              ...part,
              status: 'ambiguous',
              lastError: 'delivery_lease_expired_after_send_started'
            }
          : part),
        claimToken: null,
        leaseUntilAt: null,
        ambiguousAt: lease.nowIso,
        ambiguousReason: 'delivery_lease_expired_after_send_started',
        lastError: 'delivery_lease_expired_after_send_started'
      }
      if (await compareAndSetConversationalReplyDeliveryPlan(row, next)) {
        return {
          claimed: false,
          reason: 'ambiguous',
          ambiguous: true,
          claimToken: null,
          plan: mapConversationalReplyDeliveryPlan(row, next)
        }
      }
      continue
    }

    if (!['pending', 'processing'].includes(plan.status)) {
      throw conversationalReplyDeliveryError(`Estado inválido del plan durable: ${plan.status}`, {
        code: 'CONVERSATIONAL_REPLY_DELIVERY_PLAN_CORRUPT'
      })
    }
    const next = {
      ...detail,
      status: 'processing',
      attempts: Math.max(0, Number(plan.attempts) || 0) + 1,
      claimToken: cleanClaimToken,
      leaseUntilAt: lease.leaseUntilIso,
      claimedAt: lease.nowIso,
      lastError: null
    }
    if (await compareAndSetConversationalReplyDeliveryPlan(row, next)) {
      return {
        claimed: true,
        reason: 'claimed',
        claimToken: cleanClaimToken,
        leaseUntilAt: lease.leaseUntilIso,
        plan: mapConversationalReplyDeliveryPlan(row, next)
      }
    }
  }

  const plan = await getConversationalReplyDeliveryPlan(cleanPlanId)
  return { claimed: false, reason: 'claim_conflict', claimToken: null, plan }
}

/**
 * Checkpoint estricto por parte. `partIndex` es base cero. Antes del request se
 * guarda `sending`; después de una respuesta aceptada se guarda `sent` junto al
 * ID canónico que devolvió el proveedor.
 */
export async function checkpointConversationalReplyDelivery(planId, claimToken, {
  partIndex,
  status,
  providerMessageId = null,
  error = '',
  nowMs = Date.now(),
  leaseMs = CONVERSATIONAL_REPLY_DELIVERY_LEASE_MS
} = {}) {
  const cleanPlanId = String(planId || '').trim()
  const cleanClaimToken = String(claimToken || '').trim()
  const cleanStatus = String(status || '').trim().toLowerCase()
  const index = Number(partIndex)
  if (!cleanPlanId || !cleanClaimToken || !Number.isInteger(index) || index < 0 || !['sending', 'sent'].includes(cleanStatus)) {
    throw conversationalReplyDeliveryError('Checkpoint inválido del plan durable', {
      statusCode: 400,
      code: 'CONVERSATIONAL_REPLY_DELIVERY_INVALID_CHECKPOINT'
    })
  }

  const row = await readConversationalReplyDeliveryPlanRow(cleanPlanId)
  if (!row) throw conversationalReplyDeliveryError('Se perdió el plan durable de respuesta')
  assertConversationalReplyDeliveryPlanRow(row)
  const detail = parseJsonField(row.detail_json, {})
  const plan = mapConversationalReplyDeliveryPlan(row)
  if (plan.status !== 'processing' || plan.claimToken !== cleanClaimToken) {
    throw conversationalReplyDeliveryError('Otro proceso tomó el plan durable de respuesta')
  }
  if (index >= plan.parts.length) {
    throw conversationalReplyDeliveryError('La parte indicada no existe en el plan durable', {
      statusCode: 400,
      code: 'CONVERSATIONAL_REPLY_DELIVERY_INVALID_CHECKPOINT'
    })
  }
  if (plan.parts.slice(0, index).some((part) => part?.status !== 'sent')) {
    throw conversationalReplyDeliveryError('Las partes del plan durable deben enviarse en orden')
  }

  const currentPart = plan.parts[index]
  if (currentPart.status === 'sent') {
    return { checkpointed: false, reason: 'already_sent', plan }
  }
  if (cleanStatus === 'sending' && currentPart.status === 'sending') {
    return { checkpointed: false, reason: 'already_sending', plan }
  }
  if (cleanStatus === 'sending' && currentPart.status !== 'pending') {
    throw conversationalReplyDeliveryError(`No se puede iniciar una parte en estado ${currentPart.status}`)
  }
  if (cleanStatus === 'sent' && currentPart.status !== 'sending') {
    throw conversationalReplyDeliveryError('Una parte debe quedar en sending antes de confirmarse como sent')
  }

  const lease = processingLeaseIso({ nowMs, leaseMs })
  const nextPart = cleanStatus === 'sending'
    ? {
        ...currentPart,
        status: 'sending',
        attempts: Math.max(0, Number(currentPart.attempts) || 0) + 1,
        sendingAt: lease.nowIso,
        providerMessageId: null,
        lastError: null
      }
    : {
        ...currentPart,
        status: 'sent',
        sentAt: lease.nowIso,
        providerMessageId: String(providerMessageId || '').trim().slice(0, 500) || null,
        lastError: String(error || '').trim().slice(0, 1200) || null
      }
  const next = {
    ...detail,
    parts: plan.parts.map((part, partIndexValue) => partIndexValue === index ? nextPart : part),
    leaseUntilAt: lease.leaseUntilIso,
    lastCheckpointAt: lease.nowIso
  }
  if (!await compareAndSetConversationalReplyDeliveryPlan(row, next)) {
    throw conversationalReplyDeliveryError('No se pudo guardar el avance durable de la respuesta')
  }
  return {
    checkpointed: true,
    reason: cleanStatus,
    plan: mapConversationalReplyDeliveryPlan(row, next)
  }
}

/**
 * Libera o termina un claim. Sólo `pending` permite reintento; si todavía hay
 * una parte `sending`, cualquier cierre no completado se convierte en
 * `ambiguous` para impedir un reenvío potencialmente duplicado.
 */
export async function settleConversationalReplyDelivery(planId, claimToken, {
  status = 'completed',
  error = '',
  interruptedByMessageId = null,
  nowMs = Date.now()
} = {}) {
  const cleanPlanId = String(planId || '').trim()
  const cleanClaimToken = String(claimToken || '').trim()
  const requestedStatus = String(status || '').trim().toLowerCase()
  if (!cleanPlanId || !cleanClaimToken || !CONVERSATIONAL_REPLY_DELIVERY_SETTLE_STATUSES.has(requestedStatus)) {
    throw conversationalReplyDeliveryError('Cierre inválido del plan durable', {
      statusCode: 400,
      code: 'CONVERSATIONAL_REPLY_DELIVERY_INVALID_SETTLEMENT'
    })
  }

  const row = await readConversationalReplyDeliveryPlanRow(cleanPlanId)
  if (!row) throw conversationalReplyDeliveryError('Se perdió el plan durable de respuesta')
  assertConversationalReplyDeliveryPlanRow(row)
  const detail = parseJsonField(row.detail_json, {})
  const plan = mapConversationalReplyDeliveryPlan(row)
  if (plan.status === requestedStatus && CONVERSATIONAL_REPLY_DELIVERY_TERMINAL_STATUSES.has(plan.status)) {
    return { settled: false, reason: `already_${plan.status}`, status: plan.status, plan }
  }
  if (plan.status !== 'processing' || plan.claimToken !== cleanClaimToken) {
    throw conversationalReplyDeliveryError('Otro proceso tomó el plan durable de respuesta')
  }
  if (requestedStatus === 'completed' && plan.parts.some((part) => part?.status !== 'sent')) {
    throw conversationalReplyDeliveryError('No se puede completar una respuesta con partes pendientes')
  }

  const lease = processingLeaseIso({ nowMs, leaseMs: CONVERSATIONAL_REPLY_DELIVERY_LEASE_MS })
  const sendingParts = plan.parts.filter((part) => part?.status === 'sending')
  const finalStatus = requestedStatus !== 'completed' && sendingParts.length
    ? 'ambiguous'
    : requestedStatus
  const cleanError = String(error || '').trim().slice(0, 1200) || null
  const next = {
    ...detail,
    status: finalStatus,
    parts: finalStatus === 'ambiguous'
      ? plan.parts.map((part) => part?.status === 'sending'
        ? { ...part, status: 'ambiguous', lastError: cleanError || 'delivery_status_unknown_after_send_started' }
        : part)
      : plan.parts,
    claimToken: null,
    leaseUntilAt: null,
    lastError: finalStatus === 'completed' || finalStatus === 'interrupted' ? null : cleanError,
    ...(finalStatus === 'completed' ? { completedAt: lease.nowIso } : {}),
    ...(finalStatus === 'interrupted'
      ? {
          interruptedAt: lease.nowIso,
          interruptedByMessageId: String(interruptedByMessageId || '').trim().slice(0, 500) || null
        }
      : {}),
    ...(finalStatus === 'pending' ? { releasedAt: lease.nowIso } : {}),
    ...(finalStatus === 'ambiguous'
      ? {
          ambiguousAt: lease.nowIso,
          ambiguousReason: cleanError || 'delivery_status_unknown_after_send_started'
        }
      : {})
  }
  if (!await compareAndSetConversationalReplyDeliveryPlan(row, next)) {
    throw conversationalReplyDeliveryError('No se pudo cerrar el plan durable de respuesta')
  }
  return {
    settled: true,
    reason: finalStatus,
    status: finalStatus,
    plan: mapConversationalReplyDeliveryPlan(row, next)
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
  const cleanAgentId = normalizeConversationStateAgentId(agentId)
  const cleanChannel = normalizeOptionalConversationStateChannel(channel)
  const state = await ensureConversationState(contactId, { agentId: cleanAgentId, channel: cleanChannel })
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
  const updateAgentAcrossChannels = Boolean(
    cleanAgentId &&
    !cleanChannel &&
    ['user', 'human', 'manual'].includes(cleanUpdatedBy)
  )
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
  if (updateAgentAcrossChannels) params.push(contactId, cleanAgentId)
  else params.push(state.id)

  await db.run(`
    UPDATE conversational_agent_state
    SET ${assignments.join(', ')}
    WHERE ${updateAgentAcrossChannels ? 'contact_id = ? AND agent_id = ?' : 'id = ?'}
  `, params)

  await recordConversationalAgentEvent({
    contactId,
    eventType: 'status_changed',
    detail: {
      status,
      updatedBy,
      clearSignal,
      pausedUntilAt: nextPausedUntilAt,
      agentId: state.agentId || cleanAgentId || null,
      channel: updateAgentAcrossChannels ? 'all' : cleanChannel || state.channel || null
    }
  })

  return getConversationState(contactId, {
    agentId: state.agentId || cleanAgentId || null,
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
  strictEvent = false,
  expectedUpdatedBy = '',
  expectedStatus = '',
  expectedSignal = undefined
} = {}) {
  const cleanChannel = normalizeOptionalConversationStateChannel(channel)
  const state = await ensureConversationState(contactId, { agentId, channel: cleanChannel })
  const currentState = state?.id
    ? await db.get('SELECT id, channel, agent_id FROM conversational_agent_state WHERE id = ?', [state.id]).catch(() => null)
    : null
  const cleanStatus = String(status || 'completed').trim() || 'completed'
  const effectiveAgentId = String(agentId || currentState?.agent_id || '').trim() || null
  const objectiveCompleted = cleanStatus === 'completed' && Boolean(effectiveAgentId)
  const timezone = await getAccountTimezone().catch(() => DEFAULT_TIMEZONE)
  const completionSummary = await buildCompletionSummaryFromClosingContext({
    signal,
    summary,
    reason,
    actionSummarySource,
    timezone
  })
  const cleanReason = cleanCompletionDisplayText(reason)
  const cleanActionSummary = cleanCompletionDisplayText(completionSummary.actionSummary)
  const cleanSummary = cleanCompletionDisplayText(completionSummary.summary)
  const cleanStateSummary = cleanCompletionDisplayText(completionSummary.stateSummary || cleanSummary || cleanActionSummary)
  const cleanExpectedUpdatedBy = String(expectedUpdatedBy || '').trim()
  const cleanExpectedStatus = String(expectedStatus || '').trim()
  const hasExplicitExpectedSignal = expectedSignal !== undefined
  const cleanExpectedSignal = expectedSignal === null
    ? null
    : String(expectedSignal || '').trim() || null
  const authorityWhere = []
  const authorityParams = []
  if (cleanExpectedUpdatedBy) {
    authorityWhere.push('updated_by = ?')
    authorityParams.push(cleanExpectedUpdatedBy)
    authorityWhere.push('status = ?')
    authorityParams.push(cleanExpectedStatus || 'active')
    if (!hasExplicitExpectedSignal || cleanExpectedSignal === null) {
      authorityWhere.push('signal IS NULL')
    } else {
      authorityWhere.push('signal = ?')
      authorityParams.push(cleanExpectedSignal)
    }
  }
  const updated = await db.run(`
    UPDATE conversational_agent_state
    SET signal = ?, signal_reason = ?, signal_summary = ?, signal_at = CURRENT_TIMESTAMP,
        status = ?, updated_by = 'agent',
        activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP),
        activation_source = COALESCE(activation_source, 'automatic'),
        activated_by = COALESCE(activated_by, 'agent'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      ${authorityWhere.length ? `AND ${authorityWhere.join(' AND ')}` : ''}
  `, [
    signal,
    cleanReason,
    cleanStateSummary,
    cleanStatus,
    currentState.id,
    ...authorityParams
  ])
  if (cleanExpectedUpdatedBy && dbMutationCount(updated) !== 1) {
    throw Object.assign(new Error('La conversación cambió antes de confirmar la acción terminal'), {
      statusCode: 409,
      code: 'conversational_terminal_authority_lost'
    })
  }

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
  // 'paused' o 'skipped'.
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
 * estados explícitos (skipped, paused, etc.).
 */
export async function markHumanTakeoverIfActive(contactId, { updatedBy = 'human' } = {}) {
  if (!contactId) return null
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
    const result = await db.run(`
      INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `, [cleanEventId, contactId, agentId, eventType, storedDetailJson || null])
    return {
      id: cleanEventId,
      inserted: Number(result?.changes ?? result?.rowCount ?? 0) === 1
    }
  } catch (error) {
    logger.warn(`[Agente conversacional] No se pudo registrar evento ${eventType}: ${error.message}`)
    if (throwOnError) throw error
    return { id: null, inserted: false }
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
  const where = ['event_type != ?']
  params.push(CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT)
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
