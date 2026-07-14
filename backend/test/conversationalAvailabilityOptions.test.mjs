import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

import { db } from '../src/config/database.js'
import { getFreeSlots as getCalendarFreeSlots } from '../src/controllers/calendarsController.js'
import { invokeController } from '../src/agents/invokeController.js'
import {
  buildNativeAppointmentAvailabilityPresentation,
  buildNativeFreeSlotDays,
  createConversationalTools,
  filterNativeFreeSlotDays,
  loadConversationalAppointmentOfferDecisionContext
} from '../src/agents/conversational/tools.js'
import { ensureToolCallingV2VisibleReply } from '../src/agents/conversational/runner.js'
import { upsertLocalCalendar } from '../src/services/localCalendarService.js'
import { CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT } from '../src/services/conversationalAppointmentPreviewOfferService.js'
import { getAccountTimezone } from '../src/utils/dateUtils.js'

function localSlot(localDate, localTime, timezone) {
  return DateTime.fromISO(`${localDate}T${localTime}:00`, { zone: timezone }).toUTC().toISO()
}

function previewContext({ config, contactId, previewScopeId, executionId }) {
  return {
    runtimeMode: 'tool_calling_v2',
    contactId,
    agentId: config.id,
    channel: 'whatsapp',
    dryRun: true,
    previewScopeId,
    executionId,
    followUpMode: false,
    actions: [],
    accountLocale: { currency: 'MXN' },
    config
  }
}

function toolByName(ctx, name) {
  return createConversationalTools(ctx).find((item) => item.name === name)
}

function freeSlotsInput(startDate, endDate, overrides = {}) {
  return {
    startDate,
    endDate,
    appointmentId: null,
    weekdays: null,
    earliestLocalTime: null,
    latestLocalTime: null,
    relativeToPreviousOffer: null,
    ...overrides
  }
}

test('filtra días y horas en la zona del negocio y construye bloques legibles para chat', () => {
  const timezone = 'America/Ciudad_Juarez'
  const raw = [
    {
      date: '2030-07-17',
      timezone,
      slots: ['17:00', '18:00', '19:00'].map((time) => localSlot('2030-07-17', time, timezone))
    },
    {
      date: '2030-07-18',
      timezone,
      slots: ['16:00', '17:00', '18:00'].map((time) => localSlot('2030-07-18', time, timezone))
    },
    {
      date: '2030-07-19',
      timezone,
      slots: ['18:00', '19:00'].map((time) => localSlot('2030-07-19', time, timezone))
    }
  ]

  const filtered = filterNativeFreeSlotDays(buildNativeFreeSlotDays(raw, timezone), {
    timezone,
    weekdays: [3, 5],
    earliestLocalTime: '17:00'
  })
  assert.deepEqual(filtered.map((day) => day.localDate), ['2030-07-17', '2030-07-19'])
  assert.deepEqual(filtered[0].options.map((option) => option.localTime), ['17:00', '18:00', '19:00'])

  const presentation = buildNativeAppointmentAvailabilityPresentation(filtered, {
    timezone,
    intervalMinutes: 60,
    maxDays: 3
  })
  assert.match(presentation.visibleReply, /\*Miércoles 17 de julio\*/)
  assert.match(presentation.visibleReply, /5:00 p\.m\. a 7:00 p\.m\. \(cada hora\)/)
  assert.match(presentation.visibleReply, /\*Viernes 19 de julio\*/)
  assert.match(presentation.visibleReply, /6:00 p\.m\. y 7:00 p\.m\./)
  assert.match(presentation.visibleReply, /¿Qué día y horario te acomoda mejor\?/)

  const sparsePresentation = buildNativeAppointmentAvailabilityPresentation([{
    localDate: '2030-07-17',
    timezone,
    options: ['09:00', '11:00', '13:00'].map((localTime) => ({
      localTime,
      startTime: localSlot('2030-07-17', localTime, timezone)
    }))
  }], {
    timezone,
    intervalMinutes: 120
  })
  assert.match(sparsePresentation.visibleReply, /9:00 a\.m\., 11:00 a\.m\. y 1:00 p\.m\./)
})

