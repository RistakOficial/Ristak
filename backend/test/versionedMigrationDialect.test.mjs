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

test('las migraciones .postgres.sql solo apuntan a PostgreSQL', () => {
  assert.equal(migrationRunsForDialect('041_payments_amount_numeric.postgres.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('041_payments_amount_numeric.postgres.sql', 'sqlite'), false)
  assert.equal(migrationRunsForDialect('040_common.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('040_common.sql', 'sqlite'), true)
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
