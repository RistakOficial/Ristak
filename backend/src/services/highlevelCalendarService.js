import { logger } from '../utils/logger.js';

/**
 * Servicio para interactuar con la API de Calendarios de HighLevel
 * Documentación: https://marketplace.gohighlevel.com/docs/ghl/calendars/calendars
 */

const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-04-15';

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

    const response = await fetch(
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

    const response = await fetch(
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

    const response = await fetch(url, {
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

    const response = await fetch(
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
    logger.info(`[HighLevel Calendar] Creando nueva cita para calendario: ${appointmentData.calendarId}`);

    // Construir payload según documentación de HighLevel
    const payload = {
      calendarId: appointmentData.calendarId,
      locationId: locationId,
      startTime: appointmentData.startTime,
      endTime: appointmentData.endTime,
      // Campos requeridos por la API
      ignoreFreeSlotValidation: true, // Evita error "Invalid slot range"
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

    if (appointmentData.assignedUserId) {
      payload.assignedUserId = appointmentData.assignedUserId;
    }

    if (appointmentData.address) {
      payload.address = appointmentData.address;
    }

    if (appointmentData.notes) {
      payload.description = appointmentData.notes; // HighLevel usa 'description' no 'notes'
    }

    const response = await fetch(
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

    const response = await fetch(
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

    const response = await fetch(
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

export default {
  getCalendars,
  getCalendar,
  getCalendarEvents,
  getFreeSlots,
  createAppointment,
  updateAppointment,
  deleteEvent
};
