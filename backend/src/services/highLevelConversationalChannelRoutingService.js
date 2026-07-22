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
const HIGHLEVEL_PHONE_MIRROR_SUFFIX_PATTERNS = [
  /\s*(?:📱\uFE0F?\s*)?\[\s*received\s+on\s+[^\]\r\n]+\]\s*$/iu,
  /\s*(?:🔁\uFE0F?\s*)?sent\s+from\s+another\s+device(?:\s*\([^\)\r\n]*\))?\s*(?:🔁\uFE0F?)?\s*$/iu
]

function cleanString(value = '') {
  return String(value || '').trim()
}

/**
 * HighLevel puede materializar el mismo WhatsApp como TYPE_CUSTOM_SMS y agregar
 * una firma operativa al cuerpo. Esa firma no pertenece al mensaje del contacto
 * y no debe romper la deduplicación ni llegar visible al chat.
 */
export function stripHighLevelPhoneMirrorAnnotation(value = '') {
  let text = String(value || '')
  let changed = true
  while (changed) {
    changed = false
    for (const pattern of HIGHLEVEL_PHONE_MIRROR_SUFFIX_PATTERNS) {
      const next = text.replace(pattern, '')
      if (next !== text) {
        text = next
        changed = true
      }
    }
  }
  return text.trim()
}

export function hasHighLevelPhoneMirrorAnnotation(value = '') {
  const raw = cleanString(value)
  return Boolean(raw && stripHighLevelPhoneMirrorAnnotation(raw) !== raw)
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
  return parseSortableTimestamp(row.message_timestamp || row.journey_message_date || row.created_at)
}

function rowCustomerPhone(row = {}) {
  return normalizePhoneForStorage(row.phone || row.from_phone || '') || cleanString(row.phone || row.from_phone)
}

function normalizeMessageText(value = '') {
  return stripHighLevelPhoneMirrorAnnotation(value).replace(/\s+/g, ' ').toLowerCase()
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

export function areHighLevelPhoneRowsCrossChannelDuplicates(source, candidate) {
  const sourceChannel = channelFromTransport(source?.transport)
  const candidateChannel = channelFromTransport(candidate?.transport)
  if (!sourceChannel || !candidateChannel || sourceChannel === candidateChannel) return false

  const sourceDirection = cleanString(source?.direction).toLowerCase()
  const candidateDirection = cleanString(candidate?.direction).toLowerCase()
  if (sourceDirection && candidateDirection && sourceDirection !== candidateDirection) return false
  if (!rowsShareCustomerPhone(source, candidate)) return false

  const sourceAt = rowTimestampMs(source)
  const candidateAt = rowTimestampMs(candidate)
  if (!sourceAt || !candidateAt) return false
  if (Math.abs(sourceAt - candidateAt) > HIGHLEVEL_CONVERSATIONAL_DUPLICATE_WINDOW_MS) return false

  return rowsShareSubstantiveContent(source, candidate)
}

function rowIdentity(row = {}) {
  return cleanString(row.id || row.whatsapp_api_message_id)
}

function oldestRow(rows = []) {
  return [...rows].sort((left, right) => {
    const byTimestamp = rowTimestampMs(left) - rowTimestampMs(right)
    if (byTimestamp !== 0) return byTimestamp
    return rowIdentity(left).localeCompare(rowIdentity(right))
  })[0] || null
}

/**
 * El historial conserva las filas crudas para soporte, pero la conversación
 * visible colapsa únicamente espejos explícitos. Dos mensajes reales idénticos
 * siguen apareciendo como dos mensajes; solo se oculta la copia que trae la
 * firma de HighLevel.
 */
export function collapseHighLevelPhoneMirrorRowsForDisplay(rows = []) {
  const entries = (Array.isArray(rows) ? rows : []).map(row => {
    const isHighLevelPhoneRow = Boolean(channelFromTransport(row?.transport))
    return {
      row,
      id: rowIdentity(row),
      annotated: isHighLevelPhoneRow && hasHighLevelPhoneMirrorAnnotation(row?.message_text),
      cleanText: isHighLevelPhoneRow
        ? stripHighLevelPhoneMirrorAnnotation(row?.message_text)
        : row?.message_text
    }
  })
  const hiddenIds = new Set()
  const usedCanonicalIds = new Set()
  const presentationById = new Map()

  const annotatedEntries = entries
    .filter(entry => entry.id && entry.annotated)
    .sort((left, right) => rowTimestampMs(left.row) - rowTimestampMs(right.row))

  for (const mirror of annotatedEntries) {
    const canonical = entries
      .filter(entry => (
        entry.id &&
        !entry.annotated &&
        !usedCanonicalIds.has(entry.id) &&
        areHighLevelPhoneRowsCrossChannelDuplicates(mirror.row, entry.row)
      ))
      .sort((left, right) => {
        const leftDistance = Math.abs(rowTimestampMs(left.row) - rowTimestampMs(mirror.row))
        const rightDistance = Math.abs(rowTimestampMs(right.row) - rowTimestampMs(mirror.row))
        if (leftDistance !== rightDistance) return leftDistance - rightDistance
        return left.id.localeCompare(right.id)
      })[0]
    if (!canonical) continue

    hiddenIds.add(mirror.id)
    usedCanonicalIds.add(canonical.id)
    const cursorRow = oldestRow([mirror.row, canonical.row])
    presentationById.set(canonical.id, {
      ...canonical.row,
      message_text: canonical.cleanText,
      journey_mirror_cursor_date: cursorRow?.journey_message_cursor_date ||
        cursorRow?.message_timestamp || cursorRow?.created_at || null,
      journey_mirror_cursor_message_id: rowIdentity(cursorRow)
    })
  }

  return entries
    .filter(entry => !hiddenIds.has(entry.id))
    .map(entry => presentationById.get(entry.id) || {
      ...entry.row,
      message_text: entry.cleanText
    })
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
    SELECT id, contact_id, phone, from_phone, business_phone, transport, direction,
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
    SELECT id, contact_id, phone, from_phone, business_phone, transport, direction,
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

  const duplicatePeers = recentRows.filter(row => areHighLevelPhoneRowsCrossChannelDuplicates(source, row))
  const duplicateGroup = duplicatePeers.length ? [source, ...duplicatePeers] : [source]
  const duplicateIds = new Set(duplicateGroup.map(row => cleanString(row.id)))
  const hasExplicitMirror = duplicateGroup.some(row => hasHighLevelPhoneMirrorAnnotation(row.message_text))
  const canonicalDuplicateIds = hasExplicitMirror
    ? new Set(duplicateGroup
        .filter(row => !hasHighLevelPhoneMirrorAnnotation(row.message_text))
        .map(row => cleanString(row.id)))
    : new Set()
  const customerPhone = rowCustomerPhone(source)
  const windowRows = duplicatePeers.length
    ? recentRows.filter(row => {
        const rowId = cleanString(row.id)
        return !duplicateIds.has(rowId) || canonicalDuplicateIds.has(rowId)
      })
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
