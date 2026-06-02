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

const DEFAULT_SESSION_ID = 'default'
const SOURCE_NAME = 'WhatsApp Business'
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' })
const runtimeSessions = new Map()

function nowIso() {
  return new Date().toISOString()
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
  return String(jid || '').endsWith('@s.whatsapp.net') || String(jid || '').endsWith('@c.us')
}

function isLidJid(jid = '') {
  return String(jid || '').endsWith('@lid') || String(jid || '').endsWith('@hosted.lid')
}

function pickPhoneJid(candidates = []) {
  return candidates.find(candidate => {
    if (!isPhoneJid(candidate)) return false
    return normalizePhoneDigits(normalizePhoneFromJid(candidate)).length >= 8
  }) || ''
}

export function resolveWhatsAppWebAddressing(msg = {}) {
  const key = msg.key || {}
  const remoteJid = key.remoteJid || ''
  const candidates = [
    key.remoteJidAlt,
    key.participantAlt,
    key.participant,
    remoteJid
  ].filter(Boolean)
  const phoneJid = pickPhoneJid(candidates)
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
  const searchRoot = {
    payload,
    externalAdReply,
    contextInfo
  }

  const detected = {
    ctwaClid: findFirstByKeys(searchRoot, ['ctwaClid', 'ctwa_clid', 'ctwa', 'clid']),
    sourceId: findFirstByKeys(searchRoot, ['sourceId', 'source_id', 'adId', 'ad_id']),
    sourceUrl: findFirstByKeys(searchRoot, ['sourceUrl', 'source_url']),
    sourceType: findFirstByKeys(searchRoot, ['sourceType', 'source_type']),
    sourceApp: findFirstByKeys(searchRoot, ['sourceApp', 'source_app', 'entryPointConversionApp']),
    entryPoint: findFirstByKeys(searchRoot, [
      'entryPointConversionSource',
      'entryPointConversionExternalSource',
      'conversionSource'
    ]),
    headline: safeString(adReply.title || adReply.headline || '') ||
      findFirstByKeys(searchRoot, ['referralHeadline', 'referral_headline', 'headline']),
    body: safeString(adReply.body || adReply.description || '') ||
      findFirstByKeys(searchRoot, ['referralBody', 'referral_body']),
    conversionData: findFirstByKeys(searchRoot, ['conversionData']),
    ctwaPayload: findFirstByKeys(searchRoot, ['ctwaPayload', 'ctwaSignals'])
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
      manualDisconnect: false
    })
  }
  return runtimeSessions.get(sessionId)
}

