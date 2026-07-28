import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import { setAppointmentConfirmationClassifierForTest } from '../src/agents/appointmentConfirmationAgent.js'
import {
  handleInboundForConfirmation,
  maybeConfirmAppointmentFromReply,
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

function storedMessageTexts(raw) {
  return JSON.parse(raw || '[]').map(entry => (
    typeof entry === 'string' ? entry : entry?.text
  ))
}

async function withConfirmationFixture({
  confirmationSuccessAction = 'chat_card',
  confirmationSuccessActions,
  noConfirmAction = 'no_action',
  aiEnabled = true,
  bypassAutomations = true
} = {}, callback) {
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
      aiEnabled,
      ...(confirmationSuccessActions
        ? { confirmationSuccessActions }
        : { confirmationSuccessAction }),
      noConfirmAction,
      bypassAutomations,
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
      ) VALUES (?, ?, ?, ?, 'sent', 'confirmation', ?, ?, ?)
    `, [
      sendId,
      reminderId,
      appointmentId,
      contactId,
      aiEnabled ? 1 : 0,
      isoAgo(2 * 60 * 1000),
      isoAgo(2 * 60 * 1000)
    ])

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
    assert.deepEqual(
      JSON.parse(window.confirmation_success_action),
      ['chat_badge', 'mark_confirmed']
    )
    assert.equal(Number(window.message_revision), 2)
    assert.deepEqual(storedMessageTexts(window.accumulated_messages), ['Si confirmo', 'ahi estare'])

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

test('confirmacion IA acumula atomically mensajes concurrentes sin sobrescribirlos', async () => {
  await withConfirmationFixture({}, async ({ contactId, appointmentId }) => {
    const expectedMessages = [
      'Sí, confirmo',
      'pero necesito la dirección',
      'por favor'
    ]
    const classifierCalls = []
    setAppointmentConfirmationClassifierForTest(async ({ accumulatedMessages }) => {
      classifierCalls.push([...accumulatedMessages])
      return { result: 'ambiguous', confidence: 'medium', reason: 'Prueba de orden' }
    })

    await Promise.all([
      { text: expectedMessages[2], receivedAt: '2026-07-27T12:00:03.000Z', messageId: 'msg-3' },
      { text: expectedMessages[0], receivedAt: '2026-07-27T12:00:01.000Z', messageId: 'msg-1' },
      { text: expectedMessages[1], receivedAt: '2026-07-27T12:00:02.000Z', messageId: 'msg-2' }
    ].map(message => (
      handleInboundForConfirmation({ contactId, ...message })
    )))

    const window = await db.get(
      `SELECT id, accumulated_messages, message_revision
       FROM appointment_confirmation_windows
       WHERE contact_id = ? AND appointment_id = ?`,
      [contactId, appointmentId]
    )
    const storedMessages = storedMessageTexts(window.accumulated_messages)

    assert.equal(Number(window.message_revision), expectedMessages.length)
    // Las escrituras simultáneas se serializan en el orden que resuelva la BD.
    assert.deepEqual([...storedMessages].sort(), [...expectedMessages].sort())

    await expireWindow(window.id)
    await processExpiredConfirmationWindows()
    assert.deepEqual(classifierCalls[0], expectedMessages)
  })
})

test('confirmacion IA difiere la acción si entra otro mensaje mientras clasifica', async () => {
  await withConfirmationFixture({}, async ({ contactId, appointmentId }) => {
    let releaseClassifier
    let notifyClassifierStarted
    const classifierStarted = new Promise(resolve => { notifyClassifierStarted = resolve })
    const releaseClassification = new Promise(resolve => { releaseClassifier = resolve })
    const calls = []

    setAppointmentConfirmationClassifierForTest(async ({ accumulatedMessages }) => {
      calls.push([...accumulatedMessages])
      if (calls.length === 1) {
        notifyClassifierStarted()
        await releaseClassification
      }
      return { result: 'confirmed', confidence: 'high', reason: 'Confirmó asistencia' }
    })

    await handleInboundForConfirmation({ contactId, text: 'Sí, confirmo' })
    const window = await db.get(
      'SELECT id FROM appointment_confirmation_windows WHERE contact_id = ? AND appointment_id = ?',
      [contactId, appointmentId]
    )
    await expireWindow(window.id)

    const firstProcessing = processExpiredConfirmationWindows()
    await classifierStarted
    await handleInboundForConfirmation({ contactId, text: 'También necesito la dirección' })
    releaseClassifier()

    const firstOutcome = await firstProcessing
    assert.equal(firstOutcome.processed, 0)

    const deferred = await db.get(
      `SELECT status, accumulated_messages, message_revision
       FROM appointment_confirmation_windows
       WHERE id = ?`,
      [window.id]
    )
    assert.equal(deferred.status, 'waiting')
    assert.equal(Number(deferred.message_revision), 2)
    assert.deepEqual(
      storedMessageTexts(deferred.accumulated_messages),
      ['Sí, confirmo', 'También necesito la dirección']
    )

    const pendingAppointment = await db.get(
      'SELECT appointment_status FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(pendingAppointment.appointment_status, 'pending')

    await expireWindow(window.id)
    const secondOutcome = await processExpiredConfirmationWindows()
    assert.equal(secondOutcome.processed, 1)
    assert.deepEqual(calls[1], ['Sí, confirmo', 'También necesito la dirección'])

    const confirmedAppointment = await db.get(
      'SELECT appointment_status FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(confirmedAppointment.appointment_status, 'confirmed')
  })
})

test('accion chat_card crea evento de confirmacion en el journey del contacto', async () => {
  await withConfirmationFixture({ confirmationSuccessAction: 'chat_card' }, async ({ contactId, appointmentId }) => {
    const payloads = []
    setAppointmentConfirmationClassifierForTest(async () => ({
      result: 'confirmed',
      confidence: 'high',
      reason: 'Confirmo por WhatsApp'
    }))
    setAppNotificationPayloadSenderForTest(async (payload, options) => {
      payloads.push({ payload, options })
      return { sent: 1, webSent: 1, nativeSent: 0, skipped: false }
    })

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
    assert.equal(payloads.length, 0, 'chat_card no debe mandar push adicional')
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
    assert.equal(payloads[0].payload.title, '✅ Cita confirmada')
    assert.match(payloads[0].payload.body, /^Ana - /)
    assert.doesNotMatch(payloads[0].payload.body, /Consulta dental/)
    assert.match(payloads[0].payload.body, /Confirmo asistencia/)
    assert.equal(payloads[0].payload.tag, `appointment-confirmed-${appointmentId}`)
    assert.equal(payloads[0].payload.category, 'appointment_confirmed')
    assert.equal(payloads[0].payload.eventKey, 'appointment_confirmed')
    assert.equal(payloads[0].payload.url, `/movil/calendar?open=appointment&id=${encodeURIComponent(appointmentId)}`)

    const appointment = await db.get(
      'SELECT status, appointment_status, confirmation_badge_until FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(appointment.status, 'confirmed')
    assert.equal(appointment.appointment_status, 'confirmed')
    assert.equal(appointment.confirmation_badge_until, null)
  })
})

test('acciones múltiples ejecutan tarjeta, push y etiqueta en una sola confirmación', async () => {
  await withConfirmationFixture({
    confirmationSuccessActions: ['chat_card', 'notify_push', 'chat_badge', 'mark_confirmed']
  }, async ({ contactId, appointmentId, startTime }) => {
    const payloads = []
    setAppointmentConfirmationClassifierForTest(async () => ({
      result: 'confirmed',
      confidence: 'high',
      reason: 'Confirmó todas las acciones'
    }))
    setAppNotificationPayloadSenderForTest(async (payload, options) => {
      payloads.push({ payload, options })
      return { sent: 1, webSent: 1, nativeSent: 0, skipped: false }
    })

    await handleInboundForConfirmation({ contactId, text: 'Sí, nos vemos allá' })
    const window = await db.get(
      `SELECT id, confirmation_success_action
       FROM appointment_confirmation_windows
       WHERE contact_id = ? AND appointment_id = ?`,
      [contactId, appointmentId]
    )
    assert.deepEqual(
      JSON.parse(window.confirmation_success_action),
      ['chat_card', 'notify_push', 'chat_badge', 'mark_confirmed']
    )

    await expireWindow(window.id)
    await processExpiredConfirmationWindows()

    const appointment = await db.get(
      'SELECT status, appointment_status, confirmation_badge_until FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(appointment.status, 'confirmed')
    assert.equal(appointment.appointment_status, 'confirmed')
    assert.equal(appointment.confirmation_badge_until, startTime)
    assert.equal(payloads.length, 1)
    assert.equal(payloads[0].payload.category, 'appointment_confirmed')

    const res = makeResponseRecorder()
    await getContactJourney({ params: { id: contactId }, query: {} }, res)
    const card = res.payload.data.find(event => (
      event.type === 'appointment_confirmation' &&
      event.data?.appointment_id === appointmentId
    ))
    assert.ok(card)
    assert.equal(card.data.result_detail, 'Confirmó todas las acciones')
  })
})

test('modo sin IA confirma sólo respuestas afirmativas sin abrir ventana', async () => {
  await withConfirmationFixture({ aiEnabled: false }, async ({ contactId, appointmentId }) => {
    const windowResult = await handleInboundForConfirmation({ contactId, text: 'Sí, ahí estaré' })
    assert.equal(windowResult.windowActive, false)

    const confirmation = await maybeConfirmAppointmentFromReply({
      contactId,
      text: 'Sí, ahí estaré'
    })
    assert.equal(confirmation?.appointmentId, appointmentId)

    const window = await db.get(
      'SELECT id FROM appointment_confirmation_windows WHERE contact_id = ? AND appointment_id = ?',
      [contactId, appointmentId]
    )
    assert.equal(window, null)

    const appointment = await db.get(
      'SELECT appointment_status FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(appointment.appointment_status, 'confirmed')
  })
})

test('respuesta ambigua nunca cancela aunque la acción configurada sea cancelar', async () => {
  await withConfirmationFixture({
    noConfirmAction: 'cancel_appointment'
  }, async ({ contactId, appointmentId }) => {
    const payloads = []
    setAppointmentConfirmationClassifierForTest(async () => ({
      result: 'ambiguous',
      confidence: 'medium',
      reason: 'Sólo preguntó por la dirección'
    }))
    setAppNotificationPayloadSenderForTest(async (payload, options) => {
      payloads.push({ payload, options })
      return { sent: 1, webSent: 1, nativeSent: 0, skipped: false }
    })

    await handleInboundForConfirmation({ contactId, text: '¿Dónde es?' })
    const window = await db.get(
      'SELECT id FROM appointment_confirmation_windows WHERE contact_id = ? AND appointment_id = ?',
      [contactId, appointmentId]
    )
    await expireWindow(window.id)
    await processExpiredConfirmationWindows()

    const appointment = await db.get(
      'SELECT appointment_status FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(appointment.appointment_status, 'pending')
    assert.equal(payloads.length, 1)
    assert.match(payloads[0].payload.title, /respuesta ambigua/)
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
