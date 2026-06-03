import * as calendarService from '../services/highlevelCalendarService.js';
import * as localCalendarService from '../services/localCalendarService.js';
import { logger } from '../utils/logger.js';
import { getGHLClient } from '../services/ghlClient.js';
import { db } from '../config/database.js';
import { getAccountTimezone } from '../utils/dateUtils.js';
import { triggerWhatsappAppointmentBookedEvent } from '../services/metaWhatsappEventsService.js';

/**
 * Controlador para endpoints de Calendarios de HighLevel
 */

async function getSavedHighLevelConfig() {
  return db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1');
}

async function getHighLevelContext(req, source = {}) {
  const saved = await getSavedHighLevelConfig().catch(() => null);
  return {
    locationId: source.locationId || req.query?.locationId || req.body?.locationId || saved?.location_id || null,
    accessToken: source.accessToken || req.query?.accessToken || req.body?.accessToken || saved?.api_token || null
  };
}

async function getCalendarSourcePreference() {
  try {
    const row = await db.get('SELECT config_value FROM app_config WHERE config_key = ?', ['calendar_source_preference']);
    return row?.config_value || 'combined';
  } catch {
    return 'combined';
  }
}

async function mirrorHighLevelCalendars(locationId, accessToken) {
  if (!locationId || !accessToken) return;

  const calendars = await calendarService.getCalendars(locationId, accessToken);
  for (const calendar of calendars) {
    await localCalendarService.upsertLocalCalendar(calendar, {
      source: 'ghl',
      ghlCalendarId: calendar.id,
      locationId,
      syncStatus: 'synced',
      rawJson: calendar
    });
  }
}

/**
 * GET /api/calendars
 * Obtener todos los calendarios de la ubicación
 */
