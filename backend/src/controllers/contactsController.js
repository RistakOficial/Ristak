import { db, getAppConfig } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { updateContactsStats } from '../utils/updateContactsStats.js'
import { resolveDateRange, resolveDateRangeWithGHLTimezone } from '../utils/dateUtils.js'
import { buildContactStats } from '../services/analyticsService.js'
import { getGHLClient } from '../services/ghlClient.js'
import {
  findContactByPhoneCandidates,
  getContactPhoneValues,
  getGhlContactIdForLocalContact,
  generateContactId,
  listContactPhoneNumbers,
  prepareContactPhoneUpsert,
  recordContactPhoneNumber
} from '../services/contactIdentityService.js'
import { getHiddenContactFilters, buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js'
import { recordAudit } from '../utils/auditLog.js'
import { nonTestPaymentCondition } from '../utils/paymentMode.js'
import { buildContactSearchClause, buildContactSearchRank, isPhoneSearchText, normalizePhoneDigits } from '../utils/searchText.js'
import { coalescedTimestampSortExpression, parseSortableTimestamp, timestampSortExpression, timestampSortParameterExpression } from '../utils/sqlTimestampSort.js'
import { normalizeTrafficSource, normalizeWhatsAppAttributionPlatform } from '../utils/trafficSourceNormalizer.js'
import { loadFirstWhatsAppAttributions, buildContactAttributionFields } from '../services/contactSourceService.js'
import { findWhatsAppProfilePictureUrl, getWhatsAppApiStatus, markLatestInboundWhatsAppApiMessageReadForContact, warmWhatsAppApiProfilePictures } from '../services/whatsappApiService.js'
import { markLatestInboundWhatsAppQrMessageReadForContact, warmWhatsAppQrProfilePictures } from '../services/whatsappQrService.js'
import { isMetaSocialMessagingEnabled, markLatestMetaSocialMessageReadForContact } from '../services/metaSocialMessagingService.js'
import {
  getChatUnreadCountsForUser,
  markChatContactReadForUser,
  markChatContactsReadForUser
} from '../services/chatReadStateService.js'
import {
  listContactCustomFieldDefinitions,
  prepareContactCustomFieldsForStorage,
  updateContactCustomFieldDefinition,
  upsertContactCustomFieldDefinition
} from '../services/contactCustomFieldDefinitionsService.js'
import {
  buildContactListPaymentStatsCte,
  buildContactListWhere,
  getContactAdvancedSort,
  getContactListSortExpression,
  normalizeContactAdvancedFilters,
  normalizeContactListQuickFilter,
  normalizeContactListTrackingFilters
} from '../services/contactListFilterService.js'
import {
  buildHighLevelCustomFieldsPayload,
  mergeContactCustomFields,
  parseContactCustomFields,
  serializeContactCustomFieldsForDb
} from '../utils/contactCustomFields.js'
import { buildPhoneMatchCandidates, normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { normalizePhoneForAccount } from '../utils/accountLocale.js'
import {
  isSuspiciousSharedVisitorId,
  isTrustedTrackingVisitorId
} from '../utils/trackingVisitorIdentity.js'
import {
  cancelContactBulkAction,
  createAutomationBulkAction,
  createWhatsAppTemplateBulkAction,
  deleteContactBulkAction,
  getContactBulkAction,
  listContactBulkActions,
  pauseContactBulkAction,
  rescheduleContactBulkAction,
  resumeContactBulkAction
} from '../services/contactBulkActionsService.js'
import {
  extractWhatsAppProfileName,
  normalizeWhatsAppProfileName,
  shouldReplaceWhatsAppApiContactName
} from '../utils/whatsappContactProfile.js'
import {
  formatContactName,
  normalizeContactNameFields,
  splitContactName
} from '../utils/contactNameFormatter.js'
import { detectWhatsAppAttributionFields } from '../utils/whatsappAttribution.js'
import { resolveTagIds, tagNamesForIds, listContactTags } from '../services/contactTagsService.js'
import { getEmailStatus } from '../services/emailService.js'
import { hasFeature } from '../services/licenseService.js'
import fetch from 'node-fetch'
import { randomUUID } from 'crypto'
import { extractConversationalAgentMessageMetadata } from '../utils/conversationalAgentMessageMetadata.js'

const CHAT_SEND_READ_RECEIPTS_CONFIG_KEY = 'chat_send_read_receipts_enabled'
const DISABLED_CONFIG_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled'])
const PROVIDER_READ_RECEIPT_TIMEOUT_MS = 3500
const CONTACT_ADVANCED_FILTER_FEATURES = [
  {
    feature: 'automations',
    matches: (field) => field === 'active_automation' || field.startsWith('automation_')
  },
  {
    feature: 'payment_plans',
    matches: (field) => field === 'has_payment_plan' || field.startsWith('payment_plan_')
  }
]

async function assertContactAdvancedFilterFeatureAccess(res, advancedFilterConfig = {}) {
  const fields = (advancedFilterConfig.groups || [])
    .flatMap((group) => Array.isArray(group?.rules) ? group.rules : [])
    .map((rule) => String(rule?.field || '').trim())
    .filter(Boolean)

  for (const rule of CONTACT_ADVANCED_FILTER_FEATURES) {
    if (!fields.some(rule.matches) || await hasFeature(rule.feature)) continue
    res.status(403).json({
      success: false,
      code: 'feature_not_available',
      feature: rule.feature,
      message: 'Esta función no está incluida en tu plan actual. Contacta al administrador para activarla.'
    })
    return false
  }

  return true
}

const isProviderReadReceiptsEnabled = (value) => {
  const normalizedValue = String(value ?? '').trim().toLowerCase()
  return !DISABLED_CONFIG_VALUES.has(normalizedValue)
}

const normalizePhone = (phone) => {
  if (!phone) return null
  const digits = String(phone).replace(/\D/g, '')
  if (digits.length < 7) return null
  return digits.slice(-10)
}

function withProviderReadReceiptTimeout(key, task) {
  let timeoutId
  const taskPromise = Promise.resolve().then(task)
  taskPromise.catch(() => null)

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`provider_read_timeout:${key}`))
    }, PROVIDER_READ_RECEIPT_TIMEOUT_MS)
    if (typeof timeoutId?.unref === 'function') timeoutId.unref()
  })

  return Promise.race([taskPromise, timeoutPromise])
    .finally(() => {
      if (timeoutId) clearTimeout(timeoutId)
    })
}

async function runProviderReadReceiptsForContact(contactId) {
  const cleanContactId = cleanString(contactId)
  if (!cleanContactId) return {}

  const providerRead = {}
  const providerReadResults = await Promise.allSettled([
    withProviderReadReceiptTimeout('whatsappApi', () => markLatestInboundWhatsAppApiMessageReadForContact({ contactId: cleanContactId })),
    withProviderReadReceiptTimeout('whatsappQr', () => markLatestInboundWhatsAppQrMessageReadForContact({ contactId: cleanContactId })),
    withProviderReadReceiptTimeout('meta', () => markLatestMetaSocialMessageReadForContact({ contactId: cleanContactId }))
  ])

  ;[
    ['whatsappApi', providerReadResults[0]],
    ['whatsappQr', providerReadResults[1]],
    ['meta', providerReadResults[2]]
  ].forEach(([key, result]) => {
    if (result.status === 'fulfilled') {
      providerRead[key] = result.value
      return
    }
    providerRead[key] = { attempted: false, error: true, reason: result.reason?.message || 'provider_read_failed' }
    logger.warn(`No se pudo marcar como leído en ${key} para ${cleanContactId}: ${result.reason?.message || result.reason}`)
  })

  return providerRead
}

function queueProviderReadReceiptsForContact(contactId) {
  const cleanContactId = cleanString(contactId)
  if (!cleanContactId) return

  const run = () => {
    void runProviderReadReceiptsForContact(cleanContactId).catch(error => {
      logger.warn(`No se pudieron procesar vistos externos para ${cleanContactId}: ${error.message}`)
    })
  }

  if (typeof setImmediate === 'function') {
    setImmediate(run)
    return
  }

  setTimeout(run, 0)
}

const parseContactTags = (raw) => {
  if (Array.isArray(raw)) return raw
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const dedupeAppointments = (appointments = []) => {
  const map = new Map()
  for (const appointment of appointments) {
    if (!appointment) continue
    const key = appointment.id || `${appointment.start_time || ''}-${appointment.title || ''}`
    if (!map.has(key)) {
      map.set(key, appointment)
    }
  }
  return Array.from(map.values())
}

const buildContactPhoneCandidates = (phone) => {
  return [...new Set([
    normalizePhoneForStorage(phone),
    cleanString(phone)
  ].filter(Boolean))]
}

const appendSqlInClause = (clauses, params, column, values = []) => {
  const uniqueValues = [...new Set(values.map(cleanString).filter(Boolean))]
  if (!uniqueValues.length) return

  clauses.push(`${column} IN (${uniqueValues.map(() => '?').join(', ')})`)
  params.push(...uniqueValues)
}

const collectBusinessPhoneMatchCandidates = (...values) => {
  const candidates = new Set()
  values.forEach((value) => {
    buildPhoneMatchCandidates(value).forEach((candidate) => candidates.add(candidate))
  })
  return [...candidates]
}

const resolveRelatedBusinessPhoneFilters = async ({ phoneNumberId, businessPhone } = {}) => {
  const phoneIds = new Set()
  const phoneCandidates = new Set(collectBusinessPhoneMatchCandidates(businessPhone))
  const cleanPhoneNumberId = cleanString(phoneNumberId)
  if (cleanPhoneNumberId) phoneIds.add(cleanPhoneNumberId)

  if (!cleanPhoneNumberId && !phoneCandidates.size) {
    return { phoneIds: [], phoneCandidates: [] }
  }

  const rows = await db.all(`
    SELECT id, phone_number, display_phone_number, qr_connected_phone
    FROM whatsapp_api_phone_numbers
  `).catch(() => [])

  const seedRows = cleanPhoneNumberId
    ? rows.filter(row => row.id === cleanPhoneNumberId)
    : []

  for (const row of seedRows) {
    collectBusinessPhoneMatchCandidates(row.phone_number, row.display_phone_number, row.qr_connected_phone)
      .forEach((candidate) => phoneCandidates.add(candidate))
  }

  for (const row of rows) {
    const rowCandidates = collectBusinessPhoneMatchCandidates(row.phone_number, row.display_phone_number, row.qr_connected_phone)
    const matchesFilter = rowCandidates.some((candidate) => phoneCandidates.has(candidate))
    if (!matchesFilter) continue

    phoneIds.add(cleanString(row.id))
    rowCandidates.forEach((candidate) => phoneCandidates.add(candidate))
  }

  return {
    phoneIds: [...phoneIds].filter(Boolean),
    phoneCandidates: [...phoneCandidates].filter(Boolean)
  }
}

const buildWhatsAppApiMessageContactMatch = (contactId, phoneCandidates = [], alias = 'msg', profileAlias = 'api_profile') => {
  const cleanContactId = cleanString(contactId)
  const cleanPhoneCandidates = [...new Set(phoneCandidates.map(cleanString).filter(Boolean))]
  if (!cleanPhoneCandidates.length) {
    return {
      condition: `${alias}.contact_id = ?`,
      params: [cleanContactId]
    }
  }

  const placeholders = cleanPhoneCandidates.map(() => '?').join(', ')
  const phoneColumns = [
    `${alias}.phone`,
    `${alias}.from_phone`,
    `${alias}.to_phone`,
    `${profileAlias}.phone`
  ]

  return {
    condition: `(${alias}.contact_id = ? OR ${phoneColumns.map(column => `${column} IN (${placeholders})`).join(' OR ')})`,
    params: [
      cleanContactId,
      ...phoneColumns.flatMap(() => cleanPhoneCandidates)
    ]
  }
}

const APPOINTMENT_CANCELED_STATUSES = new Set([
  'cancelled',
  'canceled',
  'no_show',
  'noshow',
  'invalid',
  'failed',
  'missed',
  'deleted',
  'void',
  'voided'
])
const APPOINTMENT_ATTENDED_STATUSES = new Set(['showed', 'attended', 'completed', 'complete'])
const sqlList = values => [...values].map(value => `'${value}'`).join(', ')
const isPostgresDatabase = Boolean(process.env.DATABASE_URL)
const ACTIVE_APPOINTMENT_CONDITION = `LOWER(COALESCE(appointment_status, status, '')) NOT IN (${sqlList(APPOINTMENT_CANCELED_STATUSES)})`
const ATTENDED_APPOINTMENT_CONDITION = `LOWER(COALESCE(appointment_status, status, '')) IN (${sqlList(APPOINTMENT_ATTENDED_STATUSES)})`
const CONFIRMATION_BADGE_CONDITION = isPostgresDatabase
  ? 'confirmation_badge_until IS NOT NULL AND confirmation_badge_until > CURRENT_TIMESTAMP'
  : `COALESCE(confirmation_badge_until, '') != '' AND datetime(confirmation_badge_until) > datetime('now')`
const CONTACT_WHATSAPP_PROFILE_SELECTS = `
        (
          SELECT profile_name
          FROM whatsapp_api_contacts
          WHERE contact_id = c.id
             OR phone = c.phone
             OR phone IN (SELECT phone FROM contact_phone_numbers WHERE contact_id = c.id)
          ORDER BY updated_at DESC
          LIMIT 1
        ) AS whatsapp_profile_name,
        (
          SELECT raw_profile_json
          FROM whatsapp_api_contacts
          WHERE contact_id = c.id
             OR phone = c.phone
             OR phone IN (SELECT phone FROM contact_phone_numbers WHERE contact_id = c.id)
          ORDER BY updated_at DESC
          LIMIT 1
        ) AS whatsapp_raw_profile_json,
        (
          SELECT profile_picture_url
          FROM whatsapp_api_contacts
          WHERE contact_id = c.id
             OR phone = c.phone
             OR phone IN (SELECT phone FROM contact_phone_numbers WHERE contact_id = c.id)
          ORDER BY CASE WHEN NULLIF(profile_picture_url, '') IS NULL THEN 1 ELSE 0 END,
                   profile_picture_updated_at DESC,
                   updated_at DESC
          LIMIT 1
        ) AS whatsapp_profile_picture_url,
        (
          SELECT profile_picture_updated_at
          FROM whatsapp_api_contacts
          WHERE contact_id = c.id
             OR phone = c.phone
             OR phone IN (SELECT phone FROM contact_phone_numbers WHERE contact_id = c.id)
          ORDER BY profile_picture_updated_at DESC, updated_at DESC
          LIMIT 1
        ) AS whatsapp_profile_picture_updated_at`
const CONTACT_META_PROFILE_SELECT = `
        (
          SELECT profile_picture_url
          FROM meta_social_contacts
          WHERE contact_id = c.id
          ORDER BY updated_at DESC
          LIMIT 1
        ) AS meta_social_profile_picture_url,
        (
          SELECT profile_name
          FROM meta_social_contacts
          WHERE contact_id = c.id
          ORDER BY updated_at DESC
          LIMIT 1
        ) AS meta_social_profile_name,
        (
          SELECT username
          FROM meta_social_contacts
          WHERE contact_id = c.id
          ORDER BY updated_at DESC
          LIMIT 1
        ) AS meta_social_username`

// Comentario vs DM ya NO es identidad de contacto (la misma persona = un solo
// contacto por red). La distinción vive a NIVEL MENSAJE (message_type). Dos flags
// para la bandeja de chat:
//  - has_comment_message: el contacto tiene algún comentario.
//  - has_private_dm: el contacto tiene algún mensaje privado real (no-comentario).
// "Solo comentario" (va al tab Comentarios) = has_comment_message && !has_private_dm.
const COMMENT_MESSAGE_TYPES_SQL = `('comment', 'comment_reply_public', 'comment_reply_private')`
const CONTACT_META_MESSAGE_FLAGS_SELECT = `
        (
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM meta_social_messages m
            WHERE m.contact_id = c.id
              AND m.message_type IN ${COMMENT_MESSAGE_TYPES_SQL}
          ) THEN 1 ELSE 0 END
        ) AS meta_has_comment_message,
        (
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM meta_social_messages m
            WHERE m.contact_id = c.id
              AND COALESCE(m.message_type, '') NOT IN ${COMMENT_MESSAGE_TYPES_SQL}
          ) THEN 1 ELSE 0 END
        ) AS meta_has_private_dm`

const cleanString = (value) => String(value || '').trim()
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key)
const isTruthyQueryValue = (value) => ['1', 'true', 'yes', 'si', 'sí'].includes(cleanString(value).toLowerCase())
const isExplicitFalseQueryValue = (value) => ['0', 'false', 'no', 'off'].includes(cleanString(value).toLowerCase())
const hasTextValue = (value) => cleanString(value).length > 0
const JOURNEY_MESSAGE_MAX_LIMIT = 500
const META_COMMENT_DELETED_TEXT = 'Comentario eliminado'
const META_COMMENT_EMPTY_TEXT = 'Comentario sin texto'
const META_COMMENT_PUBLIC_REPLY_TEXT = 'Respuesta pública al comentario'
const META_COMMENT_PRIVATE_REPLY_TEXT = 'Respuesta por privado al comentario'
const META_POST_DELETED_TEXT = 'Publicación eliminada'
const META_COMMENT_MESSAGE_TYPES = new Set(['comment', 'comment_reply_public', 'comment_reply_private'])
const META_REMOVED_COMMENT_STATUSES = new Set(['removed', 'deleted', 'delete', 'remove', 'hide', 'hidden'])

const isMetaCommentMessageType = (value) => META_COMMENT_MESSAGE_TYPES.has(cleanString(value).toLowerCase())

const isMetaPostDeletedForChat = (row = {}) => cleanString(row.post_type).toLowerCase() === 'deleted'

const getMetaCommentFallbackText = (row = {}) => {
  const type = cleanString(row.message_type).toLowerCase()
  if (!isMetaCommentMessageType(type)) return ''
  const status = cleanString(row.status).toLowerCase()
  if (META_REMOVED_COMMENT_STATUSES.has(status) || isMetaPostDeletedForChat(row)) return META_COMMENT_DELETED_TEXT
  if (type === 'comment_reply_public') return META_COMMENT_PUBLIC_REPLY_TEXT
  if (type === 'comment_reply_private') return META_COMMENT_PRIVATE_REPLY_TEXT
  return META_COMMENT_EMPTY_TEXT
}

const getMetaMessageTextForChat = (row = {}) => {
  return cleanString(row.message_text) || getMetaCommentFallbackText(row)
}

const getMetaPostMessageForChat = (row = {}) => {
  const postMessage = cleanString(row.post_message)
  if (postMessage) return postMessage
  return isMetaPostDeletedForChat(row) ? META_POST_DELETED_TEXT : ''
}

const getMetaSourceLabelForChat = (platform, messageType) => {
  const cleanPlatform = cleanString(platform).toLowerCase()
  const isComment = isMetaCommentMessageType(messageType)
  if (cleanPlatform === 'instagram') return isComment ? 'Instagram' : 'Instagram DM'
  return isComment ? 'Facebook' : 'Messenger'
}

const parseJourneyMessageLimit = (value) => {
  if (value === undefined || value === null || value === '') return null
  const limit = Number(value)
  if (!Number.isFinite(limit) || limit <= 0) return null
  return Math.min(Math.max(Math.round(limit), 1), JOURNEY_MESSAGE_MAX_LIMIT)
}

const parseJourneyMessageBefore = (value) => {
  const raw = cleanString(value)
  if (!raw) return null
  return parseSortableTimestamp(raw) > 0 ? raw : null
}

const parseJourneyMessageCursor = (value) => {
  const raw = cleanString(value)
  if (!raw || raw.length > 512) return null
  return raw
}

const buildJourneyMessageCursorKey = (prefix, value) => {
  const cleanValue = cleanString(value)
  return cleanValue ? `${prefix}:${cleanValue}` : ''
}

const journeyMessageCursorSqlExpression = (prefix, valueExpression) => {
  const identity = `('${prefix}:' || CAST(${valueExpression} AS TEXT))`
  return isPostgresDatabase
    ? `(${identity} COLLATE "C")`
    : `(${identity} COLLATE BINARY)`
}

const appendJourneyMessageBeforeParams = (params, beforeDate, beforeCursor) => {
  if (!beforeDate) return params
  return beforeCursor
    ? [...params, beforeDate, beforeDate, beforeCursor]
    : [...params, beforeDate]
}

// Cursor compuesto para que dos mensajes con el mismo instante no se pierdan
// entre paginas. beforeMessageDate sin cursor conserva el contrato legacy (<).
const journeyMessageBeforeClause = (
  timestampExpression,
  cursorIdentityExpression,
  beforeDate,
  beforeCursor
) => {
  if (!beforeDate) return ''
  const timestampSort = timestampSortExpression(timestampExpression)
  const cursorTimestampSort = timestampSortParameterExpression()
  if (!beforeCursor) return `AND ${timestampSort} < ${cursorTimestampSort}`
  return `AND (
    ${timestampSort} < ${cursorTimestampSort}
    OR (
      ${timestampSort} = ${cursorTimestampSort}
      AND ${cursorIdentityExpression} < ?
    )
  )`
}

const compareJourneyMessagesByCursor = (left, right) => {
  const timestampDifference = parseSortableTimestamp(left?.date) - parseSortableTimestamp(right?.date)
  if (timestampDifference !== 0) return timestampDifference
  const leftCursor = cleanString(left?.cursorKey)
  const rightCursor = cleanString(right?.cursorKey)
  if (leftCursor === rightCursor) return 0
  return leftCursor < rightCursor ? -1 : 1
}

const appendOptionalLimitParam = (params, limit) => (
  limit ? [...params, limit] : params
)

const optionalLimitClause = (limit) => (limit ? 'LIMIT ?' : '')
const sourceTypeLooksLikeAd = (value) => {
  const normalized = cleanString(value).toLowerCase().replace(/[\s-]+/g, '_')
  return ['ad', 'ads', 'advertisement', 'click_to_whatsapp', 'ctwa'].includes(normalized)
}

const hasRealWhatsAppAdAttribution = (data = {}) => {
  const hasAdIdentifier = [
    data.referral_source_id,
    data.source_id,
    data.ad_id,
    data.ad_id_thru_message,
    data.attribution_ad_id,
    data.referral_ctwa_clid,
    data.ctwa_clid,
    data.attribution_ctwa_clid
  ].some(hasTextValue)

  if (hasAdIdentifier) return true

  const sourceUrl = cleanString(data.referral_source_url || data.source_url || data.attribution_url)
  if (!sourceUrl) return false

  return [
    data.referral_source_type,
    data.source_type,
    data.referral_source_app,
    data.source_app,
    data.referral_entry_point,
    data.entry_point
  ].some(sourceTypeLooksLikeAd)
}

const GENERIC_TRAFFIC_SOURCES = new Set(['Directo', 'Desconocido', 'Otro'])
const WEB_CONVERSION_EVENT_PATTERN = /(conversion|submit|form|lead|contact|registro|captura)/i
const WEB_SOURCE_PATTERN = /(ristak_site|native_site|site|website|web|form|landing|pagina|página)/i
const WHATSAPP_SOURCE_PATTERN = /(whatsapp|waapi|ycloud|click_to_whatsapp|ctwa)/i

const isGenericTrafficSource = (source) => GENERIC_TRAFFIC_SOURCES.has(cleanString(source))
const sourceLooksWhatsApp = (source) => WHATSAPP_SOURCE_PATTERN.test(cleanString(source))

const getSessionSourceLabel = (session = {}) => normalizeTrafficSource({
  referrer_url: session.referrer_url,
  site_source_name: session.site_source_name,
  utm_source: session.utm_source,
  source_platform: session.source_platform
})

const hasNativeSiteSignal = (session = {}) => Boolean(
  cleanString(session.tracking_source).toLowerCase() === 'native_site' ||
  cleanString(session.site_id) ||
  cleanString(session.site_slug) ||
  cleanString(session.site_name) ||
  cleanString(session.form_site_id) ||
  cleanString(session.form_site_name) ||
  cleanString(session.public_page_id) ||
  cleanString(session.public_page_title)
)

const hasWebConversionSignal = (session = {}) => Boolean(
  cleanString(session.submission_id) ||
  cleanString(session.form_site_id) ||
  cleanString(session.form_site_name) ||
  WEB_CONVERSION_EVENT_PATTERN.test(cleanString(session.conversion_type)) ||
  WEB_CONVERSION_EVENT_PATTERN.test(cleanString(session.event_name))
)

const getWebSessionScore = (session = {}) => {
  let score = 0
  const source = getSessionSourceLabel(session)
  const nativeSite = hasNativeSiteSignal(session)
  const webConversion = hasWebConversionSignal(session)

  if (nativeSite && webConversion) score += 100
  else if (webConversion) score += 70
  else if (nativeSite) score += 45

  if (cleanString(session.submission_id)) score += 35
  if (cleanString(session.form_site_id) || cleanString(session.form_site_name)) score += 30
  if (WEB_CONVERSION_EVENT_PATTERN.test(cleanString(session.conversion_type))) score += 20
  if (WEB_CONVERSION_EVENT_PATTERN.test(cleanString(session.event_name))) score += 15
  if (cleanString(session.page_url) || cleanString(session.landing_page)) score += 10
  if (source && !isGenericTrafficSource(source)) score += sourceLooksWhatsApp(source) ? 5 : 25

  return score
}

const pickPrimaryWebConversionSession = (sessions = []) => {
  const scored = [...sessions]
    .map(session => ({ session, score: getWebSessionScore(session) }))
    .filter(item => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      const leftTime = parseSortableTimestamp(left.session.started_at || left.session.created_at)
      const rightTime = parseSortableTimestamp(right.session.started_at || right.session.created_at)
      return (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0)
    })

  return scored[0] || null
}

function getContactWebScore(contact = {}) {
  let score = 0
  const source = cleanString(contact.source)
  const attributionSource = normalizeTrafficSource({
    referrer_url: contact.attribution_url,
    site_source_name: contact.attribution_session_source,
    utm_source: contact.attribution_medium,
    source
  })

  if (WEB_SOURCE_PATTERN.test(source)) score += 65
  if (cleanString(contact.attribution_url) && !sourceLooksWhatsApp(contact.attribution_url)) score += 25
  if (cleanString(contact.attribution_session_source) && !sourceLooksWhatsApp(contact.attribution_session_source)) score += 20
  if (cleanString(contact.attribution_medium) && !sourceLooksWhatsApp(contact.attribution_medium)) score += 15
  if ((cleanString(contact.attribution_ad_id) || cleanString(contact.attribution_ad_name)) && !sourceLooksWhatsApp(source)) score += 10
  if (attributionSource && !isGenericTrafficSource(attributionSource)) score += sourceLooksWhatsApp(attributionSource) ? 5 : 20

  return score
}

const buildWebConversionJourneyDataFromSession = (session = null) => {
  if (!session) return null

  return {
    conversion_channel: 'web',
    conversion_source: getSessionSourceLabel(session),
    event_name: session.event_name,
    page_url: session.page_url,
    landing_page: session.landing_page || session.page_url,
    referrer_url: session.referrer_url,
    utm_source: session.utm_source,
    utm_medium: session.utm_medium,
    utm_campaign: session.utm_campaign,
    utm_term: session.utm_term,
    utm_content: session.utm_content,
    gclid: session.gclid,
    fbclid: session.fbclid,
    fbc: session.fbc,
    fbp: session.fbp,
    wbraid: session.wbraid,
    gbraid: session.gbraid,
    msclkid: session.msclkid,
    ttclid: session.ttclid,
    channel: session.channel,
    source_platform: session.source_platform,
    site_source_name: session.site_source_name,
    campaign_id: session.campaign_id,
    campaign_name: session.campaign_name || session.utm_campaign,
    adset_id: session.adset_id,
    adset_name: session.adset_name,
    ad_group_id: session.ad_group_id,
    ad_group_name: session.ad_group_name,
    ad_name: session.ad_name || session.utm_content,
    ad_id: session.ad_id,
    placement: session.placement,
    network: session.network,
    match_type: session.match_type,
    keyword: session.keyword,
    search_query: session.search_query,
    creative_id: session.creative_id,
    ad_position: session.ad_position,
    attribution_ad_name: session.ad_name || session.utm_content,
    attribution_ad_id: session.ad_id,
    tracking_source: session.tracking_source,
    site_id: session.site_id,
    site_slug: session.site_slug,
    site_name: session.site_name,
    site_type: session.site_type,
    form_site_id: session.form_site_id,
    form_site_name: session.form_site_name,
    public_page_id: session.public_page_id,
    public_page_title: session.public_page_title,
    conversion_type: session.conversion_type,
    submission_id: session.submission_id,
    match_method: session.match_method,
    match_confidence: toFiniteNumber(session.match_confidence),
    identity_evidence: parseJourneyJsonObject(session.identity_evidence_json),
    origin_confidence_score: getWebSessionScore(session)
  }
}

