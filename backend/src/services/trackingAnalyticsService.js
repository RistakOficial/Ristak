import { createHash } from 'node:crypto'
import { databaseDialect, db } from '../config/database.js'
import { resolveDateRangeWithGHLTimezone } from '../utils/dateUtils.js'
import { nonTestPaymentCondition, SUCCESS_PAYMENT_STATUSES } from '../utils/paymentMode.js'
import { getGroupExpression } from './analyticsService.js'
import { getVisitorIdentityExpression } from './trackingService.js'
import {
  getTrackingAnalyticsCacheRevision,
  invalidateTrackingAnalyticsCache
} from './trackingAnalyticsCache.js'

const TRACKING_VIEW_EVENTS = ['session_start', 'page_view', 'native_site_view']
const INACTIVE_APPOINTMENT_STATUSES = [
  'cancelled',
  'canceled',
  'no_show',
  'no-show',
  'noshow',
  'invalid',
  'failed',
  'missed',
  'deleted',
  'void',
  'voided'
]
const ATTENDED_APPOINTMENT_STATUSES = ['show', 'showed', 'completed', 'complete', 'attended']
const ALLOWED_GROUPS = new Set(['day', 'month', 'year'])
const MESSAGE_ONLY_FILTERS = new Set(['message_channel', 'message_source', 'status'])
const SESSION_FILTER_FIELDS = new Set([
  'landing_url',
  'page_url',
  'utm_campaign',
  'utm_medium',
  'utm_content',
  'utm_source',
  'device_type',
  'browser',
  'os',
  'placement',
  'ad_platform',
  'campaign_id',
  'adset_id',
  'ad_id',
  'conversion_stage',
  'tracking_source',
  'channel',
  'site_type',
  'site_id',
  'form_site_id',
  'native_conversion_source'
])
const SEARCHABLE_COLUMNS = new Set([
  'all',
  'session_id',
  'visitor_id',
  'contact_id',
  'full_name',
  'email',
  'event_name',
  'page_url',
  'referrer_url',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'channel',
  'source_platform',
  'campaign_id',
  'adset_id',
  'ad_id',
  'device_type',
  'os',
  'browser',
  'geo_country',
  'geo_city',
  'site_name'
])
const DEFAULT_SEARCH_COLUMNS = [
  'session_id',
  'visitor_id',
  'contact_id',
  'full_name',
  'email',
  'event_name',
  'page_url',
  'referrer_url',
  'utm_source',
  'utm_campaign',
  'utm_content',
  'campaign_id',
  'ad_id',
  'site_name'
]
const MAX_FILTER_VALUES = 100
const MAX_FILTER_VALUE_LENGTH = 300
const MIN_SEARCH_LENGTH = 3
const MAX_SEARCH_LENGTH = 200
const MAX_SERIES_POINTS = 400
const FACET_LIMIT = 25
const ADS_HIERARCHY_PLATFORM_LIMIT = 8
const ADS_HIERARCHY_CAMPAIGN_LIMIT = 8
const ADS_HIERARCHY_ADSET_LIMIT = 5
const ADS_HIERARCHY_AD_LIMIT = 5
const ADS_HIERARCHY_GLOBAL_LIMIT = 750
const FLAT_FACET_DIMENSIONS = Object.freeze([
  'sources',
  'campaigns',
  'adsets',
  'ads',
  'devices',
  'browsers',
  'os',
  'placements',
  'trafficChannels',
  'trackingSources',
  'pages',
  'siteTypes',
  'nativeSites',
  'nativeForms',
  'nativeConversions',
  'topVisitors'
])
const TRACKING_ANALYTICS_FACET_DIMENSIONS = Object.freeze([
  ...FLAT_FACET_DIMENSIONS,
  'adsHierarchy'
])
const TRACKING_ANALYTICS_FACET_DIMENSION_SET = new Set(TRACKING_ANALYTICS_FACET_DIMENSIONS)
const STAGE_SEARCH_CHUNK_SIZE = 500
const STAGE_SEARCH_MAX_SCAN = 10_000
const SUMMARY_CACHE_TTL_MS = 30_000
// Un stream de tracking activo puede incrementar la revision varias veces por
// segundo. Con la revision dentro de la llave, cada visita convertia la cache
// en un miss y dejaba snapshots viejos ocupando el LRU. Conservamos el ultimo
// snapshot por consulta durante una ventana acotada y lo revalidamos una sola
// vez en segundo plano; el cliente pinta ese snapshot y espera la misma promesa
// cuando necesita el resultado fresco.
const SUMMARY_CACHE_STALE_WHILE_REVALIDATE_MS = 5 * 60_000
const SUMMARY_CACHE_MAX_ENTRIES = 100
const SUMMARY_QUERY_DEADLINE_MS = 18_000
const SUMMARY_MAX_CONCURRENT_BUILDS = 2
const SUMMARY_MAX_QUEUED_BUILDS = 8
const SUMMARY_MAX_CONCURRENT_QUERIES = 2
const FACET_CACHE_TTL_MS = 30_000
const FACET_CACHE_STALE_WHILE_REVALIDATE_MS = 5 * 60_000
const FACET_CACHE_MAX_ENTRIES = 200
const FACET_QUERY_DEADLINE_MS = 18_000
const FACET_MAX_CONCURRENT_BUILDS = 1
const FACET_MAX_QUEUED_BUILDS = 12
const summaryCache = new Map()
const summaryInflight = new Map()
const summaryBuildWaiters = []
const summaryQueryWaiters = []
const facetCache = new Map()
const facetInflight = new Map()
const facetBuildWaiters = []
let activeSummaryBuilds = 0
let activeSummaryQueries = 0
let activeFacetBuilds = 0

const successfulPaymentStatusSql = SUCCESS_PAYMENT_STATUSES
  .map(status => `'${String(status).replace(/'/g, "''")}'`)
  .join(', ')
const inactiveAppointmentStatusSql = INACTIVE_APPOINTMENT_STATUSES
  .map(status => `'${status}'`)
  .join(', ')
const attendedAppointmentStatusSql = ATTENDED_APPOINTMENT_STATUSES
  .map(status => `'${status}'`)
  .join(', ')
const viewEventSql = TRACKING_VIEW_EVENTS.map(event => `'${event}'`).join(', ')

