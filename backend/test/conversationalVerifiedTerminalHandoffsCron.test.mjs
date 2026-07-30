import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'

import { db, databaseReady } from '../src/config/database.js'
import {
  createConversationalVerifiedTerminalHandoffScheduler
} from '../src/jobs/conversationalVerifiedTerminalHandoffs.cron.js'
import {
  loadToolCallingV2VerifiedPaymentHandoffPolicy
} from '../src/agents/conversational/runner.js'
import {
  checkpointToolCallingV2AppointmentBookingIntentCommit,
  recordConversationalAgentEvent,
  sealToolCallingV2AppointmentBookingIntent,
  setConversationalPriorityNotificationSenderForTest,
  setConversationalRequiredDataPromptHandlerForTest,
  setConversationalTerminalMessageHandlerForTest,
  setConversationalVerifiedPaymentHandoffHandlersForTest
} from '../src/services/conversationalAgentService.js'

await databaseReady

function passthroughTrack(_name, work) {
  return work()
}

test('el worker terminal usa lock propio, lotes acotados y cursor que no se atasca en un fallo', async () => {
  const calls = []
  const lockNames = []
  const scheduled = []
  let nowMs = 1_000
  const pages = [
    {
      scanned: 2,
      recovered: 1,
      failed: 1,
      errors: [{ pendingEventId: 'bad-1', code: 'temporary', message: 'retry' }],
      hasMore: true,
      nextCursor: { createdAt: '2026-07-30T01:00:00.000Z', id: 'row-2' }
    },
    {
      scanned: 1,
      recovered: 1,
      failed: 0,
      hasMore: false,
      nextCursor: { createdAt: '2026-07-30T01:01:00.000Z', id: 'row-3' }
    }
  ]
  const scheduler = createConversationalVerifiedTerminalHandoffScheduler({
    recover: async (options) => {
      calls.push(options)
      nowMs += 1
      return pages.shift()
    },
    withLock: async (name, _ttl, work, options) => {
      lockNames.push({ name, options })
      return { ran: true, result: await work({ isLeaseValid: () => true }) }
    },
    trackWork: passthroughTrack,
    shuttingDown: () => false,
    now: () => nowMs,
    batchLimit: 2,
    runBudgetMs: 100,
    setTimeoutFn(callback, delay) {
      scheduled.push({ callback, delay })
      return { unref() {} }
    },
    clearTimeoutFn() {},
    logger: { info() {}, warn() {}, error() {} }
  })

  const result = await scheduler.tick('test')
  assert.equal(result.pages, 2)
  assert.equal(result.scanned, 3)
  assert.equal(result.recovered, 2)
  assert.equal(result.failed, 1)
  assert.deepEqual(calls, [
    { limit: 2, afterCursor: null },
    {
      limit: 2,
      afterCursor: { createdAt: '2026-07-30T01:00:00.000Z', id: 'row-2' }
    }
  ])
  assert.deepEqual(lockNames, [{
    name: 'conversational-verified-terminal-handoffs',
    options: { failOpen: false }
  }])
  assert.equal(scheduled.length, 0)
  assert.equal(scheduler.getState().cursor, null)
})

test('el worker se autodespierta al agotar presupuesto con backlog y conserva el cursor', async () => {
  const wakeups = []
  let nowMs = 10
  const scheduler = createConversationalVerifiedTerminalHandoffScheduler({
    recover: async () => {
      nowMs = 100
      return {
        scanned: 3,
        recovered: 3,
        hasMore: true,
        nextCursor: { createdAt: '2026-07-30T02:00:00.000Z', id: 'row-3' }
      }
    },
    withLock: async (_name, _ttl, work) => ({
      ran: true,
      result: await work({ isLeaseValid: () => true })
    }),
    trackWork: passthroughTrack,
    shuttingDown: () => false,
    now: () => nowMs,
    batchLimit: 3,
    runBudgetMs: 50,
    setTimeoutFn(callback, delay) {
      wakeups.push({ callback, delay })
      return { unref() {} }
    },
    clearTimeoutFn() {},
    logger: { info() {}, warn() {}, error() {} }
  })

  const result = await scheduler.tick('test')
  assert.equal(result.hasMore, true)
  assert.equal(wakeups.length, 1)
  assert.equal(wakeups[0].delay, 0)
  assert.deepEqual(scheduler.getState().cursor, {
    createdAt: '2026-07-30T02:00:00.000Z',
    id: 'row-3'
  })
})

