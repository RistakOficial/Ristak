import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import { setAppointmentConfirmationClassifierForTest } from '../src/agents/appointmentConfirmationAgent.js'
import {
  handleInboundForConfirmation,
  processExpiredConfirmationWindows
} from '../src/services/appointmentConfirmationService.js'
import { createAppointmentReminder } from '../src/services/appointmentRemindersService.js'
import { setAppNotificationPayloadSenderForTest } from '../src/services/pushNotificationsService.js'
import { getContactJourney } from '../src/controllers/contactsController.js'

function isoFromNow(ms) {
  return new Date(Date.now() + ms).toISOString()
}

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString()
}

function makeResponseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    }
  }
}

async function expireWindow(windowId) {
  await db.run(
    'UPDATE appointment_confirmation_windows SET last_message_at = ?, updated_at = ? WHERE id = ?',
    [isoAgo(3 * 60 * 1000), isoAgo(3 * 60 * 1000), windowId]
  )
}

async function withConfirmationFixture({ confirmationSuccessAction = 'chat_card', noConfirmAction = 'no_action' } = {}, callback) {
  const suffix = randomUUID()
  const contactId = `contact_conf_${suffix}`
  const appointmentId = `appointment_conf_${suffix}`
  const sendId = `send_conf_${suffix}`
  let reminderId = ''
  const startTime = isoFromNow(60 * 60 * 1000)
  const endTime = isoFromNow(2 * 60 * 60 * 1000)

  try {
    await db.run(`
      INSERT INTO contacts (id, phone, first_name, full_name)
      VALUES (?, ?, 'Ana', 'Ana Confirmacion')
    `, [contactId, `+52155${Date.now().toString().slice(-8)}${suffix.slice(0, 4)}`])

    await db.run(`
      INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status,
        start_time, end_time, date_added, date_updated
      ) VALUES (?, 'calendar_confirmation_test', ?, 'Consulta dental', 'pending', 'pending', ?, ?, ?, ?)
    `, [appointmentId, contactId, startTime, endTime, isoAgo(5 * 60 * 1000), isoAgo(5 * 60 * 1000)])

    const reminder = await createAppointmentReminder({
      name: `Confirmacion IA ${suffix}`,
      messageType: 'confirmation',
      aiEnabled: true,
      confirmationSuccessAction,
      noConfirmAction,
      bypassAutomations: true,
      offsetValue: 1,
      offsetUnit: 'days',
      smartEnabled: false,
      senderMode: 'default'
    })
    reminderId = reminder.id

    await db.run(`
      INSERT INTO appointment_reminder_sends (
        id, reminder_id, appointment_id, contact_id, status,
        message_type, ai_enabled, send_at, sent_at
      ) VALUES (?, ?, ?, ?, 'sent', 'confirmation', 1, ?, ?)
    `, [sendId, reminderId, appointmentId, contactId, isoAgo(2 * 60 * 1000), isoAgo(2 * 60 * 1000)])

    return await callback({ contactId, appointmentId, sendId, reminderId, startTime })
  } finally {
    setAppointmentConfirmationClassifierForTest(null)
    setAppNotificationPayloadSenderForTest(null)
    await db.run('DELETE FROM appointment_confirmation_windows WHERE contact_id = ? OR appointment_id = ?', [contactId, appointmentId])
    await db.run('DELETE FROM appointment_reminder_sends WHERE id = ?', [sendId])
    if (reminderId) {
      await db.run('DELETE FROM appointment_reminders WHERE id = ?', [reminderId])
    }
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
}

test('confirmacion IA espera el ultimo mensaje del contacto y clasifica tras 2 minutos', async () => {
  await withConfirmationFixture({ confirmationSuccessAction: 'chat_badge' }, async ({ contactId, appointmentId, startTime }) => {
    const classifierCalls = []
    setAppointmentConfirmationClassifierForTest(async ({ accumulatedMessages }) => {
      classifierCalls.push([...accumulatedMessages])
      return { result: 'confirmed', confidence: 'high', reason: 'Confirmo asistencia' }
    })

    const firstInbound = await handleInboundForConfirmation({ contactId, text: 'Si confirmo' })
    assert.equal(firstInbound.windowActive, true)
    assert.equal(firstInbound.bypassAutomations, true)

    const secondInbound = await handleInboundForConfirmation({ contactId, text: 'ahi estare' })
    assert.equal(secondInbound.windowActive, true)

    const window = await db.get(
      'SELECT * FROM appointment_confirmation_windows WHERE contact_id = ? AND appointment_id = ?',
      [contactId, appointmentId]
    )
    assert.equal(window.status, 'waiting')
    assert.equal(window.confirmation_success_action, 'chat_badge')
    assert.deepEqual(JSON.parse(window.accumulated_messages), ['Si confirmo', 'ahi estare'])

    await processExpiredConfirmationWindows()
    const stillWaiting = await db.get('SELECT status FROM appointment_confirmation_windows WHERE id = ?', [window.id])
    assert.equal(stillWaiting.status, 'waiting')
    assert.equal(classifierCalls.length, 0)

    await expireWindow(window.id)
    await processExpiredConfirmationWindows()

    const done = await db.get('SELECT status, result, result_detail FROM appointment_confirmation_windows WHERE id = ?', [window.id])
    assert.equal(done.status, 'done')
    assert.equal(done.result, 'confirmed')
    assert.equal(done.result_detail, 'Confirmo asistencia')
    assert.deepEqual(classifierCalls, [['Si confirmo', 'ahi estare']])

    const appointment = await db.get(
      'SELECT status, appointment_status, confirmation_badge_until FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(appointment.status, 'confirmed')
    assert.equal(appointment.appointment_status, 'confirmed')
    assert.equal(appointment.confirmation_badge_until, startTime)
  })
})

test('accion chat_card crea evento de confirmacion en el journey del contacto', async () => {
  await withConfirmationFixture({ confirmationSuccessAction: 'chat_card' }, async ({ contactId, appointmentId }) => {
    setAppointmentConfirmationClassifierForTest(async () => ({
      result: 'confirmed',
      confidence: 'high',
      reason: 'Confirmo por WhatsApp'
    }))

    await handleInboundForConfirmation({ contactId, text: 'Claro, ahi voy' })
    const window = await db.get(
      'SELECT id FROM appointment_confirmation_windows WHERE contact_id = ? AND appointment_id = ?',
      [contactId, appointmentId]
    )
    await expireWindow(window.id)
    await processExpiredConfirmationWindows()

    const res = makeResponseRecorder()
    await getContactJourney({ params: { id: contactId }, query: {} }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)
    const card = res.payload.data.find(event => (
      event.type === 'appointment_confirmation' &&
      event.data?.appointment_id === appointmentId
    ))
    assert.ok(card)
    assert.equal(card.data.status, 'confirmed')
    assert.equal(card.data.result_detail, 'Confirmo por WhatsApp')
  })
})

test('accion notify_push envia payload push cuando la IA detecta confirmacion', async () => {
  await withConfirmationFixture({ confirmationSuccessAction: 'notify_push' }, async ({ contactId, appointmentId }) => {
    const payloads = []
    setAppointmentConfirmationClassifierForTest(async () => ({
      result: 'confirmed',
      confidence: 'high',
      reason: 'Confirmo asistencia'
    }))
    setAppNotificationPayloadSenderForTest(async (payload, options) => {
      payloads.push({ payload, options })
      return { sent: 1, webSent: 1, nativeSent: 0, skipped: false }
    })

    await handleInboundForConfirmation({ contactId, text: 'Confirmada' })
    const window = await db.get(
      'SELECT id FROM appointment_confirmation_windows WHERE contact_id = ? AND appointment_id = ?',
      [contactId, appointmentId]
    )
    await expireWindow(window.id)
    await processExpiredConfirmationWindows()

    assert.equal(payloads.length, 1)
    assert.equal(payloads[0].payload.title, 'Cita confirmada: Ana')
    assert.match(payloads[0].payload.body, /Consulta dental/)
    assert.equal(payloads[0].payload.tag, `conf-ok-${appointmentId}`)
    assert.equal(payloads[0].payload.url, `/phone/calendar?open=appointment&id=${encodeURIComponent(appointmentId)}`)

    const appointment = await db.get(
      'SELECT status, appointment_status, confirmation_badge_until FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(appointment.status, 'confirmed')
    assert.equal(appointment.appointment_status, 'confirmed')
    assert.equal(appointment.confirmation_badge_until, null)
  })
})

test('accion de no confirmacion en dropdown ejecuta push sin confirmar la cita', async () => {
  await withConfirmationFixture({
    confirmationSuccessAction: 'chat_badge',
    noConfirmAction: 'notify_push'
  }, async ({ contactId, appointmentId }) => {
    const payloads = []
    setAppointmentConfirmationClassifierForTest(async () => ({
      result: 'reschedule',
      confidence: 'high',
      reason: 'Quiere cambiar el horario'
    }))
    setAppNotificationPayloadSenderForTest(async (payload, options) => {
      payloads.push({ payload, options })
      return { sent: 1, webSent: 1, nativeSent: 0, skipped: false }
    })

    await handleInboundForConfirmation({ contactId, text: 'Mejor otro dia' })
    const window = await db.get(
      'SELECT id FROM appointment_confirmation_windows WHERE contact_id = ? AND appointment_id = ?',
      [contactId, appointmentId]
    )
    await expireWindow(window.id)
    await processExpiredConfirmationWindows()

    assert.equal(payloads.length, 1)
    assert.match(payloads[0].payload.title, /quiere reagendar/)
    assert.equal(payloads[0].payload.tag, `conf-${appointmentId}`)

    const appointment = await db.get(
      'SELECT status, appointment_status, confirmation_badge_until FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(appointment.status, 'pending')
    assert.equal(appointment.appointment_status, 'pending')
    assert.equal(appointment.confirmation_badge_until, null)
  })
})
