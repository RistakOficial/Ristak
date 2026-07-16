import { DateTime } from 'luxon'

import { databaseDialect, db } from '../config/database.js'
import { TRACKING_ANALYTICS_FAST_FACETS } from './trackingAnalyticsRangeRollupService.js'

const VIEW_FILTER_FIELDS = new Map([
  ['landing_url', 'page_value'],
  ['page_url', 'page_value'],
  ['utm_campaign', 'utm_campaign'],
  ['utm_medium', 'utm_medium'],
  ['utm_content', 'utm_content'],
  ['utm_source', 'source_filter_value'],
  ['device_type', 'device_type'],
  ['browser', 'browser'],
  ['os', 'os'],
  ['placement', 'placement'],
  ['ad_platform', 'ad_platform'],
  ['campaign_id', 'campaign_id'],
  ['adset_id', 'adset_id'],
  ['ad_id', 'ad_id'],
  ['tracking_source', 'tracking_source'],
  ['channel', 'channel'],
  ['site_type', 'site_type'],
  ['site_id', 'site_id'],
  ['form_site_id', 'form_site_id'],
  ['native_conversion_source', 'native_conversion_source']
])

const MESSAGE_ONLY_FILTERS = new Set(['message_channel', 'message_source', 'status'])

const FACET_DEFINITIONS = Object.freeze({
  sources: ['traffic_source', 'traffic_source'],
  campaigns: ['utm_campaign', 'utm_campaign'],
  adsets: ['adset_id', 'adset_label'],
  ads: ['utm_content', 'utm_content'],
  devices: ['device_type', 'device_type'],
  browsers: ['browser', 'browser'],
  os: ['os', 'os'],
  placements: ['placement', 'placement'],
  trafficChannels: ['channel', 'channel'],
  trackingSources: ['tracking_source', 'tracking_source'],
  pages: ['page_value', 'page_value'],
  siteTypes: ['site_type', 'site_type'],
  nativeSites: ['site_id', 'site_label'],
  nativeForms: ['form_site_id', 'form_label'],
  nativeConversions: ['native_conversion_source', 'native_conversion_label'],
  topVisitors: [null, null]
})

const FACET_LIMIT = 25
const ADS_HIERARCHY_PLATFORM_LIMIT = 8
const ADS_HIERARCHY_CAMPAIGN_LIMIT = 8
const ADS_HIERARCHY_ADSET_LIMIT = 5
const ADS_HIERARCHY_AD_LIMIT = 5
const ADS_HIERARCHY_GLOBAL_LIMIT = 750
// Cada periodo usa tres binds. Mantener el lote en 900 protege instalaciones
// SQLite compiladas con el limite clasico de 999 variables sin recortar la
// serie de hasta 400 puntos; PostgreSQL usa el mismo camino predecible.
const RANGE_DELTA_MAX_BIND_PARAMS = 900
const RANGE_DELTA_BINDS_PER_PERIOD = 3
const RANGE_DELTA_PERIOD_BATCH_SIZE = Math.floor(
  RANGE_DELTA_MAX_BIND_PARAMS / RANGE_DELTA_BINDS_PER_PERIOD
)

function integerValue(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0
}

function periodExpression(groupBy, alias = 'p') {
  if (groupBy === 'year') return `SUBSTR(CAST(${alias}.business_date AS TEXT), 1, 4)`
  if (groupBy === 'month') return `SUBSTR(CAST(${alias}.business_date AS TEXT), 1, 7)`
  return `CAST(${alias}.business_date AS TEXT)`
}

function addProjectionFilterConditions(filters, params, alias = 'd') {
  const conditions = []
  for (const [field, values] of Object.entries(filters || {})) {
    if (!Array.isArray(values) || values.length === 0 || MESSAGE_ONLY_FILTERS.has(field)) continue
    const column = VIEW_FILTER_FIELDS.get(field)
    if (!column) continue
    params.push(...values.map(value => String(value).toLowerCase()))
    const expression = field === 'site_type'
      ? `LOWER(COALESCE(NULLIF(${alias}.site_type, ''), 'unknown'))`
      : `LOWER(${alias}.${column})`
    conditions.push(`${expression} IN (${values.map(() => '?').join(', ')})`)
  }
  return conditions
}

