import { databaseDialect, db } from '../config/database.js'
import { resolveDateRangeWithGHLTimezone, sqliteTimezoneOffsetClause } from '../utils/dateUtils.js'
import { buildHiddenContactsCondition, getHiddenContactFilters } from '../utils/hiddenContactsFilter.js'
import {
  hashPaginationCursorScope,
  paginationCursorHiddenFiltersScope,
  paginationCursorListScope,
  paginationCursorRangeScope
} from '../utils/paginationCursorScope.js'
import { timestampSortExpression, timestampSortParameterExpression } from '../utils/sqlTimestampSort.js'
import {
  createContactPersonIdentityWarmingError,
  getContactPersonIdentityProjectionStatus
} from './contactPersonIdentityProjectionService.js'

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

function campaignContactCursorSortExpression(valueExpression) {
  if (isPostgres) {
    return `COALESCE(${valueExpression}, TIMESTAMP '1970-01-01 00:00:00')`
  }
  return `COALESCE(
    NULLIF(${timestampSortExpression(valueExpression)}, 0),
    julianday('1970-01-01 00:00:00')
  )`
}

function campaignContactCursorProjectionExpression(valueExpression) {
  const effectiveTimestamp = isPostgres
    ? campaignContactCursorSortExpression(valueExpression)
    : `COALESCE(${valueExpression}, '1970-01-01 00:00:00')`
  return isPostgres ? `(${effectiveTimestamp})::text` : effectiveTimestamp
}

function campaignContactCursorParameterExpression() {
  if (isPostgres) return '?'
  return `COALESCE(
    NULLIF(${timestampSortParameterExpression()}, 0),
    julianday('1970-01-01 00:00:00')
  )`
}

function encodeCursor(row, scope) {
  const createdAt = serializeCursorTimestamp(row?.cursor_created_at)
  const id = String(row?.id || '').trim()
  if (!createdAt || !id) return null
  return Buffer.from(JSON.stringify({ v: 2, kind: 'campaign-contacts', scope, createdAt, id }), 'utf8').toString('base64url')
}

