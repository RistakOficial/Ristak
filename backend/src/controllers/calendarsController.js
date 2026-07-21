import crypto from 'crypto';
import * as calendarService from '../services/highlevelCalendarService.js';
import * as localCalendarService from '../services/localCalendarService.js';
import * as googleCalendarService from '../services/googleCalendarService.js';
import { logger } from '../utils/logger.js';
import GHLClient, { getGHLClient } from '../services/ghlClient.js';
import { db } from '../config/database.js';
import { getAccountTimezone } from '../utils/dateUtils.js';
import { triggerWhatsappAppointmentBookedEvent } from '../services/metaWhatsappEventsService.js';
import { detectConversionSurface } from '../services/conversionAttributionService.js';
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
  hasCalendarPaymentsFeature,
  hasFeature,
  createCentralGoogleCalendarConnectUrl,
  disconnectCentralGoogleCalendar
} from '../services/licenseService.js';
import {
  finalizePreparedPhoneUpsert,
  findContactByPhoneCandidates,
  generateContactId,
  prepareContactPhoneUpsert,
  resolveContactIdByGhlId
} from '../services/contactIdentityService.js';
import {
  assertPaidPaymentGate,
  createPaymentGateLink,
  getPaymentGateStatus,
  isPaymentGateEnabled,
  normalizePaymentGateConfig,
  paymentGateMatches
} from '../services/publicPaymentGateService.js';
import { syncRegisteredIntegrationCronsForProvider } from '../jobs/integrationCronRegistry.js';
import { formatContactName, splitContactName } from '../utils/contactNameFormatter.js';
import {
  markTestAppointmentProviderSyncFailure,
  runIdempotentAppointmentCreation
} from '../services/appointmentCreationSafetyService.js';
import {
  assertConversationalAppointmentDepositReservationFence,
  claimConversationalTerminalMutationAuthority,
  consumeConversationalAppointmentDepositEvidence
} from '../services/conversationalAgentService.js';
import {
  dispatchAppointmentAutomationEvent,
  dispatchAppointmentCreatedAutomations
} from '../services/appointmentAutomationService.js';
import { INTERNAL_CONTROLLER_CONTEXT } from '../agents/invokeController.js';

