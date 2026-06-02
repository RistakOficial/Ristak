import crypto from 'crypto'
import fetch from 'node-fetch'
import { db } from '../config/database.js'
import { getMetaApiVersion } from '../config/constants.js'
import { decrypt, encrypt, isEncrypted } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'

const DEFAULT_CONNECTION_STATUS = 'not_configured'
const COEXISTENCE_FEATURE_TYPE = 'whatsapp_business_app_onboarding'
const COEXISTENCE_FINISH_EVENT = 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'

function normalizeString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function nullableString(value) {
  const normalized = normalizeString(value)
  return normalized || null
}

function normalizeGraphVersion(value) {
  const normalized = normalizeString(value || getMetaApiVersion() || 'v23.0')
  if (!normalized) return 'v23.0'
  return normalized.startsWith('v') ? normalized : `v${normalized}`
}

function graphBase(version) {
  return `https://graph.facebook.com/${normalizeGraphVersion(version)}`
}

function safeJsonStringify(value) {
  if (value === null || value === undefined) return null
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ serialization_error: true })
  }
}

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function encryptSecret(value, previousValue = null) {
  const normalized = normalizeString(value)
  if (!normalized || normalized.startsWith('***')) return previousValue || null
  return isEncrypted(normalized) ? normalized : encrypt(normalized)
}

function decryptSecret(value) {
  if (!value) return null
  return isEncrypted(value) ? decrypt(value) : value
}

function maskSecret(value) {
  if (!value) return ''
  let plain = ''
  try {
    plain = decryptSecret(value) || ''
  } catch {
    plain = ''
  }

  if (!plain) return '***'
  return `***${plain.slice(-4)}`
}

function asBooleanInteger(value) {
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0
}

function unixSecondsToIso(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000).toISOString()
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex')
}

function isConnectedPhone(phone = {}) {
  return phone.is_on_biz_app === true || phone.is_on_biz_app === 1 || phone.platform_type === 'CLOUD_API'
}

function getSessionData(sessionPayload = {}) {
  return sessionPayload?.data && typeof sessionPayload.data === 'object'
    ? sessionPayload.data
    : {}
}

function getSessionWabaId(sessionPayload = {}) {
  const data = getSessionData(sessionPayload)
  return nullableString(
    data.waba_id ||
    data.whatsapp_business_account_id ||
    data.business_account_id ||
    sessionPayload.waba_id
  )
}

function getSessionPhoneNumberId(sessionPayload = {}) {
  const data = getSessionData(sessionPayload)
  return nullableString(
    data.phone_number_id ||
    data.whatsapp_business_phone_number_id ||
    data.business_phone_number_id ||
    sessionPayload.phone_number_id
  )
}

function getSessionId(sessionPayload = {}) {
  const data = getSessionData(sessionPayload)
  return nullableString(data.session_id || sessionPayload.session_id)
}

function getConfigStatus(row = {}) {
  if (row.connection_status) return row.connection_status
  if (row.business_token && row.waba_id && row.phone_number_id) return 'connected'
  if (row.app_id && row.app_secret && row.embedded_signup_config_id) return 'ready_to_connect'
  return DEFAULT_CONNECTION_STATUS
}

