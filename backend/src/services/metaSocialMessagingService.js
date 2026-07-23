import crypto from 'crypto'
import fetch from 'node-fetch'
import { fileTypeFromBuffer } from 'file-type'
import { db, getAppConfig } from '../config/database.js'
import { API_URLS } from '../config/constants.js'
import { safeMetaGraphTransportError } from '../utils/metaGraphSecurity.js'
import { logger } from '../utils/logger.js'
import { formatContactName } from '../utils/contactNameFormatter.js'
import { getMetaSocialConfig } from './metaAdsService.js'
import { sendChatMessageNotification } from './pushNotificationsService.js'
import { publishChatMessageEvent } from './chatLiveEventsService.js'
import { claimInboundChatMessage } from './chatReadStateService.js'
import { captureContactIdentityFromMessage } from './contactMessageIdentityCaptureService.js'
import {
  buildLocalMediaUrl,
  prepareMetaSocialAudioBuffer,
  prepareWhatsAppMediaForDirectUpload
} from './whatsappApiService.js'
import { downloadSafeOutboundMediaUrl } from './outboundMediaReferenceService.js'
import { buildConversationalAgentMessageMetadata } from '../utils/conversationalAgentMessageMetadata.js'
import { withConversationalInboundCommitLock } from './conversationalInboundCommitLockService.js'
// (NOTI-003) Confirmación de citas por respuesta también para DMs de Messenger/Instagram.
import { maybeConfirmAppointmentFromReply, handleInboundForConfirmation } from './appointmentConfirmationService.js'

const DEFAULT_VERIFY_TOKEN = 'ristak-meta-webhook'
const META_SIGNATURE_HEADER = 'x-hub-signature-256'
const META_SOCIAL_GRAPH_TIMEOUT_MS = 45_000
let metaSocialGraphTimeoutMs = META_SOCIAL_GRAPH_TIMEOUT_MS
const META_MESSENGER_MESSAGING_ENABLED_KEY = 'meta_messenger_messaging_enabled'
const META_INSTAGRAM_MESSAGING_ENABLED_KEY = 'meta_instagram_messaging_enabled'
const META_FACEBOOK_COMMENTS_ENABLED_KEY = 'meta_facebook_comments_enabled'
const META_INSTAGRAM_COMMENTS_ENABLED_KEY = 'meta_instagram_comments_enabled'
const META_SOCIAL_HISTORY_CONVERSATION_PAGE_LIMIT = 50
const META_SOCIAL_HISTORY_MESSAGE_PAGE_LIMIT = 50
const META_SOCIAL_HISTORY_MESSAGE_FIELDS = 'id,message,created_time,from,to,attachments,shares'
const COMMENT_DELETED_TEXT = 'Comentario eliminado'
const POST_DELETED_TEXT = 'Publicación eliminada'
const metaSocialHistorySyncing = new Set()
const META_SOCIAL_MAX_MEDIA_BYTES = 25 * 1024 * 1024
const META_INSTAGRAM_MAX_IMAGE_BYTES = 8 * 1024 * 1024
const META_SOCIAL_ATTACHMENT_TYPES = new Set(['image', 'video', 'audio', 'file'])
const META_SOCIAL_PREPARED_MEDIA_CACHE_TTL_MS = 60 * 60 * 1000
const META_SOCIAL_PREPARED_MEDIA_CACHE_MAX = 300
const metaSocialPreparedMediaCache = new Map()
const metaSocialPreparedMediaInflight = new Map()
const META_SOCIAL_MESSENGER_FILE_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/json',
  'application/zip',
  'text/csv',
  'text/plain'
])

async function defaultMetaSocialOutboundMediaUploader(input) {
  const { uploadMediaAsset } = await import('./mediaStorageService.js')
  return uploadMediaAsset(input)
}

let metaSocialOutboundMediaDownloader = downloadSafeOutboundMediaUrl
let metaSocialOutboundMediaUploader = defaultMetaSocialOutboundMediaUploader

export function setMetaSocialOutboundMediaTransportForTest(overrides = {}) {
  metaSocialPreparedMediaCache.clear()
  metaSocialPreparedMediaInflight.clear()
  metaSocialOutboundMediaDownloader = typeof overrides.downloader === 'function'
    ? overrides.downloader
    : downloadSafeOutboundMediaUrl
  metaSocialOutboundMediaUploader = typeof overrides.uploader === 'function'
    ? overrides.uploader
    : defaultMetaSocialOutboundMediaUploader
}

export function setMetaSocialGraphTimeoutForTest(timeoutMs = META_SOCIAL_GRAPH_TIMEOUT_MS) {
  const parsed = Number(timeoutMs)
  metaSocialGraphTimeoutMs = Number.isFinite(parsed) && parsed > 0
    ? Math.max(1, Math.round(parsed))
    : META_SOCIAL_GRAPH_TIMEOUT_MS
}

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function cleanMediaMimeType(value = '') {
  const normalized = cleanString(value).toLowerCase().split(';')[0].trim()
  if (normalized === 'audio/x-m4a' || normalized === 'audio/m4a') return 'audio/mp4'
  if (normalized === 'audio/x-wav') return 'audio/wav'
  if (normalized === 'image/jpg') return 'image/jpeg'
  return normalized
}

function sanitizeMetaMediaFilename(value = '', fallback = 'archivo') {
  const rawName = cleanString(value).split(/[\\/]/).pop() || fallback
  const safeName = rawName
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return (safeName || fallback).slice(0, 180)
}

function parseMetaSocialMediaDataUrl(value = '') {
  const match = cleanString(value).match(/^data:([^;,]+)(?:;[^,]*)?;base64,([a-z0-9+/=\s]+)$/i)
  if (!match) {
    throw createMetaSocialMessageError('El archivo multimedia no llegó en un formato válido.', 400, {
      code: 'invalid_meta_media_data_url'
    })
  }

  const encoded = match[2].replace(/\s/g, '')
  const estimatedBytes = Math.floor((encoded.length * 3) / 4)
  if (!encoded || encoded.length % 4 !== 0 || estimatedBytes > META_SOCIAL_MAX_MEDIA_BYTES) {
    throw createMetaSocialMessageError('El archivo multimedia está vacío o supera 25 MB.', 413, {
      code: 'meta_media_too_large'
    })
  }

  const buffer = Buffer.from(encoded, 'base64')
  if (!buffer.length || buffer.length > META_SOCIAL_MAX_MEDIA_BYTES) {
    throw createMetaSocialMessageError('El archivo multimedia está vacío o supera 25 MB.', 413, {
      code: 'meta_media_too_large'
    })
  }

  return {
    buffer,
    mimeType: cleanMediaMimeType(match[1])
  }
}

async function detectMetaSocialMediaMime({ buffer, declaredMimeType = '', attachmentType = '' } = {}) {
  const detected = await fileTypeFromBuffer(buffer).catch(() => null)
  const declared = cleanMediaMimeType(declaredMimeType)
  const detectedMime = cleanMediaMimeType(detected?.mime)

  // Un M4A puede ser reconocido como video/mp4 por su contenedor ISO-BMFF. Si
  // el caller lo envió por la ruta de audio, la recodificación con ffmpeg es
  // quien verifica que de verdad exista una pista de audio.
  if (attachmentType === 'audio' && detectedMime === 'video/mp4') {
    return declared.startsWith('audio/') ? declared : 'audio/mp4'
  }
  if (attachmentType === 'audio' && detectedMime === 'video/webm') {
    return declared.startsWith('audio/') ? declared : 'audio/webm'
  }

  return detectedMime || declared
}

function assertMetaSocialSourceMatchesType({ platform, attachmentType, mimeType, size, providerReady = false } = {}) {
  const cleanPlatform = platform === 'instagram' ? 'instagram' : 'messenger'
  const cleanType = attachmentType === 'document' ? 'file' : attachmentType
  const cleanMime = cleanMediaMimeType(mimeType)
  const byteSize = Number(size || 0)

  if (!cleanMime) {
    throw createMetaSocialMessageError('No se pudo reconocer el tipo real del archivo multimedia.', 415, {
      code: 'meta_media_type_unknown'
    })
  }
  if (byteSize < 1 || byteSize > META_SOCIAL_MAX_MEDIA_BYTES) {
    throw createMetaSocialMessageError('El archivo multimedia está vacío o supera 25 MB.', 413, {
      code: 'meta_media_too_large'
    })
  }

  if (cleanType === 'image') {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(cleanMime)) {
      throw createMetaSocialMessageError('La imagen debe ser JPG, PNG, WebP o GIF.', 415, {
        code: 'meta_image_type_invalid'
      })
    }
    if (providerReady && cleanPlatform === 'instagram' && byteSize > META_INSTAGRAM_MAX_IMAGE_BYTES) {
      throw createMetaSocialMessageError('Instagram permite imágenes de hasta 8 MB.', 413, {
        code: 'instagram_image_too_large'
      })
    }
    return
  }

  if (cleanType === 'video') {
    if (!cleanMime.startsWith('video/')) {
      throw createMetaSocialMessageError('El archivo seleccionado no contiene un video válido.', 415, {
        code: 'meta_video_type_invalid'
      })
    }
    return
  }

  if (cleanType === 'audio') {
    if (!cleanMime.startsWith('audio/') && cleanMime !== 'video/mp4') {
      throw createMetaSocialMessageError('El archivo seleccionado no contiene audio válido.', 415, {
        code: 'meta_audio_type_invalid'
      })
    }
    return
  }

  if (cleanPlatform === 'instagram') {
    throw createMetaSocialMessageError('Instagram no permite enviar documentos por la API. Usa imagen, audio o video.', 415, {
      code: 'instagram_file_not_supported'
    })
  }

  if (!META_SOCIAL_MESSENGER_FILE_MIME_TYPES.has(cleanMime)) {
    throw createMetaSocialMessageError('Messenger no acepta este tipo de archivo. Usa PDF, Word, Excel, PowerPoint, TXT, CSV, JSON o ZIP.', 415, {
      code: 'messenger_file_type_invalid'
    })
  }
}

function normalizeMetaSocialMediaPreparationError(error) {
  if (error?.meta?.code) return error
  const message = cleanString(error?.message)
    .replace(/WhatsApp API/gi, 'Messenger o Instagram')
    .replace(/WhatsApp/gi, 'Messenger o Instagram')
  return createMetaSocialMessageError(
    message || 'No se pudo preparar el archivo para Messenger o Instagram.',
    error?.statusCode || error?.status || 422,
    {
      code: cleanString(error?.code) || 'meta_media_preparation_failed'
    }
  )
}

/**
 * Frontera única de salida para chat directo y Automatizaciones. Nunca confía
 * en la extensión o el MIME del navegador: lee bytes reales, adapta imagen,
 * video y audio al contrato de Meta, publica el resultado y sólo entonces
 * entrega una URL HTTPS a Graph.
 */
export async function prepareMetaSocialOutboundMedia({
  platform,
  attachmentType,
  attachmentDataUrl = '',
  attachmentUrl = '',
  mimeType = '',
  filename = '',
  publicBaseUrl = ''
} = {}) {
  const cleanPlatform = cleanString(platform).toLowerCase() === 'instagram' ? 'instagram' : 'messenger'
  const cleanType = cleanString(attachmentType).toLowerCase() === 'document'
    ? 'file'
    : cleanString(attachmentType).toLowerCase()
  const cleanDataUrl = cleanString(attachmentDataUrl)
  const cleanUrl = cleanString(attachmentUrl)

  if (!META_SOCIAL_ATTACHMENT_TYPES.has(cleanType)) {
    throw createMetaSocialMessageError('Meta sólo permite imagen, video, audio o archivo como adjunto.', 400)
  }
  if (!cleanDataUrl && !cleanUrl) {
    throw createMetaSocialMessageError('Falta el archivo para enviar.', 400)
  }

  const source = cleanDataUrl
    ? parseMetaSocialMediaDataUrl(cleanDataUrl)
    : await metaSocialOutboundMediaDownloader(cleanUrl, {
      maxBytes: META_SOCIAL_MAX_MEDIA_BYTES,
      timeoutMs: 60_000
    })
  const declaredMimeType = cleanMediaMimeType(mimeType || source.mimeType)
  const sourceMimeType = await detectMetaSocialMediaMime({
    buffer: source.buffer,
    declaredMimeType,
    attachmentType: cleanType
  })

  assertMetaSocialSourceMatchesType({
    platform: cleanPlatform,
    attachmentType: cleanType,
    mimeType: sourceMimeType,
    size: source.buffer.length
  })

  const sourceHash = crypto.createHash('sha256')
    .update(source.buffer)
    .update(`|${cleanPlatform}|${cleanType}|${declaredMimeType}|${sanitizeMetaMediaFilename(filename)}`)
    .digest('hex')
  const cacheKey = `meta-social-media-v2:${sourceHash}`
  const cached = metaSocialPreparedMediaCache.get(cacheKey)
  if (cached?.value && cached.expiresAt > Date.now()) return cached.value
  if (cached) metaSocialPreparedMediaCache.delete(cacheKey)
  const inflight = metaSocialPreparedMediaInflight.get(cacheKey)
  if (inflight) return inflight

  const preparationPromise = (async () => {
    let prepared
    try {
      if (cleanType === 'audio') {
        prepared = await prepareMetaSocialAudioBuffer({
          buffer: source.buffer,
          mimeType: sourceMimeType
        })
      } else if (cleanType === 'image' && sourceMimeType !== 'image/gif') {
        prepared = await prepareWhatsAppMediaForDirectUpload({
          buffer: source.buffer,
          mimeType: sourceMimeType,
          filename,
          kind: 'image'
        })
        prepared.filename = 'meta-image.jpg'
        prepared.metadata = {
          ...(prepared.metadata || {}),
          metaSocialCompatible: true
        }
      } else if (cleanType === 'video') {
        prepared = await prepareWhatsAppMediaForDirectUpload({
          buffer: source.buffer,
          mimeType: sourceMimeType,
          filename,
          kind: 'video',
          maxVideoOutputBytes: META_SOCIAL_MAX_MEDIA_BYTES
        })
        prepared.filename = 'meta-video.mp4'
        prepared.metadata = {
          ...(prepared.metadata || {}),
          metaSocialCompatible: true
        }
      } else {
        const fallbackName = cleanType === 'image' ? 'meta-image.gif' : 'archivo'
        prepared = {
          buffer: source.buffer,
          mimeType: sourceMimeType,
          filename: sanitizeMetaMediaFilename(filename, fallbackName),
          metadata: {
            metaSocialCompatible: true,
            originalMimeType: declaredMimeType || sourceMimeType
          }
        }
      }
    } catch (error) {
      throw normalizeMetaSocialMediaPreparationError(error)
    }

    assertMetaSocialSourceMatchesType({
      platform: cleanPlatform,
      attachmentType: cleanType,
      mimeType: prepared.mimeType,
      size: prepared.buffer.length,
      providerReady: true
    })

    const asset = await metaSocialOutboundMediaUploader({
      buffer: prepared.buffer,
      mimeType: prepared.mimeType,
      filename: sanitizeMetaMediaFilename(prepared.filename, 'archivo'),
      module: 'chat',
      isPublic: true,
      skipCompression: true,
      clientUploadId: cacheKey,
      metadata: {
        ...(prepared.metadata || {}),
        source: 'meta_social_outbound_media',
        platform: cleanPlatform,
        attachmentType: cleanType
      }
    })
    const publicUrl = buildLocalMediaUrl({ publicPath: asset.publicUrl || asset.publicPath }, publicBaseUrl)
    if (!/^https:\/\//i.test(publicUrl)) {
      throw createMetaSocialMessageError('Messenger e Instagram necesitan almacenamiento multimedia público por HTTPS.', 503, {
        code: 'meta_media_public_url_missing'
      })
    }

    const result = {
      attachmentType: cleanType,
      publicUrl,
      publicPath: asset.publicUrl || asset.publicPath,
      mimeType: cleanMediaMimeType(asset.mimeType || prepared.mimeType),
      filename: asset.originalFilename || asset.storedFilename || prepared.filename,
      size: Number(asset.sizeProcessed || prepared.buffer.length),
      mediaAssetId: cleanString(asset.id || asset.mediaAssetId),
      originalMimeType: declaredMimeType || sourceMimeType
    }
    metaSocialPreparedMediaCache.set(cacheKey, {
      value: result,
      expiresAt: Date.now() + META_SOCIAL_PREPARED_MEDIA_CACHE_TTL_MS
    })
    while (metaSocialPreparedMediaCache.size > META_SOCIAL_PREPARED_MEDIA_CACHE_MAX) {
      const oldestKey = metaSocialPreparedMediaCache.keys().next().value
      if (!oldestKey) break
      metaSocialPreparedMediaCache.delete(oldestKey)
    }
    return result
  })()
  metaSocialPreparedMediaInflight.set(cacheKey, preparationPromise)
  try {
    return await preparationPromise
  } finally {
    if (metaSocialPreparedMediaInflight.get(cacheKey) === preparationPromise) {
      metaSocialPreparedMediaInflight.delete(cacheKey)
    }
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return 'null'
  }
}

function hashId(prefix, value) {
  return `${prefix}_${crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 32)}`
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

function compactName(...values) {
  const name = values
    .map(cleanString)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return formatContactName(name)
}

function getPlatformLabel(platform) {
  if (platform === 'instagram') return 'Instagram DM'
  return 'Messenger'
}

function getCommentPlatformLabel(platform) {
  if (platform === 'instagram') return 'Instagram'
  return 'Facebook'
}

function isEnabledConfigValue(value) {
  const normalized = cleanString(value).toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(normalized)
}

export async function isMetaSocialMessagingEnabled(platform = '') {
  const normalizedPlatform = cleanString(platform).toLowerCase()
  const key = normalizedPlatform === 'instagram'
    ? META_INSTAGRAM_MESSAGING_ENABLED_KEY
    : META_MESSENGER_MESSAGING_ENABLED_KEY

  const value = await getAppConfig(key).catch(error => {
    logger.warn(`No se pudo leer switch de mensajería Meta (${key}): ${error.message}`)
    return ''
  })

  return isEnabledConfigValue(value)
}

// Switch de COMENTARIOS, independiente del de DMs (auto-responder no aplica aquí).
export async function isMetaSocialCommentsEnabled(platform = '') {
  const normalizedPlatform = cleanString(platform).toLowerCase()
  const key = normalizedPlatform === 'instagram'
    ? META_INSTAGRAM_COMMENTS_ENABLED_KEY
    : META_FACEBOOK_COMMENTS_ENABLED_KEY

  const value = await getAppConfig(key).catch(error => {
    logger.warn(`No se pudo leer switch de comentarios Meta (${key}): ${error.message}`)
    return ''
  })

  return isEnabledConfigValue(value)
}

function normalizeObjectPlatform(objectType = '', entry = {}, messaging = {}, config = {}) {
  const object = cleanString(objectType).toLowerCase()
  const entryId = cleanString(entry.id)
  const recipientId = cleanString(messaging.recipient?.id)
  const senderId = cleanString(messaging.sender?.id)
  const configuredInstagramId = cleanString(config.instagram_account_id)

  if (
    object === 'instagram' ||
    (configuredInstagramId && [entryId, recipientId, senderId].includes(configuredInstagramId))
  ) {
    return 'instagram'
  }

  return 'messenger'
}

function getBusinessId(platform, entry = {}, messaging = {}, config = {}) {
  const configuredId = platform === 'instagram'
    ? cleanString(config.instagram_account_id)
    : cleanString(config.page_id)

  return configuredId || cleanString(messaging.recipient?.id) || cleanString(entry.id)
}

function inferDirection({ platform, entry, messaging, config }) {
  if (messaging.message?.is_echo === true) return 'outbound'

  const senderId = cleanString(messaging.sender?.id)
  const businessId = getBusinessId(platform, entry, messaging, config)

  if (senderId && businessId && senderId === businessId) return 'outbound'
  return 'inbound'
}

function extractAttachment(message = {}) {
  const attachment = Array.isArray(message.attachments) ? message.attachments[0] : null
  if (!attachment) return {}

  return {
    messageType: cleanString(attachment.type) || 'attachment',
    mediaUrl: cleanString(attachment.payload?.url),
    mediaMimeType: cleanString(attachment.payload?.mime_type || attachment.mime_type)
  }
}

function normalizeMetaGraphTimestamp(value) {
  const cleanValue = cleanString(value)
  if (cleanValue) {
    const parsed = Date.parse(cleanValue)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }

  const numeric = Number(value)
  if (Number.isFinite(numeric)) {
    return new Date(numeric > 9999999999 ? numeric : numeric * 1000).toISOString()
  }

  return new Date().toISOString()
}

function normalizeGraphCollection(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.data)) return value.data
  return []
}

function extractGraphMessageAttachments(message = {}) {
  const attachments = normalizeGraphCollection(message.attachments).map((attachment, index) => {
    const image = attachment.image_data || attachment.image || {}
    const video = attachment.video_data || attachment.video || {}
    const audio = attachment.audio_data || attachment.audio || {}
    const file = attachment.file_data || attachment.file || {}
    const type = cleanString(attachment.type).toLowerCase() ||
      (image.url ? 'image' : video.url ? 'video' : audio.url ? 'audio' : 'attachment')
    const mediaUrl = cleanString(
      attachment.payload?.url ||
      image.url ||
      image.preview_url ||
      video.url ||
      video.preview_url ||
      audio.url ||
      file.url ||
      attachment.url
    )

    return {
      index,
      messageType: type || 'attachment',
      messageText: cleanString(attachment.name || attachment.title || attachment.description),
      mediaUrl,
      mediaMimeType: cleanString(attachment.mime_type || image.mime_type || video.mime_type || audio.mime_type || file.mime_type)
    }
  })
  if (attachments.length) return attachments

  const share = normalizeGraphCollection(message.shares)[0]
  if (share) {
    return [{
      index: 0,
      messageType: 'link',
      messageText: cleanString(share.name || share.description || share.link),
      mediaUrl: cleanString(share.link),
      mediaMimeType: ''
    }]
  }

  return []
}

function extractSocialMessage({ objectType, entry, messaging, config }) {
  const platform = normalizeObjectPlatform(objectType, entry, messaging, config)
  const direction = inferDirection({ platform, entry, messaging, config })
  const senderId = cleanString(direction === 'inbound' ? messaging.sender?.id : messaging.recipient?.id)
  const recipientId = cleanString(direction === 'inbound' ? messaging.recipient?.id : messaging.sender?.id)
  const timestamp = Number(messaging.timestamp || entry.time || Date.now())
  const messageTimestamp = Number.isFinite(timestamp)
    ? new Date(timestamp > 9999999999 ? timestamp : timestamp * 1000).toISOString()
    : new Date().toISOString()

  if (!senderId) return null

  const messageEdit = messaging.message_edit || messaging.messageEdit || messaging.message?.message_edit
  if (messageEdit?.mid) {
    return {
      platform,
      direction,
      senderId,
      recipientId,
      pageId: platform === 'messenger' ? recipientId || cleanString(entry.id) : cleanString(config.page_id),
      instagramAccountId: platform === 'instagram' ? recipientId || cleanString(entry.id) : cleanString(config.instagram_account_id),
      metaMessageId: cleanString(messageEdit.mid),
      messageType: 'text',
      messageText: cleanString(messageEdit.text),
      mediaUrl: '',
      mediaMimeType: '',
      postbackPayload: '',
      referral: null,
      messageTimestamp,
      status: direction === 'outbound' ? 'sent' : 'received',
      isMutation: true,
      mutationType: 'edit',
      raw: messaging
    }
  }

  if (messaging.message) {
    const attachment = extractAttachment(messaging.message)
    const isDeleted = messaging.message.is_deleted === true || messaging.is_deleted === true
    const text = isDeleted ? 'Mensaje anulado' : cleanString(messaging.message.text)
    return {
      platform,
      direction,
      senderId,
      recipientId,
      pageId: platform === 'messenger' ? recipientId || cleanString(entry.id) : cleanString(config.page_id),
      instagramAccountId: platform === 'instagram' ? recipientId || cleanString(entry.id) : cleanString(config.instagram_account_id),
      metaMessageId: cleanString(messaging.message.mid),
      messageType: attachment.messageType || (text ? 'text' : 'message'),
      messageText: text,
      mediaUrl: attachment.mediaUrl || '',
      mediaMimeType: attachment.mediaMimeType || '',
      postbackPayload: '',
      referral: messaging.message.referral || messaging.referral || null,
      messageTimestamp,
      status: isDeleted ? 'removed' : (direction === 'outbound' ? 'sent' : 'received'),
      isMutation: isDeleted,
      mutationType: isDeleted ? 'delete' : '',
      raw: messaging
    }
  }

  if (messaging.postback) {
    return {
      platform,
      direction,
      senderId,
      recipientId,
      pageId: platform === 'messenger' ? recipientId || cleanString(entry.id) : cleanString(config.page_id),
      instagramAccountId: platform === 'instagram' ? recipientId || cleanString(entry.id) : cleanString(config.instagram_account_id),
      metaMessageId: cleanString(messaging.postback.mid),
      messageType: 'postback',
      messageText: cleanString(messaging.postback.title || messaging.postback.payload) || 'Respuesta rápida',
      mediaUrl: '',
      mediaMimeType: '',
      postbackPayload: cleanString(messaging.postback.payload),
      referral: messaging.postback.referral || messaging.referral || null,
      messageTimestamp,
      raw: messaging
    }
  }

  if (messaging.referral) {
    return {
      platform,
      direction,
      senderId,
      recipientId,
      pageId: platform === 'messenger' ? recipientId || cleanString(entry.id) : cleanString(config.page_id),
      instagramAccountId: platform === 'instagram' ? recipientId || cleanString(entry.id) : cleanString(config.instagram_account_id),
      metaMessageId: '',
      messageType: 'referral',
      messageText: cleanString(messaging.referral.ref || messaging.referral.source) || 'Llegó desde un enlace de Meta',
      mediaUrl: '',
      mediaMimeType: '',
      postbackPayload: '',
      referral: messaging.referral,
      messageTimestamp,
      raw: messaging
    }
  }

  if (messaging.reaction) {
    return {
      platform,
      direction,
      senderId,
      recipientId,
      pageId: platform === 'messenger' ? recipientId || cleanString(entry.id) : cleanString(config.page_id),
      instagramAccountId: platform === 'instagram' ? recipientId || cleanString(entry.id) : cleanString(config.instagram_account_id),
      metaMessageId: cleanString(messaging.reaction.mid),
      messageType: 'reaction',
      messageText: cleanString(messaging.reaction.reaction) || 'Reacción',
      mediaUrl: '',
      mediaMimeType: '',
      postbackPayload: '',
      referral: null,
      messageTimestamp,
      raw: messaging
    }
  }

  return null
}

