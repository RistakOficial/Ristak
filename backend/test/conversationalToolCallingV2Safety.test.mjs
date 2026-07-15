import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

import { db } from '../src/config/database.js'
import { invokeController } from '../src/agents/invokeController.js'
import {
  buildNativeFreeSlotDays,
  createConversationalTools,
  loadConversationalAppointmentOfferDecisionContext,
  setNativeAppointmentAfterPreCommitAuthorityHookForTest,
  setNativeHandoffAfterAssignmentHookForTest,
  setNativeHumanBookingAfterCommitHookForTest,
  setNativePaymentResumeBeforeTerminalCommitHookForTest,
  setNativePaymentReceiptAnalysisHookForTest
} from '../src/agents/conversational/tools.js'
import {
  ensureToolCallingV2VisibleReply,
  normalizeConversationalPreviewTranscript,
  runConversationalAgentPreview,
  resumeToolCallingV2AfterVerifiedPayment
} from '../src/agents/conversational/runner.js'
import {
  findVerifiedPaymentEvidence,
  verifyNativeAppointmentSelectionEvidence
} from '../src/agents/conversational/actionEvidence.js'
import { upsertLocalCalendar as upsertLocalCalendarService } from '../src/services/localCalendarService.js'
import { registerAgentTransferPaymentProofForReview } from '../src/services/paymentFlowService.js'
import { setConversationalAgentLivePaymentDependenciesForTests } from '../src/services/conversationalAgentLivePaymentService.js'
import {
  completeConversationalAgentSalePaymentFromInvoice,
  consumeConversationalAppointmentDepositForHumanBooking,
  consumeConversationalAppointmentDepositEvidence,
  createConversationalAgent,
  deleteConversationalAgent,
  recordConversationalAgentEvent,
  reserveConversationalAppointmentDepositEvidence,
  setConversationSignal,
  setConversationalPaymentAfterStateInspectionHookForTest,
  setConversationalPriorityNotificationSenderForTest,
  setConversationalPaymentResumeHandlerForTest,
  setConversationalPaymentTerminalReplyHandlerForTest
} from '../src/services/conversationalAgentService.js'
import { getAccountCurrency } from '../src/utils/accountLocale.js'
import { getAccountTimezone } from '../src/utils/dateUtils.js'
import { updateAppointment as updateCalendarAppointment } from '../src/controllers/calendarsController.js'
import {
  approveTransferProof,
  deleteTransaction,
  recordPayment,
  rejectTransferProof,
  voidTransaction
} from '../src/controllers/transactionsController.js'

test.beforeEach(() => {
  setConversationalPaymentTerminalReplyHandlerForTest(async () => ({ sent: true, testDelivery: true }))
})

test.afterEach(async () => {
  setConversationalPaymentTerminalReplyHandlerForTest(null)
  setNativeAppointmentAfterPreCommitAuthorityHookForTest(null)
  await db.run("DELETE FROM conversational_agents WHERE name = 'Agente fixture live'").catch(() => {})
})

// Estas pruebas aíslan candados conversacionales, no el horizonte de reservación.
// Mantienen sus fechas lejanas deliberadas sin quedar limitadas por el default de 30 días.
function upsertLocalCalendar(calendar, options) {
  return upsertLocalCalendarService({
    allowBookingFor: 36500,
    allowBookingForUnit: 'days',
    ...calendar
  }, options)
}

function mockResponse() {
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

function v2Context(items, overrides = {}) {
  return {
    runtimeMode: 'tool_calling_v2',
    contactId: `contact_v2_${randomUUID()}`,
    agentId: `agent_v2_${randomUUID()}`,
    channel: 'whatsapp',
    dryRun: true,
    previewScopeId: `appointment_preview_${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 48)}`,
    followUpMode: false,
    actions: [],
    accountLocale: { currency: 'MXN' },
    config: {
      id: `agent_v2_${randomUUID()}`,
      runtimeMode: 'tool_calling_v2',
      objective: 'custom',
      capabilitiesConfig: { schemaVersion: 1, items }
    },
    ...overrides
  }
}

async function persistLiveAgentConfig(ctx) {
  if (ctx?.dryRun) return
  const agentId = String(ctx?.config?.id || ctx?.agentId || '').trim()
  assert.ok(agentId, 'el fixture live necesita agentId')
  await db.run(
    `INSERT INTO conversational_agents (id, name, enabled, runtime_mode, capabilities_config)
     VALUES (?, 'Agente fixture live', 1, 'tool_calling_v2', ?)
     ON CONFLICT(id) DO UPDATE SET
       enabled = 1,
       runtime_mode = 'tool_calling_v2',
       capabilities_config = excluded.capabilities_config,
       updated_at = CURRENT_TIMESTAMP`,
    [agentId, JSON.stringify(ctx.config.capabilitiesConfig)]
  )
}

function confirmedAppointmentSelection(ctx, startTime, timezone, customerQuote = 'sí, ese horario está bien') {
  const selectedStartTime = String(startTime)
  const localLabel = buildNativeFreeSlotDays([{
    date: DateTime.fromISO(selectedStartTime, { setZone: true }).setZone(timezone).toISODate(),
    timezone,
    slots: [selectedStartTime]
  }], timezone)[0].options[0].localLabel
  const executionId = String(ctx.executionId || `message_selection_${randomUUID()}`)
  ctx.executionId = executionId
  ctx.conversationMessages = [
    { id: `offer_${randomUUID()}`, role: 'assistant', content: `Te ofrezco ${localLabel}.` },
    { id: executionId, role: 'user', content: customerQuote }
  ]
  return {
    selectionMode: 'accepted_prior_offer',
    selectedStartTime,
    customerQuote,
    assistantOfferQuote: localLabel
  }
}

async function authorizeAppointmentOffer(ctx, startTime, timezone, customerQuote = 'sí, ese horario está bien') {
  await persistLiveAgentConfig(ctx)
  const confirmationExecutionId = String(ctx.executionId || `message_confirmation_${randomUUID()}`)
  ctx.executionId = `${confirmationExecutionId}_offer`
  const offered = await createConversationalTools(ctx)
    .find((item) => item.name === 'offer_appointment_slot')
    .invoke(null, JSON.stringify({
      startTime,
      appointmentId: null,
      selectionContext: 'exact_preference'
    }))
  assert.equal(offered.ok, true, JSON.stringify(offered))
  assert.doesNotMatch(offered.visibleReply, /[ap]\.\s?m\.\./i)
  const localLabel = buildNativeFreeSlotDays([{ timezone, slots: [startTime] }], timezone)[0].options[0].localLabel
  const capabilityItems = Array.isArray(ctx?.config?.capabilitiesConfig?.items)
    ? ctx.config.capabilitiesConfig.items
    : []
  const bookingOwner = capabilityItems.find((item) => item?.id === 'schedule_appointment')?.bookingOwner === 'human'
    ? 'human'
    : 'ai'
  const depositRequired = capabilityItems.some((item) => (
    item?.id === 'collect_payment' &&
    item?.enabled !== false &&
    (item?.paymentMode === 'deposit' || item?.chargeType === 'deposit' || item?.deposit?.enabled === true)
  ))
  const confirmationQuestion = depositRequired && bookingOwner === 'human'
    ? '¿Confirmas que sigamos con el anticipo para después enviar la solicitud al equipo?'
    : depositRequired
      ? '¿Confirmas que sigamos con el anticipo para ese horario?'
      : bookingOwner === 'human'
        ? '¿Confirmas que envíe al equipo la solicitud con ese horario?'
        : '¿Confirmas que te agende en ese horario?'
  assert.equal(
    offered.visibleReply,
    `Sí, el horario que me pediste está disponible: el ${localLabel}${/[.!?]$/u.test(localLabel) ? ' ' : '. '}${confirmationQuestion}`
  )
  ctx.executionId = confirmationExecutionId
  ctx.conversationMessages = [
    { id: `offer_visible_${randomUUID()}`, role: 'assistant', content: offered.visibleReply },
    { id: confirmationExecutionId, role: 'user', content: customerQuote }
  ]
  return {
    selectionMode: 'accepted_prior_offer',
    selectedStartTime: String(startTime),
    customerQuote,
    assistantOfferQuote: localLabel
  }
}

async function createSyntheticAppointmentDepositSourceBinding({
  contactId,
  agentId,
  calendarId,
  bookingOwner = 'ai',
  suffix = randomUUID()
} = {}) {
  const startTime = DateTime.now().plus({ days: 20 }).startOf('hour').toUTC().toISO()
  const verifiedAt = new Date().toISOString()
  const appointmentRequestDraft = {
    title: 'Cita ligada a anticipo',
    notes: null,
    attendeeName: null,
    attendeeContext: null,
    primaryAttendee: null,
    guests: []
  }
  const appointmentRequestDraftHash = createHash('sha256')
    .update(JSON.stringify(appointmentRequestDraft))
    .digest('hex')
  const terminalToolName = bookingOwner === 'human' ? 'request_human_booking' : 'book_appointment'
  const selectionEventId = `cae_test_selection_${suffix}`
  await recordConversationalAgentEvent({
    eventId: selectionEventId,
    contactId,
    eventType: 'appointment_slot_selection_verified',
    detail: {
      agentId,
      contactId,
      calendarId,
      startTime,
      verifiedAt,
      status: 'active',
      appointmentRequestDraft,
      appointmentRequestDraftHash,
      bookingOwner,
      terminalToolName
    },
    throwOnError: true
  })
  return {
    appointmentSelectionEventId: selectionEventId,
    appointmentSelectionCalendarId: calendarId,
    appointmentSelectionStartTime: startTime,
    appointmentSelectionVerifiedAt: verifiedAt,
    appointmentSelectionRequestDraftHash: appointmentRequestDraftHash,
    appointmentSelectionBookingOwner: bookingOwner,
    appointmentSelectionTerminalToolName: terminalToolName
  }
}

async function createLiveDepositSelection({ calendarId, contactId, agentId, startTime, timezone, executionId }) {
  const currency = await getAccountCurrency()
  const capabilities = [
    { id: 'schedule_appointment', enabled: true, calendarId, allowOverlaps: false },
    {
      id: 'collect_payment',
      enabled: true,
      paymentMode: 'deposit',
      deposit: {
        enabled: true,
        mode: 'fixed',
        amount: 500,
        currency,
        methods: { paymentLink: true, bankTransfer: true }
      }
    }
  ]
  const ctx = v2Context(capabilities, {
    contactId,
    agentId,
    dryRun: false,
    executionId: `${executionId}_offer`,
    accountLocale: { currency }
  })
  ctx.config.id = agentId
  await persistLiveAgentConfig(ctx)
  const offerResult = await createConversationalTools(ctx)
    .find((item) => item.name === 'offer_appointment_slot')
    .invoke(null, JSON.stringify({ startTime, appointmentId: null }))
  assert.equal(offerResult.ok, true, JSON.stringify(offerResult))
  assert.match(offerResult.visibleReply, /¿Confirmas que sigamos con el anticipo para ese horario\?$/)
  assert.doesNotMatch(offerResult.visibleReply, /¿Confirmas que te agende/)
  const localLabel = buildNativeFreeSlotDays([{ timezone, slots: [startTime] }], timezone)[0].options[0].localLabel
  ctx.executionId = executionId
  ctx.conversationMessages = [
    { id: `offer_visible_${executionId}`, role: 'assistant', content: offerResult.visibleReply },
    { id: executionId, role: 'user', content: 'sí, ese horario está bien' }
  ]
  const result = await createConversationalTools(ctx)
    .find((item) => item.name === 'book_appointment')
    .invoke(null, JSON.stringify({
      startTime,
      selectionEvidence: {
        selectionMode: 'accepted_prior_offer',
        selectedStartTime: startTime,
        customerQuote: 'sí, ese horario está bien',
        assistantOfferQuote: localLabel
      },
      title: null,
      notes: null,
      attendeeName: null,
      attendeeContext: null,
      primaryAttendee: null,
      guests: []
    }))
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.paymentEvidenceRequired, true, JSON.stringify(result))
  return { ctx, capabilities, currency }
}

async function createPaymentResumeTerminalRaceFixture({
  bookingOwner = 'ai',
  suffix = randomUUID()
} = {}) {
  const terminalToolName = bookingOwner === 'human' ? 'request_human_booking' : 'book_appointment'
  const calendarId = `calendar_payment_resume_race_${bookingOwner}_${suffix}`
  const contactId = `contact_payment_resume_race_${bookingOwner}_${suffix}`
  const agentId = `agent_payment_resume_race_${bookingOwner}_${suffix}`
  const paymentId = `payment_payment_resume_race_${bookingOwner}_${suffix}`
  const sourceEventId = `source_payment_resume_race_${bookingOwner}_${suffix}`
  const reconciliationId = `carec_payment_resume_race_${bookingOwner}_${suffix}`
  const reconciliationClaimToken = `claim_a_${bookingOwner}_${suffix}`
  const replacementClaimToken = `claim_b_${bookingOwner}_${suffix}`
  const currency = await getAccountCurrency()
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 55 }).startOf('day')
  const nextThursday = baseDay.plus({ days: (4 - baseDay.weekday + 7) % 7 })
  const startTime = nextThursday.set({ hour: 16, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO()
  const capabilities = [
    { id: 'schedule_appointment', enabled: true, calendarId, bookingOwner, allowOverlaps: false },
    {
      id: 'collect_payment',
      enabled: true,
      paymentMode: 'deposit',
      collectionMethod: 'payment_link',
      deposit: {
        enabled: true,
        mode: 'fixed',
        amount: 100,
        currency,
        methods: { paymentLink: true }
      }
    }
  ]

  await upsertLocalCalendar({
    id: calendarId,
    locationId: `location_payment_resume_race_${bookingOwner}_${suffix}`,
    name: `Agenda carrera ${bookingOwner}`,
    source: 'ristak',
    slotDuration: 60,
    slotInterval: 60,
    openHours: [{ daysOfTheWeek: [4], hours: [{ openHour: 15, openMinute: 0, closeHour: 18, closeMinute: 0 }] }]
  }, { source: 'ristak', syncStatus: 'synced' })
  await db.run(
    `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
     VALUES (?, 'Cliente carrera de anticipo', '+526560001234', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId]
  )
  await db.run(
    `INSERT INTO conversational_agents (id, name, enabled, runtime_mode, capabilities_config)
     VALUES (?, 'Agente carrera de anticipo', 1, 'tool_calling_v2', ?)`,
    [agentId, JSON.stringify({ schemaVersion: 3, items: capabilities })]
  )

  const selectionCtx = v2Context(capabilities, {
    contactId,
    agentId,
    dryRun: false,
    executionId: `message_payment_resume_race_${bookingOwner}_${suffix}`,
    accountLocale: { currency }
  })
  selectionCtx.config.id = agentId
  const selectionEvidence = await authorizeAppointmentOffer(selectionCtx, startTime, timezone)
  const first = await createConversationalTools(selectionCtx)
    .find((item) => item.name === terminalToolName)
    .invoke(null, JSON.stringify({
      startTime,
      selectionEvidence,
      title: 'Valoración ligada al anticipo',
      notes: 'Contrato original que no puede cambiar durante la reanudación',
      attendeeName: null,
      attendeeContext: null,
      primaryAttendee: null,
      guests: []
    }))
  assert.equal(first.ok, false, JSON.stringify(first))
  assert.equal(first.paymentEvidenceRequired, true, JSON.stringify(first))

  const selection = await db.get(
    `SELECT id, detail_json FROM conversational_agent_events
     WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_selection_verified'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [contactId, agentId]
  )
  assert.ok(selection?.id)
  const selectionDetail = JSON.parse(selection.detail_json)
  const sourceBinding = {
    appointmentSelectionEventId: selection.id,
    appointmentSelectionCalendarId: selectionDetail.calendarId,
    appointmentSelectionStartTime: selectionDetail.startTime,
    appointmentSelectionVerifiedAt: selectionDetail.verifiedAt,
    appointmentSelectionRequestDraftHash: selectionDetail.appointmentRequestDraftHash,
    appointmentSelectionBookingOwner: selectionDetail.bookingOwner,
    appointmentSelectionTerminalToolName: selectionDetail.terminalToolName
  }
  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, paid_at, created_at, updated_at
    ) VALUES (?, ?, 100, ?, 'paid', 'card', 'live', 'stripe', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [paymentId, contactId, currency]
  )
  await recordConversationalAgentEvent({
    eventId: sourceEventId,
    contactId,
    eventType: 'payment_link_created',
    detail: {
      agentId,
      ledgerPaymentId: paymentId,
      amount: 100,
      currency,
      paymentEnvironment: 'live',
      paymentMode: 'deposit',
      paymentPurpose: 'appointment_deposit',
      appointmentDeposit: true,
      ...sourceBinding
    },
    throwOnError: true
  })
  await recordConversationalAgentEvent({
    eventId: reconciliationId,
    contactId,
    eventType: 'payment_reconciliation_v2',
    detail: {
      agentId,
      sourceEventId,
      status: 'processing',
      claimToken: reconciliationClaimToken,
      leaseUntilAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      verifiedEventAppliedAt: new Date().toISOString(),
      ledgerPaymentId: paymentId,
      amount: 100,
      currency,
      paymentEnvironment: 'live',
      paymentPurpose: 'appointment_deposit',
      appointmentDeposit: true,
      autoResumeAllowed: true,
      manualReviewOnly: false,
      ...sourceBinding
    },
    throwOnError: true
  })
  await db.run(
    `INSERT INTO conversational_agent_state (
      contact_id, agent_id, channel, status, signal, updated_by, updated_at
    ) VALUES (?, ?, 'whatsapp', 'active', NULL, NULL, CURRENT_TIMESTAMP)`,
    [contactId, agentId]
  )

  return {
    bookingOwner,
    terminalToolName,
    calendarId,
    contactId,
    agentId,
    paymentId,
    reconciliationId,
    reconciliationClaimToken,
    replacementClaimToken,
    currency,
    startTime,
    capabilities,
    selectionDetail,
    contexts: [selectionCtx]
  }
}

async function invokePaymentResumeTerminalFixture(fixture, claimToken = fixture.reconciliationClaimToken) {
  const ctx = v2Context(fixture.capabilities, {
    contactId: fixture.contactId,
    agentId: fixture.agentId,
    dryRun: false,
    executionId: `payment-resume:${fixture.reconciliationId}`,
    accountLocale: { currency: fixture.currency },
    paymentResumeClaim: {
      reconciliationId: fixture.reconciliationId,
      claimToken,
      agentId: fixture.agentId,
      channel: 'whatsapp'
    }
  })
  ctx.config.id = fixture.agentId
  fixture.contexts.push(ctx)
  const result = await createConversationalTools(ctx)
    .find((item) => item.name === fixture.terminalToolName)
    .invoke(null, JSON.stringify({
      title: 'Dato nuevo que no debe sustituir el contrato pagado',
      notes: null,
      attendeeName: null,
      attendeeContext: null,
      primaryAttendee: null,
      guests: []
    }))
  return { ctx, result }
}

async function cleanupPaymentResumeTerminalRaceFixture(fixture) {
  setNativePaymentResumeBeforeTerminalCommitHookForTest(null)
  setNativeAppointmentAfterPreCommitAuthorityHookForTest(null)
  const requestIds = fixture.contexts
    .flatMap((ctx) => ctx.actions || [])
    .map((action) => String(action?.clientRequestId || '').trim())
    .filter(Boolean)
  for (const requestId of new Set(requestIds)) {
    await db.run('DELETE FROM appointment_creation_requests WHERE client_request_id = ?', [requestId]).catch(() => {})
  }
  await db.run(
    `DELETE FROM appointment_creation_requests
     WHERE appointment_id IN (SELECT id FROM appointments WHERE contact_id = ?)`,
    [fixture.contactId]
  ).catch(() => {})
  await db.run('DELETE FROM appointments WHERE contact_id = ?', [fixture.contactId]).catch(() => {})
  await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [fixture.contactId]).catch(() => {})
  await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [fixture.contactId]).catch(() => {})
  await db.run('DELETE FROM payments WHERE contact_id = ?', [fixture.contactId]).catch(() => {})
  await db.run('DELETE FROM calendars WHERE id = ?', [fixture.calendarId]).catch(() => {})
  await db.run('DELETE FROM conversational_agents WHERE id = ?', [fixture.agentId]).catch(() => {})
  await db.run('DELETE FROM contacts WHERE id = ?', [fixture.contactId]).catch(() => {})
}

for (const bookingOwner of ['ai', 'human']) {
  const terminalToolName = bookingOwner === 'human' ? 'request_human_booking' : 'book_appointment'

  test(`claim A pierde ante claim B justo antes de ${terminalToolName} y el replay viejo no responde`, async () => {
    let fixture = null
    try {
      fixture = await createPaymentResumeTerminalRaceFixture({ bookingOwner })
      let hookCalls = 0
      setNativePaymentResumeBeforeTerminalCommitHookForTest(async (hookContext) => {
        hookCalls += 1
        assert.equal(hookContext.terminalToolName, terminalToolName)
        assert.equal(hookContext.reconciliationId, fixture.reconciliationId)
        assert.equal(hookContext.reconciliationClaimToken, fixture.reconciliationClaimToken)
        const row = await db.get(
          'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
          [fixture.reconciliationId]
        )
        const detail = JSON.parse(row.detail_json)
        assert.equal(detail.status, 'processing')
        assert.equal(detail.claimToken, fixture.reconciliationClaimToken)
        await db.run(
          'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?',
          [JSON.stringify({
            ...detail,
            claimToken: fixture.replacementClaimToken,
            leaseUntilAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
          }), fixture.reconciliationId]
        )
      })

      const staleAttempt = await invokePaymentResumeTerminalFixture(fixture)
      assert.equal(hookCalls, 1)
      assert.equal(staleAttempt.result.ok, false, JSON.stringify(staleAttempt.result))
      assert.notEqual(staleAttempt.ctx.actions.at(-1)?.outcome?.actionCompleted, true)
      setNativePaymentResumeBeforeTerminalCommitHookForTest(null)

      const reconciliation = JSON.parse((await db.get(
        'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
        [fixture.reconciliationId]
      )).detail_json)
      assert.equal(reconciliation.claimToken, fixture.replacementClaimToken)
      assert.equal(Number((await db.get(
        'SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?',
        [fixture.contactId]
      )).total), 0)
      assert.equal(Number((await db.get(
        `SELECT COUNT(*) AS total FROM conversational_agent_events
         WHERE contact_id = ? AND event_type = 'human_booking_requested'`,
        [fixture.contactId]
      )).total), 0)
      const consumptionRow = await db.get(
        'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
        [`${fixture.reconciliationId}_consumed`]
      )
      if (consumptionRow?.detail_json) {
        assert.notEqual(JSON.parse(consumptionRow.detail_json).status, 'consumed')
      }
      const untouchedState = await db.get(
        `SELECT status, signal, updated_by FROM conversational_agent_state
         WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
        [fixture.contactId, fixture.agentId]
      )
      assert.equal(untouchedState.status, 'active')
      assert.equal(untouchedState.signal, null)

      let deliveryCalls = 0
      const recordedEvents = []
      const replay = await resumeToolCallingV2AfterVerifiedPayment({
        reconciliationId: fixture.reconciliationId,
        reconciliationClaimToken: fixture.reconciliationClaimToken,
        contactId: fixture.contactId,
        agentId: fixture.agentId,
        channel: 'whatsapp',
        amount: 100,
        currency: fixture.currency,
        paymentEnvironment: 'live',
        paymentPurpose: 'appointment_deposit',
        bookingOwner,
        terminalToolName
      }, {
        getRuntimeConfig: async () => ({ enabled: true, aiProvider: 'openai' }),
        hasFeature: async () => true,
        getAgent: async () => ({
          id: fixture.agentId,
          enabled: true,
          runtimeMode: 'tool_calling_v2',
          aiProvider: 'openai',
          model: 'fake-payment-resume-race-model',
          capabilitiesConfig: { schemaVersion: 3, items: fixture.capabilities },
          replyDelivery: { mode: 'single', splitMessagesEnabled: false }
        }),
        getState: async () => db.get(
          `SELECT status, signal FROM conversational_agent_state
           WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
          [fixture.contactId, fixture.agentId]
        ),
        getLatestInbound: async () => ({
          id: `inbound_payment_resume_race_${fixture.bookingOwner}`,
          phone: '+526560001234',
          message_text: 'ok'
        }),
        getHistoryEnvelope: async () => ({
          messages: [{ role: 'user', content: 'ok' }],
          telemetry: { totalMessages: 1, includedMessages: 1, omittedMessages: 0 }
        }),
        hydrateMessages: async (messages) => messages,
        resolveRuntime: async () => ({ apiKey: 'stored-test-key-not-real', modelProvider: { kind: 'fake' } }),
        runNativeTurn: async (input) => {
          assert.equal(input.paymentResumeClaim.claimToken, fixture.reconciliationClaimToken)
          const oldClaimAttempt = await invokePaymentResumeTerminalFixture(
            fixture,
            input.paymentResumeClaim.claimToken
          )
          return {
            ctx: oldClaimAttempt.ctx,
            reply: 'No debe enviarse porque este worker perdió el claim.',
            model: 'fake-payment-resume-race-model',
            runtimeMode: 'tool_calling_v2',
            modelCallCount: 1
          }
        },
        deliverReply: async () => {
          deliveryCalls += 1
          return { parts: ['respuesta indebida'], sentParts: 1, interruptedBy: null }
        },
        recordEvent: async (event) => {
          recordedEvents.push(event)
          return event
        }
      })
      assert.deepEqual(replay, {
        resumed: false,
        manualReviewRequired: true,
        reason: 'payment_resume_terminal_failed'
      })
      assert.equal(deliveryCalls, 0)
      assert.equal(
        recordedEvents.some((event) => event.eventId === `${fixture.reconciliationId}_reply`),
        false
      )
      assert.equal(Number((await db.get(
        `SELECT COUNT(*) AS total FROM conversational_agent_events
         WHERE contact_id = ? AND event_type = 'payment_resume_reply_sent'`,
        [fixture.contactId]
      )).total), 0)
    } finally {
      if (fixture) await cleanupPaymentResumeTerminalRaceFixture(fixture)
      else setNativePaymentResumeBeforeTerminalCommitHookForTest(null)
    }
  })

  test(`cambiar el responsable justo antes de ${terminalToolName} bloquea el efecto pagado`, async () => {
    let fixture = null
    try {
      fixture = await createPaymentResumeTerminalRaceFixture({ bookingOwner })
      const changedCapabilities = structuredClone(fixture.capabilities)
      changedCapabilities.find((item) => item.id === 'schedule_appointment').bookingOwner = bookingOwner === 'ai'
        ? 'human'
        : 'ai'
      setNativePaymentResumeBeforeTerminalCommitHookForTest(async () => {
        await db.run(
          `UPDATE conversational_agents
           SET capabilities_config = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [JSON.stringify({ schemaVersion: 3, items: changedCapabilities }), fixture.agentId]
        )
      })

      const attempt = await invokePaymentResumeTerminalFixture(fixture)
      assert.equal(attempt.result.ok, false, JSON.stringify(attempt.result))
      assert.equal(attempt.result.code, 'appointment_offer_scope_changed')
      assert.equal(attempt.result.appointmentOfferInvalidated, true)
      assert.equal(Number((await db.get(
        'SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?',
        [fixture.contactId]
      )).total), 0)
      assert.equal(Number((await db.get(
        `SELECT COUNT(*) AS total FROM conversational_agent_events
         WHERE contact_id = ? AND event_type = 'human_booking_requested'`,
        [fixture.contactId]
      )).total), 0)
      const state = await db.get(
        `SELECT status, signal FROM conversational_agent_state
         WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
        [fixture.contactId, fixture.agentId]
      )
      assert.equal(state.status, 'active')
      assert.equal(state.signal, null)
    } finally {
      if (fixture) await cleanupPaymentResumeTerminalRaceFixture(fixture)
      else setNativePaymentResumeBeforeTerminalCommitHookForTest(null)
    }
  })

  test(`cambiar reglas del calendario después del precommit bloquea ${terminalToolName} dentro del commit`, async () => {
    let fixture = null
    try {
      fixture = await createPaymentResumeTerminalRaceFixture({ bookingOwner })
      let hookCalls = 0
      setNativeAppointmentAfterPreCommitAuthorityHookForTest(async (hookContext) => {
        hookCalls += 1
        assert.equal(hookContext.terminalToolName, terminalToolName)
        assert.equal(hookContext.calendarId, fixture.calendarId)
        assert.match(String(hookContext.calendarFingerprint || ''), /^[a-f0-9]{64}$/i)
        const updated = await db.run(
          'UPDATE calendars SET slot_interval = 30 WHERE id = ?',
          [fixture.calendarId]
        )
        assert.equal(Number(updated?.changes ?? updated?.rowCount ?? 0), 1)
      })

      const attempt = await invokePaymentResumeTerminalFixture(fixture)
      assert.equal(hookCalls, 1)
      assert.equal(attempt.result.ok, false, JSON.stringify(attempt.result))
      assert.equal(attempt.result.code, 'appointment_offer_scope_changed')
      assert.equal(attempt.result.appointmentOfferInvalidated, true)
      assert.equal(Number((await db.get(
        'SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?',
        [fixture.contactId]
      )).total), 0)
      assert.equal(Number((await db.get(
        `SELECT COUNT(*) AS total FROM conversational_agent_events
         WHERE contact_id = ? AND event_type = 'human_booking_requested'`,
        [fixture.contactId]
      )).total), 0)
      const state = await db.get(
        `SELECT status, signal FROM conversational_agent_state
         WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
        [fixture.contactId, fixture.agentId]
      )
      assert.equal(state.status, 'active')
      assert.equal(state.signal, null)
    } finally {
      if (fixture) await cleanupPaymentResumeTerminalRaceFixture(fixture)
      else setNativeAppointmentAfterPreCommitAuthorityHookForTest(null)
    }
  })

  for (const takeoverStatus of ['human', 'paused']) {
    test(`takeover ${takeoverStatus} justo antes de ${terminalToolName} conserva el control y bloquea todo efecto`, async () => {
      let fixture = null
      try {
        fixture = await createPaymentResumeTerminalRaceFixture({ bookingOwner })
        const takeoverSignal = takeoverStatus === 'human' ? 'ready_for_human' : null
        const takeoverReason = `Takeover ${takeoverStatus} concurrente antes de ${terminalToolName}`
        setNativePaymentResumeBeforeTerminalCommitHookForTest(async (hookContext) => {
          assert.equal(hookContext.terminalToolName, terminalToolName)
          assert.equal(hookContext.reconciliationClaimToken, fixture.reconciliationClaimToken)
          const updated = await db.run(
            `UPDATE conversational_agent_state
             SET status = ?, signal = ?, signal_reason = ?, updated_by = 'human_takeover_test',
                 updated_at = CURRENT_TIMESTAMP
             WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
            [takeoverStatus, takeoverSignal, takeoverReason, fixture.contactId, fixture.agentId]
          )
          assert.equal(Number(updated?.changes ?? updated?.rowCount ?? 0), 1)
        })

        const attempt = await invokePaymentResumeTerminalFixture(fixture)
        assert.equal(attempt.result.ok, false, JSON.stringify(attempt.result))
        assert.notEqual(attempt.ctx.actions.at(-1)?.outcome?.actionCompleted, true)

        const state = await db.get(
          `SELECT status, signal, signal_reason, updated_by FROM conversational_agent_state
           WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
          [fixture.contactId, fixture.agentId]
        )
        assert.equal(state.status, takeoverStatus)
        assert.equal(state.signal, takeoverSignal)
        assert.equal(state.signal_reason, takeoverReason)
        assert.equal(state.updated_by, 'human_takeover_test')
        assert.equal(Number((await db.get(
          'SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?',
          [fixture.contactId]
        )).total), 0)
        assert.equal(Number((await db.get(
          `SELECT COUNT(*) AS total FROM conversational_agent_events
           WHERE contact_id = ? AND event_type IN ('appointment_booked', 'human_booking_requested')`,
          [fixture.contactId]
        )).total), 0)
        const consumptionRow = await db.get(
          'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
          [`${fixture.reconciliationId}_consumed`]
        )
        if (consumptionRow?.detail_json) {
          assert.notEqual(JSON.parse(consumptionRow.detail_json).status, 'consumed')
        }
        const contact = await db.get(
          'SELECT assigned_user_id, assignment_test_effect_id FROM contacts WHERE id = ?',
          [fixture.contactId]
        )
        assert.equal(contact.assigned_user_id, null)
        assert.equal(contact.assignment_test_effect_id, null)
      } finally {
        if (fixture) await cleanupPaymentResumeTerminalRaceFixture(fixture)
        else setNativePaymentResumeBeforeTerminalCommitHookForTest(null)
      }
    })
  }
}

async function createRescheduleCommitFenceFixture({ bookingOwner = 'ai' } = {}) {
  const suffix = randomUUID()
  const calendarId = `calendar_reschedule_fence_${bookingOwner}_${suffix}`
  const contactId = `contact_reschedule_fence_${bookingOwner}_${suffix}`
  const agentId = `agent_reschedule_fence_${bookingOwner}_${suffix}`
  const appointmentId = `appointment_reschedule_fence_${bookingOwner}_${suffix}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 49 }).startOf('day')
  const monday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const originalStart = monday.set({ hour: 10, minute: 0, second: 0, millisecond: 0 })
  const targetStart = monday.set({ hour: 13, minute: 0, second: 0, millisecond: 0 })
  const capabilities = [{
    id: 'schedule_appointment',
    enabled: true,
    calendarId,
    bookingOwner,
    allowOverlaps: false
  }]

  await upsertLocalCalendar({
    id: calendarId,
    name: `Agenda fence reagenda ${bookingOwner}`,
    source: 'ristak',
    allowReschedule: true,
    slotDuration: 60,
    slotInterval: 60,
    openHours: [{
      daysOfTheWeek: [1],
      hours: [{ openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0 }]
    }]
  }, { source: 'ristak', syncStatus: 'synced' })
  await db.run(
    `INSERT INTO contacts (id, full_name, created_at, updated_at)
     VALUES (?, 'Cliente fence de reagenda', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId]
  )
  await db.run(
    `INSERT INTO appointments (
       id, calendar_id, contact_id, title, status, appointment_status,
       start_time, end_time, source, sync_status, date_added, date_updated
     ) VALUES (?, ?, ?, 'Cita protegida por fence', 'confirmed', 'confirmed', ?, ?, 'ristak', 'synced', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      appointmentId,
      calendarId,
      contactId,
      originalStart.toUTC().toISO(),
      originalStart.plus({ hours: 1 }).toUTC().toISO()
    ]
  )

  const offerExecutionId = `offer_reschedule_fence_${bookingOwner}_${suffix}`
  const ctx = v2Context(capabilities, {
    contactId,
    agentId,
    dryRun: false,
    executionId: offerExecutionId
  })
  ctx.config.id = agentId
  await persistLiveAgentConfig(ctx)
  const tools = createConversationalTools(ctx)
  const availability = await tools.find((item) => item.name === 'get_free_slots').invoke(null, JSON.stringify({
    startDate: monday.toISODate(),
    endDate: monday.toISODate(),
    appointmentId
  }))
  assert.equal(availability.ok, true, JSON.stringify(availability))
  const offered = await tools.find((item) => item.name === 'offer_appointment_slot').invoke(null, JSON.stringify({
    startTime: targetStart.toUTC().toISO(),
    appointmentId
  }))
  assert.equal(offered.ok, true, JSON.stringify(offered))

  const confirmationExecutionId = `confirm_reschedule_fence_${bookingOwner}_${suffix}`
  ctx.executionId = confirmationExecutionId
  ctx.actions = []
  ctx.conversationMessages = [
    { id: offerExecutionId, role: 'user', content: 'Quiero mover mi cita a la una.' },
    { id: `visible_${offerExecutionId}`, role: 'assistant', content: offered.visibleReply },
    { id: confirmationExecutionId, role: 'user', content: 'Sí, ese horario está bien.' }
  ]
  ctx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
    ctx,
    config: ctx.config
  })
  assert.equal(ctx.appointmentOfferDecision?.purpose, 'reschedule')
  return {
    bookingOwner,
    calendarId,
    contactId,
    agentId,
    appointmentId,
    originalStart,
    ctx
  }
}

async function cleanupRescheduleCommitFenceFixture(fixture) {
  setNativeAppointmentAfterPreCommitAuthorityHookForTest(null)
  await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [fixture.contactId]).catch(() => {})
  await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [fixture.contactId]).catch(() => {})
  await db.run('DELETE FROM appointment_participants WHERE appointment_id = ?', [fixture.appointmentId]).catch(() => {})
  await db.run('DELETE FROM appointments WHERE id = ?', [fixture.appointmentId]).catch(() => {})
  await db.run('DELETE FROM conversational_agents WHERE id = ?', [fixture.agentId]).catch(() => {})
  await db.run('DELETE FROM calendars WHERE id = ?', [fixture.calendarId]).catch(() => {})
  await db.run('DELETE FROM contacts WHERE id = ?', [fixture.contactId]).catch(() => {})
}

for (const bookingOwner of ['ai', 'human']) {
  test(`desactivar reagenda después del precommit bloquea el cierre ${bookingOwner} sin mover ni entregar la cita`, async () => {
    let fixture = null
    try {
      fixture = await createRescheduleCommitFenceFixture({ bookingOwner })
      let hookCalls = 0
      setNativeAppointmentAfterPreCommitAuthorityHookForTest(async (hookContext) => {
        hookCalls += 1
        assert.equal(hookContext.purpose, 'reschedule')
        assert.equal(hookContext.calendarId, fixture.calendarId)
        assert.equal(hookContext.appointmentId, fixture.appointmentId)
        assert.equal(
          hookContext.terminalToolName,
          bookingOwner === 'human' ? 'request_human_booking' : 'reschedule_appointment'
        )
        await db.run('UPDATE calendars SET allow_reschedule = 0 WHERE id = ?', [fixture.calendarId])
      })

      const resolved = await createConversationalTools(fixture.ctx)
        .find((item) => item.name === 'resolve_active_appointment_offer')
        .invoke(null, JSON.stringify({
          decision: 'accept',
          reply: null,
          title: null,
          notes: null,
          attendeeName: null,
          attendeeContext: null,
          primaryAttendee: null,
          guests: [],
          agreedAmount: null
        }))
      assert.equal(hookCalls, 1)
      assert.equal(resolved.ok, false, JSON.stringify(resolved))
      assert.equal(resolved.code, 'appointment_offer_scope_changed')
      assert.equal(resolved.appointmentOfferInvalidated, true)
      const appointment = await db.get(
        'SELECT start_time, end_time, appointment_status FROM appointments WHERE id = ?',
        [fixture.appointmentId]
      )
      assert.equal(new Date(appointment.start_time).toISOString(), fixture.originalStart.toUTC().toISO())
      assert.equal(new Date(appointment.end_time).toISOString(), fixture.originalStart.plus({ hours: 1 }).toUTC().toISO())
      assert.equal(appointment.appointment_status, 'confirmed')
      assert.equal(Number((await db.get(
        `SELECT COUNT(*) AS total FROM conversational_agent_events
         WHERE contact_id = ? AND event_type = 'human_reschedule_requested'`,
        [fixture.contactId]
      )).total), 0)
    } finally {
      if (fixture) await cleanupRescheduleCommitFenceFixture(fixture)
      else setNativeAppointmentAfterPreCommitAuthorityHookForTest(null)
    }
  })
}

