import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  db,
  repairWhatsAppApiContactIdentityFromMessages,
  setAppConfig
} from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  extractWhatsAppProfileName,
  normalizeWhatsAppProfileName
} from '../src/utils/whatsappContactProfile.js'
import {
  captureQrChatMessage,
  getWhatsAppApiConfigKeys,
  processYCloudWhatsAppWebhook,
  repairStoredYCloudHistoryMessageDirections,
  sendWhatsAppApiImageMessage,
  sendWhatsAppApiReactionMessage,
  sendWhatsAppApiTextMessage,
  setYCloudFetchForTest,
  syncYCloudContacts,
  syncYCloudMessageRecords
} from '../src/services/whatsappApiService.js'
import {
  QR_CONSENT_TEXT,
  resetWhatsAppQrServiceForTest,
  setBaileysRuntimeForTest
} from '../src/services/whatsappQrService.js'

const ONE_PIXEL_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

async function cleanup({ contactId, apiContactId, messageId, phone, eventId }) {
  await db.run('DELETE FROM whatsapp_api_attribution WHERE whatsapp_api_message_id = ? OR contact_id = ? OR phone = ?', [messageId, contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_messages WHERE id = ? OR contact_id = ? OR phone = ?', [messageId, contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_contacts WHERE id = ? OR contact_id = ? OR phone = ?', [apiContactId, contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_webhook_events WHERE event_id = ? OR id = ?', [eventId, eventId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
}

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

async function insertInboundMessageForOpenReplyWindow({
  id,
  contactId,
  phone,
  businessPhone,
  phoneNumberId,
  text = 'Respuesta reciente del cliente',
  messageAt = new Date().toISOString()
} = {}) {
  await db.run(`
    INSERT INTO whatsapp_api_messages (
      id, provider, ycloud_message_id, contact_id, phone, from_phone, to_phone,
      business_phone, business_phone_number_id, transport, direction, message_type,
      message_text, status, message_timestamp, created_at, updated_at
    ) VALUES (?, 'ycloud', ?, ?, ?, ?, ?, ?, ?, 'api', 'inbound', 'text', ?, 'received', ?, ?, ?)
  `, [
    `reply_window_${id}`,
    `reply_window_${id}`,
    contactId,
    phone,
    phone,
    businessPhone,
    businessPhone,
    phoneNumberId,
    text,
    messageAt,
    messageAt,
    messageAt
  ])
}

function createFakeBaileysRuntime({ connectedJid, sentMessages = [], ackDelayMs = null } = {}) {
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
          const id = `qr_fallback_msg_${messageIndex}`
          sentMessages.push({ id, jid, payload })
          const ackPayload = [{
            key: { id, remoteJid: jid, fromMe: true },
            update: { status: 3 }
          }]
          if (typeof ackDelayMs === 'number') {
            setTimeout(() => {
              emit('messages.update', ackPayload).catch(() => undefined)
            }, ackDelayMs)
          } else {
            await emit('messages.update', ackPayload)
          }
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

test('normaliza nombres reales de YCloud y descarta los genéricos', () => {
  assert.equal(normalizeWhatsAppProfileName('Contacto WhatsApp API', '+524433948272'), '')
  assert.equal(normalizeWhatsAppProfileName('Contacto WhatsApp_API', '+524433948272'), '')
  assert.equal(normalizeWhatsAppProfileName('+524433948272', '+524433948272'), '')
  assert.equal(extractWhatsAppProfileName({
    customerProfile: {
      name: 'Ana López',
      username: '@ana'
    }
  }, '+524433948272'), 'Ana López')
  assert.equal(extractWhatsAppProfileName({ displayName: 'Ana López' }, '+524433948272'), 'Ana López')
})

test('envio WhatsApp API manda contexto de respuesta y reaccion al globo original', async () => {
  const id = randomUUID()
  const suffix = Date.now().toString().slice(-7)
  const phone = `+52977${suffix}`
  const businessPhone = `+52633${suffix}`
  const phoneNumberId = `phone_reply_reaction_${id}`
  const contactId = `rstk_contact_reply_reaction_${id}`
  const targetLocalId = `wa_target_reply_reaction_${id}`
  const targetWamid = `wamid.reply.reaction.${id}`
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]
  const requestBodies = []

  await cleanup({ contactId, messageId: targetLocalId, phone })
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_reply_reaction_secret'))
      await setAppConfig(keys.senderPhone, businessPhone)
      await setAppConfig(keys.phoneNumberId, phoneNumberId)
      await setAppConfig(keys.wabaId, 'waba_reply_reaction_test')
      await setAppConfig(keys.provider, 'ycloud')

      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
        ) VALUES (?, 'ycloud', 'waba_reply_reaction_test', ?, ?, 'Reply Reaction Test', 1, 1, 0, 'disconnected', 'CONNECTED')
      `, [phoneNumberId, businessPhone, businessPhone])

      await db.run(`
        INSERT INTO contacts (id, phone, full_name, first_name, source, created_at, updated_at)
        VALUES (?, ?, 'Reply Reaction Contact', 'Reply', 'WhatsApp', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [contactId, phone])

      await db.run(`
        INSERT INTO whatsapp_api_messages (
          id, provider, ycloud_message_id, wamid, contact_id, phone, from_phone, to_phone,
          business_phone, business_phone_number_id, transport, direction, message_type,
          message_text, status, message_timestamp, created_at, updated_at
        ) VALUES (?, 'ycloud', ?, ?, ?, ?, ?, ?, ?, ?, 'api', 'inbound', 'text', 'Mensaje original', 'received', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        targetLocalId,
        `ycloud_${targetLocalId}`,
        targetWamid,
        contactId,
        phone,
        phone,
        businessPhone,
        businessPhone,
        phoneNumberId
      ])

      setYCloudFetchForTest(async (url, options = {}) => {
        const parsed = new URL(String(url))
        const path = parsed.pathname.replace(/^\/v2/, '')
        const method = String(options.method || 'GET').toUpperCase()
        if (path === '/whatsapp/messages' && method === 'POST') {
          const body = JSON.parse(String(options.body || '{}'))
          requestBodies.push(body)
          return ycloudJsonResponse({
            id: `ycloud_sent_${requestBodies.length}`,
            from: businessPhone,
            to: phone,
            status: 'sent',
            type: body.type,
            text: body.text,
            reaction: body.reaction,
            context: body.context,
            createTime: '2024-05-07T08:09:10.000Z'
          })
        }
        return ycloudJsonResponse({ items: [], total: 0 })
      })

      await sendWhatsAppApiTextMessage({
        to: phone,
        from: businessPhone,
        text: 'Respuesta con quote',
        contactId,
        phoneNumberId,
        replyToMessageId: targetLocalId
      })

      await sendWhatsAppApiReactionMessage({
        to: phone,
        from: businessPhone,
        emoji: '❤️',
        contactId,
        phoneNumberId,
        targetMessageId: targetLocalId
      })

      assert.equal(requestBodies.length, 2)
      assert.equal(requestBodies[0].type, 'text')
      assert.deepEqual(requestBodies[0].context, { message_id: targetWamid })
      assert.equal(requestBodies[1].type, 'reaction')
      assert.deepEqual(requestBodies[1].reaction, { message_id: targetWamid, emoji: '❤️' })
    })
  } finally {
    setYCloudFetchForTest(null)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await cleanup({ contactId, messageId: targetLocalId, phone })
  }
})

test('webhook entrante de YCloud reemplaza WhatsApp_API por customerProfile.name', async () => {
  const id = randomUUID()
  const phone = `+52997${Date.now().toString().slice(-7)}`
  const contactId = `rstk_contact_test_${id}`
  const messageId = `ycloud_live_profile_${id}`
  const eventId = `evt_live_profile_${id}`
  const messageAt = '2024-04-05T06:07:08.000Z'

  await cleanup({ contactId, messageId, phone, eventId })

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'WhatsApp_API',
      'WhatsApp_API',
      'WhatsApp_API',
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    const payload = {
      id: eventId,
      type: 'whatsapp.inbound_message.received',
      apiVersion: 'v2',
      createTime: messageAt,
      whatsappInboundMessage: {
        id: messageId,
        wamid: `wamid.${id}`,
        wabaId: 'WABA-ID',
        from: phone,
        customerProfile: {
          name: 'Ana López',
          username: '@ana'
        },
        to: '+526561000000',
        sendTime: messageAt,
        type: 'text',
        text: { body: 'Hola' }
      }
    }

    await processYCloudWhatsAppWebhook({
      payload,
      rawBody: JSON.stringify(payload),
      signatureHeader: '',
      endpointId: ''
    })

    const contact = await db.get('SELECT full_name, first_name FROM contacts WHERE id = ?', [contactId])
    assert.equal(contact.full_name, 'Ana López')
    assert.equal(contact.first_name, 'Ana López')

    const apiContact = await db.get('SELECT profile_name FROM whatsapp_api_contacts WHERE contact_id = ?', [contactId])
    assert.equal(apiContact.profile_name, 'Ana López')
  } finally {
    await cleanup({ contactId, messageId, phone, eventId })
  }
})

test('webhook entrante guarda cuerpo y botones de mensajes interactivos', async () => {
  const id = randomUUID()
  const phone = `+52998${Date.now().toString().slice(-7)}`
  const contactId = `rstk_contact_interactive_${id}`
  const apiContactId = `waapi_contact_interactive_${id}`
  const messageId = `ycloud_interactive_${id}`
  const eventId = `evt_interactive_${id}`
  const messageAt = '2024-04-05T06:07:08.000Z'

  await cleanup({ contactId, apiContactId, messageId, phone, eventId })

  try {
    const payload = {
      id: eventId,
      type: 'whatsapp.inbound_message.received',
      apiVersion: 'v2',
      createTime: messageAt,
      whatsappInboundMessage: {
        id: messageId,
        wamid: `wamid.${id}`,
        wabaId: 'WABA-ID',
        from: phone,
        customerProfile: {
          name: 'Facebook'
        },
        to: '+526561000000',
        sendTime: messageAt,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: {
            text: 'Use 096984 for two-factor authentication on Facebook.'
          },
          action: {
            buttons: [
              { reply: { id: 'copy_code', title: 'Copy code' } },
              { reply: { id: 'not_me', title: "I didn't request a code" } }
            ]
          }
        }
      }
    }

    await processYCloudWhatsAppWebhook({
      payload,
      rawBody: JSON.stringify(payload),
      signatureHeader: '',
      endpointId: ''
    })

    const row = await db.get(
      `SELECT message_type, message_text
       FROM whatsapp_api_messages
       WHERE ycloud_message_id = ?
       LIMIT 1`,
      [messageId]
    )

    assert.equal(row.message_type, 'interactive')
    assert.equal(
      row.message_text,
      "Use 096984 for two-factor authentication on Facebook.\n\n- Copy code\n- I didn't request a code"
    )
    assert.notEqual(row.message_text, 'Mensaje')
  } finally {
    await cleanup({ contactId, apiContactId, messageId, phone, eventId })
  }
})

test('webhook saliente respeta contactId existente aunque el teléfono todavía no esté guardado', async () => {
  const id = randomUUID()
  const phone = `+52996${Date.now().toString().slice(-7)}`
  const contactId = `rstk_contact_test_${id}`
  const messageId = `ycloud_outbound_contact_${id}`
  const eventId = `evt_outbound_contact_${id}`
  const messageAt = '2024-05-06T07:08:09.000Z'

  await cleanup({ contactId, messageId, phone, eventId })

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, created_at, updated_at
      ) VALUES (?, NULL, ?, ?, ?, ?, ?)
    `, [
      contactId,
      'Ana López',
      'Ana',
      'manual',
      '2024-05-01T00:00:00.000Z',
      '2024-05-01T00:00:00.000Z'
    ])

    const payload = {
      id: eventId,
      type: 'whatsapp.message.updated',
      apiVersion: 'v2',
      createTime: messageAt,
      contactId,
      whatsappMessage: {
        id: messageId,
        from: '+526561000000',
        to: phone,
        sendTime: messageAt,
        status: 'sent',
        type: 'text',
        text: { body: 'Hola Ana' }
      }
    }

    await processYCloudWhatsAppWebhook({
      payload,
      rawBody: JSON.stringify(payload),
      signatureHeader: '',
      endpointId: ''
    })

    const message = await db.get('SELECT contact_id, phone FROM whatsapp_api_messages WHERE ycloud_message_id = ?', [messageId])
    assert.equal(message.contact_id, contactId)
    assert.equal(message.phone, phone)

    const contacts = await db.all('SELECT id, full_name, phone FROM contacts WHERE id = ? OR phone = ?', [contactId, phone])
    assert.equal(contacts.length, 1)
    assert.equal(contacts[0].id, contactId)
    assert.equal(contacts[0].full_name, 'Ana López')
    assert.equal(contacts[0].phone, phone)
  } finally {
    await cleanup({ contactId, messageId, phone, eventId })
  }
})

test('webhook fallido repetido conserva el globo respaldado por QR', async () => {
  const id = randomUUID()
  const phone = `+52995${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000001'
  const contactId = `rstk_contact_test_${id}`
  const messageId = `ycloud_qr_fallback_${id}`
  const eventId = `evt_qr_fallback_repeat_${id}`
  const messageAt = '2024-05-07T08:09:10.000Z'
  const fallbackReason = 'Message failed to send because more than 24 hours have passed since the customer last replied to this number.'
  const rawPayload = JSON.stringify({
    fallbackFrom: 'api',
    fallbackTransport: 'qr',
    fallbackReason,
    whatsappMessage: { id: `qr_${id}`, status: 'sent' }
  })

  await cleanup({ contactId, messageId, phone, eventId })

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'Cliente QR',
      'Cliente',
      'WhatsApp_API',
      messageAt,
      messageAt
    ])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, provider, ycloud_message_id, contact_id, phone, from_phone, to_phone,
        business_phone, transport, routing_reason, direction, message_type,
        message_text, status, error_code, error_message, raw_payload_json,
        message_timestamp, created_at, updated_at
      ) VALUES (?, 'ycloud', ?, ?, ?, ?, ?, ?, 'qr', ?, 'outbound', 'text', ?, 'sent', '131047', ?, ?, ?, ?, ?)
    `, [
      messageId,
      messageId,
      contactId,
      phone,
      businessPhone,
      phone,
      businessPhone,
      fallbackReason,
      'Hola, seguimos aquí',
      fallbackReason,
      rawPayload,
      messageAt,
      messageAt,
      messageAt
    ])

    const payload = {
      id: eventId,
      type: 'whatsapp.message.updated',
      apiVersion: 'v2',
      createTime: messageAt,
      whatsappMessage: {
        id: messageId,
        from: businessPhone,
        to: phone,
        sendTime: messageAt,
        status: 'failed',
        type: 'text',
        text: { body: 'Hola, seguimos aquí' },
        error: {
          code: '131047',
          message: fallbackReason
        }
      }
    }

    await processYCloudWhatsAppWebhook({
      payload,
      rawBody: JSON.stringify(payload),
      signatureHeader: '',
      endpointId: ''
    })

    const message = await db.get(`
      SELECT transport, routing_reason, status, error_code, error_message, raw_payload_json
      FROM whatsapp_api_messages
      WHERE id = ?
    `, [messageId])

    assert.equal(message.transport, 'qr')
    assert.equal(message.routing_reason, fallbackReason)
    assert.equal(message.status, 'sent')
    assert.equal(message.error_code, null)
    assert.equal(message.error_message, null)
    assert.equal(message.raw_payload_json, rawPayload)
  } finally {
    await cleanup({ contactId, messageId, phone, eventId })
  }
})

