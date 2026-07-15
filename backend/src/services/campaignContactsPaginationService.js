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

function candidateContactCondition({ alias, argsAlias, entityColumn, range, hiddenFilters }) {
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, alias, false)
  return `${alias}.created_at >= ${argsAlias}.contact_start_at
    AND ${alias}.created_at <= ${argsAlias}.contact_end_at
    ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
    AND EXISTS (
      SELECT 1
      FROM meta_ads candidate_ad
      WHERE ${metaMatchCondition({
        contactAlias: alias,
        metaAlias: 'candidate_ad',
        argsAlias,
        entityColumn,
        range
      })}
    )`
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
  const pageLimit = normalizeLimit(limit)
  const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
  if (!range.startZoned || !range.endZoned || !range.startUtc || !range.endUtc) {
    throw requestError('Rango de fechas inválido')
  }

  const [hiddenFilters, calendarIds, identityProjectionStatus] = await Promise.all([
    getHiddenContactFilters(),
    getAttributionCalendarIds(),
    getContactPersonIdentityProjectionStatus({ schedule: false })
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
  const outerCandidate = candidateContactCondition({
    alias: 'c',
    argsAlias: 'query_args',
    entityColumn: entityFilter.column,
    range,
    hiddenFilters
  })
  const newerCandidate = candidateContactCondition({
    alias: 'newer_contact',
    argsAlias: 'query_args',
    entityColumn: entityFilter.column,
    range,
    hiddenFilters
  })
  const personCandidate = candidateContactCondition({
    alias: 'person_contact',
    argsAlias: 'query_args',
    entityColumn: entityFilter.column,
    range,
    hiddenFilters
  })
  const representativeCondition = `NOT EXISTS (
    SELECT 1
    FROM contact_person_identity newer_identity
    INNER JOIN contacts newer_contact ON newer_contact.id = newer_identity.contact_id
    WHERE newer_identity.campaign_person_key = identity_projection.campaign_person_key
      AND ${newerCandidate}
      AND (
        ${campaignContactCursorSortExpression('newer_contact.created_at')}, newer_contact.id
      ) > (
        ${createdAtSort}, c.id
      )
  )`
  const personProbePrefix = `
    FROM contact_person_identity person_identity
    INNER JOIN contacts person_contact ON person_contact.id = person_identity.contact_id
    WHERE person_identity.campaign_person_key = identity_projection.campaign_person_key
      AND ${personCandidate}`
  const personIsSaleExpression = `EXISTS (
    SELECT 1 ${personProbePrefix}
      AND COALESCE(person_contact.purchases_count, 0) > 0
  )`
  const calendarCondition = calendarIds.length
    ? `AND person_appointment.calendar_id IN (${sqlList(calendarIds)})`
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
          WHERE person_signal.contact_id = person_contact.id
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
  const metadataExpression = (column) => `(
    SELECT MAX(metadata_ad.${column})
    FROM meta_ads metadata_ad
    WHERE ${metaMatchCondition({
      contactAlias: 'c',
      metaAlias: 'metadata_ad',
      argsAlias: 'query_args',
      entityColumn: entityFilter.column,
      range
    })}
  )`
  const cursorCondition = decodedCursor
    ? `AND (${createdAtSort}, c.id) < (${campaignContactCursorParameterExpression()}, ?)`
    : ''
  const cursorParams = decodedCursor
    ? [decodedCursor.createdAt, decodedCursor.id]
    : []

  const query = `
    WITH ${queryArgumentsCte()}
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
      ${metadataExpression('campaign_id')} AS campaign_id,
      ${metadataExpression('campaign_name')} AS campaign_name,
      ${metadataExpression('adset_id')} AS adset_id,
      ${metadataExpression('adset_name')} AS adset_name,
      ${metadataExpression('ad_name')} AS ad_name,
      ${personIsSaleExpression} AS person_is_sale,
      ${personHasAppointmentExpression} AS person_has_appointment,
      ${personHasAttendanceExpression} AS person_has_attendance,
      ${personLtvExpression} AS person_ltv,
      ${campaignContactCursorProjectionExpression('c.created_at')} AS cursor_created_at
    FROM contacts c${isPostgres ? '' : ' INDEXED BY idx_campaign_contacts_cursor_created_at_id'}
    INNER JOIN contact_person_identity identity_projection
      ON identity_projection.contact_id = c.id
    CROSS JOIN query_args
    WHERE ${outerCandidate}
      AND ${representativeCondition}
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
      nextCursor: hasNext ? encodeCursor(pageRows[pageRows.length - 1], cursorScope) : null
    }
  }
}

export const CAMPAIGN_CONTACTS_PAGE_LIMITS = Object.freeze({
  default: DEFAULT_PAGE_LIMIT,
  max: MAX_PAGE_LIMIT
})
