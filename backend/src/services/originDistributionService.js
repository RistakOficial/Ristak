import { databaseDialect, db } from '../config/database.js'
import { getMetaSocialConfig } from './metaAdsService.js'
import { sqliteTimezoneOffsetClause } from '../utils/dateUtils.js'
import { formatPlacementName } from '../utils/placementName.js'
import { getHiddenContactFilters, buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js'
import { buildNormalizedTrafficSourceSql } from './contactSourceService.js'
import { getProjectedMessageFirstSeenCount } from './messageFirstSeenProjectionService.js'
import { queryMessageAnalyticsProjectionAggregateRows } from './messageAnalyticsProjectionService.js'

const toRanked = (bucketMap, limit = 10) =>
  Array.from(bucketMap.entries())
    .map(([name, visitorSet]) => ({ name, value: visitorSet.size }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)

const isPostgres = databaseDialect === 'postgres'
const TRAFFIC_DISTRIBUTION_DIMENSIONS = new Set([
  'sources',
  'platforms',
  'devices',
  'placements',
  'browsers',
  'os'
])

const fallbackUnlessAborted = (fallback, signal) => (error) => {
  if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error
  return fallback
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

const getWhatsAppApiIdentitySql = (alias = 'msg') => `
  CASE
    WHEN COALESCE(${alias}.contact_id, '') != '' THEN 'contact:' || ${alias}.contact_id
    WHEN COALESCE(${alias}.phone, '') != '' THEN 'phone:' || ${alias}.phone
    WHEN COALESCE(${alias}.whatsapp_api_contact_id, '') != '' THEN 'whatsapp-profile:' || ${alias}.whatsapp_api_contact_id
    ELSE 'message:' || ${alias}.id
  END
`

function lowerMessageSignalSql(expressions = []) {
  return `LOWER(${expressions.map(expression => `COALESCE(${expression}, '')`).join(" || ' ' || ")})`
}

/**
 * Normalización SQL de la atribución de WhatsApp. Mantener esta decisión en la
 * base evita materializar todos los mensajes en Node para construir cuatro
 * tarjetas y dos filtros.
 */
function getWhatsAppMessageSourceSql(messageAlias = 'msg', attributionAlias = 'attr', contactAlias = 'c') {
  const signal = lowerMessageSignalSql([
    `COALESCE(${attributionAlias}.detected_source_url, ${messageAlias}.detected_source_url)`,
    `COALESCE(${attributionAlias}.detected_source_app, ${messageAlias}.detected_source_app)`,
    `COALESCE(${attributionAlias}.detected_entry_point, ${messageAlias}.detected_entry_point)`,
    `COALESCE(${attributionAlias}.detected_source_type, ${messageAlias}.detected_source_type)`,
    `${contactAlias}.attribution_url`,
    `${contactAlias}.attribution_session_source`,
    `${contactAlias}.attribution_medium`,
    `${contactAlias}.source`
  ])
  const attributedId = `COALESCE(
    NULLIF(${attributionAlias}.detected_source_id, ''),
    NULLIF(${messageAlias}.detected_source_id, ''),
    NULLIF(${attributionAlias}.detected_ctwa_clid, ''),
    NULLIF(${messageAlias}.detected_ctwa_clid, ''),
    NULLIF(${contactAlias}.attribution_ad_id, ''),
    NULLIF(${contactAlias}.attribution_ctwa_clid, '')
  )`

  return `CASE
    WHEN ${signal} LIKE '%instagram%' OR ${signal} LIKE '%ig.com%' THEN 'Instagram'
    WHEN ${signal} LIKE '%facebook%' OR ${signal} LIKE '%fb.com%' OR ${signal} LIKE '%m.me%' OR ${signal} LIKE '%messenger%' THEN 'Facebook'
    WHEN ${signal} LIKE '%tiktok%' OR ${signal} LIKE '%ttclid%' THEN 'TikTok'
    WHEN ${signal} LIKE '%youtube%' OR ${signal} LIKE '%youtu.be%' THEN 'YouTube'
    WHEN ${signal} LIKE '%google%' OR ${signal} LIKE '%adwords%' OR ${signal} LIKE '%gclid%' THEN 'Google'
    WHEN ${signal} LIKE '%bing%' OR ${signal} LIKE '%microsoft%' OR ${signal} LIKE '%msclkid%' THEN 'Bing'
    WHEN ${signal} LIKE '%linkedin%' OR ${signal} LIKE '%lnkd%' THEN 'LinkedIn'
    WHEN ${signal} LIKE '%snapchat%' THEN 'Snapchat'
    WHEN ${signal} LIKE '%pinterest%' OR ${signal} LIKE '%pin.it%' THEN 'Pinterest'
    WHEN ${signal} LIKE '%reddit%' OR ${signal} LIKE '%redd.it%' THEN 'Reddit'
    WHEN ${signal} LIKE '%twitter%' OR ${signal} LIKE '%x.com%' OR ${signal} LIKE '%twclid%' THEN 'Twitter'
    WHEN ${signal} LIKE '%telegram%' OR ${signal} LIKE '%t.me%' THEN 'Telegram'
    WHEN ${signal} LIKE '%email%' OR ${signal} LIKE '%newsletter%' THEN 'Email'
    WHEN ${attributedId} IS NOT NULL THEN 'Meta Ads'
    ELSE 'WhatsApp'
  END`
}

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

async function getMessageFirstSeenCount(range, providedHiddenFilters = null, signal) {
  const hiddenFilters = providedHiddenFilters || await getHiddenContactFilters({ signal })
  return getProjectedMessageFirstSeenCount(range, {
    hiddenFilters,
    signal,
    withStatus: true
  })
}

async function getWhatsAppFirstSeenCount(range, hiddenFilters) {
  return getProjectedMessageFirstSeenCount(range, {
    sourceKind: 'whatsapp',
    hiddenFilters,
    withStatus: true
  })
}

async function getMessageConnectionStatus(signal) {
  // Los tres estados locales comparten una sola ida a la base. La configuracion
  // Meta conserva su contrato de merge/decryption, pero se lee despues para no
  // volver al burst de cuatro conexiones que competia con el agregado pesado.
  const localStatus = await db.get(
    `SELECT
      EXISTS(SELECT 1 FROM whatsapp_api_phone_numbers LIMIT 1) AS whatsapp_connected,
      EXISTS(SELECT 1 FROM meta_social_contacts LIMIT 1) AS meta_contact_connected,
      (SELECT config_value
       FROM app_config
       WHERE config_key = 'email_smtp_config'
       LIMIT 1) AS email_config_value`,
    [],
    { signal }
  ).catch(fallbackUnlessAborted({
    whatsapp_connected: false,
    meta_contact_connected: false,
    email_config_value: null
  }, signal))
  const metaConfig = await getMetaSocialConfig({ migratePlaintext: false })
    .catch(fallbackUnlessAborted(null, signal))

  const emailConfig = parseJsonSafe(localStatus?.email_config_value, {})
  return {
    whatsapp: localStatus?.whatsapp_connected === true || Number(localStatus?.whatsapp_connected || 0) === 1,
    messenger: hasText(metaConfig?.page_id) || localStatus?.meta_contact_connected === true || Number(localStatus?.meta_contact_connected || 0) === 1,
    instagram: hasText(metaConfig?.instagram_account_id) || localStatus?.meta_contact_connected === true || Number(localStatus?.meta_contact_connected || 0) === 1,
    email: Boolean(emailConfig?.connected)
  }
}

export async function getMessageAnalyticsSummary(range, { groupBy = 'day', filters = {}, signal } = {}) {
  const normalizedGroupBy = ['day', 'month', 'year'].includes(groupBy) ? groupBy : 'day'
  const normalizedFilters = normalizeMessageFilters(filters)
  const hasActiveFilters = normalizedFilters.channels.length > 0 || normalizedFilters.sources.length > 0
  const hiddenFilters = await getHiddenContactFilters({ signal })
  // Mantener el mismo payload sin abrir hasta seis conexiones a la vez. El
  // agregado es la parte dominante; los snapshots auxiliares se leen después.
  const projected = await queryMessageAnalyticsProjectionAggregateRows(range, {
    groupBy: normalizedGroupBy,
    filters: normalizedFilters,
    hiddenFilters,
    signal,
    schedule: false
  })
  // Schema ausente o warming falla desde la proyeccion con 503. No existe un
  // fallback a los tres historiales: proteger la base es parte del contrato.
  const aggregateRows = projected.rows
  // El agregado ya termino antes de abrir auxiliares. A partir de aqui solo hay
  // dos tareas acotadas: estado de conexiones y first-seen; asi recuperamos una
  // ola completa de latencia sin competir con el scan principal.
  const [connectionStatus, firstSeenCount] = await Promise.all([
    getMessageConnectionStatus(signal),
    hasActiveFilters
      ? Promise.resolve({ count: null, projectionReady: true, projectionStatus: 'filtered' })
      : getMessageFirstSeenCount(range, hiddenFilters, signal)
  ])
  const metricsRow = aggregateRows.find(row => row.row_type === 'metrics') || {}
  const inboundMessages = Number(metricsRow.count_value || 0)
  const conversations = Number(metricsRow.secondary_value || 0)
  const attributedConversations = Number(metricsRow.tertiary_value || 0)
  const allMessages = Number(metricsRow.all_messages_value || 0)
  const connected = Object.values(connectionStatus).some(Boolean)
  const toFilterOption = row => ({
    name: String(row.label || row.value || ''),
    value: String(row.value || ''),
    count: Number(row.count_value || 0)
  })
  const sortFilterOptions = (a, b) => b.count - a.count || a.name.localeCompare(b.name)

  return {
    metrics: {
      inboundMessages,
      conversations,
      contacts: hasActiveFilters || firstSeenCount?.projectionStatus === 'unavailable'
        ? Math.max(conversations, Number(firstSeenCount?.count || 0))
        : Number(firstSeenCount?.count || 0),
      attributionRate: conversations > 0
        ? Number(((attributedConversations / conversations) * 100).toFixed(1))
        : 0
    },
    trend: aggregateRows
      .filter(row => row.row_type === 'trend')
      .map(row => ({ label: String(row.label || ''), messages: Number(row.count_value || 0) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    filters: {
      channels: aggregateRows
        .filter(row => row.row_type === 'channel_filter')
        .map(toFilterOption)
        .sort(sortFilterOptions),
      sources: aggregateRows
        .filter(row => row.row_type === 'source_filter')
        .map(toFilterOption)
        .sort(sortFilterOptions)
    },
    status: {
      connected,
      hasData: allMessages > 0,
      channels: connectionStatus,
      messageProjection: projected.status.status,
      messageProjectionComplete: Boolean(projected.status.ready),
      messageProjectionReadPath: projected.status.readPath || 'message_analytics_projection',
      messageProjectionGeneration: projected.status.activeGeneration || null,
      messageProjectionPending: Boolean(projected.status.pending),
      firstSeenProjection: firstSeenCount?.projectionStatus || 'unavailable',
      firstSeenProjectionComplete: Boolean(firstSeenCount?.projectionReady)
    },
    performance: {
      readPath: projected.status.readPath || 'message_analytics_projection',
      activeGeneration: projected.status.activeGeneration || null,
      pending: Boolean(projected.status.pending)
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

  const periodExpr = whatsappPeriodExpression(timestampColumn, normalizedGroupBy, range.appliedTimezone)
  const identityExpr = getWhatsAppApiIdentitySql('msg')
  const sourceExpr = getWhatsAppMessageSourceSql('msg', 'attr', 'c')
  // Este endpoint se conserva por compatibilidad, pero jamás debe descargar el
  // historial crudo. Las cuatro métricas tienen cardinalidad fija y se calculan
  // dentro de la base aunque el periodo contenga millones de mensajes.
  const aggregateRow = await db.get(`
      SELECT
        COUNT(*) AS inbound_messages,
        COUNT(DISTINCT ${identityExpr}) AS conversations,
        COUNT(DISTINCT CASE
          WHEN ${sourceExpr} NOT IN ('WhatsApp', 'Directo', 'Desconocido', 'Otro')
            THEN ${identityExpr}
          ELSE NULL
        END) AS attributed_conversations
      FROM whatsapp_api_messages msg
      LEFT JOIN whatsapp_api_attribution attr ON attr.whatsapp_api_message_id = msg.id
      LEFT JOIN contacts c ON c.id = msg.contact_id
      WHERE ${baseConditions.join(' AND ')}
    `, [range.startUtc, range.endUtc])
  const trendRows = await db.all(`
      SELECT ${periodExpr} as label, COUNT(*) as messages
      FROM whatsapp_api_messages msg
      LEFT JOIN contacts c ON c.id = msg.contact_id
      WHERE ${baseConditions.join(' AND ')}
      GROUP BY label
      ORDER BY label ASC
    `, [range.startUtc, range.endUtc])
  const firstSeenRow = await getWhatsAppFirstSeenCount(range, hiddenFilters)
  const phoneRows = await db.get(
    'SELECT COUNT(*) as total FROM whatsapp_api_phone_numbers'
  ).catch(() => ({ total: 0 }))

  const inboundMessages = Number(aggregateRow?.inbound_messages || 0)
  const conversations = Number(aggregateRow?.conversations || 0)
  const attributedConversations = Number(aggregateRow?.attributed_conversations || 0)

  return {
    metrics: {
      inboundMessages,
      conversations,
      contacts: firstSeenRow?.projectionStatus === 'unavailable'
        ? Math.max(conversations, Number(firstSeenRow?.count || 0))
        : Number(firstSeenRow?.count || 0),
      attributionRate: conversations > 0 ? Number(((attributedConversations / conversations) * 100).toFixed(1)) : 0
    },
    trend: trendRows.map(row => ({
      label: row.label,
      messages: Number(row.messages || 0)
    })),
    status: {
      connected: Number(phoneRows?.total || 0) > 0,
      hasData: inboundMessages > 0,
      firstSeenProjection: firstSeenRow?.projectionStatus || 'unavailable',
      firstSeenProjectionComplete: Boolean(firstSeenRow?.projectionReady)
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
export async function getTrafficDistributions(
  range,
  {
    includeWeb = true,
    includeWhatsapp = true,
    hiddenFilters: suppliedHiddenFilters = null,
    dimension = null,
    signal
  } = {}
) {
  const selectedDimension = TRAFFIC_DISTRIBUTION_DIMENSIONS.has(dimension) ? dimension : null
  const hiddenFilters = Array.isArray(suppliedHiddenFilters)
    ? suppliedHiddenFilters
    : (includeWhatsapp ? await getHiddenContactFilters({ signal }) : [])
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
  const hiddenSql = hiddenCondition ? `AND (msg.contact_id IS NULL OR ${hiddenCondition})` : ''
  const webSource = buildNormalizedTrafficSourceSql([
    's.referrer_url',
    's.site_source_name',
    's.utm_source',
    's.source_platform'
  ])
  const whatsappSource = getWhatsAppMessageSourceSql('msg', 'attr', 'c')
  const rawFacetLimit = 100
  const dimensionBranches = {
    sources: "SELECT 'sources' AS dimension, source_name AS name, identity FROM source_identities",
    platforms: "SELECT 'platforms' AS dimension, source_name AS name, identity FROM source_identities",
    devices: "SELECT 'devices' AS dimension, device_name AS name, 'web:' || visitor_id AS identity FROM web_sessions",
    placements: "SELECT 'placements' AS dimension, placement_name AS name, 'web:' || visitor_id AS identity FROM web_sessions",
    browsers: "SELECT 'browsers' AS dimension, browser_name AS name, 'web:' || visitor_id AS identity FROM web_sessions",
    os: "SELECT 'os' AS dimension, os_name AS name, 'web:' || visitor_id AS identity FROM web_sessions"
  }
  const selectedBranches = selectedDimension
    ? [dimensionBranches[selectedDimension]]
    : Object.values(dimensionBranches)

  const rows = await db.all(`
    WITH
    web_sessions AS (
      SELECT
        s.visitor_id,
        ${webSource} AS source_name,
        COALESCE(NULLIF(s.device_type, ''), 'Desconocido') AS device_name,
        COALESCE(NULLIF(s.browser, ''), 'Desconocido') AS browser_name,
        COALESCE(NULLIF(s.os, ''), 'Desconocido') AS os_name,
        COALESCE(NULLIF(s.placement, ''), 'Sin ubicación') AS placement_name
      FROM sessions s
      WHERE s.started_at >= ? AND s.started_at <= ?
        AND s.visitor_id IS NOT NULL AND s.visitor_id != ''
        ${includeWeb ? '' : 'AND 1 = 0'}
    ),
    whatsapp_messages AS (
      SELECT
        ${whatsappSource} AS source_name,
        'whatsapp:' || ${getWhatsAppApiIdentitySql('msg')} AS identity,
        COALESCE(msg.message_timestamp, msg.created_at) AS effective_time,
        msg.id AS message_id
      FROM whatsapp_api_messages msg
      LEFT JOIN whatsapp_api_attribution attr ON attr.whatsapp_api_message_id = msg.id
      LEFT JOIN contacts c ON c.id = msg.contact_id
      WHERE LOWER(COALESCE(msg.direction, 'inbound')) = 'inbound'
        AND COALESCE(msg.message_timestamp, msg.created_at) >= ?
        AND COALESCE(msg.message_timestamp, msg.created_at) <= ?
        ${hiddenSql}
        ${includeWhatsapp ? '' : 'AND 1 = 0'}
    ),
    ranked_whatsapp_messages AS (
      SELECT
        whatsapp_messages.*,
        ROW_NUMBER() OVER (
          PARTITION BY identity
          ORDER BY effective_time ASC, message_id ASC
        ) AS identity_rank
      FROM whatsapp_messages
    ),
    whatsapp_identities AS (
      SELECT source_name, identity
      FROM ranked_whatsapp_messages
      WHERE identity_rank = 1
    ),
    source_identities AS (
      SELECT source_name, 'web:' || visitor_id AS identity FROM web_sessions
      UNION ALL
      SELECT source_name, identity FROM whatsapp_identities
    ),
    dimension_values AS (
      ${selectedBranches.join('\nUNION ALL\n')}
    ),
    dimension_counts AS (
      SELECT dimension, name, COUNT(DISTINCT identity) AS item_count
      FROM dimension_values
      WHERE COALESCE(name, '') != '' AND COALESCE(identity, '') != ''
      GROUP BY dimension, name
    ),
    ranked_dimensions AS (
      SELECT
        dimension,
        name,
        item_count,
        ROW_NUMBER() OVER (
          PARTITION BY dimension
          ORDER BY item_count DESC, name ASC
        ) AS item_rank
      FROM dimension_counts
    )
    SELECT dimension, name, item_count
    FROM ranked_dimensions
    WHERE item_rank <= ${rawFacetLimit}
    ORDER BY dimension ASC, item_rank ASC
  `, [range.startUtc, range.endUtc, range.startUtc, range.endUtc], { signal })

  const buckets = {
    sources: new Map(),
    platforms: new Map(),
    devices: new Map(),
    placements: new Map(),
    browsers: new Map(),
    os: new Map()
  }

  for (const row of rows) {
    const bucket = buckets[row.dimension]
    if (!bucket) continue
    const fallbackName = row.dimension === 'placements' ? 'Sin ubicación' : 'Desconocido'
    const rawName = row.name || fallbackName
    const name = row.dimension === 'placements' ? formatPlacementName(rawName) : rawName
    bucket.set(name, (bucket.get(name) || 0) + Number(row.item_count || 0))
  }

  const ranked = map => Array.from(map.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name))
    .slice(0, 10)

  return Object.fromEntries(
    Object.entries(buckets).map(([dimension, bucket]) => [dimension, ranked(bucket)])
  )
}

export async function getTrafficSourceBreakdown(range, options = {}) {
  const distributions = await getTrafficDistributions(range, options)
  return distributions.sources
}

export async function getWhatsAppApiSourceBreakdown(
  range,
  { limit = 10, hiddenFilters: suppliedHiddenFilters = null } = {}
) {
  const hiddenFilters = Array.isArray(suppliedHiddenFilters)
    ? suppliedHiddenFilters
    : await getHiddenContactFilters()
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
  const hiddenSql = hiddenCondition ? `AND (msg.contact_id IS NULL OR ${hiddenCondition})` : ''
  const sourceExpression = getWhatsAppMessageSourceSql('msg', 'attr', 'c')
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 10))

  const rows = await db.all(`
    WITH source_messages AS (
      SELECT
        ${sourceExpression} AS source_name,
        ${getWhatsAppApiIdentitySql('msg')} AS identity,
        COALESCE(msg.message_timestamp, msg.created_at) AS effective_time,
        msg.id AS message_id
      FROM whatsapp_api_messages msg
      LEFT JOIN whatsapp_api_attribution attr ON attr.whatsapp_api_message_id = msg.id
      LEFT JOIN contacts c ON c.id = msg.contact_id
      WHERE LOWER(COALESCE(msg.direction, 'inbound')) = 'inbound'
        AND COALESCE(msg.message_timestamp, msg.created_at) >= ?
        AND COALESCE(msg.message_timestamp, msg.created_at) <= ?
        ${hiddenSql}
    ),
    ranked_source_messages AS (
      SELECT
        source_messages.*,
        ROW_NUMBER() OVER (
          PARTITION BY identity
          ORDER BY effective_time ASC, message_id ASC
        ) AS identity_rank
      FROM source_messages
    ),
    source_identities AS (
      SELECT source_name, identity
      FROM ranked_source_messages
      WHERE identity_rank = 1
    )
    SELECT source_name AS name, COUNT(*) AS value
    FROM source_identities
    GROUP BY source_name
    ORDER BY value DESC, name ASC
    LIMIT ?
  `, [range.startUtc, range.endUtc, safeLimit])

  return rows.map(row => ({ name: row.name || 'WhatsApp', value: Number(row.value || 0) }))
}

export async function getWhatsAppApiNumberBreakdown(
  range,
  { limit = 10, hiddenFilters: suppliedHiddenFilters = null, signal } = {}
) {
  const hiddenFilters = Array.isArray(suppliedHiddenFilters)
    ? suppliedHiddenFilters
    : await getHiddenContactFilters()
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

  const phoneKey = `COALESCE(
    NULLIF(msg.business_phone_number_id, ''),
    NULLIF(msg.business_phone, ''),
    NULLIF(phone.phone_number, ''),
    NULLIF(phone.display_phone_number, '')
  )`
  const label = `COALESCE(
    NULLIF(phone.label, ''),
    NULLIF(phone.verified_name, ''),
    NULLIF(phone.display_phone_number, ''),
    NULLIF(msg.business_phone, ''),
    NULLIF(phone.phone_number, ''),
    'Número sin nombre'
  )`
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 10))
  const rows = await db.all(`
    SELECT
      ${phoneKey} AS phone_key,
      MAX(${label}) AS name,
      COUNT(DISTINCT ${getWhatsAppApiIdentitySql('msg')}) AS value,
      MAX(NULLIF(msg.business_phone_number_id, '')) AS phone_number_id,
      MAX(COALESCE(NULLIF(phone.phone_number, ''), NULLIF(msg.business_phone, ''))) AS phone_number,
      MAX(COALESCE(NULLIF(phone.display_phone_number, ''), NULLIF(msg.business_phone, ''), NULLIF(phone.phone_number, ''))) AS display_phone_number,
      MAX(COALESCE(NULLIF(phone.status, ''), NULLIF(phone.qr_status, ''))) AS status,
      MAX(COALESCE(phone.api_send_enabled, 0)) AS api_send_enabled,
      MAX(COALESCE(phone.qr_send_enabled, 0)) AS qr_send_enabled
    FROM whatsapp_api_messages msg
    LEFT JOIN whatsapp_api_phone_numbers phone ON phone.id = msg.business_phone_number_id
    LEFT JOIN contacts c ON c.id = msg.contact_id
    WHERE ${conditions.join(' AND ')}
    GROUP BY ${phoneKey}
    ORDER BY value DESC, name ASC
    LIMIT ?
  `, [range.startUtc, range.endUtc, safeLimit], { signal })

  return rows.map(row => ({
    name: row.name || 'Número sin nombre',
    value: Number(row.value || 0),
    phoneNumberId: row.phone_number_id || null,
    phoneNumber: row.phone_number || null,
    displayPhoneNumber: row.display_phone_number || null,
    status: row.status || null,
    apiSendEnabled: Boolean(Number(row.api_send_enabled || 0)),
    qrSendEnabled: Boolean(Number(row.qr_send_enabled || 0))
  }))
}
