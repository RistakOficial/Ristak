import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { createPostgresAdapter } from '../src/config/databasePostgresAdapter.js'
import { parsePostgresTimestampWithoutTimezoneAsUtc } from '../src/config/database.js'
import { recoverDurableConversationalAgentWork } from '../src/agents/conversational/runner.js'

const postgresUrl = String(process.env.TEST_POSTGRES_URL || '').trim()

test('PostgreSQL recupera claims timestamp y reruns TEXT respetando instantes UTC exactos', {
  skip: !postgresUrl
}, async () => {
  const types = new pg.TypeOverrides()
  types.setTypeParser(1114, parsePostgresTimestampWithoutTimezoneAsUtc)
  const client = new pg.Client({ connectionString: postgresUrl, types, options: '-c timezone=UTC' })
  await client.connect()
  try {
    // Sólo tablas temporales de esta conexión; nunca usa ni cambia tablas de
    // negocio existentes en el servidor de pruebas.
    await client.query(`
      CREATE TEMP TABLE ai_agent_pending_reruns (
        run_key TEXT PRIMARY KEY, contact_id TEXT, channel TEXT,
        scheduled_for TEXT, payload TEXT
      );
      CREATE TEMP TABLE conversational_agents (id TEXT PRIMARY KEY, enabled INTEGER);
      CREATE TEMP TABLE conversational_agent_state (
        id TEXT PRIMARY KEY, contact_id TEXT, agent_id TEXT, channel TEXT,
        status TEXT, signal TEXT, inbound_processing_status TEXT,
        inbound_processing_message_id TEXT,
        inbound_processing_lease_until_at TIMESTAMP WITHOUT TIME ZONE
      );
      INSERT INTO conversational_agents VALUES ('agent', 1);
      INSERT INTO conversational_agent_state VALUES
        ('claim', 'claim-contact', 'agent', 'whatsapp', 'active', NULL,
         'processing', 'old-message', '2026-11-02 16:32:22'),
        ('due', 'due-contact', 'agent', 'whatsapp', 'active', NULL, NULL, NULL, NULL),
        ('future', 'future-contact', 'agent', 'whatsapp', 'active', NULL, NULL, NULL, NULL);
      INSERT INTO ai_agent_pending_reruns VALUES
        ('whatsapp:due-contact', 'due-contact', 'whatsapp', '2026-11-02 16:20:00', '{}'),
        ('whatsapp:future-contact', 'future-contact', 'whatsapp', '2026-11-02 16:40:00', '{}');
    `)
    const database = createPostgresAdapter(client)
    const scheduled = []
    const dependencies = {
      database,
      featureEnabled: async () => true,
      loadAssignment: async () => null,
      loadAgent: async () => ({ id: 'agent', enabled: true }),
      loadPreventive: async () => null,
      loadPlan: async () => null,
      loadLatest: async contactId => ({ id: `${contactId}-latest`, phone: '+15550009999', message_timestamp: '2026-11-02T16:26:02.000Z' }),
      loadStates: async contactId => {
        const rows = await database.all('SELECT * FROM conversational_agent_state WHERE contact_id = ?', [contactId])
        return rows.map(row => ({
          agentId: row.agent_id, status: row.status, signal: row.signal,
          inboundProcessingStatus: row.inbound_processing_status,
          inboundProcessingMessageId: row.inbound_processing_message_id,
          inboundProcessingLeaseUntilAt: row.inbound_processing_lease_until_at
        }))
      },
      schedule: value => scheduled.push(value),
      recordEvent: async () => {}
    }
    const lease = await database.get('SELECT inbound_processing_lease_until_at FROM conversational_agent_state WHERE id = ?', ['claim'])
    assert.ok(lease.inbound_processing_lease_until_at instanceof Date)
    assert.equal(lease.inbound_processing_lease_until_at.toISOString(), '2026-11-02T16:32:22.000Z')
    await recoverDurableConversationalAgentWork({ nowMs: Date.parse('2026-11-02T16:23:00.000Z') }, dependencies)
    assert.deepEqual(scheduled.map(row => row.contactId), ['due-contact'])
    scheduled.length = 0
    await recoverDurableConversationalAgentWork({ nowMs: Date.parse('2026-11-02T16:35:00.000Z') }, dependencies)
    assert.deepEqual(scheduled.map(row => row.contactId).sort(), ['claim-contact', 'due-contact'])
    assert.equal(scheduled.find(row => row.contactId === 'claim-contact').latestMessage.id, 'claim-contact-latest')
    scheduled.length = 0
    await recoverDurableConversationalAgentWork({ nowMs: Date.parse('2026-11-02T16:40:00.000Z') }, dependencies)
    assert.deepEqual(scheduled.map(row => row.contactId).sort(), ['claim-contact', 'due-contact', 'future-contact'])
  } finally {
    await client.end()
  }
})
