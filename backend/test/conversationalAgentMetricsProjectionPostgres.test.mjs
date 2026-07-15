import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import pg from 'pg'

const connectionString = String(
  process.env.CONVERSATIONAL_AGENT_METRICS_TEST_POSTGRES_URL ||
  process.env.RISTAK_TEST_POSTGRES_URL ||
  process.env.TEST_POSTGRES_URL ||
  ''
).trim()

const migrationsUrl = new URL('../migrations/versioned/', import.meta.url)
const migrationNames = [
  '098d_conversational_agent_metrics_projection.postgres.sql',
  '098e_conversational_state_metrics_pending.postgres.sql',
  '098f_conversational_event_metrics_pending.postgres.sql',
  '098g_conversational_state_paused_expiry.postgres.sql'
]

function collectPlanNodes(plan, rows = []) {
  if (!plan || typeof plan !== 'object') return rows
  rows.push(plan)
  for (const child of plan.Plans || []) collectPlanNodes(child, rows)
  return rows
}

async function createSourceSchema(client) {
  await client.query(`
    CREATE TABLE conversational_agent_state (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      signal TEXT,
      signal_at TIMESTAMP,
      last_reply_at TIMESTAMP,
      paused_until_at TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE conversational_agent_events (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      event_type TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `)
}

async function applyProjectionMigrations(client) {
  for (const name of migrationNames) {
    await client.query(await readFile(new URL(name, migrationsUrl), 'utf8'))
  }
}

test('las migraciones PG 098 dejan cada indice concurrente aislado', async () => {
  for (const [index, name] of migrationNames.entries()) {
    const sql = await readFile(new URL(name, migrationsUrl), 'utf8')
    const concurrent = sql.match(/CREATE INDEX CONCURRENTLY/gi) || []
    assert.equal(concurrent.length, index === 0 ? 0 : 1, name)
    if (concurrent.length) assert.doesNotMatch(sql, /\bBEGIN\b|\bCOMMIT\b/i)
  }
})