function requestError(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

function numberValue(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function integerValue(value) {
  return Math.max(0, Math.trunc(numberValue(value)))
}

function normalizeText(value, maxLength = MAX_FILTER_VALUE_LENGTH) {
  return String(value ?? '').trim().slice(0, maxLength)
}

export function normalizeTrackingAnalyticsFilters(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}

  const normalized = {}
  for (const [field, rawValues] of Object.entries(input)) {
    if (!SESSION_FILTER_FIELDS.has(field) && !MESSAGE_ONLY_FILTERS.has(field)) {
      throw requestError(`Filtro de tracking no soportado: ${field}`)
    }

    const values = (Array.isArray(rawValues) ? rawValues : [rawValues])
      .map(value => normalizeText(value))
      .filter(Boolean)
      .slice(0, MAX_FILTER_VALUES)

    if (values.length > 0) normalized[field] = [...new Set(values)]
  }

  return normalized
}

function hasSessionFilters(filters) {
  return Object.entries(filters).some(([field, values]) => (
    SESSION_FILTER_FIELDS.has(field) && Array.isArray(values) && values.length > 0
  ))
}

function withoutConversionStage(filters) {
  return Object.fromEntries(Object.entries(filters).filter(([field]) => field !== 'conversion_stage'))
}

function valueListCondition(expression, values, params, { lowercase = false } = {}) {
  if (!values?.length) return null
  const comparedExpression = lowercase ? `LOWER(COALESCE(${expression}, ''))` : expression
  const placeholders = values.map(() => '?').join(', ')
  params.push(...values.map(value => lowercase ? value.toLowerCase() : value))
  return `${comparedExpression} IN (${placeholders})`
}

function pageBaseExpression(alias) {
  const column = `${alias}.page_url`
  if (databaseDialect === 'postgres') return `SPLIT_PART(COALESCE(${column}, ''), '?', 1)`
  return `CASE
    WHEN INSTR(COALESCE(${column}, ''), '?') > 0
      THEN SUBSTR(${column}, 1, INSTR(${column}, '?') - 1)
    ELSE COALESCE(${column}, '')
  END`
}

function nativeFormExpression(alias) {
  return `CASE
    WHEN COALESCE(${alias}.form_site_id, '') != '' THEN ${alias}.form_site_id
    WHEN ${alias}.site_type IN ('standard_form', 'interactive_form') THEN COALESCE(${alias}.site_id, '')
    ELSE ''
  END`
}

function trackingSourceExpression(alias) {
  return `CASE
    WHEN LOWER(COALESCE(${alias}.tracking_source, '')) = 'native_site'
      OR COALESCE(${alias}.site_id, '') != ''
      THEN 'native_site'
    ELSE 'external_pixel'
  END`
}

function channelExpression(alias) {
  return `CASE
    WHEN LOWER(COALESCE(${alias}.channel, '')) = '' THEN 'direct'
    WHEN LOWER(COALESCE(${alias}.channel, '')) LIKE '%organic%' THEN 'organic'
    WHEN LOWER(COALESCE(${alias}.channel, '')) LIKE '%social%' THEN 'social'
    WHEN LOWER(COALESCE(${alias}.channel, '')) LIKE '%email%'
      OR LOWER(COALESCE(${alias}.channel, '')) LIKE '%correo%' THEN 'email'
    WHEN LOWER(COALESCE(${alias}.channel, '')) LIKE '%referral%' THEN 'referral'
    WHEN LOWER(COALESCE(${alias}.channel, '')) LIKE '%direct%' THEN 'direct'
    WHEN LOWER(COALESCE(${alias}.channel, '')) LIKE '%paid%'
      OR LOWER(COALESCE(${alias}.channel, '')) LIKE '%cpc%'
      OR LOWER(COALESCE(${alias}.channel, '')) LIKE '%ppc%'
      OR LOWER(COALESCE(${alias}.channel, '')) LIKE '%sem%'
      OR LOWER(COALESCE(${alias}.channel, '')) LIKE '%ads%'
      OR LOWER(COALESCE(${alias}.channel, '')) = 'ad' THEN 'paid'
    ELSE LOWER(COALESCE(${alias}.channel, ''))
  END`
}

function trafficSourceExpression(alias) {
  return `CASE
    WHEN LOWER(COALESCE(${alias}.referrer_url, '')) LIKE '%google.%' THEN 'Google'
    WHEN LOWER(COALESCE(${alias}.referrer_url, '')) LIKE '%facebook.%'
      OR LOWER(COALESCE(${alias}.referrer_url, '')) LIKE '%fb.com%' THEN 'Facebook'
    WHEN LOWER(COALESCE(${alias}.referrer_url, '')) LIKE '%instagram.%' THEN 'Instagram'
    WHEN LOWER(COALESCE(${alias}.referrer_url, '')) LIKE '%tiktok.%' THEN 'TikTok'
    WHEN COALESCE(${alias}.site_source_name, '') != '' THEN ${alias}.site_source_name
    WHEN COALESCE(${alias}.utm_source, '') != '' THEN ${alias}.utm_source
    WHEN COALESCE(${alias}.source_platform, '') != '' THEN ${alias}.source_platform
    ELSE 'Directo'
  END`
}

function contactStageExpression(alias = 'cf') {
  return `CASE
    WHEN ${alias}.contact_id IS NULL OR ${alias}.contact_id = '' THEN NULL
    WHEN COALESCE(${alias}.payment_count, 0) > 0 THEN 'customer'
    WHEN COALESCE(${alias}.has_attendance, 0) > 0 THEN 'appointment_attended'
    WHEN COALESCE(${alias}.has_appointment, 0) > 0 THEN 'appointment_scheduled'
    ELSE 'prospect'
  END`
}

function buildSessionFilterConditions(filters, alias, params, { includeConversionStage = false, contactAlias = 'cf' } = {}) {
  const conditions = []

  for (const [field, values] of Object.entries(filters)) {
    if (!values?.length || MESSAGE_ONLY_FILTERS.has(field)) continue
    if (field === 'conversion_stage') {
      if (includeConversionStage) {
        conditions.push(valueListCondition(contactStageExpression(contactAlias), values, params))
      }
      continue
    }

    let condition = null
    switch (field) {
      case 'landing_url':
      case 'page_url':
        condition = valueListCondition(pageBaseExpression(alias), values, params, { lowercase: true })
        break
      case 'utm_campaign':
      case 'utm_medium':
      case 'utm_content':
      case 'device_type':
      case 'browser':
      case 'os':
      case 'placement':
      case 'campaign_id':
      case 'ad_id':
      case 'site_type':
      case 'site_id':
        condition = valueListCondition(`${alias}.${field}`, values, params, { lowercase: true })
        break
      case 'utm_source':
        condition = valueListCondition(trafficSourceExpression(alias), values, params, { lowercase: true })
        break
      case 'ad_platform':
        condition = valueListCondition(`${alias}.source_platform`, values, params, { lowercase: true })
        break
      case 'adset_id':
        condition = valueListCondition(`COALESCE(NULLIF(${alias}.adset_id, ''), ${alias}.ad_group_id)`, values, params, { lowercase: true })
        break
      case 'tracking_source':
        condition = valueListCondition(trackingSourceExpression(alias), values, params, { lowercase: true })
        break
      case 'channel':
        condition = valueListCondition(channelExpression(alias), values, params, { lowercase: true })
        break
      case 'form_site_id':
        condition = valueListCondition(nativeFormExpression(alias), values, params, { lowercase: true })
        break
      case 'native_conversion_source': {
        const nativeConditions = []
        for (const value of values) {
          if (value.startsWith('form:')) {
            params.push(value.slice(5).toLowerCase())
            nativeConditions.push(`(
              ${alias}.event_name = 'native_site_conversion'
              AND LOWER(${nativeFormExpression(alias)}) = ?
            )`)
          } else if (value.startsWith('site:')) {
            params.push(value.slice(5).toLowerCase())
            nativeConditions.push(`(
              ${alias}.event_name = 'native_site_conversion'
              AND LOWER(COALESCE(${alias}.site_id, '')) = ?
            )`)
          }
        }
        if (nativeConditions.length > 0) condition = `(${nativeConditions.join(' OR ')})`
        break
      }
      default:
        break
    }

    if (condition) conditions.push(condition)
  }

  return conditions.filter(Boolean)
}

function validPaymentPredicate(alias = 'p') {
  return `
    COALESCE(${alias}.amount, 0) > 0
    AND LOWER(COALESCE(${alias}.status, '')) IN (${successfulPaymentStatusSql})
    AND ${nonTestPaymentCondition(alias)}
  `
}

function contactFactsCtes(candidateCte = 'candidate_contact_ids') {
  return `
    payment_facts AS (
      SELECT p.contact_id, COUNT(*) AS payment_count
      FROM payments p
      INNER JOIN ${candidateCte} candidate ON candidate.contact_id = p.contact_id
      WHERE ${validPaymentPredicate('p')}
      GROUP BY p.contact_id
    ),
    appointment_facts AS (
      SELECT
        a.contact_id,
        MAX(CASE
          WHEN LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN (${inactiveAppointmentStatusSql})
            THEN 1 ELSE 0
        END) AS has_appointment,
        MAX(CASE
          WHEN LOWER(COALESCE(a.appointment_status, a.status, '')) IN (${attendedAppointmentStatusSql})
            THEN 1 ELSE 0
        END) AS has_attended_status
      FROM appointments a
      INNER JOIN ${candidateCte} candidate ON candidate.contact_id = a.contact_id
      GROUP BY a.contact_id
    ),
    attendance_facts AS (
      SELECT signals.contact_id, 1 AS has_attendance_signal
      FROM appointment_attendance_signals signals
      INNER JOIN ${candidateCte} candidate ON candidate.contact_id = signals.contact_id
      GROUP BY signals.contact_id
    ),
    contact_facts AS (
      SELECT
        c.id AS contact_id,
        c.created_at AS contact_created_at,
        COALESCE(pf.payment_count, 0) AS payment_count,
        CASE
          WHEN c.appointment_date IS NOT NULL OR COALESCE(af.has_appointment, 0) > 0 THEN 1
          ELSE 0
        END AS has_appointment,
        CASE
          WHEN COALESCE(att.has_attendance_signal, 0) > 0 OR COALESCE(af.has_attended_status, 0) > 0 THEN 1
          ELSE 0
        END AS has_attendance
      FROM contacts c
      INNER JOIN ${candidateCte} candidate ON candidate.contact_id = c.id
      LEFT JOIN payment_facts pf ON pf.contact_id = c.id
      LEFT JOIN appointment_facts af ON af.contact_id = c.id
      LEFT JOIN attendance_facts att ON att.contact_id = c.id
    )
  `
}

const sessionAnalyticsProjection = (alias = 's') => `
  ${alias}.id,
  ${alias}.session_id,
  ${alias}.visitor_id,
  ${alias}.contact_id,
  ${alias}.event_name,
  ${alias}.started_at,
  ${alias}.page_url,
  ${alias}.referrer_url,
  ${alias}.utm_source,
  ${alias}.utm_medium,
  ${alias}.utm_campaign,
  ${alias}.utm_content,
  ${alias}.channel,
  ${alias}.source_platform,
  ${alias}.campaign_id,
  ${alias}.adset_id,
  ${alias}.ad_group_id,
  ${alias}.ad_id,
  ${alias}.campaign_name,
  ${alias}.adset_name,
  ${alias}.ad_group_name,
  ${alias}.ad_name,
  ${alias}.placement,
  ${alias}.site_source_name,
  ${alias}.device_type,
  ${alias}.os,
  ${alias}.browser,
  ${alias}.geo_country,
  ${alias}.geo_city,
  ${alias}.tracking_source,
  ${alias}.site_id,
  ${alias}.site_slug,
  ${alias}.site_name,
  ${alias}.site_type,
  ${alias}.form_site_id,
  ${alias}.form_site_name,
  ${alias}.conversion_type,
  ${alias}.submission_id,
  ${getVisitorIdentityExpression(alias)} AS visitor_identity
`

function buildFilteredSessionsCte(range, filters, params) {
  const baseConditions = [`s.started_at >= ?`, `s.started_at < ?`]
  params.push(range.startUtc, range.endExclusiveUtc)
  baseConditions.push(...buildSessionFilterConditions(withoutConversionStage(filters), 's', params))

  const conversionStages = filters.conversion_stage || []
  if (conversionStages.length === 0) {
    return `filtered_sessions AS (
      SELECT ${sessionAnalyticsProjection('s')}
      FROM sessions s
      WHERE ${baseConditions.join(' AND ')}
    )`
  }

  const stageParams = []
  const stageCondition = valueListCondition(contactStageExpression('cf'), conversionStages, stageParams)
  params.push(...stageParams)

  return `
    session_candidates AS (
      SELECT ${sessionAnalyticsProjection('s')}
      FROM sessions s
      WHERE ${baseConditions.join(' AND ')}
    ),
    candidate_contact_ids AS (
      SELECT DISTINCT contact_id
      FROM session_candidates
      WHERE contact_id IS NOT NULL AND contact_id != ''
    ),
    ${contactFactsCtes('candidate_contact_ids')},
    filtered_sessions AS (
      SELECT candidates.*
      FROM session_candidates candidates
      LEFT JOIN contact_facts cf ON cf.contact_id = candidates.contact_id
      WHERE ${stageCondition}
    )
  `
}

async function resolveAnalyticsRange(start, end, signal) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(start || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(end || ''))) {
    throw requestError('start y end deben usar el formato YYYY-MM-DD')
  }

  const resolved = await resolveDateRangeWithGHLTimezone({
    startDate: start,
    endDate: end,
    signal
  })
  if (!resolved.startZoned?.isValid || !resolved.endZoned?.isValid || resolved.startZoned > resolved.endZoned) {
    throw requestError('El rango de fechas no es válido')
  }

  return {
    startDate: start,
    endDate: end,
    startUtc: resolved.startUtc,
    endExclusiveUtc: resolved.endZoned.plus({ milliseconds: 1 }).toUTC().toISO({ suppressMilliseconds: false }),
    timezone: resolved.appliedTimezone,
    startZoned: resolved.startZoned,
    endZoned: resolved.endZoned
  }
}

function previousRangeFor(range) {
  const startDay = range.startZoned.startOf('day')
  const endDay = range.endZoned.startOf('day')
  const calendarDays = Math.max(1, Math.round(endDay.diff(startDay, 'days').days) + 1)
  const previousStart = startDay.minus({ days: calendarDays })

  return {
    startDate: previousStart.toISODate(),
    endDate: startDay.minus({ days: 1 }).toISODate(),
    startUtc: previousStart.toUTC().toISO({ suppressMilliseconds: false }),
    endExclusiveUtc: startDay.toUTC().toISO({ suppressMilliseconds: false }),
    timezone: range.timezone,
    startZoned: previousStart,
    endZoned: startDay.minus({ milliseconds: 1 })
  }
}

