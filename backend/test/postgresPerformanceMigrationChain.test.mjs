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
  '055a_public_sites_updated_at_id.postgres.sql',
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
  '090a_automation_trigger_index.postgres.sql',
  '091a_sites_landing_library_page.postgres.sql',
  '091b_sites_form_library_page.postgres.sql',
  '092_safe_jsonb.postgres.sql',
  '092a_public_sites_tracking_scope.postgres.sql',
  '092b_sessions_site_created_at.postgres.sql',
  '092c_sessions_form_site_created_at.postgres.sql',
  '092d_public_sites_tracking_page_mode_scope.postgres.sql',
  '092e_public_site_submissions_site_created_at.postgres.sql',
  '092f_public_site_submissions_form_site_created_at.postgres.sql',
  '093_sites_library_search_trgm.postgres.sql',
  '093a_sites_library_search.postgres.sql',
  '093b_sites_landing_library_folder.postgres.sql',
  '093c_sites_form_library_folder.postgres.sql',
  '094a_contacts_effective_created_cursor.postgres.sql',
  '094b_report_transactions_effective_at_v2.postgres.sql',
  '094ba_drop_report_transactions_effective_at_v1.postgres.sql',
  '094c_media_library_business_page.postgres.sql',
  '094d_public_sites_updated_at_v2.postgres.sql',
  '094da_drop_public_sites_updated_at_v1.postgres.sql',
  '094e_subscriptions_cursor_next_v2.postgres.sql',
  '094ea_drop_subscriptions_cursor_next_v1.postgres.sql',
  '094f_subscriptions_cursor_name_v2.postgres.sql',
  '094fa_drop_subscriptions_cursor_name_v1.postgres.sql',
  '094g_subscriptions_cursor_contact_v2.postgres.sql',
  '094ga_drop_subscriptions_cursor_contact_v1.postgres.sql',
  '094h_subscriptions_cursor_amount_v2.postgres.sql',
  '094ha_drop_subscriptions_cursor_amount_v1.postgres.sql',
  '094i_subscriptions_cursor_updated_v2.postgres.sql',
  '094ia_drop_subscriptions_cursor_updated_v1.postgres.sql',
  '094j_subscriptions_cursor_status_v2.postgres.sql',
  '094ja_drop_subscriptions_cursor_status_v1.postgres.sql',
  '094k_subscriptions_cursor_interval_v2.postgres.sql',
  '094ka_drop_subscriptions_cursor_interval_v1.postgres.sql',
  '094l_subscriptions_cursor_method_v2.postgres.sql',
  '094la_drop_subscriptions_cursor_method_v1.postgres.sql',
  '094m_subscriptions_cursor_created_v2.postgres.sql',
  '094ma_drop_subscriptions_cursor_created_v1.postgres.sql',
  '100a_reports_snapshot_cache.postgres.sql',
  '101a_campaign_overview_snapshot.postgres.sql',
  '101b_campaign_overview_ad_date.postgres.sql',
  '101c_campaign_overview_date_cover.postgres.sql',
  '107a_reports_snapshot_time_dependencies.postgres.sql',
  '111a_tracking_visitor_projection_state.postgres.sql'
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

test('los índices concurrentes 080/081/091/092 viven en migraciones unitarias', async () => {
  const baseNames = [
    '080a_tracking_visitor_projection.postgres.sql',
    '081a_report_transaction_summary_cache.postgres.sql',
    '092_safe_jsonb.postgres.sql',
    '093_sites_library_search_trgm.postgres.sql',
    '100a_reports_snapshot_cache.postgres.sql',
    '101a_campaign_overview_snapshot.postgres.sql'
  ]
  for (const name of baseNames) {
    const sql = await readFile(new URL(`../migrations/versioned/${name}`, import.meta.url), 'utf8')
    assert.doesNotMatch(sql, /CREATE INDEX CONCURRENTLY/)
  }

  const concurrentNames = migrationNames.filter(name => (
    /^080[b-k]_/.test(name) ||
    name.startsWith('081b_') ||
    /^091[ab]_/.test(name) ||
    /^092[a-f]_/.test(name) ||
    /^093[a-c]_/.test(name) ||
    /^101[bc]_/.test(name)
  ))
  for (const name of concurrentNames) {
    const sql = await readFile(new URL(`../migrations/versioned/${name}`, import.meta.url), 'utf8')
    assert.equal((sql.match(/CREATE INDEX CONCURRENTLY/g) || []).length, 1, `${name} debe crear exactamente un índice`)
  }
})