test('v2 presenta la hora local del servidor y conserva el startTime UTC sin recalcularlo', () => {
  const startTime = '2026-07-14T22:00:00.000Z'
  const [day] = buildNativeFreeSlotDays([{
    date: '2026-07-14',
    timezone: 'America/Mexico_City',
    slots: [startTime]
  }], 'UTC')
  const [option] = day.options

  assert.equal(day.timezone, 'America/Mexico_City')
  assert.equal(option.startTime, startTime)
  assert.equal(option.localDate, '2026-07-14')
  assert.equal(option.localTime, '16:00')
  assert.match(option.localLabel, /martes 14 de julio de 2026/)
  assert.match(option.localLabel, /4:00/)
  assert.doesNotMatch(option.localLabel, /5:00/)
})

test('la hora repetida por DST incluye offset y la evidencia no puede cruzar ambos instantes', () => {
  const timezone = 'America/Ciudad_Juarez'
  const firstStart = '2026-11-01T07:30:00.000Z'
  const secondStart = '2026-11-01T08:30:00.000Z'
  const options = buildNativeFreeSlotDays([{
    date: '2026-11-01',
    timezone,
    slots: [firstStart, secondStart]
  }], timezone)[0].options

  assert.notEqual(options[0].localLabel, options[1].localLabel)
  assert.match(options[0].localLabel, /UTC-06:00/)
  assert.match(options[1].localLabel, /UTC-07:00/)
  const result = verifyNativeAppointmentSelectionEvidence({
    messages: [
      { id: 'offer_dst_first', role: 'assistant', content: `Te ofrezco ${options[0].localLabel}` },
      { id: 'customer_dst', role: 'user', content: 'sí, esa' }
    ],
    startTime: secondStart,
    timezone,
    executionId: 'customer_dst',
    evidence: {
      selectionMode: 'accepted_prior_offer',
      selectedStartTime: secondStart,
      customerQuote: 'sí, esa',
      assistantOfferQuote: options[0].localLabel
    }
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /etiqueta canónica/i)
})

test('la confirmación acepta globitos contiguos y un batch inbound, pero nunca cruza otro turno del cliente', () => {
  const timezone = 'America/Ciudad_Juarez'
  const startTime = '2026-10-20T22:00:00.000Z'
  const localLabel = buildNativeFreeSlotDays([{ timezone, slots: [startTime] }], timezone)[0].options[0].localLabel
  const messages = [
    { id: 'offer_bubble_1', role: 'assistant', content: `Tengo ${localLabel}` },
    { id: 'offer_bubble_2', role: 'assistant', content: '¿te funciona?' },
    { id: 'customer_batch_1', role: 'user', content: 'el martes' },
    { id: 'customer_batch_2', role: 'user', content: 'a las 4, por favor' }
  ]
  const accepted = verifyNativeAppointmentSelectionEvidence({
    messages,
    startTime,
    timezone,
    executionId: 'customer_batch_2',
    evidence: {
      selectionMode: 'accepted_prior_offer',
      selectedStartTime: startTime,
      customerQuote: 'el martes',
      assistantOfferQuote: localLabel
    }
  })
  assert.equal(accepted.ok, true, JSON.stringify(accepted))
  assert.deepEqual(accepted.customerMessageIds, ['customer_batch_1', 'customer_batch_2'])
  assert.deepEqual(accepted.offerTurnMessageIds, ['offer_bubble_1', 'offer_bubble_2'])
  assert.equal(accepted.offerMessageId, 'offer_bubble_1')

  const crossed = verifyNativeAppointmentSelectionEvidence({
    messages: [
      { id: 'old_offer', role: 'assistant', content: localLabel },
      { id: 'intervening_customer', role: 'user', content: 'déjame pensarlo' },
      { id: 'new_assistant', role: 'assistant', content: 'claro' },
      { id: 'new_customer', role: 'user', content: 'sí' }
    ],
    startTime,
    timezone,
    executionId: 'new_customer',
    evidence: {
      selectionMode: 'accepted_prior_offer',
      selectedStartTime: startTime,
      customerQuote: 'sí',
      assistantOfferQuote: localLabel
    }
  })
  assert.equal(crossed.ok, false)

  const secondStart = '2026-10-20T23:00:00.000Z'
  const secondLabel = buildNativeFreeSlotDays([{ timezone, slots: [secondStart] }], timezone)[0].options[0].localLabel
  const ambiguous = verifyNativeAppointmentSelectionEvidence({
    messages: [
      { id: 'two_offers', role: 'assistant', content: `Tengo ${localLabel} o ${secondLabel}` },
      { id: 'ambiguous_yes', role: 'user', content: 'sí' }
    ],
    startTime,
    timezone,
    executionId: 'ambiguous_yes',
    evidence: {
      selectionMode: 'accepted_prior_offer',
      selectedStartTime: startTime,
      customerQuote: 'sí',
      assistantOfferQuote: localLabel
    }
  })
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.code, 'ambiguous_slot_selection')
})

test('get_contact_profile usa identidad virtual estable en preview y falla cerrado en vivo', async () => {
  const previewCtx = v2Context([], {
    contactId: 'ristak-preview-contact',
    dryRun: true,
    virtualContact: { id: 'ristak-preview-contact', fullName: 'Contacto de prueba' }
  })
  const previewTool = createConversationalTools(previewCtx)
    .find((item) => item.name === 'get_contact_profile')
  const preview = await previewTool.invoke(null, '{}')

  assert.equal(preview.ok, true)
  assert.equal(preview.contact.fullName, 'Contacto de prueba')
  assert.equal(preview.contact.source, 'preview_thread')
  assert.equal(preview.pastClientEvidence.isPastClient, false)
  assert.deepEqual(preview.upcomingAppointments, [])
  assert.match(preview.note, /no pidas teléfono/i)

  const missingCtx = v2Context([], {
    contactId: `contact_missing_${randomUUID()}`,
    dryRun: false
  })
  const missingTool = createConversationalTools(missingCtx)
    .find((item) => item.name === 'get_contact_profile')
  const missing = await missingTool.invoke(null, '{}')
  assert.equal(missing.ok, false)
  assert.equal(missing.transferRequired, true)
  assert.equal(missing.terminal, true)
  assert.equal(missingCtx.actions[0]?.type, 'contact_identity_unavailable')
  assert.doesNotMatch(
    ensureToolCallingV2VisibleReply('me pasas tu teléfono para buscarte?', missingCtx.actions),
    /teléfono para buscarte/i
  )
})

test('create_payment_link usa el contacto virtual del preview sin pedir teléfono ni crear pagos', async () => {
  const suffix = randomUUID()
  const productId = `product_preview_${suffix}`
  const priceId = `price_preview_${suffix}`
  const currency = await getAccountCurrency()
  try {
    await db.run(
      `INSERT INTO products (id, name, currency, is_active, source)
       VALUES (?, 'Consulta preview', ?, 1, 'ristak')`,
      [productId, currency]
    )
    await db.run(
      `INSERT INTO product_prices (id, product_id, name, currency, amount, source)
       VALUES (?, ?, 'Precio preview', ?, 1200, 'ristak')`,
      [priceId, productId, currency]
    )
    const ctx = v2Context([{
      id: 'collect_payment',
      enabled: true,
      paymentMode: 'full_payment',
      productId,
      priceId
    }], {
      contactId: 'ristak-preview-contact',
      dryRun: true,
      virtualContact: { id: 'ristak-preview-contact', fullName: 'Contacto de prueba' },
      accountLocale: { currency }
    })
    const payment = createConversationalTools(ctx).find((item) => item.name === 'create_payment_link')
    const result = await payment.invoke(null, JSON.stringify({ quantity: 1, agreedAmount: null }))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.simulated, true)
    assert.equal(result.amount, 1200)
    assert.equal(ctx.actions[0]?.type, 'create_payment_link')
    assert.equal(ctx.actions[0]?.outcome?.status, 'simulated')
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM payments WHERE contact_id = ?',
      ['ristak-preview-contact']
    )).total), 0)
  } finally {
    await db.run('DELETE FROM product_prices WHERE id = ?', [priceId]).catch(() => {})
    await db.run('DELETE FROM products WHERE id = ?', [productId]).catch(() => {})
  }
})

test('get_payment_status falla cerrado con modo ambiguo, vencimiento inválido, raw cancelado y minor units distintas', async () => {
  const suffix = randomUUID()
  const contactId = `contact_payment_status_closed_${suffix}`
  const agentId = `agent_payment_status_closed_${suffix}`
  const futureDue = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const rows = [
    {
      id: `payment_status_mode_${suffix}`,
      amount: 500,
      currency: 'MXN',
      status: 'paid',
      mode: null,
      due: futureDue,
      metadata: null,
      eventAmount: 500
    },
    {
      id: `payment_status_due_${suffix}`,
      amount: 600,
      currency: 'MXN',
      status: 'sent',
      mode: 'live',
      due: null,
      metadata: null,
      eventAmount: 600
    },
    {
      id: `payment_status_raw_${suffix}`,
      amount: 700,
      currency: 'MXN',
      status: 'pending',
      mode: 'live',
      due: futureDue,
      metadata: { stripe: { status: 'canceled' } },
      eventAmount: 700
    },
    {
      id: `payment_status_minor_${suffix}`,
      amount: 1.004,
      currency: 'KWD',
      status: 'sent',
      mode: 'live',
      due: futureDue,
      metadata: null,
      eventAmount: 1.001
    }
  ]
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Estado de pago cerrado', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    for (const [index, row] of rows.entries()) {
      await db.run(
        `INSERT INTO payments (
           id, contact_id, amount, currency, status, payment_mode, payment_provider,
           public_payment_id, payment_url, due_date, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'stripe', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [row.id, contactId, row.amount, row.currency, row.status, row.mode, `public_${row.id}`, `https://app.example/pay/${row.id}`, row.due, row.metadata ? JSON.stringify(row.metadata) : null]
      )
      await recordConversationalAgentEvent({
        eventId: `event_payment_status_${index}_${suffix}`,
        contactId,
        eventType: 'payment_link_created',
        detail: {
          agentId,
          ledgerPaymentId: row.id,
          amount: row.eventAmount,
          currency: row.currency,
          paymentProvider: 'stripe',
          paymentEnvironment: 'live',
          paymentPurpose: 'purchase'
        },
        throwOnError: true
      })
    }
    const ctx = v2Context([{
      id: 'collect_payment',
      enabled: true,
      paymentMode: 'deposit',
      chargeType: 'deposit',
      collectionMethod: 'payment_link',
      gateway: 'stripe',
      deposit: { enabled: true, mode: 'fixed', amount: 500, currency: 'MXN' }
    }], {
      contactId,
      agentId,
      dryRun: false
    })
    ctx.config.id = agentId
    const result = await createConversationalTools(ctx)
      .find((item) => item.name === 'get_payment_status')
      .invoke(null, '{}')
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.payments.length, 3, 'el monto KWD distinto por minor units no debe vincularse')
    assert.ok(result.payments.every((payment) => payment.fundsConfirmed === false))
    assert.ok(result.payments.every((payment) => payment.canReuseLink === false))
    assert.deepEqual(new Set(result.payments.map((payment) => payment.state)), new Set(['unknown', 'expired', 'cancelled']))
    assert.ok(result.payments.every((payment) => !payment.paymentUrl))
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('v2 expone la unión exacta de capacidades y nunca las tools de silencio/descarte legacy', () => {
  const ctx = v2Context([
    { id: 'schedule_appointment', enabled: true, calendarId: 'calendar_locked' },
    { id: 'collect_payment', enabled: true, productId: 'product_locked', priceId: 'price_locked' },
    { id: 'send_link', enabled: true, linkKind: 'verified_goal', url: 'https://example.com/avanzar' },
    { id: 'handoff_human', enabled: true },
    { id: 'custom_goal', enabled: true, description: 'Recabar los datos del proyecto', completion: 'handoff' }
  ])
  const names = createConversationalTools(ctx).map((item) => item.name)

  for (const expected of [
    'get_business_profile',
    'list_products',
    'get_contact_profile',
    'get_free_slots',
    'book_appointment',
    'create_payment_link',
    'send_trigger_link',
    'send_to_human',
    'mark_ready_to_advance'
  ]) assert.ok(names.includes(expected), `${expected} debe estar expuesta`)

  for (const forbidden of [
    'list_calendars',
    'send_goal_url',
    'update_closing_context',
    'discard_conversation',
    'stay_silent',
    'save_contact_data'
  ]) assert.ok(!names.includes(forbidden), `${forbidden} no debe estar expuesta en v2`)

  const noActions = createConversationalTools(v2Context([
    { id: 'schedule_appointment', enabled: false, calendarId: 'calendar_off' },
    { id: 'handoff_human', enabled: false },
    { id: 'custom_goal', enabled: true, description: 'Enviar el recurso', completion: 'send_link' }
  ])).map((item) => item.name)
  assert.ok(!noActions.includes('get_free_slots'))
  assert.ok(!noActions.includes('book_appointment'))
  assert.ok(!noActions.includes('send_to_human'))
  assert.ok(!noActions.includes('mark_ready_to_advance'))
  assert.ok(!noActions.includes('send_goal_url'))
  assert.ok(!noActions.includes('send_trigger_link'))
  assert.ok(!noActions.includes('save_contact_data'))
})

test('v2 separa físicamente link general y link de objetivo en cada combinación de capacidades', () => {
  const onlyLink = createConversationalTools(v2Context([{
    id: 'send_link',
    enabled: true,
    linkKind: 'verified_goal',
    url: 'https://example.com/recurso'
  }]))
  assert.deepEqual(
    onlyLink.map((item) => item.name).filter((name) => ['send_trigger_link', 'send_goal_url'].includes(name)),
    ['send_trigger_link']
  )
  assert.match(onlyLink.find((item) => item.name === 'send_trigger_link').description, /No crea, prepara, completa ni rastrea un Objetivo propio/i)

  const both = createConversationalTools(v2Context([
    {
      id: 'send_link',
      enabled: true,
      linkKind: 'verified_goal',
      url: 'https://example.com/registro'
    },
    {
      id: 'custom_goal',
      enabled: true,
      description: 'Completar el registro externo',
      completion: 'send_link'
    }
  ]))
  assert.deepEqual(
    both.map((item) => item.name).filter((name) => ['send_trigger_link', 'send_goal_url'].includes(name)),
    ['send_trigger_link', 'send_goal_url']
  )
  assert.match(both.find((item) => item.name === 'send_goal_url').description, /exclusivamente el enlace rastreable/i)
  assert.match(both.find((item) => item.name === 'send_goal_url').description, /No la uses para mandar un enlace general/i)

  const incompleteGoal = createConversationalTools(v2Context([
    {
      id: 'send_link',
      enabled: true,
      linkKind: 'verified_goal',
      url: 'https://example.com/registro'
    },
    {
      id: 'custom_goal',
      enabled: true,
      description: '',
      completion: 'send_link'
    }
  ]))
  assert.deepEqual(
    incompleteGoal.map((item) => item.name).filter((name) => ['send_trigger_link', 'send_goal_url'].includes(name)),
    ['send_trigger_link']
  )
})

test('una reanudación por pago confirmado no puede volver a cobrar aunque la capacidad siga activa', () => {
  const linkCtx = v2Context([{
    id: 'collect_payment',
    enabled: true,
    chargeType: 'direct',
    collectionMethod: 'payment_link',
    gateway: 'stripe',
    direct: { amount: 100, currency: 'MXN', concept: 'Consulta' }
  }])
  linkCtx.paymentResumeClaim = {
    reconciliationId: 'carec_no_double_charge_link',
    claimToken: 'capr_no_double_charge_link',
    agentId: linkCtx.config.id,
    channel: 'whatsapp'
  }
  const linkNames = createConversationalTools(linkCtx).map((item) => item.name)
  assert.ok(linkNames.includes('get_payment_status'))
  assert.ok(!linkNames.includes('create_payment_link'))

  const transferCtx = v2Context([{
    id: 'collect_payment',
    enabled: true,
    chargeType: 'deposit',
    paymentMode: 'deposit',
    collectionMethod: 'bank_transfer',
    currency: 'MXN',
    deposit: {
      enabled: true,
      mode: 'fixed',
      amount: 100,
      currency: 'MXN',
      bankTransferDetails: 'Cuenta de prueba'
    },
    bankTransfer: { details: 'Cuenta de prueba' }
  }])
  transferCtx.paymentResumeClaim = {
    reconciliationId: 'carec_no_double_charge_transfer',
    claimToken: 'capr_no_double_charge_transfer',
    agentId: transferCtx.config.id,
    channel: 'whatsapp'
  }
  const transferNames = createConversationalTools(transferCtx).map((item) => item.name)
  assert.ok(transferNames.includes('get_payment_status'))
  assert.ok(!transferNames.includes('register_deposit_payment_proof'))
})

test('todas las tools v2 conservan JSON Schema estricto y todos sus campos son requeridos', () => {
  const tools = createConversationalTools(v2Context([
    { id: 'schedule_appointment', enabled: true, calendarId: 'calendar_locked' },
    { id: 'collect_payment', enabled: true, productId: 'product_locked', priceId: 'price_locked' },
    { id: 'send_link', enabled: true, linkKind: 'verified_goal', url: 'https://example.com/avanzar' },
    { id: 'handoff_human', enabled: true },
    { id: 'custom_goal', enabled: true, description: 'Meta propia', completion: 'handoff' }
  ]))

  for (const currentTool of tools) {
    assert.equal(currentTool.strict, true, `${currentTool.name} debe ser strict`)
    assert.equal(currentTool.parameters.additionalProperties, false, `${currentTool.name} debe cerrar properties extra`)
    const properties = Object.keys(currentTool.parameters.properties || {}).sort()
    const required = [...(currentTool.parameters.required || [])].sort()
    assert.deepEqual(required, properties, `${currentTool.name} debe requerir todas sus properties`)
  }
  const paymentTool = tools.find((item) => item.name === 'create_payment_link')
  assert.equal('dueDate' in paymentTool.parameters.properties, false, 'v2 no debe permitir que el modelo invente fecha límite')
  const offerTool = tools.find((item) => item.name === 'offer_appointment_slot')
  assert.deepEqual(
    offerTool.parameters.properties.selectionContext.anyOf?.[0]?.enum,
    ['selected_from_options', 'exact_preference', 'replacement', 'neutral']
  )
  for (const unsafeCopyField of ['offerText', 'reply', 'preamble']) {
    assert.equal(
      unsafeCopyField in offerTool.parameters.properties,
      false,
      `offer_appointment_slot no debe aceptar prosa libre en ${unsafeCopyField}`
    )
  }
  for (const bookingTool of tools.filter((item) => ['book_appointment', 'request_human_booking'].includes(item.name))) {
    assert.equal(
      'selectionEvidence' in bookingTool.parameters.properties,
      false,
      `${bookingTool.name} debe derivar la evidencia del hilo y no pedirle al modelo que la recopie`
    )
    assert.equal(
      'startTime' in bookingTool.parameters.properties,
      false,
      `${bookingTool.name} debe recuperar el horario de la oferta guardada por el servidor`
    )
  }
})

