import pino from 'pino'
import crypto from 'crypto'
import { db } from '../config/database.js'
import { buildPhoneMatchCandidates, normalizePhoneDigits, normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { logger } from '../utils/logger.js'
import { acquireDistributedLock, releaseDistributedLock, renewDistributedLock } from '../utils/distributedLock.js'
import { waitForWhatsAppQrDripSlot } from './whatsappQrDripService.js'
import { downloadSafeOutboundMediaUrl } from './outboundMediaReferenceService.js'

const QR_CONSENT_TEXT = 'Acepto que esta conexión usa WhatsApp Web por QR y no la API oficial de Meta. Entiendo que puede desconectarse, fallar o poner en riesgo el número. Ristak podrá usarla para mensajes configurados cuando QR sea el canal principal, o como respaldo si hay WhatsApp API conectada y yo activo ese respaldo.'
const CONNECT_TIMEOUT_MS = 20000
const QR_RECENT_ACK_RETENTION_MS = 90000
const QR_RECENT_RISTAK_OUTBOUND_RETENTION_MS = 90000
const QR_ACK_PERSIST_RETRY_DELAYS_MS = [75, 300, 1000]
const QR_PROFILE_PICTURE_TIMEOUT_MS = 4500
const QR_PROFILE_PICTURE_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const QR_PROFILE_PICTURE_BATCH_LIMIT = 8
const WHATSAPP_PREDEFINED_LABELS = {
  paid: {
    name: 'Paid',
    predefinedId: '3'
  }
}
const RECONNECT_BASE_DELAY_MS = 2500
const CONNECTION_REPLACED_RECONNECT_BASE_DELAY_MS = 5000
const RECONNECT_MAX_DELAY_MS = 60000
const MAX_RECONNECT_ATTEMPTS = 8
const MAX_STALE_AUTH_CONNECTION_CLOSED_ATTEMPTS = 3
const QR_REPAIR_REQUIRED_STATUS = 'qr_repair_required'
const QR_SESSION_LEASE_TTL_MS = 90 * 1000
const QR_SESSION_LEASE_HEARTBEAT_MS = 30 * 1000
const QR_SESSION_LEASE_RETRY_INTERVAL_MS = 1000
const QR_SESSION_LEASE_RETRY_BUFFER_MS = 500
const QR_SESSION_LEASE_MAX_WAIT_MS = QR_SESSION_LEASE_TTL_MS + 5000
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
const VIDEO_MIME_BY_EXTENSION = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  qt: 'video/quicktime',
  '3gp': 'video/3gpp',
  '3gpp': 'video/3gpp',
  webm: 'video/webm'
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
const qrRecentMessageAcks = new Map()
const qrRecentRistakOutboundAttempts = new Map()
let baileysRuntime = null
let reconnectDelayOverrideForTest = null
const connectionOpenListeners = new Set()

// Cache de mensajes enviados para responder reintentos de descifrado
// (getMessage de Baileys). Sin esto, cuando el receptor no puede descifrar un
// mensaje y pide reenvio, no hay contenido que mandar y del otro lado se queda
// el eterno "Esperando el mensaje".
const QR_SENT_MESSAGE_CACHE_LIMIT = 500
const qrSentMessageCache = new Map()

function cacheSentQrMessage(response) {
  const id = cleanString(response?.key?.id)
  if (!id || !response?.message) return
  qrSentMessageCache.set(id, response.message)
  while (qrSentMessageCache.size > QR_SENT_MESSAGE_CACHE_LIMIT) {
    qrSentMessageCache.delete(qrSentMessageCache.keys().next().value)
  }
}

// Override de emergencia de la version de WhatsApp Web. Por default dejamos
// que Baileys elija la version compatible que trae integrada: consultar la
// version mas nueva en cada socket puede adelantar el protocolo a los protobufs
// del paquete y volver inestables sesiones sanas. Este override solo existe
// para una contingencia puntual, mientras se publica una actualizacion del SDK.
// Formato: WHATSAPP_WEB_VERSION="2,3000,1037641644"
function getWhatsAppWebVersionOverride() {
  const raw = cleanString(process.env.WHATSAPP_WEB_VERSION)
  if (!raw) return null
  return normalizeWhatsAppWebVersion(raw.split(/[.,]/))
}

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function normalizeQrLocation({ latitude, longitude, name, address } = {}) {
  const lat = Number(latitude)
  const lng = Number(longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return {
    latitude: lat,
    longitude: lng,
    name: cleanString(name),
    address: cleanString(address),
    url: `https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lng}`)}`
  }
}

function normalizeBaileysLocationMessage(locationMessage = {}) {
  return normalizeQrLocation({
    latitude: locationMessage.degreesLatitude ?? locationMessage.latitude ?? locationMessage.lat,
    longitude: locationMessage.degreesLongitude ?? locationMessage.longitude ?? locationMessage.lng,
    name: locationMessage.name,
    address: locationMessage.address
  })
}

function normalizeWhatsAppWebVersion(value) {
  if (!Array.isArray(value) || value.length !== 3) return null
  const parts = value.map(part => Number(part))
  return parts.every(part => Number.isInteger(part) && part >= 0) ? parts : null
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
    throw new Error('El archivo no tiene un formato válido para enviar por QR')
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

function inferVideoMimeType({ mimeType, url } = {}) {
  const cleanMimeType = cleanString(mimeType).toLowerCase()
  if (cleanMimeType) return cleanMimeType
  return VIDEO_MIME_BY_EXTENSION[getFileExtensionFromUrl(url)] || 'video/mp4'
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

async function buildQrMediaPayload({ dataUrl, url, label }) {
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
  const downloaded = await downloadSafeOutboundMediaUrl(cleanUrl)

  return {
    content: downloaded.buffer,
    mimeType: downloaded.mimeType,
    sourceUrl: downloaded.url
  }
}

// Extensión para el archivo temporal de entrada de ffmpeg al transcodificar una
// nota de voz por QR (ffmpeg detecta el formato por contenido; la extensión solo
// ayuda). El m4a/AAC de iOS llega como audio/mp4.
function qrAudioInputExtension(mimeType = '') {
  const clean = cleanString(mimeType).toLowerCase().split(';')[0].trim()
  switch (clean) {
    case 'audio/mp4':
    case 'audio/x-m4a':
    case 'audio/m4a':
    case 'audio/aac': return 'm4a'
    case 'audio/mpeg': return 'mp3'
    case 'audio/wav':
    case 'audio/x-wav': return 'wav'
    case 'audio/webm': return 'webm'
    case 'audio/ogg': return 'ogg'
    default: return 'audio'
  }
}

function normalizeConnectedPhone(value = '') {
  const text = cleanString(value)
  if (isLidJid(text)) return ''
  const bare = text.split('@')[0]?.split(':')[0] || text
  return normalizePhoneForStorage(bare) || bare.replace(/\D/g, '')
}

function isLidJid(value = '') {
  return /@(?:hosted\.)?lid$/i.test(cleanString(value))
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

async function resolvePhoneFromLid(sock, value = '') {
  const lid = normalizeJid(value)
  if (!isLidJid(lid)) return ''

  try {
    const pn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(lid)
    return normalizeConnectedPhone(pn)
  } catch (error) {
    logger.warn(`[WhatsApp QR] No se pudo resolver LID ${lid}: ${error.message}`)
    return ''
  }
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

function normalizeQrAttemptText(value = '') {
  return cleanString(value).toLowerCase().replace(/\s+/g, ' ').trim()
}

function qrOutboundAttemptKey({ phoneId, contactPhone, type, text = '' } = {}) {
  // WhatsApp puede devolver el mismo numero mexicano como 52... o 521...
  // dependiendo de si el evento viene del JID principal, remoteJidAlt o un
  // dispositivo vinculado. La memoria de dedupe debe usar la identidad canonica
  // que tambien usamos al guardar contactos; si se queda con digitos crudos, el
  // eco QR no encuentra el intento original y crea otro globo multimedia.
  const contact = normalizePhoneDigits(normalizePhoneForStorage(contactPhone) || contactPhone)
  const cleanType = cleanString(type || 'text').toLowerCase()
  return `${cleanString(phoneId)}|${contact}|${cleanType}|${normalizeQrAttemptText(text)}`
}

function cleanupRecentRistakQrOutboundAttempts() {
  const now = Date.now()
  for (const [key, entry] of qrRecentRistakOutboundAttempts.entries()) {
    if (!entry?.expiresAt || entry.expiresAt <= now) {
      qrRecentRistakOutboundAttempts.delete(key)
    }
  }
}

export function rememberRistakQrOutboundAttempt({ phoneId, contactPhone, type, text = '' } = {}) {
  if (!cleanString(phoneId) || !normalizePhoneDigits(contactPhone)) return
  const key = qrOutboundAttemptKey({ phoneId, contactPhone, type, text })
  cleanupRecentRistakQrOutboundAttempts()
  qrRecentRistakOutboundAttempts.set(key, {
    expiresAt: Date.now() + QR_RECENT_RISTAK_OUTBOUND_RETENTION_MS
  })
}

function isRecentRistakQrOutboundAttempt({ phoneId, contactPhone, type, text = '' } = {}) {
  cleanupRecentRistakQrOutboundAttempts()
  const key = qrOutboundAttemptKey({ phoneId, contactPhone, type, text })
  return qrRecentRistakOutboundAttempts.has(key)
}

function getJidPhoneDigits(jid = '') {
  return normalizePhoneDigits(normalizePhoneFromJid(jid))
}

async function resolveRecipientJid(sock, toPhone) {
  const candidates = buildOutboundPhoneCandidates(toPhone)
  if (!candidates.length) throw new Error('Falta el número destino')
  if (!sock?.onWhatsApp) {
    throw new Error('La conexión QR no puede verificar si el número destino existe en WhatsApp')
  }

  let results = []
  try {
    results = await sock.onWhatsApp(...candidates)
  } catch (error) {
    throw new Error(`No se pudo verificar el número destino en WhatsApp: ${error.message}`)
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

  throw new Error('Ese número no aparece como usuario activo de WhatsApp para enviar por QR')
}

function assertQrSendAccepted(response, recipientJid) {
  const messageId = cleanString(response?.key?.id)
  const remoteJid = normalizeJid(response?.key?.remoteJid)

  if (!messageId || !remoteJid) {
    throw new Error('WhatsApp QR no confirmó el envío al servidor. Intenta otra vez.')
  }

  if (recipientJid && remoteJid && remoteJid !== normalizeJid(recipientJid)) {
    throw new Error('WhatsApp QR respondió con un destinatario distinto al verificado')
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

function isConfirmedQrSendAck(ack = {}) {
  if (!ack) return false
  const status = cleanString(ack.status).toLowerCase()
  const code = getBaileysStatusCode(ack.statusCode)
  return ['delivered', 'read', 'played'].includes(status) || code >= QR_ACK_STATUS.DELIVERY_ACK
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

function buildQrFailureAckFromSendResponse(messageId, response = {}) {
  const statusCode = getBaileysStatusCode(response?.status)
  if (statusCode !== QR_ACK_STATUS.ERROR) return null

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

function hasQrReceiptTimestamp(value) {
  if (value === null || value === undefined || value === '') return false
  if (typeof value === 'object' && typeof value.toNumber === 'function') {
    return value.toNumber() > 0
  }
  return Number(value) > 0
}

function getQrReceiptStatusCode(receipt = {}) {
  if (hasQrReceiptTimestamp(receipt.playedTimestamp)) return QR_ACK_STATUS.PLAYED
  if (hasQrReceiptTimestamp(receipt.readTimestamp)) return QR_ACK_STATUS.READ
  if (hasQrReceiptTimestamp(receipt.receiptTimestamp)) return QR_ACK_STATUS.DELIVERY_ACK
  return null
}

function getQrReceiptTimestamp(receipt = {}) {
  return receipt.playedTimestamp || receipt.readTimestamp || receipt.receiptTimestamp || null
}

function buildQrAckFromMessageReceipt(update = {}) {
  const messageId = cleanString(update?.key?.id)
  if (!messageId) return null

  const receipt = update?.receipt || {}
  const statusCode = getQrReceiptStatusCode(receipt)
  if (statusCode === null) return null

  return {
    messageId,
    remoteJid: normalizeJid(update?.key?.remoteJid),
    fromMe: update?.key?.fromMe === true,
    participant: normalizeJid(receipt.userJid || update?.key?.participant),
    statusCode,
    status: mapBaileysAckToMessageStatus(statusCode),
    errorCode: '',
    errorMessage: '',
    messageTimestamp: getQrReceiptTimestamp(receipt),
    source: 'message-receipt.update',
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

async function updateStoredQrMessageAck(ack, retryAttempt = 0) {
  if (!ack?.messageId || !ack.status) return

  const rows = await db.all(`
    SELECT id, status
    FROM whatsapp_api_messages
    WHERE transport = 'qr'
      AND (ycloud_message_id = ? OR wamid = ?)
  `, [ack.messageId, ack.messageId])

  // Al responder de forma optimista el ACK puede ganarle por milisegundos al
  // INSERT del mensaje. Reintentamos en background para no perder delivered/read
  // sin volver a bloquear el request que acaba de mandar la media.
  if (!rows?.length && retryAttempt < QR_ACK_PERSIST_RETRY_DELAYS_MS.length) {
    const timeout = setTimeout(() => {
      updateStoredQrMessageAck(ack, retryAttempt + 1).catch(error => {
        logger.warn(`[WhatsApp QR] No se pudo reintentar ACK ${ack.messageId}: ${error.message}`)
      })
    }, QR_ACK_PERSIST_RETRY_DELAYS_MS[retryAttempt])
    timeout.unref?.()
    return
  }

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

    processQrAck(phone, ack)
  }
}

async function handleQrMessageReceipts(phone, updates = []) {
  const list = Array.isArray(updates) ? updates : []
  for (const update of list) {
    const ack = buildQrAckFromMessageReceipt(update)
    if (!ack) continue

    processQrAck(phone, ack)
  }
}

function processQrAck(phone, ack) {
  rememberQrAck(ack)
  updateStoredQrMessageAck(ack).catch(error => {
    logger.warn(`[WhatsApp QR] No se pudo guardar ACK ${ack.messageId} (${phone.id}): ${error.message}`)
  })

  logger.info(`[WhatsApp QR] ACK ${ack.messageId} ${ack.status}${ack.errorMessage ? `: ${ack.errorMessage}` : ''}`)
}

let whatsappApiServiceModulePromise = null
// Import dinámico para evitar el ciclo whatsappApiService -> whatsappQrService en la carga.
function loadWhatsAppApiService() {
  if (!whatsappApiServiceModulePromise) {
    whatsappApiServiceModulePromise = import('./whatsappApiService.js')
  }
  return whatsappApiServiceModulePromise
}

function unwrapBaileysMessageContent(content = {}) {
  let current = content
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current.ephemeralMessage?.message) { current = current.ephemeralMessage.message; continue }
    if (current.viewOnceMessage?.message) { current = current.viewOnceMessage.message; continue }
    if (current.viewOnceMessageV2?.message) { current = current.viewOnceMessageV2.message; continue }
    if (current.documentWithCaptionMessage?.message) { current = current.documentWithCaptionMessage.message; continue }
    if (current.deviceSentMessage?.message) { current = current.deviceSentMessage.message; continue }
    if (current.editedMessage?.message) { current = current.editedMessage.message; continue }
    if (current.protocolMessage?.editedMessage) { current = current.protocolMessage.editedMessage; continue }
    break
  }
  return current || {}
}

const BAILEYS_MACHINE_TEXT_VALUES = new Set([
  'hydratedtitletext',
  'hydratedcontenttext',
  'hydratedfootertext',
  'contenttext',
  'footertext',
  'bodytext',
  'headertext',
  'displaytext'
])

function normalizeBaileysDisplayText(value) {
  if (value && typeof value === 'object') return ''
  const text = cleanString(value)
  if (!text || text === 'null' || text === 'undefined') return ''
  const normalized = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
  return BAILEYS_MACHINE_TEXT_VALUES.has(normalized.toLowerCase()) ? '' : normalized
}

function parseQrJsonObject(value) {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function appendUniqueText(parts, value) {
  const text = normalizeBaileysDisplayText(value)
  if (text && !parts.includes(text)) parts.push(text)
}

function readStructuredText(value, keys = []) {
  if (typeof value === 'string' || typeof value === 'number') return normalizeBaileysDisplayText(value)
  if (!value || typeof value !== 'object') return ''

  for (const key of keys) {
    const direct = normalizeBaileysDisplayText(value[key])
    if (direct) return direct
  }

  for (const key of ['text', 'body', 'displayText', 'display_text', 'title', 'caption', 'contentText']) {
    const candidate = value[key]
    if (!candidate) continue
    const direct = normalizeBaileysDisplayText(candidate)
    if (direct) return direct
    const nested = readStructuredText(candidate, keys)
    if (nested) return nested
  }

  return ''
}

function looksLikeMachineButtonName(value = '') {
  const text = cleanString(value)
  return Boolean(text && /^[a-z0-9_.:-]+$/i.test(text) && !/\s/.test(text))
}

function extractBaileysButtonLabel(button = {}) {
  const params = parseQrJsonObject(button.buttonParamsJson || button.paramsJson || button.button_params_json)
  const paramsLabel = readStructuredText(params, [
    'display_text',
    'displayText',
    'cta_display_name',
    'text',
    'title',
    'label'
  ])
  if (paramsLabel) return paramsLabel

  for (const key of [
    'buttonText',
    'quickReplyButton',
    'urlButton',
    'callButton',
    'copyCodeButton',
    'reply',
    'nativeFlowInfo',
    'singleSelectReply'
  ]) {
    const label = readStructuredText(button[key], [
      'displayText',
      'display_text',
      'text',
      'title',
      'label'
    ])
    if (label) return label
  }

  const direct = readStructuredText(button, [
    'displayText',
    'display_text',
    'text',
    'title',
    'label'
  ])
  if (direct) return direct

  const name = normalizeBaileysDisplayText(button.name)
  return name && !looksLikeMachineButtonName(name) ? name : ''
}

function formatStructuredWhatsAppMessage(parts = [], buttons = []) {
  const bodyParts = []
  for (const part of parts) appendUniqueText(bodyParts, part)

  const actionLines = buttons
    .map(extractBaileysButtonLabel)
    .filter(Boolean)
    .map(label => `- ${label}`)

  return [...bodyParts, ...(actionLines.length ? [actionLines.join('\n')] : [])].join('\n\n')
}

function describeBaileysTemplateMessage(templateMessage = {}) {
  const candidates = [
    templateMessage.hydratedTemplate,
    templateMessage.hydratedFourRowTemplate,
    templateMessage.fourRowTemplate,
    templateMessage
  ].filter(value => value && typeof value === 'object')

  const parts = []
  const buttons = []

  for (const candidate of candidates) {
    appendUniqueText(parts, readStructuredText(candidate, ['hydratedTitleText', 'title', 'headerText']))
    appendUniqueText(parts, readStructuredText(candidate, ['hydratedContentText', 'contentText', 'bodyText', 'text', 'description']))
    appendUniqueText(parts, readStructuredText(candidate, ['hydratedFooterText', 'footerText', 'footer']))
    if (Array.isArray(candidate.hydratedButtons)) buttons.push(...candidate.hydratedButtons)
    if (Array.isArray(candidate.buttons)) buttons.push(...candidate.buttons)
  }

  return formatStructuredWhatsAppMessage(parts, buttons)
}

function describeBaileysButtonsMessage(buttonsMessage = {}) {
  const parts = [
    readStructuredText(buttonsMessage, ['title', 'headerText']),
    readStructuredText(buttonsMessage, ['contentText', 'text', 'bodyText', 'description']),
    readStructuredText(buttonsMessage, ['footerText', 'footer'])
  ]
  return formatStructuredWhatsAppMessage(parts, Array.isArray(buttonsMessage.buttons) ? buttonsMessage.buttons : [])
}

function describeBaileysListMessage(listMessage = {}) {
  const parts = [
    readStructuredText(listMessage, ['title']),
    readStructuredText(listMessage, ['description', 'text', 'contentText']),
    readStructuredText(listMessage, ['buttonText']),
    readStructuredText(listMessage, ['footerText', 'footer'])
  ]
  return formatStructuredWhatsAppMessage(parts)
}

function describeBaileysInteractiveMessage(interactiveMessage = {}) {
  const header = interactiveMessage.header || {}
  const body = interactiveMessage.body || {}
  const footer = interactiveMessage.footer || {}
  const nativeFlow = interactiveMessage.nativeFlowMessage || {}
  const action = interactiveMessage.action || {}
  const parts = [
    readStructuredText(header, ['title', 'subtitle', 'text']),
    readStructuredText(body, ['text', 'body']),
    readStructuredText(footer, ['text', 'footer'])
  ]
  const buttons = [
    ...(Array.isArray(nativeFlow.buttons) ? nativeFlow.buttons : []),
    ...(Array.isArray(action.buttons) ? action.buttons : [])
  ]
  return formatStructuredWhatsAppMessage(parts, buttons)
}

function getBaileysReplyText(replyMessage = {}) {
  return readStructuredText(replyMessage, [
    'selectedDisplayText',
    'selected_display_text',
    'title',
    'description',
    'body',
    'text',
    'selectedButtonId',
    'selectedRowId'
  ])
}

function describeBaileysMessageContent(content) {
  if (!content || typeof content !== 'object') return null
  const unwrapped = unwrapBaileysMessageContent(content)

  if (cleanString(unwrapped.conversation)) return { type: 'text', text: cleanString(unwrapped.conversation) }
  if (cleanString(unwrapped.extendedTextMessage?.text)) return { type: 'text', text: cleanString(unwrapped.extendedTextMessage.text) }
  if (unwrapped.templateButtonReplyMessage) return { type: 'button_reply', text: getBaileysReplyText(unwrapped.templateButtonReplyMessage) }
  if (unwrapped.buttonsResponseMessage) return { type: 'button_reply', text: getBaileysReplyText(unwrapped.buttonsResponseMessage) }
  if (unwrapped.listResponseMessage) return { type: 'list_reply', text: getBaileysReplyText(unwrapped.listResponseMessage) }
  if (unwrapped.interactiveResponseMessage) return { type: 'interactive_reply', text: getBaileysReplyText(unwrapped.interactiveResponseMessage) }
  if (unwrapped.templateMessage) return { type: 'template', text: describeBaileysTemplateMessage(unwrapped.templateMessage) }
  if (unwrapped.buttonsMessage) return { type: 'interactive', text: describeBaileysButtonsMessage(unwrapped.buttonsMessage) }
  if (unwrapped.listMessage) return { type: 'interactive', text: describeBaileysListMessage(unwrapped.listMessage) }
  if (unwrapped.interactiveMessage) return { type: 'interactive', text: describeBaileysInteractiveMessage(unwrapped.interactiveMessage) }
  if (unwrapped.imageMessage) return { type: 'image', text: cleanString(unwrapped.imageMessage.caption) }
  if (unwrapped.videoMessage) return { type: 'video', text: cleanString(unwrapped.videoMessage.caption) }
  if (unwrapped.audioMessage) return { type: 'audio', text: '' }
  if (unwrapped.documentMessage) {
    return { type: 'document', text: cleanString(unwrapped.documentMessage.caption || unwrapped.documentMessage.fileName) }
  }
  if (unwrapped.stickerMessage) return { type: 'sticker', text: '' }
  if (unwrapped.locationMessage) {
    const location = normalizeBaileysLocationMessage(unwrapped.locationMessage)
    return {
      type: 'location',
      text: cleanString(unwrapped.locationMessage.name || unwrapped.locationMessage.address || 'Ubicación'),
      ...(location ? { location } : {})
    }
  }
  if (unwrapped.reactionMessage) {
    const reaction = unwrapped.reactionMessage
    const emoji = cleanString(reaction.text || reaction.emoji)
    const targetId = cleanString(reaction.key?.id || reaction.messageKey?.id)
    return {
      type: 'reaction',
      text: emoji || 'Reacción',
      reaction: {
        emoji,
        message_id: targetId
      },
      context: targetId ? { id: targetId } : null
    }
  }
  if (unwrapped.contactMessage || unwrapped.contactsArrayMessage) {
    return { type: 'contacts', text: cleanString(unwrapped.contactMessage?.displayName) }
  }

  // Eventos de protocolo, encuestas y demás no forman parte del historial de chat.
  return null
}

async function getQrChatContactPhone(sock, message = {}) {
  const key = message.key || {}
  const remoteJid = cleanString(key.remoteJid)
  if (!remoteJid) return ''
  if (remoteJid === 'status@broadcast') return ''
  if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast') || remoteJid.endsWith('@newsletter')) return ''

  const candidates = isLidJid(remoteJid)
    ? [remoteJid, cleanString(key.remoteJidAlt), cleanString(key.senderPn), cleanString(key.participantPn)]
    : [remoteJid]

  for (const candidate of candidates) {
    if (!candidate || isLidJid(candidate)) continue
    const phone = normalizePhoneFromJid(candidate)
    if (phone) return phone
  }

  for (const candidate of candidates) {
    if (!isLidJid(candidate)) continue
    const phone = await resolvePhoneFromLid(sock, candidate)
    if (phone) return phone
  }

  return ''
}

function getBaileysMessageTimestampIso(message = {}) {
  const raw = message.messageTimestamp
  let seconds = 0
  if (raw && typeof raw === 'object') {
    seconds = typeof raw.toNumber === 'function' ? raw.toNumber() : Number(raw.low || 0)
  } else {
    seconds = Number(raw) || 0
  }
  return seconds > 0 ? new Date(seconds * 1000).toISOString() : nowIso()
}

// Tipos de mensaje QR que traen un archivo descargable (el audio de voz llega como 'audio').
const QR_DOWNLOADABLE_MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker'])

// Logger mínimo compatible con Baileys para `downloadMediaMessage` (evita ruido y crashes
// si el paquete intenta usar métodos de pino que nuestro logger no expone).
const BAILEYS_MEDIA_LOGGER = {
  level: 'silent',
  child() { return BAILEYS_MEDIA_LOGGER },
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}
}

function longLikeToNumber(value) {
  if (value == null) return 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') { const n = Number(value); return Number.isFinite(n) ? n : 0 }
  if (typeof value.toNumber === 'function') { try { return value.toNumber() } catch { return 0 } }
  if (typeof value.low === 'number') {
    const high = typeof value.high === 'number' ? value.high : 0
    return high * 4294967296 + (value.low >>> 0)
  }
  return 0
}

function fallbackMimeForMediaType(type) {
  switch (type) {
    case 'image': return 'image/jpeg'
    case 'video': return 'video/mp4'
    case 'audio': return 'audio/ogg'
    case 'sticker': return 'image/webp'
    default: return 'application/octet-stream'
  }
}

// Extrae el nodo multimedia del contenido Baileys (ya desenvuelto de ephemeral/viewOnce/etc.).
function getBaileysMediaNode(content) {
  const c = unwrapBaileysMessageContent(content)
  if (c.imageMessage) return { type: 'image', node: c.imageMessage }
  if (c.videoMessage) return { type: 'video', node: c.videoMessage }
  if (c.audioMessage) return { type: 'audio', node: c.audioMessage }
  if (c.documentMessage) return { type: 'document', node: c.documentMessage }
  if (c.stickerMessage) return { type: 'sticker', node: c.stickerMessage }
  return null
}

// Descarga (desencripta) la media de un mensaje de WhatsApp Web y la rehospeda en nuestro
// storage (Bunny) bajo el módulo 'chat'. Devuelve el descriptor listo para persistir, o null
// si no hay media, excede límites o falla la descarga (el mensaje se guarda sin archivo).
async function downloadAndStoreQrInboundMedia({ phone, message, content, messageType, wamid }) {
  const mediaInfo = getBaileysMediaNode(content)
  if (!mediaInfo?.node) return null
  const { type, node } = mediaInfo

  const runtime = await loadBaileys()
  const downloadMediaMessage = runtime?.downloadMediaMessage
  if (typeof downloadMediaMessage !== 'function') {
    logger.warn('[WhatsApp QR] El paquete de QR no expone downloadMediaMessage; se omite la media entrante')
    return null
  }

  const api = await loadWhatsAppApiService()
  const limitBytes = api.getInboundMediaLimitBytes(type)
  const declaredSize = longLikeToNumber(node.fileLength)
  if (declaredSize && declaredSize > limitBytes) {
    logger.warn(`[WhatsApp QR] Media entrante ${wamid} excede el límite permitido (${declaredSize} > ${limitBytes}); se omite`)
    return null
  }

  const sock = liveSessions.get(phone.id)?.sock || null
  const buffer = await downloadMediaMessage(
    message,
    'buffer',
    {},
    {
      logger: BAILEYS_MEDIA_LOGGER,
      reuploadRequest: typeof sock?.updateMediaMessage === 'function'
        ? sock.updateMediaMessage.bind(sock)
        : undefined
    }
  )

  if (!buffer?.length) return null
  if (buffer.length > limitBytes) {
    logger.warn(`[WhatsApp QR] Media entrante ${wamid} supera el límite tras descargar (${buffer.length} > ${limitBytes}); se omite`)
    return null
  }

  const mimeType = cleanString(node.mimetype) || fallbackMimeForMediaType(type)
  const filename = api.buildInboundMediaFilename({
    mediaId: wamid,
    messageType: type,
    mimeType,
    filename: cleanString(node.fileName)
  })
  const seconds = longLikeToNumber(node.seconds)
  const durationMs = seconds > 0 ? seconds * 1000 : null

  const { uploadMediaAsset } = await import('./mediaStorageService.js')
  const asset = await uploadMediaAsset({
    buffer,
    mimeType,
    filename,
    module: 'chat',
    isPublic: true,
    skipCompression: true,
    metadata: {
      source: 'whatsapp_qr_inbound_media',
      whatsappMessageType: type,
      qrPhoneNumberId: phone.id,
      wamid
    }
  })

  return {
    mediaUrl: asset.publicUrl,
    mediaMimeType: asset.mimeType || mimeType,
    mediaFilename: asset.originalFilename || asset.storedFilename || filename,
    mediaDurationMs: durationMs,
    mediaAssetId: asset.id
  }
}

async function handleQrIncomingMessages(phone, upsert = {}, sock = null, { historyImport = false, profileNames = null } = {}) {
  const type = cleanString(upsert.type)
  if (type && type !== 'notify' && type !== 'append') return

  const messages = Array.isArray(upsert.messages) ? upsert.messages : []
  for (const message of messages) {
    try {
      const key = message?.key || {}
      const wamid = cleanString(key.id)
      const contactPhone = await getQrChatContactPhone(sock, message)
      if (!wamid || !contactPhone) continue

      const content = describeBaileysMessageContent(message?.message)
      if (!content) continue

      if (key.fromMe && isRecentRistakQrOutboundAttempt({
        phoneId: phone.id,
        contactPhone,
        type: content.type,
        text: content.text
      })) {
        logger.info(`[WhatsApp QR] Mensaje saliente ${wamid} omitido del sync porque lo está confirmando Ristak (${phone.id})`)
        continue
      }

      const { captureQrChatMessage } = await loadWhatsAppApiService()
      const result = await captureQrChatMessage({
        phoneNumberId: phone.id,
        businessPhone: phone.expectedPhone,
        direction: key.fromMe ? 'outbound' : 'inbound',
        wamid,
        messageType: content.type,
        text: content.text,
        profileName: cleanString(message.pushName) || cleanString(profileNames?.get(normalizeJid(message?.key?.remoteJid))),
        contactPhone,
        timestamp: getBaileysMessageTimestampIso(message),
        raw: {
          key: message.key || null,
          message: message.message || null,
          ...(content.location ? { location: content.location } : {}),
          ...(content.context ? { context: content.context } : {}),
          ...(content.reaction ? { reaction: content.reaction } : {})
        },
        // En vivo solo se ejecuta si la API oficial no cubre el inbound. En un
        // bloque histórico sí descarga lo que el teléfono entregue, incluso si la
        // API está activa hoy, porque ese archivo puede ser anterior a la conexión.
        resolveInboundMedia: QR_DOWNLOADABLE_MEDIA_TYPES.has(content.type)
          ? () => downloadAndStoreQrInboundMedia({
              phone,
              message,
              content: message?.message,
              messageType: content.type,
              wamid
            })
          : null,
        historyImport
      })

      if (!result?.skipped && result?.isNew) {
        logger.info(`[WhatsApp QR] Mensaje ${key.fromMe ? 'saliente' : 'entrante'} capturado por WhatsApp Web (${phone.id}): ${wamid}`)
      }
    } catch (error) {
      logger.warn(`[WhatsApp QR] No se pudo capturar mensaje de WhatsApp Web (${phone.id}): ${error.message}`)
    }
  }
}

async function handleQrHistorySync(phone, history = {}, sock = null) {
  const messages = Array.isArray(history.messages) ? history.messages : []
  if (!messages.length) return

  const profileNames = new Map(
    (Array.isArray(history.contacts) ? history.contacts : [])
      .map(contact => [
        normalizeJid(contact?.id),
        cleanString(contact?.notify || contact?.name || contact?.verifiedName)
      ])
      .filter(([jid]) => Boolean(jid))
  )

  await handleQrIncomingMessages(phone, { type: 'append', messages }, sock, {
    historyImport: true,
    profileNames
  })

  logger.info(
    `[WhatsApp QR] Historial recibido para ${phone.id}: ${messages.length} mensajes` +
    `${history.progress != null ? `, progreso ${history.progress}%` : ''}` +
    `${history.isLatest ? ', último bloque' : ''}`
  )
}

async function handleQrMessageReactions(phone, updates = [], sock = null) {
  const messages = (Array.isArray(updates) ? updates : []).map(update => {
    const reaction = update?.reaction || {}
    const reactionKey = reaction.key || {}
    const senderTimestampMs = longLikeToNumber(reaction.senderTimestampMs)
    return {
      key: reactionKey,
      messageTimestamp: senderTimestampMs > 0 ? Math.floor(senderTimestampMs / 1000) : undefined,
      message: {
        reactionMessage: {
          ...reaction,
          // En el evento separado, `update.key` es el mensaje objetivo y
          // `reaction.key` identifica el evento de reacción.
          key: update?.key || null
        }
      }
    }
  }).filter(message => cleanString(message.key?.id))

  if (!messages.length) return
  await handleQrIncomingMessages(phone, { type: 'notify', messages }, sock)
}

async function finalizeQrSendResponse({ response, recipient, externalId }) {
  cacheSentQrMessage(response)
  const accepted = assertQrSendAccepted(response, recipient.jid)
  const immediateAck = pickBestQrAck(
    qrRecentMessageAcks.get(accepted.messageId)?.ack,
    buildQrFailureAckFromSendResponse(accepted.messageId, response)
  )

  if (cleanString(immediateAck?.status).toLowerCase() === 'failed') {
    const error = new Error(immediateAck.errorMessage || 'WhatsApp rechazo el mensaje enviado por QR')
    error.code = immediateAck.errorCode || 'qr_send_failed'
    error.statusCode = 400
    error.qrAck = immediateAck
    throw error
  }

  // Baileys ya acepto el mensaje al devolver key.id. No bloqueamos la respuesta
  // HTTP esperando hasta 20 s por delivered/read: esos ACK siguen entrando por
  // messages.update/message-receipt.update y actualizan la fila en background.
  // Es el mismo contrato optimista de las apps de mensajeria: aceptar rapido y
  // reconciliar entrega despues. Un fallo sincronico real se conserva arriba.
  const confirmed = isConfirmedQrSendAck(immediateAck)
  const resolvedStatus = confirmed ? (immediateAck.status || 'delivered') : 'sent'

  return {
    id: accepted.messageId || externalId || '',
    wamid: accepted.messageId || '',
    recipientJid: accepted.remoteJid,
    status: resolvedStatus,
    ack: immediateAck || null,
    raw: safeJson({ response, ack: immediateAck || null, ackPending: !confirmed })
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

function isConnectionClosedDisconnect(statusCode, lastError = '', DisconnectReason = {}) {
  const numericStatus = Number(statusCode)
  const closedCode = Number(DisconnectReason.connectionClosed || 428)
  return numericStatus === 428 ||
    numericStatus === closedCode ||
    /connection closed/i.test(cleanString(lastError))
}

function isConnectionReplacedDisconnect(statusCode, lastError = '', DisconnectReason = {}) {
  const numericStatus = Number(statusCode)
  const replacedCode = Number(DisconnectReason.connectionReplaced || 440)
  return numericStatus === replacedCode ||
    /(?:connection replaced|conflict|another\s+(?:session|device))/i.test(cleanString(lastError))
}

function getReconnectStatus(statusCode, lastError = '', DisconnectReason = {}) {
  return isRestartRequiredDisconnect(statusCode, lastError, DisconnectReason) ? 'restarting' : 'reconnecting'
}

function getReconnectDelayMs(statusCode, lastError = '', reconnectAttempt = 0, DisconnectReason = {}) {
  if (reconnectDelayOverrideForTest !== null) return reconnectDelayOverrideForTest
  if (isRestartRequiredDisconnect(statusCode, lastError, DisconnectReason)) return 0

  const baseDelay = isConnectionReplacedDisconnect(statusCode, lastError, DisconnectReason)
    ? CONNECTION_REPLACED_RECONNECT_BASE_DELAY_MS
    : RECONNECT_BASE_DELAY_MS
  return Math.min(baseDelay * (2 ** reconnectAttempt), RECONNECT_MAX_DELAY_MS) +
    Math.floor(Math.random() * 1500)
}

function requiresExplicitQrRepair(session = {}) {
  const status = cleanString(session?.status).toLowerCase()
  return status === QR_REPAIR_REQUIRED_STATUS ||
    status === 'qr_error' ||
    status === 'disconnected' ||
    status.startsWith('disconnected_')
}

async function getConnectedPhoneFromSocket(sock, authState) {
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

  for (const candidate of candidates) {
    const resolved = await resolvePhoneFromLid(sock, candidate)
    if (resolved) return resolved
  }

  return ''
}

function getSessionId(phoneNumberId) {
  return `qr_${phoneNumberId}`
}

function getSessionLeaseName(phoneNumberId) {
  return `whatsapp-qr-session:${phoneNumberId}`
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseSqlUtcTimestampMs(value) {
  const raw = cleanString(value)
  if (!raw) return 0

  const iso = raw
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1')
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : 0
}

async function renewQrSessionLease(lease) {
  return renewDistributedLock(lease)
}

async function releaseQrSessionLease(lease) {
  return releaseDistributedLock(lease)
}

async function getQrSessionLeaseSnapshot(phoneNumberId) {
  return db.get(`
    SELECT owner_id, locked_until
    FROM distributed_locks
    WHERE name = ?
  `, [getSessionLeaseName(phoneNumberId)]).catch(() => null)
}

async function waitForQrSessionLeaseRetry(phoneNumberId, startedAt) {
  const elapsedMs = Date.now() - startedAt
  const remainingWaitMs = QR_SESSION_LEASE_MAX_WAIT_MS - elapsedMs
  if (remainingWaitMs <= 0) return false

  const snapshot = await getQrSessionLeaseSnapshot(phoneNumberId)
  const lockedUntilMs = parseSqlUtcTimestampMs(snapshot?.locked_until)
  const untilExpiryMs = lockedUntilMs ? lockedUntilMs - Date.now() : 0
  const waitMs = Math.max(
    250,
    Math.min(
      QR_SESSION_LEASE_RETRY_INTERVAL_MS,
      remainingWaitMs,
      untilExpiryMs > 0 ? untilExpiryMs + QR_SESSION_LEASE_RETRY_BUFFER_MS : QR_SESSION_LEASE_RETRY_INTERVAL_MS
    )
  )

  await sleep(waitMs)
  return true
}

async function acquireQrSessionLease(phoneNumberId, { waitForRelease = false, reason = 'socket' } = {}) {
  const existingLease = liveSessions.get(phoneNumberId)?.lease
  if (existingLease && await renewQrSessionLease(existingLease)) {
    return existingLease
  }

  const startedAt = Date.now()
  let didLogWait = false

  while (true) {
    const { acquired, lock } = await acquireDistributedLock(
      getSessionLeaseName(phoneNumberId),
      QR_SESSION_LEASE_TTL_MS
    )
    if (acquired) return lock

    if (!waitForRelease || !(await waitForQrSessionLeaseRetry(phoneNumberId, startedAt))) {
      const error = new Error('Esta conexión QR ya está activa en otra instancia. El watchdog no abrirá otro socket para no desincronizar WhatsApp.')
      error.code = 'whatsapp_qr_session_locked'
      throw error
    }

    if (!didLogWait) {
      didLogWait = true
      logger.warn(`[WhatsApp QR] Esperando lease activo de sesión ${phoneNumberId} para ${reason}; se reintentará el envío sin mostrar error al chat`)
    }
  }
}

function startQrSessionLeaseHeartbeat(phoneNumberId, lease) {
  if (!lease || lease.failOpen) return null

  const timer = setInterval(() => {
    const live = liveSessions.get(phoneNumberId)
    if (!live || live.lease !== lease) return

    renewQrSessionLease(lease)
      .then((renewed) => {
        if (renewed) return
        logger.warn(`[WhatsApp QR] Se perdió el lease de sesión ${phoneNumberId}; cerrando socket local para no reemplazar otra instancia`)
        closeLiveSession(phoneNumberId, { releaseLease: false })
      })
      .catch((error) => {
        logger.warn(`[WhatsApp QR] No se pudo renovar lease ${phoneNumberId}: ${error.message}`)
        closeLiveSession(phoneNumberId, { releaseLease: false })
      })
  }, QR_SESSION_LEASE_HEARTBEAT_MS)

  timer.unref?.()
  return timer
}

async function loadBaileys() {
  if (baileysRuntime) return baileysRuntime

  try {
    const baileys = await import('@whiskeysockets/baileys')
    const makeWASocket = baileys.default || baileys.makeWASocket

    if (!makeWASocket || !baileys.initAuthCreds || !baileys.makeCacheableSignalKeyStore) {
      throw new Error('El paquete de QR no trae los métodos esperados')
    }

    baileysRuntime = {
      makeWASocket,
      BufferJSON: baileys.BufferJSON,
      DisconnectReason: baileys.DisconnectReason || {},
      Browsers: baileys.Browsers || null,
      DEFAULT_CONNECTION_CONFIG: baileys.DEFAULT_CONNECTION_CONFIG || null,
      defaultConnectionVersion: baileys.DEFAULT_CONNECTION_CONFIG?.version || null,
      initAuthCreds: baileys.initAuthCreds,
      makeCacheableSignalKeyStore: baileys.makeCacheableSignalKeyStore,
      downloadMediaMessage: baileys.downloadMediaMessage,
      proto: baileys.proto
    }
    return baileysRuntime
  } catch (error) {
    throw new Error(`La conexión por QR no está instalada correctamente: ${error.message}`)
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

export function setBaileysRuntimeForTest(runtime = null) {
  baileysRuntime = runtime || null
}

export function setWhatsAppQrReconnectDelayForTest(delayMs = null) {
  const numericDelay = Number(delayMs)
  reconnectDelayOverrideForTest = Number.isFinite(numericDelay) && numericDelay >= 0
    ? numericDelay
    : null
}

export function resetWhatsAppQrServiceForTest() {
  for (const phoneNumberId of [...liveSessions.keys()]) {
    closeLiveSession(phoneNumberId)
  }
  baileysRuntime = null
  reconnectDelayOverrideForTest = null
  qrRecentMessageAcks.clear()
  qrRecentRistakOutboundAttempts.clear()
  connectionOpenListeners.clear()
}

export function onWhatsAppQrConnectionOpen(listener) {
  if (typeof listener !== 'function') return () => {}
  connectionOpenListeners.add(listener)
  return () => connectionOpenListeners.delete(listener)
}

function notifyWhatsAppQrConnectionOpen(payload = {}) {
  for (const listener of connectionOpenListeners) {
    Promise.resolve()
      .then(() => listener(payload))
      .catch(error => {
        logger.warn(`[WhatsApp QR] Listener de conexión abierta falló: ${error.message}`)
      })
  }
}

export async function shutdownWhatsAppQrService({ reason = 'shutdown' } = {}) {
  const sessions = [...liveSessions.entries()].map(([phoneNumberId, live]) => ({
    phoneNumberId,
    lease: live?.lease
  }))

  for (const { phoneNumberId } of sessions) {
    closeLiveSession(phoneNumberId, { releaseLease: false })
  }

  const results = await Promise.allSettled(
    sessions
      .filter(({ lease }) => Boolean(lease))
      .map(({ lease }) => releaseQrSessionLease(lease))
  )
  const released = results.filter(result => result.status === 'fulfilled' && result.value).length

  if (sessions.length) {
    logger.info(`[WhatsApp QR] ${reason}: ${sessions.length} sesión(es) QR cerradas, ${released} lease(s) liberado(s)`)
  }

  return { closed: sessions.length, released }
}

async function getPhoneRow(phoneNumberId) {
  const id = cleanString(phoneNumberId)
  if (!id) throw new Error('Elige el número que quieres conectar por QR')

  const row = await db.get(`
    SELECT *
    FROM whatsapp_api_phone_numbers
    WHERE id = ?
  `, [id])

  if (!row) {
    throw new Error('No encontramos ese número en la conexión oficial de WhatsApp')
  }

  const expectedPhone = normalizePhoneForStorage(row.phone_number || row.display_phone_number) ||
    cleanString(row.phone_number || row.display_phone_number)
  const provider = cleanString(row.provider).toLowerCase()
  const isQrOnlyPendingPhone = provider === 'qr' && Number(row.api_send_enabled || 0) === 0

  if (!expectedPhone && !isQrOnlyPendingPhone) {
    throw new Error('Ese número no tiene teléfono guardado para validar el QR')
  }

  return {
    ...row,
    expectedPhone
  }
}

async function findPhoneRowByConnectedPhone(phoneNumber, excludePhoneNumberId = '') {
  const normalizedPhone = normalizePhoneForStorage(phoneNumber) || cleanString(phoneNumber)
  if (!normalizedPhone) return null

  const rows = await db.all(`
    SELECT *
    FROM whatsapp_api_phone_numbers
    WHERE id != ?
  `, [cleanString(excludePhoneNumberId)])

  return (rows || []).find(row =>
    phoneMatches(row.phone_number || row.display_phone_number || row.qr_connected_phone, normalizedPhone)
  ) || null
}

async function promoteStandaloneQrPhone(phone, connectedPhone) {
  const normalizedPhone = normalizePhoneForStorage(connectedPhone) || cleanString(connectedPhone)
  if (!normalizedPhone) {
    throw new Error('WhatsApp no entregó el número conectado. Genera otro QR e inténtalo de nuevo.')
  }

  const expectedPhone = normalizePhoneForStorage(phone.phone_number || phone.display_phone_number) ||
    cleanString(phone.phone_number || phone.display_phone_number)
  if (expectedPhone) {
    return {
      ...phone,
      expectedPhone
    }
  }

  if (cleanString(phone.provider).toLowerCase() !== 'qr') {
    throw new Error('Ese número no tiene teléfono guardado para validar el QR')
  }

  const duplicate = await findPhoneRowByConnectedPhone(normalizedPhone, phone.id)
  if (duplicate?.id) {
    throw new Error('Ese número ya existe en WhatsApp API. Conecta su QR desde la fila del número para validar que coincida.')
  }

  const displayPhone = cleanString(connectedPhone) || normalizedPhone
  const currentVerifiedName = cleanString(phone.verified_name)
  await db.run(`
    UPDATE whatsapp_api_phone_numbers
    SET phone_number = ?,
        display_phone_number = COALESCE(NULLIF(display_phone_number, ''), ?),
        verified_name = COALESCE(NULLIF(verified_name, ''), 'WhatsApp QR'),
        status = COALESCE(NULLIF(status, ''), 'QR_ONLY'),
        raw_payload_json = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    normalizedPhone,
    displayPhone,
    safeJson({
      source: 'qr_detected',
      connectedPhone: normalizedPhone,
      detectedAt: nowIso()
    }),
    phone.id
  ])

  return {
    ...phone,
    phone_number: normalizedPhone,
    display_phone_number: cleanString(phone.display_phone_number) || displayPhone,
    verified_name: currentVerifiedName || 'WhatsApp QR',
    expectedPhone: normalizedPhone
  }
}