/**
 * Controlador para calendarios de Ristak con sincronizaciones externas opcionales.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CALENDAR_EVENTS_MAX_RANGE_DAYS = 370;
const CALENDAR_MONTH_PREVIEW_MAX_RANGE_DAYS = 45;
const CALENDAR_AVAILABILITY_MAX_RANGE_DAYS = 45;
const CALENDAR_BLOCKED_SLOTS_MAX_RANGE_DAYS = 45;
const APPOINTMENT_BOOKING_CHANNELS = new Set(['whatsapp', 'whatsapp_qr', 'messenger', 'instagram', 'email']);
const HIGHLEVEL_REMOTE_OUTCOME_UNKNOWN_MARKER = '[remote_outcome_unknown]';

function createCalendarRequestAbortScope(res) {
  const controller = new AbortController();
  const onClose = () => {
    if (!res?.writableEnded && !res?.finished) controller.abort();
  };
  const observable = typeof res?.once === 'function';
  if (observable) res.once('close', onClose);
  return {
    signal: controller.signal,
    cleanup() {
      if (observable && typeof res?.off === 'function') res.off('close', onClose);
    }
  };
}

function isCalendarRequestAbort(error, signal) {
  return Boolean(signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR');
}

async function lockCalendarAppointmentCreation(calendarId) {
  // SQLite ya entra con BEGIN IMMEDIATE en db.transaction. En PostgreSQL este
  // candado transaccional serializa el bloque check+insert por calendario, aun
  // cuando una petición viene del agente v2 y la otra del admin/API legacy.
  if (!process.env.DATABASE_URL || !calendarId) return;
  await db.get(
    'SELECT pg_advisory_xact_lock(hashtext(?)) AS appointment_creation_locked',
    [String(calendarId)]
  );
}

function normalizeAppointmentBookingChannel(value) {
  const channel = cleanString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (!channel) return null;
  if (channel.includes('whatsapp_qr') || channel === 'qr' || channel.includes('baileys') || channel.includes('bailey')) return 'whatsapp_qr';
  if (channel.includes('whatsapp') || channel === 'wa' || channel.includes('waba') || channel.includes('ycloud')) return 'whatsapp';
  if (channel.includes('instagram') || channel === 'ig' || channel === 'instagram_dm') return 'instagram';
  if (channel.includes('messenger') || channel.includes('facebook') || channel === 'fb') return 'messenger';
  if (channel.includes('email') || channel.includes('correo') || channel === 'mail') return 'email';
  return APPOINTMENT_BOOKING_CHANNELS.has(channel) ? channel : null;
}

function getAppointmentBookingChannel(payload = {}) {
  return normalizeAppointmentBookingChannel(
    payload.bookingChannel || payload.booking_channel || payload.sourceChannel || payload.source_channel ||
    payload.channel || payload.source || payload.origin || payload?.meta?.bookingChannel ||
    payload?.meta?.booking_channel || payload?.meta?.sourceChannel || payload?.meta?.source_channel ||
    payload?.meta?.channel || payload?.meta?.source || payload?.meta?.origin
  );
}

function calendarRangeError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function parseEpochMillis(value, fieldName) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) {
    throw calendarRangeError(`${fieldName} inválido`);
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw calendarRangeError(`${fieldName} inválido`);
  }

  return timestamp;
}

function parseDateOnly(value, fieldName) {
  const clean = cleanString(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    throw calendarRangeError(`${fieldName} inválido`);
  }

  const [year, month, day] = clean.split('-').map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw calendarRangeError(`${fieldName} inválido`);
  }

  return { value: clean, timestamp };
}

function assertEpochRangeLimit({ startTime, endTime, maxDays, label }) {
  const start = parseEpochMillis(startTime, 'startTime');
  const end = parseEpochMillis(endTime, 'endTime');

  if (end < start) {
    throw calendarRangeError('endTime debe ser mayor o igual a startTime');
  }

  const rangeDays = Math.ceil((end - start + 1) / MS_PER_DAY);
  if (rangeDays > maxDays) {
    throw calendarRangeError(`${label} permite rangos de hasta ${maxDays} días por solicitud`);
  }

  return { start, end };
}

function assertDateOnlyRangeLimit({ startDate, endDate, maxDays, label }) {
  const start = parseDateOnly(startDate, 'startDate');
  const end = parseDateOnly(endDate, 'endDate');

  if (end.timestamp < start.timestamp) {
    throw calendarRangeError('endDate debe ser mayor o igual a startDate');
  }

  const rangeDays = Math.floor((end.timestamp - start.timestamp) / MS_PER_DAY) + 1;
  if (rangeDays > maxDays) {
    throw calendarRangeError(`${label} permite rangos de hasta ${maxDays} días por solicitud`);
  }

  return { startDate: start.value, endDate: end.value };
}

async function getSavedHighLevelConfig() {
  return db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1');
}

function isHighLevelConfigured(config = {}) {
  return Boolean(
    cleanString(config?.location_id || config?.locationId) &&
    cleanString(config?.api_token || config?.accessToken)
  );
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

function withoutGoogleCalendarLinkMutation(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const sanitized = { ...source };
  for (const key of [
    'googleCalendarId', 'google_calendar_id',
    'googleAccessRole', 'google_access_role',
    'googleCalendarSummary', 'google_calendar_summary',
    'googleCalendarTimeZone', 'google_calendar_time_zone'
  ]) {
    delete sanitized[key];
  }

  for (const rawKey of ['rawJson', 'raw_json']) {
    if (!(rawKey in sanitized)) continue;
    let parsed = sanitized[rawKey];
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch { continue; }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const safeRaw = { ...parsed };
    for (const key of [
      'googleCalendarId', 'google_calendar_id',
      'googleAccessRole', 'google_access_role',
      'googleCalendarSummary', 'google_calendar_summary',
      'googleCalendarTimeZone', 'google_calendar_time_zone'
    ]) {
      delete safeRaw[key];
    }
    sanitized[rawKey] = safeRaw;
  }
  return sanitized;
}

function normalizeCalendarAvailabilityWrite(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const hasOpenHours = Object.prototype.hasOwnProperty.call(source, 'openHours')
    || Object.prototype.hasOwnProperty.call(source, 'open_hours');
  if (!hasOpenHours) return source;

  const normalized = { ...source };
  normalized.openHours = localCalendarService.normalizeCalendarOpenHoursForWrite(
    source.openHours ?? source.open_hours
  );
  normalized.availabilityScheduleConfigured = true;
  delete normalized.open_hours;
  delete normalized.availability_schedule_configured;
  return normalized;
}

async function markAppointmentMirrorSyncError({
  appointmentId,
  provider,
  message,
  expectedAppointment = null
} = {}) {
  const normalizedAppointmentId = cleanString(appointmentId);
  if (!normalizedAppointmentId) return null;
  const safeMessage = cleanString(message || 'El espejo externo no confirmó la sincronización.').slice(0, 1000);
  if (provider !== 'google') {
    return localCalendarService.markHighLevelAppointmentMirrorError(
      normalizedAppointmentId,
      safeMessage,
      { expectedAppointment }
    );
  }

  if (!expectedAppointment) {
    await db.run(`
      UPDATE appointments
      SET google_sync_status = 'error', google_sync_error = ?
      WHERE id = ?
    `, [safeMessage, normalizedAppointmentId]);
    return localCalendarService.getLocalAppointment(normalizedAppointmentId);
  }

  return withAppointmentMirrorFenceLock(expectedAppointment, async () => {
    const current = await localCalendarService.getLocalAppointment(normalizedAppointmentId);
    if (!appointmentMatchesMirrorFence(current, expectedAppointment)) {
      await db.run(`
        UPDATE appointments
        SET google_sync_status = 'pending'
        WHERE id = ?
      `, [normalizedAppointmentId]);
      return localCalendarService.getLocalAppointment(normalizedAppointmentId);
    }
    await db.run(`
      UPDATE appointments
      SET google_sync_status = 'error', google_sync_error = ?
      WHERE id = ?
    `, [safeMessage, normalizedAppointmentId]);
    return localCalendarService.getLocalAppointment(normalizedAppointmentId);
  });
}

function highLevelMirrorWriteOutcomeIsAmbiguous(error) {
  if (error?.code === 'highlevel_mirror_remote_outcome_unknown') return true;
  const status = Number(error?.status || error?.statusCode || 0);
  return !status || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function appointmentMirrorFenceSnapshot(appointment = {}) {
  const instant = (value) => {
    const timestamp = new Date(value || '').getTime();
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
  };
  return {
    id: cleanString(appointment.id),
    calendarId: cleanString(appointment.calendarId || appointment.calendar_id),
    contactId: cleanString(appointment.contactId || appointment.contact_id),
    locationId: cleanString(appointment.locationId || appointment.location_id),
    title: cleanString(appointment.title),
    status: cleanString(appointment.status || appointment.appointmentStatus || appointment.appointment_status),
    appointmentStatus: cleanString(appointment.appointmentStatus || appointment.appointment_status || appointment.status),
    assignedUserId: cleanString(appointment.assignedUserId || appointment.assigned_user_id),
    notes: cleanString(appointment.notes),
    address: cleanString(appointment.address),
    startTime: instant(appointment.startTime || appointment.start_time),
    endTime: instant(appointment.endTime || appointment.end_time),
    dateUpdated: instant(appointment.dateUpdated || appointment.date_updated)
  };
}

function appointmentMatchesMirrorFence(appointment, expectedAppointment) {
  if (!appointment?.id || !expectedAppointment?.id) return false;
  return JSON.stringify(appointmentMirrorFenceSnapshot(appointment)) ===
    JSON.stringify(appointmentMirrorFenceSnapshot(expectedAppointment));
}

function appointmentProviderResponseStaleError() {
  const error = new Error('La cita volvió a cambiar mientras respondía el calendario externo. Se conservó la versión más reciente.');
  error.status = 409;
  error.statusCode = 409;
  error.code = 'appointment_provider_response_stale';
  return error;
}

async function withAppointmentMirrorFenceLock(expectedAppointment, callback) {
  const calendarId = cleanString(expectedAppointment?.calendarId || expectedAppointment?.calendar_id);
  const lockKey = calendarId || cleanString(expectedAppointment?.id);
  if (!lockKey) return callback();
  return db.transaction(async () => {
    await lockCalendarAppointmentCreation(lockKey);
    return callback();
  });
}

async function confirmHighLevelMirrorForExactLocalVersion(expectedAppointment, remoteAppointmentId) {
  const settled = await withAppointmentMirrorFenceLock(expectedAppointment, async () => {
    try {
      return {
        stale: false,
        appointment: await localCalendarService.markHighLevelAppointmentMirrorSynced(
          expectedAppointment.id,
          remoteAppointmentId,
          { expectedAppointment }
        )
      };
    } catch (error) {
      if (error?.code !== 'appointment_provider_response_stale') throw error;
      return {
        stale: true,
        appointment: await localCalendarService.getLocalAppointment(expectedAppointment.id)
      };
    }
  });

  if (settled.stale) throw appointmentProviderResponseStaleError();
  return settled.appointment;
}

async function resolveHighLevelMirrorUpdateFailure(expectedAppointment, providerError) {
  const settled = await withAppointmentMirrorFenceLock(expectedAppointment, async () => {
    const current = await localCalendarService.getLocalAppointment(expectedAppointment.id);
    const stale = !appointmentMatchesMirrorFence(current, expectedAppointment);
    if (stale) {
      await db.run(`
        UPDATE appointments
        SET sync_status = CASE
              WHEN sync_status = 'pending_delete' THEN 'pending_delete'
              ELSE 'pending'
            END
        WHERE id = ?
      `, [expectedAppointment.id]);
    } else {
      await db.run(`
        UPDATE appointments
        SET sync_status = CASE
              WHEN sync_status = 'pending_delete' THEN 'pending_delete'
              ELSE 'pending'
            END,
            sync_error = ?
        WHERE id = ?
      `, [cleanString(providerError?.message || 'HighLevel no confirmó el espejo.').slice(0, 1000), expectedAppointment.id]);
    }
    return { stale, appointment: current };
  });

  if (settled.stale) throw appointmentProviderResponseStaleError();
  return settled.appointment;
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

function disabledCalendarBookingPayment() {
  return normalizePaymentGateConfig({});
}

async function canUseCalendarCustomForms() {
  return (await hasFeature('forms')) && (await hasFeature('sites'));
}

function disabledCalendarCustomFormConfig(value = {}) {
  const config = localCalendarService.normalizeCalendarBookingFormConfig(value);
  return {
    ...config,
    useCustomForm: false,
    customFormId: ''
  };
}

async function enforceCalendarCustomFormAccess(existingCalendar = {}, updateData = {}) {
  const requestedBookingForm = updateData.bookingForm ?? updateData.booking_form;
  const nextBookingForm = requestedBookingForm ?? existingCalendar.bookingForm ?? existingCalendar.booking_form ?? {};
  const normalizedBookingForm = localCalendarService.normalizeCalendarBookingFormConfig(nextBookingForm);

  if (!normalizedBookingForm.useCustomForm) {
    return updateData;
  }

  if (await canUseCalendarCustomForms()) {
    return updateData;
  }

  if (
    requestedBookingForm !== undefined &&
    localCalendarService.normalizeCalendarBookingFormConfig(requestedBookingForm).useCustomForm
  ) {
    const error = new Error('Los formularios personalizados de calendario no están incluidos en tu plan actual.');
    error.status = 403;
    error.code = 'feature_not_available';
    throw error;
  }

  return {
    ...updateData,
    bookingForm: disabledCalendarCustomFormConfig(nextBookingForm)
  };
}

async function resolveCalendarBookingPayment(calendar = {}, bookingForm = {}) {
  const canUseCalendarPayments = await hasCalendarPaymentsFeature();
  if (!canUseCalendarPayments) return disabledCalendarBookingPayment();

  const calendarPayment = normalizePaymentGateConfig(calendar.bookingPayment || calendar.booking_payment || {});
  if (isPaymentGateEnabled(calendarPayment)) return calendarPayment;

  const formPayment = normalizePaymentGateConfig(bookingForm.paymentGate || bookingForm.payment_gate || {});
  if (isPaymentGateEnabled(formPayment)) return formPayment;

  return calendarPayment;
}

async function enforceCalendarPaymentConfigAccess(existingCalendar = {}, updateData = {}) {
  const requestedPaymentConfig = updateData.bookingPayment ?? updateData.booking_payment;
  const nextPayment = normalizePaymentGateConfig(
    requestedPaymentConfig ?? existingCalendar.bookingPayment ?? existingCalendar.booking_payment ?? {}
  );

  if (!isPaymentGateEnabled(nextPayment)) {
    return updateData;
  }

  if (await hasCalendarPaymentsFeature()) {
    return updateData;
  }

  if (requestedPaymentConfig !== undefined && isPaymentGateEnabled(normalizePaymentGateConfig(requestedPaymentConfig))) {
    const error = new Error('El cobro antes de agendar no está incluido en tu plan actual.');
    error.status = 403;
    error.code = 'feature_not_available';
    throw error;
  }

  return {
    ...updateData,
    bookingPayment: disabledCalendarBookingPayment()
  };
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

// Canal "smart" del calendario: lo decide la SUPERFICIE REAL de la conversión,
// no la atribución interna (esa la resuelve conversionAttributionService y se
// guarda como snapshot en la cita). Un booking del widget/página pública ES
// website; un booking creado desde una conversación va por ese canal.
async function resolveCalendarSmartEventChannel(contactId, surfaceHint = '') {
  const contact = await getCalendarContactForMeta(contactId);
  if (!contact) return { channel: 'site', reason: 'missing_contact', surface: 'website', contact: null };

  if (surfaceHint === 'website') {
    return { channel: 'site', reason: 'conversion_surface_website', surface: 'website', contact };
  }

  const surface = await detectConversionSurface({ contactId, contact }).catch(error => {
    logger.warn(`[Calendars Controller] No se pudo detectar superficie de conversión del contacto ${contactId}: ${error.message}`);
    return 'website';
  });

  return {
    channel: surface === 'website' ? 'site' : surface,
    reason: `conversion_surface_${surface}`,
    surface,
    contact
  };
}

async function resolveCalendarCustomEventChannel({ customEvents, contactId, surfaceHint = '' }) {
  const configuredChannel = ['whatsapp', 'messenger', 'instagram'].includes(customEvents?.channel)
    ? customEvents.channel
    : customEvents?.channel === 'smart'
      ? 'smart'
      : 'site';

  if (configuredChannel !== 'smart') {
    const contact = configuredChannel === 'site' ? await getCalendarContactForMeta(contactId) : null;
    return { channel: configuredChannel, reason: 'configured_channel', surface: '', contact };
  }

  return resolveCalendarSmartEventChannel(contactId, surfaceHint);
}

function getCustomEventsForResolvedChannel(customEvents = {}, channel = 'site') {
  return {
    ...customEvents,
    channel,
    eventName: channel === 'site' ? customEvents.eventName : 'LeadSubmitted'
  };
}

function googleCalendarIntegrationStatus(config = {}) {
  return {
    ...config,
    connectionMode: 'oauth',
    configured: true,
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
    const isAllowedPath = url.pathname === '/initialization'
      || url.pathname === '/settings/calendars'
      || url.pathname.startsWith('/settings/calendars/');
    if (!isAllowedPath) return fallback;
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
  return splitContactName(fullName);
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

async function getCalendarFreeSlotsForPublic(calendar, { startDate, endDate }) {
  const businessTimezone = await getAccountTimezone();
  return localCalendarService.getLocalFreeSlots(
    calendar.id,
    // Entre UTC-12 y UTC+14 una misma hora puede caer dos fechas de calendario
    // aparte. Calculamos ambos bordes y el cliente agrupa los instantes UTC en
    // la zona del visitante.
    addDateOnlyDays(startDate, -2),
    addDateOnlyDays(endDate, 2),
    businessTimezone,
    {
      allowDefaultOpenHours: false
    }
  );
}

/**
 * Resolución interna de disponibilidad para la ruta protegida y el agente.
 * La agenda pública conserva deliberadamente su helper local separado.
 */
function verifiedAvailabilityError(message) {
  const error = new Error(message);
  error.status = 503;
  return error;
}

function calendarAvailabilityFailureMessage(availability = {}, { reschedule = false, allowOverride = false } = {}) {
  const reason = cleanString(availability.reason).toLowerCase();
  const baseMessage = reason === 'invalid_slot'
    ? 'Ese horario no es válido.'
    : reason === 'slot_duration_mismatch'
      ? `La cita debe durar exactamente ${Number(availability.expectedDurationMinutes) || 1} minutos según este calendario.`
    : reason === 'outside_booking_window'
      ? 'Ese horario está fuera del periodo permitido por el calendario.'
      : reason === 'daily_limit_reached'
        ? 'Ese día ya alcanzó el máximo de citas permitido.'
        : reason === 'blocked'
          ? 'Ese horario está bloqueado en el calendario.'
          : reason === 'slot_conflict' && allowOverride
            ? 'Ese horario ya alcanzó el límite de citas. Elige otro horario o confirma el sobreagendamiento.'
            : 'Ese horario ya no está disponible.';
  return reschedule ? `${baseMessage} La cita conserva su horario anterior.` : baseMessage;
}

function calendarAvailabilityFailureData(availability = {}) {
  return {
    reason: cleanString(availability.reason) || 'unavailable',
    limit: availability.limit,
    overlapping: availability.overlapping,
    ...(availability.bufferConflict === true ? { bufferConflict: true } : {}),
    ...(availability.dailyLimit !== undefined ? { dailyLimit: availability.dailyLimit } : {}),
    ...(availability.appointmentsOnDay !== undefined ? { appointmentsOnDay: availability.appointmentsOnDay } : {}),
    ...(availability.earliestStart ? { earliestStart: availability.earliestStart } : {}),
    ...(availability.latestStart ? { latestStart: availability.latestStart } : {}),
    ...(availability.expectedDurationMinutes !== undefined
      ? { expectedDurationMinutes: availability.expectedDurationMinutes }
      : {}),
    ...(availability.actualDurationMinutes !== undefined
      ? { actualDurationMinutes: availability.actualDurationMinutes }
      : {}),
    ...(availability.blocked ? { blocked: true } : {})
  };
}

