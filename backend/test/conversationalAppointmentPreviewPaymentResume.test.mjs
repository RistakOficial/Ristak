import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

import { db } from '../src/config/database.js'
import {
  createConversationalTools,
  loadConversationalAppointmentOfferDecisionContext
} from '../src/agents/conversational/tools.js'
import { runToolCallingV2Turn } from '../src/agents/conversational/runner.js'
import {
  getConversationalAgentTestVerifiedPaymentEvidence,
  prepareConversationalAgentTestRun,
  recordConversationalAgentPreviewEffects,
  setConversationalAgentTestServiceDependenciesForTests
} from '../src/services/conversationalAgentTestService.js'
import {
  setConversationalAgentTestPaymentDependenciesForTests,
  syncConversationalAgentTestPaymentLink
} from '../src/services/conversationalAgentTestPaymentService.js'
import {
  buildConversationalAppointmentPreviewOfferEventId,
  buildConversationalAppointmentPreviewScopeId
} from '../src/services/conversationalAppointmentPreviewOfferService.js'
import { createLocalAppointment, upsertLocalCalendar } from '../src/services/localCalendarService.js'
import { getAccountCurrency } from '../src/utils/accountLocale.js'
import { getAccountTimezone } from '../src/utils/dateUtils.js'
import { runVersionedMigrations } from '../src/startup/runMigrations.js'

await runVersionedMigrations()

function terminalBookingArgs() {
  return {
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
    guests: [{
      name: 'Ana Jiménez',
      phone: null,
      phoneSourceQuote: null,
      email: null,
      emailSourceQuote: null,
      relation: 'Acompañante'
    }]
  }
}

function alteredResumeBookingArgs() {
  return {
    title: 'Cita para el contacto equivocado',
    notes: null,
    attendeeName: null,
    attendeeContext: null,
    primaryAttendee: null,
    guests: []
  }
}

