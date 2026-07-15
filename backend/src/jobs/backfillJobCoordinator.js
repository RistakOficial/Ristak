import { logger as defaultLogger } from '../utils/logger.js'

export const BACKFILL_JOB_PRIORITY = Object.freeze({
  CRITICAL: 50,
  HIGH: 40,
  NORMAL: 30,
  LOW: 20,
  MAINTENANCE: 10
})

const DEFAULT_MAX_CONCURRENCY = 1
const DEFAULT_YIELD_MS = 25
const DEFAULT_AGING_INTERVAL_MS = 250

function normalizeInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

/**
 * Cola local de backfills pesados.
 *
 * - Limita I/O por proceso sin formar parte de readiness.
 * - Deduplica una misma proyeccion mientras esta en cola o ejecutandose.
 * - Respeta prioridad, pero envejece trabajos para que una prioridad baja no
 *   quede hambrienta si siguen llegando trabajos urgentes.
 * - Aisla rechazos: un backfill fallido nunca detiene los siguientes.
 */
export function createBackfillJobCoordinator({
  maxConcurrency = DEFAULT_MAX_CONCURRENCY,
  yieldMs = DEFAULT_YIELD_MS,
  agingIntervalMs = DEFAULT_AGING_INTERVAL_MS,
  logger = defaultLogger
} = {}) {
  const concurrency = normalizeInteger(maxConcurrency, DEFAULT_MAX_CONCURRENCY, { min: 1, max: 8 })
  const defaultYieldMs = normalizeInteger(yieldMs, DEFAULT_YIELD_MS, { min: 0, max: 10_000 })
  const agingMs = normalizeInteger(agingIntervalMs, DEFAULT_AGING_INTERVAL_MS, { min: 1, max: 60_000 })
  const jobs = new Map()
  const idleWaiters = new Set()
  let sequence = 0
  let activeCount = 0
  let drainTimer = null

  function effectivePriority(job, now = Date.now()) {
    const ageBoost = Math.floor(Math.max(0, now - job.enqueuedAt) / agingMs)
    return job.priority + ageBoost
  }

  function nextQueuedJob() {
    const now = Date.now()
    return [...jobs.values()]
      .filter(job => job.state === 'queued')
      .sort((left, right) => (
        effectivePriority(right, now) - effectivePriority(left, now)
        || left.sequence - right.sequence
      ))[0] || null
  }

  function resolveIdleWaitersIfNeeded() {
    if (activeCount !== 0 || jobs.size !== 0 || drainTimer) return
    for (const resolve of idleWaiters) resolve()
    idleWaiters.clear()
  }

  function requestDrain(delayMs = 0) {
    if (drainTimer || activeCount >= concurrency || !nextQueuedJob()) {
      resolveIdleWaitersIfNeeded()
      return
    }
    drainTimer = setTimeout(() => {
      drainTimer = null
      drain()
    }, Math.max(0, delayMs))
  }

  function completeJob(job) {
    jobs.delete(job.key)
    activeCount = Math.max(0, activeCount - 1)
    requestDrain(job.yieldMs)
    resolveIdleWaitersIfNeeded()
  }

  function runJob(job) {
    job.state = 'running'
    job.startedAt = Date.now()
    activeCount += 1

    Promise.resolve()
      .then(() => job.run())
      .catch(error => {
        try {
          job.onError?.(error)
        } catch (handlerError) {
          logger?.warn?.(`[Backfill] El manejador de error de ${job.key} fallo: ${handlerError.message}`)
        }
        logger?.warn?.(`[Backfill] ${job.key} fallo de forma aislada: ${error?.message || error}`)
      })
      .finally(() => completeJob(job))
  }

  function drain() {
    while (activeCount < concurrency) {
      const job = nextQueuedJob()
      if (!job) break
      runJob(job)
    }
    resolveIdleWaitersIfNeeded()
  }

  function schedule({ key, run, priority = BACKFILL_JOB_PRIORITY.NORMAL, yieldMs: jobYieldMs, onError } = {}) {
    const normalizedKey = String(key || '').trim()
    if (!normalizedKey) throw new TypeError('Backfill job key is required')
    if (typeof run !== 'function') throw new TypeError(`Backfill job ${normalizedKey} requires a run function`)

    const existing = jobs.get(normalizedKey)
    if (existing) {
      return { scheduled: false, key: normalizedKey, state: existing.state }
    }

    const job = {
      key: normalizedKey,
      run,
      onError,
      priority: normalizeInteger(priority, BACKFILL_JOB_PRIORITY.NORMAL, { min: -1_000, max: 1_000 }),
      yieldMs: normalizeInteger(jobYieldMs, defaultYieldMs, { min: 0, max: 10_000 }),
      enqueuedAt: Date.now(),
      sequence: sequence += 1,
      state: 'queued',
      startedAt: null
    }
    jobs.set(normalizedKey, job)
    requestDrain()
    return { scheduled: true, key: normalizedKey, state: 'queued' }
  }

  function snapshot() {
    return {
      maxConcurrency: concurrency,
      activeCount,
      jobs: [...jobs.values()]
        .sort((left, right) => left.sequence - right.sequence)
        .map(job => ({
          key: job.key,
          priority: job.priority,
          state: job.state,
          enqueuedAt: job.enqueuedAt,
          startedAt: job.startedAt
        }))
    }
  }

  function whenIdle() {
    if (activeCount === 0 && jobs.size === 0 && !drainTimer) return Promise.resolve()
    return new Promise(resolve => idleWaiters.add(resolve))
  }

  return Object.freeze({ schedule, snapshot, whenIdle })
}

const globalBackfillJobCoordinator = createBackfillJobCoordinator()

export function scheduleBackfillJob(job) {
  return globalBackfillJobCoordinator.schedule(job)
}

export function getBackfillJobCoordinatorSnapshot() {
  return globalBackfillJobCoordinator.snapshot()
}

export function waitForBackfillJobsToBecomeIdle() {
  return globalBackfillJobCoordinator.whenIdle()
}
