import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { databaseDialect, db } from '../src/config/database.js'
import { listInvoiceSchedules } from '../src/controllers/highlevelController.js'
import { isPaymentPlanScheduleFullyPaid } from '../src/utils/paymentPlanStatus.js'

test.before(async () => {
  if (databaseDialect !== 'sqlite') return
  for (const name of [
    '061_payment_plans_pagination.sqlite.sql',
    '071_payment_lists_cursor_summary.sqlite.sql'
  ]) {
    await db.exec(await readFile(new URL(`../migrations/versioned/${name}`, import.meta.url), 'utf8'))
  }
})

function requestList(query = {}) {
  return new Promise((resolve, reject) => {
    const req = { query }
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code
        return this
      },
      json(payload) {
        if (this.statusCode >= 400 || payload?.success === false) {
          reject(new Error(payload?.error || `payment plans request failed (${this.statusCode})`))
          return
        }
        resolve(payload)
      }
    }

    listInvoiceSchedules(req, res).catch(reject)
  })
}

test('planes de pago pagina, busca, filtra, ordena y resume el universo desde SQL', async () => {
  const marker = `scale_plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const statuses = ['active', 'scheduled', 'paused', 'completed', 'canceled']

  try {
    for (let index = 0; index < 45; index += 1) {
      const day = String((index % 28) + 1).padStart(2, '0')
      await db.run(
        `INSERT INTO payment_plans (
          id, contact_name, email, phone, name, title, status, total, currency,
          recurrence_label, start_date, next_run_at, source, raw_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', 'Mensual', ?, ?, 'stripe', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          `${marker}_${String(index).padStart(3, '0')}`,
          `Contacto ${marker} ${index}`,
          `${marker}.${index}@example.test`,
          `+1555${String(index).padStart(7, '0')}`,
          `Plan ${marker} ${index}`,
          `Plan ${marker} ${index}`,
          statuses[index % statuses.length],
          index + 1,
          `2026-08-${day}`,
          `2026-09-${day}`
        ]
      )
    }

    const firstPage = await requestList({
      q: marker,
      page: '1',
      limit: '10',
      sortBy: 'total',
      sortOrder: 'DESC'
    })
    assert.ok(firstPage.pagination.nextCursor)

    const secondPage = await requestList({
      q: marker,
      page: '2',
      cursor: firstPage.pagination.nextCursor,
      limit: '10',
      sortBy: 'total',
      sortOrder: 'DESC'
    })

    assert.equal(secondPage.source, 'local')
    assert.equal(secondPage.data.length, 10)
    assert.equal(secondPage.pagination.page, 2)
    assert.equal(secondPage.pagination.limit, 10)
    assert.equal(secondPage.pagination.total, null)
    assert.equal(secondPage.pagination.totalPages, null)
    assert.equal(secondPage.pagination.hasNext, true)
    assert.equal(secondPage.pagination.hasPrev, true)
    assert.ok(secondPage.pagination.nextCursor)
    assert.equal(secondPage.data[0].total, 35)
    assert.equal(secondPage.data.at(-1).total, 26)
    assert.ok(secondPage.summary.total >= 45)
    assert.ok(secondPage.summary.active >= 18)
    assert.ok(secondPage.summary.inactive >= 18)
    assert.ok(secondPage.summary.completed >= 9)
    const facetCounts = Object.fromEntries(secondPage.facets.statuses.map((item) => [item.value, item.count]))
    assert.ok(facetCounts.active >= 9)
    assert.ok(facetCounts.cancelled >= 9)
    assert.ok(facetCounts.completed >= 9)
    assert.ok(facetCounts.paused >= 9)
    assert.ok(facetCounts.scheduled >= 9)

    const cancelled = await requestList({
      q: marker,
      status: 'canceled',
      page: '1',
      limit: '5',
      sortBy: 'name',
      sortOrder: 'ASC'
    })
    assert.equal(cancelled.pagination.total, null)
    assert.equal(cancelled.data.length, 5)
    assert.ok(cancelled.data.every((plan) => plan.status === 'canceled'))
    assert.ok(cancelled.summary.total >= 45, 'los KPIs no deben reducirse al tamaño de la página ni al filtro de estado')

    await assert.rejects(
      requestList({ q: marker, limit: '10', offset: '20', sortBy: 'total', sortOrder: 'DESC' }),
      /offset|nextCursor/i
    )

    if (databaseDialect === 'sqlite') {
      const plan = await db.all(
        `EXPLAIN QUERY PLAN
         SELECT payment_plans.*
         FROM payment_plans
         WHERE LOWER(
           COALESCE(payment_plans.id, '') || ' ' ||
           COALESCE(payment_plans.name, '') || ' ' ||
           COALESCE(payment_plans.title, '') || ' ' ||
           COALESCE(payment_plans.contact_name, '') || ' ' ||
           COALESCE(payment_plans.email, '') || ' ' ||
           COALESCE(payment_plans.phone, '') || ' ' ||
           COALESCE(payment_plans.description, '') || ' ' ||
           COALESCE(payment_plans.recurrence_label, '') || ' ' ||
           COALESCE(payment_plans.source, '')
         ) LIKE ?
         ORDER BY
           COALESCE(payment_plans.start_date, payment_plans.next_run_at, payment_plans.updated_at, payment_plans.created_at, '') DESC,
           COALESCE(payment_plans.next_run_at, payment_plans.updated_at, payment_plans.created_at, '') DESC,
           payment_plans.id DESC
         LIMIT 20`,
        [`%${marker}%`]
      )
      assert.match(plan.map((row) => row.detail).join('\n'), /idx_payment_plans_start_page/)
    }
  } finally {
    await db.run('DELETE FROM payment_plans WHERE id LIKE ?', [`${marker}%`])
  }
})