test('preview con anticipo reanuda desde evidencia sandbox durable y materializa la cita en otro request', async () => {
  const suffix = randomUUID()
  const runId = `session_payment_resume_${suffix}`
  const agentId = `agent_payment_resume_${suffix}`
  const contactId = `contact_payment_resume_${suffix}`
  const calendarId = `calendar_payment_resume_${suffix}`
  const username = `user_payment_resume_${suffix}`
  const offerMessageId = `message_offer_${suffix}`
  const confirmationMessageId = `message_confirm_${suffix}`
  const acceptanceMessageId = `message_accept_${suffix}`
  const resumeMessageId = `message_resume_${suffix}`
  const currency = await getAccountCurrency()
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 31 }).startOf('day')
  const monday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const slot = monday.set({ hour: 11, minute: 0, second: 0, millisecond: 0 })
  const startTime = slot.toUTC().toISO()
  const capabilitiesConfig = {
    schemaVersion: 3,
    items: [
      {
        id: 'schedule_appointment',
        enabled: true,
        calendarId,
        bookingOwner: 'ai',
        allowOverlaps: false,
        testMode: { enabled: true, cleanupAfterMinutes: 5, notify: false }
      },
      {
        id: 'collect_payment',
        enabled: true,
        collectionMethod: 'payment_link',
        paymentMode: 'deposit',
        chargeType: 'deposit',
        gateway: 'stripe',
        deposit: {
          enabled: true,
          mode: 'fixed',
          amount: 500,
          currency,
          methods: { paymentLink: true, bankTransfer: false }
        },
        installments: { enabled: false, maxInstallments: 0 },
        expirationMinutes: 60,
        afterPayment: 'continue',
        testMode: { enabled: true, cleanupAfterMinutes: 5, notify: false }
      }
    ]
  }
  const config = {
    id: agentId,
    runtimeMode: 'tool_calling_v2',
    objective: 'schedule_appointment',
    capabilitiesConfig
  }
  const effects = {
    enabled: true,
    scheduleAppointment: true,
    collectPayment: true,
    assignUser: false,
    notifyOwner: false
  }
  let userId = ''
  let paymentEffectId = ''
  let paymentId = ''

  try {
    await db.run(
      `INSERT INTO users (username, password_hash, full_name, is_active, created_at, updated_at)
       VALUES (?, 'test-hash', 'Dueño de prueba', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [username]
    )
    userId = String((await db.get('SELECT id FROM users WHERE username = ?', [username]))?.id || '')
    await db.run(
      `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
       VALUES (?, 'Contacto que agenda', '+526567426612', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await upsertLocalCalendar({
      id: calendarId,
      locationId: `location_payment_resume_${suffix}`,
      name: 'Agenda sandbox con anticipo',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{
        daysOfTheWeek: [1],
        hours: [{ openHour: 11, openMinute: 0, closeHour: 12, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO conversational_agents (id, name, enabled, runtime_mode, capabilities_config)
       VALUES (?, 'Agente sandbox con anticipo', 1, 'tool_calling_v2', ?)`,
      [agentId, JSON.stringify(capabilitiesConfig)]
    )

    setConversationalAgentTestServiceDependenciesForTests({
      createAppointment: async (req, res) => {
        const appointment = await createLocalAppointment(req.body, { syncStatus: 'synced' })
        res.status(201).json({ success: true, data: appointment })
      }
    })
    setConversationalAgentTestPaymentDependenciesForTests({
      createPaymentGateLink: async (paymentConfig, options) => {
        assert.equal(paymentConfig.mode, 'test')
        assert.equal(options.forceTestMode, true)
        paymentId = `payment_resume_${suffix}`
        const publicPaymentId = `public_payment_resume_${suffix}`
        const paymentUrl = `https://payments.example.test/${publicPaymentId}`
        const testEffectId = options.metadata?.conversationalAgentTest?.testEffectId || null
        await db.run(
          `INSERT INTO payments (
             id, contact_id, amount, currency, status, payment_method, payment_mode,
             payment_provider, public_payment_id, payment_url, metadata_json,
             conversational_test_effect_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'sent', 'stripe', 'test', 'stripe', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            paymentId,
            contactId,
            paymentConfig.amount,
            paymentConfig.currency,
            publicPaymentId,
            paymentUrl,
            JSON.stringify(options.metadata),
            testEffectId
          ]
        )
        return { payment: { id: paymentId }, publicPaymentId, paymentUrl }
      }
    })

    const previewScopeId = buildConversationalAppointmentPreviewScopeId({
      testSessionId: runId,
      requestedByUserId: userId,
      agentId
    })
    const offerRun = await prepareConversationalAgentTestRun({
      testRunId: runId,
      testMessageId: offerMessageId,
      agentId,
      requestedByUserId: userId,
      contactId,
      effects
    })
    const virtualContact = {
      id: contactId,
      fullName: 'Contacto que agenda',
      full_name: 'Contacto que agenda',
      phone: '+526567426612'
    }
    const offerCtx = {
      runtimeMode: 'tool_calling_v2',
      contactId,
      agentId,
      channel: 'whatsapp',
      dryRun: true,
      previewScopeId,
      executionId: offerRun.executionId,
      virtualContact,
      conversationMessages: [
        { id: offerRun.executionId, role: 'user', content: 'Quiero agendar a mi mamá Paty y Ana irá como acompañante.' }
      ],
      accountLocale: { currency },
      actions: [],
      config
    }
    const offered = await createConversationalTools(offerCtx)
      .find((item) => item.name === 'offer_appointment_slot')
      .invoke(null, JSON.stringify({ startTime }))
    assert.equal(offered.ok, true, JSON.stringify(offered))

    const confirmationRun = await prepareConversationalAgentTestRun({
      testRunId: runId,
      testMessageId: confirmationMessageId,
      agentId,
      requestedByUserId: userId,
      contactId,
      effects
    })
    const confirmationCtx = {
      ...offerCtx,
      executionId: confirmationRun.executionId,
      actions: [],
      conversationMessages: [
        { id: `opening_${suffix}`, role: 'user', content: 'Quiero agendar a mi mamá Paty y Ana irá como acompañante.' },
        { id: `assistant_offer_${suffix}`, role: 'assistant', content: offered.visibleReply },
        { id: confirmationRun.executionId, role: 'user', content: 'antes dime cuánto cuesta' }
      ]
    }
    const offerEventId = buildConversationalAppointmentPreviewOfferEventId(previewScopeId)
    const offerBeforeWrongReplay = await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )
    const wrongReoffer = await createConversationalTools(confirmationCtx)
      .find((item) => item.name === 'offer_appointment_slot')
      .invoke(null, JSON.stringify({ startTime }))
    assert.equal(wrongReoffer.ok, false, JSON.stringify(wrongReoffer))
    assert.equal(wrongReoffer.code, 'appointment_preview_offer_pending_decision')
    assert.equal((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )).detail_json, offerBeforeWrongReplay.detail_json)

    confirmationCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: confirmationCtx,
      config
    })
    assert.equal(confirmationCtx.appointmentOfferDecision?.active, true)
    const decisionTools = createConversationalTools(confirmationCtx)
    assert.equal(decisionTools.some((item) => item.name === 'get_free_slots'), false)
    assert.equal(decisionTools.some((item) => item.name === 'offer_appointment_slot'), false)
    assert.equal(decisionTools.some((item) => item.name === 'book_appointment'), false)
    const keptOpen = await decisionTools
      .find((item) => item.name === 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify({
        decision: 'keep_open',
        reply: 'claro, la valoración tiene el valor configurado; el horario sigue disponible',
        agreedAmount: null,
        ...terminalBookingArgs()
      }))
    assert.equal(keptOpen.ok, true, JSON.stringify(keptOpen))
    assert.equal(JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )).detail_json).status, 'active')

    const acceptanceRun = await prepareConversationalAgentTestRun({
      testRunId: runId,
      testMessageId: acceptanceMessageId,
      agentId,
      requestedByUserId: userId,
      contactId,
      effects
    })
    const acceptanceCtx = {
      ...confirmationCtx,
      executionId: acceptanceRun.executionId,
      actions: [],
      conversationMessages: [
        { id: `opening_${suffix}`, role: 'user', content: 'Quiero agendar a mi mamá Paty y Ana irá como acompañante.' },
        { id: `assistant_offer_${suffix}`, role: 'assistant', content: offered.visibleReply },
        { id: confirmationRun.executionId, role: 'user', content: 'antes dime cuánto cuesta' },
        { id: `assistant_keep_open_${suffix}`, role: 'assistant', content: keptOpen.visibleReply },
        { id: acceptanceRun.executionId, role: 'user', content: 'ok, sí apártalo' }
      ]
    }
    acceptanceCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: acceptanceCtx,
      config
    })

    const activeOfferBeforePaymentPreflight = await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )
    const missingPaymentDataConfig = {
      ...config,
      capabilitiesConfig: {
        ...capabilitiesConfig,
        items: capabilitiesConfig.items.map((item) => item.id === 'collect_payment'
          ? {
              ...item,
              deposit: {
                ...item.deposit,
                mode: 'range',
                amount: null,
                minAmount: 100,
                maxAmount: 700
              }
            }
          : item),
        dataRequirements: {
          enabled: true,
          fields: [{ field: 'email', level: 'required', scope: 'payment' }],
          updateContact: { enabled: false, policy: 'replace_placeholders' },
          participants: { enabled: false, guestFields: ['name'], maxGuests: 10 }
        }
      }
    }
    const actionScopedPaymentCtx = {
      ...acceptanceCtx,
      config: missingPaymentDataConfig,
      capabilitiesConfig: missingPaymentDataConfig.capabilitiesConfig,
      actions: []
    }
    const actionScopedPaymentTools = createConversationalTools(actionScopedPaymentCtx)
    assert.equal(actionScopedPaymentTools.some((item) => item.name === 'save_contact_data'), true)
    const missingPaymentData = await actionScopedPaymentTools
      .find((item) => item.name === 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify({
        decision: 'accept',
        reply: null,
        agreedAmount: null,
        ...terminalBookingArgs()
      }))
    assert.equal(missingPaymentData.ok, false, JSON.stringify(missingPaymentData))
    assert.equal(missingPaymentData.needsData, true)
    assert.match(missingPaymentData.visibleReply, /correo/i)
    assert.equal((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )).detail_json, activeOfferBeforePaymentPreflight.detail_json)

    const retainedOnlyForAction = await actionScopedPaymentTools
      .find((item) => item.name === 'save_contact_data')
      .invoke(null, JSON.stringify({
        fullName: null,
        phone: null,
        alternatePhone: null,
        email: 'paty@example.com',
        company: null,
        address: null,
        customValues: null,
        confirmedReplacement: false
      }))
    assert.equal(retainedOnlyForAction.ok, true, JSON.stringify(retainedOnlyForAction))
    assert.equal(retainedOnlyForAction.retainedForCurrentAction, true)
    assert.equal(retainedOnlyForAction.actionCompleted, false)
    const effectiveContact = await createConversationalTools({
      ...actionScopedPaymentCtx,
      appointmentOfferDecision: null
    }).find((item) => item.name === 'get_contact_profile')
      .invoke(null, JSON.stringify({}))
    assert.equal(effectiveContact.contact.email, 'paty@example.com')
    assert.equal((await db.get('SELECT email FROM contacts WHERE id = ?', [contactId])).email, null)

    const missingAgreedAmount = await actionScopedPaymentTools
      .find((item) => item.name === 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify({
        decision: 'accept',
        reply: null,
        agreedAmount: null,
        ...terminalBookingArgs()
      }))
    assert.equal(missingAgreedAmount.ok, false, JSON.stringify(missingAgreedAmount))
    assert.equal(missingAgreedAmount.requiredField, 'agreedAmount')
    assert.match(missingAgreedAmount.visibleReply, /monto de anticipo/i)
    assert.equal((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )).detail_json, activeOfferBeforePaymentPreflight.detail_json)

    const acceptedWithAutomaticPayment = await createConversationalTools(acceptanceCtx)
      .find((item) => item.name === 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify({
        decision: 'accept',
        reply: null,
        agreedAmount: null,
        ...terminalBookingArgs()
      }))
    assert.equal(acceptedWithAutomaticPayment.ok, true, JSON.stringify(acceptedWithAutomaticPayment))
    assert.equal(acceptedWithAutomaticPayment.terminal, true)
    assert.match(acceptedWithAutomaticPayment.visibleReply, /enlace de anticipo/i)
    assert.equal(acceptanceCtx.actions.filter((action) => action.type === 'create_payment_link').length, 1)

    const boundBeforeConflictingReplay = await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )
    const replayDecisionContext = {
      ...acceptanceCtx.appointmentOfferDecision,
      active: false
    }
    const conflictingDraftReplay = await createConversationalTools({
      ...acceptanceCtx,
      appointmentOfferDecision: replayDecisionContext,
      appointmentOfferResolutionAuthority: {
        decision: 'accept',
        offerEventId,
        executionId: acceptanceRun.executionId,
        calendarId,
        startTime,
        terminalToolName: acceptanceCtx.appointmentOfferDecision.terminalToolName
      },
      actions: []
    }).find((item) => item.name === 'book_appointment')
      .invoke(null, JSON.stringify(alteredResumeBookingArgs()))
    assert.equal(conflictingDraftReplay.ok, false, JSON.stringify(conflictingDraftReplay))
    assert.equal(conflictingDraftReplay.code, 'appointment_request_contract_conflict')
    assert.equal((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )).detail_json, boundBeforeConflictingReplay.detail_json)

    const paymentEffects = await recordConversationalAgentPreviewEffects({
      runContext: acceptanceRun,
      actions: acceptanceCtx.actions
    })
    assert.equal(paymentEffects.length, 1, JSON.stringify(paymentEffects))
    assert.equal(paymentEffects[0].type, 'payment')
    assert.equal(paymentEffects[0].status, 'prepared')
    paymentEffectId = paymentEffects[0].id

    await db.run(
      `UPDATE payments
       SET status = 'paid', paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [paymentId]
    )
    const paidLedger = await syncConversationalAgentTestPaymentLink({
      effectId: paymentEffectId,
      requestedByUserId: userId
    })
    assert.equal(paidLedger.status, 'paid_test')

    const resumeRun = await prepareConversationalAgentTestRun({
      testRunId: runId,
      testMessageId: resumeMessageId,
      agentId,
      requestedByUserId: userId,
      contactId,
      effects
    })
    const testVerifiedPaymentEvidence = await getConversationalAgentTestVerifiedPaymentEvidence({
      runContext: resumeRun
    })
    assert.ok(testVerifiedPaymentEvidence)
    assert.equal(testVerifiedPaymentEvidence.testEffectId, paymentEffectId)
    assert.equal(testVerifiedPaymentEvidence.startTime, startTime)

    const acceptedBeforeResume = await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )
    const acceptedDetail = JSON.parse(acceptedBeforeResume.detail_json)
    assert.equal(acceptedDetail.appointmentRequestDraft.primaryAttendee.name, 'Paty Jiménez')
    assert.equal(acceptedDetail.appointmentRequestDraft.guests[0].name, 'Ana Jiménez')
    assert.match(acceptedDetail.appointmentRequestDraftHash, /^[a-f0-9]{64}$/)
    assert.equal(acceptedDetail.bookingOwner, 'ai')
    assert.equal(acceptedDetail.terminalToolName, 'book_appointment')
    assert.equal(testVerifiedPaymentEvidence.bookingOwner, 'ai')
    assert.equal(testVerifiedPaymentEvidence.terminalToolName, 'book_appointment')
    const rejectedReofferCtx = {
      ...offerCtx,
      executionId: resumeRun.executionId,
      testVerifiedPaymentEvidence,
      actions: []
    }
    const rejectedReoffer = await createConversationalTools(rejectedReofferCtx)
      .find((item) => item.name === 'offer_appointment_slot')
      .invoke(null, JSON.stringify({ startTime }))
    assert.equal(rejectedReoffer.ok, false, JSON.stringify(rejectedReoffer))
    assert.equal((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )).detail_json, acceptedBeforeResume.detail_json)

    const resumeMessages = [
      { id: `opening_${suffix}`, role: 'user', content: 'Hola quisiera agendar' },
      { id: `assistant_question_${suffix}`, role: 'assistant', content: 'Claro. ¿Qué día entre semana te queda mejor para la cita?' },
      { id: `availability_${suffix}`, role: 'user', content: 'que fechas hay' },
      { id: `assistant_offer_${suffix}`, role: 'assistant', content: offered.visibleReply },
      { id: confirmationRun.executionId, role: 'user', content: 'ok' },
      { id: `assistant_payment_${suffix}`, role: 'assistant', content: `Para confirmar la cita se requiere un anticipo. ${paymentEffects[0].payload.paymentUrl}` }
    ]
    let forcedToolCalls = 0
    const resumedTurn = await runToolCallingV2Turn({
      config,
      runtime: { modelProvider: {} },
      messages: resumeMessages,
      contactId,
      contactName: 'Contacto que agenda',
      dryRun: true,
      channel: 'whatsapp',
      traceMessage: 'Pago sandbox confirmado por webhook',
      executionId: resumeRun.executionId,
      previewScopeId,
      testVerifiedPaymentEvidence,
      virtualContact,
      conversationModel: 'gpt-4.1-mini'
    }, {
      executeAgent: async ({ agent }) => {
        assert.equal(agent.modelSettings.toolChoice, 'book_appointment')
        const terminalTool = agent.tools.find((item) => item.name === agent.modelSettings.toolChoice)
        assert.ok(terminalTool)
        forcedToolCalls += 1
        const result = await terminalTool.invoke(null, JSON.stringify(alteredResumeBookingArgs()))
        assert.equal(result.ok, true, JSON.stringify(result))
        assert.equal(result.simulated, true)
        return ''
      },
      runInChannel: (_channel, callback) => callback()
    })

    assert.equal(forcedToolCalls, 1)
    assert.doesNotMatch(resumedTurn.reply, /tengo disponible|te funciona|preparo el enlace/i)
    assert.match(resumedTurn.reply, /cita(?: de prueba)? quedó confirmada/i)
    const bookingAction = resumedTurn.ctx.actions.find((action) => action.type === 'book_appointment')
    assert.ok(bookingAction)
    assert.equal(bookingAction.startTime, startTime)
    assert.equal(bookingAction.confirmationEvidence.reusedForTestPaymentResume, true)
    assert.equal(bookingAction.title, 'Cita para Paty Jiménez · Valoración de rodilla')
    assert.ok(bookingAction.participants.some((participant) => participant.role === 'primary_attendee' && participant.name === 'Paty Jiménez'))
    assert.ok(bookingAction.participants.some((participant) => participant.role === 'guest' && participant.name === 'Ana Jiménez'))

    const appointmentEffects = await recordConversationalAgentPreviewEffects({
      runContext: resumeRun,
      actions: resumedTurn.ctx.actions
    })
    assert.equal(appointmentEffects.length, 1, JSON.stringify(appointmentEffects))
    assert.equal(appointmentEffects[0].type, 'appointment')
    assert.equal(appointmentEffects[0].status, 'recorded', JSON.stringify(appointmentEffects[0]))
    assert.equal(appointmentEffects[0].payload.appointmentCreated, true)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [calendarId, contactId]
    )).total), 1)
    const createdAppointment = await db.get(
      `SELECT id FROM appointments
       WHERE calendar_id = ? AND contact_id = ? ORDER BY start_time DESC LIMIT 1`,
      [calendarId, contactId]
    )
    const materializedParticipants = await db.all(
      `SELECT role, name_snapshot FROM appointment_participants
       WHERE appointment_id = ? ORDER BY role, position`,
      [createdAppointment.id]
    )
    assert.ok(materializedParticipants.some((participant) => participant.role === 'primary_attendee' && participant.name_snapshot === 'Paty Jiménez'))
    assert.ok(materializedParticipants.some((participant) => participant.role === 'guest' && participant.name_snapshot === 'Ana Jiménez'))

    const materialized = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )).detail_json)
    assert.equal(materialized.status, 'materialized')
  } finally {
    setConversationalAgentTestServiceDependenciesForTests(null)
    setConversationalAgentTestPaymentDependenciesForTests(null)
    await db.run(
      `DELETE FROM internal_notifications
       WHERE category = 'conversational_agent_test' AND contact_id = ?`,
      [contactId]
    ).catch(() => undefined)
    await db.run(
      `DELETE FROM appointment_creation_requests
       WHERE appointment_id IN (SELECT id FROM appointments WHERE calendar_id = ?)`,
      [calendarId]
    ).catch(() => undefined)
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_test_payment_links WHERE test_run_id = ?', [runId]).catch(() => undefined)
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_test_effects WHERE run_id = ?', [runId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_test_runs WHERE id = ?', [runId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_events WHERE agent_id = ?', [agentId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => undefined)
  }
})