const buildWebConversionJourneyDataFromContact = (contact = {}) => {
  const source = normalizeTrafficSource({
    referrer_url: contact.attribution_url,
    site_source_name: contact.attribution_session_source,
    utm_source: contact.attribution_medium,
    source: contact.source
  })
  const sourceLabel = source && !isGenericTrafficSource(source) ? source : ''

  return {
    conversion_channel: 'web',
    conversion_source: sourceLabel || 'Sitio web',
    page_url: contact.attribution_url,
    referrer_url: contact.attribution_url,
    utm_source: contact.attribution_session_source,
    utm_medium: contact.attribution_medium,
    source_platform: contact.attribution_session_source,
    site_source_name: contact.attribution_session_source,
    ad_name: contact.attribution_ad_name,
    ad_id: contact.attribution_ad_id,
    attribution_ad_name: contact.attribution_ad_name,
    attribution_ad_id: contact.attribution_ad_id,
    origin_confidence_score: getContactWebScore(contact)
  }
}

const resolveWebConversionEvidence = (contact = {}, sessions = []) => {
  const sessionEvidence = pickPrimaryWebConversionSession(sessions)
  const contactScore = getContactWebScore(contact)
  const candidates = [
    sessionEvidence ? {
      score: sessionEvidence.score,
      data: buildWebConversionJourneyDataFromSession(sessionEvidence.session),
      source: 'session'
    } : null,
    contactScore > 0 ? {
      score: contactScore,
      data: buildWebConversionJourneyDataFromContact(contact),
      source: 'contact'
    } : null
  ].filter(Boolean)

  return candidates.sort((left, right) => right.score - left.score)[0] || { score: 0, data: null, source: null }
}

const OUTBOUND_JOURNEY_MESSAGE_DIRECTIONS = [
  'outbound',
  'outgoing',
  'sent',
  'business',
  'api',
  'app',
  'business_echo',
  'smb_echo',
  'echo',
  'message_echo'
]
const OUTBOUND_JOURNEY_MESSAGE_DIRECTION_SET = new Set(OUTBOUND_JOURNEY_MESSAGE_DIRECTIONS)
const isOutboundWhatsAppDirection = (direction) =>
  OUTBOUND_JOURNEY_MESSAGE_DIRECTION_SET.has(cleanString(direction).toLowerCase())

const getWhatsAppEventScore = (event = {}, contactCreatedAt = null) => {
  const data = event.data || {}
  if (event.type !== 'whatsapp_message') return 0
  if (isOutboundWhatsAppDirection(data.direction)) return 0

  let score = 35
  if (hasRealWhatsAppAdAttribution(data) || data.is_ad_attributed) score += 45
  if (cleanString(data.referral_ctwa_clid)) score += 25
  if (cleanString(data.referral_source_id) || cleanString(data.attribution_ad_id)) score += 20
  if (cleanString(data.referral_source_app) || cleanString(data.referral_entry_point)) score += 10

  const contactTime = contactCreatedAt ? parseSortableTimestamp(contactCreatedAt) : null
  const eventTime = event.date ? parseSortableTimestamp(event.date) : null
  if (Number.isFinite(contactTime) && Number.isFinite(eventTime)) {
    score += eventTime <= contactTime + 5 * 60 * 1000 ? 25 : -20
  }

  return Math.max(score, 0)
}

const resolveWhatsAppConversionEvidence = (contact = {}, whatsappEvents = []) => {
  const contactSourceScore = sourceLooksWhatsApp(contact.source) ? 45 : 0
  const eventEvidence = whatsappEvents
    .map(event => ({ event, score: getWhatsAppEventScore(event, contact.created_at) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score)[0]

  if (eventEvidence && eventEvidence.score >= contactSourceScore) {
    return { score: eventEvidence.score, event: eventEvidence.event, source: 'whatsapp_event' }
  }

  return { score: contactSourceScore, event: null, source: contactSourceScore ? 'contact_source' : null }
}

const resolveContactJourneyOrigin = ({ contact = {}, sessions = [], whatsappEvents = [] } = {}) => {
  const web = resolveWebConversionEvidence(contact, sessions)
  const whatsapp = resolveWhatsAppConversionEvidence(contact, whatsappEvents)

  if (web.score > 0 && web.score >= whatsapp.score) {
    return { channel: 'web', webData: web.data, whatsappEvent: null, scores: { web: web.score, whatsapp: whatsapp.score } }
  }

  if (whatsapp.score > 0) {
    return { channel: 'whatsapp', webData: null, whatsappEvent: whatsapp.event, scores: { web: web.score, whatsapp: whatsapp.score } }
  }

  return { channel: null, webData: null, whatsappEvent: null, scores: { web: web.score, whatsapp: whatsapp.score } }
}

const toFiniteNumber = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

const parseJourneyJsonObject = (value) => {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value

  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const buildPreRegistrationJourneyMeta = (eventDate, contactCreatedAt) => {
  const eventTime = parseSortableTimestamp(eventDate)
  const contactTime = parseSortableTimestamp(contactCreatedAt)

  if (!Number.isFinite(eventTime) || !Number.isFinite(contactTime) || eventTime <= 0 || contactTime <= 0) {
    return {
      is_pre_registration: false,
      contact_created_at: contactCreatedAt || null
    }
  }

  const millisecondsBeforeContact = contactTime - eventTime
  const isPreRegistration = millisecondsBeforeContact > 0

  return {
    is_pre_registration: isPreRegistration,
    contact_created_at: contactCreatedAt || null,
    minutes_before_contact: isPreRegistration
      ? Math.max(1, Math.round(millisecondsBeforeContact / 60000))
      : 0
  }
}

const normalizeJourneyPageUrl = (value) => {
  const raw = cleanString(value)
  if (!raw) return ''

  try {
    const parsed = new URL(raw, 'https://ristak.local')
    for (const param of ['no_track', 'preview', 'preview_mode', 'rstk_play_id']) {
      parsed.searchParams.delete(param)
    }
    parsed.hash = ''
    const host = parsed.hostname === 'ristak.local' ? '' : parsed.hostname.toLowerCase()
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/'
    const search = parsed.searchParams.toString()
    return `${host}${pathname}${search ? `?${search}` : ''}`.toLowerCase()
  } catch {
    return raw.split('#')[0].replace(/\/+$/, '').toLowerCase()
  }
}

const normalizeJourneyPagePath = (value) => {
  const raw = cleanString(value)
  if (!raw) return ''

  try {
    const parsed = new URL(raw, 'https://ristak.local')
    return (parsed.pathname.replace(/\/+$/, '') || '/').toLowerCase()
  } catch {
    const withoutQuery = raw.split('?')[0].split('#')[0]
    return (withoutQuery.replace(/\/+$/, '') || '/').toLowerCase()
  }
}

const buildVideoEngagementJourneyData = (row = {}, contact = {}) => {
  const maxPosition = Math.max(
    toFiniteNumber(row.max_position_seconds),
    toFiniteNumber(row.max_event_position_seconds),
    toFiniteNumber(row.last_position_seconds)
  )
  const eventDate = row.first_event_at || row.started_at || row.last_event_at

  return {
    id: row.id,
    playback_id: row.playback_id,
    visitor_id: row.visitor_id,
    session_id: row.session_id,
    media_asset_id: row.media_asset_id,
    stream_library_id: row.stream_library_id,
    stream_video_id: row.stream_video_id,
    video_provider: row.video_provider,
    video_title: row.video_title,
    tracking_source: row.tracking_source,
    site_id: row.site_id,
    site_slug: row.site_slug,
    site_name: row.site_name,
    site_type: row.site_type,
    form_site_id: row.form_site_id,
    form_site_name: row.form_site_name,
    public_page_id: row.public_page_id,
    public_page_title: row.public_page_title,
    block_id: row.block_id,
    block_label: row.block_label,
    page_url: row.page_url,
    referrer_url: row.referrer_url,
    duration_seconds: toFiniteNumber(row.duration_seconds),
    watched_seconds: toFiniteNumber(row.watched_seconds),
    start_position_seconds: toFiniteNumber(row.min_position_seconds),
    end_position_seconds: maxPosition,
    max_position_seconds: maxPosition,
    max_progress_percent: toFiniteNumber(row.max_progress_percent),
    play_count: toFiniteNumber(row.play_count),
    pause_count: toFiniteNumber(row.pause_count),
    seek_count: toFiniteNumber(row.seek_count),
    event_count: toFiniteNumber(row.event_count),
    ended: Boolean(row.ended),
    match_method: row.match_method,
    match_confidence: toFiniteNumber(row.match_confidence),
    identity_evidence: parseJourneyJsonObject(row.identity_evidence_json),
    first_event_at: eventDate,
    last_event_at: row.last_event_at || row.ended_at || row.first_event_at,
    ended_at: row.ended_at,
    standalone: false,
    ...buildPreRegistrationJourneyMeta(eventDate, contact.created_at)
  }
}

const getVideoEngagementKey = (video = {}) => cleanString(video.playback_id || video.id)

const getJourneyRowTime = (row = {}, fallback = 0) => {
  const raw = row.first_event_at || row.started_at || row.last_event_at || row.created_at || row.date
  const time = parseSortableTimestamp(raw)
  return Number.isFinite(time) ? time : fallback
}

const pickNearestSessionEntry = (video, sessionEntries, predicate) => {
  const candidates = sessionEntries.filter(({ session }) => predicate(session))
  if (!candidates.length) return null

  const videoTime = getJourneyRowTime(video)
  return candidates
    .map(entry => ({
      entry,
      distance: Math.abs(getJourneyRowTime(entry.session) - videoTime)
    }))
    .sort((left, right) => left.distance - right.distance)[0]?.entry || null
}

const findVideoSessionEntry = (video, sessionEntries) => {
  const sessionId = cleanString(video.session_id)
  if (sessionId) {
    const match = pickNearestSessionEntry(video, sessionEntries, session => cleanString(session.session_id) === sessionId)
    if (match) return match
  }

  const publicPageId = cleanString(video.public_page_id)
  if (publicPageId) {
    const match = pickNearestSessionEntry(video, sessionEntries, session => cleanString(session.public_page_id) === publicPageId)
    if (match) return match
  }

  const normalizedUrl = normalizeJourneyPageUrl(video.page_url)
  if (normalizedUrl) {
    const match = pickNearestSessionEntry(video, sessionEntries, session =>
      normalizeJourneyPageUrl(session.page_url || session.landing_page) === normalizedUrl
    )
    if (match) return match
  }

  const normalizedPath = normalizeJourneyPagePath(video.page_url)
  if (normalizedPath) {
    return pickNearestSessionEntry(video, sessionEntries, session =>
      normalizeJourneyPagePath(session.page_url || session.landing_page) === normalizedPath
    )
  }

  return null
}

const buildPageVisitJourneyEvent = (session, { contactCreatedAt } = {}) => ({
  type: 'page_visit',
  date: session.started_at,
  data: {
    id: session.id,
    event_name: session.event_name,
    session_id: session.session_id,
    tracking_session_id: session.id,
    visitor_id: session.visitor_id,
    contact_id: session.contact_id,
    page_url: session.page_url,
    landing_page: session.landing_page,
    referrer_url: session.referrer_url,
    utm_source: session.utm_source,
    utm_medium: session.utm_medium,
    utm_campaign: session.utm_campaign,
    utm_term: session.utm_term,
    utm_content: session.utm_content,
    gclid: session.gclid,
    fbclid: session.fbclid,
    fbc: session.fbc,
    fbp: session.fbp,
    wbraid: session.wbraid,
    gbraid: session.gbraid,
    msclkid: session.msclkid,
    ttclid: session.ttclid,
    channel: session.channel,
    source_platform: session.source_platform,
    site_source_name: session.site_source_name,
    campaign_id: session.campaign_id,
    adset_id: session.adset_id,
    ad_group_id: session.ad_group_id,
    ad_group_name: session.ad_group_name,
    campaign_name: session.campaign_name,
    adset_name: session.adset_name,
    ad_name: session.ad_name,
    ad_id: session.ad_id,
    placement: session.placement,
    network: session.network,
    match_type: session.match_type,
    keyword: session.keyword,
    search_query: session.search_query,
    creative_id: session.creative_id,
    ad_position: session.ad_position,
    device_type: session.device_type,
    os: session.os,
    browser: session.browser,
    browser_version: session.browser_version,
    language: session.language,
    timezone: session.timezone,
    geo_city: session.geo_city,
    geo_region: session.geo_region,
    geo_country: session.geo_country,
    tracking_source: session.tracking_source,
    site_id: session.site_id,
    site_slug: session.site_slug,
    site_name: session.site_name,
    site_type: session.site_type,
    form_site_id: session.form_site_id,
    form_site_name: session.form_site_name,
    public_page_id: session.public_page_id,
    public_page_title: session.public_page_title,
    conversion_type: session.conversion_type,
    submission_id: session.submission_id,
    match_method: session.match_method,
    match_confidence: toFiniteNumber(session.match_confidence),
    identity_evidence: parseJourneyJsonObject(session.identity_evidence_json),
    session_event_count: toFiniteNumber(session.session_event_count),
    session_page_view_count: toFiniteNumber(session.session_page_view_count),
    session_conversion_count: toFiniteNumber(session.session_conversion_count),
    session_started_at: session.session_started_at,
    session_ended_at: session.session_ended_at,
    session_duration_seconds: toFiniteNumber(session.session_duration_seconds),
    pages_visited: toFiniteNumber(session.pages_visited),
    first_page_url: session.first_page_url,
    last_page_url: session.last_page_url,
    event_names: Array.isArray(session.event_names) ? session.event_names : [],
    session_ids: Array.isArray(session.session_ids) ? session.session_ids : [],
    visitor_ids: Array.isArray(session.visitor_ids) ? session.visitor_ids : [],
    visible_session_count: toFiniteNumber(session.visible_session_count),
    tracking_session_ids: Array.isArray(session.tracking_session_ids) ? session.tracking_session_ids : [],
    tracking_identity_untrusted: Boolean(session.tracking_identity_untrusted),
    identity_warning: session.identity_warning || null,
    ...buildPreRegistrationJourneyMeta(session.started_at, contactCreatedAt)
  }
})

const JOURNEY_SESSION_VIEW_EVENTS = new Set(['session_start', 'page_view', 'native_site_view'])

const getJourneySessionTime = (session = {}) => {
  const time = parseSortableTimestamp(session.started_at || session.created_at)
  return Number.isFinite(time) ? time : 0
}

const isJourneySessionViewEvent = (session = {}) =>
  JOURNEY_SESSION_VIEW_EVENTS.has(cleanString(session.event_name).toLowerCase())

const isJourneySessionConversionEvent = (session = {}) => Boolean(
  cleanString(session.submission_id) ||
  WEB_CONVERSION_EVENT_PATTERN.test(cleanString(session.conversion_type)) ||
  WEB_CONVERSION_EVENT_PATTERN.test(cleanString(session.event_name))
)

const hasMeaningfulSessionValue = (value) => {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 && trimmed !== 'null' && trimmed !== 'undefined'
  }
  return true
}

const copyMissingSessionFields = (target, source = {}) => {
  Object.entries(source).forEach(([key, value]) => {
    if (!hasMeaningfulSessionValue(target[key]) && hasMeaningfulSessionValue(value)) {
      target[key] = value
    }
  })
}

const getJourneySessionMergeScore = (session = {}) => {
  let score = getWebSessionScore(session)
  if (cleanString(session.page_url) || cleanString(session.landing_page)) score += 20
  if (isJourneySessionViewEvent(session)) score += 10
  if (isJourneySessionConversionEvent(session)) score += 30
  if (cleanString(session.event_name).toLowerCase() === 'session_end') score -= 50
  return score
}

const getJourneySessionPageKey = (session = {}) =>
  normalizeJourneyPageUrl(session.page_url || session.landing_page)

const getJourneyVisitDayKey = (session = {}) => {
  const value = cleanString(session.started_at || session.created_at)
  return value.split(/[T\s]/)[0] || ''
}

const getJourneyVisitSourceKey = (session = {}) =>
  cleanString(
    getSessionSourceLabel(session) ||
    session.source_platform ||
    session.site_source_name ||
    session.utm_source ||
    session.channel ||
    'unknown'
  ).toLowerCase()

const getJourneyVisitSurfaceKey = (session = {}) =>
  cleanString(
    session.public_page_id ||
    session.form_site_id ||
    session.site_id ||
    normalizeJourneyPagePath(session.page_url || session.landing_page) ||
    getJourneySessionPageKey(session) ||
    'unknown'
  ).toLowerCase()

const getJourneyVisitGroupKey = (session = {}) =>
  [
    getJourneyVisitDayKey(session),
    getJourneyVisitSourceKey(session),
    getJourneyVisitSurfaceKey(session)
  ].join(':')

const pickJourneySessionBaseRow = (rows = []) => {
  const sorted = [...rows].sort((left, right) => getJourneySessionTime(left) - getJourneySessionTime(right))
  return sorted.find(row => cleanString(row.event_name).toLowerCase() !== 'session_end' && getJourneySessionPageKey(row)) ||
    sorted.find(row => cleanString(row.event_name).toLowerCase() !== 'session_end') ||
    sorted[0] ||
    {}
}

const hasSessionSummaryCount = (row = {}, field) => hasOwn(row, field)

const mergeJourneySessionSummaries = (summaries = [], { useBestMatch = true } = {}) => {
  const chronological = [...summaries].sort((left, right) => getJourneySessionTime(left) - getJourneySessionTime(right))
  const base = { ...pickJourneySessionBaseRow(chronological) }
  const byBestData = [...chronological].sort((left, right) => getJourneySessionMergeScore(right) - getJourneySessionMergeScore(left))
  byBestData.forEach(row => copyMissingSessionFields(base, row))

  if (useBestMatch) {
    const bestMatchRow = [...chronological].sort((left, right) =>
      toFiniteNumber(right.match_confidence) - toFiniteNumber(left.match_confidence)
    )[0]
    if (bestMatchRow && toFiniteNumber(bestMatchRow.match_confidence) >= toFiniteNumber(base.match_confidence)) {
      base.match_method = bestMatchRow.match_method || base.match_method
      base.match_confidence = bestMatchRow.match_confidence
      base.identity_evidence_json = bestMatchRow.identity_evidence_json || base.identity_evidence_json
    }
  }

  const first = chronological[0]
  const last = chronological[chronological.length - 1]
  const pageRows = chronological.filter(row => getJourneySessionPageKey(row))
  const uniquePageKeys = [...new Set(chronological.flatMap(row =>
    Array.isArray(row.page_keys) && row.page_keys.length
      ? row.page_keys.map(cleanString)
      : [getJourneySessionPageKey(row)]
  ).filter(Boolean))]
  const eventNames = [...new Set(chronological.flatMap(row =>
    Array.isArray(row.event_names) && row.event_names.length
      ? row.event_names.map(cleanString)
      : [cleanString(row.event_name)]
  ).filter(Boolean))]
  const trackingSessionIds = [...new Set(chronological.flatMap(row =>
    Array.isArray(row.tracking_session_ids) && row.tracking_session_ids.length
      ? row.tracking_session_ids.map(cleanString)
      : [cleanString(row.id)]
  ).filter(Boolean))]
  const sessionIds = [...new Set(chronological.flatMap(row =>
    Array.isArray(row.session_ids) && row.session_ids.length
      ? row.session_ids.map(cleanString)
      : [cleanString(row.session_id)]
  ).filter(Boolean))]
  const visitorIds = [...new Set(chronological.flatMap(row =>
    Array.isArray(row.visitor_ids) && row.visitor_ids.length
      ? row.visitor_ids.map(cleanString)
      : [cleanString(row.visitor_id)]
  ).filter(Boolean))]
  const hasUntrustedVisitorIdentity = chronological.some(row => row.tracking_identity_untrusted) ||
    visitorIds.some(isSuspiciousSharedVisitorId)
  const firstPage = pageRows[0]
  const lastPage = pageRows[pageRows.length - 1]
  const startedAt = first?.session_started_at || first?.started_at || first?.created_at || base.started_at
  const endedAt = last?.session_ended_at || last?.started_at || last?.created_at || startedAt
  const startedTime = parseSortableTimestamp(startedAt)
  const endedTime = parseSortableTimestamp(endedAt)
  const durationSeconds = Number.isFinite(startedTime) && Number.isFinite(endedTime) && endedTime > startedTime
    ? Math.round((endedTime - startedTime) / 1000)
    : 0

  return {
    ...base,
    started_at: startedAt,
    created_at: first?.created_at || base.created_at,
    session_event_count: hasUntrustedVisitorIdentity ? 0 : chronological.reduce(
      (total, row) => total + (hasSessionSummaryCount(row, 'session_event_count') ? Math.max(1, toFiniteNumber(row.session_event_count)) : 1),
      0
    ),
    session_page_view_count: hasUntrustedVisitorIdentity ? 0 : chronological.reduce(
      (total, row) => total + (hasSessionSummaryCount(row, 'session_page_view_count') ? toFiniteNumber(row.session_page_view_count) : (isJourneySessionViewEvent(row) ? 1 : 0)),
      0
    ),
    session_conversion_count: hasUntrustedVisitorIdentity ? 0 : chronological.reduce(
      (total, row) => total + (hasSessionSummaryCount(row, 'session_conversion_count') ? toFiniteNumber(row.session_conversion_count) : (isJourneySessionConversionEvent(row) ? 1 : 0)),
      0
    ),
    session_started_at: startedAt,
    session_ended_at: endedAt,
    session_duration_seconds: hasUntrustedVisitorIdentity ? 0 : durationSeconds,
    pages_visited: hasUntrustedVisitorIdentity ? 0 : uniquePageKeys.length,
    page_keys: uniquePageKeys,
    first_page_url: firstPage?.first_page_url || firstPage?.page_url || firstPage?.landing_page || base.first_page_url || base.page_url || base.landing_page,
    last_page_url: lastPage?.last_page_url || lastPage?.page_url || lastPage?.landing_page || firstPage?.page_url || firstPage?.landing_page || base.last_page_url || base.page_url || base.landing_page,
    event_names: eventNames,
    tracking_session_ids: trackingSessionIds,
    session_ids: sessionIds,
    visitor_ids: visitorIds,
    visible_session_count: hasUntrustedVisitorIdentity ? 0 : (sessionIds.length || chronological.length),
    tracking_identity_untrusted: hasUntrustedVisitorIdentity,
    identity_warning: hasUntrustedVisitorIdentity ? 'shared_ad_like_visitor_id' : base.identity_warning
  }
}

const summarizeJourneySessionRows = (rows = []) => {
  if (!rows.length) return []

  const groups = new Map()
  rows.forEach((row) => {
    const key = cleanString(row.session_id) || cleanString(row.id)
    if (!key) return
    const bucket = groups.get(key)
    if (bucket) {
      bucket.push(row)
    } else {
      groups.set(key, [row])
    }
  })

  const sessionSummaries = [...groups.values()]
    .map(mergeJourneySessionSummaries)
    .sort((left, right) => getJourneySessionTime(left) - getJourneySessionTime(right))

  const visibleGroups = new Map()
  sessionSummaries.forEach((summary) => {
    const key = getJourneyVisitGroupKey(summary)
    const bucket = visibleGroups.get(key)
    if (bucket) {
      bucket.push(summary)
    } else {
      visibleGroups.set(key, [summary])
    }
  })

  return [...visibleGroups.values()]
    .map(group => mergeJourneySessionSummaries(group, { useBestMatch: group.length === 1 }))
    .sort((left, right) => getJourneySessionTime(left) - getJourneySessionTime(right))
}

const attachVideoEngagementsToPageVisits = (sessionEntries, videoEngagements) => {
  const attached = new Set()

  videoEngagements.forEach(video => {
    const key = getVideoEngagementKey(video)
    const match = findVideoSessionEntry(video, sessionEntries)
    if (!key || !match) return

    const existing = Array.isArray(match.event.data.video_engagements)
      ? match.event.data.video_engagements
      : []
    match.event.data.video_engagements = [...existing, video]
    attached.add(key)
  })

  return attached
}

const loadContactVideoEngagements = async (contact = {}) => {
  const conditions = ['vps.contact_id = ?']
  const params = [contact.id]

  if (cleanString(contact.visitor_id)) {
    conditions.push('vps.visitor_id = ?')
    params.push(cleanString(contact.visitor_id))
  }

  if (cleanString(contact.email)) {
    conditions.push('vps.email = ?')
    params.push(cleanString(contact.email))
  }

  const rows = await db.all(`
    SELECT
      vps.*,
      COALESCE((
        SELECT MIN(position_seconds)
        FROM video_playback_events vpe
        WHERE vpe.playback_id = vps.playback_id
      ), 0) as min_position_seconds,
      COALESCE((
        SELECT MAX(position_seconds)
        FROM video_playback_events vpe
        WHERE vpe.playback_id = vps.playback_id
      ), vps.max_position_seconds, 0) as max_event_position_seconds,
      COALESCE((
        SELECT COUNT(*)
        FROM video_playback_events vpe
        WHERE vpe.playback_id = vps.playback_id
      ), 0) as event_count
    FROM video_playback_sessions vps
    WHERE (${conditions.join(' OR ')})
      AND (
        COALESCE(vps.play_count, 0) > 0
        OR COALESCE(vps.watched_seconds, 0) > 0
        OR COALESCE(vps.max_progress_percent, 0) > 0
        OR COALESCE(vps.ended, 0) = 1
      )
    ORDER BY COALESCE(vps.first_event_at, vps.started_at, vps.last_event_at) ASC
  `, params)

  return rows.map(row => buildVideoEngagementJourneyData(row, contact))
}

const HIGHLEVEL_MESSAGE_REFRESH_LIMIT = 12
const HIGHLEVEL_REFRESHABLE_STATUS = new Set(['', 'pending', 'queued', 'processing', 'scheduled', 'sent', 'accepted'])
const HIGHLEVEL_STATUS_PRIORITY = {
  '': 0,
  pending: 1,
  queued: 1,
  processing: 1,
  scheduled: 1,
  sent: 2,
  accepted: 2,
  delivered: 3,
  failed: 4,
  undelivered: 4,
  rejected: 4,
  read: 5
}

const parseJsonObject = (value) => {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const getNestedObject = (value, path = []) => {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== 'object') return null
    current = current[key]
  }
  return current && typeof current === 'object' ? current : null
}

const getWhatsAppReplyContextId = (context = null, rawPayload = null) => cleanString(
  context?.id ||
  context?.message_id ||
  context?.messageId ||
  context?.quotedMessageId ||
  getNestedObject(rawPayload, ['context'])?.id ||
  getNestedObject(rawPayload, ['context'])?.message_id ||
  getNestedObject(rawPayload, ['reaction'])?.message_id ||
  getNestedObject(rawPayload, ['reaction'])?.messageId ||
  getNestedObject(rawPayload, ['qrRaw', 'reaction'])?.message_id ||
  getNestedObject(rawPayload, ['qrRaw', 'context'])?.id
)

const getWhatsAppReactionEmoji = (rawPayload = null, context = null, fallbackText = '') => cleanString(
  getNestedObject(rawPayload, ['reaction'])?.emoji ||
  getNestedObject(rawPayload, ['reaction'])?.text ||
  getNestedObject(rawPayload, ['qrRaw', 'reaction'])?.emoji ||
  getNestedObject(rawPayload, ['qrRaw', 'reaction'])?.text ||
  context?.reaction?.emoji ||
  fallbackText
)

const getMetaReplyContextId = (rawPayload = null) => cleanString(
  getNestedObject(rawPayload, ['context', 'reply_to'])?.mid ||
  getNestedObject(rawPayload, ['response', 'message', 'reply_to'])?.mid ||
  getNestedObject(rawPayload, ['message', 'reply_to'])?.mid ||
  getNestedObject(rawPayload, ['reply_to'])?.mid
)

const getMetaReactionTargetId = (rawPayload = null) => cleanString(
  getNestedObject(rawPayload, ['context'])?.target_message_id ||
  getNestedObject(rawPayload, ['payload'])?.message_id ||
  getNestedObject(rawPayload, ['reaction'])?.mid
)

const safeJsonStringify = (value, fallback = null) => {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return fallback
  }
}

const normalizeHighLevelConversationStatus = (value = '') => {
  const status = cleanString(value).toLowerCase().replace(/[\s-]+/g, '_')
  if (!status) return ''
  if (['read', 'seen', 'opened', 'played'].includes(status)) return 'read'
  if (['delivered', 'delivery_ack'].includes(status)) return 'delivered'
  if (['sent', 'accepted', 'complete', 'completed', 'success', 'succeeded'].includes(status)) return 'sent'
  if (['queued', 'pending', 'processing', 'scheduled'].includes(status)) return 'pending'
  if (['failed', 'error', 'undelivered', 'bounced', 'rejected'].includes(status)) return 'failed'
  return ''
}

const firstDefinedValue = (...values) => values.find(value => value !== undefined && value !== null && value !== '')

const getHighLevelMessageObject = (response = {}) => {
  const candidates = [
    response.message,
    response.data?.message,
    response.data?.messages?.[0],
    response.messages?.[0],
    response.data,
    response
  ]
  return candidates.find(candidate => candidate && typeof candidate === 'object' && !Array.isArray(candidate)) || {}
}

