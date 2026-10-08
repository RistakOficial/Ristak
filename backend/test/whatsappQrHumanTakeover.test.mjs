import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { databaseReady, db, setAppConfig } from '../src/config/database.js'
import {
  captureQrChatMessage, getWhatsAppApiConfigKeys,
  processMetaDirectWebhookPayload, processYCloudWhatsAppWebhook
} from '../src/services/whatsappApiService.js'
import {
  expirePausedConversationStates, getConversationState,
  pauseConversationForExternalWhatsAppReply, setConversationStatus, assignAgentToContactManually
} from '../src/services/conversationalAgentService.js'
import { resolveInboundAgentForContact } from '../src/agents/conversational/runner.js'
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
const DAY_MS = 24 * 60 * 60 * 1000

function metaEcho(phoneNumberId, id, timestamp = Math.floor(Date.now() / 1000)) {
  return { object: 'whatsapp_business_account', entry: [{ id: 'waba_takeover_test', changes: [{
    field: 'smb_message_echoes', value: {
      metadata: { phone_number_id: phoneNumberId, display_phone_number: BUSINESS_PHONE },
      smb_message_echoes: [{ id, to: CONTACT_PHONE, timestamp: String(timestamp),
        type: 'text', text: { body: 'Te atiendo personalmente' } }]
    }
  }] }] }
}

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
    text: 'Te atiendo personalmente', timestamp: new Date().toISOString(), ...overrides
  })
  const status = async () => (await db.get(
    'SELECT status FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?', [contactId, agentId]
  ))?.status
  return { contactId, agentId, phoneNumberId, capture, status }
}

test('una respuesta nueva desde WhatsApp pausa al robot 24 horas y registra el plazo UTC', async t => {
  const { capture, status, contactId } = await fixture(t)
  const repliedAt = new Date().toISOString()
  const result = await capture({ timestamp: repliedAt })
  assert.equal(result.isNew, true)
  assert.equal(await status(), 'paused')
  const state = await db.get('SELECT paused_until_at, updated_by FROM conversational_agent_state WHERE contact_id = ?', [contactId])
  assert.equal(Date.parse(state.paused_until_at) - Date.parse(repliedAt), DAY_MS)
  assert.equal(state.updated_by, 'whatsapp_business')
  const event = await db.get(`SELECT detail_json FROM conversational_agent_events
    WHERE contact_id = ? AND event_type = 'status_changed'`, [contactId])
  assert.equal(JSON.parse(event.detail_json).reason, 'external_whatsapp_reply')
})

test('durante la pausa externa ningún otro agente automático toma WhatsApp; otro canal y el vencimiento siguen funcionando', async t => {
  const { capture, contactId, agentId } = await fixture(t)
  const otherAgentId = `cagent_qr_alternative_${randomUUID()}`
  t.after(() => db.run('DELETE FROM conversational_agents WHERE id = ?', [otherAgentId]))
  await db.run('UPDATE conversational_agents SET enabled = 1 WHERE id = ?', [agentId])
  await db.run('INSERT INTO conversational_agents (id, name, enabled) VALUES (?, ?, 1)', [otherAgentId, 'Automatic alternative'])
  await assignAgentToContactManually(contactId, agentId, { channel: 'whatsapp' })
  await db.run(`INSERT INTO conversational_agent_state (contact_id, agent_id, status, channel, assignment_source)
    VALUES (?, ?, 'active', 'instagram', 'manual')`, [contactId, agentId])
  await capture()

  const ruleContext = { contact: { id: contactId }, channel: 'whatsapp' }
  const paused = await resolveInboundAgentForContact({ contactId, channel: 'whatsapp', ruleContext })
  assert.equal(paused.agentConfig, null, 'la pausa del chat no debe dejar que entre un robot alternativo')
  assert.equal(paused.state.status, 'paused')
  const alternateState = await db.get('SELECT id FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?', [contactId, otherAgentId])
  assert.equal(Boolean(alternateState), false)

  const instagram = await resolveInboundAgentForContact({ contactId, channel: 'instagram', ruleContext: { ...ruleContext, channel: 'instagram' } })
  assert.equal(instagram.agentConfig?.id, agentId)
  assert.equal(instagram.state.status, 'active')

  const row = await db.get('SELECT paused_until_at FROM conversational_agent_state WHERE contact_id = ? AND channel = ?', [contactId, 'whatsapp'])
  await expirePausedConversationStates({ nowIso: new Date(Date.parse(row.paused_until_at) + 1).toISOString() })
  const resumed = await resolveInboundAgentForContact({ contactId, channel: 'whatsapp', ruleContext })
  assert.equal(resumed.agentConfig?.id, agentId)
  assert.equal(resumed.state.status, 'active')
})

