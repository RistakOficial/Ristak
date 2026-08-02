import { logger } from '../utils/logger.js'
import {
  getAppointmentRemindersOverview,
  createAppointmentReminder,
  updateAppointmentReminder,
  deleteAppointmentReminder
} from '../services/appointmentRemindersService.js'

function sendError(res, error, fallback = 'Error procesando la solicitud') {
  const status = error.status || 500
  const payload = { success: false, error: error.message || fallback }
  if (error.code) payload.code = error.code
  if (error.conflict) payload.conflict = error.conflict
  res.status(status).json(payload)
}

function requireCalendarId(value) {
  const calendarId = String(value || '').trim()
  if (calendarId) return calendarId
  const error = new Error('Selecciona un calendario para administrar sus mensajes automáticos.')
  error.status = 400
  error.code = 'appointment_reminder_calendar_required'
  throw error
}

export async function getAppointmentRemindersHandler(req, res) {
  try {
    const calendarId = requireCalendarId(req.query.calendarId)
    res.json({ success: true, data: await getAppointmentRemindersOverview(calendarId) })
  } catch (error) {
    logger.error(`Error listando mensajes automáticos de citas: ${error.message}`)
    sendError(res, error, 'Error listando los mensajes automáticos')
  }
}

export async function createAppointmentReminderHandler(req, res) {
  try {
    const body = req.body || {}
    const reminder = await createAppointmentReminder({
      ...body,
      calendarId: requireCalendarId(body.calendarId)
    })
    res.status(201).json({ success: true, data: reminder })
  } catch (error) {
    logger.error(`Error creando mensaje automático de citas: ${error.message}`)
    sendError(res, error, 'Error creando el mensaje automático')
  }
}

export async function updateAppointmentReminderHandler(req, res) {
  try {
    const body = req.body || {}
    const reminder = await updateAppointmentReminder(req.params.reminderId, {
      ...body,
      calendarId: requireCalendarId(body.calendarId)
    })
    res.json({ success: true, data: reminder })
  } catch (error) {
    logger.error(`Error actualizando mensaje automático de citas: ${error.message}`)
    sendError(res, error, 'Error actualizando el mensaje automático')
  }
}

export async function deleteAppointmentReminderHandler(req, res) {
  try {
    const calendarId = requireCalendarId(req.query.calendarId)
    res.json({ success: true, data: await deleteAppointmentReminder(req.params.reminderId, calendarId) })
  } catch (error) {
    logger.error(`Error eliminando mensaje automático de citas: ${error.message}`)
    sendError(res, error, 'Error eliminando el mensaje automático')
  }
}
