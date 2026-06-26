import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  createAppointmentReminder,
  processDueAppointmentReminders
} from '../src/services/appointmentRemindersService.js'
import { createMessageTemplate } from '../src/services/messageTemplatesService.js'
import {
  getWhatsAppApiConfigKeys,
  setYCloudFetchForTest
} from '../src/services/whatsappApiService.js'

function ycloudJsonResponse(body, { status = 200, statusText = 'OK' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => JSON.stringify(body)
  }
}

async function snapshotAppConfig(keys = [], callback) {
  const uniqueKeys = [...new Set(keys)]
  const placeholders = uniqueKeys.map(() => '?').join(', ')
  const previousRows = placeholders
    ? await db.all(
        `SELECT config_key, config_value FROM app_config WHERE config_key IN (${placeholders})`,
        uniqueKeys
      )
    : []

  try {
    if (placeholders) {
      await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, uniqueKeys)
    }
    return await callback()
  } finally {
    if (placeholders) {
      await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, uniqueKeys)
    }
    for (const row of previousRows) {
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET
          config_value = excluded.config_value,
          updated_at = CURRENT_TIMESTAMP
      `, [row.config_key, row.config_value])
    }
  }
}

async function withYCloudMessageCapture(callback) {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [
    keys.enabled,
    keys.apiKey,
    keys.senderPhone,
    keys.phoneNumberId,
    keys.wabaId,
    keys.provider,
    keys.lastError
  ]
  const captures = []

  return snapshotAppConfig(configKeys, async () => {
    await setAppConfig(keys.enabled, '1')
    await setAppConfig(keys.apiKey, encrypt('ycloud_appointment_reminder_secret'))
    await setAppConfig(keys.senderPhone, '+526561234567')
    await setAppConfig(keys.phoneNumberId, 'phone_appointment_reminder_test')
    await setAppConfig(keys.wabaId, 'waba_appointment_reminder_test')
    await setAppConfig(keys.provider, 'ycloud')
    await setAppConfig(keys.lastError, '')

    setYCloudFetchForTest(async (url, options = {}) => {
      const parsed = new URL(String(url))
      const path = parsed.pathname.replace(/^\/v2/, '')
      const method = String(options.method || 'GET').toUpperCase()
      if (path === '/whatsapp/messages' && method === 'POST') {
        const body = JSON.parse(options.body || '{}')
        captures.push(body)
        return ycloudJsonResponse({
          id: `ycloud_appointment_msg_${captures.length}`,
          from: body.from,
          to: body.to,
          type: body.type,
          status: 'sent',
          [body.type]: body[body.type]
        })
      }
      return ycloudJsonResponse({ ok: true })
    })

    try {
      return await callback(captures)
    } finally {
      setYCloudFetchForTest(null)
    }
  })
}

async function createReminderTemplate({ suffix, ycloudStatus = 'APPROVED' }) {
  const name = `recordatorio_servicio_${suffix.replace(/-/g, '_')}`
  const template = await createMessageTemplate({
    folderId: null,
    name,
    description: 'Recordatorio de cita para prueba',
    category: 'utility',
    language: 'es_MX',
    status: 'active',
    headerEnabled: false,
    headerType: 'none',
    headerText: '',
    headerMediaUrl: '',
    headerLocation: { latitude: '', longitude: '', name: '', address: '' },
    bodyText: 'Hola {{1}}, tu cita es {{2}}.',
    footerText: 'Gracias',
    buttons: [],
    variableExamples: {
      '{{contact.first_name}}': 'Ana',
      '{{cita.hora}}': '12:00'
    },
    variableBindings: {
      headerText: {},
      bodyText: {
        1: {
          variableKey: 'contact.first_name',
          mergeField: '{{contact.first_name}}',
          label: 'Primer nombre',
          example: 'Ana'
        },
        2: {
          variableKey: 'cita.hora',
          mergeField: '{{cita.hora}}',
          label: 'Hora de cita',
          example: '12:00'
        }
      }
    }
  })

  await db.run(
    'UPDATE whatsapp_message_templates SET ycloud_status = ?, ycloud_template_id = ? WHERE id = ?',
    [ycloudStatus, `official_${name}`, template.id]
  )

  if (ycloudStatus === 'APPROVED') {
    const components = [
      { type: 'BODY', text: 'Hola {{1}}, tu cita es {{2}}.' },
      { type: 'FOOTER', text: 'Gracias' }
    ]
    await db.run(
      'DELETE FROM whatsapp_api_templates WHERE name = ? AND language = ?',
      [name, 'es_MX']
    )
    await db.run(
      `INSERT INTO whatsapp_api_templates (
        id, official_template_id, waba_id, name, language, status, components_json, raw_payload_json
      ) VALUES (?, ?, ?, ?, ?, 'APPROVED', ?, ?)`,
      [
        `api_${template.id}`,
        `official_${name}`,
        'waba_appointment_reminder_test',
        name,
        'es_MX',
        JSON.stringify(components),
        JSON.stringify({ components })
      ]
    )
  }

  return { ...template, name }
}

async function withReminderFixture({ ycloudStatus = 'APPROVED', qrFallbackEnabled = false }, callback) {
  const suffix = randomUUID()
  const phone = `+52155${Date.now().toString().slice(-8)}`
  const contactId = `contact_reminder_${suffix}`
  const appointmentId = `appointment_reminder_${suffix}`
  const phoneNumberId = `phone_reminder_${suffix}`
  const existingReminders = await db.all('SELECT id, enabled FROM appointment_reminders')
  let reminderId = ''

  await db.run('UPDATE appointment_reminders SET enabled = 0')

  const template = await createReminderTemplate({ suffix, ycloudStatus })
  const startTime = DateTime.utc().plus({ hours: 1 }).toISO()

  try {
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, waba_id, phone_number, display_phone_number, verified_name,
        is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
      ) VALUES (?, ?, ?, ?, ?, 1, 1, 0, 'disconnected', 'CONNECTED')
    `, [phoneNumberId, 'waba_appointment_reminder_test', '+526561234567', '+52 656 123 4567', 'Ristak Test'])

    await db.run(`
      INSERT INTO contacts (id, phone, first_name, full_name, preferred_whatsapp_phone_number_id)
      VALUES (?, ?, 'Ana', 'Ana Test', ?)
    `, [contactId, phone, phoneNumberId])

    await db.run(`
      INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time
      ) VALUES (?, 'calendar_test', ?, 'Consulta', 'pending', 'pending', ?, ?)
    `, [
      appointmentId,
      contactId,
      startTime,
      DateTime.fromISO(startTime).plus({ hours: 1 }).toISO()
    ])

    const reminder = await createAppointmentReminder({
      name: `Recordatorio ${suffix}`,
      messageType: 'reminder',
      templateId: template.id,
      offsetValue: 2,
      offsetUnit: 'hours',
      smartEnabled: false,
      senderMode: 'default',
      qrFallbackEnabled
    })
    reminderId = reminder.id

    return await callback({ reminder, template, appointmentId, contactId, phone, phoneNumberId })
  } finally {
    await db.run('DELETE FROM appointment_reminder_sends WHERE appointment_id = ?', [appointmentId])
    if (reminderId) {
      await db.run('DELETE FROM appointment_reminders WHERE id = ?', [reminderId])
    }
    for (const row of existingReminders) {
      await db.run('UPDATE appointment_reminders SET enabled = ? WHERE id = ?', [row.enabled, row.id])
    }
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    await db.run('DELETE FROM whatsapp_api_messages WHERE phone = ? OR to_phone = ?', [phone, phone])
    await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [phone])
    await db.run('DELETE FROM whatsapp_api_template_sends WHERE template_name = ?', [template.name])
    await db.run('DELETE FROM whatsapp_api_templates WHERE name = ?', [template.name])
    await db.run('DELETE FROM whatsapp_message_templates WHERE id = ?', [template.id])
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId])
  }
}