// Normaliza un comentario (FB 'feed' item=comment / IG 'comments') al mismo shape
// que un DM, más campos de comentario. CLAVE: el authorId del comentario ES el
// mismo PSID/IGSID que el sender de los DMs de la misma persona (verificado en
// prod), así que el senderId es el id crudo — comentario y DM CONVERGEN en un solo
// contacto. La distinción comentario/DM vive en message_type, no en el contacto.
// Solo si Meta oculta el from.id (privacidad FB) se cae al commentId, que no
// puede fusionar y queda como un contacto de comentario suelto.
// Extrae la media adjunta de un comentario de Facebook. FB manda la foto/video del
// comentario como URL directa (value.photo / value.video) o dentro de un attachment
// estructurado. Instagram no adjunta media del autor en comentarios (value.media es el
// post comentado, no un adjunto), así que ahí no aplica.
export function extractCommentMedia(value = {}) {
  const photo = cleanString(value.photo)
  if (photo) return { mediaUrl: photo, mediaType: 'image' }
  const video = cleanString(value.video)
  if (video) return { mediaUrl: video, mediaType: 'video' }

  const attachment = value.attachment ||
    (Array.isArray(value.attachments?.data) ? value.attachments.data[0] : null)
  if (attachment) {
    const type = cleanString(attachment.type).toLowerCase()
    const url = cleanString(
      attachment.media?.image?.src ||
      attachment.media?.source ||
      attachment.url ||
      attachment.payload?.url
    )
    if (url) {
      const mediaType = type.includes('video')
        ? 'video'
        : type.includes('audio')
          ? 'audio'
          : 'image'
      return { mediaUrl: url, mediaType }
    }
  }
  return { mediaUrl: '', mediaType: '' }
}

function extractCommentEvent({ objectType, entry, change, config = {} }) {
  const field = cleanString(change?.field).toLowerCase()
  const value = change?.value || {}
  const object = cleanString(objectType).toLowerCase()

  const isFacebookComment = field === 'feed' && cleanString(value.item).toLowerCase() === 'comment'
  const isInstagramComment = field === 'comments' || field === 'live_comments'
  if (!isFacebookComment && !isInstagramComment) return null

  const platform = (object === 'instagram' || isInstagramComment) ? 'instagram' : 'messenger'

  const commentId = cleanString(value.comment_id || value.id)
  if (!commentId) return null

  const from = value.from || {}
  const authorId = cleanString(from.id)
  const authorName = cleanString(from.name)
  const authorUsername = cleanString(from.username)

  const pageId = cleanString(config.page_id)
  const igId = cleanString(config.instagram_account_id)
  // Anti-loop: si el autor es la propia Página/cuenta IG, es NUESTRA respuesta.
  const isEcho = Boolean(authorId && (authorId === pageId || authorId === igId))
  const direction = isEcho ? 'outbound' : 'inbound'
  const verb = cleanString(value.verb).toLowerCase() || 'add' // IG no manda verb

  // id crudo del autor = mismo PSID/IGSID que su DM → converge en un contacto.
  // Fallback al commentId solo si Meta ocultó el from.id (no fusiona, pero nunca
  // deja el sender_id NULL).
  const senderId = authorId || commentId

  const text = cleanString(value.message || value.text)
  const rawTs = Number(value.created_time || entry?.time || Date.now())
  const messageTimestamp = Number.isFinite(rawTs)
    ? new Date(rawTs > 9999999999 ? rawTs : rawTs * 1000).toISOString()
    : new Date().toISOString()

  // Adjunto del comentario (solo FB): se rehospeda en nuestro storage igual que los DMs.
  const commentMedia = isFacebookComment ? extractCommentMedia(value) : { mediaUrl: '', mediaType: '' }

  return {
    platform,
    direction,
    senderId,
    recipientId: platform === 'instagram' ? igId : pageId,
    pageId: platform === 'messenger' ? pageId : '',
    instagramAccountId: platform === 'instagram' ? igId : '',
    metaMessageId: commentId, // dedup natural (edits/reenvíos llegan con el mismo id)
    messageType: isEcho ? 'comment_reply_public' : 'comment',
    // No persistas "Comentario sin texto" como contenido real: Meta puede reenviar
    // el mismo comment_id sin message y ese fallback pisaría el texto original.
    messageText: text || (verb === 'remove' || verb === 'hide' ? COMMENT_DELETED_TEXT : ''),
    mediaUrl: commentMedia.mediaUrl,
    mediaType: commentMedia.mediaType,
    mediaMimeType: '',
    postbackPayload: '',
    referral: null,
    messageTimestamp,
    // Campos de comentario:
    commentId,
    postId: cleanString(value.post_id),
    parentCommentId: cleanString(value.parent_id),
    mediaId: cleanString(value.media?.id || value.media_id),
    permalink: cleanString(value.permalink_url || value.permalink),
    verb,
    isEcho,
    authorId,
    authorName,
    authorUsername,
    raw: change
  }
}

function extractDeletedPostEvent({ objectType, change }) {
  const field = cleanString(change?.field).toLowerCase()
  const value = change?.value || {}
  const object = cleanString(objectType).toLowerCase()
  const verb = cleanString(value.verb || value.action).toLowerCase()
  if (!['remove', 'removed', 'delete', 'deleted', 'hide', 'hidden'].includes(verb)) return null

  const item = cleanString(value.item || value.object_type || value.type || field).toLowerCase()
  if (item === 'comment' || field === 'comments' || field === 'live_comments') return null

  const isPostLikeItem = ['post', 'media', 'photo', 'video', 'reel', 'story', 'status'].includes(item) ||
    ['media', 'feed'].includes(field)
  if (!isPostLikeItem) return null

  const platform = object === 'instagram' || field === 'media' ? 'instagram' : 'messenger'
  const postId = cleanString(value.post_id || value.media_id || value.id || value.object_id)
  if (!postId) return null

  return {
    platform,
    postId,
    raw: change
  }
}

// Marca (soft) un comentario eliminado sin borrar la fila, para no perder el hilo.
async function softRemoveComment(comment) {
  const platform = comment.platform === 'instagram' ? 'instagram' : 'messenger'
  const commentId = cleanString(comment.commentId)
  const inboundMessageId = hashId('meta_social_msg', commentId)
  const outboundMessageId = hashId('meta_social_msg', `${platform}:${commentId}:outbound`)
  await db.run(
    `UPDATE meta_social_messages
     SET message_text = ?, status = 'removed', updated_at = CURRENT_TIMESTAMP
     WHERE platform = ?
       AND (
         id IN (?, ?)
         OR COALESCE(comment_id, '') = ?
         OR COALESCE(meta_message_id, '') = ?
       )`,
    [COMMENT_DELETED_TEXT, platform, inboundMessageId, outboundMessageId, commentId, commentId]
  )
}

async function markSocialPostDeleted(event) {
  const platform = event.platform === 'instagram' ? 'instagram' : 'messenger'
  const postId = cleanString(event.postId)
  if (!postId) return

  await cacheDeletedSocialPost({
    platform,
    postId,
    mediaId: postId,
    raw: event.raw
  })

  await db.run(
    `UPDATE meta_social_messages
     SET message_text = ?, status = 'removed', updated_at = CURRENT_TIMESTAMP
     WHERE platform = ?
       AND message_type IN ('comment', 'comment_reply_public', 'comment_reply_private')
       AND (
         COALESCE(post_id, '') = ?
         OR COALESCE(media_id, '') = ?
       )`,
    [COMMENT_DELETED_TEXT, platform, postId, postId]
  )
}

async function saveOutboundCommentEcho(comment) {
  const platform = comment.platform === 'instagram' ? 'instagram' : 'messenger'
  const replyCommentId = cleanString(comment.commentId)
  const targetCommentId = cleanString(comment.parentCommentId)

  if (!replyCommentId || !targetCommentId) {
    logger.info(`[Meta social] Comentario propio ${replyCommentId || '(sin id)'} ignorado: Meta no envió parent_id para enlazarlo al contacto.`)
    return null
  }

  const target = await db.get(`
    SELECT
      msg.contact_id,
      msg.meta_social_contact_id,
      msg.sender_id AS contact_sender_id,
      msg.recipient_id AS business_recipient_id,
      msg.page_id,
      msg.instagram_account_id,
      msg.comment_id,
      msg.post_id,
      msg.media_id,
      profile.id AS profile_id,
      profile.sender_id AS profile_sender_id,
      profile.page_id AS profile_page_id,
      profile.instagram_account_id AS profile_instagram_account_id
    FROM meta_social_messages msg
    LEFT JOIN meta_social_contacts profile ON profile.id = msg.meta_social_contact_id
    WHERE msg.platform = ?
      AND msg.comment_id = ?
      AND COALESCE(msg.contact_id, '') <> ''
      AND LOWER(COALESCE(msg.direction, '')) = 'inbound'
    ORDER BY CASE WHEN msg.message_type = 'comment' THEN 0 ELSE 1 END,
             COALESCE(msg.message_timestamp, msg.created_at) DESC
    LIMIT 1
  `, [platform, targetCommentId]).catch(error => {
    logger.warn(`[Meta social] No se pudo buscar el comentario padre ${targetCommentId}: ${error.message}`)
    return null
  })

  if (!target?.contact_id) {
    logger.info(`[Meta social] Respuesta propia ${replyCommentId} ignorada: no existe comentario padre ${targetCommentId} en el chat local.`)
    return null
  }

  const profile = {
    id: cleanString(target.profile_id || target.meta_social_contact_id),
    sender_id: cleanString(target.profile_sender_id || target.contact_sender_id),
    page_id: cleanString(target.profile_page_id || target.page_id || target.business_recipient_id),
    instagram_account_id: cleanString(target.profile_instagram_account_id || target.instagram_account_id || target.business_recipient_id)
  }

  if (!profile.id || !profile.sender_id) {
    logger.warn(`[Meta social] Respuesta propia ${replyCommentId} sin perfil social enlazado para ${target.contact_id}.`)
    return null
  }

  const targetPostId = cleanString(target.post_id) ||
    cleanString(target.media_id) ||
    cleanString(comment.postId) ||
    cleanString(comment.mediaId)

  const sent = await saveMetaSocialOutboundMessage({
    platform,
    contactId: target.contact_id,
    profile,
    messageId: replyCommentId,
    text: comment.messageText,
    response: {
      id: replyCommentId,
      webhook_echo: true
    },
    externalId: replyCommentId,
    messageType: 'comment_reply_public',
    messageTimestamp: comment.messageTimestamp,
    commentId: cleanString(target.comment_id) || targetCommentId,
    postId: targetPostId,
    parentCommentId: targetCommentId,
    context: {
      source: 'meta_comment_echo',
      reply_comment_id: replyCommentId,
      parent_comment_id: targetCommentId,
      raw: comment.raw
    }
  })

  return {
    ...sent,
    messageId: sent.localMessageId,
    contactId: target.contact_id,
    platform,
    direction: 'outbound',
    messageText: comment.messageText,
    messageType: 'comment_reply_public',
    timestamp: comment.messageTimestamp
  }
}

// El webhook de comentarios trae from.{id,name} pero NO siempre trae foto. Para
// FB hacemos best-effort desde el comment_id. Para IG, si Meta entrega el IGSID,
// lo consultamos igual que un DM con las credenciales Graph resueltas
// (name, username, profile_pic).
async function fetchMetaCommentAuthorProfile({ platform, commentId, authorId, accessToken, baseUrl = getMetaSocialGraphBaseUrl(platform) }) {
  if (!accessToken) return {}
  try {
    if (platform === 'instagram') {
      if (!authorId) return {}
      const data = await metaSocialGraphRequest(`/${encodeURIComponent(authorId)}`, {
        token: accessToken,
        baseUrl,
        query: { fields: 'name,username,profile_pic' }
      })
      return {
        name: cleanString(data?.name),
        username: cleanString(data?.username),
        profilePictureUrl: cleanString(data?.profile_pic)
      }
    }
    // Facebook: vía el comment_id (from{picture}). OJO: Meta suele OCULTAR la foto
    // (y el from) de comentaristas ajenos por privacidad — el nombre igual viene
    // en el webhook, así que este fetch es best-effort para la foto.
    if (!commentId) return {}
    const data = await metaSocialGraphRequest(`/${encodeURIComponent(commentId)}`, {
      token: accessToken,
      baseUrl,
      query: { fields: 'from{id,name,picture}' }
    })
    const from = data?.from || {}
    return {
      name: cleanString(from.name),
      profilePictureUrl: cleanString(from.picture?.data?.url)
    }
  } catch (error) {
    logger.warn(`No se pudo leer perfil del comentarista (${platform}): ${error.message}`)
    return {}
  }
}

// Saca y cachea el contenido de la publicación/media comentada (texto + imagen +
// permalink) para mostrar "de qué publicación comentó" dentro del globo. Se pide
// una sola vez por publicación (cache en meta_social_posts).
async function cacheDeletedSocialPost(comment, error = null) {
  const platform = comment.platform === 'instagram' ? 'instagram' : 'messenger'
  const postId = cleanString(comment.postId) || cleanString(comment.mediaId)
  if (!postId) return
  const raw = {
    unavailable: true,
    reason: cleanString(error?.message),
    meta: error?.meta || null,
    event: comment.raw || null
  }
  await db.run(`
    INSERT INTO meta_social_posts (id, platform, post_type, message, image_url, permalink, raw_json, fetched_at, updated_at)
    VALUES (?, ?, 'deleted', ?, NULL, NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      platform = excluded.platform,
      post_type = excluded.post_type,
      message = COALESCE(NULLIF(meta_social_posts.message, ''), excluded.message),
      raw_json = excluded.raw_json,
      updated_at = CURRENT_TIMESTAMP
  `, [postId, platform, POST_DELETED_TEXT, safeJson(raw)]).catch(dbError => {
    logger.warn(`No se pudo cachear publicación eliminada ${postId}: ${dbError.message}`)
  })
}

async function fetchAndCacheSocialPost(comment, accessToken, baseUrl = '', config = null) {
  const platform = comment.platform
  const postId = platform === 'instagram' ? cleanString(comment.mediaId) : cleanString(comment.postId)
  if (!postId || !accessToken) return
  const existing = await db.get('SELECT id, image_url FROM meta_social_posts WHERE id = ?', [postId]).catch(() => null)
  const existingImageUrl = cleanString(existing?.image_url)
  if (existing && existingImageUrl && !isMetaHostedMediaUrl(existingImageUrl)) {
    return db.get(
      'SELECT id, platform, post_type, message, image_url, permalink, fetched_at, updated_at FROM meta_social_posts WHERE id = ?',
      [postId]
    ).catch(() => existing)
  }

  try {
    const graphBaseUrl = cleanString(baseUrl) || getMetaSocialGraphBaseUrl(platform)
    const fields = platform === 'instagram'
      ? 'caption,media_type,media_url,thumbnail_url,permalink,timestamp'
      : 'message,permalink_url,created_time,full_picture'
    const data = await metaSocialGraphRequest(`/${encodeURIComponent(postId)}`, { token: accessToken, baseUrl: graphBaseUrl, query: { fields } })
    const message = platform === 'instagram' ? cleanString(data?.caption) : cleanString(data?.message)
    const graphImageUrl = platform === 'instagram'
      ? cleanString(data?.thumbnail_url || data?.media_url)
      : cleanString(data?.full_picture)
    const rehostedImage = graphImageUrl
      ? await rehostMetaSocialMedia({
        socialMessage: {
          platform,
          messageType: 'image',
          mediaType: 'image',
          mediaUrl: graphImageUrl,
          mediaMimeType: '',
          metaMessageId: postId
        },
        config,
        accessToken,
        existingMediaUrl: existingImageUrl
      }).catch(error => {
        logger.warn(`No se pudo persistir la imagen de la publicación ${postId}: ${error.message}`)
        return null
      })
      : null
    const imageUrl = rehostedImage?.mediaUrl || graphImageUrl
    const permalink = cleanString(data?.permalink || data?.permalink_url)
    const postType = platform === 'instagram' ? cleanString(data?.media_type) || 'media' : 'post'

    await db.run(`
      INSERT INTO meta_social_posts (id, platform, post_type, message, image_url, permalink, raw_json, fetched_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        platform = excluded.platform,
        post_type = excluded.post_type,
        message = COALESCE(NULLIF(excluded.message, ''), meta_social_posts.message),
        image_url = COALESCE(NULLIF(excluded.image_url, ''), meta_social_posts.image_url),
        permalink = COALESCE(NULLIF(excluded.permalink, ''), meta_social_posts.permalink),
        raw_json = excluded.raw_json,
        updated_at = CURRENT_TIMESTAMP
    `, [postId, platform, postType, message || null, imageUrl || null, permalink || null, safeJson(data)])

    return db.get(
      'SELECT id, platform, post_type, message, image_url, permalink, fetched_at, updated_at FROM meta_social_posts WHERE id = ?',
      [postId]
    ).catch(() => ({ id: postId, platform, post_type: postType, message, image_url: imageUrl, permalink }))
  } catch (error) {
    const unavailable = error?.statusCode === 404 ||
      /unsupported get request|does not exist|cannot be loaded|object .*not found/i.test(cleanString(error?.message))
    if (unavailable) await cacheDeletedSocialPost(comment, error)
    logger.warn(`No se pudo cachear la publicación comentada ${postId}: ${error.message}`)
    return null
  }
}

const metaSocialPostPreviewRefreshes = new Map()

async function refreshMetaSocialPostPreviewForChat(message = {}) {
  const platform = cleanString(message.platform).toLowerCase() === 'instagram' ? 'instagram' : 'messenger'
  const postId = platform === 'instagram'
    ? cleanString(message.media_id || message.post_id)
    : cleanString(message.post_id || message.media_id)
  if (!postId) return null

  const existingImageUrl = cleanString(message.post_image_url)
  if (!isMetaHostedMediaUrl(existingImageUrl)) return null
  if (cleanString(message.post_type).toLowerCase() === 'deleted') return null

  const refreshKey = `${platform}:${postId}`
  if (metaSocialPostPreviewRefreshes.has(refreshKey)) {
    return metaSocialPostPreviewRefreshes.get(refreshKey)
  }

  const refreshPromise = (async () => {
    const config = await getMetaSocialConfig().catch(() => null)
    if (!config) return null
    const credentials = await resolveMetaSocialGraphCredentials(platform, config, { safe: true })
    if (!credentials.token) return null

    return fetchAndCacheSocialPost({
      platform,
      postId: platform === 'messenger' ? postId : '',
      mediaId: platform === 'instagram' ? postId : ''
    }, credentials.token, credentials.baseUrl, config)
  })()
    .catch(error => {
      logger.warn(`[Meta social] No se pudo renovar el preview temporal ${postId}: ${error.message}`)
      return null
    })
    .finally(() => {
      metaSocialPostPreviewRefreshes.delete(refreshKey)
    })

  metaSocialPostPreviewRefreshes.set(refreshKey, refreshPromise)
  return refreshPromise
}

// Las URLs de fbcdn/scontent que quedaron en filas legacy pueden caducar aunque el
// mensaje y la publicación sigan existiendo. La primera lectura del chat las renueva
// contra Graph y las rehospeda; las siguientes lecturas ya usan la URL estable.
export async function refreshMetaSocialPostPreviewsForChat(messages = [], { limit = 6 } = {}) {
  const unique = new Map()
  // El query del chat regresa orden cronológico; recorremos al revés para reparar
  // primero lo que el usuario acaba de recibir y tiene visible al fondo del hilo.
  const newestFirst = Array.isArray(messages) ? [...messages].reverse() : []
  for (const message of newestFirst) {
    const platform = cleanString(message?.platform).toLowerCase() === 'instagram' ? 'instagram' : 'messenger'
    const postId = platform === 'instagram'
      ? cleanString(message?.media_id || message?.post_id)
      : cleanString(message?.post_id || message?.media_id)
    if (!postId || !isMetaHostedMediaUrl(message?.post_image_url)) continue
    if (cleanString(message?.post_type).toLowerCase() === 'deleted') continue
    if (!unique.has(`${platform}:${postId}`)) unique.set(`${platform}:${postId}`, message)
    if (unique.size >= Math.max(1, Number(limit) || 6)) break
  }

  const refreshed = new Map()
  const results = await Promise.allSettled(
    [...unique.entries()].map(async ([key, message]) => [key, await refreshMetaSocialPostPreviewForChat(message)])
  )
  results.forEach(result => {
    if (result.status !== 'fulfilled') return
    const [key, row] = result.value
    if (row?.image_url) refreshed.set(key, row)
  })
  return refreshed
}

// Nombre del participante vía el endpoint de conversaciones cuando el perfil
// directo viene restringido. La llamada conserva el contrato por plataforma:
// Messenger e Instagram usan Page/Facebook Graph; Instagram se opera desde la
// Página enlazada con el Page token derivado.
// La foto no sale por este fallback, solo el nombre.
async function fetchMetaConversationParticipantName({ platform, senderId, businessId, pageId, accessToken, baseUrl = getMetaSocialGraphBaseUrl(platform) }) {
  const conversationOwnerId = cleanString(businessId || pageId)
  if (!senderId || !accessToken) return ''
  if (platform !== 'instagram' && !conversationOwnerId) return ''
  try {
    const conversationsPath = `/${encodeURIComponent(conversationOwnerId)}/conversations`
    const data = await metaSocialGraphRequest(conversationsPath, {
      token: accessToken,
      baseUrl,
      query: {
        platform: platform === 'instagram' ? 'instagram' : 'messenger',
        user_id: senderId,
        fields: 'participants'
      }
    })
    for (const conversation of data.data || []) {
      for (const participant of conversation.participants?.data || []) {
        if (cleanString(participant.id) === cleanString(senderId)) {
          return compactName(participant.name)
        }
      }
    }
    return ''
  } catch (error) {
    logger.warn(`No se pudo leer nombre por conversaciones ${platform} ${senderId}: ${error.message}`)
    return ''
  }
}

