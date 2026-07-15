import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import pg from 'pg'

const connectionString = process.env.RISTAK_TEST_POSTGRES_URL || ''
const TOTAL_MESSAGES = 1_000_000
const PHONE_COUNT = 8
const HIDDEN_CONTACTS = 100
const START_DATE = '2025-01-01'
const END_DATE = '2025-12-31'

function clientOptions() {
  const local = /(?:localhost|127\.0\.0\.1|postgresql:\/\/\/)/i.test(connectionString)
  return {
    connectionString,
    ...(local ? {} : { ssl: { rejectUnauthorized: false } })
  }
}

function sumPlanMetric(plan, key) {
  if (!plan || typeof plan !== 'object') return 0
  let total = Number(plan[key] || 0)
  for (const child of plan.Plans || []) total += sumPlanMetric(child, key)
  return total
}

async function explain(client, sql, params) {
  const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params)
  const root = result.rows[0]['QUERY PLAN'][0]
  return {
    executionMs: Number(root['Execution Time'] || 0),
    planningMs: Number(root['Planning Time'] || 0),
    tempReadBlocks: sumPlanMetric(root.Plan, 'Temp Read Blocks'),
    tempWrittenBlocks: sumPlanMetric(root.Plan, 'Temp Written Blocks')
  }
}

async function readCounts(client) {
  const result = await client.query(`
    SELECT delta.business_phone_key, SUM(delta.range_delta)::bigint AS identity_count
    FROM message_analytics_phone_range_delta delta
    WHERE delta.generation = 1
      AND delta.start_boundary <= $1::date
      AND delta.occurrence_date <= $2::date
    GROUP BY delta.business_phone_key
    HAVING SUM(delta.range_delta) > 0
  `, [START_DATE, END_DATE])
  return new Map(result.rows.map(row => [row.business_phone_key, Number(row.identity_count)]))
}

async function readMetadata(client, phoneKeys) {
  const result = await client.query(`
    WITH projected_phone_metadata AS (
      SELECT
        metadata.business_phone_key,
        MAX(NULLIF(metadata.business_phone_number_id, '')) AS business_phone_number_id,
        MAX(NULLIF(metadata.business_phone_number, '')) AS business_phone_number
      FROM message_analytics_daily_phone_metadata metadata
      WHERE metadata.generation = 1
        AND metadata.business_date >= $1::date AND metadata.business_date <= $2::date
        AND metadata.business_phone_key = ANY($3::text[])
        AND metadata.message_count > 0
      GROUP BY metadata.business_phone_key
    )
    SELECT projected.*, phone.label, phone.phone_number, phone.display_phone_number
    FROM projected_phone_metadata projected
    LEFT JOIN whatsapp_api_phone_numbers phone
      ON phone.id = projected.business_phone_number_id
  `, [START_DATE, END_DATE, phoneKeys])
  return result.rows
}

async function benchmarkRead(client, { hidden = false } = {}) {
  const startedAt = performance.now()
  const counts = await readCounts(client)
  let affectedPairs = []
  if (hidden) {
    const contacts = await client.query(`
      SELECT id FROM contacts WHERE LOWER(COALESCE(full_name, '')) = LOWER($1)
      UNION
      SELECT id FROM contacts WHERE LOWER(COALESCE(email, '')) = LOWER($1)
      UNION
      SELECT id FROM contacts WHERE LOWER(COALESCE(phone, '')) = LOWER($1)
      UNION
      SELECT id FROM contacts WHERE LOWER(id) = LOWER($1)
    `, ['Benchmark Hidden'])
    const contactIds = contacts.rows.map(row => row.id)
    const affected = await client.query(`
      SELECT DISTINCT business_phone_key, identity_key
      FROM message_analytics_daily_phone_identity
      WHERE generation = 1
        AND contact_id = ANY($1::text[])
        AND business_date >= $2::date AND business_date <= $3::date
    `, [contactIds, START_DATE, END_DATE])
    affectedPairs = affected.rows
    if (affectedPairs.length) {
      const values = []
      const pairSql = affectedPairs.map((pair, index) => {
        values.push(pair.business_phone_key, pair.identity_key)
        const offset = index * 2 + 3
        return `(business_phone_key = $${offset} AND identity_key = $${offset + 1})`
      }).join(' OR ')
      const rows = await client.query(`
        SELECT business_phone_key, identity_key, contact_id, message_count
        FROM message_analytics_daily_phone_identity
        WHERE generation = 1
          AND business_date >= $1::date AND business_date <= $2::date
          AND (${pairSql})
      `, [START_DATE, END_DATE, ...values])
      const grouped = new Map()
      const hiddenIds = new Set(contactIds)
      for (const row of rows.rows) {
        const pairKey = `${row.business_phone_key}\u0000${row.identity_key}`
        if (!grouped.has(pairKey)) {
          grouped.set(pairKey, {
            phoneKey: row.business_phone_key,
            hidden: false,
            visible: false
          })
        }
        const entry = grouped.get(pairKey)
        if (hiddenIds.has(row.contact_id)) entry.hidden = true
        else entry.visible = true
      }
      for (const entry of grouped.values()) {
        if (entry.hidden && !entry.visible) {
          counts.set(entry.phoneKey, Number(counts.get(entry.phoneKey) || 0) - 1)
        }
      }
    }
  }
  const metadata = await readMetadata(client, [...counts.keys()])
  return {
    elapsedMs: performance.now() - startedAt,
    counts,
    metadata,
    affectedPairs: affectedPairs.length
  }
}

