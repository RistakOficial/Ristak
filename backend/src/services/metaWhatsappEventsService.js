import crypto from 'crypto'
import fetch from 'node-fetch'
import { db, getAppConfig } from '../config/database.js'
import { API_URLS } from '../config/constants.js'
import { logger } from '../utils/logger.js'
import { getMetaConfig } from './metaAdsService.js'
import { nonTestPaymentCondition } from '../utils/paymentMode.js'
import { buildPhoneMatchCandidates } from '../utils/phoneUtils.js'

const CONFIG_KEYS = {
  scheduleEnabled: 'meta_whatsapp_schedule_enabled',
  purchaseEnabled: 'meta_whatsapp_purchase_enabled',
  scheduleEventName: 'meta_whatsapp_schedule_event_name',
  purchaseEventName: 'meta_whatsapp_purchase_event_name',
  testEventCode: 'meta_test_event_code',
  whatsappBusinessAccountId: 'meta_whatsapp_business_account_id'
}

const EVENT_TYPES = {
  schedule: 'appointment_booked',
  purchase: 'first_purchase'
}

const CONTACT_SENT_FIELDS = {
  [EVENT_TYPES.schedule]: {
    sent: 'meta_schedule_event_sent',
    sentAt: 'meta_schedule_event_sent_at',
    eventId: 'meta_schedule_event_id'
  },
  [EVENT_TYPES.purchase]: {
    sent: 'meta_purchase_event_sent',
    sentAt: 'meta_purchase_event_sent_at',
    eventId: 'meta_purchase_event_id'
  }
}

const SUCCESS_PAYMENT_STATUSES = new Set([
  'paid',
  'succeeded',
  'completed',
  'complete',
  'fulfilled',
  'success'
])

function parseBoolean(value, defaultValue = false) {
  if (value === null || value === undefined || value === '') return defaultValue
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1

  const normalized = String(value).trim().toLowerCase()
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)
}

function cleanString(value) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function normalizeForHash(value) {
  const clean = cleanString(value).toLowerCase()
  return clean || null
}

function normalizePhoneForHash(value) {
  const clean = cleanString(value)
  if (!clean) return null

  const digits = clean.replace(/[^\d]/g, '')
  return digits || null
}

function hashValue(value, normalizer = normalizeForHash) {
  const normalized = normalizer(value)
  if (!normalized) return null

  return crypto.createHash('sha256').update(normalized).digest('hex')
}

function jsonForLog(value) {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return JSON.stringify({ serializationError: true })
  }
}

function normalizeCurrency(value) {
  const currency = cleanString(value || 'MXN').toUpperCase()
  return currency || 'MXN'
}

function normalizeAmount(value) {
  const amount = Number(value)
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null
}

function deriveNames(contact = {}) {
  const firstName = cleanString(contact.first_name)
  const lastName = cleanString(contact.last_name)

  if (firstName || lastName) {
    return { firstName, lastName }
  }

  const parts = cleanString(contact.full_name).split(' ').filter(Boolean)
  if (parts.length === 0) return { firstName: '', lastName: '' }

  return {
    firstName: parts[0],
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : ''
  }
}

function buildUserData(contact) {
  const { firstName, lastName } = deriveNames(contact)
  const userData = {
    ph: hashValue(contact.phone, normalizePhoneForHash),
    external_id: hashValue(contact.id),
    em: hashValue(contact.email),
    fn: hashValue(firstName),
    ln: hashValue(lastName)
  }

  return Object.fromEntries(
    Object.entries(userData).filter(([, value]) => Boolean(value))
  )
}

function normalizeBusinessMessagingEventName(value) {
  const eventName = cleanString(value)
  const aliases = {
    lead: 'LeadSubmitted',
    schedule: 'LeadSubmitted'
  }

  return aliases[eventName.toLowerCase()] || eventName
}

