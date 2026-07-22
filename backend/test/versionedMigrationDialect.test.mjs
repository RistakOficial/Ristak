import assert from 'node:assert/strict'
import { mkdtemp, copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sqlite3Module from 'sqlite3'
import {
  migrationRunsForDialect,
  runVersionedMigrations
} from '../src/startup/runMigrations.js'

const sqlite3 = sqlite3Module.verbose()

function openMemoryDatabase() {
  const connection = new sqlite3.Database(':memory:')
  const database = {
    run(sql, params = []) {
      return new Promise((resolve, reject) => {
        connection.run(sql, params, function onRun(error) {
          if (error) reject(error)
          else resolve({ lastID: this.lastID, changes: this.changes })
        })
      })
    },
    all(sql, params = []) {
      return new Promise((resolve, reject) => {
        connection.all(sql, params, (error, rows) => {
          if (error) reject(error)
          else resolve(rows)
        })
      })
    },
    exec(sql) {
      return new Promise((resolve, reject) => {
        connection.exec(sql, (error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    },
    async transaction(callback) {
      await database.run('BEGIN IMMEDIATE')
      try {
        const result = await callback(database)
        await database.run('COMMIT')
        return result
      } catch (error) {
        await database.run('ROLLBACK').catch(() => undefined)
        throw error
      }
    },
    close() {
      return new Promise((resolve, reject) => {
        connection.close((error) => error ? reject(error) : resolve())
      })
    }
  }
  return database
}

test('las migraciones con sufijo de dialecto sólo apuntan a su motor', () => {
  assert.equal(migrationRunsForDialect('041_payments_amount_numeric.postgres.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('041_payments_amount_numeric.postgres.sql', 'sqlite'), false)
  assert.equal(migrationRunsForDialect('050_tracking_performance_indexes.sqlite.sql', 'sqlite'), true)
  assert.equal(migrationRunsForDialect('050_tracking_performance_indexes.sqlite.sql', 'postgres'), false)
  assert.equal(migrationRunsForDialect('051_message_analytics_indexes.sqlite.sql', 'sqlite'), true)
  assert.equal(migrationRunsForDialect('051_message_analytics_indexes.sqlite.sql', 'postgres'), false)
  assert.equal(migrationRunsForDialect('093_sites_library_folder_queries.sqlite.sql', 'sqlite'), true)
  assert.equal(migrationRunsForDialect('093a_sites_library_search.postgres.sql', 'sqlite'), false)
  assert.equal(migrationRunsForDialect('094_cursor_index_alignment.sqlite.sql', 'sqlite'), true)
  assert.equal(migrationRunsForDialect('094_cursor_index_alignment.sqlite.sql', 'postgres'), false)
  assert.equal(migrationRunsForDialect('094a_contacts_effective_created_cursor.postgres.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('094ba_drop_report_transactions_effective_at_v1.postgres.sql', 'sqlite'), false)
  assert.equal(migrationRunsForDialect('100_reports_snapshot_cache.sqlite.sql', 'sqlite'), true)
  assert.equal(migrationRunsForDialect('100_reports_snapshot_cache.sqlite.sql', 'postgres'), false)
  assert.equal(migrationRunsForDialect('100a_reports_snapshot_cache.postgres.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('100a_reports_snapshot_cache.postgres.sql', 'sqlite'), false)
  assert.equal(migrationRunsForDialect('101_campaign_overview_snapshot.sqlite.sql', 'sqlite'), true)
  assert.equal(migrationRunsForDialect('101_campaign_overview_snapshot.sqlite.sql', 'postgres'), false)
  assert.equal(migrationRunsForDialect('101a_campaign_overview_snapshot.postgres.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('101a_campaign_overview_snapshot.postgres.sql', 'sqlite'), false)
  assert.equal(migrationRunsForDialect('101b_campaign_overview_ad_date.sqlite.sql', 'sqlite'), true)
  assert.equal(migrationRunsForDialect('101b_campaign_overview_ad_date.postgres.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('101c_campaign_overview_date_cover.postgres.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('101c_campaign_overview_date_cover.postgres.sql', 'sqlite'), false)
  assert.equal(migrationRunsForDialect('111_tracking_visitor_projection_state.sqlite.sql', 'sqlite'), true)
  assert.equal(migrationRunsForDialect('111_tracking_visitor_projection_state.sqlite.sql', 'postgres'), false)
  assert.equal(migrationRunsForDialect('111a_tracking_visitor_projection_state.postgres.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('111a_tracking_visitor_projection_state.postgres.sql', 'sqlite'), false)
  assert.equal(migrationRunsForDialect('125_sites_content_assets.sqlite.sql', 'sqlite'), true)
  assert.equal(migrationRunsForDialect('125_sites_content_assets.sqlite.sql', 'postgres'), false)
  assert.equal(migrationRunsForDialect('125a_sites_content_assets.postgres.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('125a_sites_content_assets.postgres.sql', 'sqlite'), false)
  assert.equal(migrationRunsForDialect('126_gigstack_invoice_jobs.sqlite.sql', 'sqlite'), true)
  assert.equal(migrationRunsForDialect('126_gigstack_invoice_jobs.sqlite.sql', 'postgres'), false)
  assert.equal(migrationRunsForDialect('126a_gigstack_invoice_jobs.postgres.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('126a_gigstack_invoice_jobs.postgres.sql', 'sqlite'), false)
  assert.equal(migrationRunsForDialect('128_media_folders.sqlite.sql', 'sqlite'), true)
  assert.equal(migrationRunsForDialect('128_media_folders.sqlite.sql', 'postgres'), false)
  assert.equal(migrationRunsForDialect('128a_media_folders.postgres.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('128a_media_folders.postgres.sql', 'sqlite'), false)
  assert.equal(migrationRunsForDialect('040_common.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('040_common.sql', 'sqlite'), true)
})

test('el bootstrap común nunca manda julianday de SQLite a PostgreSQL', async () => {
  const source = await readFile(new URL('../src/config/database.js', import.meta.url), 'utf8')

  assert.match(
    source,
    /if \(!usePostgres\) \{\s*await db\.run\(`\s*CREATE INDEX IF NOT EXISTS idx_campaign_contacts_cursor_created_at_id[\s\S]*?julianday\(created_at\)[\s\S]*?`\)\s*\}/
  )
})

test('PostgreSQL omite y registra una migración exclusiva de SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-sqlite-only-migration-'))
  const database = openMemoryDatabase()

  try {
    await writeFile(
      join(directory, '051_message_analytics_indexes.sqlite.sql'),
      'THIS IS INTENTIONALLY NOT VALID SQL; THE RUNNER MUST SKIP IT;\n',
      'utf8'
    )

    const result = await runVersionedMigrations({ database, dialect: 'postgres', directory })
    assert.deepEqual(result, { applied: 0, skipped: 1 })
    const ledger = await database.all('SELECT name FROM schema_migrations')
    assert.deepEqual(ledger.map(row => row.name), ['051_message_analytics_indexes.sqlite.sql'])
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('la migración de idempotencia agrega failure_kind a instalaciones existentes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-appointment-failure-kind-'))
  const database = openMemoryDatabase()
  const migration = new URL(
    '../migrations/versioned/051_appointment_creation_failure_kind.sql',
    import.meta.url
  )

  try {
    await database.exec(`
      CREATE TABLE appointment_creation_requests (
        client_request_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        error_retryable INTEGER NOT NULL DEFAULT 0
      );
    `)
    await copyFile(migration, join(directory, '051_appointment_creation_failure_kind.sql'))

    const result = await runVersionedMigrations({ database, dialect: 'sqlite', directory })
    assert.deepEqual(result, { applied: 1, skipped: 0 })

    const columns = await database.all('PRAGMA table_info(appointment_creation_requests)')
    assert.equal(columns.find((column) => column.name === 'failure_kind')?.type, 'TEXT')
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('las migraciones del tester agregan el ledger de turnos a una instalación existente', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-test-turn-ledger-migrations-'))
  const database = openMemoryDatabase()
  const migrationNames = [
    '052a_conversational_agent_test_effect_error_code.sql',
    '052b_conversational_agent_test_effect_error_retryable.sql',
    '052c_conversational_agent_test_turns.sql'
  ]

  try {
    await database.exec(`
      CREATE TABLE conversational_agent_test_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        requested_by_user_id TEXT NOT NULL,
        effects_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        expires_at DATETIME NOT NULL
      );
      CREATE TABLE conversational_agent_test_effects (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        effect_type TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'recorded',
        payload_json TEXT NOT NULL
      );
    `)
    for (const name of migrationNames) {
      await copyFile(
        new URL(`../migrations/versioned/${name}`, import.meta.url),
        join(directory, name)
      )
    }

    const firstRun = await runVersionedMigrations({ database, dialect: 'sqlite', directory })
    assert.deepEqual(firstRun, { applied: 3, skipped: 0 })
    const effectColumns = await database.all('PRAGMA table_info(conversational_agent_test_effects)')
    assert.equal(effectColumns.find((column) => column.name === 'error_code')?.type, 'TEXT')
    assert.equal(effectColumns.find((column) => column.name === 'error_retryable')?.type, 'INTEGER')
    const turnColumns = await database.all('PRAGMA table_info(conversational_agent_test_turns)')
    assert.ok(turnColumns.some((column) => column.name === 'client_request_hash'))
    assert.ok(turnColumns.some((column) => column.name === 'preview_result_json'))
    assert.ok(turnColumns.some((column) => column.name === 'response_json'))
    const indexes = await database.all("SELECT name FROM sqlite_master WHERE type = 'index'")
    assert.ok(indexes.some((row) => row.name === 'idx_conv_agent_test_turn_identity'))
    assert.ok(indexes.some((row) => row.name === 'idx_conv_agent_test_turn_run'))

    const ledger = await database.all('SELECT name FROM schema_migrations ORDER BY name')
    assert.deepEqual(ledger.map((row) => row.name), migrationNames)
    assert.deepEqual(
      await runVersionedMigrations({ database, dialect: 'sqlite', directory }),
      { applied: 0, skipped: 0 }
    )
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('el ledger versionado también converge si el bootstrap ya creó las columnas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-test-turn-bootstrap-migrations-'))
  const database = openMemoryDatabase()
  const migrationNames = [
    '052a_conversational_agent_test_effect_error_code.sql',
    '052b_conversational_agent_test_effect_error_retryable.sql',
    '052c_conversational_agent_test_turns.sql'
  ]

  try {
    await database.exec(`
      CREATE TABLE conversational_agent_test_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        requested_by_user_id TEXT NOT NULL,
        effects_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        expires_at DATETIME NOT NULL
      );
      CREATE TABLE conversational_agent_test_effects (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        effect_type TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'recorded',
        payload_json TEXT NOT NULL,
        error_code TEXT,
        error_retryable INTEGER
      );
    `)
    for (const name of migrationNames) {
      await copyFile(
        new URL(`../migrations/versioned/${name}`, import.meta.url),
        join(directory, name)
      )
    }

    const result = await runVersionedMigrations({ database, dialect: 'sqlite', directory })
    assert.deepEqual(result, { applied: 1, skipped: 0 })
    assert.equal((await database.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversational_agent_test_turns'"
    )).length, 1)
    const ledger = await database.all('SELECT name FROM schema_migrations ORDER BY name')
    assert.deepEqual(ledger.map((row) => row.name), migrationNames)
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('PostgreSQL serializa dos runners y aplica una cadena versionada una sola vez', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-concurrent-migrations-'))
  const base = openMemoryDatabase()
  let lockHeld = false
  let migrationExecutions = 0
  const lockNames = []
  const database = {
    run: (...args) => base.run(...args),
    all: (...args) => base.all(...args),
    async exec(sql) {
      if (sql.includes('concurrent_migration_marker')) {
        migrationExecutions += 1
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      return base.exec(sql)
    },
    async withAdvisoryLock(lockName, callback) {
      lockNames.push(lockName)
      if (lockHeld) {
        throw Object.assign(new Error('busy'), { code: 'DATABASE_ADVISORY_LOCK_BUSY' })
      }
      lockHeld = true
      try {
        return await callback(database)
      } finally {
        lockHeld = false
      }
    }
  }

  try {
    await writeFile(
      join(directory, '001_concurrent.sql'),
      'CREATE TABLE concurrent_migration_marker (id TEXT PRIMARY KEY);\n',
      'utf8'
    )
    const results = await Promise.all([
      runVersionedMigrations({ database, dialect: 'postgres', directory }),
      runVersionedMigrations({ database, dialect: 'postgres', directory })
    ])

    assert.deepEqual(results.map((result) => result.applied).sort(), [0, 1])
    assert.equal(migrationExecutions, 1)
    assert.equal(lockNames.every((name) => name === 'versioned-migrations'), true)
  } finally {
    await base.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('SQLite omite y registra la migracion PostgreSQL sin ejecutar su DDL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-migrations-'))
  const database = openMemoryDatabase()
  const postgresMigration = new URL(
    '../migrations/versioned/041_payments_amount_numeric.postgres.sql',
    import.meta.url
  )

  try {
    await database.exec(`
      CREATE TABLE payments (id TEXT PRIMARY KEY, amount REAL);
      INSERT INTO payments (id, amount) VALUES ('pay_sqlite', 1200.125);
    `)
    await writeFile(
      join(directory, '040_common.sql'),
      'CREATE TABLE common_marker (id TEXT PRIMARY KEY);\n',
      'utf8'
    )
    await copyFile(postgresMigration, join(directory, '041_payments_amount_numeric.postgres.sql'))

    const firstRun = await runVersionedMigrations({ database, dialect: 'sqlite', directory })
    assert.deepEqual(firstRun, { applied: 1, skipped: 1 })

    const paymentColumns = await database.all('PRAGMA table_info(payments)')
    assert.equal(paymentColumns.find((column) => column.name === 'amount')?.type, 'REAL')
    assert.equal((await database.all("SELECT name FROM sqlite_master WHERE name = 'common_marker'")).length, 1)

    const ledger = await database.all('SELECT name FROM schema_migrations ORDER BY name')
    assert.deepEqual(ledger.map((row) => row.name), [
      '040_common.sql',
      '041_payments_amount_numeric.postgres.sql'
    ])

    const secondRun = await runVersionedMigrations({ database, dialect: 'sqlite', directory })
    assert.deepEqual(secondRun, { applied: 0, skipped: 0 })
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('SQLite 091+ revierte DDL parcial y solo publica el ledger al completar todo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-sqlite-atomic-migration-'))
  const database = openMemoryDatabase()
  const file = '103_atomic_projection.sqlite.sql'

  try {
    await writeFile(join(directory, file), `
      CREATE TABLE atomic_projection_fixture (id TEXT PRIMARY KEY);
      THIS STATEMENT MUST FAIL;
    `, 'utf8')

    await assert.rejects(
      runVersionedMigrations({ database, dialect: 'sqlite', directory }),
      /syntax error|near "THIS"/i
    )
    assert.equal((await database.all(
      "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'atomic_projection_fixture'"
    ))[0].total, 0)
    assert.equal((await database.all(
      'SELECT COUNT(*) AS total FROM schema_migrations WHERE name = ?',
      [file]
    ))[0].total, 0)

    await writeFile(join(directory, file), `
      CREATE TABLE atomic_projection_fixture (id TEXT PRIMARY KEY);
      CREATE INDEX atomic_projection_fixture_page ON atomic_projection_fixture(id);
    `, 'utf8')
    assert.deepEqual(
      await runVersionedMigrations({ database, dialect: 'sqlite', directory }),
      { applied: 1, skipped: 0 }
    )
    assert.equal((await database.all(
      'SELECT COUNT(*) AS total FROM schema_migrations WHERE name = ?',
      [file]
    ))[0].total, 1)
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('SQLite 091+ falla cerrado ante un objeto homonimo y no finge haber migrado', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-sqlite-strict-migration-'))
  const database = openMemoryDatabase()
  const file = '103_strict_projection.sqlite.sql'

  try {
    await database.exec('CREATE TABLE strict_projection_fixture (id TEXT PRIMARY KEY);')
    await writeFile(
      join(directory, file),
      'CREATE TABLE strict_projection_fixture (id TEXT PRIMARY KEY);',
      'utf8'
    )

    await assert.rejects(
      runVersionedMigrations({ database, dialect: 'sqlite', directory }),
      /already exists/i
    )
    assert.equal((await database.all(
      'SELECT COUNT(*) AS total FROM schema_migrations WHERE name = ?',
      [file]
    ))[0].total, 0)
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('PostgreSQL 091+ no deja DDL aplicado si falla solamente el ledger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-postgres-atomic-ledger-'))
  const base = openMemoryDatabase()
  const file = '103a_atomic_ledger.postgres.sql'
  let failLedger = true
  const database = {
    run: (...args) => base.run(...args),
    all: (...args) => base.all(...args),
    exec: (...args) => base.exec(...args),
    transaction(callback) {
      return base.transaction((transaction) => callback({
        ...transaction,
        async run(sql, params = []) {
          if (failLedger && sql.includes('INSERT INTO schema_migrations')) {
            throw new Error('simulated ledger disconnect')
          }
          return transaction.run(sql, params)
        }
      }))
    }
  }

  try {
    await writeFile(
      join(directory, file),
      'CREATE TABLE postgres_atomic_fixture (id TEXT PRIMARY KEY);',
      'utf8'
    )
    await assert.rejects(
      runVersionedMigrations({ database, dialect: 'postgres', directory }),
      /simulated ledger disconnect/
    )
    assert.equal((await base.all(
      "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'postgres_atomic_fixture'"
    ))[0].total, 0)
    assert.equal((await base.all(
      'SELECT COUNT(*) AS total FROM schema_migrations WHERE name = ?',
      [file]
    ))[0].total, 0)

    failLedger = false
    assert.deepEqual(
      await runVersionedMigrations({ database, dialect: 'postgres', directory }),
      { applied: 1, skipped: 0 }
    )
  } finally {
    await base.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('la identidad de protocolo migra instalaciones viejas antes de crear su indice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-whatsapp-identity-migrations-'))
  const database = openMemoryDatabase()
  const columnMigration = new URL(
    '../migrations/versioned/044_whatsapp_protocol_message_identity.sql',
    import.meta.url
  )
  const indexMigration = new URL(
    '../migrations/versioned/044a_whatsapp_protocol_message_identity_index.sql',
    import.meta.url
  )

  try {
    await database.exec(`
      CREATE TABLE whatsapp_api_messages (
        id TEXT PRIMARY KEY,
        direction TEXT
      );
    `)
    await copyFile(columnMigration, join(directory, '044_whatsapp_protocol_message_identity.sql'))
    await copyFile(indexMigration, join(directory, '044a_whatsapp_protocol_message_identity_index.sql'))

    const result = await runVersionedMigrations({ database, dialect: 'sqlite', directory })
    assert.deepEqual(result, { applied: 2, skipped: 0 })

    const columns = await database.all('PRAGMA table_info(whatsapp_api_messages)')
    assert.equal(columns.find((column) => column.name === 'protocol_message_key_id')?.type, 'TEXT')
    assert.equal((await database.all(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_whatsapp_api_messages_protocol_key'"
    )).length, 1)
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('el indice de identidad se crea aunque el bootstrap ya haya agregado la columna', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-whatsapp-identity-bootstrap-'))
  const database = openMemoryDatabase()
  const columnMigration = new URL(
    '../migrations/versioned/044_whatsapp_protocol_message_identity.sql',
    import.meta.url
  )
  const indexMigration = new URL(
    '../migrations/versioned/044a_whatsapp_protocol_message_identity_index.sql',
    import.meta.url
  )

  try {
    await database.exec(`
      CREATE TABLE whatsapp_api_messages (
        id TEXT PRIMARY KEY,
        direction TEXT,
        protocol_message_key_id TEXT
      );
    `)
    await copyFile(columnMigration, join(directory, '044_whatsapp_protocol_message_identity.sql'))
    await copyFile(indexMigration, join(directory, '044a_whatsapp_protocol_message_identity_index.sql'))

    const result = await runVersionedMigrations({ database, dialect: 'sqlite', directory })
    assert.deepEqual(result, { applied: 1, skipped: 0 })

    const ledger = await database.all('SELECT name FROM schema_migrations ORDER BY name')
    assert.deepEqual(ledger.map((row) => row.name), [
      '044_whatsapp_protocol_message_identity.sql',
      '044a_whatsapp_protocol_message_identity_index.sql'
    ])
    assert.equal((await database.all(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_whatsapp_api_messages_protocol_key'"
    )).length, 1)
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('la migracion 092 de Sites tracking corre completa e idempotente en SQLite real', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-sites-tracking-migrations-'))
  const database = openMemoryDatabase()
  const trackingMigration = new URL(
    '../migrations/versioned/092_sites_tracking_scope.sqlite.sql',
    import.meta.url
  )

  try {
    await database.exec(`
      CREATE TABLE public_sites (
        id TEXT PRIMARY KEY,
        site_type TEXT NOT NULL,
        status TEXT NOT NULL,
        theme_json TEXT,
        updated_at TIMESTAMP NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        site_id TEXT,
        form_site_id TEXT,
        created_at TIMESTAMP NOT NULL
      );
      CREATE TABLE public_site_submissions (
        id TEXT PRIMARY KEY,
        site_id TEXT,
        form_site_id TEXT,
        created_at TIMESTAMP NOT NULL
      );
      INSERT INTO public_sites (id, site_type, status, theme_json, updated_at)
      VALUES ('malformed-theme', 'landing_page', 'published', '{malformed', CURRENT_TIMESTAMP);
    `)
    await copyFile(trackingMigration, join(directory, '092_sites_tracking_scope.sqlite.sql'))

    const firstRun = await runVersionedMigrations({ database, dialect: 'sqlite', directory })
    assert.deepEqual(firstRun, { applied: 1, skipped: 0 })

    const indexes = await database.all(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'idx_public_sites_tracking_scope',
          'idx_public_sites_tracking_page_mode_scope',
          'idx_sessions_site_created_at',
          'idx_sessions_form_site_created_at',
          'idx_public_site_submissions_site',
          'idx_public_site_submissions_form_site'
        )
      ORDER BY name
    `)
    assert.deepEqual(indexes.map(row => row.name), [
      'idx_public_site_submissions_form_site',
      'idx_public_site_submissions_site',
      'idx_public_sites_tracking_page_mode_scope',
      'idx_public_sites_tracking_scope',
      'idx_sessions_form_site_created_at',
      'idx_sessions_site_created_at'
    ])

    const pageModePlan = await database.all(`
      EXPLAIN QUERY PLAN
      SELECT id
      FROM public_sites
      WHERE site_type = 'landing_page'
        AND status = 'published'
        AND CASE
          WHEN json_valid(theme_json)
            THEN COALESCE(json_extract(theme_json, '$.pageMode'), 'funnel')
          ELSE 'funnel'
        END = 'website'
      ORDER BY updated_at DESC, id DESC
      LIMIT 50
    `)
    assert.match(JSON.stringify(pageModePlan), /idx_public_sites_tracking_page_mode_scope/)
    const malformedTheme = await database.all(`
      SELECT CASE
        WHEN json_valid(theme_json)
          THEN COALESCE(json_extract(theme_json, '$.pageMode'), 'funnel')
        ELSE 'funnel'
      END AS page_mode
      FROM public_sites
      WHERE id = 'malformed-theme'
    `)
    assert.equal(malformedTheme[0].page_mode, 'funnel')

    const sitePlan = await database.all(`
      EXPLAIN QUERY PLAN
      SELECT id
      FROM sessions
      WHERE site_id = 'site-one'
        AND site_id != ''
        AND created_at >= '2098-01-01T00:00:00.000Z'
    `)
    assert.match(JSON.stringify(sitePlan), /idx_sessions_site_created_at/)

    const formPlan = await database.all(`
      EXPLAIN QUERY PLAN
      SELECT id
      FROM sessions
      WHERE form_site_id = 'form-one'
        AND form_site_id != ''
        AND created_at >= '2098-01-01T00:00:00.000Z'
    `)
    assert.match(JSON.stringify(formPlan), /idx_sessions_form_site_created_at/)

    const submissionPlan = await database.all(`
      EXPLAIN QUERY PLAN
      SELECT id
      FROM public_site_submissions
      WHERE site_id = 'site-one'
        AND created_at >= '2098-01-01T00:00:00.000Z'
    `)
    assert.match(JSON.stringify(submissionPlan), /idx_public_site_submissions_site/)

    const secondRun = await runVersionedMigrations({ database, dialect: 'sqlite', directory })
    assert.deepEqual(secondRun, { applied: 0, skipped: 0 })
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('la migracion 093 de bibliotecas Sites tolera JSON corrupto y crea ambos índices SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-sites-library-migrations-'))
  const database = openMemoryDatabase()
  const migration = new URL(
    '../migrations/versioned/093_sites_library_folder_queries.sqlite.sql',
    import.meta.url
  )

  try {
    await database.exec(`
      CREATE TABLE public_sites (
        id TEXT PRIMARY KEY,
        site_type TEXT NOT NULL,
        theme_json TEXT,
        created_at TIMESTAMP NOT NULL,
        updated_at TIMESTAMP NOT NULL
      );
      INSERT INTO public_sites (id, site_type, theme_json, created_at, updated_at)
      VALUES
        ('malformed-landing', 'landing_page', '{malformed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('form-by-source', 'standard_form', '{"librarySource":"site_embed"}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `)
    await copyFile(migration, join(directory, '093_sites_library_folder_queries.sqlite.sql'))

    assert.deepEqual(
      await runVersionedMigrations({ database, dialect: 'sqlite', directory }),
      { applied: 1, skipped: 0 }
    )
    assert.deepEqual(
      await runVersionedMigrations({ database, dialect: 'sqlite', directory }),
      { applied: 0, skipped: 0 }
    )

    const indexes = await database.all(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'idx_public_sites_landing_library_folder_page',
          'idx_public_sites_form_library_folder_page'
        )
      ORDER BY name
    `)
    assert.deepEqual(indexes.map(row => row.name), [
      'idx_public_sites_form_library_folder_page',
      'idx_public_sites_landing_library_folder_page'
    ])
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('la migracion 125 repara instalaciones cuyo bootstrap ya se marco sin content assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-sites-content-assets-migration-'))
  const database = openMemoryDatabase()
  const migration = new URL(
    '../migrations/versioned/125_sites_content_assets.sqlite.sql',
    import.meta.url
  )

  try {
    await database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE app_config (
        config_key TEXT PRIMARY KEY,
        config_value TEXT
      );
      CREATE TABLE public_sites (
        id TEXT PRIMARY KEY
      );
      INSERT INTO app_config (config_key, config_value)
      VALUES ('core_schema_bootstrap_version', '2026-07-12-v1');
      INSERT INTO public_sites (id) VALUES ('site-preview');
    `)
    await copyFile(migration, join(directory, '125_sites_content_assets.sqlite.sql'))

    assert.deepEqual(
      await runVersionedMigrations({ database, dialect: 'sqlite', directory }),
      { applied: 1, skipped: 0 }
    )

    const table = await database.all(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'public_site_content_assets'
    `)
    assert.deepEqual(table.map(row => row.name), ['public_site_content_assets'])

    const indexes = await database.all(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'idx_public_site_content_assets_site_key',
          'idx_public_site_content_assets_media'
        )
      ORDER BY name
    `)
    assert.deepEqual(indexes.map(row => row.name), [
      'idx_public_site_content_assets_media',
      'idx_public_site_content_assets_site_key'
    ])

    await database.run(`
      INSERT INTO public_site_content_assets (
        id, site_id, asset_key, media_asset_id
      ) VALUES (?, ?, ?, ?)
    `, ['binding-one', 'site-preview', 'hero', 'media-one'])
    await assert.rejects(
      database.run(`
        INSERT INTO public_site_content_assets (
          id, site_id, asset_key, media_asset_id
        ) VALUES (?, ?, ?, ?)
      `, ['binding-two', 'site-preview', 'hero', 'media-two']),
      /UNIQUE constraint failed/
    )

    assert.deepEqual(
      await runVersionedMigrations({ database, dialect: 'sqlite', directory }),
      { applied: 0, skipped: 0 }
    )
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('la migracion 126 agrega la cola fiscal Gigstack a instalaciones existentes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-gigstack-invoice-jobs-migration-'))
  const database = openMemoryDatabase()
  const migration = new URL(
    '../migrations/versioned/126_gigstack_invoice_jobs.sqlite.sql',
    import.meta.url
  )

  try {
    await database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE app_config (
        config_key TEXT PRIMARY KEY,
        config_value TEXT
      );
      CREATE TABLE payments (
        id TEXT PRIMARY KEY
      );
      INSERT INTO app_config (config_key, config_value)
      VALUES ('core_schema_bootstrap_version', '2026-07-12-v1');
      INSERT INTO payments (id) VALUES ('payment-preview');
    `)
    await copyFile(migration, join(directory, '126_gigstack_invoice_jobs.sqlite.sql'))

    assert.deepEqual(
      await runVersionedMigrations({ database, dialect: 'sqlite', directory }),
      { applied: 1, skipped: 0 }
    )

    const table = await database.all(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'gigstack_invoice_jobs'
    `)
    assert.deepEqual(table.map(row => row.name), ['gigstack_invoice_jobs'])

    const indexes = await database.all(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_gigstack_invoice_jobs_due'
    `)
    assert.deepEqual(indexes.map(row => row.name), ['idx_gigstack_invoice_jobs_due'])

    await database.run(`
      INSERT INTO gigstack_invoice_jobs (payment_id, payment_mode)
      VALUES (?, ?)
    `, ['payment-preview', 'test'])
    await assert.rejects(
      database.run(`
        INSERT INTO gigstack_invoice_jobs (payment_id, payment_mode)
        VALUES (?, ?)
      `, ['missing-payment', 'live']),
      /FOREIGN KEY constraint failed/
    )

    assert.deepEqual(
      await runVersionedMigrations({ database, dialect: 'sqlite', directory }),
      { applied: 0, skipped: 0 }
    )
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('la migracion 128 agrega carpetas multimedia vacías a instalaciones existentes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-media-folders-migration-'))
  const database = openMemoryDatabase()
  const migration = new URL(
    '../migrations/versioned/128_media_folders.sqlite.sql',
    import.meta.url
  )

  try {
    await database.exec(`
      CREATE TABLE app_config (
        config_key TEXT PRIMARY KEY,
        config_value TEXT
      );
      INSERT INTO app_config (config_key, config_value)
      VALUES ('core_schema_bootstrap_version', '2026-07-12-v1');
    `)
    await copyFile(migration, join(directory, '128_media_folders.sqlite.sql'))

    assert.deepEqual(
      await runVersionedMigrations({ database, dialect: 'sqlite', directory }),
      { applied: 1, skipped: 0 }
    )

    await database.run(`
      INSERT INTO media_folders (business_id, path, parent_path, name)
      VALUES (?, ?, ?, ?)
    `, ['business-one', 'Clientes/ACME', 'Clientes', 'ACME'])
    await database.run(`
      INSERT INTO media_folders (business_id, path, parent_path, name)
      VALUES (?, ?, ?, ?)
    `, ['business-two', 'Clientes/ACME', 'Clientes', 'ACME'])
    await assert.rejects(
      database.run(`
        INSERT INTO media_folders (business_id, path, parent_path, name)
        VALUES (?, ?, ?, ?)
      `, ['business-one', 'Clientes/ACME', 'Clientes', 'ACME']),
      /UNIQUE constraint failed/
    )

    const index = await database.all(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_media_folders_parent'
    `)
    assert.deepEqual(index.map(row => row.name), ['idx_media_folders_parent'])
    assert.deepEqual(
      await runVersionedMigrations({ database, dialect: 'sqlite', directory }),
      { applied: 0, skipped: 0 }
    )
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('la migracion 094 alinea expresiones keyset SQLite y retira sólo los índices v1 redundantes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-cursor-index-alignment-'))
  const database = openMemoryDatabase()
  const migration = new URL(
    '../migrations/versioned/094_cursor_index_alignment.sqlite.sql',
    import.meta.url
  )

  try {
    await database.exec(`
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        created_at TEXT
      );
      CREATE TABLE payments (
        id TEXT PRIMARY KEY,
        payment_mode TEXT,
        date TEXT,
        created_at TEXT
      );
      CREATE TABLE media_assets (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT,
        deleted_at TEXT
      );
      CREATE TABLE public_sites (
        id TEXT PRIMARY KEY,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE subscriptions (
        id TEXT PRIMARY KEY,
        name TEXT,
        contact_name TEXT,
        status TEXT,
        amount REAL,
        interval_type TEXT,
        payment_method TEXT,
        next_run_at TEXT,
        created_at TEXT,
        updated_at TEXT
      );

      CREATE INDEX idx_report_transactions_effective_at_id
        ON payments(COALESCE(date, created_at) DESC, id DESC)
        WHERE COALESCE(payment_mode, 'live') != 'test';
      CREATE INDEX idx_public_sites_updated_at_id
        ON public_sites(updated_at DESC, id DESC);
      CREATE INDEX idx_subscriptions_cursor_next
        ON subscriptions((CASE WHEN next_run_at IS NULL THEN 1 ELSE 0 END), next_run_at, COALESCE(updated_at, created_at), id)
        WHERE COALESCE(status, '') <> 'deleted';
      CREATE INDEX idx_subscriptions_cursor_name
        ON subscriptions((CASE WHEN name IS NULL THEN 1 ELSE 0 END), name, COALESCE(updated_at, created_at), id)
        WHERE COALESCE(status, '') <> 'deleted';
      CREATE INDEX idx_subscriptions_cursor_contact
        ON subscriptions((CASE WHEN contact_name IS NULL THEN 1 ELSE 0 END), contact_name, COALESCE(updated_at, created_at), id)
        WHERE COALESCE(status, '') <> 'deleted';
      CREATE INDEX idx_subscriptions_cursor_amount
        ON subscriptions((CASE WHEN amount IS NULL THEN 1 ELSE 0 END), amount, COALESCE(updated_at, created_at), id)
        WHERE COALESCE(status, '') <> 'deleted';
      CREATE INDEX idx_subscriptions_cursor_updated
        ON subscriptions((CASE WHEN updated_at IS NULL THEN 1 ELSE 0 END), updated_at, COALESCE(updated_at, created_at), id)
        WHERE COALESCE(status, '') <> 'deleted';
      CREATE INDEX idx_subscriptions_cursor_status
        ON subscriptions((CASE WHEN status IS NULL THEN 1 ELSE 0 END), status, COALESCE(updated_at, created_at), id)
        WHERE COALESCE(status, '') <> 'deleted';
      CREATE INDEX idx_subscriptions_cursor_interval
        ON subscriptions((CASE WHEN interval_type IS NULL THEN 1 ELSE 0 END), interval_type, COALESCE(updated_at, created_at), id)
        WHERE COALESCE(status, '') <> 'deleted';
      CREATE INDEX idx_subscriptions_cursor_method
        ON subscriptions((CASE WHEN payment_method IS NULL THEN 1 ELSE 0 END), payment_method, COALESCE(updated_at, created_at), id)
        WHERE COALESCE(status, '') <> 'deleted';
      CREATE INDEX idx_subscriptions_cursor_created
        ON subscriptions((CASE WHEN created_at IS NULL THEN 1 ELSE 0 END), created_at, COALESCE(updated_at, created_at), id)
        WHERE COALESCE(status, '') <> 'deleted';

      WITH RECURSIVE sequence(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 300
      )
      INSERT INTO contacts (id, created_at)
      SELECT printf('contact-%04d', value), datetime('2099-01-01', '-' || value || ' seconds')
      FROM sequence;

      WITH RECURSIVE sequence(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 300
      )
      INSERT INTO payments (id, payment_mode, date, created_at)
      SELECT printf('payment-%04d', value), 'live', datetime('2099-01-01', '-' || value || ' seconds'), NULL
      FROM sequence;

      WITH RECURSIVE sequence(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 300
      )
      INSERT INTO media_assets (id, business_id, status, created_at)
      SELECT printf('media-%04d', value), 'default', 'ready', datetime('2099-01-01', '-' || value || ' seconds')
      FROM sequence;

      WITH RECURSIVE sequence(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 300
      )
      INSERT INTO public_sites (id, created_at, updated_at)
      SELECT printf('site-%04d', value), NULL, datetime('2099-01-01', '-' || value || ' seconds')
      FROM sequence;

      WITH RECURSIVE sequence(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 300
      )
      INSERT INTO subscriptions (
        id, name, contact_name, status, amount, interval_type, payment_method,
        next_run_at, created_at, updated_at
      )
      SELECT
        printf('subscription-%04d', value),
        printf('Plan %04d', value),
        printf('Contact %04d', value),
        'active',
        value,
        'monthly',
        'manual',
        datetime('2099-01-01', '+' || value || ' seconds'),
        datetime('2098-01-01', '+' || value || ' seconds'),
        NULL
      FROM sequence;
    `)
    await copyFile(migration, join(directory, '094_cursor_index_alignment.sqlite.sql'))

    assert.deepEqual(
      await runVersionedMigrations({ database, dialect: 'sqlite', directory }),
      { applied: 1, skipped: 0 }
    )
    assert.deepEqual(
      await runVersionedMigrations({ database, dialect: 'sqlite', directory }),
      { applied: 0, skipped: 0 }
    )

    const expectedIndexes = [
      'idx_campaign_contacts_cursor_created_at_id',
      'idx_contacts_cursor_effective_created_at_id',
      'idx_media_assets_library_business_page',
      'idx_public_sites_updated_at_id_v2',
      'idx_report_transactions_effective_at_id_v2',
      'idx_subscriptions_cursor_amount_v2',
      'idx_subscriptions_cursor_contact_v2',
      'idx_subscriptions_cursor_created_v2',
      'idx_subscriptions_cursor_interval_v2',
      'idx_subscriptions_cursor_method_v2',
      'idx_subscriptions_cursor_name_v2',
      'idx_subscriptions_cursor_next_v2',
      'idx_subscriptions_cursor_status_v2',
      'idx_subscriptions_cursor_updated_v2'
    ]
    const alignedIndexes = await database.all(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'index' AND name IN (${expectedIndexes.map(() => '?').join(', ')})
      ORDER BY name
    `, expectedIndexes)
    assert.deepEqual(alignedIndexes.map(row => row.name), expectedIndexes)

    const retiredIndexes = await database.all(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
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
    `)
    assert.deepEqual(retiredIndexes, [])
    const campaignCursorIndexSql = alignedIndexes.find(
      row => row.name === 'idx_campaign_contacts_cursor_created_at_id'
    )?.sql || ''
    assert.match(campaignCursorIndexSql, /julianday\('1970-01-01 00:00:00'\)/)
    assert.match(
      campaignCursorIndexSql,
      /NULLIF\s*\(\s*COALESCE\s*\(\s*COALESCE\s*\(\s*julianday\(created_at\)/
    )
    assert.match(
      alignedIndexes.find(row => row.name === 'idx_subscriptions_cursor_next_v2')?.sql || '',
      /COALESCE\(updated_at, created_at, ''\)/
    )
    const subscriptionCursorIndexes = alignedIndexes.filter(
      row => row.name.startsWith('idx_subscriptions_cursor_')
    )
    assert.equal(subscriptionCursorIndexes.length, 9)
    assert.equal(
      subscriptionCursorIndexes.every(row => /COALESCE\(updated_at, created_at, ''\)/.test(row.sql || '')),
      true,
      'las nueve variantes deben compartir exactamente el tie-breaker con fallback'
    )

    const planCases = [
      {
        index: 'idx_contacts_cursor_effective_created_at_id',
        sql: `SELECT id FROM contacts
          WHERE (COALESCE(created_at, '1970-01-01 00:00:00'), id) < ('2100-01-01 00:00:00', 'zzzz')
          ORDER BY COALESCE(created_at, '1970-01-01 00:00:00') DESC, id DESC LIMIT 50`
      },
      {
        index: 'idx_campaign_contacts_cursor_created_at_id',
        sql: `SELECT id FROM contacts
          WHERE (
            COALESCE(
              NULLIF(COALESCE(
                COALESCE(julianday(created_at), julianday(REPLACE(REPLACE(created_at, 'T', ' '), 'Z', ''))),
                0
              ), 0),
              julianday('1970-01-01 00:00:00')
            ), id
          ) < (julianday('2100-01-01 00:00:00'), 'zzzz')
          ORDER BY COALESCE(
            NULLIF(COALESCE(
              COALESCE(julianday(created_at), julianday(REPLACE(REPLACE(created_at, 'T', ' '), 'Z', ''))),
              0
            ), 0),
            julianday('1970-01-01 00:00:00')
          ) DESC, id DESC LIMIT 50`
      },
      {
        index: 'idx_report_transactions_effective_at_id_v2',
        sql: `SELECT id FROM payments
          WHERE COALESCE(payment_mode, 'live') != 'test'
            AND (COALESCE(date, created_at, '1970-01-01 00:00:00'), id) < ('2100-01-01 00:00:00', 'zzzz')
          ORDER BY COALESCE(date, created_at, '1970-01-01 00:00:00') DESC, id DESC LIMIT 50`
      },
      {
        index: 'idx_media_assets_library_business_page',
        sql: `SELECT id FROM media_assets
          WHERE business_id = 'default' AND deleted_at IS NULL AND status != 'deleted'
            AND (COALESCE(created_at, '1970-01-01 00:00:00'), id) < ('2100-01-01 00:00:00', 'zzzz')
          ORDER BY COALESCE(created_at, '1970-01-01 00:00:00') DESC, id DESC LIMIT 50`
      },
      {
        index: 'idx_public_sites_updated_at_id_v2',
        sql: `SELECT id FROM public_sites
          WHERE (COALESCE(updated_at, created_at, '1970-01-01 00:00:00'), id) < ('2100-01-01 00:00:00', 'zzzz')
          ORDER BY COALESCE(updated_at, created_at, '1970-01-01 00:00:00') DESC, id DESC LIMIT 50`
      },
      {
        index: 'idx_subscriptions_cursor_next_v2',
        sql: `SELECT id FROM subscriptions
          WHERE COALESCE(status, '') <> 'deleted'
            AND (
              CASE WHEN next_run_at IS NULL THEN 1 ELSE 0 END,
              next_run_at,
              COALESCE(updated_at, created_at, ''),
              id
            ) > (0, '2000-01-01 00:00:00', '2000-01-01 00:00:00', '')
          ORDER BY
            (CASE WHEN next_run_at IS NULL THEN 1 ELSE 0 END) ASC,
            next_run_at ASC,
            COALESCE(updated_at, created_at, '') ASC,
            id ASC
          LIMIT 50`
      }
    ]

    for (const planCase of planCases) {
      const plan = await database.all(`EXPLAIN QUERY PLAN ${planCase.sql}`)
      const serializedPlan = JSON.stringify(plan)
      assert.match(serializedPlan, new RegExp(planCase.index), `${planCase.index} debe resolver el keyset`)
      assert.doesNotMatch(serializedPlan, /USE TEMP B-TREE/, `${planCase.index} no debe ordenar en memoria`)
    }
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})