async function resolveQrPhone({ phoneNumberId, from } = {}) {
  if (phoneNumberId) return getPhoneRow(phoneNumberId)

  const normalizedFrom = normalizePhoneForStorage(from) || cleanString(from)
  if (!normalizedFrom) throw new Error('Elige el número que enviara por QR')

  const rows = await db.all(`
    SELECT *
    FROM whatsapp_api_phone_numbers
    WHERE qr_send_enabled = 1
  `)

  const row = rows.find(item => phoneMatches(item.phone_number || item.display_phone_number, normalizedFrom))
  if (!row) {
    throw new Error('Ese número no tiene QR conectado para enviar mensajes')
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

// Rehospeda (best-effort) el avatar de WhatsApp QR al Bunny para que no caduque.
// Devuelve la URL a guardar (Bunny si se pudo, cruda si no). Nunca lanza.
async function rehostQrAvatarUrl(canonicalPhone, profilePictureUrl) {
  const raw = cleanString(profilePictureUrl)
  try {
    const currentRow = await db
      .get('SELECT profile_picture_url FROM whatsapp_api_contacts WHERE phone = ?', [canonicalPhone])
      .catch(() => null)
    const { resolveAvatarForPersist } = await import('./mediaStorageService.js')
    const resolved = await resolveAvatarForPersist({
      incomingUrl: raw,
      currentUrl: currentRow?.profile_picture_url || '',
      channel: 'whatsapp',
      filename: `wa-${canonicalPhone}.jpg`
    })
    return resolved?.url || raw
  } catch {
    return raw
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

  // Rehospedar el avatar al Bunny (una vez por contacto) para que no caduque.
  // Best-effort: si falla o no hay Bunny, se guarda la URL cruda como antes.
  const storedPictureUrl = await rehostQrAvatarUrl(canonicalPhone, profilePictureUrl)

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
    cleanString(storedPictureUrl) || null,
    safeJson(rawProfile)
  ])

  return cleanString(storedPictureUrl)
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
      profile_picture_url = CASE
        WHEN LOWER(COALESCE(whatsapp_api_contacts.profile_picture_url, '')) LIKE 'https://pps.whatsapp.net/%'
          OR LOWER(COALESCE(whatsapp_api_contacts.profile_picture_url, '')) LIKE 'http://pps.whatsapp.net/%'
        THEN NULL
        ELSE whatsapp_api_contacts.profile_picture_url
      END,
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
      logger.warn(`[WhatsApp QR] No se pudo preparar número QR ${row.id}: ${error.message}`)
      return null
    })
    if (phone) fullRows.push(phone)
  }
  return fullRows
}