async function fetchMetaSenderProfile({ platform, senderId, pageId = '', businessId = '', accessToken, baseUrl = getMetaSocialGraphBaseUrl(platform) }) {
  if (!senderId || !accessToken) return {}

  // OJO Instagram: un IGSID NO tiene el campo `profile_picture_url` — pedirlo
  // hace que Meta rechace TODA la petición con (#100) y el perfil vuelve vacío
  // (por eso el DM caía como "Instagram DM 0895…" sin nombre ni foto). Los
  // campos válidos para IG son name,username,profile_pic.
  const fields = platform === 'instagram'
    ? 'name,username,profile_pic'
    : 'id,name,first_name,last_name,profile_pic'

  let result = {}
  try {
    const data = await metaSocialGraphRequest(`/${encodeURIComponent(senderId)}`, {
      token: accessToken,
      baseUrl,
      query: { fields }
    })
    result = {
      name: compactName(data.name) || compactName(data.first_name, data.last_name),
      username: cleanString(data.username),
      profilePictureUrl: cleanString(data.profile_picture_url || data.profile_pic),
      raw: data
    }
  } catch (error) {
    logger.warn(`No se pudo leer perfil ${platform} ${senderId}: ${error.message}`)
  }

  // Fallback de NOMBRE: si el perfil directo no dio nombre (usuario no-rol), lo
  // sacamos de las conversaciones (ahí Meta sí lo entrega). La foto queda vacía.
  if (!cleanString(result.name)) {
    const conversationName = await fetchMetaConversationParticipantName({
      platform,
      senderId,
      businessId: businessId || pageId,
      accessToken,
      baseUrl
    })
    if (conversationName) result.name = conversationName
  }

  return result
}

function getFallbackContactName(platform, senderId) {
  const suffix = cleanString(senderId).slice(-6)
  return suffix ? `${getPlatformLabel(platform)} ${suffix}` : getPlatformLabel(platform)
}

function createMetaSocialMessageError(message, statusCode = 400, meta = null) {
  const error = new Error(message)
  error.statusCode = statusCode
  if (meta && typeof meta === 'object') error.meta = meta
  return error
}

function normalizeMetaGraphCode(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function createMetaSocialGraphError(data = {}, statusCode = 400, { path = '', method = 'GET' } = {}) {
  const graphError = data?.error || {}
  const originalMessage = cleanString(graphError.message) || `Meta Graph respondió ${statusCode}`
  return createMetaSocialMessageError(originalMessage, statusCode, {
    provider: 'meta',
    graphError: {
      code: normalizeMetaGraphCode(graphError.code),
      subcode: normalizeMetaGraphCode(graphError.error_subcode),
      type: cleanString(graphError.type),
      message: originalMessage,
      fbtraceId: cleanString(graphError.fbtrace_id),
      path: cleanString(path),
      method: cleanString(method).toUpperCase() || 'GET'
    }
  })
}

function isMetaCapabilityError(error) {
  const code = normalizeMetaGraphCode(error?.meta?.graphError?.code)
  const message = cleanString(error?.message)
  return code === 3 || /application does not have the capability/i.test(message)
}

function isMetaPermissionError(error) {
  const code = normalizeMetaGraphCode(error?.meta?.graphError?.code)
  const message = cleanString(error?.message)
  return code === 10 ||
    code === 200 ||
    code === 230 ||
    /requires .*permission|missing permission|permission to/i.test(message)
}

function createMetaSocialCapabilityMessage(platform) {
  if (platform === 'instagram') {
    return 'Meta bloqueó Instagram DM: falta capacidad de mensajería de Instagram en la app de Meta o la cuenta profesional no está habilitada para ese endpoint. Revisa instagram_manage_messages, app Live/Advanced Access y que Instagram esté enlazado a la Página. Detalle: (#3).'
  }

  return 'Meta bloqueó Messenger: falta aprobar pages_messaging en la app de Meta. Apruébalo, pon la app en Live si respondes a clientes reales y reconecta Meta en Ristak para regenerar el token. Detalle: (#3).'
}

function createMetaSocialPermissionMessage(platform) {
  if (platform === 'instagram') {
    return 'Meta rechazó Instagram DM por permisos insuficientes. Revisa que el token base pueda derivar el token de la Página y que incluya instagram_manage_messages; si usas Instagram Login directo, revisa instagram_business_manage_messages.'
  }

  return 'Meta rechazó Messenger por permisos insuficientes. Revisa que el token de la Página incluya pages_messaging y que la persona/cuenta tenga acceso de mensajería sobre la Página conectada.'
}

function createMetaSocialCommentPermissionMessage(platform, replyType) {
  const cleanPlatform = platform === 'instagram' ? 'instagram' : 'messenger'
  const mode = replyType === 'private' ? 'private' : 'public'

  if (cleanPlatform === 'instagram') {
    if (mode === 'public') {
      return 'Meta rechazó la respuesta pública al comentario de Instagram por permisos insuficientes. Revisa que el token de la Página incluya instagram_manage_comments y que la cuenta profesional esté enlazada a la Página conectada.'
    }
    return 'Meta rechazó el DM privado desde comentario de Instagram por permisos insuficientes. Revisa instagram_manage_messages y que la cuenta profesional esté enlazada a la Página conectada.'
  }

  if (mode === 'public') {
    return 'Meta rechazó la respuesta pública al comentario de Facebook por permisos insuficientes. Revisa que el token de la Página incluya pages_manage_engagement; para leer comentarios por API, Meta también puede exigir pages_read_user_content o Page Public Content Access.'
  }

  return 'Meta rechazó el DM privado desde comentario de Facebook por permisos insuficientes. Revisa que el token de la Página incluya pages_messaging y que la persona/cuenta tenga acceso de mensajería sobre la Página conectada.'
}

function normalizeMetaSocialSendError(error, platform) {
  const cleanPlatform = platform === 'instagram' ? 'instagram' : 'messenger'
  if (isMetaCapabilityError(error)) {
    return createMetaSocialMessageError(createMetaSocialCapabilityMessage(cleanPlatform), error.statusCode || 400, {
      ...(error.meta || {}),
      actionRequired: 'meta_app_capability'
    })
  }

  if (isMetaPermissionError(error)) {
    return createMetaSocialMessageError(createMetaSocialPermissionMessage(cleanPlatform), error.statusCode || 400, {
      ...(error.meta || {}),
      actionRequired: 'meta_permissions'
    })
  }

  return error
}

function normalizeMetaSocialCommentReplyError(error, platform, replyType) {
  const cleanPlatform = platform === 'instagram' ? 'instagram' : 'messenger'
  if (isMetaCapabilityError(error)) {
    return createMetaSocialMessageError(createMetaSocialCapabilityMessage(cleanPlatform), error.statusCode || 400, {
      ...(error.meta || {}),
      actionRequired: 'meta_app_capability'
    })
  }

  if (isMetaPermissionError(error)) {
    return createMetaSocialMessageError(createMetaSocialCommentPermissionMessage(cleanPlatform, replyType), error.statusCode || 400, {
      ...(error.meta || {}),
      actionRequired: 'meta_permissions'
    })
  }

  return normalizeMetaSocialSendError(error, cleanPlatform)
}

let oauthProofCache = { baseToken: '', baseProof: '', pageToken: '', pageProof: '', at: 0 }

async function resolveMetaAppSecretProof(token, explicitProof = '') {
  const cleanToken = cleanString(token)
  const provided = cleanString(explicitProof)
  if (provided) return provided
  const now = Date.now()
  if (now - oauthProofCache.at < 5 * 60 * 1000) {
    if (cleanToken && cleanToken === oauthProofCache.pageToken) return oauthProofCache.pageProof
    if (cleanToken && cleanToken === oauthProofCache.baseToken) return oauthProofCache.baseProof
  }
  const config = await getMetaSocialConfig().catch(() => null)
  if (!['oauth_bisu', 'oauth_user'].includes(cleanString(config?.connection_mode))) return ''
  oauthProofCache = {
    baseToken: cleanString(config?.access_token),
    baseProof: cleanString(config?.oauth_appsecret_proof),
    pageToken: cleanString(config?.oauth_page_access_token),
    pageProof: cleanString(config?.oauth_page_appsecret_proof),
    at: now
  }
  if (cleanToken === oauthProofCache.pageToken) return oauthProofCache.pageProof
  if (cleanToken === oauthProofCache.baseToken) return oauthProofCache.baseProof
  return ''
}

async function metaSocialGraphRequest(path, {
  method = 'GET',
  token,
  appSecretProof = '',
  query,
  body,
  baseUrl = API_URLS.META_GRAPH
} = {}) {
  const cleanToken = cleanString(token)
  if (!cleanToken) throw createMetaSocialMessageError('Meta no está conectado', 409)

  const url = new URL(`${baseUrl}${path}`)
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  })
  const proof = await resolveMetaAppSecretProof(cleanToken, appSecretProof)
  if (proof) url.searchParams.set('appsecret_proof', proof)

  let response
  try {
    response = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${cleanToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(metaSocialGraphTimeoutMs)
    })
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw createMetaSocialMessageError('Meta tardó demasiado en responder. Ristak no repetirá este intento a ciegas.', 504, {
        code: 'meta_graph_timeout',
        path,
        method
      })
    }
    throw createMetaSocialMessageError(safeMetaGraphTransportError(error), 502)
  }
  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw createMetaSocialGraphError(data, response.status, { path, method })
  }

  return data
}

// Campos de webhook de la Página que Ristak sabe procesar (ver
// processMetaSocialWebhook: message, postback, reaction, referral). Los mismos
// campos cubren Messenger e Instagram DM, porque el IG va enlazado a la Página.
// messaging_* para DMs; feed = comentarios de la Página de Facebook. Los
// comentarios de Instagram NO son campo de la Página: llegan por el objeto
// 'instagram' (comments/live_comments) suscrito a nivel de app en el panel de Meta.
// La suscripción de una Page se declara completa en cada conexión para que el
// inbox no pierda ecos, cambios ni estados cuando Meta vuelve a registrar el
// webhook. El historial previo se importa aparte por Conversations API.
export const META_PAGE_SUBSCRIBED_FIELDS = [
  'messages',
  'message_echoes',
  'message_edits',
  'message_reactions',
  'message_reads',
  'message_deliveries',
  'messaging_postbacks',
  'messaging_referrals',
  'feed'
]

// Meta exige un token de Página para operar DMs. Messenger prefiere el User
// Token humano guardado específicamente para esa superficie; Instagram, CAPI y
// anuncios conservan el System User Token principal. El Page token resultante se
// deriva on-demand y se cachea por token origen. Ante un 190 se re-deriva.
const PAGE_TOKEN_TTL_MS = 30 * 60 * 1000
let pageTokenCache = { pageId: '', sourceTokenHash: '', token: '', at: 0 }

export async function resolveMetaPageAccessToken({ config, forceRefresh = false, platform = 'messenger' } = {}) {
  const cfg = config || await getMetaSocialConfig().catch(() => null)
  const pageId = cleanString(cfg?.page_id)
  const isOAuth = ['oauth_bisu', 'oauth_user'].includes(cleanString(cfg?.connection_mode))
  if (isOAuth) {
    const oauthPageToken = cleanString(cfg?.oauth_page_access_token)
    if (!pageId) throw createMetaSocialMessageError('Falta seleccionar la Página de Facebook en Meta Ads.', 409)
    if (!oauthPageToken) {
      throw createMetaSocialMessageError('La conexión OAuth no tiene acceso cifrado para la Página seleccionada.', 409)
    }
    return oauthPageToken
  }
  const useMessengerToken = !isInstagramPlatform(platform)
  const userToken = cleanString(
    useMessengerToken
      ? cfg?.messenger_user_token || cfg?.access_token
      : cfg?.access_token
  )
  if (!pageId) throw createMetaSocialMessageError('Falta seleccionar la Página de Facebook en Meta Ads.', 409)
  if (!userToken) {
    throw createMetaSocialMessageError(
      useMessengerToken
        ? 'Guarda el User Token de Messenger y selecciona la Facebook Page para operar Messenger.'
        : 'Conecta Meta Ads para operar Instagram.',
      409
    )
  }

  // La Página puede mantenerse igual mientras el usuario reemplaza el System
  // User token (por ejemplo, después de corregir permisos). No reutilices el
  // Page token derivado del secreto anterior durante los 30 minutos de caché.
  const sourceTokenHash = crypto.createHash('sha256').update(userToken).digest('hex')
  const now = Date.now()
  if (
    !forceRefresh &&
    pageTokenCache.token &&
    pageTokenCache.pageId === pageId &&
    pageTokenCache.sourceTokenHash === sourceTokenHash &&
    (now - pageTokenCache.at) < PAGE_TOKEN_TTL_MS
  ) {
    return pageTokenCache.token
  }

  const data = await metaSocialGraphRequest(`/${encodeURIComponent(pageId)}`, {
    token: userToken,
    query: { fields: 'access_token' }
  })
  const pageToken = cleanString(data?.access_token)
  if (!pageToken) {
    throw createMetaSocialMessageError(
      'Meta no devolvió el token de la Página. Revisa que tu usuario administre esa Página y tenga permisos de mensajería.',
      409
    )
  }

  pageTokenCache = { pageId, sourceTokenHash, token: pageToken, at: now }
  return pageToken
}

// Un Page token recién regenerado puede arreglar un rechazo #200 cuando Meta
// acabó de reconocer permisos nuevos. El primer POST fue rechazado, por lo que
// repetirlo una única vez con el token de Página rederivado no duplica mensajes.
function shouldRefreshMetaPageToken(error) {
  return error?.statusCode === 401 ||
    isMetaPermissionError(error) ||
    /oauth|access token|\b190\b/i.test(error?.message || '')
}

// Devuelve el mejor token disponible para leer/enviar por la Página, cayendo al
// token origen si por alguna razón no se puede derivar el de Página (para no
// romper el flujo de recepción por un fallo transitorio de derivación).
async function resolveMetaPageTokenSafe(config, platform = 'messenger') {
  const fallbackToken = cleanString(
    isInstagramPlatform(platform)
      ? config?.access_token
      : config?.messenger_user_token || config?.access_token
  )
  return resolveMetaPageAccessToken({ config, platform }).catch(error => {
    logger.warn(`No se pudo derivar token de Página, usando token base: ${error.message}`)
    return fallbackToken
  })
}

function isInstagramPlatform(platform = '') {
  return cleanString(platform).toLowerCase() === 'instagram'
}

function getMetaSocialGraphBaseUrl() {
  return API_URLS.META_GRAPH
}

function hasMetaSocialGraphTokenSource(platform, config = {}) {
  if (isInstagramPlatform(platform)) {
    return Boolean(
      cleanString(config?.access_token) &&
      cleanString(config?.page_id) &&
      cleanString(config?.instagram_account_id)
    )
  }

  return Boolean(cleanString(config?.access_token))
}

async function resolveMetaSocialGraphCredentials(platform, config, { forceRefresh = false, safe = false } = {}) {
  if (isInstagramPlatform(platform)) {
    let token = ''
    try {
      token = await resolveMetaPageAccessToken({ config, forceRefresh, platform: 'instagram' })
    } catch (error) {
      if (!safe) throw error
      logger.warn(`No se pudo derivar token de Página para Instagram: ${error.message}`)
    }
    return { token, baseUrl: API_URLS.META_GRAPH, tokenSource: 'page' }
  }

  const token = safe
    ? await resolveMetaPageTokenSafe(config, 'messenger')
    : await resolveMetaPageAccessToken({ config, forceRefresh, platform: 'messenger' })
  return { token, baseUrl: API_URLS.META_GRAPH, tokenSource: 'page' }
}

async function resolveMetaSocialGraphToken(platform, config, { forceRefresh = false, safe = false } = {}) {
  const credentials = await resolveMetaSocialGraphCredentials(platform, config, { forceRefresh, safe })
  if (!credentials.token && !safe) {
    throw createMetaSocialMessageError(
      isInstagramPlatform(platform)
        ? 'Conecta Meta Ads y selecciona la Página enlazada a Instagram para operar Instagram.'
        : 'Conecta Meta Ads para operar Messenger.',
      409
    )
  }

  return credentials.token
}

function normalizeMetaSocialHistoryPlatform(platform = '') {
  return isInstagramPlatform(platform) ? 'instagram' : 'messenger'
}

function normalizeOptionalHistoryLimit(value) {
  if (value === null || value === undefined || value === '') return Number.POSITIVE_INFINITY
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : Number.POSITIVE_INFINITY
}

function getMetaSocialHistoryBusinessId(platform, config = {}) {
  return platform === 'instagram'
    ? cleanString(config.instagram_account_id)
    : cleanString(config.page_id)
}

function getMetaSocialHistoryConversationPath(platform, businessId) {
  return `/${encodeURIComponent(businessId)}/conversations`
}

function getMetaSocialHistoryPlatformParam(platform) {
  return platform === 'instagram' ? 'instagram' : 'messenger'
}

function getGraphNextAfter(data = {}) {
  if (!data?.paging?.next) return ''
  return cleanString(data?.paging?.cursors?.after)
}

function buildMetaSocialBusinessIdSet(platform, config = {}, businessId = '') {
  return new Set([
    cleanString(businessId),
    cleanString(config.page_id),
    cleanString(config.instagram_account_id)
  ].filter(Boolean))
}

function getConversationParticipants(conversation = {}) {
  return normalizeGraphCollection(conversation.participants)
}

function getMessageRecipients(message = {}) {
  return normalizeGraphCollection(message.to)
}

function findParticipantById(participants = [], id = '') {
  const cleanId = cleanString(id)
  if (!cleanId) return null
  return participants.find(participant => cleanString(participant?.id) === cleanId) || null
}

function findCustomerParticipant(participants = [], businessIds = new Set()) {
  return participants.find(participant => {
    const id = cleanString(participant?.id)
    return id && !businessIds.has(id)
  }) || null
}

function isNewerMetaTimestamp(candidate = '', current = '') {
  const candidateMs = Date.parse(candidate)
  const currentMs = Date.parse(current)
  if (!Number.isFinite(candidateMs)) return false
  if (!Number.isFinite(currentMs)) return true
  return candidateMs > currentMs
}

function buildMetaSocialMessageFromGraphConversation({ platform, config, conversation, graphMessage, businessId }) {
  const cleanPlatform = normalizeMetaSocialHistoryPlatform(platform)
  const businessIds = buildMetaSocialBusinessIdSet(cleanPlatform, config, businessId)
  const participants = getConversationParticipants(conversation)
  const recipients = getMessageRecipients(graphMessage)
  const recipientIds = recipients.map(recipient => cleanString(recipient?.id)).filter(Boolean)
  const fromId = cleanString(graphMessage?.from?.id)
  const fromIsBusiness = fromId && businessIds.has(fromId)
  const direction = fromIsBusiness ? 'outbound' : 'inbound'
  const fallbackCustomer = findCustomerParticipant(participants, businessIds)
  const customerId = direction === 'inbound'
    ? fromId
    : recipientIds.find(id => id && !businessIds.has(id)) || cleanString(fallbackCustomer?.id)

  if (!customerId || businessIds.has(customerId)) return null

  const recipientId = direction === 'inbound'
    ? recipientIds.find(id => businessIds.has(id)) || businessId
    : businessId
  const participant = findParticipantById(participants, customerId) ||
    (direction === 'inbound'
      ? graphMessage.from
      : recipients.find(recipient => cleanString(recipient?.id) === customerId)) ||
    fallbackCustomer ||
    {}
  const text = cleanString(graphMessage?.message)
  const attachments = extractGraphMessageAttachments(graphMessage)
  const primaryAttachment = attachments[0] || {}
  const messageTimestamp = normalizeMetaGraphTimestamp(graphMessage?.created_time)

  const baseMessageId = cleanString(graphMessage?.id)
  const buildSocialMessage = (attachment = primaryAttachment, attachmentIndex = 0) => ({
      platform: cleanPlatform,
      direction,
      senderId: customerId,
      recipientId,
      pageId: cleanPlatform === 'messenger' ? cleanString(config.page_id || businessId) : cleanString(config.page_id),
      instagramAccountId: cleanPlatform === 'instagram' ? cleanString(config.instagram_account_id || businessId) : cleanString(config.instagram_account_id),
      // Meta agrupa varios adjuntos bajo un solo mensaje. El primero conserva el
      // MID real para replies/reacciones; los adicionales usan IDs locales estables
      // derivados del MID para que cada archivo pueda vivir y mostrarse en el chat.
      metaMessageId: attachmentIndex === 0 ? baseMessageId : `${baseMessageId}:attachment:${attachmentIndex}`,
      messageType: attachment.messageType || (text ? 'text' : 'message'),
      messageText: attachmentIndex === 0 ? (text || attachment.messageText || '') : (attachment.messageText || ''),
      mediaUrl: attachment.mediaUrl || '',
      mediaMimeType: attachment.mediaMimeType || '',
      postbackPayload: '',
      referral: null,
      messageTimestamp,
      raw: {
        provider: 'meta',
        source: 'conversation_backfill',
        conversationId: cleanString(conversation?.id),
        providerMessageId: baseMessageId,
        attachmentIndex,
        attachmentCount: attachments.length,
        message: graphMessage
      }
    })

  return {
    socialMessages: attachments.length
      ? attachments.map((attachment, index) => buildSocialMessage(attachment, index))
      : [buildSocialMessage({}, 0)],
    participant
  }
}

async function resolveMetaSocialHistoryProfile({ platform, senderId, participant, profileCache }) {
  const key = `${platform}:${senderId}`
  if (profileCache.has(key)) return profileCache.get(key)

  // Conversations API ya entrega la identidad del participante junto con cada
  // conversación. Volver a consultar /{PSID|IGSID} por cada contacto duplica el
  // tráfico, suele ser rechazado para PSIDs antiguos y no aporta nada al
  // historial. Los webhooks nuevos conservan su enriquecimiento normal; el
  // backfill usa únicamente los datos que Meta ya devolvió en la conversación.
  const profile = {
    name: compactName(participant?.name),
    username: cleanString(participant?.username),
    profilePictureUrl: cleanString(
      participant?.profile_pic ||
      participant?.profile_picture_url
    ),
    raw: {
      participant: participant || null
    }
  }
  profileCache.set(key, profile)
  return profile
}

async function fetchMetaSocialHistoryMessagesPage({ platform, conversationId, graphToken, baseUrl, after = '', limit }) {
  return metaSocialGraphRequest(`/${encodeURIComponent(conversationId)}/messages`, {
    token: graphToken,
    baseUrl,
    query: {
      fields: META_SOCIAL_HISTORY_MESSAGE_FIELDS,
      limit,
      ...(after ? { after } : {})
    }
  })
}

async function syncMetaSocialConversationMessages({
  platform,
  config,
  conversation,
  businessId,
  graphToken,
  baseUrl,
  maxMessagesPerConversation,
  maxTotalMessages,
  profileCache,
  publishEvents,
  stats
}) {
  const conversationId = cleanString(conversation?.id)
  if (!conversationId) {
    stats.skippedMessages += 1
    return false
  }

  let after = ''
  let pages = 0
  let messagesInConversation = 0
  const seenCursors = new Set()
  let latestPublished = null

  while (messagesInConversation < maxMessagesPerConversation && stats.messagesScanned < maxTotalMessages) {
    const data = await fetchMetaSocialHistoryMessagesPage({
      platform,
      conversationId,
      graphToken,
      baseUrl,
      after,
      limit: Math.min(META_SOCIAL_HISTORY_MESSAGE_PAGE_LIMIT, maxMessagesPerConversation - messagesInConversation)
    })
    pages += 1
    const messages = normalizeGraphCollection(data)
    if (!messages.length) break

    for (const graphMessage of messages) {
      if (messagesInConversation >= maxMessagesPerConversation || stats.messagesScanned >= maxTotalMessages) break
      messagesInConversation += 1
      stats.messagesScanned += 1

      const normalized = buildMetaSocialMessageFromGraphConversation({
        platform,
        config,
        conversation,
        graphMessage,
        businessId
      })
      if (!normalized?.socialMessages?.length) {
        stats.skippedMessages += 1
        continue
      }

      const { socialMessages, participant } = normalized
      const firstSocialMessage = socialMessages[0]
      const profile = await resolveMetaSocialHistoryProfile({
        platform: firstSocialMessage.platform,
        senderId: firstSocialMessage.senderId,
        participant,
        profileCache
      })
      const localContact = await upsertLocalSocialContact({ socialMessage: firstSocialMessage, profile })

      for (const socialMessage of socialMessages) {
        const messageId = getMetaSocialMessageLocalId(socialMessage)
        const existing = await db.get('SELECT id FROM meta_social_messages WHERE id = ?', [messageId]).catch(() => null)
        const socialContactId = await upsertMetaSocialContact({
          contactId: localContact.id,
          socialMessage,
          profile,
          incrementMessageCount: !existing
        })
        const savedMessage = await upsertMetaSocialMessage({
          socialContactId,
          contactId: localContact.id,
          socialMessage,
          config,
          historyImport: true
        })

        if (savedMessage.isNew && socialMessage.direction === 'inbound') {
          await captureMetaSocialContactIdentity({ contactId: localContact.id, socialMessage })
        }

        if (savedMessage.isNew) stats.saved += 1
        else stats.updated += 1

        if (
          publishEvents &&
          savedMessage.isNew &&
          (!latestPublished || isNewerMetaTimestamp(socialMessage.messageTimestamp, latestPublished.messageTimestamp))
        ) {
          latestPublished = {
            contactId: localContact.id,
            contactName: localContact.contactName,
            messageId: savedMessage.messageId,
            platform: socialMessage.platform,
            direction: socialMessage.direction,
            messageType: socialMessage.messageType,
            messageTimestamp: socialMessage.messageTimestamp
          }
        }
      }
    }

    const nextAfter = getGraphNextAfter(data)
    if (nextAfter && messagesInConversation >= maxMessagesPerConversation) {
      stats.truncated = true
    }
    if (!nextAfter || seenCursors.has(nextAfter)) break
    seenCursors.add(nextAfter)
    after = nextAfter
  }

  if (latestPublished) {
    publishChatMessageEvent({
      contactId: latestPublished.contactId,
      messageId: latestPublished.messageId,
      channel: latestPublished.platform,
      provider: 'meta',
      transport: latestPublished.platform,
      direction: latestPublished.direction,
      messageType: latestPublished.messageType,
      messageTimestamp: latestPublished.messageTimestamp,
      isNew: true,
      historyImport: true
    })
  }

  stats.messagePages += pages
  return stats.messagesScanned >= maxTotalMessages
}

