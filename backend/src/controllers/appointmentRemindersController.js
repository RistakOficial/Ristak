import { logger } from '../utils/logger.js'
import {
  getAppointmentRemindersOverview,
  createAppointmentReminder,
  updateAppointmentReminder,
  deleteAppointmentReminder
} from '../services/appointmentRemindersService.js'

function sendError(res, error, fallback = 'Error procesando la solicitud') {
  const status = error.status || 500
  res.status(status).json({ success: false, error: error.message || fallback })
}

export async function getAppointmentRemindersHandler(req, res) {
  try {
    res.json({ success: true, data: await getAppointmentRemindersOverview() })
  } catch (error) {
    logger.error(`Error listando mensajes automáticos de citas: ${error.message}`)
    sendError(res, error, 'Error listando los mensajes automáticos')
  }
}

export async function createAppointmentReminderHandler(req, res) {
  try {
    const reminder = await createAppointmentReminder(req.body || {})
    res.status(201).json({ success: true, data: reminder })
  } catch (error) {
    logger.error(`Error creando mensaje automático de citas: ${error.message}`)
    sendError(res, error, 'Error creando el mensaje automático')
  }
}

export async function updateAppointmentReminderHandler(req, res) {
  try {
    const reminder = await updateAppointmentReminder(req.params.reminderId, req.body || {})
    res.json({ success: true, data: reminder })
  } catch (error) {
    logger.error(`Error actualizando mensaje automático de citas: ${error.message}`)
    sendError(res, error, 'Error actualizando el mensaje automático')
  }
}

export async function deleteAppointmentReminderHandler(req, res) {
  try {
    res.json({ success: true, data: await deleteAppointmentReminder(req.params.reminderId) })
  } catch (error) {
    logger.error(`Error eliminando mensaje automático de citas: ${error.message}`)
    sendError(res, error, 'Error eliminando el mensaje automático')
  }
}