function sanitizeConfig(row) {
  if (!row) {
    return {
      configured: false,
      connectionStatus: DEFAULT_CONNECTION_STATUS,
      coexistenceFeatureType: COEXISTENCE_FEATURE_TYPE,
      finishEvent: COEXISTENCE_FINISH_EVENT,
      graphApiVersion: normalizeGraphVersion()
    }
  }

  return {
    configured: Boolean(row.app_id && row.app_secret && row.embedded_signup_config_id),
    id: row.id,
    appId: row.app_id || '',
    appSecret: row.app_secret ? maskSecret(row.app_secret) : '',
    appSecretConfigured: Boolean(row.app_secret),
    embeddedSignupConfigId: row.embedded_signup_config_id || '',
    graphApiVersion: normalizeGraphVersion(getMetaApiVersion()),
    webhookVerifyToken: row.webhook_verify_token ? decryptSecret(row.webhook_verify_token) || '' : '',
    webhookVerifyTokenConfigured: Boolean(row.webhook_verify_token),
    callbackUrl: row.callback_url || '',
    businessToken: row.business_token ? maskSecret(row.business_token) : '',
    businessTokenConfigured: Boolean(row.business_token),
    wabaId: row.waba_id || '',
    phoneNumberId: row.phone_number_id || '',
    displayPhoneNumber: row.display_phone_number || '',
    verifiedName: row.verified_name || '',
    qualityRating: row.quality_rating || '',
    platformType: row.platform_type || '',
    isOnBizApp: Boolean(row.is_on_biz_app),
    connectionStatus: getConfigStatus(row),
    onboardingEvent: row.onboarding_event || '',
    connectedAt: row.connected_at || null,
    lastExchangeAt: row.last_exchange_at || null,
    lastVerifiedAt: row.last_verified_at || null,
    metadata: safeJsonParse(row.metadata, {}),
    coexistenceFeatureType: COEXISTENCE_FEATURE_TYPE,
    finishEvent: COEXISTENCE_FINISH_EVENT
  }
}

async function getRawConfig() {
  return await db.get('SELECT * FROM whatsapp_api_config ORDER BY id DESC LIMIT 1')
}

async function getRawConfigById(id) {
  if (!id) return getRawConfig()
  return await db.get('SELECT * FROM whatsapp_api_config WHERE id = ? LIMIT 1', [id])
}

async function insertConfig(payload) {
  await db.run(
    `INSERT INTO whatsapp_api_config (
      app_id, app_secret, embedded_signup_config_id, graph_api_version,
      webhook_verify_token, callback_url, connection_status, metadata,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      payload.app_id,
      payload.app_secret,
      payload.embedded_signup_config_id,
      payload.graph_api_version,
      payload.webhook_verify_token,
      payload.callback_url,
      payload.connection_status,
      payload.metadata
    ]
  )

  return getRawConfig()
}

async function updateConfig(id, updates) {
  await db.run(
    `UPDATE whatsapp_api_config
     SET app_id = ?,
         app_secret = ?,
         embedded_signup_config_id = ?,
         graph_api_version = ?,
         webhook_verify_token = ?,
         callback_url = ?,
         connection_status = ?,
         metadata = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      updates.app_id,
      updates.app_secret,
      updates.embedded_signup_config_id,
      updates.graph_api_version,
      updates.webhook_verify_token,
      updates.callback_url,
      updates.connection_status,
      updates.metadata,
      id
    ]
  )

  return getRawConfigById(id)
}

export async function getWhatsAppConfig() {
  return sanitizeConfig(await getRawConfig())
}

export async function saveWhatsAppConfig(input = {}) {
  const existing = await getRawConfig()
  const appId = nullableString(input.appId ?? input.app_id ?? existing?.app_id)
  const embeddedSignupConfigId = nullableString(
    input.embeddedSignupConfigId ??
    input.embedded_signup_config_id ??
    existing?.embedded_signup_config_id
  )
  const graphApiVersion = normalizeGraphVersion(getMetaApiVersion())
  const appSecret = encryptSecret(input.appSecret ?? input.app_secret, existing?.app_secret)
  const webhookVerifyToken = encryptSecret(input.webhookVerifyToken ?? input.webhook_verify_token, existing?.webhook_verify_token)
  const callbackUrl = nullableString(input.callbackUrl ?? input.callback_url ?? existing?.callback_url)
  const metadata = {
    ...(safeJsonParse(existing?.metadata, {}) || {}),
    docs: {
      embeddedSignup: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation',
      coexistence: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users'
    }
  }

  const nextStatus = existing?.business_token
    ? getConfigStatus(existing)
    : appId && appSecret && embeddedSignupConfigId
      ? 'ready_to_connect'
      : DEFAULT_CONNECTION_STATUS

  const payload = {
    app_id: appId,
    app_secret: appSecret,
    embedded_signup_config_id: embeddedSignupConfigId,
    graph_api_version: graphApiVersion,
    webhook_verify_token: webhookVerifyToken,
    callback_url: callbackUrl,
    connection_status: nextStatus,
    metadata: safeJsonStringify(metadata)
  }

  const saved = existing
    ? await updateConfig(existing.id, payload)
    : await insertConfig(payload)

  return sanitizeConfig(saved)
}

