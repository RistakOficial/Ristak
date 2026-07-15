import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import pg from 'pg'

import {
  assertConcurrentPostgresMigrationIsIsolated,
  runVersionedMigrations
} from '../src/startup/runMigrations.js'

const connectionString = process.env.RISTAK_TEST_POSTGRES_URL || ''

function convertPlaceholders(sql) {
  let index = 0
  return String(sql).replace(/\?/g, () => `$${++index}`)
}

function createMigrationAdapter(client) {
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
    async configureVersionedMigrationSession({ lockTimeoutMs, statementTimeoutMs }) {
      await client.query(`
        SELECT
          set_config('lock_timeout', $1, false),
          set_config('statement_timeout', $2, false)
      `, [`${lockTimeoutMs}ms`, `${statementTimeoutMs}ms`])
    },
    async resetVersionedMigrationSession() {
      await client.query('RESET lock_timeout; RESET statement_timeout')
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
    },
    async withAdvisoryLock(_name, callback) {
      return callback(adapter)
    }
  }
  return adapter
}

async function withIsolatedPostgres(prefix, callback) {
  const client = new pg.Client({ connectionString })
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`))
  await client.connect()
  try {
    await client.query(`CREATE SCHEMA "${schema}"`)
    await client.query(`SET search_path TO "${schema}", public`)
    return await callback({ client, schema, directory, database: createMigrationAdapter(client) })
  } finally {
    await client.query('RESET lock_timeout; RESET statement_timeout').catch(() => undefined)
    await client.query('SET search_path TO public').catch(() => undefined)
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await client.end().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}

const fastPolicy = Object.freeze({
  lockTimeoutMs: 100,
  statementTimeoutMs: 5_000,
  maxAttempts: 3,
  retryBaseMs: 25
})

test('rechaza INDEX CONCURRENTLY mezclado con extension u otra sentencia', () => {
  assert.throws(
    () => assertConcurrentPostgresMigrationIsIsolated(`
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE INDEX CONCURRENTLY idx_fixture ON fixture USING GIN (name gin_trgm_ops);
    `, '105c_fixture.postgres.sql'),
    (error) => error?.code === 'POSTGRES_CONCURRENT_DDL_NOT_ISOLATED'
  )
  assert.doesNotThrow(() => assertConcurrentPostgresMigrationIsIsolated(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fixture ON fixture(id);
  `, '105c_fixture.postgres.sql'))
})

test('094a/094b crean cursores inmutables sobre TIMESTAMP y TIMESTAMPTZ', {
  skip: !connectionString
}, async () => {
  const migrationFiles = [
    '094a_contacts_effective_created_cursor.postgres.sql',
    '094b_report_transactions_effective_at_v2.postgres.sql'
  ]

  for (const timestampType of ['TIMESTAMP', 'TIMESTAMPTZ']) {
    await withIsolatedPostgres(`ristak_cursor_type_${timestampType.toLowerCase()}`, async ({
      client,
      directory,
      database
    }) => {
      await client.query(`
        CREATE TABLE contacts (
          id TEXT PRIMARY KEY,
          created_at ${timestampType}
        );
        CREATE TABLE payments (
          id TEXT PRIMARY KEY,
          payment_mode TEXT,
          date ${timestampType},
          created_at ${timestampType}
        );
      `)

      for (const file of migrationFiles) {
        const sql = await readFile(new URL(`../migrations/versioned/${file}`, import.meta.url), 'utf8')
        await writeFile(join(directory, file), sql)
      }

      assert.deepEqual(
        await runVersionedMigrations({
          database,
          dialect: 'postgres',
          directory,
          postgresDdlPolicy: fastPolicy
        }),
        { applied: 2, skipped: 0 }
      )

      const indexStates = await client.query(`
        SELECT relation.relname AS index_name, state.indisvalid, state.indisready
        FROM pg_index state
        JOIN pg_class relation ON relation.oid = state.indexrelid
        WHERE relation.relname IN (
          'idx_contacts_cursor_effective_created_at_id',
          'idx_report_transactions_effective_at_id_v2'
        )
        ORDER BY relation.relname
      `)
      assert.equal(indexStates.rows.length, 2)
      assert.equal(indexStates.rows.every(row => row.indisvalid && row.indisready), true)

      await client.query('SET enable_seqscan TO off')
      try {
        const contactPlan = await client.query(`
          EXPLAIN (FORMAT JSON, COSTS OFF)
          SELECT id
          FROM contacts
          WHERE (COALESCE(created_at, '1970-01-01 00:00:00+00'), id)
            < ('2100-01-01 00:00:00+00', 'zzzz')
          ORDER BY COALESCE(created_at, '1970-01-01 00:00:00+00') DESC, id DESC
          LIMIT 50
        `)
        const contactPlanJson = JSON.stringify(contactPlan.rows[0]['QUERY PLAN'])
        assert.match(contactPlanJson, /idx_contacts_cursor_effective_created_at_id/)
        assert.doesNotMatch(contactPlanJson, /"Node Type":"Sort"/)

        const transactionPlan = await client.query(`
          EXPLAIN (FORMAT JSON, COSTS OFF)
          SELECT id
          FROM payments
          WHERE COALESCE(payment_mode, 'live') != 'test'
            AND (COALESCE(date, created_at, '1970-01-01 00:00:00+00'), id)
              < ('2100-01-01 00:00:00+00', 'zzzz')
          ORDER BY COALESCE(date, created_at, '1970-01-01 00:00:00+00') DESC, id DESC
          LIMIT 50
        `)
        const transactionPlanJson = JSON.stringify(transactionPlan.rows[0]['QUERY PLAN'])
        assert.match(transactionPlanJson, /idx_report_transactions_effective_at_id_v2/)
        assert.doesNotMatch(transactionPlanJson, /"Node Type":"Sort"/)
      } finally {
        await client.query('RESET enable_seqscan')
      }

      assert.deepEqual(
        await runVersionedMigrations({ database, dialect: 'postgres', directory }),
        { applied: 0, skipped: 0 }
      )
    })
  }
})