const extractHighLevelConversationStatus = (response = {}) => {
  const message = getHighLevelMessageObject(response)
  return normalizeHighLevelConversationStatus(firstDefinedValue(
    message.status,
    message.messageStatus,
    message.message_status,
    message.deliveryStatus,
    message.delivery_status,
    message.statusName,
    response.status,
    response.messageStatus,
    response.message_status,
    response.deliveryStatus,
    response.delivery_status,
    response.data?.status,
    response.data?.messageStatus,
    response.data?.message_status,
    response.data?.deliveryStatus,
    response.data?.delivery_status
  ))
}

const shouldRefreshHighLevelStatus = (status = '') => {
  return HIGHLEVEL_REFRESHABLE_STATUS.has(normalizeHighLevelConversationStatus(status) || cleanString(status).toLowerCase())
}

const pickBestHighLevelStatus = (currentStatus = '', nextStatus = '') => {
  const current = normalizeHighLevelConversationStatus(currentStatus) || cleanString(currentStatus).toLowerCase()
  const next = normalizeHighLevelConversationStatus(nextStatus)
  if (!next) return current || ''
  if (!current) return next
  return (HIGHLEVEL_STATUS_PRIORITY[next] || 0) >= (HIGHLEVEL_STATUS_PRIORITY[current] || 0) ? next : current
}

const buildHighLevelStatusPayload = (rawPayload, response) => {
  const current = parseJsonObject(rawPayload) || {}
  return safeJsonStringify({
    ...current,
    lastStatusRefresh: {
      provider: 'highlevel',
      refreshedAt: new Date().toISOString(),
      response
    }
  }, rawPayload || null)
}

async function refreshHighLevelConversationMessageStatuses(contactId) {
  try {
    const [whatsappRows, metaRows] = await Promise.all([
      db.all(
        `SELECT id, ycloud_message_id, wamid, status, raw_payload_json
         FROM whatsapp_api_messages
         WHERE contact_id = ?
           AND LOWER(COALESCE(direction, '')) = 'outbound'
           AND COALESCE(ycloud_message_id, wamid, '') != ''
           AND LOWER(COALESCE(transport, '')) IN ('ghl_whatsapp', 'ghl_sms', 'ghl_webchat')
         ORDER BY COALESCE(message_timestamp, created_at) DESC
         LIMIT ?`,
        [contactId, HIGHLEVEL_MESSAGE_REFRESH_LIMIT]
      ),
      db.all(
        `SELECT id, meta_message_id, status, raw_payload_json
         FROM meta_social_messages
         WHERE contact_id = ?
           AND LOWER(COALESCE(direction, '')) = 'outbound'
           AND COALESCE(meta_message_id, '') != ''
           AND raw_payload_json LIKE ?
         ORDER BY COALESCE(message_timestamp, created_at) DESC
         LIMIT ?`,
        [contactId, '%"provider":"highlevel"%', HIGHLEVEL_MESSAGE_REFRESH_LIMIT]
      ).catch(error => {
        logger.warn(`[HighLevel Conversations] No se pudieron leer mensajes sociales para refrescar estados: ${error.message}`)
        return []
      })
    ])

    const rows = [
      ...whatsappRows.map(row => ({ ...row, table: 'whatsapp', remoteId: row.ycloud_message_id || row.wamid })),
      ...metaRows.map(row => ({ ...row, table: 'meta', remoteId: row.meta_message_id }))
    ].filter(row => row.remoteId && shouldRefreshHighLevelStatus(row.status))

    if (rows.length === 0) return

    const ghlClient = await getGHLClient()
    await Promise.all(rows.map(async row => {
      try {
        const response = await ghlClient.getConversationMessage(row.remoteId)
        const remoteStatus = extractHighLevelConversationStatus(response)
        const nextStatus = pickBestHighLevelStatus(row.status, remoteStatus)
        if (!nextStatus || nextStatus === cleanString(row.status).toLowerCase()) return

        const rawPayload = buildHighLevelStatusPayload(row.raw_payload_json, response)
        if (row.table === 'meta') {
          await db.run(
            `UPDATE meta_social_messages
             SET status = ?, raw_payload_json = COALESCE(?, raw_payload_json), updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [nextStatus, rawPayload, row.id]
          )
          return
        }

        await db.run(
          `UPDATE whatsapp_api_messages
           SET status = ?, raw_payload_json = COALESCE(?, raw_payload_json), updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [nextStatus, rawPayload, row.id]
        )
      } catch (error) {
        logger.warn(`[HighLevel Conversations] No se pudo refrescar estado del mensaje ${row.remoteId}: ${error.message}`)
      }
    }))
  } catch (error) {
    logger.warn(`[HighLevel Conversations] No se pudieron refrescar estados para el contacto ${contactId}: ${error.message}`)
  }
}

const getWhatsAppMediaFromPayload = (rawPayload, messageType = '') => {
  const payload = parseJsonObject(rawPayload)
  if (!payload) return {}

  const pickMediaUrl = (media = {}) => cleanString(
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
  )
  const pickMediaId = (media = {}) => cleanString(
    media.id ||
    media.mediaId ||
    media.media_id ||
    media.assetId ||
    media.asset_id ||
    media.fileId ||
    media.file_id
  )
  const pickMediaMimeType = (media = {}) => cleanString(
    media.mimeType ||
    media.mime_type ||
    media.mimetype ||
    media.contentType ||
    media.content_type
  )
  const pickMediaFilename = (media = {}) => cleanString(
    media.filename ||
    media.fileName ||
    media.file_name ||
    media.originalFilename ||
    media.original_filename ||
    media.name ||
    media.title
  )
  const pickMediaDurationMs = (media = {}) => (
    Number(media.durationMs || media.duration_ms || media.duration || 0) || null
  )
  const normalizeMediaCandidate = (media) => {
    if (!media) return null
    if (typeof media === 'string') {
      const mediaUrl = cleanString(media)
      return mediaUrl ? { media_url: mediaUrl } : null
    }
    if (typeof media !== 'object') return null

    const mediaUrl = pickMediaUrl(media)
    const mediaId = pickMediaId(media)
    const mimeType = pickMediaMimeType(media)
    const filename = pickMediaFilename(media)
    const durationMs = pickMediaDurationMs(media)
    if (!mediaUrl && !mediaId && !mimeType && !filename && !durationMs) return null

    return {
      media_url: mediaUrl,
      media_id: mediaId,
      media_mime_type: mimeType,
      media_filename: filename,
      media_duration_ms: durationMs
    }
  }

  const normalizedType = cleanString(messageType).toLowerCase()
  const mediaObjects = [
    payload[normalizedType],
    payload.audio,
    payload.image,
    payload.video,
    payload.document,
    payload.sticker,
    payload.whatsappMessage?.[normalizedType],
    payload.whatsappInboundMessage?.[normalizedType],
    payload.message?.[normalizedType],
    payload.localMedia,
    payload.response?.[normalizedType],
    payload.request?.[normalizedType],
    ...(Array.isArray(payload.attachments) ? payload.attachments : []),
    ...(Array.isArray(payload.message?.attachments) ? payload.message.attachments : []),
    payload.message?.attachment,
    payload.attachment,
    payload.media,
    payload.file
  ].map(normalizeMediaCandidate).filter(Boolean)

  const media = mediaObjects[0] || null
  if (!media) return {}

  return media
}

const getWhatsAppLocationFromPayload = (rawPayload, messageType = '') => {
  const payload = parseJsonObject(rawPayload)
  if (!payload) return {}

  const parseCoordinate = (value) => {
    if (value === null || value === undefined || value === '') return null
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }
  const normalizeLocation = (location = {}) => {
    if (!location || typeof location !== 'object') return null
    const latitude = parseCoordinate(
      location.latitude ??
      location.lat ??
      location.degreesLatitude ??
      location.degrees_latitude
    )
    const longitude = parseCoordinate(
      location.longitude ??
      location.lng ??
      location.lon ??
      location.degreesLongitude ??
      location.degrees_longitude
    )
    if (latitude === null || longitude === null) return null

    return {
      location_latitude: latitude,
      location_longitude: longitude,
      location_name: cleanString(location.name || location.title),
      location_address: cleanString(location.address || location.description),
      location_url: cleanString(location.url || location.href) ||
        `https://www.google.com/maps?q=${encodeURIComponent(`${latitude},${longitude}`)}`
    }
  }

  const normalizedType = cleanString(messageType).toLowerCase()
  const candidates = [
    payload.location,
    payload.locationMessage,
    payload.qrRaw?.location,
    payload.whatsappMessage?.location,
    payload.whatsappInboundMessage?.location,
    payload.message?.location,
    payload.response?.location,
    payload.request?.location,
    normalizedType ? payload[normalizedType] : null
  ]

  for (const candidate of candidates) {
    const location = normalizeLocation(candidate)
    if (location) return location
  }

  return {}
}

const splitName = (name = '') => splitContactName(name)

const createManualContactId = () => generateContactId()

const getProfilePhotoFromRawProfile = (rawProfile) => findWhatsAppProfilePictureUrl(rawProfile)

const getContactProfilePhotoUrl = (contact = {}) =>
  cleanString(contact.profile_photo_url) ||
  cleanString(contact.profile_picture_url) ||
  cleanString(contact.whatsapp_profile_picture_url) ||
  cleanString(contact.whatsapp_qr_profile_picture_url) ||
  cleanString(contact.meta_social_profile_picture_url) ||
  cleanString(contact.avatar_url) ||
  cleanString(contact.photo_url) ||
  cleanString(contact.picture_url) ||
  getProfilePhotoFromRawProfile(contact.whatsapp_raw_profile_json)

const getContactDisplayName = (contact = {}) => {
  const phone = normalizePhoneForStorage(contact.phone) || cleanString(contact.phone)
  const storedName = cleanString(contact.full_name)
  const socialName = cleanString(contact.meta_social_profile_name)
  const socialUsername = cleanString(contact.meta_social_username).replace(/^@+/, '')
  // Un contacto que solo vino de un comentario puede tener el @usuario guardado
  // como full_name (se creó antes de resolver el nombre). Prefiere el nombre
  // real del perfil social sobre un @handle.
  const storedLooksLikeHandle = !storedName ||
    storedName.startsWith('@') ||
    (Boolean(socialUsername) && storedName.replace(/^@+/, '').toLowerCase() === socialUsername.toLowerCase())
  if (socialName && storedLooksLikeHandle) {
    return socialName
  }
  if (storedName && !shouldReplaceWhatsAppApiContactName(storedName, phone)) {
    return formatContactName(storedName)
  }

  return normalizeWhatsAppProfileName(contact.whatsapp_profile_name, phone) ||
    extractWhatsAppProfileName(contact.whatsapp_raw_profile_json, phone) ||
    normalizeWhatsAppProfileName(contact.first_name, phone) ||
    socialName ||
    phone ||
    ''
}

const comparableContactLabel = (value = '') =>
  cleanString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')

const getSafeContactAdFields = (contact = {}) => {
  const adId = cleanString(contact.attribution_ad_id)
  const adName = cleanString(contact.attribution_ad_name)
  const hasAdSignal = hasRealWhatsAppAdAttribution(contact)
  if (!hasAdSignal) {
    return { ad_name: '', ad_id: '' }
  }

  const adNameKey = comparableContactLabel(adName)
  const displayNameKey = comparableContactLabel(getContactDisplayName(contact))
  const apiProfileNameKey = comparableContactLabel(contact.whatsapp_profile_name)
  const adNameLooksLikeContactName = !adId && adNameKey && (
    adNameKey === displayNameKey ||
    adNameKey === apiProfileNameKey
  )

  return {
    ad_name: adNameLooksLikeContactName ? '' : adName,
    ad_id: adId
  }
}

const buildContactPhonesForResponse = (contact = {}) => {
  const byPhone = new Map()
  const addPhone = (entry = {}) => {
    const phone = cleanString(entry.phone)
    if (!phone || byPhone.has(phone)) return

    const isPrimary = Boolean(entry.isPrimary || entry.is_primary || phone === cleanString(contact.phone))
    const label = isPrimary
      ? 'Principal'
      : cleanString(entry.label) && cleanString(entry.label) !== 'Principal'
        ? cleanString(entry.label)
        : 'Adicional'
    byPhone.set(phone, {
      id: cleanString(entry.id) || phone,
      phone,
      label,
      isPrimary,
      is_primary: isPrimary,
      source: cleanString(entry.source),
      createdAt: entry.createdAt || entry.created_at || null,
      updatedAt: entry.updatedAt || entry.updated_at || null
    })
  }

  if (contact.phone) {
    addPhone({
      id: `${contact.id || 'contact'}-primary-phone`,
      phone: contact.phone,
      label: 'Principal',
      isPrimary: true
    })
  }

  const phones = Array.isArray(contact.phoneNumbers)
    ? contact.phoneNumbers
    : Array.isArray(contact.phones)
      ? contact.phones
      : []

  phones.forEach(addPhone)

  return [...byPhone.values()].sort((left, right) => {
    if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1
    return String(left.createdAt || '').localeCompare(String(right.createdAt || ''))
  })
}

const attachContactPhoneNumbers = async (contacts = []) => {
  if (!Array.isArray(contacts) || contacts.length === 0) return contacts

  const uniqueIds = [...new Set(contacts.map(contact => cleanString(contact?.id)).filter(Boolean))]
  if (!uniqueIds.length) return contacts

  const phoneRowsByContact = new Map(uniqueIds.map(id => [id, []]))
  const rows = await db.all(
    `SELECT id, contact_id, phone, label, is_primary, source, created_at, updated_at
     FROM contact_phone_numbers
     WHERE contact_id IN (${uniqueIds.map(() => '?').join(', ')})
     ORDER BY is_primary DESC, created_at ASC, phone ASC`,
    uniqueIds
  ).catch(() => [])

  rows.forEach(row => {
    const contactId = cleanString(row.contact_id)
    if (!phoneRowsByContact.has(contactId)) return
    phoneRowsByContact.get(contactId).push({
      id: row.id,
      phone: row.phone,
      label: row.label || '',
      isPrimary: Boolean(row.is_primary),
      is_primary: Boolean(row.is_primary),
      source: row.source || '',
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null
    })
  })

  return contacts.map(contact => ({
    ...contact,
    phoneNumbers: phoneRowsByContact.get(cleanString(contact?.id)) || []
  }))
}

const getCustomerPaymentsCount = (contact = {}) => {
  const raw = contact.customer_payments_count ??
    contact.customerPaymentsCount ??
    contact.successful_payments_count ??
    contact.purchases_count ??
    contact.purchases ??
    0
  const count = Number(raw)
  return Number.isFinite(count) ? count : 0
}

const mapContactRowForResponse = (contact = {}) => {
  const customerPaymentsCount = getCustomerPaymentsCount(contact)
  let status = 'lead'
  if (customerPaymentsCount > 0) {
    status = 'customer'
  } else if (contact.has_appointments || contact.appointment_date) {
    status = 'appointment'
  }
  const adFields = getSafeContactAdFields(contact)

  const phones = buildContactPhonesForResponse(contact)

  return {
    id: contact.id,
    createdAt: contact.created_at,
    name: getContactDisplayName(contact),
    full_name: formatContactName(contact.full_name),
    first_name: formatContactName(contact.first_name),
    last_name: formatContactName(contact.last_name, { allowLeadingConnectorLowercase: true }),
    email: contact.email || '',
    phone: contact.phone || '',
    ltv: parseFloat(contact.total_paid || 0),
    status,
    lastPurchase: contact.last_customer_payment_date || contact.last_purchase_date,
    purchases: customerPaymentsCount,
    successfulPaymentsCount: customerPaymentsCount,
    hasAppointments: Boolean(contact.has_appointments),
    hasShowedAppointment: Boolean(contact.has_showed_appointment),
    hasAttendedAppointment: Boolean(contact.has_showed_appointment),
    hasUpcomingConfirmedAppointmentBadge: Boolean(contact.has_confirmation_badge),
    source: contact.source,
    profilePhotoUrl: getContactProfilePhotoUrl(contact) || null,
    ad_name: adFields.ad_name,
    ad_id: adFields.ad_id,
    preferredWhatsAppPhoneNumberId: contact.preferred_whatsapp_phone_number_id || '',
    preferred_whatsapp_phone_number_id: contact.preferred_whatsapp_phone_number_id || '',
    phones,
    phoneNumbers: phones,
    customFields: parseContactCustomFields(contact.custom_fields),
    socialProfileName: cleanString(contact.meta_social_profile_name) || null,
    socialUsername: cleanString(contact.meta_social_username).replace(/^@+/, '') || null,
    notes: ''
  }
}

const mapChatContactRowForResponse = (contact = {}) => ({
  ...mapContactRowForResponse(contact),
  lastMessageText: contact.last_message_text || '',
  lastMessageType: contact.last_message_type || '',
  lastMessageChannel: contact.last_message_channel || '',
  lastMessageDate: contact.last_message_date || contact.created_at,
  lastMessageDirection: contact.last_message_direction || '',
  lastBusinessPhone: contact.last_business_phone || '',
  lastBusinessPhoneNumberId: contact.last_business_phone_number_id || '',
  lastInboundBusinessPhone: contact.last_inbound_business_phone || '',
  lastInboundBusinessPhoneNumberId: contact.last_inbound_business_phone_number_id || '',
  firstInboundBusinessPhone: contact.first_inbound_business_phone || '',
  firstInboundBusinessPhoneNumberId: contact.first_inbound_business_phone_number_id || '',
  lastMessageTransport: contact.last_message_transport || '',
  messageCount: Number(contact.message_count || 0),
  unreadCount: Number(contact.unread_count || 0),
  hasCommentMessage: Boolean(Number(contact.meta_has_comment_message || 0)),
  hasPrivateDm: Boolean(Number(contact.meta_has_private_dm || 0))
})

const fetchPickerLatestMessageRowsByContact = async (contacts = [], phoneRowsByContact = new Map()) => {
  const contactIds = contacts.map(contact => cleanString(contact.id)).filter(Boolean)
  if (!contactIds.length) return new Map()

  const phonePairs = []
  contacts.forEach(contact => {
    const contactId = cleanString(contact.id)
    if (!contactId) return
    const seenPhones = new Set()
    const addPhone = (value) => {
      const phone = cleanString(value)
      if (!phone || seenPhones.has(phone)) return
      seenPhones.add(phone)
      phonePairs.push([contactId, phone])
    }
    addPhone(contact.phone)
    ;(phoneRowsByContact.get(contactId) || []).forEach(row => addPhone(row.phone))
  })

  const phoneRowsCte = phonePairs.length
    ? `VALUES ${phonePairs.map(() => '(?, ?)').join(', ')}`
    : 'SELECT NULL AS contact_id, NULL AS phone WHERE 1 = 0'
  const directWhatsAppContactIdSql = 'COALESCE(msg.contact_id, api_profile.contact_id)'
  const params = [
    ...contactIds,
    ...phonePairs.flatMap(([contactId, phone]) => [contactId, phone])
  ]

  const rows = await db.all(
    `WITH picked_contacts(contact_id) AS (
        VALUES ${contactIds.map(() => '(?)').join(', ')}
      ),
      picked_contact_phones(contact_id, phone) AS (
        ${phoneRowsCte}
      ),
      picker_message_rows AS (
        SELECT
          ${directWhatsAppContactIdSql} AS contact_id,
          msg.message_text,
          msg.message_type,
          msg.direction,
          msg.business_phone,
          msg.business_phone_number_id,
          msg.transport,
          COALESCE(msg.message_timestamp, msg.created_at) AS message_date,
          msg.created_at,
          'whatsapp' AS message_channel
        FROM whatsapp_api_messages msg
        LEFT JOIN whatsapp_api_contacts api_profile ON api_profile.id = msg.whatsapp_api_contact_id
        JOIN picked_contacts pc ON pc.contact_id = ${directWhatsAppContactIdSql}
        WHERE ${directWhatsAppContactIdSql} IS NOT NULL
        UNION ALL
        SELECT
          MIN(picked_contact_phones.contact_id) AS contact_id,
          msg.message_text,
          msg.message_type,
          msg.direction,
          msg.business_phone,
          msg.business_phone_number_id,
          msg.transport,
          COALESCE(msg.message_timestamp, msg.created_at) AS message_date,
          msg.created_at,
          'whatsapp' AS message_channel
        FROM whatsapp_api_messages msg
        LEFT JOIN whatsapp_api_contacts api_profile ON api_profile.id = msg.whatsapp_api_contact_id
        JOIN picked_contact_phones
          ON picked_contact_phones.phone IN (msg.phone, msg.from_phone, msg.to_phone, api_profile.phone)
        WHERE ${directWhatsAppContactIdSql} IS NULL
          AND TRIM(COALESCE(picked_contact_phones.phone, '')) != ''
        GROUP BY
          msg.id,
          msg.message_text,
          msg.message_type,
          msg.direction,
          msg.business_phone,
          msg.business_phone_number_id,
          msg.transport,
          COALESCE(msg.message_timestamp, msg.created_at),
          msg.created_at
        UNION ALL
        SELECT
          meta_social_messages.contact_id,
          meta_social_messages.message_text,
          meta_social_messages.message_type,
          meta_social_messages.direction,
          NULL AS business_phone,
          NULL AS business_phone_number_id,
          NULL AS transport,
          COALESCE(meta_social_messages.message_timestamp, meta_social_messages.created_at) AS message_date,
          meta_social_messages.created_at,
          meta_social_messages.platform AS message_channel
        FROM meta_social_messages
        JOIN picked_contacts pc ON pc.contact_id = meta_social_messages.contact_id
        WHERE meta_social_messages.contact_id IS NOT NULL
        UNION ALL
        SELECT
          email_messages.contact_id,
          CASE
            WHEN COALESCE(email_messages.subject, '') != '' AND COALESCE(email_messages.message_text, '') != '' THEN email_messages.subject || ' · ' || email_messages.message_text
            WHEN COALESCE(email_messages.subject, '') != '' THEN email_messages.subject
            ELSE COALESCE(email_messages.message_text, '')
          END AS message_text,
          'email' AS message_type,
          email_messages.direction,
          NULL AS business_phone,
          NULL AS business_phone_number_id,
          CASE
            WHEN email_messages.raw_payload_json LIKE '%"provider":"highlevel"%' THEN 'ghl_email'
            ELSE 'smtp'
          END AS transport,
          COALESCE(email_messages.message_timestamp, email_messages.created_at) AS message_date,
          email_messages.created_at,
          'email' AS message_channel
        FROM email_messages
        JOIN picked_contacts pc ON pc.contact_id = email_messages.contact_id
        WHERE email_messages.contact_id IS NOT NULL
      ),
      latest_picker_messages AS (
        SELECT
          *,
          ROW_NUMBER() OVER (
            PARTITION BY contact_id
            ORDER BY ${timestampSortExpression('message_date')} DESC, ${timestampSortExpression('created_at')} DESC
          ) AS row_rank
        FROM picker_message_rows
        WHERE contact_id IS NOT NULL
      )
      SELECT
        contact_id,
        message_text AS last_message_text,
        message_type AS last_message_type,
        message_channel AS last_message_channel,
        message_date AS last_message_date,
        direction AS last_message_direction,
        business_phone AS last_business_phone,
        business_phone_number_id AS last_business_phone_number_id,
        transport AS last_message_transport
      FROM latest_picker_messages
      WHERE row_rank = 1`,
    params
  ).catch(error => {
    logger.warn(`No se pudo hidratar canal del directorio picker: ${error.message}`)
    return []
  })

  return new Map(rows.map(row => [cleanString(row.contact_id), row]))
}

const CHAT_CONTACTS_DEFAULT_LIMIT = 50
const CHAT_CONTACTS_MAX_LIMIT = 100

const getRequestUserId = (req) => req.user?.userId || req.user?.id || null

const applyWarmedProfilePictures = (rows = [], warmedPictures = new Map()) => {
  if (!warmedPictures?.size) return rows

  const now = new Date().toISOString()
  return rows.map(row => {
    const key = cleanString(row?.id) || cleanString(row?.phone)
    const profilePictureUrl = warmedPictures.get(key)
    return profilePictureUrl
      ? {
          ...row,
          whatsapp_profile_picture_url: profilePictureUrl,
          whatsapp_profile_picture_updated_at: row.whatsapp_profile_picture_updated_at || now
        }
      : row
  })
}

const warmWhatsAppProfilePicturesForRows = async (rows = [], {
  apiLimit = 40,
  qrLimit = 16
} = {}) => {
  if (!Array.isArray(rows) || rows.length === 0) return rows

  let hydratedRows = rows

  try {
    const apiPictures = await warmWhatsAppApiProfilePictures(hydratedRows, { limit: apiLimit })
    hydratedRows = applyWarmedProfilePictures(hydratedRows, apiPictures)
  } catch (error) {
    logger.warn(`No se pudieron preparar fotos por WhatsApp API: ${error.message}`)
  }

  try {
    const qrPictures = await warmWhatsAppQrProfilePictures(hydratedRows, { limit: qrLimit })
    hydratedRows = applyWarmedProfilePictures(hydratedRows, qrPictures)
  } catch (error) {
    logger.warn(`No se pudieron preparar fotos por QR: ${error.message}`)
  }

  return hydratedRows
}

const mapMetaAttributionRow = (row, matchType) => {
  if (!row) return null

  return {
    source: 'meta_ads',
    matchType,
    adAccountId: row.ad_account_id || null,
    campaignId: row.campaign_id || null,
    campaignName: row.campaign_name || null,
    adsetId: row.adset_id || null,
    adsetName: row.adset_name || null,
    adId: row.ad_id || null,
    adName: row.ad_name || null,
    creativeThumbnailUrl: row.creative_thumbnail_url || null,
    creativeImageUrl: row.creative_image_url || null,
    creativeVideoUrl: row.creative_video_url || null,
    creativePreviewUrl: row.creative_preview_url || null,
    date: row.date || null
  }
}

const getMetaAttributionForContact = async (contact = {}, firstSession = null, whatsappAttribution = null) => {
  const uniqueValues = (values = [], normalize = value => cleanString(value)) => {
    const seen = new Set()
    const result = []

    values.forEach(value => {
      const normalized = normalize(value)
      if (!normalized || seen.has(normalized)) return
      seen.add(normalized)
      result.push(normalized)
    })

    return result
  }

  const selectMetaFields = `
    SELECT
      date,
      ad_account_id,
      campaign_id,
      campaign_name,
      adset_id,
      adset_name,
      ad_id,
      ad_name,
      creative_thumbnail_url,
      creative_image_url,
      creative_video_url,
      creative_preview_url
    FROM meta_ads
`

  const adIdCandidates = uniqueValues([
    contact.attribution_ad_id,
    firstSession?.ad_id,
    whatsappAttribution?.referral_source_id,
    whatsappAttribution?.ad_id_thru_message
  ])

  if (adIdCandidates.length > 0) {
    const rows = await db.all(
      `${selectMetaFields}
       WHERE ad_id IN (${adIdCandidates.map(() => '?').join(', ')})
       ORDER BY ${timestampSortExpression('date')} DESC`,
      adIdCandidates
    )

    for (const candidate of adIdCandidates) {
      const match = rows.find(row => cleanString(row.ad_id) === candidate)
      if (match) return mapMetaAttributionRow(match, 'ad_id')
    }
  }

  const adNameCandidates = uniqueValues([
    firstSession?.ad_name,
    contact.attribution_ad_name
  ], value => cleanString(value).toLowerCase())

  if (adNameCandidates.length > 0) {
    const rows = await db.all(
      `${selectMetaFields}
       WHERE LOWER(ad_name) IN (${adNameCandidates.map(() => '?').join(', ')})
       ORDER BY ${timestampSortExpression('date')} DESC`,
      adNameCandidates
    )

    for (const candidate of adNameCandidates) {
      const match = rows.find(row => cleanString(row.ad_name).toLowerCase() === candidate)
      if (match) return mapMetaAttributionRow(match, 'ad_name_exact')
    }
  }

  return null
}

const buildResolvedMetaAdFields = (contact = {}, metaAttribution = null) => ({
  ad_name: metaAttribution?.adName || contact.meta_ad_name || contact.attribution_ad_name || contact.ad_name || null,
  ad_id: metaAttribution?.adId || contact.attribution_ad_id || contact.ad_id || null,
  campaign_id: metaAttribution?.campaignId || contact.campaign_id || null,
  campaign_name: metaAttribution?.campaignName || contact.campaign_name || null,
  adset_id: metaAttribution?.adsetId || contact.adset_id || null,
  adset_name: metaAttribution?.adsetName || contact.adset_name || null
})

const getMetaSocialReferralObject = (row = {}, rawPayload = null) => {
  const storedReferral = parseJsonObject(row.referral_json)
  if (storedReferral) return storedReferral

  return getNestedObject(rawPayload, ['message', 'referral']) ||
    getNestedObject(rawPayload, ['postback', 'referral']) ||
    getNestedObject(rawPayload, ['referral']) ||
    null
}

const metaSocialReferralLooksLikeAd = (referral = null) => {
  if (!referral || typeof referral !== 'object') return false
  if (cleanString(referral.ad_id)) return true
  if (cleanString(referral.source).toUpperCase() === 'ADS') return true
  return Boolean(referral.ads_context_data && typeof referral.ads_context_data === 'object')
}

const buildMetaSocialAdAttributionData = (row = {}, rawPayload = null) => {
  const referral = getMetaSocialReferralObject(row, rawPayload)
  if (!metaSocialReferralLooksLikeAd(referral)) return {}

  const adsContext = referral.ads_context_data && typeof referral.ads_context_data === 'object'
    ? referral.ads_context_data
    : {}
  const platform = cleanString(row.platform).toLowerCase() === 'instagram' ? 'instagram' : 'messenger'
  const sourceId = cleanString(referral.ad_id || adsContext.ad_id)
  const rawSourceType = cleanString(referral.source || referral.type)
  const sourceType = rawSourceType.toUpperCase() === 'ADS' ? 'ad' : (rawSourceType || 'ad')
  const headline = cleanString(adsContext.ad_title || adsContext.title || referral.ref)
  const body = cleanString(adsContext.post_body || adsContext.body || adsContext.description)
  const sourceUrl = cleanString(
    adsContext.ad_url ||
    adsContext.source_url ||
    adsContext.url ||
    referral.referral_url ||
    referral.source_url ||
    referral.url
  )
  const imageUrl = cleanString(
    adsContext.photo_url ||
    adsContext.image_url ||
    adsContext.thumbnail_url ||
    adsContext.picture
  )
  const videoUrl = cleanString(adsContext.video_url)
  const thumbnailUrl = cleanString(
    adsContext.thumbnail_url ||
    adsContext.photo_url ||
    adsContext.video_url
  )

  return {
    is_ad_attributed: true,
    ad_platform: platform === 'instagram' ? 'Instagram' : 'Messenger',
    referral_source_id: sourceId || null,
    referral_source_type: sourceType,
    referral_source_url: sourceUrl || null,
    referral_headline: headline || null,
    referral_body: body || null,
    referral_image_url: imageUrl || null,
    referral_video_url: videoUrl || null,
    referral_thumbnail_url: thumbnailUrl || null,
    referral_source_app: platform,
    referral_entry_point: cleanString(referral.type) || null,
    ad_id_thru_message: sourceId || null
  }
}

const loadMetaAdsByAdIds = async (adIds = []) => {
  const uniqueIds = [...new Set(adIds.map(cleanString).filter(Boolean))]
  const byAdId = new Map()
  if (uniqueIds.length === 0) return byAdId

  const rows = await db.all(
    `SELECT
       date,
       ad_account_id,
       campaign_id,
       campaign_name,
       adset_id,
       adset_name,
       ad_id,
       ad_name,
       creative_thumbnail_url,
       creative_image_url,
       creative_video_url,
       creative_preview_url
     FROM meta_ads
     WHERE ad_id IN (${uniqueIds.map(() => '?').join(', ')})
     ORDER BY ${timestampSortExpression('date')} DESC`,
    uniqueIds
  )

  rows.forEach(row => {
    const adId = cleanString(row.ad_id)
    if (adId && !byAdId.has(adId)) {
      byAdId.set(adId, mapMetaAttributionRow(row, 'ad_id'))
    }
  })

  return byAdId
}

const enrichMessagingJourneyEventsWithMetaAds = async (events = []) => {
  const getAdId = (data = {}) => {
    const detected = detectWhatsAppAttributionFields({ data }, [
      data.message_text,
      data.message_content,
      data.message,
      data.body,
      data.text,
      data.caption
    ])
    return cleanString(data.attribution_ad_id || data.referral_source_id || data.ad_id_thru_message || detected.sourceId)
  }
  const adIds = events.flatMap(event => {
    const data = event?.data || {}
    return [getAdId(data)]
  })
  const metaByAdId = await loadMetaAdsByAdIds(adIds)
  if (metaByAdId.size === 0) return events

  return events.map(event => {
    const data = event?.data || {}
    const adId = getAdId(data)
    const metaAttribution = metaByAdId.get(adId)
    if (!metaAttribution) return event

    return {
      ...event,
      data: {
        ...data,
        campaign_id: metaAttribution.campaignId || data.campaign_id || null,
        campaign_name: metaAttribution.campaignName || data.campaign_name || null,
        ad_account_id: metaAttribution.adAccountId || data.ad_account_id || null,
        adset_id: metaAttribution.adsetId || data.adset_id || null,
        adset_name: metaAttribution.adsetName || data.adset_name || null,
        referral_source_id: data.referral_source_id || adId || null,
        referral_source_type: data.referral_source_type || (adId ? 'ad' : null),
        attribution_ad_id: metaAttribution.adId || data.attribution_ad_id || data.referral_source_id || adId || null,
        attribution_ad_name: metaAttribution.adName || data.attribution_ad_name || data.referral_headline || null,
        creative_thumbnail_url: metaAttribution.creativeThumbnailUrl || data.creative_thumbnail_url || null,
        creative_image_url: metaAttribution.creativeImageUrl || data.creative_image_url || null,
        creative_video_url: metaAttribution.creativeVideoUrl || data.creative_video_url || null,
        creative_preview_url: metaAttribution.creativePreviewUrl || data.creative_preview_url || null
      }
    }
  })
}

export const getContactCustomFieldDefinitions = async (req, res) => {
  try {
    const includeArchived = String(req.query?.includeArchived || req.query?.include_archived || '').toLowerCase() === 'true'
    const definitions = await listContactCustomFieldDefinitions({
      includeArchived,
      userId: req.user?.userId
    })

    res.json({
      success: true,
      data: definitions
    })
  } catch (error) {
    logger.error(`Error listando campos personalizados de contacto: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'No se pudieron cargar los campos personalizados'
    })
  }
}

export const createContactCustomFieldDefinition = async (req, res) => {
  try {
    const definition = await upsertContactCustomFieldDefinition(req.body || {}, {
      sourceType: 'manual',
      ownerUserId: req.user?.userId,
      syncTarget: req.body?.syncTarget || req.body?.sync_target || 'local'
    })

    if (!definition) {
      return res.status(400).json({
        success: false,
        error: 'Ese campo pertenece a los datos principales del contacto'
      })
    }

    res.status(201).json({
      success: true,
      data: definition
    })
  } catch (error) {
    logger.error(`Error creando campo personalizado de contacto: ${error.message}`)
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'No se pudo crear el campo personalizado'
    })
  }
}

export const updateContactCustomFieldDefinitionHandler = async (req, res) => {
  try {
    const definition = await updateContactCustomFieldDefinition(req.params.definitionId, req.body || {})

    if (!definition) {
      return res.status(404).json({
        success: false,
        error: 'Campo personalizado no encontrado'
      })
    }

    res.json({
      success: true,
      data: definition
    })
  } catch (error) {
    logger.error(`Error actualizando campo personalizado de contacto: ${error.message}`)
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'No se pudo actualizar el campo personalizado'
    })
  }
}

/**
 * Obtiene conversaciones con actividad de WhatsApp.
 */
export const getChatContacts = async (req, res) => {
  try {
    const {
      q = '',
      limit = CHAT_CONTACTS_DEFAULT_LIMIT,
      offset = 0,
      businessPhoneNumberId = '',
      businessPhone = '',
      beforeMessageDate = '',
      beforeContactId = ''
    } = req.query
    const limitNumber = Math.min(Math.max(Number(limit) || CHAT_CONTACTS_DEFAULT_LIMIT, 1), CHAT_CONTACTS_MAX_LIMIT)
    const shouldWarmProfilePictures = isTruthyQueryValue(req.query.warmProfilePictures || req.query.warmProfiles)
    const searchTerm = cleanString(q)
    const cursorMessageDate = cleanString(beforeMessageDate)
    const cursorContactId = cleanString(beforeContactId)
    const cursorEnabled = Boolean(cursorMessageDate && cursorContactId)
    const offsetNumber = cursorEnabled ? 0 : Math.max(Math.floor(Number(offset) || 0), 0)
    const phoneNumberIdFilter = cleanString(businessPhoneNumberId)
    const businessPhoneFilter = normalizePhoneForStorage(businessPhone)
    const relatedBusinessPhoneFilters = await resolveRelatedBusinessPhoneFilters({
      phoneNumberId: phoneNumberIdFilter,
      businessPhone: businessPhoneFilter || businessPhone
    })
    const directWhatsAppContactIdSql = 'COALESCE(msg.contact_id, api_profile.contact_id)'
    const whatsappMessageConditions = []
    const whatsappMessageParams = []
    const conditions = []
    const params = []
    const includeMetaSocialMessages = !phoneNumberIdFilter && !businessPhoneFilter

    if (phoneNumberIdFilter || businessPhoneFilter) {
      const phoneClauses = []
      appendSqlInClause(phoneClauses, whatsappMessageParams, 'msg.business_phone_number_id', relatedBusinessPhoneFilters.phoneIds)
      appendSqlInClause(phoneClauses, whatsappMessageParams, 'msg.business_phone', relatedBusinessPhoneFilters.phoneCandidates)
      whatsappMessageConditions.push(`(${phoneClauses.join(' OR ')})`)
    }

    if (searchTerm) {
      const searchClause = buildContactSearchClause('c', searchTerm)
      conditions.push(searchClause.condition)
      params.push(...searchClause.params)
    }

    const hiddenFilters = await getHiddenContactFilters()
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
    if (hiddenCondition) {
      conditions.push(hiddenCondition)
    }

    if (cursorEnabled) {
      const cursorTimestampSort = timestampSortParameterExpression()
      conditions.push(`(
        chat_stats.last_message_sort < ${cursorTimestampSort}
        OR (chat_stats.last_message_sort = ${cursorTimestampSort} AND chat_stats.contact_id < ?)
      )`)
      params.push(cursorMessageDate, cursorMessageDate, cursorContactId)
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const buildWhatsAppWhereClause = (extraConditions = []) => {
      const clauses = [...whatsappMessageConditions, ...extraConditions].filter(Boolean)
      return clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    }
    const whatsappBaseWhereClause = buildWhatsAppWhereClause()
    const whatsappDirectWhereClause = buildWhatsAppWhereClause([`${directWhatsAppContactIdSql} IS NOT NULL`])
    const whatsappPhoneLookupWhereClause = buildWhatsAppWhereClause([`${directWhatsAppContactIdSql} IS NULL`])
    const whatsappStatsSourceRowsSql = `
        SELECT
          msg.id AS message_id,
          ${directWhatsAppContactIdSql} AS direct_contact_id,
          msg.phone,
          msg.from_phone,
          msg.to_phone,
          api_profile.phone AS api_profile_phone,
          COALESCE(msg.message_timestamp, msg.created_at) AS message_date
        FROM whatsapp_api_messages msg
        LEFT JOIN whatsapp_api_contacts api_profile ON api_profile.id = msg.whatsapp_api_contact_id
        ${whatsappBaseWhereClause}
    `
    const messageStatsRowsSql = `
        SELECT
          direct_contact_id AS contact_id,
          COUNT(*) AS message_count,
          MAX(message_date) AS last_message_date,
          MAX(${timestampSortExpression('message_date')}) AS last_message_sort
        FROM whatsapp_stats_source_rows
        WHERE direct_contact_id IS NOT NULL
        GROUP BY direct_contact_id
        UNION ALL
        SELECT
          contact_id,
          COUNT(*) AS message_count,
          MAX(message_date) AS last_message_date,
          MAX(${timestampSortExpression('message_date')}) AS last_message_sort
        FROM (
          SELECT
            message_id,
            MIN(contact_id) AS contact_id,
            MAX(message_date) AS message_date
          FROM whatsapp_stats_phone_matches
          GROUP BY message_id
        ) resolved_phone_stats
        WHERE contact_id IS NOT NULL
        GROUP BY contact_id
        ${includeMetaSocialMessages ? `
        UNION ALL
        SELECT
          contact_id,
          COUNT(*) AS message_count,
          MAX(COALESCE(message_timestamp, created_at)) AS last_message_date,
          MAX(${timestampSortExpression('COALESCE(message_timestamp, created_at)')}) AS last_message_sort
        FROM meta_social_messages
        WHERE contact_id IS NOT NULL
        GROUP BY contact_id
        ` : ''}
        ${includeMetaSocialMessages ? `
        UNION ALL
        SELECT
          contact_id,
          COUNT(*) AS message_count,
          MAX(COALESCE(message_timestamp, created_at)) AS last_message_date,
          MAX(${timestampSortExpression('COALESCE(message_timestamp, created_at)')}) AS last_message_sort
        FROM email_messages
        WHERE contact_id IS NOT NULL
        GROUP BY contact_id
        ` : ''}
    `

    const selectedMessageRowsSql = `
        SELECT
          ${directWhatsAppContactIdSql} AS contact_id,
          'whatsapp:' || msg.id AS message_row_id,
          msg.message_text,
          msg.message_type,
          msg.direction,
          msg.business_phone,
          msg.business_phone_number_id,
          msg.transport,
          COALESCE(msg.message_timestamp, msg.created_at) AS message_date,
          msg.created_at,
          'whatsapp' AS message_channel
        FROM whatsapp_api_messages msg
        LEFT JOIN whatsapp_api_contacts api_profile ON api_profile.id = msg.whatsapp_api_contact_id
        JOIN ranked_chats ON ranked_chats.contact_id = ${directWhatsAppContactIdSql}
        ${whatsappDirectWhereClause}
        UNION ALL
        SELECT
          MIN(ranked_contact_phones.contact_id) AS contact_id,
          'whatsapp:' || msg.id AS message_row_id,
          msg.message_text,
          msg.message_type,
          msg.direction,
          msg.business_phone,
          msg.business_phone_number_id,
          msg.transport,
          COALESCE(msg.message_timestamp, msg.created_at) AS message_date,
          msg.created_at,
          'whatsapp' AS message_channel
        FROM whatsapp_api_messages msg
        LEFT JOIN whatsapp_api_contacts api_profile ON api_profile.id = msg.whatsapp_api_contact_id
        JOIN ranked_contact_phones ON ranked_contact_phones.phone IN (msg.phone, msg.from_phone, msg.to_phone, api_profile.phone)
        ${whatsappPhoneLookupWhereClause}
        GROUP BY
          msg.id,
          msg.message_text,
          msg.message_type,
          msg.direction,
          msg.business_phone,
          msg.business_phone_number_id,
          msg.transport,
          COALESCE(msg.message_timestamp, msg.created_at),
          msg.created_at
        ${includeMetaSocialMessages ? `
        UNION ALL
        SELECT
          meta_social_messages.contact_id,
          'meta:' || meta_social_messages.id AS message_row_id,
          CASE
            WHEN LOWER(COALESCE(meta_social_messages.message_type, '')) IN ('comment', 'comment_reply_public', 'comment_reply_private')
              AND (
                LOWER(COALESCE(meta_social_messages.status, '')) IN ('removed', 'deleted', 'delete', 'remove', 'hide', 'hidden')
                OR LOWER(COALESCE(latest_meta_post.post_type, '')) = 'deleted'
              ) THEN 'Comentario eliminado'
            WHEN LOWER(COALESCE(meta_social_messages.message_type, '')) = 'comment'
              AND COALESCE(meta_social_messages.message_text, '') = '' THEN 'Comentario sin texto'
            WHEN LOWER(COALESCE(meta_social_messages.message_type, '')) = 'comment_reply_public'
              AND COALESCE(meta_social_messages.message_text, '') = '' THEN 'Respuesta pública al comentario'
            WHEN LOWER(COALESCE(meta_social_messages.message_type, '')) = 'comment_reply_private'
              AND COALESCE(meta_social_messages.message_text, '') = '' THEN 'Respuesta por privado al comentario'
            ELSE meta_social_messages.message_text
          END AS message_text,
          meta_social_messages.message_type,
          meta_social_messages.direction,
          NULL AS business_phone,
          NULL AS business_phone_number_id,
          NULL AS transport,
          COALESCE(meta_social_messages.message_timestamp, meta_social_messages.created_at) AS message_date,
          meta_social_messages.created_at,
          meta_social_messages.platform AS message_channel
        FROM meta_social_messages
        JOIN ranked_chats ON ranked_chats.contact_id = meta_social_messages.contact_id
        LEFT JOIN meta_social_posts latest_meta_post
          ON latest_meta_post.id = COALESCE(NULLIF(meta_social_messages.post_id, ''), meta_social_messages.media_id)
        WHERE meta_social_messages.contact_id IS NOT NULL
        ` : ''}
        ${includeMetaSocialMessages ? `
        UNION ALL
        SELECT
          email_messages.contact_id,
          'email:' || email_messages.id AS message_row_id,
          CASE
            WHEN COALESCE(email_messages.subject, '') != '' AND COALESCE(email_messages.message_text, '') != '' THEN email_messages.subject || ' · ' || email_messages.message_text
            WHEN COALESCE(email_messages.subject, '') != '' THEN email_messages.subject
            ELSE COALESCE(email_messages.message_text, '')
          END AS message_text,
          'email' AS message_type,
          email_messages.direction,
          NULL AS business_phone,
          NULL AS business_phone_number_id,
          CASE
            WHEN email_messages.raw_payload_json LIKE '%"provider":"highlevel"%' THEN 'ghl_email'
            ELSE 'smtp'
          END AS transport,
          COALESCE(email_messages.message_timestamp, email_messages.created_at) AS message_date,
          email_messages.created_at,
          'email' AS message_channel
        FROM email_messages
        JOIN ranked_chats ON ranked_chats.contact_id = email_messages.contact_id
        WHERE email_messages.contact_id IS NOT NULL
        ` : ''}
    `

    const rows = await db.all(`
      WITH contact_phone_lookup AS (
        SELECT id AS contact_id, phone
        FROM contacts
        WHERE TRIM(COALESCE(phone, '')) != ''
        UNION ALL
        SELECT contact_id, phone
        FROM contact_phone_numbers
        WHERE TRIM(COALESCE(phone, '')) != ''
      ),
      whatsapp_stats_source_rows AS (
        ${whatsappStatsSourceRowsSql}
      ),
      whatsapp_stats_phone_matches AS (
        SELECT whatsapp_stats_source_rows.message_id, whatsapp_stats_source_rows.message_date, contact_phone_lookup.contact_id
        FROM whatsapp_stats_source_rows
        JOIN contact_phone_lookup ON contact_phone_lookup.phone = whatsapp_stats_source_rows.phone
        WHERE whatsapp_stats_source_rows.direct_contact_id IS NULL
          AND TRIM(COALESCE(whatsapp_stats_source_rows.phone, '')) != ''
        UNION ALL
        SELECT whatsapp_stats_source_rows.message_id, whatsapp_stats_source_rows.message_date, contact_phone_lookup.contact_id
        FROM whatsapp_stats_source_rows
        JOIN contact_phone_lookup ON contact_phone_lookup.phone = whatsapp_stats_source_rows.from_phone
        WHERE whatsapp_stats_source_rows.direct_contact_id IS NULL
          AND TRIM(COALESCE(whatsapp_stats_source_rows.from_phone, '')) != ''
        UNION ALL
        SELECT whatsapp_stats_source_rows.message_id, whatsapp_stats_source_rows.message_date, contact_phone_lookup.contact_id
        FROM whatsapp_stats_source_rows
        JOIN contact_phone_lookup ON contact_phone_lookup.phone = whatsapp_stats_source_rows.to_phone
        WHERE whatsapp_stats_source_rows.direct_contact_id IS NULL
          AND TRIM(COALESCE(whatsapp_stats_source_rows.to_phone, '')) != ''
        UNION ALL
        SELECT whatsapp_stats_source_rows.message_id, whatsapp_stats_source_rows.message_date, contact_phone_lookup.contact_id
        FROM whatsapp_stats_source_rows
        JOIN contact_phone_lookup ON contact_phone_lookup.phone = whatsapp_stats_source_rows.api_profile_phone
        WHERE whatsapp_stats_source_rows.direct_contact_id IS NULL
          AND TRIM(COALESCE(whatsapp_stats_source_rows.api_profile_phone, '')) != ''
      ),
      message_stats_rows AS (
        ${messageStatsRowsSql}
      ),
      chat_stats AS (
        SELECT
          contact_id,
          SUM(message_count) AS message_count,
          MAX(last_message_date) AS last_message_date,
          MAX(last_message_sort) AS last_message_sort
        FROM message_stats_rows
        GROUP BY contact_id
      ),
      ranked_chats AS (
        SELECT
          chat_stats.contact_id,
          chat_stats.message_count,
          chat_stats.last_message_date,
          chat_stats.last_message_sort
        FROM chat_stats
        JOIN contacts c ON c.id = chat_stats.contact_id
        ${whereClause}
        ORDER BY chat_stats.last_message_sort DESC, chat_stats.contact_id DESC
        LIMIT ? OFFSET ?
      ),
      ranked_contact_phones AS (
        SELECT ranked_chats.contact_id, contacts.phone
        FROM ranked_chats
        JOIN contacts ON contacts.id = ranked_chats.contact_id
        WHERE TRIM(COALESCE(contacts.phone, '')) != ''
        UNION ALL
        SELECT ranked_chats.contact_id, contact_phone_numbers.phone
        FROM ranked_chats
        JOIN contact_phone_numbers ON contact_phone_numbers.contact_id = ranked_chats.contact_id
        WHERE TRIM(COALESCE(contact_phone_numbers.phone, '')) != ''
      ),
      selected_message_rows AS (
        ${selectedMessageRowsSql}
      ),
      latest_messages AS (
        SELECT
          *,
          ROW_NUMBER() OVER (
            PARTITION BY contact_id
            ORDER BY ${timestampSortExpression('message_date')} DESC, ${timestampSortExpression('created_at')} DESC
          ) AS row_rank
        FROM selected_message_rows
      ),
      latest_inbound_messages AS (
        SELECT
          *,
          ROW_NUMBER() OVER (
            PARTITION BY contact_id
            ORDER BY ${timestampSortExpression('message_date')} DESC, ${timestampSortExpression('created_at')} DESC
          ) AS row_rank
        FROM selected_message_rows
        WHERE direction = 'inbound'
          AND (business_phone_number_id IS NOT NULL OR business_phone IS NOT NULL)
      ),
      first_inbound_messages AS (
        SELECT
          *,
          ROW_NUMBER() OVER (
            PARTITION BY contact_id
            ORDER BY ${timestampSortExpression('message_date')} ASC, ${timestampSortExpression('created_at')} ASC
          ) AS row_rank
        FROM selected_message_rows
        WHERE direction = 'inbound'
          AND (business_phone_number_id IS NOT NULL OR business_phone IS NOT NULL)
      ),
      payment_stats AS (
        SELECT
          payments.contact_id,
          SUM(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN amount ELSE 0 END) AS total_paid,
          SUM(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN 1 ELSE 0 END) AS purchases_count,
          SUM(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                THEN 1 ELSE 0 END) AS customer_payments_count,
          MAX(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN date ELSE NULL END) AS last_purchase_date,
          MAX(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                THEN COALESCE(paid_at, date, created_at) ELSE NULL END) AS last_customer_payment_date
        FROM payments
        JOIN ranked_chats ON ranked_chats.contact_id = payments.contact_id
        GROUP BY payments.contact_id
      )
      SELECT
        c.id,
        c.phone,
        c.email,
        c.full_name,
        c.first_name,
        c.last_name,
        c.source,
        c.attribution_ad_name,
        c.attribution_ad_id,
        c.preferred_whatsapp_phone_number_id,
        c.custom_fields,
        c.tags,
${CONTACT_WHATSAPP_PROFILE_SELECTS},
${CONTACT_META_PROFILE_SELECT},
${CONTACT_META_MESSAGE_FLAGS_SELECT},
        COALESCE(ps.total_paid, 0) AS total_paid,
        COALESCE(ps.purchases_count, 0) AS purchases_count,
        COALESCE(ps.customer_payments_count, ps.purchases_count, 0) AS customer_payments_count,
        ps.last_purchase_date AS last_purchase_date,
        ps.last_customer_payment_date AS last_customer_payment_date,
        c.appointment_date,
        c.created_at,
        (
          SELECT COUNT(*) > 0
          FROM appointments
          WHERE contact_id = c.id
            AND ${ACTIVE_APPOINTMENT_CONDITION}
        ) AS has_appointments,
        (
          COALESCE(ps.customer_payments_count, ps.purchases_count, 0) > 0
          OR EXISTS (
            SELECT 1
            FROM appointment_attendance_signals aas
            WHERE aas.contact_id = c.id
          )
          OR EXISTS (
            SELECT 1
            FROM appointments
            WHERE contact_id = c.id
              AND ${ATTENDED_APPOINTMENT_CONDITION}
          )
        ) AS has_showed_appointment,
        (
          SELECT COUNT(*) > 0
          FROM appointments
          WHERE contact_id = c.id
            AND ${CONFIRMATION_BADGE_CONDITION}
        ) AS has_confirmation_badge,
        ranked_chats.message_count,
        lm.message_date AS last_message_date,
        lm.message_text AS last_message_text,
        lm.message_type AS last_message_type,
        lm.message_channel AS last_message_channel,
        lm.direction AS last_message_direction,
        lm.business_phone AS last_business_phone,
        lm.business_phone_number_id AS last_business_phone_number_id,
        lm.transport AS last_message_transport,
        lim.business_phone AS last_inbound_business_phone,
        lim.business_phone_number_id AS last_inbound_business_phone_number_id,
        fim.business_phone AS first_inbound_business_phone,
        fim.business_phone_number_id AS first_inbound_business_phone_number_id,
        0 AS unread_count
      FROM ranked_chats
      JOIN contacts c ON c.id = ranked_chats.contact_id
      LEFT JOIN payment_stats ps ON ps.contact_id = c.id
      LEFT JOIN latest_messages lm ON lm.contact_id = c.id AND lm.row_rank = 1
      LEFT JOIN latest_inbound_messages lim ON lim.contact_id = c.id AND lim.row_rank = 1
      LEFT JOIN first_inbound_messages fim ON fim.contact_id = c.id AND fim.row_rank = 1
      ORDER BY ranked_chats.last_message_sort DESC, ranked_chats.contact_id DESC
    `, [
      ...whatsappMessageParams,
      ...params,
      limitNumber,
      offsetNumber,
      ...whatsappMessageParams,
      ...whatsappMessageParams
    ])

    const responseRows = shouldWarmProfilePictures
      ? await warmWhatsAppProfilePicturesForRows(rows, {
          apiLimit: 60,
          qrLimit: 24
        })
      : rows
    const responseRowsWithPhones = await attachContactPhoneNumbers(responseRows)
    const unreadCounts = await getChatUnreadCountsForUser({
      userId: getRequestUserId(req),
      contactIds: responseRowsWithPhones.map(row => row.id)
    })

    res.json({
      success: true,
      data: responseRowsWithPhones.map(row => mapChatContactRowForResponse({
        ...row,
        unread_count: unreadCounts.get(String(row.id)) || 0
      }))
    })
  } catch (error) {
    logger.error(`Error obteniendo chats: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo chats'
    })
  }
}

