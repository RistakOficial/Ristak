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
  if (columns.some(column => column.name === 'visitor_projection_version')) return
  await db.exec(await readFile(new URL('../migrations/versioned/080_tracking_visitor_projection.sqlite.sql', import.meta.url), 'utf8'))
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

test('visitors drill-down is cursor paginated, searchable and capped for legacy callers', async () => {
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
    assert.equal(historicalSearchPage.data.length, 1)
    assert.equal(historicalSearchPage.data[0].sessionId, `session-historical-old-${suffix}`)

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
      SELECT current.id
      FROM sessions current
      WHERE current.started_at >= ?
        AND current.started_at <= ?
        AND current.visitor_key IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM sessions newer
          WHERE newer.visitor_key = current.visitor_key
            AND newer.started_at >= ?
            AND newer.started_at <= ?
            AND (newer.started_at, newer.id) > (current.started_at, current.id)
        )
      ORDER BY current.started_at DESC, current.id DESC
      LIMIT 51
    `, [
      `${date}T00:00:00.000Z`,
      `${date}T23:59:59.999Z`,
      `${date}T00:00:00.000Z`,
      `${date}T23:59:59.999Z`
    ])
    const plan = explain.map(row => row.detail).join('\n')
    assert.match(plan, /idx_sessions_started_at(?:_id)?/)
    assert.match(plan, /idx_sessions_visitor_key_started_page/)
  } finally {
    for (const id of sessionIds) {
      await db.run('DELETE FROM sessions WHERE id = ?', [id])
    }
    for (const id of contactIds) {
      await db.run('DELETE FROM contacts WHERE id = ?', [id])
    }
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
  assert.match(conversionsHandler, /fetchPaymentSummariesForContacts\(contactIds\)/)
  assert.doesNotMatch(conversionsHandler, /fetchPaymentsForContacts|fetchAppointmentsForContacts/)
  assert.match(conversionsHandler, /GROUP BY c\.id/)
})

test('desktop drill-down consumers use remote search and cursor navigation instead of direct unbounded fetches', async () => {
  const frontendFile = (path) => readFile(new URL(`../../frontend/src/${path}`, import.meta.url), 'utf8')
  const [dashboard, campaigns, reports, analytics, visitorModal] = await Promise.all([
    frontendFile('pages/Dashboard/Dashboard.tsx'),
    frontendFile('pages/Campaigns/Campaigns.tsx'),
    frontendFile('pages/Reports/Reports.tsx'),
    frontendFile('pages/Analytics/Analytics.tsx'),
    frontendFile('components/common/VisitorDetailsModal/VisitorDetailsModal.tsx')
  ])

  for (const source of [dashboard, campaigns, reports]) {
    assert.doesNotMatch(source, /fetch\([^)]*\/api\/tracking\/visitors\?/)
    assert.match(source, /getVisitorsPage/)
    assert.match(source, /onPageChange=/)
    assert.match(source, /onSearchChange=/)
  }
  assert.match(analytics, /getContactConversionContacts\(/)
  assert.match(analytics, /handleConversionContactPageChange/)
  assert.match(analytics, /handleConversionContactSearch/)
  assert.match(analytics, /onSelectContact=\{hydrateConversionContact\}/)
  assert.match(visitorModal, /window\.setTimeout\(\(\) => onSearchChange/)
  assert.match(visitorModal, /hasNextPage/)
  assert.match(visitorModal, /Siguiente\s*<\/Button>/)
})
