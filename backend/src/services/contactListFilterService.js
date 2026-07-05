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

const appointmentCountExpression = (contactAlias = 'c', condition = '') => (
  `(SELECT COUNT(*)
    FROM appointments a_count
    WHERE a_count.contact_id = ${contactAlias}.id
      ${condition ? `AND ${condition}` : ''})`
)

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
    attended_appointments_count: appointmentCountExpression(contactAlias, CONTACT_LIST_ATTENDED_APPOINTMENT_CONDITION)
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
              customKey: cleanString(rule?.customKey, 180)
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
  return ''
}

const appointmentNumberExpression = (field, contactAlias = 'c') => {
  if (field === 'appointments_count') return appointmentCountExpression(contactAlias)
  if (field === 'active_appointments_count') return appointmentCountExpression(contactAlias, CONTACT_LIST_ACTIVE_APPOINTMENT_CONDITION)
  if (field === 'attended_appointments_count') return appointmentCountExpression(contactAlias, CONTACT_LIST_ATTENDED_APPOINTMENT_CONDITION)
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

const buildCustomFieldCondition = (rule, contactAlias = 'c') => {
  const keyValues = customFieldKeyVariants(rule.customKey || rule.value)
  if (!keyValues.length) return null

  const rows = customFieldRowsExpression(contactAlias)
  const operator = rule.operator
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
    landing_page: `COALESCE(${sessionAlias}.page_url, ${sessionAlias}.landing_page, '')`,
    page_url: `${sessionAlias}.page_url`,
    referrer_url: `${sessionAlias}.referrer_url`,
    utm_source: `${sessionAlias}.utm_source`,
    utm_medium: `COALESCE(${sessionAlias}.utm_medium, ${sessionAlias}.adset_name, '')`,
    utm_campaign: `COALESCE(${sessionAlias}.utm_campaign, ${sessionAlias}.campaign_name, '')`,
    utm_content: `COALESCE(${sessionAlias}.utm_content, ${sessionAlias}.ad_name, '')`,
    utm_term: `${sessionAlias}.utm_term`,
    source_platform: `${sessionAlias}.source_platform`,
    site_source_name: `${sessionAlias}.site_source_name`,
    campaign_name: `COALESCE(${sessionAlias}.campaign_name, ${sessionAlias}.utm_campaign, '')`,
    adset_name: `COALESCE(${sessionAlias}.adset_name, ${sessionAlias}.utm_medium, '')`,
    ad_name: `COALESCE(${sessionAlias}.ad_name, ${sessionAlias}.utm_content, '')`,
    ad_id: `${sessionAlias}.ad_id`,
    device_type: `${sessionAlias}.device_type`,
    browser: `${sessionAlias}.browser`,
    os: `${sessionAlias}.os`,
    placement: `${sessionAlias}.placement`,
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
    payment_status: `${alias}.status`,
    payment_provider: `${alias}.payment_provider`,
    payment_mode: `${alias}.payment_mode`,
    payment_method: `${alias}.payment_method`
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

  if (rule.field === 'payment_date') {
    const dateCondition = buildDateMatchCondition(`COALESCE(${alias}.paid_at, ${alias}.date, ${alias}.created_at)`, rule.operator, rule.value, rule.valueTo, rule.timezone)
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
    appointment_status: `COALESCE(${alias}.appointment_status, ${alias}.status, '')`,
    appointment_calendar: `${alias}.calendar_id`,
    appointment_assigned_user: `${alias}.assigned_user_id`,
    appointment_title: `${alias}.title`
  }

  if (textFields[rule.field]) {
    const textCondition = buildTextMatchCondition(textFields[rule.field], rule.operator, rule.value)
    if (!textCondition) return null
    return buildExistsCondition({
      table: 'appointments',
      alias,
      contactAlias,
      rowCondition: textCondition.condition,
      rowParams: textCondition.params
    })
  }

  if (rule.field === 'appointment_date') {
    const dateCondition = buildDateMatchCondition(`COALESCE(${alias}.start_time, ${alias}.date_added, ${alias}.created_at)`, rule.operator, rule.value, rule.valueTo, rule.timezone)
    if (!dateCondition) return null
    return buildExistsCondition({
      table: 'appointments',
      alias,
      contactAlias,
      rowCondition: `${CONTACT_LIST_ACTIVE_APPOINTMENT_CONDITION} AND ${dateCondition.condition}`,
      rowParams: dateCondition.params
    })
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

  const booleanConditions = {
    has_payments: `EXISTS (SELECT 1 FROM payments p_bool WHERE p_bool.contact_id = ${contactAlias}.id AND ${paymentLivePredicate('p_bool')})`,
    has_successful_payment: existsCustomerPayment(contactAlias),
    has_failed_payment: `EXISTS (SELECT 1 FROM payments p_bool WHERE p_bool.contact_id = ${contactAlias}.id AND ${paymentFailedPredicate('p_bool')})`,
    has_active_appointment: existsActiveAppointment(contactAlias),
    has_attended_appointment: `(${existsAttendanceSignal(contactAlias)} OR ${existsAttendedAppointment(contactAlias)})`,
    has_past_appointment: {
      condition: `EXISTS (
        SELECT 1
        FROM appointments a_bool
        WHERE a_bool.contact_id = ${contactAlias}.id
          AND ${CONTACT_LIST_ACTIVE_APPOINTMENT_CONDITION}
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
          AND ${CONTACT_LIST_ACTIVE_APPOINTMENT_CONDITION}
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
        AND ae_bool.status IN ('active', 'waiting')
    )`
  }

  if (booleanConditions[field]) return buildBooleanCondition(booleanConditions[field], operator, normalizedRule.value)

  const sessionFields = new Set([
    'landing_page',
    'page_url',
    'referrer_url',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
    'utm_term',
    'source_platform',
    'site_source_name',
    'campaign_name',
    'adset_name',
    'ad_name',
    'ad_id',
    'device_type',
    'browser',
    'os',
    'placement',
    'geo_city',
    'geo_region',
    'geo_country'
  ])
  if (sessionFields.has(field)) return buildSessionFieldTextCondition(normalizedRule, contactAlias)

  const paymentExists = buildPaymentExistsRule(normalizedRule, contactAlias)
  if (paymentExists) return paymentExists

  const appointmentExists = buildAppointmentExistsRule(normalizedRule, contactAlias)
  if (appointmentExists) return appointmentExists

  if (field === 'automation_status') {
    const alias = 'ae_adv'
    const textCondition = buildTextMatchCondition(`${alias}.status`, operator, normalizedRule.value)
    if (!textCondition) return null
    return buildExistsCondition({
      table: 'automation_enrollments',
      alias,
      contactAlias,
      rowCondition: textCondition.condition,
      rowParams: textCondition.params
    })
  }

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
