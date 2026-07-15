import { expirePausedConversationStates } from '../services/conversationalAgentService.js'
import { logger } from '../utils/logger.js'
import { withCronLock } from '../utils/cronLock.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'

const INTERVAL_MS = 5_000
const LOCK_TTL_MS = 30_000
const MAX_BATCHES_PER_TICK = 4

let intervalId = null
let running = false

/**
 * Job de sistema: materializa el fin de una pausa sin convertir los GET de
 * métricas/listados en comandos ocultos. El índice parcial 098 limita cada
 * claim a las pausas realmente vencidas y el servicio garantiza evento único.
 */
export async function runConversationalAgentPauseExpiry() {
  if (running || isDeployShutdownStarted()) return { skipped: true }
  running = true
  try {
    return await trackDeployDrainWork('cron:conversational-agent-pause-expiry', async () => {
      const lock = await withCronLock('conversational-agent-pause-expiry', LOCK_TTL_MS, async () => {
        let expired = 0
        let batches = 0
        while (batches < MAX_BATCHES_PER_TICK) {
          const batchCount = await expirePausedConversationStates()
          expired += batchCount
          batches += 1
          if (batchCount < 500) break
        }
        return { expired, batches }
      })
      if (!lock.ran) return { skipped: true, reason: 'locked' }
      if ((lock.result?.expired || 0) > 0) {
        logger.info(`[Agente] ${lock.result.expired} pausa(s) vencida(s) reactivadas.`)
      }
      return lock.result
    })
  } finally {
    running = false
  }
}

export function startConversationalAgentPauseExpiryCron() {
  if (intervalId) return
  intervalId = setInterval(() => {
    runConversationalAgentPauseExpiry().catch((error) => {
      logger.error(`[Agente] Error reactivando pausas vencidas: ${error.message}`)
    })
  }, INTERVAL_MS)
  intervalId.unref?.()
  runConversationalAgentPauseExpiry().catch((error) => {
    logger.error(`[Agente] Error inicial reactivando pausas vencidas: ${error.message}`)
  })
}

export function stopConversationalAgentPauseExpiryCron() {
  if (!intervalId) return
  clearInterval(intervalId)
  intervalId = null
}

export default runConversationalAgentPauseExpiry