export function canUseTrackingAnalyticsProjection(filters = {}, { facetDimension = null } = {}) {
  if (facetDimension && facetDimension !== 'adsHierarchy' && !FACET_DEFINITIONS[facetDimension]) return false
  return Object.entries(filters).every(([field, values]) => (
    !Array.isArray(values)
    || values.length === 0
    || MESSAGE_ONLY_FILTERS.has(field)
    || field === 'conversion_stage'
    || VIEW_FILTER_FIELDS.has(field)
  ))
}

function buildProjectedAdsHierarchy(rows) {
  const platforms = []
  const platformById = new Map()
  const campaignByPath = new Map()
  const adsetByPath = new Map()
  const key = (...parts) => JSON.stringify(parts)

  for (const row of rows) {
    const platformId = String(row.platform_id || '').trim()
    if (!platformId) continue
    if (row.node_level === 'platform') {
      const platform = {
        platform: String(row.platform_name || platformId),
        platform_id: platformId,
        count: integerValue(row.item_count),
        campaigns: []
      }
      platforms.push(platform)
      platformById.set(platformId, platform)
      continue
    }
    const platform = platformById.get(platformId)
    const campaignId = String(row.campaign_id || '').trim()
    if (!platform || !campaignId) continue
    const campaignPath = key(platformId, campaignId)
    if (row.node_level === 'campaign') {
      const campaign = {
        id: campaignId,
        name: decodeProjectedHierarchyLabel(row.campaign_name, campaignId),
        count: integerValue(row.item_count),
        adsets: []
      }
      platform.campaigns.push(campaign)
      campaignByPath.set(campaignPath, campaign)
      continue
    }
    const campaign = campaignByPath.get(campaignPath)
    const adsetId = String(row.adset_id || '').trim()
    if (!campaign || !adsetId) continue
    const adsetPath = key(platformId, campaignId, adsetId)
    if (row.node_level === 'adset') {
      const adset = {
        id: adsetId,
        name: decodeProjectedHierarchyLabel(row.adset_name, adsetId),
        count: integerValue(row.item_count),
        ads: []
      }
      campaign.adsets.push(adset)
      adsetByPath.set(adsetPath, adset)
      continue
    }
    const adset = adsetByPath.get(adsetPath)
    const adId = String(row.ad_id || '').trim()
    if (!adset || !adId || row.node_level !== 'ad') continue
    adset.ads.push({
      id: adId,
      name: decodeProjectedHierarchyLabel(row.ad_name, adId),
      count: integerValue(row.item_count)
    })
  }
  return platforms
}

function decodeProjectedHierarchyLabel(value, fallback) {
  const label = String(value || fallback || '').trim()
  try {
    return decodeURIComponent(label)
  } catch {
    return label
  }
}

function emptySessionMetrics() {
  return {
    pageViews: 0,
    uniqueVisitors: 0,
    uniqueSessions: 0,
    identifiedContacts: 0,
    returningUsers: 0
  }
}

function hasProjectedViewFilters(filters = {}) {
  return Object.entries(filters).some(([field, values]) => (
    (VIEW_FILTER_FIELDS.has(field) || field === 'conversion_stage') &&
    Array.isArray(values) && values.length > 0
  ))
}

function addConversionStageCondition(filters, params, alias = 'conversion_fact') {
  const stages = Array.isArray(filters?.conversion_stage)
    ? filters.conversion_stage.map(value => String(value || '').trim()).filter(Boolean)
    : []
  if (!stages.length) return null
  params.push(...stages)
  return `${alias}.stage IN (${stages.map(() => '?').join(', ')})`
}

