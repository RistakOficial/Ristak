import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import { buildInputItems } from '../src/agents/runner.js'
import { buildNativeConversationalInstructions } from '../src/agents/conversational/nativePrompt.js'
import {
  buildNativeFreeSlotDays,
  createConversationalTools,
  loadConversationalAppointmentOfferDecisionContext
} from '../src/agents/conversational/tools.js'
import {
  CONVERSATIONAL_PREVIEW_CONTACT_EMAIL,
  CONVERSATIONAL_PREVIEW_CONTACT_ID,
  CONVERSATIONAL_PREVIEW_CONTACT_NAME,
  TOOL_CALLING_V2_HISTORY_BYTE_BUDGET,
  TOOL_CALLING_V2_MODEL_SETTINGS,
  buildToolCallingV2HistoryEnvelope,
  createToolCallingV2Agent,
  enforceToolCallingV2AppointmentOfferPostcondition,
  estimateToolCallingV2HistoryMessageBytes,
  ensureToolCallingV2VisibleReply,
  guardConversationalAppointmentReplyAgainstState,
  loadToolCallingV2ConversationEnvelope,
  resolveConversationalFollowUpAIProvider,
  resumeToolCallingV2AfterVerifiedPayment,
  runConversationalAgentPreview,
  runToolCallingV2Turn,
  sanitizeToolCallingV2Reply
} from '../src/agents/conversational/runner.js'
import { upsertLocalCalendar } from '../src/services/localCalendarService.js'
import { getAccountTimezone } from '../src/utils/dateUtils.js'

function conversationMessages(count) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `mensaje ${index + 1}`
  }))
}

async function runVerifiedAppointmentPaymentResumeFixture({
  bookingOwner,
  terminalToolName,
  actions,
  assertReconciliationClaim = async () => ({ valid: true }),
  onDelivery = null
}) {
  const suffix = randomUUID()
  const reconciliationId = `resume_${suffix}`
  const contactId = `contact_${suffix}`
  const agentId = `agent_${suffix}`
  const events = []
  const deliveries = []
  const latest = {
    id: `inbound_${suffix}`,
    phone: '+526560000000',
    message_text: 'ok'
  }
  const result = await resumeToolCallingV2AfterVerifiedPayment({
    reconciliationId,
    reconciliationClaimToken: `claim_${suffix}`,
    contactId,
    agentId,
    channel: 'whatsapp',
    amount: 100,
    currency: 'MXN',
    paymentEnvironment: 'test',
    paymentPurpose: 'appointment_deposit',
    bookingOwner,
    terminalToolName
  }, {
    getRuntimeConfig: async () => ({ aiProvider: 'openai', model: 'fake-model' }),
    hasFeature: async () => true,
    getAgent: async () => ({
      id: agentId,
      enabled: true,
      runtimeMode: 'tool_calling_v2',
      aiProvider: 'openai',
      model: 'fake-model',
      capabilitiesConfig: {
        schemaVersion: 3,
        items: [{
          id: 'schedule_appointment',
          enabled: true,
          calendarId: `calendar_${suffix}`,
          bookingOwner
        }]
      }
    }),
    getState: async () => ({ status: 'active', signal: null }),
    getLatestInbound: async () => latest,
    getHistoryEnvelope: async () => ({
      messages: [{ role: 'user', content: 'ok' }],
      telemetry: { totalMessages: 1, includedMessages: 1, omittedMessages: 0 }
    }),
    hydrateMessages: async (messages) => messages,
    resolveRuntime: async () => ({ apiKey: 'stored-test-key-not-real', modelProvider: { kind: 'fake' } }),
    runNativeTurn: async (input) => {
      assert.equal(input.forcedToolName, terminalToolName)
      return {
        reply: 'listo, el paso de agenda quedó terminado',
        ctx: { actions },
        model: 'fake-model',
        runtimeMode: 'tool_calling_v2',
        modelCallCount: 1
      }
    },
    assertReconciliationClaim,
    deliverReply: async (input) => {
      deliveries.push(input)
      onDelivery?.(input)
      return {
        parts: [input.reply],
        sentParts: 1,
        interruptedBy: null,
        inProgress: false
      }
    },
    recordEvent: async (event) => {
      events.push(event)
      return event
    }
  })
  return { result, reconciliationId, events, deliveries }
}

test('si el claim se pierde después de la terminal, el Runner no entrega ni sella respuesta', async () => {
  let deliveryCalls = 0
  await assert.rejects(
    runVerifiedAppointmentPaymentResumeFixture({
      bookingOwner: 'ai',
      terminalToolName: 'book_appointment',
      actions: [{
        type: 'book_appointment',
        outcome: { status: 'ok', ok: true, simulated: false, actionCompleted: true }
      }],
      assertReconciliationClaim: async () => {
        throw Object.assign(new Error('claim reemplazado'), { code: 'payment_reconciliation_claim_lost' })
      },
      onDelivery: () => { deliveryCalls += 1 }
    }),
    (error) => error?.code === 'payment_reconciliation_claim_lost'
  )
  assert.equal(deliveryCalls, 0)
})

test('Agent v2 desactiva tool calls paralelas para serializar mutaciones', () => {
  const agent = createToolCallingV2Agent({
    model: 'gpt-4.1-mini',
    instructions: 'Prueba',
    tools: []
  })

  assert.equal(TOOL_CALLING_V2_MODEL_SETTINGS.parallelToolCalls, false)
  assert.equal(agent.modelSettings.parallelToolCalls, false)
  assert.equal(typeof agent.toolUseBehavior, 'function')
})

test('Agent v2 puede exigir una herramienta terminal exacta sin aceptar nombres que no estén habilitados', () => {
  const bookTool = { type: 'function', name: 'book_appointment' }
  const forcedAgent = createToolCallingV2Agent({
    model: 'gpt-4.1-mini',
    instructions: 'Prueba',
    tools: [bookTool],
    forcedToolName: 'book_appointment'
  })
  assert.equal(forcedAgent.modelSettings.toolChoice, 'book_appointment')

  const adjudicationAgent = createToolCallingV2Agent({
    model: 'gpt-4.1-mini',
    instructions: 'Prueba',
    tools: [{ type: 'function', name: 'resolve_active_appointment_offer' }],
    forcedToolName: 'resolve_active_appointment_offer',
    requireTool: true,
    resetRequiredToolChoice: true
  })
  assert.equal(adjudicationAgent.modelSettings.toolChoice, 'resolve_active_appointment_offer')
  assert.equal(adjudicationAgent.resetToolChoice, true)

  const unavailableAgent = createToolCallingV2Agent({
    model: 'gpt-4.1-mini',
    instructions: 'Prueba',
    tools: [bookTool],
    forcedToolName: 'request_human_booking'
  })
  assert.equal(unavailableAgent.modelSettings.toolChoice, undefined)

  assert.throws(
    () => createToolCallingV2Agent({
      model: 'gpt-4.1-mini',
      instructions: 'Prueba',
      tools: [bookTool],
      forcedToolName: 'request_human_booking',
      requireTool: true
    }),
    (error) => error?.code === 'required_conversational_tool_unavailable'
  )
})

test('seguimiento v2 resuelve proveedor aun cuando una configuración legacy no lo traiga', () => {
  assert.equal(resolveConversationalFollowUpAIProvider({}), 'openai')
  assert.equal(resolveConversationalFollowUpAIProvider({ aiProvider: 'gemini' }), 'gemini')
})

