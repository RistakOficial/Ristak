import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { db } from '../src/config/database.js'
import {
  createLocalBlockedSlot,
  createLocalCalendar,
  createLocalAppointment,
  checkSlotAvailability,
  deleteLocalBlockedSlot,
  ensureHighLevelContactForAppointment,
  getLocalFreeSlots,
  getPublicCalendarBySlug,
  listLocalBlockedSlots,
  renderPublicCalendarHtml,
  updateLocalBlockedSlot,
  upsertLocalCalendar
} from '../src/services/localCalendarService.js'

test('getLocalFreeSlots usa el switch persistido como única política de empalmes', async () => {
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
    const savedCalendar = await upsertLocalCalendar({
      id: calendarId,
      ghlCalendarId,
      locationId: 'loc_overlap_test',
      name: 'Calendario GHL con cupo',
      source: 'ghl',
      allowBookingFor: 365,
      allowBookingForUnit: 'days',
      slotDuration: 60,
      slotInterval: 60,
      appoinmentPerSlot: 2,
      allowOverlaps: true,
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
      'el switch de empalmes debe conservar el slot tras una cita'
    )

    slots = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC', { appointmentLimit: 1 })
    assert.ok(
      slots[0]?.slots.includes(expectedSlot),
      'un override legacy no puede contradecir el switch persistido del calendario'
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
    assert.ok(
      slots[0]?.slots.includes(expectedSlot),
      'el switch conserva el horario aunque el cupo legacy de HighLevel ya se alcanzó'
    )

    assert.equal(savedCalendar.allowOverlaps, true)
    const disabledCalendar = await upsertLocalCalendar({
      id: calendarId,
      ghlCalendarId,
      source: 'ghl',
      allowOverlaps: false
    }, {
      source: 'ghl',
      ghlCalendarId,
      syncStatus: 'synced'
    })
    assert.equal(disabledCalendar.allowOverlaps, false)

    slots = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC')
    assert.equal(slots[0]?.slots.includes(expectedSlot), false)
    const conflict = await checkSlotAvailability(
      calendarId,
      slotStart.toISO(),
      slotEnd.toISO(),
      { timezone: 'UTC', enforceCalendarRules: true }
    )
    assert.equal(conflict.available, false)
    assert.equal(conflict.reason, 'slot_conflict')
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
      allowBookingFor: 365,
      allowBookingForUnit: 'days',
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
      allowBookingFor: 365,
      allowBookingForUnit: 'days',
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
      allowBookingFor: 365,
      allowBookingForUnit: 'days',
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

test('getLocalFreeSlots convierte slotDuration en horas antes de calcular los inicios disponibles', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_duration_hours_${suffix}`
  const baseDay = DateTime.utc().plus({ days: 41 }).startOf('day')
  const nextMonday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const dateKey = nextMonday.toISODate()

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda con duración expresada en horas',
      source: 'ristak',
      allowBookingFor: 365,
      allowBookingForUnit: 'days',
      slotDuration: 2,
      slotDurationUnit: 'hours',
      slotInterval: 30,
      slotIntervalUnit: 'mins',
      openHours: [{
        daysOfTheWeek: [1],
        hours: [{ openHour: 9, openMinute: 0, closeHour: 13, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })

    const slots = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC')
    const starts = slots[0]?.slots || []

    assert.deepEqual(starts, [
      nextMonday.set({ hour: 9, minute: 0 }).toISO(),
      nextMonday.set({ hour: 9, minute: 30 }).toISO(),
      nextMonday.set({ hour: 10, minute: 0 }).toISO(),
      nextMonday.set({ hour: 10, minute: 30 }).toISO(),
      nextMonday.set({ hour: 11, minute: 0 }).toISO()
    ])
    assert.equal(
      starts.includes(nextMonday.set({ hour: 11, minute: 30 }).toISO()),
      false,
      'una cita de dos horas que terminaría después del cierre no debe ofrecerse'
    )
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('getLocalFreeSlots bloquea una cita que empieza antes del rango y termina dentro de él', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_cross_range_${suffix}`
  const appointmentId = `rstk_appt_cross_range_${suffix}`
  const baseDay = DateTime.utc().plus({ days: 43 }).startOf('day')
  const nextMonday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const dateKey = nextMonday.toISODate()
  const midnightSlot = nextMonday.toISO()

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda con cita que cruza medianoche',
      source: 'ristak',
      allowBookingFor: 365,
      allowBookingForUnit: 'days',
      slotDuration: 30,
      slotDurationUnit: 'mins',
      slotInterval: 30,
      slotIntervalUnit: 'mins',
      openHours: [{
        daysOfTheWeek: [1],
        hours: [{ openHour: 0, openMinute: 0, closeHour: 2, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })

    await createLocalAppointment({
      id: appointmentId,
      calendarId,
      title: 'Cita que empezó el día anterior',
      source: 'ristak',
      startTime: nextMonday.minus({ minutes: 30 }).toISO(),
      endTime: nextMonday.plus({ minutes: 30 }).toISO(),
      appointmentStatus: 'confirmed'
    }, { syncStatus: 'synced' })

    const slots = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC')
    const starts = slots[0]?.slots || []

    assert.equal(
      starts.includes(midnightSlot),
      false,
      'el slot de 00:00 debe bloquearse aunque la cita haya empezado antes del rango consultado'
    )
    assert.equal(
      starts.includes(nextMonday.set({ hour: 0, minute: 30 }).toISO()),
      true,
      'el slot contiguo de 00:30 debe liberarse al terminar la cita'
    )
  } finally {
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('la lista y el candado final no inventan horario cuando openHours falta', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_without_default_hours_${suffix}`
  const baseDay = DateTime.utc().plus({ days: 47 }).startOf('day')
  const nextMonday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const dateKey = nextMonday.toISODate()

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda sin horario abierto configurado',
      source: 'ristak',
      allowBookingFor: 365,
      allowBookingForUnit: 'days',
      slotDuration: 60,
      slotInterval: 60,
      openHours: []
    }, { source: 'ristak', syncStatus: 'synced' })

    const slots = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC', {
      allowDefaultOpenHours: false
    })

    assert.deepEqual(slots[0]?.slots || [], [])

    const requestedStart = nextMonday.set({ hour: 9 })
    const strictAvailability = await checkSlotAvailability(
      calendarId,
      requestedStart.toISO(),
      requestedStart.plus({ hours: 1 }).toISO(),
      {
        timezone: 'UTC',
        currentTimeMs: nextMonday.minus({ days: 1 }).toMillis(),
        enforceCalendarRules: true
      }
    )
    assert.equal(strictAvailability.available, false)
    assert.equal(strictAvailability.reason, 'outside_open_hours')

    const legacyAvailability = await checkSlotAvailability(
      calendarId,
      requestedStart.toISO(),
      requestedStart.plus({ hours: 1 }).toISO()
    )
    assert.equal(legacyAvailability.available, true, 'el flujo legacy conserva su validación histórica')
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('la lista y el candado final respetan horario, cierre y cadencia en la zona del negocio', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_strict_open_hours_${suffix}`
  const timezone = 'America/Ciudad_Juarez'
  const businessDay = DateTime.fromISO('2030-01-07T00:00:00', { zone: timezone })
  const currentTime = businessDay.set({ hour: 7 })
  const dateKey = businessDay.toISODate()

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda estricta por zona del negocio',
      source: 'ristak',
      slotDuration: 1,
      slotDurationUnit: 'hours',
      slotInterval: 1,
      slotIntervalUnit: 'hours',
      allowBookingFor: 365,
      allowBookingForUnit: 'days',
      openHours: [{
        daysOfTheWeek: [businessDay.weekday],
        hours: [{ openHour: 9, openMinute: 15, closeHour: 13, closeMinute: 45 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })

    const listed = await getLocalFreeSlots(calendarId, dateKey, dateKey, timezone, {
      currentTimeMs: currentTime.toMillis(),
      allowDefaultOpenHours: false
    })
    const listedStarts = listed[0]?.slots || []
    const validStart = businessDay.set({ hour: 10, minute: 15 })
    assert.equal(listedStarts.includes(validStart.toUTC().toISO()), true)
    assert.equal(listedStarts.includes(businessDay.set({ hour: 10, minute: 30 }).toUTC().toISO()), false)
    assert.equal(listedStarts.includes(businessDay.set({ hour: 13, minute: 15 }).toUTC().toISO()), false)

    const available = await checkSlotAvailability(
      calendarId,
      validStart.toUTC().toISO(),
      validStart.plus({ hours: 1 }).toUTC().toISO(),
      { timezone, currentTimeMs: currentTime.toMillis(), enforceCalendarRules: true }
    )
    assert.equal(available.available, true)

    const misalignedStart = businessDay.set({ hour: 10, minute: 30 })
    const misaligned = await checkSlotAvailability(
      calendarId,
      misalignedStart.toUTC().toISO(),
      misalignedStart.plus({ hours: 1 }).toUTC().toISO(),
      { timezone, currentTimeMs: currentTime.toMillis(), enforceCalendarRules: true }
    )
    assert.equal(misaligned.available, false)
    assert.equal(misaligned.reason, 'slot_not_aligned')

    const afterClosingStart = businessDay.set({ hour: 13, minute: 15 })
    const afterClosing = await checkSlotAvailability(
      calendarId,
      afterClosingStart.toUTC().toISO(),
      afterClosingStart.plus({ hours: 1 }).toUTC().toISO(),
      { timezone, currentTimeMs: currentTime.toMillis(), enforceCalendarRules: true }
    )
    assert.equal(afterClosing.available, false)
    assert.equal(afterClosing.reason, 'outside_open_hours')

    const beforeOpeningStart = businessDay.set({ hour: 8, minute: 15 })
    const beforeOpening = await checkSlotAvailability(
      calendarId,
      beforeOpeningStart.toUTC().toISO(),
      beforeOpeningStart.plus({ hours: 1 }).toUTC().toISO(),
      { timezone, currentTimeMs: currentTime.toMillis(), enforceCalendarRules: true }
    )
    assert.equal(beforeOpening.available, false)
    assert.equal(beforeOpening.reason, 'outside_open_hours')
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('la lista y el candado final ofrecen dos bloques del mismo día y omiten el hueco entre ellos', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_two_blocks_${suffix}`
  const timezone = 'America/Ciudad_Juarez'
  const businessDay = DateTime.fromISO('2030-01-07T00:00:00', { zone: timezone })
  const currentTime = businessDay.set({ hour: 6 })
  const dateKey = businessDay.toISODate()

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda con dos bloques por día',
      source: 'ristak',
      slotDuration: 1,
      slotDurationUnit: 'hours',
      slotInterval: 1,
      slotIntervalUnit: 'hours',
      allowBookingFor: 365,
      allowBookingForUnit: 'days',
      // 9:00–13:00 y 14:00–19:00 el mismo día: el hueco 13:00–14:00 nunca debe
      // ofrecer horarios, ni en la URL pública ni en el agente (misma función).
      openHours: [{
        daysOfTheWeek: [businessDay.weekday],
        hours: [
          { openHour: 9, openMinute: 0, closeHour: 13, closeMinute: 0 },
          { openHour: 14, openMinute: 0, closeHour: 19, closeMinute: 0 }
        ]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })

    const listed = await getLocalFreeSlots(calendarId, dateKey, dateKey, timezone, {
      currentTimeMs: currentTime.toMillis(),
      allowDefaultOpenHours: false
    })
    const listedStarts = listed[0]?.slots || []
    const startAt = (hour) => businessDay.set({ hour, minute: 0 }).toUTC().toISO()

    // Primer bloque: 9, 10, 11 y 12 (el de las 12 termina justo a la 1 PM).
    for (const hour of [9, 10, 11, 12]) {
      assert.equal(listedStarts.includes(startAt(hour)), true, `falta ${hour}:00 del primer bloque`)
    }
    // El hueco 13:00–14:00 no ofrece ningún inicio.
    assert.equal(listedStarts.includes(startAt(13)), false, 'la 1 PM (hueco) no debe ofrecerse')
    // Segundo bloque: 14, 15, 16, 17 y 18 (el de las 18 termina a las 7 PM).
    for (const hour of [14, 15, 16, 17, 18]) {
      assert.equal(listedStarts.includes(startAt(hour)), true, `falta ${hour}:00 del segundo bloque`)
    }
    // Nada después del cierre del segundo bloque.
    assert.equal(listedStarts.includes(startAt(19)), false, 'las 7 PM (cierre) no debe ofrecerse')
    assert.equal(listedStarts.length, 9, 'solo 4 + 5 inicios entre ambos bloques')

    // El candado final (que usan tanto el POST público como el agente) coincide.
    const gapStart = businessDay.set({ hour: 13, minute: 0 })
    const gap = await checkSlotAvailability(
      calendarId,
      gapStart.toUTC().toISO(),
      gapStart.plus({ hours: 1 }).toUTC().toISO(),
      { timezone, currentTimeMs: currentTime.toMillis(), enforceCalendarRules: true }
    )
    assert.equal(gap.available, false)
    assert.equal(gap.reason, 'outside_open_hours')

    const secondBlockStart = businessDay.set({ hour: 14, minute: 0 })
    const secondBlock = await checkSlotAvailability(
      calendarId,
      secondBlockStart.toUTC().toISO(),
      secondBlockStart.plus({ hours: 1 }).toUTC().toISO(),
      { timezone, currentTimeMs: currentTime.toMillis(), enforceCalendarRules: true }
    )
    assert.equal(secondBlock.available, true)
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('la lista y el candado estricto fallan cerrado ante openHours malformado', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_malformed_hours_${suffix}`
  const timezone = 'America/Mexico_City'
  const businessDay = DateTime.fromISO('2030-01-07T00:00:00', { zone: timezone })
  const requestedStart = businessDay.set({ hour: 9 })

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda con horario malformado',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      allowBookingFor: 365,
      allowBookingForUnit: 'days',
      openHours: [{
        daysOfTheWeek: [businessDay.weekday],
        hours: [{ openHour: 'incorrecto', closeHour: 17, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })

    const listed = await getLocalFreeSlots(
      calendarId,
      businessDay.toISODate(),
      businessDay.toISODate(),
      timezone,
      {
        currentTimeMs: businessDay.minus({ days: 1 }).toMillis(),
        allowDefaultOpenHours: false
      }
    )
    assert.deepEqual(listed[0]?.slots || [], [])

    const strictAvailability = await checkSlotAvailability(
      calendarId,
      requestedStart.toUTC().toISO(),
      requestedStart.plus({ hours: 1 }).toUTC().toISO(),
      {
        timezone,
        currentTimeMs: businessDay.minus({ days: 1 }).toMillis(),
        enforceCalendarRules: true
      }
    )
    assert.equal(strictAvailability.available, false)
    assert.equal(strictAvailability.reason, 'outside_open_hours')
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('la lista y el candado final respetan anticipación mínima y horizonte máximo', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_booking_window_${suffix}`
  const now = DateTime.fromISO('2030-01-07T08:00:00.000Z', { zone: 'utc' })
  const dateKey = now.toISODate()

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda con ventana de reservación',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      allowBookingAfter: 2,
      allowBookingAfterUnit: 'hours',
      allowBookingFor: 1,
      allowBookingForUnit: 'days',
      openHours: [{
        daysOfTheWeek: [now.weekday],
        hours: [{ openHour: 8, openMinute: 0, closeHour: 13, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })

    const slots = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC', {
      currentTimeMs: now.toMillis()
    })
    const starts = slots[0]?.slots || []
    assert.equal(starts.includes(now.set({ hour: 9 }).toISO()), false)
    assert.equal(starts.includes(now.set({ hour: 10 }).toISO()), true)

    const tooSoon = await checkSlotAvailability(
      calendarId,
      now.set({ hour: 9 }).toISO(),
      now.set({ hour: 10 }).toISO(),
      { timezone: 'UTC', currentTimeMs: now.toMillis(), enforceCalendarRules: true }
    )
    assert.equal(tooSoon.available, false)
    assert.equal(tooSoon.reason, 'outside_booking_window')

    const beyondHorizon = await checkSlotAvailability(
      calendarId,
      now.plus({ days: 2 }).set({ hour: 10 }).toISO(),
      now.plus({ days: 2 }).set({ hour: 11 }).toISO(),
      { timezone: 'UTC', currentTimeMs: now.toMillis(), enforceCalendarRules: true }
    )
    assert.equal(beyondHorizon.available, false)
    assert.equal(beyondHorizon.reason, 'outside_booking_window')
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('la lista y el candado final respetan máximo diario y buffers antes/después', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_daily_buffers_${suffix}`
  const appointmentId = `rstk_appt_daily_buffers_${suffix}`
  const now = DateTime.fromISO('2030-01-07T07:00:00.000Z', { zone: 'utc' })
  const dateKey = now.toISODate()

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda con buffers y límite diario',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 30,
      preBuffer: 15,
      preBufferUnit: 'mins',
      slotBuffer: 15,
      slotBufferUnit: 'mins',
      appoinmentPerDay: 2,
      allowBookingFor: 365,
      allowBookingForUnit: 'days',
      openHours: [{
        daysOfTheWeek: [now.weekday],
        hours: [{ openHour: 8, openMinute: 0, closeHour: 13, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await createLocalAppointment({
      id: appointmentId,
      calendarId,
      title: 'Cita existente',
      startTime: now.set({ hour: 10, minute: 0 }).toISO(),
      endTime: now.set({ hour: 11, minute: 0 }).toISO(),
      appointmentStatus: 'confirmed'
    }, { syncStatus: 'synced' })

    const slots = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC', {
      currentTimeMs: now.toMillis()
    })
    const starts = slots[0]?.slots || []
    assert.equal(starts.includes(now.set({ hour: 9, minute: 0 }).toISO()), false)
    assert.equal(starts.includes(now.set({ hour: 8, minute: 30 }).toISO()), true)
    assert.equal(starts.includes(now.set({ hour: 11, minute: 0 }).toISO()), false)
    assert.equal(starts.includes(now.set({ hour: 11, minute: 30 }).toISO()), true)

    const bufferedConflict = await checkSlotAvailability(
      calendarId,
      now.set({ hour: 11, minute: 0 }).toISO(),
      now.set({ hour: 12, minute: 0 }).toISO(),
      { timezone: 'UTC', currentTimeMs: now.toMillis(), enforceCalendarRules: true }
    )
    assert.equal(bufferedConflict.available, false)
    assert.equal(bufferedConflict.reason, 'buffer_conflict')

    await createLocalAppointment({
      id: `${appointmentId}_second`,
      calendarId,
      title: 'Segunda cita del día',
      startTime: now.set({ hour: 8, minute: 0 }).toISO(),
      endTime: now.set({ hour: 9, minute: 0 }).toISO(),
      appointmentStatus: 'confirmed'
    }, { syncStatus: 'synced' })

    const dailyLimit = await checkSlotAvailability(
      calendarId,
      now.set({ hour: 12, minute: 0 }).toISO(),
      now.set({ hour: 13, minute: 0 }).toISO(),
      { timezone: 'UTC', currentTimeMs: now.toMillis(), enforceCalendarRules: true }
    )
    assert.equal(dailyLimit.available, false)
    assert.equal(dailyLimit.reason, 'daily_limit_reached')

    const noMoreSlots = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC', {
      currentTimeMs: now.toMillis()
    })
    assert.deepEqual(noMoreSlots[0]?.slots || [], [])

    const noMoreSlotsEvenWithOverlaps = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC', {
      currentTimeMs: now.toMillis(),
      ignoreAppointmentConflicts: true
    })
    assert.deepEqual(
      noMoreSlotsEvenWithOverlaps[0]?.slots || [],
      [],
      'permitir empalmes no debe saltarse el máximo diario configurado'
    )

    const dailyLimitEvenWithOverlaps = await checkSlotAvailability(
      calendarId,
      now.set({ hour: 12, minute: 0 }).toISO(),
      now.set({ hour: 13, minute: 0 }).toISO(),
      {
        timezone: 'UTC',
        currentTimeMs: now.toMillis(),
        enforceCalendarRules: true,
        ignoreAppointmentConflicts: true
      }
    )
    assert.equal(dailyLimitEvenWithOverlaps.available, false)
    assert.equal(dailyLimitEvenWithOverlaps.reason, 'daily_limit_reached')
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('sin empalmes, el buffer bloquea el mismo horario y sus vecinos aunque HighLevel anuncie más cupo', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_capacity_buffer_${suffix}`
  const appointmentId = `rstk_appt_capacity_buffer_${suffix}`
  const now = DateTime.fromISO('2030-01-07T07:00:00.000Z', { zone: 'utc' })
  const dateKey = now.toISODate()

  try {
    await upsertLocalCalendar({
      id: calendarId,
      ghlCalendarId: `ghl_capacity_buffer_${suffix}`,
      name: 'Agenda con capacidad y buffer',
      source: 'ghl',
      slotDuration: 60,
      slotInterval: 30,
      preBuffer: 15,
      preBufferUnit: 'mins',
      slotBuffer: 15,
      slotBufferUnit: 'mins',
      appoinmentPerSlot: 2,
      allowOverlaps: false,
      allowBookingFor: 365,
      allowBookingForUnit: 'days',
      openHours: [{
        daysOfTheWeek: [now.weekday],
        hours: [{ openHour: 9, openMinute: 0, closeHour: 13, closeMinute: 0 }]
      }]
    }, {
      source: 'ghl',
      ghlCalendarId: `ghl_capacity_buffer_${suffix}`,
      syncStatus: 'synced'
    })
    await createLocalAppointment({
      id: appointmentId,
      calendarId,
      title: 'Primera plaza del horario',
      source: 'ghl',
      startTime: now.set({ hour: 10 }).toISO(),
      endTime: now.set({ hour: 11 }).toISO(),
      appointmentStatus: 'confirmed'
    }, { syncStatus: 'synced' })

    const slots = await getLocalFreeSlots(calendarId, dateKey, dateKey, 'UTC', {
      currentTimeMs: now.toMillis()
    })
    const starts = slots[0]?.slots || []
    assert.equal(
      starts.includes(now.set({ hour: 10 }).toISO()),
      false,
      'el cupo legacy no puede contradecir el switch apagado'
    )
    assert.equal(
      starts.includes(now.set({ hour: 11 }).toISO()),
      false,
      'el buffer posterior no se convierte en una segunda plaza'
    )

    const neighbor = await checkSlotAvailability(
      calendarId,
      now.set({ hour: 11 }).toISO(),
      now.set({ hour: 12 }).toISO(),
      { timezone: 'UTC', currentTimeMs: now.toMillis(), enforceCalendarRules: true }
    )
    assert.equal(neighbor.available, false)
    assert.equal(neighbor.reason, 'buffer_conflict')
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('el calendario público muestra la duración real cuando está configurada en horas', () => {
  const html = renderPublicCalendarHtml({
    id: 'rstk_cal_duration_display',
    slug: 'duration-display',
    name: 'Duración correcta',
    slotDuration: 2,
    slotDurationUnit: 'hours'
  })

  assert.match(html, />120 min<\/span>/)
  assert.match(html, /"duration":120/)
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
      allowBookingFor: 365,
      allowBookingForUnit: 'days',
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
      googleCalendarId: 'ventas-google-externo@test.com'
    }, {
      source: 'google',
      syncStatus: 'synced',
      allowGoogleSyncMetadata: true
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
      syncStatus: 'pending',
      allowGoogleSyncMetadata: true
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