async function findExistingContact(phone) {
  const candidates = buildPhoneMatchCandidates(phone)
  if (!candidates.length) return null

  const placeholders = candidates.map(() => '?').join(', ')
  return db.get(
    `SELECT id, full_name, phone, attribution_ad_id, attribution_ctwa_clid, attribution_ad_name
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

async function upsertLocalContact({ phone, pushName, remoteJid, messageText, attribution }) {
  const canonicalPhone = normalizePhoneForStorage(phone) || phone
  const existing = await findExistingContact(canonicalPhone)
  const fullName = pushName || canonicalPhone || 'Contacto WhatsApp'

  if (!existing) {
    const contactId = hashId('waweb_contact', `${canonicalPhone}|${remoteJid}`)
    const customFieldsValue = JSON.stringify(buildContactCustomFields({ remoteJid, messageText, attribution }))
    const customFieldsPlaceholder = isPostgres() ? '?::jsonb' : '?'

    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, attribution_url, attribution_session_source,
        attribution_medium, attribution_ctwa_clid, attribution_ad_name, attribution_ad_id,
        custom_fields, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${customFieldsPlaceholder}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
      attribution.sourceId || null,
      attribution.sourceId || null,
      customFieldsValue
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

  if (attribution.sourceId) {
    updates.push('attribution_ad_id = ?')
    params.push(attribution.sourceId)
    updates.push('attribution_ad_name = COALESCE(attribution_ad_name, ?)')
    params.push(attribution.sourceId)
  }

  if (updates.length) {
    updates.push('updated_at = CURRENT_TIMESTAMP')
    params.push(existing.id)
    await db.run(`UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`, params)
  }

  return { id: existing.id, created: false }
}

async function upsertWhatsAppWebContact({ sessionId, contactId, remoteJid, phone, pushName, rawProfile }) {
  const webContactId = hashId('waweb_profile', `${sessionId}|${remoteJid}`)

  await db.run(`
    INSERT INTO whatsapp_web_contacts (
      id, session_id, contact_id, remote_jid, phone, push_name, display_name,
      raw_profile_json, first_seen_at, last_seen_at, message_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(session_id, remote_jid) DO UPDATE SET
      contact_id = COALESCE(excluded.contact_id, whatsapp_web_contacts.contact_id),
      phone = COALESCE(excluded.phone, whatsapp_web_contacts.phone),
      push_name = COALESCE(excluded.push_name, whatsapp_web_contacts.push_name),
      display_name = COALESCE(excluded.display_name, whatsapp_web_contacts.display_name),
      raw_profile_json = excluded.raw_profile_json,
      last_seen_at = CURRENT_TIMESTAMP,
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
    safeJson(rawProfile)
  ])

  return webContactId
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
      context_info_json = excluded.context_info_json,
      detected_ctwa_clid = excluded.detected_ctwa_clid,
      detected_source_id = excluded.detected_source_id,
      detected_source_url = excluded.detected_source_url,
      detected_source_type = excluded.detected_source_type,
      detected_source_app = excluded.detected_source_app,
      detected_entry_point = excluded.detected_entry_point,
      detected_headline = excluded.detected_headline,
      detected_body = excluded.detected_body,
      detected_conversion_data = excluded.detected_conversion_data,
      detected_ctwa_payload = excluded.detected_ctwa_payload,
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
        detected_ctwa_clid = excluded.detected_ctwa_clid,
        detected_source_id = excluded.detected_source_id,
        detected_source_url = excluded.detected_source_url,
        detected_source_type = excluded.detected_source_type,
        detected_source_app = excluded.detected_source_app,
        detected_entry_point = excluded.detected_entry_point,
        detected_headline = excluded.detected_headline,
        detected_body = excluded.detected_body,
        detected_conversion_data = excluded.detected_conversion_data,
        detected_ctwa_payload = excluded.detected_ctwa_payload,
        external_ad_reply_json = excluded.external_ad_reply_json,
        context_info_json = excluded.context_info_json,
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
      has_attribution = excluded.has_attribution,
      detected_ctwa_clid = excluded.detected_ctwa_clid,
      detected_source_id = excluded.detected_source_id,
      detected_source_url = excluded.detected_source_url,
      detected_source_type = excluded.detected_source_type,
      detected_source_app = excluded.detected_source_app,
      detected_entry_point = excluded.detected_entry_point,
      detected_headline = excluded.detected_headline,
      detected_body = excluded.detected_body,
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
  return processWhatsAppWebMessage(sessionId, msg, {
    eventSource: 'notify',
    onlyAttributed: false
  })
}