test('una oferta durable fuerza adjudicación semántica primero y preserve deja continuar sin mutarla', async () => {
  const suffix = randomUUID()
  const agentId = `agent_offer_decision_${suffix}`
  const contactId = `contact_offer_decision_${suffix}`
  const previewScopeId = `appointment_preview_${'b'.repeat(48)}`
  const offerEventId = `cae_appointment_preview_offer_${previewScopeId}`
  const offerExecutionId = `test:offer_${suffix}`
  const confirmationExecutionId = `test:confirm_${suffix}`
  const calendarId = `calendar_${suffix}`
  const timezone = await getAccountTimezone()
  const pendingStartTime = '2030-07-15T16:00:00.000Z'
  const pendingLabel = buildNativeFreeSlotDays([{
    timezone,
    slots: [pendingStartTime]
  }], timezone)[0].options[0].localLabel
  const pendingOfferText = `Perfecto, elegiste el ${pendingLabel}${/[.!?]$/u.test(pendingLabel) ? ' ' : '. '}¿Confirmas que sigamos con el anticipo para ese horario?`
  const config = {
    id: agentId,
    runtimeMode: 'tool_calling_v2',
    aiProvider: 'openai',
    model: 'gpt-4.1-mini',
    capabilitiesConfig: {
      items: [
        { id: 'schedule_appointment', enabled: true, calendarId, bookingOwner: 'ai' },
        {
          id: 'collect_payment',
          enabled: true,
          collectionMethod: 'payment_link',
          paymentMode: 'deposit',
          gateway: 'stripe',
          deposit: { enabled: true, mode: 'fixed', amount: 100, currency: 'MXN', methods: { paymentLink: true } }
        },
        { id: 'handoff_human', enabled: true }
      ]
    }
  }

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda oferta pendiente runtime',
      source: 'ristak',
      openHours: []
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, 'appointment_slot_preview_offer_created', ?)`,
      [offerEventId, contactId, agentId, JSON.stringify({
        agentId,
        contactId,
        calendarId,
        startTime: pendingStartTime,
        localLabel: pendingLabel,
        timezone,
        bookingOwner: 'ai',
        terminalToolName: 'book_appointment',
        channel: 'whatsapp',
        executionId: offerExecutionId,
        offerCopyVersion: 2,
        selectionContext: 'selected_from_options',
        depositRequiredAtOffer: true,
        offerText: pendingOfferText,
        purpose: 'book',
        appointmentId: null,
        expectedStartTime: null,
        expectedEndTime: null,
        durationMs: null,
        status: 'active',
        phase: 'awaiting_decision',
        previewScopeId,
        offeredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      })]
    )

    const offerBeforeAdjudication = (await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )).detail_json
    let activeOfferAgent = null
    const result = await runToolCallingV2Turn({
      config,
      runtime: { modelProvider: {} },
      messages: [
        { id: offerExecutionId, role: 'assistant', content: pendingOfferText },
        { id: confirmationExecutionId, role: 'user', content: 'cuánto cuesta la consulta?' }
      ],
      contactId,
      dryRun: true,
      channel: 'whatsapp',
      executionId: confirmationExecutionId,
      previewScopeId,
      conversationModel: 'gpt-4.1-mini'
    }, {
      executeAgent: async ({ agent }) => {
        activeOfferAgent = agent
        const names = agent.tools.map((item) => item.name)
        assert.equal(agent.modelSettings.toolChoice, 'resolve_active_appointment_offer')
        assert.equal(agent.resetToolChoice, true)
        for (const expected of [
          'resolve_active_appointment_offer',
          'get_business_profile',
          'list_products',
          'get_contact_profile',
          'get_contact_appointments',
          'get_free_slots',
          'offer_appointment_slot',
          'cancel_appointment',
          'create_payment_link',
          'send_to_human'
        ]) assert.ok(names.includes(expected), `${expected} debe seguir disponible con una oferta activa`)
        assert.equal(names.includes('book_appointment'), false, 'la aceptación debe entrar por el resolver único')
        assert.equal(names.includes('reschedule_appointment'), false, 'la aceptación debe entrar por el resolver único')
        assert.equal(names.includes('get_conversation_history'), false)
        const preserved = await agent.tools
          .find((item) => item.name === 'resolve_active_appointment_offer')
          .invoke(null, JSON.stringify({
            decision: 'preserve',
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
        assert.equal(preserved.ok, true)
        assert.equal(preserved.terminal, false)
        assert.equal(preserved.appointmentOfferPreserved, true)
        const continuation = await agent.toolUseBehavior(null, [{
          tool: { name: 'resolve_active_appointment_offer' },
          output: preserved
        }])
        assert.equal(continuation.isFinalOutput, false)
        const priceLookup = await agent.tools
          .find((item) => item.name === 'list_products')
          .invoke(null, JSON.stringify({ query: `consulta inexistente ${suffix}` }))
        assert.equal(priceLookup.ok, true)
        const repeatedAdjudication = await agent.tools
          .find((item) => item.name === 'resolve_active_appointment_offer')
          .invoke(null, JSON.stringify({
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
        assert.equal(repeatedAdjudication.ok, false)
        assert.equal(repeatedAdjudication.code, 'appointment_offer_already_adjudicated')
        return 'la consulta no aparece en el catálogo todavía'
      },
      validateAppointmentOfferReplySemantics: async ({ reply, model, modelProvider }) => {
        assert.equal(reply, 'la consulta no aparece en el catálogo todavía')
        assert.equal(model, 'gpt-4.1-mini')
        assert.deepEqual(modelProvider, {})
        return { classification: 'safe_unrelated', modelCallCount: 1, source: 'di_test' }
      },
      runInChannel: (_channel, callback) => callback()
    })
    assert.equal(result.appointmentOfferDecision?.offerEventId, offerEventId)
    assert.equal(result.reply, 'la consulta no aparece en el catálogo todavía')
    assert.equal(result.appointmentOfferPostcondition.adjudicationDecision, 'preserve')
    assert.equal(result.appointmentOfferPostcondition.prevented, false)
    assert.equal(result.appointmentOfferPostcondition.semanticClassification, 'safe_unrelated')
    assert.equal(result.appointmentOfferPostcondition.semanticValidation.source, 'di_test')
    assert.equal(result.modelCallCount, 2)
    assert.equal(result.ctx.appointmentOfferAdjudication?.decision, 'preserve')
    assert.equal(result.ctx.actions.filter((action) => (
      ['book_appointment', 'request_human_booking', 'reschedule_appointment'].includes(action.type)
    )).length, 0)
    assert.equal((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )).detail_json, offerBeforeAdjudication)

    const ambiguousExecutionId = `test:ambiguous_${suffix}`
    const ambiguousResult = await runToolCallingV2Turn({
      config,
      runtime: { modelProvider: {} },
      messages: [
        { id: offerExecutionId, role: 'assistant', content: pendingOfferText },
        { id: ambiguousExecutionId, role: 'user', content: 'mmm, no sé' }
      ],
      contactId,
      dryRun: true,
      channel: 'whatsapp',
      executionId: ambiguousExecutionId,
      previewScopeId,
      conversationModel: 'gpt-4.1-mini'
    }, {
      executeAgent: async ({ agent }) => {
        assert.equal(agent.modelSettings.toolChoice, 'resolve_active_appointment_offer')
        const preserved = await agent.tools
          .find((item) => item.name === 'resolve_active_appointment_offer')
          .invoke(null, JSON.stringify({
            decision: 'preserve',
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
        assert.equal(preserved.appointmentOfferPreserved, true)
        return 'sin problema, tómate tu tiempo'
      },
      validateAppointmentOfferReplySemantics: async () => ({
        classification: 'safe_unrelated',
        modelCallCount: 1,
        source: 'di_test'
      }),
      runInChannel: (_channel, callback) => callback()
    })
    assert.equal(ambiguousResult.reply, 'sin problema, tómate tu tiempo')
    assert.equal(ambiguousResult.appointmentOfferPostcondition.adjudicationDecision, 'preserve')
    assert.equal(ambiguousResult.ctx.actions.filter((action) => (
      ['book_appointment', 'request_human_booking', 'reschedule_appointment'].includes(action.type)
    )).length, 0)
    assert.equal((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )).detail_json, offerBeforeAdjudication)

    const decisionCtx = {
      config,
      capabilitiesConfig: config.capabilitiesConfig,
      runtimeMode: 'tool_calling_v2',
      contactId,
      agentId,
      channel: 'whatsapp',
      dryRun: true,
      previewScopeId,
      executionId: confirmationExecutionId,
      appointmentOfferDecision: result.appointmentOfferDecision,
      accountLocale: { currency: 'MXN' },
      conversationMessages: [
        { id: offerExecutionId, role: 'assistant', content: pendingOfferText },
        { id: confirmationExecutionId, role: 'user', content: 'cuánto cuesta la consulta?' }
      ],
      actions: []
    }
    const decisionTools = createConversationalTools(decisionCtx)
    const offerBeforePriceQuestion = (await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )).detail_json
    const priceLookup = await decisionTools
      .find((item) => item.name === 'list_products')
      .invoke(null, JSON.stringify({ query: `consulta inexistente ${suffix}` }))
    assert.equal(priceLookup.ok, true)
    assert.equal((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )).detail_json, offerBeforePriceQuestion)

    const offerResolver = decisionTools
      .find((item) => item.name === 'resolve_active_appointment_offer')
    const missingScope = await offerResolver
      .invoke(null, JSON.stringify({
        decision: 'request_other_options',
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
    assert.equal(missingScope.ok, false)
    assert.equal(missingScope.code, 'appointment_next_preference_scope_required')
    assert.equal(missingScope.terminal, false)
    assert.equal(missingScope.visibleReply, null)
    assert.match(missingScope.continueWith, /same_date|mismo turno/i)
    assert.equal(decisionCtx.appointmentOfferAdjudication, undefined)
    assert.equal((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )).detail_json, offerBeforePriceQuestion)

    const otherOptions = await offerResolver
      .invoke(null, JSON.stringify({
        decision: 'request_other_options',
        nextPreferenceScope: 'same_date',
        reply: null,
        title: null,
        notes: null,
        attendeeName: null,
        attendeeContext: null,
        primaryAttendee: null,
        guests: [],
        agreedAmount: null
      }))
    assert.equal(otherOptions.ok, true)
    assert.equal(otherOptions.terminal, false)
    assert.equal(otherOptions.visibleReply, null)
    assert.match(otherOptions.continueWith, /conserva la fecha|consulta otra vez la hora/i)
    const continuation = await activeOfferAgent.toolUseBehavior(null, [{
      tool: { name: 'resolve_active_appointment_offer' },
      output: otherOptions
    }])
    assert.equal(continuation.isFinalOutput, false)
    assert.equal(JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )).detail_json).status, 'superseded')

    const supersededRow = await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )
    const restoredOffer = JSON.parse(supersededRow.detail_json)
    restoredOffer.status = 'active'
    restoredOffer.phase = 'awaiting_decision'
    delete restoredOffer.resolvedAt
    delete restoredOffer.resolvedExecutionId
    delete restoredOffer.resolution
    const restoredProgress = JSON.parse((await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_selection_progress'`,
      [contactId, agentId]
    )).detail_json)
    restoredOffer.offeredAt = new Date(
      Math.max(Date.now(), Date.parse(restoredProgress.updatedAt || '') + 1)
    ).toISOString()
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?',
      [JSON.stringify(restoredOffer), offerEventId]
    )
    decisionCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: decisionCtx,
      config
    })
    delete decisionCtx.appointmentOfferAdjudication
    const handoffTools = createConversationalTools(decisionCtx)
    const handedOff = await handoffTools
      .find((item) => item.name === 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify({
        decision: 'handoff',
        reply: 'quiero hablar con una persona',
        title: null,
        notes: null,
        attendeeName: null,
        attendeeContext: null,
        primaryAttendee: null,
        guests: [],
        agreedAmount: null
      }))
    assert.equal(handedOff.ok, true, JSON.stringify(handedOff))
    assert.equal(JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )).detail_json).status, 'handed_off')
    const staleAcceptance = await handoffTools
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
    assert.equal(staleAcceptance.ok, false)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE id = ?', [offerEventId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('la postcondición no entrega prosa de cita creada sin adjudicación y terminal exitosas', async () => {
  const offerDecision = {
    active: true,
    offerEventId: 'offer_postcondition',
    purpose: 'book',
    terminalToolName: 'book_appointment'
  }
  const runFixture = async ({ adjudication = null } = {}) => {
    const ctx = {
      actions: [],
      appointmentOfferDecision: offerDecision,
      ...(adjudication ? { appointmentOfferAdjudication: adjudication } : {})
    }
    return runToolCallingV2Turn({
      config: { id: 'agent_postcondition' },
      runtime: { modelProvider: {} },
      messages: [{ id: 'message_postcondition', role: 'user', content: 'sí' }],
      executionId: 'message_postcondition',
      conversationModel: 'gpt-4.1-mini'
    }, {
      buildAgentForRun: async () => ({
        agent: {},
        ctx,
        model: 'gpt-4.1-mini',
        aiProvider: 'openai',
        appointmentOfferDecision: offerDecision
      }),
      executeAgent: async () => 'listo, la cita quedó creada',
      runInChannel: (_channel, callback) => callback()
    })
  }

  const withoutResolver = await runFixture()
  assert.notEqual(withoutResolver.reply, 'listo, la cita quedó creada')
  assert.equal(withoutResolver.appointmentOfferPostcondition.reason, 'appointment_offer_adjudication_missing')
  assert.equal(withoutResolver.appointmentOfferPostcondition.terminalActionSucceeded, false)

  const acceptedWithoutTerminal = await runFixture({
    adjudication: {
      completed: true,
      source: 'resolver_tool',
      decision: 'accept',
      offerEventId: offerDecision.offerEventId
    }
  })
  assert.notEqual(acceptedWithoutTerminal.reply, 'listo, la cita quedó creada')
  assert.equal(acceptedWithoutTerminal.appointmentOfferPostcondition.reason, 'appointment_offer_terminal_success_missing')
  assert.equal(acceptedWithoutTerminal.appointmentOfferPostcondition.terminalActionSucceeded, false)
})