export const markChatContactRead = async (req, res) => {
  try {
    const userId = getRequestUserId(req)
    const contactId = cleanString(req.params?.id || req.body?.contactId)

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Usuario no autenticado'
      })
    }

    if (!contactId) {
      return res.status(400).json({
        success: false,
        error: 'Contacto inválido'
      })
    }

    const state = await markChatContactReadForUser({ userId, contactId })
    let sendProviderReadReceipts = true
    try {
      sendProviderReadReceipts = isProviderReadReceiptsEnabled(
        await getAppConfig(CHAT_SEND_READ_RECEIPTS_CONFIG_KEY)
      )
    } catch (error) {
      logger.warn('[Contacts] No se pudo leer configuracion de vistos externos; se mantiene comportamiento default', {
        contactId,
        error: error?.message
      })
    }

    if (!sendProviderReadReceipts) {
      return res.json({
        success: true,
        data: state,
        providerRead: {
          enabled: false,
          reason: 'read_receipts_disabled'
        }
      })
    }

    queueProviderReadReceiptsForContact(contactId)
    res.json({
      success: true,
      data: state,
      providerRead: {
        enabled: true,
        queued: true
      }
    })
  } catch (error) {
    logger.error(`Error marcando chat como leído: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error marcando chat como leído'
    })
  }
}

export const markChatContactsRead = async (req, res) => {
  try {
    const userId = getRequestUserId(req)
    const rawContactIds = Array.isArray(req.body?.contactIds)
      ? req.body.contactIds
      : Array.isArray(req.body?.ids)
        ? req.body.ids
        : []
    const contactIds = rawContactIds.map(cleanString).filter(Boolean)

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Usuario no autenticado'
      })
    }

    if (!contactIds.length) {
      return res.status(400).json({
        success: false,
        error: 'Selecciona al menos un chat'
      })
    }

    const state = await markChatContactsReadForUser({ userId, contactIds })
    res.json({ success: true, data: state })
  } catch (error) {
    logger.error(`Error marcando chats como leídos: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error marcando chats como leídos'
    })
  }
}

/**
 * Obtiene todos los contactos con paginación y filtros
 */
