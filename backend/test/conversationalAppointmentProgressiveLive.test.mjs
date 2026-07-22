import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

import { db, setAppConfig } from '../src/config/database.js'
import {
  createConversationalTools,
  loadConversationalAppointmentOfferDecisionContext,
  loadConversationalAppointmentSelectionProgressContext,
  setNativeAppointmentAfterPreCommitAuthorityHookForTest,
  setNativeAppointmentBeforeResolverTerminalHookForTest,
  setNativeAppointmentCreateControllerInvokeHookForTest,
  setNativeAppointmentRuntimeAgentLookupHookForTest,
  supersedeUndeliveredConversationalAppointmentOffer
} from '../src/agents/conversational/tools.js'
import { upsertLocalCalendar } from '../src/services/localCalendarService.js'
import {
  assignAgentToConversation,
  claimConversationInboundMessage,
  completeConversationInboundMessage,
  checkpointConversationalReplyDelivery,
  claimConversationalReplyDelivery,
  getOrCreateConversationalReplyDeliveryPlan,
  settleConversationalReplyDelivery
} from '../src/services/conversationalAgentService.js'
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

function appointmentDepositCapability() {
  return {
    id: 'collect_payment',
    enabled: true,
    chargeType: 'deposit',
    paymentMode: 'deposit',
    collectionMethod: 'bank_transfer',
    bankTransfer: { details: 'Datos bancarios de prueba' },
    deposit: {
      enabled: true,
      mode: 'fixed',
      amount: 500,
      currency: 'MXN',
      methods: { bankTransfer: true }
    }
  }
}

async function setFixtureDepositRequirement(fixture, enabled) {
  const nextConfig = structuredClone(fixture.config)
  nextConfig.capabilitiesConfig.items = nextConfig.capabilitiesConfig.items
    .filter((item) => item.id !== 'collect_payment')
  if (enabled) nextConfig.capabilitiesConfig.items.push(appointmentDepositCapability())
  fixture.config = nextConfig
  await db.run(
    'UPDATE conversational_agents SET capabilities_config = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [JSON.stringify(nextConfig.capabilitiesConfig), fixture.agentId]
  )
  return nextConfig
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
  await db.run('DELETE FROM chat_inbound_message_claims WHERE contact_id = ?', [fixture.contactId]).catch(() => {})
  await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [fixture.contactId]).catch(() => {})
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

async function offerExactTime(
  fixture,
  localTime,
  executionId = `offer-time-${fixture.suffix}`,
  selectionContext = 'selected_from_options'
) {
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
    appointmentId: null,
    selectionContext
  }))
  assert.equal(offered.ok, true, JSON.stringify(offered))
  assert.equal(offered.actionCompleted, true)
  assert.equal(offered.simulated, undefined)
  const expectedOpening = {
    selected_from_options: 'Perfecto, elegiste el ',
    exact_preference: 'Sí, el horario que me pediste está disponible: ',
    replacement: 'Va, la nueva opción sería el ',
    neutral: 'Perfecto, entonces sería el '
  }[selectionContext]
  assert.match(offered.visibleReply, new RegExp(`^${expectedOpening.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  const depositRequired = fixture.config.capabilitiesConfig.items.some((item) => (
    item.id === 'collect_payment' &&
    item.enabled !== false &&
    (item.paymentMode === 'deposit' || item.deposit?.enabled === true)
  ))
  assert.match(
    offered.visibleReply,
    depositRequired
      ? /¿Confirmas que sigamos con el anticipo para ese horario\?$/
      : /¿Confirmas que te agende en ese horario\?$/
  )
  return { ctx, availability, offered, startTime }
}

async function createOfferReplyDelivery({
  fixture,
  sourceMessageId,
  reply,
  status = 'completed',
  identity = {},
  providerMessageId = `provider-offer-${fixture.suffix}`
} = {}) {
  const planIdentity = {
    contactId: fixture.contactId,
    agentId: fixture.agentId,
    channel: 'whatsapp',
    sourceMessageId,
    externalIdPrefix: 'convagent',
    ...identity
  }
  const created = await getOrCreateConversationalReplyDeliveryPlan(planIdentity, {
    reply,
    parts: [reply],
    delaySchedule: [0],
    splitterMeta: { source: 'structured_offer', reason: 'server_single_message' }
  })
  if (status === 'pending') return created.plan

  const claim = await claimConversationalReplyDelivery(created.plan.id)
  assert.equal(claim.claimed, true, JSON.stringify(claim))
  if (status === 'interrupted') {
    return (await settleConversationalReplyDelivery(created.plan.id, claim.claimToken, {
      status: 'interrupted',
      interruptedByMessageId: `newer-${fixture.suffix}`
    })).plan
  }

  await checkpointConversationalReplyDelivery(created.plan.id, claim.claimToken, {
    partIndex: 0,
    status: 'sending'
  })
  if (status === 'ambiguous') {
    return (await settleConversationalReplyDelivery(created.plan.id, claim.claimToken, {
      status: 'pending',
      error: 'simulated_unknown_provider_result'
    })).plan
  }
  await checkpointConversationalReplyDelivery(created.plan.id, claim.claimToken, {
    partIndex: 0,
    status: 'sent',
    providerMessageId
  })
  return (await settleConversationalReplyDelivery(created.plan.id, claim.claimToken, {
    status: 'completed'
  })).plan
}

async function mutateReplyDeliveryPlan(planId, mutate) {
  const row = await db.get(
    'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
    [planId]
  )
  assert.ok(row?.detail_json, `Falta el plan durable ${planId}`)
  const detail = JSON.parse(row.detail_json)
  const nextDetail = mutate(detail)
  await db.run(
    'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
    [JSON.stringify(nextDetail), planId, row.detail_json]
  )
}

async function truncatedLedgerConfirmationContext(fixture, executionId) {
  const ctx = liveContext({
    fixture,
    executionId,
    messages: [{ id: executionId, role: 'user', content: 'sí, confirmamos' }]
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
  return ctx
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

async function prepareLiveAppointmentConfirmation(fixture, localTime = '16:00') {
  await selectDate(fixture)
  const exact = await offerExactTime(fixture, localTime)
  const confirmation = await confirmationContext(
    fixture,
    exact.offered,
    `confirm-retry-${fixture.suffix}`
  )
  return {
    exact,
    confirmation,
    resolver: toolNamed(confirmation, 'resolve_active_appointment_offer')
  }
}

function singleBookAppointmentAction(ctx) {
  const actions = (ctx.actions || []).filter((action) => action.type === 'book_appointment')
  assert.equal(actions.length, 1, JSON.stringify(ctx.actions))
  return actions[0]
}

async function appointmentCount(fixture) {
  return Number((await db.get(
    'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
    [fixture.calendarId, fixture.contactId]
  )).total)
}

async function insertLiveInbound(fixture, id, text, timestamp, messageType = 'text') {
  await db.run(
    `INSERT INTO whatsapp_api_messages (
       id, contact_id, direction, message_type, message_text, transport,
       message_timestamp, created_at, updated_at
     ) VALUES (?, ?, 'inbound', ?, ?, 'ycloud', ?, ?, CURRENT_TIMESTAMP)`,
    [id, fixture.contactId, messageType, text, timestamp, timestamp]
  )
}

async function insertLiveInboundAuthorityClaim(fixture, id, messageTimestamp, claimedAt) {
  await db.run(
    `INSERT INTO chat_inbound_message_claims (
       channel, message_id, contact_id, message_timestamp, claimed_at
     ) VALUES ('whatsapp', ?, ?, ?, ?)
     ON CONFLICT(channel, message_id) DO UPDATE SET
       contact_id = excluded.contact_id,
       message_timestamp = excluded.message_timestamp,
       claimed_at = excluded.claimed_at`,
    [id, fixture.contactId, messageTimestamp, claimedAt]
  )
}

test('live: el copy v2 enlaza la oferta con el hilo y un replay conserva el primer texto durable', async () => {
  const cases = [
    ['selected_from_options', '11:00'],
    ['exact_preference', '12:00'],
    ['replacement', '13:00'],
    ['neutral', '14:00']
  ]

  for (const [selectionContext, localTime] of cases) {
    const fixture = await createFixture(`copy_context_${selectionContext}`)
    try {
      await selectDate(fixture)
      const exact = await offerExactTime(
        fixture,
        localTime,
        `offer-context-${selectionContext}-${fixture.suffix}`,
        selectionContext
      )
      const row = await db.get(
        `SELECT id, detail_json FROM conversational_agent_events
         WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
        [fixture.contactId, fixture.agentId]
      )
      const detail = JSON.parse(row.detail_json)
      assert.equal(detail.offerCopyVersion, 2)
      assert.equal(detail.selectionContext, selectionContext)
      assert.equal(detail.depositRequiredAtOffer, false)
      assert.equal(detail.offerText, exact.offered.visibleReply)
      assert.equal(detail.startTime, exact.startTime)

      if (selectionContext === 'selected_from_options') {
        const replay = await toolNamed(exact.ctx, 'offer_appointment_slot').invoke(null, JSON.stringify({
          startTime: exact.startTime,
          appointmentId: null,
          selectionContext: 'replacement'
        }))
        assert.equal(replay.ok, true, JSON.stringify(replay))
        assert.equal(replay.visibleReply, exact.offered.visibleReply)
        assert.match(replay.visibleReply, /^Perfecto, elegiste el /)
        assert.equal(Number((await db.get(
          `SELECT COUNT(*) AS total FROM conversational_agent_events
           WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
          [fixture.contactId, fixture.agentId]
        )).total), 1)
      }
    } finally {
      await cleanupFixture(fixture)
    }
  }
})

test('live: un copy v2 adulterado o de versión desconocida falla cerrado', async () => {
  const cases = [
    [
      'context_mismatch',
      (detail) => ({ ...detail, selectionContext: 'replacement' }),
      'legacy_offer_contract_invalid'
    ],
    [
      'unknown_version',
      (detail) => ({ ...detail, offerCopyVersion: 99 }),
      'legacy_offer_contract_invalid'
    ],
    [
      'offer_text_changed',
      (detail) => ({ ...detail, offerText: `${detail.offerText} alterado` }),
      'legacy_offer_contract_invalid'
    ],
    ['deposit_snapshot_changed', (detail) => ({
      ...detail,
      depositRequiredAtOffer: !detail.depositRequiredAtOffer
    }), 'appointment_deposit_requirement_changed'],
    [
      'booking_owner_changed',
      (detail) => ({ ...detail, bookingOwner: 'human' }),
      'legacy_offer_contract_invalid'
    ],
    ['terminal_binding_changed', (detail) => ({
      ...detail,
      bookingOwner: 'human',
      terminalToolName: 'request_human_booking'
    }), 'booking_owner_changed']
  ]

  for (const [label, mutate, expectedResolution] of cases) {
    const fixture = await createFixture(`copy_contract_${label}`)
    try {
      await selectDate(fixture)
      const exact = await offerExactTime(fixture, '15:00')
      const row = await db.get(
        `SELECT id, detail_json FROM conversational_agent_events
         WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
        [fixture.contactId, fixture.agentId]
      )
      const detail = JSON.parse(row.detail_json)
      await db.run(
        'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
        [JSON.stringify(mutate(detail)), row.id, row.detail_json]
      )

      const ctx = liveContext({
        fixture,
        executionId: `confirm-tampered-${label}-${fixture.suffix}`,
        messages: [
          { id: `assistant-tampered-${label}-${fixture.suffix}`, role: 'assistant', content: exact.offered.visibleReply },
          { id: `confirm-tampered-${label}-${fixture.suffix}`, role: 'user', content: 'sí' }
        ]
      })
      ctx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
        ctx,
        config: fixture.config
      })
      assert.equal(ctx.appointmentOfferDecision, null)
      const closed = JSON.parse((await db.get(
        'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
        [row.id]
      )).detail_json)
      assert.equal(closed.status, 'superseded')
      assert.equal(closed.resolution, expectedResolution)
      assert.equal(await appointmentCount(fixture), 0)
    } finally {
      await cleanupFixture(fixture)
    }
  }
})

