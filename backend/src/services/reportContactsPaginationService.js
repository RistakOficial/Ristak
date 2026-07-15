import { databaseDialect, db } from '../config/database.js'
import { resolveDateRangeWithGHLTimezone, sqliteTimezoneOffsetClause } from '../utils/dateUtils.js'
import { buildHiddenContactsCondition, getHiddenContactFilters } from '../utils/hiddenContactsFilter.js'
import {
  hashPaginationCursorScope,
  paginationCursorHiddenFiltersScope,
  paginationCursorListScope,
  paginationCursorRangeScope
} from '../utils/paginationCursorScope.js'
import { nonTestPaymentCondition, SUCCESS_PAYMENT_STATUSES } from '../utils/paymentMode.js'
import {
  createContactPersonIdentityWarmingError,
  getContactPersonIdentityProjectionStatus
} from './contactPersonIdentityProjectionService.js'

const isPostgres = databaseDialect === 'postgres'
const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 100
const TOTAL_COUNT_CAP = 10_000
const VALID_TYPES = new Set(['interesados', 'customers', 'sales', 'appointments', 'attendances'])
const VALID_SCOPES = new Set(['all', 'attribution', 'campaigns', 'attributed'])
const INACTIVE_APPOINTMENT_STATUSES = [
  'cancelled',
  'canceled',
  'no_show',
  'noshow',
  'invalid',
  'failed',
  'missed',
  'deleted',
  'void',
  'voided'
]
const ATTENDED_APPOINTMENT_STATUSES = ['showed', 'attended', 'completed', 'complete']

function requestError(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAGE_LIMIT
  return Math.min(parsed, MAX_PAGE_LIMIT)
}

function normalizeReportContactsSearch(value) {
  return String(value || '').trim().toLowerCase().slice(0, 200)
}

function serializeCursorTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  return String(value || '').trim()
}

function contactCursorSortExpression(alias = 'eligible_contacts') {
  return isPostgres
    ? `COALESCE(${alias}.created_at, '1970-01-01 00:00:00+00')`
    : `COALESCE(${alias}.created_at, '1970-01-01 00:00:00')`
}

function contactCursorProjectionExpression(alias = 'eligible_contacts') {
  const sortExpression = contactCursorSortExpression(alias)
  return isPostgres ? `(${sortExpression})::text` : sortExpression
}

function encodeCursor(row, scope, { total, totalIsCapped } = {}) {
  const createdAt = serializeCursorTimestamp(row?.cursor_created_at)
  if (!createdAt || !row?.id) return null
  return Buffer.from(JSON.stringify({
    v: 2,
    kind: 'report-contacts',
    scope,
    createdAt,
    id: row.id,
    total,
    totalIsCapped: Boolean(totalIsCapped)
  }), 'utf8').toString('base64url')
}

function decodeCursor(value, expectedScope) {
  const clean = String(value || '').trim()
  if (!clean) return null
  if (clean.length > 2048) throw requestError('Cursor inválido')

  try {
    const decoded = JSON.parse(Buffer.from(clean, 'base64url').toString('utf8'))
    const isLegacyCursor = decoded?.v === undefined && decoded?.kind === undefined && decoded?.scope === undefined
    const isScopedCursor = decoded?.v === 2 && decoded?.kind === 'report-contacts' && typeof decoded?.scope === 'string'
    if (!isLegacyCursor && !isScopedCursor) throw new Error('invalid cursor payload')
    if (isScopedCursor && decoded.scope !== expectedScope) {
      throw requestError('El cursor ya no corresponde a esta vista; vuelve a la primera página')
    }
    const createdAt = String(decoded?.createdAt || '').trim()
    const id = String(decoded?.id || '').trim()
    if (!createdAt || !id || createdAt.length > 80 || id.length > 300 || !Number.isFinite(Date.parse(createdAt))) {
      throw new Error('invalid cursor')
    }
    const parsedTotal = Number(decoded?.total)
    const hasStableTotal = Number.isInteger(parsedTotal) &&
      parsedTotal >= 0 && parsedTotal <= TOTAL_COUNT_CAP &&
      typeof decoded?.totalIsCapped === 'boolean'
    return {
      createdAt,
      id,
      total: hasStableTotal ? parsedTotal : null,
      totalIsCapped: hasStableTotal ? decoded.totalIsCapped : null
    }
  } catch (error) {
    if (error?.status === 400) throw error
    throw requestError('Cursor inválido')
  }
}

