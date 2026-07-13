import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getCalendarAppointmentDurationMinutes,
  intersectCalendarAvailabilitySlots,
  resolveCalendarAvailabilityProvider,
  resolveCalendarAvailabilitySlots
} from '../src/controllers/calendarsController.js'

test('calendario Ristak con espejo GHL valida disponibilidad sólo en la agenda local canónica', async () => {
  const availabilityOptions = {
    allowDefaultOpenHours: false,
    excludeAppointmentId: 'appointment-reschedule',
    durationMinutes: 120
  }
  const calls = []
  const calendar = {
    id: 'rstk-calendar-linked-ghl',
    source: 'ristak',
    ghlCalendarId: 'ghl-calendar-real'
  }
  const localDays = [{
    date: '2030-07-15',
    timezone: 'America/Ciudad_Juarez',
    slots: [
      '2030-07-15T16:00:00.000Z',
      '2030-07-15T18:00:00.000Z'
    ]
  }]
  const provider = resolveCalendarAvailabilityProvider(calendar, calendar.id)
  assert.deepEqual(provider, { provider: 'ghl', remoteCalendarId: 'ghl-calendar-real' })

  const result = await resolveCalendarAvailabilitySlots({
    calendar,
    requestedCalendarId: calendar.id,
    startDate: '2030-07-15',
    endDate: '2030-07-15',
    timezone: 'America/Ciudad_Juarez',
    accessToken: 'test-token',
    requireVerifiedExternalAvailability: true,
    availabilityOptions
  }, {
    getLocalFreeSlots: async (calendarId, startDate, endDate, timezone, options) => {
      calls.push('local')
      assert.equal(calendarId, calendar.id)
      assert.equal(startDate, '2030-07-15')
      assert.equal(endDate, '2030-07-15')
      assert.equal(timezone, 'America/Ciudad_Juarez')
      assert.equal(options, availabilityOptions)
      return localDays
    },
    getHighLevelFreeSlots: async (calendarId, startDate, endDate, accessToken, timezone) => {
      void calendarId; void startDate; void endDate; void accessToken; void timezone
      assert.fail('HighLevel es espejo y no debe vetar slots del calendario local')
    },
    syncGoogleEventsForDateRange: async () => {
      assert.fail('un calendario GHL no debe intentar sincronizar Google')
    }
  })

  assert.deepEqual(calls, ['local'])
  assert.deepEqual(result, localDays)
})

test('allowOverlaps conserva los slots locales sin depender de la disponibilidad de GHL', async () => {
  const calls = []
  const calendar = {
    id: 'rstk-calendar-linked-ghl-overlaps',
    source: 'ristak',
    ghlCalendarId: 'ghl-calendar-overlaps'
  }
  const localDays = [{
    date: '2030-07-15',
    timezone: 'America/Ciudad_Juarez',
    slots: ['2030-07-15T16:00:00.000Z', '2030-07-15T18:00:00.000Z']
  }]

  const result = await resolveCalendarAvailabilitySlots({
    calendar,
    requestedCalendarId: calendar.id,
    startDate: '2030-07-15',
    endDate: '2030-07-15',
    timezone: 'America/Ciudad_Juarez',
    accessToken: 'test-token',
    requireVerifiedExternalAvailability: true,
    availabilityOptions: {
      allowDefaultOpenHours: false,
      ignoreAppointmentConflicts: true
    }
  }, {
    getHighLevelFreeSlots: async () => {
      assert.fail('el espejo GHL no debe consultarse para decidir disponibilidad local')
    },
    getLocalFreeSlots: async (_calendarId, _startDate, _endDate, _timezone, options) => {
      calls.push('local')
      assert.equal(options.ignoreAppointmentConflicts, true)
      return localDays
    },
    syncGoogleEventsForDateRange: async () => assert.fail('no aplica Google')
  })

  assert.deepEqual(calls, ['local'])
  assert.deepEqual(result, localDays)
})

test('calendario Google sincroniza sólo Google y calcula disponibilidad local después del sync', async () => {
  const calls = []
  const calendar = {
    id: 'rstk-calendar-linked-google',
    source: 'ristak',
    googleCalendarId: 'primary@example.test'
  }
  const localDays = [{ date: '2030-07-16', slots: ['2030-07-16T15:00:00.000Z'] }]

  const result = await resolveCalendarAvailabilitySlots({
    calendar,
    requestedCalendarId: calendar.id,
    startDate: '2030-07-16',
    endDate: '2030-07-16',
    timezone: 'UTC',
    accessToken: 'unused-ghl-token',
    requireVerifiedExternalAvailability: true,
    availabilityOptions: { allowDefaultOpenHours: false }
  }, {
    syncGoogleEventsForDateRange: async (input) => {
      calls.push('google')
      assert.equal(input.calendarId, calendar.id)
      return { enabled: true, linkedCalendars: 1, saved: 0 }
    },
    getLocalFreeSlots: async () => {
      calls.push('local')
      return localDays
    },
    getHighLevelFreeSlots: async () => {
      assert.fail('un calendario Google no debe consultar HighLevel')
    }
  })

  assert.deepEqual(calls, ['google', 'local'])
  assert.equal(result, localDays)
})

