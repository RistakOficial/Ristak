import { db, databaseDialect } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { getAccountTimezone } from '../utils/dateUtils.js'
import { isAffirmativeReply, renderMessageText } from './appointmentReminderLogic.js'
import { classifyConfirmationResponse } from '../agents/appointmentConfirmationAgent.js'
import { sendAppointmentConfirmationNotification } from './pushNotificationsService.js'
import { createRistakId } from '../utils/idGenerator.js'
import { publishChatDataChangedEvent } from './chatLiveEventsService.js'
import {
  LEGACY_CONFIRMATION_SUCCESS_ACTIONS,
  normalizeConfirmationSuccessActions,
  serializeConfirmationSuccessActions
} from './appointmentConfirmationActions.js'

export { isAffirmativeReply }

// Tiempo de espera tras el último mensaje del contacto antes de clasificar (2 minutos).
const DEBOUNCE_MS = 2 * 60 * 1000
const MAX_CONFIRMATION_REPLY_TEXT_LENGTH = 4096
let confirmationReplySenderForTest = null

export function setAppointmentConfirmationReplySenderForTest(sender = null) {
  confirmationReplySenderForTest = typeof sender === 'function' ? sender : null
}

function makeWindowId() {
  return createRistakId('confirmation_window')
}

function nowIso() {
  return new Date().toISOString()
}

function publishAppointmentChanged(contactId, appointmentId) {
  publishChatDataChangedEvent({
    contactId,
    domains: ['appointments'],
    entityId: appointmentId
  })
}

// Tras cambiar el estado de una cita (confirmar/cancelar) hay que reflejarlo en Google:
// una cita pendiente vive como 'tentative' y al confirmarse debe pasar a 'confirmed'
// (o borrarse si se cancela). Import dinámico para evitar ciclos; un fallo de sync nunca
// debe tumbar la confirmación.
async function resyncAppointmentToGoogle(appointmentId) {
  if (!appointmentId) return
  try {
    const { syncAppointmentToGoogle } = await import('./googleCalendarService.js')
    await syncAppointmentToGoogle(appointmentId)
  } catch (error) {
    logger.warn(`[Confirmación IA] No se pudo re-sincronizar la cita ${appointmentId} con Google: ${error.message}`)
  }
}

async function dispatchAppointmentStatusAutomation(appointmentId, extra = {}) {
  if (!appointmentId) return
  try {
    const appointment = await db.get(
      'SELECT * FROM appointments WHERE id = ?',
      [appointmentId]
    )
    if (!appointment) return
    const { dispatchAppointmentAutomationEvent } = await import('./appointmentAutomationService.js')
    await dispatchAppointmentAutomationEvent('appointment-status', appointment, extra)
  } catch (error) {
    logger.warn(`[Confirmación IA] No se pudo avisar a las automatizaciones del cambio en la cita ${appointmentId}: ${error.message}`)
  }
}

function parseStoredMessages(raw) {
  try {
    const parsed = JSON.parse(raw || '[]')
    if (!Array.isArray(parsed)) return []

    return parsed
      .map((entry, index) => {
        if (typeof entry === 'string') {
          return { text: entry.trim(), messageId: '', receivedAtMs: null, index }
        }

        const text = String(entry?.text || '').trim()
        const receivedAtMs = new Date(entry?.receivedAt || '').getTime()
        return {
          text,
          messageId: String(entry?.messageId || '').trim(),
          receivedAtMs: Number.isNaN(receivedAtMs) ? null : receivedAtMs,
          index
        }
      })
      .filter(entry => entry.text)
      .sort((left, right) => {
        // Ventanas creadas antes de este cambio guardaban strings. Si aparece
        // una mezcla, se conserva el orden ya persistido. Cuando ambos mensajes
        // traen instante del proveedor, sí se reconstruye el orden real.
        if (
          left.receivedAtMs !== null &&
          right.receivedAtMs !== null &&
          left.receivedAtMs !== right.receivedAtMs
        ) {
          return left.receivedAtMs - right.receivedAtMs
        }
        return left.index - right.index
      })
  } catch {
    return []
  }
}

function buildStoredMessage({ text, receivedAt, messageId, fallbackReceivedAt }) {
  const messageText = String(text || '').trim()
  if (!messageText) return null

  const receivedAtDate = new Date(receivedAt || '')
  const receivedAtIso = Number.isNaN(receivedAtDate.getTime())
    ? fallbackReceivedAt
    : receivedAtDate.toISOString()
  const stored = {
    text: messageText,
    receivedAt: receivedAtIso
  }
  const cleanMessageId = String(messageId || '').trim()
  if (cleanMessageId) stored.messageId = cleanMessageId
  return stored
}

function confirmationMessagesAppendExpression() {
  if (databaseDialect === 'postgres') {
    return `(
      COALESCE(NULLIF(appointment_confirmation_windows.accumulated_messages, ''), '[]')::jsonb
      || excluded.accumulated_messages::jsonb
    )::text`
  }

  return `
    CASE
      WHEN excluded.accumulated_messages = '[]' THEN
        COALESCE(NULLIF(appointment_confirmation_windows.accumulated_messages, ''), '[]')
      ELSE json_insert(
        CASE
          WHEN json_valid(appointment_confirmation_windows.accumulated_messages)
            THEN appointment_confirmation_windows.accumulated_messages
          ELSE '[]'
        END,
        '$[#]',
        json_extract(excluded.accumulated_messages, '$[0]')
      )
    END`
}

