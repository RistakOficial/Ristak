import { randomUUID } from 'crypto'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { getAccountTimezone } from '../utils/dateUtils.js'
import { buildTagMatchKeys, resolveTagIds, tagNamesForIds } from './contactTagsService.js'

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
 * ready_to_buy | appointment_booked | discarded
 */

export const CONVERSATIONAL_OBJECTIVES = [
  { id: 'citas', label: 'Cerrar citas' },
  { id: 'ventas', label: 'Cerrar ventas' },
  { id: 'datos', label: 'Conseguir datos específicos' },
  { id: 'filtrar', label: 'Filtrar curiosos' },
  { id: 'detectar', label: 'Detectar prospectos listos' },
  { id: 'custom', label: 'Objetivo personalizado' }
]

export const SUCCESS_ACTIONS = [
  { id: 'book_appointment', label: 'Agendar directamente' },
  { id: 'ready_for_human', label: 'Marcar lista para humano' },
  { id: 'ready_to_buy', label: 'Marcar lista para comprar' },
  { id: 'internal_signal', label: 'Solo crear señal interna' },
  { id: 'none', label: 'No hacer nada' }
]

const VALID_OBJECTIVES = new Set(CONVERSATIONAL_OBJECTIVES.map((item) => item.id))
const VALID_SUCCESS_ACTIONS = new Set(SUCCESS_ACTIONS.map((item) => item.id))
const VALID_STATUSES = new Set(['active', 'paused', 'human', 'skipped', 'completed', 'discarded'])

function toBoolean(value) {
  return [true, 1, '1', 'true'].includes(value)
}

