import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db, setAppConfig } from '../src/config/database.js'
import { setAppointmentConfirmationClassifierForTest } from '../src/agents/appointmentConfirmationAgent.js'
import {
  handleInboundForConfirmation,
  maybeConfirmAppointmentFromReply,
  processExpiredConfirmationTimeouts,
  processExpiredConfirmationWindows,
  resolveAppointmentConfirmationFlow,
  setAppointmentConfirmationReplySenderForTest
} from '../src/services/appointmentConfirmationService.js'
import { createAppointmentReminder } from '../src/services/appointmentRemindersService.js'
import { setAppNotificationPayloadSenderForTest } from '../src/services/pushNotificationsService.js'
import { getContactById, getContactJourney } from '../src/controllers/contactsController.js'
import { updateAppointment } from '../src/controllers/calendarsController.js'

const TEST_CALENDAR_ID = 'calendar_confirmation_test'

await db.run(`
  INSERT INTO calendars (id, name, is_active, source)
  VALUES (?, 'Calendario de confirmaciones', 1, 'ristak')
  ON CONFLICT(id) DO NOTHING
`, [TEST_CALENDAR_ID])

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

async function expireConfirmationTimeout(sendId) {
  await db.run(`
    UPDATE appointment_reminder_sends
    SET confirmation_deadline_at = ?,
        confirmation_timeout_status = 'pending',
        confirmation_timeout_processed_at = NULL
    WHERE id = ?
  `, [isoAgo(60 * 1000), sendId])
}