export async function syncMetaSocialConversationHistory({
  platform = 'messenger',
  config = null,
  reason = 'manual',
  maxConversations = null,
  maxMessagesPerConversation = null,
  maxTotalMessages = null,
  publishEvents = true
} = {}) {
  const cleanPlatform = normalizeMetaSocialHistoryPlatform(platform)
  const stats = {
    provider: 'meta',
    platform: cleanPlatform,
    reason: cleanString(reason) || 'manual',
    skipped: false,
    skipReason: '',
    conversations: 0,
    conversationPages: 0,
    messagePages: 0,
    messagesScanned: 0,
    saved: 0,
    updated: 0,
    skippedMessages: 0,
    truncated: false
  }

  const enabled = await isMetaSocialMessagingEnabled(cleanPlatform)
  if (!enabled) {
    return {
      ...stats,
      skipped: true,
      skipReason: 'messaging-disabled'
    }
  }

  const cfg = config || await getMetaSocialConfig()
  const businessId = getMetaSocialHistoryBusinessId(cleanPlatform, cfg || {})
  if (!businessId) {
    return {
      ...stats,
      skipped: true,
      skipReason: cleanPlatform === 'instagram' ? 'missing-instagram-account' : 'missing-page'
    }
  }

  const graphCredentials = await resolveMetaSocialGraphCredentials(cleanPlatform, cfg)
  const graphToken = graphCredentials.token
  const baseUrl = graphCredentials.baseUrl
  const conversationLimit = normalizeOptionalHistoryLimit(maxConversations)
  const messageLimit = normalizeOptionalHistoryLimit(maxMessagesPerConversation)
  const totalMessageLimit = normalizeOptionalHistoryLimit(maxTotalMessages)
  const profileCache = new Map()
  const seenCursors = new Set()
  let after = ''

  while (stats.conversations < conversationLimit && stats.messagesScanned < totalMessageLimit) {
    const data = await metaSocialGraphRequest(getMetaSocialHistoryConversationPath(cleanPlatform, businessId), {
      token: graphToken,
      baseUrl,
      query: {
        platform: getMetaSocialHistoryPlatformParam(cleanPlatform),
        fields: 'id,participants,updated_time',
        limit: Math.min(META_SOCIAL_HISTORY_CONVERSATION_PAGE_LIMIT, conversationLimit - stats.conversations),
        ...(after ? { after } : {})
      }
    })
    stats.conversationPages += 1
    const conversations = normalizeGraphCollection(data)
    if (!conversations.length) break

    for (const conversation of conversations) {
      if (stats.conversations >= conversationLimit || stats.messagesScanned >= totalMessageLimit) break
      stats.conversations += 1
      const reachedTotalLimit = await syncMetaSocialConversationMessages({
        platform: cleanPlatform,
        config: cfg,
        conversation,
        businessId,
        graphToken,
        baseUrl,
        maxMessagesPerConversation: messageLimit,
        maxTotalMessages: totalMessageLimit,
        profileCache,
        publishEvents,
        stats
      })
      if (reachedTotalLimit) break
    }

    const nextAfter = getGraphNextAfter(data)
    if (nextAfter && (
      stats.conversations >= conversationLimit ||
      stats.messagesScanned >= totalMessageLimit
    )) {
      stats.truncated = true
    }
    if (!nextAfter || seenCursors.has(nextAfter)) break
    seenCursors.add(nextAfter)
    after = nextAfter
  }

  return stats
}

export function syncMetaSocialConversationHistoryInBackground({ platforms = ['messenger', 'instagram'], reason = 'connection' } = {}) {
  const cleanPlatforms = [...new Set((Array.isArray(platforms) ? platforms : [platforms]).map(normalizeMetaSocialHistoryPlatform))]
  const started = []
  const skipped = []

  for (const platform of cleanPlatforms) {
    if (metaSocialHistorySyncing.has(platform)) {
      skipped.push({ platform, reason: 'already-running' })
      continue
    }

    metaSocialHistorySyncing.add(platform)
    started.push(platform)
    syncMetaSocialConversationHistory({ platform, reason })
      .then(result => {
        if (result?.skipped) {
          logger.info(`Meta social: historial ${platform} omitido (${result.skipReason || 'sin razon'})`)
          return
        }
        logger.info(
          `Meta social: historial ${platform} importado ` +
          `(${result.saved} nuevos, ${result.updated} existentes, ${result.conversations} conversaciones, ${result.messagesScanned} mensajes leidos)`
        )
      })
      .catch(error => {
        logger.warn(`Meta social: no se pudo importar historial ${platform}: ${error.message}`)
      })
      .finally(() => {
        metaSocialHistorySyncing.delete(platform)
      })
  }

  return {
    syncStarted: started.length > 0,
    started,
    skipped
  }
}

// ─── Listado de publicaciones para el selector de disparadores/condiciones ───
// Trae las publicaciones de la Página (FB published_posts) o de la cuenta (IG
// media) paginando contra Graph, las cachea en meta_social_posts, y luego sirve
// desde el caché con búsqueda por texto o ID. Así el dropdown carga rápido y la
// carga fuerte contra Meta solo ocurre una vez cada POSTS_SYNC_TTL_MS.
const POSTS_SYNC_TTL_MS = 10 * 60 * 1000
const POSTS_MAX_SYNC = 200
const POSTS_QUICK_PAGES = 1        // primera carga: 1 página (~50) para responder ya
const POSTS_UPSERT_CHUNK = 40      // filas por INSERT en lote
const postsSyncState = new Map()   // 'facebook' | 'instagram' -> timestamp del último sync completo
const postsSyncing = new Set()     // plataformas con sync en curso (evita duplicar)

function normalizeSocialPostPlatform(platform) {
  return String(platform || '').toLowerCase() === 'instagram' ? 'instagram' : 'facebook'
}

async function syncMetaSocialPostsFromGraph(platform, config, graphToken, { maxPages = Infinity, baseUrl = '' } = {}) {
  const isIg = platform === 'instagram'
  const businessId = isIg ? cleanString(config?.instagram_account_id) : cleanString(config?.page_id)
  if (!businessId) return 0
  const edge = isIg ? 'media' : 'published_posts'
  const graphBaseUrl = cleanString(baseUrl) || getMetaSocialGraphBaseUrl(platform)
  const fields = isIg
    ? 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp'
    : 'id,message,story,full_picture,permalink_url,created_time'

  let after = ''
  let fetched = 0
  let pages = 0
  const rows = []
  while (fetched < POSTS_MAX_SYNC && pages < maxPages) {
    const query = { fields, limit: 50 }
    if (after) query.after = after
    let data
    try {
      data = await metaSocialGraphRequest(`/${encodeURIComponent(businessId)}/${edge}`, { token: graphToken, baseUrl: graphBaseUrl, query })
    } catch (error) {
      if (!rows.length) throw error // primer batch falla (permiso/token) → propaga
      logger.warn(`[Meta posts] paginación cortada en ${platform}: ${error.message}`)
      break
    }
    const items = Array.isArray(data?.data) ? data.data : []
    for (const it of items) {
      const id = cleanString(it?.id)
      if (!id) continue
      rows.push({
        id,
        message: isIg ? cleanString(it?.caption) : (cleanString(it?.message) || cleanString(it?.story)),
        imageUrl: isIg ? cleanString(it?.thumbnail_url || it?.media_url) : cleanString(it?.full_picture),
        permalink: isIg ? cleanString(it?.permalink) : cleanString(it?.permalink_url),
        postType: isIg ? (cleanString(it?.media_type) || 'media') : 'post',
        postedAt: cleanString(it?.timestamp || it?.created_time) || null,
        raw: it
      })
    }
    fetched += items.length
    pages += 1
    after = cleanString(data?.paging?.cursors?.after)
    if (!after || !items.length) break
  }

  // Upsert por LOTES (un INSERT por chunk, no uno por fila) → mucho menos
  // round-trips a Postgres, que es lo que hacía lenta la carga inicial.
  for (let i = 0; i < rows.length; i += POSTS_UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + POSTS_UPSERT_CHUNK)
    const valuesSql = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)').join(', ')
    const params = []
    for (const r of chunk) {
      params.push(r.id, platform, r.postType, r.message || null, r.imageUrl || null, r.permalink || null, r.postedAt, safeJson(r.raw))
    }
    await db.run(`
      INSERT INTO meta_social_posts (id, platform, post_type, message, image_url, permalink, posted_at, raw_json, fetched_at, updated_at)
      VALUES ${valuesSql}
      ON CONFLICT(id) DO UPDATE SET
        platform = excluded.platform,
        post_type = excluded.post_type,
        message = COALESCE(NULLIF(excluded.message, ''), meta_social_posts.message),
        image_url = COALESCE(NULLIF(excluded.image_url, ''), meta_social_posts.image_url),
        permalink = COALESCE(NULLIF(excluded.permalink, ''), meta_social_posts.permalink),
        posted_at = COALESCE(excluded.posted_at, meta_social_posts.posted_at),
        raw_json = excluded.raw_json,
        updated_at = CURRENT_TIMESTAMP
    `, params).catch((error) => logger.warn(`[Meta posts] no se pudo guardar lote: ${error.message}`))
  }
  return rows.length
}

// Ejecuta UNA sincronización con guard anti-duplicado. Marca "fresco" solo tras
// una pasada COMPLETA; el quick-sync de la primera carga no la marca para que el
// sync de fondo la complete después.
async function syncPostsOnce(platform, config, { maxPages = Infinity } = {}) {
  if (postsSyncing.has(platform)) return 0
  postsSyncing.add(platform)
  try {
    const graphCredentials = await resolveMetaSocialGraphCredentials(platform, config)
    const n = await syncMetaSocialPostsFromGraph(platform, config, graphCredentials.token, { maxPages, baseUrl: graphCredentials.baseUrl })
    if (maxPages === Infinity) postsSyncState.set(platform, Date.now())
    logger.info(`[Meta posts] ${platform}: ${n} publicaciones sincronizadas`)
    return n
  } finally {
    postsSyncing.delete(platform)
  }
}

export async function listMetaSocialPosts({ platform = 'facebook', search = '', limit = 25, offset = 0, refresh = false } = {}) {
  const cleanPlatform = normalizeSocialPostPlatform(platform)
  const config = await getMetaSocialConfig().catch(() => null)
  const businessId = cleanPlatform === 'instagram'
    ? cleanString(config?.instagram_account_id)
    : cleanString(config?.page_id)
  if (!businessId) {
    throw createMetaSocialMessageError(
      cleanPlatform === 'instagram'
        ? 'Conecta una cuenta de Instagram en Meta Ads para elegir publicaciones.'
        : 'Selecciona la Página de Facebook en Meta Ads para elegir publicaciones.',
      409
    )
  }

  // FB puede estar cacheado como 'facebook' o (legado, desde comentarios) 'messenger'.
  const platformFilter = cleanPlatform === 'instagram' ? ['instagram'] : ['facebook', 'messenger']
  const inClause = platformFilter.map(() => '?').join(',')

  const cachedCount = await db.get(
    `SELECT COUNT(*) AS n FROM meta_social_posts WHERE platform IN (${inClause})`,
    platformFilter
  ).then((r) => Number(r?.n) || 0).catch(() => 0)

  const lastSync = postsSyncState.get(cleanPlatform) || 0
  const stale = (Date.now() - lastSync) > POSTS_SYNC_TTL_MS
  if (cachedCount === 0) {
    // Sin caché: trae SOLO la primera página de forma síncrona para responder ya,
    // y completa el resto en segundo plano (el dropdown ya muestra publicaciones).
    const graphCredentials = await resolveMetaSocialGraphCredentials(cleanPlatform, config)
    await syncMetaSocialPostsFromGraph(cleanPlatform, config, graphCredentials.token, { maxPages: POSTS_QUICK_PAGES, baseUrl: graphCredentials.baseUrl })
    void syncPostsOnce(cleanPlatform, config).catch(() => {})
  } else if (refresh) {
    // Refresco manual: el usuario lo pidió, esperamos la pasada completa.
    await syncPostsOnce(cleanPlatform, config).catch((error) =>
      logger.warn(`[Meta posts] refresco ${cleanPlatform} falló: ${error.message}`))
  } else if (stale) {
    // Caché viejo: responde YA del caché y refresca en segundo plano.
    void syncPostsOnce(cleanPlatform, config).catch(() => {})
  }

  const cleanSearch = cleanString(search).toLowerCase()
  const where = [`platform IN (${inClause})`]
  const params = [...platformFilter]
  if (cleanSearch) {
    where.push('(LOWER(message) LIKE ? OR LOWER(id) LIKE ? OR LOWER(permalink) LIKE ?)')
    const like = `%${cleanSearch}%`
    params.push(like, like, like)
  }
  const whereSql = where.join(' AND ')

  const total = await db.get(`SELECT COUNT(*) AS n FROM meta_social_posts WHERE ${whereSql}`, params)
    .then((r) => Number(r?.n) || 0).catch(() => 0)
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100)
  const safeOffset = Math.max(Number(offset) || 0, 0)
  const rows = await db.all(
    `SELECT id, platform, post_type, message, image_url, permalink, posted_at
     FROM meta_social_posts WHERE ${whereSql}
     ORDER BY (posted_at IS NULL), posted_at DESC, updated_at DESC
     LIMIT ? OFFSET ?`,
    [...params, safeLimit, safeOffset]
  ).catch(() => [])

  const posts = rows.map((r) => ({
    id: r.id,
    platform: r.platform === 'instagram' ? 'instagram' : 'facebook',
    type: r.post_type || '',
    message: r.message || '',
    imageUrl: r.image_url || '',
    permalink: r.permalink || '',
    postedAt: r.posted_at || ''
  }))
  return { posts, total, hasMore: safeOffset + posts.length < total }
}

/**
 * Suscribe la Página de Facebook al webhook de la app (subscribed_apps).
 * Este es el paso que le dice a Meta "mándame los mensajes de esta Página".
 * Activar el toggle en Ristak NO basta: sin esta suscripción Meta nunca llama al
 * webhook. Es idempotente: se puede llamar cuantas veces se quiera.
 */
export async function ensureMetaPageMessagingSubscription({ config: explicitConfig = null } = {}) {
  const config = explicitConfig || await getMetaSocialConfig().catch(() => null)
  const pageId = cleanString(config?.page_id)
  if (!pageId) throw createMetaSocialMessageError('Falta seleccionar la Página de Facebook en Meta Ads.', 409)

  const pageToken = await resolveMetaPageAccessToken({ config, platform: 'messenger' })
  await metaSocialGraphRequest(`/${encodeURIComponent(pageId)}/subscribed_apps`, {
    method: 'POST',
    token: pageToken,
    appSecretProof: config?.oauth_page_appsecret_proof,
    query: { subscribed_fields: META_PAGE_SUBSCRIBED_FIELDS.join(',') }
  })

  logger.info(`[Meta social] Página ${pageId} suscrita al webhook de mensajería (${META_PAGE_SUBSCRIBED_FIELDS.join(',')})`)
  return { pageId, subscribedFields: [...META_PAGE_SUBSCRIBED_FIELDS] }
}

/** Revierte únicamente la suscripción de la app representada por el token. */
export async function removeMetaPageMessagingSubscription({ config: explicitConfig = null } = {}) {
  const config = explicitConfig || await getMetaSocialConfig().catch(() => null)
  const pageId = cleanString(config?.page_id)
  if (!pageId) return { pageId: '', unsubscribed: false, skipped: true }

  const pageToken = await resolveMetaPageAccessToken({ config, platform: 'messenger', forceRefresh: true })
  await metaSocialGraphRequest(`/${encodeURIComponent(pageId)}/subscribed_apps`, {
    method: 'DELETE',
    token: pageToken,
    appSecretProof: config?.oauth_page_appsecret_proof
  })
  return { pageId, unsubscribed: true }
}

/**
 * Reconcilia la suscripción del inbox al arrancar una instalación ya conectada.
 *
 * El flujo de conexión y el toggle de Messenger ya registran la Página, pero
 * instalaciones que se conectaron antes de agregar un campo nuevo al webhook no
 * vuelven a pasar por ese flujo. Meta no agrega automáticamente los campos que
 * el cliente empieza a necesitar después. Esta pasada idempotente conserva la
 * suscripción completa sin tocar cuentas donde Messenger está apagado.
 */
export async function reconcileMetaPageMessagingSubscription({
  isMessengerEnabled = isMetaSocialMessagingEnabled,
  ensureSubscription = ensureMetaPageMessagingSubscription
} = {}) {
  if (!(await isMessengerEnabled('messenger'))) {
    return { skipped: true, reason: 'messenger-disabled' }
  }

  return {
    skipped: false,
    ...(await ensureSubscription())
  }
}

/** Lee la suscripción actual de la Página (para verificar/diagnosticar). */
export async function getMetaPageMessagingSubscription() {
  const config = await getMetaSocialConfig().catch(() => null)
  const pageId = cleanString(config?.page_id)
  if (!pageId) return { pageId: '', subscribed: false, apps: [] }

  const pageToken = await resolveMetaPageAccessToken({ config, platform: 'messenger' })
  const data = await metaSocialGraphRequest(`/${encodeURIComponent(pageId)}/subscribed_apps`, {
    token: pageToken
  })
  const apps = Array.isArray(data?.data) ? data.data : []
  const subscribed = apps.some(app => Array.isArray(app?.subscribed_fields)
    ? app.subscribed_fields.some(f => (typeof f === 'string' ? f : f?.name) === 'messages')
    : false)
  return { pageId, subscribed, apps }
}

function getMetaSocialBusinessId(platform, config = {}, profile = {}) {
  if (platform === 'instagram') {
    return cleanString(profile.instagram_account_id) || cleanString(config.instagram_account_id)
  }

  return cleanString(profile.page_id) || cleanString(config.page_id)
}

function getMetaInstagramMessagesPath({ config = {} } = {}) {
  const pageId = cleanString(config?.page_id)
  if (!pageId) {
    throw createMetaSocialMessageError('Falta seleccionar la Página enlazada a Instagram en Meta Ads.', 409)
  }
  return `/${encodeURIComponent(pageId)}/messages`
}

async function resolveMetaSocialMessageReference({ contactId, platform, messageId, providerMessageId } = {}) {
  const cleanContactId = cleanString(contactId)
  const cleanPlatform = cleanString(platform).toLowerCase() === 'instagram' ? 'instagram' : 'messenger'
  const cleanMessageId = cleanString(messageId)
  const cleanProviderMessageId = cleanString(providerMessageId)
  if (!cleanContactId || (!cleanMessageId && !cleanProviderMessageId)) return null

  const row = await db.get(`
    SELECT id, meta_message_id, message_type, message_text, raw_payload_json
    FROM meta_social_messages
    WHERE contact_id = ?
      AND platform = ?
      AND (
        (? != '' AND id = ?)
        OR (? != '' AND meta_message_id = ?)
      )
    ORDER BY updated_at DESC
    LIMIT 1
  `, [
    cleanContactId,
    cleanPlatform,
    cleanMessageId, cleanMessageId,
    cleanProviderMessageId, cleanProviderMessageId
  ]).catch(() => null)

  const rawPayload = parseJsonObject(row?.raw_payload_json)
  const remoteId = cleanString(
    row?.meta_message_id ||
    rawPayload?.response?.message_id ||
    cleanProviderMessageId
  )
  if (!remoteId) return null

  return {
    localMessageId: cleanString(row?.id),
    providerMessageId: remoteId,
    messageType: cleanString(row?.message_type),
    text: cleanString(row?.message_text)
  }
}

function normalizeMetaReactionValue(emoji) {
  const value = cleanString(emoji)
  if (!value) return ''
  const normalized = value.toLowerCase()
  if (normalized === 'love' || value === '❤️' || value === '❤') return 'love'
  return ''
}

async function sendMetaMessengerTextRequest({ businessId, recipientId, body, config, replyToProviderMessageId = '' }) {
  const sendPayload = {
    messaging_type: 'RESPONSE',
    recipient: { id: recipientId },
    message: {
      text: body,
      ...(replyToProviderMessageId ? { reply_to: { mid: replyToProviderMessageId } } : {})
    }
  }

  try {
    return await metaSocialGraphRequest(`/${encodeURIComponent(businessId)}/messages`, {
      method: 'POST',
      token: await resolveMetaPageAccessToken({ config, platform: 'messenger' }),
      body: sendPayload
    })
  } catch (error) {
    if (!shouldRefreshMetaPageToken(error)) throw error
    return await metaSocialGraphRequest(`/${encodeURIComponent(businessId)}/messages`, {
      method: 'POST',
      token: await resolveMetaPageAccessToken({ config, forceRefresh: true, platform: 'messenger' }),
      body: sendPayload
    })
  }
}

async function withRefreshedMetaInstagramCredentials(config, callback) {
  const credentials = await resolveMetaSocialGraphCredentials('instagram', config)
  try {
    return await callback(credentials)
  } catch (error) {
    if (!shouldRefreshMetaPageToken(error)) throw error
    const refreshedCredentials = await resolveMetaSocialGraphCredentials('instagram', config, { forceRefresh: true })
    return callback(refreshedCredentials)
  }
}

async function sendMetaInstagramTextRequest({ businessId, recipientId, body, config, replyToProviderMessageId = '' }) {
  return withRefreshedMetaInstagramCredentials(config, graphCredentials => (
    metaSocialGraphRequest(getMetaInstagramMessagesPath({ businessId, config, credentials: graphCredentials }), {
      method: 'POST',
      token: graphCredentials.token,
      baseUrl: graphCredentials.baseUrl,
      body: {
        recipient: { id: recipientId },
        message: {
          text: body,
          ...(replyToProviderMessageId ? { reply_to: { mid: replyToProviderMessageId } } : {})
        }
      }
    })
  ))
}

async function sendMetaMessengerAttachmentRequest({ businessId, recipientId, attachmentType, attachmentUrl, config, replyToProviderMessageId = '' }) {
  const sendPayload = {
    messaging_type: 'RESPONSE',
    recipient: { id: recipientId },
    message: {
      attachment: {
        type: attachmentType,
        payload: {
          url: attachmentUrl,
          is_reusable: false
        }
      },
      ...(replyToProviderMessageId ? { reply_to: { mid: replyToProviderMessageId } } : {})
    }
  }

  try {
    return await metaSocialGraphRequest(`/${encodeURIComponent(businessId)}/messages`, {
      method: 'POST',
      token: await resolveMetaPageAccessToken({ config, platform: 'messenger' }),
      body: sendPayload
    })
  } catch (error) {
    if (!shouldRefreshMetaPageToken(error)) throw error
    return await metaSocialGraphRequest(`/${encodeURIComponent(businessId)}/messages`, {
      method: 'POST',
      token: await resolveMetaPageAccessToken({ config, forceRefresh: true, platform: 'messenger' }),
      body: sendPayload
    })
  }
}

async function sendMetaInstagramAttachmentRequest({ businessId, recipientId, attachmentType, attachmentUrl, config, replyToProviderMessageId = '' }) {
  return withRefreshedMetaInstagramCredentials(config, graphCredentials => (
    metaSocialGraphRequest(getMetaInstagramMessagesPath({ businessId, config, credentials: graphCredentials }), {
      method: 'POST',
      token: graphCredentials.token,
      baseUrl: graphCredentials.baseUrl,
      body: {
        recipient: { id: recipientId },
        message: {
          attachment: {
            type: attachmentType,
            payload: {
              url: attachmentUrl
            }
          },
          ...(replyToProviderMessageId ? { reply_to: { mid: replyToProviderMessageId } } : {})
        }
      }
    })
  ))
}

