import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import {
  db,
  parsePostgresTimestampWithoutTimezoneAsUtc
} from '../src/config/database.js'
import { dispatchAppointmentAutomationEvent } from '../src/services/appointmentAutomationService.js'
import {
  buildAppointmentTestActionKey,
  claimAppointmentTestAction
} from '../src/services/conversationalAppointmentTestAutomationAuditService.js'
import {
  executeSafeTestAppointmentReminders,
  processDueAppointmentReminders
} from '../src/services/appointmentRemindersService.js'
import { cleanupConversationalTestAppointment } from '../src/services/conversationalAppointmentTestCleanupService.js'
import { getLocalAppointment } from '../src/services/localCalendarService.js'

function unique(prefix) {
  return `${prefix}_${randomUUID()}`
}

test('PostgreSQL interpreta timestamp without time zone con el contrato UTC del CRM', () => {
  const parsed = parsePostgresTimestampWithoutTimezoneAsUtc('2026-07-13 16:00:00.123456')
  assert.ok(parsed instanceof Date)
  assert.equal(parsed.toISOString(), '2026-07-13T16:00:00.123Z')
})

async function insertUser(suffix, label = 'Dueño prueba') {
  const username = `${suffix}@example.com`
  const result = await db.run(
    `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
     VALUES (?, ?, 'test-hash', ?, 'admin', 1)`,
    [username, username, label]
  )
  return String(result.lastID || (await db.get('SELECT id FROM users WHERE username = ?', [username]))?.id || '')
}

async function insertTestFixture({ suffix, requestedByUserId, entityId = null } = {}) {
  const contactId = `contact_${suffix}`
  const runId = `run_${suffix}`
  const effectId = `effect_${suffix}`
  const appointmentId = entityId || `appointment_${suffix}`
  await db.run(
    `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields, tags)
     VALUES (?, ?, ?, 'Paty Prueba', 'Paty', '{}', '[]')`,
    [contactId, `+521${Date.now().toString().slice(-10)}`, `${suffix}@example.com`]
  )
  await db.run(`
    INSERT INTO conversational_agent_test_runs (
      id, agent_id, requested_by_user_id, contact_id, effects_json, status, expires_at
    ) VALUES (?, ?, ?, ?, '{}', 'active', '2099-07-12T18:05:00.000Z')
  `, [runId, `agent_${suffix}`, requestedByUserId, contactId])
  await db.run(`
    INSERT INTO conversational_agent_test_effects (
      id, run_id, message_id, effect_type, request_hash, status, entity_id,
      payload_json, cleanup_status
    ) VALUES (?, ?, ?, 'appointment', 'hash', 'recorded', ?, '{}', 'pending')
  `, [effectId, runId, `message_${suffix}`, appointmentId])
  await db.run(`
    INSERT INTO appointments (
      id, calendar_id, contact_id, title, status, appointment_status,
      start_time, end_time, source, is_test, test_run_id, test_effect_id, test_expires_at
    ) VALUES (?, 'calendar-test', ?, '[PRUEBA] Consulta', 'confirmed', 'confirmed',
      '2099-07-12T18:00:00.000Z', '2099-07-12T19:00:00.000Z',
      'conversational_agent_test', 1, ?, ?, '2099-07-12T18:05:00.000Z')
  `, [appointmentId, contactId, runId, effectId])
  return { contactId, runId, effectId, appointmentId }
}

async function deleteTestFixture({ fixture, automationId = '', userIds = [], reminderId = '' } = {}) {
  if (!fixture) return
  await db.run('DELETE FROM appointment_confirmation_windows WHERE appointment_id = ?', [fixture.appointmentId]).catch(() => {})
  await db.run('DELETE FROM appointment_reminder_sends WHERE appointment_id = ?', [fixture.appointmentId]).catch(() => {})
  if (reminderId) await db.run('DELETE FROM appointment_reminders WHERE id = ?', [reminderId]).catch(() => {})
  await db.run('DELETE FROM internal_notifications WHERE contact_id = ?', [fixture.contactId]).catch(() => {})
  await db.run('DELETE FROM automation_enrollments WHERE contact_id = ?', [fixture.contactId]).catch(() => {})
  if (automationId) await db.run('DELETE FROM automations WHERE id = ?', [automationId]).catch(() => {})
  await db.run('DELETE FROM conversational_appointment_test_automation_receipts WHERE test_effect_id = ?', [fixture.effectId]).catch(() => {})
  await db.run('DELETE FROM conversational_appointment_test_provider_receipts WHERE test_effect_id = ?', [fixture.effectId]).catch(() => {})
  await db.run('DELETE FROM appointment_participants WHERE appointment_id = ?', [fixture.appointmentId]).catch(() => {})
  await db.run('DELETE FROM appointments WHERE id = ?', [fixture.appointmentId]).catch(() => {})
  await db.run('DELETE FROM conversational_agent_test_effects WHERE id = ?', [fixture.effectId]).catch(() => {})
  await db.run('DELETE FROM conversational_agent_test_runs WHERE id = ?', [fixture.runId]).catch(() => {})
  await db.run('DELETE FROM contacts WHERE id = ?', [fixture.contactId]).catch(() => {})
  for (const userId of userIds) {
    await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
  }
}