test('la postcondición canonicaliza decisiones no-accept y sólo deja preserve lateral validado', () => {
  const offerDecision = {
    active: true,
    offerEventId: 'offer_all_decisions',
    purpose: 'book',
    terminalToolName: 'book_appointment',
    localLabel: 'mañana a las 4:00 p. m.'
  }
  const falseConfirmation = 'listo, tu cita quedó confirmada'
  const adjudication = (decision, extra = {}) => ({
    completed: true,
    source: 'resolver_tool',
    decision,
    offerEventId: offerDecision.offerEventId,
    ...extra
  })
  const enforce = ({ decision, marker = {}, semanticReplyValidation = null, reply = falseConfirmation }) => {
    const ctx = {
      actions: [],
      appointmentOfferDecision: offerDecision,
      appointmentOfferAdjudication: adjudication(decision, marker)
    }
    return {
      ctx,
      result: enforceToolCallingV2AppointmentOfferPostcondition({
        reply,
        ctx,
        initialOfferDecision: offerDecision,
        semanticReplyValidation
      })
    }
  }

  const preserveWithoutValidation = enforce({ decision: 'preserve' }).result
  assert.notEqual(preserveWithoutValidation.reply, falseConfirmation)
  assert.equal(preserveWithoutValidation.reason, 'appointment_offer_preserve_reply_unverified')

  const preserveOutcomeClaim = enforce({
    decision: 'preserve',
    semanticReplyValidation: { classification: 'appointment_outcome_claim' }
  }).result
  assert.notEqual(preserveOutcomeClaim.reply, falseConfirmation)
  assert.equal(preserveOutcomeClaim.reason, 'appointment_offer_preserve_outcome_claim_blocked')

  const repeatedPrompt = enforce({
    decision: 'preserve',
    reply: '¿Qué fecha y hora quieres para tu cita?',
    semanticReplyValidation: { classification: 'appointment_decision_prompt' }
  })
  assert.equal(repeatedPrompt.result.reason, 'appointment_offer_preserve_decision_prompt_blocked')
  const guardedFallback = guardConversationalAppointmentReplyAgainstState({
    reply: repeatedPrompt.result.reply,
    ctx: repeatedPrompt.ctx
  })
  assert.equal(guardedFallback.prevented, false)
  assert.equal(guardedFallback.reply, repeatedPrompt.result.reply)

  const safeLateralReply = 'la consulta cuesta 500 pesos e incluye la valoración inicial'
  const safePreserve = enforce({
    decision: 'preserve',
    reply: safeLateralReply,
    semanticReplyValidation: { classification: 'safe_unrelated' }
  }).result
  assert.equal(safePreserve.reply, safeLateralReply)
  assert.equal(safePreserve.prevented, false)

  const decline = enforce({
    decision: 'decline',
    marker: { output: { ok: true, actionCompleted: true, visibleReply: 'claro, no confirmé ese horario' } }
  }).result
  assert.equal(decline.reply, 'claro, no confirmé ese horario')
  assert.equal(decline.reason, 'appointment_offer_decline_reply_canonicalized')

  const change = enforce({
    decision: 'request_other_options',
    marker: { nextPreferenceScope: 'same_date', output: { ok: true, actionCompleted: true, visibleReply: null } }
  }).result
  assert.notEqual(change.reply, falseConfirmation)
  assert.match(change.reply, /conservé el día/i)
  assert.equal(change.reason, 'appointment_offer_change_reply_canonicalized')

  const handoff = enforce({
    decision: 'handoff',
    marker: { output: { ok: true, actionCompleted: true, visibleReply: 'el equipo continuará contigo' } }
  }).result
  assert.equal(handoff.reply, 'el equipo continuará contigo')
  assert.equal(handoff.reason, 'appointment_offer_handoff_reply_canonicalized')
})

test('la compuerta semántica corre sólo para preserve y falla cerrada si el classifier truena', async () => {
  const runFixture = async ({ decision, classifier }) => {
    const offerDecision = {
      active: true,
      offerEventId: `offer_classifier_${decision}`,
      purpose: 'book',
      terminalToolName: 'book_appointment'
    }
    const ctx = {
      actions: [],
      appointmentOfferDecision: offerDecision,
      appointmentOfferAdjudication: {
        completed: true,
        source: 'resolver_tool',
        decision,
        nextPreferenceScope: decision === 'request_other_options' ? 'same_date' : null,
        offerEventId: offerDecision.offerEventId,
        output: decision === 'decline'
          ? { ok: true, actionCompleted: true, visibleReply: 'claro, no confirmé ese horario' }
          : (decision === 'handoff'
              ? { ok: true, actionCompleted: true, visibleReply: 'el equipo continuará contigo' }
              : { ok: true, actionCompleted: true, visibleReply: null })
      }
    }
    return runToolCallingV2Turn({
      config: { id: `agent_classifier_${decision}` },
      runtime: { modelProvider: { provider: 'same-provider' } },
      messages: [{ id: `message_classifier_${decision}`, role: 'user', content: 'mensaje' }],
      executionId: `message_classifier_${decision}`,
      conversationModel: 'gpt-4.1-mini'
    }, {
      buildAgentForRun: async () => ({
        agent: {},
        ctx,
        model: 'gpt-4.1-mini',
        aiProvider: 'openai',
        appointmentOfferDecision: offerDecision
      }),
      executeAgent: async () => 'listo, tu cita quedó confirmada',
      validateAppointmentOfferReplySemantics: classifier,
      runInChannel: (_channel, callback) => callback()
    })
  }

  let mutativeClassifierCalls = 0
  for (const decision of ['accept', 'decline', 'request_other_options', 'handoff']) {
    const result = await runFixture({
      decision,
      classifier: async () => {
        mutativeClassifierCalls += 1
        return { classification: 'safe_unrelated', modelCallCount: 1, source: 'should_not_run' }
      }
    })
    assert.notEqual(result.reply, 'listo, tu cita quedó confirmada')
    assert.equal(result.appointmentOfferPostcondition.semanticValidation, null)
  }
  assert.equal(mutativeClassifierCalls, 0)

  let preserveClassifierCalls = 0
  const failedClassifier = await runFixture({
    decision: 'preserve',
    classifier: async ({ reply, model, modelProvider }) => {
      preserveClassifierCalls += 1
      assert.equal(reply, 'listo, tu cita quedó confirmada')
      assert.equal(model, 'gpt-4.1-mini')
      assert.deepEqual(modelProvider, { provider: 'same-provider' })
      throw new Error('classifier timeout')
    }
  })
  assert.equal(preserveClassifierCalls, 1)
  assert.notEqual(failedClassifier.reply, 'listo, tu cita quedó confirmada')
  assert.equal(failedClassifier.appointmentOfferPostcondition.reason, 'appointment_offer_preserve_reply_unverified')
  assert.equal(failedClassifier.appointmentOfferPostcondition.semanticClassification, 'unavailable')
})

test('DI semántica adjudica sí, jalo, de una y me sirve como accept con una sola terminal', async () => {
  for (const phrase of ['sí', 'jalo', 'de una', 'me sirve']) {
    const offerDecision = {
      active: true,
      offerEventId: `offer_accept_${phrase}`,
      purpose: 'book',
      terminalToolName: 'book_appointment'
    }
    const ctx = { actions: [], appointmentOfferDecision: offerDecision }
    const result = await runToolCallingV2Turn({
      config: { id: `agent_accept_${phrase}` },
      runtime: { modelProvider: {} },
      messages: [{ id: `message_accept_${phrase}`, role: 'user', content: phrase }],
      executionId: `message_accept_${phrase}`,
      dryRun: true,
      conversationModel: 'gpt-4.1-mini'
    }, {
      buildAgentForRun: async () => ({
        agent: {},
        ctx,
        model: 'gpt-4.1-mini',
        aiProvider: 'openai',
        appointmentOfferDecision: offerDecision
      }),
      executeAgent: async ({ messages }) => {
        assert.equal(messages.at(-1)?.content, phrase)
        ctx.appointmentOfferAdjudication = {
          completed: true,
          source: 'resolver_tool',
          decision: 'accept',
          offerEventId: offerDecision.offerEventId
        }
        ctx.actions.push({
          type: 'book_appointment',
          outcome: {
            status: 'simulated',
            ok: true,
            simulated: true,
            actionCompleted: false,
            wouldMarkObjectiveCompleted: true
          }
        })
        return 'respuesta libre que no debe gobernar la confirmación'
      },
      runInChannel: (_channel, callback) => callback()
    })
    assert.equal(result.ctx.appointmentOfferAdjudication.decision, 'accept')
    assert.equal(result.ctx.actions.filter((action) => action.type === 'book_appointment').length, 1)
    assert.equal(result.reply, 'listo, la cita de prueba quedó confirmada')
    assert.equal(result.appointmentOfferPostcondition.terminalActionSucceeded, true)
  }
})

