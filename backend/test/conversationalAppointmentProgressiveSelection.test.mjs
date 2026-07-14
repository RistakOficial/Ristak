import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

import { db, setAppConfig } from '../src/config/database.js'
import {
  buildNativeFreeSlotDays,
  createConversationalTools,
  loadConversationalAppointmentOfferDecisionContext,
  loadConversationalAppointmentSelectionProgressContext,
  setNativeAppointmentAvailabilityLookupHookForTest
} from '../src/agents/conversational/tools.js'
import { runToolCallingV2Turn } from '../src/agents/conversational/runner.js'
import { upsertLocalCalendar } from '../src/services/localCalendarService.js'
import {
  CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT,
  buildConversationalAppointmentPreviewOfferEventId,
  cleanupConversationalAppointmentPreviewOffers
} from '../src/services/conversationalAppointmentPreviewOfferService.js'
import { getAccountTimezone, invalidateTimezoneCache } from '../src/utils/dateUtils.js'

function previewScope(suffix) {
  return `appointment_preview_${createHash('sha256').update(suffix).digest('hex').slice(0, 48)}`
}

function previewContext({ config, contactId, scopeId, executionId, messages = [] }) {
  return {
    runtimeMode: 'tool_calling_v2',
    contactId,
    agentId: config.id,
    channel: 'whatsapp',
    dryRun: true,
    previewScopeId: scopeId,
    executionId,
    followUpMode: false,
    actions: [],
    accountLocale: { currency: 'MXN' },
    virtualContact: {
      id: contactId,
      fullName: 'Contacto de prueba'
    },
    conversationMessages: messages,
    config
  }
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

function toolNamed(ctx, name) {
  const found = createConversationalTools(ctx).find((item) => item.name === name)
  assert.ok(found, `Falta la herramienta ${name}`)
  return found
}

function offerDecisionInput(decision, nextPreferenceScope = null) {
  return {
    decision,
    nextPreferenceScope,
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

async function createFixture(label = 'progressive') {
  const suffix = `${label}_${randomUUID()}`
  const timezone = await getAccountTimezone()
  const firstDay = DateTime.now().setZone(timezone).plus({ days: 21 }).startOf('day')
  const secondDay = firstDay.plus({ days: 1 })
  const calendarId = `calendar_${suffix}`
  const agentId = `agent_${suffix}`
  const contactId = `contact_${suffix}`
  const scopeId = previewScope(suffix)
  const config = {
    id: agentId,
    runtimeMode: 'tool_calling_v2',
    aiProvider: 'openai',
    model: 'gpt-4.1-mini',
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

  await upsertLocalCalendar({
    id: calendarId,
    name: 'Agenda progresiva',
    source: 'ristak',
    slotDuration: 60,
    slotDurationUnit: 'mins',
    slotInterval: 60,
    slotIntervalUnit: 'mins',
    appoinmentPerSlot: 1,
    allowReschedule: true,
    allowCancellation: true,
    openHours: [{
      daysOfTheWeek: [...new Set([firstDay.weekday, secondDay.weekday])],
      hours: [{ openHour: 11, openMinute: 0, closeHour: 17, closeMinute: 0 }]
    }]
  }, { source: 'ristak', syncStatus: 'synced' })

  return {
    suffix,
    timezone,
    firstDate: firstDay.toISODate(),
    secondDate: secondDay.toISODate(),
    calendarId,
    agentId,
    contactId,
    scopeId,
    config
  }
}

async function cleanupFixture(fixture) {
  await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [fixture.contactId]).catch(() => {})
  await db.run('DELETE FROM appointments WHERE calendar_id = ?', [fixture.calendarId]).catch(() => {})
  await db.run('DELETE FROM calendars WHERE id = ?', [fixture.calendarId]).catch(() => {})
}

async function selectDate(fixture, localDate, executionId = `select-date-${fixture.suffix}`) {
  const ctx = previewContext({
    config: fixture.config,
    contactId: fixture.contactId,
    scopeId: fixture.scopeId,
    executionId
  })
  ctx.appointmentOfferDecision = null
  ctx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
    ctx,
    config: fixture.config
  })
  const availability = await toolNamed(ctx, 'get_free_slots').invoke(
    null,
    JSON.stringify(freeSlotsInput(localDate, {
      progressDateAction: ctx.appointmentSelectionProgress?.selectedDate &&
        ctx.appointmentSelectionProgress.selectedDate !== localDate
        ? 'replace_selected_date'
        : 'keep_selected_date'
    }))
  )
  assert.equal(availability.ok, true, JSON.stringify(availability))
  assert.ok(availability.total > 1)
  const response = await toolNamed(ctx, 'offer_appointment_options').invoke(null, JSON.stringify({
    maxDays: 1,
    selectionMode: 'collecting_time',
    selectedLocalDate: localDate
  }))
  assert.equal(response.ok, true, JSON.stringify(response))
  return { ctx, availability, response }
}

async function insertOriginMainPreviewOffer({
  fixture,
  startTime,
  executionId,
  localLabelOverride = null,
  detailOverrides = {}
}) {
  const offerEventId = buildConversationalAppointmentPreviewOfferEventId(fixture.scopeId)
  const progressRow = await db.get(
    `SELECT detail_json FROM conversational_agent_events
     WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_selection_progress'`,
    [fixture.contactId, fixture.agentId]
  )
  const progressUpdatedAtMs = Date.parse(JSON.parse(progressRow?.detail_json || '{}').updatedAt || '')
  const offeredAt = new Date(Math.max(Date.now(), progressUpdatedAtMs + 1)).toISOString()
  const canonical = buildNativeFreeSlotDays([{
    timezone: fixture.timezone,
    slots: [startTime]
  }], fixture.timezone)[0]?.options?.[0]
  assert.ok(canonical?.localLabel, 'La oferta legacy de prueba debe usar el label canónico de origin/main')
  const localLabel = localLabelOverride ?? canonical.localLabel
  const separator = /[.!?]$/u.test(localLabel) ? ' ' : '. '
  const offerText = `Tengo disponible ${localLabel}${separator}¿Te funciona ese horario?`
  // Payload exacto del writer previo al progreso durable: no trae binding
  // terminal y no supersede la fila appointment_selection_progress.
  const detail = {
    agentId: fixture.agentId,
    contactId: fixture.contactId,
    channel: 'whatsapp',
    calendarId: fixture.calendarId,
    startTime,
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
    offeredAt,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    previewScopeId: fixture.scopeId,
    ...detailOverrides
  }
  await db.run(
    `INSERT INTO conversational_agent_events
      (id, contact_id, agent_id, event_type, detail_json)
     VALUES (?, ?, ?, ?, ?)`,
    [
      offerEventId,
      fixture.contactId,
      fixture.agentId,
      CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT,
      JSON.stringify(detail)
    ]
  )
  return { offerEventId, detail, offerText }
}

test('día en un turno + hora en otro + “sí” termina la cita sin repetir fecha ni dejarla en loop', async () => {
  const fixture = await createFixture('confirm_chain')
  try {
    const dateTurn = await selectDate(fixture, fixture.firstDate)
    assert.equal(dateTurn.response.selectedDate, fixture.firstDate)
    assert.equal(dateTurn.response.missingField, 'time')
    assert.match(dateTurn.response.visibleReply, /¿A qué hora te acomodaría\?/)
    assert.doesNotMatch(dateTurn.response.visibleReply, /¿Qué día y horario te acomoda mejor\?/)
    const partialToolNames = createConversationalTools(dateTurn.ctx).map((item) => item.name)
    assert.equal(partialToolNames.includes('book_appointment'), false)
    assert.equal(partialToolNames.includes('reschedule_appointment'), false)
    assert.equal(partialToolNames.includes('request_human_booking'), false)
    assert.ok(partialToolNames.includes('resolve_active_appointment_selection'))

    const timeExecutionId = `time-${fixture.suffix}`
    const timeCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: timeExecutionId
    })
    timeCtx.appointmentOfferDecision = null
    timeCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: timeCtx,
      config: fixture.config
    })
    assert.equal(timeCtx.appointmentSelectionProgress?.selectedDate, fixture.firstDate)
    assert.deepEqual(timeCtx.appointmentSelectionProgress?.missingFields, ['time'])

    const exactAvailability = await toolNamed(timeCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.firstDate, {
        earliestLocalTime: '16:00',
        latestLocalTime: '16:00'
      })
    ))
    assert.equal(exactAvailability.ok, true, JSON.stringify(exactAvailability))
    assert.equal(exactAvailability.total, 1)
    const exactSlot = exactAvailability.slots[0].options[0]
    const offered = await toolNamed(timeCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: exactSlot.startTime,
      appointmentId: null
    }))
    assert.equal(offered.ok, true, JSON.stringify(offered))
    assert.match(offered.visibleReply, /¿Te funciona ese horario\?/)

    const confirmationExecutionId = `confirm-${fixture.suffix}`
    const offerMessageId = `assistant-offer-${fixture.suffix}`
    const confirmationCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: confirmationExecutionId,
      messages: [
        { id: timeExecutionId, role: 'user', content: 'a las cuatro' },
        { id: offerMessageId, role: 'assistant', content: offered.visibleReply },
        { id: confirmationExecutionId, role: 'user', content: 'sí, confirmamos' }
      ]
    })
    confirmationCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: confirmationCtx,
      config: fixture.config
    })
    confirmationCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: confirmationCtx,
      config: fixture.config
    })
    assert.equal(confirmationCtx.appointmentOfferDecision?.active, true)
    assert.equal(confirmationCtx.appointmentSelectionProgress, null)

    const confirmationToolNames = createConversationalTools(confirmationCtx).map((item) => item.name)
    assert.ok(confirmationToolNames.includes('resolve_active_appointment_offer'))
    assert.equal(confirmationToolNames.includes('book_appointment'), false)
    assert.equal(confirmationToolNames.includes('reschedule_appointment'), false)

    const confirmed = await toolNamed(confirmationCtx, 'resolve_active_appointment_offer').invoke(null, JSON.stringify({
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
    }))
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
    assert.equal(confirmed.simulated, true)
    assert.equal(confirmed.terminal, true)
    assert.match(confirmed.visibleReply, /cita de prueba quedó confirmada/i)
    assert.doesNotMatch(confirmed.visibleReply, /qué día|qué horario|a qué hora/i)
    const bookingAction = confirmationCtx.actions.find((action) => action.type === 'book_appointment')
    assert.equal(bookingAction?.outcome?.wouldMarkObjectiveCompleted, true)

    const replayCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `confirm-replay-${fixture.suffix}`,
      messages: [
        { id: timeExecutionId, role: 'user', content: 'a las cuatro' },
        { id: offerMessageId, role: 'assistant', content: offered.visibleReply },
        { id: `confirm-replay-${fixture.suffix}`, role: 'user', content: 'sí' }
      ]
    })
    replayCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: replayCtx,
      config: fixture.config
    })
    assert.equal(replayCtx.appointmentOfferDecision, null, 'la misma oferta ya aceptada no vuelve a agendar')
  } finally {
    await cleanupFixture(fixture)
  }
})

