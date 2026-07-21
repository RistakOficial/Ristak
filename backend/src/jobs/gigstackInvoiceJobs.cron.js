import { processDueGigstackInvoiceJobs } from '../services/gigstackInvoiceService.js'
import { canRunBackgroundJob } from '../services/licenseService.js'
import { logger } from '../utils/logger.js'
import { withCronLock } from '../utils/cronLock.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'

const INTERVAL_MS = 60 * 1000
const LOCK_TTL_MS = 55 * 1000
let intervalId = null
let running = false

export async function runGigstackInvoiceJobs(source = 'interval') {
  if (running || isDeployShutdownStarted()) return { skipped: true }
  if (!(await canRunBackgroundJob('payments'))) return { skipped: true, reason: 'license' }
  running = true
  try {
    return await trackDeployDrainWork('cron:gigstack-invoice-jobs', async () => {
      const lock = await withCronLock(
        'gigstack-invoice-jobs',
        LOCK_TTL_MS,
        () => processDueGigstackInvoiceJobs(),
        { failOpen: false, leaseTtlMs: LOCK_TTL_MS }
      )
      if (!lock.ran) return { skipped: true, reason: 'locked' }
      const results = lock.result || []
      const registered = results.filter((result) => result.registered).length
      const retrying = results.filter((result) => result.error && result.retryable).length
      const blocked = results.filter((result) => result.error && !result.retryable).length
      if (registered || retrying || blocked) {
        logger.info(`[Gigstack] ${source}: ${registered} registrados, ${retrying} en reintento, ${blocked} bloqueados.`)
      }
      return { registered, retrying, blocked }
    }, source)
  } finally {
    running = false
  }
}

export function startGigstackInvoiceJobsCron() {
  if (intervalId) return
  intervalId = setInterval(() => {
    runGigstackInvoiceJobs().catch((error) => {
      logger.error(`[Gigstack] Error procesando cola fiscal: ${error.message}`)
    })
  }, INTERVAL_MS)
  intervalId.unref?.()
  runGigstackInvoiceJobs('startup').catch((error) => {
    logger.error(`[Gigstack] Error inicial procesando cola fiscal: ${error.message}`)
  })
}

export function stopGigstackInvoiceJobsCron() {
  if (intervalId) clearInterval(intervalId)
  intervalId = null
}