function effectiveGroupBy(requestedGroupBy, range) {
  const requested = ALLOWED_GROUPS.has(requestedGroupBy) ? requestedGroupBy : 'day'
  const days = Math.max(1, Math.round(range.endZoned.startOf('day').diff(range.startZoned.startOf('day'), 'days').days) + 1)
  const months = Math.max(1, ((range.endZoned.year - range.startZoned.year) * 12) + range.endZoned.month - range.startZoned.month + 1)
  const years = Math.max(1, range.endZoned.year - range.startZoned.year + 1)

  if (requested === 'day' && days > MAX_SERIES_POINTS) return months <= MAX_SERIES_POINTS ? 'month' : 'year'
  if (requested === 'month' && months > MAX_SERIES_POINTS) return 'year'
  if (requested === 'year' && years > MAX_SERIES_POINTS) {
    throw requestError(`El rango supera el máximo de ${MAX_SERIES_POINTS} puntos anuales`)
  }
  return requested
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

async function querySessionMetrics(range, filters, groupBy, { includeSeries, signal }) {
  const params = []
  const filteredSessionsCte = buildFilteredSessionsCte(range, filters, params)

  if (!includeSeries) {
    const row = await db.get(`
      WITH
      ${filteredSessionsCte},
      view_sessions AS (
        SELECT session_id, contact_id, visitor_identity
        FROM filtered_sessions
        WHERE event_name IN (${viewEventSql})
      ),
      returning_identities AS (
        SELECT visitor_identity
        FROM view_sessions
        GROUP BY visitor_identity
        HAVING COUNT(DISTINCT session_id) > 1
      )
      SELECT
        COUNT(*) AS page_views,
        COUNT(DISTINCT visitor_identity) AS unique_visitors,
        COUNT(DISTINCT session_id) AS unique_sessions,
        COUNT(DISTINCT contact_id) AS identified_contacts,
        (SELECT COUNT(*) FROM returning_identities) AS returning_users
      FROM view_sessions
    `, params, { signal })

    return {
      metrics: {
        pageViews: integerValue(row?.page_views),
        uniqueVisitors: integerValue(row?.unique_visitors),
        uniqueSessions: integerValue(row?.unique_sessions),
        identifiedContacts: integerValue(row?.identified_contacts),
        returningUsers: integerValue(row?.returning_users)
      },
      series: []
    }
  }

  const periodExpression = getGroupExpression('started_at', groupBy, range.timezone)
  const seriesSql = databaseDialect === 'postgres'
    ? `
      WITH
      ${filteredSessionsCte},
      view_sessions AS (
        SELECT
          session_id,
          contact_id,
          visitor_identity,
          ${periodExpression} AS period
        FROM filtered_sessions
        WHERE event_name IN (${viewEventSql})
      ),
      identity_groups AS (
        SELECT
          GROUPING(period) AS total_group,
          period,
          visitor_identity,
          COUNT(*) AS page_views,
          COUNT(DISTINCT session_id) AS identity_sessions,
          MAX(CASE WHEN contact_id = '' THEN 1 ELSE 0 END) AS has_empty_contact
        FROM view_sessions
        GROUP BY GROUPING SETS (
          (visitor_identity),
          (period, visitor_identity)
        )
      ),
      identity_rollups AS (
        SELECT
          total_group,
          period,
          SUM(page_views) AS page_views,
          COUNT(visitor_identity) AS unique_visitors,
          COUNT(*) FILTER (WHERE visitor_identity LIKE 'contact:%')
            + MAX(has_empty_contact) AS identified_contacts,
          COUNT(*) FILTER (
            WHERE visitor_identity IS NOT NULL AND identity_sessions > 1
          ) AS returning_users
        FROM identity_groups
        GROUP BY total_group, period
      ),
      complete_identity_rollups AS (
        SELECT
          total_group,
          period,
          page_views,
          unique_visitors,
          identified_contacts,
          returning_users
        FROM identity_rollups
        UNION ALL
        SELECT 1, NULL::text, 0, 0, 0, 0
        WHERE NOT EXISTS (
          SELECT 1
          FROM identity_rollups
          WHERE total_group = 1
        )
      ),
      session_groups AS (
        SELECT
          GROUPING(period) AS total_group,
          period,
          session_id
        FROM view_sessions
        WHERE session_id IS NOT NULL
        GROUP BY GROUPING SETS (
          (session_id),
          (period, session_id)
        )
      ),
      session_rollups AS (
        SELECT total_group, period, COUNT(*) AS unique_sessions
        FROM session_groups
        GROUP BY total_group, period
      )
      SELECT
        CASE WHEN identities.total_group = 1 THEN 'metric' ELSE 'series' END AS row_type,
        identities.period,
        identities.page_views,
        identities.unique_visitors,
        COALESCE(sessions.unique_sessions, 0) AS unique_sessions,
        identities.identified_contacts,
        identities.returning_users
      FROM complete_identity_rollups identities
      LEFT JOIN session_rollups sessions
        ON sessions.total_group = identities.total_group
        AND sessions.period IS NOT DISTINCT FROM identities.period
      ORDER BY row_type ASC, period ASC
    `
    : `
      WITH
      ${filteredSessionsCte},
      view_sessions AS (
        SELECT
          session_id,
          contact_id,
          visitor_identity,
          ${periodExpression} AS period
        FROM filtered_sessions
        WHERE event_name IN (${viewEventSql})
      ),
      identity_totals AS (
        SELECT visitor_identity
        FROM view_sessions
        GROUP BY visitor_identity
        HAVING COUNT(DISTINCT session_id) > 1
      ),
      identity_periods AS (
        SELECT period, visitor_identity
        FROM view_sessions
        GROUP BY period, visitor_identity
        HAVING COUNT(DISTINCT session_id) > 1
      ),
      period_totals AS (
        SELECT
          period,
          COUNT(*) AS page_views,
          COUNT(DISTINCT visitor_identity) AS unique_visitors,
          COUNT(DISTINCT session_id) AS unique_sessions,
          COUNT(DISTINCT contact_id) AS identified_contacts
        FROM view_sessions
        GROUP BY period
      ),
      returning_periods AS (
        SELECT period, COUNT(*) AS returning_users
        FROM identity_periods
        GROUP BY period
      )
      SELECT
        'metric' AS row_type,
        NULL AS period,
        COUNT(*) AS page_views,
        COUNT(DISTINCT visitor_identity) AS unique_visitors,
        COUNT(DISTINCT session_id) AS unique_sessions,
        COUNT(DISTINCT contact_id) AS identified_contacts,
        (SELECT COUNT(*) FROM identity_totals) AS returning_users
      FROM view_sessions
      UNION ALL
      SELECT
        'series' AS row_type,
        totals.period,
        totals.page_views,
        totals.unique_visitors,
        totals.unique_sessions,
        totals.identified_contacts,
        COALESCE(returning_rows.returning_users, 0) AS returning_users
      FROM period_totals totals
      LEFT JOIN returning_periods returning_rows ON returning_rows.period = totals.period
      ORDER BY row_type ASC, period ASC
    `
  const rows = await db.all(seriesSql, params, { signal })

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
    series: rows
      .filter(row => row.row_type === 'series')
      .map(row => ({
        period: String(row.period || ''),
        pageViews: integerValue(row.page_views),
        uniqueVisitors: integerValue(row.unique_visitors),
        uniqueSessions: integerValue(row.unique_sessions),
        identifiedContacts: integerValue(row.identified_contacts),
        returningUsers: integerValue(row.returning_users)
      }))
  }
}

function contactAnalyticsSourceCondition(alias = 'c') {
  return `(
    (${alias}.visitor_id IS NOT NULL AND ${alias}.visitor_id != '')
    OR LOWER(COALESCE(${alias}.source, '')) LIKE '%whatsapp%'
    OR EXISTS (SELECT 1 FROM whatsapp_api_messages wam WHERE wam.contact_id = ${alias}.id)
    OR EXISTS (SELECT 1 FROM whatsapp_api_attribution waa WHERE waa.contact_id = ${alias}.id)
    OR EXISTS (SELECT 1 FROM whatsapp_attribution wa WHERE wa.contact_id = ${alias}.id)
  )`
}

function emptyConversionMetrics() {
  return { registrations: 0, prospects: 0, appointments: 0, attendances: 0, customers: 0, purchases: 0 }
}

async function queryConversionMetrics(range, filters, groupBy, { includeSeries, signal }) {
  const params = [range.startUtc, range.endExclusiveUtc]
  const candidateConditions = [
    `c.created_at >= ?`,
    `c.created_at < ?`,
    contactAnalyticsSourceCondition('c')
  ]
  const activeWebFilters = hasSessionFilters(filters)

  if (activeWebFilters) {
    const sessionConditions = [
      `sf.contact_id = c.id`,
      `sf.started_at >= ?`,
      `sf.started_at < ?`,
      `sf.started_at >= c.created_at`
    ]
    params.push(range.startUtc, range.endExclusiveUtc)
    sessionConditions.push(...buildSessionFilterConditions(withoutConversionStage(filters), 'sf', params))
    candidateConditions.push(`EXISTS (
      SELECT 1
      FROM sessions sf
      WHERE ${sessionConditions.join(' AND ')}
    )`)
  }

  const stageConditions = []
  if (filters.conversion_stage?.length) {
    stageConditions.push(valueListCondition(contactStageExpression('cf'), filters.conversion_stage, params))
  }

  const periodExpression = getGroupExpression('contact_created_at', groupBy, range.timezone)
  const groupSelect = includeSeries ? `${periodExpression} AS period,` : `NULL AS period,`
  const groupClause = includeSeries ? `GROUP BY ${periodExpression} ORDER BY period ASC` : ''
  const rows = await db.all(`
    WITH
    candidate_contacts AS (
      SELECT c.id AS contact_id
      FROM contacts c
      WHERE ${candidateConditions.join(' AND ')}
    ),
    ${contactFactsCtes('candidate_contacts')}
    SELECT
      ${groupSelect}
      COUNT(*) AS registrations,
      SUM(CASE WHEN ${contactStageExpression('cf')} = 'prospect' THEN 1 ELSE 0 END) AS prospects,
      SUM(CASE WHEN COALESCE(cf.has_appointment, 0) > 0 THEN 1 ELSE 0 END) AS appointments,
      SUM(CASE WHEN COALESCE(cf.has_attendance, 0) > 0 THEN 1 ELSE 0 END) AS attendances,
      SUM(CASE WHEN COALESCE(cf.payment_count, 0) > 0 THEN 1 ELSE 0 END) AS customers,
      SUM(COALESCE(cf.payment_count, 0)) AS purchases,
      SUM(CASE WHEN ${contactStageExpression('cf')} = 'appointment_scheduled' THEN 1 ELSE 0 END) AS stage_appointments,
      SUM(CASE WHEN ${contactStageExpression('cf')} = 'appointment_attended' THEN 1 ELSE 0 END) AS stage_attendances
    FROM contact_facts cf
    ${stageConditions.length > 0 ? `WHERE ${stageConditions.join(' AND ')}` : ''}
    ${groupClause}
  `, params, { signal })

  const series = rows.map(row => ({
    period: includeSeries ? String(row.period || '') : '',
    registrations: integerValue(row.registrations),
    prospects: integerValue(row.prospects),
    appointments: integerValue(row.appointments),
    attendances: integerValue(row.attendances),
    customers: integerValue(row.customers),
    purchases: integerValue(row.purchases),
    stageAppointments: integerValue(row.stage_appointments),
    stageAttendances: integerValue(row.stage_attendances)
  }))
  const metrics = series.reduce((totals, row) => ({
    registrations: totals.registrations + row.registrations,
    prospects: totals.prospects + row.prospects,
    appointments: totals.appointments + row.appointments,
    attendances: totals.attendances + row.attendances,
    customers: totals.customers + row.customers,
    purchases: totals.purchases + row.purchases
  }), emptyConversionMetrics())

  const stageCounts = series.reduce((totals, row) => ({
    appointmentScheduled: totals.appointmentScheduled + row.stageAppointments,
    appointmentAttended: totals.appointmentAttended + row.stageAttendances
  }), { appointmentScheduled: 0, appointmentAttended: 0 })
  const publicSeries = series.map(({ stageAppointments, stageAttendances, ...row }) => row)

  return { metrics, series: includeSeries ? publicSeries : [], stageCounts }
}

function facetItem(row) {
  return {
    value: String(row.value || '').slice(0, MAX_FILTER_VALUE_LENGTH),
    label: String(row.label || row.value || '').slice(0, MAX_FILTER_VALUE_LENGTH),
    count: integerValue(row.item_count)
  }
}

function facetDimensionDefinitions(alias, identityExpression) {
  return [
    ['sources', trafficSourceExpression(alias), trafficSourceExpression(alias), identityExpression],
    ['campaigns', `${alias}.utm_campaign`, `${alias}.utm_campaign`, identityExpression],
    ['adsets', `COALESCE(NULLIF(${alias}.adset_id, ''), NULLIF(${alias}.ad_group_id, ''), ${alias}.utm_medium)`, `COALESCE(NULLIF(${alias}.adset_id, ''), NULLIF(${alias}.ad_group_id, ''), ${alias}.utm_medium)`, identityExpression],
    // El filtro visible de Analíticas envía utm_content. La faceta debe devolver
    // exactamente ese mismo valor; mezclar aquí ad_id producía una opción que al
    // seleccionarse no encontraba las sesiones que acababa de contar.
    ['ads', `${alias}.utm_content`, `${alias}.utm_content`, identityExpression],
    ['devices', `${alias}.device_type`, `${alias}.device_type`, identityExpression],
    ['browsers', `${alias}.browser`, `${alias}.browser`, identityExpression],
    ['os', `${alias}.os`, `${alias}.os`, identityExpression],
    ['placements', `${alias}.placement`, `${alias}.placement`, identityExpression],
    ['trafficChannels', channelExpression(alias), channelExpression(alias), identityExpression],
    ['trackingSources', trackingSourceExpression(alias), trackingSourceExpression(alias), identityExpression],
    ['pages', pageBaseExpression(alias), pageBaseExpression(alias), identityExpression],
    ['siteTypes', `COALESCE(NULLIF(${alias}.site_type, ''), 'unknown')`, `COALESCE(NULLIF(${alias}.site_type, ''), 'unknown')`, identityExpression],
    ['nativeSites', `${alias}.site_id`, `COALESCE(NULLIF(${alias}.site_name, ''), NULLIF(${alias}.site_slug, ''), ${alias}.site_id)`, identityExpression],
    ['nativeForms', nativeFormExpression(alias), `COALESCE(NULLIF(${alias}.form_site_name, ''), NULLIF(${alias}.site_name, ''), ${nativeFormExpression(alias)})`, identityExpression],
    ['nativeConversions', `CASE WHEN ${alias}.event_name = 'native_site_conversion' AND ${nativeFormExpression(alias)} != '' THEN 'form:' || ${nativeFormExpression(alias)} WHEN ${alias}.event_name = 'native_site_conversion' THEN 'site:' || COALESCE(${alias}.site_id, '') ELSE '' END`, `CASE WHEN ${alias}.event_name = 'native_site_conversion' AND ${nativeFormExpression(alias)} != '' THEN 'Formulario: ' || COALESCE(NULLIF(${alias}.form_site_name, ''), NULLIF(${alias}.site_name, ''), ${nativeFormExpression(alias)}) WHEN ${alias}.event_name = 'native_site_conversion' THEN 'Landing: ' || COALESCE(NULLIF(${alias}.site_name, ''), NULLIF(${alias}.site_slug, ''), ${alias}.site_id) ELSE '' END`, `COALESCE(NULLIF(${alias}.submission_id, ''), NULLIF(${alias}.contact_id, ''), ${identityExpression})`],
    ['topVisitors', identityExpression, identityExpression, identityExpression]
  ]
}

