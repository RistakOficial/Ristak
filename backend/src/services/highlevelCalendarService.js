import { logger } from '../utils/logger.js';

/**
 * Servicio para interactuar con la API de Calendarios de HighLevel
 * Documentación: https://marketplace.gohighlevel.com/docs/ghl/calendars/calendars
 */

const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-04-15';
const REQUEST_TIMEOUT = 15000; // 15 segundos timeout

/**
 * Fetch con timeout automático
 */
async function fetchWithTimeout(url, options = {}, timeout = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout después de ${timeout}ms`);
    }
    throw error;
  }
}

/**
 * Mapear estado de cita del frontend al formato de HighLevel
 * Frontend: pending, confirmed, cancelled, showed, noshow, rescheduled
 * HighLevel: confirmed, cancelled, showed, noshow, invalid
 */
function mapAppointmentStatus(status) {
  const statusMap = {
    'pending': 'confirmed', // pending no existe en GHL, usar confirmed
    'confirmed': 'confirmed',
    'cancelled': 'cancelled',
    'showed': 'showed',
    'noshow': 'noshow',
    'rescheduled': 'confirmed' // rescheduled no existe en GHL, usar confirmed
  };
  return statusMap[status] || 'confirmed';
}

/**
 * Obtener todos los calendarios de una ubicación
 * @param {string} locationId - ID de la ubicación en HighLevel
 * @param {string} accessToken - Token de acceso OAuth
 * @returns {Promise<Array>} Lista de calendarios
 */
export async function getCalendars(locationId, accessToken) {
  try {
    logger.info(`[HighLevel Calendar] Obteniendo calendarios para locationId: ${locationId}`);

    const response = await fetchWithTimeout(
      `${GHL_API_BASE}/calendars/?locationId=${locationId}`,
      {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Version': API_VERSION,
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[HighLevel Calendar] Error al obtener calendarios: ${response.status} - ${errorText}`);
      throw new Error(`Error al obtener calendarios: ${response.status}`);
    }

    const data = await response.json();
    logger.info(`[HighLevel Calendar] Calendarios obtenidos exitosamente: ${data.calendars?.length || 0} calendarios`);

    return data.calendars || [];
  } catch (error) {
    logger.error(`[HighLevel Calendar] Error en getCalendars: ${error.message}`);
    throw error;
  }
}

/**
 * Obtener un calendario específico por ID
 * @param {string} calendarId - ID del calendario
 * @param {string} accessToken - Token de acceso OAuth
 * @returns {Promise<Object>} Datos del calendario
 */
export async function getCalendar(calendarId, accessToken) {
  try {
    logger.info(`[HighLevel Calendar] Obteniendo calendario: ${calendarId}`);

    const response = await fetchWithTimeout(
      `${GHL_API_BASE}/calendars/${calendarId}`,
      {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Version': API_VERSION,
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[HighLevel Calendar] Error al obtener calendario: ${response.status} - ${errorText}`);
      throw new Error(`Error al obtener calendario: ${response.status}`);
    }

    const data = await response.json();
    logger.info(`[HighLevel Calendar] Calendario obtenido exitosamente: ${data.name || calendarId}`);

    return data;
  } catch (error) {
    logger.error(`[HighLevel Calendar] Error en getCalendar: ${error.message}`);
    throw error;
  }
}

/**
 * Obtener eventos de calendario (citas) en un rango de fechas
 * @param {string} locationId - ID de la ubicación
 * @param {number} startTime - Timestamp inicio en milisegundos
 * @param {number} endTime - Timestamp fin en milisegundos
 * @param {string} accessToken - Token de acceso OAuth
 * @param {string} calendarId - (Opcional) Filtrar por calendario específico
 * @returns {Promise<Array>} Lista de eventos/citas
 */
export async function getCalendarEvents(locationId, startTime, endTime, accessToken, calendarId = null) {
  try {
    logger.info(`[HighLevel Calendar] Obteniendo eventos para locationId: ${locationId}, rango: ${new Date(startTime).toISOString()} - ${new Date(endTime).toISOString()}`);

    let url = `${GHL_API_BASE}/calendars/events?locationId=${locationId}&startTime=${startTime}&endTime=${endTime}`;

    if (calendarId) {
      url += `&calendarId=${calendarId}`;
    }

    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Version': API_VERSION,
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[HighLevel Calendar] Error al obtener eventos: ${response.status} - ${errorText}`);
      throw new Error(`Error al obtener eventos: ${response.status}`);
    }

    const data = await response.json();
    logger.info(`[HighLevel Calendar] Eventos obtenidos exitosamente: ${data.events?.length || 0} eventos`);

    return data.events || [];
  } catch (error) {
    logger.error(`[HighLevel Calendar] Error en getCalendarEvents: ${error.message}`);
    throw error;
  }
}