async function exchangeCodeForBusinessToken(config, code) {
  const appSecret = decryptSecret(config.app_secret)
  const params = new URLSearchParams({
    client_id: config.app_id,
    client_secret: appSecret,
    code
  })

  const response = await fetch(`${graphBase(config.graph_api_version)}/oauth/access_token?${params.toString()}`)
  const data = await response.json()

  if (!response.ok || data.error) {
    const message = data?.error?.message || `Meta token exchange failed (${response.status})`
    const error = new Error(message)
    error.meta = data
    throw error
  }

  return data
}

async function subscribeWabaToWebhooks({ wabaId, businessToken, graphApiVersion }) {
  if (!wabaId || !businessToken) return null

  const params = new URLSearchParams({ access_token: businessToken })
  const response = await fetch(`${graphBase(graphApiVersion)}/${encodeURIComponent(wabaId)}/subscribed_apps?${params.toString()}`, {
    method: 'POST'
  })
  const data = await response.json()

  if (!response.ok || data.error) {
    const message = data?.error?.message || `Meta WABA subscription failed (${response.status})`
    const error = new Error(message)
    error.meta = data
    throw error
  }

  return data
}

async function fetchPhoneNumber({ phoneNumberId, businessToken, graphApiVersion }) {
  if (!phoneNumberId || !businessToken) return null

  const params = new URLSearchParams({
    fields: [
      'id',
      'display_phone_number',
      'verified_name',
      'quality_rating',
      'code_verification_status',
      'platform_type',
      'is_on_biz_app'
    ].join(','),
    access_token: businessToken
  })

  const response = await fetch(`${graphBase(graphApiVersion)}/${encodeURIComponent(phoneNumberId)}?${params.toString()}`)
  const data = await response.json()

  if (!response.ok || data.error) {
    const message = data?.error?.message || `Meta phone number lookup failed (${response.status})`
    const error = new Error(message)
    error.meta = data
    throw error
  }

  return data
}

async function fetchWabaPhoneNumbers({ wabaId, businessToken, graphApiVersion }) {
  if (!wabaId || !businessToken) return []

  const params = new URLSearchParams({
    fields: [
      'id',
      'display_phone_number',
      'verified_name',
      'quality_rating',
      'code_verification_status',
      'platform_type',
      'is_on_biz_app'
    ].join(','),
    access_token: businessToken
  })

  const response = await fetch(`${graphBase(graphApiVersion)}/${encodeURIComponent(wabaId)}/phone_numbers?${params.toString()}`)
  const data = await response.json()

  if (!response.ok || data.error) {
    const message = data?.error?.message || `Meta WABA phone numbers lookup failed (${response.status})`
    const error = new Error(message)
    error.meta = data
    throw error
  }

  return Array.isArray(data?.data) ? data.data : []
}

async function upsertPhoneNumber({ configId, wabaId, phone = {} }) {
  const phoneNumberId = nullableString(phone.id || phone.phone_number_id)
  if (!phoneNumberId) return null

  await db.run(
    `INSERT INTO whatsapp_phone_numbers (
      config_id, waba_id, phone_number_id, display_phone_number, verified_name,
      quality_rating, code_verification_status, name_status, platform_type,
      is_on_biz_app, throughput_level, status, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(phone_number_id) DO UPDATE SET
      config_id = excluded.config_id,
      waba_id = excluded.waba_id,
      display_phone_number = excluded.display_phone_number,
      verified_name = excluded.verified_name,
      quality_rating = excluded.quality_rating,
      code_verification_status = excluded.code_verification_status,
      name_status = excluded.name_status,
      platform_type = excluded.platform_type,
      is_on_biz_app = excluded.is_on_biz_app,
      throughput_level = excluded.throughput_level,
      status = excluded.status,
      metadata = excluded.metadata,
      updated_at = CURRENT_TIMESTAMP`,
    [
      configId,
      nullableString(wabaId),
      phoneNumberId,
      nullableString(phone.display_phone_number),
      nullableString(phone.verified_name),
      nullableString(phone.quality_rating),
      nullableString(phone.code_verification_status),
      nullableString(phone.name_status),
      nullableString(phone.platform_type),
      asBooleanInteger(phone.is_on_biz_app),
      nullableString(phone.throughput?.level || phone.throughput_level),
      nullableString(phone.status),
      safeJsonStringify(phone)
    ]
  )

  return await db.get('SELECT * FROM whatsapp_phone_numbers WHERE phone_number_id = ? LIMIT 1', [phoneNumberId])
}

