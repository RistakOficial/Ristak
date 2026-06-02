import crypto from 'crypto'
import pino from 'pino'
import QRCode from 'qrcode'
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  proto
} from '@whiskeysockets/baileys'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { buildPhoneMatchCandidates, normalizePhoneDigits, normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { detectWhatsAppAttributionFields } from '../utils/whatsappAttribution.js'

const DEFAULT_SESSION_ID = 'default'
const SOURCE_NAME = 'WhatsApp Business'
const FULL_HISTORY_BROWSER = Browsers.macOS('Desktop')
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' })
const runtimeSessions = new Map()

function nowIso() {
  return new Date().toISOString()
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isPostgres() {
  return Boolean(process.env.DATABASE_URL)
}

function hashId(prefix, value) {
  return `${prefix}_${crypto.createHash('sha256').update(String(value || crypto.randomUUID())).digest('hex').slice(0, 24)}`
}

function safeString(value) {
  if (value === null || value === undefined) return ''
  if (Buffer.isBuffer(value)) return value.toString('base64')
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, BufferJSON.replacer)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? null, BufferJSON.replacer)
  } catch {
    return JSON.stringify({ unserializable: true })
  }
}

function parseAuthJson(value) {
  if (!value) return null
  try {
    return JSON.parse(value, BufferJSON.reviver)
  } catch {
    return null
  }
}

function toDateTime(value) {
  if (!value) return null
  if (typeof value === 'number') {
    const millis = value > 9999999999 ? value : value * 1000
    return new Date(millis).toISOString()
  }
  if (typeof value === 'object' && typeof value.toNumber === 'function') {
    return new Date(value.toNumber() * 1000).toISOString()
  }
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function normalizePhoneFromJid(jid = '') {
  const raw = String(jid || '').split('@')[0]?.split(':')[0] || ''
  const digits = raw.replace(/\D/g, '')
  return digits ? `+${digits}` : ''
}

function isPhoneJid(jid = '') {
  return String(jid || '').endsWith('@s.whatsapp.net') ||
    String(jid || '').endsWith('@c.us') ||
    String(jid || '').endsWith('@hosted')
}

function isLidJid(jid = '') {
  return String(jid || '').endsWith('@lid') || String(jid || '').endsWith('@hosted.lid')
}

function normalizeJid(value = '') {
  const jid = String(value || '').trim()
  const atIndex = jid.indexOf('@')
  if (atIndex < 0) return jid

  const user = jid.slice(0, atIndex).split(':')[0]
  const server = jid.slice(atIndex + 1)
  return `${user}@${server}`
}

function rememberLidPhoneMapping(map, lid, phoneJid) {
  const normalizedLid = normalizeJid(lid)
  const normalizedPhoneJid = normalizeJid(phoneJid)

  if (!map || !isLidJid(normalizedLid) || !isPhoneJid(normalizedPhoneJid)) return
  if (normalizePhoneDigits(normalizePhoneFromJid(normalizedPhoneJid)).length < 8) return

  map.set(normalizedLid, normalizedPhoneJid)
}

function buildLidPhoneMap({ lidPnMappings = [], contacts = [] } = {}) {
  const map = new Map()

  for (const mapping of lidPnMappings || []) {
    rememberLidPhoneMapping(map, mapping?.lid, mapping?.pn)
  }

  for (const contact of contacts || []) {
    rememberLidPhoneMapping(map, contact?.lid || contact?.id, contact?.phoneNumber)
    rememberLidPhoneMapping(map, contact?.id, contact?.phoneNumber)
    rememberLidPhoneMapping(map, contact?.lid, contact?.id)
  }

  return map
}

function mergeLidPhoneMappings(target, source) {
  if (!target || !source) return
  for (const [lid, phoneJid] of source.entries()) {
    rememberLidPhoneMapping(target, lid, phoneJid)
  }
}

function mappedPhoneJid(candidate, lidPhoneMap) {
  const jid = normalizeJid(candidate)
  if (isPhoneJid(jid)) return jid
  if (isLidJid(jid)) return lidPhoneMap?.get(jid) || ''
  return ''
}

function pickPhoneJid(candidates = [], lidPhoneMap = new Map()) {
  return candidates.map(candidate => mappedPhoneJid(candidate, lidPhoneMap)).find(candidate => {
    if (!isPhoneJid(candidate)) return false
    return normalizePhoneDigits(normalizePhoneFromJid(candidate)).length >= 8
  }) || ''
}

export function resolveWhatsAppWebAddressing(msg = {}, lidPhoneMap = new Map()) {
  const key = msg.key || {}
  const remoteJid = key.remoteJid || ''
  const candidates = [
    key.remoteJidAlt,
    key.participantAlt,
    key.participant,
    remoteJid
  ].filter(Boolean)
  const phoneJid = pickPhoneJid(candidates, lidPhoneMap)
  const identityJid = phoneJid || remoteJid
  const rawPhone = normalizePhoneFromJid(identityJid)

  return {
    remoteJid,
    phoneJid,
    identityJid,
    rawPhone,
    phone: normalizePhoneForStorage(rawPhone) || rawPhone,
    usedLidFallback: !phoneJid && isLidJid(remoteJid)
  }
}

function shouldIgnoreJid(jid = '') {
  return !jid ||
    jid === 'status@broadcast' ||
    jid.endsWith('@g.us') ||
    jid.endsWith('@broadcast') ||
    jid.includes('newsletter')
}

function getMessageContent(message = {}) {
  return message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.documentWithCaptionMessage?.message ||
    message
}

function getMessageType(message = {}) {
  const content = getMessageContent(message)
  return Object.keys(content || {}).find(key => key !== 'messageContextInfo') || 'unknown'
}

function getMessageText(message = {}) {
  const content = getMessageContent(message)
  return content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    content.listResponseMessage?.description ||
    ''
}

function walk(value, visitor, path = [], seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)

  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visitor, [...path, String(index)], seen))
    return
  }

  for (const [key, child] of Object.entries(value)) {
    visitor(key, child, [...path, key])
    walk(child, visitor, [...path, key], seen)
  }
}

function findFirstByKeys(payload, keys) {
  const wanted = new Set(keys.map(key => key.toLowerCase()))
  let found = ''

  walk(payload, (key, value) => {
    if (found) return
    if (wanted.has(String(key).toLowerCase())) {
      const normalized = safeString(value)
      if (normalized) found = normalized
    }
  })

  return found
}

function findFirstObjectByKeys(payload, keys) {
  const wanted = new Set(keys.map(key => key.toLowerCase()))
  let found = null

  walk(payload, (key, value) => {
    if (found) return
    if (wanted.has(String(key).toLowerCase()) && value && typeof value === 'object') {
      found = value
    }
  })

  return found
}

function collectContextInfo(payload) {
  const contextInfo = []

  walk(payload, (key, value) => {
    if (String(key).toLowerCase() === 'contextinfo' && value && typeof value === 'object') {
      contextInfo.push(value)
    }
  })

  return contextInfo
}