test('eco QR repara un globo API fallido duplicado', async () => {
  const id = randomUUID()
  const suffix = Date.now().toString().slice(-7)
  const phone = `+52991${suffix}`
  const businessPhone = `+52654${suffix}`
  const phoneNumberId = `phone_qr_echo_repair_${id}`
  const contactId = `rstk_contact_qr_echo_repair_${id}`
  const messageId = `api_failed_qr_echo_${id}`
  const body = 'Hola, esto ya salió por QR'
  const messageAt = '2024-05-07T08:09:10.000Z'
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]

  await cleanup({ contactId, messageId, phone })
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_qr_echo_repair_secret'))
      await setAppConfig(keys.senderPhone, businessPhone)
      await setAppConfig(keys.phoneNumberId, phoneNumberId)
      await setAppConfig(keys.wabaId, 'waba_qr_echo_repair_test')
      await setAppConfig(keys.provider, 'ycloud')

      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, qr_connected_phone, status
        ) VALUES (?, 'ycloud', 'waba_qr_echo_repair_test', ?, ?, 'QR Echo Repair Test', 1, 1, 1, 'connected', ?, 'CONNECTED')
      `, [phoneNumberId, businessPhone, businessPhone, businessPhone])

      await db.run(`
        INSERT INTO contacts (
          id, phone, full_name, first_name, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        contactId,
        phone,
        'Cliente Eco QR',
        'Cliente',
        'WhatsApp_API',
        messageAt,
        messageAt
      ])

      await db.run(`
        INSERT INTO whatsapp_api_messages (
          id, provider, ycloud_message_id, wamid, contact_id, phone, from_phone, to_phone,
          business_phone, business_phone_number_id, transport, direction, message_type,
          message_text, status, error_code, error_message, message_timestamp, created_at, updated_at
        ) VALUES (?, 'ycloud', ?, ?, ?, ?, ?, ?, ?, ?, 'api', 'outbound', 'text', ?, 'failed', '131047', ?, ?, ?, ?)
      `, [
        messageId,
        messageId,
        `api_${id}`,
        contactId,
        phone,
        businessPhone,
        phone,
        businessPhone,
        phoneNumberId,
        body,
        'Message failed to send because more than 24 hours have passed since the customer last replied to this number.',
        messageAt,
        messageAt,
        messageAt
      ])

      const result = await captureQrChatMessage({
        phoneNumberId,
        businessPhone,
        direction: 'outbound',
        wamid: `qr_echo_${id}`,
        messageType: 'text',
        text: body,
        contactPhone: phone,
        timestamp: messageAt
      })

      assert.equal(result.repaired, true)
      assert.equal(result.messageId, messageId)
      assert.equal(result.transport, 'qr')

      const message = await db.get(`
        SELECT transport, routing_reason, status, error_code, error_message, wamid, raw_payload_json
        FROM whatsapp_api_messages
        WHERE id = ?
      `, [messageId])

      assert.equal(message.transport, 'qr')
      assert.equal(message.routing_reason, 'Capturado desde la sesión de WhatsApp Web.')
      assert.equal(message.status, 'sent')
      assert.equal(message.error_code, null)
      assert.equal(message.error_message, null)
      assert.equal(message.wamid, `qr_echo_${id}`)
      const rawPayload = JSON.parse(message.raw_payload_json)
      assert.equal(rawPayload.fallbackFrom, 'api')
      assert.equal(rawPayload.fallbackTransport, 'qr')
      assert.equal(rawPayload.qrEcho, true)
      assert.equal(rawPayload.clearedApiError.code, '131047')
    })
  } finally {
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await cleanup({ contactId, messageId, phone })
  }
})

