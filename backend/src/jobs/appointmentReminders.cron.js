import {
  ensureDefaultAppointmentReminder,
  processDueAppointmentReminders
} from '../services/appointmentRemindersService.js'
import { processExpiredConfirmationWindows } from '../services/appointmentConfirmationService.js'
import { logger } from '../utils/logger.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'
import { withCronLock } from '../utils/cronLock.js'

const APPOINTMENT_REMINDERS_INTERVAL_MS = 60 * 1000
// Las ventanas se verifican más frecuentemente para no agregar latencia innecesaria
// después del debounce de 3 min. Cada 30 s es suficiente.
const CONFIRMATION_WINDOWS_INTERVAL_MS = 30 * 1000

let started = false
let running = false
let windowsRunning = false

async function runAppointmentRemindersDispatch(source = 'interval') {
  if (running || isDeployShutdownStarted()) return
  running = true

  try {
    await trackDeployDrainWork('cron:appointment-reminders', async () => {
      // (APT-009) Lock distribuido: si hubiera varias instancias, solo una despacha
      // recordatorios por tick (evita mensajes duplicados). Defensivo con 1 instancia.
      await withCronLock('appointment-reminders', APPOINTMENT_REMINDERS_INTERVAL_MS, async () => {
        const { sent, errors, skipped } = await processDueAppointmentReminders()
        if (sent || errors || skipped) {
          logger.info(`[Citas] Mensajes automáticos (${source}): ${sent} enviados, ${errors} con error, ${skipped} omitidos`)
        }
      })
    }, source)
  } catch (error) {
    logger.error(`[Citas] Error procesando mensajes automáticos: ${error.message}`)
  } finally {
    running = false
  }
}

async function runConfirmationWindowsDispatch() {
  if (windowsRunning || isDeployShutdownStarted()) return
  windowsRunning = true
  try {
    await trackDeployDrainWork('cron:appointment-confirmations', async () => {
      // (APT-009) Lock distribuido también para las ventanas de confirmación IA.
      await withCronLock('appointment-confirmations', CONFIRMATION_WINDOWS_INTERVAL_MS, async () => {
        const { processed } = await processExpiredConfirmationWindows()
        if (processed) {
          logger.info(`[Citas] Ventanas de confirmación IA procesadas: ${processed}`)
        }
      })
    })
  } catch (error) {
    logger.error(`[Citas] Error procesando ventanas de confirmación IA: ${error.message}`)
  } finally {
    windowsRunning = false
  }
}

export function startAppointmentRemindersCron() {
  if (started) return
  started = true

  logger.info('Iniciando mensajes automáticos de citas')

  ensureDefaultAppointmentReminder().catch(error => {
    logger.warn(`[Citas] No se pudo crear el recordatorio por defecto: ${error.message}`)
  })

  setInterval(() => {
    runAppointmentRemindersDispatch().catch(error => {
      logger.error(`[Citas] Error no manejado en mensajes automáticos: ${error.message}`)
    })
  }, APPOINTMENT_REMINDERS_INTERVAL_MS)

  setInterval(() => {
    runConfirmationWindowsDispatch().catch(error => {
      logger.error(`[Citas] Error no manejado en ventanas de confirmación IA: ${error.message}`)
    })
  }, CONFIRMATION_WINDOWS_INTERVAL_MS)

  runAppointmentRemindersDispatch('startup').catch(error => {
    logger.error(`[Citas] Error inicial en mensajes automáticos: ${error.message}`)
  })

  runConfirmationWindowsDispatch().catch(error => {
    logger.error(`[Citas] Error inicial en ventanas de confirmación IA: ${error.message}`)
  })
}
