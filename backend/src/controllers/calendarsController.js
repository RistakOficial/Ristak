import crypto from 'crypto';
import * as calendarService from '../services/highlevelCalendarService.js';
import * as localCalendarService from '../services/localCalendarService.js';
import * as googleCalendarService from '../services/googleCalendarService.js';
import { logger } from '../utils/logger.js';
import GHLClient, { getGHLClient } from '../services/ghlClient.js';
import { db } from '../config/database.js';
import { getAccountTimezone } from '../utils/dateUtils.js';
import { triggerWhatsappAppointmentBookedEvent } from '../services/metaWhatsappEventsService.js';
import { sendCalendarAppointmentNotification } from '../services/pushNotificationsService.js';
import { getRequestHost, resolveConnectedPublicDomainForHost } from '../services/sitesService.js';
import { renderCalendarAppointmentTemplates } from '../services/calendarAppointmentTemplateService.js';
import { normalizePhoneForAccount } from '../utils/accountLocale.js';
import {
  isLicenseEnforced,
  getCentralGoogleCalendarStatus,
  createCentralGoogleCalendarConnectUrl,
  listCentralGoogleCalendars,
  disconnectCentralGoogleCalendar
} from '../services/licenseService.js';
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
  if (normalized === 'google') return 'combined';
  return ['combined', 'ristak', 'ghl'].includes(normalized) ? normalized : 'combined';
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

function canWriteGoogleCalendarRole(role) {
  return ['owner', 'writer'].includes(cleanString(role).toLowerCase());
}

function serviceAccountGoogleStatus(config = {}) {
  return {
    connectionMode: 'service_account',
    configured: true,
    ...config
  };
}

function centralGoogleStatus(calendar = {}) {
  const connected = Boolean(calendar.connected);
  const connectedAt = calendar.connected_at || calendar.connectedAt || null;

  return {
    connectionMode: 'oauth',
    configured: calendar.configured !== false,
    connected,
    calendarId: '',
    serviceAccountEmail: '',
    projectId: '',
    privateKeyId: '',
    calendarSummary: calendar.email || '',
    calendarTimeZone: '',
    lastTestAt: connectedAt,
    lastTestStatus: connected ? 'success' : null,
    lastTestMessage: connected ? 'Conectado con Google desde el portal de Ristak.' : '',
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncMessage: '',
    syncedCalendarsCount: 0,
    syncedEventsCount: 0,
    connectedAt,
    updatedAt: connectedAt,
    googleAccountEmail: calendar.email || '',
    googleAccountName: calendar.name || '',
    googleAccountPictureUrl: calendar.picture_url || calendar.pictureUrl || '',
    scopes: Array.isArray(calendar.scopes) ? calendar.scopes : [],
    canManageEvents: Boolean(calendar.can_manage_events || calendar.canManageEvents),
    canListCalendars: Boolean(calendar.can_list_calendars || calendar.canListCalendars)
  };
}

function centralGoogleCalendarOption(calendar = {}) {
  const accessRole = cleanString(calendar.access_role || calendar.accessRole);
  const summary = cleanString(calendar.name || calendar.summary || calendar.id);

  return {
    id: cleanString(calendar.id),
    summary,
    name: summary,
    timeZone: cleanString(calendar.time_zone || calendar.timeZone),
    accessRole,
    primary: Boolean(calendar.primary),
    selected: true,
    backgroundColor: cleanString(calendar.background_color || calendar.backgroundColor),
    foregroundColor: cleanString(calendar.foreground_color || calendar.foregroundColor)
  };
}

