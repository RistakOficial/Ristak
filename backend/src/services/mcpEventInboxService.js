import crypto from 'node:crypto'
import { db } from '../config/database.js'
import { hasModuleFeature, isLicenseEnforced } from './licenseService.js'
import { hasUserAccess } from '../utils/userAccess.js'
import { logger } from '../utils/logger.js'

const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const MAX_EVENT_PAYLOAD_BYTES = 16 * 1024
const SECRET_KEY_PATTERN = /(token|secret|password|authorization|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|database[_-]?url|encrypted|hash|cookie|base64)/i
const EVENT_DOMAIN_MODULES = Object.freeze({
  chat: 'chat',
  payments: 'payments'
})

function clean(value, maxLength = 240) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function sanitizePayload(value, key = '', depth = 0) {
  if (SECRET_KEY_PATTERN.test(key)) return '[redacted]'
  if (depth > 8) return '[truncated]'
  if (typeof value === 'string') return clean(value, 1000)
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizePayload(item, '', depth + 1))
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([entryKey, entryValue]) => [
    entryKey,
    sanitizePayload(entryValue, entryKey, depth + 1)
  ]))
}

function serializePayload(payload) {
  const serialized = JSON.stringify(sanitizePayload(payload))
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_EVENT_PAYLOAD_BYTES) return serialized
  return JSON.stringify({ truncated: true, reason: 'payload_too_large' })
}

function parsePayload(value) {
  try {
    return JSON.parse(value || '{}')
  } catch {
    return { unavailable: true }
  }
}

function encodeCursor(row) {
  if (!row) return null
  return Buffer.from(JSON.stringify({
    occurredAt: row.occurred_at,
    eventId: row.event_id
  })).toString('base64url')
}

function decodeCursor(value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'))
    const occurredAt = clean(parsed?.occurredAt, 80)
    const eventId = clean(parsed?.eventId, 120)
    if (!occurredAt || !eventId || !Number.isFinite(new Date(occurredAt).getTime())) throw new Error('invalid')
    return { occurredAt, eventId }
  } catch {
    const error = new Error('El cursor de eventos no es válido.')
    error.code = 'invalid_event_cursor'
    error.status = 400
    throw error
  }
}

function actor(context = {}) {
  const userId = context.user?.id || context.user?.userId || context.mcpUser?.id
  const grantId = context.mcpUser?.grantId || context.grant?.id || context.grant?.grantId
  if (!userId || !grantId) {
    const error = new Error('La conexión MCP no tiene un grant identificable.')
    error.code = 'mcp_actor_missing'
    error.status = 401
    throw error
  }
  return { userId: String(userId), grantId: clean(grantId, 300) }
}

async function allowedDomains(context, requestedDomain = '') {
  const licenseOptions = {
    state: context.license || null,
    email: context.user?.email || context.user?.username || null
  }
  const entries = Object.entries(EVENT_DOMAIN_MODULES)
  const allowed = []
  for (const [domain, module] of entries) {
    if (requestedDomain && requestedDomain !== domain) continue
    if (!hasUserAccess(context.user || {}, module, 'read')) continue
    if (isLicenseEnforced() && !(await hasModuleFeature(module, licenseOptions))) continue
    allowed.push(domain)
  }
  return allowed
}

