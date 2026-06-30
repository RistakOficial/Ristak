import crypto from 'crypto';
import * as calendarService from '../services/highlevelCalendarService.js';
import * as localCalendarService from '../services/localCalendarService.js';
import * as googleCalendarService from '../services/googleCalendarService.js';
import { logger } from '../utils/logger.js';
import GHLClient, { getGHLClient } from '../services/ghlClient.js';
import { db } from '../config/database.js';
import { getAccountTimezone } from '../utils/dateUtils.js';
import { triggerWhatsappAppointmentBookedEvent } from '../services/metaWhatsappEventsService.js';
import { sendAppointmentConfirmationNotification, sendAppointmentStatusNotification, sendCalendarAppointmentNotification } from '../services/pushNotificationsService.js';
import {
  getRequestHost,
  resolvePublicCalendarHostForHost,
  resolvePublicPrefillContact,
  sendCalendarBookingSiteMetaEvent
} from '../services/sitesService.js';
import { renderCalendarAppointmentTemplates } from '../services/calendarAppointmentTemplateService.js';
import { normalizePhoneForAccount } from '../utils/accountLocale.js';
import {
  isLicenseEnforced,
  createCentralGoogleCalendarConnectUrl,
  disconnectCentralGoogleCalendar
} from '../services/licenseService.js';
import {
  finalizePreparedPhoneUpsert,
  findContactByPhoneCandidates,
  generateContactId,
  prepareContactPhoneUpsert
} from '../services/contactIdentityService.js';
import { loadFirstWhatsAppAttributions } from '../services/contactSourceService.js';
import {
  assertPaidPaymentGate,
  createPaymentGateLink,
  getPaymentGateStatus,
  isPaymentGateEnabled,
  normalizePaymentGateConfig,
  paymentGateMatches
} from '../services/publicPaymentGateService.js';
import { syncRegisteredIntegrationCronsForProvider } from '../jobs/integrationCronRegistry.js';

