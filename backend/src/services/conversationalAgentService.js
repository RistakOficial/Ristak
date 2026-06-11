import { randomUUID } from 'crypto'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'

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

const EMPTY_ENTRY_FILTERS = {
  channel: 'any',      // any | whatsapp | messenger | instagram
  keywords: [],        // frases clave en el mensaje
  match: 'contains',   // contains | exact | starts_with
  tags: [],            // el contacto debe tener alguna de estas etiquetas
  calendarId: ''       // el contacto debe tener cita próxima en este calendario
}

function normalizeEntryFilters(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const channel = ['any', 'whatsapp', 'messenger', 'instagram'].includes(raw.channel) ? raw.channel : 'any'
  const match = ['contains', 'exact', 'starts_with'].includes(raw.match) ? raw.match : 'contains'
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 30)
    : []
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 30)
    : []
  const calendarId = String(raw.calendarId || '').trim()
  return { channel, keywords, match, tags, calendarId }
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
    entryFilters: normalizeEntryFilters(parseJsonField(row.entry_filters, null)),
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
    JSON.stringify(EMPTY_ENTRY_FILTERS)
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
    entryFilters: input.entryFilters === undefined ? base.entryFilters : normalizeEntryFilters(input.entryFilters)
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
  entryFilters: { ...EMPTY_ENTRY_FILTERS }
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
    next.closingStrategyMode, next.closingStrategyCustom, JSON.stringify(next.entryFilters)
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
    next.closingStrategyMode, next.closingStrategyCustom, JSON.stringify(next.entryFilters),
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

/**
 * Encuentra el primer agente habilitado cuyos filtros de entrada coinciden con
 * el mensaje/contacto (en orden de posición). Filtros vacíos = pasa.
 */
export async function matchAgentForMessage({ contactId, messageText = '', channel = 'whatsapp' } = {}) {
  const agents = (await listConversationalAgents()).filter((agent) => agent.enabled)
  if (!agents.length) return null

  const contact = contactId
    ? await db.get('SELECT id, tags FROM contacts WHERE id = ?', [contactId]).catch(() => null)
    : null
  const contactTags = parseJsonField(contact?.tags, []).map(normalizeMatchText)
  const text = normalizeMatchText(messageText)

  for (const agent of agents) {
    const filters = agent.entryFilters

    if (filters.channel !== 'any' && filters.channel !== channel) continue

    if (filters.keywords.length) {
      const matched = filters.keywords.some((keyword) => {
        const needle = normalizeMatchText(keyword)
        if (!needle) return false
        if (filters.match === 'exact') return text === needle
        if (filters.match === 'starts_with') return text.startsWith(needle)
        return text.includes(needle)
      })
      if (!matched) continue
    }

    if (filters.tags.length) {
      const hasTag = filters.tags.some((tag) => contactTags.includes(normalizeMatchText(tag)))
      if (!hasTag) continue
    }

    if (filters.calendarId) {
      const appointment = contactId
        ? await db.get(`
            SELECT id FROM appointments
            WHERE contact_id = ? AND calendar_id = ? AND deleted_at IS NULL AND start_time >= ?
            LIMIT 1
          `, [contactId, filters.calendarId, new Date().toISOString()]).catch(() => null)
        : null
      if (!appointment) continue
    }

    return agent
  }

  return null
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
        const row = await db.get('SELECT tags FROM contacts WHERE id = ?', [contactId])
        const tags = parseJsonField(row?.tags, [])
        const list = Array.isArray(tags) ? tags : []
        const next = extra.type === 'remove_tag'
          ? list.filter((candidate) => normalizeMatchText(candidate) !== normalizeMatchText(extra.tag))
          : [...new Set([...list, extra.tag])]
        await db.run('UPDATE contacts SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [JSON.stringify(next), contactId])
        applied.push({ type: extra.type, tag: extra.tag })
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
