import { db } from '../config/database.js'
import { DateTime } from 'luxon'
import { sqliteTimezoneOffsetClause } from '../utils/dateUtils.js'
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
const MESSAGE_CHANNEL_LABELS = {
  whatsapp: 'WhatsApp',
  messenger: 'Messenger',
  instagram: 'Instagram DM',
  email: 'Email'
}

const hasText = (value) => {
  if (value === null || value === undefined) return false
  const text = String(value).trim()
  return Boolean(text) && text !== 'null' && text !== 'undefined'
}

const parseJsonSafe = (value, fallback = null) => {
  if (!hasText(value)) return fallback
  if (typeof value === 'object') return value

  try {
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

const normalizeMessageChannel = (value, fallback = 'whatsapp') => {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized.includes('instagram') || normalized === 'ig') return 'instagram'
  if (normalized.includes('messenger') || normalized === 'facebook' || normalized === 'fb') return 'messenger'
  if (normalized.includes('email') || normalized.includes('correo') || normalized.includes('smtp')) return 'email'
  if (normalized.includes('whatsapp') || normalized === 'wa' || normalized.includes('ycloud')) return 'whatsapp'
  return fallback
}

const getMessageChannelLabel = (channel) =>
  MESSAGE_CHANNEL_LABELS[normalizeMessageChannel(channel)] || 'Mensajes'

const getMetaMessageIdentity = (message = {}) => {
  if (hasText(message.contact_id)) return `contact:${message.contact_id}`
  if (hasText(message.sender_id)) return `meta:${normalizeMessageChannel(message.platform, 'messenger')}:${message.sender_id}`
  if (hasText(message.meta_social_contact_id)) return `meta-profile:${message.meta_social_contact_id}`
  return `message:${message.id}`
}

const getEmailMessageIdentity = (message = {}) => {
  if (hasText(message.contact_id)) return `contact:${message.contact_id}`
  if (hasText(message.from_email)) return `email:${String(message.from_email).trim().toLowerCase()}`
  return `message:${message.id}`
}

const getMetaMessageIdentitySql = (alias = 'msg') => `
  CASE
    WHEN COALESCE(${alias}.contact_id, '') != '' THEN 'contact:' || ${alias}.contact_id
    WHEN COALESCE(${alias}.sender_id, '') != '' THEN 'meta:' || COALESCE(${alias}.platform, 'messenger') || ':' || ${alias}.sender_id
    WHEN COALESCE(${alias}.meta_social_contact_id, '') != '' THEN 'meta-profile:' || ${alias}.meta_social_contact_id
    ELSE 'message:' || ${alias}.id
  END
`

const getEmailMessageIdentitySql = (alias = 'msg') => `
  CASE
    WHEN COALESCE(${alias}.contact_id, '') != '' THEN 'contact:' || ${alias}.contact_id
    WHEN COALESCE(${alias}.from_email, '') != '' THEN 'email:' || LOWER(${alias}.from_email)
    ELSE 'message:' || ${alias}.id
  END
`

function readNestedValue(source, paths = []) {
  for (const path of paths) {
    const value = path.reduce((current, key) => (
      current && typeof current === 'object' ? current[key] : undefined
    ), source)
    if (hasText(value)) return value
  }
  return null
}

function resolveMetaSurface(value) {
  if (!hasText(value)) return null
  const normalized = String(value).trim().toLowerCase()
  if (normalized.includes('instagram') || normalized === 'ig') return 'Instagram'
  if (normalized.includes('messenger') || normalized.includes('m.me')) return 'Messenger'
  if (normalized.includes('facebook') || normalized === 'fb') return 'Facebook'
  if (normalized.includes('audience_network') || normalized.includes('audience network')) return 'Audience Network'
  return null
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

const resolveMetaMessageSource = (message = {}) => {
  const channel = normalizeMessageChannel(message.platform, 'messenger')
  const channelLabel = getMessageChannelLabel(channel)
  const referral = parseJsonSafe(message.referral_json, {})
  const referralSourceUrl = readNestedValue(referral, [
    ['referral_url'],
    ['referer_uri'],
    ['source_url'],
    ['ads_context_data', 'source_url']
  ])
  const referralSourceId = readNestedValue(referral, [
    ['source_id'],
    ['ad_id'],
    ['ads_context_data', 'ad_id'],
    ['ads_context_data', 'source_id']
  ])
  const referralSourceType = readNestedValue(referral, [
    ['source'],
    ['type'],
    ['ads_context_data', 'source']
  ])
  const referralSourceApp = readNestedValue(referral, [
    ['source_app'],
    ['sourceApp'],
    ['entry_point'],
    ['entryPoint'],
    ['ads_context_data', 'source_app'],
    ['ads_context_data', 'entry_point']
  ])
  const referralPlatform = readNestedValue(referral, [
    ['platform'],
    ['publisher_platform'],
    ['source_platform'],
    ['ads_context_data', 'platform'],
    ['ads_context_data', 'publisher_platform'],
    ['ads_context_data', 'source_platform']
  ])
  const explicitSurface = [
    referralSourceUrl,
    referralSourceApp,
    referralPlatform,
    message.platform
  ].map(resolveMetaSurface).find(Boolean)

  if (explicitSurface) {
    return explicitSurface
  }

  const attributedPlatform = normalizeWhatsAppAttributionPlatform({
    referral_source_url: referralSourceUrl,
    referral_source_type: referralSourceType,
    referral_source_id: referralSourceId,
    referral_source_app: referralSourceApp,
    source_app: referralSourceApp,
    source_platform: referralPlatform,
    source: referralPlatform || referralSourceType
  })

  if (attributedPlatform && !GENERIC_SOURCES.has(attributedPlatform) && attributedPlatform !== 'WhatsApp') {
    return attributedPlatform
  }

  if (hasText(referralSourceId) || String(referralSourceType || '').toLowerCase().includes('ad')) {
    return 'Meta Ads'
  }

  return channelLabel
}

const resolveEmailMessageSource = () => 'Email'

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
    return `datetime(${column}, ${sqliteTimezoneOffsetClause(timezone)})`
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
      COALESCE(msg.message_timestamp, msg.created_at) as message_timestamp,
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

function parseMessageDateTime(value) {
  if (!hasText(value)) return null

  const text = String(value).trim()
  let parsed = DateTime.fromISO(text, { zone: 'utc' })
  if (!parsed.isValid) parsed = DateTime.fromSQL(text, { zone: 'utc' })
  if (!parsed.isValid) parsed = DateTime.fromJSDate(new Date(text), { zone: 'utc' })

  return parsed.isValid ? parsed : null
}

function formatMessagePeriod(value, groupBy = 'day', timezone = 'UTC') {
  const parsed = parseMessageDateTime(value)
  if (!parsed) return null

  const zoned = parsed.setZone(timezone || 'UTC')
  if (!zoned.isValid) return null
  if (groupBy === 'year') return zoned.toFormat('yyyy')
  if (groupBy === 'month') return zoned.toFormat('yyyy-MM')
  return zoned.toFormat('yyyy-MM-dd')
}

function normalizeMessageFilters(filters = {}) {
  const normalizeList = (value) => {
    if (Array.isArray(value)) {
      return value.map(item => String(item || '').trim()).filter(Boolean)
    }
    if (!hasText(value)) return []
    return String(value)
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  }

  return {
    channels: normalizeList(filters.channels).map(channel => normalizeMessageChannel(channel)),
    sources: normalizeList(filters.sources)
  }
}

function applyMessageFilters(messages, rawFilters = {}) {
  const filters = normalizeMessageFilters(rawFilters)
  const selectedChannels = new Set(filters.channels)
  const selectedSources = new Set(filters.sources.map(source => source.toLowerCase()))

  return messages.filter(message => {
    if (selectedChannels.size > 0 && !selectedChannels.has(message.channel)) return false
    if (selectedSources.size > 0 && !selectedSources.has(String(message.source || '').toLowerCase())) return false
    return true
  })
}

function toMessageFilterOptions(messages) {
  const channels = new Map()
  const sources = new Map()

  const add = (map, key, label, identity) => {
    if (!hasText(key) || !hasText(label)) return
    if (!map.has(key)) {
      map.set(key, { name: label, value: key, identities: new Set() })
    }
    map.get(key).identities.add(identity)
  }

  messages.forEach(message => {
    add(channels, message.channel, message.channelLabel, message.identity)
    add(sources, message.source, message.source, message.identity)
  })

  const format = (map) => Array.from(map.values())
    .map(item => ({ name: item.name, value: item.value, count: item.identities.size }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  return {
    channels: format(channels),
    sources: format(sources)
  }
}

async function getMetaMessageRows(range) {
  const hiddenFilters = await getHiddenContactFilters()
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
  const timestampColumn = 'COALESCE(msg.message_timestamp, msg.created_at)'
  const conditions = [
    "LOWER(COALESCE(msg.direction, 'inbound')) = 'inbound'",
    `${timestampColumn} >= ?`,
    `${timestampColumn} <= ?`
  ]

  if (hiddenCondition) {
    conditions.push(`(msg.contact_id IS NULL OR ${hiddenCondition})`)
  }

  return db.all(`
    SELECT
      msg.id,
      msg.platform,
      msg.meta_social_contact_id,
      msg.contact_id,
      msg.sender_id,
      msg.referral_json,
      ${timestampColumn} as message_timestamp
    FROM meta_social_messages msg
    LEFT JOIN contacts c ON c.id = msg.contact_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${timestampColumn} ASC, msg.id ASC
  `, [range.startUtc, range.endUtc]).catch(() => [])
}

async function getEmailMessageRows(range) {
  const hiddenFilters = await getHiddenContactFilters()
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
  const timestampColumn = 'COALESCE(msg.message_timestamp, msg.created_at)'
  const conditions = [
    "LOWER(COALESCE(msg.direction, 'outbound')) = 'inbound'",
    `${timestampColumn} >= ?`,
    `${timestampColumn} <= ?`
  ]

  if (hiddenCondition) {
    conditions.push(`(msg.contact_id IS NULL OR ${hiddenCondition})`)
  }

  return db.all(`
    SELECT
      msg.id,
      msg.contact_id,
      msg.from_email,
      ${timestampColumn} as message_timestamp
    FROM email_messages msg
    LEFT JOIN contacts c ON c.id = msg.contact_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${timestampColumn} ASC, msg.id ASC
  `, [range.startUtc, range.endUtc]).catch(() => [])
}

async function getMessageAnalyticsRows(range) {
  const [whatsappMessages, metaMessages, emailMessages] = await Promise.all([
    getWhatsAppApiOriginMessages(range).catch(() => []),
    getMetaMessageRows(range),
    getEmailMessageRows(range)
  ])

  const rows = []

  whatsappMessages.forEach(message => {
    const identity = getWhatsAppApiIdentity(message)
    const source = resolveWhatsAppApiSource(message)
    rows.push({
      id: `whatsapp:${message.id}`,
      channel: 'whatsapp',
      channelLabel: 'WhatsApp',
      source,
      identity,
      timestamp: message.message_timestamp,
      attributed: source && source !== 'WhatsApp' && !GENERIC_SOURCES.has(source)
    })
  })

  metaMessages.forEach(message => {
    const channel = normalizeMessageChannel(message.platform, 'messenger')
    const source = resolveMetaMessageSource(message)
    rows.push({
      id: `meta:${message.id}`,
      channel,
      channelLabel: getMessageChannelLabel(channel),
      source,
      identity: getMetaMessageIdentity(message),
      timestamp: message.message_timestamp,
      attributed: source === 'Meta Ads'
    })
  })

  emailMessages.forEach(message => {
    const source = resolveEmailMessageSource(message)
    rows.push({
      id: `email:${message.id}`,
      channel: 'email',
      channelLabel: 'Email',
      source,
      identity: getEmailMessageIdentity(message),
      timestamp: message.message_timestamp,
      attributed: false
    })
  })

  return rows
}

async function getMessageFirstSeenCount(range) {
  const hiddenFilters = await getHiddenContactFilters()
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
  const hiddenSql = hiddenCondition ? `AND (msg.contact_id IS NULL OR ${hiddenCondition})` : ''
  const whatsappTimestamp = 'COALESCE(msg.message_timestamp, msg.created_at)'
  const metaTimestamp = 'COALESCE(msg.message_timestamp, msg.created_at)'
  const emailTimestamp = 'COALESCE(msg.message_timestamp, msg.created_at)'

  const row = await db.get(`
    SELECT COUNT(*) as total
    FROM (
      SELECT identity, MIN(first_seen_at) as first_seen_at
      FROM (
        SELECT ${getWhatsAppApiIdentitySql('msg')} as identity, MIN(${whatsappTimestamp}) as first_seen_at
        FROM whatsapp_api_messages msg
        LEFT JOIN contacts c ON c.id = msg.contact_id
        WHERE LOWER(COALESCE(msg.direction, 'inbound')) = 'inbound'
          ${hiddenSql}
        GROUP BY identity

        UNION ALL

        SELECT ${getMetaMessageIdentitySql('msg')} as identity, MIN(${metaTimestamp}) as first_seen_at
        FROM meta_social_messages msg
        LEFT JOIN contacts c ON c.id = msg.contact_id
        WHERE LOWER(COALESCE(msg.direction, 'inbound')) = 'inbound'
          ${hiddenSql}
        GROUP BY identity

        UNION ALL

        SELECT ${getEmailMessageIdentitySql('msg')} as identity, MIN(${emailTimestamp}) as first_seen_at
        FROM email_messages msg
        LEFT JOIN contacts c ON c.id = msg.contact_id
        WHERE LOWER(COALESCE(msg.direction, 'outbound')) = 'inbound'
          ${hiddenSql}
        GROUP BY identity
      ) all_first_seen
      GROUP BY identity
    ) first_seen
    WHERE first_seen_at >= ? AND first_seen_at <= ?
  `, [range.startUtc, range.endUtc]).catch(() => ({ total: 0 }))

  return Number(row?.total || 0)
}

async function getMessageConnectionStatus() {
  const [phoneRows, metaConfig, metaContactRows, emailConfigRow] = await Promise.all([
    db.get('SELECT COUNT(*) as total FROM whatsapp_api_phone_numbers').catch(() => ({ total: 0 })),
    db.get('SELECT page_id, instagram_account_id FROM meta_config LIMIT 1').catch(() => null),
    db.get('SELECT COUNT(*) as total FROM meta_social_contacts').catch(() => ({ total: 0 })),
    db.get("SELECT config_value FROM app_config WHERE config_key = 'email_smtp_config'").catch(() => null)
  ])

  const emailConfig = parseJsonSafe(emailConfigRow?.config_value, {})
  return {
    whatsapp: Number(phoneRows?.total || 0) > 0,
    messenger: hasText(metaConfig?.page_id) || Number(metaContactRows?.total || 0) > 0,
    instagram: hasText(metaConfig?.instagram_account_id) || Number(metaContactRows?.total || 0) > 0,
    email: Boolean(emailConfig?.connected)
  }
}

export async function getMessageAnalyticsSummary(range, { groupBy = 'day', filters = {} } = {}) {
  const normalizedGroupBy = ['day', 'month', 'year'].includes(groupBy) ? groupBy : 'day'
  const normalizedFilters = normalizeMessageFilters(filters)
  const hasActiveFilters = normalizedFilters.channels.length > 0 || normalizedFilters.sources.length > 0
  const allMessages = await getMessageAnalyticsRows(range)
  const filteredMessages = applyMessageFilters(allMessages, normalizedFilters)
  const identities = new Set()
  const attributedIdentities = new Set()
  const trendMap = new Map()

  filteredMessages.forEach(message => {
    identities.add(message.identity)
    if (message.attributed) attributedIdentities.add(message.identity)

    const period = formatMessagePeriod(message.timestamp, normalizedGroupBy, range.appliedTimezone)
    if (!period) return
    trendMap.set(period, (trendMap.get(period) || 0) + 1)
  })

  const connectionStatus = await getMessageConnectionStatus()
  const connected = Object.values(connectionStatus).some(Boolean)
  const firstSeenCount = hasActiveFilters ? identities.size : await getMessageFirstSeenCount(range)

  return {
    metrics: {
      inboundMessages: filteredMessages.length,
      conversations: identities.size,
      contacts: firstSeenCount,
      attributionRate: identities.size > 0 ? Number(((attributedIdentities.size / identities.size) * 100).toFixed(1)) : 0
    },
    trend: Array.from(trendMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, messages]) => ({ label, messages })),
    filters: toMessageFilterOptions(allMessages),
    status: {
      connected,
      hasData: allMessages.length > 0,
      channels: connectionStatus
    }
  }
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