export function normalizeTrackingAnalyticsFacetDimension(input) {
  const dimension = normalizeText(input, 40)
  if (!TRACKING_ANALYTICS_FACET_DIMENSION_SET.has(dimension)) {
    throw requestError(`Dimensión de faceta no soportada: ${dimension || '(vacía)'}`)
  }
  return dimension
}

function flatFacetDefinition(alias, identityExpression, dimension) {
  const definition = facetDimensionDefinitions(alias, identityExpression)
    .find(([candidate]) => candidate === dimension)
  if (!definition) throw requestError(`Dimensión de faceta no soportada: ${dimension}`)
  return definition
}

async function queryPostgresSessionFacetsWithoutConversionFilter(range, filters, signal) {
  const identityExpression = getVisitorIdentityExpression('s')
  const dimensions = facetDimensionDefinitions('s', identityExpression)
  const params = []

  // GROUPING SETS parecía ahorrar recorridos, pero con 300k eventos y work_mem
  // de 4 MB mantuvo simultáneamente los estados de 16 dimensiones y derramó
  // casi 3 GiB a temporales. Cada rama siguiente agrega y poda sus 25 valores
  // antes del UNION ALL. Repite un scan barato e indexado por rango, evita la
  // explosión de memoria y conserva exactamente value/count/orden de facetas.
  const facetBranches = dimensions.map(([dimension, value, label, identity]) => {
    const branchParams = [range.startUtc, range.endExclusiveUtc]
    const conditions = [`s.started_at >= ?`, `s.started_at < ?`]
    conditions.push(...buildSessionFilterConditions(filters, 's', branchParams))
    conditions.push(`COALESCE(CAST(${value} AS TEXT), '') != ''`)
    params.push(...branchParams)

    const itemCount = dimension === 'topVisitors'
      ? 'COUNT(*)'
      : `COUNT(DISTINCT ${identity})`

    return `
      SELECT dimension, value, label, item_count
      FROM (
        SELECT
          '${dimension}' AS dimension,
          CAST(COALESCE(${value}, '') AS TEXT) AS value,
          CAST(MAX(COALESCE(${label}, ${value}, '')) AS TEXT) AS label,
          ${itemCount} AS item_count
        FROM sessions s
        WHERE ${conditions.join(' AND ')}
        GROUP BY ${value}
        ORDER BY item_count DESC, value ASC
        LIMIT ${FACET_LIMIT}
      ) ${dimension}_facet
    `
  })

  const rows = await db.all(`
    SELECT dimension, value, label, item_count
    FROM (
      ${facetBranches.join('\nUNION ALL\n')}
    ) facet_rows
    ORDER BY dimension ASC, item_count DESC, value ASC
  `, params, { signal })

  const facets = Object.fromEntries(dimensions.map(([dimension]) => [dimension, []]))
  for (const row of rows) facets[row.dimension]?.push(facetItem(row))
  return facets
}

async function queryPostgresSingleSessionFacetWithoutConversionFilter(range, filters, dimension, signal) {
  const identityExpression = getVisitorIdentityExpression('s')
  const [, value, label, identity] = flatFacetDefinition('s', identityExpression, dimension)
  const params = [range.startUtc, range.endExclusiveUtc]
  const conditions = [`s.started_at >= ?`, `s.started_at < ?`]
  conditions.push(...buildSessionFilterConditions(filters, 's', params))
  conditions.push(`COALESCE(CAST(${value} AS TEXT), '') != ''`)
  const itemCount = dimension === 'topVisitors'
    ? 'COUNT(*)'
    : `COUNT(DISTINCT ${identity})`

  // Esta ruta ejecuta exactamente una dimensión. No se permite aceptar un
  // arreglo ni construir un UNION: cada intención del usuario paga un solo
  // agregado acotado y no vuelve a meter las 16 facetas en la ruta crítica.
  const rows = await db.all(`
    SELECT
      CAST(COALESCE(${value}, '') AS TEXT) AS value,
      CAST(MAX(COALESCE(${label}, ${value}, '')) AS TEXT) AS label,
      ${itemCount} AS item_count
    FROM sessions s
    WHERE ${conditions.join(' AND ')}
    GROUP BY ${value}
    ORDER BY item_count DESC, value ASC
    LIMIT ${FACET_LIMIT}
  `, params, { signal })

  return rows.map(facetItem)
}

function hierarchyNodeKey(...parts) {
  return JSON.stringify(parts)
}

function decodeHierarchyLabel(value, fallback) {
  const rawLabel = normalizeText(value) || fallback
  try {
    return decodeURIComponent(rawLabel.replace(/\+/g, ' '))
  } catch {
    return rawLabel
  }
}

function buildAdsHierarchy(rows) {
  const platforms = []
  const platformById = new Map()
  const campaignByPath = new Map()
  const adsetByPath = new Map()

  for (const row of rows) {
    const platformId = normalizeText(row.platform_id)
    if (!platformId) continue

    if (row.node_level === 'platform') {
      const platform = {
        platform: normalizeText(row.platform_name) || platformId,
        platform_id: platformId,
        count: integerValue(row.item_count),
        campaigns: []
      }
      platforms.push(platform)
      platformById.set(platformId, platform)
      continue
    }

    const platform = platformById.get(platformId)
    if (!platform) continue

    const campaignId = normalizeText(row.campaign_id)
    if (!campaignId) continue
    const campaignPath = hierarchyNodeKey(platformId, campaignId)

    if (row.node_level === 'campaign') {
      const campaign = {
        id: campaignId,
        name: decodeHierarchyLabel(row.campaign_name, campaignId),
        count: integerValue(row.item_count),
        adsets: []
      }
      platform.campaigns.push(campaign)
      campaignByPath.set(campaignPath, campaign)
      continue
    }

    const campaign = campaignByPath.get(campaignPath)
    if (!campaign) continue

    const adsetId = normalizeText(row.adset_id)
    if (!adsetId) continue
    const adsetPath = hierarchyNodeKey(platformId, campaignId, adsetId)

    if (row.node_level === 'adset') {
      const adset = {
        id: adsetId,
        name: decodeHierarchyLabel(row.adset_name, adsetId),
        count: integerValue(row.item_count),
        ads: []
      }
      campaign.adsets.push(adset)
      adsetByPath.set(adsetPath, adset)
      continue
    }

    if (row.node_level !== 'ad') continue
    const adset = adsetByPath.get(adsetPath)
    const adId = normalizeText(row.ad_id)
    if (!adset || !adId) continue
    adset.ads.push({
      id: adId,
      name: decodeHierarchyLabel(row.ad_name, adId),
      count: integerValue(row.item_count)
    })
  }

  return platforms
}

async function queryAdsHierarchy(range, filters, signal) {
  const params = []
  const filteredSessionsCte = buildFilteredSessionsCte(range, filters, params)
  const platformExpression = trafficSourceExpression('fs')

  const rows = await db.all(`
    WITH
    ${filteredSessionsCte},
    hierarchy_base AS (
      SELECT
        CAST(${platformExpression} AS TEXT) AS platform_id,
        CAST(COALESCE(fs.utm_campaign, '') AS TEXT) AS campaign_id,
        CAST(COALESCE(NULLIF(fs.campaign_name, ''), fs.utm_campaign, '') AS TEXT) AS campaign_name,
        CAST(COALESCE(fs.utm_medium, '') AS TEXT) AS adset_id,
        CAST(COALESCE(NULLIF(fs.adset_name, ''), NULLIF(fs.ad_group_name, ''), fs.utm_medium, '') AS TEXT) AS adset_name,
        CAST(COALESCE(fs.utm_content, '') AS TEXT) AS ad_id,
        CAST(COALESCE(NULLIF(fs.ad_name, ''), fs.utm_content, '') AS TEXT) AS ad_name,
        CAST(fs.visitor_identity AS TEXT) AS visitor_identity
      FROM filtered_sessions fs
      WHERE COALESCE(fs.visitor_identity, '') != ''
        AND (
          COALESCE(fs.utm_source, '') != ''
          OR COALESCE(fs.utm_campaign, '') != ''
          OR COALESCE(fs.utm_medium, '') != ''
          OR COALESCE(fs.utm_content, '') != ''
        )
    ),
    platform_counts AS (
      SELECT
        platform_id,
        COUNT(DISTINCT visitor_identity) AS item_count
      FROM hierarchy_base
      GROUP BY platform_id
    ),
    ranked_platforms AS (
      SELECT
        platform_id,
        item_count,
        ROW_NUMBER() OVER (ORDER BY item_count DESC, platform_id ASC) AS platform_rank
      FROM platform_counts
      WHERE platform_id != ''
    ),
    selected_platforms AS (
      SELECT platform_id, item_count, platform_rank
      FROM ranked_platforms
      WHERE platform_rank <= ${ADS_HIERARCHY_PLATFORM_LIMIT}
    ),
    campaign_counts AS (
      SELECT
        hb.platform_id,
        hb.campaign_id,
        MAX(hb.campaign_name) AS campaign_name,
        COUNT(DISTINCT hb.visitor_identity) AS item_count
      FROM hierarchy_base hb
      INNER JOIN selected_platforms sp ON sp.platform_id = hb.platform_id
      WHERE hb.campaign_id != ''
      GROUP BY hb.platform_id, hb.campaign_id
    ),
    ranked_campaigns AS (
      SELECT
        cc.*,
        sp.platform_rank,
        ROW_NUMBER() OVER (
          PARTITION BY cc.platform_id
          ORDER BY cc.item_count DESC, cc.campaign_id ASC
        ) AS campaign_rank
      FROM campaign_counts cc
      INNER JOIN selected_platforms sp ON sp.platform_id = cc.platform_id
    ),
    selected_campaigns AS (
      SELECT *
      FROM ranked_campaigns
      WHERE campaign_rank <= ${ADS_HIERARCHY_CAMPAIGN_LIMIT}
    ),
    adset_counts AS (
      SELECT
        hb.platform_id,
        hb.campaign_id,
        hb.adset_id,
        MAX(hb.adset_name) AS adset_name,
        COUNT(DISTINCT hb.visitor_identity) AS item_count
      FROM hierarchy_base hb
      INNER JOIN selected_campaigns sc
        ON sc.platform_id = hb.platform_id
        AND sc.campaign_id = hb.campaign_id
      WHERE hb.adset_id != ''
      GROUP BY hb.platform_id, hb.campaign_id, hb.adset_id
    ),
    ranked_adsets AS (
      SELECT
        ac.*,
        sc.platform_rank,
        sc.campaign_rank,
        ROW_NUMBER() OVER (
          PARTITION BY ac.platform_id, ac.campaign_id
          ORDER BY ac.item_count DESC, ac.adset_id ASC
        ) AS adset_rank
      FROM adset_counts ac
      INNER JOIN selected_campaigns sc
        ON sc.platform_id = ac.platform_id
        AND sc.campaign_id = ac.campaign_id
    ),
    selected_adsets AS (
      SELECT *
      FROM ranked_adsets
      WHERE adset_rank <= ${ADS_HIERARCHY_ADSET_LIMIT}
    ),
    ad_counts AS (
      SELECT
        hb.platform_id,
        hb.campaign_id,
        hb.adset_id,
        hb.ad_id,
        MAX(hb.ad_name) AS ad_name,
        COUNT(DISTINCT hb.visitor_identity) AS item_count
      FROM hierarchy_base hb
      INNER JOIN selected_adsets sa
        ON sa.platform_id = hb.platform_id
        AND sa.campaign_id = hb.campaign_id
        AND sa.adset_id = hb.adset_id
      WHERE hb.ad_id != ''
      GROUP BY hb.platform_id, hb.campaign_id, hb.adset_id, hb.ad_id
    ),
    ranked_ads AS (
      SELECT
        ac.*,
        sa.platform_rank,
        sa.campaign_rank,
        sa.adset_rank,
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
      SELECT *
      FROM ranked_ads
      WHERE ad_rank <= ${ADS_HIERARCHY_AD_LIMIT}
    ),
    hierarchy_nodes AS (
      SELECT
        1 AS node_order,
        'platform' AS node_level,
        platform_id,
        platform_id AS platform_name,
        CAST(NULL AS TEXT) AS campaign_id,
        CAST(NULL AS TEXT) AS campaign_name,
        CAST(NULL AS TEXT) AS adset_id,
        CAST(NULL AS TEXT) AS adset_name,
        CAST(NULL AS TEXT) AS ad_id,
        CAST(NULL AS TEXT) AS ad_name,
        item_count,
        platform_rank,
        0 AS campaign_rank,
        0 AS adset_rank,
        0 AS ad_rank
      FROM selected_platforms

      UNION ALL

      SELECT
        2 AS node_order,
        'campaign' AS node_level,
        platform_id,
        platform_id AS platform_name,
        campaign_id,
        campaign_name,
        CAST(NULL AS TEXT) AS adset_id,
        CAST(NULL AS TEXT) AS adset_name,
        CAST(NULL AS TEXT) AS ad_id,
        CAST(NULL AS TEXT) AS ad_name,
        item_count,
        platform_rank,
        campaign_rank,
        0 AS adset_rank,
        0 AS ad_rank
      FROM selected_campaigns

      UNION ALL

      SELECT
        3 AS node_order,
        'adset' AS node_level,
        platform_id,
        platform_id AS platform_name,
        campaign_id,
        CAST(NULL AS TEXT) AS campaign_name,
        adset_id,
        adset_name,
        CAST(NULL AS TEXT) AS ad_id,
        CAST(NULL AS TEXT) AS ad_name,
        item_count,
        platform_rank,
        campaign_rank,
        adset_rank,
        0 AS ad_rank
      FROM selected_adsets

      UNION ALL

      SELECT
        4 AS node_order,
        'ad' AS node_level,
        platform_id,
        platform_id AS platform_name,
        campaign_id,
        CAST(NULL AS TEXT) AS campaign_name,
        adset_id,
        CAST(NULL AS TEXT) AS adset_name,
        ad_id,
        ad_name,
        item_count,
        platform_rank,
        campaign_rank,
        adset_rank,
        ad_rank
      FROM selected_ads
    )
    SELECT
      node_level,
      platform_id,
      platform_name,
      campaign_id,
      campaign_name,
      adset_id,
      adset_name,
      ad_id,
      ad_name,
      item_count
    FROM hierarchy_nodes
    ORDER BY node_order ASC, platform_rank ASC, campaign_rank ASC, adset_rank ASC, ad_rank ASC
    LIMIT ${ADS_HIERARCHY_GLOBAL_LIMIT}
  `, params, { signal })

  return buildAdsHierarchy(rows)
}

