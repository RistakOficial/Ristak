import { nonTestPaymentCondition, SUCCESS_PAYMENT_STATUSES } from '../utils/paymentMode.js'
import { buildContactSearchClause, containsPattern, normalizePhoneDigits } from '../utils/searchText.js'

export const TRANSACTION_LIST_DEFAULT_LIMIT = 50
export const TRANSACTION_LIST_MAX_LIMIT = 5000

const SUCCESS_STATUS_SET = new Set(SUCCESS_PAYMENT_STATUSES)
const CLOSED_VISIBLE_STATUSES = [
  'paid',
  'succeeded',
  'completed',
  'complete',
  'fulfilled',
  'success',
  'refunded',
  'void',
  'deleted'
]
const SUCCESS_STATUS_SQL_LIST = SUCCESS_PAYMENT_STATUSES
  .map(status => `'${String(status).replace(/'/g, "''")}'`)
  .join(', ')

const normalizeListValue = (value) => String(value || '').trim().toLowerCase()

export function normalizeTransactionStatus(status) {
  const normalized = normalizeListValue(status)
  if (!normalized) return ''
  return SUCCESS_STATUS_SET.has(normalized) ? 'paid' : normalized
}

export function normalizeTransactionStatusFilters(value) {
  const values = Array.isArray(value)
    ? value.flatMap(item => String(item || '').split(','))
    : String(value || '').split(',')

  return Array.from(new Set(
    values
      .map(normalizeTransactionStatus)
      .filter(Boolean)
  ))
}

export function normalizeTransactionPagination({
  page = 1,
  limit,
  defaultLimit = TRANSACTION_LIST_DEFAULT_LIMIT,
  maxLimit = TRANSACTION_LIST_MAX_LIMIT
} = {}) {
  const parsedLimit = Number(limit)
  const limitNumber = Math.min(
    Math.max(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : defaultLimit, 1),
    maxLimit
  )
  const parsedPage = Number(page)
  const pageNumber = Math.max(Number.isFinite(parsedPage) && parsedPage > 0 ? Math.floor(parsedPage) : 1, 1)

  return {
    pageNumber,
    limitNumber,
    offset: Math.max((pageNumber - 1) * limitNumber, 0)
  }
}

export function buildTransactionStatusGroupExpression(alias = 'p') {
  return `CASE
    WHEN LOWER(COALESCE(${alias}.status, '')) IN (${SUCCESS_STATUS_SQL_LIST}) THEN 'paid'
    ELSE LOWER(COALESCE(${alias}.status, ''))
  END`
}

export function buildTransactionStatusCondition(statuses = [], alias = 'p') {
  const selectedStatuses = normalizeTransactionStatusFilters(statuses)
  if (!selectedStatuses.length) {
    return null
  }

  const clauses = []
  const params = []

  if (selectedStatuses.includes('paid')) {
    clauses.push(`LOWER(${alias}.status) IN (${SUCCESS_PAYMENT_STATUSES.map(() => '?').join(', ')})`)
    params.push(...SUCCESS_PAYMENT_STATUSES)
  }

  const directStatuses = selectedStatuses.filter(status => status !== 'paid')
  if (directStatuses.length) {
    clauses.push(`LOWER(${alias}.status) IN (${directStatuses.map(() => '?').join(', ')})`)
    params.push(...directStatuses)
  }

  return clauses.length
    ? { condition: `(${clauses.join(' OR ')})`, params }
    : null
}

function buildPaymentListExclusionConditions(alias = 'p') {
  const finalStatuses = CLOSED_VISIBLE_STATUSES
    .map(status => `'${status}'`)
    .join(', ')

  return [
    `NOT EXISTS (
      SELECT 1
      FROM installment_payments ip
      WHERE ip.payment_id = ${alias}.id
        AND LOWER(COALESCE(${alias}.status, 'pending')) NOT IN (${finalStatuses})
    )`,
    `NOT EXISTS (
      SELECT 1
      FROM payment_flows pf
      WHERE pf.first_payment_invoice_id = ${alias}.id
        AND pf.payment_provider = 'stripe'
        AND COALESCE(${alias}.public_payment_id, '') = ''
        AND COALESCE(${alias}.payment_url, '') = ''
        AND LOWER(COALESCE(${alias}.status, 'pending')) NOT IN (${finalStatuses})
    )`,
    `NOT (
      (COALESCE(${alias}.metadata_json, '') LIKE '%site_checkout%' OR COALESCE(${alias}.metadata_json, '') LIKE '%site_form%')
      AND LOWER(COALESCE(${alias}.status, '')) IN ('sent', 'pending', 'processing', 'requires_action', 'requires_payment_method', 'incomplete', 'draft', 'initiated')
    )`
  ]
}

