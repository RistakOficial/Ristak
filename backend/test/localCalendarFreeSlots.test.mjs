import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { db } from '../src/config/database.js'
import {
  createLocalAppointment,
  getLocalFreeSlots,
  upsertLocalCalendar
} from '../src/services/localCalendarService.js'

test('getLocalFreeSlots respeta el cupo por slot en calendarios HighLevel', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_overlap_${suffix}`
  const ghlCalendarId = `ghl_cal_overlap_${suffix}`
  const firstAppointmentId = `rstk_appt_overlap_1_${suffix}`
  const secondAppointmentId = `rstk_appt_overlap_2_${suffix}`
  const baseDay = DateTime.utc().plus({ days: 30 }).startOf('day')
  const nextMonday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const dateKey = nextMonday.toISODate()
  const slotStart = nextMonday.set({ hour: 15, minute: 0 })
  const slotEnd = slotStart.plus({ minutes: 60 })
  const expectedSlot = slotStart.toISO()

  try {
    await upsertLocalCalendar({
      id: calendarId,
      ghlCalendarId,
      locationId: 'loc_overlap_test',
      name: 'Calendario GHL con cupo',
      source: 'ghl',
      slotDuration: 60,
      slotInterval: 60,
      appoinmentPerSlot: 2,
      openHours: [
        {
          daysOfTheWeek: [1],
          hours: [{ openHour: 15, openMinute: 0, closeHour: 17, closeMinute: 0 }]
        }
      ]
    }, {
      source: 'ghl',
      ghlCalendarId,
      syncStatus: 'synced'
    })

    await createLocalAppointment({
      id: firstAppointmentId,
      calendarId,
      locationId: 'loc_overlap_test',
      title: 'Primera cita',
      source: 'ghl',
      startTime: slotStart.toISO(),
      endTime: slotEnd.toISO(),
      appointmentStatus: 'confirmed'
    }, {
      locationId: 'loc_overlap_test',
      syncStatus: 'synced'
    })

    let slots = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC')
    assert.ok(
      slots[0]?.slots.includes(expectedSlot),
      'un calendario HighLevel con cupo 2 debe conservar el slot tras una cita'
    )

    await createLocalAppointment({
      id: secondAppointmentId,
      calendarId,
      locationId: 'loc_overlap_test',
      title: 'Segunda cita',
      source: 'ghl',
      startTime: slotStart.toISO(),
      endTime: slotEnd.toISO(),
      appointmentStatus: 'confirmed'
    }, {
      locationId: 'loc_overlap_test',
      syncStatus: 'synced'
    })

    slots = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC')
    assert.equal(
      slots[0]?.slots.includes(expectedSlot),
      false,
      'el slot se oculta cuando alcanza el cupo importado de HighLevel'
    )
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})