export async function recordMcpBusinessEvent({ domain, type, entityId = null, payload = {}, occurredAt = null } = {}) {
  const cleanDomain = clean(domain, 80)
  const eventType = clean(type, 120)
  if (!EVENT_DOMAIN_MODULES[cleanDomain] || !eventType) return { recorded: false, reason: 'unsupported_event' }

  const eventId = crypto.randomUUID()
  const instant = occurredAt && Number.isFinite(new Date(occurredAt).getTime())
    ? new Date(occurredAt).toISOString()
    : new Date().toISOString()
  const expiresAt = new Date(new Date(instant).getTime() + EVENT_RETENTION_MS).toISOString()
  await db.run(
    `INSERT INTO mcp_business_events (
       event_id, domain, event_type, entity_id, payload_json, occurred_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [eventId, cleanDomain, eventType, clean(entityId, 240) || null, serializePayload(payload), instant, expiresAt]
  )
  return { recorded: true, eventId }
}

export function recordMcpBusinessEventBestEffort(event) {
  recordMcpBusinessEvent(event).catch(error => {
    const missingTableDuringRollout = error?.code === '42P01'
      || /no such table:?\s*mcp_business_events/i.test(String(error?.message || ''))
    if (missingTableDuringRollout) return
    logger.warn(`[MCP events] No se pudo guardar ${clean(event?.type, 120) || 'evento'}: ${error.message}`)
  })
}

export async function listMcpBusinessEvents(context, args = {}) {
  const { userId, grantId } = actor(context)
  const grant = await db.get(
    `SELECT grant_id, created_at FROM oauth_grants
     WHERE grant_id = ? AND user_id = ? AND revoked_at IS NULL`,
    [grantId, userId]
  )
  if (!grant) {
    const error = new Error('La conexión MCP ya no está activa.')
    error.code = 'oauth_grant_inactive'
    error.status = 401
    throw error
  }

  const domains = await allowedDomains(context, clean(args.domain, 80))
  if (!domains.length) return { success: true, events: [], nextCursor: null, hasMore: false }

  const cursor = decodeCursor(args.afterCursor)
  const limit = Math.max(1, Math.min(Number(args.limit) || 50, 100))
  const params = [grantId, grant.created_at, ...domains]
  const conditions = [
    'ack.event_id IS NULL',
    'events.occurred_at >= ?',
    `events.domain IN (${domains.map(() => '?').join(', ')})`,
    'events.expires_at > CURRENT_TIMESTAMP'
  ]
  if (args.eventType) {
    conditions.push('events.event_type = ?')
    params.push(clean(args.eventType, 120))
  }
  if (cursor) {
    conditions.push('(events.occurred_at > ? OR (events.occurred_at = ? AND events.event_id > ?))')
    params.push(cursor.occurredAt, cursor.occurredAt, cursor.eventId)
  }
  params.push(limit + 1)

  const rows = await db.all(
    `SELECT events.event_id, events.domain, events.event_type, events.entity_id,
            events.payload_json, events.occurred_at
     FROM mcp_business_events events
     LEFT JOIN mcp_event_acknowledgements ack
       ON ack.event_id = events.event_id AND ack.oauth_grant_id = ?
     WHERE ${conditions.join(' AND ')}
     ORDER BY events.occurred_at ASC, events.event_id ASC
     LIMIT ?`,
    params
  )
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  return {
    success: true,
    events: page.map(row => ({
      eventId: row.event_id,
      domain: row.domain,
      eventType: row.event_type,
      entityId: row.entity_id || null,
      payload: parsePayload(row.payload_json),
      occurredAt: row.occurred_at
    })),
    nextCursor: hasMore ? encodeCursor(page.at(-1)) : null,
    hasMore
  }
}

export async function acknowledgeMcpBusinessEvents(context, eventIds = []) {
  const { userId, grantId } = actor(context)
  const uniqueIds = [...new Set((eventIds || []).map(value => clean(value, 120)).filter(Boolean))]
  const domains = await allowedDomains(context)
  if (!uniqueIds.length || !domains.length) return { success: true, acknowledged: 0 }

  const acknowledged = await db.transaction(async transaction => {
    const grant = await transaction.get(
      `SELECT grant_id, created_at FROM oauth_grants
       WHERE grant_id = ? AND user_id = ? AND revoked_at IS NULL`,
      [grantId, userId]
    )
    if (!grant) {
      const error = new Error('La conexión MCP ya no está activa.')
      error.code = 'oauth_grant_inactive'
      error.status = 401
      throw error
    }

    let count = 0
    for (const eventId of uniqueIds) {
      const visible = await transaction.get(
        `SELECT event_id FROM mcp_business_events
         WHERE event_id = ? AND occurred_at >= ? AND expires_at > CURRENT_TIMESTAMP
           AND domain IN (${domains.map(() => '?').join(', ')})`,
        [eventId, grant.created_at, ...domains]
      )
      if (!visible) continue
      const result = await transaction.run(
        `INSERT INTO mcp_event_acknowledgements (oauth_grant_id, event_id)
         VALUES (?, ?) ON CONFLICT(oauth_grant_id, event_id) DO NOTHING`,
        [grantId, eventId]
      )
      count += Number(result?.changes ?? result?.rowCount) || 0
    }
    return count
  })
  return { success: true, acknowledged, requested: uniqueIds.length }
}

export const __mcpEventInboxTestHooks = {
  decodeCursor,
  encodeCursor,
  sanitizePayload,
  serializePayload
}
