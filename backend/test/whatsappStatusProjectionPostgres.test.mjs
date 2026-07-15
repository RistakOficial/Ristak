import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import pg from 'pg'

import {
  rebuildWhatsAppStatusProjection,
  scheduleWhatsAppStatusProjectionBackfill
} from '../src/services/whatsappStatusProjectionService.js'

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
const cutoverLockMigrationUrl = new URL(
  '../migrations/versioned/112a_whatsapp_status_projection_cutover_lock.postgres.sql',
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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function withDeadline(promise, timeoutMs, label) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} excedió ${timeoutMs}ms`)), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForPostgresLock(observer, pid, queryPattern, label) {
  const deadline = Date.now() + 5_000
  let lastActivity = null
  while (Date.now() < deadline) {
    const result = await observer.query(`
      SELECT state, wait_event_type, wait_event, query
      FROM pg_stat_activity
      WHERE pid = $1
    `, [pid])
    lastActivity = result.rows[0] || null
    if (
      lastActivity?.wait_event_type === 'Lock' &&
      queryPattern.test(String(lastActivity.query || ''))
    ) {
      return lastActivity
    }
    await delay(20)
  }
  assert.fail(`${label}: no llegó al lock esperado. Actividad: ${JSON.stringify(lastActivity)}`)
}

async function createRoutingProjectionFixture(prefix) {
  const client = new pg.Client({ connectionString })
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`
  await client.connect()
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
  `)
  await client.query(await readFile(migrationUrl, 'utf8'))
  await client.query(await readFile(routingIndexMigrationUrl, 'utf8'))
  await client.query(await readFile(cutoverLockMigrationUrl, 'utf8'))

  return {
    client,
    schema,
    async connect(applicationName) {
      const connection = new pg.Client({ connectionString, application_name: applicationName })
      await connection.connect()
      await connection.query(`SET search_path TO "${schema}", public`)
      await connection.query("SET deadlock_timeout = '100ms'")
      await connection.query("SET statement_timeout = '8000ms'")
      return connection
    },
    async cleanup() {
      await client.query('SET search_path TO public').catch(() => undefined)
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
      await client.end().catch(() => undefined)
    }
  }
}

test('status WhatsApp ready no vuelve a escribir, drenar ni encolar el backfill', async () => {
  const reads = []
  let scheduled = 0
  const database = {
    async get(sql) {
      reads.push(String(sql))
      return { projection_version: 1, status: 'ready' }
    },
    async transaction() {
      assert.fail('ready no debe abrir una transacción de backfill')
    }
  }

  const rebuilt = await rebuildWhatsAppStatusProjection({ database, dialect: 'postgres' })
  assert.deepEqual(rebuilt, {
    ready: true,
    processed: 0,
    skipped: true,
    alreadyReady: true,
    reason: 'ready'
  })

  const queued = await scheduleWhatsAppStatusProjectionBackfill({
    database,
    dialect: 'postgres',
    scheduleJob() {
      scheduled += 1
      return { scheduled: true }
    }
  })
  assert.deepEqual(queued, { scheduled: false, ready: true, reason: 'ready' })
  assert.equal(scheduled, 0)
  assert.equal(reads.length, 2)

  const source = await readFile(
    new URL('../src/services/whatsappStatusProjectionService.js', import.meta.url),
    'utf8'
  )
  assert.doesNotMatch(source, /setInterval\s*\(/)
  assert.match(source, /PROJECTION_RETRY_MAX_MS/)
  assert.match(source, /delayMs\s*\*\s*2/)
  assert.match(source, /Number\(result\.processed \|\| 0\) > 0[\s\S]*projectionRetryDelayMs = PROJECTION_RETRY_MIN_MS/)

  const cutoverMigration = await readFile(cutoverLockMigrationUrl, 'utf8')
  assert.match(cutoverMigration, /FROM whatsapp_status_projection_state[\s\S]*FOR SHARE/i)
  assert.match(cutoverMigration, /BEFORE INSERT OR UPDATE OR DELETE ON whatsapp_routing_events/i)
  assert.match(cutoverMigration, /status = 'ready'/i)
})

test('status WhatsApp respeta ready aunque cambie mientras toma el candado', async () => {
  let transactions = 0
  const database = {
    async get() {
      return { projection_version: 1, status: 'replaying' }
    },
    async transaction(callback) {
      transactions += 1
      return callback({
        async get() {
          return { projection_version: 1, status: 'ready' }
        },
        async all() {
          assert.fail('ready no debe leer colas de deltas')
        },
        async run() {
          assert.fail('ready no debe escribir la proyección')
        }
      })
    }
  }

  const result = await rebuildWhatsAppStatusProjection({ database, dialect: 'postgres' })
  assert.equal(result.ready, true)
  assert.equal(result.processed, 0)
  assert.equal(result.alreadyReady, true)
  assert.equal(transactions, 1)
})

test('PostgreSQL: routing writer-first durante baseline converge exacto sin deadlock', {
  skip: !connectionString,
  timeout: 30_000
}, async () => {
  const fixture = await createRoutingProjectionFixture('ristak_wa_baseline_race')
  const writer = await fixture.connect('ristak-wa-baseline-writer')
  const worker = await fixture.connect('ristak-wa-baseline-worker')
  let writerTransactionOpen = false
  let workerPromise = null

  try {
    await writer.query('BEGIN')
    writerTransactionOpen = true
    await writer.query(`
      INSERT INTO whatsapp_routing_events (
        id, contact_id, previous_phone_number_id, new_phone_number_id, source, created_at
      ) VALUES (
        'baseline_concurrent_route', 'baseline_contact',
        'phone_before_baseline', 'phone_after_baseline', 'contingency', '2099-01-01'
      )
    `)

    workerPromise = rebuildWhatsAppStatusProjection({
      database: createAdapter(worker),
      dialect: 'postgres'
    })
    const blocked = await waitForPostgresLock(
      fixture.client,
      worker.processID,
      /whatsapp_status_projection_state[\s\S]*FOR UPDATE/i,
      'el baseline debe terminar antes de esperar el singleton del writer'
    )
    assert.match(String(blocked.wait_event || ''), /transactionid|tuple/i)
    assert.equal((await fixture.client.query(`
      SELECT status FROM whatsapp_status_projection_state WHERE singleton_id = 1
    `)).rows[0].status, 'backfilling')

    await writer.query('COMMIT')
    writerTransactionOpen = false
    const result = await withDeadline(workerPromise, 10_000, 'baseline concurrente')
    assert.equal(result.ready, true)

    const snapshot = await fixture.client.query(`
      SELECT state.status,
             latest.latest_event_id,
             latest.previous_phone_number_id,
             latest.new_phone_number_id,
             latest.source,
             COALESCE(restores.contact_count, 0)::int AS restore_count,
             (SELECT COUNT(*)::int FROM whatsapp_status_routing_deltas WHERE applied = FALSE) AS pending
      FROM whatsapp_status_projection_state state
      LEFT JOIN whatsapp_routing_latest_projection latest
        ON latest.contact_id = 'baseline_contact'
      LEFT JOIN whatsapp_contingency_restore_counts restores
        ON restores.previous_phone_number_id = 'phone_before_baseline'
      WHERE state.singleton_id = 1
    `)
    assert.deepEqual(snapshot.rows[0], {
      status: 'ready',
      latest_event_id: 'baseline_concurrent_route',
      previous_phone_number_id: 'phone_before_baseline',
      new_phone_number_id: 'phone_after_baseline',
      source: 'contingency',
      restore_count: 1,
      pending: 0
    })
  } finally {
    if (writerTransactionOpen) await writer.query('ROLLBACK').catch(() => undefined)
    await workerPromise?.catch(() => undefined)
    await Promise.all([
      writer.end().catch(() => undefined),
      worker.end().catch(() => undefined)
    ])
    await fixture.cleanup()
  }
})

test('PostgreSQL: finalizer writer-first conserva el ultimo delta y converge a ready sin deadlock', {
  skip: !connectionString,
  timeout: 30_000
}, async () => {
  const fixture = await createRoutingProjectionFixture('ristak_wa_finalizer_race')
  const writer = await fixture.connect('ristak-wa-finalizer-writer')
  const worker = await fixture.connect('ristak-wa-finalizer-worker')
  let writerTransactionOpen = false
  let workerPromise = null

  try {
    const initial = await rebuildWhatsAppStatusProjection({
      database: createAdapter(fixture.client),
      dialect: 'postgres'
    })
    assert.equal(initial.ready, true)
    await fixture.client.query(`
      UPDATE whatsapp_status_projection_state
      SET status = 'replaying', updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = 1
    `)

    // El writer toma primero FOR SHARE sobre el singleton y conserva su delta
    // sin commit. El worker debe drenar lo visible, soltar cualquier lock de
    // routing y sólo entonces esperar FOR UPDATE en una transacción separada.
    await writer.query('BEGIN')
    writerTransactionOpen = true
    await writer.query(`
      INSERT INTO whatsapp_routing_events (
        id, contact_id, previous_phone_number_id, new_phone_number_id, source, created_at
      ) VALUES (
        'finalizer_concurrent_route', 'finalizer_contact',
        'phone_before_finalizer', 'phone_after_finalizer', 'manual', '2099-02-01'
      )
    `)

    workerPromise = rebuildWhatsAppStatusProjection({
      database: createAdapter(worker),
      dialect: 'postgres'
    })
    const blocked = await waitForPostgresLock(
      fixture.client,
      worker.processID,
      /whatsapp_status_projection_state[\s\S]*FOR UPDATE/i,
      'el finalizer debe esperar al writer sin conservar locks de routing'
    )
    assert.match(String(blocked.wait_event || ''), /transactionid|tuple/i)

    await writer.query('COMMIT')
    writerTransactionOpen = false
    const firstPass = await withDeadline(workerPromise, 10_000, 'finalizer writer-first')
    assert.equal(firstPass.ready, false)
    assert.equal(firstPass.pending, true)
    assert.equal((await fixture.client.query(`
      SELECT status FROM whatsapp_status_projection_state WHERE singleton_id = 1
    `)).rows[0].status, 'replaying')
    assert.equal(Number((await fixture.client.query(`
      SELECT COUNT(*) AS total
      FROM whatsapp_status_routing_deltas
      WHERE applied = FALSE
    `)).rows[0].total), 1, 'el finalizer no debe perder el delta que ganó la carrera')

    const converged = await withDeadline(rebuildWhatsAppStatusProjection({
      database: createAdapter(worker),
      dialect: 'postgres'
    }), 10_000, 'drenado del último delta')
    assert.equal(converged.ready, true)

    const snapshot = await fixture.client.query(`
      SELECT state.status,
             latest.latest_event_id,
             latest.previous_phone_number_id,
             latest.new_phone_number_id,
             latest.source,
             (SELECT COUNT(*)::int FROM whatsapp_status_routing_deltas WHERE applied = FALSE) AS pending
      FROM whatsapp_status_projection_state state
      LEFT JOIN whatsapp_routing_latest_projection latest
        ON latest.contact_id = 'finalizer_contact'
      WHERE state.singleton_id = 1
    `)
    assert.deepEqual(snapshot.rows[0], {
      status: 'ready',
      latest_event_id: 'finalizer_concurrent_route',
      previous_phone_number_id: 'phone_before_finalizer',
      new_phone_number_id: 'phone_after_finalizer',
      source: 'manual',
      pending: 0
    })
  } finally {
    if (writerTransactionOpen) await writer.query('ROLLBACK').catch(() => undefined)
    await workerPromise?.catch(() => undefined)
    await Promise.all([
      writer.end().catch(() => undefined),
      worker.end().catch(() => undefined)
    ])
    await fixture.cleanup()
  }
})

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
    await client.query(await readFile(cutoverLockMigrationUrl, 'utf8'))
    assert.equal((await client.query(`
      SELECT status FROM whatsapp_status_projection_state WHERE singleton_id = 1
    `)).rows[0].status, 'backfilling', 'una base nueva no debe saltarse el baseline')
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

    // Reproduce de forma determinista la ventana que antes dejaba deltas
    // huérfanos: el worker ya certificó las colas y sostiene FOR UPDATE mientras
    // un mensaje intenta decidir si escribe delta o contador vivo.
    await client.query(`
      UPDATE whatsapp_status_projection_state
      SET status = 'replaying', updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = 1
    `)
    const cutoverClient = new pg.Client({ connectionString })
    const writerClient = new pg.Client({ connectionString })
    await Promise.all([cutoverClient.connect(), writerClient.connect()])
    try {
      await cutoverClient.query(`SET search_path TO "${schema}", public`)
      await writerClient.query(`SET search_path TO "${schema}", public`)
      await cutoverClient.query('BEGIN')
      await cutoverClient.query(`
        SELECT status
        FROM whatsapp_status_projection_state
        WHERE singleton_id = 1
        FOR UPDATE
      `)

      let writerSettled = false
      const writerPromise = writerClient.query(`
        INSERT INTO whatsapp_api_messages (id, direction)
        VALUES ('cutover_race_message', 'inbound')
      `).finally(() => {
        writerSettled = true
      })

      await new Promise(resolve => setTimeout(resolve, 100))
      assert.equal(writerSettled, false, 'el trigger debe esperar el corte atómico del worker')

      await cutoverClient.query(`
        UPDATE whatsapp_status_projection_state
        SET status = 'ready', updated_at = CURRENT_TIMESTAMP
        WHERE singleton_id = 1
      `)
      await cutoverClient.query('COMMIT')
      await writerPromise

      assert.equal(Number((await client.query(`
        SELECT COUNT(*) AS total
        FROM whatsapp_status_metric_deltas
        WHERE applied = FALSE
      `)).rows[0].total), 0, 'el evento posterior al corte no debe quedar varado como delta')
      const raceCounts = new Map((await client.query(`
        SELECT metric, SUM(counter_value)::bigint AS total
        FROM whatsapp_status_metric_counters
        WHERE metric IN ('messages', 'inbound_messages')
        GROUP BY metric
      `)).rows.map(row => [row.metric, Number(row.total)]))
      assert.equal(raceCounts.get('messages'), 300001)
      assert.equal(raceCounts.get('inbound_messages'), 150001)
    } finally {
      await cutoverClient.query('ROLLBACK').catch(() => undefined)
      await Promise.all([
        cutoverClient.end().catch(() => undefined),
        writerClient.end().catch(() => undefined)
      ])
    }

    await client.query("DELETE FROM whatsapp_api_messages WHERE id = 'cutover_race_message'")

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
