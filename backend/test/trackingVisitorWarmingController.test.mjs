import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { databaseDialect, db } from '../src/config/database.js'
import { getVisitorsList } from '../src/controllers/trackingController.js'
import { readTrackingVisitorProjectionState } from '../src/services/trackingVisitorProjectionService.js'

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

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value)
    },
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

test('visitors responde warming explícito y reintentable en vez de ejecutar el fallback histórico', {
  skip: databaseDialect !== 'sqlite',
  timeout: 15_000
}, async () => {
  await ensureProjectionSchema()
  const id = `visitor-warming-controller-${process.pid}-${Date.now()}`
  try {
    await db.run(`
      INSERT INTO sessions (id, session_id, visitor_id, event_name, started_at, created_at)
      VALUES (?, ?, ?, 'page_view', '2098-04-02T12:00:00.000Z', '2098-04-02T12:00:00.000Z')
    `, [id, `session-${id}`, `visitor-${id}`])
    await db.run(
      'UPDATE sessions SET visitor_key = NULL, visitor_projection_version = 0 WHERE id = ?',
      [id]
    )
    await db.run(`
      UPDATE tracking_visitor_projection_state
      SET status = 'backfilling', updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = 1
    `)

    const response = createResponse()
    await getVisitorsList({
      query: {
        startDate: '2098-04-02',
        endDate: '2098-04-02',
        limit: '50'
      }
    }, response)

    assert.equal(response.statusCode, 503)
    assert.equal(response.body?.code, 'tracking_visitor_projection_warming')
    assert.equal(response.body?.retryable, true)
    assert.equal(response.body?.coverage?.status, 'warming')
    assert.equal(response.headers['retry-after'], '1')

    const controllerSource = await readFile(
      new URL('../src/controllers/trackingController.js', import.meta.url),
      'utf8'
    )
    const visitorsHandlerStart = controllerSource.indexOf('export async function getVisitorsList')
    const visitorsHandler = controllerSource.slice(
      visitorsHandlerStart,
      controllerSource.indexOf('export async function getContactsByDate', visitorsHandlerStart)
    )
    assert.match(visitorsHandler, /throw trackingProjectionWarmingError\(visitorCoverage\)/)
    assert.doesNotMatch(visitorsHandler, /ranked_raw_visitors/i)

    const deadline = Date.now() + 10_000
    let state = await readTrackingVisitorProjectionState()
    while (state?.status !== 'ready' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
      state = await readTrackingVisitorProjectionState()
    }
  } finally {
    await db.run('DELETE FROM sessions WHERE id = ?', [id]).catch(() => undefined)
    await db.run(`
      UPDATE tracking_visitor_projection_state
      SET status = 'ready', last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = 1
    `).catch(() => undefined)
  }
})
