import * as calendarService from '../services/highlevelCalendarService.js';
import { logger } from '../utils/logger.js';

/**
 * Controlador para endpoints de Calendarios de HighLevel
 */

/**
 * GET /api/calendars
 * Obtener todos los calendarios de la ubicación
 */
export async function getCalendars(req, res) {
  try {
    const { locationId, accessToken } = req.query;

    if (!locationId || !accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere locationId y accessToken'
      });
    }

    const calendars = await calendarService.getCalendars(locationId, accessToken);

    res.json({
      success: true,
      data: calendars
    });
  } catch (error) {
    logger.error(`[Calendars Controller] Error en getCalendars: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * GET /api/calendars/:id
 * Obtener un calendario específico
 */
export async function getCalendar(req, res) {
  try {
    const { id } = req.params;
    const { accessToken } = req.query;

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere accessToken'
      });
    }

    const calendar = await calendarService.getCalendar(id, accessToken);

    res.json({
      success: true,
      data: calendar
    });
  } catch (error) {
    logger.error(`[Calendars Controller] Error en getCalendar: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * GET /api/calendars/events
 * Obtener eventos (citas) de un rango de fechas
 */
export async function getEvents(req, res) {
  try {
    const { locationId, startTime, endTime, calendarId, accessToken } = req.query;

    if (!locationId || !startTime || !endTime || !accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere locationId, startTime, endTime y accessToken'
      });
    }

    const events = await calendarService.getCalendarEvents(
      locationId,
      parseInt(startTime, 10),
      parseInt(endTime, 10),
      accessToken,
      calendarId
    );

    res.json({
      success: true,
      data: events
    });
  } catch (error) {
    logger.error(`[Calendars Controller] Error en getEvents: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * GET /api/calendars/:id/free-slots
 * Obtener slots disponibles de un calendario
 */
export async function getFreeSlots(req, res) {
  try {
    const { id } = req.params;
    const { startDate, endDate, timezone, accessToken } = req.query;

    if (!startDate || !endDate || !accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere startDate, endDate y accessToken'
      });
    }

    const slots = await calendarService.getFreeSlots(
      id,
      startDate,
      endDate,
      accessToken,
      timezone
    );

    res.json({
      success: true,
      data: slots
    });
  } catch (error) {
    logger.error(`[Calendars Controller] Error en getFreeSlots: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * POST /api/calendars/appointments
 * Crear una nueva cita
 */
export async function createAppointment(req, res) {
  try {
    const { accessToken, ...appointmentData } = req.body;

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere accessToken'
      });
    }

    const appointment = await calendarService.createAppointment(appointmentData, accessToken);

    res.status(201).json({
      success: true,
      data: appointment
    });
  } catch (error) {
    logger.error(`[Calendars Controller] Error en createAppointment: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * PUT /api/calendars/appointments/:id
 * Actualizar una cita existente
 */
export async function updateAppointment(req, res) {
  try {
    const { id } = req.params;
    const { accessToken, ...updateData } = req.body;

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere accessToken'
      });
    }

    const appointment = await calendarService.updateAppointment(id, updateData, accessToken);

    res.json({
      success: true,
      data: appointment
    });
  } catch (error) {
    logger.error(`[Calendars Controller] Error en updateAppointment: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * DELETE /api/calendars/events/:id
 * Eliminar un evento del calendario
 */
export async function deleteEvent(req, res) {
  try {
    const { id } = req.params;
    const { accessToken } = req.query;

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere accessToken'
      });
    }

    await calendarService.deleteEvent(id, accessToken);

    res.json({
      success: true,
      message: 'Evento eliminado exitosamente'
    });
  } catch (error) {
    logger.error(`[Calendars Controller] Error en deleteEvent: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

export default {
  getCalendars,
  getCalendar,
  getEvents,
  getFreeSlots,
  createAppointment,
  updateAppointment,
  deleteEvent
};