test('live: prender o apagar el anticipo después de ofrecer invalida la promesa y no crea cita', async () => {
  for (const scenario of [
    { label: 'off_to_on', requiredAtOffer: false, requiredAtConfirmation: true },
    { label: 'on_to_off', requiredAtOffer: true, requiredAtConfirmation: false }
  ]) {
    const fixture = await createFixture(`deposit_requirement_${scenario.label}`)
    try {
      await setFixtureDepositRequirement(fixture, scenario.requiredAtOffer)
      await selectDate(fixture)
      const exact = await offerExactTime(fixture, '15:00')
      const offeredRow = await db.get(
        `SELECT id, detail_json FROM conversational_agent_events
         WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
        [fixture.contactId, fixture.agentId]
      )
      const offeredDetail = JSON.parse(offeredRow.detail_json)
      assert.equal(offeredDetail.offerCopyVersion, 2)
      assert.equal(offeredDetail.depositRequiredAtOffer, scenario.requiredAtOffer)
      assert.equal(offeredDetail.offerText, exact.offered.visibleReply)

      await setFixtureDepositRequirement(fixture, scenario.requiredAtConfirmation)
      const confirmationExecutionId = `confirm-deposit-${scenario.label}-${fixture.suffix}`
      const confirmation = liveContext({
        fixture,
        executionId: confirmationExecutionId,
        messages: [
          { id: exact.ctx.executionId, role: 'user', content: 'ese horario me interesa' },
          { id: `assistant-deposit-${scenario.label}-${fixture.suffix}`, role: 'assistant', content: exact.offered.visibleReply },
          { id: confirmationExecutionId, role: 'user', content: 'sí, confirma' }
        ]
      })
      confirmation.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
        ctx: confirmation,
        config: fixture.config
      })

      assert.equal(confirmation.appointmentOfferDecision, null)
      assert.equal(
        createConversationalTools(confirmation).some((item) => item.name === 'resolve_active_appointment_offer'),
        false
      )
      const invalidated = JSON.parse((await db.get(
        'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
        [offeredRow.id]
      )).detail_json)
      assert.equal(invalidated.status, 'superseded')
      assert.equal(invalidated.resolution, 'appointment_deposit_requirement_changed')
      assert.equal(invalidated.depositRequiredAtOffer, scenario.requiredAtOffer)
      assert.equal(await appointmentCount(fixture), 0)
    } finally {
      await cleanupFixture(fixture)
    }
  }
})

test('live: una duda lateral preserva la oferta v2 y un “sí” posterior crea exactamente una cita', async () => {
  const fixture = await createFixture('preserve_side_question_then_accept')
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '16:00')
    const sideQuestionExecutionId = `location-question-${fixture.suffix}`
    const sideMessages = [
      { id: exact.ctx.executionId, role: 'user', content: 'me interesa ese horario' },
      { id: `assistant-offer-before-location-${fixture.suffix}`, role: 'assistant', content: exact.offered.visibleReply },
      { id: sideQuestionExecutionId, role: 'user', content: 'antes, ¿dónde están ubicados?' }
    ]
    const sideQuestion = liveContext({
      fixture,
      executionId: sideQuestionExecutionId,
      messages: sideMessages
    })
    sideQuestion.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: sideQuestion,
      config: fixture.config
    })
    assert.equal(sideQuestion.appointmentOfferDecision?.active, true)
    const offerRowBeforePreserve = await db.get(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
      [fixture.contactId, fixture.agentId]
    )

    const preserved = await toolNamed(sideQuestion, 'resolve_active_appointment_offer').invoke(
      null,
      JSON.stringify({ ...acceptOfferInput(), decision: 'preserve' })
    )
    assert.equal(preserved.ok, true, JSON.stringify(preserved))
    assert.equal(preserved.terminal, false)
    assert.equal(preserved.appointmentOfferPreserved, true)
    assert.equal(await appointmentCount(fixture), 0)
    assert.equal(
      (await db.get(
        'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
        [offerRowBeforePreserve.id]
      )).detail_json,
      offerRowBeforePreserve.detail_json,
      'preserve no debe reescribir ni cerrar la oferta'
    )

    const confirmationExecutionId = `confirm-after-location-${fixture.suffix}`
    const confirmation = liveContext({
      fixture,
      executionId: confirmationExecutionId,
      messages: [
        ...sideMessages,
        {
          id: `assistant-location-${fixture.suffix}`,
          role: 'assistant',
          content: 'Estamos en Hospital San Miguel, Coahuila 216, Morelia.'
        },
        { id: confirmationExecutionId, role: 'user', content: 'gracias, sí, confirma ese horario' }
      ]
    })
    confirmation.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: confirmation,
      config: fixture.config
    })
    assert.equal(confirmation.appointmentOfferDecision?.active, true)
    const confirmed = await toolNamed(confirmation, 'resolve_active_appointment_offer').invoke(
      null,
      JSON.stringify(acceptOfferInput())
    )
    collectClientRequestIds(fixture, confirmation)

    assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
    assert.equal(confirmed.actionCompleted, true)
    assert.match(confirmed.visibleReply, /cita quedó confirmada/i)
    assert.equal(await appointmentCount(fixture), 1)
    const appointment = await db.get(
      'SELECT start_time FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )
    assert.equal(new Date(appointment.start_time).toISOString(), exact.startTime)
  } finally {
    await cleanupFixture(fixture)
  }
})

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
    const confirmedLocalLabel = confirmation.appointmentOfferDecision.localLabel
    const confirmed = await resolver.invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, confirmation)

    assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
    assert.equal(confirmed.actionCompleted, true)
    assert.equal(confirmed.simulated, undefined)
    assert.match(confirmed.visibleReply, /cita quedó confirmada/i)
    assert.match(confirmed.visibleReply, new RegExp(confirmedLocalLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
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

test('live: “sí” seguido de “mejor a las 3” antes del commit frena las 4 y procesa la hora nueva', async () => {
  const fixture = await createFixture('newer_inbound_terminal_fence')
  const initialConfirmationId = `confirm-old-${fixture.suffix}`
  const newerPreferenceId = `prefer-new-${fixture.suffix}`
  const finalConfirmationId = `confirm-new-${fixture.suffix}`
  const baseTimestampMs = Date.now() + 10_000
  try {
    await selectDate(fixture)
    const original = await offerExactTime(fixture, '16:00')
    const initialConfirmation = await confirmationContext(
      fixture,
      original.offered,
      initialConfirmationId
    )
    await insertLiveInbound(
      fixture,
      initialConfirmationId,
      'sí, confirmamos',
      new Date(baseTimestampMs).toISOString()
    )
    await assignAgentToConversation(fixture.contactId, fixture.agentId, {
      channel: 'whatsapp',
      updatedBy: 'agent'
    })
    const initialClaim = await claimConversationInboundMessage(
      fixture.contactId,
      initialConfirmationId,
      { agentId: fixture.agentId, channel: 'whatsapp' }
    )
    assert.equal(initialClaim.claimed, true, JSON.stringify(initialClaim))
    initialConfirmation.inboundClaim = {
      messageId: initialConfirmationId,
      claimToken: initialClaim.claimToken
    }

    let hookCalls = 0
    setNativeAppointmentAfterPreCommitAuthorityHookForTest(async ({ terminalToolName, purpose }) => {
      hookCalls += 1
      assert.equal(terminalToolName, 'book_appointment')
      assert.equal(purpose, 'book')
      await insertLiveInbound(
        fixture,
        newerPreferenceId,
        'mejor a las 3',
        new Date(baseTimestampMs + 1_000).toISOString()
      )
    })

    const rejectedOldCommit = await toolNamed(initialConfirmation, 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, initialConfirmation)

    assert.equal(hookCalls, 1)
    assert.equal(rejectedOldCommit.ok, false, JSON.stringify(rejectedOldCommit))
    assert.equal(rejectedOldCommit.code, 'appointment_request_superseded_by_newer_inbound')
    assert.equal(rejectedOldCommit.appointmentOfferInvalidated, true)
    assert.equal(rejectedOldCommit.appointmentOfferRestoreSameDate, true)
    assert.equal(await appointmentCount(fixture), 0)

    const supersededOffer = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'
       ORDER BY created_at DESC LIMIT 1`,
      [fixture.contactId, fixture.agentId]
    )
    const supersededDetail = JSON.parse(supersededOffer?.detail_json || '{}')
    assert.equal(supersededDetail.status, 'superseded')
    assert.equal(supersededDetail.resolution, 'newer_inbound_preempted_terminal_commit')

    setNativeAppointmentAfterPreCommitAuthorityHookForTest(null)
    const initialCompleted = await completeConversationInboundMessage(
      fixture.contactId,
      initialConfirmationId,
      {
        agentId: fixture.agentId,
        channel: 'whatsapp',
        claimToken: initialClaim.claimToken,
        answered: false
      }
    )
    assert.equal(initialCompleted.completed, true)
    const newerClaim = await claimConversationInboundMessage(
      fixture.contactId,
      newerPreferenceId,
      { agentId: fixture.agentId, channel: 'whatsapp' }
    )
    assert.equal(newerClaim.claimed, true, JSON.stringify(newerClaim))
    const changed = await offerExactTime(fixture, '15:00', newerPreferenceId)
    assert.notEqual(changed.startTime, original.startTime)
    const newerCompleted = await completeConversationInboundMessage(
      fixture.contactId,
      newerPreferenceId,
      {
        agentId: fixture.agentId,
        channel: 'whatsapp',
        claimToken: newerClaim.claimToken,
        answered: true
      }
    )
    assert.equal(newerCompleted.completed, true)
    await insertLiveInbound(
      fixture,
      finalConfirmationId,
      'sí, ahora sí',
      new Date(baseTimestampMs + 2_000).toISOString()
    )
    const finalConfirmation = await confirmationContext(
      fixture,
      changed.offered,
      finalConfirmationId
    )
    const finalClaim = await claimConversationInboundMessage(
      fixture.contactId,
      finalConfirmationId,
      { agentId: fixture.agentId, channel: 'whatsapp' }
    )
    assert.equal(finalClaim.claimed, true, JSON.stringify(finalClaim))
    finalConfirmation.inboundClaim = {
      messageId: finalConfirmationId,
      claimToken: finalClaim.claimToken
    }
    const confirmedNewTime = await toolNamed(finalConfirmation, 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, finalConfirmation)

    assert.equal(confirmedNewTime.ok, true, JSON.stringify(confirmedNewTime))
    assert.equal(await appointmentCount(fixture), 1)
    const appointment = await db.get(
      'SELECT start_time FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )
    assert.equal(new Date(appointment.start_time).toISOString(), changed.startTime)
  } finally {
    setNativeAppointmentAfterPreCommitAuthorityHookForTest(null)
    await cleanupFixture(fixture)
  }
})

test('live: una corrección persistida después gana aunque comparta timestamp y su ID ordene antes que la confirmación', async () => {
  const fixture = await createFixture('same_timestamp_newer_inbound_fence')
  const confirmationId = `z-confirm-${fixture.suffix}`
  const correctionId = `a-correction-${fixture.suffix}`
  const providerTimestamp = new Date(Date.now() + 10_000).toISOString()
  const firstClaimedAt = new Date(Date.now() + 20_000).toISOString()
  const correctionClaimedAt = new Date(Date.parse(firstClaimedAt) + 1).toISOString()
  try {
    await selectDate(fixture)
    const original = await offerExactTime(fixture, '16:00')
    const confirmation = await confirmationContext(
      fixture,
      original.offered,
      confirmationId
    )
    await insertLiveInbound(fixture, confirmationId, 'sí, confirmamos', providerTimestamp)
    await insertLiveInboundAuthorityClaim(
      fixture,
      confirmationId,
      providerTimestamp,
      firstClaimedAt
    )
    await assignAgentToConversation(fixture.contactId, fixture.agentId, {
      channel: 'whatsapp',
      updatedBy: 'agent'
    })
    const claim = await claimConversationInboundMessage(fixture.contactId, confirmationId, {
      agentId: fixture.agentId,
      channel: 'whatsapp'
    })
    assert.equal(claim.claimed, true, JSON.stringify(claim))
    confirmation.inboundClaim = {
      messageId: confirmationId,
      claimToken: claim.claimToken
    }

    setNativeAppointmentAfterPreCommitAuthorityHookForTest(async () => {
      await insertLiveInbound(
        fixture,
        correctionId,
        'mejor a las 3',
        providerTimestamp
      )
      await insertLiveInboundAuthorityClaim(
        fixture,
        correctionId,
        providerTimestamp,
        correctionClaimedAt
      )
    })

    const rejected = await toolNamed(confirmation, 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, confirmation)

    assert.equal(rejected.ok, false, JSON.stringify(rejected))
    assert.equal(rejected.code, 'appointment_request_superseded_by_newer_inbound')
    assert.equal(rejected.appointmentOfferInvalidated, true)
    assert.equal(await appointmentCount(fixture), 0)
  } finally {
    setNativeAppointmentAfterPreCommitAuthorityHookForTest(null)
    await cleanupFixture(fixture)
  }
})

test('live: una reacción llegada durante el commit no cancela la confirmación sustantiva', async () => {
  const fixture = await createFixture('reaction_does_not_preempt_terminal')
  const confirmationId = `confirm-reaction-${fixture.suffix}`
  const timestampMs = Date.now() + 20_000
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '14:00')
    const confirmation = await confirmationContext(fixture, exact.offered, confirmationId)
    await insertLiveInbound(
      fixture,
      confirmationId,
      'sí',
      new Date(timestampMs).toISOString()
    )
    setNativeAppointmentAfterPreCommitAuthorityHookForTest(async () => {
      await insertLiveInbound(
        fixture,
        `reaction-${fixture.suffix}`,
        '👍',
        new Date(timestampMs + 1_000).toISOString(),
        'reaction'
      )
    })

    const confirmed = await toolNamed(confirmation, 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, confirmation)
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
    assert.equal(await appointmentCount(fixture), 1)
    const appointment = await db.get(
      'SELECT start_time FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )
    assert.equal(new Date(appointment.start_time).toISOString(), exact.startTime)
  } finally {
    setNativeAppointmentAfterPreCommitAuthorityHookForTest(null)
    await cleanupFixture(fixture)
  }
})

test('live: un claim de inbound perdido bloquea la creación aunque la oferta siga vigente', async () => {
  const fixture = await createFixture('lost_inbound_claim_blocks_terminal')
  const confirmationId = `confirm-lost-claim-${fixture.suffix}`
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '13:00')
    const confirmation = await confirmationContext(fixture, exact.offered, confirmationId)
    await insertLiveInbound(fixture, confirmationId, 'sí', new Date().toISOString())
    await assignAgentToConversation(fixture.contactId, fixture.agentId, {
      channel: 'whatsapp',
      updatedBy: 'agent'
    })
    const claim = await claimConversationInboundMessage(fixture.contactId, confirmationId, {
      agentId: fixture.agentId,
      channel: 'whatsapp'
    })
    assert.equal(claim.claimed, true, JSON.stringify(claim))
    confirmation.inboundClaim = {
      messageId: confirmationId,
      claimToken: `${claim.claimToken}-stale`
    }

    const rejected = await toolNamed(confirmation, 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, confirmation)
    assert.equal(rejected.ok, false, JSON.stringify(rejected))
    assert.equal(rejected.code, 'appointment_request_authority_lost')
    assert.equal(rejected.appointmentOfferInvalidated, true)
    assert.equal(await appointmentCount(fixture), 0)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('live: un inbound con claim vigente pero sin fila canónica falla cerrado', async () => {
  const fixture = await createFixture('claimed_inbound_missing_canonical_row')
  const confirmationId = `confirm-missing-row-${fixture.suffix}`
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '13:00')
    const confirmation = await confirmationContext(fixture, exact.offered, confirmationId)
    await insertLiveInbound(fixture, confirmationId, 'sí', new Date().toISOString())
    await assignAgentToConversation(fixture.contactId, fixture.agentId, {
      channel: 'whatsapp',
      updatedBy: 'agent'
    })
    const claim = await claimConversationInboundMessage(fixture.contactId, confirmationId, {
      agentId: fixture.agentId,
      channel: 'whatsapp'
    })
    assert.equal(claim.claimed, true, JSON.stringify(claim))
    confirmation.inboundClaim = {
      messageId: confirmationId,
      claimToken: claim.claimToken
    }
    await db.run('DELETE FROM whatsapp_api_messages WHERE id = ? AND contact_id = ?', [
      confirmationId,
      fixture.contactId
    ])

    const rejected = await toolNamed(confirmation, 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, confirmation)
    assert.equal(rejected.ok, false, JSON.stringify(rejected))
    assert.equal(rejected.code, 'appointment_request_authority_lost')
    assert.equal(rejected.appointmentOfferInvalidated, true)
    assert.equal(rejected.appointmentOfferRestoreSameDate, true)
    assert.equal(await appointmentCount(fixture), 0)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('live: un replay canónico reprogramado no devuelve datos stale si ya llegó otra instrucción', async () => {
  const fixture = await createFixture('changed_replay_newer_inbound_fence')
  const confirmationId = `confirm-changed-replay-${fixture.suffix}`
  const baseTimestampMs = Date.now() + 10_000
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '16:00')
    const confirmation = await confirmationContext(fixture, exact.offered, confirmationId)
    const first = await toolNamed(confirmation, 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, confirmation)
    assert.equal(first.ok, true, JSON.stringify(first))
    const appointment = await db.get(
      `SELECT id, start_time, end_time FROM appointments
       WHERE calendar_id = ? AND contact_id = ?`,
      [fixture.calendarId, fixture.contactId]
    )
    const movedStart = new Date(Date.parse(appointment.start_time) + 7 * 24 * 60 * 60 * 1000).toISOString()
    const movedEnd = new Date(Date.parse(appointment.end_time) + 7 * 24 * 60 * 60 * 1000).toISOString()
    await db.run('UPDATE appointments SET start_time = ?, end_time = ? WHERE id = ?', [
      movedStart,
      movedEnd,
      appointment.id
    ])
    await db.run(
      `UPDATE conversational_agent_state
       SET status = 'active', signal = NULL,
           inbound_processing_message_id = NULL,
           inbound_processing_status = NULL,
           inbound_processing_claim_token = NULL,
           inbound_processing_lease_until_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      [fixture.contactId, fixture.agentId]
    )
    await insertLiveInbound(
      fixture,
      confirmationId,
      'sí',
      new Date(baseTimestampMs).toISOString()
    )
    const claim = await claimConversationInboundMessage(fixture.contactId, confirmationId, {
      agentId: fixture.agentId,
      channel: 'whatsapp'
    })
    assert.equal(claim.claimed, true, JSON.stringify(claim))
    confirmation.inboundClaim = { messageId: confirmationId, claimToken: claim.claimToken }
    await insertLiveInbound(
      fixture,
      `newer-changed-replay-${fixture.suffix}`,
      'mejor otra hora',
      new Date(baseTimestampMs + 1_000).toISOString()
    )

    const rejected = await toolNamed(confirmation, 'book_appointment').invoke(null, JSON.stringify({
      title: null,
      notes: null,
      attendeeName: null,
      attendeeContext: null,
      primaryAttendee: null,
      guests: []
    }))
    assert.equal(rejected.ok, false, JSON.stringify(rejected))
    assert.equal(rejected.code, 'appointment_request_superseded_by_newer_inbound')
    assert.equal(rejected.appointmentOfferInvalidated, true)
    assert.equal('existingAppointment' in rejected, false)
    assert.equal(await appointmentCount(fixture), 1)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('live: la recuperación de una cita existente cerca sync y depósito contra un inbound más nuevo', async () => {
  const fixture = await createFixture('existing_recovery_newer_inbound_fence')
  const recoveryConfirmationId = `confirm-existing-recovery-${fixture.suffix}`
  const newerInboundId = `newer-existing-recovery-${fixture.suffix}`
  const baseTimestampMs = Date.now() + 20_000
  try {
    const firstPrepared = await prepareLiveAppointmentConfirmation(fixture, '16:00')
    const first = await firstPrepared.resolver.invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, firstPrepared.confirmation)
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(await appointmentCount(fixture), 1)

    await db.run(
      `DELETE FROM conversational_agent_events
       WHERE contact_id = ? AND event_type IN ('appointment_booked', 'signal_set')`,
      [fixture.contactId]
    )
    await db.run(
      `UPDATE conversational_agent_state
       SET status = 'active', signal = NULL, signal_reason = NULL,
           signal_summary = NULL, signal_at = NULL,
           inbound_processing_message_id = NULL,
           inbound_processing_status = NULL,
           inbound_processing_claim_token = NULL,
           inbound_processing_lease_until_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      [fixture.contactId, fixture.agentId]
    )

    await selectDate(fixture, `select-existing-recovery-${fixture.suffix}`)
    const recoveryOffer = await offerExactTime(
      fixture,
      '15:00',
      `offer-existing-recovery-${fixture.suffix}`
    )
    const recoveryConfirmation = await confirmationContext(
      fixture,
      recoveryOffer.offered,
      recoveryConfirmationId
    )
    await insertLiveInbound(
      fixture,
      recoveryConfirmationId,
      'sí',
      new Date(baseTimestampMs).toISOString()
    )
    const claim = await claimConversationInboundMessage(fixture.contactId, recoveryConfirmationId, {
      agentId: fixture.agentId,
      channel: 'whatsapp'
    })
    assert.equal(claim.claimed, true, JSON.stringify(claim))
    recoveryConfirmation.inboundClaim = {
      messageId: recoveryConfirmationId,
      claimToken: claim.claimToken
    }
    setNativeAppointmentAfterPreCommitAuthorityHookForTest(async ({ appointmentId }) => {
      assert.ok(appointmentId)
      await insertLiveInbound(
        fixture,
        newerInboundId,
        'mejor otra hora',
        new Date(baseTimestampMs + 1_000).toISOString()
      )
    })

    const rejected = await toolNamed(recoveryConfirmation, 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, recoveryConfirmation)
    assert.equal(rejected.ok, false, JSON.stringify(rejected))
    assert.equal(rejected.code, 'appointment_request_superseded_by_newer_inbound')
    assert.equal(rejected.appointmentOfferInvalidated, true)
    assert.equal(await appointmentCount(fixture), 1)
    const state = await db.get(
      `SELECT status, signal FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      [fixture.contactId, fixture.agentId]
    )
    assert.equal(state.status, 'active')
    assert.equal(state.signal, null)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type IN ('appointment_booked', 'signal_set')`,
      [fixture.contactId]
    )).total), 0)
  } finally {
    setNativeAppointmentAfterPreCommitAuthorityHookForTest(null)
    await cleanupFixture(fixture)
  }
})

