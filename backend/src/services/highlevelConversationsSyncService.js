/**
 * SINCRONIZACIÓN DE CONVERSACIONES (CHATS) DESDE HIGHLEVEL
 *
 * Importa el historial de mensajes de HighLevel (WhatsApp, SMS, Messenger,
 * Instagram) hacia las tablas locales que alimentan el chat de la app móvil
 * y del escritorio:
 * - whatsapp_api_messages  (WhatsApp y SMS enviados/recibidos vía GHL)
 * - meta_social_messages   (Messenger e Instagram vía GHL)
 *
 * Usa GET /conversations/messages/export con paginación por cursor.
 * Los IDs locales se generan igual que los espejos de envío
 * (hashId('ghl_msg', `${remoteId}:0`)) para no duplicar mensajes que
 * Ristak ya guardó al enviarlos.
 */

import crypto from 'crypto'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { logger } from '../utils/logger.js'
import GHLClient from './ghlClient.js'
import { sendChatMessageNotification } from './pushNotificationsService.js'

const LAST_SYNC_CONFIG_KEY = 'highlevel_conversations_last_synced_at'
const INCREMENTAL_OVERLAP_MS = 24 * 60 * 60 * 1000 // re-leer 24h hacia atrás por seguridad
const EXPORT_PAGE_LIMIT = 100
const MAX_EXPORT_PAGES = 1000

let syncRunning = false

function cleanString(value) {
  return String(value || '').trim()
}

function hashId(prefix, value) {
  return `${prefix}_${crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 32)}`
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return 'null'
  }
}

function parseTimestampToIso(value) {
  if (value === null || value === undefined || value === '') return null
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizeMessageStatus(value = '') {
  const status = cleanString(value).toLowerCase().replace(/[\s-]+/g, '_')
  if (!status) return ''
  if (['read', 'seen', 'opened', 'played'].includes(status)) return 'read'
  if (['delivered', 'delivery_ack'].includes(status)) return 'delivered'
  if (['sent', 'accepted', 'complete', 'completed', 'success', 'succeeded'].includes(status)) return 'sent'
  if (['queued', 'pending', 'processing', 'scheduled'].includes(status)) return 'pending'
  if (['failed', 'error', 'undelivered', 'bounced', 'rejected'].includes(status)) return 'failed'
  return ''
}

function normalizeDirection(value = '') {
  const direction = cleanString(value).toLowerCase()
  if (direction.includes('inbound') || direction.includes('incoming')) return 'inbound'
  if (direction.includes('outbound') || direction.includes('outgoing')) return 'outbound'
  return ''
}

/**
 * Determina el canal local de un mensaje de HighLevel.
 * Devuelve null para canales que no se muestran en el chat
 * (email, llamadas, reviews, actividades, etc).
 */
export function resolveHighLevelMessageChannel(message = {}) {
  const channelText = [
    message.messageType,
    message.message_type,
    message.channel,
    message.type,
    message.subType,
    message.sub_type
  ]
    .map(value => cleanString(value).toUpperCase())
    .filter(Boolean)
    .join(' ')

  if (!channelText) return null

  if (channelText.includes('WHATSAPP')) {
    return { table: 'whatsapp', transport: 'ghl_whatsapp' }
  }
  if (channelText.includes('FACEBOOK') || /\bFB\b/.test(channelText)) {
    return { table: 'meta', platform: 'messenger' }
  }
  if (channelText.includes('INSTAGRAM') || /\bIG\b/.test(channelText)) {
    return { table: 'meta', platform: 'instagram' }
  }

  // Excluir tipos que contienen "SMS" pero no son chat (review requests, etc.)
  if (channelText.includes('REVIEW') || channelText.includes('NO_SHOW')) return null

  if (channelText.includes('SMS')) {
    return { table: 'whatsapp', transport: 'ghl_sms' }
  }

  return null
}

function extractExportMessages(response = {}) {
  const candidates = [
    response.messages,
    response.items,
    response.data,
    response.data?.messages,
    response.data?.items,
    response.result?.messages
  ]
  return candidates.find(Array.isArray) || []
}

function extractExportCursor(response = {}) {
  return cleanString(
    response.nextCursor ||
    response.cursor ||
    response.meta?.nextCursor ||
    response.data?.nextCursor ||
    response.pageInfo?.nextCursor ||
    ''
  )
}

function getRemoteMessageId(message = {}) {
  return cleanString(message.id || message._id || message.messageId || message.message_id)
}

function getMessageBody(message = {}) {
  return cleanString(message.body || message.message || message.text || message.messageBody)
}

function getMessageAttachments(message = {}) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : []
  return attachments
    .map(item => cleanString(typeof item === 'string' ? item : item?.url || item?.fileUrl || item?.link))
    .filter(Boolean)
}