export function resolveCalendarAvailabilityProvider(calendar = null, requestedCalendarId = '') {
  const source = cleanString(calendar?.source).toLowerCase();
  const highLevelCalendarId = cleanString(calendar?.ghlCalendarId || calendar?.ghl_calendar_id);
  const googleCalendarId = cleanString(calendar?.googleCalendarId || calendar?.google_calendar_id);
  const usesHighLevel = Boolean(highLevelCalendarId) || source === 'ghl';
  const usesGoogle = Boolean(googleCalendarId) || source === 'google';

  if (usesHighLevel && usesGoogle) {
    return {
      provider: 'ghl_google',
      remoteCalendarId: highLevelCalendarId || null,
      googleCalendarId: googleCalendarId || null
    };
  }
  // Un calendario creado en Ristak conserva source=ristak aunque ya tenga espejo
  // remoto. El ID ligado, no el source, determina dónde vive su disponibilidad.
  if (usesHighLevel) {
    return { provider: 'ghl', remoteCalendarId: highLevelCalendarId || null };
  }
  if (usesGoogle) {
    return { provider: 'google', remoteCalendarId: googleCalendarId || null };
  }
  // Compatibilidad con llamadas legacy que todavía mandan directamente un ID GHL.
  if (!calendar && cleanString(requestedCalendarId)) {
    return { provider: 'ghl', remoteCalendarId: cleanString(requestedCalendarId), remoteOnly: true };
  }
  return { provider: 'local', remoteCalendarId: null };
}

function canonicalAvailabilityInstant(value) {
  const candidate = value && typeof value === 'object'
    ? (value.startTime || value.start_time || value.datetime || value.dateTime)
    : value;
  const timestamp = new Date(candidate || '').getTime();
  return Number.isFinite(timestamp) ? String(timestamp) : '';
}

export function intersectCalendarAvailabilitySlots(localDays = [], remoteDays = []) {
  const remoteInstants = new Set(
    (Array.isArray(remoteDays) ? remoteDays : [])
      .flatMap(day => Array.isArray(day?.slots) ? day.slots : [])
      .map(canonicalAvailabilityInstant)
      .filter(Boolean)
  );

  return (Array.isArray(localDays) ? localDays : []).map(day => {
    const seen = new Set();
    const slots = (Array.isArray(day?.slots) ? day.slots : []).filter(slot => {
      const instant = canonicalAvailabilityInstant(slot);
      if (!instant || !remoteInstants.has(instant) || seen.has(instant)) return false;
      seen.add(instant);
      return true;
    });
    return { ...day, slots };
  });
}

export async function resolveCalendarAvailabilitySlots({
  calendar = null,
  requestedCalendarId = '',
  startDate,
  endDate,
  timezone,
  accessToken = null,
  requireVerifiedExternalAvailability = false,
  availabilityOptions = {}
} = {}, dependencies = {}) {
  const getLocalSlots = dependencies.getLocalFreeSlots || localCalendarService.getLocalFreeSlots;
  const getHighLevelSlots = dependencies.getHighLevelFreeSlots || calendarService.getFreeSlots;
  const syncGoogleSlots = dependencies.syncGoogleEventsForDateRange || googleCalendarService.syncGoogleEventsForDateRange;
  const provider = resolveCalendarAvailabilityProvider(calendar, requestedCalendarId);
  const localCalendarId = cleanString(calendar?.id || requestedCalendarId);
  const cleanAccessToken = cleanString(accessToken);
  const localAvailabilityOptions = availabilityOptions.allowDefaultOpenHours === false
    ? availabilityOptions
    : { allowDefaultOpenHours: false, ...availabilityOptions };
  const loadLocalSlots = () => getLocalSlots(
    localCalendarId,
    startDate,
    endDate,
    timezone,
    localAvailabilityOptions
  );

  const usesGoogle = provider.provider === 'google' || provider.provider === 'ghl_google';
  const usesHighLevel = provider.provider === 'ghl' || provider.provider === 'ghl_google';
  const linkedGoogleCalendarId = provider.provider === 'ghl_google'
    ? provider.googleCalendarId
    : provider.remoteCalendarId;

  if (!usesGoogle && !usesHighLevel) {
    return loadLocalSlots();
  }

  if (usesGoogle) {
    if (!calendar?.id || !linkedGoogleCalendarId) {
      logger.warn('[Calendars Controller] La agenda local conserva una liga Google incompleta; se usa la ocupación guardada en Ristak.');
    } else {
      try {
        const syncResult = await syncGoogleSlots({
          calendarId: calendar.id,
          startDate,
          endDate,
          timezone
        });
        if (syncResult?.enabled !== true || Number(syncResult?.linkedCalendars || 0) < 1) {
          logger.warn('[Calendars Controller] Google no confirmó la liga; se usa la ocupación local ya sincronizada.');
        }
      } catch (error) {
        logger.warn(`[Calendars Controller] Sync Google para slots falló, usando DB local: ${error.message}`);
      }
    }
  }

  // Toda agenda persistida es canónica en Ristak. Google y HighLevel son espejos:
  // sus eventos entrantes se materializan localmente por sincronización, pero una
  // caída externa nunca veta ni reemplaza la disponibilidad que valida la BD.
  if (calendar) {
    return loadLocalSlots();
  }

  // Compatibilidad legacy para llamadas que aún mandan un ID remoto sin que
  // exista una agenda local. Ese único caso sí necesita consultar HighLevel.
  if (!provider.remoteCalendarId || !cleanAccessToken) {
    if (requireVerifiedExternalAvailability) {
      throw verifiedAvailabilityError(
        !provider.remoteCalendarId
          ? 'No se pudo identificar el calendario de HighLevel ligado a esta agenda.'
          : 'No se pudo comprobar la disponibilidad actual porque HighLevel no está conectado.'
      );
    }
    return calendar ? loadLocalSlots() : [];
  }

  let remoteSlots;
  try {
    remoteSlots = await getHighLevelSlots(
      provider.remoteCalendarId,
      startDate,
      endDate,
      cleanAccessToken,
      timezone
    );
    if (!Array.isArray(remoteSlots)) {
      throw new Error('HighLevel devolvió una respuesta de disponibilidad inválida.');
    }
  } catch (error) {
    if (requireVerifiedExternalAvailability) {
      throw verifiedAvailabilityError('No se pudo comprobar la disponibilidad actual contra HighLevel.');
    }
    logger.warn(`[Calendars Controller] Free slots GHL falló, usando local: ${error.message}`);
    return calendar ? loadLocalSlots() : [];
  }

  return remoteSlots;
}

