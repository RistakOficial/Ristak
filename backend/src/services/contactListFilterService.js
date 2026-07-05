import { DateTime } from 'luxon'
import { resolveDateRange } from '../utils/dateUtils.js'
import { nonTestPaymentCondition, SUCCESS_PAYMENT_STATUSES } from '../utils/paymentMode.js'
import { buildContactSearchClause, containsPattern, textFoldExpression } from '../utils/searchText.js'
import { timestampSortExpression } from '../utils/sqlTimestampSort.js'

const isPostgresDatabase = Boolean(process.env.DATABASE_URL)

export const CONTACT_LIST_QUICK_FILTERS = new Set(['all', 'leads', 'appointments', 'attendances', 'customers'])

const APPOINTMENT_CANCELED_STATUSES = new Set([
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
])
const APPOINTMENT_CANCELLED_ONLY_STATUSES = new Set([
  'cancelled',
  'canceled',
  'invalid',
  'failed',
  'deleted',
  'void',
  'voided'
])
const APPOINTMENT_NO_SHOW_STATUSES = new Set(['no_show', 'no-show', 'noshow', 'missed'])
const APPOINTMENT_ATTENDED_STATUSES = new Set(['showed', 'show', 'attended', 'completed', 'complete'])
const FAILED_PAYMENT_STATUSES = [
  'failed',
  'declined',
  'rejected',
  'canceled',
  'cancelled',
  'expired',
  'void',
  'voided',
  'refunded',
  'chargeback',
  'disputed'
]
const PAYMENT_STATUS_OPTIONS = [...SUCCESS_PAYMENT_STATUSES, ...FAILED_PAYMENT_STATUSES]
const PENDING_INSTALLMENT_STATUSES = new Set(['pending', 'scheduled', 'due'])
const OVERDUE_INSTALLMENT_STATUSES = new Set(['pending', 'scheduled', 'due', 'failed'])

const sqlList = values => [...values].map(value => `'${String(value).replace(/'/g, "''")}'`).join(', ')

export const CONTACT_LIST_ACTIVE_APPOINTMENT_CONDITION = `LOWER(COALESCE(appointment_status, status, '')) NOT IN (${sqlList(APPOINTMENT_CANCELED_STATUSES)})`
export const CONTACT_LIST_ATTENDED_APPOINTMENT_CONDITION = `LOWER(COALESCE(appointment_status, status, '')) IN (${sqlList(APPOINTMENT_ATTENDED_STATUSES)})`

const cleanString = (value, maxLength = 500) => {
  const cleaned = String(value ?? '').replace(/\s+/g, ' ').trim()
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned
}

const uniqueCleanStrings = (values = [], maxLength = 500) => (
  [...new Set((Array.isArray(values) ? values : [values])
    .map(value => cleanString(value, maxLength))
    .filter(Boolean))]
)

const numberValue = (value) => {
  const number = Number(String(value ?? '').replace(/,/g, '').trim())
  return Number.isFinite(number) ? number : null
}

const lowerValue = (value) => cleanString(value).toLowerCase()

const placeholderList = (values = []) => values.map(() => '?').join(', ')

const paymentCustomerPredicate = (alias = 'p') => (
  `${alias}.amount > 0 AND LOWER(COALESCE(${alias}.status, '')) IN (${sqlList(SUCCESS_PAYMENT_STATUSES)})`
)

const paymentSuccessPredicate = (alias = 'p') => (
  `${paymentCustomerPredicate(alias)} AND ${nonTestPaymentCondition(alias)}`
)

const paymentFailedPredicate = (alias = 'p') => (
  `${alias}.amount > 0 AND LOWER(COALESCE(${alias}.status, '')) IN (${sqlList(FAILED_PAYMENT_STATUSES)}) AND ${nonTestPaymentCondition(alias)}`
)

const paymentLivePredicate = (alias = 'p') => (
  `${alias}.amount > 0 AND ${nonTestPaymentCondition(alias)}`
)

const existsCustomerPayment = (contactAlias = 'c') => (
  `EXISTS (
    SELECT 1
    FROM payments p_stage_customer
    WHERE p_stage_customer.contact_id = ${contactAlias}.id
      AND ${paymentCustomerPredicate('p_stage_customer')}
  )`
)

const existsActiveAppointment = (contactAlias = 'c') => (
  `EXISTS (
    SELECT 1
    FROM appointments a_stage_active
    WHERE a_stage_active.contact_id = ${contactAlias}.id
      AND ${CONTACT_LIST_ACTIVE_APPOINTMENT_CONDITION}
  )`
)

const existsAttendedAppointment = (contactAlias = 'c') => (
  `EXISTS (
    SELECT 1
    FROM appointments a_stage_attended
    WHERE a_stage_attended.contact_id = ${contactAlias}.id
      AND ${CONTACT_LIST_ATTENDED_APPOINTMENT_CONDITION}
  )`
)

const existsAttendanceSignal = (contactAlias = 'c') => (
  `EXISTS (
    SELECT 1
    FROM appointment_attendance_signals aas_stage
    WHERE aas_stage.contact_id = ${contactAlias}.id
  )`
)

const buildQuickFilterCondition = (quickFilter = 'all', contactAlias = 'c') => {
  const filter = CONTACT_LIST_QUICK_FILTERS.has(String(quickFilter)) ? String(quickFilter) : 'all'
  const customer = existsCustomerPayment(contactAlias)
  const activeAppointment = existsActiveAppointment(contactAlias)

  if (filter === 'customers') return customer
  if (filter === 'appointments') return `(${activeAppointment} AND NOT ${customer})`
  if (filter === 'attendances') {
    return `(${customer} OR ${existsAttendanceSignal(contactAlias)} OR ${existsAttendedAppointment(contactAlias)})`
  }
  if (filter === 'leads') return `(NOT ${customer} AND NOT ${activeAppointment})`
  return ''
}

const contactStageExpression = (contactAlias = 'c') => (
  `CASE
    WHEN ${existsCustomerPayment(contactAlias)} THEN 'customer'
    WHEN ${existsActiveAppointment(contactAlias)} THEN 'appointment'
    ELSE 'lead'
  END`
)

export const contactListPrioritySortExpression = (contactAlias = 'c', paymentStatsAlias = 'ps') => (
  `CASE
    WHEN COALESCE(${paymentStatsAlias}.customer_payments_count, ${paymentStatsAlias}.purchases_count, 0) > 0 THEN 4
    WHEN ${existsAttendanceSignal(contactAlias)} OR ${existsAttendedAppointment(contactAlias)} THEN 3
    WHEN ${existsActiveAppointment(contactAlias)} THEN 2
    ELSE 1
  END`
)

const appointmentStatusExpression = (alias = 'a') => `LOWER(COALESCE(${alias}.appointment_status, ${alias}.status, ''))`
const appointmentDateExpression = (alias = 'a') => `COALESCE(${alias}.start_time, ${alias}.date_added, ${alias}.created_at)`
const appointmentActiveCondition = (alias = 'a') => `${appointmentStatusExpression(alias)} NOT IN (${sqlList(APPOINTMENT_CANCELED_STATUSES)})`
const appointmentAttendedCondition = (alias = 'a') => `${appointmentStatusExpression(alias)} IN (${sqlList(APPOINTMENT_ATTENDED_STATUSES)})`
const appointmentCancelledOnlyCondition = (alias = 'a') => `${appointmentStatusExpression(alias)} IN (${sqlList(APPOINTMENT_CANCELLED_ONLY_STATUSES)})`
const appointmentNoShowCondition = (alias = 'a') => `${appointmentStatusExpression(alias)} IN (${sqlList(APPOINTMENT_NO_SHOW_STATUSES)})`
const currentTimestampExpression = () => (isPostgresDatabase ? 'CURRENT_TIMESTAMP' : "datetime('now')")
const timestampCompareExpression = (expression) => (isPostgresDatabase ? expression : `datetime(${expression})`)
const appointmentHasDateCondition = (alias = 'a') => `NULLIF(TRIM(CAST(${appointmentDateExpression(alias)} AS TEXT)), '') IS NOT NULL`
const futureAppointmentCondition = (alias = 'a') => (
  `${appointmentActiveCondition(alias)}
    AND ${appointmentHasDateCondition(alias)}
    AND ${timestampCompareExpression(appointmentDateExpression(alias))} >= ${currentTimestampExpression()}`
)
const pastAppointmentCondition = (alias = 'a') => (
  `${appointmentActiveCondition(alias)}
    AND ${appointmentHasDateCondition(alias)}
    AND ${timestampCompareExpression(appointmentDateExpression(alias))} < ${currentTimestampExpression()}`
)

