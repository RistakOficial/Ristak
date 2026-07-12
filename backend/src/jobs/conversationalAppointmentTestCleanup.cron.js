import cron from 'node-cron'
import { cleanupExpiredConversationalTestAppointments } from '../services/conversationalAppointmentTestCleanupService.js'
import { cleanupExpiredConversationalAppointmentPreviewOffers } from '../services/conversationalAppointmentPreviewOfferService.js'
import { logger } from '../utils/logger.js'
import { withCronLock } from '../utils/cronLock.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'

const TEST_APPOINTMENT_CLEANUP_LOCK_TTL_MS = 60 * 1000

let cleanupTask = null
let cleanupRunning = false

export async function runConversationalAppointmentTestCleanup(source = 'manual') {
  if (cleanupRunning || isDeployShutdownStarted()) return { skipped: true }
  cleanupRunning = true

  try {
    return await trackDeployDrainWork('cron:conversational-appointment-test-cleanup', async () => {
      const result = await withCronLock(
        'conversational-appointment-test-cleanup',
        TEST_APPOINTMENT_CLEANUP_LOCK_TTL_MS,
        async () => {
          const appointments = await cleanupExpiredConversationalTestAppointments()
          const previewOffers = await cleanupExpiredConversationalAppointmentPreviewOffers()
          return { ...appointments, previewOffers }
        }
      )
      if (!result.ran) return { skipped: true, reason: 'locked' }

      const summary = result.result || {}
      if (summary.processed) {
        logger.info(
          `[Tester agente] Limpieza de citas (${source}): ${summary.cleaned || 0} limpias, ` +
          `${summary.pending || 0} pendientes, ${summary.failed || 0} con error`
        )
      }
      return summary
    }, source)
  } catch (error) {
    logger.error(`[Tester agente] Error en limpieza de citas de prueba: ${error.message}`)
    return { failed: 1, error: error.message }
  } finally {
    cleanupRunning = false
  }
}

export function startConversationalAppointmentTestCleanupCron() {
  if (cleanupTask) return
  cleanupTask = cron.schedule('* * * * *', () => {
    runConversationalAppointmentTestCleanup('interval').catch(error => {
      logger.error(`[Tester agente] Error no manejado en limpieza de citas: ${error.message}`)
    })
  })
  runConversationalAppointmentTestCleanup('startup').catch(error => {
    logger.error(`[Tester agente] Error inicial en limpieza de citas: ${error.message}`)
  })
}

export function stopConversationalAppointmentTestCleanupCron() {
  if (!cleanupTask) return
  cleanupTask.stop()
  cleanupTask.destroy?.()
  cleanupTask = null
}
