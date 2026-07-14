import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

import { db, setAppConfig } from '../src/config/database.js'
import {
  createConversationalTools,
  loadConversationalAppointmentOfferDecisionContext,
  loadConversationalAppointmentSelectionProgressContext,
  setNativeAppointmentBeforeResolverTerminalHookForTest,
  setNativeAppointmentRuntimeAgentLookupHookForTest,
  supersedeUndeliveredConversationalAppointmentOffer
} from '../src/agents/conversational/tools.js'
import { upsertLocalCalendar } from '../src/services/localCalendarService.js'
import { getAccountTimezone, invalidateTimezoneCache } from '../src/utils/dateUtils.js'

function liveContext({ fixture, executionId, messages = [] }) {
  return {
    runtimeMode: 'tool_calling_v2',
    contactId: fixture.contactId,
    agentId: fixture.agentId,
    channel: 'whatsapp',
    dryRun: false,
    followUpMode: false,
    executionId,
    actions: [],
    accountLocale: { currency: 'MXN' },
    conversationMessages: messages,
    config: fixture.config
  }
}

function toolNamed(ctx, name) {
  const found = createConversationalTools(ctx).find((item) => item.name === name)
  assert.ok(found, `Falta la herramienta ${name}`)
  return found
}

function freeSlotsInput(localDate, overrides = {}) {
  return {
    startDate: localDate,
    endDate: localDate,
    appointmentId: null,
    weekdays: null,
    earliestLocalTime: null,
    latestLocalTime: null,
    relativeToPreviousOffer: null,
    progressDateAction: 'keep_selected_date',
    ...overrides
  }
}

function acceptOfferInput() {
  return {
    decision: 'accept',
    nextPreferenceScope: null,
    reply: null,
    title: null,
    notes: null,
    attendeeName: null,
    attendeeContext: null,
    primaryAttendee: null,
    guests: [],
    agreedAmount: null
  }
}

async function createFixture(label) {
  const suffix = `${label}_${randomUUID()}`
  const timezone = await getAccountTimezone()
  const localDay = DateTime.now().setZone(timezone).plus({ days: 21 }).startOf('day')
  const calendarId = `calendar_progressive_live_${suffix}`
  const contactId = `contact_progressive_live_${suffix}`
  const agentId = `agent_progressive_live_${suffix}`
  const config = {
    id: agentId,
    runtimeMode: 'tool_calling_v2',
    objective: 'custom',
    capabilitiesConfig: {
      schemaVersion: 3,
      items: [{
        id: 'schedule_appointment',
        enabled: true,
        calendarId,
        bookingOwner: 'ai',
        allowOverlaps: false
      }]
    }
  }

  await db.run(
    `INSERT INTO contacts (id, full_name, created_at, updated_at)
     VALUES (?, 'Contacto agenda progresiva live', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId]
  )
  await db.run(
    `INSERT INTO conversational_agents (id, name, enabled, runtime_mode, capabilities_config)
     VALUES (?, 'Agente agenda progresiva live', 1, 'tool_calling_v2', ?)`,
    [agentId, JSON.stringify(config.capabilitiesConfig)]
  )
  await upsertLocalCalendar({
    id: calendarId,
    name: 'Agenda progresiva live',
    source: 'ristak',
    allowBookingFor: 365,
    allowBookingForUnit: 'days',
    slotDuration: 60,
    slotDurationUnit: 'mins',
    slotInterval: 60,
    slotIntervalUnit: 'mins',
    appoinmentPerSlot: 1,
    allowReschedule: true,
    allowCancellation: true,
    openHours: [{
      daysOfTheWeek: [localDay.weekday],
      hours: [{ openHour: 11, openMinute: 0, closeHour: 17, closeMinute: 0 }]
    }]
  }, { source: 'ristak', syncStatus: 'synced' })

  return {
    suffix,
    timezone,
    localDate: localDay.toISODate(),
    calendarId,
    contactId,
    agentId,
    config,
    clientRequestIds: new Set()
  }
}

function collectClientRequestIds(fixture, ctx) {
  for (const action of Array.isArray(ctx?.actions) ? ctx.actions : []) {
    const clientRequestId = String(action?.clientRequestId || '').trim()
    if (clientRequestId) fixture.clientRequestIds.add(clientRequestId)
  }
}

async function cleanupFixture(fixture, extraContactIds = []) {
  for (const clientRequestId of fixture.clientRequestIds) {
    await db.run(
      'DELETE FROM appointment_creation_requests WHERE client_request_id = ?',
      [clientRequestId]
    ).catch(() => {})
  }
  await db.run(
    `DELETE FROM appointment_creation_requests
     WHERE appointment_id IN (SELECT id FROM appointments WHERE calendar_id = ?)`,
    [fixture.calendarId]
  ).catch(() => {})
  await db.run(
    `DELETE FROM appointment_participants
     WHERE appointment_id IN (SELECT id FROM appointments WHERE calendar_id = ?)`,
    [fixture.calendarId]
  ).catch(() => {})
  await db.run(
    'DELETE FROM conversational_agent_events WHERE contact_id = ? OR agent_id = ?',
    [fixture.contactId, fixture.agentId]
  ).catch(() => {})
  await db.run(
    'DELETE FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
    [fixture.contactId, fixture.agentId]
  ).catch(() => {})
  await db.run('DELETE FROM conversational_agents WHERE id = ?', [fixture.agentId]).catch(() => {})
  await db.run('DELETE FROM appointments WHERE calendar_id = ?', [fixture.calendarId]).catch(() => {})
  await db.run(
    `DELETE FROM contacts WHERE id IN (${[fixture.contactId, ...extraContactIds].map(() => '?').join(', ')})`,
    [fixture.contactId, ...extraContactIds]
  ).catch(() => {})
  await db.run('DELETE FROM calendars WHERE id = ?', [fixture.calendarId]).catch(() => {})
}

async function selectDate(fixture, executionId = `select-date-${fixture.suffix}`) {
  const ctx = liveContext({ fixture, executionId })
  ctx.appointmentOfferDecision = null
  ctx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
    ctx,
    config: fixture.config
  })
  const availability = await toolNamed(ctx, 'get_free_slots').invoke(
    null,
    JSON.stringify(freeSlotsInput(fixture.localDate))
  )
  assert.equal(availability.ok, true, JSON.stringify(availability))
  assert.ok(availability.total > 1, JSON.stringify(availability))
  const selected = await toolNamed(ctx, 'offer_appointment_options').invoke(null, JSON.stringify({
    maxDays: 1,
    selectionMode: 'collecting_time',
    selectedLocalDate: fixture.localDate
  }))
  assert.equal(selected.ok, true, JSON.stringify(selected))
  assert.equal(selected.selectedDate, fixture.localDate)
  assert.equal(selected.missingField, 'time')
  assert.match(selected.visibleReply, /¿A qué hora te acomodaría\?/)
  assert.doesNotMatch(selected.visibleReply, /¿Qué día y horario te acomoda mejor\?/)
  return { ctx, availability, selected }
}

async function offerExactTime(fixture, localTime, executionId = `offer-time-${fixture.suffix}`) {
  const ctx = liveContext({ fixture, executionId })
  ctx.appointmentOfferDecision = null
  ctx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
    ctx,
    config: fixture.config
  })
  assert.equal(ctx.appointmentSelectionProgress?.selectedDate, fixture.localDate)
  const availability = await toolNamed(ctx, 'get_free_slots').invoke(null, JSON.stringify(
    freeSlotsInput(fixture.localDate, {
      earliestLocalTime: localTime,
      latestLocalTime: localTime
    })
  ))
  assert.equal(availability.ok, true, JSON.stringify(availability))
  assert.equal(availability.total, 1, JSON.stringify(availability))
  const startTime = availability.slots[0].options[0].startTime
  const offered = await toolNamed(ctx, 'offer_appointment_slot').invoke(null, JSON.stringify({
    startTime,
    appointmentId: null
  }))
  assert.equal(offered.ok, true, JSON.stringify(offered))
  assert.equal(offered.actionCompleted, true)
  assert.equal(offered.simulated, undefined)
  assert.match(offered.visibleReply, /¿Te funciona ese horario\?/)
  return { ctx, availability, offered, startTime }
}

async function insertOriginMainLiveOffer({ fixture, option, executionId }) {
  const progressRow = await db.get(
    `SELECT detail_json FROM conversational_agent_events
     WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_selection_progress'`,
    [fixture.contactId, fixture.agentId]
  )
  const progressUpdatedAtMs = Date.parse(JSON.parse(progressRow?.detail_json || '{}').updatedAt || '')
  assert.ok(Number.isFinite(progressUpdatedAtMs), 'La fecha parcial debe conservar updatedAt')
  const offeredAtMs = Math.max(Date.now(), progressUpdatedAtMs + 1)
  const localLabel = String(option?.localLabel || '').trim()
  const separator = /[.!?]$/u.test(localLabel) ? ' ' : '. '
  const offerText = `Tengo disponible ${localLabel}${separator}¿Te funciona ese horario?`
  const detail = {
    agentId: fixture.agentId,
    contactId: fixture.contactId,
    channel: 'whatsapp',
    calendarId: fixture.calendarId,
    startTime: option.startTime,
    localLabel,
    timezone: fixture.timezone,
    executionId,
    offerText,
    purpose: 'book',
    appointmentId: null,
    expectedStartTime: null,
    expectedEndTime: null,
    durationMs: null,
    status: 'active',
    phase: 'awaiting_decision',
    offeredAt: new Date(offeredAtMs).toISOString(),
    expiresAt: new Date(offeredAtMs + 15 * 60 * 1000).toISOString()
  }
  const eventId = `cae_appointment_offer_${createHash('sha256').update([
    fixture.agentId,
    fixture.contactId,
    'whatsapp',
    fixture.calendarId,
    option.startTime,
    executionId,
    'book',
    '',
    '',
    '',
    0
  ].join('\u0000')).digest('hex').slice(0, 48)}`
  await db.run(
    `INSERT INTO conversational_agent_events
      (id, contact_id, agent_id, event_type, detail_json)
     VALUES (?, ?, ?, 'appointment_slot_offer_created', ?)`,
    [eventId, fixture.contactId, fixture.agentId, JSON.stringify(detail)]
  )
  return { eventId, detail }
}

