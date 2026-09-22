import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { db } from '../src/config/database.js'
import { createPostgresAdapter } from '../src/config/databasePostgresAdapter.js'
import {
  getInboundMandatoryHandoffEscalationReason,
  loadPendingInboundMessages,
  loadToolCallingV2ConversationEnvelope,
  loadToolCallingV2ConversationEnvelopeThroughMessage
} from '../src/agents/conversational/runner.js'

const channels = ['whatsapp', 'sms', 'webchat', 'messenger', 'instagram', 'facebook_comment', 'instagram_comment', 'email']
const tableFor = channel => channel === 'email' ? 'email_messages'
  : ['whatsapp', 'sms', 'webchat'].includes(channel) ? 'whatsapp_api_messages' : 'meta_social_messages'

async function verifyCanonicalBoundaries(database, { nativeDates = false } = {}) {
  const contactId = `history_boundary_${randomUUID()}`
  await database.run('INSERT INTO contacts (id, full_name) VALUES (?, ?)', [contactId, 'Prueba de historial'])
  try {
    for (const channel of channels) {
      const table = tableFor(channel)
      for (const useCreatedAt of [false, true]) {
        const prefix = `${contactId}_${channel}_${useCreatedAt}`
        const ids = ['a', 'm', 'z'].map(letter => `${prefix}_${letter}`)
        for (let i = 0; i < ids.length; i += 1) {
          const stamp = `2026-09-22 21:09:43.12345${5 + i}`
          const type = channel.endsWith('_comment') ? 'comment' : 'text'
          const text = i === 0 ? 'CLAVE-HISTORIAL '.repeat(1000) : `mensaje ${i}`
          const columns = ['id', 'contact_id', 'direction', 'message_text', 'message_timestamp', 'created_at']
          const values = [ids[i], contactId, 'inbound', text, useCreatedAt ? null : stamp, stamp]
          if (table !== 'email_messages') { columns.push('message_type'); values.push(type) }
          if (table === 'whatsapp_api_messages') { columns.push('transport'); values.push(channel === 'whatsapp' ? 'qr' : channel) }
          if (table === 'meta_social_messages') { columns.push('platform'); values.push(channel.startsWith('instagram') ? 'instagram' : 'messenger') }
          await database.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values.map(() => '?').join(', ')})`, values)
        }
        const anchor = await database.get(`SELECT * FROM ${table} WHERE id = ?`, [ids[1]])
        if (nativeDates) assert.ok((anchor.message_timestamp || anchor.created_at) instanceof Date)
        // Exercise the Date shape from pg even when this test runs on SQLite.
        const dateAnchor = { ...anchor, message_timestamp: useCreatedAt ? null : new Date('2026-09-22T21:09:43.123Z'), created_at: new Date('2026-09-22T21:09:43.123Z') }
        const pending = await loadPendingInboundMessages(contactId, { lastAnsweredInboundMessageId: ids[0] }, channel, dateAnchor)
        assert.deepEqual(pending.map(row => row.id), [ids[1]], `${channel}: incluye el ancla exacta y excluye el siguiente microsegundo`)
        const envelope = await loadToolCallingV2ConversationEnvelopeThroughMessage({ contactId, channel, terminalSourceMessageId: ids[1], byteBudget: 1024 })
        assert.equal(envelope.messages.at(-1).id, ids[1])
        assert.equal(envelope.telemetry.totalMessages, 2)
        const search = await envelope.loadOlderPage({ mode: 'search', query: 'CLAVE-HISTORIAL' })
        assert.equal(search.returnedMessages, 1)
        const wrongContact = await loadToolCallingV2ConversationEnvelope({ contactId: 'another_contact', channel, throughMessage: dateAnchor })
        assert.equal(wrongContact.telemetry.totalMessages, 0)
        await database.run(`DELETE FROM ${table} WHERE contact_id = ?`, [contactId])
      }
    }
  } finally {
    for (const table of new Set(channels.map(tableFor))) await database.run(`DELETE FROM ${table} WHERE contact_id = ?`, [contactId])
    await database.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
}

test('los ocho canales conservan la frontera canónica aunque pg entregue Date con menos precisión', async () => {
  await verifyCanonicalBoundaries(db)
})

test('una fecha inválida no abre el historial sin límites', async () => {
  await assert.rejects(loadPendingInboundMessages('invalid_boundary', {}, 'whatsapp', { id: 'invalid', created_at: new Date(NaN) }), { code: 'conversational_history_timestamp_invalid' })
})

test('un error general en el tercer intento no fuerza handoff cuando esa capacidad está apagada', () => {
  assert.equal(getInboundMandatoryHandoffEscalationReason({ state: { inboundProcessingLastError: 'invalid input syntax for type timestamp' }, attemptCount: 3, policyConfigured: false }), null)
  assert.equal(getInboundMandatoryHandoffEscalationReason({ attemptCount: 1, policyConfigured: true }), null)
  assert.equal(getInboundMandatoryHandoffEscalationReason({ attemptCount: 3, policyConfigured: true }).marker, 'mandatory_handoff_attempt_threshold')
  assert.equal(getInboundMandatoryHandoffEscalationReason({ state: { inboundProcessingLastError: 'mandatory_handoff_escalation_pending:handoff_rule_scope_load_failed' }, attemptCount: 1, policyConfigured: false }).marker, 'mandatory_handoff_escalation_pending')
})

test('PostgreSQL real carga pendientes, cuenta historial y busca con timestamps nativos y microsegundos', { skip: !process.env.TEST_POSTGRES_URL }, async () => {
  const client = new pg.Client({ connectionString: process.env.TEST_POSTGRES_URL })
  await client.connect()
  const database = createPostgresAdapter(client)
  const previous = { get: db.get, all: db.all }
  try {
    // TEMP tables belong only to this connection; no production or shared test
    // tables, OpenAI requests, customer credentials or outbound messages.
    await client.query(`CREATE TEMP TABLE contacts (id TEXT PRIMARY KEY, full_name TEXT);
      CREATE TEMP TABLE whatsapp_api_messages (
        id TEXT PRIMARY KEY, contact_id TEXT, direction TEXT, message_type TEXT,
        message_text TEXT, media_url TEXT, media_mime_type TEXT, media_filename TEXT,
        media_duration_ms INTEGER, phone TEXT, business_phone TEXT, business_phone_number_id TEXT,
        transport TEXT, message_timestamp TIMESTAMP, created_at TIMESTAMP, raw_payload_json TEXT);
      CREATE TEMP TABLE meta_social_messages (
        id TEXT PRIMARY KEY, contact_id TEXT, direction TEXT, message_type TEXT, message_text TEXT,
        media_url TEXT, media_mime_type TEXT, platform TEXT, message_timestamp TIMESTAMP,
        created_at TIMESTAMP, raw_payload_json TEXT);
      CREATE TEMP TABLE email_messages (
        id TEXT PRIMARY KEY, contact_id TEXT, direction TEXT, message_text TEXT, subject TEXT,
        from_email TEXT, to_email TEXT, reply_to TEXT, message_timestamp TIMESTAMP,
        created_at TIMESTAMP, raw_payload_json TEXT);`)
    db.get = database.get
    db.all = database.all
    await verifyCanonicalBoundaries(database, { nativeDates: true })
  } finally {
    db.get = previous.get
    db.all = previous.all
    await client.end()
  }
})