const appointmentCountExpression = (contactAlias = 'c', condition = '') => (
  `(SELECT COUNT(*)
    FROM appointments a_count
    WHERE a_count.contact_id = ${contactAlias}.id
      ${condition ? `AND ${condition}` : ''})`
)

const appointmentDateAggregateExpression = (aggregate = 'MAX', contactAlias = 'c', condition = '') => {
  const alias = 'a_date'
  return `(SELECT ${aggregate}(${appointmentDateExpression(alias)})
    FROM appointments ${alias}
    WHERE ${alias}.contact_id = ${contactAlias}.id
      ${condition ? `AND ${condition}` : ''})`
}

export function getContactListSortExpression(sortBy, contactAlias = 'c', paymentStatsAlias = 'ps') {
  const createdAtSortExpression = timestampSortExpression(`${contactAlias}.created_at`)
  const sortableMap = {
    priority: contactListPrioritySortExpression(contactAlias, paymentStatsAlias),
    created_at: createdAtSortExpression,
    updated_at: timestampSortExpression(`${contactAlias}.updated_at`),
    full_name: `${contactAlias}.full_name`,
    email: `${contactAlias}.email`,
    phone: `${contactAlias}.phone`,
    total_paid: `COALESCE(${paymentStatsAlias}.total_paid, 0)`,
    purchases_count: `COALESCE(${paymentStatsAlias}.purchases_count, 0)`,
    payments_count: `COALESCE(${paymentStatsAlias}.payments_count, 0)`,
    failed_payments_count: `COALESCE(${paymentStatsAlias}.failed_payments_count, 0)`,
    last_purchase_date: timestampSortExpression(`${paymentStatsAlias}.last_purchase_date`),
    appointments_count: appointmentCountExpression(contactAlias),
    active_appointments_count: appointmentCountExpression(contactAlias, CONTACT_LIST_ACTIVE_APPOINTMENT_CONDITION),
    attended_appointments_count: appointmentCountExpression(contactAlias, CONTACT_LIST_ATTENDED_APPOINTMENT_CONDITION),
    next_appointment_date: timestampSortExpression(appointmentDateAggregateExpression('MIN', contactAlias, futureAppointmentCondition('a_date'))),
    last_appointment_date: timestampSortExpression(appointmentDateAggregateExpression('MAX', contactAlias))
  }

  return sortableMap[String(sortBy || '')] || createdAtSortExpression
}

export function buildContactListPaymentStatsCte() {
  return `
      payment_stats AS (
        SELECT
          contact_id,
          SUM(CASE
                WHEN ${paymentSuccessPredicate('payments')}
                THEN amount ELSE 0 END) AS total_paid,
          SUM(CASE
                WHEN ${paymentLivePredicate('payments')}
                THEN 1 ELSE 0 END) AS payments_count,
          SUM(CASE
                WHEN ${paymentSuccessPredicate('payments')}
                THEN 1 ELSE 0 END) AS purchases_count,
          SUM(CASE
                WHEN ${paymentCustomerPredicate('payments')}
                THEN 1 ELSE 0 END) AS customer_payments_count,
          SUM(CASE
                WHEN ${paymentFailedPredicate('payments')}
                THEN 1 ELSE 0 END) AS failed_payments_count,
          MAX(CASE
                WHEN ${paymentSuccessPredicate('payments')}
                THEN COALESCE(paid_at, date, created_at) ELSE NULL END) AS last_purchase_date,
          MAX(CASE
                WHEN ${paymentCustomerPredicate('payments')}
                THEN COALESCE(paid_at, date, created_at) ELSE NULL END) AS last_customer_payment_date
        FROM payments
        GROUP BY contact_id
      )
  `
}

