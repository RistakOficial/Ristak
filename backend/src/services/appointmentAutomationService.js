import { logger } from '../utils/logger.js'
import {
  clearAppointmentReminderSends,
  executeSafeTestAppointmentReminders
} from './appointmentRemindersService.js'

const CANCELLED_STATUSES = new Set(['cancelled', 'canceled', 'no_show', 'no-show', 'noshow', 'deleted'])

function cleanString(value) {
  return String(value ?? '').trim()
}

function appointmentValue(appointment = {}, camelCase, snakeCase) {
  return appointment[camelCase] ?? appointment[snakeCase] ?? null
}

function normalizeAppointmentStatus(appointment = {}) {
  return cleanString(
    appointmentValue(appointment, 'appointmentStatus', 'appointment_status') ||
    appointment.status
  ).toLowerCase()
}

function firstAppointmentValue(...values) {
  for (const value of values) {
    if (cleanString(value)) return value
  }
  return null
}

function buildEventData(appointment = {}, extra = {}) {
  const appointmentChange = firstAppointmentValue(
    extra.appointmentChange,
    extra.appointment_change,
    appointment.appointmentChange,
    appointment.appointment_change
  )
  const previousAppointmentId = firstAppointmentValue(
    extra.previousAppointmentId,
    extra.previous_appointment_id,
    appointment.previousAppointmentId,
    appointment.previous_appointment_id
  )
  const replacesAppointmentId = firstAppointmentValue(
    extra.replacesAppointmentId,
    extra.replaces_appointment_id,
    appointment.replacesAppointmentId,
    appointment.replaces_appointment_id
  )
  const replacementAppointmentId = firstAppointmentValue(
    extra.replacementAppointmentId,
    extra.replacement_appointment_id,
    appointment.replacementAppointmentId,
    appointment.replacement_appointment_id
  )

  return {
    contactId: appointmentValue(appointment, 'contactId', 'contact_id'),
    appointmentId: appointment.id || null,
    calendarId: appointmentValue(appointment, 'calendarId', 'calendar_id'),
    calendarName: appointmentValue(appointment, 'calendarName', 'calendar_name'),
    status: normalizeAppointmentStatus(appointment) || 'booked',
    appointmentStatus: normalizeAppointmentStatus(appointment) || 'booked',
    title: appointment.title || null,
    startTime: appointmentValue(appointment, 'startTime', 'start_time'),
    endTime: appointmentValue(appointment, 'endTime', 'end_time'),
    source: appointment.source || null,
    bookingChannel: appointmentValue(appointment, 'bookingChannel', 'booking_channel'),
    isTest: Boolean(appointmentValue(appointment, 'isTest', 'is_test')),
    testRunId: appointmentValue(appointment, 'testRunId', 'test_run_id'),
    testEffectId: appointmentValue(appointment, 'testEffectId', 'test_effect_id'),
    testExpiresAt: appointmentValue(appointment, 'testExpiresAt', 'test_expires_at'),
    ...extra,
    appointmentChange,
    previousAppointmentId,
    replacesAppointmentId,
    replacementAppointmentId
  }
}

/**
 * Dispara un evento de automatizaciones para una cita sin permitir que una
 * falla del motor de flujos rompa la reserva que ya se guardó.
 */
export async function dispatchAppointmentAutomationEvent(eventType, appointment = {}, extra = {}) {
  const eventData = buildEventData(appointment, extra)
  if (!cleanString(eventData.contactId)) return { dispatched: false, reason: 'missing_contact' }

  try {
    if (
      eventType === 'appointment-status' &&
      cleanString(eventData.appointmentChange).toLowerCase() === 'rescheduled' &&
      cleanString(eventData.appointmentId)
    ) {
      await clearAppointmentReminderSends(eventData.appointmentId).catch((error) => {
        logger.warn(`[Recordatorios] No se pudieron recalcular los envíos de la cita reprogramada ${eventData.appointmentId}: ${error.message}`)
      })
    }
    const engine = await import('./automationEngine.js')
    if (eventData.isTest) {
      const execution = await engine.executeTestAutomationEvent(eventType, eventData)
      return {
        dispatched: Number(execution.realActionCount || 0) > 0,
        executed: true,
        testMode: true,
        isolated: true,
        execution,
        // Alias temporal para consumidores ya desplegados. El contenido ya no
        // es un preview: incluye la traza real/simulada y recibos auditables.
        preview: execution
      }
    }
    await engine.handleAutomationEvent(eventType, eventData)
    return { dispatched: true }
  } catch (error) {
    logger.warn(`[Automatizaciones] No se pudo disparar ${eventType} para la cita ${eventData.appointmentId || 'sin_id'}: ${error.message}`)
    return { dispatched: false, reason: 'engine_error', error: error.message }
  }
}

/**
 * Una cita nueva puede activar tanto el disparador de cita agendada como el de
 * estado inicial (por ejemplo, confirmada). Se mantiene aquí para que las
 * rutas pública, admin y agente compartan exactamente el mismo contrato.
 */
export async function dispatchAppointmentCreatedAutomations(appointment = {}) {
  const status = normalizeAppointmentStatus(appointment)
  if (CANCELLED_STATUSES.has(status)) return { dispatched: false, reason: 'cancelled' }

  const booked = await dispatchAppointmentAutomationEvent('appointment-booked', appointment)
  const statusEvent = await dispatchAppointmentAutomationEvent('appointment-status', appointment)
  const reminders = Boolean(appointmentValue(appointment, 'isTest', 'is_test'))
    ? await executeSafeTestAppointmentReminders(appointment).catch((error) => {
        logger.warn(`[Recordatorios] No se pudo ejecutar la prueba segura para la cita ${appointment.id || 'sin_id'}: ${error.message}`)
        return { executed: false, reason: 'engine_error', error: error.message, reminders: [] }
      })
    : null
  return { booked, status: statusEvent, reminders }
}
