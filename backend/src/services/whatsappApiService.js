import crypto from 'crypto'
import fetch from 'node-fetch'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { findContactByPhoneCandidates } from './contactIdentityService.js'
import { decrypt, encrypt } from '../utils/encryption.js'
import { buildPhoneMatchCandidates, normalizePhoneDigits, normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { detectWhatsAppAttributionFields } from '../utils/whatsappAttribution.js'
import { logger } from '../utils/logger.js'

const YCLOUD_API_BASE_URL = 'https://api.ycloud.com/v2'
const SOURCE_NAME = 'WhatsApp_API'
const PROVIDER_NAME = 'ycloud'
const WEBHOOK_DESCRIPTION = 'Ristak WhatsApp_API via YCloud'
const GENERIC_CONTACT_NAME = 'Contacto WhatsApp_API'

const REQUIRED_WEBHOOK_EVENTS = [
  'whatsapp.inbound_message.received',
  'whatsapp.message.updated',
  'whatsapp.user.preferences',
  'contact.unsubscribe.created',
  'contact.unsubscribe.deleted',
  'whatsapp.phone_number.deleted',
  'whatsapp.phone_number.name_updated',
  'whatsapp.phone_number.quality_updated',
  'whatsapp.business_account.updated',
  'whatsapp.business_account.reviewed',
  'whatsapp.business_account.deleted'
]

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
    throw new Error('Falta la API key de YCloud')
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
    const message = data?.message ||
      data?.error?.message ||
      data?.error ||
      `YCloud respondió ${response.status} ${response.statusText}`
    throw new Error(message)
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

  return {
    id,
    wabaId,
    phoneNumber,
    displayPhoneNumber: cleanString(record.displayPhoneNumber) || phoneNumber,
    verifiedName: cleanString(record.verifiedName || record.requestedVerifiedName || record.newName),
    qualityRating: cleanString(record.qualityRating),
    messagingLimit: cleanString(record.messagingLimit || record.whatsappBusinessManagerMessagingLimit),
    status: cleanString(record.status || record.nameStatus || record.codeVerificationStatus),
    raw: record
  }
}

