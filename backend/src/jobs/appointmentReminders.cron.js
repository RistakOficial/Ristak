import {
  ensureDefaultAppointmentReminder,
  processDueAppointmentReminders
} from '../services/appointmentRemindersService.js'
import { processExpiredConfirmationWindows } from '../services/appointmentConfirmationService.js'
import { logger } from '../utils/logger.js'

const APPOINTMENT_REMINDERS_INTERVAL_MS = 60 * 1000
// Las ventanas se verifican más frecuentemente para no agregar latencia innecesaria
// después del debounce de 3 min. Cada 30 s es suficiente.
const CONFIRMATION_WINDOWS_INTERVAL_MS = 30 * 1000

let started = false
let running = false
let windowsRunning = false

async function runAppointmentRemindersDispatch(source = 'interval') {
  if (running) return
  running = true

  try {
    const { sent, errors, skipped } = await processDueAppointmentReminders()
    if (sent || errors || skipped) {
      logger.info(`[Citas] Mensajes automáticos (${source}): ${sent} enviados, ${errors} con error, ${skipped} omitidos`)
    }
  } catch (error) {
    logger.error(`[Citas] Error procesando mensajes automáticos: ${error.message}`)
  } finally {
    running = false
  }
}

async function runConfirmationWindowsDispatch() {
  if (windowsRunning) return
  windowsRunning = true
  try {
    const { processed } = await processExpiredConfirmationWindows()
    if (processed) {
      logger.info(`[Citas] Ventanas de confirmación IA procesadas: ${processed}`)
    }
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
