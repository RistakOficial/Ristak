import {
  cleanupDueConversationalAgentTestAssignments,
  retryConversationalAgentTestAssignmentNotifications
} from '../services/conversationalAgentTestAssignmentService.js'
import { logger } from '../utils/logger.js'
import { withCronLock } from '../utils/cronLock.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'

const INTERVAL_MS = 60 * 1000
const LOCK_TTL_MS = 55 * 1000

let timer = null
let running = false

/** Job de sistema exportable; server decide cuándo conectarlo. */
export async function runConversationalAgentTestAssignmentsCleanup(options = {}) {
  if (running || isDeployShutdownStarted()) return { skipped: true }
  running = true
  try {
    return await trackDeployDrainWork('cron:conversational-test-assignment-cleanup', async () => {
      const lock = await withCronLock('conversational-test-assignment-cleanup', LOCK_TTL_MS, async () => {
        const cleanup = await cleanupDueConversationalAgentTestAssignments(options)
        const notifications = await retryConversationalAgentTestAssignmentNotifications(options)
        return { cleanup, notifications }
      })
      if (!lock.ran) return { skipped: true, reason: 'locked' }

      const result = lock.result || {}
      if (result.cleanup?.failed > 0 || result.notifications?.failed > 0) {
        logger.warn(
          `[Tester agente] Asignaciones de prueba: ${result.cleanup?.cleaned || 0} restauradas, ` +
          `${result.cleanup?.failed || 0} limpiezas y ${result.notifications?.failed || 0} notificaciones pendientes.`
        )
      } else if ((result.cleanup?.cleaned || 0) > 0) {
        logger.info(`[Tester agente] ${result.cleanup.cleaned} asignación(es) de prueba restaurada(s).`)
      }
      return result
    })
  } finally {
    running = false
  }
}

export function startConversationalAgentTestAssignmentsCleanup() {
  if (timer) return
  timer = setInterval(() => {
    runConversationalAgentTestAssignmentsCleanup().catch(error => {
      logger.error(`[Tester agente] Error limpiando asignaciones de prueba: ${error.message}`)
    })
  }, INTERVAL_MS)
  timer.unref?.()
  runConversationalAgentTestAssignmentsCleanup({ source: 'startup' }).catch(() => undefined)
}

export function stopConversationalAgentTestAssignmentsCleanup() {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

export default runConversationalAgentTestAssignmentsCleanup
