import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  enrollContactManually,
  handleAutomationEvent,
  processDueResumes
} from '../src/services/automationEngine.js'
import {
  setAutomationAppointmentConfirmationSenderForTest
} from '../src/services/appointmentRemindersService.js'
import { ensureDefaultAppointmentMessageTemplates } from '../src/services/messageTemplatesService.js'
import {
  handleInboundForConfirmation,
  processExpiredConfirmationWindows,
  setAppointmentConfirmationReplySenderForTest
} from '../src/services/appointmentConfirmationService.js'
import { setAppointmentConfirmationClassifierForTest } from '../src/agents/appointmentConfirmationAgent.js'

test('Marcar asistencia actualiza la cita exacta y registra una señal idempotente', async () => {
  const suffix = randomUUID()
  const automationId = `automation_attendance_${suffix}`
  const contactId = `contact_attendance_${suffix}`
  const selectedCalendarId = `calendar_attendance_${suffix}`
  const otherCalendarId = `calendar_attendance_other_${suffix}`
  const selectedAppointmentId = `appointment_attendance_${suffix}`
  const otherAppointmentId = `appointment_attendance_other_${suffix}`
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000)
  const end = new Date(start.getTime() + 60 * 60 * 1000)
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: { triggers: [] }
      },
      {
        id: 'mark-attendance',
        type: 'action-appointment-upsert',
        label: 'Crear / actualizar cita',
        config: {
          mode: 'mark_attendance',
          calendar: selectedCalendarId
        }
      }
    ],
    edges: [
      {
        id: 'edge-start-attendance',
        sourceNodeId: 'start',
        sourceHandle: 'out',
        targetNodeId: 'mark-attendance',
        targetHandle: 'in'
      }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: false }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+521${Date.now().toString().slice(-10)}`,
        `attendance-${suffix}@test.com`,
        'Contacto Asistencia',
        'Contacto',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO calendars (
         id, name, event_title, is_active, slot_duration, slot_duration_unit,
         source, open_hours, availability_schedule_configured
       ) VALUES (?, ?, 'Consulta', 1, 60, 'mins', 'ristak', '[]', 0),
                (?, ?, 'Consulta alterna', 1, 60, 'mins', 'ristak', '[]', 0)`,
      [selectedCalendarId, 'Calendario atribuido', otherCalendarId, 'Otro calendario']
    )
    await db.run(
      `INSERT INTO appointments (
         id, calendar_id, contact_id, title, status, appointment_status,
         start_time, end_time, date_added, date_updated
       ) VALUES (?, ?, ?, 'Consulta correcta', 'confirmed', 'confirmed', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
                (?, ?, ?, 'Consulta de otro calendario', 'confirmed', 'confirmed', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        selectedAppointmentId,
        selectedCalendarId,
        contactId,
        start.toISOString(),
        end.toISOString(),
        otherAppointmentId,
        otherCalendarId,
        contactId,
        start.toISOString(),
        end.toISOString()
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, 'Test marcar asistencia', 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, JSON.stringify(flow), JSON.stringify(flow)]
    )

    const firstEnrollment = await enrollContactManually({ automationId, contactId })
    assert.equal(firstEnrollment.status, 'completed')

    const selected = await db.get(
      'SELECT status, appointment_status FROM appointments WHERE id = ?',
      [selectedAppointmentId]
    )
    const other = await db.get(
      'SELECT status, appointment_status FROM appointments WHERE id = ?',
      [otherAppointmentId]
    )
    assert.equal(selected.status, 'showed')
    assert.equal(selected.appointment_status, 'showed')
    assert.equal(other.status, 'confirmed')
    assert.equal(other.appointment_status, 'confirmed')

    const signal = await db.get(
      `SELECT contact_id, appointment_id, source
       FROM appointment_attendance_signals
       WHERE contact_id = ? AND appointment_id = ?`,
      [contactId, selectedAppointmentId]
    )
    assert.deepEqual(signal, {
      contact_id: contactId,
      appointment_id: selectedAppointmentId,
      source: 'automation_mark_attendance'
    })

    const secondEnrollment = await enrollContactManually({ automationId, contactId })
    assert.equal(secondEnrollment.status, 'completed')
    const signalCount = await db.get(
      `SELECT COUNT(*) AS total
       FROM appointment_attendance_signals
       WHERE contact_id = ? AND appointment_id = ?`,
      [contactId, selectedAppointmentId]
    )
    assert.equal(Number(signalCount.total), 1)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId]).catch(() => undefined)
    await db.run('DELETE FROM automations WHERE id = ?', [automationId]).catch(() => undefined)
    await db.run('DELETE FROM appointment_attendance_signals WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM appointments WHERE id IN (?, ?)', [selectedAppointmentId, otherAppointmentId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id IN (?, ?)', [selectedCalendarId, otherCalendarId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('Confirmar cita espera su horario, envía una sola vez y guarda la configuración del flujo', async () => {
  const suffix = randomUUID()
  const automationId = `automation_confirmation_${suffix}`
  const contactId = `contact_confirmation_${suffix}`
  const calendarId = `calendar_confirmation_${suffix}`
  const appointmentId = `appointment_confirmation_${suffix}`
  const appointmentStart = new Date(Date.now() + 24 * 60 * 60 * 1000)
  const appointmentEnd = new Date(appointmentStart.getTime() + 60 * 60 * 1000)
  let sendCount = 0

  try {
    await ensureDefaultAppointmentMessageTemplates({ submitToActiveProvider: false })
    const template = await db.get(`
      SELECT id, name, language
      FROM whatsapp_message_templates
      WHERE name = 'confirmacion_cita_dia_anterior'
      ORDER BY created_at ASC
      LIMIT 1
    `)
    assert.ok(template?.id)

    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, 'Contacto Confirmación', 'Contacto', '{}')`,
      [contactId, `+521${Date.now().toString().slice(-10)}`, `confirmation-${suffix}@test.com`]
    )
    await db.run(
      `INSERT INTO calendars (
         id, name, event_title, is_active, slot_duration, slot_duration_unit,
         source, open_hours, availability_schedule_configured
       ) VALUES (?, 'Calendario confirmación', 'Consulta', 1, 60, 'mins', 'ristak', '[]', 0)`,
      [calendarId]
    )
    await db.run(
      `INSERT INTO appointments (
         id, calendar_id, contact_id, title, status, appointment_status,
         start_time, end_time, date_added, date_updated, source
       ) VALUES (?, ?, ?, 'Consulta por confirmar', 'confirmed', 'confirmed', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'ristak')`,
      [appointmentId, calendarId, contactId, appointmentStart.toISOString(), appointmentEnd.toISOString()]
    )

    const flow = {
      nodes: [
        {
          id: 'start',
          type: 'start',
          config: {
            triggers: [{ id: 'booked', type: 'trigger-appointment-booked', config: { calendar: calendarId } }]
          }
        },
        {
          id: 'confirm-appointment',
          type: 'action-appointment-confirmation',
          label: 'Confirmar cita',
          config: {
            calendar: calendarId,
            channel: 'whatsapp',
            timingAnchor: 'after_booking',
            offsetValue: 10,
            offsetUnit: 'minutes',
            template: template.id,
            templateName: template.name,
            templateLanguage: template.language || 'es_MX',
            senderMode: 'contact',
            smartEnabled: false,
            confirmationTimeoutValue: 6,
            confirmationTimeoutUnit: 'hours',
            confirmationTimeoutMode: 'response_window',
            confirmationResponseStart: '09:00',
            confirmationResponseEnd: '21:00',
            noConfirmAction: 'cancel_appointment',
            confirmationReplyText: 'Quedó confirmada tu cita.',
            createChatCard: true,
            createChatBadge: true,
            bypassAutomations: true
          }
        }
      ],
      edges: [{ id: 'start-confirm', sourceNodeId: 'start', targetNodeId: 'confirm-appointment' }],
      settings: { allowReentry: false, preventDuplicateActiveEnrollment: true }
    }
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, 'Confirmación única', 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, JSON.stringify(flow), JSON.stringify(flow)]
    )

    setAutomationAppointmentConfirmationSenderForTest(async () => {
      sendCount += 1
      return { id: `message_${suffix}` }
    })

    await handleAutomationEvent('appointment-booked', {
      contactId,
      appointmentId,
      calendarId,
      status: 'confirmed',
      startTime: appointmentStart.toISOString()
    })
    let enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.wait_kind, 'appointment-confirmation')
    assert.equal(sendCount, 0)

    await db.run(
      'UPDATE appointments SET date_added = ? WHERE id = ?',
      [new Date(Date.now() - 11 * 60 * 1000).toISOString(), appointmentId]
    )
    await db.run(
      'UPDATE automation_enrollments SET resume_at = ? WHERE id = ?',
      [new Date(Date.now() - 1000).toISOString(), enrollment.id]
    )
    await processDueResumes()

    enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(enrollment.status, 'completed')
    assert.equal(sendCount, 1)

    const send = await db.get(`
      SELECT status, message_type, ai_enabled, source_type, source_id, source_config
      FROM appointment_reminder_sends
      WHERE appointment_id = ? AND source_type = 'automation'
    `, [appointmentId])
    assert.equal(send.status, 'sent')
    assert.equal(send.message_type, 'confirmation')
    assert.equal(Number(send.ai_enabled), 1)
    assert.equal(send.source_id, `${automationId}:confirm-appointment`)
    assert.deepEqual(JSON.parse(send.source_config), {
      calendarId,
      channel: 'whatsapp',
      noConfirmAction: 'cancel_appointment',
      bypassAutomations: true,
      confirmationSuccessAction: '["chat_card","chat_badge","mark_confirmed"]',
      confirmationReplyText: 'Quedó confirmada tu cita.'
    })

    setAppointmentConfirmationClassifierForTest(async () => ({
      result: 'confirmed',
      confidence: 'high',
      reason: 'El contacto confirmó'
    }))
    setAppointmentConfirmationReplySenderForTest(async () => ({
      messageId: `confirmation_reply_${suffix}`
    }))
    const inbound = await handleInboundForConfirmation({
      contactId,
      text: 'Sí, ahí voy',
      messageId: `inbound_${suffix}`
    })
    assert.equal(inbound.windowActive, true)
    assert.equal(inbound.bypassAutomations, true)
    const window = await db.get(
      'SELECT id FROM appointment_confirmation_windows WHERE appointment_id = ?',
      [appointmentId]
    )
    await db.run(
      'UPDATE appointment_confirmation_windows SET last_message_at = ? WHERE id = ?',
      [new Date(Date.now() - 3 * 60 * 1000).toISOString(), window.id]
    )
    const processed = await processExpiredConfirmationWindows()
    assert.equal(processed.processed, 1)
    const confirmedWindow = await db.get(
      'SELECT status, result, confirmation_success_action FROM appointment_confirmation_windows WHERE id = ?',
      [window.id]
    )
    assert.equal(confirmedWindow.status, 'done')
    assert.equal(confirmedWindow.result, 'confirmed')
    assert.deepEqual(JSON.parse(confirmedWindow.confirmation_success_action), [
      'chat_card',
      'chat_badge',
      'mark_confirmed'
    ])

    await handleAutomationEvent('appointment-status', {
      contactId,
      appointmentId,
      calendarId,
      status: 'confirmed',
      appointmentChange: 'rescheduled',
      startTime: appointmentStart.toISOString()
    })
    const enrollmentCount = await db.get(
      'SELECT COUNT(*) AS total FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(Number(enrollmentCount.total), 1)
    assert.equal(sendCount, 1)
  } finally {
    setAutomationAppointmentConfirmationSenderForTest(null)
    setAppointmentConfirmationClassifierForTest(null)
    setAppointmentConfirmationReplySenderForTest(null)
    await db.run('DELETE FROM appointment_confirmation_windows WHERE appointment_id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM appointment_reminder_sends WHERE appointment_id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId]).catch(() => undefined)
    await db.run('DELETE FROM automations WHERE id = ?', [automationId]).catch(() => undefined)
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('Confirmar cita recalcula una espera anterior a la cita cuando se reagenda', async () => {
  const suffix = randomUUID()
  const automationId = `automation_confirmation_reschedule_${suffix}`
  const contactId = `contact_confirmation_reschedule_${suffix}`
  const calendarId = `calendar_confirmation_reschedule_${suffix}`
  const appointmentId = `appointment_confirmation_reschedule_${suffix}`
  const originalStart = new Date(Date.now() + 3 * 60 * 60 * 1000)
  const originalEnd = new Date(originalStart.getTime() + 60 * 60 * 1000)
  const rescheduledStart = new Date(originalStart.getTime() + 2 * 60 * 60 * 1000)
  const rescheduledEnd = new Date(rescheduledStart.getTime() + 60 * 60 * 1000)

  try {
    await ensureDefaultAppointmentMessageTemplates({ submitToActiveProvider: false })
    const template = await db.get(`
      SELECT id, name, language
      FROM whatsapp_message_templates
      WHERE name = 'confirmacion_cita_dia_anterior'
      ORDER BY created_at ASC
      LIMIT 1
    `)
    assert.ok(template?.id)

    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, 'Contacto Reagendado', 'Contacto', '{}')`,
      [contactId, `+521${Date.now().toString().slice(-10)}`, `reschedule-${suffix}@test.com`]
    )
    await db.run(
      `INSERT INTO calendars (
         id, name, event_title, is_active, slot_duration, slot_duration_unit,
         source, open_hours, availability_schedule_configured
       ) VALUES (?, 'Calendario reagendado', 'Consulta', 1, 60, 'mins', 'ristak', '[]', 0)`,
      [calendarId]
    )
    await db.run(
      `INSERT INTO appointments (
         id, calendar_id, contact_id, title, status, appointment_status,
         start_time, end_time, date_added, date_updated, source
       ) VALUES (?, ?, ?, 'Consulta reagendada', 'confirmed', 'confirmed', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'ristak')`,
      [appointmentId, calendarId, contactId, originalStart.toISOString(), originalEnd.toISOString()]
    )

    const flow = {
      nodes: [
        {
          id: 'start',
          type: 'start',
          config: {
            triggers: [{ id: 'booked', type: 'trigger-appointment-booked', config: { calendar: calendarId } }]
          }
        },
        {
          id: 'confirm-appointment',
          type: 'action-appointment-confirmation',
          label: 'Confirmar cita',
          config: {
            calendar: calendarId,
            timingAnchor: 'before_appointment',
            offsetValue: 1,
            offsetUnit: 'hours',
            template: template.id,
            templateName: template.name,
            templateLanguage: template.language || 'es_MX',
            senderMode: 'contact',
            smartEnabled: false,
            confirmationTimeoutValue: 30,
            confirmationTimeoutUnit: 'minutes',
            confirmationTimeoutMode: 'elapsed',
            noConfirmAction: 'no_action'
          }
        }
      ],
      edges: [{ id: 'start-confirm', sourceNodeId: 'start', targetNodeId: 'confirm-appointment' }],
      settings: { allowReentry: false, preventDuplicateActiveEnrollment: true }
    }
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, 'Confirmación al reagendar', 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('appointment-booked', {
      contactId,
      appointmentId,
      calendarId,
      status: 'confirmed',
      startTime: originalStart.toISOString()
    })
    let enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.wait_kind, 'appointment-confirmation')
    assert.ok(
      Math.abs(new Date(enrollment.resume_at).getTime() - (originalStart.getTime() - 60 * 60 * 1000)) < 1000
    )

    await db.run(
      `UPDATE appointments
       SET start_time = ?, end_time = ?, date_updated = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [rescheduledStart.toISOString(), rescheduledEnd.toISOString(), appointmentId]
    )
    await handleAutomationEvent('appointment-status', {
      contactId,
      appointmentId,
      calendarId,
      status: 'confirmed',
      appointmentChange: 'rescheduled',
      startTime: rescheduledStart.toISOString()
    })

    enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.wait_kind, 'appointment-confirmation')
    assert.ok(
      Math.abs(new Date(enrollment.resume_at).getTime() - (rescheduledStart.getTime() - 60 * 60 * 1000)) < 1000
    )
  } finally {
    await db.run('DELETE FROM appointment_confirmation_windows WHERE appointment_id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM appointment_reminder_sends WHERE appointment_id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId]).catch(() => undefined)
    await db.run('DELETE FROM automations WHERE id = ?', [automationId]).catch(() => undefined)
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