test('una oferta de un pod viejo reconcilia la fecha parcial y pedir otra hora no revive el loop', async () => {
  const fixture = await createFixture('rolling_legacy_offer')
  try {
    await selectDate(fixture, fixture.firstDate)
    const startTime = DateTime.fromISO(`${fixture.firstDate}T16:00`, { zone: fixture.timezone })
      .toUTC()
      .toISO()
    const sourceExecutionId = `legacy-hour-${fixture.suffix}`
    const legacy = await insertOriginMainPreviewOffer({
      fixture,
      startTime,
      executionId: sourceExecutionId
    })

    const requestOtherExecutionId = `legacy-other-hour-${fixture.suffix}`
    const ctx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: requestOtherExecutionId,
      messages: [
        { id: sourceExecutionId, role: 'user', content: 'a las cuatro' },
        { id: `legacy-offer-message-${fixture.suffix}`, role: 'assistant', content: legacy.offerText },
        { id: requestOtherExecutionId, role: 'user', content: 'mejor otra hora' }
      ]
    })
    ctx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx,
      config: fixture.config
    })
    assert.equal(ctx.appointmentOfferDecision?.active, true)

    const migratedOffer = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [legacy.offerEventId]
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
    assert.equal(reconciledProgress.supersededByOfferEventId, legacy.offerEventId)

    const requestOther = await toolNamed(ctx, 'resolve_active_appointment_offer').invoke(
      null,
      JSON.stringify(offerDecisionInput('request_other_options', 'same_date'))
    )
    assert.equal(requestOther.ok, true, JSON.stringify(requestOther))
    assert.equal(requestOther.terminal, false)

    const nextCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `legacy-next-hour-${fixture.suffix}`
    })
    nextCtx.appointmentOfferDecision = null
    nextCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: nextCtx,
      config: fixture.config
    })
    assert.equal(nextCtx.appointmentSelectionProgress?.appointmentStatus, 'collecting_time')
    assert.equal(nextCtx.appointmentSelectionProgress?.selectedDate, fixture.firstDate)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('una oferta vieja de otro día pierde contra la fecha parcial más nueva', async () => {
  const fixture = await createFixture('rolling_legacy_scope_mismatch')
  try {
    await selectDate(fixture, fixture.firstDate)
    const legacy = await insertOriginMainPreviewOffer({
      fixture,
      startTime: DateTime.fromISO(`${fixture.secondDate}T16:00`, { zone: fixture.timezone })
        .toUTC()
        .toISO(),
      executionId: `legacy-wrong-day-${fixture.suffix}`
    })
    const ctx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `legacy-wrong-day-reply-${fixture.suffix}`
    })
    ctx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx,
      config: fixture.config
    })
    assert.equal(ctx.appointmentOfferDecision, null)
    const closedOffer = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [legacy.offerEventId]
    )).detail_json)
    assert.equal(closedOffer.status, 'superseded')
    assert.equal(closedOffer.resolution, 'progress_authority_newer_or_different_scope')
    const progress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: { ...ctx, appointmentOfferDecision: null },
      config: fixture.config
    })
    assert.equal(progress?.appointmentStatus, 'collecting_time')
    assert.equal(progress?.selectedDate, fixture.firstDate)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('una oferta legacy con texto de una hora y startTime de otra se cierra sin agendar', async () => {
  const fixture = await createFixture('rolling_legacy_label_mismatch')
  try {
    await selectDate(fixture, fixture.firstDate)
    const startTime = DateTime.fromISO(`${fixture.firstDate}T16:00`, { zone: fixture.timezone })
      .toUTC()
      .toISO()
    const otherLabel = buildNativeFreeSlotDays([{
      timezone: fixture.timezone,
      slots: [DateTime.fromISO(`${fixture.firstDate}T15:00`, { zone: fixture.timezone }).toUTC().toISO()]
    }], fixture.timezone)[0].options[0].localLabel
    const legacy = await insertOriginMainPreviewOffer({
      fixture,
      startTime,
      executionId: `legacy-label-mismatch-${fixture.suffix}`,
      localLabelOverride: otherLabel
    })
    const ctx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `legacy-label-mismatch-reply-${fixture.suffix}`
    })
    ctx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx,
      config: fixture.config
    })
    assert.equal(ctx.appointmentOfferDecision, null)
    const closedOffer = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [legacy.offerEventId]
    )).detail_json)
    assert.equal(closedOffer.status, 'superseded')
    assert.equal(closedOffer.resolution, 'legacy_offer_contract_invalid')
    const progress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: { ...ctx, appointmentOfferDecision: null },
      config: fixture.config
    })
    assert.equal(progress?.appointmentStatus, 'collecting_time')
    assert.equal(progress?.selectedDate, fixture.firstDate)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('una oferta legacy con propósito desconocido no se degrada silenciosamente a cita nueva', async () => {
  const fixture = await createFixture('rolling_legacy_unknown_purpose')
  try {
    await selectDate(fixture, fixture.firstDate)
    const legacy = await insertOriginMainPreviewOffer({
      fixture,
      startTime: DateTime.fromISO(`${fixture.firstDate}T16:00`, { zone: fixture.timezone })
        .toUTC()
        .toISO(),
      executionId: `legacy-unknown-purpose-${fixture.suffix}`,
      detailOverrides: {
        purpose: 'move',
        appointmentId: `appointment-future-${fixture.suffix}`
      }
    })
    const ctx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `legacy-unknown-purpose-reply-${fixture.suffix}`
    })
    ctx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx,
      config: fixture.config
    })
    assert.equal(ctx.appointmentOfferDecision, null)
    const closedOffer = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [legacy.offerEventId]
    )).detail_json)
    assert.equal(closedOffer.status, 'superseded')
    assert.equal(closedOffer.resolution, 'legacy_offer_contract_invalid')
    const progress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: { ...ctx, appointmentOfferDecision: null },
      config: fixture.config
    })
    assert.equal(progress?.appointmentStatus, 'collecting_time')
    assert.equal(progress?.selectedDate, fixture.firstDate)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('un progreso book que arrastra appointmentId no autoriza degradarlo a una cita nueva', async () => {
  const fixture = await createFixture('rolling_malformed_book_progress')
  try {
    await selectDate(fixture, fixture.firstDate)
    const progressRow = await db.get(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_selection_progress'`,
      [fixture.contactId, fixture.agentId]
    )
    const malformedProgressJson = JSON.stringify({
      ...JSON.parse(progressRow.detail_json),
      purpose: 'book',
      appointmentId: `appointment-ambiguous-${fixture.suffix}`
    })
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
      [malformedProgressJson, progressRow.id, progressRow.detail_json]
    )
    const legacy = await insertOriginMainPreviewOffer({
      fixture,
      startTime: DateTime.fromISO(`${fixture.firstDate}T16:00`, { zone: fixture.timezone })
        .toUTC()
        .toISO(),
      executionId: `legacy-malformed-book-progress-${fixture.suffix}`
    })
    const ctx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `legacy-malformed-book-progress-reply-${fixture.suffix}`
    })
    ctx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx,
      config: fixture.config
    })
    assert.equal(ctx.appointmentOfferDecision, null)
    assert.equal(
      (await db.get('SELECT detail_json FROM conversational_agent_events WHERE id = ?', [progressRow.id])).detail_json,
      malformedProgressJson
    )
    const closedOffer = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [legacy.offerEventId]
    )).detail_json)
    assert.equal(closedOffer.status, 'superseded')
    assert.equal(closedOffer.resolution, 'progress_authority_newer_or_different_scope')
  } finally {
    await cleanupFixture(fixture)
  }
})