async function confirmationContext(fixture, offered, executionId) {
  const offerRows = await db.all(
    `SELECT detail_json FROM conversational_agent_events
     WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
    [fixture.contactId, fixture.agentId]
  )
  const activeOffer = (offerRows || [])
    .map((row) => JSON.parse(row.detail_json))
    .find((detail) => detail.status === 'active')
  assert.ok(activeOffer?.executionId, 'La oferta activa debe conservar el inbound que la originó')
  const ctx = liveContext({
    fixture,
    executionId,
    messages: [
      { id: activeOffer.executionId, role: 'user', content: 'esa hora me interesa' },
      { id: `assistant-${executionId}`, role: 'assistant', content: offered.visibleReply },
      { id: executionId, role: 'user', content: 'sí, confirmamos' }
    ]
  })
  ctx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
    ctx,
    config: fixture.config
  })
  ctx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
    ctx,
    config: fixture.config
  })
  assert.equal(ctx.appointmentOfferDecision?.active, true)
  assert.equal(ctx.appointmentSelectionProgress, null)
  return ctx
}

test('live: fecha, hora, oferta y “sí” crean una sola cita real por el resolver; el replay no duplica', async () => {
  const fixture = await createFixture('book_once')
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '16:00')
    for (let index = 0; index < 25; index += 1) {
      await db.run(
        `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
         VALUES (?, ?, ?, 'appointment_slot_offer_created', ?)`,
        [
          `other_channel_offer_${index}_${fixture.suffix}`,
          fixture.contactId,
          fixture.agentId,
          JSON.stringify({
            agentId: fixture.agentId,
            contactId: fixture.contactId,
            channel: 'instagram',
            calendarId: fixture.calendarId,
            startTime: exact.startTime,
            localLabel: 'Horario de otro canal',
            timezone: fixture.timezone,
            executionId: `other-channel-${index}-${fixture.suffix}`,
            purpose: 'book',
            status: 'active',
            phase: 'awaiting_decision',
            offeredAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
          })
        ]
      )
    }
    const progressRow = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_selection_progress'`,
      [fixture.contactId, fixture.agentId]
    )
    assert.equal(JSON.parse(progressRow.detail_json).previewScopeId, null)

    const confirmation = await confirmationContext(
      fixture,
      exact.offered,
      `confirm-${fixture.suffix}`
    )
    assert.equal(confirmation.appointmentOfferDecision?.startTime, exact.startTime)
    const names = createConversationalTools(confirmation).map((item) => item.name)
    assert.ok(names.includes('resolve_active_appointment_offer'))
    assert.equal(names.includes('book_appointment'), false)
    const resolver = toolNamed(confirmation, 'resolve_active_appointment_offer')
    const confirmed = await resolver.invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, confirmation)

    assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
    assert.equal(confirmed.actionCompleted, true)
    assert.equal(confirmed.simulated, undefined)
    assert.match(confirmed.visibleReply, /cita quedó confirmada/i)
    const rows = await db.all(
      `SELECT id, start_time, appointment_status, status
       FROM appointments WHERE calendar_id = ? AND contact_id = ?`,
      [fixture.calendarId, fixture.contactId]
    )
    assert.equal(rows.length, 1)
    assert.equal(new Date(rows[0].start_time).toISOString(), exact.startTime)
    assert.match(String(rows[0].appointment_status || rows[0].status), /confirm/i)

    const duplicateResolverCall = await resolver.invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, confirmation)
    assert.equal(duplicateResolverCall.ok, false, JSON.stringify(duplicateResolverCall))
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )).total), 1)

    const replayCtx = liveContext({
      fixture,
      executionId: `confirm-replay-${fixture.suffix}`,
      messages: [
        { id: `assistant-replay-${fixture.suffix}`, role: 'assistant', content: exact.offered.visibleReply },
        { id: `confirm-replay-${fixture.suffix}`, role: 'user', content: 'sí' }
      ]
    })
    replayCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: replayCtx,
      config: fixture.config
    })
    assert.equal(replayCtx.appointmentOfferDecision, null)
    assert.equal(
      createConversationalTools(replayCtx).some((item) => item.name === 'resolve_active_appointment_offer'),
      false
    )
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )).total), 1)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('live rolling: una oferta creada por origin/main acepta “sí”, agenda una vez y el replay no duplica', async () => {
  const fixture = await createFixture('legacy_offer_accept')
  try {
    await selectDate(fixture)
    const offerExecutionId = `legacy-offer-${fixture.suffix}`
    const availabilityCtx = liveContext({ fixture, executionId: offerExecutionId })
    availabilityCtx.appointmentOfferDecision = null
    availabilityCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: availabilityCtx,
      config: fixture.config
    })
    const availability = await toolNamed(availabilityCtx, 'get_free_slots').invoke(
      null,
      JSON.stringify(freeSlotsInput(fixture.localDate, {
        earliestLocalTime: '16:00',
        latestLocalTime: '16:00'
      }))
    )
    assert.equal(availability.ok, true, JSON.stringify(availability))
    assert.equal(availability.total, 1, JSON.stringify(availability))
    const option = availability.slots[0].options[0]
    const legacy = await insertOriginMainLiveOffer({
      fixture,
      option,
      executionId: offerExecutionId
    })

    const confirmationExecutionId = `legacy-confirm-${fixture.suffix}`
    const confirmation = liveContext({
      fixture,
      executionId: confirmationExecutionId,
      messages: [
        { id: offerExecutionId, role: 'user', content: 'a las cuatro' },
        { id: `assistant-${offerExecutionId}`, role: 'assistant', content: legacy.detail.offerText },
        { id: confirmationExecutionId, role: 'user', content: 'sí, confirmamos' }
      ]
    })
    confirmation.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: confirmation,
      config: fixture.config
    })
    confirmation.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: confirmation,
      config: fixture.config
    })
    assert.equal(confirmation.appointmentOfferDecision?.active, true)
    assert.equal(confirmation.appointmentOfferDecision?.startTime, option.startTime)
    assert.equal(confirmation.appointmentSelectionProgress, null)

    const migratedOffer = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [legacy.eventId]
    )).detail_json)
    assert.equal(migratedOffer.bookingOwner, 'ai')
    assert.equal(migratedOffer.terminalToolName, 'book_appointment')
    assert.ok(migratedOffer.legacyTerminalBindingMigratedAt)
    const reconciledProgress = JSON.parse((await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_selection_progress'`,
      [fixture.contactId, fixture.agentId]
    )).detail_json)
    assert.equal(reconciledProgress.appointmentStatus, 'superseded')
    assert.equal(reconciledProgress.supersededByOfferEventId, legacy.eventId)

    const resolver = toolNamed(confirmation, 'resolve_active_appointment_offer')
    const confirmed = await resolver.invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, confirmation)
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
    assert.equal(confirmed.actionCompleted, true)
    assert.match(confirmed.visibleReply, /cita quedó confirmada/i)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )).total), 1)

    const duplicateResolverCall = await resolver.invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, confirmation)
    assert.equal(duplicateResolverCall.ok, false, JSON.stringify(duplicateResolverCall))
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )).total), 1)

    const replayCtx = liveContext({
      fixture,
      executionId: `legacy-replay-${fixture.suffix}`,
      messages: [
        { id: `assistant-replay-${fixture.suffix}`, role: 'assistant', content: legacy.detail.offerText },
        { id: `legacy-replay-${fixture.suffix}`, role: 'user', content: 'sí' }
      ]
    })
    replayCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: replayCtx,
      config: fixture.config
    })
    assert.equal(replayCtx.appointmentOfferDecision, null)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )).total), 1)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('live: si otro contacto ocupa el slot después de ofrecerlo, accept no crea ni confirma otra cita', async () => {
  const fixture = await createFixture('occupied_after_offer')
  const competitorId = `contact_competitor_${fixture.suffix}`
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '15:00')
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto competidor', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [competitorId]
    )
    const start = DateTime.fromISO(exact.startTime, { setZone: true })
    await db.run(
      `INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status,
        start_time, end_time, source, sync_status, date_added, date_updated
      ) VALUES (?, ?, ?, 'Cita competidora', 'confirmed', 'confirmed', ?, ?, 'ristak', 'synced', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        `appointment_competitor_${fixture.suffix}`,
        fixture.calendarId,
        competitorId,
        start.toUTC().toISO(),
        start.plus({ hours: 1 }).toUTC().toISO()
      ]
    )

    const confirmation = await confirmationContext(
      fixture,
      exact.offered,
      `confirm-occupied-${fixture.suffix}`
    )
    const resolver = toolNamed(confirmation, 'resolve_active_appointment_offer')
    const blocked = await resolver.invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, confirmation)

    assert.equal(blocked.ok, false, JSON.stringify(blocked))
    assert.equal(blocked.actionCompleted, false)
    assert.doesNotMatch(String(blocked.visibleReply || ''), /cita quedó confirmada/i)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )).total), 0)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, competitorId]
    )).total), 1)

    const offerRow = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
      [fixture.contactId, fixture.agentId]
    )
    const offerDetail = JSON.parse(offerRow.detail_json)
    assert.equal(offerDetail.status, 'superseded', 'el slot inválido no debe revivir como oferta activa')
    assert.equal(offerDetail.resolution, 'slot_unavailable')

    const retryCtx = liveContext({
      fixture,
      executionId: `confirm-occupied-retry-${fixture.suffix}`,
      messages: [
        { id: `assistant-occupied-retry-${fixture.suffix}`, role: 'assistant', content: exact.offered.visibleReply },
        { id: `confirm-occupied-retry-${fixture.suffix}`, role: 'user', content: 'sí' }
      ]
    })
    retryCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: retryCtx,
      config: fixture.config
    })
    retryCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: retryCtx,
      config: fixture.config
    })
    assert.equal(retryCtx.appointmentOfferDecision, null)
    assert.equal(retryCtx.appointmentSelectionProgress?.selectedDate, fixture.localDate)
    assert.equal(
      createConversationalTools(retryCtx).some((item) => item.name === 'resolve_active_appointment_offer'),
      false,
      'otro “sí” no debe volver a intentar el mismo slot ocupado'
    )
  } finally {
    await cleanupFixture(fixture, [competitorId])
  }
})

test('live: decline cierra el estado parcial sin crear ni cancelar una cita', async () => {
  const fixture = await createFixture('decline_partial')
  try {
    await selectDate(fixture)
    const declineCtx = liveContext({
      fixture,
      executionId: `decline-${fixture.suffix}`,
      messages: [{ id: `decline-${fixture.suffix}`, role: 'user', content: 'mejor ya no quiero cita' }]
    })
    declineCtx.appointmentOfferDecision = null
    declineCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: declineCtx,
      config: fixture.config
    })
    assert.equal(declineCtx.appointmentSelectionProgress?.selectedDate, fixture.localDate)

    const declined = await toolNamed(declineCtx, 'resolve_active_appointment_selection')
      .invoke(null, JSON.stringify({ decision: 'decline' }))
    assert.equal(declined.ok, true, JSON.stringify(declined))
    assert.equal(declined.actionCompleted, true)
    assert.equal(declined.simulated, undefined)
    assert.match(declined.visibleReply, /dejamos la búsqueda de cita aquí/i)

    const freshCtx = liveContext({ fixture, executionId: `after-decline-${fixture.suffix}` })
    freshCtx.appointmentOfferDecision = null
    assert.equal(await loadConversationalAppointmentSelectionProgressContext({
      ctx: freshCtx,
      config: fixture.config
    }), null)
    const row = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_selection_progress'`,
      [fixture.contactId, fixture.agentId]
    )
    assert.equal(JSON.parse(row.detail_json).appointmentStatus, 'cancelled')
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )).total), 0)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('live: una hora inexistente conserva la fecha y permite mostrar alternativas del mismo día', async () => {
  const fixture = await createFixture('unavailable_then_alternatives')
  try {
    await selectDate(fixture)
    const ctx = liveContext({ fixture, executionId: `unavailable-${fixture.suffix}` })
    ctx.appointmentOfferDecision = null
    ctx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx,
      config: fixture.config
    })
    assert.equal(ctx.appointmentSelectionProgress?.selectedDate, fixture.localDate)

    const unavailable = await toolNamed(ctx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.localDate, {
        earliestLocalTime: '17:00',
        latestLocalTime: '17:00'
      })
    ))
    assert.equal(unavailable.ok, true, JSON.stringify(unavailable))
    assert.equal(unavailable.total, 0)
    assert.equal(ctx.appointmentSelectionProgress?.selectedDate, fixture.localDate)

    const alternatives = await toolNamed(ctx, 'get_free_slots').invoke(
      null,
      JSON.stringify(freeSlotsInput(fixture.localDate))
    )
    assert.equal(alternatives.ok, true, JSON.stringify(alternatives))
    assert.ok(alternatives.total > 1, JSON.stringify(alternatives))
    assert.equal(
      alternatives.slots.flatMap((day) => day.options).some((option) => option.localTime === '17:00'),
      false
    )
    const shown = await toolNamed(ctx, 'offer_appointment_options').invoke(null, JSON.stringify({
      maxDays: 1,
      selectionMode: 'collecting_time',
      selectedLocalDate: fixture.localDate
    }))
    assert.equal(shown.ok, true, JSON.stringify(shown))
    assert.equal(shown.selectedDate, fixture.localDate)
    assert.equal(shown.missingField, 'time')
    assert.match(shown.visibleReply, /¿A qué hora te acomodaría\?/)
    assert.doesNotMatch(shown.visibleReply, /¿Qué día y horario te acomoda mejor\?/)

    const freshCtx = liveContext({ fixture, executionId: `after-alternatives-${fixture.suffix}` })
    freshCtx.appointmentOfferDecision = null
    freshCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: freshCtx,
      config: fixture.config
    })
    assert.equal(freshCtx.appointmentSelectionProgress?.selectedDate, fixture.localDate)
    assert.deepEqual(freshCtx.appointmentSelectionProgress?.missingFields, ['time'])
  } finally {
    await cleanupFixture(fixture)
  }
})

