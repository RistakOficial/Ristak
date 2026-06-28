import { processDueStripePaymentPlanCharges } from '../services/stripePaymentService.js'
import { logger } from '../utils/logger.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'
import { withCronLock } from '../utils/cronLock.js'

// Revisa cada minuto para pruebas y planes con hora exacta. La idempotencia/lock evita doble cargo.
const STRIPE_PAYMENT_PLANS_INTERVAL_MS = 60 * 1000

let started = false
let running = false

async function runStripePaymentPlans(source = 'interval') {
  if (running || isDeployShutdownStarted()) return
  running = true

  try {
    await trackDeployDrainWork('cron:stripe-payment-plans', async () => {
      // (CRON-009 / PAY-008 / CRON-002) Lock distribuido: si hay varias instancias, solo una
      // cobra parcialidades en este tick (defensivo; con 1 instancia es inofensivo). El reclamo
      // no era atómico (CRON-002) y el cron no tenía lock (PAY-008); ahora la idempotencia de
      // Stripe (llave por bucket diario) protege contra doble cargo y el lock evita trabajo
      // y efectos duplicados entre réplicas.
      const { ran } = await withCronLock('stripe-payment-plans', STRIPE_PAYMENT_PLANS_INTERVAL_MS, async () => {
        const results = await processDueStripePaymentPlanCharges()
        const charged = results.filter((result) => result.charged).length
        const failed = results.filter((result) => result.error).length

        if (charged || failed) {
          logger.info(`[Stripe Planes] ${source}: ${charged} cobrados, ${failed} con error`)
        }
      })
      if (!ran) logger.info(`[Stripe Planes] ${source}: omitido (otra instancia tiene el lock)`)
    }, source)
  } catch (error) {
    const message = String(error?.message || '')
    if (!/Stripe no está configurado/i.test(message)) {
      logger.error(`[Stripe Planes] Error revisando cobros programados: ${message}`)
    }
  } finally {
    running = false
  }
}

export function startStripePaymentPlansCron() {
  if (started) return
  started = true

  logger.info('Iniciando cola de planes de pago Stripe')
  setInterval(() => {
    runStripePaymentPlans().catch((error) => {
      logger.error(`[Stripe Planes] Error no manejado: ${error.message}`)
    })
  }, STRIPE_PAYMENT_PLANS_INTERVAL_MS)

  runStripePaymentPlans('startup').catch((error) => {
    logger.error(`[Stripe Planes] Error inicial: ${error.message}`)
  })
}
