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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
 *    si dos instancias chocan, el objeto "ya existe" se trata como aplicado en vez
 *    de tumbar el arranque.
 *  - aplicación previa manual de un cambio: igual, se marca aplicada y se sigue.
 * Funciona en SQLite (dev) y PostgreSQL (prod) usando la abstracción db.
 */
async function runVersionedMigrationsUnlocked({
  database = db,
  dialect = databaseDialect,
  directory = migrationsDir
} = {}) {
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
      await database.exec(sql)
      await database.run('INSERT INTO schema_migrations (name) VALUES (?) ON CONFLICT DO NOTHING', [file])
      applied.add(file)
      count += 1
      logger.success(`[Migraciones] Aplicada ${file}`)
    } catch (error) {
      if (ALREADY_EXISTS.test(String(error.message || ''))) {
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
