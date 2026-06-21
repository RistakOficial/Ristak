import { processDueConektaPaymentPlanCharges } from '../services/conektaPaymentService.js'
import { logger } from '../utils/logger.js'

// Los planes se cobran por fecha, no por segundo exacto; 30 minutos evita ruido innecesario.
const CONEKTA_PAYMENT_PLANS_INTERVAL_MS = 30 * 60 * 1000

let started = false
let running = false

async function runConektaPaymentPlans(source = 'interval') {
  if (running) return
  running = true

  try {
    const result = await processDueConektaPaymentPlanCharges()
    if (result.succeeded || result.failed) {
      logger.info(`[Conekta Planes] ${source}: ${result.succeeded} cobrados, ${result.failed} con error`)
    }
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
  setInterval(() => {
    runConektaPaymentPlans().catch((error) => {
      logger.error(`[Conekta Planes] Error no manejado: ${error.message}`)
    })
  }, CONEKTA_PAYMENT_PLANS_INTERVAL_MS)

  runConektaPaymentPlans('startup').catch((error) => {
    logger.error(`[Conekta Planes] Error inicial: ${error.message}`)
  })
}
