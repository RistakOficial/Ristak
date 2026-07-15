import { databaseDialect, db } from '../config/database.js'
import { serializePaymentRowAmount } from '../utils/paymentAmountSerialization.js'

const DEFAULT_PAGE_LIMIT = 20
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

function cleanId(value) {
  const id = String(value || '').trim()
  if (!id || id.length > 300) throw requestError('Contacto inválido')
  return id
}

function timestampSortExpression(...expressions) {
  const values = expressions.map(value => String(value || '').trim()).filter(Boolean)
  if (isPostgres) {
    return `COALESCE(${values.join(', ')}, TIMESTAMPTZ '1970-01-01 00:00:00+00')`
  }
  return `COALESCE(${values.map(value => `julianday(${value})`).join(', ')}, julianday('1970-01-01 00:00:00'))`
}

function timestampProjectionExpression(...expressions) {
  if (isPostgres) return `(${timestampSortExpression(...expressions)})::text`
  return `printf('%.17g', ${timestampSortExpression(...expressions)})`
}

function timestampParameterExpression() {
  return isPostgres ? '?::timestamptz' : 'CAST(? AS REAL)'
}

function encodeCursor({ kind, contactId, occurredAt, id }) {
  if (!occurredAt || !id) return null
  return Buffer.from(JSON.stringify({
    v: 1,
    kind,
    contactId,
    occurredAt: String(occurredAt),
    id: String(id)
  }), 'utf8').toString('base64url')
}

function decodeCursor(value, { kind, contactId }) {
  const encoded = String(value || '').trim()
  if (!encoded) return null
  if (encoded.length > 2_048) throw requestError('Cursor inválido')

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (
      parsed?.v !== 1 ||
      parsed?.kind !== kind ||
      parsed?.contactId !== contactId ||
      !String(parsed?.occurredAt || '').trim() ||
      !String(parsed?.id || '').trim()
    ) {
      throw new Error('invalid cursor payload')
    }
    if (String(parsed.occurredAt).length > 120 || String(parsed.id).length > 300) {
      throw new Error('invalid cursor fields')
    }
    return { occurredAt: String(parsed.occurredAt), id: String(parsed.id) }
  } catch {
    throw requestError('El cursor ya no corresponde a este contacto')
  }
}

async function listContactChildPage({
  kind,
  contactId: rawContactId,
  cursor,
  limit,
  signal,
  table,
  alias,
  timestampColumns,
  where = [],
  select = `${alias}.*`,
  mapRow = row => row
}) {
  const contactId = cleanId(rawContactId)
  const pageLimit = normalizeLimit(limit)
  const decodedCursor = decodeCursor(cursor, { kind, contactId })
  const occurredAtSort = timestampSortExpression(...timestampColumns)
  const conditions = [`${alias}.contact_id = ?`, ...where]
  const params = [contactId]

  if (decodedCursor) {
    conditions.push(`(${occurredAtSort}, ${alias}.id) < (${timestampParameterExpression()}, ?)`)
    params.push(decodedCursor.occurredAt, decodedCursor.id)
  }

  const rows = await db.all(`
    SELECT
      ${select},
      ${timestampProjectionExpression(...timestampColumns)} AS detail_cursor_at
    FROM ${table} ${alias}
    WHERE ${conditions.join('\n      AND ')}
    ORDER BY ${occurredAtSort} DESC, ${alias}.id DESC
    LIMIT ?
  `, [...params, pageLimit + 1], { signal })

  const hasNext = rows.length > pageLimit
  const pageRows = hasNext ? rows.slice(0, pageLimit) : rows
  const lastRow = pageRows[pageRows.length - 1]
  const nextCursor = hasNext
    ? encodeCursor({
        kind,
        contactId,
        occurredAt: lastRow.detail_cursor_at,
        id: lastRow.id
      })
    : null

  return {
    rows: pageRows.map(row => {
      const { detail_cursor_at: _cursor, ...publicRow } = row
      return mapRow(publicRow)
    }),
    pagination: {
      mode: 'cursor',
      limit: pageLimit,
      hasNext,
      nextCursor
    }
  }
}

export function listContactPaymentsPage({ contactId, cursor, limit, signal } = {}) {
  return listContactChildPage({
    kind: 'contact-payments',
    contactId,
    cursor,
    limit,
    signal,
    table: 'payments',
    alias: 'payment',
    timestampColumns: ['payment.date', 'payment.created_at'],
    where: [
      "LOWER(COALESCE(payment.status, '')) != 'deleted'",
      `NOT (
        (COALESCE(payment.metadata_json, '') LIKE '%site_checkout%' OR COALESCE(payment.metadata_json, '') LIKE '%site_form%')
        AND LOWER(COALESCE(payment.status, '')) IN ('sent', 'pending', 'processing', 'requires_action', 'requires_payment_method', 'incomplete', 'draft', 'initiated')
      )`
    ],
    mapRow: row => serializePaymentRowAmount({ ...row })
  }).then(result => ({ payments: result.rows, pagination: result.pagination }))
}

export function listContactAppointmentsPage({ contactId, cursor, limit, signal } = {}) {
  return listContactChildPage({
    kind: 'contact-appointments',
    contactId,
    cursor,
    limit,
    signal,
    table: 'appointments',
    alias: 'appointment',
    timestampColumns: ['appointment.start_time', 'appointment.date_added', 'appointment.date_updated']
  }).then(result => ({ appointments: result.rows, pagination: result.pagination }))
}