test('PostgreSQL 1M anual mantiene lectura por deltas y hidden sin temp spill', {
  skip: !connectionString,
  timeout: 600_000
}, async () => {
  const client = new pg.Client(clientOptions())
  const schema = `phone_projection_bench_${randomUUID().replaceAll('-', '')}`
  await client.connect()
  try {
    await client.query(`CREATE SCHEMA "${schema}"`)
    await client.query(`SET search_path TO "${schema}", public`)
    await client.query(`
      CREATE TABLE whatsapp_api_messages(
        id TEXT PRIMARY KEY, contact_id TEXT, phone TEXT, whatsapp_api_contact_id TEXT,
        direction TEXT, message_timestamp TIMESTAMPTZ, created_at TIMESTAMPTZ,
        business_phone TEXT, business_phone_number_id TEXT,
        detected_ctwa_clid TEXT, detected_source_id TEXT, detected_source_url TEXT,
        detected_source_type TEXT, detected_source_app TEXT, detected_entry_point TEXT
      );
      CREATE TABLE meta_social_messages(
        id TEXT PRIMARY KEY, platform TEXT, meta_social_contact_id TEXT, contact_id TEXT,
        sender_id TEXT, direction TEXT, message_timestamp TIMESTAMPTZ,
        created_at TIMESTAMPTZ, referral_json TEXT
      );
      CREATE TABLE email_messages(
        id TEXT PRIMARY KEY, contact_id TEXT, direction TEXT, from_email TEXT,
        message_timestamp TIMESTAMPTZ, created_at TIMESTAMPTZ
      );
      CREATE TABLE whatsapp_api_attribution(
        id TEXT PRIMARY KEY, whatsapp_api_message_id TEXT,
        detected_source_id TEXT, detected_ctwa_clid TEXT, detected_source_url TEXT,
        detected_source_type TEXT, detected_source_app TEXT, detected_entry_point TEXT
      );
      CREATE TABLE contacts(
        id TEXT PRIMARY KEY, full_name TEXT, email TEXT, phone TEXT, source TEXT,
        attribution_url TEXT, attribution_session_source TEXT, attribution_medium TEXT,
        attribution_ctwa_clid TEXT, attribution_ad_id TEXT
      );
      CREATE TABLE whatsapp_api_phone_numbers(
        id TEXT PRIMARY KEY, label TEXT, verified_name TEXT, phone_number TEXT,
        display_phone_number TEXT, status TEXT, qr_status TEXT,
        api_send_enabled BOOLEAN, qr_send_enabled BOOLEAN
      );
    `)
    for (const migration of [
      '114a_message_analytics_projection.postgres.sql',
      '115a_message_analytics_range_rollup.postgres.sql',
      '118a_message_analytics_phone_projection.postgres.sql'
    ]) {
      await client.query(await readFile(
        new URL(`../migrations/versioned/${migration}`, import.meta.url),
        'utf8'
      ))
    }
    // El benchmark mide lectura/tamaño. UNLOGGED evita gastar varios minutos en
    // WAL al fabricar el fixture descartable sin cambiar índices ni planes.
    await client.query(`
      SET synchronous_commit = OFF;
      ALTER TABLE message_analytics_phone_fact SET UNLOGGED;
      ALTER TABLE message_analytics_daily_phone_identity SET UNLOGGED;
      ALTER TABLE message_analytics_daily_phone_metadata SET UNLOGGED;
      ALTER TABLE message_analytics_phone_range_delta SET UNLOGGED;
    `)
    await client.query(`
      UPDATE message_analytics_projection_state
      SET projection_version = 3, status = 'ready',
          active_generation = 1, active_version = 3, active_timezone = 'UTC',
          building_generation = NULL, building_version = NULL, building_timezone = NULL
      WHERE singleton_id = 1;
      INSERT INTO message_analytics_range_generation(generation, status, built_at)
      VALUES (1, 'ready', CURRENT_TIMESTAMP);
    `)
    await client.query(`
      INSERT INTO whatsapp_api_phone_numbers(
        id, label, verified_name, phone_number, display_phone_number,
        status, api_send_enabled, qr_send_enabled
      )
      SELECT
        'phone-' || phone_index,
        'Numero ' || phone_index,
        'Numero verificado ' || phone_index,
        '+52656000' || LPAD(phone_index::text, 4, '0'),
        '+52 656 000 ' || LPAD(phone_index::text, 4, '0'),
        'connected', TRUE, FALSE
      FROM generate_series(0, $1::int - 1) AS phone_index
    `, [PHONE_COUNT])
    await client.query(`
      INSERT INTO contacts(id, full_name, email, phone)
      SELECT
        'hidden-' || n,
        'Benchmark Hidden',
        'hidden-' || n || '@benchmark.invalid',
        '+521' || LPAD(n::text, 10, '0')
      FROM generate_series(1, $1::int) AS n
    `, [HIDDEN_CONTACTS])
    await client.query(`
      INSERT INTO message_analytics_phone_fact(
        generation, source_message_id, projection_version, included,
        occurred_at, business_date, identity_key, contact_id, contact_key,
        business_phone_key, business_phone_number_id, business_phone_number
      )
      SELECT
        1,
        'message-' || n,
        3,
        TRUE,
        ($2::date + ((n - 1) % 365)::int + TIME '12:00')::timestamptz,
        $2::date + ((n - 1) % 365)::int,
        'identity-' || n,
        CASE WHEN n <= $3::int THEN 'hidden-' || n ELSE 'contact-' || n END,
        CASE WHEN n <= $3::int THEN 'hidden-' || n ELSE 'contact-' || n END,
        'phone-' || ((n - 1) % $4::int),
        'phone-' || ((n - 1) % $4::int),
        '+52656000' || LPAD(((n - 1) % $4::int)::text, 4, '0')
      FROM generate_series(1, $1::int) AS n
    `, [TOTAL_MESSAGES, START_DATE, HIDDEN_CONTACTS, PHONE_COUNT])
    await client.query(`
      INSERT INTO message_analytics_daily_phone_identity(
        generation, business_date, business_phone_key, identity_key,
        contact_key, contact_id, message_count
      )
      SELECT
        generation, business_date, business_phone_key, identity_key,
        contact_key, contact_id, 1
      FROM message_analytics_phone_fact
    `)
    await client.query(`
      INSERT INTO message_analytics_daily_phone_metadata(
        generation, business_date, business_phone_key,
        business_phone_number_id, business_phone_number, message_count
      )
      SELECT
        1,
        day,
        'phone-' || phone_index,
        'phone-' || phone_index,
        '+52656000' || LPAD(phone_index::text, 4, '0'),
        1
      FROM generate_series($1::date, $2::date, INTERVAL '1 day') AS day
      CROSS JOIN generate_series(0, $3::int - 1) AS phone_index
    `, [START_DATE, END_DATE, PHONE_COUNT])
    await client.query(`
      WITH occurrences AS (
        SELECT
          business_phone_key,
          business_date,
          COUNT(*)::bigint AS identity_count
        FROM message_analytics_daily_phone_identity
        WHERE generation = 1
        GROUP BY business_phone_key, business_date
      ), points AS (
        SELECT
          business_phone_key,
          DATE '0001-01-01' AS start_boundary,
          business_date AS occurrence_date,
          identity_count AS range_delta
        FROM occurrences
        UNION ALL
        SELECT
          business_phone_key,
          business_date + 1 AS start_boundary,
          business_date AS occurrence_date,
          -identity_count AS range_delta
        FROM occurrences
      )
      INSERT INTO message_analytics_phone_range_delta(
        generation, business_phone_key, start_boundary, occurrence_date, range_delta
      )
      SELECT 1, business_phone_key, start_boundary, occurrence_date, SUM(range_delta)
      FROM points
      GROUP BY business_phone_key, start_boundary, occurrence_date
    `)
    await client.query('CREATE INDEX contacts_bench_name_exact ON contacts(LOWER(COALESCE(full_name, \'\')))')
    await client.query(`
      ANALYZE message_analytics_phone_fact;
      ANALYZE message_analytics_daily_phone_identity;
      ANALYZE message_analytics_daily_phone_metadata;
      ANALYZE message_analytics_phone_range_delta;
      ANALYZE contacts;
    `)

    // Una vuelta de calentamiento separa IO inicial del hot path que verá el usuario.
    await benchmarkRead(client)
    await benchmarkRead(client, { hidden: true })
    const regular = await benchmarkRead(client)
    const hidden = await benchmarkRead(client, { hidden: true })
    const expectedPerPhone = TOTAL_MESSAGES / PHONE_COUNT
    assert.equal(regular.counts.size, PHONE_COUNT)
    assert.ok([...regular.counts.values()].every(value => value === expectedPerPhone))
    assert.equal(hidden.affectedPairs, HIDDEN_CONTACTS)
    assert.equal(
      [...hidden.counts.values()].reduce((sum, value) => sum + value, 0),
      TOTAL_MESSAGES - HIDDEN_CONTACTS
    )

    const deltaSql = `
      SELECT delta.business_phone_key, SUM(delta.range_delta)::bigint AS identity_count
      FROM message_analytics_phone_range_delta delta
      WHERE delta.generation = 1
        AND delta.start_boundary <= $1::date AND delta.occurrence_date <= $2::date
      GROUP BY delta.business_phone_key
      HAVING SUM(delta.range_delta) > 0
    `
    const affectedSql = `
      SELECT DISTINCT business_phone_key, identity_key
      FROM message_analytics_daily_phone_identity
      WHERE generation = 1
        AND contact_id = ANY($1::text[])
        AND business_date >= $2::date AND business_date <= $3::date
    `
    const deltaPlan = await explain(client, deltaSql, [START_DATE, END_DATE])
    const affectedPlan = await explain(client, affectedSql, [
      Array.from({ length: HIDDEN_CONTACTS }, (_, index) => `hidden-${index + 1}`),
      START_DATE,
      END_DATE
    ])
    const sizeRows = await client.query(`
      SELECT relation_name,
             pg_total_relation_size(to_regclass(relation_name))::bigint AS bytes
      FROM (VALUES
        ('message_analytics_phone_fact'),
        ('message_analytics_daily_phone_identity'),
        ('message_analytics_daily_phone_metadata'),
        ('message_analytics_phone_range_delta')
      ) AS relations(relation_name)
      ORDER BY relation_name
    `)
    const relationBytes = Object.fromEntries(sizeRows.rows.map(row => [
      row.relation_name,
      Number(row.bytes)
    ]))
    const totalBytes = Object.values(relationBytes).reduce((sum, bytes) => sum + bytes, 0)
    const report = {
      rows: TOTAL_MESSAGES,
      days: 365,
      phones: PHONE_COUNT,
      hiddenContacts: HIDDEN_CONTACTS,
      regularMs: Number(regular.elapsedMs.toFixed(2)),
      hiddenMs: Number(hidden.elapsedMs.toFixed(2)),
      deltaExplain: deltaPlan,
      hiddenAffectedExplain: affectedPlan,
      relationBytes,
      totalBytes,
      tempReadBlocks: deltaPlan.tempReadBlocks + affectedPlan.tempReadBlocks,
      tempWrittenBlocks: deltaPlan.tempWrittenBlocks + affectedPlan.tempWrittenBlocks
    }
    console.info(`PHONE_PROJECTION_BENCHMARK ${JSON.stringify(report)}`)
    assert.ok(regular.elapsedMs < 500, `lectura anual tardó ${regular.elapsedMs.toFixed(2)}ms`)
    assert.ok(hidden.elapsedMs < 750, `lectura hidden tardó ${hidden.elapsedMs.toFixed(2)}ms`)
    assert.equal(report.tempReadBlocks, 0)
    assert.equal(report.tempWrittenBlocks, 0)
  } finally {
    await client.query('SET search_path TO public').catch(() => undefined)
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await client.end()
  }
})
