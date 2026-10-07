import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { databaseReady, db, setAppConfig } from '../src/config/database.js'
import { captureQrChatMessage, getWhatsAppApiConfigKeys } from '../src/services/whatsappApiService.js'
import {
  QR_CONSENT_TEXT,
  prepareWhatsAppQrTextDelivery,
  resetWhatsAppQrServiceForTest,
  sendWhatsAppQrTextMessage,
  setBaileysRuntimeForTest
} from '../src/services/whatsappQrService.js'
import { buildConversationalAgentMessageMetadata } from '../src/utils/conversationalAgentMessageMetadata.js'

const BUSINESS_PHONE = '+526561234567'
const CONTACT_PHONE = '+526569998888'
const BUSINESS_JID = '526561234567@s.whatsapp.net'
const CONTACT_JID = '526569998888@s.whatsapp.net'
const MESSAGE_AT = '2026-10-07T19:00:00.000Z'

async function fixture(t) {
  await databaseReady
  const id = randomUUID()
  const contactId = `rstk_contact_qr_takeover_${id}`
  const agentId = `cagent_qr_takeover_${id}`
  const phoneNumberId = `phone_qr_takeover_${id}`
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]
  const placeholders = configKeys.map(() => '?').join(', ')
  const previousConfig = await db.all(`SELECT * FROM app_config WHERE config_key IN (${placeholders})`, configKeys)
  await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, configKeys)
  await setAppConfig(keys.enabled, '0')
  await db.run('INSERT INTO contacts (id, full_name, phone) VALUES (?, ?, ?)', [contactId, 'QR takeover test', CONTACT_PHONE])
  // No real provider/model is used: the state is active but this fixture cannot
  // launch an AI reply or send a message outside its in-memory socket.
  await db.run('INSERT INTO conversational_agents (id, name, enabled) VALUES (?, ?, 0)', [agentId, 'QR takeover agent'])
  await db.run(`INSERT INTO conversational_agent_state (contact_id, agent_id, status, channel)
    VALUES (?, ?, 'active', 'whatsapp')`, [contactId, agentId])
  await db.run(`INSERT INTO whatsapp_api_phone_numbers (
    id, provider, phone_number, display_phone_number, is_default_sender,
    api_send_enabled, qr_send_enabled, qr_status, qr_connected_phone, status
  ) VALUES (?, 'qr', ?, ?, 1, 0, 1, 'connected', ?, 'CONNECTED')`, [phoneNumberId, BUSINESS_PHONE, BUSINESS_PHONE, BUSINESS_PHONE])

  t.after(async () => {
    resetWhatsAppQrServiceForTest()
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM conversational_agent_manual_assignments WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId])
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM whatsapp_api_contacts WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`])
    await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId])
    await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId])
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId])
    await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, configKeys)
    for (const row of previousConfig) {
      await setAppConfig(row.config_key, row.config_value)
    }
  })

  const capture = (overrides = {}) => captureQrChatMessage({
    phoneNumberId, businessPhone: BUSINESS_PHONE, direction: 'outbound',
    wamid: `qr_takeover_${randomUUID()}`, contactPhone: CONTACT_PHONE,
    text: 'Te atiendo personalmente', timestamp: MESSAGE_AT, ...overrides
  })
  const status = async () => (await db.get(
    'SELECT status FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?', [contactId, agentId]
  ))?.status
  return { contactId, agentId, phoneNumberId, capture, status }
}

test('una respuesta nueva desde WhatsApp toma el mando y el robot deja de responder', async t => {
  const { capture, status, contactId } = await fixture(t)
  const result = await capture()
  assert.equal(result.isNew, true)
  assert.equal(await status(), 'human')
  const event = await db.get(`SELECT event_type FROM conversational_agent_events
    WHERE contact_id = ? AND event_type = 'status_changed'`, [contactId])
  assert.ok(event, 'la toma humana debe quedar registrada')
})

test('una respuesta humana con archivo detiene al robot antes de esperar su descarga', async t => {
  const { capture, status } = await fixture(t)
  const result = await capture({ messageType: 'image', text: '', resolveInboundMedia: async () => {
    assert.equal(await status(), 'human', 'una descarga lenta no debe dejar al robot contestando')
    return { mediaUrl: 'https://cdn.example.com/qr-takeover.jpg', mediaMimeType: 'image/jpeg' }
  } })
  assert.equal(result.mediaUrl, 'https://cdn.example.com/qr-takeover.jpg')
  assert.equal(await status(), 'human')
})

test('importar historial o repetir un mensaje antiguo no toma el mando después de reactivar el robot', async t => {
  const { capture, status } = await fixture(t)
  const wamid = `qr_history_${randomUUID()}`
  await capture({ wamid, historyImport: true })
  assert.equal(await status(), 'active')
  const duplicate = await capture({ wamid })
  assert.equal(duplicate.isNew, false)
  assert.equal(await status(), 'active')
})

test('los envíos identificados como propios de Ristak no provocan una toma humana', async t => {
  const { capture, status } = await fixture(t)
  await capture({ sentFromRistak: true, text: 'Recordatorio automático' })
  assert.equal(await status(), 'active')
})

test('la copia QR conserva la autoría del robot aunque complete una fila de estado', async t => {
  const { capture, status, contactId, agentId, phoneNumberId } = await fixture(t)
  const wamid = `qr_agent_status_${randomUUID()}`
  await db.run(`INSERT INTO whatsapp_api_messages (
    id, wamid, contact_id, phone, business_phone, business_phone_number_id,
    direction, message_type, transport, raw_payload_json
  ) VALUES (?, ?, ?, ?, ?, ?, 'outbound', 'status', 'qr', ?)`, [
    `qr_status_${randomUUID()}`, wamid, contactId, CONTACT_PHONE, BUSINESS_PHONE,
    phoneNumberId, JSON.stringify(buildConversationalAgentMessageMetadata(agentId))
  ])
  const result = await capture({ wamid, text: 'Respuesta del robot' })
  assert.equal(result.isNew, true, 'el contenido puede llegar después del estado de entrega')
  assert.equal(await status(), 'active')
})

test('la toma desde WhatsApp respeta los estados pausados y terminales', async t => {
  const { capture, status, contactId } = await fixture(t)
  for (const original of ['paused', 'skipped', 'completed', 'discarded']) {
    await db.run('UPDATE conversational_agent_state SET status = ? WHERE contact_id = ?', [original, contactId])
    await capture()
    assert.equal(await status(), original)
  }
})

test('un eco propio que llega antes de terminar el envío no detiene al robot; un mensaje del teléfono sí', async t => {
  const { status, phoneNumberId } = await fixture(t)
  await db.run(`INSERT INTO whatsapp_qr_sessions (
    id, phone_number_id, expected_phone, connected_phone, status, consent_accepted,
    consent_text, consent_accepted_at, last_connected_at
  ) VALUES (?, ?, ?, ?, 'connected', 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
    `qr_${phoneNumberId}`, phoneNumberId, BUSINESS_PHONE, BUSINESS_PHONE, QR_CONSENT_TEXT
  ])
  await db.run(`INSERT INTO whatsapp_qr_auth_state (phone_number_id, auth_key, value_json)
    VALUES (?, 'creds', ?)`, [phoneNumberId, JSON.stringify({ me: { id: BUSINESS_JID }, registered: true })])

  const listeners = new Map()
  const emit = async (event, payload) => {
    for (const handler of listeners.get(event) || []) await handler(payload)
  }
  const echo = (id, text) => emit('messages.upsert', {
    type: 'notify', messages: [{ key: { id, remoteJid: CONTACT_JID, fromMe: true },
      message: { conversation: text }, messageTimestamp: 1791399600 }]
  })
  let generatedId = ''
  setBaileysRuntimeForTest({
    BufferJSON: { replacer: (_key, value) => value, reviver: (_key, value) => value },
    initAuthCreds: () => ({ me: { id: BUSINESS_JID }, registered: true }),
    makeCacheableSignalKeyStore: keys => keys,
    generateMessageIDV2: () => { generatedId = `qr_own_${randomUUID()}`; return generatedId },
    makeWASocket: () => {
      const sock = {
        user: { id: BUSINESS_JID }, ws: { close() {} },
        ev: {
          on: (event, handler) => listeners.set(event, [...(listeners.get(event) || []), handler]),
          removeAllListeners: event => event ? listeners.delete(event) : listeners.clear()
        },
        onWhatsApp: async () => [{ exists: true, jid: CONTACT_JID }],
        sendMessage: async (jid, payload, options) => {
          assert.equal(options.messageId, generatedId)
          await echo(options.messageId, payload.text)
          assert.equal(await status(), 'active', 'el eco no debe adelantarse a la clasificación del envío')
          return { key: { id: options.messageId, remoteJid: jid, fromMe: true }, message: payload }
        }
      }
      queueMicrotask(() => { void emit('connection.update', { connection: 'open' }) })
      return sock
    }
  })

  await prepareWhatsAppQrTextDelivery({ phoneNumberId })
  await sendWhatsAppQrTextMessage({ phoneNumberId, to: CONTACT_PHONE, text: 'Mensaje automático', skipQrSendProtection: true })
  assert.equal(await status(), 'active')
  await echo(`qr_phone_${randomUUID()}`, 'Yo sigo la conversación')
  assert.equal(await status(), 'human')
})