function detectAttribution(payload) {
  const externalAdReply = findFirstObjectByKeys(payload, ['externalAdReply', 'external_ad_reply'])
  const contextInfo = collectContextInfo(payload)
  const contextSource = contextInfo[0] || null
  const adReply = externalAdReply || {}
  const fields = detectWhatsAppAttributionFields(payload, [
    getMessageText(payload?.message)
  ])

  const detected = {
    ctwaClid: fields.ctwaClid,
    sourceId: fields.sourceId,
    sourceUrl: fields.sourceUrl,
    sourceType: fields.sourceType,
    sourceApp: fields.sourceApp,
    entryPoint: fields.entryPoint,
    headline: safeString(adReply.title || adReply.headline || '') ||
      fields.headline,
    body: safeString(adReply.body || adReply.description || '') ||
      fields.body,
    conversionData: fields.conversionData,
    ctwaPayload: fields.ctwaPayload
  }

  return {
    ...detected,
    externalAdReply,
    contextInfo: contextSource,
    hasAttribution: Object.values(detected).some(Boolean) || Boolean(externalAdReply)
  }
}

async function ensureSessionRecord(sessionId = DEFAULT_SESSION_ID) {
  await db.run(`
    INSERT INTO whatsapp_web_sessions (id, label, status, updated_at)
    VALUES (?, ?, 'disconnected', CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      updated_at = CURRENT_TIMESTAMP
  `, [sessionId, 'WhatsApp Business'])
}

async function updateSession(sessionId, updates) {
  const entries = Object.entries(updates).filter(([, value]) => value !== undefined)
  if (!entries.length) return

  const assignments = entries.map(([key]) => `${key} = ?`)
  const params = entries.map(([, value]) => value)
  assignments.push('updated_at = CURRENT_TIMESTAMP')
  params.push(sessionId)

  await db.run(
    `UPDATE whatsapp_web_sessions SET ${assignments.join(', ')} WHERE id = ?`,
    params
  )
}

async function readAuthData(sessionId, authKey) {
  const row = await db.get(
    'SELECT value_json FROM whatsapp_web_auth_state WHERE session_id = ? AND auth_key = ?',
    [sessionId, authKey]
  )
  return parseAuthJson(row?.value_json)
}

async function writeAuthData(sessionId, authKey, value) {
  await db.run(`
    INSERT INTO whatsapp_web_auth_state (session_id, auth_key, value_json, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(session_id, auth_key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = CURRENT_TIMESTAMP
  `, [sessionId, authKey, safeJson(value)])
}

async function removeAuthData(sessionId, authKey) {
  await db.run(
    'DELETE FROM whatsapp_web_auth_state WHERE session_id = ? AND auth_key = ?',
    [sessionId, authKey]
  )
}

async function clearAuthState(sessionId) {
  await db.run('DELETE FROM whatsapp_web_auth_state WHERE session_id = ?', [sessionId])
}

async function hasSavedAuthState(sessionId = DEFAULT_SESSION_ID) {
  const row = await db.get(
    'SELECT 1 as present FROM whatsapp_web_auth_state WHERE session_id = ? AND auth_key = ? LIMIT 1',
    [sessionId, 'creds']
  )
  return Boolean(row)
}

async function useDbAuthState(sessionId = DEFAULT_SESSION_ID) {
  await ensureSessionRecord(sessionId)

  const creds = await readAuthData(sessionId, 'creds') || initAuthCreds()
  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data = {}

        await Promise.all(ids.map(async (id) => {
          let value = await readAuthData(sessionId, `${type}-${id}`)
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value)
          }
          data[id] = value
        }))

        return data
      },
      set: async (data) => {
        const tasks = []
        for (const category of Object.keys(data || {})) {
          for (const id of Object.keys(data[category] || {})) {
            const value = data[category][id]
            const authKey = `${category}-${id}`
            tasks.push(value ? writeAuthData(sessionId, authKey, value) : removeAuthData(sessionId, authKey))
          }
        }
        await Promise.all(tasks)
      },
      clear: async () => clearAuthState(sessionId)
    }
  }

  return {
    state,
    saveCreds: async () => writeAuthData(sessionId, 'creds', creds)
  }
}

function getRuntime(sessionId = DEFAULT_SESSION_ID) {
  if (!runtimeSessions.has(sessionId)) {
    runtimeSessions.set(sessionId, {
      socket: null,
      starting: null,
      manualDisconnect: false,
      lidPhoneMap: new Map()
    })
  }
  return runtimeSessions.get(sessionId)
}

async function findExistingContact(phone) {
  const candidates = buildPhoneMatchCandidates(phone)
  if (!candidates.length) return null

  const placeholders = candidates.map(() => '?').join(', ')
  return db.get(
    `SELECT id, full_name, phone, source, created_at, attribution_ad_id, attribution_ctwa_clid, attribution_ad_name
     FROM contacts
     WHERE phone IN (${placeholders})
     LIMIT 1`,
    candidates
  )
}

function buildContactCustomFields({ remoteJid, messageText, attribution }) {
  return [
    { key: 'whatsapp_web_remote_jid', field_value: remoteJid },
    { key: 'whatsapp_web_first_message', field_value: messageText || '' },
    { key: 'whatsapp_web_source_id', field_value: attribution.sourceId || '' },
    { key: 'whatsapp_web_ctwa_clid', field_value: attribution.ctwaClid || '' },
    { key: 'whatsapp_web_source_url', field_value: attribution.sourceUrl || '' }
  ]
}

function shouldMoveContactCreatedAt(existing, firstMessageAt, { allowAttributionCorrection = false } = {}) {
  if (!firstMessageAt) return false

  const source = String(existing?.source || '').toLowerCase()
  if (!allowAttributionCorrection && source && source !== SOURCE_NAME.toLowerCase()) return false

  if (!existing?.created_at) return true

  const existingTime = Date.parse(String(existing.created_at))
  const firstMessageTime = Date.parse(String(firstMessageAt))

  if (!Number.isFinite(firstMessageTime)) return false
  if (!Number.isFinite(existingTime)) return true

  return firstMessageTime < existingTime
}

function shouldApplyWhatsAppSourceId(existing, attribution, messageTimestamp) {
  if (!attribution?.sourceId) return false
  if (!existing?.attribution_ad_id) return true
  if (existing.attribution_ad_id === attribution.sourceId) return false

  const messageTime = Date.parse(String(messageTimestamp || ''))
  const existingCreatedTime = Date.parse(String(existing.created_at || ''))

  return Number.isFinite(messageTime) &&
    (!Number.isFinite(existingCreatedTime) || messageTime <= existingCreatedTime)
}

function getMessageSortTime(msg) {
  const timestamp = toDateTime(msg?.messageTimestamp)
  const time = timestamp ? Date.parse(timestamp) : NaN
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER
}