test('eco QR saliente escrito en el teléfono se captura aunque la API oficial esté operativa', async () => {
  // Regresión: la API oficial NO reporta por webhook los mensajes que el operador escribe
  // directamente en el teléfono; su único origen es el eco fromMe de Baileys. El skip
  // 'official_api_active' solo debe aplicar al inbound (que el webhook sí cubre).
  const id = randomUUID()
  const suffix = Date.now().toString().slice(-7)
  const phone = `+52993${suffix}`
  const businessPhone = `+52655${suffix}`
  const phoneNumberId = `phone_qr_outbound_echo_${id}`
  const contactId = `rstk_contact_qr_outbound_echo_${id}`
  const outboundWamid = `qr_outbound_echo_${id}`
  const inboundWamid = `qr_inbound_echo_${id}`
  const outboundBody = `Respuesta escrita en el teléfono ${id}`
  const inboundBody = `Mensaje entrante del cliente ${id}`
  const messageAt = '2024-06-01T10:20:30.000Z'
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]

  await cleanup({ contactId, messageId: outboundWamid, phone })
  await db.run('DELETE FROM whatsapp_api_messages WHERE wamid IN (?, ?)', [outboundWamid, inboundWamid]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_qr_outbound_echo_secret'))
      await setAppConfig(keys.senderPhone, businessPhone)
      await setAppConfig(keys.phoneNumberId, phoneNumberId)
      await setAppConfig(keys.wabaId, 'waba_qr_outbound_echo_test')
      await setAppConfig(keys.provider, 'ycloud')

      // API oficial totalmente operativa (enabled + apiKey + api_send_enabled=1 + CONNECTED, sin alertas bloqueantes).
      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, qr_connected_phone, status
        ) VALUES (?, 'ycloud', 'waba_qr_outbound_echo_test', ?, ?, 'QR Outbound Echo Test', 1, 1, 1, 'connected', ?, 'CONNECTED')
      `, [phoneNumberId, businessPhone, businessPhone, businessPhone])

      await db.run(`
        INSERT INTO contacts (
          id, phone, full_name, first_name, source, created_at, updated_at
        ) VALUES (?, ?, 'Cliente Eco Saliente', 'Cliente', 'WhatsApp_API', ?, ?)
      `, [contactId, phone, messageAt, messageAt])

      // Saliente escrito en el teléfono: sin fila API previa que dedupear -> debe capturarse.
      const outboundResult = await captureQrChatMessage({
        phoneNumberId,
        businessPhone,
        direction: 'outbound',
        wamid: outboundWamid,
        messageType: 'text',
        text: outboundBody,
        contactPhone: phone,
        timestamp: messageAt
      })

      assert.equal(outboundResult.skipped, false)
      assert.equal(outboundResult.isNew, true)

      const outboundRow = await db.get(`
        SELECT direction, transport, origin, routing_reason, message_text, wamid
        FROM whatsapp_api_messages
        WHERE wamid = ?
      `, [outboundWamid])
      assert.ok(outboundRow, 'el eco saliente debe persistirse')
      assert.equal(outboundRow.direction, 'outbound')
      assert.equal(outboundRow.transport, 'qr')
      assert.equal(outboundRow.origin, 'whatsapp.qr.message.synced')
      assert.equal(outboundRow.routing_reason, 'Capturado desde la sesión de WhatsApp Web.')
      assert.equal(outboundRow.message_text, outboundBody)

      // Entrante con la misma config: SÍ se omite porque el webhook de YCloud ya lo registra.
      const inboundResult = await captureQrChatMessage({
        phoneNumberId,
        businessPhone,
        direction: 'inbound',
        wamid: inboundWamid,
        messageType: 'text',
        text: inboundBody,
        contactPhone: phone,
        timestamp: messageAt
      })

      assert.equal(inboundResult.skipped, true)
      assert.equal(inboundResult.reason, 'official_api_active')

      const inboundRow = await db.get('SELECT id FROM whatsapp_api_messages WHERE wamid = ?', [inboundWamid])
      assert.ok(!inboundRow, 'el entrante no debe persistirse por QR cuando la API oficial está operativa')
    })
  } finally {
    await db.run('DELETE FROM whatsapp_api_messages WHERE wamid IN (?, ?)', [outboundWamid, inboundWamid]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await cleanup({ contactId, messageId: outboundWamid, phone })
  }
})

test('eco QR de foto API sin caption no crea globo Foto duplicado', async () => {
  const id = randomUUID()
  const suffix = Date.now().toString().slice(-7)
  const phone = `+52992${suffix}`
  const businessPhone = `+52656${suffix}`
  const phoneNumberId = `phone_qr_api_photo_echo_${id}`
  const contactId = `rstk_contact_qr_api_photo_echo_${id}`
  const apiMessageId = `api_photo_no_caption_${id}`
  const qrEchoWamid = `qr_photo_echo_${id}`
  const messageAt = '2024-06-01T10:20:30.000Z'
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]

  await cleanup({ contactId, messageId: apiMessageId, phone })
  await db.run('DELETE FROM whatsapp_api_messages WHERE wamid = ?', [qrEchoWamid]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_qr_api_photo_echo_secret'))
      await setAppConfig(keys.senderPhone, businessPhone)
      await setAppConfig(keys.phoneNumberId, phoneNumberId)
      await setAppConfig(keys.wabaId, 'waba_qr_api_photo_echo_test')
      await setAppConfig(keys.provider, 'ycloud')

      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, qr_connected_phone, status
        ) VALUES (?, 'ycloud', 'waba_qr_api_photo_echo_test', ?, ?, 'QR API Photo Echo Test', 1, 1, 1, 'connected', ?, 'CONNECTED')
      `, [phoneNumberId, businessPhone, businessPhone, businessPhone])

      await db.run(`
        INSERT INTO contacts (
          id, phone, full_name, first_name, source, created_at, updated_at
        ) VALUES (?, ?, 'Cliente Foto Eco', 'Cliente', 'WhatsApp_API', ?, ?)
      `, [contactId, phone, messageAt, messageAt])

      await db.run(`
        INSERT INTO whatsapp_api_messages (
          id, provider, ycloud_message_id, wamid, contact_id, phone, from_phone, to_phone,
          business_phone, business_phone_number_id, transport, direction, message_type,
          message_text, media_url, media_mime_type, media_filename, status,
          message_timestamp, created_at, updated_at
        ) VALUES (?, 'ycloud', ?, ?, ?, ?, ?, ?, ?, ?, 'api', 'outbound', 'image',
          NULL, '/media/assets/api-photo-preview/file', 'image/jpeg', 'whatsapp-image.jpg', 'sent',
          ?, ?, ?)
      `, [
        apiMessageId,
        apiMessageId,
        `wamid_api_photo_${id}`,
        contactId,
        phone,
        businessPhone,
        phone,
        businessPhone,
        phoneNumberId,
        messageAt,
        messageAt,
        messageAt
      ])

      const result = await captureQrChatMessage({
        phoneNumberId,
        businessPhone,
        direction: 'outbound',
        wamid: qrEchoWamid,
        messageType: 'image',
        text: '',
        contactPhone: phone,
        timestamp: messageAt
      })

      assert.equal(result.skipped, true)
      assert.equal(result.reason, 'duplicate_recent')
      assert.equal(result.messageId, apiMessageId)

      const duplicate = await db.get('SELECT id FROM whatsapp_api_messages WHERE wamid = ?', [qrEchoWamid])
      assert.ok(!duplicate)

      const row = await db.get('SELECT transport, message_type, message_text FROM whatsapp_api_messages WHERE id = ?', [apiMessageId])
      assert.equal(row.transport, 'api')
      assert.equal(row.message_type, 'image')
      assert.equal(row.message_text, null)
    })
  } finally {
    await db.run('DELETE FROM whatsapp_api_messages WHERE wamid = ?', [qrEchoWamid]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await cleanup({ contactId, messageId: apiMessageId, phone })
  }
})

