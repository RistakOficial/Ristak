import { processDueConektaPaymentPlanCharges } from '../services/conektaPaymentService.js'
import { logger } from '../utils/logger.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'
import { withCronLock } from '../utils/cronLock.js'
import { canRunBackgroundJob } from '../services/licenseService.js'

// Revisa cada minuto para pruebas y planes con hora exacta. La idempotencia/lock evita doble cargo.
const CONEKTA_PAYMENT_PLANS_INTERVAL_MS = 60 * 1000

let started = false
let running = false
let intervalId = null

async function runConektaPaymentPlans(source = 'interval') {
  if (running || isDeployShutdownStarted()) return
  if (!(await canRunBackgroundJob('payments')) || !(await canRunBackgroundJob('payment_plans'))) return
  running = true

  try {
    await trackDeployDrainWork('cron:conekta-payment-plans', async () => {
      // (CRON-009 / CRON-002) Lock distribuido: una sola instancia cobra parcialidades por tick.
      // Cierra el reclamo no atómico de cobros Conekta (CRON-002) entre réplicas.
      const { ran } = await withCronLock('conekta-payment-plans', CONEKTA_PAYMENT_PLANS_INTERVAL_MS, async ({ isLeaseValid }) => {
        const result = await processDueConektaPaymentPlanCharges({ isLeaseValid })
        if (result.succeeded || result.failed) {
          logger.info(`[Conekta Planes] ${source}: ${result.succeeded} cobrados, ${result.failed} con error`)
        }
      }, { failOpen: false, leaseTtlMs: 5 * 60 * 1000 })
      if (!ran) logger.info(`[Conekta Planes] ${source}: omitido (otra instancia tiene el lock)`)
    }, source)
  } catch (error) {
    const message = String(error?.message || '')
    if (!/Conekta no está configurado/i.test(message)) {
      logger.error(`[Conekta Planes] Error revisando cobros programados: ${message}`)
    }
  } finally {
    running = false
  }
}

export function startConektaPaymentPlansCron() {
  if (started) return
  started = true

  logger.info('Iniciando cola de planes de pago Conekta')
  intervalId = setInterval(() => {
    runConektaPaymentPlans().catch((error) => {
      logger.error(`[Conekta Planes] Error no manejado: ${error.message}`)
    })
  }, CONEKTA_PAYMENT_PLANS_INTERVAL_MS)

  runConektaPaymentPlans('startup').catch((error) => {
    logger.error(`[Conekta Planes] Error inicial: ${error.message}`)
  })
}

export function stopConektaPaymentPlansCron() {
  if (intervalId) clearInterval(intervalId)
  intervalId = null
  started = false
}