async function updateCentralCalendarGoogleSync({ calendarId, googleCalendarId }) {
  const localCalendar = await localCalendarService.getLocalCalendar(calendarId);
  if (!localCalendar?.id) {
    throw new Error('Calendario de Ristak no encontrado');
  }

  const normalizedGoogleCalendarId = cleanString(googleCalendarId);
  if (!normalizedGoogleCalendarId) {
    return localCalendarService.updateLocalCalendar(localCalendar.id, {
      googleCalendarId: '',
      googleAccessRole: '',
      googleCalendarSummary: '',
      googleCalendarTimeZone: ''
    }, {
      syncStatus: localCalendar.syncStatus || 'pending'
    });
  }

  const options = (await listCentralGoogleCalendars()).map(centralGoogleCalendarOption);
  const googleCalendar = options.find((option) => cleanString(option.id).toLowerCase() === normalizedGoogleCalendarId.toLowerCase());

  if (!googleCalendar?.id) {
    throw new Error('Ese calendario de Google no está disponible en la cuenta conectada.');
  }

  if (!canWriteGoogleCalendarRole(googleCalendar.accessRole)) {
    throw new Error('Ese calendario de Google necesita permiso para hacer cambios en eventos.');
  }

  return localCalendarService.updateLocalCalendar(localCalendar.id, {
    googleCalendarId: googleCalendar.id,
    googleAccessRole: googleCalendar.accessRole,
    googleCalendarSummary: googleCalendar.summary,
    googleCalendarTimeZone: googleCalendar.timeZone
  }, {
    syncStatus: localCalendar.syncStatus || 'pending'
  });
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

function getCalendarSlotLimit(calendar = {}) {
  const value = Number(calendar.appoinmentPerSlot ?? calendar.appointmentPerSlot ?? calendar.appoinment_per_slot ?? 1);
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
}

function shouldUseLocalAvailabilityForOverlaps(calendar = {}) {
  return getCalendarSlotLimit(calendar) > 1;
}

function keepLocalContactOnRemoteAppointment(remote = {}, contactId = '') {
  const localContactId = cleanString(contactId);
  if (!localContactId) return remote;

  if (remote?.appointment && typeof remote.appointment === 'object') {
    return {
      ...remote,
      appointment: {
        ...remote.appointment,
        contactId: localContactId
      }
    };
  }

  return {
    ...remote,
    contactId: localContactId
  };
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
    const error = new Error('Dominio inválido');
    error.status = 404;
    throw error;
  }

  const domainResolution = await resolveConnectedPublicDomainForHost(host);
  if (!domainResolution.ok) {
    const error = new Error(domainResolution.message || 'Dominio público no verificado');
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
  const useLocalAvailability = shouldUseLocalAvailabilityForOverlaps(calendar);

  await googleCalendarService.syncGoogleEventsForDateRange({
    calendarId: calendar.id,
    startDate,
    endDate,
    timezone
  }).catch(error => {
    logger.warn(`[Calendars Controller] Sync Google para slots publicos falló, usando DB local: ${error.message}`);
  });

  if (useLocalAvailability) {
    return localCalendarService.getLocalFreeSlots(
      calendar.id,
      startDate,
      endDate,
      timezone
    );
  }

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
 * Estado público de la integración Google Calendar por Service Account.
 */
export async function getGoogleCalendarIntegration(req, res) {
  try {
    if (isLicenseEnforced()) {
      return res.json({
        success: true,
        data: centralGoogleStatus(await getCentralGoogleCalendarStatus())
      });
    }

    res.json({
      success: true,
      data: serviceAccountGoogleStatus(await googleCalendarService.getGoogleCalendarConfig())
    });
  } catch (error) {
    logger.error(`[Calendars Controller] Error en getGoogleCalendarIntegration: ${error.message}`);
    if (isLicenseEnforced()) {
      return res.json({
        success: true,
        data: {
          ...centralGoogleStatus({ configured: false, connected: false }),
          lastTestStatus: 'error',
          lastTestMessage: error.message
        }
      });
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * POST /api/calendars/google-integration/connect-url
 * Genera la URL central de OAuth para Google Calendar desde el portal Ristak.
 */
export async function getGoogleCalendarConnectUrl(req, res) {
  try {
    if (!isLicenseEnforced()) {
      return res.status(400).json({
        success: false,
        error: 'Esta instalación usa conexión manual por Service Account.'
      });
    }

    const data = await createCentralGoogleCalendarConnectUrl({
      returnPath: req.body?.returnPath || req.body?.return_path || '/settings/calendars/google'
    });

    if (!data.url) {
      return res.status(503).json({
        success: false,
        error: 'El portal central no devolvió la URL de Google Calendar.'
      });
    }

    res.json({
      success: true,
      data
    });
  } catch (error) {
    logger.warn(`[Calendars Controller] No se pudo generar OAuth Google Calendar: ${error.message}`);
    res.status(400).json({
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
    if (isLicenseEnforced()) {
      return res.status(404).json({
        success: false,
        error: 'Esta instalación usa OAuth central de Google Calendar.'
      });
    }

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
    if (isLicenseEnforced()) {
      return res.status(400).json({
        success: false,
        error: 'Esta instalación usa OAuth central. Conecta Google Calendar desde el botón de Google.'
      });
    }

    const body = req.body || {};
    const config = await googleCalendarService.saveGoogleCalendarConfig({
      calendarId: body.calendarId ?? body.calendar_id ?? '',
      credentials: body.credentials || body.serviceAccountJson || body.service_account_json
    });

    await localCalendarService.reconcileCalendarDefaults().catch(error => {
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
    if (isLicenseEnforced()) {
      return res.json({
        success: true,
        data: centralGoogleStatus(await getCentralGoogleCalendarStatus())
      });
    }

    const config = await googleCalendarService.testGoogleCalendarConnection();

    await localCalendarService.reconcileCalendarDefaults().catch(error => {
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
    if (isLicenseEnforced()) {
      const now = new Date();
      const syncStart = req.body?.startTime || req.body?.start_time || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const syncEnd = req.body?.endTime || req.body?.end_time || new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
      const inboundResult = await googleCalendarService.syncGoogleEventsToLocal({
        startTime: syncStart,
        endTime: syncEnd
      });
      const syncResult = await googleCalendarService.syncLocalAppointmentsToGoogle({
        startTime: req.body?.startTime || req.body?.start_time,
        endTime: req.body?.endTime || req.body?.end_time
      });
      const deletedEventsCount = Number(inboundResult.deleted || 0);
      const syncedEventsCount = Number(inboundResult.saved || 0) + Number(syncResult.synced || 0) + deletedEventsCount;
      const linkedCalendarsCount = Number(inboundResult.linkedCalendars || syncResult.linkedCalendars || 0);
      const status = centralGoogleStatus(await getCentralGoogleCalendarStatus());
      return res.json({
        success: true,
        data: {
          ...status,
          lastSyncAt: new Date().toISOString(),
          lastSyncStatus: syncResult.failed > 0 ? 'warning' : 'success',
          lastSyncMessage: `${syncedEventsCount} cita(s) sincronizadas con Google Calendar${deletedEventsCount ? ` (${deletedEventsCount} eliminada(s) en Ristak)` : ''}${syncResult.failed > 0 ? `; ${syncResult.failed} quedaron pendientes` : ''}`,
          syncedCalendarsCount: linkedCalendarsCount,
          syncedEventsCount
        }
      });
    }

    const body = req.body || {};
    const config = await googleCalendarService.syncGoogleIntegrationNow({
      startTime: body.startTime || body.start_time,
      endTime: body.endTime || body.end_time
    });

    await localCalendarService.reconcileCalendarDefaults().catch(error => {
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
 * GET /api/calendars/google-integration/calendars
 * Lista calendarios Google disponibles para vincular con calendarios Ristak.
 */
export async function listGoogleCalendarOptions(req, res) {
  try {
    if (isLicenseEnforced()) {
      return res.json({
        success: true,
        data: (await listCentralGoogleCalendars()).map(centralGoogleCalendarOption)
      });
    }

    res.json({
      success: true,
      data: await googleCalendarService.listGoogleCalendarOptions()
    });
  } catch (error) {
    logger.warn(`[Calendars Controller] No se pudieron listar calendarios Google: ${error.message}`);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * PUT /api/calendars/:id/google-sync
 * Vincula o desvincula un calendario local con un calendario Google existente.
 */
export async function updateCalendarGoogleSync(req, res) {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const googleCalendarId = body.googleCalendarId || body.google_calendar_id || '';
    const calendar = isLicenseEnforced()
      ? await updateCentralCalendarGoogleSync({ calendarId: id, googleCalendarId })
      : await googleCalendarService.updateLocalCalendarGoogleSync({ calendarId: id, googleCalendarId });

    let initialGoogleSync = null;
    if (calendar?.googleCalendarId) {
      const now = new Date();
      const startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const endTime = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();

      initialGoogleSync = await googleCalendarService.syncGoogleEventsToLocal({
        startTime,
        endTime,
        calendarId: calendar.id
      });

      await googleCalendarService.syncLocalAppointmentsToGoogle({
        calendarId: calendar.id
      }).catch(error => {
        logger.warn(`[Calendars Controller] Vinculo Google guardado, pero export inicial falló: ${error.message}`);
      });
    }

    const updatedCalendar = await localCalendarService.attachPublicCalendarUrl(
      await localCalendarService.getLocalCalendar(id),
      await localCalendarService.getCalendarPublicUrlStatus()
    );

    res.json({
      success: true,
      data: {
        ...updatedCalendar,
        initialGoogleSync
      }
    });
  } catch (error) {
    logger.warn(`[Calendars Controller] No se pudo actualizar sync Google del calendario: ${error.message}`);
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
    if (isLicenseEnforced()) {
      return res.json({
        success: true,
        data: {
          connected: Boolean((await getCentralGoogleCalendarStatus()).connected),
          mergeAvailable: false,
          googleCalendar: null,
          sourceCalendars: [],
          totalAppointments: 0
        }
      });
    }

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
    if (isLicenseEnforced()) {
      return res.status(400).json({
        success: false,
        error: 'La combinación automática todavía no aplica para Google Calendar conectado desde el portal.'
      });
    }

    const result = await googleCalendarService.mergeRistakAppointmentsIntoGoogle({
      sourceCalendarIds: req.body?.sourceCalendarIds || req.body?.source_calendar_ids || null
    });

    await localCalendarService.reconcileCalendarDefaults().catch(error => {
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
    if (isLicenseEnforced()) {
      const calendar = await disconnectCentralGoogleCalendar();
      await googleCalendarService.deleteGoogleCalendarConfig();
      await localCalendarService.reconcileCalendarDefaults().catch(error => {
        logger.warn(`[Calendars Controller] No se pudo reconciliar calendario predeterminado tras desconectar Google central: ${error.message}`);
      });
      return res.json({
        success: true,
        data: centralGoogleStatus(calendar)
      });
    }

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
    const error = new Error('El teléfono es requerido');
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

    // LOCAL PRIMERO: si ya hay calendarios de GHL espejados en la base de
    // datos, responder con lo local y refrescar desde HighLevel en segundo
    // plano. Solo se espera a HighLevel cuando todavía no hay espejo local.
    const hasMirroredGhlCalendars = locationId && accessToken
      ? Boolean(await db.get("SELECT id FROM calendars WHERE source = 'ghl' AND COALESCE(ghl_calendar_id, '') != '' LIMIT 1").catch(() => null))
      : false;

    if (locationId && accessToken) {
      if (hasMirroredGhlCalendars) {
        mirrorHighLevelCalendars(locationId, accessToken).catch(error => {
          logger.warn(`[Calendars Controller] No se pudieron espejear calendarios GHL en segundo plano: ${error.message}`);
        });
      } else {
        try {
          await mirrorHighLevelCalendars(locationId, accessToken);
        } catch (error) {
          logger.warn(`[Calendars Controller] No se pudieron espejear calendarios GHL: ${error.message}`);
        }
      }
    }

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

    // Refresca desde HighLevel y persiste todo en la tabla appointments.
    const refreshFromHighLevel = async () => {
      if (!locationId || !accessToken) return;
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
    };

    const refreshFromGoogle = () => googleCalendarService.syncGoogleEventsToLocal({
      startTime,
      endTime,
      calendarId
    });

    // LOCAL PRIMERO: la base de datos es la fuente de verdad de la app.
    // Si ya hay citas guardadas para este rango, responder de inmediato y
    // refrescar desde HighLevel/Google en segundo plano (sin bloquear la UI).
    // Solo se espera a HighLevel cuando la BD todavía está vacía (primera carga).
    let events = await localCalendarService.listLocalAppointments({
      startTime,
      endTime,
      calendarId
    });

    if (events.length > 0) {
      refreshFromHighLevel().catch(error => {
        logger.warn(`[Calendars Controller] No se pudo refrescar eventos GHL en segundo plano: ${error.message}`);
      });
      refreshFromGoogle().catch(error => {
        logger.warn(`[Calendars Controller] No se pudo refrescar eventos Google en segundo plano: ${error.message}`);
      });
    } else {
      try {
        await refreshFromHighLevel();
      } catch (error) {
        logger.warn(`[Calendars Controller] No se pudo refrescar eventos GHL, usando DB local: ${error.message}`);
      }

      await refreshFromGoogle().catch(error => {
        logger.warn(`[Calendars Controller] No se pudo refrescar eventos Google, usando DB local: ${error.message}`);
      });

      events = await localCalendarService.listLocalAppointments({
        startTime,
        endTime,
        calendarId
      });
    }

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
        error: 'Horario inválido'
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
    const publicAppointmentData = {
      contactId,
      calendarId: calendar.id,
      appointmentStatus: calendar.autoConfirm ? 'confirmed' : 'pending',
      status: calendar.autoConfirm ? 'confirmed' : 'pending',
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      notes: cleanString(body.notes)
    };
    const renderedTemplates = await renderCalendarAppointmentTemplates({
      calendar,
      appointmentData: publicAppointmentData,
      titleTemplate: calendar.eventTitle || calendar.name || 'Cita',
      notesTemplate: calendar.notes || publicAppointmentData.notes
    });
    let appointment = await localCalendarService.createLocalAppointment({
      ...publicAppointmentData,
      locationId: context.locationId || calendar.locationId,
      title: renderedTemplates.title,
      notes: renderedTemplates.notes,
      source: 'ristak'
    }, {
      locationId: context.locationId || calendar.locationId,
      syncStatus: 'pending'
    });

    if (context.locationId && context.accessToken && calendar.ghlCalendarId) {
      try {
        const ghlContactId = await localCalendarService.ensureHighLevelContactForAppointment(
          new GHLClient(context.accessToken, context.locationId),
          { ...appointment, contactId }
        );
        const remote = await calendarService.createAppointment({
          calendarId: calendar.ghlCalendarId,
          contactId: ghlContactId || contactId,
          title: renderedTemplates.title,
          appointmentStatus: calendar.autoConfirm ? 'confirmed' : 'pending',
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          notes: renderedTemplates.notes
        }, context.locationId, context.accessToken);

        appointment = await localCalendarService.upsertLocalAppointment(keepLocalContactOnRemoteAppointment(remote, contactId), {
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

    await googleCalendarService.syncGoogleEventsForDateRange({
      calendarId: localCalendar?.id || id,
      startDate,
      endDate,
      timezone
    }).catch(error => {
      logger.warn(`[Calendars Controller] Sync Google para slots falló, usando DB local: ${error.message}`);
    });

    if (localCalendar && shouldUseLocalAvailabilityForOverlaps(localCalendar)) {
      slots = await localCalendarService.getLocalFreeSlots(
        localCalendar.id,
        startDate,
        endDate,
        timezone
      );
    } else if (accessToken && (localCalendar?.ghlCalendarId || (!localCalendar && id))) {
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
    const renderedTemplates = await renderCalendarAppointmentTemplates({
      calendar: localCalendar || {},
      appointmentData,
      titleTemplate: appointmentData.title || localCalendar?.eventTitle || localCalendar?.name || 'Cita',
      notesTemplate: localCalendar?.notes || appointmentData.notes || appointmentData.description || ''
    });
    const localAppointmentData = {
      ...appointmentData,
      title: renderedTemplates.title,
      notes: renderedTemplates.notes
    };
    let appointment = await localCalendarService.createLocalAppointment({
      ...localAppointmentData,
      calendarId: localCalendar?.id || appointmentData.calendarId,
      locationId: context.locationId
    }, {
      locationId: context.locationId,
      syncStatus: 'pending'
    });

    if (context.locationId && context.accessToken && (localCalendar?.ghlCalendarId || !localCalendar)) {
      try {
        const localContactId = appointment.contactId || appointmentData.contactId || appointmentData.contact_id;
        const ghlContactId = await localCalendarService.ensureHighLevelContactForAppointment(
          new GHLClient(context.accessToken, context.locationId),
          { ...appointment, contactId: localContactId }
        );
        const remote = await calendarService.createAppointment(
          {
            ...localAppointmentData,
            calendarId: localCalendar?.ghlCalendarId || appointmentData.calendarId,
            contactId: ghlContactId || localContactId || localAppointmentData.contactId || localAppointmentData.contact_id
          },
          context.locationId,
          context.accessToken
        );
        appointment = await localCalendarService.upsertLocalAppointment(keepLocalContactOnRemoteAppointment(remote, localContactId), {
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
  updateCalendarGoogleSync,
  deleteEvent,
  getGoogleCalendarIntegration,
  getGoogleCalendarConnectUrl,
  listGoogleCalendarOptions,
  saveGoogleCalendarIntegration,
  testGoogleCalendarIntegration,
  syncGoogleCalendarIntegration,
  getGoogleCalendarMergePreview,
  mergeGoogleCalendarAppointments,
  deleteGoogleCalendarIntegration
};
