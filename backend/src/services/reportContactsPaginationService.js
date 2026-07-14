import { databaseDialect, db } from '../config/database.js'
import { resolveDateRangeWithGHLTimezone, sqliteTimezoneOffsetClause } from '../utils/dateUtils.js'
import { buildHiddenContactsCondition, getHiddenContactFilters } from '../utils/hiddenContactsFilter.js'
import { nonTestPaymentCondition, SUCCESS_PAYMENT_STATUSES } from '../utils/paymentMode.js'

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

function encodeCursor(row) {
  if (!row?.created_at || !row?.id) return null
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id }), 'utf8').toString('base64url')
}

function decodeCursor(value) {
  const clean = String(value || '').trim()
  if (!clean) return null
  if (clean.length > 2048) throw requestError('Cursor inválido')

  try {
    const decoded = JSON.parse(Buffer.from(clean, 'base64url').toString('utf8'))
    const createdAt = String(decoded?.createdAt || '').trim()
    const id = String(decoded?.id || '').trim()
    if (!createdAt || !id || createdAt.length > 80 || id.length > 300 || !Number.isFinite(Date.parse(createdAt))) {
      throw new Error('invalid cursor')
    }
    return { createdAt, id }
  } catch {
    throw requestError('Cursor inválido')
  }
}

function sqlList(values) {
  return values.map((value) => `'${value}'`).join(', ')
}

