import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db, setAppConfig } from '../src/config/database.js'
import {
  QR_CONSENT_TEXT,
  resetWhatsAppQrServiceForTest,
  resumeWhatsAppQrSessions,
  setBaileysRuntimeForTest,
  startWhatsAppQrConnection,
  setWhatsAppQrReconnectDelayForTest,
  shutdownWhatsAppQrService
} from '../src/services/whatsappQrService.js'
import { createWhatsAppQrPhoneNumber, deleteWhatsAppQrPhoneNumber, disconnectWhatsAppPhoneNumber } from '../src/services/whatsappApiService.js'
import { getChatContacts } from '../src/controllers/contactsController.js'

const BUSINESS_PHONE = '+526561234567'
const CONNECTED_JID = '526561234567@s.whatsapp.net'
const DEFAULT_FAKE_WA_WEB_VERSION = [2, 3000, 1035194821]

function sqlFuture(offsetMs = 60_000) {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ')
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

async function readChatContacts(query = {}) {
  const res = createMockResponse()
  await getChatContacts({ query, user: {} }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body?.success, true)
  assert.ok(Array.isArray(res.body.data))

  return res.body.data
}

function createFakeBaileysRuntime(sockets = [], options = {}) {
  const DisconnectReason = {
    connectionClosed: 428,
    connectionLost: 408,
    connectionReplaced: 440,
    timedOut: 408,
    loggedOut: 401,
    badSession: 500,
    restartRequired: 515
  }
  const defaultVersion = options.defaultVersion || DEFAULT_FAKE_WA_WEB_VERSION
  const socketUser = options.user || { id: CONNECTED_JID }
  const authRegistered = options.authRegistered ?? true
  const fetchLatestWaWebVersion = options.fetchLatestWaWebVersion ||
    (options.latestWaWebVersion ? async () => ({ version: options.latestWaWebVersion, isLatest: true }) : undefined)

  return {
    DisconnectReason,
    DEFAULT_CONNECTION_CONFIG: {
      version: defaultVersion
    },
    defaultConnectionVersion: defaultVersion,
    fetchLatestWaWebVersion,
    BufferJSON: {
      replacer: (_key, value) => value,
      reviver: (_key, value) => value
    },
    Browsers: {
      macOS: (name) => ['macOS', name, 'Ristak']
    },
    initAuthCreds: () => ({
      me: options.authMe || { id: CONNECTED_JID },
      registered: authRegistered
    }),
    makeCacheableSignalKeyStore: (keys) => keys,
    proto: {
      Message: {
        AppStateSyncKeyData: {
          fromObject: (value) => value
        }
      }
    },
    makeWASocket: (socketOptions) => {
      const listeners = new Map()
      const sock = {
        options: socketOptions,
        user: socketUser,
        closed: false,
        signalRepository: socketOptions.signalRepository,
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
          close: () => {
            sock.closed = true
          }
        },
        emit: async (eventName, payload) => {
          for (const handler of listeners.get(eventName) || []) {
            await handler(payload)
          }
        }
      }
      sockets.push(sock)
      if (options.autoOpen) {
        queueMicrotask(() => {
          sock.emit('connection.update', { connection: 'open' }).catch(() => undefined)
        })
      }
      return sock
    }
  }
}

async function cleanupQrFixture(phoneNumberId) {
  resetWhatsAppQrServiceForTest()
  await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`])
  await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId])
  await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId])
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId])
}

async function withQrFixture({ status = 'connected', lastDisconnectedAt = null } = {}, callback) {
  const phoneNumberId = `phone_qr_reconnect_${randomUUID()}`
  await cleanupQrFixture(phoneNumberId)

  try {
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, waba_id, phone_number, display_phone_number, verified_name,
        is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
      ) VALUES (?, 'qr', 'waba_qr_reconnect_test', ?, ?, 'QR Reconnect Test', 1, 0, 1, ?, 'CONNECTED')
    `, [phoneNumberId, BUSINESS_PHONE, BUSINESS_PHONE, status])

    await db.run(`
      INSERT INTO whatsapp_qr_sessions (
        id, phone_number_id, expected_phone, connected_phone, status,
        consent_accepted, consent_text, consent_accepted_at, last_connected_at,
        last_disconnected_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
    `, [
      `qr_${phoneNumberId}`,
      phoneNumberId,
      BUSINESS_PHONE,
      BUSINESS_PHONE,
      status,
      QR_CONSENT_TEXT,
      lastDisconnectedAt
    ])

    await db.run(`
      INSERT INTO whatsapp_qr_auth_state (phone_number_id, auth_key, value_json, updated_at)
      VALUES (?, 'creds', ?, CURRENT_TIMESTAMP)
    `, [
      phoneNumberId,
      JSON.stringify({
        me: { id: CONNECTED_JID },
        registered: true
      })
    ])

    return await callback({ phoneNumberId })
  } finally {
    await cleanupQrFixture(phoneNumberId)
  }
}

