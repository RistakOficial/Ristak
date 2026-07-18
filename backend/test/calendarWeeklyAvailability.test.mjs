import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

import { db } from '../src/config/database.js'
import {
  createLocalCalendar,
  getLocalCalendar,
  getLocalFreeSlots,
  normalizeCalendarOpenHoursForWrite,
  updateLocalCalendar,
  upsertLocalCalendar
} from '../src/services/localCalendarService.js'

const DEFAULT_WEEKLY_AVAILABILITY = [
  {
    daysOfTheWeek: [1, 2, 3, 4, 5],
    hours: [{ openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0 }]
  }
]

function assertAvailabilityInputError(error) {
  assert.equal(error?.status, 400)
  assert.equal(error?.code, 'invalid_calendar_open_hours')
  return true
}

async function deleteCalendar(calendarId) {
  await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
  await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
}

test('normaliza openHours a días canónicos, ordenados y sin duplicados', () => {
  const normalized = normalizeCalendarOpenHoursForWrite([
    {
      daysOfTheWeek: ['2', 1, 1],
      hours: [
        { openHour: 14, openMinute: 30, closeHour: 16, closeMinute: 0 },
        { openHour: 9, openMinute: 0, closeHour: 12, closeMinute: 15 }
      ]
    },
    {
      dayOfWeek: 7,
      openHour: 8,
      openMinute: 0,
      closeHour: 10,
      closeMinute: 0
    }
  ])

  assert.deepEqual(normalized, [
    {
      daysOfTheWeek: [0],
      hours: [{ openHour: 8, openMinute: 0, closeHour: 10, closeMinute: 0 }]
    },
    {
      daysOfTheWeek: [1],
      hours: [
        { openHour: 9, openMinute: 0, closeHour: 12, closeMinute: 15 },
        { openHour: 14, openMinute: 30, closeHour: 16, closeMinute: 0 }
      ]
    },
    {
      daysOfTheWeek: [2],
      hours: [
        { openHour: 9, openMinute: 0, closeHour: 12, closeMinute: 15 },
        { openHour: 14, openMinute: 30, closeHour: 16, closeMinute: 0 }
      ]
    }
  ])
})

test('rechaza rangos semanales empalmados aunque lleguen en entradas distintas', () => {
  assert.throws(
    () => normalizeCalendarOpenHoursForWrite([
      {
        daysOfTheWeek: [1],
        hours: [{ openHour: 9, openMinute: 0, closeHour: 12, closeMinute: 0 }]
      },
      {
        day: 1,
        openHour: 11,
        openMinute: 30,
        closeHour: 13,
        closeMinute: 0
      }
    ]),
    assertAvailabilityInputError
  )
})

test('rechaza intervalos semanales inválidos', async (t) => {
  const invalidCases = [
    {
      name: 'el cierre no ocurre después de la apertura',
      value: [{
        daysOfTheWeek: [2],
        hours: [{ openHour: 17, openMinute: 0, closeHour: 9, closeMinute: 0 }]
      }]
    },
    {
      name: '24:00 sólo puede usarse sin minutos adicionales',
      value: [{
        daysOfTheWeek: [3],
        hours: [{ openHour: 9, openMinute: 0, closeHour: 24, closeMinute: 1 }]
      }]
    },
    {
      name: 'no guarda 24:00 porque los calendarios conectados sólo aceptan hora 0 a 23',
      value: [{
        daysOfTheWeek: [3],
        hours: [{ openHour: 9, openMinute: 0, closeHour: 24, closeMinute: 0 }]
      }]
    },
    {
      name: 'no convierte partes vacías del horario en medianoche',
      value: [{
        daysOfTheWeek: [3],
        hours: [{ openHour: '', openMinute: null, closeHour: 10, closeMinute: 0 }]
      }]
    },
    {
      name: 'un día activo necesita al menos un rango',
      value: [{ daysOfTheWeek: [4], hours: [] }]
    },
    {
      name: 'no acepta días de la semana fuera del contrato 0 a 6',
      value: [{
        daysOfTheWeek: [1, 9],
        hours: [{ openHour: 9, openMinute: 0, closeHour: 10, closeMinute: 0 }]
      }]
    },
    {
      name: 'no convierte valores vacíos o fraccionarios en días válidos',
      value: [{
        daysOfTheWeek: ['', 1.5],
        hours: [{ openHour: 9, openMinute: 0, closeHour: 10, closeMinute: 0 }]
      }]
    }
  ]

  for (const invalidCase of invalidCases) {
    await t.test(invalidCase.name, () => {
      assert.throws(
        () => normalizeCalendarOpenHoursForWrite(invalidCase.value),
        assertAvailabilityInputError
      )
    })
  }
})

