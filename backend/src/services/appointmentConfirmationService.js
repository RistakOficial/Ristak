import { db, databaseDialect } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { isAffirmativeReply } from './appointmentReminderLogic.js'
import { classifyConfirmationResponse } from '../agents/appointmentConfirmationAgent.js'
import { sendAppNotificationPayload, sendAppointmentConfirmationNotification } from './pushNotificationsService.js'
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

function parseMessages(raw) {
  try {
    const parsed = JSON.parse(raw || '[]')
    if (!Array.isArray(parsed)) return []

    return parsed
      .map((entry, index) => {
        if (typeof entry === 'string') {
          return { text: entry.trim(), receivedAtMs: null, index }
        }

        const text = String(entry?.text || '').trim()
        const receivedAtMs = new Date(entry?.receivedAt || '').getTime()
        return {
          text,
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
      .map(entry => entry.text)
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
  if (normalized === 'confirmed') return 'confirmed'
  if (['cancelled', 'canceled'].includes(normalized)) return 'cancel'
  return 'already_resolved'
}

function isTerminalAppointmentStatus(status) {
  return ['confirmed', 'cancelled', 'canceled', 'showed', 'noshow', 'invalid']
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
        AND LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN ('confirmed', 'cancelled', 'canceled')
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
  await sendAppNotificationPayload({
    title: `Confirmación pendiente de revisión: ${contactName}`,
    body: `No se canceló "${appointmentTitle}" porque Ristak no pudo resolver la respuesta con seguridad.`.slice(0, 160),
    tag: `confirmation-timeout-review-${outcome.appointmentId}`,
    url: `/movil/calendar?open=appointment&id=${encodeURIComponent(outcome.appointmentId)}`
  }).catch(error => {
    logger.warn(`[Confirmación IA] No se pudo avisar la revisión del plazo: ${error.message}`)
  })
}

async function notifyConfirmationTimeoutCancellation(outcome) {
  const contactName = String(outcome.contactName || 'Contacto').trim()
  const appointmentTitle = String(outcome.appointmentTitle || 'cita').trim()
  await sendAppNotificationPayload({
    title: `Cita cancelada por falta de confirmación: ${contactName}`,
    body: `"${appointmentTitle}" se canceló al vencer el plazo configurado sin una confirmación clara.`.slice(0, 160),
    tag: `confirmation-timeout-cancelled-${outcome.appointmentId}`,
    url: `/movil/calendar?open=appointment&id=${encodeURIComponent(outcome.appointmentId)}`
  }).catch(error => {
    logger.warn(`[Confirmación IA] No se pudo avisar la cancelación por plazo: ${error.message}`)
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
        a.title,
        a.start_time,
        a.appointment_status,
        a.status AS legacy_status,
        a.deleted_at,
        c.first_name,
        c.full_name
      FROM appointment_reminder_sends s
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
    const terminal = send.deleted_at ||
      isTerminalAppointmentStatus(appointmentStatus) ||
      appointmentStarted

    if (terminal) {
      const terminalTimeoutStatus = appointmentStatus === 'confirmed'
        ? 'confirmed'
        : appointmentStarted
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
      confirmationWindow?.result === 'human_needed'
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
          'confirmed', 'cancelled', 'canceled', 'showed', 'noshow', 'invalid'
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
      appointmentTitle: send.title,
      contactName: send.first_name || send.full_name
    }
  })
}

/**
 * Cancela citas pendientes cuando vence el plazo que empezó al completar el
 * mensaje de confirmación. Cada envío guarda su deadline inmutable para que
 * editar el recordatorio después no cambie ultimátums ya enviados.
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
        await notifyConfirmationTimeoutCancellation(outcome)
        logger.info(`[Confirmación IA] Cita ${outcome.appointmentId} cancelada al vencer el plazo sin confirmación`)
      } else if (outcome.status === 'review_required') {
        reviewRequired += 1
        await notifyConfirmationTimeoutReview(outcome)
        logger.warn(`[Confirmación IA] El plazo de la cita ${outcome.appointmentId} terminó en revisión segura; no se canceló`)
      }
    } catch (error) {
      logger.error(`[Confirmación IA] Error procesando plazo del envío ${send.id}: ${error.message}`)
    }
  }

  return { processed, cancelled, reviewRequired }
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

  const appointmentState = await db.get(`
    SELECT appointment_status, status, start_time
    FROM appointments
    WHERE id = ? AND deleted_at IS NULL
  `, [appointmentId])
  const currentAppointmentStatus = appointmentState?.appointment_status || appointmentState?.status
  const appointmentStart = appointmentState?.start_time ? new Date(appointmentState.start_time) : null
  const appointmentExpired = appointmentStart && !Number.isNaN(appointmentStart.getTime()) && appointmentStart <= new Date()

  if (!appointmentState || isTerminalAppointmentStatus(currentAppointmentStatus) || appointmentExpired) {
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
    await executeConfirmationSuccessActions({
      contactId,
      appointmentId,
      actions: normalizeConfirmationSuccessActions(
        win.confirmation_success_action || reminderData?.confirmation_success_action,
        LEGACY_CONFIRMATION_SUCCESS_ACTIONS
      ),
      resultDetail,
      reminderData
    })
    logger.info(`[Confirmación IA] Cita ${appointmentId} confirmada automáticamente`)
  } else {
    // Para reschedule, cancel, ambiguous, human_needed → ejecutar la acción del recordatorio.
    // EXCEPCIÓN de seguridad (NOTI-001): si el clasificador falló técnicamente, nunca
    // ejecutamos una acción destructiva; degradamos 'cancel_appointment' a 'notify_push'
    // para que un humano revise sin que se cancele la cita.
    // Seguridad (NOTI-001, extendido): NUNCA cancelamos destructivamente ante
    // INCERTIDUMBRE. 'cancel_appointment' sólo procede con una señal de que la persona
    // no asistirá (reschedule/cancel explícitos). Si el clasificador falló técnicamente,
    // o el resultado fue 'ambiguous' o 'human_needed' (p. ej. la persona sólo preguntó
    // algo logístico como "¿dónde es?"), degradamos a 'notify_push' para que un humano
    // revise SIN borrar la cita de alguien que sí piensa asistir.
    const configuredAction = String(reminderData?.no_confirm_action || 'no_action')
    const uncertainResult = classifierFailed || result === 'ambiguous' || result === 'human_needed'
    const noConfirmAction = uncertainResult && configuredAction === 'cancel_appointment'
      ? 'notify_push'
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
  return {
    processed: Number(finished?.changes || 0) > 0,
    deferred: Number(finished?.changes || 0) === 0
  }
}

async function executeConfirmationSuccessActions({ contactId, appointmentId, actions, resultDetail, reminderData }) {
  const normalizedActions = normalizeConfirmationSuccessActions(
    actions,
    LEGACY_CONFIRMATION_SUCCESS_ACTIONS
  )
  const appointment = await db.get(`
    SELECT a.id, a.title, a.start_time, a.calendar_id, a.contact_id, c.first_name, c.full_name
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

  if (normalizedActions.includes('notify_push')) {
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
    logger.info(`[Confirmación IA] Notificación de confirmación enviada para cita ${appointmentId}`)
  }

  if (normalizedActions.includes('chat_card')) {
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
    publishAppointmentChanged(contactId, appointmentId)
    await resyncAppointmentToGoogle(appointmentId)
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
      url: `/movil/calendar?open=appointment&id=${encodeURIComponent(appointmentId)}`
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
      AND s.ai_enabled = 0
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
  publishAppointmentChanged(id, pending.appointment_id)
  await resyncAppointmentToGoogle(pending.appointment_id)

  logger.info(`[Citas] IA confirmó la cita ${pending.appointment_id} por respuesta del contacto ${id}`)
  return { appointmentId: pending.appointment_id }
}
