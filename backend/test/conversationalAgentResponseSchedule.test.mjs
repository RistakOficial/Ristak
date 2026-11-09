import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { databaseReady, db } from '../src/config/database.js'
import { runVersionedMigrations } from '../src/startup/runMigrations.js'
import { invalidateTimezoneCache } from '../src/utils/dateUtils.js'
import {
  isAgentResponseScheduleOpenAt,
  normalizeAgentResponseSchedule,
  parseStoredAgentResponseSchedule
} from '../src/utils/conversationalAgentResponseSchedule.js'
import {
  assignAgentToConversation,
  createConversationalAgent,
  getConversationState,
  shouldSuppressChatNotificationForConversationalAgent,
  updateConversationalAgent
} from '../src/services/conversationalAgentService.js'
import {
  handleInboundConversationalMessage,
  sendCurrentConversationalReply,
  shouldRecoverPendingInbound
} from '../src/agents/conversational/runner.js'

await databaseReady
await runVersionedMigrations()

const weekly = [{ dayOfWeek: 1, start: '09:00', end: '17:00' }]
const schedule = { weekly, dateOverrides: [] }

test('evalúa días y límites en la zona del negocio, y cada fecha sustituye su horario semanal', () => {
  const configured = normalizeAgentResponseSchedule({
    weekly: [...weekly, { dayOfWeek: 0, start: '18:00', end: '24:00' }],
    dateOverrides: [
      { date: '2026-11-02', intervals: [] },
      { date: '2026-11-03', intervals: [{ start: '09:00', end: '12:00' }] }
    ]
  })
  const open = (iso) => isAgentResponseScheduleOpenAt(configured, 'America/Ciudad_Juarez', Date.parse(iso))
  assert.equal(open('2026-11-02T06:59:59Z'), true, 'el domingo local sigue abierto')
  assert.equal(open('2026-11-02T07:00:00Z'), false, 'medianoche termina el tramo del domingo')
  assert.equal(open('2026-11-02T16:00:00Z'), false, 'la excepción cierra el lunes')
  assert.equal(open('2026-11-03T15:59:59Z'), false)
  assert.equal(open('2026-11-03T16:00:00Z'), true, 'la excepción abre un martes cerrado normalmente')
  assert.equal(open('2026-11-03T19:00:00Z'), false)
  assert.equal(open('2026-11-09T16:00:00Z'), true, 'el lunes siguiente conserva su horario')
  assert.equal(isAgentResponseScheduleOpenAt(null, 'UTC', 0), true)
  assert.equal(isAgentResponseScheduleOpenAt(parseStoredAgentResponseSchedule('{'), 'UTC', 0), false)
})

test('rechaza fechas imposibles, días inválidos, intervalos empalmados y horarios vacíos', () => {
  for (const malformed of [
    { weekly: [], dateOverrides: [] },
    { ...schedule, weekly: [{ ...weekly[0], dayOfWeek: 7 }] },
    { ...schedule, weekly: [{ ...weekly[0], end: '07:00' }] },
    { ...schedule, weekly: [...weekly, { dayOfWeek: 1, start: '16:00', end: '17:30' }] },
    { ...schedule, dateOverrides: [{ date: '2026-02-30', intervals: [] }] },
    { ...schedule, dateOverrides: [{ date: '2026-11-02', intervals: [] }, { date: '2026-11-02', intervals: [] }] }
  ]) {
    assert.throws(() => normalizeAgentResponseSchedule(malformed), { statusCode: 400, code: 'CONVERSATIONAL_AGENT_INVALID_RESPONSE_SCHEDULE' })
  }
})

test('persiste el horario y conserva el modo siempre para bots anteriores o cambios parciales', async (t) => {
  const agent = await createConversationalAgent({ enabled: false })
  t.after(() => db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]))
  assert.equal(agent.responseSchedule, null)
  assert.deepEqual((await updateConversationalAgent(agent.id, { responseSchedule: schedule })).responseSchedule, schedule)
  assert.deepEqual((await updateConversationalAgent(agent.id, { name: 'Con horario' })).responseSchedule, schedule)
  assert.equal((await updateConversationalAgent(agent.id, { responseSchedule: null })).responseSchedule, null)
})