async function sendMetaInstagramReactionRequest({ businessId, recipientId, reaction, targetProviderMessageId, config }) {
  return withRefreshedMetaInstagramCredentials(config, graphCredentials => (
    metaSocialGraphRequest(getMetaInstagramMessagesPath({ businessId, config, credentials: graphCredentials }), {
      method: 'POST',
      token: graphCredentials.token,
      baseUrl: graphCredentials.baseUrl,
      body: {
        recipient: { id: recipientId },
        sender_action: 'react',
        payload: {
          message_id: targetProviderMessageId,
          reaction
        }
      }
    })
  ))
}

async function sendMetaInstagramMarkSeenRequest({ recipientId, config }) {
  return withRefreshedMetaInstagramCredentials(config, graphCredentials => (
    metaSocialGraphRequest(getMetaInstagramMessagesPath({ config, credentials: graphCredentials }), {
      method: 'POST',
      token: graphCredentials.token,
      baseUrl: graphCredentials.baseUrl,
      body: {
        recipient: { id: recipientId },
        sender_action: 'mark_seen'
      }
    })
  ))
}

async function sendMetaMessengerReactionRequest({ businessId, recipientId, reaction, targetProviderMessageId, config }) {
  const sendPayload = {
    recipient: { id: recipientId },
    sender_action: 'react',
    payload: {
      message_id: targetProviderMessageId,
      reaction
    }
  }

  try {
    return await metaSocialGraphRequest(`/${encodeURIComponent(businessId)}/messages`, {
      method: 'POST',
      token: await resolveMetaPageAccessToken({ config, platform: 'messenger' }),
      body: sendPayload
    })
  } catch (error) {
    if (!shouldRefreshMetaPageToken(error)) throw error
    return await metaSocialGraphRequest(`/${encodeURIComponent(businessId)}/messages`, {
      method: 'POST',
      token: await resolveMetaPageAccessToken({ config, forceRefresh: true, platform: 'messenger' }),
      body: sendPayload
    })
  }
}

async function sendMetaMessengerMarkSeenRequest({ businessId, recipientId, config }) {
  const sendPayload = {
    recipient: { id: recipientId },
    sender_action: 'mark_seen'
  }

  try {
    return await metaSocialGraphRequest(`/${encodeURIComponent(businessId)}/messages`, {
      method: 'POST',
      token: await resolveMetaPageAccessToken({ config, platform: 'messenger' }),
      body: sendPayload
    })
  } catch (error) {
    if (!shouldRefreshMetaPageToken(error)) throw error
    return await metaSocialGraphRequest(`/${encodeURIComponent(businessId)}/messages`, {
      method: 'POST',
      token: await resolveMetaPageAccessToken({ config, forceRefresh: true, platform: 'messenger' }),
      body: sendPayload
    })
  }
}

async function saveMetaSocialOutboundMessage({ platform, contactId, profile, messageId, text, response, externalId, agentId, messageType = 'text', messageTimestamp = '', commentId = '', postId = '', parentCommentId = '', mediaUrl = '', mediaMimeType = '', context = null, reservationId = '' }) {
  const now = cleanString(messageTimestamp) || new Date().toISOString()
  const cleanPlatform = platform === 'instagram' ? 'instagram' : 'messenger'
  const cleanMessageType = cleanString(messageType) || 'text'
  const remoteMessageId = cleanString(
    messageId ||
    response?.message_id ||
    response?.id ||
    externalId
  )
  const localMessageId = cleanString(reservationId) || hashId(
    'meta_social_msg',
    remoteMessageId
      ? `${cleanPlatform}:${remoteMessageId}:outbound`
      : `${cleanPlatform}:${contactId}:${text}:${now}`
  )
  const rawPayload = safeJson({
    provider: 'meta',
    platform: cleanPlatform,
    ...(externalId ? { externalId: cleanString(externalId) } : {}),
    ...buildConversationalAgentMessageMetadata(agentId),
    response,
    ...(context ? { context } : {})
  })
  const existing = await db.get('SELECT id, status FROM meta_social_messages WHERE id = ?', [localMessageId]).catch(() => null)

  const persist = async (database) => {
    // Si el webhook echo ganó la carrera contra la respuesta HTTP de Graph,
    // fusionamos esa fila temporal en la reserva idempotente antes de publicar.
    if (remoteMessageId) {
      const duplicateRows = await database.all(`
        SELECT id
        FROM meta_social_messages
        WHERE platform = ?
          AND meta_message_id = ?
          AND direction = 'outbound'
          AND id != ?
      `, [cleanPlatform, remoteMessageId, localMessageId])
      for (const duplicate of duplicateRows) {
        await database.run('DELETE FROM meta_social_messages WHERE id = ?', [duplicate.id])
      }
    }

    await database.run(`
    INSERT INTO meta_social_messages (
      id, platform, meta_message_id, meta_social_contact_id, contact_id,
      sender_id, recipient_id, page_id, instagram_account_id,
      direction, status, message_type, message_text,
      media_url, media_mime_type,
      postback_payload, message_timestamp, raw_payload_json, referral_json,
      comment_id, post_id, parent_comment_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      meta_message_id = COALESCE(NULLIF(excluded.meta_message_id, ''), meta_social_messages.meta_message_id),
      meta_social_contact_id = COALESCE(excluded.meta_social_contact_id, meta_social_messages.meta_social_contact_id),
      contact_id = COALESCE(meta_social_messages.contact_id, excluded.contact_id),
      sender_id = COALESCE(NULLIF(excluded.sender_id, ''), meta_social_messages.sender_id),
      recipient_id = COALESCE(NULLIF(excluded.recipient_id, ''), meta_social_messages.recipient_id),
      page_id = COALESCE(NULLIF(excluded.page_id, ''), meta_social_messages.page_id),
      instagram_account_id = COALESCE(NULLIF(excluded.instagram_account_id, ''), meta_social_messages.instagram_account_id),
      direction = COALESCE(NULLIF(excluded.direction, ''), meta_social_messages.direction),
      status = COALESCE(NULLIF(excluded.status, ''), meta_social_messages.status),
      message_type = COALESCE(NULLIF(excluded.message_type, ''), meta_social_messages.message_type),
      message_text = COALESCE(NULLIF(excluded.message_text, ''), meta_social_messages.message_text),
      media_url = COALESCE(NULLIF(excluded.media_url, ''), meta_social_messages.media_url),
      media_mime_type = COALESCE(NULLIF(excluded.media_mime_type, ''), meta_social_messages.media_mime_type),
      message_timestamp = COALESCE(excluded.message_timestamp, meta_social_messages.message_timestamp),
      raw_payload_json = excluded.raw_payload_json,
      comment_id = COALESCE(NULLIF(excluded.comment_id, ''), meta_social_messages.comment_id),
      post_id = COALESCE(NULLIF(excluded.post_id, ''), meta_social_messages.post_id),
      parent_comment_id = COALESCE(NULLIF(excluded.parent_comment_id, ''), meta_social_messages.parent_comment_id),
      updated_at = CURRENT_TIMESTAMP
  `, [
    localMessageId,
    cleanPlatform,
    remoteMessageId || null,
    profile.id || null,
    contactId,
    getMetaSocialBusinessId(cleanPlatform, {}, profile) || null,
    cleanString(profile.sender_id) || null,
    cleanPlatform === 'messenger' ? cleanString(profile.page_id) || null : null,
    cleanPlatform === 'instagram' ? cleanString(profile.instagram_account_id) || null : null,
    'outbound',
    'sent',
    cleanMessageType,
    text,
    cleanString(mediaUrl) || null,
    cleanString(mediaMimeType) || null,
    null,
    now,
    rawPayload,
    null,
    cleanString(commentId) || null,
    cleanString(postId) || null,
    cleanString(parentCommentId) || null
    ])
  }

  await db.transaction(persist)

  publishChatMessageEvent({
    contactId,
    messageId: localMessageId,
    channel: cleanPlatform,
    provider: 'meta',
    transport: cleanPlatform,
    direction: 'outbound',
    messageType: cleanMessageType,
    messageTimestamp: now,
    isNew: !existing || ['pending', 'sending', 'accepted'].includes(cleanString(existing.status))
  })

  return {
    localMessageId,
    status: 'sent',
    transport: cleanPlatform,
    channel: cleanPlatform,
    remoteMessageId: remoteMessageId || null,
    isNew: !existing || ['pending', 'sending', 'accepted'].includes(cleanString(existing.status))
  }
}

const META_SOCIAL_DISPATCH_WAIT_MS = 10_000
const META_SOCIAL_PENDING_STALE_MS = 5 * 60 * 1000

function parseMetaSocialDatabaseTimestampMs(value) {
  if (value instanceof Date) return value.getTime()
  const raw = cleanString(value)
  if (!raw) return 0
  // SQLite CURRENT_TIMESTAMP no incluye offset, pero siempre está en UTC.
  // Sin la Z, JavaScript lo interpretaría como hora local y podría declarar
  // stale una reserva recién creada en instalaciones fuera de UTC.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : 0
}

function getMetaSocialDispatchId({ contactId, platform, externalId } = {}) {
  const cleanExternalId = cleanString(externalId)
  if (!cleanExternalId) return ''
  return hashId('meta_social_dispatch', `${platform}:${contactId}:${cleanExternalId}`)
}

async function readMetaSocialOutboundDispatch(id) {
  if (!id) return null
  return db.get(`
    SELECT id, platform, meta_message_id, status, message_type, message_text,
           media_url, media_mime_type, raw_payload_json, updated_at, message_timestamp
    FROM meta_social_messages
    WHERE id = ? AND direction = 'outbound'
    LIMIT 1
  `, [id])
}

async function waitForMetaSocialOutboundDispatch(row) {
  let current = row
  const deadline = Date.now() + META_SOCIAL_DISPATCH_WAIT_MS
  while (current && ['pending', 'sending'].includes(cleanString(current.status)) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
    current = await readMetaSocialOutboundDispatch(current.id)
  }
  return current
}

async function reconcileAcceptedMetaSocialDispatch(row) {
  if (!row?.id || !cleanString(row.meta_message_id)) return row
  await db.transaction(async (database) => {
    const duplicates = await database.all(`
      SELECT id
      FROM meta_social_messages
      WHERE platform = ? AND meta_message_id = ? AND direction = 'outbound' AND id != ?
    `, [row.platform, row.meta_message_id, row.id])
    for (const duplicate of duplicates) {
      await database.run('DELETE FROM meta_social_messages WHERE id = ?', [duplicate.id])
    }
    await database.run(`
      UPDATE meta_social_messages
      SET status = 'sent', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'accepted'
    `, [row.id])
  })
  return readMetaSocialOutboundDispatch(row.id)
}

async function findMetaSocialOutboundByExternalId({ contactId, platform, externalId } = {}) {
  const cleanExternalId = cleanString(externalId)
  if (!cleanExternalId) return null

  const dispatchId = getMetaSocialDispatchId({ contactId, platform, externalId: cleanExternalId })
  let exact = await readMetaSocialOutboundDispatch(dispatchId)
  if (exact && ['pending', 'sending'].includes(cleanString(exact.status))) {
    const updatedAt = parseMetaSocialDatabaseTimestampMs(exact.updated_at || exact.message_timestamp)
    if (updatedAt && Date.now() - updatedAt > META_SOCIAL_PENDING_STALE_MS) {
      if (cleanString(exact.status) === 'pending') {
        await db.run("DELETE FROM meta_social_messages WHERE id = ? AND status = 'pending'", [dispatchId])
        exact = null
      } else {
        await db.run("UPDATE meta_social_messages SET status = 'send_unknown', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'sending'", [dispatchId])
        exact = await readMetaSocialOutboundDispatch(dispatchId)
      }
    }
  }
  if (exact) {
    exact = await waitForMetaSocialOutboundDispatch(exact)
    if (cleanString(exact?.status) === 'accepted') {
      exact = await reconcileAcceptedMetaSocialDispatch(exact)
    }
    return exact
  }

  // Compatibilidad con mensajes creados antes de la reserva determinística.
  const legacyCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const externalIdNeedle = `%"externalId":${JSON.stringify(cleanExternalId)}%`
  const rows = await db.all(`
    SELECT id, meta_message_id, status, message_type, message_text,
           media_url, media_mime_type, raw_payload_json
    FROM meta_social_messages
    WHERE contact_id = ?
      AND platform = ?
      AND direction = 'outbound'
      AND COALESCE(updated_at, message_timestamp) >= ?
      AND raw_payload_json LIKE ?
    ORDER BY updated_at DESC, message_timestamp DESC
    LIMIT 50
  `, [contactId, platform, legacyCutoff, externalIdNeedle])

  return rows.find(row => cleanString(parseJsonObject(row.raw_payload_json)?.externalId) === cleanExternalId) || null
}

async function claimMetaSocialOutboundDispatch({ contactId, platform, externalId, profile, messageType = 'text', text = '', mediaUrl = '', mediaMimeType = '', context = null } = {}) {
  const cleanExternalId = cleanString(externalId)
  if (!cleanExternalId) return { claimed: true, reservationId: '' }
  const reservationId = getMetaSocialDispatchId({ contactId, platform, externalId: cleanExternalId })
  const now = new Date().toISOString()
  const rawPayload = safeJson({
    provider: 'meta',
    platform,
    externalId: cleanExternalId,
    dispatchState: 'pending',
    ...(context ? { context } : {})
  })
  const result = await db.run(`
    INSERT INTO meta_social_messages (
      id, platform, meta_social_contact_id, contact_id,
      sender_id, recipient_id, page_id, instagram_account_id,
      direction, status, message_type, message_text,
      media_url, media_mime_type, message_timestamp, raw_payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'outbound', 'pending', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO NOTHING
  `, [
    reservationId,
    platform,
    profile?.id || null,
    contactId,
    getMetaSocialBusinessId(platform, {}, profile || {}) || null,
    cleanString(profile?.sender_id) || null,
    platform === 'messenger' ? cleanString(profile?.page_id) || null : null,
    platform === 'instagram' ? cleanString(profile?.instagram_account_id) || null : null,
    cleanString(messageType) || 'text',
    text,
    cleanString(mediaUrl) || null,
    cleanString(mediaMimeType) || null,
    now,
    rawPayload
  ])
  if (Number(result?.changes || result?.rowCount || 0) > 0) {
    return { claimed: true, reservationId }
  }

  const existing = await findMetaSocialOutboundByExternalId({ contactId, platform, externalId: cleanExternalId })
  if (!existing) return claimMetaSocialOutboundDispatch({ contactId, platform, externalId, profile, messageType, text, mediaUrl, mediaMimeType, context })
  return { claimed: false, reservationId, existing }
}

async function markMetaSocialOutboundDispatchSending(reservationId) {
  if (!reservationId) return
  const result = await db.run(`
    UPDATE meta_social_messages
    SET status = 'sending', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'pending'
  `, [reservationId])
  if (Number(result?.changes || result?.rowCount || 0) < 1) {
    throw createMetaSocialMessageError('Este mensaje ya está siendo procesado.', 409, {
      code: 'meta_send_in_progress'
    })
  }
}

