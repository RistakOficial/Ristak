import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { databaseDialect, db } from '../src/config/database.js'
import { listInvoiceSchedules } from '../src/controllers/highlevelController.js'
import { listSubscriptions } from '../src/services/subscriptionsService.js'

function decodeCursor(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

function scopeHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url')
}

function requestPaymentPlans(query = {}) {
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

async function collectSubscriptionIds({ marker, sortOrder }) {
  const ids = []
  const cursorPayloads = []
  const seenCursors = new Set()
  let cursor
  let page = 1

  do {
    const result = await listSubscriptions({
      search: marker,
      sortBy: 'nextRunAt',
      sortOrder,
      cursor,
      page,
      limit: 1
    })
    assert.equal(result.subscriptions.length, 1)
    assert.equal(
      Object.keys(result.subscriptions[0]).some((key) => key.startsWith('cursor_')),
      false,
      'las columnas privadas del cursor no deben filtrarse al DTO'
    )
    ids.push(result.subscriptions[0].id)

    cursor = result.pagination.nextCursor || undefined
    if (cursor) {
      assert.equal(seenCursors.has(cursor), false, 'el cursor debe avanzar en cada página')
      seenCursors.add(cursor)
      cursorPayloads.push(decodeCursor(cursor))
      page += 1
      assert.ok(page <= 10, 'el recorrido no debe entrar en un ciclo')
    }
  } while (cursor)

  return { ids, cursorPayloads }
}

async function collectPaymentPlanIds({ marker, sortBy, sortOrder }) {
  const ids = []
  const cursorPayloads = []
  const seenCursors = new Set()
  let cursor
  let page = 1

  do {
    const result = await requestPaymentPlans({
      q: marker,
      sortBy,
      sortOrder,
      cursor,
      page: String(page),
      limit: '1'
    })
    assert.equal(result.data.length, 1)
    assert.equal(
      Object.keys(result.data[0]).some((key) => key.startsWith('cursor_')),
      false,
      'las columnas privadas del cursor no deben filtrarse al DTO'
    )
    ids.push(result.data[0].id)

    cursor = result.pagination.nextCursor || undefined
    if (cursor) {
      assert.equal(seenCursors.has(cursor), false, 'el cursor debe avanzar en cada página')
      seenCursors.add(cursor)
      cursorPayloads.push(decodeCursor(cursor))
      page += 1
      assert.ok(page <= 10, 'el recorrido no debe entrar en un ciclo')
    }
  } while (cursor)

  return { ids, cursorPayloads }
}

test.before(async () => {
  if (databaseDialect !== 'sqlite') return
  await db.exec(await readFile(
    new URL('../migrations/versioned/071_payment_lists_cursor_summary.sqlite.sql', import.meta.url),
    'utf8'
  ))
})

test('suscripciones recorre timestamps, nulos y empates sin saltos en ASC y DESC', async () => {
  const marker = `subscription_cursor_precision_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const id = (suffix) => `${marker}_${suffix}`
  const rows = [
    ['a', '2098-04-01T12:00:00.123456Z', '2098-04-02T12:00:00.123451Z', '2098-04-02T12:00:00.123451Z'],
    ['b', '2098-04-01T12:00:00.123456Z', '2098-04-02T12:00:00.123451Z', '2098-04-02T12:00:00.123451Z'],
    ['c', '2098-04-01T12:00:00.123456Z', '2098-04-02T12:00:00.123452Z', '2098-04-02T12:00:00.123452Z'],
    ['d', '2098-04-01T12:00:00.123457Z', '2098-04-02T12:00:00.123450Z', '2098-04-02T12:00:00.123450Z'],
    ['e', null, '2098-04-02T12:00:00.123453Z', '2098-04-02T12:00:00.123453Z'],
    ['f', null, null, null]
  ]

  try {
    for (const [suffix, nextRunAt, createdAt, updatedAt] of rows) {
      await db.run(
        `INSERT INTO subscriptions (
          id, name, description, status, amount, currency, interval_type, interval_count,
          next_run_at, payment_method, payment_provider, payment_mode, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', 10, 'USD', 'monthly', 1, ?, 'manual', 'manual', 'live', ?, ?)`,
        [id(suffix), `Cursor ${marker} ${suffix}`, marker, nextRunAt, createdAt, updatedAt]
      )
    }

    const asc = await collectSubscriptionIds({ marker, sortOrder: 'asc' })
    const desc = await collectSubscriptionIds({ marker, sortOrder: 'desc' })

    assert.deepEqual(asc.ids, ['a', 'b', 'c', 'd', 'f', 'e'].map(id))
    assert.deepEqual(desc.ids, ['e', 'f', 'd', 'c', 'b', 'a'].map(id))
    assert.match(String(asc.cursorPayloads[0].sortValue), /\.123456/)
    assert.match(String(asc.cursorPayloads[0].tieValue), /\.123451/)
    assert.equal(asc.cursorPayloads[0].scope, scopeHash({
      status: '',
      search: marker.toLowerCase().slice(0, 200),
      sortBy: 'nextRunAt',
      sortOrder: 'ASC'
    }))
  } finally {
    await db.run('DELETE FROM subscriptions WHERE id LIKE ?', [`${marker}%`]).catch(() => undefined)
  }
})

