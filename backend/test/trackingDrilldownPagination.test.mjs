import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { databaseDialect, db } from '../src/config/database.js'
import {
  getContactConversionsList,
  getSessionsHandler,
  getVisitorsList
} from '../src/controllers/trackingController.js'
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

async function callController(handler, query, expectedStatus = 200) {
  const response = createResponse()
  await handler({ query }, response)
  assert.equal(response.statusCode, expectedStatus)
  return response.body
}

test('el endpoint legacy de sesiones rechaza descargas grandes y offsets profundos', async () => {
  const tooLarge = await callController(getSessionsHandler, { limit: '201' }, 400)
  assert.match(tooLarge.error, /max 200/i)

  const tooDeep = await callController(getSessionsHandler, { limit: '50', offset: '5001' }, 400)
  assert.match(tooDeep.error, /sessions\/search with cursor/i)
})

test('visitors drill-down is projection-paginated, bounded-searchable and capped for legacy callers', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const date = '2099-06-14'
  const sessionIds = []
  const contactIds = []

  try {
    await ensureVisitorProjectionMigration()
    await runTrackingVisitorProjectionBackfill({ batchSize: 25, yieldMs: 0 })

    for (let index = 0; index < 105; index += 1) {
      const id = `visitor-page-row-${suffix}-${String(index).padStart(3, '0')}`
      const timestamp = `${date}T${String(12 + Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`
      sessionIds.push(id)
      await db.run(`
        INSERT INTO sessions (
          id, session_id, visitor_id, event_name, started_at, created_at, utm_campaign
        ) VALUES (?, ?, ?, 'page_view', ?, ?, ?)
      `, [
        id,
        `session-${suffix}-${index}`,
        `visitor-${suffix}-${index}`,
        timestamp,
        timestamp,
        index === 77 ? `simple-needle-${suffix}` : 'campana-general'
      ])
    }

    const duplicateLatestId = `visitor-page-row-${suffix}-latest`
    sessionIds.push(duplicateLatestId)
    await db.run(`
      INSERT INTO sessions (
        id, session_id, visitor_id, event_name, started_at, created_at, utm_campaign
      ) VALUES (?, ?, ?, 'page_view', ?, ?, 'campana-general')
    `, [
      duplicateLatestId,
      `session-${suffix}-latest`,
      `visitor-${suffix}-0`,
      `${date}T15:00:00.000Z`,
      `${date}T15:00:00.000Z`
    ])

    const historicalNeedleVisitor = `visitor-historical-${suffix}`
    const historicalNeedleId = `visitor-historical-${suffix}-old`
    const historicalLatestId = `visitor-historical-${suffix}-latest`
    sessionIds.push(historicalNeedleId, historicalLatestId)
    await db.run(`
      INSERT INTO sessions (
        id, session_id, visitor_id, event_name, started_at, created_at, utm_campaign
      ) VALUES (?, ?, ?, 'page_view', ?, ?, ?)
    `, [
      historicalNeedleId,
      `session-historical-old-${suffix}`,
      historicalNeedleVisitor,
      `${date}T16:00:00.100Z`,
      `${date}T16:00:00.100Z`,
      `historical-needle-${suffix}`
    ])
    await db.run(`
      INSERT INTO sessions (
        id, session_id, visitor_id, event_name, started_at, created_at, utm_campaign
      ) VALUES (?, ?, ?, 'page_view', ?, ?, 'sin-coincidencia')
    `, [
      historicalLatestId,
      `session-historical-latest-${suffix}`,
      historicalNeedleVisitor,
      `${date}T17:00:00.900Z`,
      `${date}T17:00:00.900Z`
    ])

    const searchableContactId = `visitor-contact-${suffix}`
    contactIds.push(searchableContactId)
    await db.run(`
      INSERT INTO contacts (id, full_name, email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `, [
      searchableContactId,
      `Contacto Encontrable ${suffix}`,
      `encontrable-${suffix}@local.invalid`,
      `${date}T18:00:00.000Z`,
      `${date}T18:00:00.000Z`
    ])
    for (const [label, timestamp] of [['old', '18:00:00.100'], ['latest', '19:00:00.900']]) {
      const contactSessionId = `visitor-contact-${suffix}-${label}`
      sessionIds.push(contactSessionId)
      await db.run(`
        INSERT INTO sessions (
          id, session_id, visitor_id, contact_id, event_name, started_at, created_at
        ) VALUES (?, ?, ?, ?, 'page_view', ?, ?)
      `, [
        contactSessionId,
        `session-contact-${label}-${suffix}`,
        `visitor-contact-${suffix}`,
        searchableContactId,
        `${date}T${timestamp}Z`,
        `${date}T${timestamp}Z`
      ])
    }

    const legacyPage = await callController(getVisitorsList, { startDate: date, endDate: date })
    assert.equal(legacyPage.data.length, 50)
    assert.equal(legacyPage.pagination.limit, 50)
    assert.equal(legacyPage.pagination.hasNext, true)
    assert.ok(legacyPage.pagination.nextCursor)
    assert.equal(legacyPage.coverage.source, 'tracking_visitor_latest')
    assert.equal(legacyPage.coverage.exact, true)
    assert.equal(legacyPage.data.find(row => row.visitorId === `visitor-${suffix}-0`)?.sessionId, `session-${suffix}-latest`)
    assert.equal(new Set(legacyPage.data.map(row => row.visitorId)).size, legacyPage.data.length)

    const maxGuardPage = await callController(getVisitorsList, {
      startDate: date,
      endDate: date,
      limit: '999999'
    })
    assert.equal(maxGuardPage.data.length, 100)
    assert.equal(maxGuardPage.pagination.limit, 100)
    assert.equal(maxGuardPage.pagination.hasNext, true)

    const firstPage = await callController(getVisitorsList, {
      startDate: date,
      endDate: date,
      limit: '2'
    })
    const secondPage = await callController(getVisitorsList, {
      startDate: date,
      endDate: date,
      limit: '2',
      cursor: firstPage.pagination.nextCursor
    })
    assert.equal(firstPage.data.length, 2)
    assert.equal(secondPage.data.length, 2)
    assert.equal(new Set([...firstPage.data, ...secondPage.data].map(row => row.sessionId)).size, 4)

    const searchPage = await callController(getVisitorsList, {
      startDate: date,
      endDate: date,
      search: `simple-needle-${suffix}`
    })
    assert.equal(searchPage.data.length, 1)
    assert.equal(searchPage.data[0].utmCampaign, `simple-needle-${suffix}`)

    const historicalSearchPage = await callController(getVisitorsList, {
      startDate: date,
      endDate: date,
      search: `historical-needle-${suffix}`
    })
    assert.equal(historicalSearchPage.data.length, 0)
    assert.equal(historicalSearchPage.coverage.partial, true)
    assert.equal(historicalSearchPage.coverage.search.mode, 'bounded_latest_projection')
    assert.equal(historicalSearchPage.coverage.search.historicalSessionsIncluded, false)

    const contactSearchPage = await callController(getVisitorsList, {
      startDate: date,
      endDate: date,
      search: `Encontrable ${suffix}`
    })
    assert.equal(contactSearchPage.data.length, 1)
    assert.equal(contactSearchPage.data[0].sessionId, `session-contact-latest-${suffix}`)

    const tooShortSearch = await callController(getVisitorsList, {
      startDate: date,
      endDate: date,
      search: 'ab'
    })
    assert.deepEqual(tooShortSearch.data, [])
    assert.equal(tooShortSearch.pagination.searchMinLength, 3)

    const escapedWildcardSearch = await callController(getVisitorsList, {
      startDate: date,
      endDate: date,
      search: '%'
    })
    assert.equal(escapedWildcardSearch.data.length, 0)

    const invalidCursor = await callController(getVisitorsList, {
      startDate: date,
      endDate: date,
      cursor: 'esto-no-es-un-cursor'
    }, 400)
    assert.equal(invalidCursor.error, 'Cursor inválido')

    const explain = await db.all(`
      EXPLAIN QUERY PLAN
      SELECT current.session_row_id
      FROM tracking_visitor_latest current
      WHERE current.scope_type = 'all'
        AND current.scope_id = ''
        AND current.bucket_kind = 'day'
        AND current.latest_at >= ?
        AND current.latest_at < ?
      ORDER BY current.latest_at DESC, current.session_row_id DESC
      LIMIT 51
    `, [
      `${date}T00:00:00.000Z`,
      `${date}T23:59:59.999Z`
    ])
    const plan = explain.map(row => row.detail).join('\n')
    assert.match(plan, /idx_tracking_visitor_latest_day_page/)
  } finally {
    for (const id of sessionIds) {
      await db.run('DELETE FROM sessions WHERE id = ?', [id])
    }
    for (const id of contactIds) {
      await db.run('DELETE FROM contacts WHERE id = ?', [id])
    }
  }
})

