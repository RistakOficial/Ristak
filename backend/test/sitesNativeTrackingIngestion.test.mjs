import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import { createSession } from '../src/services/trackingService.js'

test('native Sites tracking deduplicates event_id atomically and records timestamp correction', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const siteId = `native_tracking_site_${suffix}`
  const sessionId = `native_tracking_session_${suffix}`
  const visitorId = `native_tracking_visitor_${suffix}`
  const eventId = `native_tracking_event_${suffix}`
  const staleClientTimestamp = '2020-01-01T00:00:00.000Z'
  const payload = {
    session_id: sessionId,
    visitor_id: visitorId,
    event_name: 'native_site_view',
    ts: staleClientTimestamp,
    data: {
      event_id: eventId,
      tracking_source: 'native_site',
      site_id: siteId,
      url: `https://example.test/${suffix}`
    },
    ip: '127.0.0.1',
    user_agent: 'Ristak native tracking ingestion test'
  }

  try {
    const first = await createSession(payload)
    const duplicate = await createSession(payload)
    const rows = await db.all(`
      SELECT event_id, started_at, client_started_at, timestamp_adjusted
      FROM sessions
      WHERE event_id = ?
    `, [eventId])

    assert.equal(first.success, true)
    assert.equal(duplicate.success, true)
    assert.equal(duplicate.deduped, true)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].event_id, eventId)
    assert.equal(new Date(rows[0].client_started_at).toISOString(), staleClientTimestamp)
    assert.equal(Number(rows[0].timestamp_adjusted), 1)
    assert.ok(
      Math.abs(Date.now() - new Date(rows[0].started_at).getTime()) < 60_000,
      'el instante canónico debe usar la hora de recepción cuando el reloj del cliente está sesgado'
    )
  } finally {
    await db.run('DELETE FROM tracking_identity_matches WHERE session_id = ?', [sessionId]).catch(() => undefined)
    await db.run('DELETE FROM sessions WHERE event_id = ?', [eventId]).catch(() => undefined)
  }
})