test('una oferta vieja no puede pisar una versión futura aunque diga estar terminada o vencida', async () => {
  const fixture = await createFixture('rolling_legacy_future_progress')
  try {
    await selectDate(fixture, fixture.firstDate)
    const progressRow = await db.get(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_selection_progress'`,
      [fixture.contactId, fixture.agentId]
    )
    const futureProgressJson = JSON.stringify({
      ...JSON.parse(progressRow.detail_json),
      schemaVersion: 99,
      appointmentStatus: 'superseded',
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    })
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
      [futureProgressJson, progressRow.id, progressRow.detail_json]
    )
    const legacy = await insertOriginMainPreviewOffer({
      fixture,
      startTime: DateTime.fromISO(`${fixture.firstDate}T16:00`, { zone: fixture.timezone })
        .toUTC()
        .toISO(),
      executionId: `legacy-future-schema-${fixture.suffix}`
    })
    const ctx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `legacy-future-schema-reply-${fixture.suffix}`
    })
    await assert.rejects(
      loadConversationalAppointmentOfferDecisionContext({ ctx, config: fixture.config }),
      (error) => error?.code === 'appointment_offer_progress_authority_ambiguous'
    )
    assert.equal(
      (await db.get('SELECT detail_json FROM conversational_agent_events WHERE id = ?', [progressRow.id])).detail_json,
      futureProgressJson
    )
    const closedOffer = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [legacy.offerEventId]
    )).detail_json)
    assert.equal(closedOffer.status, 'superseded')
    assert.equal(closedOffer.resolution, 'progress_authority_unknown')
  } finally {
    await cleanupFixture(fixture)
  }
})

test('cambiar de fecha reemplaza el día anterior, no arrastra hora y permite reiniciar el proceso', async () => {
  const fixture = await createFixture('replace_date')
  try {
    await selectDate(fixture, fixture.firstDate, `select-first-${fixture.suffix}`)

    const replacement = await selectDate(fixture, fixture.secondDate, `select-second-${fixture.suffix}`)
    assert.equal(replacement.response.selectedDate, fixture.secondDate)
    assert.match(replacement.response.visibleReply, /¿A qué hora te acomodaría\?/)

    const resetCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `restart-${fixture.suffix}`
    })
    resetCtx.appointmentOfferDecision = null
    resetCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: resetCtx,
      config: fixture.config
    })
    assert.equal(resetCtx.appointmentSelectionProgress?.selectedDate, fixture.secondDate)
    assert.equal(resetCtx.appointmentSelectionProgress?.selectedTime, null)
    assert.ok(createConversationalTools(resetCtx).some((item) => item.name === 'resolve_active_appointment_selection'))

    const restarted = await toolNamed(resetCtx, 'resolve_active_appointment_selection').invoke(null, JSON.stringify({
      decision: 'restart'
    }))
    assert.equal(restarted.ok, true, JSON.stringify(restarted))
    assert.match(restarted.visibleReply, /empezamos de nuevo/i)

    const afterResetCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `after-restart-${fixture.suffix}`
    })
    afterResetCtx.appointmentOfferDecision = null
    afterResetCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: afterResetCtx,
      config: fixture.config
    })
    assert.equal(afterResetCtx.appointmentSelectionProgress, null)
    assert.equal(
      createConversationalTools(afterResetCtx).some((item) => item.name === 'resolve_active_appointment_selection'),
      false
    )
  } finally {
    await cleanupFixture(fixture)
  }
})

test('una hora suelta no puede cambiar silenciosamente el día durable y la transición final vuelve a comprobarlo', async () => {
  const fixture = await createFixture('wrong_day_for_hour')
  try {
    await selectDate(fixture, fixture.firstDate)
    const ctx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `wrong-day-hour-${fixture.suffix}`
    })
    ctx.appointmentOfferDecision = null
    ctx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx,
      config: fixture.config
    })
    assert.equal(ctx.appointmentSelectionProgress?.selectedDate, fixture.firstDate)

    const wrongDay = await toolNamed(ctx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.secondDate, {
        earliestLocalTime: '16:00',
        latestLocalTime: '16:00',
        progressDateAction: 'keep_selected_date'
      })
    ))
    assert.equal(wrongDay.ok, false, JSON.stringify(wrongDay))
    assert.equal(wrongDay.code, 'appointment_progress_date_change_required')
    assert.equal(ctx.nativeAppointmentAvailability, undefined)

    const explicitDateLookup = await toolNamed(ctx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.secondDate, {
        earliestLocalTime: '16:00',
        latestLocalTime: '16:00',
        progressDateAction: 'replace_selected_date'
      })
    ))
    assert.equal(explicitDateLookup.total, 1, JSON.stringify(explicitDateLookup))
    assert.equal(ctx.appointmentSelectionProgress?.selectedDate, fixture.secondDate)
    const forgedStartTime = DateTime.fromISO(`${fixture.firstDate}T16:00:00`, { zone: fixture.timezone })
      .toUTC()
      .toISO()
    ctx.nativeAppointmentAvailability.slots[0].options[0] = {
      ...ctx.nativeAppointmentAvailability.slots[0].options[0],
      startTime: forgedStartTime,
      localDate: fixture.firstDate
    }
    const forgedTransition = await toolNamed(ctx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: forgedStartTime,
      appointmentId: null
    }))
    assert.equal(forgedTransition.ok, false, JSON.stringify(forgedTransition))
    assert.equal(forgedTransition.code, 'appointment_progress_state_conflict')
    assert.equal(await db.get(
      `SELECT id FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_preview_offer_created'`,
      [fixture.contactId, fixture.agentId]
    ), null)

    const finalCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `after-wrong-day-${fixture.suffix}`
    })
    finalCtx.appointmentOfferDecision = null
    finalCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: finalCtx,
      config: fixture.config
    })
    assert.equal(finalCtx.appointmentSelectionProgress?.selectedDate, fixture.secondDate)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('un cambio explícito a un día sin esa hora conserva el día nuevo para el siguiente turno', async () => {
  const fixture = await createFixture('replace_date_without_slot')
  try {
    await selectDate(fixture, fixture.firstDate)
    const replacementCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `replace-without-slot-${fixture.suffix}`
    })
    replacementCtx.appointmentOfferDecision = null
    replacementCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: replacementCtx,
      config: fixture.config
    })
    const unavailable = await toolNamed(replacementCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.secondDate, {
        earliestLocalTime: '10:00',
        latestLocalTime: '10:00',
        progressDateAction: 'replace_selected_date'
      })
    ))
    assert.equal(unavailable.ok, true, JSON.stringify(unavailable))
    assert.equal(unavailable.total, 0)
    assert.equal(unavailable.selectedDate, fixture.secondDate)
    assert.equal(replacementCtx.appointmentSelectionProgress?.selectedDate, fixture.secondDate)

    const nextCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `hour-after-empty-replacement-${fixture.suffix}`
    })
    nextCtx.appointmentOfferDecision = null
    nextCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: nextCtx,
      config: fixture.config
    })
    assert.equal(nextCtx.appointmentSelectionProgress?.selectedDate, fixture.secondDate)
    const nextHour = await toolNamed(nextCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.secondDate, {
        earliestLocalTime: '16:00',
        latestLocalTime: '16:00',
        progressDateAction: 'keep_selected_date'
      })
    ))
    assert.equal(nextHour.ok, true, JSON.stringify(nextHour))
    assert.equal(nextHour.total, 1, JSON.stringify(nextHour))

    const closedDate = DateTime.fromISO(fixture.firstDate, { zone: fixture.timezone })
      .plus({ days: 2 })
      .toISODate()
    const closedCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `closed-date-${fixture.suffix}`
    })
    closedCtx.appointmentOfferDecision = null
    closedCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: closedCtx,
      config: fixture.config
    })
    const closed = await toolNamed(closedCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(closedDate, { progressDateAction: 'replace_selected_date' })
    ))
    assert.equal(closed.ok, true, JSON.stringify(closed))
    assert.equal(closed.total, 0)
    assert.equal(closed.selectedDate, null)
    assert.equal(closed.missingField, 'date')
    assert.equal(closedCtx.appointmentSelectionProgress?.appointmentStatus, 'collecting_date')
    assert.deepEqual(closedCtx.appointmentSelectionProgress?.missingFields, ['date'])

    const afterClosedCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `after-closed-date-${fixture.suffix}`
    })
    afterClosedCtx.appointmentOfferDecision = null
    afterClosedCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: afterClosedCtx,
      config: fixture.config
    })
    assert.equal(afterClosedCtx.appointmentSelectionProgress?.selectedDate, null)
    assert.deepEqual(afterClosedCtx.appointmentSelectionProgress?.missingFields, ['date'])
    const staleHour = await toolNamed(afterClosedCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.secondDate, {
        earliestLocalTime: '16:00',
        latestLocalTime: '16:00',
        progressDateAction: 'keep_selected_date'
      })
    ))
    assert.equal(staleHour.ok, false, JSON.stringify(staleHour))
    assert.equal(staleHour.code, 'appointment_progress_date_change_required')

    const newDateAndHour = await toolNamed(afterClosedCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.firstDate, {
        earliestLocalTime: '16:00',
        latestLocalTime: '16:00',
        progressDateAction: 'replace_selected_date'
      })
    ))
    assert.equal(newDateAndHour.ok, true, JSON.stringify(newDateAndHour))
    assert.equal(newDateAndHour.total, 1)
    assert.equal(afterClosedCtx.appointmentSelectionProgress?.selectedDate, fixture.firstDate)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('si falla la consulta al cambiar de día, descarta la fecha vieja y conserva que falta una fecha', async () => {
  const fixture = await createFixture('replace_date_lookup_failure')
  try {
    await selectDate(fixture, fixture.firstDate)
    const ctx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `replace-lookup-failure-${fixture.suffix}`
    })
    ctx.appointmentOfferDecision = null
    ctx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx,
      config: fixture.config
    })
    setNativeAppointmentAvailabilityLookupHookForTest(async () => {
      throw Object.assign(new Error('El proveedor de calendario no respondió.'), { statusCode: 503 })
    })
    const result = await toolNamed(ctx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.secondDate, { progressDateAction: 'replace_selected_date' })
    ))
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.availabilityCheckFailed, true)
    assert.equal(result.transferRequired, true)
    assert.equal(result.selectedDate, null)
    assert.equal(result.missingField, 'date')
    assert.match(result.note, /fecha anterior quedó descartada/i)

    setNativeAppointmentAvailabilityLookupHookForTest(null)
    const nextCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `after-replace-lookup-failure-${fixture.suffix}`
    })
    nextCtx.appointmentOfferDecision = null
    nextCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: nextCtx,
      config: fixture.config
    })
    assert.equal(nextCtx.appointmentSelectionProgress?.appointmentStatus, 'collecting_date')
    assert.equal(nextCtx.appointmentSelectionProgress?.selectedDate, null)
    assert.deepEqual(nextCtx.appointmentSelectionProgress?.missingFields, ['date'])
  } finally {
    setNativeAppointmentAvailabilityLookupHookForTest(null)
    await cleanupFixture(fixture)
  }
})