/**
 * Controlador para calendarios de Ristak con sincronizaciones externas opcionales.
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

function parseJsonObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function isEnabledConfigFlag(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'si', 'sí', 'on', 'enabled'].includes(value.trim().toLowerCase());
  }
  return false;
}

function normalizeBaseUrl(value) {
  const clean = cleanString(value).replace(/\/+$/, '');
  if (!clean) return '';

  try {
    const withProtocol = /^https?:\/\//i.test(clean) ? clean : `https://${clean}`;
    const parsed = new URL(withProtocol);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function getRequestBaseUrl(req) {
  const headers = req.headers || {};
  const forwardedHost = cleanString(headers['x-forwarded-host']).split(',')[0].trim();
  const host = forwardedHost || cleanString(headers.host);
  const forwardedProto = cleanString(headers['x-forwarded-proto']).split(',')[0].trim();
  const protocol = forwardedProto || cleanString(req.protocol) || 'https';
  return host ? normalizeBaseUrl(`${protocol}://${host}`) : '';
}

function getGoogleCalendarOAuthAppUrl(req) {
  return normalizeBaseUrl(req.headers?.origin)
    || normalizeBaseUrl(req.body?.appUrl || req.body?.app_url)
    || getRequestBaseUrl(req);
}

function getClientIp(req) {
  const forwarded = cleanString(req.headers?.['x-forwarded-for']);
  if (forwarded) return forwarded.split(',')[0].trim();
  return cleanString(req.ip || req.socket?.remoteAddress);
}

function buildPublicCalendarMetaRequest(req, body = {}) {
  const source = body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta) ? body.meta : {};
  return {
    ip: getClientIp(req),
    userAgent: cleanString(req.headers?.['user-agent']),
    meta: {
      ...source,
      pageUrl: cleanString(source.pageUrl || source.page_url || body.sourceUrl || body.source_url),
      sourceUrl: cleanString(body.sourceUrl || body.source_url),
      referrer: cleanString(source.referrer || source.referer),
      fbp: cleanString(source.fbp),
      fbc: cleanString(source.fbc)
    }
  };
}

function getCalendarPaymentPublicId(body = {}) {
  return cleanString(
    body.paymentPublicId ||
    body.payment_public_id ||
    body.publicPaymentId ||
    body.public_payment_id ||
    body.meta?.paymentPublicId ||
    body.meta?.payment_public_id ||
    body.meta?.publicPaymentId ||
    body.meta?.public_payment_id
  );
}

function buildCalendarPaymentRequiredResponse(bookingPayment, paymentStatus = {}) {
  return {
    status: 'payment_pending',
    paymentRequired: true,
    publicPaymentId: cleanString(paymentStatus.publicPaymentId || paymentStatus.public_payment_id),
    paymentUrl: cleanString(paymentStatus.paymentUrl || paymentStatus.payment_url),
    paymentStatus: cleanString(paymentStatus.status || 'sent'),
    paymentProvider: cleanString(paymentStatus.provider || bookingPayment.gateway),
    paymentGateway: bookingPayment.gateway,
    amount: Number(paymentStatus.amount || bookingPayment.amount) || bookingPayment.amount,
    currency: cleanString(paymentStatus.currency || bookingPayment.currency) || bookingPayment.currency,
    productName: bookingPayment.productName,
    buttonText: bookingPayment.buttonText,
    pendingMessage: bookingPayment.pendingMessage,
    paidMessage: bookingPayment.paidMessage,
    message: bookingPayment.pendingMessage || 'Completa el pago para agendar.'
  };
}

function resolveCalendarBookingPayment(calendar = {}, bookingForm = {}) {
  const calendarPayment = normalizePaymentGateConfig(calendar.bookingPayment || calendar.booking_payment || {});
  if (isPaymentGateEnabled(calendarPayment)) return calendarPayment;

  const formPayment = normalizePaymentGateConfig(bookingForm.paymentGate || bookingForm.payment_gate || {});
  if (isPaymentGateEnabled(formPayment)) return formPayment;

  return calendarPayment;
}

async function getCustomCalendarFormPaymentGate(bookingForm = {}) {
  const config = bookingForm && typeof bookingForm === 'object' && !Array.isArray(bookingForm) ? bookingForm : {};
  const customFormId = cleanString(config.customFormId || config.custom_form_id || config.formId || config.form_id);
  const useCustomForm = isEnabledConfigFlag(config.useCustomForm ?? config.use_custom_form);

  if (!useCustomForm || !customFormId) return normalizePaymentGateConfig({});

  const site = await db.get(`
    SELECT id, theme_json
    FROM public_sites
    WHERE id = ?
      AND COALESCE(status, 'draft') != 'archived'
      AND site_type IN ('standard_form', 'interactive_form')
    LIMIT 1
  `, [customFormId]).catch(() => null);

  const paymentRows = site?.id
    ? await db.all(`
      SELECT settings_json
      FROM public_site_blocks
      WHERE site_id = ?
        AND block_type = 'payment'
    `, [site.id]).catch(() => [])
    : [];

  for (const row of paymentRows) {
    const settings = parseJsonObject(row.settings_json, {});
    const paymentGate = normalizePaymentGateConfig(settings.paymentGate || settings.payment_gate || {});
    if (isPaymentGateEnabled(paymentGate)) return paymentGate;
  }

  const theme = parseJsonObject(site?.theme_json, {});
  return normalizePaymentGateConfig(theme.paymentGate || theme.payment_gate || {});
}

async function findCalendarPaymentSourceConflict(existingCalendar = {}, updateData = {}) {
  const bookingForm = updateData.bookingForm ?? updateData.booking_form ?? existingCalendar.bookingForm ?? existingCalendar.booking_form ?? {};
  const bookingPayment = normalizePaymentGateConfig(
    updateData.bookingPayment ?? updateData.booking_payment ?? existingCalendar.bookingPayment ?? existingCalendar.booking_payment ?? {}
  );

  if (!bookingPayment.enabled) return null;

  const formPayment = await getCustomCalendarFormPaymentGate(bookingForm);
  if (!formPayment.enabled) return null;

  return { bookingPayment, formPayment };
}

async function resolveCalendarPaymentGate({ req, body, calendar, bookingPayment, bookingSubmission, start, timezone }) {
  const expected = {
    source: 'calendar_booking',
    calendarId: calendar.id,
    startTime: start.toISOString()
  };
  const existingPublicPaymentId = getCalendarPaymentPublicId(body);

  if (existingPublicPaymentId) {
    const paidStatus = await assertPaidPaymentGate(existingPublicPaymentId, expected);
    if (paidStatus) return { paid: true, status: paidStatus };

    const pendingStatus = await getPaymentGateStatus(existingPublicPaymentId);
    if (pendingStatus && paymentGateMatches(pendingStatus, expected)) {
      return {
        paid: false,
        response: buildCalendarPaymentRequiredResponse(bookingPayment, pendingStatus)
      };
    }
  }

  const result = await createPaymentGateLink(bookingPayment, {
    baseUrl: getRequestBaseUrl(req),
    contact: {
      name: bookingSubmission.contact.name,
      email: bookingSubmission.contact.email,
      phone: bookingSubmission.contact.phone
    },
    source: 'calendar_booking',
    metadata: {
      calendarId: calendar.id,
      calendarSlug: calendar.slug || '',
      calendarName: calendar.name || '',
      startTime: start.toISOString(),
      timezone,
      paymentGate: expected
    }
  });

  return {
    paid: false,
    response: buildCalendarPaymentRequiredResponse(bookingPayment, {
      publicPaymentId: result.publicPaymentId,
      paymentUrl: result.paymentUrl,
      provider: bookingPayment.gateway,
      status: 'sent',
      amount: bookingPayment.amount,
      currency: bookingPayment.currency
    })
  };
}

function parseAttributionTime(value) {
  if (!value) return null;
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? time : null;
}

function sourceLooksLikeWhatsApp(value = '') {
  const normalized = cleanString(value).toLowerCase();
  return Boolean(normalized && (
    normalized.includes('whatsapp') ||
    normalized.includes('wa.me') ||
    normalized.includes('ctwa') ||
    normalized.includes('click_to_whatsapp') ||
    normalized.includes('ycloud')
  ));
}

function sourceLooksLikeWeb(value = '') {
  const normalized = cleanString(value).toLowerCase();
  return Boolean(normalized && (
    normalized.includes('ristak_site') ||
    normalized.includes('ristak_calendar') ||
    normalized.includes('public_calendar') ||
    normalized.includes('site') ||
    normalized.includes('form') ||
    normalized.includes('landing') ||
    normalized.includes('web')
  ));
}

async function getFirstCalendarContactWebSession(contact = {}) {
  const conditions = [];
  const params = [];

  if (contact.id) {
    conditions.push('contact_id = ?');
    params.push(contact.id);
  }
  if (contact.visitor_id) {
    conditions.push('visitor_id = ?');
    params.push(contact.visitor_id);
  }
  if (contact.email) {
    conditions.push('LOWER(email) = ?');
    params.push(String(contact.email).toLowerCase());
  }

  if (!conditions.length) return null;

  return db.get(`
    SELECT
      id,
      contact_id,
      visitor_id,
      email,
      started_at,
      created_at,
      page_url,
      referrer_url,
      utm_source,
      utm_medium,
      utm_campaign,
      source_platform,
      site_source_name,
      tracking_source,
      site_id,
      site_slug,
      site_type,
      form_site_id,
      conversion_type,
      submission_id,
      fbclid,
      fbc,
      fbp,
      ad_id
    FROM sessions
    WHERE ${conditions.join(' OR ')}
    ORDER BY started_at ASC, created_at ASC, id ASC
    LIMIT 1
  `, params).catch(error => {
    logger.warn(`[Calendars Controller] No se pudo leer primera sesión web del contacto ${contact.id || ''}: ${error.message}`);
    return null;
  });
}

async function getCalendarContactForMeta(contactId) {
  if (!contactId) return null;
  return db.get(`
    SELECT
      id,
      phone,
      email,
      full_name,
      first_name,
      last_name,
      source,
      visitor_id,
      attribution_url,
      attribution_session_source,
      attribution_medium,
      attribution_ctwa_clid,
      attribution_ad_name,
      attribution_ad_id,
      created_at
    FROM contacts
    WHERE id = ?
  `, [contactId]).catch(error => {
    logger.warn(`[Calendars Controller] No se pudo leer contacto ${contactId} para evento Meta: ${error.message}`);
    return null;
  });
}

async function resolveCalendarSmartEventChannel(contactId) {
  const contact = await getCalendarContactForMeta(contactId);
  if (!contact) return { channel: 'site', reason: 'missing_contact', contact: null };

  const firstWebSession = await getFirstCalendarContactWebSession(contact);
  const whatsappAttributions = await loadFirstWhatsAppAttributions([contactId]).catch(error => {
    logger.warn(`[Calendars Controller] No se pudo leer atribución WhatsApp del contacto ${contactId}: ${error.message}`);
    return new Map();
  });
  const whatsappAttribution = whatsappAttributions.get(contactId) || null;
  const webTime = parseAttributionTime(firstWebSession?.started_at || firstWebSession?.created_at);
  const whatsappTime = parseAttributionTime(whatsappAttribution?.created_at);
  const hasWebSignal = Boolean(firstWebSession) ||
    sourceLooksLikeWeb(contact.source) ||
    sourceLooksLikeWeb(contact.attribution_session_source) ||
    sourceLooksLikeWeb(contact.attribution_url);
  const hasWhatsAppSignal = Boolean(whatsappAttribution) ||
    Boolean(cleanString(contact.attribution_ctwa_clid)) ||
    sourceLooksLikeWhatsApp(contact.source) ||
    sourceLooksLikeWhatsApp(contact.attribution_session_source) ||
    sourceLooksLikeWhatsApp(contact.attribution_url);

  if (hasWhatsAppSignal) {
    if (hasWebSignal && webTime && whatsappTime) {
      return {
        channel: whatsappTime < webTime ? 'whatsapp' : 'site',
        reason: whatsappTime < webTime ? 'whatsapp_first_touch' : 'web_first_touch',
        contact
      };
    }

    if (!hasWebSignal || (!webTime && !sourceLooksLikeWeb(contact.source))) {
      return { channel: 'whatsapp', reason: 'whatsapp_attribution', contact };
    }
  }

  return {
    channel: 'site',
    reason: hasWebSignal ? 'web_attribution' : 'fallback_site',
    contact
  };
}

async function resolveCalendarCustomEventChannel({ customEvents, contactId }) {
  const configuredChannel = customEvents?.channel === 'whatsapp'
    ? 'whatsapp'
    : customEvents?.channel === 'smart'
      ? 'smart'
      : 'site';

  if (configuredChannel !== 'smart') {
    const contact = configuredChannel === 'site' ? await getCalendarContactForMeta(contactId) : null;
    return { channel: configuredChannel, reason: 'configured_channel', contact };
  }

  return resolveCalendarSmartEventChannel(contactId);
}

function getCustomEventsForResolvedChannel(customEvents = {}, channel = 'site') {
  return {
    ...customEvents,
    channel,
    eventName: channel === 'whatsapp' ? 'LeadSubmitted' : customEvents.eventName
  };
}

function googleCalendarIntegrationStatus(config = {}) {
  return {
    ...config,
    connectionMode: 'oauth',
    configured: isLicenseEnforced(),
    connected: config.connectionMode === 'oauth' ? Boolean(config.connected) : false
  };
}

function sanitizeGoogleCalendarReturnPath(value, fallbackPath = '/settings/calendars/google') {
  const fallback = cleanString(fallbackPath) || '/settings/calendars/google';
  const rawPath = cleanString(value);

  if (!rawPath || !rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.startsWith('/api/')) {
    return fallback;
  }

  try {
    const url = new URL(rawPath.slice(0, 700), 'https://ristak.local');
    const isCalendarsPath = url.pathname === '/settings/calendars' || url.pathname.startsWith('/settings/calendars/');
    if (!isCalendarsPath) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
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

function dateKeyFromDate(date, timezone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = (type) => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function addDateOnlyDays(dateOnly, days) {
  const [year, month, day] = String(dateOnly || '').split('-').map(Number);
  if (!year || !month || !day) return dateOnly;
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return [
    next.getUTCFullYear(),
    String(next.getUTCMonth() + 1).padStart(2, '0'),
    String(next.getUTCDate()).padStart(2, '0')
  ].join('-');
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

  const domainResolution = await resolvePublicCalendarHostForHost(host);
  if (!domainResolution.ok) {
    const error = new Error(domainResolution.message || 'Dominio público no disponible');
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

async function getCalendarFreeSlotsForPublic(calendar, { startDate, endDate, timezone }) {
  return localCalendarService.getLocalFreeSlots(
    calendar.id,
    startDate,
    endDate,
    timezone
  );
}

/**
 * GET /api/calendars/google-integration
 * Estado público de la integración Google Calendar.
 */
