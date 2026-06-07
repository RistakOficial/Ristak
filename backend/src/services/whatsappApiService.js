import crypto from 'crypto'
import { spawn } from 'child_process'
import fs from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import fetch from 'node-fetch'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { findContactByPhoneCandidates } from './contactIdentityService.js'
import { sendChatMessageNotification } from './pushNotificationsService.js'
import {
  QR_CONSENT_TEXT,
  disconnectWhatsAppQrConnection,
  getWhatsAppQrSession,
  getWhatsAppQrSessions,
  sendWhatsAppQrAudioMessage,
  sendWhatsAppQrDocumentMessage,
  sendWhatsAppQrImageMessage,
  sendWhatsAppQrTextMessage,
  startWhatsAppQrConnection
} from './whatsappQrService.js'
import { decrypt, encrypt } from '../utils/encryption.js'
import { buildPhoneMatchCandidates, normalizePhoneDigits, normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { detectWhatsAppAttributionFields } from '../utils/whatsappAttribution.js'
import { logger } from '../utils/logger.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const YCLOUD_API_BASE_URL = 'https://api.ycloud.com/v2'
const SOURCE_NAME = 'WhatsApp_API'
const PROVIDER_NAME = 'ycloud'
const WEBHOOK_DESCRIPTION = 'Ristak WhatsApp API'
const GENERIC_CONTACT_NAME = 'Contacto WhatsApp_API'
const WHATSAPP_IMAGE_UPLOAD_ROOT = join(__dirname, '../../uploads/whatsapp-images')
const WHATSAPP_IMAGE_PUBLIC_PATH = '/uploads/whatsapp-images'
const MAX_WHATSAPP_IMAGE_BYTES = 8 * 1024 * 1024
const WHATSAPP_AUDIO_UPLOAD_ROOT = join(__dirname, '../../uploads/whatsapp-audio')
const WHATSAPP_AUDIO_PUBLIC_PATH = '/uploads/whatsapp-audio'
const MAX_WHATSAPP_AUDIO_BYTES = 16 * 1024 * 1024
const WHATSAPP_DOCUMENT_UPLOAD_ROOT = join(__dirname, '../../uploads/whatsapp-documents')
const WHATSAPP_DOCUMENT_PUBLIC_PATH = '/uploads/whatsapp-documents'
const MAX_WHATSAPP_DOCUMENT_BYTES = 20 * 1024 * 1024
const WHATSAPP_VOICE_NOTE_MIME_TYPE = 'audio/ogg; codecs=opus'
const WHATSAPP_API_PROFILE_PICTURE_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const WHATSAPP_API_PROFILE_PICTURE_BATCH_LIMIT = 40
const IMAGE_EXTENSION_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
}
const AUDIO_EXTENSION_BY_MIME = {
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav'
}
const DOCUMENT_EXTENSION_BY_MIME = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'text/csv': 'csv'
}
const DOCUMENT_MIME_BY_EXTENSION = Object.fromEntries(
  Object.entries(DOCUMENT_EXTENSION_BY_MIME).map(([mimeType, extension]) => [extension, mimeType])
)
const API_FALLBACK_PHONE_STATUSES = new Set([
  'BANNED',
  'BLOCKED',
  'RESTRICTED',
  'RATE_LIMITED',
  'DISCONNECTED',
  'MIGRATED'
])
const API_FALLBACK_ERROR_PATTERN = /\b(WABA|BUSINESS ACCOUNT|PHONE NUMBER|SENDER|FROM|ACCOUNT|QUALITY|MESSAGING LIMIT|RATE.?LIMIT|RESTRICT|BANNED|BLOCKED|DISABLED|SUSPENDED|LOCKED|NOT ALLOWED|NOT_ALLOWED|CUSTOMER SERVICE WINDOW|24.?HOUR|24 HORAS|OUTSIDE.*WINDOW)\b/i
const API_FALLBACK_RECIPIENT_ERROR_PATTERN = /\b(RECIPIENT|CUSTOMER|USER|DESTINATION|TO PHONE|UNSUBSCRIBED|OPTED.?OUT|BLOCKED BY USER|USER BLOCKED)\b/i

const REQUIRED_WEBHOOK_EVENTS = [
  'whatsapp.inbound_message.received',
  'whatsapp.message.updated',
  'whatsapp.smb.history',
  'whatsapp.smb.message.created',
  'whatsapp.user.preferences',
  'contact.unsubscribe.created',
  'contact.unsubscribe.deleted',
  'whatsapp.phone_number.deleted',
  'whatsapp.phone_number.name_updated',
  'whatsapp.phone_number.quality_updated',
  'whatsapp.template.category_updated',
  'whatsapp.template.quality_updated',
  'whatsapp.template.reviewed',
  'whatsapp.business_account.updated',
  'whatsapp.business_account.reviewed',
  'whatsapp.business_account.deleted'
]

const INBOUND_MESSAGE_EVENT_TYPES = new Set([
  'whatsapp.inbound_message.received'
])

const OUTBOUND_MESSAGE_EVENT_TYPES = new Set([
  'whatsapp.message.updated',
  'whatsapp.smb.message.created'
])

const HISTORY_MESSAGE_EVENT_TYPES = new Set([
  'whatsapp.smb.history'
])

const MESSAGE_EVENT_TYPES = new Set([
  ...INBOUND_MESSAGE_EVENT_TYPES,
  ...OUTBOUND_MESSAGE_EVENT_TYPES,
  ...HISTORY_MESSAGE_EVENT_TYPES
])

const PHONE_STATUS_ALERTS = {
  BANNED: {
    severity: 'critical',
    title: 'Numero de WhatsApp baneado',
    message: 'WhatsApp marco este numero como baneado. No se puede usar para enviar mensajes hasta resolverlo en Meta o WhatsApp API.'
  },
  BLOCKED: {
    severity: 'critical',
    title: 'Limite de WhatsApp alcanzado',
    message: 'El numero alcanzo el limite de mensajes del periodo de 24 horas. Las plantillas pueden fallar hasta que se reinicie el limite.'
  },
  RESTRICTED: {
    severity: 'critical',
    title: 'Numero restringido',
    message: 'El numero alcanzo su limite de conversaciones iniciadas por negocio y no puede mandar mas mensajes por ahora.'
  },
  RATE_LIMITED: {
    severity: 'critical',
    title: 'WhatsApp aplico rate limit',
    message: 'WhatsApp limito el volumen de envio del numero. Baja el ritmo de plantillas y revisa calidad/saldo antes de reintentar.'
  },
  DISCONNECTED: {
    severity: 'critical',
    title: 'Numero desconectado',
    message: 'El numero no esta alcanzable por los servidores de WhatsApp. Revisa el estado en Meta o WhatsApp API antes de enviar.'
  },
  MIGRATED: {
    severity: 'critical',
    title: 'Numero migrado',
    message: 'Este numero fue transferido a otra cuenta de WhatsApp Business. La configuracion de WhatsApp_API debe revisarse.'
  },
  FLAGGED: {
    severity: 'warning',
    title: 'Numero marcado por baja calidad',
    message: 'WhatsApp marco el numero por baja calidad. Si no mejora, puede bajar el limite o bloquear envios.'
  },
  WARNED: {
    severity: 'warning',
    title: 'Advertencia en WhatsApp',
    message: 'WhatsApp emitio una advertencia para este numero, probablemente por reportes o calidad de mensajes.'
  },
  UNVERIFIED: {
    severity: 'warning',
    title: 'Numero sin verificar',
    message: 'El numero todavia no esta verificado. Termina la verificacion para poder enviar bien.'
  },
  MANUAL_REVIEW: {
    severity: 'warning',
    title: 'Numero en revision manual',
    message: 'Meta o WhatsApp API esta revisando el numero. El envio puede quedar limitado hasta que aprueben la revision.'
  },
  PENDING: {
    severity: 'info',
    title: 'Numero pendiente',
    message: 'El numero esta pendiente de verificacion o registro en WhatsApp Business.'
  },
  UNKNOWN: {
    severity: 'warning',
    title: 'Estado de numero desconocido',
    message: 'WhatsApp API no pudo determinar el estado del numero. Conviene sincronizar y revisar antes de enviar campañas.'
  }
}

const TEMPLATE_STATUS_ALERTS = {
  REJECTED: {
    severity: 'critical',
    title: 'Plantilla rechazada',
    message: 'Meta rechazo esta plantilla. No se puede enviar hasta corregirla y aprobarla.'
  },
  PAUSED: {
    severity: 'critical',
    title: 'Plantilla pausada',
    message: 'Meta pauso esta plantilla por retroalimentacion negativa. No se puede enviar mientras siga pausada.'
  },
  DISABLED: {
    severity: 'critical',
    title: 'Plantilla deshabilitada',
    message: 'Meta deshabilito esta plantilla. Revisa el motivo y apela o crea una version corregida.'
  },
  ARCHIVED: {
    severity: 'critical',
    title: 'Plantilla archivada',
    message: 'La plantilla esta archivada. WhatsApp API indica que las plantillas archivadas no se pueden enviar.'
  },
  DELETED: {
    severity: 'critical',
    title: 'Plantilla eliminada',
    message: 'La plantilla fue eliminada y ya no esta disponible para envio.'
  },
  IN_APPEAL: {
    severity: 'warning',
    title: 'Plantilla en apelacion',
    message: 'La plantilla esta en apelacion. Evita depender de ella hasta que Meta confirme el resultado.'
  },
  PENDING: {
    severity: 'info',
    title: 'Plantilla pendiente',
    message: 'La plantilla sigue en revision. No se puede usar para enviar hasta que este APPROVED.'
  }
}

const CONFIG_KEYS = {
  enabled: 'whatsapp_api_enabled',
  apiKey: 'whatsapp_api_ycloud_api_key_encrypted',
  senderPhone: 'whatsapp_api_sender_phone',
  phoneNumberId: 'whatsapp_api_phone_number_id',
  wabaId: 'whatsapp_api_waba_id',
  provider: 'whatsapp_api_provider',
  webhookEndpointId: 'whatsapp_api_webhook_endpoint_id',
  webhookSecret: 'whatsapp_api_webhook_secret_encrypted',
  webhookUrl: 'whatsapp_api_webhook_url',
  webhookStatus: 'whatsapp_api_webhook_status',
  connectedAt: 'whatsapp_api_connected_at',
  disconnectedAt: 'whatsapp_api_disconnected_at',
  lastSyncedAt: 'whatsapp_api_last_synced_at',
  lastError: 'whatsapp_api_last_error'
}

function nowIso() {
  return new Date().toISOString()
}

function normalizeMessageDeliveryStatus(status = '') {
  const normalized = cleanString(status).toLowerCase().replace(/[\s-]+/g, '_')
  if (normalized === 'seen') return 'read'
  if (normalized === 'delivery_ack') return 'delivered'
  if (normalized === 'server_ack') return 'sent'
  return normalized
}

function getMessageDeliveryStatusPriority(status = '') {
  switch (normalizeMessageDeliveryStatus(status)) {
    case 'failed':
    case 'error':
    case 'undelivered':
    case 'rejected':
      return 100
    case 'read':
    case 'played':
      return 90
    case 'delivered':
      return 80
    case 'sent':
      return 70
    case 'accepted':
      return 60
    case 'warning':
      return 55
    case 'pending':
    case 'queued':
    case 'scheduled':
      return 20
    default:
      return 0
  }
}

function pickBestMessageDeliveryStatus(currentStatus = '', incomingStatus = '') {
  const incoming = normalizeMessageDeliveryStatus(incomingStatus)
  if (!incoming) return cleanString(currentStatus)

  const current = normalizeMessageDeliveryStatus(currentStatus)
  return getMessageDeliveryStatusPriority(incoming) >= getMessageDeliveryStatusPriority(current)
    ? incoming
    : current
}

function isPostgres() {
  return Boolean(process.env.DATABASE_URL)
}

function hashId(prefix, value) {
  return `${prefix}_${crypto.createHash('sha256').update(String(value || crypto.randomUUID())).digest('hex').slice(0, 24)}`
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

const normalizeProfilePictureKey = (key = '') => cleanString(key).toLowerCase().replace(/[\s_-]+/g, '')

const PROFILE_PICTURE_URL_KEYS = new Set([
  'profilepictureurl',
  'profilephotourl',
  'profileimageurl',
  'avatarurl',
  'photourl',
  'pictureurl',
  'displaypictureurl',
  'headshoturl'
])

const PROFILE_PICTURE_CONTEXT_KEYS = new Set([
  'profile',
  'customerprofile',
  'whatsappprofile',
  'avatar',
  'photo',
  'picture',
  'image',
  'displaypicture',
  'headshot'
])

function isHttpUrl(value) {
  const text = cleanString(value)
  return /^https?:\/\//i.test(text) ? text : ''
}

function isLikelyProfilePictureUrlKey(key, path = []) {
  const normalizedKey = normalizeProfilePictureKey(key)
  if (PROFILE_PICTURE_URL_KEYS.has(normalizedKey)) return true

  const hasProfileHint =
    normalizedKey.includes('profile') ||
    normalizedKey.includes('avatar') ||
    normalizedKey.includes('photo') ||
    normalizedKey.includes('picture') ||
    normalizedKey.includes('headshot')

  if (normalizedKey.endsWith('url') && hasProfileHint) return true

  if (normalizedKey === 'url') {
    return path.some(part => PROFILE_PICTURE_CONTEXT_KEYS.has(normalizeProfilePictureKey(part)))
  }

  if (normalizedKey === 'imageurl') {
    return path.some(part => PROFILE_PICTURE_CONTEXT_KEYS.has(normalizeProfilePictureKey(part)))
  }

  return false
}

function parseJsonLikeValue(value) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed || !/^[{[]/.test(trimmed)) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function findProfilePictureUrlInValue(value, { path = [], depth = 0, seen = new WeakSet() } = {}) {
  const parsedValue = parseJsonLikeValue(value)
  if (!parsedValue || depth > 5) return ''

  if (typeof parsedValue === 'string') {
    return path.length && isLikelyProfilePictureUrlKey(path[path.length - 1], path.slice(0, -1))
      ? isHttpUrl(parsedValue)
      : ''
  }

  if (Array.isArray(parsedValue)) {
    for (const item of parsedValue) {
      const found = findProfilePictureUrlInValue(item, { path, depth: depth + 1, seen })
      if (found) return found
    }
    return ''
  }

  if (typeof parsedValue !== 'object') return ''
  if (seen.has(parsedValue)) return ''
  seen.add(parsedValue)

  for (const [key, child] of Object.entries(parsedValue)) {
    if (!isLikelyProfilePictureUrlKey(key, path)) continue
    const found = findProfilePictureUrlInValue(child, { path: [...path, key], depth: depth + 1, seen })
    if (found) return found
  }

  const priorityKeys = [
    'customerProfile',
    'profile',
    'whatsAppProfile',
    'whatsappProfile',
    'contact',
    'avatar',
    'photo',
    'picture',
    'image'
  ]

  for (const key of priorityKeys) {
    if (!(key in parsedValue)) continue
    const found = findProfilePictureUrlInValue(parsedValue[key], { path: [...path, key], depth: depth + 1, seen })
    if (found) return found
  }

  for (const [key, child] of Object.entries(parsedValue)) {
    if (!child || typeof child !== 'object') continue
    const found = findProfilePictureUrlInValue(child, { path: [...path, key], depth: depth + 1, seen })
    if (found) return found
  }

  return ''
}

function isFreshDate(value, ttlMs) {
  if (!value) return false
  const time = new Date(value).getTime()
  return Number.isFinite(time) && Date.now() - time < ttlMs
}

export function findWhatsAppProfilePictureUrl(value) {
  return findProfilePictureUrlInValue(value)
}

function normalizePublicBaseUrl(value = '') {
  return cleanString(value).replace(/\/+$/, '')
}

function isPrivateHost(hostname = '') {
  const host = hostname.toLowerCase()
  return host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
}

function requirePublicHttpsBaseUrl(baseUrl = '', mediaLabel = 'archivos') {
  const normalized = normalizePublicBaseUrl(baseUrl)
  let parsed
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error(`Para enviar ${mediaLabel} por WhatsApp, configura una URL pública HTTPS de Ristak.`)
  }

  if (parsed.protocol !== 'https:' || isPrivateHost(parsed.hostname)) {
    throw new Error(`Para enviar ${mediaLabel} por WhatsApp, Ristak necesita estar publicado en una URL HTTPS que WhatsApp pueda abrir.`)
  }

  return normalized
}

export function buildLocalMediaUrl(localMedia, publicBaseUrl = '') {
  const publicPath = cleanString(localMedia?.publicPath)
  if (!publicPath) return ''

  const baseUrl = normalizePublicBaseUrl(publicBaseUrl || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL)
  if (!baseUrl) return publicPath

  try {
    const parsed = new URL(baseUrl)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return `${baseUrl}${publicPath}`
    }
  } catch {
    return publicPath
  }

  return publicPath
}

function parseImageDataUrl(value = '') {
  const match = cleanString(value).match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([a-z0-9+/=\s]+)$/i)
  if (!match) {
    throw new Error('La foto debe ser JPG, PNG o WebP.')
  }

  const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase()
  const extension = IMAGE_EXTENSION_BY_MIME[mimeType]
  if (!extension) {
    throw new Error('La foto debe ser JPG, PNG o WebP.')
  }

  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64')
  if (!buffer.length) {
    throw new Error('La foto está vacía.')
  }

  if (buffer.length > MAX_WHATSAPP_IMAGE_BYTES) {
    throw new Error('La foto pesa demasiado. Toma otra foto más ligera o recórtala antes de enviarla.')
  }

  return { buffer, mimeType, extension }
}

function parseAudioDataUrl(value = '') {
  const match = cleanString(value).match(/^data:([^;,]+)((?:;[^;,=]+=[^;,]+)*);base64,([a-z0-9+/=\s]+)$/i)
  if (!match) {
    throw new Error('El audio no llegó en un formato válido.')
  }

  const mimeType = match[1].toLowerCase()
  const params = String(match[2] || '').toLowerCase()
  const extension = AUDIO_EXTENSION_BY_MIME[mimeType]
  if (!extension) {
    throw new Error('WhatsApp no acepta este formato de audio. Graba otra vez o usa un audio compatible.')
  }

  const buffer = Buffer.from(match[3].replace(/\s/g, ''), 'base64')
  if (!buffer.length) {
    throw new Error('El audio está vacío.')
  }

  if (buffer.length > MAX_WHATSAPP_AUDIO_BYTES) {
    throw new Error('El audio pesa demasiado. Graba uno más corto para poder enviarlo por WhatsApp.')
  }

  return { buffer, mimeType, params, extension }
}

function sanitizeDocumentFilename(value = '', mimeType = '') {
  const extension = DOCUMENT_EXTENSION_BY_MIME[mimeType] || 'pdf'
  const rawName = cleanString(value).split(/[\\/]/).pop() || `documento-${Date.now()}.${extension}`
  const withoutControlChars = rawName.replace(/[\u0000-\u001f\u007f]/g, '')
  const sanitized = withoutControlChars.replace(/[<>:"/\\|?*]+/g, '_').replace(/\s+/g, ' ').trim()
  const finalName = sanitized || `documento-${Date.now()}.${extension}`
  return /\.[a-z0-9]{2,8}$/i.test(finalName) ? finalName.slice(0, 180) : `${finalName.slice(0, 170)}.${extension}`
}

function parseDocumentDataUrl(value = '', filename = '', providedMimeType = '') {
  const match = cleanString(value).match(/^data:([^;,]*)?(?:;[^,]*)?;base64,([a-z0-9+/=\s]+)$/i)
  if (!match) {
    throw new Error('El documento no llegó en un formato válido.')
  }

  const extension = cleanString(filename).toLowerCase().split('.').pop()
  const directMimeType = cleanString(providedMimeType).toLowerCase()
  const dataUrlMimeType = cleanString(match[1]).toLowerCase()
  const mimeType = DOCUMENT_EXTENSION_BY_MIME[directMimeType]
    ? directMimeType
    : DOCUMENT_EXTENSION_BY_MIME[dataUrlMimeType]
      ? dataUrlMimeType
      : DOCUMENT_MIME_BY_EXTENSION[extension]

  if (!mimeType) {
    throw new Error('El documento debe ser PDF, Word, Excel, PowerPoint, TXT o CSV.')
  }

  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64')
  if (!buffer.length) {
    throw new Error('El documento está vacío.')
  }

  if (buffer.length > MAX_WHATSAPP_DOCUMENT_BYTES) {
    throw new Error('El documento pesa demasiado. Elige uno de menos de 20 MB para poder enviarlo por WhatsApp.')
  }

  return {
    buffer,
    mimeType,
    extension: DOCUMENT_EXTENSION_BY_MIME[mimeType],
    filename: sanitizeDocumentFilename(filename, mimeType)
  }
}

function audioNeedsWhatsAppConversion({ mimeType, params }) {
  return !(mimeType === 'audio/ogg' && String(params || '').includes('opus'))
}

function normalizeVoiceNoteMimeType({ mimeType, params } = {}) {
  const cleanMimeType = cleanString(mimeType).toLowerCase()
  if (cleanMimeType === 'audio/ogg' && String(params || '').toLowerCase().includes('opus')) {
    return WHATSAPP_VOICE_NOTE_MIME_TYPE
  }
  return cleanMimeType
}

function runFfmpeg(args = []) {
  return new Promise((resolve, reject) => {
    const binary = process.env.FFMPEG_PATH || 'ffmpeg'
    const child = spawn(binary, args)
    let stderr = ''

    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })

    child.on('error', () => {
      reject(new Error('El audio salió en un formato que WhatsApp no acepta y este servidor no pudo adaptarlo. Intenta grabarlo otra vez.'))
    })

    child.on('close', code => {
      if (code === 0) {
        resolve()
        return
      }

      const detail = stderr.trim().slice(0, 240)
      reject(new Error(detail || 'No se pudo preparar el audio para WhatsApp. Intenta grabarlo otra vez.'))
    })
  })
}

