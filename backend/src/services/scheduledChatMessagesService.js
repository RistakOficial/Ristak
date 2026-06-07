import crypto from 'crypto'
import { db } from '../config/database.js'
import { sendHighLevelConversationMessageCore } from '../controllers/highlevelController.js'
import { sendWhatsAppApiTextMessage } from './whatsappApiService.js'
import { logger } from '../utils/logger.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'

const DISPATCH_BATCH_SIZE = 20
const STALE_SENDING_MS = 10 * 60 * 1000
const MIN_SCHEDULE_DELAY_MS = 10 * 1000

const HIGHLEVEL_TRANSPORT_BY_CHANNEL = {
  whatsapp_api: 'ghl_whatsapp',
  sms_qr: 'ghl_sms',
  messenger: 'ghl_messenger',
  instagram: 'ghl_instagram'
}

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return JSON.stringify({ unserializable: true })
  }
}

function createServiceError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function nowIso() {
  return new Date().toISOString()
}

function createScheduledMessageId() {
  return `scheduled_chat_${crypto.randomUUID()}`
}

function parseScheduledDate(value) {
  const date = new Date(cleanString(value))
  if (Number.isNaN(date.getTime())) {
    throw createServiceError('Elige una fecha y hora válidas para programar el mensaje.')
  }

  if (date.getTime() < Date.now() + MIN_SCHEDULE_DELAY_MS) {
    throw createServiceError('Elige una hora futura para programar el mensaje.')
  }

  return date.toISOString()
}

function normalizeProvider(value = '') {
  const normalized = cleanString(value).toLowerCase().replace(/[\s-]+/g, '_')
  return normalized === 'highlevel' ? 'highlevel' : 'whatsapp_api'
}

function normalizeHighLevelChannel(value = '') {
  const normalized = cleanString(value).toLowerCase().replace(/[\s-]+/g, '_')
  if (['sms', 'sms_qr', 'qr', 'whatsapp_qr', 'ghl_sms'].includes(normalized)) return 'sms_qr'
  if (['messenger', 'facebook', 'fb', 'ghl_messenger'].includes(normalized)) return 'messenger'
  if (['instagram', 'ig', 'ghl_instagram'].includes(normalized)) return 'instagram'
  return 'whatsapp_api'
}

function normalizeWhatsappTransport(value = '') {
  return cleanString(value).toLowerCase() === 'qr' ? 'qr' : 'api'
}

function getScheduledTransport(row = {}) {
  if (row.provider === 'highlevel') {
    return cleanString(row.transport) || HIGHLEVEL_TRANSPORT_BY_CHANNEL[row.channel] || 'ghl_whatsapp'
  }

  return normalizeWhatsappTransport(row.transport)
}

function normalizeScheduledMessageRow(row = {}) {
  if (!row) return null
  return {
    id: cleanString(row.id),
    contactId: cleanString(row.contact_id),
    provider: normalizeProvider(row.provider),
    channel: cleanString(row.channel),
    transport: getScheduledTransport(row),
    text: cleanString(row.message_text),
    toPhone: cleanString(row.to_phone),
    fromPhone: cleanString(row.from_phone),
    businessPhoneNumberId: cleanString(row.business_phone_number_id),
    scheduledAt: cleanString(row.scheduled_at),
    status: cleanString(row.status) || 'scheduled',
    externalId: cleanString(row.external_id),
    sentMessageId: cleanString(row.sent_message_id),
    attempts: Number(row.attempts || 0),
    errorMessage: cleanString(row.error_message),
    createdAt: cleanString(row.created_at),
    updatedAt: cleanString(row.updated_at),
    sentAt: cleanString(row.sent_at)
  }
}

async function getContact(contactId) {
  const id = cleanString(contactId)
  if (!id) throw createServiceError('Elige un contacto para programar el mensaje.')

  const contact = await db.get(
    `SELECT id, phone
     FROM contacts
     WHERE id = ?
     LIMIT 1`,
    [id]
  )

  if (!contact) throw createServiceError('Contacto no encontrado.', 404)
  return contact
}