test('live: una oferta que no alcanzó a salir se cierra por ejecución, conserva el día y no rechaza el horario', async () => {
  const fixture = await createFixture('undelivered_offer')
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '14:00', `offer-undelivered-${fixture.suffix}`)
    const offerAction = exact.ctx.actions.find((action) => action.type === 'offer_appointment_slot')
    assert.ok(offerAction?.outcome?.offerEventId)

    const foreignExecutionCtx = liveContext({
      fixture,
      executionId: `another-execution-${fixture.suffix}`
    })
    foreignExecutionCtx.actions = exact.ctx.actions
    assert.equal(await supersedeUndeliveredConversationalAppointmentOffer({
      ctx: foreignExecutionCtx,
      config: fixture.config,
      reason: 'offer_reply_preempted_before_send'
    }), false, 'otra ejecución no puede cerrar una oferta ajena')

    assert.equal(await supersedeUndeliveredConversationalAppointmentOffer({
      ctx: exact.ctx,
      config: fixture.config,
      reason: 'offer_reply_preempted_before_send'
    }), true)
    const closed = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerAction.outcome.offerEventId]
    )).detail_json)
    assert.equal(closed.status, 'superseded')
    assert.equal(closed.resolution, 'offer_reply_preempted_before_send')
    assert.equal((closed.rejectedStartTimes || []).includes(exact.startTime), false)

    const retryCtx = liveContext({ fixture, executionId: `retry-undelivered-${fixture.suffix}` })
    retryCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: retryCtx,
      config: fixture.config
    })
    retryCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: retryCtx,
      config: fixture.config
    })
    assert.equal(retryCtx.appointmentOfferDecision, null)
    assert.equal(retryCtx.appointmentSelectionProgress?.selectedDate, fixture.localDate)

    const availability = await toolNamed(retryCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.localDate, { earliestLocalTime: '14:00', latestLocalTime: '14:00' })
    ))
    assert.equal(availability.total, 1, JSON.stringify(availability))
    const reoffered = await toolNamed(retryCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: availability.slots[0].options[0].startTime,
      appointmentId: null
    }))
    assert.equal(reoffered.ok, true, JSON.stringify(reoffered))
  } finally {
    await cleanupFixture(fixture)
  }
})