async function withAppConfigValue(key, value, callback) {
  const previous = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    [key]
  )
  try {
    await setAppConfig(key, value)
    return await callback()
  } finally {
    await db.run('DELETE FROM app_config WHERE config_key = ?', [key])
    if (previous) {
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
      `, [key, previous.config_value])
    }
  }
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
  confirmationTimeoutValue = 6,
  confirmationTimeoutUnit = 'hours',
  aiEnabled = true,
  bypassAutomations = true,
  confirmationReplyText = '',
  channel = 'whatsapp',
  appointmentStatus = 'pending',
  reminderCalendarId = TEST_CALENDAR_ID,
  appointmentCalendarId = reminderCalendarId
} = {}, callback) {
  const suffix = randomUUID()
  const contactId = `contact_conf_${suffix}`
  const appointmentId = `appointment_conf_${suffix}`
  const sendId = `send_conf_${suffix}`
  let reminderId = ''
  const startTime = isoFromNow(60 * 60 * 1000)
  const endTime = isoFromNow(2 * 60 * 60 * 1000)

  try {
    for (const calendarId of new Set([reminderCalendarId, appointmentCalendarId])) {
      await db.run(`
        INSERT INTO calendars (id, name, is_active, source)
        VALUES (?, ?, 1, 'ristak')
        ON CONFLICT(id) DO NOTHING
      `, [calendarId, `Calendario ${calendarId}`])
    }

    await db.run(`
      INSERT INTO contacts (id, phone, email, first_name, full_name)
      VALUES (?, ?, ?, 'Ana', 'Ana Confirmacion')
    `, [
      contactId,
      `+52155${Date.now().toString().slice(-8)}${suffix.slice(0, 4)}`,
      `ana-${suffix}@example.test`
    ])

    await db.run(`
      INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status,
        start_time, end_time, date_added, date_updated
      ) VALUES (?, ?, ?, 'Consulta dental', ?, ?, ?, ?, ?, ?)
    `, [
      appointmentId,
      appointmentCalendarId,
      contactId,
      appointmentStatus,
      appointmentStatus,
      startTime,
      endTime,
      isoAgo(5 * 60 * 1000),
      isoAgo(5 * 60 * 1000)
    ])

    const reminder = await createAppointmentReminder({
      calendarId: reminderCalendarId,
      name: `Confirmacion IA ${suffix}`,
      messageType: 'confirmation',
      aiEnabled,
      channel,
      contentMode: channel === 'whatsapp' ? 'template' : 'direct',
      messageText: '¿Confirmas tu cita?',
      ...(confirmationSuccessActions
        ? { confirmationSuccessActions }
        : { confirmationSuccessAction }),
      noConfirmAction,
      confirmationReplyText,
      ...(noConfirmAction === 'cancel_appointment'
        ? { confirmationTimeoutValue, confirmationTimeoutUnit }
        : {}),
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
    setAppointmentConfirmationReplySenderForTest(null)
    setAppNotificationPayloadSenderForTest(null)
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM appointment_confirmation_windows WHERE contact_id = ? OR appointment_id = ?', [contactId, appointmentId])
    await db.run('DELETE FROM appointment_reminder_sends WHERE id = ?', [sendId])
    if (reminderId) {
      await db.run('DELETE FROM appointment_reminders WHERE id = ?', [reminderId])
    }
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    for (const calendarId of new Set([reminderCalendarId, appointmentCalendarId])) {
      if (calendarId !== TEST_CALENDAR_ID) {
        await db.run('DELETE FROM calendars WHERE id = ?', [calendarId])
      }
    }
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

test('confirmacion IA envia una sola respuesta libre por la misma linea de WhatsApp', async () => {
  await withConfirmationFixture({
    confirmationReplyText: 'Perfecto {{contact.first_name}}, te esperamos para {{cita.titulo}} el {{cita.fecha}} a las {{cita.hora}}.'
  }, async ({ contactId, appointmentId, sendId }) => {
    const inboundMessageId = `wa_inbound_confirmation_${randomUUID()}`
    const businessPhoneNumberId = `wa_phone_confirmation_${randomUUID()}`
    const contact = await db.get('SELECT phone FROM contacts WHERE id = ?', [contactId])
    const captures = []

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, contact_id, phone, from_phone, to_phone, business_phone,
        business_phone_number_id, transport, direction, message_type,
        message_text, message_timestamp
      ) VALUES (?, ?, ?, ?, '+526561234567', '+526561234567', ?, 'api', 'inbound', 'text', 'Sí confirmo', ?)
    `, [
      inboundMessageId,
      contactId,
      contact.phone,
      contact.phone,
      businessPhoneNumberId,
      isoAgo(3 * 60 * 1000)
    ])

    setAppointmentConfirmationClassifierForTest(async () => ({
      result: 'confirmed',
      confidence: 'high',
      reason: 'Confirmó su asistencia'
    }))
    setAppointmentConfirmationReplySenderForTest(async (payload) => {
      captures.push(payload)
      return { id: 'provider_confirmation_reply', localMessageId: 'local_confirmation_reply' }
    })

    await handleInboundForConfirmation({
      contactId,
      text: 'Sí confirmo',
      receivedAt: isoAgo(3 * 60 * 1000),
      messageId: inboundMessageId
    })
    const window = await db.get(
      'SELECT id FROM appointment_confirmation_windows WHERE contact_id = ? AND appointment_id = ?',
      [contactId, appointmentId]
    )
    await expireWindow(window.id)
    await processExpiredConfirmationWindows()

    assert.equal(captures.length, 1)
    assert.equal(captures[0].to, contact.phone)
    assert.equal(captures[0].from, '+526561234567')
    assert.equal(captures[0].phoneNumberId, businessPhoneNumberId)
    assert.equal(captures[0].transport, 'api')
    assert.equal(captures[0].allowQrFallback, true)
    assert.equal(captures[0].preferOfficialApiWhenReplyWindowOpen, true)
    assert.equal(captures[0].variablesResolved, true)
    assert.match(captures[0].text, /Perfecto Ana/)
    assert.match(captures[0].text, /Consulta dental/)
    assert.doesNotMatch(captures[0].text, /\{\{/)

    const send = await db.get(`
      SELECT confirmation_reply_sent_at, confirmation_reply_message_id
      FROM appointment_reminder_sends
      WHERE id = ?
    `, [sendId])
    assert.ok(send.confirmation_reply_sent_at)
    assert.equal(send.confirmation_reply_message_id, 'local_confirmation_reply')

    const secondInboundMessageId = `${inboundMessageId}_second`
    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, contact_id, phone, from_phone, to_phone, business_phone,
        business_phone_number_id, transport, direction, message_type,
        message_text, message_timestamp
      ) VALUES (?, ?, ?, ?, '+526561234567', '+526561234567', ?, 'api', 'inbound', 'text', 'Confirmado', ?)
    `, [
      secondInboundMessageId,
      contactId,
      contact.phone,
      contact.phone,
      businessPhoneNumberId,
      isoAgo(3 * 60 * 1000)
    ])
    const laterInbound = await handleInboundForConfirmation({
      contactId,
      text: 'Confirmado',
      receivedAt: isoAgo(3 * 60 * 1000),
      messageId: secondInboundMessageId
    })
    assert.equal(laterInbound.windowActive, false)

    assert.equal(captures.length, 1, 'la cortesía configurada debe enviarse una sola vez por confirmación')

    const terminalWindow = await db.get(`
      SELECT status, result, message_revision, accumulated_messages
      FROM appointment_confirmation_windows
      WHERE id = ?
    `, [window.id])
    assert.equal(terminalWindow.status, 'done')
    assert.equal(terminalWindow.result, 'confirmed')
    assert.equal(Number(terminalWindow.message_revision), 1)
    assert.deepEqual(storedMessageTexts(terminalWindow.accumulated_messages), ['Sí confirmo'])
  })
})

test('confirmacion IA respeta el canal elegido y responde por correo', async () => {
  await withConfirmationFixture({
    channel: 'email',
    confirmationReplyText: 'Gracias {{contact.first_name}}, tu cita quedó confirmada.'
  }, async ({ contactId, appointmentId, sendId }) => {
    const captures = []
    const contact = await db.get('SELECT email FROM contacts WHERE id = ?', [contactId])

    setAppointmentConfirmationClassifierForTest(async () => ({
      result: 'confirmed',
      confidence: 'high',
      reason: 'Confirmó por correo'
    }))
    setAppointmentConfirmationReplySenderForTest(async (payload) => {
      captures.push(payload)
      return { id: 'email_confirmation_reply' }
    })

    const wrongChannel = await handleInboundForConfirmation({
      contactId,
      text: 'Sí, ahí estaré',
      messageId: `messenger_inbound_${randomUUID()}`,
      channel: 'messenger'
    })
    assert.equal(wrongChannel.windowActive, false)

    const emailMessageId = `email_inbound_${randomUUID()}`
    const emailInbound = await handleInboundForConfirmation({
      contactId,
      text: 'Sí, confirmo por correo',
      receivedAt: isoAgo(3 * 60 * 1000),
      messageId: emailMessageId,
      channel: 'email'
    })
    assert.equal(emailInbound.windowActive, true)

    const window = await db.get(
      'SELECT id, accumulated_messages FROM appointment_confirmation_windows WHERE appointment_id = ?',
      [appointmentId]
    )
    assert.equal(JSON.parse(window.accumulated_messages)[0].channel, 'email')
    await expireWindow(window.id)
    await processExpiredConfirmationWindows()

    assert.equal(captures.length, 1)
    assert.equal(captures[0].to, contact.email)
    assert.equal(captures[0].channel, 'email')
    assert.match(captures[0].subject, /Cita confirmada/)
    assert.match(captures[0].text, /Gracias Ana/)

    const send = await db.get(
      'SELECT confirmation_reply_sent_at, confirmation_reply_message_id FROM appointment_reminder_sends WHERE id = ?',
      [sendId]
    )
    assert.ok(send.confirmation_reply_sent_at)
    assert.equal(send.confirmation_reply_message_id, 'email_confirmation_reply')
  })
})

test('confirmacion IA responde por la misma conversación de Instagram o Messenger', async () => {
  for (const channel of ['instagram', 'messenger']) {
    await withConfirmationFixture({
      channel,
      confirmationReplyText: 'Gracias {{contact.first_name}}, nos vemos en tu cita.'
    }, async ({ contactId, appointmentId }) => {
      const captures = []

      setAppointmentConfirmationClassifierForTest(async () => ({
        result: 'confirmed',
        confidence: 'high',
        reason: `Confirmó por ${channel}`
      }))
      setAppointmentConfirmationReplySenderForTest(async (payload) => {
        captures.push(payload)
        return { id: `${channel}_confirmation_reply` }
      })

      const inbound = await handleInboundForConfirmation({
        contactId,
        text: 'Sí, confirmo',
        receivedAt: isoAgo(3 * 60 * 1000),
        messageId: `${channel}_inbound_${randomUUID()}`,
        channel
      })
      assert.equal(inbound.windowActive, true)

      const window = await db.get(
        'SELECT id FROM appointment_confirmation_windows WHERE appointment_id = ?',
        [appointmentId]
      )
      await expireWindow(window.id)
      await processExpiredConfirmationWindows()

      assert.equal(captures.length, 1)
      assert.equal(captures[0].platform, channel)
      assert.equal(captures[0].channel, channel)
      assert.match(captures[0].message, /Gracias Ana/)
    })
  }
})

test('confirmacion IA terminada no reabre la ventana ni repite el push con mensajes posteriores', async () => {
  await withConfirmationFixture({}, async ({ contactId, appointmentId }) => {
    const classifierCalls = []
    const payloads = []
    setAppointmentConfirmationClassifierForTest(async ({ accumulatedMessages }) => {
      classifierCalls.push([...accumulatedMessages])
      return { result: 'confirmed', confidence: 'high', reason: 'Confirmó su asistencia' }
    })
    setAppNotificationPayloadSenderForTest(async (payload, options) => {
      payloads.push({ payload, options })
      return { sent: 1, webSent: 1, nativeSent: 0, skipped: false }
    })

    const confirmationInbound = await handleInboundForConfirmation({
      contactId,
      text: 'Hola, sí está bien, gracias'
    })
    assert.equal(confirmationInbound.windowActive, true)

    const window = await db.get(
      'SELECT id FROM appointment_confirmation_windows WHERE contact_id = ? AND appointment_id = ?',
      [contactId, appointmentId]
    )
    await expireWindow(window.id)
    const firstProcessing = await processExpiredConfirmationWindows()

    assert.equal(firstProcessing.processed, 1)
    assert.deepEqual(classifierCalls, [['Hola, sí está bien, gracias']])
    assert.equal(payloads.length, 1)
    assert.equal(payloads[0].payload.category, 'appointment_confirmed')

    const laterInbound = await handleInboundForConfirmation({
      contactId,
      text: 'Pásame el link o las instrucciones, por favor'
    })
    assert.equal(laterInbound.windowActive, false)

    const secondProcessing = await processExpiredConfirmationWindows()
    assert.equal(secondProcessing.processed, 0)
    assert.equal(classifierCalls.length, 1)
    assert.equal(payloads.length, 1)

    const terminalWindow = await db.get(`
      SELECT status, result, message_revision, accumulated_messages
      FROM appointment_confirmation_windows
      WHERE id = ?
    `, [window.id])
    assert.equal(terminalWindow.status, 'done')
    assert.equal(terminalWindow.result, 'confirmed')
    assert.equal(Number(terminalWindow.message_revision), 1)
    assert.deepEqual(
      storedMessageTexts(terminalWindow.accumulated_messages),
      ['Hola, sí está bien, gracias']
    )
  })
})

test('un envío nuevo tras reprogramar inicia una confirmacion limpia', async () => {
  await withConfirmationFixture({}, async ({ contactId, appointmentId, sendId, reminderId }) => {
    setAppointmentConfirmationClassifierForTest(async () => ({
      result: 'confirmed',
      confidence: 'high',
      reason: 'Confirmó el horario original'
    }))

    await handleInboundForConfirmation({ contactId, text: 'Sí, confirmo' })
    const originalWindow = await db.get(
      'SELECT id FROM appointment_confirmation_windows WHERE contact_id = ? AND appointment_id = ?',
      [contactId, appointmentId]
    )
    await expireWindow(originalWindow.id)
    await processExpiredConfirmationWindows()

    const replacementSendId = `send_conf_reprogrammed_${randomUUID()}`
    try {
      // La reprogramación elimina los envíos before_appointment para que el
      // cron pueda crear uno nuevo para el horario recalculado.
      await db.run('DELETE FROM appointment_reminder_sends WHERE id = ?', [sendId])
      await db.run(`
        INSERT INTO appointment_reminder_sends (
          id, reminder_id, appointment_id, contact_id, status,
          message_type, ai_enabled, send_at, sent_at
        ) VALUES (?, ?, ?, ?, 'sent', 'confirmation', 1, ?, ?)
      `, [
        replacementSendId,
        reminderId,
        appointmentId,
        contactId,
        isoAgo(2 * 60 * 1000),
        isoAgo(2 * 60 * 1000)
      ])

      const newInbound = await handleInboundForConfirmation({
        contactId,
        text: 'Confirmo el nuevo horario'
      })
      assert.equal(newInbound.windowActive, true)

      const resetWindow = await db.get(`
        SELECT reminder_send_id, status, result, result_detail, processed_at,
               message_revision, accumulated_messages
        FROM appointment_confirmation_windows
        WHERE id = ?
      `, [originalWindow.id])
      assert.equal(resetWindow.reminder_send_id, replacementSendId)
      assert.equal(resetWindow.status, 'waiting')
      assert.equal(resetWindow.result, null)
      assert.equal(resetWindow.result_detail, null)
      assert.equal(resetWindow.processed_at, null)
      assert.equal(Number(resetWindow.message_revision), 1)
      assert.deepEqual(
        storedMessageTexts(resetWindow.accumulated_messages),
        ['Confirmo el nuevo horario']
      )
    } finally {
      await db.run('DELETE FROM appointment_reminder_sends WHERE id = ?', [replacementSendId])
    }
  })
})

test('un fallo del mensaje de respuesta no revierte la confirmacion de la cita', async () => {
  await withConfirmationFixture({
    confirmationReplyText: 'Gracias por confirmar, te esperamos.'
  }, async ({ contactId, appointmentId, sendId }) => {
    const inboundMessageId = `wa_inbound_reply_failure_${randomUUID()}`
    const contact = await db.get('SELECT phone FROM contacts WHERE id = ?', [contactId])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, contact_id, phone, from_phone, to_phone, business_phone,
        transport, direction, message_type, message_text, message_timestamp
      ) VALUES (?, ?, ?, ?, '+526561234567', '+526561234567', 'api', 'inbound', 'text', 'Sí', ?)
    `, [inboundMessageId, contactId, contact.phone, contact.phone, isoAgo(3 * 60 * 1000)])

    setAppointmentConfirmationClassifierForTest(async () => ({
      result: 'confirmed',
      confidence: 'high',
      reason: 'Confirmó su asistencia'
    }))
    setAppointmentConfirmationReplySenderForTest(async () => {
      throw new Error('WhatsApp temporalmente no disponible')
    })

    await handleInboundForConfirmation({
      contactId,
      text: 'Sí',
      receivedAt: isoAgo(3 * 60 * 1000),
      messageId: inboundMessageId
    })
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
    const doneWindow = await db.get(
      'SELECT status, result FROM appointment_confirmation_windows WHERE id = ?',
      [window.id]
    )
    const send = await db.get(
      'SELECT confirmation_reply_sent_at FROM appointment_reminder_sends WHERE id = ?',
      [sendId]
    )
    assert.equal(appointment.appointment_status, 'confirmed')
    assert.equal(doneWindow.status, 'done')
    assert.equal(doneWindow.result, 'confirmed')
    assert.equal(send.confirmation_reply_sent_at, null)
  })
})