test('Modo test envía webhook marcado y notificación sólo al dueño; mutaciones quedan simuladas e idempotentes', async () => {
  const suffix = unique('safe_automation')
  const automationId = `automation_${suffix}`
  const ownerUserId = await insertUser(`owner-${suffix}`, 'Dueño del test')
  const unrelatedUserId = await insertUser(`other-${suffix}`, 'Usuario que no debe recibir')
  const fixture = await insertTestFixture({ suffix, requestedByUserId: ownerUserId })
  const received = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    received.push({ headers: request.headers, body: JSON.parse(body || '{}') })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const webhookUrl = `http://127.0.0.1:${address.port}/appointment`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        config: { triggers: [{ id: 'booked', type: 'trigger-appointment-booked', config: {} }] }
      },
      {
        id: 'webhook',
        type: 'action-webhook',
        label: 'Webhook cita',
        config: { method: 'POST', url: webhookUrl, bodyMode: 'json', body: '{"kind":"appointment"}' }
      },
      {
        id: 'tag',
        type: 'action-add-contact-tag',
        label: 'Etiqueta peligrosa',
        config: { tag: `tag_${suffix}` }
      },
      {
        id: 'whatsapp',
        type: 'channel-whatsapp',
        label: 'Mensaje que no debe salir',
        config: { message: 'Este mensaje externo sólo debe simularse.' }
      },
      {
        id: 'notify',
        type: 'action-system-notification',
        label: 'Avisar equipo',
        config: {
          recipientMode: 'all',
          deliverToBell: true,
          deliverToPush: false,
          deliverToEmail: false,
          pushTitle: 'Cita creada',
          pushBody: 'Revisa a {{contact.fullName}}'
        }
      }
    ],
    edges: [
      { id: 'e1', sourceNodeId: 'start', targetNodeId: 'webhook' },
      { id: 'e2', sourceNodeId: 'webhook', sourceHandle: 'out', targetNodeId: 'tag' },
      { id: 'e3', sourceNodeId: 'tag', sourceHandle: 'out', targetNodeId: 'whatsapp' },
      { id: 'e4', sourceNodeId: 'whatsapp', sourceHandle: 'out', targetNodeId: 'notify' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: false }
  }

  try {
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, 'Automatización segura test', 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, JSON.stringify(flow), JSON.stringify(flow)]
    )
    const appointment = {
      id: fixture.appointmentId,
      contactId: fixture.contactId,
      calendarId: 'calendar-test',
      appointmentStatus: 'confirmed',
      status: 'confirmed',
      isTest: true,
      testRunId: fixture.runId,
      testEffectId: fixture.effectId,
      testExpiresAt: '2099-07-12T18:05:00.000Z'
    }
    const first = await dispatchAppointmentAutomationEvent('appointment-booked', appointment)
    const second = await dispatchAppointmentAutomationEvent('appointment-booked', appointment)

    assert.equal(first.executed, true)
    assert.equal(first.execution.realActionCount, 2, JSON.stringify(first.execution, null, 2))
    assert.equal(first.execution.simulatedActionCount, 2)
    assert.equal(second.executed, true)
    assert.equal(received.length, 1)
    assert.equal(received[0].headers['x-ristak-test-mode'], 'true')
    assert.equal(received[0].headers['x-ristak-test-run-id'], fixture.runId)
    assert.equal(received[0].headers['x-ristak-test-effect-id'], fixture.effectId)
    assert.match(received[0].headers['idempotency-key'], new RegExp(fixture.effectId))
    assert.equal(received[0].body.testMode, true)
    assert.equal(received[0].body.ristakTest.testEffectId, fixture.effectId)
    assert.equal(received[0].body.ristakTest.appointmentId, fixture.appointmentId)

    assert.equal((await db.get('SELECT tags FROM contacts WHERE id = ?', [fixture.contactId])).tags, '[]')
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM automation_enrollments WHERE automation_id = ?',
      [automationId]
    )).total), 0)
    const notifications = await db.all(
      'SELECT recipient_user_id, title, metadata_json FROM internal_notifications WHERE automation_id = ? AND automation_node_id = ?',
      [automationId, 'notify']
    )
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].recipient_user_id, ownerUserId)
    assert.match(notifications[0].title, /^Prueba · /)
    const metadata = JSON.parse(notifications[0].metadata_json)
    assert.equal(metadata.testMode, true)
    assert.equal(metadata.routedOnlyToTestOwner, true)
    assert.notEqual(notifications[0].recipient_user_id, unrelatedUserId)

    const receipts = await db.all(
      `SELECT action_type, execution_mode, status
       FROM conversational_appointment_test_automation_receipts
       WHERE test_effect_id = ? ORDER BY action_type`,
      [fixture.effectId]
    )
    assert.deepEqual(receipts, [
      { action_type: 'internal-notification', execution_mode: 'real', status: 'sent' },
      { action_type: 'irreversible-node', execution_mode: 'simulated', status: 'simulated' },
      { action_type: 'irreversible-node', execution_mode: 'simulated', status: 'simulated' },
      { action_type: 'webhook', execution_mode: 'real', status: 'sent' }
    ])
  } finally {
    server.close()
    await once(server, 'close').catch(() => {})
    await deleteTestFixture({ fixture, automationId, userIds: [ownerUserId, unrelatedUserId] })
  }
})

