import pino from 'pino'
import crypto from 'crypto'
import { db } from '../config/database.js'
import { buildPhoneMatchCandidates, normalizePhoneDigits, normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { logger } from '../utils/logger.js'

const QR_CONSENT_TEXT = 'Acepto que esta conexion usa WhatsApp Web por QR y no la API oficial de Meta. Entiendo que puede desconectarse, fallar o poner en riesgo el numero. Ristak solo la usara para mensajes individuales cuando yo lo active.'
const CONNECT_TIMEOUT_MS = 20000
const QR_SEND_ACK_TIMEOUT_MS = 10000
const QR_RECENT_ACK_RETENTION_MS = 90000
const QR_PROFILE_PICTURE_TIMEOUT_MS = 4500
const QR_PROFILE_PICTURE_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const QR_PROFILE_PICTURE_BATCH_LIMIT = 8
const RECONNECT_BASE_DELAY_MS = 2500
const RECONNECT_MAX_DELAY_MS = 60000
const MAX_RECONNECT_ATTEMPTS = 8
const QR_ACK_STATUS = {
  ERROR: 0,
  PENDING: 1,
  SERVER_ACK: 2,
  DELIVERY_ACK: 3,
  READ: 4,
  PLAYED: 5
}
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' })
const AUDIO_MIME_BY_EXTENSION = {
  aac: 'audio/aac',
  amr: 'audio/amr',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'audio/webm'
}
const DOCUMENT_MIME_BY_EXTENSION = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv'
}
const WHATSAPP_VOICE_NOTE_MIME_TYPE = 'audio/ogg; codecs=opus'

const liveSessions = new Map()
const qrSendAckWaiters = new Map()
const qrRecentMessageAcks = new Map()
let baileysRuntime = null

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function nowIso() {
  return new Date().toISOString()
}

function hashId(prefix, value) {
  return `${prefix}_${crypto.createHash('sha256').update(String(value || crypto.randomUUID())).digest('hex').slice(0, 24)}`
}

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })

  return { promise, resolve, reject }
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return JSON.stringify({ unserializable: true })
  }
}

function safeAuthJson(value, BufferJSON) {
  try {
    return JSON.stringify(value ?? null, BufferJSON?.replacer)
  } catch {
    return JSON.stringify({ unserializable: true })
  }
}

function parseAuthJson(value, BufferJSON) {
  if (!value) return null
  try {
    return JSON.parse(value, BufferJSON?.reviver)
  } catch {
    return null
  }
}

function parseMediaDataUrl(dataUrl = '') {
  const text = cleanString(dataUrl)
  if (!text) return null

  const match = text.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/i)
  if (!match) {
    throw new Error('El archivo no tiene un formato valido para enviar por QR')
  }

  return {
    buffer: Buffer.from(match[2], 'base64'),
    mimeType: cleanString(match[1]).toLowerCase()
  }
}

function getFileExtensionFromUrl(url = '') {
  const cleanUrl = cleanString(url).split('?')[0].split('#')[0]
  const extension = cleanUrl.split('.').pop()
  return cleanString(extension).toLowerCase()
}

function inferAudioMimeType({ mimeType, url } = {}) {
  const cleanMimeType = cleanString(mimeType).toLowerCase()
  if (cleanMimeType) return cleanMimeType
  return AUDIO_MIME_BY_EXTENSION[getFileExtensionFromUrl(url)] || 'audio/mpeg'
}

function getFilenameFromUrl(url = '') {
  try {
    const parsed = new URL(cleanString(url))
    return decodeURIComponent(parsed.pathname.split('/').pop() || '')
  } catch {
    return cleanString(url).split('?')[0].split('#')[0].split('/').pop() || ''
  }
}

function inferDocumentMimeType({ mimeType, url, filename } = {}) {
  const cleanMimeType = cleanString(mimeType).toLowerCase()
  if (cleanMimeType) return cleanMimeType
  const extension = getFileExtensionFromUrl(filename) || getFileExtensionFromUrl(url)
  return DOCUMENT_MIME_BY_EXTENSION[extension] || 'application/octet-stream'
}

function normalizeVoiceNoteMimeType(mimeType = '') {
  const cleanMimeType = cleanString(mimeType).toLowerCase()
  if (!cleanMimeType) return WHATSAPP_VOICE_NOTE_MIME_TYPE
  if (cleanMimeType === 'audio/ogg' || cleanMimeType.startsWith('audio/ogg;')) {
    return WHATSAPP_VOICE_NOTE_MIME_TYPE
  }
  return cleanMimeType
}

function getAudioDurationSeconds(durationMs) {
  const value = Number(durationMs || 0)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.max(1, Math.round(value / 1000))
}

function buildQrMediaPayload({ dataUrl, url, label }) {
  const parsedDataUrl = parseMediaDataUrl(dataUrl)
  if (parsedDataUrl?.buffer?.length) {
    return {
      content: parsedDataUrl.buffer,
      mimeType: parsedDataUrl.mimeType,
      sourceUrl: ''
    }
  }

  const cleanUrl = cleanString(url)
  if (!cleanUrl) throw new Error(`Falta el archivo para mandar ${label} por QR`)

  return {
    content: { url: cleanUrl },
    mimeType: '',
    sourceUrl: cleanUrl
  }
}

function normalizeConnectedPhone(value = '') {
  const text = cleanString(value)
  const bare = text.split('@')[0]?.split(':')[0] || text
  return normalizePhoneForStorage(bare) || bare.replace(/\D/g, '')
}

function normalizeJid(value = '') {
  const jid = cleanString(value)
  const atIndex = jid.indexOf('@')
  if (atIndex < 0) return jid

  const user = jid.slice(0, atIndex).split(':')[0]
  const server = jid.slice(atIndex + 1)
  return `${user}@${server}`
}

function normalizePhoneFromJid(jid = '') {
  const digits = normalizePhoneDigits(String(jid || '').split('@')[0]?.split(':')[0] || '')
  return digits ? `+${digits}` : ''
}

function phoneMatches(left = '', right = '') {
  const leftCandidates = buildPhoneMatchCandidates(left)
  const rightCandidates = buildPhoneMatchCandidates(right)
  return leftCandidates.some(candidate => rightCandidates.includes(candidate))
}

function buildOutboundPhoneCandidates(value = '') {
  const candidates = new Set()
  const addCandidate = (candidate) => {
    const digits = normalizePhoneDigits(candidate)
    if (digits.length >= 8) candidates.add(digits)
  }

  addCandidate(value)
  addCandidate(normalizePhoneForStorage(value))
  for (const candidate of buildPhoneMatchCandidates(value)) {
    addCandidate(candidate)
  }

  return [...candidates]
}

function getJidPhoneDigits(jid = '') {
  return normalizePhoneDigits(normalizePhoneFromJid(jid))
}