test('recupera un indice CONCURRENTLY homonimo indisvalid=false antes de marcar la migracion', {
  skip: !connectionString
}, async () => {
  await withIsolatedPostgres('ristak_invalid_index', async ({ client, directory, database }) => {
    await client.query(`
      CREATE TABLE migration_index_fixture (
        id BIGSERIAL PRIMARY KEY,
        group_key INTEGER NOT NULL
      );
      INSERT INTO migration_index_fixture (group_key) VALUES (7), (7), (8);
    `)

    await assert.rejects(
      client.query(`
        CREATE UNIQUE INDEX CONCURRENTLY idx_migration_invalid_fixture
        ON migration_index_fixture(group_key)
      `),
      /could not create unique index|duplicate key/i
    )
    const invalid = await client.query(`
      SELECT indisvalid, indisready
      FROM pg_index
      WHERE indexrelid = to_regclass($1)
    `, ['idx_migration_invalid_fixture'])
    assert.equal(invalid.rows[0]?.indisvalid, false)

    const file = '091a_recover_invalid_index.postgres.sql'
    await writeFile(join(directory, file), `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_migration_invalid_fixture
      ON migration_index_fixture(group_key, id);
    `)

    assert.deepEqual(
      await runVersionedMigrations({
        database,
        dialect: 'postgres',
        directory,
        postgresDdlPolicy: fastPolicy
      }),
      { applied: 1, skipped: 0 }
    )

    const repaired = await client.query(`
      SELECT
        index_state.indisvalid,
        index_state.indisready,
        index_state.indisunique,
        pg_get_indexdef(index_state.indexrelid) AS definition
      FROM pg_index index_state
      WHERE index_state.indexrelid = to_regclass($1)
    `, ['idx_migration_invalid_fixture'])
    assert.equal(repaired.rows[0]?.indisvalid, true)
    assert.equal(repaired.rows[0]?.indisready, true)
    assert.equal(repaired.rows[0]?.indisunique, false)
    assert.match(repaired.rows[0]?.definition || '', /\(group_key, id\)/)
    assert.deepEqual(
      await runVersionedMigrations({ database, dialect: 'postgres', directory }),
      { applied: 0, skipped: 0 }
    )
  })
})