export function getCalendarAppointmentDurationMinutes(calendar = {}) {
  return Math.max(1, localCalendarService.calendarDurationToMinutes(
    calendar.slotDuration ?? calendar.slot_duration,
    calendar.slotDurationUnit ?? calendar.slot_duration_unit,
    60
  ));
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
    res.status(error.status || 400).json({
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
    await disconnectCentralGoogleCalendar().catch(error => {
      logger.warn(`[Calendars Controller] No se pudo limpiar metadata central de Google: ${error.message}`);
    });
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

function getPublicCalendarContactIdentity(body = {}) {
  const meta = body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta) ? body.meta : {};
  return {
    contactId: cleanString(body.contactId || body.contact_id || meta.contactId || meta.contact_id),
    visitorId: cleanString(body.visitorId || body.visitor_id || meta.visitorId || meta.visitor_id),
    sessionId: cleanString(body.sessionId || body.session_id || meta.sessionId || meta.session_id)
  };
}

async function resolveTrustedPublicCalendarContactId(body = {}) {
  const identity = getPublicCalendarContactIdentity(body);
  if (!identity.contactId) return '';

  const resolved = await resolvePublicPrefillContact(identity).catch(error => {
    logger.warn(`[Calendars Controller] No se pudo validar contactId público ${identity.contactId}: ${error.message}`);
    return null;
  });

  return resolved?.contactId === identity.contactId ? identity.contactId : '';
}

async function upsertPublicCalendarContact({ calendar, contact, host, sourceUrl, explicitContactId = '' }) {
  const fullName = formatContactName(cleanString(contact.name || contact.fullName));
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

  const explicitContact = explicitContactId
    ? await db.get('SELECT id FROM contacts WHERE id = ? LIMIT 1', [explicitContactId]).catch(() => null)
    : null;
  const byEmail = !explicitContact && email
    ? await db.get('SELECT id FROM contacts WHERE LOWER(email) = LOWER(?) ORDER BY updated_at DESC LIMIT 1', [email]).catch(() => null)
    : null;
  const byPhone = !explicitContact && !byEmail && phone ? await findContactByPhoneCandidates(phone).catch(() => null) : null;
  const contactId = explicitContact?.id || byEmail?.id || byPhone?.id || generateContactId();
  const overwriteContactFields = Boolean(explicitContact?.id);
  const emailConflict = overwriteContactFields && email
    ? await db.get('SELECT id FROM contacts WHERE LOWER(email) = LOWER(?) AND id != ? LIMIT 1', [email, contactId]).catch(() => null)
    : null;
  const emailForStorage = emailConflict ? '' : email;
  const names = splitName(fullName);
  const phoneUpsert = phone ? await prepareContactPhoneUpsert({ contactId, phone }) : { phone: null };

  await db.run(`
    INSERT INTO contacts (
      id, phone, email, full_name, first_name, last_name, source,
      attribution_url, attribution_session_source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      phone = CASE WHEN ? = 1 AND excluded.phone IS NOT NULL THEN excluded.phone ELSE COALESCE(NULLIF(contacts.phone, ''), excluded.phone) END,
      email = CASE WHEN ? = 1 AND excluded.email IS NOT NULL THEN excluded.email ELSE COALESCE(NULLIF(contacts.email, ''), excluded.email) END,
      full_name = CASE WHEN ? = 1 AND excluded.full_name IS NOT NULL THEN excluded.full_name ELSE COALESCE(NULLIF(contacts.full_name, ''), excluded.full_name) END,
      first_name = CASE WHEN ? = 1 AND excluded.first_name IS NOT NULL THEN excluded.first_name ELSE COALESCE(NULLIF(contacts.first_name, ''), excluded.first_name) END,
      last_name = CASE WHEN ? = 1 AND excluded.last_name IS NOT NULL THEN excluded.last_name ELSE COALESCE(NULLIF(contacts.last_name, ''), excluded.last_name) END,
      source = COALESCE(NULLIF(contacts.source, ''), excluded.source),
      attribution_url = COALESCE(NULLIF(contacts.attribution_url, ''), excluded.attribution_url),
      attribution_session_source = COALESCE(NULLIF(contacts.attribution_session_source, ''), excluded.attribution_session_source),
      updated_at = CURRENT_TIMESTAMP
  `, [
    contactId,
    phoneUpsert.phone || phone || null,
    emailForStorage || null,
    fullName,
    names.firstName || null,
    names.lastName || null,
    `ristak_calendar:${calendar.slug || calendar.id}`,
    cleanString(sourceUrl) || `https://${host}/calendar/${calendar.slug || calendar.id}`,
    'public_calendar',
    overwriteContactFields ? 1 : 0,
    overwriteContactFields ? 1 : 0,
    overwriteContactFields ? 1 : 0,
    overwriteContactFields ? 1 : 0,
    overwriteContactFields ? 1 : 0
  ]);

  if (phone) await finalizePreparedPhoneUpsert(phoneUpsert, contactId);
  return contactId;
}

/**
 * GET /api/calendars
 * Obtener todos los calendarios de la ubicación
 */
export async function getCalendars(req, res) {
  try {
    // La navegación siempre lee el espejo local. Los webhooks, crons
    // condicionales y acciones explícitas de sincronización mantienen ese
    // espejo; un GET nunca dispara tráfico ni escrituras a proveedores.
    const sourcePreference = await getCalendarSourcePreference(req.query?.sourcePreference);
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

    const formSafeCalendarData = await enforceCalendarCustomFormAccess(
      {},
      normalizeCalendarAvailabilityWrite(withoutGoogleCalendarLinkMutation(calendarData))
    );
    const safeCalendarData = await enforceCalendarPaymentConfigAccess({}, formSafeCalendarData);

    let calendar = await localCalendarService.createLocalCalendar({
      ...safeCalendarData,
      locationId: locationId || safeCalendarData.locationId
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
    res.status(error.status || 500).json({
      success: false,
      code: error.code,
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
  const requestScope = createCalendarRequestAbortScope(res);
  try {
    const { startTime, endTime, calendarId } = req.query;

    if (!startTime || !endTime) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere startTime y endTime'
      });
    }

    const range = assertEpochRangeLimit({
      startTime,
      endTime,
      maxDays: CALENDAR_EVENTS_MAX_RANGE_DAYS,
      label: 'El calendario'
    });
    // La agenda visible es una lectura local pura. La sincronización externa
    // vive en webhooks, crons registrados por integración y acciones manuales;
    // no se multiplica con cada navegación o cambio de vista.
    const events = await localCalendarService.listLocalAppointments({
      startTime: range.start,
      endTime: range.end,
      calendarId,
      signal: requestScope.signal
    });

    if (requestScope.signal.aborted) return;
    res.json({
      success: true,
      data: events
    });
  } catch (error) {
    if (isCalendarRequestAbort(error, requestScope.signal)) return;
    const log = error.status && error.status < 500 ? logger.warn : logger.error;
    log(`[Calendars Controller] Error en getEvents: ${error.message}`);
    res.status(error.status || 500).json({
      success: false,
      error: error.message
    });
  } finally {
    requestScope.cleanup();
  }
}

/** GET /api/calendars/events/month-preview - previews acotados + conteos exactos por día. */
export async function getEventsMonthPreview(req, res) {
  const requestScope = createCalendarRequestAbortScope(res);
  try {
    const { startTime, endTime, calendarId } = req.query;
    if (!calendarId || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere calendarId, startTime y endTime'
      });
    }
    const range = assertEpochRangeLimit({
      startTime,
      endTime,
      maxDays: CALENDAR_MONTH_PREVIEW_MAX_RANGE_DAYS,
      label: 'La vista mensual'
    });
    const data = await localCalendarService.listLocalAppointmentMonthPreview({
      calendarId,
      startTime: range.start,
      endTime: range.end,
      previewLimit: req.query?.previewLimit,
      signal: requestScope.signal
    });
    if (requestScope.signal.aborted) return;
    res.json({ success: true, data });
  } catch (error) {
    if (isCalendarRequestAbort(error, requestScope.signal)) return;
    const status = error.status || 500;
    const log = status < 500 ? logger.warn : logger.error;
    log(`[Calendars Controller] Error en getEventsMonthPreview: ${error.message}`);
    res.status(status).json({
      success: false,
      ...(error.code ? { code: error.code } : {}),
      error: status < 500 ? error.message : 'Error obteniendo vista mensual de citas'
    });
  } finally {
    requestScope.cleanup();
  }
}

/** GET /api/calendars/events/page - página keyset exacta para día/semana. */
export async function getEventsPage(req, res) {
  const requestScope = createCalendarRequestAbortScope(res);
  try {
    const { startTime, endTime, calendarId } = req.query;
    if (!calendarId || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere calendarId, startTime y endTime'
      });
    }
    const range = assertEpochRangeLimit({
      startTime,
      endTime,
      maxDays: CALENDAR_EVENTS_MAX_RANGE_DAYS,
      label: 'La página del calendario'
    });
    const includeCounts = !['0', 'false', 'no'].includes(String(req.query?.includeCounts || '').toLowerCase());
    const data = await localCalendarService.listVisibleLocalAppointmentsPage({
      calendarId,
      startTime: range.start,
      endTime: range.end,
      cursor: req.query?.cursor,
      limit: req.query?.limit,
      includeCounts,
      signal: requestScope.signal
    });
    if (requestScope.signal.aborted) return;
    res.json({ success: true, data });
  } catch (error) {
    if (isCalendarRequestAbort(error, requestScope.signal)) return;
    const status = error.status || 500;
    const log = status < 500 ? logger.warn : logger.error;
    log(`[Calendars Controller] Error en getEventsPage: ${error.message}`);
    res.status(status).json({
      success: false,
      ...(error.code ? { code: error.code } : {}),
      error: status < 500 ? error.message : 'Error obteniendo página de citas'
    });
  } finally {
    requestScope.cleanup();
  }
}

/** GET /api/calendars/events/day-counts - conteos exactos, cero filas de cita. */
export async function getEventDayCounts(req, res) {
  const requestScope = createCalendarRequestAbortScope(res);
  try {
    const { startTime, endTime, calendarId } = req.query;
    if (!calendarId || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere calendarId, startTime y endTime'
      });
    }
    const range = assertEpochRangeLimit({
      startTime,
      endTime,
      maxDays: CALENDAR_EVENTS_MAX_RANGE_DAYS,
      label: 'Los conteos del calendario'
    });
    const data = await localCalendarService.getLocalAppointmentDayCounts({
      calendarId,
      startTime: range.start,
      endTime: range.end,
      signal: requestScope.signal
    });
    if (requestScope.signal.aborted) return;
    res.json({ success: true, data });
  } catch (error) {
    if (isCalendarRequestAbort(error, requestScope.signal)) return;
    const status = error.status || 500;
    const log = status < 500 ? logger.warn : logger.error;
    log(`[Calendars Controller] Error en getEventDayCounts: ${error.message}`);
    res.status(status).json({
      success: false,
      error: status < 500 ? error.message : 'Error obteniendo conteos diarios de citas'
    });
  } finally {
    requestScope.cleanup();
  }
}

/** GET /api/calendars/events/overview - KPIs multi-calendario + próximas filas acotadas. */
export async function getEventsOverview(req, res) {
  const requestScope = createCalendarRequestAbortScope(res);
  try {
    const { startTime, endTime } = req.query;
    if (!startTime || !endTime) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere startTime y endTime'
      });
    }
    const range = assertEpochRangeLimit({
      startTime,
      endTime,
      maxDays: CALENDAR_EVENTS_MAX_RANGE_DAYS,
      label: 'El resumen móvil del calendario'
    });
    const data = await localCalendarService.getLocalAppointmentsOverview({
      startTime: range.start,
      endTime: range.end,
      limit: req.query?.limit,
      signal: requestScope.signal
    });
    if (requestScope.signal.aborted) return;
    res.json({ success: true, data });
  } catch (error) {
    if (isCalendarRequestAbort(error, requestScope.signal)) return;
    const status = error.status || 500;
    const log = status < 500 ? logger.warn : logger.error;
    log(`[Calendars Controller] Error en getEventsOverview: ${error.message}`);
    res.status(status).json({
      success: false,
      error: status < 500 ? error.message : 'Error obteniendo resumen móvil de citas'
    });
  } finally {
    requestScope.cleanup();
  }
}

/** GET /api/calendars/upcoming - página local, acotada y con cursor. */
export async function getUpcomingAppointments(req, res) {
  try {
    const page = await localCalendarService.listUpcomingLocalAppointmentsPage({
      calendarId: req.query?.calendarId,
      cursor: req.query?.cursor,
      limit: req.query?.limit
    });

    res.json({ success: true, data: page });
  } catch (error) {
    const status = error.status || 500;
    const log = status < 500 ? logger.warn : logger.error;
    log(`[Calendars Controller] Error en getUpcomingAppointments: ${error.message}`);
    res.status(status).json({
      success: false,
      ...(error.code ? { code: error.code } : {}),
      error: status < 500 ? error.message : 'Error obteniendo próximas citas'
    });
  }
}

