import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

import { db } from '../src/config/database.js'
import {
  buildNativeAppointmentAvailabilityPresentation,
  buildNativeFreeSlotDays,
  createConversationalTools,
  filterNativeFreeSlotDays,
  loadConversationalAppointmentOfferDecisionContext
} from '../src/agents/conversational/tools.js'
import { buildCanonicalAppointmentSlotOption } from '../src/agents/conversational/actionEvidence.js'
import {
  CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT,
  buildConversationalAppointmentPreviewOfferEventId
} from '../src/services/conversationalAppointmentPreviewOfferService.js'
import { upsertLocalCalendar } from '../src/services/localCalendarService.js'
import { getAccountTimezone } from '../src/utils/dateUtils.js'

function localSlot(localDate, localTime, timezone) {
  return DateTime.fromISO(`${localDate}T${localTime}:00`, { zone: timezone }).toUTC().toISO()
}

function epochMinute(value) {
  return Math.floor(Date.parse(String(value || '')) / 60000)
}

function toolNamed(ctx, name) {
  const found = createConversationalTools(ctx).find((item) => item.name === name)
  assert.ok(found, `Falta la herramienta ${name}`)
  return found
}

test('DST fallback conserva ambos instantes repetidos, muestra offsets y permite pedir el segundo como más tarde', () => {
  const timezone = 'America/Ciudad_Juarez'
  const firstOccurrence = '2030-11-03T07:30:00.000Z'
  const secondOccurrence = '2030-11-03T08:30:00.000Z'
  const days = buildNativeFreeSlotDays([{
    date: '2030-11-03',
    timezone,
    slots: [firstOccurrence, secondOccurrence]
  }], timezone)

  assert.equal(days[0].options.length, 2)
  assert.match(days[0].options[0].localLabel, /UTC-06:00/)
  assert.match(days[0].options[1].localLabel, /UTC-07:00/)

  const presentation = buildNativeAppointmentAvailabilityPresentation(days, {
    timezone,
    intervalMinutes: 60
  })
  assert.match(presentation.visibleReply, /1:30 a\.m\. \(UTC-06:00\)/)
  assert.match(presentation.visibleReply, /1:30 a\.m\. \(UTC-07:00\)/)
  assert.deepEqual(presentation.displayedStartTimes, [firstOccurrence, secondOccurrence])

  const later = filterNativeFreeSlotDays(days, {
    timezone,
    excludedStartTimes: [firstOccurrence],
    relativeToStartTime: firstOccurrence,
    relativeDirection: 'later'
  })
  assert.deepEqual(later[0].options.map((option) => option.startTime), [secondOccurrence])
})

