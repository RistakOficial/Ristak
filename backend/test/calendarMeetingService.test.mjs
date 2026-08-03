import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  createLocalAppointment,
  createLocalCalendar,
  getLocalAppointment
} from '../src/services/localCalendarService.js'
import {
  buildAppointmentMeetingJoinUrl,
  handleCalendarMeetingLinkClick,
  syncCalendarMeetingResources
} from '../src/services/calendarMeetingService.js'
import {
  listTriggerLinks,
  recordTriggerLinkClick,
  recordTriggerLinkRecipientClick
} from '../src/services/triggerLinksService.js'
import { readTriggerLinkRecipientToken } from '../src/services/triggerLinkRecipientTokenService.js'

test('una cita en línea usa enlace opaco, oculta el destino interno y marca asistencia exacta', async () => {
  const suffix = randomUUID().replace(/-/g, '')
  const contactId = `contact_meeting_${suffix}`
  const calendarId = `calendar_meeting_${suffix}`
  const appointmentId = `appointment_meeting_${suffix}`
  const concurrentAppointmentId = `appointment_meeting_concurrent_${suffix}`

  try {
    await db.run(
      'INSERT INTO contacts (id, full_name, first_name, phone) VALUES (?, ?, ?, ?)',
      [contactId, 'María Reunión', 'María', '+526560000099']
    )
    const calendar = await createLocalCalendar({
      id: calendarId,
      name: 'Consultas en línea',
      meetingMode: 'online',
      meetingUrl: 'https://meet.google.com/abc-defg-hij'
    })
    await syncCalendarMeetingResources(calendar)

    const internalLink = await db.get(
      "SELECT * FROM trigger_links WHERE system_scope = 'calendar_meeting' AND owner_id = ?",
      [calendarId]
    )
    assert.ok(internalLink?.public_id)
    assert.equal(internalLink.destination_url, 'https://meet.google.com/abc-defg-hij')
    assert.equal((await listTriggerLinks()).some(link => link.id === internalLink.id), false)
    await assert.rejects(
      recordTriggerLinkClick(internalLink.public_id, { query: {}, headers: {} }),
      (error) => error?.status === 404
    )
    const reminder = await db.get(
      "SELECT * FROM appointment_reminders WHERE calendar_id = ? AND system_key = 'online_meeting_join_link_10m'",
      [calendarId]
    )
    assert.equal(reminder?.enabled, 1)
    assert.equal(reminder?.offset_value, 10)
    assert.equal(reminder?.offset_unit, 'minutes')
    assert.equal(reminder?.template_name, 'acceso_videollamada_10_minutos')
    const onlineTemplate = await db.get(
      'SELECT body_text, footer_text FROM whatsapp_message_templates WHERE id = ?',
      [reminder.template_id]
    )
    assert.equal(
      onlineTemplate?.body_text,
      'Hola {{1}}, tu cita en línea comienza el {{2}} a las {{3}}. Ingresa a la videollamada aquí: {{4}}\n\nTe esperamos.'
    )
    assert.equal(onlineTemplate?.footer_text, 'Mensaje automático de Ristak')

    const start = new Date(Date.now() + 60 * 60 * 1000)
    const appointment = await createLocalAppointment({
      id: appointmentId,
      calendarId,
      contactId,
      title: 'Consulta privada',
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
      status: 'confirmed',
      appointmentStatus: 'confirmed'
    })
    const joinUrl = await buildAppointmentMeetingJoinUrl({
      appointment,
      contactId,
      baseUrl: 'https://app.ristak.test'
    })
    assert.match(joinUrl, /^https:\/\/app\.ristak\.test\/pce1_[A-Za-z0-9_-]+$/)
    assert.equal(joinUrl.includes('meet.google.com'), false)
    assert.equal(joinUrl.includes(appointmentId), false)
    const recipientToken = new URL(joinUrl).pathname.slice(1)
    assert.deepEqual(
      await readTriggerLinkRecipientToken(recipientToken),
      { publicId: internalLink.public_id, contactId, appointmentId }
    )

    const click = await recordTriggerLinkRecipientClick(recipientToken, { query: {}, headers: {} })
    assert.equal(click.destinationUrl, 'https://meet.google.com/abc-defg-hij')
    const stored = await getLocalAppointment(appointmentId)
    assert.equal(stored.appointmentStatus, 'showed')
    assert.ok(await db.get(
      'SELECT id FROM appointment_attendance_signals WHERE contact_id = ? AND appointment_id = ?',
      [contactId, appointmentId]
    ))

    const replay = await handleCalendarMeetingLinkClick({ appointmentId, contactId, calendarId })
    assert.equal(replay.marked, false)
    assert.equal(replay.reason, 'already_attended')

    await createLocalAppointment({
      id: concurrentAppointmentId,
      calendarId,
      contactId,
      title: 'Consulta con clic simultáneo',
      startTime: new Date(start.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      endTime: new Date(start.getTime() + 2.5 * 60 * 60 * 1000).toISOString(),
      status: 'confirmed',
      appointmentStatus: 'confirmed'
    })
    const concurrentResults = await Promise.all([
      handleCalendarMeetingLinkClick({ appointmentId: concurrentAppointmentId, contactId, calendarId }),
      handleCalendarMeetingLinkClick({ appointmentId: concurrentAppointmentId, contactId, calendarId })
    ])
    assert.equal(concurrentResults.filter(result => result.marked).length, 1)
    assert.equal((await getLocalAppointment(concurrentAppointmentId)).appointmentStatus, 'showed')
  } finally {
    await db.run('DELETE FROM appointment_reminder_sends WHERE appointment_id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM appointment_reminder_sends WHERE appointment_id = ?', [concurrentAppointmentId]).catch(() => undefined)
    await db.run('DELETE FROM appointment_attendance_signals WHERE appointment_id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM appointment_attendance_signals WHERE appointment_id = ?', [concurrentAppointmentId]).catch(() => undefined)
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM appointments WHERE id = ?', [concurrentAppointmentId]).catch(() => undefined)
    await db.run('DELETE FROM appointment_reminders WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    const links = await db.all("SELECT id FROM trigger_links WHERE system_scope = 'calendar_meeting' AND owner_id = ?", [calendarId]).catch(() => [])
    for (const link of links) {
      await db.run('DELETE FROM trigger_link_events WHERE trigger_link_id = ?', [link.id]).catch(() => undefined)
    }
    await db.run("DELETE FROM trigger_links WHERE system_scope = 'calendar_meeting' AND owner_id = ?", [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
