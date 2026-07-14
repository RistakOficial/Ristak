import { databaseDialect, db } from '../config/database.js'
import { buildDedupExpression } from './analyticsService.js'
import { resolveDateRangeWithGHLTimezone, sqliteTimezoneOffsetClause } from '../utils/dateUtils.js'
import { buildHiddenContactsCondition, getHiddenContactFilters } from '../utils/hiddenContactsFilter.js'
import { timestampSortExpression, timestampSortParameterExpression } from '../utils/sqlTimestampSort.js'

const isPostgres = databaseDialect === 'postgres'
const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 100
const VALID_TYPES = new Set(['interesados', 'sales', 'appointments', 'attendances'])
const ACTIVE_APPOINTMENT_STATUSES_EXCLUDED = [
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
const ATTENDED_APPOINTMENT_STATUSES = ['showed', 'show', 'attended', 'completed', 'complete']

function requestError(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE_LIMIT
  return Math.min(parsed, MAX_PAGE_LIMIT)
}

function serializeCursorTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  return String(value || '').trim()
}

function encodeCursor(row) {
  const createdAt = serializeCursorTimestamp(row?.created_at)
  const id = String(row?.id || '').trim()
  if (!createdAt || !id) return null
  return Buffer.from(JSON.stringify({ v: 1, kind: 'campaign-contacts', createdAt, id }), 'utf8').toString('base64url')
}

function decodeCursor(value) {
  const clean = String(value || '').trim()
  if (!clean) return null
  if (clean.length > 2048) throw requestError('Cursor inválido')

  try {
    const parsed = JSON.parse(Buffer.from(clean, 'base64url').toString('utf8'))
    const createdAt = String(parsed?.createdAt || '').trim()
    const id = String(parsed?.id || '').trim()
    if (parsed?.v !== 1 || parsed?.kind !== 'campaign-contacts' || !createdAt || !id) {
      throw new Error('invalid cursor payload')
    }
    if (createdAt.length > 100 || id.length > 300 || !Number.isFinite(Date.parse(createdAt))) {
      throw new Error('invalid cursor fields')
    }
    return { createdAt, id }
  } catch {
    throw requestError('Cursor inválido')
  }
}

function escapeLikeSearch(value) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase('es-MX')
    .slice(0, 200)
    .replace(/!/g, '!!')
    .replace(/%/g, '!%')
    .replace(/_/g, '!_')
}

function sqlList(values) {
  return values.map(value => `'${String(value).replace(/'/g, "''")}'`).join(', ')
}

function timestampDateExpression(column, timezone = 'UTC', referenceDate = new Date()) {
  if (!isPostgres) {
    return `DATE(datetime(${column}, ${sqliteTimezoneOffsetClause(timezone, referenceDate)}))`
  }
  const safeTimezone = String(timezone || 'UTC').replace(/'/g, "''")
  return `((${column})::timestamptz AT TIME ZONE '${safeTimezone}')::date`
}

function metaDateExpression(column) {
  return isPostgres ? `(${column})::date` : `DATE(${column})`
}

async function getAttributionCalendarIds() {
  const row = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ? LIMIT 1',
    ['attribution_calendar_ids']
  )
  if (!row?.config_value) return []

  try {
    const parsed = JSON.parse(row.config_value)
    return Array.isArray(parsed)
      ? [...new Set(parsed.map(value => String(value).trim()).filter(Boolean))]
      : []
  } catch {
    return []
  }
}

function resolveEntityFilter({ campaignId, adsetId, adId }) {
  if (String(adId || '').trim()) return { column: 'ad_id', value: String(adId).trim() }
  if (String(adsetId || '').trim()) return { column: 'adset_id', value: String(adsetId).trim() }
  if (String(campaignId || '').trim()) return { column: 'campaign_id', value: String(campaignId).trim() }
  throw requestError('Se requiere al menos campaign_id, adset_id o ad_id')
}

