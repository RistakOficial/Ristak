import crypto from 'crypto'
import { db } from '../config/database.js'
import { logger } from './logger.js'

const PROCESS_LOCK_OWNER_ID = `${process.pid}:${crypto.randomUUID()}`

function sqlNow(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ')
}

function normalizeLockName(name) {
  return String(name || '').trim()
}

function normalizeTtlMs(ttlMs) {
  const numericTtl = Number(ttlMs)
  return Number.isFinite(numericTtl) && numericTtl > 0
    ? Math.max(1000, Math.floor(numericTtl))
    : 60_000
}

export function getDistributedLockOwnerId() {
  return PROCESS_LOCK_OWNER_ID
}

export async function acquireDistributedLock(name, ttlMs, { failOpen = true } = {}) {
  const cleanName = normalizeLockName(name)
  if (!cleanName) throw new Error('Falta el nombre del lock distribuido')

  const leaseTtlMs = normalizeTtlMs(ttlMs)
  const ownerId = PROCESS_LOCK_OWNER_ID
  const lockedUntil = sqlNow(leaseTtlMs)
  const now = sqlNow(0)

  try {
    const result = await db.run(`
      INSERT INTO distributed_locks (name, owner_id, locked_until, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(name) DO UPDATE SET
        owner_id = excluded.owner_id,
        locked_until = excluded.locked_until,
        updated_at = CURRENT_TIMESTAMP
      WHERE distributed_locks.locked_until <= ?
         OR distributed_locks.owner_id = ?
    `, [cleanName, ownerId, lockedUntil, now, ownerId])

    return {
      acquired: Number(result?.changes || 0) > 0,
      lock: {
        name: cleanName,
        ownerId,
        ttlMs: leaseTtlMs,
        failOpen: false
      }
    }
  } catch (error) {
    if (!failOpen) throw error
    logger.warn(`[DistributedLock] No se pudo adquirir "${cleanName}" (se permite continuar): ${error.message}`)
    return {
      acquired: true,
      lock: {
        name: cleanName,
        ownerId,
        ttlMs: leaseTtlMs,
        failOpen: true
      }
    }
  }
}

export async function renewDistributedLock(lock) {
  if (!lock?.name || !lock?.ownerId) return false
  if (lock.failOpen) return true

  try {
    const result = await db.run(`
      UPDATE distributed_locks
      SET locked_until = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE name = ?
        AND owner_id = ?
    `, [sqlNow(normalizeTtlMs(lock.ttlMs)), lock.name, lock.ownerId])
    return Number(result?.changes || 0) > 0
  } catch (error) {
    logger.warn(`[DistributedLock] No se pudo renovar "${lock.name}": ${error.message}`)
    return false
  }
}

export async function releaseDistributedLock(lock) {
  if (!lock?.name || !lock?.ownerId || lock.failOpen) return false

  try {
    const result = await db.run(`
      UPDATE distributed_locks
      SET locked_until = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE name = ?
        AND owner_id = ?
    `, [sqlNow(0), lock.name, lock.ownerId])
    return Number(result?.changes || 0) > 0
  } catch (error) {
    logger.warn(`[DistributedLock] No se pudo liberar "${lock.name}": ${error.message}`)
    return false
  }
}