test('oferta de reagenda humana pendiente conserva request_human_booking como única terminal', async () => {
  const suffix = randomUUID()
  const agentId = `agent_human_pending_${suffix}`
  const contactId = `contact_human_pending_${suffix}`
  const scopeToken = randomUUID().replaceAll('-', '').padEnd(48, 'a').slice(0, 48)
  const previewScopeId = `appointment_preview_${scopeToken}`
  const offerEventId = `cae_appointment_preview_offer_${previewScopeId}`
  const offerExecutionId = `test:human_offer_${suffix}`
  const confirmationExecutionId = `test:human_confirm_${suffix}`
  const calendarId = `calendar_${suffix}`
  const timezone = await getAccountTimezone()
  const pendingStartTime = '2030-07-16T19:00:00.000Z'
  const pendingLabel = buildNativeFreeSlotDays([{
    timezone,
    slots: [pendingStartTime]
  }], timezone)[0].options[0].localLabel
  const pendingOfferText = `Tengo disponible ${pendingLabel}${/[.!?]$/u.test(pendingLabel) ? ' ' : '. '}¿Te funciona ese horario?`
  const config = {
    id: agentId,
    runtimeMode: 'tool_calling_v2',
    aiProvider: 'openai',
    model: 'gpt-4.1-mini',
    capabilitiesConfig: {
      items: [{
        id: 'schedule_appointment',
        enabled: true,
        calendarId,
        bookingOwner: 'human'
      }]
    }
  }

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda humana pendiente runtime',
      source: 'ristak',
      allowReschedule: true,
      openHours: []
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, 'appointment_slot_preview_offer_created', ?)`,
      [offerEventId, contactId, agentId, JSON.stringify({
        agentId,
        contactId,
        calendarId,
        startTime: pendingStartTime,
        localLabel: pendingLabel,
        timezone,
        bookingOwner: 'human',
        terminalToolName: 'request_human_booking',
        channel: 'whatsapp',
        executionId: offerExecutionId,
        offerText: pendingOfferText,
        purpose: 'reschedule',
        appointmentId: `appointment_${suffix}`,
        expectedStartTime: '2030-07-15T16:00:00.000Z',
        expectedEndTime: '2030-07-15T17:00:00.000Z',
        durationMs: 60 * 60 * 1000,
        status: 'active',
        phase: 'awaiting_decision',
        previewScopeId,
        offeredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      })]
    )

    const result = await runToolCallingV2Turn({
      config,
      runtime: { modelProvider: {} },
      messages: [
        { id: offerExecutionId, role: 'assistant', content: pendingOfferText },
        { id: confirmationExecutionId, role: 'user', content: 'sí, cámbiamela a ese horario' }
      ],
      contactId,
      dryRun: true,
      channel: 'whatsapp',
      executionId: confirmationExecutionId,
      previewScopeId,
      conversationModel: 'gpt-4.1-mini'
    }, {
      executeAgent: async ({ agent }) => {
        const names = agent.tools.map((item) => item.name)
        assert.ok(names.includes('resolve_active_appointment_offer'))
        assert.equal(names.includes('request_human_booking'), false)
        assert.equal(names.includes('reschedule_appointment'), false)
        assert.match(agent.instructions, /única terminal válida es request_human_booking/i)
        assert.match(agent.instructions, /sin modificar el calendario/i)
        assert.match(agent.instructions, /no prepara un anticipo nuevo/i)
        assert.doesNotMatch(agent.instructions, /única mutación válida es reschedule_appointment/i)
        return 'respuesta de prueba'
      },
      runInChannel: (_channel, callback) => callback()
    })

    assert.equal(result.appointmentOfferDecision?.purpose, 'reschedule')
    assert.equal(result.appointmentOfferDecision?.terminalToolName, 'request_human_booking')
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE id = ?', [offerEventId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('dos ofertas live vigentes fallan cerrado antes de volver a exponer agenda', async () => {
  const suffix = randomUUID()
  const agentId = `agent_ambiguous_offer_${suffix}`
  const contactId = `contact_ambiguous_offer_${suffix}`
  const calendarId = `calendar_ambiguous_offer_${suffix}`
  const eventIds = [`offer_ambiguous_a_${suffix}`, `offer_ambiguous_b_${suffix}`]
  const config = {
    id: agentId,
    capabilitiesConfig: {
      items: [{ id: 'schedule_appointment', enabled: true, calendarId, bookingOwner: 'ai' }]
    }
  }
  try {
    for (const [index, eventId] of eventIds.entries()) {
      await db.run(
        `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
         VALUES (?, ?, ?, 'appointment_slot_offer_created', ?)`,
        [eventId, contactId, agentId, JSON.stringify({
          agentId,
          contactId,
          calendarId,
          startTime: `2030-07-${15 + index}T16:00:00.000Z`,
          localLabel: `horario ${index + 1}`,
          timezone: 'America/Mexico_City',
          channel: 'whatsapp',
          executionId: `old_execution_${index}_${suffix}`,
          offerText: `Oferta ${index + 1}`,
          status: 'active',
          phase: 'awaiting_decision',
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
        })]
      )
    }
    await assert.rejects(
      loadConversationalAppointmentOfferDecisionContext({
        ctx: {
          config,
          capabilitiesConfig: config.capabilitiesConfig,
          contactId,
          agentId,
          channel: 'whatsapp',
          dryRun: false,
          executionId: `current_execution_${suffix}`
        },
        config
      }),
      (error) => error?.code === 'appointment_offer_state_ambiguous'
    )
    await db.run('DELETE FROM conversational_agent_events WHERE id = ?', [eventIds[1]])
    const resolvingRow = await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [eventIds[0]]
    )
    const resolvingDetail = JSON.parse(resolvingRow.detail_json)
    resolvingDetail.status = 'resolving_handoff'
    resolvingDetail.phase = 'resolving'
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?',
      [JSON.stringify(resolvingDetail), eventIds[0]]
    )
    await assert.rejects(
      loadConversationalAppointmentOfferDecisionContext({
        ctx: {
          config,
          capabilitiesConfig: config.capabilitiesConfig,
          contactId,
          agentId,
          channel: 'whatsapp',
          dryRun: false,
          executionId: `next_execution_${suffix}`
        },
        config
      }),
      (error) => error?.code === 'appointment_offer_resolution_in_progress'
    )
  } finally {
    for (const eventId of eventIds) {
      await db.run('DELETE FROM conversational_agent_events WHERE id = ?', [eventId]).catch(() => {})
    }
  }
})

test('un anticipo sandbox verificado exige la terminal humana cuando bookingOwner es human', async () => {
  let calls = 0
  const result = await runToolCallingV2Turn({
    config: {
      id: 'agent_human_payment_resume',
      capabilitiesConfig: {
        schemaVersion: 3,
        items: [{
          id: 'schedule_appointment',
          enabled: true,
          calendarId: 'calendar_human_payment_resume',
          bookingOwner: 'human'
        }]
      }
    },
    runtime: { modelProvider: {} },
    messages: [{ role: 'user', content: 'ok' }],
    contactId: 'contact_human_payment_resume',
    dryRun: true,
    channel: 'whatsapp',
    executionId: 'preview_execution_human_payment_resume',
    previewScopeId: 'cap_preview_human_payment_resume',
    testVerifiedPaymentEvidence: {
      paymentMode: 'test',
      paymentPurpose: 'appointment_deposit',
      testRunId: 'test_run_human_payment_resume',
      testEffectId: 'test_effect_human_payment_resume',
      previewScopeId: 'cap_preview_human_payment_resume',
      appointmentOfferEventId: 'offer_human_payment_resume',
      appointmentOfferFingerprint: 'fingerprint_human_payment_resume',
      calendarId: 'calendar_human_payment_resume',
      startTime: '2026-08-10T16:00:00.000Z',
      bookingOwner: 'human',
      terminalToolName: 'request_human_booking'
    },
    conversationModel: 'gpt-4.1-mini'
  }, {
    executeAgent: async ({ agent }) => {
      calls += 1
      assert.equal(agent.modelSettings.toolChoice, 'request_human_booking')
      assert.ok(agent.tools.some((item) => item.name === 'request_human_booking'))
      assert.ok(!agent.tools.some((item) => item.name === 'book_appointment'))
      return 'el equipo continuará con la solicitud'
    },
    runInChannel: (_channel, callback) => callback()
  })
  assert.equal(calls, 1)
  assert.equal(result.forcedToolName, 'request_human_booking')
})

for (const variant of [
  { bookingOwner: 'ai', terminalToolName: 'book_appointment' },
  { bookingOwner: 'human', terminalToolName: 'request_human_booking' }
]) {
  test(`reanudación de pago bloquea entrega si ${variant.terminalToolName} falta o falla`, async () => {
    for (const actions of [
      [],
      [{
        type: variant.terminalToolName,
        outcome: {
          status: 'error',
          ok: false,
          simulated: false,
          actionCompleted: false,
          error: 'fallo terminal reproducible'
        }
      }]
    ]) {
      const execution = await runVerifiedAppointmentPaymentResumeFixture({
        ...variant,
        actions
      })
      assert.deepEqual(execution.result, {
        resumed: false,
        manualReviewRequired: true,
        reason: 'payment_resume_terminal_failed'
      })
      assert.equal(execution.deliveries.length, 0)
      assert.equal(
        execution.events.some((event) => event.eventId === `${execution.reconciliationId}_reply`),
        false
      )
    }
  })

  test(`reanudación de pago sólo entrega tras ${variant.terminalToolName} live exitoso`, async () => {
    const execution = await runVerifiedAppointmentPaymentResumeFixture({
      ...variant,
      actions: [{
        type: variant.terminalToolName,
        outcome: {
          status: 'ok',
          ok: true,
          simulated: false,
          actionCompleted: true
        }
      }]
    })
    assert.equal(execution.result.resumed, true)
    assert.equal(execution.result.sent, true)
    assert.equal(execution.deliveries.length, 1)
    assert.equal(
      execution.events.some((event) => event.eventId === `${execution.reconciliationId}_reply`),
      true
    )
  })
}

test('una mutación confirmada y una oferta estructurada de preview cierran la vuelta', async () => {
  const liveAgent = createToolCallingV2Agent({
    model: 'gpt-4.1-mini',
    instructions: 'Prueba',
    tools: [],
    dryRun: false
  })
  const committed = await liveAgent.toolUseBehavior(null, [{
    tool: { name: 'book_appointment' },
    output: { ok: true, actionCompleted: true }
  }])
  assert.equal(committed.isFinalOutput, true)
  assert.equal(committed.finalOutput, '')

  const rejected = await liveAgent.toolUseBehavior(null, [{
    tool: { name: 'book_appointment' },
    output: { ok: false, actionCompleted: false }
  }])
  assert.equal(rejected.isFinalOutput, false)

  const previewAgent = createToolCallingV2Agent({
    model: 'gpt-4.1-mini',
    instructions: 'Prueba',
    tools: [],
    dryRun: true
  })
  assert.equal(typeof previewAgent.toolUseBehavior, 'function')
  const previewOffer = await previewAgent.toolUseBehavior(null, [{
    tool: { name: 'offer_appointment_slot' },
    output: {
      ok: true,
      simulated: true,
      actionCompleted: false,
      terminal: true,
      visibleReply: 'Tengo disponible el martes a las 4:00 p. m. ¿Te funciona ese horario?'
    }
  }])
  assert.equal(previewOffer.isFinalOutput, true)
  assert.equal(previewOffer.finalOutput, 'Tengo disponible el martes a las 4:00 p. m. ¿Te funciona ese horario?')
  const previewRead = await previewAgent.toolUseBehavior(null, [{
    tool: { name: 'get_free_slots' },
    output: { ok: true, simulated: true, actionCompleted: false }
  }])
  assert.equal(previewRead.isFinalOutput, false)
  const previewBooking = await previewAgent.toolUseBehavior(null, [{
    tool: { name: 'book_appointment' },
    output: {
      ok: true,
      simulated: true,
      actionCompleted: false,
      wouldMarkObjectiveCompleted: true
    }
  }])
  assert.equal(previewBooking.isFinalOutput, true)
  assert.equal(previewBooking.finalOutput, '')
})

test('v2 sólo expone mutaciones de capacidades activadas y nunca tools de silencio o descarte', () => {
  const capabilitiesConfig = {
    schemaVersion: 1,
    items: [{ id: 'schedule_appointment', enabled: true, calendarId: 'calendar-real' }]
  }
  const names = createConversationalTools({
    config: { runtimeMode: 'tool_calling_v2', capabilitiesConfig },
    runtimeMode: 'tool_calling_v2',
    capabilitiesConfig,
    followUpMode: false,
    accountLocale: { currency: 'MXN' },
    actions: []
  }).map((candidate) => candidate.name)

  assert.ok(names.includes('get_free_slots'))
  assert.ok(names.includes('offer_appointment_slot'))
  assert.ok(names.includes('book_appointment'))
  for (const forbidden of [
    'create_payment_link',
    'send_trigger_link',
    'send_goal_url',
    'send_to_human',
    'mark_ready_to_advance',
    'save_contact_data',
    'stay_silent',
    'discard_conversation',
    'update_closing_context'
  ]) {
    assert.equal(names.includes(forbidden), false, `no debe exponer ${forbidden}`)
  }
})

test('una capacidad activada con configuración incompleta no se presenta como disponible ni expone tools', () => {
  const capabilitiesConfig = {
    schemaVersion: 3,
    items: [{ id: 'schedule_appointment', enabled: true, calendarId: '' }]
  }
  const capabilityManifest = [{
    id: 'schedule_appointment',
    label: 'Agendar cita',
    enabled: true,
    ready: false,
    missingConfiguration: ['Selecciona un calendario.']
  }]
  const instructions = buildNativeConversationalInstructions({
    capabilitiesConfig,
    capabilityManifest
  })
  const names = createConversationalTools({
    config: { runtimeMode: 'tool_calling_v2', capabilitiesConfig },
    runtimeMode: 'tool_calling_v2',
    capabilitiesConfig,
    followUpMode: false,
    actions: []
  }).map((candidate) => candidate.name)

  assert.match(instructions, /activada, pero todavía NO está disponible/i)
  assert.match(instructions, /configuración está incompleta/i)
  assert.match(instructions, /No existe una herramienta operativa para esta capacidad/i)
  assert.doesNotMatch(instructions, /Agendar cita: Esta capacidad está disponible/i)
  assert.equal(names.includes('get_free_slots'), false)
  assert.equal(names.includes('offer_appointment_slot'), false)
  assert.equal(names.includes('book_appointment'), false)
})

test('cobro expone una sola tool según Link de pago o Transferencia/Depósito', () => {
  const toolNamesFor = (collectionMethod, { afterPayment = 'continue', withGeneralHandoff = false } = {}) => {
    const capabilitiesConfig = {
      items: [
        {
          id: 'collect_payment',
          enabled: true,
          collectionMethod,
          chargeType: 'direct',
          afterPayment,
          direct: { amount: 1200, currency: 'MXN', concept: 'Consulta' },
          ...(collectionMethod === 'bank_transfer'
            ? { bankTransfer: { details: 'Banco de prueba · cuenta 1234' } }
            : {})
        },
        ...(withGeneralHandoff ? [{ id: 'handoff_human', enabled: true }] : [])
      ]
    }
    return createConversationalTools({
      config: { runtimeMode: 'tool_calling_v2', capabilitiesConfig },
      runtimeMode: 'tool_calling_v2',
      capabilitiesConfig,
      followUpMode: false,
      accountLocale: { currency: 'MXN' },
      actions: []
    }).map((candidate) => candidate.name)
  }

  const linkTools = toolNamesFor('payment_link')
  assert.equal(linkTools.includes('create_payment_link'), true)
  assert.equal(linkTools.includes('register_deposit_payment_proof'), false)
  assert.equal(toolNamesFor('payment_link', { afterPayment: 'handoff' }).includes('send_to_human'), false)
  assert.equal(toolNamesFor('payment_link', { afterPayment: 'handoff', withGeneralHandoff: true }).includes('send_to_human'), true)

  const transferTools = toolNamesFor('bank_transfer')
  assert.equal(transferTools.includes('create_payment_link'), false)
  assert.equal(transferTools.includes('register_deposit_payment_proof'), true)
})

test('bookingOwner human reemplaza agendar por la solicitud humana estructurada', () => {
  const capabilitiesConfig = {
    schemaVersion: 1,
    items: [{
      id: 'schedule_appointment',
      enabled: true,
      calendarId: 'calendar-real',
      bookingOwner: 'human',
      handoffUserId: '7',
      handoffUserName: 'Mariana'
    }]
  }
  const tools = createConversationalTools({
    config: { runtimeMode: 'tool_calling_v2', capabilitiesConfig },
    runtimeMode: 'tool_calling_v2',
    capabilitiesConfig,
    followUpMode: false,
    dryRun: true,
    virtualContact: { fullName: CONVERSATIONAL_PREVIEW_CONTACT_NAME },
    accountLocale: { currency: 'MXN' },
    actions: []
  })
  const names = tools.map((candidate) => candidate.name)

  assert.ok(names.includes('get_free_slots'))
  assert.ok(names.includes('request_human_booking'))
  assert.equal(names.includes('book_appointment'), false)
  assert.equal(names.includes('reschedule_appointment'), false)
  const request = tools.find((candidate) => candidate.name === 'request_human_booking')
  assert.deepEqual(
    Object.keys(request.parameters.properties).sort(),
    ['attendeeContext', 'attendeeName', 'guests', 'notes', 'primaryAttendee', 'title']
  )
})

test('seguimiento v2 conserva sólo herramientas de lectura', () => {
  const capabilitiesConfig = {
    schemaVersion: 1,
    items: [
      { id: 'schedule_appointment', enabled: true, calendarId: 'calendar-real' },
      { id: 'collect_payment', enabled: true, productId: 'product-real', priceId: 'price-real' },
      { id: 'handoff_human', enabled: true, pastClientsToHuman: true }
    ]
  }
  const tools = createConversationalTools({
    config: { runtimeMode: 'tool_calling_v2', capabilitiesConfig },
    runtimeMode: 'tool_calling_v2',
    capabilitiesConfig,
    followUpMode: true,
    accountLocale: { currency: 'MXN' },
    actions: []
  })
  const names = tools.map((candidate) => candidate.name)
  const contactProfile = tools.find((candidate) => candidate.name === 'get_contact_profile')

  assert.deepEqual(names.sort(), ['get_business_profile', 'get_contact_profile', 'list_products'])
  assert.match(contactProfile.description, /sólo lectura/i)
  assert.match(contactProfile.description, /no activa reglas de traspaso ni autoriza acciones/i)
  assert.doesNotMatch(contactProfile.description, /consulta obligatoria|usa send_to_human/i)
})

test('buildInputItems conserva el límite base y acepta completo el sobre nativo ya acotado por bytes', () => {
  const messages = conversationMessages(200)
  const base = buildInputItems(messages)
  const native = buildInputItems(messages, { preserveAll: true })

  assert.equal(base.length, 12)
  assert.equal(native.length, 200)
  assert.match(JSON.stringify(base[0]), /mensaje 189/)
  assert.match(JSON.stringify(native[0]), /mensaje 1/)
})

test('sobre v2 conserva completos 60 y 200 mensajes cortos cuando caben', () => {
  for (const count of [60, 200]) {
    const messages = conversationMessages(count)
    const envelope = buildToolCallingV2HistoryEnvelope(messages)
    assert.deepEqual(envelope.messages, messages)
    assert.equal(envelope.telemetry.totalMessages, count)
    assert.equal(envelope.telemetry.includedMessages, count)
    assert.equal(envelope.telemetry.omittedMessages, 0)
    assert.ok(envelope.telemetry.includedBytes <= TOOL_CALLING_V2_HISTORY_BYTE_BUDGET)
    assert.equal(envelope.loadOlderPage, null)
  }
})

test('sobre v2 nunca corta el último mensaje y pagina los anteriores por bytes', async () => {
  const latest = `ULTIMO-INTEGRO-${'á'.repeat(3000)}`
  const messages = [
    { role: 'user', content: 'primero' },
    { role: 'assistant', content: 'segundo' },
    { role: 'user', content: latest }
  ]
  const latestBytes = estimateToolCallingV2HistoryMessageBytes(messages[2])
  const envelope = buildToolCallingV2HistoryEnvelope(messages, { byteBudget: latestBytes - 1 })

  assert.equal(envelope.messages.length, 1)
  assert.equal(envelope.messages[0].content, latest)
  assert.equal(envelope.messages[0].content.length, latest.length)
  assert.equal(envelope.telemetry.omittedMessages, 2)
  assert.equal(envelope.telemetry.overBudget, true)

  const page = await envelope.loadOlderPage({ mode: 'previous', cursor: null, offset: null, query: null, limit: 2 })
  assert.deepEqual(page.messages.map((message) => message.text), ['primero', 'segundo'])
  assert.equal(page.hasMore, false)
})

test('sobre v2 reserva bytes para medios remotos antes de hidratarlos', () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `mensaje con adjunto ${index + 1}`,
    message_type: 'image',
    media_url: `https://media.example/${index + 1}`,
    media_filename: `imagen-${index + 1}.png`,
    media_mime_type: 'image/png'
  }))
  const envelope = buildToolCallingV2HistoryEnvelope(messages)

  assert.ok(envelope.telemetry.includedMessages <= 4)
  assert.ok(envelope.telemetry.omittedMessages >= 96)
  assert.equal(envelope.messages.at(-1).content, 'mensaje con adjunto 100')
  assert.ok(envelope.telemetry.includedBytes <= TOOL_CALLING_V2_HISTORY_BYTE_BUDGET)
  assert.equal(typeof envelope.loadOlderPage, 'function')
})