function sqlList(values) {
  return values.map((value) => `'${value}'`).join(', ')
}

function timestampDateExpression(column, timezone = 'UTC', referenceDate = new Date()) {
  if (!isPostgres) {
    return `DATE(datetime(${column}, ${sqliteTimezoneOffsetClause(timezone, referenceDate)}))`
  }
  const safeTimezone = String(timezone || 'UTC').replace(/'/g, "''")
  return `((${column})::timestamptz AT TIME ZONE '${safeTimezone}')::date`
}

function attributionMatchCondition(alias, timezone, referenceDate) {
  const contactDate = timestampDateExpression(`${alias}.created_at`, timezone, referenceDate)
  const adDate = isPostgres ? '(ma.date)::date' : 'DATE(ma.date)'
  return `${alias}.attribution_ad_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM meta_ads ma
    WHERE ma.ad_id = ${alias}.attribution_ad_id
      AND ${adDate} = ${contactDate}
  )`
}

async function getAttributionCalendarIds() {
  const config = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ? LIMIT 1',
    ['attribution_calendar_ids']
  )
  if (!config?.config_value) return []

  try {
    const ids = JSON.parse(config.config_value)
    return Array.isArray(ids) ? ids.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

function normalizedAppointmentStatus(alias) {
  return `LOWER(COALESCE(NULLIF(TRIM(${alias}.appointment_status), ''), NULLIF(TRIM(${alias}.status), ''), ''))`
}

function normalizedSqliteTimestamp(column) {
  if (isPostgres) return column
  const text = `TRIM(CAST(${column} AS TEXT))`
  const numeric = `CAST(${column} AS REAL)`
  const fromEpoch = `CASE WHEN ABS(${numeric}) >= 100000000000
    THEN datetime(${numeric} / 1000.0, 'unixepoch')
    ELSE datetime(${numeric}, 'unixepoch') END`
  return `CASE
    WHEN ${column} IS NULL OR ${text} = '' THEN NULL
    WHEN typeof(${column}) IN ('integer', 'real') THEN ${fromEpoch}
    WHEN ${text} NOT GLOB '*[^0-9]*' THEN ${fromEpoch}
    ELSE datetime(${column})
  END`
}

function addRangeCondition(conditions, params, column, range, { normalized = false } = {}) {
  const placeholder = normalized && !isPostgres ? 'datetime(?)' : '?'
  if (range.startUtc) {
    conditions.push(`${column} >= ${placeholder}`)
    params.push(range.startUtc)
  }
  if (range.endUtc) {
    conditions.push(`${column} <= ${placeholder}`)
    params.push(range.endUtc)
  }
}

function successfulPaymentExists(range, params, {
  useContactCreatedAt = false,
  contactAlias = 'c'
} = {}) {
  const paymentConditions = [
    `p.contact_id = ${contactAlias}.id`,
    `LOWER(p.status) IN (${SUCCESS_PAYMENT_STATUSES.map(() => '?').join(', ')})`,
    nonTestPaymentCondition('p')
  ]
  params.push(...SUCCESS_PAYMENT_STATUSES)
  if (!useContactCreatedAt) addRangeCondition(paymentConditions, params, 'p.date', range)
  return `EXISTS (SELECT 1 FROM payments p WHERE ${paymentConditions.join(' AND ')})`
}

function appointmentCalendarCondition(calendarIds, params, alias = 'a') {
  if (!calendarIds.length) return ''
  params.push(...calendarIds)
  return `${alias}.calendar_id IN (${calendarIds.map(() => '?').join(', ')})`
}

function activeAppointmentExists(range, params, calendarIds, {
  useContactCreatedAt = false,
  contactAlias = 'c'
} = {}) {
  const appointmentConditions = [
    `a.contact_id = ${contactAlias}.id`,
    `${normalizedAppointmentStatus('a')} NOT IN (${sqlList(INACTIVE_APPOINTMENT_STATUSES)})`
  ]
  const calendarCondition = appointmentCalendarCondition(calendarIds, params)
  if (calendarCondition) appointmentConditions.push(calendarCondition)
  if (!useContactCreatedAt) {
    addRangeCondition(
      appointmentConditions,
      params,
      normalizedSqliteTimestamp('a.date_added'),
      range,
      { normalized: true }
    )
  }
  return `EXISTS (SELECT 1 FROM appointments a WHERE ${appointmentConditions.join(' AND ')})`
}

function attendedAppointmentExists(params, calendarIds, { contactAlias = 'c' } = {}) {
  const appointmentConditions = [
    `a.contact_id = ${contactAlias}.id`,
    `${normalizedAppointmentStatus('a')} IN (${sqlList(ATTENDED_APPOINTMENT_STATUSES)})`
  ]
  const calendarCondition = appointmentCalendarCondition(calendarIds, params)
  if (calendarCondition) appointmentConditions.push(calendarCondition)
  return `(
    EXISTS (SELECT 1 FROM appointment_attendance_signals aas WHERE aas.contact_id = ${contactAlias}.id) OR
    EXISTS (SELECT 1 FROM appointments a WHERE ${appointmentConditions.join(' AND ')})
  )`
}

function buildEligibility({
  type,
  scope,
  range,
  hiddenFilters,
  calendarIds,
  search,
  alias = 'c'
}) {
  const params = []
  const conditions = [`${alias}.deleted_at IS NULL`]
  const useContactAttribution = scope === 'attribution' || scope === 'campaigns' || scope === 'attributed'
  const scopeAttributed = scope === 'campaigns' || scope === 'attributed'
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, alias, false)

  if (hiddenCondition) conditions.push(hiddenCondition)
  if (scopeAttributed) conditions.push(attributionMatchCondition(alias, range.appliedTimezone, range.startUtc))

  if (type === 'sales') {
    if (useContactAttribution) addRangeCondition(conditions, params, `${alias}.created_at`, range)
    conditions.push(successfulPaymentExists(range, params, {
      useContactCreatedAt: useContactAttribution,
      contactAlias: alias
    }))
  } else if (type === 'customers' && !useContactAttribution) {
    const firstPaymentConditions = [
      `first_payment.contact_id = ${alias}.id`,
      `LOWER(first_payment.status) IN (${SUCCESS_PAYMENT_STATUSES.map(() => '?').join(', ')})`,
      nonTestPaymentCondition('first_payment'),
      `first_payment.date = (
        SELECT MIN(first_payment_inner.date)
        FROM payments first_payment_inner
        WHERE first_payment_inner.contact_id = ${alias}.id
          AND LOWER(first_payment_inner.status) IN (${SUCCESS_PAYMENT_STATUSES.map(() => '?').join(', ')})
          AND ${nonTestPaymentCondition('first_payment_inner')}
      )`
    ]
    params.push(...SUCCESS_PAYMENT_STATUSES, ...SUCCESS_PAYMENT_STATUSES)
    addRangeCondition(firstPaymentConditions, params, 'first_payment.date', range)
    conditions.push(`EXISTS (SELECT 1 FROM payments first_payment WHERE ${firstPaymentConditions.join(' AND ')})`)
  } else if (type === 'appointments') {
    if (useContactAttribution) addRangeCondition(conditions, params, `${alias}.created_at`, range)
    conditions.push(activeAppointmentExists(range, params, calendarIds, {
      useContactCreatedAt: useContactAttribution,
      contactAlias: alias
    }))
  } else if (type === 'attendances') {
    addRangeCondition(conditions, params, `${alias}.created_at`, range)
    conditions.push(attendedAppointmentExists(params, calendarIds, { contactAlias: alias }))
  } else {
    addRangeCondition(conditions, params, `${alias}.created_at`, range)
    if (type === 'customers') conditions.push(`COALESCE(${alias}.purchases_count, 0) > 0`)
  }

  const cleanSearch = normalizeReportContactsSearch(search)
  if (cleanSearch) {
    const pattern = `%${cleanSearch}%`
    conditions.push(`LOWER(
      COALESCE(${alias}.full_name, '') || ' ' ||
      COALESCE(${alias}.email, '') || ' ' ||
      COALESCE(${alias}.phone, '') || ' ' ||
      ${alias}.id
    ) LIKE ?`)
    params.push(pattern)
  }

  return { conditions, params, useContactAttribution }
}

function mapContactRow(row) {
  return {
    id: row.id,
    name: row.full_name || '',
    email: row.email || '',
    phone: row.phone || '',
    created_at: row.created_at,
    ltv: Number(row.ltv || 0),
    purchases: Number(row.purchases || 0),
    attributed: Boolean(row.attribution_ad_id),
    source: row.source || null,
    ad_name: row.attribution_ad_name || null,
    ad_id: row.attribution_ad_id || null,
    lifetimeLtv: Number(row.total_paid || 0),
    lifetimePurchases: Number(row.purchases_count || 0),
    isCustomer: Number(row.total_paid || 0) > 0 || Number(row.purchases_count || 0) > 0,
    hasAppointments: Boolean(row.has_appointments),
    hasShowedAppointment: Boolean(row.has_attended_appointment),
    hasAttendedAppointment: Boolean(row.has_attended_appointment)
  }
}

export async function listReportContactsPage({
  startDate,
  endDate,
  type = 'interesados',
  scope = 'all',
  dedupeByPerson = false,
  search = '',
  cursor,
  limit = DEFAULT_PAGE_LIMIT
} = {}) {
  const cleanType = VALID_TYPES.has(type) ? type : 'interesados'
  const cleanScope = VALID_SCOPES.has(scope) ? scope : 'all'
  const limitNumber = normalizeLimit(limit)
  const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
  const [hiddenFilters, calendarIds, identityProjectionStatus] = await Promise.all([
    getHiddenContactFilters(),
    getAttributionCalendarIds(),
    dedupeByPerson
      ? getContactPersonIdentityProjectionStatus({ schedule: false })
      : Promise.resolve({ available: true, ready: true, status: 'not-required' })
  ])
  const cursorScope = hashPaginationCursorScope('report-contacts', {
    range: paginationCursorRangeScope(range),
    type: cleanType,
    scope: cleanScope,
    dedupeByPerson: Boolean(dedupeByPerson),
    search: normalizeReportContactsSearch(search),
    hiddenFilters: paginationCursorHiddenFiltersScope(hiddenFilters),
    calendarIds: paginationCursorListScope(calendarIds),
    paymentStatuses: paginationCursorListScope(SUCCESS_PAYMENT_STATUSES),
    inactiveAppointmentStatuses: paginationCursorListScope(INACTIVE_APPOINTMENT_STATUSES),
    attendedAppointmentStatuses: paginationCursorListScope(ATTENDED_APPOINTMENT_STATUSES),
    paymentMode: 'non-test',
    sort: ['created_at:desc', 'id:desc']
  })
  const decodedCursor = decodeCursor(cursor, cursorScope)
  if (dedupeByPerson && !identityProjectionStatus.ready) {
    throw createContactPersonIdentityWarmingError()
  }

  const eligibility = buildEligibility({
    type: cleanType,
    scope: cleanScope,
    range,
    hiddenFilters,
    calendarIds,
    search,
    alias: 'c'
  })
  const newerEligibility = dedupeByPerson
    ? buildEligibility({
        type: cleanType,
        scope: cleanScope,
        range,
        hiddenFilters,
        calendarIds,
        search,
        alias: 'newer_contact'
      })
    : { conditions: [], params: [] }
  const identityJoin = dedupeByPerson
    ? 'INNER JOIN contact_person_identity identity_projection ON identity_projection.contact_id = c.id'
    : ''
  const pageContactsFrom = isPostgres
    ? 'contacts c'
    : 'contacts c INDEXED BY idx_contacts_cursor_effective_created_at_id'
  const representativeCondition = dedupeByPerson
    ? `NOT EXISTS (
        SELECT 1
        FROM contact_person_identity newer_identity
        INNER JOIN contacts newer_contact ON newer_contact.id = newer_identity.contact_id
        WHERE newer_identity.report_person_key = identity_projection.report_person_key
          AND ${newerEligibility.conditions.join(' AND ')}
          AND (
            ${contactCursorSortExpression('newer_contact')}, newer_contact.id
          ) > (
            ${contactCursorSortExpression('c')}, c.id
          )
      )`
    : '1 = 1'
  const pageConditions = [...eligibility.conditions, representativeCondition]
  const cursorSortExpression = contactCursorSortExpression('c')
  const cursorParams = []
  if (decodedCursor) {
    pageConditions.push(`(${cursorSortExpression}, c.id) < (?, ?) `)
    cursorParams.push(decodedCursor.createdAt, decodedCursor.id)
  }

  const activeAppointmentExpression = `EXISTS (
    SELECT 1 FROM appointments detail_appointment
    WHERE detail_appointment.contact_id = c.id
      AND ${normalizedAppointmentStatus('detail_appointment')} NOT IN (${sqlList(INACTIVE_APPOINTMENT_STATUSES)})
  )`
  const attendedAppointmentExpression = `(
    EXISTS (SELECT 1 FROM appointment_attendance_signals detail_signal WHERE detail_signal.contact_id = c.id) OR
    EXISTS (
      SELECT 1 FROM appointments detail_attendance
      WHERE detail_attendance.contact_id = c.id
        AND ${normalizedAppointmentStatus('detail_attendance')} IN (${sqlList(ATTENDED_APPOINTMENT_STATUSES)})
    )
  )`
  const usePeriodPaymentDetails = cleanType === 'sales' && !eligibility.useContactAttribution
  const periodPaymentConditions = []
  const detailPaymentParams = []
  if (usePeriodPaymentDetails) {
    periodPaymentConditions.push(
      'detail_payment.contact_id = c.id',
      `LOWER(detail_payment.status) IN (${SUCCESS_PAYMENT_STATUSES.map(() => '?').join(', ')})`,
      nonTestPaymentCondition('detail_payment')
    )
    detailPaymentParams.push(...SUCCESS_PAYMENT_STATUSES)
    addRangeCondition(periodPaymentConditions, detailPaymentParams, 'detail_payment.date', range)
  }
  const ltvExpression = usePeriodPaymentDetails
    ? `COALESCE((SELECT SUM(detail_payment.amount) FROM payments detail_payment WHERE ${periodPaymentConditions.join(' AND ')}), 0)`
    : 'COALESCE(c.total_paid, 0)'
  const purchasesExpression = usePeriodPaymentDetails
    ? `(SELECT COUNT(*) FROM payments detail_payment WHERE ${periodPaymentConditions.join(' AND ')})`
    : 'COALESCE(c.purchases_count, 0)'

  const rowsPromise = db.all(
    `SELECT
       c.id, c.full_name, c.email, c.phone, c.created_at, c.total_paid, c.purchases_count,
       c.attribution_ad_id, c.attribution_ad_name, c.source,
       ${contactCursorProjectionExpression('c')} AS cursor_created_at,
       ${ltvExpression} AS ltv,
       ${purchasesExpression} AS purchases,
       ${activeAppointmentExpression} AS has_appointments,
       ${attendedAppointmentExpression} AS has_attended_appointment
     FROM ${pageContactsFrom}
     ${identityJoin}
     WHERE ${pageConditions.join(' AND ')}
     ORDER BY ${cursorSortExpression} DESC, c.id DESC
     LIMIT ?`,
    [
      ...detailPaymentParams,
      ...detailPaymentParams,
      ...eligibility.params,
      ...newerEligibility.params,
      ...cursorParams,
      limitNumber + 1
    ]
  )

  // El total acotado se calcula una sola vez y viaja firmado por el scope del
  // cursor. Las paginas siguientes no vuelven a recorrer las primeras 10k filas.
  const shouldCount = !decodedCursor || decodedCursor.total === null
  const countPromise = shouldCount
    ? db.get(
      `SELECT COUNT(*) AS total
     FROM (
       SELECT 1
       FROM contacts c
       ${identityJoin}
       WHERE ${eligibility.conditions.join(' AND ')}
         AND ${representativeCondition}
       LIMIT ?
     ) capped_contacts`,
      [...eligibility.params, ...newerEligibility.params, TOTAL_COUNT_CAP + 1]
    )
    : Promise.resolve({
        total: decodedCursor.total + (decodedCursor.totalIsCapped ? 1 : 0)
      })

  const [rows, countRow] = await Promise.all([rowsPromise, countPromise])
  const hasNext = rows.length > limitNumber
  const pageRows = hasNext ? rows.slice(0, limitNumber) : rows
  const countedTotal = Number(countRow?.total || 0)

  return {
    range,
    contacts: pageRows.map(mapContactRow),
    pagination: {
      limit: limitNumber,
      total: Math.min(countedTotal, TOTAL_COUNT_CAP),
      totalIsCapped: countedTotal > TOTAL_COUNT_CAP,
      hasNext,
      nextCursor: hasNext
        ? encodeCursor(pageRows[pageRows.length - 1], cursorScope, {
            total: Math.min(countedTotal, TOTAL_COUNT_CAP),
            totalIsCapped: countedTotal > TOTAL_COUNT_CAP
          })
        : null
    }
  }
}

export const REPORT_CONTACTS_PAGE_LIMITS = Object.freeze({
  default: DEFAULT_PAGE_LIMIT,
  max: MAX_PAGE_LIMIT,
  totalCap: TOTAL_COUNT_CAP
})
