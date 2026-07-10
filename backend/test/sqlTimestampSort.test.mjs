import assert from 'node:assert/strict'
import test from 'node:test'

import { db } from '../src/config/database.js'
import {
  coalescedTimestampSortExpression,
  parseSortableTimestamp,
  timestampSortExpression
} from '../src/utils/sqlTimestampSort.js'

const moduleUrl = new URL('../src/utils/sqlTimestampSort.js', import.meta.url)

function placeholderCount(value) {
  return (String(value).match(/\?/g) || []).length
}

test('timestamp sort helpers order contacts, appointments and payments by real time across stored formats', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const contactId = `sort_contact_owner_${suffix}`
  const contactIds = {
    earlyIso: `sort_contact_early_iso_${suffix}`,
    lateSql: `sort_contact_late_sql_${suffix}`,
    middleIso: `sort_contact_middle_iso_${suffix}`
  }
  const appointmentIds = {
    earlyIso: `sort_appointment_early_iso_${suffix}`,
    lateSql: `sort_appointment_late_sql_${suffix}`,
    middleIso: `sort_appointment_middle_iso_${suffix}`
  }
  const paymentIds = {
    earlyIso: `sort_payment_early_iso_${suffix}`,
    lateSql: `sort_payment_late_sql_${suffix}`,
    middleIso: `sort_payment_middle_iso_${suffix}`
  }
  const marker = `sort_timestamp_${suffix}`

  const rows = [
    ['earlyIso', '2099-04-04T17:30:00.000Z', '2099-04-04T17:30:01.000Z'],
    ['lateSql', '2099-04-04 19:00:00', '2099-04-04 19:00:01'],
    ['middleIso', '2099-04-04T18:00:00.000Z', '2099-04-04T18:00:01.000Z']
  ]

  try {
    await db.run(
      'INSERT INTO contacts (id, full_name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [contactId, marker, '2099-04-04T00:00:00.000Z', '2099-04-04T00:00:00.000Z']
    )

    for (const [key, primaryDate, createdAt] of rows) {
      await db.run(
        'INSERT INTO contacts (id, full_name, created_at, updated_at) VALUES (?, ?, ?, ?)',
        [contactIds[key], `${marker}_${key}`, primaryDate, createdAt]
      )
      await db.run(
        `INSERT INTO appointments (id, contact_id, title, start_time, end_time, date_added, date_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [appointmentIds[key], contactId, `${marker}_${key}`, primaryDate, createdAt, createdAt, createdAt]
      )
      await db.run(
        `INSERT INTO payments (
          id, contact_id, amount, currency, status, payment_method, payment_mode,
          payment_provider, reference, title, description, date, created_at, updated_at
        ) VALUES (?, ?, 100, 'MXN', 'paid', 'cash', 'live', 'manual', ?, ?, ?, ?, ?, ?)`,
        [paymentIds[key], contactId, marker, `${marker}_${key}`, `${marker}_${key}`, primaryDate, createdAt, createdAt]
      )
    }

    const sortedContacts = await db.all(
      `SELECT id FROM contacts
       WHERE full_name LIKE ?
       ORDER BY ${timestampSortExpression('created_at')} DESC, id DESC`,
      [`${marker}_%`]
    )
    const sortedAppointments = await db.all(
      `SELECT id FROM appointments
       WHERE title LIKE ?
       ORDER BY ${coalescedTimestampSortExpression('start_time', 'date_added')} DESC, id DESC`,
      [`${marker}_%`]
    )
    const sortedPayments = await db.all(
      `SELECT id FROM payments
       WHERE reference = ?
       ORDER BY ${coalescedTimestampSortExpression('date', 'created_at')} DESC, id DESC`,
      [marker]
    )

    assert.deepEqual(
      sortedContacts.map(row => row.id),
      [contactIds.lateSql, contactIds.middleIso, contactIds.earlyIso]
    )
    assert.deepEqual(
      sortedAppointments.map(row => row.id),
      [appointmentIds.lateSql, appointmentIds.middleIso, appointmentIds.earlyIso]
    )
    assert.deepEqual(
      sortedPayments.map(row => row.id),
      [paymentIds.lateSql, paymentIds.middleIso, paymentIds.earlyIso]
    )
    assert.ok(parseSortableTimestamp('2099-04-04 19:00:00') > parseSortableTimestamp('2099-04-04T18:00:00.000Z'))
  } finally {
    for (const id of Object.values(paymentIds)) {
      await db.run('DELETE FROM payments WHERE id = ?', [id]).catch(() => {})
    }
    for (const id of Object.values(appointmentIds)) {
      await db.run('DELETE FROM appointments WHERE id = ?', [id]).catch(() => {})
    }
    for (const id of [...Object.values(contactIds), contactId]) {
      await db.run('DELETE FROM contacts WHERE id = ?', [id]).catch(() => {})
    }
  }
})

test('timestampSortParameterExpression binds exactly once on SQLite and Postgres', async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL
  try {
    delete process.env.DATABASE_URL
    const sqliteModule = await import(`${moduleUrl.href}?dialect=sqlite-${Date.now()}`)
    const sqliteExpression = sqliteModule.timestampSortParameterExpression()
    assert.equal(placeholderCount(sqliteExpression), 1)
    assert.match(sqliteExpression, /julianday\(\?\)/)

    process.env.DATABASE_URL = 'postgresql://binding-check.invalid/ristak'
    const postgresModule = await import(`${moduleUrl.href}?dialect=postgres-${Date.now()}`)
    const postgresExpression = postgresModule.timestampSortParameterExpression()
    assert.equal(placeholderCount(postgresExpression), 1)
    assert.match(postgresExpression, /EXTRACT\(EPOCH/)
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = originalDatabaseUrl
  }
})
