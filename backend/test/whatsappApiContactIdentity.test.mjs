import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  db,
  getAppConfig,
  repairWhatsAppApiContactIdentityFromMessages,
  setAppConfig
} from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  extractWhatsAppProfileName,
  normalizeWhatsAppProfileName
} from '../src/utils/whatsappContactProfile.js'
import {
  YCLOUD_HISTORY_BACKFILL_VERSION,
  captureQrChatMessage,
  getWhatsAppApiConfigKeys,
  getWhatsAppApiRequiredWebhookEvents,
  processYCloudWhatsAppWebhook,
  repairWhatsAppProtocolMessageIdentities,
  repairStoredYCloudHistoryMessageDirections,
  runYCloudHistoryBackfillBatch,
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
import {
  resetWhatsAppQrDripRuntimeForTest,
  setWhatsAppQrDripSleepForTest
} from '../src/services/whatsappQrDripService.js'
import { getChatContacts } from '../src/controllers/contactsController.js'

const ONE_PIXEL_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
const VALID_OGG_OPUS_DATA_URL = 'data:audio/ogg;codecs=opus;base64,T2dnUwACAAAAAAAAAAC3bz5UAAAAAF9EXgkBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAALdvPlQBAAAAGaef4gE+T3B1c1RhZ3MNAAAATGF2ZjYyLjEyLjEwMgEAAAAdAAAAZW5jb2Rlcj1MYXZjNjIuMjguMTAyIGxpYm9wdXNPZ2dTAAS4JgAAAAAAALdvPlQCAAAAC0SjeAtFNjQxMjcwMzUqF3iCAbdsfkDmAAAGS7TjumYR3p00RmwBHPB+I1m2zIXrmd7aBIGjduC2A1wWfuKopx7fzlrQS4bGLc+BnYqkIkXcxwldWXijP/esmIUDXCYJlv9nCL7fgGPAvjeM8OkgudL/caOCG6HJnKqN6vBOROgBGTLI+axxcdqjR3iboxJRRQCs0ky14jfRZlm92WkiUNr3DzWw4+Wx98jdsGxYSXK89+hYLRz8wpvjzDHFfgN4m6MSVs4iKkTY4B+i5MZKX7oD0oqS8sDjgb3P1kzpjChOdn4p8hKrIOo5iNWlBQ2HeJujX3Wc/EkNeFc8EJ8EQgTM6vBjyEl0VL8/GXoXtJgxBWlaTy5ZsndLX2+12lIG4vp4m6MXUV8mKyhiES+Om70HKUgcHjLILmQd5M+0sQ+XSDU8UWqsEkjj64ueAeySOq+RhfBzeZureJujX3Wc/EXtr4kI5+fJxq6G+cwFCZR6q7Kutp0WvvmBv231nX0Hb9Se/0S+7VGjeJujElFFANDLwZ1z7toAlP1FFw5GylCcHpCS4YWDdWoTkDdThgxrmgWllJqky5ujivwGeJujElbOIipFGIWoi9E7IdHXTfF6kHlqfNIV5rk86Mc/0dbzcR6fM4Wq/NQLtMYQ/eGxFdZImysfdZz8STOyk08i9Ec9uRIoArhlUWBwvWCPq76xEWvHCYXWbyTIJ0BIBbul8BHm3h2TRdVKljNtaNImd5UVgA=='

async function cleanup({ contactId, apiContactId, messageId, phone, eventId }) {
  await db.run('DELETE FROM chat_inbound_message_claims WHERE channel = ? AND contact_id = ?', ['whatsapp', contactId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_attribution WHERE whatsapp_api_message_id = ? OR contact_id = ? OR phone = ?', [messageId, contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_messages WHERE id = ? OR contact_id = ? OR phone = ?', [messageId, contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_contacts WHERE id = ? OR contact_id = ? OR phone = ?', [apiContactId, contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_webhook_events WHERE event_id = ? OR id = ?', [eventId, eventId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
}

async function cleanupMetaAds(adIds = []) {
  for (const adId of adIds) {
    await db.run('DELETE FROM meta_ads WHERE ad_id = ?', [adId]).catch(() => undefined)
  }
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    }
  }
}

async function readChatContacts(query = {}, user = {}) {
  const res = createMockResponse()
  await getChatContacts({ query, user }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body?.success, true)
  assert.ok(Array.isArray(res.body.data))

  return res.body.data
}

async function insertMetaAdForDate({ adId, date, suffix, name = 'Anuncio WhatsApp' }) {
  await db.run(
    `INSERT INTO meta_ads (
      date, ad_account_id, campaign_id, campaign_name, adset_id, adset_name,
      ad_id, ad_name, spend, clicks, reach
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      date,
      `act_wa_attr_${suffix}`,
      `camp_wa_attr_${suffix}`,
      `Campaña ${name}`,
      `adset_wa_attr_${suffix}`,
      `Conjunto ${name}`,
      adId,
      name,
      10,
      1,
      100
    ]
  )
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
    INSERT INTO contacts (
      id, phone, full_name, first_name, source, created_at, updated_at
    ) VALUES (?, ?, 'Cliente WhatsApp Test', 'Cliente', 'WhatsApp_API', ?, ?)
    ON CONFLICT(id) DO NOTHING
  `, [contactId, phone, messageAt, messageAt])

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

function createFakeBaileysRuntime({ connectedJid, sentMessages = [], ackDelayMs = null, sendDelayMs = 0 } = {}) {
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
          if (sendDelayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, sendDelayMs))
          }
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

test('webhook YCloud ignora mensajes nuevos de un número desconectado de Ristak', async () => {
  const id = randomUUID()
  const phone = `+52996${Date.now().toString().slice(-7)}`
  const businessPhone = `+52654${Date.now().toString().slice(-7)}`
  const phoneNumberId = `ycloud_detached_phone_${id}`
  const messageId = `ycloud_detached_message_${id}`
  const eventId = `ycloud_detached_event_${id}`
  const messageAt = '2024-04-05T06:07:08.000Z'

  await cleanup({ contactId: '', messageId, phone, eventId })
  try {
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, waba_id, phone_number, display_phone_number, verified_name,
        status, api_send_enabled, qr_send_enabled, qr_status
      ) VALUES (?, 'ycloud', 'waba_detached', ?, ?, 'YCloud desconectado', 'CONNECTED', 0, 0, 'disconnected')
    `, [phoneNumberId, businessPhone, businessPhone])

    const payload = {
      id: eventId,
      type: 'whatsapp.inbound_message.received',
      apiVersion: 'v2',
      createTime: messageAt,
      whatsappInboundMessage: {
        id: messageId,
        wamid: `wamid.${id}`,
        wabaId: 'waba_detached',
        from: phone,
        to: businessPhone,
        sendTime: messageAt,
        type: 'text',
        text: { body: 'Este mensaje no debe entrar a Ristak' }
      }
    }

    await processYCloudWhatsAppWebhook({
      payload,
      rawBody: JSON.stringify(payload),
      signatureHeader: '',
      endpointId: ''
    })

    const storedMessage = await db.get('SELECT id FROM whatsapp_api_messages WHERE ycloud_message_id = ?', [messageId])
    const storedContact = await db.get('SELECT id FROM contacts WHERE phone = ?', [phone])
    assert.equal(storedMessage, null)
    assert.equal(storedContact, null)
  } finally {
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await cleanup({ contactId: '', messageId, phone, eventId })
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

test('Coexistence reconcilia el eco YCloud y la captura QR por identidad exacta', async () => {
  const id = randomUUID()
  const suffix = Date.now().toString().slice(-7)
  const phone = `+52991${suffix}`
  const businessPhone = `+52654${suffix}`
  const phoneNumberId = `phone_protocol_echo_${id}`
  const contactId = `rstk_contact_protocol_echo_${id}`
  const providerMessageId = `ycloud_protocol_echo_${id}`
  const eventId = `evt_protocol_echo_${id}`
  const qrMessageKey = '2AB6D0F198A01CB993EA'
  const officialWamid = 'wamid.HBgNNTIxNDQ0MjA3Njc4NhUCABEYFDJBQjZEMEYxOThBMDFDQjk5M0VBAA=='
  const body = 'Mensaje escrito desde WhatsApp Business'
  const messageAt = '2024-05-07T08:09:10.000Z'
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]

  await cleanup({ contactId, phone, eventId })
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_protocol_echo_secret'))
      await setAppConfig(keys.senderPhone, businessPhone)
      await setAppConfig(keys.phoneNumberId, phoneNumberId)
      await setAppConfig(keys.wabaId, 'waba_protocol_echo_test')
      await setAppConfig(keys.provider, 'ycloud')

      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, qr_connected_phone, status
        ) VALUES (?, 'ycloud', 'waba_protocol_echo_test', ?, ?, 'Protocol Echo Test', 1, 1, 1, 'connected', ?, 'CONNECTED')
      `, [phoneNumberId, businessPhone, businessPhone])

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

      const qrResult = await captureQrChatMessage({
        phoneNumberId,
        businessPhone,
        direction: 'outbound',
        wamid: qrMessageKey,
        messageType: 'text',
        text: body,
        contactPhone: phone,
        timestamp: messageAt
      })

      const payload = {
        id: eventId,
        type: 'whatsapp.smb.message.echoes',
        apiVersion: 'v2',
        createTime: messageAt,
        whatsappMessage: {
          id: providerMessageId,
          wamid: officialWamid,
          from: businessPhone,
          to: phone,
          wabaId: 'waba_protocol_echo_test',
          status: 'sent',
          type: 'text',
          text: { body },
          createTime: messageAt,
          sendTime: messageAt
        }
      }
      await processYCloudWhatsAppWebhook({
        payload,
        rawBody: JSON.stringify(payload),
        signatureHeader: '',
        endpointId: ''
      })

      const rows = await db.all(`
        SELECT id, provider_message_id, ycloud_message_id, wamid,
               protocol_message_key_id, transport, source_adapter, message_text
        FROM whatsapp_api_messages
        WHERE contact_id = ? AND message_text = ?
      `, [contactId, body])

      assert.equal(rows.length, 1)
      assert.equal(rows[0].id, qrResult.messageId)
      assert.equal(rows[0].provider_message_id, providerMessageId)
      assert.equal(rows[0].ycloud_message_id, providerMessageId)
      assert.equal(rows[0].wamid, officialWamid)
      assert.equal(rows[0].protocol_message_key_id, qrMessageKey)
      assert.equal(rows[0].transport, 'qr')
      assert.equal(rows[0].source_adapter, 'baileys')
    })
  } finally {
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await cleanup({ contactId, phone, eventId })
  }
})