async function processWhatsAppWebMessage(sessionId, msg, { eventSource = 'notify', onlyAttributed = false } = {}) {
  if (!msg?.message) return { saved: false, reason: 'ignored' }

  const { remoteJid, phoneJid, identityJid, phone, usedLidFallback } = resolveWhatsAppWebAddressing(msg)
  if (shouldIgnoreJid(remoteJid)) return { saved: false, reason: 'ignored-jid' }

  const attribution = detectAttribution(msg)
  if (onlyAttributed && !attribution.hasAttribution) {
    return { saved: false, reason: 'no-attribution' }
  }

  if (!phone || usedLidFallback) {
    logger.warn(`WhatsApp Business mensaje sin numero telefonico resoluble: ${remoteJid}`)
    return { saved: false, reason: 'no-phone' }
  }

  const pushName = msg.key?.fromMe ? '' : (msg.pushName || '')
  const messageText = getMessageText(msg.message)
  const contact = await upsertLocalContact({
    phone,
    pushName,
    remoteJid: identityJid,
    messageText,
    attribution
  })
  const webContactId = await upsertWhatsAppWebContact({
    sessionId,
    contactId: contact.id,
    remoteJid: identityJid,
    phone,
    pushName,
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

  await updateSession(sessionId, { last_error: null })

  logger.info(`WhatsApp Business mensaje ${eventSource === 'history' ? 'historico ' : ''}recibido de ${phone}${attribution.hasAttribution ? ' con atribucion detectada' : ''}`)

  return {
    saved: true,
    attributionDetected: attribution.hasAttribution,
    phone
  }
}

async function processWhatsAppWebHistory(sessionId, messages = [], metadata = {}) {
  let saved = 0
  let attributed = 0

  for (const msg of messages) {
    const result = await processWhatsAppWebMessage(sessionId, msg, {
      eventSource: 'history',
      onlyAttributed: false
    })

    if (result.saved) {
      saved += 1
      if (result.attributionDetected) {
        attributed += 1
      }
    }
  }

  if (saved > 0) {
    logger.info(`WhatsApp Business historial guardado: ${saved} mensajes, ${attributed} con atribucion${metadata.syncType ? ` (sync ${metadata.syncType})` : ''}`)
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
    runtime.socket.ev.removeAllListeners('creds.update')
    runtime.socket.ws?.close?.()
  } catch (error) {
    logger.warn(`No se pudo cerrar socket WhatsApp Business: ${error.message}`)
  } finally {
    runtime.socket = null
    runtime.starting = null
  }
}

export async function startWhatsAppWebSession(sessionId = DEFAULT_SESSION_ID) {
  await ensureSessionRecord(sessionId)
  const runtime = getRuntime(sessionId)

  if (runtime.starting) return runtime.starting
  if (runtime.socket) return getWhatsAppWebStatus(sessionId)

  runtime.manualDisconnect = false
  runtime.starting = (async () => {
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
      browser: Browsers.macOS('Ristak'),
      logger: baileysLogger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
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
          const shouldReconnect = !runtime.manualDisconnect && statusCode !== DisconnectReason.loggedOut
          disconnectRuntimeSocket(sessionId, runtime)

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
            onlyAttributed: false
          })
        } catch (error) {
          logger.error(`Error guardando mensaje WhatsApp Business: ${error.message}`)
        }
      }
    })

    socket.ev.on('messaging-history.set', async ({ messages = [], syncType, progress }) => {
      try {
        await processWhatsAppWebHistory(sessionId, messages, { syncType, progress })
      } catch (error) {
        logger.error(`Error guardando historial de atribucion WhatsApp Business: ${error.message}`)
      }
    })

    socket.ev.on('messaging-history.status', ({ syncType, status }) => {
      logger.info(`WhatsApp Business historial ${status}: ${syncType}`)
    })

    runtime.starting = null
    return getWhatsAppWebStatus(sessionId)
  })()

  return runtime.starting
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
      (SELECT COUNT(*) FROM whatsapp_web_contacts WHERE session_id = ?) as contacts_count,
      (SELECT COUNT(*) FROM whatsapp_web_messages WHERE session_id = ?) as messages_count,
      (SELECT COUNT(*) FROM whatsapp_web_attribution WHERE session_id = ?) as attribution_count
  `, [sessionId, sessionId, sessionId])
  const authSaved = await hasSavedAuthState(sessionId)

  return {
    session: {
      ...session,
      auth_saved: authSaved
    },
    stats: {
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
  if (!await hasSavedAuthState(DEFAULT_SESSION_ID)) return

  startWhatsAppWebSession(DEFAULT_SESSION_ID).catch(error => {
    logger.error(`No se pudo iniciar WhatsApp Business automaticamente: ${error.message}`)
  })
}