test('live retry: un 503 transitorio reintenta una vez con body, autoridad, fecha, hora y llave idénticos', async () => {
  const fixture = await createFixture('controller_retry_503_success')
  const calls = []
  try {
    const { exact, confirmation, resolver } = await prepareLiveAppointmentConfirmation(fixture)
    setNativeAppointmentCreateControllerInvokeHookForTest(async ({ attempt, body, internalContext, invoke }) => {
      calls.push({ attempt, body, internalContext })
      if (attempt === 1) {
        return {
          statusCode: 503,
          payload: { success: false, code: 'test_transient_503', error: 'Fallo transitorio de prueba' }
        }
      }
      return invoke()
    })

    const confirmed = await resolver.invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, confirmation)

    assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
    assert.equal(calls.length, 2)
    assert.strictEqual(calls[0].body, calls[1].body)
    assert.strictEqual(calls[0].internalContext, calls[1].internalContext)
    assert.strictEqual(
      calls[0].internalContext.conversationalAppointmentAuthorityFence,
      calls[1].internalContext.conversationalAppointmentAuthorityFence
    )
    assert.equal(Object.isFrozen(calls[0].body), true)
    assert.equal(Object.isFrozen(calls[0].body.participants), true)
    assert.equal(calls[0].body.calendarId, fixture.calendarId)
    assert.equal(calls[0].body.startTime, exact.startTime)
    assert.equal(calls[0].body.clientRequestId, calls[1].body.clientRequestId)
    assert.ok(calls[0].body.clientRequestId)
    assert.equal(await appointmentCount(fixture), 1)

    const action = singleBookAppointmentAction(confirmation)
    assert.equal(action.outcome.controllerAttempts, 2)
    assert.equal(action.outcome.retried, true)
    assert.equal(action.outcome.firstFailureCode, 'test_transient_503')

    const retryRows = await db.all(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_creation_retry'`,
      [fixture.contactId, fixture.agentId]
    )
    assert.equal(retryRows.length, 1)
    const retryDetail = JSON.parse(retryRows[0].detail_json)
    assert.deepEqual(Object.keys(retryDetail).sort(), [
      'agentId',
      'attempt',
      'calendarId',
      'code',
      'startTime',
      'statusCode'
    ])
    assert.equal(retryDetail.attempt, 2)
    assert.equal(retryDetail.statusCode, 503)
    assert.equal(retryDetail.code, 'test_transient_503')
    assert.equal(retryDetail.calendarId, fixture.calendarId)
    assert.equal(retryDetail.startTime, exact.startTime)
    assert.equal(JSON.stringify(retryDetail).includes(fixture.contactId), false)
    assert.equal(JSON.stringify(retryDetail).includes(calls[0].body.clientRequestId), false)

    const request = await db.get(
      `SELECT status, request_hash, appointment_id
       FROM appointment_creation_requests WHERE client_request_id = ?`,
      [calls[0].body.clientRequestId]
    )
    assert.equal(request?.status, 'completed')
    assert.ok(request?.request_hash)
    assert.ok(request?.appointment_id)
  } finally {
    setNativeAppointmentCreateControllerInvokeHookForTest(null)
    await cleanupFixture(fixture)
  }
})