test('el mantenimiento historico fusiona los pares QR y SMB exactos ya guardados', async () => {
  const id = randomUUID()
  const phone = `+52985${Date.now().toString().slice(-7)}`
  const businessPhone = '+526541234567'
  const contactId = `rstk_contact_protocol_history_${id}`
  const qrRowId = `qr_protocol_history_${id}`
  const apiRowId = `api_protocol_history_${id}`
  const qrMessageKey = '2A107A68B47DA3E71797'
  const officialWamid = 'wamid.HBgNNTIxNDQ0MjA3Njc4NhUCABEYFDJBMTA3QTY4QjQ3REEzRTcxNzk3AA=='
  const body = `Historial exacto ${id}`

  await cleanup({ contactId, phone })
  try {
    await db.run(`
      INSERT INTO contacts (id, phone, full_name, first_name, source, created_at, updated_at)
      VALUES (?, ?, 'Cliente histórico', 'Cliente', 'WhatsApp_API', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [contactId, phone])
    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, provider, source_adapter, origin, provider_message_id, wamid,
        contact_id, phone, from_phone, to_phone, business_phone, transport,
        direction, message_type, message_text, status, message_timestamp
      ) VALUES (?, 'ycloud', 'baileys', 'whatsapp.qr.message.synced', ?, ?,
        ?, ?, ?, ?, ?, 'qr', 'outbound', 'text', ?, 'sent', CURRENT_TIMESTAMP)
    `, [qrRowId, qrMessageKey, qrMessageKey, contactId, phone, businessPhone, phone, businessPhone, body])
    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, provider, source_adapter, origin, provider_message_id, ycloud_message_id,
        wamid, contact_id, phone, from_phone, to_phone, business_phone, transport,
        direction, message_type, message_text, status, message_timestamp
      ) VALUES (?, 'ycloud', 'ycloud', 'whatsapp.smb.message.echoes', ?, ?, ?,
        ?, ?, ?, ?, ?, 'api', 'outbound', 'text', ?, 'sent', CURRENT_TIMESTAMP)
    `, [apiRowId, apiRowId, apiRowId, officialWamid, contactId, phone, businessPhone, phone, businessPhone, body])

    const repair = await repairWhatsAppProtocolMessageIdentities({ force: true })
    assert.ok(repair.backfilled >= 2)
    assert.ok(repair.merged >= 1)

    const rows = await db.all(`
      SELECT id, ycloud_message_id, wamid, protocol_message_key_id, transport, source_adapter
      FROM whatsapp_api_messages
      WHERE contact_id = ? AND message_text = ?
    `, [contactId, body])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, qrRowId)
    assert.equal(rows[0].ycloud_message_id, apiRowId)
    assert.equal(rows[0].wamid, officialWamid)
    assert.equal(rows[0].protocol_message_key_id, qrMessageKey)
    assert.equal(rows[0].transport, 'qr')
    assert.equal(rows[0].source_adapter, 'baileys')
  } finally {
    await cleanup({ contactId, phone })
  }
})

test('eco QR saliente escrito en el teléfono se captura aunque la API oficial esté operativa', async () => {
  // Baileys debe capturarlo de inmediato aunque después llegue un eco SMB del
  // proveedor. El skip 'official_api_active' sólo aplica al inbound; el
  // outbound se reconcilia después por identidad exacta de protocolo.
  const id = randomUUID()
  const suffix = Date.now().toString().slice(-7)
  const phone = `+52993${suffix}`
  const businessPhone = `+52655${suffix}`
  const phoneNumberId = `phone_qr_outbound_echo_${id}`
  const contactId = `rstk_contact_qr_outbound_echo_${id}`
  const outboundWamid = `qr_outbound_echo_${id}`
  const inboundWamid = `qr_inbound_echo_${id}`
  const historicalInboundWamid = `qr_inbound_history_${id}`
  const outboundBody = `Respuesta escrita en el teléfono ${id}`
  const inboundBody = `Mensaje entrante del cliente ${id}`
  const messageAt = '2024-06-01T10:20:30.000Z'
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]

  await cleanup({ contactId, messageId: outboundWamid, phone })
  await db.run('DELETE FROM whatsapp_api_messages WHERE wamid IN (?, ?, ?)', [outboundWamid, inboundWamid, historicalInboundWamid]).catch(() => undefined)
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
      `, [phoneNumberId, businessPhone, businessPhone])

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

      // Un bloque histórico QR sí se conserva: puede contener pasado anterior a
      // la conexión API y el dedupe evita repetir lo que el webhook ya guardó.
      const historicalInboundResult = await captureQrChatMessage({
        phoneNumberId,
        businessPhone,
        direction: 'inbound',
        wamid: historicalInboundWamid,
        messageType: 'text',
        text: 'Mensaje histórico anterior a la API',
        contactPhone: phone,
        timestamp: messageAt,
        historyImport: true
      })

      assert.equal(historicalInboundResult.skipped, false)
      const historicalInboundRow = await db.get(
        'SELECT transport, direction FROM whatsapp_api_messages WHERE wamid = ?',
        [historicalInboundWamid]
      )
      assert.equal(historicalInboundRow.transport, 'qr')
      assert.equal(historicalInboundRow.direction, 'inbound')
    })
  } finally {
    await db.run('DELETE FROM whatsapp_api_messages WHERE wamid IN (?, ?, ?)', [outboundWamid, inboundWamid, historicalInboundWamid]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await cleanup({ contactId, messageId: outboundWamid, phone })
  }
})

