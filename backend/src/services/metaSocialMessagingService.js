import crypto from 'crypto'
import fetch from 'node-fetch'
import { db, getAppConfig } from '../config/database.js'
import { API_URLS } from '../config/constants.js'
import { logger } from '../utils/logger.js'
import { getMetaConfig } from './metaAdsService.js'
import { sendChatMessageNotification } from './pushNotificationsService.js'
import { publishChatMessageEvent } from './chatLiveEventsService.js'
import { recordInboundChatUnread } from './chatReadStateService.js'
// (NOTI-003) Confirmación de citas por respuesta también para DMs de Messenger/Instagram.
import { maybeConfirmAppointmentFromReply, handleInboundForConfirmation } from './appointmentConfirmationService.js'

const DEFAULT_VERIFY_TOKEN = 'ristak-meta-webhook'
const META_SIGNATURE_HEADER = 'x-hub-signature-256'
const META_MESSENGER_MESSAGING_ENABLED_KEY = 'meta_messenger_messaging_enabled'
const META_INSTAGRAM_MESSAGING_ENABLED_KEY = 'meta_instagram_messaging_enabled'
const META_FACEBOOK_COMMENTS_ENABLED_KEY = 'meta_facebook_comments_enabled'
const META_INSTAGRAM_COMMENTS_ENABLED_KEY = 'meta_instagram_comments_enabled'

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
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

