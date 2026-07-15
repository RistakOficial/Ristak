import { db } from '../config/database.js'
import { scheduleBackfillJob } from './backfillJobCoordinator.js'

const GLOBAL_PROJECTION_BACKFILL_LOCK = 'projection-backfill-global-io'
const MIN_RETRY_MS = 100
const MAX_RETRY_MS = 1_000

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))

/**
 * El coordinador limita este proceso. Este lease agrega el fence entre procesos
 * durante rolling deploys o instalaciones que ejecutan mas de una instancia.
 * `pinConnection: false` permite que cada worker conserve su propio advisory
 * lock y sus transacciones sin intentar anidarlos en la sesion del fence global.
 */
export async function runWithProjectionBackfillIoLease(run, {
  database = db,
  sleepFn = sleep,
  minRetryMs = MIN_RETRY_MS,
  maxRetryMs = MAX_RETRY_MS
} = {}) {
  if (typeof run !== 'function') throw new TypeError('Projection backfill run function is required')
  if (typeof database?.withAdvisoryLock !== 'function') return run()

  let retryMs = Math.max(1, Number(minRetryMs) || MIN_RETRY_MS)
  const retryCeiling = Math.max(retryMs, Number(maxRetryMs) || MAX_RETRY_MS)

  while (true) {
    let callbackStarted = false
    try {
      return await database.withAdvisoryLock(
        GLOBAL_PROJECTION_BACKFILL_LOCK,
        async () => {
          callbackStarted = true
          return run()
        },
        { pinConnection: false }
      )
    } catch (error) {
      // Reintentar despues de empezar el worker podria repetir escrituras. Los
      // workers ya manejan sus propios locks/errores; aqui solo esperamos por
      // el fence global cuando el callback todavia no comenzo.
      if (error?.code !== 'DATABASE_ADVISORY_LOCK_BUSY' || callbackStarted) throw error
      await sleepFn(retryMs)
      retryMs = Math.min(retryCeiling, Math.ceil(retryMs * 1.7))
    }
  }
}

export function scheduleProjectionBackfillJob(job = {}) {
  const run = job?.run
  if (typeof run !== 'function') throw new TypeError('Projection backfill job requires a run function')
  return scheduleBackfillJob({
    ...job,
    run: () => runWithProjectionBackfillIoLease(run)
  })
}
