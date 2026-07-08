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
import { createWhatsAppQrPhoneNumber, deleteWhatsAppQrPhoneNumber } from '../src/services/whatsappApiService.js'

const BUSINESS_PHONE = '+526561234567'
const CONNECTED_JID = '526561234567@s.whatsapp.net'
const DEFAULT_FAKE_WA_WEB_VERSION = [2, 3000, 1035194821]

function sqlFuture(offsetMs = 60_000) {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ')
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

test('WhatsApp QR usa la versión viva de WhatsApp Web al crear el socket', async () => {
  const sockets = []
  const latestVersion = [2, 3000, 1042401057]
  let fetchCalls = 0

  await withQrFixture({ status: 'connected' }, async () => {
    setBaileysRuntimeForTest(createFakeBaileysRuntime(sockets, {
      fetchLatestWaWebVersion: async (options = {}) => {
        fetchCalls += 1
        assert.ok(options.signal)
        return { version: latestVersion, isLatest: true }
      }
    }))

    const result = await resumeWhatsAppQrSessions({ source: 'test' })

    assert.equal(result.resumed, 1)
    assert.equal(fetchCalls, 1)
    assert.deepEqual(sockets[0].options.version, latestVersion)
  })
})

test('WHATSAPP_WEB_VERSION tiene prioridad sobre la consulta viva', async () => {
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
      /Solo puedes eliminar números conectados por QR/
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
