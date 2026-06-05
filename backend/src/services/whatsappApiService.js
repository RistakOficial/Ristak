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
  'whatsapp.template.category_updated',
  'whatsapp.template.quality_updated',
  'whatsapp.template.reviewed',
  'whatsapp.business_account.updated',
  'whatsapp.business_account.reviewed',
  'whatsapp.business_account.deleted'
]

const PHONE_STATUS_ALERTS = {
  BANNED: {
    severity: 'critical',
    title: 'Numero de WhatsApp baneado',
    message: 'WhatsApp marco este numero como baneado. No se puede usar para enviar mensajes hasta resolverlo en Meta/YCloud.'
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
    message: 'El numero no esta alcanzable por los servidores de WhatsApp. Revisa el estado en YCloud/Meta antes de enviar.'
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
    message: 'Meta/YCloud esta revisando el numero. El envio puede quedar limitado hasta que aprueben la revision.'
  },
  PENDING: {
    severity: 'info',
    title: 'Numero pendiente',
    message: 'El numero esta pendiente de verificacion o registro en WhatsApp Business.'
  },
  UNKNOWN: {
    severity: 'warning',
    title: 'Estado de numero desconocido',
    message: 'YCloud no pudo determinar el estado del numero. Conviene sincronizar y revisar antes de enviar campañas.'
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
    message: 'La plantilla esta archivada. YCloud indica que las plantillas archivadas no se pueden enviar.'
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
      title: 'Saldo de YCloud agotado',
      message: `La cuenta YCloud reporta ${amount.toFixed(2)} ${currency}. Las plantillas pueden fallar por saldo insuficiente.`,
      entityType: 'account',
      entityId: 'balance',
      raw: balance.raw || balance
    })
  } else if (amount <= 10) {
    await upsertAlert({
      severity: 'warning',
      alertType: 'balance',
      title: 'Saldo bajo de YCloud',
      message: `La cuenta YCloud reporta ${amount.toFixed(2)} ${currency}. Recarga antes de lanzar envios grandes.`,
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
      message: 'YCloud aviso que la cuenta de WhatsApp Business fue eliminada. Revisa Meta/YCloud antes de mandar.',
      sourceEventId,
      entityType: 'business_account',
      entityId,
      raw: { eventType, account }
    })
    return
  }

  if (rawText.includes('BANNED') || rawText.includes('BLOCKED') || rawText.includes('DISABLED')) {
    await upsertAlert({
      severity: 'critical',
      alertType: 'business_account',
      title: 'Cuenta WhatsApp Business con bloqueo',
      message: 'YCloud reporto una actualizacion grave en la cuenta de WhatsApp Business. Revisa el panel de YCloud/Meta.',
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
      message: `YCloud reporto decision/estado ${decision}. Puede afectar aprobacion o envio de plantillas.`,
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

function normalizeYCloudContactRecord(record = {}) {
  const phone = normalizePhoneForStorage(record.phoneNumber) || cleanString(record.phoneNumber)
  const profileName = normalizeDisplayText(record.nickname || record.name || record.fullName || record.email)
  return {
    id: cleanString(record.id) || hashId('ycloud_contact', phone || record.email),
    phone,
    email: cleanString(record.email),
    profileName,
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
      messageText: '',
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

    const apiContactId = hashId('waapi_profile', contact.phone)
    await db.run(`
      INSERT INTO whatsapp_api_contacts (
        id, contact_id, phone, profile_name, raw_profile_json,
        first_seen_at, last_seen_at, message_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
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
        updated_at = CURRENT_TIMESTAMP
    `, [
      apiContactId,
      localContact.id || null,
      contact.phone,
      contact.profileName || null,
      safeJson(contact.raw),
      contact.seenAt,
      contact.seenAt
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
      profile_picture_url, business_profile_json, quality_rating, messaging_limit,
      status, updated_at
    FROM whatsapp_api_phone_numbers
    ORDER BY updated_at DESC, phone_number ASC
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
  const [stats, phoneNumbers, balance, templates, alerts] = await Promise.all([
    getStats(),
    getPhoneNumbersFromDb(),
    getBalanceFromDb(),
    getTemplatesFromDb({ limit: 12 }),
    getActiveAlertsFromDb({ limit: 12 })
  ])

  const connected = Boolean(config.enabled && config.hasApiKey && config.webhookEndpointId)
  const requiresPhoneSelection = connected && !config.senderPhone && phoneNumbers.length > 1
  const selectedPhone = phoneNumbers.find(phone => phone.id === config.phoneNumberId) ||
    phoneNumbers.find(phone => phone.phone_number === config.senderPhone) ||
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
    const [phoneNumbers, balance, templates, ycloudContacts] = await Promise.all([
      listYCloudPhoneNumbers(cleanApiKey),
      retrieveYCloudBalance(cleanApiKey).catch(error => {
        logger.warn(`No se pudo leer balance YCloud: ${error.message}`)
        return null
      }),
      listYCloudTemplates(cleanApiKey, { wabaId }).catch(error => {
        logger.warn(`No se pudieron leer plantillas YCloud: ${error.message}`)
        return []
      }),
      listYCloudContacts(cleanApiKey).catch(error => {
        logger.warn(`No se pudieron leer contactos YCloud: ${error.message}`)
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
    const [phoneNumbers, balance, templates, ycloudContacts] = await Promise.all([
      listYCloudPhoneNumbers(config.apiKey),
      retrieveYCloudBalance(config.apiKey).catch(error => {
        logger.warn(`No se pudo actualizar balance YCloud: ${error.message}`)
        return null
      }),
      listYCloudTemplates(config.apiKey, { wabaId: config.wabaId }).catch(error => {
        logger.warn(`No se pudieron actualizar plantillas YCloud: ${error.message}`)
        return []
      }),
      listYCloudContacts(config.apiKey).catch(error => {
        logger.warn(`No se pudieron actualizar contactos YCloud: ${error.message}`)
        return []
      })
    ])
    const enrichedPhoneNumbers = await enrichPhoneNumbersWithProfiles(config.apiKey, phoneNumbers)
    await syncPhoneNumbers(enrichedPhoneNumbers)
    if (balance) await syncBalance(balance)
    await syncTemplates(templates)
    await syncYCloudContacts(ycloudContacts)

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
      await syncPhoneNumbers([payload.whatsappPhoneNumber], {
        sourceEventId: eventRowId,
        eventType: payload?.type
      })
    } else if (payload?.whatsappTemplate) {
      await syncTemplates([payload.whatsappTemplate], {
        sourceEventId: eventRowId,
        eventType: payload?.type
      })
    } else if (payload?.whatsappBusinessAccount) {
      await syncBusinessAccountAlert(payload.whatsappBusinessAccount, {
        sourceEventId: eventRowId,
        eventType: payload?.type
      })
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
      SELECT id, waba_id, name, language, status, quality_rating
      FROM whatsapp_api_templates
      WHERE id = ?
    `, [templateId])
  }

  if (!templateName || !language) return null
  return db.get(`
    SELECT id, waba_id, name, language, status, quality_rating
    FROM whatsapp_api_templates
    WHERE name = ? AND language = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `, [templateName, language])
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
  externalId
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

  const response = await ycloudRequest('/whatsapp/messages', {
    apiKey: config.apiKey,
    method: 'POST',
    body: requestBody
  })

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
      createTime: response.createTime || nowIso()
    },
    direction: 'outbound'
  })

  return response
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
