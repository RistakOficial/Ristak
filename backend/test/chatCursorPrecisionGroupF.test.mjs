import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import pg from 'pg'

const repoFile = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')
const postgresUrl = String(
  process.env.CHAT_CURSOR_TEST_POSTGRES_URL || process.env.TEST_POSTGRES_URL || ''
).trim()

test('Grupo F conserva un cursor privado lossless en todas las fuentes de conversación', async () => {
  const [backend, contactsService, desktop, phone] = await Promise.all([
    repoFile('backend/src/controllers/contactsController.js'),
    repoFile('frontend/src/services/contactsService.ts'),
    repoFile('frontend/src/pages/DesktopChat/DesktopChat.tsx'),
    repoFile('frontend/src/pages/PhoneChat/PhoneChat.tsx')
  ])

  assert.match(backend, /isPostgresDatabase \? `\(\$\{timestampExpression}\)::text` : timestampExpression/)
  for (const timestampConstant of [
    'whatsappAttributionMessageTimestamp',
    'whatsappApiMessageTimestamp',
    'metaSocialMessageTimestamp',
    'emailMessageTimestamp',
    'appointmentConfirmationTimestampExpression'
  ]) {
    assert.match(backend, new RegExp(`losslessTimestampCursorProjection\\(${timestampConstant}\\)`))
    assert.match(backend, new RegExp(`journeyMessageBeforeClause\\(\\s*${timestampConstant}`))
    assert.match(backend, new RegExp(`timestampSortExpression\\(${timestampConstant}\\)`))
  }
  assert.equal((backend.match(/cursorDate: .*journey_message_cursor_date/g) || []).length, 5)

  assert.match(contactsService, /cursorDate\?: string/)
  assert.match(contactsService, /cursorKey\?: string/)
  assert.match(contactsService, /beforeMessageCursor\?: string/)
  assert.match(contactsService, /params\.beforeMessageCursor = options\.beforeMessageCursor/)
  assert.match(contactsService, /event\.cursorDate \|\| event\.date/)

  for (const source of [desktop, phone]) {
    assert.match(source, /getOldestJourneyMessageCursor\(contactJourneyRef\.current\)/)
    assert.match(source, /beforeMessageCursor: oldestCursor\.beforeMessageCursor/)
    assert.match(source, /event\.type === 'appointment_confirmation'/)
    assert.match(source, /cursorDate: event\.cursorDate \|\| previous\.cursorDate/)
    assert.match(source, /cursorKey: event\.cursorKey \|\| previous\.cursorKey/)
  }
})

test('Grupo F pagina la bandeja por el mismo last_message_sort que usa ORDER BY', async () => {
  const [backend, desktop, phone] = await Promise.all([
    repoFile('backend/src/controllers/contactsController.js'),
    repoFile('frontend/src/pages/DesktopChat/DesktopChat.tsx'),
    repoFile('frontend/src/pages/PhoneChat/PhoneChat.tsx')
  ])

  assert.match(backend, /beforeMessageSort = ''/)
  assert.match(backend, /parseNumericCursor\(beforeMessageSort\)/)
  assert.match(backend, /\(chat_stats\.last_message_sort, chat_stats\.contact_id\) < \(\$\{numericCursorParameterExpression\(\)}/)
  assert.match(backend, /ranked_chats\.last_message_sort AS last_message_cursor_sort/)
  assert.match(backend, /lastMessageCursorSort: cleanString\(contact\.last_message_cursor_sort\)/)
  assert.match(backend, /hashPaginationCursorScope\('chat-contacts'/)
  assert.match(backend, /hiddenFilters: paginationCursorHiddenFiltersScope\(hiddenFilters\)/)
  assert.match(backend, /resolvedBusinessPhoneNumberIds: paginationCursorListScope/)
  assert.match(backend, /resolvedBusinessPhones: paginationCursorListScope/)
  assert.match(backend, /lastMessageCursorScope: cleanString\(contact\.last_message_cursor_scope\)/)
  assert.match(backend, /requestedMessageScope && requestedMessageScope !== chatContactsCursorScope/)
  assert.doesNotMatch(backend, /ranked_chats\.last_message_date.*last_message_cursor_date/)

  for (const source of [desktop, phone]) {
    assert.match(source, /lastMessageCursorSort\?: string/)
    assert.match(source, /lastMessageCursorScope\?: string/)
    assert.match(source, /beforeMessageSort: cursor\.beforeMessageSort/)
    assert.match(source, /beforeMessageScope: cursor\.beforeMessageScope/)
    assert.match(source, /compareLosslessNumericCursorValues\(leftSort, rightSort\)/)
    assert.match(source, /compareChatListContactCursors\(contact, boundary\) < 0/)
    assert.doesNotMatch(source, /chatListOffsetRef/)
  }
})

test('PostgreSQL vivo conserva microsegundos y recorre empates con sort+id sin perder filas', {
  skip: !postgresUrl
}, async () => {
  const client = new pg.Client({ connectionString: postgresUrl })
  await client.connect()

  const rowsSql = `
    WITH source_rows(id, message_date) AS (
      VALUES
        ('chat-c', '2100-01-01T12:00:00.123456Z'::timestamptz),
        ('chat-b', '2100-01-01T08:00:00.123455-04:00'::timestamptz),
        ('chat-a', '2100-01-01T12:00:00.123455Z'::timestamptz)
    ), ranked AS (
      SELECT id, message_date, EXTRACT(EPOCH FROM message_date) AS message_sort
      FROM source_rows
    )
  `

  try {
    const projection = await client.query(`
      ${rowsSql}
      SELECT
        id,
        message_date,
        message_date::text AS cursor_date,
        message_sort::text AS cursor_sort
      FROM ranked
      ORDER BY message_sort DESC, id DESC
      LIMIT 1
    `)
    assert.equal(projection.rows[0].id, 'chat-c')
    assert.equal(projection.rows[0].message_date.toISOString(), '2100-01-01T12:00:00.123Z')
    assert.match(projection.rows[0].cursor_date, /\.123456[+-]\d{2}(?::?\d{2})?$/)
    assert.match(projection.rows[0].cursor_sort, /\.123456$/)

    const collected = []
    let cursorSort = null
    let cursorId = null
    for (let page = 0; page < 4; page += 1) {
      const result = await client.query(`
        ${rowsSql}
        SELECT id, message_sort::text AS cursor_sort
        FROM ranked
        ${cursorSort ? 'WHERE (message_sort, id) < ($1::numeric, $2)' : ''}
        ORDER BY message_sort DESC, id DESC
        LIMIT 1
      `, cursorSort ? [cursorSort, cursorId] : [])
      if (result.rowCount === 0) break
      collected.push(result.rows[0].id)
      cursorSort = result.rows[0].cursor_sort
      cursorId = result.rows[0].id
    }

    assert.deepEqual(collected, ['chat-c', 'chat-b', 'chat-a'])
    assert.equal(new Set(collected).size, 3)
  } finally {
    await client.end()
  }
})
