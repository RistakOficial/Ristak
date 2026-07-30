import {
  recoverPendingToolCallingV2VerifiedTerminalHandoffs
} from '../services/conversationalAgentService.js'
import { logger as defaultLogger } from '../utils/logger.js'
import { withCronLock as defaultWithCronLock } from '../utils/cronLock.js'
import {
  isDeployShutdownStarted,
  trackDeployDrainWork
} from '../utils/deployDrainTracker.js'

const DEFAULT_INTERVAL_MS = 60 * 1000
const DEFAULT_LOCK_TTL_MS = 55 * 1000
const DEFAULT_BATCH_LIMIT = 4
const DEFAULT_RUN_BUDGET_MS = 15 * 1000
const DEFAULT_RETRY_WAKE_MS = 5 * 1000
const DEFAULT_MAX_PAGES_PER_RUN = 8

function positiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(max, Math.max(1, Math.trunc(parsed)))
}

function normalizeCursor(value) {
  const createdAt = String(value?.createdAt || '').trim()
  const id = String(value?.id || '').trim()
  if (!createdAt || !id || !Number.isFinite(Date.parse(createdAt))) return null
  return { createdAt, id }
}

function mergeRecoveryTotals(target, page = {}) {
  for (const key of [
    'scanned',
    'recovered',
    'materialized',
    'processing',
    'failed'
  ]) {
    target[key] += Math.max(0, Number(page?.[key]) || 0)
  }
  if (Array.isArray(page?.errors)) {
    target.errors.push(...page.errors.slice(0, Math.max(0, 100 - target.errors.length)))
  }
}

/**
 * Worker de sistema independiente para obligaciones terminales.
 *
 * El cursor avanza aunque una fila falle, así un caso roto no entierra al
 * resto. Cada ejecución tiene lote y presupuesto acotados; si todavía hay
 * cola, se despierta sola sin esperar al watchdog de un minuto.
 */
