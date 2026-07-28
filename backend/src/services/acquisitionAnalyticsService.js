import { db } from '../config/database.js'
import { buildHiddenContactsCondition, getHiddenContactFilters } from '../utils/hiddenContactsFilter.js'
import { normalizeDateOnlyInTimezone } from '../utils/dateUtils.js'
import { nonTestPaymentCondition, SUCCESS_PAYMENT_STATUSES } from '../utils/paymentMode.js'
import { queryContactAcquisitionAnalytics } from './contactOriginProjectionService.js'
import { queryMessageAnalyticsPopulation } from './messageAnalyticsProjectionService.js'
import { getTrackingAnalyticsProjectionStatus } from './trackingAnalyticsProjectionService.js'

const POPULATIONS = new Set(['visitors', 'conversations', 'newConversations', 'contacts', 'buyers'])
const DIMENSIONS = new Set(['channel', 'entry', 'source'])
const GROUPS = new Set(['day', 'month', 'year'])
const CHANNELS = new Set(['website', 'whatsapp', 'messenger', 'instagram', 'email'])
const MESSAGE_CHANNELS = new Set(['whatsapp', 'messenger', 'instagram', 'email'])
const VISITOR_STAGES = new Set([
  'prospect',
  'appointment_scheduled',
  'appointment_attended',
  'customer'
])
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const successfulPaymentStatusSql = SUCCESS_PAYMENT_STATUSES
  .map(status => `'${String(status).replace(/'/g, "''")}'`)
  .join(', ')
const inactiveAppointmentStatusSql = [
  'cancelled',
  'canceled',
  'no_show',
  'no-show',
  'noshow',
  'invalid',
  'deleted',
  'void',
  'rescheduled'
].map(status => `'${status}'`).join(', ')
const attendedAppointmentStatusSql = [
  'show',
  'showed',
  'completed',
  'complete',
  'attended'
].map(status => `'${status}'`).join(', ')

const hasText = value => Boolean(String(value || '').trim())

const normalizeList = value => {
  const values = Array.isArray(value) ? value : String(value || '').split(',')
  return [...new Set(values
    .map(item => String(item || '').trim().toLowerCase())
    .filter(item => CHANNELS.has(item)))]
}

const normalizePopulation = value => (
  POPULATIONS.has(String(value || '')) ? String(value) : 'contacts'
)

const normalizeDimension = value => (
  DIMENSIONS.has(String(value || '')) ? String(value) : 'entry'
)

const normalizeGroupBy = value => (
  GROUPS.has(String(value || '')) ? String(value) : 'day'
)

const businessDateRange = range => {
  const startDate = range?.startDate || (
    range?.startUtc
      ? normalizeDateOnlyInTimezone(range.startUtc, range.appliedTimezone)
      : null
  )
  const endDate = range?.endDate || (
    range?.endUtc
      ? normalizeDateOnlyInTimezone(range.endUtc, range.appliedTimezone)
      : null
  )
  if (
    !DATE_ONLY_PATTERN.test(String(startDate || '')) ||
    !DATE_ONLY_PATTERN.test(String(endDate || '')) ||
    startDate > endDate
  ) {
    const error = new Error('El rango de adquisición no es válido.')
    error.code = 'INVALID_ACQUISITION_DATE_RANGE'
    error.status = 400
    throw error
  }
  return { startDate, endDate }
}

const periodExpression = (groupBy, alias = 'selected') => {
  if (groupBy === 'year') return `SUBSTR(CAST(${alias}.business_date AS TEXT), 1, 4)`
  if (groupBy === 'month') return `SUBSTR(CAST(${alias}.business_date AS TEXT), 1, 7)`
  return `CAST(${alias}.business_date AS TEXT)`
}

const WEB_FILTER_FIELDS = Object.freeze({
  landing_url: 'page_value',
  page_url: 'page_value',
  utm_campaign: 'utm_campaign',
  utm_medium: 'utm_medium',
  utm_content: 'utm_content',
  utm_source: 'source_filter_value',
  device_type: 'device_type',
  browser: 'browser',
  os: 'os',
  placement: 'placement',
  ad_platform: 'ad_platform',
  campaign_id: 'campaign_id',
  adset_id: 'adset_id',
  ad_id: 'ad_id',
  tracking_source: 'tracking_source',
  channel: 'channel',
  site_type: 'site_type',
  site_id: 'site_id',
  form_site_id: 'form_site_id',
  native_conversion_source: 'native_conversion_source'
})