test('un horario no disponible conserva el día y una pregunta intermedia no borra el estado parcial', async () => {
  const fixture = await createFixture('unavailable')
  try {
    await selectDate(fixture, fixture.firstDate)

    const unrelatedCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `price-question-${fixture.suffix}`
    })
    unrelatedCtx.appointmentOfferDecision = null
    unrelatedCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: unrelatedCtx,
      config: fixture.config
    })
    assert.equal(unrelatedCtx.appointmentSelectionProgress?.selectedDate, fixture.firstDate)

    const unavailable = await toolNamed(unrelatedCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.firstDate, {
        earliestLocalTime: '17:00',
        latestLocalTime: '17:00'
      })
    ))
    assert.equal(unavailable.ok, true, JSON.stringify(unavailable))
    assert.equal(unavailable.total, 0)

    const nextCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `after-unavailable-${fixture.suffix}`
    })
    nextCtx.appointmentOfferDecision = null
    nextCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: nextCtx,
      config: fixture.config
    })
    assert.equal(nextCtx.appointmentSelectionProgress?.selectedDate, fixture.firstDate)
    assert.deepEqual(nextCtx.appointmentSelectionProgress?.missingFields, ['time'])
  } finally {
    await cleanupFixture(fixture)
  }
})

test('el runner reinyecta la fecha parcial y las reglas de confirmación en una ejecución nueva', async () => {
  const fixture = await createFixture('runner_context')
  try {
    await selectDate(fixture, fixture.firstDate)
    let capturedInstructions = ''
    const turn = await runToolCallingV2Turn({
      config: fixture.config,
      runtime: { modelProvider: {} },
      messages: [{ id: `hour-${fixture.suffix}`, role: 'user', content: 'el último horario' }],
      contactId: fixture.contactId,
      contactName: 'Contacto de prueba',
      dryRun: true,
      channel: 'whatsapp',
      traceMessage: 'el último horario',
      executionId: `hour-${fixture.suffix}`,
      previewScopeId: fixture.scopeId,
      virtualContact: { id: fixture.contactId, fullName: 'Contacto de prueba' },
      conversationModel: 'gpt-4.1-mini'
    }, {
      executeAgent: async ({ agent }) => {
        capturedInstructions = String(agent.instructions || '')
        return 'respuesta de prueba'
      },
      runInChannel: (_channel, callback) => callback()
    })

    assert.equal(turn.appointmentSelectionProgress?.selectedDate, fixture.firstDate)
    assert.match(capturedInstructions, /Selección progresiva de cita/)
    assert.match(capturedInstructions, new RegExp(fixture.firstDate))
    assert.match(capturedInstructions, /falta únicamente la hora/i)
    assert.match(capturedInstructions, /el último/i)
    assert.match(capturedInstructions, /reconsulta get_free_slots exactamente/i)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('cambiar sólo la hora conserva la fecha; cambiar de día elimina la fecha anterior', async () => {
  const fixture = await createFixture('change_time_scope')
  try {
    await selectDate(fixture, fixture.firstDate)

    const offerCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `offer-16-${fixture.suffix}`
    })
    offerCtx.appointmentOfferDecision = null
    offerCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: offerCtx,
      config: fixture.config
    })
    const atFour = await toolNamed(offerCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.firstDate, { earliestLocalTime: '16:00', latestLocalTime: '16:00' })
    ))
    assert.equal(atFour.total, 1, JSON.stringify(atFour))
    const firstOffer = await toolNamed(offerCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: atFour.slots[0].options[0].startTime,
      appointmentId: null
    }))
    assert.equal(firstOffer.ok, true, JSON.stringify(firstOffer))

    const changeTimeCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `change-time-${fixture.suffix}`,
      messages: [
        { id: `offer-16-message-${fixture.suffix}`, role: 'assistant', content: firstOffer.visibleReply },
        { id: `change-time-${fixture.suffix}`, role: 'user', content: 'mejor a las 3' }
      ]
    })
    changeTimeCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: changeTimeCtx,
      config: fixture.config
    })
    const missingScope = await toolNamed(changeTimeCtx, 'resolve_active_appointment_offer').invoke(
      null,
      JSON.stringify(offerDecisionInput('request_other_options', null))
    )
    assert.equal(missingScope.ok, false, JSON.stringify(missingScope))
    assert.equal(missingScope.code, 'appointment_next_preference_scope_required')
    assert.match(missingScope.visibleReply, /mismo día|cambiar de fecha/i)
    const stillActive = await loadConversationalAppointmentOfferDecisionContext({
      ctx: changeTimeCtx,
      config: fixture.config
    })
    assert.equal(stillActive?.active, true, 'omitir el alcance no debe borrar la fecha ni consumir la oferta')
    const keepDate = await toolNamed(changeTimeCtx, 'resolve_active_appointment_offer').invoke(
      null,
      JSON.stringify(offerDecisionInput('request_other_options', 'same_date'))
    )
    assert.equal(keepDate.ok, true, JSON.stringify(keepDate))
    assert.equal(keepDate.terminal, false)

    const retainedCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `retained-date-${fixture.suffix}`
    })
    retainedCtx.appointmentOfferDecision = null
    retainedCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: retainedCtx,
      config: fixture.config
    })
    assert.equal(retainedCtx.appointmentSelectionProgress?.selectedDate, fixture.firstDate)
    assert.deepEqual(retainedCtx.appointmentSelectionProgress?.missingFields, ['time'])

    const atThree = await toolNamed(retainedCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.firstDate, { earliestLocalTime: '15:00', latestLocalTime: '15:00' })
    ))
    assert.equal(atThree.total, 1, JSON.stringify(atThree))
    const secondOffer = await toolNamed(retainedCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: atThree.slots[0].options[0].startTime,
      appointmentId: null
    }))
    assert.equal(secondOffer.ok, true, JSON.stringify(secondOffer))

    const changeDateCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `change-date-${fixture.suffix}`,
      messages: [
        { id: `offer-15-message-${fixture.suffix}`, role: 'assistant', content: secondOffer.visibleReply },
        { id: `change-date-${fixture.suffix}`, role: 'user', content: 'mejor otro día' }
      ]
    })
    changeDateCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: changeDateCtx,
      config: fixture.config
    })
    const clearDate = await toolNamed(changeDateCtx, 'resolve_active_appointment_offer').invoke(
      null,
      JSON.stringify(offerDecisionInput('request_other_options', 'different_date'))
    )
    assert.equal(clearDate.ok, true, JSON.stringify(clearDate))

    const clearedCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `cleared-date-${fixture.suffix}`
    })
    clearedCtx.appointmentOfferDecision = null
    clearedCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: clearedCtx,
      config: fixture.config
    })
    assert.equal(clearedCtx.appointmentSelectionProgress?.active, true)
    assert.equal(clearedCtx.appointmentSelectionProgress?.appointmentStatus, 'collecting_date')
    assert.equal(clearedCtx.appointmentSelectionProgress?.selectedDate, null)
    assert.deepEqual(clearedCtx.appointmentSelectionProgress?.missingFields, ['date'])

    const unhydratedCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `unhydrated-date-${fixture.suffix}`
    })
    unhydratedCtx.appointmentOfferDecision = null
    unhydratedCtx.appointmentSelectionProgress = null
    const otherDay = await toolNamed(unhydratedCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.secondDate, { progressDateAction: 'replace_selected_date' })
    ))
    assert.ok(otherDay.total > 0, JSON.stringify(otherDay))
    const parallelOffer = await toolNamed(unhydratedCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: otherDay.slots[0].options[0].startTime,
      appointmentId: null
    }))
    assert.equal(parallelOffer.ok, false, JSON.stringify(parallelOffer))
    assert.equal(parallelOffer.terminal, true)
    assert.equal(parallelOffer.code, 'appointment_progress_state_conflict')
    const stillCollectingDate = await loadConversationalAppointmentSelectionProgressContext({
      ctx: { ...clearedCtx, appointmentSelectionProgress: null },
      config: fixture.config
    })
    assert.equal(stillCollectingDate?.appointmentStatus, 'collecting_date')
    assert.equal(stillCollectingDate?.selectedDate, null)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('un estado vencido se invalida, no revive y la limpieza del preview lo elimina', async () => {
  const fixture = await createFixture('expired_progress')
  try {
    await selectDate(fixture, fixture.firstDate)
    const progressRow = await db.get(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_selection_progress'`,
      [fixture.contactId, fixture.agentId]
    )
    assert.ok(progressRow?.id)
    const expiredDetail = {
      ...JSON.parse(progressRow.detail_json),
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    }
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
      [JSON.stringify(expiredDetail), progressRow.id, progressRow.detail_json]
    )

    const expiredCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `after-expiry-${fixture.suffix}`
    })
    expiredCtx.appointmentOfferDecision = null
    expiredCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: expiredCtx,
      config: fixture.config
    })
    assert.equal(expiredCtx.appointmentSelectionProgress, null)
    const invalidated = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [progressRow.id]
    )).detail_json)
    assert.equal(invalidated.appointmentStatus, 'superseded')
    assert.equal(invalidated.invalidationReason, 'expired')

    const replacement = await selectDate(fixture, fixture.secondDate, `after-expiry-select-${fixture.suffix}`)
    assert.equal(replacement.response.selectedDate, fixture.secondDate)

    const cleanup = await cleanupConversationalAppointmentPreviewOffers({
      previewScopeId: fixture.scopeId,
      agentId: fixture.agentId
    })
    assert.ok(cleanup.deleted >= 1, JSON.stringify(cleanup))
    assert.equal(await db.get(
      `SELECT id FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_selection_progress'`,
      [fixture.contactId, fixture.agentId]
    ), null)
    assert.equal(await db.get(
      `SELECT id FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_preview_authority_lock'`,
      [fixture.contactId, fixture.agentId]
    ), null, 'el reset del tester también elimina la fila de serialización preview')
  } finally {
    await cleanupFixture(fixture)
  }
})