test('una respuesta humana con archivo detiene al robot antes de esperar su descarga', async t => {
  const { capture, status } = await fixture(t)
  const result = await capture({ messageType: 'image', text: '', resolveInboundMedia: async () => {
    assert.equal(await status(), 'paused', 'una descarga lenta no debe dejar al robot contestando')
    return { mediaUrl: 'https://cdn.example.com/qr-takeover.jpg', mediaMimeType: 'image/jpeg' }
  } })
  assert.equal(result.mediaUrl, 'https://cdn.example.com/qr-takeover.jpg')
  assert.equal(await status(), 'paused')
})

test('cada respuesta humana nueva renueva su pausa; duplicados o mensajes fuera de orden no mueven el plazo', async t => {
  const { capture, status, contactId, agentId } = await fixture(t)
  const firstAt = new Date(Date.now() - 60_000).toISOString()
  const lastAt = new Date().toISOString()
  const wamid = `qr_renew_${randomUUID()}`
  await capture({ timestamp: firstAt })
  await capture({ wamid, timestamp: lastAt })
  const state = await getConversationState(contactId, { agentId, channel: 'whatsapp' })
  assert.equal(Date.parse(state.pausedUntilAt), Date.parse(lastAt) + DAY_MS)
  await capture({ timestamp: firstAt })
  await capture({ wamid, timestamp: new Date(Date.now() + 60_000).toISOString() })
  assert.equal((await getConversationState(contactId, { agentId })).pausedUntilAt, state.pausedUntilAt)
  await setConversationStatus(contactId, 'active', { updatedBy: 'user', agentId, channel: 'whatsapp' })
  await capture({ wamid })
  assert.equal(await status(), 'active', 'un eco duplicado no cancela una reactivación explícita')
})

test('la pausa externa se reactiva al vencer incluso después de reconstruir el estado desde la base', async t => {
  const { capture, status, contactId, agentId } = await fixture(t)
  await capture()
  const state = await getConversationState(contactId, { agentId })
  await expirePausedConversationStates({ nowIso: new Date(Date.parse(state.pausedUntilAt) - 1).toISOString() })
  assert.equal(await status(), 'paused')
  await expirePausedConversationStates({ nowIso: state.pausedUntilAt })
  assert.equal(await status(), 'active')
  assert.equal((await getConversationState(contactId, { agentId })).pausedUntilAt, null)
  const event = await db.get("SELECT detail_json FROM conversational_agent_events WHERE contact_id = ? AND detail_json LIKE '%pause_expired%'", [contactId])
  assert.equal(JSON.parse(event.detail_json).reason, 'pause_expired')
})

test('una respuesta externa respeta otras redes, las pausas manuales y los chats sin agente', async t => {
  const { capture, contactId, agentId } = await fixture(t)
  await db.run("INSERT INTO conversational_agent_state (contact_id, agent_id, status, channel) VALUES (?, ?, 'active', 'instagram')", [contactId, agentId])
  await capture()
  const instagram = await getConversationState(contactId, { agentId, channel: 'instagram' })
  assert.equal(instagram.status, 'active')
  const manualDeadline = new Date(Date.now() + 60_000).toISOString()
  await setConversationStatus(contactId, 'paused', { updatedBy: 'user', agentId, channel: 'whatsapp', pausedUntilAt: manualDeadline })
  await capture()
  const manual = await getConversationState(contactId, { agentId, channel: 'whatsapp' })
  assert.equal(manual.pausedUntilAt, manualDeadline)
  assert.equal(manual.updatedBy, 'user')
  await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId])
  await capture()
  assert.equal(await getConversationState(contactId), null)
})

test('el plazo interpreta timestamps SQL como UTC y no reactiva mensajes de más de 24 horas', async t => {
  const { contactId, agentId, status } = await fixture(t)
  const at = new Date(Date.now() - 60_000).toISOString().replace('T', ' ').replace('Z', '')
  await pauseConversationForExternalWhatsAppReply(contactId, { messageAt: at })
  const state = await getConversationState(contactId, { agentId })
  assert.equal(Date.parse(state.pausedUntilAt), Date.parse(`${at.replace(' ', 'T')}Z`) + DAY_MS)
  await setConversationStatus(contactId, 'active', { updatedBy: 'user', agentId, channel: 'whatsapp' })
  await pauseConversationForExternalWhatsAppReply(contactId, { messageAt: new Date(Date.now() - DAY_MS - 1).toISOString() })
  assert.equal(await status(), 'active')
})

