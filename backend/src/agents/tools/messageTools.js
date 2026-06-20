import { tool } from '@openai/agents'
import { z } from 'zod'
import { db } from '../../config/database.js'

const INBOX_CHANNELS = new Set(['all', 'whatsapp', 'facebook', 'instagram', 'email'])
const MESSAGE_DIRECTIONS = new Set(['all', 'inbound', 'outbound'])

function cleanText(value) {
  return String(value || '').trim()
}

function normalizeInboxChannel(value) {
  const channel = cleanText(value || 'all').toLowerCase()
  return INBOX_CHANNELS.has(channel) ? channel : 'all'
}

function normalizeMessageDirection(value) {
  const direction = cleanText(value || 'inbound').toLowerCase()
  return MESSAGE_DIRECTIONS.has(direction) ? direction : 'inbound'
}

function clampLimit(value, fallback = 20) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(1, Math.min(100, Math.trunc(number)))
}

function addDirectionFilter(conditions, alias, defaultDirection, direction) {
  if (direction === 'all') return
  conditions.push(`LOWER(COALESCE(${alias}.direction, '${defaultDirection}')) = ?`)
}

function addCommonFilters(conditions, params, { alias, defaultDirection, direction, contactId, since }) {
  addDirectionFilter(conditions, alias, defaultDirection, direction)
  if (direction !== 'all') params.push(direction)
  if (contactId) {
    conditions.push(`${alias}.contact_id = ?`)
    params.push(contactId)
  }
  if (since) {
    conditions.push(`COALESCE(${alias}.message_timestamp, ${alias}.created_at) >= ?`)
    params.push(since)
  }
}

function mapInboxMessage(row) {
  return {
    id: row.id,
    channel: row.channel,
    direction: row.direction || '',
    contactId: row.contact_id || null,
    contactName: row.contact_name || row.peer_name || row.address || 'Sin contacto',
    peerName: row.peer_name || null,
    address: row.address || null,
    text: row.message_text || '',
    subject: row.subject || null,
    messageType: row.message_type || null,
    status: row.status || null,
    messageAt: row.message_at || null
  }
}