test('resumeWhatsAppQrSessions reabre sesiones connection_replaced sin cooldown manual', async () => {
  const sockets = []

  await withQrFixture({
    status: 'connection_replaced',
    lastDisconnectedAt: new Date().toISOString()
  }, async () => {
    setBaileysRuntimeForTest(createFakeBaileysRuntime(sockets))

    const result = await resumeWhatsAppQrSessions({ source: 'test' })

    assert.equal(result.resumed, 1)
    assert.equal(sockets.length, 1)
  })
})

test('resumeWhatsAppQrSessions no abre otra sesión si un lease vigente pertenece a otra instancia', async () => {
  const sockets = []

  await withQrFixture({ status: 'connected' }, async ({ phoneNumberId }) => {
    await db.run(`
      INSERT INTO distributed_locks (name, owner_id, locked_until, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `, [`whatsapp-qr-session:${phoneNumberId}`, 'other-render-instance', sqlFuture()])

    setBaileysRuntimeForTest(createFakeBaileysRuntime(sockets))

    const result = await resumeWhatsAppQrSessions({ source: 'test' })
    const lock = await db.get(
      'SELECT owner_id FROM distributed_locks WHERE name = ?',
      [`whatsapp-qr-session:${phoneNumberId}`]
    )

    assert.equal(result.resumed, 0)
    assert.equal(sockets.length, 0)
    assert.equal(lock.owner_id, 'other-render-instance')
  })
})

test('shutdownWhatsAppQrService libera el lease QR del proceso durante deploy drain', async () => {
  const sockets = []

  await withQrFixture({ status: 'connected' }, async ({ phoneNumberId }) => {
    setBaileysRuntimeForTest(createFakeBaileysRuntime(sockets))

    const result = await resumeWhatsAppQrSessions({ source: 'test' })
    const shutdown = await shutdownWhatsAppQrService({ reason: 'test-shutdown' })
    const lock = await db.get(
      'SELECT owner_id, locked_until <= CURRENT_TIMESTAMP AS expired FROM distributed_locks WHERE name = ?',
      [`whatsapp-qr-session:${phoneNumberId}`]
    )

    assert.equal(result.resumed, 1)
    assert.equal(shutdown.closed, 1)
    assert.equal(shutdown.released, 1)
    assert.equal(Number(lock.expired), 1)
  })
})

test('WhatsApp QR deja la versión en manos de Baileys y usa un navegador lógico para vincular', async () => {
  const sockets = []
  let fetchCalls = 0

  await withQrFixture({ status: 'connected' }, async () => {
    setBaileysRuntimeForTest(createFakeBaileysRuntime(sockets, {
      fetchLatestWaWebVersion: async () => {
        fetchCalls += 1
        return { version: [2, 3000, 1042401057], isLatest: true }
      }
    }))

    const result = await resumeWhatsAppQrSessions({ source: 'test' })

    assert.equal(result.resumed, 1)
    assert.equal(fetchCalls, 0)
    assert.equal(Object.hasOwn(sockets[0].options, 'version'), false)
    assert.deepEqual(sockets[0].options.browser, ['macOS', 'Google Chrome', 'Ristak'])
  })
})

