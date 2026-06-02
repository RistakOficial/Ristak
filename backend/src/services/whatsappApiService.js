import crypto from 'crypto'
import fetch from 'node-fetch'
import { db } from '../config/database.js'
import { getMetaApiVersion } from '../config/constants.js'
import { getMetaConfig, saveMetaAccessToken } from './metaAdsService.js'
import { decrypt, encrypt, isEncrypted } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'

const DEFAULT_CONNECTION_STATUS = 'not_configured'
const DISCONNECTED_CONNECTION_STATUS = 'disconnected'
const WHATSAPP_CLOUD_API_DOCS_URL = 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started'
const WHATSAPP_CLOUD_API_WEBHOOKS_URL = 'https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks'
const WHATSAPP_CLOUD_API_TOKENS_URL = 'https://developers.facebook.com/docs/whatsapp/business-management-api/get-started'

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

function generateWebhookVerifyToken() {
  return `wa_${crypto.randomBytes(24).toString('hex')}`
}

function isConnectedPhone(phone = {}) {
  return Boolean(phone.id || phone.phone_number_id || phone.is_on_biz_app === true || phone.is_on_biz_app === 1 || phone.platform_type === 'CLOUD_API')
}

function hasSharedMetaAccessToken(metaConfig = {}) {
  return Boolean(metaConfig?.access_token)
}

function getConfigStatus(row = {}, metaConfig = {}) {
  if (row.connection_status === DISCONNECTED_CONNECTION_STATUS) return row.connection_status
  if (row.connection_status === 'connected' && hasSharedMetaAccessToken(metaConfig)) return row.connection_status
  if (row.app_id && row.app_secret && hasSharedMetaAccessToken(metaConfig) && row.waba_id && row.phone_number_id) return 'ready_to_connect'
  return DEFAULT_CONNECTION_STATUS
}

function isMetaConnectionGoneError(error = {}) {
  const message = normalizeString(error.message || error.meta?.error?.message).toLowerCase()
  return (
    message.includes('application has been deleted') ||
    message.includes('unsupported get request') ||
    message.includes('object does not exist') ||
    message.includes('cannot be loaded')
  )
}