test('un webhook con resultado ambiguo nunca se reenvía y cleanup lo cierra como outcome_unknown', async () => {
  const suffix = unique('ambiguous_webhook')
  const automationId = `automation_${suffix}`
  const ownerUserId = await insertUser(`owner-${suffix}`)
  const fixture = await insertTestFixture({ suffix, requestedByUserId: ownerUserId })
  let received = 0
  const server = createServer((_request, response) => {
    received += 1
    response.writeHead(200)
    response.end('ok')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const flow = {
    nodes: [
      { id: 'start', type: 'start', config: { triggers: [{ id: 'booked', type: 'trigger-appointment-booked', config: {} }] } },
      { id: 'webhook', type: 'action-webhook', config: { method: 'POST', url: `http://127.0.0.1:${address.port}/ambiguous` } }
    ],
    edges: [{ id: 'edge', sourceNodeId: 'start', targetNodeId: 'webhook' }],
    settings: {}
  }

  try {
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, 'Webhook ambiguo', 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, JSON.stringify(flow), JSON.stringify(flow)]
    )
    const context = {
      testMode: true,
      testRunId: fixture.runId,
      testEffectId: fixture.effectId,
      appointmentId: fixture.appointmentId,
      eventType: 'appointment-booked',
      testExpiresAt: '2099-07-12T18:05:00.000Z'
    }
    const action = {
      automationId,
      automationName: 'Webhook ambiguo',
      nodeId: 'webhook',
      nodeType: 'action-webhook',
      actionType: 'webhook',
      request: { testMode: true }
    }
    const claim = await claimAppointmentTestAction(context, action)
    assert.equal(claim.claimed, true)
    assert.equal(claim.idempotencyKey, buildAppointmentTestActionKey(context, action))

    const result = await dispatchAppointmentAutomationEvent('appointment-booked', {
      id: fixture.appointmentId,
      contactId: fixture.contactId,
      calendarId: 'calendar-test',
      status: 'confirmed',
      appointmentStatus: 'confirmed',
      isTest: true,
      testRunId: fixture.runId,
      testEffectId: fixture.effectId,
      testExpiresAt: '2000-07-12T18:05:00.000Z'
    })
    assert.equal(received, 0)
    assert.equal(result.execution.failedActionCount, 1)
    assert.match(result.execution.matched[0].trace[0].detail, /no se reenvió/i)

    const cleanup = await cleanupConversationalTestAppointment({
      appointmentId: fixture.appointmentId,
      testEffectId: fixture.effectId
    })
    assert.equal(cleanup.status, 'cleaned')
    const receipt = await db.get(
      'SELECT status FROM conversational_appointment_test_automation_receipts WHERE id = ?',
      [claim.receipt.id]
    )
    assert.equal(receipt.status, 'outcome_unknown')
    const effectPayload = JSON.parse((await db.get(
      'SELECT payload_json FROM conversational_agent_test_effects WHERE id = ?',
      [fixture.effectId]
    )).payload_json)
    assert.equal(effectPayload.automationAudit.outcome_unknown, 1)
  } finally {
    server.close()
    await once(server, 'close').catch(() => {})
    await deleteTestFixture({ fixture, automationId, userIds: [ownerUserId] })
  }
})

