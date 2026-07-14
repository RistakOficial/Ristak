import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import { createAppointment as createAppointmentController } from '../src/controllers/calendarsController.js'
import { upsertLocalCalendar } from '../src/services/localCalendarService.js'

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    }
  }
}

test('strictAvailabilityCheck exige exactamente la duración configurada del calendario', async (t) => {
  const calendarId = `calendar_duration_contract_${randomUUID()}`
  const startTime = '2099-07-20T15:00:00.000Z'

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda de una hora',
      source: 'ristak',
      slotDuration: 60,
      slotDurationUnit: 'mins',
      slotInterval: 60,
      slotIntervalUnit: 'mins',
      allowBookingFor: 36500,
      allowBookingForUnit: 'days',
      openHours: [{
        daysOfTheWeek: [0, 1, 2, 3, 4, 5, 6],
        hours: [{ openHour: 0, openMinute: 0, closeHour: 24, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })

    for (const durationMinutes of [1, 30, 90]) {
      await t.test(`rechaza ${durationMinutes} minutos contra una agenda de 60`, async () => {
        const response = createResponse()
        await createAppointmentController({
          body: {
            calendarId,
            title: `Intento de ${durationMinutes} minutos`,
            startTime,
            endTime: new Date(Date.parse(startTime) + durationMinutes * 60 * 1000).toISOString(),
            strictAvailabilityCheck: true
          }
        }, response)

        assert.equal(response.statusCode, 409, JSON.stringify(response.body))
        assert.equal(response.body?.code, 'slot_unavailable')
        assert.equal(response.body?.data?.reason, 'slot_duration_mismatch')
        assert.equal(response.body?.data?.expectedDurationMinutes, 60)
        assert.equal(response.body?.data?.actualDurationMinutes, durationMinutes)
      })
    }

    const exactResponse = createResponse()
    await createAppointmentController({
      body: {
        calendarId,
        title: 'Intento exacto de 60 minutos',
        startTime,
        endTime: new Date(Date.parse(startTime) + 60 * 60 * 1000).toISOString(),
        strictAvailabilityCheck: true
      }
    }, exactResponse)

    assert.equal(exactResponse.statusCode, 201, JSON.stringify(exactResponse.body))
    const rows = await db.all('SELECT id FROM appointments WHERE calendar_id = ?', [calendarId])
    assert.equal(rows.length, 1)
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('la duración estricta respeta slotDurationUnit', async () => {
  const calendarId = `calendar_duration_hours_${randomUUID()}`
  const startTime = '2099-07-21T15:00:00.000Z'

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda configurada en horas',
      source: 'ristak',
      slotDuration: 1,
      slotDurationUnit: 'hours',
      slotInterval: 1,
      slotIntervalUnit: 'hours',
      allowBookingFor: 36500,
      allowBookingForUnit: 'days',
      openHours: [{
        daysOfTheWeek: [0, 1, 2, 3, 4, 5, 6],
        hours: [{ openHour: 0, openMinute: 0, closeHour: 24, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })

    const response = createResponse()
    await createAppointmentController({
      body: {
        calendarId,
        title: 'Una hora configurada como hours',
        startTime,
        endTime: new Date(Date.parse(startTime) + 60 * 60 * 1000).toISOString(),
        strictAvailabilityCheck: true
      }
    }, response)

    assert.equal(response.statusCode, 201, JSON.stringify(response.body))
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})
