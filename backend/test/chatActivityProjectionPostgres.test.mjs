import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'
import pg from 'pg'

const connectionString = String(
  process.env.CHAT_ACTIVITY_TEST_POSTGRES_URL ||
  process.env.RISTAK_TEST_POSTGRES_URL ||
  process.env.TEST_POSTGRES_URL ||
  ''
).trim()

const migrationsUrl = new URL('../migrations/versioned/', import.meta.url)

async function postgresProjectionMigrationNames() {
  return (await readdir(migrationsUrl))
    .filter(name => /^(?:095z|096).*chat_activity.*\.postgres\.sql$/.test(name))
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
      phone TEXT,
      full_name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE contact_phone_numbers (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE whatsapp_api_phone_numbers (
      id TEXT PRIMARY KEY,
      phone_number TEXT,
      display_phone_number TEXT,
      qr_connected_phone TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE whatsapp_api_contacts (
      id TEXT PRIMARY KEY,
      contact_id TEXT,
      phone TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE whatsapp_api_messages (
      id TEXT PRIMARY KEY,
      whatsapp_api_contact_id TEXT,
      contact_id TEXT,
      phone TEXT,
      from_phone TEXT,
      to_phone TEXT,
      business_phone_number_id TEXT,
      business_phone TEXT,
      direction TEXT,
      message_type TEXT,
      message_timestamp TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE meta_social_messages (
      id TEXT PRIMARY KEY,
      contact_id TEXT,
      direction TEXT,
      message_timestamp TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE email_messages (
      id TEXT PRIMARY KEY,
      contact_id TEXT,
      direction TEXT,
      message_timestamp TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX idx_pg_test_whatsapp_profile ON whatsapp_api_messages(whatsapp_api_contact_id);
    CREATE INDEX idx_pg_test_whatsapp_phone ON whatsapp_api_messages(phone);
    CREATE INDEX idx_pg_test_whatsapp_from_phone ON whatsapp_api_messages(from_phone);
    CREATE INDEX idx_pg_test_whatsapp_to_phone ON whatsapp_api_messages(to_phone);
  `)
}

async function applyProjectionMigrations(client) {
  const names = await postgresProjectionMigrationNames()
  assert.ok(names.includes('096a_chat_activity_projection.postgres.sql'))

  for (const name of names) {
    const sql = await readFile(new URL(name, migrationsUrl), 'utf8')
    await client.query(sql)
  }
  return names
}

test('migraciones PostgreSQL de Chat separan trabajo concurrente y conservan sentinel/scope', async () => {
  const names = await postgresProjectionMigrationNames()
  assert.ok(names.includes('096a_chat_activity_projection.postgres.sql'))

  for (const name of names) {
    const sql = await readFile(new URL(name, migrationsUrl), 'utf8')
    const concurrentActions = sql.match(/(?:CREATE|DROP) INDEX CONCURRENTLY/gi) || []
    assert.ok(concurrentActions.length <= 1, `${name} no debe elevar el pico de disco con varios indices concurrentes`)
    if (concurrentActions.length) assert.doesNotMatch(sql, /\bBEGIN\b|\bCOMMIT\b/i)
  }

  const base = await readFile(new URL('096a_chat_activity_projection.postgres.sql', migrationsUrl), 'utf8')
  assert.match(base, /chat_message_activity/i)
  assert.match(base, /chat_contact_activity/i)
  assert.match(base, /chat_contact_scope_activity/i)
  assert.match(base, /chat_activity_projection_state/i)
  assert.match(base, /chat_activity_identity_queue/i)
  assert.match(base, /included/i)
  assert.match(base, /last_created_sort/i)
  assert.match(base, /SKIP LOCKED|chat_projection_version/i)
  assert.match(base, /ristak_chat_unresolved_phone_exists/i)
  assert.doesNotMatch(base, /(?:OLD|NEW)\.phone\s+IN\s*\(msg\.phone/i)
})

test('PostgreSQL real mantiene exactitud incremental y planes proporcionales a pagina', {
  skip: !connectionString,
  timeout: 180_000
}, async () => {
  const client = new pg.Client({ connectionString })
  const schema = `ristak_chat_activity_${randomUUID().replaceAll('-', '')}`
  await client.connect()

  try {
    await client.query(`CREATE SCHEMA "${schema}"`)
    await client.query(`SET search_path TO "${schema}", public`)
    await createSourceSchema(client)
    await applyProjectionMigrations(client)

    await client.query(`
      INSERT INTO contacts(id, phone, full_name) VALUES
        ('identity-a', '5215511111111', 'A'),
        ('identity-direct', '5215522222222', 'Direct'),
        ('identity-profile', '5215533333333', 'Profile'),
        ('identity-z', '5215511111111', 'Z');
      INSERT INTO whatsapp_api_contacts(id, contact_id, phone)
      VALUES ('wa-profile', 'identity-profile', '5215511111111');
      INSERT INTO whatsapp_api_phone_numbers(id, phone_number, display_phone_number, qr_connected_phone)
      VALUES ('business-main', '+526561000000', '+52 656 100 0000', '+5216561000000');

      INSERT INTO whatsapp_api_messages(
        id, contact_id, whatsapp_api_contact_id, phone,
        business_phone, message_type, message_timestamp, created_at
      ) VALUES
        ('wa-direct', 'identity-direct', 'wa-profile', '5215511111111',
         '+52 656 100 0000', 'text', '2100-01-01 10:00:00.123456', '2100-01-01 10:00:00.123456'),
        ('wa-profile-message', NULL, 'wa-profile', '5215511111111',
         '526561000000', 'text', '2100-01-01 10:01:00.123456', '2100-01-01 10:01:00.123456'),
        ('wa-phone', NULL, NULL, '5215511111111',
         '526561000000', 'text', '2100-01-01 10:02:00.123456', '2100-01-01 10:02:00.123456'),
        ('wa-status', 'identity-direct', NULL, '5215522222222',
         '+526561000000', 'status', '2100-01-01 10:03:00.123456', '2100-01-01 10:03:00.123456'),
        ('wa-unresolved', NULL, NULL, '5299999999999',
         '+529999999999', 'text', '2100-01-01 10:04:00.123456', '2100-01-01 10:04:00.123456');

      INSERT INTO meta_social_messages(id, contact_id, message_timestamp, created_at)
      VALUES ('meta-direct', 'identity-direct', '2100-01-01 10:05:00.223456', '2100-01-01 10:05:00.223456');
      INSERT INTO email_messages(id, contact_id, message_timestamp, created_at)
      VALUES ('email-direct', 'identity-direct', '2100-01-01 10:06:00.323456', '2100-01-01 10:06:00.323456');
    `)

    const identityRows = await client.query(`
      SELECT source_message_id, contact_id, scope_key, included
      FROM chat_message_activity
      WHERE source_kind = 'whatsapp'
      ORDER BY source_message_id
    `)
    const identity = new Map(identityRows.rows.map(row => [row.source_message_id, row]))
    assert.equal(identityRows.rowCount, 5, 'status y no-resuelto tambien dejan sentinel')
    assert.equal(identity.get('wa-direct').contact_id, 'identity-direct')
    assert.equal(identity.get('wa-profile-message').contact_id, 'identity-profile')
    assert.equal(identity.get('wa-phone').contact_id, 'identity-a')
    assert.equal(Number(identity.get('wa-status').included), 0)
    assert.equal(Number(identity.get('wa-unresolved').included), 0)
    assert.equal(identity.get('wa-direct').scope_key, 'id:business-main')
    assert.equal(identity.get('wa-profile-message').scope_key, 'id:business-main')
    assert.equal(identity.get('wa-phone').scope_key, 'id:business-main')

    let directSummary = await client.query(`
      SELECT message_count, last_source_kind, last_source_message_id
      FROM chat_contact_activity
      WHERE contact_id = 'identity-direct'
    `)
    assert.equal(Number(directSummary.rows[0].message_count), 3)
    assert.equal(
      `${directSummary.rows[0].last_source_kind}:${directSummary.rows[0].last_source_message_id}`,
      'email:email-direct'
    )

    await client.query(`
      UPDATE whatsapp_api_messages
      SET contact_id = 'identity-direct', message_timestamp = '2100-01-01 10:07:00.423456'
      WHERE id = 'wa-phone';
      DELETE FROM email_messages WHERE id = 'email-direct';
    `)
    directSummary = await client.query(`
      SELECT message_count, last_source_kind, last_source_message_id
      FROM chat_contact_activity
      WHERE contact_id = 'identity-direct'
    `)
    assert.equal(Number(directSummary.rows[0].message_count), 3)
    assert.equal(
      `${directSummary.rows[0].last_source_kind}:${directSummary.rows[0].last_source_message_id}`,
      'whatsapp:wa-phone'
    )

    // Volumen amplio en raw y summaries. Los raw quedan deliberadamente sin
    // proyeccion para que un regreso accidental al full scan sea visible.
    await client.query(`ALTER TABLE contacts DISABLE TRIGGER USER`)
    await client.query(`ALTER TABLE whatsapp_api_messages DISABLE TRIGGER USER`)
    await client.query(`ALTER TABLE chat_message_activity DISABLE TRIGGER USER`)
    await client.query(`
      INSERT INTO contacts(id, full_name, created_at, updated_at)
      SELECT 'scale-contact-' || LPAD(series::text, 6, '0'), 'Scale ' || series,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM generate_series(1, 50000) series;

      INSERT INTO whatsapp_api_messages(
        id, contact_id, business_phone_number_id, business_phone,
        message_type, message_timestamp, created_at, chat_projection_version
      )
      SELECT
        'scale-message-' || LPAD(series::text, 7, '0'),
        'scale-contact-' || LPAD(((series - 1) % 50000 + 1)::text, 6, '0'),
        CASE WHEN series % 2 = 0 THEN 'business-a' ELSE 'business-b' END,
        '+526561000000', 'text',
        TIMESTAMP '2101-01-01 00:00:00' + series * INTERVAL '1 microsecond',
        TIMESTAMP '2101-01-01 00:00:00' + series * INTERVAL '1 microsecond',
        0
      FROM generate_series(1, 250000) series;

      INSERT INTO chat_contact_activity(
        contact_id, message_count, last_message_sort, last_created_sort,
        last_source_kind, last_source_message_id
      )
      SELECT
        'scale-contact-' || LPAD(series::text, 6, '0'), 5,
        5000000000 + series, 5000000000 + series,
        'whatsapp', 'scale-message-' || LPAD((200000 + series)::text, 7, '0')
      FROM generate_series(1, 50000) series;

      INSERT INTO chat_contact_scope_activity(
        contact_id, scope_key, message_count, last_message_sort, last_created_sort,
        last_source_kind, last_source_message_id
      )
      SELECT
        'scale-contact-' || LPAD(series::text, 6, '0'),
        CASE WHEN series % 2 = 0 THEN 'id:business-a' ELSE 'id:business-b' END,
        5, 5000000000 + series, 5000000000 + series,
        'whatsapp', 'scale-message-' || LPAD((200000 + series)::text, 7, '0')
      FROM generate_series(1, 50000) series;

      INSERT INTO chat_message_activity(
        source_kind, source_message_id, included, contact_id, scope_key, direction,
        message_sort, created_sort, message_at
      )
      SELECT
        'whatsapp', 'scale-message-' || LPAD((200000 + series)::text, 7, '0'),
        1, 'scale-contact-' || LPAD(series::text, 6, '0'),
        CASE WHEN series % 2 = 0 THEN 'id:business-a' ELSE 'id:business-b' END,
        'inbound', 5000000000 + series, 5000000000 + series,
        '2101-01-01 00:00:00'
      FROM generate_series(1, 50000) series;
    `)
    await client.query(`ALTER TABLE contacts ENABLE TRIGGER USER`)
    await client.query(`ALTER TABLE whatsapp_api_messages ENABLE TRIGGER USER`)
    await client.query(`ALTER TABLE chat_message_activity ENABLE TRIGGER USER`)
    await client.query('ANALYZE contacts; ANALYZE whatsapp_api_messages; ANALYZE chat_message_activity; ANALYZE chat_contact_activity; ANALYZE chat_contact_scope_activity;')

    const identityLookupPlanResult = await client.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF)
      SELECT
        EXISTS (
          SELECT 1 FROM whatsapp_api_messages msg
          WHERE NULLIF(BTRIM(COALESCE(msg.contact_id, '')), '') IS NULL
            AND msg.phone = 'phone-without-any-message'
        ) OR EXISTS (
          SELECT 1 FROM whatsapp_api_messages msg
          WHERE NULLIF(BTRIM(COALESCE(msg.contact_id, '')), '') IS NULL
            AND msg.from_phone = 'phone-without-any-message'
        ) OR EXISTS (
          SELECT 1 FROM whatsapp_api_messages msg
          WHERE NULLIF(BTRIM(COALESCE(msg.contact_id, '')), '') IS NULL
            AND msg.to_phone = 'phone-without-any-message'
        ) OR EXISTS (
          SELECT 1
          FROM whatsapp_api_contacts profile
          JOIN whatsapp_api_messages msg ON msg.whatsapp_api_contact_id = profile.id
          WHERE NULLIF(BTRIM(COALESCE(msg.contact_id, '')), '') IS NULL
            AND NULLIF(BTRIM(COALESCE(profile.contact_id, '')), '') IS NULL
            AND profile.phone = 'phone-without-any-message'
        )
    `)
    const identityLookupPlan = identityLookupPlanResult.rows[0]['QUERY PLAN'][0]
    const identityLookupNodes = collectPlanNodes(identityLookupPlan.Plan)
    const identityMessageNodes = identityLookupNodes.filter(node => (
      node['Relation Name'] === 'whatsapp_api_messages'
    ))
    assert.ok(identityMessageNodes.length >= 4)
    assert.ok(identityMessageNodes.every(node => /Index/.test(node['Node Type'] || '')), (
      `editar/importar contactos no debe barrer mensajes: ${JSON.stringify(identityMessageNodes)}`
    ))
    const identityIndexNames = new Set(identityMessageNodes.map(node => node['Index Name']).filter(Boolean))
    for (const indexName of [
      'idx_whatsapp_api_messages_chat_unresolved_profile',
      'idx_whatsapp_api_messages_chat_unresolved_phone',
      'idx_whatsapp_api_messages_chat_unresolved_from_phone',
      'idx_whatsapp_api_messages_chat_unresolved_to_phone'
    ]) {
      assert.ok(identityIndexNames.has(indexName), `${indexName} debe proteger el trigger de identidad`)
    }
    assert.ok(
      Number(identityLookupPlan['Execution Time']) < 1000,
      `lookup de identidad al editar contacto tardo ${identityLookupPlan['Execution Time']}ms`
    )

    const editedContactPlanResult = await client.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF)
      UPDATE contacts
      SET phone = 'phone-without-any-message'
      WHERE id = 'scale-contact-000001'
    `)
    const editedContactPlan = editedContactPlanResult.rows[0]['QUERY PLAN'][0]
    assert.ok(
      Number(editedContactPlan['Execution Time']) < 1000,
      `trigger de identidad al editar contacto tardo ${editedContactPlan['Execution Time']}ms`
    )

    const pendingPlanResult = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id
      FROM whatsapp_api_messages
      WHERE chat_projection_version < 1
      ORDER BY id
      LIMIT 1000
    `)
    const pendingNodes = collectPlanNodes(pendingPlanResult.rows[0]['QUERY PLAN'][0].Plan)
    assert.ok(pendingNodes.some(node => (
      node['Index Name'] === 'idx_whatsapp_api_messages_chat_projection_pending'
    )), 'el backfill debe encontrar pendientes por indice parcial, no recorrer raw completo en cada batch')

    const globalPlanResult = await client.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF)
      SELECT activity.contact_id, activity.message_count, activity.last_message_sort
      FROM chat_contact_activity activity
      JOIN contacts contact ON contact.id = activity.contact_id
      WHERE (activity.last_message_sort, activity.contact_id) < (5000050001::numeric, 'zzzz')
      ORDER BY activity.last_message_sort DESC, activity.contact_id DESC
      LIMIT 50
    `)
    const globalPlan = globalPlanResult.rows[0]['QUERY PLAN'][0]
    const globalNodes = collectPlanNodes(globalPlan.Plan)
    const globalRelations = new Set(globalNodes.map(node => node['Relation Name']).filter(Boolean))
    assert.ok(globalRelations.has('chat_contact_activity'))
    assert.ok(!globalRelations.has('whatsapp_api_messages'))
    assert.ok(!globalRelations.has('meta_social_messages'))
    assert.ok(!globalRelations.has('email_messages'))
    assert.ok(globalNodes.some(node => /Index/.test(node['Node Type'] || '') && node['Relation Name'] === 'chat_contact_activity'))
    assert.ok(Number(globalPlan['Execution Time']) < 1000, `global page tardo ${globalPlan['Execution Time']}ms`)

    const handlerShapePlanResult = await client.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF)
      WITH chat_stats AS (
        SELECT contact_id, message_count, last_message_sort, last_created_sort,
               last_source_kind, last_source_message_id
        FROM chat_contact_activity
      ), ranked_chats AS (
        SELECT stats.*
        FROM chat_stats stats
        JOIN contacts contact ON contact.id = stats.contact_id
        WHERE (stats.last_message_sort, stats.contact_id) < (5000050001::numeric, 'zzzz')
        ORDER BY stats.last_message_sort DESC, stats.contact_id DESC
        LIMIT 50
      ), selected_activity_keys AS (
        SELECT contact_id, last_source_kind AS source_kind,
               last_source_message_id AS source_message_id
        FROM ranked_chats
        UNION
        SELECT ranked.contact_id, 'whatsapp', (
          SELECT activity.source_message_id
          FROM chat_message_activity activity
          WHERE activity.included = 1
            AND activity.source_kind = 'whatsapp'
            AND activity.contact_id = ranked.contact_id
            AND activity.direction = 'inbound'
          ORDER BY activity.message_sort DESC, activity.created_sort DESC,
                   activity.source_message_id DESC
          LIMIT 1
        )
        FROM ranked_chats ranked
        UNION
        SELECT ranked.contact_id, 'whatsapp', (
          SELECT activity.source_message_id
          FROM chat_message_activity activity
          WHERE activity.included = 1
            AND activity.source_kind = 'whatsapp'
            AND activity.contact_id = ranked.contact_id
            AND activity.direction = 'inbound'
          ORDER BY activity.message_sort, activity.created_sort,
                   activity.source_message_id
          LIMIT 1
        )
        FROM ranked_chats ranked
      ), selected_rows AS (
        SELECT keys.contact_id, message.id AS source_message_id
        FROM selected_activity_keys keys
        JOIN whatsapp_api_messages message
          ON keys.source_kind = 'whatsapp' AND message.id = keys.source_message_id
        WHERE keys.source_message_id IS NOT NULL
        UNION ALL
        SELECT keys.contact_id, message.id
        FROM selected_activity_keys keys
        JOIN meta_social_messages message
          ON keys.source_kind = 'meta' AND message.id = keys.source_message_id
        WHERE keys.source_message_id IS NOT NULL
        UNION ALL
        SELECT keys.contact_id, message.id
        FROM selected_activity_keys keys
        JOIN email_messages message
          ON keys.source_kind = 'email' AND message.id = keys.source_message_id
        WHERE keys.source_message_id IS NOT NULL
      )
      SELECT ranked.contact_id, ranked.message_count, COUNT(selected.source_message_id)
      FROM ranked_chats ranked
      LEFT JOIN selected_rows selected ON selected.contact_id = ranked.contact_id
      GROUP BY ranked.contact_id, ranked.message_count, ranked.last_message_sort
      ORDER BY ranked.last_message_sort DESC, ranked.contact_id DESC
    `)
    const handlerShapePlan = handlerShapePlanResult.rows[0]['QUERY PLAN'][0]
    const handlerNodes = collectPlanNodes(handlerShapePlan.Plan)
    const rawTableNames = new Set([
      'whatsapp_api_messages',
      'meta_social_messages',
      'email_messages'
    ])
    const rawNodes = handlerNodes.filter(node => rawTableNames.has(node['Relation Name']))
    assert.ok(rawNodes.length >= 1)
    assert.ok(
      rawNodes.every(node => /Index/.test(node['Node Type'] || '') || Number(node['Actual Rows'] || 0) === 0),
      `la hidratacion raw debe ser PK/index lookup acotado: ${JSON.stringify(rawNodes)}`
    )
    assert.ok(
      handlerNodes.some(node => /Index/.test(node['Node Type'] || '') && node['Relation Name'] === 'chat_message_activity'),
      'latest/first inbound debe usar ledger indexado sólo para los 50 ranked contacts'
    )
    assert.ok(Number(handlerShapePlan['Execution Time']) < 1000, `handler shape tardo ${handlerShapePlan['Execution Time']}ms`)

    const scopedPlanResult = await client.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF)
      WITH scope_candidates AS (
        (SELECT contact_id, message_count, last_message_sort
         FROM chat_contact_scope_activity
         WHERE scope_key = 'id:business-a'
         ORDER BY last_message_sort DESC, contact_id DESC
         LIMIT 51)
        UNION ALL
        (SELECT contact_id, message_count, last_message_sort
         FROM chat_contact_scope_activity
         WHERE scope_key = 'id:business-b'
         ORDER BY last_message_sort DESC, contact_id DESC
         LIMIT 51)
      ), candidate_contacts AS (
        SELECT DISTINCT contact_id FROM scope_candidates
      ), projected_stats_rows AS (
        SELECT scoped.*
        FROM chat_contact_scope_activity scoped
        JOIN candidate_contacts candidate ON candidate.contact_id = scoped.contact_id
        WHERE scoped.scope_key IN ('id:business-a', 'id:business-b')
      ), ranked_stats AS (
        SELECT
          contact_id,
          SUM(message_count) OVER (PARTITION BY contact_id) AS message_count,
          last_message_sort,
          last_created_sort,
          last_source_kind,
          last_source_message_id,
          ROW_NUMBER() OVER (
            PARTITION BY contact_id
            ORDER BY last_message_sort DESC, last_created_sort DESC,
                     last_source_kind DESC, last_source_message_id DESC
          ) AS row_rank
        FROM projected_stats_rows
      ), chat_stats AS (
        SELECT * FROM ranked_stats WHERE row_rank = 1
      )
      SELECT contact_id, message_count, last_message_sort
      FROM chat_stats
      ORDER BY last_message_sort DESC, contact_id DESC
      LIMIT 50
    `)
    const scopedPlan = scopedPlanResult.rows[0]['QUERY PLAN'][0]
    const scopedNodes = collectPlanNodes(scopedPlan.Plan)
    const scopedRelations = new Set(scopedNodes.map(node => node['Relation Name']).filter(Boolean))
    assert.deepEqual([...scopedRelations], ['chat_contact_scope_activity'])
    assert.ok(scopedNodes.filter(node => (
      /Index/.test(node['Node Type'] || '') && node['Relation Name'] === 'chat_contact_scope_activity'
    )).length >= 2)
    assert.ok(Number(scopedPlan['Execution Time']) < 1000, `scoped page tardo ${scopedPlan['Execution Time']}ms`)
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await client.end()
  }
})