async function markMetaSocialOutboundDispatchAccepted({ reservationId, remoteMessageId, response, externalId, context, mediaUrl = '', mediaMimeType = '' } = {}) {
  if (!reservationId) return
  await db.run(`
    UPDATE meta_social_messages
    SET meta_message_id = ?, status = 'accepted',
        media_url = COALESCE(NULLIF(?, ''), media_url),
        media_mime_type = COALESCE(NULLIF(?, ''), media_mime_type),
        raw_payload_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    cleanString(remoteMessageId) || null,
    cleanString(mediaUrl),
    cleanString(mediaMimeType),
    safeJson({
      provider: 'meta',
      externalId: cleanString(externalId),
      dispatchState: 'accepted',
      response,
      ...(context ? { context } : {})
    }),
    reservationId
  ])
}

async function handleMetaSocialOutboundDispatchFailure(reservationId, error) {
  if (!reservationId) return
  const statusCode = Number(error?.statusCode || error?.status || 0)
  if (statusCode >= 400 && statusCode < 500 && statusCode !== 408) {
    await db.run("DELETE FROM meta_social_messages WHERE id = ? AND status = 'sending'", [reservationId])
    return
  }
  await db.run(`
    UPDATE meta_social_messages
    SET status = 'send_unknown', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'sending'
  `, [reservationId])
}

function buildReusedMetaSocialSendResult(row, platform) {
  const storedStatus = cleanString(row.status)
  if (['pending', 'sending'].includes(storedStatus)) {
    throw createMetaSocialMessageError('Este mensaje todavía se está procesando; Ristak no lo duplicará.', 409, {
      code: 'meta_send_in_progress'
    })
  }
  if (storedStatus === 'send_unknown') {
    throw createMetaSocialMessageError('Meta no confirmó si recibió este intento. Ristak lo bloqueó para evitar un mensaje duplicado.', 409, {
      code: 'meta_send_delivery_unknown'
    })
  }
  const sent = {
    localMessageId: cleanString(row.id),
    status: storedStatus === 'accepted' ? 'sent' : storedStatus || 'sent',
    transport: platform,
    channel: platform,
    remoteMessageId: cleanString(row.meta_message_id) || null,
    isNew: false,
    deduplicated: true
  }
  return {
    ...sent,
    id: sent.remoteMessageId || sent.localMessageId,
    platform,
    provider: 'meta',
    data: sent
  }
}

export async function sendMetaSocialTextMessage({ contactId, platform, message, externalId, agentId, replyToMessageId = '', replyToProviderMessageId = '' } = {}) {
  const cleanContactId = cleanString(contactId)
  const cleanPlatform = cleanString(platform).toLowerCase() === 'instagram' ? 'instagram' : 'messenger'
  const body = cleanString(message)

  if (!cleanContactId) throw createMetaSocialMessageError('Falta el contacto', 400)
  if (!body) throw createMetaSocialMessageError('Falta el texto del mensaje', 400)

  const existingSend = await findMetaSocialOutboundByExternalId({
    contactId: cleanContactId,
    platform: cleanPlatform,
    externalId
  })
  if (existingSend) return buildReusedMetaSocialSendResult(existingSend, cleanPlatform)

  const enabled = await isMetaSocialMessagingEnabled(cleanPlatform)
  if (!enabled) {
    throw createMetaSocialMessageError(`Activa ${getPlatformLabel(cleanPlatform)} en Configuración > Meta Ads > Redes sociales para responder por este canal.`, 409)
  }

  const config = await getMetaSocialConfig().catch(error => {
    logger.warn(`No se pudo leer Meta para enviar DM: ${error.message}`)
    return null
  })
  const hasRequiredToken = hasMetaSocialGraphTokenSource(cleanPlatform, config || {})
  if (!hasRequiredToken) {
    throw createMetaSocialMessageError(
      cleanPlatform === 'instagram'
        ? 'Conecta Meta Ads con un token que pueda operar la Página enlazada a Instagram.'
        : 'Conecta Meta Ads para responder por Messenger.',
      409
    )
  }

  const profile = await db.get(
    `SELECT id, sender_id, recipient_id, page_id, instagram_account_id
     FROM meta_social_contacts
     WHERE contact_id = ? AND platform = ?
     ORDER BY updated_at DESC, last_seen_at DESC
     LIMIT 1`,
    [cleanContactId, cleanPlatform]
  ).catch(() => null)

  const recipientId = cleanString(profile?.sender_id)
  if (!profile || !recipientId) {
    throw createMetaSocialMessageError(`Este contacto no tiene ${getPlatformLabel(cleanPlatform)} enlazado.`, 404)
  }

  const businessId = getMetaSocialBusinessId(cleanPlatform, config, profile)
  if (!businessId) {
    throw createMetaSocialMessageError(
      cleanPlatform === 'instagram'
        ? 'Falta seleccionar la cuenta de Instagram en Meta Ads.'
        : 'Falta seleccionar la página de Facebook en Meta Ads.',
      409
    )
  }

  const replyReference = await resolveMetaSocialMessageReference({
    contactId: cleanContactId,
    platform: cleanPlatform,
    messageId: replyToMessageId,
    providerMessageId: replyToProviderMessageId
  })
  const replyProviderMessageId = cleanString(replyReference?.providerMessageId)

  const textContext = replyProviderMessageId ? { reply_to: { mid: replyProviderMessageId } } : null
  const dispatch = await claimMetaSocialOutboundDispatch({
    contactId: cleanContactId,
    platform: cleanPlatform,
    externalId,
    profile,
    messageType: 'text',
    text: body,
    context: textContext
  })
  if (!dispatch.claimed) return buildReusedMetaSocialSendResult(dispatch.existing, cleanPlatform)
  await markMetaSocialOutboundDispatchSending(dispatch.reservationId)

  let response
  try {
    response = cleanPlatform === 'instagram'
      ? await sendMetaInstagramTextRequest({ businessId, recipientId, body, config, replyToProviderMessageId: replyProviderMessageId })
      : await sendMetaMessengerTextRequest({ businessId, recipientId, body, config, replyToProviderMessageId: replyProviderMessageId })
  } catch (error) {
    await handleMetaSocialOutboundDispatchFailure(dispatch.reservationId, error).catch(() => undefined)
    throw normalizeMetaSocialSendError(error, cleanPlatform)
  }

  await markMetaSocialOutboundDispatchAccepted({
    reservationId: dispatch.reservationId,
    remoteMessageId: response?.message_id || response?.id,
    response,
    externalId,
    context: textContext
  })

  const sent = await saveMetaSocialOutboundMessage({
    platform: cleanPlatform,
    contactId: cleanContactId,
    profile,
    messageId: response?.message_id || response?.id,
    text: body,
    response,
    externalId,
    agentId,
    context: textContext,
    reservationId: dispatch.reservationId
  })

  return {
    ...sent,
    id: sent.remoteMessageId || sent.localMessageId,
    platform: cleanPlatform,
    provider: 'meta',
    data: sent
  }
}

export async function sendMetaSocialAudioMessage({
  contactId,
  platform,
  audioDataUrl = '',
  audioUrl = '',
  audioMimeType = '',
  filename = '',
  durationMs = null,
  voice = true,
  externalId,
  replyToMessageId = '',
  replyToProviderMessageId = '',
  publicBaseUrl = ''
} = {}) {
  const cleanContactId = cleanString(contactId)
  const cleanPlatform = cleanString(platform).toLowerCase() === 'instagram' ? 'instagram' : 'messenger'
  const cleanAudioUrl = cleanString(audioUrl)
  const cleanAudioDataUrl = cleanString(audioDataUrl)
  const isVoiceNote = voice !== false
  const parsedDurationMs = Number(durationMs)
  const audioDurationMs = Number.isFinite(parsedDurationMs) && parsedDurationMs > 0
    ? Math.round(parsedDurationMs)
    : null

  if (!cleanContactId) throw createMetaSocialMessageError('Falta el contacto', 400)
  if (!cleanAudioUrl && !cleanAudioDataUrl) throw createMetaSocialMessageError('Falta el audio para enviar', 400)

  const existingSend = await findMetaSocialOutboundByExternalId({
    contactId: cleanContactId,
    platform: cleanPlatform,
    externalId
  })
  if (existingSend) {
    const reused = buildReusedMetaSocialSendResult(existingSend, cleanPlatform)
    const rawPayload = parseJsonObject(existingSend.raw_payload_json)
    const existingAudio = rawPayload?.context?.audio || {}
    return {
      ...reused,
      audio: {
        link: cleanString(existingAudio.link || existingSend.media_url),
        url: cleanString(existingAudio.url || existingSend.media_url),
        mimeType: cleanString(existingAudio.mimeType || existingSend.media_mime_type || 'audio/mp4'),
        voice: existingAudio.voice !== false,
        ...(Number(existingAudio.durationMs) > 0 ? { durationMs: Number(existingAudio.durationMs) } : {})
      }
    }
  }

  const enabled = await isMetaSocialMessagingEnabled(cleanPlatform)
  if (!enabled) {
    throw createMetaSocialMessageError(`Activa ${getPlatformLabel(cleanPlatform)} en Configuración > Meta Ads > Redes sociales para responder por este canal.`, 409)
  }

  const config = await getMetaSocialConfig().catch(error => {
    logger.warn(`No se pudo leer Meta para enviar audio DM: ${error.message}`)
    return null
  })
  const hasRequiredToken = hasMetaSocialGraphTokenSource(cleanPlatform, config || {})
  if (!hasRequiredToken) {
    throw createMetaSocialMessageError(
      cleanPlatform === 'instagram'
        ? 'Conecta Meta Ads con un token que pueda operar la Página enlazada a Instagram.'
        : 'Conecta Meta Ads para responder por Messenger.',
      409
    )
  }

  const profile = await db.get(
    `SELECT id, sender_id, recipient_id, page_id, instagram_account_id
     FROM meta_social_contacts
     WHERE contact_id = ? AND platform = ?
     ORDER BY updated_at DESC, last_seen_at DESC
     LIMIT 1`,
    [cleanContactId, cleanPlatform]
  ).catch(() => null)

  const recipientId = cleanString(profile?.sender_id)
  if (!profile || !recipientId) {
    throw createMetaSocialMessageError(`Este contacto no tiene ${getPlatformLabel(cleanPlatform)} enlazado.`, 404)
  }

  const businessId = getMetaSocialBusinessId(cleanPlatform, config, profile)
  if (!businessId) {
    throw createMetaSocialMessageError(
      cleanPlatform === 'instagram'
        ? 'Falta seleccionar la cuenta de Instagram en Meta Ads.'
        : 'Falta seleccionar la página de Facebook en Meta Ads.',
      409
    )
  }

  const replyReference = await resolveMetaSocialMessageReference({
    contactId: cleanContactId,
    platform: cleanPlatform,
    messageId: replyToMessageId,
    providerMessageId: replyToProviderMessageId
  })
  const replyProviderMessageId = cleanString(replyReference?.providerMessageId)

  const preparedMedia = await prepareMetaSocialOutboundMedia({
    platform: cleanPlatform,
    attachmentType: 'audio',
    attachmentDataUrl: cleanAudioDataUrl,
    attachmentUrl: cleanAudioUrl,
    mimeType: audioMimeType,
    filename,
    publicBaseUrl
  })
  const attachmentUrl = preparedMedia.publicUrl
  const mediaMimeType = preparedMedia.mimeType
  const localMedia = {
    publicUrl: preparedMedia.publicUrl,
    publicPath: preparedMedia.publicPath,
    mimeType: preparedMedia.mimeType,
    filename: preparedMedia.filename,
    size: preparedMedia.size,
    mediaAssetId: preparedMedia.mediaAssetId,
    kind: 'audio',
    originalMimeType: preparedMedia.originalMimeType
  }
  const audioContext = {
    audio: {
      link: attachmentUrl,
      url: attachmentUrl,
      mimeType: mediaMimeType,
      voice: isVoiceNote,
      ...(audioDurationMs ? { durationMs: audioDurationMs } : {})
    },
    ...(replyProviderMessageId ? { reply_to: { mid: replyProviderMessageId } } : {})
  }
  const dispatch = await claimMetaSocialOutboundDispatch({
    contactId: cleanContactId,
    platform: cleanPlatform,
    externalId,
    profile,
    messageType: 'audio',
    mediaUrl: attachmentUrl,
    mediaMimeType,
    context: audioContext
  })
  if (!dispatch.claimed) {
    const reused = buildReusedMetaSocialSendResult(dispatch.existing, cleanPlatform)
    const rawPayload = parseJsonObject(dispatch.existing.raw_payload_json)
    return {
      ...reused,
      audio: rawPayload?.context?.audio || audioContext.audio,
      localMedia
    }
  }
  await markMetaSocialOutboundDispatchSending(dispatch.reservationId)

  let response
  try {
    response = cleanPlatform === 'instagram'
      ? await sendMetaInstagramAttachmentRequest({ businessId, recipientId, attachmentType: 'audio', attachmentUrl, config, replyToProviderMessageId: replyProviderMessageId })
      : await sendMetaMessengerAttachmentRequest({ businessId, recipientId, attachmentType: 'audio', attachmentUrl, config, replyToProviderMessageId: replyProviderMessageId })
  } catch (error) {
    await handleMetaSocialOutboundDispatchFailure(dispatch.reservationId, error).catch(() => undefined)
    throw normalizeMetaSocialSendError(error, cleanPlatform)
  }

  await markMetaSocialOutboundDispatchAccepted({
    reservationId: dispatch.reservationId,
    remoteMessageId: response?.message_id || response?.id,
    response,
    externalId,
    context: audioContext,
    mediaUrl: attachmentUrl,
    mediaMimeType
  })

  const sent = await saveMetaSocialOutboundMessage({
    platform: cleanPlatform,
    contactId: cleanContactId,
    profile,
    messageId: response?.message_id || response?.id,
    text: '',
    response,
    externalId,
    messageType: 'audio',
    mediaUrl: attachmentUrl,
    mediaMimeType,
    context: audioContext,
    reservationId: dispatch.reservationId
  })

  return {
    ...sent,
    id: sent.remoteMessageId || sent.localMessageId,
    platform: cleanPlatform,
    provider: 'meta',
    audio: {
      link: attachmentUrl,
      url: attachmentUrl,
      mimeType: mediaMimeType,
      voice: isVoiceNote,
      ...(audioDurationMs ? { durationMs: audioDurationMs } : {})
    },
    localMedia,
    data: sent
  }
}

/**
 * Envía un adjunto normalizado por la frontera compartida de chat y
 * Automatizaciones. Meta no acepta un caption dentro del payload del adjunto:
 * el caller puede mandar texto como un mensaje separado si lo necesita.
 */
export async function sendMetaSocialAttachmentMessage({
  contactId,
  platform,
  attachmentType,
  attachmentDataUrl = '',
  attachmentUrl = '',
  mimeType = '',
  filename = '',
  externalId,
  agentId,
  replyToMessageId = '',
  replyToProviderMessageId = '',
  publicBaseUrl = ''
} = {}) {
  const cleanContactId = cleanString(contactId)
  const cleanPlatform = cleanString(platform).toLowerCase() === 'instagram' ? 'instagram' : 'messenger'
  const requestedAttachmentType = cleanString(attachmentType).toLowerCase()
  const cleanAttachmentType = requestedAttachmentType === 'document' ? 'file' : requestedAttachmentType
  const cleanAttachmentDataUrl = cleanString(attachmentDataUrl)
  const cleanAttachmentUrl = cleanString(attachmentUrl)

  if (!cleanContactId) throw createMetaSocialMessageError('Falta el contacto', 400)
  if (!META_SOCIAL_ATTACHMENT_TYPES.has(cleanAttachmentType)) {
    throw createMetaSocialMessageError('Meta sólo permite imagen, video, audio o archivo como adjunto.', 400)
  }
  if (!cleanAttachmentDataUrl && !cleanAttachmentUrl) {
    throw createMetaSocialMessageError('Falta el archivo para enviar', 400)
  }

  const existingSend = await findMetaSocialOutboundByExternalId({
    contactId: cleanContactId,
    platform: cleanPlatform,
    externalId
  })
  if (existingSend) {
    const reused = buildReusedMetaSocialSendResult(existingSend, cleanPlatform)
    const rawPayload = parseJsonObject(existingSend.raw_payload_json)
    const existingAttachment = rawPayload?.context?.attachment || {}
    return {
      ...reused,
      attachment: {
        type: cleanString(existingAttachment.type || existingSend.message_type || cleanAttachmentType),
        link: cleanString(existingAttachment.link || existingSend.media_url),
        url: cleanString(existingAttachment.url || existingSend.media_url),
        mimeType: cleanString(existingAttachment.mimeType || existingSend.media_mime_type),
        ...(cleanString(existingAttachment.filename) ? { filename: cleanString(existingAttachment.filename) } : {})
      }
    }
  }

  const enabled = await isMetaSocialMessagingEnabled(cleanPlatform)
  if (!enabled) {
    throw createMetaSocialMessageError(`Activa ${getPlatformLabel(cleanPlatform)} en Configuración > Meta Ads > Redes sociales para responder por este canal.`, 409)
  }

  const config = await getMetaSocialConfig().catch(error => {
    logger.warn(`No se pudo leer Meta para enviar adjunto DM: ${error.message}`)
    return null
  })
  const hasRequiredToken = hasMetaSocialGraphTokenSource(cleanPlatform, config || {})
  if (!hasRequiredToken) {
    throw createMetaSocialMessageError(
      cleanPlatform === 'instagram'
        ? 'Conecta Meta Ads con un token que pueda operar la Página enlazada a Instagram.'
        : 'Conecta Meta Ads para responder por Messenger.',
      409
    )
  }

  const profile = await db.get(
    `SELECT id, sender_id, recipient_id, page_id, instagram_account_id
     FROM meta_social_contacts
     WHERE contact_id = ? AND platform = ?
     ORDER BY updated_at DESC, last_seen_at DESC
     LIMIT 1`,
    [cleanContactId, cleanPlatform]
  ).catch(() => null)

  const recipientId = cleanString(profile?.sender_id)
  if (!profile || !recipientId) {
    throw createMetaSocialMessageError(`Este contacto no tiene ${getPlatformLabel(cleanPlatform)} enlazado.`, 404)
  }

  const businessId = getMetaSocialBusinessId(cleanPlatform, config, profile)
  if (!businessId) {
    throw createMetaSocialMessageError(
      cleanPlatform === 'instagram'
        ? 'Falta seleccionar la cuenta de Instagram en Meta Ads.'
        : 'Falta seleccionar la página de Facebook en Meta Ads.',
      409
    )
  }

  const replyReference = await resolveMetaSocialMessageReference({
    contactId: cleanContactId,
    platform: cleanPlatform,
    messageId: replyToMessageId,
    providerMessageId: replyToProviderMessageId
  })
  const replyProviderMessageId = cleanString(replyReference?.providerMessageId)

  const preparedMedia = await prepareMetaSocialOutboundMedia({
    platform: cleanPlatform,
    attachmentType: cleanAttachmentType,
    attachmentDataUrl: cleanAttachmentDataUrl,
    attachmentUrl: cleanAttachmentUrl,
    mimeType,
    filename,
    publicBaseUrl
  })
  const preparedAttachmentUrl = preparedMedia.publicUrl
  const preparedMimeType = preparedMedia.mimeType
  const attachmentContext = {
    attachment: {
      type: cleanAttachmentType,
      link: preparedAttachmentUrl,
      url: preparedAttachmentUrl,
      mimeType: preparedMimeType,
      filename: preparedMedia.filename
    },
    ...(replyProviderMessageId ? { reply_to: { mid: replyProviderMessageId } } : {})
  }
  const dispatch = await claimMetaSocialOutboundDispatch({
    contactId: cleanContactId,
    platform: cleanPlatform,
    externalId,
    profile,
    messageType: cleanAttachmentType,
    mediaUrl: preparedAttachmentUrl,
    mediaMimeType: preparedMimeType,
    context: attachmentContext
  })
  if (!dispatch.claimed) {
    const reused = buildReusedMetaSocialSendResult(dispatch.existing, cleanPlatform)
    const rawPayload = parseJsonObject(dispatch.existing.raw_payload_json)
    return {
      ...reused,
      attachment: rawPayload?.context?.attachment || attachmentContext.attachment
    }
  }
  await markMetaSocialOutboundDispatchSending(dispatch.reservationId)

  let response
  try {
    response = cleanPlatform === 'instagram'
      ? await sendMetaInstagramAttachmentRequest({ businessId, recipientId, attachmentType: cleanAttachmentType, attachmentUrl: preparedAttachmentUrl, config, replyToProviderMessageId: replyProviderMessageId })
      : await sendMetaMessengerAttachmentRequest({ businessId, recipientId, attachmentType: cleanAttachmentType, attachmentUrl: preparedAttachmentUrl, config, replyToProviderMessageId: replyProviderMessageId })
  } catch (error) {
    await handleMetaSocialOutboundDispatchFailure(dispatch.reservationId, error).catch(() => undefined)
    throw normalizeMetaSocialSendError(error, cleanPlatform)
  }

  await markMetaSocialOutboundDispatchAccepted({
    reservationId: dispatch.reservationId,
    remoteMessageId: response?.message_id || response?.id,
    response,
    externalId,
    context: attachmentContext,
    mediaUrl: preparedAttachmentUrl,
    mediaMimeType: preparedMimeType
  })

  const sent = await saveMetaSocialOutboundMessage({
    platform: cleanPlatform,
    contactId: cleanContactId,
    profile,
    messageId: response?.message_id || response?.id,
    text: '',
    response,
    externalId,
    agentId,
    messageType: cleanAttachmentType,
    mediaUrl: preparedAttachmentUrl,
    mediaMimeType: preparedMimeType,
    context: attachmentContext,
    reservationId: dispatch.reservationId
  })

  return {
    ...sent,
    id: sent.remoteMessageId || sent.localMessageId,
    platform: cleanPlatform,
    provider: 'meta',
    attachment: {
      type: cleanAttachmentType,
      link: preparedAttachmentUrl,
      url: preparedAttachmentUrl,
      mimeType: preparedMimeType,
      filename: preparedMedia.filename
    },
    localMedia: {
      publicUrl: preparedAttachmentUrl,
      publicPath: preparedMedia.publicPath,
      mimeType: preparedMimeType,
      filename: preparedMedia.filename,
      size: preparedMedia.size,
      mediaAssetId: preparedMedia.mediaAssetId,
      kind: cleanAttachmentType,
      originalMimeType: preparedMedia.originalMimeType
    },
    data: sent
  }
}

export async function sendMetaSocialReactionMessage({ contactId, platform, emoji, targetMessageId = '', targetProviderMessageId = '', externalId } = {}) {
  const cleanContactId = cleanString(contactId)
  const cleanPlatform = cleanString(platform).toLowerCase() === 'instagram' ? 'instagram' : 'messenger'
  const reaction = normalizeMetaReactionValue(emoji)

  if (!cleanContactId) throw createMetaSocialMessageError('Falta el contacto', 400)
  if (!reaction) throw createMetaSocialMessageError('Meta solo permite reaccionar con corazón en este canal.', 400)

  const enabled = await isMetaSocialMessagingEnabled(cleanPlatform)
  if (!enabled) {
    throw createMetaSocialMessageError(`Activa ${getPlatformLabel(cleanPlatform)} en Configuración > Meta Ads > Redes sociales para reaccionar por este canal.`, 409)
  }

  const config = await getMetaSocialConfig().catch(error => {
    logger.warn(`No se pudo leer Meta para reaccionar DM: ${error.message}`)
    return null
  })
  const hasRequiredToken = hasMetaSocialGraphTokenSource(cleanPlatform, config || {})
  if (!hasRequiredToken) {
    throw createMetaSocialMessageError(
      cleanPlatform === 'instagram'
        ? 'Conecta Meta Ads con un token que pueda operar la Página enlazada a Instagram.'
        : 'Conecta Meta Ads para responder por Messenger.',
      409
    )
  }

  const profile = await db.get(
    `SELECT id, sender_id, recipient_id, page_id, instagram_account_id
     FROM meta_social_contacts
     WHERE contact_id = ? AND platform = ?
     ORDER BY updated_at DESC, last_seen_at DESC
     LIMIT 1`,
    [cleanContactId, cleanPlatform]
  ).catch(() => null)

  const recipientId = cleanString(profile?.sender_id)
  if (!profile || !recipientId) {
    throw createMetaSocialMessageError(`Este contacto no tiene ${getPlatformLabel(cleanPlatform)} enlazado.`, 404)
  }

  const businessId = getMetaSocialBusinessId(cleanPlatform, config, profile)
  if (!businessId) {
    throw createMetaSocialMessageError(
      cleanPlatform === 'instagram'
        ? 'Falta seleccionar la cuenta de Instagram en Meta Ads.'
        : 'Falta seleccionar la página de Facebook en Meta Ads.',
      409
    )
  }

  const target = await resolveMetaSocialMessageReference({
    contactId: cleanContactId,
    platform: cleanPlatform,
    messageId: targetMessageId,
    providerMessageId: targetProviderMessageId
  })
  const targetProviderId = cleanString(target?.providerMessageId || targetProviderMessageId)
  if (!targetProviderId) throw createMetaSocialMessageError('No encontramos el mensaje original para reaccionar.', 400)

  let response
  try {
    response = cleanPlatform === 'instagram'
      ? await sendMetaInstagramReactionRequest({ businessId, recipientId, reaction, targetProviderMessageId: targetProviderId, config })
      : await sendMetaMessengerReactionRequest({ businessId, recipientId, reaction, targetProviderMessageId: targetProviderId, config })
  } catch (error) {
    throw normalizeMetaSocialSendError(error, cleanPlatform)
  }

  const responseMessageId = cleanString(response?.message_id || response?.id)
  const localReactionId = cleanString(externalId) || hashId('meta_social_reaction', `${cleanPlatform}:${targetProviderId}:${reaction}:${Date.now()}`)

  const sent = await saveMetaSocialOutboundMessage({
    platform: cleanPlatform,
    contactId: cleanContactId,
    profile,
    messageId: responseMessageId || localReactionId,
    text: '❤️',
    response,
    externalId: localReactionId,
    messageType: 'reaction',
    context: {
      reaction,
      target_message_id: targetProviderId
    }
  })

  return {
    ...sent,
    id: sent.remoteMessageId || sent.localMessageId,
    platform: cleanPlatform,
    provider: 'meta',
    data: sent
  }
}

export async function markLatestMetaSocialMessageReadForContact({ contactId, platform = '' } = {}) {
  const cleanContactId = cleanString(contactId)
  if (!cleanContactId) {
    return [{ platform: '', attempted: false, reason: 'missing_contact' }]
  }

  const requestedPlatform = cleanString(platform).toLowerCase()
  const platforms = requestedPlatform
    ? [requestedPlatform === 'instagram' ? 'instagram' : 'messenger']
    : ['messenger', 'instagram']
  const config = await getMetaSocialConfig().catch(error => {
    logger.warn(`No se pudo leer Meta para marcar visto: ${error.message}`)
    return null
  })
  const results = []

  for (const cleanPlatform of platforms) {
    try {
      const enabled = await isMetaSocialMessagingEnabled(cleanPlatform)
      if (!enabled) {
        results.push({ platform: cleanPlatform, attempted: false, reason: 'messaging_disabled' })
        continue
      }

      const profile = await db.get(
        `SELECT id, sender_id, recipient_id, page_id, instagram_account_id
         FROM meta_social_contacts
         WHERE contact_id = ? AND platform = ?
         ORDER BY updated_at DESC, last_seen_at DESC
         LIMIT 1`,
        [cleanContactId, cleanPlatform]
      ).catch(() => null)
      const recipientId = cleanString(profile?.sender_id)
      if (!profile || !recipientId) {
        results.push({ platform: cleanPlatform, attempted: false, reason: 'contact_not_linked' })
        continue
      }

      const row = await db.get(`
        SELECT id, meta_message_id, sender_id
        FROM meta_social_messages
        WHERE contact_id = ?
          AND platform = ?
          AND LOWER(COALESCE(direction, '')) = 'inbound'
          AND COALESCE(comment_id, '') = ''
          AND LOWER(COALESCE(status, '')) NOT IN ('read', 'failed', 'removed')
        ORDER BY COALESCE(message_timestamp, updated_at, created_at) DESC
        LIMIT 1
      `, [cleanContactId, cleanPlatform]).catch(() => null)
      if (!row) {
        results.push({ platform: cleanPlatform, attempted: false, reason: 'no_unread_inbound_message' })
        continue
      }

      const businessId = getMetaSocialBusinessId(cleanPlatform, config, profile)
      if (!businessId && cleanPlatform !== 'instagram') {
        results.push({ platform: cleanPlatform, attempted: false, reason: 'missing_business_id' })
        continue
      }

      if (cleanPlatform === 'instagram') {
        await sendMetaInstagramMarkSeenRequest({ recipientId, config })
      } else {
        await sendMetaMessengerMarkSeenRequest({ businessId, recipientId, config })
      }

      await db.run(`
        UPDATE meta_social_messages
        SET status = 'read',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [row.id]).catch(() => undefined)

      results.push({
        platform: cleanPlatform,
        attempted: true,
        provider: 'meta',
        messageId: row.id,
        providerMessageId: cleanString(row.meta_message_id)
      })
    } catch (error) {
      results.push({
        platform: cleanPlatform,
        attempted: false,
        error: true,
        reason: error.message || 'meta_mark_seen_failed'
      })
    }
  }

  return results
}