async function upsertLocalContact({ phone, pushName, remoteJid, messageText, messageTimestamp, isInbound, attribution }) {
  const canonicalPhone = normalizePhoneForStorage(phone) || phone
  const existing = await findExistingContact(canonicalPhone)
  const fullName = pushName || canonicalPhone || 'Contacto WhatsApp'
  const firstMessageAt = messageTimestamp || nowIso()

  if (!existing) {
    const contactId = hashId('waweb_contact', `${canonicalPhone}|${remoteJid}`)
    const customFieldsValue = JSON.stringify(buildContactCustomFields({ remoteJid, messageText, attribution }))
    const customFieldsPlaceholder = isPostgres() ? '?::jsonb' : '?'

    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, attribution_url, attribution_session_source,
        attribution_medium, attribution_ctwa_clid, attribution_ad_name, attribution_ad_id,
        custom_fields, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${customFieldsPlaceholder}, ?, CURRENT_TIMESTAMP)
    `, [
      contactId,
      canonicalPhone || null,
      fullName,
      pushName || null,
      SOURCE_NAME,
      attribution.sourceUrl || null,
      attribution.sourceApp || attribution.entryPoint || SOURCE_NAME,
      attribution.sourceType || 'whatsapp_web',
      attribution.ctwaClid || null,
      attribution.headline || attribution.sourceId || null,
      attribution.sourceId || null,
      customFieldsValue,
      firstMessageAt
    ])

    return { id: contactId, created: true }
  }

  const updates = []
  const params = []

  if (!existing.full_name && pushName) {
    updates.push('full_name = ?')
    params.push(pushName)
  }

  if (attribution.sourceUrl) {
    updates.push('attribution_url = ?')
    params.push(attribution.sourceUrl)
  }

  if (attribution.sourceApp || attribution.entryPoint) {
    updates.push('attribution_session_source = ?')
    params.push(attribution.sourceApp || attribution.entryPoint)
  }

  if (attribution.sourceType) {
    updates.push('attribution_medium = ?')
    params.push(attribution.sourceType)
  }

  if (attribution.ctwaClid) {
    updates.push('attribution_ctwa_clid = ?')
    params.push(attribution.ctwaClid)
  }

  if (shouldApplyWhatsAppSourceId(existing, attribution, messageTimestamp)) {
    updates.push('attribution_ad_id = ?')
    params.push(attribution.sourceId)
  }

  if (attribution.headline) {
    updates.push('attribution_ad_name = ?')
    params.push(attribution.headline)
  } else if (shouldApplyWhatsAppSourceId(existing, attribution, messageTimestamp)) {
    updates.push("attribution_ad_name = COALESCE(NULLIF(attribution_ad_name, ''), ?)")
    params.push(attribution.sourceId)
  }

  if (isInbound && shouldMoveContactCreatedAt(existing, messageTimestamp, {
    allowAttributionCorrection: Boolean(attribution.sourceId)
  })) {
    updates.push('created_at = ?')
    params.push(messageTimestamp)
  }

  if (updates.length) {
    updates.push('updated_at = CURRENT_TIMESTAMP')
    params.push(existing.id)
    await db.run(`UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`, params)
  }

  return { id: existing.id, created: false }
}

async function upsertWhatsAppWebContact({ sessionId, contactId, remoteJid, phone, pushName, firstSeenAt, rawProfile }) {
  const webContactId = hashId('waweb_profile', `${sessionId}|${remoteJid}`)
  const seenAt = firstSeenAt || nowIso()

  await db.run(`
    INSERT INTO whatsapp_web_contacts (
      id, session_id, contact_id, remote_jid, phone, push_name, display_name,
      raw_profile_json, first_seen_at, last_seen_at, message_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(session_id, remote_jid) DO UPDATE SET
      contact_id = COALESCE(excluded.contact_id, whatsapp_web_contacts.contact_id),
      phone = COALESCE(excluded.phone, whatsapp_web_contacts.phone),
      push_name = COALESCE(excluded.push_name, whatsapp_web_contacts.push_name),
      display_name = COALESCE(excluded.display_name, whatsapp_web_contacts.display_name),
      raw_profile_json = excluded.raw_profile_json,
      first_seen_at = CASE
        WHEN whatsapp_web_contacts.first_seen_at IS NULL THEN excluded.first_seen_at
        WHEN excluded.first_seen_at IS NULL THEN whatsapp_web_contacts.first_seen_at
        WHEN excluded.first_seen_at < whatsapp_web_contacts.first_seen_at THEN excluded.first_seen_at
        ELSE whatsapp_web_contacts.first_seen_at
      END,
      last_seen_at = CASE
        WHEN whatsapp_web_contacts.last_seen_at IS NULL THEN excluded.last_seen_at
        WHEN excluded.last_seen_at IS NULL THEN whatsapp_web_contacts.last_seen_at
        WHEN excluded.last_seen_at > whatsapp_web_contacts.last_seen_at THEN excluded.last_seen_at
        ELSE whatsapp_web_contacts.last_seen_at
      END,
      message_count = whatsapp_web_contacts.message_count + 1,
      updated_at = CURRENT_TIMESTAMP
  `, [
    webContactId,
    sessionId,
    contactId,
    remoteJid,
    phone || null,
    pushName || null,
    pushName || phone || null,
    safeJson(rawProfile),
    seenAt,
    seenAt
  ])

  return webContactId
}

async function upsertWhatsAppWebProfile({ sessionId, contactId, remoteJid, phone, displayName, rawProfile }) {
  const webContactId = hashId('waweb_profile', `${sessionId}|${remoteJid}`)

  await db.run(`
    INSERT INTO whatsapp_web_contacts (
      id, session_id, contact_id, remote_jid, phone, push_name, display_name,
      raw_profile_json, first_seen_at, last_seen_at, message_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(session_id, remote_jid) DO UPDATE SET
      contact_id = COALESCE(excluded.contact_id, whatsapp_web_contacts.contact_id),
      phone = COALESCE(excluded.phone, whatsapp_web_contacts.phone),
      push_name = COALESCE(excluded.push_name, whatsapp_web_contacts.push_name),
      display_name = COALESCE(excluded.display_name, whatsapp_web_contacts.display_name),
      raw_profile_json = excluded.raw_profile_json,
      updated_at = CURRENT_TIMESTAMP
  `, [
    webContactId,
    sessionId,
    contactId || null,
    remoteJid,
    phone || null,
    displayName || null,
    displayName || phone || null,
    safeJson(rawProfile)
  ])

  return webContactId
}

async function upsertWhatsAppWebChat({ sessionId, contactId, remoteJid, phone, displayName, chat }) {
  const webChatId = hashId('waweb_chat', `${sessionId}|${remoteJid}`)
  const conversationTimestamp = toDateTime(
    chat?.conversationTimestamp ||
    chat?.lastMessageRecvTimestamp ||
    chat?.t ||
    chat?.timestamp
  )
  const mutedUntil = toDateTime(chat?.muteEndTime || chat?.mutedUntil)

  await db.run(`
    INSERT INTO whatsapp_web_chats (
      id, session_id, contact_id, remote_jid, phone, display_name,
      conversation_timestamp, unread_count, archived, pinned, muted_until,
      raw_chat_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(session_id, remote_jid) DO UPDATE SET
      contact_id = COALESCE(excluded.contact_id, whatsapp_web_chats.contact_id),
      phone = COALESCE(excluded.phone, whatsapp_web_chats.phone),
      display_name = COALESCE(excluded.display_name, whatsapp_web_chats.display_name),
      conversation_timestamp = COALESCE(excluded.conversation_timestamp, whatsapp_web_chats.conversation_timestamp),
      unread_count = COALESCE(excluded.unread_count, whatsapp_web_chats.unread_count),
      archived = COALESCE(excluded.archived, whatsapp_web_chats.archived),
      pinned = COALESCE(excluded.pinned, whatsapp_web_chats.pinned),
      muted_until = COALESCE(excluded.muted_until, whatsapp_web_chats.muted_until),
      raw_chat_json = excluded.raw_chat_json,
      updated_at = CURRENT_TIMESTAMP
  `, [
    webChatId,
    sessionId,
    contactId || null,
    remoteJid,
    phone || null,
    displayName || phone || null,
    conversationTimestamp,
    Number(chat?.unreadCount || chat?.unread_count || 0),
    chat?.archived ? 1 : 0,
    chat?.pinned ? 1 : 0,
    mutedUntil,
    safeJson(chat)
  ])

  return webChatId
}

function getWhatsAppProfileDisplayName(profile = {}, phone = '') {
  return profile.name ||
    profile.notify ||
    profile.verifiedName ||
    profile.pushName ||
    profile.shortName ||
    phone ||
    ''
}

async function processWhatsAppWebContacts(sessionId, contacts = [], lidPhoneMap = new Map()) {
  let saved = 0

  for (const profile of contacts || []) {
    const remoteJid = normalizeJid(profile?.id || profile?.jid || profile?.lid || profile?.phoneNumber || '')
    if (!remoteJid || shouldIgnoreJid(remoteJid)) continue

    const phoneJid = pickPhoneJid([
      profile?.phoneNumber,
      profile?.pn,
      profile?.jid,
      profile?.id,
      profile?.lid
    ].filter(Boolean), lidPhoneMap)
    const phone = normalizePhoneForStorage(normalizePhoneFromJid(phoneJid)) || normalizePhoneFromJid(phoneJid)
    const existingContact = phone ? await findExistingContact(phone) : null
    const displayName = getWhatsAppProfileDisplayName(profile, phone)

    await upsertWhatsAppWebProfile({
      sessionId,
      contactId: existingContact?.id || null,
      remoteJid,
      phone,
      displayName,
      rawProfile: profile
    })
    saved += 1
  }

  return saved
}

function shouldIgnoreChatJid(jid = '') {
  return !jid ||
    jid === 'status@broadcast' ||
    jid.endsWith('@broadcast') ||
    jid.includes('newsletter')
}

async function processWhatsAppWebChats(sessionId, chats = [], lidPhoneMap = new Map()) {
  let saved = 0

  for (const chat of chats || []) {
    const remoteJid = normalizeJid(chat?.id || chat?.jid || chat?.remoteJid || '')
    if (!remoteJid || shouldIgnoreChatJid(remoteJid)) continue

    const phoneJid = pickPhoneJid([remoteJid], lidPhoneMap)
    const phone = normalizePhoneForStorage(normalizePhoneFromJid(phoneJid)) || normalizePhoneFromJid(phoneJid)
    const existingContact = phone ? await findExistingContact(phone) : null
    const displayName = chat?.name || chat?.subject || chat?.notify || phone || remoteJid

    await upsertWhatsAppWebChat({
      sessionId,
      contactId: existingContact?.id || null,
      remoteJid,
      phone,
      displayName,
      chat
    })
    saved += 1
  }

  return saved
}

async function reconcileWhatsAppContactCreatedAt(sessionId = DEFAULT_SESSION_ID) {
  const rows = await db.all(`
    SELECT
      contact_id,
      COALESCE(
        MIN(CASE WHEN direction = 'inbound' THEN message_timestamp END),
        MIN(message_timestamp)
      ) as first_message_at
    FROM whatsapp_web_messages
    WHERE session_id = ?
      AND contact_id IS NOT NULL
      AND message_timestamp IS NOT NULL
    GROUP BY contact_id
  `, [sessionId])

  let updated = 0

  for (const row of rows) {
    const contact = await db.get(
      'SELECT id, source, created_at FROM contacts WHERE id = ?',
      [row.contact_id]
    )

    if (!contact || !shouldMoveContactCreatedAt(contact, row.first_message_at)) continue

    await db.run(`
      UPDATE contacts
      SET created_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [row.first_message_at, row.contact_id])
    updated += 1
  }

  if (updated > 0) {
    logger.info(`WhatsApp Business fechas de contactos reconciliadas: ${updated}`)
  }

  return updated
}

async function getFirstWhatsAppSourceAttribution(contactId) {
  if (!contactId) return null

  return db.get(`
    SELECT *
    FROM (
      SELECT
        COALESCE(NULLIF(referral_source_id, ''), NULLIF(ad_id_thru_message, '')) as source_id,
        referral_ctwa_clid as ctwa_clid,
        referral_source_url as source_url,
        referral_source_type as source_type,
        NULL as source_app,
        NULL as entry_point,
        referral_headline as headline,
        created_at as attribution_at
      FROM whatsapp_attribution
      WHERE contact_id = ?

      UNION ALL

      SELECT
        COALESCE(NULLIF(attr.detected_source_id, ''), NULLIF(msg.detected_source_id, '')) as source_id,
        COALESCE(NULLIF(attr.detected_ctwa_clid, ''), NULLIF(msg.detected_ctwa_clid, '')) as ctwa_clid,
        COALESCE(NULLIF(attr.detected_source_url, ''), NULLIF(msg.detected_source_url, '')) as source_url,
        COALESCE(NULLIF(attr.detected_source_type, ''), NULLIF(msg.detected_source_type, '')) as source_type,
        COALESCE(NULLIF(attr.detected_source_app, ''), NULLIF(msg.detected_source_app, '')) as source_app,
        COALESCE(NULLIF(attr.detected_entry_point, ''), NULLIF(msg.detected_entry_point, '')) as entry_point,
        COALESCE(NULLIF(attr.detected_headline, ''), NULLIF(msg.detected_headline, '')) as headline,
        COALESCE(msg.message_timestamp, msg.created_at, attr.created_at) as attribution_at
      FROM whatsapp_web_messages msg
      LEFT JOIN whatsapp_web_attribution attr ON attr.whatsapp_web_message_id = msg.id
      WHERE msg.contact_id = ?
    ) candidates
    WHERE source_id IS NOT NULL
      AND source_id != ''
    ORDER BY
      CASE WHEN attribution_at IS NULL THEN 1 ELSE 0 END,
      attribution_at ASC
    LIMIT 1
  `, [contactId, contactId])
}

function shouldUseFirstWhatsAppSource(contact, attribution) {
  if (!attribution?.source_id) return false
  if (!contact?.attribution_ad_id) return true
  if (contact.attribution_ad_id === attribution.source_id) return true

  const source = String(contact.source || '').toLowerCase()
  if (!source || source === SOURCE_NAME.toLowerCase()) return true

  const attributionTime = Date.parse(String(attribution.attribution_at || ''))
  const contactTime = Date.parse(String(contact.created_at || ''))

  return Number.isFinite(attributionTime) &&
    (!Number.isFinite(contactTime) || attributionTime <= contactTime)
}

async function reconcileContactFirstWhatsAppAttribution(contactId) {
  const [contact, firstAttribution] = await Promise.all([
    db.get(`
      SELECT id, source, created_at, attribution_ad_id, attribution_ctwa_clid,
             attribution_url, attribution_session_source, attribution_medium,
             attribution_ad_name
      FROM contacts
      WHERE id = ?
      LIMIT 1
    `, [contactId]),
    getFirstWhatsAppSourceAttribution(contactId)
  ])

  if (!contact || !firstAttribution?.source_id) return 0

  const useFirstSource = shouldUseFirstWhatsAppSource(contact, firstAttribution)
  const updates = []
  const params = []

  if (useFirstSource && contact.attribution_ad_id !== firstAttribution.source_id) {
    updates.push('attribution_ad_id = ?')
    params.push(firstAttribution.source_id)
  }

  if (useFirstSource && firstAttribution.ctwa_clid) {
    updates.push('attribution_ctwa_clid = COALESCE(NULLIF(attribution_ctwa_clid, \'\'), ?)')
    params.push(firstAttribution.ctwa_clid)
  }

  if (useFirstSource && firstAttribution.source_url) {
    updates.push('attribution_url = COALESCE(NULLIF(attribution_url, \'\'), ?)')
    params.push(firstAttribution.source_url)
  }

  if (useFirstSource && (firstAttribution.source_app || firstAttribution.entry_point)) {
    updates.push('attribution_session_source = COALESCE(NULLIF(attribution_session_source, \'\'), ?)')
    params.push(firstAttribution.source_app || firstAttribution.entry_point)
  }

  if (useFirstSource && firstAttribution.source_type) {
    updates.push('attribution_medium = COALESCE(NULLIF(attribution_medium, \'\'), ?)')
    params.push(firstAttribution.source_type)
  }

  if (useFirstSource && (firstAttribution.headline || firstAttribution.source_id)) {
    updates.push('attribution_ad_name = COALESCE(NULLIF(attribution_ad_name, \'\'), ?)')
    params.push(firstAttribution.headline || firstAttribution.source_id)
  }

  if (useFirstSource && shouldMoveContactCreatedAt(contact, firstAttribution.attribution_at, {
    allowAttributionCorrection: true
  })) {
    updates.push('created_at = ?')
    params.push(firstAttribution.attribution_at)
  }

  if (!updates.length) return 0

  updates.push('updated_at = CURRENT_TIMESTAMP')
  params.push(contactId)

  await db.run(`UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`, params)

  if (useFirstSource) {
    logger.info(`WhatsApp Business primer source_id aplicado a contacto ${contactId}: ${firstAttribution.source_id}`)
  }

  return 1
}

async function reconcileWhatsAppFirstAttribution(sessionId = DEFAULT_SESSION_ID) {
  const rows = await db.all(`
    SELECT DISTINCT contact_id
    FROM (
      SELECT contact_id
      FROM whatsapp_web_messages
      WHERE session_id = ?
        AND contact_id IS NOT NULL
        AND COALESCE(detected_source_id, '') != ''

      UNION

      SELECT contact_id
      FROM whatsapp_attribution
      WHERE contact_id IS NOT NULL
        AND COALESCE(referral_source_id, ad_id_thru_message, '') != ''
    ) contacts_with_whatsapp_source
  `, [sessionId])

  let updated = 0

  for (const row of rows) {
    updated += await reconcileContactFirstWhatsAppAttribution(row.contact_id)
  }

  if (updated > 0) {
    logger.info(`WhatsApp Business primera atribucion reconciliada en ${updated} contactos`)
  }

  return updated
}

async function saveWhatsAppWebMessage({
  sessionId,
  contactId,
  webContactId,
  msg,
  remoteJid,
  phone,
  pushName,
  attribution
}) {
  const messageId = msg.key?.id || hashId('msgid', safeJson(msg))
  const webMessageId = hashId('waweb_msg', `${sessionId}|${remoteJid}|${messageId}`)
  const messageType = getMessageType(msg.message)
  const messageText = getMessageText(msg.message)
  const messageTimestamp = toDateTime(msg.messageTimestamp)
  const rawPayload = safeJson(msg)
  const contextInfoJson = attribution.contextInfo ? safeJson(attribution.contextInfo) : null

  await db.run(`
    INSERT INTO whatsapp_web_messages (
      id, session_id, whatsapp_web_contact_id, contact_id, remote_jid, phone, message_id,
      direction, message_type, message_text, push_name, message_timestamp, raw_payload_json,
      context_info_json, detected_ctwa_clid, detected_source_id, detected_source_url,
      detected_source_type, detected_source_app, detected_entry_point, detected_headline, detected_body, detected_conversion_data,
      detected_ctwa_payload, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      contact_id = COALESCE(excluded.contact_id, whatsapp_web_messages.contact_id),
      whatsapp_web_contact_id = COALESCE(excluded.whatsapp_web_contact_id, whatsapp_web_messages.whatsapp_web_contact_id),
      message_text = excluded.message_text,
      raw_payload_json = excluded.raw_payload_json,
      context_info_json = COALESCE(excluded.context_info_json, whatsapp_web_messages.context_info_json),
      detected_ctwa_clid = COALESCE(excluded.detected_ctwa_clid, whatsapp_web_messages.detected_ctwa_clid),
      detected_source_id = COALESCE(excluded.detected_source_id, whatsapp_web_messages.detected_source_id),
      detected_source_url = COALESCE(excluded.detected_source_url, whatsapp_web_messages.detected_source_url),
      detected_source_type = COALESCE(excluded.detected_source_type, whatsapp_web_messages.detected_source_type),
      detected_source_app = COALESCE(excluded.detected_source_app, whatsapp_web_messages.detected_source_app),
      detected_entry_point = COALESCE(excluded.detected_entry_point, whatsapp_web_messages.detected_entry_point),
      detected_headline = COALESCE(excluded.detected_headline, whatsapp_web_messages.detected_headline),
      detected_body = COALESCE(excluded.detected_body, whatsapp_web_messages.detected_body),
      detected_conversion_data = COALESCE(excluded.detected_conversion_data, whatsapp_web_messages.detected_conversion_data),
      detected_ctwa_payload = COALESCE(excluded.detected_ctwa_payload, whatsapp_web_messages.detected_ctwa_payload),
      updated_at = CURRENT_TIMESTAMP
  `, [
    webMessageId,
    sessionId,
    webContactId,
    contactId,
    remoteJid,
    phone || null,
    messageId,
    msg.key?.fromMe ? 'outbound' : 'inbound',
    messageType,
    messageText || null,
    pushName || null,
    messageTimestamp,
    rawPayload,
    contextInfoJson,
    attribution.ctwaClid || null,
    attribution.sourceId || null,
    attribution.sourceUrl || null,
    attribution.sourceType || null,
    attribution.sourceApp || null,
    attribution.entryPoint || null,
    attribution.headline || null,
    attribution.body || null,
    attribution.conversionData || null,
    attribution.ctwaPayload || null
  ])

  if (attribution.hasAttribution) {
    const attributionId = hashId('waweb_attr', `${sessionId}|${remoteJid}|${messageId}`)
    await db.run(`
      INSERT INTO whatsapp_web_attribution (
        id, session_id, whatsapp_web_message_id, whatsapp_web_contact_id, contact_id,
        remote_jid, phone, message_id, detected_ctwa_clid, detected_source_id,
        detected_source_url, detected_source_type, detected_source_app, detected_entry_point,
        detected_headline, detected_body, detected_conversion_data, detected_ctwa_payload, external_ad_reply_json,
        context_info_json, raw_payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        contact_id = COALESCE(excluded.contact_id, whatsapp_web_attribution.contact_id),
        detected_ctwa_clid = COALESCE(excluded.detected_ctwa_clid, whatsapp_web_attribution.detected_ctwa_clid),
        detected_source_id = COALESCE(excluded.detected_source_id, whatsapp_web_attribution.detected_source_id),
        detected_source_url = COALESCE(excluded.detected_source_url, whatsapp_web_attribution.detected_source_url),
        detected_source_type = COALESCE(excluded.detected_source_type, whatsapp_web_attribution.detected_source_type),
        detected_source_app = COALESCE(excluded.detected_source_app, whatsapp_web_attribution.detected_source_app),
        detected_entry_point = COALESCE(excluded.detected_entry_point, whatsapp_web_attribution.detected_entry_point),
        detected_headline = COALESCE(excluded.detected_headline, whatsapp_web_attribution.detected_headline),
        detected_body = COALESCE(excluded.detected_body, whatsapp_web_attribution.detected_body),
        detected_conversion_data = COALESCE(excluded.detected_conversion_data, whatsapp_web_attribution.detected_conversion_data),
        detected_ctwa_payload = COALESCE(excluded.detected_ctwa_payload, whatsapp_web_attribution.detected_ctwa_payload),
        external_ad_reply_json = COALESCE(excluded.external_ad_reply_json, whatsapp_web_attribution.external_ad_reply_json),
        context_info_json = COALESCE(excluded.context_info_json, whatsapp_web_attribution.context_info_json),
        raw_payload_json = excluded.raw_payload_json
    `, [
      attributionId,
      sessionId,
      webMessageId,
      webContactId,
      contactId,
      remoteJid,
      phone || null,
      messageId,
      attribution.ctwaClid || null,
      attribution.sourceId || null,
      attribution.sourceUrl || null,
      attribution.sourceType || null,
      attribution.sourceApp || null,
      attribution.entryPoint || null,
      attribution.headline || null,
      attribution.body || null,
      attribution.conversionData || null,
      attribution.ctwaPayload || null,
      attribution.externalAdReply ? safeJson(attribution.externalAdReply) : null,
      contextInfoJson,
      rawPayload
    ])
  }

  await saveWhatsAppWebLog({
    sessionId,
    webMessageId,
    contactId,
    remoteJid,
    phone,
    msg,
    messageType,
    messageText,
    messageTimestamp,
    rawPayload,
    pushName,
    attribution
  })

  return webMessageId
}

async function saveWhatsAppWebLog({
  sessionId,
  webMessageId,
  contactId,
  remoteJid,
  phone,
  msg,
  messageType,
  messageText,
  messageTimestamp,
  rawPayload,
  pushName,
  attribution
}) {
  const logId = hashId('waweb_log', `${sessionId}|${webMessageId}`)

  await db.run(`
    INSERT INTO whatsapp_web_logs (
      id, session_id, whatsapp_web_message_id, contact_id, remote_jid, phone,
      direction, message_type, message_text, push_name, has_attribution,
      detected_ctwa_clid, detected_source_id, detected_source_url, detected_source_type,
      detected_source_app, detected_entry_point, detected_headline, detected_body,
      message_timestamp, raw_payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      contact_id = excluded.contact_id,
      phone = excluded.phone,
      direction = excluded.direction,
      message_type = excluded.message_type,
      message_text = excluded.message_text,
      push_name = excluded.push_name,
      has_attribution = CASE
        WHEN excluded.has_attribution = 1 OR whatsapp_web_logs.has_attribution = 1 THEN 1
        ELSE 0
      END,
      detected_ctwa_clid = COALESCE(excluded.detected_ctwa_clid, whatsapp_web_logs.detected_ctwa_clid),
      detected_source_id = COALESCE(excluded.detected_source_id, whatsapp_web_logs.detected_source_id),
      detected_source_url = COALESCE(excluded.detected_source_url, whatsapp_web_logs.detected_source_url),
      detected_source_type = COALESCE(excluded.detected_source_type, whatsapp_web_logs.detected_source_type),
      detected_source_app = COALESCE(excluded.detected_source_app, whatsapp_web_logs.detected_source_app),
      detected_entry_point = COALESCE(excluded.detected_entry_point, whatsapp_web_logs.detected_entry_point),
      detected_headline = COALESCE(excluded.detected_headline, whatsapp_web_logs.detected_headline),
      detected_body = COALESCE(excluded.detected_body, whatsapp_web_logs.detected_body),
      message_timestamp = excluded.message_timestamp,
      raw_payload_json = excluded.raw_payload_json
  `, [
    logId,
    sessionId,
    webMessageId,
    contactId,
    remoteJid,
    phone || null,
    msg.key?.fromMe ? 'outbound' : 'inbound',
    messageType,
    messageText || null,
    pushName || null,
    attribution.hasAttribution ? 1 : 0,
    attribution.ctwaClid || null,
    attribution.sourceId || null,
    attribution.sourceUrl || null,
    attribution.sourceType || null,
    attribution.sourceApp || null,
    attribution.entryPoint || null,
    attribution.headline || null,
    attribution.body || null,
    messageTimestamp,
    rawPayload
  ])

  await db.run(`
    DELETE FROM whatsapp_web_logs
    WHERE session_id = ?
      AND id IN (
        SELECT id
        FROM whatsapp_web_logs
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT 1000000 OFFSET 100
      )
  `, [sessionId, sessionId])
}

async function processIncomingMessage(sessionId, msg) {
  const runtime = getRuntime(sessionId)
  return processWhatsAppWebMessage(sessionId, msg, {
    eventSource: 'notify',
    onlyAttributed: false,
    lidPhoneMap: runtime.lidPhoneMap
  })
}

async function processWhatsAppWebMessage(sessionId, msg, { eventSource = 'notify', onlyAttributed = false, lidPhoneMap = new Map() } = {}) {
  if (!msg?.message) return { saved: false, reason: 'ignored' }

  const { remoteJid, phoneJid, identityJid, phone, usedLidFallback } = resolveWhatsAppWebAddressing(msg, lidPhoneMap)
  if (shouldIgnoreJid(remoteJid)) return { saved: false, reason: 'ignored-jid' }

  const attribution = detectAttribution(msg)
  if (onlyAttributed && !attribution.hasAttribution) {
    return { saved: false, reason: 'no-attribution' }
  }

  if (!phone || usedLidFallback) {
    logger.warn(`WhatsApp Business mensaje sin numero telefonico resoluble: ${remoteJid}`)
    return { saved: false, reason: 'no-phone' }
  }

  const isInbound = !msg.key?.fromMe
  const pushName = isInbound ? (msg.pushName || '') : ''
  const messageText = getMessageText(msg.message)
  const messageTimestamp = toDateTime(msg.messageTimestamp)
  const contact = await upsertLocalContact({
    phone,
    pushName,
    remoteJid: identityJid,
    messageText,
    messageTimestamp,
    isInbound,
    attribution
  })
  const webContactId = await upsertWhatsAppWebContact({
    sessionId,
    contactId: contact.id,
    remoteJid: identityJid,
    phone,
    pushName,
    firstSeenAt: messageTimestamp,
    rawProfile: {
      key: msg.key,
      pushName,
      remoteJid,
      phoneJid,
      identityJid
    }
  })

  await saveWhatsAppWebMessage({
    sessionId,
    contactId: contact.id,
    webContactId,
    msg,
    remoteJid: identityJid,
    phone,
    pushName,
    attribution
  })

  if (attribution.sourceId) {
    await reconcileContactFirstWhatsAppAttribution(contact.id)
  }

  await updateSession(sessionId, { last_error: null })

  logger.info(`WhatsApp Business mensaje ${eventSource === 'history' ? 'historico ' : ''}recibido de ${phone}${attribution.hasAttribution ? ' con atribucion detectada' : ''}`)

  return {
    saved: true,
    attributionDetected: attribution.hasAttribution,
    contactId: contact.id,
    phone
  }
}

async function processWhatsAppWebHistory(sessionId, messages = [], metadata = {}) {
  const runtime = getRuntime(sessionId)
  const historyLidPhoneMap = buildLidPhoneMap(metadata)
  mergeLidPhoneMappings(runtime.lidPhoneMap, historyLidPhoneMap)
  const contactsSaved = await processWhatsAppWebContacts(sessionId, metadata.contacts || [], runtime.lidPhoneMap)
  const chatsSaved = await processWhatsAppWebChats(sessionId, metadata.chats || [], runtime.lidPhoneMap)

  let saved = 0
  let attributed = 0
  let failed = 0
  const affectedContactIds = new Set()

  const sortedMessages = [...messages].sort((a, b) => getMessageSortTime(a) - getMessageSortTime(b))

  for (const msg of sortedMessages) {
    let result

    try {
      result = await processWhatsAppWebMessage(sessionId, msg, {
        eventSource: 'history',
        onlyAttributed: false,
        lidPhoneMap: runtime.lidPhoneMap
      })
    } catch (error) {
      failed += 1
      logger.error(`Error guardando mensaje historico WhatsApp Business: ${error.message}`)
      continue
    }

    if (result.saved) {
      saved += 1
      if (result.contactId) {
        affectedContactIds.add(result.contactId)
      }
      if (result.attributionDetected) {
        attributed += 1
      }
    }
  }

  logger.info(
    `WhatsApp Business historial procesado: ${saved}/${messages.length} mensajes guardados, ${contactsSaved} contactos, ${chatsSaved} chats, ${attributed} con atribucion, ${failed} fallidos, ${runtime.lidPhoneMap.size} mappings LID-PN${metadata.syncType ? ` (sync ${metadata.syncType})` : ''}`
  )

  if (saved > 0) {
    await reconcileWhatsAppContactCreatedAt(sessionId)
  }

  for (const contactId of affectedContactIds) {
    await reconcileContactFirstWhatsAppAttribution(contactId)
  }

  return saved
}

async function createQrImage(qr) {
  return QRCode.toDataURL(qr, {
    margin: 1,
    width: 320,
    color: {
      dark: '#111111',
      light: '#ffffff'
    }
  })
}

async function getConnectedAccountInfo(socket) {
  const jid = socket.user?.id || ''
  let profilePictureUrl = null
  let businessProfile = null

  if (jid) {
    try {
      profilePictureUrl = await socket.profilePictureUrl(jid, 'image', 5000)
    } catch {
      profilePictureUrl = null
    }

    try {
      businessProfile = await socket.getBusinessProfile(jid)
    } catch {
      businessProfile = null
    }
  }

  return {
    jid,
    phone: normalizePhoneForStorage(normalizePhoneFromJid(jid)) || normalizePhoneFromJid(jid),
    pushName: socket.user?.name ||
      socket.user?.verifiedName ||
      businessProfile?.businessName ||
      businessProfile?.name ||
      null,
    profilePictureUrl,
    businessProfile,
    accountInfo: socket.user || null
  }
}

function disconnectRuntimeSocket(sessionId, runtime) {
  if (!runtime?.socket) return
  try {
    runtime.socket.ev.removeAllListeners('connection.update')
    runtime.socket.ev.removeAllListeners('messages.upsert')
    runtime.socket.ev.removeAllListeners('messaging-history.set')
    runtime.socket.ev.removeAllListeners('messaging-history.status')
    runtime.socket.ev.removeAllListeners('contacts.upsert')
    runtime.socket.ev.removeAllListeners('contacts.update')
    runtime.socket.ev.removeAllListeners('chats.upsert')
    runtime.socket.ev.removeAllListeners('chats.update')
    runtime.socket.ev.removeAllListeners('lid-mapping.update')
    runtime.socket.ev.removeAllListeners('creds.update')
    runtime.socket.ws?.close?.()
  } catch (error) {
    logger.warn(`No se pudo cerrar socket WhatsApp Business: ${error.message}`)
  } finally {
    runtime.socket = null
    runtime.starting = null
  }
}

export async function startWhatsAppWebSession(sessionId = DEFAULT_SESSION_ID, { resetAuth = false } = {}) {
  await ensureSessionRecord(sessionId)
  const runtime = getRuntime(sessionId)

  if (resetAuth) {
    runtime.manualDisconnect = true
    disconnectRuntimeSocket(sessionId, runtime)
    runtime.lidPhoneMap.clear()
    await clearAuthState(sessionId)
    await updateSession(sessionId, {
      status: 'disconnected',
      phone: null,
      jid: null,
      push_name: null,
      profile_picture_url: null,
      business_profile_json: null,
      account_info_json: null,
      qr_code: null,
      qr_image: null,
      last_error: null,
      disconnected_at: nowIso()
    })
  } else {
    if (runtime.starting) return getWhatsAppWebStatus(sessionId)
    if (runtime.socket) return getWhatsAppWebStatus(sessionId)
  }

  runtime.manualDisconnect = false
  runtime.starting = (async () => {
    try {
      const authAlreadySaved = await hasSavedAuthState(sessionId)
      if (!authAlreadySaved) {
        runtime.lidPhoneMap.clear()
      }

      const { state, saveCreds } = await useDbAuthState(sessionId)

      await updateSession(sessionId, {
        status: 'connecting',
        qr_code: null,
        qr_image: null,
        last_error: null
      })

      const socket = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger)
        },
        browser: FULL_HISTORY_BROWSER,
        logger: baileysLogger,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        qrTimeout: 60000,
        syncFullHistory: true,
        shouldSyncHistoryMessage: () => true
      })

      runtime.socket = socket

      socket.ev.on('creds.update', saveCreds)

      socket.ev.on('connection.update', async (update) => {
        try {
          const { connection, qr, lastDisconnect } = update

          if (qr) {
            const qrImage = await createQrImage(qr)
            await updateSession(sessionId, {
              status: 'qr',
              qr_code: qr,
              qr_image: qrImage,
              last_qr_at: nowIso(),
              last_error: null
            })
          }

          if (connection === 'open') {
            const accountInfo = await getConnectedAccountInfo(socket)
            await updateSession(sessionId, {
              status: 'connected',
              qr_code: null,
              qr_image: null,
              phone: accountInfo.phone,
              jid: accountInfo.jid || null,
              push_name: accountInfo.pushName,
              profile_picture_url: accountInfo.profilePictureUrl,
              business_profile_json: accountInfo.businessProfile ? safeJson(accountInfo.businessProfile) : null,
              account_info_json: accountInfo.accountInfo ? safeJson(accountInfo.accountInfo) : null,
              connected_at: nowIso(),
              last_error: null
            })
            logger.success('WhatsApp Business conectado')
          }

          if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const authFailed = statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession
            const shouldReconnect = !runtime.manualDisconnect && !authFailed
            disconnectRuntimeSocket(sessionId, runtime)

            if (authFailed) {
              await clearAuthState(sessionId)
            }

            await updateSession(sessionId, {
              status: shouldReconnect ? 'reconnecting' : 'disconnected',
              disconnected_at: nowIso(),
              qr_code: null,
              qr_image: null,
              last_error: lastDisconnect?.error?.message || null
            })

            if (shouldReconnect) {
              setTimeout(() => {
                startWhatsAppWebSession(sessionId).catch(error => {
                  logger.error(`No se pudo reconectar WhatsApp Business: ${error.message}`)
                })
              }, 2500)
            }
          }
        } catch (error) {
          logger.error(`Error procesando connection.update de WhatsApp Business: ${error.message}`)
        }
      })

      socket.ev.on('messages.upsert', async ({ messages = [], type = 'notify' }) => {
        for (const msg of messages) {
          try {
            await processWhatsAppWebMessage(sessionId, msg, {
              eventSource: type,
              onlyAttributed: false,
              lidPhoneMap: runtime.lidPhoneMap
            })
          } catch (error) {
            logger.error(`Error guardando mensaje WhatsApp Business: ${error.message}`)
          }
        }
      })

      socket.ev.on('messaging-history.set', async ({ messages = [], contacts = [], chats = [], lidPnMappings = [], syncType, progress }) => {
        try {
          await processWhatsAppWebHistory(sessionId, messages, { contacts, chats, lidPnMappings, syncType, progress })
        } catch (error) {
          logger.error(`Error guardando historial de atribucion WhatsApp Business: ${error.message}`)
        }
      })

      socket.ev.on('contacts.upsert', async (contacts = []) => {
        try {
          await processWhatsAppWebContacts(sessionId, contacts, runtime.lidPhoneMap)
        } catch (error) {
          logger.error(`Error guardando contactos WhatsApp Business: ${error.message}`)
        }
      })

      socket.ev.on('contacts.update', async (contacts = []) => {
        try {
          await processWhatsAppWebContacts(sessionId, contacts, runtime.lidPhoneMap)
        } catch (error) {
          logger.error(`Error actualizando contactos WhatsApp Business: ${error.message}`)
        }
      })

      socket.ev.on('chats.upsert', async (chats = []) => {
        try {
          await processWhatsAppWebChats(sessionId, chats, runtime.lidPhoneMap)
        } catch (error) {
          logger.error(`Error guardando chats WhatsApp Business: ${error.message}`)
        }
      })

      socket.ev.on('chats.update', async (chats = []) => {
        try {
          await processWhatsAppWebChats(sessionId, chats, runtime.lidPhoneMap)
        } catch (error) {
          logger.error(`Error actualizando chats WhatsApp Business: ${error.message}`)
        }
      })

      socket.ev.on('lid-mapping.update', ({ lid, pn }) => {
        rememberLidPhoneMapping(runtime.lidPhoneMap, lid, pn)
      })

      socket.ev.on('messaging-history.status', ({ syncType, status }) => {
        logger.info(`WhatsApp Business historial ${status}: ${syncType}`)
      })

      return getWhatsAppWebStatus(sessionId)
    } catch (error) {
      await updateSession(sessionId, {
        status: 'disconnected',
        qr_code: null,
        qr_image: null,
        last_error: error.message || 'No se pudo iniciar WhatsApp Business'
      }).catch(() => {})
      logger.error(`No se pudo iniciar WhatsApp Business: ${error.message}`)
      throw error
    } finally {
      runtime.starting = null
    }
  })()

  return Promise.race([
    runtime.starting,
    wait(1500).then(() => getWhatsAppWebStatus(sessionId))
  ])
}

