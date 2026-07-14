import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import pg from 'pg'

const connectionString = process.env.RISTAK_TEST_POSTGRES_URL || ''
const migrationNames = [
  '050a_sessions_started_at_id.postgres.sql',
  '052_tracking_search_pg_trgm.postgres.sql',
  '053_tracking_search_document_trgm.postgres.sql',
  '060d_report_contacts_search_trgm.postgres.sql',
  '070a_campaign_performance_materialized_cache.postgres.sql',
  '071a_payment_lists_cursor_summary.postgres.sql',
  '071b_subscriptions_cursor_next.postgres.sql',
  '071c_subscriptions_cursor_name.postgres.sql',
  '071d_subscriptions_cursor_contact.postgres.sql',
  '071e_subscriptions_cursor_amount.postgres.sql',
  '071f_subscriptions_cursor_updated.postgres.sql',
  '071g_subscriptions_cursor_status.postgres.sql',
  '071h_subscriptions_cursor_interval.postgres.sql',
  '071i_subscriptions_cursor_method.postgres.sql',
  '071j_subscriptions_cursor_created.postgres.sql',
  '071k_payment_plans_total_cursor.postgres.sql',
  '071l_payment_plans_email_cursor.postgres.sql',
  '080a_tracking_visitor_projection.postgres.sql',
  '080b_tracking_visitor_projection_backfill.postgres.sql',
  '080c_tracking_visitor_key_started.postgres.sql',
  '080d_tracking_visitor_key_created.postgres.sql',
  '080e_tracking_campaign_started_page.postgres.sql',
  '080f_tracking_adset_started_page.postgres.sql',
  '080g_tracking_ad_started_page.postgres.sql',
  '080h_tracking_contacts_search.postgres.sql',
  '080i_tracking_contacts_created_page.postgres.sql',
  '080j_tracking_sessions_contact_created_page.postgres.sql',
  '080k_tracking_visitor_latest_visitor.postgres.sql',
  '081a_report_transaction_summary_cache.postgres.sql',
  '081b_report_transaction_effective_at.postgres.sql',
  '090a_automation_trigger_index.postgres.sql'
]

test('cada índice concurrente 071 vive en su propia migración PostgreSQL', async () => {
  const base = await readFile(
    new URL('../migrations/versioned/071a_payment_lists_cursor_summary.postgres.sql', import.meta.url),
    'utf8'
  )
  assert.doesNotMatch(base, /CREATE INDEX CONCURRENTLY/)

  for (const name of migrationNames.filter(name => /^071[b-l]_/.test(name))) {
    const sql = await readFile(new URL(`../migrations/versioned/${name}`, import.meta.url), 'utf8')
    assert.equal((sql.match(/CREATE INDEX CONCURRENTLY/g) || []).length, 1, `${name} debe crear exactamente un índice`)
  }
})

test('los índices concurrentes 080/081 viven en migraciones unitarias', async () => {
  const baseNames = [
    '080a_tracking_visitor_projection.postgres.sql',
    '081a_report_transaction_summary_cache.postgres.sql'
  ]
  for (const name of baseNames) {
    const sql = await readFile(new URL(`../migrations/versioned/${name}`, import.meta.url), 'utf8')
    assert.doesNotMatch(sql, /CREATE INDEX CONCURRENTLY/)
  }

  const concurrentNames = migrationNames.filter(name => /^080[b-k]_/.test(name) || name.startsWith('081b_'))
  for (const name of concurrentNames) {
    const sql = await readFile(new URL(`../migrations/versioned/${name}`, import.meta.url), 'utf8')
    assert.equal((sql.match(/CREATE INDEX CONCURRENTLY/g) || []).length, 1, `${name} debe crear exactamente un índice`)
  }
})