test('visitor GET serves partial projection during warming without inspecting historical sessions', async () => {
  if (databaseDialect !== 'sqlite') return
  await ensureVisitorProjectionMigration()
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const prefix = `warming-${suffix}-`
  const observedSql = []
  const originalAll = db.all
  const originalGet = db.get

  try {
    await db.run(`
      WITH RECURSIVE sequence(n) AS (
        SELECT 1
        UNION ALL
        SELECT n + 1 FROM sequence WHERE n < 1200
      )
      INSERT INTO sessions (
        id, session_id, visitor_id, event_name, started_at, created_at
      )
      SELECT
        ? || printf('%04d', n),
        'session-' || ? || printf('%04d', n),
        'visitor-' || ? || printf('%04d', n),
        'page_view',
        datetime('2098-02-12T12:00:00.000Z', '+' || n || ' seconds'),
        datetime('2098-02-12T12:00:00.000Z', '+' || n || ' seconds')
      FROM sequence
    `, [prefix, prefix, prefix])
    await db.run('UPDATE sessions SET visitor_projection_version = 0 WHERE id LIKE ?', [`${prefix}%`])
    await db.run(`
      UPDATE tracking_visitor_projection_state
      SET status = 'backfilling', updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = 1
    `)

    db.all = async function observedAll(sql, params) {
      observedSql.push(String(sql))
      return originalAll.call(this, sql, params)
    }
    db.get = async function observedGet(sql, params) {
      observedSql.push(String(sql))
      return originalGet.call(this, sql, params)
    }

    const page = await callController(getVisitorsList, {
      startDate: '2098-02-12',
      endDate: '2098-02-12',
      limit: '50'
    })
    assert.equal(page.data.length, 50)
    assert.equal(page.coverage.status, 'warming')
    assert.equal(page.coverage.partial, true)
    assert.equal(page.coverage.reason, 'projection_warming')

    const requestSql = observedSql.join('\n')
    assert.match(requestSql, /tracking_visitor_latest/i)
    assert.doesNotMatch(requestSql, /visitor_projection_version/i)
    assert.doesNotMatch(requestSql, /ranked_visitors|matched_visitor_candidates/i)
    assert.doesNotMatch(requestSql, /ROW_NUMBER\s*\(\s*\)\s*OVER/i)
    assert.equal(observedSql.filter(sql => /\bFROM\s+sessions\b/i.test(sql)).length, 0)
  } finally {
    db.all = originalAll
    db.get = originalGet
    await db.run('DELETE FROM sessions WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
    await db.run(`
      UPDATE tracking_visitor_projection_state
      SET status = 'ready', last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = 1
    `).catch(() => undefined)
  }
})

test('visitor projection backfill and triggers keep the durable identity exact', async () => {
  if (databaseDialect !== 'sqlite') return
  await ensureVisitorProjectionMigration()
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const id = `visitor-projection-${suffix}`
  const numericOlderId = `z-visitor-numeric-${suffix}`
  const numericLatestId = `a-visitor-numeric-${suffix}`
  const numericVisitorId = `visitor-numeric-${suffix}`

  try {
    await db.run(`
      INSERT INTO sessions (id, session_id, visitor_id, event_name, started_at, created_at)
      VALUES (?, ?, ?, 'page_view', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [id, `session-${suffix}`, `visitor-${suffix}`])

    let row = await db.get('SELECT visitor_key, visitor_projection_version FROM sessions WHERE id = ?', [id])
    assert.equal(row.visitor_key, `visitor:visitor-${suffix}`)
    assert.equal(Number(row.visitor_projection_version), 3)

    // Simula una fila heredada anterior a la migración.
    await db.run('UPDATE sessions SET visitor_key = NULL, visitor_projection_version = 0 WHERE id = ?', [id])
    await db.run(`
      UPDATE tracking_visitor_projection_state
      SET status = 'backfilling', updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = 1
    `)
    const backfill = await runTrackingVisitorProjectionBackfill({ batchSize: 1, yieldMs: 0 })
    assert.equal(backfill.ready, true)
    assert.ok(backfill.updated >= 1)

    row = await db.get('SELECT visitor_key, visitor_projection_version FROM sessions WHERE id = ?', [id])
    assert.equal(row.visitor_key, `visitor:visitor-${suffix}`)
    assert.equal(Number(row.visitor_projection_version), 3)

    await db.run('UPDATE sessions SET visitor_id = ? WHERE id = ?', [`visitor-updated-${suffix}`, id])
    row = await db.get('SELECT visitor_key FROM sessions WHERE id = ?', [id])
    assert.equal(row.visitor_key, `visitor:visitor-updated-${suffix}`)

    const secondsTimestamp = Date.parse('2031-08-12T12:00:00.100Z') / 1000
    const millisecondsTimestamp = Date.parse('2031-08-12T12:00:00.900Z')
    await db.run(`
      INSERT INTO sessions (id, session_id, visitor_id, event_name, started_at, created_at)
      VALUES (?, ?, ?, 'page_view', ?, ?)
    `, [
      numericOlderId,
      `session-numeric-older-${suffix}`,
      numericVisitorId,
      secondsTimestamp,
      '2031-08-12T12:00:00.100Z'
    ])
    await db.run(`
      INSERT INTO sessions (id, session_id, visitor_id, event_name, started_at, created_at)
      VALUES (?, ?, ?, 'page_view', ?, ?)
    `, [
      numericLatestId,
      `session-numeric-latest-${suffix}`,
      numericVisitorId,
      millisecondsTimestamp,
      '2031-08-12T12:00:00.900Z'
    ])

    let numericHeads = await db.all(`
      SELECT bucket_kind, session_row_id, latest_at
      FROM tracking_visitor_latest
      WHERE scope_type = 'all'
        AND scope_id = ''
        AND visitor_key = ?
      ORDER BY bucket_kind
    `, [`visitor:${numericVisitorId}`])
    assert.equal(numericHeads.length, 2)
    assert.ok(numericHeads.every(head => head.session_row_id === numericLatestId))
    assert.ok(numericHeads.every(head => head.latest_at.endsWith('00.900Z')))

    const dedupedPage = await callController(getVisitorsList, {
      startDate: '2031-08-12',
      endDate: '2031-08-12',
      limit: '100'
    })
    assert.equal(
      dedupedPage.data.filter(visitor => visitor.visitorId === numericVisitorId).length,
      1,
      'la misma cabeza day+quarter sólo puede producir un visitante/cursor'
    )

    await db.run('UPDATE sessions SET started_at = ? WHERE id = ?', [
      Date.parse('2031-08-12T12:00:00.050Z'),
      numericLatestId
    ])
    numericHeads = await db.all(`
      SELECT bucket_kind, session_row_id, latest_at
      FROM tracking_visitor_latest
      WHERE scope_type = 'all'
        AND scope_id = ''
        AND visitor_key = ?
      ORDER BY bucket_kind
    `, [`visitor:${numericVisitorId}`])
    assert.equal(numericHeads.length, 2)
    assert.ok(numericHeads.every(head => head.session_row_id === numericOlderId))
    assert.ok(numericHeads.every(head => head.latest_at.endsWith('00.100Z')))

    await db.run('DELETE FROM sessions WHERE id = ?', [numericOlderId])
    numericHeads = await db.all(`
      SELECT bucket_kind, session_row_id, latest_at
      FROM tracking_visitor_latest
      WHERE scope_type = 'all'
        AND scope_id = ''
        AND visitor_key = ?
      ORDER BY bucket_kind
    `, [`visitor:${numericVisitorId}`])
    assert.equal(numericHeads.length, 2)
    assert.ok(numericHeads.every(head => head.session_row_id === numericLatestId))
    assert.ok(numericHeads.every(head => head.latest_at.endsWith('00.050Z')))
  } finally {
    await db.run('DELETE FROM sessions WHERE id = ?', [id]).catch(() => undefined)
    await db.run('DELETE FROM sessions WHERE id = ?', [numericOlderId]).catch(() => undefined)
    await db.run('DELETE FROM sessions WHERE id = ?', [numericLatestId]).catch(() => undefined)
  }
})

test('ready projection restart is O(1) and never rechecks sessions', async () => {
  if (databaseDialect !== 'sqlite') return
  await ensureVisitorProjectionMigration()
  await db.run(`
    UPDATE tracking_visitor_projection_state
    SET projection_version = 3, status = 'ready', last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE singleton_id = 1
  `)
  const observedSql = []
  const originalGet = db.get
  const originalAll = db.all
  const originalRun = db.run

  try {
    db.get = async function observedGet(sql, params) {
      observedSql.push(String(sql))
      return originalGet.call(this, sql, params)
    }
    db.all = async function observedAll(sql, params) {
      observedSql.push(String(sql))
      return originalAll.call(this, sql, params)
    }
    db.run = async function observedRun(sql, params) {
      observedSql.push(String(sql))
      return originalRun.call(this, sql, params)
    }

    const result = await runTrackingVisitorProjectionBackfill({ batchSize: 1, yieldMs: 0 })
    assert.equal(result.ready, true)
    assert.equal(result.alreadyReady, true)
    assert.equal(result.updated, 0)
    assert.doesNotMatch(observedSql.join('\n'), /\b(?:FROM|UPDATE)\s+sessions\b/i)
  } finally {
    db.get = originalGet
    db.all = originalAll
    db.run = originalRun
  }
})

test('visitor GET propagates operational projection-state errors instead of returning an empty success', async () => {
  if (databaseDialect !== 'sqlite') return
  await ensureVisitorProjectionMigration()
  const originalGet = db.get

  try {
    db.get = async function failingProjectionState(sql, params) {
      if (/tracking_visitor_projection_state/i.test(String(sql))) {
        const error = new Error('database connection interrupted')
        error.code = 'ECONNRESET'
        throw error
      }
      return originalGet.call(this, sql, params)
    }

    const response = await callController(getVisitorsList, {
      startDate: '2098-02-12',
      endDate: '2098-02-12'
    }, 500)
    assert.equal(response.error, 'Internal server error')
    assert.equal(response.success, undefined)
  } finally {
    db.get = originalGet
  }
})

test('contact-attributed visitor search keeps contact cursor stable and preserves historical matches', async () => {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const date = '2099-09-10'
  const contactIds = [`attributed-a-${suffix}`, `attributed-b-${suffix}`]
  const sessionIds = []

  try {
    for (let index = 0; index < contactIds.length; index += 1) {
      const contactId = contactIds[index]
      const contactTimestamp = `${date}T${index === 0 ? '14' : '13'}:00:00.000Z`
      await db.run(`
        INSERT INTO contacts (id, full_name, email, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `, [
        contactId,
        index === 0 ? `Contact Needle ${suffix}` : `Contacto ${suffix} ${index}`,
        `${contactId}@local.invalid`,
        contactTimestamp,
        contactTimestamp
      ])

      for (const [label, time, campaign] of [
        ['old', '15:00:00.100', index === 1 ? `Session Needle ${suffix}` : 'old-contact-session'],
        ['latest', '16:00:00.900', 'latest-contact-session']
      ]) {
        const sessionId = `${contactId}-${label}`
        sessionIds.push(sessionId)
        await db.run(`
          INSERT INTO sessions (
            id, session_id, visitor_id, contact_id, event_name,
            started_at, created_at, utm_campaign
          ) VALUES (?, ?, ?, ?, 'page_view', ?, ?, ?)
        `, [
          sessionId,
          `session-${sessionId}`,
          `visitor-${contactId}`,
          contactId,
          `${date}T${time}Z`,
          `${date}T${time}Z`,
          campaign
        ])
      }
    }

    const contactMatch = await callController(getVisitorsList, {
      startDate: date,
      endDate: date,
      scope: 'attribution',
      search: `Contact Needle ${suffix}`
    })
    assert.equal(contactMatch.data.length, 1)
    assert.equal(contactMatch.data[0].contactId, contactIds[0])
    assert.equal(contactMatch.data[0].sessionId, `session-${contactIds[0]}-latest`)

    const historicalSessionMatch = await callController(getVisitorsList, {
      startDate: date,
      endDate: date,
      scope: 'attribution',
      search: `Session Needle ${suffix}`
    })
    assert.equal(historicalSessionMatch.data.length, 1)
    assert.equal(historicalSessionMatch.data[0].contactId, contactIds[1])
    assert.equal(historicalSessionMatch.data[0].sessionId, `session-${contactIds[1]}-old`)

    const firstPage = await callController(getVisitorsList, {
      startDate: date,
      endDate: date,
      scope: 'attribution',
      limit: '1'
    })
    assert.equal(firstPage.data[0].contactId, contactIds[0])

    const lateSessionId = `${contactIds[0]}-after-first-page`
    sessionIds.push(lateSessionId)
    await db.run(`
      INSERT INTO sessions (
        id, session_id, visitor_id, contact_id, event_name, started_at, created_at
      ) VALUES (?, ?, ?, ?, 'page_view', ?, ?)
    `, [
      lateSessionId,
      `session-${lateSessionId}`,
      `visitor-${contactIds[0]}`,
      contactIds[0],
      `${date}T17:00:00.000Z`,
      `${date}T17:00:00.000Z`
    ])

    const secondPage = await callController(getVisitorsList, {
      startDate: date,
      endDate: date,
      scope: 'attribution',
      limit: '1',
      cursor: firstPage.pagination.nextCursor
    })
    assert.equal(secondPage.data[0].contactId, contactIds[1])
  } finally {
    for (const id of sessionIds) {
      await db.run('DELETE FROM sessions WHERE id = ?', [id]).catch(() => undefined)
    }
    for (const id of contactIds) {
      await db.run('DELETE FROM contacts WHERE id = ?', [id]).catch(() => undefined)
    }
  }
})

test('contact conversion drill-down pages before loading details and searches on the server', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const date = '2099-07-20'
  const contactIds = []

  try {
    for (let index = 0; index < 4; index += 1) {
      const id = `conversion-page-${suffix}-${index}`
      const timestamp = `${date}T1${index}:00:00.000Z`
      contactIds.push(id)
      await db.run(`
        INSERT INTO contacts (
          id, full_name, email, visitor_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, [
        id,
        index === 2 ? `Contacto Aguja ${suffix}` : `Contacto ${index}`,
        `conversion-${suffix}-${index}@local.invalid`,
        `conversion-visitor-${suffix}-${index}`,
        timestamp,
        timestamp
      ])
    }

    const firstPage = await callController(getContactConversionsList, {
      start: date,
      end: date,
      type: 'registrations',
      limit: '2'
    })
    assert.equal(firstPage.data.contacts.length, 2)
    assert.equal(firstPage.data.pagination.hasNext, true)
    assert.ok(firstPage.data.pagination.nextCursor)

    const secondPage = await callController(getContactConversionsList, {
      start: date,
      end: date,
      type: 'registrations',
      limit: '2',
      cursor: firstPage.data.pagination.nextCursor
    })
    assert.equal(secondPage.data.contacts.length, 2)
    assert.equal(secondPage.data.pagination.hasNext, false)
    assert.equal(new Set([...firstPage.data.contacts, ...secondPage.data.contacts].map(row => row.id)).size, 4)

    const searchPage = await callController(getContactConversionsList, {
      start: date,
      end: date,
      type: 'registrations',
      search: `Aguja ${suffix}`
    })
    assert.deepEqual(searchPage.data.contacts.map(row => row.id), [contactIds[2]])
  } finally {
    for (const id of contactIds) {
      await db.run('DELETE FROM contacts WHERE id = ?', [id])
    }
  }
})

test('tracking drill-down source keeps remote calls and unbounded list queries out of both handlers', async () => {
  const source = await readFile(new URL('../src/controllers/trackingController.js', import.meta.url), 'utf8')
  const visitorsHandler = source.slice(
    source.indexOf('export async function getVisitorsList'),
    source.indexOf('export async function getContactsByDate')
  )
  const conversionsHandler = source.slice(
    source.indexOf('export async function getContactConversionsList'),
    source.length
  )

  assert.doesNotMatch(visitorsHandler, /leadconnectorhq|getContactsWithShowedAppointmentsHybrid|api_token/i)
  assert.match(visitorsHandler, /LIMIT \?/)
  assert.match(visitorsHandler, /pageLimit \+ 1/)
  assert.match(visitorsHandler, /pagination:/)
  assert.doesNotMatch(conversionsHandler, /ORDER BY c\.created_at DESC\s*`/)
  assert.match(visitorsHandler, /fetchBoundedAppointmentsForContacts\(contactIds\)/)
  assert.match(visitorsHandler, /SELECT \* FROM day_page\s+UNION\s+SELECT \* FROM quarter_page/)
  assert.doesNotMatch(visitorsHandler, /SELECT \* FROM day_page\s+UNION ALL\s+SELECT \* FROM quarter_page/)
  assert.match(conversionsHandler, /fetchPaymentSummariesForContacts\(contactIds\)/)
  assert.doesNotMatch(conversionsHandler, /fetchPaymentsForContacts|fetchAppointmentsForContacts/)
  assert.match(conversionsHandler, /GROUP BY c\.id/)
})

test('desktop drill-down consumers use remote search and cursor navigation instead of direct unbounded fetches', async () => {
  const frontendFile = (path) => readFile(new URL(`../../frontend/src/${path}`, import.meta.url), 'utf8')
  const [dashboard, campaigns, reports, analytics, analyticsService, trackingClient, visitorModal] = await Promise.all([
    frontendFile('pages/Dashboard/Dashboard.tsx'),
    frontendFile('pages/Campaigns/Campaigns.tsx'),
    frontendFile('pages/Reports/Reports.tsx'),
    frontendFile('pages/Analytics/Analytics.tsx'),
    frontendFile('services/analyticsService.ts'),
    frontendFile('services/trackingService.ts'),
    frontendFile('components/common/VisitorDetailsModal/VisitorDetailsModal.tsx')
  ])

  for (const source of [dashboard, campaigns, reports]) {
    assert.doesNotMatch(source, /fetch\([^)]*\/api\/tracking\/visitors\?/)
    assert.match(source, /getVisitorsPage/)
    assert.match(source, /onPageChange=/)
    assert.match(source, /onSearchChange=/)
    assert.match(source, /trackingVisitorsCoverageNotice\(result\.coverage\)/)
    assert.match(source, /result\.items\.length > 0 \|\| !coverageNotice/)
  }
  assert.match(analyticsService, /AnalyticsVisitorsCoverage = TrackingVisitorsCoverage/)
  assert.match(trackingClient, /coverage\?: TrackingVisitorsCoverage/)
  assert.match(analytics, /getContactConversionContacts\(/)
  assert.match(analytics, /handleConversionContactPageChange/)
  assert.match(analytics, /handleConversionContactSearch/)
  assert.match(analytics, /onSelectContact=\{hydrateConversionContact\}/)
  assert.match(visitorModal, /window\.setTimeout\(\(\) => onSearchChange/)
  assert.match(visitorModal, /hasNextPage/)
  assert.match(visitorModal, /Siguiente\s*<\/Button>/)
})