async function persistOnboardingSession({ code, sessionPayload, responsePayload }) {
  const sessionData = getSessionData(sessionPayload)
  const event = nullableString(sessionPayload?.event || responsePayload?.event)

  await db.run(
    `INSERT INTO whatsapp_onboarding_sessions (
      event, session_id, code, waba_id, phone_number_id, current_step,
      error_code, error_message, raw_payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      event,
      getSessionId(sessionPayload),
      code ? encryptSecret(code) : null,
      getSessionWabaId(sessionPayload),
      getSessionPhoneNumberId(sessionPayload),
      nullableString(sessionData.current_step),
      nullableString(sessionData.error_code),
      nullableString(sessionData.error_message),
      safeJsonStringify({ sessionPayload, responsePayload })
    ]
  )
}

async function updateConfigAfterOnboarding({
  config,
  businessToken,
  tokenResponse,
  sessionPayload,
  responsePayload,
  subscriptionResponse,
  phone,
  phoneNumbers
}) {
  const selectedPhone = phone || phoneNumbers?.find(isConnectedPhone) || phoneNumbers?.[0] || null
  const wabaId = getSessionWabaId(sessionPayload) || config.waba_id
  const phoneNumberId = selectedPhone?.id || getSessionPhoneNumberId(sessionPayload) || config.phone_number_id
  const connected = Boolean(businessToken && wabaId && phoneNumberId)
  const onBizApp = selectedPhone ? asBooleanInteger(selectedPhone.is_on_biz_app) : asBooleanInteger(config.is_on_biz_app)
  const platformType = selectedPhone?.platform_type || config.platform_type || null

  await db.run(
    `UPDATE whatsapp_api_config
     SET business_token = ?,
         business_token_expires_at = ?,
         waba_id = ?,
         phone_number_id = ?,
         display_phone_number = ?,
         verified_name = ?,
         quality_rating = ?,
         platform_type = ?,
         is_on_biz_app = ?,
         connection_status = ?,
         onboarding_event = ?,
         last_session_payload = ?,
         last_error_payload = NULL,
         metadata = ?,
         connected_at = CASE WHEN ? = 1 THEN COALESCE(connected_at, CURRENT_TIMESTAMP) ELSE connected_at END,
         last_exchange_at = CURRENT_TIMESTAMP,
         last_verified_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_verified_at END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      encryptSecret(businessToken),
      tokenResponse?.expires_in ? new Date(Date.now() + Number(tokenResponse.expires_in) * 1000).toISOString() : null,
      nullableString(wabaId),
      nullableString(phoneNumberId),
      nullableString(selectedPhone?.display_phone_number),
      nullableString(selectedPhone?.verified_name),
      nullableString(selectedPhone?.quality_rating),
      nullableString(platformType),
      onBizApp,
      connected ? 'connected' : 'token_exchanged',
      nullableString(sessionPayload?.event || COEXISTENCE_FINISH_EVENT),
      safeJsonStringify(sessionPayload),
      safeJsonStringify({
        token_type: tokenResponse?.token_type || null,
        subscription: subscriptionResponse || null,
        phoneNumbers: phoneNumbers || [],
        responsePayload: responsePayload || null,
        coexistenceFeatureType: COEXISTENCE_FEATURE_TYPE
      }),
      connected ? 1 : 0,
      selectedPhone ? 1 : 0,
      config.id
    ]
  )

  if (selectedPhone?.id) {
    await upsertPhoneNumber({ configId: config.id, wabaId, phone: selectedPhone })
  }

  if (Array.isArray(phoneNumbers)) {
    for (const phoneNumber of phoneNumbers) {
      await upsertPhoneNumber({ configId: config.id, wabaId, phone: phoneNumber })
    }
  }

  return await getRawConfigById(config.id)
}