function resultForTerminalAppointment(status) {
  const normalized = String(status || '').trim().toLowerCase()
  if (['cancelled', 'canceled'].includes(normalized)) return 'cancel'
  return 'already_resolved'
}

function isClosedAppointmentStatus(status) {
  return ['cancelled', 'canceled', 'showed', 'noshow', 'invalid']
    .includes(String(status || '').trim().toLowerCase())
}

async function finishClaimedWindow({
  windowId,
  revision,
  result,
  resultDetail = '',
  expectedStatus = 'processing'
}) {
  const timestamp = nowIso()
  return db.run(`
    UPDATE appointment_confirmation_windows
    SET status = 'done',
        result = ?,
        result_detail = ?,
        processed_at = ?,
        updated_at = ?
    WHERE id = ?
      AND status = ?
      AND message_revision = ?
  `, [
    result,
    String(resultDetail || '').slice(0, 500),
    timestamp,
    timestamp,
    windowId,
    expectedStatus,
    revision
  ])
}

async function markConfirmationSendConfirmed(sendId) {
  const id = String(sendId || '').trim()
  if (!id) return
  const timestamp = nowIso()
  await db.run(`
    UPDATE appointment_reminder_sends
    SET confirmation_timeout_status = 'confirmed',
        confirmation_timeout_processed_at = ?
    WHERE id = ?
      AND confirmation_timeout_status = 'pending'
  `, [timestamp, id])
}

async function markConfirmationSendResponded(sendId) {
  const id = String(sendId || '').trim()
  if (!id) return
  const timestamp = nowIso()
  await db.run(`
    UPDATE appointment_reminder_sends
    SET confirmation_timeout_status = 'responded',
        confirmation_timeout_processed_at = ?
    WHERE id = ?
      AND confirmation_timeout_status = 'pending'
  `, [timestamp, id])
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
export async function handleInboundForConfirmation({
  contactId,
  text,
  receivedAt,
  messageId
} = {}) {
  const id = String(contactId || '').trim()
  if (!id) return { windowActive: false }

  const now = nowIso()
  const storedMessage = buildStoredMessage({
    text,
    receivedAt,
    messageId,
    fallbackReceivedAt: now
  })

  const activeWindow = await db.transaction(async (transaction) => {
    // El mismo envío se bloquea al recibir y al vencer el ultimátum. Así una
    // respuesta y una cancelación no pueden ganar simultáneamente.
    const pending = await transaction.get(`
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
        AND LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN (
          'cancelled', 'canceled', 'showed', 'noshow', 'invalid'
        )
      ORDER BY s.sent_at DESC
      LIMIT 1
      ${databaseDialect === 'postgres' ? 'FOR UPDATE OF s' : ''}
    `, [id, now])

    if (!pending) return null

    const bypassAutomations = Number(pending.bypass_automations || 0) === 1

    // Una sola escritura atómica crea o agrega el mensaje. Antes se hacía
    // SELECT + UPDATE/UPSERT y dos mensajes entregados en el mismo lote podían
    // leer el mismo arreglo y sobrescribirse entre sí.
    await transaction.run(`
      INSERT INTO appointment_confirmation_windows
        (id, contact_id, appointment_id, reminder_send_id, status,
         accumulated_messages, message_revision, bypass_automations,
         confirmation_success_action, last_message_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'waiting', ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(contact_id, appointment_id) DO UPDATE SET
        reminder_send_id = excluded.reminder_send_id,
        status = 'waiting',
        accumulated_messages = ${confirmationMessagesAppendExpression()},
        message_revision = COALESCE(appointment_confirmation_windows.message_revision, 0) + 1,
        bypass_automations = excluded.bypass_automations,
        confirmation_success_action = excluded.confirmation_success_action,
        last_message_at = excluded.last_message_at,
        updated_at = excluded.updated_at
    `, [
      makeWindowId(), id, pending.appointment_id, pending.send_id,
      JSON.stringify(storedMessage ? [storedMessage] : []),
      bypassAutomations ? 1 : 0,
      serializeConfirmationSuccessActions(
        pending.confirmation_success_action,
        LEGACY_CONFIRMATION_SUCCESS_ACTIONS
      ),
      now, now, now
    ])
    return {
      appointmentId: pending.appointment_id,
      bypassAutomations
    }
  })

  if (!activeWindow) return { windowActive: false }
  logger.info(`[Confirmación IA] Respuesta acumulada para contacto ${id}, cita ${activeWindow.appointmentId}`)

  return { windowActive: true, bypassAutomations: activeWindow.bypassAutomations }
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
      const outcome = await processConfirmationWindow(win, cutoff)
      if (outcome?.processed) processed += 1
    } catch (error) {
      logger.error(`[Confirmación IA] Error procesando ventana ${win.id}: ${error.message}`)
      await db.run(`
        UPDATE appointment_confirmation_windows
        SET status = 'error', result_detail = ?, updated_at = ?
        WHERE id = ? AND status IN ('processing', 'deciding')
      `, [error.message.slice(0, 500), nowIso(), win.id])
    }
  }

  return { processed }
}

