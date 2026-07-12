import { retryConversationalAgentSafetyNotifications } from '../services/conversationalAgentSafetyNotificationService.js'
import { logger } from '../utils/logger.js'
import { withCronLock } from '../utils/cronLock.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'

const INTERVAL_MS = 60 * 1000
const LOCK_TTL_MS = 55 * 1000
let started = false
let running = false

export async function runConversationalAgentSafetyNotifications(source = 'interval') {
  if (running || isDeployShutdownStarted()) return { skipped: true }
  running = true
  try {
    return await trackDeployDrainWork('cron:conversational-safety-notifications', async () => {
      const lock = await withCronLock('conversational-safety-notifications', LOCK_TTL_MS, async () => {
        const result = await retryConversationalAgentSafetyNotifications({ limit: 30 })
        if (result.attempted) {
          logger.info(`[Agente conversacional] Revisiones preventivas: ${result.sent} avisadas, ${result.failed} pendientes`)
        }
        return result
      })
      return lock.result || { skipped: !lock.ran }
    }, source)
  } catch (error) {
    logger.error(`[Agente conversacional] Error reintentando avisos preventivos: ${error.message}`)
    return { error: error.message }
  } finally {
    running = false
  }
}

export function startConversationalAgentSafetyNotificationsCron() {
  if (started) return
  started = true
  const timer = setInterval(() => {
    runConversationalAgentSafetyNotifications().catch(() => undefined)
  }, INTERVAL_MS)
  timer.unref?.()
  runConversationalAgentSafetyNotifications('startup').catch(() => undefined)
}
