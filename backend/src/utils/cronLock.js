import { db } from '../config/database.js'
import { logger } from './logger.js'

function sqlNow(offsetMs = 0) {
  // Formato 'YYYY-MM-DD HH:MM:SS' (UTC) para comparar bien en SQLite (texto) y Postgres (timestamp).
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * (CRON-009) Ejecuta fn solo si se obtiene el lock distribuido `name`. Evita que un cron
 * sensible (p. ej. cobros) corra en dos instancias a la vez. El lock se reclama si está
 * libre o EXPIRADO (ttlMs), y se libera al terminar. Portable SQLite/Postgres.
 *
 * Fail-open a propósito: si la tabla de locks no existe o hay un error de DB, se ejecuta
 * fn igual (no es peor que el comportamiento previo sin lock).
 *
 * @param {string} name
 * @param {number} ttlMs - vida del lock si el proceso muere sin liberar (usa el intervalo del cron)
 * @param {() => Promise<any>} fn
 * @returns {Promise<{ ran: boolean }>}
 */
export async function withCronLock(name, ttlMs, fn) {
  let acquired = false
  try {
    const res = await db.run(
      `INSERT INTO cron_locks (name, locked_until) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET locked_until = excluded.locked_until
       WHERE cron_locks.locked_until <= ?`,
      [name, sqlNow(Math.max(1000, ttlMs)), sqlNow(0)]
    )
    acquired = Number(res?.changes || 0) > 0
  } catch (error) {
    logger.warn(`[CronLock] No se pudo evaluar el lock "${name}" (se ejecuta igual): ${error.message}`)
    return { ran: await runSafely(fn) }
  }

  if (!acquired) return { ran: false }

  try {
    await fn()
    return { ran: true }
  } finally {
    try {
      // Liberar: dejar locked_until en el pasado para que el siguiente tick pueda tomarlo.
      await db.run('UPDATE cron_locks SET locked_until = ? WHERE name = ?', [sqlNow(0), name])
    } catch (error) {
      logger.warn(`[CronLock] No se pudo liberar el lock "${name}": ${error.message}`)
    }
  }
}

async function runSafely(fn) {
  await fn()
  return true
}