export async function disconnectWhatsAppWebSession(sessionId = DEFAULT_SESSION_ID) {
  await ensureSessionRecord(sessionId)
  const runtime = getRuntime(sessionId)
  runtime.manualDisconnect = true

  if (runtime.socket) {
    try {
      await runtime.socket.logout('Ristak disconnect')
    } catch (error) {
      logger.warn(`Logout WhatsApp Business fallo, limpiando sesion local: ${error.message}`)
    }
  }

  disconnectRuntimeSocket(sessionId, runtime)
  runtime.lidPhoneMap.clear()
  await clearAuthState(sessionId)
  await updateSession(sessionId, {
    status: 'disconnected',
    phone: null,
    jid: null,
    push_name: null,
    profile_picture_url: null,
    business_profile_json: null,
    account_info_json: null,
    qr_code: null,
    qr_image: null,
    last_error: null,
    disconnected_at: nowIso()
  })

  return getWhatsAppWebStatus(sessionId)
}

export async function getWhatsAppWebStatus(sessionId = DEFAULT_SESSION_ID) {
  await ensureSessionRecord(sessionId)
  const session = await db.get('SELECT * FROM whatsapp_web_sessions WHERE id = ?', [sessionId])
  const stats = await db.get(`
    SELECT
      (SELECT COUNT(*) FROM whatsapp_web_chats WHERE session_id = ?) as chats_count,
      (SELECT COUNT(*) FROM whatsapp_web_contacts WHERE session_id = ?) as contacts_count,
      (SELECT COUNT(*) FROM whatsapp_web_messages WHERE session_id = ?) as messages_count,
      (SELECT COUNT(*) FROM whatsapp_web_attribution WHERE session_id = ?) as attribution_count
  `, [sessionId, sessionId, sessionId, sessionId])
  const authSaved = await hasSavedAuthState(sessionId)

  return {
    session: {
      ...session,
      auth_saved: authSaved
    },
    stats: {
      chats: Number(stats?.chats_count || 0),
      contacts: Number(stats?.contacts_count || 0),
      messages: Number(stats?.messages_count || 0),
      attribution: Number(stats?.attribution_count || 0)
    }
  }
}