export async function completeEmbeddedSignup({ code, sessionPayload = {}, responsePayload = {} }) {
  const config = await getRawConfig()
  if (!config?.app_id || !config?.app_secret || !config?.embedded_signup_config_id) {
    throw new Error('Configura App ID, App Secret y Configuration ID antes de conectar WhatsApp')
  }

  await persistOnboardingSession({ code, sessionPayload, responsePayload })

  if (!code) {
    await db.run(
      `UPDATE whatsapp_api_config
       SET last_session_payload = ?,
           last_error_payload = ?,
           onboarding_event = ?,
           connection_status = CASE WHEN connection_status = 'connected' THEN connection_status ELSE 'signup_event_received' END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        safeJsonStringify(sessionPayload),
        sessionPayload?.event === 'CANCEL' ? safeJsonStringify(sessionPayload) : null,
        nullableString(sessionPayload?.event),
        config.id
      ]
    )

    return sanitizeConfig(await getRawConfigById(config.id))
  }

  const wabaId = getSessionWabaId(sessionPayload) || nullableString(responsePayload?.waba_id) || config.waba_id
  const sessionPhoneNumberId = getSessionPhoneNumberId(sessionPayload) || nullableString(responsePayload?.phone_number_id)
  const tokenResponse = await exchangeCodeForBusinessToken(config, code)
  const businessToken = tokenResponse.access_token

  let subscriptionResponse = null
  if (wabaId) {
    subscriptionResponse = await subscribeWabaToWebhooks({
      wabaId,
      businessToken,
      graphApiVersion: config.graph_api_version
    })
  }

  let phone = null
  let phoneNumbers = []
  if (sessionPhoneNumberId) {
    phone = await fetchPhoneNumber({
      phoneNumberId: sessionPhoneNumberId,
      businessToken,
      graphApiVersion: config.graph_api_version
    })
  }

  if (wabaId) {
    phoneNumbers = await fetchWabaPhoneNumbers({
      wabaId,
      businessToken,
      graphApiVersion: config.graph_api_version
    })
  }

  const saved = await updateConfigAfterOnboarding({
    config,
    businessToken,
    tokenResponse,
    sessionPayload: {
      ...sessionPayload,
      data: {
        ...getSessionData(sessionPayload),
        waba_id: wabaId,
        phone_number_id: sessionPhoneNumberId
      }
    },
    responsePayload,
    subscriptionResponse,
    phone,
    phoneNumbers
  })

  return sanitizeConfig(saved)
}

export async function refreshWhatsAppConnectionStatus() {
  const config = await getRawConfig()
  if (!config?.business_token) {
    return sanitizeConfig(config)
  }

  const businessToken = decryptSecret(config.business_token)
  const wabaId = config.waba_id
  const phoneNumberId = config.phone_number_id

  let phone = null
  let phoneNumbers = []
  if (phoneNumberId) {
    phone = await fetchPhoneNumber({
      phoneNumberId,
      businessToken,
      graphApiVersion: config.graph_api_version
    })
  }

  if (wabaId) {
    phoneNumbers = await fetchWabaPhoneNumbers({
      wabaId,
      businessToken,
      graphApiVersion: config.graph_api_version
    })
  }

  const selectedPhone = phone || phoneNumbers.find(item => item.id === phoneNumberId) || phoneNumbers.find(isConnectedPhone) || phoneNumbers[0] || null

  if (selectedPhone?.id) {
    await upsertPhoneNumber({ configId: config.id, wabaId, phone: selectedPhone })
  }

  for (const phoneNumber of phoneNumbers) {
    await upsertPhoneNumber({ configId: config.id, wabaId, phone: phoneNumber })
  }

  await db.run(
    `UPDATE whatsapp_api_config
     SET phone_number_id = COALESCE(?, phone_number_id),
         display_phone_number = COALESCE(?, display_phone_number),
         verified_name = COALESCE(?, verified_name),
         quality_rating = COALESCE(?, quality_rating),
         platform_type = COALESCE(?, platform_type),
         is_on_biz_app = ?,
         connection_status = CASE WHEN business_token IS NOT NULL AND waba_id IS NOT NULL AND COALESCE(?, phone_number_id) IS NOT NULL THEN 'connected' ELSE connection_status END,
         metadata = ?,
         last_verified_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      nullableString(selectedPhone?.id),
      nullableString(selectedPhone?.display_phone_number),
      nullableString(selectedPhone?.verified_name),
      nullableString(selectedPhone?.quality_rating),
      nullableString(selectedPhone?.platform_type),
      selectedPhone ? asBooleanInteger(selectedPhone.is_on_biz_app) : asBooleanInteger(config.is_on_biz_app),
      nullableString(selectedPhone?.id),
      safeJsonStringify({
        ...(safeJsonParse(config.metadata, {}) || {}),
        lastStatusRefresh: new Date().toISOString(),
        phoneNumbers
      }),
      config.id
    ]
  )

  return sanitizeConfig(await getRawConfigById(config.id))
}