test('dos capturas concurrentes del mismo instante registran una sola pausa', async t => {
  const { contactId, agentId } = await fixture(t)
  const messageAt = new Date().toISOString()
  await Promise.all([
    pauseConversationForExternalWhatsAppReply(contactId, { messageAt }),
    pauseConversationForExternalWhatsAppReply(contactId, { messageAt })
  ])
  const state = await getConversationState(contactId, { agentId })
  assert.equal(state.status, 'paused')
  const events = await db.all("SELECT id FROM conversational_agent_events WHERE contact_id = ? AND detail_json LIKE '%external_whatsapp_reply%'", [contactId])
  assert.equal(events.length, 1)
})

test('los ecos nuevos de Meta directo y YCloud también pausan al robot, pero su historial no lo hace', async t => {
  const { contactId, agentId, phoneNumberId, status } = await fixture(t)
  await db.run("UPDATE whatsapp_api_phone_numbers SET provider = 'meta_direct', api_send_enabled = 1 WHERE id = ?", [phoneNumberId])
  const [meta] = await processMetaDirectWebhookPayload({ payload: metaEcho(phoneNumberId, `wamid.meta_${randomUUID()}`) })
  assert.equal(meta.businessEcho, true)
  assert.equal(await status(), 'paused')
  await setConversationStatus(contactId, 'active', { updatedBy: 'user', agentId, channel: 'whatsapp' })
  await db.run("UPDATE whatsapp_api_phone_numbers SET provider = 'ycloud' WHERE id = ?", [phoneNumberId])
  const payload = { id: `echo_event_${randomUUID()}`, type: 'whatsapp.smb.message.echoes', createTime: new Date().toISOString(),
    whatsappMessage: { id: `ycloud_echo_${randomUUID()}`, wamid: `wamid.ycloud_${randomUUID()}`,
      from: BUSINESS_PHONE, to: CONTACT_PHONE, phoneNumberId, type: 'text', text: { body: 'Te atiendo personalmente' } } }
  const historyPayload = { ...payload, id: `history_event_${randomUUID()}`, type: 'whatsapp.smb.history',
    whatsappMessage: { ...payload.whatsappMessage, id: `history_${randomUUID()}`, wamid: `history_wamid_${randomUUID()}` } }
  t.after(() => db.run('DELETE FROM whatsapp_api_webhook_events WHERE id IN (?, ?)', [payload.id, historyPayload.id]))
  await processYCloudWhatsAppWebhook({ payload, rawBody: JSON.stringify(payload) })
  assert.equal(await status(), 'paused')
  await setConversationStatus(contactId, 'active', { updatedBy: 'user', agentId, channel: 'whatsapp' })
  await processYCloudWhatsAppWebhook({ payload: historyPayload, rawBody: JSON.stringify(historyPayload) })
  assert.equal(await status(), 'active')
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
  for (const original of ['paused', 'human', 'skipped', 'completed', 'discarded']) {
    await db.run('UPDATE conversational_agent_state SET status = ? WHERE contact_id = ?', [original, contactId])
    await capture()
    assert.equal(await status(), original)
  }
})

test('un eco propio que llega antes de terminar el envío no detiene al robot; un mensaje del teléfono sí', async t => {
  const { status, phoneNumberId } = await fixture(t)
  const officialPhoneId = `phone_meta_echo_${randomUUID()}`
  await db.run(`INSERT INTO whatsapp_api_phone_numbers (id, provider, phone_number, display_phone_number,
    api_send_enabled, status) VALUES (?, 'meta_direct', ?, ?, 1, 'CONNECTED')`, [officialPhoneId, BUSINESS_PHONE, BUSINESS_PHONE])
  t.after(() => db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [officialPhoneId]))
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
      message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000) }]
  })
  let generatedId = ''
  setBaileysRuntimeForTest({
    BufferJSON: { replacer: (_key, value) => value, reviver: (_key, value) => value },
    initAuthCreds: () => ({ me: { id: BUSINESS_JID }, registered: true }),
    makeCacheableSignalKeyStore: keys => keys,
    generateMessageIDV2: () => { generatedId = `3EB0${randomUUID().replaceAll('-', '').toUpperCase()}`; return generatedId },
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
          const officialWamid = `wamid.${Buffer.from(`HBgL${options.messageId}`).toString('base64url')}`
          await processMetaDirectWebhookPayload({ payload: metaEcho(officialPhoneId, officialWamid) })
          assert.equal(await status(), 'active', 'el eco oficial del mismo envío QR tampoco debe pausarlo')
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
  assert.equal(await status(), 'paused')
})
