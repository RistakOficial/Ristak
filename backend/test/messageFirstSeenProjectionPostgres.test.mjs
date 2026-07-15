import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'
import pg from 'pg'

const connectionString = String(
  process.env.MESSAGE_FIRST_SEEN_TEST_POSTGRES_URL ||
  process.env.RISTAK_TEST_POSTGRES_URL ||
  process.env.TEST_POSTGRES_URL ||
  ''
).trim()

const migrationsUrl = new URL('../migrations/versioned/', import.meta.url)

async function projectionMigrationNames() {
  return (await readdir(migrationsUrl))
    .filter(name => /^099[d-g]_message_first_seen_.*\.postgres\.sql$/.test(name))
    .sort()
}

function collectPlanNodes(plan, rows = []) {
  if (!plan || typeof plan !== 'object') return rows
  rows.push(plan)
  for (const child of plan.Plans || []) collectPlanNodes(child, rows)
  return rows
}

async function createSourceSchema(client) {
  await client.query(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      full_name TEXT,
      email TEXT,
      phone TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE whatsapp_api_messages (
      id TEXT PRIMARY KEY,
      contact_id TEXT,
      phone TEXT,
      whatsapp_api_contact_id TEXT,
      direction TEXT,
      message_timestamp TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE meta_social_messages (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      contact_id TEXT,
      sender_id TEXT,
      meta_social_contact_id TEXT,
      direction TEXT,
      message_timestamp TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE email_messages (
      id TEXT PRIMARY KEY,
      contact_id TEXT,
      from_email TEXT,
      direction TEXT,
      message_timestamp TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `)
}

async function applyProjectionMigrations(client) {
  const names = await projectionMigrationNames()
  assert.deepEqual(names, [
    '099d_message_first_seen_projection.postgres.sql',
    '099e_message_first_seen_whatsapp_pending.postgres.sql',
    '099f_message_first_seen_meta_pending.postgres.sql',
    '099g_message_first_seen_email_pending.postgres.sql'
  ])
  for (const name of names) {
    await client.query(await readFile(new URL(name, migrationsUrl), 'utf8'))
  }
}

test('PostgreSQL mantiene first-seen exacto y consulta proyeccion indexada con 250k raw', {
  skip: !connectionString,
  timeout: 180_000
}, async (t) => {
  const client = new pg.Client({ connectionString })
  const schema = `ristak_message_first_seen_${randomUUID().replaceAll('-', '')}`
  await client.connect()

  try {
    await client.query(`CREATE SCHEMA "${schema}"`)
    await client.query(`SET search_path TO "${schema}", public`)
    await createSourceSchema(client)
    await applyProjectionMigrations(client)

    await client.query(`
      INSERT INTO contacts(id, full_name, email) VALUES
        ('contact-a', 'Contacto A', 'a@example.test'),
        ('contact-b', 'Contacto B', 'b@example.test');

      INSERT INTO whatsapp_api_messages(
        id, contact_id, direction, message_timestamp, created_at
      ) VALUES
        ('wa-a', 'contact-a', 'inbound',
         '2250-01-01 10:00:00.123456', '2250-01-01 10:00:00.123456'),
        ('wa-b', 'contact-a', 'inbound',
         '2250-01-01 10:00:00.123456', '2250-01-01 10:00:00.123456');

      INSERT INTO meta_social_messages(
        id, platform, contact_id, direction, message_timestamp, created_at
      ) VALUES (
        'meta-a', 'instagram', 'contact-a', 'inbound',
        '2250-01-01 11:00:00.654321', '2250-01-01 11:00:00.654321'
      );

      INSERT INTO email_messages(
        id, contact_id, direction, message_timestamp, created_at
      ) VALUES (
        'email-a', 'contact-a', NULL,
        '2250-01-01 09:00:00.111111', '2250-01-01 09:00:00.111111'
      );

      INSERT INTO whatsapp_api_messages(id, direction, message_timestamp, created_at)
      VALUES ('anonymous-shared', NULL, '2250-01-02 10:00:00.000001', '2250-01-02 10:00:00.000001');
      INSERT INTO meta_social_messages(id, platform, direction, message_timestamp, created_at)
      VALUES ('anonymous-shared', 'messenger', NULL, '2250-01-02 10:00:00.000002', '2250-01-02 10:00:00.000002');
      INSERT INTO email_messages(id, direction, message_timestamp, created_at)
      VALUES ('anonymous-shared', 'inbound', '2250-01-02 10:00:00.000003', '2250-01-02 10:00:00.000003');
    `)

    let firstWa = await client.query(`
      SELECT source_message_id, first_seen_at::text
      FROM message_identity_first_seen_source
      WHERE source_kind = 'whatsapp' AND identity_key = 'contact:contact-a'
    `)
    assert.equal(firstWa.rows[0].source_message_id, 'wa-a')
    assert.match(firstWa.rows[0].first_seen_at, /10:00:00\.123456/)

    let globalContact = await client.query(`
      SELECT source_kind, source_message_id
      FROM message_identity_first_seen_global
      WHERE identity_key = 'contact:contact-a'
    `)
    assert.deepEqual(globalContact.rows[0], {
      source_kind: 'whatsapp',
      source_message_id: 'wa-a'
    })
    const anonymousGlobal = await client.query(`
      SELECT COUNT(*) AS total
      FROM message_identity_first_seen_global
      WHERE identity_key = 'message:anonymous-shared'
    `)
    assert.equal(Number(anonymousGlobal.rows[0].total), 1)
    const anonymousSources = await client.query(`
      SELECT COUNT(*) AS total
      FROM message_identity_first_seen_source
      WHERE identity_key = 'message:anonymous-shared'
    `)
    assert.equal(Number(anonymousSources.rows[0].total), 3)

    await client.query("DELETE FROM whatsapp_api_messages WHERE id = 'wa-a'")
    firstWa = await client.query(`
      SELECT source_message_id
      FROM message_identity_first_seen_source
      WHERE source_kind = 'whatsapp' AND identity_key = 'contact:contact-a'
    `)
    assert.equal(firstWa.rows[0].source_message_id, 'wa-b')

    await client.query("UPDATE whatsapp_api_messages SET contact_id = 'contact-b' WHERE id = 'wa-b'")
    globalContact = await client.query(`
      SELECT source_kind, source_message_id
      FROM message_identity_first_seen_global
      WHERE identity_key = 'contact:contact-a'
    `)
    assert.deepEqual(globalContact.rows[0], {
      source_kind: 'meta',
      source_message_id: 'meta-a'
    })

    await client.query("UPDATE email_messages SET direction = 'inbound' WHERE id = 'email-a'")
    globalContact = await client.query(`
      SELECT source_kind, source_message_id, first_seen_at::text
      FROM message_identity_first_seen_global
      WHERE identity_key = 'contact:contact-a'
    `)
    assert.equal(globalContact.rows[0].source_kind, 'email')
    assert.match(globalContact.rows[0].first_seen_at, /09:00:00\.111111/)
    await client.query("DELETE FROM email_messages WHERE id = 'email-a'")

    // Raw deliberadamente enorme y pendiente. El fast path debe ser inmune a
    // esa cardinalidad porque solo consulta las summaries ya convergidas.
    await client.query('ALTER TABLE whatsapp_api_messages DISABLE TRIGGER USER')
    await client.query(`
      INSERT INTO whatsapp_api_messages(
        id, phone, direction, message_timestamp, created_at,
        first_seen_projection_version
      )
      SELECT
        'scale-raw-' || LPAD(series::text, 7, '0'),
        'scale-phone-' || LPAD(((series - 1) % 50000 + 1)::text, 6, '0'),
        'inbound',
        TIMESTAMP '2300-01-01 00:00:00' + series * INTERVAL '1 microsecond',
        TIMESTAMP '2300-01-01 00:00:00' + series * INTERVAL '1 microsecond',
        0
      FROM generate_series(1, 250000) series
    `)
    await client.query('ALTER TABLE whatsapp_api_messages ENABLE TRIGGER USER')

    await client.query('ALTER TABLE message_first_seen_ledger DISABLE TRIGGER USER')
    await client.query(`
      INSERT INTO message_first_seen_ledger(
        source_kind, source_message_id, included, identity_key,
        first_seen_at, contact_id
      )
      SELECT
        'whatsapp',
        'scale-ledger-' || LPAD(series::text, 6, '0'),
        1,
        'phone:scale-' || LPAD(series::text, 6, '0'),
        TIMESTAMP '2300-01-01 00:00:00' + series * INTERVAL '1 microsecond',
        NULL
      FROM generate_series(1, 50000) series;

      INSERT INTO message_identity_first_seen_global(
        identity_key, first_seen_at, source_kind, source_message_id, contact_id
      )
      SELECT
        'phone:scale-' || LPAD(series::text, 6, '0'),
        TIMESTAMP '2300-01-01 00:00:00' + series * INTERVAL '1 microsecond',
        'whatsapp',
        'scale-ledger-' || LPAD(series::text, 6, '0'),
        NULL
      FROM generate_series(1, 50000) series;

      INSERT INTO message_identity_first_seen_source(
        source_kind, identity_key, first_seen_at, source_message_id, contact_id
      )
      SELECT
        'whatsapp',
        'phone:scale-' || LPAD(series::text, 6, '0'),
        TIMESTAMP '2300-01-01 00:00:00' + series * INTERVAL '1 microsecond',
        'scale-ledger-' || LPAD(series::text, 6, '0'),
        NULL
      FROM generate_series(1, 50000) series;
    `)
    await client.query('ALTER TABLE message_first_seen_ledger ENABLE TRIGGER USER')
    await client.query(`
      ANALYZE whatsapp_api_messages;
      ANALYZE message_first_seen_ledger;
      ANALYZE message_identity_first_seen_global;
      ANALYZE message_identity_first_seen_source;
    `)

    const globalPlanResult = await client.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF)
      SELECT COUNT(*)
      FROM message_identity_first_seen_global first_seen
      WHERE first_seen.first_seen_at >= TIMESTAMP '2300-01-01 00:00:00.010000'
        AND first_seen.first_seen_at <= TIMESTAMP '2300-01-01 00:00:00.010100'
    `)
    const globalPlan = globalPlanResult.rows[0]['QUERY PLAN'][0]
    const globalNodes = collectPlanNodes(globalPlan.Plan)
    assert.ok(globalNodes.some(node => (
      node['Index Name'] === 'idx_message_first_seen_global_range'
    )), JSON.stringify(globalNodes))
    assert.equal(globalNodes.some(node => node['Relation Name'] === 'whatsapp_api_messages'), false)
    assert.equal(globalNodes.some(node => node['Relation Name'] === 'contacts'), false)
    assert.ok(Number(globalPlan['Execution Time']) < 1000)

    const timestampType = await client.query(`
      SELECT data_type, datetime_precision
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'message_identity_first_seen_global'
        AND column_name = 'first_seen_at'
    `)
    assert.deepEqual(timestampType.rows[0], {
      data_type: 'timestamp without time zone',
      datetime_precision: 6
    })
    const exactRange = await client.query(`
      SELECT COUNT(*) AS total
      FROM message_identity_first_seen_global
      WHERE first_seen_at >= $1
        AND first_seen_at <= $2
    `, [
      '2300-01-01T00:00:00.010000Z',
      '2300-01-01T00:00:00.010100Z'
    ])
    assert.equal(Number(exactRange.rows[0].total), 101, 'el rango inclusivo conserva microsegundos')

    const sourcePlanResult = await client.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF)
      SELECT COUNT(*)
      FROM message_identity_first_seen_source first_seen
      WHERE first_seen.source_kind = 'whatsapp'
        AND first_seen.first_seen_at >= TIMESTAMP '2300-01-01 00:00:00.020000'
        AND first_seen.first_seen_at <= TIMESTAMP '2300-01-01 00:00:00.020100'
    `)
    const sourcePlan = sourcePlanResult.rows[0]['QUERY PLAN'][0]
    const sourceNodes = collectPlanNodes(sourcePlan.Plan)
    assert.ok(sourceNodes.some(node => (
      node['Index Name'] === 'idx_message_first_seen_source_range'
    )), JSON.stringify(sourceNodes))
    assert.ok(Number(sourcePlan['Execution Time']) < 1000)

    const replacementPlanResult = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT source_message_id
      FROM message_first_seen_ledger
      WHERE identity_key = 'phone:scale-025000'
        AND included = 1
        AND first_seen_at IS NOT NULL
      ORDER BY first_seen_at, source_kind, source_message_id
      LIMIT 1
    `)
    const replacementNodes = collectPlanNodes(replacementPlanResult.rows[0]['QUERY PLAN'][0].Plan)
    assert.ok(replacementNodes.some(node => (
      node['Index Name'] === 'idx_message_first_seen_ledger_global_min'
    )), JSON.stringify(replacementNodes))

    const pendingPlanResult = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id
      FROM whatsapp_api_messages
      WHERE first_seen_projection_version < 1
      ORDER BY id
      LIMIT 1000
    `)
    const pendingNodes = collectPlanNodes(pendingPlanResult.rows[0]['QUERY PLAN'][0].Plan)
    assert.ok(pendingNodes.some(node => (
      node['Index Name'] === 'idx_whatsapp_messages_first_seen_pending'
    )), JSON.stringify(pendingNodes))

    const rawCount = await client.query(`
      SELECT COUNT(*) AS total FROM whatsapp_api_messages WHERE id LIKE 'scale-raw-%'
    `)
    assert.equal(Number(rawCount.rows[0].total), 250000)
    t.diagnostic(
      `raw=${rawCount.rows[0].total}, global-range=${Number(globalPlan['Execution Time']).toFixed(3)}ms, ` +
      `source-range=${Number(sourcePlan['Execution Time']).toFixed(3)}ms, exact-microsecond-rows=${exactRange.rows[0].total}`
    )
  } finally {
    await client.query('RESET search_path').catch(() => undefined)
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await client.end()
  }
})
