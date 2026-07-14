import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { db } from '../src/config/database.js'
import {
  createAppointmentTool,
  getFreeSlotsTool,
  updateAppointmentTool
} from '../src/agents/tools/appointmentTools.js'
import { upsertLocalCalendar } from '../src/services/localCalendarService.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('AppointmentModal convierte slotDuration con su unidad antes de mostrar o calcular el fin', () => {
  const source = fs.readFileSync(
    path.join(repositoryRoot, 'frontend/src/components/common/AppointmentModal/AppointmentModal.tsx'),
    'utf8'
  )

  assert.match(source, /import \{ calendarDurationToMinutes \} from '\.\.\/WeeklyAvailabilityEditor';/)
  assert.match(
    source,
    /const configuredDurationMinutes = calendarDurationToMinutes\(\s*calendar\?\.slotDuration \?\? 60,\s*calendar\?\.slotDurationUnit \?\? 'mins'\s*\);/
  )
  assert.match(source, /formatSlotWithDuration\(timeSlot, configuredDurationMinutes, accountTimezone\)/)
  assert.ok(
    (source.match(/configuredDurationMinutes \* 60 \* 1000/g) || []).length >= 3,
    'todos los cálculos de fin deben usar la duración ya convertida a minutos'
  )
  assert.doesNotMatch(source, /calendar\?\.slotDuration \|\| 60/)
})

test('el agente general reporta cero cuando el calendario no tiene ningún slot real', async () => {
  const calendarId = `agent_closed_duration_${randomUUID()}`

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda cerrada para agente',
      source: 'ristak',
      slotDuration: 1,
      slotDurationUnit: 'hours',
      availabilityScheduleConfigured: true,
      allowBookingFor: 36500,
      allowBookingForUnit: 'days',
      openHours: []
    }, { source: 'ristak', syncStatus: 'synced' })

    const result = await getFreeSlotsTool.invoke(null, JSON.stringify({
      calendarId,
      startDate: '2099-07-20',
      endDate: '2099-07-20'
    }))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.total, 0)
    assert.equal(result.durationMinutes, 60)
    assert.deepEqual(result.slots, [])
  } finally {
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('el agente general deriva el fin configurado al crear y reagendar', async () => {
  const suffix = randomUUID()
  const calendarId = `agent_duration_${suffix}`
  const contactId = `contact_agent_duration_${suffix}`

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda del agente configurada en horas',
      source: 'ristak',
      slotDuration: 1,
      slotDurationUnit: 'hours',
      slotInterval: 1,
      slotIntervalUnit: 'hours',
      allowBookingFor: 36500,
      allowBookingForUnit: 'days',
      openHours: [{
        daysOfTheWeek: [0, 1, 2, 3, 4, 5, 6],
        hours: [{ openHour: 9, openMinute: 0, closeHour: 13, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto duración agente', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )

    const availability = await getFreeSlotsTool.invoke(null, JSON.stringify({
      calendarId,
      startDate: '2099-07-20',
      endDate: '2099-07-20'
    }))
    assert.equal(availability.ok, true, JSON.stringify(availability))
    assert.equal(availability.durationMinutes, 60)
    assert.equal(availability.total, 4)
    const starts = availability.slots.flatMap((day) => day.slots)
    assert.equal(starts.length, 4)

    const created = await createAppointmentTool.invoke(null, JSON.stringify({
      calendarId,
      contactId,
      title: 'Cita creada por agente general',
      startTime: starts[0],
      endTime: new Date(Date.parse(starts[0]) + 30 * 60 * 1000).toISOString(),
      notes: null
    }))
    assert.equal(created.ok, true, JSON.stringify(created))
    assert.equal(created.data?.durationMinutes, 60)
    assert.equal(
      Date.parse(created.data?.endTime) - Date.parse(created.data?.startTime),
      60 * 60 * 1000
    )

    const updated = await updateAppointmentTool.invoke(null, JSON.stringify({
      appointmentId: created.data.id,
      title: null,
      startTime: starts[2],
      endTime: new Date(Date.parse(starts[2]) + 90 * 60 * 1000).toISOString(),
      notes: null,
      appointmentStatus: null
    }))
    assert.equal(updated.ok, true, JSON.stringify(updated))
    assert.equal(updated.data?.durationMinutes, 60)
    assert.equal(updated.data?.startTime, starts[2])
    assert.equal(
      Date.parse(updated.data?.endTime) - Date.parse(updated.data?.startTime),
      60 * 60 * 1000
    )

    const outsideConfiguredHours = new Date(Date.parse(starts[0]) + 5 * 60 * 60 * 1000).toISOString()
    const rejected = await updateAppointmentTool.invoke(null, JSON.stringify({
      appointmentId: created.data.id,
      title: null,
      startTime: outsideConfiguredHours,
      endTime: new Date(Date.parse(outsideConfiguredHours) + 60 * 60 * 1000).toISOString(),
      notes: null,
      appointmentStatus: null
    }))
    assert.equal(rejected.ok, false, JSON.stringify(rejected))
    assert.equal(rejected.statusCode, 409)

    const row = await db.get('SELECT start_time, end_time FROM appointments WHERE id = ?', [created.data.id])
    assert.equal(row.start_time, starts[2])
    assert.equal(Date.parse(row.end_time) - Date.parse(row.start_time), 60 * 60 * 1000)
  } finally {
    await db.run(
      'DELETE FROM appointment_participants WHERE appointment_id IN (SELECT id FROM appointments WHERE calendar_id = ?)',
      [calendarId]
    ).catch(() => undefined)
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})
