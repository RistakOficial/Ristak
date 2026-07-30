import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import { collectEvent } from '../src/controllers/trackingController.js'
import { createSession } from '../src/services/trackingService.js'

test('native Sites tracking deduplicates event_id atomically and records timestamp correction', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const siteId = `native_tracking_site_${suffix}`
  const sessionId = `native_tracking_session_${suffix}`
  const visitorId = `native_tracking_visitor_${suffix}`
  const eventId = `native_tracking_event_${suffix}`
  const pageFlowRevision = `page_flow_revision_${suffix}`
  const pageJourneyId = `page_journey_${suffix}`
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
      page_flow_revision: pageFlowRevision,
      page_journey_id: pageJourneyId,
      url: `https://example.test/${suffix}`
    },
    ip: '127.0.0.1',
    user_agent: 'Ristak native tracking ingestion test'
  }

  try {
    const first = await createSession(payload)
    const duplicate = await createSession(payload)
    const rows = await db.all(`
      SELECT
        event_id,
        started_at,
        client_started_at,
        timestamp_adjusted,
        page_flow_revision,
        page_journey_id
      FROM sessions
      WHERE event_id = ?
    `, [eventId])

    assert.equal(first.success, true)
    assert.equal(duplicate.success, true)
    assert.equal(duplicate.deduped, true)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].event_id, eventId)
    assert.equal(rows[0].page_flow_revision, pageFlowRevision)
    assert.equal(rows[0].page_journey_id, pageJourneyId)
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

test('/collect rejects the server-only native_site_conversion event before persisting it', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const sessionId = `public_spoofed_conversion_${suffix}`
  const response = {
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

  await collectEvent({
    headers: { 'content-length': '400', 'user-agent': 'Ristak reserved-event test' },
    body: {
      visitor_id: `visitor_${suffix}`,
      session_id: sessionId,
      event_name: ' Native_Site_Conversion ',
      ts: new Date().toISOString(),
      data: {
        tracking_source: 'native_site',
        submission_id: `submission_${suffix}`
      }
    },
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' }
  }, response)

  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.payload, { error: 'Reserved event name' })
  assert.equal(
    Number((await db.get('SELECT COUNT(*) AS total FROM sessions WHERE session_id = ?', [sessionId]))?.total || 0),
    0
  )
})