function buildBusinessMessagingUserData(contact, metaConfig, whatsappAttribution) {
  const userData = buildUserData(contact)
  const ctwaClid = cleanString(contact.attribution_ctwa_clid || whatsappAttribution?.referral_ctwa_clid)
  const pageId = cleanString(metaConfig?.pageId)
  const whatsappBusinessAccountId = cleanString(metaConfig?.whatsappBusinessAccountId)

  if (ctwaClid) {
    userData.ctwa_clid = ctwaClid
  }

  if (pageId) {
    userData.page_id = pageId
  }

  if (whatsappBusinessAccountId) {
    userData.whatsapp_business_account_id = whatsappBusinessAccountId
  }

  return userData
}

function buildBusinessMessagingCustomData(customData, contact, whatsappAttribution) {
  const enrichedData = { ...customData }
  const adId = cleanString(
    contact.attribution_ad_id ||
    whatsappAttribution?.referral_source_id ||
    whatsappAttribution?.ad_id_thru_message
  )
  const adName = cleanString(contact.attribution_ad_name || whatsappAttribution?.referral_headline)
  const referralSourceType = cleanString(whatsappAttribution?.referral_source_type)
  const referralSourceUrl = cleanString(whatsappAttribution?.referral_source_url)
  const attributionSource = cleanString(whatsappAttribution?.attribution_source)

  if (adId) {
    enrichedData.ad_id = adId
  }

  if (adName) {
    enrichedData.ad_name = adName
  }

  if (referralSourceType) {
    enrichedData.referral_source_type = referralSourceType
  }

  if (referralSourceUrl) {
    enrichedData.referral_source_url = referralSourceUrl
  }

  if (attributionSource) {
    enrichedData.attribution_source = attributionSource
  }

  return Object.fromEntries(
    Object.entries(enrichedData).filter(([, value]) => value !== null && value !== undefined && value !== '')
  )
}

async function getConfigBoolean(key, defaultValue = false) {
  const value = await getAppConfig(key)
  return parseBoolean(value, defaultValue)
}

async function getConfiguredEventName(key, fallback) {
  const value = cleanString(await getAppConfig(key))
  return normalizeBusinessMessagingEventName(value || fallback)
}

async function getMetaCapiConfig() {
  const metaConfig = await getMetaConfig().catch(error => {
    logger.warn(`No se pudo leer configuración de Meta para WhatsApp CAPI: ${error.message}`)
    return null
  })

  const datasetId = cleanString(
    metaConfig?.pixel_id ||
    process.env.META_PIXEL_ID ||
    process.env.META_DATASET_ID ||
    process.env.DATASET_ID
  )

  const accessToken = cleanString(
    metaConfig?.pixel_api_token ||
    process.env.META_ACCESS_TOKEN ||
    metaConfig?.access_token
  )

  const testEventCode = cleanString(
    await getAppConfig(CONFIG_KEYS.testEventCode) ||
    process.env.META_TEST_EVENT_CODE
  )

  const pageId = cleanString(
    metaConfig?.page_id ||
    process.env.META_PAGE_ID ||
    process.env.FACEBOOK_PAGE_ID
  )

  const whatsappBusinessAccountId = cleanString(
    await getAppConfig(CONFIG_KEYS.whatsappBusinessAccountId) ||
    process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID ||
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ||
    process.env.META_WABA_ID ||
    process.env.WABA_ID
  )

  return {
    datasetId,
    accessToken,
    testEventCode,
    pageId,
    whatsappBusinessAccountId
  }
}

async function getContactForMetaEvent(contactId) {
  if (!contactId) return null

  return db.get(
    `SELECT
       id,
       phone,
       email,
       full_name,
       first_name,
       last_name,
       attribution_ctwa_clid,
       attribution_ad_id,
       attribution_ad_name,
       COALESCE(meta_schedule_event_sent, 0) as meta_schedule_event_sent,
       meta_schedule_event_sent_at,
       meta_schedule_event_id,
       COALESCE(meta_purchase_event_sent, 0) as meta_purchase_event_sent,
       meta_purchase_event_sent_at,
       meta_purchase_event_id
     FROM contacts
     WHERE id = ?`,
    [contactId]
  )
}

