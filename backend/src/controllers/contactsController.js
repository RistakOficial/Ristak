import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { updateContactsStats } from '../utils/updateContactsStats.js'
import { resolveDateRange, resolveDateRangeWithGHLTimezone } from '../utils/dateUtils.js'
import { buildContactStats } from '../services/analyticsService.js'
import { getGHLClient } from '../services/ghlClient.js'
import { findContactByPhoneCandidates, getGhlContactIdForLocalContact, prepareContactPhoneUpsert } from '../services/contactIdentityService.js'
import { getHiddenContactFilters, buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js'
import { nonTestPaymentCondition } from '../utils/paymentMode.js'
import { buildContactSearchClause, buildContactSearchRank } from '../utils/searchText.js'
import { normalizeWhatsAppAttributionPlatform } from '../utils/trafficSourceNormalizer.js'
import { loadFirstWhatsAppAttributions, buildContactAttributionFields } from '../services/contactSourceService.js'
import { findWhatsAppProfilePictureUrl, warmWhatsAppApiProfilePictures } from '../services/whatsappApiService.js'
import { warmWhatsAppQrProfilePictures } from '../services/whatsappQrService.js'
import {
  listContactCustomFieldDefinitions,
  prepareContactCustomFieldsForStorage,
  updateContactCustomFieldDefinition,
  upsertContactCustomFieldDefinition
} from '../services/contactCustomFieldDefinitionsService.js'
import {
  buildHighLevelCustomFieldsPayload,
  mergeContactCustomFields,
  parseContactCustomFields,
  serializeContactCustomFieldsForDb
} from '../utils/contactCustomFields.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { normalizePhoneForAccount } from '../utils/accountLocale.js'
import { resolveTagIds, tagNamesForIds, listContactTags } from '../services/contactTagsService.js'
import fetch from 'node-fetch'
import { randomUUID } from 'crypto'

const normalizePhone = (phone) => {
  if (!phone) return null
  const digits = String(phone).replace(/\D/g, '')
  if (digits.length < 7) return null
  return digits.slice(-10)
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
const ACTIVE_APPOINTMENT_CONDITION = `LOWER(COALESCE(appointment_status, status, '')) NOT IN (${sqlList(APPOINTMENT_CANCELED_STATUSES)})`
const ATTENDED_APPOINTMENT_CONDITION = `LOWER(COALESCE(appointment_status, status, '')) IN (${sqlList(APPOINTMENT_ATTENDED_STATUSES)})`
const CONTACT_WHATSAPP_PROFILE_SELECTS = `
        (
          SELECT raw_profile_json
          FROM whatsapp_api_contacts
          WHERE contact_id = c.id OR phone = c.phone
          ORDER BY updated_at DESC
          LIMIT 1
        ) AS whatsapp_raw_profile_json,
        (
          SELECT profile_picture_url
          FROM whatsapp_api_contacts
          WHERE contact_id = c.id OR phone = c.phone
          ORDER BY CASE WHEN NULLIF(profile_picture_url, '') IS NULL THEN 1 ELSE 0 END,
                   profile_picture_updated_at DESC,
                   updated_at DESC
          LIMIT 1
        ) AS whatsapp_profile_picture_url,
        (
          SELECT profile_picture_updated_at
          FROM whatsapp_api_contacts
          WHERE contact_id = c.id OR phone = c.phone
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
        ) AS meta_social_profile_picture_url`

const cleanString = (value) => String(value || '').trim()
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key)
const isTruthyQueryValue = (value) => ['1', 'true', 'yes', 'si', 'sí'].includes(cleanString(value).toLowerCase())
const hasTextValue = (value) => cleanString(value).length > 0
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
           AND LOWER(COALESCE(transport, '')) IN ('ghl_whatsapp', 'ghl_sms')
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
    payload.message?.[normalizedType]
  ].filter(item => item && typeof item === 'object')

  const media = mediaObjects[0] || null
  if (!media) return {}

  return {
    media_url: cleanString(media.link || media.url || media.href),
    media_id: cleanString(media.id || media.mediaId || media.media_id),
    media_mime_type: cleanString(media.mimeType || media.mime_type),
    media_filename: cleanString(media.filename || media.fileName || media.name),
    media_duration_ms: Number(media.durationMs || media.duration_ms || 0) || null
  }
}

const splitName = (name = '') => {
  const parts = cleanString(name).split(/\s+/).filter(Boolean)
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' ')
  }
}

const createManualContactId = () => `manual_contact_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`

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