function inferAttachmentMessageType(url = '') {
  const cleanUrl = cleanString(url).split('?')[0].toLowerCase()
  if (/\.(jpg|jpeg|png|gif|webp|heic|bmp)$/.test(cleanUrl)) return 'image'
  if (/\.(mp4|mov|avi|webm|mkv)$/.test(cleanUrl)) return 'video'
  if (/\.(mp3|ogg|oga|wav|m4a|aac|opus)$/.test(cleanUrl)) return 'audio'
  if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|csv|txt|zip)$/.test(cleanUrl)) return 'document'
  return 'file'
}

async function getLocalContact(contactId) {
  if (!cleanString(contactId)) return null
  return db.get(
    'SELECT id, phone, email, full_name, first_name, last_name FROM contacts WHERE id = ?',
    [contactId]
  ).catch(() => null)
}

/**
 * Garantiza que el contacto del mensaje exista localmente.
 * Si no existe lo descarga desde HighLevel (reutiliza la lógica del sync).
 */
async function ensureLocalContact({ contactId, apiToken, locationId }) {
  let contact = await getLocalContact(contactId)
  if (contact) return { contact, created: false }

  const { ensureContactExists } = await import('./highlevelSyncService.js')
  const usePostgres = Boolean(process.env.DATABASE_URL)
  const created = await ensureContactExists(contactId, apiToken, usePostgres, locationId)
  contact = await getLocalContact(contactId)
  return { contact, created }
}