export function createConversationalVerifiedTerminalHandoffScheduler({
  recover = recoverPendingToolCallingV2VerifiedTerminalHandoffs,
  withLock = defaultWithCronLock,
  trackWork = trackDeployDrainWork,
  shuttingDown = isDeployShutdownStarted,
  logger = defaultLogger,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  intervalMs = DEFAULT_INTERVAL_MS,
  lockTtlMs = DEFAULT_LOCK_TTL_MS,
  batchLimit = DEFAULT_BATCH_LIMIT,
  runBudgetMs = DEFAULT_RUN_BUDGET_MS,
  retryWakeMs = DEFAULT_RETRY_WAKE_MS,
  maxPagesPerRun = DEFAULT_MAX_PAGES_PER_RUN
} = {}) {
  const safeIntervalMs = positiveInteger(intervalMs, DEFAULT_INTERVAL_MS)
  const safeLockTtlMs = positiveInteger(lockTtlMs, DEFAULT_LOCK_TTL_MS)
  const safeBatchLimit = positiveInteger(batchLimit, DEFAULT_BATCH_LIMIT, 100)
  const safeRunBudgetMs = positiveInteger(runBudgetMs, DEFAULT_RUN_BUDGET_MS)
  const safeRetryWakeMs = positiveInteger(retryWakeMs, DEFAULT_RETRY_WAKE_MS)
  const safeMaxPagesPerRun = positiveInteger(
    maxPagesPerRun,
    DEFAULT_MAX_PAGES_PER_RUN,
    100
  )

  let intervalId = null
  let wakeTimerId = null
  let running = false
  let cursor = null

  const reportFailure = (error) => {
    logger.error(
      `[Agente conversacional] Error recuperando obligaciones terminales: ${
        error?.message || error
      }`
    )
  }

  const scheduleWake = (delayMs = 0) => {
    if (wakeTimerId || shuttingDown()) return false
    wakeTimerId = setTimeoutFn(() => {
      wakeTimerId = null
      tick('wake').catch(reportFailure)
    }, Math.max(0, Number(delayMs) || 0))
    wakeTimerId?.unref?.()
    return true
  }

  async function tick(source = 'manual') {
    if (running || shuttingDown()) return { skipped: true }
    running = true
    let wakeAfterRunMs = null
    try {
      return await trackWork(
        'cron:conversational-verified-terminal-handoffs',
        async () => {
          const locked = await withLock(
            'conversational-verified-terminal-handoffs',
            safeLockTtlMs,
            async ({ isLeaseValid = () => true } = {}) => {
              const deadline = now() + safeRunBudgetMs
              const totals = {
                scanned: 0,
                recovered: 0,
                materialized: 0,
                processing: 0,
                failed: 0,
                errors: [],
                pages: 0,
                hasMore: false
              }

              while (!shuttingDown() && isLeaseValid()) {
                const page = await recover({
                  limit: safeBatchLimit,
                  afterCursor: cursor
                })
                totals.pages += 1
                mergeRecoveryTotals(totals, page)

                const nextCursor = normalizeCursor(page?.nextCursor)
                if (nextCursor) cursor = nextCursor

                // Compatibilidad defensiva: mientras una instalación actualiza
                // el servicio, un lote lleno también significa "puede haber más".
                totals.hasMore = page?.hasMore === true ||
                  Math.max(0, Number(page?.scanned) || 0) >= safeBatchLimit

                if (!totals.hasMore) {
                  // Terminó una vuelta completa. El próximo tick vuelve al
                  // principio y reintenta fallos sin encerrar al resto detrás.
                  cursor = null
                  break
                }
                if (
                  !nextCursor ||
                  now() >= deadline ||
                  totals.pages >= safeMaxPagesPerRun
                ) break
              }

              if (totals.hasMore && !shuttingDown()) wakeAfterRunMs = 0
              if (totals.recovered || totals.materialized) {
                logger.info(
                  `[Agente conversacional] Obligaciones terminales: ${
                    totals.materialized
                  } materializadas, ${totals.recovered} resueltas.`
                )
              }
              for (const failure of totals.errors) {
                logger.warn(
                  `[Agente conversacional] Obligación terminal ${
                    failure?.pendingEventId ||
                    failure?.intentEventId ||
                    failure?.eventId ||
                    'desconocida'
                  } sigue pendiente (${failure?.code || 'unknown'}): ${
                    failure?.message || 'sin detalle'
                  }`
                )
              }
              return totals
            },
            { failOpen: false }
          )
          return locked.result || {
            skipped: true,
            reason: locked.ran ? 'empty' : 'locked'
          }
        },
        source
      )
    } catch (error) {
      wakeAfterRunMs = safeRetryWakeMs
      throw error
    } finally {
      running = false
      if (wakeAfterRunMs !== null) scheduleWake(wakeAfterRunMs)
    }
  }

  function start() {
    if (intervalId) return false
    intervalId = setIntervalFn(() => {
      tick('interval').catch(reportFailure)
    }, safeIntervalMs)
    intervalId?.unref?.()
    scheduleWake(0)
    return true
  }

  function stop() {
    if (intervalId) clearIntervalFn(intervalId)
    if (wakeTimerId) clearTimeoutFn(wakeTimerId)
    const stopped = Boolean(intervalId || wakeTimerId)
    intervalId = null
    wakeTimerId = null
    return stopped
  }

  return {
    tick,
    wake: scheduleWake,
    start,
    stop,
    getState: () => ({
      running,
      started: Boolean(intervalId),
      wakeScheduled: Boolean(wakeTimerId),
      cursor
    })
  }
}

const scheduler = createConversationalVerifiedTerminalHandoffScheduler()

export function runConversationalVerifiedTerminalHandoffRecovery(source = 'manual') {
  return scheduler.tick(source)
}

export function wakeConversationalVerifiedTerminalHandoffRecovery(delayMs = 0) {
  return scheduler.wake(delayMs)
}

export function startConversationalVerifiedTerminalHandoffRecovery() {
  return scheduler.start()
}

export function stopConversationalVerifiedTerminalHandoffRecovery() {
  return scheduler.stop()
}