const mapContactRowForResponse = (contact = {}) => {
  let status = 'lead'
  if (Number(contact.purchases_count || 0) > 0) {
    status = 'customer'
  } else if (contact.has_appointments || contact.appointment_date) {
    status = 'appointment'
  }

  return {
    id: contact.id,
    createdAt: contact.created_at,
    name: contact.full_name || '',
    email: contact.email || '',
    phone: contact.phone || '',
    ltv: parseFloat(contact.total_paid || 0),
    status,
    lastPurchase: contact.last_purchase_date,
    purchases: contact.purchases_count || 0,
    hasAppointments: Boolean(contact.has_appointments),
    hasShowedAppointment: Boolean(contact.has_showed_appointment),
    hasAttendedAppointment: Boolean(contact.has_showed_appointment),
    source: contact.source,
    profilePhotoUrl: getContactProfilePhotoUrl(contact) || null,
    ad_name: contact.attribution_ad_name,
    ad_id: contact.attribution_ad_id,
    preferredWhatsAppPhoneNumberId: contact.preferred_whatsapp_phone_number_id || '',
    preferred_whatsapp_phone_number_id: contact.preferred_whatsapp_phone_number_id || '',
    customFields: parseContactCustomFields(contact.custom_fields),
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
  unreadCount: Number(contact.unread_count || 0)
})

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
       ORDER BY date DESC`,
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
       ORDER BY date DESC`,
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