function buildSeriesPeriods(range, groupBy) {
  const start = DateTime.fromISO(range.startDate, { zone: 'UTC' }).startOf('day')
  const end = DateTime.fromISO(range.endDate, { zone: 'UTC' }).startOf('day')
  if (!start.isValid || !end.isValid || end < start) return []
  const unit = groupBy === 'year' ? 'year' : (groupBy === 'month' ? 'month' : 'day')
  const periods = []
  let cursor = start.startOf(unit)
  while (cursor <= end) {
    const periodStart = cursor < start ? start : cursor
    const unitEnd = cursor.endOf(unit).startOf('day')
    const periodEnd = unitEnd > end ? end : unitEnd
    periods.push({
      period: unit === 'year' ? cursor.toFormat('yyyy') : (unit === 'month' ? cursor.toFormat('yyyy-MM') : cursor.toISODate()),
      startDate: periodStart.toISODate(),
      endDate: periodEnd.toISODate()
    })
    cursor = cursor.plus({ [unit === 'day' ? 'days' : `${unit}s`]: 1 }).startOf(unit)
  }
  return periods
}

async function queryRangeDeltaMetrics(range, groupBy, { includeSeries, signal } = {}) {
  const periods = [
    { period: '__metric__', startDate: range.startDate, endDate: range.endDate },
    ...(includeSeries ? buildSeriesPeriods(range, groupBy) : [])
  ]
  const requestedStart = databaseDialect === 'postgres'
    ? 'CAST(requested.start_date AS DATE)'
    : 'requested.start_date'
  const requestedEnd = databaseDialect === 'postgres'
    ? 'CAST(requested.end_date AS DATE)'
    : 'requested.end_date'
  const rows = []
  for (let offset = 0; offset < periods.length; offset += RANGE_DELTA_PERIOD_BATCH_SIZE) {
    const periodBatch = periods.slice(offset, offset + RANGE_DELTA_PERIOD_BATCH_SIZE)
    const valuesSql = periodBatch.map(() => '(?, ?, ?)').join(', ')
    const params = periodBatch.flatMap(period => [period.period, period.startDate, period.endDate])
    const batchRows = await db.all(`
      WITH requested_periods(period, start_date, end_date) AS (
        VALUES ${valuesSql}
      )
      SELECT
        requested.period,
        COALESCE(SUM(CASE WHEN delta.entity_type = 'visitor' THEN delta.range_delta ELSE 0 END), 0) AS unique_visitors,
        COALESCE(SUM(CASE WHEN delta.entity_type = 'session' THEN delta.range_delta ELSE 0 END), 0) AS unique_sessions,
        COALESCE(SUM(CASE WHEN delta.entity_type = 'contact' THEN delta.range_delta ELSE 0 END), 0) AS identified_contacts,
        COALESCE(SUM(CASE WHEN delta.entity_type = 'returning' THEN delta.range_delta ELSE 0 END), 0) AS returning_users
      FROM requested_periods requested
      LEFT JOIN tracking_analytics_range_delta delta
        ON delta.start_boundary <= ${requestedStart}
       AND delta.occurrence_date <= ${requestedEnd}
      GROUP BY requested.period
    `, params, { signal })
    rows.push(...batchRows)
  }

  const dailyRows = await db.all(`
    SELECT CAST(business_date AS TEXT) AS business_date, page_views
    FROM tracking_analytics_daily_rollup
    WHERE business_date >= ? AND business_date <= ?
    ORDER BY business_date ASC
  `, [range.startDate, range.endDate], { signal })
  const pageViewsByPeriod = new Map(periods.map(period => [period.period, 0]))
  for (const row of dailyRows) {
    const date = String(row.business_date || '').slice(0, 10)
    const matching = periods.filter(period => date >= period.startDate && date <= period.endDate)
    for (const period of matching) {
      pageViewsByPeriod.set(period.period, Number(pageViewsByPeriod.get(period.period) || 0) + Number(row.page_views || 0))
    }
  }

  const byPeriod = new Map(rows.map(row => [String(row.period), row]))
  const toMetrics = (period) => {
    const row = byPeriod.get(period) || {}
    return {
      pageViews: integerValue(pageViewsByPeriod.get(period)),
      uniqueVisitors: integerValue(row.unique_visitors),
      uniqueSessions: integerValue(row.unique_sessions),
      identifiedContacts: integerValue(row.identified_contacts),
      returningUsers: integerValue(row.returning_users)
    }
  }
  return {
    metrics: toMetrics('__metric__'),
    series: includeSeries
      ? periods
          .slice(1)
          .map(period => ({ period: period.period, ...toMetrics(period.period) }))
          .filter(({ period: _period, ...metrics }) => Object.values(metrics).some(value => value > 0))
      : [],
    readPath: 'tracking_analytics_range_delta_v2'
  }
}