async function queryFlatSessionFacets(range, filters, signal) {
  if (databaseDialect === 'postgres' && !filters.conversion_stage?.length) {
    return queryPostgresSessionFacetsWithoutConversionFilter(range, filters, signal)
  }

  const params = []
  const filteredSessionsCte = buildFilteredSessionsCte(range, filters, params)
  const dimensions = facetDimensionDefinitions('fs', 'fs.visitor_identity')
  const dimensionSql = dimensions.map(([dimension, value, label, identity]) => `
    SELECT
      '${dimension}' AS dimension,
      CAST(COALESCE(${value}, '') AS TEXT) AS value,
      CAST(COALESCE(${label}, ${value}, '') AS TEXT) AS label,
      CAST(COALESCE(${identity}, '') AS TEXT) AS identity
    FROM filtered_sessions fs
  `).join('\nUNION ALL\n')

  const rows = await db.all(`
    WITH
    ${filteredSessionsCte},
    dimension_values AS (
      ${dimensionSql}
    ),
    dimension_counts AS (
      SELECT
        dimension,
        value,
        MAX(label) AS label,
        CASE
          WHEN dimension = 'topVisitors' THEN COUNT(*)
          ELSE COUNT(DISTINCT identity)
        END AS item_count
      FROM dimension_values
      WHERE value != '' AND identity != ''
      GROUP BY dimension, value
    ),
    ranked_dimensions AS (
      SELECT
        dimension,
        value,
        label,
        item_count,
        ROW_NUMBER() OVER (PARTITION BY dimension ORDER BY item_count DESC, value ASC) AS item_rank
      FROM dimension_counts
    )
    SELECT dimension, value, label, item_count
    FROM ranked_dimensions
    WHERE item_rank <= ${FACET_LIMIT}
    ORDER BY dimension ASC, item_rank ASC
  `, params, { signal })

  const facets = Object.fromEntries(dimensions.map(([dimension]) => [dimension, []]))
  for (const row of rows) facets[row.dimension]?.push(facetItem(row))
  return facets
}

async function querySingleFlatSessionFacet(range, filters, dimension, signal) {
  if (databaseDialect === 'postgres' && !filters.conversion_stage?.length) {
    return queryPostgresSingleSessionFacetWithoutConversionFilter(range, filters, dimension, signal)
  }

  const params = []
  const filteredSessionsCte = buildFilteredSessionsCte(range, filters, params)
  const [, value, label, identity] = flatFacetDefinition(
    'fs',
    'fs.visitor_identity',
    dimension
  )
  const itemCount = dimension === 'topVisitors'
    ? 'COUNT(*)'
    : `COUNT(DISTINCT ${identity})`

  const rows = await db.all(`
    WITH
    ${filteredSessionsCte}
    SELECT
      CAST(COALESCE(${value}, '') AS TEXT) AS value,
      CAST(MAX(COALESCE(${label}, ${value}, '')) AS TEXT) AS label,
      ${itemCount} AS item_count
    FROM filtered_sessions fs
    WHERE COALESCE(CAST(${value} AS TEXT), '') != ''
      AND COALESCE(CAST(${identity} AS TEXT), '') != ''
    GROUP BY ${value}
    ORDER BY item_count DESC, value ASC
    LIMIT ${FACET_LIMIT}
  `, params, { signal })

  return rows.map(facetItem)
}

async function queryTrackingAnalyticsFacet(range, filters, dimension, signal) {
  if (dimension === 'adsHierarchy') return queryAdsHierarchy(range, filters, signal)
  return querySingleFlatSessionFacet(range, filters, dimension, signal)
}

async function querySessionFacets(range, filters, signal, runQuery) {
  // Facetas planas y jerarquía no dependen entre sí. Ambas comparten el
  // semáforo global de dos consultas con sesiones/conversiones; así reducen el
  // tiempo de pared sin volver al burst de seis consultas que saturó Render.
  const siblingController = new AbortController()
  const linkedScope = createLinkedSummaryAbortScope([signal, siblingController.signal])
  const flatPromise = runQuery(() => queryFlatSessionFacets(range, filters, linkedScope.signal))
  const hierarchyPromise = runQuery(() => queryAdsHierarchy(range, filters, linkedScope.signal))

  try {
    const [facets, adsHierarchy] = await Promise.all([flatPromise, hierarchyPromise])
    facets.adsHierarchy = adsHierarchy
    return facets
  } catch (error) {
    siblingController.abort(error)
    await Promise.allSettled([flatPromise, hierarchyPromise])
    throw error
  } finally {
    linkedScope.cleanup()
  }
}

function trendValue(current, previous) {
  if (!previous) return current > 0 ? 100 : 0
  return ((current - previous) / Math.abs(previous)) * 100
}

function finalizeMetrics(sessionMetrics, conversionMetrics) {
  const metrics = { ...sessionMetrics, ...conversionMetrics }
  metrics.conversionRate = metrics.uniqueVisitors > 0
    ? (metrics.registrations / metrics.uniqueVisitors) * 100
    : 0
  metrics.avgPagePerSession = metrics.uniqueSessions > 0
    ? metrics.pageViews / metrics.uniqueSessions
    : 0
  return metrics
}

async function computeTrackingAnalyticsSummary({
  start,
  end,
  requestedGroupBy,
  normalizedFilters,
  range,
  appliedGroupBy,
  includeFacets,
  signal
}) {
  const previousRange = previousRangeFor(range)
  const siblingController = new AbortController()
  const linkedScope = createLinkedSummaryAbortScope([signal, siblingController.signal])
  const runQuery = callback => withTrackingSummaryQuerySlot(linkedScope.signal, callback)

  // Hasta tres carriles independientes reducen el tiempo de pared frente a seis
  // lecturas seriales. El core web usa sólo sesiones y conversiones; callers
  // legacy pueden sumar facetas. Cada carril conserva su orden y todos pasan por un
  // semáforo global de dos consultas: ni un build ni varios builds simultáneos
  // pueden abrir más de dos agregados pesados contra PostgreSQL.
  const sessionLane = (async () => ({
    current: await runQuery(() => querySessionMetrics(
      range,
      normalizedFilters,
      appliedGroupBy,
      { includeSeries: true, signal: linkedScope.signal }
    )),
    previous: await runQuery(() => querySessionMetrics(
      previousRange,
      normalizedFilters,
      appliedGroupBy,
      { includeSeries: false, signal: linkedScope.signal }
    ))
  }))()
  const conversionLane = (async () => ({
    current: await runQuery(() => queryConversionMetrics(
      range,
      normalizedFilters,
      appliedGroupBy,
      { includeSeries: true, signal: linkedScope.signal }
    )),
    previous: await runQuery(() => queryConversionMetrics(
      previousRange,
      normalizedFilters,
      appliedGroupBy,
      { includeSeries: false, signal: linkedScope.signal }
    ))
  }))()
  // El frontend puede sacar las facetas de la apertura inicial. En ese caso ni
  // siquiera se crea la promesa del carril: no hay SQL plano, jerarquía ni
  // trabajo en cola escondido después de responder el core.
  const lanes = [sessionLane, conversionLane]
  if (includeFacets) {
    lanes.push(querySessionFacets(
      range,
      normalizedFilters,
      linkedScope.signal,
      runQuery
    ))
  }

  let laneResults
  try {
    laneResults = await Promise.all(lanes)
  } catch (error) {
    // Si un carril falla, cancelar y esperar los hermanos evita consultas
    // huérfanas consumiendo conexiones después de que el request ya terminó.
    if (!siblingController.signal.aborted) siblingController.abort(error)
    await Promise.allSettled(lanes)
    throw error
  } finally {
    linkedScope.cleanup()
  }

  const [sessions, conversions, loadedFacets] = laneResults
  const facets = includeFacets ? loadedFacets : {}
  const currentSessions = sessions.current
  const previousSessions = sessions.previous
  const currentConversions = conversions.current
  const previousConversions = conversions.previous

  const current = finalizeMetrics(currentSessions.metrics, currentConversions.metrics)
  const previous = finalizeMetrics(previousSessions.metrics, previousConversions.metrics)
  const trends = Object.fromEntries(Object.keys(current).map(key => [key, trendValue(current[key], previous[key])]))
  const conversionFacets = [
    { value: 'prospect', label: 'Prospectos', count: current.prospects },
    { value: 'appointment_scheduled', label: 'Citas agendadas', count: currentConversions.stageCounts.appointmentScheduled },
    { value: 'appointment_attended', label: 'Citas atendidas', count: currentConversions.stageCounts.appointmentAttended },
    { value: 'customer', label: 'Clientes', count: current.customers }
  ]
  facets.conversions = conversionFacets

  return {
    range: {
      start,
      end,
      previousStart: previousRange.startDate,
      previousEnd: previousRange.endDate,
      timezone: range.timezone,
      requestedGroupBy,
      groupBy: appliedGroupBy
    },
    metrics: { current, previous, trends },
    trafficSeries: currentSessions.series,
    conversionSeries: currentConversions.series,
    distributions: includeFacets
      ? {
          sources: facets.sources.slice(0, 5),
          placements: facets.placements.slice(0, 5),
          devices: facets.devices.slice(0, 5),
          browsers: facets.browsers.slice(0, 5),
          os: facets.os.slice(0, 5),
          channels: facets.trafficChannels.slice(0, 5),
          trackingSources: facets.trackingSources.slice(0, 5),
          topVisitors: facets.topVisitors.slice(0, 5)
        }
      : {},
    facets
  }
}

function stableFilterCacheKey(filters) {
  return Object.keys(filters)
    .sort()
    .map(field => [field, [...filters[field]].sort()])
}

