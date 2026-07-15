import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { databaseDialect, db } from '../src/config/database.js'
import {
  CONTACT_ORIGIN_PROJECTION_LIMITS,
  CONTACT_ORIGIN_PROJECTION_VERSION,
  getContactOriginProjectionStatus,
  queryContactOriginBreakdowns,
  readContactOriginProjectionState,
  runContactOriginProjectionBackfill
} from '../src/services/contactOriginProjectionService.js'
import { migrationRunsForDialect } from '../src/startup/runMigrations.js'
import { assertConcurrentPostgresMigrationIsIsolated } from '../src/startup/runMigrations.js'
import { invalidateTimezoneCache } from '../src/utils/dateUtils.js'

const sqliteMigrationUrl = new URL(
  '../migrations/versioned/117_contact_origin_projection.sqlite.sql',
  import.meta.url
)
const postgresMigrationUrl = new URL(
  '../migrations/versioned/117a_contact_origin_projection.postgres.sql',
  import.meta.url
)
const postgresVisitorIndexUrl = new URL(
  '../migrations/versioned/117b_contact_origin_contacts_visitor.postgres.sql',
  import.meta.url
)
const postgresEmailIndexUrl = new URL(
  '../migrations/versioned/117c_contact_origin_contacts_email.postgres.sql',
  import.meta.url
)
const contactSourceServiceUrl = new URL('../src/services/contactSourceService.js', import.meta.url)

const prefix = 'origin-projection-test-'