function visitorFilterSql(filters = {}, params = [], alias = 'dimensions') {
  const conditions = []
  for (const [field, rawValues] of Object.entries(filters || {})) {
    if (field === 'conversion_stage') continue
    const column = WEB_FILTER_FIELDS[field]
    if (!column || !Array.isArray(rawValues) || rawValues.length === 0) continue
    const values = rawValues.map(value => String(value || '').trim().toLowerCase()).filter(Boolean)
    if (!values.length) continue
    params.push(...values)
    const expression = field === 'site_type'
      ? `LOWER(COALESCE(NULLIF(${alias}.site_type, ''), 'unknown'))`
      : `LOWER(COALESCE(${alias}.${column}, ''))`
    conditions.push(`${expression} IN (${values.map(() => '?').join(', ')})`)
  }
  return conditions
}

function visitorStageSql(filters = {}, params = [], contactAlias = 'contacts') {
  const stages = Array.isArray(filters?.conversion_stage)
    ? [...new Set(filters.conversion_stage
        .map(value => String(value || '').trim().toLowerCase())
        .filter(value => VISITOR_STAGES.has(value)))]
    : []
  if (!stages.length) return ''
  params.push(...stages)
  const stageExpression = `CASE
    WHEN ${contactAlias}.id IS NULL OR ${contactAlias}.id = '' THEN NULL
    WHEN EXISTS (
      SELECT 1
      FROM payments stage_payments
      WHERE stage_payments.contact_id = ${contactAlias}.id
        AND COALESCE(stage_payments.amount, 0) > 0
        AND LOWER(COALESCE(stage_payments.status, '')) IN (${successfulPaymentStatusSql})
        AND ${nonTestPaymentCondition('stage_payments')}
    ) THEN 'customer'
    WHEN EXISTS (
      SELECT 1
      FROM appointment_attendance_signals stage_attendance
      WHERE stage_attendance.contact_id = ${contactAlias}.id
    ) OR EXISTS (
      SELECT 1
      FROM appointments stage_attended_appointments
      WHERE stage_attended_appointments.contact_id = ${contactAlias}.id
        AND LOWER(COALESCE(
          stage_attended_appointments.appointment_status,
          stage_attended_appointments.status,
          ''
        )) IN (${attendedAppointmentStatusSql})
    ) THEN 'appointment_attended'
    WHEN ${contactAlias}.appointment_date IS NOT NULL OR EXISTS (
      SELECT 1
      FROM appointments stage_appointments
      WHERE stage_appointments.contact_id = ${contactAlias}.id
        AND LOWER(COALESCE(
          stage_appointments.appointment_status,
          stage_appointments.status,
          ''
        )) NOT IN (${inactiveAppointmentStatusSql})
    ) THEN 'appointment_scheduled'
    ELSE 'prospect'
  END`
  return `${stageExpression} IN (${stages.map(() => '?').join(', ')})`
}

function visitorCategorySql(dimension, alias = 'selected') {
  if (dimension === 'channel') return "'website'"
  if (dimension === 'source') {
    return `COALESCE(NULLIF(${alias}.traffic_source, ''), 'Desconocido')`
  }
  return `CASE
    WHEN LOWER(COALESCE(${alias}.channel, '')) = 'paid'
      OR COALESCE(${alias}.ad_id, '') != ''
      OR LOWER(COALESCE(${alias}.utm_medium, '')) IN (
        'paid', 'paid_search', 'paid_social', 'cpc', 'ppc', 'sem', 'display', 'ads', 'ad'
      )
      THEN 'website.paid_ad'
    ELSE 'website.unattributed'
  END`
}

