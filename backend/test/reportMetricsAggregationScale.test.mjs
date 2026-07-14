import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

import { databaseDialect, db } from '../src/config/database.js'
import { buildAggregatedReportMetrics } from '../src/services/reportMetricsAggregationService.js'
import { invalidateTimezoneCache } from '../src/utils/dateUtils.js'

const serviceSourceUrl = new URL('../src/services/reportMetricsAggregationService.js', import.meta.url)
const controllerSourceUrl = new URL('../src/controllers/reportsController.js', import.meta.url)

test('Reportes usa agregados SQL locales y no el constructor histórico en memoria', async () => {
  const [serviceSource, controllerSource] = await Promise.all([
    readFile(serviceSourceUrl, 'utf8'),
    readFile(controllerSourceUrl, 'utf8')
  ])

  assert.match(controllerSource, /buildAggregatedReportMetrics/)
  assert.doesNotMatch(controllerSource, /buildReportMetrics/)
  assert.match(serviceSource, /runBoundedQueryTasks\(\[/)
  assert.match(serviceSource, /concurrency = 2/)
  assert.match(serviceSource, /COUNT\(DISTINCT/)
  assert.doesNotMatch(serviceSource, /getContactsWithAppointmentsHybrid|getContactsWithShowedAppointmentsHybrid|loadAppointmentsFromAPI/)
  assert.doesNotMatch(serviceSource, /\bfetch\s*\(/)
})

test('SQLite conserva fechas heterogéneas, fallback de estado, DST y dedupe sin rango', {
  skip: databaseDialect !== 'sqlite'
}, async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const contactIds = [
    `report-edge-a-${suffix}`,
    `report-edge-b-${suffix}`,
    `report-edge-dedupe-a-${suffix}`,
    `report-edge-dedupe-b-${suffix}`,
    `report-edge-transition-${suffix}`
  ]
  const appointmentIds = [`report-edge-apt-a-${suffix}`, `report-edge-apt-b-${suffix}`]
  const paymentId = `report-edge-payment-${suffix}`
  const sessionRowId = randomUUID()
  const adAccountId = `report-edge-ad-account-${suffix}`
  const previousTimezone = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    ['account_timezone']
  )
  const createdAt = '2026-01-02T04:30:00.000Z'
  const appointmentAt = '2026-01-01T18:00:00.000Z'

  try {
    await db.run(`
      INSERT INTO app_config (config_key, config_value, updated_at)
      VALUES ('account_timezone', 'America/New_York', CURRENT_TIMESTAMP)
      ON CONFLICT(config_key) DO UPDATE SET
        config_value = excluded.config_value,
        updated_at = CURRENT_TIMESTAMP
    `)
    invalidateTimezoneCache()

    await db.run(`
      INSERT INTO contacts (id, phone, full_name, created_at, updated_at)
      VALUES
        (?, ?, 'Persona DST A', ?, ?),
        (?, ?, 'Persona DST B', ?, ?),
        (?, ?, 'Persona dedupe A', ?, ?),
        (?, ?, 'Persona dedupe B', ?, ?)
    `, [
      contactIds[0], '5551111111', createdAt, createdAt,
      contactIds[1], '5552222222', createdAt, createdAt,
      contactIds[2], '555\t123\u00a04567', createdAt, createdAt,
      contactIds[3], '5551234567', createdAt, createdAt
    ])

    await db.run(`
      INSERT INTO appointments (
        id, contact_id, title, status, appointment_status, start_time, date_added
      ) VALUES (?, ?, 'Cancelada', 'cancelled', '', ?, ?)
    `, [appointmentIds[0], contactIds[0], appointmentAt, '2026-01-01 18:00:00'])
    await db.run(`
      INSERT INTO appointments (
        id, contact_id, title, status, appointment_status, start_time, date_added
      ) VALUES (?, ?, 'Asistida', 'showed', '', ?, ?)
    `, [appointmentIds[1], contactIds[1], appointmentAt, Date.parse(appointmentAt)])

    await db.run(`
      INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        date, created_at, updated_at
      ) VALUES (?, ?, 42, 'MXN', 'succeeded', 'card', 'live', ?, ?, ?)
    `, [paymentId, contactIds[0], appointmentAt, appointmentAt, appointmentAt])
    await db.run(`
      INSERT INTO sessions (
        id, session_id, visitor_id, contact_id, event_name, started_at, created_at
      ) VALUES (?, ?, ?, ?, 'page_view', ?, ?)
    `, [sessionRowId, `report-edge-session-${suffix}`, `report-edge-visitor-${suffix}`, contactIds[0], appointmentAt, appointmentAt])
    await db.run(`
      INSERT INTO meta_ads (
        date, ad_account_id, campaign_id, campaign_name, adset_id, adset_name,
        ad_id, ad_name, spend, reach, clicks
      ) VALUES ('2026-01-01', ?, ?, 'Edge', ?, 'Edge', ?, 'Edge', 10, 100, 5)
    `, [adAccountId, `report-edge-campaign-${suffix}`, `report-edge-adset-${suffix}`, `report-edge-ad-${suffix}`])

    const ranged = await buildAggregatedReportMetrics({
      startDate: '2026-01-01',
      endDate: '2026-01-01',
      groupBy: 'day',
      scope: 'all'
    })
    const rangedBucket = ranged.metrics.find(row => row.date === '2026-01-01')
    assert.ok(rangedBucket)
    assert.equal(rangedBucket.leads, 3)
    assert.equal(rangedBucket.appointments, 2)

    const attribution = await buildAggregatedReportMetrics({
      startDate: '2026-01-01',
      endDate: '2026-01-01',
      groupBy: 'day',
      scope: 'attribution'
    })
    const attributionBucket = attribution.metrics.find(row => row.date === '2026-01-01')
    assert.ok(attributionBucket)
    assert.equal(attributionBucket.appointments, 1)
    assert.equal(attributionBucket.attendances, 1)

    const allHistory = await buildAggregatedReportMetrics({ groupBy: 'day', scope: 'all' })
    const historicalBucket = allHistory.metrics.find(row => row.date === '2026-01-01')
    assert.ok(historicalBucket)
    assert.equal(historicalBucket.leads, 3)
    assert.equal(historicalBucket.appointments, 2)
    assert.equal(historicalBucket.sales, 1)
    assert.equal(historicalBucket.revenue, 42)
    assert.equal(historicalBucket.new_customers, 1)
    assert.equal(historicalBucket.visitors, 1)
    assert.equal(historicalBucket.spend, 10)

    await db.run(
      "UPDATE app_config SET config_value = 'America/Godthab', updated_at = CURRENT_TIMESTAMP WHERE config_key = 'account_timezone'"
    )
    invalidateTimezoneCache()
    await db.run(`
      INSERT INTO contacts (id, full_name, created_at, updated_at)
      VALUES (?, 'Transición DST exacta', '2026-03-29T01:00:00.000Z', '2026-03-29T01:00:00.000Z')
    `, [contactIds[4]])

    const transitionRange = await buildAggregatedReportMetrics({
      startDate: '2026-03-29',
      endDate: '2026-03-29',
      groupBy: 'day',
      scope: 'all'
    })
    assert.equal(transitionRange.metrics.find(row => row.date === '2026-03-29')?.leads, 1)
    assert.equal(transitionRange.metrics.some(row => row.date === '2026-03-28'), false)
  } finally {
    await db.run('DELETE FROM meta_ads WHERE ad_account_id = ?', [adAccountId]).catch(() => undefined)
    await db.run('DELETE FROM sessions WHERE id = ?', [sessionRowId]).catch(() => undefined)
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => undefined)
    for (const id of appointmentIds) await db.run('DELETE FROM appointments WHERE id = ?', [id]).catch(() => undefined)
    for (const id of contactIds) await db.run('DELETE FROM contacts WHERE id = ?', [id]).catch(() => undefined)
    if (previousTimezone?.config_value) {
      await db.run(
        'UPDATE app_config SET config_value = ?, updated_at = CURRENT_TIMESTAMP WHERE config_key = ?',
        [previousTimezone.config_value, 'account_timezone']
      )
    } else {
      await db.run('DELETE FROM app_config WHERE config_key = ?', ['account_timezone'])
    }
    invalidateTimezoneCache()
  }
})

test('agrega métricas y deduplica personas sin sacar historiales de la base', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const date = '2097-08-19'
  const createdAt = `${date}T18:00:00.000Z`
  const contactIds = [`report-a-${suffix}`, `report-b-${suffix}`, `report-c-${suffix}`]
  const paymentIds = [`report-pay-a-${suffix}`, `report-pay-b-${suffix}`]
  const appointmentIds = [`report-apt-a-${suffix}`, `report-apt-b-${suffix}`]
  const sessionIds = [`report-session-a-${suffix}`, `report-session-b-${suffix}`, `report-session-c-${suffix}`]
  const sessionRowIds = sessionIds.map(() => randomUUID())
  const attendanceId = `report-attendance-${suffix}`
  const accountId = `report-account-${suffix}`

  try {
    await db.run(`
      INSERT INTO contacts (
        id, email, phone, full_name, purchases_count, total_paid, created_at, updated_at
      ) VALUES
        (?, ?, ?, 'Persona duplicada A', 1, 100, ?, ?),
        (?, ?, ?, 'Persona duplicada B', 0, 0, ?, ?),
        (?, ?, ?, 'Persona distinta', 0, 0, ?, ?)
    `, [
      contactIds[0], `same-${suffix}@example.invalid`, '+5211111111111', createdAt, createdAt,
      contactIds[1], `SAME-${suffix}@example.invalid`, '+5212222222222', createdAt, createdAt,
      contactIds[2], `other-${suffix}@example.invalid`, '+5213333333333', createdAt, createdAt
    ])

    for (const [index, contactId] of contactIds.entries()) {
      await db.run(`
        INSERT INTO sessions (
          id, session_id, visitor_id, contact_id, event_name, started_at, created_at
        ) VALUES (?, ?, ?, ?, 'page_view', ?, ?)
      `, [sessionRowIds[index], sessionIds[index], `visitor-${index}-${suffix}`, contactId, createdAt, createdAt])
    }

    for (const [index, contactId] of contactIds.slice(0, 2).entries()) {
      await db.run(`
        INSERT INTO appointments (
          id, contact_id, title, status, appointment_status, start_time, date_added
        ) VALUES (?, ?, 'Cita reporte', 'confirmed', 'confirmed', ?, ?)
      `, [appointmentIds[index], contactId, createdAt, createdAt])
      await db.run(`
        INSERT INTO payments (
          id, contact_id, amount, currency, status, payment_method, payment_mode,
          date, created_at, updated_at
        ) VALUES (?, ?, ?, 'MXN', 'succeeded', 'card', 'live', ?, ?, ?)
      `, [paymentIds[index], contactId, index === 0 ? 100 : 50, createdAt, createdAt, createdAt])
    }

    await db.run(`
      INSERT INTO appointment_attendance_signals (
        id, contact_id, appointment_id, source, first_seen_at, updated_at
      ) VALUES (?, ?, '', 'test', ?, ?)
    `, [attendanceId, contactIds[2], createdAt, createdAt])

    await db.run(`
      INSERT INTO meta_ads (
        date, ad_account_id, campaign_id, campaign_name, adset_id, adset_name,
        ad_id, ad_name, spend, reach, clicks
      ) VALUES (?, ?, ?, 'Reporte', ?, 'Reporte', ?, 'Reporte', 20, 200, 10)
    `, [date, accountId, `report-campaign-${suffix}`, `report-adset-${suffix}`, `report-ad-${suffix}`])

    const all = await buildAggregatedReportMetrics({ startDate: date, endDate: date, groupBy: 'day', scope: 'all' })
    const allBucket = all.metrics.find(row => row.date === date)
    assert.ok(allBucket)
    assert.equal(allBucket.leads, 2)
    assert.equal(allBucket.customers, 1)
    assert.equal(allBucket.appointments, 1)
    assert.equal(allBucket.attendances, 2)
    assert.equal(allBucket.new_customers, 1)
    assert.equal(allBucket.sales, 2)
    assert.equal(allBucket.revenue, 150)
    assert.equal(allBucket.spend, 20)
    assert.equal(allBucket.visitors, 3)
    assert.equal(allBucket.roas, 7.5)
    assert.equal(allBucket.profit, 130)

    const attribution = await buildAggregatedReportMetrics({ startDate: date, endDate: date, groupBy: 'day', scope: 'attribution' })
    const attributionBucket = attribution.metrics.find(row => row.date === date)
    assert.ok(attributionBucket)
    assert.equal(attributionBucket.leads, 2)
    assert.equal(attributionBucket.appointments, 1)
    assert.equal(attributionBucket.attendances, 2)
    assert.equal(attributionBucket.new_customers, 1)
    assert.equal(attributionBucket.sales, 1)
    assert.equal(attributionBucket.revenue, 150)
  } finally {
    await db.run('DELETE FROM meta_ads WHERE ad_account_id = ?', [accountId]).catch(() => undefined)
    await db.run('DELETE FROM appointment_attendance_signals WHERE id = ?', [attendanceId]).catch(() => undefined)
    for (const id of sessionRowIds) await db.run('DELETE FROM sessions WHERE id = ?', [id]).catch(() => undefined)
    for (const id of appointmentIds) await db.run('DELETE FROM appointments WHERE id = ?', [id]).catch(() => undefined)
    for (const id of paymentIds) await db.run('DELETE FROM payments WHERE id = ?', [id]).catch(() => undefined)
    for (const id of contactIds) await db.run('DELETE FROM contacts WHERE id = ?', [id]).catch(() => undefined)
  }
})