async function ensureSchema() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS crm_list_projection_state (
      projection_key TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'backfilling',
      processed_count INTEGER NOT NULL DEFAULT 0,
      generation INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS contact_list_activity (
      contact_id TEXT PRIMARY KEY,
      first_payment_date TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  await db.exec(await readFile(sqliteMigrationUrl, 'utf8'))
  for (const key of ['contact_rows', 'contact_payments']) {
    await db.run(`
      INSERT INTO crm_list_projection_state(projection_key, status, processed_count, generation, updated_at)
      VALUES (?, 'ready', 0, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(projection_key) DO UPDATE SET status = 'ready', updated_at = CURRENT_TIMESTAMP
    `, [key])
  }
  await db.run(`
    INSERT INTO app_config(config_key, config_value, created_at, updated_at)
    VALUES ('account_timezone', 'UTC', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(config_key) DO UPDATE SET config_value = 'UTC', updated_at = CURRENT_TIMESTAMP
  `)
  invalidateTimezoneCache()
}

async function resetProjection() {
  for (const table of [
    'contact_origin_contact_queue',
    'contact_origin_identity_queue',
    'contact_origin_appointment_queue',
    'contact_origin_generation_gc',
    'contact_origin_appointment_range_point',
    'contact_origin_appointment_range_delta',
    'contact_origin_appointment_fact',
    'contact_origin_daily_rollup',
    'contact_origin_contact_fact',
    'contact_origin_range_generation'
  ]) {
    await db.run(`DELETE FROM ${table}`)
  }
  await db.run(`
    UPDATE contact_origin_projection_state
    SET projection_version = ?, status = 'backfilling',
        active_generation = NULL, active_version = NULL, active_timezone = NULL,
        building_generation = NULL, building_version = NULL, building_timezone = NULL,
        contact_cursor = '', appointment_cursor = '',
        contacts_complete = 0, appointments_complete = 0, range_compiled = 0,
        processed_contacts = 0, processed_appointments = 0,
        last_applied_at = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE singleton_id = 1
  `, [CONTACT_ORIGIN_PROJECTION_VERSION])
}

async function clearFixture() {
  await db.run(`DELETE FROM whatsapp_api_attribution WHERE id LIKE ?`, [`${prefix}%`])
  await db.run(`DELETE FROM whatsapp_api_messages WHERE id LIKE ?`, [`${prefix}%`])
  await db.run(`DELETE FROM whatsapp_attribution WHERE contact_id LIKE ?`, [`${prefix}%`])
  await db.run(`DELETE FROM sessions WHERE session_id LIKE ?`, [`${prefix}%`])
  await db.run(`DELETE FROM appointments WHERE id LIKE ?`, [`${prefix}%`])
  await db.run(`DELETE FROM contact_list_activity WHERE contact_id LIKE ?`, [`${prefix}%`])
  await db.run(`DELETE FROM contacts WHERE id LIKE ?`, [`${prefix}%`])
  await resetProjection()
}

async function insertContact(suffix, source, createdAt) {
  const id = `${prefix}${suffix}`
  await db.run(`
    INSERT INTO contacts(id, full_name, email, source, visitor_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [id, `Contacto ${suffix}`, `${suffix}@origin-projection.test`, source,
    `${prefix}visitor-${suffix}`, createdAt, createdAt])
  await db.run(`
    INSERT INTO contact_list_activity(contact_id, first_payment_date, updated_at)
    VALUES (?, NULL, CURRENT_TIMESTAMP)
  `, [id])
  return id
}

async function insertAppointment(suffix, contactId, day, calendarId) {
  const id = `${prefix}appointment-${suffix}`
  await db.run(`
    INSERT INTO appointments(id, contact_id, calendar_id, date_added, start_time, end_time)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [id, contactId, calendarId, `${day}T12:00:00.000Z`,
    `${day}T12:00:00.000Z`, `${day}T13:00:00.000Z`])
  return id
}

async function runUntilReady() {
  let result
  for (let attempt = 0; attempt < 120; attempt += 1) {
    result = await runContactOriginProjectionBackfill({
      contactBatchSize: 2,
      appointmentBatchSize: 2,
      queueBatchSize: 2,
      maxQueueBatches: 2,
      maxBackfillBatches: 1
    })
    if (result.ready) return result
  }
  assert.fail(`La proyección de origen no convergió: ${JSON.stringify(result)}`)
}

function range(startDay = '2260-07-10', endDay = '2260-07-13') {
  return {
    startUtc: `${startDay}T00:00:00.000Z`,
    endUtc: `${endDay}T23:59:59.999Z`,
    appliedTimezone: 'UTC'
  }
}

function asMap(rows) {
  return new Map(rows.map(row => [row.name, row.value]))
}

test('117 separa dialectos y mantiene triggers limitados a colas', async () => {
  const sqliteSql = await readFile(sqliteMigrationUrl, 'utf8')
  const postgresSql = await readFile(postgresMigrationUrl, 'utf8')
  const postgresVisitorIndexSql = await readFile(postgresVisitorIndexUrl, 'utf8')
  const postgresEmailIndexSql = await readFile(postgresEmailIndexUrl, 'utf8')
  const contactSourceService = await readFile(contactSourceServiceUrl, 'utf8')
  assert.equal(migrationRunsForDialect('117_contact_origin_projection.sqlite.sql', 'sqlite'), true)
  assert.equal(migrationRunsForDialect('117_contact_origin_projection.sqlite.sql', 'postgres'), false)
  assert.equal(migrationRunsForDialect('117a_contact_origin_projection.postgres.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('117a_contact_origin_projection.postgres.sql', 'sqlite'), false)
  assert.equal(migrationRunsForDialect('117b_contact_origin_contacts_visitor.postgres.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('117b_contact_origin_contacts_visitor.postgres.sql', 'sqlite'), false)
  assert.equal(migrationRunsForDialect('117c_contact_origin_contacts_email.postgres.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('117c_contact_origin_contacts_email.postgres.sql', 'sqlite'), false)
  assert.match(sqliteSql, /contact_origin_contact_queue/)
  assert.match(sqliteSql, /contact_origin_identity_queue/)
  assert.match(sqliteSql, /contact_origin_appointment_queue/)
  assert.doesNotMatch(sqliteSql, /CREATE TRIGGER[\s\S]*?COUNT\s*\(/i)
  assert.match(postgresSql, /enqueue_contact_origin_api_attribution_change/)
  assert.match(postgresSql, /enqueue_contact_origin_whatsapp_message_change/)
  assert.match(postgresSql, /old_relevant OR contact_changed/)
  assert.match(postgresSql, /whatsapp_api_message_id/)
  assert.doesNotMatch(postgresSql, /CREATE INDEX CONCURRENTLY/i)
  assert.match(postgresVisitorIndexSql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/)
  assert.match(postgresEmailIndexSql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/)
  assert.doesNotThrow(() => assertConcurrentPostgresMigrationIsIsolated(
    postgresVisitorIndexSql,
    '117b_contact_origin_contacts_visitor.postgres.sql'
  ))
  assert.doesNotThrow(() => assertConcurrentPostgresMigrationIsIsolated(
    postgresEmailIndexSql,
    '117c_contact_origin_contacts_email.postgres.sql'
  ))
  assert.ok(CONTACT_ORIGIN_PROJECTION_LIMITS.queryDeadlineMs <= 8_000)
  assert.ok(CONTACT_ORIGIN_PROJECTION_LIMITS.maxHiddenContactIds <= 10_000)
  assert.match(contactSourceService, /SELECT DISTINCT ON \(contact_id\)/)
  assert.match(contactSourceService, /SELECT DISTINCT ON \(msg\.contact_id\)/)
  assert.match(contactSourceService, /ROW_NUMBER\(\) OVER \([\s\S]*PARTITION BY contact_id/)
  assert.match(contactSourceService, /PARTITION BY msg\.contact_id/)
})

test('117 publica leads, conversiones y citas exactas con dedup multi-calendario', async (t) => {
  if (databaseDialect !== 'sqlite') return t.skip('Fixture SQLite; PostgreSQL se valida por separado')
  await ensureSchema()
  await clearFixture()

  const google = await insertContact('google', 'Directo', '2260-07-10T08:00:00.000Z')
  const facebook = await insertContact('facebook', 'Facebook', '2260-07-10T09:00:00.000Z')
  await insertContact('direct', 'Directo', '2260-07-11T10:00:00.000Z')
  await db.run(`
    INSERT INTO sessions(
      id, session_id, visitor_id, contact_id, email, event_name,
      started_at, created_at, utm_source, source_platform
    ) VALUES (?, ?, ?, ?, ?, 'page_view', ?, ?, 'google', 'google')
  `, [`${prefix}session-google`, `${prefix}session-google`, `${prefix}visitor-google`, google,
    'google@origin-projection.test', '2260-07-09T08:00:00.000Z', '2260-07-09T08:00:00.000Z'])
  await db.run(`UPDATE contact_list_activity SET first_payment_date = ? WHERE contact_id = ?`, [
    '2260-07-12T08:00:00.000Z', google
  ])
  await db.run(`UPDATE contact_list_activity SET first_payment_date = ? WHERE contact_id = ?`, [
    '2260-07-13T08:00:00.000Z', facebook
  ])
  await insertAppointment('google-a', google, '2260-07-11', 'cal-a')
  await insertAppointment('google-b', google, '2260-07-12', 'cal-b')
  await insertAppointment('facebook-a', facebook, '2260-07-11', 'cal-a')

  await runUntilReady()
  const state = await readContactOriginProjectionState()
  assert.equal(state.status, 'ready')
  assert.equal(Number(state.active_version), CONTACT_ORIGIN_PROJECTION_VERSION)

  const all = await queryContactOriginBreakdowns(range())
  assert.deepEqual(all.readPath, {
    leads: 'daily_rollup',
    appointments: 'appointment_range_delta',
    conversions: 'daily_rollup'
  })
  assert.deepEqual(asMap(all.leads), new Map([
    ['Facebook', 1],
    ['Google', 1],
    ['Otro', 1]
  ]))
  assert.deepEqual(asMap(all.appointments), new Map([
    ['Facebook', 1],
    ['Google', 1]
  ]))
  assert.deepEqual(asMap(all.conversions), new Map([
    ['Facebook', 1],
    ['Google', 1]
  ]))

  const calendars = await queryContactOriginBreakdowns(range(), {
    attributionCalendarIds: ['cal-a', 'cal-b']
  })
  assert.equal(calendars.readPath.appointments, 'appointment_presence')
  assert.equal(calendars.readPath.leads, 'daily_rollup')
  assert.equal(calendars.readPath.conversions, 'daily_rollup')
  assert.deepEqual(asMap(calendars.appointments), new Map([
    ['Facebook', 1],
    ['Google', 1]
  ]), 'un contacto con citas en dos calendarios cuenta una sola vez')

  const hidden = await queryContactOriginBreakdowns(range(), {
    hiddenFilters: [{ text: 'Contacto facebook', type: 'exact' }]
  })
  assert.equal(hidden.readPath.leads, 'daily_rollup_minus_hidden')
  assert.equal(hidden.readPath.appointments, 'appointment_range_delta_minus_hidden')
  assert.equal(hidden.readPath.conversions, 'daily_rollup_minus_hidden')
  assert.equal(asMap(hidden.leads).has('Facebook'), false)
  assert.equal(asMap(hidden.appointments).has('Facebook'), false)
  assert.equal(asMap(hidden.conversions).has('Facebook'), false)

  await clearFixture()
})

test('117 sirve la generación activa durante catch-up y reporta pending sin 503', async (t) => {
  if (databaseDialect !== 'sqlite') return t.skip('Fixture SQLite; PostgreSQL se valida por separado')
  await ensureSchema()
  await clearFixture()
  const contactId = await insertContact('busy', 'Facebook', '2260-09-01T08:00:00.000Z')
  await runUntilReady()

  await db.run(`
    INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
    VALUES (?, 1, CURRENT_TIMESTAMP)
  `, [contactId])
  const status = await getContactOriginProjectionStatus({ range: range('2260-09-01', '2260-09-02') })
  assert.equal(status.available, true)
  assert.equal(status.ready, false)
  assert.equal(status.pending, true)

  const result = await queryContactOriginBreakdowns(range('2260-09-01', '2260-09-02'))
  assert.equal(asMap(result.leads).get('Facebook'), 1)
  assert.equal(result.projection.pending, true)
  await clearFixture()
})

test('117 no amplifica una ráfaga normal de chat y sí reconcilia una señal inbound', async (t) => {
  if (databaseDialect !== 'sqlite') return t.skip('Fixture SQLite; PostgreSQL se valida por separado')
  await ensureSchema()
  await clearFixture()
  const contactId = await insertContact('chat-volume', 'Directo', '2260-10-01T08:00:00.000Z')
  await runUntilReady()

  await db.transaction(async transaction => {
    for (let index = 0; index < 1_000; index += 1) {
      await transaction.run(`
        INSERT INTO whatsapp_api_messages(
          id, contact_id, direction, message_timestamp, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, [
        `${prefix}chat-normal-${index}`,
        contactId,
        index % 2 === 0 ? 'outbound' : 'inbound',
        `2260-10-01T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
        '2260-10-01T08:00:00.000Z',
        '2260-10-01T08:00:00.000Z'
      ])
    }
  })
  let queued = await db.get(`
    SELECT revision FROM contact_origin_contact_queue WHERE contact_id = ?
  `, [contactId])
  assert.equal(queued == null, true, 'mensajes sin atribución no deben tocar la cola de origen')

  await db.run(`
    INSERT INTO whatsapp_api_messages(
      id, contact_id, direction, detected_source_app,
      message_timestamp, created_at, updated_at
    ) VALUES (?, ?, 'inbound', 'facebook', ?, ?, ?)
  `, [
    `${prefix}chat-attributed`, contactId,
    '2260-10-01T07:00:00.000Z',
    '2260-10-01T07:00:00.000Z',
    '2260-10-01T07:00:00.000Z'
  ])
  queued = await db.get(`
    SELECT revision FROM contact_origin_contact_queue WHERE contact_id = ?
  `, [contactId])
  assert.equal(Number(queued?.revision), 1)

  await runUntilReady()
  const result = await queryContactOriginBreakdowns(range('2260-10-01', '2260-10-02'))
  assert.equal(asMap(result.leads).get('Facebook'), 1)
  await clearFixture()
})

test('117 reconcilia cambios y mueve también el rollup de rangos sin refetch histórico', async (t) => {
  if (databaseDialect !== 'sqlite') return t.skip('Fixture SQLite; PostgreSQL se valida por separado')
  await ensureSchema()
  await clearFixture()
  const contactId = await insertContact('mutation', 'Facebook', '2260-08-01T08:00:00.000Z')
  const appointmentId = await insertAppointment('mutation', contactId, '2260-08-02', 'cal-a')
  await runUntilReady()

  let result = await queryContactOriginBreakdowns(range('2260-08-01', '2260-08-03'))
  assert.equal(asMap(result.appointments).get('Facebook'), 1)

  await db.run(`UPDATE contacts SET source = 'TikTok', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [contactId])
  await runUntilReady()
  result = await queryContactOriginBreakdowns(range('2260-08-01', '2260-08-03'))
  assert.equal(asMap(result.leads).has('Facebook'), false)
  assert.equal(asMap(result.appointments).has('Facebook'), false)
  assert.equal(asMap(result.appointments).get('TikTok'), 1)

  await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
  await runUntilReady()
  result = await queryContactOriginBreakdowns(range('2260-08-01', '2260-08-03'))
  assert.deepEqual(result.appointments, [])

  await clearFixture()
})
