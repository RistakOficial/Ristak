import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import { buildContactsList, buildContactStats, buildReportMetrics } from '../src/services/analyticsService.js'

async function cleanupContact(contactId) {
  await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId])
  await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId])
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
}

async function withAppConfigKeyCleared(configKey, callback) {
  const rows = await db.all('SELECT * FROM app_config WHERE config_key = ?', [configKey]).catch(() => [])

  await db.run('DELETE FROM app_config WHERE config_key = ?', [configKey])
  try {
    return await callback()
  } finally {
    await db.run('DELETE FROM app_config WHERE config_key = ?', [configKey]).catch(() => undefined)
    for (const row of rows) {
      const columns = Object.keys(row)
      if (!columns.length) continue
      const quotedColumns = columns.map(column => `"${String(column).replace(/"/g, '""')}"`).join(', ')
      const placeholders = columns.map(() => '?').join(', ')
      await db.run(
        `INSERT INTO app_config (${quotedColumns}) VALUES (${placeholders})`,
        columns.map(column => row[column])
      ).catch(() => undefined)
    }
  }
}

async function withHighLevelConfigCleared(callback) {
  const columns = await db.all('PRAGMA table_info(highlevel_config)')
  const columnNames = columns.map(column => column.name).filter(Boolean)
  const rows = columnNames.length ? await db.all('SELECT * FROM highlevel_config') : []

  await db.run('DELETE FROM highlevel_config')
  try {
    return await callback()
  } finally {
    await db.run('DELETE FROM highlevel_config').catch(() => undefined)
    for (const row of rows) {
      const placeholders = columnNames.map(() => '?').join(', ')
      const quotedColumns = columnNames.map(column => `"${String(column).replace(/"/g, '""')}"`).join(', ')
      await db.run(
        `INSERT INTO highlevel_config (${quotedColumns}) VALUES (${placeholders})`,
        columnNames.map(column => row[column])
      ).catch(() => undefined)
    }
  }
}

test('sales list in all scope returns only payments inside the selected range', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const contactId = `range-payment-contact-${suffix}`
  const inRangePaymentId = `range-payment-in-${suffix}`
  const outsideRangePaymentId = `range-payment-out-${suffix}`
  const createdAt = '2026-06-10T18:00:00.000Z'

  await cleanupContact(contactId)

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, email, full_name, total_paid, purchases_count, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      `+521${String(Date.now()).slice(-10)}`,
      `range-payment-${suffix}@local.invalid`,
      'Contacto Pago Por Fecha',
      3000,
      2,
      createdAt,
      createdAt
    ])

    await db.run(`
      INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode, date, created_at, updated_at
      )
      VALUES (?, ?, ?, 'MXN', 'succeeded', 'card', 'live', ?, ?, ?)
    `, [
      inRangePaymentId,
      contactId,
      1200,
      '2026-06-10T18:00:00.000Z',
      '2026-06-10T18:00:00.000Z',
      '2026-06-10T18:00:00.000Z'
    ])

    await db.run(`
      INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode, date, created_at, updated_at
      )
      VALUES (?, ?, ?, 'MXN', 'succeeded', 'card', 'live', ?, ?, ?)
    `, [
      outsideRangePaymentId,
      contactId,
      1800,
      '2026-06-11T18:00:00.000Z',
      '2026-06-11T18:00:00.000Z',
      '2026-06-11T18:00:00.000Z'
    ])

    const allScopeResult = await buildContactsList({
      startDate: '2026-06-10',
      endDate: '2026-06-10',
      type: 'sales',
      scope: 'all'
    })

    const allScopeContact = allScopeResult.contacts.find(contact => contact.id === contactId)
    assert.ok(allScopeContact)
    assert.equal(allScopeContact.ltv, 1200)
    assert.equal(allScopeContact.purchases, 1)
    assert.deepEqual(allScopeContact.payments.map(payment => payment.id), [inRangePaymentId])
    assert.equal(allScopeContact.lifetimeLtv, 3000)
    assert.equal(allScopeContact.lifetimePurchases, 2)

    const attributionResult = await buildContactsList({
      startDate: '2026-06-10',
      endDate: '2026-06-10',
      type: 'sales',
      scope: 'attribution'
    })

    const attributionContact = attributionResult.contacts.find(contact => contact.id === contactId)
    assert.ok(attributionContact)
    assert.equal(attributionContact.ltv, 3000)
    assert.equal(attributionContact.purchases, 2)
    assert.deepEqual(
      attributionContact.payments.map(payment => payment.id).sort(),
      [inRangePaymentId, outsideRangePaymentId].sort()
    )
  } finally {
    await cleanupContact(contactId)
  }
})

