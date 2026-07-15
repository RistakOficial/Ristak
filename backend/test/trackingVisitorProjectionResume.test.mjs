import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { databaseDialect, db } from '../src/config/database.js'
import {
  readTrackingVisitorProjectionState,
  scheduleTrackingVisitorProjectionBackfill,
  TRACKING_VISITOR_PROJECTION_LIMITS
} from '../src/services/trackingVisitorProjectionService.js'

async function ensureProjectionSchema() {
  const columns = await db.all("PRAGMA table_info('sessions')")
  if (!columns.some(column => column.name === 'visitor_projection_version')) {
    await db.exec(await readFile(
      new URL('../migrations/versioned/080_tracking_visitor_projection.sqlite.sql', import.meta.url),
      'utf8'
    ))
  }
  const state = await db.all("PRAGMA table_info('tracking_visitor_projection_state')")
  if (!state.length) {
    await db.exec(await readFile(
      new URL('../migrations/versioned/111_tracking_visitor_projection_state.sqlite.sql', import.meta.url),
      'utf8'
    ))
  }
}

test('el backfill de visitantes se reanuda solo después de ceder, sin GETs ni tráfico', {
  skip: databaseDialect !== 'sqlite',
  timeout: 15_000
}, async () => {
  await ensureProjectionSchema()
  const prefix = `visitor-auto-resume-${process.pid}-${Date.now()}-`

  try {
    await db.run(`
      WITH RECURSIVE sequence(n) AS (
        SELECT 1
        UNION ALL
        SELECT n + 1 FROM sequence WHERE n < 2200
      )
      INSERT INTO sessions (
        id, session_id, visitor_id, event_name, started_at, created_at
      )
      SELECT
        ? || printf('%04d', n),
        'session-' || ? || printf('%04d', n),
        'visitor-' || ? || printf('%04d', n),
        'page_view',
        datetime('2098-03-01T00:00:00.000Z', '+' || n || ' seconds'),
        datetime('2098-03-01T00:00:00.000Z', '+' || n || ' seconds')
      FROM sequence
    `, [prefix, prefix, prefix])
    await db.run(
      'UPDATE sessions SET visitor_key = NULL, visitor_projection_version = 0 WHERE id LIKE ?',
      [`${prefix}%`]
    )
    await db.run(`
      UPDATE tracking_visitor_projection_state
      SET status = 'backfilling', updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = 1
    `)

    const queued = scheduleTrackingVisitorProjectionBackfill()
    assert.equal(queued.scheduled, true)

    const deadline = Date.now() + 10_000
    let state = await readTrackingVisitorProjectionState()
    while (state?.status !== 'ready' && Date.now() < deadline) {
      // Sólo observamos el singleton. No se vuelve a llamar schedule ni a un GET
      // de producto: la segunda corrida debe venir del one-shot interno.
      await new Promise(resolve => setTimeout(resolve, 50))
      state = await readTrackingVisitorProjectionState()
    }

    assert.equal(state?.status, 'ready')
    assert.equal(Number((await db.get(`
      SELECT COUNT(*) AS total
      FROM sessions
      WHERE id LIKE ? AND visitor_projection_version < 3
    `, [`${prefix}%`]))?.total || 0), 0)
    assert.equal(TRACKING_VISITOR_PROJECTION_LIMITS.resumesWithoutTraffic, true)
    assert.ok(TRACKING_VISITOR_PROJECTION_LIMITS.pauseMs <= 1_000)
  } finally {
    await db.run('DELETE FROM sessions WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
    await db.run(`
      UPDATE tracking_visitor_projection_state
      SET status = 'ready', last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = 1
    `).catch(() => undefined)
  }
})