// Responder un COMENTARIO. replyType:
//  - 'public'  => responde en la publicación (FB: /{comment_id}/comments, IG: /{comment_id}/replies)
//  - 'private' => abre/continúa un DM con quien comentó (/{businessId}/messages recipient:{comment_id})
// Se apoya en el token de PÁGINA y en el comment_id del último comentario entrante
// del contacto (si no se pasa explícito). NO usa el senderId sintético (no es un PSID).
export async function sendMetaSocialCommentReply({ contactId, platform, message, replyType = 'private', commentId = '', postId = '', externalId, agentId, attachment = null, publicBaseUrl = '' } = {}) {
  const cleanContactId = cleanString(contactId)
  const cleanPlatform = cleanString(platform).toLowerCase() === 'instagram' ? 'instagram' : 'messenger'
  const body = cleanString(message)
  const mode = cleanString(replyType).toLowerCase() === 'public' ? 'public' : 'private'
  const rawAttachmentType = cleanString(attachment?.type).toLowerCase()
  const attachmentType = rawAttachmentType === 'voice'
    ? 'audio'
    : rawAttachmentType === 'document' ? 'file' : rawAttachmentType
  // Un envío lleva texto O un adjunto. Private Replies por comment_id sólo
  // admite texto; el adjunto existe aquí únicamente para la imagen pública de FB.
  let att = attachment && (cleanString(attachment.dataUrl || attachment.data_url) || cleanString(attachment.url || attachment.link))
    ? {
        type: attachmentType || 'image',
        dataUrl: cleanString(attachment.dataUrl || attachment.data_url),
        url: cleanString(attachment.url || attachment.link),
        mimeType: cleanMediaMimeType(attachment.mimeType || attachment.mimetype),
        filename: sanitizeMetaMediaFilename(attachment.filename || attachment.fileName, 'imagen')
      }
    : null

  if (!cleanContactId) throw createMetaSocialMessageError('Falta el contacto', 400)
  if (!body && !att) throw createMetaSocialMessageError('Falta el contenido de la respuesta', 400)
  if (att && mode === 'private') {
    throw createMetaSocialMessageError(
      'La respuesta privada inicial a un comentario solo admite texto. Cuando la persona responda, envía imagen, video o audio desde su conversación normal.',
      422,
      { code: 'meta_private_comment_reply_text_only' }
    )
  }
  if (att && cleanPlatform === 'instagram') {
    throw createMetaSocialMessageError('Instagram no permite adjuntos en respuestas públicas; responde con texto.', 422, {
      code: 'instagram_public_comment_attachment_not_supported'
    })
  }
  if (att && att.type !== 'image') {
    throw createMetaSocialMessageError('En respuestas públicas de Facebook solo puedes adjuntar una imagen.', 422, {
      code: 'facebook_public_comment_image_only'
    })
  }

  const existingSend = await findMetaSocialOutboundByExternalId({
    contactId: cleanContactId,
    platform: cleanPlatform,
    externalId
  })
  if (existingSend) {
    return {
      ...buildReusedMetaSocialSendResult(existingSend, cleanPlatform),
      replyType: mode,
      commentId: cleanString(commentId) || null
    }
  }

  const enabled = await isMetaSocialCommentsEnabled(cleanPlatform)
  if (!enabled) {
    throw createMetaSocialMessageError(`Activa los comentarios de ${getCommentPlatformLabel(cleanPlatform)} en Configuración > Meta Ads > Redes sociales para responder.`, 409)
  }

  const config = await getMetaSocialConfig().catch(error => {
    logger.warn(`No se pudo leer Meta para responder comentario: ${error.message}`)
    return null
  })
  const hasRequiredToken = hasMetaSocialGraphTokenSource(cleanPlatform, config || {})
  if (!hasRequiredToken) {
    throw createMetaSocialMessageError(
      cleanPlatform === 'instagram'
        ? 'Conecta Meta Ads con un token que pueda operar la Página enlazada a Instagram.'
        : 'Conecta Meta Ads para responder comentarios de Facebook.',
      409
    )
  }

  // Perfil del contacto-comentario (para guardar el saliente en el mismo hilo).
  const profile = await db.get(
    `SELECT id, sender_id, recipient_id, page_id, instagram_account_id
     FROM meta_social_contacts
     WHERE contact_id = ? AND platform = ?
     ORDER BY updated_at DESC, last_seen_at DESC
     LIMIT 1`,
    [cleanContactId, cleanPlatform]
  ).catch(() => null)

  // Resolver el comentario objetivo (último entrante) si no viene explícito.
  let targetCommentId = cleanString(commentId)
  let targetPostId = cleanString(postId)
  if (!targetCommentId) {
    const row = await db.get(
      `SELECT comment_id, post_id FROM meta_social_messages
       WHERE contact_id = ? AND platform = ? AND message_type = 'comment'
         AND LOWER(COALESCE(direction,'')) = 'inbound' AND COALESCE(comment_id,'') <> ''
       ORDER BY COALESCE(message_timestamp, created_at) DESC
       LIMIT 1`,
      [cleanContactId, cleanPlatform]
    ).catch(() => null)
    targetCommentId = cleanString(row?.comment_id)
    targetPostId = targetPostId || cleanString(row?.post_id)
  }
  if (!targetCommentId) {
    throw createMetaSocialMessageError('No se encontró el comentario al que responder.', 404)
  }

  // Resolver la publicación del comentario para guardarla en el saliente y que el
  // globo de la respuesta muestre la misma tarjeta de la publicación que el
  // comentario original. El comment_id de Meta es único global, así que basta con
  // él (funciona aunque el comentario viva en el contacto-comentario enlazado).
  if (!targetPostId) {
    const postRow = await db.get(
      `SELECT post_id, media_id FROM meta_social_messages
       WHERE comment_id = ? AND (COALESCE(post_id, '') <> '' OR COALESCE(media_id, '') <> '')
       ORDER BY COALESCE(message_timestamp, created_at) DESC
       LIMIT 1`,
      [targetCommentId]
    ).catch(() => null)
    targetPostId = cleanString(postRow?.post_id) || cleanString(postRow?.media_id)
  }

  if (att) {
    const preparedMedia = await prepareMetaSocialOutboundMedia({
      platform: cleanPlatform,
      attachmentType: 'image',
      attachmentDataUrl: att.dataUrl,
      attachmentUrl: att.dataUrl ? '' : att.url,
      mimeType: att.mimeType,
      filename: att.filename,
      publicBaseUrl
    })
    att = {
      type: 'image',
      url: preparedMedia.publicUrl,
      mimeType: preparedMedia.mimeType,
      filename: preparedMedia.filename,
      mediaAssetId: preparedMedia.mediaAssetId
    }
  }

  let path
  let payload
  let graphCredentials = null
  if (mode === 'public') {
    path = cleanPlatform === 'instagram'
      ? `/${encodeURIComponent(targetCommentId)}/replies`
      : `/${encodeURIComponent(targetCommentId)}/comments`
    if (att) {
      // Público: Instagram es SOLO texto; Facebook admite UNA imagen (attachment_url).
      payload = body ? { message: body, attachment_url: att.url } : { attachment_url: att.url }
    } else {
      payload = { message: body }
    }
  } else {
    const businessId = getMetaSocialBusinessId(cleanPlatform, config, profile || {})
    const canUseInstagramPageNode = cleanPlatform === 'instagram' && cleanString(config?.page_id)
    if (!businessId && !canUseInstagramPageNode) {
      throw createMetaSocialMessageError(
        cleanPlatform === 'instagram' ? 'Falta la cuenta de Instagram en Meta Ads.' : 'Falta la página de Facebook en Meta Ads.',
        409
      )
    }
    graphCredentials = await resolveMetaSocialGraphCredentials(cleanPlatform, config)
    path = cleanPlatform === 'instagram'
      ? getMetaInstagramMessagesPath({ businessId, config, credentials: graphCredentials })
      : `/${encodeURIComponent(businessId)}/messages`
    // Private Replies abre el hilo con un único texto. La multimedia se habilita
    // después, cuando el usuario responde y ya existe recipient.id/PSID/IGSID.
    payload = { recipient: { comment_id: targetCommentId }, message: { text: body } }
  }

  graphCredentials ||= await resolveMetaSocialGraphCredentials(cleanPlatform, config)
  const commentContext = {
    commentReply: {
      mode,
      commentId: targetCommentId,
      ...(targetPostId ? { postId: targetPostId } : {})
    },
    ...(att ? {
      attachment: {
        type: 'image',
        link: att.url,
        url: att.url,
        mimeType: att.mimeType,
        filename: att.filename,
        ...(att.mediaAssetId ? { mediaAssetId: att.mediaAssetId } : {})
      }
    } : {})
  }
  const dispatch = await claimMetaSocialOutboundDispatch({
    contactId: cleanContactId,
    platform: cleanPlatform,
    externalId,
    profile,
    messageType: mode === 'public' ? 'comment_reply_public' : 'comment_reply_private',
    text: body,
    mediaUrl: att?.url || '',
    mediaMimeType: att?.mimeType || '',
    context: commentContext
  })
  if (!dispatch.claimed) {
    return {
      ...buildReusedMetaSocialSendResult(dispatch.existing, cleanPlatform),
      replyType: mode,
      commentId: targetCommentId
    }
  }
  await markMetaSocialOutboundDispatchSending(dispatch.reservationId)

  let response
  try {
    try {
      response = await metaSocialGraphRequest(path, {
        method: 'POST',
        token: graphCredentials.token,
        baseUrl: graphCredentials.baseUrl,
        body: payload
      })
    } catch (error) {
      if (!shouldRefreshMetaPageToken(error)) throw error
      const retryCredentials = await resolveMetaSocialGraphCredentials(cleanPlatform, config, { forceRefresh: true })
      const retryPath = mode === 'private' && cleanPlatform === 'instagram'
        ? getMetaInstagramMessagesPath({
            businessId: getMetaSocialBusinessId(cleanPlatform, config, profile || {}),
            config,
            credentials: retryCredentials
          })
        : path
      response = await metaSocialGraphRequest(retryPath, {
        method: 'POST',
        token: retryCredentials.token,
        baseUrl: retryCredentials.baseUrl,
        body: payload
      })
    }
  } catch (error) {
    await handleMetaSocialOutboundDispatchFailure(dispatch.reservationId, error).catch(() => undefined)
    throw normalizeMetaSocialCommentReplyError(error, cleanPlatform, mode)
  }

  await markMetaSocialOutboundDispatchAccepted({
    reservationId: dispatch.reservationId,
    remoteMessageId: response?.id || response?.message_id,
    response,
    externalId,
    context: commentContext,
    mediaUrl: att?.url || '',
    mediaMimeType: att?.mimeType || ''
  })

  const sent = await saveMetaSocialOutboundMessage({
    platform: cleanPlatform,
    contactId: cleanContactId,
    profile: profile || {},
    messageId: response?.id || response?.message_id,
    text: body,
    response,
    externalId,
    agentId,
    messageType: mode === 'public' ? 'comment_reply_public' : 'comment_reply_private',
    mediaUrl: att?.url || '',
    mediaMimeType: att?.mimeType || '',
    commentId: targetCommentId,
    postId: targetPostId,
    context: commentContext,
    reservationId: dispatch.reservationId
  })

  return {
    ...sent,
    id: sent.remoteMessageId || sent.localMessageId,
    platform: cleanPlatform,
    provider: 'meta',
    replyType: mode,
    commentId: targetCommentId,
    data: sent
  }
}

async function upsertLocalSocialContact({ socialMessage, profile }) {
  const contactId = hashId('meta_social_contact', `${socialMessage.platform}:${socialMessage.senderId}`)
  const platformLabel = getPlatformLabel(socialMessage.platform)
  const contactName = compactName(profile.name) ||
    compactName(profile.username ? `@${profile.username}` : '') ||
    getFallbackContactName(socialMessage.platform, socialMessage.senderId)
  const customFieldsValue = JSON.stringify([
    { key: 'meta_social_platform', field_value: platformLabel },
    { key: 'meta_social_sender_id', field_value: socialMessage.senderId },
    { key: 'meta_social_page_id', field_value: socialMessage.pageId || '' },
    { key: 'meta_social_instagram_account_id', field_value: socialMessage.instagramAccountId || '' },
    { key: 'meta_social_first_message', field_value: socialMessage.messageText || '' }
  ])
  const customFieldsPlaceholder = process.env.DATABASE_URL ? '?::jsonb' : '?'

  // Atribución de anuncio (CTM/CTI): si el DM llegó desde un anuncio de
  // Click-to-Messenger/Instagram, el referral trae ad_id + título. Lo guardamos en
  // el contacto para que el evento de CAPI quede atribuido al anuncio (paridad con
  // WhatsApp). Los comentarios no traen referral → queda vacío (sin efecto).
  const referral = socialMessage.referral || {}
  const adId = cleanString(referral.ad_id)
  const adName = cleanString(referral.ads_context_data?.ad_title || referral.ref)

  await db.run(`
    INSERT INTO contacts (
      id, full_name, first_name, source,
      attribution_session_source, attribution_medium, attribution_ad_id, attribution_ad_name, custom_fields,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${customFieldsPlaceholder}, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE SET
      full_name = COALESCE(NULLIF(contacts.full_name, ''), excluded.full_name),
      first_name = COALESCE(NULLIF(contacts.first_name, ''), excluded.first_name),
      source = COALESCE(NULLIF(contacts.source, ''), excluded.source),
      attribution_session_source = COALESCE(NULLIF(contacts.attribution_session_source, ''), excluded.attribution_session_source),
      attribution_medium = COALESCE(NULLIF(contacts.attribution_medium, ''), excluded.attribution_medium),
      attribution_ad_id = COALESCE(NULLIF(contacts.attribution_ad_id, ''), excluded.attribution_ad_id),
      attribution_ad_name = COALESCE(NULLIF(contacts.attribution_ad_name, ''), excluded.attribution_ad_name),
      custom_fields = COALESCE(contacts.custom_fields, excluded.custom_fields),
      updated_at = CURRENT_TIMESTAMP
  `, [
    contactId,
    contactName,
    contactName,
    platformLabel,
    socialMessage.platform,
    'dm',
    adId || null,
    adName || null,
    customFieldsValue,
    socialMessage.messageTimestamp
  ])

  return {
    id: contactId,
    contactName
  }
}

// Rehospeda (best-effort) el avatar social al Bunny para que no caduque. CRÍTICO
// para comentarios: su foto no se puede re-pedir después, así que se rehospeda
// aquí mismo (síncrono) con la URL que ya tenemos en mano. Nunca lanza.
async function rehostMetaAvatarUrl({ incomingUrl, currentUrl, platform, senderId }) {
  const raw = cleanString(incomingUrl)
  if (!raw) return ''
  try {
    const { resolveAvatarForPersist } = await import('./mediaStorageService.js')
    const channel = cleanString(platform).toLowerCase() || 'social'
    const idHint = cleanString(senderId).replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 40) || 'contact'
    const resolved = await resolveAvatarForPersist({
      incomingUrl: raw,
      currentUrl: cleanString(currentUrl),
      channel,
      subFolder: channel,
      filename: `${channel}-${idHint}.jpg`
    })
    return resolved?.url || raw
  } catch {
    return raw
  }
}

async function upsertMetaSocialContact({ contactId, socialMessage, profile, incrementMessageCount = true }) {
  const socialContactId = hashId('meta_social_profile', `${socialMessage.platform}:${socialMessage.senderId}`)
  const messageCountIncrement = incrementMessageCount ? 1 : 0

  // Rehospedar el avatar al Bunny (una vez por contacto) para que no caduque.
  const currentSocialRow = await db
    .get('SELECT profile_picture_url FROM meta_social_contacts WHERE platform = ? AND sender_id = ? LIMIT 1', [socialMessage.platform, socialMessage.senderId])
    .catch(() => null)
  const storedPictureUrl = await rehostMetaAvatarUrl({
    incomingUrl: profile.profilePictureUrl,
    currentUrl: currentSocialRow?.profile_picture_url,
    platform: socialMessage.platform,
    senderId: socialMessage.senderId
  })

  await db.run(`
    INSERT INTO meta_social_contacts (
      id, contact_id, platform, sender_id, recipient_id, page_id, instagram_account_id,
      profile_name, username, profile_picture_url, raw_profile_json, meta_user_id,
      first_seen_at, last_seen_at, message_count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(platform, sender_id) DO UPDATE SET
      contact_id = COALESCE(excluded.contact_id, meta_social_contacts.contact_id),
      recipient_id = COALESCE(NULLIF(excluded.recipient_id, ''), meta_social_contacts.recipient_id),
      page_id = COALESCE(NULLIF(excluded.page_id, ''), meta_social_contacts.page_id),
      instagram_account_id = COALESCE(NULLIF(excluded.instagram_account_id, ''), meta_social_contacts.instagram_account_id),
      meta_user_id = COALESCE(NULLIF(excluded.meta_user_id, ''), meta_social_contacts.meta_user_id),
      profile_name = COALESCE(NULLIF(excluded.profile_name, ''), meta_social_contacts.profile_name),
      username = COALESCE(NULLIF(excluded.username, ''), meta_social_contacts.username),
      profile_picture_url = COALESCE(NULLIF(excluded.profile_picture_url, ''), meta_social_contacts.profile_picture_url),
      raw_profile_json = COALESCE(NULLIF(excluded.raw_profile_json, 'null'), meta_social_contacts.raw_profile_json),
      first_seen_at = CASE
        WHEN meta_social_contacts.first_seen_at IS NULL THEN excluded.first_seen_at
        WHEN excluded.first_seen_at IS NULL THEN meta_social_contacts.first_seen_at
        WHEN excluded.first_seen_at < meta_social_contacts.first_seen_at THEN excluded.first_seen_at
        ELSE meta_social_contacts.first_seen_at
      END,
      last_seen_at = CASE
        WHEN meta_social_contacts.last_seen_at IS NULL THEN excluded.last_seen_at
        WHEN excluded.last_seen_at IS NULL THEN meta_social_contacts.last_seen_at
        WHEN excluded.last_seen_at > meta_social_contacts.last_seen_at THEN excluded.last_seen_at
        ELSE meta_social_contacts.last_seen_at
      END,
      message_count = meta_social_contacts.message_count + excluded.message_count,
      updated_at = CURRENT_TIMESTAMP
  `, [
    socialContactId,
    contactId,
    socialMessage.platform,
    socialMessage.senderId,
    socialMessage.recipientId || null,
    socialMessage.pageId || null,
    socialMessage.instagramAccountId || null,
    profile.name || null,
    profile.username || null,
    storedPictureUrl || null,
    safeJson(profile.raw || null),
    // id crudo del usuario (PSID/IGSID): para DMs es senderId; para comentarios
    // es authorId (senderId trae el prefijo sintético 'fb_comment:'/'ig_comment:').
    cleanString(socialMessage.authorId) || cleanString(socialMessage.senderId) || null,
    socialMessage.messageTimestamp,
    socialMessage.messageTimestamp,
    messageCountIncrement
  ])

  // El perfil puede existir desde una importación o versión anterior con un id
  // distinto al hash canónico actual. En ese caso el ON CONFLICT actualiza esa
  // fila, pero `socialContactId` sigue apuntando al id candidato que nunca se
  // insertó. Devolverlo rompe la FK de meta_social_messages justo cuando un echo
  // saliente intenta reconciliarse con una reserva local. Siempre regresamos el
  // id que realmente quedó persistido.
  const persisted = await db.get(
    'SELECT id FROM meta_social_contacts WHERE platform = ? AND sender_id = ? LIMIT 1',
    [socialMessage.platform, socialMessage.senderId]
  )

  return cleanString(persisted?.id) || socialContactId
}

// ─── Rehospedaje de media entrante de Messenger/Instagram ───
// Las URLs de adjuntos que manda Meta en el webhook son temporales y caducan (CDN
// firmado de Facebook/Instagram). Si las guardáramos tal cual, el historial de fotos/
// audios/videos/documentos se "pudre": al abrir un chat viejo el archivo ya no carga.
// Por eso descargamos el binario y lo rehospedamos en nuestro storage (Bunny, módulo
// 'chat'), igual que hacemos con WhatsApp Cloud API y con el canal QR.

const SOCIAL_MEDIA_DOWNLOAD_TIMEOUT_MS = 20000

function isMetaHostedMediaUrl(url) {
  const u = cleanString(url).toLowerCase()
  if (!u) return false
  // Dominios de CDN de Meta cuyas URLs caducan. Cualquier otra (p. ej. nuestro Bunny)
  // se considera ya persistida y no se vuelve a descargar.
  return /(fbcdn\.net|fbsbx\.com|lookaside\.|cdninstagram\.com|scontent)/.test(u)
}

function normalizeSocialMediaType(type) {
  const t = cleanString(type).toLowerCase()
  if (t === 'image') return 'image'
  if (t === 'video') return 'video'
  if (t === 'audio') return 'audio'
  if (t === 'file' || t === 'document') return 'document'
  return 'document'
}

function getSocialMediaLimitBytes(mediaType) {
  switch (normalizeSocialMediaType(mediaType)) {
    case 'image': return Number(process.env.META_SOCIAL_IMAGE_MAX_BYTES || 25 * 1024 * 1024)
    case 'video': return Number(process.env.META_SOCIAL_VIDEO_MAX_BYTES || 64 * 1024 * 1024)
    case 'audio': return Number(process.env.META_SOCIAL_AUDIO_MAX_BYTES || 25 * 1024 * 1024)
    default: return Number(process.env.META_SOCIAL_DOCUMENT_MAX_BYTES || 50 * 1024 * 1024)
  }
}

const SOCIAL_EXTENSION_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
  'application/pdf': 'pdf'
}

function fallbackSocialMime(mediaType) {
  switch (normalizeSocialMediaType(mediaType)) {
    case 'image': return 'image/jpeg'
    case 'video': return 'video/mp4'
    case 'audio': return 'audio/mpeg'
    default: return 'application/octet-stream'
  }
}

function buildSocialMediaFilename({ platform, messageType, mimeType, seed }) {
  const type = normalizeSocialMediaType(messageType)
  const extension = SOCIAL_EXTENSION_BY_MIME[cleanMimeType(mimeType)] ||
    (type === 'image' ? 'jpg' : type === 'video' ? 'mp4' : type === 'audio' ? 'mp3' : 'bin')
  const suffix = cleanString(seed).replace(/[^a-z0-9]/gi, '').slice(-12) || String(Date.now())
  return `${cleanString(platform) || 'meta'}-${type}-${suffix}.${extension}`
}

function cleanMimeType(value) {
  return cleanString(value).split(';')[0].toLowerCase()
}

