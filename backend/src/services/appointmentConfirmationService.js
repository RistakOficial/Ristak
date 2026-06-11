import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'

import { isAffirmativeReply } from './appointmentReminderLogic.js'

export { isAffirmativeReply }

/**
 * Cuando un contacto responde afirmativamente a un mensaje de confirmación
 * con IA activada, confirma automáticamente su próxima cita pendiente.
 * Se invoca con cada mensaje entrante de WhatsApp; sale rápido si no aplica.
 */
export async function maybeConfirmAppointmentFromReply({ contactId, text } = {}) {
  const id = String(contactId || '').trim()
  if (!id || !isAffirmativeReply(text)) return null

  const pending = await db.get(`
    SELECT s.id AS send_id, s.appointment_id, a.title
    FROM appointment_reminder_sends s
    JOIN appointments a ON a.id = s.appointment_id
    WHERE s.contact_id = ?
      AND s.status = 'sent'
      AND s.message_type = 'confirmation'
      AND s.ai_enabled = 1
      AND a.deleted_at IS NULL
      AND a.start_time > ?
      AND LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN ('confirmed', 'cancelled', 'canceled')
    ORDER BY s.sent_at DESC
    LIMIT 1
  `, [id, new Date().toISOString()])

  if (!pending) return null

  await db.run(`
    UPDATE appointments
    SET appointment_status = 'confirmed', status = 'confirmed', date_updated = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [pending.appointment_id])

  logger.info(`[Citas] IA confirmó la cita ${pending.appointment_id} por respuesta del contacto ${id}`)
  return { appointmentId: pending.appointment_id }
}