async function upsertWhatsAppRow({ message, contact, transport, direction, notifyNewInbound }) {
  const remoteMessageId = getRemoteMessageId(message)
  if (!remoteMessageId) return { saved: 0, isNew: false }

  const text = getMessageBody(message)
  const attachments = getMessageAttachments(message)
  const messageTimestamp = parseTimestampToIso(
    message.dateAdded || message.date_added || message.createdAt || message.created_at || message.dateUpdated
  ) || new Date().toISOString()
  const status = normalizeMessageStatus(message.status) || (direction === 'inbound' ? 'delivered' : 'sent')
  const contactPhone = cleanString(contact?.phone)
  const rawPayload = safeJsonStringify({ provider: 'highlevel', source: 'conversations_sync', message })
  const items = attachments.length ? attachments : [null]

  let saved = 0
  let isNew = false
  for (const [index, attachmentUrl] of items.entries()) {
    const localMessageId = hashId('ghl_msg', `${remoteMessageId}:${index}`)
    const existing = await db.get('SELECT id FROM whatsapp_api_messages WHERE id = ?', [localMessageId])
    if (!existing) isNew = true

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, ycloud_message_id, contact_id, phone, from_phone, to_phone,
        transport, direction, message_type, message_text, media_url,
        status, message_timestamp, raw_payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        contact_id = COALESCE(excluded.contact_id, whatsapp_api_messages.contact_id),
        phone = COALESCE(NULLIF(excluded.phone, ''), whatsapp_api_messages.phone),
        from_phone = COALESCE(NULLIF(excluded.from_phone, ''), whatsapp_api_messages.from_phone),
        to_phone = COALESCE(NULLIF(excluded.to_phone, ''), whatsapp_api_messages.to_phone),
        transport = COALESCE(NULLIF(excluded.transport, ''), whatsapp_api_messages.transport),
        direction = COALESCE(NULLIF(excluded.direction, ''), whatsapp_api_messages.direction),
        message_type = COALESCE(NULLIF(excluded.message_type, ''), whatsapp_api_messages.message_type),
        message_text = COALESCE(NULLIF(excluded.message_text, ''), whatsapp_api_messages.message_text),
        media_url = COALESCE(NULLIF(excluded.media_url, ''), whatsapp_api_messages.media_url),
        status = COALESCE(NULLIF(excluded.status, ''), whatsapp_api_messages.status),
        message_timestamp = COALESCE(excluded.message_timestamp, whatsapp_api_messages.message_timestamp),
        updated_at = CURRENT_TIMESTAMP
    `, [
      localMessageId,
      remoteMessageId,
      contact.id,
      contactPhone || null,
      direction === 'inbound' ? (contactPhone || null) : null,
      direction === 'inbound' ? null : (contactPhone || null),
      transport,
      direction,
      attachmentUrl ? inferAttachmentMessageType(attachmentUrl) : 'text',
      index === 0 ? text : '',
      attachmentUrl || null,
      status,
      messageTimestamp,
      rawPayload
    ])
    saved++
  }

  if (isNew && notifyNewInbound && direction === 'inbound') {
    sendChatMessageNotification({
      contactId: contact.id,
      contactName: contact.full_name || contact.first_name || contactPhone,
      text: text || 'Nuevo mensaje',
      messageType: attachments.length ? inferAttachmentMessageType(attachments[0]) : 'text',
      messageId: remoteMessageId,
      timestamp: messageTimestamp
    }).catch(error => {
      logger.warn(`[GHL Conversations] No se pudo notificar mensaje ${remoteMessageId}: ${error.message}`)
    })
  }

  return { saved, isNew }
}

async function upsertMetaRow({ message, contact, platform, direction, notifyNewInbound }) {
  const remoteMessageId = getRemoteMessageId(message)
  if (!remoteMessageId) return { saved: 0, isNew: false }

  const text = getMessageBody(message)
  const attachments = getMessageAttachments(message)
  const messageTimestamp = parseTimestampToIso(
    message.dateAdded || message.date_added || message.createdAt || message.created_at || message.dateUpdated
  ) || new Date().toISOString()
  const status = normalizeMessageStatus(message.status) || (direction === 'inbound' ? 'delivered' : 'sent')
  const rawPayload = safeJsonStringify({ provider: 'highlevel', source: 'conversations_sync', message })
  const profile = await db.get(
    `SELECT id, sender_id, recipient_id, page_id, instagram_account_id
     FROM meta_social_contacts
     WHERE contact_id = ? AND platform = ?
     ORDER BY updated_at DESC
     LIMIT 1`,
    [contact.id, platform]
  ).catch(() => null)
  const items = attachments.length ? attachments : [null]

  let saved = 0
  let isNew = false
  for (const [index, attachmentUrl] of items.entries()) {
    const localMessageId = hashId('ghl_meta_msg', `${remoteMessageId}:${index}`)
    const existing = await db.get('SELECT id FROM meta_social_messages WHERE id = ?', [localMessageId])
    if (!existing) isNew = true

    await db.run(`
      INSERT INTO meta_social_messages (
        id, platform, meta_message_id, meta_social_contact_id, contact_id,
        sender_id, recipient_id, page_id, instagram_account_id,
        direction, status, message_type, message_text, media_url,
        message_timestamp, raw_payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        meta_social_contact_id = COALESCE(excluded.meta_social_contact_id, meta_social_messages.meta_social_contact_id),
        contact_id = COALESCE(excluded.contact_id, meta_social_messages.contact_id),
        direction = COALESCE(NULLIF(excluded.direction, ''), meta_social_messages.direction),
        status = COALESCE(NULLIF(excluded.status, ''), meta_social_messages.status),
        message_type = COALESCE(NULLIF(excluded.message_type, ''), meta_social_messages.message_type),
        message_text = COALESCE(NULLIF(excluded.message_text, ''), meta_social_messages.message_text),
        media_url = COALESCE(NULLIF(excluded.media_url, ''), meta_social_messages.media_url),
        message_timestamp = COALESCE(excluded.message_timestamp, meta_social_messages.message_timestamp),
        updated_at = CURRENT_TIMESTAMP
    `, [
      localMessageId,
      platform,
      remoteMessageId,
      profile?.id || null,
      contact.id,
      direction === 'inbound' ? (profile?.sender_id || null) : (profile?.recipient_id || profile?.page_id || null),
      direction === 'inbound' ? (profile?.recipient_id || profile?.page_id || null) : (profile?.sender_id || null),
      profile?.page_id || null,
      profile?.instagram_account_id || null,
      direction,
      status,
      attachmentUrl ? inferAttachmentMessageType(attachmentUrl) : 'message',
      index === 0 ? text : '',
      attachmentUrl || null,
      messageTimestamp,
      rawPayload
    ])
    saved++
  }

  if (isNew && notifyNewInbound && direction === 'inbound') {
    sendChatMessageNotification({
      contactId: contact.id,
      contactName: contact.full_name || contact.first_name || platform,
      text: text || 'Nuevo mensaje',
      messageType: 'message',
      messageId: remoteMessageId,
      timestamp: messageTimestamp
    }).catch(error => {
      logger.warn(`[GHL Conversations] No se pudo notificar mensaje ${remoteMessageId}: ${error.message}`)
    })
  }

  return { saved, isNew }
}

/**
 * Guarda un mensaje de HighLevel en la tabla local correspondiente.
 * Crea el contacto local si no existe todavía.
 */
export async function upsertHighLevelConversationMessage({
  message,
  apiToken,
  locationId,
  notifyNewInbound = false
}) {
  const channel = resolveHighLevelMessageChannel(message)
  if (!channel) return { saved: 0, skipped: true, reason: 'channel_not_supported' }

  const direction = normalizeDirection(message.direction) || 'inbound'
  const contactId = cleanString(message.contactId || message.contact_id || message.contact?.id)
  if (!contactId) return { saved: 0, skipped: true, reason: 'missing_contact' }

  if (!getMessageBody(message) && getMessageAttachments(message).length === 0) {
    return { saved: 0, skipped: true, reason: 'empty_message' }
  }

  const { contact, created } = await ensureLocalContact({ contactId, apiToken, locationId })
  if (!contact) return { saved: 0, skipped: true, reason: 'contact_unavailable' }

  const result = channel.table === 'meta'
    ? await upsertMetaRow({ message, contact, platform: channel.platform, direction, notifyNewInbound })
    : await upsertWhatsAppRow({ message, contact, transport: channel.transport, direction, notifyNewInbound })

  return { ...result, skipped: false, contactCreated: created, table: channel.table }
}

/**
 * Sincroniza el historial de conversaciones desde HighLevel.
 *
 * @param {Object} options
 * @param {string} options.locationId
 * @param {string} options.apiToken
 * @param {boolean} options.fullSync - true para ignorar el checkpoint y traer todo
 * @param {boolean} options.notifyNewInbound - enviar push por mensajes entrantes nuevos
 * @param {Function} options.onProgress - callback (processed, totalKnown, message)
 */
export async function syncHighLevelConversationHistory({
  locationId,
  apiToken,
  fullSync = false,
  notifyNewInbound = false,
  onProgress
} = {}) {
  if (!locationId || !apiToken) {
    throw new Error('Se requieren locationId y apiToken para sincronizar conversaciones')
  }

  if (syncRunning) {
    logger.info('[GHL Conversations] Sincronización ya en curso, se omite esta ejecución')
    return { total: 0, saved: 0, skipped: 0, contactsCreated: 0, alreadyRunning: true }
  }

  syncRunning = true
  const startedAt = new Date().toISOString()

  try {
    const client = new GHLClient(apiToken, locationId)

    let startDate = null
    if (!fullSync) {
      const lastSyncedAt = parseTimestampToIso(await getAppConfig(LAST_SYNC_CONFIG_KEY).catch(() => null))
      if (lastSyncedAt) {
        startDate = new Date(new Date(lastSyncedAt).getTime() - INCREMENTAL_OVERLAP_MS).toISOString()
      }
    }

    logger.info(`[GHL Conversations] Importando historial de chats desde HighLevel${startDate ? ` (desde ${startDate})` : ' (historial completo)'}...`)

    let cursor = null
    let page = 0
    let total = 0
    let saved = 0
    let skipped = 0
    let contactsCreated = 0
    const seenCursors = new Set()

    while (page < MAX_EXPORT_PAGES) {
      page++
      const response = await client.exportConversationMessages({
        limit: EXPORT_PAGE_LIMIT,
        sortBy: 'createdAt',
        sortOrder: 'desc',
        ...(startDate && { startDate }),
        ...(cursor && { cursor })
      })

      const messages = extractExportMessages(response)
      if (!messages.length) break

      for (const message of messages) {
        total++
        try {
          const result = await upsertHighLevelConversationMessage({
            message,
            apiToken,
            locationId,
            notifyNewInbound
          })
          if (result.skipped) {
            skipped++
          } else {
            saved += result.saved > 0 ? 1 : 0
            if (result.contactCreated) contactsCreated++
          }
        } catch (error) {
          skipped++
          logger.warn(`[GHL Conversations] No se pudo guardar mensaje ${getRemoteMessageId(message) || 'sin_id'}: ${error.message}`)
        }
      }

      if (onProgress) {
        const totalKnown = Number(response.total || response.totalCount || 0) || total
        onProgress(saved, Math.max(totalKnown, total), `Importando chats: ${saved} mensajes guardados`)
      }

      const nextCursor = extractExportCursor(response)
      if (!nextCursor || seenCursors.has(nextCursor)) break

      seenCursors.add(nextCursor)
      cursor = nextCursor
    }

    await setAppConfig(LAST_SYNC_CONFIG_KEY, startedAt)

    logger.info(`[GHL Conversations] ✅ ${saved} mensajes sincronizados (${skipped} omitidos, ${contactsCreated} contactos creados)`)

    return { total, saved, skipped, contactsCreated }
  } finally {
    syncRunning = false
  }
}

/**
 * Procesa un webhook de conversación desde un workflow de HighLevel
 * (trigger "Customer Replied" / "Cliente respondió" → Custom Webhook).
 * Acepta payloads flexibles: el mensaje puede venir en message{}, customData{}
 * o en la raíz del body.
 */
export async function processHighLevelConversationWebhook(payload = {}) {
  const { getHighLevelConfig } = await import('../config/database.js')
  const config = await getHighLevelConfig()
  if (!config?.api_token || !config?.location_id) {
    return { saved: 0, skipped: true, reason: 'highlevel_not_configured' }
  }

  const messageSource = payload.message && typeof payload.message === 'object'
    ? payload.message
    : payload.customData && typeof payload.customData === 'object'
      ? payload.customData
      : payload

  const contactId = cleanString(
    payload.contact_id ||
    payload.contactId ||
    payload.contact?.id ||
    messageSource.contactId ||
    messageSource.contact_id
  )

  const message = {
    id: getRemoteMessageId(messageSource) || getRemoteMessageId(payload) ||
      hashId('ghl_wh', `${contactId}:${getMessageBody(messageSource)}:${Date.now()}`),
    contactId,
    body: getMessageBody(messageSource) || getMessageBody(payload),
    direction: messageSource.direction || payload.direction || 'inbound',
    messageType: messageSource.messageType || messageSource.type || payload.messageType || payload.type || payload.channel,
    status: messageSource.status || payload.status,
    attachments: Array.isArray(messageSource.attachments) ? messageSource.attachments : [],
    dateAdded: messageSource.dateAdded || messageSource.timestamp || payload.timestamp || new Date().toISOString()
  }

  // Si el workflow no especifica canal, asumir WhatsApp (canal principal de chat)
  if (!resolveHighLevelMessageChannel(message)) {
    message.messageType = 'TYPE_WHATSAPP'
  }

  return upsertHighLevelConversationMessage({
    message,
    apiToken: config.api_token,
    locationId: config.location_id,
    notifyNewInbound: true
  })
}