const loadMetaAdsByAdIds = async (adIds = []) => {
  const uniqueIds = [...new Set(adIds.map(cleanString).filter(Boolean))]
  const byAdId = new Map()
  if (uniqueIds.length === 0) return byAdId

  const rows = await db.all(
    `SELECT
       date,
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
     ORDER BY date DESC`,
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

const enrichWhatsAppJourneyEventsWithMetaAds = async (events = []) => {
  const adIds = events.flatMap(event => {
    const data = event?.data || {}
    return [
      data.attribution_ad_id,
      data.referral_source_id,
      data.ad_id_thru_message
    ]
  })
  const metaByAdId = await loadMetaAdsByAdIds(adIds)
  if (metaByAdId.size === 0) return events

  return events.map(event => {
    const data = event?.data || {}
    const adId = cleanString(data.attribution_ad_id || data.referral_source_id || data.ad_id_thru_message)
    const metaAttribution = metaByAdId.get(adId)
    if (!metaAttribution) return event

    return {
      ...event,
      data: {
        ...data,
        campaign_id: metaAttribution.campaignId || data.campaign_id || null,
        campaign_name: metaAttribution.campaignName || data.campaign_name || null,
        adset_id: metaAttribution.adsetId || data.adset_id || null,
        adset_name: metaAttribution.adsetName || data.adset_name || null,
        attribution_ad_id: metaAttribution.adId || data.attribution_ad_id || data.referral_source_id || null,
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
    const { q = '', limit = 60, businessPhoneNumberId = '', businessPhone = '' } = req.query
    const limitNumber = Math.min(Number(limit) || 60, 100)
    const shouldWarmProfilePictures = isTruthyQueryValue(req.query.warmProfilePictures || req.query.warmProfiles)
    const searchTerm = cleanString(q)
    const phoneNumberIdFilter = cleanString(businessPhoneNumberId)
    const businessPhoneFilter = normalizePhoneForStorage(businessPhone)
    const whatsappMessageConditions = ['contact_id IS NOT NULL']
    const whatsappMessageParams = []
    const conditions = []
    const params = []
    const includeMetaSocialMessages = !phoneNumberIdFilter && !businessPhoneFilter

    if (phoneNumberIdFilter || businessPhoneFilter) {
      const phoneClauses = []
      if (phoneNumberIdFilter) {
        phoneClauses.push('business_phone_number_id = ?')
        whatsappMessageParams.push(phoneNumberIdFilter)
      }
      if (businessPhoneFilter) {
        phoneClauses.push('business_phone = ?')
        whatsappMessageParams.push(businessPhoneFilter)
      }
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

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const messageRowsSql = `
        SELECT
          contact_id,
          'whatsapp:' || id AS message_row_id,
          message_text,
          message_type,
          direction,
          business_phone,
          business_phone_number_id,
          transport,
          COALESCE(message_timestamp, created_at) AS message_date,
          created_at,
          'whatsapp' AS message_channel
        FROM whatsapp_api_messages
        WHERE ${whatsappMessageConditions.join(' AND ')}
        ${includeMetaSocialMessages ? `
        UNION ALL
        SELECT
          contact_id,
          'meta:' || id AS message_row_id,
          message_text,
          message_type,
          direction,
          NULL AS business_phone,
          NULL AS business_phone_number_id,
          NULL AS transport,
          COALESCE(message_timestamp, created_at) AS message_date,
          created_at,
          platform AS message_channel
        FROM meta_social_messages
        WHERE contact_id IS NOT NULL
        ` : ''}
    `

    const rows = await db.all(`
      WITH message_rows AS (
        ${messageRowsSql}
      ),
      chat_stats AS (
        SELECT
          contact_id,
          COUNT(*) AS message_count,
          MAX(message_date) AS last_message_date
        FROM message_rows
        GROUP BY contact_id
      ),
      payment_stats AS (
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
          MAX(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN date ELSE NULL END) AS last_purchase_date
        FROM payments
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
        c.attribution_ad_name,
        c.attribution_ad_id,
        c.preferred_whatsapp_phone_number_id,
        c.custom_fields,
        c.tags,
${CONTACT_WHATSAPP_PROFILE_SELECTS},
${CONTACT_META_PROFILE_SELECT},
        COALESCE(ps.total_paid, 0) AS total_paid,
        COALESCE(ps.purchases_count, 0) AS purchases_count,
        ps.last_purchase_date AS last_purchase_date,
        c.appointment_date,
        c.created_at,
        (
          SELECT COUNT(*) > 0
          FROM appointments
          WHERE contact_id = c.id
            AND ${ACTIVE_APPOINTMENT_CONDITION}
        ) AS has_appointments,
        (
          COALESCE(ps.purchases_count, 0) > 0
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
        chat_stats.message_count,
        chat_stats.last_message_date,
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
      FROM chat_stats
      JOIN contacts c ON c.id = chat_stats.contact_id
      LEFT JOIN payment_stats ps ON ps.contact_id = c.id
      LEFT JOIN message_rows lm ON lm.message_row_id = (
        SELECT message_row_id
        FROM message_rows
        WHERE contact_id = c.id
        ORDER BY message_date DESC, created_at DESC
        LIMIT 1
      )
      LEFT JOIN message_rows lim ON lim.message_row_id = (
        SELECT message_row_id
        FROM message_rows
        WHERE contact_id = c.id
          AND direction = 'inbound'
          AND (business_phone_number_id IS NOT NULL OR business_phone IS NOT NULL)
        ORDER BY message_date DESC, created_at DESC
        LIMIT 1
      )
      LEFT JOIN message_rows fim ON fim.message_row_id = (
        SELECT message_row_id
        FROM message_rows
        WHERE contact_id = c.id
          AND direction = 'inbound'
          AND (business_phone_number_id IS NOT NULL OR business_phone IS NOT NULL)
        ORDER BY message_date ASC, created_at ASC
        LIMIT 1
      )
      ${whereClause}
      ORDER BY chat_stats.last_message_date DESC
      LIMIT ?
    `, [...whatsappMessageParams, ...params, limitNumber])

    const responseRows = shouldWarmProfilePictures
      ? await warmWhatsAppProfilePicturesForRows(rows, {
          apiLimit: 60,
          qrLimit: 24
        })
      : rows

    res.json({
      success: true,
      data: responseRows.map(mapChatContactRowForResponse)
    })
  } catch (error) {
    logger.error(`Error obteniendo chats: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo chats'
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
      endDate
    } = req.query

    const pageNumber = Number(page) || 1
    const limitNumber = Math.min(Number(limit) || 50, 500)
    const offset = Math.max((pageNumber - 1) * limitNumber, 0)
    const shouldWarmProfilePictures = isTruthyQueryValue(req.query.warmProfilePictures || req.query.warmProfiles)

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
    const rangeLabel = range.isFiltered
      ? `${range.startUtc || '---'} -> ${range.endUtc || '---'}`
      : 'todos'

    logger.info(`Obteniendo contactos - página ${pageNumber}, límite ${limitNumber}, rango: ${rangeLabel}`)

    // Query base
    const params = []

    // Construir WHERE clause para filtros (para COUNT query - sin alias)
    const conditions = []

    if (search) {
      const searchClause = buildContactSearchClause('contacts', search)
      conditions.push(searchClause.condition)
      params.push(...searchClause.params)
    }

    if (range.startUtc) {
      conditions.push('created_at >= ?')
      params.push(range.startUtc)
    }

    if (range.endUtc) {
      conditions.push('created_at <= ?')
      params.push(range.endUtc)
    }

    // Aplicar filtro de contactos ocultos (para COUNT - sin alias)
    const hiddenFilters = await getHiddenContactFilters()
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false)
    if (hiddenCondition) {
      conditions.push(hiddenCondition)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // Obtener el total de contactos
    const countQuery = `SELECT COUNT(*) as total FROM contacts ${whereClause}`
    const countResult = await db.get(countQuery, params)
    const totalContacts = countResult.total

    // Construir WHERE clause para query principal (con alias 'c')
    const mainConditions = []

    if (search) {
      mainConditions.push(buildContactSearchClause('c', search).condition)
    }

    if (range.startUtc) {
      mainConditions.push('c.created_at >= ?')
    }

    if (range.endUtc) {
      mainConditions.push('c.created_at <= ?')
    }

    // Aplicar filtro de contactos ocultos (con alias 'c')
    const hiddenConditionAlias = buildHiddenContactsCondition(hiddenFilters, 'c', false)
    if (hiddenConditionAlias) {
      mainConditions.push(hiddenConditionAlias)
    }

    const mainWhereClause = mainConditions.length > 0 ? `WHERE ${mainConditions.join(' AND ')}` : ''

    // Obtener los contactos
    const sortableColumns = new Set([
      'created_at',
      'full_name',
      'email',
      'phone',
      'total_paid',
      'purchases_count'
    ])
    const safeSortBy = sortableColumns.has(sortBy) ? sortBy : 'created_at'
    const orderDirection = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC'

    const searchRank = search ? buildContactSearchRank('c', search) : null
    const orderBy = searchRank
      ? `${searchRank.expression} DESC, ${safeSortBy} ${orderDirection}`
      : `${safeSortBy} ${orderDirection}`

    const contactsQuery = `
      WITH payment_stats AS (
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
          MAX(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN date ELSE NULL END) AS last_purchase_date
        FROM payments
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
        ps.last_purchase_date AS last_purchase_date,
        c.appointment_date,
        c.created_at,
        (
          SELECT COUNT(*) > 0
          FROM appointments
          WHERE contact_id = c.id
            AND ${ACTIVE_APPOINTMENT_CONDITION}
        ) AS has_appointments,
        (
          COALESCE(ps.purchases_count, 0) > 0
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
        ) AS has_showed_appointment
      FROM contacts c
      LEFT JOIN payment_stats ps ON ps.contact_id = c.id
      ${mainWhereClause}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `

    const contactsParams = [...params, ...(searchRank?.params ?? []), limitNumber, offset]
    const contacts = await db.all(contactsQuery, contactsParams)
    const hydratedContacts = shouldWarmProfilePictures
      ? await warmWhatsAppProfilePicturesForRows(contacts, {
          apiLimit: Math.min(limitNumber, 80),
          qrLimit: Math.min(limitNumber, 24)
        })
      : contacts

    const firstSessionsByContact = new Map()
    const firstSessionsByVisitor = new Map()
    const firstSessionsByEmail = new Map()
    const contactIds = Array.from(new Set(hydratedContacts.map(c => c.id).filter(Boolean)))
    const visitorIds = Array.from(new Set(hydratedContacts.map(c => c.visitor_id).filter(Boolean)))
    const emails = Array.from(new Set(
      hydratedContacts
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
    const mappedContacts = hydratedContacts.map(c => {
      const firstSession = getFirstSessionForContact(c)
      const attributionFields = buildContactAttributionFields(c, whatsappAttributionsByContact.get(c.id))

      // Determinar status basado en la actividad del contacto
      let status = 'lead'
      if (c.purchases_count > 0) {
        status = 'customer'
      } else if (c.has_appointments) {
        status = 'appointment'
      }

      return {
        id: c.id,
        createdAt: c.created_at,
        name: c.full_name || '',
        email: c.email || '',
        phone: c.phone || '',
        ltv: parseFloat(c.total_paid || 0),
        status,
        lastPurchase: c.last_purchase_date,
        purchases: c.purchases_count || 0,
        hasAppointments: Boolean(c.has_appointments),
        hasShowedAppointment: Boolean(c.has_showed_appointment),
        hasAttendedAppointment: Boolean(c.has_showed_appointment),
        source: c.source,
        attribution_url: attributionFields.attribution_url,
        attribution_session_source: attributionFields.attribution_session_source,
        attribution_medium: attributionFields.attribution_medium,
        attribution_ctwa_clid: attributionFields.attribution_ctwa_clid,
        whatsappAttributionPlatform: attributionFields.whatsappAttributionPlatform,
        ad_name: c.attribution_ad_name,
        ad_id: c.attribution_ad_id,
        preferredWhatsAppPhoneNumberId: c.preferred_whatsapp_phone_number_id || '',
        preferred_whatsapp_phone_number_id: c.preferred_whatsapp_phone_number_id || '',
        profilePhotoUrl: getContactProfilePhotoUrl(c) || null,
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
      `Contactos obtenidos (${rangeLabel}) -> ${hydratedContacts.length} registros en esta página, ${totalContacts} total`
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
          MAX(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN date ELSE NULL END) AS last_purchase_date
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
        ps.last_purchase_date AS last_purchase_date,
        c.appointment_date,
        c.created_at,
        (
          SELECT COUNT(*) > 0
          FROM appointments
          WHERE contact_id = c.id
            AND ${ACTIVE_APPOINTMENT_CONDITION}
        ) AS has_appointments,
        (
          COALESCE(ps.purchases_count, 0) > 0
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
        ) AS has_showed_appointment
      FROM contacts c
      LEFT JOIN payment_stats ps ON ps.contact_id = c.id
      WHERE c.id = ?`,
      [id, id]
    )

    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contacto no encontrado'
      })
    }

    const [hydratedContact] = await warmWhatsAppProfilePicturesForRows([contact], {
      apiLimit: 1,
      qrLimit: 1
    })
    contact = hydratedContact || contact

    // Obtener pagos del contacto
    const payments = await db.all(
      `SELECT * FROM payments
       WHERE contact_id = ?
       AND LOWER(COALESCE(status, '')) != 'deleted'
       ORDER BY date DESC`,
      [id]
    )

    // IMPORTANTE: Estrategia de obtención de citas (DB first, API as fallback)
    // 1. Primero consultamos la DB local (tabla appointments) - respuesta inmediata
    // 2. Si hay configuración de HighLevel, hacemos fallback a API en tiempo real
    // 3. Las citas nuevas de la API se guardan en DB para cache futuro
    // Esto garantiza mejor performance y resiliencia (funciona offline)
    let appointments = await db.all(
      `SELECT * FROM appointments
       WHERE contact_id = ?
       ORDER BY start_time DESC`,
      [id]
    )

    // Fallback: Intentar obtener citas de HighLevel API en tiempo real
    // Solo si no tenemos citas localmente o queremos actualizar con datos frescos
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
         ORDER BY start_time DESC`,
        relatedContactIds
      )
      appointments = appointments.concat(relatedAppointments)
    }

    const dedupedAppointments = dedupeAppointments(appointments)
    const sortedAppointmentsAsc = [...dedupedAppointments].sort((a, b) =>
      new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
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
      new Date(b.start_time).getTime() - new Date(a.start_time).getTime()
    )
    const hasShowedAppointment =
      Boolean(contact.has_showed_appointment) ||
      appointmentsOrdered.some(appointment =>
        APPOINTMENT_ATTENDED_STATUSES.has(String(appointment.appointment_status || appointment.status || '').trim().toLowerCase())
      )

    // Determinar status basado en la actividad del contacto
    let status = 'lead'
    if (contact.purchases_count > 0) {
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

    // Mapear campos de base de datos a nombres esperados por frontend
    const mappedContact = {
      id: contact.id,
      createdAt: contact.created_at,
      name: contact.full_name || '',
      email: contact.email || '',
      phone: contact.phone || '',
      ltv: parseFloat(contact.total_paid || 0),
      status,
      lastPurchase: contact.last_purchase_date,
      purchases: contact.purchases_count || 0,
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

    if (!q) {
      return res.json({
        success: true,
        data: []
      })
    }

    const searchClause = buildContactSearchClause('c', q)
    const searchRank = buildContactSearchRank('c', q)

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
          MAX(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN date ELSE NULL END) AS last_purchase_date
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
        c.appointment_date,
        ps.last_purchase_date AS last_purchase_date,
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
          COALESCE(ps.purchases_count, 0) > 0
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
        ) AS has_showed_appointment
      FROM contacts c
      LEFT JOIN payment_stats ps ON ps.contact_id = c.id
      WHERE ${searchClause.condition}
      ORDER BY ${searchRank.expression} DESC, c.created_at DESC
      LIMIT 20`,
      [...searchClause.params, ...searchRank.params]
    )
    const hydratedContacts = await warmWhatsAppProfilePicturesForRows(contacts, {
      apiLimit: 20,
      qrLimit: 10
    })

    // Mapear campos de base de datos a nombres esperados por frontend
    const mappedContacts = hydratedContacts.map(c => {
      // Determinar status basado en la actividad del contacto
      let status = 'lead'
      if (c.purchases_count > 0) {
        status = 'customer'
      } else if (c.has_appointments) {
        status = 'appointment'
      }

      return {
        id: c.id,
        createdAt: c.created_at,
        name: c.full_name || '',
        email: c.email || '',
        phone: c.phone || '',
        ltv: parseFloat(c.total_paid || 0),
        status,
        lastPurchase: c.last_purchase_date,
        purchases: c.purchases_count || 0,
        hasAppointments: Boolean(c.has_appointments),
        hasShowedAppointment: Boolean(c.has_showed_appointment),
        hasAttendedAppointment: Boolean(c.has_showed_appointment),
        source: c.source,
        ad_name: c.attribution_ad_name,
        ad_id: c.attribution_ad_id,
        profilePhotoUrl: getContactProfilePhotoUrl(c) || null,
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

    const firstNameInput = cleanString(first_name)
    const lastNameInput = cleanString(last_name)
    const fullName = cleanString(full_name || name || [firstNameInput, lastNameInput].filter(Boolean).join(' '))
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
    const nameParts = fullName ? splitName(fullName) : {
      firstName: firstNameInput,
      lastName: lastNameInput
    }
    const createdAtValue = createdAt && !Number.isNaN(Date.parse(createdAt))
      ? new Date(createdAt).toISOString()
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

    logger.info(`Contacto manual creado: ${id} (${contact.full_name || contact.email || contact.phone || 'sin nombre'})`)

    import('../services/automationEngine.js')
      .then(engine => engine.handleAutomationEvent('contact-created', { contactId: id }))
      .catch(() => {})

    res.status(201).json({
      success: true,
      data: mapContactRowForResponse(contact)
    })
  } catch (error) {
    logger.error(`Error creando contacto: ${error.message}`)
    const isUniqueError = /unique|duplicate/i.test(error.message || '')
    res.status(isUniqueError ? 409 : 500).json({
      success: false,
      error: isUniqueError
        ? 'Ya existe un contacto con ese correo o teléfono.'
        : 'Error creando contacto'
    })
  }
}

/**
 * Obtiene estadísticas de contactos
 */
export const getContactStats = async (req, res) => {
  try {
    const { startDate, endDate } = req.query

    const { range, metrics } = await buildContactStats({ startDate, endDate })

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
export const syncContactsStats = async (req, res) => {
  try {
    const stats = await updateContactsStats()

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
      dndSettings
    } = req.body
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
    const normalizedPhone = phone !== undefined
      ? (await normalizePhoneForAccount(phone) || phone || null)
      : undefined
    const phoneUpsert = phone !== undefined
      ? await prepareContactPhoneUpsert({ contactId: id, phone: normalizedPhone })
      : null

    // Construir query de actualización solo con campos permitidos
    const updates = []
    const params = []

    if (full_name !== undefined) {
      updates.push('full_name = ?')
      params.push(full_name)
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

      if (full_name) ghlUpdateData.name = full_name
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
      if (shouldSyncHighLevelCustomFields) {
        logger.warn(`No se pudieron actualizar custom fields en HighLevel para ${id}: ${error.message}`)
        return res.status(502).json({
          success: false,
          error: 'No se pudieron sincronizar los campos personalizados con GoHighLevel'
        })
      }

      logger.warn(`No se pudo actualizar el contacto en HighLevel: ${error.message}`)
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
      if (full_name !== undefined && full_name !== existing.full_name) changedFields.push('name')
      if (email !== undefined && email !== existing.email) changedFields.push('email')
      if (phone !== undefined && phone !== existing.phone) changedFields.push('phone')
      if (source !== undefined && source !== existing.source) changedFields.push('source')
      if (Array.isArray(customFields)) customFields.forEach(field => { if (field?.key) changedFields.push(field.key) })
      import('../services/automationEngine.js').then(engine => {
        if (changedFields.length > 0) {
          engine.handleAutomationEvent('contact-updated', { contactId: id, changedFields }).catch(() => {})
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
    const updatedData = {
      ...updated,
      preferredWhatsAppPhoneNumberId: updated.preferred_whatsapp_phone_number_id || '',
      customFields: parseContactCustomFields(updated.custom_fields),
      tags: parseContactTags(updated.tags)
    }

    logger.info(`Contacto actualizado: ${id}`)

    res.json({
      success: true,
      data: updatedData
    })

  } catch (error) {
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

    // Eliminar el contacto (las relaciones se eliminan automáticamente por CASCADE)
    await db.run('DELETE FROM contacts WHERE id = ?', [id])

    logger.info(`Contacto eliminado: ${id} (${existing.full_name})`)

    res.json({
      success: true,
      message: 'Contacto eliminado correctamente'
    })

  } catch (error) {
    logger.error(`Error eliminando contacto ${req.params.id}: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error eliminando contacto'
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
      WHERE contacts.id = ?
      ORDER BY meta_ads.date DESC
      LIMIT 1
    `, [id])
    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contacto no encontrado'
      })
    }

    const journey = []
    await refreshHighLevelConversationMessageStatuses(id)

    const successfulPaymentsCondition = `
      contact_id = ?
      AND amount > 0
      AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
      AND ${nonTestPaymentCondition()}
    `
    const firstPayment = await db.get(
      `SELECT date FROM payments
       WHERE ${successfulPaymentsCondition}
       ORDER BY date ASC
       LIMIT 1`,
      [id]
    )
    const rawFirstPaymentTime = firstPayment?.date ? new Date(firstPayment.date).getTime() : null
    const firstPaymentTime = Number.isFinite(rawFirstPaymentTime) ? rawFirstPaymentTime : null

    const getDateTime = (value) => {
      const time = new Date(value).getTime()
      return Number.isFinite(time) ? time : 0
    }

    const detectWhatsAppAdPlatform = (data = {}) => normalizeWhatsAppAttributionPlatform(data)

    // El backend emite los eventos de WhatsApp tal cual (uno por mensaje). El frontend
    // los agrupa a uno por día —usando la MISMA zona horaria con la que muestra las
    // fechas— y fusiona la info dando prioridad a la atribución de anuncio. Los mensajes
    // reales del chat se entregan completos para no romper conversación ni archivos; la
    // regla temporal de conversión se aplica sólo al timeline de Info del contacto.
    const isStoredChatMessageEvent = (event) => Boolean(
      event?.data?.whatsapp_api_message_id ||
      event?.data?.whatsapp_message_id ||
      event?.data?.message_type ||
      event?.data?.direction ||
      event?.data?.transport
    )

    const addWhatsAppJourneyEvents = (events) => {
      events
        .filter(event => event?.date)
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

    if (contact.visitor_id) {
      sessions = await db.all(
        `SELECT * FROM sessions
         WHERE contact_id = ? OR visitor_id = ?
         ORDER BY started_at ASC`,
        [id, contact.visitor_id]
      )
    } else {
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

    // Agregar todas las visitas al journey
    sessions.forEach(session => {
      journey.push({
        type: 'page_visit',
        date: session.started_at,
        data: {
          event_name: session.event_name,
          page_url: session.page_url,
          landing_page: session.landing_page,
          referrer_url: session.referrer_url,
          utm_source: session.utm_source,
          utm_medium: session.utm_medium,
          utm_campaign: session.utm_campaign,
          utm_content: session.utm_content,
          source_platform: session.source_platform,
          site_source_name: session.site_source_name,
          campaign_name: session.campaign_name,
          ad_name: session.ad_name,
          ad_id: session.ad_id,
          device_type: session.device_type,
          browser: session.browser,
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
          submission_id: session.submission_id
        }
      })
    })

    // 2. Movimientos de WhatsApp del cliente: diario antes del pago, atribuidos despues.
    const whatsappJourneyEvents = []
    const whatsappMessages = await db.all(
      `SELECT * FROM whatsapp_attribution
       WHERE contact_id = ?
       ORDER BY created_at ASC`,
      [id]
    )

    whatsappMessages.forEach(msg => {
      const data = {
        source: 'WhatsApp',
        phone: msg.phone,
        message_text: msg.message_content,
        referral_source_url: msg.referral_source_url,
        referral_source_type: msg.referral_source_type,
        referral_source_id: msg.referral_source_id || msg.ad_id_thru_message,
        referral_headline: msg.referral_headline,
        referral_body: msg.referral_body,
        referral_image_url: msg.referral_image_url,
        referral_video_url: msg.referral_video_url,
        referral_thumbnail_url: msg.referral_thumbnail_url,
        referral_ctwa_clid: msg.referral_ctwa_clid,
        attribution_source: 'whatsapp_attribution',
        attribution_record_id: msg.id,
        ad_id_thru_message: msg.ad_id_thru_message
      }
      const isAdAttributed = hasRealWhatsAppAdAttribution({
        ...data,
        ad_id_thru_message: msg.ad_id_thru_message
      })

      whatsappJourneyEvents.push({
        type: 'whatsapp_message',
        date: msg.created_at,
        data: {
          ...data,
          is_ad_attributed: isAdAttributed,
          ad_platform: isAdAttributed ? detectWhatsAppAdPlatform(data) : null
        }
      })
    })

    const whatsappApiMessages = await db.all(
      `SELECT
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
       LEFT JOIN whatsapp_api_attribution attr ON attr.whatsapp_api_message_id = msg.id
       WHERE msg.contact_id = ?
       ORDER BY COALESCE(msg.message_timestamp, msg.created_at) ASC`,
      [id]
    )

    whatsappApiMessages.forEach(msg => {
      const payloadMedia = getWhatsAppMediaFromPayload(msg.raw_payload_json, msg.message_type)
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
        referral_source_url: msg.detected_source_url,
        referral_source_type: msg.detected_source_type,
        referral_ctwa_clid: msg.detected_ctwa_clid,
        referral_source_id: msg.detected_source_id,
        referral_headline: msg.detected_headline,
        referral_body: msg.detected_body,
        referral_source_app: msg.detected_source_app,
        referral_entry_point: msg.detected_entry_point,
        referral_conversion_data: msg.detected_conversion_data,
        referral_ctwa_payload: msg.detected_ctwa_payload,
        attribution_source: 'whatsapp_api',
        attribution_record_id: msg.attribution_id || null,
        whatsapp_api_message_id: msg.whatsapp_api_message_id,
        whatsapp_message_id: msg.wamid || msg.ycloud_message_id,
        direction: msg.direction || 'inbound',
        status: msg.status || null,
        error_code: msg.error_code || null,
        error_message: msg.error_message || null
      }
      const isAdAttributed = hasRealWhatsAppAdAttribution(data)

      whatsappJourneyEvents.push({
        type: 'whatsapp_message',
        date: msg.message_timestamp || msg.created_at,
        data: {
          ...data,
          is_ad_attributed: isAdAttributed,
          ad_platform: isAdAttributed ? detectWhatsAppAdPlatform(data) : null
        }
      })
    })

    const enrichedWhatsAppJourneyEvents = await enrichWhatsAppJourneyEventsWithMetaAds(whatsappJourneyEvents)
    addWhatsAppJourneyEvents(enrichedWhatsAppJourneyEvents)

    const metaSocialMessages = await db.all(
      `SELECT
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
          msg.referral_json,
          profile.profile_name,
          profile.username
       FROM meta_social_messages msg
       LEFT JOIN meta_social_contacts profile ON profile.id = msg.meta_social_contact_id
       WHERE msg.contact_id = ?
       ORDER BY COALESCE(msg.message_timestamp, msg.created_at) ASC`,
      [id]
    )

    metaSocialMessages.forEach(msg => {
      const platform = cleanString(msg.platform)
      const source = platform === 'instagram' ? 'Instagram DM' : 'Messenger'

      journey.push({
        type: 'meta_message',
        date: msg.message_timestamp || msg.created_at,
        data: {
          source,
          social_platform: platform,
          sender_id: msg.sender_id,
          recipient_id: msg.recipient_id,
          page_id: msg.page_id,
          instagram_account_id: msg.instagram_account_id,
          profile_name: msg.profile_name,
          username: msg.username,
          message_text: msg.message_text,
          message_type: msg.message_type,
          media_url: msg.media_url,
          media_mime_type: msg.media_mime_type,
          postback_payload: msg.postback_payload,
          referral_json: msg.referral_json,
          attribution_source: 'meta_social',
          meta_social_message_id: msg.meta_social_message_id,
          meta_message_id: msg.meta_message_id,
          direction: msg.direction || 'inbound',
          status: msg.status || null,
          transport: platform === 'instagram' ? 'instagram' : 'messenger'
        }
      })
    })

    // 3. Contacto creado
    const adAttributedWhatsAppEvent = enrichedWhatsAppJourneyEvents.find(event => event?.data?.is_ad_attributed)
    const resolvedContactAdFields = buildResolvedMetaAdFields(contact, null)

    journey.push({
      type: 'contact_created',
      date: contact.created_at,
      data: {
        name: contact.full_name,
        email: contact.email,
        phone: contact.phone,
        source: contact.source,
        attribution_ad_name: adAttributedWhatsAppEvent?.data?.attribution_ad_name || resolvedContactAdFields.ad_name,
        attribution_ad_id: adAttributedWhatsAppEvent?.data?.attribution_ad_id || resolvedContactAdFields.ad_id,
        campaign_id: adAttributedWhatsAppEvent?.data?.campaign_id || resolvedContactAdFields.campaign_id,
        campaign_name: adAttributedWhatsAppEvent?.data?.campaign_name || resolvedContactAdFields.campaign_name,
        adset_id: adAttributedWhatsAppEvent?.data?.adset_id || resolvedContactAdFields.adset_id,
        adset_name: adAttributedWhatsAppEvent?.data?.adset_name || resolvedContactAdFields.adset_name
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
             ORDER BY date_added ASC`,
            [id, ...calendarIds]
          )
        } else {
          // Sin calendarios configurados, usar todos
          appointments = await db.all(
            `SELECT * FROM appointments
             WHERE contact_id = ?
             ORDER BY date_added ASC`,
            [id]
          )
        }
      } catch (error) {
        logger.warn(`Error parseando calendarios de atribución: ${error.message}`)
        // Fallback: usar todos los calendarios
        appointments = await db.all(
          `SELECT * FROM appointments
           WHERE contact_id = ?
           ORDER BY date_added ASC`,
          [id]
        )
      }
    } else {
      // Sin configuración, usar todos los calendarios
      appointments = await db.all(
        `SELECT * FROM appointments
         WHERE contact_id = ?
         ORDER BY date_added ASC`,
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
       ORDER BY date ASC`,
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
    journey.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

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