export async function listInboxMessages({ channel = 'all', direction = 'inbound', contactId = null, since = null, query = null, limit = 20, unreadOnly = false } = {}) {
  const safeChannel = normalizeInboxChannel(channel)
  const safeDirection = normalizeMessageDirection(unreadOnly ? 'inbound' : direction)
  const safeLimit = clampLimit(limit)
  const cleanContactId = cleanText(contactId)
  const cleanSince = cleanText(since)
  const cleanQuery = cleanText(query).toLowerCase()

  const unions = []
  const params = []

  if (safeChannel === 'all' || safeChannel === 'whatsapp') {
    const conditions = ['1 = 1']
    const localParams = []
    addCommonFilters(conditions, localParams, {
      alias: 'msg',
      defaultDirection: 'inbound',
      direction: safeDirection,
      contactId: cleanContactId,
      since: cleanSince
    })
    unions.push(`
      SELECT
        'whatsapp' AS channel,
        msg.id,
        msg.contact_id,
        c.full_name AS contact_name,
        wac.profile_name AS peer_name,
        COALESCE(NULLIF(msg.phone, ''), NULLIF(msg.from_phone, ''), NULLIF(msg.to_phone, '')) AS address,
        LOWER(COALESCE(msg.direction, 'inbound')) AS direction,
        msg.message_text,
        msg.message_type,
        msg.status,
        NULL AS subject,
        COALESCE(msg.message_timestamp, msg.created_at) AS message_at
      FROM whatsapp_api_messages msg
      LEFT JOIN contacts c ON c.id = msg.contact_id
      LEFT JOIN whatsapp_api_contacts wac ON wac.id = msg.whatsapp_api_contact_id
      WHERE ${conditions.join(' AND ')}
    `)
    params.push(...localParams)
  }

  if (safeChannel === 'all' || safeChannel === 'facebook' || safeChannel === 'instagram') {
    const conditions = ['1 = 1']
    const localParams = []
    addCommonFilters(conditions, localParams, {
      alias: 'msg',
      defaultDirection: 'inbound',
      direction: safeDirection,
      contactId: cleanContactId,
      since: cleanSince
    })
    if (safeChannel === 'facebook' || safeChannel === 'instagram') {
      conditions.push('LOWER(msg.platform) = ?')
      localParams.push(safeChannel)
    }
    unions.push(`
      SELECT
        LOWER(COALESCE(msg.platform, 'meta')) AS channel,
        msg.id,
        msg.contact_id,
        c.full_name AS contact_name,
        COALESCE(msc.profile_name, msc.username) AS peer_name,
        COALESCE(msc.username, msg.sender_id) AS address,
        LOWER(COALESCE(msg.direction, 'inbound')) AS direction,
        msg.message_text,
        msg.message_type,
        msg.status,
        NULL AS subject,
        COALESCE(msg.message_timestamp, msg.created_at) AS message_at
      FROM meta_social_messages msg
      LEFT JOIN contacts c ON c.id = msg.contact_id
      LEFT JOIN meta_social_contacts msc ON msc.id = msg.meta_social_contact_id
      WHERE ${conditions.join(' AND ')}
    `)
    params.push(...localParams)
  }

  if (safeChannel === 'all' || safeChannel === 'email') {
    const conditions = ['1 = 1']
    const localParams = []
    addCommonFilters(conditions, localParams, {
      alias: 'msg',
      defaultDirection: 'outbound',
      direction: safeDirection,
      contactId: cleanContactId,
      since: cleanSince
    })
    unions.push(`
      SELECT
        'email' AS channel,
        msg.id,
        msg.contact_id,
        c.full_name AS contact_name,
        NULL AS peer_name,
        CASE
          WHEN LOWER(COALESCE(msg.direction, 'outbound')) = 'inbound' THEN msg.from_email
          ELSE msg.to_email
        END AS address,
        LOWER(COALESCE(msg.direction, 'outbound')) AS direction,
        msg.message_text,
        'email' AS message_type,
        msg.status,
        msg.subject,
        COALESCE(msg.message_timestamp, msg.created_at) AS message_at
      FROM email_messages msg
      LEFT JOIN contacts c ON c.id = msg.contact_id
      WHERE ${conditions.join(' AND ')}
    `)
    params.push(...localParams)
  }

  if (!unions.length) {
    return { ok: true, total: 0, messages: [], unreadSupported: false }
  }

  const outerConditions = []
  if (cleanQuery) {
    outerConditions.push(`(
      LOWER(COALESCE(contact_name, '')) LIKE ?
      OR LOWER(COALESCE(peer_name, '')) LIKE ?
      OR LOWER(COALESCE(address, '')) LIKE ?
      OR LOWER(COALESCE(message_text, '')) LIKE ?
      OR LOWER(COALESCE(subject, '')) LIKE ?
    )`)
    const like = `%${cleanQuery}%`
    params.push(like, like, like, like, like)
  }

  const sql = `
    SELECT *
    FROM (${unions.join('\nUNION ALL\n')}) inbox
    ${outerConditions.length ? `WHERE ${outerConditions.join(' AND ')}` : ''}
    ORDER BY message_at DESC, id DESC
    LIMIT ?
  `
  params.push(safeLimit)

  const rows = await db.all(sql, params)
  return {
    ok: true,
    channel: safeChannel,
    direction: safeDirection,
    total: rows.length,
    unreadSupported: false,
    note: unreadOnly ? 'Ristak no guarda una marca universal de leído/no leído en backend; se listan mensajes entrantes recientes como aproximación operativa.' : undefined,
    messages: rows.map(mapInboxMessage)
  }
}

export const listInboxMessagesTool = tool({
  name: 'list_inbox_messages',
  description: 'Lista la bandeja de mensajes multicanal (WhatsApp, Instagram/Facebook y email). Úsala para saber quién escribió, cuál fue el último mensaje o revisar mensajes entrantes recientes. No inventes "no leídos": el backend no tiene una marca universal de leído/no leído, así que unreadOnly devuelve entrantes recientes.',
  parameters: z.object({
    channel: z.enum(['all', 'whatsapp', 'facebook', 'instagram', 'email']).nullable().describe('Canal a consultar; default all'),
    direction: z.enum(['all', 'inbound', 'outbound']).nullable().describe('Dirección; default inbound para mensajes recibidos'),
    contactId: z.string().nullable().describe('Filtrar por contacto si ya tienes el contactId'),
    since: z.string().nullable().describe('Filtrar desde esta fecha/hora ISO o YYYY-MM-DD'),
    query: z.string().nullable().describe('Buscar por contacto, teléfono/correo, usuario, asunto o texto del mensaje'),
    unreadOnly: z.boolean().nullable().describe('true si el usuario pide no leídos; devuelve entrantes recientes y avisa que no hay marca universal de leído en backend'),
    limit: z.number().int().min(1).max(100).nullable().describe('Máximo de mensajes (default 20)')
  }),
  execute: async ({ channel, direction, contactId, since, query, unreadOnly, limit }) => listInboxMessages({
    channel: channel || 'all',
    direction: direction || 'inbound',
    contactId,
    since,
    query,
    unreadOnly: Boolean(unreadOnly),
    limit
  })
})

export const messageInboxTools = [listInboxMessagesTool]
