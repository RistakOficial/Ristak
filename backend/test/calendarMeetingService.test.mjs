import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db, setAppConfig } from '../src/config/database.js'
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
import { createMessageTemplate } from '../src/services/messageTemplatesService.js'
import { updateAppointmentReminder } from '../src/services/appointmentRemindersService.js'
import {
  listTriggerLinks,
  recordTriggerLinkClick,
  recordTriggerLinkRecipientClick
} from '../src/services/triggerLinksService.js'
import { readTriggerLinkRecipientToken } from '../src/services/triggerLinkRecipientTokenService.js'
import { setAppNotificationPayloadSenderForTest } from '../src/services/pushNotificationsService.js'

const NOTIFICATION_PREFERENCES_CONFIG_KEY = 'notification_preferences_matrix'

async function waitFor(condition, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail('La notificación de ingreso no se entregó dentro del tiempo esperado.')
}

test('una cita en línea usa enlace opaco, oculta el destino interno y marca asistencia exacta', async () => {
  const suffix = randomUUID().replace(/-/g, '')
  const contactId = `contact_meeting_${suffix}`
  const calendarId = `calendar_meeting_${suffix}`
  const appointmentId = `appointment_meeting_${suffix}`
  const concurrentAppointmentId = `appointment_meeting_concurrent_${suffix}`
  const customTemplateName = `acceso_videollamada_personalizado_${suffix}`
  let customTemplateId = ''
  const pushDeliveries = []
  const previousNotificationPreferences = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    [NOTIFICATION_PREFERENCES_CONFIG_KEY]
  )

  try {
    await db.run('DELETE FROM app_config WHERE config_key = ?', [NOTIFICATION_PREFERENCES_CONFIG_KEY])
    setAppNotificationPayloadSenderForTest(async (payload, options) => {
      pushDeliveries.push({ payload, options })
      return { sent: 1, nativeSent: 1, webSent: 0, skipped: false }
    })
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
    assert.equal(reminder?.template_name, 'acceso_videollamada_10_minutos_v2')
    assert.equal(
      reminder?.message_text,
      'Aquí te paso el enlace para conectarnos:\n{{cita.enlace_ingreso}}\n\nYo me conecto en diez minutos. También te envié el enlace por correo electrónico, por si no puedes ingresar desde aquí.\n\nUn favor, ¿puedes ir ingresando para verificar que sí puedes entrar? Gracias.'
    )
    const onlineTemplate = await db.get(
      'SELECT body_text, footer_text, variable_bindings_json FROM whatsapp_message_templates WHERE id = ?',
      [reminder.template_id]
    )
    assert.equal(
      onlineTemplate?.body_text,
      'Aquí te paso el enlace para conectarnos:\n{{1}}\n\nYo me conecto en diez minutos. También te envié el enlace por correo electrónico, por si no puedes ingresar desde aquí.\n\nUn favor, ¿puedes ir ingresando para verificar que sí puedes entrar? Gracias.'
    )
    assert.equal(onlineTemplate?.footer_text, 'Mensaje automático de Ristak')
    assert.deepEqual(JSON.parse(onlineTemplate?.variable_bindings_json || '{}'), {
      headerText: {},
      bodyText: {
        1: {
          variableKey: 'cita.enlace_ingreso',
          mergeField: '{{cita.enlace_ingreso}}',
          label: 'Enlace de ingreso a la cita',
          example: 'https://app.ristak.com/pce1_enlace_seguro'
        }
      }
    })

    const customTemplate = await createMessageTemplate({
      folderId: null,
      name: customTemplateName,
      description: 'Plantilla aprobada elegida por el usuario para su videollamada.',
      category: 'utility',
      language: 'es_MX',
      status: 'active',
      headerEnabled: false,
      headerType: 'none',
      bodyText: 'Ingresa a tu cita desde aquí: {{1}}',
      footerText: 'Mensaje automático',
      buttons: [],
      variableExamples: {
        '{{cita.enlace_ingreso}}': 'https://app.ristak.test/pce1_enlace_seguro'
      },
      variableBindings: {
        headerText: {},
        bodyText: {
          1: {
            variableKey: 'cita.enlace_ingreso',
            mergeField: '{{cita.enlace_ingreso}}',
            label: 'Enlace de ingreso a la cita',
            example: 'https://app.ristak.test/pce1_enlace_seguro'
          }
        }
      }
    })
    customTemplateId = customTemplate.id
    await db.run(`
      UPDATE whatsapp_message_templates
      SET provider_template_name = ?, provider_template_id = ?, provider_status = 'APPROVED'
      WHERE id = ?
    `, [customTemplateName, `provider_${suffix}`, customTemplateId])
    await updateAppointmentReminder(reminder.id, {
      calendarId,
      templateId: customTemplateId,
      templateName: customTemplateName,
      templateLanguage: 'es_MX',
      contentMode: 'template'
    })

    await syncCalendarMeetingResources({ ...calendar, meetingMode: 'in_person', meetingUrl: '' })
    const disabledCustomReminder = await db.get(
      "SELECT * FROM appointment_reminders WHERE calendar_id = ? AND system_key = 'online_meeting_join_link_10m'",
      [calendarId]
    )
    assert.equal(disabledCustomReminder?.enabled, 0)
    assert.equal(disabledCustomReminder?.template_id, customTemplateId)

    await syncCalendarMeetingResources(calendar)
    const preservedCustomReminder = await db.get(
      "SELECT * FROM appointment_reminders WHERE calendar_id = ? AND system_key = 'online_meeting_join_link_10m'",
      [calendarId]
    )
    assert.equal(preservedCustomReminder?.enabled, 1)
    assert.equal(preservedCustomReminder?.template_id, customTemplateId)
    assert.equal(preservedCustomReminder?.template_name, customTemplateName)

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
    await waitFor(() => pushDeliveries.length > 0)
    assert.equal(pushDeliveries[0].payload.category, 'appointment_joined')
    assert.match(pushDeliveries[0].payload.title, /María Reunión ingresó a la videollamada/)
    assert.equal(pushDeliveries[0].options.userIds, null)
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
    setAppNotificationPayloadSenderForTest(null)
    await db.run('DELETE FROM app_config WHERE config_key = ?', [NOTIFICATION_PREFERENCES_CONFIG_KEY]).catch(() => undefined)
    if (previousNotificationPreferences) {
      await setAppConfig(NOTIFICATION_PREFERENCES_CONFIG_KEY, previousNotificationPreferences.config_value).catch(() => undefined)
    }
    await db.run("DELETE FROM internal_notifications WHERE category = 'appointment_joined' AND contact_id = ?", [contactId]).catch(() => undefined)
    await db.run('DELETE FROM appointment_reminder_sends WHERE appointment_id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM appointment_reminder_sends WHERE appointment_id = ?', [concurrentAppointmentId]).catch(() => undefined)
    await db.run('DELETE FROM appointment_attendance_signals WHERE appointment_id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM appointment_attendance_signals WHERE appointment_id = ?', [concurrentAppointmentId]).catch(() => undefined)
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM appointments WHERE id = ?', [concurrentAppointmentId]).catch(() => undefined)
    await db.run('DELETE FROM appointment_reminders WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    if (customTemplateId) {
      await db.run('DELETE FROM whatsapp_message_templates WHERE id = ?', [customTemplateId]).catch(() => undefined)
      await db.run('DELETE FROM whatsapp_api_templates WHERE name = ? AND language = ?', [customTemplateName, 'es_MX']).catch(() => undefined)
    }
    const links = await db.all("SELECT id FROM trigger_links WHERE system_scope = 'calendar_meeting' AND owner_id = ?", [calendarId]).catch(() => [])
    for (const link of links) {
      await db.run('DELETE FROM trigger_link_events WHERE trigger_link_id = ?', [link.id]).catch(() => undefined)
    }
    await db.run("DELETE FROM trigger_links WHERE system_scope = 'calendar_meeting' AND owner_id = ?", [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
