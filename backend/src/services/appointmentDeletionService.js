import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import * as highLevelCalendarService from './highlevelCalendarService.js'
import * as localCalendarService from './localCalendarService.js'
import * as googleCalendarService from './googleCalendarService.js'
import { dispatchAppointmentAutomationEvent } from './appointmentAutomationService.js'

function cleanString(value) {
  return String(value ?? '').trim()
}

function cleanupUnavailableError(message, code) {
  const error = new Error(message)
  error.status = 409
  error.statusCode = 409
  error.code = code
  return error
}

/**
 * Retira una cita de sus proveedores y de la agenda local usando un único
 * contrato. El snapshot se conserva hasta el final para que Automatizaciones
 * reciba la cancelación aunque la fila local ya no exista.
 */
export async function deleteAppointmentEverywhere(appointmentId, {
  accessToken = null,
  requireGoogleCleanup = false,
  suppressGoogleNotificationEmails = []
} = {}) {
  const existing = await localCalendarService.getLocalAppointment(appointmentId)
  if (!existing) return { deleted: false, appointment: null }

  if (existing.googleEventId) {
    const googleResult = await googleCalendarService.deleteGoogleEventForAppointment(existing, {
      suppressNotificationEmails: suppressGoogleNotificationEmails
    })
    if (requireGoogleCleanup && googleResult?.deleted !== true) {
      throw cleanupUnavailableError(
        'No se pudo retirar la cita de Google Calendar. Reconecta Google Calendar o cancela el evento manualmente antes de archivar el contacto.',
        'contact_google_appointment_cleanup_unavailable'
      )
    }
  }

  let pendingHighLevelDelete = false
  if (cleanString(existing.ghlAppointmentId)) {
    if (cleanString(accessToken)) {
      try {
        await highLevelCalendarService.deleteEvent(existing.ghlAppointmentId, accessToken)
        await localCalendarService.deleteLocalAppointment(existing.id)
      } catch (error) {
        pendingHighLevelDelete = true
        logger.warn(`[Citas] Delete HighLevel falló para ${existing.id}; queda pendiente: ${error.message}`)
        await localCalendarService.deleteLocalAppointment(existing.id, { markPendingDelete: true })
      }
    } else {
      pendingHighLevelDelete = true
      await localCalendarService.deleteLocalAppointment(existing.id, { markPendingDelete: true })
    }
  } else {
    await localCalendarService.deleteLocalAppointment(existing.id)
  }

  await dispatchAppointmentAutomationEvent('appointment-status', {
    ...existing,
    status: 'cancelled',
    appointmentStatus: 'cancelled'
  }, {
    previousStatus: existing.appointmentStatus || existing.status || null,
    previousAppointmentId: existing.id,
    appointmentChange: 'cancelled'
  })

  return {
    deleted: true,
    appointment: existing,
    pendingHighLevelDelete
  }
}

export async function getStoredHighLevelCalendarAccessToken() {
  const config = await db.get('SELECT api_token FROM highlevel_config LIMIT 1').catch(() => null)
  return cleanString(config?.api_token) || null
}
