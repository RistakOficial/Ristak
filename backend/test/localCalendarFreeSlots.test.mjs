import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { db } from '../src/config/database.js'
import {
  createLocalAppointment,
  ensureHighLevelContactForAppointment,
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

    slots = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC', { appointmentLimit: 1 })
    assert.equal(
      slots[0]?.slots.includes(expectedSlot),
      false,
      'el agente puede forzar horarios únicos aunque el calendario permita cupo mayor'
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

    slots = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC', { ignoreAppointmentConflicts: true })
    assert.ok(
      slots[0]?.slots.includes(expectedSlot),
      'el agente puede permitir empalmes y conservar el horario aunque ya tenga citas'
    )
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('getLocalFreeSlots deduplica slots cuando horarios personalizados se empalman', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_custom_overlap_${suffix}`
  const baseDay = DateTime.utc().plus({ days: 30 }).startOf('day')
  const nextMonday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const dateKey = nextMonday.toISODate()
  const expectedFirstSlot = nextMonday.set({ hour: 10, minute: 0 }).toISO()

  try {
    await upsertLocalCalendar({
      id: calendarId,
      ghlCalendarId: `ghl_cal_custom_overlap_${suffix}`,
      locationId: 'loc_custom_overlap_test',
      name: 'Calendario con horarios empalmados',
      source: 'ghl',
      slotDuration: 60,
      slotInterval: 60,
      appoinmentPerSlot: 2,
      openHours: [
        {
          daysOfTheWeek: [1],
          hours: [{ openHour: 10, openMinute: 0, closeHour: 12, closeMinute: 0 }]
        },
        {
          daysOfTheWeek: [1],
          hours: [{ openHour: 10, openMinute: 0, closeHour: 12, closeMinute: 0 }]
        }
      ]
    }, {
      source: 'ghl',
      syncStatus: 'synced'
    })

    const slots = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC')
    const daySlots = slots[0]?.slots || []

    assert.ok(daySlots.includes(expectedFirstSlot), 'el primer horario empalmado debe seguir disponible')
    assert.equal(daySlots.length, new Set(daySlots).size, 'los horarios empalmados no deben duplicar botones')
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('ensureHighLevelContactForAppointment liga el contacto local con HighLevel', async () => {
  const suffix = randomUUID()
  const contactId = `rstk_contact_${suffix}`
  const ghlContactId = `ghl_contact_${suffix}`
  const phone = `+1555${suffix.replace(/-/g, '').slice(0, 10)}`
  const email = `contact-${suffix}@example.com`
  const searches = []

  const fakeClient = {
    searchContacts: async (query) => {
      searches.push(query)
      return { contacts: [{ id: ghlContactId }] }
    },
    createContact: async () => {
      throw new Error('No debió crear contacto si ya encontró uno')
    }
  }

  try {
    await db.run(
      'INSERT INTO contacts (id, phone, email, full_name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactId, phone, email, 'Contacto Cita', 'ristak']
    )

    const resolved = await ensureHighLevelContactForAppointment(fakeClient, { contactId })
    const row = await db.get('SELECT ghl_contact_id FROM contacts WHERE id = ?', [contactId])

    assert.equal(resolved, ghlContactId)
    assert.equal(row?.ghl_contact_id, ghlContactId)
    assert.ok(searches.some(query => query.email === email || query.phone === phone))
  } finally {
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