test('WhatsApp QR solicita y persiste el historial completo sin marcarlo como no leído', async () => {
  const sockets = []

  await withQrFixture({ status: 'connected' }, async ({ phoneNumberId }) => {
    const contactPhone = '+526561111222'
    const contactJid = '526561111222@s.whatsapp.net'
    const wamid = `history-${randomUUID()}`
    const reactionWamid = `reaction-${randomUUID()}`
    setBaileysRuntimeForTest(createFakeBaileysRuntime(sockets))

    try {
      const result = await resumeWhatsAppQrSessions({ source: 'history-test' })
      assert.equal(result.resumed, 1)
      assert.equal(sockets.length, 1)
      assert.equal(sockets[0].options.syncFullHistory, true)
      assert.equal(sockets[0].options.shouldSyncHistoryMessage({ syncType: 'FULL' }), true)

      await sockets[0].emit('messaging-history.set', {
        contacts: [{ id: contactJid, notify: 'Cliente Histórico' }],
        messages: [{
          key: { id: wamid, remoteJid: contactJid, fromMe: false },
          messageTimestamp: 1_767_225_600,
          message: { extendedTextMessage: { text: 'Mensaje recuperado del teléfono' } }
        }],
        progress: 100,
        isLatest: true
      })

      const stored = await db.get(`
        SELECT wamid, phone, direction, message_text, transport
        FROM whatsapp_api_messages
        WHERE wamid = ?
      `, [wamid])
      assert.equal(stored.wamid, wamid)
      assert.equal(stored.phone, contactPhone)
      assert.equal(stored.direction, 'inbound')
      assert.equal(stored.message_text, 'Mensaje recuperado del teléfono')
      assert.equal(stored.transport, 'qr')

      const unread = await db.get(
        'SELECT COUNT(*) AS total FROM chat_read_states WHERE contact_id = (SELECT contact_id FROM whatsapp_api_messages WHERE wamid = ?)',
        [wamid]
      )
      assert.equal(Number(unread.total), 0)

      await sockets[0].emit('messages.reaction', [{
        key: { id: wamid, remoteJid: contactJid, fromMe: false },
        reaction: {
          key: { id: reactionWamid, remoteJid: contactJid, fromMe: false },
          text: '🔥',
          senderTimestampMs: 1_767_225_601_000
        }
      }])

      const storedReaction = await db.get(`
        SELECT message_type, message_text, context_json
        FROM whatsapp_api_messages
        WHERE wamid = ?
      `, [reactionWamid])
      assert.equal(storedReaction.message_type, 'reaction')
      assert.equal(storedReaction.message_text, '🔥')
      assert.equal(JSON.parse(storedReaction.context_json).id, wamid)
    } finally {
      await db.run('DELETE FROM whatsapp_api_messages WHERE wamid IN (?, ?)', [wamid, reactionWamid]).catch(() => undefined)
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [contactPhone]).catch(() => undefined)
      await db.run('DELETE FROM contacts WHERE phone = ?', [contactPhone]).catch(() => undefined)
    }
  })
})

test('WHATSAPP_WEB_VERSION permite un override de emergencia sin consultar una versión viva', async () => {
  const sockets = []
  const previousVersion = process.env.WHATSAPP_WEB_VERSION
  let fetchCalls = 0

  process.env.WHATSAPP_WEB_VERSION = '2,3000,1111111111'
  try {
    await withQrFixture({ status: 'connected' }, async () => {
      setBaileysRuntimeForTest(createFakeBaileysRuntime(sockets, {
        fetchLatestWaWebVersion: async () => {
          fetchCalls += 1
          return { version: [2, 3000, 2222222222], isLatest: true }
        }
      }))

      const result = await resumeWhatsAppQrSessions({ source: 'test' })

      assert.equal(result.resumed, 1)
      assert.equal(fetchCalls, 0)
      assert.deepEqual(sockets[0].options.version, [2, 3000, 1111111111])
    })
  } finally {
    if (previousVersion === undefined) delete process.env.WHATSAPP_WEB_VERSION
    else process.env.WHATSAPP_WEB_VERSION = previousVersion
  }
})

test('la validación del número conectado no confunde LID con el teléfono esperado', async () => {
  const sockets = []

  await withQrFixture({ status: 'connected' }, async ({ phoneNumberId }) => {
    setBaileysRuntimeForTest(createFakeBaileysRuntime(sockets, {
      user: {
        id: '123456789@lid',
        lid: '123456789@lid'
      }
    }))

    const result = await resumeWhatsAppQrSessions({ source: 'test' })
    assert.equal(result.resumed, 1)
    assert.equal(sockets.length, 1)

    await sockets[0].emit('connection.update', { connection: 'open' })

    const session = await db.get(
      'SELECT status, connected_phone, last_error FROM whatsapp_qr_sessions WHERE phone_number_id = ?',
      [phoneNumberId]
    )
    assert.equal(session.status, 'connected')
    assert.equal(session.connected_phone, BUSINESS_PHONE)
    assert.equal(session.last_error, null)
  })
})