function trackingSnapshotMetadata({
  exactAtBuiltAt,
  builtAt,
  builtRevision,
  currentRevision,
  cacheTtlMs = SUMMARY_CACHE_TTL_MS,
  maxStaleAgeMs = SUMMARY_CACHE_STALE_WHILE_REVALIDATE_MS
}) {
  const revisionChanged = builtRevision !== currentRevision
  const revalidateAfterMs = exactAtBuiltAt && revisionChanged
    ? Date.now()
    : builtAt + cacheTtlMs
  return {
    stale: !exactAtBuiltAt || revisionChanged || Date.now() >= revalidateAfterMs,
    consistency: exactAtBuiltAt ? 'exact' : 'moving-window',
    exactAtBuiltAt: Boolean(exactAtBuiltAt),
    builtAt: new Date(builtAt).toISOString(),
    builtRevision: Number(builtRevision || 0),
    revision: Number(currentRevision || 0),
    revalidateAfter: new Date(revalidateAfterMs).toISOString(),
    maxStaleAgeMs
  }
}

function readSummaryCache(key, revision) {
  const cached = summaryCache.get(key)
  if (!cached) return null
  const age = Date.now() - cached.fetchedAt
  if (age >= SUMMARY_CACHE_STALE_WHILE_REVALIDATE_MS) {
    summaryCache.delete(key)
    return null
  }

  // Map conserva orden de inserción: mover al final implementa un LRU pequeño.
  summaryCache.delete(key)
  summaryCache.set(key, cached)
  const metadata = trackingSnapshotMetadata({
    exactAtBuiltAt: cached.exactAtBuiltAt,
    builtAt: cached.fetchedAt,
    builtRevision: cached.revision,
    currentRevision: revision
  })
  const data = age < SUMMARY_CACHE_TTL_MS && cached.revision === revision
    ? cached.data
    : { ...cached.data, snapshot: metadata }
  return {
    data,
    stale: metadata.stale,
    refreshDue: age >= SUMMARY_CACHE_TTL_MS || (
      cached.exactAtBuiltAt && cached.revision !== revision
    )
  }
}

function writeSummaryCache(key, data, revision, { exactAtBuiltAt = true } = {}) {
  const fetchedAt = Date.now()
  const snapshot = trackingSnapshotMetadata({
    exactAtBuiltAt,
    builtAt: fetchedAt,
    builtRevision: revision,
    currentRevision: revision
  })
  const snapshotData = { ...data, snapshot }
  summaryCache.set(key, {
    data: snapshotData,
    fetchedAt,
    revision,
    exactAtBuiltAt: Boolean(exactAtBuiltAt)
  })
  while (summaryCache.size > SUMMARY_CACHE_MAX_ENTRIES) {
    summaryCache.delete(summaryCache.keys().next().value)
  }
  return snapshotData
}

function readFacetCache(key, revision) {
  const cached = facetCache.get(key)
  if (!cached) return null
  const age = Date.now() - cached.fetchedAt
  if (age >= FACET_CACHE_STALE_WHILE_REVALIDATE_MS) {
    facetCache.delete(key)
    return null
  }

  facetCache.delete(key)
  facetCache.set(key, cached)
  const metadata = trackingSnapshotMetadata({
    exactAtBuiltAt: cached.exactAtBuiltAt,
    builtAt: cached.fetchedAt,
    builtRevision: cached.revision,
    currentRevision: revision,
    cacheTtlMs: FACET_CACHE_TTL_MS,
    maxStaleAgeMs: FACET_CACHE_STALE_WHILE_REVALIDATE_MS
  })
  const data = age < FACET_CACHE_TTL_MS && cached.revision === revision
    ? cached.data
    : { ...cached.data, snapshot: metadata }
  return {
    data,
    refreshDue: age >= FACET_CACHE_TTL_MS || (
      cached.exactAtBuiltAt && cached.revision !== revision
    )
  }
}

function writeFacetCache(key, data, revision, { exactAtBuiltAt = true } = {}) {
  const fetchedAt = Date.now()
  const snapshot = trackingSnapshotMetadata({
    exactAtBuiltAt,
    builtAt: fetchedAt,
    builtRevision: revision,
    currentRevision: revision,
    cacheTtlMs: FACET_CACHE_TTL_MS,
    maxStaleAgeMs: FACET_CACHE_STALE_WHILE_REVALIDATE_MS
  })
  const snapshotData = { ...data, snapshot }
  facetCache.set(key, {
    data: snapshotData,
    fetchedAt,
    revision,
    exactAtBuiltAt: Boolean(exactAtBuiltAt)
  })
  while (facetCache.size > FACET_CACHE_MAX_ENTRIES) {
    facetCache.delete(facetCache.keys().next().value)
  }
  return snapshotData
}

export function clearTrackingAnalyticsSummaryCache() {
  summaryCache.clear()
  for (const record of summaryInflight.values()) record?.controller?.abort()
  summaryInflight.clear()
  facetCache.clear()
  for (const record of facetInflight.values()) record?.controller?.abort()
  facetInflight.clear()
  invalidateTrackingAnalyticsCache()
}

function createSummaryQueryDeadline() {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    const reason = new Error('El resumen de Analíticas excedió el presupuesto de ejecución')
    reason.code = 'tracking_analytics_deadline'
    controller.abort(reason)
  }, SUMMARY_QUERY_DEADLINE_MS)
  timer.unref?.()
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer)
  }
}

function createFacetQueryDeadline() {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    const reason = new Error('La faceta de Analíticas excedió el presupuesto de ejecución')
    reason.code = 'tracking_analytics_facet_deadline'
    controller.abort(reason)
  }, FACET_QUERY_DEADLINE_MS)
  timer.unref?.()
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer)
  }
}

function trackingSummaryDeadlineError() {
  const error = new Error('El resumen tardó demasiado y fue cancelado para proteger la estabilidad del CRM. Intenta nuevamente.')
  error.status = 503
  error.code = 'tracking_analytics_deadline'
  return error
}

function trackingSummaryBusyError() {
  const error = new Error('Analíticas ya está procesando otras consultas. Intenta nuevamente en unos segundos.')
  error.status = 503
  error.code = 'tracking_analytics_busy'
  return error
}

function trackingFacetDeadlineError() {
  const error = new Error('La faceta tardó demasiado y fue cancelada para proteger la estabilidad del CRM. Intenta nuevamente.')
  error.status = 503
  error.code = 'tracking_analytics_facet_deadline'
  return error
}

function trackingFacetBusyError() {
  const error = new Error('Analíticas ya está procesando otra faceta. Intenta nuevamente en unos segundos.')
  error.status = 503
  error.code = 'tracking_analytics_facet_busy'
  return error
}

function trackingSummaryAbortError() {
  const error = new Error('La consulta de Analíticas fue cancelada')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  error.status = 499
  return error
}

function throwIfTrackingSummaryAborted(signal) {
  if (signal?.aborted) throw trackingSummaryAbortError()
}

async function withTrackingSummaryQuerySlot(signal, callback) {
  throwIfTrackingSummaryAborted(signal)
  if (activeSummaryQueries >= SUMMARY_MAX_CONCURRENT_QUERIES) {
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null }
      waiter.onAbort = () => {
        const index = summaryQueryWaiters.indexOf(waiter)
        if (index >= 0) summaryQueryWaiters.splice(index, 1)
        reject(trackingSummaryAbortError())
      }
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      summaryQueryWaiters.push(waiter)
      // AbortSignal no reproduce un evento ya ocurrido. Cerrar esta carrera
      // evita dejar una Promise en cola para siempre si abortó entre el primer
      // chequeo y el registro del listener.
      if (signal?.aborted) waiter.onAbort()
    })
  } else {
    activeSummaryQueries += 1
  }

  try {
    throwIfTrackingSummaryAborted(signal)
    return await callback()
  } finally {
    let next = null
    while ((next = summaryQueryWaiters.shift() || null)) {
      next.signal?.removeEventListener('abort', next.onAbort)
      if (next.signal?.aborted) {
        next.reject(trackingSummaryAbortError())
        continue
      }
      next.resolve()
      break
    }
    if (!next) {
      activeSummaryQueries = Math.max(0, activeSummaryQueries - 1)
    }
  }
}

async function withTrackingFacetBuildSlot(signal, callback) {
  throwIfTrackingSummaryAborted(signal)
  if (activeFacetBuilds >= FACET_MAX_CONCURRENT_BUILDS) {
    if (facetBuildWaiters.length >= FACET_MAX_QUEUED_BUILDS) {
      throw trackingFacetBusyError()
    }
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null }
      waiter.onAbort = () => {
        const index = facetBuildWaiters.indexOf(waiter)
        if (index >= 0) facetBuildWaiters.splice(index, 1)
        reject(trackingSummaryAbortError())
      }
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      facetBuildWaiters.push(waiter)
      if (signal?.aborted) waiter.onAbort()
    })
  } else {
    activeFacetBuilds += 1
  }

  try {
    throwIfTrackingSummaryAborted(signal)
    // La compuerta singular se adquiere antes del semáforo global. La faceta
    // sólo ocupa uno de los dos carriles compartidos y deja avanzar el core.
    return await withTrackingSummaryQuerySlot(signal, callback)
  } finally {
    let next = null
    while ((next = facetBuildWaiters.shift() || null)) {
      next.signal?.removeEventListener('abort', next.onAbort)
      if (next.signal?.aborted) {
        next.reject(trackingSummaryAbortError())
        continue
      }
      next.resolve()
      break
    }
    if (!next) activeFacetBuilds = Math.max(0, activeFacetBuilds - 1)
  }
}

async function withTrackingSummaryBuildSlot(signal, callback) {
  throwIfTrackingSummaryAborted(signal)
  if (activeSummaryBuilds >= SUMMARY_MAX_CONCURRENT_BUILDS) {
    if (summaryBuildWaiters.length >= SUMMARY_MAX_QUEUED_BUILDS) {
      throw trackingSummaryBusyError()
    }
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null }
      waiter.onAbort = () => {
        const index = summaryBuildWaiters.indexOf(waiter)
        if (index >= 0) summaryBuildWaiters.splice(index, 1)
        reject(trackingSummaryAbortError())
      }
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      summaryBuildWaiters.push(waiter)
      if (signal?.aborted) waiter.onAbort()
    })
  } else {
    activeSummaryBuilds += 1
  }

  try {
    throwIfTrackingSummaryAborted(signal)
    return await callback()
  } finally {
    let next = null
    while ((next = summaryBuildWaiters.shift() || null)) {
      next.signal?.removeEventListener('abort', next.onAbort)
      if (next.signal?.aborted) {
        next.reject(trackingSummaryAbortError())
        continue
      }
      next.resolve()
      break
    }
    if (!next) {
      activeSummaryBuilds = Math.max(0, activeSummaryBuilds - 1)
    }
  }
}

function createLinkedSummaryAbortScope(signals) {
  const controller = new AbortController()
  const listeners = []
  for (const signal of signals.filter(Boolean)) {
    const onAbort = () => controller.abort(signal.reason)
    if (signal.aborted) onAbort()
    else {
      signal.addEventListener('abort', onAbort, { once: true })
      listeners.push([signal, onAbort])
    }
  }
  return {
    signal: controller.signal,
    cleanup() {
      for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener)
    }
  }
}

function cancelUnusedTrackingSummaryBuild(record, cacheKey) {
  if (record.keepAlive || record.waiters > 0 || record.controller.signal.aborted) return
  record.controller.abort()
  if (summaryInflight.get(cacheKey) === record) summaryInflight.delete(cacheKey)
  void record.promise.catch(() => undefined)
}

function cancelOneBackgroundTrackingSummaryBuild() {
  for (const [key, record] of summaryInflight.entries()) {
    if (!record.keepAlive || record.waiters > 0 || record.controller.signal.aborted) continue
    record.controller.abort()
    if (summaryInflight.get(key) === record) summaryInflight.delete(key)
    void record.promise.catch(() => undefined)
    return true
  }
  return false
}