test('recibe fuera de horario sin contestar al abrir, conserva avisos y protege el envío final', async (t) => {
  const contactId = `schedule_contact_${randomUUID()}`
  const messageId = `schedule_message_${randomUUID()}`
  const phone = '+15550061234'
  const receivedAt = '2026-11-02T08:59:59Z'
  const nowMs = Date.parse('2026-11-02T09:00:00Z')
  const previousZone = await db.get("SELECT config_value FROM app_config WHERE config_key = 'account_timezone'")
  await db.run(`INSERT INTO app_config (config_key, config_value) VALUES ('account_timezone', 'UTC')
    ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value`)
  invalidateTimezoneCache()
  t.after(async () => {
    if (previousZone) {
      await db.run("UPDATE app_config SET config_value = ? WHERE config_key = 'account_timezone'", [previousZone.config_value])
    } else {
      await db.run("DELETE FROM app_config WHERE config_key = 'account_timezone'")
    }
    invalidateTimezoneCache()
  })
  t.mock.method(Date, 'now', () => nowMs)

  const agent = await createConversationalAgent({
    contactScope: 'all', hideAttendedNotifications: true, responseSchedule: schedule
  })
  await db.run('INSERT INTO contacts (id, full_name, phone) VALUES (?, ?, ?)', [contactId, 'Horario', phone])
  t.after(async () => {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id])
  })
  await assignAgentToConversation(contactId, agent.id, { channel: 'whatsapp' })
  await db.run(`INSERT INTO whatsapp_api_messages (
    id, contact_id, phone, direction, message_type, message_text, transport, message_timestamp, created_at
  ) VALUES (?, ?, ?, 'inbound', 'text', 'Antes de abrir', 'qr', ?, ?)`, [
    messageId, contactId, phone, receivedAt, receivedAt
  ])

  assert.deepEqual(await handleInboundConversationalMessage({ contactId, phone, messageId }), {
    skipped: true, reason: 'outside_response_schedule'
  })
  const state = await getConversationState(contactId, { agentId: agent.id, channel: 'whatsapp' })
  assert.equal(state.inboundProcessingStatus, 'completed')
  assert.equal(state.lastAnsweredInboundMessageId, null)
  assert.equal(shouldRecoverPendingInbound({ id: messageId, created_at: receivedAt }, state, { nowMs }), false)
  assert.equal(await shouldSuppressChatNotificationForConversationalAgent(contactId, {
    channel: 'whatsapp', receivedAtMs: Date.parse(receivedAt)
  }), false)
  assert.equal(await shouldSuppressChatNotificationForConversationalAgent(contactId, {
    channel: 'whatsapp', receivedAtMs: nowMs
  }), true)
  assert.equal(await shouldSuppressChatNotificationForConversationalAgent(contactId, {
    channel: 'email', receivedAtMs: nowMs
  }), false)

  t.mock.method(Date, 'now', () => Date.parse('2026-11-02T17:00:00Z'))
  const dependencies = {
    database: { transaction: async (callback) => callback({}) },
    acquireLock: async () => {},
    getState: async () => ({ agentId: agent.id, status: 'active', inboundProcessingClaimToken: 'claim', inboundProcessingMessageId: messageId }),
    findNewer: async () => ({ checked: true, newerMessage: null })
  }
  const sendOptions = {
    contactId, agentId: agent.id, channel: 'whatsapp', sourceMessageId: messageId,
    inboundClaim: { claimToken: 'claim' }, send: async () => 'confirmado'
  }
  assert.deepEqual(await sendCurrentConversationalReply(sendOptions, dependencies), {
    allowed: false, reason: 'outside_response_schedule'
  })
  assert.deepEqual(await sendCurrentConversationalReply({ ...sendOptions, ownsTerminalState: true }, dependencies), {
    allowed: true, sent: true, deliveryResult: 'confirmado'
  })
})
