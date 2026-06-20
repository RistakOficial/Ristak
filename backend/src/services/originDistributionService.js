import { db } from '../config/database.js'
import { normalizeTrafficSource, normalizeWhatsAppAttributionPlatform } from '../utils/trafficSourceNormalizer.js'
import { formatPlacementName } from '../utils/placementName.js'
import { getHiddenContactFilters, buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js'

const toRanked = (bucketMap, limit = 10) =>
  Array.from(bucketMap.entries())
    .map(([name, visitorSet]) => ({ name, value: visitorSet.size }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)

const GENERIC_SOURCES = new Set(['Directo', 'Desconocido', 'Otro'])
const isPostgres = Boolean(process.env.DATABASE_URL)

const hasText = (value) => {
  if (value === null || value === undefined) return false
  const text = String(value).trim()
  return Boolean(text) && text !== 'null' && text !== 'undefined'
}

const resolveWhatsAppApiSource = (message = {}) => {
  const attributedPlatform = normalizeWhatsAppAttributionPlatform({
    referral_source_url: message.detected_source_url,
    referral_source_type: message.detected_source_type,
    referral_source_id: message.detected_source_id,
    referral_ctwa_clid: message.detected_ctwa_clid,
    referral_source_app: message.detected_source_app,
    referral_entry_point: message.detected_entry_point,
    attribution_url: message.attribution_url,
    source_url: message.attribution_url,
    source_type: message.attribution_medium,
    source_app: message.attribution_session_source,
    source_id: message.attribution_ad_id,
    ad_id: message.attribution_ad_id,
    ctwa_clid: message.attribution_ctwa_clid,
    source: message.contact_source || 'whatsapp_api'
  })

  if (attributedPlatform && !GENERIC_SOURCES.has(attributedPlatform)) {
    return attributedPlatform
  }

  const contactPlatform = normalizeTrafficSource({
    referrer_url: message.attribution_url,
    site_source_name: message.attribution_session_source,
    utm_source: message.attribution_medium,
    source: message.contact_source || 'whatsapp_api'
  })

  return contactPlatform && !GENERIC_SOURCES.has(contactPlatform)
    ? contactPlatform
    : 'WhatsApp'
}

const getWhatsAppApiIdentity = (message = {}) => {
  if (hasText(message.contact_id)) return `contact:${message.contact_id}`
  if (hasText(message.phone)) return `phone:${message.phone}`
  if (hasText(message.whatsapp_api_contact_id)) return `whatsapp-profile:${message.whatsapp_api_contact_id}`
  return `message:${message.id}`
}

const getWhatsAppApiIdentitySql = (alias = 'msg') => `
  CASE
    WHEN COALESCE(${alias}.contact_id, '') != '' THEN 'contact:' || ${alias}.contact_id
    WHEN COALESCE(${alias}.phone, '') != '' THEN 'phone:' || ${alias}.phone
    WHEN COALESCE(${alias}.whatsapp_api_contact_id, '') != '' THEN 'whatsapp-profile:' || ${alias}.whatsapp_api_contact_id
    ELSE 'message:' || ${alias}.id
  END
`

function whatsappTimestampExpression(column, timezone = 'UTC') {
  if (!isPostgres) {
    return `datetime(${column}, '-6 hours')`
  }

  const safeTimezone = String(timezone || 'UTC').replace(/'/g, "''")
  return `((${column})::timestamptz AT TIME ZONE '${safeTimezone}')`
}

function whatsappPeriodExpression(column, groupBy = 'day', timezone = 'UTC') {
  const localTimestamp = whatsappTimestampExpression(column, timezone)

  if (!isPostgres) {
    if (groupBy === 'year') return `strftime('%Y', ${localTimestamp})`
    if (groupBy === 'month') return `strftime('%Y-%m', ${localTimestamp})`
    return `strftime('%Y-%m-%d', ${localTimestamp})`
  }

  if (groupBy === 'year') return `TO_CHAR(${localTimestamp}, 'YYYY')`
  if (groupBy === 'month') return `TO_CHAR(${localTimestamp}, 'YYYY-MM')`
  return `TO_CHAR(${localTimestamp}, 'YYYY-MM-DD')`
}

async function getWhatsAppApiOriginMessages(range) {
  const hiddenFilters = await getHiddenContactFilters()
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)

  const conditions = [
    "LOWER(COALESCE(msg.direction, 'inbound')) = 'inbound'",
    'COALESCE(msg.message_timestamp, msg.created_at) >= ?',
    'COALESCE(msg.message_timestamp, msg.created_at) <= ?'
  ]

  if (hiddenCondition) {
    conditions.push(`(msg.contact_id IS NULL OR ${hiddenCondition})`)
  }

  return db.all(`
    SELECT
      msg.id,
      msg.whatsapp_api_contact_id,
      msg.contact_id,
      msg.phone,
      COALESCE(attr.detected_ctwa_clid, msg.detected_ctwa_clid) as detected_ctwa_clid,
      COALESCE(attr.detected_source_id, msg.detected_source_id) as detected_source_id,
      COALESCE(attr.detected_source_url, msg.detected_source_url) as detected_source_url,
      COALESCE(attr.detected_source_type, msg.detected_source_type) as detected_source_type,
      COALESCE(attr.detected_source_app, msg.detected_source_app) as detected_source_app,
      COALESCE(attr.detected_entry_point, msg.detected_entry_point) as detected_entry_point,
      c.source as contact_source,
      c.attribution_url,
      c.attribution_session_source,
      c.attribution_medium,
      c.attribution_ctwa_clid,
      c.attribution_ad_id
    FROM whatsapp_api_messages msg
    LEFT JOIN whatsapp_api_attribution attr ON attr.whatsapp_api_message_id = msg.id
    LEFT JOIN contacts c ON c.id = msg.contact_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY COALESCE(msg.message_timestamp, msg.created_at) ASC, msg.id ASC
  `, [range.startUtc, range.endUtc])
}

export async function getWhatsAppApiAnalyticsSummary(range, { groupBy = 'day' } = {}) {
  const normalizedGroupBy = ['day', 'month', 'year'].includes(groupBy) ? groupBy : 'day'
  const hiddenFilters = await getHiddenContactFilters()
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
  const timestampColumn = 'COALESCE(msg.message_timestamp, msg.created_at)'
  const baseConditions = [
    "LOWER(COALESCE(msg.direction, 'inbound')) = 'inbound'",
    `${timestampColumn} >= ?`,
    `${timestampColumn} <= ?`
  ]

  if (hiddenCondition) {
    baseConditions.push(`(msg.contact_id IS NULL OR ${hiddenCondition})`)
  }

  const messages = await getWhatsAppApiOriginMessages(range)
  const identities = new Set()
  const attributedIdentities = new Set()

  messages.forEach(message => {
    const identity = getWhatsAppApiIdentity(message)
    identities.add(identity)

    const source = resolveWhatsAppApiSource(message)
    if (source && source !== 'WhatsApp' && !GENERIC_SOURCES.has(source)) {
      attributedIdentities.add(identity)
    }
  })

  const periodExpr = whatsappPeriodExpression(timestampColumn, normalizedGroupBy, range.appliedTimezone)
  const trendRows = await db.all(`
    SELECT ${periodExpr} as label, COUNT(*) as messages
    FROM whatsapp_api_messages msg
    LEFT JOIN contacts c ON c.id = msg.contact_id
    WHERE ${baseConditions.join(' AND ')}
    GROUP BY label
    ORDER BY label ASC
  `, [range.startUtc, range.endUtc])

  const identityExpr = getWhatsAppApiIdentitySql('msg')
  const firstSeenConditions = ["LOWER(COALESCE(msg.direction, 'inbound')) = 'inbound'"]
  if (hiddenCondition) {
    firstSeenConditions.push(`(msg.contact_id IS NULL OR ${hiddenCondition})`)
  }

  const firstSeenRow = await db.get(`
    SELECT COUNT(*) as total
    FROM (
      SELECT ${identityExpr} as identity, MIN(${timestampColumn}) as first_seen_at
      FROM whatsapp_api_messages msg
      LEFT JOIN contacts c ON c.id = msg.contact_id
      WHERE ${firstSeenConditions.join(' AND ')}
      GROUP BY identity
    ) first_seen
    WHERE first_seen_at >= ? AND first_seen_at <= ?
  `, [range.startUtc, range.endUtc])

  const phoneRows = await db.get('SELECT COUNT(*) as total FROM whatsapp_api_phone_numbers').catch(() => ({ total: 0 }))

  const inboundMessages = messages.length
  const conversations = identities.size
  const attributedConversations = attributedIdentities.size

  return {
    metrics: {
      inboundMessages,
      conversations,
      contacts: Number(firstSeenRow?.total || 0),
      attributionRate: conversations > 0 ? Number(((attributedConversations / conversations) * 100).toFixed(1)) : 0
    },
    trend: trendRows.map(row => ({
      label: row.label,
      messages: Number(row.messages || 0)
    })),
    status: {
      connected: Number(phoneRows?.total || 0) > 0,
      hasData: inboundMessages > 0
    }
  }
}

/**
 * Distribución de tráfico (sesiones web) por las 6 dimensiones del dropdown derecho.
 * Cuenta visitantes únicos por bucket, igual que la página de Analíticas
 * (Analytics.tsx ~1153-1282). Un visitante puede caer en varios buckets si tuvo
 * sesiones con distinta fuente/dispositivo/etc.
 * @param {{ startUtc: string, endUtc: string }} range
 * @returns {Promise<{ sources, platforms, devices, placements, browsers, os }>}
 */
export async function getTrafficDistributions(range, { includeWeb = true, includeWhatsapp = true } = {}) {
  const sessions = includeWeb
    ? await db.all(`
      SELECT visitor_id, referrer_url, site_source_name, utm_source, source_platform,
             device_type, browser, os, placement
      FROM sessions
      WHERE started_at >= ? AND started_at <= ?
        AND visitor_id IS NOT NULL AND visitor_id != ''
    `, [range.startUtc, range.endUtc])
    : []

  const sources = new Map()
  const platforms = new Map()
  const devices = new Map()
  const placements = new Map()
  const browsers = new Map()
  const operatingSystems = new Map()

  const add = (map, key, visitorId) => {
    if (!map.has(key)) map.set(key, new Set())
    map.get(key).add(visitorId)
  }

  sessions.forEach(session => {
    const visitorId = session.visitor_id
    // Fuentes y Plataformas usan exactamente la misma normalización en Analíticas.
    const sourceName = normalizeTrafficSource({
      referrer_url: session.referrer_url,
      site_source_name: session.site_source_name,
      utm_source: session.utm_source,
      source_platform: session.source_platform
    })

    add(sources, sourceName, visitorId)
    add(platforms, sourceName, visitorId)
    add(devices, session.device_type || 'Desconocido', visitorId)
    add(browsers, session.browser || 'Desconocido', visitorId)
    add(operatingSystems, session.os || 'Desconocido', visitorId)
    add(placements, formatPlacementName(session.placement || 'Sin ubicación'), visitorId)
  })

  if (includeWhatsapp) {
    const whatsappMessages = await getWhatsAppApiOriginMessages(range)
    const seenWhatsappIdentities = new Set()

    whatsappMessages.forEach(message => {
      const identity = getWhatsAppApiIdentity(message)
      if (seenWhatsappIdentities.has(identity)) return
      seenWhatsappIdentities.add(identity)

      const sourceName = resolveWhatsAppApiSource(message)
      add(sources, sourceName, `whatsapp:${identity}`)
      add(platforms, sourceName, `whatsapp:${identity}`)
    })
  }

  return {
    sources: toRanked(sources),
    platforms: toRanked(platforms),
    devices: toRanked(devices),
    placements: toRanked(placements),
    browsers: toRanked(browsers),
    os: toRanked(operatingSystems)
  }
}

export async function getTrafficSourceBreakdown(range, options = {}) {
  const distributions = await getTrafficDistributions(range, options)
  return distributions.sources
}

export async function getWhatsAppApiSourceBreakdown(range, { limit = 10 } = {}) {
  const whatsappMessages = await getWhatsAppApiOriginMessages(range)
  const sources = new Map()
  const seenWhatsappIdentities = new Set()

  const add = (map, key, visitorId) => {
    if (!map.has(key)) map.set(key, new Set())
    map.get(key).add(visitorId)
  }

  whatsappMessages.forEach(message => {
    const identity = getWhatsAppApiIdentity(message)
    if (seenWhatsappIdentities.has(identity)) return
    seenWhatsappIdentities.add(identity)

    add(sources, resolveWhatsAppApiSource(message), `whatsapp:${identity}`)
  })

  return toRanked(sources, limit)
}

export async function getWhatsAppApiNumberBreakdown(range, { limit = 10 } = {}) {
  const hiddenFilters = await getHiddenContactFilters()
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)

  const conditions = [
    "LOWER(COALESCE(msg.direction, 'inbound')) = 'inbound'",
    'COALESCE(msg.message_timestamp, msg.created_at) >= ?',
    'COALESCE(msg.message_timestamp, msg.created_at) <= ?',
    `(
      COALESCE(msg.business_phone_number_id, '') != ''
      OR COALESCE(msg.business_phone, '') != ''
      OR COALESCE(phone.phone_number, '') != ''
      OR COALESCE(phone.display_phone_number, '') != ''
    )`
  ]

  if (hiddenCondition) {
    conditions.push(`(msg.contact_id IS NULL OR ${hiddenCondition})`)
  }

  const rows = await db.all(`
    SELECT
      msg.id,
      msg.whatsapp_api_contact_id,
      msg.contact_id,
      msg.phone,
      msg.business_phone_number_id,
      msg.business_phone,
      phone.phone_number,
      phone.display_phone_number,
      phone.verified_name,
      phone.label,
      phone.status,
      phone.api_send_enabled,
      phone.qr_send_enabled,
      phone.qr_status
    FROM whatsapp_api_messages msg
    LEFT JOIN whatsapp_api_phone_numbers phone ON phone.id = msg.business_phone_number_id
    LEFT JOIN contacts c ON c.id = msg.contact_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY COALESCE(msg.message_timestamp, msg.created_at) ASC, msg.id ASC
  `, [range.startUtc, range.endUtc])

  const buckets = new Map()

  rows.forEach(row => {
    const phoneKey = cleanBusinessPhoneKey(row)
    if (!phoneKey) return

    const label = (
      hasText(row.label) ? String(row.label).trim() :
      hasText(row.verified_name) ? String(row.verified_name).trim() :
      hasText(row.display_phone_number) ? String(row.display_phone_number).trim() :
      hasText(row.business_phone) ? String(row.business_phone).trim() :
      hasText(row.phone_number) ? String(row.phone_number).trim() :
      'Número sin nombre'
    )

    if (!buckets.has(phoneKey)) {
      buckets.set(phoneKey, {
        name: label,
        phoneNumberId: row.business_phone_number_id || null,
        phoneNumber: row.phone_number || row.business_phone || null,
        displayPhoneNumber: row.display_phone_number || row.business_phone || row.phone_number || null,
        status: row.status || row.qr_status || null,
        apiSendEnabled: Boolean(Number(row.api_send_enabled || 0)),
        qrSendEnabled: Boolean(Number(row.qr_send_enabled || 0)),
        identities: new Set()
      })
    }

    buckets.get(phoneKey).identities.add(getWhatsAppApiIdentity(row))
  })

  return Array.from(buckets.values())
    .map(bucket => ({
      name: bucket.name,
      value: bucket.identities.size,
      phoneNumberId: bucket.phoneNumberId,
      phoneNumber: bucket.phoneNumber,
      displayPhoneNumber: bucket.displayPhoneNumber,
      status: bucket.status,
      apiSendEnabled: bucket.apiSendEnabled,
      qrSendEnabled: bucket.qrSendEnabled
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
}

function cleanBusinessPhoneKey(row = {}) {
  const candidates = [
    row.business_phone_number_id,
    row.business_phone,
    row.phone_number,
    row.display_phone_number
  ]

  const candidate = candidates.find(hasText)
  return candidate ? String(candidate).trim() : ''
}

/**
 * IDs de contactos creados dentro del rango (leads/prospectos), excluyendo ocultos.
 * @param {{ startUtc: string, endUtc: string }} range
 * @returns {Promise<string[]>}
 */
export async function getLeadsContactIds(range) {
  const hiddenFilters = await getHiddenContactFilters()
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false)

  const conditions = ['created_at >= ?', 'created_at <= ?']
  if (hiddenCondition) conditions.push(hiddenCondition)

  const rows = await db.all(`
    SELECT id FROM contacts WHERE ${conditions.join(' AND ')}
  `, [range.startUtc, range.endUtc])

  return rows.map(row => row.id)
}
