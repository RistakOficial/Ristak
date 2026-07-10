import { processDuePaymentAutomations } from '../services/paymentAutomationsService.js'
import { logger } from '../utils/logger.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'
import { withCronLock } from '../utils/cronLock.js'
import { canRunBackgroundJob } from '../services/licenseService.js'

const PAYMENT_AUTOMATIONS_INTERVAL_MS = 30 * 60 * 1000
const PAYMENT_AUTOMATIONS_LOCK_TTL_MS = 10 * 60 * 1000

let started = false
let running = false

async function runPaymentAutomations(source = 'interval') {
  if (running || isDeployShutdownStarted()) return
  if (!(await canRunBackgroundJob('payment_automations'))) return
  running = true

  try {
    await trackDeployDrainWork('cron:payment-automations', async () => {
      const { ran } = await withCronLock('payment-automations', PAYMENT_AUTOMATIONS_LOCK_TTL_MS, async () => {
        const results = await processDuePaymentAutomations()
        const sent = results.filter((result) => result.sent).length
        const failed = results.filter((result) => result.error).length

        if (sent || failed) {
          logger.info(`[Pagos] ${source}: ${sent} automatizaciones enviadas, ${failed} con error`)
        }
      })
      if (!ran) logger.info(`[Pagos] ${source}: omitido (otra instancia tiene el lock de automatizaciones)`)
    }, source)
  } catch (error) {
    logger.error(`[Pagos] Error revisando automatizaciones: ${error.message}`)
  } finally {
    running = false
  }
}

export function startPaymentAutomationsCron() {
  if (started) return
  started = true

  logger.info('Iniciando cola de automatizaciones de pago')
  setInterval(() => {
    runPaymentAutomations().catch((error) => {
      logger.error(`[Pagos] Error no manejado en automatizaciones: ${error.message}`)
    })
  }, PAYMENT_AUTOMATIONS_INTERVAL_MS)

  runPaymentAutomations('startup').catch((error) => {
    logger.error(`[Pagos] Error inicial en automatizaciones: ${error.message}`)
  })
}
