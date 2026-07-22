import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  getWhatsAppApiStatus,
  getWhatsAppApiConfigKeys,
  resolveWhatsAppOutboundRoute,
  sendWhatsAppApiInteractiveMessage,
  sendWhatsAppApiTextMessage,
  sendWhatsAppApiTemplateMessage,
  setMetaDirectFetchForTest,
  setYCloudFetchForTest
} from '../src/services/whatsappApiService.js'
import {
  handleAutomationEvent,
  handleIncomingMessage
} from '../src/services/automationEngine.js'
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
    json: async () => body,
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
          const id = `qr_automation_msg_${messageIndex}`
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

async function withYCloudMessageCapture(callback) {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const businessPhone = '+526561234567'
  const phoneNumberId = 'phone_ycloud_buttons_test'
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
  captures.openReplyWindow = async (phone, existingContactId = '') => {
    const now = new Date().toISOString()
    const suffix = String(phone || '').replace(/\D/g, '') || randomUUID().replace(/-/g, '')
    const contactId = existingContactId || `ycloud_buttons_contact_${suffix}`
    const messageId = `ycloud_buttons_inbound_${suffix}`

    if (!existingContactId) {
      await db.run(`
        INSERT INTO contacts (
          id, phone, full_name, first_name, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          phone = excluded.phone,
          updated_at = excluded.updated_at
      `, [
        contactId,
        phone,
        'Cliente Botones',
        'Cliente',
        'WhatsApp_API',
        now,
        now
      ])
    }

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, provider, ycloud_message_id, contact_id, phone, from_phone, to_phone,
        business_phone, business_phone_number_id, transport, direction, message_type,
        message_text, status, message_timestamp, created_at, updated_at
      ) VALUES (?, 'ycloud', ?, ?, ?, ?, ?, ?, ?, 'api', 'inbound', 'text', ?, 'received', ?, ?, ?)
    `, [
      messageId,
      messageId,
      contactId,
      phone,
      phone,
      businessPhone,
      businessPhone,
      phoneNumberId,
      'Respuesta reciente del cliente',
      now,
      now,
      now
    ])
  }

  return snapshotAppConfig(configKeys, async () => {
    await setAppConfig(keys.enabled, '1')
    await setAppConfig(keys.apiKey, encrypt('ycloud_test_secret'))
    await setAppConfig(keys.senderPhone, businessPhone)
    await setAppConfig(keys.phoneNumberId, phoneNumberId)
    await setAppConfig(keys.wabaId, 'waba_ycloud_buttons_test')
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
          id: `ycloud_msg_${captures.length}`,
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

async function withMetaDirectMessageCapture(callback) {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [
    keys.provider,
    keys.metaStatus,
    keys.metaWabaId,
    keys.metaPhoneNumberId,
    keys.metaDisplayPhoneNumber,
    keys.metaSystemUserToken,
    keys.metaLastError
  ]
  const captures = []

  return snapshotAppConfig(configKeys, async () => {
    await setAppConfig(keys.provider, 'meta_direct')
    await setAppConfig(keys.metaStatus, 'connected')
    await setAppConfig(keys.metaWabaId, 'waba_meta_direct_buttons_test')
    await setAppConfig(keys.metaPhoneNumberId, 'phone_meta_direct_buttons_test')
    await setAppConfig(keys.metaDisplayPhoneNumber, '+526561234567')
    await setAppConfig(keys.metaSystemUserToken, encrypt('meta_direct_test_token'))
    await setAppConfig(keys.metaLastError, '')

    setMetaDirectFetchForTest(async (url, options = {}) => {
      const parsed = new URL(String(url))
      const method = String(options.method || 'GET').toUpperCase()
      if (parsed.pathname.endsWith('/phone_meta_direct_buttons_test/messages') && method === 'POST') {
        const body = JSON.parse(options.body || '{}')
        captures.push(body)
        return ycloudJsonResponse({
          messaging_product: 'whatsapp',
          contacts: [{ input: body.to, wa_id: body.to.replace(/\D/g, '') }],
          messages: [{ id: `wamid.meta_direct_${captures.length}` }]
        })
      }
      return ycloudJsonResponse({ ok: true })
    })

    try {
      return await callback(captures)
    } finally {
      setMetaDirectFetchForTest(null)
    }
  })
}

test('Meta directo exige reconexión y deshabilita el número cuando Graph revoca el activo', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const phoneNumberId = `phone_meta_permission_${randomUUID()}`
  const contactId = `contact_meta_permission_${randomUUID()}`
  const customerPhone = '+526561111111'
  const configKeys = [
    keys.provider,
    keys.metaStatus,
    keys.metaWabaId,
    keys.metaPhoneNumberId,
    keys.metaDisplayPhoneNumber,
    keys.metaSystemUserToken,
    keys.metaLastError
  ]

  await snapshotAppConfig(configKeys, async () => {
    await setAppConfig(keys.provider, 'meta_direct')
    await setAppConfig(keys.metaStatus, 'connected')
    await setAppConfig(keys.metaWabaId, 'waba_meta_permission_test')
    await setAppConfig(keys.metaPhoneNumberId, phoneNumberId)
    await setAppConfig(keys.metaDisplayPhoneNumber, '+526568619478')
    await setAppConfig(keys.metaSystemUserToken, encrypt('meta_direct_revoked_token'))
    await setAppConfig(keys.metaLastError, '')
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, waba_id, phone_number, display_phone_number, verified_name,
        status, api_send_enabled, updated_at
      ) VALUES (?, 'meta_direct', 'waba_meta_permission_test', '+526568619478', '+52 656 861 9478',
        'Meta Permission Test', 'CONNECTED', 1, CURRENT_TIMESTAMP)
    `, [phoneNumberId])
    await db.run(`
      INSERT INTO contacts (id, phone, full_name, source, created_at, updated_at)
      VALUES (?, ?, 'Meta Permission Contact', 'WhatsApp_API', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [contactId, customerPhone])
    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, provider, source_adapter, contact_id, phone, from_phone, to_phone,
        business_phone, business_phone_number_id, transport, direction,
        message_type, message_text, message_timestamp, created_at, updated_at
      ) VALUES (?, 'meta_direct', 'meta_direct', ?, ?, ?, '+526568619478',
        '+526568619478', ?, 'api', 'inbound', 'text', 'Respuesta reciente',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [`meta_permission_inbound_${randomUUID()}`, contactId, customerPhone, customerPhone, phoneNumberId])

    setMetaDirectFetchForTest(async () => ycloudJsonResponse({
      error: {
        code: 100,
        error_subcode: 33,
        message: `Unsupported post request. Object with ID '${phoneNumberId}' does not exist.`
      }
    }, { status: 400, statusText: 'Bad Request' }))

    try {
      await assert.rejects(
        () => sendWhatsAppApiTextMessage({
          to: customerPhone,
          text: 'Mensaje que no debe salir',
          contactId,
          allowQrFallback: false
        }),
        /perdió permisos en Meta/
      )

      assert.equal(await db.get(
        'SELECT config_value FROM app_config WHERE config_key = ?',
        [keys.metaStatus]
      ).then(row => row?.config_value), 'reconnect_required')
      assert.match(await db.get(
        'SELECT config_value FROM app_config WHERE config_key = ?',
        [keys.metaLastError]
      ).then(row => row?.config_value || ''), /Vuelve a conectarla/)
      assert.deepEqual(await db.get(
        'SELECT status, api_send_enabled FROM whatsapp_api_phone_numbers WHERE id = ?',
        [phoneNumberId]
      ), { status: 'AUTHORIZATION_REQUIRED', api_send_enabled: 0 })
    } finally {
      setMetaDirectFetchForTest(null)
      await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
      await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId])
    }
  })
})

test('un número YCloud elegido no se envía por Meta aunque la bandera global haya quedado vieja', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const suffix = randomUUID()
  const ycloudPhoneNumberId = `phone_ycloud_route_${suffix}`
  const metaPhoneNumberId = `phone_meta_stale_${suffix}`
  const businessPhone = `+52656${Date.now().toString().slice(-7)}`
  const to = `+52155${Date.now().toString().slice(-8)}`
  const contactId = `contact_ycloud_route_${suffix}`
  const configKeys = [
    keys.enabled,
    keys.apiKey,
    keys.senderPhone,
    keys.phoneNumberId,
    keys.wabaId,
    keys.provider,
    keys.metaStatus,
    keys.metaWabaId,
    keys.metaPhoneNumberId,
    keys.metaDisplayPhoneNumber,
    keys.metaSystemUserToken
  ]
  const ycloudRequests = []
  let metaRequests = 0

  await snapshotAppConfig(configKeys, async () => {
    try {
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_route_test_secret'))
      await setAppConfig(keys.senderPhone, businessPhone)
      await setAppConfig(keys.phoneNumberId, ycloudPhoneNumberId)
      await setAppConfig(keys.wabaId, `waba_ycloud_route_${suffix}`)
      // Reproduce el estado real encontrado en soporte: YCloud sano, pero la
      // bandera global todavía apuntando a una conexión Meta revocada.
      await setAppConfig(keys.provider, 'meta_direct')
      await setAppConfig(keys.metaStatus, 'reconnect_required')
      await setAppConfig(keys.metaWabaId, `waba_meta_stale_${suffix}`)
      await setAppConfig(keys.metaPhoneNumberId, metaPhoneNumberId)
      await setAppConfig(keys.metaDisplayPhoneNumber, '+526568619478')
      await setAppConfig(keys.metaSystemUserToken, encrypt('meta_stale_test_token'))

      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
        ) VALUES (?, 'ycloud', ?, ?, ?, 'YCloud Route Test', 1, 1, 0, 'disconnected', 'CONNECTED')
      `, [ycloudPhoneNumberId, `waba_ycloud_route_${suffix}`, businessPhone, businessPhone])
      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
        ) VALUES (?, 'meta_direct', ?, '+526568619478', '+526568619478',
          'Meta Stale Test', 0, 0, 0, 'disconnected', 'AUTHORIZATION_REQUIRED')
      `, [metaPhoneNumberId, `waba_meta_stale_${suffix}`])
      await db.run(`
        INSERT INTO contacts (id, phone, full_name, first_name, source, created_at, updated_at)
        VALUES (?, ?, 'Cliente Route Test', 'Cliente', 'WhatsApp_API', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [contactId, to])
      await db.run(`
        INSERT INTO whatsapp_api_messages (
          id, provider, ycloud_message_id, contact_id, phone, from_phone, to_phone,
          business_phone, business_phone_number_id, transport, direction, message_type,
          message_text, status, message_timestamp, created_at, updated_at
        ) VALUES (?, 'ycloud', ?, ?, ?, ?, ?, ?, ?, 'api', 'inbound', 'text',
          'Ventana abierta', 'received', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [`inbound_ycloud_route_${suffix}`, `inbound_ycloud_route_${suffix}`, contactId, to, to, businessPhone, businessPhone, ycloudPhoneNumberId])

      setYCloudFetchForTest(async (_url, options = {}) => {
        const body = JSON.parse(options.body || '{}')
        ycloudRequests.push(body)
        return ycloudJsonResponse({
          id: `ycloud_route_message_${suffix}`,
          from: body.from,
          to: body.to,
          type: body.type,
          text: body.text,
          status: 'sent'
        })
      })
      setMetaDirectFetchForTest(async () => {
        metaRequests += 1
        throw new Error('Meta no debe recibir este mensaje')
      })

      const result = await sendWhatsAppApiTextMessage({
        to,
        text: 'Este mensaje pertenece a YCloud',
        contactId,
        phoneNumberId: ycloudPhoneNumberId,
        allowQrFallback: false
      })

      assert.equal(ycloudRequests.length, 1)
      assert.equal(metaRequests, 0)
      assert.equal(ycloudRequests[0].from, businessPhone)
      assert.equal(ycloudRequests[0].text.body, 'Este mensaje pertenece a YCloud')
      assert.ok(result.localMessageId)
      assert.equal((await getWhatsAppApiStatus()).activeProvider, 'ycloud')
    } finally {
      setYCloudFetchForTest(null)
      setMetaDirectFetchForTest(null)
      await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR business_phone_number_id IN (?, ?)', [contactId, ycloudPhoneNumberId, metaPhoneNumberId]).catch(() => undefined)
      await db.run('DELETE FROM whatsapp_api_contacts WHERE contact_id = ? OR phone = ?', [contactId, to]).catch(() => undefined)
      await db.run('DELETE FROM contacts WHERE id = ? OR phone = ?', [contactId, to]).catch(() => undefined)
      await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id IN (?, ?)', [ycloudPhoneNumberId, metaPhoneNumberId]).catch(() => undefined)
    }
  })
})

test('un número Meta elegido no se envía por YCloud aunque la preferencia global diga YCloud', async () => {
  const keys = getWhatsAppApiConfigKeys()
  await withMetaDirectMessageCapture(async (captures) => {
    const contactId = `contact_meta_route_${randomUUID()}`
    const customerPhone = '+525510101010'
    await setAppConfig(keys.provider, 'ycloud')
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, waba_id, phone_number, display_phone_number, verified_name,
        is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
      ) VALUES ('phone_meta_direct_buttons_test', 'meta_direct',
        'waba_meta_direct_buttons_test', '+526561234567', '+526561234567',
        'Meta Route Test', 0, 1, 0, 'disconnected', 'CONNECTED')
      ON CONFLICT(id) DO UPDATE SET
        provider = 'meta_direct',
        api_send_enabled = 1,
        status = 'CONNECTED'
    `)
    await db.run(`
      INSERT INTO contacts (id, phone, full_name, source, created_at, updated_at)
      VALUES (?, ?, 'Meta Route Contact', 'WhatsApp_API', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [contactId, customerPhone])
    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, provider, source_adapter, contact_id, phone, from_phone, to_phone,
        business_phone, business_phone_number_id, transport, direction,
        message_type, message_text, message_timestamp, created_at, updated_at
      ) VALUES (?, 'meta_direct', 'meta_direct', ?, ?, ?, '+526561234567',
        '+526561234567', 'phone_meta_direct_buttons_test', 'api', 'inbound',
        'text', 'Respuesta reciente', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [`meta_route_inbound_${randomUUID()}`, contactId, customerPhone, customerPhone])

    try {
      const result = await sendWhatsAppApiTextMessage({
        to: customerPhone,
        text: 'Este mensaje pertenece a Meta',
        phoneNumberId: 'phone_meta_direct_buttons_test',
        contactId,
        allowQrFallback: false
      })

      assert.equal(captures.length, 1)
      assert.equal(captures[0].type, 'text')
      assert.equal(captures[0].text.body, 'Este mensaje pertenece a Meta')
      assert.equal(result.messages?.[0]?.id, 'wamid.meta_direct_1')
    } finally {
      await db.run('DELETE FROM whatsapp_api_messages WHERE business_phone_number_id = ? OR phone = ?', ['phone_meta_direct_buttons_test', customerPhone]).catch(() => undefined)
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [customerPhone]).catch(() => undefined)
      await db.run('DELETE FROM contacts WHERE id = ? OR phone = ?', [contactId, customerPhone]).catch(() => undefined)
      await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', ['phone_meta_direct_buttons_test']).catch(() => undefined)
    }
  })
})

async function withOnlyQrSender(callback) {
  const phoneNumberId = `phone_auto_qr_primary_${randomUUID()}`
  const businessPhone = '+526561234567'
  const connectedJid = `${normalizeDigits(businessPhone)}@s.whatsapp.net`
  const sentMessages = []
  const existingPhones = await db.all(`
    SELECT id, api_send_enabled, qr_send_enabled, qr_status
    FROM whatsapp_api_phone_numbers
  `)

  resetWhatsAppQrServiceForTest()

  try {
    await db.run('UPDATE whatsapp_api_phone_numbers SET api_send_enabled = 0, qr_send_enabled = 0')
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId])
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, waba_id, phone_number, display_phone_number, verified_name,
        is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
      ) VALUES (?, 'qr', 'waba_auto_qr_primary_test', ?, ?, 'QR Automation Test', 1, 0, 1, 'connected', 'CONNECTED')
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

    setBaileysRuntimeForTest(createFakeBaileysRuntime(connectedJid, sentMessages))
    return await callback({ phoneNumberId, sentMessages })
  } finally {
    resetWhatsAppQrServiceForTest()
    await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    for (const row of existingPhones) {
      await db.run(`
        UPDATE whatsapp_api_phone_numbers
        SET api_send_enabled = ?, qr_send_enabled = ?, qr_status = ?
        WHERE id = ?
      `, [row.api_send_enabled, row.qr_send_enabled, row.qr_status, row.id]).catch(() => undefined)
    }
  }
}

test('mensaje manual pedido por QR usa API oficial si la ventana de 24h sigue abierta', async () => {
  await withYCloudMessageCapture(async (captures) => {
    const to = '+5215500012400'
    try {
      await captures.openReplyWindow(to)

      const result = await sendWhatsAppApiTextMessage({
        to,
        text: 'Seguimos por API',
        transport: 'qr',
        phoneNumberId: 'phone_ycloud_buttons_test',
        preferOfficialApiWhenReplyWindowOpen: true
      })

      assert.equal(captures.length, 1)
      assert.equal(captures[0].type, 'text')
      assert.equal(captures[0].text.body, 'Seguimos por API')
      assert.ok(result.localMessageId)

      const row = await db.get(
        `SELECT transport, message_text
         FROM whatsapp_api_messages
         WHERE id = ?`,
        [result.localMessageId]
      )
      assert.equal(row.transport, 'api')
      assert.equal(row.message_text, 'Seguimos por API')
    } finally {
      await db.run('DELETE FROM whatsapp_api_messages WHERE phone = ? OR to_phone = ?', [to, to])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to])
      await db.run('DELETE FROM contacts WHERE phone = ?', [to])
    }
  })
})

test('el ruteo activo promueve API y conserva el QR hermano como respaldo automático', async () => {
  await withYCloudMessageCapture(async () => {
    const suffix = randomUUID()
    const apiId = `phone_api_route_${suffix}`
    const qrId = `phone_qr_route_${suffix}`
    const businessPhone = '+526561234567'
    try {
      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
        ) VALUES (?, 'ycloud', 'waba_ycloud_buttons_test', ?, ?, 'API Route Test',
          1, 1, 0, 'disconnected', 'CONNECTED')
      `, [apiId, businessPhone, businessPhone])
      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
        ) VALUES (?, 'qr', ?, ?, 'QR Route Test', 0, 0, 1, 'connected', 'CONNECTED')
      `, [qrId, businessPhone, businessPhone])

      const route = await resolveWhatsAppOutboundRoute({ phoneNumberId: qrId })

      assert.equal(route.available, true)
      assert.equal(route.transport, 'api')
      assert.equal(route.phoneNumberId, apiId)
      assert.equal(route.qrFallbackAvailable, true)
    } finally {
      await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id IN (?, ?)', [apiId, qrId])
    }
  })
})

test('envía botones interactivos de respuesta por YCloud', async () => {
  await withYCloudMessageCapture(async (captures) => {
    const to = '+5215511112222'
    try {
      await captures.openReplyWindow(to)

      await sendWhatsAppApiInteractiveMessage({
        to,
        body: 'Elige una opción',
        buttons: [
          { id: 'interesado', title: 'Me interesa' },
          { id: 'despues', title: 'Luego' }
        ]
      })

      assert.equal(captures.length, 1)
      assert.equal(captures[0].type, 'interactive')
      assert.equal(captures[0].interactive.type, 'button')
      assert.deepEqual(captures[0].interactive.action.buttons.map(button => button.reply), [
        { id: 'interesado', title: 'Me interesa' },
        { id: 'despues', title: 'Luego' }
      ])
    } finally {
      await db.run('DELETE FROM whatsapp_api_messages WHERE phone = ? OR to_phone = ?', [to, to])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to])
      await db.run('DELETE FROM contacts WHERE phone = ?', [to])
    }
  })
})

test('agrega payloads a quick replies de plantillas al enviarlas por YCloud', async () => {
  await withYCloudMessageCapture(async (captures) => {
    const suffix = randomUUID()
    const templateId = `template_buttons_${suffix}`
    const to = '+5215522223333'
    const components = [
      {
        type: 'BODY',
        text: 'Hola, elige una opción'
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Sí quiero' },
          { type: 'QUICK_REPLY', text: 'Después' }
        ]
      }
    ]

    try {
      await db.run(
        `INSERT INTO whatsapp_api_templates (
          id, official_template_id, waba_id, name, language, status, components_json, raw_payload_json
        ) VALUES (?, ?, ?, ?, ?, 'APPROVED', ?, ?)`,
        [
          templateId,
          `official_${suffix}`,
          'waba_ycloud_buttons_test',
          `botones_${suffix.replace(/-/g, '_')}`,
          'es_MX',
          JSON.stringify(components),
          JSON.stringify({ components })
        ]
      )

      await sendWhatsAppApiTemplateMessage({
        to,
        templateId
      })

      assert.equal(captures.length, 1)
      assert.equal(captures[0].type, 'template')
      const buttonComponents = captures[0].template.components.filter(component => component.type === 'button')
      assert.equal(buttonComponents.length, 2)
      assert.deepEqual(buttonComponents.map(component => component.sub_type), ['quick_reply', 'quick_reply'])
      assert.deepEqual(buttonComponents.map(component => component.index), ['0', '1'])
      assert.equal(buttonComponents.every(component => component.parameters?.[0]?.type === 'payload'), true)
      assert.equal(buttonComponents[0].parameters[0].payload.includes(':button:0:si_quiero'), true)
    } finally {
      await db.run('DELETE FROM whatsapp_api_template_sends WHERE template_id = ?', [templateId])
      await db.run('DELETE FROM whatsapp_api_templates WHERE id = ?', [templateId])
      await db.run('DELETE FROM whatsapp_api_messages WHERE phone = ? OR to_phone = ?', [to, to])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to])
      await db.run('DELETE FROM contacts WHERE phone = ?', [to])
    }
  })
})

test('guarda en el chat el texto renderizado de plantillas enviadas por YCloud', async () => {
  await withYCloudMessageCapture(async (captures) => {
    const suffix = randomUUID()
    const templateId = `template_history_${suffix}`
    const templateName = `recordatorio_${suffix.replace(/-/g, '_')}`
    const to = `+52155${Date.now().toString().slice(-8)}`
    let ycloudMessageId = ''
    const components = [
      {
        type: 'BODY',
        text: 'Hola {{1}}, tu cita es {{2}}.'
      },
      {
        type: 'FOOTER',
        text: 'Gracias'
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Confirmar' }
        ]
      }
    ]

    try {
      await db.run(
        `INSERT INTO whatsapp_api_templates (
          id, official_template_id, waba_id, name, language, status, components_json, raw_payload_json
        ) VALUES (?, ?, ?, ?, ?, 'APPROVED', ?, ?)`,
        [
          templateId,
          `official_${suffix}`,
          'waba_ycloud_buttons_test',
          templateName,
          'es_MX',
          JSON.stringify(components),
          JSON.stringify({ components })
        ]
      )

      await sendWhatsAppApiTemplateMessage({
        to,
        templateId,
        variables: {
          1: 'Ana',
          2: 'mañana'
        }
      })
      assert.equal(captures.length, 1)
      ycloudMessageId = `ycloud_msg_${captures.length}`

      const row = await db.get(
        `SELECT message_type, message_text
         FROM whatsapp_api_messages
         WHERE ycloud_message_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
        [ycloudMessageId]
      )

      assert.equal(row.message_type, 'template')
      assert.equal(row.message_text, 'Hola Ana, tu cita es mañana.\n\nGracias\n\n- Confirmar')
      assert.notEqual(row.message_text, templateName)

      const sendRow = await db.get(
        'SELECT raw_payload_json FROM whatsapp_api_template_sends WHERE template_id = ? LIMIT 1',
        [templateId]
      )
      const sendPayload = JSON.parse(sendRow.raw_payload_json)
      assert.equal(sendPayload.template.id, templateId)
      assert.equal(sendPayload.template.renderedText, row.message_text)
      assert.deepEqual(sendPayload.template.components, components)
    } finally {
      await db.run('DELETE FROM whatsapp_api_template_sends WHERE template_id = ?', [templateId])
      await db.run('DELETE FROM whatsapp_api_templates WHERE id = ?', [templateId])
      await db.run('DELETE FROM whatsapp_api_messages WHERE ycloud_message_id = ? OR phone = ? OR to_phone = ?', [ycloudMessageId, to, to])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to])
      await db.run('DELETE FROM contacts WHERE phone = ?', [to])
    }
  })
})

