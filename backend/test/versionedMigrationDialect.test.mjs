import assert from 'node:assert/strict'
import { mkdtemp, copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sqlite3Module from 'sqlite3'
import {
  assertConcurrentPostgresMigrationIsIsolated,
  migrationRunsForDialect,
  runVersionedMigrations
} from '../src/startup/runMigrations.js'
import { ensureSqliteSitesAnalyticsTrackingSchema } from '../src/startup/sitesAnalyticsSchemaCompatibility.js'
import { ensureSqliteConversationalHandoffSchema } from '../src/startup/conversationalHandoffSchemaCompatibility.js'
import {
  ensureSqliteAppointmentConfirmationTimeoutSchema
} from '../src/startup/appointmentConfirmationTimeoutSchemaCompatibility.js'
import {
  ensureSqliteSitesPublicationDomainSchema
} from '../src/startup/sitesPublicationDomainSchemaCompatibility.js'

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
  assert.equal(migrationRunsForDialect('146_sites_publication_domain.postgres.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('146_sites_publication_domain.postgres.sql', 'sqlite'), false)
  assert.equal(migrationRunsForDialect('040_common.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('040_common.sql', 'sqlite'), true)
})

test('la migración PostgreSQL instala public_sites.public_domain en bases existentes', async () => {
  const sql = await readFile(
    new URL('../migrations/versioned/146_sites_publication_domain.postgres.sql', import.meta.url),
    'utf8'
  )

  assert.match(
    sql,
    /ALTER TABLE public_sites\s+ADD COLUMN IF NOT EXISTS public_domain TEXT;/i
  )
  assert.match(
    sql,
    /CREATE INDEX IF NOT EXISTS idx_public_sites_public_domain_lower\s+ON public_sites\(LOWER\(public_domain\)\)/i
  )
})

test('la migración 150 limita horarios y llaves de sistema por calendario en SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-reminder-calendar-scope-'))
  const database = openMemoryDatabase()
  const migrationName = '150_appointment_reminders_calendar_scope.sqlite.sql'

  try {
    await database.exec(`
      CREATE TABLE appointment_reminders (
        id TEXT PRIMARY KEY,
        calendar_id TEXT,
        system_key TEXT,
        schedule_key TEXT
      );
      CREATE TABLE appointments (
        id TEXT PRIMARY KEY,
        calendar_id TEXT
      );
      CREATE TABLE appointment_reminder_sends (
        id TEXT PRIMARY KEY,
        reminder_id TEXT,
        appointment_id TEXT,
        confirmation_timeout_status TEXT,
        confirmation_timeout_processed_at TEXT
      );
      CREATE UNIQUE INDEX idx_appointment_reminders_system_key
        ON appointment_reminders(system_key)
        WHERE system_key IS NOT NULL;
      CREATE UNIQUE INDEX idx_appointment_reminders_schedule_key
        ON appointment_reminders(schedule_key)
        WHERE schedule_key IS NOT NULL;
      INSERT INTO appointment_reminders (id, calendar_id, system_key, schedule_key)
      VALUES ('reminder_a', 'calendar_a', 'default_on_booking', 'after_booking:0');
      INSERT INTO appointments (id, calendar_id)
      VALUES ('appointment_b', 'calendar_b');
      INSERT INTO appointment_reminder_sends (
        id, reminder_id, appointment_id, confirmation_timeout_status
      ) VALUES ('send_crossed', 'reminder_a', 'appointment_b', 'pending');
    `)
    await copyFile(
      new URL(`../migrations/versioned/${migrationName}`, import.meta.url),
      join(directory, migrationName)
    )

    assert.deepEqual(
      await runVersionedMigrations({ database, dialect: 'sqlite', directory }),
      { applied: 1, skipped: 0 }
    )

    await database.run(`
      INSERT INTO appointment_reminders (id, calendar_id, system_key, schedule_key)
      VALUES ('reminder_b', 'calendar_b', 'default_on_booking', 'after_booking:0')
    `)
    await assert.rejects(
      () => database.run(`
        INSERT INTO appointment_reminders (id, calendar_id, schedule_key)
        VALUES ('reminder_duplicate', 'calendar_a', 'after_booking:0')
      `),
      /UNIQUE constraint failed/i
    )
    const [crossedSend] = await database.all(`
      SELECT confirmation_timeout_status, confirmation_timeout_processed_at
      FROM appointment_reminder_sends
      WHERE id = 'send_crossed'
    `)
    assert.equal(crossedSend.confirmation_timeout_status, 'disabled')
    assert.ok(crossedSend.confirmation_timeout_processed_at)
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('la migración 150 de PostgreSQL conserva legacy y reemplaza índices globales', async () => {
  const sql = await readFile(
    new URL('../migrations/versioned/150a_appointment_reminders_calendar_scope.postgres.sql', import.meta.url),
    'utf8'
  )

  assert.match(sql, /ADD COLUMN IF NOT EXISTS calendar_id TEXT/i)
  assert.match(sql, /WHERE appointment_reminders\.calendar_id IS NULL/i)
  assert.match(sql, /DROP INDEX IF EXISTS idx_appointment_reminders_schedule_key/i)
  assert.match(sql, /ON appointment_reminders\(calendar_id, schedule_key\)/i)
  assert.match(sql, /ON appointment_reminders\(calendar_id, system_key\)/i)
  assert.match(sql, /confirmation_timeout_status = 'disabled'/i)
})

test('SQLite repara public_sites.public_domain aunque el bootstrap legacy ya se haya omitido', async () => {
  const database = openMemoryDatabase()

  try {
    await database.exec(`
      CREATE TABLE public_sites (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        domain TEXT
      );
    `)

    assert.deepEqual(
      await ensureSqliteSitesPublicationDomainSchema({ database, dialect: 'sqlite' }),
      {
        addedColumns: ['public_sites.public_domain'],
        createdIndexes: ['idx_public_sites_public_domain_lower']
      }
    )
    const columns = await database.all('PRAGMA table_info(public_sites)')
    assert.equal(columns.find(column => column.name === 'public_domain')?.type, 'TEXT')
    const indexes = await database.all("SELECT name FROM sqlite_master WHERE type = 'index'")
    assert.ok(indexes.some(row => row.name === 'idx_public_sites_public_domain_lower'))

    assert.deepEqual(
      await ensureSqliteSitesPublicationDomainSchema({ database, dialect: 'sqlite' }),
      { addedColumns: [], createdIndexes: [] }
    )
  } finally {
    await database.close()
  }
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

test('las migraciones 136/137/139/140 reparan un esquema legado de Sites Analytics y quedan idempotentes en SQLite real', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-sites-analytics-schema-'))
  const database = openMemoryDatabase()
  const sqliteMigration = new URL(
    '../migrations/versioned/136_sites_analytics_tracking_schema.sqlite.sql',
    import.meta.url
  )
  const postgresMigration = new URL(
    '../migrations/versioned/136a_sites_analytics_tracking_schema.postgres.sql',
    import.meta.url
  )
  const submissionEvidenceSqliteMigration = new URL(
    '../migrations/versioned/137_sites_analytics_submission_evidence.sqlite.sql',
    import.meta.url
  )
  const submissionEvidencePostgresMigration = new URL(
    '../migrations/versioned/137a_sites_analytics_submission_evidence.postgres.sql',
    import.meta.url
  )
  const submissionEvidenceContractMigration = new URL(
    '../migrations/versioned/137b_sites_analytics_submission_evidence_contract.postgres.sql',
    import.meta.url
  )
  const siteFlowMigrationFiles = [
    '139_sites_flow_events.sqlite.sql',
    '139a_sites_flow_events.postgres.sql',
    '139b_sites_flow_events_form_cohort.postgres.sql',
    '139c_sites_flow_events_site_time.postgres.sql',
    '139d_sites_flow_events_attempt_order.postgres.sql',
    '139e_sites_flow_events_visitor_time.postgres.sql',
    '139f_sites_flow_events_retention.postgres.sql',
    '139g_sites_flow_events_contract.postgres.sql'
  ]
  const pageFlowRevisionSqliteMigration = new URL(
    '../migrations/versioned/140_sites_page_flow_revision.sqlite.sql',
    import.meta.url
  )
  const pageFlowRevisionPostgresMigration = new URL(
    '../migrations/versioned/140a_sites_page_flow_revision.postgres.sql',
    import.meta.url
  )
  const pageFlowRevisionIndexPostgresMigration = new URL(
    '../migrations/versioned/140b_sites_page_flow_revision_index.postgres.sql',
    import.meta.url
  )
  const pageFlowRevisionContractPostgresMigration = new URL(
    '../migrations/versioned/140c_sites_page_flow_revision_contract.postgres.sql',
    import.meta.url
  )

  try {
    await database.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        started_at TIMESTAMP NOT NULL,
        tracking_source TEXT DEFAULT 'external_pixel',
        site_id TEXT,
        form_site_id TEXT,
        submission_id TEXT
      );

      CREATE TABLE video_playback_events (
        id TEXT PRIMARY KEY,
        event_id TEXT UNIQUE,
        playback_id TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        media_asset_id TEXT,
        site_id TEXT,
        event_at TIMESTAMP NOT NULL
      );
    `)

    const repair = await ensureSqliteSitesAnalyticsTrackingSchema({
      database,
      dialect: 'sqlite'
    })
    assert.deepEqual(repair.addedColumns, [
      'sessions.event_id',
      'sessions.client_started_at',
      'sessions.timestamp_adjusted',
      'sessions.page_flow_revision',
      'sessions.page_journey_id',
      'video_playback_events.event_sequence',
      'video_playback_events.ingestion_version',
      'video_playback_events.payload_hash',
      'video_playback_events.tracking_source',
      'video_playback_events.context_verified',
      'video_playback_events.event_time_quality',
      'video_playback_events.watch_from_seconds',
      'video_playback_events.watch_to_seconds',
      'video_playback_events.client_event_at'
    ])

    const expectedTrackingIndexes = [
      'idx_sessions_event_id_unique',
      'idx_sessions_form_tracking_started',
      'idx_sessions_site_page_flow_started',
      'idx_sessions_site_tracking_started',
      'idx_sessions_submission_tracking_event',
      'idx_video_events_asset_time_type',
      'idx_video_events_playback_sequence',
      'idx_video_events_playback_type_time',
      'idx_video_events_site_time_type',
      'idx_video_events_visitor_time'
    ]
    assert.deepEqual([...repair.createdIndexes].sort(), expectedTrackingIndexes)

    await copyFile(sqliteMigration, join(directory, '136_sites_analytics_tracking_schema.sqlite.sql'))
    await copyFile(postgresMigration, join(directory, '136a_sites_analytics_tracking_schema.postgres.sql'))
    await copyFile(
      submissionEvidenceSqliteMigration,
      join(directory, '137_sites_analytics_submission_evidence.sqlite.sql')
    )
    await copyFile(
      submissionEvidencePostgresMigration,
      join(directory, '137a_sites_analytics_submission_evidence.postgres.sql')
    )
    await copyFile(
      submissionEvidenceContractMigration,
      join(directory, '137b_sites_analytics_submission_evidence_contract.postgres.sql')
    )
    for (const file of siteFlowMigrationFiles) {
      await copyFile(
        new URL(`../migrations/versioned/${file}`, import.meta.url),
        join(directory, file)
      )
    }
    await copyFile(
      pageFlowRevisionSqliteMigration,
      join(directory, '140_sites_page_flow_revision.sqlite.sql')
    )
    await copyFile(
      pageFlowRevisionPostgresMigration,
      join(directory, '140a_sites_page_flow_revision.postgres.sql')
    )
    await copyFile(
      pageFlowRevisionIndexPostgresMigration,
      join(directory, '140b_sites_page_flow_revision_index.postgres.sql')
    )
    await copyFile(
      pageFlowRevisionContractPostgresMigration,
      join(directory, '140c_sites_page_flow_revision_contract.postgres.sql')
    )

    const firstRun = await runVersionedMigrations({ database, dialect: 'sqlite', directory })
    assert.deepEqual(firstRun, { applied: 4, skipped: 13 })

    const sessionColumns = await database.all('PRAGMA table_info("sessions")')
    assert.deepEqual(
      sessionColumns
        .map(row => row.name)
        .filter(name => [
          'event_id',
          'client_started_at',
          'timestamp_adjusted',
          'page_flow_revision',
          'page_journey_id'
        ].includes(name))
        .sort(),
      ['client_started_at', 'event_id', 'page_flow_revision', 'page_journey_id', 'timestamp_adjusted']
    )

    const videoColumns = await database.all('PRAGMA table_info("video_playback_events")')
    assert.deepEqual(
      videoColumns
        .map(row => row.name)
        .filter(name => [
          'event_sequence',
          'ingestion_version',
          'payload_hash',
          'tracking_source',
          'context_verified',
          'event_time_quality',
          'watch_from_seconds',
          'watch_to_seconds',
          'client_event_at'
        ].includes(name))
        .sort(),
      [
        'client_event_at',
        'context_verified',
        'event_sequence',
        'event_time_quality',
        'ingestion_version',
        'payload_hash',
        'tracking_source',
        'watch_from_seconds',
        'watch_to_seconds'
      ]
    )

    const indexes = await database.all(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND name LIKE 'idx_%'
      ORDER BY name
    `)
    const expectedIndexes = [
      ...expectedTrackingIndexes,
      'idx_site_flow_events_attempt_order',
      'idx_site_flow_events_created_at',
      'idx_site_flow_events_form_revision_time',
      'idx_site_flow_events_site_time',
      'idx_site_flow_events_visitor_time'
    ].sort()
    assert.deepEqual(indexes.map(row => row.name), expectedIndexes)

    const cohortIndexColumns = await database.all(
      'PRAGMA index_info("idx_site_flow_events_form_revision_time")'
    )
    assert.deepEqual(
      cohortIndexColumns.map(row => row.name),
      ['form_site_id', 'flow_revision', 'event_name', 'event_at', 'attempt_id']
    )

    const retentionIndexColumns = await database.all(
      'PRAGMA index_info("idx_site_flow_events_created_at")'
    )
    assert.deepEqual(
      retentionIndexColumns.map(row => row.name),
      ['created_at', 'event_at', 'id']
    )

    const secondRepair = await ensureSqliteSitesAnalyticsTrackingSchema({
      database,
      dialect: 'sqlite'
    })
    assert.deepEqual(secondRepair, { addedColumns: [], createdIndexes: [] })
    assert.deepEqual(
      await runVersionedMigrations({ database, dialect: 'sqlite', directory }),
      { applied: 0, skipped: 0 }
    )
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('la reparación SQLite falla cerrado ante un índice homónimo con definición incorrecta', async () => {
  const database = openMemoryDatabase()

  try {
    await database.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        started_at TIMESTAMP NOT NULL,
        tracking_source TEXT DEFAULT 'external_pixel',
        site_id TEXT,
        form_site_id TEXT,
        submission_id TEXT
      );

      CREATE TABLE video_playback_events (
        id TEXT PRIMARY KEY,
        event_id TEXT UNIQUE,
        playback_id TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        media_asset_id TEXT,
        site_id TEXT,
        event_at TIMESTAMP NOT NULL
      );

      CREATE INDEX idx_sessions_event_id_unique
        ON sessions(site_id);
    `)

    await assert.rejects(
      ensureSqliteSitesAnalyticsTrackingSchema({
        database,
        dialect: 'sqlite'
      }),
      error => (
        error?.code === 'SITES_ANALYTICS_INDEX_CONTRACT_MISMATCH' &&
        error?.indexName === 'idx_sessions_event_id_unique'
      )
    )

    const columns = await database.all('PRAGMA table_info("sessions")')
    assert.equal(
      columns.some(row => row.name === 'event_id'),
      false,
      'la transacción completa debe revertirse cuando el índice no es canónico'
    )
  } finally {
    await database.close()
  }
})

test('la reparación SQLite valida y repone los índices canónicos de site_flow_events', async () => {
  const database = openMemoryDatabase()
  const migrationSql = await readFile(
    new URL('../migrations/versioned/139_sites_flow_events.sqlite.sql', import.meta.url),
    'utf8'
  )

  try {
    await database.exec(migrationSql)
    await database.run('DROP INDEX idx_site_flow_events_created_at')

    const repair = await ensureSqliteSitesAnalyticsTrackingSchema({
      database,
      dialect: 'sqlite'
    })
    assert.deepEqual(repair, {
      addedColumns: [],
      createdIndexes: ['idx_site_flow_events_created_at']
    })

    await database.run('DROP INDEX idx_site_flow_events_form_revision_time')
    await database.run(`
      CREATE INDEX idx_site_flow_events_form_revision_time
      ON site_flow_events(form_site_id, flow_revision, event_at, event_name, attempt_id)
    `)

    await assert.rejects(
      ensureSqliteSitesAnalyticsTrackingSchema({
        database,
        dialect: 'sqlite'
      }),
      error => (
        error?.code === 'SITES_ANALYTICS_INDEX_CONTRACT_MISMATCH' &&
        error?.indexName === 'idx_site_flow_events_form_revision_time'
      )
    )
  } finally {
    await database.close()
  }
})

test('los trenes PostgreSQL 136/137/139/140 separan columnas, índices concurrentes y validación canónica', async () => {
  const columnSql = await readFile(
    new URL('../migrations/versioned/136a_sites_analytics_tracking_schema.postgres.sql', import.meta.url),
    'utf8'
  )

  for (const column of [
    'event_id',
    'client_started_at',
    'timestamp_adjusted',
    'event_sequence',
    'ingestion_version',
    'payload_hash',
    'tracking_source',
    'context_verified',
    'event_time_quality',
    'watch_from_seconds',
    'watch_to_seconds',
    'client_event_at'
  ]) {
    assert.match(columnSql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`))
  }
  assert.doesNotMatch(columnSql, /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i)

  const concurrentMigrations = [
    ['136b_sites_analytics_sessions_event_id.postgres.sql', 'idx_sessions_event_id_unique'],
    ['136c_sites_analytics_sessions_site_scope.postgres.sql', 'idx_sessions_site_tracking_started'],
    ['136d_sites_analytics_sessions_form_scope.postgres.sql', 'idx_sessions_form_tracking_started'],
    ['136e_sites_analytics_video_sequence.postgres.sql', 'idx_video_events_playback_sequence'],
    ['136f_sites_analytics_video_asset_scope.postgres.sql', 'idx_video_events_asset_time_type'],
    ['136g_sites_analytics_video_site_scope.postgres.sql', 'idx_video_events_site_time_type'],
    ['136h_sites_analytics_video_playback_scope.postgres.sql', 'idx_video_events_playback_type_time'],
    ['136i_sites_analytics_video_visitor_scope.postgres.sql', 'idx_video_events_visitor_time'],
    ['137a_sites_analytics_submission_evidence.postgres.sql', 'idx_sessions_submission_tracking_event'],
    ['139b_sites_flow_events_form_cohort.postgres.sql', 'idx_site_flow_events_form_revision_time'],
    ['139c_sites_flow_events_site_time.postgres.sql', 'idx_site_flow_events_site_time'],
    ['139d_sites_flow_events_attempt_order.postgres.sql', 'idx_site_flow_events_attempt_order'],
    ['139e_sites_flow_events_visitor_time.postgres.sql', 'idx_site_flow_events_visitor_time'],
    ['139f_sites_flow_events_retention.postgres.sql', 'idx_site_flow_events_created_at']
  ]
  for (const [file, index] of concurrentMigrations) {
    const sql = await readFile(new URL(`../migrations/versioned/${file}`, import.meta.url), 'utf8')
    assert.doesNotThrow(() => assertConcurrentPostgresMigrationIsIsolated(sql, file))
    assert.match(
      sql,
      new RegExp(`CREATE (?:UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS ${index}\\b`)
    )
  }

  const siteFlowTableSql = await readFile(
    new URL('../migrations/versioned/139a_sites_flow_events.postgres.sql', import.meta.url),
    'utf8'
  )
  assert.match(siteFlowTableSql, /CREATE TABLE IF NOT EXISTS site_flow_events\b/)
  assert.match(siteFlowTableSql, /\bclient_event_at TIMESTAMPTZ\b/)
  assert.match(siteFlowTableSql, /\bevent_at TIMESTAMPTZ NOT NULL\b/)
  assert.match(siteFlowTableSql, /\bcreated_at TIMESTAMPTZ NOT NULL\b/)
  assert.doesNotMatch(
    siteFlowTableSql,
    /\b(?:client_event_at|event_at|created_at)\s+TIMESTAMP(?!TZ)\b/
  )
  assert.doesNotMatch(siteFlowTableSql, /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i)

  const siteFlowCohortIndexSql = await readFile(
    new URL('../migrations/versioned/139b_sites_flow_events_form_cohort.postgres.sql', import.meta.url),
    'utf8'
  )
  assert.match(
    siteFlowCohortIndexSql,
    /site_flow_events\s*\(\s*form_site_id,\s*flow_revision,\s*event_name,\s*event_at,\s*attempt_id\s*\)/i
  )

  const siteFlowRetentionIndexSql = await readFile(
    new URL('../migrations/versioned/139f_sites_flow_events_retention.postgres.sql', import.meta.url),
    'utf8'
  )
  assert.match(
    siteFlowRetentionIndexSql,
    /site_flow_events\s*\(\s*created_at,\s*event_at,\s*id\s*\)/i
  )

  const siteFlowContractSql = await readFile(
    new URL('../migrations/versioned/139g_sites_flow_events_contract.postgres.sql', import.meta.url),
    'utf8'
  )
  assert.match(siteFlowContractSql, /\bformat_type\b/)
  assert.match(siteFlowContractSql, /timestamp with time zone/)
  assert.match(siteFlowContractSql, /\bpg_index\b/)
  assert.match(siteFlowContractSql, /\bindisvalid\b/)
  assert.match(siteFlowContractSql, /\bindisready\b/)
  assert.match(siteFlowContractSql, /'form_site_id', 'flow_revision', 'event_name', 'event_at', 'attempt_id'/)
  assert.match(siteFlowContractSql, /'created_at', 'event_at', 'id'/)
  assert.match(siteFlowContractSql, /\bRAISE EXCEPTION\b/)

  const pageFlowColumnSql = await readFile(
    new URL('../migrations/versioned/140a_sites_page_flow_revision.postgres.sql', import.meta.url),
    'utf8'
  )
  assert.match(pageFlowColumnSql, /ADD COLUMN IF NOT EXISTS page_flow_revision\b/)
  assert.match(pageFlowColumnSql, /ADD COLUMN IF NOT EXISTS page_journey_id\b/)
  assert.doesNotMatch(pageFlowColumnSql, /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i)

  const pageFlowIndexFile = '140b_sites_page_flow_revision_index.postgres.sql'
  const pageFlowIndexSql = await readFile(
    new URL(`../migrations/versioned/${pageFlowIndexFile}`, import.meta.url),
    'utf8'
  )
  assert.doesNotThrow(() => assertConcurrentPostgresMigrationIsIsolated(
    pageFlowIndexSql,
    pageFlowIndexFile
  ))
  assert.match(
    pageFlowIndexSql,
    /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_site_page_flow_started\b/
  )

  const pageFlowContractSql = await readFile(
    new URL('../migrations/versioned/140c_sites_page_flow_revision_contract.postgres.sql', import.meta.url),
    'utf8'
  )
  assert.match(pageFlowContractSql, /\bformat_type\b/)
  assert.match(pageFlowContractSql, /'page_flow_revision'/)
  assert.match(pageFlowContractSql, /'page_journey_id'/)
  assert.match(pageFlowContractSql, /\bpg_index\b/)
  assert.match(pageFlowContractSql, /\bindisvalid\b/)
  assert.match(pageFlowContractSql, /\bindisready\b/)
  assert.match(pageFlowContractSql, /'site_id',\s*'page_flow_revision',\s*'started_at'/)
  assert.match(pageFlowContractSql, /\bRAISE EXCEPTION\b/)

  const validationSql = await readFile(
    new URL('../migrations/versioned/136j_sites_analytics_index_contract.postgres.sql', import.meta.url),
    'utf8'
  )
  assert.match(validationSql, /\bpg_index\b/)
  assert.match(validationSql, /\bpg_get_expr\b/)
  assert.match(validationSql, /\bindisunique\b/)
  assert.match(validationSql, /\bindisvalid\b/)
  assert.match(validationSql, /\bindisready\b/)
  assert.match(validationSql, /\bpg_am\b/)
  assert.match(validationSql, /\bactual_access_method\b/)
  assert.match(validationSql, /'btree'/)
  assert.match(validationSql, /\bactual_columns\b/)
  assert.match(validationSql, /\bnormalized_predicate\b/)
  assert.match(validationSql, /\bRAISE EXCEPTION\b/)

  const submissionEvidenceValidationSql = await readFile(
    new URL(
      '../migrations/versioned/137b_sites_analytics_submission_evidence_contract.postgres.sql',
      import.meta.url
    ),
    'utf8'
  )
  assert.match(submissionEvidenceValidationSql, /\bpg_index\b/)
  assert.match(submissionEvidenceValidationSql, /\bpg_am\b/)
  assert.match(submissionEvidenceValidationSql, /\bindisvalid\b/)
  assert.match(submissionEvidenceValidationSql, /\bindisready\b/)
  assert.match(submissionEvidenceValidationSql, /'submission_id'/)
  assert.match(submissionEvidenceValidationSql, /'tracking_source'/)
  assert.match(submissionEvidenceValidationSql, /'event_name'/)
  assert.match(submissionEvidenceValidationSql, /'started_at'/)
  assert.match(submissionEvidenceValidationSql, /\bRAISE EXCEPTION\b/)
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

test('la migracion 141 rellena el ciclo conversacional e instala el índice de handoff en SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-conversational-handoff-schema-'))
  const database = openMemoryDatabase()
  const migrationFiles = [
    '141_conversational_handoff_activation_cycle.sqlite.sql',
    '141a_conversational_handoff_activation_cycle.postgres.sql',
    '141b_conversational_handoff_event_scope.postgres.sql',
    '141c_conversational_handoff_contract.postgres.sql'
  ]

  try {
    await database.exec(`
      CREATE TABLE conversational_agent_state (
        id TEXT PRIMARY KEY,
        activated_at DATETIME,
        created_at DATETIME,
        updated_at DATETIME
      );
      CREATE TABLE conversational_agent_events (
        id TEXT PRIMARY KEY,
        contact_id TEXT,
        agent_id TEXT,
        event_type TEXT,
        created_at DATETIME
      );
      INSERT INTO conversational_agent_state (
        id, activated_at, created_at, updated_at
      ) VALUES (
        'state_legacy', '2026-07-30 12:00:00',
        '2026-07-29 12:00:00', '2026-07-30 12:30:00'
      );
    `)

    const repair = await ensureSqliteConversationalHandoffSchema({
      database,
      dialect: 'sqlite'
    })
    assert.deepEqual(repair.addedColumns, [
      'conversational_agent_state.activation_cycle_id',
      'conversational_agent_state.activation_cycle_started_at',
      'conversational_agent_state.activation_cycle_started_message_id'
    ])

    for (const file of migrationFiles) {
      await copyFile(
        new URL(`../migrations/versioned/${file}`, import.meta.url),
        join(directory, file)
      )
    }

    const firstRun = await runVersionedMigrations({
      database,
      dialect: 'sqlite',
      directory
    })
    assert.deepEqual(firstRun, { applied: 1, skipped: 3 })

    const [state] = await database.all(
      `SELECT activation_cycle_id, activation_cycle_started_at,
              activation_cycle_started_message_id
       FROM conversational_agent_state
       WHERE id = 'state_legacy'`
    )
    assert.equal(
      state.activation_cycle_id,
      'cac_legacy_backfill_state_legacy'
    )
    assert.equal(state.activation_cycle_started_at, '2026-07-30 12:00:00')
    assert.equal(state.activation_cycle_started_message_id, null)

    const indexColumns = await database.all(
      `PRAGMA index_info('idx_conv_agent_events_contact_agent_type_created')`
    )
    assert.deepEqual(
      indexColumns.map((row) => row.name),
      ['contact_id', 'agent_id', 'event_type', 'created_at', 'id']
    )

    const secondRun = await runVersionedMigrations({
      database,
      dialect: 'sqlite',
      directory
    })
    assert.deepEqual(secondRun, { applied: 0, skipped: 0 })
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('las migraciones 142 y 143 agregan el ultimátum y su horario de respuesta en SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-appointment-confirmation-timeout-'))
  const database = openMemoryDatabase()
  const migrationFiles = [
    '142_appointment_confirmation_timeout.sqlite.sql',
    '142a_appointment_confirmation_timeout.postgres.sql',
    '143_appointment_confirmation_response_window.sqlite.sql',
    '143a_appointment_confirmation_response_window.postgres.sql'
  ]

  try {
    await database.exec(`
      CREATE TABLE appointment_reminders (
        id TEXT PRIMARY KEY,
        no_confirm_action TEXT
      );
      CREATE TABLE appointment_reminder_sends (
        id TEXT PRIMARY KEY,
        status TEXT,
        sent_at DATETIME
      );
    `)

    const repair = await ensureSqliteAppointmentConfirmationTimeoutSchema({
      database,
      dialect: 'sqlite'
    })
    assert.deepEqual(repair.addedColumns, [
      'appointment_reminders.confirmation_timeout_value',
      'appointment_reminders.confirmation_timeout_unit',
      'appointment_reminders.confirmation_timeout_mode',
      'appointment_reminders.confirmation_response_start',
      'appointment_reminders.confirmation_response_end',
      'appointment_reminder_sends.confirmation_deadline_at',
      'appointment_reminder_sends.confirmation_timeout_status',
      'appointment_reminder_sends.confirmation_timeout_processed_at'
    ])

    for (const file of migrationFiles) {
      await copyFile(
        new URL(`../migrations/versioned/${file}`, import.meta.url),
        join(directory, file)
      )
    }

    const firstRun = await runVersionedMigrations({
      database,
      dialect: 'sqlite',
      directory
    })
    assert.deepEqual(firstRun, { applied: 2, skipped: 2 })

    const reminderColumns = await database.all('PRAGMA table_info("appointment_reminders")')
    assert.deepEqual(
      reminderColumns
        .map((row) => row.name)
        .filter((name) => name.startsWith('confirmation_timeout_')),
      [
        'confirmation_timeout_value',
        'confirmation_timeout_unit',
        'confirmation_timeout_mode'
      ]
    )
    assert.deepEqual(
      reminderColumns
        .map((row) => row.name)
        .filter((name) => name.startsWith('confirmation_response_')),
      ['confirmation_response_start', 'confirmation_response_end']
    )

    const sendColumns = await database.all('PRAGMA table_info("appointment_reminder_sends")')
    assert.deepEqual(
      sendColumns
        .map((row) => row.name)
        .filter((name) => name.startsWith('confirmation_')),
      [
        'confirmation_deadline_at',
        'confirmation_timeout_status',
        'confirmation_timeout_processed_at'
      ]
    )

    const indexColumns = await database.all(
      `PRAGMA index_info('idx_appointment_reminder_sends_confirmation_deadline')`
    )
    assert.deepEqual(
      indexColumns.map((row) => row.name),
      ['confirmation_timeout_status', 'confirmation_deadline_at']
    )

    const secondRun = await runVersionedMigrations({
      database,
      dialect: 'sqlite',
      directory
    })
    assert.deepEqual(secondRun, { applied: 0, skipped: 0 })
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('la migracion 142 de PostgreSQL usa timestamps absolutos e idempotencia de rolling deploy', async () => {
  const migration = await readFile(
    new URL(
      '../migrations/versioned/142a_appointment_confirmation_timeout.postgres.sql',
      import.meta.url
    ),
    'utf8'
  )

  assert.match(migration, /ADD COLUMN IF NOT EXISTS confirmation_timeout_value INTEGER/i)
  assert.match(migration, /ADD COLUMN IF NOT EXISTS confirmation_timeout_unit TEXT/i)
  assert.match(migration, /ADD COLUMN IF NOT EXISTS confirmation_deadline_at TIMESTAMPTZ/i)
  assert.match(migration, /ADD COLUMN IF NOT EXISTS confirmation_timeout_processed_at TIMESTAMPTZ/i)
  assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_appointment_reminder_sends_confirmation_deadline/i)
  assert.doesNotMatch(migration, /\bDATETIME\b/i)
})

test('la migracion 143 de PostgreSQL conserva horas de pared y defaults compatibles', async () => {
  const migration = await readFile(
    new URL(
      '../migrations/versioned/143a_appointment_confirmation_response_window.postgres.sql',
      import.meta.url
    ),
    'utf8'
  )

  assert.match(migration, /ADD COLUMN IF NOT EXISTS confirmation_timeout_mode TEXT DEFAULT 'elapsed'/i)
  assert.match(migration, /ADD COLUMN IF NOT EXISTS confirmation_response_start TEXT DEFAULT '09:00'/i)
  assert.match(migration, /ADD COLUMN IF NOT EXISTS confirmation_response_end TEXT DEFAULT '21:00'/i)
  assert.match(migration, /SET confirmation_timeout_mode = COALESCE/i)
  assert.doesNotMatch(migration, /\bDATETIME\b/i)
})

test('la migracion 141 de PostgreSQL protege inserts de writers anteriores al rolling deploy', async () => {
  const activationMigration = await readFile(
    new URL(
      '../migrations/versioned/141a_conversational_handoff_activation_cycle.postgres.sql',
      import.meta.url
    ),
    'utf8'
  )
  const contractMigration = await readFile(
    new URL(
      '../migrations/versioned/141c_conversational_handoff_contract.postgres.sql',
      import.meta.url
    ),
    'utf8'
  )

  assert.match(
    activationMigration,
    /ALTER COLUMN activation_cycle_id\s+SET DEFAULT \(\s*'cac_legacy_insert_' \|\|\s*md5\(/i
  )
  assert.match(
    activationMigration,
    /ALTER COLUMN activation_cycle_started_at\s+SET DEFAULT CURRENT_TIMESTAMP/i
  )
  assert.match(
    activationMigration,
    /ALTER COLUMN activation_cycle_id SET NOT NULL/i
  )
  assert.match(
    activationMigration,
    /ALTER COLUMN activation_cycle_started_at SET NOT NULL/i
  )
  assert.match(
    activationMigration,
    /CREATE OR REPLACE FUNCTION capture_conversational_legacy_cycle_anchor\(\)[\s\S]*?NEW\.activation_cycle_started_message_id := NEW\.last_inbound_message_id/i
  )
  assert.match(
    activationMigration,
    /NEW\.activation_cycle_id LIKE 'cac_legacy_insert_%'[\s\S]*?OR NEW\.activation_cycle_id LIKE 'cac_legacy_reactivation_%'/i
  )
  assert.match(
    activationMigration,
    /THEN 'cac_legacy_backfill_' \|\| id/i
  )
  assert.match(
    activationMigration,
    /OLD\.status IN \('human', 'completed', 'skipped'\)[\s\S]*?NEW\.status = 'active'/i
  )
  assert.match(
    activationMigration,
    /NEW\.activation_cycle_id IS NOT DISTINCT FROM OLD\.activation_cycle_id[\s\S]*?NEW\.activation_cycle_started_at\s+IS NOT DISTINCT FROM OLD\.activation_cycle_started_at[\s\S]*?NEW\.activation_cycle_started_message_id\s+IS NOT DISTINCT FROM OLD\.activation_cycle_started_message_id/i
  )
  assert.match(
    activationMigration,
    /NEW\.activation_cycle_id :=\s*'cac_legacy_reactivation_'[\s\S]*?NEW\.activation_cycle_started_at := CURRENT_TIMESTAMP;[\s\S]*?NEW\.activation_cycle_started_message_id := NULL;/i
  )
  assert.match(
    activationMigration,
    /NEW\.last_inbound_message_id IS DISTINCT FROM OLD\.last_inbound_message_id/i
  )
  assert.match(
    activationMigration,
    /NULLIF\(BTRIM\(COALESCE\(\s*NEW\.activation_cycle_started_message_id,[\s\S]*?\)\), ''\) IS NULL[\s\S]*?NULLIF\(BTRIM\(COALESCE\(NEW\.last_inbound_message_id, ''\)\), ''\) IS NOT NULL/i
  )
  assert.match(
    activationMigration,
    /CREATE TRIGGER trg_conv_agent_state_legacy_cycle_anchor\s+BEFORE INSERT OR UPDATE OF status, last_inbound_message_id/i
  )
  assert.match(contractMigration, /cycle_id_not_null IS DISTINCT FROM TRUE/i)
  assert.match(contractMigration, /cycle_started_not_null IS DISTINCT FROM TRUE/i)
  assert.match(contractMigration, /cycle_id_default IS NULL/i)
  assert.match(contractMigration, /cycle_started_default IS NULL/i)
  assert.match(contractMigration, /cac_legacy_insert_/i)
  assert.match(
    contractMigration,
    /pg_get_triggerdef\(trigger_state\.oid, TRUE\)/i
  )
  assert.match(
    contractMigration,
    /trigger_state\.tgenabled IN \('O', 'A'\)/i
  )
})

test('la migracion 144 crea la preferencia general y conserva la elección telefónica anterior', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ristak-contact-reply-preference-'))
  const database = openMemoryDatabase()
  const sqliteFile = '144_contact_reply_channel_preferences.sqlite.sql'
  const postgresFile = '144a_contact_reply_channel_preferences.postgres.sql'

  try {
    await database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE contacts (id TEXT PRIMARY KEY);
      CREATE TABLE contact_conversational_channel_preferences (
        contact_id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        selected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        selected_by_user_id TEXT,
        selection_source TEXT NOT NULL DEFAULT 'manual',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      );
      INSERT INTO contacts (id) VALUES ('contact_legacy_preference');
      INSERT INTO contact_conversational_channel_preferences (
        contact_id, channel, selected_by_user_id, selection_source
      ) VALUES ('contact_legacy_preference', 'whatsapp', 'user_legacy', 'manual');
    `)

    for (const file of [sqliteFile, postgresFile]) {
      await copyFile(
        new URL(`../migrations/versioned/${file}`, import.meta.url),
        join(directory, file)
      )
    }

    const firstRun = await runVersionedMigrations({ database, dialect: 'sqlite', directory })
    assert.deepEqual(firstRun, { applied: 1, skipped: 1 })

    const preferences = await database.all(`
      SELECT contact_id, channel, route_id, selected_by_user_id, selection_source
      FROM contact_reply_channel_preferences
    `)
    assert.deepEqual(preferences, [{
      contact_id: 'contact_legacy_preference',
      channel: 'whatsapp',
      route_id: null,
      selected_by_user_id: 'user_legacy',
      selection_source: 'manual'
    }])

    const secondRun = await runVersionedMigrations({ database, dialect: 'sqlite', directory })
    assert.deepEqual(secondRun, { applied: 0, skipped: 0 })

    const postgresMigration = await readFile(
      new URL(`../migrations/versioned/${postgresFile}`, import.meta.url),
      'utf8'
    )
    assert.match(postgresMigration, /CREATE TABLE IF NOT EXISTS contact_reply_channel_preferences/i)
    assert.match(postgresMigration, /ON CONFLICT\(contact_id\) DO NOTHING/i)
    assert.doesNotMatch(postgresMigration, /\bDATETIME\b/i)
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})
