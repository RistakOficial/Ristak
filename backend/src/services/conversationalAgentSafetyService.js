import { createHash, randomUUID } from 'node:crypto'

import { db } from '../config/database.js'
import { normalizeToUtcIso } from '../utils/dateUtils.js'

export const PREVENTIVE_MEASURE_CATEGORIES = Object.freeze([
  'phishing',
  'malicious_link',
  'fraud',
  'spam',
  'sexual_harassment',
  'threat',
  'severe_abuse',
  'prompt_injection',
  'other'
])

export const PREVENTIVE_MEASURE_SEVERITIES = Object.freeze(['high', 'critical'])

const CATEGORY_SET = new Set(PREVENTIVE_MEASURE_CATEGORIES)
const SEVERITY_SET = new Set(PREVENTIVE_MEASURE_SEVERITIES)
const BLOCK_MODES = new Set(['temporary', 'indefinite'])
const NOTIFICATION_AUDIENCES = new Set(['account_admins', 'owner', 'assigned_user', 'human_review', 'specific_user'])
const MAX_QUARANTINE_MINUTES = 30 * 24 * 60
const DEFAULT_NOTIFICATION_LEASE_MS = 2 * 60 * 1000
const MAX_NOTIFICATION_LEASE_MS = 10 * 60 * 1000
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_SAFETY_LOCK_WAIT_MS = 45 * 1000
const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|bearer|token|secret|password|encrypted|access[_-]?token|refresh[_-]?token|client[_-]?secret)/i

function safetyError(message, statusCode = 400, code = 'invalid_preventive_measure') {
  const error = new Error(message)
  error.status = statusCode
  error.statusCode = statusCode
  error.code = code
  return error
}

function mutationCount(result) {
  return Number(result?.changes ?? result?.rowCount ?? 0)
}

function cleanText(value, maxLength = 2400) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > maxLength ? text.slice(0, maxLength) : text
}

function requiredText(value, label, maxLength = 240) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!normalized) throw safetyError(`${label} es obligatorio.`, 400, 'preventive_measure_identity_required')
  if (normalized.length > maxLength) {
    throw safetyError(`${label} excede ${maxLength} caracteres.`, 400, 'preventive_measure_value_too_long')
  }
  return normalized
}

function normalizeChannel(value) {
  const channel = requiredText(value, 'channel', 80).toLowerCase()
  if (!/^[a-z0-9][a-z0-9._:-]{0,79}$/.test(channel)) {
    throw safetyError('channel no es un identificador válido.', 400, 'invalid_preventive_measure_channel')
  }
  return channel
}

function normalizeCategory(value) {
  const category = cleanText(value, 80).toLowerCase()
  if (!CATEGORY_SET.has(category)) {
    throw safetyError('La categoría preventiva no está permitida.', 400, 'invalid_preventive_measure_category')
  }
  return category
}

function normalizeSeverity(value) {
  const severity = cleanText(value, 24).toLowerCase()
  if (!SEVERITY_SET.has(severity)) {
    throw safetyError('La severidad preventiva debe ser high o critical.', 400, 'invalid_preventive_measure_severity')
  }
  return severity
}

function sanitizeValue(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null
  if (typeof value === 'string') return cleanText(value, 2400)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth >= 6) return '[recortado]'

  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => sanitizeValue(item, depth + 1))
  }

  if (typeof value === 'object') {
    const output = {}
    for (const [key, child] of Object.entries(value).slice(0, 80)) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? '[redactado]' : sanitizeValue(child, depth + 1)
    }
    return output
  }

  return cleanText(value, 2400)
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value).sort().reduce((output, key) => {
    output[key] = stableValue(value[key])
    return output
  }, {})
}

function normalizeEvidence(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return sanitizeValue(value)
  }
  const summary = cleanText(value, 2400)
  return summary ? { summary } : {}
}