async function upsertQrLabel(phoneNumberId, label = {}) {
  const phoneId = cleanString(phoneNumberId)
  const labelId = cleanString(label.id || label.labelId)
  if (!phoneId || !labelId) return

  await db.run(`
    INSERT INTO whatsapp_qr_labels (
      phone_number_id, label_id, name, color, predefined_id, deleted,
      raw_payload_json, first_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(phone_number_id, label_id) DO UPDATE SET
      name = excluded.name,
      color = excluded.color,
      predefined_id = excluded.predefined_id,
      deleted = excluded.deleted,
      raw_payload_json = excluded.raw_payload_json,
      updated_at = CURRENT_TIMESTAMP
  `, [
    phoneId,
    labelId,
    cleanString(label.name) || null,
    Number.isFinite(Number(label.color)) ? Number(label.color) : null,
    cleanString(label.predefinedId || label.predefined_id) || null,
    label.deleted ? 1 : 0,
    safeJson(label)
  ])
}

async function handleQrLabelEdit(phone, label = {}) {
  await upsertQrLabel(phone?.id, label)
}

async function getQrPaidLabelIds(phoneNumberId) {
  const phoneId = cleanString(phoneNumberId)
  if (!phoneId) return []

  const paid = WHATSAPP_PREDEFINED_LABELS.paid
  const rows = await db.all(`
    SELECT label_id, name, predefined_id
    FROM whatsapp_qr_labels
    WHERE phone_number_id = ?
      AND COALESCE(deleted, 0) = 0
      AND (
        predefined_id = ?
        OR LOWER(COALESCE(name, '')) IN ('paid', 'pagado')
      )
    ORDER BY
      CASE WHEN predefined_id = ? THEN 0 ELSE 1 END,
      updated_at DESC
  `, [phoneId, paid.predefinedId, paid.predefinedId]).catch(error => {
    logger.warn(`[WhatsApp QR] No se pudieron leer labels QR ${phoneId}: ${error.message}`)
    return []
  })

  return [...new Set((rows || []).map(row => cleanString(row.label_id)).filter(Boolean))]
}