test('calendario con Google y HighLevel refresca Google y decide con la BD local', async () => {
  const calls = []
  const calendar = {
    id: 'rstk-calendar-linked-both',
    source: 'ristak',
    ghlCalendarId: 'ghl-calendar-linked-both',
    googleCalendarId: 'google-calendar-linked-both@example.test'
  }
  const provider = resolveCalendarAvailabilityProvider(calendar, calendar.id)
  assert.deepEqual(provider, {
    provider: 'ghl_google',
    remoteCalendarId: 'ghl-calendar-linked-both',
    googleCalendarId: 'google-calendar-linked-both@example.test'
  })

  const result = await resolveCalendarAvailabilitySlots({
    calendar,
    requestedCalendarId: calendar.id,
    startDate: '2030-07-16',
    endDate: '2030-07-16',
    timezone: 'UTC',
    accessToken: 'test-token',
    requireVerifiedExternalAvailability: true,
    availabilityOptions: { allowDefaultOpenHours: false }
  }, {
    syncGoogleEventsForDateRange: async () => {
      calls.push('google')
      return { enabled: true, linkedCalendars: 1 }
    },
    getHighLevelFreeSlots: async () => {
      assert.fail('HighLevel es espejo y no debe intersectar la agenda local')
    },
    getLocalFreeSlots: async () => {
      calls.push('local')
      return [{
        date: '2030-07-16',
        slots: ['2030-07-16T15:00:00.000Z', '2030-07-16T16:00:00.000Z']
      }]
    }
  })

  assert.deepEqual(calls, ['google', 'local'])
  assert.deepEqual(result[0].slots, ['2030-07-16T15:00:00.000Z', '2030-07-16T16:00:00.000Z'])
})

test('una caída del espejo no bloquea la disponibilidad guardada en Ristak', async () => {
  const ghlLocal = [{ date: '2030-07-17', slots: ['2030-07-17T16:00:00.000Z'] }]
  assert.deepEqual(
    await resolveCalendarAvailabilitySlots({
      calendar: {
        id: 'rstk-calendar-without-ghl-token',
        source: 'ristak',
        ghlCalendarId: 'ghl-calendar-without-token'
      },
      requestedCalendarId: 'rstk-calendar-without-ghl-token',
      startDate: '2030-07-17',
      endDate: '2030-07-17',
      timezone: 'UTC',
      accessToken: null,
      requireVerifiedExternalAvailability: true
    }, {
      getLocalFreeSlots: async () => ghlLocal,
      getHighLevelFreeSlots: async () => assert.fail('no debe llamar GHL sin token'),
      syncGoogleEventsForDateRange: async () => assert.fail('no debe llamar Google para una liga GHL')
    }),
    ghlLocal
  )

  const googleLocal = [{ date: '2030-07-17', slots: ['2030-07-17T18:00:00.000Z'] }]
  assert.deepEqual(
    await resolveCalendarAvailabilitySlots({
      calendar: {
        id: 'rstk-calendar-google-not-linked',
        source: 'ristak',
        googleCalendarId: 'missing@example.test'
      },
      requestedCalendarId: 'rstk-calendar-google-not-linked',
      startDate: '2030-07-17',
      endDate: '2030-07-17',
      timezone: 'UTC',
      requireVerifiedExternalAvailability: true
    }, {
      syncGoogleEventsForDateRange: async () => ({ enabled: true, linkedCalendars: 0 }),
      getLocalFreeSlots: async () => googleLocal
    }),
    googleLocal
  )
})

test('intersección canónica compara instantes equivalentes aunque usen offsets distintos', () => {
  const result = intersectCalendarAvailabilitySlots(
    [{
      date: '2030-07-18',
      slots: [
        '2030-07-18T16:00:00.000Z',
        '2030-07-18T17:00:00.000Z',
        'fecha-inválida'
      ]
    }],
    [{
      date: '2030-07-18',
      slots: [
        '2030-07-18T10:00:00-06:00',
        '2030-07-18T10:00:00-06:00',
        { startTime: '2030-07-18T18:00:00.000Z' }
      ]
    }]
  )

  assert.deepEqual(result[0].slots, ['2030-07-18T16:00:00.000Z'])
})

test('la cita pública convierte unidades de duración antes de calcular su final', () => {
  assert.equal(getCalendarAppointmentDurationMinutes({
    slotDuration: 2,
    slotDurationUnit: 'hours'
  }), 120)
  assert.equal(getCalendarAppointmentDurationMinutes({
    slot_duration: 90,
    slot_duration_unit: 'mins'
  }), 90)
})