test('guarda en el chat el texto renderizado de plantillas enviadas por Meta Direct', async () => {
  await withMetaDirectMessageCapture(async (captures) => {
    const suffix = randomUUID()
    const templateId = `template_meta_history_${suffix}`
    const templateName = `seguimiento_meta_${suffix.replace(/-/g, '_')}`
    const to = `+52156${Date.now().toString().slice(-8)}`
    const components = [
      {
        type: 'BODY',
        text: 'Hola {{1}}, tu pago de {{2}} está listo.'
      },
      {
        type: 'FOOTER',
        text: 'Gracias'
      }
    ]

    try {
      await db.run(
        `INSERT INTO whatsapp_api_templates (
          id, official_template_id, waba_id, name, language, status, components_json, raw_payload_json
        ) VALUES (?, ?, ?, ?, ?, 'APPROVED', ?, ?)`,
        [
          templateId,
          `official_${suffix}`,
          'waba_meta_direct_buttons_test',
          templateName,
          'es_MX',
          JSON.stringify(components),
          JSON.stringify({ components })
        ]
      )

      await sendWhatsAppApiTemplateMessage({
        to,
        templateId,
        variables: {
          1: 'Ana',
          2: 'Plan mensual'
        }
      })

      assert.equal(captures.length, 1)
      assert.equal(captures[0].type, 'template')
      assert.deepEqual(captures[0].template.components, [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Ana' },
            { type: 'text', text: 'Plan mensual' }
          ]
        }
      ])

      const row = await db.get(
        `SELECT provider, message_type, message_text, wamid, status
         FROM whatsapp_api_messages
         WHERE wamid = ?
         LIMIT 1`,
        ['wamid.meta_direct_1']
      )

      assert.equal(row.provider, 'meta_direct')
      assert.equal(row.message_type, 'template')
      assert.equal(row.message_text, 'Hola Ana, tu pago de Plan mensual está listo.\n\nGracias')
      assert.equal(row.status, 'sent')

      const sendRow = await db.get(
        'SELECT raw_payload_json FROM whatsapp_api_template_sends WHERE template_id = ? LIMIT 1',
        [templateId]
      )
      const sendPayload = JSON.parse(sendRow.raw_payload_json)
      assert.equal(sendPayload.request.provider, 'meta_direct')
      assert.equal(sendPayload.template.renderedText, row.message_text)
    } finally {
      await db.run('DELETE FROM whatsapp_api_template_sends WHERE template_id = ?', [templateId])
      await db.run('DELETE FROM whatsapp_api_templates WHERE id = ?', [templateId])
      await db.run('DELETE FROM whatsapp_api_messages WHERE wamid = ? OR phone = ? OR to_phone = ?', ['wamid.meta_direct_1', to, to])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to])
      await db.run('DELETE FROM contacts WHERE phone = ?', [to])
    }
  })
})