export async function getWebhookVerifyToken() {
  const config = await getRawConfig()
  if (!config?.webhook_verify_token) return null
  return decryptSecret(config.webhook_verify_token)
}

async function upsertWhatsAppContact(contact = {}, fallbackWaId = null) {
  const waId = nullableString(contact.wa_id || contact.from || fallbackWaId)
  if (!waId) return null

  const profileName = nullableString(contact.profile?.name || contact.profile_name || contact.name)
  await db.run(
    `INSERT INTO whatsapp_contacts (
      wa_id, phone, profile_name, first_seen_at, last_seen_at, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(wa_id) DO UPDATE SET
      phone = COALESCE(excluded.phone, whatsapp_contacts.phone),
      profile_name = COALESCE(excluded.profile_name, whatsapp_contacts.profile_name),
      last_seen_at = CURRENT_TIMESTAMP,
      metadata = excluded.metadata,
      updated_at = CURRENT_TIMESTAMP`,
    [
      waId,
      nullableString(contact.phone || waId),
      profileName,
      safeJsonStringify(contact)
    ]
  )

  return await db.get('SELECT * FROM whatsapp_contacts WHERE wa_id = ? LIMIT 1', [waId])
}

async function upsertChat({ phoneNumberId, contactRow, waId, lastMessageAt }) {
  const resolvedWaId = nullableString(contactRow?.wa_id || waId)
  if (!resolvedWaId) return null

  await db.run(
    `INSERT INTO whatsapp_chats (
      phone_number_id, wa_contact_id, wa_id, status, last_message_at, unread_count, created_at, updated_at
    ) VALUES (?, ?, ?, 'open', ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(phone_number_id, wa_id) DO UPDATE SET
      wa_contact_id = COALESCE(excluded.wa_contact_id, whatsapp_chats.wa_contact_id),
      last_message_at = COALESCE(excluded.last_message_at, whatsapp_chats.last_message_at),
      updated_at = CURRENT_TIMESTAMP`,
    [
      nullableString(phoneNumberId),
      contactRow?.id || null,
      resolvedWaId,
      lastMessageAt || null
    ]
  )

  const normalizedPhoneNumberId = nullableString(phoneNumberId)
  if (!normalizedPhoneNumberId) {
    return await db.get(
      'SELECT * FROM whatsapp_chats WHERE phone_number_id IS NULL AND wa_id = ? LIMIT 1',
      [resolvedWaId]
    )
  }

  return await db.get(
    'SELECT * FROM whatsapp_chats WHERE phone_number_id = ? AND wa_id = ? LIMIT 1',
    [normalizedPhoneNumberId, resolvedWaId]
  )
}