async function notifyConfirmationTimeoutReview(outcome) {
  const contactName = String(outcome.contactName || 'Contacto').trim()
  const appointmentTitle = String(outcome.appointmentTitle || 'cita').trim()
  await sendAppointmentConfirmationNotification({
    id: outcome.appointmentId,
    calendar_id: outcome.calendarId,
    contact_id: outcome.contactId
  }, {
    appointmentId: outcome.appointmentId,
    calendarId: outcome.calendarId,
    contactId: outcome.contactId,
    contactName,
    notificationTitle: `Confirmación pendiente de revisión: ${contactName}`,
    notificationBody: `Se conservó "${appointmentTitle}" porque Ristak no pudo resolver la respuesta con seguridad.`,
    notificationTag: `confirmation-timeout-review-${outcome.appointmentId}`
  }).catch(error => {
    logger.warn(`[Confirmación IA] No se pudo avisar la revisión del plazo: ${error.message}`)
  })
}

async function notifyConfirmationTimeoutCancellation(outcome) {
  const contactName = String(outcome.contactName || 'Contacto').trim()
  const appointmentTitle = String(outcome.appointmentTitle || 'cita').trim()
  await sendAppointmentConfirmationNotification({
    id: outcome.appointmentId,
    calendar_id: outcome.calendarId,
    contact_id: outcome.contactId
  }, {
    appointmentId: outcome.appointmentId,
    calendarId: outcome.calendarId,
    contactId: outcome.contactId,
    contactName,
    notificationTitle: `Cita cancelada por falta de confirmación: ${contactName}`,
    notificationBody: `"${appointmentTitle}" se canceló al vencer el plazo configurado sin una confirmación clara.`,
    notificationTag: `confirmation-timeout-cancelled-${outcome.appointmentId}`
  }).catch(error => {
    logger.warn(`[Confirmación IA] No se pudo avisar la cancelación por plazo: ${error.message}`)
  })
}

async function notifyConfirmationTimeoutPreserved(outcome) {
  const contactName = String(outcome.contactName || 'Contacto').trim()
  const appointmentTitle = String(outcome.appointmentTitle || 'cita').trim()
  await sendAppointmentConfirmationNotification({
    id: outcome.appointmentId,
    calendar_id: outcome.calendarId,
    contact_id: outcome.contactId
  }, {
    appointmentId: outcome.appointmentId,
    calendarId: outcome.calendarId,
    contactId: outcome.contactId,
    contactName,
    notificationTitle: `Confirmación no recibida: ${contactName}`,
    notificationBody: `Venció el plazo de "${appointmentTitle}" sin confirmación; la cita se conservó.`,
    notificationTag: `confirmation-timeout-preserved-${outcome.appointmentId}`
  }).catch(error => {
    logger.warn(`[Confirmación IA] No se pudo avisar el plazo vencido: ${error.message}`)
  })
}

