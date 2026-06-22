import { randomUUID } from 'crypto'
import { Agent, Runner, OpenAIProvider } from '@openai/agents'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { PUBLIC_URL } from '../config/constants.js'
import { CHEAPEST_OPENAI_MODEL } from '../config/openAIModels.js'
import { logger } from '../utils/logger.js'
import { getAccountTimezone } from '../utils/dateUtils.js'
import { buildTagMatchKeys, resolveTagIds, tagNamesForIds } from './contactTagsService.js'
import { getOpenAIApiKey } from './aiAgentService.js'
import {
  DEFAULT_CONVERSATIONAL_AI_PROVIDER,
  getDefaultConversationalModelForProvider,
  normalizeConversationalAIProvider
} from './conversationalAIProviderService.js'

/**
 * Servicio del agente conversacional: configuración global, estado por
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
const DEFAULT_SUCCESS_ACTION = 'ready_for_human'
const VALID_STATUSES = new Set(['active', 'paused', 'human', 'skipped', 'completed', 'discarded'])
const DEFAULT_CONVERSATIONAL_AGENT_MODEL = getDefaultConversationalModelForProvider(DEFAULT_CONVERSATIONAL_AI_PROVIDER)
const AI_MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/
const COMPLETION_SUMMARY_MODEL = CHEAPEST_OPENAI_MODEL
export const CONVERSATIONAL_AGENT_MANUAL_DISABLED_CONFIG_KEY = 'conversational_agent_manual_disabled_at'
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
  mode: 'single',
  splitMessagesEnabled: false,
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
    closingStrategyMode: row.closing_strategy_mode === 'custom' ? 'custom' : 'system',
    closingStrategyCustom: row.closing_strategy_custom || '',
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
    closingStrategyMode: input.closingStrategyMode === undefined
      ? current.closingStrategyMode
      : (input.closingStrategyMode === 'custom' ? 'custom' : 'system'),
    closingStrategyCustom: input.closingStrategyCustom === undefined
      ? current.closingStrategyCustom
      : String(input.closingStrategyCustom || '').slice(0, 8000)
  }

  const existing = await db.get('SELECT id FROM conversational_agent_config WHERE id = 1')
  if (existing) {
    await db.run(`
      UPDATE conversational_agent_config
      SET enabled = ?, ai_provider = ?, model = ?, objective = ?, custom_objective = ?, success_action = ?,
          required_data = ?, handoff_rules = ?, extra_instructions = ?,
          allow_emojis = ?, hide_attended = ?, hide_attended_notifications = ?, default_calendar_id = ?,
          closing_strategy_mode = ?, closing_strategy_custom = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `, [
      next.enabled ? 1 : 0, next.aiProvider, next.model, next.objective, next.customObjective, next.successAction,
      next.requiredData, next.handoffRules, next.extraInstructions,
      next.allowEmojis ? 1 : 0, 0, next.hideAttendedNotifications ? 1 : 0, next.defaultCalendarId,
      next.closingStrategyMode, next.closingStrategyCustom
    ])
  } else {
    await db.run(`
      INSERT INTO conversational_agent_config (
        id, enabled, ai_provider, model, objective, custom_objective, success_action,
        required_data, handoff_rules, extra_instructions,
        allow_emojis, hide_attended, hide_attended_notifications, default_calendar_id,
        closing_strategy_mode, closing_strategy_custom
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      next.enabled ? 1 : 0, next.aiProvider, next.model, next.objective, next.customObjective, next.successAction,
      next.requiredData, next.handoffRules, next.extraInstructions,
      next.allowEmojis ? 1 : 0, 0, next.hideAttendedNotifications ? 1 : 0, next.defaultCalendarId,
      next.closingStrategyMode, next.closingStrategyCustom
    ])
  }

  await setAppConfig(
    CONVERSATIONAL_AGENT_MANUAL_DISABLED_CONFIG_KEY,
    next.enabled ? null : new Date().toISOString()
  ).catch((error) => {
    logger.warn(`[Agente conversacional] No se pudo guardar bandera de apagado manual: ${error.message}`)
  })

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
  if (['sms', 'sms_qr', 'ghl_sms'].includes(normalized)) return 'sms'
  if (['webchat', 'web_chat', 'chat_web'].includes(normalized)) return 'webchat'
  return 'whatsapp'
}

function completionPhoneTransportFilter(channel = 'whatsapp') {
  return channel === 'sms'
    ? "AND LOWER(COALESCE(transport, '')) IN ('ghl_sms', 'sms', 'sms_qr')"
    : "AND LOWER(COALESCE(transport, '')) NOT IN ('ghl_sms', 'sms', 'sms_qr')"
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

function formatHumanDateTimeFromSummary(summary, timezone = 'America/Mexico_City') {
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

function buildCompletionActionSummary({ signal, summary = '', reason = '', closingContext = {}, timezone = 'America/Mexico_City' } = {}) {
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

async function buildCompletionSummaryFromClosingContext({ contactId = '', signal, summary = '', reason = '', actionSummarySource = '', closingContext = {}, timezone = 'America/Mexico_City', channel = 'whatsapp' } = {}) {
  const cleanSignal = String(signal || '').trim()
  const baseSummary = cleanCompletionDisplayText(summary)
  const baseReason = cleanCompletionDisplayText(reason)
  const actionSource = cleanCompletionDisplayText(actionSummarySource) || baseSummary
  const normalizedContext = normalizeStoredAdvancedClosingContext(closingContext)
  const actionSummary = buildCompletionActionSummary({ signal, summary: actionSource, reason: baseReason, closingContext: normalizedContext, timezone })
  const hidesMissingSummary = ['appointment_booked', 'purchase_completed'].includes(cleanSignal)
  const generatedSummary = CONVERSATIONAL_AGENT_COMPLETION_SIGNALS.has(cleanSignal)
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
    presence: ['from_ad', 'not_from_ad'],
    ad: ['is', 'is_not']
  },
  // base: siempre cierto; los parámetros acotan hora/día actuales del negocio
  schedule: {
    time: ['between', 'outside'],
    day: ['is']
  }
}

const CHAT_CONDITION_CHANNELS = new Set(['whatsapp', 'instagram', 'messenger', 'webchat', 'sms'])
const CONDITION_CHANNELS = new Set(['chat', ...CHAT_CONDITION_CHANNELS, 'email'])
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
  const operator = operators.includes(param.operator) ? param.operator : operators[0]

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
      from_ad: [],
      not_from_ad: [{ field: 'presence', operator: 'not_from_ad' }],
      ad_is: [{ field: 'ad', operator: 'is', value: cond.value }],
      ad_is_not: [{ field: 'ad', operator: 'is_not', value: cond.value }]
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
      field: String(extra.field || '').trim().slice(0, 120),
      value: String(extra.value || '').trim().slice(0, 400)
    }))
    .filter((extra) => (extra.type === 'set_custom_field' ? Boolean(extra.field) : Boolean(extra.tag)))
    .slice(0, 12)
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

export function getConversationalGoalWebhookUrl() {
  return new URL(CONVERSATIONAL_AGENT_GOAL_WEBHOOK_PATH, `${getPublicWebhookBaseUrl()}/`).toString()
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
    externalObjectId: row.external_object_id || null,
    externalStatus: row.external_status || null,
    metadata: parseJsonField(row.metadata_json, {}),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    completedAt: row.completed_at || null
  }
}

export async function createConversationGoalLink({
  contactId,
  agentId = null,
  objective = 'custom',
  targetUrl,
  trackingParam = DEFAULT_GOAL_TRACKING_PARAM,
  linkParams = {},
  metadata = {}
} = {}) {
  const cleanContactId = String(contactId || '').trim()
  if (!cleanContactId) {
    throw Object.assign(new Error('Falta el contacto para crear el enlace de objetivo'), { statusCode: 400 })
  }

  const id = `goal_${randomUUID()}`
  const cleanObjective = normalizeGoalLinkObjective(objective)
  const cleanTrackingParam = normalizeTrackingParam(trackingParam)
  const cleanTargetUrl = normalizeGoalUrl(targetUrl)
  const cleanLinkParams = normalizeGoalLinkParams(linkParams)
  const sentUrl = buildTrackedGoalUrl(cleanTargetUrl, cleanTrackingParam, id, cleanLinkParams)
  const cleanMetadata = metadata && typeof metadata === 'object' ? metadata : {}

  await db.run(`
    INSERT INTO conversational_agent_goal_links (
      id, contact_id, agent_id, objective, status, target_url, sent_url, tracking_param, metadata_json
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `, [
    id,
    cleanContactId,
    agentId ? String(agentId) : null,
    cleanObjective,
    cleanTargetUrl,
    sentUrl,
    cleanTrackingParam,
    JSON.stringify(cleanMetadata)
  ])

  await recordConversationalAgentEvent({
    contactId: cleanContactId,
    eventType: 'goal_url_created',
    detail: {
      goalId: id,
      agentId: agentId || null,
      objective: cleanObjective,
      trackingParam: cleanTrackingParam,
      targetUrl: cleanTargetUrl,
      linkParams: cleanLinkParams
    }
  })

  return {
    id,
    contactId: cleanContactId,
    agentId: agentId || null,
    objective: cleanObjective,
    status: 'pending',
    targetUrl: cleanTargetUrl,
    sentUrl,
    trackingParam: cleanTrackingParam,
    linkParams: cleanLinkParams,
    callbackUrl: getConversationalGoalWebhookUrl()
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

function normalizeComparableId(value) {
  return String(value || '').trim().toLowerCase()
}

function validateExpectedGoalReference(expected = {}, received = {}) {
  const checks = [
    ['calendarId', 'calendario'],
    ['productId', 'producto'],
    ['priceId', 'precio']
  ]
  for (const [key, label] of checks) {
    const expectedValue = normalizeComparableId(expected[key])
    const receivedValue = normalizeComparableId(received[key])
    if (expectedValue && receivedValue && expectedValue !== receivedValue) {
      const error = new Error(`La confirmación no corresponde al ${label} esperado`)
      error.statusCode = 409
      error.expected = { [key]: expected[key] }
      error.received = { [key]: received[key] }
      throw error
    }
  }
}

export async function completeConversationGoalLink(goalId, {
  externalObjectId = '',
  externalStatus = '',
  calendarId = '',
  productId = '',
  priceId = '',
  metadata = {}
} = {}) {
  const cleanGoalId = String(goalId || '').trim()
  if (!cleanGoalId) {
    throw Object.assign(new Error('Falta el ID de seguimiento del objetivo'), { statusCode: 400 })
  }

  const row = await db.get('SELECT * FROM conversational_agent_goal_links WHERE id = ?', [cleanGoalId])
  if (!row) {
    throw Object.assign(new Error('No encontramos ese objetivo pendiente'), { statusCode: 404 })
  }

  const mapped = conversationSignalForGoalObjective(row.objective)
  if (row.status === 'completed') {
    return {
      ...mapGoalLinkRow(row),
      alreadyCompleted: true,
      signal: mapped.signal,
      callbackUrl: getConversationalGoalWebhookUrl()
    }
  }

  const cleanExternalObjectId = String(externalObjectId || '').trim().slice(0, 240)
  const cleanExternalStatus = String(externalStatus || '').trim().slice(0, 120)
  const cleanMetadata = metadata && typeof metadata === 'object' ? metadata : {}
  const previousMetadata = parseJsonField(row.metadata_json, {})
  const expected = previousMetadata.expected && typeof previousMetadata.expected === 'object'
    ? previousMetadata.expected
    : {}
  const receivedReference = {
    calendarId: String(calendarId || '').trim().slice(0, 160),
    productId: String(productId || '').trim().slice(0, 160),
    priceId: String(priceId || '').trim().slice(0, 160)
  }
  validateExpectedGoalReference(expected, receivedReference)
  const nextMetadata = {
    ...previousMetadata,
    confirmation: cleanMetadata,
    receivedReference
  }

  await db.run(`
    UPDATE conversational_agent_goal_links
    SET status = 'completed',
        external_object_id = ?,
        external_status = ?,
        metadata_json = ?,
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    cleanExternalObjectId || null,
    cleanExternalStatus || null,
    JSON.stringify(nextMetadata),
    cleanGoalId
  ])

  const technicalSummary = cleanExternalObjectId
    ? `ID de ${mapped.objectLabel}: ${cleanExternalObjectId}`
    : `Confirmación recibida para ${mapped.objectLabel}`
  const conversationSummary = cleanCompletionDisplayText(previousMetadata.resumen || previousMetadata.summary || '')

  await setConversationSignal(row.contact_id, mapped.signal, {
    reason: mapped.reason,
    summary: conversationSummary,
    actionSummarySource: technicalSummary,
    originalSummary: technicalSummary,
    status: 'completed'
  })

  if (row.agent_id) {
    const agent = await getConversationalAgent(row.agent_id).catch(() => null)
    if (agent) {
      await applyAgentCompletionAction(agent, row.contact_id)
      await applyAgentSuccessExtras(agent, row.contact_id)
    }
  }

  await notifyConversationalCompletion({
    contactId: row.contact_id,
    reason: mapped.reason,
    summary: conversationSummary || technicalSummary,
    signal: mapped.signal
  })

  await recordConversationalAgentEvent({
    contactId: row.contact_id,
    eventType: 'goal_url_completed',
    detail: {
      goalId: cleanGoalId,
      agentId: row.agent_id || null,
      objective: row.objective,
      signal: mapped.signal,
      externalObjectId: cleanExternalObjectId || null,
      externalStatus: cleanExternalStatus || null,
      receivedReference
    }
  })

  return {
    ...(await getConversationGoalLink(cleanGoalId)),
    signal: mapped.signal,
    callbackUrl: getConversationalGoalWebhookUrl()
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
  'invoice_id',
  'id'
]

const EXTERNAL_STATUS_WEBHOOK_KEYS = ['status', 'state', 'eventStatus', 'event_status', 'paymentStatus', 'payment_status']

const CALENDAR_WEBHOOK_KEYS = ['calendarId', 'calendar_id', 'calendar', 'calendarRef', 'calendar_ref']
const PRODUCT_WEBHOOK_KEYS = ['productId', 'product_id', 'product', 'productRef', 'product_ref', 'itemId', 'item_id', 'sku']
const PRICE_WEBHOOK_KEYS = ['priceId', 'price_id', 'price', 'priceRef', 'price_ref', 'variantId', 'variant_id']

export async function completeConversationGoalLinkFromWebhook(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {}
  const goalId = extractPayloadValue(source, GOAL_ID_WEBHOOK_KEYS) || extractGoalIdValue(source)
  if (!goalId) {
    throw Object.assign(new Error(`Falta ${DEFAULT_GOAL_TRACKING_PARAM} en la confirmación automática`), { statusCode: 400 })
  }

  return completeConversationGoalLink(goalId, {
    externalObjectId: extractPayloadValue(source, EXTERNAL_OBJECT_WEBHOOK_KEYS),
    externalStatus: extractPayloadValue(source, EXTERNAL_STATUS_WEBHOOK_KEYS),
    calendarId: extractPayloadValue(source, CALENDAR_WEBHOOK_KEYS),
    productId: extractPayloadValue(source, PRODUCT_WEBHOOK_KEYS),
    priceId: extractPayloadValue(source, PRICE_WEBHOOK_KEYS),
    metadata: source
  })
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

  const state = await getConversationState(cleanContactId)
  const agentId = matchedDetail.agentId || state?.agentId || null
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
    status: 'completed'
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
    closingStrategyMode: row.closing_strategy_mode === 'custom' ? 'custom' : 'system',
    closingStrategyCustom: row.closing_strategy_custom || '',
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
 * Si todavía no hay agentes pero la config global vieja (de un solo agente)
 * tiene reglas reales, crea el "Agente principal" a partir de ella.
 * La config default vacía no se migra, así una cuenta nueva empieza sin agentes.
 */
