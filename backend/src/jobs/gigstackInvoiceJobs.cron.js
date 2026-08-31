import {
  processDueGigstackInvoiceDeliveryJobs,
  processDueGigstackInvoiceJobs
} from '../services/gigstackInvoiceService.js'
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
        async () => ({
          invoiceResults: await processDueGigstackInvoiceJobs(),
          deliveryResults: await processDueGigstackInvoiceDeliveryJobs()
        }),
        { failOpen: false, leaseTtlMs: LOCK_TTL_MS }
      )
      if (!lock.ran) return { skipped: true, reason: 'locked' }
      const invoiceResults = lock.result?.invoiceResults || []
      const deliveryResults = lock.result?.deliveryResults || []
      const registered = invoiceResults.filter((result) => result.registered).length
      const invoiceRetrying = invoiceResults.filter((result) => result.error && result.retryable).length
      const invoiceBlocked = invoiceResults.filter((result) => result.error && !result.retryable).length
      const delivered = deliveryResults.filter((result) => result.sent).length
      const deliveryRetrying = deliveryResults.filter((result) => result.error && result.retryable).length
      const deliveryBlocked = deliveryResults.filter((result) => result.error && !result.retryable).length
      if (registered || invoiceRetrying || invoiceBlocked || delivered || deliveryRetrying || deliveryBlocked) {
        logger.info(`[Gigstack] ${source}: ${registered} registrados, ${delivered} documentos enviados, ${invoiceRetrying + deliveryRetrying} en reintento, ${invoiceBlocked + deliveryBlocked} bloqueados.`)
      }
      return {
        registered,
        delivered,
        retrying: invoiceRetrying + deliveryRetrying,
        blocked: invoiceBlocked + deliveryBlocked
      }
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
