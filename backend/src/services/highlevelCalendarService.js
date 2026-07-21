import { DateTime } from 'luxon';
import { logger } from '../utils/logger.js';
import { getAccountTimezone, resolveTimezone } from '../utils/dateUtils.js';
import crypto from 'node:crypto';

/**
 * Servicio para interactuar con la API de Calendarios de HighLevel
 * Documentación: https://marketplace.gohighlevel.com/docs/ghl/calendars/calendars
 */

const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-04-15';
const CALENDARS_API_VERSION = 'v3';
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

function cleanString(value) {
  return String(value ?? '').trim();
}

export function highLevelTestAppointmentMarker(testEffectId) {
  const effectId = cleanString(testEffectId);
  if (!effectId) throw new Error('La cita de prueba no tiene testEffectId para generar su marcador HighLevel');
  return `[RISTAK-TEST:${crypto.createHash('sha256').update(effectId).digest('hex')}]`;
}

export function appendHighLevelTestAppointmentMarker(notes, testEffectId) {
  const marker = highLevelTestAppointmentMarker(testEffectId);
  const description = cleanString(notes);
  return description.includes(marker) ? description : [description, marker].filter(Boolean).join('\n');
}

function exactRemoteInstant(left, right) {
  const leftMs = new Date(left).getTime();
  const rightMs = new Date(right).getTime();
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

export function findHighLevelTestAppointmentByCommand(events = [], command = {}) {
  const marker = cleanString(command.marker);
  const calendarId = cleanString(command.calendarId);
  const contactId = cleanString(command.contactId);
  if (!marker || !calendarId || !contactId || !command.startTime || !command.endTime) return null;

  for (const event of (Array.isArray(events) ? events : [])) {
    const remote = event?.appointment || event || {};
    const description = cleanString(remote.description || remote.notes);
    const matches = description.includes(marker)
      && cleanString(remote.calendarId || remote.calendar_id) === calendarId
      && cleanString(remote.contactId || remote.contact_id) === contactId
      && exactRemoteInstant(remote.startTime || remote.start_time, command.startTime)
      && exactRemoteInstant(remote.endTime || remote.end_time, command.endTime);
    if (matches) return remote;
  }
  return null;
}

export function isAmbiguousHighLevelAppointmentWriteError(error) {
  const status = Number(error?.status || 0);
  return !status || status === 408 || status === 409 || status === 429 || status >= 500;
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
          'Version': CALENDARS_API_VERSION,
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
          'Version': CALENDARS_API_VERSION,
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
 * Crear un calendario en HighLevel.
 * Endpoint oficial: POST /calendars/ con Version v3.
 * @param {Object} calendarData - Configuración completa del calendario
 * @param {string} accessToken - Token de acceso OAuth / Private Integration Token
 * @returns {Promise<Object>} Calendario creado
 */
export async function createCalendar(calendarData, accessToken) {
  try {
    logger.info(`[HighLevel Calendar] Creando calendario: ${calendarData.name || calendarData.slug || 'Sin nombre'}`);

    if (!calendarData.locationId) {
      throw new Error('Se requiere locationId para crear calendario');
    }

    if (!calendarData.name) {
      throw new Error('Se requiere name para crear calendario');
    }

    const response = await fetchWithTimeout(
      `${GHL_API_BASE}/calendars/`,
      {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Version': CALENDARS_API_VERSION,
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify(calendarData)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[HighLevel Calendar] Error al crear calendario: ${response.status} - ${errorText}`);
      throw new Error(`Error al crear calendario: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const calendar = data.calendar || data;
    logger.info(`[HighLevel Calendar] Calendario creado exitosamente: ${calendar.id || 'N/A'}`);

    return data;
  } catch (error) {
    logger.error(`[HighLevel Calendar] Error en createCalendar: ${error.message}`);
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
      const error = new Error(`Error al obtener eventos: ${response.status}`);
      error.status = response.status;
      throw error;
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
export async function getFreeSlots(calendarId, startDate, endDate, accessToken, timezone) {
  try {
    logger.info(`[HighLevel Calendar] Obteniendo slots disponibles para calendario: ${calendarId}`);

    const effectiveTimezone = resolveTimezone(timezone || await getAccountTimezone());

    // Convertir fechas string a timestamps en milisegundos
    // startDate y endDate vienen como "YYYY-MM-DD" del frontend y se interpretan
    // como días completos en la zona horaria del negocio.
    const startTimestamp = DateTime.fromISO(startDate, { zone: effectiveTimezone }).startOf('day').toMillis();
    const endTimestamp = DateTime.fromISO(endDate, { zone: effectiveTimezone }).endOf('day').toMillis();

    logger.info(`[HighLevel Calendar] Fechas convertidas: ${startDate} (${startTimestamp}) - ${endDate} (${endTimestamp})`);

    const response = await fetchWithTimeout(
      `${GHL_API_BASE}/calendars/${calendarId}/free-slots?startDate=${startTimestamp}&endDate=${endTimestamp}&timezone=${effectiveTimezone}`,
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

    // Transformar respuesta de objeto a array
    // API devuelve: { "2025-10-22": { "slots": [...] }, "2025-10-23": { "slots": [...] } }
    // Necesitamos: [{ date: "2025-10-22", slots: [...] }, { date: "2025-10-23", slots: [...] }]
    const slotsArray = [];

    for (const [date, dateData] of Object.entries(data)) {
      // Ignorar traceId y otros campos que no sean fechas
      if (date === 'traceId' || !dateData.slots) continue;

      slotsArray.push({
        date,
        slots: dateData.slots
      });
    }

    // Ordenar por fecha (más reciente primero)
    slotsArray.sort((a, b) => new Date(a.date) - new Date(b.date));

    logger.info(`[HighLevel Calendar] ${slotsArray.length} días con slots disponibles`);

    return slotsArray;
  } catch (error) {
    logger.error(`[HighLevel Calendar] Error en getFreeSlots: ${error.message}`);
    throw error;
  }
}

/**
 * Obtener horarios bloqueados de un calendario
 * @param {string} locationId - ID de la ubicación
 * @param {number} startTime - Timestamp inicio en milisegundos
 * @param {number} endTime - Timestamp fin en milisegundos
 * @param {string} accessToken - Token de acceso OAuth
 * @param {string} calendarId - (Opcional) ID del calendario
 * @returns {Promise<Array>} Lista de horarios bloqueados
 */
export async function getBlockedSlots(locationId, startTime, endTime, accessToken, calendarId = null, calendar = null, timezone = 'UTC') {
  try {
    logger.info(`[HighLevel Calendar] Obteniendo blocked slots para locationId: ${locationId}, rango: ${new Date(startTime).toISOString()} - ${new Date(endTime).toISOString()}`);

    // IMPORTANTE: El API de HighLevel REQUIERE uno de estos filtros obligatoriamente:
    // - calendarId (para bloqueos del calendario completo)
    // - userId (para bloqueos de usuarios específicos)
    // - groupId (para bloqueos de grupos)
    //
    // PROBLEMA: Los blocked slots creados con assignedUserId NO se devuelven si filtras por calendarId
    // SOLUCIÓN: Hacer MÚLTIPLES consultas y combinar resultados:
    // 1. Consulta con calendarId → Bloqueos del calendario
    // 2. Consulta con cada userId del calendario → Bloqueos de usuarios

    const allBlockedSlots = [];

    // 1. Obtener blocked slots del calendario (si se proporcionó calendarId)
    if (calendarId) {
      try {
        const urlCalendar = `${GHL_API_BASE}/calendars/blocked-slots?locationId=${locationId}&startTime=${startTime}&endTime=${endTime}&calendarId=${calendarId}`;

        const responseCalendar = await fetchWithTimeout(urlCalendar, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Version': API_VERSION,
            'Authorization': `Bearer ${accessToken}`
          }
        });

        if (responseCalendar.ok) {
          const dataCalendar = await responseCalendar.json();
          const calendarSlots = dataCalendar.events || [];
          allBlockedSlots.push(...calendarSlots);
          logger.info(`[HighLevel Calendar] ${calendarSlots.length} blocked slots del calendario obtenidos`);
        }
      } catch (error) {
        logger.warn(`[HighLevel Calendar] Error al obtener blocked slots del calendario: ${error.message}`);
      }
    }

    // 2. Obtener blocked slots de usuarios del calendario
    if (calendar && calendar.teamMembers && calendar.teamMembers.length > 0) {
      const userIds = calendar.teamMembers.map(tm => tm.userId);
      logger.info(`[HighLevel Calendar] Consultando blocked slots de ${userIds.length} usuarios`);

      // Hacer consultas en paralelo para cada usuario
      const userPromises = userIds.map(async (userId) => {
        try {
          const urlUser = `${GHL_API_BASE}/calendars/blocked-slots?locationId=${locationId}&startTime=${startTime}&endTime=${endTime}&userId=${userId}`;

          const responseUser = await fetchWithTimeout(urlUser, {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'Version': API_VERSION,
              'Authorization': `Bearer ${accessToken}`
            }
          });

          if (responseUser.ok) {
            const dataUser = await responseUser.json();
            return dataUser.events || [];
          }
          return [];
        } catch (error) {
          logger.warn(`[HighLevel Calendar] Error al obtener blocked slots del usuario ${userId}: ${error.message}`);
          return [];
        }
      });

      const userResults = await Promise.all(userPromises);
      const userSlots = userResults.flat();
      allBlockedSlots.push(...userSlots);
      logger.info(`[HighLevel Calendar] ${userSlots.length} blocked slots de usuarios obtenidos`);
    }

    // Deduplicar por ID (pueden venir duplicados si un slot está asociado a múltiples usuarios)
    const uniqueSlots = Array.from(
      new Map(allBlockedSlots.map(slot => [slot.id, slot])).values()
    );

    logger.info(`[HighLevel Calendar] Total: ${uniqueSlots.length} blocked slots únicos`);
    const blockedSlots = uniqueSlots;

    // Transformar a formato estándar si es necesario.
    // IMPORTANTE: date/startTime/endTime se devuelven en la ZONA DE LA CUENTA para que
    // los bloqueos queden alineados con las citas en la rejilla del calendario.
    const zone = timezone || 'UTC';
    const normalizedSlots = blockedSlots.map(slot => {
      // Si el slot ya tiene el formato correcto (date + startTime + endTime separados)
      if (slot.date && typeof slot.startTime === 'string' && slot.startTime.length === 5) {
        return {
          ...slot,
          id: slot.id, // Incluir ID para poder editar/eliminar
          reason: slot.reason || slot.title || 'Bloqueado'
        };
      }

      // Si viene en formato ISO completo (del API de HighLevel)
      // startTime: "2025-10-28T15:00:00.000Z" -> convertir a la zona de la cuenta
      const startDt = DateTime.fromISO(slot.startTime, { setZone: true }).setZone(zone);
      const endDt = (slot.endTime
        ? DateTime.fromISO(slot.endTime, { setZone: true })
        : startDt.plus({ minutes: 30 })
      ).setZone(zone);

      const safeStart = startDt.isValid ? startDt : DateTime.fromJSDate(new Date(slot.startTime)).setZone(zone);
      const safeEnd = endDt.isValid ? endDt : safeStart.plus({ minutes: 30 });

      return {
        id: slot.id, // IMPORTANTE: Incluir ID para editar/eliminar
        date: safeStart.toFormat('yyyy-MM-dd'), // YYYY-MM-DD (zona de la cuenta)
        startTime: safeStart.toFormat('HH:mm'), // HH:mm (zona de la cuenta)
        endTime: safeEnd.toFormat('HH:mm'), // HH:mm (zona de la cuenta)
        reason: slot.title || slot.reason || 'Bloqueado',
        blockedBy: slot.assignedUserId || slot.blockedBy || null
      };
    });

    logger.info(`[HighLevel Calendar] ${normalizedSlots.length} horarios bloqueados encontrados`);

    return normalizedSlots;
  } catch (error) {
    logger.error(`[HighLevel Calendar] Error en getBlockedSlots: ${error.message}`);
    throw error;
  }
}

/**
 * Crear un nuevo blocked slot (horario bloqueado)
 * @param {Object} blockData - Datos del bloqueo
 * @param {string} locationId - ID de la ubicación
 * @param {string} accessToken - Token de acceso OAuth
 * @returns {Promise<Object>} Blocked slot creado
 */
export async function createBlockedSlot(blockData, locationId, accessToken) {
  try {
    logger.info(`[HighLevel Calendar] Creando blocked slot para calendario: ${blockData.calendarId}`);

    // Validaciones previas
    const startDate = new Date(blockData.startTime);
    const endDate = new Date(blockData.endTime);

    if (isNaN(startDate.getTime())) {
      throw new Error(`Fecha de inicio inválida: ${blockData.startTime}`);
    }
    if (isNaN(endDate.getTime())) {
      throw new Error(`Fecha de fin inválida: ${blockData.endTime}`);
    }

    if (endDate <= startDate) {
      throw new Error(`La fecha de fin debe ser posterior a la fecha de inicio`);
    }

    // Validar que al menos uno esté presente: calendarId O assignedUserId
    if (!blockData.calendarId && !blockData.assignedUserId) {
      throw new Error('Se requiere calendarId o assignedUserId para crear un blocked slot');
    }

    // IMPORTANTE: El API de HighLevel usa lógica EXCLUSIVA (XOR):
    // - calendarId (sin assignedUserId) → Bloquea TODO el calendario
    // - assignedUserId (sin calendarId) → Bloquea solo ese usuario específico
    // - AMBOS juntos → ERROR 422 "Either calendarId or assignedUserId must be present"

    const payload = {
      title: blockData.title || 'Horario bloqueado',
      locationId: locationId,
      startTime: blockData.startTime,
      endTime: blockData.endTime
    };

    // Solo agregar UNO de los dos (nunca ambos)
    if (blockData.assignedUserId) {
      payload.assignedUserId = blockData.assignedUserId;
      logger.info(`[HighLevel Calendar] Bloqueando usuario específico: ${blockData.assignedUserId}`);
    } else if (blockData.calendarId) {
      payload.calendarId = blockData.calendarId;
      logger.info(`[HighLevel Calendar] Bloqueando calendario completo: ${blockData.calendarId}`);
    }

    logger.info(`[HighLevel Calendar] Payload final: ${JSON.stringify(payload, null, 2)}`);

    const response = await fetchWithTimeout(
      `${GHL_API_BASE}/calendars/events/block-slots`,
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
      logger.error(`[HighLevel Calendar] Error al crear blocked slot: ${response.status} - ${errorText}`);
      throw new Error(`Error al crear blocked slot: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    logger.info(`[HighLevel Calendar] Blocked slot creado exitosamente: ${data.id || 'N/A'}`);

    return data;
  } catch (error) {
    logger.error(`[HighLevel Calendar] Error en createBlockedSlot: ${error.message}`);
    throw error;
  }
}

/**
 * Actualizar un blocked slot existente
 * @param {string} eventId - ID del evento/blocked slot
 * @param {Object} updateData - Datos a actualizar
 * @param {string} accessToken - Token de acceso OAuth
 * @returns {Promise<Object>} Blocked slot actualizado
 */
export async function updateBlockedSlot(eventId, updateData, accessToken) {
  try {
    logger.info(`[HighLevel Calendar] Actualizando blocked slot: ${eventId}`);

    const response = await fetchWithTimeout(
      `${GHL_API_BASE}/calendars/events/block-slots/${eventId}`,
      {
        method: 'PUT',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Version': CALENDARS_API_VERSION,
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify(updateData)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[HighLevel Calendar] Error al actualizar blocked slot: ${response.status} - ${errorText}`);
      throw new Error(`Error al actualizar blocked slot: ${response.status}`);
    }

    const data = await response.json();
    logger.info(`[HighLevel Calendar] Blocked slot actualizado exitosamente: ${eventId}`);

    return data;
  } catch (error) {
    logger.error(`[HighLevel Calendar] Error en updateBlockedSlot: ${error.message}`);
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
      // En Modo test queremos recorrer exactamente el carril real de avisos.
      // Fuera del tester conservamos el comportamiento histórico silencioso.
      toNotify: Boolean(appointmentData.isTest || appointmentData.is_test),
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
      payload.description = appointmentData.isTest || appointmentData.is_test
        ? appendHighLevelTestAppointmentMarker(appointmentData.notes, appointmentData.testEffectId || appointmentData.test_effect_id)
        : appointmentData.notes; // HighLevel usa 'description' no 'notes'
    } else if (appointmentData.isTest || appointmentData.is_test) {
      payload.description = appendHighLevelTestAppointmentMarker('', appointmentData.testEffectId || appointmentData.test_effect_id);
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
      const error = new Error(`Error al crear cita: ${response.status} - ${errorText}`);
      error.status = response.status;
      throw error;
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

    const payload = {
      ...updateData
    };

    if (payload.appointment_status && !payload.appointmentStatus) {
      payload.appointmentStatus = payload.appointment_status;
      delete payload.appointment_status;
    }

    if (payload.appointmentStatus) {
      payload.appointmentStatus = mapAppointmentStatus(payload.appointmentStatus);
    }

    if (payload.notes && !payload.description) {
      payload.description = payload.notes;
      delete payload.notes;
    }

    if (payload.startTime || payload.endTime || payload.start_time || payload.end_time) {
      if (payload.ignoreFreeSlotValidation === undefined) {
        payload.ignoreFreeSlotValidation = true;
      }
      if (payload.ignoreDateRange === undefined) {
        payload.ignoreDateRange = true;
      }
    }

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
        body: JSON.stringify(payload)
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
          'Version': CALENDARS_API_VERSION,
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

/**
 * Eliminar un blocked slot (horario bloqueado)
 * @param {string} eventId - ID del blocked slot
 * @param {string} accessToken - Token de acceso OAuth
 * @returns {Promise<boolean>} True si se eliminó correctamente
 */
export async function deleteBlockedSlot(eventId, accessToken) {
  try {
    logger.info(`[HighLevel Calendar] Eliminando blocked slot: ${eventId}`);

    const response = await fetchWithTimeout(
      `${GHL_API_BASE}/calendars/blocked-slots/${eventId}`,
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
      logger.error(`[HighLevel Calendar] Error al eliminar blocked slot: ${response.status} - ${errorText}`);
      throw new Error(`Error al eliminar blocked slot: ${response.status}`);
    }

    logger.info(`[HighLevel Calendar] Blocked slot eliminado exitosamente: ${eventId}`);
    return true;
  } catch (error) {
    logger.error(`[HighLevel Calendar] Error en deleteBlockedSlot: ${error.message}`);
    throw error;
  }
}

export default {
  getCalendars,
  getCalendar,
  createCalendar,
  getCalendarEvents,
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