test('cursor previous avanza por mensajes devueltos sin repetir ni saltar al recortar por bytes', async () => {
  const messages = Array.from({ length: 300 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `cursor-${index + 1}-${'x'.repeat(7000)}`
  }))
  const envelope = buildToolCallingV2HistoryEnvelope(messages, { byteBudget: 8000 })
  assert.equal(envelope.telemetry.includedMessages, 1)

  let cursor = null
  const seen = []
  for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
    const page = await envelope.loadOlderPage({
      mode: 'previous',
      cursor,
      offset: null,
      query: null,
      limit: 30
    })
    assert.ok(page.returnedMessages >= 1 && page.returnedMessages <= 2)
    const pageTexts = page.messages.map((message) => message.text)
    assert.equal(new Set(pageTexts).size, pageTexts.length)
    assert.ok(pageTexts.every((text) => !seen.includes(text)))
    seen.push(...pageTexts)
    const expectedPosition = 1 + seen.length
    assert.equal(page.nextCursor, `previous:${expectedPosition}`)
    cursor = page.nextCursor
  }
  assert.equal(new Set(seen).size, seen.length)
})

test('hilo de 2000 mensajes permite oldest, salto aleatorio y búsqueda literal en pocas llamadas', async () => {
  const messages = Array.from({ length: 2000 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `hilo-${index + 1}-${'z'.repeat(220)}`,
    id: `internal-${index + 1}`,
    raw_payload_json: '{"private":true}'
  }))
  messages[5].content += ' aguja-compartida'
  messages[1999].content += ' aguja-compartida'
  messages[986].content += ' aguja-987'
  const envelope = buildToolCallingV2HistoryEnvelope(messages)
  assert.ok(envelope.telemetry.omittedMessages > 1500)

  const oldest = await envelope.loadOlderPage({
    mode: 'oldest', cursor: null, offset: null, query: null, limit: 3
  })
  assert.deepEqual(oldest.messages.map((message) => message.text.slice(0, 6)), ['hilo-1', 'hilo-2', 'hilo-3'])

  const jumped = await envelope.loadOlderPage({
    mode: 'offset', cursor: null, offset: 1000, query: null, limit: 2
  })
  assert.match(jumped.messages[0].text, /^hilo-1001-/)
  assert.equal(jumped.nextCursor, 'offset:1002')

  const found = await envelope.loadOlderPage({
    mode: 'search', cursor: null, offset: null, query: 'aguja-987', limit: 5
  })
  assert.equal(found.returnedMessages, 1)
  assert.match(found.messages[0].text, /aguja-987/)

  const omittedOnly = await envelope.loadOlderPage({
    mode: 'search', cursor: null, offset: null, query: 'aguja-compartida', limit: 5
  })
  assert.equal(omittedOnly.returnedMessages, 1)
  assert.match(omittedOnly.messages[0].text, /^hilo-6-/)
  assert.doesNotMatch(JSON.stringify([oldest, jumped, found, omittedOnly]), /internal-|raw_payload|private/)
})