export const getContacts = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      search = '',
      sortBy = 'created_at',
      sortOrder = 'DESC',
      startDate,
      endDate,
      filter = 'all'
    } = req.query

    const pageNumber = Number(page) || 1
    const limitNumber = Math.min(Number(limit) || 50, 500)
    const offset = Math.max((pageNumber - 1) * limitNumber, 0)
    const shouldWarmProfilePictures = isTruthyQueryValue(req.query.warmProfilePictures || req.query.warmProfiles)
    const quickFilter = normalizeContactListQuickFilter(filter)
    const trackingFilters = normalizeContactListTrackingFilters(req.query.trackingFilters || req.query.filters)
    const advancedFilterConfig = normalizeContactAdvancedFilters(req.query.advancedFilters || req.query.conditions)
    if (!(await assertContactAdvancedFilterFeatureAccess(res, advancedFilterConfig))) return
    const advancedSort = getContactAdvancedSort(advancedFilterConfig)

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
    const rangeLabel = range.isFiltered
      ? `${range.startUtc || '---'} -> ${range.endUtc || '---'}`
      : 'todos'

    logger.info(`Obteniendo contactos - página ${pageNumber}, límite ${limitNumber}, rango: ${rangeLabel}`)

    // Aplicar filtro de contactos ocultos (para COUNT - sin alias)
    const hiddenFilters = await getHiddenContactFilters()
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false)
    const countWhere = buildContactListWhere({
      alias: 'contacts',
      search,
      range,
      hiddenCondition,
      quickFilter,
      trackingFilters,
      advancedFilters: advancedFilterConfig
    })

    // Obtener el total de contactos
    const countQuery = `SELECT COUNT(*) as total FROM contacts ${countWhere.whereClause}`
    const countResult = await db.get(countQuery, countWhere.params)
    const totalContacts = countResult.total

    // Construir WHERE clause para query principal (con alias 'c')
    const hiddenConditionAlias = buildHiddenContactsCondition(hiddenFilters, 'c', false)
    const mainWhere = buildContactListWhere({
      alias: 'c',
      search,
      range,
      hiddenCondition: hiddenConditionAlias,
      quickFilter,
      trackingFilters,
      advancedFilters: advancedFilterConfig
    })

    // Obtener los contactos
    const safeSortBy = getContactListSortExpression(advancedSort?.by || sortBy, 'c', 'ps')
    const orderDirection = String(advancedSort?.order || sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC'

    const searchRank = search ? buildContactSearchRank('c', search) : null
    const orderBy = searchRank
      ? `${searchRank.expression} DESC, ${safeSortBy} ${orderDirection}, c.id ${orderDirection}`
      : `${safeSortBy} ${orderDirection}, c.id ${orderDirection}`

    const contactsQuery = `
      WITH ${buildContactListPaymentStatsCte()}
      SELECT
        c.id,
        c.phone,
        c.email,
        c.full_name,
        c.first_name,
        c.last_name,
        c.source,
        c.visitor_id,
        c.attribution_url,
        c.attribution_session_source,
        c.attribution_medium,
        c.attribution_ctwa_clid,
        c.attribution_ad_name,
        c.attribution_ad_id,
        c.preferred_whatsapp_phone_number_id,
        c.custom_fields,
        c.tags,
${CONTACT_WHATSAPP_PROFILE_SELECTS},
${CONTACT_META_PROFILE_SELECT},
        COALESCE(ps.total_paid, 0) AS total_paid,
        COALESCE(ps.payments_count, 0) AS payments_count,
        COALESCE(ps.purchases_count, 0) AS purchases_count,
        COALESCE(ps.customer_payments_count, ps.purchases_count, 0) AS customer_payments_count,
        COALESCE(ps.failed_payments_count, 0) AS failed_payments_count,
        ps.last_purchase_date AS last_purchase_date,
        ps.last_customer_payment_date AS last_customer_payment_date,
        c.appointment_date,
        c.created_at,
        (
          SELECT COUNT(*) > 0
          FROM appointments
          WHERE contact_id = c.id
            AND ${ACTIVE_APPOINTMENT_CONDITION}
        ) AS has_appointments,
        (
          COALESCE(ps.customer_payments_count, ps.purchases_count, 0) > 0
          OR EXISTS (
            SELECT 1
            FROM appointment_attendance_signals aas
            WHERE aas.contact_id = c.id
          )
          OR EXISTS (
            SELECT 1
            FROM appointments
            WHERE contact_id = c.id
              AND ${ATTENDED_APPOINTMENT_CONDITION}
          )
        ) AS has_showed_appointment,
        (
          SELECT COUNT(*) > 0
          FROM appointments
          WHERE contact_id = c.id
            AND ${CONFIRMATION_BADGE_CONDITION}
        ) AS has_confirmation_badge
      FROM contacts c
      LEFT JOIN payment_stats ps ON ps.contact_id = c.id
      ${mainWhere.whereClause}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `

    const contactsParams = [...mainWhere.params, ...(searchRank?.params ?? []), limitNumber, offset]
    const contacts = await db.all(contactsQuery, contactsParams)
    const hydratedContacts = shouldWarmProfilePictures
      ? await warmWhatsAppProfilePicturesForRows(contacts, {
          apiLimit: Math.min(limitNumber, 80),
          qrLimit: Math.min(limitNumber, 24)
        })
      : contacts
    const contactsWithPhones = await attachContactPhoneNumbers(hydratedContacts)

    const firstSessionsByContact = new Map()
    const firstSessionsByVisitor = new Map()
    const firstSessionsByEmail = new Map()
    const contactIds = Array.from(new Set(contactsWithPhones.map(c => c.id).filter(Boolean)))
    const visitorIds = Array.from(new Set(contactsWithPhones.map(c => c.visitor_id).filter(Boolean)))
    const emails = Array.from(new Set(
      contactsWithPhones
        .map(c => c.email)
        .filter(Boolean)
        .map(email => String(email).toLowerCase())
    ))

    if (contactIds.length > 0 || visitorIds.length > 0 || emails.length > 0) {
      const sessionConditions = []
      const sessionParams = []

      const addInCondition = (field, values) => {
        if (!values.length) return
        sessionConditions.push(`${field} IN (${values.map(() => '?').join(', ')})`)
        sessionParams.push(...values)
      }

      addInCondition('contact_id', contactIds)
      addInCondition('visitor_id', visitorIds)
      addInCondition('LOWER(email)', emails)

      const firstSessions = await db.all(`
        SELECT
          id,
          contact_id,
          visitor_id,
          email,
          started_at,
          created_at,
          page_url,
          referrer_url,
          utm_source,
          utm_medium,
          utm_campaign,
          utm_content,
          utm_term,
          source_platform,
          site_source_name,
          campaign_name,
          adset_name,
          ad_name,
          ad_id,
          device_type,
          browser,
          os,
          placement,
          geo_city,
          geo_region,
          geo_country
        FROM sessions
        WHERE ${sessionConditions.join(' OR ')}
        ORDER BY started_at ASC, created_at ASC, id ASC
      `, sessionParams)

      firstSessions.forEach(session => {
        if (session.contact_id && !firstSessionsByContact.has(session.contact_id)) {
          firstSessionsByContact.set(session.contact_id, session)
        }
        if (session.visitor_id && !firstSessionsByVisitor.has(session.visitor_id)) {
          firstSessionsByVisitor.set(session.visitor_id, session)
        }
        if (session.email) {
          const emailKey = String(session.email).toLowerCase()
          if (!firstSessionsByEmail.has(emailKey)) {
            firstSessionsByEmail.set(emailKey, session)
          }
        }
      })
    }

    const getFirstSessionForContact = (contact) =>
      firstSessionsByContact.get(contact.id) ||
      (contact.visitor_id ? firstSessionsByVisitor.get(contact.visitor_id) : null) ||
      (contact.email ? firstSessionsByEmail.get(String(contact.email).toLowerCase()) : null) ||
      null

    const whatsappAttributionsByContact = await loadFirstWhatsAppAttributions(contactIds)

    // Mapear campos de base de datos a nombres esperados por frontend
    const mappedContacts = contactsWithPhones.map(c => {
      const customerPaymentsCount = getCustomerPaymentsCount(c)
      const firstSession = getFirstSessionForContact(c)
      const attributionFields = buildContactAttributionFields(c, whatsappAttributionsByContact.get(c.id))
      const adFields = getSafeContactAdFields({
        ...c,
        attribution_url: attributionFields.attribution_url,
        attribution_medium: attributionFields.attribution_medium,
        attribution_ctwa_clid: attributionFields.attribution_ctwa_clid,
        attribution_session_source: attributionFields.attribution_session_source
      })

      // Determinar status basado en la actividad del contacto
      let status = 'lead'
      if (customerPaymentsCount > 0) {
        status = 'customer'
      } else if (c.has_appointments) {
        status = 'appointment'
      }

      return {
        id: c.id,
        createdAt: c.created_at,
        name: getContactDisplayName(c),
        email: c.email || '',
        phone: c.phone || '',
        ltv: parseFloat(c.total_paid || 0),
        status,
        lastPurchase: c.last_customer_payment_date || c.last_purchase_date,
        purchases: customerPaymentsCount,
        paymentsCount: c.payments_count || 0,
        successfulPaymentsCount: customerPaymentsCount,
        failedPaymentsCount: c.failed_payments_count || 0,
        hasAppointments: Boolean(c.has_appointments),
        hasShowedAppointment: Boolean(c.has_showed_appointment),
        hasAttendedAppointment: Boolean(c.has_showed_appointment),
        hasUpcomingConfirmedAppointmentBadge: Boolean(c.has_confirmation_badge),
        source: c.source,
        attribution_url: attributionFields.attribution_url,
        attribution_session_source: attributionFields.attribution_session_source,
        attribution_medium: attributionFields.attribution_medium,
        attribution_ctwa_clid: attributionFields.attribution_ctwa_clid,
        whatsappAttributionPlatform: attributionFields.whatsappAttributionPlatform,
        ad_name: adFields.ad_name,
        ad_id: adFields.ad_id,
        preferredWhatsAppPhoneNumberId: c.preferred_whatsapp_phone_number_id || '',
        preferred_whatsapp_phone_number_id: c.preferred_whatsapp_phone_number_id || '',
        profilePhotoUrl: getContactProfilePhotoUrl(c) || null,
        phones: buildContactPhonesForResponse(c),
        phoneNumbers: buildContactPhonesForResponse(c),
        customFields: parseContactCustomFields(c.custom_fields),
        tags: parseContactTags(c.tags),
        firstSession: firstSession ? {
          started_at: firstSession.started_at,
          page_url: firstSession.page_url,
          landing_page: firstSession.page_url,
          referrer_url: firstSession.referrer_url,
          utm_source: firstSession.utm_source,
          utm_medium: firstSession.utm_medium,
          utm_campaign: firstSession.utm_campaign,
          utm_content: firstSession.utm_content,
          utm_term: firstSession.utm_term,
          source_platform: firstSession.source_platform,
          site_source_name: firstSession.site_source_name,
          campaign_name: firstSession.campaign_name,
          adset_name: firstSession.adset_name,
          ad_name: firstSession.ad_name,
          ad_id: firstSession.ad_id,
          device_type: firstSession.device_type,
          browser: firstSession.browser,
          os: firstSession.os,
          placement: firstSession.placement,
          geo_city: firstSession.geo_city,
          geo_region: firstSession.geo_region,
          geo_country: firstSession.geo_country
        } : null,
        notes: ''
      }
    })

    // Calcular información de paginación
    const totalPages = Math.ceil(totalContacts / limitNumber)

    logger.debug(
      `Contactos obtenidos (${rangeLabel}) -> ${contactsWithPhones.length} registros en esta página, ${totalContacts} total`
    )

    res.json({
      success: true,
      data: mappedContacts,
      pagination: {
        page: pageNumber,
        limit: limitNumber,
        total: totalContacts,
        totalPages,
        hasNext: pageNumber < totalPages,
        hasPrev: pageNumber > 1
      }
    })

  } catch (error) {
    logger.error(`Error obteniendo contactos: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo contactos'
    })
  }
}

/**
 * Obtiene un contacto por ID
 */
export const getContactById = async (req, res) => {
  try {
    const { id } = req.params
    const shouldWarmProfilePictures = !isExplicitFalseQueryValue(
      req.query?.warmProfilePictures ?? req.query?.warmProfiles ?? req.query?.hydrateProfilePictures
    )
    const shouldRefreshExternalAppointments = !isExplicitFalseQueryValue(
      req.query?.refreshExternalAppointments ?? req.query?.refreshAppointments
    )

    // (SEC-005 / ACL-002) Aplicar filtro de contactos ocultos también al detalle por ID:
    // si el contacto cae bajo un filtro de ocultos, responder 404 (no exponerlo por ID).
    const hiddenFilters = await getHiddenContactFilters()
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)

    let contact = await db.get(
      `WITH payment_stats AS (
        SELECT
          contact_id,
          SUM(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN amount ELSE 0 END) AS total_paid,
          SUM(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN 1 ELSE 0 END) AS purchases_count,
          SUM(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                THEN 1 ELSE 0 END) AS customer_payments_count,
          MAX(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN date ELSE NULL END) AS last_purchase_date,
          MAX(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                THEN COALESCE(paid_at, date, created_at) ELSE NULL END) AS last_customer_payment_date
        FROM payments
        WHERE contact_id = ?
        GROUP BY contact_id
      )
      SELECT
        c.id,
        c.phone,
        c.email,
        c.full_name,
        c.first_name,
        c.last_name,
        c.source,
        c.visitor_id,
        c.attribution_url,
        c.attribution_session_source,
        c.attribution_medium,
        c.attribution_ctwa_clid,
        c.attribution_ad_name,
        c.attribution_ad_id,
        c.preferred_whatsapp_phone_number_id,
        c.custom_fields,
        c.tags,
${CONTACT_WHATSAPP_PROFILE_SELECTS},
${CONTACT_META_PROFILE_SELECT},
        COALESCE(ps.total_paid, 0) AS total_paid,
        COALESCE(ps.purchases_count, 0) AS purchases_count,
        COALESCE(ps.customer_payments_count, ps.purchases_count, 0) AS customer_payments_count,
        ps.last_purchase_date AS last_purchase_date,
        ps.last_customer_payment_date AS last_customer_payment_date,
        c.appointment_date,
        c.created_at,
        (
          SELECT COUNT(*) > 0
          FROM appointments
          WHERE contact_id = c.id
            AND ${ACTIVE_APPOINTMENT_CONDITION}
        ) AS has_appointments,
        (
          COALESCE(ps.customer_payments_count, ps.purchases_count, 0) > 0
          OR EXISTS (
            SELECT 1
            FROM appointment_attendance_signals aas
            WHERE aas.contact_id = c.id
          )
          OR EXISTS (
            SELECT 1
            FROM appointments
            WHERE contact_id = c.id
              AND ${ATTENDED_APPOINTMENT_CONDITION}
          )
        ) AS has_showed_appointment,
        (
          SELECT COUNT(*) > 0
          FROM appointments
          WHERE contact_id = c.id
            AND ${CONFIRMATION_BADGE_CONDITION}
        ) AS has_confirmation_badge
      FROM contacts c
      LEFT JOIN payment_stats ps ON ps.contact_id = c.id
      WHERE c.id = ? AND c.deleted_at IS NULL${hiddenCondition ? ` AND ${hiddenCondition}` : ''}`,
      [id, id]
    )

    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contacto no encontrado'
      })
    }

    if (shouldWarmProfilePictures) {
      const [hydratedContact] = await warmWhatsAppProfilePicturesForRows([contact], {
        apiLimit: 1,
        qrLimit: 1
      })
      contact = hydratedContact || contact
    }

    // Obtener pagos del contacto
    const paymentDateSort = timestampSortExpression('date')
    const paymentCreatedSort = timestampSortExpression('created_at')
    const payments = await db.all(
      `SELECT * FROM payments
       WHERE contact_id = ?
       AND LOWER(COALESCE(status, '')) != 'deleted'
       -- Ocultar intentos de checkout de sitio no completados (solo paid/failed reales)
       AND NOT (
         (COALESCE(metadata_json, '') LIKE '%site_checkout%' OR COALESCE(metadata_json, '') LIKE '%site_form%')
         AND LOWER(COALESCE(status, '')) IN ('sent', 'pending', 'processing', 'requires_action', 'requires_payment_method', 'incomplete', 'draft', 'initiated')
       )
       ORDER BY ${paymentDateSort} DESC, ${paymentCreatedSort} DESC, id DESC`,
      [id]
    )

    // IMPORTANTE: Estrategia de obtención de citas (DB first, API as fallback)
    // 1. Primero consultamos la DB local (tabla appointments) - respuesta inmediata
    // 2. Si hay configuración de HighLevel, hacemos fallback a API en tiempo real
    // 3. Las citas nuevas de la API se guardan en DB para cache futuro
    // Esto garantiza mejor performance y resiliencia (funciona offline)
    const appointmentStartSort = timestampSortExpression('start_time')
    let appointments = await db.all(
      `SELECT * FROM appointments
       WHERE contact_id = ?
       ORDER BY ${appointmentStartSort} DESC, id DESC`,
      [id]
    )

    // Fallback: Intentar obtener citas de HighLevel API en tiempo real.
    // Chat puede pedir refreshExternalAppointments=false para pintar mensajes sin esperar APIs externas.
    if (shouldRefreshExternalAppointments) {
      try {
        // Obtener configuración de HighLevel
        const config = await db.get(
          'SELECT location_id, api_token FROM highlevel_config LIMIT 1'
        )

        if (config && config.api_token) {
          logger.info(`Obteniendo citas de HighLevel para contacto ${id}`)

          // Usar el endpoint correcto: /contacts/{contactId}/appointments
          const eventsResponse = await fetch(
            `https://services.leadconnectorhq.com/contacts/${id}/appointments`,
            {
              headers: {
                'Authorization': `Bearer ${config.api_token}`,
                'Version': '2021-07-28'
              }
            }
          )

          if (eventsResponse.ok) {
            const eventsData = await eventsResponse.json()

            if (eventsData.events && eventsData.events.length > 0) {
              logger.info(`Encontradas ${eventsData.events.length} citas en HighLevel para contacto ${id}`)

              // Guardar las citas en la DB para cache
              for (const appointment of eventsData.events) {
                await db.run(`
                  INSERT INTO appointments (
                    id, calendar_id, contact_id, location_id, title,
                    status, appointment_status, assigned_user_id, notes,
                    address, start_time, end_time, date_added, date_updated
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT (id) DO UPDATE SET
                    title = excluded.title,
                    status = excluded.status,
                    appointment_status = excluded.appointment_status,
                    start_time = excluded.start_time,
                    end_time = excluded.end_time,
                    date_updated = excluded.date_updated
                `, [
                  appointment.id,
                  appointment.calendarId,
                  appointment.contactId,
                  appointment.locationId || config.location_id,
                  appointment.title || '(Sin título)',
                  appointment.status,
                  appointment.appointmentStatus,
                  appointment.assignedUserId,
                  appointment.notes,
                  appointment.address,
                  appointment.startTime ? new Date(appointment.startTime) : null,
                  appointment.endTime ? new Date(appointment.endTime) : null,
                  appointment.dateAdded ? new Date(appointment.dateAdded) : new Date(),
                  new Date()
                ])
              }

              // Combinar con las citas locales (evitando duplicados)
              const appointmentIds = new Set(appointments.map(a => a.id))
              for (const appointment of eventsData.events) {
                if (!appointmentIds.has(appointment.id)) {
                  appointments.push({
                    id: appointment.id,
                    calendar_id: appointment.calendarId,
                    contact_id: appointment.contactId,
                    title: appointment.title,
                    status: appointment.status,
                    appointment_status: appointment.appointmentStatus,
                    assigned_user_id: appointment.assignedUserId,
                    notes: appointment.notes,
                    address: appointment.address,
                    start_time: appointment.startTime,
                    end_time: appointment.endTime
                  })
                }
              }

              logger.info(`Total de citas después de combinar: ${appointments.length}`)
            } else {
              logger.info(`No se encontraron citas en HighLevel para contacto ${id}`)
            }
          } else {
            const errorText = await eventsResponse.text()
            logger.warn(`Error obteniendo citas de HighLevel: ${eventsResponse.status} - ${errorText.substring(0, 100)}`)
          }
        }
      } catch (error) {
        logger.warn(`No se pudieron obtener citas de HighLevel para contacto ${id}: ${error.message}`)
        // Continuar con las citas locales si falla HighLevel
      }
    }

    const normalizedPhone = normalizePhone(contact.phone)
    let relatedContactIds = []

    if (normalizedPhone) {
      const relatedContacts = await db.all(
        `SELECT id, phone
         FROM contacts
         WHERE id != ?
           AND phone IS NOT NULL
           AND phone != ''
           AND phone LIKE ?`,
        [id, `%${normalizedPhone}`]
      )

      relatedContactIds = relatedContacts
        .filter(row => normalizePhone(row.phone) === normalizedPhone)
        .map(row => row.id)
    }

    if (relatedContactIds.length > 0) {
      const placeholders = relatedContactIds.map(() => '?').join(', ')
      const relatedAppointments = await db.all(
        `SELECT *
         FROM appointments
         WHERE contact_id IN (${placeholders})
         ORDER BY ${appointmentStartSort} DESC, id DESC`,
        relatedContactIds
      )
      appointments = appointments.concat(relatedAppointments)
    }

    const dedupedAppointments = dedupeAppointments(appointments)
    const sortedAppointmentsAsc = [...dedupedAppointments].sort((a, b) =>
      parseSortableTimestamp(a.start_time) - parseSortableTimestamp(b.start_time)
    )

    // Calcular primera cita y próxima cita
    let firstAppointmentDate = null
    let nextAppointmentDate = null

    if (sortedAppointmentsAsc.length > 0) {
      firstAppointmentDate = sortedAppointmentsAsc[0].start_time

      const now = new Date()
      const futureAppointments = sortedAppointmentsAsc.filter(apt => {
        if (!apt?.start_time) return false
        const aptDate = new Date(apt.start_time)
        if (Number.isNaN(aptDate.getTime()) || aptDate <= now) {
          return false
        }
        const statusValue = String(apt.appointment_status || apt.status || '').toLowerCase()
        return !APPOINTMENT_CANCELED_STATUSES.has(statusValue)
      })

      if (futureAppointments.length > 0) {
        nextAppointmentDate = futureAppointments[0].start_time
      }
    }

    const appointmentsOrdered = dedupedAppointments.sort((a, b) =>
      parseSortableTimestamp(b.start_time) - parseSortableTimestamp(a.start_time)
    )
    const hasShowedAppointment =
      Boolean(contact.has_showed_appointment) ||
      appointmentsOrdered.some(appointment =>
        APPOINTMENT_ATTENDED_STATUSES.has(String(appointment.appointment_status || appointment.status || '').trim().toLowerCase())
      )

    // Determinar status basado en la actividad del contacto
    const customerPaymentsCount = getCustomerPaymentsCount(contact)
    let status = 'lead'
    if (customerPaymentsCount > 0) {
      status = 'customer'
    } else if (contact.has_appointments) {
      status = 'appointment'
    }

    // Obtener primera sesión (primera atribución/primer toque) del contacto
    let firstSession = null
    try {
      // Buscar por contact_id, visitor_id o email
      let sessionQuery = `
        SELECT *
        FROM sessions
        WHERE contact_id = ?
        ORDER BY started_at ASC
        LIMIT 1
      `
      firstSession = await db.get(sessionQuery, [id])

      // Fallback: buscar por visitor_id si existe
      if (!firstSession && contact.visitor_id) {
        sessionQuery = `
          SELECT *
          FROM sessions
          WHERE visitor_id = ?
          ORDER BY started_at ASC
          LIMIT 1
        `
        firstSession = await db.get(sessionQuery, [contact.visitor_id])
      }

      // Fallback: buscar por email si existe
      if (!firstSession && contact.email) {
        sessionQuery = `
          SELECT *
          FROM sessions
          WHERE email = ?
          ORDER BY started_at ASC
          LIMIT 1
        `
        firstSession = await db.get(sessionQuery, [contact.email])
      }
    } catch (error) {
      logger.warn(`No se pudo obtener primera sesión para contacto ${id}: ${error.message}`)
    }

    const whatsappAttributionsByContact = await loadFirstWhatsAppAttributions([id])
    const whatsappAttribution = whatsappAttributionsByContact.get(id)
    const attributionFields = buildContactAttributionFields(contact, whatsappAttribution)
    const metaAttribution = await getMetaAttributionForContact(contact, firstSession, whatsappAttribution)
    const resolvedAdFields = buildResolvedMetaAdFields(contact, metaAttribution)
    const phoneNumbers = await listContactPhoneNumbers(id)
    const contactWithPhones = { ...contact, phoneNumbers }
    const phones = buildContactPhonesForResponse(contactWithPhones)

    // Mapear campos de base de datos a nombres esperados por frontend
    const mappedContact = {
      id: contact.id,
      createdAt: contact.created_at,
      name: getContactDisplayName(contact),
      email: contact.email || '',
      phone: contact.phone || '',
      ltv: parseFloat(contact.total_paid || 0),
      status,
      lastPurchase: contact.last_customer_payment_date || contact.last_purchase_date,
      purchases: customerPaymentsCount,
      successfulPaymentsCount: customerPaymentsCount,
      source: contact.source,
      ad_name: resolvedAdFields.ad_name,
      ad_id: resolvedAdFields.ad_id,
      campaign_id: resolvedAdFields.campaign_id,
      campaign_name: resolvedAdFields.campaign_name,
      adset_id: resolvedAdFields.adset_id,
      adset_name: resolvedAdFields.adset_name,
      preferredWhatsAppPhoneNumberId: contact.preferred_whatsapp_phone_number_id || '',
      preferred_whatsapp_phone_number_id: contact.preferred_whatsapp_phone_number_id || '',
      profilePhotoUrl: getContactProfilePhotoUrl(contact) || null,
      phones,
      phoneNumbers: phones,
      customFields: parseContactCustomFields(contact.custom_fields),
      tags: parseContactTags(contact.tags),
      notes: '',
      payments,
      appointments: appointmentsOrdered,
      firstAppointmentDate,
      nextAppointmentDate,
      hasAppointments: Boolean(contact.has_appointments),
      hasShowedAppointment,
      hasAttendedAppointment: hasShowedAppointment,
      hasUpcomingConfirmedAppointmentBadge: Boolean(contact.has_confirmation_badge),
      attribution_url: attributionFields.attribution_url,
      attribution_session_source: attributionFields.attribution_session_source,
      attribution_medium: attributionFields.attribution_medium,
      attribution_ctwa_clid: attributionFields.attribution_ctwa_clid,
      whatsappAttributionPlatform: attributionFields.whatsappAttributionPlatform,
      metaAttribution,
      firstSession: firstSession ? {
        started_at: firstSession.started_at,
        page_url: firstSession.page_url,
        landing_page: firstSession.landing_page,
        referrer_url: firstSession.referrer_url,
        utm_source: firstSession.utm_source,
        utm_medium: firstSession.utm_medium,
        utm_campaign: firstSession.utm_campaign,
        utm_content: firstSession.utm_content,
        utm_term: firstSession.utm_term,
        source_platform: firstSession.source_platform,
        site_source_name: firstSession.site_source_name,
        campaign_name: firstSession.campaign_name,
        adset_name: firstSession.adset_name,
        ad_name: firstSession.ad_name,
        ad_id: firstSession.ad_id,
        device_type: firstSession.device_type,
        browser: firstSession.browser,
        os: firstSession.os,
        placement: firstSession.placement,
        geo_city: firstSession.geo_city,
        geo_region: firstSession.geo_region,
        geo_country: firstSession.geo_country
      } : null
    }

    res.json({
      success: true,
      data: mappedContact
    })

  } catch (error) {
    logger.error(`Error obteniendo contacto ${req.params.id}: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo contacto'
    })
  }
}

/**
 * Busca contactos por término de búsqueda
 */
export const searchContacts = async (req, res) => {
  try {
    const { q } = req.query
    const pickerMode = isTruthyQueryValue(
      req.query?.picker ?? req.query?.lightweight ?? req.query?.directory
    )

    if (!q && !pickerMode) {
      return res.json({
        success: true,
        data: []
      })
    }

    // Los selectores nativos de Nuevo chat / Citas / Pagos solo necesitan
    // identidad básica. La búsqueda histórica de contactos calcula LTV,
    // compras, citas/asistencias y además consulta proveedores para calentar
    // avatares: correcto para el CRM, carísimo e innecesario para escoger una
    // persona. Este modo es deliberadamente local y sin I/O externo para que el
    // directorio responda en un solo query aun con proveedores lentos.
    if (pickerMode) {
      const trimmedQuery = cleanString(q)
      const exactContactId = cleanString(req.query?.contactId || req.query?.contact_id)
      const requestedLimit = Number(req.query?.limit)
      const limit = exactContactId
        ? 1
        : Number.isFinite(requestedLimit)
        ? Math.min(Math.max(Math.round(requestedLimit), 1), 100)
        : 60
      const searchClause = !exactContactId && trimmedQuery
        ? buildContactSearchClause('c', trimmedQuery)
        : null
      const searchRank = !exactContactId && trimmedQuery
        ? buildContactSearchRank('c', trimmedQuery)
        : null

      // (ACL-002) El directorio ligero conserva exactamente la exclusión de
      // contactos ocultos del endpoint completo.
      const hiddenFilters = await getHiddenContactFilters()
      const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
      const conditions = ['c.deleted_at IS NULL']
      if (exactContactId) conditions.push('c.id = ?')
      if (searchClause) conditions.push(searchClause.condition)
      if (hiddenCondition) conditions.push(hiddenCondition)

      const orderBy = searchRank
        ? `${searchRank.expression} DESC, c.updated_at DESC, c.created_at DESC, c.id DESC`
        : 'c.updated_at DESC, c.created_at DESC, c.id DESC'
      const params = [
        ...(exactContactId ? [exactContactId] : []),
        ...(searchClause?.params ?? []),
        ...(searchRank?.params ?? []),
        limit
      ]
      const contacts = await db.all(
        `SELECT
          c.id,
          c.full_name,
          c.first_name,
          c.last_name,
          c.email,
          c.phone,
          c.created_at,
          c.updated_at,
          c.source,
          c.preferred_whatsapp_phone_number_id
        FROM contacts c
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${orderBy}
        LIMIT ?`,
        params
      )
      const contactIds = contacts.map(contact => cleanString(contact.id)).filter(Boolean)
      const phoneRowsByContact = new Map(contactIds.map(id => [id, []]))
      if (contactIds.length) {
        const phoneRows = await db.all(
          `SELECT id, contact_id, phone, label, is_primary, source, created_at, updated_at
           FROM contact_phone_numbers
           WHERE contact_id IN (${contactIds.map(() => '?').join(', ')})
           ORDER BY is_primary DESC, created_at ASC, phone ASC`,
          contactIds
        ).catch(() => [])
        phoneRows.forEach(row => {
          const contactId = cleanString(row.contact_id)
          if (!phoneRowsByContact.has(contactId)) return
          phoneRowsByContact.get(contactId).push({
            id: row.id,
            phone: row.phone,
            label: row.label || '',
            isPrimary: Boolean(row.is_primary),
            is_primary: Boolean(row.is_primary),
            source: row.source || '',
            createdAt: row.created_at || null,
            updatedAt: row.updated_at || null
          })
        })
      }
      const latestMessagesByContact = await fetchPickerLatestMessageRowsByContact(contacts, phoneRowsByContact)
      const queryDigits = isPhoneSearchText(trimmedQuery)
        ? normalizePhoneDigits(trimmedQuery)
        : ''

      return res.json({
        success: true,
        data: contacts.map(contact => {
          const latestMessage = latestMessagesByContact.get(cleanString(contact.id)) || {}
          const phones = buildContactPhonesForResponse({
            ...contact,
            phoneNumbers: phoneRowsByContact.get(cleanString(contact.id)) || []
          })
          const matchedPhone = queryDigits
            ? phones.find(entry => normalizePhoneDigits(entry.phone).includes(queryDigits))?.phone || ''
            : ''
          return {
            id: contact.id,
            createdAt: contact.created_at,
            name: getContactDisplayName(contact),
            email: contact.email || '',
            phone: contact.phone || '',
            matchedPhone,
            ltv: 0,
            status: 'lead',
            lastPurchase: null,
            purchases: 0,
            successfulPaymentsCount: 0,
            hasAppointments: false,
            hasShowedAppointment: false,
            hasAttendedAppointment: false,
            hasUpcomingConfirmedAppointmentBadge: false,
            source: contact.source || null,
            profilePhotoUrl: null,
            preferredWhatsAppPhoneNumberId: contact.preferred_whatsapp_phone_number_id || '',
            phones,
            phoneNumbers: phones,
            notes: '',
            lastMessageText: latestMessage.last_message_text || '',
            lastMessageType: latestMessage.last_message_type || '',
            lastMessageChannel: latestMessage.last_message_channel || '',
            lastMessageDate: latestMessage.last_message_date || contact.created_at,
            lastMessageDirection: latestMessage.last_message_direction || '',
            lastBusinessPhone: latestMessage.last_business_phone || '',
            lastBusinessPhoneNumberId: latestMessage.last_business_phone_number_id || '',
            lastInboundBusinessPhone: '',
            lastInboundBusinessPhoneNumberId: '',
            firstInboundBusinessPhone: '',
            firstInboundBusinessPhoneNumberId: '',
            lastMessageTransport: latestMessage.last_message_transport || '',
            messageCount: 0,
            unreadCount: 0,
            hasCommentMessage: false,
            hasPrivateDm: false
          }
        })
      })
    }

    const searchClause = buildContactSearchClause('c', q)
    const searchRank = buildContactSearchRank('c', q)

    // (ACL-002) Excluir contactos ocultos también en la búsqueda de contactos.
    const hiddenFilters = await getHiddenContactFilters()
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)

    const contacts = await db.all(
      `WITH payment_stats AS (
        SELECT
          contact_id,
          SUM(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN amount ELSE 0 END) AS total_paid,
          SUM(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN 1 ELSE 0 END) AS purchases_count,
          SUM(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                THEN 1 ELSE 0 END) AS customer_payments_count,
          MAX(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN date ELSE NULL END) AS last_purchase_date,
          MAX(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                THEN COALESCE(paid_at, date, created_at) ELSE NULL END) AS last_customer_payment_date
        FROM payments
        GROUP BY contact_id
      )
      SELECT
        c.id,
        c.full_name,
        c.email,
        c.phone,
        COALESCE(ps.total_paid, 0) AS total_paid,
        COALESCE(ps.purchases_count, 0) AS purchases_count,
        COALESCE(ps.customer_payments_count, ps.purchases_count, 0) AS customer_payments_count,
        c.appointment_date,
        ps.last_purchase_date AS last_purchase_date,
        ps.last_customer_payment_date AS last_customer_payment_date,
        c.created_at,
        c.source,
        c.attribution_ad_name,
        c.attribution_ad_id,
${CONTACT_WHATSAPP_PROFILE_SELECTS},
${CONTACT_META_PROFILE_SELECT},
        (
          SELECT COUNT(*) > 0
          FROM appointments
          WHERE contact_id = c.id
            AND ${ACTIVE_APPOINTMENT_CONDITION}
        ) AS has_appointments,
        (
          COALESCE(ps.customer_payments_count, ps.purchases_count, 0) > 0
          OR EXISTS (
            SELECT 1
            FROM appointment_attendance_signals aas
            WHERE aas.contact_id = c.id
          )
          OR EXISTS (
            SELECT 1
            FROM appointments
            WHERE contact_id = c.id
              AND ${ATTENDED_APPOINTMENT_CONDITION}
          )
        ) AS has_showed_appointment,
        (
          SELECT COUNT(*) > 0
          FROM appointments
          WHERE contact_id = c.id
            AND ${CONFIRMATION_BADGE_CONDITION}
        ) AS has_confirmation_badge
      FROM contacts c
      LEFT JOIN payment_stats ps ON ps.contact_id = c.id
      WHERE ${searchClause.condition} AND c.deleted_at IS NULL${hiddenCondition ? ` AND ${hiddenCondition}` : ''}
      ORDER BY ${searchRank.expression} DESC, ${timestampSortExpression('c.created_at')} DESC, c.id DESC
      LIMIT 20`,
      [...searchClause.params, ...searchRank.params]
    )
    const hydratedContacts = await warmWhatsAppProfilePicturesForRows(contacts, {
      apiLimit: 20,
      qrLimit: 10
    })
    const contactsWithPhones = await attachContactPhoneNumbers(hydratedContacts)

    // Mapear campos de base de datos a nombres esperados por frontend
    const mappedContacts = contactsWithPhones.map(c => {
      const customerPaymentsCount = getCustomerPaymentsCount(c)
      // Determinar status basado en la actividad del contacto
      let status = 'lead'
      if (customerPaymentsCount > 0) {
        status = 'customer'
      } else if (c.has_appointments) {
        status = 'appointment'
      }

      return {
        id: c.id,
        createdAt: c.created_at,
        name: getContactDisplayName(c),
        email: c.email || '',
        phone: c.phone || '',
        ltv: parseFloat(c.total_paid || 0),
        status,
        lastPurchase: c.last_customer_payment_date || c.last_purchase_date,
        purchases: customerPaymentsCount,
        successfulPaymentsCount: customerPaymentsCount,
        hasAppointments: Boolean(c.has_appointments),
        hasShowedAppointment: Boolean(c.has_showed_appointment),
        hasAttendedAppointment: Boolean(c.has_showed_appointment),
        hasUpcomingConfirmedAppointmentBadge: Boolean(c.has_confirmation_badge),
        source: c.source,
        ad_name: c.attribution_ad_name,
        ad_id: c.attribution_ad_id,
        profilePhotoUrl: getContactProfilePhotoUrl(c) || null,
        phones: buildContactPhonesForResponse(c),
        phoneNumbers: buildContactPhonesForResponse(c),
        notes: ''
      }
    })

    res.json({
      success: true,
      data: mappedContacts
    })

  } catch (error) {
    logger.error(`Error buscando contactos: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error buscando contactos'
    })
  }
}

