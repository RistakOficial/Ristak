import { databaseDialect, db } from '../config/database.js'
import { resolveDateRangeWithGHLTimezone } from '../utils/dateUtils.js'
import { buildHiddenContactsCondition, getHiddenContactFilters } from '../utils/hiddenContactsFilter.js'
import {
  hashPaginationCursorScope,
  paginationCursorHiddenFiltersScope,
  paginationCursorListScope,
  paginationCursorRangeScope
} from '../utils/paginationCursorScope.js'
import { buildPaymentDisplay } from '../utils/paymentDisplay.js'
import { serializePaymentAmount } from '../utils/paymentAmountSerialization.js'
import { nonTestPaymentCondition, SUCCESS_PAYMENT_STATUSES } from '../utils/paymentMode.js'
import {
  buildReportTransactionSummaryCacheKey,
  getReportTransactionSummary
} from './reportTransactionSummaryCacheService.js'

const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 100
const isPostgres = databaseDialect === 'postgres'

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

function normalizeLegacyPage(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

function serializeCursorTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  return String(value || '').trim()
}

function transactionCursorSortExpression(alias = 'p') {
  return isPostgres
    ? `COALESCE(${alias}.date, ${alias}.created_at, TIMESTAMP '1970-01-01 00:00:00')`
    : `COALESCE(${alias}.date, ${alias}.created_at, '1970-01-01 00:00:00')`
}

function transactionCursorProjectionExpression(alias = 'p') {
  const sortExpression = transactionCursorSortExpression(alias)
  return isPostgres ? `(${sortExpression})::text` : sortExpression
}

function encodeCursor(row, scope) {
  const occurredAt = serializeCursorTimestamp(row?.cursor_at)
  const id = String(row?.id || '').trim()
  if (!occurredAt || !id) return null
  return Buffer.from(JSON.stringify({ v: 2, kind: 'report-transactions', scope, occurredAt, id }), 'utf8').toString('base64url')
}