test('carga viva pagina desde DB, queda ligada a contacto+canal y la tool no expone IDs ni payloads', async () => {
  const allMessages = conversationMessages(60).map((message, index) => ({
    ...message,
    id: `internal-${index + 1}`,
    raw_payload_json: '{"secret":"never"}',
    messageTimestamp: `2026-07-10T00:${String(index).padStart(2, '0')}:00.000Z`,
    ...(index === 55
      ? {
          message_type: 'image',
          media_url: 'https://secret.example/internal-file-token',
          media_filename: 'foto-cliente.png',
          media_mime_type: 'image/png'
        }
      : {})
  }))
  const calls = []
  const searchCalls = []
  const loadRows = async (contactId, channel, { limit, offset }) => {
    calls.push({ contactId, channel, limit, offset })
    assert.equal(contactId, 'contacto-servidor')
    assert.equal(channel, 'sms')
    const endExclusive = Math.max(0, allMessages.length - offset)
    const start = Math.max(0, endExclusive - limit)
    return allMessages.slice(start, endExclusive)
  }
  const countRows = async (contactId, channel) => {
    assert.equal(contactId, 'contacto-servidor')
    assert.equal(channel, 'sms')
    return allMessages.length
  }
  const searchRows = async (contactId, channel, { query, limit, offset, beforeMessage }) => {
    searchCalls.push({ contactId, channel, query, limit, offset, beforeMessage })
    assert.equal(contactId, 'contacto-servidor')
    assert.equal(channel, 'sms')
    assert.equal(beforeMessage.content, 'mensaje 58')
    const matches = allMessages.slice(0, 57)
      .filter((message) => message.content.toLowerCase().includes(String(query).toLowerCase()))
    const endExclusive = Math.max(0, matches.length - offset)
    const start = Math.max(0, endExclusive - limit)
    return matches.slice(start, endExclusive)
  }

  const complete = await loadToolCallingV2ConversationEnvelope({
    contactId: 'contacto-servidor',
    channel: 'sms',
    pageSize: 7
  }, { loadRows, countRows })
  assert.equal(complete.telemetry.includedMessages, 60)
  assert.equal(complete.telemetry.omittedMessages, 0)
  assert.ok(complete.telemetry.pagesLoaded > 1)
  assert.deepEqual(complete.messages.map((message) => message.content), allMessages.map((message) => message.content))

  calls.length = 0
  const threeMessageBudget = allMessages.slice(-3)
    .reduce((sum, message) => sum + estimateToolCallingV2HistoryMessageBytes(message), 0)
  const bounded = await loadToolCallingV2ConversationEnvelope({
    contactId: 'contacto-servidor',
    channel: 'sms',
    byteBudget: threeMessageBudget,
    pageSize: 7
  }, { loadRows, countRows, searchRows })
  assert.equal(bounded.telemetry.includedMessages, 3)
  assert.equal(bounded.telemetry.omittedMessages, 57)

  const capabilitiesConfig = { schemaVersion: 1, items: [] }
  const historyTool = createConversationalTools({
    contactId: 'contacto-servidor',
    channel: 'sms',
    config: { runtimeMode: 'tool_calling_v2', capabilitiesConfig },
    runtimeMode: 'tool_calling_v2',
    capabilitiesConfig,
    historyContext: { telemetry: bounded.telemetry },
    loadConversationHistoryPage: bounded.loadOlderPage,
    followUpMode: false,
    accountLocale: { currency: 'MXN' },
    actions: []
  }).find((candidate) => candidate.name === 'get_conversation_history')

  assert.ok(historyTool)
  assert.equal(historyTool.strict, true)
  assert.deepEqual(Object.keys(historyTool.parameters.properties).sort(), ['cursor', 'limit', 'mode', 'offset', 'query'])
  assert.equal(historyTool.parameters.additionalProperties, false)
  assert.deepEqual([...historyTool.parameters.required].sort(), ['cursor', 'limit', 'mode', 'offset', 'query'])
  const older = await historyTool.invoke(null, JSON.stringify({ mode: 'previous', cursor: null, offset: null, query: null, limit: 3 }))
  assert.equal(older.ok, true)
  const olderWithMedia = await historyTool.invoke(null, JSON.stringify({ mode: 'previous', cursor: older.nextCursor, offset: null, query: null, limit: 3 }))
  assert.ok(olderWithMedia.messages.some((message) => message.attachmentSummary?.includes('Adjunto: imagen')))
  assert.doesNotMatch(JSON.stringify(olderWithMedia), /foto-cliente\.png/)
  const searched = await historyTool.invoke(null, JSON.stringify({ mode: 'search', cursor: null, offset: null, query: 'mensaje 11', limit: 3 }))
  assert.equal(searched.returnedMessages, 1)
  assert.equal(searched.messages[0].text, 'mensaje 11')
  const visiblePayload = JSON.stringify([older, olderWithMedia, searched])
  assert.doesNotMatch(visiblePayload, /internal-|raw_payload|never|secret\.example/)
  assert.ok(calls.every((call) => call.contactId === 'contacto-servidor' && call.channel === 'sms'))
  assert.ok(searchCalls.every((call) => call.contactId === 'contacto-servidor' && call.channel === 'sms'))
})

test('búsqueda SQL real sólo consulta el tramo omitido del contacto y canal ligados', async () => {
  const contactId = `history_search_${randomUUID()}`
  const otherContactId = `history_search_other_${randomUUID()}`
  const insertedContacts = [contactId, otherContactId]
  try {
    for (const id of insertedContacts) {
      await db.run(
        `INSERT INTO contacts (id, full_name, created_at, updated_at)
         VALUES (?, 'Contacto historial', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id]
      )
    }
    for (let index = 0; index < 40; index += 1) {
      const timestamp = new Date(Date.UTC(2026, 6, 10, 12, 0, index)).toISOString()
      const marker = index === 5 || index === 39 ? ' clave%_literal' : ''
      await db.run(`
        INSERT INTO whatsapp_api_messages (
          id, contact_id, direction, message_type, message_text, transport, message_timestamp, created_at
        ) VALUES (?, ?, ?, 'text', ?, 'sms', ?, ?)
      `, [
        `${contactId}_${String(index).padStart(3, '0')}`,
        contactId,
        index % 2 ? 'outbound' : 'inbound',
        `sql-${index + 1}-${'x'.repeat(1000)}${marker}`,
        timestamp,
        timestamp
      ])
    }
    const otherTimestamp = new Date(Date.UTC(2026, 6, 10, 11, 0, 0)).toISOString()
    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, contact_id, direction, message_type, message_text, transport, message_timestamp, created_at
      ) VALUES (?, ?, 'inbound', 'text', ?, 'sms', ?, ?)
    `, [`${otherContactId}_001`, otherContactId, 'otro contacto clave%_literal', otherTimestamp, otherTimestamp])

    const envelope = await loadToolCallingV2ConversationEnvelope({
      contactId,
      channel: 'sms',
      byteBudget: 2500,
      pageSize: 7
    })
    assert.ok(envelope.telemetry.omittedMessages > 30)
    const found = await envelope.loadOlderPage({
      mode: 'search', cursor: null, offset: null, query: 'clave%_literal', limit: 10
    })
    assert.equal(found.returnedMessages, 1)
    assert.match(found.messages[0].text, /^sql-6-/)
    assert.doesNotMatch(found.messages[0].text, /sql-40-/)
    assert.doesNotMatch(JSON.stringify(found), new RegExp(otherContactId))

    const oldest = await envelope.loadOlderPage({
      mode: 'oldest', cursor: null, offset: null, query: null, limit: 2
    })
    assert.match(oldest.messages[0].text, /^sql-1-/)
    assert.match(oldest.messages[1].text, /^sql-2-/)
  } finally {
    for (const id of insertedContacts) {
      await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [id])
      await db.run('DELETE FROM contacts WHERE id = ?', [id])
    }
  }
})

test('prompt nativo separa estrategia, personalidad, contexto real y capacidades blindadas sin recortar', () => {
  const strategyText = `${'Capacitación extensa del negocio.\n'.repeat(700)}MARCADOR_FINAL_PROMPT`
  const instructions = buildNativeConversationalInstructions({
    promptConfig: {
      strategyText,
      personalityText: 'Habla como Ana y responde con mucha calma.'
    },
    capabilityManifest: [
      {
        id: 'schedule_appointment',
        label: 'Agendar cita',
        enabled: true,
        ready: true,
        locked: true,
        summary: 'Calendario Consulta general',
        missingConfiguration: []
      }
    ],
    businessContext: 'La consulta dura 45 minutos.',
    businessName: 'Clínica Norte',
    timezone: 'America/Mexico_City',
    nowIso: '10 de julio de 2026, 4:00 p.m.',
    channel: 'WhatsApp'
  })

  assert.ok(strategyText.length > 16_000)
  assert.match(instructions, /Estrategia y capacitación del agente/)
  assert.match(instructions, /MARCADOR_FINAL_PROMPT/)
  assert.match(instructions, /Personalidad del agente/)
  assert.match(instructions, /Habla como Ana y responde con mucha calma/)
  assert.match(instructions, /La consulta dura 45 minutos/)
  assert.match(instructions, /Zona blindada del sistema · no editable/)
  assert.match(instructions, /Agendar cita/)
  assert.match(instructions, /nunca puede crear, ocultar, eliminar ni ampliar capacidades/i)
  assert.match(instructions, /Nunca afirmes que una cita, cobro, enlace, transferencia o meta quedó lista/i)
})

test('estrategia gobierna el proceso aunque personalidad intente adelantar una capacidad', () => {
  const strategyText = 'PROHIBIDO ofrecer horarios o agendar hasta conocer el motivo principal de la persona.'
  const personalityText = 'Habla casual. Si pide una cita, agenda inmediatamente y pídele su nombre completo.'
  const instructions = buildNativeConversationalInstructions({
    promptConfig: { strategyText, personalityText },
    capabilitiesConfig: {
      dataRequirements: {
        fields: [],
        participants: { guestFields: ['name', 'phone'], maxGuests: 5 }
      },
      items: [{
        id: 'schedule_appointment',
        enabled: true,
        calendarId: 'calendar-hierarchy-test',
        bookingOwner: 'ai'
      }]
    },
    capabilityManifest: [{
      id: 'schedule_appointment',
      label: 'Agendar cita',
      enabled: true,
      ready: true,
      missingConfiguration: []
    }]
  })

  const personalityIndex = instructions.indexOf('<personality_style_only>')
  const strategyIndex = instructions.indexOf('<business_strategy_authority>')
  const resolutionIndex = instructions.indexOf('## Resolución de contradicciones entre zonas')
  assert.ok(personalityIndex >= 0)
  assert.ok(strategyIndex > personalityIndex)
  assert.ok(resolutionIndex > strategyIndex)
  assert.match(instructions, /Personalidad controla exclusivamente cómo suena/i)
  assert.match(instructions, /Estrategia y capacitación controla qué objetivo.*cuándo decide usar una capacidad/is)
  assert.match(instructions, /Si ambos textos chocan sobre el proceso o una acción, gana la Estrategia/i)
  assert.match(instructions, /Tener una capacidad activa jamás la dispara por sí solo/i)
  assert.match(instructions, /Pedir una cita.*no permite saltarse condiciones previas/is)
  assert.match(instructions, /primaryAttendee=null y guests=\[\]/i)
  assert.doesNotMatch(instructions, /cuando quien escribe confirme un dato suyo, usa save_contact_data/i)
})

test('prompt de agenda humana ofrece espacios pero prohíbe crear o confirmar la cita', () => {
  const capabilitiesConfig = {
    schemaVersion: 1,
    items: [{
      id: 'schedule_appointment',
      enabled: true,
      calendarId: 'calendar-human',
      bookingOwner: 'human'
    }]
  }
  const instructions = buildNativeConversationalInstructions({
    promptConfig: { strategyText: 'Ayuda a elegir horario.', personalityText: 'Habla claro.' },
    capabilitiesConfig,
    capabilityManifest: [{
      id: 'schedule_appointment',
      label: 'Agendar cita',
      enabled: true,
      ready: true,
      locked: true,
      bookingOwner: 'human',
      summary: 'Agenda humana',
      missingConfiguration: []
    }]
  })

  assert.match(instructions, /request_human_booking/)
  assert.match(instructions, /sin crear una cita/i)
  assert.match(instructions, /nunca digas que la cita nueva quedó agendada/i)
  assert.match(instructions, /estrategia y capacitación del dueño decide cuándo conviene/i)
  assert.match(instructions, /una oferta pendiente no encierra la conversación/i)
  assert.match(instructions, /pueden usarse, consultarse y retomarse cuantas veces/i)
  assert.doesNotMatch(instructions, /pausa cualquier guion, interrogatorio o pregunta de calificación/i)
  assert.doesNotMatch(instructions, /sus reglas tienen precedencia sobre el guion editable/i)
  assert.match(instructions, /contacto solicitante siempre es el contacto de este hilo/i)
  assert.match(instructions, /no busques otra ficha ni pidas otro teléfono/i)
  assert.doesNotMatch(instructions, /selectionEvidence|customerQuote|assistantOfferQuote|mismo startTime/i)
  assert.match(instructions, /servidor recupera la oferta exacta/i)
})