async function processConfirmationTimeout(sendId, currentTime) {
  return db.transaction(async (transaction) => {
    const send = await transaction.get(`
      SELECT
        s.id,
        s.appointment_id,
        s.contact_id,
        s.confirmation_deadline_at,
        s.confirmation_timeout_status,
        r.no_confirm_action,
        r.calendar_id AS reminder_calendar_id,
        a.title,
        a.calendar_id,
        a.start_time,
        a.appointment_status,
        a.status AS legacy_status,
        a.deleted_at,
        c.first_name,
        c.full_name
      FROM appointment_reminder_sends s
      JOIN appointment_reminders r ON r.id = s.reminder_id
      JOIN appointments a ON a.id = s.appointment_id
      LEFT JOIN contacts c ON c.id = s.contact_id
      WHERE s.id = ?
      ${databaseDialect === 'postgres' ? 'FOR UPDATE OF s' : ''}
    `, [sendId])

    if (
      !send ||
      send.confirmation_timeout_status !== 'pending' ||
      !send.confirmation_deadline_at ||
      new Date(send.confirmation_deadline_at).getTime() > new Date(currentTime).getTime()
    ) {
      return { processed: false }
    }

    // Una confirmación creada antes del alcance por calendario pudo quedar
    // ligada a una cita ajena. Nunca ejecutes su acción diferida (en especial
    // cancelar): se desactiva al detectarla y se conserva la fila como auditoría.
    const reminderCalendarId = String(send.reminder_calendar_id || '').trim()
    const appointmentCalendarId = String(send.calendar_id || '').trim()
    if (!reminderCalendarId || !appointmentCalendarId || reminderCalendarId !== appointmentCalendarId) {
      await transaction.run(`
        UPDATE appointment_reminder_sends
        SET confirmation_timeout_status = 'disabled',
            confirmation_timeout_processed_at = ?
        WHERE id = ? AND confirmation_timeout_status = 'pending'
      `, [currentTime, sendId])
      return { processed: true, status: 'disabled' }
    }

    const confirmationWindow = await transaction.get(`
      SELECT status, result, result_detail
      FROM appointment_confirmation_windows
      WHERE reminder_send_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `, [sendId])

    if (['waiting', 'processing', 'deciding'].includes(String(confirmationWindow?.status || ''))) {
      return { processed: false, deferred: true }
    }

    const appointmentStatus = String(send.appointment_status || send.legacy_status || '').toLowerCase()
    const appointmentStarted = new Date(send.start_time).getTime() <= new Date(currentTime).getTime()
    const repliedConfirmed = confirmationWindow?.status === 'done' &&
      confirmationWindow?.result === 'confirmed'

    if (repliedConfirmed) {
      await transaction.run(`
        UPDATE appointment_reminder_sends
        SET confirmation_timeout_status = 'confirmed',
            confirmation_timeout_processed_at = ?
        WHERE id = ? AND confirmation_timeout_status = 'pending'
      `, [currentTime, sendId])
      return { processed: true, status: 'confirmed' }
    }

    const terminal = send.deleted_at ||
      isClosedAppointmentStatus(appointmentStatus) ||
      appointmentStarted

    if (terminal) {
      const terminalTimeoutStatus = appointmentStarted
        ? 'expired'
        : 'already_resolved'
      await transaction.run(`
        UPDATE appointment_reminder_sends
        SET confirmation_timeout_status = ?,
            confirmation_timeout_processed_at = ?
        WHERE id = ? AND confirmation_timeout_status = 'pending'
      `, [terminalTimeoutStatus, currentTime, sendId])
      return { processed: true, status: terminalTimeoutStatus }
    }

    const needsSafeReview = confirmationWindow?.status === 'error' ||
      ['ambiguous', 'human_needed'].includes(String(confirmationWindow?.result || ''))
    if (needsSafeReview) {
      await transaction.run(`
        UPDATE appointment_reminder_sends
        SET confirmation_timeout_status = 'review_required',
            confirmation_timeout_processed_at = ?
        WHERE id = ? AND confirmation_timeout_status = 'pending'
      `, [currentTime, sendId])
      return {
        processed: true,
        status: 'review_required',
        appointmentId: send.appointment_id,
        contactId: send.contact_id,
        calendarId: send.calendar_id,
        appointmentTitle: send.title,
        contactName: send.first_name || send.full_name
      }
    }

    const configuredAction = String(send.no_confirm_action || '').trim()
    const shouldCancel = configuredAction === 'cancel_appointment'
    if (!shouldCancel) {
      await transaction.run(`
        UPDATE appointment_reminder_sends
        SET confirmation_timeout_status = 'preserved',
            confirmation_timeout_processed_at = ?
        WHERE id = ? AND confirmation_timeout_status = 'pending'
      `, [currentTime, sendId])
      return {
        processed: true,
        status: 'preserved',
        appointmentId: send.appointment_id,
        contactId: send.contact_id,
        calendarId: send.calendar_id,
        appointmentTitle: send.title,
        contactName: send.first_name || send.full_name
      }
    }

    const cancelled = await transaction.run(`
      UPDATE appointments
      SET appointment_status = 'cancelled',
          status = 'cancelled',
          date_updated = CURRENT_TIMESTAMP
      WHERE id = ?
        AND deleted_at IS NULL
        AND start_time > ?
        AND LOWER(COALESCE(appointment_status, status, '')) NOT IN (
          'cancelled', 'canceled', 'showed', 'noshow', 'invalid'
        )
    `, [send.appointment_id, currentTime])

    const didCancel = Number(cancelled?.changes || 0) > 0
    await transaction.run(`
      UPDATE appointment_reminder_sends
      SET confirmation_timeout_status = ?,
          confirmation_timeout_processed_at = ?
      WHERE id = ? AND confirmation_timeout_status = 'pending'
    `, [didCancel ? 'cancelled' : 'already_resolved', currentTime, sendId])

    return {
      processed: true,
      status: didCancel ? 'cancelled' : 'already_resolved',
      appointmentId: send.appointment_id,
      contactId: send.contact_id,
      calendarId: send.calendar_id,
      appointmentTitle: send.title,
      contactName: send.first_name || send.full_name,
      previousStatus: appointmentStatus || null
    }
  })
}

/**
 * Aplica la acción configurada cuando vence el plazo que empezó al completar
 * el mensaje de confirmación. Cada envío guarda su deadline inmutable para que
 * editar el recordatorio después no cambie plazos ya enviados.
 */
