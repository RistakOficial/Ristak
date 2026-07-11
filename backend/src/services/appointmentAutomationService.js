import { logger } from '../utils/logger.js'

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

function buildEventData(appointment = {}, extra = {}) {
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
    ...extra
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
    const engine = await import('./automationEngine.js')
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
  return { booked, status: statusEvent }
}