/**
 * Obtener detalles completos de una cita individual
 * Este endpoint devuelve información completa incluyendo contactId y assignedUserId
 * @param {string} eventId - ID del evento/cita
 * @param {string} accessToken - Token de acceso OAuth
 * @returns {Promise<Object>} Detalles completos de la cita
 */
export async function getAppointment(eventId, accessToken) {
  try {
    logger.info(`[HighLevel Calendar] Obteniendo detalles de cita: ${eventId}`);

    const response = await fetchWithTimeout(
      `${GHL_API_BASE}/calendars/events/appointments/${eventId}`,
      {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Version': API_VERSION,
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[HighLevel Calendar] Error al obtener cita: ${response.status} - ${errorText}`);
      throw new Error(`Error al obtener cita: ${response.status}`);
    }

    const data = await response.json();
    logger.info(`[HighLevel Calendar] Cita obtenida exitosamente: ${eventId} (contactId: ${data.contactId || 'N/A'}, assignedUserId: ${data.assignedUserId || 'N/A'})`);

    return data;
  } catch (error) {
    logger.error(`[HighLevel Calendar] Error en getAppointment: ${error.message}`);
    throw error;
  }
}

/**
 * Obtener slots disponibles de un calendario
 * @param {string} calendarId - ID del calendario
 * @param {string} startDate - Fecha inicio (YYYY-MM-DD)
 * @param {string} endDate - Fecha fin (YYYY-MM-DD)
 * @param {string} accessToken - Token de acceso OAuth
 * @param {string} timezone - Zona horaria (ej: "America/Mexico_City")
 * @returns {Promise<Array>} Lista de slots disponibles
 */
export async function getFreeSlots(calendarId, startDate, endDate, accessToken, timezone = 'America/Mexico_City') {
  try {
    logger.info(`[HighLevel Calendar] Obteniendo slots disponibles para calendario: ${calendarId}`);

    const response = await fetchWithTimeout(
      `${GHL_API_BASE}/calendars/${calendarId}/free-slots?startDate=${startDate}&endDate=${endDate}&timezone=${timezone}`,
      {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Version': API_VERSION,
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[HighLevel Calendar] Error al obtener slots: ${response.status} - ${errorText}`);
      throw new Error(`Error al obtener slots: ${response.status}`);
    }

    const data = await response.json();
    logger.info(`[HighLevel Calendar] Slots disponibles obtenidos exitosamente`);

    return data;
  } catch (error) {
    logger.error(`[HighLevel Calendar] Error en getFreeSlots: ${error.message}`);
    throw error;
  }
}

/**
 * Crear una nueva cita en el calendario
 * @param {Object} appointmentData - Datos de la cita
 * @param {string} locationId - ID de la ubicación
 * @param {string} accessToken - Token de acceso OAuth
 * @returns {Promise<Object>} Cita creada
 */
