import crypto from 'crypto'
import { spawn } from 'child_process'
import fs from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import nodeFetch from 'node-fetch'
import sharp from 'sharp'
import { db, getAppConfig, repairWhatsAppApiContactIdentityFromMessages, setAppConfig } from '../config/database.js'
import { findContactByPhoneCandidates, generateContactId, recordContactPhoneNumber } from './contactIdentityService.js'
import { sendChatMessageNotification } from './pushNotificationsService.js'
import { maybeConfirmAppointmentFromReply, handleInboundForConfirmation } from './appointmentConfirmationService.js'
import {
  QR_CONSENT_TEXT,
  disconnectWhatsAppQrConnection,
  getWhatsAppQrSession,
  getWhatsAppQrSessions,
  rememberRistakQrOutboundAttempt,
  sendWhatsAppQrAudioMessage,
  sendWhatsAppQrDocumentMessage,
  sendWhatsAppQrImageMessage,
  sendWhatsAppQrLocationMessage,
  sendWhatsAppQrReactionMessage,
  sendWhatsAppQrVideoMessage,
  sendWhatsAppQrTextMessage,
  startWhatsAppQrConnection,
  warmWhatsAppQrProfilePictures
} from './whatsappQrService.js'
import { getWhatsAppQrDripSettings } from './whatsappQrDripService.js'
import { decrypt, encrypt } from '../utils/encryption.js'
import { buildPhoneMatchCandidates, normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { detectWhatsAppAttributionFields } from '../utils/whatsappAttribution.js'
import { logger } from '../utils/logger.js'
import { normalizeYCloudApiKeyInput } from '../utils/ycloudApiKey.js'
import {
  GENERIC_WHATSAPP_API_CONTACT_NAME,
  extractWhatsAppProfileName,
  normalizeWhatsAppProfileName,
  shouldReplaceWhatsAppApiContactName
} from '../utils/whatsappContactProfile.js'
import { getMetaConfig } from './metaAdsService.js'
import { getVerifiedAppBaseUrl } from './sitesService.js'
import { renderTemplateVariables } from './templateVariablesService.js'
import { publishChatMessageEvent } from './chatLiveEventsService.js'
import { claimInboundChatMessage } from './chatReadStateService.js'
import { captureContactIdentityFromMessage } from './contactMessageIdentityCaptureService.js'
import {
  clearWhatsAppApiIntegrationCredentials,
  clearWhatsAppMetaDirectIntegrationCredentials
} from './integrationCredentialsCleanupService.js'
import {
  DEFAULT_TIMEZONE,
  businessTodayDateOnly,
  getAccountTimezone,
  normalizeDateOnlyInTimezone
} from '../utils/dateUtils.js'
import {
  buildConversationalAgentMessageMetadata,
  extractConversationalAgentMessageMetadata,
  formatConversationalAgentMessageMetadata
} from '../utils/conversationalAgentMessageMetadata.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const YCLOUD_API_BASE_URL = String(process.env.YCLOUD_API_BASE_URL || 'https://api.ycloud.com/v2').replace(/\/+$/, '')
const YCLOUD_REQUEST_TIMEOUT_MS = 20_000
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v22.0'
const META_GRAPH_BASE_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}`
const SOURCE_NAME = 'WhatsApp_API'
const PROVIDER_NAME = 'ycloud'
const META_DIRECT_PROVIDER_NAME = 'meta_direct'
const DEFAULT_INSTALLER_PUBLIC_URL = 'https://www.ristak.com'
const WEBHOOK_DESCRIPTION = 'Ristak WhatsApp API'
const GENERIC_CONTACT_NAME = GENERIC_WHATSAPP_API_CONTACT_NAME
const WHATSAPP_IMAGE_UPLOAD_ROOT = join(__dirname, '../../uploads/whatsapp-images')
let ycloudFetch = nodeFetch
let metaDirectFetch = nodeFetch

export function setYCloudFetchForTest(fetchImpl) {
  ycloudFetch = typeof fetchImpl === 'function' ? fetchImpl : nodeFetch
}

export function setMetaDirectFetchForTest(fetchImpl) {
  metaDirectFetch = typeof fetchImpl === 'function' ? fetchImpl : nodeFetch
}
const WHATSAPP_IMAGE_PUBLIC_PATH = '/uploads/whatsapp-images'
const MAX_WHATSAPP_IMAGE_INPUT_BYTES = 25 * 1024 * 1024
const MAX_WHATSAPP_IMAGE_OUTPUT_BYTES = 5 * 1024 * 1024
const WHATSAPP_AUDIO_UPLOAD_ROOT = join(__dirname, '../../uploads/whatsapp-audio')
const WHATSAPP_AUDIO_PUBLIC_PATH = '/uploads/whatsapp-audio'
const MAX_WHATSAPP_AUDIO_BYTES = 16 * 1024 * 1024
const WHATSAPP_DOCUMENT_UPLOAD_ROOT = join(__dirname, '../../uploads/whatsapp-documents')
const WHATSAPP_DOCUMENT_PUBLIC_PATH = '/uploads/whatsapp-documents'
const MAX_WHATSAPP_DOCUMENT_BYTES = 20 * 1024 * 1024
const WHATSAPP_VIDEO_UPLOAD_ROOT = join(__dirname, '../../uploads/whatsapp-videos')
const WHATSAPP_VIDEO_PUBLIC_PATH = '/uploads/whatsapp-videos'
const MAX_WHATSAPP_VIDEO_INPUT_BYTES = 25 * 1024 * 1024
const MAX_WHATSAPP_VIDEO_OUTPUT_BYTES = 16 * 1024 * 1024
const FFMPEG_MAX_CONCURRENCY = Math.min(
  4,
  Math.max(1, Number(process.env.WHATSAPP_FFMPEG_MAX_CONCURRENCY || 2) || 2)
)
const FFMPEG_MAX_QUEUE = Math.min(
  20,
  Math.max(1, Number(process.env.WHATSAPP_FFMPEG_MAX_QUEUE || 6) || 6)
)
const FFMPEG_QUEUE_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.WHATSAPP_FFMPEG_QUEUE_TIMEOUT_MS || 15_000) || 15_000
)
const FFMPEG_PROCESS_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.WHATSAPP_FFMPEG_PROCESS_TIMEOUT_MS || 60_000) || 60_000
)
const WHATSAPP_VIDEO_TRANSCODE_BUDGET_MS = Math.max(
  15_000,
  Number(process.env.WHATSAPP_VIDEO_TRANSCODE_BUDGET_MS || 90_000) || 90_000
)
const FFMPEG_STDERR_LIMIT = 16 * 1024
const WHATSAPP_VIDEO_MIME_TYPE = 'video/mp4'
const WHATSAPP_VOICE_NOTE_MIME_TYPE = 'audio/ogg; codecs=opus'
const CHAT_AUDIO_PLAYBACK_MIME_TYPE = 'audio/mp4'
const CHAT_AUDIO_PLAYBACK_EXTENSION = 'm4a'
const WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000
const WHATSAPP_REPLY_WINDOW_CLOSED_REASON = 'La conversación lleva más de 24 horas sin respuesta del cliente; WhatsApp API solo permite plantillas.'
const WHATSAPP_REPLY_WINDOW_UNKNOWN_REASON = 'No hay una respuesta reciente del cliente registrada; WhatsApp API solo permite mensajes libres dentro de la ventana de 24 horas.'
const WHATSAPP_API_PROFILE_PICTURE_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const WHATSAPP_API_PROFILE_PICTURE_BATCH_LIMIT = 40
const WHATSAPP_PROFILE_PICTURE_BACKFILL_DEFAULT_LIMIT = 1000
const WHATSAPP_PROFILE_PICTURE_BACKFILL_MAX_LIMIT = 5000
const WHATSAPP_PROFILE_PICTURE_BACKFILL_QR_BATCH_LIMIT = 8
const WHATSAPP_INTERACTIVE_REPLY_BUTTON_LIMIT = 3
const WHATSAPP_INTERACTIVE_REPLY_BUTTON_TITLE_MAX = 20
const WHATSAPP_INTERACTIVE_REPLY_BUTTON_ID_MAX = 256
let activeFfmpegProcesses = 0
const ffmpegWaitQueue = []

async function getBusinessDayKey() {
  const timezone = await getAccountTimezone().catch(() => DEFAULT_TIMEZONE)
  return businessTodayDateOnly(timezone)
}
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
  'audio/x-wav': 'wav',
  // Safari can wrap microphone-only recordings in an MP4 container and label
  // them as video/mp4. This endpoint only accepts audio payloads, so we treat
  // that input as something that must be transcoded before WhatsApp sees it.
  'video/mp4': 'mp4'
}
const VIDEO_EXTENSION_BY_MIME = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'video/3gp': '3gp'
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
const QR_FALLBACK_READY_STATUSES = new Set(['connected', 'reconnecting', 'restarting', 'connection_replaced'])
const API_FALLBACK_ERROR_PATTERN = /\b(WABA|BUSINESS ACCOUNT|PHONE NUMBER|SENDER|FROM|ACCOUNT|QUALITY|MESSAGING LIMIT|RATE.?LIMIT|RESTRICT|BANNED|BLOCKED|DISABLED|SUSPENDED|LOCKED|NOT ALLOWED|NOT_ALLOWED|CUSTOMER SERVICE WINDOW|24.?HOUR|24 HORAS|OUTSIDE.*WINDOW)\b/i
const API_FALLBACK_RECIPIENT_ERROR_PATTERN = /\b(RECIPIENT|CUSTOMER|USER|DESTINATION|TO PHONE|UNSUBSCRIBED|OPTED.?OUT|BLOCKED BY USER|USER BLOCKED)\b/i

const REQUIRED_WEBHOOK_EVENTS = [
  'whatsapp.inbound_message.received',
  'whatsapp.message.updated',
  'whatsapp.smb.history',
  'whatsapp.smb.message.echoes',
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
  'whatsapp.smb.message.echoes'
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
    title: 'Número de WhatsApp baneado',
    message: 'WhatsApp marcó este número como baneado. No se puede usar para enviar mensajes hasta resolverlo en Meta o WhatsApp API.'
  },
  BLOCKED: {
    severity: 'critical',
    title: 'Límite de WhatsApp alcanzado',
    message: 'El número alcanzó el límite de mensajes del periodo de 24 horas. Las plantillas pueden fallar hasta que se reinicie el límite.'
  },
  RESTRICTED: {
    severity: 'critical',
    title: 'Número restringido',
    message: 'El número alcanzó su límite de conversaciones iniciadas por negocio y no puede mandar más mensajes por ahora.'
  },
  RATE_LIMITED: {
    severity: 'critical',
    title: 'WhatsApp aplicó rate limit',
    message: 'WhatsApp limitó el volumen de envío del número. Baja el ritmo de plantillas y revisa calidad/saldo antes de reintentar.'
  },
  DISCONNECTED: {
    severity: 'critical',
    title: 'Número desconectado',
    message: 'El número no está alcanzable por los servidores de WhatsApp. Revisa el estado en Meta o WhatsApp API antes de enviar.'
  },
  MIGRATED: {
    severity: 'critical',
    title: 'Número migrado',
    message: 'Este número fue transferido a otra cuenta de WhatsApp Business. La configuración de WhatsApp_API debe revisarse.'
  },
  FLAGGED: {
    severity: 'warning',
    title: 'Número marcado por baja calidad',
    message: 'WhatsApp marcó el número por baja calidad. Si no mejora, puede bajar el límite o bloquear envíos.'
  },
  WARNED: {
    severity: 'warning',
    title: 'Advertencia en WhatsApp',
    message: 'WhatsApp emitió una advertencia para este número, probablemente por reportes o calidad de mensajes.'
  },
  UNVERIFIED: {
    severity: 'warning',
    title: 'Número sin verificar',
    message: 'El número todavía no está verificado. Termina la verificación para poder enviar bien.'
  },
  MANUAL_REVIEW: {
    severity: 'warning',
    title: 'Número en revisión manual',
    message: 'Meta o WhatsApp API está revisando el número. El envío puede quedar limitado hasta que aprueben la revisión.'
  },
  PENDING: {
    severity: 'info',
    title: 'Número pendiente',
    message: 'El número está pendiente de verificación o registro en WhatsApp Business.'
  },
  UNKNOWN: {
    severity: 'warning',
    title: 'Estado de número desconocido',
    message: 'WhatsApp API no pudo determinar el estado del número. Conviene sincronizar y revisar antes de enviar campañas.'
  }
}

const TEMPLATE_STATUS_ALERTS = {
  REJECTED: {
    severity: 'critical',
    title: 'Plantilla rechazada',
    message: 'Meta rechazó esta plantilla. No se puede enviar hasta corregirla y aprobarla.'
  },
  PAUSED: {
    severity: 'critical',
    title: 'Plantilla pausada',
    message: 'Meta pausó esta plantilla por retroalimentación negativa. No se puede enviar mientras siga pausada.'
  },
  DISABLED: {
    severity: 'critical',
    title: 'Plantilla deshabilitada',
    message: 'Meta deshabilitó esta plantilla. Revisa el motivo y apela o crea una versión corregida.'
  },
  ARCHIVED: {
    severity: 'critical',
    title: 'Plantilla archivada',
    message: 'La plantilla está archivada. WhatsApp API indica que las plantillas archivadas no se pueden enviar.'
  },
  DELETED: {
    severity: 'critical',
    title: 'Plantilla eliminada',
    message: 'La plantilla fue eliminada y ya no está disponible para envío.'
  },
  IN_APPEAL: {
    severity: 'warning',
    title: 'Plantilla en apelacion',
    message: 'La plantilla está en apelación. Evita depender de ella hasta que Meta confirme el resultado.'
  },
  PENDING: {
    severity: 'info',
    title: 'Plantilla pendiente',
    message: 'La plantilla sigue en revisión. No se puede usar para enviar hasta que esté APPROVED.'
  }
}

const CONFIG_KEYS = {
  enabled: 'whatsapp_api_enabled',
  apiKey: 'whatsapp_api_ycloud_api_key_encrypted',
  senderPhone: 'whatsapp_api_sender_phone',
  phoneNumberId: 'whatsapp_api_phone_number_id',
  wabaId: 'whatsapp_api_waba_id',
  provider: 'whatsapp_api_provider',
  metaStatus: 'whatsapp_meta_direct_status',
  metaAppId: 'whatsapp_meta_direct_app_id',
  metaBusinessId: 'whatsapp_meta_direct_business_id',
  metaWabaId: 'whatsapp_meta_direct_waba_id',
  metaPhoneNumberId: 'whatsapp_meta_direct_phone_number_id',
  metaDisplayPhoneNumber: 'whatsapp_meta_direct_display_phone_number',
  metaCoexistenceEnabled: 'whatsapp_meta_direct_coexistence_enabled',
  metaSystemUserToken: 'whatsapp_meta_direct_system_user_token_encrypted',
  metaWebhookMode: 'whatsapp_meta_direct_webhook_mode',
  metaInstallerWebhookUrl: 'whatsapp_meta_direct_installer_webhook_url',
  metaInstallerOAuthCallbackUrl: 'whatsapp_meta_direct_installer_oauth_callback_url',
  metaConnectedAt: 'whatsapp_meta_direct_connected_at',
  metaDisconnectedAt: 'whatsapp_meta_direct_disconnected_at',
  metaLastWebhookReceivedAt: 'whatsapp_meta_direct_last_webhook_received_at',
  metaLastRelayReceivedAt: 'whatsapp_meta_direct_last_relay_received_at',
  metaLastError: 'whatsapp_meta_direct_last_error',
  metaDatasetId: 'whatsapp_meta_direct_dataset_id',
  metaAdAccountId: 'whatsapp_meta_direct_ad_account_id',
  webhookEndpointId: 'whatsapp_api_webhook_endpoint_id',
  webhookSecret: 'whatsapp_api_webhook_secret_encrypted',
  webhookUrl: 'whatsapp_api_webhook_url',
  webhookStatus: 'whatsapp_api_webhook_status',
  connectedAt: 'whatsapp_api_connected_at',
  disconnectedAt: 'whatsapp_api_disconnected_at',
  lastSyncedAt: 'whatsapp_api_last_synced_at',
  lastError: 'whatsapp_api_last_error'
}

const HISTORY_DIRECTION_REPAIR_CONFIG_KEY = 'whatsapp_api_history_direction_repair_version'
const YCLOUD_HISTORY_BACKFILL_STATE_CONFIG_KEY = 'whatsapp_api_ycloud_history_backfill_state'
export const YCLOUD_HISTORY_BACKFILL_VERSION = '2026-07-11-ycloud-smb-echoes-backfill'
const HISTORY_DIRECTION_REPAIR_VERSION = YCLOUD_HISTORY_BACKFILL_VERSION

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
    case 'read':
    case 'played':
      return 90
    case 'delivered':
      return 80
    // (WA-007) 'failed'/'error'/'undelivered'/'rejected' ya NO son terminales por
    // encima de delivered/read. Si después llega un acuse real de entrega/lectura
    // (prueba de que el mensaje SÍ llegó), debe ganar sobre un 'failed' previo o
    // fuera de orden. Mantienen prioridad sobre 'sent'/'accepted'/'pending' para
    // que un fallo siga sobreescribiendo un simple 'enviado'.
    case 'failed':
    case 'error':
    case 'undelivered':
    case 'rejected':
      return 75
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

function cleanMimeType(value = '') {
  return cleanString(value).split(';')[0].toLowerCase()
}

/**
 * YCloud/Meta necesita conservar el codec en el multipart de una nota de voz.
 * Quitar el parámetro y dejar solo `audio/ogg` vuelve ambiguo el archivo: OGG
 * también puede contener codecs que WhatsApp no acepta. Para cualquier otro
 * medio seguimos usando el MIME base, que es el contrato normal de subida.
 */
function normalizeYCloudUploadMimeType(value = '') {
  const original = cleanString(value).toLowerCase()
  if (
    cleanMimeType(original) === 'audio/ogg' &&
    /(?:^|;)\s*codecs\s*=\s*opus\s*(?:;|$)/.test(original)
  ) {
    return WHATSAPP_VOICE_NOTE_MIME_TYPE
  }
  return cleanMimeType(original)
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
  if (/^https?:\/\//i.test(publicPath)) return publicPath

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

export function requirePublicMediaUrl(localMedia, publicBaseUrl = '', mediaLabel = 'archivos') {
  const publicPath = cleanString(localMedia?.publicPath)
  if (/^https:\/\//i.test(publicPath)) return publicPath

  // (WA-006) Un asset que cayó al fallback de disco local solo sirve para QR
  // (ruta relativa sin HTTPS). El envío por API necesita una URL pública que
  // WhatsApp pueda abrir, así que se bloquea aquí con un mensaje accionable en
  // vez de dejar que falle más adelante con un error genérico.
  if (localMedia?.qrOnly === true || localMedia?.localFallback === true) {
    throw new Error(`Para enviar ${mediaLabel} por WhatsApp por la API oficial, Ristak necesita almacenamiento multimedia público (HTTPS). El archivo se guardó solo en disco local y únicamente puede enviarse por QR.`)
  }

  const baseUrl = requirePublicHttpsBaseUrl(publicBaseUrl || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL, mediaLabel)
  const mediaUrl = buildLocalMediaUrl(localMedia, baseUrl)
  if (!/^https:\/\//i.test(mediaUrl)) {
    throw new Error(`Para enviar ${mediaLabel} por WhatsApp, Ristak necesita un enlace público HTTPS que WhatsApp pueda abrir.`)
  }
  return mediaUrl
}

function allowsLegacyWhatsAppLocalMediaFallback() {
  return /^(1|true|yes|si|on)$/i.test(cleanString(process.env.WHATSAPP_LOCAL_MEDIA_FALLBACK))
}

function handleWhatsAppMediaStorageError(mediaLabel, error) {
  if (allowsLegacyWhatsAppLocalMediaFallback()) {
    logger.warn(`[WhatsApp API] No se pudo guardar ${mediaLabel} en mediaStorageService: ${error.message}; usando fallback local de emergencia.`)
    return
  }

  logger.error(`[WhatsApp API] No se pudo guardar ${mediaLabel} en almacenamiento multimedia centralizado: ${error.message}`)
  throw error
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

  if (buffer.length > MAX_WHATSAPP_IMAGE_INPUT_BYTES) {
    throw new Error('La foto pesa demasiado. Toma otra foto más ligera o recórtala antes de enviarla.')
  }

  return { buffer, mimeType, extension }
}

async function prepareWhatsAppApiImageBuffer({ buffer, mimeType }) {
  try {
    const output = await sharp(buffer, { limitInputPixels: 64_000_000 })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer()

    if (!output.length) {
      throw new Error('La conversión dejó la foto vacía.')
    }
    if (output.length > MAX_WHATSAPP_IMAGE_OUTPUT_BYTES) {
      throw new Error('La foto sigue pesando demasiado para WhatsApp después de comprimirla.')
    }

    return {
      buffer: output,
      mimeType: 'image/jpeg',
      extension: 'jpg',
      compression: 'whatsapp_jpeg'
    }
  } catch (error) {
    const fallbackMimeType = cleanMimeType(mimeType)
    if (fallbackMimeType === 'image/jpeg' || fallbackMimeType === 'image/png') {
      if (buffer.length > MAX_WHATSAPP_IMAGE_OUTPUT_BYTES) {
        throw new Error('La foto pesa demasiado para WhatsApp. Recórtala o toma una versión más ligera.')
      }
      logger.warn(`[WhatsApp API] No se pudo optimizar foto a JPEG: ${error.message}; usando ${fallbackMimeType}.`)
      return {
        buffer,
        mimeType: fallbackMimeType,
        extension: IMAGE_EXTENSION_BY_MIME[fallbackMimeType] || 'jpg',
        compression: 'original_compatible'
      }
    }

    throw new Error('La foto salió en un formato que WhatsApp no acepta y no se pudo convertir a JPEG. Intenta tomarla otra vez.')
  }
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

function getDocumentSendExtension(mimeType = '') {
  const cleanMime = cleanMimeType(mimeType)
  return DOCUMENT_EXTENSION_BY_MIME[cleanMime] || VIDEO_EXTENSION_BY_MIME[cleanMime] || AUDIO_EXTENSION_BY_MIME[cleanMime] || 'bin'
}

function sanitizeDocumentFilename(value = '', mimeType = '') {
  const extension = getDocumentSendExtension(mimeType)
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
  const mimeType = DOCUMENT_EXTENSION_BY_MIME[directMimeType] || VIDEO_EXTENSION_BY_MIME[directMimeType] || AUDIO_EXTENSION_BY_MIME[directMimeType]
    ? directMimeType
    : DOCUMENT_EXTENSION_BY_MIME[dataUrlMimeType] || VIDEO_EXTENSION_BY_MIME[dataUrlMimeType] || AUDIO_EXTENSION_BY_MIME[dataUrlMimeType]
      ? dataUrlMimeType
      : DOCUMENT_MIME_BY_EXTENSION[extension] || VIDEO_MIME_BY_EXTENSION[extension] || AUDIO_MIME_BY_EXTENSION[extension]

  if (!mimeType) {
    throw new Error('El archivo debe ser PDF, Word, Excel, PowerPoint, TXT, CSV, audio o video compatible.')
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
    extension: getDocumentSendExtension(mimeType),
    filename: sanitizeDocumentFilename(filename, mimeType)
  }
}

function parseVideoDataUrl(value = '') {
  const match = cleanString(value).match(/^data:([^;,]+)(?:;[^,]*)?;base64,([a-z0-9+/=\s]+)$/i)
  if (!match) {
    throw new Error('El video no llegó en un formato válido.')
  }

  const mimeType = cleanMimeType(match[1])
  const extension = VIDEO_EXTENSION_BY_MIME[mimeType]
  if (!extension) {
    throw new Error('El video debe ser MP4, MOV, WebM o 3GP para poder prepararlo para WhatsApp.')
  }

  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64')
  if (!buffer.length) {
    throw new Error('El video está vacío.')
  }

  if (buffer.length > MAX_WHATSAPP_VIDEO_INPUT_BYTES) {
    throw new Error('El video pesa demasiado. Graba uno más corto para poder comprimirlo y enviarlo por WhatsApp.')
  }

  return { buffer, mimeType, extension }
}

function audioNeedsWhatsAppConversion({ mimeType, params }) {
  return !(mimeType === 'audio/ogg' && String(params || '').includes('opus'))
}

function audioNeedsChatPlaybackConversion({ mimeType } = {}) {
  const cleanMimeType = cleanMimeTypeValue(mimeType)
  return ![
    'audio/aac',
    'audio/mp4',
    'audio/mpeg',
    'audio/wav',
    'audio/x-wav'
  ].includes(cleanMimeType)
}

function cleanMimeTypeValue(value = '') {
  return cleanString(value).toLowerCase().split(';')[0].trim()
}

function normalizeVoiceNoteMimeType({ mimeType, params } = {}) {
  const cleanMimeType = cleanString(mimeType).toLowerCase()
  if (cleanMimeType === 'audio/ogg' && String(params || '').toLowerCase().includes('opus')) {
    return WHATSAPP_VOICE_NOTE_MIME_TYPE
  }
  return cleanMimeType
}

function ffmpegError(message, status = 503, code = 'ffmpeg_unavailable') {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

function releaseFfmpegSlot() {
  activeFfmpegProcesses = Math.max(0, activeFfmpegProcesses - 1)
  while (ffmpegWaitQueue.length) {
    const waiter = ffmpegWaitQueue.shift()
    if (!waiter || waiter.cancelled) continue
    clearTimeout(waiter.timer)
    activeFfmpegProcesses += 1
    waiter.resolve(releaseFfmpegSlot)
    return
  }
}

function acquireFfmpegSlot() {
  if (activeFfmpegProcesses < FFMPEG_MAX_CONCURRENCY) {
    activeFfmpegProcesses += 1
    return Promise.resolve(releaseFfmpegSlot)
  }
  if (ffmpegWaitQueue.length >= FFMPEG_MAX_QUEUE) {
    return Promise.reject(ffmpegError(
      'El servidor está preparando demasiados archivos al mismo tiempo. Espera unos segundos e intenta otra vez.',
      503,
      'ffmpeg_queue_full'
    ))
  }

  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, cancelled: false, timer: null }
    waiter.timer = setTimeout(() => {
      waiter.cancelled = true
      reject(ffmpegError(
        'El servidor sigue ocupado preparando otros archivos. Intenta otra vez en unos segundos.',
        503,
        'ffmpeg_queue_timeout'
      ))
    }, FFMPEG_QUEUE_TIMEOUT_MS)
    ffmpegWaitQueue.push(waiter)
  })
}

async function runFfmpeg(args = [], options = {}) {
  const release = await acquireFfmpegSlot()
  try {
    const deadlineRemaining = Number(options.deadlineMs) - Date.now()
    const requestedTimeout = Number(options.timeoutMs || FFMPEG_PROCESS_TIMEOUT_MS)
    const timeoutMs = Number.isFinite(deadlineRemaining)
      ? Math.min(requestedTimeout, deadlineRemaining)
      : requestedTimeout
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
      throw ffmpegError(
        cleanString(options.timeoutMessage) || 'El archivo tardó demasiado en prepararse. Elige uno más corto.',
        422,
        'ffmpeg_timeout'
      )
    }

    return await new Promise((resolve, reject) => {
      const binary = process.env.FFMPEG_PATH || 'ffmpeg'
      const child = spawn(binary, ['-nostdin', ...args], {
        stdio: ['ignore', 'ignore', 'pipe']
      })
      let stderr = ''
      let settled = false
      let timedOut = false
      let timeout = null
      const unavailableMessage = cleanString(options.unavailableMessage) ||
        'El audio salió en un formato que WhatsApp no acepta y este servidor no pudo adaptarlo. Intenta grabarlo otra vez.'
      const failureMessage = cleanString(options.failureMessage) ||
        'No se pudo preparar el audio para WhatsApp. Intenta grabarlo otra vez.'

      const finish = (error = null) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error) reject(error)
        else resolve()
      }

      timeout = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)

      child.stderr.on('data', chunk => {
        if (stderr.length < FFMPEG_STDERR_LIMIT) {
          stderr += chunk.toString().slice(0, FFMPEG_STDERR_LIMIT - stderr.length)
        }
      })

      child.on('error', () => {
        finish(ffmpegError(unavailableMessage, 503, 'ffmpeg_unavailable'))
      })

      child.on('close', code => {
        if (timedOut) {
          finish(ffmpegError(
            cleanString(options.timeoutMessage) || 'El archivo tardó demasiado en prepararse. Elige uno más corto.',
            422,
            'ffmpeg_timeout'
          ))
          return
        }
        if (code === 0) {
          finish()
          return
        }

        const detail = stderr.trim().slice(0, 240)
        finish(ffmpegError(detail || failureMessage, 422, 'ffmpeg_conversion_failed'))
      })
    })
  } finally {
    release()
  }
}

async function convertVideoToWhatsAppMp4({ buffer, extension }) {
  const folder = await fs.mkdtemp(join(tmpdir(), 'ristak-whatsapp-video-'))
  const inputPath = join(folder, `input.${extension || 'video'}`)
  const attempts = [
    { maxDimension: 1280, crf: 28, audioBitrate: '96k', label: '1280_crf28' },
    { maxDimension: 960, crf: 32, audioBitrate: '80k', label: '960_crf32' },
    { maxDimension: 720, crf: 35, audioBitrate: '64k', label: '720_crf35' },
    { maxDimension: 480, crf: 38, audioBitrate: '48k', label: '480_crf38' }
  ]
  const deadlineMs = Date.now() + WHATSAPP_VIDEO_TRANSCODE_BUDGET_MS

  try {
    await fs.writeFile(inputPath, buffer)

    for (const attempt of attempts) {
      const outputPath = join(folder, `video-${attempt.label}.mp4`)
      await runFfmpeg([
        '-y',
        '-i',
        inputPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-vf',
        `scale=w=${attempt.maxDimension}:h=${attempt.maxDimension}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-profile:v',
        'baseline',
        '-level',
        '3.1',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        String(attempt.crf),
        '-c:a',
        'aac',
        '-ac',
        '2',
        '-ar',
        '44100',
        '-b:a',
        attempt.audioBitrate,
        '-movflags',
        '+faststart',
        outputPath
      ], {
        unavailableMessage: 'El video salió en un formato que WhatsApp no acepta y este servidor no pudo adaptarlo. Intenta grabarlo otra vez.',
        failureMessage: 'No se pudo preparar el video para WhatsApp. Intenta grabarlo otra vez.',
        timeoutMessage: 'El video tardó demasiado en prepararse. Graba uno más corto o envíalo como documento.',
        deadlineMs
      })

      const converted = await fs.readFile(outputPath)
      if (!converted.length) {
        throw new Error('El video convertido quedó vacío. Intenta grabarlo otra vez.')
      }
      if (converted.length <= MAX_WHATSAPP_VIDEO_OUTPUT_BYTES) {
        return {
          buffer: converted,
          compression: `whatsapp_mp4_h264_aac_${attempt.label}`
        }
      }
    }

    throw new Error('El video sigue pesando más de 16 MB después de comprimirlo. Graba uno más corto para enviarlo por WhatsApp.')
  } finally {
    await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function prepareWhatsAppVideo(parsed) {
  const converted = await convertVideoToWhatsAppMp4(parsed)
  return {
    buffer: converted.buffer,
    mimeType: WHATSAPP_VIDEO_MIME_TYPE,
    extension: 'mp4',
    compression: converted.compression
  }
}

// Un contenedor OGG SIEMPRE empieza con la firma "OggS" (capture pattern de la
// primera página). Es el chequeo barato y confiable de que unos bytes son un OGG
// real (y no un m4a/AAC disfrazado), evitando subir al proveedor algo que
// rechazaría como application/octet-stream.
function isOggBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 4 &&
    buffer.subarray(0, 4).toString('latin1') === 'OggS'
}

function isOggOpusBuffer(buffer) {
  return isOggBuffer(buffer) && buffer.includes(Buffer.from('OpusHead', 'ascii'))
}

function assertOggOpusBuffer(buffer) {
  if (!isOggOpusBuffer(buffer)) {
    throw new Error('El audio no quedó en formato de nota de voz de WhatsApp (OGG/Opus). Intenta grabarlo otra vez.')
  }
}

// Exportada para reutilizarla en el canal QR (Baileys también exige OGG/Opus para
// notas de voz PTT); una sola tubería de conversión para ambos transportes.
export async function convertAudioToOggOpus({ buffer, extension }) {
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
      '32k',
      // `voip` es el modo Opus que WhatsApp usa para notas de voz (PTT); optimiza
      // voz y produce el OGG/Opus que Meta/YCloud/Baileys aceptan de verdad.
      '-application',
      'voip',
      outputPath
    ])

    const converted = await fs.readFile(outputPath)
    if (!converted.length) {
      throw new Error('El audio convertido quedó vacío. Intenta grabarlo otra vez.')
    }
    // Garantiza que ffmpeg REALMENTE produjo un OGG antes de subirlo: si por
    // cualquier razón no lo es, falla claro aquí en vez de que el proveedor lo
    // rechace como application/octet-stream tras gastar la subida.
    assertOggOpusBuffer(converted)

    if (converted.length > MAX_WHATSAPP_AUDIO_BYTES) {
      throw new Error('El audio pesa demasiado. Graba uno más corto para poder enviarlo por WhatsApp.')
    }

    return converted
  } finally {
    await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function convertAudioToChatPlaybackMp4({ buffer, extension }) {
  const folder = await fs.mkdtemp(join(tmpdir(), 'ristak-chat-audio-preview-'))
  const inputPath = join(folder, `input.${extension || 'audio'}`)
  const outputPath = join(folder, `preview.${CHAT_AUDIO_PLAYBACK_EXTENSION}`)

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
      '44100',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-movflags',
      '+faststart',
      outputPath
    ], {
      unavailableMessage: 'El audio salió en un formato que Ristak no pudo preparar para reproducirse. Intenta grabarlo otra vez.',
      failureMessage: 'No se pudo preparar el audio para reproducirse en el chat. Intenta grabarlo otra vez.'
    })

    const converted = await fs.readFile(outputPath)
    if (!converted.length) {
      throw new Error('El audio de reproducción quedó vacío. Intenta grabarlo otra vez.')
    }

    if (converted.length > MAX_WHATSAPP_AUDIO_BYTES) {
      throw new Error('El audio pesa demasiado. Graba uno más corto para poder enviarlo por WhatsApp.')
    }

    return converted
  } finally {
    await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function prepareWhatsAppVoiceAudio(parsed) {
  // Transcodifica si el formato no es opus, O si dice ser audio/ogg;opus pero los
  // bytes NO son un OGG real (cliente con etiqueta mentirosa). Nunca se sube un
  // buffer no-OGG bajo la etiqueta de nota de voz → mata el rechazo octet-stream.
  if (audioNeedsWhatsAppConversion(parsed) || !isOggOpusBuffer(parsed.buffer)) {
    return {
      buffer: await convertAudioToOggOpus(parsed),
      mimeType: WHATSAPP_VOICE_NOTE_MIME_TYPE,
      extension: 'ogg',
      compression: 'whatsapp_ogg_opus'
    }
  }

  return {
    buffer: parsed.buffer,
    mimeType: normalizeVoiceNoteMimeType(parsed) || parsed.mimeType,
    extension: 'ogg',
    compression: 'original_ogg_opus'
  }
}

/**
 * Normaliza binarios multipart de la app nativa antes de persistirlos en el
 * CDN. Es la misma tubería estricta que antes solo se ejecutaba después de
 * decodificar un data URL: imagen optimizada, video MP4 H.264 y voz OGG/Opus.
 * Los documentos se conservan byte por byte.
 */
export async function prepareWhatsAppMediaForDirectUpload({
  buffer,
  mimeType = '',
  filename = '',
  kind = ''
} = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('El archivo está vacío.')
  }

  const cleanKind = cleanString(kind).toLowerCase()
  const normalizedMimeType = cleanMimeType(mimeType)

  if (cleanKind === 'image') {
    const extension = IMAGE_EXTENSION_BY_MIME[normalizedMimeType]
    if (!extension) throw new Error('La foto debe ser JPG, PNG o WebP.')
    if (buffer.length > MAX_WHATSAPP_IMAGE_INPUT_BYTES) {
      throw new Error('La foto pesa demasiado. Toma otra foto más ligera o recórtala antes de enviarla.')
    }
    const prepared = await prepareWhatsAppApiImageBuffer({ buffer, mimeType: normalizedMimeType })
    return {
      ...prepared,
      filename: `whatsapp-image.${prepared.extension}`,
      metadata: {
        whatsappApiCompatible: true,
        whatsappImageCompression: prepared.compression,
        originalMimeType: normalizedMimeType,
        originalFilename: sanitizeDocumentFilename(filename, normalizedMimeType)
      }
    }
  }

  if (cleanKind === 'video') {
    const extension = VIDEO_EXTENSION_BY_MIME[normalizedMimeType]
    if (!extension) {
      throw new Error('El video debe ser MP4, MOV, WebM o 3GP para poder prepararlo para WhatsApp.')
    }
    if (buffer.length > MAX_WHATSAPP_VIDEO_INPUT_BYTES) {
      throw new Error('El video pesa demasiado. Graba uno más corto para poder comprimirlo y enviarlo por WhatsApp.')
    }
    const prepared = await convertVideoToWhatsAppMp4({ buffer, extension })
    return {
      buffer: prepared.buffer,
      mimeType: WHATSAPP_VIDEO_MIME_TYPE,
      extension: 'mp4',
      filename: 'whatsapp-video.mp4',
      metadata: {
        whatsappApiCompatible: true,
        whatsappVideoCompression: prepared.compression,
        originalMimeType: normalizedMimeType,
        originalFilename: sanitizeDocumentFilename(filename, normalizedMimeType)
      }
    }
  }

  if (cleanKind === 'audio') {
    const extension = AUDIO_EXTENSION_BY_MIME[normalizedMimeType]
    if (!extension) {
      throw new Error('WhatsApp no acepta este formato de audio. Graba otra vez o usa un audio compatible.')
    }
    if (buffer.length > MAX_WHATSAPP_AUDIO_BYTES) {
      throw new Error('El audio pesa demasiado. Graba uno más corto para poder enviarlo por WhatsApp.')
    }
    const params = cleanString(mimeType).toLowerCase().split(';').slice(1).join(';')
    const prepared = await prepareWhatsAppVoiceAudio({
      buffer,
      mimeType: normalizedMimeType,
      params,
      extension
    })
    return {
      ...prepared,
      filename: `whatsapp-audio.${prepared.extension}`,
      metadata: {
        whatsappApiCompatible: true,
        whatsappVoiceNote: true,
        whatsappAudioCompression: prepared.compression,
        originalMimeType: normalizedMimeType,
        originalFilename: sanitizeDocumentFilename(filename, normalizedMimeType)
      }
    }
  }

  if (cleanKind === 'document') {
    const allowed = DOCUMENT_EXTENSION_BY_MIME[normalizedMimeType] ||
      VIDEO_EXTENSION_BY_MIME[normalizedMimeType] ||
      AUDIO_EXTENSION_BY_MIME[normalizedMimeType]
    if (!allowed) {
      throw new Error('El archivo debe ser PDF, Word, Excel, PowerPoint, TXT, CSV, audio o video compatible.')
    }
    if (buffer.length > MAX_WHATSAPP_DOCUMENT_BYTES) {
      throw new Error('El documento pesa demasiado. Elige uno de menos de 20 MB para poder enviarlo por WhatsApp.')
    }
    return {
      buffer,
      mimeType: normalizedMimeType,
      extension: getDocumentSendExtension(normalizedMimeType),
      filename: sanitizeDocumentFilename(filename, normalizedMimeType),
      metadata: {
        whatsappApiCompatible: true,
        whatsappDocument: true,
        originalMimeType: normalizedMimeType
      }
    }
  }

  throw new Error('El tipo de archivo de chat no es válido.')
}

async function prepareChatAudioPlaybackPreview(parsed) {
  if (audioNeedsChatPlaybackConversion(parsed)) {
    return {
      buffer: await convertAudioToChatPlaybackMp4(parsed),
      mimeType: CHAT_AUDIO_PLAYBACK_MIME_TYPE,
      extension: CHAT_AUDIO_PLAYBACK_EXTENSION,
      compression: 'chat_playback_m4a_aac'
    }
  }

  const normalizedMimeType = cleanMimeTypeValue(parsed.mimeType)
  return {
    buffer: parsed.buffer,
    mimeType: normalizedMimeType === 'audio/x-wav' ? 'audio/wav' : normalizedMimeType,
    extension: AUDIO_EXTENSION_BY_MIME[normalizedMimeType] || CHAT_AUDIO_PLAYBACK_EXTENSION,
    compression: 'original_chat_playback'
  }
}

export async function saveWhatsAppImageDataUrl(dataUrl = '') {
  const parsed = parseImageDataUrl(dataUrl)
  const prepared = await prepareWhatsAppApiImageBuffer(parsed)
  try {
    const { uploadMediaAsset } = await import('./mediaStorageService.js')
    const asset = await uploadMediaAsset({
      buffer: prepared.buffer,
      mimeType: prepared.mimeType,
      filename: `whatsapp-image.${prepared.extension}`,
      module: 'chat',
      isPublic: true,
      skipCompression: true,
      metadata: {
        whatsappApiCompatible: true,
        whatsappImageCompression: prepared.compression,
        originalMimeType: parsed.mimeType,
        originalExtension: parsed.extension
      }
    })
    return {
      mimeType: asset.mimeType,
      size: asset.sizeProcessed,
      publicPath: asset.publicUrl,
      filename: asset.storedFilename,
      mediaAssetId: asset.id
    }
  } catch (error) {
    handleWhatsAppMediaStorageError('imagen de chat', error)
  }

  const dayKey = await getBusinessDayKey()
  const folder = join(WHATSAPP_IMAGE_UPLOAD_ROOT, dayKey)
  const filename = `${crypto.randomUUID()}.${prepared.extension}`
  const filePath = join(folder, filename)

  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(filePath, prepared.buffer)

  return {
    mimeType: prepared.mimeType,
    size: prepared.buffer.length,
    // (WA-006) El fallback a disco local produce una ruta relativa sin HTTPS:
    // solo sirve para envíos por QR. Se marca como local/qr-only y se expone
    // filePath para que el envío por API la detecte y bloquee con un error claro
    // en vez de intentar mandar una URL que WhatsApp no puede abrir.
    localFallback: true,
    qrOnly: true,
    filePath,
    publicPath: `${WHATSAPP_IMAGE_PUBLIC_PATH}/${dayKey}/${filename}`,
    filename
  }
}

export async function saveWhatsAppAudioDataUrl(dataUrl = '') {
  const parsed = parseAudioDataUrl(dataUrl)
  const originalMimeType = parsed.mimeType
  const media = await prepareWhatsAppVoiceAudio(parsed)
  try {
    const { uploadMediaAsset } = await import('./mediaStorageService.js')
    const asset = await uploadMediaAsset({
      buffer: media.buffer,
      mimeType: media.mimeType,
      filename: `whatsapp-audio.${media.extension}`,
      module: 'chat',
      isPublic: true,
      skipCompression: true,
      metadata: {
        whatsappApiCompatible: true,
        whatsappVoiceNote: true,
        whatsappAudioCompression: media.compression,
        originalMimeType,
        originalExtension: parsed.extension
      }
    })
    return {
      mimeType: media.mimeType,
      originalMimeType,
      size: asset.sizeProcessed,
      publicPath: asset.publicUrl,
      filename: asset.storedFilename,
      mediaAssetId: asset.id
    }
  } catch (error) {
    handleWhatsAppMediaStorageError('audio de chat', error)
  }

  const dayKey = await getBusinessDayKey()
  const folder = join(WHATSAPP_AUDIO_UPLOAD_ROOT, dayKey)
  const filename = `${crypto.randomUUID()}.${media.extension}`
  const filePath = join(folder, filename)

  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(filePath, media.buffer)

  return {
    mimeType: media.mimeType,
    originalMimeType,
    size: media.buffer.length,
    // (WA-006) Fallback local: solo válido para QR (ruta relativa sin HTTPS).
    localFallback: true,
    qrOnly: true,
    filePath,
    publicPath: `${WHATSAPP_AUDIO_PUBLIC_PATH}/${dayKey}/${filename}`,
    filename
  }
}

export async function saveWhatsAppAudioPlaybackPreviewDataUrl(dataUrl = '', durationMs = null) {
  const parsed = parseAudioDataUrl(dataUrl)
  const originalMimeType = parsed.mimeType
  const media = await prepareChatAudioPlaybackPreview(parsed)
  const cleanDurationMs = Number(durationMs || 0)
  try {
    const { uploadMediaAsset } = await import('./mediaStorageService.js')
    const asset = await uploadMediaAsset({
      buffer: media.buffer,
      mimeType: media.mimeType,
      filename: `whatsapp-audio-preview.${media.extension}`,
      module: 'chat',
      isPublic: true,
      skipCompression: true,
      metadata: {
        whatsappChatPlaybackPreview: true,
        whatsappAudioPlaybackCompression: media.compression,
        originalMimeType,
        originalExtension: parsed.extension,
        ...(cleanDurationMs > 0 ? { durationMs: Math.round(cleanDurationMs) } : {})
      }
    })
    const publicUrl = cleanString(asset.publicUrl || asset.url)
    return {
      mimeType: asset.mimeType || media.mimeType,
      size: asset.sizeProcessed,
      publicPath: publicUrl,
      publicUrl,
      mediaUrl: publicUrl,
      url: publicUrl,
      link: publicUrl,
      filename: asset.storedFilename,
      mediaAssetId: asset.id,
      storage: cleanString(asset.storageProvider || 'media_storage'),
      storageProvider: cleanString(asset.storageProvider || ''),
      originalMimeType,
      originalExtension: parsed.extension,
      ...(cleanDurationMs > 0 ? { durationMs: Math.round(cleanDurationMs) } : {})
    }
  } catch (error) {
    handleWhatsAppMediaStorageError('preview de audio de chat', error)
  }

  const dayKey = await getBusinessDayKey()
  const folder = join(WHATSAPP_AUDIO_UPLOAD_ROOT, dayKey)
  const filename = `${crypto.randomUUID()}.${media.extension}`
  const filePath = join(folder, filename)
  const publicPath = `${WHATSAPP_AUDIO_PUBLIC_PATH}/${dayKey}/${filename}`

  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(filePath, media.buffer)

  return {
    mimeType: media.mimeType,
    size: media.buffer.length,
    localFallback: true,
    filePath,
    publicPath,
    publicUrl: publicPath,
    mediaUrl: publicPath,
    url: publicPath,
    link: publicPath,
    filename,
    storage: 'local',
    storageProvider: 'local',
    originalMimeType,
    originalExtension: parsed.extension,
    ...(cleanDurationMs > 0 ? { durationMs: Math.round(cleanDurationMs) } : {})
  }
}

export async function saveWhatsAppVideoDataUrl(dataUrl = '') {
  const parsed = parseVideoDataUrl(dataUrl)
  const originalMimeType = parsed.mimeType
  const media = await prepareWhatsAppVideo(parsed)
  try {
    const { uploadMediaAsset } = await import('./mediaStorageService.js')
    const asset = await uploadMediaAsset({
      buffer: media.buffer,
      mimeType: media.mimeType,
      filename: `whatsapp-video.${media.extension}`,
      module: 'chat',
      isPublic: true,
      skipCompression: true,
      metadata: {
        whatsappApiCompatible: true,
        whatsappVideoCompression: media.compression,
        originalMimeType,
        originalExtension: parsed.extension
      }
    })
    return {
      mimeType: media.mimeType,
      originalMimeType,
      size: asset.sizeProcessed,
      publicPath: asset.publicUrl,
      filename: asset.storedFilename,
      mediaAssetId: asset.id
    }
  } catch (error) {
    handleWhatsAppMediaStorageError('video de chat', error)
  }

  const dayKey = await getBusinessDayKey()
  const folder = join(WHATSAPP_VIDEO_UPLOAD_ROOT, dayKey)
  const filename = `${crypto.randomUUID()}.${media.extension}`
  const filePath = join(folder, filename)

  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(filePath, media.buffer)

  return {
    mimeType: media.mimeType,
    originalMimeType,
    size: media.buffer.length,
    // (WA-006) Fallback local: solo válido para QR (ruta relativa sin HTTPS).
    localFallback: true,
    qrOnly: true,
    filePath,
    publicPath: `${WHATSAPP_VIDEO_PUBLIC_PATH}/${dayKey}/${filename}`,
    filename
  }
}

export async function saveWhatsAppDocumentDataUrl(dataUrl = '', filename = '', mimeType = '') {
  const parsed = parseDocumentDataUrl(dataUrl, filename, mimeType)
  try {
    const { uploadMediaAsset } = await import('./mediaStorageService.js')
    const asset = await uploadMediaAsset({
      buffer: parsed.buffer,
      mimeType: parsed.mimeType,
      filename: parsed.filename,
      module: 'chat',
      isPublic: true
    })
    return {
      mimeType: asset.mimeType,
      size: asset.sizeProcessed,
      publicPath: asset.publicUrl,
      storedFilename: asset.storedFilename,
      filename: asset.originalFilename,
      mediaAssetId: asset.id
    }
  } catch (error) {
    handleWhatsAppMediaStorageError('documento de chat', error)
  }

  const dayKey = await getBusinessDayKey()
  const folder = join(WHATSAPP_DOCUMENT_UPLOAD_ROOT, dayKey)
  const storedFilename = `${crypto.randomUUID()}.${parsed.extension}`
  const filePath = join(folder, storedFilename)

  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(filePath, parsed.buffer)

  return {
    mimeType: parsed.mimeType,
    size: parsed.buffer.length,
    // (WA-006) Fallback local: solo válido para QR (ruta relativa sin HTTPS).
    localFallback: true,
    qrOnly: true,
    filePath,
    publicPath: `${WHATSAPP_DOCUMENT_PUBLIC_PATH}/${dayKey}/${storedFilename}`,
    storedFilename,
    filename: parsed.filename
  }
}

async function prepareWhatsAppImageForProviderUpload(dataUrl = '') {
  const parsed = parseImageDataUrl(dataUrl)
  const prepared = await prepareWhatsAppApiImageBuffer(parsed)
  return {
    buffer: prepared.buffer,
    mimeType: prepared.mimeType,
    filename: `whatsapp-image.${prepared.extension}`,
    size: prepared.buffer.length,
    metadata: {
      whatsappApiCompatible: true,
      whatsappImageCompression: prepared.compression,
      originalMimeType: parsed.mimeType,
      originalExtension: parsed.extension
    }
  }
}

async function prepareWhatsAppAudioForProviderUpload(dataUrl = '') {
  const parsed = parseAudioDataUrl(dataUrl)
  const media = await prepareWhatsAppVoiceAudio(parsed)
  return {
    buffer: media.buffer,
    mimeType: media.mimeType,
    filename: `whatsapp-audio.${media.extension}`,
    size: media.buffer.length,
    metadata: {
      whatsappApiCompatible: true,
      whatsappVoiceNote: true,
      whatsappAudioCompression: media.compression,
      originalMimeType: parsed.mimeType,
      originalExtension: parsed.extension
    }
  }
}

async function prepareWhatsAppVideoForProviderUpload(dataUrl = '') {
  const parsed = parseVideoDataUrl(dataUrl)
  const media = await prepareWhatsAppVideo(parsed)
  return {
    buffer: media.buffer,
    mimeType: media.mimeType,
    filename: `whatsapp-video.${media.extension}`,
    size: media.buffer.length,
    metadata: {
      whatsappApiCompatible: true,
      whatsappVideoCompression: media.compression,
      originalMimeType: parsed.mimeType,
      originalExtension: parsed.extension
    }
  }
}

async function prepareWhatsAppDocumentForProviderUpload(dataUrl = '', filename = '', mimeType = '') {
  const parsed = parseDocumentDataUrl(dataUrl, filename, mimeType)
  return {
    buffer: parsed.buffer,
    mimeType: parsed.mimeType,
    filename: parsed.filename,
    size: parsed.buffer.length,
    metadata: {
      whatsappApiCompatible: true,
      originalMimeType: parsed.mimeType,
      originalExtension: parsed.extension
    }
  }
}

function inferWhatsAppMediaExtension(mimeType = '') {
  const cleanType = cleanMimeType(mimeType)
  return IMAGE_EXTENSION_BY_MIME[cleanType] ||
    AUDIO_EXTENSION_BY_MIME[cleanType] ||
    VIDEO_EXTENSION_BY_MIME[cleanType] ||
    DOCUMENT_EXTENSION_BY_MIME[cleanType] ||
    cleanType.split('/')[1] ||
    'bin'
}

function buildQrInlineMediaMetadata({ dataUrl = '', mimeType = '', filename = '', defaultBasename = 'whatsapp-media', type = '' } = {}) {
  const match = cleanString(dataUrl).match(/^data:([^;,]+)(?:;[^,]*)?;base64,([a-z0-9+/=\s]+)$/i)
  const parsedMimeType = match ? cleanMimeType(match[1]) : ''
  const size = match ? Buffer.byteLength(match[2].replace(/\s/g, ''), 'base64') : null
  const finalMimeType = cleanMimeType(mimeType) || parsedMimeType
  const finalFilename = cleanString(filename) ||
    (defaultBasename && finalMimeType ? `${defaultBasename}.${inferWhatsAppMediaExtension(finalMimeType)}` : '')
  const metadata = {
    ...(match ? { whatsappQrInlineSend: true } : {}),
    ...(type ? { uploadType: type } : {}),
    ...(parsedMimeType ? { originalMimeType: parsedMimeType } : {})
  }

  return {
    ...(finalMimeType ? { mimeType: finalMimeType, mimetype: finalMimeType } : {}),
    ...(finalFilename ? { filename: finalFilename } : {}),
    ...(size ? { size } : {}),
    ...(match ? {
      storage: 'qr',
      storageProvider: 'whatsapp_qr'
    } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {})
  }
}

function mergeMediaMetadata(...values) {
  const merged = {}
  for (const value of values) {
    if (isPlainObject(value)) Object.assign(merged, value)
  }
  return Object.keys(merged).length ? merged : null
}

async function uploadPreparedMediaToYCloud({ config, fromPhone, media, type } = {}) {
  const uploadMimeType = normalizeYCloudUploadMimeType(media?.uploadMimeType || media?.mimeType)
  const uploaded = await ycloudUploadWhatsAppMedia({
    apiKey: config?.apiKey,
    phoneNumber: fromPhone,
    buffer: media?.buffer,
    mimeType: uploadMimeType || media?.mimeType,
    filename: media?.filename
  })

  return {
    id: uploaded.id,
    providerMediaId: uploaded.providerMediaId,
    provider: uploaded.provider,
    providerMediaExpiresAt: uploaded.expiresAt,
    mimeType: uploadMimeType || uploaded.mimeType || '',
    filename: media?.filename || uploaded.filename || '',
    size: media?.size || uploaded.size || null,
    storage: 'provider',
    storageProvider: PROVIDER_NAME,
    uploadType: type || '',
    metadata: {
      ...(media?.metadata || {}),
      ...(media?.mimeType && uploadMimeType && media.mimeType !== uploadMimeType ? { originalUploadMimeType: media.mimeType } : {})
    },
    rawUpload: uploaded.raw || {}
  }
}

async function savePreparedMediaForChatPreview(media = {}, { type = '', mediaLabel = 'media' } = {}) {
  if (!Buffer.isBuffer(media?.buffer) || !media.buffer.length || !media.mimeType) return null

  try {
    const { uploadMediaAsset } = await import('./mediaStorageService.js')
    const asset = await uploadMediaAsset({
      buffer: media.buffer,
      mimeType: media.mimeType,
      filename: media.filename || `whatsapp-${type || 'media'}.${inferWhatsAppMediaExtension(media.mimeType)}`,
      module: 'chat',
      isPublic: true,
      skipCompression: true,
      metadata: {
        ...(isPlainObject(media.metadata) ? media.metadata : {}),
        whatsappProviderPreview: true,
        uploadType: type || 'media'
      }
    })
    const publicUrl = cleanString(asset.publicUrl || asset.url)
    if (!publicUrl) return null

    return {
      publicUrl,
      mediaUrl: publicUrl,
      url: publicUrl,
      link: publicUrl,
      mimeType: cleanString(asset.mimeType || media.mimeType),
      filename: cleanString(asset.storedFilename || asset.filename || asset.originalFilename || media.filename),
      mediaAssetId: cleanString(asset.id),
      storage: cleanString(asset.storageProvider || 'media_storage'),
      storageProvider: cleanString(asset.storageProvider || '')
    }
  } catch (error) {
    logger.warn(`[WhatsApp API] No se pudo guardar preview de ${mediaLabel}: ${error.message}`)
    return null
  }
}

async function saveQrInlineImageForChatPreview(dataUrl = '') {
  const cleanDataUrl = cleanString(dataUrl)
  if (!cleanDataUrl) return null

  try {
    const preparedImage = await prepareWhatsAppImageForProviderUpload(cleanDataUrl)
    return savePreparedMediaForChatPreview(preparedImage, {
      type: 'image',
      mediaLabel: 'foto de WhatsApp QR'
    })
  } catch (error) {
    logger.warn(`[WhatsApp QR] No se pudo guardar preview de foto QR: ${error.message}`)
    return null
  }
}

function buildPreparedMediaDataUrl(media = {}) {
  if (!Buffer.isBuffer(media.buffer) || !media.buffer.length || !media.mimeType) return ''
  return `data:${media.mimeType};base64,${media.buffer.toString('base64')}`
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

async function clearYCloudConnectionConfig() {
  await clearWhatsAppApiIntegrationCredentials()
}

async function clearStaleDisconnectedYCloudCredentials(config) {
  if (!config || config.enabled || !config.hasApiKey) return config
  await clearYCloudConnectionConfig()
  return loadConfig()
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
    apiKey: normalizeYCloudApiKeyInput(apiKey),
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

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url')
}

function base64UrlDecode(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8')
}

async function getLicenseRuntimeConfig({ appUrl } = {}) {
  const [
    licenseKey,
    clientId,
    installationId,
    savedAppUrl,
    verifiedAppBaseUrl
  ] = await Promise.all([
    getAppConfig('license_key'),
    getAppConfig('license_client_id'),
    getAppConfig('installation_id'),
    getAppConfig('public_app_url'),
    getVerifiedAppBaseUrl().catch(error => {
      logger.warn(`No se pudo resolver dominio de app verificado para Meta directo: ${error.message}`)
      return ''
    })
  ])

  return {
    licenseKey: cleanString(licenseKey || process.env.RISTAK_LICENSE_KEY || process.env.LICENSE_KEY),
    clientId: cleanString(clientId || process.env.RISTAK_CLIENT_ID || process.env.CLIENT_ID || process.env.RENDER_SERVICE_ID || 'local'),
    installationId: cleanString(installationId || process.env.RISTAK_INSTALLATION_ID || process.env.INSTALLATION_ID || process.env.RENDER_SERVICE_ID || 'local'),
    appUrl: normalizePublicBaseUrl(verifiedAppBaseUrl || appUrl || savedAppUrl || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || process.env.APP_URL || 'http://localhost:5173')
  }
}

function signHmacHex(secret, value) {
  return crypto.createHmac('sha256', cleanString(secret)).update(String(value || '')).digest('hex')
}

function encodeSignedState(payload, secret) {
  const body = base64UrlEncode(JSON.stringify(payload || {}))
  return `${body}.${signHmacHex(secret, body)}`
}

function decodeSignedState(state = '', secret = '') {
  const [body, signature] = cleanString(state).split('.')
  if (!body || !signature || !secret) throw new Error('Estado de conexión inválido')
  const expected = signHmacHex(secret, body)
  if (!timingSafeEqualText(expected, signature)) throw new Error('Estado de conexión alterado')
  const payload = JSON.parse(base64UrlDecode(body))
  if (Number(payload.exp || 0) && Date.now() > Number(payload.exp)) {
    throw new Error('Estado de conexión expirado')
  }
  return payload
}

async function getMetaDirectHmacSecret() {
  const runtime = await getLicenseRuntimeConfig()
  if (!runtime.licenseKey) throw new Error('Falta la licencia local para firmar la conexión con Ristak')
  return runtime.licenseKey
}

function timingSafeEqualText(left = '', right = '') {
  const leftBuffer = Buffer.from(cleanString(left))
  const rightBuffer = Buffer.from(cleanString(right))
  if (leftBuffer.length !== rightBuffer.length) return false
  return crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

async function rememberSignedRequestNonce(nonce, purpose = 'meta_direct') {
  const cleanNonce = cleanString(nonce)
  if (!cleanNonce) throw new Error('Falta nonce de seguridad')
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  await db.run(`
    DELETE FROM whatsapp_meta_direct_nonces
    WHERE created_at < ?
  `, [cutoff]).catch(() => null)

  const existing = await db.get('SELECT nonce FROM whatsapp_meta_direct_nonces WHERE nonce = ?', [cleanNonce]).catch(() => null)
  if (existing) throw new Error('Nonce de seguridad repetido')
  await db.run('INSERT INTO whatsapp_meta_direct_nonces (nonce, purpose) VALUES (?, ?)', [cleanNonce, purpose])
}

async function verifyInstallerSignedRequest({ rawBody = '', headers = {}, purpose = 'meta_direct' } = {}) {
  const timestamp = cleanString(headers.signatureTimestamp || headers.timestamp)
  const nonce = cleanString(headers.signatureNonce || headers.nonce)
  const signature = cleanString(headers.signature)
  if (!timestamp || !nonce || !signature) throw new Error('Faltan encabezados de firma de Ristak')

  const timestampMs = Number(timestamp)
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) {
    throw new Error('Firma expirada')
  }

  const secret = await getMetaDirectHmacSecret()
  const expected = signHmacHex(secret, `${timestamp}.${nonce}.${rawBody || ''}`)
  if (!timingSafeEqualText(expected, signature)) throw new Error('Firma inválida de Ristak')
  await rememberSignedRequestNonce(nonce, purpose)
}

async function loadMetaDirectConfig({ includeSecrets = false } = {}) {
  const [
    status,
    appId,
    businessId,
    wabaId,
    phoneNumberId,
    displayPhoneNumber,
    coexistenceEnabled,
    webhookMode,
    installerWebhookUrl,
    installerOAuthCallbackUrl,
    connectedAt,
    disconnectedAt,
    lastWebhookReceivedAt,
    lastRelayReceivedAt,
    lastError,
    datasetId,
    adAccountId,
    token
  ] = await Promise.all([
    getAppConfig(CONFIG_KEYS.metaStatus),
    getAppConfig(CONFIG_KEYS.metaAppId),
    getAppConfig(CONFIG_KEYS.metaBusinessId),
    getAppConfig(CONFIG_KEYS.metaWabaId),
    getAppConfig(CONFIG_KEYS.metaPhoneNumberId),
    getAppConfig(CONFIG_KEYS.metaDisplayPhoneNumber),
    getAppConfig(CONFIG_KEYS.metaCoexistenceEnabled),
    getAppConfig(CONFIG_KEYS.metaWebhookMode),
    getAppConfig(CONFIG_KEYS.metaInstallerWebhookUrl),
    getAppConfig(CONFIG_KEYS.metaInstallerOAuthCallbackUrl),
    getAppConfig(CONFIG_KEYS.metaConnectedAt),
    getAppConfig(CONFIG_KEYS.metaDisconnectedAt),
    getAppConfig(CONFIG_KEYS.metaLastWebhookReceivedAt),
    getAppConfig(CONFIG_KEYS.metaLastRelayReceivedAt),
    getAppConfig(CONFIG_KEYS.metaLastError),
    getAppConfig(CONFIG_KEYS.metaDatasetId),
    getAppConfig(CONFIG_KEYS.metaAdAccountId),
    includeSecrets ? getEncryptedConfig(CONFIG_KEYS.metaSystemUserToken) : Promise.resolve('')
  ])

  const hasSystemUserToken = Boolean(await getAppConfig(CONFIG_KEYS.metaSystemUserToken))
  const connected = status === 'connected' && Boolean(phoneNumberId && wabaId && hasSystemUserToken)

  return {
    provider: META_DIRECT_PROVIDER_NAME,
    status: connected ? 'connected' : (status || 'disconnected'),
    connected,
    configured: Boolean(phoneNumberId || wabaId || appId || hasSystemUserToken),
    hasSystemUserToken,
    appId: appId || '',
    businessId: businessId || '',
    wabaId: wabaId || '',
    phoneNumberId: phoneNumberId || '',
    displayPhoneNumber: displayPhoneNumber || '',
    coexistenceEnabled: coexistenceEnabled === '1',
    webhookMode: webhookMode || 'installer_relay',
    installerWebhookUrl: installerWebhookUrl || '',
    installerOAuthCallbackUrl: installerOAuthCallbackUrl || '',
    connectedAt: connectedAt || null,
    disconnectedAt: disconnectedAt || null,
    lastWebhookReceivedAt: lastWebhookReceivedAt || null,
    lastRelayReceivedAt: lastRelayReceivedAt || null,
    lastError: lastError || '',
    datasetId: datasetId || '',
    adAccountId: adAccountId || '',
    systemUserToken: token || ''
  }
}

function getYCloudResponseMessage(data, response) {
  const message = data?.error?.error_user_msg ||
    data?.error?.error_data ||
    data?.message ||
    data?.error?.message ||
    data?.error ||
    `WhatsApp API respondió ${response.status} ${response.statusText}`

  return typeof message === 'string' ? message : safeJson(message)
}

function buildYCloudRequestErrorMessage(path, data, response) {
  const statusCode = Number(response.status || 0)
  const message = getYCloudResponseMessage(data, response)

  if ((statusCode === 401 || statusCode === 403) && cleanString(path).startsWith('/webhookEndpoints')) {
    return 'YCloud no permitió configurar el webhook automático. La llave puede estar bien, pero esa cuenta o llave no tiene permiso para crear webhooks desde la API.'
  }

  if (statusCode === 401 || statusCode === 403) {
    return 'YCloud no aceptó esa llave. Copia la API Key desde YCloud en API & Integration > API Keys; no uses el token de webhook ni un token de usuario.'
  }

  return message
}

function buildWebhookSetupWarning(error) {
  const statusCode = Number(error?.statusCode || 0)
  if (statusCode === 401 || statusCode === 403) {
    return 'La llave de WhatsApp API se guardó, pero YCloud no dejó configurar el webhook automático. Los números ya pueden sincronizarse; para recibir mensajes entrantes revisa permisos de webhooks en YCloud y vuelve a sincronizar.'
  }

  return `La llave de WhatsApp API se guardó, pero el webhook quedó pendiente: ${error?.message || 'YCloud no respondió correctamente'}. Ristak volverá a intentarlo al sincronizar.`
}

async function ycloudRequest(path, { apiKey, method = 'GET', body, query } = {}) {
  const cleanApiKey = normalizeYCloudApiKeyInput(apiKey)
  if (!cleanApiKey) {
    throw new Error('Falta la llave de WhatsApp API')
  }

  const url = new URL(`${YCLOUD_API_BASE_URL}${path}`)
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), YCLOUD_REQUEST_TIMEOUT_MS)
  let response

  try {
    response = await ycloudFetch(url.toString(), {
      method,
      headers: {
        accept: 'application/json',
        'X-API-Key': cleanApiKey,
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`YCloud no respondió ${path} en ${Math.round(YCLOUD_REQUEST_TIMEOUT_MS / 1000)} segundos`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }

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
    const message = buildYCloudRequestErrorMessage(path, data, response)
    const error = new Error(message)
    error.statusCode = response.status
    error.ycloudPath = path
    error.ycloud = data
    throw error
  }

  return data || {}
}

function multipartSafeFilename(value = '') {
  const filename = cleanString(value).replace(/[\r\n"]/g, '_')
  return filename || `whatsapp-media-${Date.now()}`
}

/**
 * Construye el multipart como bytes deterministas. YCloud reenvía ese archivo
 * a Meta y sus validadores son muy estrictos con OGG/Opus: dejar que dos
 * implementaciones Fetch distintas serialicen FormData produjo cargas que el
 * proveedor aceptaba inicialmente pero luego clasificaba como octet-stream.
 */
function buildYCloudMultipartUpload({ buffer, filename, mimeType } = {}) {
  const boundary = `----RistakYCloud${crypto.randomBytes(18).toString('hex')}`
  const safeFilename = multipartSafeFilename(filename)
  const safeMimeType = cleanString(mimeType).replace(/[\r\n]/g, '') || 'application/octet-stream'
  const opening = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${safeFilename}"\r\n` +
    `Content-Type: ${safeMimeType}\r\n\r\n`,
    'utf8'
  )
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')

  return {
    body: Buffer.concat([opening, buffer, closing]),
    contentType: `multipart/form-data; boundary=${boundary}`
  }
}

function describeYCloudMediaUpload({ buffer, mimeType, upload } = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer.length : 0
  const fingerprint = Buffer.isBuffer(buffer) && buffer.length
    ? crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16)
    : 'empty'

  return [
    `mime=${cleanString(mimeType) || 'application/octet-stream'}`,
    `bytes=${bytes}`,
    `ogg=${isOggBuffer(buffer)}`,
    `opus=${isOggOpusBuffer(buffer)}`,
    `sha256=${fingerprint}`,
    `multipartBytes=${upload?.body?.length || 0}`
  ].join(', ')
}

async function ycloudUploadWhatsAppMedia({ apiKey, phoneNumber, buffer, mimeType, filename } = {}) {
  const cleanApiKey = normalizeYCloudApiKeyInput(apiKey)
  if (!cleanApiKey) {
    throw new Error('Falta la llave de WhatsApp API')
  }
  const cleanPhoneNumber = normalizePhoneForStorage(phoneNumber) || cleanString(phoneNumber)
  if (!cleanPhoneNumber) throw new Error('Falta el número emisor para subir media a WhatsApp')
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('El archivo para WhatsApp está vacío')

  const normalizedMimeType = normalizeYCloudUploadMimeType(mimeType)
  const cleanFilename = cleanString(filename) || `whatsapp-media-${Date.now()}`
  const upload = buildYCloudMultipartUpload({
    buffer,
    filename: cleanFilename,
    mimeType: normalizedMimeType || 'application/octet-stream'
  })
  const uploadDescription = describeYCloudMediaUpload({
    buffer,
    mimeType: normalizedMimeType,
    upload
  })

  // No registra el archivo ni la llave. Sí deja una huella corta y las firmas
  // del contenedor para poder comprobar en soporte qué bytes salieron hacia
  // YCloud si Meta vuelve a rechazar una nota de voz de forma asíncrona.
  if (normalizedMimeType?.startsWith('audio/')) {
    logger.info(`[WhatsApp API] Subiendo audio a YCloud (${uploadDescription})`)
  }

  const response = await ycloudFetch(`${YCLOUD_API_BASE_URL}/whatsapp/media/${encodeURIComponent(cleanPhoneNumber)}/upload`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'X-API-Key': cleanApiKey,
      'content-type': upload.contentType,
      'content-length': String(upload.body.length)
    },
    // Mandamos un Buffer ya formado, no una implementación de FormData. Así el
    // límite/host de YCloud recibe los bytes OGG/Opus exactos, el boundary y el
    // Content-Length explícito, sin diferencias entre undici, node-fetch o el
    // runtime de Render.
    body: upload.body
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
    const message = buildYCloudRequestErrorMessage(`/whatsapp/media/${cleanPhoneNumber}/upload`, data, response)
    const error = new Error(message)
    error.statusCode = response.status
    error.ycloudPath = '/whatsapp/media/{phoneNumber}/upload'
    error.ycloud = data
    throw error
  }

  const mediaId = cleanString(data?.id || data?.mediaId || data?.media_id)
  if (!mediaId) {
    const error = new Error('WhatsApp API subió el archivo pero no devolvió media id')
    error.statusCode = 502
    error.ycloudPath = '/whatsapp/media/{phoneNumber}/upload'
    error.ycloud = data
    throw error
  }

  if (normalizedMimeType?.startsWith('audio/')) {
    logger.info(`[WhatsApp API] YCloud aceptó el binario de audio (mediaId=${mediaId}, ${uploadDescription})`)
  }

  return {
    id: mediaId,
    provider: PROVIDER_NAME,
    providerMediaId: mediaId,
    mimeType: normalizedMimeType || '',
    filename: cleanFilename,
    size: buffer.length,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    raw: data || {}
  }
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

async function listYCloudContacts(apiKey, { maxPages = 100 } = {}) {
  const contacts = []
  const limit = 100
  const pageLimit = Math.max(1, Math.min(Number(maxPages) || 100, 100))

  for (let page = 1; page <= pageLimit; page += 1) {
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

  if (contacts.length >= pageLimit * limit) {
    logger.warn(`WhatsApp API: YCloud devolvio ${contacts.length} contactos y puede haber mas; la API limita page a ${pageLimit}.`)
  }

  return contacts
}

function extractYCloudPageItems(data = {}) {
  return Array.isArray(data.items)
    ? data.items
    : Array.isArray(data.data)
      ? data.data
      : []
}

function getYCloudPageTotal(data = {}) {
  const total = Number(data.total)
  return Number.isFinite(total) ? total : null
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
    provider: cleanString(record.provider) || PROVIDER_NAME,
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
    provider: item.provider || PROVIDER_NAME,
    waba_id: item.wabaId || null,
    phone_number: item.phoneNumber || null,
    display_phone_number: item.displayPhoneNumber || null,
    verified_name: item.verifiedName || null,
    profile_picture_url: item.profilePictureUrl || null,
    business_profile_json: item.businessProfile ? safeJson(item.businessProfile) : null,
    quality_rating: item.qualityRating || null,
    messaging_limit: item.messagingLimit || null,
    status: item.status || null,
    provider: cleanString(record.provider || item.provider) || PROVIDER_NAME,
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
      title: 'Calidad baja del número',
      message: `${label}: La calidad está en RED o fue marcada como FLAGGED. Esto puede bajar límites o bloquear plantillas.`,
      sourceEventId,
      entityType: 'phone_number',
      entityId,
      raw: { eventType, phoneNumber: phoneNumber.raw || phoneNumber }
    })
  } else if (qualityRating === 'YELLOW') {
    await upsertAlert({
      severity: 'info',
      alertType: 'phone_quality',
      title: 'Calidad media del número',
      message: `${label}: La calidad está en YELLOW. No es bloqueo, pero conviene cuidar volumen y contenido.`,
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
        message: 'Meta marcó esta plantilla y podría deshabilitarla si no mejora su rendimiento.'
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
      message: `${label}: La calidad está en RED. Puede terminar pausada o deshabilitada.`,
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
      message: `La cuenta de WhatsApp API reporta ${amount.toFixed(2)} ${currency}. Recarga antes de lanzar envíos grandes.`,
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
      message: 'WhatsApp API reporto una actualización grave en la cuenta de WhatsApp Business. Revisa el panel de Meta o WhatsApp API.',
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
      title: 'Cuenta WhatsApp Business en revisión',
      message: `WhatsApp API reportó decisión/estado ${decision}. Puede afectar aprobación o envío de plantillas.`,
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
    if (item.status === 'DELETED') {
      await deleteWhatsAppApiTemplateSnapshot({
        wabaId: item.wabaId,
        name: item.name,
        language: item.language,
        ids: [item.id, item.officialTemplateId]
      })
      await deleteLocalMessageTemplateMirror(item)
      continue
    }

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

async function deleteLocalMessageTemplateMirror(template = {}) {
  const name = cleanString(template.name)
  const language = cleanString(template.language)
  if (!name || !language) return { deleted: 0 }

  const result = await db.run(`
    DELETE FROM whatsapp_message_templates
    WHERE language = ?
      AND (
        ycloud_template_name = ?
        OR (COALESCE(ycloud_template_name, '') = '' AND name = ?)
      )
  `, [language, name, name])
  return { deleted: Number(result?.changes || 0) }
}

export async function deleteWhatsAppApiTemplateSnapshot({ wabaId, name, language, ids = [] } = {}) {
  const cleanWabaId = cleanString(wabaId)
  const cleanName = cleanString(name)
  const cleanLanguage = cleanString(language)
  const cleanIds = [...new Set((Array.isArray(ids) ? ids : [ids]).map(cleanString).filter(Boolean))]
  const clauses = []
  const params = []

  if (cleanName && cleanLanguage) {
    const clause = cleanWabaId
      ? '(waba_id = ? AND name = ? AND language = ?)'
      : '(name = ? AND language = ?)'
    clauses.push(clause)
    if (cleanWabaId) params.push(cleanWabaId)
    params.push(cleanName, cleanLanguage)
  }

  if (cleanIds.length) {
    const placeholders = cleanIds.map(() => '?').join(', ')
    clauses.push(`(id IN (${placeholders}) OR official_template_id IN (${placeholders}))`)
    params.push(...cleanIds, ...cleanIds)
  }

  if (!clauses.length) {
    return { deleted: 0, sendReferencesReleased: 0 }
  }

  const whereSql = clauses.join(' OR ')
  const rows = await db.all(`SELECT id FROM whatsapp_api_templates WHERE ${whereSql}`, params)
  const templateIds = [...new Set(rows.map(row => cleanString(row.id)).filter(Boolean))]
  let sendReferencesReleased = 0

  if (templateIds.length) {
    const placeholders = templateIds.map(() => '?').join(', ')
    const result = await db.run(
      `UPDATE whatsapp_api_template_sends SET template_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE template_id IN (${placeholders})`,
      templateIds
    )
    sendReferencesReleased = Number(result?.changes || 0)
  }

  const result = await db.run(`DELETE FROM whatsapp_api_templates WHERE ${whereSql}`, params)
  return {
    deleted: Number(result?.changes || 0),
    sendReferencesReleased
  }
}

export async function upsertWhatsAppApiTemplateSnapshot(record = {}) {
  const config = await loadConfig()
  const wabaId = cleanString(record.wabaId || record.waba_id || config.wabaId)
  const item = normalizeTemplateRecord({
    ...record,
    wabaId
  })

  if (!item.wabaId || !item.name || !item.language) return null

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
      official_template_id = COALESCE(excluded.official_template_id, whatsapp_api_templates.official_template_id),
      category = COALESCE(NULLIF(excluded.category, ''), whatsapp_api_templates.category),
      sub_category = COALESCE(NULLIF(excluded.sub_category, ''), whatsapp_api_templates.sub_category),
      previous_category = COALESCE(NULLIF(excluded.previous_category, ''), whatsapp_api_templates.previous_category),
      message_send_ttl_seconds = COALESCE(excluded.message_send_ttl_seconds, whatsapp_api_templates.message_send_ttl_seconds),
      status = COALESCE(NULLIF(excluded.status, ''), whatsapp_api_templates.status),
      quality_rating = COALESCE(NULLIF(excluded.quality_rating, ''), whatsapp_api_templates.quality_rating),
      reason = COALESCE(NULLIF(excluded.reason, ''), whatsapp_api_templates.reason),
      status_update_event = COALESCE(NULLIF(excluded.status_update_event, ''), whatsapp_api_templates.status_update_event),
      disable_date = COALESCE(excluded.disable_date, whatsapp_api_templates.disable_date),
      components_json = CASE
        WHEN excluded.components_json IS NOT NULL AND excluded.components_json != '[]' THEN excluded.components_json
        ELSE whatsapp_api_templates.components_json
      END,
      raw_payload_json = excluded.raw_payload_json,
      ycloud_create_time = COALESCE(excluded.ycloud_create_time, whatsapp_api_templates.ycloud_create_time),
      ycloud_update_time = COALESCE(excluded.ycloud_update_time, whatsapp_api_templates.ycloud_update_time),
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

  return item.id
}

async function syncLocalMessageTemplateFromYCloud(template) {
  if (!template?.name || !template?.language) return

  try {
    await db.run(`
      UPDATE whatsapp_message_templates
      SET
        ycloud_template_id = COALESCE(?, ycloud_template_id),
        ycloud_template_name = COALESCE(?, ycloud_template_name),
        ycloud_status = ?,
        ycloud_reason = ?,
        ycloud_status_update_event = ?,
        ycloud_quality_rating = ?,
        ycloud_raw_payload_json = ?,
        ycloud_synced_at = CURRENT_TIMESTAMP,
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE language = ?
        AND (
          ycloud_template_name = ?
          OR (COALESCE(ycloud_template_name, '') = '' AND name = ?)
        )
    `, [
      template.officialTemplateId || template.id || null,
      template.name || null,
      template.status || null,
      template.reason || null,
      template.statusUpdateEvent || null,
      template.qualityRating || null,
      safeJson(template.raw),
      template.language,
      template.name,
      template.name
    ])
  } catch (error) {
    logger.warn(`No se pudo sincronizar plantilla local ${template.name}/${template.language}: ${error.message}`)
  }
}

async function syncPhoneNumbers(phoneNumbers = [], options = {}) {
  const normalized = phoneNumbers.map(normalizePhoneNumberRecord)

  // Cuando recibimos la lista COMPLETA desde YCloud (pruneMissing) borramos las
  // filas en caché que YCloud ya no devuelve (números eliminados / WABA dado de baja),
  // así no se quedan apareciendo números fantasma en la app. Protegemos los números
  // que estén conectados por QR (WhatsApp Web), que no salen del API de YCloud.
  if (options.pruneMissing) {
    const keepIds = normalized.map(item => item.id).filter(Boolean)
    const placeholders = keepIds.map(() => '?').join(', ')
    const stale = await db.all(`
      SELECT id, phone_number, verified_name
      FROM whatsapp_api_phone_numbers
      WHERE COALESCE(provider, 'ycloud') = ?
        AND LOWER(COALESCE(qr_status, '')) NOT IN ('connected', 'reconnecting', 'restarting')
        ${keepIds.length ? `AND id NOT IN (${placeholders})` : ''}
    `, [PROVIDER_NAME, ...keepIds])

    for (const row of stale) {
      await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [row.id])
      logger.info(`WhatsApp API: número eliminado de YCloud, borrado de caché local: ${row.phone_number || row.id} (${row.verified_name || 'sin nombre'})`)
    }
  }

  for (const item of normalized) {
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, waba_id, phone_number, display_phone_number, verified_name,
        profile_picture_url, business_profile_json, quality_rating, messaging_limit,
        status, raw_payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        provider = COALESCE(NULLIF(excluded.provider, ''), whatsapp_api_phone_numbers.provider),
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
      cleanString(item.provider) || PROVIDER_NAME,
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
    SELECT id, phone_number, display_phone_number, qr_connected_phone
    FROM whatsapp_api_phone_numbers
  `).catch(() => [])

  const match = rows.find(row => rowMatchesAnyPhone(row, [normalized]))

  return match?.id || null
}

const BUSINESS_PHONE_ROW_SELECT = `
  id, waba_id, phone_number, display_phone_number, status,
  quality_rating, api_send_enabled, qr_send_enabled, qr_status,
  qr_connected_phone, qr_last_error, is_default_sender, updated_at
`

async function findBusinessPhoneRowForSender({ phoneNumberId, fromPhone } = {}) {
  const cleanPhoneNumberId = cleanString(phoneNumberId)
  if (cleanPhoneNumberId) {
    return db.get(`
      SELECT ${BUSINESS_PHONE_ROW_SELECT}
      FROM whatsapp_api_phone_numbers
      WHERE id = ?
    `, [cleanPhoneNumberId]).catch(() => null)
  }

  const normalized = normalizePhoneForStorage(fromPhone) || cleanString(fromPhone)
  if (!normalized) return null

  const rows = await db.all(`
    SELECT ${BUSINESS_PHONE_ROW_SELECT}
    FROM whatsapp_api_phone_numbers
    ORDER BY is_default_sender DESC, updated_at DESC
  `).catch(() => [])

  return rows.find(row => rowMatchesAnyPhone(row, [normalized])) || null
}

function isQrFallbackReady(phoneRow = {}) {
  if (!phoneRow?.id) return false
  const status = cleanString(phoneRow.qr_status).toLowerCase()
  const resumableStatus = QR_FALLBACK_READY_STATUSES.has(status) || status.startsWith('disconnected_')
  const legacyConnectedPhone = !status && cleanString(phoneRow.qr_connected_phone)
  return Boolean(
    phoneRow?.id &&
    Number(phoneRow.qr_send_enabled || 0) === 1 &&
    (resumableStatus || legacyConnectedPhone)
  )
}

function getPhoneRowMatchValues(phoneRow = {}) {
  const row = phoneRow || {}
  return [
    row.phone_number,
    row.display_phone_number,
    row.qr_connected_phone
  ].map(value => normalizePhoneForStorage(value) || cleanString(value)).filter(Boolean)
}

function rowMatchesAnyPhone(row = {}, phones = []) {
  const candidates = getPhoneRowMatchValues(row)
  return candidates.some(candidate => phones.some(phone => phoneMatches(candidate, phone)))
}

async function findQrFallbackPhoneRowForSender({ phoneNumberId, fromPhone, phoneRow } = {}) {
  const sourceRow = phoneRow || await findBusinessPhoneRowForSender({ phoneNumberId, fromPhone })
  if (isQrFallbackReady(sourceRow)) return sourceRow

  const searchPhones = [
    normalizePhoneForStorage(fromPhone) || cleanString(fromPhone),
    ...getPhoneRowMatchValues(sourceRow)
  ].filter(Boolean)
  if (!searchPhones.length) return null

  const rows = await db.all(`
    SELECT ${BUSINESS_PHONE_ROW_SELECT}
    FROM whatsapp_api_phone_numbers
    WHERE qr_send_enabled = 1
    ORDER BY is_default_sender DESC, updated_at DESC
  `).catch(() => [])

  return rows.find(row =>
    cleanString(row.id) !== cleanString(sourceRow?.id) &&
    isQrFallbackReady(row) &&
    rowMatchesAnyPhone(row, searchPhones)
  ) || null
}

function buildSqlInClause(values = []) {
  const uniqueValues = [...new Set(values.map(cleanString).filter(Boolean))]
  if (!uniqueValues.length) return { clause: '', params: [] }
  return {
    clause: uniqueValues.map(() => '?').join(', '),
    params: uniqueValues
  }
}

async function getOfficialApiClosedReplyWindowReason({ contactId, toPhone, fromPhone, phoneNumberId } = {}) {
  const contactIdValue = cleanString(contactId)
  const contactPhone = normalizePhoneForStorage(toPhone) || cleanString(toPhone)
  const businessPhone = normalizePhoneForStorage(fromPhone) || cleanString(fromPhone)
  const phoneNumberIdValue = cleanString(phoneNumberId)

  const contactClauses = []
  const params = []
  if (contactIdValue) {
    contactClauses.push('contact_id = ?')
    params.push(contactIdValue)
  }
  const contactPhoneMatches = buildSqlInClause(buildPhoneMatchCandidates(contactPhone))
  if (contactPhoneMatches.clause) {
    contactClauses.push(`(phone IN (${contactPhoneMatches.clause}) OR from_phone IN (${contactPhoneMatches.clause}))`)
    params.push(...contactPhoneMatches.params, ...contactPhoneMatches.params)
  }
  if (!contactClauses.length) return WHATSAPP_REPLY_WINDOW_UNKNOWN_REASON

  const businessClauses = []
  const businessPhoneMatches = buildSqlInClause(buildPhoneMatchCandidates(businessPhone))
  if (businessPhoneMatches.clause) {
    businessClauses.push(`(business_phone IN (${businessPhoneMatches.clause}) OR to_phone IN (${businessPhoneMatches.clause}))`)
    params.push(...businessPhoneMatches.params, ...businessPhoneMatches.params)
  }
  if (phoneNumberIdValue) {
    businessClauses.push('business_phone_number_id = ?')
    params.push(phoneNumberIdValue)
  }

  const row = await db.get(`
    SELECT message_timestamp, created_at
    FROM whatsapp_api_messages
    WHERE LOWER(COALESCE(direction, '')) = 'inbound'
      AND (${contactClauses.join(' OR ')})
      ${businessClauses.length ? `AND (${businessClauses.join(' OR ')})` : ''}
    ORDER BY COALESCE(message_timestamp, created_at) DESC, created_at DESC
    LIMIT 1
  `, params).catch(() => null)

  const lastInboundAt = toDateTime(row?.message_timestamp || row?.created_at)
  if (!lastInboundAt) return WHATSAPP_REPLY_WINDOW_UNKNOWN_REASON
  const lastInboundMs = Date.parse(lastInboundAt)
  if (!Number.isFinite(lastInboundMs)) return WHATSAPP_REPLY_WINDOW_UNKNOWN_REASON
  return Date.now() - lastInboundMs >= WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS
    ? WHATSAPP_REPLY_WINDOW_CLOSED_REASON
    : ''
}

function getPhoneRowRestrictionReason(phoneRow = {}) {
  if (!phoneRow?.id) return ''
  const status = cleanString(phoneRow.status).toUpperCase()
  const apiSendEnabled = phoneRow.api_send_enabled === undefined || phoneRow.api_send_enabled === null
    ? 1
    : Number(phoneRow.api_send_enabled)
  if (apiSendEnabled === 0) {
    return 'El envío por WhatsApp API está desactivado para este número.'
  }
  if (API_FALLBACK_PHONE_STATUSES.has(status)) {
    return `WhatsApp API marcó este número como ${status}.`
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
    SELECT alert_type, severity, title, message, entity_type, entity_id, updated_at
    FROM whatsapp_api_alerts
    WHERE status = 'active'
      AND (${alertScopes.join(' OR ')})
    ORDER BY updated_at DESC
  `, params).catch(() => [])
  const blockingAlert = alerts.find(alert => (
    isBlockingOfficialApiAlert(alert) && !isExpiredRestrictionAlert(alert)
  ))
  if (!blockingAlert) return ''

  return cleanString(blockingAlert.message || blockingAlert.title) ||
    'WhatsApp API reportó una restricción activa.'
}

// Una alerta de bloqueo que no se ha refrescado en este lapso deja de frenar
// los envios por API: el siguiente envio funciona como sonda. Si la cuenta
// sigue bloqueada, el fallo reactiva la alerta; si Meta ya la libero, el envio
// sale y resolveOfficialApiRestrictionAlerts limpia la alerta. Sin esto, la
// alerta bloquea el intento y nunca se entera de que la cuenta ya funciona.
const RESTRICTION_ALERT_TTL_MS = 6 * 60 * 60 * 1000

function isExpiredRestrictionAlert(alert = {}) {
  const updatedAt = Date.parse(alert.updated_at || '')
  if (!Number.isFinite(updatedAt)) return false
  return (Date.now() - updatedAt) > RESTRICTION_ALERT_TTL_MS
}

// Contraparte de activateOfficialApiRestrictionFromFailedMessage: cuando la API
// vuelve a aceptar mensajes de este número/cuenta, las alertas de bloqueo ya no
// reflejan la realidad y deben resolverse solas.
async function resolveOfficialApiRestrictionAlerts({ businessPhoneNumberId, wabaId } = {}) {
  const cleanWabaId = cleanString(wabaId)
  if (businessPhoneNumberId) {
    await resolveAlert({ alertType: 'phone_status', entityType: 'phone_number', entityId: businessPhoneNumberId })
  }
  if (cleanWabaId && cleanWabaId !== 'business_account') {
    await resolveAlert({ alertType: 'business_account', entityType: 'business_account', entityId: cleanWabaId })
  }
  await resolveAlert({ alertType: 'business_account', entityType: 'business_account', entityId: 'business_account' })
}

function getOfficialApiErrorText(error) {
  return [
    error?.message,
    error?.statusCode,
    safeJson(error?.ycloud || null)
  ].map(cleanString).filter(Boolean).join(' ')
}

// Errores que pertenecen a UNA conversación, no al número ni a la cuenta:
// 131047 = ventana de 24 horas vencida, 131026 = destinatario no puede recibir,
// 131021 = enviarse a si mismo, 470 = fuera de ventana (código legado).
const API_CONVERSATION_SCOPED_ERROR_CODES = /\b(131047|131026|131021|470)\b/

function getOfficialApiConversationWindowReason(error) {
  const text = getOfficialApiErrorText(error)
  if (!text) return ''
  if (/\b(131047|470)\b/.test(text) || /24.?HOUR|24 HORAS|CUSTOMER SERVICE WINDOW|OUTSIDE.*WINDOW/i.test(text)) {
    return WHATSAPP_REPLY_WINDOW_CLOSED_REASON
  }
  return ''
}

function getOfficialApiRestrictionErrorReason(error) {
  const statusCode = Number(error?.statusCode || 0)
  // OJO: para decidir el ALCANCE del error se usa solo el mensaje del error,
  // nunca el JSON crudo del webhook: ese JSON siempre trae "from" y "wabaId",
  // hacia que todo error pareciera "de cuenta" y un simple 131047 (ventana de
  // 24 horas) terminaba marcando el número y la cuenta como bloqueados.
  const text = cleanString(error?.message) || getOfficialApiErrorText(error)
  if (!text) return ''

  if (API_CONVERSATION_SCOPED_ERROR_CODES.test(text)) return ''
  const hasBusinessScope = /\b(WABA|BUSINESS ACCOUNT|PHONE NUMBER|SENDER|QUALITY|MESSAGING LIMIT)\b/i.test(text)
  if (API_FALLBACK_RECIPIENT_ERROR_PATTERN.test(text) && !hasBusinessScope) return ''
  if (statusCode === 429) return 'WhatsApp API rechazó el envío por límite de volumen.'
  if (API_FALLBACK_ERROR_PATTERN.test(text)) {
    return 'WhatsApp API rechazó el envío por restricción o límite.'
  }
  return ''
}

async function getOfficialApiFallbackDecision({
  config,
  fromPhone,
  phoneNumberId,
  toPhone,
  contactId,
  error,
  checkReplyWindow = false
} = {}) {
  const phoneRow = await findBusinessPhoneRowForSender({ phoneNumberId, fromPhone })
  const signalReason = await getOfficialApiRestrictionReason({ phoneRow, config })
  const errorReason = error ? getOfficialApiRestrictionErrorReason(error) : ''
  // La ventana de 24 horas también amerita respaldo QR, pero es un asunto de
  // ESTA conversación: decide el fallback sin marcar nada como restringido.
  const windowReason = error && !errorReason ? getOfficialApiConversationWindowReason(error) : ''
  const preflightWindowReason = !error && checkReplyWindow
    ? await getOfficialApiClosedReplyWindowReason({ contactId, toPhone, fromPhone, phoneNumberId })
    : ''
  const reason = errorReason || windowReason || signalReason || preflightWindowReason
  const fallbackPhoneRow = reason
    ? await findQrFallbackPhoneRowForSender({ phoneNumberId, fromPhone, phoneRow })
    : null

  return {
    phoneRow,
    fallbackPhoneRow,
    reason,
    preflightWindowReason,
    shouldFallback: Boolean(reason && fallbackPhoneRow?.id),
    shouldBlockOfficialApi: Boolean(preflightWindowReason && !fallbackPhoneRow?.id)
  }
}

async function shouldPreferOfficialApiOverRequestedQr({
  cleanTransport,
  preferOfficialApiWhenReplyWindowOpen = false,
  config,
  fromPhone,
  phoneNumberId,
  toPhone,
  contactId
} = {}) {
  if (cleanTransport !== 'qr' || !preferOfficialApiWhenReplyWindowOpen) return false
  const officialApiAvailable = config?.provider === META_DIRECT_PROVIDER_NAME || Boolean(config?.enabled && config?.apiKey)
  if (!officialApiAvailable || !fromPhone || !toPhone) return false

  const decision = await getOfficialApiFallbackDecision({
    config,
    fromPhone,
    phoneNumberId,
    toPhone,
    contactId,
    checkReplyWindow: true
  })
  return !decision.reason
}

function throwIfOfficialApiBlockedByReplyWindow(decision = {}) {
  if (!decision.shouldBlockOfficialApi) return
  throw new Error(decision.reason || 'La conversación está fuera de la ventana de 24 horas; usa una plantilla o QR.')
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
      title: 'Número con WhatsApp API bloqueado',
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
  existingMessage,
  agentMetadata = {}
} = {}) {
  const previousTransport = cleanString(existingMessage?.transport).toLowerCase()
  const currentStatus = cleanString(normalizedMessage?.status).toLowerCase()
  if ((previousTransport === 'qr' && cleanString(existingMessage?.routing_reason)) || currentStatus !== 'failed') return null

  const phoneRow = await findQrFallbackPhoneRowForSender({
    phoneNumberId: businessPhoneNumberId,
    fromPhone: identity?.businessPhone || normalizedMessage?.from
  })
  if (!phoneRow?.id) {
    logger.warn(`[WhatsApp API] Cuenta restringida pero QR no está listo para ${identity?.businessPhone || normalizedMessage?.from || 'número desconocido'}`)
    return null
  }

  const fromPhone = identity?.businessPhone || normalizedMessage?.from
  const toPhone = identity?.phone || normalizedMessage?.to
  const fallbackExternalId = `${cleanString(normalizedMessage?.externalId || messageId) || hashId('waapi_failed', safeJson(normalizedMessage))}-qr-fallback`
  const cleanMessageType = cleanString(messageType).toLowerCase()

  try {
    let fallbackResponse = null
    if (['text', 'interactive', 'template'].includes(cleanMessageType) && messageText) {
      fallbackResponse = await sendTextViaQrFallback({
        phoneNumberId: phoneRow.id,
        fromPhone,
        toPhone,
        body: messageText,
        externalId: fallbackExternalId,
        fallbackReason: reason,
        persist: false
      })
    } else if (cleanMessageType === 'location') {
      const location = normalizeWhatsAppLocation(normalizedMessage?.location || {})
      if (!location) return null
      fallbackResponse = await sendLocationViaQrFallback({
        phoneNumberId: phoneRow.id,
        fromPhone,
        toPhone,
        location,
        externalId: fallbackExternalId,
        fallbackReason: reason,
        persist: false
      })
    } else if (cleanMessageType === 'image') {
      const image = normalizedMessage?.image || {}
      const link = cleanString(image.link || image.url)
      if (!link) return null
      fallbackResponse = await sendImageViaQrFallback({
        phoneNumberId: phoneRow.id,
        fromPhone,
        toPhone,
        requestImage: {
          link,
          ...(image.caption ? { caption: image.caption } : {})
        },
        externalId: fallbackExternalId,
        fallbackReason: reason,
        persist: false
      })
    } else if (cleanMessageType === 'audio') {
      const audio = normalizedMessage?.audio || {}
      const link = cleanString(audio.link || audio.url)
      if (!link) return null
      fallbackResponse = await sendAudioViaQrFallback({
        phoneNumberId: phoneRow.id,
        fromPhone,
        toPhone,
        requestAudio: { link },
        externalId: fallbackExternalId,
        fallbackReason: reason,
        persist: false
      })
    } else if (cleanMessageType === 'document') {
      const document = normalizedMessage?.document || {}
      const link = cleanString(document.link || document.url)
      if (!link) return null
      fallbackResponse = await sendDocumentViaQrFallback({
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
        fallbackReason: reason,
        persist: false
      })
    } else if (cleanMessageType === 'video') {
      const video = normalizedMessage?.video || {}
      const link = cleanString(video.link || video.url)
      if (!link) return null
      fallbackResponse = await sendVideoViaQrFallback({
        phoneNumberId: phoneRow.id,
        fromPhone,
        toPhone,
        requestVideo: {
          link,
          ...(video.caption ? { caption: video.caption } : {}),
          ...(video.mimeType || video.mimetype ? { mimeType: video.mimeType || video.mimetype } : {})
        },
        externalId: fallbackExternalId,
        fallbackReason: reason,
        persist: false
      })
    }

    if (!fallbackResponse) return null
    const applied = await applyQrFallbackToExistingApiMessage({
      messageId,
      fallbackResponse,
      reason,
      messageType,
      externalId: fallbackExternalId,
      agentMetadata
    })
    return {
      ...fallbackResponse,
      fallback: true,
      fallbackFrom: 'api',
      fallbackReason: cleanString(reason),
      routingReason: cleanString(reason),
      transport: 'qr',
      status: applied?.status || fallbackResponse.status || 'sent',
      localMessageId: applied?.id || messageId
    }
  } catch (error) {
    logger.warn(`[WhatsApp API] No se pudo reintentar por QR ${messageId}: ${error.message}`)
  }

  return null
}

async function applyQrFallbackToExistingApiMessage({ messageId, fallbackResponse, reason, messageType, externalId = '', agentMetadata = {} } = {}) {
  const cleanMessageId = cleanString(messageId)
  if (!cleanMessageId) return null

  const existing = await db.get(`
    SELECT id, contact_id, direction, message_timestamp, created_at
    FROM whatsapp_api_messages
    WHERE id = ?
  `, [cleanMessageId]).catch(() => null)
  if (!existing?.id) return null

  const fallbackStatus = normalizeMessageDeliveryStatus(fallbackResponse?.status) || 'sent'
  const fallbackWamid = cleanString(fallbackResponse?.wamid || fallbackResponse?.id)
  await db.run(`
    UPDATE whatsapp_api_messages
    SET transport = 'qr',
        routing_reason = ?,
        status = ?,
        error_code = NULL,
        error_message = NULL,
        wamid = COALESCE(NULLIF(?, ''), wamid),
        raw_payload_json = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    cleanString(reason) || 'WhatsApp API no pudo enviar el mensaje; se usó QR como respaldo.',
    fallbackStatus,
    fallbackWamid,
    safeJson({
      fallbackFrom: 'api',
      fallbackTransport: 'qr',
      fallbackReason: cleanString(reason),
      ...(externalId ? { externalId: cleanString(externalId) } : {}),
      ...agentMetadata,
      whatsappMessage: fallbackResponse
    }),
    cleanMessageId
  ])

  publishChatMessageEvent({
    contactId: existing.contact_id,
    messageId: cleanMessageId,
    channel: 'whatsapp',
    provider: PROVIDER_NAME,
    transport: 'qr',
    direction: existing.direction || 'outbound',
    messageType,
    messageTimestamp: existing.message_timestamp || existing.created_at || nowIso(),
    isNew: false
  })

  return { ...existing, transport: 'qr', status: fallbackStatus }
}

function buildSendResponseFromQrFallback(apiResponse = {}, fallbackResponse = null) {
  if (cleanString(fallbackResponse?.transport).toLowerCase() !== 'qr') return null

  const {
    error: _error,
    errors: _errors,
    errorCode: _errorCode,
    errorMessage: _errorMessage,
    ...cleanApiResponse
  } = apiResponse || {}
  const fallbackReason = cleanString(fallbackResponse.fallbackReason || fallbackResponse.routingReason)

  return {
    ...cleanApiResponse,
    ...fallbackResponse,
    fallback: true,
    fallbackFrom: 'api',
    transport: 'qr',
    status: normalizeMessageDeliveryStatus(fallbackResponse.status) || 'sent',
    ...(fallbackReason ? {
      fallbackReason,
      routingReason: fallbackReason
    } : {})
  }
}

function normalizeYCloudContactRecord(record = {}) {
  const phone = normalizePhoneForStorage(record.phoneNumber) || cleanString(record.phoneNumber)
  const profileName = extractWhatsAppProfileName(record, phone) || normalizeWhatsAppProfileName(record.email, phone)
  const firstSeenAt = toDateTime(
    record.createTime ||
    record.createdAt ||
    record.created_at ||
    record.firstSeen ||
    record.first_seen ||
    record.lastSeen
  ) || nowIso()
  const lastSeenAt = toDateTime(
    record.lastSeen ||
    record.updateTime ||
    record.updatedAt ||
    record.updated_at
  ) || firstSeenAt
  return {
    id: cleanString(record.id) || hashId('ycloud_contact', phone || record.email),
    phone,
    email: cleanString(record.email),
    profileName,
    profilePictureUrl: findProfilePictureUrlInValue(record),
    firstSeenAt,
    lastSeenAt,
    sourceId: cleanString(record.sourceId),
    sourceUrl: cleanString(record.sourceUrl),
    sourceType: cleanString(record.sourceType),
    raw: record
  }
}

export async function syncYCloudContacts(contacts = []) {
  for (const contact of contacts.map(normalizeYCloudContactRecord).filter(item => item.phone)) {
    const localContact = await upsertLocalContact({
      phone: contact.phone,
      profileName: contact.profileName,
      messageTimestamp: contact.firstSeenAt,
      attribution: {
        // YCloud contact.sourceId describes how the contact record was created
        // (for example a batch import), not the Click-to-WhatsApp ad id.
        sourceId: '',
        sourceUrl: contact.sourceUrl,
        sourceType: contact.sourceType || 'ycloud_contact',
        sourceApp: SOURCE_NAME,
        entryPoint: 'ycloud_contacts',
        ctwaClid: '',
        headline: '',
        body: ''
      }
    })

    await upsertWhatsAppApiContact({
      contactId: localContact.id,
      phone: contact.phone,
      profileName: contact.profileName,
      rawProfile: contact.raw,
      seenAt: contact.firstSeenAt,
      lastSeenAt: contact.lastSeenAt,
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

async function refreshYCloudWebhookEndpoint(config = {}) {
  let webhookUrl = cleanString(config.webhookUrl)

  if (!webhookUrl && config.webhookEndpointId) {
    const existingEndpoint = await ycloudRequest(`/webhookEndpoints/${encodeURIComponent(config.webhookEndpointId)}`, {
      apiKey: config.apiKey
    })
    webhookUrl = cleanString(existingEndpoint?.url)
  }

  if (!webhookUrl) {
    return { skipped: true, reason: 'missing_webhook_url' }
  }

  const webhookEndpoint = await ensureWebhookEndpoint({
    apiKey: config.apiKey,
    webhookUrl,
    webhookEndpointId: config.webhookEndpointId
  })

  await setAppConfig(CONFIG_KEYS.webhookEndpointId, webhookEndpoint.id || config.webhookEndpointId || '')
  await setAppConfig(CONFIG_KEYS.webhookStatus, webhookEndpoint.status || config.webhookStatus || '')
  await setAppConfig(CONFIG_KEYS.webhookUrl, webhookEndpoint.url || webhookUrl)
  if (webhookEndpoint.secret) {
    await setEncryptedConfig(CONFIG_KEYS.webhookSecret, webhookEndpoint.secret)
  }

  return { skipped: false, webhookEndpoint }
}

async function getPhoneNumbersFromDb() {
  return db.all(`
    SELECT id, waba_id, phone_number, display_phone_number, verified_name,
      provider, profile_picture_url, business_profile_json, quality_rating, messaging_limit,
      status, label, is_default_sender, api_send_enabled, qr_send_enabled,
      qr_consent_accepted_at, qr_consent_accepted_by, qr_status,
      qr_connected_phone, qr_last_connected_at, qr_last_disconnected_at,
      qr_last_error, updated_at
    FROM whatsapp_api_phone_numbers
    ORDER BY is_default_sender DESC, updated_at DESC, phone_number ASC
  `)
}

export async function createWhatsAppQrPhoneNumber({ phoneNumberId, phoneNumber, label } = {}) {
  const cleanPhoneNumberId = cleanString(phoneNumberId)
  const normalizedPhone = normalizePhoneForStorage(phoneNumber) || cleanString(phoneNumber)

  if (cleanPhoneNumberId) {
    const existing = await db.get('SELECT * FROM whatsapp_api_phone_numbers WHERE id = ?', [cleanPhoneNumberId])
    if (!existing) {
      throw new Error('No encontramos ese número QR de WhatsApp')
    }

    const displayPhone = cleanString(phoneNumber) || normalizedPhone
    await db.run(`
      UPDATE whatsapp_api_phone_numbers
      SET phone_number = COALESCE(NULLIF(?, ''), phone_number),
          display_phone_number = COALESCE(NULLIF(?, ''), display_phone_number),
          verified_name = COALESCE(NULLIF(?, ''), verified_name),
          label = COALESCE(NULLIF(?, ''), label),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      normalizedPhone,
      displayPhone,
      cleanString(label),
      cleanString(label),
      cleanPhoneNumberId
    ])

    return db.get('SELECT * FROM whatsapp_api_phone_numbers WHERE id = ?', [cleanPhoneNumberId])
  }

  if (!normalizedPhone) {
    const id = hashId('waqr_phone', `pending:${crypto.randomUUID()}`)
    const verifiedName = cleanString(label) || 'WhatsApp QR'
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, phone_number, display_phone_number, verified_name, label,
        status, api_send_enabled, qr_send_enabled, qr_status, raw_payload_json, updated_at
      ) VALUES (?, 'qr', NULL, NULL, ?, ?, 'QR_ONLY', 0, 0, 'disconnected', ?, CURRENT_TIMESTAMP)
    `, [
      id,
      verifiedName,
      cleanString(label) || null,
      safeJson({ source: 'qr_only_pending', createdAt: nowIso() })
    ])

    return db.get('SELECT * FROM whatsapp_api_phone_numbers WHERE id = ?', [id])
  }

  const existingRows = await getPhoneNumbersFromDb()
  const existing = existingRows.find(row => phoneMatches(row.phone_number || row.display_phone_number, normalizedPhone))
  if (existing?.id) {
    await db.run(`
      UPDATE whatsapp_api_phone_numbers
      SET label = COALESCE(NULLIF(?, ''), label),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [cleanString(label), existing.id])
    return db.get('SELECT * FROM whatsapp_api_phone_numbers WHERE id = ?', [existing.id])
  }

  const id = hashId('waqr_phone', normalizedPhone)
  const displayPhone = cleanString(phoneNumber) || normalizedPhone
  const verifiedName = cleanString(label) || 'WhatsApp QR'
  await db.run(`
    INSERT INTO whatsapp_api_phone_numbers (
      id, provider, phone_number, display_phone_number, verified_name, label,
      status, api_send_enabled, qr_send_enabled, qr_status, raw_payload_json, updated_at
    ) VALUES (?, 'qr', ?, ?, ?, ?, 'QR_ONLY', 0, 0, 'disconnected', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      provider = CASE
        WHEN COALESCE(whatsapp_api_phone_numbers.provider, '') = '' THEN 'qr'
        ELSE whatsapp_api_phone_numbers.provider
      END,
      phone_number = COALESCE(NULLIF(excluded.phone_number, ''), whatsapp_api_phone_numbers.phone_number),
      display_phone_number = COALESCE(NULLIF(excluded.display_phone_number, ''), whatsapp_api_phone_numbers.display_phone_number),
      verified_name = COALESCE(NULLIF(excluded.verified_name, ''), whatsapp_api_phone_numbers.verified_name),
      label = COALESCE(NULLIF(excluded.label, ''), whatsapp_api_phone_numbers.label),
      api_send_enabled = COALESCE(whatsapp_api_phone_numbers.api_send_enabled, 0),
      qr_status = COALESCE(NULLIF(whatsapp_api_phone_numbers.qr_status, ''), excluded.qr_status),
      raw_payload_json = excluded.raw_payload_json,
      updated_at = CURRENT_TIMESTAMP
  `, [
    id,
    normalizedPhone,
    displayPhone,
    verifiedName,
    cleanString(label) || null,
    safeJson({ source: 'qr_only', phoneNumber: normalizedPhone, createdAt: nowIso() })
  ])

  return db.get('SELECT * FROM whatsapp_api_phone_numbers WHERE id = ?', [id])
}

export async function deleteWhatsAppQrPhoneNumber({ phoneNumberId } = {}) {
  const cleanPhoneNumberId = cleanString(phoneNumberId)
  if (!cleanPhoneNumberId) {
    throw new Error('Elige el número QR que quieres eliminar')
  }

  const phone = await db.get(`
    SELECT id, provider, status, phone_number, display_phone_number, verified_name, is_default_sender
    FROM whatsapp_api_phone_numbers
    WHERE id = ?
  `, [cleanPhoneNumberId])

  if (!phone) {
    throw new Error('Ese número de WhatsApp no está en la lista')
  }

  if (cleanString(phone.provider).toLowerCase() !== 'qr') {
    throw new Error('Solo puedes eliminar números conectados por QR. Los números oficiales se eliminan desde YCloud/Meta y Ristak los limpia al sincronizar.')
  }

  await disconnectWhatsAppQrConnection({ phoneNumberId: cleanPhoneNumberId })

  const configuredPhoneNumberId = cleanString(await getAppConfig(CONFIG_KEYS.phoneNumberId))
  const shouldResetDefault = configuredPhoneNumberId === cleanPhoneNumberId || Number(phone.is_default_sender || 0) === 1

  await db.run('UPDATE contacts SET preferred_whatsapp_phone_number_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE preferred_whatsapp_phone_number_id = ?', [cleanPhoneNumberId])
  await db.run('UPDATE scheduled_chat_messages SET business_phone_number_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE business_phone_number_id = ?', [cleanPhoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [cleanPhoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [cleanPhoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_labels WHERE phone_number_id = ?', [cleanPhoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${cleanPhoneNumberId}`]).catch(() => undefined)
  const result = await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [cleanPhoneNumberId])

  if (shouldResetDefault) {
    const nextDefault = await db.get(`
      SELECT id, waba_id, phone_number, display_phone_number
      FROM whatsapp_api_phone_numbers
      ORDER BY is_default_sender DESC, updated_at DESC, phone_number ASC
      LIMIT 1
    `)

    if (nextDefault?.id) {
      await setDefaultSenderPhoneNumber(nextDefault.id)
      await setAppConfig(CONFIG_KEYS.senderPhone, nextDefault.phone_number || nextDefault.display_phone_number || '')
      await setAppConfig(CONFIG_KEYS.phoneNumberId, nextDefault.id || '')
      await setAppConfig(CONFIG_KEYS.wabaId, nextDefault.waba_id || '')
    } else {
      await setAppConfig(CONFIG_KEYS.senderPhone, '')
      await setAppConfig(CONFIG_KEYS.phoneNumberId, '')
      await setAppConfig(CONFIG_KEYS.wabaId, '')
    }
  }

  await setAppConfig(CONFIG_KEYS.lastSyncedAt, nowIso())
  await setAppConfig(CONFIG_KEYS.lastError, '')

  logger.info(`WhatsApp QR: número eliminado localmente: ${phone.phone_number || phone.display_phone_number || phone.id} (${phone.verified_name || 'sin nombre'})`)

  return {
    deleted: Number(result?.changes || 0),
    phoneNumberId: cleanPhoneNumberId
  }
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
  const officialName = cleanString(row.name)
  const displayName = cleanString(row.display_name) || officialName
  return {
    id: row.id,
    official_template_id: row.official_template_id,
    waba_id: row.waba_id,
    name: displayName,
    official_name: officialName,
    local_template_id: row.local_template_id || null,
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
    where.push('t.status = ?')
    params.push(cleanString(status).toUpperCase())
  }

  params.push(Math.max(1, Math.min(Number(limit) || 100, 200)))

  const rows = await db.all(`
    SELECT
      t.id,
      t.official_template_id,
      t.waba_id,
      t.name,
      COALESCE(NULLIF(mt.name, ''), t.name) AS display_name,
      mt.id AS local_template_id,
      mt.ycloud_template_name AS local_ycloud_template_name,
      t.language,
      t.category,
      t.sub_category,
      t.previous_category,
      t.message_send_ttl_seconds,
      t.status,
      t.quality_rating,
      t.reason,
      t.status_update_event,
      t.disable_date,
      t.components_json,
      t.ycloud_create_time,
      t.ycloud_update_time,
      t.created_at,
      t.updated_at
    FROM whatsapp_api_templates t
    LEFT JOIN whatsapp_message_templates mt
      ON mt.language = t.language
      AND (
        mt.ycloud_template_id = t.id
        OR mt.ycloud_template_id = t.official_template_id
        OR mt.ycloud_template_name = t.name
        OR mt.name = t.name
      )
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY
      CASE
        WHEN mt.id IS NOT NULL AND (
          t.name = mt.ycloud_template_name
          OR (COALESCE(mt.ycloud_template_name, '') = '' AND t.name = mt.name)
        ) THEN 0
        WHEN mt.id IS NOT NULL THEN 1
        ELSE 2
      END,
      CASE t.status
        WHEN 'APPROVED' THEN 0
        WHEN 'PENDING' THEN 1
        WHEN 'IN_APPEAL' THEN 2
        ELSE 3
      END,
      t.updated_at DESC,
      t.name ASC
    LIMIT ?
  `, params)

  const seen = new Set()
  const deduped = []
  for (const row of rows) {
    const key = row.local_template_id
      ? `local:${row.local_template_id}`
      : `remote:${row.waba_id}|${row.name}|${row.language}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(row)
  }

  return deduped.map(mapTemplateRow)
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
    countRows("SELECT COUNT(*) as total FROM whatsapp_api_messages WHERE direction IN ('outbound', 'business_echo')"),
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

// Contactos cuyo último evento de ruteo es una contingencia: si el número original ya volvió,
// se le ofrece al usuario regresarlos. Los cambiados manualmente después quedan fuera porque
// su último evento ya no es 'contingency'.
async function getPendingContingencyRestoreCounts() {
  const rows = await db.all(`
    SELECT e.previous_phone_number_id, COUNT(*) AS contact_count
    FROM whatsapp_routing_events e
    JOIN (
      SELECT contact_id, MAX(created_at) AS max_created
      FROM whatsapp_routing_events
      GROUP BY contact_id
    ) latest ON latest.contact_id = e.contact_id AND latest.max_created = e.created_at
    WHERE e.source = 'contingency'
      AND e.previous_phone_number_id IS NOT NULL
    GROUP BY e.previous_phone_number_id
  `).catch(() => [])

  const counts = new Map()
  for (const row of rows) {
    counts.set(cleanString(row.previous_phone_number_id), Number(row.contact_count) || 0)
  }
  return counts
}

export async function rerouteWhatsAppPhoneNumberContacts({ phoneNumberId, targetPhoneNumberId, reason } = {}) {
  const sourceId = cleanString(phoneNumberId)
  const targetId = cleanString(targetPhoneNumberId)
  if (!sourceId || !targetId) throw new Error('Faltan el número de origen y el número destino')
  if (sourceId === targetId) throw new Error('Elige un número distinto al que no está disponible')

  const target = await db.get('SELECT id FROM whatsapp_api_phone_numbers WHERE id = ?', [targetId])
  if (!target) throw new Error('Ese número destino no está conectado')

  // Contactos operando por el número caído: con preferencia explícita hacia él, o sin
  // preferencia pero cuyo último mensaje entrante llegó por él.
  const contacts = await db.all(`
    SELECT c.id, c.preferred_whatsapp_phone_number_id
    FROM contacts c
    WHERE c.preferred_whatsapp_phone_number_id = ?
       OR (
         COALESCE(c.preferred_whatsapp_phone_number_id, '') = ''
         AND (
           SELECT m.business_phone_number_id
           FROM whatsapp_api_messages m
           WHERE m.contact_id = c.id
             AND m.direction = 'inbound'
             AND m.business_phone_number_id IS NOT NULL
           ORDER BY COALESCE(m.message_timestamp, m.created_at) DESC
           LIMIT 1
         ) = ?
       )
  `, [sourceId, sourceId]).catch(() => [])

  const cleanReason = cleanString(reason) || 'Cambio temporal: el número original no está disponible'
  const automationEngine = contacts.length > 0
    ? await import('./automationEngine.js').catch(() => null)
    : null
  let moved = 0
  for (const contact of contacts) {
    const previousPhoneNumberId = cleanString(contact.preferred_whatsapp_phone_number_id) || sourceId
    await db.run(
      'UPDATE contacts SET preferred_whatsapp_phone_number_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [targetId, contact.id]
    )
    await db.run(`
      INSERT INTO whatsapp_routing_events (id, contact_id, previous_phone_number_id, new_phone_number_id, reason, source)
      VALUES (?, ?, ?, ?, ?, 'contingency')
    `, [
      crypto.randomUUID(),
      contact.id,
      previousPhoneNumberId,
      targetId,
      cleanReason
    ])
    automationEngine?.handleAutomationEvent?.('contact-updated', {
      contactId: contact.id,
      changedFields: ['preferredWhatsAppPhoneNumberId', 'preferred_whatsapp_phone_number_id'],
      previousPhoneNumberId,
      newPhoneNumberId: targetId,
      contactChangeSource: 'automation'
    }).catch(() => undefined)
    moved += 1
  }

  return { moved, from: sourceId, to: targetId }
}

export async function restoreWhatsAppPhoneNumberContacts({ phoneNumberId } = {}) {
  const sourceId = cleanString(phoneNumberId)
  if (!sourceId) throw new Error('Falta el número a restaurar')

  const rows = await db.all(`
    SELECT e.contact_id, e.previous_phone_number_id, e.new_phone_number_id
    FROM whatsapp_routing_events e
    JOIN (
      SELECT contact_id, MAX(created_at) AS max_created
      FROM whatsapp_routing_events
      GROUP BY contact_id
    ) latest ON latest.contact_id = e.contact_id AND latest.max_created = e.created_at
    WHERE e.source = 'contingency'
      AND e.previous_phone_number_id = ?
  `, [sourceId]).catch(() => [])

  let restored = 0
  const automationEngine = rows.length > 0
    ? await import('./automationEngine.js').catch(() => null)
    : null
  for (const row of rows) {
    const previousPhoneNumberId = cleanString(row.new_phone_number_id) || null
    await db.run(
      'UPDATE contacts SET preferred_whatsapp_phone_number_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [sourceId, row.contact_id]
    )
    await db.run(`
      INSERT INTO whatsapp_routing_events (id, contact_id, previous_phone_number_id, new_phone_number_id, reason, source)
      VALUES (?, ?, ?, ?, ?, 'restore')
    `, [
      crypto.randomUUID(),
      row.contact_id,
      previousPhoneNumberId,
      sourceId,
      'El número original volvió a estar disponible'
    ])
    automationEngine?.handleAutomationEvent?.('contact-updated', {
      contactId: row.contact_id,
      changedFields: ['preferredWhatsAppPhoneNumberId', 'preferred_whatsapp_phone_number_id'],
      previousPhoneNumberId,
      newPhoneNumberId: sourceId,
      contactChangeSource: 'automation'
    }).catch(() => undefined)
    restored += 1
  }

  return { restored, phoneNumberId: sourceId }
}

export async function getWhatsAppApiStatus() {
  const config = await clearStaleDisconnectedYCloudCredentials(await loadConfig())
  const metaDirect = await loadMetaDirectConfig()
  const [stats, phoneNumbers, balance, templates, alerts, qrSessions, qrDripSettings] = await Promise.all([
    getStats(),
    getPhoneNumbersFromDb(),
    getBalanceFromDb(),
    getTemplatesFromDb({ limit: 12 }),
    getActiveAlertsFromDb({ limit: 12 }),
    getWhatsAppQrSessions().catch(error => {
      logger.warn(`No se pudieron leer sesiones QR WhatsApp: ${error.message}`)
      return []
    }),
    getWhatsAppQrDripSettings().catch(error => {
      logger.warn(`No se pudo leer configuración anti-bloqueos QR: ${error.message}`)
      return { enabled: true, delaySeconds: 30, delayUnit: 'seconds', minDelaySeconds: 15, maxDelaySeconds: 600 }
    })
  ])

  const connected = Boolean(config.enabled && config.hasApiKey)
  const requiresPhoneSelection = false

  // Disponibilidad operativa por número: API oficial sana, respaldo QR listo, o nada.
  const phoneNumbersWithAvailability = await Promise.all(phoneNumbers.map(async (phone) => {
    const apiRestrictionReason = connected
      ? await getOfficialApiRestrictionReason({ phoneRow: phone, config }).catch(() => '')
      : 'WhatsApp API no está conectado.'
    const apiAvailable = connected && !apiRestrictionReason
    const qrReady = isQrFallbackReady(phone)
    return {
      ...phone,
      availability: {
        apiAvailable,
        apiReason: apiAvailable ? '' : (apiRestrictionReason || 'WhatsApp API no está conectado.'),
        qrReady,
        available: apiAvailable || qrReady
      }
    }
  }))

  const needsDefaultSelection = Boolean(
    connected &&
    phoneNumbersWithAvailability.length > 1 &&
    !phoneNumbersWithAvailability.some(phone => Number(phone.is_default_sender || 0) === 1)
  )

  const pendingRestoreCounts = await getPendingContingencyRestoreCounts().catch(() => new Map())
  const pendingRestores = phoneNumbersWithAvailability
    .filter(phone => (pendingRestoreCounts.get(phone.id) || 0) > 0 && phone.availability.apiAvailable)
    .map(phone => ({
      phoneNumberId: phone.id,
      phone: phone.phone_number || phone.display_phone_number || '',
      verifiedName: phone.verified_name || '',
      contactCount: pendingRestoreCounts.get(phone.id) || 0
    }))

  const selectedPhone = phoneNumbersWithAvailability.find(phone => phone.id === config.phoneNumberId) ||
    phoneNumbersWithAvailability.find(phone => phone.phone_number === config.senderPhone) ||
    phoneNumbersWithAvailability.find(phone => Number(phone.is_default_sender || 0) === 1) ||
    phoneNumbersWithAvailability[0] ||
    null
  const highestSeverity = alerts.reduce((highest, alert) => {
    return !highest || alertSeverityRank(alert.severity) > alertSeverityRank(highest) ? alert.severity : highest
  }, '')

  return {
    provider: PROVIDER_NAME,
    activeProvider: config.provider || PROVIDER_NAME,
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
    phoneNumbers: phoneNumbersWithAvailability,
    selectedPhone,
    needsDefaultSelection,
    pendingRestores,
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
      sessions: qrSessions,
      drip: qrDripSettings
    },
    metaDirect: {
      provider: metaDirect.provider,
      connected: metaDirect.connected,
      configured: metaDirect.configured,
      status: metaDirect.status,
      appId: metaDirect.appId,
      businessId: metaDirect.businessId,
      wabaId: metaDirect.wabaId,
      phoneNumberId: metaDirect.phoneNumberId,
      displayPhoneNumber: metaDirect.displayPhoneNumber,
      coexistenceEnabled: metaDirect.coexistenceEnabled,
      webhookMode: metaDirect.webhookMode,
      installerWebhookUrl: metaDirect.installerWebhookUrl,
      installerOAuthCallbackUrl: metaDirect.installerOAuthCallbackUrl,
      connectedAt: metaDirect.connectedAt,
      disconnectedAt: metaDirect.disconnectedAt,
      lastWebhookReceivedAt: metaDirect.lastWebhookReceivedAt,
      lastRelayReceivedAt: metaDirect.lastRelayReceivedAt,
      lastError: metaDirect.lastError,
      datasetId: metaDirect.datasetId,
      adAccountId: metaDirect.adAccountId,
      hasSystemUserToken: metaDirect.hasSystemUserToken
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

async function isCurrentYCloudConnection(apiKey) {
  const cleanApiKey = normalizeYCloudApiKeyInput(apiKey)
  if (!cleanApiKey) return false

  try {
    const config = await loadConfig({ includeSecrets: true })
    return Boolean(
      config.enabled &&
      config.provider === PROVIDER_NAME &&
      normalizeYCloudApiKeyInput(config.apiKey) === cleanApiKey
    )
  } catch (error) {
    logger.warn(`No se pudo verificar la conexión YCloud activa: ${error.message}`)
    return false
  }
}

async function runYCloudPostConnectionSync({ apiKey, businessPhoneHints = [], wabaIds = [], source = 'conexion' } = {}) {
  const cleanApiKey = normalizeYCloudApiKeyInput(apiKey)
  if (!cleanApiKey) return

  const cleanBusinessPhoneHints = [...new Set(businessPhoneHints.map(cleanString).filter(Boolean))]
  const cleanWabaIds = [...new Set(wabaIds.map(cleanString).filter(Boolean))]
  const stillConnected = () => isCurrentYCloudConnection(cleanApiKey)

  if (!await stillConnected()) return

  const ycloudContacts = await listYCloudContacts(cleanApiKey).catch(error => {
    logger.warn(`No se pudieron leer contactos de WhatsApp API en segundo plano (${source}): ${error.message}`)
    return []
  })

  if (ycloudContacts.length && await stillConnected()) {
    await syncYCloudContacts(ycloudContacts).catch(error => {
      logger.warn(`No se pudieron sincronizar contactos de WhatsApp API en segundo plano (${source}): ${error.message}`)
    })
  }

  if (!await stillConnected()) return

  await syncYCloudMessagesFromApi(cleanApiKey, {
    businessPhoneHints: cleanBusinessPhoneHints,
    wabaIds: cleanWabaIds
  }).catch(error => {
    logger.warn(`No se pudo sincronizar historial saliente desde YCloud en segundo plano (${source}): ${error.message}`)
  })

  if (!await stillConnected()) return

  await backfillStoredWhatsAppApiMessageEvents({
    businessPhoneHints: cleanBusinessPhoneHints
  }).catch(error => {
    logger.warn(`No se pudo recuperar historial guardado WhatsApp Business en segundo plano (${source}): ${error.message}`)
  })

  if (!await stillConnected()) return

  await repairWhatsAppApiContactIdentityFromMessages().catch(error => {
    logger.warn(`No se pudo reparar nombres/fechas de contactos WhatsApp API en segundo plano (${source}): ${error.message}`)
  })

  if (!await stillConnected()) return

  await backfillWhatsAppContactProfilePictures({
    limit: WHATSAPP_PROFILE_PICTURE_BACKFILL_DEFAULT_LIMIT,
    onlyMissing: true,
    scope: 'all_crm'
  }).catch(error => {
    logger.warn(`No se pudieron hidratar avatares de contactos WhatsApp en segundo plano (${source}): ${error.message}`)
  })
}

function scheduleYCloudPostConnectionSync(options = {}) {
  setTimeout(() => {
    runYCloudPostConnectionSync(options).catch(error => {
      logger.warn(`No se pudo completar la sincronización de WhatsApp API en segundo plano: ${error.message}`)
    })
  }, 0)
}

export async function connectWhatsAppApi({ apiKey, senderPhone, phoneNumberId, wabaId, webhookUrl } = {}) {
  const saved = await loadConfig({ includeSecrets: true })
  const submittedApiKey = normalizeYCloudApiKeyInput(apiKey)
  const canReuseSavedConnection = Boolean(saved.enabled && saved.hasApiKey)
  const cleanApiKey = submittedApiKey || (canReuseSavedConnection ? saved.apiKey : '')

  if (!submittedApiKey && saved.hasApiKey && !saved.enabled) {
    await clearYCloudConnectionConfig()
  }

  if (!cleanApiKey) {
    throw new Error('Pega la llave de WhatsApp API para conectar WhatsApp Business')
  }

  try {
    let webhookEndpoint = null
    let webhookSetupWarning = ''
    const [phoneNumbers, balance, templates] = await Promise.all([
      listYCloudPhoneNumbers(cleanApiKey),
      retrieveYCloudBalance(cleanApiKey).catch(error => {
        logger.warn(`No se pudo leer balance de WhatsApp API: ${error.message}`)
        return null
      }),
      listYCloudTemplates(cleanApiKey, { wabaId }).catch(error => {
        logger.warn(`No se pudieron leer plantillas de WhatsApp API: ${error.message}`)
        return []
      })
    ])
    const enrichedPhoneNumbers = await enrichPhoneNumbersWithProfiles(cleanApiKey, phoneNumbers)
    await syncPhoneNumbers(enrichedPhoneNumbers, { pruneMissing: true })
    if (balance) await syncBalance(balance)
    await syncTemplates(templates)

    const selectedPhone = pickPhoneNumber(enrichedPhoneNumbers, { senderPhone, phoneNumberId, wabaId })
    if (selectedPhone) {
      await syncPhoneNumbers([selectedPhone.raw || selectedPhone])
    }

    try {
      webhookEndpoint = await ensureWebhookEndpoint({
        apiKey: cleanApiKey,
        webhookUrl,
        webhookEndpointId: canReuseSavedConnection ? saved.webhookEndpointId : ''
      })
    } catch (error) {
      webhookSetupWarning = buildWebhookSetupWarning(error)
      logger.warn(`WhatsApp API conectado con webhook pendiente: ${error.message}`)
    }

    await setEncryptedConfig(CONFIG_KEYS.apiKey, cleanApiKey)
    await setAppConfig(CONFIG_KEYS.enabled, '1')
    await setAppConfig(CONFIG_KEYS.provider, PROVIDER_NAME)
    await setAppConfig(CONFIG_KEYS.webhookEndpointId, webhookEndpoint?.id || (canReuseSavedConnection ? saved.webhookEndpointId : '') || '')
    await setAppConfig(CONFIG_KEYS.webhookUrl, webhookEndpoint?.url || webhookUrl || (canReuseSavedConnection ? saved.webhookUrl : '') || '')
    await setAppConfig(CONFIG_KEYS.webhookStatus, webhookEndpoint ? (webhookEndpoint.status || 'active') : 'pending')
    await setAppConfig(CONFIG_KEYS.connectedAt, canReuseSavedConnection ? (saved.connectedAt || nowIso()) : nowIso())
    await setAppConfig(CONFIG_KEYS.lastSyncedAt, nowIso())
    await setAppConfig(CONFIG_KEYS.lastError, webhookSetupWarning)

    if (webhookEndpoint?.secret) {
      await setEncryptedConfig(CONFIG_KEYS.webhookSecret, webhookEndpoint.secret)
    }

    if (selectedPhone?.phoneNumber) {
      await setAppConfig(CONFIG_KEYS.senderPhone, selectedPhone.phoneNumber)
      await setAppConfig(CONFIG_KEYS.phoneNumberId, selectedPhone.id || '')
      await setAppConfig(CONFIG_KEYS.wabaId, selectedPhone.wabaId || '')
      await setDefaultSenderPhoneNumber(selectedPhone.id)
    }

    const businessPhoneHints = [
      selectedPhone?.phoneNumber,
      selectedPhone?.displayPhoneNumber,
      senderPhone,
      ...enrichedPhoneNumbers.flatMap(item => [item.phoneNumber, item.displayPhoneNumber])
    ].filter(Boolean)
    const wabaIds = [
      selectedPhone?.wabaId,
      wabaId,
      ...enrichedPhoneNumbers.map(item => item.wabaId)
    ].filter(Boolean)

    scheduleYCloudPostConnectionSync({
      apiKey: cleanApiKey,
      businessPhoneHints,
      wabaIds,
      source: 'conexion'
    })

    return getWhatsAppApiStatus()
  } catch (error) {
    await setAppConfig(CONFIG_KEYS.lastError, error.message)
    throw error
  }
}

export async function refreshWhatsAppApi() {
  const config = await loadConfig({ includeSecrets: true })
  if (!config.enabled && config.hasApiKey) {
    await clearYCloudConnectionConfig()
  }
  if (!config.enabled || !config.apiKey) {
    throw new Error('WhatsApp_API no está conectado')
  }

  try {
    let webhookSetupWarning = ''
    const [phoneNumbers, balance, templates] = await Promise.all([
      listYCloudPhoneNumbers(config.apiKey),
      retrieveYCloudBalance(config.apiKey).catch(error => {
        logger.warn(`No se pudo actualizar balance de WhatsApp API: ${error.message}`)
        return null
      }),
      listYCloudTemplates(config.apiKey, { wabaId: config.wabaId }).catch(error => {
        logger.warn(`No se pudieron actualizar plantillas de WhatsApp API: ${error.message}`)
        return []
      })
    ])
    const enrichedPhoneNumbers = await enrichPhoneNumbersWithProfiles(config.apiKey, phoneNumbers)
    await syncPhoneNumbers(enrichedPhoneNumbers, { pruneMissing: true })
    if (config.phoneNumberId) {
      await setDefaultSenderPhoneNumber(config.phoneNumberId)
    }
    if (balance) await syncBalance(balance)
    await syncTemplates(templates)

    const businessPhoneHints = [
      config.senderPhone,
      ...enrichedPhoneNumbers.flatMap(item => [item.phoneNumber, item.displayPhoneNumber])
    ].filter(Boolean)
    const wabaIds = [
      config.wabaId,
      ...enrichedPhoneNumbers.map(item => item.wabaId)
    ].filter(Boolean)

    if (config.webhookEndpointId || config.webhookUrl) {
      try {
        await refreshYCloudWebhookEndpoint(config)
      } catch (error) {
        webhookSetupWarning = buildWebhookSetupWarning(error)
        await setAppConfig(CONFIG_KEYS.webhookStatus, 'pending')
        await setAppConfig(CONFIG_KEYS.lastError, webhookSetupWarning)
      }
    }

    await setAppConfig(CONFIG_KEYS.lastSyncedAt, nowIso())
    await setAppConfig(CONFIG_KEYS.lastError, webhookSetupWarning)
    scheduleYCloudPostConnectionSync({
      apiKey: config.apiKey,
      businessPhoneHints,
      wabaIds,
      source: 'actualizacion'
    })
    return getWhatsAppApiStatus()
  } catch (error) {
    await setAppConfig(CONFIG_KEYS.lastError, error.message)
    throw error
  }
}

export async function previewWhatsAppApiPhoneNumbers({ apiKey } = {}) {
  const saved = await loadConfig({ includeSecrets: true })
  const submittedApiKey = normalizeYCloudApiKeyInput(apiKey)
  const cleanApiKey = submittedApiKey || (saved.enabled ? saved.apiKey : '')

  if (!submittedApiKey && saved.hasApiKey && !saved.enabled) {
    await clearYCloudConnectionConfig()
  }

  if (!cleanApiKey) {
    throw new Error('Pega la llave de WhatsApp API para buscar tus números')
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
  await setAppConfig(CONFIG_KEYS.lastError, '')
  await clearYCloudConnectionConfig()
  return getWhatsAppApiStatus()
}

export async function resetWhatsAppApiCredentials() {
  return disconnectWhatsAppApi()
}

function normalizeDisplayText(value) {
  const text = cleanString(value).replace(/\s+/g, ' ')
  if (!text || text === 'null' || text === 'undefined') return ''
  return text
}

function shouldReplaceContactName(currentName, phone = '') {
  return shouldReplaceWhatsAppApiContactName(currentName, phone)
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeMessageTextObject(value) {
  if (typeof value === 'string') return { body: value }
  return isPlainObject(value) ? value : null
}

function appendReadableMessagePart(parts, value) {
  if (value && typeof value === 'object') return
  const text = cleanString(value)
  if (text && text !== 'null' && text !== 'undefined' && !parts.includes(text)) parts.push(text)
}

function cleanStructuredPrimitive(value) {
  return value && typeof value === 'object' ? '' : cleanString(value)
}

function readStructuredMessageText(value, keys = []) {
  if (typeof value === 'string' || typeof value === 'number') return cleanString(value)
  if (!isPlainObject(value)) return ''

  for (const key of keys) {
    const direct = cleanStructuredPrimitive(value[key])
    if (direct) return direct
  }

  for (const key of ['text', 'body', 'displayText', 'display_text', 'title', 'caption', 'contentText']) {
    const candidate = value[key]
    if (!candidate) continue
    const direct = cleanStructuredPrimitive(candidate)
    if (direct) return direct
    const nested = readStructuredMessageText(candidate, keys)
    if (nested) return nested
  }

  return ''
}

function parseStructuredButtonParams(button = {}) {
  const value = button.buttonParamsJson || button.paramsJson || button.button_params_json
  if (!value) return null
  return parseJsonValue(value, null)
}

function getStructuredButtonLabel(button = {}) {
  const params = parseStructuredButtonParams(button)
  const paramsLabel = readStructuredMessageText(params, [
    'display_text',
    'displayText',
    'cta_display_name',
    'text',
    'title',
    'label'
  ])
  if (paramsLabel) return paramsLabel

  for (const key of ['reply', 'buttonText', 'quickReplyButton', 'urlButton', 'callButton', 'copyCodeButton']) {
    const label = readStructuredMessageText(button[key], [
      'displayText',
      'display_text',
      'text',
      'title',
      'label'
    ])
    if (label) return label
  }

  return readStructuredMessageText(button, [
    'displayText',
    'display_text',
    'text',
    'title',
    'label'
  ])
}

function formatStructuredMessage(parts = [], buttons = []) {
  const bodyParts = []
  for (const part of parts) appendReadableMessagePart(bodyParts, part)

  const actionLines = buttons
    .map(getStructuredButtonLabel)
    .filter(Boolean)
    .map(label => `- ${label}`)

  return [...bodyParts, ...(actionLines.length ? [actionLines.join('\n')] : [])].join('\n\n')
}

function extractInteractiveMessageText(interactive = {}) {
  if (!isPlainObject(interactive)) return ''
  const parts = [
    readStructuredMessageText(interactive.header, ['title', 'subtitle', 'text']),
    readStructuredMessageText(interactive.body, ['text', 'body']),
    readStructuredMessageText(interactive.footer, ['text', 'footer'])
  ]
  const buttons = [
    ...(Array.isArray(interactive.action?.buttons) ? interactive.action.buttons : []),
    ...(Array.isArray(interactive.nativeFlowMessage?.buttons) ? interactive.nativeFlowMessage.buttons : [])
  ]
  return formatStructuredMessage(parts, buttons)
}

function extractTemplateMessageText(template = {}) {
  if (!isPlainObject(template)) return ''
  const parts = [
    readStructuredMessageText(template.header, ['text', 'title']),
    readStructuredMessageText(template.body, ['text', 'body']),
    readStructuredMessageText(template.footer, ['text', 'footer']),
    readStructuredMessageText(template, ['text', 'body', 'contentText'])
  ]
  const buttons = []

  const components = Array.isArray(template.components) ? template.components : []
  for (const component of components) {
    const type = cleanString(component?.type).toLowerCase()
    if (type === 'header' || type === 'body' || type === 'footer') {
      appendReadableMessagePart(parts, readStructuredMessageText(component, ['text', 'body']))
    }
    if (type === 'button' || type === 'buttons') {
      if (Array.isArray(component.buttons)) buttons.push(...component.buttons)
      else buttons.push(component)
    }
  }

  if (Array.isArray(template.buttons)) buttons.push(...template.buttons)
  return formatStructuredMessage(parts, buttons)
}

function extractMessageText(message = {}) {
  const text = normalizeMessageTextObject(message.text)
  const interactiveText = extractInteractiveMessageText(message.interactive)
  const templateText = extractTemplateMessageText(message.template)

  return cleanString(
    text?.body ||
    message.button?.text ||
    message.interactive?.button_reply?.title ||
    message.interactive?.list_reply?.title ||
    message.interactive?.nfm_reply?.body ||
    interactiveText ||
    message.image?.caption ||
    message.video?.caption ||
    message.document?.caption ||
    templateText ||
    message.template?.name ||
    message.location?.name ||
    message.location?.address ||
    (cleanString(message.type).toLowerCase() === 'location' ? 'Ubicación' : '') ||
    message.reaction?.emoji ||
    ''
  )
}

function normalizeWhatsAppLocation({ latitude, longitude, name, address } = {}) {
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

function buildWhatsAppLocationText(location = {}) {
  return cleanString(location.name || location.address) || 'Ubicación'
}

async function resolveWhatsAppMessageReference({ messageId, providerMessageId, contactId } = {}) {
  const cleanMessageId = cleanString(messageId)
  const cleanProviderMessageId = cleanString(providerMessageId)
  const cleanContactId = cleanString(contactId)
  if (!cleanMessageId && !cleanProviderMessageId) return null

  const row = await db.get(`
    SELECT id, ycloud_message_id, meta_message_id, wamid, direction, message_type, message_text, context_json, raw_payload_json
    FROM whatsapp_api_messages
    WHERE (
        (? != '' AND id = ?)
        OR (? != '' AND ycloud_message_id = ?)
        OR (? != '' AND meta_message_id = ?)
        OR (? != '' AND wamid = ?)
      )
      AND (? = '' OR contact_id = ?)
    ORDER BY updated_at DESC
    LIMIT 1
  `, [
    cleanMessageId, cleanMessageId,
    cleanProviderMessageId, cleanProviderMessageId,
    cleanProviderMessageId, cleanProviderMessageId,
    cleanProviderMessageId, cleanProviderMessageId,
    cleanContactId, cleanContactId
  ]).catch(() => null)

  const providerId = cleanString(row?.wamid || row?.ycloud_message_id || row?.meta_message_id || cleanProviderMessageId)
  if (!providerId) return null
  return {
    localMessageId: cleanString(row?.id),
    providerMessageId: providerId,
    messageType: cleanString(row?.message_type),
    text: cleanString(row?.message_text)
  }
}

export async function markLatestInboundWhatsAppApiMessageReadForContact({ contactId } = {}) {
  const cleanContactId = cleanString(contactId)
  if (!cleanContactId) {
    return { attempted: false, reason: 'missing_contact' }
  }

  const config = await loadConfig({ includeSecrets: true })
  const provider = cleanString(config.provider || PROVIDER_NAME).toLowerCase()
  if (!config.enabled || !config.apiKey || provider !== PROVIDER_NAME) {
    return { attempted: false, reason: 'ycloud_not_connected' }
  }

  const row = await db.get(`
    SELECT id, ycloud_message_id, wamid, status
    FROM whatsapp_api_messages
    WHERE contact_id = ?
      AND LOWER(COALESCE(direction, '')) = 'inbound'
      AND LOWER(COALESCE(transport, 'api')) != 'qr'
      AND LOWER(COALESCE(status, '')) NOT IN ('read', 'failed')
    ORDER BY COALESCE(message_timestamp, updated_at, created_at) DESC
    LIMIT 1
  `, [cleanContactId]).catch(() => null)

  const providerMessageId = cleanString(row?.wamid || row?.ycloud_message_id || row?.id)
  if (!providerMessageId) {
    return { attempted: false, reason: 'no_unread_inbound_message' }
  }

  await ycloudRequest(`/whatsapp/inboundMessages/${encodeURIComponent(providerMessageId)}/markAsRead`, {
    apiKey: config.apiKey,
    method: 'POST'
  })

  await db.run(`
    UPDATE whatsapp_api_messages
    SET status = 'read',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [row.id]).catch(() => undefined)

  return {
    attempted: true,
    provider: PROVIDER_NAME,
    messageId: row.id,
    providerMessageId
  }
}

async function resolveWhatsAppReplyContext({ replyToMessageId, replyToProviderMessageId, contactId } = {}) {
  const reference = await resolveWhatsAppMessageReference({
    messageId: replyToMessageId,
    providerMessageId: replyToProviderMessageId,
    contactId
  })
  if (!reference?.providerMessageId) return null
  return {
    message_id: reference.providerMessageId
  }
}

function extractButtonReply(message = {}) {
  const messageType = cleanString(message.type).toLowerCase()
  const interactiveType = cleanString(message.interactive?.type).toLowerCase()
  const buttonReply = message.interactive?.button_reply
  if (buttonReply) {
    const id = cleanString(buttonReply.id)
    const title = cleanString(buttonReply.title)
    return {
      id: id || title,
      payload: id || title,
      title,
      type: interactiveType || 'button_reply'
    }
  }

  const listReply = message.interactive?.list_reply
  if (listReply) {
    const id = cleanString(listReply.id)
    const title = cleanString(listReply.title)
    return {
      id: id || title,
      payload: id || title,
      title,
      type: interactiveType || 'list_reply'
    }
  }

  if (messageType === 'button' || message.button) {
    const payload = cleanString(message.button?.payload || message.button?.id)
    const title = cleanString(message.button?.text || message.button?.title)
    return {
      id: payload || title,
      payload: payload || title,
      title,
      type: 'template_button'
    }
  }

  return null
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
      mediaDurationMs: null,
      mediaIsVoice: false
    }
  }

  const durationMs = Number(media.durationMs || media.duration_ms || media.durationMillis || media.duration_millis || 0)
  const durationSeconds = Number(media.durationSeconds || media.duration_seconds || 0)
  const ambiguousDuration = Number(media.duration || 0)

  return {
    mediaUrl: cleanString(
      media.mediaUrl ||
      media.media_url ||
      media.publicUrl ||
      media.public_url ||
      media.downloadUrl ||
      media.download_url ||
      media.fileUrl ||
      media.file_url ||
      media.audioUrl ||
      media.audio_url ||
      media.imageUrl ||
      media.image_url ||
      media.videoUrl ||
      media.video_url ||
      media.link ||
      media.url ||
      media.href
    ),
    mediaMimeType: cleanString(media.mimeType || media.mime_type || media.mimetype || media.contentType || media.content_type),
    mediaFilename: cleanString(media.filename || media.fileName || media.file_name || media.originalFilename || media.original_filename || media.name),
    mediaDurationMs: durationMs > 0
      ? Math.round(durationMs)
      : durationSeconds > 0
        ? Math.round(durationSeconds * 1000)
        : ambiguousDuration > 0
          ? Math.round(ambiguousDuration <= 3600 ? ambiguousDuration * 1000 : ambiguousDuration)
          : null,
    mediaIsVoice: Boolean(media.voice || media.isVoice || media.is_voice || media.ptt)
  }
}

function getMessageMediaObject(message = {}) {
  const messageType = cleanString(message.type).toLowerCase()
  const candidates = [
    messageType ? message[messageType] : null,
    message.audio,
    message.image,
    message.video,
    message.document,
    message.sticker,
    message.media,
    message.file
  ].filter(isPlainObject)
  return candidates[0] || null
}

function getMessageMediaId(message = {}) {
  const media = getMessageMediaObject(message)
  return cleanString(
    media?.id ||
    media?.mediaId ||
    media?.media_id ||
    media?.assetId ||
    media?.asset_id ||
    media?.fileId ||
    media?.file_id
  )
}

const QR_MEDIA_MESSAGE_TYPES = new Set(['image', 'video', 'audio', 'voice', 'document', 'sticker'])
const OUTBOUND_API_MEDIA_QR_ECHO_TYPES = new Set(['image', 'video', 'audio', 'voice', 'document', 'sticker'])
const QR_MEDIA_FINGERPRINT_KEYS = new Set(['filesha256', 'fileencsha256', 'sha256'])

function recentMessageWindowExpressions() {
  return {
    lowerBoundExpr: isPostgres() ? "(?::timestamp - INTERVAL '2 minutes')" : "datetime(?, '-2 minutes')",
    upperBoundExpr: isPostgres() ? "(?::timestamp + INTERVAL '2 minutes')" : "datetime(?, '+2 minutes')",
    messageTimeExpr: isPostgres()
      ? 'COALESCE(message_timestamp, created_at)::timestamp'
      : 'datetime(COALESCE(message_timestamp, created_at))'
  }
}

function storedMessageLooksFailed(row = {}) {
  const status = normalizeMessageDeliveryStatus(row.status)
  const hasError = Boolean(cleanString(row.error_code || row.error_message))
  return ['failed', 'error', 'undelivered', 'rejected', 'cancelled'].includes(status) || hasError
}

async function handleRecentQrEchoDuplicate({
  duplicate,
  cleanDirection,
  cleanWamid,
  raw,
  messageType,
  messageTimestamp
} = {}) {
  const duplicateTransport = cleanString(duplicate?.transport).toLowerCase()
  if (cleanDirection === 'outbound' && duplicateTransport !== 'qr' && storedMessageLooksFailed(duplicate)) {
    await db.run(`
      UPDATE whatsapp_api_messages
      SET transport = 'qr',
          routing_reason = ?,
          status = 'sent',
          error_code = NULL,
          error_message = NULL,
          wamid = COALESCE(NULLIF(?, ''), wamid),
          raw_payload_json = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      'Capturado desde la sesión de WhatsApp Web.',
      cleanWamid,
      safeJson({
        fallbackFrom: 'api',
        fallbackTransport: 'qr',
        qrEcho: true,
        clearedApiError: {
          code: cleanString(duplicate.error_code) || null,
          message: cleanString(duplicate.error_message) || null
        },
        whatsappMessage: {
          id: cleanWamid,
          status: 'sent',
          transport: 'qr'
        },
        ...(raw ? { raw } : {})
      }),
      duplicate.id
    ])

    publishChatMessageEvent({
      contactId: duplicate.contact_id,
      messageId: duplicate.id,
      channel: 'whatsapp',
      provider: PROVIDER_NAME,
      transport: 'qr',
      direction: duplicate.direction || cleanDirection,
      messageType: cleanString(duplicate.message_type || messageType) || messageType,
      messageTimestamp: duplicate.message_timestamp || duplicate.created_at || messageTimestamp,
      isNew: false
    })

    return {
      skipped: false,
      repaired: true,
      reason: 'duplicate_failed_api_repaired',
      messageId: duplicate.id,
      contactId: duplicate.contact_id,
      transport: 'qr',
      status: 'sent'
    }
  }

  return { skipped: true, reason: 'duplicate_recent', messageId: duplicate?.id }
}

function collectQrMediaFingerprints(value, fingerprints = new Set(), depth = 0) {
  if (value == null || depth > 12) return fingerprints

  if (typeof value === 'string') {
    const cleanValue = value.trim()
    if ((cleanValue.startsWith('{') && cleanValue.endsWith('}')) || (cleanValue.startsWith('[') && cleanValue.endsWith(']'))) {
      try {
        collectQrMediaFingerprints(JSON.parse(cleanValue), fingerprints, depth + 1)
      } catch {
        // El raw de proveedores puede traer strings que parecen JSON sin serlo.
      }
    }
    return fingerprints
  }

  if (Array.isArray(value)) {
    for (const item of value) collectQrMediaFingerprints(item, fingerprints, depth + 1)
    return fingerprints
  }

  if (!isPlainObject(value)) return fingerprints

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = cleanString(key).toLowerCase()
    if (QR_MEDIA_FINGERPRINT_KEYS.has(normalizedKey) && typeof child === 'string') {
      const fingerprint = cleanString(child)
      if (fingerprint) fingerprints.add(fingerprint)
    }
    collectQrMediaFingerprints(child, fingerprints, depth + 1)
  }

  return fingerprints
}

function qrMediaFingerprints(value) {
  return collectQrMediaFingerprints(value)
}

function sharesQrMediaFingerprint(left, right) {
  if (!left?.size || !right?.size) return false
  for (const fingerprint of left) {
    if (right.has(fingerprint)) return true
  }
  return false
}

async function findRecentOutboundMediaDuplicate({
  cleanContactPhone,
  cleanDirection,
  cleanMessageType,
  cleanWamid,
  messageTimestamp,
  raw
} = {}) {
  if (cleanDirection !== 'outbound') return null
  if (!OUTBOUND_API_MEDIA_QR_ECHO_TYPES.has(cleanMessageType)) return null

  const {
    lowerBoundExpr,
    upperBoundExpr,
    messageTimeExpr
  } = recentMessageWindowExpressions()

  const candidates = await db.all(`
    SELECT
      id,
      contact_id,
      status,
      transport,
      routing_reason,
      error_code,
      error_message,
      direction,
      message_type,
      message_timestamp,
      created_at,
      raw_payload_json
    FROM whatsapp_api_messages
    WHERE phone = ?
      AND direction = ?
      AND LOWER(COALESCE(message_type, '')) = ?
      AND COALESCE(message_text, '') = ''
      AND COALESCE(wamid, '') != ?
      AND ${messageTimeExpr} BETWEEN ${lowerBoundExpr} AND ${upperBoundExpr}
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 8
  `, [cleanContactPhone, cleanDirection, cleanMessageType, cleanWamid, messageTimestamp, messageTimestamp]).catch(() => [])

  if (!candidates?.length) return null

  // Para ecos de un envío QR directo no basta "mismo tipo + mismo minuto": el
  // operador puede mandar dos fotos seguidas sin caption. Baileys sí entrega la
  // huella criptográfica del archivo en ambos eventos, aunque use WAMID distintos.
  // La usamos para reconciliar exactamente la misma media sin comernos otra foto.
  const incomingFingerprints = qrMediaFingerprints(raw)
  if (incomingFingerprints.size) {
    const exactMediaMatch = candidates.find(candidate => sharesQrMediaFingerprint(
      incomingFingerprints,
      qrMediaFingerprints(candidate.raw_payload_json)
    ))
    if (exactMediaMatch) return exactMediaMatch
  }

  // La API oficial no siempre expone la huella que devuelve el eco de WhatsApp
  // Web. Conservamos el dedupe previo para esa ruta, pero no lo aplicamos a filas
  // QR sin fingerprint porque podría ocultar una segunda foto real.
  return candidates.find(candidate => cleanString(candidate.transport).toLowerCase() !== 'qr') || null
}

function rememberOfficialApiOutboundForQrEcho({ phoneNumberId, toPhone, type, text = '' } = {}) {
  rememberRistakQrOutboundAttempt({
    phoneId: phoneNumberId,
    contactPhone: toPhone,
    type,
    text
  })
}

// Traduce el tipo de mensaje a la clave que `extractMessageMedia` sabe leer en el objeto
// del mensaje (message.image / message.audio / etc.).
function normalizeQrMediaKey(messageType = '') {
  const type = cleanString(messageType).toLowerCase()
  if (type === 'voice') return 'audio'
  if (QR_MEDIA_MESSAGE_TYPES.has(type)) return type
  return 'media'
}

export function getInboundMediaLimitBytes(messageType = '') {
  const type = cleanString(messageType).toLowerCase()
  if (type === 'audio' || type === 'voice') return MAX_WHATSAPP_AUDIO_BYTES
  if (type === 'image' || type === 'sticker') return MAX_WHATSAPP_IMAGE_INPUT_BYTES
  if (type === 'document') return MAX_WHATSAPP_DOCUMENT_BYTES
  if (type === 'video') return Number(process.env.WHATSAPP_INBOUND_VIDEO_MAX_BYTES || 64 * 1024 * 1024)
  return MAX_WHATSAPP_DOCUMENT_BYTES
}

export function getInboundMediaExtension({ messageType = '', mimeType = '', filename = '' } = {}) {
  const cleanMime = cleanMimeType(mimeType)
  const currentExtension = cleanString(filename).toLowerCase().split('.').pop()
  if (/^[a-z0-9]{2,8}$/.test(currentExtension)) return currentExtension

  const type = cleanString(messageType).toLowerCase()
  if (type === 'audio' || type === 'voice') return AUDIO_EXTENSION_BY_MIME[cleanMime] || 'ogg'
  if (type === 'image' || type === 'sticker') return IMAGE_EXTENSION_BY_MIME[cleanMime] || 'jpg'
  if (type === 'document') return DOCUMENT_EXTENSION_BY_MIME[cleanMime] || 'bin'
  if (type === 'video') return VIDEO_EXTENSION_BY_MIME[cleanMime] || 'mp4'
  return DOCUMENT_EXTENSION_BY_MIME[cleanMime] || 'bin'
}

function buildInboundMediaFilename({ mediaId = '', messageType = '', mimeType = '', filename = '' } = {}) {
  const provided = cleanString(filename).split(/[\\/]/).pop()
  if (provided && /\.[a-z0-9]{2,8}$/i.test(provided)) return provided.slice(0, 180)

  const type = cleanString(messageType).toLowerCase() || 'media'
  const extension = getInboundMediaExtension({ messageType: type, mimeType, filename })
  const suffix = cleanString(mediaId).slice(-10) || Date.now()
  return `whatsapp-${type}-${suffix}.${extension}`
}

async function downloadMetaDirectInboundMedia({ mediaId, token, phoneNumberId = '', messageType = '', mimeType = '', filename = '' } = {}) {
  const cleanMediaId = cleanString(mediaId)
  if (!cleanMediaId) return null
  const cleanMessageType = cleanString(messageType).toLowerCase()
  const maxBytes = getInboundMediaLimitBytes(cleanMessageType)

  const mediaInfo = await metaDirectGraphRequest(`/${encodeURIComponent(cleanMediaId)}`, {
    token,
    query: {
      fields: 'url,mime_type,file_size',
      ...(phoneNumberId ? { phone_number_id: phoneNumberId } : {})
    }
  })
  const mediaUrl = cleanString(mediaInfo.url)
  if (!mediaUrl) throw new Error('Meta no devolvió URL para el archivo recibido')

  const declaredSize = Number(mediaInfo.file_size || 0)
  if (declaredSize > maxBytes) {
    throw new Error('El archivo recibido excede el tamaño máximo permitido')
  }

  const response = await nodeFetch(mediaUrl, {
    headers: { Authorization: `Bearer ${cleanString(token)}` }
  })
  if (!response.ok) {
    throw new Error(`Meta no permitió descargar el archivo recibido (${response.status})`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (!buffer.length) throw new Error('Meta devolvió un archivo vacío')
  if (buffer.length > maxBytes) throw new Error('El archivo recibido excede el tamaño máximo permitido')

  const responseMimeType = cleanString(response.headers.get('content-type')).split(';')[0]
  const fallbackMimeType = cleanMessageType === 'audio' || cleanMessageType === 'voice'
    ? 'audio/ogg'
    : cleanMessageType === 'image' || cleanMessageType === 'sticker'
      ? 'image/jpeg'
      : cleanMessageType === 'video'
        ? 'video/mp4'
        : 'application/octet-stream'
  const finalMimeType = cleanMimeType(mediaInfo.mime_type || responseMimeType || mimeType || fallbackMimeType)
  const finalFilename = buildInboundMediaFilename({
    mediaId: cleanMediaId,
    messageType: cleanMessageType,
    mimeType: finalMimeType,
    filename
  })
  const { uploadMediaAsset } = await import('./mediaStorageService.js')
  const asset = await uploadMediaAsset({
    buffer,
    mimeType: finalMimeType,
    filename: finalFilename,
    module: 'chat',
    isPublic: true,
    skipCompression: true,
    metadata: {
      source: 'meta_direct_inbound_media',
      whatsappMediaId: cleanMediaId,
      whatsappMessageType: cleanMessageType,
      phoneNumberId: cleanString(phoneNumberId)
    }
  })

  return {
    mediaUrl: asset.publicUrl,
    mediaMimeType: asset.mimeType || finalMimeType,
    mediaFilename: asset.originalFilename || asset.storedFilename || finalFilename,
    mediaAssetId: asset.id
  }
}

async function hydrateInboundMessageMedia(normalizedMessage = {}, media = {}, { businessPhoneNumberId = '' } = {}) {
  if (media.mediaUrl) return media
  const messageType = cleanString(normalizedMessage.type).toLowerCase()
  if (!['audio', 'voice', 'image', 'video', 'document', 'sticker'].includes(messageType)) return media
  if (cleanString(normalizedMessage.provider) !== META_DIRECT_PROVIDER_NAME) return media

  const mediaId = getMessageMediaId(normalizedMessage)
  if (!mediaId) return media

  try {
    const config = await loadMetaDirectConfig({ includeSecrets: true })
    const downloaded = await downloadMetaDirectInboundMedia({
      mediaId,
      token: config.systemUserToken,
      phoneNumberId: cleanString(normalizedMessage.phoneNumberId || businessPhoneNumberId || config.phoneNumberId),
      messageType,
      mimeType: media.mediaMimeType,
      filename: media.mediaFilename
    })
    if (!downloaded?.mediaUrl) return media

    const mediaKey = messageType === 'voice' ? 'audio' : messageType
    const currentMedia = isPlainObject(normalizedMessage[mediaKey]) ? normalizedMessage[mediaKey] : {}
    normalizedMessage[mediaKey] = {
      ...currentMedia,
      id: mediaId,
      link: downloaded.mediaUrl,
      url: downloaded.mediaUrl,
      publicUrl: downloaded.mediaUrl,
      mimeType: downloaded.mediaMimeType,
      filename: downloaded.mediaFilename,
      mediaAssetId: downloaded.mediaAssetId
    }

    return {
      ...media,
      mediaUrl: downloaded.mediaUrl,
      mediaMimeType: media.mediaMimeType || downloaded.mediaMimeType,
      mediaFilename: media.mediaFilename || downloaded.mediaFilename
    }
  } catch (error) {
    logger.warn(`[Meta directo] No se pudo preparar media entrante ${mediaId}: ${error.message}`)
    return media
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
  const referralSourceId = cleanString(referral.source_id || referral.sourceId || referral.ad_id || referral.adId)

  const attribution = {
    ctwaClid: cleanString(referral.ctwa_clid || referral.ctwaClid || referral.ctwa || detected.ctwaClid),
    sourceId: cleanString(referralSourceId || detected.sourceId),
    officialSourceId: cleanString(referralSourceId || detected.officialSourceId),
    ristakAdId: cleanString(detected.ristakAdId),
    sourceIdSource: cleanString(referralSourceId || detected.officialSourceId) ? 'official_source_id' : cleanString(detected.sourceIdSource),
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
    hasAttribution: Boolean(
      attribution.ctwaClid ||
      attribution.sourceId ||
      attribution.sourceUrl ||
      attribution.sourceType ||
      attribution.sourceApp ||
      attribution.entryPoint ||
      attribution.headline ||
      attribution.body ||
      attribution.imageUrl ||
      attribution.videoUrl ||
      attribution.thumbnailUrl ||
      attribution.conversionData ||
      attribution.ctwaPayload
    ) ||
      Boolean(referral && Object.keys(referral).length)
  }
}

function sourceTypeLooksLikeAd(value = '') {
  const normalized = cleanString(value).toLowerCase().replace(/[\s-]+/g, '_')
  return ['ad', 'ads', 'advertisement', 'click_to_whatsapp', 'ctwa'].includes(normalized)
}

function hasWhatsAppAdAttributionSignal(attribution = {}) {
  return Boolean(
    attribution.sourceId &&
    (
      attribution.ctwaClid ||
      sourceTypeLooksLikeAd(attribution.sourceType) ||
      attribution.sourceUrl ||
      attribution.headline
    )
  )
}

async function getWhatsAppAttributionBusinessDate(messageTimestamp = '') {
  const timezone = await getAccountTimezone().catch(() => DEFAULT_TIMEZONE)
  return normalizeDateOnlyInTimezone(
    messageTimestamp || nowIso(),
    timezone,
    businessTodayDateOnly(timezone)
  )
}

async function hasMetaAdOnBusinessDate(adId = '', businessDate = '') {
  const cleanAdId = cleanString(adId)
  const cleanDate = cleanString(businessDate)
  if (!cleanAdId || !cleanDate) return false

  const row = await db.get(
    'SELECT 1 AS found FROM meta_ads WHERE ad_id = ? AND date = ? LIMIT 1',
    [cleanAdId, cleanDate]
  ).catch(() => null)
  return Boolean(row?.found)
}

async function resolveWhatsAppAttributionSourceId(attribution = {}, messageTimestamp = '') {
  const officialSourceId = cleanString(attribution.officialSourceId)
  const ristakAdId = cleanString(attribution.ristakAdId)
  const defaultSourceId = cleanString(attribution.sourceId || officialSourceId || ristakAdId)

  if (!defaultSourceId) return attribution

  if (!officialSourceId || !ristakAdId || officialSourceId === ristakAdId) {
    return {
      ...attribution,
      sourceId: defaultSourceId,
      sourceIdSource: defaultSourceId === ristakAdId && !officialSourceId ? 'rstkad_id' : (attribution.sourceIdSource || 'official_source_id'),
      sourceType: defaultSourceId === ristakAdId && !attribution.sourceType ? 'ad' : attribution.sourceType
    }
  }

  const businessDate = await getWhatsAppAttributionBusinessDate(messageTimestamp)
  const [officialMatchedMetaAds, ristakMatchedMetaAds] = await Promise.all([
    hasMetaAdOnBusinessDate(officialSourceId, businessDate),
    hasMetaAdOnBusinessDate(ristakAdId, businessDate)
  ])

  let sourceId = officialSourceId
  let sourceIdSource = 'official_source_id'
  let sourceIdResolution = 'official_default'

  if (officialMatchedMetaAds && ristakMatchedMetaAds) {
    sourceIdResolution = 'both_matched_official_wins'
  } else if (!officialMatchedMetaAds && ristakMatchedMetaAds) {
    sourceId = ristakAdId
    sourceIdSource = 'rstkad_id'
    sourceIdResolution = 'rstkad_live_ad_wins'
  } else if (officialMatchedMetaAds) {
    sourceIdResolution = 'official_live_ad_wins'
  }

  return {
    ...attribution,
    sourceId,
    sourceIdSource,
    sourceIdResolution,
    sourceIdCandidates: {
      officialSourceId,
      ristakAdId,
      businessDate,
      officialMatchedMetaAds,
      ristakMatchedMetaAds
    },
    sourceType: sourceId === ristakAdId && !attribution.sourceType ? 'ad' : attribution.sourceType
  }
}

function normalizeDirectionValue(value) {
  const text = cleanString(value).toLowerCase()
  if (!text) return ''
  if (['inbound', 'incoming', 'received', 'customer', 'user'].includes(text)) return 'inbound'
  if (['outbound', 'outgoing', 'sent', 'business', 'api', 'app'].includes(text)) return 'outbound'
  if (['business_echo', 'smb_echo', 'echo', 'message_echo'].includes(text)) return 'business_echo'
  return ''
}

function normalizePhoneSet(values = []) {
  return new Set(
    values
      .map(value => normalizePhoneForStorage(value) || cleanString(value))
      .filter(Boolean)
  )
}

function normalizePhoneComparable(value) {
  return normalizePhoneForStorage(value) || cleanString(value)
}

function phoneMatches(left, right) {
  const leftPhone = normalizePhoneComparable(left)
  const rightPhone = normalizePhoneComparable(right)
  if (!leftPhone || !rightPhone) return false
  const rightCandidates = new Set(buildPhoneMatchCandidates(rightPhone))
  return buildPhoneMatchCandidates(leftPhone).some(candidate => rightCandidates.has(candidate))
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

  const messageType = cleanString(message.type || message.messageType || message.message_type).toLowerCase()
  if (message.businessEcho === true || message.business_echo === true || message.isEcho === true || message.is_echo === true) return 'business_echo'
  if (payload.field === 'smb_message_echoes' || payload.field === 'message_echoes' || messageType === 'smb_message_echo') return 'business_echo'
  if (message.fromMe === true || message.from_me === true || message.isFromMe === true) return 'outbound'
  if (message.fromMe === false || message.from_me === false || message.isFromMe === false) return 'inbound'

  const hints = normalizePhoneSet(businessPhoneHints)
  const fromPhone = normalizePhoneForStorage(message.from) || cleanString(message.from)
  const toPhone = normalizePhoneForStorage(message.to) || cleanString(message.to)
  if (fromPhone && hints.has(fromPhone)) return 'outbound'
  if (toPhone && hints.has(toPhone)) return 'inbound'

  if (INBOUND_MESSAGE_EVENT_TYPES.has(type)) return 'inbound'
  if (OUTBOUND_MESSAGE_EVENT_TYPES.has(type)) return 'outbound'

  // (WA-005) Antes de caer al default, usar el estado de entrega como señal:
  // 'sent'/'delivered'/'failed'/'undelivered' son acuses que SOLO aplican a
  // mensajes que nosotros enviamos (salientes). Sin esto, un saliente sin otra
  // señal de dirección se guardaba como 'inbound'.
  const deliveryStatus = normalizeMessageDeliveryStatus(message.status)
  if (['sent', 'delivered', 'failed', 'undelivered'].includes(deliveryStatus)) return 'outbound'

  return 'inbound'
}

function getMessageIdentity({ payload = {}, direction = '', message = {}, businessPhoneHints = [] }) {
  const normalizedDirection = inferMessageDirection({ payload, direction, message, businessPhoneHints })
  const isInbound = normalizedDirection === 'inbound'
  const customerPhone = isInbound ? message.from : message.to
  const businessPhone = isInbound ? message.to : message.from

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
  const cleanFallback = normalizeWhatsAppProfileName(fallbackName, phone)

  if (storedName && !shouldReplaceContactName(storedName, phone)) {
    return storedName
  }

  if (cleanFallback) {
    return cleanFallback
  }

  return phone
}

async function upsertLocalContact({ contactId, phone, profileName, messageTimestamp, attribution }) {
  const canonicalPhone = normalizePhoneForStorage(phone) || cleanString(phone)
  if (!canonicalPhone) return { id: null, created: false }

  const cleanContactId = cleanString(contactId)
  const existingById = cleanContactId
    ? await db.get(`
        SELECT id, phone, full_name, source, total_paid, purchases_count,
               attribution_ctwa_clid, attribution_ad_name, attribution_ad_id,
               created_at
        FROM contacts
        WHERE id = ?
        LIMIT 1
      `, [cleanContactId]).catch(() => null)
    : null
  const existing = existingById || await findContactByPhoneCandidates(canonicalPhone)
  const contactName = normalizeWhatsAppProfileName(profileName, canonicalPhone)
  const fullName = contactName || GENERIC_CONTACT_NAME
  const cleanMessageTimestamp = toDateTime(messageTimestamp) || null
  const hasAdAttribution = hasWhatsAppAdAttributionSignal(attribution)
  const attributionAdId = hasAdAttribution ? attribution.sourceId : ''
  const attributionAdName = hasAdAttribution ? (attribution.headline || attribution.sourceId) : ''

  if (!existing) {
    // ID propio de Ristak: el teléfono/perfil de WhatsApp queda como referencia
    // (contacts.phone y whatsapp_api_contacts), nunca como primary key.
    const contactId = generateContactId()
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
      attributionAdName || null,
      attributionAdId || null,
      cleanMessageTimestamp || nowIso()
    ])

    await recordContactPhoneNumber({
      contactId,
      phone: canonicalPhone,
      label: 'Principal',
      isPrimary: true,
      source: 'whatsapp_api'
    }).catch(error => {
      logger.warn(`[WhatsApp API] No se pudo registrar teléfono principal para ${contactId}: ${error.message}`)
    })

    return {
      id: contactId,
      created: true,
      contactName: contactName || canonicalPhone
    }
  }

  const updates = []
  const params = []
  const sourceLooksWhatsAppApi = cleanString(existing.source).toLowerCase() === SOURCE_NAME.toLowerCase()

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

  if (existingById && canonicalPhone && !cleanString(existing.phone)) {
    const phoneOwner = await findContactByPhoneCandidates(canonicalPhone, { excludeId: existing.id })
    if (!phoneOwner) {
      updates.push('phone = ?')
      params.push(canonicalPhone)
    }
  }

  if (attribution.ctwaClid) {
    updates.push('attribution_ctwa_clid = COALESCE(NULLIF(attribution_ctwa_clid, \'\'), ?)')
    params.push(attribution.ctwaClid)
  }

  if (attribution.sourceId) {
    // Contact attribution is acquisition first-touch. Later WhatsApp ad touches
    // stay in whatsapp_api_attribution and are used by conversion snapshots.
    updates.push('attribution_ad_id = COALESCE(NULLIF(attribution_ad_id, \'\'), ?)')
    params.push(attribution.sourceId)
    updates.push('attribution_ad_name = COALESCE(NULLIF(attribution_ad_name, \'\'), ?)')
    params.push(attribution.headline || attribution.sourceId)
  }

  const existingCreatedAt = toDateTime(existing.created_at)
  if (
    cleanMessageTimestamp &&
    sourceLooksWhatsAppApi &&
    (!existingCreatedAt || new Date(cleanMessageTimestamp).getTime() < new Date(existingCreatedAt).getTime())
  ) {
    updates.push('created_at = ?')
    params.push(cleanMessageTimestamp)
  }

  if (updates.length) {
    updates.push('updated_at = CURRENT_TIMESTAMP')
    params.push(existing.id)
    await db.run(`UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`, params)
  }

  await recordContactPhoneNumber({
    contactId: existing.id,
    phone: canonicalPhone,
    label: existing.phone && normalizePhoneForStorage(existing.phone) !== canonicalPhone ? 'Adicional' : 'Principal',
    isPrimary: !cleanString(existing.phone) || normalizePhoneForStorage(existing.phone) === canonicalPhone,
    source: 'whatsapp_api'
  }).catch(error => {
    logger.warn(`[WhatsApp API] No se pudo registrar teléfono para ${existing.id}: ${error.message}`)
  })

  return {
    id: existing.id,
    created: false,
    contactName: getStoredContactDisplayName(existing, contactName, canonicalPhone)
  }
}

// Rehospeda (best-effort) el avatar de WhatsApp Cloud API al Bunny para que no
// caduque. Devuelve la URL a guardar (Bunny si se pudo, cruda si no). Nunca lanza.
async function rehostApiAvatarUrl({ incomingUrl, currentUrl, canonicalPhone }) {
  const raw = cleanString(incomingUrl)
  if (!raw) return ''
  try {
    const { resolveAvatarForPersist } = await import('./mediaStorageService.js')
    const resolved = await resolveAvatarForPersist({
      incomingUrl: raw,
      currentUrl: cleanString(currentUrl),
      channel: 'whatsapp',
      filename: `wa-${canonicalPhone}.jpg`
    })
    return resolved?.url || raw
  } catch {
    return raw
  }
}

async function upsertWhatsAppApiContact({
  contactId,
  phone,
  profileName,
  rawProfile,
  seenAt,
  lastSeenAt,
  profilePictureUrl,
  profilePictureSource = 'whatsapp_api',
  messageCountDelta = 1
}) {
  const canonicalPhone = normalizePhoneForStorage(phone) || cleanString(phone)
  if (!canonicalPhone) return null

  const apiContactId = hashId('waapi_profile', canonicalPhone)
  const existingApiContact = await db.get(
    'SELECT profile_name, profile_picture_url FROM whatsapp_api_contacts WHERE phone = ? LIMIT 1',
    [canonicalPhone]
  ).catch(() => null)
  const cleanProfileName = normalizeWhatsAppProfileName(profileName, canonicalPhone)
  const profileNameForStorage = cleanProfileName && (
    !existingApiContact || shouldReplaceWhatsAppApiContactName(existingApiContact.profile_name, canonicalPhone)
  )
    ? cleanProfileName
    : ''
  const cleanProfilePictureUrl = cleanString(profilePictureUrl) || findProfilePictureUrlInValue(rawProfile)
  // Rehospedar el avatar al Bunny (una vez por contacto) para que no caduque.
  // Best-effort: si falla o no hay Bunny, cae a la URL cruda como antes.
  const storedPictureUrl = await rehostApiAvatarUrl({
    incomingUrl: cleanProfilePictureUrl,
    currentUrl: existingApiContact?.profile_picture_url,
    canonicalPhone
  })
  const cleanProfilePictureSource = storedPictureUrl
    ? cleanString(profilePictureSource) || 'whatsapp_api'
    : null
  const profilePictureUpdatedAt = storedPictureUrl ? nowIso() : null
  const safeMessageCountDelta = Math.max(Number(messageCountDelta) || 0, 0)
  const firstSeenAt = toDateTime(seenAt) || nowIso()
  const cleanLastSeenAt = toDateTime(lastSeenAt) || firstSeenAt

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
    profileNameForStorage || null,
    storedPictureUrl || null,
    cleanProfilePictureSource,
    profilePictureUpdatedAt,
    safeJson(rawProfile),
    firstSeenAt,
    cleanLastSeenAt,
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
  const phone = normalizePhoneForStorage(contact.phone) || cleanString(contact.phone)
  return normalizeWhatsAppProfileName(contact.full_name, phone) ||
    extractWhatsAppProfileName(contact, phone) ||
    extractWhatsAppProfileName(rawProfile, phone)
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
      logger.warn(`[WhatsApp API] No se pudo cargar configuración para fotos de perfil: ${error.message}`)
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

async function getWhatsAppProfilePictureRefreshContact({ contactId, phone, profileName } = {}) {
  const cleanContactId = cleanString(contactId)
  const canonicalPhone = normalizePhoneForStorage(phone) || cleanString(phone)
  if (!cleanContactId && !canonicalPhone) return null

  const row = await db.get(`
    SELECT
      c.id,
      c.phone,
      c.full_name,
      c.first_name,
      (
        SELECT profile_picture_url
        FROM whatsapp_api_contacts
        WHERE contact_id = c.id
           OR phone = ?
           OR phone = c.phone
        ORDER BY CASE WHEN NULLIF(profile_picture_url, '') IS NULL THEN 1 ELSE 0 END,
                 profile_picture_updated_at DESC,
                 updated_at DESC
        LIMIT 1
      ) AS whatsapp_profile_picture_url,
      (
        SELECT profile_picture_updated_at
        FROM whatsapp_api_contacts
        WHERE contact_id = c.id
           OR phone = ?
           OR phone = c.phone
        ORDER BY profile_picture_updated_at DESC, updated_at DESC
        LIMIT 1
      ) AS whatsapp_profile_picture_updated_at,
      (
        SELECT raw_profile_json
        FROM whatsapp_api_contacts
        WHERE contact_id = c.id
           OR phone = ?
           OR phone = c.phone
        ORDER BY updated_at DESC
        LIMIT 1
      ) AS whatsapp_raw_profile_json
    FROM contacts c
    WHERE (? != '' AND c.id = ?)
       OR (? != '' AND c.phone = ?)
       OR (? != '' AND c.id = (
         SELECT contact_id
         FROM contact_phone_numbers
         WHERE phone = ?
         ORDER BY is_primary DESC, updated_at DESC
         LIMIT 1
       ))
    ORDER BY CASE WHEN c.id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `, [
    canonicalPhone,
    canonicalPhone,
    canonicalPhone,
    cleanContactId,
    cleanContactId,
    canonicalPhone,
    canonicalPhone,
    canonicalPhone,
    canonicalPhone,
    cleanContactId
  ]).catch(() => null)

  if (row) {
    return {
      ...row,
      name: cleanString(row.full_name || row.first_name || profileName),
      phone: normalizePhoneForStorage(row.phone || canonicalPhone) || cleanString(row.phone || canonicalPhone)
    }
  }

  if (!canonicalPhone) return null
  return {
    id: cleanContactId,
    phone: canonicalPhone,
    full_name: cleanString(profileName),
    name: cleanString(profileName),
    whatsapp_profile_picture_url: '',
    whatsapp_profile_picture_updated_at: null,
    whatsapp_raw_profile_json: null
  }
}

export async function refreshInboundWhatsAppContactProfilePicture(result = {}) {
  if (result?.direction && result.direction !== 'inbound') return { refreshed: false, reason: 'not_inbound' }
  if (result?.isNew === false) return { refreshed: false, reason: 'existing_message' }

  const contact = await getWhatsAppProfilePictureRefreshContact({
    contactId: result.contactId,
    phone: result.phone,
    profileName: result.profileName || result.contactName
  })
  if (!contact?.phone) return { refreshed: false, reason: 'missing_contact' }

  const key = cleanString(contact.id) || cleanString(contact.phone)
  let profileContact = contact
  const apiPictures = await warmWhatsAppApiProfilePictures([profileContact], { limit: 1 })
  const apiUrl = apiPictures.get(key)
  if (apiUrl) {
    profileContact = {
      ...profileContact,
      whatsapp_profile_picture_url: apiUrl,
      whatsapp_profile_picture_updated_at: nowIso()
    }
  }

  const qrPictures = await warmWhatsAppQrProfilePictures([profileContact], { limit: 1 })
  const qrUrl = qrPictures.get(key)
  const refreshedUrl = qrUrl || apiUrl || ''

  return refreshedUrl
    ? { refreshed: true, url: refreshedUrl, source: qrUrl ? 'qr' : 'api' }
    : { refreshed: false, reason: 'not_available' }
}

function clampWhatsAppProfilePictureBackfillLimit(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return WHATSAPP_PROFILE_PICTURE_BACKFILL_DEFAULT_LIMIT
  return Math.min(Math.max(Math.floor(parsed), 1), WHATSAPP_PROFILE_PICTURE_BACKFILL_MAX_LIMIT)
}

function chunkProfilePictureBackfillContacts(contacts = [], size = WHATSAPP_PROFILE_PICTURE_BACKFILL_QR_BATCH_LIMIT) {
  const chunkSize = Math.max(Math.floor(Number(size) || WHATSAPP_PROFILE_PICTURE_BACKFILL_QR_BATCH_LIMIT), 1)
  const chunks = []
  for (let index = 0; index < contacts.length; index += chunkSize) {
    chunks.push(contacts.slice(index, index + chunkSize))
  }
  return chunks
}

function mergeProfilePictureResults(target = new Map(), source = new Map()) {
  for (const [key, value] of source || []) {
    const cleanKey = cleanString(key)
    const cleanValue = cleanString(value)
    if (cleanKey && cleanValue) target.set(cleanKey, cleanValue)
  }
  return target
}

function applyBackfilledProfilePicturesToContacts(contacts = [], pictures = new Map()) {
  if (!pictures?.size) return contacts
  const refreshedAt = nowIso()
  return contacts.map(contact => {
    const key = cleanString(contact?.id) || cleanString(contact?.phone)
    const url = pictures.get(key)
    return url
      ? {
          ...contact,
          whatsapp_profile_picture_url: url,
          whatsapp_profile_picture_updated_at: refreshedAt
        }
      : contact
  })
}

async function listWhatsAppProfilePictureBackfillContacts({ limit, onlyMissing = false, contactIds = [], scope = 'all_crm' } = {}) {
  const safeLimit = clampWhatsAppProfilePictureBackfillLimit(limit)
  const rowLimit = Math.min(safeLimit * 4, WHATSAPP_PROFILE_PICTURE_BACKFILL_MAX_LIMIT * 4)
  const cleanContactIds = [...new Set((Array.isArray(contactIds) ? contactIds : [])
    .map(cleanString)
    .filter(Boolean))]
  const contactIdClause = cleanContactIds.length
    ? `AND c.id IN (${cleanContactIds.map(() => '?').join(', ')})`
    : ''
  const onlyMissingClause = onlyMissing
    ? "WHERE NULLIF(whatsapp_profile_picture_url, '') IS NULL"
    : ''
  const whatsappOnlyClause = cleanString(scope).toLowerCase() === 'whatsapp_only'
    ? `AND (
          LOWER(COALESCE(c.source, '')) LIKE '%whatsapp%'
          OR EXISTS (
            SELECT 1
            FROM whatsapp_api_contacts wac
            WHERE wac.contact_id = c.id
               OR wac.phone = cp.phone
               OR wac.phone = c.phone
          )
          OR EXISTS (
            SELECT 1
            FROM whatsapp_api_messages msg
            WHERE msg.contact_id = c.id
               OR cp.phone IN (msg.phone, msg.from_phone, msg.to_phone)
          )
        )`
    : ''

  const rows = await db.all(`
    WITH contact_phone_lookup AS (
      SELECT
        id AS contact_id,
        phone,
        1 AS is_primary,
        updated_at AS phone_updated_at
      FROM contacts
      WHERE TRIM(COALESCE(phone, '')) != ''
      UNION ALL
      SELECT
        contact_id,
        phone,
        COALESCE(is_primary, 0) AS is_primary,
        updated_at AS phone_updated_at
      FROM contact_phone_numbers
      WHERE TRIM(COALESCE(phone, '')) != ''
    ),
    candidates AS (
      SELECT
        c.id,
        cp.phone,
        c.full_name,
        c.first_name,
        c.preferred_whatsapp_phone_number_id,
        (
          SELECT profile_name
          FROM whatsapp_api_contacts wac
          WHERE wac.contact_id = c.id
             OR wac.phone = cp.phone
             OR wac.phone = c.phone
          ORDER BY wac.updated_at DESC
          LIMIT 1
        ) AS whatsapp_profile_name,
        (
          SELECT raw_profile_json
          FROM whatsapp_api_contacts wac
          WHERE wac.contact_id = c.id
             OR wac.phone = cp.phone
             OR wac.phone = c.phone
          ORDER BY wac.updated_at DESC
          LIMIT 1
        ) AS whatsapp_raw_profile_json,
        (
          SELECT profile_picture_url
          FROM whatsapp_api_contacts wac
          WHERE wac.contact_id = c.id
             OR wac.phone = cp.phone
             OR wac.phone = c.phone
          ORDER BY CASE WHEN NULLIF(wac.profile_picture_url, '') IS NULL THEN 1 ELSE 0 END,
                   wac.profile_picture_updated_at DESC,
                   wac.updated_at DESC
          LIMIT 1
        ) AS whatsapp_profile_picture_url,
        (
          SELECT profile_picture_updated_at
          FROM whatsapp_api_contacts wac
          WHERE wac.contact_id = c.id
             OR wac.phone = cp.phone
             OR wac.phone = c.phone
          ORDER BY wac.profile_picture_updated_at DESC, wac.updated_at DESC
          LIMIT 1
        ) AS whatsapp_profile_picture_updated_at,
        (
          SELECT business_phone
          FROM whatsapp_api_messages msg
          WHERE (msg.contact_id = c.id OR cp.phone IN (msg.phone, msg.from_phone, msg.to_phone))
            AND msg.direction = 'inbound'
            AND TRIM(COALESCE(msg.business_phone, '')) != ''
          ORDER BY COALESCE(msg.message_timestamp, msg.created_at) DESC, msg.created_at DESC
          LIMIT 1
        ) AS last_inbound_business_phone,
        (
          SELECT business_phone_number_id
          FROM whatsapp_api_messages msg
          WHERE (msg.contact_id = c.id OR cp.phone IN (msg.phone, msg.from_phone, msg.to_phone))
            AND msg.direction = 'inbound'
            AND TRIM(COALESCE(msg.business_phone_number_id, '')) != ''
          ORDER BY COALESCE(msg.message_timestamp, msg.created_at) DESC, msg.created_at DESC
          LIMIT 1
        ) AS last_inbound_business_phone_number_id,
        (
          SELECT MAX(COALESCE(msg.message_timestamp, msg.created_at))
          FROM whatsapp_api_messages msg
          WHERE msg.contact_id = c.id
             OR cp.phone IN (msg.phone, msg.from_phone, msg.to_phone)
        ) AS last_whatsapp_message_at,
        CASE WHEN COALESCE(cp.is_primary, 0) = 1 THEN 0 ELSE 1 END AS phone_rank
      FROM contacts c
      JOIN contact_phone_lookup cp ON cp.contact_id = c.id
      WHERE c.deleted_at IS NULL
        ${contactIdClause}
        AND TRIM(COALESCE(cp.phone, '')) != ''
        ${whatsappOnlyClause}
    )
    SELECT *
    FROM candidates
    ${onlyMissingClause}
    ORDER BY CASE WHEN NULLIF(whatsapp_profile_picture_url, '') IS NULL THEN 0 ELSE 1 END,
             CASE WHEN whatsapp_profile_picture_updated_at IS NULL THEN 0 ELSE 1 END,
             whatsapp_profile_picture_updated_at ASC,
             last_whatsapp_message_at DESC,
             phone_rank ASC,
             id ASC
    LIMIT ?
  `, [...cleanContactIds, rowLimit])

  const contacts = []
  const seenContactIds = new Set()
  const seenPhones = new Set()
  for (const row of rows || []) {
    const contactId = cleanString(row.id)
    const phone = normalizePhoneForStorage(row.phone) || cleanString(row.phone)
    const key = contactId || phone
    if (!key || seenContactIds.has(contactId) || seenPhones.has(phone)) continue

    seenContactIds.add(contactId)
    seenPhones.add(phone)
    contacts.push({
      ...row,
      id: contactId,
      phone,
      name: cleanString(row.full_name || row.first_name || row.whatsapp_profile_name || phone)
    })
    if (contacts.length >= safeLimit) break
  }

  return contacts
}

export async function backfillWhatsAppContactProfilePictures({
  limit = WHATSAPP_PROFILE_PICTURE_BACKFILL_DEFAULT_LIMIT,
  force = false,
  onlyMissing = false,
  contactIds = [],
  scope = 'all_crm'
} = {}) {
  const safeLimit = clampWhatsAppProfilePictureBackfillLimit(limit)
  const normalizedScope = cleanString(scope).toLowerCase() === 'whatsapp_only' ? 'whatsapp_only' : 'all_crm'
  const contacts = await listWhatsAppProfilePictureBackfillContacts({
    limit: safeLimit,
    onlyMissing: Boolean(onlyMissing) && !force,
    contactIds,
    scope: normalizedScope
  })
  const startedAt = nowIso()

  if (!contacts.length) {
    return {
      ok: true,
      startedAt,
      finishedAt: nowIso(),
      limit: safeLimit,
      force: Boolean(force),
      onlyMissing: Boolean(onlyMissing) && !force,
      scope: normalizedScope,
      scanned: 0,
      apiAttempted: 0,
      qrAttempted: 0,
      apiUpdated: 0,
      qrUpdated: 0,
      updated: 0,
      contacts: []
    }
  }

  const apiPictures = await warmWhatsAppApiProfilePictures(contacts, {
    limit: contacts.length,
    force: Boolean(force)
  })
  let hydratedContacts = applyBackfilledProfilePicturesToContacts(contacts, apiPictures)
  const qrPictures = new Map()

  for (const chunk of chunkProfilePictureBackfillContacts(
    hydratedContacts,
    WHATSAPP_PROFILE_PICTURE_BACKFILL_QR_BATCH_LIMIT
  )) {
    const chunkPictures = await warmWhatsAppQrProfilePictures(chunk, {
      limit: chunk.length,
      force: Boolean(force)
    })
    mergeProfilePictureResults(qrPictures, chunkPictures)
    hydratedContacts = applyBackfilledProfilePicturesToContacts(hydratedContacts, chunkPictures)
  }

  const updatedKeys = new Set([...apiPictures.keys(), ...qrPictures.keys()].map(cleanString).filter(Boolean))

  return {
    ok: true,
    startedAt,
    finishedAt: nowIso(),
    limit: safeLimit,
    force: Boolean(force),
    onlyMissing: Boolean(onlyMissing) && !force,
    scope: normalizedScope,
    scanned: contacts.length,
    apiAttempted: contacts.length,
    qrAttempted: contacts.length,
    apiUpdated: apiPictures.size,
    qrUpdated: qrPictures.size,
    updated: updatedKeys.size,
    contacts: hydratedContacts
      .filter(contact => updatedKeys.has(cleanString(contact.id) || cleanString(contact.phone)))
      .map(contact => ({
        id: contact.id,
        phone: contact.phone,
        name: cleanString(contact.full_name || contact.name || contact.whatsapp_profile_name),
        profilePictureUrl: qrPictures.get(cleanString(contact.id) || cleanString(contact.phone)) ||
          apiPictures.get(cleanString(contact.id) || cleanString(contact.phone)) ||
          ''
      }))
  }
}

function scheduleInboundWhatsAppContactProfilePictureRefresh(result = {}, source = 'whatsapp') {
  if (!result?.contactId || !result?.phone || result?.direction !== 'inbound' || result?.isNew === false) return

  refreshInboundWhatsAppContactProfilePicture(result).catch(error => {
    logger.warn(`[WhatsApp] No se pudo refrescar avatar de contacto (${source}) ${result.contactId || result.phone || ''}: ${error.message}`)
  })
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
  normalized.customerProfile = normalized.customerProfile ||
    normalized.customer_profile ||
    normalized.contactProfile ||
    normalized.contact_profile ||
    normalized.contact?.customerProfile ||
    normalized.contact?.profile
  normalized.profile = normalized.profile ||
    normalized.whatsAppProfile ||
    normalized.whatsappProfile ||
    normalized.whatsapp_profile

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

async function upsertMessage({ payload, message, direction, businessPhoneHints = [], transport = 'api', contactId = null, historyImport = false }) {
  const normalizedMessage = normalizeWebhookMessage(message)
  const identity = getMessageIdentity({ payload, direction, message: normalizedMessage, businessPhoneHints })
  const contactIdHint = cleanString(
    contactId ||
    normalizedMessage.contactId ||
    normalizedMessage.contact_id ||
    payload.contactId ||
    payload.contact_id
  )
  const cleanTransport = cleanString(normalizedMessage.transport || payload.transport || transport || 'api').toLowerCase() || 'api'
  const routingReason = cleanString(
    normalizedMessage.fallbackReason ||
    normalizedMessage.routingReason ||
    payload.fallbackReason ||
    payload.routingReason
  )
  const messageText = extractMessageText(normalizedMessage)
  const messageTimestamp = toDateTime(normalizedMessage.sendTime || normalizedMessage.createTime || normalizedMessage.updateTime || payload.createTime) || nowIso()
  const profileName = extractWhatsAppProfileName(normalizedMessage, identity.phone)
  const rawProfile = normalizedMessage.customerProfile || normalizedMessage.profile || null
  const profilePictureUrl = findProfilePictureUrlInValue(rawProfile)
  const attribution = await resolveWhatsAppAttributionSourceId(
    extractAttribution(payload, normalizedMessage, messageText),
    messageTimestamp
  )
  const localContact = await upsertLocalContact({
    contactId: contactIdHint,
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

  const provider = cleanString(normalizedMessage.provider || payload.provider) || PROVIDER_NAME
  const origin = cleanString(normalizedMessage.origin || payload.origin || payload.field || payload.type)
  const rawMessageId = cleanString(normalizedMessage.id)
  const metaMessageId = ''
  const ycloudMessageId = rawMessageId
  const wamid = cleanString(normalizedMessage.wamid || normalizedMessage.context?.id)
  const computedMessageId = hashId('waapi_msg', ycloudMessageId || metaMessageId || wamid || `${payload.id}|${identity.direction}|${identity.phone}`)
  const existingMessage = await db.get(`
    SELECT id, status, transport, routing_reason, raw_payload_json
    FROM whatsapp_api_messages
    WHERE id = ?
      OR (? != '' AND ycloud_message_id = ?)
      OR (? != '' AND meta_message_id = ?)
      OR (? != '' AND wamid = ?)
    ORDER BY updated_at DESC
    LIMIT 1
  `, [computedMessageId, ycloudMessageId, ycloudMessageId, metaMessageId, metaMessageId, wamid, wamid]).catch(() => null)
  const messageId = existingMessage?.id || computedMessageId
  const incomingAgentMarker = extractConversationalAgentMessageMetadata(normalizedMessage)
  const existingAgentMarker = extractConversationalAgentMessageMetadata(existingMessage?.raw_payload_json)
  const preservedAgentMetadata = formatConversationalAgentMessageMetadata(
    incomingAgentMarker.sentByAgent ? incomingAgentMarker : existingAgentMarker
  )
  const businessPhoneNumberId = await findBusinessPhoneNumberId(identity.businessPhone)
  const incomingStatus = normalizeMessageDeliveryStatus(normalizedMessage.status)
  const existingQrFallbackApplied = cleanString(existingMessage?.transport).toLowerCase() === 'qr' &&
    Boolean(cleanString(existingMessage?.routing_reason)) &&
    cleanTransport === 'api' &&
    identity.direction === 'outbound' &&
    incomingStatus === 'failed'
  const status = existingQrFallbackApplied
    ? (normalizeMessageDeliveryStatus(existingMessage?.status) || 'sent')
    : pickBestMessageDeliveryStatus(existingMessage?.status, incomingStatus)
  const error = Array.isArray(normalizedMessage.errors) ? normalizedMessage.errors[0] : normalizedMessage.error
  const errorCode = cleanString(error?.code || normalizedMessage.errorCode)
  const errorMessage = cleanString(error?.message || error?.title || normalizedMessage.errorMessage)
  const messageType = cleanString(normalizedMessage.type) || 'unknown'
  const buttonReply = extractButtonReply(normalizedMessage)
  const media = await hydrateInboundMessageMedia(
    normalizedMessage,
    extractMessageMedia(normalizedMessage),
    { businessPhoneNumberId }
  )
  const businessEcho = identity.direction === 'business_echo' || normalizedMessage.businessEcho === true || normalizedMessage.business_echo === true
  const relayEventId = cleanString(payload.relayEventId || payload.relay_event_id)

  await db.run(`
    INSERT INTO whatsapp_api_messages (
      id, provider, origin, ycloud_message_id, meta_message_id, wamid, waba_id, business_phone_number_id,
      whatsapp_api_contact_id, contact_id,
      phone, from_phone, to_phone, business_phone, transport, routing_reason, direction, message_type,
      message_text, media_url, media_mime_type, media_filename, media_duration_ms,
      status, business_echo, relay_event_id, error_code, error_message, message_timestamp,
      raw_payload_json, context_json, referral_json,
      detected_ctwa_clid, detected_source_id, detected_source_url, detected_source_type,
      detected_source_app, detected_entry_point, detected_headline, detected_body,
      detected_conversion_data, detected_ctwa_payload, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      provider = COALESCE(NULLIF(excluded.provider, ''), whatsapp_api_messages.provider),
      origin = COALESCE(NULLIF(excluded.origin, ''), whatsapp_api_messages.origin),
      meta_message_id = COALESCE(NULLIF(excluded.meta_message_id, ''), whatsapp_api_messages.meta_message_id),
      business_phone_number_id = COALESCE(excluded.business_phone_number_id, whatsapp_api_messages.business_phone_number_id),
      whatsapp_api_contact_id = COALESCE(excluded.whatsapp_api_contact_id, whatsapp_api_messages.whatsapp_api_contact_id),
      contact_id = COALESCE(excluded.contact_id, whatsapp_api_messages.contact_id),
      phone = COALESCE(NULLIF(excluded.phone, ''), whatsapp_api_messages.phone),
      from_phone = COALESCE(NULLIF(excluded.from_phone, ''), whatsapp_api_messages.from_phone),
      to_phone = COALESCE(NULLIF(excluded.to_phone, ''), whatsapp_api_messages.to_phone),
      business_phone = COALESCE(NULLIF(excluded.business_phone, ''), whatsapp_api_messages.business_phone),
      transport = COALESCE(NULLIF(excluded.transport, ''), whatsapp_api_messages.transport),
      routing_reason = COALESCE(NULLIF(excluded.routing_reason, ''), whatsapp_api_messages.routing_reason),
      direction = COALESCE(NULLIF(excluded.direction, ''), whatsapp_api_messages.direction),
      message_type = COALESCE(NULLIF(excluded.message_type, ''), whatsapp_api_messages.message_type),
      message_text = COALESCE(NULLIF(excluded.message_text, ''), whatsapp_api_messages.message_text),
      media_url = COALESCE(NULLIF(excluded.media_url, ''), whatsapp_api_messages.media_url),
      media_mime_type = COALESCE(NULLIF(excluded.media_mime_type, ''), whatsapp_api_messages.media_mime_type),
      media_filename = COALESCE(NULLIF(excluded.media_filename, ''), whatsapp_api_messages.media_filename),
      media_duration_ms = COALESCE(excluded.media_duration_ms, whatsapp_api_messages.media_duration_ms),
      status = COALESCE(NULLIF(excluded.status, ''), whatsapp_api_messages.status),
      business_echo = COALESCE(excluded.business_echo, whatsapp_api_messages.business_echo),
      relay_event_id = COALESCE(NULLIF(excluded.relay_event_id, ''), whatsapp_api_messages.relay_event_id),
      error_code = CASE
        WHEN LOWER(COALESCE(excluded.transport, whatsapp_api_messages.transport, '')) = 'qr' THEN NULL
        ELSE COALESCE(NULLIF(excluded.error_code, ''), whatsapp_api_messages.error_code)
      END,
      error_message = CASE
        WHEN LOWER(COALESCE(excluded.transport, whatsapp_api_messages.transport, '')) = 'qr' THEN NULL
        ELSE COALESCE(NULLIF(excluded.error_message, ''), whatsapp_api_messages.error_message)
      END,
      message_timestamp = COALESCE(excluded.message_timestamp, whatsapp_api_messages.message_timestamp),
      raw_payload_json = COALESCE(NULLIF(excluded.raw_payload_json, ''), whatsapp_api_messages.raw_payload_json),
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
    provider,
    origin || null,
    ycloudMessageId || null,
    null,
    wamid || null,
    cleanString(message.wabaId) || null,
    businessPhoneNumberId,
    apiContactId,
    localContact.id,
    identity.phone || null,
    identity.fromPhone || null,
    identity.toPhone || null,
    identity.businessPhone || null,
    existingQrFallbackApplied ? 'qr' : cleanTransport,
    existingQrFallbackApplied ? existingMessage.routing_reason : (routingReason || null),
    identity.direction,
    messageType,
    messageText || null,
    media.mediaUrl || null,
    media.mediaMimeType || null,
    media.mediaFilename || null,
    media.mediaDurationMs,
    status || null,
    businessEcho ? 1 : 0,
    relayEventId || null,
    existingQrFallbackApplied ? null : (errorCode || null),
    existingQrFallbackApplied ? null : (errorMessage || null),
    messageTimestamp,
    existingQrFallbackApplied ? null : safeJson({ ...normalizedMessage, ...preservedAgentMetadata }),
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

  const failureText = `${errorCode} ${errorMessage}`.trim()
  const restrictionReason = incomingStatus === 'failed'
    ? getOfficialApiRestrictionErrorReason({ message: failureText })
    : ''
  // Ventana de 24 horas (131047 y parecidos): el mensaje se reintenta por QR,
  // pero NO se crea ninguna alerta de bloqueo porque el número y la cuenta
  // estan perfectamente sanos.
  const conversationWindowReason = incomingStatus === 'failed' && !restrictionReason
    ? getOfficialApiConversationWindowReason({ message: failureText })
    : ''

  let qrFallbackResponse = null
  if (cleanTransport === 'api' && identity.direction === 'outbound' && !existingQrFallbackApplied && (restrictionReason || conversationWindowReason)) {
    if (restrictionReason) {
      await activateOfficialApiRestrictionFromFailedMessage({
        normalizedMessage,
        businessPhoneNumberId,
        businessPhone: identity.businessPhone,
        reason: restrictionReason
      })
    }
    qrFallbackResponse = await retryFailedOfficialApiMessageViaQr({
      normalizedMessage,
      identity,
      businessPhoneNumberId,
      messageId,
      messageType,
      messageText,
      reason: restrictionReason || conversationWindowReason,
      existingMessage,
      agentMetadata: preservedAgentMetadata
    })
  }

  const finalTransport = qrFallbackResponse || existingQrFallbackApplied ? 'qr' : cleanTransport
  const finalRoutingReason = cleanString(
    qrFallbackResponse?.routingReason ||
    qrFallbackResponse?.fallbackReason ||
    (existingQrFallbackApplied ? existingMessage?.routing_reason : routingReason)
  )
  const finalStatus = qrFallbackResponse?.status || status

  // La API confirmo un envio saliente: cualquier alerta de bloqueo de este
  // número o de la cuenta quedo obsoleta y se resuelve sola.
  if (
    cleanTransport === 'api' &&
    identity.direction === 'outbound' &&
    ['sent', 'delivered', 'read'].includes(incomingStatus)
  ) {
    await resolveOfficialApiRestrictionAlerts({
      businessPhoneNumberId,
      wabaId: cleanString(message.wabaId || normalizedMessage.wabaId)
    }).catch(error => {
      logger.warn(`[WhatsApp API] No se pudieron resolver alertas de bloqueo: ${error.message}`)
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

  const inboundClaim = identity.direction === 'inbound'
    ? await claimInboundChatMessage({
      channel: 'whatsapp',
      messageId,
      contactId: localContact.id,
      messageTimestamp,
      incrementUnread: !historyImport
    })
    : null
  const isNewMessage = identity.direction === 'inbound'
    ? Boolean(inboundClaim?.claimed)
    : !existingMessage

  if (identity.direction !== 'inbound' || isNewMessage) {
    publishChatMessageEvent({
      contactId: localContact.id,
      messageId,
      channel: 'whatsapp',
      provider,
      transport: finalTransport,
      direction: identity.direction,
      messageType,
      messageTimestamp,
      isNew: isNewMessage,
      historyImport: historyImport === true
    })
  }
  if (isNewMessage && identity.direction === 'inbound') {
    await captureContactIdentityFromMessage({
      contactId: localContact.id,
      text: messageText,
      source: 'whatsapp_inbound_message',
      allowEmail: true,
      allowPhone: false
    })
  }

  return {
    messageId,
    contactId: localContact.id,
    apiContactId,
    attribution,
    direction: identity.direction,
    provider,
    origin,
    businessEcho,
    phone: identity.phone,
    businessPhone: identity.businessPhone,
    businessPhoneNumberId,
    transport: finalTransport,
    status: finalStatus,
    routingReason: finalRoutingReason,
    fallbackApplied: Boolean(qrFallbackResponse),
    fallbackResponse: qrFallbackResponse || null,
    fallbackReason: qrFallbackResponse?.fallbackReason || '',
    contactName: localContact.contactName,
    profileName,
    messageText,
    messageType,
    mediaUrl: media.mediaUrl || '',
    mediaMimeType: media.mediaMimeType || '',
    mediaFilename: media.mediaFilename || '',
    mediaDurationMs: media.mediaDurationMs || null,
    mediaIsVoice: Boolean(media.mediaIsVoice),
    buttonId: buttonReply?.id || '',
    buttonPayload: buttonReply?.payload || '',
    buttonTitle: buttonReply?.title || '',
    buttonReplyType: buttonReply?.type || '',
    isNew: isNewMessage,
    messageTimestamp
  }
}

// (WA-009) Persiste en el chat un envío saliente por API que falló y NO tuvo
// fallback por QR. Sin esto, un mensaje que truena en la API oficial sin
// fallback desaparece: nunca queda registro en la conversación. Se guarda como
// saliente con status 'failed' y el detalle del error para que el operador lo
// vea en el historial y pueda reintentarlo.
async function persistFailedOutboundApiMessage({ fromPhone, toPhone, type = 'text', content = {}, externalId, contactId, error } = {}) {
  try {
    const errorMessage = cleanString(error?.message || error)
    const errorCode = cleanString(error?.code || error?.statusCode)
    await upsertMessage({
      payload: {
        id: externalId || hashId('waapi_send_failed_event', `${fromPhone}|${toPhone}|${type}|${nowIso()}`),
        type: 'whatsapp.message.failed',
        createTime: nowIso()
      },
      message: {
        from: fromPhone,
        to: toPhone,
        type,
        ...content,
        status: 'failed',
        transport: 'api',
        createTime: nowIso(),
        error: { code: errorCode || undefined, message: errorMessage || 'Envío por API fallido' }
      },
      direction: 'outbound',
      transport: 'api',
      contactId
    })
  } catch (persistError) {
    logger.error(`[WhatsApp API] No se pudo persistir el envío saliente fallido: ${persistError.message}`)
  }
}

// Persiste en el historial unificado un mensaje visto por la sesión de WhatsApp Web (Baileys).
// Para el INBOUND: si la API oficial de ese número está sana, el webhook de YCloud ya registra el
// mensaje y guardarlo aquí duplicaría el chat, así que se omite. Para el OUTBOUND escrito
// directamente en el teléfono (eco fromMe de Baileys) NO existe webhook equivalente —la API oficial
// solo reporta lo que se envía A TRAVÉS de ella— por lo que la sesión QR es su única fuente y debe
// capturarse SIEMPRE, incluso con la API operativa. El dedupe difuso de abajo evita duplicar cuando
// Ristak además lo envió por la API.
export async function captureQrChatMessage({
  phoneNumberId,
  businessPhone,
  direction,
  wamid,
  messageType = 'text',
  text = '',
  profileName = '',
  contactPhone,
  timestamp,
  raw = null,
  resolveInboundMedia = null,
  historyImport = false
} = {}) {
  const cleanDirection = direction === 'outbound' ? 'outbound' : 'inbound'
  const cleanBusinessPhone = normalizePhoneForStorage(businessPhone) || cleanString(businessPhone)
  const cleanContactPhone = normalizePhoneForStorage(contactPhone) || cleanString(contactPhone)
  const cleanWamid = cleanString(wamid)
  if (!cleanContactPhone || !cleanWamid) {
    return { skipped: true, reason: 'missing_identity' }
  }

  const config = await loadConfig({ includeSecrets: true })
  const phoneRow = await findBusinessPhoneRowForSender({ phoneNumberId, fromPhone: cleanBusinessPhone })
  const messageText = cleanString(text)
  const cleanMessageType = cleanString(messageType).toLowerCase()
  const messageTimestamp = toDateTime(timestamp) || nowIso()

  // Dedupe difusa: el mismo mensaje pudo entrar por webhook con otro wamid durante una transición.
  // Las reacciones se identifican por su WAMID y mensaje objetivo: dos reacciones
  // iguales dentro de la misma ventana son acciones distintas, no ecos duplicados.
  if (messageText && cleanMessageType !== 'reaction') {
    // PAY-006-DB-005: datetime(?, '±2 minutes') es SQLite-only y truena en Postgres
    // (la query iba en un .catch que ocultaba el error => el dedupe nunca corría en prod).
    // Se ramifica a INTERVAL en Postgres manteniendo el mismo orden de parámetros.
    const {
      lowerBoundExpr,
      upperBoundExpr,
      messageTimeExpr
    } = recentMessageWindowExpressions()
    const duplicate = await db.get(`
      SELECT
        id,
        contact_id,
        status,
        transport,
        routing_reason,
        error_code,
        error_message,
        direction,
        message_type,
        message_timestamp,
        created_at
      FROM whatsapp_api_messages
      WHERE phone = ?
        AND direction = ?
        AND message_text = ?
        AND COALESCE(wamid, '') != ?
        AND ${messageTimeExpr} BETWEEN ${lowerBoundExpr} AND ${upperBoundExpr}
      LIMIT 1
    `, [cleanContactPhone, cleanDirection, messageText, cleanWamid, messageTimestamp, messageTimestamp]).catch(() => null)
    if (duplicate) {
      return handleRecentQrEchoDuplicate({
        duplicate,
        cleanDirection,
        cleanWamid,
        raw,
        messageType,
        messageTimestamp
      })
    }
  } else if (cleanMessageType !== 'reaction') {
    const duplicate = await findRecentOutboundMediaDuplicate({
      cleanContactPhone,
      cleanDirection,
      cleanMessageType,
      cleanWamid,
      messageTimestamp,
      raw
    })
    if (duplicate) {
      return handleRecentQrEchoDuplicate({
        duplicate,
        cleanDirection,
        cleanWamid,
        raw,
        messageType: cleanMessageType || messageType,
        messageTimestamp
      })
    }
  }

  const officialApiOperational = Boolean(config.enabled && config.apiKey) &&
    Boolean(phoneRow?.id) &&
    Number(phoneRow.api_send_enabled ?? 1) === 1 &&
    !(await getOfficialApiRestrictionReason({ phoneRow, config }))
  // Solo el inbound lo cubre de forma redundante el webhook de YCloud. Un mensaje saliente
  // escrito directamente en el teléfono llega únicamente como eco fromMe de Baileys y no tiene
  // copia por webhook, así que jamás debe omitirse aquí: es su única fuente para el chat.
  // En vivo, la API oficial es la fuente primaria y evita duplicar el webhook.
  // Durante un HistorySync QR no podemos asumir que la API ya tenga ese pasado:
  // se importa y el dedupe por IDs/contenido decide si ya existía.
  if (officialApiOperational && cleanDirection === 'inbound' && !historyImport) {
    // El número usa WhatsApp API (YCloud/oficial): la media entrante llega hospedada por el
    // proveedor a través del webhook, así que NO descargamos ni rehospedamos en Bunny.
    return { skipped: true, reason: 'official_api_active' }
  }

  // Llegados aquí el número vive de la sesión QR (Baileys): el proveedor no guarda la
  // media por nosotros, así que la descargamos y la persistimos en nuestro storage.
  // Se resuelve de forma perezosa para no descargar nada si el mensaje se descarta arriba.
  let inboundMedia = null
  if (typeof resolveInboundMedia === 'function' && QR_MEDIA_MESSAGE_TYPES.has(cleanString(messageType).toLowerCase())) {
    // Evita re-descargar/re-subir si el mensaje ya tiene su media rehospedada (p. ej. una
    // resincronización de historial de WhatsApp Web reenvía el mismo wamid).
    const alreadyStored = await db.get(
      `SELECT 1 FROM whatsapp_api_messages WHERE wamid = ? AND COALESCE(media_url, '') != '' LIMIT 1`,
      [cleanWamid]
    ).catch(() => null)
    if (!alreadyStored) {
      inboundMedia = await Promise.resolve()
        .then(() => resolveInboundMedia())
        .catch(error => {
          logger.warn(`[WhatsApp QR] No se pudo guardar la media entrante ${cleanWamid}: ${error.message}`)
          return null
        })
    }
  }

  const mediaKey = normalizeQrMediaKey(messageType)
  const mediaNode = inboundMedia?.mediaUrl
    ? {
        link: inboundMedia.mediaUrl,
        url: inboundMedia.mediaUrl,
        publicUrl: inboundMedia.mediaUrl,
        ...(inboundMedia.mediaMimeType ? { mimeType: inboundMedia.mediaMimeType } : {}),
        ...(inboundMedia.mediaFilename ? { filename: inboundMedia.mediaFilename } : {}),
        ...(inboundMedia.mediaDurationMs ? { durationMs: inboundMedia.mediaDurationMs } : {}),
        ...(inboundMedia.mediaAssetId ? { mediaAssetId: inboundMedia.mediaAssetId } : {})
      }
    : null

  const result = await upsertMessage({
    payload: {
      id: cleanWamid,
      type: cleanDirection === 'inbound' ? 'whatsapp.qr.message.received' : 'whatsapp.qr.message.synced',
      transport: 'qr',
      routingReason: cleanDirection === 'inbound' ? '' : 'Capturado desde la sesión de WhatsApp Web.',
      createTime: messageTimestamp
    },
    message: {
      id: '',
      wamid: cleanWamid,
      from: cleanDirection === 'inbound' ? cleanContactPhone : cleanBusinessPhone,
      to: cleanDirection === 'inbound' ? cleanBusinessPhone : cleanContactPhone,
      type: messageType,
      ...(messageText ? { text: { body: messageText } } : {}),
      ...(mediaNode ? { [mediaKey]: mediaNode } : {}),
      ...(raw?.context ? { context: raw.context } : {}),
      ...(raw?.reaction ? { reaction: raw.reaction } : {}),
      ...(cleanDirection === 'inbound' && profileName ? { profileName } : {}),
      transport: 'qr',
      sendTime: messageTimestamp,
      createTime: messageTimestamp,
      ...(raw ? { qrRaw: raw } : {})
    },
    direction: cleanDirection,
    businessPhoneHints: [cleanBusinessPhone].filter(Boolean),
    transport: 'qr',
    historyImport
  })

  if (!result.businessPhoneNumberId && phoneRow?.id && result.messageId) {
    await db.run(`
      UPDATE whatsapp_api_messages
      SET business_phone_number_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND business_phone_number_id IS NULL
    `, [phoneRow.id, result.messageId]).catch(() => {})
  }

  if (cleanDirection === 'inbound' && result.isNew && !historyImport) {
    scheduleInboundWhatsAppContactProfilePictureRefresh(result, 'whatsapp_qr')

    // Ventana de confirmación con IA: registrar mensaje y determinar si se deben
    // pausar otros agentes/automatizaciones durante la espera de 3 minutos.
    let confirmWindow = { windowActive: false, bypassAutomations: false }
    await handleInboundForConfirmation({
      contactId: result.contactId,
      text: result.messageText
    }).then(w => { confirmWindow = w }).catch(error => {
      logger.warn(`[Citas] Error en ventana de confirmación (QR): ${error.message}`)
    })

    if (!confirmWindow.windowActive) {
      await maybeConfirmAppointmentFromReply({
        contactId: result.contactId,
        text: result.messageText
      }).catch(error => {
        logger.warn(`[Citas] No se pudo evaluar confirmación automática (QR): ${error.message}`)
      })
    }

    const shouldBypass = confirmWindow.windowActive && confirmWindow.bypassAutomations

    if (result.contactId && !shouldBypass) {
      await import('./automationEngine.js')
        .then(engine => engine.handleIncomingMessage({
          contactId: result.contactId,
          phone: result.phone,
          contactName: result.contactName,
          text: result.messageText,
          messageType: result.messageType,
          channel: 'whatsapp',
          businessPhoneNumberId: result.businessPhoneNumberId || phoneRow?.id || null
        }))
        .catch(error => {
          logger.warn(`[Automatizaciones] No se pudo procesar el mensaje entrante (QR): ${error.message}`)
        })
    }

    if (result.contactId && !shouldBypass) {
      import('../agents/conversational/runner.js')
        .then(runner => runner.handleInboundMessageForConversationalAgent({
          contactId: result.contactId,
          phone: result.phone,
          messageId: result.messageId
        }))
        .catch(error => {
          logger.warn(`[Agente conversacional] No se pudo atender el mensaje entrante (QR): ${error.message}`)
        })
    }

    await sendChatMessageNotification({
      contactId: result.contactId,
      contactName: result.contactName,
      phone: result.phone,
      profileName: result.profileName,
      text: result.messageText,
      messageType: result.messageType,
      mediaUrl: result.mediaUrl || result.media_url || '',
      mediaFilename: result.mediaFilename || result.media_filename || '',
      mediaDurationMs: result.mediaDurationMs || result.media_duration_ms || null,
      voice: result.mediaIsVoice || result.media_is_voice || false,
      messageId: result.messageId,
      timestamp: result.messageTimestamp
    }).catch(error => {
      logger.warn(`[Push] No se pudo avisar mensaje WhatsApp QR ${result.messageId || ''}: ${error.message}`)
    })
  }

  return { skipped: false, ...result }
}

function directionFromCandidatePath(path = [], payload = {}) {
  const pathText = path.join('.').toLowerCase()
  const type = cleanString(payload.type)

  if (pathText.includes('inbound')) return 'inbound'
  if (pathText.includes('outbound')) return 'outbound'
  if (HISTORY_MESSAGE_EVENT_TYPES.has(type)) return ''
  if (pathText.includes('whatsappmessage') || pathText.includes('whatsapp_message')) return 'outbound'
  if (INBOUND_MESSAGE_EVENT_TYPES.has(type)) return 'inbound'
  if (OUTBOUND_MESSAGE_EVENT_TYPES.has(type)) return 'outbound'
  return ''
}

function isHistoryPayload(payload = {}) {
  return HISTORY_MESSAGE_EVENT_TYPES.has(cleanString(payload?.type)) ||
    cleanString(payload?.event).toLowerCase() === 'history'
}

function pickFirstPhone(values = []) {
  for (const value of values) {
    const phone = normalizePhoneComparable(value)
    if (phone) return phone
  }
  return ''
}

function getHistoryBusinessPhoneFromObject(value = {}) {
  if (!isPlainObject(value)) return ''
  const metadata = isPlainObject(value.metadata) ? value.metadata : {}
  const valueMetadata = isPlainObject(value.value?.metadata) ? value.value.metadata : {}
  const dataMetadata = isPlainObject(value.data?.metadata) ? value.data.metadata : {}

  return pickFirstPhone([
    metadata.display_phone_number,
    metadata.displayPhoneNumber,
    metadata.business_phone_number,
    metadata.businessPhoneNumber,
    valueMetadata.display_phone_number,
    valueMetadata.displayPhoneNumber,
    dataMetadata.display_phone_number,
    dataMetadata.displayPhoneNumber,
    value.businessPhone,
    value.business_phone,
    value.businessPhoneNumber,
    value.business_phone_number,
    value.senderPhoneNumber,
    value.sender_phone_number
  ])
}

function getHistoryCustomerPhoneFromObject(value = {}) {
  if (!isPlainObject(value)) return ''
  if (Array.isArray(value.messages) || Array.isArray(value.whatsappMessages)) {
    return pickFirstPhone([
      value.customerPhone,
      value.customer_phone,
      value.customer,
      value.phone,
      value.waId,
      value.wa_id,
      value.id
    ])
  }

  return pickFirstPhone([
    value.customerPhone,
    value.customer_phone,
    value.customer,
    value.contactPhone,
    value.contact_phone
  ])
}

function mergeHistoryContext(context = {}, value = {}) {
  const businessPhone = getHistoryBusinessPhoneFromObject(value)
  const customerPhone = getHistoryCustomerPhoneFromObject(value)

  return {
    businessPhone: businessPhone || context.businessPhone || '',
    customerPhone: customerPhone || context.customerPhone || ''
  }
}

function withHistoryMessageContext(message = {}, context = {}, payload = {}) {
  if (!isHistoryPayload(payload) || !isPlainObject(message)) return message

  const businessPhone = normalizePhoneComparable(
    message.businessPhone ||
    message.business_phone ||
    message.businessPhoneNumber ||
    message.business_phone_number ||
    context.businessPhone
  )
  const customerPhone = normalizePhoneComparable(
    message.customerPhone ||
    message.customer_phone ||
    message.customer ||
    message.phone ||
    context.customerPhone
  )

  if (!businessPhone && !customerPhone) return message

  const next = { ...message }
  if (businessPhone && !pickFirstPhone([next.businessPhone, next.business_phone, next.businessPhoneNumber, next.business_phone_number])) {
    next.businessPhone = businessPhone
  }
  if (customerPhone && !pickFirstPhone([next.customerPhone, next.customer_phone, next.customer, next.phone])) {
    next.customerPhone = customerPhone
  }

  const fromPhone = normalizePhoneComparable(next.from || next.fromPhone || next.from_phone || next.sender || next.senderPhone)
  const toPhone = normalizePhoneComparable(next.to || next.toPhone || next.to_phone || next.recipient || next.recipientPhone)
  const hasExplicitDirection = normalizeDirectionValue(next.direction || next.messageDirection || next.message_direction)

  if (businessPhone && customerPhone) {
    const fromIsBusiness = phoneMatches(fromPhone, businessPhone)
    const fromIsCustomer = phoneMatches(fromPhone, customerPhone)
    const toIsBusiness = phoneMatches(toPhone, businessPhone)
    const toIsCustomer = phoneMatches(toPhone, customerPhone)

    if (fromIsBusiness || toIsCustomer) {
      if (!hasExplicitDirection) next.direction = 'outbound'
      if (!toPhone) next.to = customerPhone
      if (!fromPhone) next.from = businessPhone
    } else if (fromIsCustomer || toIsBusiness) {
      if (!hasExplicitDirection) next.direction = 'inbound'
      if (!fromPhone) next.from = customerPhone
      if (!toPhone) next.to = businessPhone
    }
  }

  return next
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
    value.customer ||
    value.customerPhone ||
    value.customer_phone
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

function collectWhatsAppMessageCandidates(value, { payload, path = [], candidates = [], seen = new WeakSet(), historyContext = {} } = {}) {
  if (!value || typeof value !== 'object') return candidates
  if (seen.has(value)) return candidates
  seen.add(value)

  const nextHistoryContext = isHistoryPayload(payload)
    ? mergeHistoryContext(historyContext, value)
    : historyContext

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectWhatsAppMessageCandidates(item, {
      payload,
      path: [...path, String(index)],
      candidates,
      seen,
      historyContext: nextHistoryContext
    }))
    return candidates
  }

  if (looksLikeWhatsAppMessage(value) && !isMetadataPath(path)) {
    candidates.push({
      message: withHistoryMessageContext(value, nextHistoryContext, payload),
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
      seen,
      historyContext: nextHistoryContext
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
  const payloadBusinessPhone = getHistoryBusinessPhoneFromObject(payload)
  const effectiveBusinessPhoneHints = [
    ...businessPhoneHints,
    payloadBusinessPhone
  ].filter(Boolean)
  const candidates = extractWhatsAppMessageCandidates(payload)
  const results = []

  for (const candidate of candidates) {
    results.push(await upsertMessage({
      payload,
      message: candidate.message,
      direction: candidate.direction,
      businessPhoneHints: effectiveBusinessPhoneHints
    }))
  }

  return results
}

function getYCloudMessageRecordKey(record = {}) {
  return [
    cleanString(record.id || record.messageId || record.message_id || record.ycloudMessageId),
    cleanString(record.wamid || record.waMessageId || record.whatsappMessageId),
    cleanString(record.from || record.fromPhone || record.senderPhone),
    cleanString(record.to || record.toPhone || record.recipientPhone),
    cleanString(record.sendTime || record.createTime || record.updateTime || record.timestamp)
  ].join('|')
}

export async function syncYCloudMessageRecords(records = [], {
  businessPhoneHints = [],
  direction = '',
  eventType = 'whatsapp.smb.history',
  source = 'ycloud_history',
  seenKeys = null
} = {}) {
  const stats = {
    records: 0,
    messages: 0,
    created: 0,
    updated: 0,
    attributed: 0,
    skipped: 0,
    failed: 0
  }

  for (const record of Array.isArray(records) ? records : []) {
    if (!isPlainObject(record)) {
      stats.skipped += 1
      continue
    }

    const recordKey = getYCloudMessageRecordKey(record)
    if (seenKeys && recordKey && seenKeys.has(recordKey)) {
      stats.skipped += 1
      continue
    }
    if (seenKeys && recordKey) seenKeys.add(recordKey)

    const recordId = cleanString(record.id || record.messageId || record.message_id || record.ycloudMessageId)
    const messageAt = toDateTime(record.sendTime || record.createTime || record.updateTime || record.timestamp) || nowIso()
    const payload = {
      id: recordId ? `${source}_${recordId}` : hashId('ycloud_history_evt', safeJson(record)),
      type: eventType,
      apiVersion: 'v2',
      createTime: messageAt,
      origin: source,
      ...(eventType === 'whatsapp.inbound_message.received' || direction === 'inbound'
        ? { whatsappInboundMessage: record }
        : { whatsappMessage: record })
    }

    try {
      const result = await upsertMessage({
        payload,
        message: {
          ...record,
          origin: cleanString(record.origin) || source
        },
        direction,
        businessPhoneHints
      })
      stats.records += 1
      stats.messages += 1
      if (result?.isNew) stats.created += 1
      else stats.updated += 1
      if (result?.attribution?.hasAttribution) stats.attributed += 1
    } catch (error) {
      stats.failed += 1
      logger.warn(`No se pudo importar mensaje historico WhatsApp API ${recordId || recordKey || ''}: ${error.message}`)
    }
  }

  return stats
}

async function syncYCloudMessagesScope(apiKey, {
  query = {},
  businessPhoneHints = [],
  seenKeys,
  scopeName = 'all',
  maxPages = 100
} = {}) {
  const limit = 100
  const pageLimit = Math.max(1, Math.min(Number(maxPages) || 100, 100))
  const stats = {
    scope: scopeName,
    total: null,
    pages: 0,
    records: 0,
    messages: 0,
    created: 0,
    updated: 0,
    attributed: 0,
    skipped: 0,
    failed: 0,
    truncated: false
  }

  for (let page = 1; page <= pageLimit; page += 1) {
    const data = await ycloudRequest('/whatsapp/messages', {
      apiKey,
      query: {
        page,
        limit,
        includeTotal: true,
        ...query
      }
    })
    const items = extractYCloudPageItems(data)
    const total = getYCloudPageTotal(data)
    if (total !== null && stats.total === null) stats.total = total

    stats.pages += 1
    stats.records += items.length

    const pageStats = await syncYCloudMessageRecords(items, {
      businessPhoneHints,
      // YCloud's /whatsapp/messages list is the outbound message list.
      direction: 'outbound',
      eventType: 'whatsapp.message.updated',
      source: `ycloud_message_list_${scopeName}`,
      seenKeys
    })
    stats.messages += pageStats.messages
    stats.created += pageStats.created
    stats.updated += pageStats.updated
    stats.attributed += pageStats.attributed
    stats.skipped += pageStats.skipped
    stats.failed += pageStats.failed

    if (items.length < limit || (total !== null && stats.records >= total)) break
  }

  if (stats.total !== null && stats.records < stats.total && stats.pages >= pageLimit) {
    stats.truncated = true
  }

  return stats
}

async function syncYCloudMessagesFromApi(apiKey, { businessPhoneHints = [], wabaIds = [] } = {}) {
  const cleanWabaIds = [...new Set(wabaIds.map(cleanString).filter(Boolean))]
  const scopes = cleanWabaIds.length > 1
    ? cleanWabaIds.map(wabaId => ({
        name: `waba_${wabaId}`,
        query: { 'filter.wabaId': wabaId }
      }))
    : [{ name: 'all', query: cleanWabaIds[0] ? { 'filter.wabaId': cleanWabaIds[0] } : {} }]
  const seenKeys = new Set()
  const summary = {
    scopes: [],
    total: 0,
    pages: 0,
    records: 0,
    messages: 0,
    created: 0,
    updated: 0,
    attributed: 0,
    skipped: 0,
    failed: 0,
    truncated: false
  }

  for (const scope of scopes) {
    const stats = await syncYCloudMessagesScope(apiKey, {
      query: scope.query,
      businessPhoneHints,
      seenKeys,
      scopeName: scope.name
    })
    summary.scopes.push(stats)
    summary.total += Number(stats.total || 0)
    summary.pages += stats.pages
    summary.records += stats.records
    summary.messages += stats.messages
    summary.created += stats.created
    summary.updated += stats.updated
    summary.attributed += stats.attributed
    summary.skipped += stats.skipped
    summary.failed += stats.failed
    summary.truncated = summary.truncated || stats.truncated
  }

  if (summary.messages) {
    logger.info(`WhatsApp API sincronizo ${summary.messages} mensajes salientes desde YCloud (${summary.created} nuevos, ${summary.updated} actualizados).`)
  }
  if (summary.truncated) {
    logger.warn('WhatsApp API: YCloud limito el listado de /whatsapp/messages a 100 paginas. Los mensajes entrantes historicos dependen del webhook whatsapp.smb.history.')
  }

  return summary
}

async function syncYCloudMessagesPage(apiKey, {
  query = {},
  businessPhoneHints = [],
  scopeName = 'all',
  page = 1
} = {}) {
  const limit = 100
  const cleanPage = Math.max(1, Number(page) || 1)
  const data = await ycloudRequest('/whatsapp/messages', {
    apiKey,
    query: {
      page: cleanPage,
      limit,
      includeTotal: true,
      ...query
    }
  })
  const items = extractYCloudPageItems(data)
  const total = getYCloudPageTotal(data)
  const stats = await syncYCloudMessageRecords(items, {
    businessPhoneHints,
    direction: 'outbound',
    eventType: 'whatsapp.message.updated',
    source: `ycloud_message_list_${scopeName}`
  })
  const completed = items.length < limit || (total !== null && cleanPage * limit >= total)

  return {
    ...stats,
    page: cleanPage,
    total,
    records: items.length,
    completed,
    nextPage: completed ? null : cleanPage + 1
  }
}

function parseYCloudHistoryBackfillState(value) {
  const parsed = parseJsonValue(value, {})
  if (!isPlainObject(parsed) || parsed.version !== HISTORY_DIRECTION_REPAIR_VERSION) {
    return { page: 1, webhookUpdated: false, total: null }
  }

  return {
    page: Math.max(1, Number(parsed.page) || 1),
    webhookUpdated: parsed.webhookUpdated === true,
    total: Number.isFinite(Number(parsed.total)) ? Number(parsed.total) : null
  }
}

/**
 * Sincroniza una porción corta del historial saliente de YCloud y guarda la
 * siguiente página antes de devolver. Así el proceso se puede reanudar después
 * de un deploy sin volver a recorrer todos los mensajes ya importados.
 */
export async function runYCloudHistoryBackfillBatch({ maxPages = 3 } = {}) {
  const currentVersion = await getAppConfig(HISTORY_DIRECTION_REPAIR_CONFIG_KEY).catch(() => '')
  if (currentVersion === HISTORY_DIRECTION_REPAIR_VERSION) {
    return { skipped: true, reason: 'already_repaired', completed: true, pages: 0, messages: 0 }
  }

  const config = await loadConfig({ includeSecrets: true })
  if (!config.enabled || !config.apiKey) {
    return { skipped: true, reason: 'ycloud_disconnected', completed: false, pages: 0, messages: 0 }
  }

  const state = parseYCloudHistoryBackfillState(
    await getAppConfig(YCLOUD_HISTORY_BACKFILL_STATE_CONFIG_KEY).catch(() => '')
  )
  const businessPhoneHints = await getKnownBusinessPhoneHints(config)
  const wabaIds = [config.wabaId].filter(Boolean)
  const query = wabaIds[0] ? { 'filter.wabaId': wabaIds[0] } : {}
  const pageLimit = Math.max(1, Math.min(Number(maxPages) || 1, 5))
  let page = state.page
  let webhookUpdated = state.webhookUpdated
  let total = state.total
  const summary = {
    skipped: false,
    completed: false,
    pages: 0,
    messages: 0,
    created: 0,
    updated: 0,
    failed: 0,
    pageStart: page,
    pageEnd: page,
    total
  }

  if (!webhookUpdated) {
    const webhookSync = await refreshYCloudWebhookEndpoint(config)
    if (webhookSync.skipped) {
      throw new Error('YCloud no tiene una URL pública de webhook para actualizar los ecos de WhatsApp Business App')
    }
    webhookUpdated = true
    await setAppConfig(YCLOUD_HISTORY_BACKFILL_STATE_CONFIG_KEY, safeJson({
      version: HISTORY_DIRECTION_REPAIR_VERSION,
      page,
      webhookUpdated,
      total,
      updatedAt: nowIso()
    }))
  }

  for (let index = 0; index < pageLimit; index += 1) {
    const result = await syncYCloudMessagesPage(config.apiKey, {
      query,
      businessPhoneHints,
      scopeName: wabaIds[0] ? `waba_${wabaIds[0]}` : 'all',
      page
    })
    total = result.total ?? total
    summary.pages += 1
    summary.messages += result.messages
    summary.created += result.created
    summary.updated += result.updated
    summary.failed += result.failed
    summary.pageEnd = result.page
    summary.total = total

    if (result.completed) {
      summary.completed = true
      await setAppConfig(HISTORY_DIRECTION_REPAIR_CONFIG_KEY, HISTORY_DIRECTION_REPAIR_VERSION)
      await setAppConfig(YCLOUD_HISTORY_BACKFILL_STATE_CONFIG_KEY, '')
      logger.info(`WhatsApp API completó backfill YCloud: ${summary.messages} mensajes en páginas ${summary.pageStart}-${summary.pageEnd}.`)
      return summary
    }

    page = result.nextPage
  }

  await setAppConfig(YCLOUD_HISTORY_BACKFILL_STATE_CONFIG_KEY, safeJson({
    version: HISTORY_DIRECTION_REPAIR_VERSION,
    page,
    webhookUpdated,
    total,
    updatedAt: nowIso()
  }))
  logger.info(`WhatsApp API avanzó backfill YCloud: páginas ${summary.pageStart}-${summary.pageEnd}; continúa en ${page}.`)
  return summary
}

async function backfillStoredWhatsAppApiMessageEvents({ businessPhoneHints = [], limit = 0, eventTypes = [...MESSAGE_EVENT_TYPES] } = {}) {
  const cleanEventTypes = [...new Set((Array.isArray(eventTypes) ? eventTypes : [])
    .map(cleanString)
    .filter(Boolean))]
  if (!cleanEventTypes.length) {
    return { events: 0, messages: 0 }
  }

  const placeholders = cleanEventTypes.map(() => '?').join(', ')
  const cleanLimit = Math.max(Number(limit) || 0, 0)
  const rows = await db.all(`
    SELECT id, event_type, raw_payload_json
    FROM whatsapp_api_webhook_events
    WHERE event_type IN (${placeholders})
    ORDER BY COALESCE(ycloud_create_time, created_at) ASC, id ASC
    ${cleanLimit ? 'LIMIT ?' : ''}
  `, cleanLimit ? [...cleanEventTypes, cleanLimit] : cleanEventTypes)

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

export async function repairStoredYCloudHistoryMessageDirections({ force = false, limit = 0 } = {}) {
  if (!force) {
    const currentVersion = await getAppConfig(HISTORY_DIRECTION_REPAIR_CONFIG_KEY).catch(() => '')
    if (currentVersion === HISTORY_DIRECTION_REPAIR_VERSION) {
      return { skipped: true, reason: 'already_repaired', events: 0, messages: 0, outboundMessages: 0 }
    }
  }

  const config = await loadConfig({ includeSecrets: true }).catch(error => {
    logger.warn(`No se pudo cargar configuración WhatsApp API para reparación de historial: ${error.message}`)
    return {}
  })
  const businessPhoneHints = await getKnownBusinessPhoneHints(config).catch(error => {
    logger.warn(`No se pudieron cargar números WhatsApp API para reparación de historial: ${error.message}`)
    return []
  })

  const result = await backfillStoredWhatsAppApiMessageEvents({
    businessPhoneHints,
    limit,
    eventTypes: [...HISTORY_MESSAGE_EVENT_TYPES, ...OUTBOUND_MESSAGE_EVENT_TYPES]
  })

  let outboundSync = null
  let webhookSync = { skipped: true, reason: 'ycloud_disconnected' }
  let backfillCompleted = true
  if (config.enabled && config.apiKey) {
    try {
      webhookSync = await refreshYCloudWebhookEndpoint(config)
      if (webhookSync.skipped) {
        backfillCompleted = false
        logger.warn('WhatsApp API omitio la actualizacion del webhook YCloud: falta la URL publica del endpoint.')
      }
    } catch (error) {
      backfillCompleted = false
      const webhookSetupWarning = buildWebhookSetupWarning(error)
      await setAppConfig(CONFIG_KEYS.webhookStatus, 'pending')
      await setAppConfig(CONFIG_KEYS.lastError, webhookSetupWarning)
      logger.warn(`No se pudo actualizar webhook YCloud durante backfill: ${error.message}`)
    }

    const wabaIds = [config.wabaId].filter(Boolean)
    try {
      outboundSync = await syncYCloudMessagesFromApi(config.apiKey, {
        businessPhoneHints,
        wabaIds
      })
    } catch (error) {
      backfillCompleted = false
      logger.warn(`No se pudo corregir historial saliente desde YCloud durante reparación: ${error.message}`)
      outboundSync = { messages: 0, created: 0, updated: 0, failed: 0 }
    }
  }

  await repairWhatsAppApiContactIdentityFromMessages().catch(error => {
    logger.warn(`No se pudo reparar identidad tras recalcular historial WhatsApp API: ${error.message}`)
  })
  if (backfillCompleted) {
    await setAppConfig(HISTORY_DIRECTION_REPAIR_CONFIG_KEY, HISTORY_DIRECTION_REPAIR_VERSION)
  }

  if (result.events) {
    logger.info(`WhatsApp API recalculo dirección de historial guardado: ${result.messages} mensajes en ${result.events} eventos.`)
  }
  if (outboundSync?.messages) {
    logger.info(`WhatsApp API recalculo historial saliente desde YCloud: ${outboundSync.messages} mensajes (${outboundSync.updated} actualizados, ${outboundSync.created} nuevos).`)
  }

  return {
    skipped: false,
    completed: backfillCompleted,
    ...result,
    webhookUpdated: webhookSync.skipped === false,
    webhookSkipReason: webhookSync.skipped ? webhookSync.reason : '',
    outboundMessages: outboundSync?.messages || 0,
    outboundCreated: outboundSync?.created || 0,
    outboundUpdated: outboundSync?.updated || 0,
    outboundFailed: outboundSync?.failed || 0
  }
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
      processedError: 'Firma de WhatsApp API inválida'
    })
    const error = new Error('Firma de WhatsApp API inválida')
    error.statusCode = 401
    throw error
  }

  // (WA-001) Rollout seguro de firma de webhooks: si NO hay webhook_secret configurado
  // aún (cuentas YCloud sin permiso para crear webhooks), aceptamos el payload para no
  // romper integraciones en vivo, pero dejamos un warning visible de que el endpoint
  // está aceptando webhooks sin verificar firma. Cuando exista secret, el bloque de
  // arriba (signatureValid === false) ya rechaza con 401.
  if (signatureValid === null) {
    logger.warn('[WhatsApp API] Webhook YCloud aceptado SIN verificación de firma: no hay webhook_secret configurado. Configura el secreto para firmar y proteger este endpoint.')
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

    const inboundResults = messageResults.filter(result => result?.direction === 'inbound' && result?.isNew !== false)
    inboundResults.forEach(result => scheduleInboundWhatsAppContactProfilePictureRefresh(result, 'ycloud_webhook'))

    // Ventanas de confirmación con IA: registrar mensajes y obtener estado de bypass.
    const confirmWindows = new Map()
    await Promise.all(inboundResults
      .map(result => handleInboundForConfirmation({
        contactId: result.contactId,
        text: result.messageText
      }).then(w => { confirmWindows.set(result.contactId, w) })
        .catch(error => {
          logger.warn(`[Citas] Error en ventana de confirmación: ${error.message}`)
        })))

    await Promise.all(inboundResults
      .map(result => {
        const win = confirmWindows.get(result.contactId)
        if (win?.windowActive) return Promise.resolve()
        return maybeConfirmAppointmentFromReply({
          contactId: result.contactId,
          text: result.messageText
        }).catch(error => {
          logger.warn(`[Citas] No se pudo evaluar confirmación automática: ${error.message}`)
        })
      }))

    // Motor de automatizaciones: disparar/reanudar flujos con cada mensaje
    // entrante (import dinámico para evitar dependencia circular)
    Promise.all(inboundResults
      .filter(result => {
        const win = confirmWindows.get(result.contactId)
        return !(win?.windowActive && win?.bypassAutomations)
      })
      .map(result => import('./automationEngine.js')
        .then(engine => engine.handleIncomingMessage({
          contactId: result.contactId,
          phone: result.phone,
          contactName: result.contactName,
          text: result.messageText,
          messageType: result.messageType,
          buttonId: result.buttonId,
          buttonPayload: result.buttonPayload,
          buttonTitle: result.buttonTitle,
          buttonReplyType: result.buttonReplyType,
          channel: 'whatsapp',
          businessPhoneNumberId: result.businessPhoneNumberId || null
        }))
        .catch(error => {
          logger.warn(`[Automatizaciones] No se pudo procesar el mensaje entrante: ${error.message}`)
        }))).catch(() => {})

    // Agente conversacional: atiende la conversación si está activado
    // (import dinámico para evitar dependencia circular)
    Promise.all(inboundResults
      .filter(result => result?.contactId)
      .filter(result => {
        const win = confirmWindows.get(result.contactId)
        return !(win?.windowActive && win?.bypassAutomations)
      })
      .map(result => import('../agents/conversational/runner.js')
        .then(runner => runner.handleInboundMessageForConversationalAgent({
          contactId: result.contactId,
          phone: result.phone,
          messageId: result.messageId
        }))
        .catch(error => {
          logger.warn(`[Agente conversacional] No se pudo atender el mensaje entrante: ${error.message}`)
        }))).catch(() => {})

    await Promise.all(inboundResults
      .map(result => sendChatMessageNotification({
        contactId: result.contactId,
        contactName: result.contactName,
        phone: result.phone,
        profileName: result.profileName,
        text: result.messageText,
        messageType: result.messageType,
        mediaUrl: result.mediaUrl || result.media_url || '',
        mediaFilename: result.mediaFilename || result.media_filename || '',
        mediaDurationMs: result.mediaDurationMs || result.media_duration_ms || null,
        voice: result.mediaIsVoice || result.media_is_voice || false,
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

export async function createMetaDirectConnectUrl({ appUrl } = {}) {
  const runtime = await getLicenseRuntimeConfig({ appUrl })
  if (!runtime.licenseKey) {
    throw new Error('Falta la licencia local para iniciar la conexión directa con Meta')
  }

  const issuedAt = Date.now()
  const state = encodeSignedState({
    client_id: runtime.clientId,
    installation_id: runtime.installationId,
    app_url: runtime.appUrl,
    nonce: crypto.randomUUID(),
    iat: issuedAt,
    exp: issuedAt + 15 * 60 * 1000
  }, runtime.licenseKey)

  const installerUrl = normalizePublicBaseUrl(
    process.env.META_WHATSAPP_PORTAL_URL ||
    process.env.META_WHATSAPP_PUBLIC_URL ||
    DEFAULT_INSTALLER_PUBLIC_URL
  )
  const url = new URL('/meta/whatsapp/connect', installerUrl)
  url.searchParams.set('state', state)

  return {
    url: url.toString(),
    expiresAt: new Date(issuedAt + 15 * 60 * 1000).toISOString()
  }
}

export async function getMetaDirectSetupPrefill({ payload = {}, rawBody = '', headers = {} } = {}) {
  await verifyInstallerSignedRequest({ rawBody, headers, purpose: 'meta_setup_prefill' })

  const runtime = await getLicenseRuntimeConfig()
  const statePayload = decodeSignedState(payload.state || payload.signed_state || '', runtime.licenseKey)
  if (cleanString(statePayload.installation_id) !== runtime.installationId && runtime.installationId !== 'local') {
    throw new Error('La conexión pertenece a otra instalación de Ristak')
  }

  const [metaDirect, metaConfig, savedWabaId] = await Promise.all([
    loadMetaDirectConfig({ includeSecrets: true }),
    getMetaConfig().catch(error => {
      logger.warn(`No se pudo leer Meta local para prellenar WhatsApp: ${error.message}`)
      return null
    }),
    getAppConfig('meta_whatsapp_business_account_id').catch(() => '')
  ])

  const systemUserToken = cleanString(metaDirect.systemUserToken || metaConfig?.access_token)
  const wabaId = cleanString(metaDirect.wabaId || savedWabaId)
  const datasetId = cleanString(metaDirect.datasetId || metaConfig?.pixel_id)
  const adAccountId = cleanString(metaDirect.adAccountId || metaConfig?.ad_account_id)

  return {
    available: Boolean(systemUserToken || wabaId || datasetId || adAccountId),
    source: metaDirect.hasSystemUserToken ? 'whatsapp_meta_direct' : (metaConfig?.access_token ? 'meta_config' : ''),
    appId: cleanString(metaDirect.appId || metaConfig?.app_id),
    appSecret: cleanString(metaConfig?.app_secret),
    systemUserToken,
    systemUserTokenConfigured: Boolean(systemUserToken),
    businessId: cleanString(metaDirect.businessId),
    wabaId,
    phoneNumberId: cleanString(metaDirect.phoneNumberId),
    displayPhoneNumber: cleanString(metaDirect.displayPhoneNumber),
    datasetId,
    adAccountId,
    pageId: cleanString(metaConfig?.page_id),
    instagramAccountId: cleanString(metaConfig?.instagram_account_id)
  }
}

export async function completeMetaDirectConnection({ payload = {}, rawBody = '', headers = {} } = {}) {
  await verifyInstallerSignedRequest({ rawBody, headers, purpose: 'meta_connect_complete' })

  const runtime = await getLicenseRuntimeConfig()
  const statePayload = decodeSignedState(payload.state || payload.signed_state || '', runtime.licenseKey)
  if (cleanString(statePayload.installation_id) !== runtime.installationId && runtime.installationId !== 'local') {
    throw new Error('La conexión pertenece a otra instalación de Ristak')
  }

  const systemUserToken = cleanString(payload.systemUserToken || payload.system_user_token)
  const appId = cleanString(payload.appId || payload.app_id)
  const businessId = cleanString(payload.businessId || payload.business_id)
  const wabaId = cleanString(payload.wabaId || payload.waba_id)
  const phoneNumberId = cleanString(payload.phoneNumberId || payload.phone_number_id)
  const displayPhoneNumber = normalizePhoneForStorage(payload.displayPhoneNumber || payload.display_phone_number) ||
    cleanString(payload.displayPhoneNumber || payload.display_phone_number)

  if (!systemUserToken) throw new Error('Falta el System User Token de Meta')
  if (!wabaId) throw new Error('Falta el WABA ID de Meta')
  if (!phoneNumberId) throw new Error('Falta el Phone Number ID de Meta')

  await subscribeMetaDirectWaba({ wabaId, token: systemUserToken })

  await setAppConfig(CONFIG_KEYS.metaStatus, 'connected')
  await setAppConfig(CONFIG_KEYS.metaAppId, appId)
  await setAppConfig(CONFIG_KEYS.metaBusinessId, businessId)
  await setAppConfig(CONFIG_KEYS.metaWabaId, wabaId)
  await setAppConfig(CONFIG_KEYS.metaPhoneNumberId, phoneNumberId)
  await setAppConfig(CONFIG_KEYS.metaDisplayPhoneNumber, displayPhoneNumber)
  await setAppConfig(CONFIG_KEYS.metaCoexistenceEnabled, payload.coexistenceEnabled === false ? '0' : '1')
  await setAppConfig(CONFIG_KEYS.metaWebhookMode, 'installer_relay')
  await setAppConfig(CONFIG_KEYS.metaInstallerWebhookUrl, cleanString(payload.installerWebhookUrl || payload.installer_webhook_url))
  await setAppConfig(CONFIG_KEYS.metaInstallerOAuthCallbackUrl, cleanString(payload.installerOAuthCallbackUrl || payload.installer_oauth_callback_url))
  await setAppConfig(CONFIG_KEYS.metaDatasetId, cleanString(payload.datasetId || payload.dataset_id))
  await setAppConfig(CONFIG_KEYS.metaAdAccountId, cleanString(payload.adAccountId || payload.ad_account_id))
  await setAppConfig(CONFIG_KEYS.metaConnectedAt, nowIso())
  await setAppConfig(CONFIG_KEYS.metaDisconnectedAt, '')
  await setAppConfig(CONFIG_KEYS.metaLastError, '')
  await setEncryptedConfig(CONFIG_KEYS.metaSystemUserToken, systemUserToken)

  await db.run(`
    INSERT INTO whatsapp_api_phone_numbers (
      id, provider, waba_id, phone_number, display_phone_number, verified_name,
      status, raw_payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'CONNECTED', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      provider = excluded.provider,
      waba_id = excluded.waba_id,
      phone_number = COALESCE(NULLIF(excluded.phone_number, ''), whatsapp_api_phone_numbers.phone_number),
      display_phone_number = COALESCE(NULLIF(excluded.display_phone_number, ''), whatsapp_api_phone_numbers.display_phone_number),
      verified_name = COALESCE(NULLIF(excluded.verified_name, ''), whatsapp_api_phone_numbers.verified_name),
      status = 'CONNECTED',
      raw_payload_json = excluded.raw_payload_json,
      updated_at = CURRENT_TIMESTAMP
  `, [
    phoneNumberId,
    META_DIRECT_PROVIDER_NAME,
    wabaId,
    displayPhoneNumber || null,
    cleanString(payload.displayPhoneNumber || payload.display_phone_number) || displayPhoneNumber || null,
    cleanString(payload.verifiedName || payload.verified_name) || 'Meta directo',
    safeJson({
      appId,
      businessId,
      wabaId,
      phoneNumberId,
      displayPhoneNumber,
      source: META_DIRECT_PROVIDER_NAME
    })
  ])

  return getWhatsAppApiStatus()
}

export async function disconnectMetaDirectConnection() {
  await clearWhatsAppMetaDirectIntegrationCredentials()
  await setAppConfig(CONFIG_KEYS.metaStatus, 'disconnected')
  await setAppConfig(CONFIG_KEYS.metaDisconnectedAt, nowIso())

  const activeProvider = await getAppConfig(CONFIG_KEYS.provider)
  if (activeProvider === META_DIRECT_PROVIDER_NAME) {
    await setAppConfig(CONFIG_KEYS.provider, PROVIDER_NAME)
  }

  return getWhatsAppApiStatus()
}

export async function setWhatsAppActiveProvider({ provider } = {}) {
  const cleanProvider = cleanString(provider)
  if (![PROVIDER_NAME, META_DIRECT_PROVIDER_NAME].includes(cleanProvider)) {
    throw new Error('Proveedor de WhatsApp inválido')
  }

  if (cleanProvider === META_DIRECT_PROVIDER_NAME) {
    const metaConfig = await loadMetaDirectConfig()
    if (!metaConfig.connected) throw new Error('Primero conecta Meta directo')
  }

  await setAppConfig(CONFIG_KEYS.provider, cleanProvider)
  return getWhatsAppApiStatus()
}

async function metaDirectGraphRequest(path, { method = 'GET', token, query, body } = {}) {
  const cleanToken = cleanString(token)
  if (!cleanToken) throw new Error('Falta el token de Meta directo')
  const url = new URL(`${META_GRAPH_BASE_URL}${path}`)
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }

  const response = await metaDirectFetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${cleanToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data?.error?.message || `Meta Graph respondió ${response.status}`)
  }
  return data
}

async function subscribeMetaDirectWaba({ wabaId, token } = {}) {
  const cleanWabaId = cleanString(wabaId)
  if (!cleanWabaId) throw new Error('Falta el WABA ID de Meta')

  await metaDirectGraphRequest(`/${encodeURIComponent(cleanWabaId)}/subscribed_apps`, {
    method: 'POST',
    token,
    body: {}
  })
  logger.info(`[Meta directo] App suscrita a webhooks de WABA ${cleanWabaId}`)
}

export async function testMetaDirectConnection() {
  const config = await loadMetaDirectConfig({ includeSecrets: true })
  if (!config.connected) throw new Error('Meta directo no está conectado')
  const phone = await metaDirectGraphRequest(`/${encodeURIComponent(config.phoneNumberId)}`, {
    token: config.systemUserToken,
    query: { fields: 'id,display_phone_number,verified_name,quality_rating,messaging_limit_tier' }
  })

  if (phone.display_phone_number || phone.verified_name) {
    await db.run(`
      UPDATE whatsapp_api_phone_numbers
      SET display_phone_number = COALESCE(?, display_phone_number),
        verified_name = COALESCE(?, verified_name),
        quality_rating = COALESCE(?, quality_rating),
        messaging_limit = COALESCE(?, messaging_limit),
        raw_payload_json = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      phone.display_phone_number || null,
      phone.verified_name || null,
      phone.quality_rating || null,
      phone.messaging_limit_tier || null,
      safeJson(phone),
      config.phoneNumberId
    ])
  }

  await setAppConfig(CONFIG_KEYS.metaLastError, '')
  return { ok: true, phone }
}

export async function syncMetaDirectHistory() {
  return {
    synced: false,
    status: 'not_available',
    message: 'Meta no entrega historial completo por Graph API en este flujo. Los mensajes nuevos se sincronizan por webhook relay.'
  }
}

function normalizeMetaMessageBody(message = {}) {
  if (message.text?.body) return message.text.body
  if (message.button?.text) return message.button.text
  if (message.interactive?.button_reply?.title) return message.interactive.button_reply.title
  if (message.interactive?.list_reply?.title) return message.interactive.list_reply.title
  if (message.image?.caption) return message.image.caption
  if (message.document?.caption) return message.document.caption
  if (message.video?.caption) return message.video.caption
  return ''
}

function normalizeMetaWebhookMessages(payload = {}, config = {}) {
  const results = []
  const entries = Array.isArray(payload.entry) ? payload.entry : []

  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : []
    for (const change of changes) {
      const field = cleanString(change.field)
      const value = change.value || {}
      const metadata = value.metadata || {}
      const businessPhone = normalizePhoneForStorage(metadata.display_phone_number || config.displayPhoneNumber) ||
        cleanString(metadata.display_phone_number || config.displayPhoneNumber)
      const phoneNumberId = cleanString(metadata.phone_number_id || config.phoneNumberId)
      const wabaId = cleanString(entry.id || value.whatsapp_business_account_id || config.wabaId)

      for (const message of Array.isArray(value.messages) ? value.messages : []) {
        const direction = field === 'smb_message_echoes' || message.from_me || message.business_echo
          ? 'business_echo'
          : 'inbound'
        const messageType = cleanString(message.type) || 'unknown'
        results.push({
          direction,
          message: {
            ...message,
            id: message.id,
            wamid: message.id,
            metaMessageId: message.id,
            provider: META_DIRECT_PROVIDER_NAME,
            origin: field || 'messages',
            wabaId,
            from: direction === 'inbound' ? message.from : businessPhone,
            to: direction === 'inbound' ? businessPhone : (message.to || message.recipient_id),
            type: messageType,
            status: direction === 'business_echo' ? 'sent' : cleanString(message.status),
            sendTime: message.timestamp,
            text: normalizeMetaMessageBody(message) ? { body: normalizeMetaMessageBody(message) } : message.text,
            businessEcho: direction === 'business_echo',
            phoneNumberId
          }
        })
      }

      const echoes = Array.isArray(value.smb_message_echoes)
        ? value.smb_message_echoes
        : Array.isArray(value.message_echoes)
          ? value.message_echoes
          : []
      for (const echo of echoes) {
        results.push({
          direction: 'business_echo',
          message: {
            ...echo,
            id: echo.id || echo.message_id,
            wamid: echo.id || echo.message_id,
            metaMessageId: echo.id || echo.message_id,
            provider: META_DIRECT_PROVIDER_NAME,
            origin: field || 'smb_message_echoes',
            wabaId,
            from: businessPhone,
            to: echo.to || echo.recipient_id || echo.from,
            type: cleanString(echo.type) || 'text',
            status: cleanString(echo.status) || 'sent',
            sendTime: echo.timestamp,
            text: normalizeMetaMessageBody(echo) ? { body: normalizeMetaMessageBody(echo) } : echo.text,
            businessEcho: true,
            phoneNumberId
          }
        })
      }

      for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
        results.push({
          direction: 'outbound',
          message: {
            id: status.id,
            wamid: status.id,
            metaMessageId: status.id,
            provider: META_DIRECT_PROVIDER_NAME,
            origin: field || 'statuses',
            wabaId,
            from: businessPhone,
            to: status.recipient_id,
            type: 'status',
            status: status.status,
            sendTime: status.timestamp,
            errors: status.errors,
            phoneNumberId
          }
        })
      }
    }
  }

  return results
}

async function processMetaDirectWebhookPayload({ payload = {}, eventRowId = '' } = {}) {
  const config = await loadMetaDirectConfig()
  const businessPhoneHints = await getKnownBusinessPhoneHints({
    senderPhone: config.displayPhoneNumber,
    phoneNumberId: config.phoneNumberId,
    wabaId: config.wabaId
  })
  const normalized = normalizeMetaWebhookMessages(payload, config)
  const results = []

  for (const item of normalized) {
    const result = await upsertMessage({
      payload: {
        ...payload,
        id: payload.id || eventRowId,
        provider: META_DIRECT_PROVIDER_NAME,
        origin: item.message.origin,
        field: item.message.origin,
        relayEventId: eventRowId
      },
      message: item.message,
      direction: item.direction,
      businessPhoneHints,
      transport: 'api'
    })
    results.push(result)
  }

  const alertFields = new Set([
    'message_template_status_update',
    'template_category_update',
    'message_template_quality_update',
    'account_update',
    'account_alerts',
    'account_review_update',
    'business_status_update',
    'phone_number_quality_update',
    'phone_number_name_update',
    'business_capability_update'
  ])
  const entries = Array.isArray(payload.entry) ? payload.entry : []
  for (const entry of entries) {
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      if (!alertFields.has(cleanString(change.field))) continue
      await upsertAlert({
        severity: change.field.includes('quality') ? 'warning' : 'info',
        alertType: `meta_direct_${change.field}`,
        title: 'Actualización de Meta directo',
        message: cleanString(change.value?.event || change.value?.new_status || change.value?.message_template_name || change.field),
        sourceEventId: eventRowId,
        entityType: change.field,
        entityId: cleanString(change.value?.message_template_id || change.value?.phone_number_id || entry.id || change.field),
        raw: change.value || change
      })
    }
  }

  await setAppConfig(CONFIG_KEYS.metaLastWebhookReceivedAt, nowIso())
  return results
}

export async function processMetaDirectWebhookRelay({ payload = {}, rawBody = '', headers = {} } = {}) {
  await verifyInstallerSignedRequest({ rawBody, headers, purpose: 'meta_webhook_relay' })
  const eventRowId = await saveWebhookEvent({
    payload: {
      ...payload,
      id: payload.id || payload.event_id || hashId('meta_evt', rawBody || safeJson(payload)),
      type: cleanString(payload.type) || 'meta.direct.webhook',
      apiVersion: META_GRAPH_VERSION
    },
    rawBody,
    endpointId: headers.installationId || 'installer_relay',
    signatureValid: true,
    processedStatus: 'received'
  })

  try {
    const messageResults = await processMetaDirectWebhookPayload({ payload, eventRowId })
    const inboundResults = messageResults.filter(result => result?.direction === 'inbound' && result?.isNew !== false)
    inboundResults.forEach(result => scheduleInboundWhatsAppContactProfilePictureRefresh(result, 'meta_direct_webhook'))
    const confirmWindows = new Map()

    await Promise.all(inboundResults.map(result => handleInboundForConfirmation({
      contactId: result.contactId,
      text: result.messageText
    }).then(w => { confirmWindows.set(result.contactId, w) }).catch(error => {
      logger.warn(`[Citas] Error en ventana Meta directo: ${error.message}`)
    })))

    await Promise.all(inboundResults.map(result => {
      const win = confirmWindows.get(result.contactId)
      if (win?.windowActive) return Promise.resolve()
      return maybeConfirmAppointmentFromReply({
        contactId: result.contactId,
        text: result.messageText
      }).catch(error => logger.warn(`[Citas] No se pudo evaluar Meta directo: ${error.message}`))
    }))

    Promise.all(inboundResults
      .filter(result => {
        const win = confirmWindows.get(result.contactId)
        return !(win?.windowActive && win?.bypassAutomations)
      })
      .map(result => import('./automationEngine.js')
        .then(engine => engine.handleIncomingMessage({
          contactId: result.contactId,
          phone: result.phone,
          contactName: result.contactName,
          text: result.messageText,
          messageType: result.messageType,
          buttonId: result.buttonId,
          buttonPayload: result.buttonPayload,
          buttonTitle: result.buttonTitle,
          buttonReplyType: result.buttonReplyType,
          channel: 'whatsapp',
          businessPhoneNumberId: result.businessPhoneNumberId || null
        }))
        .catch(error => logger.warn(`[Automatizaciones] Meta directo no pudo procesar mensaje: ${error.message}`)))).catch(() => {})

    Promise.all(inboundResults
      .filter(result => result?.contactId)
      .filter(result => {
        const win = confirmWindows.get(result.contactId)
        return !(win?.windowActive && win?.bypassAutomations)
      })
      .map(result => import('../agents/conversational/runner.js')
        .then(runner => runner.handleInboundMessageForConversationalAgent({
          contactId: result.contactId,
          phone: result.phone,
          messageId: result.messageId
        }))
        .catch(error => logger.warn(`[Agente conversacional] Meta directo no pudo atender: ${error.message}`)))).catch(() => {})

    await Promise.all(inboundResults.map(result => sendChatMessageNotification({
      contactId: result.contactId,
      contactName: result.contactName,
      phone: result.phone,
      profileName: result.profileName,
      text: result.messageText,
      messageType: result.messageType,
      mediaUrl: result.mediaUrl || result.media_url || '',
      mediaFilename: result.mediaFilename || result.media_filename || '',
      mediaDurationMs: result.mediaDurationMs || result.media_duration_ms || null,
      voice: result.mediaIsVoice || result.media_is_voice || false,
      messageId: result.messageId,
      timestamp: result.messageTimestamp
    }).catch(error => {
      logger.warn(`[Push] No se pudo avisar mensaje Meta directo ${result?.messageId || ''}: ${error.message}`)
    })))

    await db.run(`
      UPDATE whatsapp_api_webhook_events
      SET processed_status = 'processed', processed_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [eventRowId])
    await setAppConfig(CONFIG_KEYS.metaLastRelayReceivedAt, nowIso())

    return { processed: true, eventId: eventRowId, messages: messageResults.length }
  } catch (error) {
    await setAppConfig(CONFIG_KEYS.metaLastError, error.message)
    await db.run(`
      UPDATE whatsapp_api_webhook_events
      SET processed_status = 'error', processed_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [error.message, eventRowId])
    throw error
  }
}

async function sendTextViaMetaDirect({ to, text, from, externalId, replyContext = null } = {}) {
  const config = await loadMetaDirectConfig({ includeSecrets: true })
  if (!config.connected) throw new Error('Meta directo no está conectado')
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const body = cleanString(text)
  if (!toPhone) throw new Error('Falta el número destino')
  if (!body) throw new Error('Falta el texto del mensaje')

  return metaDirectGraphRequest(`/${encodeURIComponent(config.phoneNumberId)}/messages`, {
    method: 'POST',
    token: config.systemUserToken,
    body: {
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'text',
      text: { body },
      ...(replyContext?.message_id ? { context: replyContext } : {}),
      ...(externalId ? { biz_opaque_callback_data: externalId } : {})
    }
  })
}

async function sendReactionViaMetaDirect({ to, emoji, from, externalId, targetProviderMessageId } = {}) {
  const config = await loadMetaDirectConfig({ includeSecrets: true })
  if (!config.connected) throw new Error('Meta directo no está conectado')
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const reactionEmoji = cleanString(emoji)
  const targetId = cleanString(targetProviderMessageId)
  if (!toPhone) throw new Error('Falta el número destino')
  if (!reactionEmoji) throw new Error('Falta la reacción')
  if (!targetId) throw new Error('Falta el mensaje original para reaccionar')

  const response = await metaDirectGraphRequest(`/${encodeURIComponent(config.phoneNumberId)}/messages`, {
    method: 'POST',
    token: config.systemUserToken,
    body: {
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'reaction',
      reaction: {
        message_id: targetId,
        emoji: reactionEmoji
      },
      ...(externalId ? { biz_opaque_callback_data: externalId } : {})
    }
  })
  const message = Array.isArray(response?.messages) ? response.messages[0] : null
  const contact = Array.isArray(response?.contacts) ? response.contacts[0] : null
  const messageId = cleanString(response?.id || response?.messageId || response?.message_id || message?.id)

  return {
    ...response,
    id: messageId || cleanString(externalId),
    wamid: cleanString(response?.wamid || response?.waMessageId || message?.id) || messageId || null,
    status: cleanString(response?.status || message?.message_status) || 'sent',
    from: normalizePhoneForStorage(config.displayPhoneNumber || from) || cleanString(config.displayPhoneNumber || from),
    to: normalizePhoneForStorage(contact?.input || toPhone) || cleanString(contact?.input || toPhone),
    type: 'reaction',
    reaction: {
      message_id: targetId,
      emoji: reactionEmoji
    },
    context: {
      id: targetId
    },
    transport: 'api'
  }
}

async function sendLocationViaMetaDirect({ to, location, from, externalId } = {}) {
  const config = await loadMetaDirectConfig({ includeSecrets: true })
  if (!config.connected) throw new Error('Meta directo no está conectado')
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  if (!toPhone) throw new Error('Falta el número destino')
  if (!location) throw new Error('Faltan coordenadas válidas para la ubicación')

  const response = await metaDirectGraphRequest(`/${encodeURIComponent(config.phoneNumberId)}/messages`, {
    method: 'POST',
    token: config.systemUserToken,
    body: {
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'location',
      location: {
        latitude: location.latitude,
        longitude: location.longitude,
        ...(location.name ? { name: location.name } : {}),
        ...(location.address ? { address: location.address } : {})
      },
      ...(externalId ? { biz_opaque_callback_data: externalId } : {})
    }
  })

  const message = Array.isArray(response?.messages) ? response.messages[0] : null
  const contact = Array.isArray(response?.contacts) ? response.contacts[0] : null
  const messageId = cleanString(response?.id || response?.messageId || response?.message_id || message?.id)

  return {
    ...response,
    id: messageId || cleanString(externalId),
    wamid: cleanString(response?.wamid || response?.waMessageId || message?.id) || messageId || null,
    status: cleanString(response?.status || message?.message_status) || 'sent',
    from: normalizePhoneForStorage(config.displayPhoneNumber || from) || cleanString(config.displayPhoneNumber || from),
    to: normalizePhoneForStorage(contact?.input || toPhone) || cleanString(contact?.input || toPhone),
    type: 'location',
    transport: 'api',
    location
  }
}

export async function sendMetaDirectTestMessage({ to, text } = {}) {
  return sendTextViaMetaDirect({ to, text: text || 'Prueba de WhatsApp directo desde Ristak' })
}

async function sendTemplateViaMetaDirect({ to, template, components, externalId } = {}) {
  const config = await loadMetaDirectConfig({ includeSecrets: true })
  if (!config.connected) throw new Error('Meta directo no está conectado')
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  if (!toPhone) throw new Error('Falta el número destino')
  if (!template?.name || !template?.language) throw new Error('Falta la plantilla de Meta')

  const response = await metaDirectGraphRequest(`/${encodeURIComponent(config.phoneNumberId)}/messages`, {
    method: 'POST',
    token: config.systemUserToken,
    body: {
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        ...(Array.isArray(components) && components.length ? { components } : {})
      },
      ...(externalId ? { biz_opaque_callback_data: externalId } : {})
    }
  })

  const message = Array.isArray(response?.messages) ? response.messages[0] : null
  const contact = Array.isArray(response?.contacts) ? response.contacts[0] : null
  const messageId = cleanString(response?.id || response?.messageId || response?.message_id || message?.id)

  return {
    ...response,
    id: messageId || cleanString(externalId),
    wamid: cleanString(response?.wamid || response?.waMessageId || message?.id) || messageId || null,
    status: cleanString(response?.status || message?.message_status) || 'sent',
    from: normalizePhoneForStorage(config.displayPhoneNumber) || cleanString(config.displayPhoneNumber),
    to: normalizePhoneForStorage(contact?.input || toPhone) || cleanString(contact?.input || toPhone),
    type: 'template',
    transport: 'api',
    template: {
      name: template.name,
      language: { code: template.language },
      ...(Array.isArray(components) && components.length ? { components } : {})
    }
  }
}

function normalizeInteractiveReplyButtons(buttons = []) {
  if (!Array.isArray(buttons)) return []
  const normalized = buttons
    .map((button, index) => {
      const title = cleanString(button?.title || button?.label || button?.text)
      const id = cleanString(button?.id || button?.payload || `btn_${index}_${slugForButtonPayload(title)}`)
      return {
        id: id.slice(0, WHATSAPP_INTERACTIVE_REPLY_BUTTON_ID_MAX),
        title
      }
    })
    .filter(button => button.title)

  if (normalized.length > WHATSAPP_INTERACTIVE_REPLY_BUTTON_LIMIT) {
    throw new Error(`WhatsApp permite máximo ${WHATSAPP_INTERACTIVE_REPLY_BUTTON_LIMIT} botones por mensaje`)
  }

  const ids = new Set()
  normalized.forEach((button) => {
    if (button.title.length > WHATSAPP_INTERACTIVE_REPLY_BUTTON_TITLE_MAX) {
      throw new Error(`El botón "${button.title}" supera ${WHATSAPP_INTERACTIVE_REPLY_BUTTON_TITLE_MAX} caracteres`)
    }
    if (!button.id) throw new Error(`El botón "${button.title}" necesita un identificador`)
    if (ids.has(button.id)) throw new Error(`Hay botones repetidos con el identificador "${button.id}"`)
    ids.add(button.id)
  })

  return normalized
}

function normalizeInteractiveUrlButton(value = null) {
  if (!value || typeof value !== 'object') return null
  const title = cleanString(value.title || value.label || value.text || value.displayText)
  const url = cleanString(value.url)
  if (!title && !url) return null
  if (!title) throw new Error('El botón de URL necesita texto')
  if (!url) throw new Error('El botón de URL necesita URL')
  if (title.length > WHATSAPP_INTERACTIVE_REPLY_BUTTON_TITLE_MAX) {
    throw new Error(`El botón "${title}" supera ${WHATSAPP_INTERACTIVE_REPLY_BUTTON_TITLE_MAX} caracteres`)
  }
  if (!/^https?:\/\//i.test(url)) throw new Error('El botón de URL debe empezar con http:// o https://')
  return { title, url }
}

function buildInteractiveMessagePayload({ body, buttons, urlButton } = {}) {
  const bodyText = cleanString(body)
  if (!bodyText) throw new Error('Falta el texto del mensaje')

  const replyButtons = normalizeInteractiveReplyButtons(buttons)
  const ctaButton = normalizeInteractiveUrlButton(urlButton)
  if (replyButtons.length && ctaButton) {
    throw new Error('WhatsApp no permite mezclar botones de respuesta y botón de URL en el mismo mensaje')
  }
  if (!replyButtons.length && !ctaButton) {
    throw new Error('Agrega al menos un botón')
  }

  if (ctaButton) {
    return {
      interactive: {
        type: 'cta_url',
        body: { text: bodyText },
        action: {
          name: 'cta_url',
          parameters: {
            display_text: ctaButton.title,
            url: ctaButton.url
          }
        }
      },
      fallbackText: `${bodyText}\n\n${ctaButton.title}: ${ctaButton.url}`,
      buttons: [],
      urlButton: ctaButton
    }
  }

  return {
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: replyButtons.map((button) => ({
          type: 'reply',
          reply: {
            id: button.id,
            title: button.title
          }
        }))
      }
    },
    fallbackText: `${bodyText}\n\n${replyButtons.map((button) => `- ${button.title}`).join('\n')}`,
    buttons: replyButtons,
    urlButton: null
  }
}

async function sendInteractiveViaMetaDirect({ to, interactive, externalId } = {}) {
  const config = await loadMetaDirectConfig({ includeSecrets: true })
  if (!config.connected) throw new Error('Meta directo no está conectado')
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  if (!toPhone) throw new Error('Falta el número destino')
  if (!interactive) throw new Error('Falta el mensaje interactivo')

  return metaDirectGraphRequest(`/${encodeURIComponent(config.phoneNumberId)}/messages`, {
    method: 'POST',
    token: config.systemUserToken,
    body: {
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'interactive',
      interactive,
      ...(externalId ? { biz_opaque_callback_data: externalId } : {})
    }
  })
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
    throw new Error('WhatsApp Business no está conectado con WhatsApp API')
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

export async function editWhatsAppApiTemplate(templatePayload = {}) {
  const config = await loadConfig({ includeSecrets: true })
  if (!config.enabled || !config.apiKey) {
    throw new Error('WhatsApp Business no está conectado con WhatsApp API')
  }

  const cleanWabaId = cleanString(templatePayload.wabaId || config.wabaId)
  const cleanName = cleanString(templatePayload.name)
  const cleanLanguage = cleanString(templatePayload.language)
  const components = Array.isArray(templatePayload.components) ? templatePayload.components : []

  if (!cleanWabaId) throw new Error('Falta el WABA ID de WhatsApp Business para editar la plantilla')
  if (!cleanName) throw new Error('Falta el nombre de la plantilla')
  if (!cleanLanguage) throw new Error('Falta el idioma de la plantilla')
  if (!components.length) throw new Error('Faltan los componentes de la plantilla')

  const body = { components }
  if (Number.isFinite(Number(templatePayload.messageSendTtlSeconds))) {
    body.messageSendTtlSeconds = Number(templatePayload.messageSendTtlSeconds)
  }
  if (typeof templatePayload.ctaUrlLinkTrackingOptedOut === 'boolean') {
    body.ctaUrlLinkTrackingOptedOut = templatePayload.ctaUrlLinkTrackingOptedOut
  }

  const response = await ycloudRequest(
    `/whatsapp/templates/${encodeURIComponent(cleanWabaId)}/${encodeURIComponent(cleanName)}/${encodeURIComponent(cleanLanguage)}`,
    {
      apiKey: config.apiKey,
      method: 'PATCH',
      body
    }
  )
  const enrichedResponse = {
    ...(response && typeof response === 'object' ? response : {}),
    wabaId: cleanString(response?.wabaId) || cleanWabaId,
    name: cleanString(response?.name) || cleanName,
    language: cleanString(response?.language) || cleanLanguage,
    category: cleanString(response?.category) || cleanString(templatePayload.category),
    status: cleanString(response?.status).toUpperCase() || 'PENDING',
    officialTemplateId: cleanString(response?.officialTemplateId || response?.id || templatePayload.officialTemplateId),
    components: Array.isArray(response?.components) && response.components.length ? response.components : components
  }
  if (!cleanString(enrichedResponse.id) && cleanString(enrichedResponse.officialTemplateId)) {
    enrichedResponse.id = cleanString(enrichedResponse.officialTemplateId)
  }

  await syncTemplates([enrichedResponse], { eventType: 'manual_template_edit' })
  return enrichedResponse
}

export async function deleteWhatsAppApiTemplate({ wabaId, name, language } = {}) {
  const config = await loadConfig({ includeSecrets: true })
  if (!config.enabled || !config.apiKey) {
    throw new Error('WhatsApp Business no está conectado con WhatsApp API')
  }

  const cleanWabaId = cleanString(wabaId || config.wabaId)
  const cleanName = cleanString(name)
  const cleanLanguage = cleanString(language)

  if (!cleanWabaId) throw new Error('Falta el WABA ID de WhatsApp Business')
  if (!cleanName) throw new Error('Falta el nombre de la plantilla')
  if (!cleanLanguage) throw new Error('Falta el idioma de la plantilla')

  let ycloud = null
  let notFound = false

  try {
    ycloud = await ycloudRequest(
      `/whatsapp/templates/${encodeURIComponent(cleanWabaId)}/${encodeURIComponent(cleanName)}/${encodeURIComponent(cleanLanguage)}`,
      {
        apiKey: config.apiKey,
        method: 'DELETE'
      }
    )
  } catch (error) {
    if (Number(error.statusCode || 0) === 404) {
      notFound = true
    } else {
      throw error
    }
  }

  const snapshot = await deleteWhatsAppApiTemplateSnapshot({
    wabaId: cleanWabaId,
    name: cleanName,
    language: cleanLanguage
  })

  return {
    deleted: !notFound,
    notFound,
    wabaId: cleanWabaId,
    name: cleanName,
    language: cleanLanguage,
    snapshot,
    ycloud
  }
}

export async function retrieveWhatsAppApiTemplate({ wabaId, name, language } = {}) {
  const config = await loadConfig({ includeSecrets: true })
  if (!config.enabled || !config.apiKey) {
    throw new Error('WhatsApp Business no está conectado con WhatsApp API')
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
    throw new Error('WhatsApp Business no está conectado con WhatsApp API')
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

function slugForButtonPayload(value = '') {
  return cleanString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function templateButtonPayload({ template, button, index }) {
  const name = slugForButtonPayload(template?.name) || 'template'
  const language = slugForButtonPayload(template?.language) || 'lang'
  const label = slugForButtonPayload(button?.text || button?.label || button?.title) || `button_${index}`
  return `template:${name}:${language}:button:${index}:${label}`.slice(0, WHATSAPP_INTERACTIVE_REPLY_BUTTON_ID_MAX)
}

function templateQuickReplyButtonComponents(template = {}, components = []) {
  const existingComponents = Array.isArray(components) ? components : []
  if (existingComponents.some(component => cleanString(component?.type).toLowerCase() === 'button')) {
    return existingComponents
  }

  const sourceComponents = parseJsonValue(template?.components_json, [])
  const buttonsComponent = (Array.isArray(sourceComponents) ? sourceComponents : []).find(component =>
    cleanString(component?.type).toUpperCase() === 'BUTTONS'
  )
  const buttons = Array.isArray(buttonsComponent?.buttons) ? buttonsComponent.buttons : []
  const quickReplies = buttons
    .map((button, index) => ({ button, index }))
    .filter(({ button }) => cleanString(button?.type).toUpperCase() === 'QUICK_REPLY')
    .map(({ button, index }) => ({
      type: 'button',
      sub_type: 'quick_reply',
      index: String(index),
      parameters: [{
        type: 'payload',
        payload: templateButtonPayload({ template, button, index })
      }]
    }))

  return quickReplies.length ? [...existingComponents, ...quickReplies] : existingComponents
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

function buildRenderedTemplateText({ template, components, variables } = {}) {
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

  const buttonsComponent = (Array.isArray(sourceComponents) ? sourceComponents : []).find(component =>
    cleanString(component?.type).toUpperCase() === 'BUTTONS'
  )
  const buttonLabels = (Array.isArray(buttonsComponent?.buttons) ? buttonsComponent.buttons : [])
    .map(button => cleanString(button?.text || button?.label || button?.title))
    .filter(Boolean)
  if (buttonLabels.length) {
    textParts.push(buttonLabels.map(label => `- ${label}`).join('\n'))
  }

  return textParts.map(cleanString).filter(Boolean).join('\n\n')
}

function templateSendSnapshot(template = {}, renderedText = '') {
  return {
    id: template.id || null,
    name: template.name || '',
    language: template.language || '',
    components: parseJsonValue(template.components_json, []),
    renderedText: cleanString(renderedText)
  }
}

async function saveTemplateSend({ template, requestBody, response, variables, renderedText = '' }) {
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
    safeJson({
      request: requestBody,
      response,
      template: templateSendSnapshot(template, renderedText)
    })
  ])

  return id
}

async function renderOutgoingVariables(value, options = {}) {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => renderTemplateVariables(String(item ?? ''), options)))
  }
  if (value && typeof value === 'object') {
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [
      key,
      await renderTemplateVariables(String(item ?? ''), options)
    ]))
    return Object.fromEntries(entries)
  }
  return value
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
  contactId,
  userId,
  publicBaseUrl,
  extraVariables,
  phoneNumberId,
  allowQrFallback = true
} = {}) {
  const config = await loadConfig({ includeSecrets: true })
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const cleanTemplateName = cleanString(templateName)
  const cleanLanguage = cleanString(language)

  if (!toPhone) throw new Error('Falta el número destino')
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
  // WA-008: no asumir que una plantilla no sincronizada localmente es válida.
  // Antes la validación se omitía cuando `status` venía vacío (plantilla no
  // encontrada en whatsapp_api_templates), permitiendo enviar plantillas que
  // podían estar PENDING/REJECTED en Meta. Ahora se exige status APPROVED
  // confirmado localmente; si no hay snapshot local, se rechaza el envío.
  if (!template) {
    throw new Error(`La plantilla ${finalTemplate.name} (${finalTemplate.language}) no está sincronizada; sincroniza las plantillas y verifica que esté APPROVED antes de enviar`)
  }
  if (finalTemplate.status !== 'APPROVED') {
    throw new Error(`La plantilla ${finalTemplate.name} está ${finalTemplate.status || 'sin estado'}; solo se pueden enviar plantillas APPROVED`)
  }

  const renderedVariables = await renderOutgoingVariables(variables, {
    contactId,
    phone: toPhone,
    userId,
    publicBaseUrl,
    extraVariables
  })
  const templateComponents = templateQuickReplyButtonComponents(
    finalTemplate,
    buildTemplateComponents({ components, variables: renderedVariables })
  )
  const normalizedVariables = normalizeTemplateVariables(renderedVariables)
  const renderedTemplateText = buildRenderedTemplateText({
    template: finalTemplate,
    components: templateComponents,
    variables: normalizedVariables
  })
  const templateRequest = {
    name: finalTemplate.name,
    language: {
      code: finalTemplate.language,
      policy: 'deterministic'
    },
    ...(templateComponents.length ? { components: templateComponents } : {})
  }

  if (config.provider === META_DIRECT_PROVIDER_NAME) {
    const response = await sendTemplateViaMetaDirect({
      to: toPhone,
      template: finalTemplate,
      components: templateComponents,
      externalId
    })

    const metaRequestBody = {
      from: response.from || '',
      to: response.to || toPhone,
      type: 'template',
      template: templateRequest,
      provider: META_DIRECT_PROVIDER_NAME,
      ...(externalId ? { externalId } : {})
    }

    await saveTemplateSend({
      template: finalTemplate,
      requestBody: {
        ...metaRequestBody,
        ...(renderedTemplateText ? { renderedText: renderedTemplateText } : {})
      },
      response,
      variables: normalizedVariables,
      renderedText: renderedTemplateText
    })

    await upsertMessage({
      payload: {
        id: response.id || externalId || hashId('waapi_meta_tpl_send_event', `${response.from}|${toPhone}|${finalTemplate.name}`),
        type: 'whatsapp.message.updated',
        createTime: nowIso(),
        provider: META_DIRECT_PROVIDER_NAME,
        whatsappMessage: response
      },
      message: {
        ...response,
        provider: META_DIRECT_PROVIDER_NAME,
        origin: response.origin || 'manual_template_send',
        from: response.from || metaRequestBody.from,
        to: response.to || toPhone,
        type: 'template',
        template: response.template || templateRequest,
        text: response.text || (renderedTemplateText ? { body: renderedTemplateText } : undefined),
        transport: 'api',
        createTime: response.createTime || nowIso()
      },
      direction: 'outbound',
      transport: 'api',
      contactId
    })

    return response
  }

  if (!config.enabled || !config.apiKey) {
    throw new Error('WhatsApp_API no está conectado')
  }

  const fromPhone = normalizePhoneForStorage(from || config.senderPhone) || cleanString(from || config.senderPhone)
  if (!fromPhone) throw new Error('Falta el número emisor de WhatsApp_API')
  const requestBody = {
    from: fromPhone,
    to: toPhone,
    type: 'template',
    template: templateRequest,
    filterUnsubscribed: true,
    filterBlocked: true,
    ...(externalId ? { externalId } : {})
  }

  const sendTemplateViaQr = async ({ fallbackReason, originalError, fallbackPhoneNumberId } = {}) => {
    const text = buildRenderedTemplateText({
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
      contactId,
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
      variables: normalizedVariables,
      renderedText: text
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
  if (allowQrFallback && fallbackDecision.shouldFallback) {
    return sendTemplateViaQr({
      fallbackReason: fallbackDecision.reason,
      fallbackPhoneNumberId: fallbackDecision.fallbackPhoneRow?.id
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
    if (allowQrFallback && retryDecision.shouldFallback) {
      logger.warn(`[WhatsApp API] Envio de plantilla API fallo; usando QR para ${fromPhone}: ${retryDecision.reason}`)
      return sendTemplateViaQr({
        fallbackReason: retryDecision.reason,
        originalError: error,
        fallbackPhoneNumberId: retryDecision.fallbackPhoneRow?.id
      })
    }
    // (WA-009) Sin fallback QR: registrar el saliente fallido antes de propagar.
    await persistFailedOutboundApiMessage({
      fromPhone,
      toPhone,
      type: 'template',
      content: {
        template: requestBody.template,
        ...(renderedTemplateText ? { text: { body: renderedTemplateText } } : {})
      },
      externalId,
      contactId,
      error
    })
    throw error
  }

  await saveTemplateSend({
    template: finalTemplate,
    requestBody: {
      ...requestBody,
      ...(renderedTemplateText ? { renderedText: renderedTemplateText } : {})
    },
    response,
    variables: normalizedVariables,
    renderedText: renderedTemplateText
  })

  const persistedMessage = await upsertMessage({
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
      text: response.text || (renderedTemplateText ? { body: renderedTemplateText } : undefined),
      transport: 'api',
      createTime: response.createTime || nowIso()
    },
    direction: 'outbound',
    transport: 'api',
    contactId
  })
  const fallbackSendResponse = buildSendResponseFromQrFallback(response, persistedMessage?.fallbackResponse)
  if (fallbackSendResponse) {
    return {
      ...fallbackSendResponse,
      localMessageId: fallbackSendResponse.localMessageId || persistedMessage?.messageId || null,
      type: 'template',
      template: requestBody.template
    }
  }

  return { ...response, localMessageId: persistedMessage?.messageId || null }
}

export async function sendWhatsAppApiInteractiveMessage({
  to,
  from,
  body,
  text,
  buttons,
  urlButton,
  externalId,
  transport = 'api',
  allowQrFallback = true,
  contactId,
  userId,
  publicBaseUrl,
  extraVariables,
  phoneNumberId,
  replyToMessageId = '',
  replyToProviderMessageId = '',
  preferOfficialApiWhenReplyWindowOpen = false,
  skipQrSendProtection = false
} = {}) {
  const config = await loadConfig({ includeSecrets: true })
  const fromPhone = normalizePhoneForStorage(from || config.senderPhone) || cleanString(from || config.senderPhone)
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const renderedBody = await renderTemplateVariables(body || text, {
    contactId,
    phone: toPhone || to,
    userId,
    publicBaseUrl,
    extraVariables
  })
  let cleanTransport = cleanString(transport).toLowerCase() === 'qr' ? 'qr' : 'api'
  const interactivePayload = buildInteractiveMessagePayload({
    body: renderedBody,
    buttons,
    urlButton
  })

  if (!toPhone) throw new Error('Falta el número destino')

  if (await shouldPreferOfficialApiOverRequestedQr({
    cleanTransport,
    preferOfficialApiWhenReplyWindowOpen,
    config,
    fromPhone,
    phoneNumberId,
    toPhone,
    contactId
  })) {
    cleanTransport = 'api'
  }

  if (cleanTransport !== 'qr' && config.provider === META_DIRECT_PROVIDER_NAME) {
    return sendInteractiveViaMetaDirect({
      to: toPhone,
      interactive: interactivePayload.interactive,
      externalId
    })
  }

  if (cleanTransport !== 'qr' && (!config.enabled || !config.apiKey)) {
    throw new Error('WhatsApp_API no está conectado')
  }

  if (!fromPhone) throw new Error('Falta el número emisor de WhatsApp_API')

  if (cleanTransport === 'qr') {
    return sendTextViaQrFallback({
      phoneNumberId,
      fromPhone,
      toPhone,
      body: interactivePayload.fallbackText,
      externalId,
      contactId,
      skipQrSendProtection
    })
  }

  const fallbackDecision = await getOfficialApiFallbackDecision({
    config,
    fromPhone,
    phoneNumberId,
    toPhone,
    contactId,
    checkReplyWindow: true
  })
  if (allowQrFallback && fallbackDecision.shouldFallback) {
    return sendTextViaQrFallback({
      phoneNumberId: fallbackDecision.fallbackPhoneRow?.id || phoneNumberId,
      fromPhone,
      toPhone,
      body: interactivePayload.fallbackText,
      externalId,
      contactId,
      fallbackReason: fallbackDecision.reason,
      skipQrSendProtection
    })
  }
  throwIfOfficialApiBlockedByReplyWindow(fallbackDecision)

  const requestBody = {
    from: fromPhone,
    to: toPhone,
    type: 'interactive',
    interactive: interactivePayload.interactive,
    ...(externalId ? { externalId } : {})
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
    if (allowQrFallback && retryDecision.shouldFallback) {
      logger.warn(`[WhatsApp API] Envio interactivo API fallo; usando QR para ${fromPhone}: ${retryDecision.reason}`)
      return sendTextViaQrFallback({
        phoneNumberId: retryDecision.fallbackPhoneRow?.id || phoneNumberId,
        fromPhone,
        toPhone,
        body: interactivePayload.fallbackText,
        externalId,
        contactId,
        fallbackReason: retryDecision.reason,
        originalError: error,
        skipQrSendProtection
      })
    }
    // (WA-009) Sin fallback QR: registrar el saliente fallido antes de propagar.
    await persistFailedOutboundApiMessage({
      fromPhone,
      toPhone,
      type: 'interactive',
      content: { interactive: interactivePayload.interactive },
      externalId,
      contactId,
      error
    })
    throw error
  }

  const persistedMessage = await upsertMessage({
    payload: {
      id: response.id || externalId || hashId('waapi_interactive_send_event', `${fromPhone}|${toPhone}|${safeJson(interactivePayload.interactive)}`),
      type: 'whatsapp.message.updated',
      createTime: nowIso(),
      whatsappMessage: response
    },
    message: {
      ...response,
      from: response.from || fromPhone,
      to: response.to || toPhone,
      type: response.type || 'interactive',
      interactive: response.interactive || interactivePayload.interactive,
      transport: 'api',
      createTime: response.createTime || nowIso()
    },
    direction: 'outbound',
    transport: 'api',
    contactId
  })
  const fallbackSendResponse = buildSendResponseFromQrFallback(response, persistedMessage?.fallbackResponse)
  if (fallbackSendResponse) {
    return {
      ...fallbackSendResponse,
      localMessageId: fallbackSendResponse.localMessageId || persistedMessage?.messageId || null
    }
  }

  return { ...response, localMessageId: persistedMessage?.messageId || null }
}

function buildQrFallbackError(originalError, fallbackError) {
  const message = `${originalError?.message || 'WhatsApp API no pudo enviar el mensaje'}. El respaldo por QR también fallo: ${fallbackError.message}`
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
      fallbackReason,
      routingReason: fallbackReason
    } : {})
  }
}

async function sendTextViaQrFallback({ fromPhone, toPhone, body, externalId, phoneNumberId, contactId, replyToMessageId = '', replyToProviderMessageId = '', fallbackReason, originalError, persist = true, skipQrSendProtection = false, agentId } = {}) {
  try {
    const agentMetadata = buildConversationalAgentMessageMetadata(agentId)
    const response = await sendWhatsAppQrTextMessage({
      phoneNumberId,
      from: fromPhone,
      to: toPhone,
      text: body,
      externalId,
      replyToMessageId,
      replyToProviderMessageId,
      skipQrSendProtection
    })

    let persistedMessage = null
    if (persist) {
      persistedMessage = await upsertMessage({
        payload: {
          id: response.id || externalId || hashId('waqr_send_event', `${fromPhone}|${toPhone}|${body}`),
          type: fallbackReason ? 'whatsapp.qr.message.fallback_sent' : 'whatsapp.qr.message.sent',
          transport: 'qr',
          fallbackReason: fallbackReason || null,
          ...(externalId ? { externalId } : {}),
          ...agentMetadata,
          createTime: response.createTime || nowIso(),
          whatsappMessage: response
        },
        message: {
          ...response,
          ...agentMetadata,
          from: response.from || fromPhone,
          to: response.to || toPhone,
          type: response.type || 'text',
          text: response.text || { body },
          ...(response.context ? { context: response.context } : {}),
          transport: 'qr',
          createTime: response.createTime || nowIso()
        },
        direction: 'outbound',
        transport: 'qr',
        contactId
      })
    }

    return {
      ...decorateQrFallbackResponse(response, fallbackReason),
      localMessageId: persistedMessage?.messageId || null
    }
  } catch (fallbackError) {
    if (originalError) throw buildQrFallbackError(originalError, fallbackError)
    throw fallbackError
  }
}

async function sendLocationViaQrFallback({ fromPhone, toPhone, location, externalId, phoneNumberId, contactId, fallbackReason, originalError, persist = true, skipQrSendProtection = false } = {}) {
  try {
    const response = await sendWhatsAppQrLocationMessage({
      phoneNumberId,
      from: fromPhone,
      to: toPhone,
      latitude: location?.latitude,
      longitude: location?.longitude,
      name: location?.name,
      address: location?.address,
      externalId,
      skipQrSendProtection
    })
    const responseLocation = normalizeWhatsAppLocation(response.location || location)

    let persistedMessage = null
    if (persist) {
      persistedMessage = await upsertMessage({
        payload: {
          id: response.id || externalId || hashId('waqr_location_event', `${fromPhone}|${toPhone}|${responseLocation?.latitude}|${responseLocation?.longitude}`),
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
          type: 'location',
          text: { body: buildWhatsAppLocationText(responseLocation) },
          location: responseLocation,
          transport: 'qr',
          createTime: response.createTime || nowIso()
        },
        direction: 'outbound',
        transport: 'qr',
        contactId
      })
    }

    return {
      ...decorateQrFallbackResponse(response, fallbackReason),
      localMessageId: persistedMessage?.messageId || null,
      location: responseLocation
    }
  } catch (fallbackError) {
    if (originalError) throw buildQrFallbackError(originalError, fallbackError)
    throw fallbackError
  }
}

async function sendImageViaQrFallback({ fromPhone, toPhone, requestImage, imageDataUrl, preparedImage, externalId, phoneNumberId, contactId, localMedia, publicBaseUrl, fallbackReason, originalError, persist = true, skipQrSendProtection = false } = {}) {
  try {
    const localMediaUrl = localMedia ? buildLocalMediaUrl(localMedia, publicBaseUrl) : ''
    const optimizedImage = preparedImage || (!localMedia && cleanString(imageDataUrl)
      ? await prepareWhatsAppImageForProviderUpload(imageDataUrl)
      : null)
    const optimizedImageDataUrl = optimizedImage ? buildPreparedMediaDataUrl(optimizedImage) : imageDataUrl
    const [response, qrPreviewImage] = await Promise.all([
      sendWhatsAppQrImageMessage({
        phoneNumberId,
        from: fromPhone,
        to: toPhone,
        imageDataUrl: optimizedImageDataUrl,
        imageUrl: requestImage?.link || localMediaUrl,
        caption: requestImage?.caption,
        externalId,
        skipQrSendProtection
      }),
      localMedia
        ? Promise.resolve(null)
        : optimizedImage
          ? savePreparedMediaForChatPreview(optimizedImage, {
              type: 'image',
              mediaLabel: 'foto de WhatsApp QR'
            })
          : saveQrInlineImageForChatPreview(imageDataUrl)
    ])
    const qrPreviewImageUrl = cleanString(qrPreviewImage?.link || qrPreviewImage?.publicUrl || qrPreviewImage?.url || qrPreviewImage?.mediaUrl)
    const responseImage = isPlainObject(response.image) ? response.image : {}
    const qrMetadata = buildQrInlineMediaMetadata({
      dataUrl: optimizedImageDataUrl,
      mimeType: requestImage?.mimeType || localMedia?.mimeType,
      filename: requestImage?.filename || localMedia?.filename,
      defaultBasename: 'whatsapp-image',
      type: 'image'
    })
    const qrPreviewFilename = qrPreviewImage?.mimeType
      ? `whatsapp-image.${inferWhatsAppMediaExtension(qrPreviewImage.mimeType)}`
      : ''
    const mergedMetadata = mergeMediaMetadata(qrMetadata.metadata, requestImage?.metadata, responseImage.metadata)
    const finalImage = {
      ...(requestImage || {}),
      ...qrMetadata,
      ...(qrPreviewImage ? {
        mediaUrl: qrPreviewImage.mediaUrl || qrPreviewImageUrl,
        publicUrl: qrPreviewImage.publicUrl || qrPreviewImageUrl,
        url: qrPreviewImage.url || qrPreviewImageUrl,
        previewMediaAssetId: qrPreviewImage.mediaAssetId,
        previewStorage: qrPreviewImage.storage,
        previewStorageProvider: qrPreviewImage.storageProvider
      } : {}),
      ...responseImage,
      link: cleanString(responseImage.link || requestImage?.link || qrPreviewImageUrl || localMediaUrl),
      mimeType: cleanString(qrPreviewImage?.mimeType || responseImage.mimeType || requestImage?.mimeType || qrMetadata.mimeType || localMedia?.mimeType),
      filename: cleanString(responseImage.filename || requestImage?.filename || localMedia?.filename || qrPreviewFilename || qrMetadata.filename || qrPreviewImage?.filename),
      ...(requestImage?.caption || response.image?.caption ? { caption: requestImage?.caption || response.image?.caption } : {})
    }
    if (finalImage.mimeType) finalImage.mimetype = finalImage.mimeType
    if (!finalImage.filename) delete finalImage.filename
    if (mergedMetadata) finalImage.metadata = mergedMetadata

    let persistedMessage = null
    if (persist) {
      persistedMessage = await upsertMessage({
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
        transport: 'qr',
        contactId
      })
    }

    return {
      ...decorateQrFallbackResponse(response, fallbackReason),
      localMessageId: persistedMessage?.messageId || null,
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

async function sendDocumentViaQrFallback({ fromPhone, toPhone, requestDocument, documentDataUrl, externalId, phoneNumberId, contactId, localMedia, publicBaseUrl, fallbackReason, originalError, persist = true, skipQrSendProtection = false } = {}) {
  try {
    const localMediaUrl = localMedia ? buildLocalMediaUrl(localMedia, publicBaseUrl) : ''
    const response = await sendWhatsAppQrDocumentMessage({
      phoneNumberId,
      from: fromPhone,
      to: toPhone,
      documentDataUrl,
      documentUrl: requestDocument?.link || requestDocument?.url || localMediaUrl,
      caption: requestDocument?.caption,
      filename: requestDocument?.filename || requestDocument?.fileName || localMedia?.filename,
      mimeType: requestDocument?.mimeType || requestDocument?.mimetype || localMedia?.mimeType,
      externalId,
      skipQrSendProtection
    })
    const responseDocument = isPlainObject(response.document) ? response.document : {}
    const qrMetadata = buildQrInlineMediaMetadata({
      dataUrl: documentDataUrl,
      mimeType: requestDocument?.mimeType || requestDocument?.mimetype || localMedia?.mimeType,
      filename: requestDocument?.filename || requestDocument?.fileName || localMedia?.filename,
      defaultBasename: 'documento',
      type: 'document'
    })
    const mergedMetadata = mergeMediaMetadata(qrMetadata.metadata, requestDocument?.metadata, responseDocument.metadata)
    const finalDocument = {
      ...(requestDocument || {}),
      ...qrMetadata,
      ...responseDocument,
      link: cleanString(responseDocument.link || requestDocument?.link || requestDocument?.url || localMediaUrl),
      url: cleanString(responseDocument.url || responseDocument.link || requestDocument?.url || requestDocument?.link || localMediaUrl),
      mimeType: cleanString(responseDocument.mimeType || requestDocument?.mimeType || requestDocument?.mimetype || qrMetadata.mimeType || localMedia?.mimeType),
      filename: cleanString(responseDocument.filename || requestDocument?.filename || requestDocument?.fileName || qrMetadata.filename || localMedia?.filename),
      ...(requestDocument?.caption || response.document?.caption ? { caption: requestDocument?.caption || response.document?.caption } : {})
    }
    if (finalDocument.mimeType) finalDocument.mimetype = finalDocument.mimeType
    if (mergedMetadata) finalDocument.metadata = mergedMetadata

    let persistedMessage = null
    if (persist) {
      persistedMessage = await upsertMessage({
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
        transport: 'qr',
        contactId
      })
    }

    return {
      ...decorateQrFallbackResponse(response, fallbackReason),
      localMessageId: persistedMessage?.messageId || null,
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

async function sendVideoViaQrFallback({ fromPhone, toPhone, requestVideo, videoDataUrl, externalId, phoneNumberId, contactId, localMedia, publicBaseUrl, fallbackReason, originalError, persist = true, skipQrSendProtection = false } = {}) {
  try {
    const localMediaUrl = localMedia ? buildLocalMediaUrl(localMedia, publicBaseUrl) : ''
    const response = await sendWhatsAppQrVideoMessage({
      phoneNumberId,
      from: fromPhone,
      to: toPhone,
      videoDataUrl,
      videoUrl: requestVideo?.link || requestVideo?.url || localMediaUrl,
      caption: requestVideo?.caption,
      mimeType: requestVideo?.mimeType || requestVideo?.mimetype || localMedia?.mimeType,
      externalId,
      skipQrSendProtection
    })
    const responseVideo = isPlainObject(response.video) ? response.video : {}
    const qrMetadata = buildQrInlineMediaMetadata({
      dataUrl: videoDataUrl,
      mimeType: requestVideo?.mimeType || requestVideo?.mimetype || localMedia?.mimeType,
      filename: requestVideo?.filename || localMedia?.filename,
      defaultBasename: 'whatsapp-video',
      type: 'video'
    })
    const mergedMetadata = mergeMediaMetadata(qrMetadata.metadata, requestVideo?.metadata, responseVideo.metadata)
    const finalVideo = {
      ...(requestVideo || {}),
      ...qrMetadata,
      ...responseVideo,
      link: cleanString(responseVideo.link || requestVideo?.link || requestVideo?.url || localMediaUrl),
      url: cleanString(responseVideo.url || responseVideo.link || requestVideo?.url || requestVideo?.link || localMediaUrl),
      mimeType: cleanString(responseVideo.mimeType || requestVideo?.mimeType || requestVideo?.mimetype || qrMetadata.mimeType || localMedia?.mimeType),
      filename: cleanString(responseVideo.filename || requestVideo?.filename || qrMetadata.filename || localMedia?.filename),
      ...(requestVideo?.caption || response.video?.caption ? { caption: requestVideo?.caption || response.video?.caption } : {})
    }
    if (finalVideo.mimeType) finalVideo.mimetype = finalVideo.mimeType
    if (!finalVideo.filename) delete finalVideo.filename
    if (mergedMetadata) finalVideo.metadata = mergedMetadata

    let persistedMessage = null
    if (persist) {
      persistedMessage = await upsertMessage({
        payload: {
          id: response.id || externalId || hashId('waqr_video_event', `${fromPhone}|${toPhone}|${finalVideo.link}`),
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
          type: response.type || 'video',
          video: finalVideo,
          transport: 'qr',
          createTime: response.createTime || nowIso()
        },
        direction: 'outbound',
        transport: 'qr',
        contactId
      })
    }

    return {
      ...decorateQrFallbackResponse(response, fallbackReason),
      localMessageId: persistedMessage?.messageId || null,
      video: finalVideo,
      localMedia: localMedia
        ? { ...localMedia, publicUrl: localMediaUrl }
        : localMedia
    }
  } catch (fallbackError) {
    if (originalError) throw buildQrFallbackError(originalError, fallbackError)
    throw fallbackError
  }
}

async function sendAudioViaQrFallback({ fromPhone, toPhone, requestAudio, audioDataUrl, externalId, phoneNumberId, contactId, localMedia, publicBaseUrl, durationMs, fallbackReason, originalError, persist = true, skipQrSendProtection = false } = {}) {
  try {
    const localMediaUrl = localMedia ? buildLocalMediaUrl(localMedia, publicBaseUrl) : ''
    const publicAudioUrl = cleanString(requestAudio?.link || requestAudio?.url || localMediaUrl)
    const inlineAudioDataUrl = cleanString(audioDataUrl)
    const qrAudioUrl = cleanString(localMedia?.filePath || (inlineAudioDataUrl ? '' : publicAudioUrl))
    const response = await sendWhatsAppQrAudioMessage({
      phoneNumberId,
      from: fromPhone,
      to: toPhone,
      audioDataUrl: qrAudioUrl ? undefined : inlineAudioDataUrl,
      audioUrl: qrAudioUrl,
      audioPublicUrl: publicAudioUrl,
      externalId,
      durationMs,
      skipQrSendProtection
    })
    const responseAudio = isPlainObject(response.audio) ? response.audio : {}
    const qrMetadata = buildQrInlineMediaMetadata({
      dataUrl: audioDataUrl,
      mimeType: requestAudio?.mimeType || requestAudio?.mimetype || localMedia?.mimeType,
      filename: requestAudio?.filename || localMedia?.filename,
      defaultBasename: 'whatsapp-audio',
      type: 'audio'
    })
    const mergedMetadata = mergeMediaMetadata(qrMetadata.metadata, requestAudio?.metadata, responseAudio.metadata)
    const finalAudio = {
      ...(requestAudio || {}),
      ...qrMetadata,
      ...responseAudio,
      link: cleanString(responseAudio.link || publicAudioUrl),
      url: cleanString(responseAudio.url || responseAudio.link || publicAudioUrl),
      mimeType: cleanString(responseAudio.mimeType || requestAudio?.mimeType || qrMetadata.mimeType || localMedia?.mimeType),
      ptt: true,
      ...(durationMs ? { durationMs } : {})
    }
    if (finalAudio.mimeType) finalAudio.mimetype = finalAudio.mimeType
    if (mergedMetadata) finalAudio.metadata = mergedMetadata

    let persistedMessage = null
    if (persist) {
      persistedMessage = await upsertMessage({
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
        transport: 'qr',
        contactId
      })
    }

    return {
      ...decorateQrFallbackResponse(response, fallbackReason),
      localMessageId: persistedMessage?.messageId || null,
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

export async function sendWhatsAppApiTextMessage({
  to,
  text,
  from,
  externalId,
  transport = 'api',
  allowQrFallback = true,
  contactId,
  userId,
  publicBaseUrl,
  extraVariables,
  phoneNumberId,
  replyToMessageId = '',
  replyToProviderMessageId = '',
  preferOfficialApiWhenReplyWindowOpen = false,
  skipQrSendProtection = false,
  agentId
} = {}) {
  const config = await loadConfig({ includeSecrets: true })
  const fromPhone = normalizePhoneForStorage(from || config.senderPhone) || cleanString(from || config.senderPhone)
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const renderedText = await renderTemplateVariables(text, {
    contactId,
    phone: toPhone || to,
    userId,
    publicBaseUrl,
    extraVariables
  })
  const body = cleanString(renderedText)
  const agentMetadata = buildConversationalAgentMessageMetadata(agentId)

  if (!toPhone) throw new Error('Falta el número destino')
  if (!body) throw new Error('Falta el texto del mensaje')

  const replyContext = await resolveWhatsAppReplyContext({
    replyToMessageId,
    replyToProviderMessageId,
    contactId
  })

  let cleanTransport = cleanString(transport).toLowerCase() === 'qr' ? 'qr' : 'api'
  if (await shouldPreferOfficialApiOverRequestedQr({
    cleanTransport,
    preferOfficialApiWhenReplyWindowOpen,
    config,
    fromPhone,
    phoneNumberId,
    toPhone,
    contactId
  })) {
    cleanTransport = 'api'
  }

  if (cleanTransport !== 'qr' && config.provider === META_DIRECT_PROVIDER_NAME) {
    return sendTextViaMetaDirect({ to: toPhone, text: body, from, externalId, replyContext })
  }

  if (cleanTransport !== 'qr' && (!config.enabled || !config.apiKey)) {
    throw new Error('WhatsApp_API no está conectado')
  }

  if (!fromPhone) throw new Error('Falta el número emisor de WhatsApp_API')

  if (cleanTransport === 'qr') {
    return sendTextViaQrFallback({
      phoneNumberId,
      fromPhone,
      toPhone,
      body,
      externalId,
      contactId,
      replyToMessageId,
      replyToProviderMessageId: replyContext?.message_id || replyToProviderMessageId,
      skipQrSendProtection,
      agentId
    })
  }

  const fallbackDecision = await getOfficialApiFallbackDecision({
    config,
    fromPhone,
    phoneNumberId,
    toPhone,
    contactId,
    checkReplyWindow: true
  })
  if (allowQrFallback && fallbackDecision.shouldFallback) {
    return sendTextViaQrFallback({
      phoneNumberId: fallbackDecision.fallbackPhoneRow?.id || phoneNumberId,
      fromPhone,
      toPhone,
      body,
      externalId,
      contactId,
      replyToMessageId,
      replyToProviderMessageId: replyContext?.message_id || replyToProviderMessageId,
      fallbackReason: fallbackDecision.reason,
      skipQrSendProtection,
      agentId
    })
  }
  throwIfOfficialApiBlockedByReplyWindow(fallbackDecision)

  rememberOfficialApiOutboundForQrEcho({
    phoneNumberId,
    toPhone,
    type: 'text',
    text: body
  })

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
        ...(replyContext ? { context: replyContext } : {}),
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
    if (allowQrFallback && retryDecision.shouldFallback) {
      logger.warn(`[WhatsApp API] Envio API fallo; usando QR para ${fromPhone}: ${retryDecision.reason}`)
      return sendTextViaQrFallback({
        phoneNumberId: retryDecision.fallbackPhoneRow?.id || phoneNumberId,
        fromPhone,
        toPhone,
        body,
        externalId,
        contactId,
        replyToMessageId,
        replyToProviderMessageId: replyContext?.message_id || replyToProviderMessageId,
        fallbackReason: retryDecision.reason,
        originalError: error,
        skipQrSendProtection,
        agentId
      })
    }
    // (WA-009) Sin fallback QR: registrar el saliente fallido antes de propagar.
    await persistFailedOutboundApiMessage({
      fromPhone,
      toPhone,
      type: 'text',
      content: { text: { body } },
      externalId,
      contactId,
      error
    })
    throw error
  }

  const persistedMessage = await upsertMessage({
    payload: {
      id: response.id || externalId || hashId('waapi_send_event', `${fromPhone}|${toPhone}|${body}`),
      type: 'whatsapp.message.updated',
      ...(externalId ? { externalId } : {}),
      ...agentMetadata,
      createTime: nowIso(),
      whatsappMessage: response
    },
    message: {
      ...response,
      ...agentMetadata,
      from: response.from || fromPhone,
      to: response.to || toPhone,
      type: response.type || 'text',
      text: response.text || { body },
      ...(replyContext ? { context: replyContext } : {}),
      transport: 'api',
      createTime: response.createTime || nowIso()
    },
    direction: 'outbound',
    transport: 'api',
    contactId
  })
  const fallbackSendResponse = buildSendResponseFromQrFallback(response, persistedMessage?.fallbackResponse)
  if (fallbackSendResponse) {
    return {
      ...fallbackSendResponse,
      localMessageId: fallbackSendResponse.localMessageId || persistedMessage?.messageId || null
    }
  }

  return { ...response, localMessageId: persistedMessage?.messageId || null }
}

export async function sendWhatsAppApiReactionMessage({
  to,
  from,
  emoji,
  targetMessageId,
  targetProviderMessageId,
  externalId,
  transport = 'api',
  allowQrFallback = true,
  contactId,
  phoneNumberId,
  preferOfficialApiWhenReplyWindowOpen = false,
  skipQrSendProtection = false
} = {}) {
  const config = await loadConfig({ includeSecrets: true })
  let cleanTransport = cleanString(transport).toLowerCase() === 'qr' ? 'qr' : 'api'
  const fromPhone = normalizePhoneForStorage(from || config.senderPhone) || cleanString(from || config.senderPhone)
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const reactionEmoji = cleanString(emoji)
  const target = await resolveWhatsAppMessageReference({
    messageId: targetMessageId,
    providerMessageId: targetProviderMessageId,
    contactId
  })
  const targetProviderId = cleanString(target?.providerMessageId || targetProviderMessageId)

  if (!toPhone) throw new Error('Falta el número destino')
  if (!reactionEmoji) throw new Error('Falta la reacción')
  if (!targetProviderId) throw new Error('No encontramos el mensaje original para reaccionar')

  if (await shouldPreferOfficialApiOverRequestedQr({
    cleanTransport,
    preferOfficialApiWhenReplyWindowOpen,
    config,
    fromPhone,
    phoneNumberId,
    toPhone,
    contactId
  })) {
    cleanTransport = 'api'
  }

  if (cleanTransport !== 'qr' && config.provider === META_DIRECT_PROVIDER_NAME) {
    const response = await sendReactionViaMetaDirect({
      to: toPhone,
      from: fromPhone,
      emoji: reactionEmoji,
      targetProviderMessageId: targetProviderId,
      externalId
    })
    const persistedMessage = await upsertMessage({
      payload: {
        id: response.id || externalId || hashId('waapi_reaction_meta_event', `${fromPhone}|${toPhone}|${targetProviderId}|${reactionEmoji}`),
        type: 'whatsapp.message.updated',
        createTime: nowIso(),
        whatsappMessage: response
      },
      message: {
        ...response,
        from: response.from || fromPhone,
        to: response.to || toPhone,
        type: 'reaction',
        reaction: response.reaction || { message_id: targetProviderId, emoji: reactionEmoji },
        context: response.context || { id: targetProviderId },
        transport: 'api',
        createTime: response.createTime || nowIso()
      },
      direction: 'outbound',
      transport: 'api',
      contactId
    })
    return { ...response, localMessageId: persistedMessage?.messageId || null }
  }

  if (cleanTransport !== 'qr' && (!config.enabled || !config.apiKey)) {
    throw new Error('WhatsApp_API no está conectado')
  }
  if (!fromPhone) throw new Error('Falta el número emisor de WhatsApp_API')

  if (cleanTransport === 'qr') {
    const response = await sendWhatsAppQrReactionMessage({
      phoneNumberId,
      from: fromPhone,
      to: toPhone,
      emoji: reactionEmoji,
      targetMessageId,
      targetProviderMessageId: targetProviderId,
      externalId,
      skipQrSendProtection
    })
    const persistedMessage = await upsertMessage({
      payload: {
        id: response.id || externalId || hashId('waqr_reaction_event', `${fromPhone}|${toPhone}|${targetProviderId}|${reactionEmoji}`),
        type: 'whatsapp.qr.message.sent',
        transport: 'qr',
        createTime: response.createTime || nowIso(),
        whatsappMessage: response
      },
      message: {
        ...response,
        from: response.from || fromPhone,
        to: response.to || toPhone,
        type: 'reaction',
        reaction: response.reaction || { message_id: targetProviderId, emoji: reactionEmoji },
        context: response.context || { id: targetProviderId },
        transport: 'qr',
        createTime: response.createTime || nowIso()
      },
      direction: 'outbound',
      transport: 'qr',
      contactId
    })
    return { ...decorateQrFallbackResponse(response, null), localMessageId: persistedMessage?.messageId || null }
  }

  const fallbackDecision = await getOfficialApiFallbackDecision({
    config,
    fromPhone,
    phoneNumberId,
    toPhone,
    contactId,
    checkReplyWindow: true
  })
  if (allowQrFallback && fallbackDecision.shouldFallback) {
    const response = await sendWhatsAppQrReactionMessage({
      phoneNumberId: fallbackDecision.fallbackPhoneRow?.id || phoneNumberId,
      from: fromPhone,
      to: toPhone,
      emoji: reactionEmoji,
      targetMessageId,
      targetProviderMessageId: targetProviderId,
      externalId,
      skipQrSendProtection
    })
    const persistedMessage = await upsertMessage({
      payload: {
        id: response.id || externalId || hashId('waqr_reaction_fallback_event', `${fromPhone}|${toPhone}|${targetProviderId}|${reactionEmoji}`),
        type: 'whatsapp.qr.message.fallback_sent',
        transport: 'qr',
        fallbackReason: fallbackDecision.reason,
        createTime: response.createTime || nowIso(),
        whatsappMessage: response
      },
      message: {
        ...response,
        from: response.from || fromPhone,
        to: response.to || toPhone,
        type: 'reaction',
        reaction: response.reaction || { message_id: targetProviderId, emoji: reactionEmoji },
        context: response.context || { id: targetProviderId },
        transport: 'qr',
        createTime: response.createTime || nowIso()
      },
      direction: 'outbound',
      transport: 'qr',
      contactId
    })
    return {
      ...decorateQrFallbackResponse(response, fallbackDecision.reason),
      localMessageId: persistedMessage?.messageId || null
    }
  }
  throwIfOfficialApiBlockedByReplyWindow(fallbackDecision)

  const reactionPayload = {
    message_id: targetProviderId,
    emoji: reactionEmoji
  }
  const response = await ycloudRequest('/whatsapp/messages', {
    apiKey: config.apiKey,
    method: 'POST',
    body: {
      from: fromPhone,
      to: toPhone,
      type: 'reaction',
      reaction: reactionPayload,
      ...(externalId ? { externalId } : {})
    }
  })

  const persistedMessage = await upsertMessage({
    payload: {
      id: response.id || externalId || hashId('waapi_reaction_event', `${fromPhone}|${toPhone}|${targetProviderId}|${reactionEmoji}`),
      type: 'whatsapp.message.updated',
      createTime: nowIso(),
      whatsappMessage: response
    },
    message: {
      ...response,
      from: response.from || fromPhone,
      to: response.to || toPhone,
      type: response.type || 'reaction',
      reaction: response.reaction || reactionPayload,
      context: response.context || { id: targetProviderId },
      transport: 'api',
      createTime: response.createTime || nowIso()
    },
    direction: 'outbound',
    transport: 'api',
    contactId
  })

  return { ...response, localMessageId: persistedMessage?.messageId || null }
}

export async function sendWhatsAppApiLocationMessage({
  to,
  from,
  latitude,
  longitude,
  name,
  address,
  externalId,
  transport = 'api',
  allowQrFallback = true,
  contactId,
  phoneNumberId,
  preferOfficialApiWhenReplyWindowOpen = false,
  skipQrSendProtection = false
} = {}) {
  const config = await loadConfig({ includeSecrets: true })
  const fromPhone = normalizePhoneForStorage(from || config.senderPhone) || cleanString(from || config.senderPhone)
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const location = normalizeWhatsAppLocation({ latitude, longitude, name, address })

  if (!toPhone) throw new Error('Falta el número destino')
  if (!location) throw new Error('Faltan coordenadas válidas para la ubicación')

  let cleanTransport = cleanString(transport).toLowerCase() === 'qr' ? 'qr' : 'api'
  if (await shouldPreferOfficialApiOverRequestedQr({
    cleanTransport,
    preferOfficialApiWhenReplyWindowOpen,
    config,
    fromPhone,
    phoneNumberId,
    toPhone,
    contactId
  })) {
    cleanTransport = 'api'
  }

  if (cleanTransport !== 'qr' && config.provider === META_DIRECT_PROVIDER_NAME) {
    const response = await sendLocationViaMetaDirect({ to: toPhone, location, from: fromPhone, externalId })
    const persistedMessage = await upsertMessage({
      payload: {
        id: response.id || externalId || hashId('waapi_location_meta_event', `${fromPhone}|${toPhone}|${location.latitude}|${location.longitude}`),
        type: 'whatsapp.message.updated',
        createTime: nowIso(),
        whatsappMessage: response
      },
      message: {
        ...response,
        from: response.from || fromPhone,
        to: response.to || toPhone,
        type: 'location',
        text: { body: buildWhatsAppLocationText(location) },
        location,
        transport: 'api',
        createTime: response.createTime || nowIso()
      },
      direction: 'outbound',
      transport: 'api',
      contactId
    })
    const fallbackSendResponse = buildSendResponseFromQrFallback(response, persistedMessage?.fallbackResponse)
    if (fallbackSendResponse) {
      return {
        ...fallbackSendResponse,
        localMessageId: fallbackSendResponse.localMessageId || persistedMessage?.messageId || null
      }
    }
    return { ...response, localMessageId: persistedMessage?.messageId || null, location }
  }

  if (cleanTransport !== 'qr' && (!config.enabled || !config.apiKey)) {
    throw new Error('WhatsApp_API no está conectado')
  }

  if (!fromPhone) throw new Error('Falta el número emisor de WhatsApp_API')

  if (cleanTransport === 'qr') {
    return sendLocationViaQrFallback({
      phoneNumberId,
      fromPhone,
      toPhone,
      location,
      externalId,
      contactId,
      skipQrSendProtection
    })
  }

  const fallbackDecision = await getOfficialApiFallbackDecision({
    config,
    fromPhone,
    phoneNumberId,
    toPhone,
    contactId,
    checkReplyWindow: true
  })
  if (allowQrFallback && fallbackDecision.shouldFallback) {
    return sendLocationViaQrFallback({
      phoneNumberId: fallbackDecision.fallbackPhoneRow?.id || phoneNumberId,
      fromPhone,
      toPhone,
      location,
      externalId,
      contactId,
      fallbackReason: fallbackDecision.reason,
      skipQrSendProtection
    })
  }
  throwIfOfficialApiBlockedByReplyWindow(fallbackDecision)

  const requestBody = {
    from: fromPhone,
    to: toPhone,
    type: 'location',
    location: {
      latitude: location.latitude,
      longitude: location.longitude,
      ...(location.name ? { name: location.name } : {}),
      ...(location.address ? { address: location.address } : {})
    },
    filterUnsubscribed: true,
    filterBlocked: true,
    ...(externalId ? { externalId } : {})
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
    if (allowQrFallback && retryDecision.shouldFallback) {
      logger.warn(`[WhatsApp API] Envio de ubicación API fallo; usando QR para ${fromPhone}: ${retryDecision.reason}`)
      return sendLocationViaQrFallback({
        phoneNumberId: retryDecision.fallbackPhoneRow?.id || phoneNumberId,
        fromPhone,
        toPhone,
        location,
        externalId,
        contactId,
        fallbackReason: retryDecision.reason,
        originalError: error,
        skipQrSendProtection
      })
    }
    await persistFailedOutboundApiMessage({
      fromPhone,
      toPhone,
      type: 'location',
      content: { text: { body: buildWhatsAppLocationText(location) }, location },
      externalId,
      contactId,
      error
    })
    throw error
  }

  const responseLocation = normalizeWhatsAppLocation({
    ...location,
    ...(response.location || {})
  }) || location

  const persistedMessage = await upsertMessage({
    payload: {
      id: response.id || externalId || hashId('waapi_location_event', `${fromPhone}|${toPhone}|${location.latitude}|${location.longitude}`),
      type: 'whatsapp.message.updated',
      createTime: nowIso(),
      whatsappMessage: response
    },
    message: {
      ...response,
      from: response.from || fromPhone,
      to: response.to || toPhone,
      type: response.type || 'location',
      text: response.text || { body: buildWhatsAppLocationText(location) },
      location: responseLocation,
      transport: 'api',
      createTime: response.createTime || nowIso()
    },
    direction: 'outbound',
    transport: 'api',
    contactId
  })
  const fallbackSendResponse = buildSendResponseFromQrFallback(response, persistedMessage?.fallbackResponse)
  if (fallbackSendResponse) {
    return {
      ...fallbackSendResponse,
      localMessageId: fallbackSendResponse.localMessageId || persistedMessage?.messageId || null
    }
  }

  return {
    ...response,
    localMessageId: persistedMessage?.messageId || null,
    type: response.type || 'location',
    location: responseLocation
  }
}

export async function sendWhatsAppApiImageMessage({
  to,
  from,
  imageDataUrl,
  imageUrl,
  caption,
  externalId,
  transport = 'api',
  allowQrFallback = true,
  contactId,
  userId,
  extraVariables,
  publicBaseUrl,
  phoneNumberId,
  preferOfficialApiWhenReplyWindowOpen = false,
  skipQrSendProtection = false
} = {}) {
  const config = await loadConfig({ includeSecrets: true })
  const fromPhone = normalizePhoneForStorage(from || config.senderPhone) || cleanString(from || config.senderPhone)
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const renderedCaption = await renderTemplateVariables(caption, {
    contactId,
    phone: toPhone || to,
    userId,
    publicBaseUrl,
    extraVariables
  })
  const cleanCaption = cleanString(renderedCaption).slice(0, 1024)
  const cleanImageUrl = cleanString(imageUrl)

  if (!fromPhone) throw new Error('Falta el número emisor de WhatsApp_API')
  if (!toPhone) throw new Error('Falta el número destino')

  let cleanTransport = cleanString(transport).toLowerCase() === 'qr' ? 'qr' : 'api'
  if (await shouldPreferOfficialApiOverRequestedQr({
    cleanTransport,
    preferOfficialApiWhenReplyWindowOpen,
    config,
    fromPhone,
    phoneNumberId,
    toPhone,
    contactId
  })) {
    cleanTransport = 'api'
  }
  if (cleanTransport !== 'qr' && (!config.enabled || !config.apiKey)) {
    throw new Error('WhatsApp_API no está conectado')
  }

  let link = cleanImageUrl
  let providerImage = null
  let providerPreviewImage = null
  let preparedImage = null

  const getPreparedImage = async () => {
    if (!preparedImage) preparedImage = await prepareWhatsAppImageForProviderUpload(imageDataUrl)
    return preparedImage
  }

  if (cleanTransport === 'qr') {
    const optimizedImage = link ? null : await getPreparedImage()
    return sendImageViaQrFallback({
      phoneNumberId,
      fromPhone,
      toPhone,
      requestImage: {
        ...(link ? { link } : {}),
        ...(cleanCaption ? { caption: cleanCaption } : {})
      },
      imageDataUrl,
      preparedImage: optimizedImage,
      externalId,
      contactId,
      publicBaseUrl,
      skipQrSendProtection
    })
  }

  const fallbackDecision = await getOfficialApiFallbackDecision({
    config,
    fromPhone,
    phoneNumberId,
    toPhone,
    contactId,
    checkReplyWindow: true
  })
  if (allowQrFallback && fallbackDecision.shouldFallback) {
    const optimizedImage = link ? null : await getPreparedImage()
    return sendImageViaQrFallback({
      phoneNumberId: fallbackDecision.fallbackPhoneRow?.id || phoneNumberId,
      fromPhone,
      toPhone,
      requestImage: {
        ...(link ? { link } : {}),
        ...(cleanCaption ? { caption: cleanCaption } : {})
      },
      imageDataUrl,
      preparedImage: optimizedImage,
      externalId,
      contactId,
      publicBaseUrl,
      fallbackReason: fallbackDecision.reason,
      skipQrSendProtection
    })
  }
  throwIfOfficialApiBlockedByReplyWindow(fallbackDecision)

  if (!link) {
    const optimizedImage = await getPreparedImage()
    const uploads = await Promise.all([
      uploadPreparedMediaToYCloud({
        config,
        fromPhone,
        media: optimizedImage,
        type: 'image'
      }),
      savePreparedMediaForChatPreview(optimizedImage, {
        type: 'image',
        mediaLabel: 'foto de WhatsApp API'
      })
    ])
    providerImage = uploads[0]
    providerPreviewImage = uploads[1]
  }

  if (cleanTransport !== 'qr' && link && !/^https:\/\//i.test(link)) {
    throw new Error('La foto necesita un enlace público HTTPS para poder enviarse por WhatsApp.')
  }

  const requestImage = {
    ...(providerImage ? { id: providerImage.id } : { link }),
    ...(cleanCaption ? { caption: cleanCaption } : {})
  }
  const storedImage = {
    ...requestImage,
    ...(providerImage ? {
      mediaId: providerImage.id,
      providerMediaId: providerImage.providerMediaId,
      providerMediaExpiresAt: providerImage.providerMediaExpiresAt,
      mimeType: providerImage.mimeType,
      filename: providerImage.filename,
      size: providerImage.size,
      storage: providerImage.storage,
      storageProvider: providerImage.storageProvider,
      metadata: providerImage.metadata
    } : {}),
    ...(providerPreviewImage ? {
      mediaUrl: providerPreviewImage.mediaUrl,
      publicUrl: providerPreviewImage.publicUrl,
      url: providerPreviewImage.url,
      link: providerPreviewImage.link,
      previewMediaAssetId: providerPreviewImage.mediaAssetId,
      previewStorage: providerPreviewImage.storage,
      previewStorageProvider: providerPreviewImage.storageProvider
    } : {})
  }
  const requestBody = {
    from: fromPhone,
    to: toPhone,
    type: 'image',
    image: requestImage,
    filterUnsubscribed: true,
    filterBlocked: true,
    ...(externalId ? { externalId } : {})
  }

  rememberOfficialApiOutboundForQrEcho({
    phoneNumberId,
    toPhone,
    type: 'image',
    text: cleanCaption
  })

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
    if (allowQrFallback && retryDecision.shouldFallback) {
      logger.warn(`[WhatsApp API] Envio de foto API fallo; usando QR para ${fromPhone}: ${retryDecision.reason}`)
      return sendImageViaQrFallback({
        phoneNumberId: retryDecision.fallbackPhoneRow?.id || phoneNumberId,
        fromPhone,
        toPhone,
        requestImage: requestBody.image,
        imageDataUrl,
        preparedImage,
        externalId,
        contactId,
        publicBaseUrl,
        fallbackReason: retryDecision.reason,
        originalError: error,
        skipQrSendProtection
      })
    }
    // (WA-009) Sin fallback QR: registrar el saliente fallido antes de propagar.
    await persistFailedOutboundApiMessage({
      fromPhone,
      toPhone,
      type: 'image',
      content: { image: storedImage },
      externalId,
      contactId,
      error
    })
    throw error
  }

  const persistedMessage = await upsertMessage({
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
      image: {
        ...storedImage,
        ...(response.image || {})
      },
      transport: 'api',
      createTime: response.createTime || nowIso()
    },
    direction: 'outbound',
    transport: 'api',
    contactId
  })
  const fallbackSendResponse = buildSendResponseFromQrFallback(response, persistedMessage?.fallbackResponse)
  if (fallbackSendResponse) {
    return {
      ...fallbackSendResponse,
      localMessageId: fallbackSendResponse.localMessageId || persistedMessage?.messageId || null
    }
  }

  return {
    ...response,
    localMessageId: persistedMessage?.messageId || null,
    image: {
      ...storedImage,
      ...(response.image || {})
    },
    localMedia: null
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
  allowQrFallback = true,
  contactId,
  userId,
  extraVariables,
  publicBaseUrl,
  phoneNumberId,
  preferOfficialApiWhenReplyWindowOpen = false,
  skipQrSendProtection = false
} = {}) {
  const config = await loadConfig({ includeSecrets: true })
  const fromPhone = normalizePhoneForStorage(from || config.senderPhone) || cleanString(from || config.senderPhone)
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const renderedCaption = await renderTemplateVariables(caption, {
    contactId,
    phone: toPhone || to,
    userId,
    publicBaseUrl,
    extraVariables
  })
  const cleanCaption = cleanString(renderedCaption).slice(0, 1024)
  const cleanDocumentUrl = cleanString(documentUrl)

  if (!fromPhone) throw new Error('Falta el número emisor de WhatsApp_API')
  if (!toPhone) throw new Error('Falta el número destino')

  let cleanTransport = cleanString(transport).toLowerCase() === 'qr' ? 'qr' : 'api'
  if (await shouldPreferOfficialApiOverRequestedQr({
    cleanTransport,
    preferOfficialApiWhenReplyWindowOpen,
    config,
    fromPhone,
    phoneNumberId,
    toPhone,
    contactId
  })) {
    cleanTransport = 'api'
  }
  if (cleanTransport !== 'qr' && (!config.enabled || !config.apiKey)) {
    throw new Error('WhatsApp_API no está conectado')
  }

  let link = cleanDocumentUrl
  let providerDocument = null
  const fallbackFilename = sanitizeDocumentFilename(filename, cleanString(mimeType).toLowerCase())

  if (cleanTransport === 'qr') {
    return sendDocumentViaQrFallback({
      phoneNumberId,
      fromPhone,
      toPhone,
      requestDocument: {
        ...(link ? { link } : {}),
        filename: fallbackFilename,
        ...(cleanString(mimeType) ? { mimeType: cleanString(mimeType).toLowerCase() } : {}),
        ...(cleanCaption ? { caption: cleanCaption } : {})
      },
      documentDataUrl,
      externalId,
      contactId,
      publicBaseUrl,
      skipQrSendProtection
    })
  }

  const fallbackDecision = await getOfficialApiFallbackDecision({
    config,
    fromPhone,
    phoneNumberId,
    toPhone,
    contactId,
    checkReplyWindow: true
  })
  if (allowQrFallback && fallbackDecision.shouldFallback) {
    return sendDocumentViaQrFallback({
      phoneNumberId: fallbackDecision.fallbackPhoneRow?.id || phoneNumberId,
      fromPhone,
      toPhone,
      requestDocument: {
        ...(link ? { link } : {}),
        filename: fallbackFilename,
        ...(cleanString(mimeType) ? { mimeType: cleanString(mimeType).toLowerCase() } : {}),
        ...(cleanCaption ? { caption: cleanCaption } : {})
      },
      documentDataUrl,
      externalId,
      contactId,
      publicBaseUrl,
      fallbackReason: fallbackDecision.reason,
      skipQrSendProtection
    })
  }
  throwIfOfficialApiBlockedByReplyWindow(fallbackDecision)

  if (!link) {
    const preparedDocument = await prepareWhatsAppDocumentForProviderUpload(documentDataUrl, filename, mimeType)
    providerDocument = await uploadPreparedMediaToYCloud({
      config,
      fromPhone,
      media: preparedDocument,
      type: 'document'
    })
  }

  if (cleanTransport !== 'qr' && link && !/^https:\/\//i.test(link)) {
    throw new Error('El documento necesita un enlace público HTTPS para poder enviarse por WhatsApp.')
  }

  const requestDocument = {
    ...(providerDocument ? { id: providerDocument.id } : { link }),
    filename: providerDocument?.filename || fallbackFilename,
    ...(cleanCaption ? { caption: cleanCaption } : {})
  }
  const storedDocument = {
    ...requestDocument,
    ...(providerDocument ? {
      mediaId: providerDocument.id,
      providerMediaId: providerDocument.providerMediaId,
      providerMediaExpiresAt: providerDocument.providerMediaExpiresAt,
      mimeType: providerDocument.mimeType,
      size: providerDocument.size,
      storage: providerDocument.storage,
      storageProvider: providerDocument.storageProvider,
      metadata: providerDocument.metadata
    } : {})
  }
  const requestBody = {
    from: fromPhone,
    to: toPhone,
    type: 'document',
    document: requestDocument,
    filterUnsubscribed: true,
    filterBlocked: true,
    ...(externalId ? { externalId } : {})
  }

  rememberOfficialApiOutboundForQrEcho({
    phoneNumberId,
    toPhone,
    type: 'document',
    text: cleanCaption || requestDocument.filename || ''
  })

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
    if (allowQrFallback && retryDecision.shouldFallback) {
      logger.warn(`[WhatsApp API] Envio de documento API fallo; usando QR para ${fromPhone}: ${retryDecision.reason}`)
      return sendDocumentViaQrFallback({
        phoneNumberId: retryDecision.fallbackPhoneRow?.id || phoneNumberId,
        fromPhone,
        toPhone,
        requestDocument: {
          ...storedDocument
        },
        documentDataUrl,
        externalId,
        contactId,
        publicBaseUrl,
        fallbackReason: retryDecision.reason,
        originalError: error,
        skipQrSendProtection
      })
    }
    // (WA-009) Sin fallback QR: registrar el saliente fallido antes de propagar.
    await persistFailedOutboundApiMessage({
      fromPhone,
      toPhone,
      type: 'document',
      content: { document: storedDocument },
      externalId,
      contactId,
      error
    })
    throw error
  }

  const persistedMessage = await upsertMessage({
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
      document: {
        ...storedDocument,
        ...(response.document || {})
      },
      transport: 'api',
      createTime: response.createTime || nowIso()
    },
    direction: 'outbound',
    transport: 'api',
    contactId
  })
  const fallbackSendResponse = buildSendResponseFromQrFallback(response, persistedMessage?.fallbackResponse)
  if (fallbackSendResponse) {
    return {
      ...fallbackSendResponse,
      localMessageId: fallbackSendResponse.localMessageId || persistedMessage?.messageId || null
    }
  }

  return {
    ...response,
    localMessageId: persistedMessage?.messageId || null,
    document: {
      ...storedDocument,
      ...(response.document || {})
    },
    localMedia: null
  }
}

export async function sendWhatsAppApiVideoMessage({
  to,
  from,
  videoDataUrl,
  videoUrl,
  caption,
  externalId,
  transport = 'api',
  allowQrFallback = true,
  contactId,
  userId,
  extraVariables,
  publicBaseUrl,
  phoneNumberId,
  preferOfficialApiWhenReplyWindowOpen = false,
  skipQrSendProtection = false
} = {}) {
  const config = await loadConfig({ includeSecrets: true })
  const fromPhone = normalizePhoneForStorage(from || config.senderPhone) || cleanString(from || config.senderPhone)
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const renderedCaption = await renderTemplateVariables(caption, {
    contactId,
    phone: toPhone || to,
    userId,
    publicBaseUrl,
    extraVariables
  })
  const cleanCaption = cleanString(renderedCaption).slice(0, 1024)
  const cleanVideoUrl = cleanString(videoUrl)

  if (!fromPhone) throw new Error('Falta el número emisor de WhatsApp_API')
  if (!toPhone) throw new Error('Falta el número destino')

  let cleanTransport = cleanString(transport).toLowerCase() === 'qr' ? 'qr' : 'api'
  if (await shouldPreferOfficialApiOverRequestedQr({
    cleanTransport,
    preferOfficialApiWhenReplyWindowOpen,
    config,
    fromPhone,
    phoneNumberId,
    toPhone,
    contactId
  })) {
    cleanTransport = 'api'
  }
  if (cleanTransport !== 'qr' && (!config.enabled || !config.apiKey)) {
    throw new Error('WhatsApp_API no está conectado')
  }

  let link = cleanVideoUrl
  let providerVideo = null
  let preparedVideo = null
  let qrVideoDataUrl = ''

  const getPreparedVideo = async () => {
    if (!preparedVideo) {
      preparedVideo = await prepareWhatsAppVideoForProviderUpload(videoDataUrl)
      qrVideoDataUrl = buildPreparedMediaDataUrl(preparedVideo)
    }
    return preparedVideo
  }

  const buildQrRequestVideo = async () => {
    if (link) {
      return {
        link,
        ...(cleanCaption ? { caption: cleanCaption } : {})
      }
    }

    const media = await getPreparedVideo()
    return {
      mimeType: media.mimeType,
      mimetype: media.mimeType,
      filename: media.filename,
      metadata: media.metadata,
      ...(cleanCaption ? { caption: cleanCaption } : {})
    }
  }

  if (cleanTransport === 'qr') {
    return sendVideoViaQrFallback({
      phoneNumberId,
      fromPhone,
      toPhone,
      requestVideo: await buildQrRequestVideo(),
      videoDataUrl: link ? undefined : qrVideoDataUrl,
      externalId,
      contactId,
      publicBaseUrl,
      skipQrSendProtection
    })
  }

  const fallbackDecision = await getOfficialApiFallbackDecision({
    config,
    fromPhone,
    phoneNumberId,
    toPhone,
    contactId,
    checkReplyWindow: true
  })
  if (allowQrFallback && fallbackDecision.shouldFallback) {
    return sendVideoViaQrFallback({
      phoneNumberId: fallbackDecision.fallbackPhoneRow?.id || phoneNumberId,
      fromPhone,
      toPhone,
      requestVideo: await buildQrRequestVideo(),
      videoDataUrl: link ? undefined : qrVideoDataUrl,
      externalId,
      contactId,
      publicBaseUrl,
      fallbackReason: fallbackDecision.reason,
      skipQrSendProtection
    })
  }
  throwIfOfficialApiBlockedByReplyWindow(fallbackDecision)

  if (!link) {
    const media = await getPreparedVideo()
    providerVideo = await uploadPreparedMediaToYCloud({
      config,
      fromPhone,
      media,
      type: 'video'
    })
  }

  if (cleanTransport !== 'qr' && link && !/^https:\/\//i.test(link)) {
    throw new Error('El video necesita un enlace público HTTPS para poder enviarse por WhatsApp.')
  }

  const requestVideo = {
    ...(providerVideo ? { id: providerVideo.id } : { link }),
    ...(cleanCaption ? { caption: cleanCaption } : {})
  }
  const storedVideo = {
    ...requestVideo,
    ...(providerVideo ? {
      mediaId: providerVideo.id,
      providerMediaId: providerVideo.providerMediaId,
      providerMediaExpiresAt: providerVideo.providerMediaExpiresAt,
      mimeType: providerVideo.mimeType,
      mimetype: providerVideo.mimeType,
      filename: providerVideo.filename,
      size: providerVideo.size,
      storage: providerVideo.storage,
      storageProvider: providerVideo.storageProvider,
      metadata: providerVideo.metadata
    } : {})
  }
  const requestBody = {
    from: fromPhone,
    to: toPhone,
    type: 'video',
    video: requestVideo,
    filterUnsubscribed: true,
    filterBlocked: true,
    ...(externalId ? { externalId } : {})
  }

  rememberOfficialApiOutboundForQrEcho({
    phoneNumberId,
    toPhone,
    type: 'video',
    text: cleanCaption
  })

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
    if (allowQrFallback && retryDecision.shouldFallback) {
      logger.warn(`[WhatsApp API] Envio de video API fallo; usando QR para ${fromPhone}: ${retryDecision.reason}`)
      return sendVideoViaQrFallback({
        phoneNumberId: retryDecision.fallbackPhoneRow?.id || phoneNumberId,
        fromPhone,
        toPhone,
        requestVideo: providerVideo ? storedVideo : requestBody.video,
        videoDataUrl: providerVideo ? qrVideoDataUrl : undefined,
        externalId,
        contactId,
        publicBaseUrl,
        fallbackReason: retryDecision.reason,
        originalError: error,
        skipQrSendProtection
      })
    }
    await persistFailedOutboundApiMessage({
      fromPhone,
      toPhone,
      type: 'video',
      content: { video: storedVideo },
      externalId,
      contactId,
      error
    })
    throw error
  }

  const persistedMessage = await upsertMessage({
    payload: {
      id: response.id || externalId || hashId('waapi_video_event', `${fromPhone}|${toPhone}|${link || providerVideo?.id || ''}`),
      type: 'whatsapp.message.updated',
      createTime: nowIso(),
      whatsappMessage: response
    },
    message: {
      ...response,
      from: response.from || fromPhone,
      to: response.to || toPhone,
      type: response.type || 'video',
      video: {
        ...storedVideo,
        ...(response.video || {})
      },
      transport: 'api',
      createTime: response.createTime || nowIso()
    },
    direction: 'outbound',
    transport: 'api',
    contactId
  })
  const fallbackSendResponse = buildSendResponseFromQrFallback(response, persistedMessage?.fallbackResponse)
  if (fallbackSendResponse) {
    return {
      ...fallbackSendResponse,
      localMessageId: fallbackSendResponse.localMessageId || persistedMessage?.messageId || null
    }
  }

  return {
    ...response,
    localMessageId: persistedMessage?.messageId || null,
    video: {
      ...storedVideo,
      ...(response.video || {})
    },
    localMedia: null
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
  allowQrFallback = true,
  contactId,
  phoneNumberId,
  preferOfficialApiWhenReplyWindowOpen = false,
  skipQrSendProtection = false
} = {}) {
  const config = await loadConfig({ includeSecrets: true })
  const fromPhone = normalizePhoneForStorage(from || config.senderPhone) || cleanString(from || config.senderPhone)
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const cleanAudioUrl = cleanString(audioUrl)
  const isVoiceNote = voice === undefined ? Boolean(audioDataUrl) : Boolean(voice)

  if (!fromPhone) throw new Error('Falta el número emisor de WhatsApp_API')
  if (!toPhone) throw new Error('Falta el número destino')

  let cleanTransport = cleanString(transport).toLowerCase() === 'qr' ? 'qr' : 'api'
  if (await shouldPreferOfficialApiOverRequestedQr({
    cleanTransport,
    preferOfficialApiWhenReplyWindowOpen,
    config,
    fromPhone,
    phoneNumberId,
    toPhone,
    contactId
  })) {
    cleanTransport = 'api'
  }
  if (cleanTransport !== 'qr' && (!config.enabled || !config.apiKey)) {
    throw new Error('WhatsApp_API no está conectado')
  }

  let link = cleanAudioUrl
  let providerAudio = null
  let providerPreviewAudio = null
  let preparedAudio = null

  const getPreparedAudio = async () => {
    if (!preparedAudio) preparedAudio = await prepareWhatsAppAudioForProviderUpload(audioDataUrl)
    return preparedAudio
  }

  const getProviderPreviewAudio = async () => {
    // Si el audio ya tiene URL pública (como los assets de Automatizaciones),
    // igual guardamos el preview M4A interno para que el historial de Ristak se
    // reproduzca de forma consistente en web, móvil e iOS.
    if (!cleanString(audioDataUrl)) return null
    if (!providerPreviewAudio) {
      providerPreviewAudio = await saveWhatsAppAudioPlaybackPreviewDataUrl(audioDataUrl, durationMs)
    }
    return providerPreviewAudio
  }

  const buildPreviewAudioFields = (previewAudio = null) => {
    if (!previewAudio) return {}
    const previewUrl = cleanString(previewAudio.mediaUrl || previewAudio.publicUrl || previewAudio.url || previewAudio.link || previewAudio.publicPath)
    return {
      ...(previewUrl ? {
        mediaUrl: previewUrl,
        publicUrl: previewUrl,
        url: previewUrl,
        link: previewUrl
      } : {}),
      ...(previewAudio.mimeType ? { mimeType: previewAudio.mimeType, mimetype: previewAudio.mimeType } : {}),
      ...(previewAudio.filename ? { filename: previewAudio.filename } : {}),
      ...(previewAudio.mediaAssetId ? { previewMediaAssetId: previewAudio.mediaAssetId } : {}),
      ...(previewAudio.storage ? { previewStorage: previewAudio.storage } : {}),
      ...(previewAudio.storageProvider ? { previewStorageProvider: previewAudio.storageProvider } : {}),
      ...(previewAudio.durationMs ? { durationMs: previewAudio.durationMs } : {})
    }
  }

  const buildQrRequestAudio = async () => {
    const previewAudio = await getProviderPreviewAudio()
    return {
      ...(link ? { link } : buildPreviewAudioFields(previewAudio)),
      ...(isVoiceNote ? { voice: true } : {})
    }
  }

  if (cleanTransport === 'qr') {
    return sendAudioViaQrFallback({
      phoneNumberId,
      fromPhone,
      toPhone,
      requestAudio: await buildQrRequestAudio(),
      audioDataUrl,
      externalId,
      contactId,
      publicBaseUrl,
      durationMs,
      skipQrSendProtection
    })
  }

  const fallbackDecision = await getOfficialApiFallbackDecision({
    config,
    fromPhone,
    phoneNumberId,
    toPhone,
    contactId,
    checkReplyWindow: true
  })
  if (allowQrFallback && fallbackDecision.shouldFallback) {
    return sendAudioViaQrFallback({
      phoneNumberId: fallbackDecision.fallbackPhoneRow?.id || phoneNumberId,
      fromPhone,
      toPhone,
      requestAudio: await buildQrRequestAudio(),
      audioDataUrl,
      externalId,
      contactId,
      publicBaseUrl,
      durationMs,
      fallbackReason: fallbackDecision.reason,
      skipQrSendProtection
    })
  }
  throwIfOfficialApiBlockedByReplyWindow(fallbackDecision)

  if (!link) {
    const prepared = await getPreparedAudio()
    providerPreviewAudio = await getProviderPreviewAudio()
    providerAudio = await uploadPreparedMediaToYCloud({
      config,
      fromPhone,
      media: prepared,
      type: 'audio'
    })
  } else {
    // La API entrega el OGG público directamente, pero el historial local sigue
    // necesitando su preview M4A para reproducirse igual en todos los clientes.
    providerPreviewAudio = await getProviderPreviewAudio()
  }

  if (cleanTransport !== 'qr' && link && !/^https:\/\//i.test(link)) {
    throw new Error('El audio necesita un enlace público HTTPS para poder enviarse por WhatsApp.')
  }

  const requestAudio = {
    ...(providerAudio ? { id: providerAudio.id } : { link }),
    ...(isVoiceNote ? { voice: true } : {})
  }
  const storedAudio = {
    ...requestAudio,
    ...(providerAudio ? {
      mediaId: providerAudio.id,
      providerMediaId: providerAudio.providerMediaId,
      providerMediaExpiresAt: providerAudio.providerMediaExpiresAt,
      providerMimeType: providerAudio.mimeType,
      providerFilename: providerAudio.filename,
      mimeType: providerAudio.mimeType,
      filename: providerAudio.filename,
      size: providerAudio.size,
      storage: providerAudio.storage,
      storageProvider: providerAudio.storageProvider,
      metadata: providerAudio.metadata
    } : {}),
    ...buildPreviewAudioFields(providerPreviewAudio),
    ...(durationMs ? { durationMs } : {})
  }
  const requestBody = {
    from: fromPhone,
    to: toPhone,
    type: 'audio',
    audio: requestAudio,
    filterUnsubscribed: true,
    filterBlocked: true,
    ...(externalId ? { externalId } : {})
  }

  rememberOfficialApiOutboundForQrEcho({
    phoneNumberId,
    toPhone,
    type: 'audio',
    text: ''
  })

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
    if (allowQrFallback && retryDecision.shouldFallback) {
      logger.warn(`[WhatsApp API] Envio de audio API fallo; usando QR para ${fromPhone}: ${retryDecision.reason}`)
      return sendAudioViaQrFallback({
        phoneNumberId: retryDecision.fallbackPhoneRow?.id || phoneNumberId,
        fromPhone,
        toPhone,
        requestAudio: {
          ...storedAudio
        },
        audioDataUrl,
        externalId,
        contactId,
        publicBaseUrl,
        durationMs,
        fallbackReason: retryDecision.reason,
        originalError: error,
        skipQrSendProtection
      })
    }
    // (WA-009) Sin fallback QR: registrar el saliente fallido antes de propagar.
    await persistFailedOutboundApiMessage({
      fromPhone,
      toPhone,
      type: 'audio',
      content: { audio: storedAudio },
      externalId,
      contactId,
      error
    })
    throw error
  }

  const persistedMessage = await upsertMessage({
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
        ...storedAudio,
        ...(response.audio || {}),
        ...(durationMs ? { durationMs } : {})
      },
      transport: 'api',
      createTime: response.createTime || nowIso()
    },
    direction: 'outbound',
    transport: 'api',
    contactId
  })
  const fallbackSendResponse = buildSendResponseFromQrFallback(response, persistedMessage?.fallbackResponse)
  if (fallbackSendResponse) {
    return {
      ...fallbackSendResponse,
      localMessageId: fallbackSendResponse.localMessageId || persistedMessage?.messageId || null
    }
  }

  return {
    ...response,
    localMessageId: persistedMessage?.messageId || null,
    audio: {
      ...storedAudio,
      ...(response.audio || {}),
      ...(durationMs ? { durationMs } : {})
    },
    localMedia: null
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
