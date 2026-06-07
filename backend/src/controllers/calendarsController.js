import crypto from 'crypto';
import * as calendarService from '../services/highlevelCalendarService.js';
import * as localCalendarService from '../services/localCalendarService.js';
import * as googleCalendarService from '../services/googleCalendarService.js';
import { logger } from '../utils/logger.js';
import { getGHLClient } from '../services/ghlClient.js';
import { db } from '../config/database.js';
import { getAccountTimezone } from '../utils/dateUtils.js';
import { triggerWhatsappAppointmentBookedEvent } from '../services/metaWhatsappEventsService.js';
import { sendCalendarAppointmentNotification } from '../services/pushNotificationsService.js';
import { getRequestHost, resolveConnectedPublicDomainForHost } from '../services/sitesService.js';
import { normalizePhoneForAccount } from '../utils/accountLocale.js';
import {
  finalizePreparedPhoneUpsert,
  findContactByPhoneCandidates,
  prepareContactPhoneUpsert
} from '../services/contactIdentityService.js';

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

function normalizeCalendarSourcePreference(value) {
  const normalized = cleanString(value || 'combined').toLowerCase();
  return ['combined', 'ristak', 'ghl', 'google'].includes(normalized) ? normalized : 'combined';
}

async function getCalendarSourcePreference(override = '') {
  if (override) {
    return normalizeCalendarSourcePreference(override);
  }

  try {
    const row = await db.get('SELECT config_value FROM app_config WHERE config_key = ?', ['calendar_source_preference']);
    return normalizeCalendarSourcePreference(row?.config_value);
  } catch {
    return 'combined';
  }
}

function cleanString(value) {
  return String(value ?? '').trim();
}

function normalizeEmail(value) {
  const email = cleanString(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function splitName(fullName = '') {
  const parts = cleanString(fullName).split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' ')
  };
}

function dateKeyFromDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

async function getSavedHighLevelOnlyContext() {
  const saved = await getSavedHighLevelConfig().catch(() => null);
  return {
    locationId: saved?.location_id || null,
    accessToken: saved?.api_token || null
  };
}

async function ensurePublicCalendarRequest(req, slugOrId) {
  const host = getRequestHost(req);
  if (!host) {
    const error = new Error('Dominio invalido');
    error.status = 404;
    throw error;
  }

  const domainResolution = await resolveConnectedPublicDomainForHost(host);
  if (!domainResolution.ok) {
    const error = new Error(domainResolution.message || 'Dominio publico no verificado');
    error.status = domainResolution.status || 404;
    throw error;
  }

  const calendar = await localCalendarService.getPublicCalendarBySlug(slugOrId);
  if (!calendar) {
    const error = new Error('Calendario no encontrado o inactivo');
    error.status = 404;
    throw error;
  }

  return { host, calendar };
}

async function getCalendarFreeSlotsForPublic(calendar, { startDate, endDate, timezone }, context = {}) {
  let slots = null;

  if (context.accessToken && calendar.ghlCalendarId) {
    try {
      slots = await calendarService.getFreeSlots(
        calendar.ghlCalendarId,
        startDate,
        endDate,
        context.accessToken,
        timezone
      );
    } catch (error) {
      logger.warn(`[Calendars Controller] Free slots publicos GHL fallaron, usando local: ${error.message}`);
    }
  }

  await googleCalendarService.syncGoogleEventsForDateRange({
    calendarId: calendar.id,
    startDate,
    endDate,
    timezone
  }).catch(error => {
    logger.warn(`[Calendars Controller] Sync Google para slots publicos falló, usando DB local: ${error.message}`);
  });

  if (!slots) {
    slots = await localCalendarService.getLocalFreeSlots(
      calendar.id,
      startDate,
      endDate,
      timezone
    );
  }

  return slots;
}

/**
 * GET /api/calendars/google-integration
 * Estado publico de la integración Google Calendar por Service Account.
 */
