import {
  cleanupAbandonedAutomationReviewRuns,
  readAutomationReviewProjectionState,
  scheduleAutomationReviewProjectionBackfill
} from '../services/automationReferenceResolver.js'
import { logger as defaultLogger } from '../utils/logger.js'
import { isDeployShutdownStarted } from '../utils/deployDrainTracker.js'

const DEFAULT_INTERVAL_MS = 1_000
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000

/**
 * Scheduler local de sistema. Su tick hace una sola lectura por PK y delega el
 * trabajo pesado a la cola/fence de proyecciones; nunca reconstruye dentro del
 * timer ni necesita que un GET de Header actúe como comando oculto.
 */
export function createAutomationReviewProjectionScheduler({
  intervalMs = DEFAULT_INTERVAL_MS,
  cleanupIntervalMs = DEFAULT_CLEANUP_INTERVAL_MS,
  readState = readAutomationReviewProjectionState,
  scheduleWorker = scheduleAutomationReviewProjectionBackfill,
  cleanupRuns = cleanupAbandonedAutomationReviewRuns,
  shuttingDown = isDeployShutdownStarted,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = defaultLogger
} = {}) {
  let intervalId = null
  let running = false
  let nextCleanupAt = 0

  async function tick() {
    if (running || shuttingDown()) return { scheduled: false, skipped: true }
    running = true
    try {
      const state = await readState()
      if (!state) return { scheduled: false, skipped: true, reason: 'state_unavailable' }

      const sourceRevision = Number(state.source_revision || 0)
      const projectedRevision = Number(state.projected_revision || 0)
      const pending = state.status === 'pending' || projectedRevision !== sourceRevision
      const queued = pending ? scheduleWorker() : null
      let cleaned = 0
      const currentTime = Number(now())
      if (currentTime >= nextCleanupAt) {
        nextCleanupAt = currentTime + Math.max(60_000, Number(cleanupIntervalMs) || DEFAULT_CLEANUP_INTERVAL_MS)
        try {
          cleaned = await cleanupRuns()
        } catch (error) {
          logger.warn(`[Automatizaciones] No se pudo limpiar staging abandonado: ${error.message}`)
        }
      }

      return pending
        ? {
            scheduled: Boolean(queued?.scheduled),
            pending: true,
            sourceRevision,
            queueState: queued?.state || null,
            cleaned
          }
        : { scheduled: false, pending: false, sourceRevision, cleaned }
    } finally {
      running = false
    }
  }

  function reportFailure(error) {
    logger.warn(`[Automatizaciones] No se pudo revisar el estado de la proyección: ${error.message}`)
  }

  function start() {
    if (intervalId) return false
    intervalId = setIntervalFn(() => {
      tick().catch(reportFailure)
    }, Math.max(100, Number(intervalMs) || DEFAULT_INTERVAL_MS))
    intervalId?.unref?.()
    tick().catch(reportFailure)
    return true
  }

  function stop() {
    if (!intervalId) return false
    clearIntervalFn(intervalId)
    intervalId = null
    return true
  }

  return Object.freeze({ tick, start, stop })
}

const automationReviewProjectionScheduler = createAutomationReviewProjectionScheduler()

export function runAutomationReviewProjectionSchedulerTick() {
  return automationReviewProjectionScheduler.tick()
}

export function startAutomationReviewProjectionScheduler() {
  return automationReviewProjectionScheduler.start()
}

export function stopAutomationReviewProjectionScheduler() {
  return automationReviewProjectionScheduler.stop()
}
