import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import { getTransactions } from '../src/controllers/transactionsController.js'
import { buildTransactionSummary } from '../src/services/analyticsService.js'

function createResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    }
  }
}

async function withHiddenFiltersCleared(callback) {
  const columns = await db.all('PRAGMA table_info(hidden_contact_filters)').catch(() => [])
  const columnNames = columns.map(column => column.name).filter(Boolean)
  const rows = columnNames.length ? await db.all('SELECT * FROM hidden_contact_filters').catch(() => []) : []

  await db.run('DELETE FROM hidden_contact_filters').catch(() => undefined)
  try {
    return await callback()
  } finally {
    await db.run('DELETE FROM hidden_contact_filters').catch(() => undefined)
    for (const row of rows) {
      const placeholders = columnNames.map(() => '?').join(', ')
      const quotedColumns = columnNames.map(column => `"${String(column).replace(/"/g, '""')}"`).join(', ')
      await db.run(
        `INSERT INTO hidden_contact_filters (${quotedColumns}) VALUES (${placeholders})`,
        columnNames.map(column => row[column])
      ).catch(() => undefined)
    }
  }
}

async function cleanup(ids) {
  await db.run(
    `DELETE FROM payments
     WHERE id IN (?, ?, ?, ?) OR contact_id IN (?, ?)`,
    [
      ids.paidPaymentId,
      ids.succeededPaymentId,
      ids.failedPaymentId,
      ids.otherPaymentId,
      ids.matchingContactId,
      ids.otherContactId
    ]
  ).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id IN (?, ?)', [ids.matchingContactId, ids.otherContactId]).catch(() => undefined)
}

test('transactions list paginates search results and summary honors search/status filters', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const ids = {
    matchingContactId: `payments-page-contact-${suffix}`,
    otherContactId: `payments-page-other-${suffix}`,
    paidPaymentId: `payments-page-paid-${suffix}`,
    succeededPaymentId: `payments-page-succeeded-${suffix}`,
    failedPaymentId: `payments-page-failed-${suffix}`,
    otherPaymentId: `payments-page-other-payment-${suffix}`
  }
  const searchName = `Ana Blindaje Pagos ${suffix}`
  const date = '2026-07-01T18:00:00.000Z'

  await cleanup(ids)

  try {
    await withHiddenFiltersCleared(async () => {
      await db.run(
        `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
         VALUES (?, ?, ?, '+5215550101000', 'test', ?, ?)`,
        [ids.matchingContactId, searchName, `ana-blindaje-${suffix}@local.invalid`, date, date]
      )
      await db.run(
        `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
         VALUES (?, ?, ?, '+5215550102000', 'test', ?, ?)`,
        [ids.otherContactId, `Beto Blindaje Pagos ${suffix}`, `beto-blindaje-${suffix}@local.invalid`, date, date]
      )

      await db.run(
        `INSERT INTO payments (
          id, contact_id, amount, currency, status, payment_method, payment_mode,
          payment_provider, title, description, date, created_at, updated_at
        ) VALUES (?, ?, 100, 'MXN', 'paid', 'card', 'live', 'manual', 'Pago pagado', 'Pago pagado', ?, ?, ?)`,
        [ids.paidPaymentId, ids.matchingContactId, date, date, date]
      )
      await db.run(
        `INSERT INTO payments (
          id, contact_id, amount, currency, status, payment_method, payment_mode,
          payment_provider, title, description, date, created_at, updated_at
        ) VALUES (?, ?, 200, 'MXN', 'succeeded', 'card', 'live', 'stripe', 'Pago exitoso', 'Pago exitoso', ?, ?, ?)`,
        [ids.succeededPaymentId, ids.matchingContactId, date, date, date]
      )
      await db.run(
        `INSERT INTO payments (
          id, contact_id, amount, currency, status, payment_method, payment_mode,
          payment_provider, title, description, date, created_at, updated_at
        ) VALUES (?, ?, 300, 'MXN', 'failed', 'card', 'live', 'stripe', 'Pago rechazado', 'Pago rechazado', ?, ?, ?)`,
        [ids.failedPaymentId, ids.matchingContactId, date, date, date]
      )
      await db.run(
        `INSERT INTO payments (
          id, contact_id, amount, currency, status, payment_method, payment_mode,
          payment_provider, title, description, date, created_at, updated_at
        ) VALUES (?, ?, 999, 'MXN', 'paid', 'card', 'live', 'manual', 'Pago otro contacto', 'Pago otro contacto', ?, ?, ?)`,
        [ids.otherPaymentId, ids.otherContactId, date, date, date]
      )

      const res = createResponse()
      await getTransactions({
        query: {
          page: '1',
          limit: '1',
          q: searchName,
          status: 'paid',
          startDate: '2026-07-01',
          endDate: '2026-07-01',
          sortBy: 'amount',
          sortOrder: 'ASC',
          sync: 'false'
        },
        headers: {}
      }, res)

      assert.equal(res.statusCode, 200)
      assert.equal(res.payload.success, true)
      assert.equal(res.payload.data.length, 1)
      assert.equal(res.payload.data[0].amount, 100)
      assert.equal(res.payload.pagination.total, 2)
      assert.equal(res.payload.pagination.totalPages, 2)
      assert.equal(res.payload.pagination.hasNext, true)

      const statusCounts = Object.fromEntries(
        res.payload.facets.statuses.map(status => [status.value, status.count])
      )
      assert.equal(statusCounts.paid, 2)
      assert.equal(statusCounts.failed, 1)

      const multiStatusRes = createResponse()
      await getTransactions({
        query: {
          page: '1',
          limit: '10',
          q: searchName,
          status: 'paid,failed',
          startDate: '2026-07-01',
          endDate: '2026-07-01',
          sortBy: 'amount',
          sortOrder: 'ASC',
          sync: 'false'
        },
        headers: {}
      }, multiStatusRes)

      assert.equal(multiStatusRes.statusCode, 200)
      assert.equal(multiStatusRes.payload.pagination.total, 3)
      assert.deepEqual(multiStatusRes.payload.data.map(payment => payment.amount), [100, 200, 300])

      const { summary } = await buildTransactionSummary({
        startDate: '2026-07-01',
        endDate: '2026-07-01',
        search: searchName,
        statuses: ['paid']
      })

      assert.equal(summary.totalRevenue, 300)
      assert.equal(summary.completedPayments, 2)
      assert.equal(summary.averageTicket, 150)
      assert.equal(summary.refunds, 0)
    })
  } finally {
    await cleanup(ids)
  }
})