test('eco QR saliente de WhatsApp normal conserva phoneNumberId para la bandeja movil filtrada', async () => {
  const id = randomUUID()
  const suffix = Date.now().toString().slice(-7)
  const phone = `+52994${suffix}`
  const businessPhone = `+52656${suffix}`
  const phoneNumberId = `phone_qr_connected_only_${id}`
  const contactId = `rstk_contact_qr_connected_only_${id}`
  const outboundWamid = `qr_connected_only_${id}`
  const outboundBody = `Respuesta normal desde WhatsApp ${id}`
  const messageAt = '2026-07-08T15:20:00.000Z'

  await cleanup({ contactId, messageId: outboundWamid, phone })
  await db.run('DELETE FROM whatsapp_api_messages WHERE wamid = ?', [outboundWamid]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)

  try {
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, phone_number, display_phone_number, verified_name,
        is_default_sender, api_send_enabled, qr_send_enabled, qr_status,
        qr_connected_phone, status, updated_at
      ) VALUES (?, 'qr', NULL, NULL, 'QR WhatsApp Normal', 1, 0, 1, 'connected', ?, 'QR_ONLY', ?)
    `, [phoneNumberId, businessPhone, messageAt])

    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, created_at, updated_at
      ) VALUES (?, ?, 'Cliente WhatsApp Normal', 'Cliente', 'WhatsApp_QR', ?, ?)
    `, [contactId, phone, messageAt, messageAt])

    const result = await captureQrChatMessage({
      phoneNumberId,
      businessPhone,
      direction: 'outbound',
      wamid: outboundWamid,
      messageType: 'text',
      text: outboundBody,
      contactPhone: phone,
      timestamp: messageAt
    })

    assert.equal(result.skipped, false)
    assert.equal(result.businessPhoneNumberId, phoneNumberId)

    const row = await db.get(`
      SELECT contact_id, direction, transport, business_phone, business_phone_number_id, message_text
      FROM whatsapp_api_messages
      WHERE wamid = ?
    `, [outboundWamid])

    assert.ok(row)
    assert.equal(row.contact_id, contactId)
    assert.equal(row.direction, 'outbound')
    assert.equal(row.transport, 'qr')
    assert.equal(normalizeDigits(row.business_phone), normalizeDigits(businessPhone))
    assert.equal(row.business_phone_number_id, phoneNumberId)
    assert.equal(row.message_text, outboundBody)

    const chats = await readChatContacts({
      businessPhoneNumberId: phoneNumberId,
      businessPhone,
      limit: '100'
    })
    const chat = chats.find(item => item.id === contactId)

    assert.ok(chat)
    assert.equal(chat.lastMessageText, outboundBody)
    assert.equal(chat.lastMessageDirection, 'outbound')
    assert.equal(chat.lastBusinessPhoneNumberId, phoneNumberId)
  } finally {
    await db.run('DELETE FROM whatsapp_api_messages WHERE wamid = ?', [outboundWamid]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await cleanup({ contactId, messageId: outboundWamid, phone })
  }
})