export async function getRecentWhatsAppWebMessages(sessionId = DEFAULT_SESSION_ID, limit = 12) {
  await ensureSessionRecord(sessionId)
  const safeLimit = Math.min(Math.max(Number(limit) || 12, 1), 50)

  return db.all(`
    SELECT id, contact_id, phone, push_name, message_text, message_type, detected_ctwa_clid,
           detected_source_id, detected_source_url, created_at
    FROM whatsapp_web_messages
    WHERE session_id = ?
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `, [sessionId])
}

export async function getWhatsAppWebLogs(sessionId = DEFAULT_SESSION_ID) {
  await ensureSessionRecord(sessionId)

  const fields = `
    id, whatsapp_web_message_id, contact_id, remote_jid, phone, direction,
    message_type, message_text, push_name, has_attribution, detected_ctwa_clid,
    detected_source_id, detected_source_url, detected_source_type, detected_source_app,
    detected_entry_point, detected_headline, detected_body, message_timestamp,
    created_at
  `

  const [recent, attributed] = await Promise.all([
    db.all(`
      SELECT ${fields}
      FROM whatsapp_web_logs
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT 100
    `, [sessionId]),
    db.all(`
      SELECT ${fields}
      FROM whatsapp_web_logs
      WHERE session_id = ?
        AND has_attribution = 1
      ORDER BY created_at DESC
      LIMIT 100
    `, [sessionId])
  ])

  return { recent, attributed }
}

export async function initializeWhatsAppWebReceiver() {
  await ensureSessionRecord(DEFAULT_SESSION_ID)
  await reconcileWhatsAppContactCreatedAt(DEFAULT_SESSION_ID).catch(error => {
    logger.warn(`No se pudieron reconciliar fechas de contactos WhatsApp Business: ${error.message}`)
  })
  await reconcileWhatsAppFirstAttribution(DEFAULT_SESSION_ID).catch(error => {
    logger.warn(`No se pudo reconciliar primera atribucion WhatsApp Business: ${error.message}`)
  })

  if (!await hasSavedAuthState(DEFAULT_SESSION_ID)) return

  startWhatsAppWebSession(DEFAULT_SESSION_ID).catch(error => {
    logger.error(`No se pudo iniciar WhatsApp Business automaticamente: ${error.message}`)
  })
}