async function resolveRecipientJid(sock, toPhone) {
  const candidates = buildOutboundPhoneCandidates(toPhone)
  if (!candidates.length) throw new Error('Falta el numero destino')
  if (!sock?.onWhatsApp) {
    throw new Error('La conexion QR no puede verificar si el numero destino existe en WhatsApp')
  }

  let results = []
  try {
    results = await sock.onWhatsApp(...candidates)
  } catch (error) {
    throw new Error(`No se pudo verificar el numero destino en WhatsApp: ${error.message}`)
  }

  const existingResults = Array.isArray(results)
    ? results.filter(result => result?.exists && result?.jid)
    : []

  for (const candidate of candidates) {
    const matched = existingResults.find(result => getJidPhoneDigits(result.jid) === candidate)
    if (matched) {
      return {
        jid: normalizeJid(matched.jid),
        verifiedPhone: normalizePhoneForStorage(normalizePhoneFromJid(matched.jid)) || normalizePhoneFromJid(matched.jid),
        lookup: existingResults
      }
    }
  }

  const fallback = existingResults[0]
  if (fallback?.jid) {
    return {
      jid: normalizeJid(fallback.jid),
      verifiedPhone: normalizePhoneForStorage(normalizePhoneFromJid(fallback.jid)) || normalizePhoneFromJid(fallback.jid),
      lookup: existingResults
    }
  }

  throw new Error('Ese numero no aparece como usuario activo de WhatsApp para enviar por QR')
}

function assertQrSendAccepted(response, recipientJid) {
  const messageId = cleanString(response?.key?.id)
  const remoteJid = normalizeJid(response?.key?.remoteJid)

  if (!messageId || !remoteJid) {
    throw new Error('WhatsApp QR no confirmo el envio al servidor. Intenta otra vez.')
  }

  if (recipientJid && remoteJid && remoteJid !== normalizeJid(recipientJid)) {
    throw new Error('WhatsApp QR respondio con un destinatario distinto al verificado')
  }

  return {
    messageId,
    remoteJid
  }
}

function getBaileysStatusCode(value) {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric

  const label = cleanString(value).toUpperCase()
  return Object.prototype.hasOwnProperty.call(QR_ACK_STATUS, label)
    ? QR_ACK_STATUS[label]
    : null
}

function mapBaileysAckToMessageStatus(statusCode) {
  const code = getBaileysStatusCode(statusCode)
  if (code === QR_ACK_STATUS.ERROR) return 'failed'
  if (code >= QR_ACK_STATUS.READ) return 'read'
  if (code >= QR_ACK_STATUS.DELIVERY_ACK) return 'delivered'
  if (code >= QR_ACK_STATUS.SERVER_ACK) return 'sent'
  return 'pending'
}

function getStoredStatusPriority(status) {
  switch (cleanString(status).toLowerCase()) {
    case 'failed':
    case 'error':
      return 100
    case 'read':
      return 80
    case 'delivered':
      return 70
    case 'sent':
      return 60
    case 'pending':
    case 'queued':
    case 'scheduled':
      return 20
    default:
      return 0
  }
}

function shouldUpdateStoredStatus(currentStatus, nextStatus) {
  const next = cleanString(nextStatus).toLowerCase()
  if (!next) return false
  if (next === 'failed') return true
  return getStoredStatusPriority(next) >= getStoredStatusPriority(currentStatus)
}

function getQrAckPriority(ack = {}) {
  const status = cleanString(ack.status).toLowerCase()
  if (status === 'failed') return 100
  return getStoredStatusPriority(status)
}

function pickBestQrAck(current, next) {
  if (!current) return next
  if (!next) return current
  return getQrAckPriority(next) >= getQrAckPriority(current) ? next : current
}

function shouldResolveQrAck(ack = {}) {
  const status = cleanString(ack.status).toLowerCase()
  const code = getBaileysStatusCode(ack.statusCode)
  return status === 'failed' || code === QR_ACK_STATUS.ERROR || code >= QR_ACK_STATUS.SERVER_ACK
}

function getQrAckError(update = {}) {
  const params = update?.update?.messageStubParameters
  if (Array.isArray(params) && params.length) {
    return {
      errorCode: cleanString(params[0]),
      errorMessage: cleanString(params.slice(1).join(' '))
    }
  }

  return {
    errorCode: '',
    errorMessage: ''
  }
}

function buildQrAckFromMessageUpdate(update = {}) {
  const messageId = cleanString(update?.key?.id)
  if (!messageId) return null

  const statusCode = getBaileysStatusCode(update?.update?.status)
  if (statusCode === null) return null

  const error = getQrAckError(update)
  const status = mapBaileysAckToMessageStatus(statusCode)

  return {
    messageId,
    remoteJid: normalizeJid(update?.key?.remoteJid),
    fromMe: update?.key?.fromMe === true,
    statusCode,
    status,
    errorCode: error.errorCode,
    errorMessage: status === 'failed'
      ? error.errorMessage || error.errorCode || 'WhatsApp rechazo el mensaje por QR'
      : '',
    messageTimestamp: update?.update?.messageTimestamp || null,
    source: 'messages.update',
    receivedAt: nowIso()
  }
}

function buildQrAckFromSendResponse(messageId, response = {}) {
  const statusCode = getBaileysStatusCode(response?.status)
  return {
    messageId,
    remoteJid: normalizeJid(response?.key?.remoteJid),
    fromMe: response?.key?.fromMe === true,
    statusCode,
    status: mapBaileysAckToMessageStatus(statusCode),
    errorCode: '',
    errorMessage: '',
    source: 'sendMessage',
    receivedAt: nowIso()
  }
}

function cleanupRecentQrAcks() {
  const now = Date.now()
  for (const [messageId, entry] of qrRecentMessageAcks.entries()) {
    if (!entry?.expiresAt || entry.expiresAt <= now) {
      qrRecentMessageAcks.delete(messageId)
    }
  }
}

function rememberQrAck(ack) {
  if (!ack?.messageId) return
  cleanupRecentQrAcks()
  const existing = qrRecentMessageAcks.get(ack.messageId)?.ack
  qrRecentMessageAcks.set(ack.messageId, {
    ack: pickBestQrAck(existing, ack),
    expiresAt: Date.now() + QR_RECENT_ACK_RETENTION_MS
  })
}

function resolveQrAckWaiter(ack) {
  if (!ack?.messageId) return
  const waiter = qrSendAckWaiters.get(ack.messageId)
  if (!waiter) return

  waiter.bestAck = pickBestQrAck(waiter.bestAck, ack)
  if (!shouldResolveQrAck(waiter.bestAck)) return

  clearTimeout(waiter.timeout)
  qrSendAckWaiters.delete(ack.messageId)
  waiter.resolve(waiter.bestAck)
}