test('live: un replay tardío de la misma ejecución no vuelve a mostrar una oferta con TTL vencido', async () => {
  const fixture = await createFixture('expired_exact_replay')
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '14:00', `same-expired-execution-${fixture.suffix}`)
    const offerAction = exact.ctx.actions.find((action) => action.type === 'offer_appointment_slot')
    const row = await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerAction.outcome.offerEventId]
    )
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
      [
        JSON.stringify({
          ...JSON.parse(row.detail_json),
          expiresAt: new Date(Date.now() - 60_000).toISOString()
        }),
        offerAction.outcome.offerEventId,
        row.detail_json
      ]
    )

    const replay = await toolNamed(exact.ctx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: exact.startTime,
      appointmentId: null
    }))
    assert.equal(replay.ok, false, JSON.stringify(replay))
    assert.doesNotMatch(String(replay.visibleReply || ''), /¿Te funciona ese horario\?/i)
    const stored = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerAction.outcome.offerEventId]
    )).detail_json)
    assert.notEqual(stored.status, 'active')
  } finally {
    await cleanupFixture(fixture)
  }
})

test('live: un “sí” sin evidencia de que la oferta llegó cierra el estado invisible y vuelve a pedir sólo la hora', async () => {
  const fixture = await createFixture('invisible_offer_confirmation')
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '15:00')
    const executionId = `confirm-invisible-${fixture.suffix}`
    const confirmation = liveContext({
      fixture,
      executionId,
      messages: [{ id: executionId, role: 'user', content: 'sí' }]
    })
    confirmation.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: confirmation,
      config: fixture.config
    })
    assert.equal(confirmation.appointmentOfferDecision?.active, true)

    const result = await toolNamed(confirmation, 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify(acceptOfferInput()))
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, 'appointment_offer_visibility_unverified')
    assert.match(result.visibleReply, /conservé el día/i)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )).total), 0)

    const offerDetail = JSON.parse((await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
      [fixture.contactId, fixture.agentId]
    )).detail_json)
    assert.equal(offerDetail.status, 'superseded')
    assert.equal(offerDetail.resolution, 'offer_visibility_unverified')
    assert.equal((offerDetail.rejectedStartTimes || []).includes(exact.startTime), false)

    const nextCtx = liveContext({ fixture, executionId: `after-invisible-${fixture.suffix}` })
    nextCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: nextCtx,
      config: fixture.config
    })
    nextCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: nextCtx,
      config: fixture.config
    })
    assert.equal(nextCtx.appointmentOfferDecision, null)
    assert.equal(nextCtx.appointmentSelectionProgress?.selectedDate, fixture.localDate)
    assert.equal(createConversationalTools(nextCtx).some((tool) => tool.name === 'resolve_active_appointment_offer'), false)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('live: una oferta vieja idéntica no autoriza otra oferta que nunca se mostró', async () => {
  const fixture = await createFixture('stale_identical_visible_offer')
  try {
    await selectDate(fixture, `select-old-${fixture.suffix}`)
    const oldExact = await offerExactTime(fixture, '15:00', `offer-old-${fixture.suffix}`)
    const declineExecutionId = `decline-old-${fixture.suffix}`
    const declineCtx = liveContext({
      fixture,
      executionId: declineExecutionId,
      messages: [
        { id: oldExact.ctx.executionId, role: 'user', content: 'a las tres' },
        { id: `assistant-old-${fixture.suffix}`, role: 'assistant', content: oldExact.offered.visibleReply },
        { id: declineExecutionId, role: 'user', content: 'no' }
      ]
    })
    declineCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: declineCtx,
      config: fixture.config
    })
    const declined = await toolNamed(declineCtx, 'resolve_active_appointment_offer').invoke(
      null,
      JSON.stringify({ ...acceptOfferInput(), decision: 'decline' })
    )
    assert.equal(declined.ok, true, JSON.stringify(declined))

    await selectDate(fixture, `select-new-${fixture.suffix}`)
    const currentExact = await offerExactTime(fixture, '15:00', `offer-new-${fixture.suffix}`)
    assert.equal(currentExact.offered.visibleReply, oldExact.offered.visibleReply)
    const confirmationExecutionId = `confirm-new-invisible-${fixture.suffix}`
    const confirmation = liveContext({
      fixture,
      executionId: confirmationExecutionId,
      messages: [
        { id: oldExact.ctx.executionId, role: 'user', content: 'a las tres' },
        { id: `assistant-old-${fixture.suffix}`, role: 'assistant', content: oldExact.offered.visibleReply },
        { id: declineExecutionId, role: 'user', content: 'no' },
        { id: currentExact.ctx.executionId, role: 'user', content: 'mejor sí, a las tres' },
        { id: confirmationExecutionId, role: 'user', content: 'sí' }
      ]
    })
    confirmation.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: confirmation,
      config: fixture.config
    })
    const result = await toolNamed(confirmation, 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify(acceptOfferInput()))
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, 'appointment_offer_visibility_unverified')
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )).total), 0)
    const progress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: confirmation,
      config: fixture.config
    })
    assert.equal(progress?.selectedDate, fixture.localDate)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('live: si la oferta vence entre aceptar y ejecutar la terminal, no agenda y recupera el día de inmediato', async () => {
  const fixture = await createFixture('expiry_during_resolver')
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '15:00')
    const confirmation = await confirmationContext(
      fixture,
      exact.offered,
      `confirm-expiry-during-resolver-${fixture.suffix}`
    )
    setNativeAppointmentBeforeResolverTerminalHookForTest(async ({ offerEventId }) => {
      const row = await db.get(
        'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
        [offerEventId]
      )
      await db.run(
        'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
        [
          JSON.stringify({
            ...JSON.parse(row.detail_json),
            expiresAt: new Date(Date.now() - 60_000).toISOString()
          }),
          offerEventId,
          row.detail_json
        ]
      )
    })

    const result = await toolNamed(confirmation, 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify(acceptOfferInput()))
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, 'appointment_offer_expired')
    assert.match(result.visibleReply, /conservé el día/i)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )).total), 0)
    const progress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: confirmation,
      config: fixture.config
    })
    assert.equal(progress?.selectedDate, fixture.localDate)
  } finally {
    setNativeAppointmentBeforeResolverTerminalHookForTest(null)
    await cleanupFixture(fixture)
  }
})