export async function processExpiredConfirmationTimeouts({ batchSize = 50 } = {}) {
  const currentTime = nowIso()
  const sends = await db.all(`
    SELECT id
    FROM appointment_reminder_sends
    WHERE status = 'sent'
      AND confirmation_timeout_status = 'pending'
      AND confirmation_deadline_at <= ?
    ORDER BY confirmation_deadline_at ASC, id ASC
    LIMIT ?
  `, [currentTime, batchSize])

  let processed = 0
  let cancelled = 0
  let preserved = 0
  let reviewRequired = 0

  for (const send of sends) {
    try {
      const outcome = await processConfirmationTimeout(send.id, currentTime)
      if (!outcome?.processed) continue
      processed += 1
      if (outcome.status === 'cancelled') {
        cancelled += 1
        publishAppointmentChanged(outcome.contactId, outcome.appointmentId)
        await resyncAppointmentToGoogle(outcome.appointmentId)
        await dispatchAppointmentStatusAutomation(outcome.appointmentId, {
          previousStatus: outcome.previousStatus,
          previousAppointmentId: outcome.appointmentId,
          appointmentChange: 'cancelled'
        })
        await notifyConfirmationTimeoutCancellation(outcome)
        logger.info(`[Confirmación IA] Cita ${outcome.appointmentId} cancelada al vencer el plazo sin confirmación`)
      } else if (outcome.status === 'review_required') {
        reviewRequired += 1
        await notifyConfirmationTimeoutReview(outcome)
        logger.warn(`[Confirmación IA] El plazo de la cita ${outcome.appointmentId} terminó en revisión segura; no se canceló`)
      } else if (outcome.status === 'preserved') {
        preserved += 1
        await notifyConfirmationTimeoutPreserved(outcome)
        logger.info(`[Confirmación IA] La cita ${outcome.appointmentId} se conservó al vencer el plazo sin confirmación`)
      }
    } catch (error) {
      logger.error(`[Confirmación IA] Error procesando plazo del envío ${send.id}: ${error.message}`)
    }
  }

  return { processed, cancelled, preserved, reviewRequired }
}

