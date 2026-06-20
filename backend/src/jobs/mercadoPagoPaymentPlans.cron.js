import { processDueMercadoPagoPaymentPlanCharges } from '../services/mercadoPagoPaymentService.js'
import { logger } from '../utils/logger.js'

// Mercado Pago no cobra tarjetas guardadas off-session aquí; genera links vencidos.
const MERCADOPAGO_PAYMENT_PLANS_INTERVAL_MS = 30 * 60 * 1000

let started = false
let running = false

async function runMercadoPagoPaymentPlans(source = 'interval') {
  if (running) return
  running = true

  try {
    const results = await processDueMercadoPagoPaymentPlanCharges()
    const generated = results.filter((result) => result.generated).length
    const failed = results.filter((result) => result.error).length

    if (generated || failed) {
      logger.info(`[Mercado Pago Planes] ${source}: ${generated} links generados, ${failed} con error`)
    }
  } catch (error) {
    const message = String(error?.message || '')
    if (!/Mercado Pago no está configurado/i.test(message)) {
      logger.error(`[Mercado Pago Planes] Error revisando parcialidades: ${message}`)
    }
  } finally {
    running = false
  }
}

export function startMercadoPagoPaymentPlansCron() {
  if (started) return
  started = true

  logger.info('Iniciando cola de planes de pago Mercado Pago')
  setInterval(() => {
    runMercadoPagoPaymentPlans().catch((error) => {
      logger.error(`[Mercado Pago Planes] Error no manejado: ${error.message}`)
    })
  }, MERCADOPAGO_PAYMENT_PLANS_INTERVAL_MS)

  runMercadoPagoPaymentPlans('startup').catch((error) => {
    logger.error(`[Mercado Pago Planes] Error inicial: ${error.message}`)
  })
}
