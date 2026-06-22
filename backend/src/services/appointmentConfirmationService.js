import crypto from 'crypto'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { isAffirmativeReply } from './appointmentReminderLogic.js'
import { classifyConfirmationResponse } from '../agents/appointmentConfirmationAgent.js'
import { sendAppNotificationPayload, sendAppointmentConfirmationNotification } from './pushNotificationsService.js'

export { isAffirmativeReply }

// Tiempo de espera tras el último mensaje del contacto antes de clasificar (2 minutos).
const DEBOUNCE_MS = 2 * 60 * 1000
const CONFIRMATION_SUCCESS_ACTIONS = new Set(['mark_confirmed', 'chat_card', 'notify_push', 'chat_badge'])

function makeWindowId() {
  return `conf_win_${crypto.randomUUID()}`
}

function nowIso() {
  return new Date().toISOString()
}

function parseMessages(raw) {
  try {
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function normalizeConfirmationSuccessAction(value) {
  const clean = String(value || '').trim()
  return CONFIRMATION_SUCCESS_ACTIONS.has(clean) ? clean : 'chat_card'
}

/**
 * Verifica si un contacto tiene una ventana de confirmación activa (status='waiting').
 * Se usa para decidir si otros agentes/automatizaciones deben pausarse.
 */
export async function getActiveConfirmationWindow(contactId) {
  const id = String(contactId || '').trim()
  if (!id) return null
  return db.get(`
    SELECT * FROM appointment_confirmation_windows
    WHERE contact_id = ? AND status = 'waiting'
    LIMIT 1
  `, [id])
}

/**
 * Registra un mensaje entrante en la ventana de confirmación si el contacto
 * tiene un envío de confirmación con IA pendiente. Crea la ventana si no existe.
 *
 * Retorna:
 *   { windowActive: true, bypassAutomations: boolean } si el contacto está
 *   dentro de una secuencia de confirmación con IA.
 *   { windowActive: false } si no aplica.
 */
export async function handleInboundForConfirmation({ contactId, text } = {}) {
  const id = String(contactId || '').trim()
  if (!id) return { windowActive: false }

  // Buscar si hay un envío de confirmación con IA para este contacto
  // (cualquier cita futura no confirmada aún).
  const pending = await db.get(`
    SELECT
      s.id AS send_id,
      s.appointment_id,
      s.reminder_id,
      r.bypass_automations,
      r.confirmation_success_action,
      a.title
    FROM appointment_reminder_sends s
    JOIN appointments a ON a.id = s.appointment_id
    JOIN appointment_reminders r ON r.id = s.reminder_id
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

  if (!pending) return { windowActive: false }

  const bypassAutomations = Number(pending.bypass_automations || 0) === 1
  const now = nowIso()
  const messageText = String(text || '').trim()

  // ¿Ya existe una ventana activa para este par (contacto, cita)?
  const existing = await db.get(`
    SELECT id, accumulated_messages FROM appointment_confirmation_windows
    WHERE contact_id = ? AND appointment_id = ? AND status = 'waiting'
  `, [id, pending.appointment_id])

  if (existing) {
    // Reiniciar el temporizador y agregar el mensaje.
    const messages = parseMessages(existing.accumulated_messages)
    if (messageText) messages.push(messageText)
    await db.run(`
      UPDATE appointment_confirmation_windows
      SET accumulated_messages = ?, last_message_at = ?, updated_at = ?
      WHERE id = ?
    `, [JSON.stringify(messages), now, now, existing.id])
    logger.info(`[Confirmación IA] Ventana reiniciada para contacto ${id} (${messages.length} msgs acumulados)`)
  } else {
    // Crear nueva ventana.
    const messages = messageText ? [messageText] : []
    await db.run(`
      INSERT INTO appointment_confirmation_windows
        (id, contact_id, appointment_id, reminder_send_id, status,
         accumulated_messages, bypass_automations, confirmation_success_action, last_message_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(contact_id, appointment_id) DO UPDATE SET
        status = 'waiting',
        accumulated_messages = excluded.accumulated_messages,
        bypass_automations = excluded.bypass_automations,
        confirmation_success_action = excluded.confirmation_success_action,
        last_message_at = excluded.last_message_at,
        updated_at = excluded.updated_at
    `, [
      makeWindowId(), id, pending.appointment_id, pending.send_id,
      JSON.stringify(messages), bypassAutomations ? 1 : 0,
      normalizeConfirmationSuccessAction(pending.confirmation_success_action),
      now, now, now
    ])
    logger.info(`[Confirmación IA] Ventana abierta para contacto ${id}, cita ${pending.appointment_id}`)
  }

  return { windowActive: true, bypassAutomations }
}

/**
 * Procesa todas las ventanas cuyo temporizador expiró (≥ 2 min sin mensajes nuevos).
 * Llamado desde el cron de mensajes automáticos.
 */
export async function processExpiredConfirmationWindows() {
  const cutoff = new Date(Date.now() - DEBOUNCE_MS).toISOString()

  const windows = await db.all(`
    SELECT * FROM appointment_confirmation_windows
    WHERE status = 'waiting' AND last_message_at <= ?
  `, [cutoff])

  if (!windows.length) return { processed: 0 }

  let processed = 0
  for (const win of windows) {
    try {
      await processConfirmationWindow(win)
      processed += 1
    } catch (error) {
      logger.error(`[Confirmación IA] Error procesando ventana ${win.id}: ${error.message}`)
      await db.run(`
        UPDATE appointment_confirmation_windows
        SET status = 'error', result_detail = ?, updated_at = ?
        WHERE id = ?
      `, [error.message.slice(0, 500), nowIso(), win.id])
    }
  }

  return { processed }
}

async function processConfirmationWindow(win) {
  // Bloquear la ventana para evitar procesarla dos veces.
  const updated = await db.run(`
    UPDATE appointment_confirmation_windows
    SET status = 'processing', updated_at = ?
    WHERE id = ? AND status = 'waiting'
  `, [nowIso(), win.id])

  if (!updated || updated.changes === 0) return // Ya tomada por otra ejecución concurrente.

  const messages = parseMessages(win.accumulated_messages)
  const contactId = String(win.contact_id || '')
  const appointmentId = String(win.appointment_id || '')

  // Obtener datos del recordatorio para la acción configurada.
  const reminderData = await db.get(`
    SELECT r.no_confirm_action, r.bypass_automations, r.confirmation_success_action, c.phone, c.first_name
    FROM appointment_reminder_sends s
    JOIN appointment_reminders r ON r.id = s.reminder_id
    JOIN contacts c ON c.id = s.contact_id
    WHERE s.id = ?
  `, [win.reminder_send_id])

  // Si no hay mensajes acumulados, cerrar la ventana sin acción.
  if (!messages.length) {
    await db.run(`
      UPDATE appointment_confirmation_windows
      SET status = 'done', result = 'no_response', processed_at = ?, updated_at = ?
      WHERE id = ?
    `, [nowIso(), nowIso(), win.id])
    logger.info(`[Confirmación IA] Ventana ${win.id} cerrada sin mensajes (sin respuesta)`)
    return
  }

  // Clasificar la respuesta con el agente IA.
  const classification = await classifyConfirmationResponse({ accumulatedMessages: messages })
  const result = classification?.result || 'ambiguous'
  const resultDetail = classification?.reason || ''

  logger.info(`[Confirmación IA] Contacto ${contactId}, cita ${appointmentId}: ${result} (${resultDetail})`)

  // Ejecutar la acción según la clasificación.
  if (result === 'confirmed') {
    await db.run(`
      UPDATE appointments
      SET appointment_status = 'confirmed', status = 'confirmed', date_updated = CURRENT_TIMESTAMP
      WHERE id = ? AND LOWER(COALESCE(appointment_status, status, '')) NOT IN ('confirmed')
    `, [appointmentId])
    await executeConfirmationSuccessAction({
      contactId,
      appointmentId,
      action: normalizeConfirmationSuccessAction(win.confirmation_success_action || reminderData?.confirmation_success_action),
      resultDetail,
      reminderData
    })
    logger.info(`[Confirmación IA] Cita ${appointmentId} confirmada automáticamente`)
  } else {
    // Para reschedule, cancel, ambiguous, human_needed → ejecutar la acción del recordatorio.
    const noConfirmAction = String(reminderData?.no_confirm_action || 'no_action')
    await executeNoConfirmAction({
      contactId,
      appointmentId,
      action: noConfirmAction,
      result,
      resultDetail,
      reminderData
    })
  }

  await db.run(`
    UPDATE appointment_confirmation_windows
    SET status = 'done', result = ?, result_detail = ?, processed_at = ?, updated_at = ?
    WHERE id = ?
  `, [result, resultDetail.slice(0, 500), nowIso(), nowIso(), win.id])
}

async function executeConfirmationSuccessAction({ contactId, appointmentId, action, resultDetail, reminderData }) {
  const normalizedAction = normalizeConfirmationSuccessAction(action)
  const appointment = await db.get(`
    SELECT a.id, a.title, a.start_time, a.calendar_id, a.contact_id, c.first_name, c.full_name
    FROM appointments a
    LEFT JOIN contacts c ON c.id = a.contact_id
    WHERE a.id = ?
  `, [appointmentId])

  const contactName = String(appointment?.first_name || appointment?.full_name || reminderData?.first_name || 'Contacto').trim()
  const appointmentTitle = String(appointment?.title || 'cita').trim()

  await sendAppointmentConfirmationNotification(appointment || { id: appointmentId, contactId }, {
    appointmentId,
    contactId,
    contactName,
    appointmentTitle,
    calendarId: appointment?.calendar_id,
    startTime: appointment?.start_time,
    resultDetail
  }).catch(error => {
    logger.warn(`[Confirmación IA] No se pudo enviar push de cita confirmada: ${error.message}`)
  })

  if (normalizedAction === 'chat_badge') {
    await db.run(`
      UPDATE appointments
      SET confirmation_badge_until = COALESCE(start_time, ?), date_updated = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), appointmentId])
    logger.info(`[Confirmación IA] Etiqueta visual temporal activada para cita ${appointmentId}`)
    return
  }

  if (normalizedAction === 'notify_push') {
    logger.info(`[Confirmación IA] Notificación de confirmación enviada para cita ${appointmentId}`)
    return
  }

  if (normalizedAction === 'chat_card') {
    logger.info(`[Confirmación IA] Tarjeta de confirmación disponible en journey para cita ${appointmentId}`)
  }
}