/**
 * Lee el read model angosto. El CTE materializado toca la tabla de presencia
 * una sola vez aunque el resultado incluya total, serie y usuarios recurrentes.
 * Las fechas ya son fechas civiles de la cuenta; no dependen del timezone del
 * proceso ni del navegador.
 */
async function queryPresenceSessionMetrics(
  range,
  filters,
  groupBy,
  { includeSeries, signal } = {}
) {
  const requestedConversionStages = Array.isArray(filters?.conversion_stage)
    ? filters.conversion_stage.map(value => String(value || '').trim()).filter(Boolean)
    : []
  const params = [range.startDate, range.endDate]
  const baseConditions = ['p.business_date >= ?', 'p.business_date <= ?', 'p.view_count > 0']
  const dimensionConditions = addProjectionFilterConditions(filters, params)
  const conversionStageCondition = addConversionStageCondition(filters, params)
  const dimensionJoin = dimensionConditions.length > 0
    ? `INNER JOIN tracking_analytics_dimensions d
        ON d.dimension_key = p.dimension_key`
    : ''
  const conversionJoin = conversionStageCondition
    ? `INNER JOIN tracking_conversion_contact_fact conversion_fact
        ON conversion_fact.contact_id = p.contact_key`
    : ''
  // Con una o dos etapas elegidas, empezar por los contactos de 116 y hacer
  // probes (contact_key, business_date) evita el seq scan de toda presence.
  // OFFSET 0 conserva deliberadamente el LATERAL como barrera de planificación;
  // sin ella PostgreSQL vuelve a invertir el join y barre millones de filas.
  const useContactDrivenStagePath = databaseDialect === 'postgres'
    && requestedConversionStages.length > 0
    && requestedConversionStages.length <= 2
  const filteredPresenceFrom = useContactDrivenStagePath
    ? `tracking_conversion_contact_fact conversion_fact
      CROSS JOIN LATERAL (
        SELECT
          contact_presence.business_date,
          contact_presence.dimension_key,
          contact_presence.visitor_key,
          contact_presence.session_key,
          contact_presence.contact_key,
          contact_presence.view_count
        FROM tracking_analytics_presence contact_presence
        WHERE contact_presence.contact_key = conversion_fact.contact_id
          AND contact_presence.contact_key <> ''
          AND contact_presence.business_date >= ?
          AND contact_presence.business_date <= ?
          AND contact_presence.event_count > 0
          AND contact_presence.view_count > 0
        OFFSET 0
      ) p
      ${dimensionJoin}`
    : `tracking_analytics_presence p
      ${dimensionJoin}
      ${conversionJoin}`
  const filteredPresenceConditions = useContactDrivenStagePath
    ? [...dimensionConditions, conversionStageCondition].filter(Boolean)
    : [...baseConditions, ...dimensionConditions, conversionStageCondition].filter(Boolean)
  const materialized = databaseDialect === 'postgres' ? 'AS MATERIALIZED' : 'AS'
  const period = periodExpression(groupBy)
  const seriesCtes = includeSeries
    ? `,
      period_totals AS (
        SELECT
          period,
          SUM(view_count) AS page_views,
          COUNT(DISTINCT NULLIF(visitor_key, '')) AS unique_visitors,
          COUNT(DISTINCT NULLIF(session_key, '')) AS unique_sessions,
          COUNT(DISTINCT NULLIF(contact_key, '')) AS identified_contacts
        FROM view_rows
        GROUP BY period
      ),
      period_identity_sessions AS (
        SELECT period, visitor_key
        FROM view_rows
        WHERE visitor_key != ''
        GROUP BY period, visitor_key
        HAVING COUNT(DISTINCT NULLIF(session_key, '')) > 1
      ),
      period_returning AS (
        SELECT period, COUNT(*) AS returning_users
        FROM period_identity_sessions
        GROUP BY period
      )`
    : ''
  const seriesSelect = includeSeries
    ? `
      UNION ALL
      SELECT
        'series' AS row_type,
        totals.period,
        totals.page_views,
        totals.unique_visitors,
        totals.unique_sessions,
        totals.identified_contacts,
        COALESCE(returning_rows.returning_users, 0) AS returning_users,
        NULL AS facet_dimension,
        NULL AS facet_value,
        NULL AS facet_label,
        NULL AS facet_count
      FROM period_totals totals
      LEFT JOIN period_returning returning_rows ON returning_rows.period = totals.period`
    : ''
  const rows = await db.all(`
    WITH
    filtered_presence ${materialized} (
      SELECT
        p.business_date,
        p.visitor_key,
        p.session_key,
        p.contact_key,
        p.view_count
      FROM ${filteredPresenceFrom}
      WHERE ${filteredPresenceConditions.join(' AND ')}
    ),
    view_rows AS (
      SELECT
        ${period} AS period,
        visitor_key,
        session_key,
        contact_key,
        view_count
      FROM filtered_presence p
    ),
    overall AS (
      SELECT
        SUM(view_count) AS page_views,
        COUNT(DISTINCT NULLIF(visitor_key, '')) AS unique_visitors,
        COUNT(DISTINCT NULLIF(session_key, '')) AS unique_sessions,
        COUNT(DISTINCT NULLIF(contact_key, '')) AS identified_contacts
      FROM view_rows
    ),
    overall_returning AS (
      SELECT COUNT(*) AS returning_users
      FROM (
        SELECT visitor_key
        FROM view_rows
        WHERE visitor_key != ''
        GROUP BY visitor_key
        HAVING COUNT(DISTINCT NULLIF(session_key, '')) > 1
      ) returning_identities
    )
    ${seriesCtes}
    SELECT
      'metric' AS row_type,
      NULL AS period,
      overall.page_views,
      overall.unique_visitors,
      overall.unique_sessions,
      overall.identified_contacts,
      overall_returning.returning_users,
      NULL AS facet_dimension,
      NULL AS facet_value,
      NULL AS facet_label,
      NULL AS facet_count
    FROM overall
    CROSS JOIN overall_returning
    ${seriesSelect}
    ORDER BY row_type ASC, period ASC
  `, params, { signal })

  const metricRow = rows.find(row => row.row_type === 'metric')
  return {
    metrics: metricRow
      ? {
          pageViews: integerValue(metricRow.page_views),
          uniqueVisitors: integerValue(metricRow.unique_visitors),
          uniqueSessions: integerValue(metricRow.unique_sessions),
          identifiedContacts: integerValue(metricRow.identified_contacts),
          returningUsers: integerValue(metricRow.returning_users)
        }
      : emptySessionMetrics(),
    series: includeSeries
      ? rows
          .filter(row => row.row_type === 'series')
          .map(row => ({
            period: String(row.period || ''),
            pageViews: integerValue(row.page_views),
            uniqueVisitors: integerValue(row.unique_visitors),
            uniqueSessions: integerValue(row.unique_sessions),
            identifiedContacts: integerValue(row.identified_contacts),
            returningUsers: integerValue(row.returning_users)
          }))
      : [],
    readPath: 'tracking_analytics_presence_filtered'
  }
}