function buildDedupExpression(alias = 'c') {
  if (isPostgres) {
    const phoneDigits = `REGEXP_REPLACE(COALESCE(${alias}.phone, ''), '[^0-9]', '', 'g')`
    return `CASE
      WHEN ${alias}.email IS NOT NULL AND ${alias}.email LIKE '%@%'
        THEN CONCAT('email::', LOWER(TRIM(${alias}.email)))
      WHEN ${alias}.phone IS NOT NULL AND LENGTH(${phoneDigits}) >= 10
        THEN CONCAT('phone::', RIGHT(${phoneDigits}, 10))
      ELSE CONCAT('id::', ${alias}.id::text)
    END`
  }

  const canonicalPhone = `(SELECT cpn.phone
    FROM contact_phone_numbers cpn
    WHERE cpn.contact_id = ${alias}.id
    ORDER BY cpn.is_primary DESC, cpn.updated_at DESC, cpn.id
    LIMIT 1)`
  const canonicalDigits = `REPLACE(COALESCE(${canonicalPhone}, ''), '+', '')`
  const legacyPersonKey = `(WITH RECURSIVE normalized_phone(rest, digits) AS (
    SELECT COALESCE(CAST(${alias}.phone AS TEXT), ''), ''
    UNION ALL
    SELECT
      SUBSTR(rest, 2),
      digits || CASE WHEN SUBSTR(rest, 1, 1) GLOB '[0-9]' THEN SUBSTR(rest, 1, 1) ELSE '' END
    FROM normalized_phone
    WHERE rest != ''
  )
  SELECT CASE
    WHEN LENGTH(digits) >= 10 THEN 'phone::' || SUBSTR(digits, -10)
    ELSE 'id::' || ${alias}.id
  END
  FROM normalized_phone
  WHERE rest = ''
  LIMIT 1)`
  const phonePersonKey = `(WITH canonical_phone(canonical_digits) AS MATERIALIZED (
    SELECT ${canonicalDigits}
  )
  SELECT CASE
    WHEN LENGTH(canonical_digits) >= 10 THEN 'phone::' || SUBSTR(canonical_digits, -10)
    ELSE ${legacyPersonKey}
  END
  FROM canonical_phone)`
  return `CASE
    WHEN ${alias}.email IS NOT NULL AND ${alias}.email LIKE '%@%'
      THEN 'email::' || LOWER(TRIM(${alias}.email))
    ELSE ${phonePersonKey}
  END`
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

function successfulPaymentExists(range, params, { useContactCreatedAt = false } = {}) {
  const paymentConditions = [
    'p.contact_id = c.id',
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

function activeAppointmentExists(range, params, calendarIds, { useContactCreatedAt = false } = {}) {
  const appointmentConditions = [
    'a.contact_id = c.id',
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

function attendedAppointmentExists(params, calendarIds) {
  const appointmentConditions = [
    'a.contact_id = c.id',
    `${normalizedAppointmentStatus('a')} IN (${sqlList(ATTENDED_APPOINTMENT_STATUSES)})`
  ]
  const calendarCondition = appointmentCalendarCondition(calendarIds, params)
  if (calendarCondition) appointmentConditions.push(calendarCondition)
  return `(
    EXISTS (SELECT 1 FROM appointment_attendance_signals aas WHERE aas.contact_id = c.id) OR
    EXISTS (SELECT 1 FROM appointments a WHERE ${appointmentConditions.join(' AND ')})
  )`
}

function buildEligibility({ type, scope, range, hiddenCondition, calendarIds, search }) {
  const params = []
  const conditions = ['c.deleted_at IS NULL']
  const useContactAttribution = scope === 'attribution' || scope === 'campaigns' || scope === 'attributed'
  const scopeAttributed = scope === 'campaigns' || scope === 'attributed'

  if (hiddenCondition) conditions.push(hiddenCondition)
  if (scopeAttributed) conditions.push(attributionMatchCondition('c', range.appliedTimezone, range.startUtc))

  if (type === 'sales') {
    if (useContactAttribution) addRangeCondition(conditions, params, 'c.created_at', range)
    conditions.push(successfulPaymentExists(range, params, { useContactCreatedAt: useContactAttribution }))
  } else if (type === 'customers' && !useContactAttribution) {
    const firstPaymentConditions = [
      'first_payment.contact_id = c.id',
      `LOWER(first_payment.status) IN (${SUCCESS_PAYMENT_STATUSES.map(() => '?').join(', ')})`,
      nonTestPaymentCondition('first_payment'),
      `first_payment.date = (
        SELECT MIN(first_payment_inner.date)
        FROM payments first_payment_inner
        WHERE first_payment_inner.contact_id = c.id
          AND LOWER(first_payment_inner.status) IN (${SUCCESS_PAYMENT_STATUSES.map(() => '?').join(', ')})
          AND ${nonTestPaymentCondition('first_payment_inner')}
      )`
    ]
    params.push(...SUCCESS_PAYMENT_STATUSES, ...SUCCESS_PAYMENT_STATUSES)
    addRangeCondition(firstPaymentConditions, params, 'first_payment.date', range)
    conditions.push(`EXISTS (SELECT 1 FROM payments first_payment WHERE ${firstPaymentConditions.join(' AND ')})`)
  } else if (type === 'appointments') {
    if (useContactAttribution) addRangeCondition(conditions, params, 'c.created_at', range)
    conditions.push(activeAppointmentExists(range, params, calendarIds, { useContactCreatedAt: useContactAttribution }))
  } else if (type === 'attendances') {
    addRangeCondition(conditions, params, 'c.created_at', range)
    conditions.push(attendedAppointmentExists(params, calendarIds))
  } else {
    addRangeCondition(conditions, params, 'c.created_at', range)
    if (type === 'customers') conditions.push('COALESCE(c.purchases_count, 0) > 0')
  }

  const cleanSearch = String(search || '').trim().toLowerCase().slice(0, 200)
  if (cleanSearch) {
    const pattern = `%${cleanSearch}%`
    conditions.push(`LOWER(
      COALESCE(c.full_name, '') || ' ' ||
      COALESCE(c.email, '') || ' ' ||
      COALESCE(c.phone, '') || ' ' ||
      c.id
    ) LIKE ?`)
    params.push(pattern)
  }

  return { conditions, params, useContactAttribution }
}

function buildEligibleCte(conditions, dedupeByPerson) {
  const personRank = dedupeByPerson
    ? `ROW_NUMBER() OVER (
        PARTITION BY ${buildDedupExpression('c')}
        ORDER BY c.created_at DESC, c.id DESC
      )`
    : '1'

  return `WITH eligible_contacts AS (
    SELECT c.*, ${personRank} AS person_rank
    FROM contacts c
    WHERE ${conditions.join(' AND ')}
  )`
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
  const decodedCursor = decodeCursor(cursor)
  const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
  const [hiddenFilters, calendarIds] = await Promise.all([
    getHiddenContactFilters(),
    getAttributionCalendarIds()
  ])
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
  const eligibility = buildEligibility({
    type: cleanType,
    scope: cleanScope,
    range,
    hiddenCondition,
    calendarIds,
    search
  })
  const cte = buildEligibleCte(eligibility.conditions, dedupeByPerson)
  const pageConditions = ['person_rank = 1']
  const cursorParams = []
  if (decodedCursor) {
    pageConditions.push('(created_at, id) < (?, ?)')
    cursorParams.push(decodedCursor.createdAt, decodedCursor.id)
  }

  const activeAppointmentExpression = `EXISTS (
    SELECT 1 FROM appointments detail_appointment
    WHERE detail_appointment.contact_id = eligible_contacts.id
      AND ${normalizedAppointmentStatus('detail_appointment')} NOT IN (${sqlList(INACTIVE_APPOINTMENT_STATUSES)})
  )`
  const attendedAppointmentExpression = `(
    EXISTS (SELECT 1 FROM appointment_attendance_signals detail_signal WHERE detail_signal.contact_id = eligible_contacts.id) OR
    EXISTS (
      SELECT 1 FROM appointments detail_attendance
      WHERE detail_attendance.contact_id = eligible_contacts.id
        AND ${normalizedAppointmentStatus('detail_attendance')} IN (${sqlList(ATTENDED_APPOINTMENT_STATUSES)})
    )
  )`
  const usePeriodPaymentDetails = cleanType === 'sales' && !eligibility.useContactAttribution
  const periodPaymentConditions = []
  const detailPaymentParams = []
  if (usePeriodPaymentDetails) {
    periodPaymentConditions.push(
      'detail_payment.contact_id = eligible_contacts.id',
      `LOWER(detail_payment.status) IN (${SUCCESS_PAYMENT_STATUSES.map(() => '?').join(', ')})`,
      nonTestPaymentCondition('detail_payment')
    )
    detailPaymentParams.push(...SUCCESS_PAYMENT_STATUSES)
    addRangeCondition(periodPaymentConditions, detailPaymentParams, 'detail_payment.date', range)
  }
  const ltvExpression = usePeriodPaymentDetails
    ? `COALESCE((SELECT SUM(detail_payment.amount) FROM payments detail_payment WHERE ${periodPaymentConditions.join(' AND ')}), 0)`
    : 'COALESCE(total_paid, 0)'
  const purchasesExpression = usePeriodPaymentDetails
    ? `(SELECT COUNT(*) FROM payments detail_payment WHERE ${periodPaymentConditions.join(' AND ')})`
    : 'COALESCE(purchases_count, 0)'

  const rowsPromise = db.all(
    `${cte}
     SELECT
       id, full_name, email, phone, created_at, total_paid, purchases_count,
       attribution_ad_id, attribution_ad_name, source,
       ${ltvExpression} AS ltv,
       ${purchasesExpression} AS purchases,
       ${activeAppointmentExpression} AS has_appointments,
       ${attendedAppointmentExpression} AS has_attended_appointment
     FROM eligible_contacts
     WHERE ${pageConditions.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [...eligibility.params, ...detailPaymentParams, ...detailPaymentParams, ...cursorParams, limitNumber + 1]
  )

  const countPromise = db.get(
    `${cte}
     SELECT COUNT(*) AS total
     FROM (
       SELECT 1
       FROM eligible_contacts
       WHERE person_rank = 1
       LIMIT ?
     ) capped_contacts`,
    [...eligibility.params, TOTAL_COUNT_CAP + 1]
  )

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
      nextCursor: hasNext ? encodeCursor(pageRows[pageRows.length - 1]) : null
    }
  }
}

export const REPORT_CONTACTS_PAGE_LIMITS = Object.freeze({
  default: DEFAULT_PAGE_LIMIT,
  max: MAX_PAGE_LIMIT,
  totalCap: TOTAL_COUNT_CAP
})
