import { createHash, randomUUID } from 'node:crypto'
import { db } from '../config/database.js'
import { normalizeToUtcIso } from '../utils/dateUtils.js'
import {
  coalescedTimestampSortExpression,
  timestampSortExpression,
  timestampSortParameterExpression
} from '../utils/sqlTimestampSort.js'
import {
  NON_LIVE_PAYMENT_MODES,
  SUCCESS_PAYMENT_STATUSES
} from '../agents/conversational/paymentEvidenceConstants.js'

export const CONVERSATIONAL_HANDOFF_RULE_EVENT_TYPE = 'handoff_rule_pending'
export const CONVERSATIONAL_LEGACY_BACKFILL_CYCLE_PREFIX =
  'cac_legacy_backfill_'

const PENDING_HANDOFF_RULE_STATUSES = new Set([
  'ready',
  'awaiting_required_data',
  'executing',
  'failed'
])
const HANDOFF_EXECUTION_LEASE_MS = 2 * 60 * 1000
const HANDOFF_LATCH_SCAN_PAGE_SIZE = 200
const VERIFIED_APPOINTMENT_STATUSES = Object.freeze([
  'new',
  'booked',
  'confirmed',
  'scheduled',
  'showed',
  'show',
  'attended',
  'completed',
  'complete'
])

function cleanText(value, maxLength = 1000) {
  return String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function cleanPolicyRules(value, maxLength = 4000) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, maxLength)
}

function normalizeChannel(value = 'whatsapp') {
  return cleanText(value, 40).toLowerCase() || 'whatsapp'
}

function handoffRuleError(message, code, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode, status: statusCode })
}

function requiredIdentity(value, label, maxLength = 180) {
  const normalized = cleanText(value, maxLength)
  if (!normalized) {
    throw handoffRuleError(
      `Falta ${label} para conservar la obligación de traspaso.`,
      'handoff_rule_identity_missing',
      400
    )
  }
  return normalized
}