test('dos fotos sin identidad de protocolo compartida permanecen como mensajes distintos', async () => {
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

      assert.equal(result.skipped, false)
      assert.notEqual(result.messageId, apiMessageId)

      const duplicate = await db.get('SELECT id FROM whatsapp_api_messages WHERE wamid = ?', [qrEchoWamid])
      assert.ok(duplicate)

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

test('dos envios de la misma foto no se fusionan por contenido ni cercania temporal', async () => {
  const id = randomUUID()
  const suffix = Date.now().toString().slice(-7)
  const phone = `+52656${suffix}`
  const businessPhone = `+52655${suffix}`
  const phoneNumberId = `phone_qr_photo_sha_${id}`
  const contactId = `rstk_contact_qr_photo_sha_${id}`
  const originalMessageId = `qr_photo_original_${id}`
  const originalWamid = `3EB0_${id}`
  const echoWamid = `2A09_${id}`
  const fileSha256 = `same-photo-sha-${id}`
  const messageAt = '2026-07-10T23:37:40.000Z'

  await cleanup({ contactId, messageId: originalMessageId, phone })
  await db.run('DELETE FROM whatsapp_api_messages WHERE wamid IN (?, ?)', [originalWamid, echoWamid]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)

  try {
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, phone_number, display_phone_number, verified_name,
        is_default_sender, api_send_enabled, qr_send_enabled, qr_status,
        qr_connected_phone, status, updated_at
      ) VALUES (?, 'qr', NULL, NULL, 'QR Foto SHA', 1, 0, 1, 'connected', ?, 'QR_ONLY', ?)
    `, [phoneNumberId, businessPhone, messageAt])

    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, created_at, updated_at
      ) VALUES (?, ?, 'Cliente Foto SHA', 'Cliente', 'WhatsApp_QR', ?, ?)
    `, [contactId, phone, messageAt, messageAt])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, provider, ycloud_message_id, wamid, contact_id, phone, from_phone, to_phone,
        business_phone, business_phone_number_id, transport, direction, message_type,
        message_text, media_url, media_mime_type, media_filename, status,
        raw_payload_json, message_timestamp, created_at, updated_at
      ) VALUES (?, 'ycloud', ?, ?, ?, ?, ?, ?, ?, ?, 'qr', 'outbound', 'image',
        NULL, 'https://cdn.example.com/original-photo.jpg', 'image/jpeg', 'whatsapp-image.jpg', 'sent',
        ?, ?, ?, ?)
    `, [
      originalMessageId,
      originalWamid,
      originalWamid,
      contactId,
      phone,
      businessPhone,
      phone,
      businessPhone,
      phoneNumberId,
      JSON.stringify({
        raw: JSON.stringify({
          response: { message: { imageMessage: { fileSha256 } } }
        })
      }),
      messageAt,
      messageAt,
      messageAt
    ])

    const result = await captureQrChatMessage({
      phoneNumberId,
      businessPhone,
      direction: 'outbound',
      wamid: echoWamid,
      messageType: 'image',
      text: '',
      contactPhone: `+521${phone.replace(/^\+52/, '')}`,
      timestamp: '2026-07-10T23:38:06.000Z',
      raw: {
        key: { id: echoWamid, fromMe: true },
        message: { imageMessage: { fileSha256 } }
      }
    })

    assert.equal(result.skipped, false)
    assert.notEqual(result.messageId, originalMessageId)

    const rows = await db.all(`
      SELECT id, wamid, media_url
      FROM whatsapp_api_messages
      WHERE contact_id = ? AND direction = 'outbound' AND message_type = 'image'
    `, [contactId])
    assert.equal(rows.length, 2)
    assert.ok(rows.some(row => row.wamid === originalWamid && row.media_url === 'https://cdn.example.com/original-photo.jpg'))
    assert.ok(rows.some(row => row.wamid === echoWamid))
  } finally {
    await db.run('DELETE FROM whatsapp_api_messages WHERE wamid IN (?, ?)', [originalWamid, echoWamid]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await cleanup({ contactId, messageId: originalMessageId, phone })
  }
})

test('si API y QR viven en filas hermanas, una solicitud QR usa primero la API oficial', async () => {
  const id = randomUUID()
  const suffix = Date.now().toString().slice(-7)
  const phone = `+52987${suffix}`
  const businessPhone = `+52657${suffix}`
  const phoneNumberId = `phone_api_priority_${id}`
  const qrPhoneNumberId = `phone_qr_backup_priority_${id}`
  const contactId = `rstk_contact_api_priority_${id}`
  const body = 'Este mensaje debe salir una sola vez por API'
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]
  let apiPostCalls = 0

  await cleanup({ contactId, phone })
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [qrPhoneNumberId]).catch(() => undefined)

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_api_priority_secret'))
      await setAppConfig(keys.senderPhone, businessPhone)
      await setAppConfig(keys.phoneNumberId, phoneNumberId)
      await setAppConfig(keys.wabaId, 'waba_api_priority_test')
      await setAppConfig(keys.provider, 'ycloud')

      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, qr_connected_phone, status
        ) VALUES (?, 'ycloud', 'waba_api_priority_test', ?, ?, 'API Priority Test', 1, 1, 0, 'disconnected', NULL, 'CONNECTED')
      `, [phoneNumberId, businessPhone, businessPhone])
      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, qr_connected_phone, status
        ) VALUES (?, 'qr', ?, ?, 'QR Backup Priority Test', 0, 0, 1, 'connected', ?, 'QR_ONLY')
      `, [qrPhoneNumberId, businessPhone, businessPhone, businessPhone])
      await insertInboundMessageForOpenReplyWindow({ id, contactId, phone, businessPhone, phoneNumberId })

      setYCloudFetchForTest(async (url, options = {}) => {
        const parsed = new URL(String(url))
        if (parsed.pathname.endsWith('/whatsapp/messages') && String(options.method || '').toUpperCase() === 'POST') {
          apiPostCalls += 1
          return ycloudJsonResponse({
            id: `ycloud_api_priority_${id}`,
            from: businessPhone,
            to: phone,
            status: 'sent',
            type: 'text',
            text: { body },
            createTime: new Date().toISOString()
          })
        }
        return ycloudJsonResponse({ items: [], total: 0 })
      })

      const result = await sendWhatsAppApiTextMessage({
        to: phone,
        from: businessPhone,
        text: body,
        transport: 'qr',
        contactId,
        phoneNumberId: qrPhoneNumberId
      })

      assert.equal(apiPostCalls, 1)
      assert.equal(result.id, `ycloud_api_priority_${id}`)
      const saved = await db.get(`
        SELECT transport, message_text
        FROM whatsapp_api_messages
        WHERE ycloud_message_id = ?
      `, [`ycloud_api_priority_${id}`])
      assert.equal(saved.transport, 'api')
      assert.equal(saved.message_text, body)
    })
  } finally {
    setYCloudFetchForTest(null)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [qrPhoneNumberId]).catch(() => undefined)
    await cleanup({ contactId, phone })
  }
})

test('un timeout o 5xx ambiguo de API nunca dispara tambien el respaldo QR', async () => {
  const id = randomUUID()
  const suffix = Date.now().toString().slice(-7)
  const phone = `+52986${suffix}`
  const businessPhone = `+52658${suffix}`
  const phoneNumberId = `phone_ambiguous_failure_${id}`
  const contactId = `rstk_contact_ambiguous_failure_${id}`
  const body = 'No se debe duplicar por un error ambiguo'
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]

  await cleanup({ contactId, phone })
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_ambiguous_failure_secret'))
      await setAppConfig(keys.senderPhone, businessPhone)
      await setAppConfig(keys.phoneNumberId, phoneNumberId)
      await setAppConfig(keys.wabaId, 'waba_ambiguous_failure_test')
      await setAppConfig(keys.provider, 'ycloud')

      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, qr_connected_phone, status
        ) VALUES (?, 'ycloud', 'waba_ambiguous_failure_test', ?, ?, 'Ambiguous Failure Test', 1, 1, 1, 'connected', ?, 'CONNECTED')
      `, [phoneNumberId, businessPhone, businessPhone, businessPhone])
      await insertInboundMessageForOpenReplyWindow({ id, contactId, phone, businessPhone, phoneNumberId })

      setYCloudFetchForTest(async (url, options = {}) => {
        const parsed = new URL(String(url))
        if (parsed.pathname.endsWith('/whatsapp/messages') && String(options.method || '').toUpperCase() === 'POST') {
          return ycloudJsonResponse(
            { message: 'Temporary upstream failure after accepting the request' },
            { status: 500, statusText: 'Internal Server Error' }
          )
        }
        return ycloudJsonResponse({ items: [], total: 0 })
      })

      await assert.rejects(
        sendWhatsAppApiTextMessage({
          to: phone,
          from: businessPhone,
          text: body,
          transport: 'api',
          contactId,
          phoneNumberId,
          allowQrFallback: true
        }),
        /Temporary upstream failure|500|Internal Server Error/i
      )

      const qrRows = await db.all(`
        SELECT id
        FROM whatsapp_api_messages
        WHERE contact_id = ? AND transport = 'qr' AND message_text = ?
      `, [contactId, body])
      assert.equal(qrRows.length, 0)
    })
  } finally {
    setYCloudFetchForTest(null)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await cleanup({ contactId, phone })
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
      assert.equal(result.status, 'sent')
      assert.equal(result.fallback, true)
      assert.equal(result.fallbackFrom, 'api')
      assert.equal(result.routingReason, 'La conversación lleva más de 24 horas sin respuesta del cliente; WhatsApp API solo permite plantillas.')
      assert.equal(sentMessages.length, 1)
      assert.equal(sentMessages[0].payload.text, body)

      // El request ya respondio `sent`; el ACK asincrono debe reconciliar la
      // fila poco despues aunque haya llegado antes de terminar el INSERT.
      await new Promise(resolve => setTimeout(resolve, 150))

      const message = await db.get(`
        SELECT transport, source_adapter, routing_reason, status, error_code, error_message, raw_payload_json, message_text
        FROM whatsapp_api_messages
        WHERE ycloud_message_id = ?
      `, [ycloudMessageId])

      assert.equal(message.transport, 'qr')
      assert.equal(message.source_adapter, 'baileys')
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

test('webhook 131053 rescata una nota de voz por QR una sola vez', async () => {
  const id = randomUUID()
  const phone = `+52991${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000008'
  const connectedJid = `${normalizeDigits(businessPhone)}@s.whatsapp.net`
  const phoneNumberId = `phone_audio_131053_${id}`
  const contactId = `rstk_contact_audio_131053_${id}`
  const messageId = `waapi_audio_131053_${id}`
  const ycloudMessageId = `ycloud_audio_131053_${id}`
  const regularMessageId = `waapi_regular_audio_131053_${id}`
  const regularYCloudMessageId = `ycloud_regular_audio_131053_${id}`
  const raceYCloudMessageId = `ycloud_audio_race_131053_${id}`
  const sentMessages = []
  const errorMessage = 'Audio file uploaded with mimetype as audio/ogg; codecs=opus, however on processing it is of type application/octet-stream.'

  await cleanup({ contactId, messageId, phone })
  await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)

  try {
    await db.run(`
      INSERT INTO contacts (id, phone, full_name, first_name, source, created_at, updated_at)
      VALUES (?, ?, 'Cliente Audio', 'Cliente', 'WhatsApp_API', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [contactId, phone])

    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, waba_id, phone_number, display_phone_number, verified_name,
        is_default_sender, api_send_enabled, qr_send_enabled, qr_status, qr_connected_phone, status
      ) VALUES (?, 'ycloud', 'waba_audio_131053', ?, ?, 'Audio Fallback Test', 1, 1, 1, 'connected', ?, 'CONNECTED')
    `, [phoneNumberId, businessPhone, businessPhone, businessPhone])

    await db.run(`
      INSERT INTO whatsapp_qr_sessions (
        id, phone_number_id, expected_phone, connected_phone, status,
        consent_accepted, consent_text, consent_accepted_at, last_connected_at, updated_at
      ) VALUES (?, ?, ?, ?, 'connected', 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [`qr_${phoneNumberId}`, phoneNumberId, businessPhone, businessPhone, QR_CONSENT_TEXT])

    await db.run(`
      INSERT INTO whatsapp_qr_auth_state (phone_number_id, auth_key, value_json, updated_at)
      VALUES (?, 'creds', ?, CURRENT_TIMESTAMP)
    `, [phoneNumberId, JSON.stringify({ me: { id: connectedJid }, registered: true })])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, provider, ycloud_message_id, contact_id, phone, from_phone, to_phone,
        business_phone, business_phone_number_id, transport, direction, message_type,
        media_mime_type, media_duration_ms, status, message_timestamp, raw_payload_json,
        created_at, updated_at
      ) VALUES (?, 'ycloud', ?, ?, ?, ?, ?, ?, ?, 'api', 'outbound', 'audio',
        'audio/ogg; codecs=opus', 200, 'sent', CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      messageId,
      ycloudMessageId,
      contactId,
      phone,
      businessPhone,
      phone,
      businessPhone,
      phoneNumberId,
      JSON.stringify({
        id: ycloudMessageId,
        from: businessPhone,
        to: phone,
        type: 'audio',
        status: 'sent',
        audio: {
          deliveryUrl: VALID_OGG_OPUS_DATA_URL,
          voice: true,
          asyncQrFallbackAllowed: true,
          durationMs: 200
        }
      })
    ])

    setBaileysRuntimeForTest(createFakeBaileysRuntime({
      connectedJid,
      sentMessages,
      ackDelayMs: 0,
      sendDelayMs: 75
    }))
    setWhatsAppQrDripSleepForTest(async () => {})

    const processFailure = async (eventId, providerMessageId = ycloudMessageId, voice = true) => {
      const payload = {
        id: eventId,
        type: 'whatsapp.message.updated',
        apiVersion: 'v2',
        createTime: new Date().toISOString(),
        whatsappMessage: {
          id: providerMessageId,
          wamid: `wamid.${providerMessageId}`,
          status: 'failed',
          from: businessPhone,
          to: phone,
          wabaId: 'waba_audio_131053',
          type: 'audio',
          audio: { id: `media_${providerMessageId}`, voice },
          errorCode: '131053',
          errorMessage,
          createTime: new Date().toISOString()
        }
      }
      await processYCloudWhatsAppWebhook({
        payload,
        rawBody: JSON.stringify(payload),
        signatureHeader: '',
        endpointId: ''
      })
    }

    await Promise.all([
      processFailure(`evt_audio_131053_a_${id}`),
      processFailure(`evt_audio_131053_parallel_${id}`)
    ])
    await new Promise(resolve => setTimeout(resolve, 100))

    assert.equal(sentMessages.length, 1)
    assert.equal(sentMessages[0].payload.ptt, true)
    assert.equal(sentMessages[0].payload.mimetype, 'audio/ogg; codecs=opus')
    assert.ok(Buffer.isBuffer(sentMessages[0].payload.audio))
    assert.equal(sentMessages[0].payload.audio.subarray(0, 4).toString('latin1'), 'OggS')

    const row = await db.get(`
      SELECT transport, routing_reason, status, error_code, error_message, raw_payload_json
      FROM whatsapp_api_messages
      WHERE id = ?
    `, [messageId])
    assert.equal(row.transport, 'qr')
    assert.ok(['sent', 'delivered'].includes(row.status))
    assert.equal(row.error_code, null)
    assert.equal(row.error_message, null)
    assert.match(row.routing_reason, /no pudo procesar la nota de voz/i)
    const raw = JSON.parse(row.raw_payload_json)
    assert.equal(raw.fallbackFrom, 'api')
    assert.equal(raw.fallbackTransport, 'qr')

    await processFailure(`evt_audio_131053_b_${id}`)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(sentMessages.length, 1)

    const regularAudioDataUrl = `data:audio/mpeg;base64,${Buffer.from('ID3-audio-normal-fallback').toString('base64')}`
    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, provider, ycloud_message_id, contact_id, phone, from_phone, to_phone,
        business_phone, business_phone_number_id, transport, direction, message_type,
        media_mime_type, media_duration_ms, status, message_timestamp, raw_payload_json,
        created_at, updated_at
      ) VALUES (?, 'ycloud', ?, ?, ?, ?, ?, ?, ?, 'api', 'outbound', 'audio',
        'audio/mpeg', 300, 'sent', CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      regularMessageId,
      regularYCloudMessageId,
      contactId,
      phone,
      businessPhone,
      phone,
      businessPhone,
      phoneNumberId,
      JSON.stringify({
        id: regularYCloudMessageId,
        from: businessPhone,
        to: phone,
        type: 'audio',
        status: 'sent',
        audio: {
          deliveryUrl: regularAudioDataUrl,
          voice: false,
          asyncQrFallbackAllowed: true,
          durationMs: 300
        }
      })
    ])

    await processFailure(`evt_regular_audio_131053_${id}`, regularYCloudMessageId, false)
    await new Promise(resolve => setTimeout(resolve, 100))

    assert.equal(sentMessages.length, 2)
    assert.equal(sentMessages[1].payload.ptt, false)
    assert.equal(sentMessages[1].payload.mimetype, 'audio/mpeg')
    assert.deepEqual(sentMessages[1].payload.audio, Buffer.from('ID3-audio-normal-fallback'))

    const regularRow = await db.get(`
      SELECT transport, routing_reason, status, error_code, error_message
      FROM whatsapp_api_messages
      WHERE id = ?
    `, [regularMessageId])
    assert.equal(regularRow.transport, 'qr')
    assert.ok(['sent', 'delivered'].includes(regularRow.status))
    assert.equal(regularRow.error_code, null)
    assert.equal(regularRow.error_message, null)
    assert.match(regularRow.routing_reason, /no pudo procesar el audio/i)

    // Carrera real: el webhook 131053 puede llegar antes de que la respuesta
    // del POST se persista con asyncQrFallbackAllowed. El segundo upsert debe
    // detectar el fallo previo y mandar QR sin necesitar otro webhook.
    await processFailure(`evt_audio_race_failed_${id}`, raceYCloudMessageId, true)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(sentMessages.length, 2)

    const acceptedPayload = {
      id: `evt_audio_race_accepted_${id}`,
      type: 'whatsapp.message.updated',
      apiVersion: 'v2',
      createTime: new Date().toISOString(),
      whatsappMessage: {
        id: raceYCloudMessageId,
        wamid: `wamid.${raceYCloudMessageId}`,
        status: 'sent',
        from: businessPhone,
        to: phone,
        wabaId: 'waba_audio_131053',
        type: 'audio',
        audio: {
          deliveryUrl: VALID_OGG_OPUS_DATA_URL,
          voice: true,
          asyncQrFallbackAllowed: true,
          durationMs: 200
        },
        createTime: new Date().toISOString()
      }
    }
    await processYCloudWhatsAppWebhook({
      payload: acceptedPayload,
      rawBody: JSON.stringify(acceptedPayload),
      signatureHeader: '',
      endpointId: ''
    })
    await new Promise(resolve => setTimeout(resolve, 100))

    assert.equal(sentMessages.length, 3)
    assert.equal(sentMessages[2].payload.ptt, true)
    const raceRow = await db.get(`
      SELECT transport, status, error_code, error_message, routing_reason
      FROM whatsapp_api_messages
      WHERE ycloud_message_id = ?
    `, [raceYCloudMessageId])
    assert.equal(raceRow.transport, 'qr')
    assert.ok(['sent', 'delivered'].includes(raceRow.status))
    assert.equal(raceRow.error_code, null)
    assert.equal(raceRow.error_message, null)
    assert.match(raceRow.routing_reason, /no pudo procesar la nota de voz/i)
  } finally {
    resetWhatsAppQrServiceForTest()
    resetWhatsAppQrDripRuntimeForTest()
    await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE id = ? OR ycloud_message_id = ?', [regularMessageId, regularYCloudMessageId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE ycloud_message_id = ?', [raceYCloudMessageId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_webhook_events WHERE event_id LIKE ? OR id LIKE ?', [`%${id}%`, `%${id}%`]).catch(() => undefined)
    await cleanup({ contactId, messageId, phone })
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
      SELECT provider, source_adapter, provider_message_id, ycloud_message_id,
             direction, contact_id, phone
      FROM whatsapp_api_messages
      WHERE ycloud_message_id IN (?, ?)
      ORDER BY message_timestamp ASC
    `, [inboundMessageId, outboundMessageId])

    assert.equal(rows.length, 2)
    assert.equal(rows[0].ycloud_message_id, inboundMessageId)
    assert.equal(rows[0].provider, 'ycloud')
    assert.equal(rows[0].source_adapter, 'ycloud')
    assert.equal(rows[0].provider_message_id, inboundMessageId)
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

test('ecos de WhatsApp Business App se guardan como mensajes salientes', async () => {
  const id = randomUUID()
  const phone = `+52988${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000000'
  const eventId = `evt_smb_echo_${id}`
  const messageId = `ycloud_smb_echo_${id}`
  const messageAt = '2024-06-09T08:09:10.000Z'
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.senderPhone, keys.provider, keys.webhookSecret]

  await cleanup({ phone, eventId, messageId })

  try {
    await snapshotAppConfig(configKeys, async () => {
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.senderPhone, businessPhone)
      await setAppConfig(keys.provider, 'ycloud')

      const payload = {
        id: eventId,
        type: 'whatsapp.smb.message.echoes',
        apiVersion: 'v2',
        createTime: messageAt,
        whatsappMessage: {
          id: messageId,
          from: businessPhone,
          to: phone,
          wabaId: 'waba_smb_echo_test',
          status: 'sent',
          type: 'text',
          text: { body: 'Mensaje escrito desde la app oficial' },
          createTime: messageAt,
          sendTime: messageAt
        }
      }

      await processYCloudWhatsAppWebhook({
        payload,
        rawBody: JSON.stringify(payload),
        signatureHeader: '',
        endpointId: ''
      })

      const message = await db.get(`
        SELECT direction, phone, from_phone, to_phone, message_text
        FROM whatsapp_api_messages
        WHERE ycloud_message_id = ?
      `, [messageId])

      assert.deepEqual(message, {
        direction: 'outbound',
        phone,
        from_phone: businessPhone,
        to_phone: phone,
        message_text: 'Mensaje escrito desde la app oficial'
      })
    })
  } finally {
    await cleanup({ phone, eventId, messageId })
  }
})

