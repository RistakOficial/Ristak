import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db, setAppConfig } from '../src/config/database.js'
import {
  getWhatsAppApiConfigKeys
} from '../src/services/whatsappApiService.js'
import {
  QR_CONSENT_TEXT,
  resetWhatsAppQrServiceForTest,
  resumeWhatsAppQrSessions,
  setBaileysRuntimeForTest
} from '../src/services/whatsappQrService.js'

const BUSINESS_PHONE = '+526561234567'
const CONNECTED_JID = '526561234567@s.whatsapp.net'
const DEFAULT_FAKE_WA_WEB_VERSION = [2, 3000, 1035194821]

function normalizeDigits(value = '') {
  return String(value || '').replace(/\D/g, '')
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createFakeBaileysRuntime(sockets = []) {
  return {
    DisconnectReason: {
      loggedOut: 401,
      badSession: 500,
      connectionReplaced: 440,
      restartRequired: 515
    },
    DEFAULT_CONNECTION_CONFIG: {
      version: DEFAULT_FAKE_WA_WEB_VERSION
    },
    defaultConnectionVersion: DEFAULT_FAKE_WA_WEB_VERSION,
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
    makeWASocket: () => {
      const listeners = new Map()
      const emit = async (eventName, payload) => {
        for (const handler of listeners.get(eventName) || []) {
          await handler(payload)
        }
      }
      const sock = {
        user: { id: CONNECTED_JID },
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
        emit
      }

      sockets.push(sock)
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

async function cleanupQrFixture({ phoneNumberId, contactPhone, wamid } = {}) {
  resetWhatsAppQrServiceForTest()
  await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_messages WHERE wamid = ? OR phone = ?', [wamid, contactPhone]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [normalizeDigits(contactPhone)]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE phone = ?', [normalizeDigits(contactPhone)]).catch(() => undefined)
}

async function withQrFixture(callback) {
  const phoneNumberId = `phone_qr_template_${randomUUID()}`
  const contactPhone = `+52155${Date.now().toString().slice(-8)}`
  const wamid = `qr_template_${randomUUID()}`
  const sockets = []
  const keys = getWhatsAppApiConfigKeys()
  await cleanupQrFixture({ phoneNumberId, contactPhone, wamid })

  return snapshotAppConfig([keys.enabled, keys.apiKey], async () => {
    try {
      await setAppConfig(keys.enabled, '0')
      await setAppConfig(keys.apiKey, '')
      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
        ) VALUES (?, 'qr', 'waba_qr_template_test', ?, ?, 'QR Template Test', 1, 0, 1, 'connected', 'CONNECTED')
      `, [phoneNumberId, BUSINESS_PHONE, BUSINESS_PHONE])

      await db.run(`
        INSERT INTO whatsapp_qr_sessions (
          id, phone_number_id, expected_phone, connected_phone, status,
          consent_accepted, consent_text, consent_accepted_at, last_connected_at,
          updated_at
        ) VALUES (?, ?, ?, ?, 'connected', 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        `qr_${phoneNumberId}`,
        phoneNumberId,
        BUSINESS_PHONE,
        BUSINESS_PHONE,
        QR_CONSENT_TEXT
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

      setBaileysRuntimeForTest(createFakeBaileysRuntime(sockets))
      const result = await resumeWhatsAppQrSessions({ source: 'test' })
      assert.equal(result.resumed, 1)
      assert.equal(sockets.length, 1)

      return await callback({ phoneNumberId, contactPhone, wamid, socket: sockets[0] })
    } finally {
      await cleanupQrFixture({ phoneNumberId, contactPhone, wamid })
    }
  })
}

async function waitForStoredQrMessage(wamid) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const row = await db.get(
      `SELECT transport, direction, message_type, message_text
       FROM whatsapp_api_messages
       WHERE wamid = ?
       LIMIT 1`,
      [wamid]
    )
    if (row) return row
    await sleep(25)
  }
  return null
}

test('captura texto y botones de plantillas recibidas por WhatsApp QR', async () => {
  await withQrFixture(async ({ contactPhone, wamid, socket }) => {
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [{
        key: {
          id: wamid,
          remoteJid: `${normalizeDigits(contactPhone)}@s.whatsapp.net`,
          fromMe: false
        },
        pushName: 'Facebook',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          templateMessage: {
            hydratedTemplate: {
              hydratedTitleText: 'hydratedTitleText',
              hydratedContentText: 'Use 096984 for two-factor authentication on Facebook.',
              hydratedFooterText: 'hydratedFooterText',
              hydratedButtons: [
                { quickReplyButton: { displayText: 'Copy code', id: 'copy_code' } },
                { quickReplyButton: { displayText: "I didn't request a code", id: 'not_me_1' } },
                { quickReplyButton: { displayText: "I didn't request a code", id: 'not_me_2' } }
              ]
            }
          }
        }
      }]
    })

    const row = await waitForStoredQrMessage(wamid)

    assert.ok(row)
    assert.equal(row.transport, 'qr')
    assert.equal(row.direction, 'inbound')
    assert.equal(row.message_type, 'template')
    assert.equal(
      row.message_text,
      "Use 096984 for two-factor authentication on Facebook.\n\n- Copy code\n- I didn't request a code\n- I didn't request a code"
    )
    assert.notEqual(row.message_text, 'Mensaje')
  })
})