test('appointment attribution uses local Ristak appointments without HighLevel configured', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const date = '2099-07-15'
  const createdAt = `${date}T18:00:00.000Z`
  const contactId = `local-appointment-contact-${suffix}`
  const appointmentId = `local-appointment-${suffix}`

  await cleanupContact(contactId)

  try {
    await withAppConfigKeyCleared('attribution_calendar_ids', async () => withHighLevelConfigCleared(async () => {
      await db.run(`
        INSERT INTO contacts (
          id, phone, email, full_name, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        contactId,
        `+521${String(Date.now()).slice(-10)}`,
        `local-appointment-${suffix}@local.invalid`,
        'Contacto Cita Local',
        createdAt,
        createdAt
      ])

      await db.run(`
        INSERT INTO appointments (
          id, contact_id, title, status, appointment_status, start_time, date_added
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        appointmentId,
        contactId,
        'Cita local sin GHL',
        'confirmed',
        'confirmed',
        createdAt,
        createdAt
      ])

      const contactsResult = await buildContactsList({
        startDate: date,
        endDate: date,
        type: 'appointments',
        scope: 'attribution'
      })
      assert.ok(contactsResult.contacts.some(contact => contact.id === contactId))

      const report = await buildReportMetrics({
        startDate: date,
        endDate: date,
        groupBy: 'day',
        scope: 'attribution'
      })
      const bucket = report.metrics.find(item => item.date === date)
      assert.equal(bucket?.appointments, 1)
    }))
  } finally {
    await cleanupContact(contactId)
  }
})

test('contact stats honors contact list search, quick filter and date range', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const matchingContactId = `stats-filter-match-${suffix}`
  const leadContactId = `stats-filter-lead-${suffix}`
  const otherCustomerId = `stats-filter-other-${suffix}`
  const matchingPaymentId = `stats-filter-payment-match-${suffix}`
  const otherPaymentId = `stats-filter-payment-other-${suffix}`
  const createdAt = '2026-07-01T18:00:00.000Z'

  await Promise.all([
    cleanupContact(matchingContactId),
    cleanupContact(leadContactId),
    cleanupContact(otherCustomerId)
  ])

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, email, full_name, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      matchingContactId,
      `+521${String(Date.now()).slice(-10)}`,
      `ana-stats-match-${suffix}@local.invalid`,
      `Ana Stats Match ${suffix}`,
      createdAt,
      createdAt
    ])

    await db.run(`
      INSERT INTO contacts (
        id, phone, email, full_name, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      leadContactId,
      `+522${String(Date.now()).slice(-10)}`,
      `ana-stats-lead-${suffix}@local.invalid`,
      `Ana Stats Lead ${suffix}`,
      createdAt,
      createdAt
    ])

    await db.run(`
      INSERT INTO contacts (
        id, phone, email, full_name, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      otherCustomerId,
      `+523${String(Date.now()).slice(-10)}`,
      `beto-stats-${suffix}@local.invalid`,
      `Beto Stats ${suffix}`,
      createdAt,
      createdAt
    ])

    await db.run(`
      INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode, date, created_at, updated_at
      )
      VALUES (?, ?, ?, 'MXN', 'succeeded', 'card', 'live', ?, ?, ?)
    `, [
      matchingPaymentId,
      matchingContactId,
      500,
      createdAt,
      createdAt,
      createdAt
    ])

    await db.run(`
      INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode, date, created_at, updated_at
      )
      VALUES (?, ?, ?, 'MXN', 'succeeded', 'card', 'live', ?, ?, ?)
    `, [
      otherPaymentId,
      otherCustomerId,
      900,
      createdAt,
      createdAt,
      createdAt
    ])

    const { metrics } = await buildContactStats({
      startDate: '2026-07-01',
      endDate: '2026-07-01',
      search: `Ana Stats ${suffix}`,
      filter: 'customers'
    })

    assert.equal(metrics.total, 1)
    assert.equal(metrics.customers, 1)
    assert.equal(metrics.ltvTotal, 500)
    assert.equal(metrics.avgLtv, 500)
  } finally {
    await Promise.all([
      cleanupContact(matchingContactId),
      cleanupContact(leadContactId),
      cleanupContact(otherCustomerId)
    ])
  }
})
