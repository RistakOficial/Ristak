import { processDueRebillPaymentPlanCharges } from '../services/rebillPaymentService.js'
import { logger } from '../utils/logger.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'
import { withCronLock } from '../utils/cronLock.js'

const REBILL_PAYMENT_PLANS_INTERVAL_MS = 60 * 1000

let started = false
let running = false
let intervalId = null

async function runRebillPaymentPlans(source = 'interval') {
  if (running || isDeployShutdownStarted()) return
  running = true

  try {
    await trackDeployDrainWork('cron:rebill-payment-plans', async () => {
      const { ran } = await withCronLock('rebill-payment-plans', REBILL_PAYMENT_PLANS_INTERVAL_MS, async () => {
        const results = await processDueRebillPaymentPlanCharges()
        const generated = results.filter((result) => result.generated).length
        const failed = results.filter((result) => result.error).length

        if (generated || failed) {
          logger.info(`[Rebill Planes] ${source}: ${generated} links liberados, ${failed} con error`)
        }
      })
      if (!ran) logger.info(`[Rebill Planes] ${source}: omitido (otra instancia tiene el lock)`)
    }, source)
  } catch (error) {
    const message = String(error?.message || '')
    if (!/Rebill no está configurado/i.test(message)) {
      logger.error(`[Rebill Planes] Error revisando parcialidades: ${message}`)
    }
  } finally {
    running = false
  }
}

export function startRebillPaymentPlansCron() {
  if (started) return
  started = true

  logger.info('Iniciando cola de planes de pago Rebill')
  intervalId = setInterval(() => {
    runRebillPaymentPlans().catch((error) => {
      logger.error(`[Rebill Planes] Error no manejado: ${error.message}`)
    })
  }, REBILL_PAYMENT_PLANS_INTERVAL_MS)

  runRebillPaymentPlans('startup').catch((error) => {
    logger.error(`[Rebill Planes] Error inicial: ${error.message}`)
  })
}

export function stopRebillPaymentPlansCron() {
  if (intervalId) clearInterval(intervalId)
  intervalId = null
  started = false
}