async function downloadMetaAttachmentBuffer(url, token, timeoutMs = SOCIAL_MEDIA_DOWNLOAD_TIMEOUT_MS) {
  const controller = new AbortController()
  const parsedTimeout = Number(timeoutMs)
  const effectiveTimeout = Number.isFinite(parsedTimeout) && parsedTimeout > 0
    ? Math.min(SOCIAL_MEDIA_DOWNLOAD_TIMEOUT_MS, Math.max(1000, parsedTimeout))
    : SOCIAL_MEDIA_DOWNLOAD_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), effectiveTimeout)
  try {
    let response = await fetch(url, { redirect: 'follow', signal: controller.signal })
    if ((response.status === 401 || response.status === 403) && cleanString(token)) {
      const authenticatedUrl = new URL(url)
      const proof = await resolveMetaAppSecretProof(token)
      if (proof) authenticatedUrl.searchParams.set('appsecret_proof', proof)
      response = await fetch(authenticatedUrl.toString(), {
        redirect: 'follow',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${cleanString(token)}` }
      })
    }
    if (!response.ok) throw new Error(`Meta respondió ${response.status} al descargar el adjunto`)
    const buffer = Buffer.from(await response.arrayBuffer())
    const mimeType = cleanMimeType(response.headers.get('content-type'))
    return { buffer, mimeType }
  } finally {
    clearTimeout(timer)
  }
}

async function defaultSocialMediaUploader(input) {
  const { uploadMediaAsset } = await import('./mediaStorageService.js')
  return uploadMediaAsset(input)
}

// Transporte inyectable (descarga + subida) para poder probar el rehospedaje sin red ni
// Bunny reales. En producción usa node-fetch + uploadMediaAsset.
let socialMediaDownloader = downloadMetaAttachmentBuffer
let socialMediaUploader = defaultSocialMediaUploader

export function setMetaSocialMediaTransportForTest(overrides = {}) {
  socialMediaDownloader = typeof overrides.downloader === 'function' ? overrides.downloader : downloadMetaAttachmentBuffer
  socialMediaUploader = typeof overrides.uploader === 'function' ? overrides.uploader : defaultSocialMediaUploader
}

export { isMetaHostedMediaUrl, normalizeSocialMediaType }

// Descarga la media de Meta y la sube a Bunny. Devuelve { mediaUrl, mediaMimeType } con
// la URL persistida, o null si no aplica / falla (en cuyo caso se conserva la URL de Meta).
export async function rehostMetaSocialMedia({ socialMessage, config, accessToken = '', existingMediaUrl = '' }) {
  const sourceUrl = cleanString(socialMessage.mediaUrl)
  if (!sourceUrl || !isMetaHostedMediaUrl(sourceUrl)) return null

  // Idempotencia: si ya guardamos una versión rehospedada, reutilizarla sin re-descargar
  // (p. ej. si el webhook reenvía el mismo mensaje).
  if (existingMediaUrl && !isMetaHostedMediaUrl(existingMediaUrl)) {
    return { mediaUrl: existingMediaUrl, mediaMimeType: cleanString(socialMessage.mediaMimeType) }
  }

  // Para comentarios el messageType es 'comment' pero el adjunto es imagen/video: usa
  // mediaType explícito si viene, cayendo al messageType para los DMs.
  const messageType = normalizeSocialMediaType(socialMessage.mediaType || socialMessage.messageType)
  const limitBytes = getSocialMediaLimitBytes(messageType)

  const token = cleanString(accessToken) || await resolveMetaSocialGraphToken(socialMessage.platform, config, { safe: true })
  const { buffer, mimeType: downloadedMime } = await socialMediaDownloader(
    sourceUrl,
    token,
    socialMessage.downloadTimeoutMs
  )
  if (!buffer?.length) throw new Error('Meta devolvió un adjunto vacío')
  if (buffer.length > limitBytes) {
    throw new Error(`El adjunto excede el tamaño máximo permitido (${buffer.length} > ${limitBytes})`)
  }

  const mimeType = cleanString(socialMessage.mediaMimeType) || downloadedMime || fallbackSocialMime(messageType)
  const filename = buildSocialMediaFilename({
    platform: socialMessage.platform,
    messageType,
    mimeType,
    seed: socialMessage.metaMessageId || sourceUrl
  })

  const asset = await socialMediaUploader({
    buffer,
    mimeType,
    filename,
    module: 'chat',
    isPublic: true,
    skipCompression: true,
    metadata: {
      source: cleanString(socialMessage.metadataSource) || 'meta_social_inbound_media',
      platform: socialMessage.platform,
      metaMessageId: cleanString(socialMessage.metaMessageId),
      whatsappMessageType: messageType
    }
  })

  return {
    mediaUrl: asset.publicUrl,
    mediaMimeType: asset.mimeType || mimeType
  }
}

function getMetaSocialMessageLocalId(socialMessage = {}) {
  const remoteMessageId = cleanString(socialMessage.metaMessageId)
  if (remoteMessageId && cleanString(socialMessage.direction).toLowerCase() === 'outbound') {
    return hashId('meta_social_msg', `${socialMessage.platform}:${remoteMessageId}:outbound`)
  }
  return hashId(
    'meta_social_msg',
    remoteMessageId ||
      `${socialMessage.platform}:${socialMessage.senderId}:${socialMessage.messageTimestamp}:${socialMessage.messageText}:${socialMessage.messageType}`
  )
}

// La identidad remota deduplica la burbuja, pero nunca autoriza cambiarla de
// contacto. Un contact_id existente sólo se mueve mediante mergeContactIds,
// bajo locks de origen y destino.
export async function upsertMetaSocialMessage({ socialContactId, contactId, socialMessage, config = null, historyImport = false }) {
  let messageId = getMetaSocialMessageLocalId(socialMessage)
  const remoteMessageId = cleanString(socialMessage.metaMessageId)
  if (remoteMessageId && cleanString(socialMessage.direction).toLowerCase() === 'outbound') {
    const acceptedLocalSend = await db.get(`
      SELECT id
      FROM meta_social_messages
      WHERE platform = ? AND meta_message_id = ? AND direction = 'outbound'
      ORDER BY updated_at DESC
      LIMIT 1
    `, [socialMessage.platform, remoteMessageId]).catch(() => null)
    if (acceptedLocalSend?.id) messageId = acceptedLocalSend.id
  }
  const existing = await db.get(
    'SELECT id, media_url, status FROM meta_social_messages WHERE id = ?',
    [messageId]
  ).catch(() => null)

  // Rehospeda la media temporal de Meta en nuestro storage para que el historial no
  // caduque. Falla suave: si no se puede, conservamos la URL de Meta (comportamiento previo).
  let resolvedMediaUrl = socialMessage.mediaUrl || null
  let resolvedMediaMime = socialMessage.mediaMimeType || null
  if (cleanString(socialMessage.mediaUrl)) {
    const rehosted = await rehostMetaSocialMedia({
      socialMessage,
      config,
      existingMediaUrl: cleanString(existing?.media_url)
    }).catch(error => {
      logger.warn(`[Meta social] No se pudo rehospedar la media de ${socialMessage.platform} ${messageId}: ${error.message}`)
      return null
    })
    if (rehosted?.mediaUrl) {
      resolvedMediaUrl = rehosted.mediaUrl
      resolvedMediaMime = rehosted.mediaMimeType || resolvedMediaMime
    }
  }

  const persistMessageAndClaim = async (transactionDatabase = db) => {
    const existingAtCommit = await db.get(
      'SELECT id FROM meta_social_messages WHERE id = ?',
      [messageId]
    ).catch(() => existing)
    await db.run(`
      INSERT INTO meta_social_messages (
        id, platform, meta_message_id, meta_social_contact_id, contact_id,
        sender_id, recipient_id, page_id, instagram_account_id,
        direction, status, message_type, message_text, media_url, media_mime_type,
        postback_payload, message_timestamp, raw_payload_json, referral_json,
        comment_id, post_id, parent_comment_id, media_id, permalink, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        meta_message_id = COALESCE(NULLIF(excluded.meta_message_id, ''), meta_social_messages.meta_message_id),
        meta_social_contact_id = COALESCE(excluded.meta_social_contact_id, meta_social_messages.meta_social_contact_id),
        contact_id = COALESCE(meta_social_messages.contact_id, excluded.contact_id),
        sender_id = COALESCE(NULLIF(excluded.sender_id, ''), meta_social_messages.sender_id),
        recipient_id = COALESCE(NULLIF(excluded.recipient_id, ''), meta_social_messages.recipient_id),
        page_id = COALESCE(NULLIF(excluded.page_id, ''), meta_social_messages.page_id),
        instagram_account_id = COALESCE(NULLIF(excluded.instagram_account_id, ''), meta_social_messages.instagram_account_id),
        direction = COALESCE(NULLIF(excluded.direction, ''), meta_social_messages.direction),
        status = CASE
          WHEN LOWER(COALESCE(meta_social_messages.status, '')) = 'removed' THEN meta_social_messages.status
          WHEN LOWER(COALESCE(excluded.status, '')) = 'removed' THEN excluded.status
          ELSE COALESCE(NULLIF(excluded.status, ''), meta_social_messages.status)
        END,
        message_type = COALESCE(NULLIF(excluded.message_type, ''), meta_social_messages.message_type),
        message_text = CASE
          WHEN LOWER(COALESCE(meta_social_messages.status, '')) = 'removed' THEN meta_social_messages.message_text
          WHEN LOWER(COALESCE(excluded.status, '')) = 'removed' THEN excluded.message_text
          ELSE COALESCE(NULLIF(excluded.message_text, ''), meta_social_messages.message_text)
        END,
        media_url = CASE
          WHEN LOWER(COALESCE(meta_social_messages.status, '')) = 'removed' THEN meta_social_messages.media_url
          WHEN LOWER(COALESCE(excluded.status, '')) = 'removed' THEN NULL
          WHEN meta_social_messages.direction = 'outbound' AND COALESCE(meta_social_messages.media_url, '') != ''
            THEN meta_social_messages.media_url
          ELSE COALESCE(NULLIF(excluded.media_url, ''), meta_social_messages.media_url)
        END,
        media_mime_type = CASE
          WHEN LOWER(COALESCE(meta_social_messages.status, '')) = 'removed' THEN meta_social_messages.media_mime_type
          WHEN LOWER(COALESCE(excluded.status, '')) = 'removed' THEN NULL
          WHEN meta_social_messages.direction = 'outbound' AND COALESCE(meta_social_messages.media_mime_type, '') != ''
            THEN meta_social_messages.media_mime_type
          ELSE COALESCE(NULLIF(excluded.media_mime_type, ''), meta_social_messages.media_mime_type)
        END,
        postback_payload = COALESCE(NULLIF(excluded.postback_payload, ''), meta_social_messages.postback_payload),
        message_timestamp = CASE
          WHEN ? = 1 THEN meta_social_messages.message_timestamp
          ELSE COALESCE(excluded.message_timestamp, meta_social_messages.message_timestamp)
        END,
        raw_payload_json = CASE
          WHEN LOWER(COALESCE(meta_social_messages.status, '')) = 'removed' THEN meta_social_messages.raw_payload_json
          WHEN LOWER(COALESCE(excluded.status, '')) = 'removed' THEN excluded.raw_payload_json
          WHEN meta_social_messages.direction = 'outbound' AND excluded.direction = 'outbound'
            THEN meta_social_messages.raw_payload_json
          ELSE excluded.raw_payload_json
        END,
        referral_json = COALESCE(NULLIF(excluded.referral_json, 'null'), meta_social_messages.referral_json),
        comment_id = COALESCE(NULLIF(excluded.comment_id, ''), meta_social_messages.comment_id),
        post_id = COALESCE(NULLIF(excluded.post_id, ''), meta_social_messages.post_id),
        parent_comment_id = COALESCE(NULLIF(excluded.parent_comment_id, ''), meta_social_messages.parent_comment_id),
        media_id = COALESCE(NULLIF(excluded.media_id, ''), meta_social_messages.media_id),
        permalink = COALESCE(NULLIF(excluded.permalink, ''), meta_social_messages.permalink),
        updated_at = CURRENT_TIMESTAMP
    `, [
      messageId,
      socialMessage.platform,
      socialMessage.metaMessageId || null,
      socialContactId,
      contactId,
      socialMessage.senderId || null,
      socialMessage.recipientId || null,
      socialMessage.pageId || null,
      socialMessage.instagramAccountId || null,
      socialMessage.direction,
      socialMessage.status || null,
      socialMessage.messageType || 'message',
      socialMessage.messageText || null,
      resolvedMediaUrl,
      resolvedMediaMime,
      socialMessage.postbackPayload || null,
      socialMessage.messageTimestamp,
      safeJson(socialMessage.raw),
      safeJson(socialMessage.referral),
      socialMessage.commentId || null,
      socialMessage.postId || null,
      socialMessage.parentCommentId || null,
      socialMessage.mediaId || null,
      socialMessage.permalink || null,
      socialMessage.isMutation ? 1 : 0
    ])

    const inboundClaim = socialMessage.direction === 'inbound' && !socialMessage.isMutation
      ? await claimInboundChatMessage({
        channel: socialMessage.platform,
        messageId,
        contactId,
        messageTimestamp: socialMessage.messageTimestamp,
        incrementUnread: !historyImport,
        database: transactionDatabase
      })
      : null
    return { existingAtCommit, inboundClaim }
  }
  const messageType = cleanString(socialMessage.messageType).toLowerCase()
  const isSubstantiveInbound = socialMessage.direction === 'inbound' &&
    !socialMessage.isMutation && !['reaction', 'sticker'].includes(messageType)
  const commentChannel = ['comment', 'comment_reply_public', 'comment_reply_private'].includes(messageType)
    ? (socialMessage.platform === 'instagram' ? 'instagram_comment' : 'facebook_comment')
    : socialMessage.platform
  const persistence = isSubstantiveInbound
    ? await withConversationalInboundCommitLock({ contactId, channel: commentChannel }, persistMessageAndClaim)
    : await persistMessageAndClaim()
  const { existingAtCommit, inboundClaim } = persistence

  return {
    messageId,
    mediaUrl: resolvedMediaUrl || '',
    mediaMimeType: resolvedMediaMime || '',
    isNew: socialMessage.isMutation
      ? false
      : socialMessage.direction === 'inbound'
        ? Boolean(inboundClaim?.claimed)
        : !existingAtCommit
  }
}

async function captureMetaSocialContactIdentity({ contactId, socialMessage }) {
  if (!contactId || socialMessage?.direction !== 'inbound' || !cleanString(socialMessage?.messageText)) return

  await captureContactIdentityFromMessage({
    contactId,
    text: socialMessage.messageText,
    source: `meta_${socialMessage.platform || 'social'}_${socialMessage.messageType || 'message'}`,
    allowEmail: true,
    allowPhone: true
  })
}

function timingSafeEqualHex(a = '', b = '') {
  const left = Buffer.from(String(a), 'hex')
  const right = Buffer.from(String(b), 'hex')
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

export function verifyMetaWebhookSignature({ rawBody = '', signatureHeader = '', appSecret = '' } = {}) {
  const secret = cleanString(appSecret)
  if (!secret) return null

  const signature = cleanString(signatureHeader).replace(/^sha256=/, '')
  if (!signature) return false

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody || '')
    .digest('hex')

  return timingSafeEqualHex(expected, signature)
}

export async function getMetaWebhookVerifyToken() {
  return cleanString(process.env.META_WEBHOOK_VERIFY_TOKEN) ||
    cleanString(await getAppConfig('meta_webhook_verify_token').catch(() => '')) ||
    DEFAULT_VERIFY_TOKEN
}

async function saveWebhookEvent({ payload, rawBody, signatureValid, processedStatus = 'received', processedError = '' }) {
  const id = hashId('meta_social_evt', rawBody || safeJson(payload))
  const objectType = cleanString(payload?.object)
  const firstEntry = Array.isArray(payload?.entry) ? payload.entry[0] : null
  const firstMessaging = Array.isArray(firstEntry?.messaging) ? firstEntry.messaging[0] : null
  const firstChange = Array.isArray(firstEntry?.changes) ? firstEntry.changes[0] : null
  const platform = objectType === 'instagram' ? 'instagram' : 'messenger'
  const eventType = firstMessaging?.message
    ? (firstMessaging.message.is_deleted === true ? 'message_deleted' : 'message')
    : firstMessaging?.message_edit || firstMessaging?.messageEdit
      ? 'message_edit'
    : firstMessaging?.postback
      ? 'postback'
      : firstMessaging?.referral
        ? 'referral'
        : firstMessaging?.reaction
          ? 'reaction'
          : firstChange
            ? `change:${cleanString(firstChange.field) || 'unknown'}`
            : 'unknown'

  await db.run(`
    INSERT INTO meta_social_webhook_events (
      id, platform, object_type, event_type, signature_valid,
      processed_status, processed_error, raw_payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      signature_valid = COALESCE(excluded.signature_valid, meta_social_webhook_events.signature_valid),
      processed_status = excluded.processed_status,
      processed_error = excluded.processed_error,
      raw_payload_json = excluded.raw_payload_json,
      updated_at = CURRENT_TIMESTAMP
  `, [
    id,
    platform,
    objectType || null,
    eventType,
    signatureValid === null ? null : signatureValid ? 1 : 0,
    processedStatus,
    processedError || null,
    rawBody || safeJson(payload)
  ])

  return id
}

export async function processMetaSocialWebhook({
  payload = {},
  rawBody = '',
  signatureHeader = '',
  signaturePreverified = false
} = {}) {
  const config = await getMetaSocialConfig().catch(error => {
    logger.warn(`No se pudo leer configuración Meta para webhook social: ${error.message}`)
    return null
  })
  // El relay central ya verificó X-Hub-Signature-256 con el App Secret que
  // nunca sale del Installer. La segunda capa Installer -> tenant usa su HMAC
  // propio; sólo ese controller puede marcar signaturePreverified=true.
  const nativeSignatureResult = signaturePreverified
    ? true
    : verifyMetaWebhookSignature({
        rawBody,
        signatureHeader,
        appSecret: config?.app_secret
      })

  const oauthConnection = ['oauth_bisu', 'oauth_user'].includes(cleanString(config?.connection_mode))
  const signatureAccepted = signaturePreverified || (oauthConnection
    ? nativeSignatureResult === true
    : nativeSignatureResult !== false)
  const signatureValid = nativeSignatureResult === null ? null : nativeSignatureResult === true

  // OAuth jamás acepta el endpoint directo sin firma nativa: su App Secret vive
  // central y el camino normal es el relay HMAC preverified. Manual conserva por
  // transición el comportamiento legacy cuando aún no tiene App Secret; si sí
  // lo tiene, una firma incorrecta se rechaza.
  if (!signatureAccepted) {
    await saveWebhookEvent({
      payload,
      rawBody,
      signatureValid,
      processedStatus: 'rejected',
      processedError: 'Firma nativa de Meta ausente o inválida'
    })
    const error = new Error('Firma nativa de Meta ausente o inválida')
    error.statusCode = 401
    throw error
  }

  const eventRowId = await saveWebhookEvent({
    payload,
    rawBody,
    signatureValid,
    processedStatus: 'received'
  })

  const entries = Array.isArray(payload.entry) ? payload.entry : []
  const results = []
  const enabledByPlatform = new Map()
  const commentsEnabledByPlatform = new Map()
  let skippedMessages = 0

  try {
    for (const entry of entries) {
      const messagingItems = Array.isArray(entry?.messaging) ? entry.messaging : []

      for (const messaging of messagingItems) {
        const socialMessage = extractSocialMessage({
          objectType: payload.object,
          entry,
          messaging,
          config: config || {}
        })

        if (!socialMessage) continue

        if (!enabledByPlatform.has(socialMessage.platform)) {
          enabledByPlatform.set(
            socialMessage.platform,
            await isMetaSocialMessagingEnabled(socialMessage.platform)
          )
        }

        if (!enabledByPlatform.get(socialMessage.platform)) {
          skippedMessages += 1
          logger.info(`DM de ${getPlatformLabel(socialMessage.platform)} ignorado porque la mensajería Meta está apagada`)
          continue
        }

        const profileCredentials = await resolveMetaSocialGraphCredentials(socialMessage.platform, config, { safe: true })
        const profileBusinessId = getMetaSocialBusinessId(socialMessage.platform, config, {
          page_id: socialMessage.pageId,
          instagram_account_id: socialMessage.instagramAccountId
        })
        const profile = socialMessage.isMutation
          ? {}
          : await fetchMetaSenderProfile({
              platform: socialMessage.platform,
              senderId: socialMessage.senderId,
              businessId: profileBusinessId,
              accessToken: profileCredentials.token,
              baseUrl: profileCredentials.baseUrl
            })
        const localContact = await upsertLocalSocialContact({ socialMessage, profile })
        const socialContactId = await upsertMetaSocialContact({
          contactId: localContact.id,
          socialMessage,
          profile,
          incrementMessageCount: !socialMessage.isMutation
        })
        const savedMessage = await upsertMetaSocialMessage({
          socialContactId,
          contactId: localContact.id,
          socialMessage,
          config
        })

        if (savedMessage.isNew && socialMessage.direction === 'inbound') {
          await captureMetaSocialContactIdentity({ contactId: localContact.id, socialMessage })
        }

        const result = {
          ...savedMessage,
          contactId: localContact.id,
          contactName: localContact.contactName,
          platform: socialMessage.platform,
          direction: socialMessage.direction,
          messageText: socialMessage.messageText,
          messageType: socialMessage.messageType,
          timestamp: socialMessage.messageTimestamp
        }
        results.push(result)
        if (socialMessage.isMutation || result.direction !== 'inbound' || result.isNew) {
          publishChatMessageEvent({
            contactId: result.contactId,
            messageId: result.messageId,
            channel: result.platform,
            provider: 'meta',
            transport: result.platform,
            direction: result.direction,
            messageType: result.messageType,
            messageTimestamp: result.timestamp,
            isNew: result.isNew
          })
        }

        if (result.direction === 'inbound' && result.isNew !== false) {
          // (NOTI-003) Abrir/evaluar la ventana de confirmación de citas antes de
          // disparar automatizaciones/agente: el contacto pudo responder por DM al
          // recordatorio. Si hay ventana activa con bypass, no se disparan.
          const channelForAutomation = socialMessage.platform === 'instagram' ? 'instagram' : 'messenger'
          ;(async () => {
            let confirmWindow = { windowActive: false, bypassAutomations: false }
            await handleInboundForConfirmation({ contactId: result.contactId, text: result.messageText })
              .then(w => { confirmWindow = w })
              .catch(error => {
                logger.warn(`[Citas] Error en ventana de confirmación (DM Meta): ${error.message}`)
              })

            if (!confirmWindow.windowActive) {
              await maybeConfirmAppointmentFromReply({ contactId: result.contactId, text: result.messageText })
                .catch(error => {
                  logger.warn(`[Citas] No se pudo evaluar confirmación automática (DM Meta): ${error.message}`)
                })
            }

            if (confirmWindow.windowActive && confirmWindow.bypassAutomations) return

            // Motor de automatizaciones (import dinámico: evita ciclo)
            import('./automationEngine.js')
              .then(engine => engine.handleIncomingMessage({
                contactId: result.contactId,
                contactName: result.contactName,
                text: result.messageText,
                channel: channelForAutomation,
                referral: socialMessage.referral || null,
                adId: socialMessage.referral?.ad_id || null,
                adReferral: Boolean(socialMessage.referral?.ad_id)
              }))
              .catch(error => {
                logger.warn(`[Automatizaciones] DM Meta no procesado: ${error.message}`)
              })
            import('../agents/conversational/runner.js')
              .then(runner => runner.handleInboundConversationalChatMessage({
                contactId: result.contactId,
                messageId: result.messageId,
                channel: channelForAutomation
              }))
              .catch(error => {
                logger.warn(`[Agente conversacional] DM Meta no atendido: ${error.message}`)
              })
          })().catch(error => {
            logger.warn(`[Citas] Fallo inesperado al procesar inbound DM Meta: ${error.message}`)
          })
          sendChatMessageNotification({
            contactId: result.contactId,
            contactName: result.contactName,
            profileName: result.contactName,
            text: result.messageText,
            messageType: result.messageType,
            mediaUrl: result.mediaUrl || result.media_url || '',
            messageId: result.messageId,
            timestamp: result.timestamp
          }).catch(error => {
            logger.warn(`[Push] No se pudo avisar DM Meta ${result.messageId || ''}: ${error.message}`)
          })
        }
      }

      // --- COMENTARIOS (FB 'feed' item=comment / IG 'comments') ---
      // Llegan en entry.changes[] (no messaging[]). Cada uno en su try/catch para
      // que un comentario problemático nunca tumbe el batch (y no re-procese DMs).
      const changeItems = Array.isArray(entry?.changes) ? entry.changes : []
      for (const change of changeItems) {
        try {
          const deletedPost = extractDeletedPostEvent({ objectType: payload.object, change })
          if (deletedPost) {
            await markSocialPostDeleted(deletedPost).catch(error => {
              logger.warn(`No se pudo marcar publicación eliminada: ${error.message}`)
            })
            continue
          }

          const comment = extractCommentEvent({ objectType: payload.object, entry, change, config: config || {} })
          if (!comment) continue

          if (!commentsEnabledByPlatform.has(comment.platform)) {
            commentsEnabledByPlatform.set(comment.platform, await isMetaSocialCommentsEnabled(comment.platform))
          }
          if (!commentsEnabledByPlatform.get(comment.platform)) {
            skippedMessages += 1
            continue
          }

          if (comment.verb === 'remove' || comment.verb === 'hide') {
            await softRemoveComment(comment).catch(error => {
              logger.warn(`No se pudo marcar comentario eliminado: ${error.message}`)
            })
            continue
          }
          if (comment.isEcho) {
            const savedEcho = await saveOutboundCommentEcho(comment)
            if (savedEcho) {
              results.push({
                messageId: savedEcho.messageId,
                isNew: savedEcho.isNew,
                contactId: savedEcho.contactId,
                platform: savedEcho.platform,
                direction: savedEcho.direction,
                messageType: savedEcho.messageType,
                timestamp: savedEcho.timestamp
              })
            }
            continue
          }

          const commentCredentials = await resolveMetaSocialGraphCredentials(comment.platform, config, { safe: true })
          const commentAuthor = await fetchMetaCommentAuthorProfile({
            platform: comment.platform,
            commentId: comment.commentId,
            authorId: comment.authorId,
            accessToken: commentCredentials.token,
            baseUrl: commentCredentials.baseUrl
          })
          const profile = {
            name: commentAuthor.name || comment.authorName,
            username: commentAuthor.username || comment.authorUsername,
            profilePictureUrl: commentAuthor.profilePictureUrl || '',
            raw: change
          }
          const localContact = await upsertLocalSocialContact({ socialMessage: comment, profile })
          const socialContactId = await upsertMetaSocialContact({ contactId: localContact.id, socialMessage: comment, profile })
          const savedComment = await upsertMetaSocialMessage({ socialContactId, contactId: localContact.id, socialMessage: comment, config })

          if (savedComment.isNew && comment.direction === 'inbound') {
            await captureMetaSocialContactIdentity({ contactId: localContact.id, socialMessage: comment })
          }

          results.push({
            messageId: savedComment.messageId,
            isNew: savedComment.isNew,
            contactId: localContact.id,
            platform: comment.platform,
            direction: comment.direction,
            messageType: 'comment',
            timestamp: comment.messageTimestamp
          })

          if (comment.direction !== 'inbound' || savedComment.isNew) {
            publishChatMessageEvent({
              contactId: localContact.id,
              messageId: savedComment.messageId,
              channel: comment.platform,
              provider: 'meta',
              transport: comment.platform,
              direction: comment.direction,
              messageType: 'comment',
              messageTimestamp: comment.messageTimestamp,
              isNew: savedComment.isNew
            })
          }

          if (comment.direction === 'inbound' && savedComment.isNew !== false) {
            // Cachear el contenido de la publicación comentada (no bloquea el flujo).
            resolveMetaSocialGraphCredentials(comment.platform, config, { safe: true })
              .then(credentials => fetchAndCacheSocialPost(comment, credentials.token, credentials.baseUrl, config))
              .catch(error => logger.warn(`[Comentario] publicación no cacheada: ${error.message}`))

            // Automatizaciones de comentarios: evento AISLADO 'comment-received'.
            // Va por su propio carril (NO handleIncomingMessage), así que las
            // automatizaciones de DM nunca se disparan con comentarios. Sigue SIN push.
            import('./automationEngine.js')
              .then(engine => engine.handleAutomationEvent('comment-received', {
                contactId: localContact.id,
                contactName: localContact.contactName,
                platform: comment.platform === 'instagram' ? 'instagram' : 'facebook',
                messageText: comment.messageText,
                commentId: comment.commentId,
                postId: comment.postId,
                mediaId: comment.mediaId,
                parentCommentId: comment.parentCommentId,
                permalink: comment.permalink
              }))
              .catch(error => {
                logger.warn(`[Automatizaciones] Comentario no procesado: ${error.message}`)
              })

            // Agente conversacional en comentarios: canal aislado
            // 'facebook_comment'/'instagram_comment'. Solo actúa si un agente tiene
            // esa condición de ingreso (matchAgentForMessage devuelve null si no) →
            // barato y sin efecto cuando no hay agente de comentarios configurado.
            const commentAgentChannel = comment.platform === 'instagram' ? 'instagram_comment' : 'facebook_comment'
            import('../agents/conversational/runner.js')
              .then(runner => runner.handleInboundConversationalChatMessage({
                contactId: localContact.id,
                messageId: savedComment.messageId,
                channel: commentAgentChannel,
                postContext: { postId: comment.postId, mediaId: comment.mediaId, permalink: comment.permalink }
              }))
              .catch(error => {
                logger.warn(`[Agente conversacional] Comentario no atendido: ${error.message}`)
              })
          }
        } catch (error) {
          logger.warn(`Comentario Meta no procesado: ${error.message}`)
        }
      }
    }

    const finalStatus = results.length > 0 || skippedMessages === 0 ? 'processed' : 'ignored'
    const finalError = skippedMessages > 0 && results.length === 0
      ? 'Mensajería de Meta apagada en Configuración'
      : null

    await db.run(`
      UPDATE meta_social_webhook_events
      SET processed_status = ?, processed_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [finalStatus, finalError, eventRowId])

    return {
      processed: true,
      eventId: eventRowId,
      messages: results.length,
      skippedMessages,
      results
    }
  } catch (error) {
    await db.run(`
      UPDATE meta_social_webhook_events
      SET processed_status = 'error', processed_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [error.message, eventRowId])
    throw error
  }
}

export {
  META_SIGNATURE_HEADER,
  META_MESSENGER_MESSAGING_ENABLED_KEY,
  META_INSTAGRAM_MESSAGING_ENABLED_KEY
}