test('live: si la oferta vence antes de entrar al resolver, conserva el día y no vuelve a pedir la fecha', async () => {
  const fixture = await createFixture('expiry_before_resolver')
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '14:00')
    const confirmation = await confirmationContext(
      fixture,
      exact.offered,
      `confirm-expiry-before-resolver-${fixture.suffix}`
    )
    const row = await db.get(
      'SELECT id, detail_json FROM conversational_agent_events WHERE id = ?',
      [confirmation.appointmentOfferDecision.offerEventId]
    )
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
      [
        JSON.stringify({
          ...JSON.parse(row.detail_json),
          expiresAt: new Date(Date.now() - 60_000).toISOString()
        }),
        row.id,
        row.detail_json
      ]
    )

    const result = await toolNamed(confirmation, 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify(acceptOfferInput()))
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, 'appointment_offer_expired')
    assert.match(result.visibleReply, /conservé el día/i)
    assert.match(result.visibleReply, /dime la hora/i)
    assert.doesNotMatch(result.visibleReply, /qué fecha|qué día/i)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )).total), 0)
    const progress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: confirmation,
      config: fixture.config
    })
    assert.equal(progress?.selectedDate, fixture.localDate)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('live: una oferta individual expirada deja de ser autoridad, recupera la fecha y conserva la referencia más reciente', async () => {
  const fixture = await createFixture('expired_offer_progress')
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '15:00')
    const row = await db.get(
      `SELECT id, detail_json, created_at FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
      [fixture.contactId, fixture.agentId]
    )
    const currentDetail = JSON.parse(row.detail_json)
    const olderLocalDate = DateTime.fromISO(fixture.localDate, { zone: fixture.timezone })
      .plus({ days: 7 })
      .toISODate()
    const olderStartTime = DateTime.fromISO(`${olderLocalDate}T16:00:00`, { zone: fixture.timezone })
      .toUTC()
      .toISO()
    const olderOfferId = `zz_older_expired_offer_${fixture.suffix}`
    await db.run(
      `INSERT INTO conversational_agent_events
        (id, contact_id, agent_id, event_type, detail_json, created_at)
       VALUES (?, ?, ?, 'appointment_slot_offer_created', ?, ?)`,
      [
        olderOfferId,
        fixture.contactId,
        fixture.agentId,
        JSON.stringify({
          ...currentDetail,
          startTime: olderStartTime,
          executionId: `older-expired-${fixture.suffix}`,
          offeredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          expiresAt: new Date(Date.now() - 30 * 60 * 1000).toISOString()
        }),
        row.created_at
      ]
    )
    const expired = {
      ...currentDetail,
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    }
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
      [JSON.stringify(expired), row.id, row.detail_json]
    )

    const nextCtx = liveContext({ fixture, executionId: `after-expiry-${fixture.suffix}` })
    nextCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: nextCtx,
      config: fixture.config
    })
    nextCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: nextCtx,
      config: fixture.config
    })
    assert.equal(nextCtx.appointmentOfferDecision, null)
    assert.equal(nextCtx.appointmentSelectionProgress?.selectedDate, fixture.localDate)
    const stored = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [row.id]
    )).detail_json)
    assert.equal(stored.status, 'superseded')
    assert.equal(stored.resolution, 'appointment_offer_expired')
    assert.equal((stored.rejectedStartTimes || []).includes(exact.startTime), false)
    const olderStored = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [olderOfferId]
    )).detail_json)
    assert.equal(olderStored.status, 'superseded')
    assert.equal(olderStored.resolution, 'appointment_offer_expired')
    assert.notEqual(nextCtx.appointmentSelectionProgress?.selectedDate, olderLocalDate)

    const relativeCtx = liveContext({ fixture, executionId: `after-expiry-relative-${fixture.suffix}` })
    relativeCtx.appointmentOfferDecision = null
    relativeCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: relativeCtx,
      config: fixture.config
    })
    const later = await toolNamed(relativeCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.localDate, { relativeToPreviousOffer: 'later' })
    ))
    assert.equal(later.ok, true, JSON.stringify(later))
    assert.deepEqual(
      later.slots.flatMap((item) => item.options.map((option) => option.localTime)),
      ['16:00'],
      'la oferta expirada más reciente sigue siendo la referencia; no revive la lista ni otra oferta vieja'
    )
  } finally {
    await cleanupFixture(fixture)
  }
})

test('live: si una reagenda deja de estar permitida antes del “sí”, la oferta se cierra y no revive', async () => {
  const fixture = await createFixture('reschedule_permission_after_offer')
  const appointmentId = `appointment_original_${fixture.suffix}`
  try {
    const originalStart = DateTime.fromISO(`${fixture.localDate}T12:00:00`, { zone: fixture.timezone })
    await db.run(
      `INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status,
        start_time, end_time, source, sync_status, date_added, date_updated
      ) VALUES (?, ?, ?, 'Cita original', 'confirmed', 'confirmed', ?, ?, 'ristak', 'synced', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        appointmentId,
        fixture.calendarId,
        fixture.contactId,
        originalStart.toUTC().toISO(),
        originalStart.plus({ hours: 1 }).toUTC().toISO()
      ]
    )

    const dateCtx = liveContext({ fixture, executionId: `reschedule-date-${fixture.suffix}` })
    dateCtx.appointmentOfferDecision = null
    dateCtx.appointmentSelectionProgress = null
    const availability = await toolNamed(dateCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.localDate, { appointmentId })
    ))
    assert.ok(availability.total > 1, JSON.stringify(availability))
    assert.equal((await toolNamed(dateCtx, 'offer_appointment_options').invoke(null, JSON.stringify({
      maxDays: 1,
      selectionMode: 'collecting_time',
      selectedLocalDate: fixture.localDate
    }))).ok, true)

    const timeCtx = liveContext({ fixture, executionId: `reschedule-offer-${fixture.suffix}` })
    timeCtx.appointmentOfferDecision = null
    timeCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: timeCtx,
      config: fixture.config
    })
    const exact = await toolNamed(timeCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.localDate, {
        appointmentId: null,
        earliestLocalTime: '16:00',
        latestLocalTime: '16:00'
      })
    ))
    assert.equal(exact.total, 1, JSON.stringify(exact))
    const offered = await toolNamed(timeCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: exact.slots[0].options[0].startTime,
      appointmentId: null
    }))
    assert.equal(offered.ok, true, JSON.stringify(offered))

    const confirmation = await confirmationContext(
      fixture,
      offered,
      `reschedule-confirm-${fixture.suffix}`
    )
    assert.equal(confirmation.appointmentOfferDecision?.purpose, 'reschedule')
    await db.run('UPDATE calendars SET allow_reschedule = 0 WHERE id = ?', [fixture.calendarId])
    const blocked = await toolNamed(confirmation, 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify(acceptOfferInput()))
    assert.equal(blocked.ok, false, JSON.stringify(blocked))
    assert.equal(blocked.code, 'appointment_offer_scope_changed')
    assert.equal(blocked.terminal, true)

    const offerDetail = JSON.parse((await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
      [fixture.contactId, fixture.agentId]
    )).detail_json)
    assert.equal(offerDetail.status, 'superseded')
    assert.equal(offerDetail.resolution, 'appointment_scope_changed')
    const unchanged = await db.get('SELECT start_time FROM appointments WHERE id = ?', [appointmentId])
    assert.equal(new Date(unchanged.start_time).toISOString(), originalStart.toUTC().toISO())

    const retryCtx = liveContext({ fixture, executionId: `reschedule-retry-${fixture.suffix}` })
    retryCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: retryCtx,
      config: fixture.config
    })
    retryCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: retryCtx,
      config: fixture.config
    })
    assert.equal(retryCtx.appointmentOfferDecision, null)
    assert.equal(retryCtx.appointmentSelectionProgress, null)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('live: cambiar el calendario después de ofrecer invalida el horario y volver atrás no lo revive', async () => {
  const fixture = await createFixture('offer_calendar_drift')
  const replacementCalendarId = `calendar_replacement_${fixture.suffix}`
  try {
    await selectDate(fixture)
    await offerExactTime(fixture, '14:00')
    const localDay = DateTime.fromISO(fixture.localDate, { zone: fixture.timezone })
    await upsertLocalCalendar({
      id: replacementCalendarId,
      name: 'Agenda reemplazo',
      source: 'ristak',
      allowBookingFor: 365,
      allowBookingForUnit: 'days',
      slotDuration: 60,
      slotDurationUnit: 'mins',
      slotInterval: 60,
      slotIntervalUnit: 'mins',
      appoinmentPerSlot: 1,
      openHours: [{
        daysOfTheWeek: [localDay.weekday],
        hours: [{ openHour: 11, openMinute: 0, closeHour: 17, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })
    const changedConfig = structuredClone(fixture.config)
    changedConfig.capabilitiesConfig.items[0].calendarId = replacementCalendarId
    const changedFixture = { ...fixture, config: changedConfig }
    const changedCtx = liveContext({
      fixture: changedFixture,
      executionId: `calendar-drift-confirm-${fixture.suffix}`
    })
    changedCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: changedCtx,
      config: changedConfig
    })
    assert.equal(changedCtx.appointmentOfferDecision, null)

    const invalidated = JSON.parse((await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
      [fixture.contactId, fixture.agentId]
    )).detail_json)
    assert.equal(invalidated.status, 'superseded')
    assert.equal(invalidated.resolution, 'calendar_changed')

    const originalCtx = liveContext({
      fixture,
      executionId: `calendar-drift-original-${fixture.suffix}`
    })
    assert.equal(await loadConversationalAppointmentOfferDecisionContext({
      ctx: originalCtx,
      config: fixture.config
    }), null, 'volver al calendario anterior no debe revivir la oferta vieja')
  } finally {
    await db.run('DELETE FROM calendars WHERE id = ?', [replacementCalendarId]).catch(() => {})
    await cleanupFixture(fixture)
  }
})

test('live: cambiar la zona del negocio invalida la oferta UTC antes de aceptar y no agenda nada', async () => {
  const fixture = await createFixture('offer_timezone_drift')
  const previousTimezoneRow = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    ['account_timezone']
  )
  const alternateTimezone = fixture.timezone === 'UTC' ? 'America/New_York' : 'UTC'
  try {
    await selectDate(fixture)
    await offerExactTime(fixture, '14:00')
    await setAppConfig('account_timezone', alternateTimezone)
    invalidateTimezoneCache()

    const changedCtx = liveContext({
      fixture,
      executionId: `timezone-drift-confirm-${fixture.suffix}`
    })
    changedCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: changedCtx,
      config: fixture.config
    })
    assert.equal(changedCtx.appointmentOfferDecision, null)
    const invalidated = JSON.parse((await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
      [fixture.contactId, fixture.agentId]
    )).detail_json)
    assert.equal(invalidated.status, 'superseded')
    assert.equal(invalidated.resolution, 'timezone_changed')
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )).total), 0)
  } finally {
    if (previousTimezoneRow?.config_value) {
      await setAppConfig('account_timezone', previousTimezoneRow.config_value).catch(() => {})
    } else {
      await db.run('DELETE FROM app_config WHERE config_key = ?', ['account_timezone']).catch(() => {})
    }
    invalidateTimezoneCache()
    await cleanupFixture(fixture)
  }
})