test('más tarde compara la hora local y no confunde la misma hora de otro día', () => {
  const timezone = 'America/Ciudad_Juarez'
  const referenceStartTime = localSlot('2030-07-16', '19:00', timezone)
  const raw = [
    {
      date: '2030-07-17',
      timezone,
      slots: ['19:00', '20:00'].map((time) => localSlot('2030-07-17', time, timezone))
    }
  ]

  const filtered = filterNativeFreeSlotDays(buildNativeFreeSlotDays(raw, timezone), {
    timezone,
    relativeToStartTime: referenceStartTime,
    relativeToLocalDate: '2030-07-16',
    relativeToLocalTime: '19:00',
    relativeToTimezone: timezone,
    relativeDirection: 'later'
  })

  assert.deepEqual(
    filtered.flatMap((day) => day.options.map((option) => option.localTime)),
    ['20:00'],
    'miércoles 7:00 p.m. no es “más tarde” que martes 7:00 p.m.; es la misma hora local'
  )
})

test('más tarde distingue las dos 1:30 a.m. reales durante el cambio de horario', () => {
  const timezone = 'America/New_York'
  const firstOccurrence = '2030-11-03T05:30:00.000Z'
  const secondOccurrence = '2030-11-03T06:30:00.000Z'
  const raw = [{ date: '2030-11-03', timezone, slots: [firstOccurrence, secondOccurrence] }]

  const filtered = filterNativeFreeSlotDays(buildNativeFreeSlotDays(raw, timezone), {
    timezone,
    relativeToStartTime: firstOccurrence,
    relativeToLocalDate: '2030-11-03',
    relativeToLocalTime: '01:30',
    relativeToTimezone: timezone,
    relativeDirection: 'later'
  })

  assert.deepEqual(
    filtered.flatMap((day) => day.options.map((option) => option.startTime)),
    [secondOccurrence],
    'la segunda 1:30 ocurre una hora real después y debe seguir siendo negociable'
  )
})

test('una referencia conserva su zona original y no fabrica un desempate al cambiar la zona del negocio', () => {
  const currentTimezone = 'America/Ciudad_Juarez'
  const originalTimezone = 'America/New_York'
  const referenceStartTime = '2030-07-17T15:00:00.000Z' // 11:00 en Nueva York
  const candidateStartTime = '2030-07-17T17:00:00.000Z' // 11:00 en Ciudad Juárez
  const raw = [{ date: '2030-07-17', timezone: currentTimezone, slots: [candidateStartTime] }]

  const filtered = filterNativeFreeSlotDays(buildNativeFreeSlotDays(raw, currentTimezone), {
    timezone: currentTimezone,
    relativeToStartTime: referenceStartTime,
    relativeToLocalDate: '2030-07-17',
    relativeToLocalTime: '11:00',
    relativeToTimezone: originalTimezone,
    relativeDirection: 'later'
  })

  assert.equal(filtered.length, 0, '11:00 sigue siendo 11:00; sólo un pliegue DST de la misma zona desempata por instante')
})

test('get_free_slots rechaza horas imposibles en vez de ignorar la restricción', async () => {
  const suffix = randomUUID()
  const config = {
    id: `agent_invalid_local_time_${suffix}`,
    runtimeMode: 'tool_calling_v2',
    capabilitiesConfig: {
      schemaVersion: 1,
      items: [{ id: 'schedule_appointment', enabled: true, calendarId: `calendar_invalid_time_${suffix}` }]
    }
  }
  const ctx = previewContext({
    config,
    contactId: `contact_invalid_time_${suffix}`,
    previewScopeId: `appointment_preview_${createHash('sha256').update(suffix).digest('hex').slice(0, 48)}`,
    executionId: `execution_invalid_time_${suffix}`
  })

  const invalidResult = await toolByName(ctx, 'get_free_slots').invoke(null, JSON.stringify(freeSlotsInput(
      '2030-07-17',
      '2030-07-17',
      { earliestLocalTime: '29:99' }
    )))
  assert.match(String(invalidResult), /Invalid JSON input for tool/i)
})