function extractMessageText(message = {}) {
  if (message.text?.body) return message.text.body
  if (message.button?.text) return message.button.text
  if (message.interactive?.button_reply?.title) return message.interactive.button_reply.title
  if (message.interactive?.list_reply?.title) return message.interactive.list_reply.title
  if (message.image?.caption) return message.image.caption
  if (message.video?.caption) return message.video.caption
  if (message.document?.caption) return message.document.caption
  if (message.reaction?.emoji) return message.reaction.emoji
  return null
}

async function persistIncomingMessage({ message, value, field, wabaId }) {
  const metadata = value?.metadata || {}
  const phoneNumberId = nullableString(metadata.phone_number_id || value?.phone_number_id)
  const waId = nullableString(message.from || message.to || message.recipient_id)
  const messageTimestamp = unixSecondsToIso(message.timestamp)
  const contactPayload = Array.isArray(value.contacts)
    ? value.contacts.find(contact => contact.wa_id === waId) || value.contacts[0]
    : null
  const contactRow = await upsertWhatsAppContact(contactPayload || { wa_id: waId }, waId)
  const chatRow = await upsertChat({ phoneNumberId, contactRow, waId, lastMessageAt: messageTimestamp })
  const direction = field === 'smb_message_echoes' ? 'echo' : message.from ? 'inbound' : 'outbound'
  const messageId = nullableString(message.id || message.message_id || sha256(safeJsonStringify({ message, field })))

  await db.run(
    `INSERT INTO whatsapp_messages (
      whatsapp_message_id, chat_id, phone_number_id, wa_contact_id, waba_id, wa_id,
      direction, message_type, message_timestamp, status, text_body, raw_payload,
      metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(whatsapp_message_id) DO UPDATE SET
      chat_id = COALESCE(excluded.chat_id, whatsapp_messages.chat_id),
      phone_number_id = COALESCE(excluded.phone_number_id, whatsapp_messages.phone_number_id),
      wa_contact_id = COALESCE(excluded.wa_contact_id, whatsapp_messages.wa_contact_id),
      waba_id = COALESCE(excluded.waba_id, whatsapp_messages.waba_id),
      wa_id = COALESCE(excluded.wa_id, whatsapp_messages.wa_id),
      direction = excluded.direction,
      message_type = excluded.message_type,
      message_timestamp = COALESCE(excluded.message_timestamp, whatsapp_messages.message_timestamp),
      status = COALESCE(excluded.status, whatsapp_messages.status),
      text_body = COALESCE(excluded.text_body, whatsapp_messages.text_body),
      raw_payload = excluded.raw_payload,
      metadata = excluded.metadata,
      updated_at = CURRENT_TIMESTAMP`,
    [
      messageId,
      chatRow?.id || null,
      phoneNumberId,
      contactRow?.id || null,
      nullableString(wabaId),
      waId,
      direction,
      nullableString(message.type),
      messageTimestamp,
      nullableString(message.status),
      extractMessageText(message),
      safeJsonStringify(message),
      safeJsonStringify({ field, metadata })
    ]
  )
}

