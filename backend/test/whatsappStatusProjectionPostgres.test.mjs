import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import pg from 'pg'

import { rebuildWhatsAppStatusProjection } from '../src/services/whatsappStatusProjectionService.js'

const connectionString = process.env.RISTAK_TEST_POSTGRES_URL || ''
const migrationUrl = new URL('../migrations/versioned/102a_whatsapp_status_projection.postgres.sql', import.meta.url)
const routingIndexMigrationUrl = new URL(
  '../migrations/versioned/102b_whatsapp_routing_events_contact_latest.postgres.sql',
  import.meta.url
)
const templateIndexMigrationUrl = new URL(
  '../migrations/versioned/102c_whatsapp_templates_catalog_page.postgres.sql',
  import.meta.url
)

function convertPlaceholders(sql) {
  let index = 0
  return String(sql).replace(/\?/g, () => `$${++index}`)
}

function createAdapter(client) {
  const adapter = {
    async run(sql, params = []) {
      const result = await client.query(convertPlaceholders(sql), params)
      return { changes: result.rowCount, lastID: result.rows[0]?.id || null }
    },
    async get(sql, params = []) {
      const result = await client.query(convertPlaceholders(sql), params)
      return result.rows[0] || null
    },
    async all(sql, params = []) {
      const result = await client.query(convertPlaceholders(sql), params)
      return result.rows
    },
    async exec(sql) {
      await client.query(sql)
    },
    async transaction(callback) {
      await client.query('BEGIN')
      try {
        const result = await callback(adapter)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      }
    }
  }
  return adapter
}