function acquisitionLabel(key, dimension) {
  const normalized = String(key || '').trim()
  if (dimension === 'channel') {
    return {
      website: 'Sitio web',
      whatsapp: 'WhatsApp',
      messenger: 'Messenger',
      instagram: 'Instagram',
      email: 'Correo'
    }[normalized] || 'Sin canal comprobable'
  }
  if (dimension === 'entry') {
    return {
      'website.paid_ad': 'Anuncio hacia sitio web',
      'website.unattributed': 'Sitio web sin anuncio detectado',
      'whatsapp.paid_ad': 'Anuncio directo a WhatsApp',
      'whatsapp.unattributed': 'WhatsApp sin anuncio detectado',
      'messenger.paid_ad': 'Anuncio directo a Messenger',
      'messenger.unattributed': 'Messenger sin anuncio detectado',
      'instagram.paid_ad': 'Anuncio directo a Instagram',
      'instagram.unattributed': 'Instagram sin anuncio detectado',
      'email.paid_ad': 'Campaña de correo comprobada',
      'email.unattributed': 'Correo sin campaña detectada',
      'unknown.unattributed': 'Sin atribución comprobable'
    }[normalized] || normalized || 'Sin atribución comprobable'
  }
  return normalized || 'Desconocido'
}

async function queryVisitorAcquisitionAnalytics(range, {
  dimension,
  channels,
  groupBy,
  filters,
  hiddenFilters,
  signal
}) {
  if (channels.length > 0 && !channels.includes('website')) {
    return {
      population: 'visitors',
      dimension,
      total: 0,
      distribution: [],
      trend: [],
      availableChannels: [],
      status: { projection: 'ready', pending: false, ready: true }
    }
  }

  const projectionStatus = await getTrackingAnalyticsProjectionStatus({ schedule: false, signal })
  if (!projectionStatus?.available) {
    const error = new Error('La analítica de visitantes todavía se está preparando.')
    error.code = 'tracking_analytics_projection_warming'
    error.status = 503
    error.retryable = true
    error.projectionStatus = projectionStatus?.status || 'warming'
    throw error
  }

  const dates = businessDateRange(range)
  const params = [dates.startDate, dates.endDate]
  const filterConditions = visitorFilterSql(filters, params)
  const stageCondition = visitorStageSql(filters, params)
  if (stageCondition) filterConditions.push(stageCondition)
  const resolvedHiddenFilters = Array.isArray(hiddenFilters)
    ? hiddenFilters
    : await getHiddenContactFilters({ signal })
  const hiddenContactCondition = buildHiddenContactsCondition(resolvedHiddenFilters, 'contacts', false)
  const hiddenSql = hiddenContactCondition
    ? `(contacts.id IS NULL OR ${hiddenContactCondition})`
    : '1 = 1'
  const categoryExpression = visitorCategorySql(dimension, 'ranked')
  const period = periodExpression(groupBy)

  const rows = await db.all(`
    WITH ranked AS (
      SELECT
        facts.visitor_key,
        facts.business_date,
        facts.started_at,
        facts.session_row_id,
        dimensions.traffic_source,
        dimensions.utm_medium,
        dimensions.ad_id,
        dimensions.channel,
        ROW_NUMBER() OVER (
          PARTITION BY facts.visitor_key
          ORDER BY facts.started_at ASC, facts.session_row_id ASC
        ) AS visitor_rank
      FROM tracking_analytics_event_fact facts
      INNER JOIN tracking_analytics_dimensions dimensions
        ON dimensions.dimension_key = facts.dimension_key
      LEFT JOIN contacts contacts
        ON contacts.id = NULLIF(facts.contact_key, '')
      WHERE facts.business_date >= ? AND facts.business_date <= ?
        AND facts.view_count > 0
        AND facts.visitor_key != ''
        AND ${hiddenSql}
        ${filterConditions.length ? `AND ${filterConditions.join(' AND ')}` : ''}
    ),
    selected AS (
      SELECT *, ${categoryExpression} AS category_key
      FROM ranked
      WHERE visitor_rank = 1
    )
    SELECT
      'distribution' AS row_type,
      selected.category_key AS row_key,
      COUNT(*) AS row_value
    FROM selected
    GROUP BY selected.category_key
    UNION ALL
    SELECT
      'trend' AS row_type,
      ${period} AS row_key,
      COUNT(*) AS row_value
    FROM selected
    GROUP BY ${period}
    ORDER BY row_type ASC, row_key ASC
  `, params, { signal })

  const distribution = rows
    .filter(row => row.row_type === 'distribution')
    .map(row => ({
      key: String(row.row_key || ''),
      name: acquisitionLabel(row.row_key, dimension),
      value: Number(row.row_value || 0)
    }))
    .filter(item => item.value > 0)
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name))
  const trend = rows
    .filter(row => row.row_type === 'trend')
    .map(row => ({
      label: String(row.row_key || ''),
      visitors: Number(row.row_value || 0)
    }))
    .sort((left, right) => left.label.localeCompare(right.label))

  return {
    population: 'visitors',
    dimension,
    total: distribution.reduce((sum, item) => sum + item.value, 0),
    distribution,
    trend,
    availableChannels: distribution.length > 0 ? ['website'] : [],
    status: {
      projection: projectionStatus.status,
      pending: Boolean(projectionStatus.pending),
      ready: Boolean(projectionStatus.available)
    }
  }
}