test('un calendario nuevo sin openHours guarda explícitamente Lun-Vie de 09:00 a 17:00', async () => {
  const calendarId = `rstk_cal_weekly_default_${randomUUID()}`

  try {
    const calendar = await createLocalCalendar({
      id: calendarId,
      name: 'Agenda con disponibilidad inicial',
      allowBookingFor: 365,
      allowBookingForUnit: 'days'
    })

    assert.deepEqual(calendar.openHours, DEFAULT_WEEKLY_AVAILABILITY)
    assert.equal(calendar.availabilityScheduleConfigured, true)

    const stored = await db.get(
      'SELECT open_hours, availability_schedule_configured FROM calendars WHERE id = ?',
      [calendarId]
    )
    assert.deepEqual(JSON.parse(stored.open_hours), DEFAULT_WEEKLY_AVAILABILITY)
    assert.equal(Number(stored.availability_schedule_configured), 1)
  } finally {
    await deleteCalendar(calendarId)
  }
})

test('openHours vacío explícito permanece cerrado y no recupera el fallback legacy', async () => {
  const calendarId = `rstk_cal_weekly_closed_${randomUUID()}`
  const candidate = DateTime.utc().plus({ days: 7 }).startOf('day')
  const monday = candidate.plus({ days: (8 - candidate.weekday) % 7 })

  try {
    const calendar = await createLocalCalendar({
      id: calendarId,
      name: 'Agenda cerrada intencionalmente',
      allowBookingFor: 365,
      allowBookingForUnit: 'days',
      openHours: []
    })

    assert.deepEqual(calendar.openHours, [])
    assert.equal(calendar.availabilityScheduleConfigured, true)

    const slots = await getLocalFreeSlots(
      calendarId,
      monday.toISODate(),
      monday.toISODate(),
      'UTC'
    )
    assert.deepEqual(slots[0]?.slots || [], [])

    const reloaded = await getLocalCalendar(calendarId)
    assert.deepEqual(reloaded.openHours, [])
    assert.equal(reloaded.availabilityScheduleConfigured, true)
  } finally {
    await deleteCalendar(calendarId)
  }
})

test('una edición explícita persiste y genera slots aunque el calendario siga pendiente', async () => {
  const calendarId = `rstk_cal_weekly_pending_update_${randomUUID()}`
  const baseDay = DateTime.utc().plus({ days: 30 }).startOf('day')
  const nextTuesday = baseDay.plus({ days: (2 - baseDay.weekday + 7) % 7 })
  const nextMonday = nextTuesday.minus({ days: 1 })
  const copiedRanges = [
    { openHour: 13, openMinute: 5, closeHour: 14, closeMinute: 35 },
    { openHour: 16, openMinute: 10, closeHour: 17, closeMinute: 10 }
  ]
  const expectedAvailability = normalizeCalendarOpenHoursForWrite([2, 4, 6].map(day => ({
    daysOfTheWeek: [day],
    hours: copiedRanges
  })))

  try {
    const created = await createLocalCalendar({
      id: calendarId,
      name: 'Agenda pendiente que sí acepta ediciones',
      allowBookingFor: 365,
      allowBookingForUnit: 'days',
      slotDuration: 30,
      slotInterval: 30
    })
    assert.equal(created.syncStatus, 'pending')

    const updated = await updateLocalCalendar(calendarId, {
      openHours: expectedAvailability,
      availabilityScheduleConfigured: true
    })
    assert.deepEqual(updated.openHours, expectedAvailability)
    assert.equal(updated.availabilityScheduleConfigured, true)

    const stored = await db.get(
      'SELECT open_hours, availability_schedule_configured FROM calendars WHERE id = ?',
      [calendarId]
    )
    assert.deepEqual(JSON.parse(stored.open_hours), expectedAvailability)
    assert.equal(Number(stored.availability_schedule_configured), 1)

    const reloaded = await getLocalCalendar(calendarId)
    assert.deepEqual(reloaded.openHours, expectedAvailability)

    const availableTuesday = await getLocalFreeSlots(
      calendarId,
      nextTuesday.toISODate(),
      nextTuesday.toISODate(),
      'UTC'
    )
    const availableTimes = (availableTuesday[0]?.slots || []).map(slot => (
      DateTime.fromISO(slot, { setZone: true }).setZone('UTC').toFormat('HH:mm')
    ))
    assert.deepEqual(availableTimes, ['13:05', '13:35', '14:05', '16:10', '16:40'])

    const closedMonday = await getLocalFreeSlots(
      calendarId,
      nextMonday.toISODate(),
      nextMonday.toISODate(),
      'UTC'
    )
    assert.deepEqual(closedMonday[0]?.slots || [], [])
  } finally {
    await deleteCalendar(calendarId)
  }
})

