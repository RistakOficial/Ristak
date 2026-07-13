import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { db } from '../src/config/database.js'
import {
  createLocalBlockedSlot,
  createLocalCalendar,
  createLocalAppointment,
  deleteLocalBlockedSlot,
  ensureHighLevelContactForAppointment,
  getLocalFreeSlots,
  getPublicCalendarBySlug,
  listLocalBlockedSlots,
  updateLocalBlockedSlot,
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

test('getLocalFreeSlots libera inmediatamente el horario de una cita cancelada sin borrar su historial', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_cancelled_slot_${suffix}`
  const appointmentId = `rstk_appt_cancelled_slot_${suffix}`
  const baseDay = DateTime.utc().plus({ days: 33 }).startOf('day')
  const nextMonday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const dateKey = nextMonday.toISODate()
  const slotStart = nextMonday.set({ hour: 14, minute: 0 })
  const slotEnd = slotStart.plus({ minutes: 60 })
  const expectedSlot = slotStart.toISO()

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda que libera cancelaciones',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [
        {
          daysOfTheWeek: [1],
          hours: [{ openHour: 14, openMinute: 0, closeHour: 16, closeMinute: 0 }]
        }
      ]
    }, { source: 'ristak', syncStatus: 'synced' })

    await createLocalAppointment({
      id: appointmentId,
      calendarId,
      title: 'Cita que después se cancela',
      source: 'ristak',
      startTime: slotStart.toISO(),
      endTime: slotEnd.toISO(),
      appointmentStatus: 'confirmed',
      status: 'confirmed'
    }, { syncStatus: 'synced' })

    let slots = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC')
    assert.equal(slots[0]?.slots.includes(expectedSlot), false, 'la cita activa debe ocupar el horario')

    await db.run(
      `UPDATE appointments
       SET appointment_status = 'cancelled', status = 'cancelled', date_updated = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [appointmentId]
    )

    slots = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC')
    assert.equal(slots[0]?.slots.includes(expectedSlot), true, 'la cancelación suave debe liberar el horario')
    const preserved = await db.get('SELECT id, deleted_at FROM appointments WHERE id = ?', [appointmentId])
    assert.equal(preserved.id, appointmentId)
    assert.equal(preserved.deleted_at, null)
  } finally {
    await db.run('DELETE FROM appointment_participants WHERE appointment_id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('getLocalFreeSlots excluye la propia cita y valida toda su duración real al reagendar', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_reschedule_duration_${suffix}`
  const ownAppointmentId = `rstk_appt_reschedule_own_${suffix}`
  const blockingAppointmentId = `rstk_appt_reschedule_block_${suffix}`
  const baseDay = DateTime.utc().plus({ days: 37 }).startOf('day')
  const nextMonday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const dateKey = nextMonday.toISODate()
  const partialOwnOverlap = nextMonday.set({ hour: 10, minute: 30 }).toISO()
  const partialOtherOverlap = nextMonday.set({ hour: 11, minute: 30 }).toISO()

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda con duración real de reagenda',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 30,
      openHours: [{
        daysOfTheWeek: [1],
        hours: [{ openHour: 9, openMinute: 0, closeHour: 15, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })

    await createLocalAppointment({
      id: ownAppointmentId,
      calendarId,
      title: 'Cita de 90 minutos a mover',
      startTime: nextMonday.set({ hour: 10, minute: 0 }).toISO(),
      endTime: nextMonday.set({ hour: 11, minute: 30 }).toISO(),
      appointmentStatus: 'confirmed'
    }, { syncStatus: 'synced' })
    await createLocalAppointment({
      id: blockingAppointmentId,
      calendarId,
      title: 'Otra cita que sí debe bloquear',
      startTime: nextMonday.set({ hour: 12, minute: 30 }).toISO(),
      endTime: nextMonday.set({ hour: 13, minute: 30 }).toISO(),
      appointmentStatus: 'confirmed'
    }, { syncStatus: 'synced' })

    const ordinarySlots = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC')
    assert.equal(ordinarySlots[0].slots.includes(partialOwnOverlap), false)

    const rescheduleSlots = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC', {
      excludeAppointmentId: ownAppointmentId,
      durationMinutes: 90
    })
    assert.equal(rescheduleSlots[0].slots.includes(partialOwnOverlap), true)
    assert.equal(
      rescheduleSlots[0].slots.includes(partialOtherOverlap),
      false,
      '11:30–13:00 debe bloquearse porque la duración real alcanza la otra cita de 12:30'
    )
  } finally {
    await db.run('DELETE FROM appointments WHERE id IN (?, ?)', [ownAppointmentId, blockingAppointmentId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('createLocalCalendar genera IDs y URLs publicas unicas para calendarios Ristak con el mismo nombre', async () => {
  const suffix = randomUUID()
  const name = `Mi calendario ${suffix}`
  const createdIds = []

  try {
    const first = await createLocalCalendar({
      name,
      slotDuration: 60,
      slotInterval: 60,
      openHours: [
        {
          daysOfTheWeek: [1],
          hours: [{ openHour: 9, openMinute: 0, closeHour: 11, closeMinute: 0 }]
        }
      ]
    })
    const second = await createLocalCalendar({
      name,
      slotDuration: 60,
      slotInterval: 60,
      openHours: [
        {
          daysOfTheWeek: [1],
          hours: [{ openHour: 12, openMinute: 0, closeHour: 14, closeMinute: 0 }]
        }
      ]
    })
    createdIds.push(first.id, second.id)

    assert.match(first.id, /^rstk_cal_/)
    assert.match(second.id, /^rstk_cal_/)
    assert.notEqual(first.id, second.id)
    assert.notEqual(first.slug, second.slug)
    assert.equal(first.widgetSlug, first.slug)
    assert.equal(second.widgetSlug, second.slug)

    const firstPublic = await getPublicCalendarBySlug(first.slug)
    const secondPublic = await getPublicCalendarBySlug(second.slug)
    assert.equal(firstPublic?.id, first.id)
    assert.equal(secondPublic?.id, second.id)
  } finally {
    if (createdIds.length) {
      await db.run(`DELETE FROM calendars WHERE id IN (${createdIds.map(() => '?').join(', ')})`, createdIds).catch(() => undefined)
    }
  }
})

test('bloqueos locales de calendario se crean con ID rstk y afectan disponibilidad', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_blocked_${suffix}`
  const baseDay = DateTime.utc().plus({ days: 30 }).startOf('day')
  const nextMonday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const dateKey = nextMonday.toISODate()
  const blockStart = nextMonday.set({ hour: 10, minute: 0 })
  const blockEnd = blockStart.plus({ minutes: 60 })
  const expectedSlot = blockStart.toISO()
  let blockedSlotId = ''

  try {
    await upsertLocalCalendar({
      id: calendarId,
      locationId: 'loc_blocked_slot_test',
      name: 'Calendario con bloqueo',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [
        {
          daysOfTheWeek: [1],
          hours: [{ openHour: 9, openMinute: 0, closeHour: 12, closeMinute: 0 }]
        }
      ]
    }, {
      source: 'ristak',
      syncStatus: 'pending'
    })

    const blockedSlot = await createLocalBlockedSlot({
      calendarId,
      startTime: blockStart.toISO(),
      endTime: blockEnd.toISO(),
      title: 'Bloqueo smoke'
    })
    blockedSlotId = blockedSlot.id

    assert.match(blockedSlot.id, /^rstk_block_[A-Za-z0-9]{20}$/)

    let slots = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC')
    assert.equal(slots[0]?.slots.includes(expectedSlot), false)

    const listed = await listLocalBlockedSlots({
      calendarId,
      startTime: blockStart.minus({ minutes: 1 }).toISO(),
      endTime: blockEnd.plus({ minutes: 1 }).toISO()
    })
    assert.equal(listed.some((item) => item.id === blockedSlot.id), true)

    const updated = await updateLocalBlockedSlot({ id: blockedSlot.id, title: 'Bloqueo actualizado' })
    assert.equal(updated, true)

    const deleted = await deleteLocalBlockedSlot(blockedSlot.id)
    assert.equal(deleted, true)
    blockedSlotId = ''

    slots = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC')
    assert.equal(slots[0]?.slots.includes(expectedSlot), true)
  } finally {
    if (blockedSlotId) await deleteLocalBlockedSlot(blockedSlotId).catch(() => undefined)
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM blocked_slots WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('upsertLocalCalendar evita slugs publicos duplicados entre calendarios internos de Ristak', async () => {
  const suffix = randomUUID()
  const slug = `agenda-crm-${suffix}`
  const firstId = `rstk_cal_slug_a_${suffix}`
  const secondId = `rstk_cal_slug_b_${suffix}`

  try {
    const first = await upsertLocalCalendar({
      id: firstId,
      slug,
      widgetSlug: slug,
      name: 'Agenda CRM',
      source: 'ristak'
    }, {
      source: 'ristak',
      syncStatus: 'pending'
    })
    const second = await upsertLocalCalendar({
      id: secondId,
      slug,
      widgetSlug: slug,
      name: 'Agenda CRM duplicada',
      source: 'ristak'
    }, {
      source: 'ristak',
      syncStatus: 'pending'
    })

    assert.equal(first.slug, slug)
    assert.notEqual(second.slug, slug)
    assert.notEqual(first.slug, second.slug)
    assert.equal(second.widgetSlug, second.slug)

    const firstPublic = await getPublicCalendarBySlug(first.slug)
    const secondPublic = await getPublicCalendarBySlug(second.slug)
    assert.equal(firstPublic?.id, firstId)
    assert.equal(secondPublic?.id, secondId)
  } finally {
    await db.run('DELETE FROM calendars WHERE id IN (?, ?)', [firstId, secondId]).catch(() => undefined)
  }
})

test('getPublicCalendarBySlug resuelve el calendario Ristak aunque exista un origen Google con el mismo slug', async () => {
  const suffix = randomUUID()
  const slug = `agenda-publica-${suffix}`
  const ristakCalendarId = `rstk_cal_public_${suffix}`
  const googleCalendarId = `google_cal_public_${suffix}`

  try {
    await upsertLocalCalendar({
      id: googleCalendarId,
      slug,
      widgetSlug: slug,
      name: 'Google no publico',
      source: 'google',
      googleCalendarId: 'ventas-google@test.com'
    }, {
      source: 'google',
      syncStatus: 'synced'
    })

    await upsertLocalCalendar({
      id: ristakCalendarId,
      slug,
      widgetSlug: slug,
      name: 'Ristak publico',
      source: 'ristak',
      googleCalendarId: 'ventas-google@test.com'
    }, {
      source: 'ristak',
      syncStatus: 'pending'
    })

    const bySlug = await getPublicCalendarBySlug(slug)
    assert.equal(bySlug?.id, ristakCalendarId)
    assert.equal(bySlug?.source, 'ristak')

    const googleById = await getPublicCalendarBySlug(googleCalendarId)
    assert.equal(googleById, null)
  } finally {
    await db.run('DELETE FROM calendars WHERE id IN (?, ?)', [ristakCalendarId, googleCalendarId]).catch(() => undefined)
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