async function processConfirmationWindow(candidate, cutoff) {
  const candidateRevision = Number(candidate.message_revision || 0)

  // Reclamar exactamente la revisión que venció. Si entró otro mensaje desde
  // que el cron hizo el SELECT, cambió la revisión y se vuelve a esperar.
  const updated = await db.run(`
    UPDATE appointment_confirmation_windows
    SET status = 'processing', updated_at = ?
    WHERE id = ?
      AND status = 'waiting'
      AND message_revision = ?
      AND last_message_at <= ?
  `, [nowIso(), candidate.id, candidateRevision, cutoff])

  if (!updated || updated.changes === 0) return { processed: false, deferred: true }

  // Leer después del claim evita clasificar el snapshot viejo del SELECT inicial.
  const win = await db.get(`
    SELECT *
    FROM appointment_confirmation_windows
    WHERE id = ? AND status = 'processing' AND message_revision = ?
  `, [candidate.id, candidateRevision])
  if (!win) return { processed: false, deferred: true }

  const revision = Number(win.message_revision || 0)
  const storedMessages = parseStoredMessages(win.accumulated_messages)
  const messages = storedMessages.map(entry => entry.text)
  const contactId = String(win.contact_id || '')
  const appointmentId = String(win.appointment_id || '')

  // Obtener datos del recordatorio para la acción configurada.
  const reminderData = await db.get(`
    SELECT
      r.no_confirm_action,
      r.bypass_automations,
      r.confirmation_success_action,
      r.confirmation_reply_text,
      s.confirmation_reply_sent_at,
      c.phone,
      c.first_name
    FROM appointment_reminder_sends s
    JOIN appointment_reminders r ON r.id = s.reminder_id
    JOIN contacts c ON c.id = s.contact_id
    WHERE s.id = ?
  `, [win.reminder_send_id])

  const appointmentState = await db.get(`
    SELECT appointment_status, status, start_time
    FROM appointments
    WHERE id = ? AND deleted_at IS NULL
  `, [appointmentId])
  const currentAppointmentStatus = appointmentState?.appointment_status || appointmentState?.status
  const appointmentStart = appointmentState?.start_time ? new Date(appointmentState.start_time) : null
  const appointmentExpired = appointmentStart && !Number.isNaN(appointmentStart.getTime()) && appointmentStart <= new Date()

  if (!appointmentState || isClosedAppointmentStatus(currentAppointmentStatus) || appointmentExpired) {
    const priorResult = String(win.result || '').trim()
    const terminalResult = priorResult || (
      appointmentExpired
        ? 'appointment_started'
        : resultForTerminalAppointment(currentAppointmentStatus)
    )
    const terminalDetail = String(win.result_detail || '').trim() || (
      appointmentExpired
        ? 'La cita ya comenzó; la respuesta no produjo acciones automáticas.'
        : 'La cita ya tenía un estado final; no se repitieron acciones automáticas.'
    )
    const finished = await finishClaimedWindow({
      windowId: win.id,
      revision,
      result: terminalResult,
      resultDetail: terminalDetail
    })
    return { processed: Number(finished?.changes || 0) > 0 }
  }

  // Si no hay mensajes acumulados, cerrar la ventana sin acción.
  if (!messages.length) {
    const finished = await finishClaimedWindow({
      windowId: win.id,
      revision,
      result: 'no_response'
    })
    if (Number(finished?.changes || 0) > 0) {
      logger.info(`[Confirmación IA] Ventana ${win.id} cerrada sin texto clasificable`)
    }
    return { processed: Number(finished?.changes || 0) > 0 }
  }

  // Clasificar la respuesta con el agente IA.
  const classification = await classifyConfirmationResponse({ accumulatedMessages: messages })

  // IMPORTANTE (NOTI-001): distinguir una FALLA TÉCNICA del clasificador
  // (classification === null: sin API key de OpenAI, error de red, timeout o
  // JSON inválido) de una clasificación real 'ambiguous'. Ante una falla técnica
  // jamás tomamos una acción destructiva (cancelar la cita): el cliente pudo haber
  // confirmado y un hipo de un tercero no debe borrar su cita.
  const classifierFailed = !classification
  const result = classifierFailed ? 'human_needed' : (classification.result || 'ambiguous')
  const resultDetail = classifierFailed
    ? 'Clasificador IA no disponible (sin API key, error o timeout): se requiere revisión humana; no se ejecutó ninguna acción destructiva.'
    : (classification.reason || '')

  logger.info(`[Confirmación IA] Contacto ${contactId}, cita ${appointmentId}: ${result} (${resultDetail})`)

  // Reservar la decisión sólo si ningún mensaje llegó mientras el modelo
  // clasificaba. El inbound concurrente cambia status a waiting y revision +1.
  const decisionClaim = await db.run(`
    UPDATE appointment_confirmation_windows
    SET status = 'deciding',
        result = ?,
        result_detail = ?,
        updated_at = ?
    WHERE id = ?
      AND status = 'processing'
      AND message_revision = ?
  `, [result, resultDetail.slice(0, 500), nowIso(), win.id, revision])
  if (!decisionClaim || decisionClaim.changes === 0) {
    logger.info(`[Confirmación IA] Ventana ${win.id} recibió otro mensaje durante la clasificación; se difiere la acción`)
    return { processed: false, deferred: true }
  }

  // Ejecutar la acción según la clasificación.
  if (result === 'confirmed') {
    await db.run(`
      UPDATE appointments
      SET appointment_status = 'confirmed', status = 'confirmed', date_updated = CURRENT_TIMESTAMP
      WHERE id = ? AND LOWER(COALESCE(appointment_status, status, '')) NOT IN ('confirmed')
    `, [appointmentId])
    publishAppointmentChanged(contactId, appointmentId)
    await resyncAppointmentToGoogle(appointmentId)
    const confirmedAppointment = await executeConfirmationSuccessActions({
      contactId,
      appointmentId,
      actions: normalizeConfirmationSuccessActions(
        win.confirmation_success_action || reminderData?.confirmation_success_action,
        LEGACY_CONFIRMATION_SUCCESS_ACTIONS
      ),
      resultDetail,
      reminderData
    })
    await sendConfiguredConfirmationReply({
      windowId: win.id,
      reminderSendId: win.reminder_send_id,
      contactId,
      appointmentId,
      confirmationReplyText: reminderData?.confirmation_reply_text,
      storedMessages,
      appointment: confirmedAppointment,
      reminderData
    }).then(outcome => {
      if (outcome?.sent) {
        logger.info(`[Confirmación IA] Mensaje de respuesta enviado por WhatsApp para cita ${appointmentId}`)
      } else if (String(reminderData?.confirmation_reply_text || '').trim()) {
        logger.info(`[Confirmación IA] Mensaje de respuesta omitido para cita ${appointmentId}: ${outcome?.reason || 'ruta no disponible'}`)
      }
    }).catch(error => {
      // La cortesía de cierre es secundaria: una falla de WhatsApp nunca puede
      // revertir la confirmación real ni dejar la ventana en error.
      logger.warn(`[Confirmación IA] No se pudo enviar el mensaje de respuesta para cita ${appointmentId}: ${error.message}`)
    })
    logger.info(`[Confirmación IA] Cita ${appointmentId} confirmada automáticamente`)
  } else {
    // Para reschedule, cancel, ambiguous, human_needed → ejecutar la acción del recordatorio.
    // EXCEPCIÓN de seguridad (NOTI-001): si el clasificador falló técnicamente, nunca
    // ejecutamos una acción destructiva; conservamos la cita y avisamos para revisión.
    // Seguridad (NOTI-001, extendido): NUNCA cancelamos destructivamente ante
    // INCERTIDUMBRE. 'cancel_appointment' sólo procede con una señal de que la persona
    // no asistirá (reschedule/cancel explícitos). Si el clasificador falló técnicamente,
    // o el resultado fue 'ambiguous' o 'human_needed' (p. ej. la persona sólo preguntó
    // algo logístico como "¿dónde es?"), conservamos la cita y dejamos que el push
    // global de confirmaciones avise para revisión humana.
    const configuredAction = String(reminderData?.no_confirm_action || 'no_action')
    const uncertainResult = classifierFailed || result === 'ambiguous' || result === 'human_needed'
    const noConfirmAction = uncertainResult && configuredAction === 'cancel_appointment'
      ? 'no_action'
      : configuredAction === 'notify_push'
        ? 'no_action'
        : configuredAction
    if (uncertainResult && configuredAction === 'cancel_appointment') {
      logger.warn(`[Confirmación IA] Resultado incierto (${result}) para cita ${appointmentId}: se OMITE la cancelación automática y se avisa para revisión humana.`)
    }
    await executeNoConfirmAction({
      contactId,
      appointmentId,
      action: noConfirmAction,
      result,
      resultDetail,
      reminderData
    })
  }

  const finished = await finishClaimedWindow({
    windowId: win.id,
    revision,
    result,
    resultDetail,
    expectedStatus: 'deciding'
  })
  const processed = Number(finished?.changes || 0) > 0
  if (processed && result === 'confirmed') {
    await markConfirmationSendConfirmed(win.reminder_send_id)
  } else if (processed && ['cancel', 'reschedule'].includes(result)) {
    await markConfirmationSendResponded(win.reminder_send_id)
  }
  return {
    processed,
    deferred: !processed
  }
}