export async function queryTrackingAnalyticsProjectionSessionMetrics(
  range,
  filters,
  groupBy,
  options = {}
) {
  if (!hasProjectedViewFilters(filters)) {
    return queryRangeDeltaMetrics(range, groupBy, options)
  }
  // Los filtros combinados conservan su intersección exacta en presence. No se
  // suman grids por valor: hacerlo duplicaría una identidad presente en más de
  // una dimension_key. El caller expone readPath para que este fallback sea
  // observable y nunca parezca el fast path global.
  return queryPresenceSessionMetrics(range, filters, groupBy, options)
}

async function queryPresenceFacet(
  range,
  filters,
  dimension,
  { signal } = {}
) {
  const definition = FACET_DEFINITIONS[dimension]
  if (!definition) return null

  const params = [range.startDate, range.endDate]
  const conditions = [
    'p.business_date >= ?',
    'p.business_date <= ?',
    'p.event_count > 0'
  ]
  const dimensionConditions = addProjectionFilterConditions(filters, params)
  conditions.push(...dimensionConditions)
  const conversionStageCondition = addConversionStageCondition(filters, params)
  if (conversionStageCondition) conditions.push(conversionStageCondition)
  const conversionJoin = conversionStageCondition
    ? `INNER JOIN tracking_conversion_contact_fact conversion_fact
        ON conversion_fact.contact_id = p.contact_key`
    : ''
  const dimensionJoin = dimension === 'topVisitors' && dimensionConditions.length === 0
    ? ''
    : `INNER JOIN tracking_analytics_dimensions d
        ON d.dimension_key = p.dimension_key`

  if (dimension === 'topVisitors') {
    const rows = await db.all(`
      SELECT
        p.visitor_key AS value,
        p.visitor_key AS label,
        SUM(p.event_count) AS item_count
      FROM tracking_analytics_presence p
      ${dimensionJoin}
      ${conversionJoin}
      WHERE ${conditions.join(' AND ')}
        AND p.visitor_key != ''
      GROUP BY p.visitor_key
      ORDER BY item_count DESC, value ASC
      LIMIT ${FACET_LIMIT}
    `, params, { signal })
    return rows.map(row => ({
      value: String(row.value || ''),
      label: String(row.label || row.value || ''),
      count: integerValue(row.item_count)
    }))
  }

  const [valueColumn, labelColumn] = definition
  const valueExpression = dimension === 'siteTypes'
    ? `COALESCE(NULLIF(d.site_type, ''), 'unknown')`
    : `d.${valueColumn}`
  const labelExpression = dimension === 'siteTypes'
    ? valueExpression
    : `COALESCE(NULLIF(d.${labelColumn}, ''), d.${valueColumn})`
  const rows = await db.all(`
    SELECT
      ${valueExpression} AS value,
      MAX(${labelExpression}) AS label,
      COUNT(DISTINCT NULLIF(p.visitor_key, '')) AS item_count
    FROM tracking_analytics_presence p
    ${dimensionJoin}
    ${conversionJoin}
    WHERE ${conditions.join(' AND ')}
      AND COALESCE(${valueExpression}, '') != ''
      AND p.visitor_key != ''
    GROUP BY ${valueExpression}
    ORDER BY item_count DESC, value ASC
    LIMIT ${FACET_LIMIT}
  `, params, { signal })

  return rows.map(row => ({
    value: String(row.value || ''),
    label: String(row.label || row.value || ''),
    count: integerValue(row.item_count)
  }))
}

