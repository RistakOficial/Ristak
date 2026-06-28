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
const WEBHOOK_FALLBACK_ID_BUCKET_MS = 60 * 1000
const HIGHLEVEL_DUPLICATE_WINDOW_MS = 90 * 1000
const HIGHLEVEL_WEBHOOK_FALLBACK_ID_PREFIX = 'ghl_wh_'

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
async function ensureLocalContact({ contactId, apiToken, locationId }) {
  if (!cleanString(contactId)) return { contact: null, created: false }

  const { resolveContactIdByGhlId } = await import('./contactIdentityService.js')
  const resolvedId = await resolveContactIdByGhlId(contactId)
  if (resolvedId) {
    const contact = await getLocalContact(resolvedId)
    if (contact) return { contact, created: false }
  }

  const { ensureContactExists } = await import('./highlevelSyncService.js')
  const usePostgres = Boolean(process.env.DATABASE_URL)
  const ensured = await ensureContactExists(contactId, apiToken, usePostgres, locationId)
  const contact = ensured.localContactId ? await getLocalContact(ensured.localContactId) : null
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
  notifyNewInbound = false
}) {
  const channel = resolveHighLevelMessageChannel(message)
  if (!channel) return { saved: 0, skipped: true, reason: 'channel_not_supported' }

  const direction = normalizeDirection(message.direction) || 'inbound'
  const contactId = cleanString(message.contactId || message.contact_id || message.contact?.id)
  if (!contactId) return { saved: 0, skipped: true, reason: 'missing_contact' }

  if (!getMessageBody(message) && !getEmailSubject(message) && getMessageAttachments(message).length === 0) {
    return { saved: 0, skipped: true, reason: 'empty_message' }
  }

  const { contact, created } = await ensureLocalContact({ contactId, apiToken, locationId })
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
    // (GHL-006) Rastrear el mensaje MÁS ANTIGUO que NO se pudo persistir (error de
    // guardado). El checkpoint se usa como startDate (límite inferior) de la próxima
    // sync; si avanzamos más allá de un mensaje perdido, ese mensaje nunca se
    // reintenta. Por eso, si hubo fallos, NO avanzamos el checkpoint más allá del
    // mensaje fallido más antiguo: lo dejamos justo antes para que el próximo ciclo
    // lo vuelva a traer. Solo errores reales de guardado cuentan, no los 'skipped'
    // legítimos (canal no soportado, mensaje vacío, etc.).
    let oldestFailedMs = null

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
          // (GHL-006) Error real de guardado: registrar el timestamp del mensaje
          // perdido para no avanzar el checkpoint por encima de él.
          const failedMs = parseTimestampMs(
            message.dateAdded || message.date_added || message.createdAt || message.created_at || message.dateUpdated
          )
          if (failedMs !== null && (oldestFailedMs === null || failedMs < oldestFailedMs)) {
            oldestFailedMs = failedMs
          }
          logger.error(`[GHL Conversations] No se pudo guardar mensaje ${getRemoteMessageId(message) || 'sin_id'}: ${error.message}`)
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

    // (GHL-006) Avanzar el checkpoint SOLO hasta donde el guardado fue confiable.
    // Si todo se guardó OK (sin errores reales), el checkpoint llega hasta startedAt.
    // Si hubo mensajes que fallaron al persistir, NO avanzamos más allá del más
    // antiguo de ellos: dejamos el checkpoint justo antes (menos el overlap habitual)
    // para que el siguiente ciclo vuelva a traer y reintentar ese rango.
    let checkpoint = startedAt
    if (oldestFailedMs !== null) {
      const safeMs = oldestFailedMs - INCREMENTAL_OVERLAP_MS
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
