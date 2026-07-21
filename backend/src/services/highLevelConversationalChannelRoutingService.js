import { db } from '../config/database.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'
import {
  parseSortableTimestamp,
  timestampSortExpression,
  timestampSortParameterExpression
} from '../utils/sqlTimestampSort.js'

export const HIGHLEVEL_CONVERSATIONAL_WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000
export const HIGHLEVEL_CONVERSATIONAL_DUPLICATE_WINDOW_MS = 90 * 1000

const HIGHLEVEL_PHONE_TRANSPORT_CHANNELS = new Map([
  ['ghl_whatsapp', 'whatsapp'],
  ['ghl_sms', 'sms']
])
const HIGHLEVEL_PHONE_CHANNELS = new Set(['whatsapp', 'sms'])
const FUTURE_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000

function cleanString(value = '') {
  return String(value || '').trim()
}

export function normalizeHighLevelConversationalPhoneChannel(value = '') {
  const normalized = cleanString(value).toLowerCase().replace(/[\s-]+/g, '_')
  const aliases = {
    whatsapp_api: 'whatsapp',
    ghl_whatsapp: 'whatsapp',
    sms_qr: 'sms',
    ghl_sms: 'sms',
    mms: 'sms'
  }
  const channel = aliases[normalized] || normalized
  return HIGHLEVEL_PHONE_CHANNELS.has(channel) ? channel : null
}

function channelFromTransport(value = '') {
  return HIGHLEVEL_PHONE_TRANSPORT_CHANNELS.get(cleanString(value).toLowerCase()) || null
}

function rowTimestampMs(row = {}) {
  return parseSortableTimestamp(row.message_timestamp || row.created_at)
}

function rowCustomerPhone(row = {}) {
  return normalizePhoneForStorage(row.phone || row.from_phone || '') || cleanString(row.phone || row.from_phone)
}

function normalizeMessageText(value = '') {
  return cleanString(value).replace(/\s+/g, ' ').toLowerCase()
}

function rowsShareSubstantiveContent(left = {}, right = {}) {
  const leftText = normalizeMessageText(left.message_text)
  const rightText = normalizeMessageText(right.message_text)
  if (leftText || rightText) return Boolean(leftText && rightText && leftText === rightText)

  const leftMedia = cleanString(left.media_url)
  const rightMedia = cleanString(right.media_url)
  return Boolean(leftMedia && rightMedia && leftMedia === rightMedia)
}

function rowsShareCustomerPhone(left = {}, right = {}) {
  const leftPhone = rowCustomerPhone(left)
  const rightPhone = rowCustomerPhone(right)
  return Boolean(leftPhone && rightPhone && leftPhone === rightPhone)
}

function isCrossChannelDuplicate(source, candidate) {
  const sourceChannel = channelFromTransport(source?.transport)
  const candidateChannel = channelFromTransport(candidate?.transport)
  if (!sourceChannel || !candidateChannel || sourceChannel === candidateChannel) return false
  if (!rowsShareCustomerPhone(source, candidate)) return false

  const sourceAt = rowTimestampMs(source)
  const candidateAt = rowTimestampMs(candidate)
  if (!sourceAt || !candidateAt) return false
  if (Math.abs(sourceAt - candidateAt) > HIGHLEVEL_CONVERSATIONAL_DUPLICATE_WINDOW_MS) return false

  return rowsShareSubstantiveContent(source, candidate)
}

function newestRow(rows = []) {
  return [...rows].sort((left, right) => {
    const byTimestamp = rowTimestampMs(right) - rowTimestampMs(left)
    if (byTimestamp !== 0) return byTimestamp
    return cleanString(right.id).localeCompare(cleanString(left.id))
  })[0] || null
}

