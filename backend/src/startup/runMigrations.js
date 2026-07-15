import { readdir, readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { databaseDialect, db } from '../config/database.js'
import { logger } from '../utils/logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// (DB-001) Carpeta de migraciones VERSIONADAS y seguras. Se ejecutan en orden por
// nombre (001_, 002_, ...), una sola vez cada una, y se registran en schema_migrations.
//
// IMPORTANTE (DB-002): los .sql sueltos de backend/migrations/ son LEGACY y
// potencialmente destructivos (cleanup_duplicate_payments, remove_payments_fk,
// convert_to_timestamptz...). NO se ejecutan aquí: el esquema base lo crea initTables()
// de forma idempotente, y estas migraciones versionadas solo aplican cambios ADITIVOS
// nuevos. Así nunca corremos a ciegas una migración destructiva vieja.
const migrationsDir = join(__dirname, '../../migrations/versioned')

const ALREADY_EXISTS = /already exists|duplicate column|duplicate key|exists/i
const POSTGRES_ONLY_MIGRATION_SUFFIX = '.postgres.sql'
const SQLITE_ONLY_MIGRATION_SUFFIX = '.sqlite.sql'
const VERSIONED_MIGRATION_LOCK_NAME = 'versioned-migrations'
const VERSIONED_MIGRATION_LOCK_WAIT_MS = 15 * 60_000
// A partir del tren 091 todas las migraciones nuevas deben fallar cerrado. Si
// un objeto homonimo existe, hay que verificarlo; jamas maquillar una ejecucion
// parcial como aplicada. Incluye 100+ (snapshots de Reportes/Publicidad y los
// siguientes trenes), no solo 091-099.
const GUARDED_VERSIONED_MIGRATION = /^(?:09[1-9]|1\d{2})/
const DEFAULT_POSTGRES_DDL_POLICY = Object.freeze({
  lockTimeoutMs: 10_000,
  statementTimeoutMs: 15 * 60_000,
  maxAttempts: 3,
  retryBaseMs: 500
})

const RETRYABLE_POSTGRES_DDL_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available / lock_timeout
  '57014' // query_canceled / statement_timeout
])

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function boundedNumber(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

function normalizePostgresDdlPolicy(policy = {}) {
  return {
    lockTimeoutMs: boundedNumber(
      policy.lockTimeoutMs,
      DEFAULT_POSTGRES_DDL_POLICY.lockTimeoutMs,
      { min: 1, max: 60_000 }
    ),
    statementTimeoutMs: boundedNumber(
      policy.statementTimeoutMs,
      DEFAULT_POSTGRES_DDL_POLICY.statementTimeoutMs,
      { min: 1, max: 60 * 60_000 }
    ),
    maxAttempts: boundedNumber(
      policy.maxAttempts,
      DEFAULT_POSTGRES_DDL_POLICY.maxAttempts,
      { min: 1, max: 5 }
    ),
    retryBaseMs: boundedNumber(
      policy.retryBaseMs,
      DEFAULT_POSTGRES_DDL_POLICY.retryBaseMs,
      { min: 0, max: 60_000 }
    )
  }
}

function concurrentCreateIndexName(sql) {
  const withoutComments = String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*--.*$/gm, ' ')
  const match = withoutComments.match(
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_$]*)\b/i
  )
  return match?.[1] || null
}

export function assertConcurrentPostgresMigrationIsIsolated(sql, file = 'migration.sql') {
  const withoutComments = String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*--.*$/gm, ' ')
  const statements = withoutComments
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean)
  const concurrentStatements = statements.filter(statement => (
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(statement) ||
    /\bDROP\s+INDEX\s+CONCURRENTLY\b/i.test(statement)
  ))
  if (concurrentStatements.length === 0) return
  if (statements.length !== 1 || concurrentStatements.length !== 1) {
    throw Object.assign(
      new Error(
        `${file} mezcla INDEX CONCURRENTLY con otra sentencia; cada DDL concurrente debe vivir solo en su archivo.`
      ),
      { code: 'POSTGRES_CONCURRENT_DDL_NOT_ISOLATED' }
    )
  }
}

function hasConcurrentPostgresIndexDdl(sql) {
  return /\b(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX)\s+CONCURRENTLY\b/i.test(
    String(sql || '')
  )
}

function quotePostgresIdentifier(value) {
  return `"${String(value || '').replaceAll('"', '""')}"`
}

function isRetryablePostgresDdlError(error) {
  const code = String(error?.code || '')
  if (!RETRYABLE_POSTGRES_DDL_CODES.has(code)) return false
  if (code !== '57014') return true
  return /statement timeout|lock timeout|canceling statement/i.test(String(error?.message || ''))
}