export const getContactPaymentLinkDeliveryOptions = async (req, res) => {
  try {
    const contactId = cleanString(req.params.id)
    if (!contactId) {
      return res.status(400).json({
        success: false,
        error: 'Contacto inválido'
      })
    }

    const contact = await db.get(
      `SELECT id, full_name, first_name, last_name, email, phone
       FROM contacts
       WHERE id = ?
       LIMIT 1`,
      [contactId]
    )

    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contacto no encontrado'
      })
    }

    const [
      emailStatus,
      whatsappStatus,
      metaConfig,
      messengerMessagingEnabled,
      instagramMessagingEnabled,
      metaProfiles
    ] = await Promise.all([
      getEmailStatus().catch(() => ({ connected: false })),
      getWhatsAppApiStatus().catch(() => ({ connected: false, phoneNumbers: [] })),
      db.get('SELECT access_token, page_id, instagram_account_id FROM meta_config LIMIT 1').catch(() => null),
      isMetaSocialMessagingEnabled('messenger').catch(() => false),
      isMetaSocialMessagingEnabled('instagram').catch(() => false),
      db.all(
        `SELECT platform, profile_name, username
         FROM meta_social_contacts
         WHERE contact_id = ?
         GROUP BY platform, profile_name, username`,
        [contactId]
      ).catch(() => [])
    ])

    const email = cleanString(contact.email)
    const phone = cleanString(contact.phone)
    const whatsappConnected = Boolean(
      whatsappStatus?.connected ||
      (Array.isArray(whatsappStatus?.phoneNumbers) && whatsappStatus.phoneNumbers.some(phoneNumber => (
        phoneNumber?.availability?.available ||
        phoneNumber?.availability?.apiAvailable ||
        phoneNumber?.availability?.qrReady
      )))
    )
    const messengerConnected = Boolean(
      cleanString(metaConfig?.access_token) &&
      cleanString(metaConfig?.page_id) &&
      messengerMessagingEnabled
    )
    const instagramConnected = Boolean(
      cleanString(metaConfig?.access_token) &&
      cleanString(metaConfig?.instagram_account_id) &&
      instagramMessagingEnabled
    )
    const metaPlatforms = new Set(
      metaProfiles
        .map(profile => cleanString(profile.platform).toLowerCase())
        .filter(Boolean)
    )
    const profileByPlatform = new Map(
      metaProfiles.map(profile => [cleanString(profile.platform).toLowerCase(), profile])
    )
    const hasMessengerProfile = metaPlatforms.has('messenger')
    const hasInstagramProfile = metaPlatforms.has('instagram')

    res.json({
      success: true,
      data: {
        contact: {
          id: contact.id,
          name: getContactDisplayName(contact),
          email,
          phone
        },
        channels: {
          whatsapp: {
            key: 'whatsapp',
            label: 'WhatsApp',
            available: Boolean(whatsappConnected && phone),
            connected: whatsappConnected,
            value: phone,
            reason: !phone
              ? 'El contacto no tiene teléfono'
              : !whatsappConnected
                ? 'Conecta WhatsApp API para enviar este link desde Ristak'
                : ''
          },
          messenger: {
            key: 'messenger',
            label: 'Messenger DM',
            available: Boolean(messengerConnected && hasMessengerProfile),
            connected: messengerConnected,
            value: profileByPlatform.get('messenger')?.profile_name || profileByPlatform.get('messenger')?.username || '',
            reason: !hasMessengerProfile
                ? 'El contacto no tiene Messenger enlazado'
                : !messengerConnected
                  ? 'Activa Messenger en Configuración > Meta Ads > Redes sociales'
                  : ''
          },
          instagram: {
            key: 'instagram',
            label: 'Instagram DM',
            available: Boolean(instagramConnected && hasInstagramProfile),
            connected: instagramConnected,
            value: profileByPlatform.get('instagram')?.profile_name || profileByPlatform.get('instagram')?.username || '',
            reason: !hasInstagramProfile
              ? 'El contacto no tiene Instagram enlazado'
              : !instagramConnected
                ? 'Activa Instagram en Configuración > Meta Ads > Redes sociales'
                : ''
          },
          email: {
            key: 'email',
            label: 'Correo electrónico',
            available: Boolean(emailStatus.connected && email),
            connected: Boolean(emailStatus.connected),
            value: email,
            reason: !email
              ? 'El contacto no tiene correo'
              : !emailStatus.connected
                ? 'El correo no está conectado'
                : ''
          }
        }
      }
    })
  } catch (error) {
    logger.error(`Error obteniendo canales de cobro para contacto: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'No se pudieron leer los canales del contacto'
    })
  }
}

/**
 * Crea un contacto local directamente en la base de datos
 */
export const createContact = async (req, res) => {
  try {
    const {
      name,
      full_name,
      first_name,
      last_name,
      email,
      phone,
      source,
      createdAt
    } = req.body || {}

    const contactNameFields = normalizeContactNameFields({
      fullName: full_name,
      name,
      firstName: first_name,
      lastName: last_name
    })
    const fullName = contactNameFields.fullName
    const normalizedEmail = cleanString(email).toLowerCase() || null
    const normalizedPhone = phone ? await normalizePhoneForAccount(phone) : null

    if (!fullName && !normalizedEmail && !normalizedPhone) {
      return res.status(400).json({
        success: false,
        error: 'Agrega al menos nombre, correo o teléfono para crear el contacto'
      })
    }

    if (normalizedEmail) {
      const existingByEmail = await db.get(
        'SELECT id, full_name FROM contacts WHERE LOWER(email) = ? LIMIT 1',
        [normalizedEmail]
      )

      if (existingByEmail) {
        return res.status(409).json({
          success: false,
          error: 'Ya existe un contacto con ese correo. Búscalo en la lista y edítalo si necesitas cambiar algo.'
        })
      }
    }

    if (normalizedPhone) {
      const existingByPhone = await findContactByPhoneCandidates(normalizedPhone)
      if (existingByPhone) {
        return res.status(409).json({
          success: false,
          error: 'Ya existe un contacto con ese teléfono. Búscalo en la lista y edítalo si necesitas cambiar algo.'
        })
      }
    }

    const id = createManualContactId()
    const nameParts = fullName ? splitName(fullName) : contactNameFields
    const createdAtTimestamp = parseSortableTimestamp(createdAt)
    const createdAtValue = createdAt && createdAtTimestamp > 0
      ? new Date(createdAtTimestamp).toISOString()
      : new Date().toISOString()
    const sourceValue = cleanString(source) || 'ristak_manual'

    await db.run(
      `INSERT INTO contacts (
        id, phone, email, full_name, first_name, last_name, source, custom_fields, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ${process.env.DATABASE_URL ? '?::jsonb' : '?'}, ?, CURRENT_TIMESTAMP)`,
      [
        id,
        normalizedPhone,
        normalizedEmail,
        fullName || normalizedEmail || normalizedPhone || 'Contacto manual',
        nameParts.firstName || null,
        nameParts.lastName || null,
        sourceValue,
        serializeContactCustomFieldsForDb([]),
        createdAtValue
      ]
    )

    const contact = await db.get('SELECT * FROM contacts WHERE id = ?', [id])
    if (normalizedPhone) {
      await recordContactPhoneNumber({
        contactId: id,
        phone: normalizedPhone,
        label: 'Principal',
        isPrimary: true,
        source: 'manual'
      }).catch(error => {
        logger.warn(`No se pudo registrar teléfono principal para ${id}: ${error.message}`)
      })
    }
    const [contactWithPhones] = await attachContactPhoneNumbers([contact])

    logger.info(`Contacto manual creado: ${id} (${contact.full_name || contact.email || contact.phone || 'sin nombre'})`)

    import('../services/automationEngine.js')
      .then(engine => engine.handleAutomationEvent('contact-created', { contactId: id }))
      .catch(() => {})

    res.status(201).json({
      success: true,
      data: mapContactRowForResponse(contactWithPhones || contact)
    })
  } catch (error) {
    logger.error(`Error creando contacto: ${error.message}`)
    // CNT-012: el pre-check (SELECT) y el INSERT no son atómicos; bajo concurrencia
    // (webhooks + UI) la UNIQUE de la DB es el verdadero candado. Aquí mapeamos esa
    // violación de UNIQUE a un 409 con el mensaje específico del campo en conflicto
    // (correo vs teléfono) en lugar de un genérico, para que el usuario sepa qué editar.
    const message = error.message || ''
    const isUniqueError = /unique|duplicate/i.test(message)
    let conflictError = 'Ya existe un contacto con ese correo o teléfono.'
    if (isUniqueError) {
      const mentionsEmail = /email/i.test(message)
      const mentionsPhone = /phone/i.test(message)
      if (mentionsEmail && !mentionsPhone) {
        conflictError = 'Ya existe un contacto con ese correo. Búscalo en la lista y edítalo si necesitas cambiar algo.'
      } else if (mentionsPhone && !mentionsEmail) {
        conflictError = 'Ya existe un contacto con ese teléfono. Búscalo en la lista y edítalo si necesitas cambiar algo.'
      }
    }
    res.status(isUniqueError ? 409 : 500).json({
      success: false,
      error: isUniqueError
        ? conflictError
        : 'Error creando contacto'
    })
  }
}

/**
 * Obtiene estadísticas de contactos
 */
export const getContactStats = async (req, res) => {
  try {
    const { startDate, endDate, search = '', filter = 'all' } = req.query
    const advancedFilterConfig = normalizeContactAdvancedFilters(req.query.advancedFilters || req.query.conditions)
    if (!(await assertContactAdvancedFilterFeatureAccess(res, advancedFilterConfig))) return

    const { range, metrics } = await buildContactStats({
      startDate,
      endDate,
      search,
      filter: normalizeContactListQuickFilter(filter),
      trackingFilters: normalizeContactListTrackingFilters(req.query.trackingFilters || req.query.filters),
      advancedFilters: advancedFilterConfig
    })

    const rangeLabel = range.isFiltered
      ? `${range.startUtc || '---'} -> ${range.endUtc || '---'} (${range.appliedTimezone})`
      : 'todos'

    logger.info(`Obteniendo estadísticas de contactos - rango: ${rangeLabel}`)

    res.json({
      success: true,
      data: metrics
    })

    logger.debug(
      `Stats contactos (${rangeLabel}) -> total: ${metrics.total}, clientes: ${metrics.customers}`
    )

  } catch (error) {
    logger.error(`Error obteniendo estadísticas de contactos: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo estadísticas'
    })
  }
}

/**
 * Actualiza las estadísticas de todos los contactos (total_paid, purchases_count, last_purchase_date)
 */
// CNT-010: `updateContactsStats()` hace un UPDATE full-table con subconsultas y es
// caro en memoria (riesgo de OOM en el proceso de 512MB). El endpoint /sync-stats lo
// dispara a demanda, así que ráfagas o doble-click podían encadenar varias pasadas
// full-table simultáneas. Coalescemos en una sola ejecución en curso por proceso:
// las peticiones concurrentes esperan/reusan el mismo resultado en vez de lanzar más.
let inFlightStatsSync = null

export const syncContactsStats = async (req, res) => {
  try {
    if (!inFlightStatsSync) {
      inFlightStatsSync = updateContactsStats().finally(() => {
        inFlightStatsSync = null
      })
    }
    const stats = await inFlightStatsSync

    res.json({
      success: true,
      message: 'Estadísticas actualizadas correctamente',
      data: stats
    })
  } catch (error) {
    logger.error(`Error sincronizando estadísticas: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error sincronizando estadísticas'
    })
  }
}

/**
 * Historial de cambios de número de WhatsApp de un contacto (manuales y de contingencia)
 */
export const getContactWhatsAppRoutingEvents = async (req, res) => {
  try {
    const { id } = req.params
    const events = await db.all(`
      SELECT
        e.id,
        e.contact_id,
        e.previous_phone_number_id,
        e.new_phone_number_id,
        e.reason,
        e.source,
        e.created_at,
        prev.display_phone_number AS previous_phone_display,
        prev.phone_number AS previous_phone,
        next.display_phone_number AS new_phone_display,
        next.phone_number AS new_phone
      FROM whatsapp_routing_events e
      LEFT JOIN whatsapp_api_phone_numbers prev ON prev.id = e.previous_phone_number_id
      LEFT JOIN whatsapp_api_phone_numbers next ON next.id = e.new_phone_number_id
      WHERE e.contact_id = ?
      ORDER BY e.created_at DESC
    `, [id])

    res.json({ success: true, data: events })
  } catch (error) {
    logger.error(`Error obteniendo cambios de número del contacto: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo los cambios de número del contacto'
    })
  }
}

/**
 * Actualiza un contacto
 */
export const updateContact = async (req, res) => {
  try {
    const { id } = req.params
    const {
      full_name,
      email,
      phone,
      source,
      attribution_ad_name,
      attribution_ad_id,
      tags,
      customFields,
      dnd,
      dndSettings,
      confirmMerge
    } = req.body
    // (CNT-001) Bandera explícita para autorizar la fusión destructiva al editar
    // teléfono/email. Sin ella NO se fusiona en silencio.
    const mergeConfirmed = confirmMerge === true || confirmMerge === 'true'
    const hasPreferredWhatsAppPhoneNumberUpdate = hasOwn(req.body, 'preferredWhatsAppPhoneNumberId') ||
      hasOwn(req.body, 'preferred_whatsapp_phone_number_id')
    const preferredWhatsAppPhoneNumberInput = hasOwn(req.body, 'preferredWhatsAppPhoneNumberId')
      ? req.body.preferredWhatsAppPhoneNumberId
      : req.body.preferred_whatsapp_phone_number_id

    // Verificar que el contacto existe
    const existing = await db.get('SELECT id, custom_fields, preferred_whatsapp_phone_number_id, tags, full_name, email, phone, source FROM contacts WHERE id = ?', [id])
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'Contacto no encontrado'
      })
    }

    // Etiquetas: el frontend manda IDs del catálogo; se aceptan también
    // nombres (configs viejas) y se resuelven/crean en el catálogo.
    const normalizedTags = Array.isArray(tags)
      ? await resolveTagIds(tags, { createMissing: true })
      : undefined

    const hasCustomFieldsUpdate = customFields !== undefined
    if (hasCustomFieldsUpdate && !Array.isArray(customFields)) {
      return res.status(400).json({
        success: false,
        error: 'customFields debe ser un arreglo'
      })
    }

    const preparedCustomFields = hasCustomFieldsUpdate
      ? await prepareContactCustomFieldsForStorage(customFields, {
        sourceType: 'manual',
        ownerUserId: req.user?.userId
      })
      : null
    const highLevelCustomFields = hasCustomFieldsUpdate
      ? buildHighLevelCustomFieldsPayload(preparedCustomFields)
      : null
    const shouldSyncHighLevelCustomFields = Array.isArray(highLevelCustomFields) && highLevelCustomFields.length > 0
    const normalizedFullName = full_name !== undefined ? formatContactName(full_name) : undefined
    const normalizedPhone = phone !== undefined
      ? (await normalizePhoneForAccount(phone) || phone || null)
      : undefined

    // (CNT-001) NO fusionar+borrar en silencio al editar teléfono/email.
    // Si el dato nuevo ya pertenece a OTRO contacto, devolver 409 con
    // 'merge_confirmation_required' e info del contacto en conflicto, salvo que
    // venga confirmMerge=true. (El diálogo de confirmación lo hace el frontend.)
    if (!mergeConfirmed) {
      // Conflicto por teléfono
      if (phone !== undefined && normalizedPhone) {
        const phoneCanonical = normalizePhoneForStorage(normalizedPhone)
        if (phoneCanonical) {
          const phoneConflict = await findContactByPhoneCandidates(phoneCanonical, { excludeId: id })
          if (phoneConflict?.id) {
            return res.status(409).json({
              success: false,
              code: 'merge_confirmation_required',
              error: 'El teléfono ya pertenece a otro contacto. Confirma la fusión para continuar.',
              conflict: {
                field: 'phone',
                contact: {
                  id: phoneConflict.id,
                  full_name: phoneConflict.full_name || null,
                  phone: phoneConflict.phone || null
                }
              }
            })
          }
        }
      }

      // Conflicto por email
      if (email !== undefined && cleanString(email)) {
        const emailConflict = await db.get(
          "SELECT id, full_name, email, phone FROM contacts WHERE email IS NOT NULL AND email != '' AND LOWER(email) = LOWER(?) AND id != ? LIMIT 1",
          [cleanString(email), id]
        )
        if (emailConflict?.id) {
          return res.status(409).json({
            success: false,
            code: 'merge_confirmation_required',
            error: 'El email ya pertenece a otro contacto. Confirma la fusión para continuar.',
            conflict: {
              field: 'email',
              contact: {
                id: emailConflict.id,
                full_name: emailConflict.full_name || null,
                email: emailConflict.email || null,
                phone: emailConflict.phone || null
              }
            }
          })
        }
      }
    }

    const phoneUpsert = phone !== undefined
      ? await prepareContactPhoneUpsert({ contactId: id, phone: normalizedPhone })
      : null

    // Construir query de actualización solo con campos permitidos
    const updates = []
    const params = []

    if (full_name !== undefined) {
      const nameParts = splitName(normalizedFullName)
      updates.push('full_name = ?')
      params.push(normalizedFullName)
      updates.push('first_name = ?')
      params.push(nameParts.firstName || null)
      updates.push('last_name = ?')
      params.push(nameParts.lastName || null)
    }
    if (email !== undefined) {
      updates.push('email = ?')
      params.push(email)
    }
    if (phone !== undefined) {
      updates.push('phone = ?')
      params.push(phoneUpsert?.phone || null)
    }
    if (source !== undefined) {
      updates.push('source = ?')
      params.push(source)
    }
    if (attribution_ad_name !== undefined) {
      updates.push('attribution_ad_name = ?')
      params.push(attribution_ad_name)
    }
    if (attribution_ad_id !== undefined) {
      updates.push('attribution_ad_id = ?')
      params.push(attribution_ad_id)
    }
    if (hasPreferredWhatsAppPhoneNumberUpdate) {
      const preferredWhatsAppPhoneNumberId = cleanString(preferredWhatsAppPhoneNumberInput)
      if (preferredWhatsAppPhoneNumberId) {
        const phoneNumber = await db.get(
          'SELECT id FROM whatsapp_api_phone_numbers WHERE id = ?',
          [preferredWhatsAppPhoneNumberId]
        )

        if (!phoneNumber) {
          return res.status(400).json({
            success: false,
            error: 'Ese número de WhatsApp no está conectado'
          })
        }
      }

      updates.push('preferred_whatsapp_phone_number_id = ?')
      params.push(preferredWhatsAppPhoneNumberId || null)
    }

    if (updates.length === 0 && tags === undefined && !hasCustomFieldsUpdate && dnd === undefined && !hasPreferredWhatsAppPhoneNumberUpdate) {
      return res.status(400).json({
        success: false,
        error: 'No hay campos para actualizar'
      })
    }

    // Actualizar en HighLevel usando el ID ligado en ghl_contact_id
    // (los contactos solo-locales sin vínculo no se mandan a GHL)
    let mergedCustomFields = null
    try {
      const ghlContactId = await getGhlContactIdForLocalContact(id)
      const ghlClient = ghlContactId ? await getGHLClient() : null
      const ghlUpdateData = {}

      if (normalizedFullName) ghlUpdateData.name = normalizedFullName
      if (email) ghlUpdateData.email = email
      if (phone) ghlUpdateData.phone = phoneUpsert?.phone || normalizedPhone
      if (source) ghlUpdateData.source = source
      // A HighLevel se le mandan los nombres legibles, no los IDs internos
      if (normalizedTags !== undefined) ghlUpdateData.tags = await tagNamesForIds(normalizedTags)
      if (shouldSyncHighLevelCustomFields) ghlUpdateData.customFields = highLevelCustomFields
      if (dnd !== undefined) {
        ghlUpdateData.dnd = dnd
        if (dndSettings) ghlUpdateData.dndSettings = dndSettings
      }

      if (ghlContactId && ghlClient && Object.keys(ghlUpdateData).length > 0) {
        await ghlClient.updateContact(ghlContactId, ghlUpdateData)
        logger.info(`Contacto actualizado en HighLevel: ${id} (GHL ${ghlContactId})`)
      }
    } catch (error) {
      // (CNT-008) Antes se hacía `return 502` cuando fallaba la sync de custom
      // fields a HighLevel, ANTES de persistir nada local: con GHL caído/token
      // expirado el usuario no podía guardar. Ahora NO bloqueamos el guardado
      // local; solo avisamos en el log y continuamos para no perder datos.
      if (shouldSyncHighLevelCustomFields) {
        logger.warn(`No se pudieron sincronizar custom fields con HighLevel para ${id} (se guarda local de todos modos): ${error.message}`)
      } else {
        logger.warn(`No se pudo actualizar el contacto en HighLevel: ${error.message}`)
      }
      // Continuar con la actualización local aunque falle en GHL
    }

    if (hasCustomFieldsUpdate) {
      mergedCustomFields = mergeContactCustomFields(
        parseContactCustomFields(existing.custom_fields),
        preparedCustomFields
      )
      updates.push(`custom_fields = ${process.env.DATABASE_URL ? '?::jsonb' : '?'}`)
      params.push(serializeContactCustomFieldsForDb(mergedCustomFields))
    }

    // Etiquetas locales: persistir IDs y detectar añadidas/eliminadas
    let tagEvents = []
    if (normalizedTags !== undefined) {
      const previousTags = parseContactTags(existing.tags)
      const prevSet = new Set(previousTags)
      const nextSet = new Set(normalizedTags)
      const changedIds = [
        ...normalizedTags.filter(t => !prevSet.has(t)).map(tagId => ({ tagId, tagAction: 'added' })),
        ...previousTags.filter(t => !nextSet.has(t)).map(tagId => ({ tagId, tagAction: 'removed' }))
      ]
      if (changedIds.length > 0) {
        const allTags = await listContactTags()
        const nameById = new Map(allTags.map(tag => [tag.id, tag.name]))
        tagEvents = changedIds.map(event => ({
          ...event,
          tag: nameById.get(event.tagId) || event.tagId
        }))
      }
      updates.push('tags = ?')
      params.push(JSON.stringify(normalizedTags))
    }

    // Actualizar en la base de datos local
    if (updates.length > 0) {
      // Agregar updated_at
      updates.push('updated_at = CURRENT_TIMESTAMP')
      params.push(id)

      const query = `UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`
      await db.run(query, params)
    }

    if (phone !== undefined) {
      if (phoneUpsert?.phone) {
        await recordContactPhoneNumber({
          contactId: id,
          phone: phoneUpsert.phone,
          label: 'Principal',
          isPrimary: true,
          source: 'manual'
        }).catch(error => {
          logger.warn(`No se pudo registrar teléfono principal para ${id}: ${error.message}`)
        })
      } else if (existing.phone) {
        await db.run(
          'UPDATE contact_phone_numbers SET is_primary = 0, updated_at = CURRENT_TIMESTAMP WHERE contact_id = ? AND phone = ?',
          [id, existing.phone]
        ).catch(() => {})
      }
    }

    // Dejar rastro cuando la conversación se mueve manualmente a otro número
    if (hasPreferredWhatsAppPhoneNumberUpdate) {
      const previousPreferredId = cleanString(existing.preferred_whatsapp_phone_number_id)
      const newPreferredId = cleanString(preferredWhatsAppPhoneNumberInput)
      if (previousPreferredId !== newPreferredId) {
        const routingReason = cleanString(req.body.routingReason || req.body.preferredWhatsAppPhoneNumberReason)
        // 'contingency' = movido porque su número no estaba disponible (elegible para
        // restauración automática); 'manual' = decisión deliberada del usuario.
        const routingSource = cleanString(req.body.routingSource) === 'contingency' ? 'contingency' : 'manual'
        await db.run(`
          INSERT INTO whatsapp_routing_events (id, contact_id, previous_phone_number_id, new_phone_number_id, reason, source)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [
          randomUUID(),
          id,
          previousPreferredId || null,
          newPreferredId || null,
          routingReason || 'Cambio manual de número preferido',
          routingSource
        ]).catch(error => {
          logger.warn(`No se pudo registrar el cambio de número de ${id}: ${error.message}`)
        })
      }
    }

    // Motor de automatizaciones: campo cambiado y etiquetas
    {
      const changedFields = []
      if (full_name !== undefined && full_name !== existing.full_name) changedFields.push('name', 'fullName')
      if (email !== undefined && email !== existing.email) changedFields.push('email')
      if (phone !== undefined && phone !== existing.phone) changedFields.push('phone')
      if (source !== undefined && source !== existing.source) changedFields.push('source')
      if (attribution_ad_name !== undefined) changedFields.push('attributionAd')
      if (attribution_ad_id !== undefined) changedFields.push('attributionAd')
      if (hasPreferredWhatsAppPhoneNumberUpdate && cleanString(existing.preferred_whatsapp_phone_number_id) !== cleanString(preferredWhatsAppPhoneNumberInput)) {
        changedFields.push('preferredWhatsAppPhoneNumberId', 'preferred_whatsapp_phone_number_id')
      }
      if (Array.isArray(customFields)) customFields.forEach(field => {
        if (field?.key) changedFields.push(field.key, `custom:${field.key}`)
      })
      import('../services/automationEngine.js').then(engine => {
        if (changedFields.length > 0) {
          engine.handleAutomationEvent('contact-updated', { contactId: id, changedFields, contactChangeSource: 'manual' }).catch(() => {})
        }
        tagEvents.forEach(event => {
          engine.handleAutomationEvent('tag-changed', { contactId: id, ...event }).catch(() => {})
        })
      }).catch(() => {})
    }

    // Obtener el contacto actualizado
    const updated = await db.get(
      `SELECT * FROM contacts WHERE id = ?`,
      [id]
    )
    const [updatedWithPhones] = await attachContactPhoneNumbers([updated])
    const responseContact = updatedWithPhones || updated
    const phones = buildContactPhonesForResponse(responseContact)
    const updatedData = {
      ...responseContact,
      preferredWhatsAppPhoneNumberId: responseContact.preferred_whatsapp_phone_number_id || '',
      phones,
      phoneNumbers: phones,
      customFields: parseContactCustomFields(responseContact.custom_fields),
      tags: parseContactTags(responseContact.tags)
    }

    logger.info(`Contacto actualizado: ${id}`)

    res.json({
      success: true,
      data: updatedData
    })

  } catch (error) {
    // (CNT-004) Email duplicado al editar caía a un 500 genérico opaco por el
    // constraint UNIQUE. Lo mapeamos a un 409 claro y accionable (consistente
    // con la pre-validación de email/teléfono de más arriba), para que el
    // usuario sepa que el email ya pertenece a otro contacto.
    const code = String(error?.code || '')
    const message = String(error?.message || '')
    const isUniqueConflict = code === 'SQLITE_CONSTRAINT' ||
      code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      code === '23505' ||
      message.includes('UNIQUE constraint failed') ||
      message.includes('duplicate key value')
    if (isUniqueConflict) {
      logger.warn(`Conflicto de email duplicado actualizando contacto ${req.params.id}: ${error.message}`)
      return res.status(409).json({
        success: false,
        code: 'duplicate_email',
        error: 'El email ya pertenece a otro contacto. Usa uno distinto o confirma la fusión.'
      })
    }

    logger.error(`Error actualizando contacto ${req.params.id}: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error actualizando contacto'
    })
  }
}