test('agenda v2 no convierte "sí quiere ir" en un slot y sí acepta "el martes tipo 10" sobre la oferta anterior', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_selection_evidence_${suffix}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 21 }).startOf('day')
  const nextTuesday = baseDay.plus({ days: (2 - baseDay.weekday + 7) % 7 })
  const slot = nextTuesday.set({ hour: 10, minute: 0, second: 0, millisecond: 0 })
  const startTime = slot.toUTC().toISO()
  const canonicalLabel = buildNativeFreeSlotDays([{
    date: slot.toISODate(),
    timezone,
    slots: [startTime]
  }], timezone)[0].options[0].localLabel
  const initialMessage = 'Hola, quiero agendar una cita de prueba para mi mamá Paty Jiménez. Es primera vez, le duele la rodilla diario desde hace 6 meses y ya confirmó que sí quiere ir. Yo soy quien escribe desde este contacto.'

  try {
    await upsertLocalCalendar({
      id: calendarId,
      locationId: 'location_selection_evidence',
      name: 'Agenda con selección explícita',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [
        { daysOfTheWeek: [2], hours: [{ openHour: 9, openMinute: 0, closeHour: 12, closeMinute: 0 }] }
      ]
    }, { source: 'ristak', syncStatus: 'synced' })

    const ctx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId, allowOverlaps: false }
    ], {
      conversationMessages: [{ role: 'user', content: initialMessage }]
    })
    const book = createConversationalTools(ctx).find((item) => item.name === 'book_appointment')
    const basePayload = {
      title: 'Valoración de rodilla',
      notes: 'Dolor diario desde hace seis meses',
      attendeeName: null,
      attendeeContext: null,
      primaryAttendee: {
        name: 'Paty Jiménez',
        phone: null,
        email: null,
        relation: 'Mamá del contacto'
      },
      guests: []
    }

    const premature = await book.invoke(null, JSON.stringify({
      ...basePayload,
      selectionEvidence: {
        selectionMode: 'accepted_prior_offer',
        selectedStartTime: startTime,
        customerQuote: 'ya confirmó que sí quiere ir',
        assistantOfferQuote: 'martes a las 10:00'
      }
    }))
    assert.equal(premature.ok, false, JSON.stringify(premature))
    assert.equal(premature.confirmationRequired, true)
    assert.match(premature.error, /oferta estructurada|horario/i)
    assert.equal(ctx.actions.length, 0, 'sin selección no debe producir una acción que Modo test pueda materializar')

    ctx.conversationMessages = [
      { role: 'assistant', content: 'con gusto' },
      { role: 'user', content: 'sí' }
    ]
    const arbitraryYes = await book.invoke(null, JSON.stringify({
      ...basePayload,
      selectionEvidence: {
        selectionMode: 'accepted_prior_offer',
        selectedStartTime: startTime,
        customerQuote: 'sí',
        assistantOfferQuote: canonicalLabel
      }
    }))
    assert.equal(arbitraryYes.ok, false)
    assert.equal(arbitraryYes.confirmationRequired, true)
    assert.equal(ctx.actions.length, 0)

    ctx.conversationMessages = [{ role: 'user', content: 'sí quiero agendar' }]
    const arbitraryIntent = await book.invoke(null, JSON.stringify({
      ...basePayload,
      selectionEvidence: {
        selectionMode: 'accepted_prior_offer',
        selectedStartTime: startTime,
        customerQuote: 'sí quiero agendar',
        assistantOfferQuote: canonicalLabel
      }
    }))
    assert.equal(arbitraryIntent.ok, false)
    assert.equal(arbitraryIntent.confirmationRequired, true)
    assert.equal(ctx.actions.length, 0)

    ctx.executionId = `offer_selection_${suffix}`
    const offered = await createConversationalTools(ctx)
      .find((item) => item.name === 'offer_appointment_slot')
      .invoke(null, JSON.stringify({ startTime, appointmentId: null }))
    assert.equal(offered.ok, true, JSON.stringify(offered))
    ctx.actions = []
    ctx.executionId = `confirm_selection_${suffix}`
    ctx.conversationMessages = [
      { role: 'user', content: initialMessage },
      { id: `offer_visible_${suffix}`, role: 'assistant', content: offered.visibleReply },
      { id: ctx.executionId, role: 'user', content: 'el martes tipo 10' }
    ]
    const confirmed = await book.invoke(null, JSON.stringify({
      ...basePayload
    }))
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
    assert.equal(confirmed.simulated, true)
    assert.equal(ctx.actions.length, 1)
    assert.equal(ctx.actions[0]?.confirmationEvidence?.evidenceVerified, true)
    assert.equal(ctx.actions[0]?.confirmationEvidence?.selectedStartTime, startTime)
    assert.equal(ctx.actions[0]?.confirmationEvidence?.customerQuote, 'el martes tipo 10')
    assert.equal(ctx.actions[0]?.confirmationEvidence?.assistantOfferQuote, canonicalLabel)
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('una oferta canónica de un slot ya ocupado no crea selección durable ni permite cobrar anticipo', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_occupied_selection_${suffix}`
  const contactId = `contact_occupied_selection_${suffix}`
  const competitorId = `contact_occupied_competitor_${suffix}`
  const agentId = `agent_occupied_selection_${suffix}`
  const timezone = await getAccountTimezone()
  const currency = await getAccountCurrency()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 25 }).startOf('day')
  const monday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const slot = monday.set({ hour: 10, minute: 0, second: 0, millisecond: 0 })
  const startTime = slot.toUTC().toISO()

  try {
    await upsertLocalCalendar({
      id: calendarId,
      locationId: `location_${suffix}`,
      name: 'Agenda ocupada para evidencia',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [1], hours: [{ openHour: 9, openMinute: 0, closeHour: 12, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto que agenda', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
              (?, 'Contacto que ocupó el slot', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, competitorId]
    )
    await db.run(
      `INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time
       ) VALUES (?, ?, ?, 'Cita existente', 'confirmed', 'confirmed', ?, ?)`,
      [`appointment_occupied_${suffix}`, calendarId, competitorId, startTime, slot.plus({ hours: 1 }).toUTC().toISO()]
    )

    const ctx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId, allowOverlaps: false },
      {
        id: 'collect_payment',
        enabled: true,
        paymentMode: 'deposit',
        chargeType: 'deposit',
        gateway: 'stripe',
        currency,
        deposit: { enabled: true, mode: 'fixed', amount: 500, currency, methods: { paymentLink: true } }
      }
    ], {
      contactId,
      agentId,
      dryRun: false,
      executionId: `message_occupied_${suffix}`,
      accountLocale: { currency }
    })
    ctx.config.id = agentId
    const blocked = await createConversationalTools(ctx)
      .find((item) => item.name === 'offer_appointment_slot')
      .invoke(null, JSON.stringify({ startTime, appointmentId: null }))
    assert.equal(blocked.ok, false)
    assert.equal(blocked.invalidSlot, true)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_selection_verified'`,
      [contactId, agentId]
    )).total), 0)

    const payment = createConversationalTools(ctx).find((item) => item.name === 'create_payment_link')
    const paymentBlocked = await payment.invoke(null, JSON.stringify({ quantity: 1, agreedAmount: null }))
    assert.equal(paymentBlocked.ok, false)
    assert.equal(paymentBlocked.code, 'appointment_deposit_intent_required')
    assert.equal(ctx.actions.filter((action) => action.type === 'create_payment_link').length, 0)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id IN (?, ?)', [contactId, competitorId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('una oferta estructurada adulterada con otro horario jamás autoriza la cita', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_offer_adulterated_${suffix}`
  const contactId = `contact_offer_adulterated_${suffix}`
  const agentId = `agent_offer_adulterated_${suffix}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 26 }).startOf('day')
  const monday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const slot = monday.set({ hour: 16, minute: 0, second: 0, millisecond: 0 })
  const startTime = slot.toUTC().toISO()
  const confirmationId = `message_offer_adulterated_${suffix}`

  try {
    await upsertLocalCalendar({
      id: calendarId,
      locationId: `location_offer_adulterated_${suffix}`,
      name: 'Agenda oferta estructurada',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [1], hours: [{ openHour: 16, openMinute: 0, closeHour: 18, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto oferta adulterada', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    const ctx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId, allowOverlaps: false }
    ], { contactId, agentId, dryRun: false, executionId: `${confirmationId}_offer` })
    ctx.config.id = agentId
    await persistLiveAgentConfig(ctx)
    const tools = createConversationalTools(ctx)
    const offered = await tools.find((item) => item.name === 'offer_appointment_slot')
      .invoke(null, JSON.stringify({ startTime, appointmentId: null }))
    assert.equal(offered.ok, true, JSON.stringify(offered))
    const localLabel = buildNativeFreeSlotDays([{ timezone, slots: [startTime] }], timezone)[0].options[0].localLabel
    ctx.executionId = confirmationId
    ctx.conversationMessages = [
      { id: `offer_visible_${suffix}`, role: 'assistant', content: `${offered.visibleReply} También podría ser a las 5:00 p. m.` },
      { id: confirmationId, role: 'user', content: 'sí, ese horario' }
    ]
    const result = await tools.find((item) => item.name === 'book_appointment')
      .invoke(null, JSON.stringify({
        startTime,
        selectionEvidence: {
          selectionMode: 'accepted_prior_offer',
          selectedStartTime: startTime,
          customerQuote: 'sí, ese horario',
          assistantOfferQuote: localLabel
        },
        title: null,
        notes: null,
        attendeeName: null,
        attendeeContext: null,
        primaryAttendee: null,
        guests: []
      }))

    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, 'appointment_offer_mismatch')
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'appointment_slot_selection_verified'`,
      [contactId]
    )).total), 0)
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?', [contactId])).total), 0)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('allowOverlaps aplica igual al ofrecer y al confirmar una cita', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_overlap_contract_${suffix}`
  const contactId = `contact_overlap_contract_${suffix}`
  const competitorId = `contact_overlap_competitor_${suffix}`
  const agentId = `agent_overlap_contract_${suffix}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 27 }).startOf('day')
  const monday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const slot = monday.set({ hour: 11, minute: 0, second: 0, millisecond: 0 })
  const startTime = slot.toUTC().toISO()

  try {
    await upsertLocalCalendar({
      id: calendarId,
      locationId: `location_overlap_contract_${suffix}`,
      name: 'Agenda con empalme autorizado',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [1], hours: [{ openHour: 10, openMinute: 0, closeHour: 13, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto con empalme', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
              (?, 'Contacto que ya ocupa horario', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, competitorId]
    )
    await db.run(
      `INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time
       ) VALUES (?, ?, ?, 'Cita ya existente', 'confirmed', 'confirmed', ?, ?)`,
      [`appointment_overlap_competitor_${suffix}`, calendarId, competitorId, startTime, slot.plus({ hours: 1 }).toUTC().toISO()]
    )
    const ctx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId, allowOverlaps: true }
    ], { contactId, agentId, dryRun: false, executionId: `message_overlap_${suffix}` })
    ctx.config.id = agentId
    const book = createConversationalTools(ctx).find((item) => item.name === 'book_appointment')
    const result = await book.invoke(null, JSON.stringify({
      startTime,
      selectionEvidence: await authorizeAppointmentOffer(ctx, startTime, timezone),
      title: null,
      notes: null,
      attendeeName: null,
      attendeeContext: null,
      primaryAttendee: null,
      guests: []
    }))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND start_time = ?',
      [calendarId, startTime]
    )).total), 2)
  } finally {
    await db.run(
      `DELETE FROM appointment_creation_requests
       WHERE appointment_id IN (SELECT id FROM appointments WHERE calendar_id = ?)`,
      [calendarId]
    ).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id IN (?, ?)', [contactId, competitorId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('un anticipo no puede iniciar con selección vieja, pasada u ocupada', async () => {
  const suffix = randomUUID()
  const timezone = await getAccountTimezone()
  const calendarId = `calendar_deposit_stale_${suffix}`
  const agentId = `agent_deposit_stale_${suffix}`
  const contacts = ['old', 'past', 'occupied'].map((kind) => `contact_deposit_${kind}_${suffix}`)
  const base = DateTime.now().setZone(timezone).plus({ days: 35 }).startOf('day')
  const monday = base.plus({ days: (1 - base.weekday + 7) % 7 })
  const slots = [14, 15, 16].map((hour) => monday.set({ hour, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO())

  try {
    await upsertLocalCalendar({
      id: calendarId,
      locationId: `location_deposit_stale_${suffix}`,
      name: 'Agenda anticipo vigente',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [1], hours: [{ openHour: 14, openMinute: 0, closeHour: 17, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })
    for (const contactId of contacts) {
      await db.run(
        `INSERT INTO contacts (id, full_name, created_at, updated_at)
         VALUES (?, 'Contacto anticipo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [contactId]
      )
    }

    for (let index = 0; index < contacts.length; index += 1) {
      const contactId = contacts[index]
      const { ctx } = await createLiveDepositSelection({
        calendarId,
        contactId,
        agentId,
        startTime: slots[index],
        timezone,
        executionId: `message_deposit_${index}_${suffix}`
      })
      const selectionRow = await db.get(
        `SELECT id, detail_json FROM conversational_agent_events
         WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_selection_verified'
         ORDER BY created_at DESC LIMIT 1`,
        [contactId, agentId]
      )
      const intentRow = await db.get(
        `SELECT id, detail_json FROM conversational_agent_events
         WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_deposit_intent_pending'
         ORDER BY created_at DESC LIMIT 1`,
        [contactId, agentId]
      )
      assert.ok(selectionRow?.id && intentRow?.id)
      const selection = JSON.parse(selectionRow.detail_json)
      const intent = JSON.parse(intentRow.detail_json)

      if (index === 0) {
        selection.verifiedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString()
        intent.selectionVerifiedAt = selection.verifiedAt
      } else if (index === 1) {
        const past = new Date(Date.now() - 60 * 60 * 1000).toISOString()
        selection.startTime = past
        intent.startTime = past
      } else {
        await db.run(
          `INSERT INTO appointments (
             id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time
           ) VALUES (?, ?, ?, 'Competencia', 'confirmed', 'confirmed', ?, ?)`,
          [`appointment_deposit_occupied_${suffix}`, calendarId, contacts[0], slots[index], new Date(Date.parse(slots[index]) + 3600000).toISOString()]
        )
      }
      await db.run('UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?', [JSON.stringify(selection), selectionRow.id])
      await db.run('UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?', [JSON.stringify(intent), intentRow.id])

      const blocked = await createConversationalTools(ctx)
        .find((item) => item.name === 'create_payment_link')
        .invoke(null, JSON.stringify({ quantity: 1, agreedAmount: null }))
      assert.equal(blocked.ok, false)
      assert.ok([
        'appointment_deposit_selection_stale',
        'appointment_deposit_slot_unavailable'
      ].includes(blocked.code), JSON.stringify(blocked))
      assert.equal(ctx.actions.some((action) => action.type === 'create_payment_link'), false)
    }
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM payments WHERE contact_id IN (?, ?, ?)`,
      contacts
    )).total), 0)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id IN (?, ?, ?)', contacts).catch(() => {})
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id IN (?, ?, ?)', contacts).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('A→B y replay A dejan sólo B activa y jamás reviven el intento anterior', async () => {
  const suffix = randomUUID()
  const timezone = await getAccountTimezone()
  const calendarId = `calendar_selection_change_${suffix}`
  const contactId = `contact_selection_change_${suffix}`
  const agentId = `agent_selection_change_${suffix}`
  const base = DateTime.now().setZone(timezone).plus({ days: 36 }).startOf('day')
  const monday = base.plus({ days: (1 - base.weekday + 7) % 7 })
  const startA = monday.set({ hour: 14 }).toUTC().toISO()
  const startB = monday.set({ hour: 15 }).toUTC().toISO()
  try {
    await upsertLocalCalendar({
      id: calendarId,
      locationId: `location_selection_change_${suffix}`,
      name: 'Agenda cambio A B',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [1], hours: [{ openHour: 14, openMinute: 0, closeHour: 16, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto cambio de horario', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    const selectionA = await createLiveDepositSelection({
      calendarId, contactId, agentId, startTime: startA, timezone, executionId: `message_A_${suffix}`
    })
    await createLiveDepositSelection({
      calendarId, contactId, agentId, startTime: startB, timezone, executionId: `message_B_${suffix}`
    })
    const replayA = await createConversationalTools(selectionA.ctx)
      .find((item) => item.name === 'book_appointment')
      .invoke(null, JSON.stringify({
        startTime: startA,
        selectionEvidence: {
          selectionMode: 'accepted_prior_offer',
          selectedStartTime: startA,
          customerQuote: selectionA.ctx.conversationMessages.at(-1).content,
          assistantOfferQuote: buildNativeFreeSlotDays([{ timezone, slots: [startA] }], timezone)[0].options[0].localLabel
        },
        title: null,
        notes: null,
        attendeeName: null,
        attendeeContext: null,
        primaryAttendee: null,
        guests: []
      }))
    assert.equal(replayA.ok, false)
    assert.equal(replayA.code, 'appointment_selection_event_conflict')
    const selections = await db.all(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_selection_verified'`,
      [contactId, agentId]
    )
    const details = selections.map((row) => JSON.parse(row.detail_json))
    assert.equal(details.filter((detail) => detail.status === 'active').length, 1)
    assert.equal(details.find((detail) => detail.status === 'active').startTime, new Date(startB).toISOString())
    assert.equal(details.find((detail) => detail.startTime === new Date(startA).toISOString()).status, 'superseded')

    const concurrent = await Promise.allSettled([
      createLiveDepositSelection({
        calendarId, contactId, agentId, startTime: startA, timezone, executionId: `message_concurrent_A_${suffix}`
      }),
      createLiveDepositSelection({
        calendarId, contactId, agentId, startTime: startB, timezone, executionId: `message_concurrent_B_${suffix}`
      })
    ])
    assert.ok(concurrent.some((result) => result.status === 'fulfilled'))
    const afterRace = (await db.all(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_selection_verified'`,
      [contactId, agentId]
    )).map((row) => JSON.parse(row.detail_json))
    assert.equal(afterRace.filter((detail) => detail.status === 'active').length, 1)
    const afterRaceIntents = (await db.all(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_deposit_intent_pending'`,
      [contactId, agentId]
    )).map((row) => JSON.parse(row.detail_json))
    assert.equal(afterRaceIntents.filter((detail) => detail.status === 'pending').length, 1)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('replay del turno y retry concurrente/secuencial del link reutilizan proveedor, ledger, evento e intent source_bound', async () => {
  const suffix = randomUUID()
  const timezone = await getAccountTimezone()
  const currency = await getAccountCurrency()
  const calendarId = `calendar_payment_link_retry_${suffix}`
  const contactId = `contact_payment_link_retry_${suffix}`
  const agentId = `agent_payment_link_retry_${suffix}`
  const paymentId = `payment_link_retry_${suffix}`
  const publicPaymentId = `public_link_retry_${suffix}`
  const paymentUrl = `https://app.example/pay/${publicPaymentId}`
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 39 }).startOf('day')
  const monday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const startTime = monday.set({ hour: 15, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO()
  let providerCalls = 0

  try {
    await upsertLocalCalendar({
      id: calendarId,
      locationId: `location_payment_link_retry_${suffix}`,
      name: 'Agenda retry de link',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [1], hours: [{ openHour: 15, openMinute: 0, closeHour: 17, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto retry de link', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    const { ctx } = await createLiveDepositSelection({
      calendarId,
      contactId,
      agentId,
      startTime,
      timezone,
      executionId: `message_payment_link_retry_${suffix}`
    })
    const paymentCapability = ctx.config.capabilitiesConfig.items.find((item) => item.id === 'collect_payment')
    paymentCapability.gateway = 'conekta'
    paymentCapability.expirationMinutes = 60

    setConversationalAgentLivePaymentDependenciesForTests({
      getPaymentGateCheckoutKeys: async (gateway) => ({ provider: gateway, configured: true, paymentMode: 'live' }),
      normalizePaymentGateConfig: (input) => ({ ...input, gateway: 'conekta', billingType: 'single' }),
      createPaymentGateLink: async (config, options) => {
        providerCalls += 1
        await db.run(
          `INSERT INTO payments (
            id, contact_id, amount, currency, status, payment_mode, payment_provider,
            public_payment_id, payment_url, payment_link_request_key, due_date, sent_at,
            created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'sent', 'live', 'conekta', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [paymentId, contactId, config.amount, currency, publicPaymentId, paymentUrl, options.paymentLinkRequestKey, options.expiresAt]
        )
        return {
          publicPaymentId,
          paymentUrl,
          payment: {
            id: paymentId,
            publicPaymentId,
            amount: config.amount,
            currency,
            paymentMode: 'live'
          }
        }
      },
      loadExactPaymentLedger: async ({ idempotencyKey }) => db.get(
        `SELECT id, contact_id, amount, currency, status, payment_mode, payment_provider,
                ghl_invoice_id, public_payment_id, payment_url, payment_link_request_key,
                due_date, sent_at
         FROM payments WHERE id = ? AND contact_id = ? AND payment_link_request_key = ?`,
        [paymentId, contactId, idempotencyKey]
      )
    })

    const paymentTool = createConversationalTools(ctx).find((item) => item.name === 'create_payment_link')
    const [first, concurrentReplay] = await Promise.all([
      paymentTool.invoke(null, JSON.stringify({ quantity: 1, agreedAmount: null })),
      paymentTool.invoke(null, JSON.stringify({ quantity: 1, agreedAmount: null }))
    ])
    const localLabel = buildNativeFreeSlotDays([{ timezone, slots: [startTime] }], timezone)[0].options[0].localLabel
    const replayedBookingTurn = await createConversationalTools(ctx)
      .find((item) => item.name === 'book_appointment')
      .invoke(null, JSON.stringify({
        startTime,
        selectionEvidence: {
          selectionMode: 'accepted_prior_offer',
          selectedStartTime: startTime,
          customerQuote: 'sí, ese horario está bien',
          assistantOfferQuote: localLabel
        },
        title: null,
        notes: null,
        attendeeName: null,
        attendeeContext: null,
        primaryAttendee: null,
        guests: []
      }))
    const second = await paymentTool.invoke(null, JSON.stringify({ quantity: 1, agreedAmount: null }))

    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(concurrentReplay.ok, true, JSON.stringify(concurrentReplay))
    assert.equal(replayedBookingTurn.ok, false, JSON.stringify(replayedBookingTurn))
    assert.equal(replayedBookingTurn.paymentEvidenceRequired, true)
    assert.match(replayedBookingTurn.error, /create_payment_link/)
    assert.equal(second.ok, true, JSON.stringify(second))
    const crossTurnCtx = {
      ...ctx,
      // La marca efímera del turno de agenda ya no existe. El segundo turno
      // debe conservar el alcance sólo por el intent durable source_bound.
      nativePaymentCollectionScope: undefined,
      executionId: `message_payment_link_retry_second_turn_${suffix}`,
      actions: [],
      conversationMessages: [
        { id: `assistant_payment_link_retry_${suffix}`, role: 'assistant', content: 'Aquí está el link de tu anticipo.' },
        { id: `message_payment_link_retry_second_turn_${suffix}`, role: 'user', content: 'Oye, mándame otra vez el mismo link.' }
      ]
    }
    const crossTurn = await createConversationalTools(crossTurnCtx)
      .find((item) => item.name === 'create_payment_link')
      .invoke(null, JSON.stringify({ quantity: 1, agreedAmount: null }))
    assert.equal(crossTurn.ok, true, JSON.stringify(crossTurn))
    assert.equal(first.paymentLink, paymentUrl)
    assert.equal(concurrentReplay.paymentLink, paymentUrl)
    assert.equal(second.paymentLink, paymentUrl)
    assert.equal(crossTurn.paymentLink, paymentUrl)
    assert.match(crossTurn.note, /reutiliz/i)
    assert.equal(providerCalls, 1)
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM payments WHERE contact_id = ?', [contactId])).total), 1)
    const sourceEvents = await db.all(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type IN ('payment_link_created', 'payment_link_reused')`,
      [contactId]
    )
    assert.equal(sourceEvents.length, 1)
    const intentRow = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'appointment_deposit_intent_pending'
       ORDER BY created_at DESC LIMIT 1`,
      [contactId]
    )
    const intent = JSON.parse(intentRow.detail_json)
    assert.equal(intent.status, 'source_bound')
    assert.equal(intent.collectionMethod, 'paymentLink')
    assert.equal(intent.sourceEventId, sourceEvents[0].id)
    assert.ok(intent.claimToken)
    const requestAliases = await db.all(
      `SELECT idempotency_key, binding_event_id, binding_status
       FROM conversational_payment_link_requests
       WHERE contact_id = ?
       ORDER BY created_at ASC`,
      [contactId]
    )
    assert.equal(requestAliases.length, 2)
    assert.ok(requestAliases.every((row) => row.binding_status === 'bound'))
    assert.ok(requestAliases.every((row) => row.binding_event_id === sourceEvents[0].id))
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'appointment_deposit_intent_pending'`,
      [contactId]
    )).total), 1)
    const linkActions = ctx.actions.filter((action) => action.type === 'create_payment_link')
    assert.equal(linkActions.length, 3)
    assert.ok(linkActions.filter((action) => action.outcome?.reused === true).length >= 2)
    assert.ok(linkActions.filter((action) => action.outcome?.priorEquivalentLinkFound === true).length >= 2)
    assert.equal(crossTurnCtx.actions.length, 1)
    assert.equal(crossTurnCtx.actions[0].paymentPurpose, 'appointment_deposit')
    assert.equal(crossTurnCtx.actions[0].outcome?.crossTurnReuse, true)
  } finally {
    setConversationalAgentLivePaymentDependenciesForTests(null)
    await db.run('DELETE FROM conversational_payment_link_requests WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('un Link de pago no expone análisis de fotos ni acepta comprobantes alternos', async () => {
  const suffix = randomUUID()
  const timezone = await getAccountTimezone()
  const currency = await getAccountCurrency()
  const calendarId = `calendar_alternate_receipt_${suffix}`
  const contactId = `contact_alternate_receipt_${suffix}`
  const agentId = `agent_alternate_receipt_${suffix}`
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 38 }).startOf('day')
  const monday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const startTime = monday.set({ hour: 14, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO()

  try {
    await upsertLocalCalendar({
      id: calendarId,
      locationId: `location_alternate_receipt_${suffix}`,
      name: 'Agenda comprobante alterno',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [1], hours: [{ openHour: 14, openMinute: 0, closeHour: 16, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto comprobante alterno', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    const { ctx } = await createLiveDepositSelection({
      calendarId,
      contactId,
      agentId,
      startTime,
      timezone,
      executionId: `message_alternate_selection_${suffix}`
    })
    const paymentCapability = ctx.config.capabilitiesConfig.items
      .find((item) => item.id === 'collect_payment')
    assert.equal(paymentCapability.collectionMethod || 'payment_link', 'payment_link')
    const paymentTools = createConversationalTools(ctx)
    assert.equal(paymentTools.some((item) => item.name === 'create_payment_link'), true)
    assert.equal(paymentTools.some((item) => item.name === 'register_deposit_payment_proof'), false)
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM payments WHERE contact_id = ?', [contactId])).total), 0)
  } finally {
    setNativePaymentReceiptAnalysisHookForTest(null)
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('v2 agenda una frase natural sin pasar por el detector léxico legacy', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_v2_natural_${suffix}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 21 }).startOf('day')
  const nextTuesday = baseDay.plus({ days: (2 - baseDay.weekday + 7) % 7 })
  const slot = nextTuesday.set({ hour: 16, minute: 0, second: 0, millisecond: 0 })

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda v2 natural',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [
        { daysOfTheWeek: [2], hours: [{ openHour: 15, openMinute: 0, closeHour: 18, closeMinute: 0 }] }
      ]
    }, { source: 'ristak', syncStatus: 'synced' })

    const ctx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId, allowOverlaps: false }
    ], {
      conversationMessages: [
        { role: 'user', content: 'Quiero ver horarios para el martes.' },
        { role: 'assistant', content: 'Voy a revisar el calendario.' },
        { role: 'user', content: 'Va, el martes tipo tardecita.' }
      ]
    })
    const getFreeSlots = createConversationalTools(ctx).find((item) => item.name === 'get_free_slots')
    const availability = await getFreeSlots.invoke(null, JSON.stringify({
      startDate: slot.toISODate(),
      endDate: slot.toISODate()
    }))
    assert.equal(availability.ok, true, JSON.stringify(availability))
    assert.ok(availability.total > 0)
    assert.equal('calendarId' in availability, false)
    const returnedSlot = availability.slots
      .flatMap((day) => day.options)
      .find((option) => option.localDate === slot.toISODate() && option.localTime === '16:00')
    assert.ok(returnedSlot, JSON.stringify(availability))
    assert.equal(returnedSlot.startTime, slot.toUTC().toISO())
    assert.match(returnedSlot.localLabel, /4:00/)
    assert.equal(availability.slots[0]?.timezone, timezone)
    assert.match(availability.note, /offer_appointment_slot/)
    ctx.executionId = `offer_natural_${suffix}`
    const offered = await createConversationalTools(ctx)
      .find((item) => item.name === 'offer_appointment_slot')
      .invoke(null, JSON.stringify({ startTime: returnedSlot.startTime, appointmentId: null }))
    assert.equal(offered.ok, true, JSON.stringify(offered))
    ctx.actions = []
    ctx.executionId = `confirm_natural_${suffix}`
    ctx.conversationMessages = [
      { role: 'user', content: 'Quiero ver horarios para el martes.' },
      { id: `offer_visible_natural_${suffix}`, role: 'assistant', content: offered.visibleReply },
      { id: ctx.executionId, role: 'user', content: 'Va, el martes tipo tardecita.' }
    ]
    const book = createConversationalTools(ctx).find((item) => item.name === 'book_appointment')
    const result = await book.invoke(null, JSON.stringify({
      startTime: returnedSlot.startTime,
      selectionEvidence: {
        selectionMode: 'accepted_prior_offer',
        selectedStartTime: returnedSlot.startTime,
        customerQuote: 'Va, el martes tipo tardecita.',
        assistantOfferQuote: returnedSlot.localLabel
      },
      title: null,
      notes: null,
      attendeeName: null,
      attendeeContext: null
    }))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.simulated, true)
    assert.equal('calendarId' in result.appointment, false)
    assert.equal('id' in result.appointment, false)
    assert.match(ctx.actions[0]?.clientRequestId, /^conv-v2-attempt:/)
    assert.equal(ctx.actions[0]?.calendarId, calendarId)
    assert.equal(ctx.actions[0]?.confirmationEvidence?.nativeToolDecision, true)
    assert.equal(ctx.actions[0]?.confirmationEvidence?.evidenceVerified, true)
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('preview conserva identidad sin ids en fecha -> hora -> oferta visible -> sí y no vuelve a pedir la hora', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_preview_two_turns_${suffix}`
  const agentId = `agent_preview_two_turns_${suffix}`
  const previewScopeId = `appointment_preview_${createHash('sha256').update(`scope_${suffix}`).digest('hex').slice(0, 48)}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 24 }).startOf('day')
  const monday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const slot = monday.set({ hour: 10, minute: 0, second: 0, millisecond: 0 })
  const startTime = slot.toUTC().toISO()
  const opening = 'Quiero una cita para mi mamá Paty Jiménez el próximo lunes.'
  const hour = 'A las 10 de la mañana está bien.'
  const confirmation = 'Sí, ese horario le funciona. Agéndala por favor.'
  const config = {
    id: agentId,
    runtimeMode: 'tool_calling_v2',
    aiProvider: 'openai',
    model: 'fake-model',
    replyDelivery: { splitMessagesEnabled: false },
    capabilitiesConfig: {
      schemaVersion: 1,
      items: [{ id: 'schedule_appointment', enabled: true, calendarId, allowOverlaps: false }]
    }
  }

  try {
    await upsertLocalCalendar({
      id: calendarId,
      locationId: `location_preview_two_turns_${suffix}`,
      name: 'Agenda preview dos turnos',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [1], hours: [{ openHour: 10, openMinute: 0, closeHour: 11, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })

    let turnNumber = 0
    const dependencies = {
      resolvePreviewRuntimeConfig: async () => ({
        config,
        runtimeDefaults: { aiProvider: 'openai', model: 'fake-model' }
      }),
      resolveAIRuntime: async () => ({
        apiKey: 'stored-test-key-not-real',
        modelProvider: { kind: 'fake' },
        supportsMultimodalInputs: true
      }),
      hydratePreviewMessages: async (messages) => messages,
      runNativeTurn: async (args) => {
        turnNumber += 1
        assert.equal(args.previewScopeId, previewScopeId)
        const ctx = {
          runtimeMode: 'tool_calling_v2',
          contactId: args.contactId,
          agentId,
          channel: args.channel,
          dryRun: true,
          previewScopeId: args.previewScopeId,
          executionId: args.executionId,
          virtualContact: args.virtualContact,
          conversationMessages: args.messages,
          accountLocale: { currency: 'MXN' },
          actions: [],
          config
        }
        const tools = createConversationalTools(ctx)
        const output = turnNumber === 1
          ? null
          : turnNumber === 2
            ? await tools.find((item) => item.name === 'offer_appointment_slot')
                .invoke(null, JSON.stringify({ startTime, appointmentId: null }))
            : await tools.find((item) => item.name === 'book_appointment')
                .invoke(null, JSON.stringify({
                  title: 'Valoración de rodilla',
                  notes: 'Dolor de rodilla',
                  attendeeName: 'Paty Jiménez',
                  attendeeContext: 'Mamá del contacto',
                  primaryAttendee: {
                    name: 'Paty Jiménez',
                    phone: null,
                    phoneSourceQuote: null,
                    email: null,
                    emailSourceQuote: null,
                    relation: 'Mamá del contacto'
                  },
                  guests: []
                }))
        if (output) assert.equal(output.ok, true, JSON.stringify(output))
        return {
          reply: turnNumber === 1
            ? '¿A qué hora del lunes le gustaría la cita?'
            : turnNumber === 2
              ? output.visibleReply
              : 'Listo, la cita de prueba quedó preparada.',
          ctx,
          model: 'fake-model',
          runtimeMode: 'tool_calling_v2',
          modelCallCount: 1,
          historyTelemetry: args.historyEnvelope.telemetry,
          capabilityManifest: [],
          validationErrors: []
        }
      }
    }

    const first = await runConversationalAgentPreview({
      messages: [{ role: 'user', content: opening }],
      agentId,
      previewScopeId,
      executionId: `preview:offer_${suffix}`
    }, dependencies)
    assert.equal(first.replyParts.length, 1)
    assert.equal(first.actions.length, 0)
    assert.match(first.reply, /qué hora/i)

    const second = await runConversationalAgentPreview({
      // Contrato legacy real del frontend: manda el transcript completo, pero
      // no manda ids de mensaje. El servidor debe reconstruirlos sin perder el
      // turno que originó la oferta.
      messages: [
        { role: 'user', content: opening },
        { role: 'assistant', content: first.reply },
        { role: 'user', content: hour }
      ],
      agentId,
      previewScopeId,
      executionId: `preview:offer_${suffix}`
    }, dependencies)
    assert.equal(second.actions[0]?.type, 'offer_appointment_slot')
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE agent_id = ? AND event_type = 'appointment_slot_preview_offer_created'`,
      [agentId]
    )).total), 1)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
      [agentId]
    )).total), 0, 'una oferta preview nunca debe crear o superseder una oferta live')

    const otherScopeId = `appointment_preview_${createHash('sha256').update(`other_scope_${suffix}`).digest('hex').slice(0, 48)}`
    const wrongSessionCtx = {
      runtimeMode: 'tool_calling_v2',
      contactId: 'ristak-preview-contact',
      agentId,
      channel: 'whatsapp',
      dryRun: true,
      previewScopeId: otherScopeId,
      executionId: `preview:wrong_session_${suffix}`,
      virtualContact: { id: 'ristak-preview-contact', fullName: 'Contacto de prueba' },
      conversationMessages: [
        { id: `wrong_opening_${suffix}`, role: 'user', content: opening },
        { id: `wrong_question_${suffix}`, role: 'assistant', content: first.reply },
        { id: `wrong_hour_${suffix}`, role: 'user', content: hour },
        { id: `wrong_offer_${suffix}`, role: 'assistant', content: second.reply },
        { id: `preview:wrong_session_${suffix}`, role: 'user', content: confirmation }
      ],
      accountLocale: { currency: 'MXN' },
      actions: [],
      config
    }
    const wrongSession = await createConversationalTools(wrongSessionCtx)
      .find((item) => item.name === 'book_appointment')
      .invoke(null, JSON.stringify({
        title: null,
        notes: null,
        attendeeName: null,
        attendeeContext: null,
        primaryAttendee: null,
        guests: []
      }))
    assert.equal(wrongSession.ok, false)
    assert.equal(wrongSession.code, 'appointment_offer_required')
    assert.equal(wrongSessionCtx.actions.length, 0)

    const third = await runConversationalAgentPreview({
      messages: [
        { role: 'user', content: opening },
        { role: 'assistant', content: first.reply },
        { role: 'user', content: hour },
        { role: 'assistant', content: second.reply },
        { role: 'user', content: confirmation }
      ],
      agentId,
      previewScopeId,
      executionId: `preview:confirmation_${suffix}`
    }, dependencies)
    const booking = third.actions.find((action) => action.type === 'book_appointment')
    assert.ok(booking)
    assert.equal(booking.startTime, startTime)
    assert.equal(booking.outcome.status, 'simulated')
    assert.equal(booking.confirmationEvidence.evidenceVerified, true)
    assert.equal(booking.confirmationEvidence.customerQuote, confirmation)
    assert.doesNotMatch(third.reply, /dime la hora|qué hora|hora otra vez/i)

    const normalizedSecond = normalizeConversationalPreviewTranscript([
      { role: 'user', content: opening },
      { role: 'assistant', content: first.reply },
      { role: 'user', content: hour }
    ], { previewScopeId })
    const normalizedThird = normalizeConversationalPreviewTranscript([
      { role: 'user', content: opening },
      { role: 'assistant', content: first.reply },
      { role: 'user', content: hour },
      { role: 'assistant', content: second.reply },
      { role: 'user', content: confirmation }
    ], { previewScopeId })
    assert.deepEqual(
      normalizedThird.slice(0, normalizedSecond.length).map((message) => message.id),
      normalizedSecond.map((message) => message.id),
      'anexar oferta y confirmación no debe reidentificar turnos anteriores'
    )
    const offerRow = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE agent_id = ? AND event_type = 'appointment_slot_preview_offer_created'`,
      [agentId]
    )
    const offerDetail = JSON.parse(offerRow.detail_json)
    assert.equal(offerDetail.offerSourceMessageId, normalizedSecond.at(-1).id)
    assert.equal(booking.confirmationEvidence.offerSourceMessageId, normalizedSecond.at(-1).id)
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ?', [calendarId])).total), 0)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE agent_id = ?', [agentId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('agenda humana revalida, asigna y transfiere sin crear cita ni cerrar conversión', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_human_booking_${suffix}`
  const contactId = `contact_human_booking_${suffix}`
  const agentId = `agent_human_booking_${suffix}`
  const username = `user_human_booking_${suffix}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 24 }).startOf('day')
  const nextWednesday = baseDay.plus({ days: (3 - baseDay.weekday + 7) % 7 })
  const slot = nextWednesday.set({ hour: 16, minute: 0, second: 0, millisecond: 0 })
  let userId = ''

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Raúl Gómez', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO users (username, password_hash, full_name, is_active, created_at, updated_at)
       VALUES (?, 'test-hash', 'Mariana Agenda', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [username]
    )
    userId = String((await db.get('SELECT id FROM users WHERE username = ?', [username]))?.id || '')
    await upsertLocalCalendar({
      id: calendarId,
      locationId: 'location_human_booking',
      name: 'Agenda humana',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [
        { daysOfTheWeek: [3], hours: [{ openHour: 15, openMinute: 0, closeHour: 18, closeMinute: 0 }] }
      ]
    }, { source: 'ristak', syncStatus: 'synced' })

    const ctx = v2Context([{
      id: 'schedule_appointment',
      enabled: true,
      calendarId,
      bookingOwner: 'human',
      handoffUserId: userId,
      handoffUserName: 'Mariana Agenda'
    }], {
      contactId,
      agentId,
      dryRun: false,
      executionId: `message_human_booking_${suffix}`
    })
    ctx.config.id = agentId
    const tools = createConversationalTools(ctx)
    assert.equal(tools.some((item) => item.name === 'book_appointment'), false)
    const request = tools.find((item) => item.name === 'request_human_booking')
    assert.ok(request)
    const payload = {
      startTime: slot.toUTC().toISO(),
      selectionEvidence: await authorizeAppointmentOffer(ctx, slot.toUTC().toISO(), timezone),
      title: 'Valoración de rodilla',
      notes: 'Dolor diario desde hace seis meses',
      attendeeName: null,
      attendeeContext: null,
      primaryAttendee: {
        name: 'Paty Jiménez',
        phone: null,
        email: null,
        relation: 'Mamá del contacto'
      },
      guests: []
    }
    const result = await request.invoke(null, JSON.stringify(payload))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.transferredToHuman, true)
    assert.equal(result.appointmentCreated, false)
    assert.match(result.requestedSlot.title, /Paty Jiménez/)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?',
      [contactId]
    )).total), 0)

    const contact = await db.get('SELECT assigned_user_id FROM contacts WHERE id = ?', [contactId])
    assert.equal(String(contact.assigned_user_id), userId)
    const state = await db.get(
      'SELECT status, signal FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
      [contactId, agentId]
    )
    assert.equal(state.status, 'human')
    assert.equal(state.signal, 'ready_for_human')
    const event = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'human_booking_requested'`,
      [contactId]
    )
    const detail = JSON.parse(event.detail_json)
    assert.equal(detail.appointmentCreated, false)
    assert.equal(detail.objectiveCompleted, false)
    assert.equal(detail.attendeeName, 'Paty Jiménez')
    assert.match(detail.notes, /Raúl Gómez/)
    assert.match(detail.notes, /Mamá del contacto/)
    assert.equal(ctx.actions.find((action) => action.type === 'request_human_booking')?.outcome?.objectiveCompleted, false)

    const replay = await request.invoke(null, JSON.stringify(payload))
    assert.equal(replay.ok, true, JSON.stringify(replay))
    assert.equal(replay.appointmentCreated, false)
    assert.equal(ctx.actions.filter((action) => action.type === 'request_human_booking').at(-1)?.outcome?.replayed, true)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'human_booking_requested'`,
      [contactId]
    )).total), 1)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type IN ('priority_push_notification', 'priority_push_notification_failed')`,
      [contactId]
    )).total), 1)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('un anticipo ligado a agenda humana reanuda request_human_booking y nunca book_appointment', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_human_deposit_${suffix}`
  const contactId = `contact_human_deposit_${suffix}`
  let agent = null
  let agentId = ''
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 25 }).startOf('day')
  const nextWednesday = baseDay.plus({ days: (3 - baseDay.weekday + 7) % 7 })
  const slot = nextWednesday.set({ hour: 16, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO()
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto anticipo humano', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await upsertLocalCalendar({
      id: calendarId,
      locationId: 'location_human_deposit',
      name: 'Agenda humana con anticipo',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [3], hours: [{ openHour: 15, openMinute: 0, closeHour: 18, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })
    agent = await createConversationalAgent({
      name: `Agenda humana con anticipo ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      objective: 'citas',
      capabilitiesConfig: {
        schemaVersion: 3,
        items: [
          { id: 'schedule_appointment', enabled: true, calendarId, bookingOwner: 'human' },
          {
            id: 'collect_payment',
            enabled: true,
            paymentMode: 'deposit',
            collectionMethod: 'payment_link',
            deposit: { enabled: true, mode: 'fixed', amount: 100, currency: 'MXN', methods: { paymentLink: true } }
          }
        ]
      }
    })
    agentId = agent.id
    const ctx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId, bookingOwner: 'human' },
      {
        id: 'collect_payment',
        enabled: true,
        paymentMode: 'deposit',
        collectionMethod: 'payment_link',
        deposit: { enabled: true, mode: 'fixed', amount: 100, currency: 'MXN', methods: { paymentLink: true } }
      }
    ], {
      contactId,
      agentId,
      dryRun: false,
      executionId: `message_human_deposit_${suffix}`,
      accountLocale: { currency: 'MXN' }
    })
    ctx.config.id = agentId
    const selectionEvidence = await authorizeAppointmentOffer(ctx, slot, timezone)
    const first = await createConversationalTools(ctx)
      .find((item) => item.name === 'request_human_booking')
      .invoke(null, JSON.stringify({
        startTime: slot,
        selectionEvidence,
        title: 'Valoración de rodilla',
        notes: 'Anticipo antes de entregar al equipo',
        attendeeName: null,
        attendeeContext: null,
        primaryAttendee: null,
        guests: []
      }))
    assert.equal(first.ok, false, JSON.stringify(first))
    assert.equal(first.paymentEvidenceRequired, true)
    const selection = await db.get(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_selection_verified'`,
      [contactId, agentId]
    )
    const detail = JSON.parse(selection.detail_json)
    assert.equal(detail.bookingOwner, 'human')
    assert.equal(detail.terminalToolName, 'request_human_booking')
    const paymentId = `payment_human_deposit_${suffix}`
    const sourceEventId = `source_human_deposit_${suffix}`
    const reconciliationId = `carec_${createHash('sha256')
      .update([contactId, agentId, sourceEventId, paymentId].join('|'))
      .digest('hex')
      .slice(0, 48)}`
    const reconciliationClaimToken = `capr_${suffix}`
    const sourceBinding = {
      appointmentSelectionEventId: selection.id,
      appointmentSelectionCalendarId: detail.calendarId,
      appointmentSelectionStartTime: detail.startTime,
      appointmentSelectionVerifiedAt: detail.verifiedAt,
      appointmentSelectionRequestDraftHash: detail.appointmentRequestDraftHash,
      appointmentSelectionBookingOwner: detail.bookingOwner,
      appointmentSelectionTerminalToolName: detail.terminalToolName
    }
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        payment_provider, paid_at, created_at, updated_at
      ) VALUES (?, ?, 100, 'MXN', 'paid', 'card', 'live', 'stripe', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    await recordConversationalAgentEvent({
      eventId: sourceEventId,
      contactId,
      eventType: 'payment_link_created',
      detail: {
        agentId,
        ledgerPaymentId: paymentId,
        amount: 100,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentMode: 'deposit',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        ...sourceBinding
      },
      throwOnError: true
    })
    await recordConversationalAgentEvent({
      eventId: reconciliationId,
      contactId,
      eventType: 'payment_reconciliation_v2',
      detail: {
        agentId,
        sourceEventId,
        status: 'processing',
        claimToken: reconciliationClaimToken,
        leaseUntilAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        verifiedEventAppliedAt: new Date().toISOString(),
        ledgerPaymentId: paymentId,
        amount: 100,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        autoResumeAllowed: true,
        manualReviewOnly: false,
        ...sourceBinding
      },
      throwOnError: true
    })

    const resumedCtx = {
      ...ctx,
      executionId: `payment-resume:${reconciliationId}`,
      paymentResumeClaim: {
        reconciliationId,
        claimToken: reconciliationClaimToken,
        agentId,
        channel: 'whatsapp'
      },
      actions: []
    }
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
        contact_id, agent_id, channel, status, signal, updated_at
      ) VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP)`,
      [contactId, agentId]
    )
    const humanBookingEventId = `cae_human_booking_${createHash('sha256')
      .update([agentId, contactId, calendarId, detail.startTime, resumedCtx.executionId].join('\u0000'))
      .digest('hex')
      .slice(0, 48)}`
    setNativeHandoffAfterAssignmentHookForTest(async () => {
      throw new Error('fallo después de reservar anticipo humano')
    })
    const failed = await createConversationalTools(resumedCtx)
      .find((item) => item.name === 'request_human_booking')
      .invoke(null, JSON.stringify({
        title: 'Dato distinto que no debe sustituir el contrato',
        notes: null,
        attendeeName: null,
        attendeeContext: null,
        primaryAttendee: null,
        guests: []
      }))
    assert.equal(failed.ok, false, JSON.stringify(failed))
    assert.equal(await db.get(
      `SELECT id FROM conversational_agent_events WHERE id = ?`,
      [`${reconciliationId}_consumed`]
    ), null)
    assert.equal(await db.get(
      `SELECT id FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'human_booking_requested'`,
      [contactId]
    ), null)
    setNativeHandoffAfterAssignmentHookForTest(null)

    await recordConversationalAgentEvent({
      eventId: humanBookingEventId,
      contactId,
      eventType: 'human_booking_requested',
      detail: {
        agentId,
        bookingOwner: 'human',
        terminalToolName: 'request_human_booking',
        calendarId,
        startTime: detail.startTime,
        depositReconciliationId: reconciliationId,
        depositPaymentId: paymentId,
        selectionRequestDraftHash: '0'.repeat(64),
        sourceMessageId: resumedCtx.executionId,
        appointmentCreated: false
      },
      throwOnError: true
    })
    const collision = await createConversationalTools(resumedCtx)
      .find((item) => item.name === 'request_human_booking')
      .invoke(null, JSON.stringify({
        title: null,
        notes: null,
        attendeeName: null,
        attendeeContext: null,
        primaryAttendee: null,
        guests: []
      }))
    assert.equal(collision.ok, false, JSON.stringify(collision))
    assert.equal(collision.code, 'human_booking_event_contract_conflict')
    assert.equal(await db.get(
      'SELECT id FROM conversational_agent_events WHERE id = ?',
      [`${reconciliationId}_consumed`]
    ), null)
    await db.run('DELETE FROM conversational_agent_events WHERE id = ?', [humanBookingEventId])

    resumedCtx.actions = []
    setNativeHumanBookingAfterCommitHookForTest(async () => {
      throw new Error('crash después del commit humano y antes del push')
    })
    const crashResult = await createConversationalTools(resumedCtx)
        .find((item) => item.name === 'request_human_booking')
        .invoke(null, JSON.stringify({
          title: 'Dato distinto que no debe sustituir el contrato',
          notes: null,
          attendeeName: null,
          attendeeContext: null,
          primaryAttendee: null,
          guests: []
        }))
    assert.match(String(crashResult), /crash después del commit humano/)
    setNativeHumanBookingAfterCommitHookForTest(null)
    assert.equal(resumedCtx.actions.some((action) => action.type === 'book_appointment'), false)
    assert.equal(resumedCtx.actions[0]?.confirmationEvidence?.terminalToolName, 'request_human_booking')
    assert.equal((await db.get(
      `SELECT event_type FROM conversational_agent_events WHERE id = ?`,
      [humanBookingEventId]
    )).event_type, 'human_booking_requested')
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE id LIKE ? AND event_type IN (
         'priority_push_notification_pending',
         'priority_push_notification',
         'priority_push_notification_failed'
       )`,
      [`${reconciliationId}_human_booking_notification%`]
    )).total), 0)
    const consumption = JSON.parse((await db.get(
      `SELECT detail_json FROM conversational_agent_events WHERE id = ?`,
      [`${reconciliationId}_consumed`]
    )).detail_json)
    assert.equal(consumption.status, 'consumed')
    assert.equal(consumption.consumptionType, 'human_booking_request')
    assert.equal(consumption.appointmentId, null)
    assert.equal(consumption.sourceMessageId, `payment-resume:${reconciliationId}`)
    const replayedConsumption = await consumeConversationalAppointmentDepositForHumanBooking({
      reconciliationId,
      contactId,
      agentId,
      paymentId,
      reconciliationClaimToken,
      humanBookingEventId,
      calendarId,
      startTime: detail.startTime,
      selectionRequestDraftHash: detail.appointmentRequestDraftHash,
      sourceMessageId: resumedCtx.executionId
    })
    assert.equal(replayedConsumption.replayed, true)
    await assert.rejects(
      consumeConversationalAppointmentDepositForHumanBooking({
        reconciliationId,
        contactId,
        agentId,
        paymentId,
        reconciliationClaimToken,
        humanBookingEventId: `cae_human_booking_conflict_${suffix}`,
        calendarId,
        startTime: detail.startTime,
        selectionRequestDraftHash: detail.appointmentRequestDraftHash,
        sourceMessageId: resumedCtx.executionId
      }),
      (error) => error?.code === 'human_booking_deposit_consumption_conflict'
    )
    assert.equal((await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      agentId,
      requiredPurpose: 'appointment_deposit'
    })).ok, false)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?',
      [contactId]
    )).total), 0)

    const beforeRecovery = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [reconciliationId]
    )).detail_json)
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?',
      [JSON.stringify({
        ...beforeRecovery,
        status: 'pending',
        result: null,
        claimToken: null,
        leaseUntilAt: null,
        resumeCompletedAt: null,
        completedAt: null
      }), reconciliationId]
    )
    await db.run(
      `UPDATE conversational_agent_state
       SET status = 'paused', signal = NULL, signal_reason = NULL,
           signal_summary = NULL, signal_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE contact_id = ? AND agent_id = ?`,
      [contactId, agentId]
    )
    let recoveryResumeCalls = 0
    setConversationalPaymentResumeHandlerForTest(async () => {
      recoveryResumeCalls += 1
      throw new Error('el recovery humano no debe volver a ejecutar el agente')
    })
    const recovered = await completeConversationalAgentSalePaymentFromInvoice({
      contactId,
      paymentId,
      amount: 100,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    })
    assert.equal(recovered.resumed, true)
    assert.equal(recoveryResumeCalls, 0)
    const recoveredState = await db.get(
      'SELECT status, signal FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
      [contactId, agentId]
    )
    assert.equal(recoveredState.status, 'paused')
    assert.equal(recoveredState.signal, null)
    const recoveredDetail = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [reconciliationId]
    )).detail_json)
    assert.equal(recoveredDetail.status, 'completed')
    assert.equal(recoveredDetail.resumeResult.reason, 'human_booking_already_requested')
    assert.equal((await db.get(
      'SELECT event_type FROM conversational_agent_events WHERE id = ?',
      [`${reconciliationId}_human_booking_notification_pending`]
    )).event_type, 'priority_push_notification_pending')
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE id IN (?, ?)`,
      [
        `${reconciliationId}_human_booking_notification`,
        `${reconciliationId}_human_booking_notification_failed`
      ]
    )).total), 1)
    const recoveryRetry = await completeConversationalAgentSalePaymentFromInvoice({
      contactId,
      paymentId,
      amount: 100,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    })
    assert.equal(recoveryRetry.alreadyCompleted, true)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE id IN (?, ?, ?)`,
      [
        `${reconciliationId}_human_booking_notification_pending`,
        `${reconciliationId}_human_booking_notification`,
        `${reconciliationId}_human_booking_notification_failed`
      ]
    )).total), 2)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'human_booking_requested'`,
      [contactId]
    )).total), 1)
  } finally {
    setNativeHandoffAfterAssignmentHookForTest(null)
    setNativeHumanBookingAfterCommitHookForTest(null)
    setConversationalPaymentResumeHandlerForTest(null)
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('agenda humana rechaza un slot ocupado y no usa la asignación del handoff general', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_human_stale_${suffix}`
  const contactId = `contact_human_stale_${suffix}`
  const competitorId = `contact_competitor_${suffix}`
  const agentId = `agent_human_stale_${suffix}`
  const username = `user_generic_handoff_${suffix}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 26 }).startOf('day')
  const nextWednesday = baseDay.plus({ days: (3 - baseDay.weekday + 7) % 7 })
  const slot = nextWednesday.set({ hour: 16, minute: 0, second: 0, millisecond: 0 })
  let userId = ''

  try {
    await upsertLocalCalendar({
      id: calendarId,
      locationId: 'location_human_stale',
      name: 'Agenda humana ocupada',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [3], hours: [{ openHour: 15, openMinute: 0, closeHour: 18, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto del hilo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
              (?, 'Contacto competidor', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, competitorId]
    )
    await db.run(
      `INSERT INTO users (username, password_hash, full_name, is_active, created_at, updated_at)
       VALUES (?, 'test-hash', 'Persona del handoff general', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [username]
    )
    userId = String((await db.get('SELECT id FROM users WHERE username = ?', [username]))?.id || '')
    await db.run(
      `INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time
       ) VALUES (?, ?, ?, 'Cita competidora', 'confirmed', 'confirmed', ?, ?)`,
      [
        `appointment_competitor_${suffix}`,
        calendarId,
        competitorId,
        slot.toUTC().toISO(),
        slot.plus({ hours: 1 }).toUTC().toISO()
      ]
    )

    const ctx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId, bookingOwner: 'human' },
      { id: 'handoff_human', enabled: true, userId, userName: 'Persona del handoff general' }
    ], {
      contactId,
      agentId,
      dryRun: false,
      executionId: `message_human_stale_${suffix}`
    })
    ctx.config.id = agentId
    const result = await createConversationalTools(ctx)
      .find((item) => item.name === 'offer_appointment_slot')
      .invoke(null, JSON.stringify({ startTime: slot.toUTC().toISO(), appointmentId: null }))

    assert.equal(result.ok, false)
    assert.equal(result.invalidSlot, true)
    assert.equal(await db.get(
      'SELECT id FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
      [contactId, agentId]
    ), null)
    const contact = await db.get('SELECT assigned_user_id FROM contacts WHERE id = ?', [contactId])
    assert.equal(contact.assigned_user_id, null)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type IN ('human_booking_requested', 'priority_push_notification', 'priority_push_notification_failed')`,
      [contactId]
    )).total), 0)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id IN (?, ?)', [contactId, competitorId]).catch(() => {})
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('book_appointment v2 reintenta con la misma llave y reproduce una sola cita real', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_v2_replay_${suffix}`
  const contactId = `contact_v2_replay_${suffix}`
  const username = `user_v2_replay_${suffix}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 28 }).startOf('day')
  const nextMonday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const slot = nextMonday.set({ hour: 16, minute: 0, second: 0, millisecond: 0 })
  let clientRequestId = ''
  let userId = ''

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, 'Cliente replay v2']
    )
    await db.run(
      `INSERT INTO users (username, password_hash, full_name, is_active, created_at, updated_at)
       VALUES (?, 'test-hash', 'Usuario legacy oculto', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [username]
    )
    userId = String((await db.get('SELECT id FROM users WHERE username = ?', [username]))?.id || '')
    await upsertLocalCalendar({
      id: calendarId,
      locationId: 'location_v2_replay',
      name: 'Agenda v2 replay',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [
        { daysOfTheWeek: [1], hours: [{ openHour: 15, openMinute: 0, closeHour: 18, closeMinute: 0 }] }
      ]
    }, { source: 'ristak', syncStatus: 'synced' })

    const ctx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId, allowOverlaps: false }
    ], { contactId, dryRun: false, agentId: null, executionId: `message_replay_${suffix}` })
    ctx.config.id = `agent_v2_replay_${suffix}`
    ctx.config.goalWorkflow = { completion: { mode: 'assign_user', userId } }
    ctx.config.successExtras = [{ type: 'add_tag', tag: 'legacy-hidden-effect' }]
    const book = createConversationalTools(ctx).find((item) => item.name === 'book_appointment')
    const payload = {
      startTime: slot.toUTC().toISO(),
      selectionEvidence: await authorizeAppointmentOffer(ctx, slot.toUTC().toISO(), timezone),
      title: 'Valoración inicial',
      notes: 'Requiere valoración',
      attendeeName: null,
      attendeeContext: null,
      primaryAttendee: {
        name: 'Paty Jiménez',
        phone: null,
        email: null,
        relation: 'Mamá del contacto con dolor de rodilla'
      },
      guests: []
    }
    const first = await book.invoke(null, JSON.stringify(payload))
    clientRequestId = ctx.actions.find((action) => action.type === 'book_appointment')?.clientRequestId || ''
    const replay = await book.invoke(null, JSON.stringify({
      ...payload,
      title: 'Título cosmético distinto'
    }))

    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(replay.ok, true, JSON.stringify(replay))
    assert.deepEqual(replay.appointment, first.appointment)
    assert.equal('id' in first.appointment, false)
    assert.match(clientRequestId, /^conv-v2-attempt:/)
    assert.equal(ctx.actions.filter((action) => action.type === 'book_appointment').at(-1)?.clientRequestId, clientRequestId)
    const rows = await db.all(
      `SELECT id, title, notes FROM appointments
       WHERE calendar_id = ? AND contact_id = ? AND start_time = ?`,
      [calendarId, contactId, slot.toUTC().toISO()]
    )
    assert.equal(rows.length, 1)
    assert.match(rows[0].title, /Paty Jiménez/)
    assert.match(rows[0].notes, /Cliente replay v2/)
    assert.match(rows[0].notes, /Mamá del contacto con dolor de rodilla/)
    const movedSlot = slot.plus({ days: 1, hours: 1 })
    await db.run(
      `UPDATE appointments SET start_time = ?, end_time = ?, title = 'Valoración reprogramada'
       WHERE id = ?`,
      [movedSlot.toUTC().toISO(), movedSlot.plus({ hours: 1 }).toUTC().toISO(), rows[0].id]
    )
    const movedReplay = await book.invoke(null, JSON.stringify(payload))
    assert.equal(movedReplay.ok, false)
    assert.equal(movedReplay.actionCompleted, false)
    assert.equal(movedReplay.appointmentRescheduled, true)
    assert.equal(movedReplay.existingAppointment.startTime, movedSlot.toUTC().toISO())
    assert.equal(movedReplay.existingAppointment.endTime, movedSlot.plus({ hours: 1 }).toUTC().toISO())
    assert.match(movedReplay.error, /ya fue reprogramada/i)
    const movedReplayAction = ctx.actions.filter((action) => action.type === 'book_appointment').at(-1)
    assert.equal(movedReplayAction?.clientRequestId, clientRequestId)
    assert.equal(movedReplayAction?.outcome?.status, 'error')
    assert.equal(movedReplayAction?.outcome?.appointmentRescheduled, true)
    const contact = await db.get('SELECT assigned_user_id FROM contacts WHERE id = ?', [contactId])
    assert.equal(contact.assigned_user_id, null)
    const signalEvent = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'signal_set'
       ORDER BY created_at DESC LIMIT 1`,
      [contactId]
    )
    assert.notEqual(JSON.parse(signalEvent.detail_json).summarySource, 'internal_summary_agent')
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    if (clientRequestId) {
      await db.run('DELETE FROM appointment_creation_requests WHERE client_request_id = ?', [clientRequestId]).catch(() => {})
    }
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
  }
})

test('book_appointment v2 nunca adopta como propia una cita futura de otro calendario', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_bound_target_${suffix}`
  const foreignCalendarId = `calendar_bound_foreign_${suffix}`
  const contactId = `contact_bound_target_${suffix}`
  const agentId = `agent_bound_target_${suffix}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 30 }).startOf('day')
  const targetDay = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const targetSlot = targetDay.set({ hour: 16, minute: 0, second: 0, millisecond: 0 })
  const foreignSlot = targetSlot.minus({ days: 1 })

  try {
    for (const [id, day] of [[calendarId, 1], [foreignCalendarId, 7]]) {
      await upsertLocalCalendar({
        id,
        locationId: `location_${id}`,
        name: id === calendarId ? 'Agenda blindada' : 'Agenda ajena',
        source: 'ristak',
        slotDuration: 60,
        slotInterval: 60,
        openHours: [{ daysOfTheWeek: [day], hours: [{ openHour: 16, openMinute: 0, closeHour: 17, closeMinute: 0 }] }]
      }, { source: 'ristak', syncStatus: 'synced' })
    }
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente con cita ajena', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time
       ) VALUES (?, ?, ?, 'Cita ajena', 'confirmed', 'confirmed', ?, ?)`,
      [
        `appointment_foreign_${suffix}`,
        foreignCalendarId,
        contactId,
        foreignSlot.toUTC().toISO(),
        foreignSlot.plus({ hours: 1 }).toUTC().toISO()
      ]
    )

    const ctx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId }
    ], { contactId, dryRun: false, agentId, executionId: `message_bound_${suffix}` })
    ctx.config.id = agentId
    const result = await createConversationalTools(ctx)
      .find((item) => item.name === 'book_appointment')
      .invoke(null, JSON.stringify({
        startTime: targetSlot.toUTC().toISO(),
        selectionEvidence: await authorizeAppointmentOffer(ctx, targetSlot.toUTC().toISO(), timezone),
        title: null,
        notes: null,
        attendeeName: null,
        attendeeContext: null
      }))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.alreadyBooked, undefined)
    assert.equal(result.appointment.startTime, targetSlot.toUTC().toISO())
    const rows = await db.all(
      'SELECT calendar_id, start_time FROM appointments WHERE contact_id = ? ORDER BY start_time',
      [contactId]
    )
    assert.equal(rows.length, 2)
    assert.equal(rows[1].calendar_id, calendarId)
  } finally {
    await db.run(
      `DELETE FROM appointment_creation_requests
       WHERE appointment_id IN (SELECT id FROM appointments WHERE contact_id = ?)`,
      [contactId]
    ).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id IN (?, ?)', [calendarId, foreignCalendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('v2 toma producto, monto y moneda de la base aunque la capacidad traiga snapshots viejos', async () => {
  const suffix = randomUUID()
  const contactId = `contact_v2_price_${suffix}`
  const productId = `product_v2_price_${suffix}`
  const priceId = `price_v2_price_${suffix}`
  const currency = await getAccountCurrency()

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, 'Cliente precio v2']
    )
    await db.run(
      `INSERT INTO products (id, name, currency, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [productId, 'Servicio real', currency]
    )
    await db.run(
      `INSERT INTO product_prices (id, product_id, name, amount, currency, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [priceId, productId, 'Precio vigente', 123.45, currency]
    )

    const ctx = v2Context([{
      id: 'collect_payment',
      enabled: true,
      productId,
      priceId,
      paymentMode: 'full_payment',
      amount: 99999,
      currency: currency === 'USD' ? 'MXN' : 'USD'
    }], {
      contactId,
      accountLocale: { currency }
    })
    const paymentTool = createConversationalTools(ctx).find((item) => item.name === 'create_payment_link')
    const result = await paymentTool.invoke(null, JSON.stringify({ quantity: 2, agreedAmount: null }))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.simulated, true)
    assert.equal(result.amount, 246.9)
    assert.equal(result.currency, currency)
    assert.equal(result.concept, 'Servicio real · Precio vigente')
    assert.equal(result.catalogEvidence, 'product_price')
    assert.equal('invoiceId' in result, false)

    const catalog = createConversationalTools(ctx).find((item) => item.name === 'list_products')
    const visibleOffer = await catalog.invoke(null, JSON.stringify({ query: null }))
    assert.equal(visibleOffer.total, 1)
    assert.equal(visibleOffer.products[0].name, 'Servicio real')
    assert.equal(visibleOffer.products[0].configuredForPayment, true)
    assert.equal('id' in visibleOffer.products[0], false)
    assert.equal('id' in visibleOffer.products[0].prices[0], false)

    const missingExecutionCtx = v2Context([{
      id: 'collect_payment', enabled: true, productId, priceId, paymentMode: 'full_payment'
    }], { contactId, accountLocale: { currency }, dryRun: false, executionId: '' })
    const blocked = await createConversationalTools(missingExecutionCtx)
      .find((item) => item.name === 'create_payment_link')
      .invoke(null, JSON.stringify({ quantity: 1, agreedAmount: null }))
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'payment_execution_id_missing')
  } finally {
    await db.run('DELETE FROM product_prices WHERE id = ?', [priceId]).catch(() => {})
    await db.run('DELETE FROM products WHERE id = ?', [productId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('anticipo v2 de rango exige agreedAmount real y bloquea montos fuera del rango', async () => {
  const contactId = `contact_v2_range_${randomUUID()}`
  const currency = await getAccountCurrency()
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente rango v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    const rangeCtx = v2Context([{
      id: 'collect_payment',
      enabled: true,
      paymentMode: 'deposit',
      currency,
      deposit: {
        enabled: true,
        mode: 'range',
        minAmount: 50,
        maxAmount: 200,
        currency,
        methods: { paymentLink: true, bankTransfer: false }
      }
    }], { contactId, accountLocale: { currency } })
    const rangeTool = createConversationalTools(rangeCtx).find((item) => item.name === 'create_payment_link')

    const missing = await rangeTool.invoke(null, JSON.stringify({ quantity: 1, agreedAmount: null }))
    assert.equal(missing.ok, false)
    assert.equal(missing.needsData, true)
    assert.equal(missing.requiredField, 'agreedAmount')

    const outside = await rangeTool.invoke(null, JSON.stringify({ quantity: 1, agreedAmount: 225 }))
    assert.equal(outside.ok, false)
    assert.equal(outside.amountOutOfRange, true)

    const middle = await rangeTool.invoke(null, JSON.stringify({ quantity: 1, agreedAmount: 125 }))
    assert.equal(middle.ok, true, JSON.stringify(middle))
    assert.equal(middle.simulated, true)
    assert.equal(middle.amount, 125)

    const fixedCtx = v2Context([{
      id: 'collect_payment',
      enabled: true,
      paymentMode: 'deposit',
      currency,
      deposit: {
        enabled: true,
        mode: 'fixed',
        amount: 100,
        currency,
        methods: { paymentLink: true, bankTransfer: false }
      }
    }], { contactId, accountLocale: { currency } })
    const fixedTool = createConversationalTools(fixedCtx).find((item) => item.name === 'create_payment_link')
    const fixedMismatch = await fixedTool.invoke(null, JSON.stringify({ quantity: 1, agreedAmount: 90 }))
    assert.equal(fixedMismatch.ok, false)
    assert.equal(fixedMismatch.amountMismatch, true)
    const fixedCanonical = await fixedTool.invoke(null, JSON.stringify({ quantity: 1, agreedAmount: null }))
    assert.equal(fixedCanonical.ok, true)
    assert.equal(fixedCanonical.amount, 100)
  } finally {
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('handoff_human v2 asigna sólo al usuario activo configurado y el retry es idempotente', async () => {
  const suffix = randomUUID()
  const username = `handoff_v2_${suffix}`
  const contactId = `contact_handoff_v2_${suffix}`
  const inactiveContactId = `contact_handoff_inactive_v2_${suffix}`
  let userId = ''
  try {
    await db.run(
      `INSERT INTO users (username, password_hash, full_name, is_active, created_at, updated_at)
       VALUES (?, 'test-hash', 'Andrea del equipo', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [username]
    )
    userId = String((await db.get('SELECT id FROM users WHERE username = ?', [username]))?.id || '')
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente handoff v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
              (?, 'Cliente handoff inactivo v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, inactiveContactId]
    )

    const ctx = v2Context([{
      id: 'handoff_human',
      enabled: true,
      userId,
      userName: 'Nombre viejo que no manda'
    }], { contactId, dryRun: false })
    const handoff = createConversationalTools(ctx).find((item) => item.name === 'send_to_human')
    const first = await handoff.invoke(null, JSON.stringify({ motivo: 'Necesita especialista', resumen: 'Caso listo para el equipo' }))
    const replay = await handoff.invoke(null, JSON.stringify({ motivo: 'Necesita especialista', resumen: 'Retry del mismo handoff' }))

    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(first.assignedUserName, 'Andrea del equipo')
    assert.equal(replay.ok, true)
    const assigned = await db.get('SELECT assigned_user_id FROM contacts WHERE id = ?', [contactId])
    assert.equal(String(assigned.assigned_user_id), userId)
    const assignmentEvents = await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'handoff_user_assigned'`,
      [contactId]
    )
    assert.equal(Number(assignmentEvents.total), 1)

    await db.run('UPDATE users SET is_active = 0 WHERE id = ?', [userId])
    const inactiveCtx = v2Context([{
      id: 'handoff_human', enabled: true, userId, userName: 'Andrea del equipo'
    }], { contactId: inactiveContactId, dryRun: false })
    const inactiveHandoff = createConversationalTools(inactiveCtx).find((item) => item.name === 'send_to_human')
    const blocked = await inactiveHandoff.invoke(null, JSON.stringify({ motivo: 'Escalar', resumen: 'Usuario apagado' }))
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'handoff_user_unavailable')
    const inactiveContact = await db.get('SELECT assigned_user_id FROM contacts WHERE id = ?', [inactiveContactId])
    assert.equal(inactiveContact.assigned_user_id, null)
  } finally {
    for (const id of [contactId, inactiveContactId]) {
      await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [id]).catch(() => {})
      await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [id]).catch(() => {})
      await db.run('DELETE FROM contacts WHERE id = ?', [id]).catch(() => {})
    }
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
  }
})

test('handoff v2 revierte asignación y estado juntos si falla entre pasos, y el retry completa ambos', async () => {
  const scenarios = [
    {
      label: 'handoff_human',
      toolName: 'send_to_human',
      capabilities: (userId) => [{
        id: 'handoff_human', enabled: true, userId, userName: 'Responsable atómico'
      }],
      input: {
        motivo: 'Necesita revisión humana',
        resumen: 'El equipo debe continuar el caso'
      },
      expectedStatus: 'human'
    },
    {
      label: 'custom_goal',
      toolName: 'mark_ready_to_advance',
      capabilities: (userId) => [{
        id: 'custom_goal', enabled: true, description: 'Recabar requisitos', completion: 'handoff'
      }, {
        id: 'handoff_human', enabled: true, userId, userName: 'Responsable atómico'
      }],
      input: {
        intencionDetectada: 'Entregó todos los requisitos',
        resumen: 'El equipo ya puede preparar la propuesta',
        urgencia: 'media',
        siguientePaso: 'Preparar propuesta'
      },
      expectedStatus: 'completed'
    }
  ]

  for (const scenario of scenarios) {
    const suffix = randomUUID()
    const username = `handoff_atomic_${scenario.label}_${suffix}`
    const contactId = `contact_handoff_atomic_${scenario.label}_${suffix}`
    const agentId = `agent_handoff_atomic_${scenario.label}_${suffix}`
    const stateId = `state_handoff_atomic_${scenario.label}_${suffix}`
    let userId = ''
    try {
      await db.run(
        `INSERT INTO users (username, password_hash, full_name, is_active, created_at, updated_at)
         VALUES (?, 'test-hash', 'Responsable atómico', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [username]
      )
      userId = String((await db.get('SELECT id FROM users WHERE username = ?', [username]))?.id || '')
      await db.run(
        `INSERT INTO contacts (id, full_name, created_at, updated_at)
         VALUES (?, 'Cliente handoff atómico', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [contactId]
      )
      await db.run(
        `INSERT INTO conversational_agent_state (id, contact_id, agent_id, channel, status, updated_at)
         VALUES (?, ?, ?, 'whatsapp', 'active', CURRENT_TIMESTAMP)`,
        [stateId, contactId, agentId]
      )

      const ctx = v2Context(scenario.capabilities(userId), {
        contactId,
        agentId,
        dryRun: false,
        executionId: `message_handoff_atomic_${suffix}`
      })
      ctx.config.id = agentId
      const handoffTool = createConversationalTools(ctx).find((item) => item.name === scenario.toolName)
      assert.ok(handoffTool, `${scenario.label} debe exponer ${scenario.toolName}`)

      let injectedFailures = 0
      setNativeHandoffAfterAssignmentHookForTest(async ({ contactId: hookContactId, assignment }) => {
        if (hookContactId !== contactId || injectedFailures > 0) return
        injectedFailures += 1
        assert.equal(String(assignment.assignedUserId), userId)
        const error = new Error('Fallo inyectado entre asignación y estado')
        error.code = 'forced_handoff_midpoint_failure'
        throw error
      })

      const failed = await handoffTool.invoke(null, JSON.stringify(scenario.input))
      assert.equal(failed.ok, false, `${scenario.label} debe reportar el fallo intermedio`)
      assert.equal(failed.code, 'forced_handoff_midpoint_failure')
      assert.equal(injectedFailures, 1)

      const rolledBackContact = await db.get('SELECT assigned_user_id FROM contacts WHERE id = ?', [contactId])
      assert.equal(rolledBackContact.assigned_user_id, null, `${scenario.label} debe revertir la asignación`)
      const rolledBackState = await db.get(
        'SELECT status, signal FROM conversational_agent_state WHERE id = ?',
        [stateId]
      )
      assert.equal(rolledBackState.status, 'active')
      assert.equal(rolledBackState.signal, null, `${scenario.label} no debe dejar una señal parcial`)
      const rolledBackEvents = await db.get(
        `SELECT COUNT(*) AS total
         FROM conversational_agent_events
         WHERE contact_id = ? AND event_type IN ('signal_set', 'handoff_user_assigned')`,
        [contactId]
      )
      assert.equal(Number(rolledBackEvents.total), 0, `${scenario.label} debe revertir también su auditoría`)

      setNativeHandoffAfterAssignmentHookForTest(null)
      const retried = await handoffTool.invoke(null, JSON.stringify(scenario.input))
      assert.equal(retried.ok, true, JSON.stringify(retried))
      assert.equal(retried.assignedUserName, 'Responsable atómico')

      const committedContact = await db.get('SELECT assigned_user_id FROM contacts WHERE id = ?', [contactId])
      assert.equal(String(committedContact.assigned_user_id), userId)
      const committedState = await db.get(
        'SELECT status, signal FROM conversational_agent_state WHERE id = ?',
        [stateId]
      )
      assert.equal(committedState.status, scenario.expectedStatus)
      assert.equal(committedState.signal, 'ready_for_human')
      const committedEvents = await db.all(
        `SELECT event_type, COUNT(*) AS total
         FROM conversational_agent_events
         WHERE contact_id = ? AND event_type IN ('signal_set', 'handoff_user_assigned')
         GROUP BY event_type`,
        [contactId]
      )
      assert.deepEqual(
        Object.fromEntries(committedEvents.map((row) => [row.event_type, Number(row.total)])),
        { handoff_user_assigned: 1, signal_set: 1 }
      )

      const replay = await handoffTool.invoke(null, JSON.stringify(scenario.input))
      assert.equal(replay.ok, true, JSON.stringify(replay))
      const assignmentEventsAfterReplay = await db.get(
        `SELECT COUNT(*) AS total FROM conversational_agent_events
         WHERE contact_id = ? AND event_type = 'handoff_user_assigned'`,
        [contactId]
      )
      assert.equal(Number(assignmentEventsAfterReplay.total), 1, `${scenario.label} no debe duplicar la asignación`)
    } finally {
      setNativeHandoffAfterAssignmentHookForTest(null)
      await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
      await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
      if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
    }
  }
})

test('custom_goal v2 asigna por capacidad de forma idempotente sin resumen ni efectos legacy invisibles', async () => {
  const suffix = randomUUID()
  const capabilityUsername = `capability_handoff_v2_${suffix}`
  const legacyUsername = `legacy_hidden_effect_v2_${suffix}`
  const contactId = `contact_hidden_effect_v2_${suffix}`
  let capabilityUserId = ''
  let legacyUserId = ''
  try {
    await db.run(
      `INSERT INTO users (username, password_hash, full_name, is_active, created_at, updated_at)
       VALUES (?, 'test-hash', 'Usuario asignado por capacidad', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [capabilityUsername]
    )
    await db.run(
      `INSERT INTO users (username, password_hash, full_name, is_active, created_at, updated_at)
       VALUES (?, 'test-hash', 'Usuario efecto legacy', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [legacyUsername]
    )
    capabilityUserId = String((await db.get('SELECT id FROM users WHERE username = ?', [capabilityUsername]))?.id || '')
    legacyUserId = String((await db.get('SELECT id FROM users WHERE username = ?', [legacyUsername]))?.id || '')
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente custom v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    const ctx = v2Context([{
      id: 'custom_goal', enabled: true, description: 'Recabar requisitos', completion: 'handoff'
    }, {
      id: 'handoff_human', enabled: true, userId: capabilityUserId, userName: 'Usuario asignado por capacidad'
    }], { contactId, dryRun: false })
    ctx.config.id = `agent_custom_v2_${suffix}`
    ctx.config.goalWorkflow = { completion: { mode: 'assign_user', userId: legacyUserId } }
    ctx.config.successExtras = [{ type: 'add_tag', tag: 'legacy-hidden-effect' }]
    const mark = createConversationalTools(ctx).find((item) => item.name === 'mark_ready_to_advance')
    const result = await mark.invoke(null, JSON.stringify({
      intencionDetectada: 'Compartió todos los requisitos',
      resumen: 'Necesita una propuesta para un proyecto de tres sedes',
      urgencia: 'media',
      siguientePaso: 'Preparar propuesta'
    }))
    const replay = await mark.invoke(null, JSON.stringify({
      intencionDetectada: 'Compartió todos los requisitos',
      resumen: 'Necesita una propuesta para un proyecto de tres sedes',
      urgencia: 'media',
      siguientePaso: 'Preparar propuesta'
    }))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.assignedUserName, 'Usuario asignado por capacidad')
    assert.equal(replay.ok, true, JSON.stringify(replay))
    const contact = await db.get('SELECT assigned_user_id FROM contacts WHERE id = ?', [contactId])
    assert.equal(String(contact.assigned_user_id), capabilityUserId)
    assert.notEqual(String(contact.assigned_user_id), legacyUserId)
    const assignmentEvents = await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'handoff_user_assigned'`,
      [contactId]
    )
    assert.equal(Number(assignmentEvents.total), 1)
    const legacyExtrasEvents = await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'success_extras_applied'`,
      [contactId]
    )
    assert.equal(Number(legacyExtrasEvents.total), 0)
    const signalEvent = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'signal_set'
       ORDER BY created_at DESC LIMIT 1`,
      [contactId]
    )
    const detail = JSON.parse(signalEvent.detail_json)
    assert.equal(detail.summarySource, 'tool_fallback')
    assert.match(detail.summary, /proyecto de tres sedes/i)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    for (const userId of [capabilityUserId, legacyUserId]) {
      if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
    }
  }
})

test('confirmación real de pago v2 no levanta sub-IA ni aplica asignación o extras legacy ocultos', async () => {
  const suffix = randomUUID()
  const contactId = `contact_payment_completion_v2_${suffix}`
  const invoiceId = `invoice_payment_completion_v2_${suffix}`
  let agent = null
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Cliente pago v2', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    agent = await createConversationalAgent({
      name: `Pago v2 sin efectos legacy ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [{
          id: 'collect_payment',
          enabled: true,
          productId: `product_${suffix}`,
          priceId: `price_${suffix}`,
          paymentMode: 'full_payment'
        }]
      },
      goalWorkflow: {
        completion: { mode: 'assign_user', userId: 'legacy_hidden_user', userName: 'Legacy oculto' }
      },
      successExtras: [{ type: 'add_tag', tag: 'legacy-hidden-payment-extra' }]
    })
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
        contact_id, agent_id, channel, status, updated_at
      ) VALUES (?, ?, 'whatsapp', 'active', CURRENT_TIMESTAMP)`,
      [contactId, agent.id]
    )
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'payment_link_created',
      detail: {
        agentId: agent.id,
        invoiceId,
        amount: 725,
        currency: 'MXN',
        runtimeMode: 'tool_calling_v2',
        ledgerPaymentId: invoiceId,
        paymentEnvironment: 'live',
        paymentMode: 'full_payment',
        paymentPurpose: 'purchase',
        appointmentDeposit: false
      }
    })
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, payment_provider,
        ghl_invoice_id, created_at, updated_at
      ) VALUES (?, ?, 725, 'MXN', 'paid', 'live', 'highlevel', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [invoiceId, contactId, invoiceId]
    )

    const result = await completeConversationalAgentSalePaymentFromInvoice({
      contactId,
      invoiceId,
      amount: 725,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    })

    assert.equal(result.matched, true)
    const contact = await db.get('SELECT custom_fields FROM contacts WHERE id = ?', [contactId])
    const customFields = JSON.parse(contact.custom_fields || '{}')
    assert.equal(customFields.assignedUser, undefined)
    const hiddenEffects = await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type IN ('completion_user_assigned', 'success_extras_applied')`,
      [contactId]
    )
    assert.equal(Number(hiddenEffects.total), 0)

    const retry = await completeConversationalAgentSalePaymentFromInvoice({
      contactId,
      invoiceId,
      amount: 725,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    })
    assert.equal(retry.alreadyCompleted, true)
    const idempotentEvents = await db.get(
      `SELECT
         SUM(CASE WHEN event_type = 'signal_set' THEN 1 ELSE 0 END) AS signals,
         SUM(CASE WHEN event_type = 'payment_link_goal_completed' THEN 1 ELSE 0 END) AS completions
       FROM conversational_agent_events WHERE contact_id = ?`,
      [contactId]
    )
    assert.equal(Number(idempotentEvents.signals), 1)
    assert.equal(Number(idempotentEvents.completions), 1)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE id = ?', [invoiceId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('después de pagar continuar reanuda el mismo agente y no cierra el chat', async () => {
  const suffix = randomUUID()
  const contactId = `contact_payment_continue_${suffix}`
  const paymentId = `payment_continue_${suffix}`
  let agent = null
  let resumeCalls = 0
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Cliente pago que continúa', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    agent = await createConversationalAgent({
      name: `Pago y continuar ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      capabilitiesConfig: {
        schemaVersion: 3,
        items: [{
          id: 'collect_payment',
          enabled: true,
          paymentMode: 'full_payment',
          afterPayment: 'continue'
        }]
      }
    })
    await db.run('UPDATE conversational_agents SET enabled = 1 WHERE id = ?', [agent.id])
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
         contact_id, agent_id, channel, status, signal, updated_at
       ) VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP)`,
      [contactId, agent.id]
    )
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'payment_link_created',
      detail: {
        agentId: agent.id,
        ledgerPaymentId: paymentId,
        invoiceId: paymentId,
        amount: 640,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentProvider: 'stripe',
        paymentMode: 'full_payment',
        paymentPurpose: 'purchase',
        appointmentDeposit: false,
        afterPayment: 'continue',
        runtimeMode: 'tool_calling_v2'
      },
      throwOnError: true
    })
    await db.run(
      `INSERT INTO payments (
         id, contact_id, amount, currency, status, payment_mode, payment_provider,
         paid_at, created_at, updated_at
       ) VALUES (?, ?, 640, 'MXN', 'paid', 'live', 'stripe', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    setConversationalPaymentResumeHandlerForTest(async (payload) => {
      resumeCalls += 1
      assert.equal(payload.paymentPurpose, 'purchase')
      assert.equal(payload.reconciliationClaimToken.length > 0, true)
      return { resumed: true, sent: true }
    })

    const input = {
      contactId,
      paymentId,
      amount: 640,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    }
    const result = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(result.signal, 'payment_confirmed')
    assert.equal(result.afterPayment, 'continue')
    assert.equal(result.resumed, true)
    assert.equal(result.objectiveCompleted, true)
    const state = await db.get(
      'SELECT status, signal FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
      [contactId, agent.id]
    )
    assert.equal(state.status, 'active')
    assert.equal(state.signal, null)

    const replay = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(replay.alreadyCompleted, true)
    assert.equal(resumeCalls, 1)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_link_goal_completed'`,
      [contactId]
    )).total), 1)
  } finally {
    setConversationalPaymentResumeHandlerForTest(null)
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('después de pagar pasar al equipo hace handoff durable sin exponer send_to_human al modelo', async () => {
  const suffix = randomUUID()
  const contactId = `contact_payment_handoff_${suffix}`
  const paymentId = `payment_handoff_${suffix}`
  let agent = null
  let resumeCalls = 0
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Cliente pago con handoff', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    agent = await createConversationalAgent({
      name: `Pago y handoff ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      capabilitiesConfig: {
        schemaVersion: 3,
        items: [{
          id: 'collect_payment',
          enabled: true,
          paymentMode: 'full_payment',
          afterPayment: 'handoff'
        }]
      }
    })
    await db.run('UPDATE conversational_agents SET enabled = 1 WHERE id = ?', [agent.id])
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
         contact_id, agent_id, channel, status, signal, updated_at
       ) VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP)`,
      [contactId, agent.id]
    )
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'payment_link_created',
      detail: {
        agentId: agent.id,
        ledgerPaymentId: paymentId,
        invoiceId: paymentId,
        amount: 980,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentProvider: 'stripe',
        paymentMode: 'full_payment',
        paymentPurpose: 'purchase',
        appointmentDeposit: false,
        afterPayment: 'handoff',
        runtimeMode: 'tool_calling_v2'
      },
      throwOnError: true
    })
    await db.run(
      `INSERT INTO payments (
         id, contact_id, amount, currency, status, payment_mode, payment_provider,
         paid_at, created_at, updated_at
       ) VALUES (?, ?, 980, 'MXN', 'paid', 'live', 'stripe', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    setConversationalPaymentResumeHandlerForTest(async () => {
      resumeCalls += 1
      return { resumed: true, sent: true }
    })

    const input = {
      contactId,
      paymentId,
      amount: 980,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    }
    const result = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(result.signal, 'ready_for_human')
    assert.equal(result.afterPayment, 'handoff')
    assert.equal(result.handoffCompleted, true)
    assert.equal(result.objectiveCompleted, true)
    assert.equal(resumeCalls, 0)
    const state = await db.get(
      'SELECT status, signal FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
      [contactId, agent.id]
    )
    assert.equal(state.status, 'human')
    assert.equal(state.signal, 'ready_for_human')

    const replay = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(replay.alreadyCompleted, true)
    const events = await db.get(
      `SELECT
         SUM(CASE WHEN event_type = 'signal_set' THEN 1 ELSE 0 END) AS signals,
         SUM(CASE WHEN event_type = 'payment_after_action_completed' THEN 1 ELSE 0 END) AS handoffs,
         SUM(CASE WHEN event_type = 'payment_link_goal_completed' THEN 1 ELSE 0 END) AS completions
       FROM conversational_agent_events WHERE contact_id = ?`,
      [contactId]
    )
    assert.equal(Number(events.signals), 1)
    assert.equal(Number(events.handoffs), 1)
    assert.equal(Number(events.completions), 1)
  } finally {
    setConversationalPaymentResumeHandlerForTest(null)
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('un webhook de pago nunca pisa una pausa ni un takeover humano existentes', async () => {
  let resumeCalls = 0
  setConversationalPaymentResumeHandlerForTest(async () => {
    resumeCalls += 1
    return { resumed: true, sent: true }
  })

  const runScenario = async ({ afterPayment, status, signal }) => {
    const suffix = randomUUID()
    const contactId = `contact_payment_preserve_${suffix}`
    const paymentId = `payment_preserve_${suffix}`
    let agent = null
    try {
      await db.run(
        `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
         VALUES (?, 'Cliente con estado protegido', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [contactId]
      )
      agent = await createConversationalAgent({
        name: `Pago conserva estado ${suffix}`,
        enabled: false,
        runtimeMode: 'tool_calling_v2',
        capabilitiesConfig: {
          schemaVersion: 3,
          items: [{ id: 'collect_payment', enabled: true, paymentMode: 'full_payment', afterPayment }]
        }
      })
      await db.run('UPDATE conversational_agents SET enabled = 1 WHERE id = ?', [agent.id])
      await db.run(
        `INSERT OR REPLACE INTO conversational_agent_state (
           contact_id, agent_id, channel, status, signal, updated_by, updated_at
         ) VALUES (?, ?, 'whatsapp', ?, ?, 'human', CURRENT_TIMESTAMP)`,
        [contactId, agent.id, status, signal]
      )
      await recordConversationalAgentEvent({
        contactId,
        eventType: 'payment_link_created',
        detail: {
          agentId: agent.id,
          ledgerPaymentId: paymentId,
          invoiceId: paymentId,
          amount: 410,
          currency: 'MXN',
          paymentEnvironment: 'live',
          paymentProvider: 'stripe',
          paymentMode: 'full_payment',
          paymentPurpose: 'purchase',
          appointmentDeposit: false,
          afterPayment,
          runtimeMode: 'tool_calling_v2'
        },
        throwOnError: true
      })
      await db.run(
        `INSERT INTO payments (
           id, contact_id, amount, currency, status, payment_mode, payment_provider,
           paid_at, created_at, updated_at
         ) VALUES (?, ?, 410, 'MXN', 'paid', 'live', 'stripe', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [paymentId, contactId]
      )

      const result = await completeConversationalAgentSalePaymentFromInvoice({
        contactId,
        paymentId,
        amount: 410,
        currency: 'MXN',
        status: 'paid',
        paymentMode: 'live'
      })
      const preserved = await db.get(
        'SELECT status, signal, updated_by FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
        [contactId, agent.id]
      )
      assert.equal(result.statePreserved, true)
      assert.equal(preserved.status, status)
      assert.equal(preserved.signal, signal)
      assert.equal(preserved.updated_by, 'human')
      assert.equal(result.signal, 'payment_confirmed_state_preserved')
      if (afterPayment === 'handoff') assert.equal(result.handoffCompleted, false)
    } finally {
      await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
      await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
      await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
      if (agent?.id) {
        await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
        await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
      }
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    }
  }

  try {
    await runScenario({ afterPayment: 'continue', status: 'human', signal: 'ready_for_human' })
    await runScenario({ afterPayment: 'handoff', status: 'paused', signal: null })
    assert.equal(resumeCalls, 0)
  } finally {
    setConversationalPaymentResumeHandlerForTest(null)
  }
})

test('un pago completo conserva su cierre histórico sin reasignar el contacto a un agente eliminado', async () => {
  const suffix = randomUUID()
  const contactId = `contact_deleted_sales_agent_${suffix}`
  const paymentId = `payment_deleted_sales_agent_${suffix}`
  let agent = null
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Cliente de ventas con agente eliminado', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    agent = await createConversationalAgent({
      name: `Agente de ventas eliminado ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      capabilitiesConfig: {
        schemaVersion: 3,
        items: [{
          id: 'collect_payment',
          enabled: true,
          productId: `product_deleted_agent_${suffix}`,
          priceId: `price_deleted_agent_${suffix}`,
          paymentMode: 'full_payment'
        }]
      }
    })
    const deletedAgentId = agent.id
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
        contact_id, agent_id, channel, status, signal, updated_at
      ) VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP)`,
      [contactId, deletedAgentId]
    )
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'payment_link_created',
      detail: {
        agentId: deletedAgentId,
        ledgerPaymentId: paymentId,
        invoiceId: paymentId,
        amount: 725,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentProvider: 'stripe',
        paymentMode: 'full_payment',
        paymentPurpose: 'purchase',
        appointmentDeposit: false,
        runtimeMode: 'tool_calling_v2'
      },
      throwOnError: true
    })
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, payment_provider,
        paid_at, created_at, updated_at
      ) VALUES (?, ?, 725, 'MXN', 'paid', 'live', 'stripe', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    assert.equal(await deleteConversationalAgent(deletedAgentId), true)

    const input = {
      contactId,
      paymentId,
      amount: 725,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    }
    const result = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(result.matched, true)
    assert.equal(result.signal, 'purchase_completed')
    const state = await db.get(
      'SELECT agent_id, status, signal FROM conversational_agent_state WHERE contact_id = ?',
      [contactId]
    )
    assert.equal(state.agent_id, null)
    assert.equal(state.status, 'completed')
    assert.equal(state.signal, 'purchase_completed')
    assert.equal((await db.get('SELECT status FROM payments WHERE id = ?', [paymentId])).status, 'paid')
    const history = await db.get(
      `SELECT
         SUM(CASE WHEN event_type = 'payment_link_goal_completed' THEN 1 ELSE 0 END) AS completions,
         SUM(CASE WHEN event_type IN ('priority_push_notification', 'priority_push_notification_failed') THEN 1 ELSE 0 END) AS notifications
       FROM conversational_agent_events WHERE contact_id = ?`,
      [contactId]
    )
    assert.equal(Number(history.completions), 1)
    assert.equal(Number(history.notifications), 1)
    const completion = JSON.parse((await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_link_goal_completed'`,
      [contactId]
    )).detail_json)
    assert.equal(completion.agentId, deletedAgentId)
    const retry = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(retry.alreadyCompleted, true)
    assert.equal((await db.get(
      'SELECT agent_id FROM conversational_agent_state WHERE contact_id = ?',
      [contactId]
    )).agent_id, null)
  } finally {
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('reconciliación v2 falla cerrado ante status, monto, moneda, ambiente o ledger insuficientes', async () => {
  const suffix = randomUUID()
  const contactId = `contact_payment_reject_v2_${suffix}`
  const invoiceId = `invoice_payment_reject_v2_${suffix}`
  let agent = null
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Cliente rechazo factual v2', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    agent = await createConversationalAgent({
      name: `Pago v2 factual ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [{ id: 'collect_payment', enabled: true, paymentMode: 'full_payment' }]
      }
    })
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
        contact_id, agent_id, channel, status, updated_at
      ) VALUES (?, ?, 'whatsapp', 'active', CURRENT_TIMESTAMP)`,
      [contactId, agent.id]
    )
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'payment_link_created',
      detail: {
        agentId: agent.id,
        invoiceId,
        ledgerPaymentId: invoiceId,
        amount: 910.25,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentMode: 'full_payment',
        runtimeMode: 'tool_calling_v2'
      }
    })
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, payment_provider,
        ghl_invoice_id, created_at, updated_at
      ) VALUES (?, ?, 910.25, 'MXN', 'paid', 'live', 'highlevel', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [invoiceId, contactId, invoiceId]
    )

    const base = {
      contactId,
      invoiceId,
      amount: 910.25,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    }
    const cases = [
      [{ ...base, status: '' }, 'payment_status_missing'],
      [{ ...base, status: 'pending' }, 'payment_status_not_successful'],
      [{ ...base, amount: 910.24 }, 'payment_amount_mismatch'],
      [{ ...base, currency: 'USD' }, 'payment_currency_mismatch'],
      [{ ...base, paymentMode: '' }, 'payment_environment_missing'],
      [{ ...base, paymentMode: 'test' }, 'payment_environment_mismatch']
    ]
    for (const [input, reason] of cases) {
      const result = await completeConversationalAgentSalePaymentFromInvoice(input)
      assert.equal(result.matched, false, reason)
      assert.equal(result.reason, reason)
    }

    const sourceEvent = await db.get(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_link_created'
       ORDER BY created_at DESC LIMIT 1`,
      [contactId]
    )
    const testModeDetail = { ...JSON.parse(sourceEvent.detail_json), paymentEnvironment: 'test' }
    await db.run('UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?', [JSON.stringify(testModeDetail), sourceEvent.id])
    await db.run("UPDATE payments SET payment_mode = 'test' WHERE id = ?", [invoiceId])
    const sandbox = await completeConversationalAgentSalePaymentFromInvoice({ ...base, paymentMode: 'test' })
    assert.equal(sandbox.reason, 'payment_environment_not_live')
    await db.run('UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?', [JSON.stringify({ ...testModeDetail, paymentEnvironment: 'live' }), sourceEvent.id])
    await db.run("UPDATE payments SET payment_mode = 'live' WHERE id = ?", [invoiceId])

    await db.run("UPDATE payments SET status = 'pending' WHERE id = ?", [invoiceId])
    const unpaid = await completeConversationalAgentSalePaymentFromInvoice(base)
    assert.equal(unpaid.reason, 'payment_ledger_not_paid')
    await db.run("UPDATE payments SET status = 'paid' WHERE id = ?", [invoiceId])
    await db.run('DELETE FROM payments WHERE id = ?', [invoiceId])
    const missingLedger = await completeConversationalAgentSalePaymentFromInvoice(base)
    assert.equal(missingLedger.reason, 'payment_ledger_missing')

    const state = await db.get(
      'SELECT status, signal FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
      [contactId, agent.id]
    )
    assert.equal(state.status, 'active')
    assert.equal(state.signal, null)
    const completions = await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_link_goal_completed'`,
      [contactId]
    )
    assert.equal(Number(completions.total), 0)
  } finally {
    await db.run('DELETE FROM payments WHERE id = ?', [invoiceId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('anticipo de cita v2 conserva la conversación activa y reanuda una sola vez tras validar el ledger', async () => {
  const suffix = randomUUID()
  const contactId = `contact_deposit_resume_v2_${suffix}`
  const paymentId = `transfer_review_${suffix}`
  let agent = null
  let resumeCalls = 0
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Cliente anticipo v2', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    agent = await createConversationalAgent({
      name: `Cita con anticipo v2 ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      objective: 'citas',
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [
          { id: 'schedule_appointment', enabled: true, calendarId: `calendar_${suffix}` },
          {
            id: 'collect_payment',
            enabled: true,
            paymentMode: 'deposit',
            deposit: { enabled: true, mode: 'fixed', amount: 300, currency: 'MXN' }
          }
        ]
      }
    })
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
        contact_id, agent_id, channel, status, signal, updated_at
      ) VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP)`,
      [contactId, agent.id]
    )
    const sourceBinding = await createSyntheticAppointmentDepositSourceBinding({
      contactId,
      agentId: agent.id,
      calendarId: `calendar_${suffix}`,
      suffix: `resume_${suffix}`
    })
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'deposit_transfer_pending_review',
      detail: {
        agentId: agent.id,
        paymentId,
        ledgerPaymentId: paymentId,
        amount: 300,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentMode: 'deposit',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        ...sourceBinding,
        runtimeMode: 'tool_calling_v2'
      }
    })
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        payment_provider, metadata_json, paid_at, created_at, updated_at
      ) VALUES (?, ?, 300, 'MXN', 'paid', 'bank_transfer', 'live', 'manual', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    setConversationalPaymentResumeHandlerForTest(async (payload) => {
      resumeCalls += 1
      assert.equal(payload.paymentPurpose, 'appointment_deposit')
      assert.equal(payload.amount, 300)
      assert.equal(payload.currency, 'MXN')
      return { resumed: true, sent: true }
    })

    const input = {
      contactId,
      paymentId,
      amount: 300,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    }
    const result = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(result.signal, 'deposit_payment_verified')
    assert.equal(result.objectiveCompleted, false)
    assert.equal(result.resumed, true)
    const retry = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(retry.alreadyCompleted, true)
    assert.equal(resumeCalls, 1)

    const state = await db.get(
      'SELECT status, signal FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
      [contactId, agent.id]
    )
    assert.equal(state.status, 'active')
    assert.equal(state.signal, null)
    const purchaseSignals = await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'signal_set'
         AND detail_json LIKE '%purchase_completed%'`,
      [contactId]
    )
    assert.equal(Number(purchaseSignals.total), 0)
  } finally {
    setConversationalPaymentResumeHandlerForTest(null)
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('si cambia la terminal con el anticipo pendiente, conserva el pago y cierra en revisión humana sin retries', async () => {
  const suffix = randomUUID()
  const contactId = `contact_terminal_review_${suffix}`
  const paymentId = `payment_terminal_review_${suffix}`
  const signalTriggerName = `fail_manual_review_signal_${suffix.replaceAll('-', '_')}`
  let agent = null
  let resumeCalls = 0
  let pushCalls = 0
  let replyCalls = 0
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente cambio de terminal', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    agent = await createConversationalAgent({
      name: `Cambio de terminal ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      objective: 'citas',
      capabilitiesConfig: {
        schemaVersion: 3,
        items: [{ id: 'schedule_appointment', enabled: true, calendarId: `calendar_${suffix}`, bookingOwner: 'human' }]
      }
    })
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
        contact_id, agent_id, channel, status, signal, updated_at
      ) VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP)`,
      [contactId, agent.id]
    )
    const sourceBinding = await createSyntheticAppointmentDepositSourceBinding({
      contactId,
      agentId: agent.id,
      calendarId: `calendar_${suffix}`,
      bookingOwner: 'ai',
      suffix: `terminal_change_${suffix}`
    })
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'payment_link_created',
      detail: {
        agentId: agent.id,
        ledgerPaymentId: paymentId,
        amount: 100,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentProvider: 'stripe',
        paymentMode: 'deposit',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        ...sourceBinding,
        runtimeMode: 'tool_calling_v2'
      },
      throwOnError: true
    })
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        payment_provider, paid_at, created_at, updated_at
      ) VALUES (?, ?, 100, 'MXN', 'paid', 'card', 'live', 'stripe', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    await recordConversationalAgentEvent({
      eventId: `recent_generic_notification_${suffix}`,
      contactId,
      eventType: 'priority_push_notification',
      detail: {
        agentId: agent.id,
        signal: 'ready_for_human',
        sent: 1,
        reason: 'notificación genérica previa'
      },
      throwOnError: true
    })
    setConversationalPaymentResumeHandlerForTest(async (payload) => {
      resumeCalls += 1
      assert.equal(payload.bookingOwner, 'ai')
      assert.equal(payload.terminalToolName, 'book_appointment')
      return {
        resumed: false,
        manualReviewRequired: true,
        reason: 'appointment_terminal_configuration_changed'
      }
    })
    setConversationalPriorityNotificationSenderForTest(async () => {
      pushCalls += 1
      if (pushCalls === 1) throw new Error('push manual review falló')
      return { sent: 1 }
    })
    setConversationalPaymentTerminalReplyHandlerForTest(async () => {
      replyCalls += 1
      return { sent: true, testDelivery: true }
    })
    const input = {
      contactId,
      paymentId,
      amount: 100,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    }
    await db.exec(`
      CREATE TRIGGER ${signalTriggerName}
      BEFORE INSERT ON conversational_agent_events
      WHEN NEW.contact_id = '${contactId}' AND NEW.event_type = 'signal_set'
      BEGIN
        SELECT RAISE(ABORT, 'manual review signal insert failure injected');
      END
    `)
    await assert.rejects(
      completeConversationalAgentSalePaymentFromInvoice(input),
      /manual review signal insert failure injected/
    )
    await db.exec(`DROP TRIGGER IF EXISTS ${signalTriggerName}`)
    const rolledBackState = await db.get(
      'SELECT status, signal, updated_by FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
      [contactId, agent.id]
    )
    assert.equal(rolledBackState.status, 'active')
    assert.equal(rolledBackState.signal, null)
    assert.equal(rolledBackState.updated_by, null)
    assert.equal(pushCalls, 0)
    assert.equal(replyCalls, 0)

    await assert.rejects(
      completeConversationalAgentSalePaymentFromInvoice(input),
      /push manual review falló/
    )
    const failedReconciliation = await db.get(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_reconciliation_v2'`,
      [contactId]
    )
    assert.equal(JSON.parse(failedReconciliation.detail_json).status, 'pending')
    const signaledState = await db.get(
      'SELECT status, signal FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
      [contactId, agent.id]
    )
    assert.equal(signaledState.status, 'human')
    assert.equal(signaledState.signal, 'ready_for_human')
    await db.run(
      `UPDATE conversational_agent_state
       SET status = 'paused', signal = NULL, signal_reason = NULL,
           signal_summary = NULL, signal_at = NULL, updated_by = 'staff_after_push_failure',
           updated_at = CURRENT_TIMESTAMP
       WHERE contact_id = ? AND agent_id = ?`,
      [contactId, agent.id]
    )

    const result = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(result.signal, 'appointment_deposit_manual_review_required')
    assert.equal(result.manualReviewRequired, true)
    assert.equal(result.resumed, false)
    assert.equal(resumeCalls, 1)
    assert.equal(pushCalls, 2)
    assert.equal(replyCalls, 1)
    const state = await db.get(
      'SELECT status, signal, updated_by FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
      [contactId, agent.id]
    )
    assert.equal(state.status, 'paused')
    assert.equal(state.signal, null)
    assert.equal(state.updated_by, 'staff_after_push_failure')
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'appointment_deposit_manual_review_required'`,
      [contactId]
    )).total), 1)
    assert.equal((await db.get('SELECT status FROM payments WHERE id = ?', [paymentId])).status, 'paid')
    const reconciliation = await db.get(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_reconciliation_v2'`,
      [contactId]
    )
    const reconciliationDetail = JSON.parse(reconciliation.detail_json)
    assert.equal(reconciliationDetail.status, 'completed')
    assert.equal(reconciliationDetail.autoResumeAllowed, false)
    assert.equal(reconciliationDetail.manualReviewOnly, true)
    assert.equal((await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      agentId: agent.id,
      requiredPurpose: 'appointment_deposit'
    })).ok, false)
    assert.equal((await db.get(
      'SELECT event_type FROM conversational_agent_events WHERE id = ?',
      [`${reconciliation.id}_manual_review_notification_pending`]
    )).event_type, 'priority_push_notification_pending')
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE id IN (?, ?)`,
      [
        `${reconciliation.id}_manual_review_notification`,
        `${reconciliation.id}_manual_review_notification_failed`
      ]
    )).total), 2)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE id = ? AND event_type = 'signal_set'`,
      [`${reconciliation.id}_manual_review_signal`]
    )).total), 1)

    await db.run(
      `UPDATE conversational_agent_state
       SET status = 'active', signal = NULL, signal_reason = NULL, signal_summary = NULL, signal_at = NULL
       WHERE contact_id = ? AND agent_id = ?`,
      [contactId, agent.id]
    )
    await db.run(
      `DELETE FROM conversational_agent_events WHERE id LIKE ?`,
      [`${reconciliation.id}_manual_review%`]
    )
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?',
      [JSON.stringify({
        ...reconciliationDetail,
        status: 'pending',
        result: null,
        claimToken: null,
        leaseUntilAt: null,
        completedAt: null,
        resumeCompletedAt: null,
        resumeResult: null,
        manualReviewEventAppliedAt: null,
        manualReviewNotification: null,
        autoResumeAllowed: false,
        manualReviewOnly: true
      }), reconciliation.id]
    )
    const recoveredFreeze = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(recoveredFreeze.manualReviewRequired, true)
    assert.equal(recoveredFreeze.resumed, false)
    assert.equal(resumeCalls, 1)
    const retry = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(retry.alreadyCompleted, true)
    assert.equal(resumeCalls, 1)
  } finally {
    await db.exec(`DROP TRIGGER IF EXISTS ${signalTriggerName}`).catch(() => {})
    setConversationalPriorityNotificationSenderForTest(null)
    setConversationalPaymentResumeHandlerForTest(null)
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('el webhook respeta un chat ya tomado por humano y congela el anticipo sin relanzar al agente', async () => {
  const suffix = randomUUID()
  const contactId = `contact_preexisting_human_${suffix}`
  const paymentId = `payment_preexisting_human_${suffix}`
  const calendarId = `calendar_preexisting_human_${suffix}`
  let agent = null
  let resumeCalls = 0
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente ya atendido por humano', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await upsertLocalCalendar({
      id: calendarId,
      locationId: `location_preexisting_human_${suffix}`,
      name: 'Agenda para respetar takeover humano',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [1], hours: [{ openHour: 9, openMinute: 0, closeHour: 18, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })
    agent = await createConversationalAgent({
      name: `Chat humano antes del pago ${suffix}`,
      enabled: true,
      runtimeMode: 'tool_calling_v2',
      objective: 'citas',
      capabilitiesConfig: {
        schemaVersion: 3,
        items: [{ id: 'schedule_appointment', enabled: true, calendarId, bookingOwner: 'ai' }]
      }
    })
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
        contact_id, agent_id, channel, status, signal, signal_reason, updated_at
      ) VALUES (?, ?, 'whatsapp', 'human', 'ready_for_human', 'Un humano ya tomó el chat', CURRENT_TIMESTAMP)`,
      [contactId, agent.id]
    )
    const sourceBinding = await createSyntheticAppointmentDepositSourceBinding({
      contactId,
      agentId: agent.id,
      calendarId,
      bookingOwner: 'ai',
      suffix: `preexisting_human_${suffix}`
    })
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'payment_link_created',
      detail: {
        agentId: agent.id,
        ledgerPaymentId: paymentId,
        amount: 100,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentProvider: 'stripe',
        paymentMode: 'deposit',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        ...sourceBinding,
        runtimeMode: 'tool_calling_v2'
      },
      throwOnError: true
    })
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        payment_provider, paid_at, created_at, updated_at
      ) VALUES (?, ?, 100, 'MXN', 'paid', 'card', 'live', 'stripe', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    setConversationalPaymentResumeHandlerForTest(async () => {
      resumeCalls += 1
      throw new Error('un pago no debe reactivar un chat que ya tomó una persona')
    })

    const input = {
      contactId,
      paymentId,
      amount: 100,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    }
    const result = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(result.signal, 'appointment_deposit_manual_review_required')
    assert.equal(result.manualReviewRequired, true)
    assert.equal(result.resumed, false)
    assert.equal(resumeCalls, 0)
    const state = await db.get(
      'SELECT status, signal FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
      [contactId, agent.id]
    )
    assert.equal(state.status, 'human')
    assert.equal(state.signal, 'ready_for_human')
    assert.equal((await db.get('SELECT status FROM payments WHERE id = ?', [paymentId])).status, 'paid')
    const reconciliation = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_reconciliation_v2'`,
      [contactId]
    )
    const reconciliationDetail = JSON.parse(reconciliation.detail_json)
    assert.equal(reconciliationDetail.status, 'completed')
    assert.equal(reconciliationDetail.autoResumeAllowed, false)
    assert.equal(reconciliationDetail.manualReviewOnly, true)
    assert.equal(reconciliationDetail.resumeResult.reason, 'conversation_state_not_runnable_before_payment_resume')
    assert.equal((await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      agentId: agent.id,
      requiredPurpose: 'appointment_deposit'
    })).ok, false)
    const retry = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(retry.alreadyCompleted, true)
    assert.equal(resumeCalls, 0)
  } finally {
    setConversationalPaymentResumeHandlerForTest(null)
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('un takeover humano entre la lectura y la reanudación nunca es borrado por el webhook', async () => {
  const suffix = randomUUID()
  const contactId = `contact_takeover_race_${suffix}`
  const paymentId = `payment_takeover_race_${suffix}`
  const calendarId = `calendar_takeover_race_${suffix}`
  let agent = null
  let resumeCalls = 0
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente con takeover concurrente', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await upsertLocalCalendar({
      id: calendarId,
      locationId: `location_takeover_race_${suffix}`,
      name: 'Agenda takeover concurrente',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [1], hours: [{ openHour: 9, openMinute: 0, closeHour: 18, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })
    agent = await createConversationalAgent({
      name: `Takeover concurrente ${suffix}`,
      enabled: true,
      runtimeMode: 'tool_calling_v2',
      objective: 'citas',
      capabilitiesConfig: {
        schemaVersion: 3,
        items: [{ id: 'schedule_appointment', enabled: true, calendarId, bookingOwner: 'ai' }]
      }
    })
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
        contact_id, agent_id, channel, status, signal, updated_at
      ) VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP)`,
      [contactId, agent.id]
    )
    const sourceBinding = await createSyntheticAppointmentDepositSourceBinding({
      contactId,
      agentId: agent.id,
      calendarId,
      bookingOwner: 'ai',
      suffix: `takeover_race_${suffix}`
    })
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'payment_link_created',
      detail: {
        agentId: agent.id,
        ledgerPaymentId: paymentId,
        amount: 100,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentProvider: 'stripe',
        paymentMode: 'deposit',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        ...sourceBinding,
        runtimeMode: 'tool_calling_v2'
      },
      throwOnError: true
    })
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        payment_provider, paid_at, created_at, updated_at
      ) VALUES (?, ?, 100, 'MXN', 'paid', 'card', 'live', 'stripe', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    setConversationalPaymentAfterStateInspectionHookForTest(async ({ contactId: inspectedContactId }) => {
      assert.equal(inspectedContactId, contactId)
      await db.run(
        `UPDATE conversational_agent_state
         SET status = 'human', signal = 'ready_for_human', signal_reason = 'Takeover concurrente',
             updated_by = 'human', updated_at = CURRENT_TIMESTAMP
         WHERE contact_id = ? AND agent_id = ?`,
        [contactId, agent.id]
      )
    })
    setConversationalPaymentResumeHandlerForTest(async () => {
      resumeCalls += 1
      const current = await db.get(
        'SELECT status, signal FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
        [contactId, agent.id]
      )
      assert.equal(current.status, 'human')
      assert.equal(current.signal, 'ready_for_human')
      return {
        resumed: false,
        manualReviewRequired: true,
        reason: 'conversation_state_not_runnable'
      }
    })

    const result = await completeConversationalAgentSalePaymentFromInvoice({
      contactId,
      paymentId,
      amount: 100,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    })
    assert.equal(result.manualReviewRequired, true)
    assert.equal(result.resumed, false)
    assert.equal(resumeCalls, 1)
    const state = await db.get(
      'SELECT status, signal FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
      [contactId, agent.id]
    )
    assert.equal(state.status, 'human')
    assert.equal(state.signal, 'ready_for_human')
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?',
      [contactId]
    )).total), 0)
  } finally {
    setConversationalPaymentAfterStateInspectionHookForTest(null)
    setConversationalPaymentResumeHandlerForTest(null)
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('si eliminan el agente con un anticipo pendiente, el webhook conserva el pago y escala el chat liberado', async () => {
  const suffix = randomUUID()
  const contactId = `contact_deleted_agent_deposit_${suffix}`
  const paymentId = `payment_deleted_agent_deposit_${suffix}`
  const calendarId = `calendar_deleted_agent_deposit_${suffix}`
  let agent = null
  let resumeCalls = 0
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente de agente eliminado', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await upsertLocalCalendar({
      id: calendarId,
      locationId: `location_deleted_agent_${suffix}`,
      name: 'Agenda con anticipo y agente eliminado',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [1], hours: [{ openHour: 9, openMinute: 0, closeHour: 18, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })
    agent = await createConversationalAgent({
      name: `Agente que se elimina con anticipo ${suffix}`,
      enabled: true,
      runtimeMode: 'tool_calling_v2',
      objective: 'citas',
      capabilitiesConfig: {
        schemaVersion: 3,
        items: [{ id: 'schedule_appointment', enabled: true, calendarId, bookingOwner: 'ai' }]
      }
    })
    const deletedAgentId = agent.id
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
        contact_id, agent_id, channel, status, signal, updated_at
      ) VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP)`,
      [contactId, deletedAgentId]
    )
    const sourceBinding = await createSyntheticAppointmentDepositSourceBinding({
      contactId,
      agentId: deletedAgentId,
      calendarId,
      bookingOwner: 'ai',
      suffix: `deleted_agent_${suffix}`
    })
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'payment_link_created',
      detail: {
        agentId: deletedAgentId,
        ledgerPaymentId: paymentId,
        amount: 100,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentProvider: 'stripe',
        paymentMode: 'deposit',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        ...sourceBinding,
        runtimeMode: 'tool_calling_v2'
      },
      throwOnError: true
    })
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        payment_provider, paid_at, created_at, updated_at
      ) VALUES (?, ?, 100, 'MXN', 'paid', 'card', 'live', 'stripe', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    assert.equal(await deleteConversationalAgent(deletedAgentId), true)
    assert.equal(await db.get('SELECT id FROM conversational_agents WHERE id = ?', [deletedAgentId]), null)
    setConversationalPaymentResumeHandlerForTest(async () => {
      resumeCalls += 1
      throw new Error('un agente eliminado nunca debe reanudarse')
    })

    const input = {
      contactId,
      paymentId,
      amount: 100,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    }
    const result = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(result.matched, true)
    assert.equal(result.signal, 'appointment_deposit_manual_review_required')
    assert.equal(result.manualReviewRequired, true)
    assert.equal(result.resumed, false)
    assert.equal(resumeCalls, 0)
    assert.equal((await db.get('SELECT status FROM payments WHERE id = ?', [paymentId])).status, 'paid')
    const state = await db.get(
      'SELECT agent_id, status, signal FROM conversational_agent_state WHERE contact_id = ?',
      [contactId]
    )
    assert.equal(state.agent_id, null)
    assert.equal(state.status, 'human')
    assert.equal(state.signal, 'ready_for_human')
    const reconciliation = await db.get(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_reconciliation_v2'`,
      [contactId]
    )
    const reconciliationDetail = JSON.parse(reconciliation.detail_json)
    assert.equal(reconciliationDetail.status, 'completed')
    assert.equal(reconciliationDetail.agentId, deletedAgentId)
    assert.equal(reconciliationDetail.autoResumeAllowed, false)
    assert.equal(reconciliationDetail.manualReviewOnly, true)
    const review = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'appointment_deposit_manual_review_required'`,
      [contactId]
    )
    assert.equal(JSON.parse(review.detail_json).reason, 'native_agent_missing_or_changed')
    assert.equal((await db.get(
      'SELECT event_type FROM conversational_agent_events WHERE id = ?',
      [`${reconciliation.id}_manual_review_notification_pending`]
    )).event_type, 'priority_push_notification_pending')
    assert.equal((await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      agentId: deletedAgentId,
      requiredPurpose: 'appointment_deposit'
    })).ok, false)
    const retry = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(retry.alreadyCompleted, true)
    assert.equal(resumeCalls, 0)
  } finally {
    setConversationalPaymentResumeHandlerForTest(null)
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('un anticipo tardío de un agente eliminado no secuestra al agente que reemplazó el chat', async () => {
  const suffix = randomUUID()
  const contactId = `contact_deleted_deposit_reassigned_${suffix}`
  const paymentId = `payment_deleted_deposit_reassigned_${suffix}`
  const calendarId = `calendar_deleted_deposit_reassigned_${suffix}`
  let deletedAgent = null
  let currentAgent = null
  let resumeCalls = 0
  let terminalReplyCalls = 0
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente reasignado con anticipo tardío', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await upsertLocalCalendar({
      id: calendarId,
      locationId: `location_deleted_deposit_reassigned_${suffix}`,
      name: 'Agenda de agente eliminado y reemplazado',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [1], hours: [{ openHour: 9, openMinute: 0, closeHour: 18, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })
    deletedAgent = await createConversationalAgent({
      name: `Agente eliminado con anticipo pendiente ${suffix}`,
      enabled: true,
      runtimeMode: 'tool_calling_v2',
      capabilitiesConfig: {
        schemaVersion: 3,
        items: [{ id: 'schedule_appointment', enabled: true, calendarId, bookingOwner: 'ai' }]
      }
    })
    const deletedAgentId = deletedAgent.id
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
         contact_id, agent_id, channel, status, signal, updated_at
       ) VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP)`,
      [contactId, deletedAgentId]
    )
    const sourceBinding = await createSyntheticAppointmentDepositSourceBinding({
      contactId,
      agentId: deletedAgentId,
      calendarId,
      bookingOwner: 'ai',
      suffix: `deleted_deposit_reassigned_${suffix}`
    })
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'payment_link_created',
      detail: {
        agentId: deletedAgentId,
        channel: 'whatsapp',
        ledgerPaymentId: paymentId,
        invoiceId: paymentId,
        amount: 100,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentProvider: 'stripe',
        paymentMode: 'deposit',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        afterPayment: 'continue',
        ...sourceBinding,
        runtimeMode: 'tool_calling_v2'
      },
      throwOnError: true
    })
    await db.run(
      `INSERT INTO payments (
         id, contact_id, amount, currency, status, payment_method, payment_mode,
         payment_provider, paid_at, created_at, updated_at
       ) VALUES (?, ?, 100, 'MXN', 'paid', 'card', 'live', 'stripe', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    assert.equal(await deleteConversationalAgent(deletedAgentId), true)
    currentAgent = await createConversationalAgent({
      name: `Agente reemplazo protegido del anticipo ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2'
    })
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
         contact_id, agent_id, channel, status, signal, updated_by, updated_at
       ) VALUES (?, ?, 'whatsapp', 'active', NULL, 'replacement_agent', CURRENT_TIMESTAMP)`,
      [contactId, currentAgent.id]
    )
    setConversationalPaymentResumeHandlerForTest(async () => {
      resumeCalls += 1
      throw new Error('el agente eliminado no debe reanudarse')
    })
    setConversationalPaymentTerminalReplyHandlerForTest(async () => {
      terminalReplyCalls += 1
      return { sent: true, testDelivery: true }
    })

    const result = await completeConversationalAgentSalePaymentFromInvoice({
      contactId,
      paymentId,
      amount: 100,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    })
    assert.equal(result.matched, true)
    assert.equal(result.signal, 'appointment_deposit_manual_review_required')
    assert.equal(result.manualReviewRequired, true)
    assert.equal(resumeCalls, 0)
    assert.equal(terminalReplyCalls, 0)
    const protectedState = await db.get(
      `SELECT status, signal, updated_by
       FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      [contactId, currentAgent.id]
    )
    assert.equal(protectedState.status, 'active')
    assert.equal(protectedState.signal, null)
    assert.equal(protectedState.updated_by, 'replacement_agent')
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'signal_set'`,
      [contactId, currentAgent.id]
    )).total), 0)
  } finally {
    setConversationalPaymentResumeHandlerForTest(null)
    setConversationalPaymentTerminalReplyHandlerForTest(null)
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    for (const agent of [deletedAgent, currentAgent]) {
      if (!agent?.id) continue
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('un webhook legacy sin agente fuente nunca se adjudica al agente que hoy atiende el contacto', async () => {
  const suffix = randomUUID()
  const contactId = `contact_unowned_payment_source_${suffix}`
  const paymentId = `payment_unowned_source_${suffix}`
  let currentAgent = null
  let resumeCalls = 0
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente con cobro legacy sin dueño', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    currentAgent = await createConversationalAgent({
      name: `Agente actual ajeno al cobro legacy ${suffix}`,
      enabled: true,
      runtimeMode: 'tool_calling_v2'
    })
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
         contact_id, agent_id, channel, status, signal, updated_by, updated_at
       ) VALUES (?, ?, 'whatsapp', 'active', NULL, 'current_agent_before_legacy_webhook', CURRENT_TIMESTAMP)`,
      [contactId, currentAgent.id]
    )
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'payment_link_created',
      detail: {
        channel: 'whatsapp',
        ledgerPaymentId: paymentId,
        invoiceId: paymentId,
        amount: 640,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentProvider: 'stripe',
        paymentMode: 'full_payment',
        paymentPurpose: 'purchase',
        appointmentDeposit: false,
        afterPayment: 'continue',
        runtimeMode: 'tool_calling_v2'
      },
      throwOnError: true
    })
    await db.run(
      `INSERT INTO payments (
         id, contact_id, amount, currency, status, payment_mode, payment_provider,
         paid_at, created_at, updated_at
       ) VALUES (?, ?, 640, 'MXN', 'paid', 'live', 'stripe', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    setConversationalPaymentResumeHandlerForTest(async () => {
      resumeCalls += 1
      return { resumed: true, sent: true }
    })

    const result = await completeConversationalAgentSalePaymentFromInvoice({
      contactId,
      paymentId,
      amount: 640,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    })
    assert.equal(result.matched, true)
    assert.equal(result.agentId, null)
    assert.equal(result.statePreserved, true)
    assert.equal(result.signal, 'payment_confirmed_state_preserved')
    assert.equal(resumeCalls, 0)
    const protectedState = await db.get(
      `SELECT status, signal, updated_by
       FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      [contactId, currentAgent.id]
    )
    assert.equal(protectedState.status, 'active')
    assert.equal(protectedState.signal, null)
    assert.equal(protectedState.updated_by, 'current_agent_before_legacy_webhook')
  } finally {
    setConversationalPaymentResumeHandlerForTest(null)
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    if (currentAgent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [currentAgent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [currentAgent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('un anticipo legado sin selección ni draft completos pasa a revisión y jamás recicla el pago', async () => {
  const suffix = randomUUID()
  const contactId = `contact_manual_appointment_deposit_${suffix}`
  const paymentId = `payment_manual_appointment_deposit_${suffix}`
  let agent = null
  let resumeCalls = 0
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente comprobante ambiguo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    agent = await createConversationalAgent({
      name: `Anticipo manual ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      objective: 'citas',
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [
          { id: 'schedule_appointment', enabled: true, calendarId: `calendar_manual_${suffix}` },
          { id: 'collect_payment', enabled: true, paymentMode: 'deposit', deposit: { enabled: true, mode: 'fixed', amount: 300, currency: 'MXN' } }
        ]
      }
    })
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
         contact_id, agent_id, channel, status, signal, updated_at
       ) VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP)`,
      [contactId, agent.id]
    )
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'deposit_transfer_pending_review',
      detail: {
        agentId: agent.id,
        ledgerPaymentId: paymentId,
        amount: 300,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentMode: 'deposit',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        runtimeMode: 'tool_calling_v2'
      },
      throwOnError: true
    })
    await db.run(
      `INSERT INTO payments (
         id, contact_id, amount, currency, status, payment_method, payment_mode,
         payment_provider, paid_at, created_at, updated_at
       ) VALUES (?, ?, 300, 'MXN', 'paid', 'bank_transfer', 'live', 'manual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    setConversationalPaymentResumeHandlerForTest(async () => {
      resumeCalls += 1
      return { resumed: true }
    })
    const result = await completeConversationalAgentSalePaymentFromInvoice({
      contactId,
      paymentId,
      amount: 300,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    })
    assert.equal(result.signal, 'appointment_deposit_manual_review_required')
    assert.equal(result.manualReviewRequired, true)
    assert.equal(result.resumed, false)
    assert.equal(resumeCalls, 0)
    assert.equal((await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      agentId: agent.id,
      requiredPurpose: 'appointment_deposit'
    })).ok, false)
    const reconciliation = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_reconciliation_v2'`,
      [contactId]
    )
    const reconciliationDetail = JSON.parse(reconciliation.detail_json)
    assert.equal(reconciliationDetail.status, 'completed')
    assert.equal(reconciliationDetail.autoResumeAllowed, false)
    assert.equal(reconciliationDetail.manualReviewOnly, true)
    const manualReview = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'appointment_deposit_manual_review_required'`,
      [contactId]
    )
    assert.equal(JSON.parse(manualReview.detail_json).reason, 'appointment_source_binding_missing')
    assert.equal((await db.get('SELECT status FROM payments WHERE id = ?', [paymentId])).status, 'paid')
    const purchaseSignals = await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'signal_set' AND detail_json LIKE '%purchase_completed%'`,
      [contactId]
    )
    assert.equal(Number(purchaseSignals.total), 0)
  } finally {
    setConversationalPaymentResumeHandlerForTest(null)
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('recovery después de book_appointment no borra appointment_booked ni reenvía la respuesta', async () => {
  const suffix = randomUUID()
  const contactId = `contact_deposit_recovery_${suffix}`
  const paymentId = `transfer_recovery_${suffix}`
  let agent = null
  let resumeCalls = 0
  let terminalReplyCalls = 0
  let appointmentRequestId = ''
  let appointmentId = ''
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Cliente recovery anticipo', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    agent = await createConversationalAgent({
      name: `Recovery anticipo ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      objective: 'citas',
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [
          { id: 'schedule_appointment', enabled: true, calendarId: `calendar_recovery_${suffix}` },
          { id: 'collect_payment', enabled: true, paymentMode: 'deposit', deposit: { enabled: true, mode: 'fixed', amount: 400, currency: 'MXN' } }
        ]
      }
    })
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
        contact_id, agent_id, channel, status, signal, updated_at
      ) VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP)`,
      [contactId, agent.id]
    )
    const sourceBinding = await createSyntheticAppointmentDepositSourceBinding({
      contactId,
      agentId: agent.id,
      calendarId: `calendar_recovery_${suffix}`,
      suffix: `recovery_${suffix}`
    })
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'deposit_transfer_pending_review',
      detail: {
        agentId: agent.id,
        paymentId,
        ledgerPaymentId: paymentId,
        amount: 400,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentMode: 'deposit',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        ...sourceBinding,
        runtimeMode: 'tool_calling_v2'
      }
    })
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        payment_provider, paid_at, created_at, updated_at
      ) VALUES (?, ?, 400, 'MXN', 'paid', 'bank_transfer', 'live', 'manual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    setConversationalPaymentResumeHandlerForTest(async () => {
      resumeCalls += 1
      throw new Error('crash simulado antes de cerrar el ledger')
    })
    const input = { contactId, paymentId, amount: 400, currency: 'MXN', status: 'paid', paymentMode: 'live' }
    await assert.rejects(completeConversationalAgentSalePaymentFromInvoice(input), /crash simulado/)
    assert.equal(resumeCalls, 1)

    const reconciliation = await db.get(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_reconciliation_v2'
       ORDER BY created_at DESC LIMIT 1`,
      [contactId]
    )
    const reconciliationDetail = JSON.parse(reconciliation.detail_json)
    assert.equal(reconciliationDetail.status, 'pending')
    appointmentRequestId = `conv-v2-appointment:recovery:${suffix}`
    appointmentId = `appointment_recovery_${suffix}`
    await db.run(
      `INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status,
        start_time, end_time, booking_channel, date_added, date_updated
      ) VALUES (?, ?, ?, 'Consulta', 'confirmed', 'confirmed', ?, ?, 'whatsapp', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        appointmentId,
        reconciliationDetail.appointmentSelectionCalendarId,
        contactId,
        reconciliationDetail.appointmentSelectionStartTime,
        new Date(Date.parse(reconciliationDetail.appointmentSelectionStartTime) + 60 * 60 * 1000).toISOString()
      ]
    )
    await db.run(
      `INSERT INTO appointment_creation_requests (
        client_request_id, request_hash, status, processing_token
      ) VALUES (?, ?, 'processing', ?)`,
      [appointmentRequestId, '0'.repeat(64), `crashed_${suffix}`]
    )
    await recordConversationalAgentEvent({
      eventId: `${reconciliation.id}_consumed`,
      contactId,
      eventType: 'deposit_payment_consumed',
      detail: {
        agentId: agent.id,
        status: 'consumed',
        reconciliationId: reconciliation.id,
        ledgerPaymentId: paymentId,
        appointmentRequestId,
        appointmentId,
        calendarId: reconciliationDetail.appointmentSelectionCalendarId,
        startTime: reconciliationDetail.appointmentSelectionStartTime,
        selectionRequestDraftHash: reconciliationDetail.appointmentSelectionRequestDraftHash,
        bookingOwner: 'ai',
        terminalToolName: 'book_appointment'
      },
      throwOnError: true
    })
    const rescheduledStart = new Date(
      Date.parse(reconciliationDetail.appointmentSelectionStartTime) + 24 * 60 * 60 * 1000
    ).toISOString()
    await db.run(
      `UPDATE appointments SET start_time = ?, end_time = ?, date_updated = CURRENT_TIMESTAMP WHERE id = ?`,
      [rescheduledStart, new Date(Date.parse(rescheduledStart) + 60 * 60 * 1000).toISOString(), appointmentId]
    )
    await db.run(
      `UPDATE conversational_agent_state
       SET status = 'completed', signal = 'appointment_booked', updated_by = 'agent', updated_at = CURRENT_TIMESTAMP
       WHERE contact_id = ? AND agent_id = ?`,
      [contactId, agent.id]
    )
    await recordConversationalAgentEvent({
      eventId: `${reconciliation.id}_turn`,
      contactId,
      eventType: 'payment_resume_turn_completed',
      detail: { agentId: agent.id, actionTypes: ['book_appointment'], reconciliationId: reconciliation.id }
    })
    setConversationalPaymentResumeHandlerForTest(async () => {
      resumeCalls += 1
      throw new Error('no debe reanudarse otra vez')
    })
    setConversationalPaymentTerminalReplyHandlerForTest(async () => {
      terminalReplyCalls += 1
      return { sent: true, testDelivery: true }
    })

    const recovered = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(recovered.resumed, true)
    assert.equal(resumeCalls, 1)
    assert.equal(terminalReplyCalls, 1)
    const state = await db.get(
      'SELECT status, signal FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
      [contactId, agent.id]
    )
    assert.equal(state.status, 'completed')
    assert.equal(state.signal, 'appointment_booked')
    assert.equal(JSON.parse((await db.get('SELECT detail_json FROM conversational_agent_events WHERE id = ?', [reconciliation.id])).detail_json).status, 'completed')
    const repairedRequest = await db.get(
      'SELECT status, appointment_id, processing_token, response_json FROM appointment_creation_requests WHERE client_request_id = ?',
      [appointmentRequestId]
    )
    assert.equal(repairedRequest.status, 'completed')
    assert.equal(repairedRequest.appointment_id, appointmentId)
    assert.equal(repairedRequest.processing_token, null)
    assert.equal(JSON.parse(repairedRequest.response_json).id, appointmentId)
    assert.equal(JSON.parse(repairedRequest.response_json).startTime, rescheduledStart)
    const retry = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(retry.alreadyCompleted, true)
    assert.equal(terminalReplyCalls, 1)
  } finally {
    setConversationalPaymentResumeHandlerForTest(null)
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    if (appointmentRequestId) {
      await db.run('DELETE FROM appointment_creation_requests WHERE client_request_id = ?', [appointmentRequestId]).catch(() => {})
    }
    if (appointmentId) await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('aprobar o rechazar comprobante usa endpoints explícitos, sella auditoría y sólo approve reanuda', async () => {
  const suffix = randomUUID()
  const contactId = `contact_transfer_review_${suffix}`
  const approvedPaymentId = `transfer_review_approved_${suffix}`
  const rejectedPaymentId = `transfer_review_rejected_${suffix}`
  const blockedPaymentId = `transfer_review_blocked_${suffix}`
  let agent = null
  let resumeCalls = 0
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Cliente revisión transferencia', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    agent = await createConversationalAgent({
      name: `Cita revisión transferencia ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      objective: 'citas',
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [
          { id: 'schedule_appointment', enabled: true, calendarId: `calendar_review_${suffix}` },
          {
            id: 'collect_payment',
            enabled: true,
            paymentMode: 'deposit',
            deposit: { enabled: true, mode: 'fixed', amount: 250, currency: 'MXN' }
          }
        ]
      }
    })
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
        contact_id, agent_id, channel, status, signal, updated_at
      ) VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP)`,
      [contactId, agent.id]
    )

    const metadata = JSON.stringify({
      source: 'conversational_agent_transfer_proof_pending_review',
      requiresHumanVerification: true,
      agentId: agent.id,
      mediaMessageId: `secret_message_${suffix}`,
      mediaUrl: 'https://example.com/proof.jpg',
      receivedAt: '2026-07-10T18:00:00.000Z',
      extracted: { bank: 'Banco Seguro', reference: 'ABC-123', confidence: 0.99 }
    })
    for (const paymentId of [approvedPaymentId, rejectedPaymentId, blockedPaymentId]) {
      await db.run(
        `INSERT INTO payments (
          id, contact_id, amount, currency, status, payment_method, payment_mode,
          payment_provider, metadata_json, date, created_at, updated_at
        ) VALUES (?, ?, 250, 'MXN', 'pending_review', 'bank_transfer', 'manual_review',
          'manual', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [paymentId, contactId, metadata]
      )
    }
    const sourceBinding = await createSyntheticAppointmentDepositSourceBinding({
      contactId,
      agentId: agent.id,
      calendarId: `calendar_review_${suffix}`,
      suffix: `review_${suffix}`
    })
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'deposit_transfer_pending_review',
      detail: {
        agentId: agent.id,
        paymentId: approvedPaymentId,
        ledgerPaymentId: approvedPaymentId,
        amount: 250,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentMode: 'deposit',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        ...sourceBinding,
        runtimeMode: 'tool_calling_v2'
      }
    })
    setConversationalPaymentResumeHandlerForTest(async () => {
      resumeCalls += 1
      return { resumed: true, sent: true }
    })

    const approveRes = mockResponse()
    await approveTransferProof({
      params: { id: approvedPaymentId },
      body: { reference: 'REVISADO-OK' },
      user: { id: 'reviewer-safe' },
      headers: {},
      protocol: 'https',
      get: () => ''
    }, approveRes)
    assert.equal(approveRes.statusCode, 200)
    assert.equal(approveRes.body.success, true)
    assert.equal(approveRes.body.conversationResume.resumed, true)
    assert.equal(resumeCalls, 1)
    assert.deepEqual(approveRes.body.data.transferProof, {
      mediaUrl: 'https://example.com/proof.jpg',
      receivedAt: '2026-07-10T18:00:00.000Z',
      bank: 'Banco Seguro',
      reference: 'REVISADO-OK',
      reviewDecision: 'approved',
      reviewReason: null,
      reviewedAt: approveRes.body.data.paidAt
    })
    assert.equal('agentId' in approveRes.body.data.transferProof, false)
    assert.equal('mediaMessageId' in approveRes.body.data.transferProof, false)
    assert.equal('extracted' in approveRes.body.data.transferProof, false)

    const approveRetryRes = mockResponse()
    await approveTransferProof({
      params: { id: approvedPaymentId }, body: {}, user: { id: 'reviewer-safe' }, headers: {}, protocol: 'https', get: () => ''
    }, approveRetryRes)
    assert.equal(approveRetryRes.statusCode, 200)
    assert.equal(approveRetryRes.body.alreadyApproved, true)
    assert.equal(resumeCalls, 1)

    const rejectApprovedRes = mockResponse()
    await rejectTransferProof({
      params: { id: approvedPaymentId }, body: { reason: 'No aplica' }, user: { id: 'reviewer-safe' }, headers: {}, protocol: 'https', get: () => ''
    }, rejectApprovedRes)
    assert.equal(rejectApprovedRes.statusCode, 409)

    const rejectRes = mockResponse()
    await rejectTransferProof({
      params: { id: rejectedPaymentId }, body: { reason: 'Monto no aparece abonado' }, user: { id: 'reviewer-safe' }, headers: {}, protocol: 'https', get: () => ''
    }, rejectRes)
    assert.equal(rejectRes.statusCode, 200)
    assert.equal(rejectRes.body.data.status, 'rejected')
    assert.equal(rejectRes.body.data.transferProof.reviewDecision, 'rejected')
    assert.equal(rejectRes.body.data.transferProof.reviewReason, 'Monto no aparece abonado')
    assert.equal(resumeCalls, 1)

    const voidRes = mockResponse()
    await voidTransaction({ params: { id: blockedPaymentId } }, voidRes)
    assert.equal(voidRes.statusCode, 409)
    assert.match(voidRes.body.error, /revisión protegido|Aprobar o Rechazar/i)

    const genericRes = mockResponse()
    await recordPayment({
      params: { id: blockedPaymentId }, body: {}, headers: {}, protocol: 'https', get: () => ''
    }, genericRes)
    assert.equal(genericRes.statusCode, 409)
    const blocked = await db.get('SELECT status, payment_mode FROM payments WHERE id = ?', [blockedPaymentId])
    assert.equal(blocked.status, 'pending_review')
    assert.equal(blocked.payment_mode, 'manual_review')

    for (const [paymentId, expectedStatus] of [
      [blockedPaymentId, 'pending_review'],
      [approvedPaymentId, 'paid'],
      [rejectedPaymentId, 'rejected']
    ]) {
      const deleteRes = mockResponse()
      await deleteTransaction({ params: { id: paymentId } }, deleteRes)
      assert.equal(deleteRes.statusCode, 409)
      assert.match(deleteRes.body.error, /revisión protegido|historial de auditoría|no se puede eliminar/i)

      const persisted = await db.get('SELECT status FROM payments WHERE id = ?', [paymentId])
      assert.equal(persisted.status, expectedStatus)
    }
  } finally {
    setConversationalPaymentResumeHandlerForTest(null)
    for (const paymentId of [approvedPaymentId, rejectedPaymentId, blockedPaymentId]) {
      await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    }
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('la reanudación por pago usa el mismo Agent/Runner, el hilo completo y entrega respuesta sin fingir un mensaje del cliente', async () => {
  const suffix = randomUUID()
  const contactId = `contact_resume_runner_${suffix}`
  const agentId = `agent_resume_runner_${suffix}`
  const reconciliationId = `reconciliation_runner_${suffix}`
  const history = [
    { role: 'user', content: 'el martes tipo tardecita' },
    { role: 'assistant', content: 'va, te mando el anticipo para apartar' }
  ]
  let nativeTurnCalls = 0
  let deliveryCalls = 0
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
       VALUES (?, 'Cliente runner pago', '+5215550007777', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    const result = await resumeToolCallingV2AfterVerifiedPayment({
      reconciliationId,
      reconciliationClaimToken: `claim_${suffix}`,
      contactId,
      agentId,
      channel: 'whatsapp',
      amount: 300,
      currency: 'MXN',
      paymentEnvironment: 'live',
      paymentPurpose: 'appointment_deposit',
      bookingOwner: 'ai',
      terminalToolName: 'book_appointment'
    }, {
      getRuntimeConfig: async () => ({ enabled: true, aiProvider: 'openai' }),
      hasFeature: async () => true,
      getAgent: async () => ({
        id: agentId,
        enabled: true,
        runtimeMode: 'tool_calling_v2',
        model: 'test-model',
        aiProvider: 'openai',
        capabilitiesConfig: {
          schemaVersion: 3,
          items: [{
            id: 'schedule_appointment',
            enabled: true,
            calendarId: `calendar_${suffix}`,
            bookingOwner: 'ai'
          }]
        },
        replyDelivery: { mode: 'single', splitMessagesEnabled: false }
      }),
      getState: async () => ({ status: 'active', signal: null }),
      getLatestInbound: async () => ({
        id: `message_${suffix}`,
        phone: '+5215550007777',
        channel: 'whatsapp'
      }),
      getHistoryEnvelope: async () => ({ messages: history, telemetry: { total: history.length, included: history.length, omitted: 0 } }),
      hydrateMessages: async (messages) => messages,
      resolveRuntime: async () => ({ apiKey: 'test-only', modelProvider: {} }),
      runNativeTurn: async (args) => {
        nativeTurnCalls += 1
        assert.deepEqual(args.messages, history)
        assert.match(args.runtimeEventContext, /anticipo requerido para la cita fue confirmado/i)
        assert.match(args.runtimeEventContext, /servidor recupera el horario exacto ligado al pago/i)
        assert.doesNotMatch(args.runtimeEventContext, /vuelve a consultar disponibilidad real/i)
        assert.equal(args.executionId, `payment-resume:${reconciliationId}`)
        assert.equal(args.forcedToolName, 'book_appointment')
        return {
          ctx: {
            actions: [{
              type: 'book_appointment',
              outcome: { status: 'ok', ok: true, simulated: false, actionCompleted: true }
            }]
          },
          model: 'test-model',
          reply: 'listo, tu cita quedó confirmada',
          runtimeMode: 'tool_calling_v2',
          modelCallCount: 1
        }
      },
      assertReconciliationClaim: async () => ({ valid: true }),
      deliverReply: async ({ reply }) => {
        deliveryCalls += 1
        assert.equal(reply, 'listo, tu cita quedó confirmada')
        return { parts: [reply], sentParts: 1, interruptedBy: null }
      },
      recordEvent: async () => {}
    })
    assert.equal(result.resumed, true)
    assert.equal(result.sent, true)
    assert.equal(nativeTurnCalls, 1)
    assert.equal(deliveryCalls, 1)
  } finally {
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('la reanudación detecta cambios IA↔humano antes de ejecutar cualquier terminal', async () => {
  const cases = [
    {
      boundBookingOwner: 'ai',
      boundTool: 'book_appointment',
      currentBookingOwner: 'human',
      currentTool: 'request_human_booking'
    },
    {
      boundBookingOwner: 'human',
      boundTool: 'request_human_booking',
      currentBookingOwner: 'ai',
      currentTool: 'book_appointment'
    }
  ]
  for (const entry of cases) {
    const suffix = randomUUID()
    let nativeTurnCalls = 0
    const result = await resumeToolCallingV2AfterVerifiedPayment({
      reconciliationId: `reconciliation_terminal_change_${suffix}`,
      reconciliationClaimToken: `claim_terminal_change_${suffix}`,
      contactId: `contact_terminal_change_${suffix}`,
      agentId: `agent_terminal_change_${suffix}`,
      paymentPurpose: 'appointment_deposit',
      bookingOwner: entry.boundBookingOwner,
      terminalToolName: entry.boundTool
    }, {
      getRuntimeConfig: async () => ({ enabled: true, aiProvider: 'openai' }),
      hasFeature: async () => true,
      getAgent: async () => ({
        id: `agent_terminal_change_${suffix}`,
        enabled: true,
        runtimeMode: 'tool_calling_v2',
        capabilitiesConfig: {
          schemaVersion: 3,
          items: [{
            id: 'schedule_appointment',
            enabled: true,
            calendarId: `calendar_terminal_change_${suffix}`,
            bookingOwner: entry.currentBookingOwner
          }]
        }
      }),
      runNativeTurn: async () => {
        nativeTurnCalls += 1
        return null
      }
    })
    assert.equal(result.resumed, false)
    assert.equal(result.manualReviewRequired, true)
    assert.equal(result.reason, 'appointment_terminal_configuration_changed')
    assert.equal(result.terminalToolName, entry.boundTool)
    assert.equal(result.currentTerminalToolName, entry.currentTool)
    assert.equal(nativeTurnCalls, 0)
  }
})

test('la reanudación pagada exige feature, agente y conversación ejecutables o escala a revisión humana', async () => {
  const cases = [
    {
      label: 'feature apagada',
      featureEnabled: false,
      agentEnabled: true,
      state: { status: 'active', signal: null },
      reason: 'feature_disabled'
    },
    {
      label: 'agente apagado',
      featureEnabled: true,
      agentEnabled: false,
      state: { status: 'active', signal: null },
      reason: 'native_agent_unavailable'
    },
    {
      label: 'estado entregado a humano',
      featureEnabled: true,
      agentEnabled: true,
      state: { status: 'human', signal: 'ready_for_human' },
      reason: 'conversation_state_not_runnable'
    }
  ]
  for (const entry of cases) {
    const suffix = randomUUID()
    const agentId = `agent_blocked_resume_${suffix}`
    let nativeTurnCalls = 0
    const result = await resumeToolCallingV2AfterVerifiedPayment({
      reconciliationId: `reconciliation_blocked_resume_${suffix}`,
      reconciliationClaimToken: `claim_blocked_resume_${suffix}`,
      contactId: `contact_blocked_resume_${suffix}`,
      agentId,
      paymentPurpose: 'appointment_deposit',
      bookingOwner: 'ai',
      terminalToolName: 'book_appointment'
    }, {
      getRuntimeConfig: async () => ({ enabled: true, aiProvider: 'openai' }),
      hasFeature: async () => entry.featureEnabled,
      getAgent: async () => ({
        id: agentId,
        enabled: entry.agentEnabled,
        runtimeMode: 'tool_calling_v2',
        capabilitiesConfig: {
          schemaVersion: 3,
          items: [{
            id: 'schedule_appointment',
            enabled: true,
            calendarId: `calendar_blocked_resume_${suffix}`,
            bookingOwner: 'ai'
          }]
        }
      }),
      getState: async () => entry.state,
      runNativeTurn: async () => {
        nativeTurnCalls += 1
        return null
      }
    })
    assert.equal(result.resumed, false, entry.label)
    assert.equal(result.manualReviewRequired, true, entry.label)
    assert.equal(result.reason, entry.reason, entry.label)
    assert.equal(nativeTurnCalls, 0, entry.label)
  }
})

test('get_contact_profile v2 expone evidencia factual de cliente previo sin IDs internos', async () => {
  const suffix = randomUUID()
  const contactId = `contact_past_v2_${suffix}`
  const currency = await getAccountCurrency()
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente previo v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, payment_provider, paid_at, created_at, updated_at
       ) VALUES
        (?, ?, 500, ?, 'paid', 'live', 'stripe', '2025-01-10T18:00:00.000Z', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        (?, ?, 999, ?, 'paid', 'test', 'stripe', '2025-01-11T18:00:00.000Z', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        (?, ?, 700, ?, 'paid', 'manual_review', 'manual', '2025-01-12T18:00:00.000Z', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        `payment_live_${suffix}`, contactId, currency,
        `payment_test_${suffix}`, contactId, currency,
        `payment_review_${suffix}`, contactId, currency
      ]
    )
    await db.run(
      `INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time
       ) VALUES
        (?, 'calendar_history', ?, 'Consulta previa', 'confirmed', 'confirmed', '2025-02-01T16:00:00.000Z', '2025-02-01T17:00:00.000Z'),
        (?, 'calendar_history', ?, 'Cita cancelada', 'cancelled', 'cancelled', '2025-02-02T16:00:00.000Z', '2025-02-02T17:00:00.000Z')`,
      [`appointment_live_${suffix}`, contactId, `appointment_cancelled_${suffix}`, contactId]
    )

    const ctx = v2Context([{
      id: 'handoff_human', enabled: true, pastClientsToHuman: true
    }], { contactId })
    const profileTool = createConversationalTools(ctx).find((item) => item.name === 'get_contact_profile')
    assert.match(profileTool.description, /consulta obligatoria/i)
    const result = await profileTool.invoke(null, '{}')

    assert.equal(result.ok, true)
    assert.equal(result.pastClientEvidence.isPastClient, true)
    assert.equal(result.pastClientEvidence.successfulPayments.length, 1)
    assert.equal(result.pastClientEvidence.successfulPayments[0].amount, 500)
    assert.equal(result.pastClientEvidence.pastAppointments.length, 1)
    assert.equal(result.pastClientEvidence.pastAppointments[0].title, 'Consulta previa')
    assert.equal('id' in result.contact, false)
    assert.equal('totalPaid' in result.contact, false)
    assert.equal('purchasesCount' in result.contact, false)
    assert.equal('id' in result.pastClientEvidence.successfulPayments[0], false)
    assert.equal('id' in result.pastClientEvidence.pastAppointments[0], false)
  } finally {
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('send_link tipo trigger entrega sólo el destino y jamás agrega contact_id', async () => {
  const targetUrl = 'https://example.com/recurso?utm_source=ristak'
  const ctx = v2Context([{
    id: 'send_link',
    enabled: true,
    linkKind: 'trigger',
    url: targetUrl
  }], { contactId: 'contacto_que_no_debe_salir' })
  const sendLink = createConversationalTools(ctx).find((item) => item.name === 'send_trigger_link')
  const result = await sendLink.invoke(null, JSON.stringify({ intencionDetectada: null, resumen: null }))

  assert.equal(result.ok, true)
  assert.equal(result.sentUrl, targetUrl)
  assert.equal(result.objectiveCompleted, false)
  assert.equal('goalId' in result, false)
  assert.ok(!result.sentUrl.includes('contact_id'))
  assert.equal(ctx.actions[0]?.outcome?.sentUrl, targetUrl)
})

test('send_link verificable independiente entrega URL directa sin crear meta ni pasar a humano', async () => {
  const contactId = `contact_v2_direct_link_${randomUUID()}`
  const targetUrl = 'https://example.com/recurso-directo?utm_source=ristak'
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, 'Cliente enlace directo v2']
    )
    const ctx = v2Context([{
      id: 'send_link',
      enabled: true,
      linkKind: 'verified_goal',
      url: targetUrl,
      trackingParam: 'goal_ref'
    }], { contactId, dryRun: false, agentId: null, executionId: `message_direct_link_${randomUUID()}` })
    ctx.config.id = null

    const result = await createConversationalTools(ctx)
      .find((item) => item.name === 'send_trigger_link')
      .invoke(null, JSON.stringify({
        intencionDetectada: 'Pidió el recurso',
        resumen: 'La estrategia indicó mandar el enlace'
      }))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.sentUrl, targetUrl)
    assert.equal(result.confirmationMode, 'none')
    assert.equal(result.objectiveCompleted, false)
    assert.equal('goalId' in result, false)
    assert.equal(new URL(result.sentUrl).searchParams.has('goal_ref'), false)
    assert.equal(ctx.actions[0]?.objective, 'send_link')
    assert.equal(ctx.actions[0]?.outcome?.goalId, undefined)

    const goalLinks = await db.get(
      'SELECT COUNT(*) AS total FROM conversational_agent_goal_links WHERE contact_id = ?',
      [contactId]
    )
    assert.equal(Number(goalLinks.total), 0)

    const state = await db.get(
      'SELECT status, signal FROM conversational_agent_state WHERE contact_id = ?',
      [contactId]
    )
    assert.ok(!state || state.signal !== 'ready_for_human')

    const events = await db.all(
      'SELECT event_type FROM conversational_agent_events WHERE contact_id = ? ORDER BY id ASC',
      [contactId]
    )
    assert.deepEqual(events.map((event) => event.event_type), ['safe_link_sent'])
  } finally {
    await db.run('DELETE FROM conversational_agent_goal_links WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('con ambas capacidades, el envío general nunca se convierte en meta y sólo send_goal_url crea tracking', async () => {
  const contactId = `contact_v2_split_link_${randomUUID()}`
  const targetUrl = 'https://example.com/registro-separado'
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, 'Cliente links separados v2']
    )
    const ctx = v2Context([
      {
        id: 'send_link',
        enabled: true,
        linkKind: 'verified_goal',
        url: targetUrl,
        trackingParam: 'goal_ref'
      },
      {
        id: 'custom_goal',
        enabled: true,
        description: 'Completar el registro externo',
        completion: 'send_link'
      }
    ], {
      contactId,
      dryRun: false,
      agentId: null,
      executionId: `message_split_link_${randomUUID()}`
    })
    ctx.config.id = null
    const tools = createConversationalTools(ctx)

    const generalResult = await tools
      .find((item) => item.name === 'send_trigger_link')
      .invoke(null, JSON.stringify({
        intencionDetectada: 'Pidió el recurso general',
        resumen: 'No pidió completar la meta'
      }))
    assert.equal(generalResult.ok, true, JSON.stringify(generalResult))
    assert.equal(generalResult.sentUrl, targetUrl)
    assert.equal(generalResult.confirmationMode, 'none')
    assert.equal(ctx.actions[0]?.type, 'send_trigger_link')
    assert.equal(ctx.actions[0]?.objective, 'send_link')
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM conversational_agent_goal_links WHERE contact_id = ?',
      [contactId]
    )).total), 0)

    const goalResult = await tools
      .find((item) => item.name === 'send_goal_url')
      .invoke(null, JSON.stringify({
        intencionDetectada: 'Ahora sí quiere completar el registro',
        resumen: 'La estrategia autorizó avanzar con el objetivo propio'
      }))
    assert.equal(goalResult.ok, true, JSON.stringify(goalResult))
    assert.equal(goalResult.confirmationMode, 'trusted_integration')
    assert.notEqual(goalResult.sentUrl, targetUrl)
    assert.equal(new URL(goalResult.sentUrl).searchParams.has('goal_ref'), true)
    assert.equal(ctx.actions[1]?.type, 'send_goal_url')
    assert.equal(ctx.actions[1]?.objective, 'custom')
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM conversational_agent_goal_links WHERE contact_id = ?',
      [contactId]
    )).total), 1)
  } finally {
    await db.run('DELETE FROM conversational_agent_goal_links WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('custom_goal con send_link verificable reusa el mismo inbound, crea otra meta en otro inbound y nunca expone goalId', async () => {
  const contactId = `contact_v2_goal_${randomUUID()}`
  const targetUrl = 'https://example.com/finalizar'
  const trackedGoalItems = [
    {
      id: 'send_link',
      enabled: true,
      linkKind: 'verified_goal',
      url: targetUrl
    },
    {
      id: 'custom_goal',
      enabled: true,
      description: 'Completar el registro externo',
      completion: 'send_link'
    }
  ]
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, 'Cliente goal v2']
    )
    const ctx = v2Context(trackedGoalItems, {
      contactId,
      dryRun: false,
      agentId: null,
      executionId: `message_goal_1_${randomUUID()}`
    })
    ctx.config.id = null
    const sendLink = createConversationalTools(ctx).find((item) => item.name === 'send_goal_url')
    const result = await sendLink.invoke(null, JSON.stringify({
      intencionDetectada: 'Quiere finalizar',
      resumen: 'Solicitó el enlace configurado'
    }))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal('goalId' in result, false)
    assert.match(result.sentUrl, /^https:\/\/example\.com\/finalizar\?/)
    assert.ok(ctx.actions[0]?.outcome?.goalId)
    assert.equal(ctx.actions[0]?.outcome?.sentUrl, result.sentUrl)

    const replay = await sendLink.invoke(null, JSON.stringify({
      intencionDetectada: 'Quiere finalizar',
      resumen: 'Retry del mismo mensaje'
    }))
    assert.equal(replay.sentUrl, result.sentUrl)

    const nextCtx = v2Context(trackedGoalItems, {
      contactId,
      dryRun: false,
      agentId: null,
      executionId: `message_goal_2_${randomUUID()}`
    })
    nextCtx.config.id = null
    const nextSendLink = createConversationalTools(nextCtx).find((item) => item.name === 'send_goal_url')
    const nextResult = await nextSendLink.invoke(null, JSON.stringify({
      intencionDetectada: 'Quiere finalizar una meta nueva',
      resumen: 'Otro mensaje entrante'
    }))
    assert.equal(nextResult.ok, true, JSON.stringify(nextResult))
    assert.notEqual(nextResult.sentUrl, result.sentUrl)

    const count = await db.get(
      'SELECT COUNT(*) AS total FROM conversational_agent_goal_links WHERE contact_id = ?',
      [contactId]
    )
    assert.equal(Number(count.total), 2)

    const missingCtx = v2Context(trackedGoalItems, {
      contactId,
      dryRun: false,
      agentId: null,
      executionId: ''
    })
    missingCtx.config.id = null
    const missingResult = await createConversationalTools(missingCtx)
      .find((item) => item.name === 'send_goal_url')
      .invoke(null, JSON.stringify({ intencionDetectada: null, resumen: null }))
    assert.equal(missingResult.ok, false)
    assert.equal(missingResult.code, 'goal_link_execution_id_missing')
  } finally {
    await db.run('DELETE FROM conversational_agent_goal_links WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('un comprobante v2 queda pending_review/manual_review y no cuenta como pago verificado', async () => {
  const contactId = `contact_v2_proof_${randomUUID()}`
  const currency = await getAccountCurrency()
  let paymentId = ''

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, 'Cliente comprobante v2']
    )
    const payment = await registerAgentTransferPaymentProofForReview({
      contactId,
      amount: 75,
      currency,
      agentId: 'agent_v2_proof',
      mediaUrl: 'https://example.com/proof.jpg',
      mediaMessageId: 'message_v2_proof'
    })
    paymentId = payment.paymentId

    const row = await db.get(
      `SELECT status, payment_mode, payment_provider, paid_at, metadata_json
       FROM payments WHERE id = ?`,
      [paymentId]
    )
    assert.equal(row.status, 'pending_review')
    assert.equal(row.payment_mode, 'manual_review')
    assert.equal(row.payment_provider, 'manual')
    assert.equal(row.paid_at, null)
    assert.equal(JSON.parse(row.metadata_json).requiresHumanVerification, true)

    const requirement = { mode: 'fixed', amount: 75, currency }
    const pendingEvidence = await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      requirement,
      accountCurrency: currency
    })
    assert.equal(pendingEvidence.ok, false)

    // Defensa extra: ni un cambio accidental de status desbloquea manual_review.
    await db.run(
      `UPDATE payments SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [paymentId]
    )
    const mislabeledEvidence = await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      requirement,
      accountCurrency: currency
    })
    assert.equal(mislabeledEvidence.ok, false)
  } finally {
    if (paymentId) await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('comprobantes inciertos crean un solo caso manual, alertan una vez y nunca inventan pagos', async () => {
  const suffix = randomUUID()
  const contactId = `contact_uncertain_proofs_${suffix}`
  const agentId = `agent_uncertain_proofs_${suffix}`
  const historicalPaymentId = `payment_historical_proof_${suffix}`
  const historicalReconciliationId = `carec_historical_proof_${suffix}`
  const currency = await getAccountCurrency()
  const cases = [
    { failureReason: 'analysis_failed', analysis: { ok: false, reason: 'analysis_failed' } },
    { failureReason: 'amount_missing', analysis: { ok: true, isPaymentReceipt: true, amount: null, currency } },
    { failureReason: 'currency_mismatch', analysis: { ok: true, isPaymentReceipt: true, amount: 1200, currency: currency === 'USD' ? 'MXN' : 'USD' } },
    { failureReason: 'amount_mismatch', analysis: { ok: true, isPaymentReceipt: true, amount: 999, currency } }
  ]

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto comprobantes inciertos', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO payments (
         id, contact_id, amount, currency, status, payment_mode, payment_provider,
         paid_at, created_at, updated_at
       ) VALUES (?, ?, 1200, ?, 'paid', 'live', 'manual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [historicalPaymentId, contactId, currency]
    )
    await db.run(
      `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, 'payment_reconciliation_v2', ?)`,
      [historicalReconciliationId, contactId, agentId, JSON.stringify({
        agentId,
        status: 'completed',
        result: { matched: true },
        ledgerPaymentId: historicalPaymentId,
        amount: 1200,
        currency,
        paymentEnvironment: 'live',
        paymentPurpose: 'purchase',
        appointmentDeposit: false
      })]
    )
    const ctx = v2Context([{
      id: 'collect_payment',
      enabled: true,
      collectionMethod: 'bank_transfer',
      paymentMode: 'full_payment',
      chargeType: 'direct',
      direct: { amount: 1200, currency, concept: 'Consulta inicial' },
      bankTransfer: { details: 'Banco de prueba · cuenta 1234' },
      receiptProof: { enabled: true }
    }], {
      contactId,
      agentId,
      dryRun: false,
      executionId: `message_uncertain_proofs_${suffix}`,
      accountLocale: { currency }
    })
    ctx.config.id = agentId

    for (let index = 0; index < cases.length; index += 1) {
      const current = cases[index]
      const mediaMessageId = `message_uncertain_${index}_${suffix}`
      await db.run(
        `INSERT INTO whatsapp_api_messages (
          id, contact_id, direction, message_type, media_url, media_mime_type,
          message_timestamp, created_at, updated_at
         ) VALUES (?, ?, 'inbound', 'image', ?, 'image/jpeg', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [mediaMessageId, contactId, `https://example.com/uncertain-${index}.jpg`, new Date(Date.now() + (index + 1) * 1000).toISOString()]
      )
      ctx.executionId = mediaMessageId
      setNativePaymentReceiptAnalysisHookForTest(async () => current.analysis)
      const proof = createConversationalTools(ctx).find((item) => item.name === 'register_deposit_payment_proof')
      const first = await proof.invoke(null, JSON.stringify({ montoIndicado: null, referencia: null }))
      assert.equal(first.ok, true, JSON.stringify(first))
      assert.equal(first.manualReviewRequired, true)
      assert.equal(first.paymentConfirmed, false)
      const reply = ensureToolCallingV2VisibleReply('', [ctx.actions.at(-1)])
      assert.equal(reply, 'recibí el comprobante y quedó pendiente de revisión; todavía no confirma el pago')
      assert.doesNotMatch(reply, /tool|cae_|message_uncertain/i)

      if (index === 0) {
        await db.run(
          `UPDATE conversational_agent_state
           SET status = 'active', signal = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE contact_id = ? AND agent_id = ?`,
          [contactId, agentId]
        )
      }
      const retry = await proof.invoke(null, JSON.stringify({ montoIndicado: null, referencia: null }))
      assert.equal(retry.ok, true, JSON.stringify(retry))
      assert.equal(retry.alreadyRegistered, true)
      assert.equal(retry.signal, 'ready_for_human')
      const event = await db.get(
        `SELECT detail_json FROM conversational_agent_events
         WHERE contact_id = ? AND event_type = 'payment_proof_manual_review_required'
           AND detail_json LIKE ?`,
        [contactId, `%${mediaMessageId}%`]
      )
      const detail = JSON.parse(event.detail_json)
      assert.equal(detail.failureReason, current.failureReason)
      assert.equal(detail.paymentPurpose, 'purchase')
      assert.equal(detail.ledgerPaymentId, null)
      assert.equal(detail.approvalAllowed, false)
      assert.equal(detail.autoResumeAllowed, false)
    }

    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM payments WHERE contact_id = ?', [contactId])).total), 1)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM payments
       WHERE contact_id = ? AND id != ?`,
      [contactId, historicalPaymentId]
    )).total), 0)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_proof_manual_review_required'`,
      [contactId]
    )).total), cases.length)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type IN ('priority_push_notification', 'priority_push_notification_failed')`,
      [contactId]
    )).total), cases.length)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_reconciliation_v2'`,
      [contactId]
    )).total), 1)
    const state = await db.get(
      `SELECT status, signal FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ?`,
      [contactId, agentId]
    )
    assert.equal(state.status, 'human')
    assert.equal(state.signal, 'ready_for_human')
  } finally {
    setNativePaymentReceiptAnalysisHookForTest(null)
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('un source_bound viejo no convierte el comprobante actual en anticipo de cita', async () => {
  const suffix = randomUUID()
  const contactId = `contact_stale_source_bound_${suffix}`
  const agentId = `agent_stale_source_bound_${suffix}`
  const receiptMessageId = `message_stale_source_bound_${suffix}`
  const currency = await getAccountCurrency()

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto source bound viejo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, 'appointment_deposit_intent_pending', ?)`,
      [`intent_stale_source_bound_${suffix}`, contactId, agentId, JSON.stringify({
        status: 'source_bound',
        collectionMethod: 'bankTransfer',
        sourceEventId: `old_payment_source_${suffix}`,
        methods: { paymentLink: false, bankTransfer: true },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      })]
    )
    setNativePaymentReceiptAnalysisHookForTest(async () => ({
      ok: false,
      isPaymentReceipt: false,
      reason: 'analysis_failed'
    }))
    const ctx = v2Context([
      {
        id: 'schedule_appointment',
        enabled: true,
        calendarId: `calendar_stale_source_bound_${suffix}`,
        bookingOwner: 'ai'
      },
      {
        id: 'collect_payment',
        enabled: true,
        collectionMethod: 'bank_transfer',
        paymentMode: 'deposit',
        chargeType: 'deposit',
        deposit: {
          enabled: true,
          mode: 'fixed',
          amount: 300,
          currency,
          methods: { paymentLink: false, bankTransfer: true }
        },
        bankTransfer: { details: 'Banco de prueba · cuenta 1234' },
        receiptProof: { enabled: true }
      }
    ], {
      contactId,
      agentId,
      dryRun: false,
      executionId: receiptMessageId,
      accountLocale: { currency },
      conversationMessages: [{
        id: receiptMessageId,
        role: 'user',
        content: 'Esta transferencia es aparte',
        messageTimestamp: new Date().toISOString(),
        attachments: [{
          kind: 'image',
          mimeType: 'image/jpeg',
          dataUrl: 'data:image/jpeg;base64,STALESOURCE'
        }]
      }]
    })
    ctx.config.id = agentId
    const result = await createConversationalTools(ctx)
      .find((item) => item.name === 'register_deposit_payment_proof')
      .invoke(null, JSON.stringify({ montoIndicado: 300, referencia: null }))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.paymentConfirmed, false)
    assert.equal(result.manualReviewRequired, true)
    assert.equal(ctx.actions[0].paymentPurpose, 'deposit')
    const review = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_proof_manual_review_required'
       ORDER BY created_at DESC LIMIT 1`,
      [contactId]
    )
    assert.equal(JSON.parse(review.detail_json).paymentPurpose, 'deposit')
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM payments WHERE contact_id = ?', [contactId])).total), 0)
  } finally {
    setNativePaymentReceiptAnalysisHookForTest(null)
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('comprobantes válidos registran purchase y anticipo independiente como pending_review', async () => {
  const suffix = randomUUID()
  const currency = await getAccountCurrency()
  const variants = [
    {
      kind: 'purchase',
      amount: 1200,
      capability: {
        id: 'collect_payment',
        enabled: true,
        collectionMethod: 'bank_transfer',
        paymentMode: 'full_payment',
        chargeType: 'direct',
        direct: { amount: 1200, currency, concept: 'Consulta inicial' },
        bankTransfer: { details: 'Banco de prueba · cuenta 1234' },
        receiptProof: { enabled: true }
      },
      expectedPaymentMode: 'full_payment'
    },
    {
      kind: 'deposit',
      amount: 300,
      capability: {
        id: 'collect_payment',
        enabled: true,
        collectionMethod: 'bank_transfer',
        paymentMode: 'deposit',
        bankTransfer: { details: 'Banco de prueba · cuenta 1234' },
        deposit: {
          enabled: true,
          mode: 'fixed',
          amount: 300,
          currency,
          methods: { paymentLink: false, bankTransfer: true }
        },
        receiptProof: { enabled: true }
      },
      expectedPaymentMode: 'deposit'
    }
  ]
  const createdAgents = []

  try {
    for (let index = 0; index < variants.length; index += 1) {
      const variant = variants[index]
      const contactId = `contact_valid_proof_${variant.kind}_${suffix}`
      const mediaMessageId = `message_valid_proof_${variant.kind}_${suffix}`
      const agent = await createConversationalAgent({
        name: `Agente comprobante ${variant.kind} ${suffix}`,
        enabled: false,
        runtimeMode: 'tool_calling_v2',
        objective: 'ventas',
        capabilitiesConfig: { schemaVersion: 1, items: [variant.capability] }
      })
      createdAgents.push(agent)
      const agentId = agent.id
      await db.run(
        `INSERT INTO contacts (id, full_name, created_at, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [contactId, `Contacto comprobante ${variant.kind}`]
      )
      await db.run(
        `INSERT INTO whatsapp_api_messages (
          id, contact_id, direction, message_type, media_url, media_mime_type,
          message_timestamp, created_at, updated_at
         ) VALUES (?, ?, 'inbound', 'image', ?, 'image/jpeg', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [mediaMessageId, contactId, `https://example.com/valid-${variant.kind}.jpg`, new Date(Date.now() + (index + 1) * 1000).toISOString()]
      )
      await db.run(
        `INSERT OR REPLACE INTO conversational_agent_state (
          contact_id, agent_id, channel, status, signal, updated_at
         ) VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP)`,
        [contactId, agentId]
      )
      setNativePaymentReceiptAnalysisHookForTest(async () => ({
        ok: true,
        isPaymentReceipt: true,
        amount: variant.amount,
        currency,
        date: new Date().toISOString(),
        bank: 'Banco válido',
        reference: `VALID-${variant.kind}-${suffix}`,
        confidence: 0.99
      }))
      const ctx = v2Context([variant.capability], {
        contactId,
        agentId,
        dryRun: false,
        executionId: mediaMessageId,
        accountLocale: { currency }
      })
      ctx.config.id = agentId
      const result = await createConversationalTools(ctx)
        .find((item) => item.name === 'register_deposit_payment_proof')
        .invoke(null, JSON.stringify({ montoIndicado: variant.amount, referencia: null }))
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(result.paymentConfirmed, false)
      assert.equal(result.manualReviewRequired, true)
      assert.equal(result.payment.status, 'pending_review')
      const payment = await db.get(
        `SELECT id, status, payment_mode, paid_at FROM payments
         WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1`,
        [contactId]
      )
      assert.equal(payment.status, 'pending_review')
      assert.equal(payment.payment_mode, 'manual_review')
      assert.equal(payment.paid_at, null)
      const event = await db.get(
        `SELECT detail_json FROM conversational_agent_events
         WHERE contact_id = ? AND event_type = 'deposit_transfer_pending_review'
         ORDER BY created_at DESC LIMIT 1`,
        [contactId]
      )
      const detail = JSON.parse(event.detail_json)
      assert.equal(detail.paymentPurpose, variant.kind)
      assert.equal(detail.paymentMode, variant.expectedPaymentMode)
      assert.equal(detail.appointmentDeposit, false)
      assert.equal(detail.manualReviewOnly, false)
      assert.equal(detail.autoResumeAllowed, true)
      assert.equal(detail.ledgerPaymentId, payment.id)
      assert.equal(Number((await db.get(
        `SELECT COUNT(*) AS total FROM conversational_agent_events
         WHERE contact_id = ? AND event_type IN ('payment_reconciliation_v2', 'signal_set')`,
        [contactId]
      )).total), 0)

      const approveRes = mockResponse()
      await approveTransferProof({
        params: { id: payment.id },
        body: { reference: `APPROVED-${variant.kind}` },
        user: { id: 'reviewer-valid-proof' },
        headers: {},
        protocol: 'https',
        get: () => ''
      }, approveRes)
      assert.equal(approveRes.statusCode, 200, JSON.stringify(approveRes.body))
      assert.equal(approveRes.body.success, true)
      assert.equal(approveRes.body.conversationResume.signal, 'purchase_completed')
      assert.equal(approveRes.body.conversationResumePending, false)
      const completedState = await db.get(
        `SELECT status, signal FROM conversational_agent_state
         WHERE contact_id = ? AND agent_id = ?`,
        [contactId, agentId]
      )
      assert.equal(completedState.status, 'completed')
      assert.equal(completedState.signal, 'purchase_completed')
      assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?', [contactId])).total), 0)

      const approveRetryRes = mockResponse()
      await approveTransferProof({
        params: { id: payment.id },
        body: {},
        user: { id: 'reviewer-valid-proof' },
        headers: {},
        protocol: 'https',
        get: () => ''
      }, approveRetryRes)
      assert.equal(approveRetryRes.statusCode, 200)
      assert.equal(approveRetryRes.body.alreadyApproved, true)
      assert.equal(approveRetryRes.body.conversationResumePending, false)
      assert.equal(Number((await db.get(
        `SELECT COUNT(*) AS total FROM conversational_agent_events
         WHERE contact_id = ? AND event_type = 'payment_reconciliation_v2'`,
        [contactId]
      )).total), 1)
    }
  } finally {
    setNativePaymentReceiptAnalysisHookForTest(null)
    for (const variant of variants) {
      const contactId = `contact_valid_proof_${variant.kind}_${suffix}`
      await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [contactId]).catch(() => {})
      await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
      await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
      await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    }
    for (const agent of createdAgents) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
  }
})

test('evidencia v2 exige reconciliación y ledger exactos, respeta la reserva y no recicla el anticipo consumido', async () => {
  const suffix = randomUUID()
  const contactId = `contact_bound_evidence_${suffix}`
  const agentId = `agent_bound_evidence_${suffix}`
  const paymentId = `payment_bound_evidence_${suffix}`
  const reconciliationId = `carec_bound_evidence_${suffix}`
  const appointmentRequestId = `conv-v2-attempt:${createHash('sha256').update(suffix).digest('hex')}`
  const requirement = { mode: 'fixed', amount: 999, currency: 'USD' }

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente evidencia ligada', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, payment_provider,
        paid_at, created_at, updated_at
      ) VALUES (?, ?, 300, 'MXN', 'paid', 'live', 'manual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )

    const unrelated = await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      agentId,
      nativeRuntime: true,
      requiredPurpose: 'appointment_deposit',
      reconciliationId,
      appointmentRequestId,
      requirement,
      accountCurrency: 'USD'
    })
    assert.equal(unrelated.ok, false)

    const processingDetail = {
      agentId,
      status: 'processing',
      attempts: 1,
      claimToken: `claim_${suffix}`,
      leaseUntilAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      verifiedEventAppliedAt: new Date().toISOString(),
      ledgerPaymentId: paymentId,
      sourceEventId: `source_${suffix}`,
      amount: 300,
      currency: 'MXN',
      paymentEnvironment: 'live',
      paymentPurpose: 'appointment_deposit',
      appointmentDeposit: true
    }
    await recordConversationalAgentEvent({
      eventId: reconciliationId,
      contactId,
      eventType: 'payment_reconciliation_v2',
      detail: processingDetail,
      throwOnError: true
    })

    const exactResume = await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      agentId,
      nativeRuntime: true,
      requiredPurpose: 'appointment_deposit',
      reconciliationId,
      appointmentRequestId,
      requirement,
      accountCurrency: 'USD'
    })
    assert.equal(exactResume.ok, true, JSON.stringify(exactResume))
    assert.equal(exactResume.evidence.paymentId, paymentId)
    assert.equal(exactResume.evidence.amount, 300)
    assert.equal(exactResume.evidence.currency, 'MXN')

    const wrongAgent = await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      agentId: `other_${agentId}`,
      nativeRuntime: true,
      requiredPurpose: 'appointment_deposit',
      reconciliationId,
      appointmentRequestId,
      requirement,
      accountCurrency: 'USD'
    })
    assert.equal(wrongAgent.ok, false)

    const completedDetail = {
      ...processingDetail,
      status: 'completed',
      claimToken: null,
      leaseUntilAt: null,
      result: { matched: true, signal: 'deposit_payment_verified' }
    }
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?',
      [JSON.stringify(completedDetail), reconciliationId]
    )
    const completed = await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      agentId,
      nativeRuntime: true,
      requiredPurpose: 'appointment_deposit',
      appointmentRequestId,
      requirement,
      accountCurrency: 'USD'
    })
    assert.equal(completed.ok, true)

    const consumptionId = `${reconciliationId}_consumed`
    await recordConversationalAgentEvent({
      eventId: consumptionId,
      contactId,
      eventType: 'deposit_payment_consumed',
      detail: {
        status: 'reserved',
        agentId,
        reconciliationId,
        ledgerPaymentId: paymentId,
        appointmentRequestId,
        paymentPurpose: 'appointment_deposit'
      },
      throwOnError: true
    })
    const sameReservation = await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      agentId,
      nativeRuntime: true,
      requiredPurpose: 'appointment_deposit',
      appointmentRequestId,
      requirement,
      accountCurrency: 'USD'
    })
    assert.equal(sameReservation.ok, true)
    const differentRequest = await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      agentId,
      nativeRuntime: true,
      requiredPurpose: 'appointment_deposit',
      appointmentRequestId: `conv-v2-attempt:${createHash('sha256').update(`other_${suffix}`).digest('hex')}`,
      requirement,
      accountCurrency: 'USD'
    })
    assert.equal(differentRequest.ok, false)

    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?',
      [JSON.stringify({
        status: 'consumed',
        agentId,
        reconciliationId,
        ledgerPaymentId: paymentId,
        appointmentRequestId,
        appointmentId: `appointment_${suffix}`,
        paymentPurpose: 'appointment_deposit'
      }), consumptionId]
    )
    const consumed = await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      agentId,
      nativeRuntime: true,
      requiredPurpose: 'appointment_deposit',
      reconciliationId,
      appointmentRequestId,
      requirement,
      accountCurrency: 'USD'
    })
    assert.equal(consumed.ok, false)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('consume del anticipo revalida el ledger y conserva la reserva si el pago dejó de estar confirmado', async () => {
  const suffix = randomUUID()
  const contactId = `contact_consume_revalidation_${suffix}`
  const agentId = `agent_consume_revalidation_${suffix}`
  const paymentId = `payment_consume_revalidation_${suffix}`
  const reconciliationId = `carec_consume_revalidation_${suffix}`
  const appointmentId = `appointment_consume_revalidation_${suffix}`
  const appointmentRequestId = `conv-v2-attempt:${createHash('sha256').update(suffix).digest('hex')}`
  const calendarId = `calendar_consume_revalidation_${suffix}`
  const startTime = '2026-08-04T22:00:00.000Z'
  const selectionRequestDraftHash = createHash('sha256').update(`draft_${suffix}`).digest('hex')

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente revalidación consumo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, payment_provider,
        paid_at, created_at, updated_at
      ) VALUES (?, ?, 300, 'MXN', 'paid', 'live', 'manual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    await recordConversationalAgentEvent({
      eventId: reconciliationId,
      contactId,
      eventType: 'payment_reconciliation_v2',
      detail: {
        agentId,
        status: 'completed',
        ledgerPaymentId: paymentId,
        amount: 300,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        appointmentSelectionCalendarId: calendarId,
        appointmentSelectionStartTime: startTime,
        appointmentSelectionRequestDraftHash: selectionRequestDraftHash,
        appointmentSelectionBookingOwner: 'ai',
        appointmentSelectionTerminalToolName: 'book_appointment',
        result: { matched: true, signal: 'deposit_payment_verified' }
      },
      throwOnError: true
    })
    await reserveConversationalAppointmentDepositEvidence({
      reconciliationId,
      contactId,
      agentId,
      paymentId,
      appointmentRequestId,
      calendarId,
      startTime,
      selectionRequestDraftHash,
      bookingOwner: 'ai',
      terminalToolName: 'book_appointment'
    })
    await db.run(
      `INSERT INTO appointments (
        id, contact_id, status, appointment_status, start_time, end_time
      ) VALUES (?, ?, 'confirmed', 'confirmed', '2026-08-04T22:00:00.000Z', '2026-08-04T23:00:00.000Z')`,
      [appointmentId, contactId]
    )
    await db.run(
      `INSERT INTO appointment_creation_requests (
        client_request_id, request_hash, status, appointment_id, response_json,
        created_at, updated_at
      ) VALUES (?, ?, 'completed', ?, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [appointmentRequestId, createHash('sha256').update(`request_${suffix}`).digest('hex'), appointmentId]
    )

    await db.run(
      `UPDATE payments
       SET status = 'refunded', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [paymentId]
    )

    await assert.rejects(
      consumeConversationalAppointmentDepositEvidence({
        reconciliationId,
        contactId,
        agentId,
        paymentId,
        appointmentRequestId,
        appointmentId
      }),
      /anticipo ya no coincide/i
    )
    const reservation = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE id = ? AND event_type = 'deposit_payment_consumed'`,
      [`${reconciliationId}_consumed`]
    )
    assert.equal(JSON.parse(reservation.detail_json).status, 'reserved')
  } finally {
    await db.run('DELETE FROM appointment_creation_requests WHERE client_request_id = ?', [appointmentRequestId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('lease vencida recupera un anticipo sólo antes de la cita y una cita activa impide doble gasto', async () => {
  const suffix = randomUUID()
  const contactId = `contact_deposit_lease_${suffix}`
  const agentId = `agent_deposit_lease_${suffix}`
  const paymentId = `payment_deposit_lease_${suffix}`
  const reconciliationId = `carec_deposit_lease_${suffix}`
  const initialRequestId = `conv-v2-attempt:${createHash('sha256').update(`initial_${suffix}`).digest('hex')}`
  const candidateRequestIds = ['candidate_a', 'candidate_b'].map((label) => (
    `conv-v2-attempt:${createHash('sha256').update(`${label}_${suffix}`).digest('hex')}`
  ))
  const finalRequestId = `conv-v2-attempt:${createHash('sha256').update(`final_${suffix}`).digest('hex')}`
  const appointmentId = `appointment_deposit_lease_${suffix}`
  const calendarId = `calendar_deposit_lease_${suffix}`
  const startTime = '2026-08-11T22:00:00.000Z'
  const selectionRequestDraftHash = createHash('sha256').update(`draft_${suffix}`).digest('hex')

  const reserve = (appointmentRequestId) => reserveConversationalAppointmentDepositEvidence({
    reconciliationId,
    contactId,
    agentId,
    paymentId,
    appointmentRequestId,
    calendarId,
    startTime,
    selectionRequestDraftHash,
    bookingOwner: 'ai',
    terminalToolName: 'book_appointment'
  })
  const expireReservation = async () => {
    const row = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE id = ? AND event_type = 'deposit_payment_consumed'`,
      [`${reconciliationId}_consumed`]
    )
    const detail = JSON.parse(row.detail_json)
    detail.leaseUntilAt = '2000-01-01T00:00:00.000Z'
    await db.run(
      `UPDATE conversational_agent_events SET detail_json = ?
       WHERE id = ? AND detail_json = ?`,
      [JSON.stringify(detail), `${reconciliationId}_consumed`, row.detail_json]
    )
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente lease anticipo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, payment_provider,
        paid_at, created_at, updated_at
      ) VALUES (?, ?, 500, 'MXN', 'paid', 'live', 'manual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    await recordConversationalAgentEvent({
      eventId: reconciliationId,
      contactId,
      eventType: 'payment_reconciliation_v2',
      detail: {
        agentId,
        status: 'completed',
        ledgerPaymentId: paymentId,
        amount: 500,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        appointmentSelectionCalendarId: calendarId,
        appointmentSelectionStartTime: startTime,
        appointmentSelectionRequestDraftHash: selectionRequestDraftHash,
        appointmentSelectionBookingOwner: 'ai',
        appointmentSelectionTerminalToolName: 'book_appointment',
        result: { matched: true, signal: 'deposit_payment_verified' }
      },
      throwOnError: true
    })

    await assert.rejects(
      reserveConversationalAppointmentDepositEvidence({
        reconciliationId,
        contactId,
        agentId,
        paymentId,
        appointmentRequestId: initialRequestId,
        calendarId: `${calendarId}_otro`,
        startTime,
        selectionRequestDraftHash,
        bookingOwner: 'ai',
        terminalToolName: 'book_appointment'
      }),
      (error) => error?.code === 'appointment_deposit_binding_mismatch'
    )
    assert.equal(await db.get(
      'SELECT id FROM conversational_agent_events WHERE id = ?',
      [`${reconciliationId}_consumed`]
    ), null)

    const initial = await reserve(initialRequestId)
    assert.equal(initial.reserved, true)
    assert.ok(initial.claimToken)
    assert.ok(initial.leaseUntilAt)
    await expireReservation()

    const raced = await Promise.allSettled(candidateRequestIds.map((requestId) => reserve(requestId)))
    assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(raced.filter((result) => result.status === 'rejected').length, 1)
    const winnerIndex = raced.findIndex((result) => result.status === 'fulfilled')
    const winnerRequestId = candidateRequestIds[winnerIndex]
    assert.equal(raced[winnerIndex].value.recovered, true)
    const recoveredRow = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE id = ? AND event_type = 'deposit_payment_consumed'`,
      [`${reconciliationId}_consumed`]
    )
    const recoveredDetail = JSON.parse(recoveredRow.detail_json)
    assert.equal(recoveredDetail.appointmentRequestId, winnerRequestId)
    assert.equal(recoveredDetail.previousAppointmentRequestId, initialRequestId)
    assert.equal(recoveredDetail.recoveryReason, 'appointment_request_missing')

    await db.run(
      `INSERT INTO appointments (
        id, contact_id, status, appointment_status, start_time, end_time
      ) VALUES (?, ?, 'confirmed', 'confirmed', '2026-08-11T22:00:00.000Z', '2026-08-11T23:00:00.000Z')`,
      [appointmentId, contactId]
    )
    await db.run(
      `INSERT INTO appointment_creation_requests (
        client_request_id, request_hash, status, appointment_id, response_json,
        created_at, updated_at
      ) VALUES (?, ?, 'completed', ?, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [winnerRequestId, createHash('sha256').update(`winner_${suffix}`).digest('hex'), appointmentId]
    )
    await expireReservation()

    await assert.rejects(
      reserve(finalRequestId),
      /cita activa|estado incierto|reservado para otra cita/i
    )
    const protectedRow = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE id = ? AND event_type = 'deposit_payment_consumed'`,
      [`${reconciliationId}_consumed`]
    )
    assert.equal(JSON.parse(protectedRow.detail_json).appointmentRequestId, winnerRequestId)

    await db.run(
      `UPDATE appointments SET appointment_status = 'cancelled', status = 'cancelled'
       WHERE id = ?`,
      [appointmentId]
    )
    const afterCancellation = await reserve(finalRequestId)
    assert.equal(afterCancellation.recovered, true)
    const releasedCanonical = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE id = ? AND event_type = 'deposit_payment_consumed'`,
      [`${reconciliationId}_consumed`]
    )
    assert.equal(JSON.parse(releasedCanonical.detail_json).appointmentRequestId, finalRequestId)
    assert.equal(JSON.parse(releasedCanonical.detail_json).recoveryReason, 'canonical_appointment_inactive')
  } finally {
    await db.run('DELETE FROM appointment_creation_requests WHERE client_request_id IN (?, ?)', [
      candidateRequestIds[0],
      candidateRequestIds[1]
    ]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('book_appointment recupera end-to-end una lease vencida y el controller consume el fencing vigente', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_deposit_fence_${suffix}`
  const contactId = `contact_deposit_fence_${suffix}`
  const agentId = `agent_deposit_fence_${suffix}`
  const paymentId = `payment_deposit_fence_${suffix}`
  const reconciliationId = `carec_deposit_fence_${suffix}`
  const oldRequestId = `conv-v2-attempt:${createHash('sha256').update(`old_${suffix}`).digest('hex')}`
  const currency = await getAccountCurrency()
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 42 }).startOf('day')
  const monday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const slot = monday.set({ hour: 16, minute: 0, second: 0, millisecond: 0 })
  const capabilities = [
    { id: 'schedule_appointment', enabled: true, calendarId },
    {
      id: 'collect_payment',
      enabled: true,
      paymentMode: 'deposit',
      deposit: { enabled: true, mode: 'fixed', amount: 500, currency, methods: { paymentLink: true } }
    }
  ]

  try {
    await upsertLocalCalendar({
      id: calendarId,
      locationId: `location_${suffix}`,
      name: 'Agenda fencing anticipo',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [1], hours: [{ openHour: 16, openMinute: 0, closeHour: 17, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente fencing anticipo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, payment_provider,
        paid_at, created_at, updated_at
       ) VALUES (?, ?, 500, ?, 'paid', 'live', 'manual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId, currency]
    )
    const selectionCtx = v2Context(capabilities, {
      contactId,
      agentId,
      dryRun: false,
      executionId: `message_select_before_payment_${suffix}`,
      accountLocale: { currency }
    })
    selectionCtx.config.id = agentId
    const selectionAttempt = await createConversationalTools(selectionCtx)
      .find((item) => item.name === 'book_appointment')
      .invoke(null, JSON.stringify({
        startTime: slot.toUTC().toISO(),
        selectionEvidence: await authorizeAppointmentOffer(selectionCtx, slot.toUTC().toISO(), timezone),
        title: 'Valoración de rodilla',
        notes: 'Dolor de rodilla desde hace meses',
        attendeeName: null,
        attendeeContext: null,
        primaryAttendee: {
          name: 'Paty Jiménez',
          phone: null,
          phoneSourceQuote: null,
          email: null,
          emailSourceQuote: null,
          relation: 'Mamá del contacto'
        },
        guests: [{
          name: 'Ana Jiménez',
          phone: null,
          phoneSourceQuote: null,
          email: null,
          emailSourceQuote: null,
          relation: 'Acompañante'
        }]
      }))
    assert.equal(selectionAttempt.ok, false)
    assert.equal(selectionAttempt.paymentEvidenceRequired, true)
    const selectionEvent = await db.get(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_selection_verified'
       ORDER BY created_at DESC LIMIT 1`,
      [contactId, agentId]
    )
    assert.ok(selectionEvent?.id)
    const selectionDetail = JSON.parse(selectionEvent.detail_json)
    const sourceEventId = `cae_payment_source_${suffix}`
    await recordConversationalAgentEvent({
      eventId: sourceEventId,
      contactId,
      eventType: 'payment_link_created',
      detail: {
        agentId,
        ledgerPaymentId: paymentId,
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        appointmentSelectionEventId: selectionEvent.id,
        appointmentSelectionCalendarId: selectionDetail.calendarId,
        appointmentSelectionStartTime: selectionDetail.startTime,
        appointmentSelectionVerifiedAt: selectionDetail.verifiedAt,
        appointmentSelectionRequestDraftHash: selectionDetail.appointmentRequestDraftHash,
        appointmentSelectionBookingOwner: selectionDetail.bookingOwner,
        appointmentSelectionTerminalToolName: selectionDetail.terminalToolName
      },
      throwOnError: true
    })
    await recordConversationalAgentEvent({
      eventId: reconciliationId,
      contactId,
      eventType: 'payment_reconciliation_v2',
      detail: {
        agentId,
        sourceEventId,
        status: 'completed',
        ledgerPaymentId: paymentId,
        amount: 500,
        currency,
        paymentEnvironment: 'live',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        appointmentSelectionCalendarId: selectionDetail.calendarId,
        appointmentSelectionStartTime: selectionDetail.startTime,
        appointmentSelectionRequestDraftHash: selectionDetail.appointmentRequestDraftHash,
        appointmentSelectionBookingOwner: selectionDetail.bookingOwner,
        appointmentSelectionTerminalToolName: selectionDetail.terminalToolName,
        result: { matched: true, signal: 'deposit_payment_verified' }
      },
      throwOnError: true
    })
    await reserveConversationalAppointmentDepositEvidence({
      reconciliationId,
      contactId,
      agentId,
      paymentId,
      appointmentRequestId: oldRequestId,
      calendarId: selectionDetail.calendarId,
      startTime: selectionDetail.startTime,
      selectionRequestDraftHash: selectionDetail.appointmentRequestDraftHash,
      bookingOwner: selectionDetail.bookingOwner,
      terminalToolName: selectionDetail.terminalToolName
    })
    const reservationId = `${reconciliationId}_consumed`
    const reservation = await db.get('SELECT detail_json FROM conversational_agent_events WHERE id = ?', [reservationId])
    const expired = JSON.parse(reservation.detail_json)
    expired.leaseUntilAt = '2000-01-01T00:00:00.000Z'
    await db.run('UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?', [JSON.stringify(expired), reservationId])

    const tamperedSelectionDetail = JSON.parse(selectionEvent.detail_json)
    tamperedSelectionDetail.appointmentRequestDraft.primaryAttendee.name = 'Persona adulterada'
    tamperedSelectionDetail.appointmentRequestDraftHash = createHash('sha256')
      .update(JSON.stringify(tamperedSelectionDetail.appointmentRequestDraft))
      .digest('hex')
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?',
      [JSON.stringify(tamperedSelectionDetail), selectionEvent.id]
    )
    const tamperedCtx = v2Context(capabilities, {
      contactId,
      agentId,
      dryRun: false,
      executionId: `payment-resume:${reconciliationId}`,
      accountLocale: { currency }
    })
    tamperedCtx.config.id = agentId
    const tamperedResume = await createConversationalTools(tamperedCtx)
      .find((item) => item.name === 'book_appointment')
      .invoke(null, JSON.stringify({
        title: null,
        notes: null,
        attendeeName: null,
        attendeeContext: null,
        primaryAttendee: null,
        guests: []
      }))
    assert.equal(tamperedResume.ok, false, JSON.stringify(tamperedResume))
    assert.equal(tamperedResume.code, 'payment_resume_selection_mismatch')
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?', [contactId])).total), 0)
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?',
      [selectionEvent.detail_json, selectionEvent.id]
    )

    const ctx = v2Context(capabilities, {
      contactId,
      agentId,
      dryRun: false,
      executionId: `payment-resume:${reconciliationId}`,
      accountLocale: { currency }
    })
    ctx.config.id = agentId
    const result = await createConversationalTools(ctx)
      .find((item) => item.name === 'book_appointment')
      .invoke(null, JSON.stringify({
        title: null,
        notes: null,
        attendeeName: null,
        attendeeContext: null,
        primaryAttendee: null,
        guests: []
      }))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.appointment.startTime, slot.toUTC().toISO())
    assert.equal(ctx.actions[0]?.confirmationEvidence?.reusedForPaymentResume, true)
    assert.equal(ctx.actions[0]?.confirmationEvidence?.selectionEventId, selectionEvent.id)
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?', [contactId])).total), 1)
    const createdAppointment = await db.get(
      'SELECT id FROM appointments WHERE contact_id = ? ORDER BY start_time DESC LIMIT 1',
      [contactId]
    )
    const participantNames = (await db.all(
      `SELECT role, name_snapshot FROM appointment_participants
       WHERE appointment_id = ? ORDER BY role, position`,
      [createdAppointment.id]
    )).map((participant) => `${participant.role}:${participant.name_snapshot}`)
    assert.ok(participantNames.includes('primary_attendee:Paty Jiménez'), JSON.stringify(participantNames))
    assert.ok(participantNames.includes('guest:Ana Jiménez'), JSON.stringify(participantNames))
    const finalReservation = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [reservationId]
    )).detail_json)
    assert.equal(finalReservation.status, 'consumed')
    assert.notEqual(finalReservation.appointmentRequestId, oldRequestId)
    assert.ok(finalReservation.claimToken)
    assert.ok(finalReservation.appointmentId)
  } finally {
    await db.run(
      `DELETE FROM appointment_creation_requests
       WHERE appointment_id IN (SELECT id FROM appointments WHERE contact_id = ?)`,
      [contactId]
    ).catch(() => {})
    await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('binding de comprobante v2 es atómico, idempotente por mensaje y falla cerrado ante mutación', async () => {
  const suffix = randomUUID()
  const contactId = `contact_proof_binding_${suffix}`
  const agentId = `agent_proof_binding_${suffix}`
  const mediaMessageId = `media_proof_binding_${suffix}`
  const triggerName = `fail_proof_binding_${suffix.replaceAll('-', '_')}`

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente proof binding', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    const input = {
      contactId,
      amount: 250,
      currency: 'MXN',
      agentId,
      mediaUrl: 'https://example.com/proof-binding.jpg',
      mediaMessageId,
      conversationalBinding: {
        bindingKey: mediaMessageId,
        executionId: `message_${suffix}`,
        paymentPurpose: 'deposit',
        appointmentDeposit: false,
        confidence: 0.99
      }
    }
    const [first, crossAgentRace] = await Promise.all([
      registerAgentTransferPaymentProofForReview(input),
      registerAgentTransferPaymentProofForReview({
        ...input,
        agentId: `other_${agentId}`
      })
    ])
    assert.equal(crossAgentRace.paymentId, first.paymentId)
    assert.equal([first, crossAgentRace].filter((result) => result.alreadyRegistered === false).length, 1)
    const replay = await registerAgentTransferPaymentProofForReview(input)
    assert.equal(replay.paymentId, first.paymentId)
    assert.equal(replay.alreadyRegistered, true)

    const legacyBinding = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE id = ? AND event_type = 'deposit_transfer_pending_review'`,
      [first.bindingEventId]
    )
    const legacyBindingDetail = JSON.parse(legacyBinding.detail_json)
    delete legacyBindingDetail.afterPayment
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
      [JSON.stringify(legacyBindingDetail), first.bindingEventId, legacyBinding.detail_json]
    )
    const legacyReplay = await registerAgentTransferPaymentProofForReview(input)
    assert.equal(legacyReplay.paymentId, first.paymentId)
    assert.equal(legacyReplay.alreadyRegistered, true)

    await assert.rejects(
      registerAgentTransferPaymentProofForReview({ ...input, amount: 275 }),
      /incompatible|revisión humana/i
    )
    await assert.rejects(
      registerAgentTransferPaymentProofForReview({ ...input, currency: 'USD' }),
      /incompatible|revisión humana/i
    )
    await assert.rejects(
      registerAgentTransferPaymentProofForReview({
        ...input,
        conversationalBinding: {
          ...input.conversationalBinding,
          paymentPurpose: 'purchase'
        }
      }),
      /incompatible|revisión humana/i
    )
    const rows = await db.all('SELECT id FROM payments WHERE contact_id = ?', [contactId])
    assert.equal(rows.length, 1)
    const binding = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE id = ? AND event_type = 'deposit_transfer_pending_review'`,
      [first.bindingEventId]
    )
    assert.equal(JSON.parse(binding.detail_json).ledgerPaymentId, first.paymentId)

    await db.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON conversational_agent_events
      WHEN NEW.contact_id = '${contactId}' AND NEW.event_type = 'deposit_transfer_pending_review'
      BEGIN
        SELECT RAISE(ABORT, 'binding failure injected');
      END
    `)
    await assert.rejects(
      registerAgentTransferPaymentProofForReview({
        ...input,
        mediaMessageId: `media_rollback_${suffix}`,
        conversationalBinding: {
          ...input.conversationalBinding,
          bindingKey: `media_rollback_${suffix}`,
          executionId: `message_rollback_${suffix}`
        }
      }),
      /binding failure injected/
    )
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM payments WHERE contact_id = ?', [contactId])).total), 1)
  } finally {
    await db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('si el cierre de una cita v2 falla, no confirma al cliente y el siguiente inbound repara sin duplicar', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_completion_recovery_${suffix}`
  const contactId = `contact_completion_recovery_${suffix}`
  const agentId = `agent_completion_recovery_${suffix}`
  const triggerName = `fail_appointment_signal_${suffix.replaceAll('-', '_')}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 35 }).startOf('day')
  const nextTuesday = baseDay.plus({ days: (2 - baseDay.weekday + 7) % 7 })
  const slot = nextTuesday.set({ hour: 16, minute: 0, second: 0, millisecond: 0 })

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda recovery cierre',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [2], hours: [{ openHour: 16, openMinute: 0, closeHour: 17, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente recovery cierre', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO conversational_agent_state (contact_id, agent_id, channel, status, signal, created_at, updated_at)
       VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, agentId]
    )
    await db.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE UPDATE OF signal ON conversational_agent_state
      WHEN OLD.contact_id = '${contactId}' AND NEW.signal = 'appointment_booked'
      BEGIN
        SELECT RAISE(ABORT, 'signal failure injected');
      END
    `)

    const firstCtx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId }
    ], { contactId, dryRun: false, agentId, executionId: `first_message_${suffix}` })
    firstCtx.config.id = agentId
    const first = await createConversationalTools(firstCtx)
      .find((item) => item.name === 'book_appointment')
      .invoke(null, JSON.stringify({
        startTime: slot.toUTC().toISO(),
        selectionEvidence: await authorizeAppointmentOffer(firstCtx, slot.toUTC().toISO(), timezone),
        title: null,
        notes: null,
        attendeeName: null,
        attendeeContext: null
      }))
    assert.equal(first.ok, false, JSON.stringify(first))
    assert.equal(first.actionCompleted, false)
    assert.equal(first.durableEffectCommitted, true)
    assert.equal(first.completionSyncWarning, true)
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?', [contactId])).total), 1)
    const failedState = await db.get(
      'SELECT status, signal FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
      [contactId, agentId]
    )
    assert.equal(failedState.status, 'active')
    assert.equal(failedState.signal, null)

    await db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`)
    const retryCtx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId }
    ], { contactId, dryRun: false, agentId, executionId: `second_message_${suffix}` })
    retryCtx.config.id = agentId
    const retry = await createConversationalTools(retryCtx)
      .find((item) => item.name === 'book_appointment')
      .invoke(null, JSON.stringify({
        startTime: slot.plus({ weeks: 1 }).toUTC().toISO(),
        selectionEvidence: await authorizeAppointmentOffer(retryCtx, slot.plus({ weeks: 1 }).toUTC().toISO(), timezone),
        title: null,
        notes: null,
        attendeeName: null,
        attendeeContext: null
      }))
    assert.equal(retry.ok, true, JSON.stringify(retry))
    assert.equal(retry.alreadyBooked, true)
    assert.equal(retry.appointment.startTime, slot.toUTC().toISO())
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?', [contactId])).total), 1)
    const repairedState = await db.get(
      'SELECT status, signal FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
      [contactId, agentId]
    )
    assert.equal(repairedState.status, 'completed')
    assert.equal(repairedState.signal, 'appointment_booked')
  } finally {
    await db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`).catch(() => {})
    await db.run(
      `DELETE FROM appointment_creation_requests
       WHERE appointment_id IN (SELECT id FROM appointments WHERE contact_id = ?)`,
      [contactId]
    ).catch(() => {})
    await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('get_contact_appointments limita la agenda al dueño o solicitante del hilo y nunca autoriza a un invitado', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_owned_appointments_${suffix}`
  const contactId = `contact_owned_appointments_${suffix}`
  const otherContactId = `contact_other_appointments_${suffix}`
  const agentId = `agent_owned_appointments_${suffix}`
  const timezone = await getAccountTimezone()
  const monday = DateTime.now().setZone(timezone).plus({ days: 28 }).startOf('day')
    .plus({ days: (1 - DateTime.now().setZone(timezone).plus({ days: 28 }).weekday + 7) % 7 })
  const ownedId = `appointment_owned_${suffix}`
  const requesterId = `appointment_requester_${suffix}`
  const guestId = `appointment_guest_${suffix}`
  const cancelledId = `appointment_cancelled_${suffix}`
  const pastId = `appointment_past_${suffix}`
  const appointmentIds = [ownedId, requesterId, guestId, cancelledId, pastId]

  const insertAppointment = async ({ id, ownerId, start, status = 'confirmed' }) => {
    await db.run(
      `INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status,
        start_time, end_time, source, sync_status, date_added, date_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ristak', 'synced', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [id, calendarId, ownerId, `Cita ${id}`, status, status, start.toUTC().toISO(), start.plus({ hours: 1 }).toUTC().toISO()]
    )
  }

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda con propiedad conversacional',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      allowReschedule: true,
      allowCancellation: true,
      openHours: [{ daysOfTheWeek: [1], hours: [{ openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto del hilo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Otro contacto', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [otherContactId]
    )

    await insertAppointment({ id: ownedId, ownerId: contactId, start: monday.set({ hour: 9 }) })
    await insertAppointment({ id: requesterId, ownerId: otherContactId, start: monday.set({ hour: 11 }) })
    await insertAppointment({ id: guestId, ownerId: otherContactId, start: monday.set({ hour: 13 }) })
    await insertAppointment({ id: cancelledId, ownerId: contactId, start: monday.set({ hour: 15 }), status: 'cancelled' })
    await insertAppointment({ id: pastId, ownerId: contactId, start: DateTime.now().setZone(timezone).minus({ days: 2 }).startOf('hour') })
    await db.run(
      `INSERT INTO appointment_participants (
        id, appointment_id, role, position, contact_id, name_snapshot, created_at, updated_at
      ) VALUES (?, ?, 'requester', 0, ?, 'Contacto del hilo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [`participant_requester_${suffix}`, requesterId, contactId]
    )
    await db.run(
      `INSERT INTO appointment_participants (
        id, appointment_id, role, position, contact_id, name_snapshot, created_at, updated_at
      ) VALUES (?, ?, 'guest', 0, ?, 'Contacto invitado', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [`participant_guest_${suffix}`, guestId, contactId]
    )

    const ctx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId, allowOverlaps: false }
    ], { contactId, agentId, dryRun: false, executionId: `message_owned_${suffix}` })
    ctx.config.id = agentId
    const tools = createConversationalTools(ctx)
    const listed = await tools.find((item) => item.name === 'get_contact_appointments').invoke(null, '{}')
    assert.equal(listed.ok, true, JSON.stringify(listed))
    assert.equal(listed.found, true)
    assert.equal(listed.policy.canReschedule, true)
    assert.equal(listed.policy.canCancel, true)
    assert.deepEqual(
      new Set(listed.appointments.map((appointment) => appointment.appointmentId)),
      new Set([ownedId, requesterId])
    )
    assert.ok(listed.appointments.every((appointment) => appointment.localLabel && appointment.startTime.endsWith('Z')))

    const forbiddenCancellation = await tools.find((item) => item.name === 'cancel_appointment').invoke(null, JSON.stringify({
      appointmentId: guestId,
      reason: 'El invitado no puede controlar esta cita'
    }))
    assert.equal(forbiddenCancellation.ok, false)
    assert.match(forbiddenCancellation.error, /no encontré|contacto/i)
    const guestRow = await db.get('SELECT appointment_status, deleted_at FROM appointments WHERE id = ?', [guestId])
    assert.equal(guestRow.appointment_status, 'confirmed')
    assert.equal(guestRow.deleted_at, null)
  } finally {
    await db.run(
      `DELETE FROM appointment_participants WHERE appointment_id IN (${appointmentIds.map(() => '?').join(', ')})`,
      appointmentIds
    ).catch(() => {})
    await db.run(
      `DELETE FROM appointments WHERE id IN (${appointmentIds.map(() => '?').join(', ')})`,
      appointmentIds
    ).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id IN (?, ?)', [contactId, otherContactId]).catch(() => {})
  }
})

