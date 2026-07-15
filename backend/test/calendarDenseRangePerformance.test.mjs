import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { databaseDialect, db } from '../src/config/database.js'
import {
  buildAppointmentBusinessDayBounds,
  getLocalAppointmentDayCounts,
  getLocalAppointmentsOverview,
  listLocalAppointmentMonthPreview,
  listVisibleLocalAppointmentsPage,
  upsertLocalCalendar
} from '../src/services/localCalendarService.js'

const BUSINESS_TIMEZONE = 'America/New_York'

async function deleteCalendars(calendarIds) {
  const placeholders = calendarIds.map(() => '?').join(', ')
  await db.run(`DELETE FROM appointments WHERE calendar_id IN (${placeholders})`, calendarIds).catch(() => undefined)
  await db.run(`DELETE FROM calendars WHERE id IN (${placeholders})`, calendarIds).catch(() => undefined)
}

test('Calendario denso limita previews, cuenta por día del negocio y pagina sin huecos', {
  skip: databaseDialect !== 'sqlite'
}, async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_dense_${suffix}`
  const boundaryCalendarId = `rstk_cal_boundary_${suffix}`
  const prefix = `rstk_appt_dense_${suffix}`
  const calendarIds = [calendarId, boundaryCalendarId]

  await db.exec(await readFile(
    new URL('../migrations/versioned/095_upcoming_appointments_page.sqlite.sql', import.meta.url),
    'utf8'
  ))
  await db.exec(await readFile(
    new URL('../migrations/versioned/107_appointments_multi_calendar_overview.sqlite.sql', import.meta.url),
    'utf8'
  ))
  await deleteCalendars(calendarIds)

  try {
    await Promise.all([
      upsertLocalCalendar({ id: calendarId, name: 'Agenda densa', source: 'ristak' }, { source: 'ristak', syncStatus: 'synced' }),
      upsertLocalCalendar({ id: boundaryCalendarId, name: 'Agenda de límites', source: 'ristak' }, { source: 'ristak', syncStatus: 'synced' })
    ])

    // 7,000 citas, 1,000 por día del negocio. Los empates de timestamp fuerzan
    // al cursor a usar también el id y detectan cualquier salto o duplicado.
    await db.run(`
      WITH RECURSIVE dense_appointments(sequence) AS (
        SELECT 1
        UNION ALL
        SELECT sequence + 1
        FROM dense_appointments
        WHERE sequence < 7000
      )
      INSERT INTO appointments (
        id, calendar_id, title, status, appointment_status, start_time, end_time,
        date_added, date_updated, sync_status, deleted_at
      )
      SELECT
        ? || '_' || printf('%05d', sequence),
        ?,
        'Cita ' || sequence,
        'confirmed',
        'confirmed',
        datetime(
          '2099-06-01T04:00:00Z',
          '+' || ((sequence - 1) % 7) || ' days',
          '+' || (CAST((sequence - 1) / 7 AS INTEGER) % 300) || ' seconds'
        ),
        datetime(
          '2099-06-01T04:30:00Z',
          '+' || ((sequence - 1) % 7) || ' days',
          '+' || (CAST((sequence - 1) / 7 AS INTEGER) % 300) || ' seconds'
        ),
        '2099-01-01T00:00:00.000Z',
        '2099-01-01T00:00:00.000Z',
        'synced',
        NULL
      FROM dense_appointments
    `, [prefix, calendarId])

    const range = {
      calendarId,
      startTime: '2099-06-01T04:00:00.000Z',
      endTime: '2099-06-08T03:59:59.999Z',
      timezone: BUSINESS_TIMEZONE
    }
    const month = await listLocalAppointmentMonthPreview({
      ...range,
      previewLimit: 2
    })
    assert.equal(month.timezone, BUSINESS_TIMEZONE)
    assert.equal(month.total, 7000)
    assert.equal(month.days.length, 7)
    assert.deepEqual(month.days.map(day => day.total), Array(7).fill(1000))
    assert.equal(month.days.flatMap(day => day.items).length, 14)
    assert.ok(month.days.every(day => day.items.length === 2))

    const overview = await getLocalAppointmentsOverview({
      startTime: range.startTime,
      endTime: range.endTime,
      now: range.startTime,
      limit: 5
    })
    assert.equal(overview.stats.pending, 7000)
    assert.equal(Object.values(overview.stats).reduce((sum, value) => sum + value, 0), 7000)
    assert.equal(overview.upcoming.length, 5)
    assert.equal(overview.limit, 5)

    const overviewPlan = await db.all(`
      EXPLAIN QUERY PLAN
      SELECT a.id
      FROM appointments a
      WHERE a.start_time IS NOT NULL
        AND julianday(a.start_time) >= julianday(?)
        AND julianday(a.start_time) < julianday(?)
        AND COALESCE(a.sync_status, '') != 'pending_delete'
        AND a.deleted_at IS NULL
      ORDER BY julianday(a.start_time) ASC, a.id ASC
      LIMIT 5
    `, [range.startTime, '2099-06-08T04:00:00.000Z'])
    assert.match(
      overviewPlan.map(row => row.detail || '').join('\n'),
      /idx_appointments_multi_calendar_overview/
    )

    const clampedMonth = await listLocalAppointmentMonthPreview({
      ...range,
      previewLimit: 999
    })
    assert.equal(clampedMonth.previewLimit, 5)
    assert.equal(clampedMonth.days.flatMap(day => day.items).length, 35)
    await assert.rejects(
      listLocalAppointmentMonthPreview({
        calendarId,
        startTime: '2099-06-01T04:00:00.000Z',
        endTime: '2099-07-17T03:59:59.999Z',
        timezone: BUSINESS_TIMEZONE
      }),
      error => error?.status === 400 && /45 días/.test(error.message)
    )

    const clampedPage = await listVisibleLocalAppointmentsPage({
      ...range,
      limit: 999,
      includeCounts: false
    })
    assert.equal(clampedPage.pagination.limit, 200)
    assert.equal(clampedPage.items.length, 200)

    const seen = new Set()
    let cursor = null
    let pageNumber = 0
    do {
      const page = await listVisibleLocalAppointmentsPage({
        ...range,
        cursor,
        limit: 100,
        includeCounts: pageNumber === 0
      })
      assert.ok(page.items.length <= 100)
      page.items.forEach(item => seen.add(item.id))
      if (pageNumber === 0) {
        assert.equal(page.total, 7000)
        assert.deepEqual(page.days.map(day => day.total), Array(7).fill(1000))
      } else {
        assert.equal(Object.hasOwn(page, 'total'), false)
        assert.equal(Object.hasOwn(page, 'days'), false)
      }
      pageNumber += 1
      cursor = page.pagination.nextCursor
      assert.equal(page.pagination.hasNext, Boolean(cursor))
    } while (cursor)

    assert.equal(pageNumber, 70)
    assert.equal(seen.size, 7000)

    const firstPage = await listVisibleLocalAppointmentsPage({ ...range, limit: 5 })
    await assert.rejects(
      listVisibleLocalAppointmentsPage({
        ...range,
        endTime: '2099-06-07T03:59:59.999Z',
        cursor: firstPage.pagination.nextCursor,
        limit: 5
      }),
      error => error?.status === 400 && error?.code === 'invalid_visible_appointments_cursor'
    )
    await assert.rejects(
      listVisibleLocalAppointmentsPage({
        ...range,
        timezone: 'UTC',
        cursor: firstPage.pagination.nextCursor,
        limit: 5
      }),
      error => error?.status === 400 && error?.code === 'invalid_visible_appointments_cursor'
    )
    await assert.rejects(
      listVisibleLocalAppointmentsPage({
        ...range,
        calendarId: boundaryCalendarId,
        cursor: firstPage.pagination.nextCursor,
        limit: 5
      }),
      error => error?.status === 400 && error?.code === 'invalid_visible_appointments_cursor'
    )

    const plan = await db.all(`
      EXPLAIN QUERY PLAN
      SELECT a.id
      FROM appointments a
      WHERE a.calendar_id = ?
        AND a.start_time IS NOT NULL
        AND julianday(a.start_time) >= julianday(?)
        AND julianday(a.start_time) <= julianday(?)
        AND COALESCE(a.sync_status, '') != 'pending_delete'
        AND a.deleted_at IS NULL
      ORDER BY julianday(a.start_time) ASC, a.id ASC
      LIMIT 101
    `, [calendarId, range.startTime, range.endTime])
    assert.match(plan.map(row => row.detail || '').join('\n'), /idx_appointments_upcoming_page/)

    const boundaryInstants = [
      ['before-midnight', '2099-06-01T03:59:59.000Z'],
      ['at-midnight', '2099-06-01T04:00:00.000Z'],
      ['before-next-midnight', '2099-06-02T03:59:59.000Z'],
      ['next-midnight', '2099-06-02T04:00:00.000Z']
    ]
    await db.transaction(async transaction => {
      for (const [id, instant] of boundaryInstants) {
        await transaction.run(`
          INSERT INTO appointments (
            id, calendar_id, title, status, appointment_status, start_time, end_time,
            date_added, date_updated, sync_status, deleted_at
          ) VALUES (?, ?, ?, 'confirmed', 'confirmed', ?, ?, ?, ?, 'synced', NULL)
        `, [`${prefix}_${id}`, boundaryCalendarId, id, instant, instant, instant, instant])
      }
    })
    const boundaryCounts = await getLocalAppointmentDayCounts({
      calendarId: boundaryCalendarId,
      startTime: '2099-05-31T04:00:00.000Z',
      endTime: '2099-06-03T03:59:59.999Z',
      timezone: BUSINESS_TIMEZONE
    })
    assert.deepEqual(boundaryCounts.days, [
      { date: '2099-05-31', total: 1 },
      { date: '2099-06-01', total: 2 },
      { date: '2099-06-02', total: 1 }
    ])

    const annualCounts = await getLocalAppointmentDayCounts({
      calendarId: boundaryCalendarId,
      startTime: '2099-01-01T05:00:00.000Z',
      endTime: '2100-01-01T04:59:59.999Z',
      timezone: BUSINESS_TIMEZONE
    })
    assert.equal(annualCounts.days.length, 365)
    assert.equal(annualCounts.total, 4)

    const dstDay = await buildAppointmentBusinessDayBounds({
      startTime: '2025-03-09T05:00:00.000Z',
      endTime: '2025-03-10T03:59:59.999Z',
      timezone: BUSINESS_TIMEZONE
    })
    assert.equal(dstDay.bounds.length, 1)
    assert.equal(Date.parse(dstDay.bounds[0].endUtc) - Date.parse(dstDay.bounds[0].startUtc), 23 * 60 * 60 * 1000)
  } finally {
    await deleteCalendars(calendarIds)
  }
})