async function markWhatsAppDisconnected(config, reason = {}) {
  if (!config?.id) return config

  const metadata = {
    ...(safeJsonParse(config.metadata, {}) || {}),
    disconnectedAt: new Date().toISOString(),
    disconnectReason: reason.message || 'WhatsApp API desconectado',
    disconnectSource: reason.source || 'system',
    ...(reason.unsubscribeResponse ? { unsubscribeResponse: reason.unsubscribeResponse } : {})
  }

  await db.run(
    `UPDATE whatsapp_api_config
     SET connection_status = ?,
         last_error_payload = ?,
         metadata = ?,
         last_verified_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      DISCONNECTED_CONNECTION_STATUS,
      reason.error ? safeJsonStringify(reason.error) : null,
      safeJsonStringify(metadata),
      config.id
    ]
  )

  return await getRawConfigById(config.id)
}

function isDirectCloudConfigReady(row = {}, metaConfig = {}) {
  return Boolean(row.app_id && row.app_secret && hasSharedMetaAccessToken(metaConfig) && row.waba_id && row.phone_number_id && row.webhook_verify_token)
}

function sanitizeConfig(row, metaConfig = null) {
  if (!row) {
    return {
      configured: false,
      connectionStatus: DEFAULT_CONNECTION_STATUS,
      graphApiVersion: normalizeGraphVersion(),
      businessToken: metaConfig?.access_token ? maskSecret(metaConfig.access_token) : '',
      businessTokenConfigured: hasSharedMetaAccessToken(metaConfig)
    }
  }

  return {
    configured: isDirectCloudConfigReady(row),
    id: row.id,
    appId: row.app_id || '',
    appSecret: row.app_secret ? maskSecret(row.app_secret) : '',
    appSecretConfigured: Boolean(row.app_secret),
    graphApiVersion: normalizeGraphVersion(getMetaApiVersion()),
    webhookVerifyToken: row.webhook_verify_token ? decryptSecret(row.webhook_verify_token) || '' : '',
    webhookVerifyTokenConfigured: Boolean(row.webhook_verify_token),
    callbackUrl: row.callback_url || '',
    businessToken: metaConfig?.access_token ? maskSecret(metaConfig.access_token) : '',
    businessTokenConfigured: hasSharedMetaAccessToken(metaConfig),
    wabaId: row.waba_id || '',
    phoneNumberId: row.phone_number_id || '',
    displayPhoneNumber: row.display_phone_number || '',
    verifiedName: row.verified_name || '',
    qualityRating: row.quality_rating || '',
    platformType: row.platform_type || '',
    isOnBizApp: Boolean(row.is_on_biz_app),
    connectionStatus: getConfigStatus(row, metaConfig),
    onboardingEvent: row.onboarding_event || '',
    connectedAt: row.connected_at || null,
    lastExchangeAt: row.last_exchange_at || null,
    lastVerifiedAt: row.last_verified_at || null,
    metadata: safeJsonParse(row.metadata, {})
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
      app_id, app_secret, graph_api_version,
      webhook_verify_token, callback_url, waba_id, phone_number_id,
      connection_status, metadata,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      payload.app_id,
      payload.app_secret,
      payload.graph_api_version,
      payload.webhook_verify_token,
      payload.callback_url,
      payload.waba_id,
      payload.phone_number_id,
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
         graph_api_version = ?,
         webhook_verify_token = ?,
         callback_url = ?,
         waba_id = ?,
         phone_number_id = ?,
         connection_status = ?,
         metadata = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      updates.app_id,
      updates.app_secret,
      updates.graph_api_version,
      updates.webhook_verify_token,
      updates.callback_url,
      updates.waba_id,
      updates.phone_number_id,
      updates.connection_status,
      updates.metadata,
      id
    ]
  )

  return getRawConfigById(id)
}

export async function getWhatsAppConfig() {
  const [config, metaConfig] = await Promise.all([
    getRawConfig(),
    getMetaConfig().catch(error => {
      logger.warn(`No se pudo leer token compartido de Meta para WhatsApp: ${error.message}`)
      return null
    })
  ])

  return sanitizeConfig(config, metaConfig)
}

export async function saveWhatsAppConfig(input = {}) {
  const existing = await getRawConfig()
  const incomingAccessToken = input.businessToken ?? input.business_token ?? input.accessToken ?? input.access_token
  let metaConfig = await getMetaConfig().catch(error => {
    logger.warn(`No se pudo leer token compartido de Meta antes de guardar WhatsApp: ${error.message}`)
    return null
  })

  if (nullableString(incomingAccessToken) && !normalizeString(incomingAccessToken).startsWith('***')) {
    metaConfig = await saveMetaAccessToken(incomingAccessToken)
  }

  const appId = nullableString(input.appId ?? input.app_id ?? existing?.app_id)
  const graphApiVersion = normalizeGraphVersion(getMetaApiVersion())
  const appSecret = encryptSecret(input.appSecret ?? input.app_secret, existing?.app_secret)
  const wabaId = nullableString(input.wabaId ?? input.waba_id ?? existing?.waba_id)
  const phoneNumberId = nullableString(input.phoneNumberId ?? input.phone_number_id ?? existing?.phone_number_id)
  const incomingWebhookVerifyToken = input.webhookVerifyToken ?? input.webhook_verify_token
  const shouldGenerateWebhookVerifyToken = Boolean(
    !nullableString(incomingWebhookVerifyToken) &&
    !existing?.webhook_verify_token &&
    appId &&
    appSecret
  )
  const webhookVerifyToken = encryptSecret(
    shouldGenerateWebhookVerifyToken ? generateWebhookVerifyToken() : incomingWebhookVerifyToken,
    existing?.webhook_verify_token
  )
  const callbackUrl = nullableString(input.callbackUrl ?? input.callback_url ?? existing?.callback_url)
  const existingMetadata = safeJsonParse(existing?.metadata, {}) || {}
  const metadata = {
    ...existingMetadata,
    connectionMode: 'direct_cloud_api',
    docs: {
      cloudApi: WHATSAPP_CLOUD_API_DOCS_URL,
      webhooks: WHATSAPP_CLOUD_API_WEBHOOKS_URL,
      accessTokens: WHATSAPP_CLOUD_API_TOKENS_URL
    },
    webhook: {
      ...(existingMetadata.webhook || {}),
      ...(shouldGenerateWebhookVerifyToken ? { verifyTokenGeneratedAt: new Date().toISOString() } : {})
    }
  }

  const hasDirectCredentials = Boolean(appId && appSecret && hasSharedMetaAccessToken(metaConfig) && wabaId && phoneNumberId)
  const nextStatus = hasDirectCredentials
    ? existing?.connection_status === 'connected' ? 'connected' : 'ready_to_connect'
    : DEFAULT_CONNECTION_STATUS

  const payload = {
    app_id: appId,
    app_secret: appSecret,
    graph_api_version: graphApiVersion,
    webhook_verify_token: webhookVerifyToken,
    callback_url: callbackUrl,
    waba_id: wabaId,
    phone_number_id: phoneNumberId,
    connection_status: nextStatus,
    metadata: safeJsonStringify(metadata)
  }

  const saved = existing
    ? await updateConfig(existing.id, payload)
    : await insertConfig(payload)

  return sanitizeConfig(saved, metaConfig)
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

async function unsubscribeWabaFromWebhooks({ wabaId, businessToken, graphApiVersion }) {
  if (!wabaId || !businessToken) return null

  const params = new URLSearchParams({ access_token: businessToken })
  const response = await fetch(`${graphBase(graphApiVersion)}/${encodeURIComponent(wabaId)}/subscribed_apps?${params.toString()}`, {
    method: 'DELETE'
  })
  const data = await response.json()

  if (!response.ok || data.error) {
    const message = data?.error?.message || `Meta WABA unsubscribe failed (${response.status})`
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
      'quality_rating'
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
      'quality_rating'
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

async function updateConfigAfterDirectConnection({
  config,
  subscriptionResponse,
  phone,
  phoneNumbers
}) {
  const selectedPhone = phone || phoneNumbers?.find(item => item.id === config.phone_number_id) || phoneNumbers?.[0] || null
  const connected = Boolean(config.waba_id && (selectedPhone?.id || config.phone_number_id))

  await db.run(
    `UPDATE whatsapp_api_config
     SET phone_number_id = COALESCE(?, phone_number_id),
         display_phone_number = COALESCE(?, display_phone_number),
         verified_name = COALESCE(?, verified_name),
         quality_rating = COALESCE(?, quality_rating),
         platform_type = COALESCE(?, platform_type, 'CLOUD_API'),
         is_on_biz_app = 0,
         connection_status = ?,
         onboarding_event = NULL,
         last_session_payload = NULL,
         last_error_payload = NULL,
         metadata = ?,
         connected_at = CASE WHEN ? = 1 THEN COALESCE(connected_at, CURRENT_TIMESTAMP) ELSE connected_at END,
         last_exchange_at = CURRENT_TIMESTAMP,
         last_verified_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      nullableString(selectedPhone?.id),
      nullableString(selectedPhone?.display_phone_number),
      nullableString(selectedPhone?.verified_name),
      nullableString(selectedPhone?.quality_rating),
      nullableString(selectedPhone?.platform_type),
      connected ? 'connected' : 'ready_to_connect',
      safeJsonStringify({
        ...(safeJsonParse(config.metadata, {}) || {}),
        connectionMode: 'direct_cloud_api',
        subscription: subscriptionResponse || null,
        phoneNumbers: phoneNumbers || [],
        directConnectedAt: new Date().toISOString()
      }),
      connected ? 1 : 0,
      config.id
    ]
  )

  if (selectedPhone?.id) {
    await upsertPhoneNumber({ configId: config.id, wabaId: config.waba_id, phone: { ...selectedPhone, platform_type: selectedPhone.platform_type || 'CLOUD_API' } })
  }

  if (Array.isArray(phoneNumbers)) {
    for (const phoneNumber of phoneNumbers) {
      await upsertPhoneNumber({
        configId: config.id,
        wabaId: config.waba_id,
        phone: { ...phoneNumber, platform_type: phoneNumber.platform_type || 'CLOUD_API' }
      })
    }
  }

  return await getRawConfigById(config.id)
}

