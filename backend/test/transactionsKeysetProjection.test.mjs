import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { databaseDialect, db } from '../src/config/database.js'
import { getTransactions } from '../src/controllers/transactionsController.js'
import { runVersionedMigrations } from '../src/startup/runMigrations.js'

const marker = `transaction_keyset_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`
const contactIds = [`${marker}_contact_a`, `${marker}_contact_b`]
const paymentIds = ['a', 'b', 'c', 'd'].map(suffix => `${marker}_payment_${suffix}`)

function response() {
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

async function request(query) {
  const res = response()
  await getTransactions({ query, headers: {} }, res)
  return res
}

async function collect(sortBy, sortOrder) {
  const ids = []
  const cursors = new Set()
  let cursor = null
  let page = 1

  do {
    const res = await request({
      pagination: 'cursor',
      page: String(page),
      limit: '1',
      q: marker,
      sortBy,
      sortOrder,
      ...(cursor ? { cursor } : {})
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)
    assert.equal(res.payload.pagination.total, null)
    assert.equal(res.payload.pagination.totalPages, null)
    assert.deepEqual(res.payload.facets.statuses, [])
    assert.equal(res.payload.data.length, 1)
    assert.equal(Object.keys(res.payload.data[0]).some(key => key.startsWith('cursor_')), false)
    ids.push(res.payload.data[0].id)

    cursor = res.payload.pagination.nextCursor
    if (cursor) {
      assert.equal(cursors.has(cursor), false)
      cursors.add(cursor)
      page += 1
      assert.ok(page <= 10, 'el cursor no debe ciclar')
    }
  } while (cursor)

  return ids
}

test.before(async () => {
  if (databaseDialect !== 'sqlite') return
  await runVersionedMigrations()
  await db.run('DELETE FROM hidden_contact_filters').catch(() => undefined)
  await db.run(
    `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
     VALUES (?, 'Alpha Keyset', ?, '+5215550101000', 'test', '2097-01-01T00:00:00Z', '2097-01-01T00:00:00Z')`,
    [contactIds[0], `${marker}-alpha@example.test`]
  )
  await db.run(
    `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
     VALUES (?, 'Beta Keyset', ?, '+5215550102000', 'test', '2097-01-01T00:00:00Z', '2097-01-01T00:00:00Z')`,
    [contactIds[1], `${marker}-beta@example.test`]
  )

  const rows = [
    [paymentIds[0], contactIds[0], 10, 'paid', 'card', 'stripe', '2097-02-01T12:00:00.123Z', '2097-02-01T12:00:00.111Z', 'Alpha'],
    [paymentIds[1], contactIds[0], 10, 'succeeded', 'card', 'stripe', '2097-02-01T12:00:00.123Z', '2097-02-01T12:00:00.111Z', 'Alpha'],
    [paymentIds[2], contactIds[1], 20, 'failed', 'cash', 'manual', '2097-02-02T12:00:00.456Z', '2097-02-02T12:00:00.222Z', 'Beta'],
    [paymentIds[3], `${marker}_missing_contact`, 15, 'pending', 'transfer', 'manual', null, '2097-02-03T12:00:00.333Z', 'Orphan']
  ]
  // Los respaldos viejos pueden contener pagos cuyo contacto ya no existe. La
  // proyección debe seguir listándolos aunque el esquema nuevo proteja esa FK.
  await db.run('PRAGMA foreign_keys = OFF')
  try {
    for (const row of rows) {
      const [id, contactId, amount, status, method, provider, date, createdAt, title] = row
      await db.run(
        `INSERT INTO payments (
          id, contact_id, amount, currency, status, payment_method, payment_mode,
          payment_provider, title, description, date, created_at, updated_at
        ) VALUES (?, ?, ?, 'MXN', ?, ?, 'live', ?, ?, ?, ?, ?, ?)`,
        [
          id, contactId, amount, status, method, provider,
          `${marker} ${title}`, `${marker} ${title}`, date, createdAt, createdAt
        ]
      )
    }
  } finally {
    await db.run('PRAGMA foreign_keys = ON')
  }
  await db.run(`UPDATE crm_list_projection_state SET status = 'ready'`)
})

test.after(async () => {
  await db.run(`DELETE FROM payments WHERE id LIKE ?`, [`${marker}%`]).catch(() => undefined)
  await db.run(`DELETE FROM contacts WHERE id LIKE ?`, [`${marker}%`]).catch(() => undefined)
})

test('cursor de pagos recorre todos los sorts visibles ASC/DESC sin duplicar ni omitir huérfanos', async () => {
  const sorts = [
    'date', 'created_at', 'amount', 'status', 'contactName', 'email',
    'method', 'paymentType', 'paymentChannel', 'title'
  ]
  for (const sortBy of sorts) {
    for (const sortOrder of ['ASC', 'DESC']) {
      const ids = await collect(sortBy, sortOrder)
      assert.equal(ids.length, paymentIds.length, `${sortBy} ${sortOrder}`)
      assert.deepEqual(new Set(ids), new Set(paymentIds), `${sortBy} ${sortOrder}`)
    }
  }

  const orphan = await request({
    pagination: 'cursor', limit: '10', q: `${marker} Orphan`, sortBy: 'date', sortOrder: 'ASC'
  })
  assert.equal(orphan.payload.data[0].id, paymentIds[3])
  assert.equal(orphan.payload.data[0].contactName, '')
})

test('cursor queda ligado a filtros y la revisión cubre INSERT/UPDATE/DELETE y contacto asociado', async () => {
  const first = await request({
    pagination: 'cursor', limit: '1', q: marker, sortBy: 'amount', sortOrder: 'ASC'
  })
  const wrongScope = await request({
    pagination: 'cursor', limit: '1', q: marker, sortBy: 'amount', sortOrder: 'DESC',
    cursor: first.payload.pagination.nextCursor
  })
  assert.equal(wrongScope.statusCode, 400)

  const revision = async () => Number((await db.get(
    `SELECT revision FROM payment_list_revisions WHERE scope = 'transactions'`
  ))?.revision || 0)
  const generationsBefore = await db.all(
    `SELECT projection_key, generation FROM crm_list_projection_state ORDER BY projection_key`
  )
  const before = await revision()
  await db.run(`UPDATE payments SET amount = 11, reference = ? WHERE id = ?`, [`${marker}-updated`, paymentIds[0]])
  assert.equal(Number((await db.get(
    `SELECT amount_sort FROM payment_list_activity WHERE payment_id = ?`, [paymentIds[0]]
  ))?.amount_sort), 11)
  const afterPaymentUpdate = await revision()
  assert.ok(afterPaymentUpdate > before)
  await db.run(`UPDATE contacts SET full_name = 'Alpha Keyset Updated' WHERE id = ?`, [contactIds[0]])
  assert.equal((await db.get(
    `SELECT contact_name_sort FROM payment_list_activity WHERE payment_id = ?`, [paymentIds[0]]
  ))?.contact_name_sort, 'alpha keyset updated')
  const afterContactUpdate = await revision()
  assert.ok(afterContactUpdate > afterPaymentUpdate)
  await db.run(`DELETE FROM payments WHERE id = ?`, [paymentIds[3]])
  const afterOrphanDelete = await revision()
  assert.ok(afterOrphanDelete > afterContactUpdate)
  assert.deepEqual(
    await db.all(`SELECT projection_key, generation FROM crm_list_projection_state ORDER BY projection_key`),
    generationsBefore,
    'las mutaciones sincronizan la proyección sin bloquear filas de estado ya ready'
  )
})

test('el plan usa índices de la proyección y los GET de lista/detalle no llaman proveedores', async () => {
  const plan = await db.all(
    `EXPLAIN QUERY PLAN
     SELECT payment_id FROM payment_list_activity
     ORDER BY amount_sort ASC, created_sort ASC, payment_id ASC LIMIT 20`
  )
  assert.match(plan.map(row => row.detail || '').join(' '), /idx_payment_list_activity_amount/i)

  const contactProjectionPlan = await db.all(
    `EXPLAIN QUERY PLAN SELECT 1 FROM payment_list_activity WHERE contact_id = ? LIMIT 1`,
    [contactIds[0]]
  )
  assert.match(contactProjectionPlan.map(row => row.detail || '').join(' '), /idx_payment_list_activity_contact/i)
  const contactCleanupPlan = await db.all(
    `EXPLAIN QUERY PLAN DELETE FROM contact_payment_activity_items WHERE contact_id = ?`,
    [contactIds[0]]
  )
  assert.match(contactCleanupPlan.map(row => row.detail || '').join(' '), /idx_contact_payment_items_contact/i)

  for (const migrationName of [
    '097zh_payment_list_contact_id.postgres.sql',
    '097zi_contact_payment_items_contact.postgres.sql'
  ]) {
    const migration = await readFile(
      new URL(`../migrations/versioned/${migrationName}`, import.meta.url),
      'utf8'
    )
    assert.equal((migration.match(/CREATE INDEX CONCURRENTLY/g) || []).length, 1)
    assert.doesNotMatch(migration, /\bBEGIN\b|\bCOMMIT\b/)
  }

  const source = await readFile(new URL('../src/controllers/transactionsController.js', import.meta.url), 'utf8')
  const listSource = source.slice(source.indexOf('export const getTransactions'), source.indexOf('export const getTransactionFacets'))
  const detailSource = source.slice(source.indexOf('export const getTransactionById'), source.indexOf('export const getTransactionStats'))
  assert.doesNotMatch(listSource, /syncAllInvoices|refreshStripePaymentFromIntent|refreshStripeTransactionsForRows/)
  assert.doesNotMatch(detailSource, /syncAllInvoices|refreshStripePaymentFromIntent|refreshStripeTransactionsForRows/)
  assert.match(source, /export const syncTransactions[\s\S]*?syncAllInvoices/)
})