test('live retry: una respuesta lenta que termina en timeout postcommit concluye antes del replay y conserva una sola cita', async () => {
  const fixture = await createFixture('controller_retry_postcommit_timeout')
  let calls = 0
  let committedAppointmentId = null
  let replayResponse = null
  let firstAttemptSettled = false
  try {
    const { confirmation, resolver } = await prepareLiveAppointmentConfirmation(fixture, '15:00')
    setNativeAppointmentCreateControllerInvokeHookForTest(async ({ attempt, invoke }) => {
      calls += 1
      if (attempt === 1) {
        const committed = await invoke()
        assert.equal(committed.statusCode, 201, JSON.stringify(committed))
        committedAppointmentId = committed.payload?.data?.id || null
        assert.ok(committedAppointmentId)
        await new Promise((resolve) => setTimeout(resolve, 150))
        firstAttemptSettled = true
        throw Object.assign(new Error('Respuesta perdida después del commit'), { code: 'ETIMEDOUT' })
      }
      assert.equal(firstAttemptSettled, true, 'el retry no puede solaparse con el primer intento')
      replayResponse = await invoke()
      return replayResponse
    })

    const confirmed = await resolver.invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, confirmation)

    assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
    assert.equal(calls, 2)
    assert.equal(replayResponse?.statusCode, 201)
    assert.equal(replayResponse?.payload?.data?.id, committedAppointmentId)
    assert.equal(await appointmentCount(fixture), 1)
    const action = singleBookAppointmentAction(confirmation)
    assert.equal(action.outcome.controllerAttempts, 2)
    assert.equal(action.outcome.retried, true)
    assert.equal(action.outcome.firstFailureCode, 'ETIMEDOUT')
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_booked'`,
      [fixture.contactId, fixture.agentId]
    )).total), 1)
  } finally {
    setNativeAppointmentCreateControllerInvokeHookForTest(null)
    await cleanupFixture(fixture)
  }
})