test('YCloud suscribe los ecos de WhatsApp Business App con el evento oficial', () => {
  const events = getWhatsAppApiRequiredWebhookEvents()

  assert.ok(events.includes('whatsapp.smb.message.echoes'))
  assert.ok(!events.includes('whatsapp.smb.message.created'))
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
    keys.webhookEndpointId,
    keys.webhookUrl,
    keys.webhookStatus,
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
      await setAppConfig(keys.webhookEndpointId, 'webhook_ycloud_repair_test')
      await setAppConfig(keys.webhookUrl, 'https://example.test/webhook/whatsapp-api/ycloud')
      await setAppConfig(keys.webhookStatus, 'active')

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
        if (path === '/webhookEndpoints/webhook_ycloud_repair_test' && method === 'PATCH') {
          const body = JSON.parse(String(options.body || '{}'))
          assert.ok(body.enabledEvents.includes('whatsapp.smb.message.echoes'))
          assert.ok(!body.enabledEvents.includes('whatsapp.smb.message.created'))
          return ycloudJsonResponse({
            id: 'webhook_ycloud_repair_test',
            url: 'https://example.test/webhook/whatsapp-api/ycloud',
            status: 'active'
          })
        }
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
      assert.equal(result.completed, true)
      assert.equal(result.webhookUpdated, true)
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

test('backfill YCloud reanuda desde la siguiente pagina sin repetir el historial completo', async () => {
  const id = randomUUID()
  const phone = `+52986${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000000'
  const repairConfigKey = 'whatsapp_api_history_direction_repair_version'
  const stateConfigKey = 'whatsapp_api_ycloud_history_backfill_state'
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [
    keys.enabled,
    keys.apiKey,
    keys.senderPhone,
    keys.wabaId,
    keys.provider,
    keys.webhookEndpointId,
    keys.webhookUrl,
    repairConfigKey,
    stateConfigKey
  ]
  const requestedPages = []
  let webhookPatches = 0

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_batch_secret'))
      await setAppConfig(keys.senderPhone, businessPhone)
      await setAppConfig(keys.wabaId, 'waba_ycloud_batch_test')
      await setAppConfig(keys.provider, 'ycloud')
      await setAppConfig(keys.webhookEndpointId, 'webhook_ycloud_batch_test')
      await setAppConfig(keys.webhookUrl, 'https://example.test/webhook/whatsapp-api/ycloud')

      const records = Array.from({ length: 101 }, (_, index) => ({
        id: `ycloud_batch_${id}_${index + 1}`,
        from: businessPhone,
        to: phone,
        wabaId: 'waba_ycloud_batch_test',
        status: 'sent',
        type: 'text',
        text: { body: `Mensaje histórico ${index + 1}` },
        createTime: '2024-06-10T08:09:10.000Z',
        sendTime: '2024-06-10T08:09:10.000Z'
      }))

      setYCloudFetchForTest(async (url, options = {}) => {
        const parsed = new URL(String(url))
        const path = parsed.pathname.replace(/^\/v2/, '')
        const method = String(options.method || 'GET').toUpperCase()

        if (path === '/webhookEndpoints/webhook_ycloud_batch_test' && method === 'PATCH') {
          webhookPatches += 1
          return ycloudJsonResponse({
            id: 'webhook_ycloud_batch_test',
            url: 'https://example.test/webhook/whatsapp-api/ycloud',
            status: 'active'
          })
        }
        if (path === '/whatsapp/messages' && method === 'GET') {
          const page = Number(parsed.searchParams.get('page'))
          requestedPages.push(page)
          return ycloudJsonResponse({
            total: records.length,
            items: page === 1 ? records.slice(0, 100) : records.slice(100)
          })
        }
        return ycloudJsonResponse({ items: [], total: 0 })
      })

      const first = await runYCloudHistoryBackfillBatch({ maxPages: 1 })
      assert.equal(first.completed, false)
      assert.deepEqual(requestedPages, [1])
      assert.equal(webhookPatches, 1)
      assert.equal(JSON.parse(await getAppConfig(stateConfigKey)).page, 2)

      const second = await runYCloudHistoryBackfillBatch({ maxPages: 1 })
      assert.equal(second.completed, true)
      assert.deepEqual(requestedPages, [1, 2])
      assert.equal(webhookPatches, 1)
      assert.equal(await getAppConfig(repairConfigKey), '2026-07-11-ycloud-smb-echoes-backfill')

      const count = await db.get(
        "SELECT COUNT(*) AS count FROM whatsapp_api_messages WHERE ycloud_message_id LIKE ?",
        [`ycloud_batch_${id}_%`]
      )
      assert.equal(Number(count.count), 101)

      // YCloud rechaza page=101. Una cuenta con más de 10,000 salientes debe
      // cerrar el backfill en el límite documentado, no reintentar para siempre.
      requestedPages.length = 0
      await setAppConfig(repairConfigKey, '')
      await setAppConfig(stateConfigKey, JSON.stringify({
        version: YCLOUD_HISTORY_BACKFILL_VERSION,
        page: 100,
        webhookUpdated: true,
        total: 14892
      }))
      setYCloudFetchForTest(async (url, options = {}) => {
        const parsed = new URL(String(url))
        const path = parsed.pathname.replace(/^\/v2/, '')
        const method = String(options.method || 'GET').toUpperCase()
        if (path === '/whatsapp/messages' && method === 'GET') {
          requestedPages.push(Number(parsed.searchParams.get('page')))
          return ycloudJsonResponse({ total: 14892, items: records.slice(0, 100) })
        }
        return ycloudJsonResponse({ items: [], total: 0 })
      })

      const capped = await runYCloudHistoryBackfillBatch({ maxPages: 3 })
      assert.equal(capped.completed, true)
      assert.equal(capped.truncated, true)
      assert.equal(capped.providerPageLimitReached, true)
      assert.deepEqual(requestedPages, [100])
      assert.equal(await getAppConfig(repairConfigKey), YCLOUD_HISTORY_BACKFILL_VERSION)
      assert.equal(await getAppConfig(stateConfigKey), '')
    })
  } finally {
    setYCloudFetchForTest(null)
    await cleanup({ phone })
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

for (const scenario of [
  {
    name: 'usa rstkad_id cuando el source_id oficial no estuvo vivo ese dia',
    officialDate: '2024-07-14',
    ristakDate: '2024-07-15',
    expected: 'ristak'
  },
  {
    name: 'mantiene source_id oficial cuando el oficial estuvo vivo y rstkad_id no',
    officialDate: '2024-07-15',
    ristakDate: '2024-07-14',
    expected: 'official'
  },
  {
    name: 'mantiene source_id oficial cuando ambos candidatos estuvieron vivos',
    officialDate: '2024-07-15',
    ristakDate: '2024-07-15',
    expected: 'official'
  }
]) {
  test(`resuelve conflicto source_id vs rstkad_id: ${scenario.name}`, async () => {
    const id = randomUUID()
    const suffix = id.replace(/-/g, '').slice(0, 12)
    const numericSuffix = Date.now().toString().slice(-8)
    const phone = `+52992${numericSuffix}`
    const businessPhone = '+526561000000'
    const messageId = `ycloud_conflict_${suffix}`
    const officialAdId = `69910${numericSuffix}`
    const ristakAdId = `69920${numericSuffix}`
    const expectedAdId = scenario.expected === 'ristak' ? ristakAdId : officialAdId
    const messageAt = '2024-07-15T18:00:00.000Z'
    const previousTimezone = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      ['account_timezone']
    ).catch(() => null)

    await cleanup({ messageId, phone })
    await cleanupMetaAds([officialAdId, ristakAdId])

    try {
      await setAppConfig('account_timezone', 'America/Mexico_City')
      await insertMetaAdForDate({
        adId: officialAdId,
        date: scenario.officialDate,
        suffix: `official_${suffix}`,
        name: 'Anuncio oficial'
      })
      await insertMetaAdForDate({
        adId: ristakAdId,
        date: scenario.ristakDate,
        suffix: `rstkad_${suffix}`,
        name: 'Anuncio marcador Ristak'
      })

      const result = await syncYCloudMessageRecords([{
        id: messageId,
        wamid: `wamid.${id}`,
        from: phone,
        to: businessPhone,
        sendTime: messageAt,
        type: 'text',
        text: { body: `Hola, me interesaria una consulta (rstkad_id=${ristakAdId}!)` },
        customerProfile: { name: 'Cliente Conflicto' },
        referral: {
          source_url: 'https://fb.me/conflict-test',
          source_type: 'ad',
          source_id: officialAdId,
          headline: 'Consulta con el Dr Marco',
          body: 'Agenda por WhatsApp',
          ctwa_clid: `ctwa_conflict_${suffix}`
        }
      }], {
        businessPhoneHints: [businessPhone],
        direction: 'inbound',
        eventType: 'whatsapp.inbound_message.received',
        source: 'ycloud_conflict_test'
      })

      assert.equal(result.messages, 1)
      assert.equal(result.attributed, 1)

      const message = await db.get(`
        SELECT id, contact_id, message_text, detected_source_id, detected_source_type
        FROM whatsapp_api_messages
        WHERE ycloud_message_id = ?
      `, [messageId])

      assert.equal(message.detected_source_id, expectedAdId)
      assert.equal(message.detected_source_type, 'ad')
      assert.equal(message.message_text, 'Hola, me interesaria una consulta')

      const contact = await db.get(`
        SELECT attribution_ad_id, attribution_ad_name, attribution_medium
        FROM contacts
        WHERE id = ?
      `, [message.contact_id])

      assert.equal(contact.attribution_ad_id, expectedAdId)
      assert.equal(contact.attribution_ad_name, 'Consulta con el Dr Marco')
      assert.equal(contact.attribution_medium, 'ad')

      const touch = await db.get(`
        SELECT detected_source_id
        FROM whatsapp_api_attribution
        WHERE whatsapp_api_message_id = ?
      `, [message.id])

      assert.equal(touch.detected_source_id, expectedAdId)
    } finally {
      await cleanup({ messageId, phone })
      await cleanupMetaAds([officialAdId, ristakAdId])
      if (previousTimezone?.config_value) {
        await setAppConfig('account_timezone', previousTimezone.config_value)
      } else {
        await db.run('DELETE FROM app_config WHERE config_key = ?', ['account_timezone']).catch(() => undefined)
      }
    }
  })
}

test('sync historico de YCloud no pisa el primer anuncio del contacto con retouches posteriores', async () => {
  const id = randomUUID()
  const phone = `+52996${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000000'
  const contactId = `rstk_contact_test_${id}`
  const messageId = `ycloud_history_retouch_${id}`
  const firstAdId = '238555000111222'
  const retouchAdId = '238555000999888'
  const messageAt = '2024-06-11T12:13:14.000Z'

  await cleanup({ contactId, messageId, phone })

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source,
        attribution_ad_id, attribution_ad_name, attribution_ctwa_clid,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'Cliente Primer Anuncio',
      'Cliente',
      'WhatsApp_API',
      firstAdId,
      'Anuncio mayo',
      'ctwa_first_123',
      '2024-05-10T10:00:00.000Z',
      '2024-05-10T10:00:00.000Z'
    ])

    const result = await syncYCloudMessageRecords([{
      id: messageId,
      wamid: `wamid.${id}`,
      from: phone,
      to: businessPhone,
      sendTime: messageAt,
      type: 'text',
      text: { body: 'Quiero informes otra vez' },
      customerProfile: { name: 'Cliente Primer Anuncio' },
      referral: {
        source_url: 'https://fb.me/retouch-test',
        source_type: 'ad',
        source_id: retouchAdId,
        headline: 'Anuncio junio',
        body: 'Agenda por WhatsApp',
        ctwa_clid: 'ctwa_retouch_456'
      }
    }], {
      businessPhoneHints: [businessPhone],
      direction: 'inbound',
      eventType: 'whatsapp.smb.history',
      source: 'ycloud_history_test'
    })

    assert.equal(result.messages, 1)
    assert.equal(result.attributed, 1)

    const contact = await db.get(`
      SELECT attribution_ad_id, attribution_ad_name, attribution_ctwa_clid
      FROM contacts
      WHERE id = ?
    `, [contactId])

    assert.equal(contact.attribution_ad_id, firstAdId)
    assert.equal(contact.attribution_ad_name, 'Anuncio mayo')
    assert.equal(contact.attribution_ctwa_clid, 'ctwa_first_123')

    const message = await db.get(`
      SELECT id, detected_source_id, detected_ctwa_clid
      FROM whatsapp_api_messages
      WHERE ycloud_message_id = ?
    `, [messageId])

    assert.equal(message.detected_source_id, retouchAdId)
    assert.equal(message.detected_ctwa_clid, 'ctwa_retouch_456')

    const touch = await db.get(`
      SELECT detected_source_id, detected_headline, detected_ctwa_clid
      FROM whatsapp_api_attribution
      WHERE whatsapp_api_message_id = ?
    `, [message.id])

    assert.equal(touch.detected_source_id, retouchAdId)
    assert.equal(touch.detected_headline, 'Anuncio junio')
    assert.equal(touch.detected_ctwa_clid, 'ctwa_retouch_456')
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

test('backfill corrige source_id historico cuando rstkad_id es el anuncio vivo del dia', async () => {
  const id = randomUUID()
  const suffix = id.replace(/-/g, '').slice(0, 12)
  const numericSuffix = Date.now().toString().slice(-8)
  const phone = `+52991${numericSuffix}`
  const contactId = `rstk_contact_test_${id}`
  const apiContactId = `waapi_profile_test_${id}`
  const messageId = `waapi_msg_conflict_${id}`
  const attributionId = `waapi_attr_conflict_${id}`
  const officialAdId = `69930${numericSuffix}`
  const ristakAdId = `69940${numericSuffix}`
  const messageAt = '2024-07-15T18:00:00.000Z'
  const previousTimezone = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    ['account_timezone']
  ).catch(() => null)

  await cleanup({ contactId, apiContactId, messageId, phone })
  await cleanupMetaAds([officialAdId, ristakAdId])

  try {
    await setAppConfig('account_timezone', 'America/Mexico_City')
    await insertMetaAdForDate({
      adId: officialAdId,
      date: '2024-07-14',
      suffix: `official_backfill_${suffix}`,
      name: 'Anuncio oficial otro dia'
    })
    await insertMetaAdForDate({
      adId: ristakAdId,
      date: '2024-07-15',
      suffix: `rstkad_backfill_${suffix}`,
      name: 'Anuncio Ristak correcto'
    })

    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source,
        attribution_ad_id, attribution_ad_name, attribution_ctwa_clid,
        attribution_url, attribution_medium, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'Cliente Backfill Conflicto',
      'Cliente',
      'WhatsApp_API',
      officialAdId,
      'Consulta con el Dr Marco',
      'ctwa_conflict_backfill',
      'https://fb.me/conflict-backfill',
      'ad',
      messageAt,
      messageAt
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
      'Cliente Backfill Conflicto',
      JSON.stringify({ nickname: 'Cliente Backfill Conflicto' }),
      messageAt,
      messageAt,
      1,
      messageAt,
      messageAt
    ])

    const rawPayload = {
      id: 'ycloud_conflict_backfill',
      customerProfile: { name: 'Cliente Backfill Conflicto' },
      from: phone,
      to: '+526561000000',
      sendTime: messageAt,
      type: 'text',
      text: { body: `Hola, me interesaria una consulta rstkad_id=${ristakAdId}!` },
      referral: {
        source_url: 'https://fb.me/conflict-backfill',
        source_type: 'ad',
        source_id: officialAdId,
        headline: 'Consulta con el Dr Marco',
        body: 'Agenda por WhatsApp',
        ctwa_clid: 'ctwa_conflict_backfill'
      }
    }
    const referral = rawPayload.referral

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
      'ycloud_conflict_backfill',
      apiContactId,
      contactId,
      phone,
      phone,
      '+526561000000',
      'inbound',
      'text',
      rawPayload.text.body,
      'received',
      messageAt,
      JSON.stringify(rawPayload),
      JSON.stringify(referral),
      'ctwa_conflict_backfill',
      officialAdId,
      'https://fb.me/conflict-backfill',
      'ad',
      'Consulta con el Dr Marco',
      'Agenda por WhatsApp',
      messageAt,
      messageAt
    ])

    await db.run(`
      INSERT INTO whatsapp_api_attribution (
        id, whatsapp_api_message_id, whatsapp_api_contact_id, contact_id, phone,
        ycloud_message_id, detected_ctwa_clid, detected_source_id,
        detected_source_url, detected_source_type, detected_headline,
        detected_body, referral_json, raw_payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      attributionId,
      messageId,
      apiContactId,
      contactId,
      phone,
      'ycloud_conflict_backfill',
      'ctwa_conflict_backfill',
      officialAdId,
      'https://fb.me/conflict-backfill',
      'ad',
      'Consulta con el Dr Marco',
      'Agenda por WhatsApp',
      JSON.stringify(referral),
      JSON.stringify(rawPayload),
      messageAt
    ])

    const repaired = await repairWhatsAppApiContactIdentityFromMessages({ limit: 100 })
    assert.ok(repaired.contacts >= 1)
    assert.equal(repaired.repairedAdTouches, 1)

    const contact = await db.get(`
      SELECT attribution_ad_id, attribution_ad_name
      FROM contacts
      WHERE id = ?
    `, [contactId])

    assert.equal(contact.attribution_ad_id, ristakAdId)
    assert.equal(contact.attribution_ad_name, 'Consulta con el Dr Marco')

    const message = await db.get('SELECT detected_source_id FROM whatsapp_api_messages WHERE id = ?', [messageId])
    assert.equal(message.detected_source_id, ristakAdId)

    const touch = await db.get('SELECT detected_source_id FROM whatsapp_api_attribution WHERE id = ?', [attributionId])
    assert.equal(touch.detected_source_id, ristakAdId)
  } finally {
    await cleanup({ contactId, apiContactId, messageId, phone })
    await cleanupMetaAds([officialAdId, ristakAdId])
    if (previousTimezone?.config_value) {
      await setAppConfig('account_timezone', previousTimezone.config_value)
    } else {
      await db.run('DELETE FROM app_config WHERE config_key = ?', ['account_timezone']).catch(() => undefined)
    }
  }
})

test('backfill restaura el primer anuncio cuando un retouch posterior pisó el contacto', async () => {
  const id = randomUUID()
  const phone = `+52997${Date.now().toString().slice(-7)}`
  const contactId = `rstk_contact_test_${id}`
  const apiContactId = `waapi_profile_test_${id}`
  const firstMessageId = `waapi_msg_first_ad_${id}`
  const retouchMessageId = `waapi_msg_retouch_ad_${id}`
  const firstAdId = '238555000111222'
  const retouchAdId = '238555000999888'

  await cleanup({ contactId, apiContactId, messageId: firstMessageId, phone })

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source,
        attribution_ad_id, attribution_ad_name, attribution_ctwa_clid,
        attribution_url, attribution_medium, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'Cliente Retouch',
      'Cliente',
      'WhatsApp_API',
      retouchAdId,
      'Anuncio junio',
      'ctwa_retouch_456',
      'https://fb.me/retouch',
      'ad',
      '2024-05-10T10:00:00.000Z',
      '2024-06-11T12:13:14.000Z'
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
      'Cliente Retouch',
      JSON.stringify({ nickname: 'Cliente Retouch' }),
      '2024-05-10T10:00:00.000Z',
      '2024-06-11T12:13:14.000Z',
      2,
      '2024-05-10T10:00:00.000Z',
      '2024-06-11T12:13:14.000Z'
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
      firstMessageId,
      'ycloud',
      'whatsapp.inbound_message.received',
      'ycloud_first_ad',
      apiContactId,
      contactId,
      phone,
      phone,
      '+526561000000',
      'inbound',
      'text',
      'Quiero informes',
      'received',
      '2024-05-10T10:00:00.000Z',
      JSON.stringify({
        id: 'ycloud_first_ad',
        customerProfile: { name: 'Cliente Retouch' },
        from: phone,
        to: '+526561000000',
        sendTime: '2024-05-10T10:00:00.000Z',
        type: 'text',
        text: { body: 'Quiero informes' },
        referral: {
          source_url: 'https://fb.me/first',
          source_type: 'ad',
          source_id: firstAdId,
          headline: 'Anuncio mayo',
          body: 'Agenda por WhatsApp',
          ctwa_clid: 'ctwa_first_123'
        }
      }),
      JSON.stringify({
        source_url: 'https://fb.me/first',
        source_type: 'ad',
        source_id: firstAdId,
        headline: 'Anuncio mayo',
        body: 'Agenda por WhatsApp',
        ctwa_clid: 'ctwa_first_123'
      }),
      'ctwa_first_123',
      firstAdId,
      'https://fb.me/first',
      'ad',
      'Anuncio mayo',
      'Agenda por WhatsApp',
      '2024-05-10T10:00:00.000Z',
      '2024-05-10T10:00:00.000Z'
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
      retouchMessageId,
      'ycloud',
      'whatsapp.inbound_message.received',
      'ycloud_retouch_ad',
      apiContactId,
      contactId,
      phone,
      phone,
      '+526561000000',
      'inbound',
      'text',
      `Hola otra vez rstkad_id=${retouchAdId}!`,
      'received',
      '2024-06-11T12:13:14.000Z',
      JSON.stringify({
        id: 'ycloud_retouch_ad',
        customerProfile: { name: 'Cliente Retouch' },
        from: phone,
        to: '+526561000000',
        sendTime: '2024-06-11T12:13:14.000Z',
        type: 'text',
        text: { body: `Hola otra vez rstkad_id=${retouchAdId}!` },
        referral: {
          source_url: 'https://fb.me/retouch',
          source_type: 'ad',
          source_id: retouchAdId,
          headline: 'Anuncio junio',
          body: 'Agenda por WhatsApp',
          ctwa_clid: 'ctwa_retouch_456'
        }
      }),
      JSON.stringify({
        source_url: 'https://fb.me/retouch',
        source_type: 'ad',
        source_id: retouchAdId,
        headline: 'Anuncio junio',
        body: 'Agenda por WhatsApp',
        ctwa_clid: 'ctwa_retouch_456'
      }),
      'ctwa_retouch_456',
      retouchAdId,
      'https://fb.me/retouch',
      'ad',
      'Anuncio junio',
      'Agenda por WhatsApp',
      '2024-06-11T12:13:14.000Z',
      '2024-06-11T12:13:14.000Z'
    ])

    const repaired = await repairWhatsAppApiContactIdentityFromMessages({ limit: 100 })
    assert.ok(repaired.contacts >= 1)
    assert.equal(repaired.restoredFirstAdAttributions, 1)

    const contact = await db.get(`
      SELECT attribution_ad_id, attribution_ad_name, attribution_ctwa_clid,
             attribution_url, attribution_medium
      FROM contacts
      WHERE id = ?
    `, [contactId])

    assert.equal(contact.attribution_ad_id, firstAdId)
    assert.equal(contact.attribution_ad_name, 'Anuncio mayo')
    assert.equal(contact.attribution_ctwa_clid, 'ctwa_first_123')
    assert.equal(contact.attribution_url, 'https://fb.me/first')
    assert.equal(contact.attribution_medium, 'ad')

    const retouchMessage = await db.get(`
      SELECT detected_source_id, detected_ctwa_clid
      FROM whatsapp_api_messages
      WHERE id = ?
    `, [retouchMessageId])

    assert.equal(retouchMessage.detected_source_id, retouchAdId)
    assert.equal(retouchMessage.detected_ctwa_clid, 'ctwa_retouch_456')
  } finally {
    await cleanup({ contactId, apiContactId, messageId: firstMessageId, phone })
  }
})