export async function getHighLevelConversationalChannelPreference(contactId) {
  const cleanContactId = cleanString(contactId)
  if (!cleanContactId) return null

  const row = await db.get(`
    SELECT contact_id, channel, selected_at, selected_by_user_id, selection_source
    FROM contact_conversational_channel_preferences
    WHERE contact_id = ?
    LIMIT 1
  `, [cleanContactId]).catch(() => null)
  const channel = normalizeHighLevelConversationalPhoneChannel(row?.channel)
  if (!row || !channel) return null

  return {
    contactId: row.contact_id,
    channel,
    selectedAt: row.selected_at || null,
    selectedByUserId: row.selected_by_user_id || null,
    source: row.selection_source || 'manual'
  }
}

export async function setHighLevelConversationalChannelPreference(contactId, channel, {
  selectedByUserId = null,
  source = 'manual'
} = {}) {
  const cleanContactId = cleanString(contactId)
  const normalizedChannel = normalizeHighLevelConversationalPhoneChannel(channel)
  if (!cleanContactId) throw new TypeError('contactId es obligatorio para guardar el canal conversacional')
  if (!normalizedChannel) {
    const error = new TypeError('El canal conversacional debe ser WhatsApp o SMS')
    error.code = 'INVALID_HIGHLEVEL_CONVERSATIONAL_CHANNEL'
    throw error
  }

  const contact = await db.get('SELECT id FROM contacts WHERE id = ? LIMIT 1', [cleanContactId])
  if (!contact) {
    const error = new Error('Contacto no encontrado')
    error.code = 'CONTACT_NOT_FOUND'
    throw error
  }

  await db.run(`
    INSERT INTO contact_conversational_channel_preferences (
      contact_id, channel, selected_at, selected_by_user_id, selection_source, updated_at
    ) VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(contact_id) DO UPDATE SET
      channel = excluded.channel,
      selected_at = CURRENT_TIMESTAMP,
      selected_by_user_id = excluded.selected_by_user_id,
      selection_source = excluded.selection_source,
      updated_at = CURRENT_TIMESTAMP
  `, [
    cleanContactId,
    normalizedChannel,
    cleanString(selectedByUserId) || null,
    cleanString(source) || 'manual'
  ])

  return getHighLevelConversationalChannelPreference(cleanContactId)
}

async function loadHighLevelPhoneInboundRows(contactId, nowMs) {
  const messageSort = timestampSortExpression('COALESCE(message_timestamp, created_at)')
  const cutoffSort = timestampSortParameterExpression()
  const cutoff = new Date(
    nowMs - HIGHLEVEL_CONVERSATIONAL_WHATSAPP_WINDOW_MS - HIGHLEVEL_CONVERSATIONAL_DUPLICATE_WINDOW_MS
  ).toISOString()

  return db.all(`
    SELECT id, contact_id, phone, from_phone, business_phone, transport,
           message_text, media_url, message_timestamp, created_at
    FROM whatsapp_api_messages
    WHERE contact_id = ?
      AND LOWER(COALESCE(direction, '')) = 'inbound'
      AND LOWER(COALESCE(transport, '')) IN ('ghl_whatsapp', 'ghl_sms')
      AND ${messageSort} >= ${cutoffSort}
    ORDER BY ${messageSort} DESC, id DESC
  `, [contactId, cutoff])
}

/**
 * Decide el único canal de salida para WhatsApp/SMS de HighLevel.
 *
 * - La elección manual del usuario manda.
 * - Sin elección manual, WhatsApp gana mientras exista una ventana real de 24 h.
 * - Fuera de esa ventana, SMS gana.
 * - Si HighLevel materializa el mismo inbound en ambos transportes, sólo la fila
 *   del canal ganador puede despertar al agente. El duplicado actual no abre por
 *   sí mismo una ventana de WhatsApp que ya estaba vencida.
 */
