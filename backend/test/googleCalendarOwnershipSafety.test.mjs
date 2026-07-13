import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  googleEventToAppointment,
  syncGoogleEventsToLocal,
  updateLocalCalendarGoogleSync
} from '../src/services/googleCalendarService.js'
import {
  checkSlotAvailability,
  getLocalCalendar,
  upsertLocalAppointment,
  upsertLocalCalendar
} from '../src/services/localCalendarService.js'

test('una religa Google A→B no mueve la cita canónica de A y sí materializa la ocupación en B', async () => {
  const suffix = randomUUID()
  const calendarA = `rstk_calendar_owner_a_${suffix}`
  const calendarB = `rstk_calendar_owner_b_${suffix}`
  const appointmentA = `rstk_appt_owner_a_${suffix}`
  const googleEventId = `google-event-relinked-owner-${suffix}`
  const event = {
    id: googleEventId,
    summary: 'Evento espejado desde A',
    start: { dateTime: '2030-07-20T16:00:00.000Z' },
    end: { dateTime: '2030-07-20T17:00:00.000Z' },
    extendedProperties: {
      private: {
        ristakAppointmentId: appointmentA,
        ristakCalendarId: calendarA
      }
    }
  }

  try {
    for (const [id, name] of [[calendarA, 'Agenda A'], [calendarB, 'Agenda B']]) {
      await upsertLocalCalendar({
        id,
        name,
        source: 'ristak',
        openHours: [{
          daysOfTheWeek: [6],
          hours: [{ openHour: 0, openMinute: 0, closeHour: 24, closeMinute: 0 }]
        }]
      }, { source: 'ristak', syncStatus: 'synced' })
    }
    await upsertLocalAppointment({
      id: appointmentA,
      googleEventId,
      calendarId: calendarA,
      title: 'Cita canónica de A',
      startTime: event.start.dateTime,
      endTime: event.end.dateTime,
      appointmentStatus: 'confirmed',
      source: 'ristak'
    }, {
      id: appointmentA,
      googleEventId,
      calendarId: calendarA,
      source: 'ristak',
      syncStatus: 'synced',
      googleSyncStatus: 'synced'
    })

    const originalOwner = googleEventToAppointment(event, { calendarId: calendarA, timezone: 'UTC' })
    assert.equal(originalOwner.id, appointmentA)
    assert.equal(originalOwner.calendarId, calendarA)
    assert.equal(originalOwner.source, 'ristak')

    const relinkedOwner = googleEventToAppointment(event, { calendarId: calendarB, timezone: 'UTC' })
    assert.notEqual(relinkedOwner.id, appointmentA)
    assert.match(relinkedOwner.id, /^google_shadow_/)
    assert.equal(relinkedOwner.googleEventId, null)
    assert.equal(relinkedOwner.calendarId, calendarB)
    assert.equal(relinkedOwner.source, 'google_shadow')
    await upsertLocalAppointment(relinkedOwner, {
      id: relinkedOwner.id,
      calendarId: calendarB,
      source: relinkedOwner.source,
      syncStatus: 'synced',
      googleSyncStatus: 'synced',
      lastWriteWins: true
    })

    const canonicalA = await db.get('SELECT id, calendar_id, google_event_id FROM appointments WHERE id = ?', [appointmentA])
    assert.equal(canonicalA.calendar_id, calendarA)
    assert.equal(canonicalA.google_event_id, googleEventId)
    const shadowB = await db.get('SELECT id, calendar_id, google_event_id FROM appointments WHERE id = ?', [relinkedOwner.id])
    assert.equal(shadowB.calendar_id, calendarB)
    assert.equal(shadowB.google_event_id, null)
    assert.equal(
      (await checkSlotAvailability(calendarB, event.start.dateTime, event.end.dateTime)).available,
      false,
      'el evento viejo debe bloquear B sin mover la cita local de A'
    )
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id IN (?, ?)', [calendarA, calendarB]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id IN (?, ?)', [calendarA, calendarB]).catch(() => undefined)
  }
})

