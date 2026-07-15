import assert from 'node:assert/strict'
import test from 'node:test'

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    }
  }
}

test('PostgreSQL inicializa una sola agenda y GET sigue puro', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const databaseUrl = new URL(process.env.DATABASE_URL)
  const pg = await import('pg')
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname)
  const schema = `calendar_bootstrap_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    .replace(/[^a-z0-9_]/gi, '_')
    .toLowerCase()
  const admin = new pg.default.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: localHost ? false : { rejectUnauthorized: false }
  })
  await admin.connect()
  let schemaCreated = false
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    schemaCreated = true

    const OriginalPool = pg.default.Pool
    pg.default.Pool = class ScopedCalendarBootstrapPool extends OriginalPool {
      constructor(options) {
        super({
          ...options,
          ...(localHost ? { ssl: false } : {}),
          options: `${options?.options || ''} -c search_path=${schema}`.trim()
        })
      }
    }

    let database
    let calendarService
    let controller
    try {
      [database, calendarService, controller] = await Promise.all([
        import('../src/config/database.js'),
        import('../src/services/localCalendarService.js'),
        import('../src/controllers/calendarsController.js')
      ])
    } finally {
      pg.default.Pool = OriginalPool
    }

    assert.equal(database.databaseDialect, 'postgres')
    await database.databaseReady

    const results = await Promise.all(
      Array.from({ length: 24 }, () => calendarService.ensureDefaultLocalCalendar())
    )
    const rows = await database.db.all('SELECT id, name FROM calendars ORDER BY id')
    assert.deepEqual(rows, [{ id: 'rstk_cal_default', name: 'Calendario Ristak' }])
    assert.deepEqual([...new Set(results.map(calendar => calendar.id))], ['rstk_cal_default'])

    const externalCalendarId = 'ghl_cal_seed_exists_test'
    const appointmentId = 'rstk_appt_seed_exists_test'
    await database.db.run(
      'INSERT INTO highlevel_config (location_id, api_token) VALUES (?, ?)',
      ['calendar_seed_exists_test', 'test-only-token']
    )
    await calendarService.upsertLocalCalendar({
      id: externalCalendarId,
      ghlCalendarId: externalCalendarId,
      locationId: 'calendar_seed_exists_test',
      name: 'Agenda externa de prueba',
      source: 'ghl'
    }, { source: 'ghl', syncStatus: 'synced' })

    const emptySeedCalendars = await calendarService.listLocalCalendars({ sourcePreference: 'combined' })
    assert.deepEqual(emptySeedCalendars.map(calendar => calendar.id), [externalCalendarId])

    await database.db.run(`
      INSERT INTO appointments (
        id, calendar_id, title, status, appointment_status, start_time, end_time,
        date_added, date_updated, sync_status, deleted_at
      ) VALUES (?, ?, 'Cita semilla', 'confirmed', 'confirmed', ?, ?, ?, ?, 'synced', NULL)
    `, [
      appointmentId,
      'rstk_cal_default',
      '2099-01-01T16:00:00.000Z',
      '2099-01-01T17:00:00.000Z',
      '2099-01-01T16:00:00.000Z',
      '2099-01-01T16:00:00.000Z'
    ])
    const usedSeedCalendars = await calendarService.listLocalCalendars({ sourcePreference: 'combined' })
    assert.deepEqual(
      new Set(usedSeedCalendars.map(calendar => calendar.id)),
      new Set(['rstk_cal_default', externalCalendarId])
    )

    await database.db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
    await database.db.run('DELETE FROM highlevel_config WHERE location_id = ?', ['calendar_seed_exists_test'])
    await database.db.run('DELETE FROM calendars')
    const response = responseRecorder()
    await controller.getCalendars({ query: {} }, response)
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.body?.data, [])
    assert.equal(Number((await database.db.get('SELECT COUNT(*) AS total FROM calendars')).total), 0)
  } finally {
    if (schemaCreated) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    }
    await admin.end().catch(() => undefined)
  }
})