test('recordatorios de citas envían plantilla aprobada por WhatsApp API', async () => {
  await withYCloudMessageCapture(async (captures) => {
    await withReminderFixture({ ycloudStatus: 'APPROVED' }, async ({ template }) => {
      const result = await processDueAppointmentReminders({ batchSize: 1 })

      assert.equal(result.sent, 1)
      assert.equal(result.errors, 0)
      assert.equal(captures.length, 1)
      assert.equal(captures[0].type, 'template')
      assert.equal(captures[0].template.name, template.name)
      assert.equal(captures[0].template.components[0].type, 'body')
      assert.equal(captures[0].template.components[0].parameters[0].text, 'Ana')
    })
  })
})

test('recordatorios no mandan texto normal si la plantilla no está aprobada y QR está apagado', async () => {
  await withYCloudMessageCapture(async (captures) => {
    await withReminderFixture({ ycloudStatus: 'PENDING', qrFallbackEnabled: false }, async ({ appointmentId }) => {
      const result = await processDueAppointmentReminders({ batchSize: 1 })

      assert.equal(result.sent, 0)
      assert.equal(result.errors, 1)
      assert.equal(captures.length, 0)

      const send = await db.get(
        'SELECT status, error_message FROM appointment_reminder_sends WHERE appointment_id = ?',
        [appointmentId]
      )
      assert.equal(send.status, 'error')
      assert.match(send.error_message, /APPROVED/)
    })
  })
})

