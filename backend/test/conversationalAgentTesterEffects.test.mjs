import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

import { db } from '../src/config/database.js'
import {
  beginConversationalAgentTestEffect,
  cleanupConversationalAgentTestRun,
  ensureConversationalAgentTestEffectNotification,
  listRecentConversationalAgentTestRuns,
  listConversationalAgentTestEffects,
  normalizeConversationalAgentTestEffects,
  prepareConversationalAgentTestRun,
  recordConversationalAgentPreviewEffects,
  setConversationalAgentTestServiceDependenciesForTests
} from '../src/services/conversationalAgentTestService.js'
import { setConversationalAgentTestPaymentDependenciesForTests } from '../src/services/conversationalAgentTestPaymentService.js'
import {
  lockConversationalTesterConfigOverride,
  testAgent as testAgentController
} from '../src/controllers/conversationalAgentController.js'
import { createLocalAppointment, upsertLocalCalendar } from '../src/services/localCalendarService.js'
import { getAccountCurrency } from '../src/utils/accountLocale.js'
import { getAccountTimezone } from '../src/utils/dateUtils.js'
import { updateConversationalAgent } from '../src/services/conversationalAgentService.js'
import { withConversationalAgentTestMutationLock } from '../src/services/conversationalAgentTestMutationLockService.js'
import { runVersionedMigrations } from '../src/startup/runMigrations.js'

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
  } finally {
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
      createPaymentGateLink: async (config, options) => {
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
    })

    const effects = {
      enabled: true,
      scheduleAppointment: true,
      collectPayment: true,
      assignUser: true,
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
        assistantOfferQuote: 'martes a las 10:00'
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

    const assignmentRun = await prepareConversationalAgentTestRun({
      testRunId: runId,
      testMessageId: `message_assignment_${suffix}`,
      agentId,
      requestedByUserId: userId,
      contactId,
      effects
    })
    const assignment = await recordConversationalAgentPreviewEffects({
      runContext: assignmentRun,
      actions: [{
        type: 'send_to_human',
        motivo: 'La persona pidió apoyo',
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
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => {})
    await db.run('DELETE FROM product_prices WHERE id = ?', [priceId]).catch(() => {})
    await db.run('DELETE FROM products WHERE id = ?', [productId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
  }
})
