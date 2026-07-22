import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  appointmentReminderRetryCutoffExpression,
  createAppointmentReminder,
  getAppointmentRemindersOverview,
  processDueAppointmentReminders
} from '../src/services/appointmentRemindersService.js'
import { createMessageTemplate } from '../src/services/messageTemplatesService.js'
import {
  getWhatsAppApiConfigKeys,
  setYCloudFetchForTest
} from '../src/services/whatsappApiService.js'
import {
  QR_CONSENT_TEXT,
  resetWhatsAppQrServiceForTest,
  setBaileysRuntimeForTest
} from '../src/services/whatsappQrService.js'

function ycloudJsonResponse(body, { status = 200, statusText = 'OK' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => JSON.stringify(body)
  }
}

function normalizeDigits(value = '') {
  return String(value || '').replace(/\D/g, '')
}

function createFakeBaileysRuntime(connectedJid, sentMessages = []) {
  let messageIndex = 0
  return {
    DisconnectReason: {
      loggedOut: 401,
      badSession: 500,
      connectionReplaced: 440,
      restartRequired: 515
    },
    BufferJSON: {
      replacer: (_key, value) => value,
      reviver: (_key, value) => value
    },
    Browsers: {
      macOS: (name) => ['macOS', name, 'Ristak']
    },
    initAuthCreds: () => ({
      me: { id: connectedJid },
      registered: true
    }),
    makeCacheableSignalKeyStore: (keys) => keys,
    proto: {
      Message: {
        AppStateSyncKeyData: {
          fromObject: (value) => value
        }
      }
    },
    makeWASocket: () => {
      const listeners = new Map()
      const emit = async (eventName, payload) => {
        for (const handler of listeners.get(eventName) || []) {
          await handler(payload)
        }
      }
      const sock = {
        user: { id: connectedJid },
        ev: {
          on: (eventName, handler) => {
            const eventListeners = listeners.get(eventName) || []
            eventListeners.push(handler)
            listeners.set(eventName, eventListeners)
          },
          removeAllListeners: (eventName) => {
            if (eventName) listeners.delete(eventName)
            else listeners.clear()
          }
        },
        ws: {
          close: () => {}
        },
        onWhatsApp: async (...candidates) => candidates.map(candidate => ({
          exists: true,
          jid: `${normalizeDigits(candidate)}@s.whatsapp.net`
        })),
        sendMessage: async (jid, payload) => {
          messageIndex += 1
          const id = `qr_appointment_msg_${messageIndex}`
          sentMessages.push({ id, jid, payload })
          await emit('messages.update', [{
            key: { id, remoteJid: jid, fromMe: true },
            update: { status: 3 }
          }])
          return {
            key: { id, remoteJid: jid, fromMe: true },
            message: payload
          }
        },
        emit
      }
      queueMicrotask(() => {
        emit('connection.update', { connection: 'open' }).catch(() => undefined)
      })
      return sock
    }
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

async function withYCloudMessageCapture(callback, captureOptions = {}) {
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

    setYCloudFetchForTest(async (url, requestOptions = {}) => {
      const parsed = new URL(String(url))
      const path = parsed.pathname.replace(/^\/v2/, '')
      const method = String(requestOptions.method || 'GET').toUpperCase()
      if (path === '/whatsapp/messages' && method === 'POST') {
        const body = JSON.parse(requestOptions.body || '{}')
        const customResponse = await captureOptions.onMessage?.({ body, captures })
        if (customResponse) return customResponse
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
    `UPDATE whatsapp_message_templates
     SET template_provider = 'ycloud',
         provider_status = ?,
         provider_template_id = ?,
         provider_template_name = ?,
         ycloud_status = ?,
         ycloud_template_id = ?,
         ycloud_template_name = ?
     WHERE id = ?`,
    [ycloudStatus, `official_${name}`, name, ycloudStatus, `official_${name}`, name, template.id]
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

async function attachQrSessionForReminder(phoneNumberId, businessPhone, sentMessages = []) {
  const connectedJid = `${normalizeDigits(businessPhone)}@s.whatsapp.net`
  setBaileysRuntimeForTest(createFakeBaileysRuntime(connectedJid, sentMessages))

  await db.run(`
    INSERT INTO whatsapp_qr_sessions (
      id, phone_number_id, expected_phone, connected_phone, status,
      consent_accepted, consent_text, consent_accepted_at, last_connected_at, updated_at
    ) VALUES (?, ?, ?, ?, 'connected', 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    `qr_${phoneNumberId}`,
    phoneNumberId,
    businessPhone,
    businessPhone,
    QR_CONSENT_TEXT
  ])

  await db.run(`
    INSERT INTO whatsapp_qr_auth_state (phone_number_id, auth_key, value_json, updated_at)
    VALUES (?, 'creds', ?, CURRENT_TIMESTAMP)
  `, [
    phoneNumberId,
    JSON.stringify({
      me: { id: connectedJid },
      registered: true
    })
  ])
}

async function withReminderFixture({
  ycloudStatus = 'APPROVED',
  qrFallbackEnabled = false,
  apiSendEnabled = true,
  qrSendEnabled = false,
  qrStatus = 'disconnected'
}, callback) {
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
  // El recordatorio vence una hora antes de ejecutar la prueba. La reserva debe
  // ser anterior a ese instante para probar reintentos válidos, no una cita que
  // acaba de agendarse cuando su recordatorio ya había vencido.
  const bookedAt = DateTime.utc().minus({ hours: 2 }).toISO()

  try {
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, waba_id, phone_number, display_phone_number, verified_name,
        is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 'CONNECTED')
    `, [
      phoneNumberId,
      'waba_appointment_reminder_test',
      '+526561234567',
      '+52 656 123 4567',
      'Ristak Test',
      apiSendEnabled ? 1 : 0,
      qrSendEnabled ? 1 : 0,
      qrStatus
    ])

    await db.run(`
      INSERT INTO contacts (id, phone, first_name, full_name, preferred_whatsapp_phone_number_id)
      VALUES (?, ?, 'Ana', 'Ana Test', ?)
    `, [contactId, phone, phoneNumberId])

    await db.run(`
      INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status,
        start_time, end_time, date_added
      ) VALUES (?, 'calendar_test', ?, 'Consulta', 'pending', 'pending', ?, ?, ?)
    `, [
      appointmentId,
      contactId,
      startTime,
      DateTime.fromISO(startTime).plus({ hours: 1 }).toISO(),
      bookedAt
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
    resetWhatsAppQrServiceForTest()
    await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
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

test('el envío corrige una plantilla default cruzada y usa cita_programada al agendar', async () => {
  await withYCloudMessageCapture(async (captures) => {
    await withReminderFixture({ ycloudStatus: 'APPROVED' }, async ({ reminder, appointmentId }) => {
      const templates = await db.all(`
        SELECT id, name
        FROM whatsapp_message_templates
        WHERE name IN ('cita_programada', 'confirmacion_cita_dia_anterior')
      `)
      const byName = new Map(templates.map((template) => [template.name, template]))
      const noticeTemplate = byName.get('cita_programada')
      const wrongTemplate = byName.get('confirmacion_cita_dia_anterior')
      assert.ok(noticeTemplate?.id)
      assert.ok(wrongTemplate?.id)

      await db.run(`
        UPDATE whatsapp_message_templates
        SET template_provider = 'ycloud',
            provider_status = 'APPROVED',
            provider_template_id = 'official_' || name,
            provider_template_name = name,
            ycloud_status = 'APPROVED',
            ycloud_template_id = 'official_' || name,
            ycloud_template_name = name
        WHERE name IN ('cita_programada', 'confirmacion_cita_dia_anterior')
      `)
      await db.run(`
        UPDATE whatsapp_api_templates
        SET status = 'APPROVED'
        WHERE name IN ('cita_programada', 'confirmacion_cita_dia_anterior')
      `)
      await db.run(
        "UPDATE appointments SET date_added = ?, source = 'public_calendar' WHERE id = ?",
        [DateTime.utc().minus({ minutes: 1 }).toISO(), appointmentId]
      )
      // Corrupción histórica: el aviso inmediato apunta a la confirmación del
      // día anterior. El último guard del envío debe ignorar ese cruce.
      await db.run(`
        UPDATE appointment_reminders
        SET message_type = 'confirmation',
            timing_anchor = 'after_booking',
            offset_value = 0,
            offset_unit = 'minutes',
            smart_enabled = 0,
            template_id = ?,
            template_name = ?
        WHERE id = ?
      `, [wrongTemplate.id, wrongTemplate.name, reminder.id])

      const result = await processDueAppointmentReminders({ batchSize: 1 })

      assert.deepEqual(result, { sent: 1, errors: 0, skipped: 0 })
      assert.equal(captures.length, 1)
      assert.equal(captures[0].type, 'template')
      assert.equal(captures[0].template.name, 'cita_programada')
    })
  })
})

test('una cita nueva no recibe como confirmación un recordatorio cuyo momento ya había pasado', async () => {
  await withYCloudMessageCapture(async (captures) => {
    await withReminderFixture({ ycloudStatus: 'APPROVED' }, async ({ appointmentId }) => {
      await db.run(
        'UPDATE appointments SET date_added = ? WHERE id = ?',
        [DateTime.utc().toISO(), appointmentId]
      )

      const result = await processDueAppointmentReminders({ batchSize: 1 })

      assert.deepEqual(result, { sent: 0, errors: 0, skipped: 1 })
      assert.equal(captures.length, 0)

      const send = await db.get(
        'SELECT status, error_message FROM appointment_reminder_sends WHERE appointment_id = ?',
        [appointmentId]
      )
      assert.equal(send?.status, 'skipped')
      assert.match(send?.error_message || '', /se agendó después del momento programado/i)
    })
  })
})

test('recordatorios de citas con mensaje directo por WhatsApp API no requieren plantilla', async () => {
  await withYCloudMessageCapture(async (captures) => {
    await withReminderFixture({ ycloudStatus: 'PENDING' }, async ({ reminder, appointmentId, contactId, phone }) => {
      await db.run(`
        UPDATE appointment_reminders
        SET content_mode = 'direct',
            template_id = NULL,
            template_name = '',
            message_text = 'Hola {{contact.first_name}}, texto directo para tu cita a las {{cita.hora}}.'
        WHERE id = ?
      `, [reminder.id])
      await db.run(`
        INSERT INTO whatsapp_api_messages (
          id, provider, origin, business_phone_number_id, contact_id, phone,
          from_phone, to_phone, business_phone, transport, direction,
          message_type, message_text, status, message_timestamp,
          created_at, updated_at
        ) VALUES (?, 'ycloud', 'test_open_window', 'phone_appointment_reminder_test', ?, ?, ?, '+526561234567',
          '+526561234567', 'api', 'inbound', 'text', 'Hola', 'received', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        `wa_in_${appointmentId}`,
        contactId,
        phone,
        phone,
        new Date().toISOString()
      ])

      const result = await processDueAppointmentReminders({ batchSize: 1 })

      assert.equal(result.sent, 1)
      assert.equal(result.errors, 0)
      assert.equal(captures.length, 1)
      assert.equal(captures[0].type, 'text')
      assert.match(captures[0].text.body, /Hola Ana, texto directo/)
      assert.match(captures[0].text.body, /cita a las/)

      const send = await db.get(
        'SELECT status, sent_message_id, error_message FROM appointment_reminder_sends WHERE appointment_id = ?',
        [appointmentId]
      )
      assert.equal(send.status, 'sent')
      assert.equal(send.error_message, null)
      assert.equal(send.sent_message_id, 'ycloud_appointment_msg_1')
    })
  })
})

test('recordatorios no mandan texto normal si la plantilla no está aprobada y QR está apagado', async () => {
  await withYCloudMessageCapture(async (captures) => {
    await withReminderFixture({ ycloudStatus: 'PENDING', qrFallbackEnabled: false }, async ({ reminder, appointmentId }) => {
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

      const overview = await getAppointmentRemindersOverview()
      const overviewReminder = overview.reminders.find((item) => item.id === reminder.id)
      assert.equal(overviewReminder?.deliveryHealth?.status, 'error')
      assert.match(overviewReminder?.deliveryHealth?.message || '', /APPROVED/)
      assert.equal(overviewReminder?.failures?.errorCount, 1)
      assert.match(overviewReminder?.failures?.lastErrorMessage || '', /APPROVED/)
    })
  })
})

test('recordatorios de citas con solo QR envían el texto aunque la plantilla no esté aprobada', async () => {
  await withYCloudMessageCapture(async (captures) => {
    const sentMessages = []
    await withReminderFixture({
      ycloudStatus: 'PENDING',
      qrFallbackEnabled: false,
      apiSendEnabled: false,
      qrSendEnabled: true,
      qrStatus: 'connected'
    }, async ({ reminder, appointmentId, phoneNumberId }) => {
      await attachQrSessionForReminder(phoneNumberId, '+526561234567', sentMessages)

      const result = await processDueAppointmentReminders({ batchSize: 1 })

      assert.equal(result.sent, 1)
      assert.equal(result.errors, 0)
      assert.equal(captures.length, 0)
      assert.equal(sentMessages.length, 1)
      assert.match(sentMessages[0].payload.text, /Hola Ana/)

      const send = await db.get(
        'SELECT status, error_message FROM appointment_reminder_sends WHERE appointment_id = ?',
        [appointmentId]
      )
      assert.equal(send.status, 'sent')
      assert.equal(send.error_message, null)

      const overview = await getAppointmentRemindersOverview()
      const overviewReminder = overview.reminders.find((item) => item.id === reminder.id)
      assert.equal(overviewReminder?.deliveryHealth?.status, 'ready')
    })
  })
})

test('recordatorios con canal QR no brincan una API activa del mismo número', async () => {
  await withYCloudMessageCapture(async (captures) => {
    const sentMessages = []
    await withReminderFixture({
      ycloudStatus: 'PENDING',
      apiSendEnabled: true,
      qrSendEnabled: true,
      qrStatus: 'connected'
    }, async ({ reminder, appointmentId, contactId, phone, phoneNumberId }) => {
      await attachQrSessionForReminder(phoneNumberId, '+526561234567', sentMessages)
      await db.run(`
        INSERT INTO whatsapp_api_messages (
          id, provider, origin, business_phone_number_id, contact_id, phone,
          from_phone, to_phone, business_phone, transport, direction,
          message_type, message_text, status, message_timestamp,
          created_at, updated_at
        ) VALUES (?, 'ycloud', 'test_open_window', ?, ?, ?, ?, '+526561234567',
          '+526561234567', 'api', 'inbound', 'text', 'Hola', 'received', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        `wa_qr_channel_in_${appointmentId}`,
        phoneNumberId,
        contactId,
        phone,
        phone,
        new Date().toISOString()
      ])
      await db.run(`
        UPDATE appointment_reminders
        SET channel = 'whatsapp_qr',
            content_mode = 'direct',
            template_id = NULL,
            template_name = '',
            message_text = 'QR solo para {{contact.first_name}} a las {{cita.hora}}.'
        WHERE id = ?
      `, [reminder.id])

      const result = await processDueAppointmentReminders({ batchSize: 1 })

      assert.equal(result.sent, 1)
      assert.equal(result.errors, 0)
      assert.equal(captures.length, 1)
      assert.equal(captures[0].type, 'text')
      assert.match(captures[0].text.body, /QR solo para Ana/)
      assert.equal(sentMessages.length, 0)

      const send = await db.get(
        'SELECT status, sent_message_id, error_message FROM appointment_reminder_sends WHERE appointment_id = ?',
        [appointmentId]
      )
      assert.equal(send.status, 'sent')
      assert.equal(send.error_message, null)
      assert.equal(send.sent_message_id, 'ycloud_appointment_msg_1')

      const overview = await getAppointmentRemindersOverview()
      const overviewReminder = overview.reminders.find((item) => item.id === reminder.id)
      assert.equal(overviewReminder?.deliveryHealth?.status, 'warning')
      assert.match(overviewReminder?.deliveryHealth?.message || '', /API activa/)
    })
  })
})

test('recordatorios por canal disponible usan automáticamente el QR del mismo número si cae la API', async () => {
  await withYCloudMessageCapture(async (captures) => {
    const sentMessages = []
    await withReminderFixture({
      ycloudStatus: 'APPROVED',
      apiSendEnabled: true,
      qrSendEnabled: true,
      qrStatus: 'connected'
    }, async ({ reminder, appointmentId, contactId, phone, phoneNumberId }) => {
      await attachQrSessionForReminder(phoneNumberId, '+526561234567', sentMessages)
      await db.run(`
        INSERT INTO whatsapp_api_messages (
          id, provider, origin, business_phone_number_id, contact_id, phone,
          from_phone, to_phone, business_phone, transport, direction,
          message_type, message_text, status, message_timestamp,
          created_at, updated_at
        ) VALUES (?, 'ycloud', 'test_open_window', 'phone_appointment_reminder_test', ?, ?, ?, '+526561234567',
          '+526561234567', 'api', 'inbound', 'text', 'Hola', 'received', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        `wa_available_in_${appointmentId}`,
        contactId,
        phone,
        phone,
        new Date().toISOString()
      ])
      await db.run(`
        UPDATE appointment_reminders
        SET channel = 'available_channel',
            content_mode = 'direct',
            template_id = NULL,
            template_name = '',
            message_text = 'Canal disponible para {{contact.first_name}}.'
        WHERE id = ?
      `, [reminder.id])

      const result = await processDueAppointmentReminders({ batchSize: 1 })

      assert.equal(result.sent, 1)
      assert.equal(result.errors, 0)
      assert.equal(captures.length, 0)
      assert.equal(sentMessages.length, 1)
      assert.match(sentMessages[0].payload.text, /Canal disponible para Ana/)

      const send = await db.get(
        'SELECT status, sent_message_id, error_message FROM appointment_reminder_sends WHERE appointment_id = ?',
        [appointmentId]
      )
      assert.equal(send.status, 'sent')
      assert.equal(send.error_message, null)
      assert.equal(send.sent_message_id, 'qr_appointment_msg_1')
    })
  }, {
    onMessage: async () => ycloudJsonResponse(
      { error: { message: 'WhatsApp Business no está conectado' } },
      { status: 409, statusText: 'Conflict' }
    )
  })
})

test('recordatorios por canal que agendó no brincan una API activa del mismo número', async () => {
  await withYCloudMessageCapture(async (captures) => {
    const sentMessages = []
    await withReminderFixture({
      ycloudStatus: 'APPROVED',
      apiSendEnabled: true,
      qrSendEnabled: true,
      qrStatus: 'connected'
    }, async ({ reminder, appointmentId, contactId, phone, phoneNumberId }) => {
      await attachQrSessionForReminder(phoneNumberId, '+526561234567', sentMessages)
      await db.run(`
        INSERT INTO whatsapp_api_messages (
          id, provider, origin, business_phone_number_id, contact_id, phone,
          from_phone, to_phone, business_phone, transport, direction,
          message_type, message_text, status, message_timestamp,
          created_at, updated_at
        ) VALUES (?, 'ycloud', 'test_open_window', ?, ?, ?, ?, '+526561234567',
          '+526561234567', 'api', 'inbound', 'text', 'Hola', 'received', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        `wa_booking_qr_in_${appointmentId}`,
        phoneNumberId,
        contactId,
        phone,
        phone,
        new Date().toISOString()
      ])
      await db.run("UPDATE appointments SET source = 'ristak', booking_channel = 'whatsapp_qr' WHERE id = ?", [appointmentId])
      await db.run(`
        UPDATE appointment_reminders
        SET channel = 'booking_channel',
            content_mode = 'direct',
            template_id = NULL,
            template_name = '',
            message_text = 'Canal donde agendó para {{contact.first_name}}.'
        WHERE id = ?
      `, [reminder.id])

      const result = await processDueAppointmentReminders({ batchSize: 1 })

      assert.equal(result.sent, 1)
      assert.equal(result.errors, 0)
      assert.equal(captures.length, 1)
      assert.equal(captures[0].type, 'text')
      assert.match(captures[0].text.body, /Canal donde agendó para Ana/)
      assert.equal(sentMessages.length, 0)

      const send = await db.get(
        'SELECT status, sent_message_id, error_message FROM appointment_reminder_sends WHERE appointment_id = ?',
        [appointmentId]
      )
      assert.equal(send.status, 'sent')
      assert.equal(send.error_message, null)
      assert.equal(send.sent_message_id, 'ycloud_appointment_msg_1')
    })
  })
})

test('recordatorios de citas reintentan errores después del enfriamiento sin spamear', async () => {
  let failProvider = true

  await withYCloudMessageCapture(async (captures) => {
    await withReminderFixture({ ycloudStatus: 'APPROVED' }, async ({ appointmentId }) => {
      const firstRun = await processDueAppointmentReminders({ batchSize: 1 })

      assert.equal(firstRun.sent, 0)
      assert.equal(firstRun.errors, 1)
      assert.equal(captures.length, 0)

      const immediateRetry = await processDueAppointmentReminders({ batchSize: 1 })
      assert.equal(immediateRetry.sent, 0)
      assert.equal(immediateRetry.errors, 0)
      assert.equal(captures.length, 0)

      await db.run(
        `UPDATE appointment_reminder_sends
         SET sent_at = ?
         WHERE appointment_id = ?`,
        [DateTime.utc().minus({ minutes: 16 }).toISO(), appointmentId]
      )

      failProvider = false
      const retryRun = await processDueAppointmentReminders({ batchSize: 1 })

      assert.equal(retryRun.sent, 1)
      assert.equal(retryRun.errors, 0)
      assert.equal(captures.length, 1)

      const send = await db.get(
        'SELECT status, sent_message_id, error_message FROM appointment_reminder_sends WHERE appointment_id = ?',
        [appointmentId]
      )
      assert.equal(send.status, 'sent')
      assert.equal(send.sent_message_id, 'ycloud_appointment_msg_1')
      assert.equal(send.error_message, null)
    })
  }, {
    onMessage: async () => {
      if (!failProvider) return null
      return ycloudJsonResponse(
        { error: { message: 'YCloud temporalmente no disponible' } },
        { status: 500, statusText: 'Server Error' }
      )
    }
  })
})

test('el enfriamiento de recordatorios usa SQL nativo para SQLite y PostgreSQL', () => {
  assert.equal(
    appointmentReminderRetryCutoffExpression('sqlite'),
    'datetime(COALESCE(sent_at, created_at)) <= datetime(?)'
  )
  assert.equal(
    appointmentReminderRetryCutoffExpression('postgres'),
    'COALESCE(sent_at, created_at) <= ?::timestamp'
  )
})

test('overview marca recordatorios bloqueados si no hay remitente de WhatsApp', async () => {
  await withReminderFixture({ ycloudStatus: 'APPROVED' }, async ({ reminder, phoneNumberId }) => {
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId])

    const overview = await getAppointmentRemindersOverview()
    const overviewReminder = overview.reminders.find((item) => item.id === reminder.id)

    assert.equal(overviewReminder?.deliveryHealth?.status, 'error')
    assert.match(overviewReminder?.deliveryHealth?.message || '', /WhatsApp API|remitente/)
  })
})

test('avisos de cita después de agendar usan plantilla de cita programada sin activar confirmación', async () => {
  const existingReminders = await db.all('SELECT id, enabled FROM appointment_reminders')
  let reminderId = ''

  await db.run('UPDATE appointment_reminders SET enabled = 0')

  try {
    const reminder = await createAppointmentReminder({
      name: `Aviso ${randomUUID()}`,
      messageType: 'reminder',
      timingAnchor: 'after_booking',
      offsetValue: 0,
      offsetUnit: 'minutes',
      smartEnabled: false
    })
    reminderId = reminder.id

    assert.equal(reminder.messageType, 'reminder')
    assert.equal(reminder.timingAnchor, 'after_booking')
    assert.equal(reminder.offsetValue, 0)
    assert.equal(reminder.templateName, 'cita_programada')
  } finally {
    if (reminderId) await db.run('DELETE FROM appointment_reminders WHERE id = ?', [reminderId])
    for (const row of existingReminders) {
      await db.run('UPDATE appointment_reminders SET enabled = ? WHERE id = ?', [row.enabled, row.id])
    }
  }
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
