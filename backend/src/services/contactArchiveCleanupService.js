import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import * as localCalendarService from './localCalendarService.js'
import * as googleCalendarService from './googleCalendarService.js'
import {
  deleteAppointmentEverywhere,
  getStoredHighLevelCalendarAccessToken
} from './appointmentDeletionService.js'
import { exitContactAutomationEnrollments } from './automationEngine.js'
import { cancelScheduledChatMessagesForContact } from './scheduledChatMessagesService.js'
import { cancelPendingBulkActionsForContact } from './contactBulkActionsService.js'

const ACTIVE_APPOINTMENT_TERMINAL_STATUSES = [
  'cancelled',
  'canceled',
  'invalid',
  'deleted',
  'noshow',
  'no_show',
  'no-show',
  'showed',
  'show',
  'attended',
  'completed',
  'complete'
]

function cleanString(value) {
  return String(value ?? '').trim()
}

function archiveCleanupError(message, code) {
  const error = new Error(message)
  error.status = 409
  error.statusCode = 409
  error.code = code
  return error
}

async function listActiveAppointmentLinks(contactId) {
  const terminalPlaceholders = ACTIVE_APPOINTMENT_TERMINAL_STATUSES.map(() => '?').join(', ')
  return db.all(`
    SELECT DISTINCT
      a.id,
      CASE
        WHEN a.contact_id = ? THEN 1
        WHEN EXISTS (
          SELECT 1
          FROM appointment_participants owner_participant
          WHERE owner_participant.appointment_id = a.id
            AND owner_participant.contact_id = ?
            AND owner_participant.role IN ('requester', 'primary_attendee')
        ) THEN 1
        ELSE 0
      END AS owns_appointment
    FROM appointments a
    WHERE a.deleted_at IS NULL
      AND COALESCE(a.sync_status, '') != 'pending_delete'
      AND LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN (${terminalPlaceholders})
      AND (
        a.contact_id = ?
        OR EXISTS (
          SELECT 1
          FROM appointment_participants participant
          WHERE participant.appointment_id = a.id
            AND participant.contact_id = ?
        )
      )
    ORDER BY a.id ASC
  `, [contactId, contactId, ...ACTIVE_APPOINTMENT_TERMINAL_STATUSES, contactId, contactId])
}

async function removeArchivedGuestFromAppointment(appointment, contactId) {
  const participants = Array.isArray(appointment?.participants) ? appointment.participants : []
  const remaining = participants.filter(participant => cleanString(participant?.contactId) !== contactId)
  if (remaining.length === participants.length) return { updated: false }

  if (appointment.googleEventId) {
    const googleConfig = await googleCalendarService.getGoogleCalendarConfig({ includeCredentials: true })
    if (!googleConfig) {
      throw archiveCleanupError(
        'No se puede retirar al contacto invitado de Google Calendar mientras la integración está desconectada.',
        'contact_google_guest_cleanup_unavailable'
      )
    }
  }

  await localCalendarService.replaceAppointmentParticipants(appointment.id, remaining)

  if (appointment.googleEventId) {
    const syncResult = await googleCalendarService.syncAppointmentToGoogle(appointment.id, {
      sendUpdates: 'none'
    })
    if (syncResult?.enabled !== true) {
      throw archiveCleanupError(
        'No se pudo actualizar la lista de invitados en Google Calendar. Revisa la conexión antes de archivar el contacto.',
        'contact_google_guest_cleanup_failed'
      )
    }
  }

  return { updated: true }
}

async function cleanupContactAppointments(contactId) {
  const links = await listActiveAppointmentLinks(contactId)
  const contact = await db.get('SELECT email FROM contacts WHERE id = ?', [contactId])
  const archivedEmail = cleanString(contact?.email).toLowerCase()
  const accessToken = links.length > 0
    ? await getStoredHighLevelCalendarAccessToken()
    : null
  let cancelled = 0
  let guestLinksRemoved = 0

  for (const link of links) {
    const appointment = await localCalendarService.getLocalAppointment(link.id)
    if (!appointment) continue

    if (Number(link.owns_appointment) === 1) {
      const archivedAppointmentEmails = [
        archivedEmail,
        ...(Array.isArray(appointment.participants) ? appointment.participants : [])
          .filter(participant => cleanString(participant?.contactId) === contactId)
          .map(participant => cleanString(participant?.email).toLowerCase())
      ].filter(Boolean)
      const result = await deleteAppointmentEverywhere(appointment.id, {
        accessToken,
        requireGoogleCleanup: true,
        suppressGoogleNotificationEmails: [...new Set(archivedAppointmentEmails)]
      })
      if (result.deleted) cancelled += 1
      continue
    }

    const result = await removeArchivedGuestFromAppointment(appointment, contactId)
    if (result.updated) guestLinksRemoved += 1
  }

  return { cancelled, guestLinksRemoved }
}

/**
 * Cierra todos los productores de mensajes antes de completar el soft-delete.
 * El contacto ya debe estar marcado como eliminado para impedir nuevas altas
 * mientras se limpian proveedores y colas.
 */
export async function cleanupContactBeforeArchive(contactId) {
  const id = cleanString(contactId)
  if (!id) throw archiveCleanupError('Contacto inválido', 'contact_archive_invalid_id')

  const [automations, scheduledMessages, bulkActions] = await Promise.all([
    exitContactAutomationEnrollments(id),
    cancelScheduledChatMessagesForContact(id),
    cancelPendingBulkActionsForContact(id)
  ])
  // Las colas se cierran antes de hablar con proveedores externos: una llamada
  // lenta a Google/HighLevel no deja una ventana para que salga otro mensaje.
  const appointments = await cleanupContactAppointments(id)

  const result = {
    appointments,
    automations,
    scheduledMessages,
    bulkActions
  }
  logger.info(`[Contactos] Productores de salida detenidos para ${id}: ${JSON.stringify(result)}`)
  return result
}
