import { processDueMercadoPagoPaymentPlanCharges } from '../services/mercadoPagoPaymentService.js'
import { logger } from '../utils/logger.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'
import { withCronLock } from '../utils/cronLock.js'

// Mercado Pago no cobra tarjetas guardadas off-session aquí; genera links vencidos.
const MERCADOPAGO_PAYMENT_PLANS_INTERVAL_MS = 30 * 60 * 1000

let started = false
let running = false
let intervalId = null

async function runMercadoPagoPaymentPlans(source = 'interval') {
  if (running || isDeployShutdownStarted()) return
  running = true

  try {
    await trackDeployDrainWork('cron:mercadopago-payment-plans', async () => {
      // (PAY2-010 / CRON-009) Lock distribuido: una sola instancia genera links por tick.
      // El servicio ya es idempotente a nivel DB (solo toma parcialidades con
      // mercadopago_preference_id vacío y marca 'sent' al generar), pero el lock evita la
      // carrera SELECT->UPDATE entre réplicas que generaría preferencias MP duplicadas.
      const { ran } = await withCronLock('mercadopago-payment-plans', MERCADOPAGO_PAYMENT_PLANS_INTERVAL_MS, async () => {
        const results = await processDueMercadoPagoPaymentPlanCharges()
        const generated = results.filter((result) => result.generated).length
        const failed = results.filter((result) => result.error).length

        if (generated || failed) {
          logger.info(`[Mercado Pago Planes] ${source}: ${generated} links generados, ${failed} con error`)
        }
      })
      if (!ran) logger.info(`[Mercado Pago Planes] ${source}: omitido (otra instancia tiene el lock)`)
    }, source)
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
  intervalId = setInterval(() => {
    runMercadoPagoPaymentPlans().catch((error) => {
      logger.error(`[Mercado Pago Planes] Error no manejado: ${error.message}`)
    })
  }, MERCADOPAGO_PAYMENT_PLANS_INTERVAL_MS)

  runMercadoPagoPaymentPlans('startup').catch((error) => {
    logger.error(`[Mercado Pago Planes] Error inicial: ${error.message}`)
  })
}

export function stopMercadoPagoPaymentPlansCron() {
  if (intervalId) clearInterval(intervalId)
  intervalId = null
  started = false
}