async function updateStoredQrMessageAck(ack) {
  if (!ack?.messageId || !ack.status) return

  const rows = await db.all(`
    SELECT id, status
    FROM whatsapp_api_messages
    WHERE transport = 'qr'
      AND (ycloud_message_id = ? OR wamid = ?)
  `, [ack.messageId, ack.messageId])

  await Promise.all((rows || [])
    .filter(row => shouldUpdateStoredStatus(row.status, ack.status))
    .map(row => db.run(`
      UPDATE whatsapp_api_messages
      SET status = ?,
          error_code = CASE WHEN ? != '' THEN ? ELSE error_code END,
          error_message = CASE WHEN ? != '' THEN ? ELSE error_message END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      ack.status,
      ack.errorCode || '',
      ack.errorCode || '',
      ack.errorMessage || '',
      ack.errorMessage || '',
      row.id
    ])))
}

async function handleQrMessageUpdates(phone, updates = []) {
  const list = Array.isArray(updates) ? updates : []
  for (const update of list) {
    const ack = buildQrAckFromMessageUpdate(update)
    if (!ack) continue

    rememberQrAck(ack)
    resolveQrAckWaiter(ack)
    updateStoredQrMessageAck(ack).catch(error => {
      logger.warn(`[WhatsApp QR] No se pudo guardar ACK ${ack.messageId} (${phone.id}): ${error.message}`)
    })

    logger.info(`[WhatsApp QR] ACK ${ack.messageId} ${ack.status}${ack.errorMessage ? `: ${ack.errorMessage}` : ''}`)
  }
}

function waitForQrSendAck(messageId, response = {}) {
  const cleanMessageId = cleanString(messageId)
  if (!cleanMessageId) {
    return Promise.resolve({
      messageId: '',
      status: 'pending',
      statusCode: QR_ACK_STATUS.PENDING,
      source: 'missing-message-id',
      timedOut: true,
      receivedAt: nowIso()
    })
  }

  const initialAck = buildQrAckFromSendResponse(cleanMessageId, response)
  const recentAck = qrRecentMessageAcks.get(cleanMessageId)?.ack
  const bestImmediateAck = pickBestQrAck(recentAck, initialAck)
  if (shouldResolveQrAck(bestImmediateAck)) return Promise.resolve(bestImmediateAck)

  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      const waiter = qrSendAckWaiters.get(cleanMessageId)
      qrSendAckWaiters.delete(cleanMessageId)
      const latestAck = qrRecentMessageAcks.get(cleanMessageId)?.ack
      resolve(pickBestQrAck(latestAck, waiter?.bestAck || bestImmediateAck) || {
        messageId: cleanMessageId,
        status: 'pending',
        statusCode: QR_ACK_STATUS.PENDING,
        source: 'timeout',
        timedOut: true,
        receivedAt: nowIso()
      })
    }, QR_SEND_ACK_TIMEOUT_MS)

    qrSendAckWaiters.set(cleanMessageId, {
      timeout,
      resolve,
      bestAck: bestImmediateAck
    })
  })
}

async function finalizeQrSendResponse({ response, recipient, externalId }) {
  const accepted = assertQrSendAccepted(response, recipient.jid)
  const ack = await waitForQrSendAck(accepted.messageId, response)

  if (cleanString(ack.status).toLowerCase() === 'failed') {
    const error = new Error(ack.errorMessage || 'WhatsApp rechazo el mensaje enviado por QR')
    error.code = ack.errorCode || 'qr_send_failed'
    error.statusCode = 400
    error.qrAck = ack
    throw error
  }

  return {
    id: accepted.messageId || externalId || '',
    wamid: accepted.messageId || '',
    recipientJid: accepted.remoteJid,
    status: ack.status || 'pending',
    ack,
    raw: safeJson({ response, ack })
  }
}

function pickValue(values, key, fallback) {
  return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback
}

function getDisconnectStatusCode(update = {}) {
  const rawStatus = update.lastDisconnect?.error?.output?.statusCode
  const numericStatus = Number(rawStatus)
  return Number.isFinite(numericStatus) && numericStatus > 0 ? numericStatus : null
}

function getDisconnectMessage(update = {}) {
  return cleanString(
    update.lastDisconnect?.error?.message ||
    update.lastDisconnect?.error?.output?.payload?.message ||
    update.lastDisconnect?.error?.data?.reason ||
    ''
  )
}

function isRestartRequiredDisconnect(statusCode, lastError = '', DisconnectReason = {}) {
  const numericStatus = Number(statusCode)
  const restartCode = Number(DisconnectReason.restartRequired || 515)
  return numericStatus === 515 ||
    numericStatus === restartCode ||
    /restart required/i.test(cleanString(lastError))
}

function isLoggedOutDisconnect(statusCode, DisconnectReason = {}) {
  const numericStatus = Number(statusCode)
  const loggedOutCode = Number(DisconnectReason.loggedOut || 401)
  return numericStatus === 401 || numericStatus === loggedOutCode
}

function isBadSessionDisconnect(statusCode, DisconnectReason = {}) {
  const numericStatus = Number(statusCode)
  const badSessionCode = Number(DisconnectReason.badSession || 500)
  return numericStatus === badSessionCode
}

function isConnectionReplacedDisconnect(statusCode, DisconnectReason = {}) {
  const numericStatus = Number(statusCode)
  const replacedCode = Number(DisconnectReason.connectionReplaced || 440)
  return numericStatus === replacedCode
}

function getReconnectStatus(statusCode, lastError = '', DisconnectReason = {}) {
  return isRestartRequiredDisconnect(statusCode, lastError, DisconnectReason) ? 'restarting' : 'reconnecting'
}

function getConnectedPhoneFromSocket(sock, authState) {
  const candidates = [
    sock?.user?.id,
    authState?.creds?.me?.id,
    sock?.user?.jid,
    sock?.user?.lid,
    authState?.creds?.me?.lid
  ]

  for (const candidate of candidates) {
    const normalized = normalizeConnectedPhone(candidate)
    if (normalized) return normalized
  }

  return ''
}

function getSessionId(phoneNumberId) {
  return `qr_${phoneNumberId}`
}

async function loadBaileys() {
  if (baileysRuntime) return baileysRuntime

  try {
    const baileys = await import('@whiskeysockets/baileys')
    const makeWASocket = baileys.default || baileys.makeWASocket

    if (!makeWASocket || !baileys.initAuthCreds || !baileys.makeCacheableSignalKeyStore) {
      throw new Error('El paquete de QR no trae los metodos esperados')
    }

    baileysRuntime = {
      makeWASocket,
      BufferJSON: baileys.BufferJSON,
      DisconnectReason: baileys.DisconnectReason || {},
      Browsers: baileys.Browsers || null,
      initAuthCreds: baileys.initAuthCreds,
      makeCacheableSignalKeyStore: baileys.makeCacheableSignalKeyStore,
      proto: baileys.proto
    }
    return baileysRuntime
  } catch (error) {
    throw new Error(`La conexion por QR no esta instalada correctamente: ${error.message}`)
  }
}

async function loadQrCode() {
  try {
    return await import('qrcode')
  } catch (error) {
    logger.warn(`[WhatsApp QR] No se pudo cargar qrcode: ${error.message}`)
    return null
  }
}

async function getPhoneRow(phoneNumberId) {
  const id = cleanString(phoneNumberId)
  if (!id) throw new Error('Elige el numero que quieres conectar por QR')

  const row = await db.get(`
    SELECT *
    FROM whatsapp_api_phone_numbers
    WHERE id = ?
  `, [id])

  if (!row) {
    throw new Error('No encontramos ese numero en la conexion oficial de WhatsApp')
  }

  const expectedPhone = normalizePhoneForStorage(row.phone_number || row.display_phone_number) ||
    cleanString(row.phone_number || row.display_phone_number)

  if (!expectedPhone) {
    throw new Error('Ese numero no tiene telefono guardado para validar el QR')
  }

  return {
    ...row,
    expectedPhone
  }
}

async function resolveQrPhone({ phoneNumberId, from } = {}) {
  if (phoneNumberId) return getPhoneRow(phoneNumberId)

  const normalizedFrom = normalizePhoneForStorage(from) || cleanString(from)
  if (!normalizedFrom) throw new Error('Elige el numero que enviara por QR')

  const rows = await db.all(`
    SELECT *
    FROM whatsapp_api_phone_numbers
    WHERE qr_send_enabled = 1
  `)

  const row = rows.find(item => phoneMatches(item.phone_number || item.display_phone_number, normalizedFrom))
  if (!row) {
    throw new Error('Ese numero no tiene QR conectado para enviar mensajes')
  }

  return getPhoneRow(row.id)
}

function isFreshDate(value, ttlMs) {
  if (!value) return false
  const time = new Date(value).getTime()
  return Number.isFinite(time) && Date.now() - time < ttlMs
}

function getNonQrProfilePictureUrl(contact = {}) {
  return cleanString(contact.profile_photo_url) ||
    cleanString(contact.profile_picture_url) ||
    cleanString(contact.meta_social_profile_picture_url) ||
    cleanString(contact.avatar_url) ||
    cleanString(contact.photo_url) ||
    cleanString(contact.picture_url)
}

function buildQrProfileRawProfile({ recipient, profilePictureUrl, type, errorMessage } = {}) {
  return {
    source: 'baileys_qr',
    jid: recipient?.jid || '',
    verifiedPhone: recipient?.verifiedPhone || '',
    profilePictureUrl: profilePictureUrl || '',
    profilePictureType: type || 'preview',
    profilePictureFetchedAt: nowIso(),
    profilePictureError: errorMessage || ''
  }
}

async function upsertQrProfilePicture({
  contactId,
  phone,
  profileName,
  profilePictureUrl,
  recipient,
  type = 'preview'
} = {}) {
  const canonicalPhone = normalizePhoneForStorage(phone) || cleanString(phone)
  if (!canonicalPhone) return ''

  const rawProfile = buildQrProfileRawProfile({ recipient, profilePictureUrl, type })
  await db.run(`
    INSERT INTO whatsapp_api_contacts (
      id, contact_id, phone, profile_name, profile_picture_url,
      profile_picture_source, profile_picture_updated_at, profile_picture_error,
      raw_profile_json, first_seen_at, last_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'baileys_qr', CURRENT_TIMESTAMP, NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      contact_id = COALESCE(excluded.contact_id, whatsapp_api_contacts.contact_id),
      profile_name = COALESCE(NULLIF(excluded.profile_name, ''), whatsapp_api_contacts.profile_name),
      profile_picture_url = excluded.profile_picture_url,
      profile_picture_source = excluded.profile_picture_source,
      profile_picture_updated_at = excluded.profile_picture_updated_at,
      profile_picture_error = NULL,
      raw_profile_json = COALESCE(NULLIF(excluded.raw_profile_json, 'null'), whatsapp_api_contacts.raw_profile_json),
      last_seen_at = excluded.last_seen_at,
      updated_at = CURRENT_TIMESTAMP
  `, [
    hashId('waapi_profile', canonicalPhone),
    cleanString(contactId) || null,
    canonicalPhone,
    cleanString(profileName) || null,
    cleanString(profilePictureUrl) || null,
    safeJson(rawProfile)
  ])

  return cleanString(profilePictureUrl)
}

async function markQrProfilePictureError({ contactId, phone, profileName, errorMessage } = {}) {
  const canonicalPhone = normalizePhoneForStorage(phone) || cleanString(phone)
  if (!canonicalPhone) return

  await db.run(`
    INSERT INTO whatsapp_api_contacts (
      id, contact_id, phone, profile_name, profile_picture_source,
      profile_picture_updated_at, profile_picture_error,
      first_seen_at, last_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, 'baileys_qr', CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      contact_id = COALESCE(excluded.contact_id, whatsapp_api_contacts.contact_id),
      profile_name = COALESCE(NULLIF(excluded.profile_name, ''), whatsapp_api_contacts.profile_name),
      profile_picture_source = excluded.profile_picture_source,
      profile_picture_updated_at = excluded.profile_picture_updated_at,
      profile_picture_error = excluded.profile_picture_error,
      last_seen_at = excluded.last_seen_at,
      updated_at = CURRENT_TIMESTAMP
  `, [
    hashId('waapi_profile', canonicalPhone),
    cleanString(contactId) || null,
    canonicalPhone,
    cleanString(profileName) || null,
    cleanString(errorMessage).slice(0, 500) || null
  ])
}

function sortQrPhoneRowsForContact(rows = [], contact = {}) {
  const preferredIds = [
    contact.preferred_whatsapp_phone_number_id,
    contact.preferredWhatsAppPhoneNumberId,
    contact.last_inbound_business_phone_number_id,
    contact.lastInboundBusinessPhoneNumberId,
    contact.last_business_phone_number_id,
    contact.lastBusinessPhoneNumberId
  ].map(cleanString).filter(Boolean)

  const preferredPhones = [
    contact.last_inbound_business_phone,
    contact.lastInboundBusinessPhone,
    contact.last_business_phone,
    contact.lastBusinessPhone
  ].map(cleanString).filter(Boolean)

  const scoreRow = (row = {}) => {
    const idIndex = preferredIds.indexOf(cleanString(row.id))
    if (idIndex >= 0) return idIndex

    const rowPhone = row.phone_number || row.display_phone_number || row.qr_connected_phone
    const phoneIndex = preferredPhones.findIndex(phone => phoneMatches(rowPhone, phone))
    if (phoneIndex >= 0) return 10 + phoneIndex

    return Number(row.is_default_sender || 0) === 1 ? 50 : 100
  }

  return [...rows].sort((left, right) => scoreRow(left) - scoreRow(right))
}

async function getConnectedQrPhoneRowsForContact(contact = {}) {
  const rows = await db.all(`
    SELECT *
    FROM whatsapp_api_phone_numbers
    WHERE qr_send_enabled = 1
      AND LOWER(COALESCE(qr_status, '')) IN ('connected', 'reconnecting', 'restarting')
    ORDER BY updated_at DESC
  `)

  const sortedRows = sortQrPhoneRowsForContact(rows || [], contact)
  const fullRows = []
  for (const row of sortedRows) {
    const phone = await getPhoneRow(row.id).catch(error => {
      logger.warn(`[WhatsApp QR] No se pudo preparar numero QR ${row.id} para foto de perfil: ${error.message}`)
      return null
    })
    if (phone) fullRows.push(phone)
  }
  return fullRows
}

async function fetchQrProfilePictureForContact(contact = {}, { force = false, type = 'preview' } = {}) {
  const contactId = cleanString(contact.id)
  const toPhone = normalizePhoneForStorage(contact.phone) || cleanString(contact.phone)
  if (!toPhone) return ''

  if (!force && isFreshDate(contact.whatsapp_profile_picture_updated_at, QR_PROFILE_PICTURE_CACHE_TTL_MS)) {
    return ''
  }

  const qrPhones = await getConnectedQrPhoneRowsForContact(contact)
  if (!qrPhones.length) return ''

  for (const phone of qrPhones) {
    try {
      if (await markMissingAuthStateIfNeeded(phone)) continue
      const sock = await ensureOpenSocket(phone)
      if (typeof sock?.profilePictureUrl !== 'function') {
        throw new Error('Baileys no trae lectura de foto de perfil en esta version')
      }

      const recipient = await resolveRecipientJid(sock, toPhone)
      const profilePictureUrl = cleanString(
        await sock.profilePictureUrl(recipient.jid, type, QR_PROFILE_PICTURE_TIMEOUT_MS)
      )
      return upsertQrProfilePicture({
        contactId,
        phone: recipient.verifiedPhone || toPhone,
        profileName: contact.full_name || contact.name,
        profilePictureUrl,
        recipient,
        type
      })
    } catch (error) {
      const message = error?.message || 'No se pudo leer la foto de perfil por QR'
      logger.warn(`[WhatsApp QR] No se pudo leer foto de perfil ${toPhone} con ${phone.id}: ${message}`)
      await markQrProfilePictureError({
        contactId,
        phone: toPhone,
        profileName: contact.full_name || contact.name,
        errorMessage: message
      }).catch(dbError => {
        logger.warn(`[WhatsApp QR] No se pudo guardar error de foto de perfil ${toPhone}: ${dbError.message}`)
      })
    }
  }

  return ''
}

async function getSessionRow(phoneNumberId) {
  return db.get(`
    SELECT *
    FROM whatsapp_qr_sessions
    WHERE phone_number_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `, [phoneNumberId])
}

async function readAuthData(phoneNumberId, authKey, BufferJSON) {
  const row = await db.get(
    'SELECT value_json FROM whatsapp_qr_auth_state WHERE phone_number_id = ? AND auth_key = ?',
    [phoneNumberId, authKey]
  )
  return parseAuthJson(row?.value_json, BufferJSON)
}

async function writeAuthData(phoneNumberId, authKey, value, BufferJSON) {
  await db.run(`
    INSERT INTO whatsapp_qr_auth_state (phone_number_id, auth_key, value_json, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(phone_number_id, auth_key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = CURRENT_TIMESTAMP
  `, [phoneNumberId, authKey, safeAuthJson(value, BufferJSON)])
}

async function removeAuthData(phoneNumberId, authKey) {
  await db.run(
    'DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ? AND auth_key = ?',
    [phoneNumberId, authKey]
  )
}

async function clearAuthState(phoneNumberId) {
  await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId])
}

async function hasSavedAuthState(phoneNumberId) {
  const row = await db.get(
    'SELECT 1 as present FROM whatsapp_qr_auth_state WHERE phone_number_id = ? AND auth_key = ? LIMIT 1',
    [phoneNumberId, 'creds']
  )
  return Boolean(row)
}

async function useQrDbAuthState(phoneNumberId, { BufferJSON, initAuthCreds, proto } = {}) {
  const creds = await readAuthData(phoneNumberId, 'creds', BufferJSON) || initAuthCreds()
  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data = {}

        await Promise.all(ids.map(async (id) => {
          let value = await readAuthData(phoneNumberId, `${type}-${id}`, BufferJSON)
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
            tasks.push(value
              ? writeAuthData(phoneNumberId, authKey, value, BufferJSON)
              : removeAuthData(phoneNumberId, authKey))
          }
        }
        await Promise.all(tasks)
      },
      clear: async () => clearAuthState(phoneNumberId)
    }
  }

  return {
    state,
    saveCreds: async () => writeAuthData(phoneNumberId, 'creds', creds, BufferJSON)
  }
}

async function updatePhoneQrState(phoneNumberId, values = {}) {
  const updates = []
  const params = []

  for (const [column, value] of Object.entries(values)) {
    updates.push(`${column} = ?`)
    params.push(value)
  }

  if (!updates.length) return

  updates.push('updated_at = CURRENT_TIMESTAMP')
  params.push(phoneNumberId)
  await db.run(`
    UPDATE whatsapp_api_phone_numbers
    SET ${updates.join(', ')}
    WHERE id = ?
  `, params)
}

async function upsertSession(phone, values = {}) {
  const id = getSessionId(phone.id)
  const existing = await getSessionRow(phone.id)
  const next = {
    expectedPhone: pickValue(values, 'expectedPhone', phone.expectedPhone),
    connectedPhone: pickValue(values, 'connectedPhone', existing?.connected_phone ?? null),
    status: pickValue(values, 'status', existing?.status ?? 'disconnected'),
    qrCode: pickValue(values, 'qrCode', existing?.qr_code ?? null),
    qrCodeDataUrl: pickValue(values, 'qrCodeDataUrl', existing?.qr_code_data_url ?? null),
    consentAccepted: pickValue(values, 'consentAccepted', Number(existing?.consent_accepted || 0)),
    consentText: pickValue(values, 'consentText', existing?.consent_text ?? QR_CONSENT_TEXT),
    consentAcceptedAt: pickValue(values, 'consentAcceptedAt', existing?.consent_accepted_at ?? null),
    consentAcceptedBy: pickValue(values, 'consentAcceptedBy', existing?.consent_accepted_by ?? null),
    lastError: pickValue(values, 'lastError', existing?.last_error ?? null),
    lastConnectedAt: pickValue(values, 'lastConnectedAt', existing?.last_connected_at ?? null),
    lastDisconnectedAt: pickValue(values, 'lastDisconnectedAt', existing?.last_disconnected_at ?? null)
  }

  await db.run(`
    INSERT INTO whatsapp_qr_sessions (
      id, phone_number_id, expected_phone, connected_phone, status,
      qr_code, qr_code_data_url, consent_accepted, consent_text,
      consent_accepted_at, consent_accepted_by, last_error,
      last_connected_at, last_disconnected_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      expected_phone = excluded.expected_phone,
      connected_phone = excluded.connected_phone,
      status = excluded.status,
      qr_code = excluded.qr_code,
      qr_code_data_url = excluded.qr_code_data_url,
      consent_accepted = excluded.consent_accepted,
      consent_text = excluded.consent_text,
      consent_accepted_at = excluded.consent_accepted_at,
      consent_accepted_by = excluded.consent_accepted_by,
      last_error = excluded.last_error,
      last_connected_at = excluded.last_connected_at,
      last_disconnected_at = excluded.last_disconnected_at,
      updated_at = CURRENT_TIMESTAMP
  `, [
    id,
    phone.id,
    next.expectedPhone,
    next.connectedPhone,
    next.status,
    next.qrCode,
    next.qrCodeDataUrl,
    next.consentAccepted ? 1 : 0,
    next.consentText,
    next.consentAcceptedAt,
    next.consentAcceptedBy,
    next.lastError,
    next.lastConnectedAt,
    next.lastDisconnectedAt
  ])

  await updatePhoneQrState(phone.id, {
    qr_send_enabled: next.status === 'connected' ? 1 : Number(next.consentAccepted || 0),
    qr_status: next.status,
    qr_connected_phone: next.connectedPhone || null,
    qr_consent_accepted_at: next.consentAcceptedAt,
    qr_consent_accepted_by: next.consentAcceptedBy,
    qr_last_connected_at: next.lastConnectedAt,
    qr_last_disconnected_at: next.lastDisconnectedAt,
    qr_last_error: next.lastError
  })

  return getSessionRow(phone.id)
}

async function markMissingAuthStateIfNeeded(phone) {
  const status = cleanString(phone?.qr_status).toLowerCase()
  if (!phone?.id || status !== 'connected') return false
  if (liveSessions.get(phone.id)?.connected) return false
  if (await hasSavedAuthState(phone.id)) return false

  await upsertSession(phone, {
    status: 'bad_session',
    connectedPhone: null,
    qrCode: null,
    qrCodeDataUrl: null,
    lastError: 'La conexion QR anterior no tiene credenciales guardadas. Genera un QR nuevo para estabilizarla.',
    lastDisconnectedAt: nowIso()
  })
  return true
}

function mapSessionForResponse(row = {}) {
  if (!row) return null

  return {
    id: row.id,
    phoneNumberId: row.phone_number_id,
    expectedPhone: row.expected_phone,
    connectedPhone: row.connected_phone,
    status: row.status || 'disconnected',
    qrCode: row.qr_code || '',
    qrCodeDataUrl: row.qr_code_data_url || '',
    consentAccepted: Number(row.consent_accepted || 0) === 1,
    consentText: row.consent_text || QR_CONSENT_TEXT,
    consentAcceptedAt: row.consent_accepted_at || null,
    consentAcceptedBy: row.consent_accepted_by || null,
    lastError: row.last_error || '',
    lastConnectedAt: row.last_connected_at || null,
    lastDisconnectedAt: row.last_disconnected_at || null,
    updatedAt: row.updated_at || null
  }
}

function closeLiveSession(phoneNumberId) {
  const live = liveSessions.get(phoneNumberId)
  liveSessions.delete(phoneNumberId)

  if (!live?.sock) return

  try {
    live.sock.ev?.removeAllListeners?.('connection.update')
    live.sock.ev?.removeAllListeners?.('creds.update')
    live.sock.ev?.removeAllListeners?.('messages.update')
    live.sock.ws?.close?.()
  } catch (error) {
    logger.warn(`[WhatsApp QR] No se pudo cerrar socket ${phoneNumberId}: ${error.message}`)
  }
}

async function openSocket(phone, { requireConsent = true, reconnectAttempt = 0, openDeferred = null } = {}) {
  const existing = await getSessionRow(phone.id)
  if (requireConsent && Number(existing?.consent_accepted || 0) !== 1) {
    throw new Error('Primero acepta el riesgo de usar conexion por QR para este numero')
  }

  closeLiveSession(phone.id)

  const baileys = await loadBaileys()
  const {
    makeWASocket,
    DisconnectReason,
    Browsers,
    makeCacheableSignalKeyStore
  } = baileys
  const { state, saveCreds } = await useQrDbAuthState(phone.id, baileys)

  const deferred = openDeferred || createDeferred()
  let openSettled = false
  let currentReconnectAttempt = reconnectAttempt

  const resolveCurrentOpen = (value) => {
    if (openSettled) return
    openSettled = true
    deferred.resolve(value)
  }

  const rejectCurrentOpen = (error) => {
    if (openSettled) return
    openSettled = true
    deferred.reject(error)
  }

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger)
    },
    logger: baileysLogger,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    qrTimeout: 60000,
    browser: Browsers?.macOS ? Browsers.macOS('Desktop') : undefined
  })

  liveSessions.set(phone.id, {
    sock,
    openPromise: deferred.promise,
    connected: false
  })

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('messages.update', (updates) => {
    handleQrMessageUpdates(phone, updates).catch(error => {
      logger.warn(`[WhatsApp QR] No se pudieron procesar actualizaciones de mensajes ${phone.id}: ${error.message}`)
    })
  })
  sock.ev.on('connection.update', async (update = {}) => {
    const live = liveSessions.get(phone.id)

    if (update.qr) {
      const qrModule = await loadQrCode()
      const qrCodeDataUrl = qrModule?.toDataURL
        ? await qrModule.toDataURL(update.qr, { margin: 1, width: 320 })
        : ''

      await upsertSession(phone, {
        status: 'qr_pending',
        qrCode: update.qr,
        qrCodeDataUrl,
        lastError: null
      })
      return
    }

    if (update.connection === 'open') {
      const connectedPhone = getConnectedPhoneFromSocket(sock, state)

      if (!phoneMatches(connectedPhone, phone.expectedPhone)) {
        const message = `El QR conecto ${connectedPhone || 'otro numero'}, pero esperabamos ${phone.expectedPhone}`
        await clearAuthState(phone.id).catch(error => {
          logger.warn(`[WhatsApp QR] No se pudo limpiar auth con numero incorrecto ${phone.id}: ${error.message}`)
        })
        await upsertSession(phone, {
          status: 'number_mismatch',
          connectedPhone: connectedPhone || null,
          qrCode: null,
          qrCodeDataUrl: null,
          lastError: message,
          lastDisconnectedAt: nowIso()
        })
        rejectCurrentOpen(new Error(message))
        closeLiveSession(phone.id)
        return
      }

      if (live) live.connected = true
      currentReconnectAttempt = 0
      await upsertSession(phone, {
        status: 'connected',
        connectedPhone,
        qrCode: null,
        qrCodeDataUrl: null,
        lastError: null,
        lastConnectedAt: nowIso()
      })
      resolveCurrentOpen(sock)
      return
    }

    if (update.connection === 'close') {
      const statusCode = getDisconnectStatusCode(update)
      const lastError = getDisconnectMessage(update)
      const status = statusCode ? `disconnected_${statusCode}` : 'disconnected'
      const liveStillCurrent = liveSessions.get(phone.id)?.sock === sock

      if (!liveStillCurrent) {
        rejectCurrentOpen(new Error(lastError || 'La conexion por QR se reemplazo por otra sesion'))
        return
      }

      const loggedOut = isLoggedOutDisconnect(statusCode, DisconnectReason)
      const badSession = isBadSessionDisconnect(statusCode, DisconnectReason)
      const connectionReplaced = isConnectionReplacedDisconnect(statusCode, DisconnectReason)

      if (loggedOut || badSession || connectionReplaced) {
        await clearAuthState(phone.id).catch(error => {
          logger.warn(`[WhatsApp QR] No se pudo limpiar auth ${phone.id}: ${error.message}`)
        })

        const finalStatus = connectionReplaced ? 'connection_replaced' : loggedOut ? 'logged_out' : 'bad_session'
        const message = connectionReplaced
          ? 'Otra sesion de WhatsApp tomo el control de esta conexion. Genera un QR nuevo para retomar.'
          : badSession
            ? 'La sesion QR se dano. Genera un QR nuevo para conectarlo otra vez.'
            : lastError || 'WhatsApp cerro la sesion. Genera un QR nuevo para conectarlo otra vez.'
        await upsertSession(phone, {
          status: finalStatus,
          connectedPhone: null,
          qrCode: null,
          qrCodeDataUrl: null,
          lastError: message,
          lastDisconnectedAt: nowIso()
        })
        liveSessions.delete(phone.id)
        rejectCurrentOpen(new Error(message))
        return
      }

      if (currentReconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        const message = lastError ||
          'WhatsApp no dejo estabilizar la conexion por QR. Genera un QR nuevo e intentalo otra vez.'
        await upsertSession(phone, {
          status,
          qrCode: null,
          qrCodeDataUrl: null,
          lastError: message,
          lastDisconnectedAt: nowIso()
        })
        liveSessions.delete(phone.id)
        rejectCurrentOpen(new Error(message))
        return
      }

      const nextStatus = getReconnectStatus(statusCode, lastError, DisconnectReason)
      const nextReconnectAttempt = currentReconnectAttempt + 1
      const reconnectDelay = nextStatus === 'restarting'
        ? 0
        : Math.min(RECONNECT_BASE_DELAY_MS * (2 ** currentReconnectAttempt), RECONNECT_MAX_DELAY_MS)
      logger.info(`[WhatsApp QR] ${nextStatus === 'restarting' ? 'Reiniciando' : 'Reconectando'} socket ${phone.id} (${nextReconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`)
      await upsertSession(phone, {
        status: nextStatus,
        qrCode: null,
        qrCodeDataUrl: null,
        lastError: null,
        lastDisconnectedAt: nowIso()
      })
      liveSessions.delete(phone.id)

      const nextOpenDeferred = openSettled ? createDeferred() : deferred
      if (openSettled) {
        nextOpenDeferred.promise.catch(error => {
          logger.warn(`[WhatsApp QR] Reconexion fallida ${phone.id}: ${error.message}`)
        })
      }
      setTimeout(() => {
        openSocket(phone, {
          requireConsent: false,
          reconnectAttempt: nextReconnectAttempt,
          openDeferred: nextOpenDeferred
        }).catch(nextOpenDeferred.reject)
      }, reconnectDelay)
    }
  })

  return {
    sock,
    openPromise: deferred.promise
  }
}

async function waitForSessionReady(phoneNumberId, timeoutMs = 6000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const row = await getSessionRow(phoneNumberId)
    if (['qr_pending', 'connected', 'number_mismatch', 'restarting', 'reconnecting'].includes(row?.status)) {
      return row
    }
    await new Promise(resolve => setTimeout(resolve, 350))
  }

  return getSessionRow(phoneNumberId)
}

async function ensureOpenSocket(phone) {
  const live = liveSessions.get(phone.id)
  if (live?.sock && live.connected) return live.sock

  if (live?.openPromise) {
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('El QR se esta reconectando. Espera unos segundos e intenta mandar otra vez.')), CONNECT_TIMEOUT_MS)
    })

    await Promise.race([live.openPromise, timeout])
    const currentLive = liveSessions.get(phone.id)
    if (currentLive?.sock && currentLive.connected) return currentLive.sock
  }

  const { sock, openPromise } = await openSocket(phone)
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('El QR no esta conectado. Abre Configuracion > WhatsApp y escanea el codigo.')), CONNECT_TIMEOUT_MS)
  })

  await Promise.race([openPromise, timeout])
  const currentLive = liveSessions.get(phone.id)
  return currentLive?.sock || sock
}

export async function warmWhatsAppQrProfilePictures(contacts = [], {
  limit = QR_PROFILE_PICTURE_BATCH_LIMIT,
  force = false,
  type = 'preview'
} = {}) {
  const uniqueContacts = []
  const seenKeys = new Set()

  for (const contact of Array.isArray(contacts) ? contacts : []) {
    const phone = normalizePhoneForStorage(contact?.phone) || cleanString(contact?.phone)
    const key = cleanString(contact?.id) || phone
    if (!phone || !key || seenKeys.has(key)) continue
    if (!force && getNonQrProfilePictureUrl(contact)) continue
    if (!force && isFreshDate(contact?.whatsapp_profile_picture_updated_at, QR_PROFILE_PICTURE_CACHE_TTL_MS)) continue

    seenKeys.add(key)
    uniqueContacts.push(contact)
    if (uniqueContacts.length >= Math.max(Number(limit) || QR_PROFILE_PICTURE_BATCH_LIMIT, 1)) break
  }

  const results = new Map()
  if (!uniqueContacts.length) return results

  const warmed = await Promise.allSettled(
    uniqueContacts.map(contact => fetchQrProfilePictureForContact(contact, { force, type }))
  )

  warmed.forEach((result, index) => {
    if (result.status !== 'fulfilled') {
      const contact = uniqueContacts[index]
      logger.warn(`[WhatsApp QR] No se pudo preparar avatar QR ${contact?.id || contact?.phone || ''}: ${result.reason?.message || result.reason}`)
      return
    }

    const url = cleanString(result.value)
    if (url) results.set(cleanString(uniqueContacts[index]?.id) || cleanString(uniqueContacts[index]?.phone), url)
  })

  return results
}

export async function getWhatsAppQrSessions() {
  const rows = await db.all(`
    SELECT *
    FROM whatsapp_qr_sessions
    ORDER BY updated_at DESC
  `)

  const repairedRows = []
  for (const row of rows) {
    if (cleanString(row.status).toLowerCase() === 'connected' && !liveSessions.get(row.phone_number_id)?.connected) {
      const phone = await getPhoneRow(row.phone_number_id).catch(() => null)
      if (phone && await markMissingAuthStateIfNeeded(phone)) {
        repairedRows.push(await getSessionRow(row.phone_number_id))
        continue
      }
    }
    repairedRows.push(row)
  }

  return repairedRows.map(mapSessionForResponse)
}

export async function getWhatsAppQrSession(phoneNumberId) {
  return mapSessionForResponse(await getSessionRow(phoneNumberId))
}

export async function startWhatsAppQrConnection({ phoneNumberId, acceptedRisk, acceptedBy } = {}) {
  const phone = await getPhoneRow(phoneNumberId)
  if (!acceptedRisk) {
    throw new Error('Para usar QR necesitas aceptar el aviso de riesgo')
  }

  const acceptedAt = nowIso()
  await upsertSession(phone, {
    status: 'starting',
    consentAccepted: 1,
    consentText: QR_CONSENT_TEXT,
    consentAcceptedAt: acceptedAt,
    consentAcceptedBy: cleanString(acceptedBy) || 'usuario',
    qrCode: null,
    qrCodeDataUrl: null,
    lastError: null
  })

  openSocket(phone, { requireConsent: true })
    .then(({ openPromise }) => {
      openPromise.catch(error => {
        logger.warn(`[WhatsApp QR] Conexion pendiente/fallida ${phone.id}: ${error.message}`)
      })
    })
    .catch(error => {
      logger.warn(`[WhatsApp QR] No se pudo abrir QR ${phone.id}: ${error.message}`)
    })

  const row = await waitForSessionReady(phone.id)
  return mapSessionForResponse(row)
}

export async function disconnectWhatsAppQrConnection({ phoneNumberId } = {}) {
  const phone = await getPhoneRow(phoneNumberId)

  try {
    const live = liveSessions.get(phone.id)
    if (live?.sock?.logout) await live.sock.logout()
  } catch (error) {
    logger.warn(`[WhatsApp QR] No se pudo cerrar sesion QR ${phone.id}: ${error.message}`)
  }

  closeLiveSession(phone.id)

  await clearAuthState(phone.id)

  const row = await upsertSession(phone, {
    status: 'disconnected',
    connectedPhone: null,
    qrCode: null,
    qrCodeDataUrl: null,
    lastError: null,
    lastDisconnectedAt: nowIso()
  })

  await updatePhoneQrState(phone.id, {
    qr_send_enabled: 0,
    qr_status: 'disconnected',
    qr_connected_phone: null
  })

  return mapSessionForResponse(row)
}

export async function sendWhatsAppQrTextMessage({ phoneNumberId, from, to, text, externalId } = {}) {
  const phone = await resolveQrPhone({ phoneNumberId, from })
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const body = cleanString(text)

  if (await markMissingAuthStateIfNeeded(phone)) {
    throw new Error('El QR necesita reconectarse. Abre Configuracion > WhatsApp y genera un QR nuevo.')
  }
  if (Number(phone.qr_send_enabled || 0) !== 1) {
    throw new Error('Ese numero no tiene el envio por QR activado')
  }
  if (!toPhone) throw new Error('Falta el numero destino')
  if (!body) throw new Error('Falta el texto del mensaje')

  const sock = await ensureOpenSocket(phone)
  const recipient = await resolveRecipientJid(sock, toPhone)
  const response = await sock.sendMessage(recipient.jid, { text: body })
  const sendResult = await finalizeQrSendResponse({ response, recipient, externalId })

  return {
    id: sendResult.id,
    wamid: sendResult.wamid,
    from: phone.expectedPhone,
    to: recipient.verifiedPhone || toPhone,
    recipientJid: sendResult.recipientJid,
    type: 'text',
    text: { body },
    status: sendResult.status,
    transport: 'qr',
    createTime: nowIso(),
    raw: sendResult.raw
  }
}

export async function sendWhatsAppQrImageMessage({ phoneNumberId, from, to, imageDataUrl, imageUrl, caption, externalId } = {}) {
  const phone = await resolveQrPhone({ phoneNumberId, from })
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const cleanCaption = cleanString(caption).slice(0, 1024)

  if (await markMissingAuthStateIfNeeded(phone)) {
    throw new Error('El QR necesita reconectarse. Abre Configuracion > WhatsApp y genera un QR nuevo.')
  }
  if (Number(phone.qr_send_enabled || 0) !== 1) {
    throw new Error('Ese numero no tiene el envio por QR activado')
  }
  if (!toPhone) throw new Error('Falta el numero destino')

  const media = buildQrMediaPayload({
    dataUrl: imageDataUrl,
    url: imageUrl,
    label: 'la foto'
  })
  const sock = await ensureOpenSocket(phone)
  const recipient = await resolveRecipientJid(sock, toPhone)
  const response = await sock.sendMessage(recipient.jid, {
    image: media.content,
    ...(media.mimeType ? { mimetype: media.mimeType } : {}),
    ...(cleanCaption ? { caption: cleanCaption } : {})
  })
  const sendResult = await finalizeQrSendResponse({ response, recipient, externalId })

  return {
    id: sendResult.id,
    wamid: sendResult.wamid,
    from: phone.expectedPhone,
    to: recipient.verifiedPhone || toPhone,
    recipientJid: sendResult.recipientJid,
    type: 'image',
    image: {
      link: media.sourceUrl,
      mimeType: media.mimeType,
      ...(cleanCaption ? { caption: cleanCaption } : {})
    },
    status: sendResult.status,
    transport: 'qr',
    createTime: nowIso(),
    raw: sendResult.raw
  }
}

export async function sendWhatsAppQrAudioMessage({ phoneNumberId, from, to, audioDataUrl, audioUrl, audioPublicUrl, externalId, durationMs } = {}) {
  const phone = await resolveQrPhone({ phoneNumberId, from })
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)

  if (await markMissingAuthStateIfNeeded(phone)) {
    throw new Error('El QR necesita reconectarse. Abre Configuracion > WhatsApp y genera un QR nuevo.')
  }
  if (Number(phone.qr_send_enabled || 0) !== 1) {
    throw new Error('Ese numero no tiene el envio por QR activado')
  }
  if (!toPhone) throw new Error('Falta el numero destino')

  const media = buildQrMediaPayload({
    dataUrl: audioDataUrl,
    url: audioUrl,
    label: 'el audio'
  })
  const mimeType = normalizeVoiceNoteMimeType(inferAudioMimeType({ mimeType: media.mimeType, url: media.sourceUrl }))
  const seconds = getAudioDurationSeconds(durationMs)
  const sock = await ensureOpenSocket(phone)
  const recipient = await resolveRecipientJid(sock, toPhone)
  const response = await sock.sendMessage(recipient.jid, {
    audio: media.content,
    mimetype: mimeType,
    ptt: true,
    ...(seconds ? { seconds } : {})
  })
  const sendResult = await finalizeQrSendResponse({ response, recipient, externalId })
  const audioLink = cleanString(audioPublicUrl) || media.sourceUrl || cleanString(audioUrl)

  return {
    id: sendResult.id,
    wamid: sendResult.wamid,
    from: phone.expectedPhone,
    to: recipient.verifiedPhone || toPhone,
    recipientJid: sendResult.recipientJid,
    type: 'audio',
    audio: {
      link: audioLink,
      url: audioLink,
      mimeType,
      mimetype: mimeType,
      ptt: true,
      ...(seconds ? { seconds } : {}),
      ...(durationMs ? { durationMs } : {})
    },
    status: sendResult.status,
    transport: 'qr',
    createTime: nowIso(),
    raw: sendResult.raw
  }
}

export async function sendWhatsAppQrDocumentMessage({ phoneNumberId, from, to, documentDataUrl, documentUrl, caption, filename, mimeType, externalId } = {}) {
  const phone = await resolveQrPhone({ phoneNumberId, from })
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const cleanCaption = cleanString(caption).slice(0, 1024)
  const cleanFilename = cleanString(filename).slice(0, 180) || getFilenameFromUrl(documentUrl) || `documento-${Date.now()}.pdf`

  if (await markMissingAuthStateIfNeeded(phone)) {
    throw new Error('El QR necesita reconectarse. Abre Configuracion > WhatsApp y genera un QR nuevo.')
  }
  if (Number(phone.qr_send_enabled || 0) !== 1) {
    throw new Error('Ese numero no tiene el envio por QR activado')
  }
  if (!toPhone) throw new Error('Falta el numero destino')

  const media = buildQrMediaPayload({
    dataUrl: documentDataUrl,
    url: documentUrl,
    label: 'el documento'
  })
  const documentMimeType = inferDocumentMimeType({
    mimeType: media.mimeType || mimeType,
    url: media.sourceUrl || documentUrl,
    filename: cleanFilename
  })
  const sock = await ensureOpenSocket(phone)
  const recipient = await resolveRecipientJid(sock, toPhone)
  const response = await sock.sendMessage(recipient.jid, {
    document: media.content,
    mimetype: documentMimeType,
    fileName: cleanFilename,
    ...(cleanCaption ? { caption: cleanCaption } : {})
  })
  const sendResult = await finalizeQrSendResponse({ response, recipient, externalId })

  return {
    id: sendResult.id,
    wamid: sendResult.wamid,
    from: phone.expectedPhone,
    to: recipient.verifiedPhone || toPhone,
    recipientJid: sendResult.recipientJid,
    type: 'document',
    document: {
      link: media.sourceUrl || cleanString(documentUrl),
      url: media.sourceUrl || cleanString(documentUrl),
      mimeType: documentMimeType,
      mimetype: documentMimeType,
      filename: cleanFilename,
      ...(cleanCaption ? { caption: cleanCaption } : {})
    },
    status: sendResult.status,
    transport: 'qr',
    createTime: nowIso(),
    raw: sendResult.raw
  }
}

export { QR_CONSENT_TEXT }
