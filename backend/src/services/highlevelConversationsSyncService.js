/**
 * SINCRONIZACIÓN DE CONVERSACIONES (CHATS) DESDE HIGHLEVEL
 *
 * Importa el historial de mensajes de HighLevel (WhatsApp, SMS, Messenger,
 * Instagram y correo) hacia las tablas locales que alimentan el chat de la app
 * móvil y del escritorio:
 * - whatsapp_api_messages  (WhatsApp y SMS enviados/recibidos vía GHL)
 * - meta_social_messages   (Messenger e Instagram vía GHL)
 * - email_messages         (correo vía GHL)
 *
 * Usa GET /conversations/messages/export para sincronizaciones incrementales
 * recientes y GET /conversations/search + /conversations/{id}/messages para
 * backfills completos. El export global de HighLevel puede repetir cursor en
 * historiales grandes; el backfill por conversación evita cortar el historial.
 * Los IDs locales se generan igual que los espejos de envío
 * (hashId('ghl_msg', `${remoteId}:0`)) para no duplicar mensajes que
 * Ristak ya guardó al enviarlos.
 */

import crypto from 'crypto'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { logger } from '../utils/logger.js'
import GHLClient from './ghlClient.js'
import { sendChatMessageNotification } from './pushNotificationsService.js'
import { publishChatMessageEvent } from './chatLiveEventsService.js'
import { recordInboundChatUnread } from './chatReadStateService.js'
// (NOTI-003) La confirmación de citas por respuesta también debe abrirse cuando el
// contacto responde por canales sincronizados vía HighLevel (SMS/Messenger/Instagram/
// WhatsApp de GHL), no solo por WhatsApp API.
import { maybeConfirmAppointmentFromReply, handleInboundForConfirmation } from './appointmentConfirmationService.js'

const LAST_SYNC_CONFIG_KEY = 'highlevel_conversations_last_synced_at'
const INCREMENTAL_OVERLAP_MS = 24 * 60 * 60 * 1000 // re-leer 24h hacia atrás por seguridad
const EXPORT_PAGE_LIMIT = 100
const MAX_EXPORT_PAGES = 1000
const CONVERSATION_SEARCH_PAGE_LIMIT = 100
const MAX_CONVERSATION_SEARCH_PAGES = 500
const CONVERSATION_MESSAGES_PAGE_LIMIT = 100
const MAX_CONVERSATION_MESSAGE_PAGES = 500
const HISTORICAL_BULK_IMPORT_CHUNK_SIZE = 50
const WEBHOOK_FALLBACK_ID_BUCKET_MS = 60 * 1000
const HIGHLEVEL_DUPLICATE_WINDOW_MS = 90 * 1000
const HIGHLEVEL_WEBHOOK_FALLBACK_ID_PREFIX = 'ghl_wh_'
const HIGHLEVEL_NUMERIC_MESSAGE_TYPES = new Map([
  [2, 'TYPE_SMS'],
  [3, 'TYPE_EMAIL'],
  [4, 'TYPE_FACEBOOK'],
  [6, 'TYPE_INSTAGRAM'],
  [19, 'TYPE_WHATSAPP'],
  [20, 'TYPE_CUSTOM_SMS']
])

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

function buildIncrementalStartDate(lastSyncedAt) {
  const parsed = parseTimestampToIso(lastSyncedAt)
  if (!parsed) return null
  return new Date(new Date(parsed).getTime() - INCREMENTAL_OVERLAP_MS).toISOString()
}

function parseTimestampMs(value) {
  const iso = parseTimestampToIso(value)
  if (!iso) return null
  const timestamp = new Date(iso).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}