export async function ensureAgentsMigration() {
  const existing = await db.get('SELECT COUNT(*) AS total FROM conversational_agents')
  if (Number(existing?.total) > 0) return
  const legacy = await db.get('SELECT * FROM conversational_agent_config WHERE id = 1')
  if (!legacy) return
  if (!shouldMigrateLegacyConversationalAgentConfig(legacy)) return
  await db.run(`
    INSERT INTO conversational_agents (
      id, name, enabled, ai_provider, model, position, objective, custom_objective, success_action,
      success_extras, required_data, handoff_rules, extra_instructions,
      allow_emojis, hide_attended, hide_attended_notifications,
      default_calendar_id, closing_strategy_mode, closing_strategy_custom,
      response_delay_config, reply_delivery_config, follow_up_config, goal_workflow_config, entry_filters
    ) VALUES (?, ?, 1, ?, ?, 0, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  await ensureAgentsMigration()

  const config = await getConversationalAgentConfig()
  if (config.enabled) return config

  const manualDisabledAt = await getAppConfig(CONVERSATIONAL_AGENT_MANUAL_DISABLED_CONFIG_KEY).catch(() => null)
  if (manualDisabledAt) return config

  const agent = await db.get(`
    SELECT id, name
    FROM conversational_agents
    WHERE enabled = 1
    ORDER BY position ASC, created_at ASC
    LIMIT 1
  `).catch(() => null)
  if (!agent) return config

  return enableConversationalAgentRuntime({ reason, agentId: agent.id })
}

function toMetricNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function stateLastActivity(row) {
  return row?.updated_at || row?.last_reply_at || row?.signal_at || null
}

function isCompletedAgentState(row) {
  return row?.status === 'completed' || (Boolean(row?.signal) && row.signal !== 'discarded')
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
  totals.byAgent = Array.from(metricsByAgent.values())
    .sort((a, b) => (b.assignedConversations - a.assignedConversations) || (b.completedConversations - a.completedConversations))

  return totals
}

export async function getConversationalAgentMetrics() {
  await ensureAgentsMigration()
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

function agentInputToRowValues(input, base) {
  assertAgentTimingInput(input)
  const next = {
    name: input.name === undefined ? base.name : String(input.name || 'Agente').trim().slice(0, 120) || 'Agente',
    enabled: input.enabled === undefined ? base.enabled : toBoolean(input.enabled),
    aiProvider: input.aiProvider === undefined ? normalizeConversationalAIProvider(base.aiProvider) : normalizeConversationalAIProvider(input.aiProvider),
    model: input.model === undefined
      ? (input.aiProvider === undefined
        ? normalizeConversationalAgentModel(base.model, base.aiProvider)
        : getDefaultConversationalModelForProvider(input.aiProvider))
      : normalizeConversationalAgentModel(input.model, input.aiProvider === undefined ? base.aiProvider : input.aiProvider),
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
    closingStrategyMode: input.closingStrategyMode === undefined
      ? base.closingStrategyMode
      : (input.closingStrategyMode === 'custom' ? 'custom' : 'system'),
    closingStrategyCustom: input.closingStrategyCustom === undefined
      ? base.closingStrategyCustom
      : String(input.closingStrategyCustom || '').slice(0, 8000),
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

const DEFAULT_AGENT_BASE = {
  name: 'Agente',
  enabled: true,
  aiProvider: DEFAULT_CONVERSATIONAL_AI_PROVIDER,
  model: DEFAULT_CONVERSATIONAL_AGENT_MODEL,
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
  responseDelay: DEFAULT_RESPONSE_DELAY_CONFIG,
  replyDelivery: DEFAULT_REPLY_DELIVERY_CONFIG,
  followUp: DEFAULT_FOLLOW_UP_CONFIG,
  goalWorkflow: DEFAULT_GOAL_WORKFLOW_CONFIG,
  filters: { entry: [], exit: [] }
}

export async function createConversationalAgent(input = {}) {
  await ensureAgentsMigration()
  const maxPosition = await db.get('SELECT COALESCE(MAX(position), -1) AS max_pos FROM conversational_agents')
  const next = agentInputToRowValues(input, { ...DEFAULT_AGENT_BASE, position: Number(maxPosition?.max_pos ?? -1) + 1 })
  const id = `cagent_${randomUUID()}`
  await db.run(`
    INSERT INTO conversational_agents (
      id, name, enabled, ai_provider, model, position, objective, custom_objective, success_action,
      success_extras, required_data, handoff_rules, extra_instructions,
      allow_emojis, hide_attended, hide_attended_notifications,
      default_calendar_id, closing_strategy_mode, closing_strategy_custom,
      response_delay_config, reply_delivery_config, follow_up_config, goal_workflow_config, entry_filters
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id, next.name, next.enabled ? 1 : 0, next.aiProvider, next.model, next.position, next.objective, next.customObjective,
    next.successAction, JSON.stringify(next.successExtras), next.requiredData, next.handoffRules,
    next.extraInstructions, next.allowEmojis ? 1 : 0,
    0, next.hideAttendedNotifications ? 1 : 0, next.defaultCalendarId,
    next.closingStrategyMode, next.closingStrategyCustom,
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
  await db.run(`
    UPDATE conversational_agents
    SET name = ?, enabled = ?, ai_provider = ?, model = ?, position = ?, objective = ?, custom_objective = ?,
        success_action = ?, success_extras = ?, required_data = ?, handoff_rules = ?,
        extra_instructions = ?, allow_emojis = ?, hide_attended = ?, hide_attended_notifications = ?,
        default_calendar_id = ?,
        closing_strategy_mode = ?, closing_strategy_custom = ?, response_delay_config = ?,
        reply_delivery_config = ?, follow_up_config = ?, goal_workflow_config = ?, entry_filters = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    next.name, next.enabled ? 1 : 0, next.aiProvider, next.model, next.position, next.objective, next.customObjective,
    next.successAction, JSON.stringify(next.successExtras), next.requiredData, next.handoffRules,
    next.extraInstructions, next.allowEmojis ? 1 : 0,
    0, next.hideAttendedNotifications ? 1 : 0, next.defaultCalendarId,
    next.closingStrategyMode, next.closingStrategyCustom,
    JSON.stringify(next.responseDelay), JSON.stringify(next.replyDelivery), JSON.stringify(next.followUp), JSON.stringify(next.goalWorkflow), JSON.stringify(next.filters),
    agentId
  ])
  if (next.enabled) {
    await enableConversationalAgentRuntime({ reason: 'agent_updated_enabled', agentId })
  }
  return getConversationalAgent(agentId)
}

export async function deleteConversationalAgent(agentId) {
  const current = await getConversationalAgent(agentId)
  if (!current) return false
  await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId])
  await db.run('UPDATE conversational_agent_state SET agent_id = NULL WHERE agent_id = ?', [agentId]).catch(() => {})
  await recordConversationalAgentEvent({ eventType: 'agent_deleted', detail: { agentId, name: current.name } })
  return true
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
export async function buildRuleContext({ contactId = null, messageText = '', channel = 'whatsapp' } = {}) {
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
      ORDER BY COALESCE(date, created_at) DESC
      LIMIT 100
    `, [contactId]).catch(() => []) : [],
    // Atribución de anuncios: clics CTWA y anuncios detectados en sus mensajes
    contactId ? db.all(`
      SELECT DISTINCT detected_ctwa_clid, detected_source_id
      FROM whatsapp_api_messages
      WHERE contact_id = ? AND direction = 'inbound'
        AND (COALESCE(detected_ctwa_clid, '') != '' OR COALESCE(detected_source_id, '') != '')
      LIMIT 50
    `, [contactId]).catch(() => []) : [],
    contactId ? db.get(`
      SELECT business_phone_number_id
      FROM whatsapp_api_messages
      WHERE contact_id = ? AND direction = 'inbound'
      ORDER BY COALESCE(message_timestamp, created_at) DESC
      LIMIT 1
    `, [contactId]).catch(() => null) : null,
    getAccountTimezone().catch(() => 'America/Mexico_City')
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

  return {
    now: Date.now(),
    nowIso,
    channel,
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
    cameFromAd: adRows.some((row) => String(row.detected_ctwa_clid || '').trim() || String(row.detected_source_id || '').trim()),
    adSourceIds: [...new Set(adRows.map((row) => String(row.detected_source_id || '').trim()).filter(Boolean))],
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

function conditionMatches(condition, ctx) {
  const { category } = condition
  const params = condition.params || []

  if (category === 'channel') {
    return params.every((param) => {
      const targetChannel = String(param.value || '').trim().toLowerCase()
      const currentChannel = String(ctx.channel || '').trim().toLowerCase()
      const matches = targetChannel === 'chat'
        ? CHAT_CONDITION_CHANNELS.has(currentChannel)
        : targetChannel === currentChannel
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
    const presence = params.find((param) => param.field === 'presence')?.operator || 'from_ad'
    if (presence === 'not_from_ad') return !ctx.cameFromAd
    if (!ctx.cameFromAd) return false
    return params.every((param) => {
      if (param.field !== 'ad') return true
      if (!param.value) return true
      const matches = ctx.adSourceIds.includes(param.value)
      return param.operator === 'is_not' ? !matches : matches
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
export async function matchAgentForMessage({ contactId, messageText = '', channel = 'whatsapp', excludeAgentId = null, ruleContext = null } = {}) {
  const agents = (await listConversationalAgents()).filter((agent) => agent.enabled)
  if (!agents.length) return null

  const ctx = ruleContext || await buildRuleContext({ contactId, messageText, channel })

  for (const agent of agents) {
    if (excludeAgentId && agent.id === excludeAgentId) continue
    if (!entryRulesMatch(agent, ctx)) continue
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
export async function applyAgentSuccessExtras(agent, contactId) {
  const extras = normalizeSuccessExtras(agent?.successExtras)
  if (!extras.length || !contactId) return []

  const applied = []
  for (const extra of extras) {
    try {
      if (extra.type === 'add_tag' || extra.type === 'remove_tag') {
        // extra.tag puede ser un ID del catálogo (configs nuevas) o un nombre
        // (configs viejas); se resuelve a ID y se guarda siempre el ID.
        const [tagId] = await resolveTagIds([extra.tag], { createMissing: extra.type === 'add_tag' })
        const row = await db.get('SELECT tags FROM contacts WHERE id = ?', [contactId])
        const tags = parseJsonField(row?.tags, [])
        const list = Array.isArray(tags) ? tags : []
        const next = extra.type === 'remove_tag'
          ? list.filter((candidate) => candidate !== tagId && normalizeMatchText(candidate) !== normalizeMatchText(extra.tag))
          : [...new Set([...list, tagId].filter(Boolean))]
        await db.run('UPDATE contacts SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [JSON.stringify(next), contactId])
        const [tagName] = tagId ? await tagNamesForIds([tagId]) : [extra.tag]
        applied.push({ type: extra.type, tag: tagName || extra.tag })
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
    }
  }

  if (applied.length) {
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'success_extras_applied',
      detail: { agentId: agent?.id || null, applied }
    })
  }
  return applied
}

export async function applyAgentCompletionAction(agent, contactId) {
  if (!agent || !contactId) return null
  const workflow = normalizeAgentGoalWorkflow(agent.goalWorkflow)
  const completion = workflow.completion || DEFAULT_GOAL_WORKFLOW_CONFIG.completion
  if (completion.mode !== 'assign_user') return { mode: 'notify_only' }

  const configuredUserId = String(completion.userId || '').trim()
  if (!configuredUserId) return { mode: 'assign_user', skipped: true, reason: 'missing_user' }

  const user = await db.get(
    `SELECT id, username, email, full_name, first_name, last_name, phone
     FROM users
     WHERE id = ? AND is_active = 1`,
    [configuredUserId]
  ).catch(() => null)

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
    contactId,
    eventType: 'completion_user_assigned',
    detail: {
      agentId: agent.id || null,
      assignedUserId,
      assignedUserName: assignedUserName || null
    }
  })

  return { mode: 'assign_user', userId: assignedUserId, userName: assignedUserName || null }
}

async function notifyConversationalCompletion({ contactId, reason = '', summary = '', signal = 'ready_for_human' } = {}) {
  if (!contactId) return { sent: 0, skipped: true, reason: 'missing_contact' }
  try {
    const { sendConversationalAgentPriorityNotification } = await import('./pushNotificationsService.js')
    const result = await sendConversationalAgentPriorityNotification({ contactId, reason, summary, signal })
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'priority_push_notification',
      detail: { signal, sent: result?.sent || 0, skipped: Boolean(result?.skipped), reason: result?.reason || null }
    })
    return result
  } catch (error) {
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'priority_push_notification_failed',
      detail: { signal, error: error.message }
    })
    return { sent: 0, skipped: true, reason: error.message }
  }
}

function mapStateRow(row) {
  if (!row) return null
  return {
    contactId: row.contact_id,
    status: row.status,
    signal: row.signal || null,
    signalReason: row.signal_reason || null,
    signalSummary: row.signal_summary || null,
    signalAt: row.signal_at || null,
    channel: row.channel || 'whatsapp',
    lastInboundMessageId: row.last_inbound_message_id || null,
    lastAnsweredInboundMessageId: row.last_answered_inbound_message_id || null,
    lastReplyAt: row.last_reply_at || null,
    followUpBaseMessageId: row.follow_up_base_message_id || null,
    followUpSentCount: Math.max(0, Number(row.follow_up_sent_count) || 0),
    followUpLastSentAt: row.follow_up_last_sent_at || null,
    updatedBy: row.updated_by || null,
    agentId: row.agent_id || null,
    closingContext: normalizeStoredAdvancedClosingContext(row.closing_context_json || '{}'),
    updatedAt: row.updated_at || null
  }
}

export async function assignAgentToConversation(contactId, agentId) {
  await ensureConversationState(contactId)
  await db.run(`
    UPDATE conversational_agent_state
    SET agent_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE contact_id = ?
  `, [agentId, contactId])
}

export async function getConversationState(contactId) {
  if (!contactId) return null
  const row = await db.get('SELECT * FROM conversational_agent_state WHERE contact_id = ?', [contactId])
  return mapStateRow(row)
}

export async function updateConversationClosingContext(contactId, patch = {}, { updatedBy = 'agent' } = {}) {
  if (!contactId) {
    return { context: normalizeAdvancedClosingContext(patch), changedKeys: Object.keys(normalizeAdvancedClosingContext(patch)) }
  }

  await ensureConversationState(contactId)
  const row = await db.get('SELECT closing_context_json FROM conversational_agent_state WHERE contact_id = ?', [contactId])
  const { context, changedKeys } = mergeAdvancedClosingContext(row?.closing_context_json || '{}', patch, { updatedBy })

  if (!changedKeys.length) {
    return { context, changedKeys }
  }

  await db.run(`
    UPDATE conversational_agent_state
    SET closing_context_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE contact_id = ?
  `, [JSON.stringify(context), contactId])

  await recordConversationalAgentEvent({
    contactId,
    eventType: 'closing_context_updated',
    detail: { updatedBy, changedKeys }
  })

  return { context, changedKeys }
}

export async function ensureConversationState(contactId) {
  const existing = await getConversationState(contactId)
  if (existing) return existing
  await db.run(`
    INSERT INTO conversational_agent_state (contact_id, status)
    VALUES (?, 'active')
    ON CONFLICT (contact_id) DO NOTHING
  `, [contactId]).catch(async () => {
    // SQLite viejo sin ON CONFLICT por columna: reintenta simple
    await db.run('INSERT OR IGNORE INTO conversational_agent_state (contact_id, status) VALUES (?, ?)', [contactId, 'active'])
  })
  return getConversationState(contactId)
}

export async function setConversationStatus(contactId, status, { updatedBy = 'system', clearSignal = false } = {}) {
  if (!VALID_STATUSES.has(status)) {
    throw Object.assign(new Error(`Estado de conversación inválido: ${status}`), { statusCode: 400 })
  }
  await ensureConversationState(contactId)
  await db.run(`
    UPDATE conversational_agent_state
    SET status = ?,
        updated_by = ?,
        ${clearSignal ? "signal = NULL, signal_reason = NULL, signal_summary = NULL, signal_at = NULL," : ''}
        updated_at = CURRENT_TIMESTAMP
    WHERE contact_id = ?
  `, [status, updatedBy, contactId])

  await recordConversationalAgentEvent({
    contactId,
    eventType: 'status_changed',
    detail: { status, updatedBy, clearSignal }
  })

  return getConversationState(contactId)
}

export async function setConversationSignal(contactId, signal, { reason = '', summary = '', status = 'completed', actionSummarySource = '', originalSummary = '' } = {}) {
  await ensureConversationState(contactId)
  const currentState = await db.get('SELECT closing_context_json, channel FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => null)
  const closingContext = normalizeStoredAdvancedClosingContext(currentState?.closing_context_json || '{}')
  const timezone = await getAccountTimezone().catch(() => 'America/Mexico_City')
  const completionSummary = await buildCompletionSummaryFromClosingContext({
    contactId,
    signal,
    summary,
    reason,
    actionSummarySource,
    closingContext,
    timezone,
    channel: currentState?.channel || 'whatsapp'
  })
  const cleanReason = cleanCompletionDisplayText(reason)
  const cleanActionSummary = cleanCompletionDisplayText(completionSummary.actionSummary)
  const cleanSummary = cleanCompletionDisplayText(completionSummary.summary)
  const cleanStateSummary = cleanCompletionDisplayText(completionSummary.stateSummary || cleanSummary || cleanActionSummary)
  await db.run(`
    UPDATE conversational_agent_state
    SET signal = ?, signal_reason = ?, signal_summary = ?, signal_at = CURRENT_TIMESTAMP,
        status = ?, updated_by = 'agent', updated_at = CURRENT_TIMESTAMP
    WHERE contact_id = ?
  `, [signal, cleanReason, cleanStateSummary, status, contactId])

  const cleanOriginalSummary = cleanCompletionDisplayText(originalSummary || actionSummarySource)
  const detail = { signal, reason: cleanReason, summary: cleanSummary, actionSummary: cleanActionSummary, status, summarySource: completionSummary.summarySource }
  if (cleanOriginalSummary && ![cleanSummary, cleanActionSummary, cleanStateSummary].includes(cleanOriginalSummary)) {
    detail.originalSummary = cleanOriginalSummary
  }

  await recordConversationalAgentEvent({
    contactId,
    eventType: 'signal_set',
    detail
  })

  return getConversationState(contactId)
}

export async function clearConversationSignal(contactId, { updatedBy = 'user' } = {}) {
  await ensureConversationState(contactId)
  await db.run(`
    UPDATE conversational_agent_state
    SET signal = NULL, signal_reason = NULL, signal_summary = NULL, signal_at = NULL,
        updated_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE contact_id = ?
  `, [updatedBy, contactId])

  await recordConversationalAgentEvent({
    contactId,
    eventType: 'signal_cleared',
    detail: { updatedBy }
  })

  return getConversationState(contactId)
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
  const state = await getConversationState(contactId)
  if (!state || state.status !== 'active') return state
  logger.info(`[Agente conversacional] Humano tomó la conversación de ${contactId}; el agente deja de responder`)
  return setConversationStatus(contactId, 'human', { updatedBy })
}

export async function shouldSuppressChatNotificationForConversationalAgent(contactId) {
  if (!contactId) return false
  const config = await getConversationalAgentConfig()
  if (!config.enabled) return false
  const state = await getConversationState(contactId)
  if (!state?.agentId || state.status !== 'active' || state.signal) return false
  const agent = await getConversationalAgent(state.agentId)
  return Boolean(agent?.enabled && agent.hideAttendedNotifications)
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

  const state = await getConversationState(contactId)
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
  const triggerSentEvent = await db.get(
    "SELECT detail_json FROM conversational_agent_events WHERE contact_id = ? AND event_type = 'trigger_link_sent' ORDER BY created_at DESC LIMIT 1",
    [contactId]
  ).catch(() => null)
  const triggerSentDetail = triggerSentEvent?.detail_json ? safeParse(triggerSentEvent.detail_json) : null
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
    status: 'completed'
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
    SELECT s.*, c.full_name AS contact_name, c.phone AS contact_phone
    FROM conversational_agent_state s
    LEFT JOIN contacts c ON c.id = s.contact_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY COALESCE(s.signal_at, s.updated_at) DESC
    LIMIT 500
  `, params)

  return rows.map((row) => ({
    ...mapStateRow(row),
    contactName: row.contact_name || null,
    contactPhone: row.contact_phone || null
  }))
}

export async function recordConversationalAgentEvent({ contactId = null, eventType, detail = null }) {
  try {
    const detailJson = detail ? JSON.stringify(detail) : null
    const storedDetailJson = eventType === 'signal_set' ? detailJson : detailJson?.slice(0, 4000)
    await db.run(`
      INSERT INTO conversational_agent_events (id, contact_id, event_type, detail_json)
      VALUES (?, ?, ?, ?)
    `, [`cae_${randomUUID()}`, contactId, eventType, storedDetailJson || null])
  } catch (error) {
    logger.warn(`[Agente conversacional] No se pudo registrar evento ${eventType}: ${error.message}`)
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
  return CONVERSATIONAL_AGENT_COMPLETION_SIGNALS.has(signal)
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