async function getLatestWhatsappAttribution(contact) {
  if (!contact?.id) return null

  const uniquePhoneCandidates = buildPhoneMatchCandidates(contact.phone)
  const phoneFilter = uniquePhoneCandidates.length
    ? ` OR phone IN (${uniquePhoneCandidates.map(() => '?').join(', ')})`
    : ''

  const legacyRows = await db.all(
    `SELECT
       'legacy' as attribution_source,
       referral_ctwa_clid,
       referral_source_id,
       referral_source_type,
       referral_source_url,
       referral_headline,
       ad_id_thru_message,
       created_at
     FROM whatsapp_attribution
     WHERE contact_id = ?${phoneFilter}
       AND (
         COALESCE(referral_ctwa_clid, '') != ''
         OR COALESCE(referral_source_id, '') != ''
         OR COALESCE(referral_source_url, '') != ''
         OR COALESCE(referral_headline, '') != ''
         OR COALESCE(ad_id_thru_message, '') != ''
       )`,
    [contact.id, ...uniquePhoneCandidates]
  )

  const apiPhoneFilter = uniquePhoneCandidates.length
    ? ` OR msg.phone IN (${uniquePhoneCandidates.map(() => '?').join(', ')})
        OR attr.phone IN (${uniquePhoneCandidates.map(() => '?').join(', ')})`
    : ''

  const apiRows = await db.all(
    `SELECT
       'whatsapp_api' as attribution_source,
       COALESCE(attr.detected_ctwa_clid, msg.detected_ctwa_clid) as referral_ctwa_clid,
       COALESCE(attr.detected_source_id, msg.detected_source_id) as referral_source_id,
       COALESCE(attr.detected_source_type, msg.detected_source_type) as referral_source_type,
       COALESCE(attr.detected_source_url, msg.detected_source_url) as referral_source_url,
       COALESCE(attr.detected_headline, msg.detected_headline) as referral_headline,
       COALESCE(attr.detected_source_id, msg.detected_source_id) as ad_id_thru_message,
       COALESCE(attr.created_at, msg.created_at) as created_at
     FROM whatsapp_api_messages msg
     LEFT JOIN whatsapp_api_attribution attr ON attr.whatsapp_api_message_id = msg.id
     WHERE (msg.contact_id = ? OR attr.contact_id = ?${apiPhoneFilter})
       AND msg.direction = 'inbound'
       AND (
         COALESCE(attr.detected_ctwa_clid, msg.detected_ctwa_clid, '') != ''
         OR COALESCE(attr.detected_source_id, msg.detected_source_id, '') != ''
         OR COALESCE(attr.detected_source_url, msg.detected_source_url, '') != ''
         OR COALESCE(attr.detected_headline, msg.detected_headline, '') != ''
       )`,
    [contact.id, contact.id, ...uniquePhoneCandidates, ...uniquePhoneCandidates]
  )

  const rows = [...legacyRows, ...apiRows]
  if (!rows.length) return null

  return rows.sort((a, b) => {
    const aHasCtwa = cleanString(a.referral_ctwa_clid) ? 1 : 0
    const bHasCtwa = cleanString(b.referral_ctwa_clid) ? 1 : 0
    if (aHasCtwa !== bHasCtwa) return bHasCtwa - aHasCtwa

    const aTime = Date.parse(a.created_at || '') || 0
    const bTime = Date.parse(b.created_at || '') || 0
    return bTime - aTime
  })[0]
}