test('una oferta activa bloquea listas y slots nuevos; request_other_options exige reconsulta y el rechazo sobrevive otra ejecución', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_availability_guard_${suffix}`
  const agentId = `agent_availability_guard_${suffix}`
  const contactId = `contact_availability_guard_${suffix}`
  const timezone = await getAccountTimezone()
  const targetDay = DateTime.now().setZone(timezone).plus({ days: 21 }).startOf('day')
  const localDate = targetDay.toISODate()
  const rejectedStartTime = localSlot(localDate, '09:00', timezone)
  const canonical = buildCanonicalAppointmentSlotOption(rejectedStartTime, timezone)
  const previewScopeId = `appointment_preview_${createHash('sha256').update(suffix).digest('hex').slice(0, 48)}`
  const offerEventId = buildConversationalAppointmentPreviewOfferEventId(previewScopeId)
  const config = {
    id: agentId,
    runtimeMode: 'tool_calling_v2',
    capabilitiesConfig: {
      schemaVersion: 1,
      items: [{
        id: 'schedule_appointment',
        enabled: true,
        calendarId,
        bookingOwner: 'ai',
        allowOverlaps: false
      }]
    }
  }

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda de candados adversariales',
      source: 'ristak',
      slotDuration: 60,
      slotDurationUnit: 'mins',
      slotInterval: 60,
      slotIntervalUnit: 'mins',
      appoinmentPerSlot: 1,
      openHours: [{
        daysOfTheWeek: [targetDay.weekday],
        hours: [{ openHour: 9, openMinute: 0, closeHour: 12, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })

    await db.run(
      `INSERT INTO conversational_agent_events
        (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, ?, ?)`,
      [offerEventId, contactId, agentId, CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT, JSON.stringify({
        agentId,
        contactId,
        channel: 'whatsapp',
        calendarId,
        startTime: rejectedStartTime,
        localLabel: canonical.localLabel,
        timezone,
        executionId: `preview-offer-${suffix}`,
        offerText: `Tengo disponible ${canonical.localLabel}. ¿Te funciona ese horario?`,
        purpose: 'book',
        appointmentId: null,
        status: 'active',
        phase: 'awaiting_decision',
        offeredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        previewScopeId
      })]
    )

    const decisionCtx = {
      runtimeMode: 'tool_calling_v2',
      contactId,
      agentId,
      channel: 'whatsapp',
      dryRun: true,
      previewScopeId,
      executionId: `preview-reject-${suffix}`,
      followUpMode: false,
      actions: [],
      accountLocale: { currency: 'MXN' },
      config,
      nativeAppointmentAvailability: { calendarId, slots: [{ options: [{ startTime: rejectedStartTime }] }] }
    }
    decisionCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: decisionCtx,
      config
    })
    assert.equal(decisionCtx.appointmentOfferDecision?.active, true)

    const decisionTools = createConversationalTools(decisionCtx)
    const blockedList = await decisionTools
      .find((item) => item.name === 'offer_appointment_options')
      .invoke(null, JSON.stringify({ maxDays: 3 }))
    assert.equal(blockedList.code, 'appointment_offer_resolution_required')

    const blockedSlot = await decisionTools
      .find((item) => item.name === 'offer_appointment_slot')
      .invoke(null, JSON.stringify({ startTime: rejectedStartTime, appointmentId: null }))
    assert.equal(blockedSlot.code, 'appointment_offer_resolution_required')

    const changed = await decisionTools
      .find((item) => item.name === 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify({
        decision: 'request_other_options',
        reply: null,
        title: null,
        notes: null,
        attendeeName: null,
        attendeeContext: null,
        primaryAttendee: null,
        guests: [],
        agreedAmount: null
      }))
    assert.equal(changed.ok, true, JSON.stringify(changed))
    assert.equal(changed.terminal, false)
    assert.equal(decisionCtx.appointmentOfferDecision, null)
    assert.equal(decisionCtx.nativeAppointmentAvailability, undefined)
    assert.equal(decisionCtx.requireFreshAppointmentAvailability, true)

    const withoutFreshQuery = await decisionTools
      .find((item) => item.name === 'offer_appointment_slot')
      .invoke(null, JSON.stringify({
        startTime: localSlot(localDate, '10:00', timezone),
        appointmentId: null
      }))
    assert.equal(withoutFreshQuery.code, 'appointment_fresh_availability_required')

    const storedRejected = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )).detail_json)
    assert.equal(storedRejected.status, 'superseded')
    assert.equal(storedRejected.resolution, 'request_other_options')
    assert.ok(storedRejected.rejectedStartTimes.some((value) => epochMinute(value) === epochMinute(rejectedStartTime)))

    const freshCtx = {
      runtimeMode: 'tool_calling_v2',
      contactId,
      agentId,
      channel: 'whatsapp',
      dryRun: true,
      previewScopeId,
      executionId: `preview-fresh-${suffix}`,
      followUpMode: false,
      actions: [],
      accountLocale: { currency: 'MXN' },
      config
    }
    const availability = await toolNamed(freshCtx, 'get_free_slots').invoke(null, JSON.stringify({
      startDate: localDate,
      endDate: localDate,
      appointmentId: null,
      weekdays: null,
      earliestLocalTime: null,
      latestLocalTime: null,
      relativeToPreviousOffer: null
    }))
    assert.equal(availability.ok, true, JSON.stringify(availability))
    const freshOptions = availability.slots.flatMap((day) => day.options)
    assert.ok(freshOptions.length >= 2)
    assert.equal(freshOptions.some((option) => epochMinute(option.startTime) === epochMinute(rejectedStartTime)), false)

    const equivalentRejectedTime = DateTime.fromISO(rejectedStartTime, { setZone: true })
      .setZone(timezone)
      .toISO()
    const rejectedAgain = await toolNamed(freshCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: equivalentRejectedTime,
      appointmentId: null
    }))
    assert.equal(rejectedAgain.code, 'appointment_slot_previously_rejected')

    const validStartTime = freshOptions[0].startTime
    const inventedMinute = new Date(Date.parse(validStartTime) + 60000).toISOString()
    const outsideCurrentAvailability = await toolNamed(freshCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: inventedMinute,
      appointmentId: null
    }))
    assert.equal(outsideCurrentAvailability.code, 'appointment_slot_not_in_current_availability')

    const wrongAppointment = await toolNamed(freshCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: validStartTime,
      appointmentId: `appointment-wrong-${suffix}`
    }))
    assert.equal(wrongAppointment.code, 'appointment_slot_not_in_current_availability')

    const validOffer = await toolNamed(freshCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: validStartTime,
      appointmentId: null
    }))
    assert.equal(validOffer.ok, true, JSON.stringify(validOffer))
    assert.equal(validOffer.terminal, true)

    const storedReplacement = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )).detail_json)
    assert.equal(storedReplacement.status, 'active')
    assert.ok(storedReplacement.rejectedStartTimes.some((value) => epochMinute(value) === epochMinute(rejectedStartTime)))

    const liveRejectedEventId = `cae_live_rejected_${createHash('sha256').update(suffix).digest('hex').slice(0, 40)}`
    await db.run(
      `INSERT INTO conversational_agent_events
        (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, 'appointment_slot_offer_created', ?)`,
      [liveRejectedEventId, contactId, agentId, JSON.stringify({
        agentId,
        contactId,
        channel: 'whatsapp',
        calendarId,
        startTime: rejectedStartTime,
        localLabel: canonical.localLabel,
        timezone,
        executionId: `live-rejected-${suffix}`,
        purpose: 'book',
        status: 'superseded',
        phase: 'resolved',
        resolvedAt: new Date().toISOString(),
        resolution: 'request_other_options',
        rejectedStartTimes: [equivalentRejectedTime]
      })]
    )
    const liveCtx = {
      runtimeMode: 'tool_calling_v2',
      contactId,
      agentId,
      channel: 'whatsapp',
      dryRun: false,
      executionId: `live-fresh-${suffix}`,
      followUpMode: false,
      actions: [],
      accountLocale: { currency: 'MXN' },
      config
    }
    const liveAvailability = await toolNamed(liveCtx, 'get_free_slots').invoke(null, JSON.stringify({
      startDate: localDate,
      endDate: localDate,
      appointmentId: null,
      weekdays: null,
      earliestLocalTime: null,
      latestLocalTime: null,
      relativeToPreviousOffer: null
    }))
    assert.equal(liveAvailability.ok, true, JSON.stringify(liveAvailability))
    assert.equal(
      liveAvailability.slots.flatMap((day) => day.options)
        .some((option) => epochMinute(option.startTime) === epochMinute(rejectedStartTime)),
      false
    )
    const liveRejectedAgain = await toolNamed(liveCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: equivalentRejectedTime,
      appointmentId: null
    }))
    assert.equal(liveRejectedAgain.code, 'appointment_slot_previously_rejected')
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})