async function sendConfiguredConfirmationReply({
  windowId,
  reminderSendId,
  contactId,
  appointmentId,
  confirmationReplyText,
  storedMessages,
  appointment,
  reminderData
}) {
  const configuredText = String(confirmationReplyText || '').trim()
  if (!configuredText) return { sent: false, reason: 'sin mensaje configurado' }
  if (reminderData?.confirmation_reply_sent_at) {
    return { sent: false, reason: 'el mensaje ya se envió' }
  }
  if (configuredText.length > MAX_CONFIRMATION_REPLY_TEXT_LENGTH) {
    return { sent: false, reason: 'el texto supera el límite permitido' }
  }

  const latestMessage = [...(Array.isArray(storedMessages) ? storedMessages : [])]
    .reverse()
    .find(entry => String(entry?.messageId || '').trim())
  if (!latestMessage) return { sent: false, reason: 'la respuesta no tiene identidad de mensaje' }

  // La respuesta sólo sale si el último inbound que confirmó la cita pertenece
  // a la tubería nativa de WhatsApp. Así no desviamos confirmaciones de correo,
  // Instagram, Messenger o HighLevel hacia un teléfono por accidente.
  const inbound = await db.get(`
    SELECT
      id,
      business_phone_number_id,
      phone,
      from_phone,
      to_phone,
      business_phone,
      transport
    FROM whatsapp_api_messages
    WHERE id = ?
      AND contact_id = ?
      AND LOWER(COALESCE(direction, '')) = 'inbound'
    LIMIT 1
  `, [latestMessage.messageId, contactId])
  if (!inbound) return { sent: false, reason: 'la confirmación llegó por otro canal' }

  const destinationPhone = String(inbound.from_phone || inbound.phone || reminderData?.phone || '').trim()
  if (!destinationPhone) return { sent: false, reason: 'la respuesta no tiene teléfono destino' }

  const businessPhone = String(inbound.to_phone || inbound.business_phone || '').trim()
  const timezone = await getAccountTimezone()
  const renderedText = renderMessageText(configuredText, {
    contact: {
      id: contactId,
      first_name: appointment?.first_name || reminderData?.first_name,
      last_name: appointment?.last_name,
      full_name: appointment?.full_name,
      phone: destinationPhone
    },
    appointment: appointment || { id: appointmentId },
    timezone
  })
  if (!renderedText) return { sent: false, reason: 'el texto quedó vacío al renderizarse' }

  const sendText = confirmationReplySenderForTest || (await import('./whatsappApiService.js'))
    .sendWhatsAppApiTextMessage
  const response = await sendText({
    to: destinationPhone,
    text: renderedText,
    from: businessPhone || undefined,
    contactId,
    phoneNumberId: inbound.business_phone_number_id || undefined,
    transport: String(inbound.transport || '').toLowerCase() === 'qr' ? 'qr' : 'api',
    allowQrFallback: true,
    preferOfficialApiWhenReplyWindowOpen: true,
    externalId: `appointment_confirmation_reply_${reminderSendId || windowId}`,
    variablesResolved: true
  })

  const messageId = response?.localMessageId || response?.id || null
  await db.run(`
    UPDATE appointment_reminder_sends
    SET confirmation_reply_sent_at = ?,
        confirmation_reply_message_id = ?
    WHERE id = ?
      AND confirmation_reply_sent_at IS NULL
  `, [nowIso(), messageId, reminderSendId])

  return {
    sent: true,
    messageId
  }
}