test('confirmaciones "después de agendar" salen para reservas de Ristak pero no para citas sincronizadas de Google', async () => {
  await withYCloudMessageCapture(async (captures) => {
    const suffix = randomUUID()
    const phoneRistak = `+52157${Date.now().toString().slice(-8)}`
    const phoneGoogle = `+52158${Date.now().toString().slice(-8)}`
    const contactRistak = `contact_ab_ristak_${suffix}`
    const contactGoogle = `contact_ab_google_${suffix}`
    const apptRistak = `appt_ab_ristak_${suffix}`
    const apptGoogle = `appt_ab_google_${suffix}`
    const phoneNumberId = `phone_ab_${suffix}`
    const existingReminders = await db.all('SELECT id, enabled FROM appointment_reminders')
    let reminderId = ''
    const template = await createReminderTemplate({ suffix, ycloudStatus: 'APPROVED' })

    // Agendó hace 6 min; con +5 min el envío venció hace 1 min (dentro de la gracia).
    const bookedAt = DateTime.utc().minus({ minutes: 6 }).toISO()
    const startTime = DateTime.utc().plus({ days: 2 }).toISO()
    const endTime = DateTime.fromISO(startTime).plus({ hours: 1 }).toISO()

    await db.run('UPDATE appointment_reminders SET enabled = 0')

    try {
      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
        ) VALUES (?, ?, ?, ?, ?, 1, 1, 0, 'disconnected', 'CONNECTED')
      `, [phoneNumberId, 'waba_appointment_reminder_test', '+526561234567', '+52 656 123 4567', 'Ristak Test'])

      await db.run(`
        INSERT INTO contacts (id, phone, first_name, full_name, preferred_whatsapp_phone_number_id)
        VALUES (?, ?, 'Ana', 'Ana Test', ?)
      `, [contactRistak, phoneRistak, phoneNumberId])
      await db.run(`
        INSERT INTO contacts (id, phone, first_name, full_name, preferred_whatsapp_phone_number_id)
        VALUES (?, ?, 'Beto', 'Beto Test', ?)
      `, [contactGoogle, phoneGoogle, phoneNumberId])

      await db.run(`
        INSERT INTO appointments (
          id, calendar_id, contact_id, title, status, appointment_status,
          start_time, end_time, date_added, source
        ) VALUES (?, 'calendar_test', ?, 'Consulta', 'pending', 'pending', ?, ?, ?, 'public_calendar')
      `, [apptRistak, contactRistak, startTime, endTime, bookedAt])
      await db.run(`
        INSERT INTO appointments (
          id, calendar_id, contact_id, title, status, appointment_status,
          start_time, end_time, date_added, source
        ) VALUES (?, 'calendar_test', ?, 'Consulta', 'pending', 'pending', ?, ?, ?, 'google')
      `, [apptGoogle, contactGoogle, startTime, endTime, bookedAt])

      const reminder = await createAppointmentReminder({
        name: `Confirmación ${suffix}`,
        messageType: 'confirmation',
        timingAnchor: 'after_booking',
        templateId: template.id,
        offsetValue: 5,
        offsetUnit: 'minutes',
        smartEnabled: false,
        senderMode: 'default',
        aiEnabled: false
      })
      reminderId = reminder.id

      const result = await processDueAppointmentReminders({ batchSize: 5 })

      assert.equal(result.sent, 1)
      assert.equal(captures.length, 1)

      const sentRistak = await db.get(
        'SELECT status FROM appointment_reminder_sends WHERE appointment_id = ?',
        [apptRistak]
      )
      assert.equal(sentRistak?.status, 'sent')

      // La cita de Google nunca debe reclamarse ni enviarse.
      const sentGoogle = await db.get(
        'SELECT status FROM appointment_reminder_sends WHERE appointment_id = ?',
        [apptGoogle]
      )
      assert.ok(!sentGoogle, 'la cita sincronizada de Google no debe tener registro de envío')
    } finally {
      await db.run('DELETE FROM appointment_reminder_sends WHERE appointment_id IN (?, ?)', [apptRistak, apptGoogle])
      if (reminderId) await db.run('DELETE FROM appointment_reminders WHERE id = ?', [reminderId])
      for (const row of existingReminders) {
        await db.run('UPDATE appointment_reminders SET enabled = ? WHERE id = ?', [row.enabled, row.id])
      }
      await db.run('DELETE FROM appointments WHERE id IN (?, ?)', [apptRistak, apptGoogle])
      await db.run('DELETE FROM contacts WHERE id IN (?, ?)', [contactRistak, contactGoogle])
      await db.run('DELETE FROM whatsapp_api_messages WHERE phone IN (?, ?) OR to_phone IN (?, ?)', [phoneRistak, phoneGoogle, phoneRistak, phoneGoogle])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone IN (?, ?)', [phoneRistak, phoneGoogle])
      await db.run('DELETE FROM whatsapp_api_template_sends WHERE template_name = ?', [template.name])
      await db.run('DELETE FROM whatsapp_api_templates WHERE name = ?', [template.name])
      await db.run('DELETE FROM whatsapp_message_templates WHERE id = ?', [template.id])
      await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId])
    }
  })
})