test('live retry: dos 503 hacen exactamente dos intentos y no crean una cita', async () => {
  const fixture = await createFixture('controller_retry_two_503')
  let calls = 0
  try {
    const { confirmation, resolver } = await prepareLiveAppointmentConfirmation(fixture, '14:00')
    setNativeAppointmentCreateControllerInvokeHookForTest(async ({ attempt }) => {
      calls += 1
      return {
        statusCode: 503,
        payload: {
          success: false,
          code: attempt === 1 ? 'test_first_503' : 'test_second_503',
          error: 'Fallo transitorio de prueba'
        }
      }
    })

    const result = await resolver.invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, confirmation)

    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.statusCode, 503)
    assert.equal(calls, 2)
    assert.equal(await appointmentCount(fixture), 0)
    const action = singleBookAppointmentAction(confirmation)
    assert.equal(action.outcome.controllerAttempts, 2)
    assert.equal(action.outcome.retried, true)
    assert.equal(action.outcome.firstFailureCode, 'test_first_503')
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_creation_retry'`,
      [fixture.contactId, fixture.agentId]
    )).total), 1)
  } finally {
    setNativeAppointmentCreateControllerInvokeHookForTest(null)
    await cleanupFixture(fixture)
  }
})

test('live retry: un 409 definitivo no reintenta', async () => {
  const fixture = await createFixture('controller_retry_no_409')
  let calls = 0
  try {
    const { confirmation, resolver } = await prepareLiveAppointmentConfirmation(fixture, '13:00')
    setNativeAppointmentCreateControllerInvokeHookForTest(async () => {
      calls += 1
      return {
        statusCode: 409,
        payload: { success: false, code: 'slot_unavailable', error: 'El horario ya no está libre' }
      }
    })

    const result = await resolver.invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, confirmation)

    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.statusCode, 409)
    assert.equal(calls, 1)
    assert.equal(await appointmentCount(fixture), 0)
    const action = singleBookAppointmentAction(confirmation)
    assert.equal(action.outcome.controllerAttempts, 1)
    assert.equal(action.outcome.retried, false)
    assert.equal(action.outcome.firstFailureCode, 'slot_unavailable')
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_creation_retry'`,
      [fixture.contactId, fixture.agentId]
    )).total), 0)
  } finally {
    setNativeAppointmentCreateControllerInvokeHookForTest(null)
    await cleanupFixture(fixture)
  }
})