async function dropInvalidConcurrentIndex(database, indexName, file) {
  if (!indexName) return false
  const row = await database.get(`
    SELECT
      namespace.nspname AS schema_name,
      relation.relname AS index_name,
      index_state.indisvalid,
      index_state.indisready
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_index index_state ON index_state.indexrelid = relation.oid
    WHERE relation.oid = to_regclass(?)
  `, [indexName])
  if (!row || (row.indisvalid === true && row.indisready === true)) return false

  const qualifiedName = `${quotePostgresIdentifier(row.schema_name)}.${quotePostgresIdentifier(row.index_name)}`
  logger.warn(
    `[Migraciones] ${file}: retirando indice concurrente invalido ${qualifiedName} antes de reconstruirlo.`
  )
  await database.exec(`DROP INDEX CONCURRENTLY IF EXISTS ${qualifiedName}`)
  return true
}

async function executePostgresMigrationWithPolicy({
  database,
  file,
  sql,
  policy
}) {
  assertConcurrentPostgresMigrationIsIsolated(sql, file)
  const indexName = concurrentCreateIndexName(sql)
  const concurrentDdl = hasConcurrentPostgresIndexDdl(sql)
  // Todo CREATE INDEX CONCURRENTLY necesita recuperacion de artifacts invalidos.
  // El tren 091+ ademas queda acotado aunque el archivo no cree un indice.
  const guarded = Boolean(indexName) || GUARDED_VERSIONED_MIGRATION.test(file)
  const attempts = guarded ? policy.maxAttempts : 1

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let configured = false
    let operationError = null
    try {
      if (guarded && typeof database.configureVersionedMigrationSession === 'function') {
        await database.configureVersionedMigrationSession(policy)
        configured = true
      }
      await dropInvalidConcurrentIndex(database, indexName, file)
      if (guarded && !concurrentDdl) {
        if (typeof database.transaction !== 'function') {
          throw Object.assign(
            new Error(`La migracion PostgreSQL protegida ${file} necesita una transaccion real.`),
            { code: 'POSTGRES_MIGRATION_TRANSACTION_REQUIRED' }
          )
        }
        await database.transaction(async (transaction) => {
          await transaction.exec(sql)
          await transaction.run(
            'INSERT INTO schema_migrations (name) VALUES (?) ON CONFLICT DO NOTHING',
            [file]
          )
        })
      } else {
        // CREATE/DROP INDEX CONCURRENTLY no admite bloque transaccional. Estos
        // archivos estan aislados por el guard anterior y son retry-safe por
        // IF [NOT] EXISTS; si cae el proceso antes del ledger, se repiten bien.
        await database.exec(sql)
        await database.run('INSERT INTO schema_migrations (name) VALUES (?) ON CONFLICT DO NOTHING', [file])
      }
    } catch (error) {
      operationError = error
    } finally {
      if (configured && typeof database.resetVersionedMigrationSession === 'function') {
        try {
          await database.resetVersionedMigrationSession()
        } catch (resetError) {
          operationError = operationError || resetError
        }
      }
    }

    if (!operationError) return
    if (!isRetryablePostgresDdlError(operationError) || attempt >= attempts) {
      throw operationError
    }
    const delayMs = policy.retryBaseMs * attempt
    logger.warn(
      `[Migraciones] ${file}: DDL transitorio (${operationError.code || operationError.message}); ` +
      `reintento ${attempt + 1}/${attempts} en ${delayMs}ms.`
    )
    if (delayMs > 0) await sleep(delayMs)
  }
}

async function executeSqliteMigrationAtomically({ database, file, sql }) {
  if (typeof database.transaction !== 'function') {
    throw Object.assign(
      new Error(`La migracion SQLite protegida ${file} necesita una transaccion real.`),
      { code: 'SQLITE_MIGRATION_TRANSACTION_REQUIRED' }
    )
  }

  await database.transaction(async (transaction) => {
    await transaction.exec(sql)
    await transaction.run(
      'INSERT INTO schema_migrations (name) VALUES (?) ON CONFLICT DO NOTHING',
      [file]
    )
  })
}

export function migrationRunsForDialect(file, dialect = databaseDialect) {
  const migrationName = String(file || '')
  if (migrationName.endsWith(POSTGRES_ONLY_MIGRATION_SUFFIX)) {
    return dialect === 'postgres'
  }
  if (migrationName.endsWith(SQLITE_ONLY_MIGRATION_SUFFIX)) {
    return dialect === 'sqlite'
  }
  return true
}

function migrationDialectLabel(file) {
  return String(file || '').endsWith(SQLITE_ONLY_MIGRATION_SUFFIX)
    ? 'SQLite'
    : 'PostgreSQL'
}

/**
 * Aplica las migraciones versionadas pendientes. Idempotente y tolerante a:
 *  - múltiples instancias (deploy overlap): la migración ya aplicada se salta;
 *    el candado distribuido impide que dos instancias ejecuten el mismo archivo.
 *  - aplicación previa manual de cambios legacy: antes del tren 091 se conserva
 *    la compatibilidad de "ya existe". Desde 091 cualquier discrepancia falla
 *    cerrada; SQLite ejecuta DDL + ledger dentro de una sola transaccion.
 * Funciona en SQLite (dev) y PostgreSQL (prod) usando la abstracción db.
 */