test('live: cambiar la zona entre resolver el “sí” y ejecutar la terminal no agenda otra hora local', async () => {
  const fixture = await createFixture('offer_timezone_terminal_race')
  const previousTimezoneRow = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    ['account_timezone']
  )
  const alternateTimezone = fixture.timezone === 'America/Denver'
    ? 'America/Chicago'
    : 'America/Denver'
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '14:00')
    const confirmation = await confirmationContext(
      fixture,
      exact.offered,
      `confirm-timezone-terminal-race-${fixture.suffix}`
    )
    setNativeAppointmentBeforeResolverTerminalHookForTest(async () => {
      await setAppConfig('account_timezone', alternateTimezone)
      invalidateTimezoneCache()
    })

    const result = await toolNamed(confirmation, 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify(acceptOfferInput()))
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, 'appointment_offer_scope_changed')
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )).total), 0)
    const invalidated = JSON.parse((await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
      [fixture.contactId, fixture.agentId]
    )).detail_json)
    assert.equal(invalidated.status, 'superseded')
    assert.equal(invalidated.resolution, 'appointment_scope_changed')
  } finally {
    setNativeAppointmentBeforeResolverTerminalHookForTest(null)
    if (previousTimezoneRow?.config_value) {
      await setAppConfig('account_timezone', previousTimezoneRow.config_value).catch(() => {})
    } else {
      await db.run('DELETE FROM app_config WHERE config_key = ?', ['account_timezone']).catch(() => {})
    }
    invalidateTimezoneCache()
    await cleanupFixture(fixture)
  }
})