test('live retry: concurrencia y replay con la misma llave conservan una sola cita canónica', async () => {
  const fixture = await createFixture('controller_retry_concurrent_replay')
  let controllerCalls = 0
  let concurrentResults = []
  let replayResult = null
  try {
    const { confirmation, resolver } = await prepareLiveAppointmentConfirmation(fixture, '12:00')
    setNativeAppointmentCreateControllerInvokeHookForTest(async ({ invoke }) => {
      controllerCalls += 2
      concurrentResults = await Promise.all([invoke(), invoke()])
      controllerCalls += 1
      replayResult = await invoke()
      return replayResult
    })

    const confirmed = await resolver.invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, confirmation)

    assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
    assert.equal(controllerCalls, 3)
    assert.ok(concurrentResults.some((result) => result.statusCode === 201), JSON.stringify(concurrentResults))
    assert.equal(replayResult?.statusCode, 201)
    const concurrentAppointmentId = concurrentResults
      .find((result) => result.statusCode === 201)?.payload?.data?.id
    assert.ok(concurrentAppointmentId)
    assert.equal(replayResult?.payload?.data?.id, concurrentAppointmentId)
    assert.equal(await appointmentCount(fixture), 1)
    const action = singleBookAppointmentAction(confirmation)
    assert.equal(action.outcome.controllerAttempts, 1)
    assert.equal(action.outcome.retried, false)
    assert.equal(action.outcome.firstFailureCode, null)
    const request = await db.get(
      `SELECT status, appointment_id FROM appointment_creation_requests
       WHERE client_request_id = ?`,
      [action.clientRequestId]
    )
    assert.equal(request?.status, 'completed')
    assert.ok(request?.appointment_id)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_booked'`,
      [fixture.contactId, fixture.agentId]
    )).total), 1)
  } finally {
    setNativeAppointmentCreateControllerInvokeHookForTest(null)
    await cleanupFixture(fixture)
  }
})

test('live ledger: una oferta entregada hace seis minutos se reanuda con historial truncado, persiste evidencia mínima y no duplica', async () => {
  const fixture = await createFixture('durable_delivery_truncated_history')
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '16:00')
    const deliveryPlan = await createOfferReplyDelivery({
      fixture,
      sourceMessageId: exact.ctx.executionId,
      reply: exact.offered.visibleReply
    })
    const agedDeliveryAt = new Date(Date.now() - 6 * 60 * 1000).toISOString()
    await mutateReplyDeliveryPlan(deliveryPlan.id, (detail) => ({
      ...detail,
      completedAt: agedDeliveryAt,
      updatedAt: agedDeliveryAt,
      parts: detail.parts.map((part) => ({ ...part, sentAt: agedDeliveryAt }))
    }))
    deliveryPlan.completedAt = agedDeliveryAt
    const offerRow = await db.get(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [fixture.contactId, fixture.agentId]
    )
    const agedOffer = JSON.parse(offerRow?.detail_json || '{}')
    agedOffer.offeredAt = new Date(Date.now() - 6 * 60 * 1000).toISOString()
    agedOffer.expiresAt = new Date(Date.now() + 9 * 60 * 1000).toISOString()
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?',
      [JSON.stringify(agedOffer), offerRow.id]
    )
    const confirmation = await truncatedLedgerConfirmationContext(
      fixture,
      `confirm-ledger-${fixture.suffix}`
    )
    const resolver = toolNamed(confirmation, 'resolve_active_appointment_offer')
    const confirmed = await resolver.invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, confirmation)

    assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
    assert.equal(confirmed.actionCompleted, true)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )).total), 1)

    const selectionRow = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_selection_verified'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [fixture.contactId, fixture.agentId]
    )
    const selection = JSON.parse(selectionRow?.detail_json || '{}')
    assert.equal(selection.offerVisibilityEvidenceSource, 'reply_delivery_ledger')
    assert.equal(selection.offerDeliveryPlanId, deliveryPlan.id)
    assert.equal(selection.offerDeliveryReplyHash, deliveryPlan.replyHash)
    assert.equal(selection.offerDeliveryCompletedAt, deliveryPlan.completedAt)
    assert.equal(selection.offerMessageId, deliveryPlan.parts[0].providerMessageId)
    assert.equal(Object.hasOwn(selection, 'offerDeliveryText'), false)
    assert.equal(Object.hasOwn(selection, 'offerText'), false)
    assert.equal(Object.hasOwn(selection, 'parts'), false)
    assert.equal(JSON.stringify(selection).includes(exact.offered.visibleReply), false)
    assert.equal(JSON.stringify(selection).includes('Contacto agenda progresiva live'), false)

    await resolver.invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, confirmation)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )).total), 1)
  } finally {
    await cleanupFixture(fixture)
  }
})

for (const scenario of [
  { label: 'pending', status: 'pending' },
  { label: 'ambiguous', status: 'ambiguous' },
  { label: 'wrong_text', status: 'completed', reply: 'Tengo disponible otro horario. ¿Te funciona?' },
  { label: 'wrong_source', status: 'completed', identity: ({ sourceMessageId }) => ({ sourceMessageId: `${sourceMessageId}-otro` }) },
  { label: 'wrong_contact', status: 'completed', identity: () => ({ contactId: `otro-contacto-${randomUUID()}` }) },
  { label: 'wrong_agent', status: 'completed', identity: () => ({ agentId: `otro-agente-${randomUUID()}` }) },
  { label: 'wrong_channel', status: 'completed', identity: () => ({ channel: 'instagram' }) },
  { label: 'wrong_prefix', status: 'completed', identity: () => ({ externalIdPrefix: 'otro-prefijo' }) }
]) {
  test(`live ledger: ${scenario.label} no autoriza una oferta fuera del transcript`, async () => {
    const fixture = await createFixture(`ledger_reject_${scenario.label}`)
    try {
      await selectDate(fixture)
      const exact = await offerExactTime(fixture, '15:00')
      const identity = typeof scenario.identity === 'function'
        ? scenario.identity({ sourceMessageId: exact.ctx.executionId })
        : {}
      await createOfferReplyDelivery({
        fixture,
        sourceMessageId: exact.ctx.executionId,
        reply: scenario.reply || exact.offered.visibleReply,
        status: scenario.status,
        identity
      })
      const confirmation = await truncatedLedgerConfirmationContext(
        fixture,
        `confirm-${scenario.label}-${fixture.suffix}`
      )
      const result = await toolNamed(confirmation, 'resolve_active_appointment_offer')
        .invoke(null, JSON.stringify(acceptOfferInput()))

      assert.equal(result.ok, false, JSON.stringify(result))
      assert.equal(result.code, 'appointment_offer_visibility_unverified')
      assert.equal(Number((await db.get(
        'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
        [fixture.calendarId, fixture.contactId]
      )).total), 0)
    } finally {
      await cleanupFixture(fixture)
    }
  })
}

