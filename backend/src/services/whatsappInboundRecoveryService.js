import { db } from '../config/database.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { extractWhatsAppProviderError } from '../utils/whatsappProviderError.js'
import { parseStoredUtcDateTime } from '../utils/dateUtils.js'
import { withConversationalInboundCommitLock } from './conversationalInboundCommitLockService.js'
import { isWhatsAppProviderContentUnavailable } from './whatsappMessageContentService.js'

const BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const BACKUP_LIMIT_PER_PHONE = 1000
const clean = value => String(value ?? '').trim()
const phone = value => normalizePhoneForStorage(value) || ''
const parse = value => {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}

// Buffer.toJSON y Uint8Array no comparten representación. Usamos el formato
// BufferJSON de Baileys para poder descargar media después de un reinicio.
function serializeQrBackup(value) {
  return JSON.stringify(value, (_key, node) => {
    if (node?.type === 'Buffer' && typeof node.data === 'string') return node
    if (Buffer.isBuffer(node) || node instanceof Uint8Array || node?.type === 'Buffer') {
      return { type: 'Buffer', data: Buffer.from(node?.data || node).toString('base64') }
    }
    return node
  })
}

export function isUnavailableWhatsAppInbound(row = {}) {
  return Boolean(row) && clean(row.direction).toLowerCase() === 'inbound' &&
    clean(row.transport).toLowerCase() === 'api' &&
    row.status !== 'removed' &&
    isWhatsAppProviderContentUnavailable({
      messageType: row.message_type,
      errorCode: row.error_code,
      errorMessage: row.error_message
    })
}

function backupMatchesMessage(backup, row) {
  return backup && clean(backup.phone_number_id) === clean(row.business_phone_number_id) &&
    clean(backup.protocol_message_key_id) === clean(row.protocol_message_key_id) &&
    phone(backup.business_phone) === phone(row.business_phone) &&
    phone(backup.contact_phone) === phone(row.phone)
}

// La copia QR no es un segundo mensaje ni tiene efectos de negocio. Se conserva
// brevemente para cubrir también el orden QR -> webhook y los reinicios.
export async function storeWhatsAppQrInboundBackup({
  phoneNumberId, businessPhone, contactPhone, protocolMessageKeyId,
  messageType, text = '', raw = null, profileName = '', timestamp
} = {}) {
  const id = clean(protocolMessageKeyId)
  const type = clean(messageType).toLowerCase()
  const business = phone(businessPhone)
  const customer = phone(contactPhone)
  if (!clean(phoneNumberId) || !id || !type || !business || !customer ||
    isWhatsAppProviderContentUnavailable({ messageType: type }) ||
    ['edit', 'system', 'status', 'revoke'].includes(type) ||
    (type === 'text' && !clean(text)) || raw?.key?.fromMe === true ||
    (clean(raw?.key?.id) && clean(raw.key.id) !== id)) return null

  const now = Date.now()
  const content = { type, text: clean(text), qrRaw: raw, profileName: clean(profileName), timestamp }
  const contentJson = serializeQrBackup(content)
  if (Buffer.byteLength(contentJson, 'utf8') > 512 * 1024) return null
  await db.run(`
    INSERT INTO whatsapp_qr_inbound_backups (
      phone_number_id, protocol_message_key_id, business_phone, contact_phone,
      content_json, received_at_ms, expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(phone_number_id, protocol_message_key_id, contact_phone) DO UPDATE SET
      content_json = excluded.content_json,
      received_at_ms = excluded.received_at_ms,
      expires_at_ms = excluded.expires_at_ms
    WHERE whatsapp_qr_inbound_backups.business_phone = excluded.business_phone
  `, [clean(phoneNumberId), id, business, customer, contentJson, now, now + BACKUP_RETENTION_MS])
  await db.run(`
    DELETE FROM whatsapp_qr_inbound_backups
    WHERE phone_number_id = ? AND (
      expires_at_ms <= ? OR (protocol_message_key_id, contact_phone) IN (
        SELECT protocol_message_key_id, contact_phone FROM whatsapp_qr_inbound_backups
        WHERE phone_number_id = ?
        ORDER BY received_at_ms DESC, protocol_message_key_id DESC, contact_phone DESC
        LIMIT 1000 OFFSET ?
      )
    )
  `, [clean(phoneNumberId), now, clean(phoneNumberId), BACKUP_LIMIT_PER_PHONE])
  return getWhatsAppQrInboundBackup({
    business_phone_number_id: phoneNumberId, protocol_message_key_id: id,
    business_phone: business, phone: customer
  })
}

