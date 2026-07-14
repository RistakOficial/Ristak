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
const MAX_SEARCH_LENGTH = 200
const MAX_SERIES_POINTS = 400
const FACET_LIMIT = 25
const ADS_HIERARCHY_PLATFORM_LIMIT = 8
const ADS_HIERARCHY_CAMPAIGN_LIMIT = 8
const ADS_HIERARCHY_ADSET_LIMIT = 5
const ADS_HIERARCHY_AD_LIMIT = 5
const ADS_HIERARCHY_GLOBAL_LIMIT = 750
const STAGE_SEARCH_CHUNK_SIZE = 500
const STAGE_SEARCH_MAX_SCAN = 10_000
const SUMMARY_CACHE_TTL_MS = 30_000
const SUMMARY_CACHE_MAX_ENTRIES = 100
const summaryCache = new Map()
const summaryInflight = new Map()

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

async function resolveAnalyticsRange(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(start || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(end || ''))) {
    throw requestError('start y end deben usar el formato YYYY-MM-DD')
  }

  const resolved = await resolveDateRangeWithGHLTimezone({ startDate: start, endDate: end })
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

async function querySessionMetrics(range, filters, groupBy, { includeSeries }) {
  const params = []
  const filteredSessionsCte = buildFilteredSessionsCte(range, filters, params)

  if (!includeSeries) {
    const row = await db.get(`
      WITH
      ${filteredSessionsCte},
      view_sessions AS (
        SELECT * FROM filtered_sessions WHERE event_name IN (${viewEventSql})
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
    `, params)

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
  const rows = await db.all(`
    WITH
    ${filteredSessionsCte},
    view_sessions AS (
      SELECT *, ${periodExpression} AS period
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
  `, params)

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

async function queryConversionMetrics(range, filters, groupBy, { includeSeries }) {
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
  `, params)

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

async function queryPostgresSessionFacetsWithoutConversionFilter(range, filters) {
  const params = [range.startUtc, range.endExclusiveUtc]
  const identityExpression = getVisitorIdentityExpression('s')
  const dimensions = facetDimensionDefinitions('s', identityExpression)
  const conditions = [`s.started_at >= ?`, `s.started_at < ?`]
  conditions.push(...buildSessionFilterConditions(filters, 's', params))
  const dimensionCase = dimensions
    .map(([dimension, value]) => `WHEN GROUPING(${value}) = 0 THEN '${dimension}'`)
    .join('\n          ')
  const valueCase = dimensions
    .map(([, value]) => `WHEN GROUPING(${value}) = 0 THEN CAST(COALESCE(${value}, '') AS TEXT)`)
    .join('\n          ')
  const labelCase = dimensions
    .map(([, value, label]) => `WHEN GROUPING(${value}) = 0 THEN CAST(MAX(COALESCE(${label}, ${value}, '')) AS TEXT)`)
    .join('\n          ')
  const groupingSets = dimensions.map(([, value]) => `(${value})`).join(',\n        ')
  const topVisitorExpression = dimensions.find(([dimension]) => dimension === 'topVisitors')[1]

  const rows = await db.all(`
    WITH dimension_counts AS (
      SELECT
        CASE ${dimensionCase} END AS dimension,
        CASE ${valueCase} END AS value,
        CASE ${labelCase} END AS label,
        CASE
          WHEN GROUPING(${topVisitorExpression}) = 0 THEN COUNT(*)
          ELSE COUNT(DISTINCT ${identityExpression})
        END AS item_count
      FROM sessions s
      WHERE ${conditions.join(' AND ')}
      GROUP BY GROUPING SETS (
        ${groupingSets}
      )
    ),
    ranked_dimensions AS (
      SELECT
        dimension,
        value,
        label,
        item_count,
        ROW_NUMBER() OVER (PARTITION BY dimension ORDER BY item_count DESC, value ASC) AS item_rank
      FROM dimension_counts
      WHERE COALESCE(value, '') != ''
    )
    SELECT dimension, value, label, item_count
    FROM ranked_dimensions
    WHERE item_rank <= ${FACET_LIMIT}
    ORDER BY dimension ASC, item_rank ASC
  `, params)

  const facets = Object.fromEntries(dimensions.map(([dimension]) => [dimension, []]))
  for (const row of rows) facets[row.dimension]?.push(facetItem(row))
  return facets
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

async function queryAdsHierarchy(range, filters) {
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
  `, params)

  return buildAdsHierarchy(rows)
}

async function queryFlatSessionFacets(range, filters) {
  if (databaseDialect === 'postgres' && !filters.conversion_stage?.length) {
    return queryPostgresSessionFacetsWithoutConversionFilter(range, filters)
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
  `, params)

  const facets = Object.fromEntries(dimensions.map(([dimension]) => [dimension, []]))
  for (const row of rows) facets[row.dimension]?.push(facetItem(row))
  return facets
}

async function querySessionFacets(range, filters) {
  // La jerarquía corre dentro del mismo carril de facets: no abre una cuarta
  // consulta concurrente contra el pool cuando varios usuarios cargan Analytics.
  const facets = await queryFlatSessionFacets(range, filters)
  facets.adsHierarchy = await queryAdsHierarchy(range, filters)
  return facets
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
  appliedGroupBy
}) {
  const previousRange = previousRangeFor(range)

  // Tres carriles como máximo por petición: sesiones, conversiones y facets.
  // Dentro de cada carril el período anterior corre después del actual para no
  // comerse cinco conexiones del pool cuando varios usuarios abren Analytics.
  const [sessionResults, conversionResults, facets] = await Promise.all([
    (async () => ({
      current: await querySessionMetrics(range, normalizedFilters, appliedGroupBy, { includeSeries: true }),
      previous: await querySessionMetrics(previousRange, normalizedFilters, appliedGroupBy, { includeSeries: false })
    }))(),
    (async () => ({
      current: await queryConversionMetrics(range, normalizedFilters, appliedGroupBy, { includeSeries: true }),
      previous: await queryConversionMetrics(previousRange, normalizedFilters, appliedGroupBy, { includeSeries: false })
    }))(),
    querySessionFacets(range, normalizedFilters)
  ])
  const currentSessions = sessionResults.current
  const previousSessions = sessionResults.previous
  const currentConversions = conversionResults.current
  const previousConversions = conversionResults.previous

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
    distributions: {
      sources: facets.sources.slice(0, 5),
      placements: facets.placements.slice(0, 5),
      devices: facets.devices.slice(0, 5),
      browsers: facets.browsers.slice(0, 5),
      os: facets.os.slice(0, 5),
      channels: facets.trafficChannels.slice(0, 5),
      trackingSources: facets.trackingSources.slice(0, 5),
      topVisitors: facets.topVisitors.slice(0, 5)
    },
    facets
  }
}

function stableFilterCacheKey(filters) {
  return Object.keys(filters)
    .sort()
    .map(field => [field, [...filters[field]].sort()])
}

function readSummaryCache(key) {
  const cached = summaryCache.get(key)
  if (!cached) return null
  if (Date.now() - cached.fetchedAt >= SUMMARY_CACHE_TTL_MS) {
    summaryCache.delete(key)
    return null
  }

  // Map conserva orden de inserción: mover al final implementa un LRU pequeño.
  summaryCache.delete(key)
  summaryCache.set(key, cached)
  return cached.data
}

function writeSummaryCache(key, data) {
  summaryCache.set(key, { data, fetchedAt: Date.now() })
  while (summaryCache.size > SUMMARY_CACHE_MAX_ENTRIES) {
    summaryCache.delete(summaryCache.keys().next().value)
  }
}

export function clearTrackingAnalyticsSummaryCache() {
  summaryCache.clear()
  summaryInflight.clear()
  invalidateTrackingAnalyticsCache()
}

export async function getTrackingAnalyticsSummary({ start, end, groupBy = 'day', filters = {} } = {}) {
  const normalizedFilters = normalizeTrackingAnalyticsFilters(filters)
  const range = await resolveAnalyticsRange(start, end)
  const requestedGroupBy = ALLOWED_GROUPS.has(groupBy) ? groupBy : 'day'
  const appliedGroupBy = effectiveGroupBy(requestedGroupBy, range)
  const cacheKey = JSON.stringify({
    revision: getTrackingAnalyticsCacheRevision(),
    start,
    end,
    timezone: range.timezone,
    groupBy: appliedGroupBy,
    filters: stableFilterCacheKey(normalizedFilters)
  })
  const cached = readSummaryCache(cacheKey)
  if (cached) return cached
  if (summaryInflight.has(cacheKey)) return summaryInflight.get(cacheKey)

  const pending = computeTrackingAnalyticsSummary({
    start,
    end,
    requestedGroupBy,
    normalizedFilters,
    range,
    appliedGroupBy
  })
  summaryInflight.set(cacheKey, pending)

  try {
    const data = await pending
    writeSummaryCache(cacheKey, data)
    return data
  } finally {
    summaryInflight.delete(cacheKey)
  }
}

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

function decodeCursor(cursor) {
  if (!cursor) return null
  if (typeof cursor === 'object' && !Array.isArray(cursor)) {
    const startedAt = normalizeText(cursor.startedAt || cursor.started_at, 100)
    const id = normalizeText(cursor.id, 100)
    if (!startedAt || !id) throw requestError('Cursor de sesiones inválido')
    return { startedAt, id }
  }

  try {
    const payload = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'))
    const startedAt = normalizeText(payload.startedAt, 100)
    const id = normalizeText(payload.id, 100)
    if (!startedAt || !id) throw new Error('missing cursor fields')
    return { startedAt, id }
  } catch {
    throw requestError('Cursor de sesiones inválido')
  }
}

function cursorTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  return normalizeText(value, 100)
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({
    startedAt: cursorTimestamp(row.started_at),
    id: String(row.id)
  })).toString('base64url')
}

function boundedSearchRow(row) {
  const result = {}
  for (const [key, value] of Object.entries(row || {})) {
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
  ${alias}.conversion_type
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
  limit
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
  `, params)
}

async function queryStageContactFacts(candidateRows, conversionStages) {
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
  `, params)

  return new Map(rows.map(row => [String(row.contact_id), row]))
}

async function searchTrackingSessionsByStage({
  range,
  filters,
  q,
  column,
  cursor,
  limit
}) {
  const conversionStages = filters.conversion_stage || []
  const matches = []
  let scanned = 0
  let scanCursor = cursor
  let lastConsumedCandidate = null
  let exhausted = false

  while (scanned < STAGE_SEARCH_MAX_SCAN) {
    const chunkLimit = Math.min(STAGE_SEARCH_CHUNK_SIZE, STAGE_SEARCH_MAX_SCAN - scanned)
    const candidates = await queryStageSearchCandidateChunk({
      range,
      filters,
      q,
      column,
      cursor: scanCursor,
      limit: chunkLimit
    })

    if (candidates.length === 0) {
      exhausted = true
      break
    }

    const factsByContactId = await queryStageContactFacts(candidates, conversionStages)
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
          nextCursor: lastConsumedCandidate ? encodeCursor(lastConsumedCandidate) : null
        }
      }

      scanned += 1
      lastConsumedCandidate = candidate
      if (facts) matches.push({ ...candidate, ...facts })
    }

    scanCursor = {
      startedAt: cursorTimestamp(candidates[candidates.length - 1].started_at),
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
      ? encodeCursor(lastConsumedCandidate)
      : null
  }
}

export async function searchTrackingSessions({ start, end, filters = {}, q = '', column = 'all', cursor = null, limit = 50 } = {}) {
  const normalizedFilters = normalizeTrackingAnalyticsFilters(filters)
  const range = await resolveAnalyticsRange(start, end)
  const normalizedColumn = normalizeSearchColumn(column)
  const decodedCursor = decodeCursor(cursor)
  const normalizedLimit = Math.min(100, Math.max(20, Math.trunc(numberValue(limit)) || 50))
  const queryLimit = normalizedLimit + 1
  const conversionStages = normalizedFilters.conversion_stage || []

  if (conversionStages.length > 0) {
    return searchTrackingSessionsByStage({
      range,
      filters: normalizedFilters,
      q,
      column: normalizedColumn,
      cursor: decodedCursor,
      limit: normalizedLimit
    })
  }

  const params = [range.startUtc, range.endExclusiveUtc]
  const conditions = [`s.started_at >= ?`, `s.started_at < ?`]
  conditions.push(...buildSessionFilterConditions(withoutConversionStage(normalizedFilters), 's', params))

  const searchCondition = buildSearchCondition(q, normalizedColumn, 's', params)
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

  const rows = await db.all(sql, params)
  const hasMore = rows.length > normalizedLimit
  const items = formatSearchItems(rows.slice(0, normalizedLimit))

  return {
    items,
    limit: normalizedLimit,
    hasMore,
    nextCursor: hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]) : null
  }
}