for (const corruption of ['reply_hash', 'part_text']) {
  test(`live ledger: corrupción de ${corruption} falla cerrado aunque el plan diga completed`, async () => {
    const fixture = await createFixture(`ledger_corrupt_${corruption}`)
    try {
      await selectDate(fixture)
      const exact = await offerExactTime(fixture, '15:00')
      const plan = await createOfferReplyDelivery({
        fixture,
        sourceMessageId: exact.ctx.executionId,
        reply: exact.offered.visibleReply
      })
      await mutateReplyDeliveryPlan(plan.id, (detail) => corruption === 'reply_hash'
        ? { ...detail, replyHash: '0'.repeat(64) }
        : {
            ...detail,
            parts: detail.parts.map((part, index) => index === 0
              ? { ...part, text: 'Texto alterado después de la entrega' }
              : part)
          })
      const confirmation = await truncatedLedgerConfirmationContext(
        fixture,
        `confirm-corrupt-${corruption}-${fixture.suffix}`
      )
      const result = await toolNamed(confirmation, 'resolve_active_appointment_offer')
        .invoke(null, JSON.stringify(acceptOfferInput()))

      assert.equal(result.ok, false, JSON.stringify(result))
      assert.equal(result.code, 'appointment_offer_visibility_unverified')
      assert.equal(Number((await db.get(
        'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
        [fixture.calendarId, fixture.contactId]
      )).total), 0)
    } finally {
      await cleanupFixture(fixture)
    }
  })
}

test('live ledger: sin la confirmación inbound actual no agenda aunque la oferta sí haya salido', async () => {
  const fixture = await createFixture('ledger_missing_current_confirmation')
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '15:00')
    await createOfferReplyDelivery({
      fixture,
      sourceMessageId: exact.ctx.executionId,
      reply: exact.offered.visibleReply
    })
    const executionId = `confirm-missing-${fixture.suffix}`
    const confirmation = liveContext({
      fixture,
      executionId,
      messages: [{ id: `otro-inbound-${fixture.suffix}`, role: 'user', content: 'sí' }]
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
  } finally {
    await cleanupFixture(fixture)
  }
})

test('live ledger: una oferta legacy con expiresAt pasado sigue pendiente y revalida al confirmar', async () => {
  const fixture = await createFixture('ledger_expired_offer')
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '15:00')
    await createOfferReplyDelivery({
      fixture,
      sourceMessageId: exact.ctx.executionId,
      reply: exact.offered.visibleReply
    })
    const offerRow = await db.get(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
      [fixture.contactId, fixture.agentId]
    )
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
      [
        JSON.stringify({
          ...JSON.parse(offerRow.detail_json),
          expiresAt: new Date(Date.now() - 60_000).toISOString()
        }),
        offerRow.id,
        offerRow.detail_json
      ]
    )
    const confirmation = await truncatedLedgerConfirmationContext(
      fixture,
      `confirm-expired-ledger-${fixture.suffix}`
    )
    const result = await toolNamed(confirmation, 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify(acceptOfferInput()))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )).total), 1)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('live ledger: apagar el agente después de entregar la oferta impide el commit', async () => {
  const fixture = await createFixture('ledger_agent_config_changed')
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '15:00')
    await createOfferReplyDelivery({
      fixture,
      sourceMessageId: exact.ctx.executionId,
      reply: exact.offered.visibleReply
    })
    const confirmation = await truncatedLedgerConfirmationContext(
      fixture,
      `confirm-config-ledger-${fixture.suffix}`
    )
    await db.run('UPDATE conversational_agents SET enabled = 0 WHERE id = ?', [fixture.agentId])
    const result = await toolNamed(confirmation, 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify(acceptOfferInput()))

    assert.equal(result.ok, false, JSON.stringify(result))
    assert.notEqual(result.code, 'appointment_offer_visibility_unverified')
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )).total), 0)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('preview: un ledger live completed no sustituye la oferta visible del transcript de prueba', async () => {
  const fixture = await createFixture('preview_ignores_live_ledger')
  const scopeId = `appointment_preview_${createHash('sha256').update(fixture.suffix).digest('hex').slice(0, 48)}`
  const previewCtx = (executionId, messages = []) => ({
    ...liveContext({ fixture, executionId, messages }),
    dryRun: true,
    previewScopeId: scopeId,
    virtualContact: { id: fixture.contactId, fullName: 'Contacto de prueba' }
  })
  try {
    const dateCtx = previewCtx(`preview-date-${fixture.suffix}`)
    dateCtx.appointmentOfferDecision = null
    dateCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: dateCtx,
      config: fixture.config
    })
    const dayAvailability = await toolNamed(dateCtx, 'get_free_slots').invoke(
      null,
      JSON.stringify(freeSlotsInput(fixture.localDate))
    )
    assert.ok(dayAvailability.total > 1, JSON.stringify(dayAvailability))
    assert.equal((await toolNamed(dateCtx, 'offer_appointment_options').invoke(null, JSON.stringify({
      maxDays: 1,
      selectionMode: 'collecting_time',
      selectedLocalDate: fixture.localDate
    }))).ok, true)

    const sourceMessageId = `preview-offer-${fixture.suffix}`
    const offerCtx = previewCtx(sourceMessageId)
    offerCtx.appointmentOfferDecision = null
    offerCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: offerCtx,
      config: fixture.config
    })
    const exactAvailability = await toolNamed(offerCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.localDate, {
        earliestLocalTime: '15:00',
        latestLocalTime: '15:00'
      })
    ))
    const startTime = exactAvailability.slots[0].options[0].startTime
    const offered = await toolNamed(offerCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime,
      appointmentId: null
    }))
    assert.equal(offered.ok, true, JSON.stringify(offered))
    await createOfferReplyDelivery({
      fixture,
      sourceMessageId,
      reply: offered.visibleReply
    })

    const confirmationExecutionId = `preview-confirm-${fixture.suffix}`
    const confirmation = previewCtx(confirmationExecutionId, [
      { id: confirmationExecutionId, role: 'user', content: 'sí' }
    ])
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
  } finally {
    await cleanupFixture(fixture)
  }
})

test('preview: el transcript completo prueba la oferta aunque el sobre de 64 KiB sólo conserve el “sí”', async () => {
  const fixture = await createFixture('preview_truncated_transcript_evidence')
  const scopeId = `appointment_preview_${createHash('sha256').update(fixture.suffix).digest('hex').slice(0, 48)}`
  const previewCtx = (executionId, messages = []) => ({
    ...liveContext({ fixture, executionId, messages }),
    dryRun: true,
    previewScopeId: scopeId,
    virtualContact: { id: fixture.contactId, fullName: 'Contacto de prueba' }
  })
  try {
    const dateCtx = previewCtx(`preview-date-${fixture.suffix}`)
    dateCtx.appointmentOfferDecision = null
    dateCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: dateCtx,
      config: fixture.config
    })
    const dayAvailability = await toolNamed(dateCtx, 'get_free_slots').invoke(
      null,
      JSON.stringify(freeSlotsInput(fixture.localDate))
    )
    assert.ok(dayAvailability.total > 1, JSON.stringify(dayAvailability))
    assert.equal((await toolNamed(dateCtx, 'offer_appointment_options').invoke(null, JSON.stringify({
      maxDays: 1,
      selectionMode: 'collecting_time',
      selectedLocalDate: fixture.localDate
    }))).ok, true)

    const sourceMessageId = `preview-source-${fixture.suffix}`
    const sourceMessage = { id: sourceMessageId, role: 'user', content: 'el jueves a las tres' }
    const offerCtx = previewCtx(sourceMessageId, [sourceMessage])
    offerCtx.appointmentOfferDecision = null
    offerCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: offerCtx,
      config: fixture.config
    })
    const exactAvailability = await toolNamed(offerCtx, 'get_free_slots').invoke(null, JSON.stringify(
      freeSlotsInput(fixture.localDate, {
        earliestLocalTime: '15:00',
        latestLocalTime: '15:00'
      })
    ))
    const startTime = exactAvailability.slots[0].options[0].startTime
    const offered = await toolNamed(offerCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime,
      appointmentId: null
    }))
    assert.equal(offered.ok, true, JSON.stringify(offered))

    const confirmationExecutionId = `preview-confirm-${fixture.suffix}`
    const confirmationMessage = { id: confirmationExecutionId, role: 'user', content: 'sí' }
    const confirmation = previewCtx(confirmationExecutionId, [confirmationMessage])
    confirmation.appointmentTranscriptEvidenceMessages = [
      sourceMessage,
      { id: `assistant-offer-${fixture.suffix}`, role: 'assistant', content: offered.visibleReply },
      { id: `assistant-filler-${fixture.suffix}`, role: 'assistant', content: 'x'.repeat(70 * 1024) },
      confirmationMessage
    ]
    confirmation.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: confirmation,
      config: fixture.config
    })
    const result = await toolNamed(confirmation, 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify(acceptOfferInput()))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.notEqual(result.code, 'appointment_offer_visibility_unverified')
    assert.equal(result.simulated, true)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )).total), 0, 'preview sólo autoriza el efecto temporal; no crea una cita live')
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

