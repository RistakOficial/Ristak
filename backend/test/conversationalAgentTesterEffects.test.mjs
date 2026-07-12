import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

import { db } from '../src/config/database.js'
import {
  beginConversationalAgentTestEffect,
  cleanupConversationalAgentTestRun,
  ensureConversationalAgentTestEffectNotification,
  listConversationalAgentTestEffects,
  normalizeConversationalAgentTestEffects,
  prepareConversationalAgentTestRun,
  recordConversationalAgentPreviewEffects
} from '../src/services/conversationalAgentTestService.js'
import {
  lockConversationalTesterConfigOverride,
  testAgent as testAgentController
} from '../src/controllers/conversationalAgentController.js'
import { upsertLocalCalendar } from '../src/services/localCalendarService.js'
import { getAccountCurrency } from '../src/utils/accountLocale.js'
import { getAccountTimezone } from '../src/utils/dateUtils.js'

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
    notifyOwner: true
  })
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

test('efectos del tester son idempotentes, revalidan realidad, notifican una vez y nunca crean cita o pago real', async () => {
  const suffix = randomUUID()
  const agentId = `agent_test_effects_${suffix}`
  const contactId = `contact_test_effects_${suffix}`
  const calendarId = `calendar_test_effects_${suffix}`
  const productId = `product_test_effects_${suffix}`
  const priceId = `price_test_effects_${suffix}`
  const username = `tester_effects_${suffix}`
  const runId = `session_${suffix}`
  const appointmentMessageId = `message_appointment_${suffix}`
  const currency = await getAccountCurrency()
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 28 }).startOf('day')
  const slot = baseDay.set({ hour: 14, minute: 0, second: 0, millisecond: 0 })
  const capabilitiesConfig = {
    schemaVersion: 1,
    items: [
      { id: 'schedule_appointment', enabled: true, calendarId, bookingOwner: 'ai', allowOverlaps: false },
      { id: 'collect_payment', enabled: true, paymentMode: 'full_payment', productId, priceId }
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
       VALUES (?, 'Contacto elegido', '+526560000001', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
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
    await db.run(
      `INSERT INTO conversational_agents (id, name, enabled, runtime_mode, capabilities_config)
       VALUES (?, 'Agente tester', 1, 'tool_calling_v2', ?)`,
      [agentId, JSON.stringify(capabilitiesConfig)]
    )

    const effects = {
      enabled: true,
      scheduleAppointment: true,
      collectPayment: true,
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
      outcome: { status: 'simulated' }
    }
    const first = await recordConversationalAgentPreviewEffects({
      runContext: appointmentRun,
      actions: [appointmentAction]
    })
    assert.equal(first.length, 1)
    assert.equal(first[0].status, 'recorded')
    assert.equal(first[0].payload.appointmentCreated, false)
    appointmentEffectId = first[0].id
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?',
      [contactId]
    )).total), 0)

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
    assert.equal(payment[0].status, 'prepared')
    assert.equal(payment[0].payload.paymentCreated, false)
    assert.equal(payment[0].payload.linkSent, false)
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM payments WHERE contact_id = ?',
      [contactId]
    )).total), 0)

    await assert.rejects(
      listConversationalAgentTestEffects({ testRunId: runId, requestedByUserId: `${userId}-otro` }),
      (error) => error?.code === 'test_run_not_found'
    )

    const cleaned = await cleanupConversationalAgentTestRun({ testRunId: runId, requestedByUserId: userId })
    assert.equal(cleaned.cleaned, true)
    assert.ok(cleaned.effects.every((effect) => effect.status === 'cleaned'))
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