test('el worker agenda reintento corto si falla la lectura global de la cola', async () => {
  const wakeups = []
  const scheduler = createConversationalVerifiedTerminalHandoffScheduler({
    recover: async () => {
      throw new Error('database unavailable')
    },
    withLock: async (_name, _ttl, work) => ({
      ran: true,
      result: await work({ isLeaseValid: () => true })
    }),
    trackWork: passthroughTrack,
    shuttingDown: () => false,
    retryWakeMs: 1234,
    setTimeoutFn(callback, delay) {
      wakeups.push({ callback, delay })
      return { unref() {} }
    },
    clearTimeoutFn() {},
    logger: { info() {}, warn() {}, error() {} }
  })

  await assert.rejects(() => scheduler.tick('test'), /database unavailable/)
  assert.equal(wakeups.length, 1)
  assert.equal(wakeups[0].delay, 1234)
})

test('un tick real recupera booking committed, materializa el pending y resuelve el handoff exactamente una vez', async () => {
  const suffix = randomUUID()
  const contactId = `contact_cron_terminal_${suffix}`
  const agentId = `agent_cron_terminal_${suffix}`
  const stateId = `state_cron_terminal_${suffix}`
  const activationCycleId = `cycle_cron_terminal_${suffix}`
  const confirmationMessageId = `message_cron_terminal_${suffix}`
  const selectionEventId = `selection_cron_terminal_${suffix}`
  const clientRequestId = `request_cron_terminal_${suffix}`
  const appointmentId = `appointment_cron_terminal_${suffix}`
  const calendarId = `calendar_cron_terminal_${suffix}`
  const startTime = '2040-01-02T17:00:00.000Z'
  const endTime = '2040-01-02T18:00:00.000Z'
  const conversationScopeId = `handoff_scope_${createHash('sha256')
    .update([stateId, activationCycleId].join('\u0000'))
    .digest('hex')
    .slice(0, 40)}`
  const policy = {
    configRevision: `cron-terminal-revision-${suffix}`,
    policyFingerprint: `cron-terminal-policy-${suffix}`,
    enabled: true,
    criteriaConfigured: true,
    rules: 'cuando la cita quede agendada',
    assignedUserId: null,
    assignedUserName: null,
    generalFallbackPolicy: 'configured_user_or_general_team',
    dataRequirements: { enabled: false, fields: [] }
  }
  const deliveries = []
  let notificationCalls = 0
  let intent = null

  setConversationalVerifiedPaymentHandoffHandlersForTest({
    loadPolicy: async () => policy,
    adjudicate: async () => ({
      ...policy,
      decision: 'match',
      source: 'model_rule_match',
      matchedRule: policy.rules,
      reason: 'La cita ya quedó agendada.',
      summary: 'Cita confirmada; el equipo humano debe continuar.',
      conversationScopeId,
      modelCallCount: 1
    })
  })
  setConversationalPriorityNotificationSenderForTest(async () => {
    notificationCalls += 1
    return { sent: 1 }
  })
  setConversationalTerminalMessageHandlerForTest(async (payload) => {
    const pendingEventId = String(payload?.obligationId || '')
      .replace(/:terminal_message$/, '')
    const pending = await db.get(
      `SELECT event_type, detail_json
       FROM conversational_agent_events WHERE id = ?`,
      [pendingEventId]
    )
    const detail = JSON.parse(pending?.detail_json || '{}')
    deliveries.push({
      pendingEventId,
      eventTypeDuringDelivery: pending?.event_type || null,
      statusDuringDelivery: detail.status || null,
      payload
    })
    return {
      settled: true,
      sent: true,
      ambiguous: false,
      durableStatus: 'completed',
      sourceMessageId:
        `handoff-terminal:${pendingEventId}:terminal_message`
    }
  })

  try {
    await db.run(
      `INSERT INTO contacts (
         id, full_name, phone, created_at, updated_at
       ) VALUES (?, 'Tania Salinas', '+525632313412',
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO conversational_agents (
         id, name, enabled, runtime_mode, capabilities_config
       ) VALUES (?, ?, 1, 'tool_calling_v2', ?)`,
      [
        agentId,
        `Agente cron terminal ${suffix}`,
        JSON.stringify({
          schemaVersion: 3,
          items: [{
            id: 'schedule_appointment',
            enabled: true,
            calendarId
          }, {
            id: 'handoff_human',
            enabled: true,
            rules: policy.rules
          }]
        })
      ]
    )
    await db.run(
      `INSERT INTO whatsapp_api_messages (
         id, contact_id, direction, message_type, message_text,
         message_timestamp
       ) VALUES (?, ?, 'inbound', 'text', 'Sí, lunes a las 11:00',
         CURRENT_TIMESTAMP)`,
      [confirmationMessageId, contactId]
    )
    await db.run(
      `INSERT INTO conversational_agent_state (
         id, contact_id, agent_id, channel, status, signal,
         activation_cycle_id, activation_cycle_started_at,
         activation_cycle_started_message_id, created_at, updated_at
       ) VALUES (?, ?, ?, 'whatsapp', 'active', NULL, ?,
         CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        stateId,
        contactId,
        agentId,
        activationCycleId,
        confirmationMessageId
      ]
    )
    await recordConversationalAgentEvent({
      eventId: selectionEventId,
      contactId,
      eventType: 'appointment_slot_selection_verified',
      detail: {
        agentId,
        status: 'active',
        channel: 'whatsapp',
        calendarId,
        startTime,
        selectionTerminalSourceMessageId: confirmationMessageId
      },
      throwOnError: true
    })

    intent = await sealToolCallingV2AppointmentBookingIntent({
      contactId,
      agentId,
      channel: 'whatsapp',
      binding: {
        stateId,
        activationCycleId,
        conversationScopeId
      },
      clientRequestId,
      selectionEventId,
      terminalSourceMessageId: confirmationMessageId,
      calendarId,
      startTime,
      actionScopedContactData: {}
    })
    assert.equal(intent.pending, true)
    assert.equal(intent.committed, false)

    await db.transaction(async (transaction) => {
      await transaction.run(
        `INSERT INTO appointments (
           id, calendar_id, contact_id, title, status, appointment_status,
           start_time, end_time, date_added, date_updated
         ) VALUES (?, ?, ?, 'Consulta de valoración', 'confirmed', 'confirmed',
           ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [appointmentId, calendarId, contactId, startTime, endTime]
      )
      await transaction.run(
        `INSERT INTO appointment_creation_requests (
           client_request_id, request_hash, status, appointment_id,
           response_json, created_at, updated_at
         ) VALUES (?, ?, 'completed', ?, '{}',
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          clientRequestId,
          createHash('sha256')
            .update(JSON.stringify({ calendarId, contactId, startTime, endTime }))
            .digest('hex'),
          appointmentId
        ]
      )
      await checkpointToolCallingV2AppointmentBookingIntentCommit({
        intentEventId: intent.intentEventId,
        intentHash: intent.intentHash,
        clientRequestId,
        appointmentId,
        database: transaction
      })
    })

    const committed = await db.get(
      `SELECT event_type FROM conversational_agent_events WHERE id = ?`,
      [intent.intentEventId]
    )
    assert.equal(
      committed?.event_type,
      'verified_terminal_handoff_booking_committed'
    )

    const scheduler = createConversationalVerifiedTerminalHandoffScheduler({
      logger: { info() {}, warn() {}, error() {} },
      batchLimit: 20,
      runBudgetMs: 10_000,
      setTimeoutFn() {
        throw new Error('El tick no debe necesitar un wake adicional sin backlog.')
      },
      clearTimeoutFn() {}
    })
    const first = await scheduler.tick('integration-test')
    assert.equal(first.failed, 0, JSON.stringify(first))
    assert.equal(first.materialized, 1, JSON.stringify(first))
    assert.equal(first.recovered, 1, JSON.stringify(first))
    assert.equal(first.scanned, 1, JSON.stringify(first))
    assert.equal(first.hasMore, false, JSON.stringify(first))

    assert.equal(deliveries.length, 1)
    assert.equal(
      deliveries[0].eventTypeDuringDelivery,
      'verified_terminal_handoff_pending'
    )
    assert.equal(deliveries[0].statusDuringDelivery, 'processing')
    assert.equal(deliveries[0].payload.messageKind, 'handoff')
    assert.equal(notificationCalls, 1)

    const materialized = await db.get(
      `SELECT event_type, detail_json
       FROM conversational_agent_events WHERE id = ?`,
      [intent.intentEventId]
    )
    assert.equal(
      materialized?.event_type,
      'verified_terminal_handoff_booking_materialized'
    )
    const materializedDetail = JSON.parse(materialized?.detail_json || '{}')
    assert.equal(
      materializedDetail.pendingEventId,
      deliveries[0].pendingEventId
    )

    const resolved = await db.get(
      `SELECT event_type, detail_json
       FROM conversational_agent_events WHERE id = ?`,
      [materializedDetail.pendingEventId]
    )
    assert.equal(resolved?.event_type, 'verified_terminal_handoff_resolved')
    assert.equal(JSON.parse(resolved?.detail_json || '{}').status, 'completed')

    const state = await db.get(
      `SELECT status, signal
       FROM conversational_agent_state WHERE id = ?`,
      [stateId]
    )
    assert.deepEqual(
      [state?.status, state?.signal],
      ['human', 'ready_for_human']
    )

    const beforeReplayCounts = await db.get(
      `SELECT
         SUM(CASE WHEN event_type = 'verified_terminal_handoff_resolved'
           THEN 1 ELSE 0 END) AS resolved_total,
         SUM(CASE WHEN event_type = 'verified_terminal_handoff_completed'
           THEN 1 ELSE 0 END) AS handoff_total,
         SUM(CASE WHEN event_type = 'priority_push_notification'
           THEN 1 ELSE 0 END) AS notification_total
       FROM conversational_agent_events WHERE contact_id = ?`,
      [contactId]
    )
    assert.deepEqual(
      [
        Number(beforeReplayCounts.resolved_total),
        Number(beforeReplayCounts.handoff_total),
        Number(beforeReplayCounts.notification_total)
      ],
      [1, 1, 1]
    )

    const replay = await scheduler.tick('integration-replay')
    assert.equal(replay.failed, 0, JSON.stringify(replay))
    assert.equal(replay.scanned, 0, JSON.stringify(replay))
    assert.equal(replay.materialized, 0, JSON.stringify(replay))
    assert.equal(replay.recovered, 0, JSON.stringify(replay))
    assert.equal(deliveries.length, 1)
    assert.equal(notificationCalls, 1)

    const afterReplayCounts = await db.get(
      `SELECT
         SUM(CASE WHEN event_type = 'verified_terminal_handoff_resolved'
           THEN 1 ELSE 0 END) AS resolved_total,
         SUM(CASE WHEN event_type = 'verified_terminal_handoff_completed'
           THEN 1 ELSE 0 END) AS handoff_total,
         SUM(CASE WHEN event_type = 'priority_push_notification'
           THEN 1 ELSE 0 END) AS notification_total
       FROM conversational_agent_events WHERE contact_id = ?`,
      [contactId]
    )
    assert.deepEqual(afterReplayCounts, beforeReplayCounts)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?',
      [contactId]
    )).total), 1)
  } finally {
    setConversationalTerminalMessageHandlerForTest(null)
    setConversationalPriorityNotificationSenderForTest(null)
    setConversationalVerifiedPaymentHandoffHandlersForTest()
    await db.run(
      `DELETE FROM appointment_creation_requests
       WHERE client_request_id = ?`,
      [clientRequestId]
    ).catch(() => {})
    await db.run(
      'DELETE FROM appointments WHERE contact_id = ?',
      [contactId]
    ).catch(() => {})
    await db.run(
      'DELETE FROM whatsapp_api_messages WHERE contact_id = ?',
      [contactId]
    ).catch(() => {})
    await db.run(
      'DELETE FROM conversational_agent_events WHERE contact_id = ? OR agent_id = ?',
      [contactId, agentId]
    ).catch(() => {})
    await db.run(
      'DELETE FROM conversational_agent_state WHERE contact_id = ?',
      [contactId]
    ).catch(() => {})
    await db.run(
      'DELETE FROM conversational_agents WHERE id = ?',
      [agentId]
    ).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('el worker descarta campos ya completos antes de enviar, recalcula y revalida la política', async () => {
  const suffix = randomUUID()
  const contactId = `contact_cron_prompt_race_${suffix}`
  const agentId = `agent_cron_prompt_race_${suffix}`
  const stateId = `state_cron_prompt_race_${suffix}`
  const activationCycleId = `cycle_cron_prompt_race_${suffix}`
  const confirmationMessageId = `message_cron_prompt_race_${suffix}`
  const selectionEventId = `selection_cron_prompt_race_${suffix}`
  const clientRequestId = `request_cron_prompt_race_${suffix}`
  const appointmentId = `appointment_cron_prompt_race_${suffix}`
  const calendarId = `calendar_cron_prompt_race_${suffix}`
  const startTime = '2040-01-03T17:00:00.000Z'
  const endTime = '2040-01-03T18:00:00.000Z'
  const conversationScopeId = `handoff_scope_${createHash('sha256')
    .update([stateId, activationCycleId].join('\u0000'))
    .digest('hex')
    .slice(0, 40)}`
  const dataRequirements = {
    enabled: true,
    updateContact: {
      enabled: true,
      policy: 'replace_placeholders'
    },
    fields: [{
      field: 'full_name',
      label: 'nombre completo',
      level: 'required',
      scope: 'handoff'
    }, {
      field: 'email',
      label: 'correo electrónico',
      level: 'required',
      scope: 'handoff'
    }, {
      field: 'company',
      label: 'empresa',
      level: 'required',
      scope: 'handoff'
    }]
  }
  const handoffRules = 'cuando la cita quede agendada'
  let policy = null
  const enabledCapabilities = {
    schemaVersion: 3,
    dataRequirements,
    items: [{
      id: 'schedule_appointment',
      enabled: true,
      calendarId
    }, {
      id: 'handoff_human',
      enabled: true,
      rules: handoffRules
    }]
  }
  const disabledCapabilities = {
    ...enabledCapabilities,
    items: enabledCapabilities.items.map((item) => (
      item.id === 'handoff_human'
        ? { ...item, enabled: false }
        : item
    ))
  }
  let intent = null
  let promptAttempts = 0
  let providerSends = 0
  const executingLatches = []
  const promptFieldsByAttempt = []

  setConversationalTerminalMessageHandlerForTest(async () => {
    throw new Error('Una espera de datos no debe mandar el mensaje terminal.')
  })
  setConversationalRequiredDataPromptHandlerForTest(async (payload) => {
    promptAttempts += 1
    assert.equal(typeof payload.beforeSendFreshness, 'function')
    const latchRow = await db.get(
      `SELECT detail_json FROM conversational_agent_events WHERE id = ?`,
      [payload.latchId]
    )
    const executingLatch = JSON.parse(latchRow?.detail_json || '{}')
    executingLatches.push(executingLatch)
    assert.equal(executingLatch.status, 'executing')
    assert.ok(executingLatch.executionToken)
    const visibleFields = payload.missingFields.map((item) => item.field)
    promptFieldsByAttempt.push(visibleFields)

    if (promptAttempts === 1) {
      assert.deepEqual(visibleFields, ['company', 'email', 'full_name'])
      await db.run(
        `UPDATE contacts
         SET full_name = 'Tania Salinas', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [contactId]
      )
    } else if (promptAttempts === 2) {
      assert.deepEqual(visibleFields, ['company', 'email'])
      await db.run(
        `UPDATE contacts
         SET email = 'tania@example.test', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [contactId]
      )
    } else {
      assert.equal(promptAttempts, 3)
      assert.deepEqual(visibleFields, ['company'])
      await db.run(
        `UPDATE conversational_agents
         SET capabilities_config = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [JSON.stringify(disabledCapabilities), agentId]
      )
    }
    const freshness = await payload.beforeSendFreshness(async () => {
      providerSends += 1
      return {
        settled: true,
        sent: true,
        ambiguous: false,
        durableStatus: 'completed'
      }
    })
    assert.equal(freshness.deliver, false, JSON.stringify(freshness))
    assert.equal(
      freshness.reason,
      promptAttempts < 3
        ? 'required_data_prompt_field_already_complete'
        : 'required_data_policy_changed'
    )
    assert.equal(providerSends, 0)
    return {
      settled: true,
      sent: false,
      skipped: true,
      ambiguous: false,
      durableStatus: 'skipped',
      reason: freshness.reason
    }
  })

  try {
    await db.run(
      `INSERT INTO contacts (
         id, full_name, phone, created_at, updated_at
       ) VALUES (?, 'Contacto', '+525632313412',
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO conversational_agents (
         id, name, enabled, runtime_mode, capabilities_config
       ) VALUES (?, ?, 1, 'tool_calling_v2', ?)`,
      [
        agentId,
        `Agente cron prompt race ${suffix}`,
        JSON.stringify(enabledCapabilities)
      ]
    )
    policy = await loadToolCallingV2VerifiedPaymentHandoffPolicy({ agentId })
    assert.equal(policy.enabled, true)
    assert.equal(policy.criteriaConfigured, true)
    setConversationalVerifiedPaymentHandoffHandlersForTest({
      loadPolicy: async () => (
        loadToolCallingV2VerifiedPaymentHandoffPolicy({ agentId })
      ),
      adjudicate: async () => ({
        ...policy,
        decision: 'match',
        source: 'model_rule_match',
        matchedRule: policy.rules,
        reason: 'La cita ya quedó agendada.',
        summary: 'Faltan datos obligatorios antes de entregar el chat.',
        conversationScopeId,
        modelCallCount: 1
      })
    })
    await db.run(
      `INSERT INTO whatsapp_api_messages (
         id, contact_id, direction, message_type, message_text,
         message_timestamp
       ) VALUES (?, ?, 'inbound', 'text', 'Sí, el lunes a las 11',
         CURRENT_TIMESTAMP)`,
      [confirmationMessageId, contactId]
    )
    await db.run(
      `INSERT INTO conversational_agent_state (
         id, contact_id, agent_id, channel, status, signal,
         activation_cycle_id, activation_cycle_started_at,
         activation_cycle_started_message_id, created_at, updated_at
       ) VALUES (?, ?, ?, 'whatsapp', 'active', NULL, ?,
         CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        stateId,
        contactId,
        agentId,
        activationCycleId,
        confirmationMessageId
      ]
    )
    await recordConversationalAgentEvent({
      eventId: selectionEventId,
      contactId,
      eventType: 'appointment_slot_selection_verified',
      detail: {
        agentId,
        status: 'active',
        channel: 'whatsapp',
        calendarId,
        startTime,
        selectionTerminalSourceMessageId: confirmationMessageId
      },
      throwOnError: true
    })

    intent = await sealToolCallingV2AppointmentBookingIntent({
      contactId,
      agentId,
      channel: 'whatsapp',
      binding: {
        stateId,
        activationCycleId,
        conversationScopeId
      },
      clientRequestId,
      selectionEventId,
      terminalSourceMessageId: confirmationMessageId,
      calendarId,
      startTime,
      actionScopedContactData: {}
    })
    await db.transaction(async (transaction) => {
      await transaction.run(
        `INSERT INTO appointments (
           id, calendar_id, contact_id, title, status, appointment_status,
           start_time, end_time, date_added, date_updated
         ) VALUES (?, ?, ?, 'Consulta de valoración', 'confirmed', 'confirmed',
           ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [appointmentId, calendarId, contactId, startTime, endTime]
      )
      await transaction.run(
        `INSERT INTO appointment_creation_requests (
           client_request_id, request_hash, status, appointment_id,
           response_json, created_at, updated_at
         ) VALUES (?, ?, 'completed', ?, '{}',
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          clientRequestId,
          createHash('sha256')
            .update(JSON.stringify({ calendarId, contactId, startTime, endTime }))
            .digest('hex'),
          appointmentId
        ]
      )
      await checkpointToolCallingV2AppointmentBookingIntentCommit({
        intentEventId: intent.intentEventId,
        intentHash: intent.intentHash,
        clientRequestId,
        appointmentId,
        database: transaction
      })
    })

    const scheduler = createConversationalVerifiedTerminalHandoffScheduler({
      logger: { info() {}, warn() {}, error() {} },
      batchLimit: 20,
      runBudgetMs: 10_000,
      setTimeoutFn() {
        throw new Error('El tick no debe dejar backlog en esta carrera.')
      },
      clearTimeoutFn() {}
    })
    const first = await scheduler.tick('required-data-race')
    assert.equal(first.failed, 0, JSON.stringify(first))
    assert.equal(first.materialized, 1, JSON.stringify(first))
    assert.equal(first.recovered, 1, JSON.stringify(first))
    assert.equal(promptAttempts, 3)
    assert.equal(providerSends, 0)
    assert.deepEqual(promptFieldsByAttempt, [
      ['company', 'email', 'full_name'],
      ['company', 'email'],
      ['company']
    ])
    assert.equal(executingLatches.length, 3)
    assert.equal(
      executingLatches.every((latch) => (
        latch.promptDeliveryHandledMessageId === confirmationMessageId
      )),
      true
    )
    assert.equal((await db.get(
      'SELECT full_name FROM contacts WHERE id = ?',
      [contactId]
    )).full_name, 'Tania Salinas')
    assert.equal((await db.get(
      'SELECT email FROM contacts WHERE id = ?',
      [contactId]
    )).email, 'tania@example.test')

    const latch = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'handoff_rule_pending'`,
      [contactId]
    )
    const latchDetail = JSON.parse(latch?.detail_json || '{}')
    assert.equal(latchDetail.status, 'superseded', JSON.stringify(latchDetail))
    assert.equal(
      latchDetail.supersededReason,
      'handoff_policy_disabled'
    )
    const state = await db.get(
      `SELECT status, signal FROM conversational_agent_state WHERE id = ?`,
      [stateId]
    )
    assert.deepEqual([state?.status, state?.signal], ['active', null])
    const signalEvents = await db.all(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'signal_set'`,
      [contactId]
    )
    assert.equal(signalEvents.some((row) => (
      JSON.parse(row.detail_json || '{}').signal === 'ready_for_human'
    )), false)
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM chat_delivery_outbox
       WHERE contact_id = ?`,
      [contactId]
    )).total), 0)

    const replay = await scheduler.tick('required-data-race-replay')
    assert.equal(replay.failed, 0, JSON.stringify(replay))
    assert.equal(replay.scanned, 0, JSON.stringify(replay))
    assert.equal(promptAttempts, 3)
    assert.equal(providerSends, 0)
  } finally {
    setConversationalRequiredDataPromptHandlerForTest(null)
    setConversationalTerminalMessageHandlerForTest(null)
    setConversationalVerifiedPaymentHandoffHandlersForTest()
    await db.run(
      `DELETE FROM appointment_creation_requests
       WHERE client_request_id = ?`,
      [clientRequestId]
    ).catch(() => {})
    await db.run(
      'DELETE FROM appointments WHERE contact_id = ?',
      [contactId]
    ).catch(() => {})
    await db.run(
      'DELETE FROM whatsapp_api_messages WHERE contact_id = ?',
      [contactId]
    ).catch(() => {})
    await db.run(
      'DELETE FROM conversational_agent_events WHERE contact_id = ? OR agent_id = ?',
      [contactId, agentId]
    ).catch(() => {})
    await db.run(
      'DELETE FROM conversational_agent_state WHERE contact_id = ?',
      [contactId]
    ).catch(() => {})
    await db.run(
      'DELETE FROM conversational_agents WHERE id = ?',
      [agentId]
    ).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})