export async function connectWhatsAppCloudApi(input = null) {
  if (input && Object.keys(input).length > 0) {
    await saveWhatsAppConfig(input)
  }

  const [config, metaConfig] = await Promise.all([
    getRawConfig(),
    getMetaConfig()
  ])

  if (!isDirectCloudConfigReady(config, metaConfig)) {
    throw new Error('Completa App ID, App Secret, Access Token, WABA ID, Phone Number ID y webhook antes de validar WhatsApp')
  }

  const businessToken = metaConfig.access_token

  const subscriptionResponse = await subscribeWabaToWebhooks({
    wabaId: config.waba_id,
    businessToken,
    graphApiVersion: config.graph_api_version
  })

  const [phone, phoneNumbers] = await Promise.all([
    fetchPhoneNumber({
      phoneNumberId: config.phone_number_id,
      businessToken,
      graphApiVersion: config.graph_api_version
    }),
    fetchWabaPhoneNumbers({
      wabaId: config.waba_id,
      businessToken,
      graphApiVersion: config.graph_api_version
    })
  ])

  const saved = await updateConfigAfterDirectConnection({
    config,
    subscriptionResponse,
    phone,
    phoneNumbers
  })

  return sanitizeConfig(saved, metaConfig)
}

export async function refreshWhatsAppConnectionStatus() {
  const [config, metaConfig] = await Promise.all([
    getRawConfig(),
    getMetaConfig().catch(error => {
      logger.warn(`No se pudo leer token compartido de Meta al refrescar WhatsApp: ${error.message}`)
      return null
    })
  ])

  if (!config || !metaConfig?.access_token) {
    return sanitizeConfig(config, metaConfig)
  }

  const businessToken = metaConfig.access_token
  const wabaId = config.waba_id
  const phoneNumberId = config.phone_number_id

  try {
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
           connection_status = CASE WHEN waba_id IS NOT NULL AND COALESCE(?, phone_number_id) IS NOT NULL THEN 'connected' ELSE connection_status END,
           metadata = ?,
           last_error_payload = NULL,
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

    return sanitizeConfig(await getRawConfigById(config.id), metaConfig)
  } catch (error) {
    if (!isMetaConnectionGoneError(error)) throw error

    const disconnected = await markWhatsAppDisconnected(config, {
      source: 'refresh',
      message: error.message,
      error: error.meta || { message: error.message }
    })

    return sanitizeConfig(disconnected, metaConfig)
  }
}