export async function createScheduledChatMessage(payload = {}) {
  const contact = await getContact(payload.contactId)
  const provider = normalizeProvider(payload.provider)
  const text = cleanString(payload.text || payload.message)
  const scheduledAt = parseScheduledDate(payload.scheduledAt)
  const id = cleanString(payload.id) || createScheduledMessageId()
  const externalId = cleanString(payload.externalId) || id

  if (!text) {
    throw createServiceError('Escribe el mensaje que quieres programar.')
  }

  const channel = provider === 'highlevel' ? normalizeHighLevelChannel(payload.channel) : ''
  const transport = provider === 'highlevel'
    ? HIGHLEVEL_TRANSPORT_BY_CHANNEL[channel] || 'ghl_whatsapp'
    : normalizeWhatsappTransport(payload.transport)
  const toPhone = normalizePhoneForStorage(payload.toPhone || contact.phone) || cleanString(payload.toPhone || contact.phone)
  const fromPhone = normalizePhoneForStorage(payload.fromPhone) || cleanString(payload.fromPhone)
  const businessPhoneNumberId = cleanString(payload.businessPhoneNumberId)
  const createdNow = nowIso()

  if (provider === 'whatsapp_api' && !toPhone) {
    throw createServiceError('Este contacto necesita teléfono para programar el mensaje.')
  }

  if (provider === 'whatsapp_api' && !fromPhone) {
    throw createServiceError('Elige el WhatsApp del negocio que mandará el mensaje.')
  }

  if (provider === 'highlevel' && ['whatsapp_api', 'sms_qr'].includes(channel) && !toPhone) {
    throw createServiceError('Este contacto necesita teléfono para programar por WhatsApp o SMS.')
  }

  await db.run(`
    INSERT INTO scheduled_chat_messages (
      id, contact_id, provider, channel, transport, message_text,
      to_phone, from_phone, business_phone_number_id, scheduled_at,
      status, external_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      contact_id = excluded.contact_id,
      provider = excluded.provider,
      channel = excluded.channel,
      transport = excluded.transport,
      message_text = excluded.message_text,
      to_phone = excluded.to_phone,
      from_phone = excluded.from_phone,
      business_phone_number_id = excluded.business_phone_number_id,
      scheduled_at = excluded.scheduled_at,
      status = 'scheduled',
      external_id = excluded.external_id,
      error_message = NULL,
      updated_at = excluded.updated_at
  `, [
    id,
    contact.id,
    provider,
    channel || null,
    transport,
    text,
    toPhone || null,
    fromPhone || null,
    businessPhoneNumberId || null,
    scheduledAt,
    externalId,
    createdNow
  ])

  const row = await db.get('SELECT * FROM scheduled_chat_messages WHERE id = ?', [id])
  return normalizeScheduledMessageRow(row)
}

export async function listScheduledChatMessages({ contactId, statuses = ['scheduled', 'sending', 'error'] } = {}) {
  const id = cleanString(contactId)
  if (!id) return []

  const cleanStatuses = statuses.map(cleanString).filter(Boolean)
  if (cleanStatuses.length === 0) return []

  const placeholders = cleanStatuses.map(() => '?').join(', ')
  const rows = await db.all(
    `SELECT *
     FROM scheduled_chat_messages
     WHERE contact_id = ?
       AND status IN (${placeholders})
     ORDER BY scheduled_at ASC, created_at ASC`,
    [id, ...cleanStatuses]
  )

  return rows.map(normalizeScheduledMessageRow).filter(Boolean)
}

export async function cancelScheduledChatMessage({ id, contactId } = {}) {
  const scheduledId = cleanString(id)
  const cleanContactId = cleanString(contactId)
  if (!scheduledId) {
    throw createServiceError('Elige el mensaje programado que quieres eliminar.')
  }

  const params = [nowIso(), scheduledId]
  let contactClause = ''
  if (cleanContactId) {
    contactClause = 'AND contact_id = ?'
    params.push(cleanContactId)
  }

  const result = await db.run(`
    UPDATE scheduled_chat_messages
    SET status = 'cancelled',
        error_message = NULL,
        updated_at = ?
    WHERE id = ?
      ${contactClause}
      AND status IN ('scheduled', 'error')
  `, params)

  if (Number(result?.changes || 0) === 0) {
    throw createServiceError('No se encontró un mensaje programado que se pueda eliminar.', 404)
  }

  const row = await db.get('SELECT * FROM scheduled_chat_messages WHERE id = ?', [scheduledId])
  return normalizeScheduledMessageRow(row)
}