export async function getGoogleCalendarIntegration(req, res) {
  try {
    res.json({
      success: true,
      data: await googleCalendarService.getGoogleCalendarConfig()
    });
  } catch (error) {
    logger.error(`[Calendars Controller] Error en getGoogleCalendarIntegration: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * GET /api/calendars/google-integration/reveal/service-account
 * Devuelve el JSON del Service Account para edición en Settings.
 */
export async function revealGoogleCalendarServiceAccount(req, res) {
  try {
    res.json({
      success: true,
      data: {
        serviceAccountJson: await googleCalendarService.getGoogleServiceAccountJson()
      }
    });
  } catch (error) {
    logger.warn(`[Calendars Controller] No se pudo revelar JSON Google Calendar: ${error.message}`);
    res.status(404).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * PUT /api/calendars/google-integration
 * Guarda credenciales cifradas de Service Account y Calendar ID.
 */
export async function saveGoogleCalendarIntegration(req, res) {
  try {
    const body = req.body || {};
    const config = await googleCalendarService.saveGoogleCalendarConfig({
      calendarId: body.calendarId || body.calendar_id,
      credentials: body.credentials || body.serviceAccountJson || body.service_account_json
    });

    await googleCalendarService.syncGoogleCalendarsToLocal().catch(error => {
      logger.warn(`[Calendars Controller] Google guardado, pero sync de calendarios falló: ${error.message}`);
    });

    await localCalendarService.reconcileCalendarDefaults({ sourcePreference: 'google' }).catch(error => {
      logger.warn(`[Calendars Controller] No se pudo reconciliar calendario predeterminado tras guardar Google: ${error.message}`);
    });

    res.json({
      success: true,
      data: config
    });
  } catch (error) {
    logger.warn(`[Calendars Controller] Error guardando Google Calendar: ${error.message}`);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * POST /api/calendars/google-integration/test
 * Valida lectura, creación, actualización y cancelación de eventos.
 */
export async function testGoogleCalendarIntegration(req, res) {
  try {
    let config = await googleCalendarService.testGoogleCalendarConnection();
    try {
      config = await googleCalendarService.syncGoogleIntegrationNow();
    } catch (syncError) {
      logger.warn(`[Calendars Controller] Prueba Google OK, pero sync manual falló: ${syncError.message}`);
    }

    await localCalendarService.reconcileCalendarDefaults({ sourcePreference: 'google' }).catch(error => {
      logger.warn(`[Calendars Controller] No se pudo reconciliar calendario predeterminado tras probar Google: ${error.message}`);
    });

    res.json({
      success: true,
      data: config
    });
  } catch (error) {
    logger.warn(`[Calendars Controller] Prueba Google Calendar falló: ${error.message}`);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * POST /api/calendars/google-integration/sync
 * Fuerza sincronización de calendarios Google y citas recientes hacia Ristak.
 */
export async function syncGoogleCalendarIntegration(req, res) {
  try {
    const body = req.body || {};
    const config = await googleCalendarService.syncGoogleIntegrationNow({
      startTime: body.startTime || body.start_time,
      endTime: body.endTime || body.end_time
    });

    await localCalendarService.reconcileCalendarDefaults({ sourcePreference: 'google' }).catch(error => {
      logger.warn(`[Calendars Controller] No se pudo reconciliar calendario predeterminado tras sincronizar Google: ${error.message}`);
    });

    res.json({
      success: true,
      data: config
    });
  } catch (error) {
    logger.warn(`[Calendars Controller] Sync Google Calendar falló: ${error.message}`);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * GET /api/calendars/google-integration/merge-preview
 * Indica si hay citas locales de Ristak que se pueden combinar hacia el Google Calendar conectado.
 */
export async function getGoogleCalendarMergePreview(req, res) {
  try {
    res.json({
      success: true,
      data: await googleCalendarService.getGoogleCalendarMergePreview()
    });
  } catch (error) {
    logger.warn(`[Calendars Controller] No se pudo calcular preview de combinación Google: ${error.message}`);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * POST /api/calendars/google-integration/merge
 * Mueve citas existentes de calendarios Ristak al Google Calendar conectado y las sincroniza hacia Google.
 */
export async function mergeGoogleCalendarAppointments(req, res) {
  try {
    const result = await googleCalendarService.mergeRistakAppointmentsIntoGoogle({
      sourceCalendarIds: req.body?.sourceCalendarIds || req.body?.source_calendar_ids || null
    });

    await localCalendarService.reconcileCalendarDefaults({ sourcePreference: 'google' }).catch(error => {
      logger.warn(`[Calendars Controller] No se pudo reconciliar calendario predeterminado tras combinar Google: ${error.message}`);
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.warn(`[Calendars Controller] No se pudieron combinar citas hacia Google: ${error.message}`);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * DELETE /api/calendars/google-integration
 * Desconecta la integración guardada.
 */
export async function deleteGoogleCalendarIntegration(req, res) {
  try {
    await googleCalendarService.deleteGoogleCalendarConfig();
    await localCalendarService.reconcileCalendarDefaults().catch(error => {
      logger.warn(`[Calendars Controller] No se pudo reconciliar calendario predeterminado tras desconectar Google: ${error.message}`);
    });
    res.json({
      success: true,
      data: await googleCalendarService.getGoogleCalendarConfig()
    });
  } catch (error) {
    logger.error(`[Calendars Controller] Error desconectando Google Calendar: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

async function upsertPublicCalendarContact({ calendar, contact, host, sourceUrl }) {
  const fullName = cleanString(contact.name || contact.fullName);
  const email = normalizeEmail(contact.email);
  const phone = await normalizePhoneForAccount(contact.phone) || cleanString(contact.phone);

  if (!fullName) {
    const error = new Error('El nombre es requerido');
    error.status = 400;
    throw error;
  }

  if (!phone || phone.replace(/[^\d]/g, '').length < 7) {
    const error = new Error('El telefono es requerido');
    error.status = 400;
    throw error;
  }

  const byPhone = await findContactByPhoneCandidates(phone).catch(() => null);
  const byEmail = !byPhone && email
    ? await db.get('SELECT id FROM contacts WHERE LOWER(email) = LOWER(?) ORDER BY updated_at DESC LIMIT 1', [email]).catch(() => null)
    : null;
  const contactId = byPhone?.id || byEmail?.id || `rstk_contact_${crypto.randomUUID()}`;
  const names = splitName(fullName);
  const phoneUpsert = await prepareContactPhoneUpsert({ contactId, phone });

  await db.run(`
    INSERT INTO contacts (
      id, phone, email, full_name, first_name, last_name, source,
      attribution_url, attribution_session_source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      phone = COALESCE(excluded.phone, contacts.phone),
      email = COALESCE(excluded.email, contacts.email),
      full_name = COALESCE(NULLIF(excluded.full_name, ''), contacts.full_name),
      first_name = COALESCE(NULLIF(excluded.first_name, ''), contacts.first_name),
      last_name = COALESCE(NULLIF(excluded.last_name, ''), contacts.last_name),
      source = COALESCE(NULLIF(contacts.source, ''), excluded.source),
      attribution_url = COALESCE(NULLIF(contacts.attribution_url, ''), excluded.attribution_url),
      attribution_session_source = COALESCE(NULLIF(contacts.attribution_session_source, ''), excluded.attribution_session_source),
      updated_at = CURRENT_TIMESTAMP
  `, [
    contactId,
    phoneUpsert.phone || phone || null,
    email || null,
    fullName,
    names.firstName || null,
    names.lastName || null,
    `ristak_calendar:${calendar.slug || calendar.id}`,
    cleanString(sourceUrl) || `https://${host}/calendar/${calendar.slug || calendar.id}`,
    'public_calendar'
  ]);

  await finalizePreparedPhoneUpsert(phoneUpsert, contactId);
  return contactId;
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

    await googleCalendarService.syncGoogleCalendarsToLocal().catch(error => {
      logger.warn(`[Calendars Controller] No se pudieron espejear calendarios Google: ${error.message}`);
    });

    const sourcePreference = await getCalendarSourcePreference(req.query?.sourcePreference);
    await localCalendarService.reconcileCalendarDefaults({ sourcePreference }).catch(error => {
      logger.warn(`[Calendars Controller] No se pudo reconciliar calendario predeterminado: ${error.message}`);
    });
    await localCalendarService.ensureDefaultLocalCalendar();
    const calendars = await localCalendarService.listLocalCalendars({ sourcePreference });
    const calendarsWithPublicUrls = await localCalendarService.attachPublicCalendarUrls(calendars);

    res.json({
      success: true,
      data: calendarsWithPublicUrls
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

    await localCalendarService.reconcileCalendarDefaults().catch(error => {
      logger.warn(`[Calendars Controller] No se pudo reconciliar calendario predeterminado tras crear calendario: ${error.message}`);
    });

    res.status(201).json({
      success: true,
      data: await localCalendarService.attachPublicCalendarUrl(
        calendar,
        await localCalendarService.getCalendarPublicUrlStatus()
      )
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
        data: await localCalendarService.attachPublicCalendarUrl(
          localCalendar,
          await localCalendarService.getCalendarPublicUrlStatus()
        )
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
      data: await localCalendarService.attachPublicCalendarUrl(
        calendar,
        await localCalendarService.getCalendarPublicUrlStatus()
      )
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

    await googleCalendarService.syncGoogleEventsToLocal({
      startTime,
      endTime,
      calendarId
    }).catch(error => {
      logger.warn(`[Calendars Controller] No se pudo refrescar eventos Google, usando DB local: ${error.message}`);
    });

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
 * GET /api/calendars/public/:slug/free-slots
 * Slots publicos para URLs compartibles de calendario.
 */
export async function getPublicFreeSlots(req, res) {
  try {
    const { slug } = req.params;
    const { startDate, endDate, timezone } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere startDate y endDate'
      });
    }

    const { calendar } = await ensurePublicCalendarRequest(req, slug);
    const context = await getSavedHighLevelOnlyContext();
    const resolvedTimezone = cleanString(timezone) || await getAccountTimezone();
    const slots = await getCalendarFreeSlotsForPublic(calendar, {
      startDate,
      endDate,
      timezone: resolvedTimezone
    }, context);

    res.json({
      success: true,
      data: slots
    });
  } catch (error) {
    logger.warn(`[Calendars Controller] Slots publicos rechazados: ${error.message}`);
    res.status(error.status || 500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * POST /api/calendars/public/:slug/appointments
 * Crea una cita desde una URL publica de calendario.
 */
export async function createPublicAppointment(req, res) {
  try {
    const { slug } = req.params;
    const { calendar, host } = await ensurePublicCalendarRequest(req, slug);
    const body = req.body || {};
    const start = new Date(body.startTime || body.start_time || '');

    if (Number.isNaN(start.getTime())) {
      return res.status(400).json({
        success: false,
        error: 'Horario invalido'
      });
    }

    if (start.getTime() < Date.now() - 60000) {
      return res.status(400).json({
        success: false,
        error: 'Ese horario ya paso'
      });
    }

    const timezone = cleanString(body.timezone) || await getAccountTimezone();
    const context = await getSavedHighLevelOnlyContext();
    const startDate = dateKeyFromDate(start);
    const endDate = dateKeyFromDate(addDays(start, 1));
    const availableSlots = await getCalendarFreeSlotsForPublic(calendar, {
      startDate,
      endDate,
      timezone
    }, context);
    const requestedMs = start.getTime();
    const isAvailable = availableSlots
      .flatMap(day => Array.isArray(day.slots) ? day.slots : [])
      .some(slot => Math.abs(new Date(slot).getTime() - requestedMs) <= 60000);

    if (!isAvailable) {
      return res.status(409).json({
        success: false,
        error: 'Ese horario ya no esta disponible'
      });
    }

    const contactId = await upsertPublicCalendarContact({
      calendar,
      host,
      sourceUrl: body.sourceUrl || body.source_url,
      contact: {
        name: body.name || body.fullName || body.full_name,
        phone: body.phone,
        email: body.email
      }
    });

    const durationMinutes = Math.max(1, Number(calendar.slotDuration || 60));
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
    let appointment = await localCalendarService.createLocalAppointment({
      calendarId: calendar.id,
      contactId,
      locationId: context.locationId || calendar.locationId,
      title: calendar.eventTitle || calendar.name || 'Cita',
      appointmentStatus: calendar.autoConfirm ? 'confirmed' : 'pending',
      status: calendar.autoConfirm ? 'confirmed' : 'pending',
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      notes: cleanString(body.notes),
      source: 'ristak'
    }, {
      locationId: context.locationId || calendar.locationId,
      syncStatus: 'pending'
    });

    if (context.locationId && context.accessToken && calendar.ghlCalendarId) {
      try {
        const remote = await calendarService.createAppointment({
          calendarId: calendar.ghlCalendarId,
          contactId,
          title: calendar.eventTitle || calendar.name || 'Cita',
          appointmentStatus: calendar.autoConfirm ? 'confirmed' : 'pending',
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          notes: cleanString(body.notes)
        }, context.locationId, context.accessToken);

        appointment = await localCalendarService.upsertLocalAppointment(remote, {
          id: appointment.id,
          source: appointment.source || 'ristak',
          ghlAppointmentId: remote.appointment?.id || remote.id,
          calendarId: appointment.calendarId,
          locationId: context.locationId,
          syncStatus: 'synced'
        });
      } catch (error) {
        logger.warn(`[Calendars Controller] Cita publica guardada local, sync GHL pendiente: ${error.message}`);
      }
    }

    try {
      const googleResult = await googleCalendarService.syncAppointmentToGoogle(appointment);
      if (googleResult?.appointment) {
        appointment = googleResult.appointment;
      }
    } catch (error) {
      logger.warn(`[Calendars Controller] Cita publica guardada local, sync Google pendiente/error: ${error.message}`);
    }

    await triggerWhatsappAppointmentBookedEvent(contactId, {
      calendarId: calendar.id
    }).catch(error => {
      logger.warn(`[Calendars Controller] No se pudo disparar evento WhatsApp para cita publica: ${error.message}`);
    });

    await sendCalendarAppointmentNotification(appointment, {
      calendarId: calendar.id,
      calendarName: calendar.name,
      source: 'public_calendar'
    }).catch(error => {
      logger.warn(`[Calendars Controller] No se pudo enviar push de cita publica: ${error.message}`);
    });

    res.status(201).json({
      success: true,
      data: {
        appointment,
        message: 'Listo. Tu cita quedo agendada.'
      }
    });
  } catch (error) {
    logger.warn(`[Calendars Controller] Cita publica rechazada: ${error.message}`);
    res.status(error.status || 500).json({
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

    await googleCalendarService.syncGoogleEventsForDateRange({
      calendarId: localCalendar?.id || id,
      startDate,
      endDate,
      timezone
    }).catch(error => {
      logger.warn(`[Calendars Controller] Sync Google para slots falló, usando DB local: ${error.message}`);
    });

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

    try {
      const googleResult = await googleCalendarService.syncAppointmentToGoogle(appointment);
      if (googleResult?.appointment) {
        appointment = googleResult.appointment;
      }
    } catch (error) {
      logger.warn(`[Calendars Controller] Cita guardada local, sync Google pendiente/error: ${error.message}`);
    }

    const contactId = appointmentData.contactId || appointmentData.contact_id || appointment?.contactId || appointment?.contact_id;

    if (contactId) {
      await triggerWhatsappAppointmentBookedEvent(contactId, {
        calendarId: appointment?.calendarId || appointmentData.calendarId || appointmentData.calendar_id
      });
    }

    await sendCalendarAppointmentNotification(appointment, {
      calendarId: appointment?.calendarId || appointmentData.calendarId || appointmentData.calendar_id,
      calendarName: localCalendar?.name || appointmentData.calendarName || 'Calendario',
      source: 'admin_calendar'
    }).catch(error => {
      logger.warn(`[Calendars Controller] No se pudo enviar push de cita: ${error.message}`);
    });

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

    try {
      const googleResult = await googleCalendarService.syncAppointmentToGoogle(appointment);
      if (googleResult?.appointment) {
        appointment = googleResult.appointment;
      }
    } catch (error) {
      logger.warn(`[Calendars Controller] Update local guardado, sync Google pendiente/error: ${error.message}`);
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
      data: await localCalendarService.attachPublicCalendarUrl(
        calendar,
        await localCalendarService.getCalendarPublicUrlStatus()
      )
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
 * DELETE /api/calendars/:id
 * Eliminar un calendario local de Ristak.
 */
export async function deleteCalendar(req, res) {
  try {
    const { id } = req.params;
    const existing = await localCalendarService.getLocalCalendar(id);

    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'Calendario no encontrado'
      });
    }

    if (existing.source !== 'ristak') {
      return res.status(409).json({
        success: false,
        error: 'Los calendarios sincronizados se eliminan desde su origen'
      });
    }

    const deleted = await localCalendarService.deleteLocalCalendar(id);

    res.json({
      success: true,
      data: {
        id: deleted.id,
        deleted: true
      }
    });
  } catch (error) {
    logger.error(`[Calendars Controller] Error en deleteCalendar: ${error.message}`);
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

    if (existing?.googleEventId) {
      await googleCalendarService.deleteGoogleEventForAppointment(existing);
    }

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
  deleteEvent,
  getGoogleCalendarIntegration,
  saveGoogleCalendarIntegration,
  testGoogleCalendarIntegration,
  syncGoogleCalendarIntegration,
  getGoogleCalendarMergePreview,
  mergeGoogleCalendarAppointments,
  deleteGoogleCalendarIntegration
};