async function syncPhoneNumbers(phoneNumbers = []) {
  for (const item of phoneNumbers.map(normalizePhoneNumberRecord)) {
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, waba_id, phone_number, display_phone_number, verified_name,
        quality_rating, messaging_limit, status, raw_payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        waba_id = excluded.waba_id,
        phone_number = excluded.phone_number,
        display_phone_number = excluded.display_phone_number,
        verified_name = excluded.verified_name,
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
      item.qualityRating || null,
      item.messagingLimit || null,
      item.status || null,
      safeJson(item.raw)
    ])
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

  return normalized.length === 1 ? normalized[0] : null
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
      logger.warn(`No se pudo actualizar webhook YCloud ${webhookEndpointId}: ${error.message}`)
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
      quality_rating, messaging_limit, status, updated_at
    FROM whatsapp_api_phone_numbers
    ORDER BY updated_at DESC, phone_number ASC
  `)
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
    webhookEvents
  ] = await Promise.all([
    countRows('SELECT COUNT(*) as total FROM whatsapp_api_phone_numbers'),
    countRows('SELECT COUNT(*) as total FROM whatsapp_api_contacts'),
    countRows('SELECT COUNT(*) as total FROM whatsapp_api_messages'),
    countRows("SELECT COUNT(*) as total FROM whatsapp_api_messages WHERE direction = 'inbound'"),
    countRows("SELECT COUNT(*) as total FROM whatsapp_api_messages WHERE direction = 'outbound'"),
    countRows('SELECT COUNT(*) as total FROM whatsapp_api_attribution'),
    countRows('SELECT COUNT(*) as total FROM whatsapp_api_webhook_events')
  ])

  return {
    phoneNumbers,
    contacts,
    messages,
    inboundMessages,
    outboundMessages,
    attributedMessages,
    webhookEvents
  }
}

export async function getWhatsAppApiStatus() {
  const config = await loadConfig()
  const [stats, phoneNumbers] = await Promise.all([
    getStats(),
    getPhoneNumbersFromDb()
  ])

  const connected = Boolean(config.enabled && config.hasApiKey && config.webhookEndpointId)
  const requiresPhoneSelection = connected && !config.senderPhone && phoneNumbers.length > 1

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
    throw new Error('Pega la API key de YCloud para conectar WhatsApp_API')
  }

  try {
    const [phoneNumbers] = await Promise.all([
      listYCloudPhoneNumbers(cleanApiKey),
      ycloudRequest('/balance', { apiKey: cleanApiKey }).catch(() => null)
    ])
    await syncPhoneNumbers(phoneNumbers)

    const selectedPhone = pickPhoneNumber(phoneNumbers, { senderPhone, phoneNumberId, wabaId })
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
    }

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
    const phoneNumbers = await listYCloudPhoneNumbers(config.apiKey)
    await syncPhoneNumbers(phoneNumbers)

    if (config.webhookEndpointId) {
      try {
        const webhookEndpoint = await ycloudRequest(`/webhookEndpoints/${encodeURIComponent(config.webhookEndpointId)}`, {
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

    await setAppConfig(CONFIG_KEYS.lastSyncedAt, nowIso())
    await setAppConfig(CONFIG_KEYS.lastError, '')
    return getWhatsAppApiStatus()
  } catch (error) {
    await setAppConfig(CONFIG_KEYS.lastError, error.message)
    throw error
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
      logger.warn(`No se pudo deshabilitar webhook YCloud: ${error.message}`)
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

function extractMessageText(message = {}) {
  return cleanString(
    message.text?.body ||
    message.button?.text ||
    message.interactive?.button_reply?.title ||
    message.interactive?.list_reply?.title ||
    message.interactive?.nfm_reply?.body ||
    message.image?.caption ||
    message.video?.caption ||
    message.document?.caption ||
    message.location?.name ||
    message.location?.address ||
    message.reaction?.emoji ||
    ''
  )
}

function extractAttribution(payload = {}, message = {}, messageText = '') {
  const referral = message.referral || payload.whatsappInboundMessage?.referral || {}
  const detected = detectWhatsAppAttributionFields(payload, [messageText])

  const attribution = {
    ctwaClid: cleanString(referral.ctwa_clid || referral.ctwaClid || detected.ctwaClid),
    sourceId: cleanString(referral.source_id || referral.sourceId || detected.sourceId),
    sourceUrl: cleanString(referral.source_url || referral.sourceUrl || detected.sourceUrl),
    sourceType: cleanString(referral.source_type || referral.sourceType || detected.sourceType),
    sourceApp: cleanString(detected.sourceApp),
    entryPoint: cleanString(detected.entryPoint),
    headline: cleanString(referral.headline || detected.headline),
    body: cleanString(referral.body || detected.body),
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

function getMessageIdentity({ payload = {}, direction = '', message = {} }) {
  const type = cleanString(payload.type)
  const normalizedDirection = direction || (type === 'whatsapp.inbound_message.received' ? 'inbound' : 'outbound')
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

async function upsertLocalContact({ phone, profileName, messageText, messageTimestamp, attribution }) {
  const canonicalPhone = normalizePhoneForStorage(phone) || cleanString(phone)
  if (!canonicalPhone) return { id: null, created: false }

  const existing = await findContactByPhoneCandidates(canonicalPhone)
  const contactName = isPhoneLikeName(profileName, canonicalPhone) ? '' : normalizeDisplayText(profileName)
  const fullName = contactName || GENERIC_CONTACT_NAME

  if (!existing) {
    const contactId = hashId('waapi_contact', canonicalPhone)
    const customFieldsValue = JSON.stringify([
      { key: 'whatsapp_api_provider', field_value: PROVIDER_NAME },
      { key: 'whatsapp_api_first_message', field_value: messageText || '' },
      { key: 'whatsapp_api_source_id', field_value: attribution.sourceId || '' },
      { key: 'whatsapp_api_ctwa_clid', field_value: attribution.ctwaClid || '' },
      { key: 'whatsapp_api_source_url', field_value: attribution.sourceUrl || '' }
    ])
    const customFieldsPlaceholder = isPostgres() ? '?::jsonb' : '?'

    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, attribution_url, attribution_session_source,
        attribution_medium, attribution_ctwa_clid, attribution_ad_name, attribution_ad_id,
        custom_fields, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${customFieldsPlaceholder}, ?, CURRENT_TIMESTAMP)
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
      customFieldsValue,
      messageTimestamp || nowIso()
    ])

    return { id: contactId, created: true }
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

  return { id: existing.id, created: false }
}

async function upsertWhatsAppApiContact({ contactId, phone, profileName, rawProfile, seenAt }) {
  const canonicalPhone = normalizePhoneForStorage(phone) || cleanString(phone)
  if (!canonicalPhone) return null

  const apiContactId = hashId('waapi_profile', canonicalPhone)
  await db.run(`
    INSERT INTO whatsapp_api_contacts (
      id, contact_id, phone, profile_name, raw_profile_json,
      first_seen_at, last_seen_at, message_count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      contact_id = COALESCE(excluded.contact_id, whatsapp_api_contacts.contact_id),
      profile_name = COALESCE(NULLIF(excluded.profile_name, ''), whatsapp_api_contacts.profile_name),
      raw_profile_json = excluded.raw_profile_json,
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
      message_count = whatsapp_api_contacts.message_count + 1,
      updated_at = CURRENT_TIMESTAMP
  `, [
    apiContactId,
    contactId || null,
    canonicalPhone,
    normalizeDisplayText(profileName) || null,
    safeJson(rawProfile),
    seenAt || nowIso(),
    seenAt || nowIso()
  ])

  return apiContactId
}

async function upsertMessage({ payload, message, direction }) {
  const identity = getMessageIdentity({ payload, direction, message })
  const messageText = extractMessageText(message)
  const messageTimestamp = toDateTime(message.sendTime || message.createTime || message.updateTime || payload.createTime) || nowIso()
  const profileName = message.customerProfile?.name || message.profile?.name || ''
  const attribution = extractAttribution(payload, message, messageText)
  const localContact = await upsertLocalContact({
    phone: identity.phone,
    profileName,
    messageText,
    messageTimestamp,
    attribution
  })
  const apiContactId = await upsertWhatsAppApiContact({
    contactId: localContact.id,
    phone: identity.phone,
    profileName,
    rawProfile: message.customerProfile || message.profile || null,
    seenAt: messageTimestamp
  })

  const ycloudMessageId = cleanString(message.id)
  const wamid = cleanString(message.wamid || message.context?.id)
  const messageId = hashId('waapi_msg', ycloudMessageId || wamid || `${payload.id}|${identity.direction}|${identity.phone}`)
  const status = cleanString(message.status)
  const error = Array.isArray(message.errors) ? message.errors[0] : message.error

  await db.run(`
    INSERT INTO whatsapp_api_messages (
      id, ycloud_message_id, wamid, waba_id, whatsapp_api_contact_id, contact_id,
      phone, from_phone, to_phone, business_phone, direction, message_type,
      message_text, status, error_code, error_message, message_timestamp,
      raw_payload_json, context_json, referral_json,
      detected_ctwa_clid, detected_source_id, detected_source_url, detected_source_type,
      detected_source_app, detected_entry_point, detected_headline, detected_body,
      detected_conversion_data, detected_ctwa_payload, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      status = COALESCE(NULLIF(excluded.status, ''), whatsapp_api_messages.status),
      error_code = COALESCE(NULLIF(excluded.error_code, ''), whatsapp_api_messages.error_code),
      error_message = COALESCE(NULLIF(excluded.error_message, ''), whatsapp_api_messages.error_message),
      raw_payload_json = excluded.raw_payload_json,
      updated_at = CURRENT_TIMESTAMP
  `, [
    messageId,
    ycloudMessageId || null,
    wamid || null,
    cleanString(message.wabaId) || null,
    apiContactId,
    localContact.id,
    identity.phone || null,
    identity.fromPhone || null,
    identity.toPhone || null,
    identity.businessPhone || null,
    identity.direction,
    cleanString(message.type) || 'unknown',
    messageText || null,
    status || null,
    cleanString(error?.code || message.errorCode) || null,
    cleanString(error?.message || error?.title || message.errorMessage) || null,
    messageTimestamp,
    safeJson(message),
    safeJson(message.context || null),
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
      safeJson(message),
      messageTimestamp
    ])
  }

  return { messageId, contactId: localContact.id, apiContactId, attribution }
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
      processedError: 'Firma YCloud inválida'
    })
    const error = new Error('Firma YCloud inválida')
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
    if (payload?.whatsappInboundMessage) {
      await upsertMessage({
        payload,
        message: payload.whatsappInboundMessage,
        direction: 'inbound'
      })
    } else if (payload?.whatsappMessage) {
      await upsertMessage({
        payload,
        message: payload.whatsappMessage,
        direction: 'outbound'
      })
    } else if (payload?.whatsappPhoneNumber) {
      await syncPhoneNumbers([payload.whatsappPhoneNumber])
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

export async function sendWhatsAppApiTextMessage({ to, text, from, externalId } = {}) {
  const config = await loadConfig({ includeSecrets: true })
  if (!config.enabled || !config.apiKey) {
    throw new Error('WhatsApp_API no está conectado')
  }

  const fromPhone = normalizePhoneForStorage(from || config.senderPhone) || cleanString(from || config.senderPhone)
  const toPhone = normalizePhoneForStorage(to) || cleanString(to)
  const body = cleanString(text)

  if (!fromPhone) throw new Error('Falta el número emisor de WhatsApp_API')
  if (!toPhone) throw new Error('Falta el número destino')
  if (!body) throw new Error('Falta el texto del mensaje')

  const response = await ycloudRequest('/whatsapp/messages', {
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
      createTime: response.createTime || nowIso()
    },
    direction: 'outbound'
  })

  return response
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