function compactName(...values) {
  return values
    .map(cleanString)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getPlatformLabel(platform) {
  if (platform === 'instagram') return 'Instagram DM'
  return 'Messenger'
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

  if (messaging.message) {
    const attachment = extractAttachment(messaging.message)
    const text = cleanString(messaging.message.text)
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
// que un DM, más campos de comentario. CLAVE: el senderId lleva un prefijo
// sintético ("fb_comment:"/"ig_comment:") para NO colisionar con el PSID de los
// DMs (Meta usa espacios de ID distintos para la misma persona). Los nombres
// vienen en el propio payload, así que no hace falta pedir perfil.
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

  const authorKey = authorId || commentId
  const senderId = `${platform === 'instagram' ? 'ig' : 'fb'}_comment:${authorKey}`

  const text = cleanString(value.message || value.text)
  const rawTs = Number(value.created_time || entry?.time || Date.now())
  const messageTimestamp = Number.isFinite(rawTs)
    ? new Date(rawTs > 9999999999 ? rawTs : rawTs * 1000).toISOString()
    : new Date().toISOString()

  return {
    platform,
    direction,
    senderId,
    recipientId: platform === 'instagram' ? igId : pageId,
    pageId: platform === 'messenger' ? pageId : '',
    instagramAccountId: platform === 'instagram' ? igId : '',
    metaMessageId: commentId, // dedup natural (edits/reenvíos llegan con el mismo id)
    messageType: 'comment',
    messageText: text || '(comentario sin texto)',
    mediaUrl: '',
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
    authorName,
    authorUsername,
    raw: change
  }
}

// Marca (soft) un comentario eliminado sin borrar la fila, para no perder el hilo.
async function softRemoveComment(comment) {
  const messageId = hashId('meta_social_msg', comment.commentId)
  await db.run(
    `UPDATE meta_social_messages
     SET message_text = '(comentario eliminado)', status = 'removed', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [messageId]
  )
}

async function fetchMetaSenderProfile({ platform, senderId, accessToken }) {
  if (!senderId || !accessToken) return {}

  // OJO Instagram: un IGSID NO tiene el campo `profile_picture_url` — pedirlo
  // hace que Meta rechace TODA la petición con (#100) y el perfil vuelve vacío
  // (por eso el DM caía como "Instagram DM 0895…" sin nombre ni foto). Los
  // campos válidos para IG son name,username,profile_pic.
  const fields = platform === 'instagram'
    ? 'name,username,profile_pic'
    : 'id,name,first_name,last_name,profile_pic'

  try {
    const params = new URLSearchParams({
      fields,
      access_token: accessToken
    })
    const response = await fetch(`${API_URLS.META_GRAPH}/${encodeURIComponent(senderId)}?${params.toString()}`)
    const data = await response.json()

    if (data.error) {
      logger.warn(`Meta no dejo leer perfil ${platform} ${senderId}: ${data.error.message}`)
      return {}
    }

    return {
      name: compactName(data.name) || compactName(data.first_name, data.last_name),
      username: cleanString(data.username),
      profilePictureUrl: cleanString(data.profile_picture_url || data.profile_pic),
      raw: data
    }
  } catch (error) {
    logger.warn(`No se pudo leer perfil ${platform} ${senderId}: ${error.message}`)
    return {}
  }
}

function getFallbackContactName(platform, senderId) {
  const suffix = cleanString(senderId).slice(-6)
  return suffix ? `${getPlatformLabel(platform)} ${suffix}` : getPlatformLabel(platform)
}

function createMetaSocialMessageError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

async function metaSocialGraphRequest(path, { method = 'GET', token, query, body } = {}) {
  const cleanToken = cleanString(token)
  if (!cleanToken) throw createMetaSocialMessageError('Meta no está conectado', 409)

  const url = new URL(`${API_URLS.META_GRAPH}${path}`)
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  })

  const response = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${cleanToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw createMetaSocialMessageError(data?.error?.message || `Meta Graph respondió ${response.status}`, response.status)
  }

  return data
}

// Campos de webhook de la Página que Ristak sabe procesar (ver
// processMetaSocialWebhook: message, postback, reaction, referral). Los mismos
// campos cubren Messenger e Instagram DM, porque el IG va enlazado a la Página.
// messaging_* para DMs; feed = comentarios de la Página de Facebook. Los
// comentarios de Instagram NO son campo de la Página: llegan por el objeto
// 'instagram' (comments/live_comments) suscrito a nivel de app en el panel de Meta.
const META_PAGE_SUBSCRIBED_FIELDS = 'messages,messaging_postbacks,message_reactions,messaging_referrals,feed'

// El token guardado en meta_config es un token de USUARIO. Para operar la Página
// (suscribir webhooks, enviar DMs, leer perfiles) Meta exige un token de PÁGINA.
// Lo derivamos on-demand desde el token de usuario y lo cacheamos en memoria:
// un token de Página derivado de un token de usuario de larga duración no expira
// mientras el de usuario siga vivo, así que cachearlo es seguro y evita una
// llamada extra por cada mensaje. Ante un 190 (token inválido) se re-deriva.
const PAGE_TOKEN_TTL_MS = 30 * 60 * 1000
let pageTokenCache = { pageId: '', token: '', at: 0 }

export async function resolveMetaPageAccessToken({ config, forceRefresh = false } = {}) {
  const cfg = config || await getMetaConfig().catch(() => null)
  const pageId = cleanString(cfg?.page_id)
  const userToken = cleanString(cfg?.access_token)
  if (!pageId) throw createMetaSocialMessageError('Falta seleccionar la Página de Facebook en Meta Ads.', 409)
  if (!userToken) throw createMetaSocialMessageError('Conecta Meta Ads para operar Messenger/Instagram.', 409)

  const now = Date.now()
  if (
    !forceRefresh &&
    pageTokenCache.token &&
    pageTokenCache.pageId === pageId &&
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

  pageTokenCache = { pageId, token: pageToken, at: now }
  return pageToken
}

// Devuelve el mejor token disponible para leer/enviar por la Página, cayendo al
// token de usuario si por alguna razón no se puede derivar el de Página (para no
// romper el flujo de recepción por un fallo transitorio de derivación).
async function resolveMetaPageTokenSafe(config) {
  return resolveMetaPageAccessToken({ config }).catch(error => {
    logger.warn(`No se pudo derivar token de Página, usando token base: ${error.message}`)
    return cleanString(config?.access_token)
  })
}

/**
 * Suscribe la Página de Facebook al webhook de la app (subscribed_apps).
 * Este es el paso que le dice a Meta "mándame los mensajes de esta Página".
 * Activar el toggle en Ristak NO basta: sin esta suscripción Meta nunca llama al
 * webhook. Es idempotente: se puede llamar cuantas veces se quiera.
 */
export async function ensureMetaPageMessagingSubscription() {
  const config = await getMetaConfig().catch(() => null)
  const pageId = cleanString(config?.page_id)
  if (!pageId) throw createMetaSocialMessageError('Falta seleccionar la Página de Facebook en Meta Ads.', 409)

  const pageToken = await resolveMetaPageAccessToken({ config })
  await metaSocialGraphRequest(`/${encodeURIComponent(pageId)}/subscribed_apps`, {
    method: 'POST',
    token: pageToken,
    query: { subscribed_fields: META_PAGE_SUBSCRIBED_FIELDS }
  })

  logger.info(`[Meta social] Página ${pageId} suscrita al webhook de mensajería (${META_PAGE_SUBSCRIBED_FIELDS})`)
  return { pageId, subscribedFields: META_PAGE_SUBSCRIBED_FIELDS.split(',') }
}

/** Lee la suscripción actual de la Página (para verificar/diagnosticar). */
export async function getMetaPageMessagingSubscription() {
  const config = await getMetaConfig().catch(() => null)
  const pageId = cleanString(config?.page_id)
  if (!pageId) return { pageId: '', subscribed: false, apps: [] }

  const pageToken = await resolveMetaPageAccessToken({ config })
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

async function saveMetaSocialOutboundMessage({ platform, contactId, profile, messageId, text, response, externalId }) {
  const now = new Date().toISOString()
  const cleanPlatform = platform === 'instagram' ? 'instagram' : 'messenger'
  const remoteMessageId = cleanString(
    messageId ||
    response?.message_id ||
    response?.recipient_id ||
    response?.id ||
    externalId
  )
  const localMessageId = hashId(
    'meta_social_msg',
    remoteMessageId
      ? `${cleanPlatform}:${remoteMessageId}:outbound`
      : `${cleanPlatform}:${contactId}:${text}:${now}`
  )
  const rawPayload = safeJson({
    provider: 'meta',
    platform: cleanPlatform,
    response
  })

  await db.run(`
    INSERT INTO meta_social_messages (
      id, platform, meta_message_id, meta_social_contact_id, contact_id,
      sender_id, recipient_id, page_id, instagram_account_id,
      direction, status, message_type, message_text,
      postback_payload, message_timestamp, raw_payload_json, referral_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      meta_social_contact_id = COALESCE(excluded.meta_social_contact_id, meta_social_messages.meta_social_contact_id),
      contact_id = COALESCE(excluded.contact_id, meta_social_messages.contact_id),
      sender_id = COALESCE(NULLIF(excluded.sender_id, ''), meta_social_messages.sender_id),
      recipient_id = COALESCE(NULLIF(excluded.recipient_id, ''), meta_social_messages.recipient_id),
      page_id = COALESCE(NULLIF(excluded.page_id, ''), meta_social_messages.page_id),
      instagram_account_id = COALESCE(NULLIF(excluded.instagram_account_id, ''), meta_social_messages.instagram_account_id),
      direction = COALESCE(NULLIF(excluded.direction, ''), meta_social_messages.direction),
      status = COALESCE(NULLIF(excluded.status, ''), meta_social_messages.status),
      message_type = COALESCE(NULLIF(excluded.message_type, ''), meta_social_messages.message_type),
      message_text = COALESCE(NULLIF(excluded.message_text, ''), meta_social_messages.message_text),
      message_timestamp = COALESCE(excluded.message_timestamp, meta_social_messages.message_timestamp),
      raw_payload_json = excluded.raw_payload_json,
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
    'text',
    text,
    null,
    now,
    rawPayload,
    null
  ])

  publishChatMessageEvent({
    contactId,
    messageId: localMessageId,
    channel: cleanPlatform,
    provider: 'meta',
    transport: cleanPlatform,
    direction: 'outbound',
    messageType: 'text',
    messageTimestamp: now,
    isNew: true
  })

  return {
    localMessageId,
    status: 'sent',
    transport: cleanPlatform,
    channel: cleanPlatform,
    remoteMessageId: remoteMessageId || null
  }
}

export async function sendMetaSocialTextMessage({ contactId, platform, message, externalId } = {}) {
  const cleanContactId = cleanString(contactId)
  const cleanPlatform = cleanString(platform).toLowerCase() === 'instagram' ? 'instagram' : 'messenger'
  const body = cleanString(message)

  if (!cleanContactId) throw createMetaSocialMessageError('Falta el contacto', 400)
  if (!body) throw createMetaSocialMessageError('Falta el texto del mensaje', 400)

  const enabled = await isMetaSocialMessagingEnabled(cleanPlatform)
  if (!enabled) {
    throw createMetaSocialMessageError(`Activa ${getPlatformLabel(cleanPlatform)} en Configuración > Meta Ads para responder por este canal.`, 409)
  }

  const config = await getMetaConfig().catch(error => {
    logger.warn(`No se pudo leer Meta para enviar DM: ${error.message}`)
    return null
  })
  if (!config?.access_token) {
    throw createMetaSocialMessageError('Conecta Meta Ads para responder por Messenger o Instagram.', 409)
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

  // Messenger/Instagram exigen el token de PÁGINA para /{id}/messages (el token
  // de usuario da "se necesita un token de acceso a la página"). Lo derivamos y,
  // si caducó/rotó, lo re-derivamos una vez y reintentamos.
  const sendPayload = {
    messaging_type: 'RESPONSE',
    recipient: { id: recipientId },
    message: { text: body }
  }
  let response
  try {
    response = await metaSocialGraphRequest(`/${encodeURIComponent(businessId)}/messages`, {
      method: 'POST',
      token: await resolveMetaPageAccessToken({ config }),
      body: sendPayload
    })
  } catch (error) {
    const looksLikeTokenIssue = error?.statusCode === 401 || /oauth|access token|\b190\b/i.test(error?.message || '')
    if (!looksLikeTokenIssue) throw error
    response = await metaSocialGraphRequest(`/${encodeURIComponent(businessId)}/messages`, {
      method: 'POST',
      token: await resolveMetaPageAccessToken({ config, forceRefresh: true }),
      body: sendPayload
    })
  }

  const sent = await saveMetaSocialOutboundMessage({
    platform: cleanPlatform,
    contactId: cleanContactId,
    profile,
    messageId: response?.message_id || response?.id,
    text: body,
    response,
    externalId
  })

  return {
    ...sent,
    id: sent.remoteMessageId || sent.localMessageId,
    platform: cleanPlatform,
    provider: 'meta',
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

  await db.run(`
    INSERT INTO contacts (
      id, full_name, first_name, source,
      attribution_session_source, attribution_medium, custom_fields,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ${customFieldsPlaceholder}, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE SET
      full_name = COALESCE(NULLIF(contacts.full_name, ''), excluded.full_name),
      first_name = COALESCE(NULLIF(contacts.first_name, ''), excluded.first_name),
      source = COALESCE(NULLIF(contacts.source, ''), excluded.source),
      attribution_session_source = COALESCE(NULLIF(contacts.attribution_session_source, ''), excluded.attribution_session_source),
      attribution_medium = COALESCE(NULLIF(contacts.attribution_medium, ''), excluded.attribution_medium),
      custom_fields = COALESCE(contacts.custom_fields, excluded.custom_fields),
      updated_at = CURRENT_TIMESTAMP
  `, [
    contactId,
    contactName,
    contactName,
    platformLabel,
    socialMessage.platform,
    'dm',
    customFieldsValue,
    socialMessage.messageTimestamp
  ])

  return {
    id: contactId,
    contactName
  }
}

async function upsertMetaSocialContact({ contactId, socialMessage, profile }) {
  const socialContactId = hashId('meta_social_profile', `${socialMessage.platform}:${socialMessage.senderId}`)

  await db.run(`
    INSERT INTO meta_social_contacts (
      id, contact_id, platform, sender_id, recipient_id, page_id, instagram_account_id,
      profile_name, username, profile_picture_url, raw_profile_json,
      first_seen_at, last_seen_at, message_count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(platform, sender_id) DO UPDATE SET
      contact_id = COALESCE(excluded.contact_id, meta_social_contacts.contact_id),
      recipient_id = COALESCE(NULLIF(excluded.recipient_id, ''), meta_social_contacts.recipient_id),
      page_id = COALESCE(NULLIF(excluded.page_id, ''), meta_social_contacts.page_id),
      instagram_account_id = COALESCE(NULLIF(excluded.instagram_account_id, ''), meta_social_contacts.instagram_account_id),
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
      message_count = meta_social_contacts.message_count + 1,
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
    profile.profilePictureUrl || null,
    safeJson(profile.raw || null),
    socialMessage.messageTimestamp,
    socialMessage.messageTimestamp
  ])

  return socialContactId
}

async function upsertMetaSocialMessage({ socialContactId, contactId, socialMessage }) {
  const messageId = hashId(
    'meta_social_msg',
    socialMessage.metaMessageId ||
      `${socialMessage.platform}:${socialMessage.senderId}:${socialMessage.messageTimestamp}:${socialMessage.messageText}:${socialMessage.messageType}`
  )
  const existing = await db.get('SELECT id FROM meta_social_messages WHERE id = ?', [messageId]).catch(() => null)

  await db.run(`
    INSERT INTO meta_social_messages (
      id, platform, meta_message_id, meta_social_contact_id, contact_id,
      sender_id, recipient_id, page_id, instagram_account_id,
      direction, message_type, message_text, media_url, media_mime_type,
      postback_payload, message_timestamp, raw_payload_json, referral_json,
      comment_id, post_id, parent_comment_id, media_id, permalink, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      meta_social_contact_id = COALESCE(excluded.meta_social_contact_id, meta_social_messages.meta_social_contact_id),
      contact_id = COALESCE(excluded.contact_id, meta_social_messages.contact_id),
      sender_id = COALESCE(NULLIF(excluded.sender_id, ''), meta_social_messages.sender_id),
      recipient_id = COALESCE(NULLIF(excluded.recipient_id, ''), meta_social_messages.recipient_id),
      page_id = COALESCE(NULLIF(excluded.page_id, ''), meta_social_messages.page_id),
      instagram_account_id = COALESCE(NULLIF(excluded.instagram_account_id, ''), meta_social_messages.instagram_account_id),
      direction = COALESCE(NULLIF(excluded.direction, ''), meta_social_messages.direction),
      message_type = COALESCE(NULLIF(excluded.message_type, ''), meta_social_messages.message_type),
      message_text = COALESCE(NULLIF(excluded.message_text, ''), meta_social_messages.message_text),
      media_url = COALESCE(NULLIF(excluded.media_url, ''), meta_social_messages.media_url),
      media_mime_type = COALESCE(NULLIF(excluded.media_mime_type, ''), meta_social_messages.media_mime_type),
      postback_payload = COALESCE(NULLIF(excluded.postback_payload, ''), meta_social_messages.postback_payload),
      message_timestamp = COALESCE(excluded.message_timestamp, meta_social_messages.message_timestamp),
      raw_payload_json = excluded.raw_payload_json,
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
    socialMessage.messageType || 'message',
    socialMessage.messageText || null,
    socialMessage.mediaUrl || null,
    socialMessage.mediaMimeType || null,
    socialMessage.postbackPayload || null,
    socialMessage.messageTimestamp,
    safeJson(socialMessage.raw),
    safeJson(socialMessage.referral),
    socialMessage.commentId || null,
    socialMessage.postId || null,
    socialMessage.parentCommentId || null,
    socialMessage.mediaId || null,
    socialMessage.permalink || null
  ])

  return {
    messageId,
    isNew: !existing
  }
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
    ? 'message'
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

export async function processMetaSocialWebhook({ payload = {}, rawBody = '', signatureHeader = '' } = {}) {
  const config = await getMetaConfig().catch(error => {
    logger.warn(`No se pudo leer configuración Meta para webhook social: ${error.message}`)
    return null
  })
  const signatureValid = verifyMetaWebhookSignature({
    rawBody,
    signatureHeader,
    appSecret: config?.app_secret
  })

  if (signatureValid === false) {
    await saveWebhookEvent({
      payload,
      rawBody,
      signatureValid,
      processedStatus: 'rejected',
      processedError: 'Firma de Meta inválida'
    })
    const error = new Error('Firma de Meta inválida')
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

        const profile = await fetchMetaSenderProfile({
          platform: socialMessage.platform,
          senderId: socialMessage.senderId,
          accessToken: await resolveMetaPageTokenSafe(config)
        })
        const localContact = await upsertLocalSocialContact({ socialMessage, profile })
        const socialContactId = await upsertMetaSocialContact({
          contactId: localContact.id,
          socialMessage,
          profile
        })
        const savedMessage = await upsertMetaSocialMessage({
          socialContactId,
          contactId: localContact.id,
          socialMessage
        })

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

        if (result.direction === 'inbound' && result.isNew !== false) {
          recordInboundChatUnread({
            contactId: result.contactId,
            messageTimestamp: result.timestamp
          }).catch(error => {
            logger.warn(`[Chat Read State] No se pudo incrementar unread ${result.platform} ${result.messageId}: ${error.message}`)
          })
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
                channel: channelForAutomation
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
          const comment = extractCommentEvent({ objectType: payload.object, entry, change, config: config || {} })
          if (!comment) continue

          if (!commentsEnabledByPlatform.has(comment.platform)) {
            commentsEnabledByPlatform.set(comment.platform, await isMetaSocialCommentsEnabled(comment.platform))
          }
          if (!commentsEnabledByPlatform.get(comment.platform)) {
            skippedMessages += 1
            continue
          }

          if (comment.isEcho) continue // nuestra propia respuesta pública → no re-procesar (anti-loop)
          if (comment.verb === 'remove' || comment.verb === 'hide') {
            await softRemoveComment(comment).catch(error => {
              logger.warn(`No se pudo marcar comentario eliminado: ${error.message}`)
            })
            continue
          }

          const profile = { name: comment.authorName, username: comment.authorUsername, raw: change }
          const localContact = await upsertLocalSocialContact({ socialMessage: comment, profile })
          const socialContactId = await upsertMetaSocialContact({ contactId: localContact.id, socialMessage: comment, profile })
          const savedComment = await upsertMetaSocialMessage({ socialContactId, contactId: localContact.id, socialMessage: comment })

          results.push({
            messageId: savedComment.messageId,
            isNew: savedComment.isNew,
            contactId: localContact.id,
            platform: comment.platform,
            direction: comment.direction,
            messageType: 'comment',
            timestamp: comment.messageTimestamp
          })

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

          if (comment.direction === 'inbound' && savedComment.isNew !== false) {
            recordInboundChatUnread({ contactId: localContact.id, messageTimestamp: comment.messageTimestamp })
              .catch(error => {
                logger.warn(`[Chat Read State] No se pudo incrementar unread de comentario: ${error.message}`)
              })
          }
          // v1: comentarios SIN push, SIN automatizaciones, SIN agente conversacional
          // (auto-responder comentarios públicos es riesgo de spam/política de Meta).
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