export async function getGoogleCalendarIntegration(req, res) {
  try {
    res.json({
      success: true,
      data: googleCalendarIntegrationStatus(await googleCalendarService.getGoogleCalendarConfig())
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
 * POST /api/calendars/google-integration/connect-url
 * Genera la URL central de OAuth para Google Calendar desde el portal Ristak.
 */
export async function getGoogleCalendarConnectUrl(req, res) {
  try {
    if (!isLicenseEnforced()) {
      return res.status(400).json({
        success: false,
        error: 'OAuth de Google Calendar requiere el portal de Ristak configurado.'
      });
    }

    const data = await createCentralGoogleCalendarConnectUrl({
      returnPath: sanitizeGoogleCalendarReturnPath(req.body?.returnPath || req.body?.return_path),
      appUrl: getGoogleCalendarOAuthAppUrl(req)
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
 * POST /api/calendars/google-integration/connect/claim
 * Reclama el handoff OAuth de Google y guarda el refresh token cifrado local.
 */
export async function claimGoogleCalendarOAuth(req, res) {
  try {
    const handoffToken = req.body?.handoffToken || req.body?.handoff_token || '';
    const config = await googleCalendarService.claimGoogleCalendarOAuthHandoff(handoffToken);

    await localCalendarService.reconcileCalendarDefaults().catch(error => {
      logger.warn(`[Calendars Controller] No se pudo reconciliar calendario predeterminado tras OAuth Google: ${error.message}`);
    });
    await syncRegisteredIntegrationCronsForProvider('google-calendar', { reason: 'google-calendar-connected' });

    res.json({
      success: true,
      data: config
    });
  } catch (error) {
    logger.warn(`[Calendars Controller] No se pudo reclamar OAuth Google Calendar: ${error.message}`);
    res.status(error.status || 400).json({
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
    const calendar = await googleCalendarService.updateLocalCalendarGoogleSync({ calendarId: id, googleCalendarId });

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
      await disconnectCentralGoogleCalendar().catch(error => {
        logger.warn(`[Calendars Controller] No se pudo limpiar metadata central de Google: ${error.message}`);
      });
      await googleCalendarService.deleteGoogleCalendarConfig();
      await localCalendarService.reconcileCalendarDefaults().catch(error => {
        logger.warn(`[Calendars Controller] No se pudo reconciliar calendario predeterminado tras desconectar Google central: ${error.message}`);
      });
      await syncRegisteredIntegrationCronsForProvider('google-calendar', { reason: 'google-calendar-disconnected' });
      return res.json({
        success: true,
        data: await googleCalendarService.getGoogleCalendarConfig()
      });
    }

    await googleCalendarService.deleteGoogleCalendarConfig();
    await localCalendarService.reconcileCalendarDefaults().catch(error => {
      logger.warn(`[Calendars Controller] No se pudo reconciliar calendario predeterminado tras desconectar Google: ${error.message}`);
    });
    await syncRegisteredIntegrationCronsForProvider('google-calendar', { reason: 'google-calendar-disconnected' });
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
  const rawPhone = cleanString(contact.phone);
  const phone = rawPhone ? await normalizePhoneForAccount(rawPhone) || rawPhone : '';

  if (!fullName) {
    const error = new Error('El nombre es requerido');
    error.status = 400;
    throw error;
  }

  if ((!phone || phone.replace(/[^\d]/g, '').length < 7) && !email) {
    const error = new Error('El telefono o correo es requerido');
    error.status = 400;
    throw error;
  }

  const byPhone = phone ? await findContactByPhoneCandidates(phone).catch(() => null) : null;
  const byEmail = !byPhone && email
    ? await db.get('SELECT id FROM contacts WHERE LOWER(email) = LOWER(?) ORDER BY updated_at DESC LIMIT 1', [email]).catch(() => null)
    : null;
  const contactId = byPhone?.id || byEmail?.id || generateContactId();
  const names = splitName(fullName);
  const phoneUpsert = phone ? await prepareContactPhoneUpsert({ contactId, phone }) : { phone: null };

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

  if (phone) await finalizePreparedPhoneUpsert(phoneUpsert, contactId);
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
    const resolvedTimezone = cleanString(timezone) || await getAccountTimezone();
    const slots = await getCalendarFreeSlotsForPublic(calendar, {
      startDate,
      endDate,
      timezone: resolvedTimezone
    });

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
 * GET /api/calendars/public/:slug/contact-prefill
 * Devuelve datos editables para autollenar el formulario público del calendario.
 */
export async function getPublicContactPrefill(req, res) {
  try {
    const { slug } = req.params;
    await ensurePublicCalendarRequest(req, slug);

    const contact = await resolvePublicPrefillContact({
      contactId: req.query?.contactId || req.query?.contact_id,
      visitorId: req.query?.visitorId || req.query?.visitor_id,
      sessionId: req.query?.sessionId || req.query?.session_id
    });

    res.json({
      success: true,
      data: contact
    });
  } catch (error) {
    logger.warn(`[Calendars Controller] Prefill publico rechazado: ${error.message}`);
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
    const context = await getHighLevelContext(req, {});
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
    const startDate = dateKeyFromDate(start, timezone);
    const endDate = addDateOnlyDays(startDate, 1);
    const availableSlots = await getCalendarFreeSlotsForPublic(calendar, {
      startDate,
      endDate,
      timezone
    });
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

    const bookingForm = await localCalendarService.getCalendarBookingFormDefinition(calendar);
    const bookingSubmission = localCalendarService.normalizeCalendarBookingSubmission(bookingForm, body);
    if (bookingSubmission.errors.length) {
      return res.status(400).json({
        success: false,
        error: bookingSubmission.errors.join(', ')
      });
    }

    // (CAL-QUAL) Calificación: si las respuestas descalifican al prospecto, NO se agenda.
    // Respondemos 200 con un payload de descalificación para que el cliente muestre el
    // mensaje del formulario (o redirija). No se crea contacto ni cita.
    if (bookingSubmission.disqualified) {
      return res.status(200).json({
        success: false,
        disqualified: true,
        message: bookingSubmission.disqualifyMessage || 'Gracias por tus respuestas. Por ahora no podemos agendar tu cita.',
        redirectUrl: bookingSubmission.disqualifyRedirectUrl || '',
        html: bookingSubmission.disqualifyHtml || ''
      });
    }

    const bookingPayment = resolveCalendarBookingPayment(calendar, bookingForm);
    let paymentGateStatus = null;
    if (isPaymentGateEnabled(bookingPayment)) {
      const paymentResult = await resolveCalendarPaymentGate({
        req,
        body,
        calendar,
        bookingPayment,
        bookingSubmission,
        start,
        timezone
      });

      if (!paymentResult.paid) {
        return res.status(200).json({
          success: true,
          data: {
            calendarId: calendar.id,
            ...paymentResult.response
          }
        });
      }

      paymentGateStatus = paymentResult.status;
    }

    const contactId = await upsertPublicCalendarContact({
      calendar,
      host,
      sourceUrl: body.sourceUrl || body.source_url,
      contact: bookingSubmission.contact
    });

    const durationMinutes = Math.max(1, Number(calendar.slotDuration || 60));
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
    const submittedNotes = [
      bookingSubmission.notes,
      bookingSubmission.responseSummary ? `Respuestas del formulario:\n${bookingSubmission.responseSummary}` : ''
    ].filter(Boolean).join('\n\n');
    const publicAppointmentData = {
      contactId,
      calendarId: calendar.id,
      appointmentStatus: calendar.autoConfirm ? 'confirmed' : 'pending',
      status: calendar.autoConfirm ? 'confirmed' : 'pending',
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      timeZone: timezone,
      notes: submittedNotes,
      formId: bookingSubmission.formId,
      formName: bookingSubmission.formName,
      formResponses: bookingSubmission.responses,
      paymentGate: paymentGateStatus
        ? {
            publicPaymentId: paymentGateStatus.publicPaymentId,
            provider: paymentGateStatus.provider,
            amount: paymentGateStatus.amount,
            currency: paymentGateStatus.currency,
            paidAt: paymentGateStatus.paidAt
          }
        : null
    };
    // El render de variables de plantilla es cosmético y NUNCA debe impedir agendar
    // desde el calendario público: si falla, degradamos a valores planos.
    let renderedTemplates;
    try {
      renderedTemplates = await renderCalendarAppointmentTemplates({
        calendar,
        appointmentData: publicAppointmentData,
        titleTemplate: calendar.eventTitle || calendar.name || 'Cita',
        notesTemplate: calendar.notes || publicAppointmentData.notes
      });
    } catch (error) {
      logger.warn(`[Calendars Controller] No se pudieron renderizar plantillas de cita pública, uso valores planos: ${error.message}`);
      renderedTemplates = {
        title: calendar.eventTitle || calendar.name || 'Cita',
        notes: calendar.notes || publicAppointmentData.notes || ''
      };
    }
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

    const customEvents = localCalendarService.normalizeCalendarCustomEventsConfig(calendar.customEvents || {});
    let metaEvent = null;
    let metaFiredViaSite = false;

    // El SITIO es master del evento Meta "al agendar" del calendario embebido: si el sitio
    // contenedor propago un evento (metaCalEvent -> body.meta.siteEventName), fuerza el disparo
    // por canal Meta web (site) con ese evento, aunque el calendario tenga Meta apagado o en
    // whatsapp. Anti-spoofing: solo se aceptan eventos de la whitelist. El mismo event_id que
    // el pixel (calendar_{calId}_{apptId}) garantiza que Meta deduplique a 1 conversion.
    const CALENDAR_META_OVERRIDE_EVENTS = new Set(['Schedule', 'Lead', 'Contact', 'CompleteRegistration', 'FormSubmitted']);
    const rawSiteEventName = typeof body?.meta?.siteEventName === 'string' ? body.meta.siteEventName.trim() : '';
    const siteEventNameOverride = CALENDAR_META_OVERRIDE_EVENTS.has(rawSiteEventName) ? rawSiteEventName : '';
    const siteEventParametersOverride = body?.meta?.siteEventParameters &&
      typeof body.meta.siteEventParameters === 'object' &&
      !Array.isArray(body.meta.siteEventParameters)
      ? body.meta.siteEventParameters
      : {};

    if (siteEventNameOverride) {
      metaFiredViaSite = true;
      metaEvent = await sendCalendarBookingSiteMetaEvent({
        calendar,
        appointment,
        contactId,
        contact: {
          fullName: bookingSubmission.contact.name,
          phone: bookingSubmission.contact.phone,
          email: bookingSubmission.contact.email
        },
        requestMeta: buildPublicCalendarMetaRequest(req, body),
        siteOverride: { eventName: siteEventNameOverride, parameters: siteEventParametersOverride }
      }).catch(error => {
        logger.warn(`[Calendars Controller] No se pudo disparar evento Meta (override de sitio) para cita publica: ${error.message}`);
        return null;
      });
    } else {
      const resolvedCustomEvent = customEvents.enabled
        ? await resolveCalendarCustomEventChannel({ customEvents, contactId })
        : { channel: 'whatsapp', reason: 'global_whatsapp_config' };

      if (customEvents.enabled && resolvedCustomEvent.channel === 'site') {
        metaFiredViaSite = true;
        const siteCustomEvents = getCustomEventsForResolvedChannel(customEvents, 'site');
        metaEvent = await sendCalendarBookingSiteMetaEvent({
          calendar: { ...calendar, customEvents: siteCustomEvents },
          appointment,
          contactId,
          contact: {
            fullName: bookingSubmission.contact.name,
            phone: bookingSubmission.contact.phone,
            email: bookingSubmission.contact.email
          },
          requestMeta: buildPublicCalendarMetaRequest(req, body)
        }).catch(error => {
          logger.warn(`[Calendars Controller] No se pudo disparar evento Meta web para cita publica: ${error.message}`);
          return null;
        });
      } else {
        metaEvent = await triggerWhatsappAppointmentBookedEvent(contactId, {
          calendarId: calendar.id,
          calendarName: calendar.name,
          appointmentId: appointment.id,
          customEvents: customEvents.enabled ? getCustomEventsForResolvedChannel(customEvents, 'whatsapp') : undefined
        }).catch(error => {
          logger.warn(`[Calendars Controller] No se pudo disparar evento WhatsApp para cita publica: ${error.message}`);
          return null;
        });
      }
    }

    await sendCalendarAppointmentNotification(appointment, {
      calendarId: calendar.id,
      calendarName: calendar.name,
      source: 'public_calendar'
    }).catch(error => {
      logger.warn(`[Calendars Controller] No se pudo enviar push de cita publica: ${error.message}`);
    });

    const bookingCompletion = localCalendarService.normalizeCalendarBookingCompletionConfig(calendar.bookingCompletion || {});

    res.status(201).json({
      success: true,
      data: {
        appointment,
        message: bookingCompletion.message,
        bookingCompletion,
        contact: {
          contactId,
          name: bookingSubmission.contact.name,
          email: bookingSubmission.contact.email,
          phone: bookingSubmission.contact.phone
        },
        paymentGate: paymentGateStatus
          ? {
              publicPaymentId: paymentGateStatus.publicPaymentId,
              provider: paymentGateStatus.provider,
              amount: paymentGateStatus.amount,
              currency: paymentGateStatus.currency,
              paidAt: paymentGateStatus.paidAt
            }
          : null,
        metaEvent: metaFiredViaSite && metaEvent?.eventId
          ? {
              eventId: metaEvent.eventId,
              eventName: metaEvent.eventName || siteEventNameOverride || getCustomEventsForResolvedChannel(customEvents, 'site').eventName,
              appointmentId: appointment.id,
              status: appointment.appointmentStatus || appointment.status || 'booked'
            }
          : null
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

    // (APT-004) Sin HighLevel: devolver los bloqueos NATIVOS guardados localmente.
    if (!accessToken) {
      const toIso = (epoch) => {
        const n = parseInt(epoch, 10);
        return Number.isFinite(n) ? new Date(n).toISOString() : null;
      };
      const data = await localCalendarService.listLocalBlockedSlots({
        calendarId,
        startTime: startTime ? toIso(startTime) : null,
        endTime: endTime ? toIso(endTime) : null
      });
      return res.json({ success: true, data });
    }

    if (!locationId || !startTime || !endTime) {
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

    // (APT-004) Sin HighLevel: crear un bloqueo NATIVO (calendarios Ristak/Google).
    // Se respeta en checkSlotAvailability para impedir agendar sobre ese horario.
    if (!accessToken) {
      const startTime = blockData.startTime || blockData.start_time || blockData.startTimeUtc;
      const endTime = blockData.endTime || blockData.end_time || blockData.endTimeUtc;
      if (!startTime || !endTime) {
        return res.status(400).json({ success: false, error: 'Se requiere startTime y endTime para el bloqueo' });
      }
      const blockedSlot = await localCalendarService.createLocalBlockedSlot({
        calendarId: blockData.calendarId || blockData.calendar_id || req.params.calendarId || null,
        startTime,
        endTime,
        title: blockData.title || blockData.reason || blockData.name || null
      });
      return res.status(201).json({ success: true, data: blockedSlot });
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

    // (APT-004) Sin HighLevel: actualizar el bloqueo NATIVO local (calendarios Ristak/Google).
    if (!accessToken) {
      const startTime = updateData.startTime || updateData.start_time || updateData.startTimeUtc || null;
      const endTime = updateData.endTime || updateData.end_time || updateData.endTimeUtc || null;
      const title = updateData.title ?? updateData.reason ?? updateData.name;
      const ok = await localCalendarService.updateLocalBlockedSlot({ id, startTime, endTime, title });
      if (!ok) {
        return res.status(404).json({ success: false, error: 'Bloqueo no encontrado' });
      }
      return res.json({ success: true, data: { id, startTime, endTime, title } });
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
    // El render de variables de plantilla (título/notas) es cosmético y NUNCA debe
    // impedir crear la cita: si falla, degradamos a valores planos.
    let renderedTemplates;
    try {
      renderedTemplates = await renderCalendarAppointmentTemplates({
        calendar: localCalendar || {},
        appointmentData,
        titleTemplate: appointmentData.title || localCalendar?.eventTitle || localCalendar?.name || 'Cita',
        notesTemplate: localCalendar?.notes || appointmentData.notes || appointmentData.description || ''
      });
    } catch (error) {
      logger.warn(`[Calendars Controller] No se pudieron renderizar plantillas de cita, uso valores planos: ${error.message}`);
      renderedTemplates = {
        title: appointmentData.title || localCalendar?.eventTitle || localCalendar?.name || 'Cita',
        notes: localCalendar?.notes || appointmentData.notes || appointmentData.description || ''
      };
    }
    const localAppointmentData = {
      ...appointmentData,
      title: renderedTemplates.title,
      notes: renderedTemplates.notes
    };

    // (APT-001) Validar disponibilidad del slot antes de crear: evita doble-booking
    // silencioso desde el modal admin. Si el slot ya alcanzó su límite respondemos 409,
    // salvo que venga una bandera explícita para forzar (ignoreAppointmentConflicts).
    const forceDoubleBooking = appointmentData.ignoreAppointmentConflicts === true
      || appointmentData.confirmDoubleBooking === true;
    if (!forceDoubleBooking && (localCalendar?.id || appointmentData.calendarId || appointmentData.calendar_id)) {
      // El chequeo de cupo solo debe BLOQUEAR ante un conflicto real (409). Si la propia
      // verificación falla por un error inesperado, NO impedimos crear la cita (fail-open):
      // el límite anti-doble-reserva es una salvaguarda, no una puerta que tumbe el agendado.
      let availability = { available: true };
      try {
        availability = await localCalendarService.checkSlotAvailability(
          localCalendar?.id || appointmentData.calendarId || appointmentData.calendar_id,
          localAppointmentData.startTime || localAppointmentData.start_time,
          localAppointmentData.endTime || localAppointmentData.end_time
        );
      } catch (error) {
        logger.warn(`[Calendars Controller] No se pudo verificar disponibilidad del slot, permito crear: ${error.message}`);
      }
      if (!availability.available) {
        return res.status(409).json({
          success: false,
          code: 'slot_unavailable',
          error: 'Ese horario ya alcanzó el límite de citas. Elige otro horario o confirma el sobreagendamiento.',
          data: { limit: availability.limit, overlapping: availability.overlapping }
        });
      }
    }

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
      const customEvents = localCalendarService.normalizeCalendarCustomEventsConfig(localCalendar?.customEvents || {});
      const resolvedCustomEvent = customEvents.enabled
        ? await resolveCalendarCustomEventChannel({ customEvents, contactId })
        : { channel: 'whatsapp', reason: 'global_whatsapp_config', contact: null };

      if (customEvents.enabled && resolvedCustomEvent.channel === 'site') {
        const metaContact = resolvedCustomEvent.contact || await getCalendarContactForMeta(contactId) || {};
        await sendCalendarBookingSiteMetaEvent({
          calendar: { ...(localCalendar || {}), customEvents: getCustomEventsForResolvedChannel(customEvents, 'site') },
          appointment,
          contactId,
          contact: metaContact,
          requestMeta: buildPublicCalendarMetaRequest(req, req.body || {})
        }).catch(error => {
          logger.warn(`[Calendars Controller] No se pudo disparar evento Meta web para cita: ${error.message}`);
          return null;
        });
      } else {
        await triggerWhatsappAppointmentBookedEvent(contactId, {
          calendarId: appointment?.calendarId || appointmentData.calendarId || appointmentData.calendar_id,
          calendarName: localCalendar?.name || appointmentData.calendarName || '',
          appointmentId: appointment?.id,
          customEvents: customEvents.enabled ? getCustomEventsForResolvedChannel(customEvents, 'whatsapp') : undefined
        }).catch(error => {
          logger.warn(`[Calendars Controller] No se pudo disparar evento WhatsApp para cita: ${error.message}`);
          return null;
        });
      }
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

    // (APT-006) Normaliza el nuevo estado ANTES de hablar con HL. El front puede
    // mandar el estado como status / appointmentStatus / appointment_status; usamos
    // el MISMO patrón que más abajo (previousStatus/nextStatus). Si el nuevo estado
    // es 'cancelled' nos aseguramos de que el payload a HL lleve appointmentStatus
    // para que highlevelCalendarService.mapAppointmentStatus lo reciba y propague la
    // cancelación remota en este mismo PUT. NO duplicamos el mapeo de status aquí.
    const incomingStatus = String(
      updateData.appointmentStatus || updateData.appointment_status || updateData.status || ''
    ).trim().toLowerCase();
    if (incomingStatus === 'cancelled' && !updateData.appointmentStatus && !updateData.appointment_status) {
      updateData.appointmentStatus = incomingStatus;
    }

    // (APT-006) Token de fallback: cuando un admin cancela por cambio de estado puede
    // NO venir accessToken en el body. Si la cita está vinculada a HL pero no tenemos
    // token en el contexto, intentamos el token guardado (highlevel_config) para poder
    // propagar la cancelación en vez de dejarla solo local.
    if (existing?.ghlAppointmentId && !context.accessToken) {
      const saved = await getSavedHighLevelOnlyContext().catch(() => null);
      if (saved?.accessToken) {
        context.accessToken = saved.accessToken;
        if (!context.locationId && saved.locationId) {
          context.locationId = saved.locationId;
        }
      }
    }

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

    // (APT-003) Si la cita se reprogramó (cambió start_time), olvidar recordatorios ya
    // registrados para que el cron recalcule/reenvíe en la nueva fecha. La ruta GHL hace
    // upsert directo (sin pasar por updateLocalAppointment), por eso lo cubrimos aquí también.
    const prevStartMs = new Date(existing?.startTime || existing?.start_time).getTime();
    const nextStartMs = new Date(appointment?.startTime || appointment?.start_time).getTime();
    const appointmentStartChanged = Number.isFinite(prevStartMs) && Number.isFinite(nextStartMs) && prevStartMs !== nextStartMs;
    try {
      if (appointmentStartChanged && (appointment?.id || id)) {
        const { clearAppointmentReminderSends } = await import('../services/appointmentRemindersService.js');
        await clearAppointmentReminderSends(appointment?.id || id);
      }
    } catch (error) {
      logger.warn(`[Calendars Controller] No se pudieron limpiar recordatorios tras reprogramar: ${error.message}`);
    }

    const previousStatus = String(existing?.appointmentStatus || existing?.appointment_status || existing?.status || '').trim().toLowerCase();
    const nextStatus = String(appointment?.appointmentStatus || appointment?.appointment_status || appointment?.status || updateData.appointmentStatus || updateData.appointment_status || updateData.status || '').trim().toLowerCase();
    const previousCancelled = ['cancelled', 'canceled'].includes(previousStatus);
    const nextCancelled = ['cancelled', 'canceled'].includes(nextStatus);
    const notificationContext = {
      appointmentId: appointment?.id || id,
      calendarId: appointment?.calendarId || appointment?.calendar_id || existing?.calendarId || existing?.calendar_id,
      calendarName: appointment?.calendarName || appointment?.calendar_name || existing?.calendarName || existing?.calendar_name || '',
      source: 'admin_calendar_status'
    };
    if (nextCancelled && !previousCancelled) {
      await sendAppointmentStatusNotification(appointment, {
        ...notificationContext,
        eventType: 'cancelled'
      }).catch(error => {
        logger.warn(`[Calendars Controller] No se pudo enviar push de cita cancelada: ${error.message}`);
      });
    } else if (appointmentStartChanged) {
      await sendAppointmentStatusNotification(appointment, {
        ...notificationContext,
        eventType: 'rescheduled'
      }).catch(error => {
        logger.warn(`[Calendars Controller] No se pudo enviar push de cita reprogramada: ${error.message}`);
      });
    } else if (nextStatus === 'confirmed' && previousStatus !== 'confirmed') {
      await sendAppointmentConfirmationNotification(appointment, {
        ...notificationContext
      }).catch(error => {
        logger.warn(`[Calendars Controller] No se pudo enviar push de cita confirmada: ${error.message}`);
      });
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
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'Calendario no encontrado'
      });
    }

    const paymentSourceConflict = await findCalendarPaymentSourceConflict(existing, updateData);
    if (paymentSourceConflict) {
      return res.status(400).json({
        success: false,
        error: 'Ese formulario ya tiene cobro activo. Desactiva el cobro del calendario o elige un formulario sin cobro.'
      });
    }

    let calendar = await localCalendarService.updateLocalCalendar(id, updateData, { syncStatus: 'pending' });

    const remoteCalendarId = existing?.ghlCalendarId || id;
    if (context.accessToken && remoteCalendarId && existing?.ghlCalendarId) {
      try {
        const {
          bookingForm,
          bookingCompletion,
          bookingPayment,
          customEvents,
          antiTrackingEnabled,
          anti_tracking_enabled,
          ...remoteUpdateData
        } = updateData;
        const preservedBookingForm = bookingForm || calendar?.bookingForm || existing?.bookingForm;
        const preservedBookingCompletion = bookingCompletion || calendar?.bookingCompletion || existing?.bookingCompletion;
        const preservedBookingPayment = bookingPayment || calendar?.bookingPayment || existing?.bookingPayment;
        const preservedCustomEvents = customEvents || calendar?.customEvents || existing?.customEvents;
        const remote = await calendarService.updateCalendar(remoteCalendarId, remoteUpdateData, context.accessToken);
        calendar = await localCalendarService.upsertLocalCalendar(remote.calendar || remote, {
          id: existing.id,
          source: existing.source,
          ghlCalendarId: remoteCalendarId,
          locationId: context.locationId || existing.locationId,
          syncStatus: 'synced',
          rawJson: {
            ...(remote && typeof remote === 'object' ? remote : {}),
            bookingForm: preservedBookingForm,
            bookingCompletion: preservedBookingCompletion,
            bookingPayment: preservedBookingPayment,
            customEvents: preservedCustomEvents
          }
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

    // (APT-004) Sin HighLevel: eliminar el bloqueo NATIVO local (calendarios Ristak/Google).
    if (!accessToken) {
      const ok = await localCalendarService.deleteLocalBlockedSlot(id);
      if (!ok) {
        return res.status(404).json({ success: false, error: 'Bloqueo no encontrado' });
      }
      return res.json({ success: true, message: 'Blocked slot eliminado exitosamente' });
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
  testGoogleCalendarIntegration,
  syncGoogleCalendarIntegration,
  getGoogleCalendarMergePreview,
  mergeGoogleCalendarAppointments,
  deleteGoogleCalendarIntegration
};
