import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

import { db } from '../src/config/database.js'
import {
  beginConversationalAgentTestEffect,
  buildConversationalAgentTestTurnRequestHash,
  cleanupConversationalAgentTestRun,
  ensureConversationalAgentTestEffectNotification,
  listRecentConversationalAgentTestRuns,
  listConversationalAgentTestEffects,
  isConversationalAgentTestMaterializationTerminal,
  normalizeConversationalAgentTestEffects,
  executeConversationalAgentTestTurn,
  prepareConversationalAgentTestRun,
  reconcileConversationalAgentPreviewResult,
  recordConversationalAgentPreviewEffects,
  replayCompletedConversationalAgentTestTurn,
  setConversationalAgentTestServiceDependenciesForTests
} from '../src/services/conversationalAgentTestService.js'
import {
  createConversationalAgentTestPaymentLink,
  setConversationalAgentTestPaymentDependenciesForTests
} from '../src/services/conversationalAgentTestPaymentService.js'
import {
  CONVERSATIONAL_AGENT_TEST_CONTACT_EMAIL,
  resolveConversationalAgentTestContact
} from '../src/services/conversationalAgentTestContactService.js'
import {
  lockConversationalTesterConfigOverride,
  testAgent as testAgentController
} from '../src/controllers/conversationalAgentController.js'
import { createAppointment as createAppointmentController } from '../src/controllers/calendarsController.js'
import { createLocalAppointment, upsertLocalCalendar } from '../src/services/localCalendarService.js'
import { runIdempotentAppointmentCreation } from '../src/services/appointmentCreationSafetyService.js'
import {
  createConversationalTools,
  loadConversationalAppointmentOfferDecisionContext,
  loadConversationalAppointmentSelectionProgressContext
} from '../src/agents/conversational/tools.js'
import { runConversationalAgentPreview } from '../src/agents/conversational/runner.js'
import { getAccountCurrency } from '../src/utils/accountLocale.js'
import { getAccountTimezone } from '../src/utils/dateUtils.js'
import {
  getConversationalAgentMetrics,
  listConversationalAgentEvents,
  updateConversationalAgent
} from '../src/services/conversationalAgentService.js'
import { withConversationalAgentTestMutationLock } from '../src/services/conversationalAgentTestMutationLockService.js'
import { runVersionedMigrations } from '../src/startup/runMigrations.js'
import {
  CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT,
  CONVERSATIONAL_APPOINTMENT_SELECTION_PROGRESS_EVENT,
  buildConversationalAppointmentPreviewExecutionId,
  buildConversationalAppointmentPreviewOfferEventId,
  buildConversationalAppointmentPreviewScopeId,
  cleanupExpiredConversationalAppointmentPreviewOffers
} from '../src/services/conversationalAppointmentPreviewOfferService.js'

await runVersionedMigrations()

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

test('scope y ejecución del preview quedan ligados a usuario, agente, sesión y mensaje', () => {
  const base = {
    testSessionId: `session_${randomUUID()}`,
    requestedByUserId: 'user-preview-scope',
    agentId: 'agent-preview-scope'
  }
  const scope = buildConversationalAppointmentPreviewScopeId(base)
  assert.match(scope, /^appointment_preview_[a-f0-9]{48}$/)
  assert.equal(buildConversationalAppointmentPreviewScopeId(base), scope)
  assert.notEqual(buildConversationalAppointmentPreviewScopeId({ ...base, requestedByUserId: 'other-user' }), scope)
  assert.notEqual(buildConversationalAppointmentPreviewScopeId({ ...base, agentId: 'other-agent' }), scope)
  const firstExecution = buildConversationalAppointmentPreviewExecutionId({
    previewScopeId: scope,
    testMessageId: `message_${randomUUID()}`
  })
  const secondExecution = buildConversationalAppointmentPreviewExecutionId({
    previewScopeId: scope,
    testMessageId: `message_${randomUUID()}`
  })
  assert.match(firstExecution, /^preview:[a-f0-9]{48}$/)
  assert.notEqual(firstExecution, secondExecution)
})

