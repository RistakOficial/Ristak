import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'

let sqliteInboundClaimQueue = Promise.resolve()

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

async function incrementInboundChatUnread(adapter, cleanContactId, occurredAt) {
  return adapter.run(`
    INSERT INTO chat_read_states (
      user_id, contact_id, unread_count, last_read_at, last_unread_at, created_at, updated_at
    )
    SELECT CAST(id AS TEXT), ?, 1, NULL, ?, ?, ?
    FROM users
    WHERE COALESCE(is_active, 1) = 1
    ON CONFLICT(user_id, contact_id) DO UPDATE SET
      unread_count = COALESCE(chat_read_states.unread_count, 0) + 1,
      last_unread_at = CASE
        WHEN chat_read_states.last_unread_at IS NULL
          OR chat_read_states.last_unread_at < excluded.last_unread_at
          THEN excluded.last_unread_at
        ELSE chat_read_states.last_unread_at
      END,
      updated_at = excluded.updated_at
    WHERE chat_read_states.last_read_at IS NULL
      OR chat_read_states.last_read_at < excluded.last_unread_at
  `, [cleanContactId, occurredAt, occurredAt, occurredAt])
}

function runInboundClaimTransaction(callback) {
  if (process.env.DATABASE_URL) return db.transaction(callback)

  // SQLite usa conexiones dedicadas para transacciones. Serializar este tramo
  // corto evita SQLITE_BUSY cuando llegan varias copias del mismo webhook en
  // paralelo, sin convertir las lecturas normales en un cuello de botella.
  const current = sqliteInboundClaimQueue.then(
    () => db.transaction(callback),
    () => db.transaction(callback)
  )
  sqliteInboundClaimQueue = current.catch(() => undefined)
  return current
}

export async function recordInboundChatUnread({ contactId, messageTimestamp } = {}) {
  const cleanContactId = normalizeContactId(contactId)
  if (!cleanContactId) return { updated: 0 }

  const occurredAt = normalizeIsoDate(messageTimestamp)
  const result = await incrementInboundChatUnread(db, cleanContactId, occurredAt)

  return {
    updated: Math.max(0, Number(result?.changes || 0)),
    contactId: cleanContactId,
    occurredAt
  }
}

/**
 * Reclama una entrega inbound por canal+mensaje y, para mensajes vivos, suma
 * unread en la misma transacción. Así dos webhooks concurrentes no pueden
 * incrementar ni publicar dos veces el mismo mensaje. Los imports históricos
 * crean el claim durable sin convertir historial viejo en no leído.
 */
export async function claimInboundChatMessage({
  channel,
  messageId,
  contactId,
  messageTimestamp,
  incrementUnread = true
} = {}) {
  const cleanChannel = cleanString(channel).toLowerCase()
  const cleanMessageId = cleanString(messageId)
  const cleanContactId = normalizeContactId(contactId)
  if (!cleanChannel || !cleanMessageId || !cleanContactId) {
    return { claimed: false, updated: 0 }
  }

  const occurredAt = normalizeIsoDate(messageTimestamp)
  const executeClaim = async (adapter) => {
    const claim = await adapter.run(`
      INSERT INTO chat_inbound_message_claims (
        channel, message_id, contact_id, message_timestamp, claimed_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel, message_id) DO NOTHING
    `, [cleanChannel, cleanMessageId, cleanContactId, occurredAt, new Date().toISOString()])

    if (Math.max(0, Number(claim?.changes || 0)) === 0) {
      return {
        claimed: false,
        updated: 0,
        channel: cleanChannel,
        messageId: cleanMessageId,
        contactId: cleanContactId,
        occurredAt
      }
    }

    const unread = incrementUnread
      ? await incrementInboundChatUnread(adapter, cleanContactId, occurredAt)
      : { changes: 0 }

    return {
      claimed: true,
      updated: Math.max(0, Number(unread?.changes || 0)),
      channel: cleanChannel,
      messageId: cleanMessageId,
      contactId: cleanContactId,
      occurredAt
    }
  }

  // Un import histórico sólo necesita reservar la llave: un INSERT atómico es
  // suficiente y evita abrir miles de transacciones durante un backfill.
  if (!incrementUnread) return executeClaim(db)
  return runInboundClaimTransaction(executeClaim)
}