test('el contrato de lectura de planes no consulta pasarelas y la tabla usa controles server-side', async () => {
  const controller = await readFile(new URL('../src/controllers/highlevelController.js', import.meta.url), 'utf8')
  const listHandler = controller.slice(
    controller.indexOf('export const listInvoiceSchedules'),
    controller.indexOf('export const getInvoiceSchedule')
  )
  const detailHandler = controller.slice(
    controller.indexOf('export const getInvoiceSchedule'),
    controller.indexOf('export const updateInvoiceSchedule')
  )
  const frontend = await readFile(new URL('../../frontend/src/pages/Transactions/Transactions.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(listHandler, /getGHLClient|refreshStripePaymentPlanMirrors|refreshConektaPaymentPlanMirrors|refreshRebillPaymentPlanMirrors/)
  assert.doesNotMatch(detailHandler, /getGHLClient|getInvoiceSchedule\(scheduleId\)/)
  assert.match(frontend, /key="payment_plans_table"[\s\S]*?serverSideSearch=\{true\}/)
  assert.match(frontend, /key="payment_plans_table"[\s\S]*?serverSidePagination=\{true\}/)
  assert.match(frontend, /key="payment_plans_table"[\s\S]*?serverSideSort=\{true\}/)
  assert.match(frontend, /key="payment_plans_table"[\s\S]*?cursorPagination/)
  assert.match(frontend, /paymentPlanCursorStackRef/)
  assert.match(frontend, /paymentPlanDetailRequestRef\.current\.sequence !== sequence/)
  assert.match(frontend, /const paymentPlanTotals = paymentPlanSummary/)
})

test('los mirrors materializan completado y el backfill corrige planes históricos sin leer JSON', async () => {
  const marker = `completed_plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const contactId = `contact_${marker}`
  const planId = `plan_${marker}`

  assert.equal(isPaymentPlanScheduleFullyPaid({
    firstPaymentAmount: 25,
    firstPaymentStatus: 'paid',
    installments: [{ status: 'succeeded' }, { status: 'registered' }]
  }), true)
  assert.equal(isPaymentPlanScheduleFullyPaid({
    firstPaymentAmount: 25,
    firstPaymentStatus: 'paid',
    installments: [{ status: 'pending' }]
  }), false)

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, email, source, created_at, updated_at)
       VALUES (?, 'Cliente backfill', ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, `${marker}@example.test`]
    )
    await db.run(
      `INSERT INTO payment_flows (
        id, contact_id, total_amount, currency, concept, first_payment_amount,
        first_payment_status, payment_provider, current_state, created_at, updated_at
      ) VALUES (?, ?, 100, 'USD', 'Plan histórico', 25, 'paid', 'stripe', 'installment_plan_active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [planId, contactId]
    )
    await db.run(
      `INSERT INTO installment_payments (
        id, flow_id, sequence, amount, status, created_at, updated_at
      ) VALUES (?, ?, 1, 75, 'paid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [`installment_${marker}`, planId]
    )
    await db.run(
      `INSERT INTO payment_plans (
        id, contact_id, name, status, total, currency, source, item_count, raw_json, created_at, updated_at
      ) VALUES (?, ?, 'Plan histórico', 'active', 100, 'USD', 'stripe', 2, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [planId, contactId, JSON.stringify({ providerPayload: 'x'.repeat(1_000_000) })]
    )

    const migration = await readFile(
      new URL('../migrations/versioned/061j_payment_plans_completed_backfill.sql', import.meta.url),
      'utf8'
    )
    await db.exec(migration)
    const row = await db.get('SELECT status FROM payment_plans WHERE id = ?', [planId])
    assert.equal(row?.status, 'completed')

    const listed = await requestList({ q: marker, limit: '20' })
    assert.equal(listed.data[0]?.completedItemCount, 2)
    assert.equal('raw' in listed.data[0], false, 'la lista no debe transportar raw_json ni schedule_json pesados')
    assert.ok(JSON.stringify(listed).length < 20_000, 'un JSON remoto grande no debe inflar la página de la tabla')

    const services = await Promise.all([
      readFile(new URL('../src/services/stripePaymentService.js', import.meta.url), 'utf8'),
      readFile(new URL('../src/services/conektaPaymentService.js', import.meta.url), 'utf8'),
      readFile(new URL('../src/services/rebillPaymentService.js', import.meta.url), 'utf8')
    ])
    services.forEach((source) => {
      assert.match(source, /isPaymentPlanScheduleFullyPaid/)
      assert.match(source, /\? 'completed'/)
    })
  } finally {
    await db.run('DELETE FROM installment_payments WHERE flow_id = ?', [planId]).catch(() => undefined)
    await db.run('DELETE FROM payment_plans WHERE id = ?', [planId]).catch(() => undefined)
    await db.run('DELETE FROM payment_flows WHERE id = ?', [planId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
