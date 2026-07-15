import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { databaseDialect, db, setAppConfig } from '../src/config/database.js'
import { getContactConversionsList } from '../src/controllers/trackingController.js'
import { searchTrackingSessions } from '../src/services/trackingAnalyticsService.js'
import {
  ACCOUNT_TIMEZONE_CONFIG_KEY,
  invalidateTimezoneCache
} from '../src/utils/dateUtils.js'

function decodeCursor(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

function encodeLegacyCursor(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
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

async function exerciseSessionCursorPrecision() {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const prefix = `tracking-cursor-b-${suffix}`
  const date = '2097-04-11'

  await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, 'UTC')
  invalidateTimezoneCache()

  try {
    for (let index = 1; index <= 45; index += 1) {
      const fraction = String(100000 + index).padStart(6, '0')
      const timestamp = `${date}T12:00:00.${fraction}Z`
      await db.run(`
        INSERT INTO sessions (
          id, session_id, visitor_id, event_name, started_at, created_at, device_type
        ) VALUES (?, ?, ?, 'page_view', ?, ?, 'mobile')
      `, [
        randomUUID(),
        `${prefix}-${String(index).padStart(3, '0')}`,
        `${prefix}-visitor-${String(index).padStart(3, '0')}`,
        timestamp,
        timestamp
      ])
    }

    const expectedRows = await db.all(`
      SELECT id
      FROM sessions
      WHERE session_id LIKE ?
      ORDER BY started_at DESC, id DESC
    `, [`${prefix}%`])

    const pages = []
    const ids = []
    let cursor = null
    for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
      const page = await searchTrackingSessions({
        start: date,
        end: date,
        filters: { device_type: ['mobile'] },
        q: prefix,
        column: 'session_id',
        cursor,
        limit: 20
      })
      pages.push(page)
      ids.push(...page.items.map(item => item.id))
      assert.ok(page.items.every(item => !Object.hasOwn(item, 'cursor_started_at')))
      cursor = page.nextCursor
      if (!cursor) break
    }

    assert.deepEqual(pages.map(page => page.items.length), [20, 20, 5])
    assert.deepEqual(ids, expectedRows.map(row => row.id))
    assert.equal(new Set(ids).size, 45)

    const firstCursor = decodeCursor(pages[0].nextCursor)
    assert.equal(firstCursor.v, 2)
    assert.equal(firstCursor.kind, 'tracking-sessions')
    assert.match(firstCursor.startedAt, /\.100026(?:Z|[+-]00(?::?00)?)$/)

    await assert.rejects(
      searchTrackingSessions({
        start: date,
        end: date,
        filters: { device_type: ['desktop'] },
        q: prefix,
        column: 'session_id',
        cursor: pages[0].nextCursor,
        limit: 20
      }),
      error => error?.status === 400 && /no corresponde/i.test(error.message)
    )

    const legacyCursor = encodeLegacyCursor({
      startedAt: firstCursor.startedAt,
      id: firstCursor.id
    })
    const legacyPage = await searchTrackingSessions({
      start: date,
      end: date,
      filters: { device_type: ['mobile'] },
      q: prefix,
      column: 'session_id',
      cursor: legacyCursor,
      limit: 20
    })
    assert.deepEqual(legacyPage.items.map(item => item.id), pages[1].items.map(item => item.id))
  } finally {
    await db.run('DELETE FROM sessions WHERE session_id LIKE ?', [`${prefix}%`])
  }
}

test('SQLite recorre todas las sesiones aunque la llave caiga dentro del mismo milisegundo', {
  skip: databaseDialect !== 'sqlite'
}, exerciseSessionCursorPrecision)

test('PostgreSQL conserva microsegundos en el cursor aunque el DTO público use Date', {
  skip: databaseDialect !== 'postgres'
}, exerciseSessionCursorPrecision)