function normalizeDedupeText(value = '') {
  return cleanString(value).replace(/\s+/g, ' ').toLowerCase()
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

function inferHighLevelMessageType(message = {}) {
  const explicit = cleanString(message.messageType || message.message_type)
  if (explicit) return explicit

  const raw = cleanString(message.type)
  if (!raw) return ''
  if (/^\d+$/.test(raw)) {
    return HIGHLEVEL_NUMERIC_MESSAGE_TYPES.get(Number(raw)) || raw
  }
  return raw
}

/**
 * Determina el canal local de un mensaje de HighLevel.
 * Devuelve null para canales que no se muestran en el chat
 * (llamadas, reviews, actividades, etc).
 */
export function resolveHighLevelMessageChannel(message = {}) {
  const channelText = [
    inferHighLevelMessageType(message),
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
  if (channelText.includes('WEBCHAT') || channelText.includes('WEB_CHAT') || channelText.includes('LIVE_CHAT')) {
    return { table: 'whatsapp', transport: 'ghl_webchat' }
  }
  if (channelText.includes('EMAIL') || channelText.includes('E-MAIL')) {
    return { table: 'email', transport: 'ghl_email' }
  }

  // Excluir tipos que contienen "SMS" pero no son chat (review requests, etc.)
  if (channelText.includes('REVIEW') || channelText.includes('NO_SHOW')) return null

  if (channelText.includes('SMS') || channelText.includes('MMS')) {
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

function extractExportTotal(response = {}) {
  const total = Number(
    response.total ||
    response.totalCount ||
    response.data?.total ||
    response.data?.totalCount ||
    response.meta?.total ||
    0
  )
  return Number.isFinite(total) && total > 0 ? total : 0
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

function extractConversationRows(response = {}) {
  const candidates = [
    response.conversations,
    response.items,
    response.data,
    response.data?.conversations,
    response.result?.conversations
  ]
  return candidates.find(Array.isArray) || []
}

function extractConversationSearchTotal(response = {}) {
  const total = Number(response.total || response.totalCount || response.data?.total || 0)
  return Number.isFinite(total) && total > 0 ? total : 0
}

function getConversationId(conversation = {}) {
  return cleanString(conversation.id || conversation.conversationId || conversation.conversation_id)
}

function getConversationContactId(conversation = {}) {
  return cleanString(conversation.contactId || conversation.contact_id || conversation.contact?.id)
}

function getConversationSearchCursor(conversation = {}) {
  const raw = conversation.lastMessageDate ||
    conversation.last_message_date ||
    conversation.dateUpdated ||
    conversation.date_updated ||
    conversation.updatedAt ||
    conversation.updated_at ||
    conversation.dateAdded ||
    conversation.date_added ||
    conversation.createdAt ||
    conversation.created_at
  return cleanString(raw)
}

function extractConversationMessagesPayload(response = {}) {
  const payload = response.messages || response.data?.messages || response.result?.messages
  if (Array.isArray(payload)) return { messages: payload }
  if (payload && typeof payload === 'object') return payload
  return {}
}

function extractConversationMessages(response = {}) {
  const payload = extractConversationMessagesPayload(response)
  const candidates = [
    payload.messages,
    payload.items,
    response.items,
    response.data,
    response.data?.items
  ]
  return candidates.find(Array.isArray) || []
}

function extractConversationMessagesCursor(response = {}, messages = []) {
  const payload = extractConversationMessagesPayload(response)
  return cleanString(
    payload.lastMessageId ||
    payload.nextLastMessageId ||
    payload.nextMessageId ||
    payload.cursor ||
    messages.at(-1)?.id ||
    ''
  )
}

function hasConversationMessagesNextPage(response = {}) {
  const payload = extractConversationMessagesPayload(response)
  const value = payload.nextPage ?? payload.hasMore ?? payload.has_more
  if (typeof value === 'boolean') return value
  return ['1', 'true', 'yes'].includes(cleanString(value).toLowerCase())
}

function normalizeConversationMessage(message = {}, conversation = {}) {
  const normalized = { ...message }
  const messageType = inferHighLevelMessageType(normalized)
  if (messageType && !cleanString(normalized.messageType || normalized.message_type)) {
    normalized.messageType = messageType
  }

  if (!cleanString(normalized.contactId || normalized.contact_id)) {
    normalized.contactId = getConversationContactId(conversation)
  }
  if (!cleanString(normalized.conversationId || normalized.conversation_id)) {
    normalized.conversationId = getConversationId(conversation)
  }

  return normalized
}

function getRemoteMessageId(message = {}) {
  return cleanString(message.id || message._id || message.messageId || message.message_id)
}

function isHighLevelWebhookFallbackId(value = '') {
  return cleanString(value).startsWith(HIGHLEVEL_WEBHOOK_FALLBACK_ID_PREFIX)
}

export function buildHighLevelWebhookFallbackMessageId({
  contactId,
  body,
  messageType,
  direction,
  attachments = [],
  timestamp
} = {}) {
  const timestampMs = parseTimestampMs(timestamp) ?? Date.now()
  const timestampBucket = Math.floor(timestampMs / WEBHOOK_FALLBACK_ID_BUCKET_MS)
  const attachmentKey = attachments.map(item => cleanString(item)).filter(Boolean).join('|')
  return hashId('ghl_wh', [
    cleanString(contactId),
    cleanString(messageType).toUpperCase(),
    cleanString(direction).toLowerCase() || 'inbound',
    normalizeDedupeText(body),
    attachmentKey,
    timestampBucket
  ].join(':'))
}

function getDuplicateWindow(timestamp) {
  const timestampMs = parseTimestampMs(timestamp)
  if (!timestampMs) return null
  return {
    start: new Date(timestampMs - HIGHLEVEL_DUPLICATE_WINDOW_MS).toISOString(),
    end: new Date(timestampMs + HIGHLEVEL_DUPLICATE_WINDOW_MS).toISOString()
  }
}

function isSameMessageContent(row = {}, { text = '', attachmentUrl = '' } = {}) {
  return normalizeDedupeText(row.message_text) === normalizeDedupeText(text) &&
    cleanString(row.media_url) === cleanString(attachmentUrl)
}

function selectCanonicalDuplicateRow(rows = [], proposedLocalMessageId = '', remoteMessageId = '', remoteColumn = '') {
  const proposed = rows.find(row => row.id === proposedLocalMessageId)
  if (proposed) return proposed

  const remote = cleanString(remoteMessageId)
  if (remote && !isHighLevelWebhookFallbackId(remote)) {
    const existingRemote = rows.find(row => cleanString(row[remoteColumn]) === remote)
    if (existingRemote) return existingRemote
  }

  const realRemote = rows.find(row => {
    const value = cleanString(row[remoteColumn])
    return value && !isHighLevelWebhookFallbackId(value)
  })
  return realRemote || rows[0] || null
}

async function findHighLevelWhatsAppDuplicateRows({
  contactId,
  transport,
  direction,
  text,
  attachmentUrl,
  messageTimestamp,
  remoteMessageId,
  proposedLocalMessageId
}) {
  const window = getDuplicateWindow(messageTimestamp)
  if (!window || !contactId || !direction) return []

  const rows = await db.all(`
    SELECT id, ycloud_message_id, wamid, message_text, media_url, message_timestamp, created_at
    FROM whatsapp_api_messages
    WHERE contact_id = ?
      AND COALESCE(transport, '') = COALESCE(?, '')
      AND direction = ?
      AND message_timestamp BETWEEN ? AND ?
    ORDER BY created_at ASC, message_timestamp ASC
  `, [contactId, transport || '', direction, window.start, window.end]).catch(() => [])

  const remote = cleanString(remoteMessageId)
  const incomingFallback = isHighLevelWebhookFallbackId(remote)
  return rows.filter(row => {
    const rowRemote = cleanString(row.ycloud_message_id || row.wamid)
    const sameRemote = remote && rowRemote === remote
    const fallbackRelated = incomingFallback || isHighLevelWebhookFallbackId(rowRemote) || row.id === proposedLocalMessageId
    return (sameRemote || fallbackRelated) && isSameMessageContent(row, { text, attachmentUrl })
  })
}

async function deleteDuplicateWhatsAppRows(rows = [], canonicalId = '') {
  const duplicateIds = rows
    .map(row => cleanString(row.id))
    .filter(id => id && id !== canonicalId)
  for (const id of duplicateIds) {
    await db.run('DELETE FROM whatsapp_api_attribution WHERE whatsapp_api_message_id = ?', [id]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE id = ?', [id]).catch(() => undefined)
  }
}

async function findHighLevelMetaDuplicateRows({
  contactId,
  platform,
  direction,
  text,
  attachmentUrl,
  messageTimestamp,
  remoteMessageId,
  proposedLocalMessageId
}) {
  const window = getDuplicateWindow(messageTimestamp)
  if (!window || !contactId || !platform || !direction) return []

  const rows = await db.all(`
    SELECT id, meta_message_id, message_text, media_url, message_timestamp, created_at
    FROM meta_social_messages
    WHERE contact_id = ?
      AND platform = ?
      AND direction = ?
      AND message_timestamp BETWEEN ? AND ?
    ORDER BY created_at ASC, message_timestamp ASC
  `, [contactId, platform, direction, window.start, window.end]).catch(() => [])

  const remote = cleanString(remoteMessageId)
  const incomingFallback = isHighLevelWebhookFallbackId(remote)
  return rows.filter(row => {
    const rowRemote = cleanString(row.meta_message_id)
    const sameRemote = remote && rowRemote === remote
    const fallbackRelated = incomingFallback || isHighLevelWebhookFallbackId(rowRemote) || row.id === proposedLocalMessageId
    return (sameRemote || fallbackRelated) && isSameMessageContent(row, { text, attachmentUrl })
  })
}

async function deleteDuplicateMetaRows(rows = [], canonicalId = '') {
  const duplicateIds = rows
    .map(row => cleanString(row.id))
    .filter(id => id && id !== canonicalId)
  for (const id of duplicateIds) {
    await db.run('DELETE FROM meta_social_messages WHERE id = ?', [id]).catch(() => undefined)
  }
}

function getMessageBody(message = {}) {
  return cleanString(
    message.body ||
    message.message ||
    message.text ||
    message.content ||
    message.messageBody ||
    message.message_body ||
    message.bodyText ||
    message.body_text ||
    message.plainText ||
    message.plain_text ||
    message.emailBody ||
    message.email_body ||
    message.htmlBody ||
    message.html_body
  )
}

function getEmailSubject(message = {}) {
  return cleanString(message.subject || message.emailSubject || message.email_subject || message.title)
}

function pickEmailAddress(...values) {
  for (const value of values) {
    if (!value) continue
    if (typeof value === 'string') {
      const email = cleanString(value)
      if (email.includes('@')) return email
      continue
    }
    if (typeof value === 'object') {
      const email = cleanString(value.email || value.address || value.emailAddress || value.email_address)
      if (email.includes('@')) return email
    }
  }
  return ''
}

function pickAttachmentUrl(item = {}) {
  if (typeof item === 'string') return cleanString(item)
  if (!item || typeof item !== 'object') return ''
  return cleanString(
    item.url ||
    item.fileUrl ||
    item.file_url ||
    item.mediaUrl ||
    item.media_url ||
    item.publicUrl ||
    item.public_url ||
    item.downloadUrl ||
    item.download_url ||
    item.link ||
    item.href ||
    item.audioUrl ||
    item.audio_url ||
    item.imageUrl ||
    item.image_url ||
    item.videoUrl ||
    item.video_url
  )
}

function getMessageAttachments(message = {}) {
  const attachments = [
    ...(Array.isArray(message.attachments) ? message.attachments : []),
    message.attachment,
    message.media,
    message.file,
    message.audio,
    message.image,
    message.video,
    message.document
  ].filter(Boolean)
  return attachments
    .map(pickAttachmentUrl)
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
 * El contactId que manda GHL se resuelve al ID local de Ristak (ghl_contact_id);
 * si no existe se descarga desde HighLevel (reutiliza la lógica del sync).
 */
async function ensureLocalContact({ contactId, apiToken, locationId, contactCache }) {
  const cleanContactId = cleanString(contactId)
  if (!cleanContactId) return { contact: null, created: false }

  if (contactCache?.has(cleanContactId)) {
    return { contact: contactCache.get(cleanContactId), created: false }
  }

  const { resolveContactIdByGhlId } = await import('./contactIdentityService.js')
  const resolvedId = await resolveContactIdByGhlId(cleanContactId)
  if (resolvedId) {
    const contact = await getLocalContact(resolvedId)
    if (contact) {
      contactCache?.set(cleanContactId, contact)
      return { contact, created: false }
    }
  }

  const { ensureContactExists } = await import('./highlevelSyncService.js')
  const usePostgres = Boolean(process.env.DATABASE_URL)
  const ensured = await ensureContactExists(cleanContactId, apiToken, usePostgres, locationId)
  const contact = ensured.localContactId ? await getLocalContact(ensured.localContactId) : null
  if (contact) {
    contactCache?.set(cleanContactId, contact)
  }
  return { contact, created: Boolean(ensured.created) }
}

async function triggerAutomationsForInboundMessage({ contact, channel, text, messageType, isNew, notifyNewInbound }) {
  if (!contact?.id || !isNew || !notifyNewInbound) return
  if (!['whatsapp', 'messenger', 'instagram', 'sms', 'webchat', 'email'].includes(channel)) return

  // (NOTI-003) Abrir/evaluar la ventana de confirmación de citas también para los
  // inbound que llegan vía HighLevel. Si hay una ventana activa con bypass, no
  // disparamos automatizaciones (mismo criterio que el inbound de WhatsApp API/QR).
  let confirmWindow = { windowActive: false, bypassAutomations: false }
  await handleInboundForConfirmation({ contactId: contact.id, text })
    .then(w => { confirmWindow = w })
    .catch(error => {
      logger.warn(`[Citas] Error en ventana de confirmación (GHL ${channel}): ${error.message}`)
    })

  if (!confirmWindow.windowActive) {
    await maybeConfirmAppointmentFromReply({ contactId: contact.id, text })
      .catch(error => {
        logger.warn(`[Citas] No se pudo evaluar confirmación automática (GHL ${channel}): ${error.message}`)
      })
  }

  if (confirmWindow.windowActive && confirmWindow.bypassAutomations) return

  await import('./automationEngine.js')
    .then(engine => engine.handleIncomingMessage({
      contactId: contact.id,
      phone: contact.phone,
      contactName: contact.full_name || contact.first_name,
      text,
      messageType,
      channel
    }))
    .catch(error => {
      logger.warn(`[Automatizaciones] GHL no pudo procesar mensaje entrante ${channel}: ${error.message}`)
    })
}

function getAutomationChannel(channel = {}) {
  if (channel.table === 'email') return 'email'
  if (channel.table === 'meta') return channel.platform
  if (channel.table === 'whatsapp' && channel.transport === 'ghl_whatsapp') return 'whatsapp'
  if (channel.table === 'whatsapp' && channel.transport === 'ghl_sms') return 'sms'
  if (channel.table === 'whatsapp' && channel.transport === 'ghl_webchat') return 'webchat'
  return ''
}

function getLocalChannelFromWhatsAppTransport(transport = '') {
  const normalized = cleanString(transport).toLowerCase().replace(/[\s-]+/g, '_')
  if (normalized === 'ghl_sms') return 'sms'
  if (normalized === 'ghl_webchat') return 'webchat'
  return 'whatsapp'
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
    let localMessageId = hashId('ghl_msg', `${remoteMessageId}:${index}`)
    const duplicateRows = await findHighLevelWhatsAppDuplicateRows({
      contactId: contact.id,
      transport,
      direction,
      text: index === 0 ? text : '',
      attachmentUrl: attachmentUrl || '',
      messageTimestamp,
      remoteMessageId,
      proposedLocalMessageId: localMessageId
    })
    const duplicate = selectCanonicalDuplicateRow(duplicateRows, localMessageId, remoteMessageId, 'ycloud_message_id')
    if (duplicate) {
      localMessageId = duplicate.id
    }
    const existing = await db.get('SELECT id FROM whatsapp_api_messages WHERE id = ?', [localMessageId])
    if (!existing) isNew = true

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, ycloud_message_id, contact_id, phone, from_phone, to_phone,
        transport, direction, message_type, message_text, media_url,
        status, message_timestamp, raw_payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        ycloud_message_id = COALESCE(NULLIF(excluded.ycloud_message_id, ''), whatsapp_api_messages.ycloud_message_id),
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
        raw_payload_json = excluded.raw_payload_json,
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
    await deleteDuplicateWhatsAppRows(duplicateRows, localMessageId)
    saved++
  }

  if (isNew && notifyNewInbound && direction === 'inbound') {
    recordInboundChatUnread({
      contactId: contact.id,
      messageTimestamp
    }).catch(error => {
      logger.warn(`[Chat Read State] No se pudo incrementar unread GHL ${remoteMessageId}: ${error.message}`)
    })
    const channel = getLocalChannelFromWhatsAppTransport(transport)
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
    import('../agents/conversational/runner.js')
      .then(runner => runner.handleInboundConversationalChatMessage({
        contactId: contact.id,
        phone: contactPhone || null,
        messageId: hashId('ghl_msg', `${remoteMessageId}:0`),
        channel
      }))
      .catch(error => {
        logger.warn(`[Agente conversacional] GHL ${channel} no atendido: ${error.message}`)
      })
  }

  if (saved > 0) {
    const channel = getLocalChannelFromWhatsAppTransport(transport)
    publishChatMessageEvent({
      contactId: contact.id,
      messageId: remoteMessageId,
      channel,
      provider: 'highlevel',
      transport,
      direction,
      messageType: attachments.length ? inferAttachmentMessageType(attachments[0]) : 'text',
      messageTimestamp,
      isNew
    })
  }

  return { saved, isNew }
}

async function upsertEmailRow({ message, contact, direction, notifyNewInbound }) {
  const remoteMessageId = getRemoteMessageId(message)
  if (!remoteMessageId) return { saved: 0, isNew: false }

  const localMessageId = hashId('ghl_email_msg', `${remoteMessageId}:0`)
  const existing = await db.get('SELECT id FROM email_messages WHERE id = ?', [localMessageId])
  const isNew = !existing
  const text = getMessageBody(message)
  const messageTimestamp = parseTimestampToIso(
    message.dateAdded || message.date_added || message.createdAt || message.created_at || message.dateUpdated
  ) || new Date().toISOString()
  const status = normalizeMessageStatus(message.status) || (direction === 'inbound' ? 'delivered' : 'sent')
  const fromEmail = pickEmailAddress(
    message.fromEmail,
    message.from_email,
    message.from,
    message.sender,
    direction === 'inbound' ? contact?.email : ''
  )
  const toEmail = pickEmailAddress(
    message.toEmail,
    message.to_email,
    message.to,
    message.recipient,
    message.recipients?.[0],
    direction === 'outbound' ? contact?.email : ''
  )
  const rawPayload = safeJsonStringify({ provider: 'highlevel', source: 'conversations_sync', message })

  await db.run(`
    INSERT INTO email_messages (
      id, contact_id, direction, status, to_email, from_email, reply_to,
      subject, message_text, message_timestamp, raw_payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      contact_id = COALESCE(excluded.contact_id, email_messages.contact_id),
      direction = COALESCE(NULLIF(excluded.direction, ''), email_messages.direction),
      status = COALESCE(NULLIF(excluded.status, ''), email_messages.status),
      to_email = COALESCE(NULLIF(excluded.to_email, ''), email_messages.to_email),
      from_email = COALESCE(NULLIF(excluded.from_email, ''), email_messages.from_email),
      reply_to = COALESCE(NULLIF(excluded.reply_to, ''), email_messages.reply_to),
      subject = COALESCE(NULLIF(excluded.subject, ''), email_messages.subject),
      message_text = COALESCE(NULLIF(excluded.message_text, ''), email_messages.message_text),
      message_timestamp = COALESCE(excluded.message_timestamp, email_messages.message_timestamp),
      raw_payload_json = excluded.raw_payload_json,
      updated_at = CURRENT_TIMESTAMP
  `, [
    localMessageId,
    contact.id,
    direction,
    status,
    toEmail || null,
    fromEmail || null,
    fromEmail || null,
    getEmailSubject(message),
    text,
    messageTimestamp,
    rawPayload
  ])

  if (isNew && notifyNewInbound && direction === 'inbound') {
    recordInboundChatUnread({
      contactId: contact.id,
      messageTimestamp
    }).catch(error => {
      logger.warn(`[Chat Read State] No se pudo incrementar unread GHL email ${remoteMessageId}: ${error.message}`)
    })
    sendChatMessageNotification({
      contactId: contact.id,
      contactName: contact.full_name || contact.first_name || fromEmail || 'Email',
      text: text || getEmailSubject(message) || 'Nuevo correo',
      messageType: 'email',
      messageId: remoteMessageId,
      timestamp: messageTimestamp
    }).catch(error => {
      logger.warn(`[GHL Conversations] No se pudo notificar email ${remoteMessageId}: ${error.message}`)
    })
    import('../agents/conversational/runner.js')
      .then(runner => runner.handleInboundConversationalEmailMessage({
        contactId: contact.id,
        messageId: localMessageId
      }))
      .catch(error => {
        logger.warn(`[Agente conversacional] GHL email no atendido: ${error.message}`)
      })
  }

  publishChatMessageEvent({
    contactId: contact.id,
    messageId: remoteMessageId,
    channel: 'email',
    provider: 'highlevel',
    transport: 'ghl_email',
    direction,
    messageType: 'email',
    messageTimestamp,
    isNew
  })

  return { saved: 1, isNew }
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
    let localMessageId = hashId('ghl_meta_msg', `${remoteMessageId}:${index}`)
    const duplicateRows = await findHighLevelMetaDuplicateRows({
      contactId: contact.id,
      platform,
      direction,
      text: index === 0 ? text : '',
      attachmentUrl: attachmentUrl || '',
      messageTimestamp,
      remoteMessageId,
      proposedLocalMessageId: localMessageId
    })
    const duplicate = selectCanonicalDuplicateRow(duplicateRows, localMessageId, remoteMessageId, 'meta_message_id')
    if (duplicate) {
      localMessageId = duplicate.id
    }
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
        meta_message_id = COALESCE(NULLIF(excluded.meta_message_id, ''), meta_social_messages.meta_message_id),
        meta_social_contact_id = COALESCE(excluded.meta_social_contact_id, meta_social_messages.meta_social_contact_id),
        contact_id = COALESCE(excluded.contact_id, meta_social_messages.contact_id),
        direction = COALESCE(NULLIF(excluded.direction, ''), meta_social_messages.direction),
        status = COALESCE(NULLIF(excluded.status, ''), meta_social_messages.status),
        message_type = COALESCE(NULLIF(excluded.message_type, ''), meta_social_messages.message_type),
        message_text = COALESCE(NULLIF(excluded.message_text, ''), meta_social_messages.message_text),
        media_url = COALESCE(NULLIF(excluded.media_url, ''), meta_social_messages.media_url),
        message_timestamp = COALESCE(excluded.message_timestamp, meta_social_messages.message_timestamp),
        raw_payload_json = excluded.raw_payload_json,
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
    await deleteDuplicateMetaRows(duplicateRows, localMessageId)
    saved++
  }

  if (isNew && notifyNewInbound && direction === 'inbound') {
    recordInboundChatUnread({
      contactId: contact.id,
      messageTimestamp
    }).catch(error => {
      logger.warn(`[Chat Read State] No se pudo incrementar unread GHL ${platform} ${remoteMessageId}: ${error.message}`)
    })
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
    import('../agents/conversational/runner.js')
      .then(runner => runner.handleInboundConversationalChatMessage({
        contactId: contact.id,
        messageId: hashId('ghl_meta_msg', `${remoteMessageId}:0`),
        channel: platform
      }))
      .catch(error => {
        logger.warn(`[Agente conversacional] GHL ${platform} no atendido: ${error.message}`)
      })
  }

  if (saved > 0) {
    publishChatMessageEvent({
      contactId: contact.id,
      messageId: remoteMessageId,
      channel: platform,
      provider: 'highlevel',
      transport: `ghl_${platform}`,
      direction,
      messageType: attachments.length ? inferAttachmentMessageType(attachments[0]) : 'message',
      messageTimestamp,
      isNew
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
  notifyNewInbound = false,
  contactCache
}) {
  const channel = resolveHighLevelMessageChannel(message)
  if (!channel) return { saved: 0, skipped: true, reason: 'channel_not_supported' }

  const direction = normalizeDirection(message.direction) || 'inbound'
  const contactId = cleanString(message.contactId || message.contact_id || message.contact?.id)
  if (!contactId) return { saved: 0, skipped: true, reason: 'missing_contact' }

  if (!getMessageBody(message) && !getEmailSubject(message) && getMessageAttachments(message).length === 0) {
    return { saved: 0, skipped: true, reason: 'empty_message' }
  }

  const { contact, created } = await ensureLocalContact({ contactId, apiToken, locationId, contactCache })
  if (!contact) return { saved: 0, skipped: true, reason: 'contact_unavailable' }

  const result = channel.table === 'email'
    ? await upsertEmailRow({ message, contact, direction, notifyNewInbound })
    : channel.table === 'meta'
      ? await upsertMetaRow({ message, contact, platform: channel.platform, direction, notifyNewInbound })
      : await upsertWhatsAppRow({ message, contact, transport: channel.transport, direction, notifyNewInbound })

  if (direction === 'inbound') {
    await triggerAutomationsForInboundMessage({
      contact,
      channel: getAutomationChannel(channel),
      text: getMessageBody(message),
      messageType: getMessageAttachments(message).length ? 'media' : 'text',
      isNew: result.isNew,
      notifyNewInbound
    })
  }

  return { ...result, skipped: false, contactCreated: created, table: channel.table }
}

function createSyncStats(strategy) {
  return {
    strategy,
    total: 0,
    saved: 0,
    skipped: 0,
    contactsCreated: 0,
    failedMessages: 0,
    oldestFailedMs: null,
    incomplete: false,
    incompleteReason: '',
    pages: 0,
    conversations: 0,
    conversationsProcessed: 0,
    failedConversations: 0
  }
}

function recordFailedMessageTimestamp(stats, message = {}) {
  const failedMs = parseTimestampMs(
    message.dateAdded || message.date_added || message.createdAt || message.created_at || message.dateUpdated
  )
  if (failedMs !== null && (stats.oldestFailedMs === null || failedMs < stats.oldestFailedMs)) {
    stats.oldestFailedMs = failedMs
  }
}

async function importHighLevelMessageBatch({
  messages,
  apiToken,
  locationId,
  notifyNewInbound,
  stats,
  contactCache,
  historicalImport = false
}) {
  if (historicalImport) {
    await importHighLevelHistoricalMessageBatch({
      messages,
      apiToken,
      locationId,
      stats,
      contactCache
    })
    return
  }

  for (const message of messages) {
    stats.total++
    try {
      const result = await upsertHighLevelConversationMessage({
        message,
        apiToken,
        locationId,
        notifyNewInbound,
        contactCache
      })
      if (result.skipped) {
        stats.skipped++
      } else {
        stats.saved += result.saved > 0 ? 1 : 0
        if (result.contactCreated) stats.contactsCreated++
      }
    } catch (error) {
      stats.skipped++
      stats.failedMessages++
      recordFailedMessageTimestamp(stats, message)
      logger.error(`[GHL Conversations] No se pudo guardar mensaje ${getRemoteMessageId(message) || 'sin_id'}: ${error.message}`)
    }
  }
}

function chunkRows(rows = [], size = HISTORICAL_BULK_IMPORT_CHUNK_SIZE) {
  const chunks = []
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size))
  }
  return chunks
}

function createValuesSql(rowCount, paramCount) {
  const placeholders = `(${Array.from({ length: paramCount }, () => '?').join(', ')}, CURRENT_TIMESTAMP)`
  return Array.from({ length: rowCount }, () => placeholders).join(', ')
}

function getMessageTimestamp(message = {}) {
  return parseTimestampToIso(
    message.dateAdded || message.date_added || message.createdAt || message.created_at || message.dateUpdated
  ) || new Date().toISOString()
}

function prepareHistoricalMessageRows({ message, contact, channel, direction }) {
  const remoteMessageId = getRemoteMessageId(message)
  if (!remoteMessageId) return { reason: 'missing_message_id' }

  const text = getMessageBody(message)
  const attachments = getMessageAttachments(message)
  const messageTimestamp = getMessageTimestamp(message)
  const status = normalizeMessageStatus(message.status) || (direction === 'inbound' ? 'delivered' : 'sent')
  const rawPayload = safeJsonStringify({ provider: 'highlevel', source: 'conversations_sync', message })
  const items = attachments.length ? attachments : [null]

  if (channel.table === 'email') {
    const fromEmail = pickEmailAddress(
      message.fromEmail,
      message.from_email,
      message.from,
      message.sender,
      direction === 'inbound' ? contact?.email : ''
    )
    const toEmail = pickEmailAddress(
      message.toEmail,
      message.to_email,
      message.to,
      message.recipient,
      message.recipients?.[0],
      direction === 'outbound' ? contact?.email : ''
    )

    return {
      table: 'email',
      rows: [[
        hashId('ghl_email_msg', `${remoteMessageId}:0`),
        contact.id,
        direction,
        status,
        toEmail || null,
        fromEmail || null,
        fromEmail || null,
        getEmailSubject(message),
        text,
        messageTimestamp,
        rawPayload
      ]]
    }
  }

  if (channel.table === 'meta') {
    return {
      table: 'meta',
      rows: items.map((attachmentUrl, index) => [
        hashId('ghl_meta_msg', `${remoteMessageId}:${index}`),
        channel.platform,
        remoteMessageId,
        null,
        contact.id,
        null,
        null,
        null,
        null,
        direction,
        status,
        attachmentUrl ? inferAttachmentMessageType(attachmentUrl) : 'message',
        index === 0 ? text : '',
        attachmentUrl || null,
        messageTimestamp,
        rawPayload
      ])
    }
  }

  const contactPhone = cleanString(contact?.phone)
  return {
    table: 'whatsapp',
    rows: items.map((attachmentUrl, index) => [
      hashId('ghl_msg', `${remoteMessageId}:${index}`),
      remoteMessageId,
      contact.id,
      contactPhone || null,
      direction === 'inbound' ? (contactPhone || null) : null,
      direction === 'inbound' ? null : (contactPhone || null),
      channel.transport,
      direction,
      attachmentUrl ? inferAttachmentMessageType(attachmentUrl) : 'text',
      index === 0 ? text : '',
      attachmentUrl || null,
      status,
      messageTimestamp,
      rawPayload
    ])
  }
}

async function bulkUpsertHistoricalWhatsAppRows(rows = []) {
  for (const chunk of chunkRows(rows)) {
    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, ycloud_message_id, contact_id, phone, from_phone, to_phone,
        transport, direction, message_type, message_text, media_url,
        status, message_timestamp, raw_payload_json, updated_at
      ) VALUES ${createValuesSql(chunk.length, 14)}
      ON CONFLICT(id) DO UPDATE SET
        ycloud_message_id = COALESCE(NULLIF(excluded.ycloud_message_id, ''), whatsapp_api_messages.ycloud_message_id),
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
        raw_payload_json = excluded.raw_payload_json,
        updated_at = CURRENT_TIMESTAMP
    `, chunk.flat())
  }
}

async function bulkUpsertHistoricalEmailRows(rows = []) {
  for (const chunk of chunkRows(rows)) {
    await db.run(`
      INSERT INTO email_messages (
        id, contact_id, direction, status, to_email, from_email, reply_to,
        subject, message_text, message_timestamp, raw_payload_json, updated_at
      ) VALUES ${createValuesSql(chunk.length, 11)}
      ON CONFLICT(id) DO UPDATE SET
        contact_id = COALESCE(excluded.contact_id, email_messages.contact_id),
        direction = COALESCE(NULLIF(excluded.direction, ''), email_messages.direction),
        status = COALESCE(NULLIF(excluded.status, ''), email_messages.status),
        to_email = COALESCE(NULLIF(excluded.to_email, ''), email_messages.to_email),
        from_email = COALESCE(NULLIF(excluded.from_email, ''), email_messages.from_email),
        reply_to = COALESCE(NULLIF(excluded.reply_to, ''), email_messages.reply_to),
        subject = COALESCE(NULLIF(excluded.subject, ''), email_messages.subject),
        message_text = COALESCE(NULLIF(excluded.message_text, ''), email_messages.message_text),
        message_timestamp = COALESCE(excluded.message_timestamp, email_messages.message_timestamp),
        raw_payload_json = excluded.raw_payload_json,
        updated_at = CURRENT_TIMESTAMP
    `, chunk.flat())
  }
}

async function bulkUpsertHistoricalMetaRows(rows = []) {
  for (const chunk of chunkRows(rows)) {
    await db.run(`
      INSERT INTO meta_social_messages (
        id, platform, meta_message_id, meta_social_contact_id, contact_id,
        sender_id, recipient_id, page_id, instagram_account_id,
        direction, status, message_type, message_text, media_url,
        message_timestamp, raw_payload_json, updated_at
      ) VALUES ${createValuesSql(chunk.length, 16)}
      ON CONFLICT(id) DO UPDATE SET
        meta_message_id = COALESCE(NULLIF(excluded.meta_message_id, ''), meta_social_messages.meta_message_id),
        meta_social_contact_id = COALESCE(excluded.meta_social_contact_id, meta_social_messages.meta_social_contact_id),
        contact_id = COALESCE(excluded.contact_id, meta_social_messages.contact_id),
        direction = COALESCE(NULLIF(excluded.direction, ''), meta_social_messages.direction),
        status = COALESCE(NULLIF(excluded.status, ''), meta_social_messages.status),
        message_type = COALESCE(NULLIF(excluded.message_type, ''), meta_social_messages.message_type),
        message_text = COALESCE(NULLIF(excluded.message_text, ''), meta_social_messages.message_text),
        media_url = COALESCE(NULLIF(excluded.media_url, ''), meta_social_messages.media_url),
        message_timestamp = COALESCE(excluded.message_timestamp, meta_social_messages.message_timestamp),
        raw_payload_json = excluded.raw_payload_json,
        updated_at = CURRENT_TIMESTAMP
    `, chunk.flat())
  }
}

async function importHighLevelHistoricalMessageBatch({
  messages,
  apiToken,
  locationId,
  stats,
  contactCache
}) {
  const rowsByTable = {
    whatsapp: [],
    meta: [],
    email: []
  }

  for (const message of messages) {
    stats.total++
    try {
      const channel = resolveHighLevelMessageChannel(message)
      if (!channel) {
        stats.skipped++
        continue
      }

      const direction = normalizeDirection(message.direction) || 'inbound'
      const contactId = cleanString(message.contactId || message.contact_id || message.contact?.id)
      if (!contactId) {
        stats.skipped++
        continue
      }

      if (!getMessageBody(message) && !getEmailSubject(message) && getMessageAttachments(message).length === 0) {
        stats.skipped++
        continue
      }

      const { contact, created } = await ensureLocalContact({ contactId, apiToken, locationId, contactCache })
      if (!contact) {
        stats.skipped++
        continue
      }

      const prepared = prepareHistoricalMessageRows({ message, contact, channel, direction })
      if (!prepared.rows?.length || !rowsByTable[prepared.table]) {
        stats.skipped++
        continue
      }

      rowsByTable[prepared.table].push(...prepared.rows)
      stats.saved++
      if (created) stats.contactsCreated++
    } catch (error) {
      stats.skipped++
      stats.failedMessages++
      recordFailedMessageTimestamp(stats, message)
      logger.error(`[GHL Conversations] No se pudo preparar mensaje histórico ${getRemoteMessageId(message) || 'sin_id'}: ${error.message}`)
    }
  }

  try {
    await bulkUpsertHistoricalWhatsAppRows(rowsByTable.whatsapp)
    await bulkUpsertHistoricalMetaRows(rowsByTable.meta)
    await bulkUpsertHistoricalEmailRows(rowsByTable.email)
  } catch (error) {
    stats.incomplete = true
    stats.incompleteReason = stats.incompleteReason || 'historical_bulk_upsert_failed'
    throw error
  }
}

async function syncConversationMessagesByExport({
  client,
  apiToken,
  locationId,
  startDate,
  notifyNewInbound,
  onProgress
}) {
  const stats = createSyncStats('export')
  let cursor = null
  const seenCursors = new Set()
  let exhaustedPageLimit = true
  const contactCache = new Map()

  while (stats.pages < MAX_EXPORT_PAGES) {
    stats.pages++
    const response = await client.exportConversationMessages({
      limit: EXPORT_PAGE_LIMIT,
      sortBy: 'createdAt',
      sortOrder: 'desc',
      ...(startDate && { startDate }),
      ...(cursor && { cursor })
    })

    const messages = extractExportMessages(response)
    if (!messages.length) {
      exhaustedPageLimit = false
      break
    }

    await importHighLevelMessageBatch({
      messages,
      apiToken,
      locationId,
      notifyNewInbound,
      stats,
      contactCache
    })

    if (onProgress) {
      const totalKnown = Number(response.total || response.totalCount || 0) || stats.total
      onProgress(stats.saved, Math.max(totalKnown, stats.total), `Importando chats: ${stats.saved} mensajes guardados`)
    }

    const nextCursor = extractExportCursor(response)
    if (!nextCursor) {
      exhaustedPageLimit = false
      break
    }
    if (seenCursors.has(nextCursor)) {
      stats.incomplete = true
      stats.incompleteReason = 'repeated_export_cursor'
      logger.warn(`[GHL Conversations] HighLevel repitió el cursor de export (${nextCursor}); se conserva el checkpoint anterior`)
      break
    }

    seenCursors.add(nextCursor)
    cursor = nextCursor
  }

  if (exhaustedPageLimit && stats.pages >= MAX_EXPORT_PAGES && !stats.incomplete) {
    stats.incomplete = true
    stats.incompleteReason = 'export_page_limit'
    logger.warn(`[GHL Conversations] Export alcanzó el límite de ${MAX_EXPORT_PAGES} páginas; se conserva el checkpoint anterior`)
  }

  return stats
}

async function listHighLevelConversationsForBackfill({ client, onProgress }) {
  const conversationsById = new Map()
  const seenPageKeys = new Set()
  let startAfterDate = null
  let totalKnown = 0
  let pages = 0
  let exhaustedPageLimit = true

  while (pages < MAX_CONVERSATION_SEARCH_PAGES) {
    pages++
    const response = await client.searchConversations({
      limit: CONVERSATION_SEARCH_PAGE_LIMIT,
      sort: 'desc',
      sortBy: 'last_message_date',
      status: 'all',
      ...(startAfterDate && { startAfterDate })
    })

    const rows = extractConversationRows(response)
    if (!totalKnown) totalKnown = extractConversationSearchTotal(response)
    if (!rows.length) {
      exhaustedPageLimit = false
      break
    }

    const pageKey = rows.map(getConversationId).join('|')
    if (seenPageKeys.has(pageKey)) {
      throw new Error('HighLevel repitió una página de conversaciones durante el backfill')
    }
    seenPageKeys.add(pageKey)

    for (const row of rows) {
      const conversationId = getConversationId(row)
      if (conversationId && !conversationsById.has(conversationId)) {
        conversationsById.set(conversationId, row)
      }
    }

    if (onProgress) {
      onProgress(
        0,
        Math.max(totalKnown, conversationsById.size),
        `Leyendo conversaciones de HighLevel: ${conversationsById.size} encontradas`
      )
    }

    if (totalKnown && conversationsById.size >= totalKnown) {
      exhaustedPageLimit = false
      break
    }

    const nextStartAfterDate = getConversationSearchCursor(rows.at(-1))
    if (!nextStartAfterDate || nextStartAfterDate === startAfterDate) {
      throw new Error('HighLevel no devolvió un cursor válido de conversaciones')
    }
    startAfterDate = nextStartAfterDate
  }

  if (exhaustedPageLimit && pages >= MAX_CONVERSATION_SEARCH_PAGES) {
    throw new Error(`Backfill de conversaciones alcanzó el límite de ${MAX_CONVERSATION_SEARCH_PAGES} páginas`)
  }

  return {
    conversations: [...conversationsById.values()],
    totalKnown,
    pages
  }
}

async function syncConversationMessagesByConversation({
  client,
  apiToken,
  locationId,
  notifyNewInbound,
  onProgress
}) {
  const stats = createSyncStats('conversation_backfill')
  const contactCache = new Map()
  const {
    conversations,
    totalKnown,
    pages: conversationPages
  } = await listHighLevelConversationsForBackfill({ client, onProgress })

  stats.conversations = conversations.length
  stats.conversationSearchPages = conversationPages
  stats.totalKnownConversations = totalKnown || conversations.length

  for (const conversation of conversations) {
    const conversationId = getConversationId(conversation)
    stats.conversationsProcessed++
    if (!conversationId) {
      stats.skipped++
      continue
    }

    let lastMessageId = null
    const seenMessageCursors = new Set()
    let messagePages = 0
    let exhaustedMessagePageLimit = true

    while (messagePages < MAX_CONVERSATION_MESSAGE_PAGES) {
      messagePages++
      stats.pages++

      let response
      try {
        response = await client.getConversationMessages(conversationId, {
          limit: CONVERSATION_MESSAGES_PAGE_LIMIT,
          ...(lastMessageId && { lastMessageId })
        })
      } catch (error) {
        stats.incomplete = true
        stats.incompleteReason = stats.incompleteReason || 'conversation_messages_request_failed'
        stats.failedConversations++
        logger.error(`[GHL Conversations] No se pudieron leer mensajes de conversación ${conversationId}: ${error.message}`)
        break
      }

      const messages = extractConversationMessages(response)
        .map(message => normalizeConversationMessage(message, conversation))

      if (!messages.length) {
        exhaustedMessagePageLimit = false
        break
      }

      await importHighLevelMessageBatch({
        messages,
        apiToken,
        locationId,
        notifyNewInbound,
        stats,
        contactCache,
        historicalImport: true
      })

      if (onProgress) {
        onProgress(
          stats.saved,
          Math.max(stats.total, stats.saved, stats.totalKnownConversations),
          `Importando chats: ${stats.saved} mensajes guardados (${stats.conversationsProcessed}/${stats.conversations} conversaciones)`
        )
      }

      if (!hasConversationMessagesNextPage(response)) {
        exhaustedMessagePageLimit = false
        break
      }

      const nextLastMessageId = extractConversationMessagesCursor(response, messages)
      if (!nextLastMessageId || seenMessageCursors.has(nextLastMessageId)) {
        stats.incomplete = true
        stats.incompleteReason = stats.incompleteReason || 'repeated_conversation_message_cursor'
        stats.failedConversations++
        logger.warn(`[GHL Conversations] HighLevel repitió cursor de mensajes en conversación ${conversationId}; se conserva el checkpoint anterior`)
        break
      }

      seenMessageCursors.add(nextLastMessageId)
      lastMessageId = nextLastMessageId
    }

    if (exhaustedMessagePageLimit && messagePages >= MAX_CONVERSATION_MESSAGE_PAGES) {
      stats.incomplete = true
      stats.incompleteReason = stats.incompleteReason || 'conversation_message_page_limit'
      stats.failedConversations++
      logger.warn(`[GHL Conversations] Conversación ${conversationId} alcanzó el límite de ${MAX_CONVERSATION_MESSAGE_PAGES} páginas`)
    }
  }

  return stats
}

/**
 * Mide barato el tamaño probable de la sincronización antes de importar.
 * - Backfill: HighLevel solo nos da total de conversaciones.
 * - Incremental: messages/export sí reporta total de mensajes.
 */
export async function estimateHighLevelConversationSyncVolume({
  locationId,
  apiToken,
  fullSync = false
} = {}) {
  if (!locationId || !apiToken) {
    throw new Error('Se requieren locationId y apiToken para estimar conversaciones')
  }

  const client = new GHLClient(apiToken, locationId)
  let lastSyncedAt = null
  let startDate = null

  if (!fullSync) {
    lastSyncedAt = parseTimestampToIso(await getAppConfig(LAST_SYNC_CONFIG_KEY).catch(() => null))
    startDate = buildIncrementalStartDate(lastSyncedAt)
  }

  const useConversationBackfill = fullSync || !lastSyncedAt
  if (useConversationBackfill) {
    const response = await client.searchConversations({
      limit: 1,
      sort: 'desc',
      sortBy: 'last_message_date',
      status: 'all'
    })
    const rows = extractConversationRows(response)
    return {
      total: extractConversationSearchTotal(response) || rows.length,
      unit: 'conversations',
      strategy: 'conversation_backfill',
      useConversationBackfill: true,
      startDate: null,
      estimated: true
    }
  }

  const response = await client.exportConversationMessages({
    limit: 1,
    sortBy: 'createdAt',
    sortOrder: 'desc',
    startDate
  })
  const messages = extractExportMessages(response)
  return {
    total: extractExportTotal(response) || messages.length,
    unit: 'messages',
    strategy: 'export',
    useConversationBackfill: false,
    startDate,
    estimated: true
  }
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
    let lastSyncedAt = null
    if (!fullSync) {
      lastSyncedAt = parseTimestampToIso(await getAppConfig(LAST_SYNC_CONFIG_KEY).catch(() => null))
      if (lastSyncedAt) {
        startDate = buildIncrementalStartDate(lastSyncedAt)
      }
    }

    const useConversationBackfill = fullSync || !lastSyncedAt
    logger.info(
      `[GHL Conversations] Importando historial de chats desde HighLevel` +
      (useConversationBackfill
        ? ' (backfill por conversaciones)'
        : ` (incremental desde ${startDate})`) +
      '...'
    )

    const result = useConversationBackfill
      ? await syncConversationMessagesByConversation({
          client,
          apiToken,
          locationId,
          notifyNewInbound,
          onProgress
        })
      : await syncConversationMessagesByExport({
          client,
          apiToken,
          locationId,
          startDate,
          notifyNewInbound,
          onProgress
        })

    // (GHL-006) Avanzar el checkpoint SOLO hasta donde el guardado fue confiable.
    // Si todo se guardó OK (sin errores reales), el checkpoint llega hasta startedAt.
    // Si hubo mensajes que fallaron al persistir, NO avanzamos más allá del más
    // antiguo de ellos: dejamos el checkpoint justo antes (menos el overlap habitual)
    // para que el siguiente ciclo vuelva a traer y reintentar ese rango.
    let checkpointUpdated = false
    let checkpoint = lastSyncedAt || null
    if (result.incomplete && result.oldestFailedMs === null) {
      logger.warn(
        `[GHL Conversations] ⚠️ Sync incompleta (${result.incompleteReason || 'sin razón'}); ` +
        'checkpoint conservado para no perder historial'
      )
    } else {
      checkpoint = startedAt
    }

    if (!result.incomplete || result.oldestFailedMs !== null) {
      if (result.oldestFailedMs !== null) {
        const safeMs = result.oldestFailedMs - INCREMENTAL_OVERLAP_MS
        const previousCheckpointMs = parseTimestampMs(startDate) // límite inferior de esta corrida
        // No retroceder por debajo del inicio de esta ventana: solo recortar el avance.
        const boundedMs = previousCheckpointMs !== null ? Math.max(safeMs, previousCheckpointMs) : safeMs
        checkpoint = new Date(boundedMs).toISOString()
        logger.warn(
          `[GHL Conversations] ⚠️ Hubo mensajes que no se pudieron guardar; ` +
          `checkpoint no avanza más allá de ${checkpoint} (en vez de ${startedAt}) para reintentar en el próximo ciclo`
        )
      }

      await setAppConfig(LAST_SYNC_CONFIG_KEY, checkpoint)
      checkpointUpdated = true
    }

    logger.info(
      `[GHL Conversations] ✅ ${result.saved} mensajes sincronizados ` +
      `(${result.skipped} omitidos, ${result.contactsCreated} contactos creados, estrategia=${result.strategy})`
    )

    return { ...result, checkpoint, checkpointUpdated }
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

  const body = getMessageBody(messageSource) || getMessageBody(payload)
  const direction = messageSource.direction || payload.direction || 'inbound'
  const messageType = messageSource.messageType || messageSource.type || payload.messageType || payload.type || payload.channel
  const attachments = Array.isArray(messageSource.attachments)
    ? messageSource.attachments
    : Array.isArray(payload.attachments)
      ? payload.attachments
      : []
  const dateAdded = messageSource.dateAdded ||
    messageSource.date_added ||
    messageSource.createdAt ||
    messageSource.created_at ||
    messageSource.timestamp ||
    payload.dateAdded ||
    payload.date_added ||
    payload.createdAt ||
    payload.created_at ||
    payload.timestamp ||
    new Date().toISOString()

  const message = {
    id: getRemoteMessageId(messageSource) || getRemoteMessageId(payload) ||
      buildHighLevelWebhookFallbackMessageId({ contactId, body, messageType, direction, attachments, timestamp: dateAdded }),
    contactId,
    body,
    direction,
    messageType,
    status: messageSource.status || payload.status,
    attachments,
    dateAdded
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
