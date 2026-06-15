import crypto from 'crypto'
import fetch from 'node-fetch'
import { db, getAppConfig } from '../config/database.js'
import { API_URLS } from '../config/constants.js'
import { logger } from '../utils/logger.js'
import { getMetaConfig } from './metaAdsService.js'
import { sendChatMessageNotification } from './pushNotificationsService.js'

const DEFAULT_VERIFY_TOKEN = 'ristak-meta-webhook'
const META_SIGNATURE_HEADER = 'x-hub-signature-256'
const META_MESSENGER_MESSAGING_ENABLED_KEY = 'meta_messenger_messaging_enabled'
const META_INSTAGRAM_MESSAGING_ENABLED_KEY = 'meta_instagram_messaging_enabled'

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

async function fetchMetaSenderProfile({ platform, senderId, accessToken }) {
  if (!senderId || !accessToken) return {}

  const fields = platform === 'instagram'
    ? 'id,name,username,profile_pic,profile_picture_url'
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
      postback_payload, message_timestamp, raw_payload_json, referral_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
    safeJson(socialMessage.referral)
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
  const platform = objectType === 'instagram' ? 'instagram' : 'messenger'
  const eventType = firstMessaging?.message
    ? 'message'
    : firstMessaging?.postback
      ? 'postback'
      : firstMessaging?.referral
        ? 'referral'
        : firstMessaging?.reaction
          ? 'reaction'
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
          accessToken: config?.access_token
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

        if (result.direction === 'inbound' && result.isNew !== false) {
          // Motor de automatizaciones (import dinámico: evita ciclo)
          import('./automationEngine.js')
            .then(engine => engine.handleIncomingMessage({
              contactId: result.contactId,
              contactName: result.contactName,
              text: result.messageText,
              channel: socialMessage.platform === 'instagram' ? 'instagram' : 'messenger'
            }))
            .catch(error => {
              logger.warn(`[Automatizaciones] DM Meta no procesado: ${error.message}`)
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
