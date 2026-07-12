import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import { getSessionMetricsByDateRange } from '../src/services/trackingService.js'

test('session metrics deduplicate unique and returning visitors by contact identity', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const contactId = `contact_metrics_${suffix}`
  const inRange = '2026-03-08T18:00:00.000Z'

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, source, created_at, updated_at)
       VALUES (?, 'Contacto metricas', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        contact_id,
        event_name,
        started_at,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [`session_${suffix}_a`, `visitor_${suffix}_old`, contactId, 'page_view', inRange, inRange])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        contact_id,
        event_name,
        started_at,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [`session_${suffix}_b`, `visitor_${suffix}_new`, contactId, 'native_site_view', inRange, inRange])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        event_name,
        started_at,
        created_at
      ) VALUES (?, ?, ?, ?, ?)
    `, [`session_${suffix}_anonymous`, `visitor_${suffix}_anonymous`, 'session_start', inRange, inRange])

    const metrics = await getSessionMetricsByDateRange('2026-03-08', '2026-03-08')

    assert.equal(metrics.pageViews, 3)
    assert.equal(metrics.uniqueVisitors, 2)
    assert.equal(metrics.uniqueSessions, 3)
    assert.equal(metrics.returningUsers, 1)
  } finally {
    await db.run('DELETE FROM sessions WHERE session_id LIKE ?', [`session_${suffix}%`]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