async function logMetaEvent({
  contactId,
  eventType,
  metaEventName,
  eventId,
  status,
  requestPayload = null,
  responsePayload = null,
  errorMessage = null
}) {
  await db.run(
    `INSERT INTO meta_conversion_event_logs (
       contact_id,
       event_type,
       meta_event_name,
       event_id,
       status,
       request_payload,
       response_payload,
       error_message,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      contactId || null,
      eventType,
      metaEventName,
      eventId,
      status,
      requestPayload ? jsonForLog(requestPayload) : null,
      responsePayload ? jsonForLog(responsePayload) : null,
      errorMessage || null
    ]
  )
}

function contactAlreadySent(contact, eventType) {
  const fields = CONTACT_SENT_FIELDS[eventType]
  return Boolean(fields && Number(contact?.[fields.sent] || 0) === 1)
}

async function markContactEventSent(contactId, eventType, eventId) {
  const fields = CONTACT_SENT_FIELDS[eventType]
  if (!fields) return

  await db.run(
    `UPDATE contacts
     SET ${fields.sent} = 1,
         ${fields.sentAt} = CURRENT_TIMESTAMP,
         ${fields.eventId} = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [eventId, contactId]
  )
}

async function postEventToMeta({ datasetId, accessToken, payload }) {
  const url = `${API_URLS.META_GRAPH}/${encodeURIComponent(datasetId)}/events?access_token=${encodeURIComponent(accessToken)}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })

  let responsePayload = null
  const responseText = await response.text()
  try {
    responsePayload = responseText ? JSON.parse(responseText) : {}
  } catch {
    responsePayload = { raw: responseText }
  }

  if (!response.ok || responsePayload?.error) {
    const message = responsePayload?.error?.message || `Meta CAPI error ${response.status}`
    const error = new Error(message)
    error.responsePayload = responsePayload
    throw error
  }

  return responsePayload
}

async function sendMetaWhatsappEvent({
  contactId,
  eventType,
  metaEventName,
  eventId,
  customData
}) {
  const contact = await getContactForMetaEvent(contactId)

  if (!contact) {
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'skipped',
      errorMessage: 'Contacto no encontrado'
    })
    return { sent: false, reason: 'contact_not_found' }
  }

  if (!contact.phone) {
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'skipped',
      errorMessage: 'Contacto sin teléfono'
    })
    return { sent: false, reason: 'missing_phone' }
  }

  if (contactAlreadySent(contact, eventType)) {
    return { sent: false, reason: 'already_sent' }
  }

  const whatsappAttribution = await getLatestWhatsappAttribution(contact)
  const metaConfig = await getMetaCapiConfig()
  if (!metaConfig.datasetId || !metaConfig.accessToken) {
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'error',
      errorMessage: 'Falta META_PIXEL_ID/DATASET_ID o META_ACCESS_TOKEN/Pixel API Token'
    })
    return { sent: false, reason: 'missing_meta_config' }
  }

  const userData = buildBusinessMessagingUserData(contact, metaConfig, whatsappAttribution)
  if (!userData.ph || !userData.external_id) {
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'skipped',
      errorMessage: 'user_data insuficiente para Meta'
    })
    return { sent: false, reason: 'insufficient_user_data' }
  }

  if (!userData.ctwa_clid) {
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'skipped',
      errorMessage: 'Falta ctwa_clid para atribuir el evento de WhatsApp'
    })
    return { sent: false, reason: 'missing_ctwa_clid' }
  }

  const enrichedCustomData = buildBusinessMessagingCustomData(customData, contact, whatsappAttribution)
  const payload = {
    data: [
      {
        event_name: metaEventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        event_id: eventId,
        user_data: userData,
        custom_data: enrichedCustomData
      }
    ]
  }

  if (metaConfig.testEventCode) {
    payload.test_event_code = metaConfig.testEventCode
  }

  try {
    const responsePayload = await postEventToMeta({
      datasetId: metaConfig.datasetId,
      accessToken: metaConfig.accessToken,
      payload
    })

    await markContactEventSent(contactId, eventType, eventId)
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'success',
      requestPayload: payload,
      responsePayload
    })

    logger.info(`✅ Evento WhatsApp ${eventType} enviado a Meta para contacto ${contactId}`)
    return { sent: true, eventId, responsePayload }
  } catch (error) {
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'error',
      requestPayload: payload,
      responsePayload: error.responsePayload || null,
      errorMessage: error.message
    })

    logger.error(`Error enviando evento WhatsApp ${eventType} a Meta para contacto ${contactId}: ${error.message}`)
    return { sent: false, reason: 'meta_error', error: error.message }
  }
}

export function isSuccessfulPaymentStatus(status) {
  return SUCCESS_PAYMENT_STATUSES.has(String(status || '').trim().toLowerCase())
}

/**
 * Calendarios marcados para atribución. Devuelve `null` cuando no hay ninguno
 * seleccionado, lo que significa "todos" (sin filtro).
 */
async function getAttributionCalendarIds() {
  try {
    const config = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      ['attribution_calendar_ids']
    )

    if (!config || !config.config_value) {
      return null
    }

    const calendarIds = JSON.parse(config.config_value)
    return Array.isArray(calendarIds) && calendarIds.length > 0
      ? calendarIds.map((id) => String(id))
      : null
  } catch (error) {
    logger.warn(`Error al leer calendarios de atribución para eventos: ${error.message} - usando TODOS`)
    return null
  }
}

export async function triggerWhatsappAppointmentBookedEvent(contactId, options = {}) {
  if (!await getConfigBoolean(CONFIG_KEYS.scheduleEnabled, false)) {
    return { sent: false, reason: 'disabled' }
  }

  if (!contactId) {
    return { sent: false, reason: 'missing_contact_id' }
  }

  // El evento de conversión solo se dispara para citas de calendarios marcados
  // para atribución. Si no hay ninguno seleccionado (null) se envía para todos.
  // Si la cita no trae calendario, no bloqueamos (evita perder conversiones por
  // un payload incompleto).
  const attributionCalendarIds = await getAttributionCalendarIds()
  const calendarId = options.calendarId ? String(options.calendarId) : null
  if (attributionCalendarIds && calendarId && !attributionCalendarIds.includes(calendarId)) {
    return { sent: false, reason: 'calendar_not_attributed' }
  }

  const metaEventName = await getConfiguredEventName(CONFIG_KEYS.scheduleEventName, 'LeadSubmitted')
  const eventId = `schedule_contact_${contactId}`

  return sendMetaWhatsappEvent({
    contactId,
    eventType: EVENT_TYPES.schedule,
    metaEventName,
    eventId,
    customData: {
      source: 'whatsapp',
      conversion_type: EVENT_TYPES.schedule
    }
  })
}

export async function triggerWhatsappFirstPurchaseEvent(contactId, payment = {}) {
  if (!await getConfigBoolean(CONFIG_KEYS.purchaseEnabled, false)) {
    return { sent: false, reason: 'disabled' }
  }

  if (!contactId) {
    return { sent: false, reason: 'missing_contact_id' }
  }

  const paymentMode = String(payment.payment_mode || payment.paymentMode || '').trim().toLowerCase()
  if (paymentMode === 'test') {
    return { sent: false, reason: 'test_payment' }
  }

  const metaEventName = await getConfiguredEventName(CONFIG_KEYS.purchaseEventName, 'Purchase')
  const eventId = `purchase_contact_${contactId}`
  const value = normalizeAmount(payment.amount)
  const currency = normalizeCurrency(payment.currency)
  const customData = {
    currency,
    source: 'whatsapp',
    conversion_type: EVENT_TYPES.purchase
  }

  if (value !== null) {
    customData.value = value
  }

  return sendMetaWhatsappEvent({
    contactId,
    eventType: EVENT_TYPES.purchase,
    metaEventName,
    eventId,
    customData
  })
}

export async function triggerWhatsappPurchaseEventForPaymentRow(paymentId) {
  if (!paymentId) {
    return { sent: false, reason: 'missing_payment_id' }
  }

  const payment = await db.get(
    `SELECT id, contact_id, amount, currency, status
     FROM payments
     WHERE id = ?
       AND amount > 0
       AND ${nonTestPaymentCondition()}`,
    [paymentId]
  )

  if (!payment || !isSuccessfulPaymentStatus(payment.status)) {
    return { sent: false, reason: 'payment_not_successful' }
  }

  return triggerWhatsappFirstPurchaseEvent(payment.contact_id, payment)
}