async function queryRangeDeltaFacet(range, dimension, { signal } = {}) {
  const rows = await db.all(`
    SELECT
      values_table.facet_value AS value,
      SUM(delta.range_delta) AS item_count
    FROM tracking_analytics_facet_values values_table
    INNER JOIN tracking_analytics_facet_range_delta delta
      ON delta.facet_value_id = values_table.facet_value_id
    WHERE values_table.facet_type = ?
      AND delta.start_boundary <= ?
      AND delta.occurrence_date <= ?
    GROUP BY values_table.facet_value
    HAVING SUM(delta.range_delta) > 0
    ORDER BY item_count DESC, value ASC
    LIMIT ${FACET_LIMIT}
  `, [dimension, range.startDate, range.endDate], { signal })

  let labels = new Map()
  if (dimension === 'adsets' && rows.length) {
    const values = rows.map(row => String(row.value || ''))
    const labelRows = await db.all(`
      SELECT
        dimensions.adset_id AS value,
        MAX(COALESCE(NULLIF(dimensions.adset_label, ''), dimensions.adset_id)) AS label
      FROM tracking_analytics_dimensions dimensions
      WHERE dimensions.adset_id IN (${values.map(() => '?').join(', ')})
        AND EXISTS (
          SELECT 1
          FROM tracking_analytics_presence presence
          WHERE presence.dimension_key = dimensions.dimension_key
            AND presence.business_date >= ?
            AND presence.business_date <= ?
            AND presence.event_count > 0
        )
      GROUP BY dimensions.adset_id
    `, [...values, range.startDate, range.endDate], { signal })
    labels = new Map(labelRows.map(row => [String(row.value || ''), String(row.label || row.value || '')]))
  }

  return rows.map(row => {
    const value = String(row.value || '')
    return {
      value,
      label: labels.get(value) || value,
      count: integerValue(row.item_count)
    }
  })
}