async function runVersionedMigrationsUnlocked({
  database = db,
  dialect = databaseDialect,
  directory = migrationsDir,
  postgresDdlPolicy = DEFAULT_POSTGRES_DDL_POLICY
} = {}) {
  const normalizedPostgresDdlPolicy = normalizePostgresDdlPolicy(postgresDdlPolicy)
  await database.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)

  let files = []
  try {
    files = (await readdir(directory)).filter(f => f.endsWith('.sql')).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return { applied: 0, skipped: 0 }
    throw error
  }

  const appliedRows = await database.all('SELECT name FROM schema_migrations')
  const applied = new Set(appliedRows.map(r => r.name))

  let count = 0
  let skipped = 0
  for (const file of files) {
    if (applied.has(file)) continue

    if (!migrationRunsForDialect(file, dialect)) {
      logger.info(`[Migraciones] Omitiendo ${file}: sólo aplica a ${migrationDialectLabel(file)}.`)
      await database.run('INSERT INTO schema_migrations (name) VALUES (?) ON CONFLICT DO NOTHING', [file])
      applied.add(file)
      skipped += 1
      continue
    }

    const sql = await readFile(join(directory, file), 'utf8')
    logger.info(`[Migraciones] Aplicando ${file}...`)
    try {
      if (dialect === 'postgres') {
        await executePostgresMigrationWithPolicy({
          database,
          file,
          sql,
          policy: normalizedPostgresDdlPolicy
        })
      } else if (GUARDED_VERSIONED_MIGRATION.test(file)) {
        await executeSqliteMigrationAtomically({ database, file, sql })
      } else {
        await database.exec(sql)
        await database.run('INSERT INTO schema_migrations (name) VALUES (?) ON CONFLICT DO NOTHING', [file])
      }
      applied.add(file)
      count += 1
      logger.success(`[Migraciones] Aplicada ${file}`)
    } catch (error) {
      // Desde 091 un "already exists" inesperado puede ser un archivo parcial
      // o un objeto homonimo incorrecto en cualquiera de los dos dialectos.
      // Nunca se maquilla como aplicado.
      const strictMigration = GUARDED_VERSIONED_MIGRATION.test(file)
      if (!strictMigration && ALREADY_EXISTS.test(String(error.message || ''))) {
        logger.warn(`[Migraciones] ${file}: el objeto ya existía (${error.message}); se marca como aplicada.`)
        await database.run('INSERT INTO schema_migrations (name) VALUES (?) ON CONFLICT DO NOTHING', [file])
        applied.add(file)
      } else {
        logger.error(`[Migraciones] Falló ${file}: ${error.message}`)
        throw error
      }
    }
  }

  if (count > 0) logger.success(`[Migraciones] ${count} migración(es) versionada(s) aplicada(s).`)
  else logger.info('[Migraciones] Esquema versionado al día.')
  return { applied: count, skipped }
}

export async function runVersionedMigrations(options = {}) {
  const database = options.database || db
  const dialect = options.dialect || databaseDialect

  // Las cadenas PostgreSQL pueden abarcar varios archivos y procedimientos que
  // hacen COMMIT por lote. Un lock de sesion serializa la cadena completa sin
  // envolver CREATE INDEX CONCURRENTLY ni CALL en una transaccion.
  if (dialect !== 'postgres' || typeof database.withAdvisoryLock !== 'function') {
    return runVersionedMigrationsUnlocked({ ...options, database, dialect })
  }

  const startedAt = Date.now()
  let waitLogged = false
  while (true) {
    let callbackStarted = false
    try {
      return await database.withAdvisoryLock(VERSIONED_MIGRATION_LOCK_NAME, async (lockedDatabase) => {
        callbackStarted = true
        return runVersionedMigrationsUnlocked({
          ...options,
          database: lockedDatabase || database,
          dialect
        })
      })
    } catch (error) {
      // Si el callback ya empezo, el error pertenece a una migracion y jamas se
      // reintenta toda la cadena. Solo esperamos el try-lock ocupado al entrar.
      if (error?.code !== 'DATABASE_ADVISORY_LOCK_BUSY' || callbackStarted) throw error
      if (Date.now() - startedAt >= VERSIONED_MIGRATION_LOCK_WAIT_MS) {
        throw Object.assign(
          new Error('Otra instancia no liberó a tiempo el candado de migraciones versionadas.'),
          { code: 'VERSIONED_MIGRATION_LOCK_TIMEOUT' }
        )
      }
      if (!waitLogged) {
        waitLogged = true
        logger.info('[Migraciones] Otra instancia está migrando; este arranque esperará el mismo resultado.')
      }
      await sleep(500)
    }
  }
}
