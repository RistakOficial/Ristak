import cron from 'node-cron'
import { syncHighLevelPaymentPlanMirrors } from '../services/highlevelPaymentPlanMirrorService.js'
import { canRunBackgroundJob } from '../services/licenseService.js'
import { withCronLock } from '../utils/cronLock.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'
import { logger } from '../utils/logger.js'

export const HIGHLEVEL_PAYMENT_PLAN_MIRROR_CRON_EXPRESSION = '3,13,23,33,43,53 * * * *'
const HIGHLEVEL_PAYMENT_PLAN_MIRROR_LOCK_TTL_MS = 12 * 60 * 1000

let mirrorTask = null
let initialTimer = null
let mirrorRunning = false
let mirrorEnabled = false

export function getHighLevelPaymentPlanMirrorCronState() {
  return {
    active: Boolean(mirrorTask),
    running: mirrorRunning,
    initialScheduled: Boolean(initialTimer)
  }
}

export async function runHighLevelPaymentPlanMirrorTick(options = {}) {
  if (!mirrorEnabled || isDeployShutdownStarted()) return { ran: false, reason: 'stopped' }
  if (mirrorRunning) return { ran: false, reason: 'already-running' }

  mirrorRunning = true
  try {
    const canRun = options.canRun || canRunBackgroundJob
    if (!(await canRun('integrations'))) return { ran: false, reason: 'license' }

    const lock = options.withLock || withCronLock
    const sync = options.sync || syncHighLevelPaymentPlanMirrors
    return await trackDeployDrainWork('cron:highlevel-payment-plan-mirror', async () => {
      const execution = await lock(
        'highlevel-payment-plan-mirror',
        HIGHLEVEL_PAYMENT_PLAN_MIRROR_LOCK_TTL_MS,
        async ({ isLeaseValid } = {}) => sync({
          shouldContinue: () => mirrorEnabled && (typeof isLeaseValid !== 'function' || isLeaseValid())
        }),
        { failOpen: false }
      )

      if (!execution.ran) {
        logger.info('[GHL planes] Materialización omitida: otra instancia tiene el lock')
      } else if (execution.result) {
        const result = execution.result
        logger.info(
          `[GHL planes] Espejo actualizado: ${result.saved}/${result.fetched} schedules, ` +
          `${result.pages} página(s), siguiente offset ${result.nextOffset}`
        )
      }
      return execution
    })
  } finally {
    mirrorRunning = false
  }
}

export function startHighLevelPaymentPlanMirrorCron(options = {}) {
  if (mirrorTask) return true

  mirrorEnabled = true
  const schedule = options.schedule || cron.schedule.bind(cron)
  const run = options.run || runHighLevelPaymentPlanMirrorTick
  mirrorTask = schedule(HIGHLEVEL_PAYMENT_PLAN_MIRROR_CRON_EXPRESSION, async () => {
    if (!mirrorEnabled) return
    try {
      await run()
    } catch (error) {
      logger.warn(`[GHL planes] No se pudo actualizar el espejo local: ${error.message}`)
    }
  })

  if (options.runOnStart !== false) {
    const delay = Math.max(Number(options.initialDelayMs ?? 5_000), 0)
    initialTimer = setTimeout(() => {
      initialTimer = null
      if (!mirrorEnabled) return
      Promise.resolve(run()).catch(error => {
        logger.warn(`[GHL planes] Falló la materialización inicial: ${error.message}`)
      })
    }, delay)
    initialTimer.unref?.()
  }

  return true
}

export function stopHighLevelPaymentPlanMirrorCron() {
  mirrorEnabled = false
  if (initialTimer) clearTimeout(initialTimer)
  initialTimer = null
  mirrorTask?.stop?.()
  mirrorTask?.destroy?.()
  mirrorTask = null
}