test('conversion_stage no pierde el siguiente chunk cuando 500 filas comparten milisegundo', async () => {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const prefix = `tracking-stage-cursor-b-${suffix}`
  const date = '2097-04-13'
  const contactIds = []

  await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, 'UTC')
  invalidateTimezoneCache()

  try {
    await db.transaction(async transaction => {
      for (let index = 1; index <= 525; index += 1) {
        const paddedIndex = String(index).padStart(3, '0')
        const timestamp = `${date}T12:00:00.${String(300000 + index).padStart(6, '0')}Z`
        const contactId = index <= 25 ? `${prefix}-contact-${paddedIndex}` : null

        if (contactId) {
          contactIds.push(contactId)
          await transaction.run(`
            INSERT INTO contacts (id, full_name, visitor_id, source, created_at, updated_at)
            VALUES (?, ?, ?, 'tracking', ?, ?)
          `, [contactId, `Cliente chunk ${index}`, `${contactId}-visitor`, timestamp, timestamp])
          await transaction.run(`
            INSERT INTO payments (
              id, contact_id, amount, status, payment_mode, date, created_at, updated_at
            ) VALUES (?, ?, 100, 'succeeded', 'live', ?, ?, ?)
          `, [randomUUID(), contactId, timestamp, timestamp, timestamp])
        }

        await transaction.run(`
          INSERT INTO sessions (
            id, session_id, visitor_id, contact_id, event_name, started_at, created_at
          ) VALUES (?, ?, ?, ?, 'page_view', ?, ?)
        `, [
          randomUUID(),
          `${prefix}-session-${paddedIndex}`,
          `${prefix}-visitor-${paddedIndex}`,
          contactId,
          timestamp,
          timestamp
        ])
      }
    })

    const first = await searchTrackingSessions({
      start: date,
      end: date,
      filters: { conversion_stage: ['customer'] },
      q: prefix,
      column: 'session_id',
      limit: 20
    })
    const second = await searchTrackingSessions({
      start: date,
      end: date,
      filters: { conversion_stage: ['customer'] },
      q: prefix,
      column: 'session_id',
      cursor: first.nextCursor,
      limit: 20
    })

    assert.deepEqual([first.items.length, second.items.length], [20, 5])
    assert.deepEqual([first.hasMore, second.hasMore], [true, false])
    const sessionIds = [...first.items, ...second.items].map(item => item.session_id)
    assert.deepEqual(
      sessionIds,
      Array.from({ length: 25 }, (_, offset) => `${prefix}-session-${String(25 - offset).padStart(3, '0')}`)
    )
    assert.equal(new Set(sessionIds).size, 25)
  } finally {
    await db.run('DELETE FROM sessions WHERE session_id LIKE ?', [`${prefix}%`])
    for (const contactId of contactIds) {
      await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    }
  }
})

test('el drill-down de conversiones usa una llave coherente y amarra el cursor a su consulta', async () => {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const prefix = `tracking-contact-cursor-b-${suffix}`
  const date = '2097-04-12'
  const contactIds = []

  await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, 'UTC')
  invalidateTimezoneCache()

  try {
    for (let index = 1; index <= 7; index += 1) {
      const id = `${prefix}-${String(index).padStart(3, '0')}`
      const timestamp = `${date}T12:00:00.${String(200000 + index).padStart(6, '0')}Z`
      contactIds.push(id)
      await db.run(`
        INSERT INTO contacts (
          id, full_name, email, visitor_id, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'tracking', ?, ?)
      `, [
        id,
        `Contacto cursor ${index}`,
        `${id}@local.invalid`,
        `${id}-visitor`,
        timestamp,
        timestamp
      ])
    }

    const pages = []
    const ids = []
    let cursor = null
    for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
      const result = await callController(getContactConversionsList, {
        start: date,
        end: date,
        type: 'registrations',
        cursor,
        limit: '2'
      })
      pages.push(result.data)
      ids.push(...result.data.contacts.map(contact => contact.id))
      assert.ok(result.data.contacts.every(contact => !Object.hasOwn(contact, 'cursor_serialized_at')))
      cursor = result.data.pagination.nextCursor
      if (!cursor) break
    }

    assert.deepEqual(pages.map(page => page.contacts.length), [2, 2, 2, 1])
    assert.deepEqual(ids, [...contactIds].reverse())
    assert.equal(new Set(ids).size, 7)

    const firstCursor = decodeCursor(pages[0].pagination.nextCursor)
    assert.equal(firstCursor.v, 3)
    assert.equal(firstCursor.kind, 'contact-conversions')
    if (databaseDialect === 'postgres') {
      assert.match(firstCursor.createdAt, /\.200006(?:Z|[+-]00(?::?00)?)$/)
    } else {
      assert.match(firstCursor.createdAt, /\.200006Z$/)
    }

    const mismatched = await callController(getContactConversionsList, {
      start: date,
      end: date,
      type: 'prospects',
      cursor: pages[0].pagination.nextCursor,
      limit: '2'
    }, 400)
    assert.match(mismatched.error, /no corresponde/i)

    const legacyCursor = encodeLegacyCursor({
      v: 2,
      kind: firstCursor.kind,
      createdAt: firstCursor.createdAt,
      id: firstCursor.id
    })
    const legacyPage = await callController(getContactConversionsList, {
      start: date,
      end: date,
      type: 'registrations',
      cursor: legacyCursor,
      limit: '2'
    })
    assert.deepEqual(
      legacyPage.data.contacts.map(contact => contact.id),
      pages[1].contacts.map(contact => contact.id)
    )
  } finally {
    for (const contactId of contactIds) {
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    }
  }
})