async function markScheduledMessageStatus(id, patch = {}) {
  const updatedAt = nowIso()
  await db.run(`
    UPDATE scheduled_chat_messages
    SET status = ?,
        sent_message_id = ?,
        error_message = ?,
        raw_payload_json = ?,
        sent_at = ?,
        updated_at = ?
    WHERE id = ?
  `, [
    patch.status,
    patch.sentMessageId || null,
    patch.errorMessage || null,
    patch.rawPayload ? safeJson(patch.rawPayload) : null,
    patch.sentAt || null,
    updatedAt,
    id
  ])
}

async function claimScheduledMessage(id) {
  const updatedAt = nowIso()
  const result = await db.run(`
    UPDATE scheduled_chat_messages
    SET status = 'sending',
        attempts = COALESCE(attempts, 0) + 1,
        last_attempt_at = ?,
        updated_at = ?
    WHERE id = ?
      AND status = 'scheduled'
  `, [updatedAt, updatedAt, id])

  return Number(result?.changes || 0) > 0
}

async function sendScheduledChatMessage(row) {
  if (row.provider === 'highlevel') {
    return sendHighLevelConversationMessageCore({
      contactId: row.contact_id,
      channel: row.channel || 'whatsapp_api',
      message: row.message_text,
      fromNumber: row.from_phone,
      toNumber: row.to_phone,
      externalId: row.external_id || row.id
    })
  }

  return sendWhatsAppApiTextMessage({
    to: row.to_phone,
    from: row.from_phone,
    text: row.message_text,
    externalId: row.external_id || row.id,
    transport: normalizeWhatsappTransport(row.transport),
    phoneNumberId: row.business_phone_number_id
  })
}

async function dispatchScheduledRow(row) {
  const claimed = await claimScheduledMessage(row.id)
  if (!claimed) return { id: row.id, skipped: true }

  try {
    const result = await sendScheduledChatMessage(row)
    await markScheduledMessageStatus(row.id, {
      status: 'sent',
      sentMessageId: cleanString(result?.localMessageId || result?.messageId || result?.id || result?.wamid),
      rawPayload: result,
      sentAt: nowIso()
    })
    return { id: row.id, sent: true }
  } catch (error) {
    await markScheduledMessageStatus(row.id, {
      status: 'error',
      errorMessage: error.message || 'No se pudo enviar el mensaje programado.',
      rawPayload: { error: error.message || String(error) }
    })
    logger.error(`[Mensajes programados] No se pudo enviar ${row.id}: ${error.message}`)
    return { id: row.id, error: error.message || String(error) }
  }
}

export async function dispatchDueScheduledChatMessages({ limit = DISPATCH_BATCH_SIZE } = {}) {
  const staleCutoffMs = Date.now() - STALE_SENDING_MS
  const sendingRows = await db.all(`
    SELECT id, last_attempt_at, updated_at, created_at
    FROM scheduled_chat_messages
    WHERE status = 'sending'
  `).catch(error => {
    logger.warn(`[Mensajes programados] No se pudieron liberar envios atorados: ${error.message}`)
    return []
  })
  const releaseNow = nowIso()

  for (const row of sendingRows) {
    const lastActivity = new Date(row.last_attempt_at || row.updated_at || row.created_at || 0).getTime()
    if (!Number.isFinite(lastActivity) || lastActivity >= staleCutoffMs) continue

    await db.run(`
      UPDATE scheduled_chat_messages
      SET status = 'scheduled',
          updated_at = ?
      WHERE id = ?
        AND status = 'sending'
    `, [releaseNow, row.id]).catch(error => {
      logger.warn(`[Mensajes programados] No se pudo liberar ${row.id}: ${error.message}`)
    })
  }

  const dueRows = await db.all(`
    SELECT *
    FROM scheduled_chat_messages
    WHERE status = 'scheduled'
      AND scheduled_at <= ?
    ORDER BY scheduled_at ASC, created_at ASC
    LIMIT ?
  `, [nowIso(), Number(limit) || DISPATCH_BATCH_SIZE])

  const results = []
  for (const row of dueRows) {
    results.push(await dispatchScheduledRow(row))
  }

  return results
}