async function queryProjectedAdsHierarchy(range, filters, { signal } = {}) {
  const params = [range.startDate, range.endDate]
  const conditions = [
    'p.business_date >= ?',
    'p.business_date <= ?',
    'p.event_count > 0',
    "p.visitor_key != ''"
  ]
  conditions.push(...addProjectionFilterConditions(filters, params))
  const conversionStageCondition = addConversionStageCondition(filters, params)
  if (conversionStageCondition) conditions.push(conversionStageCondition)
  const conversionJoin = conversionStageCondition
    ? `INNER JOIN tracking_conversion_contact_fact conversion_fact
        ON conversion_fact.contact_id = p.contact_key`
    : ''
  const materialized = databaseDialect === 'postgres' ? 'AS MATERIALIZED' : 'AS'

  const rows = await db.all(`
    WITH hierarchy_base ${materialized} (
      SELECT
        d.traffic_source AS platform_id,
        d.utm_campaign AS campaign_id,
        COALESCE(NULLIF(d.campaign_label, ''), d.utm_campaign) AS campaign_name,
        d.utm_medium AS adset_id,
        COALESCE(NULLIF(d.adset_label, ''), d.utm_medium) AS adset_name,
        d.utm_content AS ad_id,
        COALESCE(NULLIF(d.ad_label, ''), d.utm_content) AS ad_name,
        p.visitor_key AS visitor_identity
      FROM tracking_analytics_presence p
      INNER JOIN tracking_analytics_dimensions d
        ON d.dimension_key = p.dimension_key
      ${conversionJoin}
      WHERE ${conditions.join(' AND ')}
        AND (
          d.traffic_source != '' OR d.utm_campaign != ''
          OR d.utm_medium != '' OR d.utm_content != ''
        )
    ),
    platform_counts AS (
      SELECT platform_id, COUNT(DISTINCT visitor_identity) AS item_count
      FROM hierarchy_base
      WHERE platform_id != ''
      GROUP BY platform_id
    ),
    ranked_platforms AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY item_count DESC, platform_id ASC) AS platform_rank
      FROM platform_counts
    ),
    selected_platforms AS (
      SELECT * FROM ranked_platforms WHERE platform_rank <= ${ADS_HIERARCHY_PLATFORM_LIMIT}
    ),
    campaign_counts AS (
      SELECT hb.platform_id, hb.campaign_id, MAX(hb.campaign_name) AS campaign_name,
        COUNT(DISTINCT hb.visitor_identity) AS item_count
      FROM hierarchy_base hb
      INNER JOIN selected_platforms sp ON sp.platform_id = hb.platform_id
      WHERE hb.campaign_id != ''
      GROUP BY hb.platform_id, hb.campaign_id
    ),
    ranked_campaigns AS (
      SELECT cc.*, sp.platform_rank,
        ROW_NUMBER() OVER (
          PARTITION BY cc.platform_id ORDER BY cc.item_count DESC, cc.campaign_id ASC
        ) AS campaign_rank
      FROM campaign_counts cc
      INNER JOIN selected_platforms sp ON sp.platform_id = cc.platform_id
    ),
    selected_campaigns AS (
      SELECT * FROM ranked_campaigns WHERE campaign_rank <= ${ADS_HIERARCHY_CAMPAIGN_LIMIT}
    ),
    adset_counts AS (
      SELECT hb.platform_id, hb.campaign_id, hb.adset_id, MAX(hb.adset_name) AS adset_name,
        COUNT(DISTINCT hb.visitor_identity) AS item_count
      FROM hierarchy_base hb
      INNER JOIN selected_campaigns sc
        ON sc.platform_id = hb.platform_id AND sc.campaign_id = hb.campaign_id
      WHERE hb.adset_id != ''
      GROUP BY hb.platform_id, hb.campaign_id, hb.adset_id
    ),
    ranked_adsets AS (
      SELECT ac.*, sc.platform_rank, sc.campaign_rank,
        ROW_NUMBER() OVER (
          PARTITION BY ac.platform_id, ac.campaign_id
          ORDER BY ac.item_count DESC, ac.adset_id ASC
        ) AS adset_rank
      FROM adset_counts ac
      INNER JOIN selected_campaigns sc
        ON sc.platform_id = ac.platform_id AND sc.campaign_id = ac.campaign_id
    ),
    selected_adsets AS (
      SELECT * FROM ranked_adsets WHERE adset_rank <= ${ADS_HIERARCHY_ADSET_LIMIT}
    ),
    ad_counts AS (
      SELECT hb.platform_id, hb.campaign_id, hb.adset_id, hb.ad_id,
        MAX(hb.ad_name) AS ad_name, COUNT(DISTINCT hb.visitor_identity) AS item_count
      FROM hierarchy_base hb
      INNER JOIN selected_adsets sa
        ON sa.platform_id = hb.platform_id
        AND sa.campaign_id = hb.campaign_id
        AND sa.adset_id = hb.adset_id
      WHERE hb.ad_id != ''
      GROUP BY hb.platform_id, hb.campaign_id, hb.adset_id, hb.ad_id
    ),
    ranked_ads AS (
      SELECT ac.*, sa.platform_rank, sa.campaign_rank, sa.adset_rank,
        ROW_NUMBER() OVER (
          PARTITION BY ac.platform_id, ac.campaign_id, ac.adset_id
          ORDER BY ac.item_count DESC, ac.ad_id ASC
        ) AS ad_rank
      FROM ad_counts ac
      INNER JOIN selected_adsets sa
        ON sa.platform_id = ac.platform_id
        AND sa.campaign_id = ac.campaign_id
        AND sa.adset_id = ac.adset_id
    ),
    selected_ads AS (
      SELECT * FROM ranked_ads WHERE ad_rank <= ${ADS_HIERARCHY_AD_LIMIT}
    ),
    hierarchy_nodes AS (
      SELECT 1 AS node_order, 'platform' AS node_level, platform_id,
        platform_id AS platform_name, CAST(NULL AS TEXT) AS campaign_id,
        CAST(NULL AS TEXT) AS campaign_name, CAST(NULL AS TEXT) AS adset_id,
        CAST(NULL AS TEXT) AS adset_name, CAST(NULL AS TEXT) AS ad_id,
        CAST(NULL AS TEXT) AS ad_name, item_count, platform_rank,
        0 AS campaign_rank, 0 AS adset_rank, 0 AS ad_rank
      FROM selected_platforms
      UNION ALL
      SELECT 2, 'campaign', platform_id, platform_id, campaign_id, campaign_name,
        CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT), CAST(NULL AS TEXT),
        item_count, platform_rank, campaign_rank, 0, 0
      FROM selected_campaigns
      UNION ALL
      SELECT 3, 'adset', platform_id, platform_id, campaign_id, CAST(NULL AS TEXT),
        adset_id, adset_name, CAST(NULL AS TEXT), CAST(NULL AS TEXT), item_count,
        platform_rank, campaign_rank, adset_rank, 0
      FROM selected_adsets
      UNION ALL
      SELECT 4, 'ad', platform_id, platform_id, campaign_id, CAST(NULL AS TEXT),
        adset_id, CAST(NULL AS TEXT), ad_id, ad_name, item_count,
        platform_rank, campaign_rank, adset_rank, ad_rank
      FROM selected_ads
    )
    SELECT node_level, platform_id, platform_name, campaign_id, campaign_name,
      adset_id, adset_name, ad_id, ad_name, item_count
    FROM hierarchy_nodes
    ORDER BY node_order ASC, platform_rank ASC, campaign_rank ASC, adset_rank ASC, ad_rank ASC
    LIMIT ${ADS_HIERARCHY_GLOBAL_LIMIT}
  `, params, { signal })

  return buildProjectedAdsHierarchy(rows)
}

export async function queryTrackingAnalyticsProjectionFacet(
  range,
  filters,
  dimension,
  options = {}
) {
  if (dimension === 'adsHierarchy') {
    return queryProjectedAdsHierarchy(range, filters, options)
  }
  if (TRACKING_ANALYTICS_FAST_FACETS[dimension] && !hasProjectedViewFilters(filters)) {
    return queryRangeDeltaFacet(range, dimension, options)
  }
  return queryPresenceFacet(range, filters, dimension, options)
}