export async function getWhatsAppQrInboundBackup(row = {}) {
  if (!clean(row.business_phone_number_id) || !clean(row.protocol_message_key_id)) return null
  const backup = await db.get(`
    SELECT * FROM whatsapp_qr_inbound_backups
    WHERE phone_number_id = ? AND protocol_message_key_id = ? AND contact_phone = ?
      AND expires_at_ms > ?
  `, [row.business_phone_number_id, row.protocol_message_key_id, phone(row.phone), Date.now()])
  return backupMatchesMessage(backup, row) ? { ...backup, content: parse(backup.content_json) } : null
}

export async function findUnavailableWhatsAppInboundForBackup(backup = {}) {
  const row = await db.get(`
    SELECT * FROM whatsapp_api_messages
    WHERE business_phone_number_id = ? AND protocol_message_key_id = ?
      AND phone = ? AND business_phone = ? AND direction = 'inbound' AND transport = 'api'
    LIMIT 1
  `, [backup.phone_number_id, backup.protocol_message_key_id, backup.contact_phone, backup.business_phone])
  return isUnavailableWhatsAppInbound(row) && backupMatchesMessage(backup, row) ? row : null
}

function recoveredPayload(original, backup, media = {}) {
  const next = { ...original }
  const content = backup.content || parse(backup.content_json)
  for (const key of ['errors', 'error', 'errorCode', 'errorMessage', 'whatsappApiError', 'unsupported']) delete next[key]
  next.type = content.type
  delete next.text
  if (content.text) next.text = { body: content.text }
  next.qrRaw = content.qrRaw
  for (const key of ['location', 'reaction', 'context']) {
    if (content.qrRaw?.[key]) next[key] = content.qrRaw[key]
  }
  if (media.mediaUrl) {
    const type = content.type === 'gif' ? 'video' : content.type
    next[type] = {
      link: media.mediaUrl, mimeType: media.mediaMimeType,
      filename: media.mediaFilename, durationMs: media.mediaDurationMs,
      ...(content.qrRaw?.message?.audioMessage?.ptt ? { voice: true } : {})
    }
  }
  next.qrInboundRecovery = {
    sourceAdapter: 'baileys', protocolMessageKeyId: backup.protocol_message_key_id,
    phoneNumberId: backup.phone_number_id, originalPayload: original
  }
  return next
}

// Un retry oficial sin contenido nunca puede borrar una recuperación exacta.
export function preserveRecoveredWhatsAppInboundPayload(message, existingRow, { businessPhone, contactPhone } = {}) {
  const error = extractWhatsAppProviderError(message)
  const stored = parse(existingRow?.raw_payload_json)
  if (!stored.qrInboundRecovery || existingRow?.direction !== 'inbound' ||
    existingRow.status === 'removed' ||
    phone(existingRow.business_phone) !== phone(businessPhone) ||
    phone(existingRow.phone) !== phone(contactPhone) ||
    !isWhatsAppProviderContentUnavailable({ messageType: message.type, errorCode: error.code, errorMessage: error.message })) return message
  const next = { ...message }
  for (const key of ['errors', 'error', 'errorCode', 'errorMessage', 'whatsappApiError', 'unsupported', 'text']) delete next[key]
  for (const key of ['type', 'text', 'qrRaw', 'qrInboundRecovery', 'location', 'reaction', 'context', 'image', 'video', 'audio', 'document', 'sticker']) {
    if (stored[key] !== undefined) next[key] = stored[key]
  }
  return next
}

