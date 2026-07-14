import assert from 'node:assert/strict'
import { mkdtemp, copyFile, rm, writeFile } from 'node:fs/promises'
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
  return {
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
    close() {
      return new Promise((resolve, reject) => {
        connection.close((error) => error ? reject(error) : resolve())
      })
    }
  }
}

test('las migraciones con sufijo de dialecto sólo apuntan a su motor', () => {
  assert.equal(migrationRunsForDialect('041_payments_amount_numeric.postgres.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('041_payments_amount_numeric.postgres.sql', 'sqlite'), false)
  assert.equal(migrationRunsForDialect('050_tracking_performance_indexes.sqlite.sql', 'sqlite'), true)
  assert.equal(migrationRunsForDialect('050_tracking_performance_indexes.sqlite.sql', 'postgres'), false)
  assert.equal(migrationRunsForDialect('051_message_analytics_indexes.sqlite.sql', 'sqlite'), true)
  assert.equal(migrationRunsForDialect('051_message_analytics_indexes.sqlite.sql', 'postgres'), false)
  assert.equal(migrationRunsForDialect('040_common.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('040_common.sql', 'sqlite'), true)
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
