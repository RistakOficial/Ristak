import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  hashPaginationCursorScope,
  paginationCursorHiddenFiltersScope,
  paginationCursorListScope,
  paginationCursorRangeScope
} from '../src/utils/paginationCursorScope.js'

const reportContactsUrl = new URL('../src/services/reportContactsPaginationService.js', import.meta.url)
const reportTransactionsUrl = new URL('../src/services/reportTransactionsPaginationService.js', import.meta.url)
const campaignContactsUrl = new URL('../src/services/campaignContactsPaginationService.js', import.meta.url)

test('cursores PostgreSQL del grupo A proyectan microsegundos como texto sin tocar el DTO', async () => {
  const [reportContacts, reportTransactions, campaignContacts] = await Promise.all([
    readFile(reportContactsUrl, 'utf8'),
    readFile(reportTransactionsUrl, 'utf8'),
    readFile(campaignContactsUrl, 'utf8')
  ])

  assert.match(reportContacts, /COALESCE\(\$\{alias\}\.created_at, TIMESTAMP '1970-01-01 00:00:00'\)/)
  assert.match(reportContacts, /contactCursorProjectionExpression[\s\S]{0,180}\(\$\{sortExpression\}\)::text/)
  assert.match(reportContacts, /row\?\.cursor_created_at/)
  assert.match(reportContacts, /created_at,[\s\S]{0,220}AS cursor_created_at/)
  assert.match(reportContacts, /\(\$\{cursorSortExpression\}, c\.id\) < \(\?, \?\)/)
  assert.match(reportContacts, /ORDER BY \$\{cursorSortExpression\} DESC, c\.id DESC/)
  assert.match(reportContacts, /created_at: row\.created_at/)

  assert.match(reportTransactions, /COALESCE\(\$\{alias\}\.date, \$\{alias\}\.created_at, TIMESTAMP '1970-01-01 00:00:00'\)/)
  assert.match(reportTransactions, /transactionCursorProjectionExpression[\s\S]{0,180}\(\$\{sortExpression\}\)::text/)
  assert.match(reportTransactions, /\$\{transactionCursorProjectionExpression\('p'\)\} AS cursor_at/)
  assert.match(reportTransactions, /\(\$\{effectiveDateSort\}, p\.id\) < \(\?, \?\)/)
  assert.match(reportTransactions, /ORDER BY \$\{effectiveDateSort\} DESC, p\.id DESC/)
  assert.match(reportTransactions, /cursor_at: _cursorAt,[\s\S]{0,80}created_at: _createdAt/)

  assert.match(campaignContacts, /COALESCE\(\$\{valueExpression\}, TIMESTAMP '1970-01-01 00:00:00'\)/)
  assert.match(campaignContacts, /campaignContactCursorProjectionExpression[\s\S]{0,260}\(\$\{effectiveTimestamp\}\)::text/)
  assert.equal(
    (campaignContacts.match(/julianday\('1970-01-01 00:00:00'\)/g) || []).length,
    2,
    'SQLite debe usar el mismo fallback numérico al ordenar y al comparar el cursor'
  )
  assert.match(campaignContacts, /row\?\.cursor_created_at/)
  assert.match(campaignContacts, /AS cursor_created_at/)
  assert.match(campaignContacts, /\(\$\{createdAtSort\}, c\.id\) < /)
  assert.match(campaignContacts, /ORDER BY \$\{createdAtSort\} DESC, c\.id DESC/)
  assert.match(campaignContacts, /created_at: row\.created_at/)
})

test('cursores del grupo A ligan v2 al alcance efectivo y conservan formatos legacy', async () => {
  const [reportContacts, reportTransactions, campaignContacts] = await Promise.all([
    readFile(reportContactsUrl, 'utf8'),
    readFile(reportTransactionsUrl, 'utf8'),
    readFile(campaignContactsUrl, 'utf8')
  ])

  assert.match(reportContacts, /v: 2,[\s\S]{0,80}kind: 'report-contacts',[\s\S]{0,80}scope/)
  assert.match(reportContacts, /decoded\?\.v === undefined[\s\S]{0,180}decoded\?\.v === 2/)
  assert.match(reportContacts, /hashPaginationCursorScope\('report-contacts',[\s\S]{0,900}range:[\s\S]{0,900}type:[\s\S]{0,900}scope:[\s\S]{0,900}dedupeByPerson:[\s\S]{0,900}search:[\s\S]{0,900}hiddenFilters:[\s\S]{0,900}calendarIds:[\s\S]{0,900}sort:/)

  assert.match(reportTransactions, /v: 2, kind: 'report-transactions', scope/)
  assert.match(reportTransactions, /parsed\?\.v === 1[\s\S]{0,180}parsed\?\.v === 2/)
  assert.match(reportTransactions, /hashPaginationCursorScope\('report-transactions',[\s\S]{0,700}range:[\s\S]{0,700}search:[\s\S]{0,700}hiddenFilters:[\s\S]{0,700}paymentStatuses:[\s\S]{0,700}sort:/)

  assert.match(campaignContacts, /v: 2, kind: 'campaign-contacts', scope/)
  assert.match(campaignContacts, /parsed\?\.v === 1[\s\S]{0,180}parsed\?\.v === 2/)
  assert.match(campaignContacts, /hashPaginationCursorScope\('campaign-contacts',[\s\S]{0,800}range:[\s\S]{0,800}type:[\s\S]{0,800}entity:[\s\S]{0,800}search:[\s\S]{0,800}hiddenFilters:[\s\S]{0,800}calendarIds:[\s\S]{0,800}sort:/)

  for (const source of [reportContacts, reportTransactions, campaignContacts]) {
    assert.match(source, /scope !== expectedScope/)
    assert.match(source, /El cursor ya no corresponde a esta vista/)
  }
})

test('hash de alcance canonicaliza rango, filtros e IDs sin guardar valores crudos en el cursor', () => {
  const range = paginationCursorRangeScope({
    startZoned: { toISODate: () => '2099-01-01' },
    endZoned: { toISODate: () => '2099-01-31' },
    startUtc: '2099-01-01T06:00:00.000Z',
    endUtc: '2099-02-01T05:59:59.999Z',
    appliedTimezone: 'America/Ciudad_Juarez'
  })
  const hiddenFilters = paginationCursorHiddenFiltersScope([
    { text: 'Beta', type: 'exact' },
    { text: 'Alpha\u0000', type: 'contains' },
    { text: 'Beta', type: 'exact' }
  ])
  const ids = paginationCursorListScope(['calendar-b', 'calendar-a', 'calendar-b'])
  const context = { range, hiddenFilters, ids, sort: ['created_at:desc', 'id:desc'] }
  const expected = createHash('sha256')
    .update(JSON.stringify({ kind: 'cursor-test', ...context }))
    .digest('base64url')

  assert.deepEqual(hiddenFilters, [
    { text: 'Alpha', type: 'contains' },
    { text: 'Beta', type: 'exact' }
  ])
  assert.deepEqual(ids, ['calendar-a', 'calendar-b'])
  assert.equal(hashPaginationCursorScope('cursor-test', context), expected)
})