function normalizeDistribution(result, dimension) {
  const distribution = Array.isArray(result?.distribution) ? result.distribution : []
  return distribution
    .map(item => ({
      key: String(item.key || item.name || ''),
      name: hasText(item.name) ? String(item.name) : acquisitionLabel(item.key, dimension),
      value: Math.max(0, Number(item.value || 0))
    }))
    .filter(item => item.value > 0)
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name))
}

/**
 * Contrato único para la dona y los comparadores de Analíticas.
 *
 * Cada población conserva su propio grano:
 * - visitors: una identidad web proyectada;
 * - conversations: una identidad con mensaje inbound;
 * - contacts/buyers: contact_id deduplicado.
 *
 * Nunca suma visitantes anónimos con conversaciones ni los rebautiza como
 * "personas únicas".
 */
export async function getAcquisitionAnalyticsSummary(range, options = {}) {
  const population = normalizePopulation(options.population)
  const dimension = normalizeDimension(options.dimension)
  const groupBy = normalizeGroupBy(options.groupBy)
  const channels = normalizeList(options.channels)
  const dates = businessDateRange(range)
  const hiddenFilters = Array.isArray(options.hiddenFilters)
    ? options.hiddenFilters
    : await getHiddenContactFilters({ signal: options.signal })

  let result
  if (population === 'visitors') {
    result = await queryVisitorAcquisitionAnalytics(range, {
      dimension,
      channels,
      groupBy,
      filters: options.filters || {},
      hiddenFilters,
      signal: options.signal
    })
  } else if (population === 'conversations' || population === 'newConversations') {
    const messageChannels = channels.filter(channel => MESSAGE_CHANNELS.has(channel))
    result = channels.length > 0 && messageChannels.length === 0
      ? {
          population,
          dimension,
          total: 0,
          distribution: [],
          trend: [],
          availableChannels: [],
          status: { projection: 'ready', pending: false, ready: true }
        }
      : await queryMessageAnalyticsPopulation(range, {
          population,
          dimension,
          groupBy,
          filters: {
            ...(options.filters || {}),
            channels: channels.length ? messageChannels : (options.filters?.channels || [])
          },
          hiddenFilters,
          signal: options.signal
        })
  } else {
    result = await queryContactAcquisitionAnalytics(range, {
      population,
      dimension,
      channels,
      sources: options.filters?.sources || options.filters?.message_source || [],
      groupBy,
      hiddenFilters,
      signal: options.signal
    })
  }

  const distribution = normalizeDistribution(result, dimension)
  const total = Number.isFinite(Number(result?.total))
    ? Math.max(0, Number(result.total))
    : distribution.reduce((sum, item) => sum + item.value, 0)

  return {
    population,
    dimension,
    total,
    distribution,
    trend: Array.isArray(result?.trend) ? result.trend : [],
    availableChannels: [...new Set((result?.availableChannels || [])
      .map(channel => String(channel || '').trim().toLowerCase())
      .filter(channel => CHANNELS.has(channel)))],
    status: result?.status || { projection: 'ready', pending: false, ready: true },
    range: {
      start: dates.startDate,
      end: dates.endDate,
      timezone: range.appliedTimezone
    }
  }
}

export const acquisitionAnalyticsContract = Object.freeze({
  populations: [...POPULATIONS],
  dimensions: [...DIMENSIONS],
  channels: [...CHANNELS],
  groups: [...GROUPS]
})