test('live: si otro contacto ocupa el slot sin empalmes, accept consulta y ofrece alternativas reales', async () => {
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
    assert.equal(blocked.terminal, false)
    assert.equal(blocked.visibleReply, null)
    assert.match(blocked.continueWith, /get_free_slots/)
    assert.match(blocked.continueWith, /offer_appointment_options/)
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

test('live: rechazar una oferta contextual la cierra y un “sí” posterior no la revive', async () => {
  const fixture = await createFixture('decline_contextual_offer')
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '16:00')
    const declineExecutionId = `decline-offer-${fixture.suffix}`
    const ctx = liveContext({
      fixture,
      executionId: declineExecutionId,
      messages: [
        { id: `assistant-decline-${fixture.suffix}`, role: 'assistant', content: exact.offered.visibleReply },
        { id: declineExecutionId, role: 'user', content: 'no, mejor ya no quiero agendar' }
      ]
    })
    ctx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx,
      config: fixture.config
    })
    assert.equal(ctx.appointmentOfferDecision?.active, true)
    const declined = await toolNamed(ctx, 'resolve_active_appointment_offer').invoke(null, JSON.stringify({
      ...acceptOfferInput(),
      decision: 'decline'
    }))
    assert.equal(declined.ok, true, JSON.stringify(declined))
    assert.match(declined.visibleReply, /sin problema/i)
    assert.equal(await appointmentCount(fixture), 0)

    const row = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
      [fixture.contactId, fixture.agentId]
    )
    assert.equal(JSON.parse(row.detail_json).status, 'declined')

    const retryCtx = liveContext({
      fixture,
      executionId: `confirm-after-decline-${fixture.suffix}`,
      messages: [
        { id: `assistant-after-decline-${fixture.suffix}`, role: 'assistant', content: exact.offered.visibleReply },
        { id: `confirm-after-decline-${fixture.suffix}`, role: 'user', content: 'bueno sí, confirma' }
      ]
    })
    assert.equal(await loadConversationalAppointmentOfferDecisionContext({
      ctx: retryCtx,
      config: fixture.config
    }), null)
    assert.equal(await appointmentCount(fixture), 0)
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

test('live: un replay tardío de la misma ejecución conserva la misma oferta aunque el campo legacy haya vencido', async () => {
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
    assert.equal(replay.ok, true, JSON.stringify(replay))
    assert.match(
      String(replay.visibleReply || ''),
      /¿(?:Te funciona ese horario|Confirmas que te agende en ese horario)\?/i
    )
    const stored = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerAction.outcome.offerEventId]
    )).detail_json)
    assert.equal(stored.status, 'active')
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

test('live: la oferta individual nueva se guarda sin fecha de vencimiento', async () => {
  const fixture = await createFixture('offer_without_expiry')
  try {
    await selectDate(fixture)
    await offerExactTime(fixture, '15:00')
    const row = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
      [fixture.contactId, fixture.agentId]
    )
    const detail = JSON.parse(row.detail_json)
    assert.equal(detail.status, 'active')
    assert.equal(detail.expiresAt, null)

    const nextCtx = liveContext({ fixture, executionId: `later-confirmation-${fixture.suffix}` })
    const authority = await loadConversationalAppointmentOfferDecisionContext({
      ctx: nextCtx,
      config: fixture.config
    })
    assert.equal(authority?.active, true)
    assert.equal(authority?.startTime, detail.startTime)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('live: cambiar el contrato durable de la oferta después de hidratarlo falla cerrado', async () => {
  const fixture = await createFixture('offer_contract_changed')
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '14:00')
    const confirmation = await confirmationContext(
      fixture,
      exact.offered,
      `confirm-contract-change-${fixture.suffix}`
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
          localLabel: 'Contrato manipulado'
        }),
        row.id,
        row.detail_json
      ]
    )

    const result = await toolNamed(confirmation, 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify(acceptOfferInput()))
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, 'appointment_offer_scope_changed')
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [fixture.calendarId, fixture.contactId]
    )).total), 0)
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

test('live: apagar o borrar el agente entre resolver el “sí” y ejecutar la terminal invalida la oferta', async () => {
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

test('live: un fallo técnico al releer el agente devuelve 503 y conserva la oferta para reintento', async () => {
  const fixture = await createFixture('offer_agent_lookup_failed_terminal_race')
  try {
    await selectDate(fixture)
    const exact = await offerExactTime(fixture, '14:00')
    const confirmation = await confirmationContext(
      fixture,
      exact.offered,
      `confirm-agent-lookup-failed-terminal-race-${fixture.suffix}`
    )
    setNativeAppointmentBeforeResolverTerminalHookForTest(async () => {
      setNativeAppointmentRuntimeAgentLookupHookForTest(async () => {
        throw new Error('simulated_agent_lookup_failure')
      })
    })

    const result = await toolNamed(confirmation, 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify(acceptOfferInput()))
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, 'appointment_authority_revalidation_failed')
    assert.equal(result.statusCode, 503)
    assert.equal(result.retryable, true)
    assert.equal(result.appointmentOfferInvalidated, false)
    assert.equal(await appointmentCount(fixture), 0)
    const offerDetail = JSON.parse((await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
      [fixture.contactId, fixture.agentId]
    )).detail_json)
    assert.equal(offerDetail.status, 'active')
  } finally {
    setNativeAppointmentBeforeResolverTerminalHookForTest(null)
    setNativeAppointmentRuntimeAgentLookupHookForTest(null)
    await cleanupFixture(fixture)
  }
})

test('live: un fallo técnico dentro del fence transaccional se reintenta como 503 sin invalidar la oferta', async () => {
  const fixture = await createFixture('terminal_fence_lookup_failed_retry')
  let controllerCalls = 0
  try {
    const { confirmation, resolver } = await prepareLiveAppointmentConfirmation(fixture, '14:00')
    setNativeAppointmentAfterPreCommitAuthorityHookForTest(async () => {
      setNativeAppointmentRuntimeAgentLookupHookForTest(async () => {
        throw new Error('simulated_terminal_fence_lookup_failure')
      })
    })
    setNativeAppointmentCreateControllerInvokeHookForTest(async ({ invoke }) => {
      controllerCalls += 1
      return invoke()
    })

    const result = await resolver.invoke(null, JSON.stringify(acceptOfferInput()))
    collectClientRequestIds(fixture, confirmation)
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, 'appointment_authority_revalidation_failed')
    assert.equal(result.statusCode, 503)
    assert.equal(controllerCalls, 2)
    assert.equal(await appointmentCount(fixture), 0)
    const offerDetail = JSON.parse((await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
      [fixture.contactId, fixture.agentId]
    )).detail_json)
    assert.notEqual(offerDetail.status, 'superseded')
  } finally {
    setNativeAppointmentAfterPreCommitAuthorityHookForTest(null)
    setNativeAppointmentRuntimeAgentLookupHookForTest(null)
    setNativeAppointmentCreateControllerInvokeHookForTest(null)
    await cleanupFixture(fixture)
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