test('recordatorios de cita test llegan sólo como copia interna y el cron jamás los manda al contacto', async () => {
  const suffix = unique('safe_reminder')
  const reminderId = `reminder_${suffix}`
  const ownerUserId = await insertUser(`owner-${suffix}`)
  const fixture = await insertTestFixture({ suffix, requestedByUserId: ownerUserId })

  try {
    await db.run(`
      INSERT INTO appointment_reminders (
        id, name, enabled, message_type, ai_enabled, channel, sender_mode,
        content_mode, timing_anchor, offset_value, offset_unit, message_text,
        smart_enabled, position
      ) VALUES (?, 'Aviso inmediato', 1, 'reminder', 0, 'whatsapp', 'contact',
        'direct', 'after_booking', 0, 'seconds', 'Hola {{contact.first_name}}, tu cita quedó lista.', 0, 9999)
    `, [reminderId])
    const appointment = await getLocalAppointment(fixture.appointmentId)
    assert.equal(appointment.startTime, '2099-07-12T18:00:00.000Z')
    assert.equal(appointment.endTime, '2099-07-12T19:00:00.000Z')
    assert.equal(appointment.testExpiresAt, '2099-07-12T18:05:00.000Z')
    // Los servicios internos tambien pueden recibir Date desde el driver. La
    // auditoria debe persistir un ISO UTC, nunca String(Date) dependiente del
    // locale del proceso.
    const first = await executeSafeTestAppointmentReminders({
      ...appointment,
      testExpiresAt: new Date(appointment.testExpiresAt)
    })
    const second = await executeSafeTestAppointmentReminders(appointment)
    assert.equal(first.executed, true)
    assert.equal(first.sentCount, 1)
    assert.equal(second.reminders.find((item) => item.reminderId === reminderId)?.idempotent, true)

    const notification = await db.get(
      `SELECT recipient_user_id, title, message, metadata_json
       FROM internal_notifications
       WHERE contact_id = ? AND category = 'appointment_reminder_test'`,
      [fixture.contactId]
    )
    assert.equal(notification.recipient_user_id, ownerUserId)
    assert.match(notification.title, /^Prueba · /)
    assert.match(notification.message, /No se envió al contacto/)
    assert.equal(JSON.parse(notification.metadata_json).externalDeliverySimulated, true)

    await processDueAppointmentReminders({ batchSize: 50 })
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM appointment_reminder_sends WHERE appointment_id = ?',
      [fixture.appointmentId]
    )).total), 0)

    const receipts = await db.all(
      `SELECT action_type, execution_mode, status
       FROM conversational_appointment_test_automation_receipts
       WHERE test_effect_id = ? AND node_id = ? ORDER BY action_type`,
      [fixture.effectId, reminderId]
    )
    assert.deepEqual(receipts, [
      { action_type: 'reminder-external-message', execution_mode: 'simulated', status: 'simulated' },
      { action_type: 'reminder-test-notification', execution_mode: 'real', status: 'sent' }
    ])
    const persistedExpiry = await db.get(
      `SELECT cleanup_due_at
       FROM conversational_appointment_test_automation_receipts
       WHERE test_effect_id = ? AND node_id = ? AND action_type = 'reminder-test-notification'`,
      [fixture.effectId, reminderId]
    )
    assert.equal(new Date(persistedExpiry.cleanup_due_at).toISOString(), '2099-07-12T18:05:00.000Z')
  } finally {
    await deleteTestFixture({ fixture, reminderId, userIds: [ownerUserId] })
  }
})