test('cada CREATE/DROP concurrente 094 vive solo y cada v1 se retira apenas nace su v2', async () => {
  const alignmentNames = migrationNames.filter(name => name.startsWith('094'))
  assert.equal(alignmentNames.length, 24)

  for (const name of alignmentNames) {
    const sql = await readFile(new URL(`../migrations/versioned/${name}`, import.meta.url), 'utf8')
    assert.equal(
      (sql.match(/(?:CREATE|DROP) INDEX CONCURRENTLY/g) || []).length,
      1,
      `${name} debe contener una sola acción concurrente`
    )
    assert.doesNotMatch(sql, /\bBEGIN\b|\bCOMMIT\b/)
  }

  for (const name of [
    '094a_contacts_effective_created_cursor.postgres.sql',
    '094b_report_transactions_effective_at_v2.postgres.sql'
  ]) {
    const sql = await readFile(new URL(`../migrations/versioned/${name}`, import.meta.url), 'utf8')
    assert.match(sql, /'1970-01-01 00:00:00\+00'/)
    assert.doesNotMatch(
      sql,
      /TIMESTAMP\s+'1970-01-01 00:00:00'/,
      `${name} debe dejar que PostgreSQL resuelva el fallback al tipo real de la columna`
    )
  }

  const replacementPairs = [
    ['094b_report_transactions_effective_at_v2.postgres.sql', '094ba_drop_report_transactions_effective_at_v1.postgres.sql'],
    ['094d_public_sites_updated_at_v2.postgres.sql', '094da_drop_public_sites_updated_at_v1.postgres.sql'],
    ['094e_subscriptions_cursor_next_v2.postgres.sql', '094ea_drop_subscriptions_cursor_next_v1.postgres.sql'],
    ['094f_subscriptions_cursor_name_v2.postgres.sql', '094fa_drop_subscriptions_cursor_name_v1.postgres.sql'],
    ['094g_subscriptions_cursor_contact_v2.postgres.sql', '094ga_drop_subscriptions_cursor_contact_v1.postgres.sql'],
    ['094h_subscriptions_cursor_amount_v2.postgres.sql', '094ha_drop_subscriptions_cursor_amount_v1.postgres.sql'],
    ['094i_subscriptions_cursor_updated_v2.postgres.sql', '094ia_drop_subscriptions_cursor_updated_v1.postgres.sql'],
    ['094j_subscriptions_cursor_status_v2.postgres.sql', '094ja_drop_subscriptions_cursor_status_v1.postgres.sql'],
    ['094k_subscriptions_cursor_interval_v2.postgres.sql', '094ka_drop_subscriptions_cursor_interval_v1.postgres.sql'],
    ['094l_subscriptions_cursor_method_v2.postgres.sql', '094la_drop_subscriptions_cursor_method_v1.postgres.sql'],
    ['094m_subscriptions_cursor_created_v2.postgres.sql', '094ma_drop_subscriptions_cursor_created_v1.postgres.sql']
  ]
  for (const [createName, dropName] of replacementPairs) {
    assert.equal(
      alignmentNames.indexOf(dropName),
      alignmentNames.indexOf(createName) + 1,
      `${dropName} debe seguir inmediatamente a ${createName} para acotar el pico de disco`
    )
  }

  const subscriptionSortColumns = new Map([
    ['094e_subscriptions_cursor_next_v2.postgres.sql', 'next_run_at'],
    ['094f_subscriptions_cursor_name_v2.postgres.sql', 'name'],
    ['094g_subscriptions_cursor_contact_v2.postgres.sql', 'contact_name'],
    ['094h_subscriptions_cursor_amount_v2.postgres.sql', 'amount'],
    ['094i_subscriptions_cursor_updated_v2.postgres.sql', 'updated_at'],
    ['094j_subscriptions_cursor_status_v2.postgres.sql', 'status'],
    ['094k_subscriptions_cursor_interval_v2.postgres.sql', 'interval_type'],
    ['094l_subscriptions_cursor_method_v2.postgres.sql', 'payment_method'],
    ['094m_subscriptions_cursor_created_v2.postgres.sql', 'created_at']
  ])
  for (const [name, sortColumn] of subscriptionSortColumns) {
    const sql = await readFile(new URL(`../migrations/versioned/${name}`, import.meta.url), 'utf8')
    assert.match(sql, new RegExp(`CASE WHEN ${sortColumn} IS NULL THEN 1 ELSE 0 END`))
    assert.match(sql, /COALESCE\(updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00'\)/)
    assert.match(sql, /WHERE COALESCE\(status, ''\) <> 'deleted'/)
  }
})

test('la cadena 050/055/070/071/080/081/090/091/092/093/094/100/101 aplica en PostgreSQL real sin encerrar índices concurrentes', {
  skip: !connectionString
}, async () => {
  const client = new pg.Client({ connectionString })
  const schema = `ristak_perf_${randomUUID().replaceAll('-', '')}`
  await client.connect()

  try {
    await client.query(`CREATE SCHEMA "${schema}"`)
    // Los objetos de extensiones como gin_trgm_ops viven en `public` cuando la
    // extensión ya fue instalada por otra suite. El schema aislado sigue siendo
    // el primer destino para todas nuestras tablas e índices.
    await client.query(`SET search_path TO "${schema}", public`)
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
        id TEXT PRIMARY KEY, attribution_ad_id TEXT, created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ, purchases_count INTEGER, total_paid DOUBLE PRECISION,
        appointment_date TIMESTAMPTZ, full_name TEXT, email TEXT, phone TEXT, source TEXT,
        deleted_at TIMESTAMPTZ
      );
      CREATE TABLE payments (
        id TEXT PRIMARY KEY, contact_id TEXT, status TEXT, amount DOUBLE PRECISION,
        payment_mode TEXT, date TIMESTAMPTZ, created_at TIMESTAMPTZ, updated_at TIMESTAMP
      );
      CREATE TABLE appointments (
        id TEXT PRIMARY KEY, contact_id TEXT, calendar_id TEXT, status TEXT,
        appointment_status TEXT, date_added TIMESTAMP, date_updated TIMESTAMP
      );
      CREATE TABLE appointment_attendance_signals (
        id TEXT PRIMARY KEY, contact_id TEXT, appointment_id TEXT, updated_at TIMESTAMP
      );
      CREATE TABLE contact_phone_numbers (
        id TEXT PRIMARY KEY, contact_id TEXT, phone TEXT, is_primary BOOLEAN,
        created_at TIMESTAMP, updated_at TIMESTAMP
      );
      CREATE TABLE hidden_contact_filters (
        id BIGSERIAL PRIMARY KEY, filter_text TEXT, match_type TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE app_config (
        id BIGSERIAL PRIMARY KEY, config_key TEXT UNIQUE, config_value TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE highlevel_config (
        id BIGSERIAL PRIMARY KEY, location_id TEXT, location_data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE sessions (
        id UUID PRIMARY KEY, session_id TEXT, visitor_id TEXT, contact_id TEXT,
        full_name TEXT, email TEXT, event_name TEXT, page_url TEXT, referrer_url TEXT,
        utm_source TEXT, utm_campaign TEXT, utm_content TEXT, site_name TEXT,
        campaign_id TEXT, adset_id TEXT, ad_id TEXT, started_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ, site_id TEXT, form_site_id TEXT
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
      CREATE TABLE public_sites (
        id TEXT PRIMARY KEY, site_type TEXT NOT NULL, status TEXT NOT NULL,
        name TEXT, title TEXT, description TEXT, slug TEXT, domain TEXT, theme_json TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE public_site_submissions (
        id TEXT PRIMARY KEY, site_id TEXT, form_site_id TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE media_assets (
        id TEXT PRIMARY KEY, business_id TEXT NOT NULL DEFAULT 'default',
        media_type TEXT, status TEXT NOT NULL DEFAULT 'ready',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP
      );
    `)

    // El planner con tablas vacías puede elegir cualquier índice compatible y
    // volver el EXPLAIN una prueba del fixture, no del cursor. Este volumen se
    // inserta antes de crear 091/092 para validar también el costo real del DDL.
    await client.query(`
      INSERT INTO public_sites (id, site_type, status, theme_json, created_at, updated_at)
      SELECT
        'landing-' || value,
        'landing_page',
        'published',
        CASE WHEN value % 2 = 0 THEN '{"pageMode":"website"}' ELSE '{"pageMode":"funnel"}' END,
        TIMESTAMP '2099-01-01 00:00:00' - (value * INTERVAL '1 second'),
        TIMESTAMP '2099-01-01 00:00:00' - (value * INTERVAL '1 second')
      FROM generate_series(1, 10000) value;

      INSERT INTO public_sites (id, site_type, status, theme_json, created_at, updated_at)
      SELECT
        'form-' || value,
        CASE WHEN value % 2 = 0 THEN 'standard_form' ELSE 'interactive_form' END,
        'published',
        '{}',
        TIMESTAMP '2099-01-01 00:00:00' - (value * INTERVAL '1 second'),
        TIMESTAMP '2099-01-01 00:00:00' - (value * INTERVAL '1 second')
      FROM generate_series(1, 5000) value;

      INSERT INTO public_sites (id, site_type, status, theme_json, created_at, updated_at)
      VALUES ('landing-malformed-theme', 'landing_page', 'published', '{malformed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      INSERT INTO media_assets (id, business_id, media_type, status, created_at)
      SELECT
        'media-' || value,
        CASE WHEN value % 5 = 0 THEN 'other-business' ELSE 'default' END,
        CASE WHEN value % 2 = 0 THEN 'video' ELSE 'image' END,
        'ready',
        TIMESTAMP '2099-01-01 00:00:00' - (value * INTERVAL '1 second')
      FROM generate_series(1, 10000) value;

      INSERT INTO meta_ads (date, campaign_id, adset_id, ad_id, spend, reach, clicks)
      SELECT
        TO_CHAR(DATE '2090-01-01' + (value % 3650), 'YYYY-MM-DD'),
        'campaign-' || (value % 250),
        'adset-' || (value % 1000),
        'ad-' || (value % 5000),
        value % 100,
        value % 1000,
        value % 50
      FROM generate_series(1, 100000) value;

      INSERT INTO contacts (id, full_name, email, created_at, updated_at)
      SELECT
        'contact-' || value,
        'Contact ' || value,
        'contact-' || value || '@local.invalid',
        TIMESTAMP '2099-01-01 00:00:00' - (value * INTERVAL '1 second'),
        TIMESTAMP '2099-01-01 00:00:00' - (value * INTERVAL '1 second')
      FROM generate_series(1, 10000) value;

      INSERT INTO payments (id, contact_id, status, amount, payment_mode, date, created_at)
      SELECT
        'payment-' || value,
        'contact-' || value,
        'paid',
        value,
        'live',
        TIMESTAMP '2099-01-01 00:00:00' - (value * INTERVAL '1 second'),
        NULL
      FROM generate_series(1, 10000) value;

      INSERT INTO subscriptions (
        id, name, contact_name, status, amount, interval_type, payment_method,
        next_run_at, created_at, updated_at
      )
      SELECT
        'subscription-' || value,
        'Plan ' || value,
        'Contact ' || value,
        'active',
        value,
        'monthly',
        'manual',
        TIMESTAMP '2099-01-01 00:00:00' + (value * INTERVAL '1 second'),
        TIMESTAMP '2098-01-01 00:00:00' + (value * INTERVAL '1 second'),
        NULL
      FROM generate_series(1, 10000) value;

      ANALYZE public_sites;
      ANALYZE media_assets;
      ANALYZE meta_ads;
      ANALYZE contacts;
      ANALYZE payments;
      ANALYZE subscriptions;
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
      ORDER BY indexname
    `, [schema])
    assert.deepEqual(installedIndexes.rows.map(row => row.indexname), [
      'idx_subscriptions_cursor_amount_v2',
      'idx_subscriptions_cursor_contact_v2',
      'idx_subscriptions_cursor_created_v2',
      'idx_subscriptions_cursor_interval_v2',
      'idx_subscriptions_cursor_method_v2',
      'idx_subscriptions_cursor_name_v2',
      'idx_subscriptions_cursor_next_v2',
      'idx_subscriptions_cursor_status_v2',
      'idx_subscriptions_cursor_updated_v2'
    ])
    const retiredIndexes = await client.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = $1
        AND indexname IN (
          'idx_report_transactions_effective_at_id',
          'idx_public_sites_updated_at_id',
          'idx_subscriptions_cursor_next',
          'idx_subscriptions_cursor_name',
          'idx_subscriptions_cursor_contact',
          'idx_subscriptions_cursor_amount',
          'idx_subscriptions_cursor_updated',
          'idx_subscriptions_cursor_status',
          'idx_subscriptions_cursor_interval',
          'idx_subscriptions_cursor_method',
          'idx_subscriptions_cursor_created'
        )
    `, [schema])
    assert.equal(retiredIndexes.rows.length, 0)
    const automationIndexState = await client.query(
      'SELECT status, index_version FROM automation_trigger_index_state WHERE id = 1'
    )
    assert.equal(automationIndexState.rows[0].status, 'pending')
    assert.equal(Number(automationIndexState.rows[0].index_version), 1)
    const sitesLibraryIndexes = await client.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = $1
        AND indexname IN ('idx_public_sites_landing_library_page', 'idx_public_sites_form_library_page')
    `, [schema])
    assert.equal(sitesLibraryIndexes.rows.length, 2)
    const sitesTrackingIndexes = await client.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = $1
        AND indexname IN (
          'idx_public_sites_tracking_scope',
          'idx_public_sites_tracking_page_mode_scope',
          'idx_sessions_site_created_at',
          'idx_sessions_form_site_created_at',
          'idx_public_site_submissions_site',
          'idx_public_site_submissions_form_site'
        )
    `, [schema])
    assert.equal(sitesTrackingIndexes.rows.length, 6)
    const malformedTheme = await client.query(`
      SELECT COALESCE(ristak_safe_jsonb(theme_json) ->> 'pageMode', 'funnel') AS page_mode
      FROM public_sites
      WHERE id = 'landing-malformed-theme'
    `)
    assert.equal(malformedTheme.rows[0].page_mode, 'funnel')

    const reportsSnapshotObjects = await client.query(`
      SELECT
        to_regclass('reports_snapshot_cache') AS cache_table,
        to_regclass('reports_snapshot_revision_seq') AS revision_sequence,
        (
          SELECT COUNT(*)
          FROM pg_trigger
          WHERE NOT tgisinternal AND tgname LIKE 'trg_reports_snapshot_%'
        ) AS trigger_count
    `)
    assert.equal(reportsSnapshotObjects.rows[0].cache_table, 'reports_snapshot_cache')
    assert.equal(reportsSnapshotObjects.rows[0].revision_sequence, 'reports_snapshot_revision_seq')
    assert.equal(Number(reportsSnapshotObjects.rows[0].trigger_count), 6)
    let reportsExtraRevision = await client.query(
      'SELECT last_value, is_called FROM reports_snapshot_revision_seq'
    )
    assert.equal(reportsExtraRevision.rows[0].is_called, false)
    const campaignOverviewObjects = await client.query(`
      SELECT
        to_regclass('campaign_overview_snapshots') AS cache_table,
        to_regclass('idx_meta_ads_ad_date') AS attribution_index
    `)
    assert.equal(campaignOverviewObjects.rows[0].cache_table, 'campaign_overview_snapshots')
    assert.equal(campaignOverviewObjects.rows[0].attribution_index, 'idx_meta_ads_ad_date')

    await client.query('SET enable_seqscan = off')
    const landingLibraryPlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id FROM public_sites
      WHERE site_type = 'landing_page'
      ORDER BY COALESCE(updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00') DESC, id DESC
      LIMIT 50
    `)
    const landingLibraryPlanJson = JSON.stringify(landingLibraryPlan.rows[0]['QUERY PLAN'])
    assert.match(landingLibraryPlanJson, /idx_public_sites_landing_library_page/)
    assert.doesNotMatch(landingLibraryPlanJson, /"Node Type":"Sort"/)

    const formLibraryPlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id FROM public_sites
      WHERE site_type IN ('standard_form', 'interactive_form')
        AND id != 'system-calendar-booking-form'
      ORDER BY COALESCE(updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00') DESC, id DESC
      LIMIT 50
    `)
    const formLibraryPlanJson = JSON.stringify(formLibraryPlan.rows[0]['QUERY PLAN'])
    assert.match(formLibraryPlanJson, /idx_public_sites_form_library_page/)
    assert.doesNotMatch(formLibraryPlanJson, /"Node Type":"Sort"/)

    const genericSitesPlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id FROM public_sites
      WHERE (
        COALESCE(updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00'),
        id
      ) < (TIMESTAMP '2100-01-01 00:00:00', 'zzzz')
      ORDER BY COALESCE(updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00') DESC, id DESC
      LIMIT 50
    `)
    const genericSitesPlanJson = JSON.stringify(genericSitesPlan.rows[0]['QUERY PLAN'])
    assert.match(genericSitesPlanJson, /idx_public_sites_updated_at_id_v2/)
    assert.doesNotMatch(genericSitesPlanJson, /"Node Type":"Sort"/)

    const sitesTrackingScopePlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id FROM public_sites
      WHERE site_type = 'standard_form'
        AND status = 'published'
      ORDER BY updated_at DESC, id DESC
      LIMIT 50
    `)
    assert.match(JSON.stringify(sitesTrackingScopePlan.rows[0]['QUERY PLAN']), /idx_public_sites_tracking_scope/)

    const sitesTrackingPageModePlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id FROM public_sites
      WHERE site_type = 'landing_page'
        AND status = 'published'
        AND COALESCE(ristak_safe_jsonb(theme_json) ->> 'pageMode', 'funnel') = 'website'
      ORDER BY updated_at DESC, id DESC
      LIMIT 50
    `)
    assert.match(JSON.stringify(sitesTrackingPageModePlan.rows[0]['QUERY PLAN']), /idx_public_sites_tracking_page_mode_scope/)

    const siteSessionPlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT session_id FROM sessions
      WHERE site_id = 'site-one'
        AND site_id != ''
        AND created_at >= TIMESTAMPTZ '2098-01-01T00:00:00Z'
    `)
    assert.match(JSON.stringify(siteSessionPlan.rows[0]['QUERY PLAN']), /idx_sessions_site_created_at/)

    const formSessionPlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT session_id FROM sessions
      WHERE form_site_id = 'form-one'
        AND form_site_id != ''
        AND created_at >= TIMESTAMPTZ '2098-01-01T00:00:00Z'
    `)
    assert.match(JSON.stringify(formSessionPlan.rows[0]['QUERY PLAN']), /idx_sessions_form_site_created_at/)

    const siteSubmissionPlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id FROM public_site_submissions
      WHERE site_id = 'site-one'
        AND created_at >= TIMESTAMPTZ '2098-01-01T00:00:00Z'
    `)
    assert.match(JSON.stringify(siteSubmissionPlan.rows[0]['QUERY PLAN']), /idx_public_site_submissions_site/)

    const formSubmissionPlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id FROM public_site_submissions
      WHERE form_site_id = 'form-one'
        AND created_at >= TIMESTAMPTZ '2098-01-01T00:00:00Z'
    `)
    assert.match(JSON.stringify(formSubmissionPlan.rows[0]['QUERY PLAN']), /idx_public_site_submissions_form_site/)

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
          COALESCE(updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00'),
          id
        ) > (0, TIMESTAMP '2000-01-01', TIMESTAMP '2000-01-01', '')
      ORDER BY
        (CASE WHEN next_run_at IS NULL THEN 1 ELSE 0 END) ASC,
        next_run_at ASC,
        COALESCE(updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00') ASC,
        id ASC
      LIMIT 50
    `)
    assert.match(JSON.stringify(subscriptionPlan.rows[0]['QUERY PLAN']), /idx_subscriptions_cursor_next_v2/)
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
    reportsExtraRevision = await client.query(
      'SELECT last_value, is_called FROM reports_snapshot_revision_seq'
    )
    assert.equal(reportsExtraRevision.rows[0].is_called, false)
    await client.query(`
      INSERT INTO app_config (config_key, config_value)
      VALUES ('unrelated_runtime_key', '1')
    `)
    reportsExtraRevision = await client.query(
      'SELECT last_value, is_called FROM reports_snapshot_revision_seq'
    )
    assert.equal(reportsExtraRevision.rows[0].is_called, false)
    await client.query(`
      INSERT INTO app_config (config_key, config_value)
      VALUES ('account_timezone', 'UTC')
    `)
    reportsExtraRevision = await client.query(
      'SELECT last_value, is_called FROM reports_snapshot_revision_seq'
    )
    assert.equal(reportsExtraRevision.rows[0].is_called, true)
    assert.equal(Number(reportsExtraRevision.rows[0].last_value), 1)
    await client.query(`
      UPDATE payments
      SET date = date + INTERVAL '1 day'
      WHERE id = 'payment-1'
    `)
    reportsExtraRevision = await client.query(
      'SELECT last_value, is_called FROM reports_snapshot_revision_seq'
    )
    assert.equal(Number(reportsExtraRevision.rows[0].last_value), 2)
    let revision = await client.query('SELECT core_revision, visitor_revision FROM campaign_performance_revision WHERE id = 1')
    assert.equal(Number(revision.rows[0].core_revision), 1)
    await client.query('UPDATE meta_ads SET updated_at = CURRENT_TIMESTAMP WHERE ad_id = $1', ['ad'])
    revision = await client.query('SELECT core_revision FROM campaign_performance_revision WHERE id = 1')
    assert.equal(Number(revision.rows[0].core_revision), 1)
    await client.query('UPDATE meta_ads SET spend = 11 WHERE ad_id = $1', ['ad'])
    revision = await client.query('SELECT core_revision FROM campaign_performance_revision WHERE id = 1')
    assert.equal(Number(revision.rows[0].core_revision), 2)

    await client.query('SET enable_seqscan = off')
    const campaignOverviewAttributionPlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT 1
      FROM meta_ads
      WHERE ad_id = 'ad' AND date = '2098-01-01'
      LIMIT 1
    `)
    assert.match(
      JSON.stringify(campaignOverviewAttributionPlan.rows[0]['QUERY PLAN']),
      /idx_meta_ads_ad_date/
    )
    const campaignOverviewDatePlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT date, SUM(spend)
      FROM meta_ads
      WHERE date >= '2098-01-01' AND date <= '2098-01-31'
      GROUP BY date
      ORDER BY date
    `)
    assert.match(
      JSON.stringify(campaignOverviewDatePlan.rows[0]['QUERY PLAN']),
      /idx_meta_ads_overview_date_cover/
    )
    assert.doesNotMatch(
      JSON.stringify(campaignOverviewDatePlan.rows[0]['QUERY PLAN']),
      /Seq Scan/
    )
    await client.query('RESET enable_seqscan')

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

    const reportContactCursorPlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id
      FROM contacts
      WHERE (
        COALESCE(created_at, '1970-01-01 00:00:00+00'),
        id
      ) < (TIMESTAMPTZ '2100-01-01 00:00:00+00', 'zzzz')
      ORDER BY COALESCE(created_at, '1970-01-01 00:00:00+00') DESC, id DESC
      LIMIT 50
    `)
    const reportContactCursorPlanJson = JSON.stringify(reportContactCursorPlan.rows[0]['QUERY PLAN'])
    assert.match(reportContactCursorPlanJson, /idx_contacts_cursor_effective_created_at_id/)
    assert.doesNotMatch(reportContactCursorPlanJson, /"Node Type":"Sort"/)

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

    const projectionStatePlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT status
      FROM tracking_visitor_projection_state
      WHERE singleton_id = 1
    `)
    assert.match(
      JSON.stringify(projectionStatePlan.rows[0]['QUERY PLAN']),
      /tracking_visitor_projection_state_pkey/
    )

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
        AND (
          COALESCE(date, created_at, '1970-01-01 00:00:00+00'),
          id
        ) < (CURRENT_TIMESTAMP + INTERVAL '1 day', 'zzzz')
      ORDER BY COALESCE(date, created_at, '1970-01-01 00:00:00+00') DESC, id DESC
      LIMIT 50
    `)
    assert.match(JSON.stringify(reportTransactionPlan.rows[0]['QUERY PLAN']), /idx_report_transactions_effective_at_id_v2/)

    const mediaLibraryPlan = await client.query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT id
      FROM media_assets
      WHERE business_id = 'default'
        AND deleted_at IS NULL
        AND status != 'deleted'
        AND (
          COALESCE(created_at, TIMESTAMP '1970-01-01 00:00:00'),
          id
        ) < (TIMESTAMP '2100-01-01 00:00:00', 'zzzz')
      ORDER BY COALESCE(created_at, TIMESTAMP '1970-01-01 00:00:00') DESC, id DESC
      LIMIT 50
    `)
    const mediaLibraryPlanJson = JSON.stringify(mediaLibraryPlan.rows[0]['QUERY PLAN'])
    assert.match(mediaLibraryPlanJson, /idx_media_assets_library_business_page/)
    assert.doesNotMatch(mediaLibraryPlanJson, /"Node Type":"Sort"/)
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