// Sólo enriquece la fila oficial existente. No cambia su ID, hora, contacto,
// proveedor, transporte, claim de unread ni las referencias del historial.
export async function recoverWhatsAppInboundFromQrBackup({ messageId, backup = null, media = null, triggerSideEffects = false } = {}) {
  const initial = await db.get('SELECT * FROM whatsapp_api_messages WHERE id = ?', [clean(messageId)])
  if (!isUnavailableWhatsAppInbound(initial)) return { changed: false }
  const copy = backup || await getWhatsAppQrInboundBackup(initial)
  if (!backupMatchesMessage(copy, initial) || Number(copy.expires_at_ms) <= Date.now()) return { changed: false }
  const content = copy.content || parse(copy.content_json)
  if (!content.type || isWhatsAppProviderContentUnavailable({ messageType: content.type })) return { changed: false }
  return withConversationalInboundCommitLock({ contactId: initial.contact_id, channel: 'whatsapp' }, async tx => {
    const row = await tx.get('SELECT * FROM whatsapp_api_messages WHERE id = ?', [initial.id])
    if (!isUnavailableWhatsAppInbound(row) || !backupMatchesMessage(copy, row)) return { changed: false }
    const raw = recoveredPayload(parse(row.raw_payload_json), copy, media || {})
    const result = await tx.run(`
      UPDATE whatsapp_api_messages SET message_type = ?, message_text = ?,
        media_url = COALESCE(NULLIF(?, ''), media_url),
        media_mime_type = COALESCE(NULLIF(?, ''), media_mime_type),
        media_filename = COALESCE(NULLIF(?, ''), media_filename),
        media_duration_ms = COALESCE(?, media_duration_ms),
        context_json = COALESCE(?, context_json), raw_payload_json = ?,
        error_code = NULL, error_message = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND COALESCE(status, '') != 'removed' AND raw_payload_json = ?
    `, [content.type, content.text || null, media?.mediaUrl || '', media?.mediaMimeType || '',
      media?.mediaFilename || '', media?.mediaDurationMs || null,
      content.qrRaw?.context ? JSON.stringify(content.qrRaw.context) : null,
      JSON.stringify(raw), row.id, row.raw_payload_json])
    if (Number(result?.changes || 0) !== 1) return { changed: false }
    // Si el push aún no ha salido, su contenido también debe ser el recuperado.
    const jobs = await tx.all("SELECT id, payload_json FROM chat_delivery_outbox WHERE message_id = ? AND job_kind = 'push' AND status = 'pending'", [row.id])
    for (const job of jobs) {
      await tx.run("UPDATE chat_delivery_outbox SET payload_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'", [
        JSON.stringify({ ...parse(job.payload_json), text: content.text || '', messageType: content.type,
          ...(media?.mediaUrl ? { mediaUrl: media.mediaUrl, mediaFilename: media.mediaFilename || '' } : {}) }), job.id
      ])
    }
    const effectClaim = triggerSideEffects ? await tx.run(`
      UPDATE whatsapp_qr_inbound_backups SET business_effects_claimed = 1
      WHERE phone_number_id = ? AND protocol_message_key_id = ? AND contact_phone = ?
        AND business_effects_claimed = 0
    `, [copy.phone_number_id, copy.protocol_message_key_id, copy.contact_phone]) : null
    return { changed: true, shouldTriggerBusinessEffects: Number(effectClaim?.changes || 0) === 1,
      row: await tx.get('SELECT * FROM whatsapp_api_messages WHERE id = ?', [row.id]) }
  })
}

export async function getUnavailableWhatsAppInboundsForQrRecovery({ phoneNumberId, businessPhone, limit = 20 } = {}) {
  const since = new Date(Date.now() - BACKUP_RETENTION_MS).toISOString()
  const rows = await db.all(`
    SELECT * FROM whatsapp_api_messages
    WHERE business_phone_number_id = ? AND business_phone = ?
      AND direction = 'inbound' AND transport = 'api'
      AND COALESCE(status, '') != 'removed' AND COALESCE(hidden_from_chat, 0) = 0
      AND (message_type IN ('unsupported', 'unknown', 'unavailable') OR error_code IN ('131051', '131060'))
      AND message_timestamp >= ?
    ORDER BY message_timestamp DESC, id DESC LIMIT ?
  `, [clean(phoneNumberId), phone(businessPhone), since, Math.max(1, Math.min(Number(limit) || 20, 50))])
  return rows.filter(row => isUnavailableWhatsAppInbound(row) && clean(row.protocol_message_key_id) &&
    parseStoredUtcDateTime(row.message_timestamp)?.isValid)
}