test('cancel_appointment hace soft cancel idempotente, conserva participantes y respeta allowCancellation', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_cancel_tool_${suffix}`
  const contactId = `contact_cancel_tool_${suffix}`
  const agentId = `agent_cancel_tool_${suffix}`
  const appointmentId = `appointment_cancel_tool_${suffix}`
  const deniedAppointmentId = `appointment_cancel_denied_${suffix}`
  const timezone = await getAccountTimezone()
  const monday = DateTime.now().setZone(timezone).plus({ days: 31 }).startOf('day')
    .plus({ days: (1 - DateTime.now().setZone(timezone).plus({ days: 31 }).weekday + 7) % 7 })

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda cancelación segura',
      source: 'ristak',
      allowCancellation: true,
      allowReschedule: true,
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [1], hours: [{ openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente cancelación segura', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    for (const [id, hour] of [[appointmentId, 10], [deniedAppointmentId, 13]]) {
      const start = monday.set({ hour, minute: 0 })
      await db.run(
        `INSERT INTO appointments (
          id, calendar_id, contact_id, title, status, appointment_status,
          start_time, end_time, source, sync_status, date_added, date_updated
        ) VALUES (?, ?, ?, 'Cita cancelable', 'confirmed', 'confirmed', ?, ?, 'ristak', 'synced', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id, calendarId, contactId, start.toUTC().toISO(), start.plus({ hours: 1 }).toUTC().toISO()]
      )
    }
    await db.run(
      `INSERT INTO appointment_participants (
        id, appointment_id, role, position, contact_id, name_snapshot, created_at, updated_at
      ) VALUES (?, ?, 'requester', 0, ?, 'Cliente cancelación segura', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [`participant_cancel_${suffix}`, appointmentId, contactId]
    )

    const previewCtx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId, allowOverlaps: false }
    ], { contactId, agentId, dryRun: true, executionId: `preview_offer_cancel_${suffix}` })
    previewCtx.config.id = agentId
    const previewOffer = await createConversationalTools(previewCtx)
      .find((item) => item.name === 'offer_appointment_slot')
      .invoke(null, JSON.stringify({
        startTime: monday.set({ hour: 12, minute: 0 }).toUTC().toISO(),
        appointmentId
      }))
    assert.equal(previewOffer.ok, true, JSON.stringify(previewOffer))
    previewCtx.executionId = `preview_cancel_${suffix}`
    const previewCancel = await createConversationalTools(previewCtx)
      .find((item) => item.name === 'cancel_appointment')
      .invoke(null, JSON.stringify({ appointmentId, reason: null }))
    assert.equal(previewCancel.ok, true, JSON.stringify(previewCancel))
    assert.equal(previewCancel.simulated, true)
    const previewOfferEvent = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'appointment_slot_preview_offer_created'`,
      [contactId]
    )
    const previewOfferDetail = JSON.parse(previewOfferEvent.detail_json)
    assert.equal(previewOfferDetail.status, 'superseded')
    assert.equal(previewOfferDetail.resolution, 'appointment_cancelled')

    const ctx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId, allowOverlaps: false }
    ], { contactId, agentId, dryRun: false, executionId: `message_cancel_${suffix}` })
    ctx.config.id = agentId
    const activeRescheduleOffer = await createConversationalTools(ctx)
      .find((item) => item.name === 'offer_appointment_slot')
      .invoke(null, JSON.stringify({
        startTime: monday.set({ hour: 11, minute: 0 }).toUTC().toISO(),
        appointmentId
      }))
    assert.equal(activeRescheduleOffer.ok, true, JSON.stringify(activeRescheduleOffer))
    ctx.executionId = `message_cancel_after_offer_${suffix}`
    const cancel = createConversationalTools(ctx).find((item) => item.name === 'cancel_appointment')
    const first = await cancel.invoke(null, JSON.stringify({ appointmentId, reason: 'Ya no podré asistir' }))
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(first.actionCompleted, true)
    assert.equal(first.appointmentCancelled, true)

    const stored = await db.get(
      'SELECT status, appointment_status, deleted_at FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(stored.status, 'cancelled')
    assert.equal(stored.appointment_status, 'cancelled')
    assert.equal(stored.deleted_at, null)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointment_participants WHERE appointment_id = ?',
      [appointmentId]
    )).total), 1)
    const supersededOffer = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'appointment_slot_offer_created'`,
      [contactId]
    )
    const supersededDetail = JSON.parse(supersededOffer.detail_json)
    assert.equal(supersededDetail.appointmentId, appointmentId)
    assert.equal(supersededDetail.status, 'superseded')
    assert.equal(supersededDetail.resolution, 'appointment_cancelled')

    const replay = await cancel.invoke(null, JSON.stringify({ appointmentId, reason: 'Retry del mismo mensaje' }))
    assert.equal(replay.ok, true, JSON.stringify(replay))
    assert.equal(replay.alreadyCancelled, true)
    assert.match(replay.visibleReply, /ya estaba cancelada/i)
    const cancelActions = ctx.actions.filter((action) => action.type === 'cancel_appointment')
    assert.equal(cancelActions.length, 2)
    assert.equal(cancelActions[1].outcome?.alreadyCancelled, true)
    assert.equal(ensureToolCallingV2VisibleReply('', [cancelActions[1]]), 'listo, la cita quedó cancelada')

    await db.run('UPDATE calendars SET allow_cancellation = 0 WHERE id = ?', [calendarId])
    const deniedCtx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId, allowOverlaps: false }
    ], { contactId, agentId, dryRun: false, executionId: `message_cancel_denied_${suffix}` })
    deniedCtx.config.id = agentId
    const denied = await createConversationalTools(deniedCtx)
      .find((item) => item.name === 'cancel_appointment')
      .invoke(null, JSON.stringify({ appointmentId: deniedAppointmentId, reason: null }))
    assert.equal(denied.ok, false)
    assert.match(denied.error, /no permite cancelar/i)
    assert.equal((await db.get(
      'SELECT appointment_status FROM appointments WHERE id = ?',
      [deniedAppointmentId]
    )).appointment_status, 'confirmed')
  } finally {
    await db.run('DELETE FROM appointment_participants WHERE appointment_id IN (?, ?)', [appointmentId, deniedAppointmentId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE id IN (?, ?)', [appointmentId, deniedAppointmentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('aceptar una oferta de reagendamiento conserva ID y participantes, mueve disponibilidad y no crea cita ni cobro', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_reschedule_tool_${suffix}`
  const contactId = `contact_reschedule_tool_${suffix}`
  const agentId = `agent_reschedule_tool_${suffix}`
  const appointmentId = `appointment_reschedule_tool_${suffix}`
  const currency = await getAccountCurrency()
  const timezone = await getAccountTimezone()
  const monday = DateTime.now().setZone(timezone).plus({ days: 35 }).startOf('day')
    .plus({ days: (1 - DateTime.now().setZone(timezone).plus({ days: 35 }).weekday + 7) % 7 })
  const originalStart = monday.set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
  const targetStart = monday.set({ hour: 12, minute: 0, second: 0, millisecond: 0 })
  const thirdStart = monday.set({ hour: 14, minute: 0, second: 0, millisecond: 0 })
  const capabilities = [
    { id: 'schedule_appointment', enabled: true, calendarId, allowOverlaps: false },
    {
      id: 'collect_payment',
      enabled: true,
      collectionMethod: 'payment_link',
      paymentMode: 'deposit',
      gateway: 'stripe',
      deposit: {
        enabled: true,
        mode: 'fixed',
        amount: 500,
        currency,
        methods: { paymentLink: true }
      }
    }
  ]

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda reagendamiento seguro',
      source: 'ristak',
      allowReschedule: true,
      allowCancellation: true,
      slotDuration: 90,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [1], hours: [{ openHour: 9, openMinute: 0, closeHour: 16, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente reagendamiento seguro', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status,
        start_time, end_time, source, sync_status, date_added, date_updated
      ) VALUES (?, ?, ?, 'Valoración inicial', 'confirmed', 'confirmed', ?, ?, 'ristak', 'synced', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [appointmentId, calendarId, contactId, originalStart.toUTC().toISO(), originalStart.plus({ minutes: 90 }).toUTC().toISO()]
    )
    await db.run(
      `INSERT INTO appointment_participants (
        id, appointment_id, role, position, contact_id, name_snapshot, created_at, updated_at
      ) VALUES (?, ?, 'requester', 0, ?, 'Cliente reagendamiento seguro', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [`participant_reschedule_${suffix}`, appointmentId, contactId]
    )

    const ctx = v2Context(capabilities, {
      contactId,
      agentId,
      dryRun: false,
      executionId: `offer_reschedule_${suffix}`,
      accountLocale: { currency }
    })
    ctx.config.id = agentId
    await persistLiveAgentConfig(ctx)
    const rescheduleAvailability = await createConversationalTools(ctx)
      .find((item) => item.name === 'get_free_slots')
      .invoke(null, JSON.stringify({
        startDate: monday.toISODate(),
        endDate: monday.toISODate(),
        appointmentId
      }))
    assert.equal(rescheduleAvailability.ok, true, JSON.stringify(rescheduleAvailability))
    assert.equal(rescheduleAvailability.purpose, 'reschedule')
    assert.equal(rescheduleAvailability.appointmentId, appointmentId)
    assert.equal(rescheduleAvailability.durationMinutes, 90)
    assert.ok(
      rescheduleAvailability.slots.flatMap((day) => day.options).some((option) => option.startTime === targetStart.toUTC().toISO())
    )
    const offered = await createConversationalTools(ctx)
      .find((item) => item.name === 'offer_appointment_slot')
      .invoke(null, JSON.stringify({
        startTime: targetStart.toUTC().toISO(),
        appointmentId,
        selectionContext: 'replacement'
      }))
    assert.equal(offered.ok, true, JSON.stringify(offered))
    assert.match(offered.visibleReply, /^Va, la nueva opción sería /)
    assert.match(offered.visibleReply, /¿Confirmas que cambie tu cita a ese horario\?$/)
    assert.doesNotMatch(offered.visibleReply, /anticipo|te agende/i)

    const confirmationExecutionId = `confirm_reschedule_${suffix}`
    ctx.executionId = confirmationExecutionId
    ctx.actions = []
    ctx.conversationMessages = [
      { id: `offer_reschedule_${suffix}`, role: 'user', content: 'Quiero mover esa cita a las doce.' },
      { id: `visible_offer_reschedule_${suffix}`, role: 'assistant', content: offered.visibleReply },
      { id: confirmationExecutionId, role: 'user', content: 'Sí, mejor cámbiamela a ese horario.' }
    ]
    ctx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx,
      config: ctx.config
    })
    assert.equal(ctx.appointmentOfferDecision?.purpose, 'reschedule')
    assert.equal(ctx.appointmentOfferDecision?.appointmentId, appointmentId)

    const confirmationTools = createConversationalTools(ctx)
    assert.equal(confirmationTools.some((item) => item.name === 'book_appointment'), false)
    assert.equal(confirmationTools.some((item) => item.name === 'reschedule_appointment'), false)
    assert.equal(confirmationTools.some((item) => item.name === 'request_human_booking'), false)
    assert.ok(confirmationTools.some((item) => item.name === 'resolve_active_appointment_offer'))
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ?',
      [calendarId]
    )).total), 1)

    const resolved = await createConversationalTools(ctx)
      .find((item) => item.name === 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify({
        decision: 'accept',
        reply: null,
        title: null,
        notes: null,
        attendeeName: null,
        attendeeContext: null,
        primaryAttendee: null,
        guests: [],
        agreedAmount: null
      }))
    assert.equal(resolved.ok, true, JSON.stringify(resolved))
    assert.equal(resolved.actionCompleted, true)
    assert.match(resolved.visibleReply, /cita quedó cambiada/i)

    const appointments = await db.all(
      'SELECT id, start_time, end_time, status, appointment_status, deleted_at FROM appointments WHERE calendar_id = ?',
      [calendarId]
    )
    assert.equal(appointments.length, 1)
    assert.equal(appointments[0].id, appointmentId)
    assert.equal(new Date(appointments[0].start_time).toISOString(), targetStart.toUTC().toISO())
    assert.equal(new Date(appointments[0].end_time).toISOString(), targetStart.plus({ minutes: 90 }).toUTC().toISO())
    assert.equal(appointments[0].deleted_at, null)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointment_participants WHERE appointment_id = ?',
      [appointmentId]
    )).total), 1)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM payments WHERE contact_id = ?',
      [contactId]
    )).total), 0)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_link_created'`,
      [contactId]
    )).total), 0)
    assert.equal(ctx.actions.some((action) => action.type === 'book_appointment'), false)
    assert.equal(ctx.actions.some((action) => action.type === 'create_payment_link'), false)
    assert.equal(ctx.actions.filter((action) => action.type === 'reschedule_appointment').length, 1)

    const replay = await createConversationalTools(ctx)
      .find((item) => item.name === 'reschedule_appointment')
      .invoke(null, JSON.stringify({ appointmentId }))
    assert.equal(replay.ok, true, JSON.stringify(replay))
    assert.equal(replay.alreadyRescheduled, true)
    assert.match(replay.visibleReply, /ya tenía el horario nuevo/i)
    assert.equal(ctx.actions.filter((action) => action.type === 'reschedule_appointment').length, 2)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ?',
      [calendarId]
    )).total), 1)

    const availability = await createConversationalTools(ctx)
      .find((item) => item.name === 'get_free_slots')
      .invoke(null, JSON.stringify({ startDate: monday.toISODate(), endDate: monday.toISODate() }))
    const availableStarts = availability.slots.flatMap((day) => day.options).map((option) => option.startTime)
    assert.ok(availableStarts.includes(originalStart.toUTC().toISO()), JSON.stringify(availability))
    assert.equal(availableStarts.includes(targetStart.toUTC().toISO()), false)

    await db.run('UPDATE calendars SET allow_reschedule = 0 WHERE id = ?', [calendarId])
    ctx.executionId = `offer_reschedule_denied_${suffix}`
    const deniedOffer = await createConversationalTools(ctx)
      .find((item) => item.name === 'offer_appointment_slot')
      .invoke(null, JSON.stringify({ startTime: thirdStart.toUTC().toISO(), appointmentId }))
    assert.equal(deniedOffer.ok, false)
    assert.match(deniedOffer.error, /no permite reagendar/i)
  } finally {
    await db.run(
      `DELETE FROM appointment_creation_requests
       WHERE appointment_id IN (SELECT id FROM appointments WHERE calendar_id = ?)`,
      [calendarId]
    ).catch(() => {})
    await db.run('DELETE FROM appointment_participants WHERE appointment_id = ?', [appointmentId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('agenda humana entrega un reagendamiento confirmado sin exponer la tool que mueve la cita', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_human_reschedule_${suffix}`
  const contactId = `contact_human_reschedule_${suffix}`
  const agentId = `agent_human_reschedule_${suffix}`
  const appointmentId = `appointment_human_reschedule_${suffix}`
  const participantId = `participant_human_reschedule_${suffix}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 42 }).startOf('day')
  const monday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const originalStart = monday.set({ hour: 10, minute: 0, second: 0, millisecond: 0 })
  const requestedStart = monday.set({ hour: 13, minute: 0, second: 0, millisecond: 0 })
  const capabilities = [{
    id: 'schedule_appointment',
    enabled: true,
    calendarId,
    bookingOwner: 'human',
    allowOverlaps: false
  }]

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda humana para cambios',
      source: 'ristak',
      allowReschedule: true,
      allowCancellation: true,
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{
        daysOfTheWeek: [1],
        hours: [{ openHour: 9, openMinute: 0, closeHour: 16, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente con reagenda humana', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO appointments (
         id, calendar_id, contact_id, title, status, appointment_status,
         start_time, end_time, source, sync_status, date_added, date_updated
       ) VALUES (?, ?, ?, 'Cita que sólo moverá el equipo', 'confirmed', 'confirmed', ?, ?, 'ristak', 'synced', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        appointmentId,
        calendarId,
        contactId,
        originalStart.toUTC().toISO(),
        originalStart.plus({ hours: 1 }).toUTC().toISO()
      ]
    )
    await db.run(
      `INSERT INTO appointment_participants (
         id, appointment_id, role, position, contact_id, name_snapshot, created_at, updated_at
       ) VALUES (?, ?, 'requester', 0, ?, 'Cliente con reagenda humana', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [participantId, appointmentId, contactId]
    )

    const ctx = v2Context(capabilities, {
      contactId,
      agentId,
      dryRun: false,
      executionId: `offer_human_reschedule_${suffix}`
    })
    ctx.config.id = agentId
    await persistLiveAgentConfig(ctx)
    const initialTools = createConversationalTools(ctx)
    assert.ok(initialTools.some((item) => item.name === 'request_human_booking'))
    assert.equal(initialTools.some((item) => item.name === 'reschedule_appointment'), false)

    const availability = await initialTools
      .find((item) => item.name === 'get_free_slots')
      .invoke(null, JSON.stringify({
        startDate: monday.toISODate(),
        endDate: monday.toISODate(),
        appointmentId
      }))
    assert.equal(availability.ok, true, JSON.stringify(availability))
    assert.equal(availability.purpose, 'reschedule')
    assert.ok(
      availability.slots
        .flatMap((day) => day.options)
        .some((option) => option.startTime === requestedStart.toUTC().toISO()),
      JSON.stringify(availability)
    )
    const offered = await initialTools
      .find((item) => item.name === 'offer_appointment_slot')
      .invoke(null, JSON.stringify({
        startTime: requestedStart.toUTC().toISO(),
        appointmentId,
        selectionContext: 'replacement'
      }))
    assert.equal(offered.ok, true, JSON.stringify(offered))
    assert.match(offered.visibleReply, /^Va, la nueva opción sería /)
    assert.match(
      offered.visibleReply,
      /¿Confirmas que envíe al equipo la solicitud para cambiar tu cita a ese horario\?$/
    )
    assert.doesNotMatch(offered.visibleReply, /ya (?:cambi|mov)|te agende/i)

    const confirmationExecutionId = `confirm_human_reschedule_${suffix}`
    ctx.executionId = confirmationExecutionId
    ctx.actions = []
    ctx.conversationMessages = [
      { id: `offer_human_reschedule_${suffix}`, role: 'user', content: 'Quiero mover esa cita a la una.' },
      { id: `visible_human_reschedule_${suffix}`, role: 'assistant', content: offered.visibleReply },
      { id: confirmationExecutionId, role: 'user', content: 'Sí, ese nuevo horario me funciona.' }
    ]
    ctx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx,
      config: ctx.config
    })
    assert.equal(ctx.appointmentOfferDecision?.purpose, 'reschedule')
    assert.equal(ctx.appointmentOfferDecision?.terminalToolName, 'request_human_booking')

    const confirmationTools = createConversationalTools(ctx)
    assert.ok(confirmationTools.some((item) => item.name === 'resolve_active_appointment_offer'))
    assert.equal(confirmationTools.some((item) => item.name === 'reschedule_appointment'), false)
    const resolved = await confirmationTools
      .find((item) => item.name === 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify({
        decision: 'accept',
        reply: null,
        title: null,
        notes: null,
        attendeeName: null,
        attendeeContext: null,
        primaryAttendee: null,
        guests: [],
        agreedAmount: null
      }))
    assert.equal(resolved.ok, true, JSON.stringify(resolved))
    assert.equal(resolved.actionCompleted, true)
    assert.equal(resolved.transferredToHuman, true)
    assert.equal(resolved.appointmentRescheduled, false)
    assert.match(resolved.visibleReply, /conserva el horario anterior/i)

    const appointment = await db.get(
      `SELECT id, start_time, end_time, status, appointment_status, deleted_at
       FROM appointments WHERE id = ?`,
      [appointmentId]
    )
    assert.equal(appointment.id, appointmentId)
    assert.equal(new Date(appointment.start_time).toISOString(), originalStart.toUTC().toISO())
    assert.equal(new Date(appointment.end_time).toISOString(), originalStart.plus({ hours: 1 }).toUTC().toISO())
    assert.equal(appointment.status, 'confirmed')
    assert.equal(appointment.appointment_status, 'confirmed')
    assert.equal(appointment.deleted_at, null)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ?',
      [calendarId]
    )).total), 1)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointment_participants WHERE appointment_id = ?',
      [appointmentId]
    )).total), 1)

    const state = await db.get(
      `SELECT status, signal FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      [contactId, agentId]
    )
    assert.equal(state.status, 'human')
    assert.equal(state.signal, 'ready_for_human')
    const handoffEvent = JSON.parse((await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'human_reschedule_requested'`,
      [contactId, agentId]
    )).detail_json)
    assert.equal(handoffEvent.appointmentId, appointmentId)
    assert.equal(handoffEvent.appointmentRescheduled, false)
    assert.equal(handoffEvent.requestedStartTime, requestedStart.toUTC().toISO())
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'priority_push_notification'`,
      [contactId]
    )).total), 1)
    assert.equal(ctx.actions.some((action) => action.type === 'reschedule_appointment'), false)
    assert.equal(ctx.actions.filter((action) => action.type === 'request_human_booking').length, 1)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM appointment_participants WHERE appointment_id = ?', [appointmentId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('get_contact_appointments pagina todas las citas futuras sin abrir IDs de otros contactos', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_paginated_appointments_${suffix}`
  const contactId = `contact_paginated_appointments_${suffix}`
  const agentId = `agent_paginated_appointments_${suffix}`
  const appointmentIds = Array.from({ length: 12 }, (_, index) => `appointment_paginated_${index}_${suffix}`)
  const base = DateTime.now().toUTC().plus({ days: 45 }).startOf('day')

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda paginada',
      source: 'ristak',
      allowCancellation: true,
      allowReschedule: true
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente con recurrencias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    for (let index = 0; index < appointmentIds.length; index += 1) {
      const start = base.plus({ days: index, hours: 10 })
      await db.run(
        `INSERT INTO appointments (
          id, calendar_id, contact_id, title, status, appointment_status,
          start_time, end_time, source, sync_status, date_added, date_updated
        ) VALUES (?, ?, ?, ?, 'confirmed', 'confirmed', ?, ?, 'ristak', 'synced', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [appointmentIds[index], calendarId, contactId, `Cita recurrente ${index + 1}`, start.toISO(), start.plus({ hours: 1 }).toISO()]
      )
    }

    const ctx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId, allowOverlaps: false }
    ], { contactId, agentId, dryRun: false, executionId: `message_pagination_${suffix}` })
    ctx.config.id = agentId
    const listTool = createConversationalTools(ctx).find((item) => item.name === 'get_contact_appointments')
    const firstPage = await listTool.invoke(null, JSON.stringify({ page: 1, pageSize: 5 }))
    const thirdPage = await listTool.invoke(null, JSON.stringify({ page: 3, pageSize: 5 }))

    assert.equal(firstPage.ok, true)
    assert.equal(firstPage.total, 12)
    assert.equal(firstPage.returned, 5)
    assert.equal(firstPage.hasMore, true)
    assert.equal(firstPage.nextPage, 2)
    assert.deepEqual(firstPage.appointments.map((item) => item.appointmentId), appointmentIds.slice(0, 5))
    assert.equal(thirdPage.total, 12)
    assert.equal(thirdPage.returned, 2)
    assert.equal(thirdPage.hasMore, false)
    assert.equal(thirdPage.nextPage, null)
    assert.deepEqual(thirdPage.appointments.map((item) => item.appointmentId), appointmentIds.slice(10))
  } finally {
    await db.run(
      `DELETE FROM appointments WHERE id IN (${appointmentIds.map(() => '?').join(', ')})`,
      appointmentIds
    ).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('dos cancelaciones concurrentes se serializan y la segunda queda como replay sin repetir mutación', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_concurrent_cancel_${suffix}`
  const contactId = `contact_concurrent_cancel_${suffix}`
  const appointmentId = `appointment_concurrent_cancel_${suffix}`
  const agentId = `agent_concurrent_cancel_${suffix}`
  const start = DateTime.now().toUTC().plus({ days: 50 }).startOf('hour')

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda cancelación concurrente',
      source: 'ristak',
      allowCancellation: true
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente cancelación concurrente', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status,
        start_time, end_time, source, sync_status, date_added, date_updated
      ) VALUES (?, ?, ?, 'Cita concurrente', 'confirmed', 'confirmed', ?, ?, 'ristak', 'synced', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [appointmentId, calendarId, contactId, start.toISO(), start.plus({ hours: 1 }).toISO()]
    )

    const makeCtx = (executionId) => {
      const ctx = v2Context([
        { id: 'schedule_appointment', enabled: true, calendarId, allowOverlaps: false }
      ], { contactId, agentId, dryRun: false, executionId })
      ctx.config.id = agentId
      return ctx
    }
    const contexts = [makeCtx(`cancel_a_${suffix}`), makeCtx(`cancel_b_${suffix}`)]
    const results = await Promise.all(contexts.map((ctx) => createConversationalTools(ctx)
      .find((item) => item.name === 'cancel_appointment')
      .invoke(null, JSON.stringify({ appointmentId, reason: null }))))

    assert.ok(results.every((result) => result.ok === true), JSON.stringify(results))
    assert.equal(results.filter((result) => result.alreadyCancelled === true).length, 1)
    assert.ok(contexts.every((ctx) => ctx.actions.filter((action) => action.type === 'cancel_appointment').length === 1))
    assert.equal((await db.get(
      'SELECT appointment_status FROM appointments WHERE id = ?',
      [appointmentId]
    )).appointment_status, 'cancelled')
  } finally {
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('cancelar y reagendar compiten con CAS: sólo una mutación gana y una cita cancelada nunca se reporta reagendada', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_lifecycle_cas_${suffix}`
  const contactId = `contact_lifecycle_cas_${suffix}`
  const appointmentId = `appointment_lifecycle_cas_${suffix}`
  const originalStart = DateTime.now().toUTC().plus({ days: 55 }).startOf('hour')
  const targetStart = originalStart.plus({ hours: 3 })

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda CAS lifecycle',
      source: 'ristak',
      allowCancellation: true,
      allowReschedule: true,
      openHours: [{
        daysOfTheWeek: [targetStart.setZone(await getAccountTimezone()).weekday % 7],
        hours: [{ openHour: 0, openMinute: 0, closeHour: 23, closeMinute: 59 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente CAS lifecycle', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status,
        start_time, end_time, source, sync_status, date_added, date_updated
      ) VALUES (?, ?, ?, 'Cita CAS', 'confirmed', 'confirmed', ?, ?, 'ristak', 'synced', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [appointmentId, calendarId, contactId, originalStart.toISO(), originalStart.plus({ hours: 1 }).toISO()]
    )

    const expected = {
      expectedStartTime: originalStart.toISO(),
      expectedEndTime: originalStart.plus({ hours: 1 }).toISO(),
      expectedAppointmentStatus: 'confirmed'
    }
    const [cancelResponse, rescheduleResponse] = await Promise.all([
      invokeController(updateCalendarAppointment, {
        params: { id: appointmentId },
        body: {
          ...expected,
          appointmentStatus: 'cancelled',
          status: 'cancelled',
          strictLifecycleMutation: 'cancel'
        }
      }),
      invokeController(updateCalendarAppointment, {
        params: { id: appointmentId },
        body: {
          ...expected,
          startTime: targetStart.toISO(),
          endTime: targetStart.plus({ hours: 1 }).toISO(),
          strictAvailabilityCheck: true,
          strictLifecycleMutation: 'reschedule'
        }
      })
    ])

    assert.deepEqual([cancelResponse.statusCode, rescheduleResponse.statusCode].sort(), [200, 409])
    let stored = await db.get(
      'SELECT start_time, end_time, appointment_status FROM appointments WHERE id = ?',
      [appointmentId]
    )
    const cancelledWon = stored.appointment_status === 'cancelled'
    if (!cancelledWon) {
      assert.equal(new Date(stored.start_time).toISOString(), targetStart.toISO())
      const finalCancel = await invokeController(updateCalendarAppointment, {
        params: { id: appointmentId },
        body: {
          appointmentStatus: 'cancelled',
          status: 'cancelled',
          expectedStartTime: targetStart.toISO(),
          expectedEndTime: targetStart.plus({ hours: 1 }).toISO(),
          expectedAppointmentStatus: 'confirmed',
          strictLifecycleMutation: 'cancel'
        }
      })
      assert.equal(finalCancel.statusCode, 200)
    }
    stored = await db.get('SELECT start_time, end_time, appointment_status FROM appointments WHERE id = ?', [appointmentId])
    assert.equal(stored.appointment_status, 'cancelled')

    const rejectedReschedule = await invokeController(updateCalendarAppointment, {
      params: { id: appointmentId },
      body: {
        startTime: targetStart.plus({ hours: 2 }).toISO(),
        endTime: targetStart.plus({ hours: 3 }).toISO(),
        expectedStartTime: stored.start_time,
        expectedEndTime: stored.end_time,
        expectedAppointmentStatus: 'cancelled',
        strictAvailabilityCheck: true,
        strictLifecycleMutation: 'reschedule'
      }
    })
    assert.equal(rejectedReschedule.statusCode, 409)
    assert.equal(rejectedReschedule.payload.code, 'appointment_lifecycle_inactive')
  } finally {
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('una edición se guarda primero en Ristak y la respuesta de HighLevel sólo confirma el espejo', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_preserve_contact_${suffix}`
  const contactId = `contact_preserve_contact_${suffix}`
  const appointmentId = `appointment_preserve_contact_${suffix}`
  const ghlAppointmentId = `ghl_appointment_preserve_contact_${suffix}`
  const start = DateTime.now().toUTC().plus({ days: 60 }).startOf('hour')
  const previousFetch = globalThis.fetch

  try {
    await upsertLocalCalendar({
      id: calendarId,
      ghlCalendarId: `ghl_calendar_preserve_contact_${suffix}`,
      name: 'Agenda HighLevel contacto local',
      source: 'ghl'
    }, { source: 'ghl', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto local canónico', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO appointments (
        id, ghl_appointment_id, calendar_id, contact_id, title, status, appointment_status,
        start_time, end_time, source, sync_status, date_added, date_updated
      ) VALUES (?, ?, ?, ?, 'Cita ligada a GHL', 'confirmed', 'confirmed', ?, ?, 'ghl', 'synced', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [appointmentId, ghlAppointmentId, calendarId, contactId, start.toISO(), start.plus({ hours: 1 }).toISO()]
    )
    globalThis.fetch = async () => new Response(JSON.stringify({
      appointment: {
        id: ghlAppointmentId,
        contactId: `external_contact_${suffix}`,
        title: 'Título remoto que no debe mandar',
        notes: 'Notas remotas que no deben mandar',
        startTime: start.toISO(),
        endTime: start.plus({ hours: 1 }).toISO(),
        appointmentStatus: 'confirmed',
        status: 'confirmed'
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })

    const response = await invokeController(updateCalendarAppointment, {
      params: { id: appointmentId },
      body: {
        title: 'Título local nuevo',
        notes: 'Notas locales nuevas',
        accessToken: 'test_highlevel_token'
      },
      query: { locationId: `location_${suffix}` }
    })
    assert.equal(response.statusCode, 200, JSON.stringify(response.payload))
    const stored = await db.get(
      'SELECT contact_id, title, notes, sync_status FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(stored.contact_id, contactId)
    assert.equal(stored.title, 'Título local nuevo')
    assert.equal(stored.notes, 'Notas locales nuevas')
    assert.equal(stored.sync_status, 'synced')
  } finally {
    globalThis.fetch = previousFetch
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('una respuesta tardía de HighLevel no marca synced la versión nueva ni devuelve el snapshot viejo', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_update_fence_${suffix}`
  const contactId = `contact_update_fence_${suffix}`
  const appointmentId = `appointment_update_fence_${suffix}`
  const ghlAppointmentId = `ghl_appointment_update_fence_${suffix}`
  const start = DateTime.now().toUTC().plus({ days: 61 }).startOf('hour')
  const previousFetch = globalThis.fetch
  let releaseFirstRemote
  let signalFirstRemoteStarted
  const firstRemoteStarted = new Promise(resolve => { signalFirstRemoteStarted = resolve })
  const firstRemoteRelease = new Promise(resolve => { releaseFirstRemote = resolve })

  try {
    await upsertLocalCalendar({
      id: calendarId,
      ghlCalendarId: `ghl_calendar_update_fence_${suffix}`,
      name: 'Agenda fence de actualización',
      source: 'ghl'
    }, { source: 'ghl', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto fence actualización', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO appointments (
        id, ghl_appointment_id, calendar_id, contact_id, title, status, appointment_status,
        start_time, end_time, source, sync_status, date_added, date_updated
      ) VALUES (?, ?, ?, ?, 'Versión inicial', 'confirmed', 'confirmed', ?, ?, 'ristak', 'synced', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [appointmentId, ghlAppointmentId, calendarId, contactId, start.toISO(), start.plus({ hours: 1 }).toISO()]
    )

    globalThis.fetch = async (_url, options = {}) => {
      const payload = JSON.parse(String(options.body || '{}'))
      if (payload.title === 'Versión A') {
        signalFirstRemoteStarted()
        await firstRemoteRelease
      }
      return new Response(JSON.stringify({
        appointment: {
          id: ghlAppointmentId,
          title: payload.title,
          startTime: start.toISO(),
          endTime: start.plus({ hours: 1 }).toISO(),
          appointmentStatus: 'confirmed'
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    const firstResponsePromise = invokeController(updateCalendarAppointment, {
      params: { id: appointmentId },
      body: { title: 'Versión A', accessToken: 'test_highlevel_token' },
      query: { locationId: `location_${suffix}` }
    })
    await firstRemoteStarted

    const secondResponse = await invokeController(updateCalendarAppointment, {
      params: { id: appointmentId },
      body: { title: 'Versión B', accessToken: 'test_highlevel_token' },
      query: { locationId: `location_${suffix}` }
    })
    assert.equal(secondResponse.statusCode, 200, JSON.stringify(secondResponse.payload))
    assert.equal(secondResponse.payload.data.title, 'Versión B')

    releaseFirstRemote()
    const firstResponse = await firstResponsePromise
    assert.equal(firstResponse.statusCode, 409, JSON.stringify(firstResponse.payload))
    assert.equal(firstResponse.payload.code, 'appointment_provider_response_stale')

    const stored = await db.get(
      'SELECT title, sync_status FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(stored.title, 'Versión B')
    assert.equal(stored.sync_status, 'pending')
  } finally {
    releaseFirstRemote?.()
    globalThis.fetch = previousFetch
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('afterPayment handoff convierte el cierre appointment_booked de la IA en entrega humana durable', async () => {
  const suffix = randomUUID()
  const contactId = `contact_ai_deposit_handoff_${suffix}`
  const paymentId = `payment_ai_deposit_handoff_${suffix}`
  const calendarId = `calendar_ai_deposit_handoff_${suffix}`
  let agent = null
  let resumeCalls = 0
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Cliente anticipo y entrega', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    agent = await createConversationalAgent({
      name: `Agenda IA, anticipo y humano ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      capabilitiesConfig: {
        schemaVersion: 3,
        items: [
          { id: 'schedule_appointment', enabled: true, calendarId, bookingOwner: 'ai' },
          {
            id: 'collect_payment',
            enabled: true,
            chargeType: 'deposit',
            paymentMode: 'deposit',
            collectionMethod: 'payment_link',
            gateway: 'stripe',
            afterPayment: 'handoff',
            deposit: { enabled: true, mode: 'fixed', amount: 300, currency: 'MXN' }
          }
        ]
      }
    })
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
         contact_id, agent_id, channel, status, signal, updated_at
       ) VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP)`,
      [contactId, agent.id]
    )
    const sourceBinding = await createSyntheticAppointmentDepositSourceBinding({
      contactId,
      agentId: agent.id,
      calendarId,
      bookingOwner: 'ai',
      suffix: `after_payment_handoff_${suffix}`
    })
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'payment_link_created',
      detail: {
        agentId: agent.id,
        channel: 'whatsapp',
        ledgerPaymentId: paymentId,
        invoiceId: paymentId,
        amount: 300,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentProvider: 'stripe',
        paymentMode: 'deposit',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        afterPayment: 'handoff',
        ...sourceBinding,
        runtimeMode: 'tool_calling_v2'
      },
      throwOnError: true
    })
    await db.run(
      `INSERT INTO payments (
         id, contact_id, amount, currency, status, payment_method, payment_mode,
         payment_provider, paid_at, created_at, updated_at
       ) VALUES (?, ?, 300, 'MXN', 'paid', 'card', 'live', 'stripe', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    setConversationalPaymentResumeHandlerForTest(async (payload) => {
      resumeCalls += 1
      assert.equal(payload.bookingOwner, 'ai')
      assert.equal(payload.terminalToolName, 'book_appointment')
      await setConversationSignal(contactId, 'appointment_booked', {
        reason: 'Cita agendada por el agente',
        summary: 'Cita real ligada al anticipo',
        status: 'completed',
        agentId: agent.id,
        channel: 'whatsapp',
        eventId: `appointment_booked_before_handoff_${suffix}`,
        strictEvent: true
      })
      return { resumed: true, sent: true }
    })

    const input = {
      contactId,
      paymentId,
      amount: 300,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    }
    const result = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(result.signal, 'ready_for_human')
    assert.equal(result.handoffCompleted, true)
    assert.equal(result.objectiveCompleted, true)
    const state = await db.get(
      `SELECT status, signal, agent_id, channel
       FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      [contactId, agent.id]
    )
    assert.equal(state.status, 'human')
    assert.equal(state.signal, 'ready_for_human')
    assert.equal(state.agent_id, agent.id)
    assert.equal(resumeCalls, 1)
    const reconciliation = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_reconciliation_v2'`,
      [contactId]
    )
    const reconciliationDetail = JSON.parse(reconciliation.detail_json)
    assert.ok(reconciliationDetail.afterPaymentActionCompletedAt)
    assert.equal(reconciliationDetail.afterPaymentActionResult.handoffCompleted, true)
    const replay = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(replay.alreadyCompleted, true)
    assert.equal(resumeCalls, 1)
  } finally {
    setConversationalPaymentResumeHandlerForTest(null)
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('afterPayment handoff de un agente eliminado nunca toca al agente activo que lo reemplazó', async () => {
  const suffix = randomUUID()
  const contactId = `contact_deleted_handoff_isolation_${suffix}`
  const paymentId = `payment_deleted_handoff_isolation_${suffix}`
  let deletedAgent = null
  let currentAgent = null
  let notificationCalls = 0
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Cliente con reemplazo de agente', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    deletedAgent = await createConversationalAgent({
      name: `Agente fuente eliminado ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      capabilitiesConfig: {
        schemaVersion: 3,
        items: [{ id: 'collect_payment', enabled: true, paymentMode: 'full_payment', afterPayment: 'handoff' }]
      }
    })
    const deletedAgentId = deletedAgent.id
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
         contact_id, agent_id, channel, status, signal, updated_at
       ) VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP)`,
      [contactId, deletedAgentId]
    )
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'payment_link_created',
      detail: {
        agentId: deletedAgentId,
        channel: 'whatsapp',
        ledgerPaymentId: paymentId,
        invoiceId: paymentId,
        amount: 990,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentProvider: 'stripe',
        paymentMode: 'full_payment',
        paymentPurpose: 'purchase',
        appointmentDeposit: false,
        afterPayment: 'handoff',
        runtimeMode: 'tool_calling_v2'
      },
      throwOnError: true
    })
    await db.run(
      `INSERT INTO payments (
         id, contact_id, amount, currency, status, payment_mode, payment_provider,
         paid_at, created_at, updated_at
       ) VALUES (?, ?, 990, 'MXN', 'paid', 'live', 'stripe', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    assert.equal(await deleteConversationalAgent(deletedAgentId), true)
    currentAgent = await createConversationalAgent({
      name: `Agente actual protegido ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2'
    })
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
         contact_id, agent_id, channel, status, signal, updated_by, updated_at
       ) VALUES (?, ?, 'whatsapp', 'active', NULL, 'current_agent', CURRENT_TIMESTAMP)`,
      [contactId, currentAgent.id]
    )
    setConversationalPriorityNotificationSenderForTest(async () => {
      notificationCalls += 1
      return { sent: 1 }
    })

    const result = await completeConversationalAgentSalePaymentFromInvoice({
      contactId,
      paymentId,
      amount: 990,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    })
    assert.equal(result.matched, true)
    assert.equal(result.handoffCompleted, false)
    assert.equal(result.statePreserved, true)
    assert.equal(result.signal, 'payment_confirmed_state_preserved')
    const protectedState = await db.get(
      `SELECT status, signal, updated_by FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      [contactId, currentAgent.id]
    )
    assert.equal(protectedState.status, 'active')
    assert.equal(protectedState.signal, null)
    assert.equal(protectedState.updated_by, 'current_agent')
    assert.equal(notificationCalls, 0)
    const reconciliation = JSON.parse((await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_reconciliation_v2'`,
      [contactId]
    )).detail_json)
    assert.equal(Boolean(reconciliation.afterPaymentActionCompletedAt), false)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_after_action_completed'`,
      [contactId]
    )).total), 0)
  } finally {
    setConversationalPriorityNotificationSenderForTest(null)
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    for (const agent of [deletedAgent, currentAgent]) {
      if (!agent?.id) continue
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('afterPayment continuar de un agente eliminado tampoco cierra el chat del agente que lo reemplazó', async () => {
  const suffix = randomUUID()
  const contactId = `contact_deleted_continue_isolation_${suffix}`
  const paymentId = `payment_deleted_continue_isolation_${suffix}`
  let deletedAgent = null
  let currentAgent = null
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Cliente con pago tardío aislado', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    deletedAgent = await createConversationalAgent({
      name: `Agente continue eliminado ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      capabilitiesConfig: {
        schemaVersion: 3,
        items: [{ id: 'collect_payment', enabled: true, paymentMode: 'full_payment', afterPayment: 'continue' }]
      }
    })
    const deletedAgentId = deletedAgent.id
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
         contact_id, agent_id, channel, status, signal, updated_at
       ) VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP)`,
      [contactId, deletedAgentId]
    )
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'payment_link_created',
      detail: {
        agentId: deletedAgentId,
        channel: 'whatsapp',
        ledgerPaymentId: paymentId,
        invoiceId: paymentId,
        amount: 880,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentProvider: 'stripe',
        paymentMode: 'full_payment',
        paymentPurpose: 'purchase',
        appointmentDeposit: false,
        afterPayment: 'continue',
        runtimeMode: 'tool_calling_v2'
      },
      throwOnError: true
    })
    await db.run(
      `INSERT INTO payments (
         id, contact_id, amount, currency, status, payment_mode, payment_provider,
         paid_at, created_at, updated_at
       ) VALUES (?, ?, 880, 'MXN', 'paid', 'live', 'stripe', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    assert.equal(await deleteConversationalAgent(deletedAgentId), true)
    currentAgent = await createConversationalAgent({
      name: `Agente continue actual ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2'
    })
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
         contact_id, agent_id, channel, status, signal, updated_by, updated_at
       ) VALUES (?, ?, 'whatsapp', 'active', NULL, 'current_agent_continue', CURRENT_TIMESTAMP)`,
      [contactId, currentAgent.id]
    )

    const result = await completeConversationalAgentSalePaymentFromInvoice({
      contactId,
      paymentId,
      amount: 880,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    })
    assert.equal(result.matched, true)
    assert.equal(result.signal, 'payment_confirmed_state_preserved')
    assert.equal(result.statePreserved, true)
    const protectedState = await db.get(
      `SELECT status, signal, updated_by FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      [contactId, currentAgent.id]
    )
    assert.equal(protectedState.status, 'active')
    assert.equal(protectedState.signal, null)
    assert.equal(protectedState.updated_by, 'current_agent_continue')
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'signal_set'`,
      [contactId, currentAgent.id]
    )).total), 0)
  } finally {
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    for (const agent of [deletedAgent, currentAgent]) {
      if (!agent?.id) continue
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('afterPayment handoff conserva una pausa y no manda ni registra una entrega falsa', async () => {
  const suffix = randomUUID()
  const contactId = `contact_paused_handoff_${suffix}`
  const paymentId = `payment_paused_handoff_${suffix}`
  let agent = null
  let notificationCalls = 0
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Cliente con pausa protegida', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    agent = await createConversationalAgent({
      name: `Pago con pausa protegida ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      capabilitiesConfig: {
        schemaVersion: 3,
        items: [{ id: 'collect_payment', enabled: true, paymentMode: 'full_payment', afterPayment: 'handoff' }]
      }
    })
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
         contact_id, agent_id, channel, status, signal, updated_by, updated_at
       ) VALUES (?, ?, 'whatsapp', 'paused', NULL, 'staff_pause', CURRENT_TIMESTAMP)`,
      [contactId, agent.id]
    )
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'payment_link_created',
      detail: {
        agentId: agent.id,
        channel: 'whatsapp',
        ledgerPaymentId: paymentId,
        invoiceId: paymentId,
        amount: 410,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentProvider: 'stripe',
        paymentMode: 'full_payment',
        paymentPurpose: 'purchase',
        appointmentDeposit: false,
        afterPayment: 'handoff',
        runtimeMode: 'tool_calling_v2'
      },
      throwOnError: true
    })
    await db.run(
      `INSERT INTO payments (
         id, contact_id, amount, currency, status, payment_mode, payment_provider,
         paid_at, created_at, updated_at
       ) VALUES (?, ?, 410, 'MXN', 'paid', 'live', 'stripe', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    setConversationalPriorityNotificationSenderForTest(async () => {
      notificationCalls += 1
      return { sent: 1 }
    })

    const result = await completeConversationalAgentSalePaymentFromInvoice({
      contactId,
      paymentId,
      amount: 410,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    })
    assert.equal(result.handoffCompleted, false)
    assert.equal(result.statePreserved, true)
    const state = await db.get(
      `SELECT status, signal, updated_by FROM conversational_agent_state
       WHERE contact_id = ? AND agent_id = ? AND channel = 'whatsapp'`,
      [contactId, agent.id]
    )
    assert.equal(state.status, 'paused')
    assert.equal(state.signal, null)
    assert.equal(state.updated_by, 'staff_pause')
    assert.equal(notificationCalls, 0)
    const reconciliation = JSON.parse((await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_reconciliation_v2'`,
      [contactId]
    )).detail_json)
    assert.equal(Boolean(reconciliation.afterPaymentActionCompletedAt), false)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_after_action_completed'`,
      [contactId]
    )).total), 0)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_after_action_preserved'`,
      [contactId]
    )).total), 1)
  } finally {
    setConversationalPriorityNotificationSenderForTest(null)
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})