/** GET /api/calendars/events/summary - KPIs locales del rango sin descargar filas. */
export async function getAppointmentStats(req, res) {
  const requestScope = createCalendarRequestAbortScope(res);
  try {
    const { startTime, endTime, calendarId } = req.query;
    if (!calendarId || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere calendarId, startTime y endTime'
      });
    }

    const range = assertEpochRangeLimit({
      startTime,
      endTime,
      maxDays: CALENDAR_EVENTS_MAX_RANGE_DAYS,
      label: 'El resumen del calendario'
    });
    const stats = await localCalendarService.getLocalAppointmentStats({
      calendarId,
      startTime: range.start,
      endTime: range.end,
      signal: requestScope.signal
    });

    if (requestScope.signal.aborted) return;
    res.json({ success: true, data: stats });
  } catch (error) {
    if (isCalendarRequestAbort(error, requestScope.signal)) return;
    const status = error.status || 500;
    const log = status < 500 ? logger.warn : logger.error;
    log(`[Calendars Controller] Error en getAppointmentStats: ${error.message}`);
    res.status(status).json({
      success: false,
      error: status < 500 ? error.message : 'Error obteniendo resumen de citas'
    });
  } finally {
    requestScope.cleanup();
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
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere startDate y endDate'
      });
    }

    const range = assertDateOnlyRangeLimit({
      startDate,
      endDate,
      maxDays: CALENDAR_AVAILABILITY_MAX_RANGE_DAYS,
      label: 'La disponibilidad'
    });
    const { calendar } = await ensurePublicCalendarRequest(req, slug);
    const slots = await getCalendarFreeSlotsForPublic(calendar, {
      startDate: range.startDate,
      endDate: range.endDate
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

    const businessTimezone = await getAccountTimezone();
    const timezone = cleanString(body.timezone) || businessTimezone;
    const startDate = dateKeyFromDate(start, businessTimezone);
    const endDate = addDateOnlyDays(startDate, 1);
    const availableSlots = await getCalendarFreeSlotsForPublic(calendar, {
      startDate,
      endDate
    });
    const requestedMs = start.getTime();
    const isAvailable = availableSlots
      .flatMap(day => Array.isArray(day.slots) ? day.slots : [])
      .some(slot => new Date(slot).getTime() === requestedMs);

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

    const bookingPayment = await resolveCalendarBookingPayment(calendar, bookingForm);
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

    const trustedContactId = await resolveTrustedPublicCalendarContactId(body);
    const contactId = await upsertPublicCalendarContact({
      calendar,
      host,
      sourceUrl: body.sourceUrl || body.source_url,
      contact: bookingSubmission.contact,
      explicitContactId: trustedContactId
    });

    const durationMinutes = getCalendarAppointmentDurationMinutes(calendar);
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
    const submittedNotes = [
      bookingSubmission.notes,
      bookingSubmission.responseSummary ? `Respuestas del formulario:\n${bookingSubmission.responseSummary}` : ''
    ].filter(Boolean).join('\n\n');
    const publicAppointmentData = {
      contactId,
      calendarId: calendar.id,
      bookingChannel: getAppointmentBookingChannel(body),
      appointmentStatus: calendar.autoConfirm ? 'confirmed' : 'pending',
      status: calendar.autoConfirm ? 'confirmed' : 'pending',
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      timeZone: businessTimezone,
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
    // Revalidación FINAL bajo el mismo candado transaccional del admin/agente.
    // La lectura previa alimenta la UI y el gate de pago; no puede ser la única
    // defensa porque otro request podría tomar el slot antes del INSERT.
    let appointment = await db.transaction(async () => {
      await lockCalendarAppointmentCreation(calendar.id);
      const availability = await localCalendarService.checkSlotAvailability(
        calendar.id,
        publicAppointmentData.startTime,
        publicAppointmentData.endTime,
        {
          enforceCalendarRules: true,
          timezone: businessTimezone,
          // La política de empalme vive en el calendario; el navegador no puede ampliarla.
        }
      );
      if (!availability.available) {
        const conflictError = new Error(calendarAvailabilityFailureMessage(availability));
        conflictError.status = 409;
        conflictError.code = 'slot_unavailable';
        conflictError.data = calendarAvailabilityFailureData(availability);
        throw conflictError;
      }

      return localCalendarService.createLocalAppointment({
        ...publicAppointmentData,
        locationId: context.locationId || calendar.locationId,
        title: renderedTemplates.title,
        notes: renderedTemplates.notes,
        source: 'ristak'
      }, {
        locationId: context.locationId || calendar.locationId,
        syncStatus: 'pending'
      });
    });

    if (isHighLevelConfigured(context)) {
      let highLevelAppointmentWriteStarted = false;
      try {
        if (!calendar.ghlCalendarId) {
          throw new Error(`El calendario ${calendar.id} todavía no tiene ID de HighLevel; la cita local queda pendiente de sincronización`);
        }
        const ghlContactId = await localCalendarService.ensureHighLevelContactForAppointment(
          new GHLClient(context.accessToken, context.locationId),
          { ...appointment, contactId }
        );
        const remoteContactId = ghlContactId || contactId;
        await localCalendarService.prepareHighLevelAppointmentMirrorIntent({
          appointmentId: appointment.id,
          remoteCalendarId: calendar.ghlCalendarId,
          remoteContactId,
          locationId: context.locationId
        });
        highLevelAppointmentWriteStarted = true;
        const remote = await calendarService.createAppointment({
          calendarId: calendar.ghlCalendarId,
          contactId: remoteContactId,
          title: renderedTemplates.title,
          appointmentStatus: calendar.autoConfirm ? 'confirmed' : 'pending',
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          notes: renderedTemplates.notes
        }, context.locationId, context.accessToken);

        appointment = await confirmHighLevelMirrorForExactLocalVersion(
          appointment,
          remote.appointment?.id || remote.id
        );
        await localCalendarService.completeHighLevelAppointmentMirrorIntent(
          appointment.id,
          remote.appointment?.id || remote.id
        );
      } catch (error) {
        if (error?.code === 'appointment_provider_response_stale') {
          appointment = await localCalendarService.getLocalAppointment(appointment.id) || appointment;
        } else {
          const mirrorErrorMessage = highLevelAppointmentWriteStarted && highLevelMirrorWriteOutcomeIsAmbiguous(error)
            ? `${HIGHLEVEL_REMOTE_OUTCOME_UNKNOWN_MARKER} ${error.message}`
            : error.message;
          await markAppointmentMirrorSyncError({
            appointmentId: appointment.id,
            provider: 'highlevel',
            message: mirrorErrorMessage,
            expectedAppointment: appointment
          }).catch((markError) => {
            logger.error(`[Calendars Controller] No se pudo marcar el fallo del espejo GHL de la cita pública ${appointment.id}: ${markError.message}`);
          });
          appointment = await localCalendarService.getLocalAppointment(appointment.id) || appointment;
        }
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

    await dispatchAppointmentCreatedAutomations(appointment);

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
      // Booking en la página/widget público: la superficie real de la
      // conversión ES website, así que "smart" resuelve a site aquí.
      const resolvedCustomEvent = customEvents.enabled
        ? await resolveCalendarCustomEventChannel({ customEvents, contactId, surfaceHint: 'website' })
        : { channel: 'whatsapp', reason: 'global_whatsapp_config', surface: 'website' };

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
        const resolvedChannel = ['whatsapp', 'messenger', 'instagram'].includes(resolvedCustomEvent.channel)
          ? resolvedCustomEvent.channel
          : 'whatsapp';
        metaEvent = await triggerWhatsappAppointmentBookedEvent(contactId, {
          calendarId: calendar.id,
          calendarName: calendar.name,
          appointmentId: appointment.id,
          conversionSurface: resolvedCustomEvent.surface || 'website',
          customEvents: customEvents.enabled ? getCustomEventsForResolvedChannel(customEvents, resolvedChannel) : undefined
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
    const internalAvailability = req[INTERNAL_CONTROLLER_CONTEXT] || {};
    const requireVerifiedExternalAvailability = internalAvailability.requireVerifiedExternalAvailability === true;
    const requestedAvailabilityOptions = internalAvailability.availabilityOptions && typeof internalAvailability.availabilityOptions === 'object'
      ? internalAvailability.availabilityOptions
      : {};
    // El GET protegido alimenta selectores y agente. Ningún caller amplía la
    // política: el switch persistido del calendario decide los empalmes.
    const availabilityOptions = {
      ...requestedAvailabilityOptions,
      // La política persistida del calendario manda también para callers internos.
      ignoreAppointmentConflicts: false
    };

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere startDate y endDate'
      });
    }

    const range = assertDateOnlyRangeLimit({
      startDate,
      endDate,
      maxDays: CALENDAR_AVAILABILITY_MAX_RANGE_DAYS,
      label: 'La disponibilidad'
    });
    const { accessToken } = await getHighLevelContext(req);
    const localCalendar = await localCalendarService.getLocalCalendar(id);
    // `openHours` son horas de pared del negocio. El timezone solicitado sólo
    // puede cambiar cómo se muestran los instantes, no reinterpretar 13:00 como
    // 13:00 de la computadora o del agente que hizo la petición.
    const availabilityTimezone = localCalendar
      ? await getAccountTimezone()
      : timezone;
    const slots = await resolveCalendarAvailabilitySlots({
      calendar: localCalendar,
      requestedCalendarId: id,
      startDate: range.startDate,
      endDate: range.endDate,
      timezone: availabilityTimezone,
      accessToken,
      requireVerifiedExternalAvailability,
      availabilityOptions
    });

    res.json({
      success: true,
      data: slots
    });
  } catch (error) {
    const log = error.status && error.status < 500 ? logger.warn : logger.error;
    log(`[Calendars Controller] Error en getFreeSlots: ${error.message}`);
    res.status(error.status || 500).json({
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

    if (!startTime || !endTime) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere startTime y endTime'
      });
    }

    const range = assertEpochRangeLimit({
      startTime,
      endTime,
      maxDays: CALENDAR_BLOCKED_SLOTS_MAX_RANGE_DAYS,
      label: 'La consulta de bloqueos del calendario'
    });
    const { locationId, accessToken } = await getHighLevelContext(req);

    // (APT-004) Sin HighLevel: devolver los bloqueos NATIVOS guardados localmente.
    if (!accessToken) {
      const data = await localCalendarService.listLocalBlockedSlots({
        calendarId,
        startTime: new Date(range.start).toISOString(),
        endTime: new Date(range.end).toISOString()
      });
      return res.json({ success: true, data });
    }

    if (!locationId) {
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
      range.start,
      range.end,
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
    const log = error.status && error.status < 500 ? logger.warn : logger.error;
    log(`[Calendars Controller] Error en getBlockedSlots: ${error.message}`);
    res.status(error.status || 500).json({
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
    const { accessToken: suppliedAccessToken, locationId: suppliedLocationId, ...blockData } = req.body;
    const calendarId = blockData.calendarId || blockData.calendar_id || req.params.calendarId || null;
    const localCalendar = calendarId
      ? await db.get('SELECT source, ghl_calendar_id FROM calendars WHERE id = ? LIMIT 1', [calendarId]).catch(() => null)
      : null;
    const shouldUseHighLevel = Boolean(
      suppliedAccessToken || localCalendar?.ghl_calendar_id || cleanString(localCalendar?.source).toLowerCase() === 'ghl'
    );
    const context = shouldUseHighLevel
      ? await getHighLevelContext(req, { accessToken: suppliedAccessToken, locationId: suppliedLocationId })
      : { accessToken: null, locationId: null };

    // (APT-004) Sin HighLevel: crear un bloqueo NATIVO (calendarios Ristak/Google).
    // Se respeta en checkSlotAvailability para impedir agendar sobre ese horario.
    if (!context.accessToken) {
      const startTime = blockData.startTime || blockData.start_time || blockData.startTimeUtc;
      const endTime = blockData.endTime || blockData.end_time || blockData.endTimeUtc;
      if (!startTime || !endTime) {
        return res.status(400).json({ success: false, error: 'Se requiere startTime y endTime para el bloqueo' });
      }
      const blockedSlot = await localCalendarService.createLocalBlockedSlot({
        calendarId,
        startTime,
        endTime,
        title: blockData.title || blockData.reason || blockData.name || null
      });
      return res.status(201).json({ success: true, data: blockedSlot });
    }

    if (!context.locationId) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere locationId'
      });
    }

    const blockedSlot = await calendarService.createBlockedSlot(blockData, context.locationId, context.accessToken);

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
    const { accessToken: suppliedAccessToken, ...updateData } = req.body;

    // Los bloqueos nativos se resuelven primero por ID. Si no existen, el
    // backend usa la credencial guardada para actualizar el bloqueo HighLevel;
    // el navegador no necesita recibir ni reenviar ese secret.
    if (!suppliedAccessToken) {
      const startTime = updateData.startTime || updateData.start_time || updateData.startTimeUtc || null;
      const endTime = updateData.endTime || updateData.end_time || updateData.endTimeUtc || null;
      const title = updateData.title ?? updateData.reason ?? updateData.name;
      const ok = await localCalendarService.updateLocalBlockedSlot({ id, startTime, endTime, title });
      if (ok) {
        return res.json({ success: true, data: { id, startTime, endTime, title } });
      }
    }

    const context = await getHighLevelContext(req, { accessToken: suppliedAccessToken });
    if (!context.accessToken) {
      return res.status(404).json({ success: false, error: 'Bloqueo no encontrado' });
    }
    const blockedSlot = await calendarService.updateBlockedSlot(id, updateData, context.accessToken);

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
    const {
      accessToken,
      locationId,
      clientRequestId,
      client_request_id: legacyClientRequestId,
      depositReservationEventId,
      depositReservationClaimToken,
      depositReservationAgentId,
      depositReservationRequestDraftHash,
      conversationTerminalAuthorityToken,
      conversationTerminalAgentId,
      conversationTerminalChannel,
      ...appointmentData
    } = req.body;
    const carriesTestMetadata = Boolean(
      appointmentData.isTest || appointmentData.is_test ||
      appointmentData.testRunId || appointmentData.test_run_id ||
      appointmentData.testEffectId || appointmentData.test_effect_id ||
      appointmentData.testExpiresAt || appointmentData.test_expires_at
    );
    if (
      carriesTestMetadata &&
      req[INTERNAL_CONTROLLER_CONTEXT]?.conversationalAgentTestAppointment !== true
    ) {
      return res.status(403).json({
        success: false,
        code: 'test_appointment_internal_only',
        error: 'Las marcas de una cita de prueba sólo pueden crearse desde el tester interno.'
      });
    }
    const internalAppointmentContext = req[INTERNAL_CONTROLLER_CONTEXT] || {};
    const conversationalAppointmentAuthorityFence = typeof internalAppointmentContext.conversationalAppointmentAuthorityFence === 'function'
      ? internalAppointmentContext.conversationalAppointmentAuthorityFence
      : null;
    const strictAvailabilityCheck = appointmentData.strictAvailabilityCheck === true
      || appointmentData.source === 'conversational_agent_v2';
    const forceDoubleBooking = appointmentData.ignoreAppointmentConflicts === true
      || appointmentData.confirmDoubleBooking === true;
    const depositFenceProvided = Boolean(
      depositReservationEventId || depositReservationClaimToken || depositReservationAgentId ||
      depositReservationRequestDraftHash
    );
    const terminalAuthorityProvided = Boolean(
      conversationTerminalAuthorityToken || conversationTerminalAgentId || conversationTerminalChannel
    );
    if (
      terminalAuthorityProvided &&
      req[INTERNAL_CONTROLLER_CONTEXT]?.conversationalAgentAppointment !== true
    ) {
      return res.status(403).json({
        success: false,
        code: 'conversational_terminal_authority_internal_only',
        error: 'La autoridad terminal sólo puede usarse desde el agente interno.'
      });
    }
    if (terminalAuthorityProvided && !depositFenceProvided) {
      return res.status(409).json({
        success: false,
        code: 'conversational_payment_resume_deposit_fence_missing',
        error: 'La reanudación pagada no conserva la reserva exclusiva del anticipo.'
      });
    }
    const context = await getHighLevelContext(req, { locationId, accessToken });
    const requestedCalendarId = cleanString(appointmentData.calendarId || appointmentData.calendar_id);
    if (!requestedCalendarId) {
      return res.status(400).json({
        success: false,
        code: 'appointment_calendar_required',
        error: 'Selecciona un calendario para guardar la cita local y sincronizarla con las integraciones conectadas.'
      });
    }
    const appointmentRequestId = clientRequestId || legacyClientRequestId || null;
    if (carriesTestMetadata) {
      const testEffectId = cleanString(appointmentData.testEffectId || appointmentData.test_effect_id);
      const expectedTestRequestId = testEffectId ? `conv-test:${testEffectId}` : '';
      if (!expectedTestRequestId || cleanString(appointmentRequestId) !== expectedTestRequestId) {
        return res.status(409).json({
          success: false,
          code: 'test_appointment_idempotency_identity_mismatch',
          error: 'La cita de prueba no conserva la identidad exacta de su efecto durable. Reinicia la prueba antes de continuar.'
        });
      }
    }
    const createdAppointment = await runIdempotentAppointmentCreation({
      clientRequestId: appointmentRequestId,
      payload: strictAvailabilityCheck
        ? {
            calendarId: requestedCalendarId,
            contactId: appointmentData.contactId || appointmentData.contact_id || null,
            startTime: appointmentData.startTime || appointmentData.start_time || null,
            endTime: appointmentData.endTime || appointmentData.end_time || null,
            source: 'conversational_agent_v2'
          }
        : {
            ...appointmentData,
            locationId: context.locationId || null
          },
      create: async () => {
    const localCalendar = await localCalendarService.getLocalCalendar(requestedCalendarId);
    if ((strictAvailabilityCheck || forceDoubleBooking) && !localCalendar) {
      const calendarError = new Error('El calendario configurado no existe o ya no está disponible. No se creó la cita.');
      calendarError.status = 404;
      calendarError.code = 'calendar_not_found';
      throw calendarError;
    }
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

    // (APT-001) Siempre validamos el rango y los bloqueos dentro del mismo candado.
    // El modo personalizado sólo puede ignorar conflictos con otras citas; jamás
    // puede saltarse un bloqueo explícito ni convertir el modo estricto en sobreagenda.
    const localCalendarId = localCalendar?.id || requestedCalendarId;
    const createLocalWithAvailability = async () => {
      // Orden único para evitar ciclos con una reagenda concurrente en Postgres:
      // primero el advisory del calendario. El lock inbound NO se toma aquí;
      // se adquiere sólo en el fence terminal, después de disponibilidad y
      // justo antes del INSERT, para que una corrección pueda persistirse
      // mientras la consulta externa/local tarda.
      if (localCalendarId) {
        await lockCalendarAppointmentCreation(localCalendarId);
      }
      let depositFence = null;
      if (depositFenceProvided) {
        depositFence = await assertConversationalAppointmentDepositReservationFence({
          eventId: depositReservationEventId,
          claimToken: depositReservationClaimToken,
          appointmentRequestId: clientRequestId || legacyClientRequestId,
          contactId: appointmentData.contactId || appointmentData.contact_id,
          agentId: depositReservationAgentId,
          calendarId: appointmentData.calendarId || appointmentData.calendar_id,
          startTime: appointmentData.startTime || appointmentData.start_time,
          selectionRequestDraftHash: depositReservationRequestDraftHash,
          bookingOwner: 'ai',
          terminalToolName: 'book_appointment',
          database: db
        });
      }
      if (terminalAuthorityProvided) {
        await claimConversationalTerminalMutationAuthority({
          contactId: appointmentData.contactId || appointmentData.contact_id,
          agentId: conversationTerminalAgentId,
          channel: conversationTerminalChannel || 'whatsapp',
          authorityToken: conversationTerminalAuthorityToken,
          database: db
        });
      }
      if (localCalendarId) {
        // El alta legacy ordinaria conserva su contrato fail-open. El modo estricto y
        // el override personalizado fallan cerrado: si no podemos comprobar bloqueos
        // y rango, no inventamos una cita.
        let availability = { available: true };
        try {
          availability = await localCalendarService.checkSlotAvailability(
            localCalendarId,
            localAppointmentData.startTime || localAppointmentData.start_time,
            localAppointmentData.endTime || localAppointmentData.end_time,
            strictAvailabilityCheck
              ? {
                  enforceCalendarRules: true,
                  // Ni el payload ni un contexto interno amplían esta regla:
                  // checkSlotAvailability usa la política persistida del calendario.
                  ignoreAppointmentConflicts: false,
                  timezone: localAppointmentData.timeZone || localAppointmentData.timezone
                }
              : {
                  // Personalizado puede empalmar citas, pero checkSlotAvailability
                  // aún valida rango y blocked_slots antes del INSERT.
                  ignoreAppointmentConflicts: forceDoubleBooking
                }
          );
        } catch (error) {
          if (strictAvailabilityCheck || forceDoubleBooking) {
            const availabilityError = new Error('No se pudo comprobar que el horario siga disponible. No se creó la cita.');
            availabilityError.status = 503;
            availabilityError.code = 'availability_check_failed';
            availabilityError.cause = error;
            throw availabilityError;
          }
          logger.warn(`[Calendars Controller] No se pudo verificar disponibilidad del slot, permito crear: ${error.message}`);
        }
        if (!availability.available) {
          const conflictError = new Error(calendarAvailabilityFailureMessage(availability, {
            allowOverride: !strictAvailabilityCheck
          }));
          conflictError.status = 409;
          conflictError.code = 'slot_unavailable';
          conflictError.data = calendarAvailabilityFailureData(availability);
          throw conflictError;
        }
      }

      // La disponibilidad puede tardar lo suficiente para que entre otro
      // mensaje del contacto. Repetimos la autoridad en el último punto antes
      // del INSERT: éste es el orden lineal de la decisión terminal. Un inbound
      // sustantivo ya persistido gana y el borrador anterior no crea nada.
      if (conversationalAppointmentAuthorityFence) {
        await conversationalAppointmentAuthorityFence({
          lockForCommit: true,
          phase: 'before_mutation'
        });
      }

      const localAppointment = await localCalendarService.createLocalAppointment({
        ...localAppointmentData,
        calendarId: localCalendar?.id || requestedCalendarId,
        locationId: context.locationId
      }, {
        locationId: context.locationId,
        syncStatus: 'pending'
      });
      if (depositFence) {
        await consumeConversationalAppointmentDepositEvidence({
          reconciliationId: depositFence.reconciliationId,
          contactId: appointmentData.contactId || appointmentData.contact_id,
          agentId: depositReservationAgentId,
          paymentId: depositFence.paymentId,
          reconciliationClaimToken: depositFence.reconciliationClaimToken,
          reservationClaimToken: depositReservationClaimToken,
          appointmentRequestId: clientRequestId || legacyClientRequestId,
          appointmentId: localAppointment.id,
          allowProcessingAppointmentRequest: true,
          database: db
        });
      }
      if (appointmentRequestId) {
        // La cita local es el commit canónico. Guardamos su ID antes de tocar
        // cualquier espejo o efecto posterior para que un crash recupere esta
        // misma cita y jamás vuelva a crearla.
        const checkpoint = await db.run(`
          UPDATE appointment_creation_requests
          SET appointment_id = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE client_request_id = ? AND status = 'processing'
            AND (appointment_id IS NULL OR appointment_id = ?)
        `, [localAppointment.id, appointmentRequestId, localAppointment.id]);
        if (Number(checkpoint?.changes || 0) !== 1) {
          const checkpointError = new Error('No se pudo guardar la comprobación durable de la cita local. No se confirmó la creación.');
          checkpointError.status = 503;
          checkpointError.code = 'appointment_idempotency_checkpoint_failed';
          throw checkpointError;
        }
      }
      return localAppointment;
    };

    let appointment = localCalendarId
      ? await db.transaction(createLocalWithAvailability)
      : await createLocalWithAvailability();

    if (isHighLevelConfigured(context)) {
      let highLevelAppointmentWriteStarted = false;
      try {
        const localContactId = appointment.contactId || appointmentData.contactId || appointmentData.contact_id;
        const highLevelClient = new GHLClient(context.accessToken, context.locationId);
        const ghlContactId = appointment.isTest
          ? await localCalendarService.resolveExistingHighLevelContactForTestAppointment(
              highLevelClient,
              { ...appointment, contactId: localContactId }
            )
          : await localCalendarService.ensureHighLevelContactForAppointment(
              highLevelClient,
              { ...appointment, contactId: localContactId }
            );
        const remoteCalendarId = localCalendar?.ghlCalendarId || (!localCalendar ? requestedCalendarId : '');
        if (!remoteCalendarId) {
          throw new Error(`El calendario ${localCalendar?.id || requestedCalendarId} todavía no tiene ID de HighLevel; la cita local queda pendiente de sincronización`);
        }
        const remoteContactId = ghlContactId || localContactId || localAppointmentData.contactId || localAppointmentData.contact_id;
        const remotePayload = {
          ...localAppointmentData,
          calendarId: remoteCalendarId,
          contactId: remoteContactId
        };
        let remote;
        if (appointment.isTest) {
          remote = await localCalendarService.createConversationalTestHighLevelAppointment({
              appointment,
              appointmentData: remotePayload,
              locationId: context.locationId,
              remoteCalendarId,
              contactId: remoteContactId,
              apiToken: context.accessToken
            });
        } else {
          await localCalendarService.prepareHighLevelAppointmentMirrorIntent({
            appointmentId: appointment.id,
            remoteCalendarId,
            remoteContactId,
            locationId: context.locationId
          });
          highLevelAppointmentWriteStarted = true;
          remote = await calendarService.createAppointment(remotePayload, context.locationId, context.accessToken);
        }
        const remoteAppointmentId = remote?.appointment?.id || remote?.id;
        if (!cleanString(remoteAppointmentId)) {
          const missingIdError = new Error('HighLevel respondió sin un identificador verificable del espejo.');
          missingIdError.code = 'highlevel_mirror_remote_outcome_unknown';
          throw missingIdError;
        }
        appointment = await confirmHighLevelMirrorForExactLocalVersion(
          appointment,
          remoteAppointmentId
        );
        if (!appointment.isTest) {
          await localCalendarService.completeHighLevelAppointmentMirrorIntent(
            appointment.id,
            remoteAppointmentId
          );
        }
      } catch (error) {
        if (error?.code === 'appointment_provider_response_stale') {
          appointment = await localCalendarService.getLocalAppointment(appointment.id) || appointment;
          logger.warn(`[Calendars Controller] El espejo GHL respondió para una versión anterior; la cita local vigente quedó pendiente.`);
          if (appointment?.isTest) {
            throw markTestAppointmentProviderSyncFailure(error, {
              provider: 'highlevel',
              appointmentId: appointment.id
            });
          }
        } else {
          const mirrorErrorMessage = !appointment?.isTest && highLevelAppointmentWriteStarted && highLevelMirrorWriteOutcomeIsAmbiguous(error)
            ? `${HIGHLEVEL_REMOTE_OUTCOME_UNKNOWN_MARKER} ${error.message}`
            : error.message;
          await markAppointmentMirrorSyncError({
            appointmentId: appointment?.id,
            provider: 'highlevel',
            message: mirrorErrorMessage,
            clientRequestId: appointmentRequestId,
            expectedAppointment: appointment
          }).catch((markError) => {
            logger.error(`[Calendars Controller] No se pudo marcar el fallo del espejo GHL de la cita ${appointment?.id}: ${markError.message}`);
          });
          appointment = await localCalendarService.getLocalAppointment(appointment.id) || appointment;
          if (appointment?.isTest) {
            throw markTestAppointmentProviderSyncFailure(error, {
              provider: 'highlevel',
              appointmentId: appointment.id
            });
          }
          logger.warn(`[Calendars Controller] Cita local confirmada; espejo GHL pendiente/error: ${mirrorErrorMessage}`);
        }
      }
    }

    const hasGoogleMirror = Boolean(
      cleanString(localCalendar?.googleCalendarId || localCalendar?.google_calendar_id)
    );
    try {
      const googleResult = await googleCalendarService.syncAppointmentToGoogle(appointment);
      if (googleResult?.appointment) {
        appointment = googleResult.appointment;
      }
      if (hasGoogleMirror) {
        const googleEventId = cleanString(
          googleResult?.appointment?.googleEventId ||
          googleResult?.appointment?.google_event_id ||
          googleResult?.event?.id ||
          appointment?.googleEventId ||
          appointment?.google_event_id
        );
        if (googleResult?.enabled !== true || !googleEventId) {
          throw new Error('Google Calendar no confirmó el espejo de la cita local.');
        }
      }
    } catch (error) {
      if (hasGoogleMirror) {
        await markAppointmentMirrorSyncError({
          appointmentId: appointment?.id,
          provider: 'google',
          message: error.message,
          clientRequestId: appointmentRequestId,
          expectedAppointment: appointment
        }).catch((markError) => {
          logger.error(`[Calendars Controller] No se pudo marcar el fallo del espejo Google de la cita ${appointment?.id}: ${markError.message}`);
        });
      }
      if (appointment?.isTest) {
        throw markTestAppointmentProviderSyncFailure(error, {
          provider: 'google',
          appointmentId: appointment.id
        });
      }
      logger.warn(`[Calendars Controller] Cita local confirmada; espejo Google pendiente/error: ${error.message}`);
    }

    const automationResult = await dispatchAppointmentCreatedAutomations(appointment).catch(error => {
      logger.warn(`[Calendars Controller] La cita local quedó confirmada, pero falló una automatización posterior: ${error.message}`);
      return { ok: false, error: error.message };
    });
    if (appointment?.isTest) {
      appointment = {
        ...appointment,
        testAutomationExecution: automationResult,
        testAutomationPreview: automationResult
      };
    }

    const contactId = appointmentData.contactId || appointmentData.contact_id || appointment?.contactId || appointment?.contact_id;

    // Las citas de prueba recorren calendario, push, webhooks marcados como test
    // y avisos internos dirigidos al dueño de la prueba. Mensajes externos,
    // etiquetas y mutaciones no reversibles sólo se simulan y auditan. JAMÁS
    // cuentan como conversión Meta/CAPI.
    if (contactId && !appointment?.isTest) {
      const customEvents = localCalendarService.normalizeCalendarCustomEventsConfig(localCalendar?.customEvents || {});
      // Cita creada desde el admin: la superficie se detecta por la última
      // conversación del contacto (WhatsApp/Messenger/IG) o web como fallback.
      const resolvedCustomEvent = customEvents.enabled
        ? await resolveCalendarCustomEventChannel({ customEvents, contactId })
        : { channel: 'whatsapp', reason: 'global_whatsapp_config', surface: '', contact: null };

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
        const resolvedChannel = ['whatsapp', 'messenger', 'instagram'].includes(resolvedCustomEvent.channel)
          ? resolvedCustomEvent.channel
          : 'whatsapp';
        await triggerWhatsappAppointmentBookedEvent(contactId, {
          calendarId: appointment?.calendarId || appointmentData.calendarId || appointmentData.calendar_id,
          calendarName: localCalendar?.name || appointmentData.calendarName || '',
          appointmentId: appointment?.id,
          conversionSurface: resolvedCustomEvent.surface || '',
          customEvents: customEvents.enabled ? getCustomEventsForResolvedChannel(customEvents, resolvedChannel) : undefined
        }).catch(error => {
          logger.warn(`[Calendars Controller] No se pudo disparar evento WhatsApp para cita: ${error.message}`);
          return null;
        });
      }
    }

    await sendCalendarAppointmentNotification(appointment, {
      calendarId: appointment?.calendarId || appointmentData.calendarId || appointmentData.calendar_id,
      calendarName: localCalendar?.name || appointmentData.calendarName || 'Calendario',
      source: 'admin_calendar',
      isTest: Boolean(appointment?.isTest),
      testRunId: appointment?.testRunId || null,
      testEffectId: appointment?.testEffectId || null,
      testExpiresAt: appointment?.testExpiresAt || null
    }).catch(error => {
      logger.warn(`[Calendars Controller] No se pudo enviar push de cita: ${error.message}`);
    });

        return appointment;
      }
    });

    res.status(201).json({
      success: true,
      data: createdAppointment
    });
  } catch (error) {
    const requestedStatus = Number(error.status || 500);
    const status = Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus <= 599
      ? requestedStatus
      : 500;
    const log = status < 500 ? logger.warn : logger.error;
    log(`[Calendars Controller] Error en createAppointment: ${error.message}`);
    res.status(status).json({
      success: false,
      code: error.code,
      error: error.message,
      data: error.data
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
    const internalAppointmentContext = req[INTERNAL_CONTROLLER_CONTEXT] || {};
    const conversationalAppointmentAuthorityFence = typeof internalAppointmentContext.conversationalAppointmentAuthorityFence === 'function'
      ? internalAppointmentContext.conversationalAppointmentAuthorityFence
      : null;
    const strictAvailabilityCheck = updateData.strictAvailabilityCheck === true;
    const ignoreAppointmentConflicts = updateData.ignoreAppointmentConflicts === true;
    const expectedStartTime = updateData.expectedStartTime || updateData.expected_start_time || null;
    const expectedEndTime = updateData.expectedEndTime || updateData.expected_end_time || null;
    const expectedAppointmentStatus = cleanString(
      updateData.expectedAppointmentStatus || updateData.expected_appointment_status
    ).toLowerCase() || null;
    const strictLifecycleMutation = ['cancel', 'reschedule'].includes(
      cleanString(updateData.strictLifecycleMutation || updateData.strict_lifecycle_mutation).toLowerCase()
    )
      ? cleanString(updateData.strictLifecycleMutation || updateData.strict_lifecycle_mutation).toLowerCase()
      : null;
    delete updateData.strictAvailabilityCheck;
    delete updateData.ignoreAppointmentConflicts;
    delete updateData.expectedStartTime;
    delete updateData.expected_start_time;
    delete updateData.expectedEndTime;
    delete updateData.expected_end_time;
    delete updateData.expectedAppointmentStatus;
    delete updateData.expected_appointment_status;
    delete updateData.strictLifecycleMutation;
    delete updateData.strict_lifecycle_mutation;
    const context = await getHighLevelContext(req, { accessToken });
    const existing = await localCalendarService.getLocalAppointment(id);
    let appointment;
    let lifecycleReplay = null;

    if (!existing && (strictAvailabilityCheck || strictLifecycleMutation)) {
      return res.status(404).json({
        success: false,
        code: 'appointment_not_found',
        error: 'La cita ya no existe o dejó de estar disponible.'
      });
    }

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
    const cancellationMutationRequested = ['cancelled', 'canceled'].includes(incomingStatus);
    if (!existing && cancellationMutationRequested) {
      return res.status(404).json({
        success: false,
        code: 'appointment_not_found',
        error: 'La cita ya no existe o dejó de estar disponible.'
      });
    }

    // Reagendar desde el agente y cualquier cancelación pasan por un check+update
    // local serializado por calendario. La UI/admin conserva su payload legacy,
    // pero comparte el candado al cancelar. El proveedor externo se sincroniza
    // después del commit local y, si falla, `sync_status=pending` conserva la
    // edición para el reconciliador existente.
    if ((strictAvailabilityCheck || strictLifecycleMutation || cancellationMutationRequested) && existing) {
      const requestedStartInput = updateData.startTime || updateData.start_time;
      const requestedEndInput = updateData.endTime || updateData.end_time;
      const existingStart = existing.startTime || existing.start_time;
      const existingEnd = existing.endTime || existing.end_time;
      const requestedStart = requestedStartInput || existingStart;
      const requestedEnd = requestedEndInput || existingEnd;
      const startChanged = requestedStartInput && (
        new Date(requestedStartInput).getTime() !== new Date(existingStart).getTime()
      );
      const endChanged = requestedEndInput && (
        new Date(requestedEndInput).getTime() !== new Date(existingEnd).getTime()
      );
      const cancelRequested = strictLifecycleMutation === 'cancel' || cancellationMutationRequested;
      const rescheduleRequested = strictLifecycleMutation === 'reschedule' || startChanged || endChanged;
      if (cancelRequested || rescheduleRequested) {
        const calendarId = existing.calendarId || existing.calendar_id;
        const startMs = requestedStart ? new Date(requestedStart).getTime() : NaN;
        const endMs = requestedEnd ? new Date(requestedEnd).getTime() : NaN;
        if (
          !calendarId ||
          (rescheduleRequested && (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs))
        ) {
          return res.status(400).json({
            success: false,
            code: 'appointment_reschedule_range_invalid',
            error: 'El nuevo horario de la cita no es válido.'
          });
        }
        const calendar = await localCalendarService.getLocalCalendar(calendarId);
        if (!calendar?.id) {
          return res.status(404).json({
            success: false,
            code: 'calendar_not_found',
            error: 'El calendario de la cita ya no existe o dejó de estar disponible.'
          });
        }
        appointment = await db.transaction(async () => {
          await lockCalendarAppointmentCreation(calendarId);
          const current = await localCalendarService.getLocalAppointment(id);
          if (!current?.id) {
            const error = new Error('La cita dejó de existir mientras se reprogramaba.');
            error.status = 404;
            error.code = 'appointment_not_found';
            throw error;
          }
          const currentStatus = cleanString(
            current.appointmentStatus || current.appointment_status || current.status
          ).toLowerCase();
          const currentStartMs = new Date(current.startTime || current.start_time).getTime();
          const currentEndMs = new Date(current.endTime || current.end_time).getTime();
          const cancelledStatuses = new Set(['cancelled', 'canceled']);
          const inactiveStatuses = new Set([
            ...cancelledStatuses,
            'no_show', 'no-show', 'noshow', 'invalid', 'deleted',
            'showed', 'show', 'attended', 'completed', 'complete'
          ]);

          if (cancelRequested && cancelledStatuses.has(currentStatus)) {
            lifecycleReplay = 'already_cancelled';
            return { ...current, lifecycleReplay };
          }
          if (rescheduleRequested && Number.isFinite(startMs) && Number.isFinite(endMs) &&
              currentStartMs === startMs && currentEndMs === endMs && !inactiveStatuses.has(currentStatus)) {
            lifecycleReplay = 'already_rescheduled';
            return { ...current, lifecycleReplay };
          }
          if (inactiveStatuses.has(currentStatus)) {
            const error = new Error(cancelRequested
              ? 'La cita ya no está activa y no puede cancelarse.'
              : 'La cita ya no está activa y no puede reagendarse.');
            error.status = 409;
            error.code = 'appointment_lifecycle_inactive';
            throw error;
          }
          if (
            expectedStartTime &&
            new Date(expectedStartTime).getTime() !== currentStartMs
          ) {
            const error = new Error('La cita cambió mientras se reprogramaba. Se conservó su horario vigente.');
            error.status = 409;
            error.code = 'appointment_reschedule_stale';
            throw error;
          }
          if (expectedEndTime && new Date(expectedEndTime).getTime() !== currentEndMs) {
            const error = new Error('La duración de la cita cambió mientras se procesaba. Se conservó su horario vigente.');
            error.status = 409;
            error.code = 'appointment_duration_stale';
            throw error;
          }
          if (expectedAppointmentStatus && currentStatus !== expectedAppointmentStatus) {
            const error = new Error('El estado de la cita cambió mientras se procesaba. No se aplicó la acción.');
            error.status = 409;
            error.code = 'appointment_status_stale';
            throw error;
          }
          if (cancelRequested) {
            if (conversationalAppointmentAuthorityFence) {
              await conversationalAppointmentAuthorityFence({
                lockForCommit: true,
                phase: 'before_mutation'
              });
            }
            return localCalendarService.updateLocalAppointment(id, updateData, { syncStatus: 'pending' });
          }
          const availability = await localCalendarService.checkSlotAvailability(
            calendarId,
            requestedStart,
            requestedEnd,
            {
              excludeAppointmentId: current.id,
              ignoreAppointmentConflicts: strictAvailabilityCheck
                ? false
                : ignoreAppointmentConflicts,
              ...(strictAvailabilityCheck
                ? {
                    enforceCalendarRules: true,
                    timezone: updateData.timeZone || updateData.timezone || current.timeZone || current.time_zone
                  }
                : {})
            }
          );
          if (!availability.available) {
            const error = new Error(calendarAvailabilityFailureMessage(availability, { reschedule: true }));
            error.status = 409;
            error.code = 'slot_unavailable';
            error.data = calendarAvailabilityFailureData(availability);
            throw error;
          }
          if (conversationalAppointmentAuthorityFence) {
            await conversationalAppointmentAuthorityFence({
              lockForCommit: true,
              phase: 'before_mutation'
            });
          }
          return localCalendarService.updateLocalAppointment(id, updateData, { syncStatus: 'pending' });
        });
      }
    }

    if (lifecycleReplay) {
      return res.json({
        success: true,
        data: { ...appointment, lifecycleReplay }
      });
    }

    // Ristak siempre es la autoridad de la cita. Incluso para una edición
    // ordinaria (título, notas, responsable, etc.) persistimos primero la
    // versión local y sólo después intentamos actualizar sus espejos externos.
    // Antes, una cita con ghlAppointmentId podía saltarse este UPDATE local:
    // HighLevel respondía bien, se marcaba el espejo como sincronizado y la
    // cita canónica conservaba los datos viejos.
    if (!appointment) {
      const persistOrdinaryLocalUpdate = () => localCalendarService.updateLocalAppointment(
        id,
        updateData,
        { syncStatus: 'pending' }
      );
      const updateLockKey = cleanString(existing?.calendarId || existing?.calendar_id || existing?.id);
      appointment = updateLockKey
        ? await db.transaction(async () => {
            await lockCalendarAppointmentCreation(updateLockKey);
            return persistOrdinaryLocalUpdate();
          })
        : await persistOrdinaryLocalUpdate();
      if (!appointment?.id) {
        return res.status(404).json({
          success: false,
          code: 'appointment_not_found',
          error: 'La cita ya no existe o dejó de estar disponible.'
        });
      }
    }
    const localProviderFence = appointment;

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
        await calendarService.updateAppointment(existing.ghlAppointmentId, updateData, context.accessToken);
        appointment = await confirmHighLevelMirrorForExactLocalVersion(
          localProviderFence,
          existing.ghlAppointmentId
        );
      } catch (error) {
        if (error?.code === 'appointment_provider_response_stale') throw error;
        logger.warn(`[Calendars Controller] Update GHL falló, guardando pendiente local: ${error.message}`);
        appointment = await resolveHighLevelMirrorUpdateFailure(localProviderFence, error);
      }
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

    if (nextStatus && nextStatus !== previousStatus) {
      await dispatchAppointmentAutomationEvent('appointment-status', appointment, { previousStatus });
    }

    res.json({
      success: true,
      data: appointment
    });
  } catch (error) {
    logger.error(`[Calendars Controller] Error en updateAppointment: ${error.message}`);
    res.status(Number(error.status || error.statusCode || 500)).json({
      success: false,
      ...(error.code ? { code: error.code } : {}),
      ...(error.data && typeof error.data === 'object' ? { data: error.data } : {}),
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

    const formSafeUpdateData = await enforceCalendarCustomFormAccess(
      existing,
      normalizeCalendarAvailabilityWrite(withoutGoogleCalendarLinkMutation(updateData))
    );
    const safeUpdateData = await enforceCalendarPaymentConfigAccess(existing, formSafeUpdateData);
    const paymentSourceConflict = await findCalendarPaymentSourceConflict(existing, safeUpdateData);
    if (paymentSourceConflict) {
      return res.status(400).json({
        success: false,
        error: 'Ese formulario ya tiene cobro activo. Desactiva el cobro del calendario o elige un formulario sin cobro.'
      });
    }

    let calendar = await localCalendarService.updateLocalCalendar(id, safeUpdateData, { syncStatus: 'pending' });

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
          availabilityScheduleConfigured,
          availability_schedule_configured,
          ...remoteUpdateData
        } = safeUpdateData;
        const preservedBookingForm = bookingForm || calendar?.bookingForm || existing?.bookingForm;
        const preservedBookingCompletion = bookingCompletion || calendar?.bookingCompletion || existing?.bookingCompletion;
        const preservedBookingPayment = bookingPayment || calendar?.bookingPayment || existing?.bookingPayment;
        const preservedCustomEvents = customEvents || calendar?.customEvents || existing?.customEvents;
        const remote = await calendarService.updateCalendar(remoteCalendarId, remoteUpdateData, context.accessToken);
        const remoteCalendar = remote.calendar || remote;
        calendar = await localCalendarService.upsertLocalCalendar({
          ...(remoteCalendar && typeof remoteCalendar === 'object' ? remoteCalendar : {}),
          ...calendar,
          id: existing.id,
          ghlCalendarId: remoteCalendarId
        }, {
          id: existing.id,
          source: existing.source,
          ghlCalendarId: remoteCalendarId,
          locationId: context.locationId || existing.locationId,
          syncStatus: 'synced',
          acknowledgeLocalWrite: true,
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
    res.status(error.status || 500).json({
      success: false,
      code: error.code,
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

    if (existing.source === 'ghl') {
      const highLevelConfig = await getSavedHighLevelConfig().catch(() => null);

      if (isHighLevelConfigured(highLevelConfig)) {
        return res.status(409).json({
          success: false,
          error: 'Desconecta HighLevel antes de eliminar este calendario de Ristak'
        });
      }
    } else if (existing.source !== 'ristak') {
      return res.status(409).json({
        success: false,
        error: 'Los calendarios sincronizados se eliminan desde su origen'
      });
    }

    const deleted = await localCalendarService.deleteLocalCalendar(id);

    await localCalendarService.reconcileCalendarDefaults().catch(error => {
      logger.warn(`[Calendars Controller] No se pudo reconciliar calendario predeterminado tras eliminar calendario: ${error.message}`);
    });

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
    } else if (existing?.ghlAppointmentId) {
      await localCalendarService.deleteLocalAppointment(existing.id, { markPendingDelete: true });
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
    const suppliedAccessToken = req.query.accessToken;

    // Igual que update: primero local por ID y sólo entonces HighLevel con la
    // credencial guardada en backend.
    if (!suppliedAccessToken) {
      const ok = await localCalendarService.deleteLocalBlockedSlot(id);
      if (ok) {
        return res.json({ success: true, message: 'Blocked slot eliminado exitosamente' });
      }
    }

    const context = await getHighLevelContext(req, { accessToken: suppliedAccessToken });
    if (!context.accessToken) {
      return res.status(404).json({ success: false, error: 'Bloqueo no encontrado' });
    }
    await calendarService.deleteBlockedSlot(id, context.accessToken);

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