export async function applyWhatsAppQrPaidLabelForContact(contact = {}) {
  const contactId = cleanString(contact.id)
  const toPhone = normalizePhoneForStorage(contact.phone) || cleanString(contact.phone)
  if (!contactId) return { applied: false, reason: 'missing_contact_id' }
  if (!toPhone) return { applied: false, reason: 'missing_phone' }

  const qrPhones = (await getConnectedQrPhoneRowsForContact(contact))
    .filter(phone => cleanString(phone.qr_status).toLowerCase() === 'connected')
  if (!qrPhones.length) return { applied: false, reason: 'qr_not_connected' }

  for (const phone of qrPhones) {
    try {
      if (await markMissingAuthStateIfNeeded(phone)) continue

      const sock = await ensureOpenSocket(phone)
      if (typeof sock?.addChatLabel !== 'function') {
        throw new Error('Baileys no trae soporte para aplicar etiquetas de chat')
      }

      const recipient = await resolveRecipientJid(sock, toPhone)
      const labelIds = await getQrPaidLabelIds(phone.id)
      if (!labelIds.length) {
        logger.warn(`[WhatsApp QR] No se encontró label nativa Paid sincronizada para ${phone.id}; se omitió fallback de compra ${contactId}`)
        return { applied: false, reason: 'paid_label_not_synced', phoneNumberId: phone.id }
      }

      let lastError = null
      for (const labelId of labelIds) {
        try {
          await sock.addChatLabel(recipient.jid, labelId)
          return {
            applied: true,
            reason: 'applied',
            label: WHATSAPP_PREDEFINED_LABELS.paid.name,
            labelId,
            predefinedId: WHATSAPP_PREDEFINED_LABELS.paid.predefinedId,
            phoneNumberId: phone.id,
            to: recipient.verifiedPhone || toPhone,
            recipientJid: recipient.jid,
            transport: 'qr'
          }
        } catch (error) {
          lastError = error
        }
      }

      throw lastError || new Error('No se pudo aplicar la etiqueta Paid')
    } catch (error) {
      logger.warn(`[WhatsApp QR] No se pudo aplicar label Paid a ${toPhone} con ${phone.id}: ${error.message}`)
    }
  }

  return { applied: false, reason: 'qr_label_failed' }
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
        throw new Error('Baileys no trae lectura de foto de perfil en esta versión')
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
    // Una sesión que pidió QR nuevo conserva el consentimiento, pero no puede
    // seguir siendo candidata para envíos/fallback con credenciales que WhatsApp
    // ya rechazó. Solo el clic explícito del usuario la reactiva.
    qr_send_enabled: next.status === QR_REPAIR_REQUIRED_STATUS
      ? 0
      : (next.status === 'connected' ? 1 : Number(next.consentAccepted || 0)),
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
    lastError: 'La conexión QR anterior no tiene credenciales guardadas. Genera un QR nuevo para estabilizarla.',
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

function closeLiveSession(phoneNumberId, { releaseLease = true } = {}) {
  const live = liveSessions.get(phoneNumberId)
  liveSessions.delete(phoneNumberId)

  if (live?.reconnectTimer) {
    clearTimeout(live.reconnectTimer)
  }

  if (live?.leaseHeartbeat) {
    clearInterval(live.leaseHeartbeat)
  }

  if (releaseLease && live?.lease) {
    releaseQrSessionLease(live.lease).catch(error => {
      logger.warn(`[WhatsApp QR] No se pudo liberar lease ${phoneNumberId}: ${error.message}`)
    })
  }

  if (!live?.sock) return

  try {
    live.sock.ev?.removeAllListeners?.('connection.update')
    live.sock.ev?.removeAllListeners?.('creds.update')
    live.sock.ev?.removeAllListeners?.('messaging-history.set')
    live.sock.ev?.removeAllListeners?.('messaging-history.status')
    live.sock.ev?.removeAllListeners?.('messages.update')
    live.sock.ev?.removeAllListeners?.('messages.reaction')
    live.sock.ev?.removeAllListeners?.('message-receipt.update')
    live.sock.ev?.removeAllListeners?.('labels.edit')
    live.sock.ws?.close?.()
  } catch (error) {
    logger.warn(`[WhatsApp QR] No se pudo cerrar socket ${phoneNumberId}: ${error.message}`)
  }
}

async function openSocket(phone, { requireConsent = true, reconnectAttempt = 0, openDeferred = null, waitForLease = false, leaseReason = 'socket', freshPairing = false } = {}) {
  const existing = await getSessionRow(phone.id)
  if (requireConsent && Number(existing?.consent_accepted || 0) !== 1) {
    throw new Error('Primero acepta el riesgo de usar conexión por QR para este número')
  }

  const baileys = await loadBaileys()
  const {
    makeWASocket,
    DisconnectReason,
    Browsers,
    makeCacheableSignalKeyStore
  } = baileys
  const { state, saveCreds } = await useQrDbAuthState(phone.id, baileys)
  // Algunas sesiones antiguas guardadas por versiones previas de Baileys no
  // incluyen `creds.registered`, aunque sí tienen identidad y una conexión
  // previa comprobable. No debemos tratarlas como un QR nuevo y reintentarlas
  // eternamente. `freshPairing` solo se activa después de que el usuario pidió
  // borrar ese auth y generar un QR limpio.
  const startedWithRegisteredAuth = !freshPairing && Boolean(
    state?.creds?.registered ||
    existing?.connected_phone ||
    existing?.last_connected_at
  )
  const lease = await acquireQrSessionLease(phone.id, { waitForRelease: waitForLease, reason: leaseReason })
  const webVersionOverride = getWhatsAppWebVersionOverride()

  closeLiveSession(phone.id, { releaseLease: false })

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

  let sock
  try {
    sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger)
      },
      logger: baileysLogger,
      printQRInTerminal: false,
      // La conexión QR sí debe pedir el historial que WhatsApp entregue al nuevo
      // dispositivo vinculado. FULL viene bloqueado por el default de Baileys, así
      // que también autorizamos todos los tipos de bloque histórico explícitamente.
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      markOnlineOnConnect: false,
      qrTimeout: 60000,
      // Para emitir QR Baileys necesita una identidad de navegador valida y
      // logica. `Desktop` generico esta siendo rechazado por WhatsApp con 428;
      // Chrome en macOS es una identidad estable y conserva syncFullHistory.
      browser: Browsers?.macOS ? Browsers.macOS('Google Chrome') : undefined,
      // Estabilidad 24/7: ping de keep-alive frecuente, timeouts explicitos y
      // respuesta a reintentos de descifrado del receptor.
      keepAliveIntervalMs: 10000,
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 60000,
      retryRequestDelayMs: 250,
      getMessage: async (key) => qrSentMessageCache.get(cleanString(key?.id)) || undefined,
      ...(webVersionOverride ? { version: webVersionOverride } : {})
    })
  } catch (error) {
    await releaseQrSessionLease(lease)
    throw error
  }

  liveSessions.set(phone.id, {
    sock,
    openPromise: deferred.promise,
    connected: false,
    reconnectTimer: null,
    lease,
    leaseHeartbeat: startQrSessionLeaseHeartbeat(phone.id, lease)
  })

  // Baileys puede cerrar con restartRequired inmediatamente después de escanear.
  // Serializamos el guardado y lo esperamos antes de recrear el socket para no
  // relanzarlo con credenciales viejas y pedir otro QR por accidente.
  let pendingCredsSave = Promise.resolve()
  const persistUpdatedCreds = () => {
    pendingCredsSave = pendingCredsSave
      .catch(() => undefined)
      .then(() => saveCreds())
    return pendingCredsSave
  }

  sock.ev.on('creds.update', persistUpdatedCreds)
  sock.ev.on('messaging-history.set', (history) => {
    return handleQrHistorySync(phone, history, sock).catch(error => {
      logger.warn(`[WhatsApp QR] No se pudo importar un bloque histórico ${phone.id}: ${error.message}`)
    })
  })
  sock.ev.on('messaging-history.status', (status = {}) => {
    logger.info(
      `[WhatsApp QR] Estado de historial ${phone.id}: ${cleanString(status.status) || 'desconocido'}` +
      `${status.progress != null ? ` (${status.progress}%)` : ''}`
    )
  })
  sock.ev.on('messages.update', (updates) => {
    handleQrMessageUpdates(phone, updates).catch(error => {
      logger.warn(`[WhatsApp QR] No se pudieron procesar actualizaciones de mensajes ${phone.id}: ${error.message}`)
    })
  })
  sock.ev.on('messages.reaction', (updates) => {
    return handleQrMessageReactions(phone, updates, sock).catch(error => {
      logger.warn(`[WhatsApp QR] No se pudieron guardar reacciones ${phone.id}: ${error.message}`)
    })
  })
  sock.ev.on('message-receipt.update', (updates) => {
    handleQrMessageReceipts(phone, updates).catch(error => {
      logger.warn(`[WhatsApp QR] No se pudieron procesar recibos de mensajes ${phone.id}: ${error.message}`)
    })
  })
  sock.ev.on('labels.edit', (label) => {
    handleQrLabelEdit(phone, label).catch(error => {
      logger.warn(`[WhatsApp QR] No se pudo guardar label ${phone.id}: ${error.message}`)
    })
  })
  sock.ev.on('messages.upsert', (upsert) => {
    return handleQrIncomingMessages(phone, upsert, sock).catch(error => {
      logger.warn(`[WhatsApp QR] No se pudieron capturar mensajes de WhatsApp Web ${phone.id}: ${error.message}`)
    })
  })
  sock.ev.on('connection.update', async (update = {}) => {
    const live = liveSessions.get(phone.id)

    if (update.qr) {
      let qrCodeDataUrl = ''
      try {
        const qrModule = await loadQrCode()
        qrCodeDataUrl = qrModule?.toDataURL
          ? await qrModule.toDataURL(update.qr, { margin: 1, width: 320 })
          : ''
      } catch (error) {
        logger.warn(`[WhatsApp QR] No se pudo preparar el código QR ${phone.id}: ${error.message}`)
      }

      if (!qrCodeDataUrl) {
        const message = 'WhatsApp generó el código, pero Ristak no pudo prepararlo para mostrarlo. Genera otro QR.'
        await upsertSession(phone, {
          status: 'qr_error',
          qrCode: null,
          qrCodeDataUrl: null,
          lastError: message,
          lastDisconnectedAt: nowIso()
        })
        rejectCurrentOpen(new Error(message))
        closeLiveSession(phone.id)
        return
      }

      await upsertSession(phone, {
        status: 'qr_pending',
        qrCode: update.qr,
        qrCodeDataUrl,
        lastError: null
      })
      logger.info(`[WhatsApp QR] Código QR listo para ${phone.id}`)
      return
    }

    if (update.connection === 'open') {
      const connectedPhone = await getConnectedPhoneFromSocket(sock, state)
      let activePhone = phone
      let expectedPhone = cleanString(phone.expectedPhone)

      if (!expectedPhone) {
        try {
          activePhone = await promoteStandaloneQrPhone(phone, connectedPhone)
          expectedPhone = cleanString(activePhone.expectedPhone)
        } catch (error) {
          const message = error.message || 'No se pudo detectar el número conectado por QR'
          await clearAuthState(phone.id).catch(authError => {
            logger.warn(`[WhatsApp QR] No se pudo limpiar auth con número QR inválido ${phone.id}: ${authError.message}`)
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
      }

      if (!phoneMatches(connectedPhone, expectedPhone)) {
        const message = connectedPhone
          ? `El QR conecto ${connectedPhone}, pero esperabamos ${expectedPhone}`
          : `WhatsApp no entrego el número conectado para validar que sea ${expectedPhone}. Genera otro QR e intentalo de nuevo.`
        await clearAuthState(phone.id).catch(error => {
          logger.warn(`[WhatsApp QR] No se pudo limpiar auth con número incorrecto ${phone.id}: ${error.message}`)
        })
        await upsertSession(activePhone, {
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
      await upsertSession(activePhone, {
        expectedPhone,
        status: 'connected',
        connectedPhone,
        qrCode: null,
        qrCodeDataUrl: null,
        lastError: null,
        lastConnectedAt: nowIso()
      })
      notifyWhatsAppQrConnectionOpen({
        phoneNumberId: activePhone.id,
        expectedPhone,
        connectedPhone,
        phone: activePhone
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
        if (liveSessions.get(phone.id)?.openPromise === deferred.promise) return
        rejectCurrentOpen(new Error(lastError || 'La conexión por QR se reemplazo por otra sesión'))
        return
      }

      const loggedOut = isLoggedOutDisconnect(statusCode, DisconnectReason)
      const badSession = isBadSessionDisconnect(statusCode, DisconnectReason)
      const connectionReplaced = isConnectionReplacedDisconnect(statusCode, lastError, DisconnectReason)
      const restartRequired = isRestartRequiredDisconnect(statusCode, lastError, DisconnectReason)

      if (loggedOut) {
        // Un 401 significa que WhatsApp ya desvinculo el dispositivo. El auth
        // probablemente ya no sea reutilizable, pero Ristak no debe borrarlo
        // por su cuenta: solo una regeneracion/desconexion explicita del usuario
        // puede destruir credenciales guardadas.
        const message = 'WhatsApp informó que el dispositivo fue desvinculado. Ristak conservó las credenciales y no las borrará automáticamente; genera otro QR para volver a vincularlo.'
        logger.warn(`[WhatsApp QR] WhatsApp desvinculó ${phone.id}; auth conservado hasta acción explícita`)
        await upsertSession(phone, {
          status: QR_REPAIR_REQUIRED_STATUS,
          connectedPhone: null,
          qrCode: null,
          qrCodeDataUrl: null,
          lastError: message,
          lastDisconnectedAt: nowIso()
        })
        closeLiveSession(phone.id)
        rejectCurrentOpen(new Error(message))
        return
      }

      const nextReconnectAttempt = currentReconnectAttempt + 1
      const repeatedlyRejectedRegisteredAuth = startedWithRegisteredAuth &&
        !live?.connected &&
        (
          badSession ||
          isConnectionClosedDisconnect(statusCode, lastError, DisconnectReason)
        )

      if (restartRequired) {
        try {
          await pendingCredsSave
          // El evento creds.update y connection.update pueden llegar muy juntos.
          // Guardamos de nuevo el objeto mutado antes de recrear el socket para
          // que incluso ese orden de eventos no pierda la sesión recién escaneada.
          await saveCreds()
        } catch (error) {
          const message = 'Ristak no pudo guardar las credenciales nuevas de WhatsApp. Genera un QR nuevo para no arriesgar la sesión.'
          logger.warn(`[WhatsApp QR] No se guardaron credenciales antes de reiniciar ${phone.id}: ${error.message}`)
          await upsertSession(phone, {
            status: QR_REPAIR_REQUIRED_STATUS,
            qrCode: null,
            qrCodeDataUrl: null,
            lastError: message,
            lastDisconnectedAt: nowIso()
          })
          closeLiveSession(phone.id)
          rejectCurrentOpen(new Error(message))
          return
        }
      }

      // 428 y 500 son fallos recuperables mientras el auth siga guardado. Si
      // una credencial ya registrada es rechazada varias veces antes de abrir,
      // no destruimos la sesión ni obligamos al usuario a escanear otro QR:
      // dejamos el estado en reconexión para que el watchdog vuelva a intentarlo.
      if (repeatedlyRejectedRegisteredAuth && nextReconnectAttempt >= MAX_STALE_AUTH_CONNECTION_CLOSED_ATTEMPTS) {
        logger.warn(`[WhatsApp QR] La sesión ${phone.id} seguirá en reconexión automática después de ${nextReconnectAttempt} rechazos ${statusCode || ''}; auth conservado`)
        await upsertSession(phone, {
          status: 'reconnecting',
          qrCode: null,
          qrCodeDataUrl: null,
          lastError: null,
          lastDisconnectedAt: nowIso()
        })
        closeLiveSession(phone.id)
        rejectCurrentOpen(new Error('WhatsApp QR sigue en reconexión automática; las credenciales se conservaron'))
        return
      }

      if (currentReconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        const message = lastError ||
          'WhatsApp no dejo estabilizar la conexión por QR. Genera un QR nuevo e intentalo otra vez.'
        await upsertSession(phone, {
          status,
          qrCode: null,
          qrCodeDataUrl: null,
          lastError: message,
          lastDisconnectedAt: nowIso()
        })
        closeLiveSession(phone.id)
        rejectCurrentOpen(new Error(message))
        return
      }

      const nextStatus = getReconnectStatus(statusCode, lastError, DisconnectReason)
      // Backoff exponencial con jitter: sin el jitter, varias sesiones caidas
      // a la vez reintentan sincronizadas y WhatsApp las rechaza en rafaga.
      // El 440/connectionReplaced tambien reconecta solo, pero arranca con un
      // poco mas de aire para no pelearse con un proceso viejo durante deploys.
      const reconnectDelay = getReconnectDelayMs(statusCode, lastError, currentReconnectAttempt, DisconnectReason)
      const reconnectReason = connectionReplaced ? 'sesión reemplazada' : (statusCode || lastError || 'cierre')
      logger.info(`[WhatsApp QR] ${nextStatus === 'restarting' ? 'Reiniciando' : 'Reconectando'} socket ${phone.id} por ${reconnectReason} (${nextReconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`)
      await upsertSession(phone, {
        status: nextStatus,
        qrCode: null,
        qrCodeDataUrl: null,
        lastError: null,
        lastDisconnectedAt: nowIso()
      })
      const reconnectLease = live?.lease || lease
      const reconnectLeaseHeartbeat = live?.leaseHeartbeat ||
        startQrSessionLeaseHeartbeat(phone.id, reconnectLease)
      liveSessions.delete(phone.id)

      const nextOpenDeferred = openSettled ? createDeferred() : deferred
      if (openSettled) {
        nextOpenDeferred.promise.catch(error => {
          logger.warn(`[WhatsApp QR] Reconexion fallida ${phone.id}: ${error.message}`)
        })
      }
      const reconnectTimer = setTimeout(() => {
        const pendingLive = liveSessions.get(phone.id)
        if (pendingLive?.reconnectTimer !== reconnectTimer) return

        openSocket(phone, {
          requireConsent: false,
          reconnectAttempt: nextReconnectAttempt,
          openDeferred: nextOpenDeferred,
          // Un emparejamiento que el usuario acaba de regenerar debe seguir
          // siendo fresco en cada socket de reintento. Si se pierde esta
          // bandera, el historial de una sesión vieja vuelve a parecer auth
          // válido y corta el QR nuevo al tercer 428.
          freshPairing
        }).catch(nextOpenDeferred.reject)
      }, reconnectDelay)

      liveSessions.set(phone.id, {
        sock: null,
        openPromise: nextOpenDeferred.promise,
        connected: false,
        reconnectTimer,
        lease: reconnectLease,
        leaseHeartbeat: reconnectLeaseHeartbeat
      })
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

async function ensureOpenSocket(phone, { waitForLease = false, leaseReason = 'send' } = {}) {
  const live = liveSessions.get(phone.id)
  if (live?.sock && live.connected) return live.sock

  if (live?.openPromise) {
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('El QR se está reconectando. Espera unos segundos e intenta mandar otra vez.')), CONNECT_TIMEOUT_MS)
    })

    await Promise.race([live.openPromise, timeout])
    const currentLive = liveSessions.get(phone.id)
    if (currentLive?.sock && currentLive.connected) return currentLive.sock
  }

  const { sock, openPromise } = await openSocket(phone, { waitForLease, leaseReason })
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('El QR no está conectado. Abre Configuración > WhatsApp y escanea el código.')), CONNECT_TIMEOUT_MS)
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

  const existing = await getSessionRow(phone.id)
  const live = liveSessions.get(phone.id)

  // Un clic repetido no debe cerrar un socket sano ni pelearse con un intento
  // que ya está en curso. Eso era una fuente innecesaria de desconexiones.
  if (live?.connected || live?.sock || live?.reconnectTimer) {
    return mapSessionForResponse(existing || await waitForSessionReady(phone.id))
  }

  // Una regeneración solicitada por el usuario es el único momento en que se
  // descartan credenciales recuperables que WhatsApp ya rechazó. No hacemos este
  // reset automático: así un fallo transitorio nunca desconecta un número sano.
  const freshPairing = requiresExplicitQrRepair(existing)
  if (freshPairing) {
    await clearAuthState(phone.id)
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

  try {
    const { openPromise } = await openSocket(phone, {
      requireConsent: true,
      leaseReason: 'manual-connect',
      freshPairing
    })
    openPromise.catch(error => {
      logger.warn(`[WhatsApp QR] Conexión pendiente/fallida ${phone.id}: ${error.message}`)
    })
  } catch (error) {
    // Si otra instancia tiene el lease, no pisamos su estado: sigue siendo la
    // dueña de la sesión. Los demás errores sí se reflejan para que el modal no
    // se quede en "conectando" sin una causa real.
    if (error.code !== 'whatsapp_qr_session_locked') {
      await upsertSession(phone, {
        status: 'qr_error',
        qrCode: null,
        qrCodeDataUrl: null,
        lastError: error.message || 'No se pudo iniciar la conexión por QR.',
        lastDisconnectedAt: nowIso()
      })
    }
    throw error
  }

  const row = await waitForSessionReady(phone.id)
  return mapSessionForResponse(row)
}

export async function disconnectWhatsAppQrConnection({ phoneNumberId } = {}) {
  const phone = await getPhoneRow(phoneNumberId)

  try {
    const live = liveSessions.get(phone.id)
    if (live?.sock?.logout) await live.sock.logout()
  } catch (error) {
    logger.warn(`[WhatsApp QR] No se pudo cerrar sesión QR ${phone.id}: ${error.message}`)
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

function parseJsonObject(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function readNestedJsonObject(value, keys = []) {
  let current = value
  for (const key of keys) {
    current = current && typeof current === 'object' ? current[key] : null
  }
  return parseJsonObject(current)
}

function getQrTargetMessageId(row = {}) {
  return cleanString(row.wamid || row.ycloud_message_id || row.meta_message_id || row.id)
}

function buildMinimalQuotedBaileysMessage(row = {}, recipientJid = '') {
  const messageId = getQrTargetMessageId(row)
  if (!messageId) return null
  const type = cleanString(row.message_type).toLowerCase()
  const text = cleanString(row.message_text) || (type === 'image' ? 'Foto' : type === 'video' ? 'Video' : type === 'document' ? 'Documento' : type === 'location' ? 'Ubicación' : 'Mensaje')

  return {
    key: {
      remoteJid: normalizeJid(recipientJid),
      id: messageId,
      fromMe: cleanString(row.direction).toLowerCase() === 'outbound'
    },
    message: {
      conversation: text
    }
  }
}

function getStoredBaileysMessageFromRow(row = {}, recipientJid = '') {
  const rawPayload = parseJsonObject(row.raw_payload_json)
  const directRaw = parseJsonObject(rawPayload?.qrRaw) || parseJsonObject(rawPayload?.raw) || rawPayload?.qrRaw || rawPayload?.raw
  const candidates = [
    rawPayload,
    directRaw,
    rawPayload?.response,
    directRaw?.response,
    readNestedJsonObject(rawPayload, ['raw', 'response']),
    readNestedJsonObject(rawPayload, ['qrRaw', 'response'])
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (candidate?.key?.id && candidate?.message) return candidate
    if (candidate?.response?.key?.id && candidate?.response?.message) return candidate.response
  }

  return buildMinimalQuotedBaileysMessage(row, recipientJid)
}

async function resolveQrMessageReference({ messageId, providerMessageId, recipientJid } = {}) {
  const cleanMessageId = cleanString(messageId)
  const cleanProviderMessageId = cleanString(providerMessageId)
  if (!cleanMessageId && !cleanProviderMessageId) return null

  const row = await db.get(`
    SELECT id, ycloud_message_id, meta_message_id, wamid, direction, message_type, message_text, raw_payload_json
    FROM whatsapp_api_messages
    WHERE (? != '' AND id = ?)
       OR (? != '' AND ycloud_message_id = ?)
       OR (? != '' AND meta_message_id = ?)
       OR (? != '' AND wamid = ?)
    ORDER BY updated_at DESC
    LIMIT 1
  `, [
    cleanMessageId, cleanMessageId,
    cleanProviderMessageId, cleanProviderMessageId,
    cleanProviderMessageId, cleanProviderMessageId,
    cleanProviderMessageId, cleanProviderMessageId
  ]).catch(() => null)

  if (!row && cleanProviderMessageId) {
    return {
      key: {
        remoteJid: normalizeJid(recipientJid),
        id: cleanProviderMessageId,
        fromMe: false
      },
      message: {
        conversation: 'Mensaje'
      }
    }
  }
  if (!row) return null
  return getStoredBaileysMessageFromRow(row, recipientJid)
}

export async function markLatestInboundWhatsAppQrMessageReadForContact({ contactId } = {}) {
  const cleanContactId = cleanString(contactId)
  if (!cleanContactId) {
    return { attempted: false, reason: 'missing_contact' }
  }

  const row = await db.get(`
    SELECT id, ycloud_message_id, meta_message_id, wamid, business_phone_number_id,
           phone, from_phone, to_phone, business_phone, direction, message_type,
           message_text, raw_payload_json
    FROM whatsapp_api_messages
    WHERE contact_id = ?
      AND LOWER(COALESCE(direction, '')) = 'inbound'
      AND LOWER(COALESCE(transport, '')) = 'qr'
      AND LOWER(COALESCE(status, '')) NOT IN ('read', 'failed')
    ORDER BY COALESCE(message_timestamp, updated_at, created_at) DESC
    LIMIT 1
  `, [cleanContactId]).catch(() => null)

  if (!row) {
    return { attempted: false, reason: 'no_unread_inbound_message' }
  }

  const contactPhone = normalizePhoneForStorage(row.phone || row.from_phone) || cleanString(row.phone || row.from_phone)
  if (!contactPhone) {
    return { attempted: false, reason: 'missing_contact_phone' }
  }

  const phone = await resolveQrPhone({
    phoneNumberId: row.business_phone_number_id,
    from: row.business_phone || row.to_phone
  })
  if (await markMissingAuthStateIfNeeded(phone)) {
    throw new Error('El QR necesita reconectarse. Abre Configuración > WhatsApp y genera un QR nuevo.')
  }

  const sock = await ensureOpenSocket(phone, { waitForLease: true, leaseReason: 'marcar mensaje como leído' })
  if (!sock?.readMessages) {
    throw new Error('La conexión QR no puede marcar mensajes como leídos en este momento')
  }

  const recipient = await resolveRecipientJid(sock, contactPhone)
  const storedMessage = getStoredBaileysMessageFromRow(row, recipient.jid)
  const key = storedMessage?.key
  if (!key?.id) {
    return { attempted: false, reason: 'missing_message_key' }
  }

  const readKey = {
    remoteJid: normalizeJid(key.remoteJid || recipient.jid),
    id: key.id,
    fromMe: Boolean(key.fromMe)
  }
  await sock.readMessages([readKey])

  await db.run(`
    UPDATE whatsapp_api_messages
    SET status = 'read',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [row.id]).catch(() => undefined)

  return {
    attempted: true,
    provider: 'baileys',
    messageId: row.id,
    providerMessageId: getQrTargetMessageId(row),
    jid: readKey.remoteJid
  }
}

async function sendProtectedQrMessage({ sock, phone, recipient, type, payload, options = {}, skipQrSendProtection = false } = {}) {
  if (!sock?.sendMessage) {
    throw new Error('La conexión QR no puede enviar mensajes en este momento')
  }
  if (!phone?.id) {
    throw new Error('Falta el número emisor de WhatsApp QR')
  }

  if (!skipQrSendProtection) {
    await waitForWhatsAppQrDripSlot({
      phoneNumberId: phone.id,
      to: recipient?.verifiedPhone,
      type
    })
  }

  return sock.sendMessage(recipient.jid, payload, options)
}

export async function sendWhatsAppQrTextMessage({ phoneNumberId, from, to, text, externalId, replyToMessageId = '', replyToProviderMessageId = '', skipQrSendProtection = false } = {}) {
  const phone = await resolveQrPhone({ phoneNumberId, from })
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const body = cleanString(text)

  if (await markMissingAuthStateIfNeeded(phone)) {
    throw new Error('El QR necesita reconectarse. Abre Configuración > WhatsApp y genera un QR nuevo.')
  }
  if (Number(phone.qr_send_enabled || 0) !== 1) {
    throw new Error('Ese número no tiene el envío por QR activado')
  }
  if (!toPhone) throw new Error('Falta el número destino')
  if (!body) throw new Error('Falta el texto del mensaje')

  const sock = await ensureOpenSocket(phone, { waitForLease: true, leaseReason: 'envío de texto' })
  const recipient = await resolveRecipientJid(sock, toPhone)
  const quoted = await resolveQrMessageReference({
    messageId: replyToMessageId,
    providerMessageId: replyToProviderMessageId,
    recipientJid: recipient.jid
  })
  rememberRistakQrOutboundAttempt({
    phoneId: phone.id,
    contactPhone: recipient.verifiedPhone || toPhone,
    type: 'text',
    text: body
  })
  const response = await sendProtectedQrMessage({
    sock,
    phone,
    recipient,
    type: 'text',
    payload: { text: body },
    options: quoted ? { quoted } : {},
    skipQrSendProtection
  })
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
    raw: sendResult.raw,
    ...(quoted ? {
      context: {
        id: cleanString(quoted?.key?.id) || replyToProviderMessageId || replyToMessageId
      }
    } : {})
  }
}

export async function sendWhatsAppQrReactionMessage({ phoneNumberId, from, to, emoji, targetMessageId = '', targetProviderMessageId = '', externalId, skipQrSendProtection = false } = {}) {
  const phone = await resolveQrPhone({ phoneNumberId, from })
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const reactionEmoji = cleanString(emoji)

  if (await markMissingAuthStateIfNeeded(phone)) {
    throw new Error('El QR necesita reconectarse. Abre Configuración > WhatsApp y genera un QR nuevo.')
  }
  if (Number(phone.qr_send_enabled || 0) !== 1) {
    throw new Error('Ese número no tiene el envío por QR activado')
  }
  if (!toPhone) throw new Error('Falta el número destino')
  if (!reactionEmoji) throw new Error('Falta la reacción')

  const sock = await ensureOpenSocket(phone, { waitForLease: true, leaseReason: 'reacción de mensaje' })
  const recipient = await resolveRecipientJid(sock, toPhone)
  const quoted = await resolveQrMessageReference({
    messageId: targetMessageId,
    providerMessageId: targetProviderMessageId,
    recipientJid: recipient.jid
  })
  const key = quoted?.key
  if (!key?.id) throw new Error('No encontramos el mensaje original para reaccionar')

  rememberRistakQrOutboundAttempt({
    phoneId: phone.id,
    contactPhone: recipient.verifiedPhone || toPhone,
    type: 'reaction',
    text: reactionEmoji
  })
  const response = await sendProtectedQrMessage({
    sock,
    phone,
    recipient,
    type: 'reaction',
    payload: {
      react: {
        text: reactionEmoji,
        key
      }
    },
    skipQrSendProtection
  })
  const sendResult = await finalizeQrSendResponse({ response, recipient, externalId })

  return {
    id: sendResult.id,
    wamid: sendResult.wamid,
    from: phone.expectedPhone,
    to: recipient.verifiedPhone || toPhone,
    recipientJid: sendResult.recipientJid,
    type: 'reaction',
    reaction: {
      emoji: reactionEmoji,
      message_id: key.id
    },
    context: {
      id: key.id
    },
    status: sendResult.status,
    transport: 'qr',
    createTime: nowIso(),
    raw: sendResult.raw
  }
}

export async function sendWhatsAppQrLocationMessage({ phoneNumberId, from, to, latitude, longitude, name, address, externalId, skipQrSendProtection = false } = {}) {
  const phone = await resolveQrPhone({ phoneNumberId, from })
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const location = normalizeQrLocation({ latitude, longitude, name, address })

  if (await markMissingAuthStateIfNeeded(phone)) {
    throw new Error('El QR necesita reconectarse. Abre Configuración > WhatsApp y genera un QR nuevo.')
  }
  if (Number(phone.qr_send_enabled || 0) !== 1) {
    throw new Error('Ese número no tiene el envío por QR activado')
  }
  if (!toPhone) throw new Error('Falta el número destino')
  if (!location) throw new Error('Faltan coordenadas válidas para la ubicación')

  const sock = await ensureOpenSocket(phone, { waitForLease: true, leaseReason: 'envío de ubicación' })
  const recipient = await resolveRecipientJid(sock, toPhone)
  rememberRistakQrOutboundAttempt({
    phoneId: phone.id,
    contactPhone: recipient.verifiedPhone || toPhone,
    type: 'location',
    text: location.name || location.address || 'Ubicación'
  })
  const response = await sendProtectedQrMessage({
    sock,
    phone,
    recipient,
    type: 'location',
    payload: {
      location: {
        degreesLatitude: location.latitude,
        degreesLongitude: location.longitude,
        ...(location.name ? { name: location.name } : {}),
        ...(location.address ? { address: location.address } : {})
      }
    },
    skipQrSendProtection
  })
  const sendResult = await finalizeQrSendResponse({ response, recipient, externalId })

  return {
    id: sendResult.id,
    wamid: sendResult.wamid,
    from: phone.expectedPhone,
    to: recipient.verifiedPhone || toPhone,
    recipientJid: sendResult.recipientJid,
    type: 'location',
    location,
    status: sendResult.status,
    transport: 'qr',
    createTime: nowIso(),
    raw: sendResult.raw
  }
}

export async function sendWhatsAppQrImageMessage({ phoneNumberId, from, to, imageDataUrl, imageUrl, caption, externalId, skipQrSendProtection = false } = {}) {
  const phone = await resolveQrPhone({ phoneNumberId, from })
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const cleanCaption = cleanString(caption).slice(0, 1024)

  if (await markMissingAuthStateIfNeeded(phone)) {
    throw new Error('El QR necesita reconectarse. Abre Configuración > WhatsApp y genera un QR nuevo.')
  }
  if (Number(phone.qr_send_enabled || 0) !== 1) {
    throw new Error('Ese número no tiene el envío por QR activado')
  }
  if (!toPhone) throw new Error('Falta el número destino')

  const media = await buildQrMediaPayload({
    dataUrl: imageDataUrl,
    url: imageUrl,
    label: 'la foto'
  })
  const sock = await ensureOpenSocket(phone, { waitForLease: true, leaseReason: 'envío de imagen' })
  const recipient = await resolveRecipientJid(sock, toPhone)
  rememberRistakQrOutboundAttempt({
    phoneId: phone.id,
    contactPhone: recipient.verifiedPhone || toPhone,
    type: 'image',
    text: cleanCaption
  })
  const response = await sendProtectedQrMessage({
    sock,
    phone,
    recipient,
    type: 'image',
    payload: {
      image: media.content,
      ...(media.mimeType ? { mimetype: media.mimeType } : {}),
      ...(cleanCaption ? { caption: cleanCaption } : {})
    },
    skipQrSendProtection
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

export async function sendWhatsAppQrVideoMessage({ phoneNumberId, from, to, videoDataUrl, videoUrl, caption, mimeType, externalId, skipQrSendProtection = false } = {}) {
  const phone = await resolveQrPhone({ phoneNumberId, from })
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const cleanCaption = cleanString(caption).slice(0, 1024)

  if (await markMissingAuthStateIfNeeded(phone)) {
    throw new Error('El QR necesita reconectarse. Abre Configuración > WhatsApp y genera un QR nuevo.')
  }
  if (Number(phone.qr_send_enabled || 0) !== 1) {
    throw new Error('Ese número no tiene el envío por QR activado')
  }
  if (!toPhone) throw new Error('Falta el número destino')

  const media = await buildQrMediaPayload({
    dataUrl: videoDataUrl,
    url: videoUrl,
    label: 'el video'
  })
  const videoMimeType = inferVideoMimeType({ mimeType: media.mimeType || mimeType, url: media.sourceUrl || videoUrl })
  const sock = await ensureOpenSocket(phone, { waitForLease: true, leaseReason: 'envío de video' })
  const recipient = await resolveRecipientJid(sock, toPhone)
  rememberRistakQrOutboundAttempt({
    phoneId: phone.id,
    contactPhone: recipient.verifiedPhone || toPhone,
    type: 'video',
    text: cleanCaption
  })
  const response = await sendProtectedQrMessage({
    sock,
    phone,
    recipient,
    type: 'video',
    payload: {
      video: media.content,
      mimetype: videoMimeType,
      ...(cleanCaption ? { caption: cleanCaption } : {})
    },
    skipQrSendProtection
  })
  const sendResult = await finalizeQrSendResponse({ response, recipient, externalId })

  return {
    id: sendResult.id,
    wamid: sendResult.wamid,
    from: phone.expectedPhone,
    to: recipient.verifiedPhone || toPhone,
    recipientJid: sendResult.recipientJid,
    type: 'video',
    video: {
      link: media.sourceUrl || cleanString(videoUrl),
      url: media.sourceUrl || cleanString(videoUrl),
      mimeType: videoMimeType,
      mimetype: videoMimeType,
      ...(cleanCaption ? { caption: cleanCaption } : {})
    },
    status: sendResult.status,
    transport: 'qr',
    createTime: nowIso(),
    raw: sendResult.raw
  }
}

export async function sendWhatsAppQrAudioMessage({ phoneNumberId, from, to, audioDataUrl, audioUrl, audioPublicUrl, externalId, durationMs, skipQrSendProtection = false } = {}) {
  const phone = await resolveQrPhone({ phoneNumberId, from })
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)

  if (await markMissingAuthStateIfNeeded(phone)) {
    throw new Error('El QR necesita reconectarse. Abre Configuración > WhatsApp y genera un QR nuevo.')
  }
  if (Number(phone.qr_send_enabled || 0) !== 1) {
    throw new Error('Ese número no tiene el envío por QR activado')
  }
  if (!toPhone) throw new Error('Falta el número destino')

  const media = await buildQrMediaPayload({
    dataUrl: audioDataUrl,
    url: audioUrl,
    label: 'el audio'
  })
  let mimeType = normalizeVoiceNoteMimeType(inferAudioMimeType({ mimeType: media.mimeType, url: media.sourceUrl }))
  // Baileys/WhatsApp Web exige un contenedor OGG/Opus REAL para las notas de voz
  // (ptt). Si el contenido no es un OGG/Opus REAL —aunque alguien lo etiquete
  // como audio/ogg—, transcodifícalo con la MISMA tubería del canal API antes
  // de mandarlo como PTT. Mandar AAC, MP3 u OGG sin Opus con ptt:true rompe la
  // reproducción en el receptor (aparece como archivo o "audio no disponible").
  const { convertAudioToOggOpus, isValidWhatsAppVoiceNoteBuffer } = await loadWhatsAppApiService()
  if (Buffer.isBuffer(media.content) && !isValidWhatsAppVoiceNoteBuffer(media.content)) {
    media.content = await convertAudioToOggOpus({
      buffer: media.content,
      extension: qrAudioInputExtension(media.mimeType)
    })
    mimeType = WHATSAPP_VOICE_NOTE_MIME_TYPE
  }
  const seconds = getAudioDurationSeconds(durationMs)
  const sock = await ensureOpenSocket(phone, { waitForLease: true, leaseReason: 'envío de audio' })
  const recipient = await resolveRecipientJid(sock, toPhone)
  rememberRistakQrOutboundAttempt({
    phoneId: phone.id,
    contactPhone: recipient.verifiedPhone || toPhone,
    type: 'audio',
    text: ''
  })
  const response = await sendProtectedQrMessage({
    sock,
    phone,
    recipient,
    type: 'audio',
    payload: {
      audio: media.content,
      mimetype: mimeType,
      ptt: true,
      ...(seconds ? { seconds } : {})
    },
    skipQrSendProtection
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

export async function sendWhatsAppQrDocumentMessage({ phoneNumberId, from, to, documentDataUrl, documentUrl, caption, filename, mimeType, externalId, skipQrSendProtection = false } = {}) {
  const phone = await resolveQrPhone({ phoneNumberId, from })
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const cleanCaption = cleanString(caption).slice(0, 1024)
  const cleanFilename = cleanString(filename).slice(0, 180) || getFilenameFromUrl(documentUrl) || `documento-${Date.now()}.pdf`

  if (await markMissingAuthStateIfNeeded(phone)) {
    throw new Error('El QR necesita reconectarse. Abre Configuración > WhatsApp y genera un QR nuevo.')
  }
  if (Number(phone.qr_send_enabled || 0) !== 1) {
    throw new Error('Ese número no tiene el envío por QR activado')
  }
  if (!toPhone) throw new Error('Falta el número destino')

  const media = await buildQrMediaPayload({
    dataUrl: documentDataUrl,
    url: documentUrl,
    label: 'el documento'
  })
  const documentMimeType = inferDocumentMimeType({
    mimeType: media.mimeType || mimeType,
    url: media.sourceUrl || documentUrl,
    filename: cleanFilename
  })
  const sock = await ensureOpenSocket(phone, { waitForLease: true, leaseReason: 'envío de documento' })
  const recipient = await resolveRecipientJid(sock, toPhone)
  rememberRistakQrOutboundAttempt({
    phoneId: phone.id,
    contactPhone: recipient.verifiedPhone || toPhone,
    type: 'document',
    text: cleanCaption || cleanFilename
  })
  const response = await sendProtectedQrMessage({
    sock,
    phone,
    recipient,
    type: 'document',
    payload: {
      document: media.content,
      mimetype: documentMimeType,
      fileName: cleanFilename,
      ...(cleanCaption ? { caption: cleanCaption } : {})
    },
    skipQrSendProtection
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

// Estados desde los que vale la pena reabrir una sesión con credenciales
// guardadas. connection_replaced queda por compatibilidad con sesiones que
// alcanzaron ese estado antes de que el 440 se manejara como reconexion viva.
// Los estados terminales (logged_out, bad_session, number_mismatch,
// disconnected manual) requieren un QR nuevo y NO se tocan.
const QR_RESUMABLE_STATUSES = new Set(['connected', 'reconnecting', 'restarting', 'connection_replaced'])

/**
 * Reabre las sesiones de WhatsApp Web que tienen credenciales guardadas y se
 * quedaron sin socket vivo. Se llama al arrancar el servidor (los reinicios y
 * deploys matan los sockets y nadie los volvia a abrir: la sesión quedaba
 * "muerta" hasta que alguien intentaba enviar, y tras semanas sin conectarse
 * WhatsApp desvincula el dispositivo) y periodicamente como watchdog para
 * revivir sesiones que agotaron sus reintentos de reconexion.
 */
export async function resumeWhatsAppQrSessions({ source = 'watchdog' } = {}) {
  if (process.env.WHATSAPP_QR_AUTO_RESUME === '0') {
    return { resumed: 0, disabled: true }
  }

  const rows = await db.all(`
    SELECT s.*
    FROM whatsapp_qr_sessions s
    JOIN whatsapp_api_phone_numbers p ON p.id = s.phone_number_id
    WHERE p.qr_send_enabled = 1
      AND s.consent_accepted = 1
  `).catch(() => [])

  let resumed = 0
  for (const row of rows) {
    const phoneNumberId = row.phone_number_id
    const status = cleanString(row.status).toLowerCase()
    const resumable = QR_RESUMABLE_STATUSES.has(status) || status.startsWith('disconnected_')
    if (!resumable) continue
    if (liveSessions.has(phoneNumberId)) continue
    if (!(await hasSavedAuthState(phoneNumberId))) continue

    try {
      const phone = await getPhoneRow(phoneNumberId)
      logger.info(`[WhatsApp QR] (${source}) Reabriendo sesión ${phoneNumberId} (estado previo: ${status})`)
      const { openPromise } = await openSocket(phone, { requireConsent: false })
      openPromise.catch(error => {
        logger.warn(`[WhatsApp QR] (${source}) Reapertura pendiente/fallida ${phoneNumberId}: ${error.message}`)
      })
      resumed += 1
    } catch (error) {
      logger.warn(`[WhatsApp QR] (${source}) No se pudo reabrir ${phoneNumberId}: ${error.message}`)
    }
  }

  return { resumed }
}

export { QR_CONSENT_TEXT }
