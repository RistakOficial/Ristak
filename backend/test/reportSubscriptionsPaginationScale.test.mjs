import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { databaseDialect, db } from '../src/config/database.js'
import { listReportContactsPage, REPORT_CONTACTS_PAGE_LIMITS } from '../src/services/reportContactsPaginationService.js'
import { listSubscriptions } from '../src/services/subscriptionsService.js'
import { runContactPersonIdentityProjectionBackfill } from '../src/services/contactPersonIdentityProjectionService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const createdContactIds = []
const createdSubscriptionIds = []

function decodeCursor(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

test.before(async () => {
  await db.exec(fs.readFileSync(
    path.join(projectRoot, 'migrations/versioned/071_payment_lists_cursor_summary.sqlite.sql'),
    'utf8'
  ))
  if (databaseDialect === 'sqlite') {
    await db.exec(fs.readFileSync(
      path.join(projectRoot, 'migrations/versioned/110_contact_person_identity.sqlite.sql'),
      'utf8'
    ))
    await runContactPersonIdentityProjectionBackfill({ batchSize: 500, yieldMs: 0 })
  }
})

test.after(async () => {
  if (createdSubscriptionIds.length > 0) {
    await db.run(
      `DELETE FROM subscriptions WHERE id IN (${createdSubscriptionIds.map(() => '?').join(', ')})`,
      createdSubscriptionIds
    )
  }
  if (createdContactIds.length > 0) {
    await db.run(
      `DELETE FROM contacts WHERE id IN (${createdContactIds.map(() => '?').join(', ')})`,
      createdContactIds
    )
  }
})

test('Reportes pagina por cursor, deduplica personas y sólo devuelve DTOs ligeros', async () => {
  const suffix = `${process.pid}_${Date.now()}`
  for (let index = 0; index < 125; index += 1) {
    const id = `report_scale_${suffix}_${String(index).padStart(3, '0')}`
    createdContactIds.push(id)
    const email = index < 2 ? `identity_${suffix}_${index}` : `person_${suffix}_${index}@example.test`
    const phone = index === 0
      ? '+52 1 555 000 0000'
      : index === 1
        ? '5215550000000'
        : `+521555${String(index).padStart(7, '0')}`
    await db.run(
      `INSERT INTO contacts (
        id, full_name, email, phone, source, total_paid, purchases_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'scale_test', 0, 0, ?, ?)`,
      [
        id,
        `Persona ${String(index).padStart(3, '0')}`,
        email,
        phone,
        `2026-06-${String((index % 28) + 1).padStart(2, '0')}T12:00:00.000Z`,
        `2026-06-${String((index % 28) + 1).padStart(2, '0')}T12:00:00.000Z`
      ]
    )
  }

  const convertedContactId = createdContactIds[124]
  await db.run(
    `INSERT INTO payments (id, contact_id, amount, currency, status, payment_mode, date, created_at, updated_at)
     VALUES (?, ?, 250, 'MXN', 'paid', 'live', '2026-06-20T13:00:00.000Z', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [`report_payment_${suffix}`, convertedContactId]
  )
  await db.run(
    `INSERT INTO appointments (
      id, contact_id, title, status, appointment_status, start_time, end_time, date_added, date_updated
    ) VALUES (?, ?, 'Demo', 'confirmed', 'showed', '2026-06-21T13:00:00.000Z', '2026-06-21T14:00:00.000Z', '2026-06-20T14:00:00.000Z', CURRENT_TIMESTAMP)`,
    [`report_appointment_${suffix}`, convertedContactId]
  )
  await db.run(
    `INSERT INTO appointment_attendance_signals (id, contact_id, appointment_id, source)
     VALUES (?, ?, ?, 'scale_test')`,
    [`report_attendance_${suffix}`, convertedContactId, `report_appointment_${suffix}`]
  )

  const first = await listReportContactsPage({
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    type: 'interesados',
    scope: 'all',
    dedupeByPerson: true,
    limit: 50
  })

  assert.equal(first.contacts.length, 50)
  assert.equal(first.pagination.total, 124)
  assert.equal(first.pagination.totalIsCapped, false)
  assert.equal(first.pagination.hasNext, true)
  assert.ok(first.pagination.nextCursor)
  const scopedCursor = decodeCursor(first.pagination.nextCursor)
  assert.equal(scopedCursor.v, 2)
  assert.equal(scopedCursor.kind, 'report-contacts')
  assert.match(scopedCursor.scope, /^[A-Za-z0-9_-]{40,}$/)
  assert.equal('payments' in first.contacts[0], false)
  assert.equal('appointments' in first.contacts[0], false)
  assert.equal('firstSession' in first.contacts[0], false)

  const second = await listReportContactsPage({
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    type: 'interesados',
    scope: 'all',
    dedupeByPerson: true,
    cursor: first.pagination.nextCursor,
    limit: 50
  })
  const firstIds = new Set(first.contacts.map((contact) => contact.id))
  assert.equal(second.contacts.length, 50)
  assert.equal(second.contacts.some((contact) => firstIds.has(contact.id)), false)

  const legacySecond = await listReportContactsPage({
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    type: 'interesados',
    scope: 'all',
    dedupeByPerson: true,
    cursor: encodeCursor({ createdAt: scopedCursor.createdAt, id: scopedCursor.id }),
    limit: 50
  })
  assert.deepEqual(
    legacySecond.contacts.map(contact => contact.id),
    second.contacts.map(contact => contact.id),
    'el cursor histórico sin versión ni scope debe seguir funcionando'
  )

  for (const changedScope of [
    { endDate: '2026-11-30' },
    { type: 'customers' },
    { scope: 'attribution' },
    { dedupeByPerson: false },
    { search: 'otro alcance' }
  ]) {
    await assert.rejects(
      listReportContactsPage({
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        type: 'interesados',
        scope: 'all',
        dedupeByPerson: true,
        cursor: first.pagination.nextCursor,
        limit: 50,
        ...changedScope
      }),
      error => error?.status === 400 && /ya no corresponde/.test(error.message)
    )
  }

  const search = await listReportContactsPage({
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    type: 'interesados',
    scope: 'all',
    dedupeByPerson: true,
    search: 'Persona 124',
    limit: 50
  })
  assert.equal(search.contacts.length, 1)
  assert.match(search.contacts[0].name, /Persona 124/)

  for (const type of ['customers', 'sales', 'appointments', 'attendances']) {
    const typedPage = await listReportContactsPage({
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      type,
      scope: 'all',
      dedupeByPerson: true,
      search: 'Persona 124',
      limit: 50
    })
    assert.equal(typedPage.contacts.length, 1, `el tipo ${type} debe resolverse en SQL`)
  }
  assert.equal(REPORT_CONTACTS_PAGE_LIMITS.max, 100)
  assert.equal(REPORT_CONTACTS_PAGE_LIMITS.totalCap, 10_000)
})

test('Reportes pagina contactos con created_at nulo sin truncar cursor ni alterar el DTO', async () => {
  if (databaseDialect !== 'sqlite') return
  const suffix = `${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const contactIds = ['a', 'b', 'c'].map(letter => `report_null_cursor_${suffix}_${letter}`)
  const paymentIds = contactIds.map((_, index) => `report_null_cursor_payment_${suffix}_${index}`)

  try {
    for (let index = 0; index < contactIds.length; index += 1) {
      await db.run(`
        INSERT INTO contacts (
          id, full_name, email, source, total_paid, purchases_count, created_at, updated_at
        ) VALUES (?, ?, ?, 'cursor_precision_test', 1, 1, NULL, NULL)
      `, [contactIds[index], `Cursor nulo ${suffix}`, `${contactIds[index]}@example.test`])
      await db.run(`
        INSERT INTO payments (
          id, contact_id, amount, currency, status, payment_mode, date, created_at, updated_at
        ) VALUES (?, ?, 1, 'MXN', 'paid', 'live', '2098-03-20T12:00:00.123456Z',
          '2098-03-20T12:00:00.123456Z', '2098-03-20T12:00:00.123456Z')
      `, [paymentIds[index], contactIds[index]])
    }

    const collected = []
    let cursor
    let pageCount = 0
    do {
      pageCount += 1
      assert.ok(pageCount <= contactIds.length, 'el cursor debe avanzar en cada página')
      const page = await listReportContactsPage({
        startDate: '2098-03-20',
        endDate: '2098-03-20',
        type: 'customers',
        scope: 'all',
        search: suffix,
        cursor,
        limit: 1
      })
      assert.ok(page.contacts.every(contact => contact.created_at === null))
      collected.push(...page.contacts.map(contact => contact.id))
      cursor = page.pagination.nextCursor || undefined
    } while (cursor)

    assert.deepEqual(collected, [...contactIds].sort().reverse())
  } finally {
    for (const id of paymentIds) await db.run('DELETE FROM payments WHERE id = ?', [id]).catch(() => undefined)
    for (const id of contactIds) await db.run('DELETE FROM contacts WHERE id = ?', [id]).catch(() => undefined)
  }
})

test('Suscripciones pagina y filtra en SQL mientras el resumen permanece global', async () => {
  const suffix = `${process.pid}_${Date.now()}`
  for (let index = 0; index < 45; index += 1) {
    const id = `subscription_scale_${suffix}_${String(index).padStart(3, '0')}`
    createdSubscriptionIds.push(id)
    const status = index < 30 ? 'active' : index < 35 ? 'trialing' : 'paused'
    await db.run(
      `INSERT INTO subscriptions (
        id, name, description, status, amount, currency, interval_type, interval_count,
        next_run_at, payment_method, payment_provider, payment_mode, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 100, 'MXN', 'monthly', 1, ?, 'manual', 'manual', 'live', ?, ?)`,
      [
        id,
        `Plan escala ${String(index).padStart(3, '0')}`,
        `Búsqueda única ${suffix}`,
        status,
        `2099-02-${String((index % 28) + 1).padStart(2, '0')}T12:00:00.000Z`,
        `2026-06-${String((index % 28) + 1).padStart(2, '0')}T12:00:00.000Z`,
        `2026-06-${String((index % 28) + 1).padStart(2, '0')}T12:00:00.000Z`
      ]
    )
  }

  const first = await listSubscriptions({
    status: 'active',
    search: suffix,
    page: 1,
    limit: 20,
    sortBy: 'name',
    sortOrder: 'asc'
  })
  assert.equal(first.subscriptions.length, 20)
  assert.equal(first.pagination.total, null)
  assert.equal(first.pagination.totalPages, null)
  assert.equal(first.pagination.hasNext, true)
  assert.ok(first.pagination.nextCursor)

  const second = await listSubscriptions({
    status: 'active',
    search: suffix,
    page: 2,
    cursor: first.pagination.nextCursor,
    limit: 20,
    sortBy: 'name',
    sortOrder: 'asc'
  })
  assert.equal(second.subscriptions.length, 15)
  assert.equal(second.pagination.hasPrev, true)
  assert.ok(first.summary.active >= 35)
  assert.ok(first.summary.paused >= 10)
  assert.ok(first.summary.monthlyRevenue >= 3500)

  const byId = await listSubscriptions({
    search: createdSubscriptionIds[createdSubscriptionIds.length - 1],
    page: 1,
    limit: 20
  })
  assert.equal(byId.pagination.total, null)
  assert.equal(byId.subscriptions[0]?.id, createdSubscriptionIds[createdSubscriptionIds.length - 1])
})

test('Contrato de escala evita descargas completas y refrescos externos por eventos vivos', () => {
  const reportBackend = fs.readFileSync(
    path.join(projectRoot, 'src/services/reportContactsPaginationService.js'),
    'utf8'
  )
  const subscriptionBackend = fs.readFileSync(
    path.join(projectRoot, 'src/services/subscriptionsService.js'),
    'utf8'
  )
  const reportFrontend = fs.readFileSync(
    path.join(projectRoot, '../frontend/src/pages/Reports/Reports.tsx'),
    'utf8'
  )
  const subscriptionFrontend = fs.readFileSync(
    path.join(projectRoot, '../frontend/src/pages/Transactions/PaymentSubscriptions.tsx'),
    'utf8'
  )
  const subscriptionAgentTool = fs.readFileSync(
    path.join(projectRoot, 'src/agents/tools/paymentFlowTools.js'),
    'utf8'
  )

  assert.match(reportBackend, /LIMIT \?/)
  assert.match(reportBackend, /TOTAL_COUNT_CAP = 10_000/)
  assert.doesNotMatch(reportBackend, /contactIds\.map\(\(\) => '\?'\)/)
  assert.match(reportFrontend, /onSelectContact=\{hydrateReportContact\}/)
  assert.match(reportFrontend, /nextCursor/)

  assert.match(subscriptionBackend, /SELECT\s+COUNT\(\*\) AS total[\s\S]*SUM\(CASE/)
  assert.match(subscriptionBackend, /nextCursor/)
  assert.match(subscriptionBackend, /LIMIT \?/)
  assert.doesNotMatch(subscriptionBackend, /LIMIT \? OFFSET \?/)
  assert.match(subscriptionFrontend, /serverSidePagination/)
  assert.match(subscriptionFrontend, /cursorPagination/)
  assert.match(subscriptionFrontend, /subscriptionCursorStackRef/)
  assert.match(subscriptionFrontend, /serverSideSearch/)
  assert.match(subscriptionFrontend, /loadSubscriptionsRef\.current\(\{ refresh: false \}\)/)
  assert.match(subscriptionAgentTool, /name: 'list_subscriptions'[\s\S]*search: z\.string\(\)[\s\S]*page: z\.number\(\)[\s\S]*cursor: z\.string\(\)[\s\S]*limit: z\.number\(\)/)
  assert.match(subscriptionAgentTool, /listSubscriptions\(\{[\s\S]*search: search \|\| ''[\s\S]*page: page \|\| 1[\s\S]*cursor: cursor \|\| undefined/)
})