/**
 * Aplica etiquetas en bloque a varios contactos (selección múltiple en la
 * tabla de contactos). Body: { contactIds, addTagIds?, removeTagIds? }
 */
export const bulkUpdateContactTags = async (req, res) => {
  try {
    const contactIds = Array.isArray(req.body?.contactIds)
      ? req.body.contactIds.map((value) => String(value || '').trim()).filter(Boolean)
      : []
    if (contactIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Selecciona al menos un contacto' })
    }
    if (contactIds.length > 1000) {
      return res.status(400).json({ success: false, error: 'Máximo 1000 contactos por operación' })
    }

    const addTagIds = await resolveTagIds(req.body?.addTagIds || [], { createMissing: true })
    const removeTagIds = await resolveTagIds(req.body?.removeTagIds || [])
    if (addTagIds.length === 0 && removeTagIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Selecciona al menos una etiqueta' })
    }

    const allTags = await listContactTags()
    const nameById = new Map(allTags.map(tag => [tag.id, tag.name]))
    const removeSet = new Set(removeTagIds)

    const placeholders = contactIds.map(() => '?').join(', ')
    const rows = await db.all(
      `SELECT id, tags FROM contacts WHERE id IN (${placeholders})`,
      contactIds
    )

    let updated = 0
    const tagEvents = []
    for (const row of rows) {
      const current = parseContactTags(row.tags)
      const next = [...new Set([
        ...current.filter((tagId) => !removeSet.has(tagId)),
        ...addTagIds
      ])]

      const currentSet = new Set(current)
      const nextSet = new Set(next)
      const added = next.filter((tagId) => !currentSet.has(tagId))
      const removed = current.filter((tagId) => !nextSet.has(tagId))
      if (added.length === 0 && removed.length === 0) continue

      await db.run('UPDATE contacts SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
        JSON.stringify(next),
        row.id
      ])
      updated += 1
      added.forEach((tagId) => tagEvents.push({ contactId: row.id, tagId, tag: nameById.get(tagId) || tagId, tagAction: 'added' }))
      removed.forEach((tagId) => tagEvents.push({ contactId: row.id, tagId, tag: nameById.get(tagId) || tagId, tagAction: 'removed' }))
    }

    // Los cambios de etiqueta pueden disparar automatizaciones
    if (tagEvents.length > 0) {
      import('../services/automationEngine.js').then(engine => {
        tagEvents.forEach(event => {
          engine.handleAutomationEvent('tag-changed', event).catch(() => {})
        })
      }).catch(() => {})
    }

    logger.info(`Etiquetas en bloque aplicadas: ${updated} contactos actualizados`)
    res.json({ success: true, data: { updated, total: contactIds.length } })
  } catch (error) {
    logger.error(`Error aplicando etiquetas en bloque: ${error.message}`)
    res.status(500).json({ success: false, error: 'No se pudieron aplicar las etiquetas' })
  }
}

/**
 * Actualiza campos personalizados en bloque para contactos seleccionados.
 * Body: { contactIds, customFields }
 */
export const bulkUpdateContactCustomFields = async (req, res) => {
  try {
    const contactIds = Array.isArray(req.body?.contactIds)
      ? req.body.contactIds.map((value) => cleanString(value)).filter(Boolean)
      : []
    if (contactIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Selecciona al menos un contacto' })
    }
    if (contactIds.length > 1000) {
      return res.status(400).json({ success: false, error: 'Máximo 1000 contactos por operación' })
    }

    const customFields = Array.isArray(req.body?.customFields) ? req.body.customFields : []
    if (customFields.length === 0) {
      return res.status(400).json({ success: false, error: 'Selecciona al menos un campo personalizado' })
    }

    const preparedCustomFields = await prepareContactCustomFieldsForStorage(customFields, {
      sourceType: 'manual',
      ownerUserId: req.user?.userId
    })
    if (!preparedCustomFields.length) {
      return res.status(400).json({ success: false, error: 'No se pudo preparar el campo personalizado' })
    }

    const placeholders = contactIds.map(() => '?').join(', ')
    const rows = await db.all(
      `SELECT id, custom_fields FROM contacts WHERE id IN (${placeholders})`,
      contactIds
    )

    const changedFields = [
      ...new Set(preparedCustomFields.flatMap((field) => [
        cleanString(field.key || field.fieldKey),
        cleanString(field.fieldKey),
        cleanString(field.id),
        cleanString(field.definitionId),
        cleanString(field.key || field.fieldKey) ? `custom:${cleanString(field.key || field.fieldKey)}` : ''
      ]).filter(Boolean))
    ]

    let updated = 0
    for (const row of rows) {
      const mergedCustomFields = mergeContactCustomFields(
        parseContactCustomFields(row.custom_fields),
        preparedCustomFields
      )

      await db.run(
        `UPDATE contacts SET custom_fields = ${process.env.DATABASE_URL ? '?::jsonb' : '?'}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [serializeContactCustomFieldsForDb(mergedCustomFields), row.id]
      )
      updated += 1
    }

    if (updated > 0 && changedFields.length > 0) {
      import('../services/automationEngine.js').then(engine => {
        rows.forEach(row => {
          engine.handleAutomationEvent('contact-updated', {
            contactId: row.id,
            changedFields,
            contactChangeSource: 'manual'
          }).catch(() => {})
        })
      }).catch(() => {})
    }

    logger.info(`Campos personalizados en bloque aplicados: ${updated} contactos actualizados`)
    res.json({
      success: true,
      data: {
        updated,
        total: contactIds.length,
        customFields: preparedCustomFields
      }
    })
  } catch (error) {
    logger.error(`Error aplicando campos personalizados en bloque: ${error.message}`)
    const status = error.status || error.statusCode || 500
    res.status(status).json({
      success: false,
      error: status === 500 ? 'No se pudieron aplicar los campos personalizados' : error.message
    })
  }
}

/**
 * Elimina un contacto
 */
export const deleteContact = async (req, res) => {
  try {
    const { id } = req.params

    // Verificar que el contacto existe
    const existing = await db.get('SELECT id, full_name FROM contacts WHERE id = ?', [id])
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'Contacto no encontrado'
      })
    }

    // Eliminar en HighLevel usando el ID ligado en ghl_contact_id
    // (los contactos solo-locales sin vínculo no existen en GHL)
    try {
      const ghlContactId = await getGhlContactIdForLocalContact(id)
      if (ghlContactId) {
        const ghlClient = await getGHLClient()
        await ghlClient.deleteContact(ghlContactId)
        logger.info(`Contacto eliminado de HighLevel: ${id} (GHL ${ghlContactId})`)
      }
    } catch (error) {
      logger.warn(`No se pudo eliminar el contacto de HighLevel: ${error.message}`)
      // Continuar con la eliminación local aunque falle en GHL
    }

    // (CNT-007 / DB-003) Soft-delete: marcar deleted_at en vez de borrar físicamente.
    // Así NO se dispara el ON DELETE CASCADE y se conservan pagos e historial; el
    // contacto queda en la papelera y es recuperable. Se limpia ghl_contact_id para que
    // la sincronización de HighLevel no lo "resucite" emparejándolo por ese id.
    await db.run(
      `UPDATE contacts SET deleted_at = CURRENT_TIMESTAMP, ghl_contact_id = NULL WHERE id = ?`,
      [id]
    )

    logger.info(`Contacto enviado a la papelera (soft-delete): ${id} (${existing.full_name})`)
    await recordAudit({ entityType: 'contact', entityId: id, action: 'soft_delete', actor: req.user, details: { full_name: existing.full_name } })

    res.json({
      success: true,
      message: 'Contacto movido a la papelera. Sus pagos e historial se conservan; puedes restaurarlo.'
    })

  } catch (error) {
    logger.error(`Error eliminando contacto ${req.params.id}: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error eliminando contacto'
    })
  }
}

// (CNT-007) Lista los contactos en la papelera (soft-deleted) para poder restaurarlos.
export const getTrashedContacts = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500)
    const rows = await db.all(
      `SELECT id, full_name, email, phone, source, deleted_at, total_paid, purchases_count
       FROM contacts
       WHERE deleted_at IS NOT NULL
       ORDER BY deleted_at DESC
       LIMIT ?`,
      [limit]
    )
    res.json({ success: true, contacts: rows })
  } catch (error) {
    logger.error(`Error listando papelera de contactos: ${error.message}`)
    res.status(500).json({ success: false, error: 'Error obteniendo la papelera' })
  }
}

// (CNT-007) Restaura un contacto desde la papelera (deja deleted_at en NULL).
export const restoreContact = async (req, res) => {
  try {
    const { id } = req.params
    const existing = await db.get('SELECT id, full_name FROM contacts WHERE id = ? AND deleted_at IS NOT NULL', [id])
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Contacto no encontrado en la papelera' })
    }
    await db.run('UPDATE contacts SET deleted_at = NULL WHERE id = ?', [id])
    logger.info(`Contacto restaurado de la papelera: ${id} (${existing.full_name})`)
    await recordAudit({ entityType: 'contact', entityId: id, action: 'restore', actor: req.user, details: { full_name: existing.full_name } })
    res.json({ success: true, message: 'Contacto restaurado correctamente' })
  } catch (error) {
    logger.error(`Error restaurando contacto ${req.params.id}: ${error.message}`)
    res.status(500).json({ success: false, error: 'Error restaurando contacto' })
  }
}

// (CNT-007 / DB-003) Borra permanentemente un contacto de la papelera, pero CONSERVA sus
// pagos: los desacopla (contact_id = NULL) antes del borrado para no perder historial financiero.
export const permanentDeleteContact = async (req, res) => {
  try {
    const { id } = req.params
    const existing = await db.get('SELECT id, full_name FROM contacts WHERE id = ? AND deleted_at IS NOT NULL', [id])
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Contacto no encontrado en la papelera' })
    }
    // (DB-003) Conservar los pagos: desacoplarlos del contacto antes de borrarlo (contact_id es nullable).
    await db.run('UPDATE payments SET contact_id = NULL WHERE contact_id = ?', [id])
    await db.run('DELETE FROM chat_inbound_message_claims WHERE contact_id = ?', [id])
    await db.run('DELETE FROM contacts WHERE id = ?', [id])
    logger.info(`Contacto borrado permanentemente (pagos conservados): ${id} (${existing.full_name})`)
    await recordAudit({ entityType: 'contact', entityId: id, action: 'permanent_delete', actor: req.user, details: { full_name: existing.full_name } })
    res.json({ success: true, message: 'Contacto borrado permanentemente. Sus pagos se conservaron en el historial.' })
  } catch (error) {
    logger.error(`Error borrando permanentemente contacto ${req.params.id}: ${error.message}`)
    res.status(500).json({ success: false, error: 'Error borrando el contacto' })
  }
}

export const createBulkWhatsAppTemplateAction = async (req, res) => {
  try {
    const data = await createWhatsAppTemplateBulkAction({
      ...(req.body || {}),
      userId: req.user?.userId || req.user?.id || null
    })
    res.status(201).json({ success: true, data })
  } catch (error) {
    logger.error(`Error creando lote WhatsApp de contactos: ${error.message}`)
    res.status(error.status || error.statusCode || 400).json({
      success: false,
      error: error.message || 'No se pudo crear el lote de WhatsApp'
    })
  }
}

export const createBulkAutomationAction = async (req, res) => {
  try {
    const data = await createAutomationBulkAction({
      ...(req.body || {}),
      userId: req.user?.userId || req.user?.id || null
    })
    res.status(201).json({ success: true, data })
  } catch (error) {
    logger.error(`Error creando lote de automatización de contactos: ${error.message}`)
    res.status(error.status || error.statusCode || 400).json({
      success: false,
      error: error.message || 'No se pudo crear el lote de automatización'
    })
  }
}

export const listBulkContactActions = async (req, res) => {
  try {
    const data = await listContactBulkActions({ limit: req.query?.limit })
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error listando acciones masivas de contactos: ${error.message}`)
    res.status(error.status || error.statusCode || 500).json({
      success: false,
      error: error.message || 'No se pudieron cargar las acciones masivas'
    })
  }
}

export const getBulkContactAction = async (req, res) => {
  try {
    const data = await getContactBulkAction(req.params.actionId)
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error cargando acción masiva de contactos: ${error.message}`)
    res.status(error.status || error.statusCode || 404).json({
      success: false,
      error: error.message || 'Acción masiva no encontrada'
    })
  }
}

export const pauseBulkContactAction = async (req, res) => {
  try {
    const data = await pauseContactBulkAction(req.params.actionId)
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error deteniendo acción masiva de contactos: ${error.message}`)
    res.status(error.status || error.statusCode || 400).json({
      success: false,
      error: error.message || 'No se pudo detener la acción masiva'
    })
  }
}

export const resumeBulkContactAction = async (req, res) => {
  try {
    const data = await resumeContactBulkAction(req.params.actionId)
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error reanudando acción masiva de contactos: ${error.message}`)
    res.status(error.status || error.statusCode || 400).json({
      success: false,
      error: error.message || 'No se pudo reanudar la acción masiva'
    })
  }
}

export const rescheduleBulkContactAction = async (req, res) => {
  try {
    const data = await rescheduleContactBulkAction(req.params.actionId, req.body || {})
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error reprogramando acción masiva de contactos: ${error.message}`)
    res.status(error.status || error.statusCode || 400).json({
      success: false,
      error: error.message || 'No se pudo reprogramar la acción masiva'
    })
  }
}

export const cancelBulkContactAction = async (req, res) => {
  try {
    const data = await cancelContactBulkAction(req.params.actionId)
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error cancelando acción masiva de contactos: ${error.message}`)
    res.status(error.status || error.statusCode || 400).json({
      success: false,
      error: error.message || 'No se pudo cancelar la acción masiva'
    })
  }
}

export const deleteBulkContactAction = async (req, res) => {
  try {
    const data = await deleteContactBulkAction(req.params.actionId)
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error eliminando acción masiva de contactos: ${error.message}`)
    res.status(error.status || error.statusCode || 400).json({
      success: false,
      error: error.message || 'No se pudo eliminar la acción masiva'
    })
  }
}

/**
 * Obtiene datos de registros agrupados por fecha para gráfico
 */
export const getContactsChart = async (req, res) => {
  try {
    const { startDate, endDate } = req.query

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
    const rangeLabel = range.isFiltered
      ? `${range.startUtc || '---'} -> ${range.endUtc || '---'}`
      : 'todos'

    logger.info(`Obteniendo datos de gráfico de registros - rango: ${rangeLabel}`)

    // Aplicar filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters()
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false)

    // Construir WHERE clause
    const conditions = []
    const params = []

    if (range.startUtc) {
      conditions.push('created_at >= ?')
      params.push(range.startUtc)
    }

    if (range.endUtc) {
      conditions.push('created_at <= ?')
      params.push(range.endUtc)
    }

    if (hiddenCondition) {
      conditions.push(hiddenCondition)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // Query para obtener registros por fecha
    const query = `
      SELECT
        DATE(created_at) as date,
        COUNT(*) as count
      FROM contacts
      ${whereClause}
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `

    const data = await db.all(query, params)

    logger.debug(`Datos de gráfico obtenidos: ${data.length} días con registros`)

    res.json({
      success: true,
      data
    })

  } catch (error) {
    logger.error(`Error obteniendo datos de gráfico de registros: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo datos de gráfico'
    })
  }
}

/**
 * Obtiene el journey completo del contacto (timeline de eventos)
 * Orden de eventos:
 * 1. Primer toque (sessions o whatsapp_attribution, el más antiguo)
 * 2. Se convirtió en contacto (created_at)
 * 3. Primera cita (appointments, date_added)
 * 4. Primera compra (payments, date)
 */