test('envio API fallido inmediato responde y persiste el respaldo QR limpio', async () => {
  const id = randomUUID()
  const phone = `+52994${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000002'
  const connectedJid = `${normalizeDigits(businessPhone)}@s.whatsapp.net`
  const phoneNumberId = `phone_api_qr_fallback_${id}`
  const contactId = `rstk_contact_api_qr_fallback_${id}`
  const ycloudMessageId = `ycloud_api_failed_${id}`
  const externalId = `manual_chat_${id}`
  const body = 'Hola, esto debe salir por QR'
  const fallbackReason = 'Message failed to send because more than 24 hours have passed since the customer last replied to this number.'
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]
  const sentMessages = []

  await cleanup({ contactId, messageId: ycloudMessageId, phone })
  await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_qr_fallback_secret'))
      await setAppConfig(keys.senderPhone, businessPhone)
      await setAppConfig(keys.phoneNumberId, phoneNumberId)
      await setAppConfig(keys.wabaId, 'waba_api_qr_fallback_test')
      await setAppConfig(keys.provider, 'ycloud')

      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
        ) VALUES (?, 'ycloud', 'waba_api_qr_fallback_test', ?, ?, 'API QR Fallback Test', 1, 1, 1, 'connected', 'CONNECTED')
      `, [phoneNumberId, businessPhone, businessPhone])

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

      await insertInboundMessageForOpenReplyWindow({
        id,
        contactId,
        phone,
        businessPhone,
        phoneNumberId
      })

      setBaileysRuntimeForTest(createFakeBaileysRuntime({ connectedJid, sentMessages, ackDelayMs: 0 }))
      setYCloudFetchForTest(async (url, options = {}) => {
        const parsed = new URL(String(url))
        const path = parsed.pathname.replace(/^\/v2/, '')
        const method = String(options.method || 'GET').toUpperCase()
        if (path === '/whatsapp/messages' && method === 'POST') {
          return ycloudJsonResponse({
            id: ycloudMessageId,
            from: businessPhone,
            to: phone,
            status: 'failed',
            type: 'text',
            text: { body },
            error: {
              code: '131047',
              message: fallbackReason
            },
            createTime: '2024-05-07T08:09:10.000Z'
          })
        }
        return ycloudJsonResponse({ items: [], total: 0 })
      })

      const result = await sendWhatsAppApiTextMessage({
        to: phone,
        from: businessPhone,
        text: body,
        externalId,
        contactId,
        phoneNumberId,
        skipQrSendProtection: true
      })

      assert.equal(result.transport, 'qr')
      assert.equal(result.status, 'delivered')
      assert.equal(result.fallback, true)
      assert.equal(result.fallbackFrom, 'api')
      assert.equal(result.routingReason, 'La conversación lleva más de 24 horas sin respuesta del cliente; WhatsApp API solo permite plantillas.')
      assert.equal(sentMessages.length, 1)
      assert.equal(sentMessages[0].payload.text, body)

      const message = await db.get(`
        SELECT transport, routing_reason, status, error_code, error_message, raw_payload_json, message_text
        FROM whatsapp_api_messages
        WHERE ycloud_message_id = ?
      `, [ycloudMessageId])

      assert.equal(message.transport, 'qr')
      assert.equal(message.status, 'delivered')
      assert.equal(message.error_code, null)
      assert.equal(message.error_message, null)
      assert.equal(message.message_text, body)
      assert.equal(message.routing_reason, 'La conversación lleva más de 24 horas sin respuesta del cliente; WhatsApp API solo permite plantillas.')
      const rawPayload = JSON.parse(message.raw_payload_json)
      assert.equal(rawPayload.fallbackFrom, 'api')
      assert.equal(rawPayload.fallbackTransport, 'qr')
      assert.equal(rawPayload.whatsappMessage.transport, 'qr')
    })
  } finally {
    setYCloudFetchForTest(null)
    resetWhatsAppQrServiceForTest()
    await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await cleanup({ contactId, messageId: ycloudMessageId, phone })
  }
})

test('envio API fuera de ventana usa QR en preflight sin llamar YCloud', async () => {
  const id = randomUUID()
  const suffix = Date.now().toString().slice(-7)
  const phone = `+52989${suffix}`
  const businessPhone = `+52653${suffix}`
  const connectedJid = `${normalizeDigits(businessPhone)}@s.whatsapp.net`
  const phoneNumberId = `phone_api_qr_preflight_${id}`
  const contactId = `rstk_contact_api_qr_preflight_${id}`
  const inboundMessageId = `inbound_api_qr_preflight_${id}`
  const externalId = `manual_chat_preflight_${id}`
  const body = 'Hola, esto no debe tocar la API'
  const lastInboundAt = '2024-05-01T08:00:00.000Z'
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]
  const sentMessages = []
  let ycloudPostCalls = 0

  await cleanup({ contactId, messageId: inboundMessageId, phone })
  await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_qr_preflight_secret'))
      await setAppConfig(keys.senderPhone, businessPhone)
      await setAppConfig(keys.phoneNumberId, phoneNumberId)
      await setAppConfig(keys.wabaId, 'waba_api_qr_preflight_test')
      await setAppConfig(keys.provider, 'ycloud')

      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, qr_connected_phone, status
        ) VALUES (?, 'ycloud', 'waba_api_qr_preflight_test', ?, ?, 'API QR Preflight Test', 1, 1, 1, 'connected', ?, 'CONNECTED')
      `, [phoneNumberId, businessPhone, businessPhone, businessPhone])

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

      await db.run(`
        INSERT INTO contacts (
          id, phone, full_name, first_name, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        contactId,
        phone,
        'Cliente Preflight QR',
        'Cliente',
        'WhatsApp_API',
        lastInboundAt,
        lastInboundAt
      ])

      await db.run(`
        INSERT INTO whatsapp_api_messages (
          id, provider, ycloud_message_id, contact_id, phone, from_phone, to_phone,
          business_phone, business_phone_number_id, transport, direction, message_type,
          message_text, status, message_timestamp, created_at, updated_at
        ) VALUES (?, 'ycloud', ?, ?, ?, ?, ?, ?, ?, 'api', 'inbound', 'text', ?, 'received', ?, ?, ?)
      `, [
        inboundMessageId,
        inboundMessageId,
        contactId,
        phone,
        phone,
        businessPhone,
        businessPhone,
        phoneNumberId,
        'Respuesta vieja del cliente',
        lastInboundAt,
        lastInboundAt,
        lastInboundAt
      ])

      setBaileysRuntimeForTest(createFakeBaileysRuntime({ connectedJid, sentMessages }))
      setYCloudFetchForTest(async (url, options = {}) => {
        const parsed = new URL(String(url))
        const path = parsed.pathname.replace(/^\/v2/, '')
        const method = String(options.method || 'GET').toUpperCase()
        if (path === '/whatsapp/messages' && method === 'POST') {
          ycloudPostCalls += 1
          throw new Error('YCloud no debe recibir mensajes cuando el QR puede cubrir la ventana cerrada')
        }
        return ycloudJsonResponse({ items: [], total: 0 })
      })

      const result = await sendWhatsAppApiTextMessage({
        to: phone,
        from: businessPhone,
        text: body,
        externalId,
        contactId,
        phoneNumberId,
        skipQrSendProtection: true
      })

      assert.equal(result.transport, 'qr')
      assert.equal(result.fallback, true)
      assert.equal(result.fallbackFrom, 'api')
      assert.equal(result.routingReason, 'La conversación lleva más de 24 horas sin respuesta del cliente; WhatsApp API solo permite plantillas.')
      assert.equal(ycloudPostCalls, 0)
      assert.equal(sentMessages.length, 1)
      assert.equal(sentMessages[0].payload.text, body)

      const message = await db.get(`
        SELECT transport, routing_reason, status, error_code, error_message, message_text
        FROM whatsapp_api_messages
        WHERE contact_id = ? AND direction = 'outbound' AND message_text = ?
        ORDER BY created_at DESC
        LIMIT 1
      `, [contactId, body])

      assert.equal(message.transport, 'qr')
      assert.equal(message.error_code, null)
      assert.equal(message.error_message, null)
      assert.equal(message.message_text, body)
      assert.equal(message.routing_reason, 'La conversación lleva más de 24 horas sin respuesta del cliente; WhatsApp API solo permite plantillas.')
    })
  } finally {
    setYCloudFetchForTest(null)
    resetWhatsAppQrServiceForTest()
    await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await cleanup({ contactId, messageId: inboundMessageId, phone })
  }
})