test('automatización usa parámetros predeterminados de la plantilla y no variables editadas en el bloque', async () => {
  await withYCloudMessageCapture(async (captures) => {
    const suffix = randomUUID()
    const templateId = `template_automation_defaults_${suffix}`
    const templateName = `seguimiento_defaults_${suffix.replace(/-/g, '_')}`
    const contactId = `contact_template_defaults_${suffix}`
    const automationId = `automation_template_defaults_${suffix}`
    const phone = `+52157${Date.now().toString().slice(-8)}`
    const components = [
      {
        type: 'BODY',
        text: 'Hola {{1}}, ya tenemos tu información.'
      }
    ]
    const flow = {
      nodes: [
        {
          id: 'start',
          type: 'start',
          label: 'Cuando...',
          config: {
            triggers: [
              { id: 'trigger-contact-created', type: 'trigger-contact-created', config: { source: '' } }
            ]
          }
        },
        {
          id: 'send-whatsapp-template',
          type: 'channel-whatsapp',
          label: 'WhatsApp',
          config: {
            sender: 'default',
            messageType: 'template',
            templateId,
            templateName,
            messageBlocks: [
              {
                id: 'template-block',
                type: 'template',
                templateId,
                templateName,
                templateVariables: {
                  1: 'Valor viejo que ya no debe usarse'
                }
              }
            ]
          }
        }
      ],
      edges: [
        { id: 'edge-start-send', sourceNodeId: 'start', targetNodeId: 'send-whatsapp-template' }
      ],
      settings: { allowReentry: true }
    }

    try {
      await db.run(
        `INSERT INTO whatsapp_message_templates (
          id, name, description, category, language, status,
          header_enabled, header_type, body_text, footer_text, buttons_json,
          variables_json, variable_examples_json, variable_bindings_json,
          ycloud_template_id, ycloud_status, ycloud_raw_payload_json,
          created_at, updated_at
        ) VALUES (?, ?, '', 'utility', 'es_MX', 'active', 0, 'none', ?, '', '[]', ?, ?, ?, ?, 'APPROVED', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        `local_${templateId}`,
        templateName,
        'Hola {{1}}, ya tenemos tu información.',
        JSON.stringify(['{{1}}']),
        JSON.stringify({ '{{1}}': 'Ana' }),
        JSON.stringify({ bodyText: { 1: { variableKey: 'contact.first_name', mergeField: '{{contact.first_name}}', label: 'Nombre', example: 'Ana' } } }),
        templateId,
        JSON.stringify({ id: templateId, name: templateName, status: 'APPROVED' })
      ])
      await db.run(
        `INSERT INTO whatsapp_api_templates (
          id, official_template_id, waba_id, name, language, status, components_json, raw_payload_json
        ) VALUES (?, ?, ?, ?, ?, 'APPROVED', ?, ?)`,
        [
          templateId,
          templateId,
          'waba_ycloud_buttons_test',
          templateName,
          'es_MX',
          JSON.stringify(components),
          JSON.stringify({ components })
        ]
      )
      await db.run(
        `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [contactId, phone, `template-defaults-${suffix}@example.com`, 'Claudia Plantilla', 'Claudia', '{}']
      )
      await db.run(
        `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
         VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
        [automationId, 'Test plantilla WhatsApp defaults', JSON.stringify(flow), JSON.stringify(flow)]
      )

      await handleAutomationEvent('contact-created', { contactId })

      assert.equal(captures.length, 1)
      assert.equal(captures[0].type, 'template')
      const bodyComponent = captures[0].template.components.find(component => component.type === 'body')
      assert.equal(bodyComponent.parameters[0].text, 'Claudia')
      assert.equal(JSON.stringify(captures[0]).includes('Valor viejo que ya no debe usarse'), false)

      const enrollment = await db.get(
        'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
        [automationId, contactId]
      )
      assert.equal(enrollment.status, 'completed')
    } finally {
      await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
      await db.run('DELETE FROM automations WHERE id = ?', [automationId])
      await db.run('DELETE FROM whatsapp_api_template_sends WHERE template_id = ?', [templateId])
      await db.run('DELETE FROM whatsapp_api_templates WHERE id = ?', [templateId])
      await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR phone = ? OR to_phone = ?', [contactId, phone, phone])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE contact_id = ? OR phone = ?', [contactId, phone])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
      await db.run('DELETE FROM whatsapp_message_templates WHERE id = ?', [`local_${templateId}`])
    }
  })
})

test('automatización de WhatsApp queda esperando botón y continúa por la salida elegida', async () => {
  await withYCloudMessageCapture(async (captures) => {
    const suffix = randomUUID()
    const contactId = `contact_button_wait_${suffix}`
    const automationId = `automation_button_wait_${suffix}`
    const phone = `+52155${Date.now().toString().slice(-8)}`
    const flow = {
      nodes: [
        {
          id: 'start',
          type: 'start',
          label: 'Cuando...',
          config: {
            triggers: [
              { id: 'trigger-contact-created', type: 'trigger-contact-created', config: { source: '' } }
            ]
          }
        },
        {
          id: 'send-whatsapp',
          type: 'channel-whatsapp',
          label: 'WhatsApp',
          config: {
            sender: 'default',
            messageType: 'text',
            messageBlocks: [
              {
                id: 'block-buttons',
                type: 'text',
                compiledText: '¿Te interesa?',
                buttons: [
                  { id: 'interesado', label: 'Me interesa', action: 'branch' },
                  { id: 'despues', label: 'Luego', action: 'branch' }
                ]
              }
            ]
          }
        },
        { id: 'done-interesado', type: 'extra-comment', label: 'Interesado', config: {} },
        { id: 'done-despues', type: 'extra-comment', label: 'Después', config: {} }
      ],
      edges: [
        { id: 'edge-start-send', sourceNodeId: 'start', targetNodeId: 'send-whatsapp' },
        { id: 'edge-button-interesado', sourceNodeId: 'send-whatsapp', sourceHandle: 'btn_interesado', targetNodeId: 'done-interesado' },
        { id: 'edge-button-despues', sourceNodeId: 'send-whatsapp', sourceHandle: 'btn_despues', targetNodeId: 'done-despues' }
      ],
      settings: { allowReentry: true }
    }

    try {
      await db.run(
        `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [contactId, phone, `button-wait-${suffix}@example.com`, 'Contacto Botón', 'Contacto', '{}']
      )
      await db.run(
        `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
         VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
        [automationId, 'Test botón WhatsApp', JSON.stringify(flow), JSON.stringify(flow)]
      )
      await captures.openReplyWindow(phone, contactId)

      await handleAutomationEvent('contact-created', { contactId })

      let enrollment = await db.get(
        'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
        [automationId, contactId]
      )
      assert.equal(enrollment.status, 'waiting')
      assert.equal(enrollment.wait_kind, 'button_reply')
      assert.equal(enrollment.current_node_id, 'send-whatsapp')
      assert.deepEqual(JSON.parse(enrollment.context).waitButtons, [
        { id: 'interesado', label: 'Me interesa' },
        { id: 'despues', label: 'Luego' }
      ])
      assert.equal(captures[0].interactive.type, 'button')

      await handleIncomingMessage({
        contactId,
        phone,
        text: 'Me interesa',
        buttonId: 'interesado',
        buttonPayload: 'interesado',
        buttonTitle: 'Me interesa',
        buttonReplyType: 'button_reply',
        channel: 'whatsapp'
      })

      enrollment = await db.get(
        'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
        [automationId, contactId]
      )
      assert.equal(enrollment.status, 'completed')
      assert.equal(enrollment.current_node_id, 'done-interesado')
      const log = JSON.parse(enrollment.log)
      assert.equal(log.some(entry => String(entry.detail || '').includes('Botón "Me interesa" recibido')), true)
    } finally {
      await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
      await db.run('DELETE FROM automations WHERE id = ?', [automationId])
      await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR phone = ?', [contactId, phone])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE contact_id = ? OR phone = ?', [contactId, phone])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    }
  })
})

test('automatización con respaldo QR usa WhatsApp API primero cuando está disponible', async () => {
  await withYCloudMessageCapture(async (captures) => {
    const suffix = randomUUID()
    const contactId = `contact_qr_mode_${suffix}`
    const automationId = `automation_qr_mode_${suffix}`
    const phone = `+52156${Date.now().toString().slice(-8)}`
    const flow = {
      nodes: [
        {
          id: 'start',
          type: 'start',
          label: 'Cuando...',
          config: {
            triggers: [
              { id: 'trigger-contact-created', type: 'trigger-contact-created', config: { source: '' } }
            ]
          }
        },
        {
          id: 'send-whatsapp',
          type: 'channel-whatsapp',
          label: 'WhatsApp',
          config: {
            sender: 'default',
            messageType: 'text',
            // El flag legacy ya no gobierna el ruteo. Aunque esté apagado y el
            // transporte guardado diga QR, la API oficial sigue siendo primaria.
            sendViaQr: false,
            transport: 'qr',
            messageBlocks: [
              {
                id: 'block-text',
                type: 'text',
                compiledText: 'Hola por QR'
              }
            ]
          }
        }
      ],
      edges: [
        { id: 'edge-start-send', sourceNodeId: 'start', targetNodeId: 'send-whatsapp' }
      ],
      settings: { allowReentry: true }
    }

    try {
      await db.run(
        `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [contactId, phone, `qr-mode-${suffix}@example.com`, 'Contacto QR', 'Contacto', '{}']
      )
      await db.run(
        `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
         VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
        [automationId, 'Test WhatsApp QR mode', JSON.stringify(flow), JSON.stringify(flow)]
      )
      await captures.openReplyWindow(phone, contactId)

      await handleAutomationEvent('contact-created', { contactId })

      const enrollment = await db.get(
        'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
        [automationId, contactId]
      )
      assert.equal(captures.length, 1)
      assert.equal(captures[0].type, 'text')
      assert.equal(captures[0].text.body, 'Hola por QR')
      assert.equal(enrollment.status, 'completed')
      const log = JSON.parse(enrollment.log)
      assert.equal(log.some(entry => String(entry.detail || '').includes('WhatsApp API')), true)
      assert.equal(log.some(entry => String(entry.detail || '').includes('conectado por QR')), false)
    } finally {
      await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
      await db.run('DELETE FROM automations WHERE id = ?', [automationId])
      await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR phone = ?', [contactId, phone])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE contact_id = ? OR phone = ?', [contactId, phone])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    }
  })
})

test('automatización de WhatsApp usa QR como canal principal cuando no hay API conectada', async () => {
  await withYCloudMessageCapture(async (captures) => {
    await withOnlyQrSender(async ({ sentMessages }) => {
      const suffix = randomUUID()
      const contactId = `contact_qr_primary_${suffix}`
      const automationId = `automation_qr_primary_${suffix}`
      const phone = `+52157${Date.now().toString().slice(-8)}`
      const flow = {
        nodes: [
          {
            id: 'start',
            type: 'start',
            label: 'Cuando...',
            config: {
              triggers: [
                { id: 'trigger-contact-created', type: 'trigger-contact-created', config: { source: '' } }
              ]
            }
          },
          {
            id: 'send-whatsapp',
            type: 'channel-whatsapp',
            label: 'WhatsApp',
            config: {
              sender: 'default',
              messageType: 'text',
              messageBlocks: [
                {
                  id: 'block-text',
                  type: 'text',
                  compiledText: 'Hola por QR primario'
                }
              ]
            }
          }
        ],
        edges: [
          { id: 'edge-start-send', sourceNodeId: 'start', targetNodeId: 'send-whatsapp' }
        ],
        settings: { allowReentry: true }
      }

      try {
        await db.run(
          `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [contactId, phone, `qr-primary-${suffix}@example.com`, 'Contacto QR Primario', 'Contacto', '{}']
        )
        await db.run(
          `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
           VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
          [automationId, 'Test WhatsApp QR primary', JSON.stringify(flow), JSON.stringify(flow)]
        )

        await handleAutomationEvent('contact-created', { contactId })

        const enrollment = await db.get(
          'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
          [automationId, contactId]
        )
        assert.equal(enrollment.status, 'completed')
        assert.equal(captures.length, 0)
        assert.equal(sentMessages.length, 1)
        assert.equal(sentMessages[0].payload.text, 'Hola por QR primario')

        const stored = await db.get(
          'SELECT transport, message_text FROM whatsapp_api_messages WHERE contact_id = ? AND direction = ?',
          [contactId, 'outbound']
        )
        assert.equal(stored.transport, 'qr')
        assert.equal(stored.message_text, 'Hola por QR primario')
      } finally {
        await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
        await db.run('DELETE FROM automations WHERE id = ?', [automationId])
        await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR phone = ?', [contactId, phone])
        await db.run('DELETE FROM whatsapp_api_contacts WHERE contact_id = ? OR phone = ?', [contactId, phone])
        await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
      }
    })
  })
})