test('dos turnos con el mismo estado no se pisan: uno gana CAS y el otro no deja una lista fantasma', async () => {
  const fixture = await createFixture('progress_cas')
  try {
    await selectDate(fixture, fixture.firstDate)
    const contexts = await Promise.all([fixture.firstDate, fixture.firstDate].map(async (localDate, index) => {
      const ctx = previewContext({
        config: fixture.config,
        contactId: fixture.contactId,
        scopeId: fixture.scopeId,
        executionId: `concurrent-${index}-${fixture.suffix}`
      })
      ctx.appointmentOfferDecision = null
      ctx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
        ctx,
        config: fixture.config
      })
      assert.ok(ctx.appointmentSelectionProgress?.stateFingerprint)
      const availability = await toolNamed(ctx, 'get_free_slots').invoke(
        null,
        JSON.stringify(freeSlotsInput(localDate, {
          progressDateAction: 'keep_selected_date'
        }))
      )
      assert.ok(availability.total > 1, JSON.stringify(availability))
      return { ctx, localDate }
    }))
    assert.equal(
      contexts[0].ctx.appointmentSelectionProgress.stateFingerprint,
      contexts[1].ctx.appointmentSelectionProgress.stateFingerprint
    )
    const beforeReferences = Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_availability_options_presented'`,
      [fixture.contactId, fixture.agentId]
    )).total)

    const results = await Promise.all(contexts.map(({ ctx, localDate }) => (
      toolNamed(ctx, 'offer_appointment_options').invoke(null, JSON.stringify({
        maxDays: 1,
        selectionMode: 'collecting_time',
        selectedLocalDate: localDate
      }))
    )))
    assert.equal(results.filter((result) => result.ok === true).length, 1, JSON.stringify(results))
    assert.equal(results.filter((result) => result.ok === false).length, 1, JSON.stringify(results))
    const losingResult = results.find((result) => result.ok === false)
    assert.equal(losingResult?.terminal, true, 'la ejecución CAS perdedora debe cortar la vuelta y no entrar en loop')
    assert.match(losingResult?.visibleReply || '', /qué hora/i)
    assert.equal(
      Number((await db.get(
        `SELECT COUNT(*) AS total FROM conversational_agent_events
         WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_availability_options_presented'`,
        [fixture.contactId, fixture.agentId]
      )).total),
      beforeReferences + 1,
      'la transacción perdedora no debe dejar una referencia de horarios que nunca mostró'
    )

    const finalCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `after-concurrent-${fixture.suffix}`
    })
    finalCtx.appointmentOfferDecision = null
    finalCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: finalCtx,
      config: fixture.config
    })
    assert.ok([fixture.firstDate, fixture.secondDate].includes(finalCtx.appointmentSelectionProgress?.selectedDate))
  } finally {
    await cleanupFixture(fixture)
  }
})