test('prompt v2 expresa seguimientos en la zona blindada sin fabricar mensajes del cliente', () => {
  const instructions = buildNativeConversationalInstructions({
    promptConfig: { editableText: 'Habla con calidez.' },
    followUpContext: { index: 2, strategy: 'Pregunta si desea revisar otra hora.' }
  })

  assert.match(instructions, /Modo de esta vuelta/)
  assert.match(instructions, /seguimiento programado numero 2/i)
  assert.match(instructions, /Pregunta si desea revisar otra hora/)
  assert.doesNotMatch(instructions, /\[Contexto interno de Ristak:/)
})

test('prompt v2 ordena consultar el historial omitido sin inventar una sub-IA', () => {
  const instructions = buildNativeConversationalInstructions({
    promptConfig: { editableText: 'Habla con calma.' },
    historyContext: { includedMessages: 18, omittedMessages: 42, includedBytes: 12000 }
  })

  assert.match(instructions, /42 mensajes anteriores de este mismo hilo/i)
  assert.match(instructions, /consulta get_conversation_history/i)
  assert.match(instructions, /Usa search con una frase o dato concreto/i)
  assert.match(instructions, /oldest para revisar el inicio/i)
  assert.match(instructions, /offset para saltar/i)
  assert.match(instructions, /no inventes ni resumas por tu cuenta/i)
  assert.doesNotMatch(instructions, /assessment|planner|subagente|sub-IA/i)
})

test('prompt v2 respeta que el dueño deje vacía la zona editable', () => {
  const instructions = buildNativeConversationalInstructions({
    promptConfig: { editableText: '' },
    businessContext: 'Atendemos de lunes a viernes.'
  })

  assert.match(instructions, /Sin estrategia o capacitación adicional/)
  assert.match(instructions, /Sin personalidad específica configurada/)
  assert.doesNotMatch(instructions, /Responde de forma clara, útil, cálida y breve/)
  assert.match(instructions, /contexto real del negocio como datos de referencia/i)
})

test('prompt v2 incluye criterios útiles de capacidades sin exponer identificadores internos', () => {
  const instructions = buildNativeConversationalInstructions({
    capabilityManifest: [
      { id: 'collect_payment', label: 'Cobrar', enabled: true, missingConfiguration: [] },
      { id: 'handoff_human', label: 'Pasar a un humano', enabled: true, missingConfiguration: [] },
      { id: 'custom_goal', label: 'Objetivo propio', enabled: true, missingConfiguration: [] }
    ],
    capabilitiesConfig: {
      items: [
        {
          id: 'collect_payment',
          paymentMode: 'deposit',
          collectionMethod: 'bank_transfer',
          productId: 'internal-product-id',
          priceId: 'internal-price-id',
          bankTransfer: { details: 'Banco de prueba, cuenta terminación 1234' },
          deposit: {
            enabled: true,
            mode: 'fixed',
            amount: 500,
            currency: 'MXN',
            methods: { bankTransfer: true },
            bankTransferDetails: 'Banco de prueba, cuenta terminación 1234'
          }
        },
        { id: 'handoff_human', rules: 'Transfiere cuando la persona pida un especialista.', pastClientsToHuman: true },
        { id: 'custom_goal', description: 'Confirmar que desea una demostración.' }
      ]
    }
  })

  assert.match(instructions, /anticipo configurado de 500 MXN/i)
  assert.match(instructions, /Banco de prueba, cuenta terminación 1234/)
  assert.match(instructions, /pendiente de revisión/i)
  assert.doesNotMatch(instructions, /Pasarela autorizada|meses sin intereses|Usa create_payment_link/i)
  assert.match(instructions, /Transfiere cuando la persona pida un especialista/)
  assert.match(instructions, /pastClientEvidence\.isPastClient/)
  assert.doesNotMatch(instructions, /customerEvidence/)
  assert.match(instructions, /Confirmar que desea una demostración/)
  assert.doesNotMatch(instructions, /internal-product-id|internal-price-id/)
})

test('prompt asigna herramientas distintas al enlace general y al enlace de Objetivo propio', () => {
  const standalone = buildNativeConversationalInstructions({
    capabilityManifest: [{ id: 'send_link', label: 'Mandar enlace', enabled: true, ready: true, missingConfiguration: [] }],
    capabilitiesConfig: {
      items: [{ id: 'send_link', enabled: true, linkKind: 'verified_goal', url: 'https://example.test/recurso' }]
    }
  })
  assert.match(standalone, /usa exclusivamente send_trigger_link/i)
  assert.match(standalone, /Nunca crea, prepara ni completa un Objetivo propio/i)
  assert.match(standalone, /no pasa la conversación a una persona/i)

  const goalLink = buildNativeConversationalInstructions({
    capabilityManifest: [
      { id: 'send_link', label: 'Mandar enlace', enabled: true, ready: true, missingConfiguration: [] },
      { id: 'custom_goal', label: 'Objetivo propio', enabled: true, ready: true, missingConfiguration: [] }
    ],
    capabilitiesConfig: {
      items: [
        { id: 'send_link', enabled: true, linkKind: 'verified_goal', url: 'https://example.test/registro' },
        { id: 'custom_goal', enabled: true, description: 'Completar el registro', completion: 'send_link' }
      ]
    }
  })
  assert.match(goalLink, /enlace general, usa exclusivamente send_trigger_link/i)
  assert.match(goalLink, /esta meta, usa exclusivamente send_goal_url/i)
  assert.match(goalLink, /deja el objetivo pendiente/i)
  assert.match(goalLink, /Nunca uses send_trigger_link para cumplir este Objetivo propio/i)
  assert.match(goalLink, /no declares la meta cumplida al enviarlo/i)

  const incompleteGoalLink = buildNativeConversationalInstructions({
    capabilityManifest: [
      { id: 'send_link', label: 'Mandar enlace', enabled: true, ready: true, missingConfiguration: [] },
      { id: 'custom_goal', label: 'Objetivo propio', enabled: true, ready: false, missingConfiguration: ['Describe el objetivo propio.'] }
    ],
    capabilitiesConfig: {
      items: [
        { id: 'send_link', enabled: true, linkKind: 'verified_goal', url: 'https://example.test/registro' },
        { id: 'custom_goal', enabled: true, description: '', completion: 'send_link' }
      ]
    }
  })
  assert.match(incompleteGoalLink, /send_trigger_link sólo entrega el enlace general/i)
  assert.match(incompleteGoalLink, /NO está disponible porque su configuración está incompleta/i)
  assert.doesNotMatch(incompleteGoalLink, /esta meta, usa exclusivamente send_goal_url/i)

  const triggerGoalLink = buildNativeConversationalInstructions({
    capabilityManifest: [
      { id: 'send_link', label: 'Mandar enlace', enabled: true, ready: true, missingConfiguration: [] },
      { id: 'custom_goal', label: 'Objetivo propio', enabled: true, ready: false, missingConfiguration: ['Activa y configura un enlace verificable.'] }
    ],
    capabilitiesConfig: {
      items: [
        { id: 'send_link', enabled: true, linkKind: 'trigger', url: 'https://example.test/registro' },
        { id: 'custom_goal', enabled: true, description: 'Completar registro', completion: 'send_link' }
      ]
    }
  })
  assert.match(triggerGoalLink, /send_trigger_link sólo entrega el enlace general/i)
  assert.doesNotMatch(triggerGoalLink, /esta meta, usa exclusivamente send_goal_url/i)
})

test('runtime v2 ejecuta sólo el agente principal con el transcript real y nunca devuelve silencio', async () => {
  const messages = conversationMessages(200)
  let mainRuns = 0
  let receivedMessages = null
  const ctx = { actions: [] }

  const result = await runToolCallingV2Turn({
    config: { runtimeMode: 'tool_calling_v2' },
    runtime: { modelProvider: { kind: 'fake' } },
    messages,
    channel: 'whatsapp'
  }, {
    buildAgentForRun: async () => ({
      agent: { name: 'fake' },
      ctx,
      model: 'fake-model',
      aiProvider: 'openai',
      capabilityManifest: [],
      validationErrors: [],
      knowledge: { context: '' }
    }),
    runInChannel: async (_channel, callback) => callback(),
    executeAgent: async (input) => {
      mainRuns += 1
      receivedMessages = input.messages
      assert.equal(input.runtimeMode, 'tool_calling_v2')
      assert.equal(input.preserveAllMessages, true)
      assert.equal(input.historyTelemetry.includedMessages, 200)
      assert.equal(input.historyTelemetry.omittedMessages, 0)
      input.runTelemetry.modelCallCount = 2
      return ''
    }
  })

  assert.equal(mainRuns, 1)
  assert.deepEqual(receivedMessages, messages)
  assert.deepEqual(ctx.conversationMessages, messages)
  assert.deepEqual(ctx.conversationMessages.at(-1), messages.at(-1))
  assert.equal(receivedMessages.some((message) => String(message.content).startsWith('[Contexto interno de Ristak:')), false)
  assert.equal(result.modelCallCount, 2)
  assert.equal(result.historyTelemetry.includedMessages, 200)
  assert.equal(result.historyTelemetry.omittedMessages, 0)
  assert.equal(result.runtimeMode, 'tool_calling_v2')
  assert.ok(result.reply.length > 0)
})

test('sobre e historial manual v2 son idénticos en OpenAI, Gemini, Claude y DeepSeek', async () => {
  const messages = conversationMessages(60)
  for (const provider of ['openai', 'gemini', 'claude', 'deepseek']) {
    let mainRuns = 0
    const result = await runToolCallingV2Turn({
      config: { runtimeMode: 'tool_calling_v2', aiProvider: provider },
      runtime: { modelProvider: { provider } },
      messages,
      channel: 'sms'
    }, {
      buildAgentForRun: async ({ historyContext }) => ({
        agent: { name: `fake-${provider}` },
        ctx: { actions: [], historyContext },
        model: `fake-${provider}`,
        aiProvider: provider,
        capabilityManifest: [],
        validationErrors: [],
        knowledge: { context: '' }
      }),
      runInChannel: async (_channel, callback) => callback(),
      executeAgent: async (input) => {
        mainRuns += 1
        assert.deepEqual(input.messages, messages)
        assert.equal(input.preserveAllMessages, true)
        assert.equal(input.historyTelemetry.includedMessages, 60)
        return `respuesta ${provider}`
      }
    })

    assert.equal(mainRuns, 1)
    assert.equal(result.reply, `respuesta ${provider}`)
    assert.equal(result.historyTelemetry.omittedMessages, 0)
  }
})

test('seguimiento v2 usa la misma llamada principal y conserva el transcript sin mensajes sintéticos', async () => {
  const messages = conversationMessages(8)
  let mainRuns = 0
  let receivedFollowUpContext = null

  const result = await runToolCallingV2Turn({
    config: { runtimeMode: 'tool_calling_v2' },
    runtime: { modelProvider: { kind: 'fake' } },
    messages,
    channel: 'whatsapp',
    followUpContext: { index: 1, strategy: 'Retoma la propuesta.' }
  }, {
    buildAgentForRun: async (input) => {
      receivedFollowUpContext = input.followUpContext
      return {
        agent: { name: 'fake' },
        ctx: { actions: [], followUpMode: true },
        model: 'fake-model',
        aiProvider: 'openai',
        capabilityManifest: [],
        validationErrors: [],
        knowledge: { context: '' }
      }
    },
    runInChannel: async (_channel, callback) => callback(),
    executeAgent: async (input) => {
      mainRuns += 1
      assert.deepEqual(input.messages, messages)
      assert.equal(input.preserveAllMessages, true)
      assert.equal(input.messages.some((message) => String(message.content).includes('Contexto interno')), false)
      return '¿quieres que revisemos otra opción?'
    }
  })

  assert.equal(mainRuns, 1)
  assert.deepEqual(receivedFollowUpContext, { index: 1, strategy: 'Retoma la propuesta.' })
  assert.equal(result.reply, '¿quieres que revisemos otra opción?')
  assert.equal(result.modelCallCount, 1)
})

test('fallback visible v2 sólo afirma éxito cuando la acción quedó confirmada', () => {
  const confirmedLocalLabel = 'jueves 13 de agosto de 2026 a las 4:00 p. m.'
  assert.match(
    ensureToolCallingV2VisibleReply('', [{
      type: 'book_appointment',
      outcome: { status: 'ok', ok: true, localLabel: confirmedLocalLabel }
    }]),
    new RegExp(`cita quedó confirmada para ${confirmedLocalLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')
  )
  assert.doesNotMatch(
    ensureToolCallingV2VisibleReply('', [{ type: 'book_appointment', outcome: { status: 'error', ok: false } }]),
    /quedó confirmada/i
  )
  assert.match(
    ensureToolCallingV2VisibleReply('', [{
      type: 'send_goal_url',
      outcome: { status: 'ok', sentUrl: 'https://example.com/continuar?goal=real' }
    }]),
    /https:\/\/example\.com\/continuar\?goal=real/
  )
  assert.match(
    ensureToolCallingV2VisibleReply('', [
      { type: 'save_contact_data', outcome: { status: 'ok', ok: true, actionCompleted: true } },
      { type: 'book_appointment', outcome: { status: 'ok', ok: true, actionCompleted: true } }
    ]),
    /cita quedó confirmada/i
  )
})

test('respuesta v2 agrega enlaces confirmados aunque el modelo los omita y no los duplica', () => {
  const paymentUrl = 'https://pay.example.com/invoice/real-123'
  const goalUrl = 'https://example.com/continuar?goal=real'
  const paymentAction = [{
    type: 'create_payment_link',
    outcome: { status: 'ok', ok: true, paymentLink: paymentUrl }
  }]
  const goalAction = [{
    type: 'send_goal_url',
    outcome: { status: 'ok', ok: true, sentUrl: goalUrl }
  }]

  const paymentReply = ensureToolCallingV2VisibleReply('Perfecto, ya lo preparé.', paymentAction)
  assert.match(paymentReply, /enlace de pago:/i)
  assert.match(paymentReply, /https:\/\/pay\.example\.com\/invoice\/real-123/)

  const alreadyVisible = ensureToolCallingV2VisibleReply(`Aquí está: ${paymentUrl}`, paymentAction)
  assert.equal(alreadyVisible.split(paymentUrl).length - 1, 1)

  const goalReply = ensureToolCallingV2VisibleReply('Te lo mando enseguida.', goalAction)
  assert.match(goalReply, /enlace para continuar:/i)
  assert.match(goalReply, /https:\/\/example\.com\/continuar\?goal=real/)
})

test('sanitizador v2 conserva lenguaje natural y URLs de agenda sin filtrar intención', () => {
  assert.equal(
    sanitizeToolCallingV2Reply('Te puedo agendar aquí: https://example.com/agendar'),
    'Te puedo agendar aquí: https://example.com/agendar'
  )
  assert.equal(
    sanitizeToolCallingV2Reply('Ejecuté book_appointment. Tu cita quedó lista.'),
    'Ejecuté la acción solicitada. Tu cita quedó lista.'
  )

  const toolNames = [
    'get_free_slots',
    'get_business_profile',
    'list_products',
    'get_contact_profile',
    'get_conversation_history',
    'save_contact_data',
    'update_closing_context',
    'register_deposit_payment_proof',
    'book_appointment',
    'create_payment_link',
    'send_goal_url',
    'send_trigger_link',
    'send_to_human',
    'mark_ready_to_advance'
  ]
  const sanitized = sanitizeToolCallingV2Reply(`Interno: ${toolNames.join(', ')}`)
  for (const toolName of toolNames) {
    assert.doesNotMatch(sanitized, new RegExp(toolName, 'i'))
  }
})

test('preview v2 comparte el sobre por bytes, conserva 60 mensajes cortos y nunca se marca suprimido', async () => {
  const messages = conversationMessages(60)
  let hydratedCount = 0
  let nativeRuns = 0
  const config = {
    runtimeMode: 'tool_calling_v2',
    aiProvider: 'openai',
    model: 'fake-model',
    replyDelivery: { splitMessagesEnabled: false }
  }

  const result = await runConversationalAgentPreview({ messages }, {
    resolvePreviewRuntimeConfig: async () => ({
      config,
      runtimeDefaults: { aiProvider: 'openai', model: 'fake-model' }
    }),
    resolveAIRuntime: async () => ({
      apiKey: 'stored-test-key-not-real',
      modelProvider: { kind: 'fake' },
      supportsMultimodalInputs: true
    }),
    hydratePreviewMessages: async (input) => {
      hydratedCount = input.length
      return input
    },
    runNativeTurn: async ({ messages: input, historyEnvelope, contactId, contactName, virtualContact, dryRun }) => {
      nativeRuns += 1
      assert.equal(contactId, CONVERSATIONAL_PREVIEW_CONTACT_ID)
      assert.equal(contactName, CONVERSATIONAL_PREVIEW_CONTACT_NAME)
      assert.equal(virtualContact.id, CONVERSATIONAL_PREVIEW_CONTACT_ID)
      assert.equal(virtualContact.fullName, CONVERSATIONAL_PREVIEW_CONTACT_NAME)
      assert.equal(virtualContact.email, CONVERSATIONAL_PREVIEW_CONTACT_EMAIL)
      assert.equal(dryRun, true)
      assert.equal(input.length, 60)
      assert.equal(historyEnvelope.telemetry.source, 'preview')
      assert.equal(historyEnvelope.telemetry.includedMessages, 60)
      assert.equal(historyEnvelope.telemetry.omittedMessages, 0)
      assert.equal(historyEnvelope.loadOlderPage, null)
      return {
        reply: 'respuesta visible',
        ctx: { actions: [] },
        model: 'fake-model',
        runtimeMode: 'tool_calling_v2',
        modelCallCount: 1,
        historyTelemetry: historyEnvelope.telemetry,
        capabilityManifest: [],
        validationErrors: []
      }
    }
  })

  assert.equal(hydratedCount, 60)
  assert.equal(nativeRuns, 1)
  assert.equal(result.reply, 'respuesta visible')
  assert.deepEqual(result.replyParts, ['respuesta visible'])
  assert.equal(result.suppressed, false)
  assert.equal(result.modelCallCount, 1)
  assert.equal(result.historyTelemetry.includedMessages, 60)
  assert.equal(result.historyTelemetry.omittedMessages, 0)
  assert.deepEqual(result.validationErrors, [])
})

test('preview con efectos usa el contacto real elegido y conserva dryRun para todas las tools', async () => {
  const config = {
    runtimeMode: 'tool_calling_v2',
    aiProvider: 'openai',
    model: 'fake-model',
    replyDelivery: { splitMessagesEnabled: false }
  }
  const previewContact = {
    id: 'contact-real-test',
    full_name: 'Patricia Jiménez',
    phone: '+526560000000'
  }
  const previewScopeId = `appointment_preview_${'a'.repeat(48)}`
  const agentId = 'agent-preview-real-contact'

  const result = await runConversationalAgentPreview({
    messages: [{ role: 'user', content: 'quiero agendar para mi mamá' }],
    previewContact,
    agentId,
    executionId: 'test:message-real-contact',
    previewScopeId
  }, {
    resolvePreviewRuntimeConfig: async () => ({
      config,
      runtimeDefaults: { aiProvider: 'openai', model: 'fake-model' }
    }),
    resolveAIRuntime: async () => ({
      apiKey: 'stored-test-key-not-real',
      modelProvider: { kind: 'fake' },
      supportsMultimodalInputs: true
    }),
    hydratePreviewMessages: async (input) => input,
    runNativeTurn: async ({ config: receivedConfig, contactId, contactName, virtualContact, dryRun, executionId, previewScopeId: receivedScopeId }) => {
      assert.equal(receivedConfig.id, agentId)
      assert.equal(contactId, previewContact.id)
      assert.equal(contactName, previewContact.full_name)
      assert.equal(virtualContact, null)
      assert.equal(dryRun, true)
      assert.equal(executionId, 'test:message-real-contact')
      assert.equal(receivedScopeId, previewScopeId)
      return {
        reply: 'respuesta con contacto real',
        ctx: { actions: [] },
        model: 'fake-model',
        runtimeMode: 'tool_calling_v2',
        modelCallCount: 1,
        historyTelemetry: {},
        capabilityManifest: [],
        validationErrors: []
      }
    }
  })

  assert.equal(result.reply, 'respuesta con contacto real')
})

test('preview v2 pagina sólo sus mensajes omitidos dentro de la misma ejecución principal', async () => {
  const messages = Array.from({ length: 80 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `preview-${index + 1}-${'x'.repeat(4000)}`
  }))
  messages[3].content += ' preview-needle'
  const config = {
    runtimeMode: 'tool_calling_v2',
    aiProvider: 'openai',
    model: 'fake-model',
    replyDelivery: { splitMessagesEnabled: false }
  }
  let mainRuns = 0

  const result = await runConversationalAgentPreview({ messages }, {
    resolvePreviewRuntimeConfig: async () => ({
      config,
      runtimeDefaults: { aiProvider: 'openai', model: 'fake-model' }
    }),
    resolveAIRuntime: async () => ({
      apiKey: 'stored-test-key-not-real',
      modelProvider: { kind: 'fake' },
      supportsMultimodalInputs: true
    }),
    hydratePreviewMessages: async (input) => input,
    runNativeTurn: async ({ messages: input, historyEnvelope }) => {
      mainRuns += 1
      assert.ok(historyEnvelope.telemetry.omittedMessages > 0)
      assert.equal(typeof historyEnvelope.loadOlderPage, 'function')
      const page = await historyEnvelope.loadOlderPage({ mode: 'previous', cursor: null, offset: null, query: null, limit: 2 })
      const oldest = await historyEnvelope.loadOlderPage({ mode: 'oldest', cursor: null, offset: null, query: null, limit: 1 })
      const searched = await historyEnvelope.loadOlderPage({ mode: 'search', cursor: null, offset: null, query: 'preview-needle', limit: 2 })
      const includedTexts = new Set(input.map((message) => message.content))
      assert.ok(page.messages.length > 0)
      assert.ok(page.messages.every((message) => !includedTexts.has(message.text)))
      assert.match(oldest.messages[0].text, /^preview-1-/)
      assert.equal(searched.returnedMessages, 1)
      assert.match(searched.messages[0].text, /preview-needle/)
      return {
        reply: 'preview con historial',
        ctx: { actions: [] },
        model: 'fake-model',
        runtimeMode: 'tool_calling_v2',
        modelCallCount: 1,
        historyTelemetry: historyEnvelope.telemetry,
        capabilityManifest: [],
        validationErrors: []
      }
    }
  })

  assert.equal(mainRuns, 1)
  assert.equal(result.reply, 'preview con historial')
  assert.ok(result.historyTelemetry.omittedMessages > 0)
})