test('el turno test completo serializa carreras, reproduce la respuesta exacta y recupera crashes desde el preview', async () => {
  const suffix = randomUUID()
  const runId = `session_turn_${suffix}`
  const messageId = `message_turn_${suffix}`
  const runContext = { id: runId, messageId }
  const requestPayload = {
    schemaVersion: 1,
    messages: [{ id: `transcript_${suffix}`, role: 'user', content: 'Sí, confirma las diez.' }],
    agentId: `agent_${suffix}`,
    contactId: `contact_${suffix}`,
    effects: { enabled: true, scheduleAppointment: true }
  }
  const requestHash = buildConversationalAgentTestTurnRequestHash(requestPayload)
  assert.equal(
    requestHash,
    buildConversationalAgentTestTurnRequestHash({
      effects: { scheduleAppointment: true, enabled: true },
      contactId: `contact_${suffix}`,
      agentId: `agent_${suffix}`,
      messages: requestPayload.messages,
      schemaVersion: 1
    }),
    'el hash no depende del orden de llaves'
  )

  let releasePreview
  const previewGate = new Promise((resolve) => { releasePreview = resolve })
  let previewCalls = 0
  let materializeCalls = 0
  const createPreview = async () => {
    previewCalls += 1
    await previewGate
    return {
      reply: 'El modelo dijo algo provisional.',
      actions: [{ type: 'book_appointment', startTime: '2026-08-12T16:00:00.000Z' }]
    }
  }
  const materializePreview = async () => {
    materializeCalls += 1
    return {
      reply: 'Listo, la cita de prueba quedó confirmada.',
      replyParts: ['Listo, la cita de prueba quedó confirmada.'],
      actions: [{ type: 'book_appointment', outcome: { status: 'recorded', materialized: true } }],
      testRunId: runId,
      testEffects: [{ id: `effect_${suffix}`, type: 'appointment', status: 'recorded' }]
    }
  }

  try {
    await db.run(
      `INSERT INTO conversational_agent_test_runs (
         id, agent_id, requested_by_user_id, contact_id, effects_json, status, expires_at
       ) VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      [runId, `agent_${suffix}`, `user_${suffix}`, `contact_${suffix}`, '{}', new Date(Date.now() + 60_000).toISOString()]
    )

    const first = executeConversationalAgentTestTurn({
      runContext,
      requestHash,
      createPreview,
      materializePreview
    })
    while (previewCalls === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    const contenders = Array.from({ length: 5 }, () => executeConversationalAgentTestTurn({
      runContext,
      requestHash,
      createPreview,
      materializePreview
    }))
    releasePreview()
    const raced = await Promise.all([first, ...contenders])
    assert.equal(previewCalls, 1)
    assert.equal(materializeCalls, 1)
    raced.forEach((item) => assert.deepEqual(item.response, raced[0].response))
    assert.equal(raced.filter((item) => item.replayed === false).length, 1)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM conversational_agent_test_turns WHERE run_id = ? AND message_id = ?',
      [runId, messageId]
    )).total), 1)

    const sequentialReplay = await executeConversationalAgentTestTurn({
      runContext,
      requestHash,
      createPreview,
      materializePreview
    })
    assert.equal(sequentialReplay.replayed, true)
    assert.deepEqual(sequentialReplay.response, raced[0].response)
    assert.equal(previewCalls, 1)
    assert.equal(materializeCalls, 1)

    await db.run(
      `UPDATE conversational_agent_test_turns SET client_request_hash = ?
       WHERE run_id = ? AND message_id = ?`,
      [requestHash, runId, messageId]
    )
    const earlyReplay = await replayCompletedConversationalAgentTestTurn({
      testRunId: runId,
      testMessageId: messageId,
      requestedByUserId: `user_${suffix}`,
      clientRequestHash: requestHash
    })
    assert.deepEqual(earlyReplay, raced[0].response)
    await assert.rejects(
      replayCompletedConversationalAgentTestTurn({
        testRunId: runId,
        testMessageId: messageId,
        requestedByUserId: `user_${suffix}`,
        clientRequestHash: buildConversationalAgentTestTurnRequestHash({ otro: 'payload' })
      }),
      (error) => error?.code === 'test_turn_payload_mismatch'
    )

    const corruptMessageId = `message_turn_corrupt_${suffix}`
    const corruptContext = { id: runId, messageId: corruptMessageId }
    const corruptHash = buildConversationalAgentTestTurnRequestHash({ ...requestPayload, corruptMessageId })
    const corruptTurnId = `catt_${createHash('sha256')
      .update(`${runId}\u0000${corruptMessageId}`)
      .digest('hex')
      .slice(0, 48)}`
    await db.run(
      `INSERT INTO conversational_agent_test_turns (
         id, run_id, message_id, request_hash, client_request_hash, status,
         preview_result_json, response_json, attempt_count, completed_at
       ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, 1, CURRENT_TIMESTAMP)`,
      [
        corruptTurnId,
        runId,
        corruptMessageId,
        corruptHash,
        corruptHash,
        JSON.stringify({ reply: 'Preview durable de respuesta dañada.', actions: [] }),
        '  {respuesta-incompleta  '
      ]
    )
    assert.equal(await replayCompletedConversationalAgentTestTurn({
      testRunId: runId,
      testMessageId: corruptMessageId,
      requestedByUserId: `user_${suffix}`,
      clientRequestHash: corruptHash
    }), null, 'el fast-path deja que el executor repare una respuesta ilegible')
    let corruptPreviewCalls = 0
    let corruptMaterializeCalls = 0
    const corruptRecovered = await executeConversationalAgentTestTurn({
      runContext: corruptContext,
      requestHash: corruptHash,
      createPreview: async () => {
        corruptPreviewCalls += 1
        return { reply: 'No debe consultar otra vez la IA.', actions: [] }
      },
      materializePreview: async (preview) => {
        corruptMaterializeCalls += 1
        assert.equal(preview.reply, 'Preview durable de respuesta dañada.')
        return { reply: 'Respuesta final reparada desde el preview.', actions: [] }
      }
    })
    assert.equal(corruptRecovered.recovered, true)
    assert.equal(corruptRecovered.response.reply, 'Respuesta final reparada desde el preview.')
    assert.equal(corruptPreviewCalls, 0)
    assert.equal(corruptMaterializeCalls, 1)

    let mismatchedPreviewCalls = 0
    await assert.rejects(
      executeConversationalAgentTestTurn({
        runContext,
        requestHash: buildConversationalAgentTestTurnRequestHash({ ...requestPayload, messages: [{ role: 'user', content: 'Otro mensaje.' }] }),
        createPreview: async () => { mismatchedPreviewCalls += 1; return {} },
        materializePreview
      }),
      (error) => error?.code === 'test_turn_payload_mismatch'
    )
    assert.equal(mismatchedPreviewCalls, 0)

    const crashMessageId = `message_turn_crash_${suffix}`
    const crashContext = { id: runId, messageId: crashMessageId }
    const crashHash = buildConversationalAgentTestTurnRequestHash({ ...requestPayload, crashMessageId })
    let crashPreviewCalls = 0
    let crashMaterializeCalls = 0
    const crashCreatePreview = async () => {
      crashPreviewCalls += 1
      return { reply: 'Preview durable', actions: [{ type: 'book_appointment' }] }
    }
    const crashMaterialize = async () => {
      crashMaterializeCalls += 1
      if (crashMaterializeCalls === 1) throw new Error('caída simulada después del checkpoint')
      return { reply: 'Respuesta recuperada sin segunda IA', actions: [] }
    }
    await assert.rejects(
      executeConversationalAgentTestTurn({
        runContext: crashContext,
        requestHash: crashHash,
        createPreview: crashCreatePreview,
        materializePreview: crashMaterialize
      }),
      /caída simulada/
    )
    const recovered = await executeConversationalAgentTestTurn({
      runContext: crashContext,
      requestHash: crashHash,
      createPreview: crashCreatePreview,
      materializePreview: crashMaterialize
    })
    assert.equal(recovered.recovered, true)
    assert.equal(recovered.response.reply, 'Respuesta recuperada sin segunda IA')
    assert.equal(crashPreviewCalls, 1)
    assert.equal(crashMaterializeCalls, 2)
    const recoveredRow = await db.get(
      'SELECT status, attempt_count, preview_result_json FROM conversational_agent_test_turns WHERE run_id = ? AND message_id = ?',
      [runId, crashMessageId]
    )
    assert.equal(recoveredRow.status, 'completed')
    assert.equal(Number(recoveredRow.attempt_count), 2)
    assert.ok(recoveredRow.preview_result_json)

    const pendingMessageId = `message_turn_pending_${suffix}`
    const pendingContext = { id: runId, messageId: pendingMessageId }
    const pendingHash = buildConversationalAgentTestTurnRequestHash({ ...requestPayload, pendingMessageId })
    let pendingPreviewCalls = 0
    let pendingMaterializeCalls = 0
    const pendingResult = await executeConversationalAgentTestTurn({
      runContext: pendingContext,
      requestHash: pendingHash,
      createPreview: async () => {
        pendingPreviewCalls += 1
        return { reply: 'Preview pendiente', actions: [{ type: 'book_appointment' }] }
      },
      materializePreview: async () => {
        pendingMaterializeCalls += 1
        return {
          kind: 'conversational_agent_test_turn_materialization',
          terminal: pendingMaterializeCalls > 1,
          response: {
            reply: pendingMaterializeCalls > 1
              ? 'Listo, la cita de prueba quedó confirmada.'
              : 'La cita de prueba sigue procesándose.',
            actions: []
          }
        }
      }
    })
    assert.equal(pendingResult.response.reply, 'Listo, la cita de prueba quedó confirmada.')
    assert.equal(pendingPreviewCalls, 1)
    assert.equal(pendingMaterializeCalls, 2)
    assert.equal((await db.get(
      'SELECT status FROM conversational_agent_test_turns WHERE run_id = ? AND message_id = ?',
      [runId, pendingMessageId]
    )).status, 'completed')

    const staleMessageId = `message_turn_stale_${suffix}`
    const staleContext = { id: runId, messageId: staleMessageId }
    const staleHash = buildConversationalAgentTestTurnRequestHash({ ...requestPayload, staleMessageId })
    const staleTurnId = `catt_${createHash('sha256')
      .update(`${runId}\u0000${staleMessageId}`)
      .digest('hex')
      .slice(0, 48)}`
    await db.run(
      `INSERT INTO conversational_agent_test_turns (
         id, run_id, message_id, request_hash, status, preview_result_json,
         attempt_count, claim_token, lease_until_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'processing', ?, 1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        staleTurnId,
        runId,
        staleMessageId,
        staleHash,
        JSON.stringify({ reply: 'Preview de dueño caído', actions: [{ type: 'book_appointment' }] }),
        `claim_muerto_${suffix}`,
        new Date(Date.now() - 60_000).toISOString()
      ]
    )
    let stalePreviewCalls = 0
    let staleMaterializeCalls = 0
    const reclaimed = await executeConversationalAgentTestTurn({
      runContext: staleContext,
      requestHash: staleHash,
      createPreview: async () => {
        stalePreviewCalls += 1
        return { reply: 'No debe volver a consultar la IA.', actions: [] }
      },
      materializePreview: async (preview) => {
        staleMaterializeCalls += 1
        assert.equal(preview.reply, 'Preview de dueño caído')
        return { reply: 'Turno retomado desde el checkpoint.', actions: [] }
      }
    })
    assert.equal(reclaimed.recovered, true)
    assert.equal(reclaimed.response.reply, 'Turno retomado desde el checkpoint.')
    assert.equal(stalePreviewCalls, 0)
    assert.equal(staleMaterializeCalls, 1)
    const reclaimedRow = await db.get(
      `SELECT status, attempt_count, claim_token, lease_until_at
       FROM conversational_agent_test_turns WHERE id = ?`,
      [staleTurnId]
    )
    assert.equal(reclaimedRow.status, 'completed')
    assert.equal(Number(reclaimedRow.attempt_count), 2)
    assert.equal(reclaimedRow.claim_token, null)
    assert.equal(reclaimedRow.lease_until_at, null)
  } finally {
    releasePreview?.()
    await db.run('DELETE FROM conversational_agent_test_turns WHERE run_id = ?', [runId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_test_runs WHERE id = ?', [runId]).catch(() => undefined)
  }
})

test('la respuesta visible exige efectos terminales y separa agenda, asignación y pago', () => {
  assert.equal(isConversationalAgentTestMaterializationTerminal([
    { type: 'appointment', status: 'failed', retryable: true }
  ]), false, 'un fallo transitorio nunca se cachea como respuesta final')
  assert.equal(isConversationalAgentTestMaterializationTerminal([
    { type: 'appointment', status: 'failed', retryable: false }
  ]), true, 'un fallo de negocio definitivo sí puede cerrar el turno')
  assert.equal(isConversationalAgentTestMaterializationTerminal([
    { type: 'appointment', status: 'recorded' }
  ]), true)

  const paymentAction = {
    type: 'collect_payment',
    outcome: { status: 'simulated', paymentUrl: 'https://example.test/sandbox' }
  }
  const source = {
    reply: 'Listo, tu cita quedó confirmada.',
    replyParts: ['Listo, tu cita quedó confirmada.'],
    replyPartDelaysMs: [250],
    actions: [
      {
        type: 'book_appointment',
        outcome: { status: 'simulated', ok: true, materialized: true }
      },
      paymentAction
    ]
  }
  const processing = reconcileConversationalAgentPreviewResult({
    result: source,
    testEffects: [{
      type: 'appointment',
      status: 'processing',
      code: 'test_mutation_lock_busy',
      summary: 'Otra petición todavía conserva el candado.'
    }]
  })
  assert.match(processing.reply, /sigue procesándose/i)
  assert.match(processing.reply, /todavía no puedo confirmarla/i)
  assert.doesNotMatch(processing.reply, /no se creó|quedó confirmada/i)
  assert.equal(processing.actions[0].outcome.status, 'pending')
  assert.equal(processing.actions[0].outcome.appointmentMaterialized, false)
  assert.strictEqual(processing.actions[1], paymentAction)

  const failed = reconcileConversationalAgentPreviewResult({
    result: source,
    testEffects: [{
      type: 'appointment',
      status: 'failed',
      code: 'test_appointment_creation_failed',
      summary: 'El proveedor no devolvió una confirmación final.'
    }]
  })
  assert.match(failed.reply, /no pude confirmar el resultado/i)
  assert.match(failed.reply, /no la des por agendada/i)
  assert.doesNotMatch(failed.reply, /no se creó|quedó confirmada/i)
  assert.equal(failed.actions[0].outcome.status, 'error')
  assert.equal(failed.actions[0].outcome.code, 'test_appointment_creation_failed')
  assert.strictEqual(failed.actions[1], paymentAction)

  const humanAction = {
    type: 'request_human_booking',
    outcome: { status: 'simulated', actionCompleted: true },
    targetUserId: 'user_handoff'
  }
  const assignmentWon = reconcileConversationalAgentPreviewResult({
    result: { ...source, actions: [humanAction, paymentAction] },
    testEffects: [
      {
        type: 'appointment',
        status: 'failed',
        code: 'test_slot_no_longer_free',
        appointmentDateRestored: true,
        summary: 'El slot se ocupó.'
      },
      {
        id: 'effect_assignment_recorded',
        type: 'assignment',
        status: 'recorded',
        entityId: 'contact_assigned',
        payload: { assignmentActive: true }
      }
    ]
  })
  assert.match(assignmentWon.reply, /conservé el día/i)
  assert.match(assignmentWon.reply, /asignación temporal.*sí quedó registrada/i)
  assert.equal(assignmentWon.actions[0].outcome.status, 'partial')
  assert.equal(assignmentWon.actions[0].outcome.appointmentMaterialized, false)
  assert.equal(assignmentWon.actions[0].outcome.assignmentMaterialized, true)
  assert.equal(assignmentWon.actions[0].targetUserId, 'user_handoff')
  assert.strictEqual(assignmentWon.actions[1], paymentAction)

  const appointmentWon = reconcileConversationalAgentPreviewResult({
    result: { ...source, actions: [humanAction, paymentAction] },
    testEffects: [
      {
        id: 'effect_human_request_recorded',
        type: 'appointment',
        status: 'recorded',
        payload: { safeTestRecord: true, appointmentCreated: false }
      },
      {
        type: 'assignment',
        status: 'failed',
        code: 'test_assignment_failed',
        summary: 'No se pudo completar la asignación.'
      }
    ]
  })
  assert.match(appointmentWon.reply, /solicitud de cita de prueba sí quedó registrada/i)
  assert.match(appointmentWon.reply, /no pude completar la asignación/i)
  assert.equal(appointmentWon.actions[0].outcome.status, 'partial')
  assert.equal(appointmentWon.actions[0].outcome.appointmentMaterialized, true)
  assert.equal(appointmentWon.actions[0].outcome.assignmentMaterialized, false)
  assert.strictEqual(appointmentWon.actions[1], paymentAction)

  const recordedAppointment = reconcileConversationalAgentPreviewResult({
    result: {
      reply: 'Tengo horarios de 11:00 a 16:00. ¿Cuál prefieres?',
      replyParts: ['Tengo horarios de 11:00 a 16:00. ¿Cuál prefieres?'],
      replyPartDelaysMs: [500],
      actions: [source.actions[0], { type: 'offer_appointment_options', outcome: { status: 'simulated' } }, paymentAction]
    },
    testEffects: [{
      id: 'effect_appointment_recorded',
      type: 'appointment',
      status: 'recorded',
      entityId: 'appointment_recorded',
      payload: { safeTestRecord: true, appointmentCreated: true }
    }]
  })
  assert.equal(recordedAppointment.reply, 'Listo, la cita de prueba quedó confirmada.')
  assert.deepEqual(recordedAppointment.replyParts, [recordedAppointment.reply])
  assert.deepEqual(recordedAppointment.replyPartDelaysMs, [])
  assert.doesNotMatch(recordedAppointment.reply, /11:00|16:00/)
  assert.equal(recordedAppointment.actions[0].outcome.status, 'recorded')
  assert.equal(recordedAppointment.actions[0].outcome.ok, true)
  assert.equal(recordedAppointment.actions[0].outcome.materialized, true)
  assert.strictEqual(recordedAppointment.actions[2], paymentAction)

  assert.deepEqual(processing.replyParts, [processing.reply])
  assert.deepEqual(processing.replyPartDelaysMs, [])
  assert.equal(source.reply, 'Listo, tu cita quedó confirmada.', 'la reconciliación no muta el preview original')
})

test('controller/frontend sin ids conserva fecha -> hora -> oferta -> sí y materializa una sola cita test', async () => {
  const suffix = randomUUID()
  const agentId = `agent_preview_identity_${suffix}`
  const contactId = `contact_preview_identity_${suffix}`
  const calendarId = `calendar_preview_identity_${suffix}`
  const runId = `session_preview_identity_${suffix}`
  const username = `tester_preview_identity_${suffix}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 21 }).startOf('day')
  const monday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const slot = monday.set({ hour: 10, minute: 0, second: 0, millisecond: 0 })
  const startTime = slot.toUTC().toISO()
  const opening = 'Quiero cita para mi mamá el lunes.'
  const hour = 'A las 10 de la mañana.'
  const confirmation = 'Sí, ese horario está bien. Agéndala.'
  let userId = ''
  let testAppointmentControllerCalls = 0
  let forceOriginalProviderFailure = false
  let realControllerRequest = null
  let realControllerPayload = null
  let previousGoogleConfig = null
  const googleConfigKey = 'google_calendar_service_account_config'

  const capabilitiesConfig = {
    schemaVersion: 3,
    items: [{
      id: 'schedule_appointment',
      enabled: true,
      calendarId,
      allowOverlaps: false,
      bookingOwner: 'ai',
      testMode: { enabled: true, cleanupAfterMinutes: 5, notify: false }
    }]
  }
  const config = {
    id: agentId,
    runtimeMode: 'tool_calling_v2',
    aiProvider: 'openai',
    model: 'fake-model',
    replyDelivery: { splitMessagesEnabled: false },
    capabilitiesConfig
  }
  const effects = {
    enabled: true,
    scheduleAppointment: true,
    collectPayment: false,
    assignUser: false,
    notifyOwner: false
  }

  try {
    previousGoogleConfig = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      [googleConfigKey]
    )
    await db.run('DELETE FROM app_config WHERE config_key = ?', [googleConfigKey])
    await db.run(
      `INSERT INTO users (username, password_hash, full_name, is_active, created_at, updated_at)
       VALUES (?, 'test-hash', 'Tester identidad preview', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [username]
    )
    userId = String((await db.get('SELECT id FROM users WHERE username = ?', [username]))?.id || '')
    await db.run(
      `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
       VALUES (?, 'Contacto identidad preview', '+526561234567', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await upsertLocalCalendar({
      id: calendarId,
      locationId: `location_preview_identity_${suffix}`,
      name: 'Agenda identidad preview',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [1], hours: [{ openHour: 10, openMinute: 0, closeHour: 11, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced', allowGoogleSyncMetadata: true })
    await db.run(
      `INSERT INTO conversational_agents (id, name, enabled, runtime_mode, ai_provider, model, capabilities_config)
       VALUES (?, 'Agente identidad preview', 1, 'tool_calling_v2', 'openai', 'fake-model', ?)`,
      [agentId, JSON.stringify(capabilitiesConfig)]
    )
    setConversationalAgentTestServiceDependenciesForTests({
      createAppointment: async (req, res) => {
        testAppointmentControllerCalls += 1
        if (forceOriginalProviderFailure) {
          return res.status(502).json({
            success: false,
            code: 'test_appointment_google_mirror_failed',
            error: 'Google no confirmó el espejo de la cita temporal.'
          })
        }
        if (testAppointmentControllerCalls === 1) {
          const payload = {
            calendarId: req.body.calendarId,
            contactId: req.body.contactId,
            startTime: req.body.startTime,
            endTime: req.body.endTime,
            source: 'conversational_agent_v2'
          }
          try {
            await runIdempotentAppointmentCreation({
              clientRequestId: req.body.clientRequestId,
              payload,
              create: async () => {
                throw Object.assign(new Error('Fallo transitorio controlado del calendario de prueba'), {
                  status: 503,
                  code: 'test_transient_calendar_failure'
                })
              }
            })
          } catch (error) {
            return res.status(error.status || 503).json({
              success: false,
              code: error.code,
              error: error.message
            })
          }
        }
        const originalJson = res.json.bind(res)
        realControllerRequest = req
        res.json = (payload) => {
          realControllerPayload = payload
          return originalJson(payload)
        }
        return createAppointmentController(req, res)
      }
    })

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
                  title: 'Valoración maxilofacial',
                  notes: 'Cita creada desde el tester',
                  attendeeName: 'Mamá del contacto',
                  attendeeContext: 'Mamá del contacto',
                  primaryAttendee: {
                    name: 'Mamá del contacto',
                    phone: null,
                    phoneSourceQuote: null,
                    email: null,
                    emailSourceQuote: null,
                    relation: 'Mamá'
                  },
                  guests: []
                }))
        if (output) assert.equal(output.ok, true, JSON.stringify(output))
        return {
          reply: turnNumber === 1
            ? '¿A qué hora del lunes la necesitas?'
            : turnNumber === 2
              ? output.visibleReply
              : 'Listo, la cita de prueba quedó agendada.',
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
    const runTurn = async (messages, testMessageId) => {
      const runContext = await prepareConversationalAgentTestRun({
        testRunId: runId,
        testMessageId,
        agentId,
        requestedByUserId: userId,
        contactId,
        effects,
        messages,
        configOverride: config
      })
      const previewScopeId = buildConversationalAppointmentPreviewScopeId({
        testSessionId: runId,
        requestedByUserId: userId,
        agentId
      })
      const result = await runConversationalAgentPreview({
        messages,
        agentId,
        previewContact: runContext.contact,
        executionId: runContext.executionId,
        previewScopeId
      }, dependencies)
      return { result, runContext }
    }

    const first = await runTurn([
      { role: 'user', content: opening }
    ], `message_date_${suffix}`)
    assert.match(first.result.reply, /qué hora/i)
    assert.deepEqual(await recordConversationalAgentPreviewEffects({
      runContext: first.runContext,
      actions: first.result.actions
    }), [])

    const secondMessages = [
      { role: 'user', content: opening },
      { role: 'assistant', content: first.result.reply },
      { role: 'user', content: hour }
    ]
    const second = await runTurn(secondMessages, `message_hour_${suffix}`)
    assert.equal(second.result.actions[0]?.type, 'offer_appointment_slot')
    assert.deepEqual(await recordConversationalAgentPreviewEffects({
      runContext: second.runContext,
      actions: second.result.actions
    }), [])

    const third = await runTurn([
      ...secondMessages,
      { role: 'assistant', content: second.result.reply },
      { role: 'user', content: confirmation }
    ], `message_confirmation_${suffix}`)
    const reservedTurn = await db.get(
      `SELECT status, attempt_count, request_hash, client_request_hash
       FROM conversational_agent_test_turns WHERE run_id = ? AND message_id = ?`,
      [runId, third.runContext.messageId]
    )
    assert.equal(reservedTurn.status, 'pending')
    assert.equal(Number(reservedTurn.attempt_count), 0)
    assert.match(reservedTurn.request_hash, /^[a-f0-9]{64}$/)
    assert.match(reservedTurn.client_request_hash, /^[a-f0-9]{64}$/)
    const runBeforeMismatch = await db.get(
      'SELECT effects_json, expires_at, updated_at FROM conversational_agent_test_runs WHERE id = ?',
      [runId]
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    await assert.rejects(
      prepareConversationalAgentTestRun({
        testRunId: runId,
        testMessageId: third.runContext.messageId,
        agentId,
        requestedByUserId: userId,
        contactId,
        effects,
        messages: [{ role: 'user', content: 'Payload distinto con el mismo messageId.' }],
        configOverride: config
      }),
      (error) => error?.code === 'test_turn_payload_mismatch'
    )
    const runAfterMismatch = await db.get(
      'SELECT effects_json, expires_at, updated_at FROM conversational_agent_test_runs WHERE id = ?',
      [runId]
    )
    assert.deepEqual(runAfterMismatch, runBeforeMismatch, 'el payload rechazado no muta autoridad ni TTL de la corrida')
    assert.equal(third.result.actions.filter((action) => action.type === 'book_appointment').length, 1)
    assert.doesNotMatch(third.result.reply, /dime la hora|qué hora|hora otra vez/i)
    const appointmentAction = third.result.actions.find((action) => action.type === 'book_appointment')
    const abandonedClaim = await beginConversationalAgentTestEffect({
      testRunId: runId,
      testMessageId: third.runContext.messageId,
      requestedByUserId: userId,
      effectType: 'appointment',
      request: {
        calendarId: String(appointmentAction.calendarId ?? '').trim(),
        startTime: String(appointmentAction.startTime ?? '').trim(),
        endTime: String(appointmentAction.endTime ?? '').trim(),
        title: String(appointmentAction.title ?? '').trim(),
        bookingOwner: 'ai',
        confirmationEvidence: appointmentAction.confirmationEvidence,
        participants: Array.isArray(appointmentAction.participants) ? appointmentAction.participants : []
      }
    })
    assert.equal(abandonedClaim.claimed, true)
    assert.equal(abandonedClaim.effect.status, 'processing')

    // Si el progreso parcial quedó viejo después de aceptar la oferta, la cita
    // canónica ya creada debe repararlo en el mismo COMMIT. Marcar el mismatch
    // como retryable sin corregirlo produciría un loop determinístico.
    const mismatchPreviewScopeId = buildConversationalAppointmentPreviewScopeId({
      testSessionId: runId,
      requestedByUserId: userId,
      agentId
    })
    const staleProgressId = `cae_appointment_progress_${createHash('sha256').update([
      agentId,
      contactId,
      'whatsapp',
      mismatchPreviewScopeId
    ].join('\u0000')).digest('hex').slice(0, 48)}`
    const staleProgressDetail = {
      schemaVersion: 1,
      agentId,
      contactId,
      channel: 'whatsapp',
      previewScopeId: mismatchPreviewScopeId,
      calendarId: `calendar_viejo_${suffix}`,
      selectedCalendar: `calendar_viejo_${suffix}`,
      purpose: 'book',
      appointmentId: null,
      selectedDate: slot.toFormat('yyyy-MM-dd'),
      selectedTime: '10:00',
      selectedStartTime: startTime,
      selectedTimezone: timezone,
      previouslyShownRanges: [],
      availabilityCheckedAt: new Date().toISOString(),
      availabilityVerificationRequired: false,
      lastError: null,
      appointmentStatus: 'collecting_time',
      missingFields: ['time'],
      sourceExecutionId: third.runContext.executionId,
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }
    await db.run(
      `INSERT INTO conversational_agent_events
        (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        staleProgressId,
        contactId,
        agentId,
        CONVERSATIONAL_APPOINTMENT_SELECTION_PROGRESS_EVENT,
        JSON.stringify(staleProgressDetail)
      ]
    )

    // Simula una caída con lease vigente antes de materializar. Al obtener el
    // advisory lock, el replay sabe que ese dueño ya no existe y retoma el mismo
    // request idempotente de inmediato, sin confirmar un processing huérfano.
    const materialized = await recordConversationalAgentPreviewEffects({
      runContext: third.runContext,
      actions: third.result.actions
    })
    assert.equal(materialized.length, 1)
    assert.equal(materialized[0].status, 'recorded', JSON.stringify(materialized))
    assert.equal(materialized[0].payload.appointmentCreated, true)
    assert.equal(materialized[0].payload.controllerAttempts, 2)
    assert.equal(materialized[0].payload.retried, true)
    assert.equal(testAppointmentControllerCalls, 2)
    assert.equal(realControllerPayload?.success, true)
    assert.equal(realControllerPayload?.data?.testEffectId, materialized[0].id)
    assert.equal(Number((await db.get(
      'SELECT attempt_count FROM conversational_agent_test_effects WHERE id = ?',
      [materialized[0].id]
    )).attempt_count), 2)
    const repairedProgress = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [staleProgressId]
    )).detail_json)
    assert.equal(repairedProgress.calendarId, calendarId)
    assert.equal(repairedProgress.selectedCalendar, calendarId)
    assert.equal(repairedProgress.appointmentStatus, 'materialized')
    assert.equal(repairedProgress.materializedEffectId, materialized[0].id)
    assert.equal(repairedProgress.selectedStartTime, startTime)

    const controllerReplay = mockResponse()
    await createAppointmentController(realControllerRequest, controllerReplay)
    assert.equal(controllerReplay.statusCode, 201)
    assert.equal(controllerReplay.body?.success, true)
    assert.equal(controllerReplay.body?.data?.id, materialized[0].entityId)
    const durableRequest = await db.get(
      `SELECT status, appointment_id, error_retryable
       FROM appointment_creation_requests
       WHERE client_request_id = ?`,
      [`conv-test:${materialized[0].id}`]
    )
    assert.equal(durableRequest?.status, 'completed')
    assert.equal(durableRequest?.appointment_id, materialized[0].entityId)
    assert.equal(Number(durableRequest?.error_retryable || 0), 0)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ? AND is_test = 1',
      [contactId]
    )).total), 1)

    // Segunda ventana de caída: el controller sí cerró su request y la cita,
    // pero el proceso murió antes de cerrar el efecto. El replay reconoce su
    // propia cita y pasa por el mismo controller idempotente.
    const previewScopeId = buildConversationalAppointmentPreviewScopeId({
      testSessionId: runId,
      requestedByUserId: userId,
      agentId
    })
    const offerEventId = buildConversationalAppointmentPreviewOfferEventId(previewScopeId)
    const offerRow = await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )
    const offerDetail = JSON.parse(offerRow.detail_json)
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
      [JSON.stringify({
        ...offerDetail,
        status: 'materializing',
        materializationEffectId: materialized[0].id,
        materializationExecutionId: third.runContext.executionId
      }), offerEventId, offerRow.detail_json]
    )
    await db.run(
      `UPDATE conversational_agent_test_effects
       SET status = 'processing', entity_id = NULL, claim_token = ?, lease_until_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [`abandoned_${suffix}`, new Date(Date.now() + 9 * 60 * 1000).toISOString(), materialized[0].id]
    )
    const resumedAfterCanonicalCreation = await recordConversationalAgentPreviewEffects({
      runContext: third.runContext,
      actions: third.result.actions
    })
    assert.equal(resumedAfterCanonicalCreation[0].status, 'recorded')
    assert.equal(resumedAfterCanonicalCreation[0].entityId, materialized[0].entityId)
    assert.equal(testAppointmentControllerCalls, 3)
    assert.equal(Number((await db.get(
      'SELECT attempt_count FROM conversational_agent_test_effects WHERE id = ?',
      [materialized[0].id]
    )).attempt_count), 3)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ? AND is_test = 1',
      [contactId]
    )).total), 1, 'recuperar una caída después del insert no puede duplicar la cita')

    const replay = await recordConversationalAgentPreviewEffects({
      runContext: third.runContext,
      actions: third.result.actions
    })
    assert.equal(replay[0].id, materialized[0].id)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ? AND is_test = 1',
      [contactId]
    )).total), 1, 'reintentar la confirmación no puede duplicar la cita test')

    // Tercera ventana: la cita local ya existe pero el controller aún conserva
    // un request processing. Mientras su lease está fresca, el contender sólo
    // puede decir "sigue procesándose". Vencida la lease, SafetyService marca
    // el checkpoint interrumpido; no lo adopta como éxito ni duplica la cita.
    const materializedOfferRow = await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )
    const materializedOfferDetail = JSON.parse(materializedOfferRow.detail_json)
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ? AND detail_json = ?',
      [JSON.stringify({
        ...materializedOfferDetail,
        status: 'materializing',
        materializationEffectId: materialized[0].id,
        materializationExecutionId: third.runContext.executionId
      }), offerEventId, materializedOfferRow.detail_json]
    )
    await db.run(
      `UPDATE appointment_creation_requests
       SET status = 'processing', processing_token = ?, updated_at = CURRENT_TIMESTAMP
       WHERE client_request_id = ?`,
      [`controller_still_running_${suffix}`, `conv-test:${materialized[0].id}`]
    )
    await db.run(
      `UPDATE conversational_agent_test_effects
       SET status = 'processing', entity_id = NULL, claim_token = ?, lease_until_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [`effect_owner_lost_${suffix}`, new Date(Date.now() + 9 * 60 * 1000).toISOString(), materialized[0].id]
    )
    const stillProcessing = await recordConversationalAgentPreviewEffects({
      runContext: third.runContext,
      actions: third.result.actions
    })
    assert.equal(stillProcessing[0].status, 'processing')
    assert.equal(testAppointmentControllerCalls, 3, 'el contender no entra al controller con lease fresca')
    const processingVisible = reconcileConversationalAgentPreviewResult({
      result: third.result,
      testEffects: stillProcessing
    })
    assert.match(processingVisible.reply, /sigue procesándose/i)
    assert.doesNotMatch(processingVisible.reply, /quedó agendada|quedó confirmada|no se creó/i)

    await db.run(
      `UPDATE appointment_creation_requests
       SET updated_at = '2000-01-01T00:00:00.000Z'
       WHERE client_request_id = ?`,
      [`conv-test:${materialized[0].id}`]
    )
    const interruptedCheckpoint = await recordConversationalAgentPreviewEffects({
      runContext: third.runContext,
      actions: third.result.actions
    })
    assert.equal(interruptedCheckpoint[0].status, 'failed')
    assert.equal(interruptedCheckpoint[0].code, 'test_appointment_checkpoint_interrupted')
    assert.equal(interruptedCheckpoint[0].retryable, false)
    const interruptedVisible = reconcileConversationalAgentPreviewResult({
      result: third.result,
      testEffects: interruptedCheckpoint
    })
    assert.match(interruptedVisible.reply, /se interrumpió después de guardar una cita temporal/i)
    assert.match(interruptedVisible.reply, /no la des por confirmada/i)
    assert.doesNotMatch(interruptedVisible.reply, /quedó agendada|quedó confirmada/i)
    const interruptedLedger = await db.get(
      `SELECT status, failure_kind FROM appointment_creation_requests
       WHERE client_request_id = ?`,
      [`conv-test:${materialized[0].id}`]
    )
    assert.equal(interruptedLedger.status, 'failed')
    assert.equal(interruptedLedger.failure_kind, 'test_checkpoint_interrupted')
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ? AND is_test = 1',
      [contactId]
    )).total), 1, 'el checkpoint interrumpido se limpia después; nunca crea una segunda cita')

    const repeatedInterruptedCheckpoint = await recordConversationalAgentPreviewEffects({
      runContext: third.runContext,
      actions: third.result.actions
    })
    assert.equal(repeatedInterruptedCheckpoint[0].status, 'failed')
    assert.equal(repeatedInterruptedCheckpoint[0].code, 'test_appointment_checkpoint_interrupted')
    assert.equal(repeatedInterruptedCheckpoint[0].retryable, false)
    const repeatedInterruptedVisible = reconcileConversationalAgentPreviewResult({
      result: third.result,
      testEffects: repeatedInterruptedCheckpoint
    })
    assert.equal(repeatedInterruptedVisible.reply, interruptedVisible.reply)
    assert.doesNotMatch(repeatedInterruptedVisible.reply, /horario ya no está disponible|conservé el día/i)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ? AND is_test = 1',
      [contactId]
    )).total), 1, 'repetir el mismo sí conserva el error durable y no abre otra cita')

    // El primer fallo de mirror trae el código específico del proveedor y el
    // replay trae el código canónico. Ambos deben normalizarse desde el ledger
    // durable a la misma respuesta visible de cleanup.
    await db.run(
      `UPDATE appointment_creation_requests
       SET status = 'failed', processing_token = NULL, error_status = 502,
           error_retryable = 0, failure_kind = 'test_provider_sync_failed',
           error_message = 'Google no confirmó el espejo de la cita temporal.',
           updated_at = CURRENT_TIMESTAMP
       WHERE client_request_id = ?`,
      [`conv-test:${materialized[0].id}`]
    )
    // Cada bloque simula una ventana de caída independiente. Reabre sólo el
    // efecto de prueba como recuperable para que el siguiente controller lea
    // el nuevo fallo durable; un fallo terminal real no se reabre por sí solo.
    await db.run(
      `UPDATE conversational_agent_test_effects
       SET status = 'failed', error_code = 'test_appointment_creation_failed',
           error_retryable = 1, last_error = 'ventana de provider simulada',
           claim_token = NULL, lease_until_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [materialized[0].id]
    )
    forceOriginalProviderFailure = true
    const firstProviderFailure = await recordConversationalAgentPreviewEffects({
      runContext: third.runContext,
      actions: third.result.actions
    })
    assert.equal(firstProviderFailure[0].status, 'failed')
    assert.equal(firstProviderFailure[0].code, 'test_appointment_provider_sync_failed')
    assert.equal(firstProviderFailure[0].retryable, false)
    const firstProviderVisible = reconcileConversationalAgentPreviewResult({
      result: third.result,
      testEffects: firstProviderFailure
    })
    assert.match(firstProviderVisible.reply, /proveedor externo no confirmó/i)
    assert.match(firstProviderVisible.reply, /retirará automáticamente/i)
    assert.doesNotMatch(firstProviderVisible.reply, /vuelve a intentarlo|horario ya no está disponible/i)

    forceOriginalProviderFailure = false
    const replayedProviderFailure = await recordConversationalAgentPreviewEffects({
      runContext: third.runContext,
      actions: third.result.actions
    })
    assert.equal(replayedProviderFailure[0].status, 'failed')
    assert.equal(replayedProviderFailure[0].code, 'test_appointment_provider_sync_failed')
    assert.equal(replayedProviderFailure[0].retryable, false)
    const replayedProviderVisible = reconcileConversationalAgentPreviewResult({
      result: third.result,
      testEffects: replayedProviderFailure
    })
    assert.equal(replayedProviderVisible.reply, firstProviderVisible.reply)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ? AND is_test = 1',
      [contactId]
    )).total), 1, 'el fallo durable de provider no abre otra cita en ningún retry')
  } finally {
    setConversationalAgentTestServiceDependenciesForTests(null)
    const effectRows = await db.all(
      'SELECT id FROM conversational_agent_test_effects WHERE run_id = ?',
      [runId]
    ).catch(() => [])
    for (const effect of effectRows || []) {
      await db.run(
        'DELETE FROM appointment_creation_requests WHERE client_request_id = ?',
        [`conv-test:${effect.id}`]
      ).catch(() => {})
    }
    await db.run(
      `DELETE FROM internal_notifications
       WHERE category = 'conversational_agent_test' AND contact_id = ?`,
      [contactId]
    ).catch(() => {})
    await db.run('DELETE FROM conversational_agent_test_effects WHERE run_id = ?', [runId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_test_runs WHERE id = ?', [runId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE agent_id = ?', [agentId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
    if (previousGoogleConfig) {
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET
          config_value = excluded.config_value,
          updated_at = CURRENT_TIMESTAMP
      `, [googleConfigKey, previousGoogleConfig.config_value]).catch(() => {})
    } else {
      await db.run('DELETE FROM app_config WHERE config_key = ?', [googleConfigKey]).catch(() => {})
    }
  }
})