test('lock_timeout reintenta el DDL 091-099 y solo publica ledger despues del exito', {
  skip: !connectionString
}, async () => {
  await withIsolatedPostgres('ristak_migration_lock', async ({ client, schema, directory, database }) => {
    const locker = new pg.Client({ connectionString })
    await locker.connect()
    let released = false
    try {
      await client.query('CREATE TABLE migration_lock_fixture (id TEXT PRIMARY KEY)')
      await locker.query(`SET search_path TO "${schema}", public`)
      await locker.query('BEGIN')
      await locker.query('LOCK TABLE migration_lock_fixture IN ACCESS EXCLUSIVE MODE')

      const file = '091b_retry_lock_timeout.postgres.sql'
      await writeFile(join(directory, file), `
        ALTER TABLE migration_lock_fixture ADD COLUMN IF NOT EXISTS recovered TEXT;
        CREATE TABLE IF NOT EXISTS migration_after_lock (id TEXT PRIMARY KEY);
      `)

      let ddlAttempts = 0
      const originalExec = database.exec.bind(database)
      database.exec = async (sql) => {
        if (/ALTER TABLE migration_lock_fixture/.test(sql)) ddlAttempts += 1
        return originalExec(sql)
      }

      const releasePromise = new Promise((resolve, reject) => {
        setTimeout(() => {
          locker.query('COMMIT')
            .then(() => {
              released = true
              resolve()
            })
            .catch(reject)
        }, 250)
      })

      const result = await runVersionedMigrations({
        database,
        dialect: 'postgres',
        directory,
        postgresDdlPolicy: {
          lockTimeoutMs: 30,
          statementTimeoutMs: 2_000,
          maxAttempts: 3,
          retryBaseMs: 75
        }
      })
      await releasePromise

      assert.deepEqual(result, { applied: 1, skipped: 0 })
      assert.ok(ddlAttempts >= 2, `se esperaban al menos dos intentos, hubo ${ddlAttempts}`)
      assert.equal((await client.query(`
        SELECT COUNT(*)::int AS total
        FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = 'migration_lock_fixture'
          AND column_name = 'recovered'
      `, [schema])).rows[0].total, 1)
      assert.equal((await client.query(
        'SELECT COUNT(*)::int AS total FROM schema_migrations WHERE name = $1',
        [file]
      )).rows[0].total, 1)
    } finally {
      if (!released) await locker.query('ROLLBACK').catch(() => undefined)
      await locker.end().catch(() => undefined)
    }
  })
})

test('statement_timeout revierte el archivo multi-statement y nunca lo marca a medias', {
  skip: !connectionString
}, async () => {
  await withIsolatedPostgres('ristak_migration_timeout', async ({ client, directory, database }) => {
    const file = '091c_statement_timeout.postgres.sql'
    await writeFile(join(directory, file), `
      CREATE TABLE migration_partial_fixture (id TEXT PRIMARY KEY);
      SELECT pg_sleep(0.15);
    `)

    await assert.rejects(
      runVersionedMigrations({
        database,
        dialect: 'postgres',
        directory,
        postgresDdlPolicy: {
          lockTimeoutMs: 100,
          statementTimeoutMs: 40,
          maxAttempts: 2,
          retryBaseMs: 10
        }
      }),
      (error) => error?.code === '57014'
    )

    assert.equal((await client.query(
      'SELECT to_regclass($1) AS relation',
      ['migration_partial_fixture']
    )).rows[0].relation, null)
    assert.equal((await client.query(
      'SELECT COUNT(*)::int AS total FROM schema_migrations WHERE name = $1',
      [file]
    )).rows[0].total, 0)
  })
})

test('el tren 100+ falla cerrado ante un objeto homonimo y no publica ledger', {
  skip: !connectionString
}, async () => {
  await withIsolatedPostgres('ristak_migration_strict_100', async ({ client, directory, database }) => {
    const file = '101a_strict_snapshot.postgres.sql'
    await client.query('CREATE TABLE strict_snapshot_fixture (id TEXT PRIMARY KEY)')
    await writeFile(join(directory, file), `
      CREATE TABLE strict_snapshot_fixture (id TEXT PRIMARY KEY);
    `)

    await assert.rejects(
      runVersionedMigrations({ database, dialect: 'postgres', directory }),
      /already exists/i
    )
    assert.equal((await client.query(
      'SELECT COUNT(*)::int AS total FROM schema_migrations WHERE name = $1',
      [file]
    )).rows[0].total, 0)
  })
})