function safeJson(value) {
  const serialized = JSON.stringify(sanitizeValue(value))
  return serialized.length <= 24000
    ? serialized
    : JSON.stringify({ truncated: true, preview: serialized.slice(0, 23000) })
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  if (typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function getConversationalAgentSafetyLockName({ contactId, channel } = {}) {
  const cleanContactId = requiredText(contactId, 'contactId', 240)
  const cleanChannel = normalizeChannel(channel)
  return `conversational-agent-safety:${sha256(`${cleanContactId}\u0000${cleanChannel}`)}`
}

/**
 * Candado distribuido común para la cuarentena y cualquier efecto mutable del
 * agente. `db.withAdvisoryLock` es try-lock a propósito; aquí esperamos con
 * backoff acotado para que una segunda instancia no brinque el fence sólo por
 * coincidir unos milisegundos con otra operación legítima.
 */
export async function withConversationalAgentSafetyLock({
  contactId,
  channel,
  waitMs = DEFAULT_SAFETY_LOCK_WAIT_MS,
  pinConnection = false
} = {}, callback) {
  if (typeof callback !== 'function') {
    throw safetyError('El candado preventivo necesita una operación.', 500, 'preventive_measure_lock_callback_required')
  }
  const lockName = getConversationalAgentSafetyLockName({ contactId, channel })
  const maxWaitMs = Math.min(120_000, Math.max(0, Number(waitMs) || 0))
  const deadline = Date.now() + maxWaitMs
  let delayMs = 20

  while (true) {
    let callbackStarted = false
    try {
      return await db.withAdvisoryLock(lockName, async (...args) => {
        callbackStarted = true
        return callback(...args)
      }, { pinConnection: pinConnection === true })
    } catch (error) {
      if (callbackStarted && error && typeof error === 'object') {
        error.conversationalSafetyLockCallbackStarted = true
      }
      // Un servicio interno puede usar otro advisory lock y reportar BUSY. Si
      // el callback ya empezó, jamás reintentamos toda la operación porque
      // podría haber alcanzado un proveedor externo antes del error.
      if (error?.code !== 'DATABASE_ADVISORY_LOCK_BUSY' || callbackStarted) throw error
      if (Date.now() >= deadline) {
        throw safetyError(
          'Otra operación del mismo contacto sigue en proceso; no se pudo confirmar el fence preventivo.',
          503,
          'preventive_measure_lock_timeout'
        )
      }
      await sleep(delayMs)
      delayMs = Math.min(250, Math.ceil(delayMs * 1.7))
    }
  }
}

function utcIso(value = Date.now()) {
  const normalized = normalizeToUtcIso(value instanceof Date ? value : new Date(value), 'UTC')
  if (!normalized || !Number.isFinite(Date.parse(normalized))) {
    throw safetyError('No se pudo determinar el instante UTC de la medida preventiva.', 500, 'preventive_measure_clock_error')
  }
  return normalized
}

function parseDatabaseInstant(value) {
  const text = String(value || '').trim()
  if (!text) return null
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text
  const timestamp = Date.parse(normalized)
  return Number.isFinite(timestamp) ? timestamp : null
}

function normalizePositiveInteger(value, label, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw safetyError(`${label} debe ser un entero entre ${min} y ${max}.`, 400, 'invalid_preventive_measure_policy')
  }
  return numeric
}

/**
 * Esta función sólo acepta la política construida por el servidor. El payload
 * emitido por el modelo nunca debe copiarse a `serverPolicy`.
 */
export function normalizePreventiveMeasurePolicy(serverPolicy) {
  if (!serverPolicy || typeof serverPolicy !== 'object' || Array.isArray(serverPolicy)) {
    throw safetyError('La medida requiere una política preventiva del servidor.', 500, 'preventive_measure_policy_required')
  }

  const policyId = requiredText(serverPolicy.id || serverPolicy.policyId, 'serverPolicy.id', 120)
  const version = requiredText(serverPolicy.version || serverPolicy.policyVersion || '1', 'serverPolicy.version', 40)
  const quarantine = serverPolicy.quarantine && typeof serverPolicy.quarantine === 'object'
    ? serverPolicy.quarantine
    : {}
  const mode = cleanText(quarantine.mode || serverPolicy.quarantineMode, 24).toLowerCase()
  if (!BLOCK_MODES.has(mode)) {
    throw safetyError('La política debe elegir cuarentena temporal o indefinida.', 500, 'invalid_preventive_measure_policy')
  }

  const durationMinutes = mode === 'temporary'
    ? normalizePositiveInteger(
        quarantine.durationMinutes ?? serverPolicy.quarantineMinutes,
        'serverPolicy.quarantine.durationMinutes',
        { max: MAX_QUARANTINE_MINUTES }
      )
    : null

  const notification = serverPolicy.notification && typeof serverPolicy.notification === 'object'
    ? serverPolicy.notification
    : {}
  const notificationEnabled = notification.enabled ?? serverPolicy.notifyAdmin
  if (typeof notificationEnabled !== 'boolean') {
    throw safetyError('La política debe indicar si se notifica a revisión humana.', 500, 'invalid_preventive_measure_policy')
  }
  const audience = cleanText(
    notification.audience || serverPolicy.notificationAudience || 'account_admins',
    40
  ).toLowerCase()
  if (!NOTIFICATION_AUDIENCES.has(audience)) {
    throw safetyError('La audiencia de la notificación preventiva no está permitida.', 500, 'invalid_preventive_measure_policy')
  }
  const notificationUserId = cleanText(notification.userId || notification.user_id, 160)
  if (audience === 'specific_user' && !notificationUserId) {
    throw safetyError('La audiencia específica requiere un usuario.', 500, 'invalid_preventive_measure_policy')
  }

  return {
    id: policyId,
    version,
    quarantine: {
      mode,
      durationMinutes
    },
    notification: {
      enabled: notificationEnabled,
      audience,
      ...(notificationUserId ? { userId: notificationUserId } : {})
    }
  }
}

function publicCase(row) {
  if (!row) return null
  return {
    id: row.id,
    contactId: row.contact_id,
    channel: row.channel,
    status: row.status,
    category: row.category,
    severity: row.severity,
    blockMode: row.block_mode,
    blockedUntil: row.blocked_until || null,
    policy: parseJson(row.policy_json, {}),
    eventCount: Number(row.event_count || 0),
    openedAt: row.opened_at || null,
    latestEventId: row.latest_event_id || null,
    latestAgentId: row.latest_agent_id || null,
    latestSourceMessageId: row.latest_source_message_id || null,
    latestReason: row.latest_reason || null,
    resolvedAt: row.resolved_at || null,
    resolvedBy: row.resolved_by || null,
    resolutionReason: row.resolution_reason || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

function publicEvent(row) {
  if (!row) return null
  return {
    id: row.id,
    caseId: row.case_id,
    agentId: row.agent_id,
    contactId: row.contact_id,
    channel: row.channel,
    sourceMessageId: row.source_message_id,
    category: row.category,
    severity: row.severity,
    reason: row.reason,
    evidence: parseJson(row.evidence_json, {}),
    policy: parseJson(row.policy_json, {}),
    blockMode: row.block_mode,
    blockedUntil: row.blocked_until || null,
    notificationStatus: row.notification_status,
    notificationAttempts: Number(row.notification_attempts || 0),
    notificationNextRetryAt: row.notification_next_retry_at || null,
    notificationLastError: row.notification_last_error || null,
    notificationSentAt: row.notification_sent_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

function caseIsActiveAt(row, nowMs) {
  if (!row || row.status !== 'active') return false
  if (row.block_mode === 'indefinite') return true
  const blockedUntil = parseDatabaseInstant(row.blocked_until)
  return blockedUntil === null || blockedUntil > nowMs
}

function incomingBlockedUntil(policy, nowMs) {
  return policy.quarantine.mode === 'temporary'
    ? utcIso(nowMs + (policy.quarantine.durationMinutes * 60 * 1000))
    : null
}

function calculateEffectiveBlock(current, currentIsActive, policy, requestedBlockedUntil) {
  if (!currentIsActive) {
    return {
      mode: policy.quarantine.mode,
      blockedUntil: requestedBlockedUntil,
      policyJson: safeJson(policy)
    }
  }

  if (current.block_mode === 'indefinite') {
    return {
      mode: 'indefinite',
      blockedUntil: null,
      policyJson: current.policy_json
    }
  }
  if (policy.quarantine.mode === 'indefinite') {
    return {
      mode: 'indefinite',
      blockedUntil: null,
      policyJson: safeJson(policy)
    }
  }

  const currentUntil = parseDatabaseInstant(current.blocked_until) || 0
  const requestedUntil = parseDatabaseInstant(requestedBlockedUntil) || 0
  return requestedUntil >= currentUntil
    ? { mode: 'temporary', blockedUntil: requestedBlockedUntil, policyJson: safeJson(policy) }
    : { mode: 'temporary', blockedUntil: current.blocked_until, policyJson: current.policy_json }
}

async function recordAudit(tx, {
  id = `casafety_audit_${randomUUID()}`,
  caseId,
  eventId = null,
  action,
  actorType,
  actorId = null,
  detail = {}
}) {
  await tx.run(
    `INSERT INTO conversational_agent_safety_audit (
       id, case_id, event_id, action, actor_type, actor_id, detail_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO NOTHING`,
    [id, caseId, eventId, action, actorType, actorId, safeJson(detail)]
  )
}

async function loadCaseForUpdate(tx, caseId) {
  const lockSuffix = process.env.DATABASE_URL ? ' FOR UPDATE' : ''
  return tx.get(`SELECT * FROM conversational_agent_safety_cases WHERE id = ?${lockSuffix}`, [caseId])
}

async function loadCaseByIdentityForUpdate(tx, contactId, channel) {
  const lockSuffix = process.env.DATABASE_URL ? ' FOR UPDATE' : ''
  return tx.get(
    `SELECT * FROM conversational_agent_safety_cases WHERE contact_id = ? AND channel = ?${lockSuffix}`,
    [contactId, channel]
  )
}

async function loadEventBundle(connection, eventId) {
  const eventRow = await connection.get(
    'SELECT * FROM conversational_agent_safety_events WHERE id = ?',
    [eventId]
  )
  if (!eventRow) return null
  const caseRow = await connection.get(
    'SELECT * FROM conversational_agent_safety_cases WHERE id = ?',
    [eventRow.case_id]
  )
  return {
    eventRow,
    caseRow,
    event: publicEvent(eventRow),
    case: publicCase(caseRow),
    policy: parseJson(eventRow.policy_json, {})
  }
}

/**
 * Registra una detección y activa/fortalece la cuarentena global del contacto en
 * ese canal. Nunca modifica ni elimina el contacto y tampoco toca al proveedor.
 */
export async function applyConversationalAgentPreventiveMeasure({
  agentId,
  contactId,
  channel,
  sourceMessageId,
  category,
  severity,
  reason,
  evidence = {},
  serverPolicy,
  now = Date.now()
} = {}) {
  const normalized = {
    agentId: requiredText(agentId, 'agentId', 240),
    contactId: requiredText(contactId, 'contactId', 240),
    channel: normalizeChannel(channel),
    sourceMessageId: requiredText(sourceMessageId, 'sourceMessageId', 320),
    category: normalizeCategory(category),
    severity: normalizeSeverity(severity),
    reason: requiredText(reason, 'reason', 2400),
    evidence: normalizeEvidence(evidence),
    policy: normalizePreventiveMeasurePolicy(serverPolicy)
  }
  const nowMs = Number(now instanceof Date ? now.getTime() : now)
  if (!Number.isFinite(nowMs)) throw safetyError('now no es un instante válido.', 400, 'invalid_preventive_measure_time')
  const nowIso = utcIso(nowMs)
  const requestedBlockedUntil = incomingBlockedUntil(normalized.policy, nowMs)
  const proposedCaseId = `casafety_case_${sha256(`${normalized.contactId}\u0000${normalized.channel}`).slice(0, 48)}`
  const eventId = `casafety_event_${sha256(`${normalized.agentId}\u0000${normalized.contactId}\u0000${normalized.channel}\u0000${normalized.sourceMessageId}`).slice(0, 48)}`
  const requestHash = sha256(JSON.stringify(stableValue({
    category: normalized.category,
    severity: normalized.severity,
    reason: normalized.reason,
    evidence: normalized.evidence,
    policy: normalized.policy
  })))

  return withConversationalAgentSafetyLock({
    contactId: normalized.contactId,
    channel: normalized.channel
  }, () => db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO conversational_agent_safety_cases (
         id, contact_id, channel, status, category, severity, block_mode,
         blocked_until, policy_json, event_count, opened_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'resolved', ?, ?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(contact_id, channel) DO NOTHING`,
      [
        proposedCaseId,
        normalized.contactId,
        normalized.channel,
        normalized.category,
        normalized.severity,
        normalized.policy.quarantine.mode,
        requestedBlockedUntil,
        safeJson(normalized.policy),
        nowIso
      ]
    )

    const current = await loadCaseByIdentityForUpdate(tx, normalized.contactId, normalized.channel)
    if (!current) throw safetyError('No se pudo abrir el caso preventivo durable.', 503, 'preventive_measure_case_unavailable')
    const caseId = current.id

    const currentIsActive = caseIsActiveAt(current, nowMs)
    const effectiveBlock = calculateEffectiveBlock(current, currentIsActive, normalized.policy, requestedBlockedUntil)
    const effectiveSeverity = currentIsActive && current.severity === 'critical'
      ? 'critical'
      : normalized.severity
    const effectiveCategory = currentIsActive && current.severity === 'critical' && normalized.severity !== 'critical'
      ? current.category
      : normalized.category
    const notificationStatus = normalized.policy.notification.enabled ? 'pending' : 'skipped'

    const inserted = await tx.run(
      `INSERT INTO conversational_agent_safety_events (
         id, case_id, agent_id, contact_id, channel, source_message_id,
         request_hash, category, severity, reason, evidence_json, policy_json,
         block_mode, blocked_until, notification_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(agent_id, contact_id, channel, source_message_id) DO NOTHING`,
      [
        eventId,
        caseId,
        normalized.agentId,
        normalized.contactId,
        normalized.channel,
        normalized.sourceMessageId,
        requestHash,
        normalized.category,
        normalized.severity,
        normalized.reason,
        safeJson(normalized.evidence),
        safeJson(normalized.policy),
        normalized.policy.quarantine.mode,
        requestedBlockedUntil,
        notificationStatus
      ]
    )

    if (mutationCount(inserted) !== 1) {
      const existing = await tx.get(
        `SELECT * FROM conversational_agent_safety_events
         WHERE agent_id = ? AND contact_id = ? AND channel = ? AND source_message_id = ?`,
        [normalized.agentId, normalized.contactId, normalized.channel, normalized.sourceMessageId]
      )
      if (!existing) throw safetyError('No se pudo confirmar la idempotencia de la medida.', 503, 'preventive_measure_replay_unavailable')
      if (existing.request_hash !== requestHash) {
        throw safetyError(
          'Ese mensaje ya aplicó una medida preventiva con datos distintos.',
          409,
          'preventive_measure_idempotency_conflict'
        )
      }
      const replayCase = await tx.get(
        'SELECT * FROM conversational_agent_safety_cases WHERE id = ?',
        [existing.case_id]
      )
      return {
        applied: false,
        idempotent: true,
        event: publicEvent(existing),
        case: publicCase(replayCase)
      }
    }

    const caseUpdated = await tx.run(
      `UPDATE conversational_agent_safety_cases
       SET status = 'active',
           category = ?,
           severity = ?,
           block_mode = ?,
           blocked_until = ?,
           policy_json = ?,
           event_count = COALESCE(event_count, 0) + 1,
           opened_at = ?,
           latest_event_id = ?,
           latest_agent_id = ?,
           latest_source_message_id = ?,
           latest_reason = ?,
           resolved_at = NULL,
           resolved_by = NULL,
           resolution_reason = NULL,
           updated_at = ?
       WHERE id = ?`,
      [
        effectiveCategory,
        effectiveSeverity,
        effectiveBlock.mode,
        effectiveBlock.blockedUntil,
        effectiveBlock.policyJson,
        currentIsActive ? current.opened_at : nowIso,
        eventId,
        normalized.agentId,
        normalized.sourceMessageId,
        normalized.reason,
        nowIso,
        caseId
      ]
    )
    if (mutationCount(caseUpdated) !== 1) {
      throw safetyError('El caso preventivo cambió antes de activar la cuarentena.', 409, 'preventive_measure_case_race')
    }

    const action = Number(current.event_count || 0) === 0
      ? 'quarantine_applied'
      : currentIsActive
        ? 'quarantine_reinforced'
        : 'quarantine_reopened'
    await recordAudit(tx, {
      id: `casafety_audit_${sha256(`${eventId}\u0000${action}`).slice(0, 48)}`,
      caseId,
      eventId,
      action,
      actorType: 'conversational_agent',
      actorId: normalized.agentId,
      detail: {
        category: normalized.category,
        severity: normalized.severity,
        effectiveCategory,
        effectiveSeverity,
        effectiveBlockMode: effectiveBlock.mode,
        effectiveBlockedUntil: effectiveBlock.blockedUntil,
        policyId: normalized.policy.id,
        notificationStatus
      }
    })

    const [eventRow, caseRow] = await Promise.all([
      tx.get('SELECT * FROM conversational_agent_safety_events WHERE id = ?', [eventId]),
      tx.get('SELECT * FROM conversational_agent_safety_cases WHERE id = ?', [caseId])
    ])
    return {
      applied: true,
      idempotent: false,
      event: publicEvent(eventRow),
      case: publicCase(caseRow)
    }
  }))
}

export async function getActiveConversationalAgentPreventiveMeasure({
  contactId,
  channel,
  now = Date.now()
} = {}) {
  const cleanContactId = requiredText(contactId, 'contactId', 240)
  const cleanChannel = normalizeChannel(channel)
  const nowMs = Number(now instanceof Date ? now.getTime() : now)
  if (!Number.isFinite(nowMs)) throw safetyError('now no es un instante válido.', 400, 'invalid_preventive_measure_time')

  const row = await db.get(
    `SELECT * FROM conversational_agent_safety_cases
     WHERE contact_id = ? AND channel = ?`,
    [cleanContactId, cleanChannel]
  )
  if (!row || row.status !== 'active') return null
  if (caseIsActiveAt(row, nowMs)) return publicCase(row)

  const nowIso = utcIso(nowMs)
  await db.transaction(async (tx) => {
    const locked = await loadCaseForUpdate(tx, row.id)
    if (!locked || locked.status !== 'active' || caseIsActiveAt(locked, nowMs)) return
    const result = await tx.run(
      `UPDATE conversational_agent_safety_cases
       SET status = 'resolved', resolved_at = ?, resolved_by = 'system:auto_expiry',
           resolution_reason = 'La cuarentena temporal expiró.', updated_at = ?
       WHERE id = ? AND status = 'active'`,
      [nowIso, nowIso, locked.id]
    )
    if (mutationCount(result) !== 1) return
    await recordAudit(tx, {
      caseId: locked.id,
      eventId: locked.latest_event_id,
      action: 'quarantine_expired',
      actorType: 'system',
      actorId: 'auto_expiry',
      detail: { blockedUntil: locked.blocked_until }
    })
  })
  return null
}

export async function resolveConversationalAgentPreventiveMeasure({
  caseId,
  contactId,
  channel,
  resolvedBy,
  reason,
  now = Date.now()
} = {}) {
  const cleanCaseId = cleanText(caseId, 240)
  const cleanContactId = cleanCaseId ? '' : requiredText(contactId, 'contactId', 240)
  const cleanChannel = cleanCaseId ? '' : normalizeChannel(channel)
  const actorId = requiredText(resolvedBy, 'resolvedBy', 240)
  const resolutionReason = requiredText(reason, 'reason', 2400)
  const nowIso = utcIso(now instanceof Date ? now.getTime() : now)

  return db.transaction(async (tx) => {
    const lockSuffix = process.env.DATABASE_URL ? ' FOR UPDATE' : ''
    const row = cleanCaseId
      ? await tx.get(`SELECT * FROM conversational_agent_safety_cases WHERE id = ?${lockSuffix}`, [cleanCaseId])
      : await tx.get(
          `SELECT * FROM conversational_agent_safety_cases WHERE contact_id = ? AND channel = ?${lockSuffix}`,
          [cleanContactId, cleanChannel]
        )
    if (!row) throw safetyError('El caso preventivo no existe.', 404, 'preventive_measure_case_not_found')
    if (row.status === 'resolved') {
      return { resolved: false, idempotent: true, case: publicCase(row) }
    }

    const result = await tx.run(
      `UPDATE conversational_agent_safety_cases
       SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution_reason = ?, updated_at = ?
       WHERE id = ? AND status = 'active'`,
      [nowIso, actorId, resolutionReason, nowIso, row.id]
    )
    if (mutationCount(result) !== 1) {
      throw safetyError('El caso cambió mientras se resolvía. Vuelve a consultar su estado.', 409, 'preventive_measure_resolution_race')
    }
    await recordAudit(tx, {
      caseId: row.id,
      eventId: row.latest_event_id,
      action: 'quarantine_resolved',
      actorType: 'human',
      actorId,
      detail: { reason: resolutionReason }
    })
    const resolved = await tx.get(
      'SELECT * FROM conversational_agent_safety_cases WHERE id = ?',
      [row.id]
    )
    return { resolved: true, idempotent: false, case: publicCase(resolved) }
  })
}

export async function resolveConversationalAgentPreventiveMeasuresForContact({
  contactId,
  resolvedBy,
  reason = 'El usuario reactivó manualmente la atención del agente.'
} = {}) {
  const cleanContactId = requiredText(contactId, 'contactId', 240)
  const actorId = requiredText(resolvedBy, 'resolvedBy', 240)
  const resolutionReason = requiredText(reason, 'reason', 2400)
  const activeCases = await db.all(
    `SELECT id
     FROM conversational_agent_safety_cases
     WHERE contact_id = ? AND status = 'active'
     ORDER BY created_at ASC, id ASC`,
    [cleanContactId]
  )

  const results = []
  for (const row of activeCases) {
    results.push(await resolveConversationalAgentPreventiveMeasure({
      caseId: row.id,
      resolvedBy: actorId,
      reason: resolutionReason
    }))
  }
  return {
    contactId: cleanContactId,
    resolvedCount: results.filter((result) => result.resolved).length,
    results
  }
}

export async function claimConversationalAgentPreventiveNotification({
  eventId,
  leaseMs = DEFAULT_NOTIFICATION_LEASE_MS,
  now = Date.now()
} = {}) {
  const cleanEventId = requiredText(eventId, 'eventId', 240)
  const cleanLeaseMs = normalizePositiveInteger(leaseMs, 'leaseMs', { min: 1000, max: MAX_NOTIFICATION_LEASE_MS })
  const nowMs = Number(now instanceof Date ? now.getTime() : now)
  if (!Number.isFinite(nowMs)) throw safetyError('now no es un instante válido.', 400, 'invalid_preventive_measure_time')
  const nowIso = utcIso(nowMs)
  const leaseUntil = utcIso(nowMs + cleanLeaseMs)
  const claimToken = randomUUID()

  return db.transaction(async (tx) => {
    const claimed = await tx.run(
      `UPDATE conversational_agent_safety_events
       SET notification_status = 'claimed',
           notification_attempts = COALESCE(notification_attempts, 0) + 1,
           notification_claim_token = ?,
           notification_lease_until = ?,
           notification_next_retry_at = NULL,
           notification_last_error = NULL,
           updated_at = ?
       WHERE id = ? AND (
         notification_status = 'pending' OR
         (notification_status = 'failed' AND (notification_next_retry_at IS NULL OR notification_next_retry_at <= ?)) OR
         (notification_status = 'claimed' AND (notification_lease_until IS NULL OR notification_lease_until <= ?))
       )`,
      [claimToken, leaseUntil, nowIso, cleanEventId, nowIso, nowIso]
    )
    const bundle = await loadEventBundle(tx, cleanEventId)
    if (!bundle) throw safetyError('El evento preventivo no existe.', 404, 'preventive_measure_event_not_found')
    if (mutationCount(claimed) !== 1) {
      return {
        claimed: false,
        reason: `notification_${bundle.event.notificationStatus || 'unavailable'}`,
        ...bundle
      }
    }
    await recordAudit(tx, {
      id: `casafety_audit_${sha256(`${cleanEventId}\u0000${claimToken}\u0000claimed`).slice(0, 48)}`,
      caseId: bundle.event.caseId,
      eventId: cleanEventId,
      action: 'notification_claimed',
      actorType: 'system',
      actorId: claimToken,
      detail: { leaseUntil, attempt: bundle.event.notificationAttempts }
    })
    return {
      claimed: true,
      claimToken,
      leaseUntil,
      dedupeKey: cleanEventId,
      ...bundle
    }
  })
}

export async function markConversationalAgentPreventiveNotificationSent({
  eventId,
  claimToken,
  receipt = {},
  now = Date.now()
} = {}) {
  const cleanEventId = requiredText(eventId, 'eventId', 240)
  const cleanClaimToken = requiredText(claimToken, 'claimToken', 240)
  const nowIso = utcIso(now instanceof Date ? now.getTime() : now)

  return db.transaction(async (tx) => {
    const result = await tx.run(
      `UPDATE conversational_agent_safety_events
       SET notification_status = 'sent',
           notification_claim_token = NULL,
           notification_lease_until = NULL,
           notification_next_retry_at = NULL,
           notification_last_error = NULL,
           notification_receipt_json = ?,
           notification_sent_at = ?,
           updated_at = ?
       WHERE id = ? AND notification_status = 'claimed' AND notification_claim_token = ?`,
      [safeJson(receipt), nowIso, nowIso, cleanEventId, cleanClaimToken]
    )
    if (mutationCount(result) !== 1) {
      throw safetyError('La notificación ya no pertenece a este worker.', 409, 'preventive_measure_notification_claim_lost')
    }
    const bundle = await loadEventBundle(tx, cleanEventId)
    await recordAudit(tx, {
      id: `casafety_audit_${sha256(`${cleanEventId}\u0000${cleanClaimToken}\u0000sent`).slice(0, 48)}`,
      caseId: bundle.event.caseId,
      eventId: cleanEventId,
      action: 'notification_sent',
      actorType: 'system',
      actorId: cleanClaimToken,
      detail: { receipt: sanitizeValue(receipt) }
    })
    return { sent: true, ...bundle }
  })
}

export async function markConversationalAgentPreventiveNotificationFailed({
  eventId,
  claimToken,
  error,
  retryAfterMs,
  now = Date.now()
} = {}) {
  const cleanEventId = requiredText(eventId, 'eventId', 240)
  const cleanClaimToken = requiredText(claimToken, 'claimToken', 240)
  const errorMessage = requiredText(error?.message || error, 'error', 2400)
  const nowMs = Number(now instanceof Date ? now.getTime() : now)
  if (!Number.isFinite(nowMs)) throw safetyError('now no es un instante válido.', 400, 'invalid_preventive_measure_time')

  return db.transaction(async (tx) => {
    const current = await tx.get(
      `SELECT * FROM conversational_agent_safety_events
       WHERE id = ? AND notification_status = 'claimed' AND notification_claim_token = ?`,
      [cleanEventId, cleanClaimToken]
    )
    if (!current) {
      throw safetyError('La notificación ya no pertenece a este worker.', 409, 'preventive_measure_notification_claim_lost')
    }
    const fallbackDelay = Math.min(30_000 * (2 ** Math.max(0, Number(current.notification_attempts || 1) - 1)), MAX_RETRY_DELAY_MS)
    const delayMs = retryAfterMs === undefined
      ? fallbackDelay
      : normalizePositiveInteger(retryAfterMs, 'retryAfterMs', { min: 1000, max: MAX_RETRY_DELAY_MS })
    const nextRetryAt = utcIso(nowMs + delayMs)
    const nowIso = utcIso(nowMs)
    const result = await tx.run(
      `UPDATE conversational_agent_safety_events
       SET notification_status = 'failed',
           notification_claim_token = NULL,
           notification_lease_until = NULL,
           notification_next_retry_at = ?,
           notification_last_error = ?,
           updated_at = ?
       WHERE id = ? AND notification_status = 'claimed' AND notification_claim_token = ?`,
      [nextRetryAt, errorMessage, nowIso, cleanEventId, cleanClaimToken]
    )
    if (mutationCount(result) !== 1) {
      throw safetyError('La notificación ya no pertenece a este worker.', 409, 'preventive_measure_notification_claim_lost')
    }
    const bundle = await loadEventBundle(tx, cleanEventId)
    await recordAudit(tx, {
      id: `casafety_audit_${sha256(`${cleanEventId}\u0000${cleanClaimToken}\u0000failed`).slice(0, 48)}`,
      caseId: bundle.event.caseId,
      eventId: cleanEventId,
      action: 'notification_failed',
      actorType: 'system',
      actorId: cleanClaimToken,
      detail: { error: errorMessage, nextRetryAt }
    })
    return { failed: true, nextRetryAt, ...bundle }
  })
}

export async function dispatchConversationalAgentPreventiveNotification({
  eventId,
  notify,
  leaseMs,
  retryAfterMs,
  now = Date.now()
} = {}) {
  if (typeof notify !== 'function') {
    throw safetyError('notify debe ser una función del servidor.', 500, 'preventive_measure_notifier_required')
  }
  const claim = await claimConversationalAgentPreventiveNotification({ eventId, leaseMs, now })
  if (!claim.claimed) return { dispatched: false, sent: false, ...claim }

  try {
    const receipt = await notify({
      event: claim.event,
      case: claim.case,
      policy: claim.policy,
      dedupeKey: claim.dedupeKey
    })
    const sent = await markConversationalAgentPreventiveNotificationSent({
      eventId: claim.event.id,
      claimToken: claim.claimToken,
      receipt,
      now
    })
    return { dispatched: true, sent: true, ...sent }
  } catch (error) {
    const failed = await markConversationalAgentPreventiveNotificationFailed({
      eventId: claim.event.id,
      claimToken: claim.claimToken,
      error,
      retryAfterMs,
      now
    })
    return {
      dispatched: true,
      sent: false,
      error: cleanText(error?.message || error, 2400),
      ...failed
    }
  }
}

export async function retryConversationalAgentPreventiveNotifications({
  notify,
  limit = 20,
  leaseMs,
  retryAfterMs,
  now = Date.now()
} = {}) {
  if (typeof notify !== 'function') {
    throw safetyError('notify debe ser una función del servidor.', 500, 'preventive_measure_notifier_required')
  }
  const cleanLimit = normalizePositiveInteger(limit, 'limit', { min: 1, max: 100 })
  const nowIso = utcIso(now instanceof Date ? now.getTime() : now)
  const rows = await db.all(
    `SELECT id FROM conversational_agent_safety_events
     WHERE notification_status = 'pending'
        OR (notification_status = 'failed' AND (notification_next_retry_at IS NULL OR notification_next_retry_at <= ?))
        OR (notification_status = 'claimed' AND (notification_lease_until IS NULL OR notification_lease_until <= ?))
     ORDER BY created_at ASC, id ASC
     LIMIT ?`,
    [nowIso, nowIso, cleanLimit]
  )
  const results = []
  for (const row of rows) {
    results.push(await dispatchConversationalAgentPreventiveNotification({
      eventId: row.id,
      notify,
      leaseMs,
      retryAfterMs,
      now
    }))
  }
  return {
    attempted: results.length,
    sent: results.filter((result) => result.sent === true).length,
    failed: results.filter((result) => result.dispatched === true && result.sent === false).length,
    results
  }
}