test('confirmacion IA procesa la respuesta aunque el calendario ya marque la cita como confirmada', async () => {
  await withConfirmationFixture({
    appointmentStatus: 'confirmed',
    confirmationSuccessAction: 'chat_badge'
  }, async ({ contactId, appointmentId, startTime }) => {
    setAppointmentConfirmationClassifierForTest(async () => ({
      result: 'confirmed',
      confidence: 'high',
      reason: 'Confirmó su asistencia'
    }))

    const inbound = await handleInboundForConfirmation({
      contactId,
      text: 'Sí, ahí estaré'
    })
    assert.equal(inbound.windowActive, true)

    const window = await db.get(
      'SELECT id FROM appointment_confirmation_windows WHERE contact_id = ? AND appointment_id = ?',
      [contactId, appointmentId]
    )
    assert.ok(window?.id)

    await expireWindow(window.id)
    await processExpiredConfirmationWindows()

    const done = await db.get(
      'SELECT status, result FROM appointment_confirmation_windows WHERE id = ?',
      [window.id]
    )
    assert.equal(done.status, 'done')
    assert.equal(done.result, 'confirmed')

    const appointment = await db.get(
      'SELECT appointment_status, confirmation_badge_until FROM appointments WHERE id = ?',
      [appointmentId]
    )
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

test('una acción manual gana si cierra la ventana mientras la IA todavía clasifica', async () => {
  await withConfirmationFixture({}, async ({ contactId, appointmentId, sendId }) => {
    let releaseClassifier
    let notifyClassifierStarted
    const classifierStarted = new Promise(resolve => { notifyClassifierStarted = resolve })
    const releaseClassification = new Promise(resolve => { releaseClassifier = resolve })
    const payloads = []

    setAppointmentConfirmationClassifierForTest(async () => {
      notifyClassifierStarted()
      await releaseClassification
      return { result: 'cancel', confidence: 'high', reason: 'La IA entendió una cancelación' }
    })
    setAppNotificationPayloadSenderForTest(async (payload, options) => {
      payloads.push({ payload, options })
      return { sent: 1, webSent: 1, nativeSent: 0, skipped: false }
    })

    await handleInboundForConfirmation({ contactId, text: 'Espera, déjame revisar' })
    const window = await db.get(
      'SELECT id FROM appointment_confirmation_windows WHERE appointment_id = ?',
      [appointmentId]
    )
    await expireWindow(window.id)

    const processing = processExpiredConfirmationWindows()
    await classifierStarted
    await db.run(`
      UPDATE appointments
      SET appointment_status = 'confirmed', status = 'confirmed'
      WHERE id = ?
    `, [appointmentId])
    await resolveAppointmentConfirmationFlow({
      appointmentId,
      result: 'manual_confirmed',
      resultDetail: 'Confirmada manualmente mientras la IA revisaba.'
    })
    releaseClassifier()

    const outcome = await processing
    assert.equal(outcome.processed, 0)
    assert.equal(payloads.length, 0)

    const terminalWindow = await db.get(
      'SELECT status, result FROM appointment_confirmation_windows WHERE id = ?',
      [window.id]
    )
    assert.equal(terminalWindow.status, 'done')
    assert.equal(terminalWindow.result, 'manual_confirmed')

    const send = await db.get(
      'SELECT confirmation_timeout_status FROM appointment_reminder_sends WHERE id = ?',
      [sendId]
    )
    assert.equal(send.confirmation_timeout_status, 'confirmed')
  })
})

test('accion chat_card crea evento y el push global se procesa por defecto', async () => {
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
    assert.equal(payloads.length, 1)
    assert.equal(payloads[0].payload.category, 'appointment_confirmed')
  })
})

test('la preferencia global puede apagar el push automático de confirmaciones', async () => {
  await withAppConfigValue('notification_preferences_matrix', {
    version: 1,
    rows: {
      all: { appointment_confirmed: 'off' },
      admins: { appointment_confirmed: 'off' }
    }
  }, async () => {
    await withConfirmationFixture({ confirmationSuccessAction: 'chat_card' }, async ({ contactId, appointmentId }) => {
      const payloads = []
      setAppointmentConfirmationClassifierForTest(async () => ({
        result: 'confirmed',
        confidence: 'high',
        reason: 'Confirmó asistencia'
      }))
      setAppNotificationPayloadSenderForTest(async (payload, options) => {
        payloads.push({ payload, options })
        return { sent: 1, webSent: 1, nativeSent: 0, skipped: false }
      })

      await handleInboundForConfirmation({ contactId, text: 'Sí confirmo' })
      const window = await db.get(
        'SELECT id FROM appointment_confirmation_windows WHERE appointment_id = ?',
        [appointmentId]
      )
      await expireWindow(window.id)
      await processExpiredConfirmationWindows()

      assert.equal(payloads.length, 0)
    })
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
  await withConfirmationFixture({
    aiEnabled: false,
    appointmentStatus: 'confirmed',
    noConfirmAction: 'cancel_appointment',
    confirmationTimeoutValue: 30,
    confirmationTimeoutUnit: 'minutes'
  }, async ({ contactId, appointmentId, sendId }) => {
    await db.run(`
      UPDATE appointment_reminder_sends
      SET confirmation_deadline_at = ?,
          confirmation_timeout_status = 'pending'
      WHERE id = ?
    `, [isoFromNow(30 * 60 * 1000), sendId])

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

    const send = await db.get(`
      SELECT confirmation_timeout_status, confirmation_timeout_processed_at
      FROM appointment_reminder_sends
      WHERE id = ?
    `, [sendId])
    assert.equal(send.confirmation_timeout_status, 'confirmed')
    assert.ok(send.confirmation_timeout_processed_at)

    const repeatedConfirmation = await maybeConfirmAppointmentFromReply({
      contactId,
      text: 'Sí, ya confirmé'
    })
    assert.equal(repeatedConfirmation, null)
  })
})

test('una resolución manual cierra la espera y la retira del detalle del chat', async () => {
  await withConfirmationFixture({}, async ({ contactId, appointmentId, sendId }) => {
    const detailBefore = makeResponseRecorder()
    await getContactById({ params: { id: contactId }, query: {} }, detailBefore)
    assert.equal(detailBefore.payload.data.activeAppointmentConfirmation?.id, appointmentId)
    assert.equal(detailBefore.payload.data.activeAppointmentConfirmation?.reminderSendId, sendId)

    const inbound = await handleInboundForConfirmation({ contactId, text: 'Todavía lo estoy revisando' })
    assert.equal(inbound.windowActive, true)

    const updateResponse = makeResponseRecorder()
    await updateAppointment({
      params: { id: appointmentId },
      query: {},
      body: {
        appointmentStatus: 'confirmed',
        expectedAppointmentStatus: 'pending'
      }
    }, updateResponse)
    assert.equal(updateResponse.statusCode, 200)

    const window = await db.get(`
      SELECT status, result, result_detail
      FROM appointment_confirmation_windows
      WHERE appointment_id = ?
    `, [appointmentId])
    assert.equal(window.status, 'done')
    assert.equal(window.result, 'manual_confirmed')
    assert.match(window.result_detail, /confirmó manualmente/i)

    const send = await db.get(
      'SELECT confirmation_timeout_status FROM appointment_reminder_sends WHERE id = ?',
      [sendId]
    )
    assert.equal(send.confirmation_timeout_status, 'confirmed')

    const repeatedInbound = await handleInboundForConfirmation({
      contactId,
      text: '¿Me mandas la ubicación?'
    })
    assert.equal(repeatedInbound.windowActive, false)

    const detailAfter = makeResponseRecorder()
    await getContactById({ params: { id: contactId }, query: {} }, detailAfter)
    assert.equal(detailAfter.payload.data.activeAppointmentConfirmation, null)
  })
})

test('cancelar manualmente cierra la espera y rechaza una acción basada en estado viejo', async () => {
  await withConfirmationFixture({}, async ({ contactId, appointmentId, sendId }) => {
    const staleResponse = makeResponseRecorder()
    await updateAppointment({
      params: { id: appointmentId },
      query: {},
      body: {
        appointmentStatus: 'cancelled',
        expectedAppointmentStatus: 'confirmed',
        strictLifecycleMutation: 'cancel'
      }
    }, staleResponse)
    assert.equal(staleResponse.statusCode, 409)
    assert.equal(staleResponse.payload.code, 'appointment_status_stale')

    const stillPending = await db.get(
      'SELECT appointment_status FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(stillPending.appointment_status, 'pending')

    const cancelResponse = makeResponseRecorder()
    await updateAppointment({
      params: { id: appointmentId },
      query: {},
      body: {
        appointmentStatus: 'cancelled',
        expectedAppointmentStatus: 'pending',
        strictLifecycleMutation: 'cancel'
      }
    }, cancelResponse)
    assert.equal(cancelResponse.statusCode, 200)
    assert.equal(cancelResponse.payload.data.appointmentStatus, 'cancelled')
    assert.equal(cancelResponse.payload.data.status, 'cancelled')

    const cancelled = await db.get(
      'SELECT appointment_status, status FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(cancelled.appointment_status, 'cancelled')
    assert.equal(cancelled.status, 'cancelled')

    const send = await db.get(
      'SELECT confirmation_timeout_status FROM appointment_reminder_sends WHERE id = ?',
      [sendId]
    )
    assert.equal(send.confirmation_timeout_status, 'responded')

    const laterInbound = await handleInboundForConfirmation({
      contactId,
      text: 'Oye, mejor sí quiero otra fecha'
    })
    assert.equal(laterInbound.windowActive, false)

    const detail = makeResponseRecorder()
    await getContactById({ params: { id: contactId }, query: {} }, detail)
    assert.equal(detail.payload.data.activeAppointmentConfirmation, null)
  })
})

test('respuesta ambigua nunca cancela, avisa una vez y cierra la escucha automática', async () => {
  await withConfirmationFixture({
    noConfirmAction: 'cancel_appointment'
  }, async ({ contactId, appointmentId, sendId }) => {
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

    const laterInbound = await handleInboundForConfirmation({
      contactId,
      text: 'También necesito saber si hay estacionamiento'
    })
    assert.equal(laterInbound.windowActive, false)
    await processExpiredConfirmationWindows()
    assert.equal(payloads.length, 1)

    const terminalWindow = await db.get(`
      SELECT status, result, message_revision
      FROM appointment_confirmation_windows
      WHERE id = ?
    `, [window.id])
    assert.equal(terminalWindow.status, 'done')
    assert.equal(terminalWindow.result, 'ambiguous')
    assert.equal(Number(terminalWindow.message_revision), 1)

    const send = await db.get(
      'SELECT confirmation_timeout_status FROM appointment_reminder_sends WHERE id = ?',
      [sendId]
    )
    assert.equal(send.confirmation_timeout_status, 'responded')
  })
})

test('el ultimátum empieza al enviarse y cancela sólo después de vencer sin respuesta', async () => {
  await withConfirmationFixture({
    appointmentStatus: 'confirmed',
    noConfirmAction: 'cancel_appointment',
    confirmationTimeoutValue: 30,
    confirmationTimeoutUnit: 'minutes'
  }, async ({ appointmentId, sendId }) => {
    const payloads = []
    setAppNotificationPayloadSenderForTest(async (payload, options) => {
      payloads.push({ payload, options })
      return { sent: 1, webSent: 1, nativeSent: 0, skipped: false }
    })

    await db.run(`
      UPDATE appointment_reminder_sends
      SET confirmation_deadline_at = ?,
          confirmation_timeout_status = 'pending'
      WHERE id = ?
    `, [isoFromNow(30 * 60 * 1000), sendId])

    const early = await processExpiredConfirmationTimeouts()
    assert.equal(early.processed, 0)

    await expireConfirmationTimeout(sendId)
    const expired = await processExpiredConfirmationTimeouts()
    assert.equal(expired.processed, 1)
    assert.equal(expired.cancelled, 1)

    const appointment = await db.get(
      'SELECT appointment_status FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(appointment.appointment_status, 'cancelled')

    const send = await db.get(`
      SELECT confirmation_timeout_status, confirmation_timeout_processed_at
      FROM appointment_reminder_sends
      WHERE id = ?
    `, [sendId])
    assert.equal(send.confirmation_timeout_status, 'cancelled')
    assert.ok(send.confirmation_timeout_processed_at)
    assert.equal(payloads.length, 1)
    assert.match(payloads[0].payload.title, /cancelada por falta de confirmación/i)
  })
})

test('un ultimátum heredado no cancela citas de otro calendario', async () => {
  const otherCalendarId = `calendar_confirmation_other_${randomUUID()}`
  await withConfirmationFixture({
    reminderCalendarId: TEST_CALENDAR_ID,
    appointmentCalendarId: otherCalendarId,
    noConfirmAction: 'cancel_appointment',
    confirmationTimeoutValue: 30,
    confirmationTimeoutUnit: 'minutes'
  }, async ({ appointmentId, sendId }) => {
    await expireConfirmationTimeout(sendId)
    const result = await processExpiredConfirmationTimeouts()

    assert.equal(result.processed, 1)
    assert.equal(result.cancelled, 0)

    const appointment = await db.get(
      'SELECT appointment_status FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(appointment.appointment_status, 'pending')

    const send = await db.get(
      'SELECT confirmation_timeout_status FROM appointment_reminder_sends WHERE id = ?',
      [sendId]
    )
    assert.equal(send.confirmation_timeout_status, 'disabled')
  })
})

test('el plazo también aplica al conservar la cita y avisa sin cancelarla', async () => {
  await withConfirmationFixture({
    noConfirmAction: 'no_action'
  }, async ({ appointmentId, sendId }) => {
    const payloads = []
    setAppNotificationPayloadSenderForTest(async (payload, options) => {
      payloads.push({ payload, options })
      return { sent: 1, webSent: 1, nativeSent: 0, skipped: false }
    })

    await expireConfirmationTimeout(sendId)
    const result = await processExpiredConfirmationTimeouts()

    assert.equal(result.processed, 1)
    assert.equal(result.cancelled, 0)
    assert.equal(result.preserved, 1)

    const appointment = await db.get(
      'SELECT appointment_status FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(appointment.appointment_status, 'pending')

    const send = await db.get(
      'SELECT confirmation_timeout_status FROM appointment_reminder_sends WHERE id = ?',
      [sendId]
    )
    assert.equal(send.confirmation_timeout_status, 'preserved')
    assert.equal(payloads.length, 1)
    assert.match(payloads[0].payload.title, /confirmación no recibida/i)
  })
})

test('una respuesta recibida antes del límite difiere el ultimátum hasta terminar de analizarla', async () => {
  await withConfirmationFixture({
    noConfirmAction: 'cancel_appointment',
    confirmationTimeoutValue: 30,
    confirmationTimeoutUnit: 'minutes'
  }, async ({ contactId, appointmentId, sendId }) => {
    setAppointmentConfirmationClassifierForTest(async () => ({
      result: 'confirmed',
      confidence: 'high',
      reason: 'Confirmó antes del límite'
    }))

    await handleInboundForConfirmation({ contactId, text: 'Sí, confirmo' })
    await expireConfirmationTimeout(sendId)

    const whileWaiting = await processExpiredConfirmationTimeouts()
    assert.equal(whileWaiting.processed, 0)

    const pendingAppointment = await db.get(
      'SELECT appointment_status FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(pendingAppointment.appointment_status, 'pending')

    const window = await db.get(
      'SELECT id FROM appointment_confirmation_windows WHERE reminder_send_id = ?',
      [sendId]
    )
    await expireWindow(window.id)
    await processExpiredConfirmationWindows()

    const afterClassification = await processExpiredConfirmationTimeouts()
    assert.equal(afterClassification.processed, 0)
    assert.equal(afterClassification.cancelled, 0)

    const appointment = await db.get(
      'SELECT appointment_status FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(appointment.appointment_status, 'confirmed')

    const send = await db.get(
      'SELECT confirmation_timeout_status FROM appointment_reminder_sends WHERE id = ?',
      [sendId]
    )
    assert.equal(send.confirmation_timeout_status, 'confirmed')
  })
})

test('una falla técnica del clasificador conserva la cita, avisa una vez y cierra la escucha', async () => {
  await withConfirmationFixture({
    noConfirmAction: 'cancel_appointment',
    confirmationTimeoutValue: 30,
    confirmationTimeoutUnit: 'minutes'
  }, async ({ contactId, appointmentId, sendId }) => {
    const payloads = []
    setAppointmentConfirmationClassifierForTest(async () => null)
    setAppNotificationPayloadSenderForTest(async (payload, options) => {
      payloads.push({ payload, options })
      return { sent: 1, webSent: 1, nativeSent: 0, skipped: false }
    })

    await handleInboundForConfirmation({ contactId, text: 'Sí, ahí estaré' })
    const window = await db.get(
      'SELECT id FROM appointment_confirmation_windows WHERE reminder_send_id = ?',
      [sendId]
    )
    await expireWindow(window.id)
    await processExpiredConfirmationWindows()

    const result = await processExpiredConfirmationTimeouts()
    assert.equal(result.processed, 0)
    assert.equal(result.reviewRequired, 0)
    assert.equal(result.cancelled, 0)

    const appointment = await db.get(
      'SELECT appointment_status FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(appointment.appointment_status, 'pending')

    const send = await db.get(
      'SELECT confirmation_timeout_status FROM appointment_reminder_sends WHERE id = ?',
      [sendId]
    )
    assert.equal(send.confirmation_timeout_status, 'responded')
    assert.equal(payloads.length, 1)
    assert.match(payloads[0].payload.title, /requiere atención humana/i)
  })
})

test('un ultimátum creado por Automatizaciones usa su snapshot sin una regla visible en Citas', async () => {
  const suffix = randomUUID()
  const contactId = `contact_auto_timeout_${suffix}`
  const appointmentId = `appointment_auto_timeout_${suffix}`
  const sendId = `send_auto_timeout_${suffix}`
  try {
    await db.run(`
      INSERT INTO contacts (id, phone, first_name, full_name)
      VALUES (?, ?, 'Ana', 'Ana Automatización')
    `, [contactId, `+52155${Date.now().toString().slice(-8)}${suffix.slice(0, 4)}`])
    await db.run(`
      INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status,
        start_time, end_time, date_added, date_updated
      ) VALUES (?, ?, ?, 'Consulta automatizada', 'confirmed', 'confirmed', ?, ?, ?, ?)
    `, [
      appointmentId,
      TEST_CALENDAR_ID,
      contactId,
      isoFromNow(60 * 60 * 1000),
      isoFromNow(2 * 60 * 60 * 1000),
      isoAgo(10 * 60 * 1000),
      isoAgo(10 * 60 * 1000)
    ])
    await db.run(`
      INSERT INTO appointment_reminder_sends (
        id, reminder_id, appointment_id, contact_id, status, message_type,
        ai_enabled, send_at, sent_at, confirmation_deadline_at,
        confirmation_timeout_status, source_type, source_id, source_config
      ) VALUES (?, ?, ?, ?, 'sent', 'confirmation', 1, ?, ?, ?, 'pending',
        'automation', ?, ?)
    `, [
      sendId,
      `automation-confirmation:${suffix}`,
      appointmentId,
      contactId,
      isoAgo(10 * 60 * 1000),
      isoAgo(10 * 60 * 1000),
      isoAgo(60 * 1000),
      `automation:${suffix}`,
      JSON.stringify({
        calendarId: TEST_CALENDAR_ID,
        noConfirmAction: 'cancel_appointment',
        bypassAutomations: true,
        confirmationSuccessAction: '["chat_card","mark_confirmed"]',
        confirmationReplyText: 'Confirmada.'
      })
    ])

    const result = await processExpiredConfirmationTimeouts()
    assert.equal(result.processed, 1)
    assert.equal(result.cancelled, 1)
    const appointment = await db.get(
      'SELECT appointment_status FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(appointment.appointment_status, 'cancelled')
  } finally {
    await db.run('DELETE FROM appointment_confirmation_windows WHERE appointment_id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM appointment_reminder_sends WHERE id = ?', [sendId]).catch(() => undefined)
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('la acción legacy notify_push se trata como conservar y el push sigue siendo global', async () => {
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
    assert.equal(payloads[0].payload.tag, `confirmation-response-${appointmentId}`)

    const appointment = await db.get(
      'SELECT status, appointment_status, confirmation_badge_until FROM appointments WHERE id = ?',
      [appointmentId]
    )
    assert.equal(appointment.status, 'pending')
    assert.equal(appointment.appointment_status, 'pending')
    assert.equal(appointment.confirmation_badge_until, null)
  })
})