function typeEligibilityCondition(type) {
  if (type === 'sales') return 'person_is_sale = 1'
  if (type === 'appointments') return 'person_has_appointment = 1'
  if (type === 'attendances') return 'person_has_attendance = 1'
  return '1 = 1'
}

function mapContactRow(row) {
  return {
    id: row.id,
    name: row.full_name || '',
    email: row.email || '',
    phone: row.phone || '',
    created_at: row.created_at,
    ltv: Number(row.person_ltv || 0),
    ad_id: row.attribution_ad_id || null,
    ad_name: row.ad_name || row.attribution_ad_name || null,
    campaign_id: row.campaign_id || null,
    campaign_name: row.campaign_name || null,
    adset_id: row.adset_id || null,
    adset_name: row.adset_name || null,
    source: row.source || null,
    is_sale: Boolean(row.person_is_sale),
    hasAppointments: Boolean(row.person_has_appointment),
    hasShowedAppointment: Boolean(row.person_has_attendance),
    hasAttendedAppointment: Boolean(row.person_has_attendance)
  }
}

export async function listCampaignContactsPage({
  type = 'interesados',
  startDate,
  endDate,
  campaignId,
  adsetId,
  adId,
  search = '',
  cursor,
  limit = DEFAULT_PAGE_LIMIT
} = {}) {
  const cleanType = String(type || '').trim().toLowerCase()
  if (!VALID_TYPES.has(cleanType)) throw requestError('Tipo de contacto inválido')
  if (!startDate || !endDate) throw requestError('Se requieren type, startDate y endDate')

  const entityFilter = resolveEntityFilter({ campaignId, adsetId, adId })
  const decodedCursor = decodeCursor(cursor)
  const pageLimit = normalizeLimit(limit)
  const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
  if (!range.startZoned || !range.endZoned || !range.startUtc || !range.endUtc) {
    throw requestError('Rango de fechas inválido')
  }

  const [hiddenFilters, calendarIds] = await Promise.all([
    getHiddenContactFilters(),
    getAttributionCalendarIds()
  ])
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
  const calendarCondition = calendarIds.length
    ? `AND a.calendar_id IN (${sqlList(calendarIds)})`
    : ''
  const personKey = buildDedupExpression('c')
  const createdAtSort = timestampSortExpression('created_at')
  const createdAtSortForRank = timestampSortExpression('created_at')
  const normalizedSearch = escapeLikeSearch(search)
  const searchPattern = normalizedSearch ? `%${normalizedSearch}%` : ''
  const searchMatchExpression = normalizedSearch
    ? `CASE WHEN (
        LOWER(COALESCE(c.full_name, '')) LIKE ? ESCAPE '!' OR
        LOWER(COALESCE(c.email, '')) LIKE ? ESCAPE '!' OR
        LOWER(COALESCE(c.phone, '')) LIKE ? ESCAPE '!' OR
        LOWER(COALESCE(CAST(c.id AS TEXT), '')) LIKE ? ESCAPE '!'
      ) THEN 1 ELSE 0 END`
    : '1'
  const searchParams = normalizedSearch
    ? [searchPattern, searchPattern, searchPattern, searchPattern]
    : []
  const cursorCondition = decodedCursor
    ? `AND (${createdAtSort}, id) < (${timestampSortParameterExpression()}, ?)`
    : ''
  const cursorParams = decodedCursor
    ? [decodedCursor.createdAt, decodedCursor.id]
    : []

  const query = `
    WITH matched_ads AS (
      SELECT
        ma.ad_id,
        ${metaDateExpression('ma.date')} AS ad_date,
        MAX(ma.campaign_id) AS campaign_id,
        MAX(ma.campaign_name) AS campaign_name,
        MAX(ma.adset_id) AS adset_id,
        MAX(ma.adset_name) AS adset_name,
        MAX(ma.ad_name) AS ad_name
      FROM meta_ads ma
      WHERE ma.date >= ?
        AND ma.date <= ?
        AND ma.${entityFilter.column} = ?
      GROUP BY ma.ad_id, ${metaDateExpression('ma.date')}
    ),
    candidate_contacts AS (
      SELECT
        c.id,
        c.full_name,
        c.email,
        c.phone,
        c.created_at,
        c.total_paid,
        c.purchases_count,
        c.appointment_date,
        c.attribution_ad_id,
        c.attribution_ad_name,
        c.source,
        ma.campaign_id,
        ma.campaign_name,
        ma.adset_id,
        ma.adset_name,
        ma.ad_name,
        ${personKey} AS person_key,
        CASE WHEN COALESCE(c.purchases_count, 0) > 0 THEN 1 ELSE 0 END AS is_sale,
        CASE WHEN c.appointment_date IS NOT NULL OR EXISTS (
          SELECT 1
          FROM appointments a
          WHERE a.contact_id = c.id
            ${calendarCondition}
            AND LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN (${sqlList(ACTIVE_APPOINTMENT_STATUSES_EXCLUDED)})
        ) THEN 1 ELSE 0 END AS has_appointment,
        CASE WHEN EXISTS (
          SELECT 1
          FROM appointment_attendance_signals signals
          WHERE signals.contact_id = c.id
        ) OR EXISTS (
          SELECT 1
          FROM appointments a
          WHERE a.contact_id = c.id
            ${calendarCondition}
            AND LOWER(COALESCE(a.appointment_status, a.status, '')) IN (${sqlList(ATTENDED_APPOINTMENT_STATUSES)})
        ) THEN 1 ELSE 0 END AS has_attendance,
        ${searchMatchExpression} AS search_match
      FROM contacts c
      INNER JOIN matched_ads ma
        ON ma.ad_id = c.attribution_ad_id
        AND ma.ad_date = ${timestampDateExpression('c.created_at', range.appliedTimezone, range.startUtc)}
      WHERE c.created_at >= ?
        AND c.created_at <= ?
        ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
    ),
    ranked_contacts AS (
      SELECT
        candidate_contacts.*,
        ROW_NUMBER() OVER (
          PARTITION BY person_key
          ORDER BY ${createdAtSortForRank} DESC, id DESC
        ) AS person_rank,
        MAX(is_sale) OVER (PARTITION BY person_key) AS person_is_sale,
        MAX(has_appointment) OVER (PARTITION BY person_key) AS person_has_appointment,
        MAX(has_attendance) OVER (PARTITION BY person_key) AS person_has_attendance,
        MAX(total_paid) OVER (PARTITION BY person_key) AS person_ltv,
        MAX(search_match) OVER (PARTITION BY person_key) AS person_search_match
      FROM candidate_contacts
    ),
    eligible_contacts AS (
      SELECT *
      FROM ranked_contacts
      WHERE person_rank = 1
        AND person_search_match = 1
        AND ${typeEligibilityCondition(cleanType)}
    )
    SELECT *
    FROM eligible_contacts
    WHERE 1 = 1
      ${cursorCondition}
    ORDER BY ${createdAtSort} DESC, id DESC
    LIMIT ?
  `
  const params = [
    range.startZoned.toISODate(),
    range.endZoned.toISODate(),
    entityFilter.value,
    ...searchParams,
    range.startUtc,
    range.endUtc,
    ...cursorParams,
    pageLimit + 1
  ]

  const rows = await db.all(query, params)
  const hasNext = rows.length > pageLimit
  const pageRows = hasNext ? rows.slice(0, pageLimit) : rows
  const contacts = pageRows.map(mapContactRow)

  return {
    range,
    contacts,
    summary: {
      pageCount: contacts.length,
      pageLtv: contacts.reduce((total, contact) => total + Number(contact.ltv || 0), 0)
    },
    pagination: {
      limit: pageLimit,
      hasNext,
      nextCursor: hasNext ? encodeCursor(pageRows[pageRows.length - 1]) : null
    }
  }
}

export const CAMPAIGN_CONTACTS_PAGE_LIMITS = Object.freeze({
  default: DEFAULT_PAGE_LIMIT,
  max: MAX_PAGE_LIMIT
})