test('dos previews del mismo contacto serializan el slot: gana uno y el otro conserva el día para elegir otra hora', async () => {
  const suffix = randomUUID()
  const agentId = `agent_preview_slot_race_${suffix}`
  const contactId = `contact_preview_slot_race_${suffix}`
  const calendarId = `calendar_preview_slot_race_${suffix}`
  const requestedByUserId = `user_preview_slot_race_${suffix}`
  const runAId = `session_preview_slot_race_a_${suffix}`
  const runBId = `session_preview_slot_race_b_${suffix}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 21 }).startOf('day')
  const monday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const slotA = monday.set({ hour: 10, minute: 0, second: 0, millisecond: 0 })
  const slotB = slotA.plus({ hours: 1 })
  const localDate = slotA.toFormat('yyyy-MM-dd')
  const capabilitiesConfig = {
    schemaVersion: 3,
    items: [{
      id: 'schedule_appointment',
      enabled: true,
      calendarId,
      allowOverlaps: false,
      bookingOwner: 'ai',
      testMode: { enabled: true, cleanupAfterMinutes: 5, notify: false }
    }]
  }
  const config = {
    id: agentId,
    runtimeMode: 'tool_calling_v2',
    capabilitiesConfig
  }
  const effects = {
    enabled: true,
    scheduleAppointment: true,
    collectPayment: false,
    assignUser: false,
    notifyOwner: false
  }
  const acceptInput = {
    decision: 'accept',
    nextPreferenceScope: null,
    reply: null,
    title: 'Consulta de prueba',
    notes: null,
    attendeeName: null,
    attendeeContext: null,
    primaryAttendee: null,
    guests: [],
    agreedAmount: null
  }

  const toolNamed = (ctx, name) => {
    const found = createConversationalTools(ctx).find((item) => item.name === name)
    assert.ok(found, `Falta la herramienta ${name}`)
    return found
  }
  const prepareRun = (runId, testMessageId) => prepareConversationalAgentTestRun({
    testRunId: runId,
    testMessageId,
    agentId,
    requestedByUserId,
    contactId,
    effects
  })
  const previewScopeFor = (runId) => buildConversationalAppointmentPreviewScopeId({
    testSessionId: runId,
    requestedByUserId,
    agentId
  })
  const previewContext = ({ runContext, previewScopeId, messages }) => ({
    runtimeMode: 'tool_calling_v2',
    contactId,
    agentId,
    channel: 'whatsapp',
    dryRun: true,
    previewScopeId,
    executionId: runContext.executionId,
    virtualContact: runContext.contact,
    conversationMessages: messages,
    accountLocale: { currency: 'MXN' },
    actions: [],
    config
  })
  const offerForRun = async ({ runId, testMessageId, startTime, requestText }) => {
    const runContext = await prepareRun(runId, testMessageId)
    const previewScopeId = previewScopeFor(runId)
    const ctx = previewContext({
      runContext,
      previewScopeId,
      messages: [{ id: runContext.executionId, role: 'user', content: requestText }]
    })
    const offered = await toolNamed(ctx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime,
      appointmentId: null
    }))
    assert.equal(offered.ok, true, JSON.stringify(offered))
    assert.equal(offered.simulated, true)
    return { runContext, previewScopeId, ctx, offered, requestText }
  }
  const confirmOffer = async ({ runId, testMessageId, offer, confirmationText = 'Sí, apártalo.' }) => {
    const runContext = await prepareRun(runId, testMessageId)
    const ctx = previewContext({
      runContext,
      previewScopeId: offer.previewScopeId,
      messages: [
        { id: offer.runContext.executionId, role: 'user', content: offer.requestText },
        { id: `assistant_${testMessageId}`, role: 'assistant', content: offer.offered.visibleReply },
        { id: runContext.executionId, role: 'user', content: confirmationText }
      ]
    })
    ctx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({ ctx, config })
    ctx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({ ctx, config })
    assert.equal(ctx.appointmentOfferDecision?.active, true)
    const result = await toolNamed(ctx, 'resolve_active_appointment_offer')
      .invoke(null, JSON.stringify(acceptInput))
    return { runContext, ctx, result }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
       VALUES (?, 'Contacto carrera entre previews', '+526560009999', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await upsertLocalCalendar({
      id: calendarId,
      locationId: `location_preview_slot_race_${suffix}`,
      name: 'Agenda carrera entre previews',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      appointmentLimit: 1,
      allowBookingFor: 365,
      allowBookingForUnit: 'days',
      openHours: [{
        daysOfTheWeek: [1],
        hours: [{ openHour: 10, openMinute: 0, closeHour: 13, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced', allowGoogleSyncMetadata: true })
    await db.run(
      `INSERT INTO conversational_agents (id, name, enabled, runtime_mode, capabilities_config)
       VALUES (?, 'Agente carrera entre previews', 1, 'tool_calling_v2', ?)`,
      [agentId, JSON.stringify(capabilitiesConfig)]
    )

    const offeredA = await offerForRun({
      runId: runAId,
      testMessageId: `message_offer_a_${suffix}`,
      startTime: slotA.toUTC().toISO(),
      requestText: 'Quiero el lunes a las diez.'
    })
    const offeredB = await offerForRun({
      runId: runBId,
      testMessageId: `message_offer_b_${suffix}`,
      startTime: slotA.toUTC().toISO(),
      requestText: 'Quiero el lunes a las diez.'
    })
    assert.notEqual(offeredA.previewScopeId, offeredB.previewScopeId)

    // Las dos conversaciones aceptan antes de que ninguna materialice. Ésta es
    // la carrera real: ambos previews redactaron éxito provisional, pero sólo
    // el resultado del efecto bajo candado puede autorizar la respuesta final.
    const confirmedB = await confirmOffer({
      runId: runBId,
      testMessageId: `message_confirm_b_${suffix}`,
      offer: offeredB
    })
    assert.equal(confirmedB.result.ok, true, JSON.stringify(confirmedB.result))
    const confirmedAInitial = await confirmOffer({
      runId: runAId,
      testMessageId: `message_confirm_a_racing_${suffix}`,
      offer: offeredA
    })
    assert.equal(confirmedAInitial.result.ok, true, JSON.stringify(confirmedAInitial.result))

    const raced = await Promise.all([
      { key: 'a', runId: runAId, offer: offeredA, confirmed: confirmedAInitial },
      { key: 'b', runId: runBId, offer: offeredB, confirmed: confirmedB }
    ].map(async (entry) => {
      const testEffects = await recordConversationalAgentPreviewEffects({
        runContext: entry.confirmed.runContext,
        actions: entry.confirmed.ctx.actions
      })
      return {
        ...entry,
        testEffects,
        visible: reconcileConversationalAgentPreviewResult({
          result: {
            reply: entry.confirmed.result.visibleReply,
            replyParts: [entry.confirmed.result.visibleReply],
            replyPartDelaysMs: [0],
            actions: entry.confirmed.ctx.actions
          },
          testEffects
        })
      }
    }))
    const winner = raced.find((entry) => entry.testEffects[0]?.status === 'recorded')
    const loser = raced.find((entry) => entry.testEffects[0]?.status === 'failed')
    const raceEffectSummary = raced.map((entry) => ({
      key: entry.key,
      effects: entry.testEffects.map((effect) => ({ status: effect.status, code: effect.code }))
    }))
    assert.ok(winner, JSON.stringify(raceEffectSummary))
    assert.ok(loser, JSON.stringify(raceEffectSummary))
    assert.notEqual(winner.key, loser.key)
    assert.equal(winner.testEffects.length, 1)
    assert.equal(winner.testEffects[0].payload.startTime, slotA.toUTC().toISO())
    assert.match(winner.visible.reply, /cita de prueba quedó confirmada/i)
    const winnerOfferRow = await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [buildConversationalAppointmentPreviewOfferEventId(winner.offer.previewScopeId)]
    )
    assert.equal(JSON.parse(winnerOfferRow.detail_json).status, 'materialized')
    assert.equal(loser.testEffects.length, 1)
    assert.equal(loser.testEffects[0].code, 'test_slot_no_longer_free')
    assert.equal(loser.testEffects[0].retryable, false)
    assert.equal(loser.testEffects[0].appointmentDateRestored, true, JSON.stringify(loser.testEffects[0]))
    assert.match(loser.visible.reply, /horario ya no está disponible/i)
    assert.match(loser.visible.reply, /conservé el día/i)
    assert.doesNotMatch(loser.visible.reply, /confirmada|equipo lo revise|revisión humana/i)
    const failedAction = loser.visible.actions.find((action) => action.type === 'book_appointment')
    assert.equal(failedAction?.outcome?.status, 'error')
    assert.equal(failedAction?.outcome?.materialized, false)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_test_effects
       WHERE run_id IN (?, ?) AND status = 'failed'`,
      [runAId, runBId]
    )).total), 1)
    const replayedLoserEffects = await recordConversationalAgentPreviewEffects({
      runContext: loser.confirmed.runContext,
      actions: loser.confirmed.ctx.actions
    })
    assert.ok(replayedLoserEffects[0]?.id)
    assert.equal(replayedLoserEffects[0]?.code, 'test_slot_no_longer_free')
    assert.equal(replayedLoserEffects[0]?.appointmentDateRestored, true)
    assert.equal(Number((await db.get(
      'SELECT attempt_count FROM conversational_agent_test_effects WHERE id = ?',
      [replayedLoserEffects[0].id]
    )).attempt_count), 1, 'el fallo terminal de disponibilidad no vuelve a materializarse')

    const alternateRun = await prepareRun(loser.runId, `message_offer_loser_alternate_${suffix}`)
    const alternateCtx = previewContext({
      runContext: alternateRun,
      previewScopeId: loser.offer.previewScopeId,
      messages: [{ id: alternateRun.executionId, role: 'user', content: 'Entonces a las once.' }]
    })
    alternateCtx.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({
      ctx: alternateCtx,
      config
    })
    alternateCtx.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({
      ctx: alternateCtx,
      config
    })
    assert.equal(alternateCtx.appointmentOfferDecision, null)
    assert.equal(alternateCtx.appointmentSelectionProgress?.selectedDate, localDate)
    const availability = await toolNamed(alternateCtx, 'get_free_slots').invoke(null, JSON.stringify({
      startDate: localDate,
      endDate: localDate,
      appointmentId: null,
      weekdays: null,
      earliestLocalTime: '11:00',
      latestLocalTime: '11:00',
      relativeToPreviousOffer: null,
      progressDateAction: 'keep_selected_date'
    }))
    assert.equal(availability.ok, true, JSON.stringify(availability))
    assert.equal(availability.total, 1, JSON.stringify(availability))
    assert.equal(availability.slots[0].options[0].startTime, slotB.toUTC().toISO())
    const alternateOffered = await toolNamed(alternateCtx, 'offer_appointment_slot').invoke(null, JSON.stringify({
      startTime: availability.slots[0].options[0].startTime,
      appointmentId: null
    }))
    assert.equal(alternateOffered.ok, true, JSON.stringify(alternateOffered))

    const confirmedLoser = await confirmOffer({
      runId: loser.runId,
      testMessageId: `message_confirm_loser_alternate_${suffix}`,
      offer: {
        runContext: alternateRun,
        previewScopeId: loser.offer.previewScopeId,
        offered: alternateOffered,
        requestText: 'Entonces a las once.'
      },
      confirmationText: 'Sí, ése.'
    })
    assert.equal(confirmedLoser.result.ok, true, JSON.stringify(confirmedLoser.result))
    const alternateEffects = await recordConversationalAgentPreviewEffects({
      runContext: confirmedLoser.runContext,
      actions: confirmedLoser.ctx.actions
    })
    assert.equal(alternateEffects.length, 1, JSON.stringify(alternateEffects))
    assert.equal(alternateEffects[0].status, 'recorded')
    assert.equal(alternateEffects[0].payload.startTime, slotB.toUTC().toISO())
    const alternateProgressRows = await db.all(
      `SELECT detail_json FROM conversational_agent_events
       WHERE agent_id = ? AND contact_id = ? AND event_type = 'appointment_selection_progress'`,
      [agentId, contactId]
    )
    const alternateProgress = alternateProgressRows
      .map((row) => JSON.parse(row.detail_json))
      .find((detail) => detail.previewScopeId === loser.offer.previewScopeId)
    assert.equal(alternateProgress?.appointmentStatus, 'materialized')
    assert.deepEqual(alternateProgress?.missingFields, [])
    assert.equal(alternateProgress?.selectedStartTime, slotB.toUTC().toISO())

    const appointments = await db.all(
      `SELECT id, start_time FROM appointments
       WHERE calendar_id = ? AND contact_id = ? AND deleted_at IS NULL
       ORDER BY start_time`,
      [calendarId, contactId]
    )
    assert.equal(appointments.length, 2)
    assert.deepEqual(
      appointments.map((appointment) => new Date(appointment.start_time).toISOString()),
      [slotA.toUTC().toISO(), slotB.toUTC().toISO()]
    )
    const replayAlternate = await recordConversationalAgentPreviewEffects({
      runContext: confirmedLoser.runContext,
      actions: confirmedLoser.ctx.actions
    })
    assert.equal(replayAlternate[0].id, alternateEffects[0].id)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND contact_id = ? AND deleted_at IS NULL',
      [calendarId, contactId]
    )).total), 2, 'el retry no puede duplicar ninguna de las dos citas')
  } finally {
    const effectRows = await db.all(
      'SELECT id FROM conversational_agent_test_effects WHERE run_id IN (?, ?)',
      [runAId, runBId]
    ).catch(() => [])
    for (const effect of effectRows || []) {
      await db.run(
        'DELETE FROM appointment_creation_requests WHERE client_request_id = ?',
        [`conv-test:${effect.id}`]
      ).catch(() => {})
    }
    await db.run(
      `DELETE FROM internal_notifications
       WHERE category = 'conversational_agent_test' AND contact_id = ?`,
      [contactId]
    ).catch(() => {})
    await db.run('DELETE FROM conversational_agent_test_effects WHERE run_id IN (?, ?)', [runAId, runBId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_test_runs WHERE id IN (?, ?)', [runAId, runBId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE agent_id = ?', [agentId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('ofertas preview vencidas se limpian por TTL y nunca aparecen en la bitácora visible', async () => {
  const suffix = randomUUID()
  const agentId = `agent_preview_ttl_${suffix}`
  const contactId = `contact_preview_ttl_${suffix}`
  const scopeId = buildConversationalAppointmentPreviewScopeId({
    testSessionId: `session_${suffix}`,
    requestedByUserId: `user_${suffix}`,
    agentId
  })
  const eventId = buildConversationalAppointmentPreviewOfferEventId(scopeId)
  try {
    const metricsBefore = await getConversationalAgentMetrics()
    await db.run(
      `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        eventId,
        contactId,
        agentId,
        CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT,
        JSON.stringify({ previewScopeId: scopeId, status: 'active', expiresAt: '2000-01-01T00:00:00.000Z' })
      ]
    )
    assert.deepEqual(await listConversationalAgentEvents({ contactId }), [])
    const metricsAfter = await getConversationalAgentMetrics()
    assert.equal(metricsAfter.totalEvents, metricsBefore.totalEvents)
    const result = await cleanupExpiredConversationalAppointmentPreviewOffers({ now: new Date(), limit: 20 })
    assert.ok(result.deleted >= 1)
    assert.equal(await db.get('SELECT id FROM conversational_agent_events WHERE id = ?', [eventId]), null)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE id = ?', [eventId]).catch(() => undefined)
  }
})

test('normaliza efectos sólo cuando hay una acción explícita y no activa notificaciones por omisión', () => {
  assert.deepEqual(normalizeConversationalAgentTestEffects({ enabled: true }), {
    enabled: false,
    scheduleAppointment: false,
    collectPayment: false,
    assignUser: false,
    notifyOwner: false
  })
  assert.deepEqual(normalizeConversationalAgentTestEffects({
    enabled: true,
    scheduleAppointment: true,
    notifyOwner: true
  }), {
    enabled: true,
    scheduleAppointment: true,
    collectPayment: false,
    assignUser: false,
    notifyOwner: true
  })
})

test('Modo test resuelve, reutiliza y reactiva test@aiagent.com sin selección del frontend', async () => {
  const suffix = randomUUID()
  const agentId = `agent_default_test_contact_${suffix}`
  const runId = `session_default_test_contact_${suffix}`
  const requestedByUserId = `user_default_test_contact_${suffix}`

  try {
    const concurrentContacts = await Promise.all(
      Array.from({ length: 4 }, () => resolveConversationalAgentTestContact())
    )
    const contactIds = new Set(concurrentContacts.map((contact) => contact?.id))
    assert.equal(contactIds.size, 1)
    assert.equal(concurrentContacts[0]?.email, CONVERSATIONAL_AGENT_TEST_CONTACT_EMAIL)

    const defaultContactId = concurrentContacts[0].id
    await db.run(
      'UPDATE contacts SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?',
      [defaultContactId]
    )
    const restoredContact = await resolveConversationalAgentTestContact()
    assert.equal(restoredContact.id, defaultContactId)
    assert.equal(restoredContact.deleted_at, null)

    await db.run(
      `INSERT INTO conversational_agents (id, name, enabled, runtime_mode, capabilities_config)
       VALUES (?, 'Agente con contacto técnico automático', 1, 'tool_calling_v2', ?)`,
      [agentId, JSON.stringify({
        schemaVersion: 3,
        items: [{
          id: 'schedule_appointment',
          enabled: true,
          calendarId: `calendar_default_test_contact_${suffix}`,
          bookingOwner: 'human',
          testMode: { enabled: true, cleanupAfterMinutes: 5, notify: false }
        }]
      })]
    )

    const run = await prepareConversationalAgentTestRun({
      testRunId: runId,
      testMessageId: `message_default_test_contact_${suffix}`,
      agentId,
      requestedByUserId,
      effects: {
        enabled: true,
        scheduleAppointment: true,
        notifyOwner: false
      }
    })

    assert.equal(run.contact.id, defaultContactId)
    assert.equal(run.contact.email, CONVERSATIONAL_AGENT_TEST_CONTACT_EMAIL)
    assert.equal(
      (await db.get('SELECT contact_id FROM conversational_agent_test_runs WHERE id = ?', [runId])).contact_id,
      defaultContactId
    )
  } finally {
    await db.run('DELETE FROM conversational_agent_test_effects WHERE run_id = ?', [runId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_test_turns WHERE run_id = ?', [runId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_test_runs WHERE id = ?', [runId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => undefined)
  }
})

test('agenda humana sin persona asignada abre una corrida durable de cita y notificación sin exigir assignUser', async () => {
  const suffix = randomUUID()
  const agentId = `agent_human_team_test_${suffix}`
  const contactId = `contact_human_team_test_${suffix}`
  const runId = `session_human_team_test_${suffix}`
  const requestedByUserId = `user_human_team_test_${suffix}`
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto agenda humana sin asignar', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO conversational_agents (id, name, enabled, runtime_mode, capabilities_config)
       VALUES (?, 'Agente agenda humana sin asignar', 1, 'tool_calling_v2', ?)`,
      [agentId, JSON.stringify({
        schemaVersion: 3,
        items: [{
          id: 'schedule_appointment',
          enabled: true,
          calendarId: `calendar_human_team_test_${suffix}`,
          bookingOwner: 'human',
          handoffUserId: '',
          handoffUserName: '',
          testMode: { enabled: true, cleanupAfterMinutes: 5, notify: true }
        }]
      })]
    )

    const run = await prepareConversationalAgentTestRun({
      testRunId: runId,
      testMessageId: `message_human_team_test_${suffix}`,
      agentId,
      requestedByUserId,
      contactId,
      effects: {
        enabled: true,
        scheduleAppointment: true,
        notifyOwner: true
      }
    })

    assert.equal(run.id, runId)
    assert.equal(run.effects.enabled, true)
    assert.equal(run.effects.scheduleAppointment, true)
    assert.equal(run.effects.assignUser, false)
    assert.equal(run.effects.notifyOwner, true)
    const stored = await db.get(
      'SELECT effects_json, status FROM conversational_agent_test_runs WHERE id = ?',
      [runId]
    )
    assert.equal(stored.status, 'active')
    assert.deepEqual(
      {
        scheduleAppointment: JSON.parse(stored.effects_json).scheduleAppointment,
        assignUser: JSON.parse(stored.effects_json).assignUser,
        notifyOwner: JSON.parse(stored.effects_json).notifyOwner
      },
      { scheduleAppointment: true, assignUser: false, notifyOwner: true }
    )
  } finally {
    await db.run('DELETE FROM conversational_agent_test_effects WHERE run_id = ?', [runId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_test_runs WHERE id = ?', [runId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('historial de pruebas recientes queda limitado al agente y usuario solicitante', async () => {
  const suffix = randomUUID()
  const agentId = `agent_test_history_${suffix}`
  const contactId = `contact_test_history_${suffix}`
  const runId = `session_test_history_${suffix}`
  const username = `tester_history_${suffix}`
  let userId = ''
  try {
    await db.run(
      `INSERT INTO users (username, password_hash, full_name, is_active, created_at, updated_at)
       VALUES (?, 'test-hash', 'Tester historial', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [username]
    )
    userId = String((await db.get('SELECT id FROM users WHERE username = ?', [username]))?.id || '')
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto historial', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO conversational_agents (id, name, enabled, runtime_mode, capabilities_config)
       VALUES (?, 'Agente historial', 0, 'tool_calling_v2', '{}')`,
      [agentId]
    )
    await db.run(
      `INSERT INTO conversational_agent_test_runs (
         id, agent_id, requested_by_user_id, contact_id, effects_json, status, expires_at
       ) VALUES (?, ?, ?, ?, '{}', 'active', ?)`,
      [runId, agentId, userId, contactId, new Date(Date.now() + 60_000).toISOString()]
    )
    await db.run(
      `INSERT INTO conversational_agent_test_effects (
         id, run_id, message_id, effect_type, request_hash, status, payload_json, created_at, updated_at
       ) VALUES (?, ?, ?, 'appointment', 'history-hash', 'recorded', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [`catfx_history_${suffix}`, runId, `message_history_${suffix}`, JSON.stringify({ summary: 'Cita de prueba creada.' })]
    )
    const previewScopeId = buildConversationalAppointmentPreviewScopeId({
      testSessionId: runId,
      requestedByUserId: userId,
      agentId
    })
    const previewOfferEventId = buildConversationalAppointmentPreviewOfferEventId(previewScopeId)
    await db.run(
      `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        previewOfferEventId,
        contactId,
        agentId,
        CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT,
        JSON.stringify({ previewScopeId, status: 'active', expiresAt: new Date(Date.now() + 60_000).toISOString() })
      ]
    )

    const ownHistory = await listRecentConversationalAgentTestRuns({ agentId, requestedByUserId: userId, limit: 5 })
    assert.equal(ownHistory.length, 1)
    assert.equal(ownHistory[0].id, runId)
    assert.equal(ownHistory[0].effects.length, 1)
    assert.equal(ownHistory[0].effects[0].status, 'recorded')
    assert.deepEqual(
      await listRecentConversationalAgentTestRuns({ agentId, requestedByUserId: `${userId}-otro`, limit: 5 }),
      []
    )

    // Si un proceso murió después de marcar la corrida como `cleaning`, otro
    // proceso debe poder retomarla bajo el mismo candado y cerrarla; no puede
    // quedar una prueba zombi imposible de limpiar.
    await db.run(
      "UPDATE conversational_agent_test_runs SET status = 'cleaning' WHERE id = ?",
      [runId]
    )
    const recoveredCleanup = await cleanupConversationalAgentTestRun({
      testRunId: runId,
      requestedByUserId: userId
    })
    assert.equal(recoveredCleanup.cleaned, true)
    assert.equal(
      (await db.get('SELECT status FROM conversational_agent_test_runs WHERE id = ?', [runId])).status,
      'cleaned'
    )
    assert.equal(await db.get('SELECT id FROM conversational_agent_events WHERE id = ?', [previewOfferEventId]), null)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE agent_id = ?', [agentId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_test_effects WHERE run_id = ?', [runId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_test_runs WHERE id = ?', [runId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => undefined)
  }
})

test('controller exige permisos por módulo antes de tocar contacto, agenda o proveedor', async () => {
  const req = {
    body: {
      effects: { enabled: true, scheduleAppointment: true, notifyOwner: true },
      agentId: `agent_${randomUUID()}`,
      contactId: `contact_${randomUUID()}`,
      testSessionId: `session_${randomUUID()}`,
      testMessageId: `message_${randomUUID()}`
    },
    user: {
      userId: 'employee-no-appointments',
      role: 'employee',
      access_config: JSON.stringify({ ai_agent: 'write', contacts: 'read', appointments: 'none' })
    }
  }
  const res = mockResponse()
  await testAgentController(req, res)
  assert.equal(res.statusCode, 403)
  assert.equal(res.body?.code, 'test_appointments_write_required')
})

test('el modo con efectos conserva texto editable pero ignora capacidades maliciosas del cliente', () => {
  const persisted = {
    id: 'agent-persisted',
    capabilitiesConfig: {
      schemaVersion: 1,
      items: [{ id: 'collect_payment', enabled: true, productId: 'product-real', priceId: 'price-real' }]
    },
    defaultCalendarId: 'calendar-real',
    goalWorkflow: { mode: 'persisted' }
  }
  const locked = lockConversationalTesterConfigOverride({
    promptConfig: { strategyText: 'texto todavía editable' },
    capabilitiesConfig: {
      items: [{ id: 'collect_payment', enabled: true, productId: 'product-fake', priceId: 'price-fake' }]
    },
    defaultCalendarId: 'calendar-fake',
    goalWorkflow: { mode: 'fake' }
  }, persisted)

  assert.equal(locked.promptConfig.strategyText, 'texto todavía editable')
  assert.deepEqual(locked.capabilitiesConfig, persisted.capabilitiesConfig)
  assert.equal(locked.defaultCalendarId, 'calendar-real')
  assert.deepEqual(locked.goalWorkflow, { mode: 'persisted' })
  assert.equal(locked.id, 'agent-persisted')
})

test('apagar Modo test durante la respuesta del modelo revoca el run antes de cualquier mutación', async () => {
  const suffix = randomUUID()
  const agentId = `agent_test_revoke_${suffix}`
  const contactId = `contact_test_revoke_${suffix}`
  const username = `tester_revoke_${suffix}`
  const runId = `session_revoke_${suffix}`
  let userId = ''
  const capabilitiesConfig = {
    schemaVersion: 2,
    testMode: { enabled: true, cleanupAfterMinutes: 5, notify: true },
    items: [{ id: 'schedule_appointment', enabled: true, calendarId: `calendar_${suffix}`, bookingOwner: 'ai', allowOverlaps: false }]
  }
  try {
    await db.run(
      `INSERT INTO users (username, password_hash, full_name, is_active, created_at, updated_at)
       VALUES (?, 'test-hash', 'Tester revocación', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [username]
    )
    userId = String((await db.get('SELECT id FROM users WHERE username = ?', [username]))?.id || '')
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto revocación', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO conversational_agents (id, name, enabled, runtime_mode, capabilities_config)
       VALUES (?, 'Agente revocación', 1, 'tool_calling_v2', ?)`,
      [agentId, JSON.stringify(capabilitiesConfig)]
    )
    await prepareConversationalAgentTestRun({
      testRunId: runId,
      testMessageId: `message_revoke_${suffix}`,
      agentId,
      requestedByUserId: userId,
      contactId,
      effects: { enabled: true, scheduleAppointment: true }
    })

    await db.run(
      'UPDATE conversational_agents SET capabilities_config = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [JSON.stringify({ ...capabilitiesConfig, testMode: { ...capabilitiesConfig.testMode, enabled: false } }), agentId]
    )

    await assert.rejects(
      beginConversationalAgentTestEffect({
        testRunId: runId,
        testMessageId: `message_revoke_${suffix}`,
        requestedByUserId: userId,
        effectType: 'appointment',
        request: { calendarId: `calendar_${suffix}`, startTime: '2026-08-01T18:00:00.000Z' }
      }),
      (error) => error?.code === 'test_run_config_revoked'
    )
    assert.equal((await db.get('SELECT status FROM conversational_agent_test_runs WHERE id = ?', [runId])).status, 'revoked')
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM conversational_agent_test_effects WHERE run_id = ?', [runId])).total), 0)
  } finally {
    await db.run('DELETE FROM conversational_agent_test_effects WHERE run_id = ?', [runId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_test_runs WHERE id = ?', [runId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => undefined)
  }
})

test('cada efecto exige su propio switch y transferencia nunca abre un checkout sandbox', async () => {
  const suffix = randomUUID()
  const agentId = `agent_test_scoped_${suffix}`
  const contactId = `contact_test_scoped_${suffix}`
  const requestedByUserId = `user_test_scoped_${suffix}`
  const currency = await getAccountCurrency()
  const basePayment = {
    id: 'collect_payment',
    enabled: true,
    collectionMethod: 'payment_link',
    chargeType: 'direct',
    direct: { amount: 1200, currency, concept: 'Consulta' },
    testMode: { enabled: false, notify: true }
  }
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto switches independientes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO conversational_agents (id, name, enabled, runtime_mode, capabilities_config)
       VALUES (?, 'Agente switches independientes', 1, 'tool_calling_v2', ?)`,
      [agentId, JSON.stringify({
        schemaVersion: 2,
        testMode: { enabled: true },
        items: [
          {
            id: 'schedule_appointment',
            enabled: true,
            calendarId: `calendar_${suffix}`,
            bookingOwner: 'ai',
            testMode: { enabled: true, notify: true }
          },
          basePayment
        ]
      })]
    )

    await assert.rejects(
      prepareConversationalAgentTestRun({
        testRunId: `session_scope_off_${suffix}`,
        testMessageId: `message_scope_off_${suffix}`,
        agentId,
        requestedByUserId,
        contactId,
        effects: { enabled: true, collectPayment: true }
      }),
      (error) => error?.code === 'test_payment_mode_not_enabled'
    )

    await db.run(
      'UPDATE conversational_agents SET capabilities_config = ? WHERE id = ?',
      [JSON.stringify({
        schemaVersion: 3,
        items: [
          {
            id: 'schedule_appointment',
            enabled: true,
            calendarId: `calendar_${suffix}`,
            bookingOwner: 'ai',
            testMode: { enabled: true, notify: true }
          },
          {
            id: 'handoff_human',
            enabled: true,
            userId: `user_handoff_${suffix}`
          }
        ]
      }), agentId]
    )
    await assert.rejects(
      prepareConversationalAgentTestRun({
        testRunId: `session_assignment_scope_${suffix}`,
        testMessageId: `message_assignment_scope_${suffix}`,
        agentId,
        requestedByUserId,
        contactId,
        effects: { enabled: true, assignUser: true }
      }),
      (error) => error?.code === 'test_assignment_user_required'
    )

    await db.run(
      'UPDATE conversational_agents SET capabilities_config = ? WHERE id = ?',
      [JSON.stringify({
        schemaVersion: 2,
        items: [{
          ...basePayment,
          collectionMethod: 'bank_transfer',
          bankTransfer: { details: 'Banco de prueba · cuenta 1234' },
          testMode: { enabled: true, notify: true }
        }]
      }), agentId]
    )
    const transferRunId = `session_transfer_${suffix}`
    const transferRun = await prepareConversationalAgentTestRun({
      testRunId: transferRunId,
      testMessageId: `message_transfer_${suffix}`,
      agentId,
      requestedByUserId,
      contactId,
      effects: { enabled: true, collectPayment: true }
    })
    const transferEffects = await recordConversationalAgentPreviewEffects({
      runContext: transferRun,
      actions: [{
        type: 'register_deposit_payment_proof',
        amount: 1200,
        currency,
        paymentPurpose: 'purchase',
        afterPayment: 'continue',
        outcome: {
          status: 'simulated',
          expectedAmount: 1200,
          expectedCurrency: currency,
          wouldRegisterPendingReview: true,
          paymentConfirmed: false,
          manualReviewRequired: true,
          analysis: {
            ok: true,
            isPaymentReceipt: true,
            amount: 1200,
            currency,
            bank: 'Banco de prueba',
            reference: 'REF-TEST',
            confidence: 0.98
          }
        }
      }]
    })
    assert.equal(transferEffects.length, 1)
    assert.equal(transferEffects[0].status, 'recorded')
    assert.equal(transferEffects[0].payload.collectionMethod, 'bank_transfer')
    assert.equal(transferEffects[0].payload.paymentCreated, false)
    assert.equal(transferEffects[0].payload.paymentConfirmed, false)
    assert.equal(transferEffects[0].payload.manualReviewRequired, true)
    assert.equal(transferEffects[0].payload.receiptMatchesConfiguredPayment, true)
    assert.match(transferEffects[0].summary, /pendiente de revisión/i)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM conversational_agent_test_payment_links WHERE test_run_id = ?',
      [transferRunId]
    )).total), 0)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM payments WHERE contact_id = ?',
      [contactId]
    )).total), 0)

    const cleaned = await cleanupConversationalAgentTestRun({
      testRunId: transferRunId,
      requestedByUserId
    })
    assert.equal(cleaned.cleaned, true)
    assert.equal(cleaned.effects[0].status, 'cleaned')

    await db.run(
      'UPDATE conversational_agents SET capabilities_config = ? WHERE id = ?',
      [JSON.stringify({
        schemaVersion: 3,
        items: [{
          id: 'collect_payment',
          enabled: true,
          collectionMethod: 'bank_transfer',
          paymentMode: 'deposit',
          chargeType: 'deposit',
          bankTransfer: { details: 'Banco de prueba · cuenta 1234' },
          deposit: {
            enabled: true,
            mode: 'range',
            minAmount: 200,
            maxAmount: 500,
            currency,
            methods: { paymentLink: false, bankTransfer: true }
          },
          receiptProof: { enabled: true },
          testMode: { enabled: true, notify: true }
        }]
      }), agentId]
    )
    const unreadableRunId = `session_transfer_unreadable_${suffix}`
    const unreadableRun = await prepareConversationalAgentTestRun({
      testRunId: unreadableRunId,
      testMessageId: `message_transfer_unreadable_${suffix}`,
      agentId,
      requestedByUserId,
      contactId,
      effects: { enabled: true, collectPayment: true }
    })
    const unreadableEffects = await recordConversationalAgentPreviewEffects({
      runContext: unreadableRun,
      actions: [{
        type: 'register_deposit_payment_proof',
        amount: null,
        currency,
        paymentPurpose: 'deposit',
        afterPayment: 'continue',
        outcome: {
          status: 'simulated',
          expectedMode: 'range',
          expectedAmount: null,
          expectedMinAmount: 200,
          expectedMaxAmount: 500,
          expectedCurrency: currency,
          wouldRegisterPendingReview: true,
          paymentConfirmed: false,
          manualReviewRequired: true,
          analysis: {
            ok: false,
            isPaymentReceipt: false,
            reason: 'analysis_failed'
          }
        }
      }]
    })
    assert.equal(unreadableEffects.length, 1)
    assert.equal(unreadableEffects[0].status, 'recorded')
    assert.equal(unreadableEffects[0].payload.amount, null)
    assert.equal(unreadableEffects[0].payload.expectedPayment.mode, 'range')
    assert.equal(unreadableEffects[0].payload.expectedPayment.minAmount, 200)
    assert.equal(unreadableEffects[0].payload.expectedPayment.maxAmount, 500)
    assert.equal(unreadableEffects[0].payload.receiptMatchesConfiguredPayment, false)
    assert.equal(unreadableEffects[0].payload.manualReviewRequired, true)
    assert.equal(unreadableEffects[0].payload.wouldRegisterPendingReview, true)
    assert.equal('amount' in unreadableEffects[0].payload.receiptAnalysis, false)
    assert.match(unreadableEffects[0].summary, /revisión humana/i)

    const unreadableCleaned = await cleanupConversationalAgentTestRun({
      testRunId: unreadableRunId,
      requestedByUserId
    })
    assert.equal(unreadableCleaned.cleaned, true)
    assert.equal(unreadableCleaned.effects[0].status, 'cleaned')

    const mismatchRunId = `session_transfer_mismatch_${suffix}`
    const mismatchRun = await prepareConversationalAgentTestRun({
      testRunId: mismatchRunId,
      testMessageId: `message_transfer_mismatch_${suffix}`,
      agentId,
      requestedByUserId,
      contactId,
      effects: { enabled: true, collectPayment: true }
    })
    const mismatchEffects = await recordConversationalAgentPreviewEffects({
      runContext: mismatchRun,
      actions: [{
        type: 'register_deposit_payment_proof',
        amount: null,
        currency,
        paymentPurpose: 'deposit',
        afterPayment: 'continue',
        outcome: {
          status: 'simulated',
          expectedMode: 'range',
          expectedAmount: null,
          expectedMinAmount: 200,
          expectedMaxAmount: 500,
          expectedCurrency: currency,
          wouldRegisterPendingReview: true,
          paymentConfirmed: false,
          manualReviewRequired: true,
          analysis: {
            ok: true,
            isPaymentReceipt: true,
            amount: 900,
            currency,
            reason: 'amount_mismatch'
          }
        }
      }]
    })
    assert.equal(mismatchEffects.length, 1)
    assert.equal(mismatchEffects[0].status, 'recorded')
    assert.equal(mismatchEffects[0].payload.amount, null)
    assert.equal(mismatchEffects[0].payload.receiptAnalysis.amount, 900)
    assert.equal(mismatchEffects[0].payload.receiptMatchesConfiguredPayment, false)
    assert.equal(mismatchEffects[0].payload.manualReviewRequired, true)
    assert.equal(mismatchEffects[0].payload.wouldRegisterPendingReview, true)

    const mismatchCleaned = await cleanupConversationalAgentTestRun({
      testRunId: mismatchRunId,
      requestedByUserId
    })
    assert.equal(mismatchCleaned.cleaned, true)
    assert.equal(mismatchCleaned.effects[0].status, 'cleaned')
  } finally {
    await db.run(
      'DELETE FROM internal_notifications WHERE category = ? AND contact_id = ?',
      ['conversational_agent_test', contactId]
    ).catch(() => undefined)
    await db.run(
      'DELETE FROM conversational_agent_test_effects WHERE run_id IN (SELECT id FROM conversational_agent_test_runs WHERE agent_id = ?)',
      [agentId]
    ).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_test_runs WHERE agent_id = ?', [agentId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('configuración y efecto externo comparten un candado durable por agente', async () => {
  const agentId = `agent_test_mutex_${randomUUID()}`
  const runId = `session_test_mutex_${randomUUID()}`
  let releaseEffect
  let effectPromise = null
  try {
    await db.run(
      `INSERT INTO conversational_agents (id, name, enabled, runtime_mode, capabilities_config)
       VALUES (?, 'Agente mutex', 0, 'tool_calling_v2', ?)`,
      [agentId, JSON.stringify({ schemaVersion: 2, testMode: { enabled: true }, items: [] })]
    )
    await db.run(
      `INSERT INTO conversational_agent_test_runs (
         id, agent_id, requested_by_user_id, effects_json, status, expires_at
       ) VALUES (?, ?, 'test-user', '{}', 'active', ?)`,
      [runId, agentId, new Date(Date.now() + 60_000).toISOString()]
    )
    let announceEffectLock
    const effectLockAcquired = new Promise((resolve) => { announceEffectLock = resolve })
    const releaseEffectLock = new Promise((resolve) => { releaseEffect = resolve })
    effectPromise = withConversationalAgentTestMutationLock({
      agentId,
      purpose: 'test_effect:simulated'
    }, async () => {
      announceEffectLock()
      await releaseEffectLock
      return 'effect-finished'
    })
    await effectLockAcquired

    assert.equal(
      await withConversationalAgentTestMutationLock({
        agentId: `${agentId}_different`,
        purpose: 'different_agent_can_continue'
      }, async () => 'parallel-agent'),
      'parallel-agent'
    )

    // Fuerza la carrera real: la actualización ocurre mientras otra conexión
    // conserva la exclusión física durante un efecto externo lento.
    await assert.rejects(
      updateConversationalAgent(agentId, {
        capabilitiesConfig: { schemaVersion: 2, testMode: { enabled: false }, items: [] }
      }),
      (error) => error?.code === 'test_mutation_lock_busy' && error?.statusCode === 409
    )
    assert.equal(
      JSON.parse((await db.get('SELECT capabilities_config FROM conversational_agents WHERE id = ?', [agentId])).capabilities_config).testMode.enabled,
      true
    )
    assert.equal(
      (await db.get('SELECT status FROM conversational_agent_test_runs WHERE id = ?', [runId])).status,
      'active'
    )
    await assert.rejects(
      cleanupConversationalAgentTestRun({
        testRunId: runId,
        requestedByUserId: 'test-user'
      }),
      (error) => error?.code === 'test_mutation_lock_busy' && error?.statusCode === 409
    )
    assert.equal(
      (await db.get('SELECT status FROM conversational_agent_test_runs WHERE id = ?', [runId])).status,
      'active'
    )

    releaseEffect()
    releaseEffect = null
    assert.equal(await effectPromise, 'effect-finished')
    effectPromise = null
    const updated = await updateConversationalAgent(agentId, {
      capabilitiesConfig: { schemaVersion: 2, testMode: { enabled: false }, items: [] }
    })
    assert.equal(updated.capabilitiesConfig.testMode.enabled, false)
    assert.equal(
      (await db.get('SELECT status FROM conversational_agent_test_runs WHERE id = ?', [runId])).status,
      'revoked'
    )

    // Los errores de la operación protegida no se tragan y tampoco dejan un
    // candado fantasma: la siguiente operación puede entrar inmediatamente.
    const sentinel = Object.assign(new Error('provider failed'), { code: 'PROVIDER_FAILED' })
    await assert.rejects(
      withConversationalAgentTestMutationLock({
        agentId,
        purpose: 'test_effect:failing'
      }, async () => { throw sentinel }),
      (error) => error === sentinel
    )
    assert.equal(
      await withConversationalAgentTestMutationLock({
        agentId,
        purpose: 'agent_capabilities_update:retry'
      }, async () => 'unlocked'),
      'unlocked'
    )
  } finally {
    if (releaseEffect) releaseEffect()
    if (effectPromise) await effectPromise.catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_test_runs WHERE id = ?', [runId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => undefined)
  }
})

test('si otra petición reemplaza el slot aceptado antes de materializarlo, no crea la cita ni pisa la oferta nueva', async () => {
  const suffix = randomUUID()
  const agentId = `agent_preview_offer_race_${suffix}`
  const contactId = `contact_preview_offer_race_${suffix}`
  const calendarId = `calendar_preview_offer_race_${suffix}`
  const runId = `session_preview_offer_race_${suffix}`
  const requestedByUserId = `user_preview_offer_race_${suffix}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 35 }).startOf('day')
  const slotA = baseDay.set({ hour: 14, minute: 0, second: 0, millisecond: 0 })
  const slotB = slotA.plus({ hours: 1 })
  const capabilitiesConfig = {
    schemaVersion: 2,
    testMode: { enabled: true, cleanupAfterMinutes: 5, notify: false },
    items: [
      { id: 'schedule_appointment', enabled: true, calendarId, bookingOwner: 'ai', allowOverlaps: false }
    ]
  }
  let providerCalls = 0

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto carrera preview', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await upsertLocalCalendar({
      id: calendarId,
      locationId: `location_preview_offer_race_${suffix}`,
      name: 'Agenda carrera preview',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      allowBookingFor: 365,
      allowBookingForUnit: 'days',
      openHours: [{
        daysOfTheWeek: [slotA.weekday],
        hours: [{ openHour: 13, openMinute: 0, closeHour: 17, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO conversational_agents (id, name, enabled, runtime_mode, capabilities_config)
       VALUES (?, 'Agente carrera preview', 1, 'tool_calling_v2', ?)`,
      [agentId, JSON.stringify(capabilitiesConfig)]
    )
    setConversationalAgentTestServiceDependenciesForTests({
      createAppointment: async () => {
        providerCalls += 1
        throw new Error('No debe llegar al proveedor cuando la oferta cambió')
      }
    })

    const effects = {
      enabled: true,
      scheduleAppointment: true,
      collectPayment: false,
      assignUser: false,
      notifyOwner: false
    }
    const run = await prepareConversationalAgentTestRun({
      testRunId: runId,
      testMessageId: `message_preview_offer_race_${suffix}`,
      agentId,
      requestedByUserId,
      contactId,
      effects
    })
    const previewScopeId = buildConversationalAppointmentPreviewScopeId({
      testSessionId: run.id,
      requestedByUserId: run.requestedByUserId,
      agentId: run.agent.id
    })
    const offerEventId = buildConversationalAppointmentPreviewOfferEventId(previewScopeId)
    const acceptedOfferA = {
      previewScopeId,
      agentId,
      contactId,
      channel: 'whatsapp',
      calendarId,
      startTime: slotA.toUTC().toISO(),
      localLabel: slotA.setLocale('es-MX').toFormat("cccc d 'de' LLLL, HH:mm"),
      timezone,
      executionId: buildConversationalAppointmentPreviewExecutionId({
        previewScopeId,
        testMessageId: `message_preview_offer_a_${suffix}`
      }),
      offerText: 'Tengo disponible el primer horario.',
      status: 'accepted',
      offeredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      acceptedAt: new Date().toISOString(),
      acceptedExecutionId: run.executionId
    }
    await db.run(
      `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        offerEventId,
        contactId,
        agentId,
        CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT,
        JSON.stringify(acceptedOfferA)
      ]
    )

    // La acción del primer turno ya quedó armada para A, pero antes de que el
    // tester la materialice otra petición del mismo preview publica y acepta B.
    const acceptedOfferB = {
      ...acceptedOfferA,
      startTime: slotB.toUTC().toISO(),
      localLabel: slotB.setLocale('es-MX').toFormat("cccc d 'de' LLLL, HH:mm"),
      executionId: buildConversationalAppointmentPreviewExecutionId({
        previewScopeId,
        testMessageId: `message_preview_offer_b_${suffix}`
      }),
      offerText: 'Tengo disponible el segundo horario.'
    }
    await db.run(
      `UPDATE conversational_agent_events SET detail_json = ?
       WHERE id = ? AND event_type = ?`,
      [JSON.stringify(acceptedOfferB), offerEventId, CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT]
    )

    const result = await recordConversationalAgentPreviewEffects({
      runContext: run,
      actions: [{
        type: 'book_appointment',
        calendarId,
        startTime: slotA.toUTC().toISO(),
        endTime: slotA.plus({ hours: 1 }).toUTC().toISO(),
        title: 'Cita que ya no debe materializarse',
        confirmationEvidence: {
          evidenceVerified: true,
          nativeToolDecision: true,
          selectionMode: 'accepted_prior_offer',
          selectedStartTime: slotA.toUTC().toISO(),
          customerQuote: 'sí, el primero',
          assistantOfferQuote: 'Tengo disponible el primer horario.',
          offerEventId
        },
        participants: [
          { role: 'requester', contactId, name: 'Contacto carrera preview', phone: '', email: '', relation: '' }
        ],
        outcome: { status: 'simulated' }
      }]
    })

    assert.equal(result.length, 1)
    assert.equal(result[0].type, 'appointment')
    assert.equal(result[0].status, 'failed')
    assert.match(result[0].summary, /oferta cambió antes de materializar/i)
    assert.equal(providerCalls, 0)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ?',
      [calendarId]
    )).total), 0)
    const currentOffer = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )).detail_json)
    assert.equal(currentOffer.status, 'accepted')
    assert.equal(currentOffer.startTime, slotB.toUTC().toISO())
    assert.equal(currentOffer.offerText, 'Tengo disponible el segundo horario.')
  } finally {
    setConversationalAgentTestServiceDependenciesForTests(null)
    await db.run('DELETE FROM conversational_agent_test_effects WHERE run_id = ?', [runId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_test_runs WHERE id = ?', [runId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE agent_id = ?', [agentId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('efectos del tester crean artefactos reales de prueba, son idempotentes, revalidan y se limpian', async () => {
  const suffix = randomUUID()
  const agentId = `agent_test_effects_${suffix}`
  const contactId = `contact_test_effects_${suffix}`
  const calendarId = `calendar_test_effects_${suffix}`
  const productId = `product_test_effects_${suffix}`
  const priceId = `price_test_effects_${suffix}`
  const username = `tester_effects_${suffix}`
  const runId = `session_${suffix}`
  const appointmentMessageId = `message_appointment_${suffix}`
  const contactPhone = `+521${String(Math.floor(Math.random() * 10_000_000_000)).padStart(10, '0')}`
  const currency = await getAccountCurrency()
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 28 }).startOf('day')
  const slot = baseDay.set({ hour: 14, minute: 0, second: 0, millisecond: 0 })
  const capabilitiesConfig = {
    schemaVersion: 2,
    testMode: { enabled: true, cleanupAfterMinutes: 5, notify: true },
    items: [
      { id: 'schedule_appointment', enabled: true, calendarId, bookingOwner: 'ai', allowOverlaps: false },
      {
        id: 'collect_payment',
        enabled: true,
        paymentMode: 'full_payment',
        chargeType: 'product',
        productId,
        priceId,
        gateway: 'stripe',
        installments: { enabled: false, maxInstallments: 0 },
        expirationMinutes: 60,
        afterPayment: 'continue',
        receiptProof: { enabled: true, disposition: 'pending_review' }
      }
    ]
  }
  let userId = ''
  let appointmentEffectId = ''
  const createSandboxPayment = async (config, options) => {
    assert.equal(config.mode, 'test')
    assert.equal(options.forceTestMode, true)
    const paymentId = `payment_test_${randomUUID()}`
    const publicPaymentId = `public_test_${randomUUID()}`
    const paymentUrl = `https://payments.example.test/${publicPaymentId}`
    await db.run(
      `INSERT INTO payments (
         id, contact_id, amount, currency, status, payment_method, payment_mode,
         payment_provider, public_payment_id, payment_url, metadata_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'sent', 'stripe', 'test', 'stripe', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId, config.amount, config.currency, publicPaymentId, paymentUrl, JSON.stringify(options.metadata)]
    )
    return { payment: { id: paymentId }, publicPaymentId, paymentUrl }
  }

  try {
    await db.run(
      `INSERT INTO users (username, password_hash, full_name, is_active, created_at, updated_at)
       VALUES (?, 'test-hash', 'Usuario tester', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [username]
    )
    userId = String((await db.get('SELECT id FROM users WHERE username = ?', [username]))?.id || '')
    await db.run(
      `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
       VALUES (?, 'Contacto elegido', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, contactPhone]
    )
    await upsertLocalCalendar({
      id: calendarId,
      locationId: `location_${suffix}`,
      name: 'Agenda del tester',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{
        daysOfTheWeek: [slot.weekday],
        hours: [{ openHour: 13, openMinute: 0, closeHour: 16, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO products (id, name, currency, is_active, source)
       VALUES (?, 'Consulta tester', ?, 1, 'ristak')`,
      [productId, currency]
    )
    await db.run(
      `INSERT INTO product_prices (id, product_id, name, currency, amount, source)
       VALUES (?, ?, 'Precio tester', ?, 1200, 'ristak')`,
      [priceId, productId, currency]
    )
    capabilitiesConfig.items.push({
      id: 'handoff_human',
      enabled: true,
      rules: '',
      userId,
      userName: 'Usuario tester',
      pastClientsToHuman: false
    })
    await db.run(
      `INSERT INTO conversational_agents (id, name, enabled, runtime_mode, capabilities_config)
       VALUES (?, 'Agente tester', 1, 'tool_calling_v2', ?)`,
      [agentId, JSON.stringify(capabilitiesConfig)]
    )

    setConversationalAgentTestServiceDependenciesForTests({
      createAppointment: async (req, res) => {
        const appointment = await createLocalAppointment(req.body, { syncStatus: 'synced' })
        res.status(201).json({ success: true, data: appointment })
      }
    })
    setConversationalAgentTestPaymentDependenciesForTests({
      createPaymentGateLink: createSandboxPayment
    })

    const effects = {
      enabled: true,
      scheduleAppointment: true,
      collectPayment: true,
      assignUser: false,
      notifyOwner: true
    }
    const appointmentRun = await prepareConversationalAgentTestRun({
      testRunId: runId,
      testMessageId: appointmentMessageId,
      agentId,
      requestedByUserId: userId,
      contactId,
      effects
    })
    const appointmentPreviewScopeId = buildConversationalAppointmentPreviewScopeId({
      testSessionId: appointmentRun.id,
      requestedByUserId: appointmentRun.requestedByUserId,
      agentId: appointmentRun.agent.id
    })
    const appointmentOfferEventId = buildConversationalAppointmentPreviewOfferEventId(appointmentPreviewScopeId)
    await db.run(
      `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        appointmentOfferEventId,
        contactId,
        agentId,
        CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT,
        JSON.stringify({
          previewScopeId: appointmentPreviewScopeId,
          agentId,
          contactId,
          channel: 'whatsapp',
          calendarId,
          startTime: slot.toUTC().toISO(),
          localLabel: slot.setLocale('es-MX').toFormat("cccc d 'de' LLLL, HH:mm"),
          timezone,
          executionId: buildConversationalAppointmentPreviewExecutionId({
            previewScopeId: appointmentPreviewScopeId,
            testMessageId: `message_offer_${suffix}`
          }),
          offerText: 'Tengo disponible el martes a las 14:00.',
          status: 'accepted',
          offeredAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          acceptedAt: new Date().toISOString(),
          acceptedExecutionId: appointmentRun.executionId
        })
      ]
    )
    const appointmentAction = {
      type: 'book_appointment',
      calendarId,
      startTime: slot.toUTC().toISO(),
      endTime: slot.plus({ hours: 1 }).toUTC().toISO(),
      title: 'Cita para Paty Jiménez',
      confirmationEvidence: {
        evidenceVerified: true,
        nativeToolDecision: true,
        selectionMode: 'accepted_prior_offer',
        selectedStartTime: slot.toUTC().toISO(),
        customerQuote: 'el martes tipo 10',
        assistantOfferQuote: 'martes a las 10:00',
        offerEventId: appointmentOfferEventId
      },
      participants: [
        { role: 'requester', contactId, name: 'Contacto elegido', phone: contactPhone, email: '', relation: '' },
        { role: 'primary_attendee', contactId: null, name: 'Paty Jiménez', phone: '', email: '', relation: 'mamá' }
      ],
      outcome: { status: 'simulated' }
    }
    const first = await recordConversationalAgentPreviewEffects({
      runContext: appointmentRun,
      actions: [appointmentAction]
    })
    assert.equal(first.length, 1)
    assert.equal(first[0].status, 'recorded')
    assert.equal(first[0].payload.appointmentCreated, true)
    assert.equal(first[0].payload.confirmationEvidence.evidenceVerified, true)
    assert.equal(first[0].payload.confirmationEvidence.customerQuote, 'el martes tipo 10')
    appointmentEffectId = first[0].id
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?',
      [contactId]
    )).total), 1)

    const missingEvidenceRun = await prepareConversationalAgentTestRun({
      testRunId: runId,
      testMessageId: `message_appointment_without_selection_${suffix}`,
      agentId,
      requestedByUserId: userId,
      contactId,
      effects
    })
    const { confirmationEvidence: _missingEvidence, ...appointmentWithoutEvidence } = appointmentAction
    const blockedWithoutEvidence = await recordConversationalAgentPreviewEffects({
      runContext: missingEvidenceRun,
      actions: [appointmentWithoutEvidence]
    })
    assert.equal(blockedWithoutEvidence[0].status, 'failed')
    assert.match(blockedWithoutEvidence[0].summary, /selección verificable/i)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?',
      [contactId]
    )).total), 1, 'el segundo candado del tester no debe materializar una acción sin evidencia')

    const replay = await recordConversationalAgentPreviewEffects({
      runContext: appointmentRun,
      actions: [appointmentAction]
    })
    assert.equal(replay[0].id, appointmentEffectId)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM conversational_agent_test_effects WHERE run_id = ? AND message_id = ?',
      [runId, appointmentMessageId]
    )).total), 1)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM internal_notifications
       WHERE category = 'conversational_agent_test' AND metadata_json LIKE ?`,
      [`%${appointmentEffectId}%`]
    )).total), 1)

    await assert.rejects(
      beginConversationalAgentTestEffect({
        testRunId: runId,
        testMessageId: appointmentMessageId,
        requestedByUserId: userId,
        effectType: 'appointment',
        request: { calendarId, startTime: slot.plus({ hours: 1 }).toUTC().toISO() }
      }),
      (error) => error?.code === 'test_effect_payload_mismatch'
    )

    await db.run(
      `DELETE FROM internal_notifications
       WHERE category = 'conversational_agent_test' AND metadata_json LIKE ?`,
      [`%${appointmentEffectId}%`]
    )
    await db.run(
      `UPDATE conversational_agent_test_effects
       SET notification_status = 'pending', notification_error = 'falla transitoria', updated_at = ?
       WHERE id = ?`,
      [new Date().toISOString(), appointmentEffectId]
    )
    await recordConversationalAgentPreviewEffects({ runContext: appointmentRun, actions: [appointmentAction] })
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM internal_notifications
       WHERE category = 'conversational_agent_test' AND metadata_json LIKE ?`,
      [`%${appointmentEffectId}%`]
    )).total), 1)

    await db.run(
      `DELETE FROM internal_notifications
       WHERE category = 'conversational_agent_test' AND metadata_json LIKE ?`,
      [`%${appointmentEffectId}%`]
    )
    await db.run(
      `UPDATE conversational_agent_test_effects
       SET notification_status = 'dispatching', notification_error = NULL, updated_at = ?
       WHERE id = ?`,
      [new Date(Date.now() - 10 * 60 * 1000).toISOString(), appointmentEffectId]
    )
    await Promise.all([
      ensureConversationalAgentTestEffectNotification(appointmentEffectId),
      ensureConversationalAgentTestEffectNotification(appointmentEffectId)
    ])
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM internal_notifications
       WHERE category = 'conversational_agent_test' AND metadata_json LIKE ?`,
      [`%${appointmentEffectId}%`]
    )).total), 1)

    const driftMessageId = `message_payment_drift_${suffix}`
    const driftRun = await prepareConversationalAgentTestRun({
      testRunId: runId,
      testMessageId: driftMessageId,
      agentId,
      requestedByUserId: userId,
      contactId,
      effects
    })
    await db.run('UPDATE product_prices SET amount = 1300 WHERE id = ?', [priceId])
    const stalePaymentAction = {
      type: 'create_payment_link',
      amount: 1200,
      unitAmount: 1200,
      quantity: 1,
      currency,
      concept: 'Consulta tester · Precio tester',
      catalogEvidence: { source: 'product_price', productId, priceId },
      outcome: { status: 'simulated' }
    }
    const drift = await recordConversationalAgentPreviewEffects({
      runContext: driftRun,
      actions: [stalePaymentAction]
    })
    assert.equal(drift[0].status, 'failed')
    assert.match(drift[0].summary, /producto, precio o monto/i)

    await db.run('UPDATE product_prices SET amount = 1200 WHERE id = ?', [priceId])
    const paymentMessageId = `message_payment_valid_${suffix}`
    const paymentRun = await prepareConversationalAgentTestRun({
      testRunId: runId,
      testMessageId: paymentMessageId,
      agentId,
      requestedByUserId: userId,
      contactId,
      effects
    })
    const paymentRequest = {
      amount: 1200,
      unitAmount: 1200,
      quantity: 1,
      currency,
      concept: 'Consulta tester · Precio tester',
      productId,
      priceId,
      collectionMethod: 'payment_link',
      paymentPurpose: '',
      afterPayment: 'continue'
    }
    const abandonedPaymentEffect = await beginConversationalAgentTestEffect({
      testRunId: runId,
      testMessageId: paymentMessageId,
      requestedByUserId: userId,
      effectType: 'payment',
      request: paymentRequest
    })
    assert.equal(abandonedPaymentEffect.claimed, true)

    let releasePaymentCrash
    let signalPaymentCreating
    const paymentCreating = new Promise((resolve) => { signalPaymentCreating = resolve })
    const paymentCrashGate = new Promise((resolve) => { releasePaymentCrash = resolve })
    setConversationalAgentTestPaymentDependenciesForTests({
      createPaymentGateLink: async () => {
        signalPaymentCreating()
        await paymentCrashGate
        throw Object.assign(new Error('crash simulado del dueño anterior'), { code: 'simulated_payment_owner_crash' })
      }
    })
    const abandonedInnerCreation = createConversationalAgentTestPaymentLink({
      effectId: abandonedPaymentEffect.effect.id,
      testRunId: runId,
      agentId,
      requestedByUserId: userId,
      contact: {
        id: contactId,
        name: 'Contacto elegido',
        phone: contactPhone,
        email: ''
      },
      paymentGateConfig: {
        gateway: 'stripe',
        billingType: 'single',
        amount: 1200,
        currency,
        productName: 'Consulta tester · Precio tester',
        description: 'Consulta tester · Precio tester',
        msi: { enabled: false, maxInstallments: 0 }
      }
    })
    await paymentCreating
    await db.run(
      `UPDATE conversational_agent_test_effects
       SET status = 'failed', error_code = 'simulated_outer_crash', error_retryable = 1,
           claim_token = NULL, lease_until_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [abandonedPaymentEffect.effect.id]
    )
    const paymentWhileOldOwnerIsCreating = await recordConversationalAgentPreviewEffects({
      runContext: paymentRun,
      actions: [stalePaymentAction]
    })
    assert.equal(paymentWhileOldOwnerIsCreating[0].status, 'failed')
    assert.equal(paymentWhileOldOwnerIsCreating[0].code, 'test_payment_creation_in_progress')
    assert.equal(paymentWhileOldOwnerIsCreating[0].retryable, true)
    assert.equal(Number((await db.get(
      'SELECT error_retryable FROM conversational_agent_test_effects WHERE id = ?',
      [abandonedPaymentEffect.effect.id]
    )).error_retryable), 1)

    releasePaymentCrash()
    await assert.rejects(abandonedInnerCreation, /crash simulado/)
    setConversationalAgentTestPaymentDependenciesForTests({
      createPaymentGateLink: createSandboxPayment
    })
    const payment = await recordConversationalAgentPreviewEffects({
      runContext: paymentRun,
      actions: [stalePaymentAction]
    })
    assert.equal(payment[0].status, 'prepared', JSON.stringify(payment[0], null, 2))
    assert.equal(payment[0].payload.paymentCreated, true)
    assert.equal(payment[0].payload.linkSent, true)
    assert.match(payment[0].payload.paymentUrl, /^https:\/\/payments\.example\.test\//)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM payments WHERE contact_id = ?',
      [contactId]
    )).total), 1)

    const standaloneDepositCapabilitiesConfig = {
      ...capabilitiesConfig,
      items: capabilitiesConfig.items.map((item) => item.id === 'collect_payment'
        ? {
            ...item,
            collectionMethod: 'payment_link',
            paymentMode: 'deposit',
            chargeType: 'deposit',
            deposit: { enabled: true, mode: 'fixed', amount: 100, currency },
            testMode: { enabled: true, notify: true }
          }
        : item)
    }
    await db.run(
      'UPDATE conversational_agents SET capabilities_config = ? WHERE id = ?',
      [JSON.stringify(standaloneDepositCapabilitiesConfig), agentId]
    )
    const standaloneDepositRun = await prepareConversationalAgentTestRun({
      testRunId: runId,
      testMessageId: `message_standalone_deposit_${suffix}`,
      agentId,
      requestedByUserId: userId,
      contactId,
      effects
    })
    const standaloneDeposit = await recordConversationalAgentPreviewEffects({
      runContext: standaloneDepositRun,
      actions: [{
        type: 'create_payment_link',
        amount: 100,
        currency,
        quantity: 1,
        concept: 'Anticipo general',
        paymentPurpose: 'deposit',
        afterPayment: 'continue',
        outcome: { status: 'simulated' }
      }]
    })
    assert.equal(standaloneDeposit[0].status, 'prepared', JSON.stringify(standaloneDeposit[0], null, 2))
    assert.equal(standaloneDeposit[0].payload.paymentPurpose, 'deposit')
    assert.equal(standaloneDeposit[0].payload.appointmentOfferBinding, undefined)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM payments WHERE contact_id = ?',
      [contactId]
    )).total), 2)

    const humanScheduleCapabilitiesConfig = {
      ...capabilitiesConfig,
      schemaVersion: 3,
      items: capabilitiesConfig.items.map((item) => item.id === 'schedule_appointment'
        ? {
            ...item,
            bookingOwner: 'human',
            handoffUserId: userId,
            handoffUserName: 'Usuario tester',
            testMode: { enabled: true, notify: true }
          }
        : item)
    }
    await db.run(
      'UPDATE conversational_agents SET capabilities_config = ? WHERE id = ?',
      [JSON.stringify(humanScheduleCapabilitiesConfig), agentId]
    )
    const assignmentEffects = {
      enabled: true,
      scheduleAppointment: false,
      collectPayment: false,
      assignUser: true,
      notifyOwner: true
    }
    const assignmentRun = await prepareConversationalAgentTestRun({
      testRunId: runId,
      testMessageId: `message_assignment_${suffix}`,
      agentId,
      requestedByUserId: userId,
      contactId,
      effects: assignmentEffects
    })
    const assignment = await recordConversationalAgentPreviewEffects({
      runContext: assignmentRun,
      actions: [{
        type: 'request_human_booking',
        motivo: 'La persona pidió apoyo',
        calendarId,
        startTime: slot.toUTC().toISO(),
        outcome: { status: 'simulated' }
      }]
    })
    assert.equal(assignment[0].type, 'assignment')
    assert.equal(assignment[0].status, 'recorded')
    assert.equal(assignment[0].payload.assignmentActive, true)
    const assignedContact = await db.get(
      'SELECT assigned_user_id, assignment_test_effect_id FROM contacts WHERE id = ?',
      [contactId]
    )
    assert.equal(String(assignedContact.assigned_user_id), userId)
    assert.equal(assignedContact.assignment_test_effect_id, assignment[0].id)

    await assert.rejects(
      listConversationalAgentTestEffects({ testRunId: runId, requestedByUserId: `${userId}-otro` }),
      (error) => error?.code === 'test_run_not_found'
    )

    const cleaned = await cleanupConversationalAgentTestRun({ testRunId: runId, requestedByUserId: userId })
    assert.equal(cleaned.cleaned, true)
    assert.ok(cleaned.effects.every((effect) => effect.status === 'cleaned'))
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?', [contactId])).total), 0)
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM payments WHERE contact_id = ?', [contactId])).total), 0)
    const restoredContact = await db.get(
      'SELECT assigned_user_id, assignment_test_effect_id FROM contacts WHERE id = ?',
      [contactId]
    )
    assert.equal(restoredContact.assigned_user_id, null)
    assert.equal(restoredContact.assignment_test_effect_id, null)
    await assert.rejects(
      beginConversationalAgentTestEffect({
        testRunId: runId,
        testMessageId: `message_after_cleanup_${suffix}`,
        requestedByUserId: userId,
        effectType: 'appointment',
        request: { calendarId, startTime: slot.toUTC().toISO() }
      }),
      (error) => error?.code === 'test_run_closed'
    )
  } finally {
    setConversationalAgentTestServiceDependenciesForTests(null)
    setConversationalAgentTestPaymentDependenciesForTests(null)
    await db.run(
      `DELETE FROM internal_notifications
       WHERE category = 'conversational_agent_test' AND contact_id = ?`,
      [contactId]
    ).catch(() => {})
    await db.run('DELETE FROM conversational_agent_test_effects WHERE run_id = ?', [runId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_test_runs WHERE id = ?', [runId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE agent_id = ?', [agentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => {})
    await db.run('DELETE FROM product_prices WHERE id = ?', [priceId]).catch(() => {})
    await db.run('DELETE FROM products WHERE id = ?', [productId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
  }
})