test('offer_appointment_options muestra hasta tres días reales sin crear una oferta confirmable', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_grouped_options_${suffix}`
  const agentId = `agent_grouped_options_${suffix}`
  const contactId = `contact_grouped_options_${suffix}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 21 }).startOf('day')
  const firstDay = baseDay.plus({ days: (2 - baseDay.weekday + 7) % 7 })
  const lastDay = firstDay.plus({ days: 2 })
  const previewScopeId = `appointment_preview_${createHash('sha256').update(suffix).digest('hex').slice(0, 48)}`
  const config = {
    id: agentId,
    runtimeMode: 'tool_calling_v2',
    objective: 'custom',
    capabilitiesConfig: {
      schemaVersion: 1,
      items: [{ id: 'schedule_appointment', enabled: true, calendarId, allowOverlaps: false }]
    }
  }
  const ctx = {
    runtimeMode: 'tool_calling_v2',
    contactId,
    agentId,
    channel: 'whatsapp',
    dryRun: true,
    previewScopeId,
    followUpMode: false,
    actions: [],
    accountLocale: { currency: 'MXN' },
    config
  }

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda con opciones agrupadas',
      source: 'ristak',
      slotDuration: 1,
      slotDurationUnit: 'hours',
      slotInterval: 60,
      slotIntervalUnit: 'mins',
      appoinmentPerSlot: 2,
      openHours: [
        {
          daysOfTheWeek: [firstDay.weekday, firstDay.plus({ days: 1 }).weekday, lastDay.weekday],
          hours: [{ openHour: 9, openMinute: 0, closeHour: 12, closeMinute: 0 }]
        }
      ]
    }, { source: 'ristak', syncStatus: 'synced' })

    const tools = createConversationalTools(ctx)
    const getFreeSlots = tools.find((item) => item.name === 'get_free_slots')
    const availability = await getFreeSlots.invoke(null, JSON.stringify({
      startDate: firstDay.toISODate(),
      endDate: lastDay.toISODate(),
      appointmentId: null,
      weekdays: null,
      earliestLocalTime: null,
      latestLocalTime: null,
      relativeToPreviousOffer: null
    }))
    assert.equal(availability.ok, true, JSON.stringify(availability))
    assert.equal(availability.total, 9)
    assert.equal(availability.durationMinutes, 60)

    const grouped = await tools
      .find((item) => item.name === 'offer_appointment_options')
      .invoke(null, JSON.stringify({ maxDays: 3 }))
    assert.equal(grouped.ok, true, JSON.stringify(grouped))
    assert.equal(grouped.terminal, true)
    assert.equal(grouped.actionCompleted, false)
    assert.equal(grouped.displayedDays, 3)
    assert.match(grouped.visibleReply, /\*.+\*/)
    assert.match(grouped.visibleReply, /9:00 a\.m\. a 11:00 a\.m\. \(cada hora\)/)
    assert.equal(ctx.actions.at(-1)?.type, 'offer_appointment_options')
    assert.equal(
      ensureToolCallingV2VisibleReply('texto inventado por el modelo', ctx.actions),
      grouped.visibleReply,
      'el servidor debe conservar su lista exacta como la única respuesta visible'
    )

    const pendingOffer = await loadConversationalAppointmentOfferDecisionContext({ ctx, config })
    assert.equal(pendingOffer, null, 'una lista amplia nunca debe convertir un “ok” ambiguo en una cita')
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('una lista durable permite pedir más tarde o más temprano en otra ejecución sin repetir sus límites', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_relative_list_${suffix}`
  const agentId = `agent_relative_list_${suffix}`
  const contactId = `contact_relative_list_${suffix}`
  const timezone = await getAccountTimezone()
  const firstDay = DateTime.now().setZone(timezone).plus({ days: 24 }).startOf('day')
  const lastDay = firstDay.plus({ days: 1 })
  const config = {
    id: agentId,
    runtimeMode: 'tool_calling_v2',
    objective: 'custom',
    capabilitiesConfig: {
      schemaVersion: 1,
      items: [{ id: 'schedule_appointment', enabled: true, calendarId, allowOverlaps: false }]
    }
  }
  const scope = (label) => `appointment_preview_${createHash('sha256').update(`${suffix}:${label}`).digest('hex').slice(0, 48)}`

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda para referencias relativas de lista',
      source: 'ristak',
      slotDuration: 60,
      slotDurationUnit: 'mins',
      slotInterval: 60,
      slotIntervalUnit: 'mins',
      appoinmentPerSlot: 1,
      openHours: [{
        daysOfTheWeek: [firstDay.weekday, lastDay.weekday],
        hours: [{ openHour: 9, openMinute: 0, closeHour: 14, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })

    const laterScope = scope('later')
    const listCtx = previewContext({
      config,
      contactId,
      previewScopeId: laterScope,
      executionId: `execution_list_${suffix}`
    })
    const listed = await toolByName(listCtx, 'get_free_slots').invoke(null, JSON.stringify(freeSlotsInput(
      firstDay.toISODate(),
      lastDay.toISODate(),
      { latestLocalTime: '11:00' }
    )))
    assert.equal(listed.ok, true, JSON.stringify(listed))
    assert.deepEqual(
      listed.slots.flatMap((day) => day.options.map((option) => option.localTime)),
      ['09:00', '10:00', '11:00', '09:00', '10:00', '11:00']
    )
    const displayed = await toolByName(listCtx, 'offer_appointment_options')
      .invoke(null, JSON.stringify({ maxDays: 2 }))
    assert.equal(displayed.ok, true, JSON.stringify(displayed))

    const referenceRow = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = ?`,
      [contactId, agentId, 'appointment_availability_options_presented']
    )
    const referenceDetail = JSON.parse(referenceRow.detail_json)
    assert.equal(referenceDetail.previewScopeId, laterScope)
    assert.equal(referenceDetail.purpose, 'book')
    assert.equal(referenceDetail.minimumDisplayedStartTime, localSlot(firstDay.toISODate(), '09:00', timezone))
    assert.equal(referenceDetail.maximumDisplayedStartTime, localSlot(lastDay.toISODate(), '11:00', timezone))
    assert.equal('displayedStartTimes' in referenceDetail, false, 'el evento no debe guardar la lista completa')

    const laterCtx = previewContext({
      config,
      contactId,
      previewScopeId: laterScope,
      executionId: `execution_later_${suffix}`
    })
    const later = await toolByName(laterCtx, 'get_free_slots').invoke(null, JSON.stringify(freeSlotsInput(
      firstDay.toISODate(),
      lastDay.toISODate(),
      { weekdays: [firstDay.weekday], relativeToPreviousOffer: 'later' }
    )))
    assert.equal(later.ok, true, JSON.stringify(later))
    assert.deepEqual(
      later.slots.flatMap((day) => day.options.map((option) => option.localTime)),
      ['12:00', '13:00'],
      'later debe ser estrictamente mayor al máximo local mostrado y conservar weekdays'
    )

    const earlierScope = scope('earlier')
    const highListCtx = previewContext({
      config,
      contactId,
      previewScopeId: earlierScope,
      executionId: `execution_high_list_${suffix}`
    })
    const highListed = await toolByName(highListCtx, 'get_free_slots').invoke(null, JSON.stringify(freeSlotsInput(
      firstDay.toISODate(),
      lastDay.toISODate(),
      { earliestLocalTime: '11:00' }
    )))
    assert.equal(highListed.ok, true, JSON.stringify(highListed))
    assert.equal(
      (await toolByName(highListCtx, 'offer_appointment_options').invoke(null, JSON.stringify({ maxDays: 2 }))).ok,
      true
    )

    const earlierCtx = previewContext({
      config,
      contactId,
      previewScopeId: earlierScope,
      executionId: `execution_earlier_${suffix}`
    })
    const earlier = await toolByName(earlierCtx, 'get_free_slots').invoke(null, JSON.stringify(freeSlotsInput(
      firstDay.toISODate(),
      lastDay.toISODate(),
      { weekdays: [firstDay.weekday], relativeToPreviousOffer: 'earlier' }
    )))
    assert.equal(earlier.ok, true, JSON.stringify(earlier))
    assert.deepEqual(
      earlier.slots.flatMap((day) => day.options.map((option) => option.localTime)),
      ['09:00', '10:00'],
      'earlier debe ser estrictamente menor al mínimo local mostrado'
    )
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('un horario individual rechazado más recientemente manda sobre la lista anterior', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_latest_relative_${suffix}`
  const agentId = `agent_latest_relative_${suffix}`
  const contactId = `contact_latest_relative_${suffix}`
  const timezone = await getAccountTimezone()
  const day = DateTime.now().setZone(timezone).plus({ days: 26 }).startOf('day')
  const previewScopeId = `appointment_preview_${createHash('sha256').update(suffix).digest('hex').slice(0, 48)}`
  const config = {
    id: agentId,
    runtimeMode: 'tool_calling_v2',
    objective: 'custom',
    capabilitiesConfig: {
      schemaVersion: 1,
      items: [{ id: 'schedule_appointment', enabled: true, calendarId, allowOverlaps: false }]
    }
  }

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda para precedencia de referencia',
      source: 'ristak',
      slotDuration: 60,
      slotDurationUnit: 'mins',
      slotInterval: 60,
      slotIntervalUnit: 'mins',
      appoinmentPerSlot: 1,
      openHours: [{
        daysOfTheWeek: [day.weekday],
        hours: [{ openHour: 9, openMinute: 0, closeHour: 14, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })

    const listCtx = previewContext({
      config,
      contactId,
      previewScopeId,
      executionId: `execution_list_${suffix}`
    })
    const listed = await toolByName(listCtx, 'get_free_slots').invoke(null, JSON.stringify(freeSlotsInput(
      day.toISODate(),
      day.toISODate(),
      { latestLocalTime: '11:00' }
    )))
    assert.equal(listed.ok, true, JSON.stringify(listed))
    assert.equal(
      (await toolByName(listCtx, 'offer_appointment_options').invoke(null, JSON.stringify({ maxDays: 1 }))).ok,
      true
    )

    const offerCtx = previewContext({
      config,
      contactId,
      previewScopeId,
      executionId: `execution_offer_${suffix}`
    })
    const exact = await toolByName(offerCtx, 'get_free_slots').invoke(null, JSON.stringify(freeSlotsInput(
      day.toISODate(),
      day.toISODate(),
      { earliestLocalTime: '10:00', latestLocalTime: '10:00' }
    )))
    assert.equal(exact.ok, true, JSON.stringify(exact))
    const rejectedStartTime = exact.slots[0].options[0].startTime
    const offered = await toolByName(offerCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: rejectedStartTime,
      appointmentId: null
    }))
    assert.equal(offered.ok, true, JSON.stringify(offered))

    const offerRow = await db.get(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = ?`,
      [contactId, agentId, CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT]
    )
    const offerDetail = JSON.parse(offerRow.detail_json)
    const rejectedDetail = {
      ...offerDetail,
      status: 'superseded',
      phase: 'resolved',
      resolution: 'request_other_options',
      resolvedAt: new Date().toISOString()
    }
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?',
      [JSON.stringify(rejectedDetail), offerRow.id]
    )

    const relativeCtx = previewContext({
      config,
      contactId,
      previewScopeId,
      executionId: `execution_relative_${suffix}`
    })
    const relative = await toolByName(relativeCtx, 'get_free_slots').invoke(null, JSON.stringify(freeSlotsInput(
      day.toISODate(),
      day.toISODate(),
      {
        weekdays: [day.weekday],
        latestLocalTime: '12:00',
        relativeToPreviousOffer: 'later'
      }
    )))
    assert.equal(relative.ok, true, JSON.stringify(relative))
    assert.deepEqual(
      relative.slots.flatMap((item) => item.options.map((option) => option.localTime)),
      ['11:00', '12:00'],
      '11:00 demuestra que ganó el rechazo individual de las 10:00 y no el máximo 11:00 de la lista'
    )
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('una oferta preview activa pero vencida no bloquea el siguiente horario', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_expired_preview_${suffix}`
  const agentId = `agent_expired_preview_${suffix}`
  const contactId = `contact_expired_preview_${suffix}`
  const timezone = await getAccountTimezone()
  const day = DateTime.now().setZone(timezone).plus({ days: 28 }).startOf('day')
  const previewScopeId = `appointment_preview_${createHash('sha256').update(suffix).digest('hex').slice(0, 48)}`
  const config = {
    id: agentId,
    runtimeMode: 'tool_calling_v2',
    objective: 'custom',
    capabilitiesConfig: {
      schemaVersion: 1,
      items: [{ id: 'schedule_appointment', enabled: true, calendarId, allowOverlaps: false }]
    }
  }

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda con oferta preview vencida',
      source: 'ristak',
      slotDuration: 60,
      slotDurationUnit: 'mins',
      slotInterval: 60,
      slotIntervalUnit: 'mins',
      appoinmentPerSlot: 1,
      openHours: [{
        daysOfTheWeek: [day.weekday],
        hours: [{ openHour: 9, openMinute: 0, closeHour: 12, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })

    const firstCtx = previewContext({
      config,
      contactId,
      previewScopeId,
      executionId: `execution_first_${suffix}`
    })
    const firstAvailability = await toolByName(firstCtx, 'get_free_slots').invoke(null, JSON.stringify(freeSlotsInput(
      day.toISODate(),
      day.toISODate(),
      { earliestLocalTime: '09:00', latestLocalTime: '09:00' }
    )))
    const firstOffer = await toolByName(firstCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: firstAvailability.slots[0].options[0].startTime,
      appointmentId: null
    }))
    assert.equal(firstOffer.ok, true, JSON.stringify(firstOffer))

    const stored = await db.get(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = ?`,
      [contactId, agentId, CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT]
    )
    const expiredDetail = {
      ...JSON.parse(stored.detail_json),
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    }
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?',
      [JSON.stringify(expiredDetail), stored.id]
    )

    const relativeCtx = previewContext({
      config,
      contactId,
      previewScopeId,
      executionId: `execution_relative_after_expiry_${suffix}`
    })
    const relativeAvailability = await toolByName(relativeCtx, 'get_free_slots').invoke(null, JSON.stringify(freeSlotsInput(
      day.toISODate(),
      day.toISODate(),
      { relativeToPreviousOffer: 'later' }
    )))
    assert.equal(relativeAvailability.ok, true, JSON.stringify(relativeAvailability))
    assert.deepEqual(
      relativeAvailability.slots.flatMap((item) => item.options.map((option) => option.localTime)),
      ['10:00', '11:00'],
      'la oferta vencida ya no se puede aceptar, pero conserva por 24 horas el significado de “más tarde”'
    )

    const secondCtx = previewContext({
      config,
      contactId,
      previewScopeId,
      executionId: `execution_second_${suffix}`
    })
    const secondAvailability = await toolByName(secondCtx, 'get_free_slots').invoke(null, JSON.stringify(freeSlotsInput(
      day.toISODate(),
      day.toISODate(),
      { earliestLocalTime: '10:00', latestLocalTime: '10:00' }
    )))
    const secondStartTime = secondAvailability.slots[0].options[0].startTime
    const secondOffer = await toolByName(secondCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: secondStartTime,
      appointmentId: null
    }))
    assert.equal(secondOffer.ok, true, JSON.stringify(secondOffer))

    const replaced = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [stored.id]
    )).detail_json)
    assert.equal(replaced.status, 'active')
    assert.equal(replaced.startTime, secondStartTime)
    assert.equal(replaced.executionId, secondCtx.executionId)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('la agenda del agente usa la disponibilidad local aunque el espejo HighLevel esté desconectado', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_unverified_ghl_${suffix}`
  const ghlCalendarId = `ghl_unverified_${suffix}`
  const timezone = await getAccountTimezone()
  const localDate = DateTime.now().setZone(timezone).plus({ days: 14 }).toISODate()

  try {
    await upsertLocalCalendar({
      id: calendarId,
      ghlCalendarId,
      name: 'Agenda HighLevel sin conexión de prueba',
      source: 'ghl',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{
        daysOfTheWeek: [DateTime.fromISO(localDate, { zone: timezone }).weekday],
        hours: [{ openHour: 9, openMinute: 0, closeHour: 12, closeMinute: 0 }]
      }]
    }, { source: 'ghl', ghlCalendarId, syncStatus: 'synced' })

    const response = await invokeController(getCalendarFreeSlots, {
      params: { id: calendarId },
      query: { startDate: localDate, endDate: localDate, timezone },
      internalContext: {
        requireVerifiedExternalAvailability: true,
        availabilityOptions: { allowDefaultOpenHours: false }
      }
    })
    assert.equal(response.statusCode, 200, JSON.stringify(response.payload))
    assert.equal(response.payload?.success, true)
    assert.ok(Array.isArray(response.payload?.data))
    assert.ok(response.payload.data.flatMap(day => day.slots || []).length > 0)
  } finally {
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})