function decodeCursor(value, expectedScope) {
  const clean = String(value || '').trim()
  if (!clean) return null
  if (clean.length > 2048) throw requestError('Cursor inválido')

  try {
    const parsed = JSON.parse(Buffer.from(clean, 'base64url').toString('utf8'))
    const isLegacyCursor = parsed?.v === 1 && parsed?.kind === 'report-transactions' && parsed?.scope === undefined
    const isScopedCursor = parsed?.v === 2 && parsed?.kind === 'report-transactions' && typeof parsed?.scope === 'string'
    if (!isLegacyCursor && !isScopedCursor) throw new Error('invalid cursor payload')
    if (isScopedCursor && parsed.scope !== expectedScope) {
      throw requestError('El cursor ya no corresponde a esta vista; vuelve a la primera página')
    }
    const occurredAt = String(parsed?.occurredAt || '').trim()
    const id = String(parsed?.id || '').trim()
    if (!occurredAt || !id) throw new Error('invalid cursor payload')
    if (occurredAt.length > 100 || id.length > 300 || !Number.isFinite(Date.parse(occurredAt))) {
      throw new Error('invalid cursor fields')
    }
    return { occurredAt, id }
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

function buildSearchCondition(normalized) {
  if (!normalized) return { sql: '', params: [] }

  const pattern = `%${normalized}%`
  const expressions = [
    'p.id',
    'p.description',
    'p.payment_provider',
    'p.payment_method',
    'p.amount',
    'c.full_name',
    'c.email',
    'c.phone'
  ]
  return {
    sql: `(${expressions.map(expression => `LOWER(COALESCE(CAST(${expression} AS TEXT), '')) LIKE ? ESCAPE '!'`).join(' OR ')})`,
    params: expressions.map(() => pattern)
  }
}

function mapTransactionRow(row) {
  const display = buildPaymentDisplay(row)
  const {
    metadata_json: _metadataJson,
    cursor_at: _cursorAt,
    created_at: _createdAt,
    ...publicRow
  } = row
  return {
    ...publicRow,
    amount: serializePaymentAmount(row.amount),
    payment_method_category: display.paymentMethodCategory,
    payment_method_category_id: display.paymentMethodCategoryId,
    payment_type: display.paymentType,
    payment_channel: display.paymentChannel,
    payment_channel_id: display.paymentChannelId
  }
}

export async function listReportTransactionsPage({
  startDate,
  endDate,
  search = '',
  cursor,
  page,
  limit = DEFAULT_PAGE_LIMIT
} = {}) {
  const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
  const pageLimit = normalizeLimit(limit)
  const hiddenFilters = await getHiddenContactFilters()
  const normalizedSearch = escapeLikeSearch(search)
  const cursorScope = hashPaginationCursorScope('report-transactions', {
    range: paginationCursorRangeScope(range),
    search: normalizedSearch,
    hiddenFilters: paginationCursorHiddenFiltersScope(hiddenFilters),
    paymentStatuses: paginationCursorListScope(SUCCESS_PAYMENT_STATUSES),
    paymentMode: 'non-test',
    sort: ['effective_date:desc', 'id:desc']
  })
  const decodedCursor = decodeCursor(cursor, cursorScope)
  const legacyPage = decodedCursor ? 1 : normalizeLegacyPage(page)
  if (!decodedCursor && legacyPage > 1) {
    throw requestError('Las páginas posteriores requieren cursor')
  }
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
  const baseConditions = [
    `LOWER(COALESCE(p.status, '')) IN (${SUCCESS_PAYMENT_STATUSES.map(() => '?').join(', ')})`,
    nonTestPaymentCondition('p')
  ]
  const baseParams = [...SUCCESS_PAYMENT_STATUSES]

  const effectiveDateSort = transactionCursorSortExpression('p')
  if (range.startUtc) {
    baseConditions.push(`${effectiveDateSort} >= ?`)
    baseParams.push(range.startUtc)
  }
  if (range.endUtc) {
    baseConditions.push(`${effectiveDateSort} <= ?`)
    baseParams.push(range.endUtc)
  }
  if (hiddenCondition) baseConditions.push(hiddenCondition)

  const searchCondition = buildSearchCondition(normalizedSearch)
  const listConditions = [...baseConditions]
  const listParams = [...baseParams]
  if (searchCondition.sql) {
    listConditions.push(searchCondition.sql)
    listParams.push(...searchCondition.params)
  }

  if (decodedCursor) {
    listConditions.push(`(${effectiveDateSort}, p.id) < (?, ?)`)
    listParams.push(decodedCursor.occurredAt, decodedCursor.id)
  }

  const baseWhere = `WHERE ${baseConditions.join(' AND ')}`
  const listWhere = `WHERE ${listConditions.join(' AND ')}`
  const rowsQuery = `
    SELECT
      p.id,
      p.contact_id,
      c.full_name AS contact_name,
      c.email AS contact_email,
      c.phone AS contact_phone,
      p.amount,
      p.currency,
      p.status,
      p.date,
      p.created_at,
      ${transactionCursorProjectionExpression('p')} AS cursor_at,
      p.payment_provider,
      p.payment_method,
      p.metadata_json,
      p.description
    FROM payments p
    LEFT JOIN contacts c ON c.id = p.contact_id
    ${listWhere}
    ORDER BY ${effectiveDateSort} DESC, p.id DESC
    LIMIT ?
  `
  const rowsParams = [...listParams, pageLimit + 1]
  const summaryQuery = `
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(p.amount), 0) AS total_amount
    FROM payments p
    LEFT JOIN contacts c ON c.id = p.contact_id
    ${baseWhere}
  `
  const summaryCacheKey = buildReportTransactionSummaryCacheKey({
    startUtc: range.startUtc,
    endUtc: range.endUtc,
    hiddenFilters
  })
  const summaryPromise = getReportTransactionSummary({
    cacheKey: summaryCacheKey,
    buildSummary: async () => {
      const row = await db.get(summaryQuery, baseParams)
      return {
        count: Number(row?.count || 0),
        totalAmount: Number(row?.total_amount || 0)
      }
    }
  })
  // El modal sólo necesita el total filtrado al iniciar una búsqueda. En páginas
  // siguientes hasNext viene de limit+1; repetir COUNT sobre millones no aporta.
  const filteredCountPromise = searchCondition.sql && !decodedCursor
    ? db.get(`
        SELECT COUNT(*) AS total
        FROM payments p
        LEFT JOIN contacts c ON c.id = p.contact_id
        WHERE ${[...baseConditions, searchCondition.sql].join(' AND ')}
      `, [...baseParams, ...searchCondition.params])
    : null

  const [rows, summary, filteredCountRow] = await Promise.all([
    db.all(rowsQuery, rowsParams),
    summaryPromise,
    filteredCountPromise
  ])
  const hasNext = rows.length > pageLimit
  const pageRows = hasNext ? rows.slice(0, pageLimit) : rows
  const total = searchCondition.sql
    ? (filteredCountRow ? Number(filteredCountRow.total || 0) : null)
    : Number(summary.count || 0)

  return {
    range,
    transactions: pageRows.map(mapTransactionRow),
    summary,
    pagination: {
      mode: decodedCursor || !page ? 'cursor' : 'page',
      page: decodedCursor ? null : legacyPage,
      limit: pageLimit,
      total,
      totalPages: total === null ? null : Math.ceil(total / pageLimit),
      hasNext,
      hasPrev: decodedCursor ? false : legacyPage > 1,
      nextCursor: hasNext ? encodeCursor(pageRows[pageRows.length - 1], cursorScope) : null
    }
  }
}

export const REPORT_TRANSACTIONS_PAGE_LIMITS = Object.freeze({
  default: DEFAULT_PAGE_LIMIT,
  max: MAX_PAGE_LIMIT
})