export async function disconnectWhatsAppCloudApi() {
  const [config, metaConfig] = await Promise.all([
    getRawConfig(),
    getMetaConfig().catch(error => {
      logger.warn(`No se pudo leer token compartido de Meta al desconectar WhatsApp: ${error.message}`)
      return null
    })
  ])

  if (!config) {
    return sanitizeConfig(config, metaConfig)
  }

  let unsubscribeResponse = null
  let unsubscribeError = null

  if (metaConfig?.access_token && config.waba_id) {
    try {
      unsubscribeResponse = await unsubscribeWabaFromWebhooks({
        wabaId: config.waba_id,
        businessToken: metaConfig.access_token,
        graphApiVersion: config.graph_api_version
      })
    } catch (error) {
      unsubscribeError = error
      if (!isMetaConnectionGoneError(error)) {
        logger.warn(`[WhatsApp API] No se pudo desuscribir WABA de Meta al desconectar localmente: ${error.message}`)
      }
    }
  }

  const disconnected = await markWhatsAppDisconnected(config, {
    source: 'manual_disconnect',
    message: unsubscribeError?.message || 'Desconectado manualmente desde configuración',
    error: unsubscribeError?.meta || (unsubscribeError ? { message: unsubscribeError.message } : null),
    unsubscribeResponse
  })

  return sanitizeConfig(disconnected, metaConfig)
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
  logger.error(`[WhatsApp API] ${context}: ${error.message}`)
  if (error.meta) {
    logger.error(`[WhatsApp API] Meta payload: ${safeJsonStringify(error.meta)}`)
  }
}
