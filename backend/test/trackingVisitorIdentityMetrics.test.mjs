import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { databaseDialect, db } from '../src/config/database.js'
import {
  getVisitorsByAd,
  getVisitorsByPeriod,
  getVisitorsList
} from '../src/controllers/trackingController.js'
import { buildReportMetrics } from '../src/services/analyticsService.js'
import { runTrackingVisitorProjectionBackfill } from '../src/services/trackingVisitorProjectionService.js'

async function ensureVisitorProjectionMigration() {
  if (databaseDialect !== 'sqlite') return
  const columns = await db.all("PRAGMA table_info('sessions')")
  if (!columns.some(column => column.name === 'visitor_projection_version')) {
    await db.exec(await readFile(new URL('../migrations/versioned/080_tracking_visitor_projection.sqlite.sql', import.meta.url), 'utf8'))
  }
  const stateColumns = await db.all("PRAGMA table_info('tracking_visitor_projection_state')")
  if (!stateColumns.length) {
    await db.exec(await readFile(new URL('../migrations/versioned/111_tracking_visitor_projection_state.sqlite.sql', import.meta.url), 'utf8'))
  }
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return payload
    }
  }
}

async function callController(handler, query) {
  const response = createResponse()
  await handler({ query }, response)
  assert.equal(response.statusCode, 200)
  return response.body
}

test('tracking visitor reports deduplicate the same contact across visitor ids', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const date = '2099-04-09'
  const createdAt = `${date}T18:00:00.000Z`
  const contactId = `contact_visitor_identity_${suffix}`
  const adId = `ad_visitor_identity_${suffix}`
  const appointmentId = `appt_visitor_identity_${suffix}`

  try {
    await ensureVisitorProjectionMigration()
    await runTrackingVisitorProjectionBackfill({ batchSize: 200, maxBatches: 100, yieldMs: 0 })

    await db.run(`
      INSERT INTO contacts (
        id,
        email,
        full_name,
        visitor_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      `visitor-identity-${suffix}@local.invalid`,
      'Visitante Unificado',
      `visitor_${suffix}_old`,
      createdAt,
      createdAt
    ])

    await db.run(`
      INSERT INTO appointments (
        id,
        contact_id,
        title,
        status,
        appointment_status,
        start_time,
        date_added
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      appointmentId,
      contactId,
      'Cita identidad',
      'confirmed',
      'confirmed',
      createdAt,
      createdAt
    ])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        contact_id,
        event_name,
        started_at,
        created_at,
        ad_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [`session_${suffix}_old`, `visitor_${suffix}_old`, contactId, 'page_view', createdAt, createdAt, adId])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        contact_id,
        event_name,
        started_at,
        created_at,
        ad_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [`session_${suffix}_new`, `visitor_${suffix}_new`, contactId, 'page_view', createdAt, createdAt, adId])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        event_name,
        started_at,
        created_at,
        ad_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [`session_${suffix}_anonymous`, `visitor_${suffix}_anonymous`, 'page_view', createdAt, createdAt, adId])

    const visitorsByAd = await callController(getVisitorsByAd, { startDate: date, endDate: date })
    assert.equal(visitorsByAd.data[adId].uniqueVisitors, 2)
    assert.equal(visitorsByAd.data[adId].totalPageviews, 3)

    const visitorsByPeriod = await callController(getVisitorsByPeriod, { startDate: date, endDate: date, groupBy: 'day', scope: 'all' })
    assert.equal(visitorsByPeriod.data[date], 2)

    const visitorsList = await callController(getVisitorsList, { startDate: date, endDate: date, ad_id: adId, scope: 'all' })
    assert.equal(visitorsList.data.length, 2)
    assert.equal(visitorsList.data.filter(visitor => visitor.contactId === contactId).length, 1)

    const report = await buildReportMetrics({ startDate: date, endDate: date, groupBy: 'day', scope: 'all' })
    const bucket = report.metrics.find(item => item.date === date)
    assert.equal(bucket?.visitors, 2)
  } finally {
    await db.run('DELETE FROM sessions WHERE session_id LIKE ?', [`session_${suffix}%`]).catch(() => undefined)
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