test('una respuesta remota que omite openHours no borra la agenda semanal local', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_weekly_remote_${suffix}`
  const ghlCalendarId = `ghl_cal_weekly_remote_${suffix}`
  const localAvailability = normalizeCalendarOpenHoursForWrite([
    {
      daysOfTheWeek: [1, 3, 5],
      hours: [
        { openHour: 9, openMinute: 15, closeHour: 12, closeMinute: 0 },
        { openHour: 14, openMinute: 0, closeHour: 17, closeMinute: 30 }
      ]
    }
  ])

  try {
    await upsertLocalCalendar({
      id: calendarId,
      ghlCalendarId,
      name: 'Agenda administrada en Ristak',
      source: 'ghl',
      openHours: localAvailability,
      availabilityScheduleConfigured: true
    }, {
      id: calendarId,
      source: 'ghl',
      ghlCalendarId,
      syncStatus: 'synced'
    })

    const mirrored = await upsertLocalCalendar({
      calendar: {
        id: ghlCalendarId,
        name: 'Nombre actualizado desde HighLevel',
        slotDuration: 30,
        slotInterval: 30
      }
    }, {
      id: calendarId,
      source: 'ghl',
      ghlCalendarId,
      syncStatus: 'synced'
    })

    assert.equal(mirrored.name, 'Nombre actualizado desde HighLevel')
    assert.deepEqual(mirrored.openHours, localAvailability)
    assert.equal(mirrored.availabilityScheduleConfigured, true)

    const stored = await db.get(
      'SELECT open_hours, availability_schedule_configured FROM calendars WHERE id = ?',
      [calendarId]
    )
    assert.deepEqual(JSON.parse(stored.open_hours), localAvailability)
    assert.equal(Number(stored.availability_schedule_configured), 1)
  } finally {
    await deleteCalendar(calendarId)
  }
})

test('un refresh remoto no pisa la decisión local de permitir empalmes', async () => {
  const calendarId = `rstk_cal_overlap_setting_${randomUUID()}`
  const ghlCalendarId = `ghl_cal_overlap_setting_${randomUUID()}`

  try {
    await upsertLocalCalendar({
      id: calendarId,
      ghlCalendarId,
      name: 'Agenda con política local de empalmes',
      source: 'ghl',
      appoinmentPerSlot: 5,
      allowOverlaps: false,
      openHours: DEFAULT_WEEKLY_AVAILABILITY
    }, { source: 'ghl', ghlCalendarId, syncStatus: 'synced' })

    const refreshed = await upsertLocalCalendar({
      id: calendarId,
      ghlCalendarId,
      name: 'Agenda refrescada',
      source: 'ghl',
      appoinmentPerSlot: 8
    }, { source: 'ghl', ghlCalendarId, syncStatus: 'synced' })
    assert.equal(refreshed.allowOverlaps, false)

    const enabled = await upsertLocalCalendar({
      id: calendarId,
      ghlCalendarId,
      name: 'Agenda refrescada',
      source: 'ghl',
      allowOverlaps: true
    }, { source: 'ghl', ghlCalendarId, syncStatus: 'synced' })
    assert.equal(enabled.allowOverlaps, true)
  } finally {
    await deleteCalendar(calendarId)
  }
})

test('un refresh remoto explícito no pisa una agenda local pendiente de sincronizar', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_weekly_pending_${suffix}`
  const ghlCalendarId = `ghl_cal_weekly_pending_${suffix}`
  const localAvailability = normalizeCalendarOpenHoursForWrite([{
    daysOfTheWeek: [2],
    hours: [{ openHour: 13, openMinute: 0, closeHour: 16, closeMinute: 0 }]
  }])
  const staleRemoteAvailability = normalizeCalendarOpenHoursForWrite([{
    daysOfTheWeek: [1],
    hours: [{ openHour: 9, openMinute: 0, closeHour: 10, closeMinute: 0 }]
  }])

  try {
    await upsertLocalCalendar({
      id: calendarId,
      ghlCalendarId,
      name: 'Agenda pendiente',
      source: 'ghl',
      openHours: localAvailability,
      availabilityScheduleConfigured: true
    }, {
      id: calendarId,
      source: 'ghl',
      ghlCalendarId,
      syncStatus: 'pending'
    })

    const mirrored = await upsertLocalCalendar({
      id: ghlCalendarId,
      name: 'Respuesta remota todavía vieja',
      openHours: staleRemoteAvailability
    }, {
      id: calendarId,
      source: 'ghl',
      ghlCalendarId,
      syncStatus: 'synced'
    })

    assert.deepEqual(mirrored.openHours, localAvailability)
    assert.equal(mirrored.availabilityScheduleConfigured, true)
    assert.equal(mirrored.syncStatus, 'pending')

    const mirroredAgain = await upsertLocalCalendar({
      id: ghlCalendarId,
      name: 'Otro refresh remoto todavía viejo',
      openHours: staleRemoteAvailability
    }, {
      id: calendarId,
      source: 'ghl',
      ghlCalendarId,
      syncStatus: 'synced'
    })
    assert.deepEqual(mirroredAgain.openHours, localAvailability)
    assert.equal(mirroredAgain.syncStatus, 'pending')

    const acknowledged = await upsertLocalCalendar({
      id: calendarId,
      ghlCalendarId,
      name: 'Agenda confirmada por el PUT',
      source: 'ghl',
      openHours: localAvailability,
      availabilityScheduleConfigured: true
    }, {
      id: calendarId,
      source: 'ghl',
      ghlCalendarId,
      syncStatus: 'synced',
      acknowledgeLocalWrite: true
    })
    assert.deepEqual(acknowledged.openHours, localAvailability)
    assert.equal(acknowledged.syncStatus, 'synced')
  } finally {
    await deleteCalendar(calendarId)
  }
})
