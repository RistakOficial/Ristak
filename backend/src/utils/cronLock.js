import { logger } from './logger.js'
import {
  acquireDistributedLock,
  releaseDistributedLock,
  renewDistributedLock
} from './distributedLock.js'

/**
 * Ejecuta fn con un lease distribuido con dueño y renovación. Los crones
 * financieros deben pasar failOpen:false: si la DB no puede demostrar que esta
 * instancia es la única dueña, no se cobra.
 */
export async function withCronLock(name, ttlMs, fn, { failOpen = true, leaseTtlMs } = {}) {
  const leaseDuration = Math.max(Number(leaseTtlMs || 0), Number(ttlMs || 0), 60_000)
  const { acquired, lock } = await acquireDistributedLock(name, leaseDuration, { failOpen })
  if (!acquired) return { ran: false }

  let leaseLost = false
  const heartbeatMs = Math.max(5_000, Math.floor(leaseDuration / 3))
  const heartbeat = setInterval(() => {
    renewDistributedLock(lock).then((renewed) => {
      if (!renewed) {
        leaseLost = true
        logger.error(`[CronLock] Se perdió el lease "${name}"; el trabajo actual no debe iniciar nuevos efectos externos.`)
      }
    }).catch((error) => {
      leaseLost = true
      logger.error(`[CronLock] Error renovando "${name}": ${error.message}`)
    })
  }, heartbeatMs)
  heartbeat.unref?.()

  try {
    const result = await fn({ isLeaseValid: () => !leaseLost })
    return { ran: true, result, leaseLost }
  } finally {
    clearInterval(heartbeat)
    await releaseDistributedLock(lock)
  }
}
