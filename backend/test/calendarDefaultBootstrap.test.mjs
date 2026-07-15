import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { databaseDialect, db } from '../src/config/database.js'
import { getCalendars } from '../src/controllers/calendarsController.js'
import {
  ensureDefaultLocalCalendar,
  listLocalCalendars,
  upsertLocalCalendar
} from '../src/services/localCalendarService.js'

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

async function clearCalendars() {
  await db.run('DELETE FROM appointments').catch(() => undefined)
  await db.run('DELETE FROM blocked_slots').catch(() => undefined)
  await db.run('DELETE FROM calendars')
}

test('bootstrap concurrente crea un solo calendario semilla con identidad estable', {
  skip: databaseDialect !== 'sqlite'
}, async () => {
  await clearCalendars()

  const calendars = await Promise.all(
    Array.from({ length: 24 }, () => ensureDefaultLocalCalendar())
  )
  const rows = await db.all('SELECT id, name FROM calendars ORDER BY id')

  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'rstk_cal_default')
  assert.equal(rows[0].name, 'Calendario Ristak')
  assert.deepEqual([...new Set(calendars.map(calendar => calendar.id))], ['rstk_cal_default'])
})

test('GET /calendars es lectura pura incluso si la instalación todavía no tiene calendario', {
  skip: databaseDialect !== 'sqlite'
}, async () => {
  await clearCalendars()
  try {
    const response = responseRecorder()
    await getCalendars({ query: {} }, response)

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.body?.data, [])
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM calendars')).total), 0)
  } finally {
    await ensureDefaultLocalCalendar()
  }
})

test('GET detecta la semilla usada con EXISTS sin contar el histórico', {
  skip: databaseDialect !== 'sqlite'
}, async () => {
  const locationId = 'calendar_seed_exists_test'
  const externalCalendarId = 'ghl_cal_seed_exists_test'
  const appointmentId = 'rstk_appt_seed_exists_test'
  await clearCalendars()

  try {
    await ensureDefaultLocalCalendar()
    await db.run(
      'INSERT INTO highlevel_config (location_id, api_token) VALUES (?, ?)',
      [locationId, 'test-only-token']
    )
    await upsertLocalCalendar({
      id: externalCalendarId,
      ghlCalendarId: externalCalendarId,
      locationId,
      name: 'Agenda externa de prueba',
      source: 'ghl'
    }, { source: 'ghl', syncStatus: 'synced' })

    const emptySeedCalendars = await listLocalCalendars({ sourcePreference: 'combined' })
    assert.deepEqual(emptySeedCalendars.map(calendar => calendar.id), [externalCalendarId])

    await db.run(`
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

    const usedSeedCalendars = await listLocalCalendars({ sourcePreference: 'combined' })
    assert.deepEqual(
      new Set(usedSeedCalendars.map(calendar => calendar.id)),
      new Set(['rstk_cal_default', externalCalendarId])
    )
  } finally {
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [externalCalendarId]).catch(() => undefined)
    await db.run('DELETE FROM highlevel_config WHERE location_id = ?', [locationId]).catch(() => undefined)
    await ensureDefaultLocalCalendar()
  }
})

test('el startup posee el bootstrap y el servicio cierra carreras en ambos dialectos', async () => {
  const [controller, service, server] = await Promise.all([
    readFile(new URL('../src/controllers/calendarsController.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/localCalendarService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.js', import.meta.url), 'utf8')
  ])
  const getCalendarsBody = controller.slice(
    controller.indexOf('export async function getCalendars'),
    controller.indexOf('export async function createCalendar')
  )
  const bootstrapBody = service.slice(
    service.indexOf('export async function ensureDefaultLocalCalendar'),
    service.indexOf('function appointmentRowToApi', service.indexOf('export async function ensureDefaultLocalCalendar'))
  )

  assert.doesNotMatch(getCalendarsBody, /ensureDefaultLocalCalendar|createLocalCalendar|INSERT|UPDATE|DELETE/)
  assert.match(server, /await ensureDefaultLocalCalendar\(\)/)
  assert.match(bootstrapBody, /db\.transaction/)
  assert.match(bootstrapBody, /pg_advisory_xact_lock/)
  assert.match(bootstrapBody, /id: DEFAULT_LOCAL_CALENDAR_ID/)
  assert.match(bootstrapBody, /defaultLocalCalendarBootstrapPromise/)
  assert.match(service, /DEFAULT_LOCAL_CALENDAR_ID = 'rstk_cal_default'/)
})