function mapConfigRow(row) {
  if (!row) {
    return {
      enabled: false,
      objective: 'citas',
      customObjective: '',
      successAction: 'ready_for_human',
      requiredData: '',
      handoffRules: '',
      extraInstructions: '',
      allowEmojis: false,
      hideAttended: false,
      defaultCalendarId: null,
      closingStrategyMode: 'system',
      closingStrategyCustom: '',
      updatedAt: null
    }
  }

  return {
    enabled: toBoolean(row.enabled),
    objective: VALID_OBJECTIVES.has(row.objective) ? row.objective : 'citas',
    customObjective: row.custom_objective || '',
    successAction: VALID_SUCCESS_ACTIONS.has(row.success_action) ? row.success_action : 'ready_for_human',
    requiredData: row.required_data || '',
    handoffRules: row.handoff_rules || '',
    extraInstructions: row.extra_instructions || '',
    allowEmojis: toBoolean(row.allow_emojis),
    hideAttended: toBoolean(row.hide_attended),
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
    objective: VALID_OBJECTIVES.has(input.objective) ? input.objective : current.objective,
    customObjective: input.customObjective === undefined ? current.customObjective : String(input.customObjective || '').slice(0, 2000),
    successAction: VALID_SUCCESS_ACTIONS.has(input.successAction) ? input.successAction : current.successAction,
    requiredData: input.requiredData === undefined ? current.requiredData : String(input.requiredData || '').slice(0, 2000),
    handoffRules: input.handoffRules === undefined ? current.handoffRules : String(input.handoffRules || '').slice(0, 4000),
    extraInstructions: input.extraInstructions === undefined ? current.extraInstructions : String(input.extraInstructions || '').slice(0, 8000),
    allowEmojis: input.allowEmojis === undefined ? current.allowEmojis : toBoolean(input.allowEmojis),
    hideAttended: input.hideAttended === undefined ? current.hideAttended : toBoolean(input.hideAttended),
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
      SET enabled = ?, objective = ?, custom_objective = ?, success_action = ?,
          required_data = ?, handoff_rules = ?, extra_instructions = ?,
          allow_emojis = ?, hide_attended = ?, default_calendar_id = ?,
          closing_strategy_mode = ?, closing_strategy_custom = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `, [
      next.enabled ? 1 : 0, next.objective, next.customObjective, next.successAction,
      next.requiredData, next.handoffRules, next.extraInstructions,
      next.allowEmojis ? 1 : 0, next.hideAttended ? 1 : 0, next.defaultCalendarId,
      next.closingStrategyMode, next.closingStrategyCustom
    ])
  } else {
    await db.run(`
      INSERT INTO conversational_agent_config (
        id, enabled, objective, custom_objective, success_action,
        required_data, handoff_rules, extra_instructions,
        allow_emojis, hide_attended, default_calendar_id,
        closing_strategy_mode, closing_strategy_custom
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      next.enabled ? 1 : 0, next.objective, next.customObjective, next.successAction,
      next.requiredData, next.handoffRules, next.extraInstructions,
      next.allowEmojis ? 1 : 0, next.hideAttended ? 1 : 0, next.defaultCalendarId,
      next.closingStrategyMode, next.closingStrategyCustom
    ])
  }

  await recordConversationalAgentEvent({
    contactId: null,
    eventType: 'config_updated',
    detail: { enabled: next.enabled, objective: next.objective, successAction: next.successAction }
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

/**
 * Constructor de condiciones del agente. Las condiciones se agrupan en bloques:
 * dentro de un bloque todas deben cumplirse (Y) y entre bloques basta uno (O).
 *
 *   filters = {
 *     entry: { groups: [ { conditions: [cond, ...] }, ... ] },  // (A∧B) ∨ (C∧D)
 *     exit:  { groups: [ ... ] }
 *   }
 *
 * Cada condición: { category, operator, ...valores }. Categorías y operadores:
 * - channel:      is | is_not                                   (value: canal)
 * - message:      contains | not_contains | contains_any | contains_all |
 *                 starts_with | ends_with | equals              (value | values[])
 * - tags:         has | not_has | has_any | has_all | has_none  (value | values[])
 * - appointments: has_appointment | no_appointment | has_upcoming | no_upcoming |
 *                 has_past_due | has_cancelled | has_confirmed |
 *                 in_calendar | not_in_calendar                 (calendarId)
 *                 date_is | date_not | date_before | date_after | date_between (date, dateEnd)
 *                 time_before | time_after                      (offsetValue, offsetUnit)
 * - payments:     payment_received | payment_pending | payment_failed | payment_refunded |
 *                 product_is | product_not | product_contains | product_not_contains (value)
 *                 amount_eq | amount_gt | amount_lt | amount_between (amount, amountMax)
 * - assignee:     assigned_to | not_assigned_to                 (value)
 *                 has_assignee | no_assignee
 */
export const CONDITION_CATALOG = {
  channel: ['is', 'is_not'],
  message: ['contains', 'not_contains', 'contains_any', 'contains_all', 'starts_with', 'ends_with', 'equals'],
  tags: ['has', 'not_has', 'has_any', 'has_all', 'has_none'],
  appointments: [
    'has_appointment', 'no_appointment', 'has_upcoming', 'no_upcoming',
    'has_past_due', 'has_cancelled', 'has_confirmed',
    'in_calendar', 'not_in_calendar',
    'date_is', 'date_not', 'date_before', 'date_after', 'date_between',
    'time_before', 'time_after'
  ],
  payments: [
    'payment_received', 'payment_pending', 'payment_failed', 'payment_refunded',
    'product_is', 'product_not', 'product_contains', 'product_not_contains',
    'amount_eq', 'amount_gt', 'amount_lt', 'amount_between'
  ],
  assignee: ['assigned_to', 'not_assigned_to', 'has_assignee', 'no_assignee'],
  // Vino de anuncio: clic de WhatsApp (CTWA) o anuncio específico detectado en sus mensajes
  ads: ['from_ad', 'not_from_ad', 'ad_is', 'ad_is_not'],
  // Perfil del contacto: cliente, email, origen y antigüedad
  contact: ['is_customer', 'not_customer', 'has_email', 'no_email', 'source_is', 'source_contains', 'created_within'],
  // Fecha y hora actuales en la zona del negocio (ej. responder solo fuera de horario)
  schedule: ['time_between', 'time_outside', 'day_is'],
  // Número de WhatsApp del negocio que recibió el mensaje (negocios multi-línea)
  business_phone: ['is', 'is_not']
}

const CONDITION_CHANNELS = new Set(['whatsapp', 'instagram', 'messenger', 'webchat', 'sms', 'email'])
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

function normalizeCondition(condition) {
  if (!condition || typeof condition !== 'object') return null
  const category = String(condition.category || '')
  const operators = CONDITION_CATALOG[category]
  if (!operators) return null
  const operator = operators.includes(condition.operator) ? condition.operator : operators[0]

  const base = { category, operator }
  if (category === 'channel') {
    base.value = CONDITION_CHANNELS.has(condition.value) ? condition.value : 'whatsapp'
  } else if (category === 'message') {
    if (operator === 'contains_any' || operator === 'contains_all') {
      base.values = cleanValueList(condition.values)
    } else {
      base.value = String(condition.value || '').trim().slice(0, 200)
    }
  } else if (category === 'tags') {
    if (operator === 'has' || operator === 'not_has') {
      base.value = String(condition.value || '').trim().slice(0, 120)
    } else {
      base.values = cleanValueList(condition.values)
    }
  } else if (category === 'appointments') {
    if (operator === 'in_calendar' || operator === 'not_in_calendar') {
      base.calendarId = String(condition.calendarId || '').trim()
    } else if (operator.startsWith('date_')) {
      base.date = cleanDate(condition.date)
      if (operator === 'date_between') base.dateEnd = cleanDate(condition.dateEnd)
    } else if (operator === 'time_before' || operator === 'time_after') {
      base.offsetValue = Math.min(Math.max(Number(condition.offsetValue) || 0, 0), 100000)
      base.offsetUnit = OFFSET_UNITS.has(condition.offsetUnit) ? condition.offsetUnit : 'minutes'
    }
  } else if (category === 'payments') {
    if (operator.startsWith('product_')) {
      base.value = String(condition.value || '').trim().slice(0, 200)
    } else if (operator.startsWith('amount_')) {
      base.amount = Number(condition.amount) || 0
      if (operator === 'amount_between') base.amountMax = Number(condition.amountMax) || 0
    }
  } else if (category === 'assignee') {
    if (operator === 'assigned_to' || operator === 'not_assigned_to') {
      base.value = String(condition.value || '').trim().slice(0, 160)
    }
  } else if (category === 'ads') {
    if (operator === 'ad_is' || operator === 'ad_is_not') {
      base.value = String(condition.value || '').trim().slice(0, 160)
    }
  } else if (category === 'contact') {
    if (operator === 'source_is' || operator === 'source_contains') {
      base.value = String(condition.value || '').trim().slice(0, 200)
    } else if (operator === 'created_within') {
      base.offsetValue = Math.min(Math.max(Number(condition.offsetValue) || 0, 0), 100000)
      base.offsetUnit = OFFSET_UNITS.has(condition.offsetUnit) ? condition.offsetUnit : 'days'
    }
  } else if (category === 'schedule') {
    if (operator === 'time_between' || operator === 'time_outside') {
      base.timeStart = cleanTime(condition.timeStart) || '09:00'
      base.timeEnd = cleanTime(condition.timeEnd) || '18:00'
    } else if (operator === 'day_is') {
      base.values = cleanValueList(condition.values).map((day) => day.toLowerCase()).filter((day) => WEEKDAY_KEYS.has(day))
    }
  } else if (category === 'business_phone') {
    base.value = String(condition.value || '').trim().slice(0, 120)
  }
  return base
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

function mapAgentRow(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name || 'Agente',
    enabled: toBoolean(row.enabled),
    position: Number(row.position) || 0,
    objective: VALID_OBJECTIVES.has(row.objective) ? row.objective : 'citas',
    customObjective: row.custom_objective || '',
    successAction: VALID_SUCCESS_ACTIONS.has(row.success_action) ? row.success_action : 'ready_for_human',
    successExtras: normalizeSuccessExtras(parseJsonField(row.success_extras, [])),
    requiredData: row.required_data || '',
    handoffRules: row.handoff_rules || '',
    extraInstructions: row.extra_instructions || '',
    allowEmojis: toBoolean(row.allow_emojis),
    defaultCalendarId: row.default_calendar_id || null,
    closingStrategyMode: row.closing_strategy_mode === 'custom' ? 'custom' : 'system',
    closingStrategyCustom: row.closing_strategy_custom || '',
    filters: normalizeAgentFilters(parseJsonField(row.entry_filters, null)),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

/**
 * Si todavía no hay agentes pero la config global vieja (de un solo agente)
 * tiene datos, crea el "Agente principal" a partir de ella.
 */
export async function ensureAgentsMigration() {
  const existing = await db.get('SELECT COUNT(*) AS total FROM conversational_agents')
  if (Number(existing?.total) > 0) return
  const legacy = await db.get('SELECT * FROM conversational_agent_config WHERE id = 1')
  if (!legacy) return
  await db.run(`
    INSERT INTO conversational_agents (
      id, name, enabled, position, objective, custom_objective, success_action,
      success_extras, required_data, handoff_rules, extra_instructions,
      allow_emojis, default_calendar_id, closing_strategy_mode, closing_strategy_custom, entry_filters
    ) VALUES (?, ?, 1, 0, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    `cagent_${randomUUID()}`,
    'Agente principal',
    VALID_OBJECTIVES.has(legacy.objective) ? legacy.objective : 'citas',
    legacy.custom_objective || '',
    VALID_SUCCESS_ACTIONS.has(legacy.success_action) ? legacy.success_action : 'ready_for_human',
    legacy.required_data || '',
    legacy.handoff_rules || '',
    legacy.extra_instructions || '',
    toBoolean(legacy.allow_emojis) ? 1 : 0,
    legacy.default_calendar_id || null,
    legacy.closing_strategy_mode === 'custom' ? 'custom' : 'system',
    legacy.closing_strategy_custom || '',
    JSON.stringify({ entry: [], exit: [] })
  ])
  logger.info('[Agente conversacional] Config previa migrada al contenedor "Agente principal"')
}

export async function listConversationalAgents() {
  await ensureAgentsMigration()
  const rows = await db.all('SELECT * FROM conversational_agents ORDER BY position ASC, created_at ASC')
  return rows.map(mapAgentRow)
}

export async function getConversationalAgent(agentId) {
  if (!agentId) return null
  const row = await db.get('SELECT * FROM conversational_agents WHERE id = ?', [agentId])
  return mapAgentRow(row)
}

function agentInputToRowValues(input, base) {
  const next = {
    name: input.name === undefined ? base.name : String(input.name || 'Agente').trim().slice(0, 120) || 'Agente',
    enabled: input.enabled === undefined ? base.enabled : toBoolean(input.enabled),
    position: input.position === undefined ? base.position : Number(input.position) || 0,
    objective: VALID_OBJECTIVES.has(input.objective) ? input.objective : base.objective,
    customObjective: input.customObjective === undefined ? base.customObjective : String(input.customObjective || '').slice(0, 2000),
    successAction: VALID_SUCCESS_ACTIONS.has(input.successAction) ? input.successAction : base.successAction,
    successExtras: input.successExtras === undefined ? base.successExtras : normalizeSuccessExtras(input.successExtras),
    requiredData: input.requiredData === undefined ? base.requiredData : String(input.requiredData || '').slice(0, 2000),
    handoffRules: input.handoffRules === undefined ? base.handoffRules : String(input.handoffRules || '').slice(0, 4000),
    extraInstructions: input.extraInstructions === undefined ? base.extraInstructions : String(input.extraInstructions || '').slice(0, 8000),
    allowEmojis: input.allowEmojis === undefined ? base.allowEmojis : toBoolean(input.allowEmojis),
    defaultCalendarId: input.defaultCalendarId === undefined ? base.defaultCalendarId : (String(input.defaultCalendarId || '').trim() || null),
    closingStrategyMode: input.closingStrategyMode === undefined
      ? base.closingStrategyMode
      : (input.closingStrategyMode === 'custom' ? 'custom' : 'system'),
    closingStrategyCustom: input.closingStrategyCustom === undefined
      ? base.closingStrategyCustom
      : String(input.closingStrategyCustom || '').slice(0, 8000),
    filters: input.filters === undefined ? base.filters : normalizeAgentFilters(input.filters)
  }
  return next
}

const DEFAULT_AGENT_BASE = {
  name: 'Agente',
  enabled: true,
  position: 0,
  objective: 'citas',
  customObjective: '',
  successAction: 'ready_for_human',
  successExtras: [],
  requiredData: '',
  handoffRules: '',
  extraInstructions: '',
  allowEmojis: false,
  defaultCalendarId: null,
  closingStrategyMode: 'system',
  closingStrategyCustom: '',
  filters: { entry: [], exit: [] }
}

export async function createConversationalAgent(input = {}) {
  await ensureAgentsMigration()
  const maxPosition = await db.get('SELECT COALESCE(MAX(position), -1) AS max_pos FROM conversational_agents')
  const next = agentInputToRowValues(input, { ...DEFAULT_AGENT_BASE, position: Number(maxPosition?.max_pos ?? -1) + 1 })
  const id = `cagent_${randomUUID()}`
  await db.run(`
    INSERT INTO conversational_agents (
      id, name, enabled, position, objective, custom_objective, success_action,
      success_extras, required_data, handoff_rules, extra_instructions,
      allow_emojis, default_calendar_id, closing_strategy_mode, closing_strategy_custom, entry_filters
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id, next.name, next.enabled ? 1 : 0, next.position, next.objective, next.customObjective,
    next.successAction, JSON.stringify(next.successExtras), next.requiredData, next.handoffRules,
    next.extraInstructions, next.allowEmojis ? 1 : 0, next.defaultCalendarId,
    next.closingStrategyMode, next.closingStrategyCustom, JSON.stringify(next.filters)
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
  await db.run(`
    UPDATE conversational_agents
    SET name = ?, enabled = ?, position = ?, objective = ?, custom_objective = ?,
        success_action = ?, success_extras = ?, required_data = ?, handoff_rules = ?,
        extra_instructions = ?, allow_emojis = ?, default_calendar_id = ?,
        closing_strategy_mode = ?, closing_strategy_custom = ?, entry_filters = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    next.name, next.enabled ? 1 : 0, next.position, next.objective, next.customObjective,
    next.successAction, JSON.stringify(next.successExtras), next.requiredData, next.handoffRules,
    next.extraInstructions, next.allowEmojis ? 1 : 0, next.defaultCalendarId,
    next.closingStrategyMode, next.closingStrategyCustom, JSON.stringify(next.filters),
    agentId
  ])
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

/**
 * Construye una sola vez el contexto que necesitan las condiciones (etiquetas,
 * citas, pagos y asignados del contacto) para evaluar varios agentes sin
 * repetir consultas.
 */
export async function buildRuleContext({ contactId = null, messageText = '', channel = 'whatsapp' } = {}) {
  const nowIso = new Date().toISOString()

  const [contact, appointmentRows, paymentRows, adRows, latestInbound, timezone] = await Promise.all([
    contactId ? db.get(`
      SELECT id, tags, email, source, purchases_count, total_paid, created_at, attribution_session_source
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
      email: String(contact.email || '').trim(),
      source: normalizeMatchText(contact.source || ''),
      attributionSource: normalizeMatchText(contact.attribution_session_source || ''),
      purchasesCount: Number(contact.purchases_count) || 0,
      totalPaid: Number(contact.total_paid) || 0,
      createdAt: contact.created_at || null
    } : null,
    localMinutes,
    localWeekday
  }
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

function conditionMatches(condition, ctx) {
  const { category, operator } = condition

  if (category === 'channel') {
    const matches = condition.value === ctx.channel
    return operator === 'is_not' ? !matches : matches
  }

  if (category === 'message') {
    const single = normalizeMatchText(condition.value)
    const list = (condition.values || []).map(normalizeMatchText).filter(Boolean)
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

  if (category === 'tags') {
    const single = normalizeMatchText(condition.value)
    const list = (condition.values || []).map(normalizeMatchText).filter(Boolean)
    switch (operator) {
      case 'has': return Boolean(single) && ctx.tags.includes(single)
      case 'not_has': return !single || !ctx.tags.includes(single)
      case 'has_any': return !list.length || list.some((tag) => ctx.tags.includes(tag))
      case 'has_all': return !list.length || list.every((tag) => ctx.tags.includes(tag))
      case 'has_none': return !list.length || !list.some((tag) => ctx.tags.includes(tag))
      default: return false
    }
  }

  if (category === 'appointments') {
    switch (operator) {
      case 'has_appointment': return activeAppointments(ctx).length > 0
      case 'no_appointment': return activeAppointments(ctx).length === 0
      case 'has_upcoming': return upcomingAppointments(ctx).length > 0
      case 'no_upcoming': return upcomingAppointments(ctx).length === 0
      case 'has_past_due':
        return activeAppointments(ctx).some((appt) => Date.parse(appt.endTime || appt.startTime) < ctx.now)
      case 'has_cancelled':
        return ctx.appointments.some((appt) => CANCELLED_STATUSES.has(appt.status))
      case 'has_confirmed':
        return activeAppointments(ctx).some((appt) => appt.status === 'confirmed')
      case 'in_calendar':
        return Boolean(condition.calendarId) && activeAppointments(ctx).some((appt) => appt.calendarId === condition.calendarId)
      case 'not_in_calendar':
        return !condition.calendarId || !activeAppointments(ctx).some((appt) => appt.calendarId === condition.calendarId)
      case 'date_is':
      case 'date_not':
      case 'date_before':
      case 'date_after':
      case 'date_between': {
        const appt = nextAppointment(ctx)
        if (!appt || !condition.date) return false
        const apptDate = String(appt.startTime || '').slice(0, 10)
        if (operator === 'date_is') return apptDate === condition.date
        if (operator === 'date_not') return apptDate !== condition.date
        if (operator === 'date_before') return apptDate < condition.date
        if (operator === 'date_after') return apptDate > condition.date
        return Boolean(condition.dateEnd) && apptDate >= condition.date && apptDate <= condition.dateEnd
      }
      case 'time_before': {
        // Estamos dentro de la ventana de X antes del inicio de la cita próxima
        const offset = (condition.offsetValue || 0) * (OFFSET_MS[condition.offsetUnit] || OFFSET_MS.minutes)
        return upcomingAppointments(ctx).some((appt) => {
          const start = Date.parse(appt.startTime)
          return ctx.now >= start - offset && ctx.now < start
        })
      }
      case 'time_after': {
        // Estamos dentro de la ventana de X después del fin de la cita
        const offset = (condition.offsetValue || 0) * (OFFSET_MS[condition.offsetUnit] || OFFSET_MS.minutes)
        return activeAppointments(ctx).some((appt) => {
          const end = Date.parse(appt.endTime || appt.startTime)
          return ctx.now >= end && ctx.now <= end + offset
        })
      }
      default: return false
    }
  }

  if (category === 'payments') {
    if (PAYMENT_STATUS_MAP[operator]) {
      return ctx.payments.some((payment) => PAYMENT_STATUS_MAP[operator].has(payment.status))
    }
    const value = normalizeMatchText(condition.value)
    switch (operator) {
      case 'product_is': return Boolean(value) && ctx.payments.some((payment) => payment.product === value)
      case 'product_not': return !value || !ctx.payments.some((payment) => payment.product === value)
      case 'product_contains': return Boolean(value) && ctx.payments.some((payment) => payment.product.includes(value))
      case 'product_not_contains': return !value || !ctx.payments.some((payment) => payment.product.includes(value))
      case 'amount_eq': return ctx.payments.some((payment) => payment.amount === (condition.amount || 0))
      case 'amount_gt': return ctx.payments.some((payment) => payment.amount > (condition.amount || 0))
      case 'amount_lt': return ctx.payments.some((payment) => payment.amount > 0 && payment.amount < (condition.amount || 0))
      case 'amount_between':
        return ctx.payments.some((payment) => payment.amount >= (condition.amount || 0) && payment.amount <= (condition.amountMax || 0))
      default: return false
    }
  }

  if (category === 'assignee') {
    const value = normalizeMatchText(condition.value)
    const matchesValue = Boolean(value) && (ctx.assigneeNames.some((name) => name.includes(value)) || ctx.assigneeIds.includes(value))
    switch (operator) {
      case 'assigned_to': return matchesValue
      case 'not_assigned_to': return !value || !matchesValue
      case 'has_assignee': return ctx.assigneeIds.length > 0
      case 'no_assignee': return ctx.assigneeIds.length === 0
      default: return false
    }
  }

  if (category === 'ads') {
    switch (operator) {
      case 'from_ad': return ctx.cameFromAd
      case 'not_from_ad': return !ctx.cameFromAd
      case 'ad_is': return Boolean(condition.value) && ctx.adSourceIds.includes(condition.value)
      case 'ad_is_not': return !condition.value || !ctx.adSourceIds.includes(condition.value)
      default: return false
    }
  }

  if (category === 'contact') {
    const info = ctx.contactInfo
    if (!info) return false
    const value = normalizeMatchText(condition.value)
    switch (operator) {
      case 'is_customer': return info.purchasesCount > 0 || info.totalPaid > 0
      case 'not_customer': return info.purchasesCount === 0 && info.totalPaid === 0
      case 'has_email': return Boolean(info.email)
      case 'no_email': return !info.email
      case 'source_is': return Boolean(value) && (info.source === value || info.attributionSource === value)
      case 'source_contains': return Boolean(value) && (info.source.includes(value) || info.attributionSource.includes(value))
      case 'created_within': {
        if (!info.createdAt) return false
        const offset = (condition.offsetValue || 0) * (OFFSET_MS[condition.offsetUnit] || OFFSET_MS.days)
        return ctx.now - Date.parse(info.createdAt) <= offset
      }
      default: return false
    }
  }

  if (category === 'schedule') {
    if (operator === 'day_is') {
      const days = (condition.values || []).map((day) => String(day).toLowerCase())
      return !days.length || days.includes(ctx.localWeekday)
    }
    const [startHour, startMinute] = String(condition.timeStart || '09:00').split(':').map(Number)
    const [endHour, endMinute] = String(condition.timeEnd || '18:00').split(':').map(Number)
    const start = startHour * 60 + (startMinute || 0)
    const end = endHour * 60 + (endMinute || 0)
    // Soporta rangos que cruzan medianoche (ej. 22:00 a 06:00)
    const inside = start <= end
      ? ctx.localMinutes >= start && ctx.localMinutes <= end
      : ctx.localMinutes >= start || ctx.localMinutes <= end
    return operator === 'time_outside' ? !inside : inside
  }

  if (category === 'business_phone') {
    const matches = Boolean(condition.value) && ctx.businessPhoneNumberId === condition.value
    return operator === 'is_not' ? (!condition.value || !matches) : matches
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
  const [metaAds, detectedRows, phoneRows] = await Promise.all([
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

function mapStateRow(row) {
  if (!row) return null
  return {
    contactId: row.contact_id,
    status: row.status,
    signal: row.signal || null,
    signalReason: row.signal_reason || null,
    signalSummary: row.signal_summary || null,
    signalAt: row.signal_at || null,
    lastInboundMessageId: row.last_inbound_message_id || null,
    lastReplyAt: row.last_reply_at || null,
    updatedBy: row.updated_by || null,
    agentId: row.agent_id || null,
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

export async function setConversationSignal(contactId, signal, { reason = '', summary = '', status = 'completed' } = {}) {
  await ensureConversationState(contactId)
  await db.run(`
    UPDATE conversational_agent_state
    SET signal = ?, signal_reason = ?, signal_summary = ?, signal_at = CURRENT_TIMESTAMP,
        status = ?, updated_by = 'agent', updated_at = CURRENT_TIMESTAMP
    WHERE contact_id = ?
  `, [signal, String(reason || '').slice(0, 600), String(summary || '').slice(0, 1200), status, contactId])

  await recordConversationalAgentEvent({
    contactId,
    eventType: 'signal_set',
    detail: { signal, reason, summary, status }
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
    await db.run(`
      INSERT INTO conversational_agent_events (id, contact_id, event_type, detail_json)
      VALUES (?, ?, ?, ?)
    `, [`cae_${randomUUID()}`, contactId, eventType, detail ? JSON.stringify(detail).slice(0, 4000) : null])
  } catch (error) {
    logger.warn(`[Agente conversacional] No se pudo registrar evento ${eventType}: ${error.message}`)
  }
}

export async function listConversationalAgentEvents({ contactId = null, limit = 100 } = {}) {
  const params = []
  let sql = 'SELECT * FROM conversational_agent_events'
  if (contactId) {
    sql += ' WHERE contact_id = ?'
    params.push(contactId)
  }
  sql += ' ORDER BY created_at DESC LIMIT ?'
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500))

  const rows = await db.all(sql, params)
  return rows.map((row) => ({
    id: row.id,
    contactId: row.contact_id,
    eventType: row.event_type,
    detail: row.detail_json ? safeParse(row.detail_json) : null,
    createdAt: row.created_at
  }))
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