test('envio de foto fuera de ventana usa QR como imagen y no como texto', async () => {
  const id = randomUUID()
  const suffix = Date.now().toString().slice(-7)
  const phone = `+52988${suffix}`
  const businessPhone = `+52652${suffix}`
  const connectedJid = `${normalizeDigits(businessPhone)}@s.whatsapp.net`
  const phoneNumberId = `phone_api_qr_image_preflight_${id}`
  const contactId = `rstk_contact_api_qr_image_preflight_${id}`
  const inboundMessageId = `inbound_api_qr_image_preflight_${id}`
  const externalId = `manual_chat_image_preflight_${id}`
  const lastInboundAt = '2024-05-01T08:00:00.000Z'
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]
  const sentMessages = []
  let ycloudPostCalls = 0

  await cleanup({ contactId, messageId: inboundMessageId, phone })
  await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_qr_image_preflight_secret'))
      await setAppConfig(keys.senderPhone, businessPhone)
      await setAppConfig(keys.phoneNumberId, phoneNumberId)
      await setAppConfig(keys.wabaId, 'waba_api_qr_image_preflight_test')
      await setAppConfig(keys.provider, 'ycloud')

      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, qr_connected_phone, status
        ) VALUES (?, 'ycloud', 'waba_api_qr_image_preflight_test', ?, ?, 'API QR Image Preflight Test', 1, 1, 1, 'connected', ?, 'CONNECTED')
      `, [phoneNumberId, businessPhone, businessPhone, businessPhone])

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

      await db.run(`
        INSERT INTO contacts (
          id, phone, full_name, first_name, source, created_at, updated_at
        ) VALUES (?, ?, 'Cliente Foto QR', 'Cliente', 'WhatsApp_API', ?, ?)
      `, [contactId, phone, lastInboundAt, lastInboundAt])

      await db.run(`
        INSERT INTO whatsapp_api_messages (
          id, provider, ycloud_message_id, contact_id, phone, from_phone, to_phone,
          business_phone, business_phone_number_id, transport, direction, message_type,
          message_text, status, message_timestamp, created_at, updated_at
        ) VALUES (?, 'ycloud', ?, ?, ?, ?, ?, ?, ?, 'api', 'inbound', 'text', 'Respuesta vieja del cliente', 'received', ?, ?, ?)
      `, [
        inboundMessageId,
        inboundMessageId,
        contactId,
        phone,
        phone,
        businessPhone,
        businessPhone,
        phoneNumberId,
        lastInboundAt,
        lastInboundAt,
        lastInboundAt
      ])

      setBaileysRuntimeForTest(createFakeBaileysRuntime({ connectedJid, sentMessages }))
      setYCloudFetchForTest(async (url, options = {}) => {
        const parsed = new URL(String(url))
        const path = parsed.pathname.replace(/^\/v2/, '')
        const method = String(options.method || 'GET').toUpperCase()
        if (path === '/whatsapp/messages' && method === 'POST') {
          ycloudPostCalls += 1
          throw new Error('YCloud no debe recibir fotos cuando el QR puede cubrir la ventana cerrada')
        }
        return ycloudJsonResponse({ items: [], total: 0 })
      })

      const result = await sendWhatsAppApiImageMessage({
        to: phone,
        from: businessPhone,
        imageDataUrl: ONE_PIXEL_PNG_DATA_URL,
        externalId,
        contactId,
        phoneNumberId,
        skipQrSendProtection: true
      })

      assert.equal(result.transport, 'qr')
      assert.equal(result.fallback, true)
      assert.equal(result.fallbackFrom, 'api')
      assert.equal(ycloudPostCalls, 0)
      assert.equal(sentMessages.length, 1)
      assert.equal(sentMessages[0].payload.text, undefined)
      assert.equal(sentMessages[0].payload.image instanceof Buffer, true)

      const message = await db.get(`
        SELECT transport, routing_reason, status, message_type, message_text
        FROM whatsapp_api_messages
        WHERE contact_id = ? AND direction = 'outbound' AND message_type = 'image'
        ORDER BY created_at DESC
        LIMIT 1
      `, [contactId])

      assert.equal(message.transport, 'qr')
      assert.equal(message.message_type, 'image')
      assert.equal(message.message_text, null)
      assert.equal(message.routing_reason, 'La conversación lleva más de 24 horas sin respuesta del cliente; WhatsApp API solo permite plantillas.')
    })
  } finally {
    setYCloudFetchForTest(null)
    resetWhatsAppQrServiceForTest()
    await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await cleanup({ contactId, messageId: inboundMessageId, phone })
  }
})

test('envio API sin inbound conocido usa QR en preflight sin llamar YCloud', async () => {
  const id = randomUUID()
  const suffix = Date.now().toString().slice(-7)
  const phone = `+52988${suffix}`
  const businessPhone = `+52654${suffix}`
  const connectedJid = `${normalizeDigits(businessPhone)}@s.whatsapp.net`
  const phoneNumberId = `phone_api_qr_unknown_window_${id}`
  const contactId = `rstk_contact_api_qr_unknown_window_${id}`
  const externalId = `manual_chat_unknown_window_${id}`
  const body = 'Hola, esto tampoco debe tocar la API'
  const now = new Date().toISOString()
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]
  const sentMessages = []
  let ycloudPostCalls = 0

  await cleanup({ contactId, messageId: externalId, phone })
  await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_qr_unknown_window_secret'))
      await setAppConfig(keys.senderPhone, businessPhone)
      await setAppConfig(keys.phoneNumberId, phoneNumberId)
      await setAppConfig(keys.wabaId, 'waba_api_qr_unknown_window_test')
      await setAppConfig(keys.provider, 'ycloud')

      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, qr_connected_phone, status
        ) VALUES (?, 'ycloud', 'waba_api_qr_unknown_window_test', ?, ?, 'API QR Unknown Window Test', 1, 1, 1, 'connected', ?, 'CONNECTED')
      `, [phoneNumberId, businessPhone, businessPhone, businessPhone])

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

      await db.run(`
        INSERT INTO contacts (
          id, phone, full_name, first_name, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        contactId,
        phone,
        'Cliente Sin Inbound',
        'Cliente',
        'WhatsApp_API',
        now,
        now
      ])

      setBaileysRuntimeForTest(createFakeBaileysRuntime({ connectedJid, sentMessages }))
      setYCloudFetchForTest(async (url, options = {}) => {
        const parsed = new URL(String(url))
        const path = parsed.pathname.replace(/^\/v2/, '')
        const method = String(options.method || 'GET').toUpperCase()
        if (path === '/whatsapp/messages' && method === 'POST') {
          ycloudPostCalls += 1
          throw new Error('YCloud no debe recibir mensajes sin ventana de respuesta conocida')
        }
        return ycloudJsonResponse({ items: [], total: 0 })
      })

      const result = await sendWhatsAppApiTextMessage({
        to: phone,
        from: businessPhone,
        text: body,
        externalId,
        contactId,
        phoneNumberId,
        skipQrSendProtection: true
      })

      assert.equal(result.transport, 'qr')
      assert.equal(result.fallback, true)
      assert.equal(result.fallbackFrom, 'api')
      assert.match(result.routingReason, /No hay una respuesta reciente del cliente registrada/)
      assert.equal(ycloudPostCalls, 0)
      assert.equal(sentMessages.length, 1)
      assert.equal(sentMessages[0].payload.text, body)

      const message = await db.get(`
        SELECT transport, routing_reason, status, error_code, error_message, message_text
        FROM whatsapp_api_messages
        WHERE contact_id = ? AND direction = 'outbound' AND message_text = ?
        ORDER BY created_at DESC
        LIMIT 1
      `, [contactId, body])

      assert.equal(message.transport, 'qr')
      assert.equal(message.error_code, null)
      assert.equal(message.error_message, null)
      assert.equal(message.message_text, body)
      assert.match(message.routing_reason, /No hay una respuesta reciente del cliente registrada/)
    })
  } finally {
    setYCloudFetchForTest(null)
    resetWhatsAppQrServiceForTest()
    await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await cleanup({ contactId, messageId: externalId, phone })
  }
})

test('envio API fuera de ventana usa QR aunque el QR viva en otro registro del mismo numero', async () => {
  const id = randomUUID()
  const suffix = Date.now().toString().slice(-7)
  const phone = `+52993${suffix}`
  const businessPhone = `+52656${suffix}`
  const connectedJid = `${normalizeDigits(businessPhone)}@s.whatsapp.net`
  const apiPhoneNumberId = `phone_api_sender_${id}`
  const qrPhoneNumberId = `phone_qr_sender_${id}`
  const contactId = `rstk_contact_api_qr_split_${id}`
  const ycloudMessageId = `ycloud_api_split_failed_${id}`
  const externalId = `manual_chat_split_${id}`
  const body = 'Hola, esto debe salir por el QR separado'
  const fallbackReason = 'Message failed to send because more than 24 hours have passed since the customer last replied to this number.'
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]
  const sentMessages = []

  await cleanup({ contactId, messageId: ycloudMessageId, phone })
  for (const phoneNumberId of [apiPhoneNumberId, qrPhoneNumberId]) {
    await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
  }

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_qr_split_fallback_secret'))
      await setAppConfig(keys.senderPhone, businessPhone)
      await setAppConfig(keys.phoneNumberId, apiPhoneNumberId)
      await setAppConfig(keys.wabaId, 'waba_api_qr_split_fallback_test')
      await setAppConfig(keys.provider, 'ycloud')

      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
        ) VALUES (?, 'ycloud', 'waba_api_qr_split_fallback_test', ?, ?, 'API Sender Test', 1, 1, 0, 'disconnected', 'CONNECTED')
      `, [apiPhoneNumberId, businessPhone, businessPhone])

      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, qr_connected_phone, status
        ) VALUES (?, 'qr', 'waba_api_qr_split_fallback_test', ?, ?, 'QR Sender Test', 0, 0, 1, 'connected', ?, 'QR_ONLY')
      `, [qrPhoneNumberId, businessPhone, businessPhone, businessPhone])

      await db.run(`
        INSERT INTO whatsapp_qr_sessions (
          id, phone_number_id, expected_phone, connected_phone, status,
          consent_accepted, consent_text, consent_accepted_at, last_connected_at, updated_at
        ) VALUES (?, ?, ?, ?, 'connected', 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        `qr_${qrPhoneNumberId}`,
        qrPhoneNumberId,
        businessPhone,
        businessPhone,
        QR_CONSENT_TEXT
      ])

      await db.run(`
        INSERT INTO whatsapp_qr_auth_state (phone_number_id, auth_key, value_json, updated_at)
        VALUES (?, 'creds', ?, CURRENT_TIMESTAMP)
      `, [
        qrPhoneNumberId,
        JSON.stringify({
          me: { id: connectedJid },
          registered: true
        })
      ])

      await insertInboundMessageForOpenReplyWindow({
        id,
        contactId,
        phone,
        businessPhone,
        phoneNumberId: apiPhoneNumberId
      })

      setBaileysRuntimeForTest(createFakeBaileysRuntime({ connectedJid, sentMessages }))
      setYCloudFetchForTest(async (url, options = {}) => {
        const parsed = new URL(String(url))
        const path = parsed.pathname.replace(/^\/v2/, '')
        const method = String(options.method || 'GET').toUpperCase()
        if (path === '/whatsapp/messages' && method === 'POST') {
          return ycloudJsonResponse({
            id: ycloudMessageId,
            from: businessPhone,
            to: phone,
            status: 'failed',
            type: 'text',
            text: { body },
            error: {
              code: '131047',
              message: fallbackReason
            },
            createTime: '2024-05-07T08:09:10.000Z'
          })
        }
        return ycloudJsonResponse({ items: [], total: 0 })
      })

      const result = await sendWhatsAppApiTextMessage({
        to: phone,
        from: businessPhone,
        text: body,
        externalId,
        contactId,
        phoneNumberId: apiPhoneNumberId,
        skipQrSendProtection: true
      })

      assert.equal(result.transport, 'qr')
      assert.equal(result.status, 'delivered')
      assert.equal(result.fallback, true)
      assert.equal(sentMessages.length, 1)
      assert.equal(sentMessages[0].payload.text, body)

      const message = await db.get(`
        SELECT transport, routing_reason, status, error_code, error_message, raw_payload_json, message_text
        FROM whatsapp_api_messages
        WHERE ycloud_message_id = ?
      `, [ycloudMessageId])

      assert.equal(message.transport, 'qr')
      assert.equal(message.status, 'delivered')
      assert.equal(message.error_code, null)
      assert.equal(message.error_message, null)
      assert.equal(message.message_text, body)
      assert.equal(message.routing_reason, 'La conversación lleva más de 24 horas sin respuesta del cliente; WhatsApp API solo permite plantillas.')
      const rawPayload = JSON.parse(message.raw_payload_json)
      assert.equal(rawPayload.fallbackFrom, 'api')
      assert.equal(rawPayload.fallbackTransport, 'qr')
      assert.equal(rawPayload.whatsappMessage.transport, 'qr')
    })
  } finally {
    setYCloudFetchForTest(null)
    resetWhatsAppQrServiceForTest()
    for (const phoneNumberId of [apiPhoneNumberId, qrPhoneNumberId]) {
      await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`]).catch(() => undefined)
      await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
      await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
      await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    }
    await cleanup({ contactId, messageId: ycloudMessageId, phone })
  }
})

test('envio API fuera de ventana usa QR cuando la sesion esta reconectando', async () => {
  const id = randomUUID()
  const suffix = Date.now().toString().slice(-7)
  const phone = `+52992${suffix}`
  const businessPhone = `+52655${suffix}`
  const connectedJid = `${normalizeDigits(businessPhone)}@s.whatsapp.net`
  const phoneNumberId = `phone_api_qr_reconnecting_${id}`
  const contactId = `rstk_contact_api_qr_reconnecting_${id}`
  const ycloudMessageId = `ycloud_api_reconnecting_failed_${id}`
  const externalId = `manual_chat_reconnecting_${id}`
  const body = 'Hola, esto debe salir por el QR reconectado'
  const fallbackReason = 'Message failed to send because more than 24 hours have passed since the customer last replied to this number.'
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]
  const sentMessages = []

  await cleanup({ contactId, messageId: ycloudMessageId, phone })
  await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_qr_reconnecting_fallback_secret'))
      await setAppConfig(keys.senderPhone, businessPhone)
      await setAppConfig(keys.phoneNumberId, phoneNumberId)
      await setAppConfig(keys.wabaId, 'waba_api_qr_reconnecting_fallback_test')
      await setAppConfig(keys.provider, 'ycloud')

      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, qr_connected_phone, status
        ) VALUES (?, 'ycloud', 'waba_api_qr_reconnecting_fallback_test', ?, ?, 'API QR Reconnecting Test', 1, 1, 1, 'reconnecting', ?, 'CONNECTED')
      `, [phoneNumberId, businessPhone, businessPhone, businessPhone])

      await db.run(`
        INSERT INTO whatsapp_qr_sessions (
          id, phone_number_id, expected_phone, connected_phone, status,
          consent_accepted, consent_text, consent_accepted_at, last_connected_at, updated_at
        ) VALUES (?, ?, ?, ?, 'reconnecting', 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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

      await insertInboundMessageForOpenReplyWindow({
        id,
        contactId,
        phone,
        businessPhone,
        phoneNumberId
      })

      setBaileysRuntimeForTest(createFakeBaileysRuntime({ connectedJid, sentMessages }))
      setYCloudFetchForTest(async (url, options = {}) => {
        const parsed = new URL(String(url))
        const path = parsed.pathname.replace(/^\/v2/, '')
        const method = String(options.method || 'GET').toUpperCase()
        if (path === '/whatsapp/messages' && method === 'POST') {
          return ycloudJsonResponse({
            id: ycloudMessageId,
            from: businessPhone,
            to: phone,
            status: 'failed',
            type: 'text',
            text: { body },
            error: {
              code: '131047',
              message: fallbackReason
            },
            createTime: '2024-05-07T08:09:10.000Z'
          })
        }
        return ycloudJsonResponse({ items: [], total: 0 })
      })

      const result = await sendWhatsAppApiTextMessage({
        to: phone,
        from: businessPhone,
        text: body,
        externalId,
        contactId,
        phoneNumberId,
        skipQrSendProtection: true
      })

      assert.equal(result.transport, 'qr')
      assert.equal(result.status, 'delivered')
      assert.equal(result.fallback, true)
      assert.equal(sentMessages.length, 1)
      assert.equal(sentMessages[0].payload.text, body)

      const message = await db.get(`
        SELECT transport, routing_reason, status, error_code, error_message, message_text
        FROM whatsapp_api_messages
        WHERE ycloud_message_id = ?
      `, [ycloudMessageId])

      assert.equal(message.transport, 'qr')
      assert.equal(message.status, 'delivered')
      assert.equal(message.error_code, null)
      assert.equal(message.error_message, null)
      assert.equal(message.message_text, body)
      assert.equal(message.routing_reason, 'La conversación lleva más de 24 horas sin respuesta del cliente; WhatsApp API solo permite plantillas.')
    })
  } finally {
    setYCloudFetchForTest(null)
    resetWhatsAppQrServiceForTest()
    await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await cleanup({ contactId, messageId: ycloudMessageId, phone })
  }
})

test('historial smb de YCloud infiere entrantes y salientes por teléfonos conocidos', async () => {
  const id = randomUUID()
  const phone = `+52990${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000000'
  const phoneNumberId = `phone_history_direction_${id}`
  const eventId = `evt_history_direction_${id}`
  const inboundMessageId = `ycloud_history_inbound_${id}`
  const outboundMessageId = `ycloud_history_outbound_${id}`
  const messageAt = '2024-06-07T08:09:10.000Z'

  await cleanup({ phone, eventId })
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)

  try {
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, phone_number, display_phone_number, verified_name, status, created_at, updated_at
      ) VALUES (?, 'ycloud', ?, ?, ?, 'CONNECTED', ?, ?)
    `, [
      phoneNumberId,
      businessPhone,
      businessPhone,
      'Ristak Test',
      messageAt,
      messageAt
    ])

    const payload = {
      id: eventId,
      type: 'whatsapp.smb.history',
      apiVersion: 'v2',
      createTime: messageAt,
      whatsappMessages: [
        {
          id: inboundMessageId,
          from: phone,
          to: businessPhone,
          sendTime: messageAt,
          type: 'text',
          text: { body: 'Hola, soy cliente' },
          customerProfile: { name: 'Cliente Historial' }
        },
        {
          id: outboundMessageId,
          from: businessPhone,
          to: phone,
          sendTime: '2024-06-07T08:10:10.000Z',
          type: 'text',
          text: { body: 'Hola, soy negocio' }
        }
      ]
    }

    await processYCloudWhatsAppWebhook({
      payload,
      rawBody: JSON.stringify(payload),
      signatureHeader: '',
      endpointId: ''
    })

    const rows = await db.all(`
      SELECT ycloud_message_id, direction, contact_id, phone
      FROM whatsapp_api_messages
      WHERE ycloud_message_id IN (?, ?)
      ORDER BY message_timestamp ASC
    `, [inboundMessageId, outboundMessageId])

    assert.equal(rows.length, 2)
    assert.equal(rows[0].ycloud_message_id, inboundMessageId)
    assert.equal(rows[0].direction, 'inbound')
    assert.ok(rows[0].contact_id)
    assert.equal(rows[0].phone, phone)
    assert.equal(rows[1].ycloud_message_id, outboundMessageId)
    assert.equal(rows[1].direction, 'outbound')
    assert.equal(rows[1].contact_id, rows[0].contact_id)
    assert.equal(rows[1].phone, phone)
  } finally {
    await cleanup({ phone, eventId })
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
  }
})

test('historial smb anidado usa metadata y thread para separar hablante e interlocutor', async () => {
  const id = randomUUID()
  const phone = `+52989${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000000'
  const eventId = `evt_history_nested_${id}`
  const outboundMessageId = `ycloud_history_nested_outbound_${id}`
  const inboundMessageId = `ycloud_history_nested_inbound_${id}`
  const messageAt = '2024-06-08T08:09:10.000Z'

  await cleanup({ phone, eventId })

  try {
    const payload = {
      id: eventId,
      type: 'whatsapp.smb.history',
      apiVersion: 'v2',
      createTime: messageAt,
      data: {
        metadata: {
          display_phone_number: businessPhone,
          phone_number_id: '113110828517698'
        },
        history: [
          {
            metadata: {
              phase: 'recent',
              chunk_order: 1,
              progress: 'done'
            },
            threads: [
              {
                id: phone,
                messages: [
                  {
                    id: outboundMessageId,
                    from: businessPhone,
                    timestamp: messageAt,
                    type: 'text',
                    text: { body: 'Hola, soy negocio desde historial' }
                  },
                  {
                    id: inboundMessageId,
                    from: phone,
                    timestamp: '2024-06-08T08:10:10.000Z',
                    type: 'text',
                    text: { body: 'Hola, soy cliente desde historial' }
                  }
                ]
              }
            ]
          }
        ]
      }
    }

    await processYCloudWhatsAppWebhook({
      payload,
      rawBody: JSON.stringify(payload),
      signatureHeader: '',
      endpointId: ''
    })

    const rows = await db.all(`
      SELECT ycloud_message_id, direction, contact_id, phone, from_phone, to_phone, business_phone
      FROM whatsapp_api_messages
      WHERE ycloud_message_id IN (?, ?)
      ORDER BY message_timestamp ASC
    `, [outboundMessageId, inboundMessageId])

    assert.equal(rows.length, 2)
    assert.equal(rows[0].ycloud_message_id, outboundMessageId)
    assert.equal(rows[0].direction, 'outbound')
    assert.equal(rows[0].phone, phone)
    assert.equal(rows[0].from_phone, businessPhone)
    assert.equal(rows[0].to_phone, phone)
    assert.equal(rows[0].business_phone, businessPhone)
    assert.equal(rows[1].ycloud_message_id, inboundMessageId)
    assert.equal(rows[1].direction, 'inbound')
    assert.equal(rows[1].phone, phone)
    assert.equal(rows[1].from_phone, phone)
    assert.equal(rows[1].to_phone, businessPhone)
    assert.equal(rows[1].business_phone, businessPhone)
    assert.equal(rows[1].contact_id, rows[0].contact_id)
  } finally {
    await db.run('DELETE FROM whatsapp_api_attribution WHERE ycloud_message_id IN (?, ?) OR phone = ?', [outboundMessageId, inboundMessageId, phone]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE ycloud_message_id IN (?, ?) OR phone = ?', [outboundMessageId, inboundMessageId, phone]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [phone]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_webhook_events WHERE event_id = ? OR id = ?', [eventId, eventId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE phone = ?', [phone]).catch(() => undefined)
  }
})

test('reparacion retroactiva recalcula mensajes historicos ya guardados con direccion incorrecta', async () => {
  const id = randomUUID()
  const phone = `+52988${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000000'
  const eventId = `evt_history_repair_${id}`
  const outboundMessageId = `ycloud_history_repair_outbound_${id}`
  const inboundMessageId = `ycloud_history_repair_inbound_${id}`
  const messageAt = '2024-06-09T08:09:10.000Z'
  const repairConfigKey = 'whatsapp_api_history_direction_repair_version'
  const payload = {
    id: eventId,
    type: 'whatsapp.smb.history',
    apiVersion: 'v2',
    createTime: messageAt,
    data: {
      metadata: {
        display_phone_number: businessPhone,
        phone_number_id: '113110828517698'
      },
      history: [
        {
          threads: [
            {
              id: phone,
              messages: [
                {
                  id: outboundMessageId,
                  from: businessPhone,
                  timestamp: messageAt,
                  type: 'text',
                  text: { body: 'Mensaje viejo del negocio' }
                },
                {
                  id: inboundMessageId,
                  from: phone,
                  timestamp: '2024-06-09T08:10:10.000Z',
                  type: 'text',
                  text: { body: 'Mensaje viejo del cliente' }
                }
              ]
            }
          ]
        }
      ]
    }
  }

  await cleanup({ phone, eventId })
  await db.run('DELETE FROM app_config WHERE config_key = ?', [repairConfigKey]).catch(() => undefined)

  try {
    await db.run(`
      INSERT INTO whatsapp_api_webhook_events (
        id, event_id, event_type, api_version, signature_valid, processed_status,
        raw_payload_json, ycloud_create_time, created_at, updated_at
      ) VALUES (?, ?, 'whatsapp.smb.history', 'v2', NULL, 'processed', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      eventId,
      eventId,
      JSON.stringify(payload),
      messageAt
    ])

    for (const [messageId, text] of [
      [outboundMessageId, 'Mensaje viejo del negocio'],
      [inboundMessageId, 'Mensaje viejo del cliente']
    ]) {
      await db.run(`
        INSERT INTO whatsapp_api_messages (
          id, provider, origin, ycloud_message_id, phone, from_phone, to_phone,
          business_phone, direction, message_type, message_text, message_timestamp,
          raw_payload_json, created_at, updated_at
        ) VALUES (?, 'ycloud', 'whatsapp.smb.history', ?, ?, ?, NULL, NULL, 'inbound', 'text', ?, ?, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        `wrong_${messageId}`,
        messageId,
        businessPhone,
        businessPhone,
        text,
        messageAt
      ])
    }

    const result = await repairStoredYCloudHistoryMessageDirections({ force: true })
    assert.ok(result.events >= 1)

    const rows = await db.all(`
      SELECT ycloud_message_id, direction, phone, from_phone, to_phone, business_phone
      FROM whatsapp_api_messages
      WHERE ycloud_message_id IN (?, ?)
      ORDER BY message_timestamp ASC
    `, [outboundMessageId, inboundMessageId])

    assert.equal(rows.length, 2)
    assert.equal(rows[0].ycloud_message_id, outboundMessageId)
    assert.equal(rows[0].direction, 'outbound')
    assert.equal(rows[0].phone, phone)
    assert.equal(rows[0].from_phone, businessPhone)
    assert.equal(rows[0].to_phone, phone)
    assert.equal(rows[0].business_phone, businessPhone)
    assert.equal(rows[1].ycloud_message_id, inboundMessageId)
    assert.equal(rows[1].direction, 'inbound')
    assert.equal(rows[1].phone, phone)
    assert.equal(rows[1].from_phone, phone)
    assert.equal(rows[1].to_phone, businessPhone)
    assert.equal(rows[1].business_phone, businessPhone)
  } finally {
    await db.run('DELETE FROM app_config WHERE config_key = ?', [repairConfigKey]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_attribution WHERE ycloud_message_id IN (?, ?) OR phone = ?', [outboundMessageId, inboundMessageId, phone]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE ycloud_message_id IN (?, ?) OR phone = ?', [outboundMessageId, inboundMessageId, phone]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [phone]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_webhook_events WHERE event_id = ? OR id = ?', [eventId, eventId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE phone = ?', [phone]).catch(() => undefined)
  }
})

test('reparacion retroactiva corrige salientes guardados mal usando lista de YCloud', async () => {
  const id = randomUUID()
  const phone = `+52987${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000000'
  const messageId = `ycloud_outbound_list_repair_${id}`
  const messageAt = '2024-06-10T08:09:10.000Z'
  const repairConfigKey = 'whatsapp_api_history_direction_repair_version'
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [
    keys.enabled,
    keys.apiKey,
    keys.senderPhone,
    keys.phoneNumberId,
    keys.wabaId,
    keys.provider,
    repairConfigKey
  ]

  await cleanup({ phone, messageId })

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_repair_secret'))
      await setAppConfig(keys.senderPhone, businessPhone)
      await setAppConfig(keys.phoneNumberId, 'phone_ycloud_repair_test')
      await setAppConfig(keys.wabaId, 'waba_ycloud_repair_test')
      await setAppConfig(keys.provider, 'ycloud')

      await db.run(`
        INSERT INTO whatsapp_api_messages (
          id, provider, origin, ycloud_message_id, phone, from_phone, to_phone,
          business_phone, direction, message_type, message_text, message_timestamp,
          raw_payload_json, created_at, updated_at
        ) VALUES (?, 'ycloud', 'whatsapp.smb.history', ?, ?, ?, NULL, NULL, 'inbound', 'text', ?, ?, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        `wrong_${messageId}`,
        messageId,
        businessPhone,
        businessPhone,
        'Mensaje saliente viejo guardado mal',
        messageAt
      ])

      setYCloudFetchForTest(async (url, options = {}) => {
        const parsed = new URL(String(url))
        const path = parsed.pathname.replace(/^\/v2/, '')
        const method = String(options.method || 'GET').toUpperCase()
        if (path === '/whatsapp/messages' && method === 'GET') {
          return ycloudJsonResponse({
            total: 1,
            items: [
              {
                id: messageId,
                from: businessPhone,
                to: phone,
                wabaId: 'waba_ycloud_repair_test',
                status: 'read',
                type: 'text',
                text: { body: 'Mensaje saliente viejo guardado mal' },
                createTime: messageAt,
                sendTime: messageAt
              }
            ]
          })
        }
        return ycloudJsonResponse({ items: [], total: 0 })
      })

      const result = await repairStoredYCloudHistoryMessageDirections({ force: true })
      assert.equal(result.outboundMessages, 1)

      const row = await db.get(`
        SELECT ycloud_message_id, direction, phone, from_phone, to_phone, business_phone
        FROM whatsapp_api_messages
        WHERE ycloud_message_id = ?
      `, [messageId])

      assert.equal(row.ycloud_message_id, messageId)
      assert.equal(row.direction, 'outbound')
      assert.equal(row.phone, phone)
      assert.equal(row.from_phone, businessPhone)
      assert.equal(row.to_phone, phone)
      assert.equal(row.business_phone, businessPhone)
    })
  } finally {
    setYCloudFetchForTest(null)
    await db.run('DELETE FROM app_config WHERE config_key = ?', [repairConfigKey]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_attribution WHERE ycloud_message_id = ? OR phone = ?', [messageId, phone]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE ycloud_message_id = ? OR phone = ?', [messageId, phone]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [phone]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE phone = ?', [phone]).catch(() => undefined)
  }
})

test('sync historico de YCloud conserva nombre real y source_id de anuncios', async () => {
  const id = randomUUID()
  const phone = `+52995${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000000'
  const contactId = `rstk_contact_test_${id}`
  const messageId = `ycloud_history_ad_${id}`
  const messageAt = '2024-04-11T12:13:14.000Z'

  await cleanup({ contactId, messageId, phone })

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'WhatsApp_API',
      'WhatsApp_API',
      'WhatsApp_API',
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    const result = await syncYCloudMessageRecords([{
      id: messageId,
      wamid: `wamid.${id}`,
      from: phone,
      to: businessPhone,
      sendTime: messageAt,
      type: 'text',
      text: { body: 'Quiero informes de la promo' },
      customerProfile: { name: 'Ana López' },
      referral: {
        source_url: 'https://fb.me/ad-test',
        source_type: 'ad',
        source_id: '238555000333444',
        headline: 'Promo junio',
        body: 'Agenda por WhatsApp',
        ctwa_clid: 'ctwa_history_123'
      }
    }], {
      businessPhoneHints: [businessPhone],
      direction: 'inbound',
      eventType: 'whatsapp.smb.history',
      source: 'ycloud_history_test'
    })

    assert.equal(result.messages, 1)
    assert.equal(result.attributed, 1)

    await repairWhatsAppApiContactIdentityFromMessages({ limit: 100 })

    const contact = await db.get(`
      SELECT full_name, first_name, attribution_ad_id, attribution_ad_name,
             attribution_ctwa_clid, attribution_url, attribution_medium, created_at
      FROM contacts
      WHERE id = ?
    `, [contactId])

    assert.equal(contact.full_name, 'Ana López')
    assert.equal(contact.first_name, 'Ana López')
    assert.equal(contact.attribution_ad_id, '238555000333444')
    assert.equal(contact.attribution_ad_name, 'Promo junio')
    assert.equal(contact.attribution_ctwa_clid, 'ctwa_history_123')
    assert.equal(contact.attribution_url, 'https://fb.me/ad-test')
    assert.equal(contact.attribution_medium, 'ad')
    assert.equal(new Date(contact.created_at).toISOString(), messageAt)

    const message = await db.get(`
      SELECT detected_source_id, detected_ctwa_clid, direction, origin
      FROM whatsapp_api_messages
      WHERE ycloud_message_id = ?
    `, [messageId])

    assert.equal(message.detected_source_id, '238555000333444')
    assert.equal(message.detected_ctwa_clid, 'ctwa_history_123')
    assert.equal(message.direction, 'inbound')
    assert.equal(message.origin, 'ycloud_history_test')
  } finally {
    await cleanup({ contactId, messageId, phone })
  }
})

test('sync de contactos YCloud no convierte el nombre en anuncio y respeta createTime', async () => {
  const id = randomUUID()
  const phone = `+52994${Date.now().toString().slice(-7)}`
  const contactName = 'Mier Drogueria'
  const createTime = '2024-01-02T03:04:05.000Z'
  const lastSeen = '2026-06-16T05:06:07.000Z'

  await cleanup({ phone })

  try {
    await syncYCloudContacts([{
      id: `ycloud_contact_${id}`,
      phoneNumber: phone,
      nickname: contactName,
      sourceId: 'batch_import_123',
      sourceType: 'import',
      createTime,
      lastSeen
    }])

    const contact = await db.get(`
      SELECT id, full_name, first_name, attribution_ad_id, attribution_ad_name, created_at
      FROM contacts
      WHERE phone = ?
    `, [phone])

    assert.equal(contact.full_name, contactName)
    assert.equal(contact.first_name, contactName)
    assert.equal(contact.attribution_ad_id, null)
    assert.equal(contact.attribution_ad_name, null)
    assert.equal(new Date(contact.created_at).toISOString(), createTime)

    const apiContact = await db.get(`
      SELECT profile_name, first_seen_at, last_seen_at
      FROM whatsapp_api_contacts
      WHERE contact_id = ?
    `, [contact.id])

    assert.equal(apiContact.profile_name, contactName)
    assert.equal(new Date(apiContact.first_seen_at).toISOString(), createTime)
    assert.equal(new Date(apiContact.last_seen_at).toISOString(), lastSeen)
  } finally {
    await cleanup({ phone })
  }
})

test('reparacion limpia anuncios falsos que son solo el nombre del contacto', async () => {
  const id = randomUUID()
  const phone = `+52993${Date.now().toString().slice(-7)}`
  const contactId = `rstk_contact_test_${id}`
  const apiContactId = `waapi_profile_test_${id}`

  await cleanup({ contactId, apiContactId, phone })

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source,
        attribution_ad_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'Mier Drogueria',
      'Mier Drogueria',
      'WhatsApp_API',
      'Mier Drogueria',
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_contacts (
        id, contact_id, phone, profile_name, raw_profile_json,
        first_seen_at, last_seen_at, message_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      apiContactId,
      contactId,
      phone,
      'Mier Drogueria',
      JSON.stringify({ nickname: 'Mier Drogueria' }),
      '2024-01-02T03:04:05.000Z',
      '2026-06-16T05:06:07.000Z',
      0,
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    const repaired = await repairWhatsAppApiContactIdentityFromMessages({ limit: 100 })
    assert.ok(repaired.contacts >= 1)

    const contact = await db.get('SELECT attribution_ad_id, attribution_ad_name, created_at FROM contacts WHERE id = ?', [contactId])
    assert.equal(contact.attribution_ad_id, null)
    assert.equal(contact.attribution_ad_name, null)
    assert.equal(new Date(contact.created_at).toISOString(), '2024-01-02T03:04:05.000Z')
  } finally {
    await cleanup({ contactId, apiContactId, phone })
  }
})

test('repara contactos importados de WhatsApp API con nombre y primera fecha del historial', async () => {
  const id = randomUUID()
  const phone = `+52999${Date.now().toString().slice(-7)}`
  const contactId = `rstk_contact_test_${id}`
  const apiContactId = `waapi_profile_test_${id}`
  const messageId = `waapi_msg_test_${id}`
  const realMessageAt = '2024-02-03T04:05:06.000Z'

  await cleanup({ contactId, apiContactId, messageId, phone })

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'Contacto WhatsApp API',
      'Contacto WhatsApp API',
      'WhatsApp_API',
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_contacts (
        id, contact_id, phone, profile_name, raw_profile_json,
        first_seen_at, last_seen_at, message_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      apiContactId,
      contactId,
      phone,
      'Contacto WhatsApp_API',
      JSON.stringify({ nickname: 'Contacto WhatsApp API' }),
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z',
      1,
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, provider, origin, ycloud_message_id, whatsapp_api_contact_id,
        contact_id, phone, from_phone, to_phone, direction, message_type,
        message_text, status, message_timestamp, raw_payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      messageId,
      'ycloud',
      'whatsapp.smb.history',
      'ycloud_history_1',
      apiContactId,
      contactId,
      phone,
      phone,
      '+526561000000',
      'inbound',
      'text',
      'Hola',
      'received',
      realMessageAt,
      JSON.stringify({
        id: 'ycloud_history_1',
        customerProfile: { name: 'Ana López', username: '@ana' },
        from: phone,
        to: '+526561000000',
        sendTime: realMessageAt,
        type: 'text',
        text: { body: 'Hola' }
      }),
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    const repaired = await repairWhatsAppApiContactIdentityFromMessages({ limit: 100 })
    assert.ok(repaired.contacts >= 1)
    assert.ok(repaired.apiContacts >= 1)

    const contact = await db.get('SELECT full_name, first_name, created_at FROM contacts WHERE id = ?', [contactId])
    assert.equal(contact.full_name, 'Ana López')
    assert.equal(contact.first_name, 'Ana López')
    assert.equal(new Date(contact.created_at).toISOString(), realMessageAt)

    const apiContact = await db.get('SELECT profile_name, first_seen_at FROM whatsapp_api_contacts WHERE id = ?', [apiContactId])
    assert.equal(apiContact.profile_name, 'Ana López')
    assert.equal(new Date(apiContact.first_seen_at).toISOString(), realMessageAt)
  } finally {
    await cleanup({ contactId, apiContactId, messageId, phone })
  }
})

test('repara attribution_ad_id cuando YCloud importó un sourceId genérico antes del referral real', async () => {
  const id = randomUUID()
  const phone = `+52998${Date.now().toString().slice(-7)}`
  const contactId = `rstk_contact_test_${id}`
  const apiContactId = `waapi_profile_test_${id}`
  const messageId = `waapi_msg_test_${id}`
  const realMessageAt = '2024-03-04T05:06:07.000Z'

  await cleanup({ contactId, apiContactId, messageId, phone })

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source,
        attribution_ad_id, attribution_ad_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'Contacto WhatsApp API',
      'Contacto WhatsApp API',
      'WhatsApp_API',
      'batch_import_123',
      'batch_import_123',
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_contacts (
        id, contact_id, phone, profile_name, raw_profile_json,
        first_seen_at, last_seen_at, message_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      apiContactId,
      contactId,
      phone,
      'Contacto WhatsApp_API',
      JSON.stringify({ sourceId: 'batch_import_123', sourceType: 'import' }),
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z',
      1,
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, provider, origin, ycloud_message_id, whatsapp_api_contact_id,
        contact_id, phone, from_phone, to_phone, direction, message_type,
        message_text, status, message_timestamp, raw_payload_json, referral_json,
        detected_ctwa_clid, detected_source_id, detected_source_url,
        detected_source_type, detected_headline, detected_body,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      messageId,
      'ycloud',
      'whatsapp.inbound_message.received',
      'ycloud_ad_1',
      apiContactId,
      contactId,
      phone,
      phone,
      '+526561000000',
      'inbound',
      'text',
      'Quiero informes',
      'received',
      realMessageAt,
      JSON.stringify({
        id: 'ycloud_ad_1',
        customerProfile: { name: 'Ana López' },
        from: phone,
        to: '+526561000000',
        sendTime: realMessageAt,
        type: 'text',
        text: { body: 'Quiero informes' },
        referral: {
          source_url: 'https://fb.me/xxx',
          source_type: 'ad',
          source_id: '238555000111222',
          headline: 'Promo junio',
          body: 'Agenda por WhatsApp',
          ctwa_clid: 'ctwa_real_123'
        }
      }),
      JSON.stringify({
        source_url: 'https://fb.me/xxx',
        source_type: 'ad',
        source_id: '238555000111222',
        headline: 'Promo junio',
        body: 'Agenda por WhatsApp',
        ctwa_clid: 'ctwa_real_123'
      }),
      'ctwa_real_123',
      '238555000111222',
      'https://fb.me/xxx',
      'ad',
      'Promo junio',
      'Agenda por WhatsApp',
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    const repaired = await repairWhatsAppApiContactIdentityFromMessages({ limit: 100 })
    assert.ok(repaired.contacts >= 1)

    const contact = await db.get(`
      SELECT attribution_ad_id, attribution_ad_name, attribution_ctwa_clid,
             attribution_url, attribution_medium
      FROM contacts
      WHERE id = ?
    `, [contactId])

    assert.equal(contact.attribution_ad_id, '238555000111222')
    assert.equal(contact.attribution_ad_name, 'Promo junio')
    assert.equal(contact.attribution_ctwa_clid, 'ctwa_real_123')
    assert.equal(contact.attribution_url, 'https://fb.me/xxx')
    assert.equal(contact.attribution_medium, 'ad')
  } finally {
    await cleanup({ contactId, apiContactId, messageId, phone })
  }
})