export function parseContactListJsonParam(raw, fallback = {}) {
  if (!raw) return fallback
  if (typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(String(raw))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

export function normalizeContactListQuickFilter(value = 'all') {
  const clean = cleanString(value, 40)
  return CONTACT_LIST_QUICK_FILTERS.has(clean) ? clean : 'all'
}

export function normalizeContactListTrackingFilters(raw = {}) {
  const parsed = parseContactListJsonParam(raw, {})
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

  return Object.entries(parsed).reduce((acc, [field, values]) => {
    const cleanField = cleanString(field, 80)
    const cleanValues = uniqueCleanStrings(values, 500)
    if (cleanField && cleanValues.length > 0) acc[cleanField] = cleanValues
    return acc
  }, {})
}

export function normalizeContactAdvancedFilters(raw = {}) {
  const parsed = parseContactListJsonParam(raw, {})
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { version: 1, groups: [] }
  }

  const groups = Array.isArray(parsed.groups)
    ? parsed.groups.map((group, groupIndex) => {
        const rules = Array.isArray(group?.rules)
          ? group.rules.map((rule, ruleIndex) => ({
              id: cleanString(rule?.id, 120) || `rule_${groupIndex}_${ruleIndex}`,
              field: cleanString(rule?.field, 120),
              operator: cleanString(rule?.operator, 80),
              value: rule?.value,
              valueTo: rule?.valueTo,
              customKey: cleanString(rule?.customKey, 180),
              valueType: cleanString(rule?.valueType, 40)
            })).filter(rule => rule.field && rule.operator)
          : []

        return {
          id: cleanString(group?.id, 120) || `group_${groupIndex}`,
          mode: group?.mode === 'any' ? 'any' : 'all',
          negate: Boolean(group?.negate),
          rules
        }
      }).filter(group => group.rules.length > 0)
    : []

  const sort = parsed.sort && typeof parsed.sort === 'object'
    ? {
        by: cleanString(parsed.sort.by, 80),
        order: String(parsed.sort.order || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
      }
    : null

  return {
    version: 1,
    groupMode: parsed.groupMode === 'any' ? 'any' : 'all',
    groups,
    ...(sort?.by ? { sort } : {})
  }
}

const contactTextFieldExpression = (field, contactAlias = 'c') => {
  const fullName = `COALESCE(${contactAlias}.full_name, '') || ' ' || COALESCE(${contactAlias}.first_name, '') || ' ' || COALESCE(${contactAlias}.last_name, '')`
  const fields = {
    full_name: fullName,
    first_name: `${contactAlias}.first_name`,
    last_name: `${contactAlias}.last_name`,
    email: `${contactAlias}.email`,
    phone: `${contactAlias}.phone`,
    source: `${contactAlias}.source`,
    visitor_id: `${contactAlias}.visitor_id`,
    assigned_user_id: `${contactAlias}.assigned_user_id`,
    ghl_contact_id: `${contactAlias}.ghl_contact_id`,
    stripe_customer_id: `${contactAlias}.stripe_customer_id`,
    conekta_customer_id: `${contactAlias}.conekta_customer_id`,
    attribution_url: `${contactAlias}.attribution_url`,
    attribution_session_source: `${contactAlias}.attribution_session_source`,
    attribution_medium: `${contactAlias}.attribution_medium`,
    attribution_ctwa_clid: `${contactAlias}.attribution_ctwa_clid`,
    attribution_ad_name: `${contactAlias}.attribution_ad_name`,
    attribution_ad_id: `${contactAlias}.attribution_ad_id`,
    preferred_whatsapp_phone_number_id: `${contactAlias}.preferred_whatsapp_phone_number_id`
  }
  return fields[field] || ''
}

const contactDateFieldExpression = (field, contactAlias = 'c') => {
  const fields = {
    created_at: `${contactAlias}.created_at`,
    updated_at: `${contactAlias}.updated_at`,
    contact_appointment_date: `${contactAlias}.appointment_date`
  }
  return fields[field] || ''
}

const sessionContactMatchCondition = (sessionAlias = 's', contactAlias = 'c') => (
  `(
    ${sessionAlias}.contact_id = ${contactAlias}.id
    OR (${sessionAlias}.visitor_id IS NOT NULL AND ${contactAlias}.visitor_id IS NOT NULL AND ${sessionAlias}.visitor_id = ${contactAlias}.visitor_id)
    OR (NULLIF(${sessionAlias}.email, '') IS NOT NULL AND NULLIF(${contactAlias}.email, '') IS NOT NULL AND LOWER(${sessionAlias}.email) = LOWER(${contactAlias}.email))
  )`
)

const sourceVariantsForLabel = (value) => {
  const clean = lowerValue(value)
  const variantsBySource = {
    facebook: ['facebook', 'fb', 'meta', 'facebook.com', 'fb.com'],
    instagram: ['instagram', 'ig', 'instagram.com'],
    google: ['google', 'ggl', 'adwords', 'google_ads', 'google.com', 'cpc', 'ppc', 'sem'],
    youtube: ['youtube', 'yt', 'youtube.com', 'youtu.be'],
    tiktok: ['tiktok', 'tt', 'ttclid', 'tiktok.com'],
    bing: ['bing', 'msn', 'microsoft', 'msclkid', 'bing.com'],
    twitter: ['twitter', 'x.com', 't.co'],
    linkedin: ['linkedin', 'li', 'linkedin.com'],
    snapchat: ['snapchat', 'snap'],
    pinterest: ['pinterest', 'pin'],
    reddit: ['reddit'],
    whatsapp: ['whatsapp', 'wa.me', 'waapi', 'ycloud', 'ctwa'],
    telegram: ['telegram', 't.me'],
    directo: ['direct', 'directo', '(direct)', 'none'],
    desconocido: ['unknown', 'desconocido'],
    otro: ['otro', 'other']
  }

  return uniqueCleanStrings([clean, ...(variantsBySource[clean] || [])], 120)
}

const buildTextMatchCondition = (expression, operator, value) => {
  const clean = cleanString(value)
  const folded = textFoldExpression(expression)

  if (operator === 'empty') return { condition: `NULLIF(TRIM(COALESCE(${expression}, '')), '') IS NULL`, params: [] }
  if (operator === 'not_empty') return { condition: `NULLIF(TRIM(COALESCE(${expression}, '')), '') IS NOT NULL`, params: [] }
  if (!clean) return null

  const normalized = containsPattern(clean) || '__no_match__'
  if (operator === 'is') return { condition: `${folded} = ?`, params: [lowerValue(clean)] }
  if (operator === 'is_not') return { condition: `${folded} != ?`, params: [lowerValue(clean)] }
  if (operator === 'not_contains') return { condition: `${folded} NOT LIKE ?`, params: [normalized] }
  if (operator === 'starts_with') return { condition: `${folded} LIKE ?`, params: [`${lowerValue(clean)}%`] }
  if (operator === 'ends_with') return { condition: `${folded} LIKE ?`, params: [`%${lowerValue(clean)}`] }

  return { condition: `${folded} LIKE ?`, params: [normalized] }
}

const buildAnyTextMatchCondition = (expressions = [], operator, value) => {
  const conditions = expressions
    .map(expression => buildTextMatchCondition(expression, operator, value))
    .filter(Boolean)
  if (!conditions.length) return null

  const joiner = ['is_not', 'not_contains', 'empty'].includes(operator) ? ' AND ' : ' OR '
  return {
    condition: `(${conditions.map(item => item.condition).join(joiner)})`,
    params: conditions.flatMap(item => item.params || [])
  }
}

const buildNumberMatchCondition = (expression, operator, value, valueTo) => {
  if (operator === 'empty') return { condition: `COALESCE(${expression}, 0) = 0`, params: [] }
  if (operator === 'not_empty') return { condition: `COALESCE(${expression}, 0) != 0`, params: [] }

  const left = numberValue(value)
  if (left === null) return null

  if (operator === 'between') {
    const right = numberValue(valueTo)
    if (right === null) return null
    return { condition: `COALESCE(${expression}, 0) BETWEEN ? AND ?`, params: [Math.min(left, right), Math.max(left, right)] }
  }

  const operatorMap = {
    eq: '=',
    neq: '!=',
    gt: '>',
    lt: '<',
    gte: '>=',
    lte: '<='
  }
  const sqlOperator = operatorMap[operator] || '='
  return { condition: `COALESCE(${expression}, 0) ${sqlOperator} ?`, params: [left] }
}

const dateRangeForRule = ({ operator, value, valueTo, timezone }) => {
  const clean = cleanString(value, 40)
  if (operator === 'last_days' || operator === 'older_days') {
    const days = Math.max(0, Number.parseInt(clean, 10) || 0)
    if (!days) return null
    const threshold = DateTime.utc().minus({ days }).toISO({ suppressMilliseconds: false })
    return { mode: operator === 'last_days' ? 'after_or_equal' : 'before', params: [threshold] }
  }

  if (operator === 'empty' || operator === 'not_empty') return { mode: operator, params: [] }
  if (!clean) return null

  if (operator === 'between') {
    const end = cleanString(valueTo, 40)
    if (!end) return null
    const range = resolveDateRange({ startDate: clean, endDate: end, timezone })
    if (!range.startUtc || !range.endUtc) return null
    return { mode: 'between', params: [range.startUtc, range.endUtc] }
  }

  const singleDayRange = resolveDateRange({ startDate: clean, endDate: clean, timezone })
  if (!singleDayRange.startUtc || !singleDayRange.endUtc) return null

  if (operator === 'before') return { mode: 'before', params: [singleDayRange.startUtc] }
  if (operator === 'after') return { mode: 'after', params: [singleDayRange.endUtc] }
  return { mode: 'between', params: [singleDayRange.startUtc, singleDayRange.endUtc] }
}

const buildDateMatchCondition = (expression, operator, value, valueTo, timezone) => {
  const resolved = dateRangeForRule({ operator, value, valueTo, timezone })
  if (!resolved) return null

  const emptyExpression = `NULLIF(TRIM(CAST(${expression} AS TEXT)), '')`
  if (resolved.mode === 'empty') return { condition: `${emptyExpression} IS NULL`, params: [] }
  if (resolved.mode === 'not_empty') return { condition: `${emptyExpression} IS NOT NULL`, params: [] }
  if (resolved.mode === 'before') return { condition: `${expression} < ?`, params: resolved.params }
  if (resolved.mode === 'after') return { condition: `${expression} > ?`, params: resolved.params }
  if (resolved.mode === 'after_or_equal') return { condition: `${expression} >= ?`, params: resolved.params }
  if (resolved.mode === 'between') return { condition: `${expression} BETWEEN ? AND ?`, params: resolved.params }
  return null
}

const buildBooleanCondition = (baseCondition, operator, value) => {
  const descriptor = typeof baseCondition === 'string'
    ? { condition: baseCondition, params: [] }
    : { condition: baseCondition?.condition || '', params: baseCondition?.params || [] }
  if (!descriptor.condition) return null

  const wantsTrue = operator === 'yes' || value === true || value === 'true' || value === 'yes'
  return {
    condition: wantsTrue ? `(${descriptor.condition})` : `(NOT (${descriptor.condition}))`,
    params: descriptor.params
  }
}

const buildExistsCondition = ({ table, alias, contactAlias, rowCondition, rowParams = [] }) => ({
  condition: `EXISTS (
    SELECT 1
    FROM ${table} ${alias}
    WHERE ${alias}.contact_id = ${contactAlias}.id
      AND ${rowCondition}
  )`,
  params: rowParams
})

const paymentNumberExpression = (field, contactAlias = 'c') => {
  if (field === 'payments_count') {
    return `(SELECT COUNT(*) FROM payments p_num WHERE p_num.contact_id = ${contactAlias}.id AND ${paymentLivePredicate('p_num')})`
  }
  if (field === 'successful_payments_count') {
    return `(SELECT COUNT(*) FROM payments p_num WHERE p_num.contact_id = ${contactAlias}.id AND ${paymentCustomerPredicate('p_num')})`
  }
  if (field === 'failed_payments_count') {
    return `(SELECT COUNT(*) FROM payments p_num WHERE p_num.contact_id = ${contactAlias}.id AND ${paymentFailedPredicate('p_num')})`
  }
  if (field === 'total_paid') {
    return `(SELECT COALESCE(SUM(p_num.amount), 0) FROM payments p_num WHERE p_num.contact_id = ${contactAlias}.id AND ${paymentSuccessPredicate('p_num')})`
  }
  if (field === 'average_payment_amount') {
    return `(SELECT COALESCE(AVG(p_num.amount), 0) FROM payments p_num WHERE p_num.contact_id = ${contactAlias}.id AND ${paymentSuccessPredicate('p_num')})`
  }
  return ''
}

const appointmentNumberExpression = (field, contactAlias = 'c') => {
  if (field === 'appointments_count') return appointmentCountExpression(contactAlias)
  if (field === 'active_appointments_count') return appointmentCountExpression(contactAlias, CONTACT_LIST_ACTIVE_APPOINTMENT_CONDITION)
  if (field === 'attended_appointments_count') return appointmentCountExpression(contactAlias, CONTACT_LIST_ATTENDED_APPOINTMENT_CONDITION)
  if (field === 'future_appointments_count') return appointmentCountExpression(contactAlias, futureAppointmentCondition('a_count'))
  if (field === 'past_appointments_count') return appointmentCountExpression(contactAlias, pastAppointmentCondition('a_count'))
  if (field === 'cancelled_appointments_count') return appointmentCountExpression(contactAlias, appointmentCancelledOnlyCondition('a_count'))
  if (field === 'no_show_appointments_count') return appointmentCountExpression(contactAlias, appointmentNoShowCondition('a_count'))
  return ''
}

const buildTagCondition = (rule, contactAlias = 'c') => {
  const operator = rule.operator
  const values = uniqueCleanStrings(rule.value, 160)
  const tagExpression = isPostgresDatabase
    ? `LOWER(COALESCE(${contactAlias}.tags::text, ''))`
    : `LOWER(COALESCE(${contactAlias}.tags, ''))`
  const notEmptyCondition = `${tagExpression} NOT IN ('', '[]', 'null')`

  if (operator === 'empty') return { condition: `(${tagExpression} IN ('', '[]', 'null') OR ${contactAlias}.tags IS NULL)`, params: [] }
  if (operator === 'not_empty') return { condition: notEmptyCondition, params: [] }
  if (!values.length) return null

  const valueClauses = values.map(() => `${tagExpression} LIKE ?`)
  const params = values.map(value => `%${lowerValue(value)}%`)

  if (operator === 'all') return { condition: `(${valueClauses.join(' AND ')})`, params }
  if (operator === 'none') return { condition: `(NOT (${valueClauses.join(' OR ')}))`, params }
  return { condition: `(${valueClauses.join(' OR ')})`, params }
}

const customFieldRowsExpression = (contactAlias = 'c') => {
  if (isPostgresDatabase) {
    return {
      from: `jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(COALESCE(${contactAlias}.custom_fields, '[]'::jsonb)) = 'array'
          THEN COALESCE(${contactAlias}.custom_fields, '[]'::jsonb)
          ELSE '[]'::jsonb
        END
      ) AS cf`,
      keyExpression: `LOWER(COALESCE(cf->>'key', cf->>'fieldKey', cf->>'definitionId', cf->>'id', cf->>'label', cf->>'name', ''))`,
      valueExpression: `COALESCE(cf->>'value', '')`
    }
  }

  return {
    from: `json_each(COALESCE(NULLIF(${contactAlias}.custom_fields, ''), '[]')) AS cf`,
    keyExpression: `LOWER(COALESCE(
      json_extract(cf.value, '$.key'),
      json_extract(cf.value, '$.fieldKey'),
      json_extract(cf.value, '$.definitionId'),
      json_extract(cf.value, '$.id'),
      json_extract(cf.value, '$.label'),
      json_extract(cf.value, '$.name'),
      ''
    ))`,
    valueExpression: `COALESCE(json_extract(cf.value, '$.value'), '')`
  }
}

const customFieldKeyVariants = (key) => uniqueCleanStrings([
  key,
  String(key || '').replace(/^custom:/, '')
], 180).map(lowerValue)

const customFieldNumberExpression = (valueExpression) => {
  if (isPostgresDatabase) {
    return `CASE
      WHEN TRIM(CAST(${valueExpression} AS TEXT)) ~ '^-?[0-9]+(\\.[0-9]+)?$'
      THEN CAST(${valueExpression} AS NUMERIC)
      ELSE NULL
    END`
  }

  return `CAST(NULLIF(TRIM(CAST(${valueExpression} AS TEXT)), '') AS REAL)`
}

const customFieldDateTextExpression = (valueExpression) => (
  isPostgresDatabase
    ? `LEFT(TRIM(CAST(${valueExpression} AS TEXT)), 10)`
    : `substr(TRIM(CAST(${valueExpression} AS TEXT)), 1, 10)`
)

const buildCustomFieldDateMatchCondition = (valueExpression, rule) => {
  const dateExpression = customFieldDateTextExpression(valueExpression)
  const emptyExpression = `NULLIF(${dateExpression}, '')`
  const operator = rule.operator

  if (operator === 'empty') return { condition: `${emptyExpression} IS NULL`, params: [] }
  if (operator === 'not_empty') return { condition: `${emptyExpression} IS NOT NULL`, params: [] }

  if (operator === 'last_days' || operator === 'older_days') {
    const days = Math.max(0, Number.parseInt(cleanString(rule.value, 40), 10) || 0)
    if (!days) return null
    const threshold = DateTime.now()
      .setZone(rule.timezone || 'UTC')
      .minus({ days })
      .toISODate()
    return {
      condition: operator === 'last_days' ? `${dateExpression} >= ?` : `${dateExpression} < ?`,
      params: [threshold]
    }
  }

  const left = cleanString(rule.value, 40).slice(0, 10)
  if (!left) return null

  if (operator === 'between') {
    const right = cleanString(rule.valueTo, 40).slice(0, 10)
    if (!right) return null
    return {
      condition: `${dateExpression} BETWEEN ? AND ?`,
      params: [left <= right ? left : right, left <= right ? right : left]
    }
  }

  if (operator === 'before') return { condition: `${dateExpression} < ?`, params: [left] }
  if (operator === 'after') return { condition: `${dateExpression} > ?`, params: [left] }
  return { condition: `${dateExpression} = ?`, params: [left] }
}

const customFieldTruthyCondition = (valueExpression) => (
  `LOWER(TRIM(CAST(${valueExpression} AS TEXT))) IN ('true', '1', 'yes', 'si', 'sí', 'on', 'checked')`
)

const buildCustomFieldCondition = (rule, contactAlias = 'c') => {
  const keyValues = customFieldKeyVariants(rule.customKey || rule.value)
  if (!keyValues.length) return null

  const rows = customFieldRowsExpression(contactAlias)
  const operator = rule.operator
  const valueType = lowerValue(rule.valueType)
  const hasMatchingField = `${rows.keyExpression} IN (${placeholderList(keyValues)})`

  if (operator === 'empty') {
    return {
      condition: `NOT EXISTS (
        SELECT 1
        FROM ${rows.from}
        WHERE ${hasMatchingField}
          AND NULLIF(TRIM(CAST(${rows.valueExpression} AS TEXT)), '') IS NOT NULL
      )`,
      params: keyValues
    }
  }

  if (operator === 'not_empty') {
    return {
      condition: `EXISTS (
        SELECT 1
        FROM ${rows.from}
        WHERE ${hasMatchingField}
          AND NULLIF(TRIM(CAST(${rows.valueExpression} AS TEXT)), '') IS NOT NULL
      )`,
      params: keyValues
    }
  }

  if (valueType === 'number') {
    const valueCondition = buildNumberMatchCondition(customFieldNumberExpression(rows.valueExpression), operator, rule.value, rule.valueTo)
    if (!valueCondition) return null
    return {
      condition: `EXISTS (
        SELECT 1
        FROM ${rows.from}
        WHERE ${hasMatchingField}
          AND ${valueCondition.condition}
      )`,
      params: [...keyValues, ...valueCondition.params]
    }
  }

  if (valueType === 'date') {
    const valueCondition = buildCustomFieldDateMatchCondition(rows.valueExpression, rule)
    if (!valueCondition) return null
    return {
      condition: `EXISTS (
        SELECT 1
        FROM ${rows.from}
        WHERE ${hasMatchingField}
          AND ${valueCondition.condition}
      )`,
      params: [...keyValues, ...valueCondition.params]
    }
  }

  if (valueType === 'boolean') {
    const truthyCondition = `EXISTS (
      SELECT 1
      FROM ${rows.from}
      WHERE ${hasMatchingField}
        AND ${customFieldTruthyCondition(rows.valueExpression)}
    )`
    return buildBooleanCondition({ condition: truthyCondition, params: keyValues }, operator, rule.value)
  }

  const valueCondition = buildTextMatchCondition(`CAST(${rows.valueExpression} AS TEXT)`, operator, rule.value)
  if (!valueCondition) return null

  return {
    condition: `EXISTS (
      SELECT 1
      FROM ${rows.from}
      WHERE ${hasMatchingField}
        AND ${valueCondition.condition}
    )`,
    params: [...keyValues, ...valueCondition.params]
  }
}

const buildSessionFieldTextCondition = (rule, contactAlias = 'c') => {
  const sessionAlias = 's_adv'
  const fields = {
    landing_page: `${sessionAlias}.page_url`,
    page_url: `${sessionAlias}.page_url`,
    referrer_url: `${sessionAlias}.referrer_url`,
    event_name: `${sessionAlias}.event_name`,
    utm_source: `${sessionAlias}.utm_source`,
    utm_medium: `COALESCE(${sessionAlias}.utm_medium, ${sessionAlias}.adset_name, '')`,
    utm_campaign: `COALESCE(${sessionAlias}.utm_campaign, ${sessionAlias}.campaign_name, '')`,
    utm_content: `COALESCE(${sessionAlias}.utm_content, ${sessionAlias}.ad_name, '')`,
    utm_term: `${sessionAlias}.utm_term`,
    gclid: `${sessionAlias}.gclid`,
    fbclid: `${sessionAlias}.fbclid`,
    msclkid: `${sessionAlias}.msclkid`,
    ttclid: `${sessionAlias}.ttclid`,
    wbraid: `${sessionAlias}.wbraid`,
    gbraid: `${sessionAlias}.gbraid`,
    channel: `${sessionAlias}.channel`,
    source_platform: `${sessionAlias}.source_platform`,
    site_source_name: `${sessionAlias}.site_source_name`,
    campaign_id: `${sessionAlias}.campaign_id`,
    campaign_name: `COALESCE(${sessionAlias}.campaign_name, ${sessionAlias}.utm_campaign, '')`,
    adset_id: `${sessionAlias}.adset_id`,
    adset_name: `COALESCE(${sessionAlias}.adset_name, ${sessionAlias}.utm_medium, '')`,
    ad_name: `COALESCE(${sessionAlias}.ad_name, ${sessionAlias}.utm_content, '')`,
    ad_id: `${sessionAlias}.ad_id`,
    creative_id: `${sessionAlias}.creative_id`,
    ad_position: `${sessionAlias}.ad_position`,
    network: `${sessionAlias}.network`,
    match_type: `${sessionAlias}.match_type`,
    keyword: `${sessionAlias}.keyword`,
    search_query: `${sessionAlias}.search_query`,
    device_type: `${sessionAlias}.device_type`,
    browser: `${sessionAlias}.browser`,
    os: `${sessionAlias}.os`,
    placement: `${sessionAlias}.placement`,
    tracking_source: `${sessionAlias}.tracking_source`,
    site_id: `${sessionAlias}.site_id`,
    site_name: `${sessionAlias}.site_name`,
    site_type: `${sessionAlias}.site_type`,
    form_site_id: `${sessionAlias}.form_site_id`,
    form_site_name: `${sessionAlias}.form_site_name`,
    conversion_type: `${sessionAlias}.conversion_type`,
    geo_city: `${sessionAlias}.geo_city`,
    geo_region: `${sessionAlias}.geo_region`,
    geo_country: `${sessionAlias}.geo_country`
  }

  const expression = fields[rule.field]
  if (!expression) return null

  const valueCondition = buildTextMatchCondition(expression, rule.operator, rule.value)
  if (!valueCondition) return null

  return {
    condition: `EXISTS (
      SELECT 1
      FROM sessions ${sessionAlias}
      WHERE ${sessionContactMatchCondition(sessionAlias, contactAlias)}
        AND ${valueCondition.condition}
    )`,
    params: valueCondition.params
  }
}

const buildSessionDateCondition = (rule, contactAlias = 'c') => {
  const sessionAlias = 's_date'
  const fields = {
    session_started_at: `${sessionAlias}.started_at`,
    session_created_at: `${sessionAlias}.created_at`
  }
  const expression = fields[rule.field]
  if (!expression) return null

  const dateCondition = buildDateMatchCondition(expression, rule.operator, rule.value, rule.valueTo, rule.timezone)
  if (!dateCondition) return null

  return {
    condition: `EXISTS (
      SELECT 1
      FROM sessions ${sessionAlias}
      WHERE ${sessionContactMatchCondition(sessionAlias, contactAlias)}
        AND ${dateCondition.condition}
    )`,
    params: dateCondition.params
  }
}

const buildMetaAdFieldCondition = (rule, contactAlias = 'c') => {
  const alias = 'ma_adv'
  const fields = {
    campaign_name: `${alias}.campaign_name`,
    campaign_id: `${alias}.campaign_id`,
    adset_name: `${alias}.adset_name`,
    adset_id: `${alias}.adset_id`,
    ad_name: `${alias}.ad_name`,
    ad_id: `${alias}.ad_id`,
    attribution_ad_name: `${alias}.ad_name`,
    attribution_ad_id: `${alias}.ad_id`,
    creative_id: `${alias}.creative_id`,
    creative_type: `${alias}.creative_type`
  }
  const expression = fields[rule.field]
  if (!expression) return null

  const textCondition = buildTextMatchCondition(expression, rule.operator, rule.value)
  if (!textCondition) return null

  return {
    condition: `EXISTS (
      SELECT 1
      FROM meta_ads ${alias}
      WHERE NULLIF(${contactAlias}.attribution_ad_id, '') IS NOT NULL
        AND ${alias}.ad_id = ${contactAlias}.attribution_ad_id
        AND ${textCondition.condition}
    )`,
    params: textCondition.params
  }
}

const buildTrackingValueMatch = (field, value, sessionAlias = 's_filter') => {
  const clean = cleanString(value)
  if (!clean) return null
  const normalized = lowerValue(clean)

  if (field === 'landing_url' || field === 'page_url') {
    const folded = textFoldExpression(`${sessionAlias}.page_url`)
    return {
      condition: `(${folded} LIKE ? OR ${folded} LIKE ? OR ${folded} LIKE ?)`,
      params: [`%/${normalized}`, `%/${normalized}?%`, `%${normalized}%`]
    }
  }

  if (field === 'utm_source') {
    const variants = sourceVariantsForLabel(clean)
    const expressions = [
      `${sessionAlias}.referrer_url`,
      `${sessionAlias}.site_source_name`,
      `${sessionAlias}.utm_source`,
      `${sessionAlias}.source_platform`
    ]
    const clauses = []
    const params = []
    expressions.forEach((expression) => {
      const folded = textFoldExpression(expression)
      variants.forEach((variant) => {
        clauses.push(`${folded} LIKE ?`)
        params.push(`%${variant}%`)
      })
    })
    return { condition: `(${clauses.join(' OR ')})`, params }
  }

  const decodedValue = normalized
  const encodedValue = encodeURIComponent(clean).toLowerCase()
  const plusValue = encodedValue.replace(/%20/g, '+')
  const variants = uniqueCleanStrings([decodedValue, encodedValue, plusValue], 500).map(lowerValue)
  const expressionByField = {
    utm_campaign: `COALESCE(${sessionAlias}.utm_campaign, ${sessionAlias}.campaign_name, '')`,
    utm_medium: `COALESCE(${sessionAlias}.utm_medium, ${sessionAlias}.adset_name, '')`,
    utm_content: `COALESCE(${sessionAlias}.utm_content, ${sessionAlias}.ad_name, '')`,
    ad_id: `${sessionAlias}.ad_id`,
    device_type: `${sessionAlias}.device_type`,
    browser: `${sessionAlias}.browser`,
    os: `${sessionAlias}.os`,
    placement: `${sessionAlias}.placement`
  }
  const expression = expressionByField[field]
  if (!expression) return null

  const folded = textFoldExpression(expression)
  const clauses = variants.map(() => `${folded} LIKE ?`)
  return { condition: `(${clauses.join(' OR ')})`, params: variants.map(variant => `%${variant}%`) }
}

const buildTrackingFiltersCondition = (trackingFilters = {}, contactAlias = 'c') => {
  const fieldClauses = []
  const params = []

  Object.entries(trackingFilters).forEach(([field, values]) => {
    const valueMatches = uniqueCleanStrings(values).map(value => buildTrackingValueMatch(field, value)).filter(Boolean)
    if (!valueMatches.length) return

    const fieldCondition = `EXISTS (
      SELECT 1
      FROM sessions s_filter
      WHERE ${sessionContactMatchCondition('s_filter', contactAlias)}
        AND (${valueMatches.map(match => match.condition).join(' OR ')})
    )`

    fieldClauses.push(fieldCondition)
    valueMatches.forEach(match => params.push(...match.params))
  })

  if (!fieldClauses.length) return null
  return { condition: `(${fieldClauses.join(' AND ')})`, params }
}

const buildPaymentExistsRule = (rule, contactAlias = 'c') => {
  const alias = 'p_adv'
  const textFields = {
    payment_id: `${alias}.id`,
    public_payment_id: `${alias}.public_payment_id`,
    payment_title: `${alias}.title`,
    payment_description: `${alias}.description`,
    payment_reference: `${alias}.reference`,
    payment_status: `${alias}.status`,
    payment_provider: `${alias}.payment_provider`,
    payment_mode: `${alias}.payment_mode`,
    payment_method: `${alias}.payment_method`,
    payment_currency: `${alias}.currency`
  }

  if (textFields[rule.field]) {
    const textCondition = buildTextMatchCondition(textFields[rule.field], rule.operator, rule.value)
    if (!textCondition) return null
    const basePaymentCondition = rule.field === 'payment_mode'
      ? `${alias}.amount > 0`
      : paymentLivePredicate(alias)
    return buildExistsCondition({
      table: 'payments',
      alias,
      contactAlias,
      rowCondition: `${basePaymentCondition} AND ${textCondition.condition}`,
      rowParams: textCondition.params
    })
  }

  if (rule.field === 'payment_amount') {
    const numberCondition = buildNumberMatchCondition(`${alias}.amount`, rule.operator, rule.value, rule.valueTo)
    if (!numberCondition) return null
    return buildExistsCondition({
      table: 'payments',
      alias,
      contactAlias,
      rowCondition: `${nonTestPaymentCondition(alias)} AND ${numberCondition.condition}`,
      rowParams: numberCondition.params
    })
  }

  const dateFields = {
    payment_date: `COALESCE(${alias}.paid_at, ${alias}.date, ${alias}.created_at)`,
    payment_created_at: `${alias}.created_at`
  }

  if (dateFields[rule.field]) {
    const dateCondition = buildDateMatchCondition(dateFields[rule.field], rule.operator, rule.value, rule.valueTo, rule.timezone)
    if (!dateCondition) return null
    return buildExistsCondition({
      table: 'payments',
      alias,
      contactAlias,
      rowCondition: `${paymentLivePredicate(alias)} AND ${dateCondition.condition}`,
      rowParams: dateCondition.params
    })
  }

  return null
}

const buildAppointmentExistsRule = (rule, contactAlias = 'c') => {
  const alias = 'a_adv'
  const textFields = {
    appointment_id: `${alias}.id`,
    appointment_status: `COALESCE(${alias}.appointment_status, ${alias}.status, '')`,
    appointment_title: `${alias}.title`,
    appointment_notes: `${alias}.notes`,
    appointment_address: `${alias}.address`,
    appointment_google_event_id: `${alias}.google_event_id`,
    appointment_google_sync_status: `${alias}.google_sync_status`
  }

  if (rule.field === 'appointment_calendar' || rule.field === 'appointment_assigned_user') {
    const joins = rule.field === 'appointment_calendar'
      ? `LEFT JOIN calendars cal_adv ON cal_adv.id = ${alias}.calendar_id OR cal_adv.ghl_calendar_id = ${alias}.calendar_id`
      : `LEFT JOIN users u_adv ON CAST(u_adv.id AS TEXT) = CAST(${alias}.assigned_user_id AS TEXT)`
    const expressions = rule.field === 'appointment_calendar'
      ? [
          `${alias}.calendar_id`,
          `CAST(cal_adv.id AS TEXT)`,
          'cal_adv.ghl_calendar_id',
          'cal_adv.name',
          'cal_adv.slug'
        ]
      : [
          `CAST(${alias}.assigned_user_id AS TEXT)`,
          `CAST(u_adv.id AS TEXT)`,
          'u_adv.full_name',
          'u_adv.username',
          'u_adv.email'
        ]
    const textCondition = buildAnyTextMatchCondition(expressions, rule.operator, rule.value)
    if (!textCondition) return null
    return {
      condition: `EXISTS (
        SELECT 1
        FROM appointments ${alias}
        ${joins}
        WHERE ${alias}.contact_id = ${contactAlias}.id
          AND ${textCondition.condition}
      )`,
      params: textCondition.params
    }
  }

  if (textFields[rule.field]) {
    const textCondition = buildTextMatchCondition(textFields[rule.field], rule.operator, rule.value)
    if (!textCondition) return null
    return {
      condition: `EXISTS (
        SELECT 1
        FROM appointments ${alias}
        WHERE ${alias}.contact_id = ${contactAlias}.id
          AND ${textCondition.condition}
      )`,
      params: textCondition.params
    }
  }

  const dateFields = {
    appointment_date: appointmentDateExpression(alias),
    active_appointment_date: appointmentDateExpression(alias),
    appointment_end_date: `${alias}.end_time`,
    appointment_created_at: `COALESCE(${alias}.date_added, ${alias}.created_at)`,
    appointment_updated_at: `COALESCE(${alias}.date_updated, ${alias}.created_at)`,
    appointment_confirmation_until: `${alias}.confirmation_badge_until`
  }

  if (dateFields[rule.field]) {
    const dateCondition = buildDateMatchCondition(dateFields[rule.field], rule.operator, rule.value, rule.valueTo, rule.timezone)
    if (!dateCondition) return null
    const rowCondition = rule.field === 'active_appointment_date'
      ? `${appointmentActiveCondition(alias)} AND ${dateCondition.condition}`
      : dateCondition.condition
    return buildExistsCondition({
      table: 'appointments',
      alias,
      contactAlias,
      rowCondition,
      rowParams: dateCondition.params
    })
  }

  return null
}

const buildPaymentPlanExistsRule = (rule, contactAlias = 'c') => {
  const planAlias = 'pp_adv'
  const flowAlias = 'pf_adv'
  const installmentAlias = 'ip_adv'

  const planTextFields = {
    payment_plan_id: `COALESCE(${planAlias}.id, ${planAlias}.ghl_schedule_id, ${planAlias}.name, ${planAlias}.title, '')`,
    payment_plan_status: `${planAlias}.status`
  }
  if (planTextFields[rule.field]) {
    const textCondition = buildTextMatchCondition(planTextFields[rule.field], rule.operator, rule.value)
    if (!textCondition) return null
    return buildExistsCondition({
      table: 'payment_plans',
      alias: planAlias,
      contactAlias,
      rowCondition: textCondition.condition,
      rowParams: textCondition.params
    })
  }

  const flowTextFields = {
    payment_flow_state: `${flowAlias}.current_state`,
    payment_flow_provider: `${flowAlias}.payment_provider`
  }
  if (flowTextFields[rule.field]) {
    const textCondition = buildTextMatchCondition(flowTextFields[rule.field], rule.operator, rule.value)
    if (!textCondition) return null
    return buildExistsCondition({
      table: 'payment_flows',
      alias: flowAlias,
      contactAlias,
      rowCondition: textCondition.condition,
      rowParams: textCondition.params
    })
  }

  if (rule.field === 'payment_flow_total') {
    const numberCondition = buildNumberMatchCondition(`${flowAlias}.total_amount`, rule.operator, rule.value, rule.valueTo)
    if (!numberCondition) return null
    return buildExistsCondition({
      table: 'payment_flows',
      alias: flowAlias,
      contactAlias,
      rowCondition: numberCondition.condition,
      rowParams: numberCondition.params
    })
  }

  if (rule.field === 'payment_flow_created_at') {
    const dateCondition = buildDateMatchCondition(`${flowAlias}.created_at`, rule.operator, rule.value, rule.valueTo, rule.timezone)
    if (!dateCondition) return null
    return buildExistsCondition({
      table: 'payment_flows',
      alias: flowAlias,
      contactAlias,
      rowCondition: dateCondition.condition,
      rowParams: dateCondition.params
    })
  }

  const installmentTextFields = {
    installment_status: `${installmentAlias}.status`,
    installment_method: `${installmentAlias}.payment_method`
  }
  if (installmentTextFields[rule.field]) {
    const textCondition = buildTextMatchCondition(installmentTextFields[rule.field], rule.operator, rule.value)
    if (!textCondition) return null
    return {
      condition: `EXISTS (
        SELECT 1
        FROM payment_flows ${flowAlias}
        JOIN installment_payments ${installmentAlias} ON ${installmentAlias}.flow_id = ${flowAlias}.id
        WHERE ${flowAlias}.contact_id = ${contactAlias}.id
          AND ${textCondition.condition}
      )`,
      params: textCondition.params
    }
  }

  if (rule.field === 'installment_due_date') {
    const dateCondition = buildDateMatchCondition(`${installmentAlias}.due_date`, rule.operator, rule.value, rule.valueTo, rule.timezone)
    if (!dateCondition) return null
    return {
      condition: `EXISTS (
        SELECT 1
        FROM payment_flows ${flowAlias}
        JOIN installment_payments ${installmentAlias} ON ${installmentAlias}.flow_id = ${flowAlias}.id
        WHERE ${flowAlias}.contact_id = ${contactAlias}.id
          AND ${dateCondition.condition}
      )`,
      params: dateCondition.params
    }
  }

  if (rule.field === 'installment_amount') {
    const numberCondition = buildNumberMatchCondition(`${installmentAlias}.amount`, rule.operator, rule.value, rule.valueTo)
    if (!numberCondition) return null
    return {
      condition: `EXISTS (
        SELECT 1
        FROM payment_flows ${flowAlias}
        JOIN installment_payments ${installmentAlias} ON ${installmentAlias}.flow_id = ${flowAlias}.id
        WHERE ${flowAlias}.contact_id = ${contactAlias}.id
          AND ${numberCondition.condition}
      )`,
      params: numberCondition.params
    }
  }

  return null
}

const buildAutomationExistsRule = (rule, contactAlias = 'c') => {
  const enrollmentAlias = 'ae_adv'
  const automationAlias = 'aut_adv'
  const textFields = {
    automation_id: `COALESCE(${enrollmentAlias}.automation_id, ${automationAlias}.id, '')`,
    automation_name: `${automationAlias}.name`,
    automation_status: `${enrollmentAlias}.status`,
    automation_current_step: `${enrollmentAlias}.current_node_id`,
    automation_wait_kind: `${enrollmentAlias}.wait_kind`
  }

  if (textFields[rule.field]) {
    const textCondition = buildTextMatchCondition(textFields[rule.field], rule.operator, rule.value)
    if (!textCondition) return null
    return {
      condition: `EXISTS (
        SELECT 1
        FROM automation_enrollments ${enrollmentAlias}
        LEFT JOIN automations ${automationAlias} ON ${automationAlias}.id = ${enrollmentAlias}.automation_id
        WHERE ${enrollmentAlias}.contact_id = ${contactAlias}.id
          AND ${textCondition.condition}
      )`,
      params: textCondition.params
    }
  }

  const dateFields = {
    automation_entered_at: `${enrollmentAlias}.entered_at`,
    automation_updated_at: `${enrollmentAlias}.updated_at`,
    automation_resume_at: `${enrollmentAlias}.resume_at`
  }

  if (dateFields[rule.field]) {
    const dateCondition = buildDateMatchCondition(dateFields[rule.field], rule.operator, rule.value, rule.valueTo, rule.timezone)
    if (!dateCondition) return null
    return {
      condition: `EXISTS (
        SELECT 1
        FROM automation_enrollments ${enrollmentAlias}
        WHERE ${enrollmentAlias}.contact_id = ${contactAlias}.id
          AND ${dateCondition.condition}
      )`,
      params: dateCondition.params
    }
  }

  return null
}

const buildAdvancedRuleCondition = (rule, contactAlias = 'c', timezone) => {
  const normalizedRule = { ...rule, timezone }
  const field = normalizedRule.field
  const operator = normalizedRule.operator

  if (field === 'tags') return buildTagCondition(normalizedRule, contactAlias)
  if (field === 'custom_field') return buildCustomFieldCondition(normalizedRule, contactAlias)

  if (field === 'status') {
    return buildTextMatchCondition(contactStageExpression(contactAlias), operator, normalizedRule.value)
  }

  if (field === 'priority') {
    const priorityMap = {
      high: existsCustomerPayment(contactAlias),
      medium: `(${existsAttendanceSignal(contactAlias)} OR ${existsAttendedAppointment(contactAlias)} OR ${existsActiveAppointment(contactAlias)})`,
      low: `(NOT ${existsCustomerPayment(contactAlias)} AND NOT ${existsActiveAppointment(contactAlias)})`
    }
    const selected = lowerValue(normalizedRule.value)
    const condition = priorityMap[selected]
    if (!condition) return null
    return operator === 'is_not'
      ? { condition: `(NOT (${condition}))`, params: [] }
      : { condition: `(${condition})`, params: [] }
  }

  const contactTextExpression = contactTextFieldExpression(field, contactAlias)
  if (contactTextExpression) return buildTextMatchCondition(contactTextExpression, operator, normalizedRule.value)

  const contactDateExpression = contactDateFieldExpression(field, contactAlias)
  if (contactDateExpression) return buildDateMatchCondition(contactDateExpression, operator, normalizedRule.value, normalizedRule.valueTo, timezone)

  const paymentNumber = paymentNumberExpression(field, contactAlias)
  if (paymentNumber) return buildNumberMatchCondition(paymentNumber, operator, normalizedRule.value, normalizedRule.valueTo)

  const appointmentNumber = appointmentNumberExpression(field, contactAlias)
  if (appointmentNumber) return buildNumberMatchCondition(appointmentNumber, operator, normalizedRule.value, normalizedRule.valueTo)

  if (field === 'last_payment_date') {
    return buildDateMatchCondition(
      `(SELECT MAX(COALESCE(p_last.paid_at, p_last.date, p_last.created_at)) FROM payments p_last WHERE p_last.contact_id = ${contactAlias}.id AND ${paymentCustomerPredicate('p_last')})`,
      operator,
      normalizedRule.value,
      normalizedRule.valueTo,
      timezone
    )
  }

  if (field === 'next_appointment_date') {
    return buildDateMatchCondition(
      appointmentDateAggregateExpression('MIN', contactAlias, futureAppointmentCondition('a_date')),
      operator,
      normalizedRule.value,
      normalizedRule.valueTo,
      timezone
    )
  }

  if (field === 'last_appointment_date') {
    return buildDateMatchCondition(
      appointmentDateAggregateExpression('MAX', contactAlias),
      operator,
      normalizedRule.value,
      normalizedRule.valueTo,
      timezone
    )
  }

  const booleanConditions = {
    has_any_appointment: `EXISTS (SELECT 1 FROM appointments a_bool WHERE a_bool.contact_id = ${contactAlias}.id)`,
    has_payments: `EXISTS (SELECT 1 FROM payments p_bool WHERE p_bool.contact_id = ${contactAlias}.id AND ${paymentLivePredicate('p_bool')})`,
    has_successful_payment: existsCustomerPayment(contactAlias),
    has_failed_payment: `EXISTS (SELECT 1 FROM payments p_bool WHERE p_bool.contact_id = ${contactAlias}.id AND ${paymentFailedPredicate('p_bool')})`,
    has_saved_payment_method: `(
      EXISTS (SELECT 1 FROM stripe_payment_methods spm_bool WHERE spm_bool.contact_id = ${contactAlias}.id)
      OR EXISTS (SELECT 1 FROM conekta_payment_sources cps_bool WHERE cps_bool.contact_id = ${contactAlias}.id)
      OR EXISTS (SELECT 1 FROM rebill_payment_sources rps_bool WHERE rps_bool.contact_id = ${contactAlias}.id)
    )`,
    has_active_appointment: existsActiveAppointment(contactAlias),
    has_attended_appointment: `(${existsAttendanceSignal(contactAlias)} OR ${existsAttendedAppointment(contactAlias)})`,
    has_cancelled_appointment: `EXISTS (
      SELECT 1
      FROM appointments a_bool
      WHERE a_bool.contact_id = ${contactAlias}.id
        AND ${appointmentCancelledOnlyCondition('a_bool')}
    )`,
    has_no_show_appointment: `EXISTS (
      SELECT 1
      FROM appointments a_bool
      WHERE a_bool.contact_id = ${contactAlias}.id
        AND ${appointmentNoShowCondition('a_bool')}
    )`,
    has_past_appointment: {
      condition: `EXISTS (
        SELECT 1
        FROM appointments a_bool
        WHERE a_bool.contact_id = ${contactAlias}.id
          AND ${appointmentActiveCondition('a_bool')}
          AND NULLIF(TRIM(CAST(COALESCE(a_bool.start_time, a_bool.date_added) AS TEXT)), '') IS NOT NULL
          AND COALESCE(a_bool.start_time, a_bool.date_added) < ?
      )`,
      params: [DateTime.utc().toISO({ suppressMilliseconds: false })]
    },
    has_future_appointment: {
      condition: `EXISTS (
        SELECT 1
        FROM appointments a_bool
        WHERE a_bool.contact_id = ${contactAlias}.id
          AND ${appointmentActiveCondition('a_bool')}
          AND NULLIF(TRIM(CAST(COALESCE(a_bool.start_time, a_bool.date_added) AS TEXT)), '') IS NOT NULL
          AND COALESCE(a_bool.start_time, a_bool.date_added) >= ?
      )`,
      params: [DateTime.utc().toISO({ suppressMilliseconds: false })]
    },
    has_confirmation_badge: `EXISTS (
      SELECT 1
      FROM appointments a_bool
      WHERE a_bool.contact_id = ${contactAlias}.id
        AND ${isPostgresDatabase
          ? 'a_bool.confirmation_badge_until IS NOT NULL AND a_bool.confirmation_badge_until > CURRENT_TIMESTAMP'
          : `COALESCE(a_bool.confirmation_badge_until, '') != '' AND datetime(a_bool.confirmation_badge_until) > datetime('now')`}
    )`,
    active_automation: `EXISTS (
      SELECT 1
      FROM automation_enrollments ae_bool
      WHERE ae_bool.contact_id = ${contactAlias}.id
        AND ae_bool.status IN ('active', 'waiting', 'paused')
    )`,
    has_payment_plan: `(
      EXISTS (SELECT 1 FROM payment_plans pp_bool WHERE pp_bool.contact_id = ${contactAlias}.id)
      OR EXISTS (SELECT 1 FROM payment_flows pf_bool WHERE pf_bool.contact_id = ${contactAlias}.id)
    )`,
    has_pending_installment: `EXISTS (
      SELECT 1
      FROM payment_flows pf_bool
      JOIN installment_payments ip_bool ON ip_bool.flow_id = pf_bool.id
      WHERE pf_bool.contact_id = ${contactAlias}.id
        AND LOWER(COALESCE(ip_bool.status, '')) IN (${sqlList(PENDING_INSTALLMENT_STATUSES)})
    )`,
    has_overdue_installment: `EXISTS (
      SELECT 1
      FROM payment_flows pf_bool
      JOIN installment_payments ip_bool ON ip_bool.flow_id = pf_bool.id
      WHERE pf_bool.contact_id = ${contactAlias}.id
        AND LOWER(COALESCE(ip_bool.status, '')) IN (${sqlList(OVERDUE_INSTALLMENT_STATUSES)})
        AND NULLIF(TRIM(CAST(ip_bool.due_date AS TEXT)), '') IS NOT NULL
        AND ${timestampCompareExpression('ip_bool.due_date')} < ${currentTimestampExpression()}
    )`
  }

  if (booleanConditions[field]) return buildBooleanCondition(booleanConditions[field], operator, normalizedRule.value)

  const sessionFields = new Set([
    'landing_page',
    'page_url',
    'referrer_url',
    'event_name',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
    'utm_term',
    'gclid',
    'fbclid',
    'msclkid',
    'ttclid',
    'wbraid',
    'gbraid',
    'channel',
    'source_platform',
    'site_source_name',
    'campaign_id',
    'campaign_name',
    'adset_id',
    'adset_name',
    'ad_name',
    'ad_id',
    'creative_id',
    'ad_position',
    'network',
    'match_type',
    'keyword',
    'search_query',
    'device_type',
    'browser',
    'os',
    'placement',
    'tracking_source',
    'site_id',
    'site_name',
    'site_type',
    'form_site_id',
    'form_site_name',
    'conversion_type',
    'geo_city',
    'geo_region',
    'geo_country'
  ])
  const metaAdFields = new Set(['campaign_name', 'campaign_id', 'adset_name', 'adset_id', 'ad_name', 'ad_id', 'creative_id', 'creative_type'])
  if (sessionFields.has(field) || metaAdFields.has(field)) {
    const sessionCondition = sessionFields.has(field) ? buildSessionFieldTextCondition(normalizedRule, contactAlias) : null
    const metaCondition = metaAdFields.has(field) ? buildMetaAdFieldCondition(normalizedRule, contactAlias) : null
    const conditions = [sessionCondition, metaCondition].filter(Boolean)
    if (conditions.length === 1) return conditions[0]
    if (conditions.length > 1) {
      return {
        condition: `(${conditions.map(item => item.condition).join(' OR ')})`,
        params: conditions.flatMap(item => item.params || [])
      }
    }
  }

  const sessionDateCondition = buildSessionDateCondition(normalizedRule, contactAlias)
  if (sessionDateCondition) return sessionDateCondition

  const paymentExists = buildPaymentExistsRule(normalizedRule, contactAlias)
  if (paymentExists) return paymentExists

  const paymentPlanExists = buildPaymentPlanExistsRule(normalizedRule, contactAlias)
  if (paymentPlanExists) return paymentPlanExists

  const appointmentExists = buildAppointmentExistsRule(normalizedRule, contactAlias)
  if (appointmentExists) return appointmentExists

  const automationExists = buildAutomationExistsRule(normalizedRule, contactAlias)
  if (automationExists) return automationExists

  return null
}

const buildAdvancedFiltersCondition = (advancedFilters = {}, contactAlias = 'c', timezone) => {
  const normalized = normalizeContactAdvancedFilters(advancedFilters)
  const groupConditions = []
  const params = []

  normalized.groups.forEach((group) => {
    const ruleConditions = []
    group.rules.forEach((rule) => {
      const built = buildAdvancedRuleCondition(rule, contactAlias, timezone)
      if (!built?.condition) return
      ruleConditions.push(built.condition)
      params.push(...(built.params || []))
    })

    if (!ruleConditions.length) return
    const joiner = group.mode === 'any' ? ' OR ' : ' AND '
    const groupCondition = `(${ruleConditions.join(joiner)})`
    groupConditions.push(group.negate ? `(NOT ${groupCondition})` : groupCondition)
  })

  if (!groupConditions.length) return null
  const groupJoiner = normalized.groupMode === 'any' ? ' OR ' : ' AND '
  return { condition: `(${groupConditions.join(groupJoiner)})`, params }
}

export function buildContactListWhere({
  alias = 'contacts',
  search = '',
  range = {},
  hiddenCondition = '',
  quickFilter = 'all',
  trackingFilters = {},
  advancedFilters = {},
  timezone
} = {}) {
  const conditions = []
  const params = []

  if (search) {
    const searchClause = buildContactSearchClause(alias, search)
    conditions.push(searchClause.condition)
    params.push(...searchClause.params)
  }

  if (range.startUtc) {
    conditions.push(`${alias}.created_at >= ?`)
    params.push(range.startUtc)
  }

  if (range.endUtc) {
    conditions.push(`${alias}.created_at <= ?`)
    params.push(range.endUtc)
  }

  if (hiddenCondition) {
    conditions.push(hiddenCondition)
  }

  conditions.push(`${alias}.deleted_at IS NULL`)

  const quickCondition = buildQuickFilterCondition(quickFilter, alias)
  if (quickCondition) {
    conditions.push(quickCondition)
  }

  const trackingCondition = buildTrackingFiltersCondition(normalizeContactListTrackingFilters(trackingFilters), alias)
  if (trackingCondition) {
    conditions.push(trackingCondition.condition)
    params.push(...trackingCondition.params)
  }

  const advancedCondition = buildAdvancedFiltersCondition(normalizeContactAdvancedFilters(advancedFilters), alias, timezone || range.appliedTimezone)
  if (advancedCondition) {
    conditions.push(advancedCondition.condition)
    params.push(...advancedCondition.params)
  }

  return {
    conditions,
    params,
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  }
}

export function getContactAdvancedSort(advancedFilters = {}) {
  const normalized = normalizeContactAdvancedFilters(advancedFilters)
  if (!normalized.sort?.by) return null
  return normalized.sort
}

export const CONTACT_LIST_PAYMENT_STATUS_OPTIONS = PAYMENT_STATUS_OPTIONS