test('un restart viejo no borra una fecha nueva ni vuelve a preguntar el día', async () => {
  const fixture = await createFixture('stale_partial_restart')
  try {
    await selectDate(fixture, fixture.firstDate)
    const staleCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `stale-restart-${fixture.suffix}`
    })
    staleCtx.appointmentOfferDecision = null
    staleCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: staleCtx,
      config: fixture.config
    })
    await selectDate(fixture, fixture.secondDate, `newer-date-${fixture.suffix}`)

    const result = await toolNamed(staleCtx, 'resolve_active_appointment_selection').invoke(
      null,
      JSON.stringify({ decision: 'restart' })
    )
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.terminal, true)
    assert.match(result.visibleReply, /qué hora/i)

    const finalCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `after-stale-restart-${fixture.suffix}`
    })
    finalCtx.appointmentOfferDecision = null
    finalCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: finalCtx,
      config: fixture.config
    })
    assert.equal(finalCtx.appointmentSelectionProgress?.selectedDate, fixture.secondDate)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('una reagenda progresiva conserva purpose y appointmentId aunque el modelo mande null en el turno de la hora', async () => {
  const fixture = await createFixture('reschedule_scope')
  const appointmentId = `appointment_${fixture.suffix}`
  try {
    const originalStart = DateTime.fromISO(`${fixture.firstDate}T12:00:00`, { zone: fixture.timezone })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto para reagenda progresiva', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [fixture.contactId]
    )
    await db.run(
      `INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status,
        start_time, end_time, source, sync_status, date_added, date_updated
      ) VALUES (?, ?, ?, 'Cita para mover', 'confirmed', 'confirmed', ?, ?, 'ristak', 'synced', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        appointmentId,
        fixture.calendarId,
        fixture.contactId,
        originalStart.toUTC().toISO(),
        originalStart.plus({ hours: 1 }).toUTC().toISO()
      ]
    )

    const dateCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `reschedule-date-${fixture.suffix}`
    })
    dateCtx.appointmentOfferDecision = null
    dateCtx.appointmentSelectionProgress = null
    const availability = await toolNamed(dateCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.firstDate, { appointmentId })
    ))
    assert.equal(availability.ok, true, JSON.stringify(availability))
    assert.equal(availability.purpose, 'reschedule')
    assert.equal(availability.appointmentId, appointmentId)
    const selectedDate = await toolNamed(dateCtx, 'offer_appointment_options').invoke(null, JSON.stringify({
      maxDays: 1,
      selectionMode: 'collecting_time',
      selectedLocalDate: fixture.firstDate
    }))
    assert.equal(selectedDate.ok, true, JSON.stringify(selectedDate))

    const timeCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `reschedule-time-${fixture.suffix}`
    })
    timeCtx.appointmentOfferDecision = null
    timeCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: timeCtx,
      config: fixture.config
    })
    assert.equal(timeCtx.appointmentSelectionProgress?.purpose, 'reschedule')
    assert.equal(timeCtx.appointmentSelectionProgress?.appointmentId, appointmentId)

    let rescheduleInstructions = ''
    await runToolCallingV2Turn({
      config: fixture.config,
      runtime: { modelProvider: {} },
      messages: [{ id: `reschedule-hour-prompt-${fixture.suffix}`, role: 'user', content: 'a las cuatro' }],
      contactId: fixture.contactId,
      contactName: 'Contacto para reagenda progresiva',
      dryRun: true,
      channel: 'whatsapp',
      traceMessage: 'a las cuatro',
      executionId: `reschedule-hour-prompt-${fixture.suffix}`,
      previewScopeId: fixture.scopeId,
      virtualContact: { id: fixture.contactId, fullName: 'Contacto para reagenda progresiva' },
      conversationModel: 'gpt-4.1-mini'
    }, {
      executeAgent: async ({ agent }) => {
        rescheduleInstructions = String(agent.instructions || '')
        return 'respuesta de prueba'
      },
      runInChannel: (_channel, callback) => callback()
    })
    assert.match(rescheduleInstructions, /reagenda vigente/i)
    assert.equal(rescheduleInstructions.includes(appointmentId), false, 'el ID interno no debe llegar al prompt')

    const exact = await toolNamed(timeCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.firstDate, {
        appointmentId: null,
        earliestLocalTime: '16:00',
        latestLocalTime: '16:00'
      })
    ))
    assert.equal(exact.ok, true, JSON.stringify(exact))
    assert.equal(exact.purpose, 'reschedule')
    assert.equal(exact.appointmentId, appointmentId)
    assert.equal(exact.total, 1)

    const offered = await toolNamed(timeCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: exact.slots[0].options[0].startTime,
      appointmentId: null
    }))
    assert.equal(offered.ok, true, JSON.stringify(offered))

    const confirmationCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `reschedule-confirm-${fixture.suffix}`,
      messages: [
        { id: `reschedule-offer-message-${fixture.suffix}`, role: 'assistant', content: offered.visibleReply },
        { id: `reschedule-confirm-${fixture.suffix}`, role: 'user', content: 'mejor otro día' }
      ]
    })
    confirmationCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: confirmationCtx,
      config: fixture.config
    })
    assert.equal(confirmationCtx.appointmentOfferDecision?.purpose, 'reschedule')
    assert.equal(confirmationCtx.appointmentOfferDecision?.appointmentId, appointmentId)

    const requestAnotherDate = await toolNamed(confirmationCtx, 'resolve_active_appointment_offer').invoke(
      null,
      JSON.stringify(offerDecisionInput('request_other_options', 'different_date'))
    )
    assert.equal(requestAnotherDate.ok, true, JSON.stringify(requestAnotherDate))

    const changedDateCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `reschedule-other-date-${fixture.suffix}`
    })
    changedDateCtx.appointmentOfferDecision = null
    changedDateCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: changedDateCtx,
      config: fixture.config
    })
    assert.equal(changedDateCtx.appointmentSelectionProgress?.appointmentStatus, 'collecting_date')
    assert.equal(changedDateCtx.appointmentSelectionProgress?.selectedDate, null)
    assert.deepEqual(changedDateCtx.appointmentSelectionProgress?.missingFields, ['date'])
    assert.equal(changedDateCtx.appointmentSelectionProgress?.purpose, 'reschedule')
    assert.equal(changedDateCtx.appointmentSelectionProgress?.appointmentId, appointmentId)

    const changedAvailability = await toolNamed(changedDateCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.secondDate, {
        appointmentId: null,
        progressDateAction: 'replace_selected_date'
      })
    ))
    assert.equal(changedAvailability.ok, true, JSON.stringify(changedAvailability))
    assert.equal(changedAvailability.purpose, 'reschedule')
    assert.equal(changedAvailability.appointmentId, appointmentId)
  } finally {
    await cleanupFixture(fixture)
    await db.run('DELETE FROM contacts WHERE id = ?', [fixture.contactId]).catch(() => {})
  }
})

test('una reagenda que prueba un día cerrado conserva la cita objetivo mientras vuelve a pedir fecha', async () => {
  const fixture = await createFixture('reschedule_closed_date_scope')
  const appointmentId = `appointment_${fixture.suffix}`
  try {
    const originalStart = DateTime.fromISO(`${fixture.firstDate}T12:00:00`, { zone: fixture.timezone })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto reagenda día cerrado', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [fixture.contactId]
    )
    await db.run(
      `INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status,
        start_time, end_time, source, sync_status, date_added, date_updated
      ) VALUES (?, ?, ?, 'Cita para mover', 'confirmed', 'confirmed', ?, ?, 'ristak', 'synced', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        appointmentId,
        fixture.calendarId,
        fixture.contactId,
        originalStart.toUTC().toISO(),
        originalStart.plus({ hours: 1 }).toUTC().toISO()
      ]
    )

    const dateCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `reschedule-closed-initial-${fixture.suffix}`
    })
    dateCtx.appointmentOfferDecision = null
    const initialAvailability = await toolNamed(dateCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.firstDate, { appointmentId })
    ))
    assert.equal(initialAvailability.ok, true, JSON.stringify(initialAvailability))
    const selected = await toolNamed(dateCtx, 'offer_appointment_options').invoke(null, JSON.stringify({
      maxDays: 1,
      selectionMode: 'collecting_time',
      selectedLocalDate: fixture.firstDate
    }))
    assert.equal(selected.ok, true, JSON.stringify(selected))

    const closedDate = DateTime.fromISO(fixture.firstDate, { zone: fixture.timezone })
      .plus({ days: 2 })
      .toISODate()
    const closedCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `reschedule-closed-change-${fixture.suffix}`
    })
    closedCtx.appointmentOfferDecision = null
    closedCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: closedCtx,
      config: fixture.config
    })
    const closed = await toolNamed(closedCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(closedDate, {
        appointmentId: null,
        progressDateAction: 'replace_selected_date'
      })
    ))
    assert.equal(closed.ok, true, JSON.stringify(closed))
    assert.equal(closed.total, 0)
    assert.equal(closed.selectedDate, null)
    assert.equal(closed.missingField, 'date')

    const nextCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `reschedule-after-closed-${fixture.suffix}`
    })
    nextCtx.appointmentOfferDecision = null
    nextCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: nextCtx,
      config: fixture.config
    })
    assert.equal(nextCtx.appointmentSelectionProgress?.appointmentStatus, 'collecting_date')
    assert.equal(nextCtx.appointmentSelectionProgress?.purpose, 'reschedule')
    assert.equal(nextCtx.appointmentSelectionProgress?.appointmentId, appointmentId)

    let instructions = ''
    await runToolCallingV2Turn({
      config: fixture.config,
      runtime: { modelProvider: {} },
      messages: [{ id: nextCtx.executionId, role: 'user', content: 'mejor otro día' }],
      contactId: fixture.contactId,
      contactName: 'Contacto reagenda día cerrado',
      dryRun: true,
      channel: 'whatsapp',
      traceMessage: 'mejor otro día',
      executionId: nextCtx.executionId,
      previewScopeId: fixture.scopeId,
      virtualContact: { id: fixture.contactId, fullName: 'Contacto reagenda día cerrado' },
      conversationModel: 'gpt-4.1-mini'
    }, {
      executeAgent: async ({ agent }) => {
        instructions = String(agent.instructions || '')
        return 'respuesta de prueba'
      },
      runInChannel: (_channel, callback) => callback()
    })
    assert.match(instructions, /falta la fecha/i)
    assert.match(instructions, /reagenda vigente/i)
    assert.equal(instructions.includes(appointmentId), false)

    const replacement = await toolNamed(nextCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.secondDate, {
        appointmentId: null,
        earliestLocalTime: '16:00',
        latestLocalTime: '16:00',
        progressDateAction: 'replace_selected_date'
      })
    ))
    assert.equal(replacement.ok, true, JSON.stringify(replacement))
    assert.equal(replacement.total, 1)
    assert.equal(replacement.purpose, 'reschedule')
    assert.equal(replacement.appointmentId, appointmentId)
    assert.equal(nextCtx.appointmentSelectionProgress?.selectedDate, fixture.secondDate)

    setNativeAppointmentAvailabilityLookupHookForTest(async () => {
      throw Object.assign(new Error('La agenda no respondió durante la reagenda.'), { statusCode: 503 })
    })
    const failedReplacement = await toolNamed(nextCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.firstDate, {
        appointmentId: null,
        progressDateAction: 'replace_selected_date'
      })
    ))
    assert.equal(failedReplacement.ok, false, JSON.stringify(failedReplacement))
    assert.equal(failedReplacement.selectedDate, null)
    assert.equal(failedReplacement.missingField, 'date')
    setNativeAppointmentAvailabilityLookupHookForTest(null)

    const afterFailureCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `reschedule-after-lookup-failure-${fixture.suffix}`
    })
    afterFailureCtx.appointmentOfferDecision = null
    afterFailureCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: afterFailureCtx,
      config: fixture.config
    })
    assert.equal(afterFailureCtx.appointmentSelectionProgress?.appointmentStatus, 'collecting_date')
    assert.equal(afterFailureCtx.appointmentSelectionProgress?.purpose, 'reschedule')
    assert.equal(afterFailureCtx.appointmentSelectionProgress?.appointmentId, appointmentId)
  } finally {
    setNativeAppointmentAvailabilityLookupHookForTest(null)
    await cleanupFixture(fixture)
    await db.run('DELETE FROM contacts WHERE id = ?', [fixture.contactId]).catch(() => {})
  }
})