async function persistMessageStatus({ status, value }) {
  const metadata = value?.metadata || {}
  const phoneNumberId = nullableString(metadata.phone_number_id || value?.phone_number_id)
  const metaMessageId = nullableString(status.id || status.message_id)

  await db.run(
    `INSERT INTO whatsapp_message_statuses (
      whatsapp_message_id, meta_message_id, phone_number_id, recipient_id, status,
      conversation_id, pricing_category, raw_payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      metaMessageId,
      metaMessageId,
      phoneNumberId,
      nullableString(status.recipient_id),
      nullableString(status.status) || 'unknown',
      nullableString(status.conversation?.id),
      nullableString(status.pricing?.category),
      safeJsonStringify(status)
    ]
  )

  if (metaMessageId && status.status) {
    await db.run(
      `UPDATE whatsapp_messages
       SET status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE whatsapp_message_id = ?`,
      [status.status, metaMessageId]
    )
  }
}

async function persistValueContacts(value = {}) {
  if (!Array.isArray(value.contacts)) return
  for (const contact of value.contacts) {
    await upsertWhatsAppContact(contact)
  }
}

async function processWebhookChange({ entry, change, eventHash }) {
  const value = change?.value || {}
  const metadata = value.metadata || {}
  const wabaId = nullableString(entry?.id)
  const phoneNumberId = nullableString(metadata.phone_number_id || value.phone_number_id)
  const field = nullableString(change?.field)
  const eventType = Array.isArray(value.messages)
    ? 'messages'
    : Array.isArray(value.statuses)
      ? 'statuses'
      : field || 'unknown'

  await db.run(
    `INSERT INTO whatsapp_webhook_events (
      event_hash, waba_id, phone_number_id, field, event_type, processing_status,
      raw_payload, received_at
    ) VALUES (?, ?, ?, ?, ?, 'received', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(event_hash) DO UPDATE SET
      processing_status = 'duplicate',
      processed_at = CURRENT_TIMESTAMP`,
    [
      eventHash,
      wabaId,
      phoneNumberId,
      field,
      eventType,
      safeJsonStringify({ entry, change })
    ]
  )

  try {
    await persistValueContacts(value)

    if (Array.isArray(value.messages)) {
      for (const message of value.messages) {
        await persistIncomingMessage({ message, value, field, wabaId })
      }
    }

    if (Array.isArray(value.statuses)) {
      for (const status of value.statuses) {
        await persistMessageStatus({ status, value })
      }
    }

    await db.run(
      `UPDATE whatsapp_webhook_events
       SET processing_status = 'processed', processed_at = CURRENT_TIMESTAMP
       WHERE event_hash = ?`,
      [eventHash]
    )
  } catch (error) {
    await db.run(
      `UPDATE whatsapp_webhook_events
       SET processing_status = 'error',
           error_message = ?,
           processed_at = CURRENT_TIMESTAMP
       WHERE event_hash = ?`,
      [error.message, eventHash]
    )
    throw error
  }
}

export async function ingestWhatsAppWebhook(body = {}) {
  const entries = Array.isArray(body.entry) ? body.entry : []
  let processed = 0

  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : []
    for (const change of changes) {
      const eventHash = sha256(safeJsonStringify({ object: body.object, entryId: entry.id, change }))
      await processWebhookChange({ entry, change, eventHash })
      processed += 1
    }
  }

  if (processed === 0) {
    const eventHash = sha256(safeJsonStringify(body))
    await db.run(
      `INSERT INTO whatsapp_webhook_events (
        event_hash, event_type, processing_status, raw_payload, received_at, processed_at
      ) VALUES (?, 'unknown', 'stored', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(event_hash) DO NOTHING`,
      [eventHash, safeJsonStringify(body)]
    )
  }

  return { processed }
}

export async function getWhatsAppStorageSummary() {
  const [
    phoneNumbers,
    contacts,
    chats,
    messages,
    webhookEvents
  ] = await Promise.all([
    db.get('SELECT COUNT(*) as count FROM whatsapp_phone_numbers'),
    db.get('SELECT COUNT(*) as count FROM whatsapp_contacts'),
    db.get('SELECT COUNT(*) as count FROM whatsapp_chats'),
    db.get('SELECT COUNT(*) as count FROM whatsapp_messages'),
    db.get('SELECT COUNT(*) as count FROM whatsapp_webhook_events')
  ])

  return {
    phoneNumbers: Number(phoneNumbers?.count || 0),
    contacts: Number(contacts?.count || 0),
    chats: Number(chats?.count || 0),
    messages: Number(messages?.count || 0),
    webhookEvents: Number(webhookEvents?.count || 0)
  }
}

export function logWhatsAppServiceError(context, error) {
  logger.error(`[WhatsApp Coexistence] ${context}: ${error.message}`)
  if (error.meta) {
    logger.error(`[WhatsApp Coexistence] Meta payload: ${safeJsonStringify(error.meta)}`)
  }
}