export function buildTransactionSearchCondition({
  searchTerm = '',
  paymentAlias = 'p',
  contactAlias = 'c'
} = {}) {
  const searchPattern = containsPattern(searchTerm, 500)
  if (!searchPattern) {
    return null
  }

  const searchDigits = normalizePhoneDigits(searchTerm)
  const contactSearch = buildContactSearchClause(contactAlias, searchTerm, { includeSource: true })
  const paymentSearchConditions = [
    `LOWER(COALESCE(${paymentAlias}.reference, '')) LIKE ?`,
    `LOWER(COALESCE(${paymentAlias}.title, '')) LIKE ?`,
    `LOWER(COALESCE(${paymentAlias}.description, '')) LIKE ?`,
    `LOWER(COALESCE(${paymentAlias}.invoice_number, '')) LIKE ?`,
    `LOWER(COALESCE(${paymentAlias}.public_payment_id, '')) LIKE ?`,
    `LOWER(COALESCE(${paymentAlias}.payment_provider, '')) LIKE ?`,
    `LOWER(COALESCE(${paymentAlias}.payment_method, '')) LIKE ?`,
    `LOWER(COALESCE(${paymentAlias}.status, '')) LIKE ?`,
    `COALESCE(${paymentAlias}.id, '') LIKE ?`
  ]
  const paymentSearchParams = [
    searchPattern,
    searchPattern,
    searchPattern,
    searchPattern,
    searchPattern,
    searchPattern,
    searchPattern,
    searchPattern,
    searchPattern
  ]

  if (searchDigits) {
    paymentSearchConditions.push(`REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${paymentAlias}.id, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?`)
    paymentSearchParams.push(`%${searchDigits}%`)
  }

  return {
    condition: `(${contactSearch.condition} OR (${paymentSearchConditions.join(' OR ')}))`,
    params: [
      ...contactSearch.params,
      ...paymentSearchParams
    ]
  }
}

export function buildTransactionListWhere({
  range = {},
  statuses = [],
  search = '',
  hiddenCondition = '',
  extraContactConditions = [],
  includeStatus = true,
  includeListExclusions = true,
  paymentAlias = 'p',
  contactAlias = 'c'
} = {}) {
  const filters = []
  const params = []

  if (includeStatus) {
    const statusCondition = buildTransactionStatusCondition(statuses, paymentAlias)
    if (statusCondition) {
      filters.push(statusCondition.condition)
      params.push(...statusCondition.params)
    }
  }

  if (range.startUtc) {
    filters.push(`${paymentAlias}.date >= ?`)
    params.push(range.startUtc)
  }

  if (range.endUtc) {
    filters.push(`${paymentAlias}.date <= ?`)
    params.push(range.endUtc)
  }

  if (hiddenCondition) {
    filters.push(`(${paymentAlias}.contact_id IS NULL OR ${hiddenCondition})`)
  }

  for (const condition of extraContactConditions) {
    if (condition) {
      filters.push(condition)
    }
  }

  if (includeListExclusions) {
    filters.push(...buildPaymentListExclusionConditions(paymentAlias))
  }

  const searchCondition = buildTransactionSearchCondition({
    searchTerm: search,
    paymentAlias,
    contactAlias
  })

  if (searchCondition) {
    filters.push(searchCondition.condition)
    params.push(...searchCondition.params)
  }

  return {
    filters,
    params,
    whereClause: filters.length ? `WHERE ${filters.join(' AND ')}` : ''
  }
}

export function buildSuccessfulTransactionCondition(alias = 'p') {
  return {
    condition: `LOWER(${alias}.status) IN (${SUCCESS_PAYMENT_STATUSES.map(() => '?').join(', ')})`,
    params: [...SUCCESS_PAYMENT_STATUSES]
  }
}

export function buildRefundedTransactionCondition(alias = 'p') {
  return {
    condition: `LOWER(${alias}.status) = ?`,
    params: ['refunded']
  }
}

export function buildLivePaymentCondition(alias = 'p') {
  return nonTestPaymentCondition(alias)
}