export async function getCalendars(req, res) {
  try {
    const { locationId, accessToken } = await getHighLevelContext(req);

    if (locationId && accessToken) {
      try {
        await mirrorHighLevelCalendars(locationId, accessToken);
      } catch (error) {
        logger.warn(`[Calendars Controller] No se pudieron espejear calendarios GHL: ${error.message}`);
      }
    }

    await localCalendarService.ensureDefaultLocalCalendar();
    const sourcePreference = await getCalendarSourcePreference();
    const calendars = await localCalendarService.listLocalCalendars({ sourcePreference });

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
 * POST /api/calendars
 * Crear calendario local de Ristak. Si HighLevel está conectado, intenta crearlo allá también.
 */
export async function createCalendar(req, res) {
  try {
    const { accessToken: tokenFromBody, locationId: locationFromBody, ...calendarData } = req.body;
    const { locationId, accessToken } = await getHighLevelContext(req, {
      locationId: locationFromBody,
      accessToken: tokenFromBody
    });

    let calendar = await localCalendarService.createLocalCalendar({
      ...calendarData,
      locationId: locationId || calendarData.locationId
    });

    if (locationId && accessToken) {
      const syncResult = await localCalendarService.syncLocalCalendarsToHighLevel(locationId, accessToken);
      calendar = await localCalendarService.getLocalCalendar(calendar.id);
      logger.info(`[Calendars Controller] Sync calendario creado: ${JSON.stringify(syncResult)}`);
    }

    res.status(201).json({
      success: true,
      data: calendar
    });
  } catch (error) {
    logger.error(`[Calendars Controller] Error en createCalendar: ${error.message}`);
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
    const { accessToken, locationId } = await getHighLevelContext(req);

    const localCalendar = await localCalendarService.getLocalCalendar(id);
    if (localCalendar) {
      return res.json({
        success: true,
        data: localCalendar
      });
    }

    if (!accessToken) {
      return res.status(404).json({
        success: false,
        error: 'Calendario no encontrado'
      });
    }

    const remote = await calendarService.getCalendar(id, accessToken);
    const calendar = await localCalendarService.upsertLocalCalendar(remote.calendar || remote, {
      source: 'ghl',
      ghlCalendarId: id,
      locationId,
      syncStatus: 'synced',
      rawJson: remote
    });

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
    const { startTime, endTime, calendarId } = req.query;
    const { locationId, accessToken } = await getHighLevelContext(req);

    if (!startTime || !endTime) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere startTime y endTime'
      });
    }

    if (locationId && accessToken) {
      try {
        const localCalendar = calendarId ? await localCalendarService.getLocalCalendar(calendarId) : null;
        const remoteCalendarId = localCalendar?.ghlCalendarId || calendarId || null;
        const remoteEvents = await calendarService.getCalendarEvents(
          locationId,
          parseInt(startTime, 10),
          parseInt(endTime, 10),
          accessToken,
          remoteCalendarId
        );

        for (const event of remoteEvents) {
          const eventCalendar = event.calendarId
            ? await localCalendarService.getLocalCalendar(event.calendarId)
            : null;
          await localCalendarService.upsertLocalAppointment(event, {
            source: 'ghl',
            ghlAppointmentId: event.id,
            calendarId: eventCalendar?.id || localCalendar?.id || event.calendarId,
            locationId,
            syncStatus: 'synced'
          });
        }
      } catch (error) {
        logger.warn(`[Calendars Controller] No se pudo refrescar eventos GHL, usando DB local: ${error.message}`);
      }
    }

    const events = await localCalendarService.listLocalAppointments({
      startTime,
      endTime,
      calendarId
    });

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
    const localAppointment = await localCalendarService.getLocalAppointment(eventId);

    if (localAppointment) {
      return res.json({
        success: true,
        data: localAppointment
      });
    }

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
    try {
      const localAppointment = await localCalendarService.getLocalAppointment(req.params.eventId);
      if (localAppointment) {
        logger.warn(`[Calendars Controller] Usando cita local por fallback: ${error.message}`);
        return res.json({
          success: true,
          data: localAppointment
        });
      }
    } catch (fallbackError) {
      logger.warn(`[Calendars Controller] Fallback local de cita falló: ${fallbackError.message}`);
    }

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
    const { startDate, endDate, timezone } = req.query;
    const { accessToken } = await getHighLevelContext(req);

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere startDate y endDate'
      });
    }

    const localCalendar = await localCalendarService.getLocalCalendar(id);
    let slots;

    if (accessToken && (localCalendar?.ghlCalendarId || (!localCalendar && id))) {
      try {
        slots = await calendarService.getFreeSlots(
          localCalendar?.ghlCalendarId || id,
          startDate,
          endDate,
          accessToken,
          timezone
        );
      } catch (error) {
        logger.warn(`[Calendars Controller] Free slots GHL falló, usando local: ${error.message}`);
      }
    }

    if (!slots) {
      slots = await localCalendarService.getLocalFreeSlots(
        localCalendar?.id || id,
        startDate,
        endDate,
        timezone
      );
    }

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
    const { startTime, endTime } = req.query;
    const { locationId, accessToken } = await getHighLevelContext(req);

    if (!locationId || !startTime || !endTime || !accessToken) {
      return res.json({
        success: true,
        data: []
      });
    }

    const localCalendar = await localCalendarService.getLocalCalendar(calendarId);
    const remoteCalendarId = localCalendar?.ghlCalendarId || calendarId;

    // Obtener el calendario completo para extraer teamMembers
    let calendar = null;
    if (remoteCalendarId) {
      try {
        const calendarData = await calendarService.getCalendar(remoteCalendarId, accessToken);
        calendar = calendarData.calendar || calendarData; // Normalizar respuesta
      } catch (error) {
        logger.warn(`[Calendars Controller] No se pudo obtener calendario ${remoteCalendarId}: ${error.message}`);
      }
    }

    const timezone = await getAccountTimezone();
    const blockedSlots = await calendarService.getBlockedSlots(
      locationId,
      parseInt(startTime, 10),
      parseInt(endTime, 10),
      accessToken,
      remoteCalendarId,
      calendar, // Pasar el objeto calendario completo con teamMembers
      timezone // Zona de la cuenta para alinear los bloqueos con las citas
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
    const context = await getHighLevelContext(req, { locationId, accessToken });
    const localCalendar = await localCalendarService.getLocalCalendar(appointmentData.calendarId || appointmentData.calendar_id);
    let appointment = await localCalendarService.createLocalAppointment({
      ...appointmentData,
      calendarId: localCalendar?.id || appointmentData.calendarId,
      locationId: context.locationId
    }, {
      locationId: context.locationId,
      syncStatus: 'pending'
    });

    if (context.locationId && context.accessToken && (localCalendar?.ghlCalendarId || !localCalendar)) {
      try {
        const remote = await calendarService.createAppointment(
          {
            ...appointmentData,
            calendarId: localCalendar?.ghlCalendarId || appointmentData.calendarId
          },
          context.locationId,
          context.accessToken
        );
        appointment = await localCalendarService.upsertLocalAppointment(remote, {
          id: appointment.id,
          source: appointment.source || 'ristak',
          ghlAppointmentId: remote.appointment?.id || remote.id,
          calendarId: appointment.calendarId,
          locationId: context.locationId,
          syncStatus: 'synced'
        });
      } catch (error) {
        logger.warn(`[Calendars Controller] Cita guardada local, sync GHL pendiente: ${error.message}`);
      }
    }

    const contactId = appointmentData.contactId || appointmentData.contact_id || appointment?.contactId || appointment?.contact_id;

    if (contactId) {
      await triggerWhatsappAppointmentBookedEvent(contactId, {
        calendarId: appointment?.calendarId || appointmentData.calendarId || appointmentData.calendar_id
      });
    }

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
    const context = await getHighLevelContext(req, { accessToken });
    const existing = await localCalendarService.getLocalAppointment(id);
    let appointment;

    if (context.accessToken && existing?.ghlAppointmentId) {
      try {
        const remote = await calendarService.updateAppointment(existing.ghlAppointmentId, updateData, context.accessToken);
        appointment = await localCalendarService.upsertLocalAppointment(remote, {
          id: existing.id,
          source: existing.source || 'ristak',
          ghlAppointmentId: existing.ghlAppointmentId,
          calendarId: existing.calendarId,
          locationId: context.locationId || existing.locationId,
          syncStatus: 'synced'
        });
      } catch (error) {
        logger.warn(`[Calendars Controller] Update GHL falló, guardando pendiente local: ${error.message}`);
      }
    }

    if (!appointment) {
      appointment = await localCalendarService.updateLocalAppointment(id, updateData, { syncStatus: 'pending' });
    }

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
    const context = await getHighLevelContext(req, { accessToken });
    const existing = await localCalendarService.getLocalCalendar(id);
    let calendar = await localCalendarService.updateLocalCalendar(id, updateData, { syncStatus: 'pending' });

    if (!calendar && !existing) {
      return res.status(404).json({
        success: false,
        error: 'Calendario no encontrado'
      });
    }

    const remoteCalendarId = existing?.ghlCalendarId || id;
    if (context.accessToken && remoteCalendarId && existing?.ghlCalendarId) {
      try {
        const remote = await calendarService.updateCalendar(remoteCalendarId, updateData, context.accessToken);
        calendar = await localCalendarService.upsertLocalCalendar(remote.calendar || remote, {
          id: existing.id,
          source: existing.source,
          ghlCalendarId: remoteCalendarId,
          locationId: context.locationId || existing.locationId,
          syncStatus: 'synced',
          rawJson: remote
        });
      } catch (error) {
        logger.warn(`[Calendars Controller] Update calendario GHL falló, queda pendiente: ${error.message}`);
      }
    }

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
    const { accessToken } = await getHighLevelContext(req);
    const existing = await localCalendarService.getLocalAppointment(id);

    if (accessToken && existing?.ghlAppointmentId) {
      try {
        await calendarService.deleteEvent(existing.ghlAppointmentId, accessToken);
        await localCalendarService.deleteLocalAppointment(existing.id);
      } catch (error) {
        logger.warn(`[Calendars Controller] Delete GHL falló, marcando pendiente: ${error.message}`);
        await localCalendarService.deleteLocalAppointment(existing.id, { markPendingDelete: true });
      }
    } else {
      await localCalendarService.deleteLocalAppointment(id);
    }

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
  createCalendar,
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
