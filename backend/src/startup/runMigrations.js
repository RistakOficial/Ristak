import { readdir, readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { db } from '../config/database.js'
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

/**
 * Aplica las migraciones versionadas pendientes. Idempotente y tolerante a:
 *  - múltiples instancias (deploy overlap): la migración ya aplicada se salta;
 *    si dos instancias chocan, el objeto "ya existe" se trata como aplicado en vez
 *    de tumbar el arranque.
 *  - aplicación previa manual de un cambio: igual, se marca aplicada y se sigue.
 * Funciona en SQLite (dev) y PostgreSQL (prod) usando la abstracción db.
 */
export async function runVersionedMigrations() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)

  let files = []
  try {
    files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return { applied: 0 }
    throw error
  }

  const appliedRows = await db.all('SELECT name FROM schema_migrations')
  const applied = new Set(appliedRows.map(r => r.name))

  let count = 0
  for (const file of files) {
    if (applied.has(file)) continue

    const sql = await readFile(join(migrationsDir, file), 'utf8')
    logger.info(`[Migraciones] Aplicando ${file}...`)
    try {
      await db.exec(sql)
      await db.run('INSERT INTO schema_migrations (name) VALUES (?) ON CONFLICT DO NOTHING', [file])
      count += 1
      logger.success(`[Migraciones] Aplicada ${file}`)
    } catch (error) {
      if (ALREADY_EXISTS.test(String(error.message || ''))) {
        logger.warn(`[Migraciones] ${file}: el objeto ya existía (${error.message}); se marca como aplicada.`)
        await db.run('INSERT INTO schema_migrations (name) VALUES (?) ON CONFLICT DO NOTHING', [file])
      } else {
        logger.error(`[Migraciones] Falló ${file}: ${error.message}`)
        throw error
      }
    }
  }

  if (count > 0) logger.success(`[Migraciones] ${count} migración(es) versionada(s) aplicada(s).`)
  else logger.info('[Migraciones] Esquema versionado al día.')
  return { applied: count }
}