test('live: apagar o borrar el agente entre resolver el “sí” y ejecutar la terminal falla cerrado', async () => {
  for (const scenario of [
    {
      label: 'disabled',
      mutate: (agentId) => db.run(
        'UPDATE conversational_agents SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [agentId]
      )
    },
    {
      label: 'deleted',
      mutate: (agentId) => db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId])
    },
    {
      label: 'lookup_failed',
      mutate() {
        setNativeAppointmentRuntimeAgentLookupHookForTest(async () => {
          throw new Error('simulated_agent_lookup_failure')
        })
      }
    }
  ]) {
    const fixture = await createFixture(`offer_agent_${scenario.label}_terminal_race`)
    try {
      await selectDate(fixture)
      const exact = await offerExactTime(fixture, '14:00')
      const confirmation = await confirmationContext(
        fixture,
        exact.offered,
        `confirm-agent-${scenario.label}-terminal-race-${fixture.suffix}`
      )
      setNativeAppointmentBeforeResolverTerminalHookForTest(async () => {
        await scenario.mutate(fixture.agentId)
      })

      const result = await toolNamed(confirmation, 'resolve_active_appointment_offer')
        .invoke(null, JSON.stringify(acceptOfferInput()))
      assert.equal(result.ok, false, JSON.stringify(result))
      assert.equal(result.code, 'appointment_offer_scope_changed')
      assert.equal(Number((await db.get(
        'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
        [fixture.calendarId, fixture.contactId]
      )).total), 0)
      const invalidated = JSON.parse((await db.get(
        `SELECT detail_json FROM conversational_agent_events
         WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
        [fixture.contactId, fixture.agentId]
      )).detail_json)
      assert.equal(invalidated.status, 'superseded')
      assert.equal(invalidated.resolution, 'appointment_scope_changed')
    } finally {
      setNativeAppointmentBeforeResolverTerminalHookForTest(null)
      setNativeAppointmentRuntimeAgentLookupHookForTest(null)
      await cleanupFixture(fixture)
    }
  }
})

test('live: cambiar responsable o apagar agenda cierra la oferta en vez de dejarla revivir', async () => {
  for (const scenario of [
    {
      label: 'booking_owner',
      reason: 'booking_owner_changed',
      mutate(config) {
        config.capabilitiesConfig.items[0].bookingOwner = 'human'
      }
    },
    {
      label: 'capability_disabled',
      reason: 'schedule_capability_changed',
      mutate(config) {
        config.capabilitiesConfig.items[0].enabled = false
      }
    }
  ]) {
    const fixture = await createFixture(`offer_${scenario.label}_drift`)
    try {
      await selectDate(fixture)
      await offerExactTime(fixture, '14:00')
      const changedConfig = structuredClone(fixture.config)
      scenario.mutate(changedConfig)
      const changedCtx = liveContext({
        fixture: { ...fixture, config: changedConfig },
        executionId: `${scenario.label}-drift-confirm-${fixture.suffix}`
      })
      changedCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
        ctx: changedCtx,
        config: changedConfig
      })
      assert.equal(changedCtx.appointmentOfferDecision, null)
      const invalidated = JSON.parse((await db.get(
        `SELECT detail_json FROM conversational_agent_events
         WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
        [fixture.contactId, fixture.agentId]
      )).detail_json)
      assert.equal(invalidated.status, 'superseded')
      assert.equal(invalidated.resolution, scenario.reason)
    } finally {
      await cleanupFixture(fixture)
    }
  }
})