test('cambiar el calendario invalida la fecha vieja, no la revive y permite seleccionar en la agenda nueva', async () => {
  const fixture = await createFixture('calendar_scope')
  const otherCalendarId = `calendar_other_${fixture.suffix}`
  try {
    await selectDate(fixture, fixture.firstDate)
    const weekdays = [fixture.firstDate, fixture.secondDate]
      .map((date) => DateTime.fromISO(date, { zone: fixture.timezone }).weekday)
    await upsertLocalCalendar({
      id: otherCalendarId,
      name: 'Otra agenda progresiva',
      source: 'ristak',
      slotDuration: 60,
      slotDurationUnit: 'mins',
      slotInterval: 60,
      slotIntervalUnit: 'mins',
      appoinmentPerSlot: 1,
      allowReschedule: true,
      allowCancellation: true,
      openHours: [{
        daysOfTheWeek: [...new Set(weekdays)],
        hours: [{ openHour: 11, openMinute: 0, closeHour: 17, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })
    const otherConfig = structuredClone(fixture.config)
    otherConfig.capabilitiesConfig.items[0].calendarId = otherCalendarId

    const changedCalendarCtx = previewContext({
      config: otherConfig,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `calendar-changed-${fixture.suffix}`
    })
    changedCalendarCtx.appointmentOfferDecision = null
    changedCalendarCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: changedCalendarCtx,
      config: otherConfig
    })
    assert.equal(changedCalendarCtx.appointmentSelectionProgress, null)
    const invalidatedRow = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_selection_progress'`,
      [fixture.contactId, fixture.agentId]
    )
    assert.equal(JSON.parse(invalidatedRow.detail_json).invalidationReason, 'calendar_changed')

    const originalAgainCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `calendar-original-again-${fixture.suffix}`
    })
    originalAgainCtx.appointmentOfferDecision = null
    assert.equal(await loadConversationalAppointmentSelectionProgressContext({
      ctx: originalAgainCtx,
      config: fixture.config
    }), null, 'volver al calendario anterior no revive una selección invalidada')

    const otherFixture = {
      ...fixture,
      calendarId: otherCalendarId,
      config: otherConfig
    }
    const replacement = await selectDate(
      otherFixture,
      fixture.secondDate,
      `calendar-new-selection-${fixture.suffix}`
    )
    assert.equal(replacement.response.selectedDate, fixture.secondDate)
    assert.equal(replacement.ctx.appointmentSelectionProgress?.calendarId, otherCalendarId)
  } finally {
    await db.run('DELETE FROM calendars WHERE id = ?', [otherCalendarId]).catch(() => {})
    await cleanupFixture(fixture)
  }
})

test('cambiar la zona del negocio invalida la fecha parcial y volver a la zona anterior no la revive', async () => {
  const fixture = await createFixture('timezone_scope')
  const previousTimezoneRow = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    ['account_timezone']
  )
  const alternateTimezone = fixture.timezone === 'UTC' ? 'America/New_York' : 'UTC'
  try {
    await selectDate(fixture, fixture.firstDate)
    await setAppConfig('account_timezone', alternateTimezone)
    invalidateTimezoneCache()

    const changedTimezoneCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `timezone-changed-${fixture.suffix}`
    })
    changedTimezoneCtx.appointmentOfferDecision = null
    changedTimezoneCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: changedTimezoneCtx,
      config: fixture.config
    })
    assert.equal(changedTimezoneCtx.appointmentSelectionProgress, null)
    const invalidatedRow = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_selection_progress'`,
      [fixture.contactId, fixture.agentId]
    )
    assert.equal(JSON.parse(invalidatedRow.detail_json).invalidationReason, 'timezone_changed')

    if (previousTimezoneRow?.config_value) {
      await setAppConfig('account_timezone', previousTimezoneRow.config_value)
    } else {
      await db.run('DELETE FROM app_config WHERE config_key = ?', ['account_timezone'])
    }
    invalidateTimezoneCache()
    const originalTimezoneCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `timezone-original-${fixture.suffix}`
    })
    originalTimezoneCtx.appointmentOfferDecision = null
    assert.equal(await loadConversationalAppointmentSelectionProgressContext({
      ctx: originalTimezoneCtx,
      config: fixture.config
    }), null)
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

test('una fecha parcial que ya quedó en el pasado no sigue pidiendo hora al día siguiente', async () => {
  const fixture = await createFixture('elapsed_date')
  try {
    await selectDate(fixture, fixture.firstDate)
    const row = await db.get(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_selection_progress'`,
      [fixture.contactId, fixture.agentId]
    )
    const elapsedDetail = {
      ...JSON.parse(row.detail_json),
      selectedDate: DateTime.now().setZone(fixture.timezone).minus({ days: 1 }).toISODate(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    }
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
      [JSON.stringify(elapsedDetail), row.id, row.detail_json]
    )

    const nextDayCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `next-day-${fixture.suffix}`
    })
    nextDayCtx.appointmentOfferDecision = null
    assert.equal(await loadConversationalAppointmentSelectionProgressContext({
      ctx: nextDayCtx,
      config: fixture.config
    }), null)
    const invalidated = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [row.id]
    )).detail_json)
    assert.equal(invalidated.invalidationReason, 'selected_date_elapsed')
  } finally {
    await cleanupFixture(fixture)
  }
})