async function executeConfirmationSuccessActions({ contactId, appointmentId, actions, resultDetail, reminderData }) {
  const normalizedActions = normalizeConfirmationSuccessActions(
    actions,
    LEGACY_CONFIRMATION_SUCCESS_ACTIONS
  )
  const appointment = await db.get(`
    SELECT
      a.id,
      a.title,
      a.start_time,
      a.calendar_id,
      a.contact_id,
      c.first_name,
      c.last_name,
      c.full_name,
      c.phone
    FROM appointments a
    LEFT JOIN contacts c ON c.id = a.contact_id
    WHERE a.id = ?
  `, [appointmentId])

  const contactName = String(appointment?.first_name || appointment?.full_name || reminderData?.first_name || 'Contacto').trim()
  const appointmentTitle = String(appointment?.title || 'cita').trim()

  if (normalizedActions.includes('chat_badge')) {
    await db.run(`
      UPDATE appointments
      SET confirmation_badge_until = COALESCE(start_time, ?), date_updated = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), appointmentId])
    publishAppointmentChanged(contactId, appointmentId)
    logger.info(`[Confirmación IA] Etiqueta visual temporal activada para cita ${appointmentId}`)
  }

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
  logger.info(`[Confirmación IA] Notificación de confirmación procesada para cita ${appointmentId}`)

  if (normalizedActions.includes('chat_card')) {
    logger.info(`[Confirmación IA] Tarjeta de confirmación disponible en journey para cita ${appointmentId}`)
  }

  return appointment
}

async function executeNoConfirmAction({ contactId, appointmentId, action, result, resultDetail, reminderData }) {
  const appointment = await db.get(`
    SELECT a.id, a.title, a.start_time, a.calendar_id, a.appointment_status, a.status, c.first_name, c.full_name
    FROM appointments a
    LEFT JOIN contacts c ON c.id = a.contact_id
    WHERE a.id = ?
  `, [appointmentId])

  if (action === 'cancel_appointment') {
    const previousStatus = String(appointment?.appointment_status || appointment?.status || '').trim().toLowerCase()
    const cancelled = await db.run(`
      UPDATE appointments
      SET appointment_status = 'cancelled', status = 'cancelled', date_updated = CURRENT_TIMESTAMP
      WHERE id = ?
        AND LOWER(COALESCE(appointment_status, status, '')) NOT IN ('cancelled', 'canceled')
    `, [appointmentId])
    if (Number(cancelled?.changes || 0) > 0) {
      publishAppointmentChanged(contactId, appointmentId)
      await resyncAppointmentToGoogle(appointmentId)
      await dispatchAppointmentStatusAutomation(appointmentId, {
        previousStatus: previousStatus || null,
        previousAppointmentId: appointmentId,
        appointmentChange: 'cancelled'
      })
      logger.info(`[Confirmación IA] Cita ${appointmentId} cancelada por acción automática (resultado: ${result})`)
    }
  }

  const resultLabels = {
    reschedule: 'quiere reagendar',
    cancel: 'canceló',
    ambiguous: 'dio una respuesta ambigua',
    human_needed: 'requiere atención humana'
  }
  const label = resultLabels[result] || 'no confirmó'
  const contactName = String(appointment?.first_name || appointment?.full_name || reminderData?.first_name || 'Contacto').trim()
  const appointmentTitle = String(appointment?.title || 'cita').trim()
  await sendAppointmentConfirmationNotification(appointment || { id: appointmentId, contactId }, {
    appointmentId,
    contactId,
    contactName,
    calendarId: appointment?.calendar_id,
    startTime: appointment?.start_time,
    notificationTitle: `Confirmación de cita: ${contactName} ${label}`,
    notificationBody: `${contactName} respondió sobre "${appointmentTitle}". ${resultDetail || ''}`.trim(),
    notificationTag: `confirmation-response-${appointmentId}`
  }).catch(error => {
    logger.warn(`[Confirmación IA] No se pudo enviar notificación push: ${error.message}`)
  })
  logger.info(`[Confirmación IA] Notificación de respuesta procesada para cita ${appointmentId} (resultado: ${result})`)
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
    SELECT
      s.id AS send_id,
      s.appointment_id,
      a.title,
      a.start_time,
      a.calendar_id,
      c.first_name,
      c.full_name
    FROM appointment_reminder_sends s
    JOIN appointments a ON a.id = s.appointment_id
    LEFT JOIN contacts c ON c.id = s.contact_id
    WHERE s.contact_id = ?
      AND s.status = 'sent'
      AND s.message_type = 'confirmation'
      AND s.ai_enabled = 0
      AND a.deleted_at IS NULL
      AND a.start_time > ?
      AND LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN (
        'cancelled', 'canceled', 'showed', 'noshow', 'invalid'
      )
    ORDER BY s.sent_at DESC
    LIMIT 1
  `, [id, new Date().toISOString()])

  if (!pending) return null

  await db.run(`
    UPDATE appointments
    SET appointment_status = 'confirmed', status = 'confirmed', date_updated = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [pending.appointment_id])
  await markConfirmationSendConfirmed(pending.send_id)
  publishAppointmentChanged(id, pending.appointment_id)
  await resyncAppointmentToGoogle(pending.appointment_id)
  await sendAppointmentConfirmationNotification({
    id: pending.appointment_id,
    title: pending.title,
    start_time: pending.start_time,
    calendar_id: pending.calendar_id,
    contact_id: id,
    first_name: pending.first_name,
    full_name: pending.full_name
  }, {
    appointmentId: pending.appointment_id,
    contactId: id,
    contactName: pending.first_name || pending.full_name,
    calendarId: pending.calendar_id,
    startTime: pending.start_time
  }).catch(error => {
    logger.warn(`[Citas] No se pudo enviar push de confirmación sin IA: ${error.message}`)
  })

  logger.info(`[Citas] Respuesta afirmativa confirmó la cita ${pending.appointment_id} para el contacto ${id}`)
  return { appointmentId: pending.appointment_id }
}