async function convertAudioToOggOpus({ buffer, extension }) {
  const folder = await fs.mkdtemp(join(tmpdir(), 'ristak-whatsapp-audio-'))
  const inputPath = join(folder, `input.${extension || 'audio'}`)
  const outputPath = join(folder, 'voice.ogg')

  try {
    await fs.writeFile(inputPath, buffer)
    await runFfmpeg([
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-c:a',
      'libopus',
      '-b:a',
      '48k',
      outputPath
    ])

    const converted = await fs.readFile(outputPath)
    if (!converted.length) {
      throw new Error('El audio convertido quedó vacío. Intenta grabarlo otra vez.')
    }

    if (converted.length > MAX_WHATSAPP_AUDIO_BYTES) {
      throw new Error('El audio pesa demasiado. Graba uno más corto para poder enviarlo por WhatsApp.')
    }

    return converted
  } finally {
    await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function saveWhatsAppImageDataUrl(dataUrl = '') {
  const { buffer, mimeType, extension } = parseImageDataUrl(dataUrl)
  const dayKey = new Date().toISOString().slice(0, 10)
  const folder = join(WHATSAPP_IMAGE_UPLOAD_ROOT, dayKey)
  const filename = `${crypto.randomUUID()}.${extension}`
  const filePath = join(folder, filename)

  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(filePath, buffer)

  return {
    mimeType,
    size: buffer.length,
    publicPath: `${WHATSAPP_IMAGE_PUBLIC_PATH}/${dayKey}/${filename}`,
    filename
  }
}

export async function saveWhatsAppAudioDataUrl(dataUrl = '') {
  const parsed = parseAudioDataUrl(dataUrl)
  const originalMimeType = parsed.mimeType
  const media = audioNeedsWhatsAppConversion(parsed)
    ? {
        buffer: await convertAudioToOggOpus(parsed),
        mimeType: WHATSAPP_VOICE_NOTE_MIME_TYPE,
        extension: 'ogg'
      }
    : {
        buffer: parsed.buffer,
        mimeType: normalizeVoiceNoteMimeType(parsed) || parsed.mimeType,
        extension: parsed.extension
      }
  const dayKey = new Date().toISOString().slice(0, 10)
  const folder = join(WHATSAPP_AUDIO_UPLOAD_ROOT, dayKey)
  const filename = `${crypto.randomUUID()}.${media.extension}`
  const filePath = join(folder, filename)

  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(filePath, media.buffer)

  return {
    mimeType: media.mimeType,
    originalMimeType,
    size: media.buffer.length,
    filePath,
    publicPath: `${WHATSAPP_AUDIO_PUBLIC_PATH}/${dayKey}/${filename}`,
    filename
  }
}

async function saveWhatsAppDocumentDataUrl(dataUrl = '', filename = '', mimeType = '') {
  const parsed = parseDocumentDataUrl(dataUrl, filename, mimeType)
  const dayKey = new Date().toISOString().slice(0, 10)
  const folder = join(WHATSAPP_DOCUMENT_UPLOAD_ROOT, dayKey)
  const storedFilename = `${crypto.randomUUID()}.${parsed.extension}`
  const filePath = join(folder, storedFilename)

  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(filePath, parsed.buffer)

  return {
    mimeType: parsed.mimeType,
    size: parsed.buffer.length,
    filePath,
    publicPath: `${WHATSAPP_DOCUMENT_PUBLIC_PATH}/${dayKey}/${storedFilename}`,
    storedFilename,
    filename: parsed.filename
  }
}

function parseJsonValue(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function toDateTime(value) {
  if (!value) return null
  if (typeof value === 'number') {
    const millis = value > 9999999999 ? value : value * 1000
    return new Date(millis).toISOString()
  }

  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function maskSecret(value = '') {
  const cleanValue = cleanString(value)
  if (!cleanValue) return ''
  if (cleanValue.length <= 8) return '••••'
  return `${cleanValue.slice(0, 4)}••••${cleanValue.slice(-4)}`
}

async function getEncryptedConfig(key) {
  const value = await getAppConfig(key)
  if (!value) return ''

  try {
    return decrypt(value)
  } catch (error) {
    logger.warn(`No se pudo desencriptar ${key}: ${error.message}`)
    return ''
  }
}

async function setEncryptedConfig(key, value) {
  const cleanValue = cleanString(value)
  if (!cleanValue) return
  await setAppConfig(key, encrypt(cleanValue))
}

async function deleteAppConfig(keys = []) {
  for (const key of keys) {
    await db.run('DELETE FROM app_config WHERE config_key = ?', [key])
  }
}

async function loadConfig({ includeSecrets = false } = {}) {
  const [
    enabled,
    senderPhone,
    phoneNumberId,
    wabaId,
    provider,
    webhookEndpointId,
    webhookUrl,
    webhookStatus,
    connectedAt,
    disconnectedAt,
    lastSyncedAt,
    lastError,
    apiKey,
    webhookSecret
  ] = await Promise.all([
    getAppConfig(CONFIG_KEYS.enabled),
    getAppConfig(CONFIG_KEYS.senderPhone),
    getAppConfig(CONFIG_KEYS.phoneNumberId),
    getAppConfig(CONFIG_KEYS.wabaId),
    getAppConfig(CONFIG_KEYS.provider),
    getAppConfig(CONFIG_KEYS.webhookEndpointId),
    getAppConfig(CONFIG_KEYS.webhookUrl),
    getAppConfig(CONFIG_KEYS.webhookStatus),
    getAppConfig(CONFIG_KEYS.connectedAt),
    getAppConfig(CONFIG_KEYS.disconnectedAt),
    getAppConfig(CONFIG_KEYS.lastSyncedAt),
    getAppConfig(CONFIG_KEYS.lastError),
    includeSecrets ? getEncryptedConfig(CONFIG_KEYS.apiKey) : Promise.resolve(''),
    includeSecrets ? getEncryptedConfig(CONFIG_KEYS.webhookSecret) : Promise.resolve('')
  ])

  const hasApiKey = Boolean(await getAppConfig(CONFIG_KEYS.apiKey))

  return {
    enabled: enabled !== '0',
    hasApiKey,
    apiKey,
    senderPhone,
    phoneNumberId,
    wabaId,
    provider: provider || PROVIDER_NAME,
    webhookEndpointId,
    webhookUrl,
    webhookStatus,
    connectedAt,
    disconnectedAt,
    lastSyncedAt,
    lastError,
    webhookSecret
  }
}

async function ycloudRequest(path, { apiKey, method = 'GET', body, query } = {}) {
  const cleanApiKey = cleanString(apiKey)
  if (!cleanApiKey) {
    throw new Error('Falta la llave de WhatsApp API')
  }

  const url = new URL(`${YCLOUD_API_BASE_URL}${path}`)
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  }

  const response = await fetch(url.toString(), {
    method,
    headers: {
      accept: 'application/json',
      'X-API-Key': cleanApiKey,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })

  const text = await response.text()
  let data = null

  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { message: text }
    }
  }

  if (!response.ok) {
    const message = data?.error?.error_user_msg ||
      data?.error?.error_data ||
      data?.message ||
      data?.error?.message ||
      data?.error ||
      `WhatsApp API respondio ${response.status} ${response.statusText}`
    const error = new Error(typeof message === 'string' ? message : safeJson(message))
    error.statusCode = response.status
    error.ycloud = data
    throw error
  }

  return data || {}
}

async function listYCloudPhoneNumbers(apiKey) {
  const data = await ycloudRequest('/whatsapp/phoneNumbers', {
    apiKey,
    query: { page: 1, limit: 100, includeTotal: true }
  })

  return Array.isArray(data.items)
    ? data.items
    : Array.isArray(data.data)
      ? data.data
      : []
}

async function retrieveYCloudBalance(apiKey) {
  return ycloudRequest('/balance', { apiKey })
}

async function listYCloudTemplates(apiKey, { wabaId, status } = {}) {
  const data = await ycloudRequest('/whatsapp/templates', {
    apiKey,
    query: {
      page: 1,
      limit: 100,
      includeTotal: true,
      ...(wabaId ? { 'filter.wabaId': wabaId } : {}),
      ...(status ? { 'filter.status': status } : {})
    }
  })

  return Array.isArray(data.items)
    ? data.items
    : Array.isArray(data.data)
      ? data.data
      : []
}

async function listYCloudContacts(apiKey, { maxPages = 10 } = {}) {
  const contacts = []
  const limit = 100

  for (let page = 1; page <= maxPages; page += 1) {
    const data = await ycloudRequest('/contact/contacts', {
      apiKey,
      query: { page, limit, includeTotal: true }
    })
    const items = Array.isArray(data.items)
      ? data.items
      : Array.isArray(data.data)
        ? data.data
        : []

    contacts.push(...items)
    if (items.length < limit || (data.total && contacts.length >= Number(data.total))) break
  }

  return contacts
}

async function retrieveYCloudContact(apiKey, identifier) {
  const cleanIdentifier = cleanString(identifier)
  if (!cleanIdentifier) return null

  return ycloudRequest(`/contact/contacts/${encodeURIComponent(cleanIdentifier)}`, { apiKey })
}

async function retrieveYCloudPhoneNumberProfile(apiKey, { wabaId, phoneNumber } = {}) {
  const cleanWabaId = cleanString(wabaId)
  const normalized = normalizePhoneForStorage(phoneNumber) || cleanString(phoneNumber)
  if (!cleanWabaId || !normalized) return null

  return ycloudRequest(`/whatsapp/phoneNumbers/${encodeURIComponent(cleanWabaId)}/${encodeURIComponent(normalized)}/profile`, {
    apiKey
  })
}

async function enrichPhoneNumbersWithProfiles(apiKey, phoneNumbers = []) {
  return Promise.all(phoneNumbers.map(async (phoneNumber) => {
    const normalized = normalizePhoneNumberRecord(phoneNumber)
    if (!normalized.wabaId || !normalized.phoneNumber) return phoneNumber

    try {
      const profile = await retrieveYCloudPhoneNumberProfile(apiKey, {
        wabaId: normalized.wabaId,
        phoneNumber: normalized.phoneNumber
      })
      return {
        ...phoneNumber,
        profile,
        profilePictureUrl: profile?.profilePictureUrl,
        verifiedName: phoneNumber.verifiedName || profile?.verifiedName,
        businessProfile: profile
      }
    } catch (error) {
      logger.warn(`No se pudo leer perfil WhatsApp_API ${normalized.phoneNumber}: ${error.message}`)
      return phoneNumber
    }
  }))
}

async function listYCloudWebhookEndpoints(apiKey) {
  const data = await ycloudRequest('/webhookEndpoints', {
    apiKey,
    query: { page: 1, limit: 100, includeTotal: true }
  })

  return Array.isArray(data.items)
    ? data.items
    : Array.isArray(data.data)
      ? data.data
      : []
}

function normalizePhoneNumberRecord(record = {}) {
  const phoneNumber = normalizePhoneForStorage(record.phoneNumber || record.displayPhoneNumber) ||
    cleanString(record.phoneNumber || record.displayPhoneNumber)
  const wabaId = cleanString(record.wabaId)
  const id = cleanString(record.id) || hashId('waapi_phone', `${wabaId}|${phoneNumber}`)
  const businessProfile = record.businessProfile || record.profile || null

  return {
    id,
    wabaId,
    phoneNumber,
    displayPhoneNumber: cleanString(record.displayPhoneNumber) || phoneNumber,
    verifiedName: cleanString(record.verifiedName || businessProfile?.verifiedName || record.requestedVerifiedName || record.newName),
    profilePictureUrl: cleanString(record.profilePictureUrl || businessProfile?.profilePictureUrl),
    businessProfile,
    qualityRating: cleanString(record.qualityRating),
    messagingLimit: cleanString(record.messagingLimit || record.whatsappBusinessManagerMessagingLimit),
    status: cleanString(record.status || record.nameStatus || record.codeVerificationStatus),
    raw: record
  }
}

function mapPhoneNumberForResponse(record = {}) {
  const item = normalizePhoneNumberRecord(record)
  return {
    id: item.id,
    waba_id: item.wabaId || null,
    phone_number: item.phoneNumber || null,
    display_phone_number: item.displayPhoneNumber || null,
    verified_name: item.verifiedName || null,
    profile_picture_url: item.profilePictureUrl || null,
    business_profile_json: item.businessProfile ? safeJson(item.businessProfile) : null,
    quality_rating: item.qualityRating || null,
    messaging_limit: item.messagingLimit || null,
    status: item.status || null,
    label: cleanString(record.label) || null,
    is_default_sender: Number(record.is_default_sender || 0) === 1,
    api_send_enabled: record.api_send_enabled === undefined ? true : Number(record.api_send_enabled || 0) === 1,
    qr_send_enabled: Number(record.qr_send_enabled || 0) === 1,
    qr_status: cleanString(record.qr_status) || null,
    qr_connected_phone: cleanString(record.qr_connected_phone) || null,
    qr_consent_accepted_at: record.qr_consent_accepted_at || null,
    qr_last_connected_at: record.qr_last_connected_at || null,
    qr_last_disconnected_at: record.qr_last_disconnected_at || null,
    qr_last_error: cleanString(record.qr_last_error) || null
  }
}

function normalizeTemplateRecord(record = {}) {
  const wabaId = cleanString(record.wabaId)
  const name = cleanString(record.name)
  const language = cleanString(record.language)
  const officialTemplateId = cleanString(record.officialTemplateId || record.id)
  const id = officialTemplateId || hashId('waapi_tpl', `${wabaId}|${name}|${language}`)

  return {
    id,
    officialTemplateId,
    wabaId,
    name,
    language,
    category: cleanString(record.category),
    subCategory: cleanString(record.subCategory),
    previousCategory: cleanString(record.previousCategory),
    messageSendTtlSeconds: Number.isFinite(Number(record.messageSendTtlSeconds))
      ? Number(record.messageSendTtlSeconds)
      : null,
    status: cleanString(record.status).toUpperCase(),
    qualityRating: cleanString(record.qualityRating).toUpperCase(),
    reason: cleanString(record.reason || record.whatsappApiError?.message || record.whatsappApiError?.title),
    statusUpdateEvent: cleanString(record.statusUpdateEvent).toUpperCase(),
    disableDate: toDateTime(record.disableDate),
    components: Array.isArray(record.components) ? record.components : [],
    createTime: toDateTime(record.createTime),
    updateTime: toDateTime(record.updateTime),
    raw: record
  }
}

function normalizeBalanceRecord(record = {}) {
  const amount = Number(record.amount)
  return {
    amount: Number.isFinite(amount) ? amount : 0,
    currency: cleanString(record.currency).toUpperCase(),
    raw: record
  }
}

function alertSeverityRank(severity = '') {
  return {
    critical: 3,
    warning: 2,
    info: 1
  }[cleanString(severity).toLowerCase()] || 1
}

async function upsertAlert({ severity = 'info', alertType, title, message, sourceEventId, entityType, entityId, raw }) {
  const cleanAlertType = cleanString(alertType)
  const cleanEntityType = cleanString(entityType)
  const cleanEntityId = cleanString(entityId) || cleanEntityType || cleanAlertType
  if (!cleanAlertType || !title) return null

  const id = hashId('waapi_alert', `${cleanAlertType}|${cleanEntityType}|${cleanEntityId}`)

  await db.run(`
    INSERT INTO whatsapp_api_alerts (
      id, severity, alert_type, title, message, source_event_id,
      entity_type, entity_id, status, raw_payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      severity = excluded.severity,
      title = excluded.title,
      message = excluded.message,
      source_event_id = COALESCE(excluded.source_event_id, whatsapp_api_alerts.source_event_id),
      status = 'active',
      raw_payload_json = excluded.raw_payload_json,
      resolved_at = NULL,
      updated_at = CURRENT_TIMESTAMP
  `, [
    id,
    cleanString(severity).toLowerCase() || 'info',
    cleanAlertType,
    title,
    message || null,
    sourceEventId || null,
    cleanEntityType || null,
    cleanEntityId || null,
    safeJson(raw || null)
  ])

  return id
}

async function resolveAlert({ alertType, entityType, entityId }) {
  await db.run(`
    UPDATE whatsapp_api_alerts
    SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE status = 'active'
      AND alert_type = ?
      AND COALESCE(entity_type, '') = ?
      AND COALESCE(entity_id, '') = ?
  `, [
    cleanString(alertType),
    cleanString(entityType),
    cleanString(entityId)
  ])
}

async function syncPhoneNumberAlert(phoneNumber, { sourceEventId, eventType } = {}) {
  const entityId = phoneNumber.id || phoneNumber.phoneNumber
  const label = phoneNumber.displayPhoneNumber || phoneNumber.phoneNumber || entityId
  const status = cleanString(phoneNumber.status).toUpperCase()
  const qualityRating = cleanString(phoneNumber.qualityRating).toUpperCase()
  const qualityUpdateEvent = cleanString(phoneNumber.raw?.qualityUpdateEvent).toUpperCase()

  if (PHONE_STATUS_ALERTS[status]) {
    const config = PHONE_STATUS_ALERTS[status]
    await upsertAlert({
      severity: config.severity,
      alertType: 'phone_status',
      title: config.title,
      message: `${label}: ${config.message}`,
      sourceEventId,
      entityType: 'phone_number',
      entityId,
      raw: { eventType, phoneNumber: phoneNumber.raw || phoneNumber }
    })
  } else if (status === 'CONNECTED' || qualityUpdateEvent === 'UNFLAGGED') {
    await resolveAlert({ alertType: 'phone_status', entityType: 'phone_number', entityId })
  }

  if (qualityRating === 'RED' || qualityUpdateEvent === 'FLAGGED') {
    await upsertAlert({
      severity: 'warning',
      alertType: 'phone_quality',
      title: 'Calidad baja del numero',
      message: `${label}: La calidad esta en RED o fue marcada como FLAGGED. Esto puede bajar limites o bloquear plantillas.`,
      sourceEventId,
      entityType: 'phone_number',
      entityId,
      raw: { eventType, phoneNumber: phoneNumber.raw || phoneNumber }
    })
  } else if (qualityRating === 'YELLOW') {
    await upsertAlert({
      severity: 'info',
      alertType: 'phone_quality',
      title: 'Calidad media del numero',
      message: `${label}: La calidad esta en YELLOW. No es bloqueo, pero conviene cuidar volumen y contenido.`,
      sourceEventId,
      entityType: 'phone_number',
      entityId,
      raw: { eventType, phoneNumber: phoneNumber.raw || phoneNumber }
    })
  } else if (qualityRating === 'GREEN') {
    await resolveAlert({ alertType: 'phone_quality', entityType: 'phone_number', entityId })
  }
}

async function syncTemplateAlert(template, { sourceEventId, eventType } = {}) {
  const entityId = template.id || `${template.wabaId}|${template.name}|${template.language}`
  const label = `${template.name || 'Plantilla'} ${template.language ? `(${template.language})` : ''}`.trim()
  const status = cleanString(template.status).toUpperCase()
  const statusUpdateEvent = cleanString(template.statusUpdateEvent).toUpperCase()
  const qualityRating = cleanString(template.qualityRating).toUpperCase()
  const statusAlert = TEMPLATE_STATUS_ALERTS[status] || (statusUpdateEvent === 'FLAGGED'
    ? {
        severity: 'warning',
        title: 'Plantilla marcada',
        message: 'Meta marco esta plantilla y podria deshabilitarla si no mejora su rendimiento.'
      }
    : null)

  if (statusAlert) {
    await upsertAlert({
      severity: statusAlert.severity,
      alertType: 'template_status',
      title: statusAlert.title,
      message: `${label}: ${template.reason || statusAlert.message}`,
      sourceEventId,
      entityType: 'template',
      entityId,
      raw: { eventType, template: template.raw || template }
    })
  } else if (status === 'APPROVED') {
    await resolveAlert({ alertType: 'template_status', entityType: 'template', entityId })
  }

  if (qualityRating === 'RED') {
    await upsertAlert({
      severity: 'warning',
      alertType: 'template_quality',
      title: 'Calidad baja de plantilla',
      message: `${label}: La calidad esta en RED. Puede terminar pausada o deshabilitada.`,
      sourceEventId,
      entityType: 'template',
      entityId,
      raw: { eventType, template: template.raw || template }
    })
  } else if (qualityRating === 'GREEN') {
    await resolveAlert({ alertType: 'template_quality', entityType: 'template', entityId })
  }
}

async function syncBalanceAlert(balance) {
  if (!balance) return
  const amount = Number(balance.amount || 0)
  const currency = balance.currency || ''

  if (amount <= 0) {
    await upsertAlert({
      severity: 'critical',
      alertType: 'balance',
      title: 'Saldo de WhatsApp API agotado',
      message: `La cuenta de WhatsApp API reporta ${amount.toFixed(2)} ${currency}. Las plantillas pueden fallar por saldo insuficiente.`,
      entityType: 'account',
      entityId: 'balance',
      raw: balance.raw || balance
    })
  } else if (amount <= 10) {
    await upsertAlert({
      severity: 'warning',
      alertType: 'balance',
      title: 'Saldo bajo de WhatsApp API',
      message: `La cuenta de WhatsApp API reporta ${amount.toFixed(2)} ${currency}. Recarga antes de lanzar envios grandes.`,
      entityType: 'account',
      entityId: 'balance',
      raw: balance.raw || balance
    })
  } else {
    await resolveAlert({ alertType: 'balance', entityType: 'account', entityId: 'balance' })
  }
}

async function syncBusinessAccountAlert(account = {}, { sourceEventId, eventType } = {}) {
  const entityId = cleanString(account.id || account.wabaId || account.whatsappBusinessAccountId || 'business_account')
  const rawText = safeJson(account).toUpperCase()
  const decision = cleanString(account.decision || account.reviewDecision || account.accountReviewStatus || account.status).toUpperCase()

  if (eventType === 'whatsapp.business_account.deleted') {
    await upsertAlert({
      severity: 'critical',
      alertType: 'business_account',
      title: 'Cuenta WhatsApp Business eliminada',
      message: 'WhatsApp API aviso que la cuenta de WhatsApp Business fue eliminada. Revisa Meta o WhatsApp API antes de mandar.',
      sourceEventId,
      entityType: 'business_account',
      entityId,
      raw: { eventType, account }
    })
    return
  }

  if (
    rawText.includes('BANNED') ||
    rawText.includes('BLOCKED') ||
    rawText.includes('DISABLED') ||
    rawText.includes('RESTRICTED') ||
    rawText.includes('SUSPENDED') ||
    rawText.includes('LOCKED') ||
    rawText.includes('LIMITED')
  ) {
    await upsertAlert({
      severity: 'critical',
      alertType: 'business_account',
      title: 'Cuenta WhatsApp Business con bloqueo',
      message: 'WhatsApp API reporto una actualizacion grave en la cuenta de WhatsApp Business. Revisa el panel de Meta o WhatsApp API.',
      sourceEventId,
      entityType: 'business_account',
      entityId,
      raw: { eventType, account }
    })
    return
  }

  if (decision && !['APPROVED', 'CONNECTED'].includes(decision)) {
    await upsertAlert({
      severity: 'warning',
      alertType: 'business_account',
      title: 'Cuenta WhatsApp Business en revision',
      message: `WhatsApp API reporto decision/estado ${decision}. Puede afectar aprobacion o envio de plantillas.`,
      sourceEventId,
      entityType: 'business_account',
      entityId,
      raw: { eventType, account }
    })
  }
}

async function syncBalance(balanceRecord) {
  if (!balanceRecord) return null
  const balance = normalizeBalanceRecord(balanceRecord)

  await db.run(`
    INSERT INTO whatsapp_api_balance (
      id, amount, currency, raw_payload_json, updated_at
    ) VALUES ('current', ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      amount = excluded.amount,
      currency = excluded.currency,
      raw_payload_json = excluded.raw_payload_json,
      updated_at = CURRENT_TIMESTAMP
  `, [
    balance.amount,
    balance.currency || null,
    safeJson(balance.raw)
  ])

  await syncBalanceAlert(balance)
  return balance
}

async function syncTemplates(templates = [], options = {}) {
  for (const item of templates.map(normalizeTemplateRecord).filter(template => template.wabaId && template.name && template.language)) {
    await db.run(`
      INSERT INTO whatsapp_api_templates (
        id, official_template_id, waba_id, name, language, category,
        sub_category, previous_category, message_send_ttl_seconds, status,
        quality_rating, reason, status_update_event, disable_date,
        components_json, raw_payload_json, ycloud_create_time, ycloud_update_time,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(waba_id, name, language) DO UPDATE SET
        id = excluded.id,
        official_template_id = excluded.official_template_id,
        category = excluded.category,
        sub_category = excluded.sub_category,
        previous_category = excluded.previous_category,
        message_send_ttl_seconds = excluded.message_send_ttl_seconds,
        status = excluded.status,
        quality_rating = excluded.quality_rating,
        reason = excluded.reason,
        status_update_event = excluded.status_update_event,
        disable_date = excluded.disable_date,
        components_json = excluded.components_json,
        raw_payload_json = excluded.raw_payload_json,
        ycloud_create_time = excluded.ycloud_create_time,
        ycloud_update_time = excluded.ycloud_update_time,
        updated_at = CURRENT_TIMESTAMP
    `, [
      item.id,
      item.officialTemplateId || null,
      item.wabaId,
      item.name,
      item.language,
      item.category || null,
      item.subCategory || null,
      item.previousCategory || null,
      item.messageSendTtlSeconds,
      item.status || null,
      item.qualityRating || null,
      item.reason || null,
      item.statusUpdateEvent || null,
      item.disableDate,
      safeJson(item.components),
      safeJson(item.raw),
      item.createTime,
      item.updateTime
    ])

    await syncTemplateAlert(item, options)
    await syncLocalMessageTemplateFromYCloud(item)
  }
}

async function syncLocalMessageTemplateFromYCloud(template) {
  if (!template?.name || !template?.language) return

  try {
    await db.run(`
      UPDATE whatsapp_message_templates
      SET
        ycloud_template_id = COALESCE(?, ycloud_template_id),
        ycloud_status = ?,
        ycloud_reason = ?,
        ycloud_status_update_event = ?,
        ycloud_quality_rating = ?,
        ycloud_raw_payload_json = ?,
        ycloud_synced_at = CURRENT_TIMESTAMP,
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE name = ? AND language = ?
    `, [
      template.officialTemplateId || template.id || null,
      template.status || null,
      template.reason || null,
      template.statusUpdateEvent || null,
      template.qualityRating || null,
      safeJson(template.raw),
      template.name,
      template.language
    ])
  } catch (error) {
    logger.warn(`No se pudo sincronizar plantilla local ${template.name}/${template.language}: ${error.message}`)
  }
}

async function syncPhoneNumbers(phoneNumbers = [], options = {}) {
  for (const item of phoneNumbers.map(normalizePhoneNumberRecord)) {
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, waba_id, phone_number, display_phone_number, verified_name,
        profile_picture_url, business_profile_json, quality_rating, messaging_limit,
        status, raw_payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        waba_id = excluded.waba_id,
        phone_number = excluded.phone_number,
        display_phone_number = excluded.display_phone_number,
        verified_name = excluded.verified_name,
        profile_picture_url = COALESCE(NULLIF(excluded.profile_picture_url, ''), whatsapp_api_phone_numbers.profile_picture_url),
        business_profile_json = COALESCE(excluded.business_profile_json, whatsapp_api_phone_numbers.business_profile_json),
        quality_rating = excluded.quality_rating,
        messaging_limit = excluded.messaging_limit,
        status = excluded.status,
        raw_payload_json = excluded.raw_payload_json,
        updated_at = CURRENT_TIMESTAMP
    `, [
      item.id,
      item.wabaId || null,
      item.phoneNumber || null,
      item.displayPhoneNumber || null,
      item.verifiedName || null,
      item.profilePictureUrl || null,
      item.businessProfile ? safeJson(item.businessProfile) : null,
      item.qualityRating || null,
      item.messagingLimit || null,
      item.status || null,
      safeJson(item.raw)
    ])

    await syncPhoneNumberAlert(item, options)
  }
}

async function setDefaultSenderPhoneNumber(phoneNumberId) {
  const cleanPhoneNumberId = cleanString(phoneNumberId)
  if (!cleanPhoneNumberId) return

  await db.run(`
    UPDATE whatsapp_api_phone_numbers
    SET is_default_sender = CASE WHEN id = ? THEN 1 ELSE 0 END,
      updated_at = CURRENT_TIMESTAMP
  `, [cleanPhoneNumberId])
}

export async function setWhatsAppApiDefaultPhoneNumber({ phoneNumberId } = {}) {
  const cleanPhoneNumberId = cleanString(phoneNumberId)
  if (!cleanPhoneNumberId) {
    throw new Error('Elige el número que quieres dejar como principal')
  }

  const phoneNumber = await db.get(`
    SELECT id, waba_id, phone_number, display_phone_number
    FROM whatsapp_api_phone_numbers
    WHERE id = ?
  `, [cleanPhoneNumberId])

  if (!phoneNumber) {
    throw new Error('Ese número de WhatsApp no está conectado')
  }

  const senderPhone = phoneNumber.phone_number || phoneNumber.display_phone_number || ''
  await setDefaultSenderPhoneNumber(cleanPhoneNumberId)
  await setAppConfig(CONFIG_KEYS.senderPhone, senderPhone)
  await setAppConfig(CONFIG_KEYS.phoneNumberId, phoneNumber.id || '')
  await setAppConfig(CONFIG_KEYS.wabaId, phoneNumber.waba_id || '')
  await setAppConfig(CONFIG_KEYS.lastSyncedAt, nowIso())
  await setAppConfig(CONFIG_KEYS.lastError, '')

  return getWhatsAppApiStatus()
}

async function findBusinessPhoneNumberId(phone = '') {
  const normalized = normalizePhoneForStorage(phone) || cleanString(phone)
  if (!normalized) return null

  const rows = await db.all(`
    SELECT id, phone_number, display_phone_number
    FROM whatsapp_api_phone_numbers
  `).catch(() => [])

  const candidates = buildPhoneMatchCandidates(normalized)
  const match = rows.find(row => {
    const rowCandidates = buildPhoneMatchCandidates(row.phone_number || row.display_phone_number)
    return rowCandidates.some(candidate => candidates.includes(candidate))
  })

  return match?.id || null
}

async function findBusinessPhoneRowForSender({ phoneNumberId, fromPhone } = {}) {
  const cleanPhoneNumberId = cleanString(phoneNumberId)
  if (cleanPhoneNumberId) {
    return db.get(`
      SELECT id, waba_id, phone_number, display_phone_number, status,
        quality_rating, api_send_enabled, qr_send_enabled, qr_status, qr_last_error
      FROM whatsapp_api_phone_numbers
      WHERE id = ?
    `, [cleanPhoneNumberId]).catch(() => null)
  }

  const normalized = normalizePhoneForStorage(fromPhone) || cleanString(fromPhone)
  if (!normalized) return null

  const rows = await db.all(`
    SELECT id, waba_id, phone_number, display_phone_number, status,
      quality_rating, api_send_enabled, qr_send_enabled, qr_status, qr_last_error
    FROM whatsapp_api_phone_numbers
    ORDER BY is_default_sender DESC, updated_at DESC
  `).catch(() => [])
  const candidates = buildPhoneMatchCandidates(normalized)

  return rows.find(row => {
    const rowCandidates = buildPhoneMatchCandidates(row.phone_number || row.display_phone_number)
    return rowCandidates.some(candidate => candidates.includes(candidate))
  }) || null
}

function isQrFallbackReady(phoneRow = {}) {
  return Boolean(
    phoneRow?.id &&
    Number(phoneRow.qr_send_enabled || 0) === 1 &&
    cleanString(phoneRow.qr_status).toLowerCase() === 'connected'
  )
}

function getPhoneRowRestrictionReason(phoneRow = {}) {
  if (!phoneRow?.id) return ''
  const status = cleanString(phoneRow.status).toUpperCase()
  const apiSendEnabled = phoneRow.api_send_enabled === undefined || phoneRow.api_send_enabled === null
    ? 1
    : Number(phoneRow.api_send_enabled)
  if (apiSendEnabled === 0) {
    return 'El envio por WhatsApp API esta desactivado para este numero.'
  }
  if (API_FALLBACK_PHONE_STATUSES.has(status)) {
    return `WhatsApp API marco este numero como ${status}.`
  }
  return ''
}

function isBlockingOfficialApiAlert(alert = {}) {
  const alertType = cleanString(alert.alert_type).toLowerCase()
  const severity = cleanString(alert.severity).toLowerCase()
  const text = `${alert.title || ''} ${alert.message || ''}`.toUpperCase()

  if (alertType === 'phone_status') return severity === 'critical'
  if (alertType !== 'business_account') return false
  if (severity === 'critical') return true
  return API_FALLBACK_ERROR_PATTERN.test(text) && !API_FALLBACK_RECIPIENT_ERROR_PATTERN.test(text)
}

async function getOfficialApiRestrictionReason({ phoneRow, config } = {}) {
  const directReason = getPhoneRowRestrictionReason(phoneRow)
  if (directReason) return directReason

  const phoneEntityId = cleanString(phoneRow?.id)
  const wabaIds = [...new Set([
    phoneRow?.waba_id,
    config?.wabaId,
    'business_account'
  ].map(cleanString).filter(Boolean))]
  const params = []
  const alertScopes = []

  if (phoneEntityId) {
    alertScopes.push("(alert_type = 'phone_status' AND entity_type = 'phone_number' AND entity_id = ?)")
    params.push(phoneEntityId)
  }

  if (wabaIds.length) {
    alertScopes.push(`(alert_type = 'business_account' AND entity_type = 'business_account' AND entity_id IN (${wabaIds.map(() => '?').join(', ')}))`)
    params.push(...wabaIds)
  }

  if (!alertScopes.length) return ''

  const alerts = await db.all(`
    SELECT alert_type, severity, title, message, entity_type, entity_id
    FROM whatsapp_api_alerts
    WHERE status = 'active'
      AND (${alertScopes.join(' OR ')})
    ORDER BY updated_at DESC
  `, params).catch(() => [])
  const blockingAlert = alerts.find(isBlockingOfficialApiAlert)
  if (!blockingAlert) return ''

  return cleanString(blockingAlert.message || blockingAlert.title) ||
    'WhatsApp API reporto una restriccion activa.'
}

function getOfficialApiErrorText(error) {
  return [
    error?.message,
    error?.statusCode,
    safeJson(error?.ycloud || null)
  ].map(cleanString).filter(Boolean).join(' ')
}

function getOfficialApiRestrictionErrorReason(error) {
  const statusCode = Number(error?.statusCode || 0)
  const text = getOfficialApiErrorText(error)
  if (!text) return ''

  const hasBusinessScope = /\b(WABA|BUSINESS ACCOUNT|PHONE NUMBER|SENDER|FROM|ACCOUNT|QUALITY|MESSAGING LIMIT)\b/i.test(text)
  if (API_FALLBACK_RECIPIENT_ERROR_PATTERN.test(text) && !hasBusinessScope) return ''
  if (statusCode === 429) return 'WhatsApp API rechazo el envio por limite de volumen.'
  if (API_FALLBACK_ERROR_PATTERN.test(text)) {
    return 'WhatsApp API rechazo el envio por restriccion o limite.'
  }
  return ''
}

async function getOfficialApiFallbackDecision({ config, fromPhone, phoneNumberId, error } = {}) {
  const phoneRow = await findBusinessPhoneRowForSender({ phoneNumberId, fromPhone })
  const signalReason = await getOfficialApiRestrictionReason({ phoneRow, config })
  const errorReason = error ? getOfficialApiRestrictionErrorReason(error) : ''
  const reason = errorReason || signalReason

  return {
    phoneRow,
    reason,
    shouldFallback: Boolean(reason && isQrFallbackReady(phoneRow))
  }
}

async function activateOfficialApiRestrictionFromFailedMessage({ normalizedMessage, businessPhoneNumberId, businessPhone, reason } = {}) {
  const wabaId = cleanString(normalizedMessage?.wabaId || normalizedMessage?.waba_id || 'business_account')
  const label = cleanString(businessPhone || normalizedMessage?.from || normalizedMessage?.senderPhone || '')
  const message = `${label ? `${label}: ` : ''}${reason || 'WhatsApp API reporto que la cuenta no puede enviar.'}`

  await upsertAlert({
    severity: 'critical',
    alertType: 'business_account',
    title: 'WhatsApp API bloqueado',
    message,
    entityType: 'business_account',
    entityId: wabaId || 'business_account',
    raw: { message: normalizedMessage }
  })

  if (businessPhoneNumberId) {
    await upsertAlert({
      severity: 'critical',
      alertType: 'phone_status',
      title: 'Numero con WhatsApp API bloqueado',
      message,
      entityType: 'phone_number',
      entityId: businessPhoneNumberId,
      raw: { message: normalizedMessage }
    })
  }
}

async function retryFailedOfficialApiMessageViaQr({
  normalizedMessage,
  identity,
  businessPhoneNumberId,
  messageId,
  messageType,
  messageText,
  reason,
  existingMessage
} = {}) {
  const previousStatus = cleanString(existingMessage?.status).toLowerCase()
  const currentStatus = cleanString(normalizedMessage?.status).toLowerCase()
  if (previousStatus === 'failed' || currentStatus !== 'failed') return null

  const phoneRow = await findBusinessPhoneRowForSender({
    phoneNumberId: businessPhoneNumberId,
    fromPhone: identity?.businessPhone || normalizedMessage?.from
  })
  if (!isQrFallbackReady(phoneRow)) {
    logger.warn(`[WhatsApp API] Cuenta restringida pero QR no esta listo para ${identity?.businessPhone || normalizedMessage?.from || 'numero desconocido'}`)
    return null
  }

  const fromPhone = identity?.businessPhone || normalizedMessage?.from
  const toPhone = identity?.phone || normalizedMessage?.to
  const fallbackExternalId = `${cleanString(normalizedMessage?.externalId || messageId) || hashId('waapi_failed', safeJson(normalizedMessage))}-qr-fallback`

  try {
    if (messageType === 'text' && messageText) {
      return await sendTextViaQrFallback({
        phoneNumberId: phoneRow.id,
        fromPhone,
        toPhone,
        body: messageText,
        externalId: fallbackExternalId,
        fallbackReason: reason
      })
    }

    if (messageType === 'image') {
      const image = normalizedMessage?.image || {}
      const link = cleanString(image.link || image.url)
      if (!link) return null
      return await sendImageViaQrFallback({
        phoneNumberId: phoneRow.id,
        fromPhone,
        toPhone,
        requestImage: {
          link,
          ...(image.caption ? { caption: image.caption } : {})
        },
        externalId: fallbackExternalId,
        fallbackReason: reason
      })
    }

    if (messageType === 'audio') {
      const audio = normalizedMessage?.audio || {}
      const link = cleanString(audio.link || audio.url)
      if (!link) return null
      return await sendAudioViaQrFallback({
        phoneNumberId: phoneRow.id,
        fromPhone,
        toPhone,
        requestAudio: { link },
        externalId: fallbackExternalId,
        fallbackReason: reason
      })
    }

    if (messageType === 'document') {
      const document = normalizedMessage?.document || {}
      const link = cleanString(document.link || document.url)
      if (!link) return null
      return await sendDocumentViaQrFallback({
        phoneNumberId: phoneRow.id,
        fromPhone,
        toPhone,
        requestDocument: {
          link,
          ...(document.caption ? { caption: document.caption } : {}),
          ...(document.filename || document.fileName ? { filename: document.filename || document.fileName } : {}),
          ...(document.mimeType || document.mimetype ? { mimeType: document.mimeType || document.mimetype } : {})
        },
        externalId: fallbackExternalId,
        fallbackReason: reason
      })
    }
  } catch (error) {
    logger.warn(`[WhatsApp API] No se pudo reintentar por QR ${messageId}: ${error.message}`)
  }

  return null
}

function normalizeYCloudContactRecord(record = {}) {
  const phone = normalizePhoneForStorage(record.phoneNumber) || cleanString(record.phoneNumber)
  const profileName = normalizeDisplayText(record.nickname || record.name || record.fullName || record.email)
  return {
    id: cleanString(record.id) || hashId('ycloud_contact', phone || record.email),
    phone,
    email: cleanString(record.email),
    profileName,
    profilePictureUrl: findProfilePictureUrlInValue(record),
    seenAt: toDateTime(record.lastSeen || record.createTime) || nowIso(),
    sourceId: cleanString(record.sourceId),
    sourceUrl: cleanString(record.sourceUrl),
    sourceType: cleanString(record.sourceType),
    raw: record
  }
}

async function syncYCloudContacts(contacts = []) {
  for (const contact of contacts.map(normalizeYCloudContactRecord).filter(item => item.phone)) {
    const localContact = await upsertLocalContact({
      phone: contact.phone,
      profileName: contact.profileName,
      messageTimestamp: contact.seenAt,
      attribution: {
        sourceId: contact.sourceId,
        sourceUrl: contact.sourceUrl,
        sourceType: contact.sourceType || 'ycloud_contact',
        sourceApp: SOURCE_NAME,
        entryPoint: 'ycloud_contacts',
        ctwaClid: '',
        headline: contact.profileName || contact.sourceId || '',
        body: ''
      }
    })

    await upsertWhatsAppApiContact({
      contactId: localContact.id,
      phone: contact.phone,
      profileName: contact.profileName,
      rawProfile: contact.raw,
      seenAt: contact.seenAt,
      profilePictureUrl: contact.profilePictureUrl,
      messageCountDelta: 0
    })
  }
}

function pickPhoneNumber(phoneNumbers = [], { senderPhone, phoneNumberId, wabaId } = {}) {
  const normalizedSender = normalizePhoneForStorage(senderPhone) || cleanString(senderPhone)
  const cleanPhoneNumberId = cleanString(phoneNumberId)
  const cleanWabaId = cleanString(wabaId)
  const normalized = phoneNumbers.map(normalizePhoneNumberRecord)

  if (cleanPhoneNumberId) {
    const matchedById = normalized.find(item => item.id === cleanPhoneNumberId)
    if (matchedById) return matchedById
  }

  if (normalizedSender) {
    const candidates = buildPhoneMatchCandidates(normalizedSender)
    const matchedByPhone = normalized.find(item => {
      const itemCandidates = buildPhoneMatchCandidates(item.phoneNumber || item.displayPhoneNumber)
      return itemCandidates.some(candidate => candidates.includes(candidate))
    })
    if (matchedByPhone) return matchedByPhone

    return {
      id: cleanPhoneNumberId || hashId('waapi_phone_manual', `${cleanWabaId}|${normalizedSender}`),
      wabaId: cleanWabaId,
      phoneNumber: normalizedSender,
      displayPhoneNumber: normalizedSender,
      verifiedName: '',
      status: 'manual',
      raw: { manual: true }
    }
  }

  if (cleanWabaId) {
    const matchedByWaba = normalized.find(item => item.wabaId === cleanWabaId)
    if (matchedByWaba) return matchedByWaba
  }

  return normalized[0] || null
}

async function createWebhookEndpoint(apiKey, webhookUrl) {
  return ycloudRequest('/webhookEndpoints', {
    apiKey,
    method: 'POST',
    body: {
      url: webhookUrl,
      enabledEvents: REQUIRED_WEBHOOK_EVENTS,
      description: WEBHOOK_DESCRIPTION,
      status: 'active'
    }
  })
}

async function updateWebhookEndpoint(apiKey, webhookEndpointId, webhookUrl) {
  return ycloudRequest(`/webhookEndpoints/${encodeURIComponent(webhookEndpointId)}`, {
    apiKey,
    method: 'PATCH',
    body: {
      url: webhookUrl,
      enabledEvents: REQUIRED_WEBHOOK_EVENTS,
      description: WEBHOOK_DESCRIPTION,
      status: 'active'
    }
  })
}

async function ensureWebhookEndpoint({ apiKey, webhookUrl, webhookEndpointId }) {
  const cleanWebhookUrl = cleanString(webhookUrl)
  if (!cleanWebhookUrl) {
    throw new Error('Falta la URL pública para el webhook de WhatsApp_API')
  }

  if (webhookEndpointId) {
    try {
      return await updateWebhookEndpoint(apiKey, webhookEndpointId, cleanWebhookUrl)
    } catch (error) {
      logger.warn(`No se pudo actualizar webhook de WhatsApp API ${webhookEndpointId}: ${error.message}`)
    }
  }

  const endpoints = await listYCloudWebhookEndpoints(apiKey)
  const existing = endpoints.find(endpoint =>
    endpoint.url === cleanWebhookUrl ||
    cleanString(endpoint.description) === WEBHOOK_DESCRIPTION
  )

  if (existing?.id) {
    return updateWebhookEndpoint(apiKey, existing.id, cleanWebhookUrl)
  }

  return createWebhookEndpoint(apiKey, cleanWebhookUrl)
}

async function getPhoneNumbersFromDb() {
  return db.all(`
    SELECT id, waba_id, phone_number, display_phone_number, verified_name,
      profile_picture_url, business_profile_json, quality_rating, messaging_limit,
      status, label, is_default_sender, api_send_enabled, qr_send_enabled,
      qr_consent_accepted_at, qr_consent_accepted_by, qr_status,
      qr_connected_phone, qr_last_connected_at, qr_last_disconnected_at,
      qr_last_error, updated_at
    FROM whatsapp_api_phone_numbers
    ORDER BY is_default_sender DESC, updated_at DESC, phone_number ASC
  `)
}

async function getBalanceFromDb() {
  const row = await db.get(`
    SELECT amount, currency, updated_at
    FROM whatsapp_api_balance
    WHERE id = 'current'
  `)

  if (!row) return null
  return {
    amount: Number(row.amount || 0),
    currency: row.currency || '',
    updated_at: row.updated_at || null
  }
}

function mapTemplateRow(row = {}) {
  return {
    id: row.id,
    official_template_id: row.official_template_id,
    waba_id: row.waba_id,
    name: row.name,
    language: row.language,
    category: row.category,
    sub_category: row.sub_category,
    previous_category: row.previous_category,
    message_send_ttl_seconds: row.message_send_ttl_seconds,
    status: row.status,
    quality_rating: row.quality_rating,
    reason: row.reason,
    status_update_event: row.status_update_event,
    disable_date: row.disable_date,
    components: parseJsonValue(row.components_json, []),
    ycloud_create_time: row.ycloud_create_time,
    ycloud_update_time: row.ycloud_update_time,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

async function getTemplatesFromDb({ status, limit = 100 } = {}) {
  const params = []
  const where = []

  if (status) {
    where.push('status = ?')
    params.push(cleanString(status).toUpperCase())
  }

  params.push(Math.max(1, Math.min(Number(limit) || 100, 200)))

  const rows = await db.all(`
    SELECT id, official_template_id, waba_id, name, language, category,
      sub_category, previous_category, message_send_ttl_seconds, status,
      quality_rating, reason, status_update_event, disable_date, components_json,
      ycloud_create_time, ycloud_update_time, created_at, updated_at
    FROM whatsapp_api_templates
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY
      CASE status
        WHEN 'APPROVED' THEN 0
        WHEN 'PENDING' THEN 1
        WHEN 'IN_APPEAL' THEN 2
        ELSE 3
      END,
      updated_at DESC,
      name ASC
    LIMIT ?
  `, params)

  return rows.map(mapTemplateRow)
}

async function getActiveAlertsFromDb({ limit = 20 } = {}) {
  const rows = await db.all(`
    SELECT id, severity, alert_type, title, message, source_event_id,
      entity_type, entity_id, status, created_at, resolved_at, updated_at
    FROM whatsapp_api_alerts
    WHERE status = 'active'
    ORDER BY
      CASE severity
        WHEN 'critical' THEN 0
        WHEN 'warning' THEN 1
        ELSE 2
      END,
      updated_at DESC
    LIMIT ?
  `, [Math.max(1, Math.min(Number(limit) || 20, 100))])

  return rows
}

async function countRows(sql, params = []) {
  try {
    const row = await db.get(sql, params)
    return Number(row?.total || 0)
  } catch {
    return 0
  }
}

async function getStats() {
  const [
    phoneNumbers,
    contacts,
    messages,
    inboundMessages,
    outboundMessages,
    attributedMessages,
    webhookEvents,
    templates,
    approvedTemplates,
    activeAlerts,
    criticalAlerts,
    templateSends
  ] = await Promise.all([
    countRows('SELECT COUNT(*) as total FROM whatsapp_api_phone_numbers'),
    countRows('SELECT COUNT(*) as total FROM whatsapp_api_contacts'),
    countRows('SELECT COUNT(*) as total FROM whatsapp_api_messages'),
    countRows("SELECT COUNT(*) as total FROM whatsapp_api_messages WHERE direction = 'inbound'"),
    countRows("SELECT COUNT(*) as total FROM whatsapp_api_messages WHERE direction = 'outbound'"),
    countRows('SELECT COUNT(*) as total FROM whatsapp_api_attribution'),
    countRows('SELECT COUNT(*) as total FROM whatsapp_api_webhook_events'),
    countRows('SELECT COUNT(*) as total FROM whatsapp_api_templates'),
    countRows("SELECT COUNT(*) as total FROM whatsapp_api_templates WHERE status = 'APPROVED'"),
    countRows("SELECT COUNT(*) as total FROM whatsapp_api_alerts WHERE status = 'active'"),
    countRows("SELECT COUNT(*) as total FROM whatsapp_api_alerts WHERE status = 'active' AND severity = 'critical'"),
    countRows('SELECT COUNT(*) as total FROM whatsapp_api_template_sends')
  ])

  return {
    phoneNumbers,
    contacts,
    messages,
    inboundMessages,
    outboundMessages,
    attributedMessages,
    webhookEvents,
    templates,
    approvedTemplates,
    activeAlerts,
    criticalAlerts,
    templateSends
  }
}

export async function getWhatsAppApiStatus() {
  const config = await loadConfig()
  const [stats, phoneNumbers, balance, templates, alerts, qrSessions] = await Promise.all([
    getStats(),
    getPhoneNumbersFromDb(),
    getBalanceFromDb(),
    getTemplatesFromDb({ limit: 12 }),
    getActiveAlertsFromDb({ limit: 12 }),
    getWhatsAppQrSessions().catch(error => {
      logger.warn(`No se pudieron leer sesiones QR WhatsApp: ${error.message}`)
      return []
    })
  ])

  const connected = Boolean(config.enabled && config.hasApiKey && config.webhookEndpointId)
  const requiresPhoneSelection = false
  const selectedPhone = phoneNumbers.find(phone => phone.id === config.phoneNumberId) ||
    phoneNumbers.find(phone => phone.phone_number === config.senderPhone) ||
    phoneNumbers.find(phone => Number(phone.is_default_sender || 0) === 1) ||
    phoneNumbers[0] ||
    null
  const highestSeverity = alerts.reduce((highest, alert) => {
    return !highest || alertSeverityRank(alert.severity) > alertSeverityRank(highest) ? alert.severity : highest
  }, '')

  return {
    provider: PROVIDER_NAME,
    source: SOURCE_NAME,
    connected,
    configured: Boolean(config.hasApiKey),
    requiresPhoneSelection,
    status: connected
      ? requiresPhoneSelection
        ? 'needs_phone'
        : 'connected'
      : config.hasApiKey
        ? 'disabled'
        : 'disconnected',
    credentials: {
      apiKeyMasked: config.hasApiKey ? '••••••••' : '',
      hasApiKey: config.hasApiKey
    },
    sender: {
      phone: config.senderPhone || '',
      phoneNumberId: config.phoneNumberId || '',
      wabaId: config.wabaId || ''
    },
    webhook: {
      id: config.webhookEndpointId || '',
      url: config.webhookUrl || '',
      status: config.webhookStatus || '',
      enabledEvents: REQUIRED_WEBHOOK_EVENTS
    },
    phoneNumbers,
    selectedPhone,
    balance,
    templates: {
      total: stats.templates,
      approved: stats.approvedTemplates,
      blocked: Math.max(0, stats.templates - stats.approvedTemplates),
      items: templates
    },
    alerts: {
      total: stats.activeAlerts,
      critical: stats.criticalAlerts,
      highestSeverity: highestSeverity || '',
      items: alerts
    },
    qr: {
      consentText: QR_CONSENT_TEXT,
      sessions: qrSessions
    },
    stats,
    timestamps: {
      connectedAt: config.connectedAt || null,
      disconnectedAt: config.disconnectedAt || null,
      lastSyncedAt: config.lastSyncedAt || null
    },
    lastError: config.lastError || ''
  }
}

export async function connectWhatsAppApi({ apiKey, senderPhone, phoneNumberId, wabaId, webhookUrl } = {}) {
  const saved = await loadConfig({ includeSecrets: true })
  const cleanApiKey = cleanString(apiKey) || saved.apiKey

  if (!cleanApiKey) {
    throw new Error('Pega la llave de WhatsApp API para conectar WhatsApp Business')
  }

  try {
    const [phoneNumbers, balance, templates, ycloudContacts] = await Promise.all([
      listYCloudPhoneNumbers(cleanApiKey),
      retrieveYCloudBalance(cleanApiKey).catch(error => {
        logger.warn(`No se pudo leer balance de WhatsApp API: ${error.message}`)
        return null
      }),
      listYCloudTemplates(cleanApiKey, { wabaId }).catch(error => {
        logger.warn(`No se pudieron leer plantillas de WhatsApp API: ${error.message}`)
        return []
      }),
      listYCloudContacts(cleanApiKey).catch(error => {
        logger.warn(`No se pudieron leer contactos de WhatsApp API: ${error.message}`)
        return []
      })
    ])
    const enrichedPhoneNumbers = await enrichPhoneNumbersWithProfiles(cleanApiKey, phoneNumbers)
    await syncPhoneNumbers(enrichedPhoneNumbers)
    if (balance) await syncBalance(balance)
    await syncTemplates(templates)
    await syncYCloudContacts(ycloudContacts)

    const selectedPhone = pickPhoneNumber(enrichedPhoneNumbers, { senderPhone, phoneNumberId, wabaId })
    if (selectedPhone) {
      await syncPhoneNumbers([selectedPhone.raw || selectedPhone])
    }

    const webhookEndpoint = await ensureWebhookEndpoint({
      apiKey: cleanApiKey,
      webhookUrl,
      webhookEndpointId: saved.webhookEndpointId
    })

    await setEncryptedConfig(CONFIG_KEYS.apiKey, cleanApiKey)
    await setAppConfig(CONFIG_KEYS.enabled, '1')
    await setAppConfig(CONFIG_KEYS.provider, PROVIDER_NAME)
    await setAppConfig(CONFIG_KEYS.webhookEndpointId, webhookEndpoint.id || '')
    await setAppConfig(CONFIG_KEYS.webhookUrl, webhookEndpoint.url || webhookUrl)
    await setAppConfig(CONFIG_KEYS.webhookStatus, webhookEndpoint.status || 'active')
    await setAppConfig(CONFIG_KEYS.connectedAt, saved.connectedAt || nowIso())
    await setAppConfig(CONFIG_KEYS.lastSyncedAt, nowIso())
    await setAppConfig(CONFIG_KEYS.lastError, '')

    if (webhookEndpoint.secret) {
      await setEncryptedConfig(CONFIG_KEYS.webhookSecret, webhookEndpoint.secret)
    }

    if (selectedPhone?.phoneNumber) {
      await setAppConfig(CONFIG_KEYS.senderPhone, selectedPhone.phoneNumber)
      await setAppConfig(CONFIG_KEYS.phoneNumberId, selectedPhone.id || '')
      await setAppConfig(CONFIG_KEYS.wabaId, selectedPhone.wabaId || '')
      await setDefaultSenderPhoneNumber(selectedPhone.id)
    }

    await backfillStoredWhatsAppApiMessageEvents({
      businessPhoneHints: [
        selectedPhone?.phoneNumber,
        senderPhone,
        ...enrichedPhoneNumbers.flatMap(item => [item.phoneNumber, item.displayPhoneNumber])
      ].filter(Boolean)
    }).catch(error => {
      logger.warn(`No se pudo recuperar historial guardado WhatsApp Business: ${error.message}`)
    })

    return getWhatsAppApiStatus()
  } catch (error) {
    await setAppConfig(CONFIG_KEYS.lastError, error.message)
    throw error
  }
}

export async function refreshWhatsAppApi() {
  const config = await loadConfig({ includeSecrets: true })
  if (!config.apiKey) {
    throw new Error('WhatsApp_API no tiene API key guardada')
  }

  try {
    const [phoneNumbers, balance, templates, ycloudContacts] = await Promise.all([
      listYCloudPhoneNumbers(config.apiKey),
      retrieveYCloudBalance(config.apiKey).catch(error => {
        logger.warn(`No se pudo actualizar balance de WhatsApp API: ${error.message}`)
        return null
      }),
      listYCloudTemplates(config.apiKey, { wabaId: config.wabaId }).catch(error => {
        logger.warn(`No se pudieron actualizar plantillas de WhatsApp API: ${error.message}`)
        return []
      }),
      listYCloudContacts(config.apiKey).catch(error => {
        logger.warn(`No se pudieron actualizar contactos de WhatsApp API: ${error.message}`)
        return []
      })
    ])
    const enrichedPhoneNumbers = await enrichPhoneNumbersWithProfiles(config.apiKey, phoneNumbers)
    await syncPhoneNumbers(enrichedPhoneNumbers)
    if (config.phoneNumberId) {
      await setDefaultSenderPhoneNumber(config.phoneNumberId)
    }
    if (balance) await syncBalance(balance)
    await syncTemplates(templates)
    await syncYCloudContacts(ycloudContacts)

    if (config.webhookEndpointId) {
      try {
        const webhookEndpoint = config.webhookUrl
          ? await updateWebhookEndpoint(config.apiKey, config.webhookEndpointId, config.webhookUrl)
          : await ycloudRequest(`/webhookEndpoints/${encodeURIComponent(config.webhookEndpointId)}`, {
              apiKey: config.apiKey
            })
        await setAppConfig(CONFIG_KEYS.webhookStatus, webhookEndpoint.status || config.webhookStatus || '')
        await setAppConfig(CONFIG_KEYS.webhookUrl, webhookEndpoint.url || config.webhookUrl || '')
        if (webhookEndpoint.secret) {
          await setEncryptedConfig(CONFIG_KEYS.webhookSecret, webhookEndpoint.secret)
        }
      } catch (error) {
        await setAppConfig(CONFIG_KEYS.webhookStatus, 'pending')
        await setAppConfig(CONFIG_KEYS.lastError, error.message)
      }
    }

    await backfillStoredWhatsAppApiMessageEvents({
      businessPhoneHints: [
        config.senderPhone,
        ...enrichedPhoneNumbers.flatMap(item => [item.phoneNumber, item.displayPhoneNumber])
      ].filter(Boolean)
    }).catch(error => {
      logger.warn(`No se pudo recuperar historial guardado WhatsApp Business: ${error.message}`)
    })

    await setAppConfig(CONFIG_KEYS.lastSyncedAt, nowIso())
    await setAppConfig(CONFIG_KEYS.lastError, '')
    return getWhatsAppApiStatus()
  } catch (error) {
    await setAppConfig(CONFIG_KEYS.lastError, error.message)
    throw error
  }
}

export async function previewWhatsAppApiPhoneNumbers({ apiKey } = {}) {
  const saved = await loadConfig({ includeSecrets: true })
  const cleanApiKey = cleanString(apiKey) || saved.apiKey

  if (!cleanApiKey) {
    throw new Error('Pega la llave de WhatsApp API para buscar tus numeros')
  }

  const phoneNumbers = await listYCloudPhoneNumbers(cleanApiKey)
  const enrichedPhoneNumbers = await enrichPhoneNumbersWithProfiles(cleanApiKey, phoneNumbers)

  return {
    total: enrichedPhoneNumbers.length,
    phoneNumbers: enrichedPhoneNumbers.map(mapPhoneNumberForResponse)
  }
}

export async function disconnectWhatsAppApi() {
  const config = await loadConfig({ includeSecrets: true })

  if (config.apiKey && config.webhookEndpointId) {
    try {
      const endpoint = await ycloudRequest(`/webhookEndpoints/${encodeURIComponent(config.webhookEndpointId)}`, {
        apiKey: config.apiKey,
        method: 'PATCH',
        body: { status: 'disabled' }
      })
      await setAppConfig(CONFIG_KEYS.webhookStatus, endpoint.status || 'disabled')
    } catch (error) {
      logger.warn(`No se pudo deshabilitar webhook de WhatsApp API: ${error.message}`)
    }
  }

  await setAppConfig(CONFIG_KEYS.enabled, '0')
  await setAppConfig(CONFIG_KEYS.disconnectedAt, nowIso())
  return getWhatsAppApiStatus()
}

export async function resetWhatsAppApiCredentials() {
  await disconnectWhatsAppApi().catch(() => null)
  await deleteAppConfig([
    CONFIG_KEYS.apiKey,
    CONFIG_KEYS.webhookSecret,
    CONFIG_KEYS.senderPhone,
    CONFIG_KEYS.phoneNumberId,
    CONFIG_KEYS.wabaId
  ])
  return getWhatsAppApiStatus()
}

function normalizeDisplayText(value) {
  const text = cleanString(value).replace(/\s+/g, ' ')
  if (!text || text === 'null' || text === 'undefined') return ''
  return text
}

function isPhoneLikeName(value, phone = '') {
  const text = normalizeDisplayText(value)
  if (!text) return false
  const hasLetters = /\p{L}/u.test(text)
  const digits = normalizePhoneDigits(text)
  const phoneDigits = normalizePhoneDigits(phone)
  return !hasLetters && digits.length >= 7 && (!phoneDigits || digits.endsWith(phoneDigits) || phoneDigits.endsWith(digits))
}

function shouldReplaceContactName(currentName, phone = '') {
  const text = normalizeDisplayText(currentName)
  return !text || text === GENERIC_CONTACT_NAME || text === 'Contacto WhatsApp' || isPhoneLikeName(text, phone)
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeMessageTextObject(value) {
  if (typeof value === 'string') return { body: value }
  return isPlainObject(value) ? value : null
}

function extractMessageText(message = {}) {
  const text = normalizeMessageTextObject(message.text)

  return cleanString(
    text?.body ||
    message.button?.text ||
    message.interactive?.button_reply?.title ||
    message.interactive?.list_reply?.title ||
    message.interactive?.nfm_reply?.body ||
    message.image?.caption ||
    message.video?.caption ||
    message.document?.caption ||
    message.template?.name ||
    message.location?.name ||
    message.location?.address ||
    message.reaction?.emoji ||
    ''
  )
}

function extractMessageMedia(message = {}) {
  const messageType = cleanString(message.type).toLowerCase()
  const candidates = [
    messageType ? message[messageType] : null,
    message.image,
    message.audio,
    message.video,
    message.document,
    message.sticker,
    message.media,
    message.file
  ].filter(isPlainObject)
  const media = candidates[0] || null

  if (!media) {
    return {
      mediaUrl: '',
      mediaMimeType: '',
      mediaFilename: '',
      mediaDurationMs: null
    }
  }

  return {
    mediaUrl: cleanString(media.link || media.url || media.href || media.publicUrl || media.downloadUrl),
    mediaMimeType: cleanString(media.mimeType || media.mime_type || media.mimetype || media.contentType),
    mediaFilename: cleanString(media.filename || media.fileName || media.name),
    mediaDurationMs: Number(media.durationMs || media.duration_ms || 0) || null
  }
}

function findReferralObject(payload = {}, message = {}) {
  const candidates = [
    message.referral,
    message.context?.referral,
    message.contextInfo?.referral,
    message.context_info?.referral,
    message.ad?.referral,
    message.context?.ad,
    message.contextInfo?.ad,
    payload.whatsappInboundMessage?.referral,
    payload.whatsappInboundMessage?.context?.referral,
    payload.whatsappInboundMessage?.contextInfo?.referral,
    payload.referral,
    payload.context?.referral,
    payload.contextInfo?.referral
  ]

  return candidates.find(isPlainObject) || {}
}

function extractAttribution(payload = {}, message = {}, messageText = '') {
  const referral = findReferralObject(payload, message)
  const detected = detectWhatsAppAttributionFields({ payload, message, referral }, [messageText])

  const attribution = {
    ctwaClid: cleanString(referral.ctwa_clid || referral.ctwaClid || referral.ctwa || detected.ctwaClid),
    sourceId: cleanString(referral.source_id || referral.sourceId || referral.ad_id || referral.adId || detected.sourceId),
    sourceUrl: cleanString(referral.source_url || referral.sourceUrl || detected.sourceUrl),
    sourceType: cleanString(referral.source_type || referral.sourceType || detected.sourceType),
    sourceApp: cleanString(referral.source_app || referral.sourceApp || detected.sourceApp),
    entryPoint: cleanString(referral.entry_point || referral.entryPoint || detected.entryPoint),
    headline: cleanString(referral.headline || referral.title || detected.headline),
    body: cleanString(referral.body || referral.description || detected.body),
    imageUrl: cleanString(referral.image_url || referral.imageUrl),
    videoUrl: cleanString(referral.video_url || referral.videoUrl),
    thumbnailUrl: cleanString(referral.thumbnail_url || referral.thumbnailUrl),
    conversionData: cleanString(detected.conversionData),
    ctwaPayload: cleanString(detected.ctwaPayload),
    referral
  }

  return {
    ...attribution,
    hasAttribution: Object.entries(attribution).some(([key, value]) => key !== 'referral' && Boolean(value)) ||
      Boolean(referral && Object.keys(referral).length)
  }
}

function normalizeDirectionValue(value) {
  const text = cleanString(value).toLowerCase()
  if (!text) return ''
  if (['inbound', 'incoming', 'received', 'customer', 'user'].includes(text)) return 'inbound'
  if (['outbound', 'outgoing', 'sent', 'business', 'api', 'app'].includes(text)) return 'outbound'
  return ''
}

function normalizePhoneSet(values = []) {
  return new Set(
    values
      .map(value => normalizePhoneForStorage(value) || cleanString(value))
      .filter(Boolean)
  )
}

function inferMessageDirection({ payload = {}, direction = '', message = {}, businessPhoneHints = [] }) {
  const type = cleanString(payload.type)
  const explicitDirection = normalizeDirectionValue(
    direction ||
    message.direction ||
    message.messageDirection ||
    message.message_direction ||
    message.flow
  )
  if (explicitDirection) return explicitDirection

  if (message.fromMe === true || message.from_me === true || message.isFromMe === true) return 'outbound'
  if (message.fromMe === false || message.from_me === false || message.isFromMe === false) return 'inbound'

  const hints = normalizePhoneSet(businessPhoneHints)
  const fromPhone = normalizePhoneForStorage(message.from) || cleanString(message.from)
  const toPhone = normalizePhoneForStorage(message.to) || cleanString(message.to)
  if (fromPhone && hints.has(fromPhone)) return 'outbound'
  if (toPhone && hints.has(toPhone)) return 'inbound'

  if (INBOUND_MESSAGE_EVENT_TYPES.has(type)) return 'inbound'
  if (OUTBOUND_MESSAGE_EVENT_TYPES.has(type)) return 'outbound'

  return 'inbound'
}

function getMessageIdentity({ payload = {}, direction = '', message = {}, businessPhoneHints = [] }) {
  const normalizedDirection = inferMessageDirection({ payload, direction, message, businessPhoneHints })
  const customerPhone = normalizedDirection === 'inbound' ? message.from : message.to
  const businessPhone = normalizedDirection === 'inbound' ? message.to : message.from

  return {
    direction: normalizedDirection,
    phone: normalizePhoneForStorage(customerPhone) || cleanString(customerPhone),
    fromPhone: normalizePhoneForStorage(message.from) || cleanString(message.from),
    toPhone: normalizePhoneForStorage(message.to) || cleanString(message.to),
    businessPhone: normalizePhoneForStorage(businessPhone) || cleanString(businessPhone)
  }
}

function getStoredContactDisplayName(existing = {}, fallbackName = '', phone = '') {
  const storedName = normalizeDisplayText(existing.full_name)
  const cleanFallback = normalizeDisplayText(fallbackName)

  if (storedName && storedName !== GENERIC_CONTACT_NAME && !isPhoneLikeName(storedName, phone)) {
    return storedName
  }

  if (cleanFallback && !isPhoneLikeName(cleanFallback, phone)) {
    return cleanFallback
  }

  return phone
}

async function upsertLocalContact({ phone, profileName, messageTimestamp, attribution }) {
  const canonicalPhone = normalizePhoneForStorage(phone) || cleanString(phone)
  if (!canonicalPhone) return { id: null, created: false }

  const existing = await findContactByPhoneCandidates(canonicalPhone)
  const contactName = isPhoneLikeName(profileName, canonicalPhone) ? '' : normalizeDisplayText(profileName)
  const fullName = contactName || GENERIC_CONTACT_NAME

  if (!existing) {
    const contactId = hashId('waapi_contact', canonicalPhone)
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, attribution_url, attribution_session_source,
        attribution_medium, attribution_ctwa_clid, attribution_ad_name, attribution_ad_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [
      contactId,
      canonicalPhone,
      fullName,
      contactName || null,
      SOURCE_NAME,
      attribution.sourceUrl || null,
      attribution.sourceApp || attribution.entryPoint || SOURCE_NAME,
      attribution.sourceType || 'whatsapp_api',
      attribution.ctwaClid || null,
      attribution.headline || attribution.sourceId || null,
      attribution.sourceId || null,
      messageTimestamp || nowIso()
    ])

    return {
      id: contactId,
      created: true,
      contactName: contactName || canonicalPhone
    }
  }

  const updates = []
  const params = []

  if (contactName && shouldReplaceContactName(existing.full_name, canonicalPhone)) {
    updates.push('full_name = ?')
    params.push(contactName)
    updates.push('first_name = ?')
    params.push(contactName)
  }

  if (!existing.source) {
    updates.push('source = ?')
    params.push(SOURCE_NAME)
  }

  if (attribution.sourceUrl) {
    updates.push('attribution_url = COALESCE(NULLIF(attribution_url, \'\'), ?)')
    params.push(attribution.sourceUrl)
  }

  if (attribution.sourceApp || attribution.entryPoint) {
    updates.push('attribution_session_source = COALESCE(NULLIF(attribution_session_source, \'\'), ?)')
    params.push(attribution.sourceApp || attribution.entryPoint)
  }

  if (attribution.sourceType) {
    updates.push('attribution_medium = COALESCE(NULLIF(attribution_medium, \'\'), ?)')
    params.push(attribution.sourceType)
  }

  if (attribution.ctwaClid) {
    updates.push('attribution_ctwa_clid = COALESCE(NULLIF(attribution_ctwa_clid, \'\'), ?)')
    params.push(attribution.ctwaClid)
  }

  if (attribution.sourceId) {
    updates.push('attribution_ad_id = COALESCE(NULLIF(attribution_ad_id, \'\'), ?)')
    params.push(attribution.sourceId)
    updates.push('attribution_ad_name = COALESCE(NULLIF(attribution_ad_name, \'\'), ?)')
    params.push(attribution.headline || attribution.sourceId)
  }

  if (updates.length) {
    updates.push('updated_at = CURRENT_TIMESTAMP')
    params.push(existing.id)
    await db.run(`UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`, params)
  }

  return {
    id: existing.id,
    created: false,
    contactName: getStoredContactDisplayName(existing, contactName, canonicalPhone)
  }
}

async function upsertWhatsAppApiContact({
  contactId,
  phone,
  profileName,
  rawProfile,
  seenAt,
  profilePictureUrl,
  profilePictureSource = 'whatsapp_api',
  messageCountDelta = 1
}) {
  const canonicalPhone = normalizePhoneForStorage(phone) || cleanString(phone)
  if (!canonicalPhone) return null

  const apiContactId = hashId('waapi_profile', canonicalPhone)
  const cleanProfilePictureUrl = cleanString(profilePictureUrl) || findProfilePictureUrlInValue(rawProfile)
  const cleanProfilePictureSource = cleanProfilePictureUrl
    ? cleanString(profilePictureSource) || 'whatsapp_api'
    : null
  const profilePictureUpdatedAt = cleanProfilePictureUrl ? nowIso() : null
  const safeMessageCountDelta = Math.max(Number(messageCountDelta) || 0, 0)

  await db.run(`
    INSERT INTO whatsapp_api_contacts (
      id, contact_id, phone, profile_name, profile_picture_url,
      profile_picture_source, profile_picture_updated_at, profile_picture_error,
      raw_profile_json, first_seen_at, last_seen_at, message_count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      contact_id = COALESCE(excluded.contact_id, whatsapp_api_contacts.contact_id),
      profile_name = COALESCE(NULLIF(excluded.profile_name, ''), whatsapp_api_contacts.profile_name),
      profile_picture_url = COALESCE(NULLIF(excluded.profile_picture_url, ''), whatsapp_api_contacts.profile_picture_url),
      profile_picture_source = CASE
        WHEN NULLIF(excluded.profile_picture_url, '') IS NOT NULL THEN excluded.profile_picture_source
        ELSE whatsapp_api_contacts.profile_picture_source
      END,
      profile_picture_updated_at = CASE
        WHEN NULLIF(excluded.profile_picture_url, '') IS NOT NULL THEN excluded.profile_picture_updated_at
        ELSE whatsapp_api_contacts.profile_picture_updated_at
      END,
      profile_picture_error = CASE
        WHEN NULLIF(excluded.profile_picture_url, '') IS NOT NULL THEN NULL
        ELSE whatsapp_api_contacts.profile_picture_error
      END,
      raw_profile_json = COALESCE(NULLIF(excluded.raw_profile_json, 'null'), whatsapp_api_contacts.raw_profile_json),
      first_seen_at = CASE
        WHEN whatsapp_api_contacts.first_seen_at IS NULL THEN excluded.first_seen_at
        WHEN excluded.first_seen_at IS NULL THEN whatsapp_api_contacts.first_seen_at
        WHEN excluded.first_seen_at < whatsapp_api_contacts.first_seen_at THEN excluded.first_seen_at
        ELSE whatsapp_api_contacts.first_seen_at
      END,
      last_seen_at = CASE
        WHEN whatsapp_api_contacts.last_seen_at IS NULL THEN excluded.last_seen_at
        WHEN excluded.last_seen_at IS NULL THEN whatsapp_api_contacts.last_seen_at
        WHEN excluded.last_seen_at > whatsapp_api_contacts.last_seen_at THEN excluded.last_seen_at
        ELSE whatsapp_api_contacts.last_seen_at
      END,
      message_count = COALESCE(whatsapp_api_contacts.message_count, 0) + COALESCE(excluded.message_count, 0),
      updated_at = CURRENT_TIMESTAMP
  `, [
    apiContactId,
    contactId || null,
    canonicalPhone,
    normalizeDisplayText(profileName) || null,
    cleanProfilePictureUrl || null,
    cleanProfilePictureSource,
    profilePictureUpdatedAt,
    safeJson(rawProfile),
    seenAt || nowIso(),
    seenAt || nowIso(),
    safeMessageCountDelta
  ])

  return apiContactId
}

function getProfileRawProfileForContact(contact = {}) {
  return parseJsonLikeValue(
    contact.whatsapp_raw_profile_json ||
    contact.raw_profile_json ||
    contact.customerProfile ||
    contact.customer_profile ||
    contact.profile ||
    null
  )
}

function buildYCloudContactLookupIdentifiers(contact = {}) {
  const rawProfile = getProfileRawProfileForContact(contact)
  const phone = normalizePhoneForStorage(contact.phone) || cleanString(contact.phone)
  const originalPhone = cleanString(contact.phone)
  const identifiers = [
    rawProfile?.id,
    rawProfile?.contactId,
    rawProfile?.contact_id,
    rawProfile?.ycloudContactId,
    rawProfile?.ycloud_contact_id
  ]

  if (phone) {
    identifiers.push(`+${phone}`)
    identifiers.push(phone)
  }
  if (originalPhone && originalPhone !== phone) identifiers.push(originalPhone)

  const seen = new Set()
  return identifiers
    .map(cleanString)
    .filter(identifier => {
      if (!identifier || seen.has(identifier)) return false
      seen.add(identifier)
      return true
    })
}

function getContactProfileName(contact = {}, rawProfile = null) {
  return normalizeDisplayText(
    contact.full_name ||
    contact.name ||
    contact.profile_name ||
    rawProfile?.nickname ||
    rawProfile?.name ||
    rawProfile?.fullName ||
    rawProfile?.customerProfile?.name ||
    rawProfile?.profile?.name ||
    ''
  )
}

async function retrieveYCloudContactProfilePicture(apiKey, contact = {}) {
  const identifiers = buildYCloudContactLookupIdentifiers(contact)
  let lastError = null

  for (const identifier of identifiers) {
    try {
      const rawProfile = await retrieveYCloudContact(apiKey, identifier)
      const profilePictureUrl = findProfilePictureUrlInValue(rawProfile)
      if (profilePictureUrl) {
        return { rawProfile, profilePictureUrl }
      }
    } catch (error) {
      lastError = error
      if (Number(error?.statusCode) !== 404) {
        logger.debug(`[WhatsApp API] No se pudo leer detalle de contacto ${identifier}: ${error.message}`)
      }
    }
  }

  if (lastError && Number(lastError?.statusCode) !== 404) {
    logger.debug(`[WhatsApp API] Contacto sin foto por API ${contact?.id || contact?.phone || ''}: ${lastError.message}`)
  }

  return { rawProfile: null, profilePictureUrl: '' }
}

export async function warmWhatsAppApiProfilePictures(contacts = [], {
  limit = WHATSAPP_API_PROFILE_PICTURE_BATCH_LIMIT,
  force = false
} = {}) {
  const uniqueContacts = []
  const seenKeys = new Set()

  for (const contact of Array.isArray(contacts) ? contacts : []) {
    const phone = normalizePhoneForStorage(contact?.phone) || cleanString(contact?.phone)
    const key = cleanString(contact?.id) || phone
    if (!phone || !key || seenKeys.has(key)) continue
    if (
      !force &&
      cleanString(contact?.whatsapp_profile_picture_url) &&
      isFreshDate(contact?.whatsapp_profile_picture_updated_at, WHATSAPP_API_PROFILE_PICTURE_CACHE_TTL_MS)
    ) {
      continue
    }

    seenKeys.add(key)
    uniqueContacts.push(contact)
    if (uniqueContacts.length >= Math.max(Number(limit) || WHATSAPP_API_PROFILE_PICTURE_BATCH_LIMIT, 1)) break
  }

  const results = new Map()
  if (!uniqueContacts.length) return results

  let config = null
  let configLoaded = false

  const getConfig = async () => {
    if (configLoaded) return config
    configLoaded = true
    try {
      config = await loadConfig({ includeSecrets: true })
    } catch (error) {
      logger.warn(`[WhatsApp API] No se pudo cargar configuracion para fotos de perfil: ${error.message}`)
      config = null
    }
    return config
  }

  for (const contact of uniqueContacts) {
    const key = cleanString(contact?.id) || cleanString(contact?.phone)
    const phone = normalizePhoneForStorage(contact?.phone) || cleanString(contact?.phone)
    let rawProfile = getProfileRawProfileForContact(contact)
    let profilePictureUrl = findProfilePictureUrlInValue(rawProfile)

    if (!profilePictureUrl) {
      const apiConfig = await getConfig()
      if (apiConfig?.enabled !== false && apiConfig?.apiKey) {
        const detail = await retrieveYCloudContactProfilePicture(apiConfig.apiKey, contact)
        rawProfile = detail.rawProfile || rawProfile
        profilePictureUrl = detail.profilePictureUrl
      }
    }

    if (!profilePictureUrl) continue

    await upsertWhatsAppApiContact({
      contactId: cleanString(contact?.id) || null,
      phone,
      profileName: getContactProfileName(contact, rawProfile),
      rawProfile,
      seenAt: nowIso(),
      profilePictureUrl,
      profilePictureSource: 'whatsapp_api',
      messageCountDelta: 0
    })

    results.set(key, profilePictureUrl)
  }

  return results
}

function normalizeWebhookMessage(rawMessage = {}) {
  if (!isPlainObject(rawMessage)) return rawMessage

  const normalized = { ...rawMessage }
  normalized.id = cleanString(normalized.id || normalized.messageId || normalized.message_id || normalized.ycloudMessageId) || normalized.id
  normalized.wamid = cleanString(normalized.wamid || normalized.waMessageId || normalized.whatsappMessageId || normalized.messageWamid) || normalized.wamid
  normalized.wabaId = cleanString(normalized.wabaId || normalized.waba_id || normalized.whatsappBusinessAccountId) || normalized.wabaId
  normalized.from = cleanString(normalized.from || normalized.fromPhone || normalized.from_phone || normalized.sender || normalized.senderPhone) || normalized.from
  normalized.to = cleanString(normalized.to || normalized.toPhone || normalized.to_phone || normalized.recipient || normalized.recipientPhone) || normalized.to
  normalized.status = cleanString(
    normalized.status ||
    normalized.messageStatus ||
    normalized.message_status ||
    normalized.deliveryStatus ||
    normalized.delivery_status
  ) || normalized.status
  normalized.sendTime = normalized.sendTime || normalized.send_time || normalized.timestamp || normalized.messageTimestamp || normalized.createdAt
  normalized.createTime = normalized.createTime || normalized.create_time || normalized.createdAt
  normalized.updateTime = normalized.updateTime || normalized.update_time || normalized.updatedAt

  const customerPhone = cleanString(normalized.customer || normalized.customerPhone || normalized.customer_phone || normalized.phone)
  const businessPhone = cleanString(normalized.businessPhone || normalized.business_phone || normalized.business || normalized.senderPhoneNumber)
  const explicitDirection = normalizeDirectionValue(normalized.direction || normalized.messageDirection || normalized.message_direction)
  const fromMe = normalized.fromMe === true || normalized.from_me === true || normalized.isFromMe === true
  const isOutbound = explicitDirection === 'outbound' || fromMe

  if (customerPhone) {
    if (isOutbound && !normalized.to) normalized.to = customerPhone
    if (!isOutbound && !normalized.from) normalized.from = customerPhone
  }

  if (businessPhone) {
    if (isOutbound && !normalized.from) normalized.from = businessPhone
    if (!isOutbound && !normalized.to) normalized.to = businessPhone
  }

  if (typeof normalized.text === 'string') {
    normalized.text = { body: normalized.text }
  } else if (!normalized.text && typeof normalized.body === 'string' && !normalized.template) {
    normalized.text = { body: normalized.body }
  }

  if (!normalized.customerProfile && normalized.profileName) {
    normalized.customerProfile = { name: normalized.profileName }
  } else if (!normalized.customerProfile && normalized.customerName) {
    normalized.customerProfile = { name: normalized.customerName }
  }

  const customerProfilePictureUrl =
    findProfilePictureUrlInValue(normalized.customerProfile) ||
    findProfilePictureUrlInValue(normalized.profile) ||
    findProfilePictureUrlInValue({
      profilePictureUrl: normalized.profilePictureUrl || normalized.profile_picture_url,
      profilePhotoUrl: normalized.profilePhotoUrl || normalized.profile_photo_url,
      avatarUrl: normalized.avatarUrl || normalized.avatar_url,
      photoUrl: normalized.photoUrl || normalized.photo_url,
      pictureUrl: normalized.pictureUrl || normalized.picture_url
    })

  if (customerProfilePictureUrl) {
    normalized.customerProfile = {
      ...(isPlainObject(normalized.customerProfile) ? normalized.customerProfile : {}),
      profilePictureUrl: customerProfilePictureUrl
    }
  }

  return normalized
}

async function upsertMessage({ payload, message, direction, businessPhoneHints = [], transport = 'api' }) {
  const normalizedMessage = normalizeWebhookMessage(message)
  const identity = getMessageIdentity({ payload, direction, message: normalizedMessage, businessPhoneHints })
  const cleanTransport = cleanString(normalizedMessage.transport || payload.transport || transport || 'api').toLowerCase() || 'api'
  const messageText = extractMessageText(normalizedMessage)
  const messageTimestamp = toDateTime(normalizedMessage.sendTime || normalizedMessage.createTime || normalizedMessage.updateTime || payload.createTime) || nowIso()
  const profileName = normalizedMessage.customerProfile?.name || normalizedMessage.profile?.name || ''
  const rawProfile = normalizedMessage.customerProfile || normalizedMessage.profile || null
  const profilePictureUrl = findProfilePictureUrlInValue(rawProfile)
  const attribution = extractAttribution(payload, normalizedMessage, messageText)
  const localContact = await upsertLocalContact({
    phone: identity.phone,
    profileName,
    messageTimestamp,
    attribution
  })
  const apiContactId = await upsertWhatsAppApiContact({
    contactId: localContact.id,
    phone: identity.phone,
    profileName,
    rawProfile,
    profilePictureUrl,
    seenAt: messageTimestamp
  })

  const ycloudMessageId = cleanString(normalizedMessage.id)
  const wamid = cleanString(normalizedMessage.wamid || normalizedMessage.context?.id)
  const computedMessageId = hashId('waapi_msg', ycloudMessageId || wamid || `${payload.id}|${identity.direction}|${identity.phone}`)
  const existingMessage = await db.get(`
    SELECT id, status, transport
    FROM whatsapp_api_messages
    WHERE id = ?
      OR (? != '' AND ycloud_message_id = ?)
      OR (? != '' AND wamid = ?)
    ORDER BY updated_at DESC
    LIMIT 1
  `, [computedMessageId, ycloudMessageId, ycloudMessageId, wamid, wamid]).catch(() => null)
  const messageId = existingMessage?.id || computedMessageId
  const businessPhoneNumberId = await findBusinessPhoneNumberId(identity.businessPhone)
  const incomingStatus = normalizeMessageDeliveryStatus(normalizedMessage.status)
  const status = pickBestMessageDeliveryStatus(existingMessage?.status, incomingStatus)
  const error = Array.isArray(normalizedMessage.errors) ? normalizedMessage.errors[0] : normalizedMessage.error
  const errorCode = cleanString(error?.code || normalizedMessage.errorCode)
  const errorMessage = cleanString(error?.message || error?.title || normalizedMessage.errorMessage)
  const messageType = cleanString(normalizedMessage.type) || 'unknown'
  const media = extractMessageMedia(normalizedMessage)

  await db.run(`
    INSERT INTO whatsapp_api_messages (
      id, ycloud_message_id, wamid, waba_id, business_phone_number_id,
      whatsapp_api_contact_id, contact_id,
      phone, from_phone, to_phone, business_phone, transport, direction, message_type,
      message_text, media_url, media_mime_type, media_filename, media_duration_ms,
      status, error_code, error_message, message_timestamp,
      raw_payload_json, context_json, referral_json,
      detected_ctwa_clid, detected_source_id, detected_source_url, detected_source_type,
      detected_source_app, detected_entry_point, detected_headline, detected_body,
      detected_conversion_data, detected_ctwa_payload, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      business_phone_number_id = COALESCE(excluded.business_phone_number_id, whatsapp_api_messages.business_phone_number_id),
      whatsapp_api_contact_id = COALESCE(excluded.whatsapp_api_contact_id, whatsapp_api_messages.whatsapp_api_contact_id),
      contact_id = COALESCE(excluded.contact_id, whatsapp_api_messages.contact_id),
      phone = COALESCE(NULLIF(excluded.phone, ''), whatsapp_api_messages.phone),
      from_phone = COALESCE(NULLIF(excluded.from_phone, ''), whatsapp_api_messages.from_phone),
      to_phone = COALESCE(NULLIF(excluded.to_phone, ''), whatsapp_api_messages.to_phone),
      business_phone = COALESCE(NULLIF(excluded.business_phone, ''), whatsapp_api_messages.business_phone),
      transport = COALESCE(NULLIF(excluded.transport, ''), whatsapp_api_messages.transport),
      direction = COALESCE(NULLIF(excluded.direction, ''), whatsapp_api_messages.direction),
      message_type = COALESCE(NULLIF(excluded.message_type, ''), whatsapp_api_messages.message_type),
      message_text = COALESCE(NULLIF(excluded.message_text, ''), whatsapp_api_messages.message_text),
      media_url = COALESCE(NULLIF(excluded.media_url, ''), whatsapp_api_messages.media_url),
      media_mime_type = COALESCE(NULLIF(excluded.media_mime_type, ''), whatsapp_api_messages.media_mime_type),
      media_filename = COALESCE(NULLIF(excluded.media_filename, ''), whatsapp_api_messages.media_filename),
      media_duration_ms = COALESCE(excluded.media_duration_ms, whatsapp_api_messages.media_duration_ms),
      status = COALESCE(NULLIF(excluded.status, ''), whatsapp_api_messages.status),
      error_code = COALESCE(NULLIF(excluded.error_code, ''), whatsapp_api_messages.error_code),
      error_message = COALESCE(NULLIF(excluded.error_message, ''), whatsapp_api_messages.error_message),
      message_timestamp = COALESCE(excluded.message_timestamp, whatsapp_api_messages.message_timestamp),
      raw_payload_json = excluded.raw_payload_json,
      context_json = COALESCE(NULLIF(excluded.context_json, 'null'), whatsapp_api_messages.context_json),
      referral_json = COALESCE(NULLIF(excluded.referral_json, 'null'), whatsapp_api_messages.referral_json),
      detected_ctwa_clid = COALESCE(NULLIF(excluded.detected_ctwa_clid, ''), whatsapp_api_messages.detected_ctwa_clid),
      detected_source_id = COALESCE(NULLIF(excluded.detected_source_id, ''), whatsapp_api_messages.detected_source_id),
      detected_source_url = COALESCE(NULLIF(excluded.detected_source_url, ''), whatsapp_api_messages.detected_source_url),
      detected_source_type = COALESCE(NULLIF(excluded.detected_source_type, ''), whatsapp_api_messages.detected_source_type),
      detected_source_app = COALESCE(NULLIF(excluded.detected_source_app, ''), whatsapp_api_messages.detected_source_app),
      detected_entry_point = COALESCE(NULLIF(excluded.detected_entry_point, ''), whatsapp_api_messages.detected_entry_point),
      detected_headline = COALESCE(NULLIF(excluded.detected_headline, ''), whatsapp_api_messages.detected_headline),
      detected_body = COALESCE(NULLIF(excluded.detected_body, ''), whatsapp_api_messages.detected_body),
      detected_conversion_data = COALESCE(NULLIF(excluded.detected_conversion_data, ''), whatsapp_api_messages.detected_conversion_data),
      detected_ctwa_payload = COALESCE(NULLIF(excluded.detected_ctwa_payload, ''), whatsapp_api_messages.detected_ctwa_payload),
      updated_at = CURRENT_TIMESTAMP
  `, [
    messageId,
    ycloudMessageId || null,
    wamid || null,
    cleanString(message.wabaId) || null,
    businessPhoneNumberId,
    apiContactId,
    localContact.id,
    identity.phone || null,
    identity.fromPhone || null,
    identity.toPhone || null,
    identity.businessPhone || null,
    cleanTransport,
    identity.direction,
    messageType,
    messageText || null,
    media.mediaUrl || null,
    media.mediaMimeType || null,
    media.mediaFilename || null,
    media.mediaDurationMs,
    status || null,
    errorCode || null,
    errorMessage || null,
    messageTimestamp,
    safeJson(normalizedMessage),
    safeJson(normalizedMessage.context || normalizedMessage.contextInfo || null),
    safeJson(attribution.referral || null),
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

  const restrictionReason = incomingStatus === 'failed'
    ? getOfficialApiRestrictionErrorReason({
        message: `${errorCode} ${errorMessage}`.trim(),
        ycloud: normalizedMessage
      })
    : ''

  if (cleanTransport === 'api' && identity.direction === 'outbound' && restrictionReason) {
    await activateOfficialApiRestrictionFromFailedMessage({
      normalizedMessage,
      businessPhoneNumberId,
      businessPhone: identity.businessPhone,
      reason: restrictionReason
    })
    await retryFailedOfficialApiMessageViaQr({
      normalizedMessage,
      identity,
      businessPhoneNumberId,
      messageId,
      messageType,
      messageText,
      reason: restrictionReason,
      existingMessage
    })
  }

  if (attribution.hasAttribution) {
    const attributionId = hashId('waapi_attr', `${messageId}|${attribution.sourceId}|${attribution.ctwaClid}`)
    await db.run(`
      INSERT INTO whatsapp_api_attribution (
        id, whatsapp_api_message_id, whatsapp_api_contact_id, contact_id, phone,
        ycloud_message_id, wamid, detected_ctwa_clid, detected_source_id,
        detected_source_url, detected_source_type, detected_source_app,
        detected_entry_point, detected_headline, detected_body,
        detected_conversion_data, detected_ctwa_payload, referral_json,
        raw_payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        contact_id = COALESCE(excluded.contact_id, whatsapp_api_attribution.contact_id),
        detected_ctwa_clid = COALESCE(NULLIF(excluded.detected_ctwa_clid, ''), whatsapp_api_attribution.detected_ctwa_clid),
        detected_source_id = COALESCE(NULLIF(excluded.detected_source_id, ''), whatsapp_api_attribution.detected_source_id),
        detected_source_url = COALESCE(NULLIF(excluded.detected_source_url, ''), whatsapp_api_attribution.detected_source_url),
        detected_source_type = COALESCE(NULLIF(excluded.detected_source_type, ''), whatsapp_api_attribution.detected_source_type),
        detected_source_app = COALESCE(NULLIF(excluded.detected_source_app, ''), whatsapp_api_attribution.detected_source_app),
        detected_entry_point = COALESCE(NULLIF(excluded.detected_entry_point, ''), whatsapp_api_attribution.detected_entry_point),
        detected_headline = COALESCE(NULLIF(excluded.detected_headline, ''), whatsapp_api_attribution.detected_headline),
        detected_body = COALESCE(NULLIF(excluded.detected_body, ''), whatsapp_api_attribution.detected_body),
        detected_conversion_data = COALESCE(NULLIF(excluded.detected_conversion_data, ''), whatsapp_api_attribution.detected_conversion_data),
        detected_ctwa_payload = COALESCE(NULLIF(excluded.detected_ctwa_payload, ''), whatsapp_api_attribution.detected_ctwa_payload),
        referral_json = COALESCE(NULLIF(excluded.referral_json, 'null'), whatsapp_api_attribution.referral_json),
        raw_payload_json = excluded.raw_payload_json
    `, [
      attributionId,
      messageId,
      apiContactId,
      localContact.id,
      identity.phone || null,
      ycloudMessageId || null,
      wamid || null,
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
      safeJson(attribution.referral || null),
      safeJson(normalizedMessage),
      messageTimestamp
    ])
  }

  return {
    messageId,
    contactId: localContact.id,
    apiContactId,
    attribution,
    direction: identity.direction,
    phone: identity.phone,
    businessPhone: identity.businessPhone,
    businessPhoneNumberId,
    transport: cleanTransport,
    contactName: localContact.contactName,
    profileName,
    messageText,
    messageType,
    isNew: !existingMessage,
    messageTimestamp
  }
}

function directionFromCandidatePath(path = [], payload = {}) {
  const pathText = path.join('.').toLowerCase()
  const type = cleanString(payload.type)

  if (pathText.includes('inbound')) return 'inbound'
  if (pathText.includes('outbound')) return 'outbound'
  if (pathText.includes('whatsappmessage') || pathText.includes('whatsapp_message')) return 'outbound'
  if (INBOUND_MESSAGE_EVENT_TYPES.has(type)) return 'inbound'
  if (OUTBOUND_MESSAGE_EVENT_TYPES.has(type)) return 'outbound'
  return ''
}

function looksLikeWhatsAppMessage(value = {}) {
  if (!isPlainObject(value)) return false

  const messageId = cleanString(value.id || value.wamid || value.messageId || value.message_id || value.whatsappMessageId)
  const hasAddress = Boolean(cleanString(
    value.from ||
    value.to ||
    value.fromPhone ||
    value.toPhone ||
    value.sender ||
    value.recipient ||
    value.customer
  ))
  const hasContent = Boolean(
    value.text ||
    value.image ||
    value.video ||
    value.audio ||
    value.document ||
    value.sticker ||
    value.interactive ||
    value.button ||
    value.contacts ||
    value.location ||
    value.reaction ||
    value.order ||
    value.template ||
    value.system
  )

  return Boolean(messageId && (hasAddress || hasContent))
}

function isMetadataPath(path = []) {
  const metadataKeys = new Set([
    'context',
    'contextinfo',
    'context_info',
    'referral',
    'ad',
    'error',
    'errors',
    'customerprofile',
    'profile'
  ])

  return path.some(part => metadataKeys.has(String(part || '').toLowerCase()))
}

function candidateKey(candidate = {}) {
  const message = normalizeWebhookMessage(candidate.message || {})
  return [
    candidate.direction || '',
    cleanString(message.id || ''),
    cleanString(message.wamid || ''),
    cleanString(message.from || ''),
    cleanString(message.to || ''),
    cleanString(message.sendTime || message.createTime || message.updateTime || '')
  ].join('|')
}

function collectWhatsAppMessageCandidates(value, { payload, path = [], candidates = [], seen = new WeakSet() } = {}) {
  if (!value || typeof value !== 'object') return candidates
  if (seen.has(value)) return candidates
  seen.add(value)

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectWhatsAppMessageCandidates(item, {
      payload,
      path: [...path, String(index)],
      candidates,
      seen
    }))
    return candidates
  }

  if (looksLikeWhatsAppMessage(value) && !isMetadataPath(path)) {
    candidates.push({
      message: value,
      direction: directionFromCandidatePath(path, payload),
      path: path.join('.')
    })
  }

  for (const [key, child] of Object.entries(value)) {
    if (!child || typeof child !== 'object') continue
    collectWhatsAppMessageCandidates(child, {
      payload,
      path: [...path, key],
      candidates,
      seen
    })
  }

  return candidates
}

function extractWhatsAppMessageCandidates(payload = {}) {
  const candidates = []

  if (payload?.whatsappInboundMessage) {
    candidates.push({
      message: payload.whatsappInboundMessage,
      direction: 'inbound',
      path: 'whatsappInboundMessage'
    })
  }

  if (payload?.whatsappMessage) {
    candidates.push({
      message: payload.whatsappMessage,
      direction: 'outbound',
      path: 'whatsappMessage'
    })
  }

  collectWhatsAppMessageCandidates(payload, { payload, candidates })

  const byKey = new Map()
  for (const candidate of candidates) {
    const key = candidateKey(candidate)
    if (!byKey.has(key)) byKey.set(key, candidate)
  }

  return [...byKey.values()]
}

async function getKnownBusinessPhoneHints(config = {}) {
  const rows = await db.all(`
    SELECT phone_number, display_phone_number
    FROM whatsapp_api_phone_numbers
  `).catch(() => [])

  return [
    config.senderPhone,
    ...rows.flatMap(row => [row.phone_number, row.display_phone_number])
  ].filter(Boolean)
}

async function processWhatsAppMessageEventPayload({ payload = {}, businessPhoneHints = [] } = {}) {
  const candidates = extractWhatsAppMessageCandidates(payload)
  const results = []

  for (const candidate of candidates) {
    results.push(await upsertMessage({
      payload,
      message: candidate.message,
      direction: candidate.direction,
      businessPhoneHints
    }))
  }

  return results
}

async function backfillStoredWhatsAppApiMessageEvents({ businessPhoneHints = [], limit = 1000 } = {}) {
  const eventTypes = [...MESSAGE_EVENT_TYPES]
  const placeholders = eventTypes.map(() => '?').join(', ')
  const rows = await db.all(`
    SELECT id, event_type, raw_payload_json
    FROM whatsapp_api_webhook_events
    WHERE event_type IN (${placeholders})
    ORDER BY COALESCE(ycloud_create_time, created_at) ASC, id ASC
    LIMIT ?
  `, [...eventTypes, limit])

  let savedMessages = 0
  for (const row of rows) {
    const payload = parseJsonValue(row.raw_payload_json, null)
    if (!payload) continue

    const results = await processWhatsAppMessageEventPayload({
      payload,
      businessPhoneHints
    })
    savedMessages += results.length
  }

  if (savedMessages) {
    logger.info(`WhatsApp Business API recupero ${savedMessages} mensajes desde eventos guardados`)
  }

  return { events: rows.length, messages: savedMessages }
}

function parseSignatureHeader(signatureHeader = '') {
  return String(signatureHeader || '').split(',').reduce((acc, part) => {
    const [key, value] = part.split('=')
    if (key && value) acc[key.trim()] = value.trim()
    return acc
  }, {})
}

function timingSafeEqualHex(a = '', b = '') {
  const left = Buffer.from(String(a), 'hex')
  const right = Buffer.from(String(b), 'hex')
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function verifyYCloudSignature({ rawBody, signatureHeader, secret }) {
  if (!secret) return null
  if (!signatureHeader) return false

  const parsed = parseSignatureHeader(signatureHeader)
  const timestamp = parsed.t
  const signature = parsed.s
  if (!timestamp || !signature) return false

  const signedPayload = `${timestamp}.${rawBody || ''}`
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex')

  return timingSafeEqualHex(expected, signature)
}

async function saveWebhookEvent({ payload, rawBody, endpointId, signatureValid, processedStatus = 'received', processedError = '' }) {
  const eventId = cleanString(payload?.id)
  const id = eventId || hashId('waapi_evt', rawBody || safeJson(payload))

  await db.run(`
    INSERT INTO whatsapp_api_webhook_events (
      id, event_id, event_type, api_version, webhook_endpoint_id,
      signature_valid, processed_status, processed_error, raw_payload_json,
      ycloud_create_time, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      processed_status = excluded.processed_status,
      processed_error = excluded.processed_error,
      raw_payload_json = excluded.raw_payload_json,
      updated_at = CURRENT_TIMESTAMP
  `, [
    id,
    eventId || null,
    cleanString(payload?.type) || 'unknown',
    cleanString(payload?.apiVersion) || null,
    endpointId || null,
    signatureValid === null ? null : signatureValid ? 1 : 0,
    processedStatus,
    processedError || null,
    rawBody || safeJson(payload),
    toDateTime(payload?.createTime)
  ])

  return id
}

export async function processYCloudWhatsAppWebhook({ payload, rawBody, signatureHeader, endpointId }) {
  const config = await loadConfig({ includeSecrets: true })
  const signatureValid = verifyYCloudSignature({
    rawBody,
    signatureHeader,
    secret: config.webhookSecret
  })

  if (signatureValid === false) {
    await saveWebhookEvent({
      payload,
      rawBody,
      endpointId,
      signatureValid,
      processedStatus: 'rejected',
      processedError: 'Firma de WhatsApp API invalida'
    })
    const error = new Error('Firma de WhatsApp API invalida')
    error.statusCode = 401
    throw error
  }

  const eventRowId = await saveWebhookEvent({
    payload,
    rawBody,
    endpointId,
    signatureValid,
    processedStatus: 'received'
  })

  try {
    const businessPhoneHints = await getKnownBusinessPhoneHints(config)
    const messageResults = MESSAGE_EVENT_TYPES.has(cleanString(payload?.type)) ||
      payload?.whatsappInboundMessage ||
      payload?.whatsappMessage
      ? await processWhatsAppMessageEventPayload({ payload, businessPhoneHints })
      : []

    await Promise.all(messageResults
      .filter(result => result?.direction === 'inbound' && result?.isNew !== false)
      .map(result => sendChatMessageNotification({
        contactId: result.contactId,
        contactName: result.contactName,
        phone: result.phone,
        profileName: result.profileName,
        text: result.messageText,
        messageType: result.messageType,
        messageId: result.messageId,
        timestamp: result.messageTimestamp
      }).catch(error => {
        logger.warn(`[Push] No se pudo avisar mensaje WhatsApp ${result?.messageId || ''}: ${error.message}`)
      })))

    if (payload?.whatsappPhoneNumber) {
      await syncPhoneNumbers([payload.whatsappPhoneNumber], {
        sourceEventId: eventRowId,
        eventType: payload?.type
      })
    }

    if (payload?.whatsappTemplate) {
      await syncTemplates([payload.whatsappTemplate], {
        sourceEventId: eventRowId,
        eventType: payload?.type
      })
    }

    if (payload?.whatsappBusinessAccount) {
      await syncBusinessAccountAlert(payload.whatsappBusinessAccount, {
        sourceEventId: eventRowId,
        eventType: payload?.type
      })
    }

    if (MESSAGE_EVENT_TYPES.has(cleanString(payload?.type)) && !messageResults.length) {
      logger.warn(`Evento WhatsApp Business ${payload?.type} no trajo mensajes reconocibles (${payload?.id || 'sin id'})`)
    }

    await db.run(`
      UPDATE whatsapp_api_webhook_events
      SET processed_status = 'processed', processed_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [eventRowId])

    return { processed: true, eventId: eventRowId }
  } catch (error) {
    await db.run(`
      UPDATE whatsapp_api_webhook_events
      SET processed_status = 'error', processed_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [error.message, eventRowId])
    throw error
  }
}

export async function getWhatsAppApiTemplates({ status, limit } = {}) {
  const [items, total, approved] = await Promise.all([
    getTemplatesFromDb({ status, limit }),
    countRows('SELECT COUNT(*) as total FROM whatsapp_api_templates'),
    countRows("SELECT COUNT(*) as total FROM whatsapp_api_templates WHERE status = 'APPROVED'")
  ])

  return {
    total,
    approved,
    blocked: Math.max(0, total - approved),
    items
  }
}

export async function connectWhatsAppQrForPhone({ phoneNumberId, acceptedRisk, acceptedBy } = {}) {
  return startWhatsAppQrConnection({ phoneNumberId, acceptedRisk, acceptedBy })
}

export async function getWhatsAppQrForPhone({ phoneNumberId } = {}) {
  if (phoneNumberId) return getWhatsAppQrSession(phoneNumberId)
  return getWhatsAppQrSessions()
}

export async function disconnectWhatsAppQrForPhone({ phoneNumberId } = {}) {
  return disconnectWhatsAppQrConnection({ phoneNumberId })
}

export async function createWhatsAppApiTemplate(templatePayload = {}) {
  const config = await loadConfig({ includeSecrets: true })
  if (!config.enabled || !config.apiKey) {
    throw new Error('WhatsApp Business no esta conectado con WhatsApp API')
  }

  const wabaId = cleanString(templatePayload.wabaId || config.wabaId)
  if (!wabaId) {
    throw new Error('Falta el WABA ID de WhatsApp Business para crear la plantilla')
  }

  const body = {
    ...templatePayload,
    wabaId
  }

  const response = await ycloudRequest('/whatsapp/templates', {
    apiKey: config.apiKey,
    method: 'POST',
    body
  })

  await syncTemplates([response], { eventType: 'manual_template_submit' })
  return response
}

export async function retrieveWhatsAppApiTemplate({ wabaId, name, language } = {}) {
  const config = await loadConfig({ includeSecrets: true })
  if (!config.enabled || !config.apiKey) {
    throw new Error('WhatsApp Business no esta conectado con WhatsApp API')
  }

  const cleanWabaId = cleanString(wabaId || config.wabaId)
  const cleanName = cleanString(name)
  const cleanLanguage = cleanString(language)

  if (!cleanWabaId) throw new Error('Falta el WABA ID de WhatsApp Business')
  if (!cleanName) throw new Error('Falta el nombre de la plantilla')
  if (!cleanLanguage) throw new Error('Falta el idioma de la plantilla')

  const response = await ycloudRequest(
    `/whatsapp/templates/${encodeURIComponent(cleanWabaId)}/${encodeURIComponent(cleanName)}/${encodeURIComponent(cleanLanguage)}`,
    { apiKey: config.apiKey }
  )

  await syncTemplates([response], { eventType: 'manual_template_sync' })
  return response
}

export async function syncWhatsAppApiTemplatesFromYCloud({ wabaId, status } = {}) {
  const config = await loadConfig({ includeSecrets: true })
  if (!config.enabled || !config.apiKey) {
    throw new Error('WhatsApp Business no esta conectado con WhatsApp API')
  }

  const items = await listYCloudTemplates(config.apiKey, {
    wabaId: wabaId || config.wabaId,
    status
  })
  await syncTemplates(items, { eventType: 'manual_templates_sync' })
  return getWhatsAppApiTemplates({ status })
}

function normalizeTemplateVariables(value) {
  const parsed = typeof value === 'string' ? parseJsonValue(value, value) : value
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    return Object.entries(parsed)
      .sort(([left], [right]) => {
        const leftNumber = Number(left)
        const rightNumber = Number(right)
        if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber
        return left.localeCompare(right)
      })
      .map(([, entryValue]) => entryValue)
  }

  if (typeof parsed === 'string' && parsed.trim()) {
    return parsed.split('\n').map(item => item.trim()).filter(Boolean)
  }

  return []
}

function buildTemplateComponents({ components, variables } = {}) {
  if (Array.isArray(components) && components.length) return components

  const normalizedVariables = normalizeTemplateVariables(variables)
  if (!normalizedVariables.length) return []

  return [{
    type: 'body',
    parameters: normalizedVariables.map((value) => {
      if (value && typeof value === 'object' && value.type) return value
      return {
        type: 'text',
        text: cleanString(value)
      }
    })
  }]
}

async function findTemplateForSend({ templateId, templateName, language }) {
  if (templateId) {
    return db.get(`
      SELECT id, waba_id, name, language, status, quality_rating, components_json
      FROM whatsapp_api_templates
      WHERE id = ?
    `, [templateId])
  }

  if (!templateName || !language) return null
  return db.get(`
    SELECT id, waba_id, name, language, status, quality_rating, components_json
    FROM whatsapp_api_templates
    WHERE name = ? AND language = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `, [templateName, language])
}

function getComponentParameters(components = [], type = '') {
  const target = cleanString(type).toLowerCase()
  const component = (Array.isArray(components) ? components : []).find(item =>
    cleanString(item?.type).toLowerCase() === target
  )
  return (Array.isArray(component?.parameters) ? component.parameters : [])
    .map((parameter) => cleanString(parameter?.text || parameter?.payload || parameter?.value || parameter))
}

function renderTemplateText(text = '', values = []) {
  return cleanString(text).replace(/\{\{\s*(\d+)\s*\}\}/g, (match, index) => {
    const value = values[Number(index) - 1]
    return value === undefined || value === null || value === '' ? match : cleanString(value)
  })
}

function buildTemplateTextForQrFallback({ template, components, variables } = {}) {
  const sourceComponents = parseJsonValue(template?.components_json, [])
  const requestComponents = Array.isArray(components) ? components : []
  const normalizedVariables = normalizeTemplateVariables(variables).map(cleanString)
  const textParts = []

  for (const type of ['header', 'body', 'footer']) {
    const source = (Array.isArray(sourceComponents) ? sourceComponents : []).find(component =>
      cleanString(component?.type).toLowerCase() === type
    )
    const sourceText = cleanString(source?.text)
    if (!sourceText) continue

    const params = getComponentParameters(requestComponents, type)
    const values = params.length ? params : type === 'body' ? normalizedVariables : []
    textParts.push(renderTemplateText(sourceText, values))
  }

  return textParts.map(cleanString).filter(Boolean).join('\n\n')
}

async function saveTemplateSend({ template, requestBody, response, variables }) {
  const id = hashId('waapi_tpl_send', response?.id || requestBody.externalId || `${requestBody.from}|${requestBody.to}|${template.name}|${Date.now()}`)

  await db.run(`
    INSERT INTO whatsapp_api_template_sends (
      id, template_id, template_name, language, to_phone, from_phone,
      ycloud_message_id, wamid, status, variables_json, raw_payload_json,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      ycloud_message_id = excluded.ycloud_message_id,
      wamid = excluded.wamid,
      raw_payload_json = excluded.raw_payload_json,
      updated_at = CURRENT_TIMESTAMP
  `, [
    id,
    template.id || null,
    template.name,
    template.language,
    requestBody.to,
    requestBody.from,
    cleanString(response?.id) || null,
    cleanString(response?.wamid) || null,
    cleanString(response?.status) || 'accepted',
    safeJson(variables || []),
    safeJson({ request: requestBody, response })
  ])

  return id
}

export async function sendWhatsAppApiTemplateMessage({
  to,
  from,
  templateId,
  templateName,
  language,
  components,
  variables,
  externalId,
  phoneNumberId
} = {}) {
  const config = await loadConfig({ includeSecrets: true })
  if (!config.enabled || !config.apiKey) {
    throw new Error('WhatsApp_API no esta conectado')
  }

  const fromPhone = normalizePhoneForStorage(from || config.senderPhone) || cleanString(from || config.senderPhone)
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const cleanTemplateName = cleanString(templateName)
  const cleanLanguage = cleanString(language)

  if (!fromPhone) throw new Error('Falta el numero emisor de WhatsApp_API')
  if (!toPhone) throw new Error('Falta el numero destino')
  if (!templateId && !cleanTemplateName) throw new Error('Elige una plantilla')

  const template = await findTemplateForSend({
    templateId: cleanString(templateId),
    templateName: cleanTemplateName,
    language: cleanLanguage
  })

  const finalTemplate = template || {
    id: cleanString(templateId),
    name: cleanTemplateName,
    language: cleanLanguage,
    status: ''
  }

  if (!finalTemplate.name) throw new Error('No se encontro el nombre de la plantilla')
  if (!finalTemplate.language) throw new Error('Falta el idioma de la plantilla')
  if (finalTemplate.status && finalTemplate.status !== 'APPROVED') {
    throw new Error(`La plantilla ${finalTemplate.name} esta ${finalTemplate.status}; solo se pueden enviar plantillas APPROVED`)
  }

  const templateComponents = buildTemplateComponents({ components, variables })
  const normalizedVariables = normalizeTemplateVariables(variables)
  const requestBody = {
    from: fromPhone,
    to: toPhone,
    type: 'template',
    template: {
      name: finalTemplate.name,
      language: {
        code: finalTemplate.language,
        policy: 'deterministic'
      },
      ...(templateComponents.length ? { components: templateComponents } : {})
    },
    filterUnsubscribed: true,
    filterBlocked: true,
    ...(externalId ? { externalId } : {})
  }

  const sendTemplateViaQr = async ({ fallbackReason, originalError, fallbackPhoneNumberId } = {}) => {
    const text = buildTemplateTextForQrFallback({
      template: finalTemplate,
      components: templateComponents,
      variables: normalizedVariables
    })
    if (!text) {
      if (originalError) throw originalError
      throw new Error('La plantilla no tiene texto guardado para mandarla por QR')
    }

    const qrResponse = await sendTextViaQrFallback({
      phoneNumberId: fallbackPhoneNumberId || phoneNumberId,
      fromPhone,
      toPhone,
      body: text,
      externalId,
      fallbackReason,
      originalError
    })

    await saveTemplateSend({
      template: finalTemplate,
      requestBody: {
        ...requestBody,
        fallbackTransport: 'qr',
        renderedText: text
      },
      response: qrResponse,
      variables: normalizedVariables
    })

    return {
      ...qrResponse,
      type: 'template',
      template: requestBody.template
    }
  }

  const fallbackDecision = await getOfficialApiFallbackDecision({
    config,
    fromPhone,
    phoneNumberId
  })
  if (fallbackDecision.shouldFallback) {
    return sendTemplateViaQr({
      fallbackReason: fallbackDecision.reason,
      fallbackPhoneNumberId: fallbackDecision.phoneRow?.id
    })
  }

  let response
  try {
    response = await ycloudRequest('/whatsapp/messages', {
      apiKey: config.apiKey,
      method: 'POST',
      body: requestBody
    })
  } catch (error) {
    const retryDecision = await getOfficialApiFallbackDecision({
      config,
      fromPhone,
      phoneNumberId,
      error
    })
    if (retryDecision.shouldFallback) {
      logger.warn(`[WhatsApp API] Envio de plantilla API fallo; usando QR para ${fromPhone}: ${retryDecision.reason}`)
      return sendTemplateViaQr({
        fallbackReason: retryDecision.reason,
        originalError: error,
        fallbackPhoneNumberId: retryDecision.phoneRow?.id
      })
    }
    throw error
  }

  await saveTemplateSend({
    template: finalTemplate,
    requestBody,
    response,
    variables: normalizedVariables
  })

  await upsertMessage({
    payload: {
      id: response.id || externalId || hashId('waapi_tpl_send_event', `${fromPhone}|${toPhone}|${finalTemplate.name}`),
      type: 'whatsapp.message.updated',
      createTime: nowIso(),
      whatsappMessage: response
    },
    message: {
      ...response,
      from: response.from || fromPhone,
      to: response.to || toPhone,
      type: response.type || 'template',
      template: response.template || requestBody.template,
      transport: 'api',
      createTime: response.createTime || nowIso()
    },
    direction: 'outbound',
    transport: 'api'
  })

  return response
}

function buildQrFallbackError(originalError, fallbackError) {
  const message = `${originalError?.message || 'WhatsApp API no pudo enviar el mensaje'}. El respaldo por QR tambien fallo: ${fallbackError.message}`
  const error = new Error(message)
  error.statusCode = originalError?.statusCode || 400
  error.originalError = originalError
  error.fallbackError = fallbackError
  return error
}

function decorateQrFallbackResponse(response = {}, fallbackReason = '') {
  return {
    ...response,
    transport: 'qr',
    ...(fallbackReason ? {
      fallback: true,
      fallbackFrom: 'api',
      fallbackReason
    } : {})
  }
}

async function sendTextViaQrFallback({ fromPhone, toPhone, body, externalId, phoneNumberId, fallbackReason, originalError } = {}) {
  try {
    const response = await sendWhatsAppQrTextMessage({
      phoneNumberId,
      from: fromPhone,
      to: toPhone,
      text: body,
      externalId
    })

    await upsertMessage({
      payload: {
        id: response.id || externalId || hashId('waqr_send_event', `${fromPhone}|${toPhone}|${body}`),
        type: fallbackReason ? 'whatsapp.qr.message.fallback_sent' : 'whatsapp.qr.message.sent',
        transport: 'qr',
        fallbackReason: fallbackReason || null,
        createTime: response.createTime || nowIso(),
        whatsappMessage: response
      },
      message: {
        ...response,
        from: response.from || fromPhone,
        to: response.to || toPhone,
        type: response.type || 'text',
        text: response.text || { body },
        transport: 'qr',
        createTime: response.createTime || nowIso()
      },
      direction: 'outbound',
      transport: 'qr'
    })

    return decorateQrFallbackResponse(response, fallbackReason)
  } catch (fallbackError) {
    if (originalError) throw buildQrFallbackError(originalError, fallbackError)
    throw fallbackError
  }
}

async function sendImageViaQrFallback({ fromPhone, toPhone, requestImage, imageDataUrl, externalId, phoneNumberId, localMedia, publicBaseUrl, fallbackReason, originalError } = {}) {
  try {
    const localMediaUrl = buildLocalMediaUrl(localMedia, publicBaseUrl)
    const response = await sendWhatsAppQrImageMessage({
      phoneNumberId,
      from: fromPhone,
      to: toPhone,
      imageDataUrl,
      imageUrl: requestImage?.link || localMediaUrl,
      caption: requestImage?.caption,
      externalId
    })
    const finalImage = {
      ...(requestImage || {}),
      ...(response.image || {}),
      link: cleanString(response.image?.link || requestImage?.link || localMediaUrl),
      mimeType: cleanString(response.image?.mimeType || requestImage?.mimeType || localMedia?.mimeType),
      ...(requestImage?.caption || response.image?.caption ? { caption: requestImage?.caption || response.image?.caption } : {})
    }

    await upsertMessage({
      payload: {
        id: response.id || externalId || hashId('waqr_img_event', `${fromPhone}|${toPhone}|${requestImage?.link || ''}`),
        type: fallbackReason ? 'whatsapp.qr.message.fallback_sent' : 'whatsapp.qr.message.sent',
        transport: 'qr',
        fallbackReason: fallbackReason || null,
        createTime: response.createTime || nowIso(),
        whatsappMessage: response
      },
      message: {
        ...response,
        from: response.from || fromPhone,
        to: response.to || toPhone,
        type: response.type || 'image',
        image: finalImage,
        transport: 'qr',
        createTime: response.createTime || nowIso()
      },
      direction: 'outbound',
      transport: 'qr'
    })

    return {
      ...decorateQrFallbackResponse(response, fallbackReason),
      image: finalImage,
      localMedia: localMedia
        ? { ...localMedia, publicUrl: localMediaUrl }
        : localMedia
    }
  } catch (fallbackError) {
    if (originalError) throw buildQrFallbackError(originalError, fallbackError)
    throw fallbackError
  }
}

async function sendDocumentViaQrFallback({ fromPhone, toPhone, requestDocument, documentDataUrl, externalId, phoneNumberId, localMedia, publicBaseUrl, fallbackReason, originalError } = {}) {
  try {
    const localMediaUrl = buildLocalMediaUrl(localMedia, publicBaseUrl)
    const response = await sendWhatsAppQrDocumentMessage({
      phoneNumberId,
      from: fromPhone,
      to: toPhone,
      documentDataUrl,
      documentUrl: requestDocument?.link || requestDocument?.url || localMediaUrl,
      caption: requestDocument?.caption,
      filename: requestDocument?.filename || requestDocument?.fileName || localMedia?.filename,
      mimeType: requestDocument?.mimeType || requestDocument?.mimetype || localMedia?.mimeType,
      externalId
    })
    const finalDocument = {
      ...(requestDocument || {}),
      ...(response.document || {}),
      link: cleanString(response.document?.link || requestDocument?.link || requestDocument?.url || localMediaUrl),
      url: cleanString(response.document?.url || response.document?.link || requestDocument?.url || requestDocument?.link || localMediaUrl),
      mimeType: cleanString(response.document?.mimeType || requestDocument?.mimeType || requestDocument?.mimetype || localMedia?.mimeType),
      filename: cleanString(response.document?.filename || requestDocument?.filename || requestDocument?.fileName || localMedia?.filename),
      ...(requestDocument?.caption || response.document?.caption ? { caption: requestDocument?.caption || response.document?.caption } : {})
    }

    await upsertMessage({
      payload: {
        id: response.id || externalId || hashId('waqr_doc_event', `${fromPhone}|${toPhone}|${finalDocument.link}`),
        type: fallbackReason ? 'whatsapp.qr.message.fallback_sent' : 'whatsapp.qr.message.sent',
        transport: 'qr',
        fallbackReason: fallbackReason || null,
        createTime: response.createTime || nowIso(),
        whatsappMessage: response
      },
      message: {
        ...response,
        from: response.from || fromPhone,
        to: response.to || toPhone,
        type: response.type || 'document',
        document: finalDocument,
        transport: 'qr',
        createTime: response.createTime || nowIso()
      },
      direction: 'outbound',
      transport: 'qr'
    })

    return {
      ...decorateQrFallbackResponse(response, fallbackReason),
      document: finalDocument,
      localMedia: localMedia
        ? { ...localMedia, publicUrl: localMediaUrl }
        : localMedia
    }
  } catch (fallbackError) {
    if (originalError) throw buildQrFallbackError(originalError, fallbackError)
    throw fallbackError
  }
}

async function sendAudioViaQrFallback({ fromPhone, toPhone, requestAudio, audioDataUrl, externalId, phoneNumberId, localMedia, publicBaseUrl, durationMs, fallbackReason, originalError } = {}) {
  try {
    const localMediaUrl = buildLocalMediaUrl(localMedia, publicBaseUrl)
    const publicAudioUrl = cleanString(requestAudio?.link || requestAudio?.url || localMediaUrl)
    const qrAudioUrl = cleanString(localMedia?.filePath || publicAudioUrl)
    const response = await sendWhatsAppQrAudioMessage({
      phoneNumberId,
      from: fromPhone,
      to: toPhone,
      audioDataUrl: qrAudioUrl ? undefined : audioDataUrl,
      audioUrl: qrAudioUrl,
      audioPublicUrl: publicAudioUrl,
      externalId,
      durationMs
    })
    const finalAudio = {
      ...(requestAudio || {}),
      ...(response.audio || {}),
      link: cleanString(response.audio?.link || publicAudioUrl),
      url: cleanString(response.audio?.url || response.audio?.link || publicAudioUrl),
      mimeType: cleanString(response.audio?.mimeType || requestAudio?.mimeType || localMedia?.mimeType),
      ptt: true,
      ...(durationMs ? { durationMs } : {})
    }

    await upsertMessage({
      payload: {
        id: response.id || externalId || hashId('waqr_audio_event', `${fromPhone}|${toPhone}|${publicAudioUrl || qrAudioUrl}`),
        type: fallbackReason ? 'whatsapp.qr.message.fallback_sent' : 'whatsapp.qr.message.sent',
        transport: 'qr',
        fallbackReason: fallbackReason || null,
        createTime: response.createTime || nowIso(),
        whatsappMessage: response
      },
      message: {
        ...response,
        from: response.from || fromPhone,
        to: response.to || toPhone,
        type: response.type || 'audio',
        audio: finalAudio,
        transport: 'qr',
        createTime: response.createTime || nowIso()
      },
      direction: 'outbound',
      transport: 'qr'
    })

    return {
      ...decorateQrFallbackResponse(response, fallbackReason),
      audio: finalAudio,
      localMedia: localMedia
        ? { ...localMedia, publicUrl: localMediaUrl }
        : localMedia
    }
  } catch (fallbackError) {
    if (originalError) throw buildQrFallbackError(originalError, fallbackError)
    throw fallbackError
  }
}

export async function sendWhatsAppApiTextMessage({ to, text, from, externalId, transport = 'api', phoneNumberId } = {}) {
  const config = await loadConfig({ includeSecrets: true })
  const fromPhone = normalizePhoneForStorage(from || config.senderPhone) || cleanString(from || config.senderPhone)
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const body = cleanString(text)
  const cleanTransport = cleanString(transport).toLowerCase() === 'qr' ? 'qr' : 'api'

  if (cleanTransport !== 'qr' && (!config.enabled || !config.apiKey)) {
    throw new Error('WhatsApp_API no está conectado')
  }

  if (!fromPhone) throw new Error('Falta el número emisor de WhatsApp_API')
  if (!toPhone) throw new Error('Falta el número destino')
  if (!body) throw new Error('Falta el texto del mensaje')

  if (cleanTransport === 'qr') {
    return sendTextViaQrFallback({
      phoneNumberId,
      fromPhone,
      toPhone,
      body,
      externalId
    })
  }

  const fallbackDecision = await getOfficialApiFallbackDecision({
    config,
    fromPhone,
    phoneNumberId
  })
  if (fallbackDecision.shouldFallback) {
    return sendTextViaQrFallback({
      phoneNumberId: fallbackDecision.phoneRow?.id || phoneNumberId,
      fromPhone,
      toPhone,
      body,
      externalId,
      fallbackReason: fallbackDecision.reason
    })
  }

  let response
  try {
    response = await ycloudRequest('/whatsapp/messages', {
      apiKey: config.apiKey,
      method: 'POST',
      body: {
        from: fromPhone,
        to: toPhone,
        type: 'text',
        text: { body },
        ...(externalId ? { externalId } : {})
      }
    })
  } catch (error) {
    const retryDecision = await getOfficialApiFallbackDecision({
      config,
      fromPhone,
      phoneNumberId,
      error
    })
    if (retryDecision.shouldFallback) {
      logger.warn(`[WhatsApp API] Envio API fallo; usando QR para ${fromPhone}: ${retryDecision.reason}`)
      return sendTextViaQrFallback({
        phoneNumberId: retryDecision.phoneRow?.id || phoneNumberId,
        fromPhone,
        toPhone,
        body,
        externalId,
        fallbackReason: retryDecision.reason,
        originalError: error
      })
    }
    throw error
  }

  await upsertMessage({
    payload: {
      id: response.id || externalId || hashId('waapi_send_event', `${fromPhone}|${toPhone}|${body}`),
      type: 'whatsapp.message.updated',
      createTime: nowIso(),
      whatsappMessage: response
    },
    message: {
      ...response,
      from: response.from || fromPhone,
      to: response.to || toPhone,
      type: response.type || 'text',
      text: response.text || { body },
      transport: 'api',
      createTime: response.createTime || nowIso()
    },
    direction: 'outbound',
    transport: 'api'
  })

  return response
}

export async function sendWhatsAppApiImageMessage({
  to,
  from,
  imageDataUrl,
  imageUrl,
  caption,
  externalId,
  transport = 'api',
  publicBaseUrl,
  phoneNumberId
} = {}) {
  const config = await loadConfig({ includeSecrets: true })
  const cleanTransport = cleanString(transport).toLowerCase() === 'qr' ? 'qr' : 'api'
  if (cleanTransport !== 'qr' && (!config.enabled || !config.apiKey)) {
    throw new Error('WhatsApp_API no está conectado')
  }

  const fromPhone = normalizePhoneForStorage(from || config.senderPhone) || cleanString(from || config.senderPhone)
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const cleanCaption = cleanString(caption).slice(0, 1024)
  const cleanImageUrl = cleanString(imageUrl)

  if (!fromPhone) throw new Error('Falta el número emisor de WhatsApp_API')
  if (!toPhone) throw new Error('Falta el número destino')

  let link = cleanImageUrl
  let savedImage = null

  if (!link) {
    savedImage = await saveWhatsAppImageDataUrl(imageDataUrl)
    if (cleanTransport === 'qr') {
      link = buildLocalMediaUrl(savedImage, publicBaseUrl)
    } else {
      const baseUrl = requirePublicHttpsBaseUrl(publicBaseUrl || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL, 'fotos')
      link = `${baseUrl}${savedImage.publicPath}`
    }
  }

  if (cleanTransport !== 'qr' && !/^https:\/\//i.test(link)) {
    throw new Error('La foto necesita un enlace público HTTPS para poder enviarse por WhatsApp.')
  }

  const requestBody = {
    from: fromPhone,
    to: toPhone,
    type: 'image',
    image: {
      link,
      ...(cleanCaption ? { caption: cleanCaption } : {})
    },
    filterUnsubscribed: true,
    filterBlocked: true,
    ...(externalId ? { externalId } : {})
  }

  if (cleanTransport === 'qr') {
    return sendImageViaQrFallback({
      phoneNumberId,
      fromPhone,
      toPhone,
      requestImage: {
        ...requestBody.image,
        ...(savedImage?.mimeType ? { mimeType: savedImage.mimeType } : {})
      },
      imageDataUrl,
      externalId,
      localMedia: savedImage,
      publicBaseUrl
    })
  }

  const fallbackDecision = await getOfficialApiFallbackDecision({
    config,
    fromPhone,
    phoneNumberId
  })
  if (fallbackDecision.shouldFallback) {
    return sendImageViaQrFallback({
      phoneNumberId: fallbackDecision.phoneRow?.id || phoneNumberId,
      fromPhone,
      toPhone,
      requestImage: requestBody.image,
      imageDataUrl,
      externalId,
      localMedia: savedImage,
      publicBaseUrl,
      fallbackReason: fallbackDecision.reason
    })
  }

  let response
  try {
    response = await ycloudRequest('/whatsapp/messages', {
      apiKey: config.apiKey,
      method: 'POST',
      body: requestBody
    })
  } catch (error) {
    const retryDecision = await getOfficialApiFallbackDecision({
      config,
      fromPhone,
      phoneNumberId,
      error
    })
    if (retryDecision.shouldFallback) {
      logger.warn(`[WhatsApp API] Envio de foto API fallo; usando QR para ${fromPhone}: ${retryDecision.reason}`)
      return sendImageViaQrFallback({
        phoneNumberId: retryDecision.phoneRow?.id || phoneNumberId,
        fromPhone,
        toPhone,
        requestImage: requestBody.image,
        imageDataUrl,
        externalId,
        localMedia: savedImage,
        publicBaseUrl,
        fallbackReason: retryDecision.reason,
        originalError: error
      })
    }
    throw error
  }

  await upsertMessage({
    payload: {
      id: response.id || externalId || hashId('waapi_img_event', `${fromPhone}|${toPhone}|${link}`),
      type: 'whatsapp.message.updated',
      createTime: nowIso(),
      whatsappMessage: response
    },
    message: {
      ...response,
      from: response.from || fromPhone,
      to: response.to || toPhone,
      type: response.type || 'image',
      image: response.image || requestBody.image,
      transport: 'api',
      createTime: response.createTime || nowIso()
    },
    direction: 'outbound',
    transport: 'api'
  })

  return {
    ...response,
    image: response.image || requestBody.image,
    localMedia: savedImage
  }
}

export async function sendWhatsAppApiDocumentMessage({
  to,
  from,
  documentDataUrl,
  documentUrl,
  filename,
  mimeType,
  caption,
  externalId,
  transport = 'api',
  publicBaseUrl,
  phoneNumberId
} = {}) {
  const config = await loadConfig({ includeSecrets: true })
  const cleanTransport = cleanString(transport).toLowerCase() === 'qr' ? 'qr' : 'api'
  if (cleanTransport !== 'qr' && (!config.enabled || !config.apiKey)) {
    throw new Error('WhatsApp_API no está conectado')
  }

  const fromPhone = normalizePhoneForStorage(from || config.senderPhone) || cleanString(from || config.senderPhone)
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const cleanCaption = cleanString(caption).slice(0, 1024)
  const cleanDocumentUrl = cleanString(documentUrl)

  if (!fromPhone) throw new Error('Falta el número emisor de WhatsApp_API')
  if (!toPhone) throw new Error('Falta el número destino')

  let link = cleanDocumentUrl
  let savedDocument = null

  if (!link) {
    savedDocument = await saveWhatsAppDocumentDataUrl(documentDataUrl, filename, mimeType)
    if (cleanTransport === 'qr') {
      link = buildLocalMediaUrl(savedDocument, publicBaseUrl)
    } else {
      const baseUrl = requirePublicHttpsBaseUrl(publicBaseUrl || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL, 'documentos')
      link = `${baseUrl}${savedDocument.publicPath}`
    }
  }

  if (cleanTransport !== 'qr' && !/^https:\/\//i.test(link)) {
    throw new Error('El documento necesita un enlace público HTTPS para poder enviarse por WhatsApp.')
  }

  const requestBody = {
    from: fromPhone,
    to: toPhone,
    type: 'document',
    document: {
      link,
      filename: savedDocument?.filename || sanitizeDocumentFilename(filename, savedDocument?.mimeType || cleanString(mimeType).toLowerCase()),
      ...(cleanCaption ? { caption: cleanCaption } : {})
    },
    filterUnsubscribed: true,
    filterBlocked: true,
    ...(externalId ? { externalId } : {})
  }

  if (cleanTransport === 'qr') {
    return sendDocumentViaQrFallback({
      phoneNumberId,
      fromPhone,
      toPhone,
      requestDocument: {
        ...requestBody.document,
        ...(savedDocument?.mimeType ? { mimeType: savedDocument.mimeType } : {})
      },
      documentDataUrl,
      externalId,
      localMedia: savedDocument,
      publicBaseUrl
    })
  }

  const fallbackDecision = await getOfficialApiFallbackDecision({
    config,
    fromPhone,
    phoneNumberId
  })
  if (fallbackDecision.shouldFallback) {
    return sendDocumentViaQrFallback({
      phoneNumberId: fallbackDecision.phoneRow?.id || phoneNumberId,
      fromPhone,
      toPhone,
      requestDocument: {
        ...requestBody.document,
        ...(savedDocument?.mimeType ? { mimeType: savedDocument.mimeType } : {})
      },
      documentDataUrl,
      externalId,
      localMedia: savedDocument,
      publicBaseUrl,
      fallbackReason: fallbackDecision.reason
    })
  }

  let response
  try {
    response = await ycloudRequest('/whatsapp/messages', {
      apiKey: config.apiKey,
      method: 'POST',
      body: requestBody
    })
  } catch (error) {
    const retryDecision = await getOfficialApiFallbackDecision({
      config,
      fromPhone,
      phoneNumberId,
      error
    })
    if (retryDecision.shouldFallback) {
      logger.warn(`[WhatsApp API] Envio de documento API fallo; usando QR para ${fromPhone}: ${retryDecision.reason}`)
      return sendDocumentViaQrFallback({
        phoneNumberId: retryDecision.phoneRow?.id || phoneNumberId,
        fromPhone,
        toPhone,
        requestDocument: {
          ...requestBody.document,
          ...(savedDocument?.mimeType ? { mimeType: savedDocument.mimeType } : {})
        },
        documentDataUrl,
        externalId,
        localMedia: savedDocument,
        publicBaseUrl,
        fallbackReason: retryDecision.reason,
        originalError: error
      })
    }
    throw error
  }

  await upsertMessage({
    payload: {
      id: response.id || externalId || hashId('waapi_doc_event', `${fromPhone}|${toPhone}|${link}`),
      type: 'whatsapp.message.updated',
      createTime: nowIso(),
      whatsappMessage: response
    },
    message: {
      ...response,
      from: response.from || fromPhone,
      to: response.to || toPhone,
      type: response.type || 'document',
      document: response.document || requestBody.document,
      transport: 'api',
      createTime: response.createTime || nowIso()
    },
    direction: 'outbound',
    transport: 'api'
  })

  return {
    ...response,
    document: response.document || {
      ...requestBody.document,
      ...(savedDocument?.mimeType ? { mimeType: savedDocument.mimeType } : {})
    },
    localMedia: savedDocument
  }
}

export async function sendWhatsAppApiAudioMessage({
  to,
  from,
  audioDataUrl,
  audioUrl,
  externalId,
  publicBaseUrl,
  durationMs,
  voice,
  transport = 'api',
  phoneNumberId
} = {}) {
  const config = await loadConfig({ includeSecrets: true })
  const cleanTransport = cleanString(transport).toLowerCase() === 'qr' ? 'qr' : 'api'
  if (cleanTransport !== 'qr' && (!config.enabled || !config.apiKey)) {
    throw new Error('WhatsApp_API no está conectado')
  }

  const fromPhone = normalizePhoneForStorage(from || config.senderPhone) || cleanString(from || config.senderPhone)
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const cleanAudioUrl = cleanString(audioUrl)
  const isVoiceNote = voice === undefined ? Boolean(audioDataUrl) : Boolean(voice)

  if (!fromPhone) throw new Error('Falta el número emisor de WhatsApp_API')
  if (!toPhone) throw new Error('Falta el número destino')

  let link = cleanAudioUrl
  let savedAudio = null

  if (!link) {
    savedAudio = await saveWhatsAppAudioDataUrl(audioDataUrl)
    if (cleanTransport === 'qr') {
      link = buildLocalMediaUrl(savedAudio, publicBaseUrl)
    } else {
      const baseUrl = requirePublicHttpsBaseUrl(publicBaseUrl || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL, 'audios')
      link = `${baseUrl}${savedAudio.publicPath}`
    }
  }

  if (cleanTransport !== 'qr' && !/^https:\/\//i.test(link)) {
    throw new Error('El audio necesita un enlace público HTTPS para poder enviarse por WhatsApp.')
  }

  const requestBody = {
    from: fromPhone,
    to: toPhone,
    type: 'audio',
    audio: {
      link,
      ...(isVoiceNote ? { voice: true } : {})
    },
    filterUnsubscribed: true,
    filterBlocked: true,
    ...(externalId ? { externalId } : {})
  }

  if (cleanTransport === 'qr') {
    return sendAudioViaQrFallback({
      phoneNumberId,
      fromPhone,
      toPhone,
      requestAudio: {
        ...requestBody.audio,
        ...(savedAudio?.mimeType ? { mimeType: savedAudio.mimeType } : {}),
        ...(isVoiceNote ? { voice: true } : {})
      },
      audioDataUrl,
      externalId,
      localMedia: savedAudio,
      publicBaseUrl,
      durationMs
    })
  }

  const fallbackDecision = await getOfficialApiFallbackDecision({
    config,
    fromPhone,
    phoneNumberId
  })
  if (fallbackDecision.shouldFallback) {
    return sendAudioViaQrFallback({
      phoneNumberId: fallbackDecision.phoneRow?.id || phoneNumberId,
      fromPhone,
      toPhone,
      requestAudio: {
        ...requestBody.audio,
        ...(savedAudio?.mimeType ? { mimeType: savedAudio.mimeType } : {})
      },
      audioDataUrl,
      externalId,
      localMedia: savedAudio,
      publicBaseUrl,
      durationMs,
      fallbackReason: fallbackDecision.reason
    })
  }

  let response
  try {
    response = await ycloudRequest('/whatsapp/messages', {
      apiKey: config.apiKey,
      method: 'POST',
      body: requestBody
    })
  } catch (error) {
    const retryDecision = await getOfficialApiFallbackDecision({
      config,
      fromPhone,
      phoneNumberId,
      error
    })
    if (retryDecision.shouldFallback) {
      logger.warn(`[WhatsApp API] Envio de audio API fallo; usando QR para ${fromPhone}: ${retryDecision.reason}`)
      return sendAudioViaQrFallback({
        phoneNumberId: retryDecision.phoneRow?.id || phoneNumberId,
        fromPhone,
        toPhone,
        requestAudio: {
          ...requestBody.audio,
          ...(savedAudio?.mimeType ? { mimeType: savedAudio.mimeType } : {}),
          ...(isVoiceNote ? { voice: true } : {})
        },
        audioDataUrl,
        externalId,
        localMedia: savedAudio,
        publicBaseUrl,
        durationMs,
        fallbackReason: retryDecision.reason,
        originalError: error
      })
    }
    throw error
  }

  await upsertMessage({
    payload: {
      id: response.id || externalId || hashId('waapi_audio_event', `${fromPhone}|${toPhone}|${link}`),
      type: 'whatsapp.message.updated',
      createTime: nowIso(),
      whatsappMessage: response
    },
    message: {
      ...response,
      from: response.from || fromPhone,
      to: response.to || toPhone,
      type: response.type || 'audio',
      audio: {
        ...requestBody.audio,
        ...(response.audio || {}),
        ...(durationMs ? { durationMs } : {})
      },
      transport: 'api',
      createTime: response.createTime || nowIso()
    },
    direction: 'outbound',
    transport: 'api'
  })

  return {
    ...response,
    audio: {
      ...requestBody.audio,
      ...(response.audio || {}),
      ...(durationMs ? { durationMs } : {})
    },
    localMedia: savedAudio
  }
}

export function getWhatsAppApiWebhookPath() {
  return '/webhook/whatsapp-api/ycloud'
}

export function getWhatsAppApiConfigKeys() {
  return { ...CONFIG_KEYS }
}

export function getWhatsAppApiRequiredWebhookEvents() {
  return [...REQUIRED_WEBHOOK_EVENTS]
}