test('planes de pago recorre sort numérico y timestamp con nulos, empates y ambos sentidos', async () => {
  const marker = `payment_plan_cursor_precision_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const id = (suffix) => `${marker}_${suffix}`
  const rows = [
    ['a', 10, '2098-05-01T12:00:00.223456Z', '2098-05-01T12:00:00.223451Z', '2098-05-01T12:00:00.223451Z'],
    ['b', 10, '2098-05-01T12:00:00.223456Z', '2098-05-01T12:00:00.223451Z', '2098-05-01T12:00:00.223451Z'],
    ['c', 10, '2098-05-01T12:00:00.223456Z', '2098-05-01T12:00:00.223452Z', '2098-05-01T12:00:00.223452Z'],
    ['d', 20, '2098-05-01T12:00:00.223457Z', '2098-05-01T12:00:00.223450Z', '2098-05-01T12:00:00.223450Z'],
    ['e', null, null, '2098-05-01T12:00:00.223453Z', '2098-05-01T12:00:00.223453Z'],
    ['f', null, null, null, null]
  ]

  try {
    for (const [suffix, total, startDate, nextRunAt, updatedAt] of rows) {
      await db.run(
        `INSERT INTO payment_plans (
          id, name, title, status, total, currency, description, start_date, next_run_at,
          source, raw_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, 'USD', ?, ?, ?, 'cursor_test', '{}', ?, ?)`,
        [
          id(suffix),
          `Cursor ${marker} ${suffix}`,
          `Cursor ${marker} ${suffix}`,
          total,
          marker,
          startDate,
          nextRunAt,
          updatedAt,
          updatedAt
        ]
      )
    }

    const totalAsc = await collectPaymentPlanIds({ marker, sortBy: 'total', sortOrder: 'ASC' })
    const totalDesc = await collectPaymentPlanIds({ marker, sortBy: 'total', sortOrder: 'DESC' })
    const startAsc = await collectPaymentPlanIds({ marker, sortBy: 'startDate', sortOrder: 'ASC' })
    const startDesc = await collectPaymentPlanIds({ marker, sortBy: 'startDate', sortOrder: 'DESC' })

    assert.deepEqual(totalAsc.ids, ['a', 'b', 'c', 'd', 'f', 'e'].map(id))
    assert.deepEqual(totalDesc.ids, ['e', 'f', 'd', 'c', 'b', 'a'].map(id))
    assert.deepEqual(startAsc.ids, ['f', 'e', 'a', 'b', 'c', 'd'].map(id))
    assert.deepEqual(startDesc.ids, ['d', 'c', 'b', 'a', 'e', 'f'].map(id))
    assert.equal(typeof totalAsc.cursorPayloads[0].sortValue, 'number')
    assert.match(String(startDesc.cursorPayloads[0].sortValue), /\.223457/)
    assert.match(String(startDesc.cursorPayloads[0].fallbackValue), /\.223450/)
    assert.equal(startDesc.cursorPayloads[0].scope, scopeHash({
      activeOnly: false,
      source: '',
      search: marker.toLowerCase().slice(0, 160),
      statuses: [],
      sortBy: 'startDate',
      sortOrder: 'DESC'
    }))
  } finally {
    await db.run('DELETE FROM payment_plans WHERE id LIKE ?', [`${marker}%`]).catch(() => undefined)
  }
})

test('PostgreSQL proyecta timestamps lossless sin convertir sort numérico o DTOs', async () => {
  const [subscriptionsSource, paymentPlansSource] = await Promise.all([
    readFile(new URL('../src/services/subscriptionsService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/controllers/highlevelController.js', import.meta.url), 'utf8')
  ])

  assert.match(subscriptionsSource, /databaseDialect === 'postgres' && timestamp[\s\S]*?\$\{sortExpression\}\)::text/)
  assert.match(subscriptionsSource, /TIMESTAMP '1970-01-01 00:00:00'/)
  assert.match(subscriptionsSource, /COALESCE\(updated_at, created_at, \$\{subscriptionTimestampFallbackExpression\(\)\}\)/)
  assert.match(subscriptionsSource, /\$\{sortCursorProjection\} AS cursor_sort_value/)
  assert.match(subscriptionsSource, /\$\{tieCursorProjection\} AS cursor_tie_value/)
  assert.match(subscriptionsSource, /ORDER BY[\s\S]*?\$\{requestedSortColumn\}[\s\S]*?\$\{tieSortExpression\}/)

  assert.match(paymentPlansSource, /databaseDialect === 'postgres' && timestamp[\s\S]*?\$\{sortExpression\}\)::text/)
  assert.match(paymentPlansSource, /TIMESTAMP '1970-01-01 00:00:00'/)
  assert.match(paymentPlansSource, /total: \{ expression: 'payment_plans\.total', timestamp: false \}/)
  assert.match(paymentPlansSource, /\$\{sortCursorProjection\} AS cursor_sort_value/)
  assert.match(paymentPlansSource, /\$\{fallbackCursorProjection\} AS cursor_fallback_value/)
  assert.match(paymentPlansSource, /ORDER BY \$\{nullRankExpression\}[\s\S]*?\$\{sortExpression\}[\s\S]*?\$\{fallbackSortExpression\}/)
})