export async function resolveHighLevelConversationalPhoneRoute({
  contactId,
  inboundMessageId,
  inboundChannel = '',
  nowMs = Date.now()
} = {}) {
  const cleanContactId = cleanString(contactId)
  const cleanMessageId = cleanString(inboundMessageId)
  const normalizedInboundChannel = normalizeHighLevelConversationalPhoneChannel(inboundChannel)
  if (!cleanContactId || !cleanMessageId) {
    return {
      applies: false,
      shouldHandle: true,
      sourceChannel: normalizedInboundChannel,
      replyChannel: normalizedInboundChannel,
      reason: 'non_canonical_inbound'
    }
  }

  const source = await db.get(`
    SELECT id, contact_id, phone, from_phone, business_phone, transport,
           message_text, media_url, message_timestamp, created_at
    FROM whatsapp_api_messages
    WHERE id = ? AND contact_id = ?
      AND LOWER(COALESCE(direction, '')) = 'inbound'
    LIMIT 1
  `, [cleanMessageId, cleanContactId]).catch(() => null)
  const sourceChannel = channelFromTransport(source?.transport)
  if (!source || !sourceChannel) {
    return {
      applies: false,
      shouldHandle: true,
      sourceChannel: normalizedInboundChannel,
      replyChannel: normalizedInboundChannel,
      reason: 'not_highlevel_phone_inbound'
    }
  }

  const [preference, recentRows] = await Promise.all([
    getHighLevelConversationalChannelPreference(cleanContactId),
    loadHighLevelPhoneInboundRows(cleanContactId, nowMs)
  ])
  if (!recentRows.some(row => cleanString(row.id) === cleanMessageId)) recentRows.push(source)

  const duplicatePeers = recentRows.filter(row => isCrossChannelDuplicate(source, row))
  const duplicateGroup = duplicatePeers.length ? [source, ...duplicatePeers] : [source]
  const duplicateIds = new Set(duplicateGroup.map(row => cleanString(row.id)))
  const customerPhone = rowCustomerPhone(source)
  const windowRows = duplicatePeers.length
    ? recentRows.filter(row => !duplicateIds.has(cleanString(row.id)))
    : recentRows
  const recentWhatsApp = newestRow(windowRows.filter(row => {
    if (channelFromTransport(row.transport) !== 'whatsapp') return false
    if (customerPhone && rowCustomerPhone(row) !== customerPhone) return false
    const timestamp = rowTimestampMs(row)
    return Boolean(
      timestamp &&
      timestamp <= nowMs + FUTURE_TIMESTAMP_TOLERANCE_MS &&
      nowMs - timestamp < HIGHLEVEL_CONVERSATIONAL_WHATSAPP_WINDOW_MS
    )
  }))

  const replyChannel = preference?.channel || (recentWhatsApp ? 'whatsapp' : 'sms')
  const preferredDuplicate = newestRow(duplicateGroup.filter(row => channelFromTransport(row.transport) === replyChannel))
  const shouldHandle = !duplicatePeers.length || !preferredDuplicate || preferredDuplicate.id === source.id
  const replyWhatsAppRow = replyChannel === 'whatsapp'
    ? recentWhatsApp || newestRow(duplicateGroup.filter(row => channelFromTransport(row.transport) === 'whatsapp'))
    : null

  return {
    applies: true,
    shouldHandle,
    sourceChannel,
    replyChannel,
    replyFromNumber: cleanString(replyWhatsAppRow?.business_phone) || null,
    manualPreference: preference?.channel || null,
    preferenceSelectedAt: preference?.selectedAt || null,
    whatsappWindowOpen: Boolean(recentWhatsApp),
    lastWhatsAppInboundAt: recentWhatsApp
      ? new Date(rowTimestampMs(recentWhatsApp)).toISOString()
      : null,
    duplicateDetected: duplicatePeers.length > 0,
    winningMessageId: preferredDuplicate?.id || source.id,
    reason: !shouldHandle
      ? 'cross_channel_duplicate_suppressed'
      : preference?.channel
        ? 'manual_channel_preference'
        : recentWhatsApp
          ? 'whatsapp_window_open'
          : 'whatsapp_window_closed'
  }
}