export const getContactJourney = async (req, res) => {
  try {
    const { id } = req.params
    const includeBusinessMessages = String(req.query?.includeBusinessMessages || '').toLowerCase() === 'true'
    const refreshExternalStatuses = String(req.query?.refreshExternalStatuses ?? 'true').toLowerCase() !== 'false'
    const chatMessagesOnly = isTruthyQueryValue(
      req.query?.chatMessagesOnly ?? req.query?.chatOnly ?? req.query?.messagesOnly
    )
    const journeyMessageLimit = parseJourneyMessageLimit(
      req.query?.messageLimit ?? req.query?.messagesLimit ?? req.query?.conversationMessageLimit
    )
    const journeyMessageBefore = parseJourneyMessageBefore(
      req.query?.beforeMessageDate ?? req.query?.messageBeforeDate ?? req.query?.beforeMessage
    )
    const journeyMessageBeforeCursor = journeyMessageBefore
      ? parseJourneyMessageCursor(
        req.query?.beforeMessageCursor ?? req.query?.messageBeforeCursor ?? req.query?.beforeCursor
      )
      : null
    const outboundMessageDirectionPlaceholders = OUTBOUND_JOURNEY_MESSAGE_DIRECTIONS.map(() => '?').join(', ')

    // (SEC-005 / ACL-002) No exponer el journey de un contacto oculto: si cae bajo un
    // filtro de ocultos, tratarlo como inexistente (404).
    const hiddenFilters = await getHiddenContactFilters()
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false)

    // Verificar que el contacto existe y obtener info de atribución completa
    const contact = await db.get(`
      SELECT
        contacts.*,
        meta_ads.campaign_name,
        meta_ads.campaign_id,
        meta_ads.adset_name,
        meta_ads.adset_id,
        meta_ads.ad_name as meta_ad_name
      FROM contacts
      LEFT JOIN meta_ads ON meta_ads.ad_id = contacts.attribution_ad_id
      WHERE contacts.id = ?${hiddenCondition ? ` AND ${hiddenCondition}` : ''}
      ORDER BY ${timestampSortExpression('meta_ads.date')} DESC
      LIMIT 1
    `, [id])
    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contacto no encontrado'
      })
    }
    const contactPhoneValues = await getContactPhoneValues(id, contact.phone)
    const contactPhoneCandidates = contactPhoneValues.length
      ? contactPhoneValues
      : buildContactPhoneCandidates(contact.phone)
    const whatsappApiMessageContactMatch = buildWhatsAppApiMessageContactMatch(id, contactPhoneCandidates)

    // (Social enlazado) La misma persona puede vivir como DOS contactos separados
    // (DM y comentario) enlazados por (platform, meta_user_id). Para que el chat
    // muestre TODO el historial de esa persona (mensajes privados + comentarios)
    // sin cambiar de filtro, juntamos los ids de los contactos enlazados y
    // consultamos meta_social_messages para todos ellos. Falla-seguro: si algo
    // truena, se queda solo con [id] (comportamiento anterior).
    let metaPersonContactIds = [id]
    try {
      const ownSocialRows = await db.all(
        `SELECT platform, meta_user_id
           FROM meta_social_contacts
          WHERE contact_id = ? AND COALESCE(meta_user_id, '') <> ''`,
        [id]
      )
      const linkedContactIds = new Set()
      for (const row of ownSocialRows) {
        const linkedRows = await db.all(
          `SELECT DISTINCT contact_id
             FROM meta_social_contacts
            WHERE platform = ? AND meta_user_id = ?
              AND contact_id IS NOT NULL AND contact_id <> ?`,
          [row.platform, row.meta_user_id, id]
        )
        for (const linked of linkedRows) {
          if (linked.contact_id) linkedContactIds.add(String(linked.contact_id))
        }
      }
      if (linkedContactIds.size > 0) {
        metaPersonContactIds = [id, ...linkedContactIds]
      }
    } catch (linkErr) {
      logger.warn(`No se pudieron resolver contactos sociales enlazados para ${id}: ${linkErr.message}`)
      metaPersonContactIds = [id]
    }
    const metaContactIdPlaceholders = metaPersonContactIds.map(() => '?').join(', ')

    const journey = []
    if (refreshExternalStatuses) {
      await refreshHighLevelConversationMessageStatuses(id)
    }

    const successfulPaymentsCondition = `
      contact_id = ?
      AND amount > 0
      AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
      AND ${nonTestPaymentCondition()}
    `
    const firstPayment = await db.get(
      `SELECT date FROM payments
       WHERE ${successfulPaymentsCondition}
       ORDER BY ${timestampSortExpression('date')} ASC, ${timestampSortExpression('created_at')} ASC, id ASC
       LIMIT 1`,
      [id]
    )
    const rawFirstPaymentTime = firstPayment?.date ? parseSortableTimestamp(firstPayment.date) : null
    const firstPaymentTime = Number.isFinite(rawFirstPaymentTime) ? rawFirstPaymentTime : null

    const getDateTime = (value) => {
      return parseSortableTimestamp(value)
    }

    const detectWhatsAppAdPlatform = (data = {}) => normalizeWhatsAppAttributionPlatform(data)

    // El journey default sólo representa acciones del contacto. La conversación usa
    // getContactConversation para incluir mensajes del negocio sin contaminar los
    // timelines de atribución con mensajes salientes.
    const isStoredChatMessageEvent = (event) => Boolean(
	      event?.data?.whatsapp_api_message_id ||
	      event?.data?.whatsapp_message_id ||
	      event?.data?.email_message_id ||
	      event?.data?.message_type ||
	      event?.data?.direction ||
	      event?.data?.transport
    )

    const addWhatsAppJourneyEvents = (events) => {
      events
        .filter(event => event?.date)
        .filter(event => includeBusinessMessages || !isOutboundWhatsAppDirection(event?.data?.direction))
        .sort((a, b) => getDateTime(a.date) - getDateTime(b.date))
        .forEach(event => {
          const eventTime = getDateTime(event.date)
          const isAfterFirstPayment = firstPaymentTime !== null && eventTime >= firstPaymentTime

          if (isAfterFirstPayment && !event.data?.is_ad_attributed && !isStoredChatMessageEvent(event)) {
            return
          }

          journey.push(event)
        })
    }

    // 1. TODAS las visitas/sessions (por contact_id, visitor_id o email)
    let sessions = []

    if (!chatMessagesOnly) {
      const contactVisitorId = cleanString(contact.visitor_id)
      if (isTrustedTrackingVisitorId(contactVisitorId)) {
        sessions = await db.all(
          `SELECT * FROM sessions
           WHERE contact_id = ? OR visitor_id = ?
           ORDER BY started_at ASC`,
          [id, contactVisitorId]
        )
      } else {
        if (contactVisitorId) {
          logger.warn(`Journey ignoró visitor_id no confiable para contacto ${id}: ${contactVisitorId}`)
        }
        sessions = await db.all(
          `SELECT * FROM sessions
           WHERE contact_id = ?
           ORDER BY started_at ASC`,
          [id]
        )
      }

      // Fallback por email si no encontró sesiones
      if (sessions.length === 0 && contact.email) {
        sessions = await db.all(
          `SELECT * FROM sessions WHERE email = ? ORDER BY started_at ASC`,
          [contact.email]
        )
        if (sessions.length > 0) {
          logger.info(`📍 ${sessions.length} sessions encontradas por email para contacto ${id}`)
        }
      }

      const videoEngagements = await loadContactVideoEngagements(contact)
      const sessionSummaries = summarizeJourneySessionRows(sessions)
      const sessionJourneyEntries = sessionSummaries.map(session => ({
        session,
        event: buildPageVisitJourneyEvent(session, { contactCreatedAt: contact.created_at })
      }))
      const attachedVideoKeys = attachVideoEngagementsToPageVisits(sessionJourneyEntries, videoEngagements)

      // Agregar todas las visitas al journey, enriquecidas con video si el tracking
      // detectó reproducción en la misma sesión/página.
      sessionJourneyEntries.forEach(({ event }) => {
        journey.push(event)
      })

      // Si el video se enlazó al contacto pero no hay visita exacta para colgarlo,
      // no se pierde: queda como evento propio de video dentro del viaje.
      videoEngagements.forEach(video => {
        const key = getVideoEngagementKey(video)
        if (key && attachedVideoKeys.has(key)) return

        journey.push({
          type: 'video_playback',
          date: video.first_event_at || video.last_event_at || contact.created_at,
          data: {
            ...video,
            standalone: true
          }
        })
      })
    }

    // 2. Movimientos de WhatsApp del cliente: diario antes del pago, atribuidos despues.
    const whatsappJourneyEvents = []
    const whatsappMessages = await db.all(
      `SELECT *
       FROM (
         SELECT *
         FROM whatsapp_attribution
         WHERE contact_id = ?
         ${journeyMessageBeforeClause(
           'created_at',
           journeyMessageCursorSqlExpression('whatsapp_attribution', 'id'),
           journeyMessageBefore,
           journeyMessageBeforeCursor
         )}
         ORDER BY ${timestampSortExpression('created_at')} DESC,
                  ${journeyMessageCursorSqlExpression('whatsapp_attribution', 'id')} DESC
         ${optionalLimitClause(journeyMessageLimit)}
       ) recent_whatsapp_attribution
       ORDER BY ${timestampSortExpression('created_at')} ASC,
                ${journeyMessageCursorSqlExpression('whatsapp_attribution', 'id')} ASC`,
      appendOptionalLimitParam(
        appendJourneyMessageBeforeParams(
          [id],
          journeyMessageBefore,
          journeyMessageBeforeCursor
        ),
        journeyMessageLimit
      )
    )

    whatsappMessages.forEach(msg => {
      const detectedAttribution = detectWhatsAppAttributionFields({ row: msg }, [msg.message_content])
      const referralSourceId = cleanString(msg.referral_source_id || msg.ad_id_thru_message || detectedAttribution.sourceId)
      const data = {
        source: 'WhatsApp',
        phone: msg.phone,
        message_text: msg.message_content,
        referral_source_url: msg.referral_source_url,
        referral_source_type: msg.referral_source_type || detectedAttribution.sourceType,
        referral_source_id: referralSourceId,
        referral_headline: msg.referral_headline || detectedAttribution.headline,
        referral_body: msg.referral_body || detectedAttribution.body,
        referral_image_url: msg.referral_image_url,
        referral_video_url: msg.referral_video_url,
        referral_thumbnail_url: msg.referral_thumbnail_url,
        referral_ctwa_clid: msg.referral_ctwa_clid || detectedAttribution.ctwaClid,
        attribution_source: 'whatsapp_attribution',
        attribution_record_id: msg.id,
        ad_id_thru_message: msg.ad_id_thru_message || referralSourceId
      }
      const isAdAttributed = hasRealWhatsAppAdAttribution({
        ...data,
        ad_id_thru_message: data.ad_id_thru_message
      })

      whatsappJourneyEvents.push({
        type: 'whatsapp_message',
        date: msg.created_at,
        cursorKey: buildJourneyMessageCursorKey('whatsapp_attribution', msg.id),
        data: {
          ...data,
          is_ad_attributed: isAdAttributed,
          ad_platform: isAdAttributed ? detectWhatsAppAdPlatform(data) : null
        }
      })
    })

    const whatsappApiMessages = await db.all(
      `SELECT *
       FROM (
        SELECT
          msg.id as whatsapp_api_message_id,
          msg.ycloud_message_id,
          msg.wamid,
          msg.message_text,
          msg.message_type,
          msg.message_timestamp,
          msg.created_at,
          msg.phone,
          msg.from_phone,
          msg.to_phone,
          msg.business_phone,
          msg.business_phone_number_id,
          msg.transport,
          msg.routing_reason,
          msg.direction,
          msg.status,
          msg.error_code,
          msg.error_message,
          msg.media_url,
          msg.media_mime_type,
          msg.media_filename,
          msg.media_duration_ms,
          msg.raw_payload_json,
          msg.context_json,
          COALESCE(msg.message_timestamp, msg.created_at) as journey_message_date,
          COALESCE(attr.id, '') as attribution_id,
          COALESCE(attr.detected_ctwa_clid, msg.detected_ctwa_clid) as detected_ctwa_clid,
          COALESCE(attr.detected_source_id, msg.detected_source_id) as detected_source_id,
          COALESCE(attr.detected_source_url, msg.detected_source_url) as detected_source_url,
          COALESCE(attr.detected_source_type, msg.detected_source_type) as detected_source_type,
          COALESCE(attr.detected_source_app, msg.detected_source_app) as detected_source_app,
          COALESCE(attr.detected_entry_point, msg.detected_entry_point) as detected_entry_point,
          COALESCE(attr.detected_headline, msg.detected_headline) as detected_headline,
          COALESCE(attr.detected_body, msg.detected_body) as detected_body,
          COALESCE(attr.detected_conversion_data, msg.detected_conversion_data) as detected_conversion_data,
          COALESCE(attr.detected_ctwa_payload, msg.detected_ctwa_payload) as detected_ctwa_payload
       FROM whatsapp_api_messages msg
       LEFT JOIN whatsapp_api_contacts api_profile ON api_profile.id = msg.whatsapp_api_contact_id
       LEFT JOIN whatsapp_api_attribution attr ON attr.whatsapp_api_message_id = msg.id
       WHERE ${whatsappApiMessageContactMatch.condition}
         AND (
           ? = 1
           OR LOWER(COALESCE(msg.direction, 'inbound')) NOT IN (${outboundMessageDirectionPlaceholders})
         )
         ${journeyMessageBeforeClause(
           'COALESCE(msg.message_timestamp, msg.created_at)',
           journeyMessageCursorSqlExpression('whatsapp_api', 'msg.id'),
           journeyMessageBefore,
           journeyMessageBeforeCursor
         )}
       ORDER BY ${coalescedTimestampSortExpression('msg.message_timestamp', 'msg.created_at')} DESC,
                ${journeyMessageCursorSqlExpression('whatsapp_api', 'msg.id')} DESC
       ${optionalLimitClause(journeyMessageLimit)}
       ) recent_whatsapp_api_messages
       ORDER BY ${timestampSortExpression('journey_message_date')} ASC,
                ${journeyMessageCursorSqlExpression('whatsapp_api', 'whatsapp_api_message_id')} ASC`,
      appendOptionalLimitParam(
        appendJourneyMessageBeforeParams(
          [...whatsappApiMessageContactMatch.params, includeBusinessMessages ? 1 : 0, ...OUTBOUND_JOURNEY_MESSAGE_DIRECTIONS],
          journeyMessageBefore,
          journeyMessageBeforeCursor
        ),
        journeyMessageLimit
      )
    )

    whatsappApiMessages.forEach(msg => {
      if (!includeBusinessMessages && isOutboundWhatsAppDirection(msg.direction)) return

      const payloadMedia = getWhatsAppMediaFromPayload(msg.raw_payload_json, msg.message_type)
      const payloadLocation = getWhatsAppLocationFromPayload(msg.raw_payload_json, msg.message_type)
      const rawPayload = parseJsonObject(msg.raw_payload_json)
      const agentMetadata = extractConversationalAgentMessageMetadata(rawPayload)
      const context = parseJsonObject(msg.context_json)
      const detectedAttribution = detectWhatsAppAttributionFields({ row: msg, rawPayload, context }, [msg.message_text])
      const detectedSourceId = cleanString(msg.detected_source_id || detectedAttribution.sourceId)
      const detectedSourceType = cleanString(msg.detected_source_type || detectedAttribution.sourceType)
      const replyContextId = getWhatsAppReplyContextId(context, rawPayload)
      const reactionEmoji = cleanString(msg.message_type).toLowerCase() === 'reaction'
        ? getWhatsAppReactionEmoji(rawPayload, context, msg.message_text)
        : ''
      const media = {
        media_url: cleanString(msg.media_url) || payloadMedia.media_url,
        media_id: payloadMedia.media_id,
        media_mime_type: cleanString(msg.media_mime_type) || payloadMedia.media_mime_type,
        media_filename: cleanString(msg.media_filename) || payloadMedia.media_filename,
        media_duration_ms: Number(msg.media_duration_ms || 0) || payloadMedia.media_duration_ms
      }
      const data = {
        source: 'WhatsApp',
        phone: msg.phone,
        from_phone: msg.from_phone,
        to_phone: msg.to_phone,
        business_phone: msg.business_phone,
        business_phone_number_id: msg.business_phone_number_id,
        transport: msg.transport || 'api',
        routing_reason: msg.routing_reason || null,
        message_text: msg.message_text,
        message_type: msg.message_type,
        ...media,
        ...payloadLocation,
        referral_source_url: msg.detected_source_url || detectedAttribution.sourceUrl,
        referral_source_type: detectedSourceType,
        referral_ctwa_clid: msg.detected_ctwa_clid || detectedAttribution.ctwaClid,
        referral_source_id: detectedSourceId,
        referral_headline: msg.detected_headline || detectedAttribution.headline,
        referral_body: msg.detected_body || detectedAttribution.body,
        referral_source_app: msg.detected_source_app || detectedAttribution.sourceApp,
        referral_entry_point: msg.detected_entry_point || detectedAttribution.entryPoint,
        referral_conversion_data: msg.detected_conversion_data || detectedAttribution.conversionData,
        referral_ctwa_payload: msg.detected_ctwa_payload || detectedAttribution.ctwaPayload,
        attribution_source: 'whatsapp_api',
        attribution_record_id: msg.attribution_id || null,
        whatsapp_api_message_id: msg.whatsapp_api_message_id,
        whatsapp_message_id: msg.wamid || msg.ycloud_message_id,
        provider_message_id: msg.wamid || msg.ycloud_message_id,
        sent_by_agent: agentMetadata.sentByAgent ? 1 : 0,
        agent_id: agentMetadata.agentId || null,
        reply_to_provider_message_id: cleanString(msg.message_type).toLowerCase() === 'reaction' ? '' : replyContextId,
        reaction_emoji: reactionEmoji,
        reaction_target_provider_message_id: cleanString(msg.message_type).toLowerCase() === 'reaction' ? replyContextId : '',
        direction: msg.direction || 'inbound',
        status: msg.status || null,
        error_code: msg.error_code || null,
        error_message: msg.error_message || null
      }
      const isAdAttributed = !isOutboundWhatsAppDirection(data.direction) && hasRealWhatsAppAdAttribution(data)

      whatsappJourneyEvents.push({
        type: 'whatsapp_message',
        date: msg.message_timestamp || msg.created_at,
        cursorKey: buildJourneyMessageCursorKey('whatsapp_api', msg.whatsapp_api_message_id),
        data: {
          ...data,
          is_ad_attributed: isAdAttributed,
          ad_platform: isAdAttributed ? detectWhatsAppAdPlatform(data) : null
        }
      })
    })

    const enrichedWhatsAppJourneyEvents = await enrichMessagingJourneyEventsWithMetaAds(whatsappJourneyEvents)
    addWhatsAppJourneyEvents(enrichedWhatsAppJourneyEvents)

    const metaSocialMessages = await db.all(
      `SELECT *
       FROM (
        SELECT
          msg.id as meta_social_message_id,
          msg.meta_message_id,
          msg.platform,
          msg.message_text,
          msg.message_type,
          msg.media_url,
          msg.media_mime_type,
          msg.message_timestamp,
          msg.created_at,
          msg.sender_id,
          msg.recipient_id,
          msg.page_id,
          msg.instagram_account_id,
          msg.direction,
          msg.status,
          msg.postback_payload,
          msg.raw_payload_json,
          msg.referral_json,
          msg.comment_id,
          msg.post_id,
          msg.parent_comment_id,
          msg.media_id,
          msg.permalink,
          post.message AS post_message,
          post.image_url AS post_image_url,
          post.permalink AS post_permalink,
          post.post_type AS post_type,
          COALESCE(msg.message_timestamp, msg.created_at) as journey_message_date,
          profile.profile_name,
          profile.username,
          profile.meta_user_id
       FROM meta_social_messages msg
       LEFT JOIN meta_social_contacts profile ON profile.id = msg.meta_social_contact_id
       LEFT JOIN meta_social_posts post ON post.id = COALESCE(NULLIF(msg.post_id, ''), msg.media_id)
       WHERE msg.contact_id IN (${metaContactIdPlaceholders})
         AND (
           ? = 1
           OR LOWER(COALESCE(msg.direction, 'inbound')) NOT IN (${outboundMessageDirectionPlaceholders})
         )
         ${journeyMessageBeforeClause(
           'COALESCE(msg.message_timestamp, msg.created_at)',
           journeyMessageCursorSqlExpression('meta_social', 'msg.id'),
           journeyMessageBefore,
           journeyMessageBeforeCursor
         )}
       ORDER BY ${coalescedTimestampSortExpression('msg.message_timestamp', 'msg.created_at')} DESC,
                ${journeyMessageCursorSqlExpression('meta_social', 'msg.id')} DESC
       ${optionalLimitClause(journeyMessageLimit)}
       ) recent_meta_social_messages
       ORDER BY ${timestampSortExpression('journey_message_date')} ASC,
                ${journeyMessageCursorSqlExpression('meta_social', 'meta_social_message_id')} ASC`,
      appendOptionalLimitParam(
        appendJourneyMessageBeforeParams(
          [...metaPersonContactIds, includeBusinessMessages ? 1 : 0, ...OUTBOUND_JOURNEY_MESSAGE_DIRECTIONS],
          journeyMessageBefore,
          journeyMessageBeforeCursor
        ),
        journeyMessageLimit
      )
    )

    const metaSocialJourneyEvents = []

    metaSocialMessages.forEach(msg => {
      if (!includeBusinessMessages && isOutboundWhatsAppDirection(msg.direction)) return

      const platform = cleanString(msg.platform)
      const source = getMetaSourceLabelForChat(platform, msg.message_type)
      const rawPayload = parseJsonObject(msg.raw_payload_json)
      const agentMetadata = extractConversationalAgentMessageMetadata(rawPayload)
      const metaAdAttributionData = buildMetaSocialAdAttributionData(msg, rawPayload)
      const provider = cleanString(rawPayload?.provider)
      const replyContextId = getMetaReplyContextId(rawPayload)
      const reactionTargetId = cleanString(msg.message_type).toLowerCase() === 'reaction'
        ? getMetaReactionTargetId(rawPayload) || cleanString(msg.meta_message_id)
        : ''
      const postDeleted = isMetaPostDeletedForChat(msg)

      metaSocialJourneyEvents.push({
        type: 'meta_message',
        date: msg.message_timestamp || msg.created_at,
        cursorKey: buildJourneyMessageCursorKey('meta_social', msg.meta_social_message_id),
        data: {
          source,
          social_platform: platform,
          sender_id: msg.sender_id,
          recipient_id: msg.recipient_id,
          page_id: msg.page_id,
          instagram_account_id: msg.instagram_account_id,
          profile_name: msg.profile_name,
          username: msg.username,
          message_text: getMetaMessageTextForChat(msg),
          message_type: msg.message_type,
          media_url: msg.media_url,
          media_mime_type: msg.media_mime_type,
          postback_payload: msg.postback_payload,
          referral_json: msg.referral_json,
          attribution_source: 'meta_social',
          ...metaAdAttributionData,
          provider: provider || 'meta',
          meta_social_message_id: msg.meta_social_message_id,
          meta_message_id: msg.meta_message_id,
          provider_message_id: msg.meta_message_id,
          sent_by_agent: agentMetadata.sentByAgent ? 1 : 0,
          agent_id: agentMetadata.agentId || null,
          reply_to_provider_message_id: cleanString(msg.message_type).toLowerCase() === 'reaction' ? '' : replyContextId,
          reaction_emoji: cleanString(msg.message_type).toLowerCase() === 'reaction' ? cleanString(msg.message_text) : '',
          reaction_target_provider_message_id: reactionTargetId,
          direction: msg.direction || 'inbound',
          status: msg.status || null,
          // Un comentario público no viaja por Messenger. Conservamos el canal de
          // distribución explícito para que las superficies móviles no lo pinten
          // como DM: Facebook para comentarios de página e Instagram para media.
          transport: isMetaCommentMessageType(msg.message_type)
            ? (platform === 'instagram' ? 'instagram_comment' : 'facebook_comment')
            : (platform === 'instagram' ? 'instagram' : 'messenger'),
          // Contexto de comentario (para etiquetar "comentó" y responder desde el inbox).
          comment_id: msg.comment_id || null,
          post_id: msg.post_id || null,
          media_id: msg.media_id || null,
          parent_comment_id: msg.parent_comment_id || null,
          permalink: msg.permalink || null,
          meta_user_id: msg.meta_user_id || null,
          // Contenido de la publicación comentada (para mostrar "de qué publicación
          // comentó" dentro del globo): texto, imagen y link a la publicación.
          post_message: getMetaPostMessageForChat(msg) || null,
          post_image_url: msg.post_image_url || null,
          post_permalink: msg.post_permalink || msg.permalink || null,
          post_type: msg.post_type || null,
          post_deleted: postDeleted ? 1 : 0
        }
      })
	    })

    const enrichedMetaSocialJourneyEvents = await enrichMessagingJourneyEventsWithMetaAds(metaSocialJourneyEvents)
    journey.push(...enrichedMetaSocialJourneyEvents)

	    const emailMessages = await db.all(
	      `SELECT *
	       FROM (
	        SELECT
	          id AS email_message_id,
	          contact_id,
	          direction,
	          status,
	          to_email,
	          from_email,
	          reply_to,
	          subject,
	          message_text,
	          html_body,
	          smtp_message_id,
	          error_message,
	          raw_payload_json,
	          message_timestamp,
	          created_at,
	          COALESCE(message_timestamp, created_at) as journey_message_date
	       FROM email_messages
	       WHERE contact_id = ?
	         AND (
	           ? = 1
	           OR LOWER(COALESCE(direction, 'outbound')) NOT IN (${outboundMessageDirectionPlaceholders})
	         )
	         ${journeyMessageBeforeClause(
	           'COALESCE(message_timestamp, created_at)',
	           journeyMessageCursorSqlExpression('email', 'id'),
	           journeyMessageBefore,
	           journeyMessageBeforeCursor
	         )}
	       ORDER BY ${coalescedTimestampSortExpression('message_timestamp', 'created_at')} DESC,
	                ${journeyMessageCursorSqlExpression('email', 'id')} DESC
	       ${optionalLimitClause(journeyMessageLimit)}
	       ) recent_email_messages
	       ORDER BY ${timestampSortExpression('journey_message_date')} ASC,
	                ${journeyMessageCursorSqlExpression('email', 'email_message_id')} ASC`,
	      appendOptionalLimitParam(
	        appendJourneyMessageBeforeParams(
	          [id, includeBusinessMessages ? 1 : 0, ...OUTBOUND_JOURNEY_MESSAGE_DIRECTIONS],
	          journeyMessageBefore,
	          journeyMessageBeforeCursor
	        ),
	        journeyMessageLimit
	      )
	    )

    emailMessages.forEach(msg => {
      const rawPayload = parseJsonObject(msg.raw_payload_json)
      const agentMetadata = extractConversationalAgentMessageMetadata(rawPayload)
      const provider = cleanString(rawPayload?.provider).toLowerCase()
      journey.push({
        type: 'email_message',
        date: msg.message_timestamp || msg.created_at,
        cursorKey: buildJourneyMessageCursorKey('email', msg.email_message_id),
        data: {
          source: 'Correo',
          email_message_id: msg.email_message_id,
          smtp_message_id: msg.smtp_message_id || null,
          message_type: 'email',
          message_text: msg.message_text || '',
          html_body: msg.html_body || '',
          subject: msg.subject || '',
          to_email: msg.to_email || '',
          from_email: msg.from_email || '',
          reply_to: msg.reply_to || '',
          direction: msg.direction || 'outbound',
          status: msg.status || null,
          error_message: msg.error_message || null,
          sent_by_agent: agentMetadata.sentByAgent ? 1 : 0,
          agent_id: agentMetadata.agentId || null,
          transport: provider === 'highlevel' ? 'ghl_email' : 'email'
        }
      })
    })

    const appointmentConfirmationTimestampExpression = 'COALESCE(w.processed_at, w.updated_at, w.created_at)'
    const appointmentConfirmationCards = await db.all(
      `SELECT
         w.id,
         w.appointment_id,
         w.result_detail,
         w.processed_at,
         w.updated_at,
         w.created_at,
         a.title,
         a.start_time,
         a.end_time
       FROM appointment_confirmation_windows w
       LEFT JOIN appointments a ON a.id = w.appointment_id
       WHERE w.contact_id = ?
         AND w.status = 'done'
         AND w.result = 'confirmed'
         AND COALESCE(w.confirmation_success_action, 'chat_card') = 'chat_card'
         ${journeyMessageBeforeClause(
           appointmentConfirmationTimestampExpression,
           journeyMessageCursorSqlExpression('appointment_confirmation', 'w.id'),
           journeyMessageBefore,
           journeyMessageBeforeCursor
         )}
       ORDER BY ${coalescedTimestampSortExpression('w.processed_at', 'w.updated_at', 'w.created_at')} ASC,
                ${journeyMessageCursorSqlExpression('appointment_confirmation', 'w.id')} ASC`,
      appendJourneyMessageBeforeParams(
        [id],
        journeyMessageBefore,
        journeyMessageBeforeCursor
      )
    ).catch(() => [])

    appointmentConfirmationCards.forEach(card => {
      journey.push({
        type: 'appointment_confirmation',
        date: card.processed_at || card.updated_at || card.created_at,
        cursorKey: buildJourneyMessageCursorKey('appointment_confirmation', card.id),
        data: {
          id: card.id,
          appointment_id: card.appointment_id,
          title: card.title,
          status: 'confirmed',
          start_time: card.start_time,
          end_time: card.end_time,
          result_detail: card.result_detail
        }
      })
    })

    if (chatMessagesOnly) {
      journey.sort(compareJourneyMessagesByCursor)
      const limitedJourney = journeyMessageLimit ? journey.slice(-journeyMessageLimit) : journey
      logger.info(`Mensajes de chat obtenidos para contacto ${id}: ${limitedJourney.length} eventos`)

      return res.json({
        success: true,
        data: limitedJourney
      })
    }

	    // 3. Contacto creado
    const originEvidence = resolveContactJourneyOrigin({ contact, sessions, whatsappEvents: enrichedWhatsAppJourneyEvents })
    const webConversionData = originEvidence.webData
    const adAttributedWhatsAppEvent = originEvidence.whatsappEvent || enrichedWhatsAppJourneyEvents.find(event => event?.data?.is_ad_attributed)
    const resolvedContactAdFields = buildResolvedMetaAdFields(contact, null)
    const conversionChannel = originEvidence.channel

    journey.push({
      type: 'contact_created',
      date: contact.created_at,
      data: {
        name: contact.full_name,
        email: contact.email,
        phone: contact.phone,
        source: webConversionData?.conversion_source || contact.source,
        conversion_channel: conversionChannel,
        origin_confidence: originEvidence.scores,
        ...webConversionData,
        attribution_ad_name: webConversionData?.attribution_ad_name || (conversionChannel === 'whatsapp' ? adAttributedWhatsAppEvent?.data?.attribution_ad_name : null) || resolvedContactAdFields.ad_name,
        attribution_ad_id: webConversionData?.attribution_ad_id || (conversionChannel === 'whatsapp' ? adAttributedWhatsAppEvent?.data?.attribution_ad_id : null) || resolvedContactAdFields.ad_id,
        campaign_id: webConversionData?.campaign_id || (conversionChannel === 'whatsapp' ? adAttributedWhatsAppEvent?.data?.campaign_id : null) || resolvedContactAdFields.campaign_id,
        campaign_name: webConversionData?.campaign_name || (conversionChannel === 'whatsapp' ? adAttributedWhatsAppEvent?.data?.campaign_name : null) || resolvedContactAdFields.campaign_name,
        adset_id: webConversionData?.adset_id || (conversionChannel === 'whatsapp' ? adAttributedWhatsAppEvent?.data?.adset_id : null) || resolvedContactAdFields.adset_id,
        adset_name: webConversionData?.adset_name || (conversionChannel === 'whatsapp' ? adAttributedWhatsAppEvent?.data?.adset_name : null) || resolvedContactAdFields.adset_name
      }
    })

    // 4. TODAS las citas agendadas (filtradas por calendarios de atribución)
    // Obtener calendarios de atribución configurados
    const attributionConfig = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      ['attribution_calendar_ids']
    )

    let appointments
    if (attributionConfig && attributionConfig.config_value) {
      try {
        const calendarIds = JSON.parse(attributionConfig.config_value)
        if (calendarIds.length > 0) {
          const placeholders = calendarIds.map(() => '?').join(',')
          appointments = await db.all(
            `SELECT * FROM appointments
             WHERE contact_id = ?
               AND calendar_id IN (${placeholders})
             ORDER BY ${timestampSortExpression('date_added')} ASC, id ASC`,
            [id, ...calendarIds]
          )
        } else {
          // Sin calendarios configurados, usar todos
          appointments = await db.all(
            `SELECT * FROM appointments
             WHERE contact_id = ?
             ORDER BY ${timestampSortExpression('date_added')} ASC, id ASC`,
            [id]
          )
        }
      } catch (error) {
        logger.warn(`Error parseando calendarios de atribución: ${error.message}`)
        // Fallback: usar todos los calendarios
        appointments = await db.all(
          `SELECT * FROM appointments
           WHERE contact_id = ?
           ORDER BY ${timestampSortExpression('date_added')} ASC, id ASC`,
          [id]
        )
      }
    } else {
      // Sin configuración, usar todos los calendarios
      appointments = await db.all(
        `SELECT * FROM appointments
         WHERE contact_id = ?
         ORDER BY ${timestampSortExpression('date_added')} ASC, id ASC`,
        [id]
      )
    }

    appointments.forEach(appointment => {
      journey.push({
        type: 'appointment',
        date: appointment.date_added,
        data: {
          title: appointment.title,
          status: appointment.appointment_status || appointment.status,
          start_time: appointment.start_time,
          end_time: appointment.end_time,
          address: appointment.address,
          notes: appointment.notes
        }
      })
    })

    // 5. TODOS los pagos exitosos
    const payments = await db.all(
      `SELECT * FROM payments
       WHERE ${successfulPaymentsCondition}
       ORDER BY ${timestampSortExpression('date')} ASC, ${timestampSortExpression('created_at')} ASC, id ASC`,
      [id]
    )

    payments.forEach(payment => {
      journey.push({
        type: 'payment',
        date: payment.date,
        data: {
          amount: payment.amount,
          status: payment.status,
          title: payment.title,
          type: payment.type,
          payment_provider: payment.payment_provider
        }
      })
    })

    // Ordenar TODOS los eventos por fecha cronológica
    journey.sort((a, b) => parseSortableTimestamp(a.date) - parseSortableTimestamp(b.date))

    logger.info(`Journey obtenido para contacto ${id}: ${journey.length} eventos`)

    res.json({
      success: true,
      data: journey
    })

  } catch (error) {
    logger.error(`Error obteniendo journey del contacto ${req.params.id}: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo journey del contacto'
    })
  }
}

export const getContactConversation = async (req, res) => {
  const conversationReq = {
    ...req,
    query: {
      ...req.query,
      includeBusinessMessages: 'true',
      refreshExternalStatuses: req.query?.refreshExternalStatuses ?? 'false',
      chatMessagesOnly: 'true'
    }
  }

  return getContactJourney(conversationReq, res)
}