async function executeNoConfirmAction({ contactId, appointmentId, action, result, resultDetail, reminderData }) {
  const appointment = await db.get(`
    SELECT a.id, a.title, a.start_time, c.first_name, c.full_name
    FROM appointments a
    LEFT JOIN contacts c ON c.id = a.contact_id
    WHERE a.id = ?
  `, [appointmentId])

  if (action === 'cancel_appointment') {
    await db.run(`
      UPDATE appointments
      SET appointment_status = 'cancelled', status = 'cancelled', date_updated = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [appointmentId])
    logger.info(`[Confirmación IA] Cita ${appointmentId} cancelada por acción automática (resultado: ${result})`)
  }

  if (action === 'notify_push') {
    const resultLabels = {
      reschedule: 'quiere reagendar',
      cancel: 'cancela',
      ambiguous: 'respuesta ambigua',
      human_needed: 'requiere atención humana'
    }
    const label = resultLabels[result] || result
    const contactName = String(appointment?.first_name || appointment?.full_name || reminderData?.first_name || 'Contacto').trim()
    const appointmentTitle = String(appointment?.title || 'cita').trim()

    const payload = {
      title: `Confirmación de cita: ${contactName} ${label}`,
      body: `${contactName} respondió sobre "${appointmentTitle}". ${resultDetail || ''}`.trim().slice(0, 160),
      tag: `conf-${appointmentId}`,
      url: `/phone/calendar?open=appointment&id=${encodeURIComponent(appointmentId)}`
    }

    await sendAppNotificationPayload(payload).catch(error => {
      logger.warn(`[Confirmación IA] No se pudo enviar notificación push: ${error.message}`)
    })
    logger.info(`[Confirmación IA] Notificación enviada para cita ${appointmentId} (resultado: ${result})`)
  }
}

/**
 * Compatibilidad: cuando el switch de IA está desactivado se usa esta función
 * para confirmar citas por simple detección de respuesta afirmativa (comportamiento anterior).
 */
export async function maybeConfirmAppointmentFromReply({ contactId, text } = {}) {
  const id = String(contactId || '').trim()
  if (!id || !isAffirmativeReply(text)) return null

  // Verificar primero si hay una ventana activa con IA: en ese caso el
  // procesamiento lo hace la ventana, no esta función.
  const win = await getActiveConfirmationWindow(id)
  if (win) return null

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