test('WhatsApp QR captura salientes con remoteJid LID y los muestra en la app de chats', async () => {
  const sockets = []
  const contactId = `contact_qr_lid_outbound_${randomUUID()}`
  const contactPhone = '+526561231234'
  const nationalContactPhone = '6561231234'
  const lid = '111222333444@lid'
  const wamid = `qr_lid_outbound_${randomUUID()}`
  const body = `Respuesta desde WhatsApp normal ${randomUUID()}`
  const messageTimestamp = new Date().toISOString()

  await db.run('DELETE FROM whatsapp_api_messages WHERE wamid = ? OR contact_id = ?', [wamid, contactId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_contacts WHERE contact_id = ? OR phone = ?', [contactId, contactPhone]).catch(() => undefined)
  await db.run('DELETE FROM contact_phone_numbers WHERE contact_id = ? OR phone = ?', [contactId, contactPhone]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ? OR phone IN (?, ?)', [contactId, contactPhone, nationalContactPhone]).catch(() => undefined)

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, full_name, first_name, source, created_at, updated_at)
       VALUES (?, ?, 'Cliente LID WhatsApp', 'Cliente', 'manual', ?, ?)`,
      [contactId, nationalContactPhone, messageTimestamp, messageTimestamp]
    )

    await withQrFixture({ status: 'connected' }, async () => {
      setBaileysRuntimeForTest(createFakeBaileysRuntime(sockets))

      const result = await resumeWhatsAppQrSessions({ source: 'test' })
      assert.equal(result.resumed, 1)
      assert.equal(sockets.length, 1)

      sockets[0].signalRepository = {
        lidMapping: {
          getPNForLID: async (value) => value === lid ? `${contactPhone}@s.whatsapp.net` : ''
        }
      }

      await sockets[0].emit('messages.upsert', {
        type: 'notify',
        messages: [{
          key: {
            id: wamid,
            remoteJid: lid,
            fromMe: true
          },
          message: {
            conversation: body
          },
          messageTimestamp: Math.floor(new Date(messageTimestamp).getTime() / 1000)
        }]
      })
    })

    const row = await db.get(`
      SELECT contact_id, phone, from_phone, to_phone, direction, transport, message_text, business_phone_number_id
      FROM whatsapp_api_messages
      WHERE wamid = ?
    `, [wamid])

    assert.ok(row)
    assert.equal(row.contact_id, contactId)
    assert.equal(row.direction, 'outbound')
    assert.equal(row.transport, 'qr')
    assert.equal(row.message_text, body)
    assert.ok(row.business_phone_number_id)

    const chats = await readChatContacts({ limit: '100' })
    const chat = chats.find(item => item.id === contactId)

    assert.ok(chat)
    assert.equal(chat.lastMessageText, body)
    assert.equal(chat.lastMessageDirection, 'outbound')
    assert.equal(chat.lastBusinessPhoneNumberId, row.business_phone_number_id)
  } finally {
    await db.run('DELETE FROM whatsapp_api_messages WHERE wamid = ? OR contact_id = ?', [wamid, contactId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE contact_id = ? OR phone = ?', [contactId, contactPhone]).catch(() => undefined)
    await db.run('DELETE FROM contact_phone_numbers WHERE contact_id = ? OR phone = ?', [contactId, contactPhone]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ? OR phone IN (?, ?)', [contactId, contactPhone, nationalContactPhone]).catch(() => undefined)
    resetWhatsAppQrServiceForTest()
  }
})

test('WhatsApp QR standalone detecta y guarda el número al escanear', async () => {
  const sockets = []
  const connectedJid = '526568617072@s.whatsapp.net'
  const connectedPhone = '+526568617072'
  const phone = await createWhatsAppQrPhoneNumber({})

  try {
    setBaileysRuntimeForTest(createFakeBaileysRuntime(sockets, {
      user: { id: connectedJid },
      authMe: { id: connectedJid },
      autoOpen: true
    }))

    const session = await startWhatsAppQrConnection({
      phoneNumberId: phone.id,
      acceptedRisk: true,
      acceptedBy: 'test'
    })

    const savedPhone = await db.get(
      'SELECT phone_number, display_phone_number, qr_connected_phone, qr_status FROM whatsapp_api_phone_numbers WHERE id = ?',
      [phone.id]
    )
    const savedSession = await db.get(
      'SELECT expected_phone, connected_phone, status, last_error FROM whatsapp_qr_sessions WHERE phone_number_id = ?',
      [phone.id]
    )

    assert.equal(session.status, 'connected')
    assert.equal(savedPhone.phone_number, connectedPhone)
    assert.equal(savedPhone.display_phone_number, connectedPhone)
    assert.equal(savedPhone.qr_connected_phone, connectedPhone)
    assert.equal(savedPhone.qr_status, 'connected')
    assert.equal(savedSession.expected_phone, connectedPhone)
    assert.equal(savedSession.connected_phone, connectedPhone)
    assert.equal(savedSession.status, 'connected')
    assert.equal(savedSession.last_error, null)
  } finally {
    await cleanupQrFixture(phone.id)
  }
})

test('elimina un número WhatsApp QR standalone y limpia referencias locales', async () => {
  const phone = await createWhatsAppQrPhoneNumber({ phoneNumber: '+526568617073', label: 'QR borrar' })
  const contactId = `contact_qr_delete_${randomUUID()}`
  const scheduledMessageId = `scheduled_qr_delete_${randomUUID()}`

  try {
    await db.run(
      'INSERT INTO contacts (id, phone, full_name, source, preferred_whatsapp_phone_number_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactId, '6568617073', 'Contacto QR delete', 'test', phone.id]
    )
    await db.run(`
      INSERT INTO scheduled_chat_messages (
        id, contact_id, provider, channel, transport, message_text, to_phone, business_phone_number_id, scheduled_at, status
      ) VALUES (?, ?, 'whatsapp_api', 'whatsapp', 'qr', 'Mensaje programado', '+526561110000', ?, ?, 'scheduled')
    `, [scheduledMessageId, contactId, phone.id, sqlFuture()])
    await db.run(
      'INSERT INTO whatsapp_qr_auth_state (phone_number_id, auth_key, value_json, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
      [phone.id, 'creds', '{"registered":true}']
    )
    await setAppConfig('whatsapp_api_phone_number_id', phone.id)
    await setAppConfig('whatsapp_api_sender_phone', '+526568617073')

    const result = await deleteWhatsAppQrPhoneNumber({ phoneNumberId: phone.id })

    const deletedPhone = await db.get('SELECT id FROM whatsapp_api_phone_numbers WHERE id = ?', [phone.id])
    const authState = await db.get('SELECT 1 as present FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phone.id])
    const session = await db.get('SELECT 1 as present FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phone.id])
    const contact = await db.get('SELECT preferred_whatsapp_phone_number_id FROM contacts WHERE id = ?', [contactId])
    const scheduled = await db.get('SELECT business_phone_number_id FROM scheduled_chat_messages WHERE id = ?', [scheduledMessageId])

    assert.equal(result.deleted, 1)
    assert.equal(deletedPhone, null)
    assert.equal(authState, null)
    assert.equal(session, null)
    assert.equal(contact.preferred_whatsapp_phone_number_id, null)
    assert.equal(scheduled.business_phone_number_id, null)
  } finally {
    await db.run('DELETE FROM scheduled_chat_messages WHERE id = ?', [scheduledMessageId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    await cleanupQrFixture(phone.id)
    await setAppConfig('whatsapp_api_phone_number_id', '')
    await setAppConfig('whatsapp_api_sender_phone', '')
  }
})

test('desconecta desde la fila un QR standalone sin tocar el número real de WhatsApp', async () => {
  const phone = await createWhatsAppQrPhoneNumber({ phoneNumber: '+526568617075', label: 'QR fila' })

  try {
    const status = await disconnectWhatsAppPhoneNumber({ phoneNumberId: phone.id, connection: 'qr' })
    const localPhone = await db.get('SELECT id FROM whatsapp_api_phone_numbers WHERE id = ?', [phone.id])

    assert.equal(localPhone, null)
    assert.equal(status.phoneNumbers.some(item => item.id === phone.id), false)
  } finally {
    await cleanupQrFixture(phone.id)
  }
})

test('desconectar el respaldo QR de una fila oficial conserva su conexión API', async () => {
  const phoneNumberId = `phone_ycloud_qr_disconnect_${randomUUID()}`

  try {
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, waba_id, phone_number, display_phone_number, verified_name,
        status, api_send_enabled, qr_send_enabled, qr_status
      ) VALUES (?, 'ycloud', 'waba_qr_disconnect', '+526568617076', '+52 656 861 7076', 'YCloud con QR', 'CONNECTED', 1, 1, 'connected')
    `, [phoneNumberId])

    const status = await disconnectWhatsAppPhoneNumber({ phoneNumberId, connection: 'qr' })
    const localPhone = await db.get(`
      SELECT provider, api_send_enabled, qr_send_enabled, qr_status
      FROM whatsapp_api_phone_numbers
      WHERE id = ?
    `, [phoneNumberId])

    assert.equal(localPhone.provider, 'ycloud')
    assert.equal(Number(localPhone.api_send_enabled), 1)
    assert.equal(Number(localPhone.qr_send_enabled), 0)
    assert.equal(localPhone.qr_status, 'disconnected')
    assert.equal(status.phoneNumbers.some(item => item.id === phoneNumberId), true)
  } finally {
    await cleanupQrFixture(phoneNumberId)
  }
})