function decodeCursor(value, expectedScope) {
  const clean = String(value || '').trim()
  if (!clean) return null
  if (clean.length > 2048) throw requestError('Cursor inválido')

  try {
    const parsed = JSON.parse(Buffer.from(clean, 'base64url').toString('utf8'))
    const isLegacyCursor = parsed?.v === 1 && parsed?.kind === 'campaign-contacts' && parsed?.scope === undefined
    const isScopedCursor = parsed?.v === 2 && parsed?.kind === 'campaign-contacts' && typeof parsed?.scope === 'string'
    if (!isLegacyCursor && !isScopedCursor) throw new Error('invalid cursor payload')
    if (isScopedCursor && parsed.scope !== expectedScope) {
      throw requestError('El cursor ya no corresponde a esta vista; vuelve a la primera página')
    }
    const createdAt = String(parsed?.createdAt || '').trim()
    const id = String(parsed?.id || '').trim()
    if (!createdAt || !id) throw new Error('invalid cursor payload')
    if (createdAt.length > 100 || id.length > 300 || !Number.isFinite(Date.parse(createdAt))) {
      throw new Error('invalid cursor fields')
    }
    return { createdAt, id }
  } catch (error) {
    if (error?.status === 400) throw error
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

async function getAttributionCalendarIds(signal) {
  const row = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ? LIMIT 1',
    ['attribution_calendar_ids'],
    { signal }
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

function queryArgumentsCte() {
  const timestampArgument = isPostgres ? 'CAST(? AS TIMESTAMP)' : '?'
  return `query_args AS (
    SELECT
      CAST(? AS TEXT) AS ad_start_date,
      CAST(? AS TEXT) AS ad_end_date,
      CAST(? AS TEXT) AS entity_value,
      ${timestampArgument} AS contact_start_at,
      ${timestampArgument} AS contact_end_at,
      CAST(? AS TEXT) AS search_pattern
  )`
}

function metaMatchCondition({ contactAlias, metaAlias, argsAlias, entityColumn, range }) {
  return `${metaAlias}.ad_id = ${contactAlias}.attribution_ad_id
    AND ${metaAlias}.date >= ${argsAlias}.ad_start_date
    AND ${metaAlias}.date <= ${argsAlias}.ad_end_date
    AND ${metaAlias}.${entityColumn} = ${argsAlias}.entity_value
    AND ${metaDateExpression(`${metaAlias}.date`)} = ${timestampDateExpression(
      `${contactAlias}.created_at`,
      range.appliedTimezone,
      range.startUtc
    )}`
}

function mapContactRow(row) {
  return {
    id: row.id,
    name: row.full_name || '',
    email: row.email || '',
    phone: row.phone || '',
    created_at: row.created_at,
    ltv: Number(row.person_ltv || 0),
    referredByContactId: row.referred_by_contact_id || null,
    referred_by_contact_id: row.referred_by_contact_id || null,
    referredByContact: row.referred_by_contact_id ? {
      id: row.referred_by_contact_id,
      name: row.referred_by_contact_name || '',
      email: row.referred_by_contact_email || '',
      phone: row.referred_by_contact_phone || ''
    } : null,
    attributionContactId: row.attribution_contact_id || (row.inherited_from_referral ? null : row.id),
    attributionContactName: row.attribution_contact_name || (row.inherited_from_referral ? '' : row.full_name || ''),
    attributionInheritedFromReferral: Boolean(row.inherited_from_referral),
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
  limit = DEFAULT_PAGE_LIMIT,
  signal
} = {}) {
  const cleanType = String(type || '').trim().toLowerCase()
  if (!VALID_TYPES.has(cleanType)) throw requestError('Tipo de contacto inválido')
  if (!startDate || !endDate) throw requestError('Se requieren type, startDate y endDate')

  const entityFilter = resolveEntityFilter({ campaignId, adsetId, adId })
  const pageLimit = normalizeLimit(limit)
  const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate, signal })
  if (!range.startZoned || !range.endZoned || !range.startUtc || !range.endUtc) {
    throw requestError('Rango de fechas inválido')
  }

  const [hiddenFilters, calendarIds, identityProjectionStatus] = await Promise.all([
    getHiddenContactFilters({ signal }),
    getAttributionCalendarIds(signal),
    getContactPersonIdentityProjectionStatus({ schedule: false, signal })
  ])
  const normalizedSearch = escapeLikeSearch(search)
  const cursorScope = hashPaginationCursorScope('campaign-contacts', {
    range: paginationCursorRangeScope(range),
    type: cleanType,
    entity: entityFilter,
    search: normalizedSearch,
    hiddenFilters: paginationCursorHiddenFiltersScope(hiddenFilters),
    calendarIds: paginationCursorListScope(calendarIds),
    inactiveAppointmentStatuses: paginationCursorListScope(ACTIVE_APPOINTMENT_STATUSES_EXCLUDED),
    attendedAppointmentStatuses: paginationCursorListScope(ATTENDED_APPOINTMENT_STATUSES),
    sort: ['created_at:desc', 'id:desc']
  })
  const decodedCursor = decodeCursor(cursor, cursorScope)
  if (!identityProjectionStatus.ready) {
    throw createContactPersonIdentityWarmingError()
  }

  const createdAtSort = campaignContactCursorSortExpression('c.created_at')
  const searchPattern = normalizedSearch ? `%${normalizedSearch}%` : ''
  const representativeCondition = `NOT EXISTS (
    SELECT 1
    FROM campaign_candidates newer_contact
    WHERE newer_contact.campaign_person_key = campaign_candidate.campaign_person_key
      AND (
        ${campaignContactCursorSortExpression('newer_contact.created_at')}, newer_contact.id
      ) > (
        ${createdAtSort}, c.id
      )
  )`
  const personProbePrefix = `
    FROM campaign_candidates person_contact
    WHERE person_contact.campaign_person_key = campaign_candidate.campaign_person_key`
  const personIsSaleExpression = `EXISTS (
    SELECT 1 ${personProbePrefix}
      AND COALESCE(person_contact.purchases_count, 0) > 0
  )`
  const calendarCondition = calendarIds.length
    ? `AND person_appointment.calendar_id IN (${sqlList(calendarIds)})`
    : ''
  const signalCalendarJoin = calendarIds.length
    ? 'INNER JOIN appointments signal_appointment ON signal_appointment.id = person_signal.appointment_id'
    : ''
  const signalCalendarCondition = calendarIds.length
    ? `AND signal_appointment.calendar_id IN (${sqlList(calendarIds)})`
    : ''
  const personHasAppointmentExpression = `EXISTS (
    SELECT 1 ${personProbePrefix}
      AND (
        person_contact.appointment_date IS NOT NULL OR EXISTS (
          SELECT 1
          FROM appointments person_appointment
          WHERE person_appointment.contact_id = person_contact.id
            ${calendarCondition}
            AND LOWER(COALESCE(person_appointment.appointment_status, person_appointment.status, ''))
              NOT IN (${sqlList(ACTIVE_APPOINTMENT_STATUSES_EXCLUDED)})
        )
      )
  )`
  const personHasAttendanceExpression = `EXISTS (
    SELECT 1 ${personProbePrefix}
      AND (
        EXISTS (
          SELECT 1
          FROM appointment_attendance_signals person_signal
          ${signalCalendarJoin}
          WHERE person_signal.contact_id = person_contact.id
            ${signalCalendarCondition}
        ) OR EXISTS (
          SELECT 1
          FROM appointments person_appointment
          WHERE person_appointment.contact_id = person_contact.id
            ${calendarCondition}
            AND LOWER(COALESCE(person_appointment.appointment_status, person_appointment.status, ''))
              IN (${sqlList(ATTENDED_APPOINTMENT_STATUSES)})
        )
      )
  )`
  const personLtvExpression = `COALESCE((
    SELECT MAX(person_contact.total_paid) ${personProbePrefix}
  ), 0)`
  const personSearchExpression = normalizedSearch
    ? `EXISTS (
        SELECT 1 ${personProbePrefix}
          AND (
            LOWER(COALESCE(person_contact.full_name, '')) LIKE query_args.search_pattern ESCAPE '!' OR
            LOWER(COALESCE(person_contact.email, '')) LIKE query_args.search_pattern ESCAPE '!' OR
            LOWER(COALESCE(person_contact.phone, '')) LIKE query_args.search_pattern ESCAPE '!' OR
            LOWER(COALESCE(CAST(person_contact.id AS TEXT), '')) LIKE query_args.search_pattern ESCAPE '!'
          )
      )`
    : '1 = 1'
  const typeCondition = cleanType === 'sales'
    ? personIsSaleExpression
    : cleanType === 'appointments'
      ? personHasAppointmentExpression
      : cleanType === 'attendances'
        ? personHasAttendanceExpression
        : '1 = 1'
  const cursorCondition = decodedCursor
    ? `AND (${createdAtSort}, c.id) < (${campaignContactCursorParameterExpression()}, ?)`
    : ''
  const cursorParams = decodedCursor
    ? [decodedCursor.createdAt, decodedCursor.id]
    : []

  const candidateHiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'candidate_contact', false)
  const query = `
    WITH ${queryArgumentsCte()},
    campaign_attributed_contacts AS (
      SELECT
        effective_attribution.contact_id,
        effective_attribution.attribution_contact_id,
        effective_attribution.inherited_from_referral,
        attribution_contact.attribution_ad_id,
        attribution_contact.attribution_ad_name,
        MAX(target_ad.campaign_id) AS campaign_id,
        MAX(target_ad.campaign_name) AS campaign_name,
        MAX(target_ad.adset_id) AS adset_id,
        MAX(target_ad.adset_name) AS adset_name,
        MAX(target_ad.ad_name) AS ad_name
      FROM meta_ads target_ad
      CROSS JOIN query_args
      INNER JOIN contacts attribution_contact
        ON ${metaMatchCondition({
          contactAlias: 'attribution_contact',
          metaAlias: 'target_ad',
          argsAlias: 'query_args',
          entityColumn: entityFilter.column,
          range
        })}
        AND attribution_contact.created_at >= query_args.contact_start_at
        AND attribution_contact.created_at <= query_args.contact_end_at
      INNER JOIN contact_effective_ad_attribution effective_attribution
        ON effective_attribution.attribution_contact_id = attribution_contact.id
      GROUP BY
        effective_attribution.contact_id,
        effective_attribution.attribution_contact_id,
        effective_attribution.inherited_from_referral,
        attribution_contact.attribution_ad_id,
        attribution_contact.attribution_ad_name
    ),
    campaign_candidates AS (
      SELECT
        candidate_contact.id,
        candidate_contact.full_name,
        candidate_contact.email,
        candidate_contact.phone,
        candidate_contact.created_at,
        candidate_contact.total_paid,
        candidate_contact.purchases_count,
        candidate_contact.appointment_date,
        candidate_contact.referred_by_contact_id,
        candidate_contact.source,
        identity_projection.campaign_person_key,
        campaign_attribution.attribution_contact_id,
        campaign_attribution.inherited_from_referral,
        campaign_attribution.attribution_ad_id,
        campaign_attribution.attribution_ad_name,
        campaign_attribution.campaign_id,
        campaign_attribution.campaign_name,
        campaign_attribution.adset_id,
        campaign_attribution.adset_name,
        campaign_attribution.ad_name
      FROM campaign_attributed_contacts campaign_attribution
      INNER JOIN contacts candidate_contact
        ON candidate_contact.id = campaign_attribution.contact_id
      INNER JOIN contact_person_identity identity_projection
        ON identity_projection.contact_id = candidate_contact.id
      ${candidateHiddenCondition ? `WHERE ${candidateHiddenCondition}` : ''}
    )
    SELECT
      c.id,
      c.full_name,
      c.email,
      c.phone,
      c.created_at,
      c.total_paid,
      c.purchases_count,
      c.appointment_date,
      referrer.id AS referred_by_contact_id,
      referrer.full_name AS referred_by_contact_name,
      referrer.email AS referred_by_contact_email,
      referrer.phone AS referred_by_contact_phone,
      visible_attribution_contact.id AS attribution_contact_id,
      campaign_candidate.inherited_from_referral,
      visible_attribution_contact.full_name AS attribution_contact_name,
      campaign_candidate.attribution_ad_id,
      campaign_candidate.attribution_ad_name,
      c.source,
      campaign_candidate.campaign_id,
      campaign_candidate.campaign_name,
      campaign_candidate.adset_id,
      campaign_candidate.adset_name,
      campaign_candidate.ad_name,
      ${personIsSaleExpression} AS person_is_sale,
      ${personHasAppointmentExpression} AS person_has_appointment,
      ${personHasAttendanceExpression} AS person_has_attendance,
      ${personLtvExpression} AS person_ltv,
      ${campaignContactCursorProjectionExpression('c.created_at')} AS cursor_created_at
    FROM contacts c${isPostgres ? '' : ' INDEXED BY idx_campaign_contacts_cursor_created_at_id'}
    INNER JOIN campaign_candidates campaign_candidate
      ON campaign_candidate.id = c.id
    LEFT JOIN contacts visible_attribution_contact
      ON visible_attribution_contact.id = campaign_candidate.attribution_contact_id
      ${buildHiddenContactsCondition(hiddenFilters, 'visible_attribution_contact', false)
        ? `AND ${buildHiddenContactsCondition(hiddenFilters, 'visible_attribution_contact', false)}`
        : ''}
    LEFT JOIN contacts referrer
      ON referrer.id = c.referred_by_contact_id
      ${buildHiddenContactsCondition(hiddenFilters, 'referrer', false)
        ? `AND ${buildHiddenContactsCondition(hiddenFilters, 'referrer', false)}`
        : ''}
    CROSS JOIN query_args
    WHERE ${representativeCondition}
      AND ${personSearchExpression}
      AND ${typeCondition}
      ${cursorCondition}
    ORDER BY ${createdAtSort} DESC, c.id DESC
    LIMIT ?
  `
  const params = [
    range.startZoned.toISODate(),
    range.endZoned.toISODate(),
    entityFilter.value,
    range.startUtc,
    range.endUtc,
    searchPattern,
    ...cursorParams,
    pageLimit + 1
  ]

  const rows = await db.all(query, params, { signal })
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
      nextCursor: hasNext ? encodeCursor(pageRows[pageRows.length - 1], cursorScope) : null
    }
  }
}

export const CAMPAIGN_CONTACTS_PAGE_LIMITS = Object.freeze({
  default: DEFAULT_PAGE_LIMIT,
  max: MAX_PAGE_LIMIT
})