test('la cadena 050/070/071/080/081/090 aplica en PostgreSQL real sin encerrar índices concurrentes', {
  skip: !connectionString
}, async () => {
  const client = new pg.Client({ connectionString })
  const schema = `ristak_perf_${randomUUID().replaceAll('-', '')}`
  await client.connect()

  try {
    await client.query(`CREATE SCHEMA "${schema}"`)
    await client.query(`SET search_path TO "${schema}"`)
    await client.query(`
      CREATE TABLE meta_ads (
        id BIGSERIAL PRIMARY KEY, date TEXT, campaign_id TEXT, campaign_name TEXT,
        adset_id TEXT, adset_name TEXT, ad_id TEXT, ad_name TEXT,
        creative_id TEXT, creative_type TEXT, creative_thumbnail_url TEXT,
        creative_image_url TEXT, creative_video_id TEXT, creative_video_url TEXT,
        creative_preview_url TEXT, spend DOUBLE PRECISION, reach BIGINT, clicks BIGINT,
        cpc DOUBLE PRECISION, cpm DOUBLE PRECISION, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY, attribution_ad_id TEXT, created_at TIMESTAMP,
        updated_at TIMESTAMP, purchases_count INTEGER, total_paid DOUBLE PRECISION,
        appointment_date TIMESTAMP, full_name TEXT, email TEXT, phone TEXT, source TEXT,
        deleted_at TIMESTAMP
      );
      CREATE TABLE payments (
        id TEXT PRIMARY KEY, contact_id TEXT, status TEXT, amount DOUBLE PRECISION,
        payment_mode TEXT, date TIMESTAMPTZ, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
      );
      CREATE TABLE appointments (
        id TEXT PRIMARY KEY, contact_id TEXT, calendar_id TEXT, status TEXT,
        appointment_status TEXT, date_updated TIMESTAMP
      );
      CREATE TABLE appointment_attendance_signals (
        id TEXT PRIMARY KEY, contact_id TEXT, appointment_id TEXT, updated_at TIMESTAMP
      );
      CREATE TABLE sessions (
        id UUID PRIMARY KEY, session_id TEXT, visitor_id TEXT, contact_id TEXT,
        full_name TEXT, email TEXT, event_name TEXT, page_url TEXT, referrer_url TEXT,
        utm_source TEXT, utm_campaign TEXT, utm_content TEXT, site_name TEXT,
        campaign_id TEXT, adset_id TEXT, ad_id TEXT, started_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ
      );
      CREATE TABLE subscriptions (
        id TEXT PRIMARY KEY, name TEXT, contact_name TEXT, status TEXT,
        amount DOUBLE PRECISION, interval_type TEXT, payment_method TEXT,
        next_run_at TIMESTAMP, created_at TIMESTAMP, updated_at TIMESTAMP
      );
      CREATE TABLE payment_plans (
        id TEXT PRIMARY KEY, total DOUBLE PRECISION, email TEXT,
        next_run_at TIMESTAMP, created_at TIMESTAMP, updated_at TIMESTAMP
      );
      CREATE TABLE automations (
        id TEXT PRIMARY KEY, name TEXT, status TEXT,
        flow JSONB, published_flow JSONB,
        created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, published_at TIMESTAMPTZ
      );
    `)

    for (const name of migrationNames) {
      const sql = await readFile(new URL(`../migrations/versioned/${name}`, import.meta.url), 'utf8')
      if (sql.includes('CREATE INDEX CONCURRENTLY')) {
        assert.equal((sql.match(/CREATE INDEX CONCURRENTLY/g) || []).length, 1, `${name} debe contener un solo índice concurrente`)
      }
      try {
        await client.query(sql)
      } catch (error) {
        error.message = `${name}: ${error.message}`
        throw error
      }
    }

    const installedIndexes = await client.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = $1 AND indexname LIKE 'idx_subscriptions_cursor_%'
    `, [schema])
    assert.equal(installedIndexes.rows.length, 9)
    const automationIndexState = await client.query(
      'SELECT status, index_version FROM automation_trigger_index_state WHERE id = 1'
    )
    assert.equal(automationIndexState.rows[0].status, 'pending')
    assert.equal(Number(automationIndexState.rows[0].index_version), 1)

    await client.query('SET enable_seqscan = off')
    const trackingPlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id FROM sessions
      WHERE (started_at, id) < (CURRENT_TIMESTAMP, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
      ORDER BY started_at DESC, id DESC
      LIMIT 50
    `)
    assert.match(JSON.stringify(trackingPlan.rows[0]['QUERY PLAN']), /Index Cond/)

    const subscriptionPlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id FROM subscriptions
      WHERE COALESCE(status, '') <> 'deleted'
        AND (
          CASE WHEN next_run_at IS NULL THEN 1 ELSE 0 END,
          next_run_at,
          COALESCE(updated_at, created_at),
          id
        ) > (0, TIMESTAMP '2000-01-01', TIMESTAMP '2000-01-01', '')
      ORDER BY
        (CASE WHEN next_run_at IS NULL THEN 1 ELSE 0 END) ASC,
        next_run_at ASC,
        COALESCE(updated_at, created_at) ASC,
        id ASC
      LIMIT 50
    `)
    assert.match(JSON.stringify(subscriptionPlan.rows[0]['QUERY PLAN']), /idx_subscriptions_cursor_next/)
    assert.match(JSON.stringify(subscriptionPlan.rows[0]['QUERY PLAN']), /Index Cond/)

    const paymentPlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id FROM payment_plans
      WHERE (
        CASE WHEN total IS NULL THEN 1 ELSE 0 END,
        total,
        COALESCE(next_run_at, updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00'),
        id
      ) < (0, 100, TIMESTAMP '2100-01-01', 'zzzz')
      ORDER BY
        (CASE WHEN total IS NULL THEN 1 ELSE 0 END) DESC,
        total DESC,
        COALESCE(next_run_at, updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00') DESC,
        id DESC
      LIMIT 50
    `)
    assert.match(JSON.stringify(paymentPlan.rows[0]['QUERY PLAN']), /idx_payment_plans_total_cursor/)
    assert.match(JSON.stringify(paymentPlan.rows[0]['QUERY PLAN']), /Index Cond/)

    await client.query(`
      INSERT INTO automations (id, name, status, flow, published_flow)
      VALUES
        ('automation', 'Automation', 'published', '{}'::jsonb, '{}'::jsonb),
        ('automation-paused', 'Automation paused', 'paused', '{}'::jsonb, '{}'::jsonb);
      INSERT INTO automation_trigger_index (automation_id, event_type, endpoint_id)
      VALUES
        ('automation', 'contact-created', ''),
        ('automation-paused', 'contact-created', '');
    `)
    const automationTriggerPlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT a.id, a.name, a.status, a.flow, a.published_flow
      FROM automation_trigger_index ati
      INNER JOIN automations a ON a.id = ati.automation_id
      WHERE ati.event_type = 'contact-created'
        AND ati.endpoint_id = ''
        AND a.status = 'published'
      ORDER BY a.id
    `)
    const automationTriggerPlanJson = JSON.stringify(automationTriggerPlan.rows[0]['QUERY PLAN'])
    assert.match(
      automationTriggerPlanJson,
      /idx_automation_trigger_event_endpoint_automation/
    )
    assert.match(automationTriggerPlanJson, /Index Cond/)
    assert.match(automationTriggerPlanJson, /published/)

    const automationTriggerRows = await client.query(`
      SELECT a.id
      FROM automation_trigger_index ati
      INNER JOIN automations a ON a.id = ati.automation_id
      WHERE ati.event_type = 'contact-created'
        AND ati.endpoint_id = ''
        AND a.status = 'published'
      ORDER BY a.id
    `)
    assert.deepEqual(automationTriggerRows.rows, [{ id: 'automation' }])
    await client.query('RESET enable_seqscan')

    await client.query(`
      INSERT INTO meta_ads (date, campaign_id, adset_id, ad_id, spend)
      VALUES ('2098-01-01', 'campaign', 'adset', 'ad', 10)
    `)
    let revision = await client.query('SELECT core_revision, visitor_revision FROM campaign_performance_revision WHERE id = 1')
    assert.equal(Number(revision.rows[0].core_revision), 1)
    await client.query('UPDATE meta_ads SET updated_at = CURRENT_TIMESTAMP WHERE ad_id = $1', ['ad'])
    revision = await client.query('SELECT core_revision FROM campaign_performance_revision WHERE id = 1')
    assert.equal(Number(revision.rows[0].core_revision), 1)
    await client.query('UPDATE meta_ads SET spend = 11 WHERE ad_id = $1', ['ad'])
    revision = await client.query('SELECT core_revision FROM campaign_performance_revision WHERE id = 1')
    assert.equal(Number(revision.rows[0].core_revision), 2)

    const sessionId = randomUUID()
    await client.query(`
      INSERT INTO sessions (id, session_id, visitor_id, campaign_id, started_at, created_at, page_url)
      VALUES ($1, 'session', 'visitor', 'campaign', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '/a')
    `, [sessionId])
    revision = await client.query('SELECT last_value, is_called FROM campaign_performance_visitor_revision_seq')
    assert.equal(revision.rows[0].is_called, true)
    assert.equal(Number(revision.rows[0].last_value), 1)
    await client.query("UPDATE sessions SET page_url = '/b' WHERE id = $1", [sessionId])
    revision = await client.query('SELECT last_value FROM campaign_performance_visitor_revision_seq')
    assert.equal(Number(revision.rows[0].last_value), 1)
    await client.query("UPDATE sessions SET campaign_id = 'changed' WHERE id = $1", [sessionId])
    revision = await client.query('SELECT last_value FROM campaign_performance_visitor_revision_seq')
    assert.equal(Number(revision.rows[0].last_value), 2)

    await client.query(`
      INSERT INTO subscriptions (id, name, status, amount, created_at, updated_at)
      VALUES ('subscription', 'Plan', 'active', 10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `)
    const paymentRevision = await client.query("SELECT revision FROM payment_list_revisions WHERE scope = 'subscriptions'")
    assert.equal(Number(paymentRevision.rows[0].revision), 1)

    await client.query("SET TIME ZONE 'America/Los_Angeles'")
    const olderProjectionId = 'ffffffff-ffff-4fff-8fff-fffffffffff1'
    const latestProjectionId = '00000000-0000-4000-8000-000000000001'
    await client.query(`
      INSERT INTO sessions (
        id, session_id, visitor_id, campaign_id, adset_id, ad_id,
        started_at, created_at, event_name, utm_campaign
      ) VALUES
        ($1, 'projection-old', 'projection-visitor', 'projection-campaign', 'projection-adset', 'projection-ad',
          TIMESTAMPTZ '2031-08-12 12:00:00.100+00', TIMESTAMPTZ '2031-08-12 12:00:00.100+00', 'page_view', 'plain'),
        ($2, 'projection-latest', 'projection-visitor', 'projection-campaign', 'projection-adset', 'projection-ad',
          TIMESTAMPTZ '2031-08-12 12:00:00.900+00', TIMESTAMPTZ '2031-08-12 12:00:00.900+00', 'page_view', 'pg-session-needle')
    `, [olderProjectionId, latestProjectionId])

    let projectionHeads = await client.query(`
      SELECT bucket_kind, bucket_start, session_row_id, latest_at
      FROM tracking_visitor_latest
      WHERE scope_type = 'all'
        AND scope_id = ''
        AND visitor_key = 'visitor:projection-visitor'
      ORDER BY bucket_kind
    `)
    assert.equal(projectionHeads.rows.length, 2)
    assert.ok(projectionHeads.rows.every(row => row.session_row_id === latestProjectionId))
    assert.deepEqual(
      projectionHeads.rows.map(row => row.bucket_start.toISOString()).sort(),
      ['2031-08-12T00:00:00.000Z', '2031-08-12T12:00:00.000Z']
    )

    await client.query(`
      UPDATE sessions
      SET started_at = TIMESTAMPTZ '2031-08-12 12:00:00.050+00'
      WHERE id = $1
    `, [latestProjectionId])
    projectionHeads = await client.query(`
      SELECT session_row_id, latest_at
      FROM tracking_visitor_latest
      WHERE scope_type = 'all'
        AND scope_id = ''
        AND visitor_key = 'visitor:projection-visitor'
    `)
    assert.ok(projectionHeads.rows.every(row => row.session_row_id === olderProjectionId))
    assert.ok(projectionHeads.rows.every(row => row.latest_at.toISOString().endsWith('00.100Z')))

    await client.query('DELETE FROM sessions WHERE id = $1', [olderProjectionId])
    projectionHeads = await client.query(`
      SELECT session_row_id, latest_at
      FROM tracking_visitor_latest
      WHERE scope_type = 'all'
        AND scope_id = ''
        AND visitor_key = 'visitor:projection-visitor'
    `)
    assert.ok(projectionHeads.rows.every(row => row.session_row_id === latestProjectionId))
    assert.ok(projectionHeads.rows.every(row => row.latest_at.toISOString().endsWith('00.050Z')))

    await client.query(`
      INSERT INTO contacts (id, full_name, email, created_at, updated_at)
      VALUES ('pg-search-contact', 'PG Contact Needle', 'pg-contact@local.invalid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `)

    await client.query('SET enable_seqscan = off')
    const sessionSearchPlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id
      FROM sessions
      WHERE LOWER(
        COALESCE(session_id, '') || ' ' || COALESCE(visitor_id, '') || ' ' ||
        COALESCE(contact_id, '') || ' ' || COALESCE(full_name, '') || ' ' ||
        COALESCE(email, '') || ' ' || COALESCE(event_name, '') || ' ' ||
        COALESCE(page_url, '') || ' ' || COALESCE(referrer_url, '') || ' ' ||
        COALESCE(utm_source, '') || ' ' || COALESCE(utm_campaign, '') || ' ' ||
        COALESCE(utm_content, '') || ' ' || COALESCE(campaign_id, '') || ' ' ||
        COALESCE(ad_id, '') || ' ' || COALESCE(site_name, '')
      ) LIKE '%pg-session-needle%'
    `)
    assert.match(JSON.stringify(sessionSearchPlan.rows[0]['QUERY PLAN']), /idx_sessions_search_document_trgm/)

    const contactSearchPlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id
      FROM contacts
      WHERE LOWER(
        COALESCE(full_name, '') || ' ' || COALESCE(email, '') || ' ' ||
        COALESCE(phone, '') || ' ' || id
      ) LIKE '%pg contact needle%'
    `)
    assert.match(JSON.stringify(contactSearchPlan.rows[0]['QUERY PLAN']), /idx_tracking_contacts_search_document_trgm/)

    const projectionPagePlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT session_row_id
      FROM tracking_visitor_latest
      WHERE scope_type = 'all'
        AND scope_id = ''
        AND bucket_kind = 'day'
        AND latest_at >= TIMESTAMPTZ '2031-08-12 00:00:00+00'
        AND latest_at < TIMESTAMPTZ '2031-08-13 00:00:00+00'
      ORDER BY latest_at DESC, session_row_id DESC
      LIMIT 50
    `)
    const projectionPagePlanJson = JSON.stringify(projectionPagePlan.rows[0]['QUERY PLAN'])
    assert.match(projectionPagePlanJson, /idx_tracking_visitor_latest_day_page/)
    assert.match(projectionPagePlanJson, /latest_at/)

    const projectionBackfillPlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id
      FROM sessions
      WHERE visitor_projection_version < 3
      ORDER BY started_at DESC, id DESC
      LIMIT 200
    `)
    assert.match(JSON.stringify(projectionBackfillPlan.rows[0]['QUERY PLAN']), /idx_sessions_visitor_projection_recent/)

    await client.query(`
      INSERT INTO payments (id, contact_id, status, amount, payment_mode, date, created_at)
      VALUES ('report-payment', 'pg-search-contact', 'paid', 25, 'live', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `)
    const reportTransactionPlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id
      FROM payments
      WHERE COALESCE(payment_mode, 'live') != 'test'
        AND (COALESCE(date, created_at), id) < (CURRENT_TIMESTAMP + INTERVAL '1 day', 'zzzz')
      ORDER BY COALESCE(date, created_at) DESC, id DESC
      LIMIT 50
    `)
    assert.match(JSON.stringify(reportTransactionPlan.rows[0]['QUERY PLAN']), /idx_report_transactions_effective_at_id/)
    await client.query('RESET enable_seqscan')

    const rollbackVisitorId = randomUUID()
    await client.query(`
      INSERT INTO sessions (id, session_id, visitor_id, started_at, created_at, event_name)
      VALUES ($1, 'rollback-session', 'rollback-visitor', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'page_view')
    `, [rollbackVisitorId])
    const beforeRollback = await client.query(`
      SELECT COUNT(*)::int AS total
      FROM tracking_visitor_latest
      WHERE visitor_key = 'visitor:rollback-visitor'
    `)
    await client.query('BEGIN')
    try {
      await client.query("SELECT set_config('ristak.skip_tracking_visitor_projection', 'on', true)")
      await client.query("UPDATE sessions SET contact_id = 'rollback-contact' WHERE id = $1", [rollbackVisitorId])
      await client.query("DELETE FROM tracking_visitor_latest WHERE visitor_key = 'visitor:rollback-visitor'")
      throw new Error('rollback-contract')
    } catch (error) {
      await client.query('ROLLBACK')
      assert.equal(error.message, 'rollback-contract')
    }
    const afterRollback = await client.query(`
      SELECT COUNT(*)::int AS total
      FROM tracking_visitor_latest
      WHERE visitor_key = 'visitor:rollback-visitor'
    `)
    const rolledBackSession = await client.query('SELECT contact_id FROM sessions WHERE id = $1', [rollbackVisitorId])
    const localFlag = await client.query("SELECT current_setting('ristak.skip_tracking_visitor_projection', true) AS value")
    assert.equal(afterRollback.rows[0].total, beforeRollback.rows[0].total)
    assert.equal(rolledBackSession.rows[0].contact_id, null)
    assert.equal(localFlag.rows[0].value, '')
  } finally {
    await client.query('SET search_path TO public').catch(() => undefined)
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await client.end()
  }
})