test('no elimina números oficiales de YCloud desde el endpoint local de QR', async () => {
  const phoneNumberId = `phone_ycloud_delete_guard_${randomUUID()}`

  try {
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, waba_id, phone_number, display_phone_number, verified_name,
        api_send_enabled, qr_send_enabled, qr_status, status
      ) VALUES (?, 'ycloud', 'waba_guard', '+526568617074', '+52 656 861 7074', 'YCloud guard', 1, 0, 'disconnected', 'CONNECTED')
    `, [phoneNumberId])

    await assert.rejects(
      () => deleteWhatsAppQrPhoneNumber({ phoneNumberId }),
      /sólo desconecta números QR independientes/
    )

    const row = await db.get('SELECT id FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId])
    assert.equal(row.id, phoneNumberId)
  } finally {
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
  }
})

test('cierre 440 de Baileys conserva credenciales y deja la sesión reconectando', async () => {
  const sockets = []

  await withQrFixture({ status: 'connected' }, async ({ phoneNumberId }) => {
    setBaileysRuntimeForTest(createFakeBaileysRuntime(sockets))
    setWhatsAppQrReconnectDelayForTest(60_000)

    const result = await resumeWhatsAppQrSessions({ source: 'test' })
    assert.equal(result.resumed, 1)
    assert.equal(sockets.length, 1)

    await sockets[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: {
          message: 'Stream Errored (conflict)',
          output: {
            statusCode: 440,
            payload: {
              message: 'Stream Errored (conflict)'
            }
          }
        }
      }
    })

    const session = await db.get(
      'SELECT status, last_error FROM whatsapp_qr_sessions WHERE phone_number_id = ?',
      [phoneNumberId]
    )
    const phone = await db.get(
      'SELECT qr_status, qr_last_error FROM whatsapp_api_phone_numbers WHERE id = ?',
      [phoneNumberId]
    )
    const auth = await db.get(
      'SELECT 1 as present FROM whatsapp_qr_auth_state WHERE phone_number_id = ? AND auth_key = ?',
      [phoneNumberId, 'creds']
    )

    assert.equal(session.status, 'reconnecting')
    assert.equal(session.last_error, null)
    assert.equal(phone.qr_status, 'reconnecting')
    assert.equal(phone.qr_last_error, null)
    assert.equal(auth.present, 1)
  })
})

test('tres cierres 428 de una sesión guardada conservan auth y dejan reconexión automática', async () => {
  const sockets = []

  await withQrFixture({ status: 'connected' }, async ({ phoneNumberId }) => {
    // Auth legado: el objeto es válido pero no trae `registered`. La sesión
    // sí tiene teléfono/fecha de conexión, como las filas reales anteriores a
    // Baileys 7, y debe entrar al flujo de reparación tras los 428.
    await db.run(
      'UPDATE whatsapp_qr_auth_state SET value_json = ? WHERE phone_number_id = ? AND auth_key = ?',
      [JSON.stringify({ me: { id: CONNECTED_JID } }), phoneNumberId, 'creds']
    )
    setBaileysRuntimeForTest(createFakeBaileysRuntime(sockets))
    setWhatsAppQrReconnectDelayForTest(0)

    const result = await resumeWhatsAppQrSessions({ source: 'test' })
    assert.equal(result.resumed, 1)
    assert.equal(sockets.length, 1)

    const closedUpdate = {
      connection: 'close',
      lastDisconnect: {
        error: {
          message: 'Connection Closed',
          output: { statusCode: 428 }
        }
      }
    }

    await sockets[0].emit('connection.update', closedUpdate)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(sockets.length, 2)

    await sockets[1].emit('connection.update', closedUpdate)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(sockets.length, 3)

    await sockets[2].emit('connection.update', closedUpdate)

    const session = await db.get(
      'SELECT status, last_error FROM whatsapp_qr_sessions WHERE phone_number_id = ?',
      [phoneNumberId]
    )
    const phone = await db.get(
      'SELECT qr_send_enabled, qr_status FROM whatsapp_api_phone_numbers WHERE id = ?',
      [phoneNumberId]
    )
    const auth = await db.get(
      'SELECT 1 AS present FROM whatsapp_qr_auth_state WHERE phone_number_id = ? AND auth_key = ?',
      [phoneNumberId, 'creds']
    )

    assert.equal(session.status, 'reconnecting')
    assert.equal(session.last_error, null)
    assert.equal(phone.qr_status, 'reconnecting')
    assert.equal(Number(phone.qr_send_enabled), 1)
    assert.equal(auth.present, 1)
  })
})

test('un logout 401 conserva credenciales y solo permite borrarlas mediante una acción explícita', async () => {
  const sockets = []

  await withQrFixture({ status: 'connected' }, async ({ phoneNumberId }) => {
    setBaileysRuntimeForTest(createFakeBaileysRuntime(sockets))

    const result = await resumeWhatsAppQrSessions({ source: 'test' })
    assert.equal(result.resumed, 1)

    await sockets[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: {
          message: 'Logged Out',
          output: { statusCode: 401 }
        }
      }
    })

    const session = await db.get(
      'SELECT status, last_error FROM whatsapp_qr_sessions WHERE phone_number_id = ?',
      [phoneNumberId]
    )
    const phone = await db.get(
      'SELECT qr_send_enabled, qr_status FROM whatsapp_api_phone_numbers WHERE id = ?',
      [phoneNumberId]
    )
    const auth = await db.get(
      'SELECT 1 AS present FROM whatsapp_qr_auth_state WHERE phone_number_id = ? AND auth_key = ?',
      [phoneNumberId, 'creds']
    )

    assert.equal(session.status, 'qr_repair_required')
    assert.match(session.last_error, /conservó las credenciales/i)
    assert.equal(phone.qr_status, 'qr_repair_required')
    assert.equal(Number(phone.qr_send_enabled), 0)
    assert.equal(auth.present, 1)
  })
})

test('badSession reintenta y deja el watchdog listo para recuperar sin borrar credenciales', async () => {
  const sockets = []

  await withQrFixture({ status: 'connected' }, async ({ phoneNumberId }) => {
    setBaileysRuntimeForTest(createFakeBaileysRuntime(sockets))
    setWhatsAppQrReconnectDelayForTest(0)

    const result = await resumeWhatsAppQrSessions({ source: 'test' })
    assert.equal(result.resumed, 1)

    const closedUpdate = {
      connection: 'close',
      lastDisconnect: {
        error: {
          message: 'Bad Session',
          output: { statusCode: 500 }
        }
      }
    }

    for (let index = 0; index < 3; index += 1) {
      while (sockets.length <= index) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      await sockets[index].emit('connection.update', closedUpdate)
    }

    const session = await db.get(
      'SELECT status, last_error FROM whatsapp_qr_sessions WHERE phone_number_id = ?',
      [phoneNumberId]
    )
    const phone = await db.get(
      'SELECT qr_send_enabled, qr_status FROM whatsapp_api_phone_numbers WHERE id = ?',
      [phoneNumberId]
    )
    const auth = await db.get(
      'SELECT 1 AS present FROM whatsapp_qr_auth_state WHERE phone_number_id = ? AND auth_key = ?',
      [phoneNumberId, 'creds']
    )

    assert.equal(sockets.length, 3)
    assert.equal(session.status, 'reconnecting')
    assert.equal(session.last_error, null)
    assert.equal(phone.qr_status, 'reconnecting')
    assert.equal(Number(phone.qr_send_enabled), 1)
    assert.equal(auth.present, 1)
  })
})

test('regenerar QR borra solo el auth rechazado y no vuelve a usar credenciales viejas', async () => {
  const sockets = []

  await withQrFixture({ status: 'qr_repair_required' }, async ({ phoneNumberId }) => {
    setBaileysRuntimeForTest(createFakeBaileysRuntime(sockets, {
      autoOpen: true,
      authRegistered: false
    }))

    const session = await startWhatsAppQrConnection({
      phoneNumberId,
      acceptedRisk: true,
      acceptedBy: 'test'
    })

    assert.equal(sockets.length, 1)
    assert.equal(sockets[0].options.auth.creds.registered, false)
    assert.equal(session.status, 'connected')
  })
})

test('un QR fresco conserva ese estado durante los reintentos 428 y no hereda la sesión anterior', async () => {
  const sockets = []

  await withQrFixture({ status: 'qr_repair_required' }, async ({ phoneNumberId }) => {
    setBaileysRuntimeForTest(createFakeBaileysRuntime(sockets, { authRegistered: false }))
    setWhatsAppQrReconnectDelayForTest(0)

    const starting = startWhatsAppQrConnection({
      phoneNumberId,
      acceptedRisk: true,
      acceptedBy: 'test'
    })

    while (sockets.length < 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    const closedUpdate = {
      connection: 'close',
      lastDisconnect: {
        error: {
          message: 'Connection Closed',
          output: { statusCode: 428 }
        }
      }
    }

    await sockets[0].emit('connection.update', closedUpdate)
    const initialSession = await starting
    assert.equal(initialSession.status, 'reconnecting')

    for (let index = 1; index <= 2; index += 1) {
      while (sockets.length <= index) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      await sockets[index].emit('connection.update', closedUpdate)
    }

    while (sockets.length < 4) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    const session = await db.get(
      'SELECT status, last_error FROM whatsapp_qr_sessions WHERE phone_number_id = ?',
      [phoneNumberId]
    )
    const auth = await db.get(
      'SELECT 1 AS present FROM whatsapp_qr_auth_state WHERE phone_number_id = ? AND auth_key = ?',
      [phoneNumberId, 'creds']
    )

    assert.equal(session.status, 'reconnecting')
    assert.equal(session.last_error, null)
    assert.equal(auth, null)
  })
})

test('pedir QR durante el backoff cancela la espera y genera el siguiente código de inmediato', async () => {
  const sockets = []

  await withQrFixture({ status: 'qr_repair_required' }, async ({ phoneNumberId }) => {
    setBaileysRuntimeForTest(createFakeBaileysRuntime(sockets, { authRegistered: false }))
    setWhatsAppQrReconnectDelayForTest(60_000)

    const firstStart = startWhatsAppQrConnection({
      phoneNumberId,
      acceptedRisk: true,
      acceptedBy: 'test'
    })

    while (sockets.length < 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    await sockets[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: {
          message: 'Connection Closed',
          output: { statusCode: 428 }
        }
      }
    })

    const firstSession = await firstStart
    assert.equal(firstSession.status, 'reconnecting')
    assert.equal(sockets.length, 1)

    const manualRestart = startWhatsAppQrConnection({
      phoneNumberId,
      acceptedRisk: true,
      acceptedBy: 'test'
    })

    while (sockets.length < 2) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    await sockets[1].emit('connection.update', { qr: 'manual-retry-qr' })
    const restartedSession = await manualRestart

    assert.equal(sockets.length, 2)
    assert.equal(restartedSession.status, 'qr_pending')
    assert.match(restartedSession.qrCodeDataUrl, /^data:image\/png;base64,/)
  })
})

test('volver a conectar un QR sano no reemplaza ni cierra su socket vivo', async () => {
  const sockets = []

  await withQrFixture({ status: 'connected' }, async ({ phoneNumberId }) => {
    setBaileysRuntimeForTest(createFakeBaileysRuntime(sockets))

    const result = await resumeWhatsAppQrSessions({ source: 'test' })
    assert.equal(result.resumed, 1)
    assert.equal(sockets.length, 1)

    await sockets[0].emit('connection.update', { connection: 'open' })
    const session = await startWhatsAppQrConnection({ phoneNumberId, acceptedRisk: true })

    assert.equal(sockets.length, 1)
    assert.equal(sockets[0].closed, false)
    assert.equal(session.status, 'connected')
  })
})