test('desvincular Google conserva la cita canónica y elimina toda ocupación importada', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_google_unlink_${suffix}`
  const googleCalendarId = `unlink-${suffix}@example.test`
  const canonicalId = `rstk_appt_unlink_${suffix}`
  const importedId = `google_import_unlink_${suffix}`
  const shadowId = `google_shadow_unlink_${suffix}`

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda con ocupación importada',
      source: 'ristak',
      googleCalendarId,
      openHours: [{
        daysOfTheWeek: [1, 2, 3, 4, 5, 6, 7],
        hours: [{ openHour: 0, openMinute: 0, closeHour: 24, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced', allowGoogleSyncMetadata: true })
    await upsertLocalAppointment({
      id: canonicalId,
      calendarId,
      googleEventId: `canonical-google-${suffix}`,
      title: 'Cita que Ristak conserva',
      startTime: '2030-07-22T16:00:00.000Z',
      endTime: '2030-07-22T17:00:00.000Z',
      source: 'ristak'
    }, { id: canonicalId, calendarId, source: 'ristak', googleSyncStatus: 'synced' })
    await upsertLocalAppointment({
      id: importedId,
      calendarId,
      googleEventId: `imported-google-${suffix}`,
      googleProviderCalendarId: googleCalendarId,
      title: 'Evento externo importado',
      startTime: '2030-07-22T18:00:00.000Z',
      endTime: '2030-07-22T19:00:00.000Z',
      source: 'google'
    }, { id: importedId, calendarId, source: 'google', googleSyncStatus: 'synced' })
    await upsertLocalAppointment({
      id: shadowId,
      calendarId,
      googleProviderCalendarId: googleCalendarId,
      title: 'Sombra externa',
      startTime: '2030-07-22T20:00:00.000Z',
      endTime: '2030-07-22T21:00:00.000Z',
      source: 'google_shadow'
    }, { id: shadowId, calendarId, source: 'google_shadow', googleSyncStatus: 'synced' })

    await updateLocalCalendarGoogleSync({ calendarId, googleCalendarId: '' })

    assert.equal((await getLocalCalendar(calendarId)).googleCalendarId, '')
    const canonical = await db.get(
      'SELECT google_event_id, google_provider_calendar_id FROM appointments WHERE id = ?',
      [canonicalId]
    )
    assert.equal(canonical.google_event_id, `canonical-google-${suffix}`)
    assert.equal(canonical.google_provider_calendar_id, googleCalendarId)
    assert.equal(await db.get('SELECT id FROM appointments WHERE id = ?', [importedId]), null)
    assert.equal(await db.get('SELECT id FROM appointments WHERE id = ?', [shadowId]), null)
    assert.equal(
      (await checkSlotAvailability(calendarId, '2030-07-22T18:00:00.000Z', '2030-07-22T19:00:00.000Z')).available,
      true
    )
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('el vínculo Google sólo cambia por la ruta protegida y rechaza dueños duplicados', async () => {
  const suffix = randomUUID()
  const firstCalendarId = `rstk_google_owner_a_${suffix}`
  const secondCalendarId = `rstk_google_owner_b_${suffix}`
  const googleCalendarId = `shared-${suffix}@example.test`

  try {
    await upsertLocalCalendar({
      id: firstCalendarId,
      name: 'Agenda A',
      source: 'ristak',
      googleCalendarId,
      googleCalendarSummary: 'Google compartido',
      googleAccessRole: 'owner'
    }, { source: 'ristak', syncStatus: 'synced', allowGoogleSyncMetadata: true })
    await upsertLocalCalendar({
      id: secondCalendarId,
      name: 'Agenda B',
      source: 'ristak'
    }, { source: 'ristak', syncStatus: 'synced' })

    await assert.rejects(
      () => upsertLocalCalendar({
        id: secondCalendarId,
        name: 'Agenda B',
        source: 'ristak',
        googleCalendarId
      }, { source: 'ristak', syncStatus: 'synced' }),
      error => error?.status === 409 && error?.code === 'google_calendar_link_requires_sync_route'
    )
    await assert.rejects(
      () => upsertLocalCalendar({
        id: secondCalendarId,
        name: 'Agenda B',
        source: 'ristak',
        googleCalendarId
      }, { source: 'ristak', syncStatus: 'synced', allowGoogleSyncMetadata: true }),
      error => error?.status === 409 && error?.code === 'duplicate_google_calendar_owner'
    )

    // Simula una instalación histórica ya corrupta para comprobar que el sync
    // también falla cerrado aunque la protección de escritura no existiera antes.
    await db.run(
      'UPDATE calendars SET raw_json = ? WHERE id = ?',
      [JSON.stringify({ googleCalendarId }), secondCalendarId]
    )

    await assert.rejects(
      () => syncGoogleEventsToLocal({
        calendarId: firstCalendarId,
        startTime: '2030-07-20T00:00:00.000Z',
        endTime: '2030-07-21T00:00:00.000Z',
        config: { connectionMode: 'oauth', refreshToken: 'unused-because-ownership-fails-first' }
      }),
      error => error?.status === 409 && error?.code === 'duplicate_google_calendar_owner'
    )
  } finally {
    await db.run('DELETE FROM calendars WHERE id IN (?, ?)', [firstCalendarId, secondCalendarId]).catch(() => undefined)
  }
})