export async function createAppointment(appointmentData, locationId, accessToken) {
  try {
    // Validaciones previas
    const startDate = new Date(appointmentData.startTime);
    const endDate = new Date(appointmentData.endTime);

    if (isNaN(startDate.getTime())) {
      throw new Error(`Fecha de inicio inválida: ${appointmentData.startTime}`);
    }
    if (isNaN(endDate.getTime())) {
      throw new Error(`Fecha de fin inválida: ${appointmentData.endTime}`);
    }

    if (endDate <= startDate) {
      throw new Error(`La fecha de fin debe ser posterior a la fecha de inicio`);
    }

    // Construir payload según documentación de HighLevel
    const payload = {
      calendarId: appointmentData.calendarId,
      locationId: locationId,
      startTime: appointmentData.startTime,
      endTime: appointmentData.endTime,
      // Campos requeridos por la API
      ignoreFreeSlotValidation: true, // Permite agendar incluso en horarios no disponibles
      ignoreDateRange: true, // Intenta bypasear restricción TOOFAR (fecha fuera de rango)
      toNotify: false, // No enviar notificaciones automáticas
      meetingLocationType: appointmentData.address ? 'custom' : 'zoom',
      title: appointmentData.title || 'Nueva cita',
      // Mapear status del frontend al formato de HighLevel
      appointmentStatus: mapAppointmentStatus(appointmentData.appointmentStatus)
    };

    // Campos opcionales
    if (appointmentData.contactId) {
      payload.contactId = appointmentData.contactId;
    }

    // assignedUserId es OBLIGATORIO según HighLevel API
    // Si no se proporciona, obtener del calendario
    if (appointmentData.assignedUserId) {
      payload.assignedUserId = appointmentData.assignedUserId;
    } else {
      // Obtener el calendario para extraer el primer team member
      try {
        const response = await getCalendar(appointmentData.calendarId, accessToken);

        // La API de HighLevel devuelve { calendar: {...} }
        const calendar = response.calendar || response;

        if (calendar && calendar.teamMembers && calendar.teamMembers.length > 0) {
          // Usar el primer team member disponible
          payload.assignedUserId = calendar.teamMembers[0].userId;
          logger.info(`[HighLevel Calendar] assignedUserId no proporcionado, usando primer team member: ${payload.assignedUserId}`);
        } else {
          logger.warn(`[HighLevel Calendar] No se encontraron team members en el calendario ${appointmentData.calendarId}`);
        }
      } catch (error) {
        logger.warn(`[HighLevel Calendar] No se pudo obtener team members del calendario: ${error.message}`);
      }
    }

    if (appointmentData.address) {
      payload.address = appointmentData.address;
    }

    if (appointmentData.notes) {
      payload.description = appointmentData.notes; // HighLevel usa 'description' no 'notes'
    }

    const response = await fetchWithTimeout(
      `${GHL_API_BASE}/calendars/events/appointments`,
      {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Version': API_VERSION,
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify(payload)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[HighLevel Calendar] Error al crear cita: ${response.status} - ${errorText}`);
      throw new Error(`Error al crear cita: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    logger.info(`[HighLevel Calendar] Cita creada exitosamente: ${data.id}`);

    return data;
  } catch (error) {
    logger.error(`[HighLevel Calendar] Error en createAppointment: ${error.message}`);
    throw error;
  }
}

/**
 * Actualizar una cita existente
 * @param {string} eventId - ID del evento/cita
 * @param {Object} updateData - Datos a actualizar
 * @param {string} accessToken - Token de acceso OAuth
 * @returns {Promise<Object>} Cita actualizada
 */
export async function updateAppointment(eventId, updateData, accessToken) {
  try {
    logger.info(`[HighLevel Calendar] Actualizando cita: ${eventId}`);

    const response = await fetchWithTimeout(
      `${GHL_API_BASE}/calendars/events/appointments/${eventId}`,
      {
        method: 'PUT',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Version': API_VERSION,
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify(updateData)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[HighLevel Calendar] Error al actualizar cita: ${response.status} - ${errorText}`);
      throw new Error(`Error al actualizar cita: ${response.status}`);
    }

    const data = await response.json();
    logger.info(`[HighLevel Calendar] Cita actualizada exitosamente: ${eventId}`);

    return data;
  } catch (error) {
    logger.error(`[HighLevel Calendar] Error en updateAppointment: ${error.message}`);
    throw error;
  }
}

/**
 * Eliminar un evento del calendario
 * @param {string} eventId - ID del evento
 * @param {string} accessToken - Token de acceso OAuth
 * @returns {Promise<boolean>} True si se eliminó correctamente
 */
export async function deleteEvent(eventId, accessToken) {
  try {
    logger.info(`[HighLevel Calendar] Eliminando evento: ${eventId}`);

    const response = await fetchWithTimeout(
      `${GHL_API_BASE}/calendars/events/${eventId}`,
      {
        method: 'DELETE',
        headers: {
          'Accept': 'application/json',
          'Version': API_VERSION,
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[HighLevel Calendar] Error al eliminar evento: ${response.status} - ${errorText}`);
      throw new Error(`Error al eliminar evento: ${response.status}`);
    }

    logger.info(`[HighLevel Calendar] Evento eliminado exitosamente: ${eventId}`);
    return true;
  } catch (error) {
    logger.error(`[HighLevel Calendar] Error en deleteEvent: ${error.message}`);
    throw error;
  }
}

/**
 * Actualizar configuración de un calendario
 * @param {string} calendarId - ID del calendario
 * @param {Object} updateData - Datos de configuración a actualizar
 * @param {string} accessToken - Token de acceso OAuth
 * @returns {Promise<Object>} Calendario actualizado
 */
export async function updateCalendar(calendarId, updateData, accessToken) {
  try {
    logger.info(`[HighLevel Calendar] Actualizando configuración de calendario: ${calendarId}`);
    logger.info(`[HighLevel Calendar] Datos a actualizar: ${JSON.stringify(updateData, null, 2)}`);

    const response = await fetchWithTimeout(
      `${GHL_API_BASE}/calendars/${calendarId}`,
      {
        method: 'PUT',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Version': API_VERSION,
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify(updateData)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[HighLevel Calendar] Error al actualizar calendario: ${response.status} - ${errorText}`);
      throw new Error(`Error al actualizar calendario: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    logger.info(`[HighLevel Calendar] Calendario actualizado exitosamente: ${calendarId}`);

    return data;
  } catch (error) {
    logger.error(`[HighLevel Calendar] Error en updateCalendar: ${error.message}`);
    throw error;
  }
}

export default {
  getCalendars,
  getCalendar,
  getCalendarEvents,
  getAppointment,
  getFreeSlots,
  createAppointment,
  updateAppointment,
  updateCalendar,
  deleteEvent
};
