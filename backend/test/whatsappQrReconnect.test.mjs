import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import {
  QR_CONSENT_TEXT,
  resetWhatsAppQrServiceForTest,
  resumeWhatsAppQrSessions,
  setBaileysRuntimeForTest,
  setWhatsAppQrReconnectDelayForTest
} from '../src/services/whatsappQrService.js'

const BUSINESS_PHONE = '+526561234567'
const CONNECTED_JID = '526561234567@s.whatsapp.net'

function sqlFuture(offsetMs = 60_000) {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ')
}

function createFakeBaileysRuntime(sockets = []) {
  const DisconnectReason = {
    connectionClosed: 428,
    connectionLost: 408,
    connectionReplaced: 440,
    timedOut: 408,
    loggedOut: 401,
    badSession: 500,
    restartRequired: 515
  }

  return {
    DisconnectReason,
    BufferJSON: {
      replacer: (_key, value) => value,
      reviver: (_key, value) => value
    },
    Browsers: {
      macOS: (name) => ['macOS', name, 'Ristak']
    },
    initAuthCreds: () => ({
      me: { id: CONNECTED_JID },
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
    makeWASocket: (options) => {
      const listeners = new Map()
      const sock = {
        options,
        user: { id: CONNECTED_JID },
        closed: false,
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