test('PostgreSQL mantiene status WhatsApp O(1) y exacto con 300k mensajes', {
  skip: !connectionString,
  timeout: 120_000
}, async () => {
  const client = new pg.Client({ connectionString })
  const schema = `ristak_wa_status_${randomUUID().replaceAll('-', '')}`
  await client.connect()

  try {
    await client.query(`CREATE SCHEMA "${schema}"`)
    await client.query(`SET search_path TO "${schema}", public`)
    await client.query(`
      CREATE TABLE whatsapp_api_phone_numbers (id TEXT PRIMARY KEY);
      CREATE TABLE whatsapp_api_contacts (id TEXT PRIMARY KEY);
      CREATE TABLE whatsapp_api_messages (id TEXT PRIMARY KEY, direction TEXT);
      CREATE TABLE whatsapp_api_attribution (id TEXT PRIMARY KEY);
      CREATE TABLE whatsapp_api_webhook_events (id TEXT PRIMARY KEY);
      CREATE TABLE whatsapp_api_templates (
        id TEXT PRIMARY KEY,
        status TEXT,
        raw_payload_json TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE whatsapp_api_alerts (id TEXT PRIMARY KEY, status TEXT, severity TEXT);
      CREATE TABLE whatsapp_api_template_sends (id TEXT PRIMARY KEY);
      CREATE TABLE whatsapp_routing_events (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        previous_phone_number_id TEXT,
        new_phone_number_id TEXT,
        source TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO whatsapp_api_messages (id, direction)
      SELECT 'message_' || value,
        CASE WHEN value % 2 = 0 THEN 'inbound' ELSE 'outbound' END
      FROM generate_series(1, 300000) value;
      INSERT INTO whatsapp_api_contacts (id)
      SELECT 'contact_' || value FROM generate_series(1, 100000) value;
    `)

    const migrationSql = await readFile(migrationUrl, 'utf8')
    assert.doesNotMatch(migrationSql, /LOCK TABLE/)
    assert.doesNotMatch(migrationSql, /COUNT\(\*\).*whatsapp_api_messages/is)
    const migrationStartedAt = Date.now()
    await client.query(migrationSql)
    assert.ok(Date.now() - migrationStartedAt < 5_000, '102a no debe escanear 300k mensajes')
    assert.equal((await client.query(`
      SELECT status FROM whatsapp_status_projection_state WHERE singleton_id = 1
    `)).rows[0].status, 'backfilling')
    await client.query(`
      INSERT INTO whatsapp_api_messages (id, direction)
      VALUES ('pre_cutover_message', 'inbound')
    `)
    assert.equal(Number((await client.query(`
      SELECT COUNT(*) AS total
      FROM whatsapp_status_metric_deltas
      WHERE applied = FALSE
    `)).rows[0].total), 2)

    await client.query(await readFile(routingIndexMigrationUrl, 'utf8'))
    await client.query(await readFile(templateIndexMigrationUrl, 'utf8'))
    const backfill = await rebuildWhatsAppStatusProjection({
      database: createAdapter(client),
      dialect: 'postgres'
    })
    assert.equal(backfill.ready, true)
    assert.equal((await client.query(`
      SELECT status FROM whatsapp_status_projection_state WHERE singleton_id = 1
    `)).rows[0].status, 'ready')

    const counts = await client.query(`
      SELECT metric, SUM(counter_value)::bigint AS total
      FROM whatsapp_status_metric_counters
      GROUP BY metric
    `)
    const byMetric = new Map(counts.rows.map(row => [row.metric, Number(row.total)]))
    assert.equal(byMetric.get('messages'), 300001)
    assert.equal(byMetric.get('inbound_messages'), 150001)
    assert.equal(byMetric.get('outbound_messages'), 150000)
    assert.equal(byMetric.get('contacts'), 100000)

    await client.query("DELETE FROM whatsapp_api_messages WHERE id = 'pre_cutover_message'")

    await client.query("INSERT INTO whatsapp_api_messages (id, direction) VALUES ('hot_message', 'inbound')")
    await client.query("UPDATE whatsapp_api_messages SET direction = 'business_echo' WHERE id = 'hot_message'")
    let hot = await client.query(`
      SELECT metric, SUM(counter_value)::bigint AS total
      FROM whatsapp_status_metric_counters
      WHERE metric IN ('messages', 'inbound_messages', 'outbound_messages')
      GROUP BY metric
    `)
    let hotCounts = new Map(hot.rows.map(row => [row.metric, Number(row.total)]))
    assert.equal(hotCounts.get('messages'), 300001)
    assert.equal(hotCounts.get('inbound_messages'), 150000)
    assert.equal(hotCounts.get('outbound_messages'), 150001)

    await client.query("DELETE FROM whatsapp_api_messages WHERE id = 'hot_message'")
    hot = await client.query(`
      SELECT metric, SUM(counter_value)::bigint AS total
      FROM whatsapp_status_metric_counters
      WHERE metric IN ('messages', 'inbound_messages', 'outbound_messages')
      GROUP BY metric
    `)
    hotCounts = new Map(hot.rows.map(row => [row.metric, Number(row.total)]))
    assert.equal(hotCounts.get('messages'), 300000)
    assert.equal(hotCounts.get('inbound_messages'), 150000)
    assert.equal(hotCounts.get('outbound_messages'), 150000)

    await client.query(`
      INSERT INTO whatsapp_routing_events (
        id, contact_id, previous_phone_number_id, new_phone_number_id, source, created_at
      ) VALUES
        ('route_a', 'contact_1', 'phone_original', 'phone_backup', 'contingency', '2098-01-01'),
        ('route_b', 'contact_1', 'phone_backup', 'phone_manual', 'manual', '2098-01-02');
    `)
    assert.equal((await client.query(`
      SELECT COUNT(*)::int AS total FROM whatsapp_contingency_restore_counts
    `)).rows[0].total, 0)
    await client.query("DELETE FROM whatsapp_routing_events WHERE id = 'route_b'")
    assert.equal(Number((await client.query(`
      SELECT contact_count FROM whatsapp_contingency_restore_counts
      WHERE previous_phone_number_id = 'phone_original'
    `)).rows[0].contact_count), 1)

    const plan = await client.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT metric, SUM(counter_value)
      FROM whatsapp_status_metric_counters
      GROUP BY metric
    `)
    const planJson = plan.rows[0]['QUERY PLAN'][0]
    const planText = JSON.stringify(planJson)
    assert.doesNotMatch(planText, /whatsapp_api_messages|whatsapp_api_contacts/)
    assert.ok(Number(planJson['Execution Time']) < 100, `status tardó ${planJson['Execution Time']}ms`)
  } finally {
    await client.query('SET search_path TO public').catch(() => undefined)
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await client.end().catch(() => undefined)
  }
})