function parseDetail(value) {
  if (!value) return null
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function requireDetail(value, eventId = '') {
  const detail = parseDetail(value)
  if (!detail || Number(detail.schemaVersion) < 2 || !String(detail.status || '').trim()) {
    throw handoffRuleError(
      `La obligación durable de traspaso ${cleanText(eventId, 180) || 'desconocida'} está dañada.`,
      'handoff_rule_latch_corrupt',
      500
    )
  }
  return detail
}

function updatedRowCount(result = {}) {
  return Number(result?.changes ?? result?.rowCount ?? 0)
}

function rowLockSuffix() {
  return process.env.DATABASE_URL ? ' FOR UPDATE' : ''
}

function normalizeRequirementCondition(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const fact = cleanText(source.fact, 100)
  return fact && source.operator === 'is_true' && source.value === true
    ? { fact, operator: 'is_true', value: true }
    : null
}

function normalizedDataRequirements(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  const fields = (Array.isArray(source.fields) ? source.fields : [])
    .slice(0, 40)
    .map((item) => ({
      field: cleanText(item?.field, 120),
      label: cleanText(item?.label, 180),
      level: cleanText(item?.level, 40),
      scope: cleanText(item?.scope, 80),
      condition: normalizeRequirementCondition(item?.condition)
    }))
    .filter((item) => item.field)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  return {
    enabled: source.enabled === true,
    fields,
    updateContact: {
      enabled: source.updateContact?.enabled !== false,
      policy: cleanText(source.updateContact?.policy, 80)
    }
  }
}

function normalizedRulePolicy(policy = {}) {
  return {
    agentEnabled: policy.agentEnabled !== false,
    runtimeMode: cleanText(policy.runtimeMode, 80),
    enabled: policy.enabled !== false,
    rules: cleanPolicyRules(policy.rules, 4000),
    pastClientsToHuman: policy.pastClientsToHuman === true,
    assignedUserId: cleanText(policy.assignedUserId || policy.userId, 160),
    generalFallbackPolicy: cleanText(policy.generalFallbackPolicy, 80),
    dataRequirements: normalizedDataRequirements(policy.dataRequirements)
  }
}

export function buildHandoffRuleFingerprint(policy = {}) {
  return createHash('sha256')
    .update(JSON.stringify(normalizedRulePolicy(policy)))
    .digest('hex')
}

export function buildHandoffRuleLatchId({
  contactId,
  agentId,
  channel = 'whatsapp',
  ruleFingerprint,
  conversationScopeId = '',
  triggerMessageId = '',
  evidenceDigest = ''
} = {}) {
  const identity = [
    cleanText(contactId, 180),
    cleanText(agentId, 180),
    normalizeChannel(channel),
    cleanText(ruleFingerprint, 128),
    cleanText(conversationScopeId, 180),
    cleanText(triggerMessageId, 180) || cleanText(evidenceDigest, 180)
  ].join('\u0000')
  return `cae_handoff_rule_${createHash('sha256').update(identity).digest('hex').slice(0, 48)}`
}

function normalizedDatabaseInstant(value) {
  const normalized = normalizeToUtcIso(value, 'UTC')
  const timestamp = Date.parse(String(normalized || ''))
  return Number.isFinite(timestamp) ? normalized : null
}

export function hasExactHandoffActivationCycleBoundary(scope = {}) {
  const stateId = cleanText(scope?.stateId || scope?.id, 180)
  const activationCycleId = cleanText(
    scope?.activationCycleId || scope?.activation_cycle_id,
    180
  )
  if (!activationCycleId) return false
  return (
    !activationCycleId.startsWith(CONVERSATIONAL_LEGACY_BACKFILL_CYCLE_PREFIX) &&
    (!stateId || activationCycleId !== stateId)
  )
}

function mapConversationScopeRow(row = {}) {
  if (!row?.id) return null
  const activationCycleId = cleanText(row.activation_cycle_id, 180)
  const cutoffIso = normalizedDatabaseInstant(row.activation_cycle_started_at)
  if (!activationCycleId || !cutoffIso) return null
  const conversationScopeId = `handoff_scope_${createHash('sha256')
    .update([String(row.id), activationCycleId].join('\u0000'))
    .digest('hex')
    .slice(0, 40)}`
  return {
    stateId: String(row.id),
    activationCycleId,
    activationCycleStartedMessageId:
      cleanText(row.activation_cycle_started_message_id, 180) || null,
    activationCycleBoundaryExact: hasExactHandoffActivationCycleBoundary({
      stateId: row.id,
      activationCycleId
    }),
    conversationScopeId,
    cutoffIso,
    status: String(row.status || ''),
    signal: String(row.signal || '') || null
  }
}

export async function loadHandoffConversationScope({
  contactId,
  agentId,
  channel = 'whatsapp',
  lock = false
} = {}) {
  const cleanContactId = cleanText(contactId, 180)
  const cleanAgentId = cleanText(agentId, 180)
  if (!cleanContactId || !cleanAgentId) return null
  const row = await db.get(
    `SELECT id, activation_cycle_id, activation_cycle_started_at,
            activation_cycle_started_message_id,
            status, signal
     FROM conversational_agent_state
     WHERE contact_id = ? AND agent_id = ?
       AND COALESCE(NULLIF(channel, ''), 'whatsapp') = ?
     LIMIT 1${lock ? rowLockSuffix() : ''}`,
    [cleanContactId, cleanAgentId, normalizeChannel(channel)]
  )
  return mapConversationScopeRow(row)
}

function mapLatchRow(row = {}) {
  if (!row?.id) return null
  const detail = requireDetail(row.detail_json, row.id)
  return {
    id: String(row.id),
    createdAt: row.created_at || null,
    detailJson: String(row.detail_json || ''),
    detail
  }
}

async function scanHandoffRuleLatchRows({
  contactId,
  agentId
} = {}, visit) {
  let offset = 0
  while (true) {
    const rows = await db.all(
      `SELECT id, contact_id, agent_id, detail_json, created_at
       FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [
        cleanText(contactId, 180),
        cleanText(agentId, 180),
        CONVERSATIONAL_HANDOFF_RULE_EVENT_TYPE,
        HANDOFF_LATCH_SCAN_PAGE_SIZE,
        offset
      ]
    )
    for (const row of rows) {
      const result = await visit(row)
      if (result !== undefined) return result
    }
    if (rows.length < HANDOFF_LATCH_SCAN_PAGE_SIZE) return undefined
    offset += rows.length
  }
}

function sanitizeActionScopedContactData(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const sanitized = {}
  const scalarLimits = {
    full_name: 240,
    first_name: 120,
    last_name: 180,
    phone: 80,
    email: 240
  }
  for (const [field, maxLength] of Object.entries(scalarLimits)) {
    const clean = cleanText(source[field], maxLength)
    if (clean) sanitized[field] = clean
  }
  const customFields = String(source.custom_fields || '').trim()
  if (customFields) {
    try {
      const parsed = JSON.parse(customFields)
      if (Array.isArray(parsed)) {
        sanitized.custom_fields = JSON.stringify(parsed.slice(0, 40))
      }
    } catch {
      // Un dato temporal inválido jamás debe corromper el latch.
    }
  }
  return sanitized
}

function cleanRequiredFields(requiredFields = []) {
  return (Array.isArray(requiredFields) ? requiredFields : [])
    .slice(0, 20)
    .map((item) => ({
      field: cleanText(item?.field, 80),
      label: cleanText(item?.label, 120)
    }))
    .filter((item) => item.field)
}

export async function supersedeStaleHandoffRuleLatches({
  contactId,
  agentId,
  channel = 'whatsapp',
  ruleFingerprint,
  conversationScopeId = ''
} = {}) {
  const normalizedChannel = normalizeChannel(channel)
  const cleanConversationScopeId = cleanText(conversationScopeId, 180)
  await scanHandoffRuleLatchRows({ contactId, agentId }, async (row) => {
    const detail = requireDetail(row.detail_json, row.id)
    if (
      normalizeChannel(detail.channel) !== normalizedChannel ||
      !PENDING_HANDOFF_RULE_STATUSES.has(String(detail.status || ''))
    ) return
    const samePolicy = String(detail.ruleFingerprint || '') === String(ruleFingerprint || '')
    const sameConversation = Boolean(cleanConversationScopeId) &&
      String(detail.conversationScopeId || '') === cleanConversationScopeId
    if (samePolicy && sameConversation) return
    const next = {
      ...detail,
      status: 'superseded',
      actionScopedContactData: {},
      executionToken: null,
      executionStartedAt: null,
      supersededAt: new Date().toISOString(),
      supersededReason: sameConversation
        ? 'handoff_rule_configuration_changed'
        : 'handoff_rule_conversation_changed'
    }
    await db.run(
      `UPDATE conversational_agent_events
       SET detail_json = ?
       WHERE id = ? AND event_type = ? AND detail_json = ?`,
      [
        JSON.stringify(next),
        row.id,
        CONVERSATIONAL_HANDOFF_RULE_EVENT_TYPE,
        row.detail_json
      ]
    )
  })
}

export async function loadActiveHandoffRuleLatch({
  contactId,
  agentId,
  channel = 'whatsapp',
  ruleFingerprint,
  conversationScopeId
} = {}) {
  const normalizedChannel = normalizeChannel(channel)
  const cleanConversationScopeId = cleanText(conversationScopeId, 180)
  const active = await scanHandoffRuleLatchRows({ contactId, agentId }, async (row) => {
    const mapped = mapLatchRow(row)
    const detail = mapped.detail
    if (
      normalizeChannel(detail.channel) === normalizedChannel &&
      String(detail.ruleFingerprint || '') === String(ruleFingerprint || '') &&
      String(detail.conversationScopeId || '') === cleanConversationScopeId &&
      PENDING_HANDOFF_RULE_STATUSES.has(String(detail.status || ''))
    ) return mapped
  })
  return active || null
}

export async function upsertHandoffRuleLatch({
  contactId,
  agentId,
  channel = 'whatsapp',
  ruleFingerprint,
  conversationScopeId = '',
  triggerMessageId = '',
  evidenceDigest = '',
  matchSource = 'configured_rules',
  matchedRule = '',
  reason = '',
  summary = ''
} = {}) {
  const cleanContactId = requiredIdentity(contactId, 'contactId')
  const cleanAgentId = requiredIdentity(agentId, 'agentId')
  const cleanRuleFingerprint = requiredIdentity(ruleFingerprint, 'ruleFingerprint', 128)
  const cleanConversationScopeId = requiredIdentity(conversationScopeId, 'conversationScopeId')
  const cleanTriggerMessageId = cleanText(triggerMessageId, 180)
  const cleanEvidenceDigest = cleanText(evidenceDigest, 180)
  if (!cleanTriggerMessageId && !cleanEvidenceDigest) {
    throw handoffRuleError(
      'Falta el mensaje que originó la obligación de traspaso.',
      'handoff_rule_trigger_missing',
      400
    )
  }
  const normalizedChannel = normalizeChannel(channel)

  return db.transaction(async () => {
    const scope = await loadHandoffConversationScope({
      contactId: cleanContactId,
      agentId: cleanAgentId,
      channel: normalizedChannel,
      lock: true
    })
    if (
      !scope ||
      scope.status !== 'active' ||
      scope.signal ||
      scope.conversationScopeId !== cleanConversationScopeId
    ) {
      throw handoffRuleError(
        'La conversación cambió antes de conservar la obligación de traspaso.',
        'handoff_rule_conversation_scope_lost'
      )
    }

    const existing = await loadActiveHandoffRuleLatch({
      contactId: cleanContactId,
      agentId: cleanAgentId,
      channel: normalizedChannel,
      ruleFingerprint: cleanRuleFingerprint,
      conversationScopeId: cleanConversationScopeId
    })
    if (existing) return existing

    const eventId = buildHandoffRuleLatchId({
      contactId: cleanContactId,
      agentId: cleanAgentId,
      channel: normalizedChannel,
      ruleFingerprint: cleanRuleFingerprint,
      conversationScopeId: cleanConversationScopeId,
      triggerMessageId: cleanTriggerMessageId,
      evidenceDigest: cleanEvidenceDigest
    })
    const nowIso = new Date().toISOString()
    const detail = {
      schemaVersion: 2,
      agentId: cleanAgentId,
      channel: normalizedChannel,
      ruleFingerprint: cleanRuleFingerprint,
      conversationScopeId: cleanConversationScopeId,
      triggerMessageId: cleanTriggerMessageId || null,
      matchSource: cleanText(matchSource, 80),
      matchedRule: cleanText(matchedRule, 4000) || null,
      reason: cleanText(reason, 800) || 'Se cumplió una condición obligatoria de traspaso',
      summary: cleanText(summary, 1000) || 'La conversación debe continuar con el equipo humano',
      status: 'ready',
      matchedAt: nowIso,
      requiredFields: [],
      actionScopedContactData: {}
    }
    await db.run(
      `INSERT INTO conversational_agent_events
        (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [
        eventId,
        cleanContactId,
        cleanAgentId,
        CONVERSATIONAL_HANDOFF_RULE_EVENT_TYPE,
        JSON.stringify(detail)
      ]
    )
    const row = await db.get(
      `SELECT id, contact_id, agent_id, detail_json, created_at
       FROM conversational_agent_events
       WHERE id = ? AND event_type = ?`,
      [eventId, CONVERSATIONAL_HANDOFF_RULE_EVENT_TYPE]
    )
    const stored = requireDetail(row?.detail_json, eventId)
    if (
      !row?.id ||
      String(row.contact_id || '') !== cleanContactId ||
      String(row.agent_id || '') !== cleanAgentId ||
      Number(stored.schemaVersion) < 2 ||
      normalizeChannel(stored.channel) !== normalizedChannel ||
      String(stored.ruleFingerprint || '') !== cleanRuleFingerprint ||
      String(stored.conversationScopeId || '') !== cleanConversationScopeId
    ) {
      throw handoffRuleError(
        'La obligación durable de traspaso entró en conflicto con otra identidad.',
        'handoff_rule_latch_identity_conflict'
      )
    }
    return mapLatchRow(row)
  })
}

export async function markHandoffRuleLatchAwaitingData({
  eventId,
  ruleFingerprint,
  requiredFields = [],
  actionScopedContactData = {}
} = {}) {
  return db.transaction(async () => {
    const row = await db.get(
      `SELECT id, detail_json
       FROM conversational_agent_events
       WHERE id = ? AND event_type = ?${rowLockSuffix()}`,
      [cleanText(eventId, 180), CONVERSATIONAL_HANDOFF_RULE_EVENT_TYPE]
    )
    if (!row?.id) return null
    const detail = requireDetail(row.detail_json, row.id)
    if (
      String(detail.ruleFingerprint || '') !== String(ruleFingerprint || '') ||
      !['ready', 'awaiting_required_data'].includes(String(detail.status || ''))
    ) return null
    const next = {
      ...detail,
      status: 'awaiting_required_data',
      requiredFields: cleanRequiredFields(requiredFields),
      actionScopedContactData: sanitizeActionScopedContactData(actionScopedContactData),
      waitingSince: detail.waitingSince || new Date().toISOString(),
      executionToken: null,
      executionStartedAt: null
    }
    const nextJson = JSON.stringify(next)
    const updated = await db.run(
      `UPDATE conversational_agent_events
       SET detail_json = ?
       WHERE id = ? AND event_type = ? AND detail_json = ?`,
      [nextJson, row.id, CONVERSATIONAL_HANDOFF_RULE_EVENT_TYPE, row.detail_json]
    )
    return updatedRowCount(updated) === 1
      ? { id: row.id, detail: next, detailJson: nextJson }
      : null
  })
}

export async function claimHandoffRuleLatch({
  eventId,
  ruleFingerprint,
  conversationScopeId,
  executionId = ''
} = {}) {
  return db.transaction(async () => {
    const row = await db.get(
      `SELECT id, detail_json
       FROM conversational_agent_events
       WHERE id = ? AND event_type = ?${rowLockSuffix()}`,
      [cleanText(eventId, 180), CONVERSATIONAL_HANDOFF_RULE_EVENT_TYPE]
    )
    if (!row?.id) return { claimed: false, reason: 'missing' }
    const detail = requireDetail(row.detail_json, row.id)
    if (String(detail.ruleFingerprint || '') !== String(ruleFingerprint || '')) {
      return { claimed: false, reason: 'configuration_changed' }
    }
    if (String(detail.conversationScopeId || '') !== String(conversationScopeId || '')) {
      return { claimed: false, reason: 'conversation_changed' }
    }
    if (String(detail.status || '') === 'completed') {
      return { claimed: false, reason: 'already_completed', completed: true }
    }
    if (!PENDING_HANDOFF_RULE_STATUSES.has(String(detail.status || ''))) {
      return { claimed: false, reason: String(detail.status || 'inactive') }
    }
    const startedAtMs = Date.parse(String(detail.executionStartedAt || ''))
    const activeLease = String(detail.status || '') === 'executing' &&
      Number.isFinite(startedAtMs) &&
      Date.now() - startedAtMs < HANDOFF_EXECUTION_LEASE_MS
    if (activeLease) return { claimed: false, reason: 'busy' }

    const executionToken = createHash('sha256')
      .update([
        String(row.id),
        cleanText(executionId, 180),
        randomUUID()
      ].join('\u0000'))
      .digest('hex')
    const next = {
      ...detail,
      status: 'executing',
      executionToken,
      executionStartedAt: new Date().toISOString()
    }
    const nextJson = JSON.stringify(next)
    const updated = await db.run(
      `UPDATE conversational_agent_events
       SET detail_json = ?
       WHERE id = ? AND event_type = ? AND detail_json = ?`,
      [nextJson, row.id, CONVERSATIONAL_HANDOFF_RULE_EVENT_TYPE, row.detail_json]
    )
    return updatedRowCount(updated) === 1
      ? { claimed: true, eventId: row.id, executionToken, detail: next }
      : { claimed: false, reason: 'race_lost' }
  })
}

export async function settleHandoffRuleLatch({
  eventId,
  executionToken,
  status,
  error = '',
  requiredFields = [],
  actionScopedContactData = {}
} = {}) {
  const normalizedStatus = String(status || '').trim()
  if (!['completed', 'ready', 'failed', 'awaiting_required_data'].includes(normalizedStatus)) {
    throw handoffRuleError(
      `Transición inválida de obligación de traspaso: ${normalizedStatus || 'vacía'}.`,
      'handoff_rule_invalid_settlement',
      500
    )
  }
  return db.transaction(async () => {
    const row = await db.get(
      `SELECT id, detail_json
       FROM conversational_agent_events
       WHERE id = ? AND event_type = ?${rowLockSuffix()}`,
      [cleanText(eventId, 180), CONVERSATIONAL_HANDOFF_RULE_EVENT_TYPE]
    )
    if (!row?.id) return false
    const detail = requireDetail(row.detail_json, row.id)
    if (
      String(detail.status || '') !== 'executing' ||
      String(detail.executionToken || '') !== String(executionToken || '')
    ) return String(detail.status || '') === normalizedStatus
    const nowIso = new Date().toISOString()
    const next = {
      ...detail,
      status: normalizedStatus,
      executionToken: null,
      executionStartedAt: null,
      executionFinishedAt: nowIso,
      ...(normalizedStatus === 'completed'
        ? {
            completedAt: nowIso,
            requiredFields: [],
            actionScopedContactData: {}
          }
        : {}),
      ...(normalizedStatus === 'awaiting_required_data'
        ? {
            waitingSince: detail.waitingSince || nowIso,
            requiredFields: cleanRequiredFields(requiredFields),
            actionScopedContactData: sanitizeActionScopedContactData(actionScopedContactData)
          }
        : {}),
      ...(error ? { lastError: cleanText(error, 1000) } : {})
    }
    const updated = await db.run(
      `UPDATE conversational_agent_events
       SET detail_json = ?
       WHERE id = ? AND event_type = ? AND detail_json = ?`,
      [
        JSON.stringify(next),
        row.id,
        CONVERSATIONAL_HANDOFF_RULE_EVENT_TYPE,
        row.detail_json
      ]
    )
    return updatedRowCount(updated) === 1
  })
}

export async function isHandoffRuleLatchCompleted({
  eventId,
  ruleFingerprint,
  conversationScopeId
} = {}) {
  const row = await db.get(
    `SELECT id, detail_json
     FROM conversational_agent_events
     WHERE id = ? AND event_type = ?`,
    [cleanText(eventId, 180), CONVERSATIONAL_HANDOFF_RULE_EVENT_TYPE]
  )
  if (!row?.id) return false
  const detail = requireDetail(row.detail_json, row.id)
  return String(detail.status || '') === 'completed' &&
    String(detail.ruleFingerprint || '') === String(ruleFingerprint || '') &&
    String(detail.conversationScopeId || '') === String(conversationScopeId || '')
}

async function assertHandoffRuleExecutionAuthority({
  eventId,
  executionToken,
  ruleFingerprint,
  conversationScopeId,
  contactId,
  agentId,
  channel = 'whatsapp',
  processingMessageId,
  inboundClaimToken,
  complete = false
} = {}) {
  const cleanEventId = requiredIdentity(eventId, 'eventId')
  const cleanExecutionToken = requiredIdentity(executionToken, 'executionToken')
  const cleanRuleFingerprint = requiredIdentity(ruleFingerprint, 'ruleFingerprint', 128)
  const cleanConversationScopeId = requiredIdentity(conversationScopeId, 'conversationScopeId')
  const cleanContactId = requiredIdentity(contactId, 'contactId')
  const cleanAgentId = requiredIdentity(agentId, 'agentId')
  const cleanProcessingMessageId = requiredIdentity(processingMessageId, 'processingMessageId')
  const cleanInboundClaimToken = requiredIdentity(inboundClaimToken, 'inboundClaimToken')
  const normalizedChannel = normalizeChannel(channel)

  const stateRow = await db.get(
    `SELECT id, activation_cycle_id, activation_cycle_started_at,
            activation_cycle_started_message_id,
            status, signal,
            last_inbound_message_id, inbound_processing_message_id,
            inbound_processing_status, inbound_processing_claim_token,
            inbound_processing_lease_until_at
     FROM conversational_agent_state
     WHERE contact_id = ? AND agent_id = ?
       AND COALESCE(NULLIF(channel, ''), 'whatsapp') = ?
     LIMIT 1${rowLockSuffix()}`,
    [cleanContactId, cleanAgentId, normalizedChannel]
  )
  const scope = mapConversationScopeRow(stateRow)
  const inboundLeaseUntilMs = Date.parse(String(stateRow?.inbound_processing_lease_until_at || ''))
  const stateOwnsInbound = Boolean(
    scope &&
    scope.status === 'active' &&
    !scope.signal &&
    scope.conversationScopeId === cleanConversationScopeId &&
    String(stateRow.last_inbound_message_id || '') === cleanProcessingMessageId &&
    String(stateRow.inbound_processing_message_id || '') === cleanProcessingMessageId &&
    String(stateRow.inbound_processing_status || '') === 'processing' &&
    String(stateRow.inbound_processing_claim_token || '') === cleanInboundClaimToken &&
    Number.isFinite(inboundLeaseUntilMs) &&
    inboundLeaseUntilMs > Date.now()
  )
  if (!stateOwnsInbound) {
    throw handoffRuleError(
      'Otro mensaje o una persona tomó autoridad antes del traspaso.',
      'handoff_rule_inbound_authority_lost'
    )
  }

  const row = await db.get(
    `SELECT id, contact_id, agent_id, detail_json
     FROM conversational_agent_events
     WHERE id = ? AND event_type = ?${rowLockSuffix()}`,
    [cleanEventId, CONVERSATIONAL_HANDOFF_RULE_EVENT_TYPE]
  )
  if (!row?.id) {
    throw handoffRuleError(
      'La obligación durable de traspaso dejó de existir.',
      'handoff_rule_latch_missing'
    )
  }
  const detail = requireDetail(row.detail_json, row.id)
  const latchLeaseStartedAtMs = Date.parse(String(detail.executionStartedAt || ''))
  const latchLeaseIsActive = Number.isFinite(latchLeaseStartedAtMs) &&
    Date.now() - latchLeaseStartedAtMs < HANDOFF_EXECUTION_LEASE_MS
  const latchOwnsExecution = Boolean(
    String(row.contact_id || '') === cleanContactId &&
    String(row.agent_id || '') === cleanAgentId &&
    normalizeChannel(detail.channel) === normalizedChannel &&
    String(detail.ruleFingerprint || '') === cleanRuleFingerprint &&
    String(detail.conversationScopeId || '') === cleanConversationScopeId &&
    String(detail.status || '') === 'executing' &&
    String(detail.executionToken || '') === cleanExecutionToken &&
    latchLeaseIsActive
  )
  if (!latchOwnsExecution) {
    throw handoffRuleError(
      'Otro proceso o una configuración nueva invalidó este traspaso.',
      'handoff_rule_execution_authority_lost'
    )
  }
  if (!complete) {
    return {
      authorized: true,
      stateId: scope.stateId,
      eventId: row.id,
      executionToken: cleanExecutionToken
    }
  }

  const nowIso = new Date().toISOString()
  const next = {
    ...detail,
    status: 'completed',
    executionToken: null,
    executionStartedAt: null,
    executionFinishedAt: nowIso,
    completedAt: nowIso,
    requiredFields: [],
    actionScopedContactData: {}
  }
  const updated = await db.run(
    `UPDATE conversational_agent_events
     SET detail_json = ?
     WHERE id = ? AND event_type = ? AND detail_json = ?`,
    [
      JSON.stringify(next),
      row.id,
      CONVERSATIONAL_HANDOFF_RULE_EVENT_TYPE,
      row.detail_json
    ]
  )
  if (updatedRowCount(updated) !== 1) {
    throw handoffRuleError(
      'La obligación de traspaso perdió autoridad justo antes del commit.',
      'handoff_rule_execution_authority_lost'
    )
  }
  return {
    authorized: true,
    completed: true,
    stateId: scope.stateId,
    eventId: row.id,
    executionToken: cleanExecutionToken
  }
}

/**
 * Debe ejecutarse dentro de la misma transacción que la mutación protegida.
 * Verifica configuración/scope/inbound/latch sin consumir la obligación.
 */
export async function verifyHandoffRuleExecutionAuthority(options = {}) {
  return assertHandoffRuleExecutionAuthority({ ...options, complete: false })
}

/**
 * Debe ejecutarse dentro de commitNativeHandoff. El latch queda completed en
 * la misma transacción que la asignación y el estado humano; un rollback
 * revierte todo y un lease vencido jamás puede producir un segundo efecto.
 */
export async function commitHandoffRuleExecutionAuthority(options = {}) {
  return assertHandoffRuleExecutionAuthority({ ...options, complete: true })
}

function sqlPlaceholders(values = []) {
  return values.map(() => '?').join(', ')
}

export async function hasVerifiedPastClientEvidence({
  contactId,
  beforeIso = null
} = {}) {
  const cleanContactId = cleanText(contactId, 180)
  if (!cleanContactId) return false
  const cutoff = normalizedDatabaseInstant(beforeIso || new Date())
  if (!cutoff) {
    throw handoffRuleError(
      'No se pudo fijar el instante para comprobar si el contacto ya era cliente.',
      'handoff_past_client_cutoff_invalid',
      500
    )
  }

  const appointmentStartExpression = timestampSortExpression('start_time')
  const appointmentRecordedExpression = coalescedTimestampSortExpression('date_added', 'start_time')
  const paymentTimeExpression = coalescedTimestampSortExpression('paid_at', 'date', 'created_at')
  const cutoffExpression = timestampSortParameterExpression()
  const appointmentStatuses = [...VERIFIED_APPOINTMENT_STATUSES]
  const paymentStatuses = [...SUCCESS_PAYMENT_STATUSES]
  const nonLiveModes = [...new Set(
    [...NON_LIVE_PAYMENT_MODES].map((mode) => String(mode).replace(/_/g, ' ').toLowerCase())
  )]

  const [appointment, payment] = await Promise.all([
    db.get(
      `SELECT id
       FROM appointments
       WHERE contact_id = ?
         AND deleted_at IS NULL
         AND COALESCE(is_test, 0) = 0
         AND LOWER(TRIM(COALESCE(NULLIF(appointment_status, ''), status, '')))
           IN (${sqlPlaceholders(appointmentStatuses)})
         AND ${appointmentStartExpression} < ${cutoffExpression}
         AND ${appointmentRecordedExpression} < ${cutoffExpression}
       ORDER BY ${appointmentStartExpression} DESC
       LIMIT 1`,
      [cleanContactId, ...appointmentStatuses, cutoff, cutoff]
    ),
    db.get(
      `SELECT id
       FROM payments
       WHERE contact_id = ?
         AND (conversational_test_effect_id IS NULL OR conversational_test_effect_id = '')
         AND LOWER(TRIM(COALESCE(status, ''))) IN (${sqlPlaceholders(paymentStatuses)})
         AND LOWER(REPLACE(TRIM(COALESCE(payment_mode, '')), '_', ' '))
           NOT IN (${sqlPlaceholders(nonLiveModes)})
         AND ${paymentTimeExpression} < ${cutoffExpression}
       ORDER BY ${paymentTimeExpression} DESC
       LIMIT 1`,
      [cleanContactId, ...paymentStatuses, ...nonLiveModes, cutoff]
    )
  ])
  return Boolean(appointment?.id || payment?.id)
}
