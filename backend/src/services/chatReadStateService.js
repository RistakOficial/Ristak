import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'

function cleanString(value) {
  return String(value || '').trim()
}

function normalizeUserId(value) {
  const clean = cleanString(value)
  return clean || null
}

function normalizeContactId(value) {
  const clean = cleanString(value)
  return clean || null
}

function normalizeIsoDate(value, fallback = new Date().toISOString()) {
  const timestamp = Date.parse(String(value || ''))
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback
}

function getDateMs(value) {
  const timestamp = Date.parse(String(value || ''))
  return Number.isFinite(timestamp) ? timestamp : 0
}

function maxIsoDate(...values) {
  const max = values.reduce((current, value) => Math.max(current, getDateMs(value)), 0)
  return max > 0 ? new Date(max).toISOString() : null
}

function buildInClause(values = []) {
  return values.map(() => '?').join(', ')
}

export async function getChatUnreadCountsForUser({ userId, contactIds = [] } = {}) {
  const cleanUserId = normalizeUserId(userId)
  const cleanContactIds = [...new Set(contactIds.map(normalizeContactId).filter(Boolean))]
  if (!cleanUserId || cleanContactIds.length === 0) return new Map()

  const rows = await db.all(`
    SELECT contact_id, unread_count
    FROM chat_read_states
    WHERE user_id = ?
      AND contact_id IN (${buildInClause(cleanContactIds)})
  `, [cleanUserId, ...cleanContactIds]).catch((error) => {
    logger.warn(`[Chat Read State] No se pudieron leer no leídos: ${error.message}`)
    return []
  })

  return new Map(rows.map((row) => [
    String(row.contact_id),
    Math.max(0, Number(row.unread_count || 0))
  ]))
}

export async function markChatContactsReadForUser({ userId, contactIds = [], readAt = new Date().toISOString() } = {}) {
  const cleanUserId = normalizeUserId(userId)
  const cleanContactIds = [...new Set(contactIds.map(normalizeContactId).filter(Boolean))]
  if (!cleanUserId || cleanContactIds.length === 0) {
    return { updated: 0, contactIds: [] }
  }

  const normalizedReadAt = normalizeIsoDate(readAt)
  let updated = 0

  for (const contactId of cleanContactIds) {
    await db.run(`
      INSERT INTO chat_read_states (
        user_id, contact_id, unread_count, last_read_at, last_unread_at, created_at, updated_at
      ) VALUES (?, ?, 0, ?, NULL, ?, ?)
      ON CONFLICT(user_id, contact_id) DO UPDATE SET
        unread_count = 0,
        last_read_at = excluded.last_read_at,
        updated_at = excluded.updated_at
    `, [
      cleanUserId,
      contactId,
      normalizedReadAt,
      normalizedReadAt,
      normalizedReadAt
    ])
    updated += 1
  }

  return { updated, contactIds: cleanContactIds, lastReadAt: normalizedReadAt }
}

export async function markChatContactReadForUser({ userId, contactId, readAt } = {}) {
  const result = await markChatContactsReadForUser({
    userId,
    contactIds: [contactId],
    readAt
  })
  return {
    contactId: result.contactIds[0] || normalizeContactId(contactId),
    unreadCount: 0,
    lastReadAt: result.lastReadAt || null
  }
}

async function getActiveChatReaderUserIds() {
  const rows = await db.all(`
    SELECT id
    FROM users
    WHERE COALESCE(is_active, 1) = 1
  `).catch((error) => {
    logger.warn(`[Chat Read State] No se pudieron listar usuarios para unread: ${error.message}`)
    return []
  })
  return rows.map((row) => normalizeUserId(row.id)).filter(Boolean)
}

export async function recordInboundChatUnread({ contactId, messageTimestamp } = {}) {
  const cleanContactId = normalizeContactId(contactId)
  if (!cleanContactId) return { updated: 0 }

  const occurredAt = normalizeIsoDate(messageTimestamp)
  const userIds = await getActiveChatReaderUserIds()
  if (!userIds.length) return { updated: 0 }

  let updated = 0
  for (const userId of userIds) {
    const existing = await db.get(`
      SELECT unread_count, last_read_at, last_unread_at
      FROM chat_read_states
      WHERE user_id = ? AND contact_id = ?
    `, [userId, cleanContactId]).catch(() => null)

    if (existing?.last_read_at && getDateMs(existing.last_read_at) >= getDateMs(occurredAt)) {
      continue
    }

    if (existing) {
      const unreadCount = Math.max(0, Number(existing.unread_count || 0)) + 1
      const lastUnreadAt = maxIsoDate(existing.last_unread_at, occurredAt) || occurredAt
      await db.run(`
        UPDATE chat_read_states
        SET unread_count = ?,
            last_unread_at = ?,
            updated_at = ?
        WHERE user_id = ? AND contact_id = ?
      `, [unreadCount, lastUnreadAt, occurredAt, userId, cleanContactId])
    } else {
      await db.run(`
        INSERT INTO chat_read_states (
          user_id, contact_id, unread_count, last_read_at, last_unread_at, created_at, updated_at
        ) VALUES (?, ?, 1, NULL, ?, ?, ?)
      `, [userId, cleanContactId, occurredAt, occurredAt, occurredAt])
    }
    updated += 1
  }

  return { updated, contactId: cleanContactId, occurredAt }
}