test('si la fecha cambia mientras se prepara la oferta exacta, no queda una oferta huérfana ni se pierde la selección nueva', async () => {
  const fixture = await createFixture('atomic_offer_transition')
  try {
    await selectDate(fixture, fixture.firstDate)
    const staleCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `stale-offer-${fixture.suffix}`
    })
    staleCtx.appointmentOfferDecision = null
    staleCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: staleCtx,
      config: fixture.config
    })
    const staleAvailability = await toolNamed(staleCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.firstDate, { earliestLocalTime: '16:00', latestLocalTime: '16:00' })
    ))
    assert.equal(staleAvailability.total, 1, JSON.stringify(staleAvailability))

    await selectDate(fixture, fixture.secondDate, `winning-date-${fixture.suffix}`)
    const staleOffer = await toolNamed(staleCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: staleAvailability.slots[0].options[0].startTime,
      appointmentId: null
    }))
    assert.equal(staleOffer.ok, false, JSON.stringify(staleOffer))
    assert.equal(staleOffer.code, 'appointment_progress_state_conflict')
    assert.equal(staleOffer.terminal, true, 'el turno perdedor debe cerrarse sin reintentar con el mismo fingerprint')
    assert.match(staleOffer.visibleReply, /qué hora/i)
    assert.equal(await db.get(
      `SELECT id FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_preview_offer_created'`,
      [fixture.contactId, fixture.agentId]
    ), null, 'la oferta insertada antes del conflicto debe revertirse con la transacción')

    const finalCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `after-stale-offer-${fixture.suffix}`
    })
    finalCtx.appointmentOfferDecision = null
    finalCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: finalCtx,
      config: fixture.config
    })
    assert.equal(finalCtx.appointmentSelectionProgress?.selectedDate, fixture.secondDate)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('una oferta individual concurrente gana autoridad y un turno viejo no puede revivir la fecha parcial', async () => {
  const fixture = await createFixture('offer_beats_stale_options')
  try {
    await selectDate(fixture, fixture.firstDate)

    const staleOptionsCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `stale-options-${fixture.suffix}`
    })
    staleOptionsCtx.appointmentOfferDecision = null
    staleOptionsCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: staleOptionsCtx,
      config: fixture.config
    })
    const staleAvailability = await toolNamed(staleOptionsCtx, 'get_free_slots').invoke(
      null,
      JSON.stringify(freeSlotsInput(fixture.firstDate))
    )
    assert.ok(staleAvailability.total > 1, JSON.stringify(staleAvailability))

    const offerCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `winning-offer-${fixture.suffix}`
    })
    offerCtx.appointmentOfferDecision = null
    offerCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: offerCtx,
      config: fixture.config
    })
    const exact = await toolNamed(offerCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.firstDate, { earliestLocalTime: '16:00', latestLocalTime: '16:00' })
    ))
    assert.equal(exact.total, 1, JSON.stringify(exact))
    const offered = await toolNamed(offerCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: exact.slots[0].options[0].startTime,
      appointmentId: null
    }))
    assert.equal(offered.ok, true, JSON.stringify(offered))

    const referencesBefore = Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_availability_options_presented'`,
      [fixture.contactId, fixture.agentId]
    )).total)
    const staleResult = await toolNamed(staleOptionsCtx, 'offer_appointment_options').invoke(null, JSON.stringify({
      maxDays: 1,
      selectionMode: 'collecting_time',
      selectedLocalDate: fixture.firstDate
    }))
    assert.equal(staleResult.ok, false, JSON.stringify(staleResult))
    assert.equal(staleResult.terminal, true)
    assert.equal(staleResult.code, 'appointment_preview_offer_pending_decision')
    assert.match(staleResult.visibleReply, /¿te funciona\?/i)
    assert.equal(
      Number((await db.get(
        `SELECT COUNT(*) AS total FROM conversational_agent_events
         WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_availability_options_presented'`,
        [fixture.contactId, fixture.agentId]
      )).total),
      referencesBefore,
      'el turno viejo debe revertir también su referencia informativa'
    )
    const progress = JSON.parse((await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_selection_progress'`,
      [fixture.contactId, fixture.agentId]
    )).detail_json)
    assert.equal(progress.appointmentStatus, 'superseded')
    assert.equal(progress.selectedDate, fixture.firstDate)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('una versión desconocida del estado parcial falla cerrado y no la pisa una instancia vieja', async () => {
  const fixture = await createFixture('future_progress_schema')
  try {
    await selectDate(fixture, fixture.firstDate)
    const row = await db.get(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_selection_progress'`,
      [fixture.contactId, fixture.agentId]
    )
    const futureDetail = { ...JSON.parse(row.detail_json), schemaVersion: 99 }
    const futureJson = JSON.stringify(futureDetail)
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
      [futureJson, row.id, row.detail_json]
    )

    const oldRuntimeCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `old-runtime-${fixture.suffix}`
    })
    oldRuntimeCtx.appointmentOfferDecision = null
    oldRuntimeCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: oldRuntimeCtx,
      config: fixture.config
    })
    assert.equal(oldRuntimeCtx.appointmentSelectionProgress, null)
    assert.equal((await db.get('SELECT detail_json FROM conversational_agent_events WHERE id = ?', [row.id])).detail_json, futureJson)

    const availability = await toolNamed(oldRuntimeCtx, 'get_free_slots').invoke(
      null,
      JSON.stringify(freeSlotsInput(fixture.secondDate))
    )
    assert.ok(availability.total > 1, JSON.stringify(availability))
    const overwrite = await toolNamed(oldRuntimeCtx, 'offer_appointment_options').invoke(null, JSON.stringify({
      maxDays: 1,
      selectionMode: 'collecting_time',
      selectedLocalDate: fixture.secondDate
    }))
    assert.equal(overwrite.ok, false, JSON.stringify(overwrite))
    assert.equal(overwrite.terminal, true)
    assert.equal((await db.get('SELECT detail_json FROM conversational_agent_events WHERE id = ?', [row.id])).detail_json, futureJson)

    const parallelOffer = await toolNamed(oldRuntimeCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: availability.slots[0].options[0].startTime,
      appointmentId: null
    }))
    assert.equal(parallelOffer.ok, false, JSON.stringify(parallelOffer))
    assert.equal(parallelOffer.terminal, true)
    assert.equal(parallelOffer.code, 'appointment_progress_state_conflict')
    assert.equal((await db.get('SELECT detail_json FROM conversational_agent_events WHERE id = ?', [row.id])).detail_json, futureJson)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('una reagenda parcial se invalida si la cita objetivo deja de estar activa', async () => {
  const fixture = await createFixture('reschedule_target_invalidated')
  const appointmentId = `appointment_${fixture.suffix}`
  try {
    const originalStart = DateTime.fromISO(`${fixture.firstDate}T12:00:00`, { zone: fixture.timezone })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto de reagenda invalidada', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [fixture.contactId]
    )
    await db.run(
      `INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status,
        start_time, end_time, source, sync_status, date_added, date_updated
      ) VALUES (?, ?, ?, 'Cita que se cancela', 'confirmed', 'confirmed', ?, ?, 'ristak', 'synced', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        appointmentId,
        fixture.calendarId,
        fixture.contactId,
        originalStart.toUTC().toISO(),
        originalStart.plus({ hours: 1 }).toUTC().toISO()
      ]
    )
    const ctx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `select-reschedule-${fixture.suffix}`
    })
    ctx.appointmentOfferDecision = null
    ctx.appointmentSelectionProgress = null
    const availability = await toolNamed(ctx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.secondDate, { appointmentId })
    ))
    assert.ok(availability.total > 1, JSON.stringify(availability))
    const selected = await toolNamed(ctx, 'offer_appointment_options').invoke(null, JSON.stringify({
      maxDays: 1,
      selectionMode: 'collecting_time',
      selectedLocalDate: fixture.secondDate
    }))
    assert.equal(selected.ok, true, JSON.stringify(selected))

    await db.run(
      `UPDATE appointments SET status = 'cancelled', appointment_status = 'cancelled' WHERE id = ?`,
      [appointmentId]
    )
    const afterCancellationCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `after-cancel-${fixture.suffix}`
    })
    afterCancellationCtx.appointmentOfferDecision = null
    assert.equal(await loadConversationalAppointmentSelectionProgressContext({
      ctx: afterCancellationCtx,
      config: fixture.config
    }), null)
    const invalidated = JSON.parse((await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_selection_progress'`,
      [fixture.contactId, fixture.agentId]
    )).detail_json)
    assert.equal(invalidated.appointmentStatus, 'superseded')
    assert.equal(invalidated.invalidationReason, 'reschedule_target_changed')
  } finally {
    await cleanupFixture(fixture)
    await db.run('DELETE FROM contacts WHERE id = ?', [fixture.contactId]).catch(() => {})
  }
})

test('una reagenda parcial se invalida si el calendario deja de permitir reagendas', async () => {
  const fixture = await createFixture('reschedule_permission_invalidated')
  const appointmentId = `appointment_${fixture.suffix}`
  try {
    const originalStart = DateTime.fromISO(`${fixture.firstDate}T12:00:00`, { zone: fixture.timezone })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto de permiso invalidado', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [fixture.contactId]
    )
    await db.run(
      `INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status,
        start_time, end_time, source, sync_status, date_added, date_updated
      ) VALUES (?, ?, ?, 'Cita con permiso mutable', 'confirmed', 'confirmed', ?, ?, 'ristak', 'synced', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        appointmentId,
        fixture.calendarId,
        fixture.contactId,
        originalStart.toUTC().toISO(),
        originalStart.plus({ hours: 1 }).toUTC().toISO()
      ]
    )
    const ctx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `select-reschedule-permission-${fixture.suffix}`
    })
    ctx.appointmentOfferDecision = null
    ctx.appointmentSelectionProgress = null
    const availability = await toolNamed(ctx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.secondDate, { appointmentId })
    ))
    assert.ok(availability.total > 1, JSON.stringify(availability))
    assert.equal((await toolNamed(ctx, 'offer_appointment_options').invoke(null, JSON.stringify({
      maxDays: 1,
      selectionMode: 'collecting_time',
      selectedLocalDate: fixture.secondDate
    }))).ok, true)

    await db.run('UPDATE calendars SET allow_reschedule = 0 WHERE id = ?', [fixture.calendarId])
    const disabledCtx = previewContext({
      config: fixture.config,
      contactId: fixture.contactId,
      scopeId: fixture.scopeId,
      executionId: `permission-disabled-${fixture.suffix}`
    })
    disabledCtx.appointmentOfferDecision = null
    assert.equal(await loadConversationalAppointmentSelectionProgressContext({
      ctx: disabledCtx,
      config: fixture.config
    }), null)
    const invalidated = JSON.parse((await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_selection_progress'`,
      [fixture.contactId, fixture.agentId]
    )).detail_json)
    assert.equal(invalidated.invalidationReason, 'reschedule_permission_changed')
  } finally {
    await cleanupFixture(fixture)
    await db.run('DELETE FROM contacts WHERE id = ?', [fixture.contactId]).catch(() => {})
  }
})