function waitForTrackingSummaryBuild(record, signal, cacheKey) {
  if (signal?.aborted) {
    cancelUnusedTrackingSummaryBuild(record, cacheKey)
    throw trackingSummaryAbortError()
  }
  record.waiters += 1

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      record.waiters = Math.max(0, record.waiters - 1)
      callback(value)
    }
    const onAbort = () => {
      finish(reject, trackingSummaryAbortError())
      cancelUnusedTrackingSummaryBuild(record, cacheKey)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    record.promise.then(
      result => finish(resolve, result),
      error => finish(reject, error)
    )
  })
}

function cancelUnusedTrackingFacetBuild(record, cacheKey) {
  if (record.keepAlive || record.waiters > 0 || record.controller.signal.aborted) return
  record.controller.abort()
  if (facetInflight.get(cacheKey) === record) facetInflight.delete(cacheKey)
  void record.promise.catch(() => undefined)
}

function waitForTrackingFacetBuild(record, signal, cacheKey) {
  if (signal?.aborted) {
    cancelUnusedTrackingFacetBuild(record, cacheKey)
    throw trackingSummaryAbortError()
  }
  record.waiters += 1

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      record.waiters = Math.max(0, record.waiters - 1)
      callback(value)
    }
    const onAbort = () => {
      finish(reject, trackingSummaryAbortError())
      cancelUnusedTrackingFacetBuild(record, cacheKey)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    record.promise.then(
      result => finish(resolve, result),
      error => finish(reject, error)
    )
  })
}

export async function getTrackingAnalyticsSummary({
  start,
  end,
  groupBy = 'day',
  filters = {},
  includeFacets = true,
  allowStale = false,
  signal
} = {}) {
  throwIfTrackingSummaryAborted(signal)
  const normalizedFilters = normalizeTrackingAnalyticsFilters(filters)
  const range = await resolveAnalyticsRange(start, end, signal)
  throwIfTrackingSummaryAborted(signal)
  const requestedGroupBy = ALLOWED_GROUPS.has(groupBy) ? groupBy : 'day'
  const appliedGroupBy = effectiveGroupBy(requestedGroupBy, range)
  const revision = getTrackingAnalyticsCacheRevision()
  const cacheKey = JSON.stringify({
    start,
    end,
    timezone: range.timezone,
    groupBy: appliedGroupBy,
    includeFacets: includeFacets !== false,
    filters: stableFilterCacheKey(normalizedFilters)
  })
  const cached = readSummaryCache(cacheKey, revision)
  // Una reconstruccion que cruza escrituras nunca se declara exacta, pero
  // tampoco vuelve a dispararse en cada request. Durante 30 s se sirve como
  // moving-window; despues, una sola lectura compartida intenta avanzarla.
  if (cached && !cached.refreshDue) {
    return cached.data
  }

  // SWR nunca entra a la cola detrás de otro trabajo. Bajo presión se devuelve
  // el snapshot stale de inmediato y una lectura de usuario sin snapshot puede
  // desplazar una revalidación huérfana para no quedar detrás de ella.
  if (cached && allowStale && !summaryInflight.has(cacheKey) && activeSummaryBuilds >= SUMMARY_MAX_CONCURRENT_BUILDS) {
    return cached.data
  }
  if ((!cached || !allowStale) && activeSummaryBuilds >= SUMMARY_MAX_CONCURRENT_BUILDS) {
    cancelOneBackgroundTrackingSummaryBuild()
  }

  let record = summaryInflight.get(cacheKey)
  if (record?.controller?.signal?.aborted) {
    if (summaryInflight.get(cacheKey) === record) summaryInflight.delete(cacheKey)
    void record.promise.catch(() => undefined)
    record = null
  }
  if (!record) {
    record = {
      controller: new AbortController(),
      keepAlive: Boolean(cached && allowStale),
      waiters: 0,
      promise: null
    }
    const deadline = createSummaryQueryDeadline()
    const linkedScope = createLinkedSummaryAbortScope([
      record.controller.signal,
      deadline.signal
    ])
    record.promise = withTrackingSummaryBuildSlot(linkedScope.signal, () => (
      computeTrackingAnalyticsSummary({
        start,
        end,
        requestedGroupBy,
        normalizedFilters,
        range,
        appliedGroupBy,
        includeFacets: includeFacets !== false,
        signal: linkedScope.signal
      })
    )).then((data) => {
      const completedRevision = getTrackingAnalyticsCacheRevision()
      const changedDuringBuild = completedRevision !== revision
      // No declarar fresco un agregado que cruzó escrituras. Se conserva como
      // snapshot SWR para pintar sin bloquear. Si el stream sigue escribiendo,
      // el siguiente intento queda coalescido por una ventana acotada.
      return writeSummaryCache(cacheKey, data, completedRevision, {
        exactAtBuiltAt: !changedDuringBuild
      })
    }).catch((error) => {
      if (deadline.signal.aborted && !record.controller.signal.aborted) {
        throw trackingSummaryDeadlineError()
      }
      throw error
    }).finally(() => {
      linkedScope.cleanup()
      deadline.cleanup()
      if (summaryInflight.get(cacheKey) === record) summaryInflight.delete(cacheKey)
    })
    summaryInflight.set(cacheKey, record)
  }

  if (cached && allowStale) {
    record.keepAlive = true
    // Evita un rechazo no observado cuando el navegador ya recibio el snapshot
    // anterior. La siguiente lectura volvera a intentar si la revalidacion falla.
    void record.promise.catch(() => undefined)
    return cached.data
  }

  return waitForTrackingSummaryBuild(record, signal, cacheKey)
}

function cancelOneBackgroundTrackingFacetBuild() {
  for (const [key, record] of facetInflight.entries()) {
    if (!record.keepAlive || record.waiters > 0 || record.controller.signal.aborted) continue
    record.controller.abort()
    if (facetInflight.get(key) === record) facetInflight.delete(key)
    void record.promise.catch(() => undefined)
    return true
  }
  return false
}

export async function getTrackingAnalyticsFacet({
  start,
  end,
  filters = {},
  dimension,
  allowStale = false,
  signal
} = {}) {
  throwIfTrackingSummaryAborted(signal)
  const normalizedDimension = normalizeTrackingAnalyticsFacetDimension(dimension)
  const normalizedFilters = normalizeTrackingAnalyticsFilters(filters)
  const range = await resolveAnalyticsRange(start, end, signal)
  throwIfTrackingSummaryAborted(signal)
  const revision = getTrackingAnalyticsCacheRevision()
  const cacheKey = JSON.stringify({
    start: range.startDate,
    end: range.endDate,
    timezone: range.timezone,
    filters: stableFilterCacheKey(normalizedFilters),
    dimension: normalizedDimension
  })
  const cached = readFacetCache(cacheKey, revision)
  if (cached && !cached.refreshDue) return cached.data

  // Una revalidación SWR jamás forma una cola de facetas por sí sola. Si hay
  // trabajo activo se sirve el snapshot honesto; una petición fría puede
  // desplazar una revalidación sin consumidores.
  if (cached && allowStale && !facetInflight.has(cacheKey) && activeFacetBuilds >= FACET_MAX_CONCURRENT_BUILDS) {
    return cached.data
  }
  if ((!cached || !allowStale) && activeFacetBuilds >= FACET_MAX_CONCURRENT_BUILDS) {
    cancelOneBackgroundTrackingFacetBuild()
  }

  let record = facetInflight.get(cacheKey)
  if (record?.controller?.signal?.aborted) {
    if (facetInflight.get(cacheKey) === record) facetInflight.delete(cacheKey)
    void record.promise.catch(() => undefined)
    record = null
  }
  if (!record) {
    record = {
      controller: new AbortController(),
      keepAlive: Boolean(cached && allowStale),
      waiters: 0,
      promise: null
    }
    const deadline = createFacetQueryDeadline()
    const linkedScope = createLinkedSummaryAbortScope([
      record.controller.signal,
      deadline.signal
    ])
    record.promise = withTrackingFacetBuildSlot(linkedScope.signal, async () => {
      const items = await queryTrackingAnalyticsFacet(
        range,
        normalizedFilters,
        normalizedDimension,
        linkedScope.signal
      )
      return {
        range: {
          start: range.startDate,
          end: range.endDate,
          timezone: range.timezone
        },
        facet: {
          dimension: normalizedDimension,
          items
        }
      }
    }).then((data) => {
      const completedRevision = getTrackingAnalyticsCacheRevision()
      return writeFacetCache(cacheKey, data, completedRevision, {
        exactAtBuiltAt: completedRevision === revision
      })
    }).catch((error) => {
      if (deadline.signal.aborted && !record.controller.signal.aborted) {
        throw trackingFacetDeadlineError()
      }
      throw error
    }).finally(() => {
      linkedScope.cleanup()
      deadline.cleanup()
      if (facetInflight.get(cacheKey) === record) facetInflight.delete(cacheKey)
    })
    facetInflight.set(cacheKey, record)
  }

  if (cached && allowStale) {
    record.keepAlive = true
    void record.promise.catch(() => undefined)
    return cached.data
  }

  return waitForTrackingFacetBuild(record, signal, cacheKey)
}

export const TRACKING_ANALYTICS_BUILD_LIMITS = Object.freeze({
  maxConcurrentBuilds: SUMMARY_MAX_CONCURRENT_BUILDS,
  maxConcurrentQueries: SUMMARY_MAX_CONCURRENT_QUERIES,
  maxQueuedBuilds: SUMMARY_MAX_QUEUED_BUILDS,
  queryDeadlineMs: SUMMARY_QUERY_DEADLINE_MS,
  coalesceWindowMs: SUMMARY_CACHE_TTL_MS,
  maxStaleAgeMs: SUMMARY_CACHE_STALE_WHILE_REVALIDATE_MS
})

export const TRACKING_ANALYTICS_FACET_LIMITS = Object.freeze({
  dimensions: TRACKING_ANALYTICS_FACET_DIMENSIONS,
  maxItems: FACET_LIMIT,
  maxConcurrentBuilds: FACET_MAX_CONCURRENT_BUILDS,
  maxQueuedBuilds: FACET_MAX_QUEUED_BUILDS,
  queryDeadlineMs: FACET_QUERY_DEADLINE_MS,
  coalesceWindowMs: FACET_CACHE_TTL_MS,
  maxStaleAgeMs: FACET_CACHE_STALE_WHILE_REVALIDATE_MS,
  maxCacheEntries: FACET_CACHE_MAX_ENTRIES
})

function normalizeSearchColumn(column) {
  const normalized = normalizeText(column || 'all', 40) || 'all'
  if (!SEARCHABLE_COLUMNS.has(normalized)) throw requestError(`Columna de búsqueda no soportada: ${normalized}`)
  return normalized
}

export function buildTrackingSearchDocumentExpression(alias = '') {
  const prefix = alias ? `${alias}.` : ''
  return `LOWER(${DEFAULT_SEARCH_COLUMNS
    .map(column => `COALESCE(${prefix}${column}, '')`)
    .join(" || ' ' || ")})`
}

function buildSearchCondition(q, column, alias, params) {
  const normalizedQuery = normalizeText(q, MAX_SEARCH_LENGTH)
  if (!normalizedQuery) return null

  const pattern = `%${normalizedQuery.toLowerCase()}%`
  if (column === 'all' && databaseDialect === 'postgres') {
    params.push(pattern)
    return `${buildTrackingSearchDocumentExpression(alias)} LIKE ?`
  }

  const columns = column === 'all' ? DEFAULT_SEARCH_COLUMNS : [column]
  const conditions = columns.map((field) => {
    const expression = field === 'adset_id'
      ? `COALESCE(NULLIF(${alias}.adset_id, ''), ${alias}.ad_group_id)`
      : `${alias}.${field}`
    params.push(pattern)
    return `LOWER(COALESCE(CAST(${expression} AS TEXT), '')) LIKE ?`
  })
  return `(${conditions.join(' OR ')})`
}

function trackingSearchCursorScope({ range, filters, q, column }) {
  const canonicalFilters = Object.fromEntries(Object.entries(filters || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([field, values]) => [field, [...(values || [])].map(String).sort()]))

  return createHash('sha256').update(JSON.stringify({
    kind: 'tracking-sessions',
    startUtc: range.startUtc,
    endExclusiveUtc: range.endExclusiveUtc,
    filters: canonicalFilters,
    q: normalizeText(q, MAX_SEARCH_LENGTH).toLowerCase(),
    column
  })).digest('base64url')
}

