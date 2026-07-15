import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

function collectPlanNodes(plan, rows = []) {
  if (!plan || typeof plan !== 'object') return rows
  rows.push(plan)
  for (const child of plan.Plans || []) collectPlanNodes(child, rows)
  return rows
}

test('PostgreSQL abre 100k citas con previews acotados, conteos exactos e índice keyset', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const databaseUrl = new URL(process.env.DATABASE_URL)
  const pg = await import('pg')
  const OriginalPool = pg.default.Pool
  if (['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname)) {
    pg.default.Pool = class LocalPostgresTestPool extends OriginalPool {
      constructor(options) {
        super({ ...options, ssl: false })
      }
    }
  }

  let database
  let calendarService
  try {
    [database, calendarService] = await Promise.all([
      import('../src/config/database.js'),
      import('../src/services/localCalendarService.js')
    ])
  } finally {
    pg.default.Pool = OriginalPool
  }
  assert.equal(database.databaseDialect, 'postgres')

  const marker = `calendar_dense_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const schema = marker.replace(/[^a-z0-9_]/gi, '_').toLowerCase()
  const calendarId = `${marker}_calendar`
  const microsecondCalendarId = `${marker}_microsecond_calendar`
  const directClient = new pg.default.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: ['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname)
      ? false
      : { rejectUnauthorized: false }
  })
  await directClient.connect()

  try {
    await directClient.query(`CREATE SCHEMA "${schema}"`)
    await directClient.query(`SET search_path TO "${schema}"`)
    await directClient.query(`
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        full_name TEXT,
        email TEXT,
        phone TEXT
      );
      CREATE TABLE appointments (
        id TEXT PRIMARY KEY,
        calendar_id TEXT NOT NULL,
        contact_id TEXT,
        title TEXT,
        status TEXT,
        appointment_status TEXT,
        start_time TIMESTAMP,
        end_time TIMESTAMP,
        date_added TIMESTAMP,
        date_updated TIMESTAMP,
        sync_status TEXT,
        deleted_at TIMESTAMP
      );
    `)
    const migration = await readFile(
      new URL('../migrations/versioned/095a_upcoming_appointments_page.postgres.sql', import.meta.url),
      'utf8'
    )
    await directClient.query(migration)
    const overviewMigration = await readFile(
      new URL('../migrations/versioned/107a_appointments_multi_calendar_overview.postgres.sql', import.meta.url),
      'utf8'
    )
    await directClient.query(overviewMigration)
    await directClient.query(`
      INSERT INTO appointments (
        id, calendar_id, title, status, appointment_status, start_time, end_time,
        date_added, date_updated, sync_status, deleted_at
      )
      SELECT
        $1 || '_' || LPAD(sequence::text, 6, '0'),
        $2,
        'Cita ' || sequence,
        'confirmed',
        'confirmed',
        TIMESTAMP '2099-06-01 04:00:00'
          + ((sequence - 1) % 7) * INTERVAL '1 day'
          + (((sequence - 1) / 7)::int % 300) * INTERVAL '1 second',
        TIMESTAMP '2099-06-01 04:30:00'
          + ((sequence - 1) % 7) * INTERVAL '1 day'
          + (((sequence - 1) / 7)::int % 300) * INTERVAL '1 second',
        TIMESTAMP '2099-01-01 00:00:00',
        TIMESTAMP '2099-01-01 00:00:00',
        'synced',
        NULL
      FROM generate_series(1, 100000) sequence
    `, [marker, calendarId])
    await directClient.query(`
      INSERT INTO appointments (
        id, calendar_id, title, status, appointment_status, start_time, end_time,
        date_added, date_updated, sync_status, deleted_at
      ) VALUES (
        $1, $2, 'Último microsegundo', 'confirmed', 'confirmed',
        TIMESTAMP '2099-06-08 03:59:59.999500',
        TIMESTAMP '2099-06-08 03:59:59.999500',
        TIMESTAMP '2099-01-01 00:00:00', TIMESTAMP '2099-01-01 00:00:00',
        'synced', NULL
      )
    `, [`${marker}_microsecond`, microsecondCalendarId])
    await directClient.query('ANALYZE appointments')

    await database.db.transaction(async transaction => {
      await transaction.run(`SET LOCAL search_path TO "${schema}"`)
      const range = {
        calendarId,
        startTime: '2099-06-01T04:00:00.000Z',
        endTime: '2099-06-08T03:59:59.999Z',
        timezone: 'America/New_York'
      }

      const month = await calendarService.listLocalAppointmentMonthPreview({
        ...range,
        previewLimit: 3
      })
      assert.equal(month.total, 100000)
      assert.equal(month.days.length, 7)
      assert.equal(month.days.reduce((sum, day) => sum + day.total, 0), 100000)
      assert.equal(month.days.flatMap(day => day.items).length, 21)

      const first = await calendarService.listVisibleLocalAppointmentsPage({
        ...range,
        limit: 100
      })
      assert.equal(first.total, 100000)
      assert.equal(first.items.length, 100)
      assert.equal(first.pagination.hasNext, true)
      assert.ok(first.pagination.nextCursor)

      const overview = await calendarService.getLocalAppointmentsOverview({
        startTime: range.startTime,
        endTime: range.endTime,
        now: range.startTime,
        limit: 5
      })
      assert.equal(overview.stats.pending, 100001)
      assert.equal(Object.values(overview.stats).reduce((sum, value) => sum + value, 0), 100001)
      assert.equal(overview.upcoming.length, 5)
      assert.equal(overview.limit, 5)

      const overviewPlanRows = await transaction.all(`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF)
        SELECT a.id
        FROM appointments a
        WHERE a.start_time IS NOT NULL
          AND a.start_time >= CAST(? AS TIMESTAMP)
          AND a.start_time < CAST(? AS TIMESTAMP)
          AND COALESCE(a.sync_status, '') != 'pending_delete'
          AND a.deleted_at IS NULL
        ORDER BY a.start_time ASC, a.id ASC
        LIMIT 5
      `, [range.startTime, '2099-06-08T04:00:00.000Z'])
      const overviewPlan = overviewPlanRows[0]['QUERY PLAN'][0]
      const overviewNodes = collectPlanNodes(overviewPlan.Plan)
      assert.ok(overviewNodes.some(node => node['Index Name'] === 'idx_appointments_multi_calendar_overview'))
      assert.ok(Number(overviewPlan['Execution Time']) < 1000, `el overview tardó ${overviewPlan['Execution Time']}ms`)

      const second = await calendarService.listVisibleLocalAppointmentsPage({
        ...range,
        cursor: first.pagination.nextCursor,
        limit: 100,
        includeCounts: false
      })
      assert.equal(second.items.length, 100)
      assert.equal(second.items.some(item => first.items.some(previous => previous.id === item.id)), false)
      assert.equal(Object.hasOwn(second, 'total'), false)

      const finalMillisecond = await calendarService.listVisibleLocalAppointmentsPage({
        calendarId: microsecondCalendarId,
        startTime: '2099-06-08T03:59:59.999Z',
        endTime: '2099-06-08T03:59:59.999Z',
        timezone: 'America/New_York',
        limit: 5
      })
      assert.equal(finalMillisecond.total, 1)
      assert.deepEqual(finalMillisecond.items.map(item => item.id), [`${marker}_microsecond`])

      const planRows = await transaction.all(`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF)
        SELECT a.id
        FROM appointments a
        WHERE a.calendar_id = ?
          AND a.start_time IS NOT NULL
          AND a.start_time >= CAST(? AS TIMESTAMP)
          AND a.start_time <= CAST(? AS TIMESTAMP)
          AND COALESCE(a.sync_status, '') != 'pending_delete'
          AND a.deleted_at IS NULL
        ORDER BY a.start_time ASC, a.id ASC
        LIMIT 101
      `, [calendarId, range.startTime, range.endTime])
      const plan = planRows[0]['QUERY PLAN'][0]
      const nodes = collectPlanNodes(plan.Plan)
      assert.ok(nodes.some(node => node['Index Name'] === 'idx_appointments_upcoming_page'))
      assert.ok(Number(plan['Execution Time']) < 2000, `la página densa tardó ${plan['Execution Time']}ms`)
    })
  } finally {
    await directClient.query('SET search_path TO public').catch(() => undefined)
    await directClient.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await directClient.end().catch(() => undefined)
  }
})
