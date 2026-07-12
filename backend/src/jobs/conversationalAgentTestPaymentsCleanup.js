import { cleanupDueConversationalAgentTestPaymentLinks } from '../services/conversationalAgentTestPaymentService.js'
import { logger } from '../utils/logger.js'
import { withCronLock } from '../utils/cronLock.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'

const INTERVAL_MS = 60 * 1000
const LOCK_TTL_MS = 55 * 1000
let timer = null
let running = false

/**
 * Job de sistema idempotente. Se exporta para que server/registry lo conecte en
 * una integración posterior; este módulo no arranca timers por sí solo.
 */
export async function runConversationalAgentTestPaymentsCleanup(options = {}) {
  if (running || isDeployShutdownStarted()) return { skipped: true }
  running = true
  try {
    return await trackDeployDrainWork('cron:conversational-test-payment-cleanup', async () => {
      const lock = await withCronLock('conversational-test-payment-cleanup', LOCK_TTL_MS, () => (
        cleanupDueConversationalAgentTestPaymentLinks(options)
      ))
      if (!lock.ran) return { skipped: true, reason: 'locked' }
      const result = lock.result || { cleaned: 0, failed: 0 }
      if (result.failed > 0) {
        logger.warn(`[Tester agente] Limpieza de pagos: ${result.cleaned} eliminados, ${result.failed} pendientes de reintento.`)
      } else if (result.cleaned > 0) {
        logger.info(`[Tester agente] Limpieza de pagos: ${result.cleaned} enlace(s) sandbox eliminado(s).`)
      }
      return result
    })
  } finally {
    running = false
  }
}

export function startConversationalAgentTestPaymentsCleanup() {
  if (timer) return
  timer = setInterval(() => {
    runConversationalAgentTestPaymentsCleanup().catch((error) => {
      logger.error(`[Tester agente] Error limpiando pagos sandbox: ${error.message}`)
    })
  }, INTERVAL_MS)
  timer.unref?.()
  runConversationalAgentTestPaymentsCleanup({ source: 'startup' }).catch(() => undefined)
}

export function stopConversationalAgentTestPaymentsCleanup() {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

export default runConversationalAgentTestPaymentsCleanup