function decodeCursor(cursor, expectedScope) {
  if (!cursor) return null
  if (typeof cursor === 'object' && !Array.isArray(cursor)) {
    const startedAt = normalizeText(cursor.startedAt || cursor.started_at, 100)
    const id = normalizeText(cursor.id, 100)
    if (!startedAt || !id) throw requestError('Cursor de sesiones inválido')
    if (cursor.v !== undefined && cursor.v !== 2) throw requestError('Cursor de sesiones inválido')
    if (cursor.v === 2 && (cursor.kind !== 'tracking-sessions' || cursor.scope !== expectedScope)) {
      throw requestError('El cursor de sesiones no corresponde a esta búsqueda')
    }
    return { startedAt, id }
  }

  const cleanCursor = String(cursor).trim()
  if (cleanCursor.length > 2048) throw requestError('Cursor de sesiones inválido')
  try {
    const payload = JSON.parse(Buffer.from(cleanCursor, 'base64url').toString('utf8'))
    if (payload.v !== undefined && payload.v !== 2) throw requestError('Cursor de sesiones inválido')
    if (payload.v === 2 && (payload.kind !== 'tracking-sessions' || payload.scope !== expectedScope)) {
      throw requestError('El cursor de sesiones no corresponde a esta búsqueda')
    }
    const startedAt = normalizeText(payload.startedAt, 100)
    const id = normalizeText(payload.id, 100)
    if (!startedAt || !id) throw new Error('missing cursor fields')
    return { startedAt, id }
  } catch (error) {
    if (error?.status === 400) throw error
    throw requestError('Cursor de sesiones inválido')
  }
}

function cursorTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  return normalizeText(value, 100)
}

function encodeCursor(row, scope) {
  return Buffer.from(JSON.stringify({
    v: 2,
    kind: 'tracking-sessions',
    scope,
    startedAt: cursorTimestamp(row.cursor_started_at ?? row.started_at),
    id: String(row.id)
  })).toString('base64url')
}

function trackingCursorProjection(expression) {
  return databaseDialect === 'postgres' ? `CAST(${expression} AS TEXT)` : expression
}

function boundedSearchRow(row) {
  const result = {}
  for (const [key, value] of Object.entries(row || {})) {
    if (key === 'cursor_started_at') continue
    if (typeof value !== 'string') {
      result[key] = value
      continue
    }

    const limit = key === 'page_url' || key === 'referrer_url'
      ? 2048
      : key === 'email'
        ? 320
        : key === 'full_name' || key.endsWith('_name')
          ? 500
          : MAX_FILTER_VALUE_LENGTH
    result[key] = value.slice(0, limit)
  }
  return result
}

const sessionSearchProjection = (alias = 's') => `
  ${alias}.id,
  ${alias}.session_id,
  ${alias}.visitor_id,
  ${alias}.contact_id,
  ${alias}.full_name,
  ${alias}.email,
  ${alias}.event_name,
  ${alias}.started_at,
  ${alias}.page_url,
  ${alias}.referrer_url,
  ${alias}.utm_source,
  ${alias}.utm_medium,
  ${alias}.utm_campaign,
  ${alias}.utm_content,
  ${alias}.channel,
  ${alias}.source_platform,
  ${alias}.campaign_id,
  ${alias}.adset_id,
  ${alias}.ad_group_id,
  ${alias}.ad_id,
  ${alias}.placement,
  ${alias}.device_type,
  ${alias}.os,
  ${alias}.browser,
  ${alias}.geo_country,
  ${alias}.geo_city,
  ${alias}.tracking_source,
  ${alias}.site_id,
  ${alias}.site_name,
  ${alias}.site_type,
  ${alias}.form_site_id,
  ${alias}.form_site_name,
  ${alias}.conversion_type,
  ${trackingCursorProjection(`${alias}.started_at`)} AS cursor_started_at
`

function searchResultProjection(sessionAlias, contactAlias = 'cf') {
  return `
    ${sessionSearchProjection(sessionAlias)},
    ${contactAlias}.contact_created_at,
    COALESCE(${contactAlias}.payment_count, 0) AS contact_purchases_count,
    COALESCE(${contactAlias}.has_appointment, 0) AS contact_has_appointment,
    COALESCE(${contactAlias}.has_attendance, 0) AS contact_has_attended_appointment,
    ${contactStageExpression(contactAlias)} AS conversion_stage
  `
}

function formatSearchItems(rows) {
  return rows.map(row => ({
    ...boundedSearchRow(row),
    contact_purchases_count: integerValue(row.contact_purchases_count),
    contact_has_appointment: integerValue(row.contact_has_appointment),
    contact_has_attended_appointment: integerValue(row.contact_has_attended_appointment)
  }))
}

async function queryStageSearchCandidateChunk({
  range,
  filters,
  q,
  column,
  cursor,
  limit,
  signal
}) {
  const params = [range.startUtc, range.endExclusiveUtc]
  const conditions = [`s.started_at >= ?`, `s.started_at < ?`]
  conditions.push(...buildSessionFilterConditions(withoutConversionStage(filters), 's', params))

  const searchCondition = buildSearchCondition(q, column, 's', params)
  if (searchCondition) conditions.push(searchCondition)
  if (cursor) {
    conditions.push(`(s.started_at, s.id) < (?, ?)`)
    params.push(cursor.startedAt, cursor.id)
  }
  params.push(limit)

  return db.all(`
    /* tracking-stage-candidate-chunk */
    SELECT ${sessionSearchProjection('s')}
    FROM sessions s
    WHERE ${conditions.join(' AND ')}
    ORDER BY s.started_at DESC, s.id DESC
    LIMIT ?
  `, params, { signal })
}

async function queryStageContactFacts(candidateRows, conversionStages, signal) {
  const contactIds = [...new Set(candidateRows
    .map(row => normalizeText(row.contact_id, 180))
    .filter(Boolean))]
  if (contactIds.length === 0) return new Map()

  const params = [...contactIds]
  const stageCondition = valueListCondition(contactStageExpression('cf'), conversionStages, params)
  const valuesSql = contactIds.map(() => '(?)').join(', ')
  const rows = await db.all(`
    WITH
    candidate_contact_ids(contact_id) AS (
      VALUES ${valuesSql}
    ),
    ${contactFactsCtes('candidate_contact_ids')}
    SELECT
      cf.contact_id,
      cf.contact_created_at,
      cf.payment_count AS contact_purchases_count,
      cf.has_appointment AS contact_has_appointment,
      cf.has_attendance AS contact_has_attended_appointment,
      ${contactStageExpression('cf')} AS conversion_stage
    FROM contact_facts cf
    WHERE ${stageCondition}
  `, params, { signal })

  return new Map(rows.map(row => [String(row.contact_id), row]))
}

async function searchTrackingSessionsByStage({
  range,
  filters,
  q,
  column,
  cursor,
  limit,
  cursorScope,
  signal
}) {
  const conversionStages = filters.conversion_stage || []
  const matches = []
  let scanned = 0
  let scanCursor = cursor
  let lastConsumedCandidate = null
  let exhausted = false

  while (scanned < STAGE_SEARCH_MAX_SCAN) {
    signal?.throwIfAborted?.()
    const chunkLimit = Math.min(STAGE_SEARCH_CHUNK_SIZE, STAGE_SEARCH_MAX_SCAN - scanned)
    const candidates = await queryStageSearchCandidateChunk({
      range,
      filters,
      q,
      column,
      cursor: scanCursor,
      limit: chunkLimit,
      signal
    })

    if (candidates.length === 0) {
      exhausted = true
      break
    }

    const factsByContactId = await queryStageContactFacts(candidates, conversionStages, signal)
    for (const candidate of candidates) {
      const facts = factsByContactId.get(String(candidate.contact_id || ''))
      if (facts && matches.length >= limit) {
        // Este match sólo confirma que existe otra página. No se consume: el
        // cursor queda en el candidato anterior para que el siguiente request
        // pueda devolverlo sin saltos.
        return {
          items: formatSearchItems(matches),
          limit,
          hasMore: true,
          nextCursor: lastConsumedCandidate ? encodeCursor(lastConsumedCandidate, cursorScope) : null
        }
      }

      scanned += 1
      lastConsumedCandidate = candidate
      if (facts) matches.push({ ...candidate, ...facts })
    }

    scanCursor = {
      startedAt: cursorTimestamp(
        candidates[candidates.length - 1].cursor_started_at
          ?? candidates[candidates.length - 1].started_at
      ),
      id: String(candidates[candidates.length - 1].id)
    }
    if (candidates.length < chunkLimit) {
      exhausted = true
      break
    }
  }

  const scanLimitReached = !exhausted && scanned >= STAGE_SEARCH_MAX_SCAN
  return {
    items: formatSearchItems(matches),
    limit,
    hasMore: scanLimitReached,
    nextCursor: scanLimitReached && lastConsumedCandidate
      ? encodeCursor(lastConsumedCandidate, cursorScope)
      : null
  }
}

export async function searchTrackingSessions({
  start,
  end,
  filters = {},
  q = '',
  column = 'all',
  cursor = null,
  limit = 50,
  signal
} = {}) {
  const normalizedFilters = normalizeTrackingAnalyticsFilters(filters)
  const normalizedQuery = normalizeText(q, MAX_SEARCH_LENGTH)
  const range = await resolveAnalyticsRange(start, end, signal)
  throwIfTrackingSummaryAborted(signal)
  const normalizedColumn = normalizeSearchColumn(column)
  if (normalizedQuery && normalizedQuery.length < MIN_SEARCH_LENGTH) {
    return {
      items: [],
      limit: Math.min(100, Math.max(20, Math.trunc(numberValue(limit)) || 50)),
      hasMore: false,
      nextCursor: null,
      searchMinLength: MIN_SEARCH_LENGTH
    }
  }
  const cursorScope = trackingSearchCursorScope({
    range,
    filters: normalizedFilters,
    q: normalizedQuery,
    column: normalizedColumn
  })
  const decodedCursor = decodeCursor(cursor, cursorScope)
  const normalizedLimit = Math.min(100, Math.max(20, Math.trunc(numberValue(limit)) || 50))
  const queryLimit = normalizedLimit + 1
  const conversionStages = normalizedFilters.conversion_stage || []

  if (conversionStages.length > 0) {
    return searchTrackingSessionsByStage({
      range,
      filters: normalizedFilters,
      q: normalizedQuery,
      column: normalizedColumn,
      cursor: decodedCursor,
      limit: normalizedLimit,
      cursorScope,
      signal
    })
  }

  const params = [range.startUtc, range.endExclusiveUtc]
  const conditions = [`s.started_at >= ?`, `s.started_at < ?`]
  conditions.push(...buildSessionFilterConditions(withoutConversionStage(normalizedFilters), 's', params))

  const searchCondition = buildSearchCondition(normalizedQuery, normalizedColumn, 's', params)
  if (searchCondition) conditions.push(searchCondition)
  if (decodedCursor) {
    conditions.push(`(s.started_at, s.id) < (?, ?)`)
    params.push(decodedCursor.startedAt, decodedCursor.id)
  }

  params.push(queryLimit)
  const sql = `
    WITH
    page_sessions AS (
      SELECT ${sessionSearchProjection('s')}
      FROM sessions s
      WHERE ${conditions.join(' AND ')}
      ORDER BY s.started_at DESC, s.id DESC
      LIMIT ?
    ),
    candidate_contact_ids AS (
      SELECT DISTINCT contact_id
      FROM page_sessions
      WHERE contact_id IS NOT NULL AND contact_id != ''
    ),
    ${contactFactsCtes('candidate_contact_ids')}
    SELECT ${searchResultProjection('page', 'cf')}
    FROM page_sessions page
    LEFT JOIN contact_facts cf ON cf.contact_id = page.contact_id
    ORDER BY page.started_at DESC, page.id DESC
  `

  const rows = await db.all(sql, params, { signal })
  const hasMore = rows.length > normalizedLimit
  const items = formatSearchItems(rows.slice(0, normalizedLimit))

  return {
    items,
    limit: normalizedLimit,
    hasMore,
    nextCursor: hasMore && items.length > 0
      ? encodeCursor(rows[normalizedLimit - 1], cursorScope)
      : null
  }
}
