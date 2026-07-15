import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { databaseDialect, db } from '../src/config/database.js'
import {
  getLocalAppointmentStats,
  listUpcomingLocalAppointmentsPage,
  upsertLocalCalendar
} from '../src/services/localCalendarService.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..')

function decodeCursor(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

test('próximas citas pagina por tupla exacta, limita filas y liga el cursor al calendario', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_upcoming_${suffix}`
  const otherCalendarId = `rstk_cal_upcoming_other_${suffix}`
  const startTime = '2099-09-12T15:30:00.123456Z'
  const endTime = '2099-09-12T16:00:00.123456Z'
  const appointmentIds = []

  try {
    await Promise.all([
      upsertLocalCalendar({ id: calendarId, name: 'Agenda keyset', source: 'ristak' }, { source: 'ristak', syncStatus: 'synced' }),
      upsertLocalCalendar({ id: otherCalendarId, name: 'Otra agenda', source: 'ristak' }, { source: 'ristak', syncStatus: 'synced' })
    ])

    for (let index = 0; index < 45; index += 1) {
      const id = `rstk_appt_upcoming_${suffix}_${String(index).padStart(3, '0')}`
      appointmentIds.push(id)
      const status = index < 32
        ? 'confirmed'
        : index < 36
          ? 'showed'
          : index < 39
            ? 'cancelled'
            : index < 41
              ? 'rescheduled'
              : index < 43
                ? 'noshow'
                : 'pending'
      await db.run(`
        INSERT INTO appointments (
          id, calendar_id, title, status, appointment_status, start_time, end_time,
          date_added, date_updated, sync_status, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', NULL)
      `, [id, calendarId, `Cita ${index}`, status, status, startTime, endTime, startTime, startTime])
    }

    const first = await listUpcomingLocalAppointmentsPage({
      calendarId,
      limit: 20,
      now: '2099-09-01T00:00:00.000Z'
    })
    assert.equal(first.items.length, 20)
    assert.equal(first.pagination.limit, 20)
    assert.equal(first.pagination.hasNext, true)
    assert.ok(first.pagination.nextCursor)
    assert.deepEqual(first.items.map(item => item.id), appointmentIds.slice(0, 20))

    const decoded = decodeCursor(first.pagination.nextCursor)
    assert.equal(decoded.v, 2)
    assert.equal(decoded.kind, 'upcoming-appointments')
    assert.match(decoded.scope, /^[A-Za-z0-9_-]{40,}$/)
    if (databaseDialect === 'postgres') {
      assert.match(decoded.startTime, /15:30:00\.123456/)
    } else {
      assert.equal(decoded.startTime, startTime)
    }

    if (databaseDialect === 'sqlite') {
      const sqliteMigration = await readFile(
        join(repoRoot, 'backend/migrations/versioned/095_upcoming_appointments_page.sqlite.sql'),
        'utf8'
      )
      await db.exec(sqliteMigration)
      const plan = await db.all(`
        EXPLAIN QUERY PLAN
        SELECT a.id
        FROM appointments a
        WHERE a.calendar_id = ?
          AND a.start_time IS NOT NULL
          AND julianday(a.start_time) >= julianday(?)
          AND COALESCE(a.sync_status, '') != 'pending_delete'
          AND a.deleted_at IS NULL
        ORDER BY julianday(a.start_time) ASC, a.id ASC
        LIMIT ?
      `, [calendarId, '2099-09-01T00:00:00.000Z', 21])
      assert.match(plan.map(row => row.detail || '').join('\n'), /idx_appointments_upcoming_page/)
    } else {
      const postgresMigration = await readFile(
        join(repoRoot, 'backend/migrations/versioned/095a_upcoming_appointments_page.postgres.sql'),
        'utf8'
      )
      await db.exec(postgresMigration)
      const index = await db.get(`
        SELECT indexdef
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = 'idx_appointments_upcoming_page'
      `)
      assert.ok(index?.indexdef)
      assert.match(index.indexdef, /\(calendar_id, start_time, id\)/)
      assert.match(index.indexdef, /start_time IS NOT NULL/)
      assert.match(index.indexdef, /deleted_at IS NULL/)
      assert.match(index.indexdef, /COALESCE\(sync_status, ''::text\) <> 'pending_delete'::text/)
    }

    const second = await listUpcomingLocalAppointmentsPage({
      calendarId,
      cursor: first.pagination.nextCursor,
      limit: 20,
      now: '2099-09-01T00:00:00.000Z'
    })
    assert.deepEqual(second.items.map(item => item.id), appointmentIds.slice(20, 40))
    assert.equal(second.items.some(item => first.items.some(previous => previous.id === item.id)), false)

    const third = await listUpcomingLocalAppointmentsPage({
      calendarId,
      cursor: second.pagination.nextCursor,
      limit: 20,
      now: '2099-09-01T00:00:00.000Z'
    })
    assert.deepEqual(third.items.map(item => item.id), appointmentIds.slice(40))
    assert.equal(third.pagination.hasNext, false)
    assert.equal(third.pagination.nextCursor, null)

    await assert.rejects(
      listUpcomingLocalAppointmentsPage({
        calendarId: otherCalendarId,
        cursor: first.pagination.nextCursor,
        now: '2099-09-01T00:00:00.000Z'
      }),
      error => error?.status === 400 && error?.code === 'invalid_upcoming_appointments_cursor'
    )
    await assert.rejects(
      listUpcomingLocalAppointmentsPage({ calendarId, cursor: 'cursor-roto' }),
      error => error?.status === 400 && error?.code === 'invalid_upcoming_appointments_cursor'
    )

    const stats = await getLocalAppointmentStats({
      calendarId,
      startTime: '2099-09-01T00:00:00.000Z',
      endTime: '2099-09-30T23:59:59.999Z',
      now: '2099-09-02T00:00:00.000Z'
    })
    assert.deepEqual(stats, {
      pending: 32,
      cancelled: 3,
      confirmed: 0,
      rescheduled: 2,
      showed: 4,
      noshow: 2
    })
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id IN (?, ?)', [calendarId, otherCalendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id IN (?, ?)', [calendarId, otherCalendarId]).catch(() => undefined)
  }
})

test('los GET de navegación de Calendario son lecturas locales y sus índices coinciden con el orden', async () => {
  const [
    controller,
    routes,
    service,
    sqliteMigration,
    postgresMigration,
    sqliteOverviewMigration,
    postgresOverviewMigration,
    highlevelController,
    integrationRegistry,
    highlevelWebhook,
    googleCron
  ] = await Promise.all([
    readFile(join(repoRoot, 'backend/src/controllers/calendarsController.js'), 'utf8'),
    readFile(join(repoRoot, 'backend/src/routes/calendars.routes.js'), 'utf8'),
    readFile(join(repoRoot, 'backend/src/services/localCalendarService.js'), 'utf8'),
    readFile(join(repoRoot, 'backend/migrations/versioned/095_upcoming_appointments_page.sqlite.sql'), 'utf8'),
    readFile(join(repoRoot, 'backend/migrations/versioned/095a_upcoming_appointments_page.postgres.sql'), 'utf8'),
    readFile(join(repoRoot, 'backend/migrations/versioned/107_appointments_multi_calendar_overview.sqlite.sql'), 'utf8'),
    readFile(join(repoRoot, 'backend/migrations/versioned/107a_appointments_multi_calendar_overview.postgres.sql'), 'utf8'),
    readFile(join(repoRoot, 'backend/src/controllers/highlevelController.js'), 'utf8'),
    readFile(join(repoRoot, 'backend/src/jobs/integrationCronRegistry.js'), 'utf8'),
    readFile(join(repoRoot, 'backend/src/controllers/webhooksController.js'), 'utf8'),
    readFile(join(repoRoot, 'backend/src/jobs/googleCalendarSync.cron.js'), 'utf8')
  ])

  const calendarsRead = controller.slice(
    controller.indexOf('export async function getCalendars'),
    controller.indexOf('export async function createCalendar')
  )
  const eventsRead = controller.slice(
    controller.indexOf('export async function getEvents'),
    controller.indexOf('export async function getUpcomingAppointments')
  )
  assert.doesNotMatch(calendarsRead, /getHighLevelContext|calendarService\.|googleCalendarService\./)
  assert.doesNotMatch(calendarsRead, /reconcileCalendarDefaults/)
  assert.doesNotMatch(calendarsRead, /ensureDefaultLocalCalendar|createLocalCalendar/)
  assert.doesNotMatch(eventsRead, /getHighLevelContext|calendarService\.|googleCalendarService\./)
  assert.match(eventsRead, /listLocalAppointments/)
  assert.match(eventsRead, /listLocalAppointmentMonthPreview/)
  assert.match(eventsRead, /listVisibleLocalAppointmentsPage/)
  assert.match(eventsRead, /getLocalAppointmentDayCounts/)
  assert.match(eventsRead, /getLocalAppointmentsOverview/)
  assert.match(eventsRead, /createCalendarRequestAbortScope/)

  assert.ok(routes.indexOf("router.get('/events/month-preview'") < routes.indexOf("router.get('/events/:eventId'"))
  assert.ok(routes.indexOf("router.get('/events/page'") < routes.indexOf("router.get('/events/:eventId'"))
  assert.ok(routes.indexOf("router.get('/events/day-counts'") < routes.indexOf("router.get('/events/:eventId'"))
  assert.ok(routes.indexOf("router.get('/events/overview'") < routes.indexOf("router.get('/events/:eventId'"))
  assert.ok(routes.indexOf("router.get('/events/summary'") < routes.indexOf("router.get('/events/:eventId'"))
  assert.match(routes, /router\.get\('\/upcoming', calendarsController\.getUpcomingAppointments\)/)

  const pageQuery = service.slice(
    service.indexOf('export async function listUpcomingLocalAppointmentsPage'),
    service.indexOf('export async function getLocalAppointmentStats')
  )
  assert.match(pageQuery, /hashPaginationCursorScope|cursorScope/)
  assert.match(pageQuery, /ORDER BY \$\{sql\.sort\} ASC, a\.id ASC/)
  assert.match(pageQuery, /LIMIT \?/)
  assert.match(pageQuery, /normalizedLimit \+ 1/)
  assert.match(pageQuery, /_cursor_start_time/)
  assert.match(service, /\(\$\{alias\}\.start_time, \$\{alias\}\.id\) > \(CAST\(\? AS TIMESTAMP\), \?\)/)
  assert.match(service, /\(julianday\(\$\{alias\}\.start_time\), \$\{alias\}\.id\) > \(julianday\(\?\), \?\)/)
  assert.match(service, /MONTH_APPOINTMENT_PREVIEW_MAX_LIMIT = 5/)
  assert.match(service, /dayBounds\.bounds\.length > 45/)
  assert.match(service, /normalizedLimit \+ 1/)
  assert.match(service, /getLocalAppointmentDayCounts/)
  assert.match(service, /COUNT\(a\.id\) AS total/)

  const seedUsageRead = service.slice(
    service.indexOf('async function getCalendarAppointmentCounts'),
    service.indexOf('function calendarHasAppointments')
  )
  assert.match(seedUsageRead, /WHERE EXISTS/)
  assert.match(seedUsageRead, /idx_appointments_upcoming_page/)
  assert.doesNotMatch(seedUsageRead, /SELECT\s+COUNT\s*\(/i)
  assert.match(service, /calendars\.filter\(isLikelySeedRistakCalendar\)/)

  assert.match(sqliteMigration, /appointments\(calendar_id, julianday\(start_time\), id\)/)
  assert.match(postgresMigration, /appointments\(calendar_id, start_time, id\)/)
  assert.match(postgresMigration, /CREATE INDEX CONCURRENTLY/)
  assert.match(sqliteOverviewMigration, /appointments\(julianday\(start_time\), id\)/)
  assert.match(postgresOverviewMigration, /appointments\(start_time, id\)/)
  assert.match(postgresOverviewMigration, /CREATE INDEX CONCURRENTLY/)

  // El GET ya no es dueño de la frescura. La primera conexión, los webhooks,
  // los crons condicionales y la acción manual sí mantienen el espejo local.
  const highlevelConnect = highlevelController.slice(
    highlevelController.indexOf('export const saveConfig'),
    highlevelController.indexOf('export const getConfig')
  )
  assert.match(highlevelConnect, /syncRegisteredIntegrationCronsForProvider\('highlevel'/)
  assert.match(highlevelConnect, /syncHighLevelData\(cleanLocationId, cleanToken\)/)
  assert.match(integrationRegistry, /name: 'highlevel-sync'[\s\S]*start: startHighLevelSyncCron/)
  assert.match(integrationRegistry, /name: 'google-calendar-sync'[\s\S]*start: startGoogleCalendarSyncCron/)
  assert.match(highlevelWebhook, /reconcileInboundHighLevelAppointment/)
  assert.match(googleCron, /retryGoogleCalendarSync/)

  const googleManualSync = controller.slice(
    controller.indexOf('export async function syncGoogleCalendarIntegration'),
    controller.indexOf('export async function listGoogleCalendarOptions')
  )
  const googleInitialLink = controller.slice(
    controller.indexOf('export async function updateCalendarGoogleSync'),
    controller.indexOf('export async function getGoogleCalendarMergePreview')
  )
  assert.match(googleManualSync, /syncGoogleIntegrationNow/)
  assert.match(googleInitialLink, /syncGoogleEventsToLocal/)
  assert.ok(['sqlite', 'postgres'].includes(databaseDialect))
})
