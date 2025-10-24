import * as calendarService from '../services/highlevelCalendarService.js';
import { logger } from '../utils/logger.js';
import { getGHLClient } from '../services/ghlClient.js';

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
 * GET /api/calendars/events/:eventId
 * Obtener detalles completos de una cita individual
 * Este endpoint devuelve el contactId y assignedUserId completos
 * NO requiere accessToken - lo obtiene automáticamente de la configuración guardada
 */
export async function getAppointment(req, res) {
  try {
    const { eventId } = req.params;

    // Obtener el GHL Client que ya tiene el accessToken configurado
    const ghlClient = await getGHLClient();

    // Usar el método del ghlClient en vez de calendarService
    // porque ghlClient ya tiene el token configurado
    const response = await ghlClient.request(`/calendars/events/appointments/${eventId}`);

    // HighLevel devuelve {appointment: {...}, traceId: ...}
    // Extraer solo el appointment
    const appointment = response.appointment || response;

    res.json({
      success: true,
      data: appointment
    });
  } catch (error) {
    logger.error(`[Calendars Controller] Error en getAppointment: ${error.message}`);
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
 * GET /api/calendars/:calendarId/blocked-slots
 * Obtener horarios bloqueados de un calendario
 */
export async function getBlockedSlots(req, res) {
  try {
    const { calendarId } = req.params;
    const { locationId, startTime, endTime, accessToken } = req.query;

    if (!locationId || !startTime || !endTime || !accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere locationId, startTime, endTime y accessToken'
      });
    }

    // Obtener el calendario completo para extraer teamMembers
    let calendar = null;
    if (calendarId) {
      try {
        const calendarData = await calendarService.getCalendar(calendarId, accessToken);
        calendar = calendarData.calendar || calendarData; // Normalizar respuesta
      } catch (error) {
        logger.warn(`[Calendars Controller] No se pudo obtener calendario ${calendarId}: ${error.message}`);
      }
    }

    const blockedSlots = await calendarService.getBlockedSlots(
      locationId,
      parseInt(startTime, 10),
      parseInt(endTime, 10),
      accessToken,
      calendarId,
      calendar // Pasar el objeto calendario completo con teamMembers
    );

    res.json({
      success: true,
      data: blockedSlots
    });
  } catch (error) {
    logger.error(`[Calendars Controller] Error en getBlockedSlots: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * POST /api/calendars/block-slots
 * Crear un nuevo blocked slot (horario bloqueado)
 */
export async function createBlockedSlot(req, res) {
  try {
    const { accessToken, locationId, ...blockData } = req.body;

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere accessToken'
      });
    }

    if (!locationId) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere locationId'
      });
    }

    const blockedSlot = await calendarService.createBlockedSlot(blockData, locationId, accessToken);

    res.status(201).json({
      success: true,
      data: blockedSlot
    });
  } catch (error) {
    logger.error(`[Calendars Controller] Error en createBlockedSlot: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * PUT /api/calendars/block-slots/:id
 * Actualizar un blocked slot existente
 */
export async function updateBlockedSlot(req, res) {
  try {
    const { id } = req.params;
    const { accessToken, ...updateData } = req.body;

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere accessToken'
      });
    }

    const blockedSlot = await calendarService.updateBlockedSlot(id, updateData, accessToken);

    res.json({
      success: true,
      data: blockedSlot
    });
  } catch (error) {
    logger.error(`[Calendars Controller] Error en updateBlockedSlot: ${error.message}`);
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
    const { accessToken, locationId, ...appointmentData } = req.body;

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere accessToken'
      });
    }

    if (!locationId) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere locationId'
      });
    }

    const appointment = await calendarService.createAppointment(appointmentData, locationId, accessToken);

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
 * PUT /api/calendars/:id
 * Actualizar configuración de un calendario
 */
export async function updateCalendar(req, res) {
  try {
    const { id } = req.params;
    const { accessToken, ...updateData } = req.body;

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere accessToken'
      });
    }

    const calendar = await calendarService.updateCalendar(id, updateData, accessToken);

    res.json({
      success: true,
      data: calendar
    });
  } catch (error) {
    logger.error(`[Calendars Controller] Error en updateCalendar: ${error.message}`);
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

/**
 * Eliminar un blocked slot (horario bloqueado)
 */
export async function deleteBlockedSlot(req, res) {
  try {
    const { id } = req.params;
    const { accessToken } = req.query;

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere accessToken'
      });
    }

    await calendarService.deleteBlockedSlot(id, accessToken);

    res.json({
      success: true,
      message: 'Blocked slot eliminado exitosamente'
    });
  } catch (error) {
    logger.error(`[Calendars Controller] Error en deleteBlockedSlot: ${error.message}`);
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
  getAppointment,
  getFreeSlots,
  getBlockedSlots,
  createBlockedSlot,
  updateBlockedSlot,
  deleteBlockedSlot,
  createAppointment,
  updateAppointment,
  updateCalendar,
  deleteEvent
};