test('PostgreSQL real conserva exactitud incremental y fast path O(agentes + 64)', {
  skip: !connectionString,
  timeout: 180_000
}, async () => {
  const client = new pg.Client({ connectionString })
  const schema = `ristak_agent_metrics_${randomUUID().replaceAll('-', '')}`
  await client.connect()

  try {
    await client.query(`CREATE SCHEMA "${schema}"`)
    await client.query(`SET search_path TO "${schema}", public`)
    await createSourceSchema(client)
    await applyProjectionMigrations(client)

    await client.query(`
      INSERT INTO conversational_agent_state(
        id, agent_id, status, signal, last_reply_at, updated_at
      ) VALUES
        ('exact-a-active', 'agent-a', 'active', NULL, '2100-01-01 10:00:00', '2100-01-01 10:01:00'),
        ('exact-a-completed', 'agent-a', 'completed', 'ready_to_buy', NULL, '2100-01-01 10:05:00'),
        ('exact-b-discarded', 'agent-b', 'human', 'discarded', NULL, '2100-01-01 10:03:00'),
        ('exact-sentinel', NULL, 'active', NULL, NULL, '2100-01-01 10:04:00');

      INSERT INTO conversational_agent_events(id, agent_id, event_type) VALUES
        ('exact-event-reply', 'agent-a', 'reply_sent'),
        ('exact-event-tool', 'agent-a', 'custom_tool_failed_runtime'),
        ('exact-event-preview', 'agent-a', 'appointment_slot_preview_offer_created');
    `)

    let stateSummary = await client.query(`
      SELECT * FROM conversational_agent_state_metric_summary ORDER BY agent_id
    `)
    assert.equal(stateSummary.rowCount, 2)
    assert.equal(Number(stateSummary.rows[0].total_conversations), 2)
    assert.equal(Number(stateSummary.rows[0].assigned_conversations), 1)
    assert.equal(Number(stateSummary.rows[0].completed_conversations), 1)
    assert.equal(Number(stateSummary.rows[1].human_takeovers), 1)
    assert.equal(Number(stateSummary.rows[1].discarded_conversations), 1)

    const sentinels = await client.query(`
      SELECT
        (SELECT included FROM conversational_agent_state_metric_rows WHERE state_id = 'exact-sentinel') AS state_included,
        (SELECT included FROM conversational_agent_event_metric_rows WHERE event_id = 'exact-event-preview') AS event_included
    `)
    assert.equal(Number(sentinels.rows[0].state_included), 0)
    assert.equal(Number(sentinels.rows[0].event_included), 0)

    let eventSummary = await client.query(`
      SELECT SUM(total_events) AS total_events,
             SUM(reply_events) AS reply_events,
             SUM(error_events) AS error_events,
             SUM(tool_failure_events) AS tool_failure_events
      FROM conversational_agent_event_metric_summary
    `)
    assert.deepEqual(eventSummary.rows[0], {
      total_events: '2',
      reply_events: '1',
      error_events: '1',
      tool_failure_events: '1'
    })

    await client.query(`
      UPDATE conversational_agent_state
      SET agent_id = 'agent-b', status = 'active', signal = NULL,
          updated_at = '2100-01-01 10:06:00'
      WHERE id = 'exact-a-completed';
      UPDATE conversational_agent_events
      SET event_type = 'appointment_slot_preview_offer_created'
      WHERE id = 'exact-event-tool';
    `)
    stateSummary = await client.query(`
      SELECT *, TO_CHAR(last_activity_at, 'YYYY-MM-DD HH24:MI:SS') AS last_activity_text
      FROM conversational_agent_state_metric_summary
      ORDER BY agent_id
    `)
    assert.equal(Number(stateSummary.rows[0].total_conversations), 1)
    assert.equal(stateSummary.rows[0].last_activity_text, '2100-01-01 10:01:00')
    assert.equal(Number(stateSummary.rows[1].assigned_conversations), 1)
    assert.equal(stateSummary.rows[1].last_activity_text, '2100-01-01 10:06:00')

    await client.query(`
      DELETE FROM conversational_agent_state WHERE id = 'exact-a-completed';
      DELETE FROM conversational_agent_events WHERE id = 'exact-event-reply';
    `)
    stateSummary = await client.query(`
      SELECT *, TO_CHAR(last_activity_at, 'YYYY-MM-DD HH24:MI:SS') AS last_activity_text
      FROM conversational_agent_state_metric_summary
      ORDER BY agent_id
    `)
    assert.equal(Number(stateSummary.rows[1].assigned_conversations), 0)
    assert.equal(stateSummary.rows[1].last_activity_text, '2100-01-01 10:03:00')
    eventSummary = await client.query(`
      SELECT COALESCE(SUM(total_events), 0) AS total_events
      FROM conversational_agent_event_metric_summary
    `)
    assert.equal(eventSummary.rows[0].total_events, '0')

    // Historial grande ya convergido: 100k conversaciones y 300k eventos.
    // Se carga set-based con triggers apagados y luego se materializa el mismo
    // ledger/summary que produciria el worker, para medir el plan sin gastar el
    // tiempo de la prueba en 400k upserts fila-por-fila.
    await client.query(`
      ALTER TABLE conversational_agent_state DISABLE TRIGGER USER;
      ALTER TABLE conversational_agent_events DISABLE TRIGGER USER;
      ALTER TABLE conversational_agent_state_metric_rows DISABLE TRIGGER USER;
      ALTER TABLE conversational_agent_event_metric_rows DISABLE TRIGGER USER;

      INSERT INTO conversational_agent_state(
        id, agent_id, status, signal, last_reply_at, updated_at,
        agent_metrics_projection_version
      )
      SELECT
        'scale-state-' || LPAD(series::text, 7, '0'),
        'scale-agent-' || LPAD(((series - 1) % 100)::text, 3, '0'),
        CASE
          WHEN series % 11 = 0 THEN 'completed'
          WHEN series % 13 = 0 THEN 'paused'
          WHEN series % 17 = 0 THEN 'human'
          WHEN series % 19 = 0 THEN 'skipped'
          ELSE 'active'
        END,
        CASE WHEN series % 23 = 0 THEN 'discarded' ELSE NULL END,
        CASE WHEN series % 2 = 0
          THEN TIMESTAMP '2101-01-01 00:00:00' + series * INTERVAL '1 microsecond'
          ELSE NULL END,
        TIMESTAMP '2101-02-01 00:00:00' + series * INTERVAL '1 microsecond',
        1
      FROM generate_series(1, 100000) series;

      INSERT INTO conversational_agent_state_metric_rows(
        state_id, projection_version, included, agent_id, total_conversations,
        assigned_conversations, completed_conversations, paused_conversations,
        human_takeovers, skipped_conversations, discarded_conversations,
        answered_conversations, activity_at
      )
      SELECT state_id, projection_version, included, agent_id, total_conversations,
             assigned_conversations, completed_conversations, paused_conversations,
             human_takeovers, skipped_conversations, discarded_conversations,
             answered_conversations, activity_at
      FROM ristak_conversational_state_metric_source
      WHERE state_id LIKE 'scale-state-%';

      INSERT INTO conversational_agent_state_metric_summary(
        agent_id, total_conversations, assigned_conversations,
        completed_conversations, paused_conversations, human_takeovers,
        skipped_conversations, discarded_conversations, answered_conversations,
        last_activity_at, last_activity_state_id
      )
      SELECT
        agent_id,
        SUM(total_conversations), SUM(assigned_conversations),
        SUM(completed_conversations), SUM(paused_conversations), SUM(human_takeovers),
        SUM(skipped_conversations), SUM(discarded_conversations), SUM(answered_conversations),
        MAX(activity_at),
        (ARRAY_AGG(state_id ORDER BY activity_at DESC NULLS LAST, state_id DESC))[1]
      FROM conversational_agent_state_metric_rows
      WHERE state_id LIKE 'scale-state-%'
      GROUP BY agent_id;

      INSERT INTO conversational_agent_events(
        id, agent_id, event_type, agent_metrics_projection_version
      )
      SELECT
        'scale-event-' || LPAD(series::text, 7, '0'),
        'scale-agent-' || LPAD(((series - 1) % 100)::text, 3, '0'),
        CASE
          WHEN series % 29 = 0 THEN 'custom_tool_failed_runtime'
          WHEN series % 17 = 0 THEN 'signal_set'
          WHEN series % 7 = 0 THEN 'reply_sent'
          ELSE 'agent_assigned'
        END,
        1
      FROM generate_series(1, 300000) series;

      INSERT INTO conversational_agent_event_metric_rows(
        event_id, projection_version, included, summary_shard, total_events,
        success_events, error_events, assigned_events, reply_events,
        appointment_events, payment_link_events, goal_completion_events,
        follow_up_sent_events, follow_up_suppressed_events, human_handoff_events,
        tool_failure_events
      )
      SELECT event_id, projection_version, included, summary_shard, total_events,
             success_events, error_events, assigned_events, reply_events,
             appointment_events, payment_link_events, goal_completion_events,
             follow_up_sent_events, follow_up_suppressed_events, human_handoff_events,
             tool_failure_events
      FROM ristak_conversational_event_metric_source
      WHERE event_id LIKE 'scale-event-%';

      INSERT INTO conversational_agent_event_metric_summary(
        summary_shard, total_events, success_events, error_events,
        assigned_events, reply_events, appointment_events, payment_link_events,
        goal_completion_events, follow_up_sent_events, follow_up_suppressed_events,
        human_handoff_events, tool_failure_events
      )
      SELECT
        summary_shard, SUM(total_events), SUM(success_events), SUM(error_events),
        SUM(assigned_events), SUM(reply_events), SUM(appointment_events), SUM(payment_link_events),
        SUM(goal_completion_events), SUM(follow_up_sent_events), SUM(follow_up_suppressed_events),
        SUM(human_handoff_events), SUM(tool_failure_events)
      FROM conversational_agent_event_metric_rows
      WHERE event_id LIKE 'scale-event-%'
      GROUP BY summary_shard;

      ALTER TABLE conversational_agent_state ENABLE TRIGGER USER;
      ALTER TABLE conversational_agent_events ENABLE TRIGGER USER;
      ALTER TABLE conversational_agent_state_metric_rows ENABLE TRIGGER USER;
      ALTER TABLE conversational_agent_event_metric_rows ENABLE TRIGGER USER;

      UPDATE conversational_agent_metrics_projection_state
      SET status = 'ready', updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = 1;

      ANALYZE conversational_agent_state;
      ANALYZE conversational_agent_events;
      ANALYZE conversational_agent_state_metric_rows;
      ANALYZE conversational_agent_state_metric_summary;
      ANALYZE conversational_agent_event_metric_rows;
      ANALYZE conversational_agent_event_metric_summary;
    `)

    const pendingStatePlanResult = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id FROM conversational_agent_state
      WHERE agent_metrics_projection_version < 1
      ORDER BY id
      LIMIT 1000
    `)
    const pendingStateNodes = collectPlanNodes(pendingStatePlanResult.rows[0]['QUERY PLAN'][0].Plan)
    assert.ok(pendingStateNodes.some(node => (
      node['Index Name'] === 'idx_conversational_agent_state_metrics_pending'
    )))

    const pendingEventPlanResult = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id FROM conversational_agent_events
      WHERE agent_metrics_projection_version < 1
      ORDER BY id
      LIMIT 1000
    `)
    const pendingEventNodes = collectPlanNodes(pendingEventPlanResult.rows[0]['QUERY PLAN'][0].Plan)
    assert.ok(pendingEventNodes.some(node => (
      node['Index Name'] === 'idx_conversational_agent_events_metrics_pending'
    )))

    const pausedExpiryPlanResult = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id, agent_id
      FROM conversational_agent_state
      WHERE status = 'paused'
        AND paused_until_at IS NOT NULL
        AND paused_until_at <= TIMESTAMP '2200-01-01 00:00:00'
      LIMIT 500
    `)
    const pausedExpiryNodes = collectPlanNodes(pausedExpiryPlanResult.rows[0]['QUERY PLAN'][0].Plan)
    assert.ok(pausedExpiryNodes.some(node => (
      node['Index Name'] === 'idx_conversational_agent_state_paused_expiry'
    )), 'abrir metricas no debe recorrer todos los estados pausados')

    const stateFastPlanResult = await client.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF)
      SELECT agent_id, total_conversations, assigned_conversations,
             completed_conversations, paused_conversations, human_takeovers,
             skipped_conversations, discarded_conversations, answered_conversations,
             last_activity_at
      FROM conversational_agent_state_metric_summary
      ORDER BY agent_id
    `)
    const stateFastPlan = stateFastPlanResult.rows[0]['QUERY PLAN'][0]
    const stateFastNodes = collectPlanNodes(stateFastPlan.Plan)
    const stateRelations = new Set(stateFastNodes.map(node => node['Relation Name']).filter(Boolean))
    assert.deepEqual([...stateRelations], ['conversational_agent_state_metric_summary'])
    assert.equal(Number(stateFastPlan.Plan['Actual Rows']), 102)
    assert.ok(Number(stateFastPlan['Execution Time']) < 1000)

    const eventFastPlanResult = await client.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, COSTS OFF)
      SELECT SUM(total_events), SUM(success_events), SUM(error_events),
             SUM(assigned_events), SUM(reply_events), SUM(appointment_events),
             SUM(payment_link_events), SUM(goal_completion_events),
             SUM(follow_up_sent_events), SUM(follow_up_suppressed_events),
             SUM(human_handoff_events), SUM(tool_failure_events)
      FROM conversational_agent_event_metric_summary
    `)
    const eventFastPlan = eventFastPlanResult.rows[0]['QUERY PLAN'][0]
    const eventFastNodes = collectPlanNodes(eventFastPlan.Plan)
    const eventRelations = new Set(eventFastNodes.map(node => node['Relation Name']).filter(Boolean))
    assert.deepEqual([...eventRelations], ['conversational_agent_event_metric_summary'])
    const summaryScan = eventFastNodes.find(node => (
      node['Relation Name'] === 'conversational_agent_event_metric_summary'
    ))
    assert.ok(Number(summaryScan['Actual Rows']) <= 64)
    assert.ok(Number(eventFastPlan['Execution Time']) < 1000)
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await client.end()
  }
})
