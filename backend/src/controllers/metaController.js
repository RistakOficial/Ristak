import crypto from 'crypto';
import { db, getAppConfig, setAppConfig } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { isEncrypted } from '../utils/encryption.js';
import {
  saveMetaConfig,
  syncMetaAds,
  updateRecentAds,
  getMetaSyncProgress,
  getMetaConfig,
  getLegacyMetaConfig,
  getMetaSocialConfig,
  getMetaWhatsAppBusinessAccountId,
  getMetaDeveloperSetup,
  enableMetaSocialChannelsForConnectedProfiles,
  resolveMetaCapiAccessToken,
  saveMetaMessengerUserToken as persistMetaMessengerUserToken,
  verifyMetaToken,
  fetchMetaCreativeMediaForAds,
  fetchMetaCreativeMediaForAd
} from '../services/metaAdsService.js';
import { formatDate, resolveDateRange, resolveDateRangeWithGHLTimezone } from '../utils/dateUtils.js';
import {
  getContactsWithAppointmentsHybrid,
  getContactsWithShowedAppointmentsHybrid
} from '../services/appointmentsMerge.js';
import {
  buildContactKey,
  buildDedupExpression
} from '../services/analyticsService.js';
import {
  fetchAndSaveMetaConfig,
  reconcileMetaBusinessWithHighLevel,
  saveMetaCustomValues
} from '../services/highlevelSyncService.js';
import { getConnectedMetaSocialProfiles } from '../services/metaSocialProfilesService.js';
import { getHiddenContactFilters, buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js';
import { parseContactCustomFields } from '../utils/contactCustomFields.js';
import { API_URLS } from '../config/constants.js';
import fetch from 'node-fetch';
import {
  META_PAGE_SUBSCRIBED_FIELDS,
  getMetaWebhookVerifyToken,
  ensureMetaPageMessagingSubscription,
  getMetaPageMessagingSubscription,
  resolveMetaPageAccessToken,
  syncMetaSocialConversationHistoryInBackground
} from '../services/metaSocialMessagingService.js';
import { clearMetaIntegrationCredentials } from '../services/integrationCredentialsCleanupService.js';
import { getVisitorIdentityExpression } from '../services/trackingService.js';
import { signScopedToken, verifyScopedToken } from '../utils/auth.js';
import { getActiveMetaTestEventCode } from '../utils/metaTestCode.js';
import { buildMetaBrowserUserData } from '../services/metaParameterManagerService.js';
import { syncRegisteredIntegrationCronsForProvider } from '../jobs/integrationCronRegistry.js';
import { timestampSortExpression } from '../utils/sqlTimestampSort.js';
import { normalizeBaseUrl, resolvePublicServiceBaseUrl } from '../utils/publicUrl.js';
import { getAccountCurrency } from '../utils/accountLocale.js';
import { describeMetaCapiResponseError, safeMetaGraphTransportError } from '../utils/metaGraphSecurity.js';
import {
  disconnectMetaOAuthConnection,
  replaceMetaOAuthWithManualConnection
} from '../services/metaOAuthService.js';

const SUCCESS_PAYMENT_STATUSES = new Set([
  'succeeded',
  'paid',
  'completed',
  'complete',
  'fulfilled',
  'success'
]);

const REFUND_PAYMENT_STATUSES = new Set(['refunded', 'refund']);

const isPostgres = Boolean(process.env.DATABASE_URL);
const MASKED_SECRET_PREFIX = '***';

function buildMetaAdsHistoricalSyncStartDate() {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - 35);
  return formatDate(startDate);
}

function startMetaAdsSyncAfterConnection(reason = 'meta-connected') {
  const historicalStartDate = buildMetaAdsHistoricalSyncStartDate();

  logger.info(`Meta Ads: iniciando sincronización automática post-conexión (${reason})`);

  (async () => {
    const recentResult = await updateRecentAds();

    if (!recentResult.success) {
      if (recentResult.message === 'Sync completo en progreso') {
        logger.info('Meta Ads: ya hay una sincronización completa en progreso; no se inicia otra.');
        return;
      }

      logger.warn(`Meta Ads: no se pudo actualizar el rango reciente automáticamente: ${recentResult.error || recentResult.message || 'error desconocido'}`);
      return;
    }

    logger.info(`Meta Ads: actualización reciente automática lista (${recentResult.count || 0} filas). Iniciando histórico desde ${historicalStartDate}`);

    await syncMetaAds(historicalStartDate);
  })().catch(error => {
    logger.error(`Error en sincronización automática post-conexión de Meta Ads: ${error.message}`);
  });

  return {
    syncStarted: true,
    historicalStartDate
  };
}

function startMetaSocialHistoryBackfillAfterConnection(reason = 'meta-connected', platforms = ['messenger', 'instagram']) {
  const result = syncMetaSocialConversationHistoryInBackground({ platforms, reason });
  if (result.syncStarted) {
    logger.info(`Meta social: backfill de historial iniciado (${reason}): ${result.started.join(', ')}`);
  }
  return result;
}

// META-007: Caché en memoria del recálculo de atribución (DB + API HighLevel).
// getCampaigns llamaba a getContactsWithAppointmentsHybrid / getContactsWithShowedAppointmentsHybrid
// en CADA request -> lento/costoso (golpea DB + API HL siempre). Estas dos funciones devuelven
// Sets de contact_id y su resultado NO depende del rango de fechas (el filtrado por fecha ocurre
// después, en contactsQuery); depende únicamente de los parámetros que reciben:
// location_id, api_token y attributionCalendarIds (scope de calendarios de atribución).
// Por eso la clave se compone de esos parámetros. TTL corto para reflejar nuevos eventos pronto.
const META_ATTRIBUTION_CACHE = new Map(); // key -> { value, expiresAt }
const META_ATTRIBUTION_CACHE_TTL_MS = 90 * 1000; // META-007: TTL corto (90s)

// META-007: purga perezosa de entradas vencidas para no crecer sin límite
function purgeExpiredAttributionCache(now = Date.now()) {
  for (const [key, entry] of META_ATTRIBUTION_CACHE) {
    if (!entry || entry.expiresAt <= now) {
      META_ATTRIBUTION_CACHE.delete(key);
    }
  }
}

// META-007: clave compuesta estable por (location_id, presencia de token, scope de calendarios)
function buildAttributionCacheKey(locationId, apiToken, attributionCalendarIds) {
  const calendarsPart = Array.isArray(attributionCalendarIds)
    ? [...attributionCalendarIds].map(id => String(id)).sort().join(',')
    : 'ALL';
  // No incluimos el token en claro en la clave; sólo si existe credencial (cambia el camino DB vs API).
  const tokenPart = apiToken ? 'tok' : 'no-tok';
  return `${locationId || 'no-loc'}|${tokenPart}|${calendarsPart}`;
}

// META-007: devuelve {contactsWithAppointments, contactsWithAttendances} con caché TTL.
// Recalcula (DB + API HL) sólo si no hay entrada vigente. No cambia el shape del resultado.
async function getAttributionSetsCached(locationId, apiToken, attributionCalendarIds) {
  const now = Date.now();
  purgeExpiredAttributionCache(now);

  const key = buildAttributionCacheKey(locationId, apiToken, attributionCalendarIds);
  const cached = META_ATTRIBUTION_CACHE.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const [contactsWithAppointments, contactsWithAttendances] = await Promise.all([
    getContactsWithAppointmentsHybrid(locationId, apiToken, attributionCalendarIds),
    getContactsWithShowedAppointmentsHybrid(locationId, apiToken, attributionCalendarIds)
  ]);

  const value = { contactsWithAppointments, contactsWithAttendances };
  META_ATTRIBUTION_CACHE.set(key, { value, expiresAt: now + META_ATTRIBUTION_CACHE_TTL_MS });
  return value;
}

function cleanString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function isMaskedSecret(value) {
  return cleanString(value).startsWith(MASKED_SECRET_PREFIX);
}

function maskSecret(value) {
  const cleanValue = cleanString(value);
  return cleanValue ? `${MASKED_SECRET_PREFIX}${cleanValue.slice(-8)}` : '';
}

function normalizeMetaTestEventName(value) {
  const eventName = cleanString(value) || 'LeadSubmitted';
  if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(eventName)) {
    return '';
  }
  return eventName;
}

function cleanMetaTestString(value) {
  return cleanString(value);
}

const metaTestEventParameterFields = {
  Lead: ['value', 'predictedLtv', 'currency', 'status'],
  Schedule: ['value', 'predictedLtv', 'currency', 'status'],
  Purchase: ['value', 'currency', 'orderId', 'contentIds', 'contentName', 'contentType', 'numItems'],
  WhatsAppPurchase: ['value', 'currency', 'orderId', 'contentIds', 'contentName', 'contentType', 'numItems'],
  FormSubmitted: ['value', 'predictedLtv', 'currency', 'status'],
  CompleteRegistration: ['value', 'predictedLtv', 'currency', 'status'],
  Contact: ['value', 'predictedLtv', 'currency', 'status'],
  ViewContent: ['value', 'currency', 'contentName', 'contentCategory', 'contentIds', 'contentType'],
  AddPaymentInfo: ['value', 'predictedLtv', 'currency', 'status'],
  LeadSubmitted: ['value', 'predictedLtv', 'currency', 'status']
}

const WHATSAPP_PURCHASE_TEST_EVENT_NAME = 'WhatsAppPurchase';
const WHATSAPP_BUSINESS_MESSAGING_TEST_EVENTS = new Set([
  'LeadSubmitted',
  WHATSAPP_PURCHASE_TEST_EVENT_NAME
]);
const DEFAULT_META_TEST_MESSAGING_CHANNEL = 'whatsapp';
const META_TEST_MESSAGING_CHANNELS = new Set(['whatsapp', 'messenger', 'instagram']);
const META_TEST_IDENTITY_CUSTOM_PARAMETER_ALIASES = {
  ctwa: 'ctwaClid',
  ctwaclid: 'ctwaClid',
  ctwa_clid: 'ctwaClid',
  referral_ctwa_clid: 'ctwaClid',
  page: 'pageId',
  pageid: 'pageId',
  page_id: 'pageId',
  psid: 'pageScopedUserId',
  page_scoped_user_id: 'pageScopedUserId',
  pagescopeduserid: 'pageScopedUserId',
  igsid: 'igSid',
  ig_sid: 'igSid',
  ig_scoped_user_id: 'igSid',
  igscopeduserid: 'igSid',
  instagram_account_id: 'instagramAccountId',
  instagramaccountid: 'instagramAccountId',
  ig_account_id: 'instagramAccountId',
  messaging_channel: 'messagingChannel',
  messagingchannel: 'messagingChannel',
  channel: 'messagingChannel'
};

function getMetaTestEventFieldsForEvent(eventName) {
  return metaTestEventParameterFields[eventName] || [];
}

function normalizeMetaTestNumber(value) {
  const raw = cleanMetaTestString(value).replace(/[$,\s]/g, '');
  if (!raw) return null;
  const numberValue = Number(raw);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function parseMetaTestContentIds(value) {
  return cleanMetaTestString(value)
    .split(',')
    .map(item => cleanMetaTestString(item))
    .filter(Boolean)
    .slice(0, 50);
}

function normalizeMetaTestCustomParameter(parameter) {
  if (!parameter || typeof parameter !== 'object') {
    return null;
  }

  const key = cleanMetaTestString(parameter.key)
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  const value = cleanMetaTestString(parameter.value);

  if (!key || !value) {
    return null;
  }

  return { key, value }
}

function normalizeMetaTestMessagingChannel(value) {
  const channel = cleanMetaTestString(value).toLowerCase().replace(/[^a-z]/g, '');
  if (channel === 'messenger' || channel === 'facebookmessenger' || channel === 'fbmessenger' || channel === 'facebook') {
    return 'messenger';
  }
  if (channel === 'instagram' || channel === 'instagramdm' || channel === 'ig') {
    return 'instagram';
  }
  return META_TEST_MESSAGING_CHANNELS.has(channel) ? channel : DEFAULT_META_TEST_MESSAGING_CHANNEL;
}

function normalizeMetaTestIdentityAliasKey(key) {
  return cleanMetaTestString(key).toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function applyMetaTestIdentityAlias(normalized, key, value) {
  const cleanValue = cleanMetaTestString(value);
  if (!cleanValue) return false;
  const field = META_TEST_IDENTITY_CUSTOM_PARAMETER_ALIASES[normalizeMetaTestIdentityAliasKey(key)];
  if (!field) return false;

  if (field === 'messagingChannel') {
    normalized.messagingChannel = normalizeMetaTestMessagingChannel(cleanValue);
    return true;
  }

  if (!cleanMetaTestString(normalized[field])) {
    normalized[field] = cleanValue;
  }
  return true;
}

function normalizeMetaTestEventParameters(parameters = {}) {
  const source = parameters && typeof parameters === 'object' ? parameters : {};
  const normalized = {};

  [
    'value',
    'predictedLtv',
    'currency',
    'contentName',
    'contentCategory',
    'contentIds',
    'contentType',
    'numItems',
    'orderId',
    'status',
    'searchString',
    'ctwaClid',
    'messagingChannel',
    'pageId',
    'pageScopedUserId',
    'igSid',
    'instagramAccountId'
  ].forEach((field) => {
    const value = cleanMetaTestString(source[field]);
    if (value) {
      normalized[field] = field === 'messagingChannel' ? normalizeMetaTestMessagingChannel(value) : value;
    }
  });

  [
    ['ctwa_clid', 'ctwaClid'],
    ['referral_ctwa_clid', 'ctwaClid'],
    ['page_id', 'pageId'],
    ['page_scoped_user_id', 'pageScopedUserId'],
    ['psid', 'pageScopedUserId'],
    ['ig_sid', 'igSid'],
    ['ig_scoped_user_id', 'igSid'],
    ['igsid', 'igSid'],
    ['instagram_account_id', 'instagramAccountId'],
    ['ig_account_id', 'instagramAccountId'],
    ['messaging_channel', 'messagingChannel'],
    ['channel', 'messagingChannel']
  ].forEach(([sourceKey, targetKey]) => {
    applyMetaTestIdentityAlias(normalized, targetKey, source[sourceKey]);
  });

  const custom = Array.isArray(source.custom)
    ? source.custom
      .map(normalizeMetaTestCustomParameter)
      .filter(Boolean)
      .filter(parameter => !applyMetaTestIdentityAlias(normalized, parameter.key, parameter.value))
      .slice(0, 12)
    : [];

  if (custom.length) {
    normalized.custom = custom;
  }

  return normalized;
}

function pruneMetaTestEventParametersForEvent(parameters, eventName) {
  const normalized = normalizeMetaTestEventParameters(parameters);
  const fields = getMetaTestEventFieldsForEvent(eventName);

  if (!fields.length) {
    const next = {};
    if (Array.isArray(normalized.custom)) {
      next.custom = normalized.custom;
    }
    return next;
  }

  const next = {};
  fields.forEach((field) => {
    const value = cleanMetaTestString(normalized[field]);
    if (value) {
      next[field] = value;
    }
  });

  if (isWhatsappBusinessMessagingTestEvent(eventName)) {
    next.messagingChannel = normalizeMetaTestMessagingChannel(normalized.messagingChannel);
    ['ctwaClid', 'pageId', 'pageScopedUserId', 'igSid', 'instagramAccountId'].forEach((field) => {
      const value = cleanMetaTestString(normalized[field]);
      if (value) next[field] = value;
    });
  }

  if (Array.isArray(normalized.custom)) {
    next.custom = normalized.custom;
  }

  return next;
}

function buildMetaTestCustomData(parameters = {}, eventName = 'LeadSubmitted') {
  const normalized = pruneMetaTestEventParametersForEvent(parameters, eventName);
  const customData = {};

  const value = normalizeMetaTestNumber(normalized.value);
  if (value !== null) {
    customData.value = value;
  }

  const predictedLtv = normalizeMetaTestNumber(normalized.predictedLtv);
  if (predictedLtv !== null) {
    customData.predicted_ltv = predictedLtv;
  }

  const currency = cleanMetaTestString(normalized.currency).toUpperCase().slice(0, 3);
  if (/^[A-Z]{3}$/.test(currency)) {
    customData.currency = currency;
  }

  const contentIds = parseMetaTestContentIds(normalized.contentIds);
  if (contentIds.length) {
    customData.content_ids = contentIds;
  }

  const numItems = normalizeMetaTestNumber(normalized.numItems);
  if (numItems !== null) {
    customData.num_items = Math.max(0, Math.round(numItems));
  }

  [
    ['contentName', 'content_name'],
    ['contentCategory', 'content_category'],
    ['contentType', 'content_type'],
    ['orderId', 'order_id'],
    ['status', 'status'],
    ['searchString', 'search_string']
  ].forEach(([sourceKey, targetKey]) => {
    const value = cleanMetaTestString(normalized[sourceKey]);
    if (value) {
      customData[targetKey] = value;
    }
  });

  if (Array.isArray(normalized.custom)) {
    normalized.custom.forEach((parameter) => {
      if (!parameter?.key) return;
      const value = cleanMetaTestString(parameter.value);
      if (!value) return;
      customData[parameter.key] = value;
    });
  }

  return customData;
}

function normalizeMetaCurrency(value) {
  const currency = cleanMetaTestString(value).toUpperCase().slice(0, 3);
  return /^[A-Z]{3}$/.test(currency) ? currency : '';
}

function getOutboundMetaTestEventName(eventName = '') {
  return cleanString(eventName) === WHATSAPP_PURCHASE_TEST_EVENT_NAME ? 'Purchase' : eventName;
}

function isWhatsappBusinessMessagingTestEvent(eventName = '') {
  return WHATSAPP_BUSINESS_MESSAGING_TEST_EVENTS.has(cleanString(eventName));
}

function isWhatsappPurchaseTestEvent(eventName = '') {
  return cleanString(eventName) === WHATSAPP_PURCHASE_TEST_EVENT_NAME;
}

function buildMetaTestUserData({ req, eventSourceUrl, datasetId, eventParameters = {}, metaConfig = {}, eventName = '' }) {
  if (isWhatsappBusinessMessagingTestEvent(eventName)) {
    const userData = {};
    const messagingChannel = normalizeMetaTestMessagingChannel(eventParameters.messagingChannel || eventParameters.messaging_channel);
    const pageId = cleanString(eventParameters.pageId || eventParameters.page_id || metaConfig?.page_id || process.env.META_PAGE_ID || process.env.FACEBOOK_PAGE_ID);
    const instagramAccountId = cleanString(
      eventParameters.instagramAccountId ||
      eventParameters.instagram_account_id ||
      eventParameters.ig_account_id ||
      metaConfig?.instagram_account_id ||
      process.env.META_INSTAGRAM_ACCOUNT_ID ||
      process.env.INSTAGRAM_ACCOUNT_ID
    );

    if (messagingChannel === 'messenger') {
      const psid = cleanString(eventParameters.pageScopedUserId || eventParameters.page_scoped_user_id || eventParameters.psid);
      if (pageId) userData.page_id = pageId;
      if (psid) userData.page_scoped_user_id = psid;
      return userData;
    }

    if (messagingChannel === 'instagram') {
      const igsid = cleanString(eventParameters.igSid || eventParameters.ig_sid || eventParameters.igScopedUserId || eventParameters.ig_scoped_user_id || eventParameters.igsid);
      if (instagramAccountId) userData.ig_account_id = instagramAccountId;
      if (igsid) userData.ig_sid = igsid;
      return userData;
    }

    const ctwaClid = cleanString(eventParameters.ctwaClid || eventParameters.ctwa_clid);
    const whatsappBusinessAccountId = cleanString(metaConfig?.whatsapp_business_account_id || process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID);
    if (ctwaClid) userData.ctwa_clid = ctwaClid;
    if (pageId) userData.page_id = pageId;
    if (whatsappBusinessAccountId) userData.whatsapp_business_account_id = whatsappBusinessAccountId;
    return userData;
  }

  return buildMetaBrowserUserData({
    req,
    requestMeta: {
      ip: getRequestIp(req),
      userAgent: cleanString(req.headers?.['user-agent']) || 'Ristak Meta CAPI Test',
      meta: { pageUrl: eventSourceUrl }
    },
    externalId: `ristak_meta_test_${datasetId}`,
    sourceUrl: eventSourceUrl
  });
}

function getRequestIp(req) {
  const forwardedFor = cleanString(req.headers?.['x-forwarded-for']).split(',').map(item => item.trim()).filter(Boolean)[0];
  return forwardedFor || cleanString(req.ip) || cleanString(req.socket?.remoteAddress);
}

function normalizeMetaAdAccountId(value) {
  return cleanString(value).replace(/^act_/i, '');
}

async function resolveMetaAdAccountCurrency({ metaConfig = {}, accessToken = '' } = {}) {
  const localCurrency = normalizeMetaCurrency(metaConfig?.account_currency || metaConfig?.currency);
  if (localCurrency) return localCurrency;

  const adAccountId = normalizeMetaAdAccountId(metaConfig?.ad_account_id || process.env.META_AD_ACCOUNT_ID);
  if (!adAccountId || !accessToken) return '';

  try {
    const params = new URLSearchParams({ fields: 'currency', access_token: accessToken });
    if (metaConfig?.oauth_appsecret_proof) params.set('appsecret_proof', metaConfig.oauth_appsecret_proof);
    const url = `${API_URLS.META_GRAPH}/act_${encodeURIComponent(adAccountId)}?${params.toString()}`;
    const response = await fetch(url);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.error) {
      logger.warn(`No se pudo obtener currency de Meta Ads: ${data?.error?.message || `HTTP ${response.status}`}`);
      return '';
    }
    return normalizeMetaCurrency(data?.currency);
  } catch (error) {
    logger.warn(`Error obteniendo currency de cuenta Meta: ${error.message}`);
    return '';
  }
}

function getPublicBaseUrl(req) {
  return resolvePublicServiceBaseUrl(req, [
    process.env.RENDER_EXTERNAL_URL,
    process.env.PUBLIC_URL
  ]);
}

function hasUsableLocalMetaConfig(metaConfig) {
  return Boolean(metaConfig?.access_token);
}

function toMaskedMetaCredentials(metaConfig = {}, whatsappBusinessAccountId = '', socialConfig = null) {
  const social = socialConfig || metaConfig
  return {
    connectionMode: cleanString(metaConfig.connection_mode) || null,
    adAccountId: normalizeMetaAdAccountId(metaConfig.ad_account_id),
    accessToken: maskSecret(metaConfig.access_token),
    pixelId: cleanString(metaConfig.pixel_id),
    pageId: cleanString(social?.page_id),
    instagramAccountId: cleanString(social?.instagram_account_id),
    whatsappBusinessAccountId: cleanString(whatsappBusinessAccountId)
  };
}

function timestampDateExpression(column, timezone = 'UTC') {
  if (!isPostgres) {
    return `DATE(${column})`;
  }

  const safeTimezone = String(timezone || 'UTC').replace(/'/g, "''");
  return `((${column})::timestamptz AT TIME ZONE '${safeTimezone}')::date`;
}

function timestampDayExpression(column, timezone = 'UTC') {
  if (!isPostgres) {
    return `DATE(${column})`;
  }

  return `TO_CHAR(${timestampDateExpression(column, timezone)}, 'YYYY-MM-DD')`;
}

function metaDateExpression(column) {
  return isPostgres ? `(${column})::date` : `DATE(${column})`;
}

function metaSameLocalDayCondition(metaDateColumn, timestampColumn, timezone = 'UTC') {
  return `${metaDateExpression(metaDateColumn)} = ${timestampDateExpression(timestampColumn, timezone)}`;
}

function metaDayExpression(column) {
  return isPostgres ? `TO_CHAR((${column})::date, 'YYYY-MM-DD')` : `DATE(${column})`;
}

// Rango [start, end] inclusivo sobre una expresión de fecha, con placeholders ?
// compatibles con SQLite y PostgreSQL (la capa db convierte ? a $n en PG).
function dateWindowCondition(dateExpr) {
  return isPostgres
    ? `${dateExpr} >= (?)::date AND ${dateExpr} <= (?)::date`
    : `${dateExpr} >= DATE(?) AND ${dateExpr} <= DATE(?)`;
}

function createContactMetricAccumulator() {
  return {
    interestedKeys: new Set(),
    saleKeys: new Set(),
    appointmentKeys: new Set(),
    attendanceKeys: new Set(),
    contactIdsByKey: new Map()
  };
}

function resolveMetricContactKey(contact) {
  return buildContactKey(contact) || `id::${String(contact?.contact_id || contact?.id || '')}`;
}

function addContactIdForMetricKey(metrics, key, contactId) {
  if (!contactId) return;
  const ids = metrics.contactIdsByKey.get(key) || new Set();
  ids.add(contactId);
  metrics.contactIdsByKey.set(key, ids);
}

function addContactToMetrics(metrics, contact, options = {}) {
  const contactId = contact?.contact_id || contact?.id;
  if (!contactId) return;

  const key = resolveMetricContactKey(contact);
  metrics.interestedKeys.add(key);

  if (options.sale) {
    metrics.saleKeys.add(key);
  }

  if (options.appointment) {
    metrics.appointmentKeys.add(key);
  }

  if (options.attendance) {
    metrics.attendanceKeys.add(key);
  }

  addContactIdForMetricKey(metrics, key, contactId);
}

function mergeContactMetrics(target, source) {
  source.interestedKeys.forEach(key => target.interestedKeys.add(key));
  source.saleKeys.forEach(key => target.saleKeys.add(key));
  source.appointmentKeys.forEach(key => target.appointmentKeys.add(key));
  source.attendanceKeys.forEach(key => target.attendanceKeys.add(key));

  source.contactIdsByKey.forEach((ids, key) => {
    const targetIds = target.contactIdsByKey.get(key) || new Set();
    ids.forEach(id => targetIds.add(id));
    target.contactIdsByKey.set(key, targetIds);
  });
}

function calculateMetricRevenue(metrics, financialsByContactId) {
  let revenue = 0;

  metrics.contactIdsByKey.forEach((contactIds) => {
    let bestStoredLtv = 0;
    let successfulPaymentsTotal = 0;

    contactIds.forEach((contactId) => {
      const financials = financialsByContactId.get(contactId) || { totalPaid: 0, paymentTotal: 0 };
      bestStoredLtv = Math.max(bestStoredLtv, financials.totalPaid || 0);
      successfulPaymentsTotal += financials.paymentTotal || 0;
    });

    revenue += Math.max(bestStoredLtv, successfulPaymentsTotal);
  });

  return revenue;
}

function materializeContactMetrics(metrics, financialsByContactId) {
  return {
    leads: metrics.interestedKeys.size,
    sales: metrics.saleKeys.size,
    appointments: metrics.appointmentKeys.size,
    attendances: metrics.attendanceKeys.size,
    revenue: calculateMetricRevenue(metrics, financialsByContactId)
  };
}

/**
 * Obtiene los calendarios configurados para atribución
 * @returns {Promise<string[]|null>} Array de calendar IDs o null si no están configurados
 */
async function getAttributionCalendarIds() {
  try {
    const config = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      ['attribution_calendar_ids']
    );

    if (!config || !config.config_value) {
      return null; // null = usar todos los calendarios
    }

    const calendarIds = JSON.parse(config.config_value);
    return calendarIds.length > 0 ? calendarIds : null;
  } catch (error) {
    logger.warn(`Error al leer calendarios de atribución: ${error.message}`);
    return null;
  }
}

function toCreativeResponse(media = {}) {
  return {
    creativeId: media.creative_id || null,
    creativeType: media.creative_type || null,
    creativeThumbnailUrl: media.creative_thumbnail_url || null,
    creativeImageUrl: media.creative_image_url || null,
    creativeVideoId: media.creative_video_id || null,
    creativeVideoUrl: media.creative_video_url || null,
    creativePreviewUrl: media.creative_preview_url || null
  };
}

async function cacheCreativeMedia(adId, adAccountId, media = {}) {
  if (!adId || !adAccountId || !media.creative_id) return;

  await db.run(
    `UPDATE meta_ads
     SET creative_id = COALESCE(?, creative_id),
         creative_type = COALESCE(?, creative_type),
         creative_thumbnail_url = COALESCE(?, creative_thumbnail_url),
         creative_image_url = COALESCE(?, creative_image_url),
         creative_video_id = COALESCE(?, creative_video_id),
         creative_video_url = COALESCE(?, creative_video_url),
         creative_preview_url = COALESCE(?, creative_preview_url),
         updated_at = CURRENT_TIMESTAMP
     WHERE ad_id = ? AND ad_account_id = ?`,
    [
      media.creative_id || null,
      media.creative_type || null,
      media.creative_thumbnail_url || null,
      media.creative_image_url || null,
      media.creative_video_id || null,
      media.creative_video_url || null,
      media.creative_preview_url || null,
      adId,
      adAccountId
    ]
  );
}

async function hydrateMissingCreativeMedia(rows = []) {
  const rowsMissingMedia = rows.filter(row =>
    row.ad_id &&
    (
      !row.creative_id ||
      (!row.creative_thumbnail_url && !row.creative_image_url && !row.creative_video_url && !row.creative_preview_url)
    )
  );

  if (rowsMissingMedia.length === 0) return;

  try {
    const metaConfig = await getMetaConfig();
    if (!metaConfig?.access_token || !metaConfig?.ad_account_id) return;

    const missingAdIds = [...new Set(rowsMissingMedia.map(row => String(row.ad_id)).filter(Boolean))];
    const creativeMediaByAdId = await fetchMetaCreativeMediaForAds(
      missingAdIds,
      metaConfig.access_token,
      metaConfig.ad_account_id,
      metaConfig.oauth_appsecret_proof || ''
    );

    for (const row of rowsMissingMedia) {
      const media = creativeMediaByAdId.get(String(row.ad_id));
      if (!media) continue;

      row.creative_id = media.creative_id || row.creative_id || null;
      row.creative_type = media.creative_type || row.creative_type || null;
      row.creative_thumbnail_url = media.creative_thumbnail_url || row.creative_thumbnail_url || null;
      row.creative_image_url = media.creative_image_url || row.creative_image_url || null;
      row.creative_video_id = media.creative_video_id || row.creative_video_id || null;
      row.creative_video_url = media.creative_video_url || row.creative_video_url || null;
      row.creative_preview_url = media.creative_preview_url || row.creative_preview_url || null;

      await cacheCreativeMedia(row.ad_id, metaConfig.ad_account_id, media);
    }
  } catch (error) {
    logger.warn(`No se pudieron hidratar previews de anuncios al vuelo: ${error.message}`);
  }
}

/**
 * Guarda la configuración de Meta Ads
 * USA System User Token (no requiere App ID ni App Secret)
 */
export const saveConfig = async (req, res) => {
  try {
    const { ad_account_id, access_token, pixel_id, page_id, instagram_account_id } = req.body;

    if (!ad_account_id || !access_token) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren ad_account_id y access_token'
      });
    }

    logger.info(`Guardando configuración de Meta para account: ${ad_account_id}${pixel_id ? ` con pixel: ${pixel_id}` : ''}${page_id ? ` con page: ${page_id}` : ''}`);

    const existingConfig = await getLegacyMetaConfig().catch(() => null);
    if (['oauth_bisu', 'oauth_user'].includes(cleanString(existingConfig?.connection_mode))) {
      const validation = await verifyMetaToken(access_token);
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          error: `No se desconectó OAuth porque el System User Token manual no es válido: ${validation.error || 'token inválido'}`
        });
      }
    }

    const persistManualConfig = () => saveMetaConfig(
      ad_account_id, access_token, pixel_id || null, page_id || null, instagram_account_id || null,
      { connectionMode: 'manual_system_user', allowOAuthToManual: true }
    );
    if (['oauth_bisu', 'oauth_user'].includes(cleanString(existingConfig?.connection_mode))) {
      await replaceMetaOAuthWithManualConnection(persistManualConfig);
    } else {
      await persistManualConfig();
    }
    await setAppConfig('meta_config_disconnected', '0');
    await syncRegisteredIntegrationCronsForProvider('meta', { reason: 'meta-connected' });
    await syncRegisteredIntegrationCronsForProvider('meta-ads', { reason: 'meta-connected' });
    await syncRegisteredIntegrationCronsForProvider('meta-social', { reason: 'meta-connected' });
    const socialHistoryBackfill = startMetaSocialHistoryBackfillAfterConnection('meta-config-saved');

    logger.info('Configuración de Meta guardada exitosamente');

    res.json({
      success: true,
      message: 'Configuración de Meta guardada exitosamente',
      socialHistoryBackfill
    });

  } catch (error) {
    logger.error(`Error en saveConfig: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al guardar la configuración de Meta'
    });
  }
};

/**
 * Obtiene la configuración de Meta (sin exponer el token completo)
 */
export const getConfig = async (req, res) => {
  try {
    const rawConfig = await db.get(
      'SELECT access_token FROM meta_config LIMIT 1'
    );
    const config = await getMetaConfig();

    if (!config) {
      return res.json({
        success: true,
        configured: false,
        config: null
      });
    }

    // Verificar si está encriptado
    const tokenEncrypted = isEncrypted(rawConfig?.access_token);

    res.json({
      success: true,
      configured: true,
      config: {
        connectionMode: ['oauth_bisu', 'oauth_user'].includes(cleanString(config.connection_mode))
          ? 'oauth_bisu'
          : 'manual_system_user',
        adAccountId: config.ad_account_id,
        accessToken: maskSecret(config.access_token),
        pixelId: config.pixel_id || null,
        pageId: config.page_id || null,
        instagramAccountId: config.instagram_account_id || null,
        updatedAt: config.updated_at,
        isEncrypted: tokenEncrypted, // Mostrar si está encriptado
        // Timezone info
        timezoneId: config.timezone_id,
        timezoneName: config.timezone_name,
        timezoneOffsetHoursUtc: config.timezone_offset_hours_utc,
        oauthConnected: Number(config.oauth_connected) === 1,
        oauthValidated: Number(config.oauth_validated) === 1,
        oauthUserId: config.oauth_user_id || null,
        oauthUserName: config.oauth_user_name || null,
        oauthAppId: config.oauth_app_id || null,
        oauthBusinessId: config.oauth_business_id || null,
        oauthGrantedScopes: parseJson(config.oauth_granted_scopes_json, []),
        oauthMissingScopes: parseJson(config.oauth_missing_scopes_json, []),
        tokenExpiresAt: config.token_expires_at || null,
        dataAccessExpiresAt: config.oauth_data_access_expires_at || null,
        relayStatus: config.oauth_relay_status || null
      }
    });

  } catch (error) {
    logger.error(`Error en getConfig: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener la configuración de Meta'
    });
  }
};

/**
 * Envía un evento CAPI controlado para validar el Test Event Code de Meta.
 */
const META_PIXEL_TEST_SCOPE = 'meta_pixel_test';
const META_STANDARD_BROWSER_EVENTS = ['Lead', 'Schedule', 'Purchase', 'ViewContent', 'CompleteRegistration', 'Contact'];

function escapeMetaTestHtml(value) {
  return cleanString(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// JSON seguro para embeber dentro de un <script> inline: neutraliza </script>,
// HTML y los separadores de línea U+2028/U+2029 que rompen literales JS.
function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// Límite simple en memoria de envíos CAPI por token de prueba (defensa contra
// replay del enlace público durante su TTL). Se limpia perezosamente por expiración.
const META_PIXEL_TEST_SEND_CAP = 20;
const metaPixelTestSendCounts = new Map();
function registerMetaPixelTestSend(token, expSeconds) {
  const now = Date.now();
  for (const [key, value] of metaPixelTestSendCounts) {
    if (value.exp < now) metaPixelTestSendCounts.delete(key);
  }
  const entry = metaPixelTestSendCounts.get(token) || {
    count: 0,
    exp: expSeconds ? expSeconds * 1000 : now + 600000
  };
  entry.count += 1;
  metaPixelTestSendCounts.set(token, entry);
  return entry.count;
}

/**
 * Construye y envía un evento CAPI de prueba a Meta. Reutilizado por el botón
 * "Solo servidor" (sendMetaTestEvent) y por la página de prueba combinada
 * (navegador + servidor). Devuelve un resultado normalizado, no escribe la
 * respuesta HTTP.
 */
async function performMetaCapiTestEvent({ req, metaConfig, eventName, eventParameters = {}, testEventCode, eventId, eventSourceUrl }) {
  const datasetId = cleanString(metaConfig?.pixel_id || process.env.META_PIXEL_ID || process.env.META_DATASET_ID);
  const accessToken = cleanString(resolveMetaCapiAccessToken(metaConfig));

  if (!datasetId || !accessToken) {
    return { ok: false, status: 400, error: 'Configura Meta Pixel y System User Access Token antes de enviar una prueba', eventId, eventName };
  }
  if (!testEventCode) {
    return { ok: false, status: 400, error: 'Pega el código de Test Events de Meta', eventId, eventName };
  }
  if (!eventName) {
    return { ok: false, status: 400, error: 'Usa un nombre de evento válido, por ejemplo LeadSubmitted', eventId, eventName };
  }

  const normalizedEventParameters = normalizeMetaTestEventParameters(eventParameters);
  const isBusinessMessaging = isWhatsappBusinessMessagingTestEvent(eventName);
  const isWhatsappPurchase = isWhatsappPurchaseTestEvent(eventName);
  const messagingChannel = isBusinessMessaging
    ? normalizeMetaTestMessagingChannel(normalizedEventParameters.messagingChannel)
    : '';
  const outboundEventName = getOutboundMetaTestEventName(eventName);
  const messagingChannelLabel = messagingChannel === 'instagram' ? 'Instagram' : messagingChannel === 'messenger' ? 'Messenger' : 'WhatsApp';
  const messagingEventLabel = isWhatsappPurchase ? `Purchase de ${messagingChannelLabel}` : `LeadSubmitted de ${messagingChannelLabel}`;
  const userData = buildMetaTestUserData({
    req,
    eventSourceUrl,
    datasetId,
    eventParameters: normalizedEventParameters,
    metaConfig,
    eventName
  });

  if (isBusinessMessaging) {
    if (messagingChannel === 'whatsapp' && !userData.ctwa_clid) {
      return { ok: false, status: 400, error: `Pega un ctwa_clid real para probar ${messagingEventLabel}`, eventId, eventName };
    }
    if (messagingChannel === 'messenger' && !userData.page_scoped_user_id) {
      return { ok: false, status: 400, error: `Pega un page_scoped_user_id real para probar ${messagingEventLabel}`, eventId, eventName };
    }
    if (messagingChannel === 'instagram' && !userData.ig_sid) {
      return { ok: false, status: 400, error: `Pega un ig_sid real para probar ${messagingEventLabel}`, eventId, eventName };
    }
    if (messagingChannel === 'instagram' && !userData.ig_account_id) {
      return { ok: false, status: 400, error: `Configura una cuenta de Instagram antes de probar ${messagingEventLabel}`, eventId, eventName };
    }
    if (messagingChannel !== 'instagram' && !userData.page_id) {
      return { ok: false, status: 400, error: `Configura una Facebook Page antes de probar ${messagingEventLabel}`, eventId, eventName };
    }
  }

  if (isWhatsappPurchase) {
    if (normalizeMetaTestNumber(normalizedEventParameters.value) === null) {
      return { ok: false, status: 400, error: 'Agrega un valor para probar Purchase de WhatsApp', eventId, eventName };
    }

    const accountCurrency = normalizeMetaCurrency(normalizedEventParameters.currency) || normalizeMetaCurrency(await getAccountCurrency()) || await resolveMetaAdAccountCurrency({ metaConfig, accessToken });
    if (!accountCurrency) {
      return {
        ok: false,
        status: 400,
        error: `No se pudo resolver la moneda de la cuenta para ${messagingEventLabel}`,
        eventId,
        eventName
      };
    }

    normalizedEventParameters.currency = accountCurrency;
  }

  const eventPayload = {
    event_name: outboundEventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    user_data: userData,
    custom_data: {
      source: 'ristak_settings',
      conversion_type: 'settings_test_event',
      ...buildMetaTestCustomData(normalizedEventParameters, outboundEventName)
    }
  };

  if (isBusinessMessaging) {
    eventPayload.action_source = 'business_messaging';
    eventPayload.messaging_channel = messagingChannel;
    eventPayload.custom_data.messaging_channel = messagingChannel;
  } else {
    eventPayload.action_source = 'website';
    eventPayload.event_source_url = eventSourceUrl;
    if (!eventPayload.custom_data.content_name) {
      eventPayload.custom_data.content_name = 'Ristak Meta CAPI test';
    }
  }

  const payload = {
    test_event_code: testEventCode,
    data: [eventPayload]
  };

  try {
    const capiParams = new URLSearchParams({ access_token: accessToken });
    if (metaConfig?.oauth_appsecret_proof) capiParams.set('appsecret_proof', metaConfig.oauth_appsecret_proof);
    const response = await fetch(`${API_URLS.META_GRAPH}/${encodeURIComponent(datasetId)}/events?${capiParams.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const responsePayload = await response.json().catch(() => ({}));
    if (!response.ok || responsePayload?.error) {
      return { ok: false, status: response.ok ? 400 : response.status, error: describeMetaCapiResponseError(responsePayload, response.status), eventId, eventName: outboundEventName, responsePayload };
    }
    return { ok: true, eventId, eventName: outboundEventName, testEventCode, responsePayload };
  } catch (error) {
    logger.error(`Error enviando evento CAPI de prueba: ${error.message}`);
    return { ok: false, status: 500, error: 'Error al enviar evento de prueba a Meta', eventId, eventName: outboundEventName };
  }
}

/**
 * Envía un evento CAPI controlado para validar el Test Event Code de Meta.
 */
export const sendMetaTestEvent = async (req, res) => {
  try {
    const [adsConfig, socialConfig, whatsappBusinessAccountId] = await Promise.all([
      getMetaConfig(),
      getMetaSocialConfig().catch(() => null),
      getMetaWhatsAppBusinessAccountId().catch(() => '')
    ]);
    const metaConfig = adsConfig
      ? {
          ...adsConfig,
          page_id: socialConfig?.page_id || null,
          instagram_account_id: socialConfig?.instagram_account_id || null,
          whatsapp_business_account_id: whatsappBusinessAccountId || null
        }
      : adsConfig;
    const testEventCode = cleanString(req.body?.testEventCode || req.body?.test_event_code || await getActiveMetaTestEventCode()).replace(/\s+/g, '');
    const eventName = normalizeMetaTestEventName(req.body?.eventName || req.body?.event_name);
    const eventParameters = normalizeMetaTestEventParameters(req.body?.eventParameters || req.body?.event_parameters);
    const eventId = `ristak_meta_test_${Date.now()}_${crypto.randomUUID()}`;
    const eventSourceUrl = cleanString(req.body?.eventSourceUrl || req.body?.event_source_url) || `${getPublicBaseUrl(req)}/settings/meta-ads`;

    const result = await performMetaCapiTestEvent({ req, metaConfig, eventName, eventParameters, testEventCode, eventId, eventSourceUrl });

    if (!result.ok) {
      return res.status(result.status || 400).json({
        success: false,
        error: result.error,
        eventId: result.eventId,
        eventName: result.eventName,
        responsePayload: result.responsePayload
      });
    }

    res.json({
      success: true,
      message: 'Evento de prueba enviado a Meta',
      eventId: result.eventId,
      eventName: result.eventName,
      testEventCode: result.testEventCode,
      responsePayload: result.responsePayload
    });
  } catch (error) {
    logger.error(`Error en sendMetaTestEvent: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al enviar evento de prueba a Meta'
    });
  }
};

/**
 * Genera un enlace corto y firmado para abrir la página de prueba del pixel
 * (navegador + servidor) en una pestaña nueva. Requiere auth; caduca en 10 min.
 */
export const createMetaPixelTestLink = async (req, res) => {
  try {
    const metaConfig = await getMetaConfig();
    const pixelId = cleanString(metaConfig?.pixel_id || process.env.META_PIXEL_ID || process.env.META_DATASET_ID);
    if (!pixelId) {
      return res.status(400).json({ success: false, error: 'Configura un Meta Pixel antes de abrir la prueba' });
    }
    const accessToken = cleanString(resolveMetaCapiAccessToken(metaConfig));
    const eventName = normalizeMetaTestEventName(req.body?.eventName || req.body?.event_name);
    if (!eventName) {
      return res.status(400).json({ success: false, error: 'Usa un nombre de evento válido, por ejemplo LeadSubmitted' });
    }
    const testEventCode = cleanString(req.body?.testEventCode || req.body?.test_event_code || await getActiveMetaTestEventCode()).replace(/\s+/g, '');
    const eventParameters = normalizeMetaTestEventParameters(req.body?.eventParameters || req.body?.event_parameters);

    const token = signScopedToken(META_PIXEL_TEST_SCOPE, {
      eventName,
      testEventCode,
      eventParameters,
      hasServer: Boolean(accessToken && testEventCode)
    }, 600);

    const url = `${getPublicBaseUrl(req)}/api/meta/pixel-test?t=${encodeURIComponent(token)}`;
    res.json({ success: true, url });
  } catch (error) {
    logger.error(`Error en createMetaPixelTestLink: ${error.message}`);
    res.status(500).json({ success: false, error: 'No se pudo generar la prueba del pixel' });
  }
};

/**
 * Página pública (protegida por token corto) que carga el Meta Pixel real en el
 * <head>, dispara el evento por navegador y por servidor con el mismo event_id,
 * y muestra en vivo si jaló o no por cada lado.
 */
export const renderMetaPixelTestPage = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const data = verifyScopedToken(META_PIXEL_TEST_SCOPE, req.query?.t);
  if (!data) {
    return res.status(401).type('html').send(renderMetaPixelTestShell({
      title: 'Enlace inválido',
      message: 'Este enlace de prueba ya expiró o no es válido. Vuelve a abrirlo desde Ajustes → Meta.'
    }));
  }

  const metaConfig = await getMetaConfig().catch(() => null);
  const pixelId = cleanString(metaConfig?.pixel_id || process.env.META_PIXEL_ID || process.env.META_DATASET_ID);
  if (!pixelId) {
    return res.status(400).type('html').send(renderMetaPixelTestShell({
      title: 'Sin Meta Pixel',
      message: 'No hay un Meta Pixel configurado en esta cuenta. Conéctalo en Ajustes → Meta.'
    }));
  }

  const eventName = normalizeMetaTestEventName(data.eventName) || 'LeadSubmitted';
  const method = META_STANDARD_BROWSER_EVENTS.includes(eventName) ? 'track' : 'trackCustom';
  return res.status(200).type('html').send(renderMetaPixelTestPageHtml({
    pixelId,
    eventName,
    method,
    hasServer: Boolean(data.hasServer),
    token: cleanString(req.query?.t),
    testEventCode: cleanString(data.testEventCode),
    eventParameters: normalizeMetaTestEventParameters(data.eventParameters)
  }));
};

/**
 * Envía el lado servidor (CAPI) de la página de prueba, usando el mismo event_id
 * que disparó el navegador para que Meta deduplique. Protegido por token corto.
 */
export const runMetaPixelTestServerEvent = async (req, res) => {
  try {
    const token = req.query?.t || req.body?.t;
    const data = verifyScopedToken(META_PIXEL_TEST_SCOPE, token);
    if (!data) {
      return res.status(401).json({ success: false, error: 'Enlace de prueba inválido o expirado' });
    }

    if (registerMetaPixelTestSend(token, data.exp) > META_PIXEL_TEST_SEND_CAP) {
      return res.status(429).json({ success: false, error: 'Demasiados intentos con este enlace. Vuelve a abrir la prueba desde Ajustes → Meta.' });
    }

    const [adsConfig, socialConfig] = await Promise.all([
      getMetaConfig(),
      getMetaSocialConfig().catch(() => null)
    ]);
    const metaConfig = adsConfig
      ? { ...adsConfig, page_id: socialConfig?.page_id || null, instagram_account_id: socialConfig?.instagram_account_id || null }
      : adsConfig;
    const eventName = normalizeMetaTestEventName(data.eventName);
    const eventParameters = normalizeMetaTestEventParameters(data.eventParameters);
    const testEventCode = cleanString(data.testEventCode).replace(/\s+/g, '');
    const eventId = cleanString(req.body?.eventId) || `ristak_meta_test_${Date.now()}_${crypto.randomUUID()}`;
    const eventSourceUrl = `${getPublicBaseUrl(req)}/api/meta/pixel-test`;

    const result = await performMetaCapiTestEvent({ req, metaConfig, eventName, eventParameters, testEventCode, eventId, eventSourceUrl });

    if (!result.ok) {
      // Endpoint público: no reenviamos la respuesta cruda de Meta, solo lo necesario.
      return res.status(result.status || 400).json({
        success: false,
        error: result.error,
        eventId: result.eventId,
        eventName: result.eventName
      });
    }

    res.json({
      success: true,
      eventId: result.eventId,
      eventName: result.eventName,
      eventsReceived: result.responsePayload?.events_received,
      fbtraceId: result.responsePayload?.fbtrace_id
    });
  } catch (error) {
    logger.error(`Error en runMetaPixelTestServerEvent: ${error.message}`);
    res.status(500).json({ success: false, error: 'Error al enviar el evento de prueba al servidor' });
  }
};

const META_PIXEL_TEST_STYLES = `
  *{box-sizing:border-box}
  body{margin:0;background:#0b0f17;color:#e7ecf3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{width:100%;max-width:560px;background:#121826;border:1px solid #1f2937;border-radius:18px;padding:28px;box-shadow:0 18px 50px rgba(0,0,0,.45)}
  .logo{font-weight:800;letter-spacing:.2px;color:#9db2d3;font-size:13px;text-transform:uppercase}
  h1{margin:6px 0 4px;font-size:22px}
  .sub{margin:0 0 18px;color:#9aa7bd;font-size:14px}
  .sub b{color:#e7ecf3}
  .verdict{border-radius:12px;padding:13px 15px;font-weight:600;font-size:14px;margin-bottom:16px;border:1px solid #243044;background:#0e1422;color:#cdd8ea}
  .verdict[data-state=ok]{background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.4);color:#86efac}
  .verdict[data-state=warn]{background:rgba(245,158,11,.12);border-color:rgba(245,158,11,.4);color:#fcd34d}
  .verdict[data-state=err]{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.4);color:#fca5a5}
  .rows{display:flex;flex-direction:column;gap:10px}
  .row{display:flex;gap:12px;align-items:flex-start;border:1px solid #1f2937;border-radius:12px;padding:13px 14px;background:#0e1422}
  .row .ic{flex:0 0 22px;height:22px;border-radius:50%;border:2px solid #334155;position:relative;margin-top:1px}
  .row[data-state=loading] .ic{border-color:#3b82f6;border-right-color:transparent;animation:spin .8s linear infinite}
  .row[data-state=ok] .ic{border-color:#22c55e;background:#22c55e}
  .row[data-state=ok] .ic:after{content:'';position:absolute;left:6px;top:2px;width:5px;height:10px;border:solid #06210f;border-width:0 2px 2px 0;transform:rotate(45deg)}
  .row[data-state=err] .ic{border-color:#ef4444;background:#ef4444}
  .row[data-state=err] .ic:after{content:'';position:absolute;left:9px;top:4px;width:2px;height:12px;background:#2a0606}
  .row[data-state=skip] .ic{border-color:#64748b;background:#1e293b}
  .row .title{font-weight:600;font-size:14px}
  .row .text{color:#9aa7bd;font-size:13px;margin-top:3px;word-break:break-word}
  @keyframes spin{to{transform:rotate(360deg)}}
  .meta{margin-top:16px;padding-top:14px;border-top:1px solid #1f2937;display:flex;flex-direction:column;gap:5px}
  .meta .lbl{font-size:12px;color:#7c8aa3;text-transform:uppercase;letter-spacing:.3px}
  .meta code{font-size:12px;color:#cbd5e1;background:#0b0f17;border:1px solid #1f2937;border-radius:8px;padding:8px 10px;word-break:break-all}
  .actions{margin-top:16px}
  .btn{appearance:none;border:1px solid #2b3850;background:#1b2740;color:#e7ecf3;border-radius:10px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer}
  .btn:hover{background:#22304d}
  .hint{margin:14px 0 0;font-size:12px;color:#7c8aa3;line-height:1.5}
`;

function renderMetaPixelTestShell({ title, message }) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeMetaTestHtml(title)} · Ristak</title><style>${META_PIXEL_TEST_STYLES}</style></head><body><div class="card"><div class="logo">Ristak</div><h1>${escapeMetaTestHtml(title)}</h1><p class="sub">${escapeMetaTestHtml(message)}</p></div></body></html>`;
}

function renderMetaPixelTestPageHtml({ pixelId, eventName, method, hasServer, token, testEventCode, eventParameters = {} }) {
  // Mismos parámetros que el evento de servidor, para que navegador y CAPI
  // manden el mismo custom_data.
  const customData = {
    source: 'ristak_settings',
    conversion_type: 'settings_test_event',
    ...buildMetaTestCustomData(eventParameters, eventName)
  };
  const cfg = safeJsonForScript({ pixelId, eventName, method, hasServer, token, customData });
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Prueba de Meta Pixel · Ristak</title>
  <script>
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
    n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}
    (window, document,'script','https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', ${safeJsonForScript(pixelId)});
    fbq('track', 'PageView');
  </script>
  <noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${encodeURIComponent(pixelId)}&ev=PageView&noscript=1"/></noscript>
  <style>${META_PIXEL_TEST_STYLES}</style>
</head>
<body>
  <div class="card">
    <div class="logo">Ristak · Diagnóstico</div>
    <h1>Prueba de Meta Pixel</h1>
    <p class="sub">Pixel <b>${escapeMetaTestHtml(pixelId)}</b> · Evento <b>${escapeMetaTestHtml(eventName)}</b>${testEventCode ? ` · Test code <b>${escapeMetaTestHtml(testEventCode)}</b>` : ''}</p>
    <div id="verdict" class="verdict" data-state="loading">Probando el pixel…</div>
    <div class="rows">
      <div class="row" id="browserRow" data-state="loading">
        <div class="ic"></div>
        <div class="body"><div class="title">Pixel del navegador</div><div class="text" data-text>Disparando el evento en el navegador…</div></div>
      </div>
      <div class="row" id="serverRow" data-state="loading">
        <div class="ic"></div>
        <div class="body"><div class="title">Conversions API (servidor)</div><div class="text" data-text>Enviando el evento al servidor…</div></div>
      </div>
    </div>
    <div class="meta">
      <span class="lbl">Event ID (deduplica navegador + servidor)</span>
      <code id="eventId">—</code>
    </div>
    <div class="actions"><button class="btn" type="button" onclick="location.reload()">Repetir prueba</button></div>
    <p class="hint">Busca este Event ID en Meta Events Manager → Eventos de prueba. El navegador y el servidor mandan el mismo ID, así Meta los cuenta como un solo evento.</p>
  </div>
  <script>
    (function(){
      var CFG = ${cfg};
      function row(id){ return document.getElementById(id); }
      function setRow(id, state, text){ var r = row(id); if(!r) return; r.setAttribute('data-state', state); var t = r.querySelector('[data-text]'); if(t) t.textContent = text; }
      function setVerdict(state, text){ var v = row('verdict'); if(!v) return; v.setAttribute('data-state', state); v.textContent = text; }
      var eventId = 'ristak_meta_test_' + Date.now() + '_' + Math.random().toString(16).slice(2);
      row('eventId').textContent = eventId;

      var browserDone = false, browserOk = false, serverDone = false, serverOk = false;
      function recompute(){
        if(!browserDone || !serverDone) return;
        if(browserOk && serverOk) setVerdict('ok', 'Todo jaló: el pixel del navegador y el servidor (CAPI) enviaron el evento.');
        else if(browserOk && !CFG.hasServer) setVerdict('warn', 'El pixel del navegador disparó. El servidor (CAPI) quedó omitido (agrega el System User Token y el código de Test Events).');
        else if(browserOk && !serverOk) setVerdict('warn', 'El navegador disparó pero el servidor (CAPI) falló. Revisa el detalle de abajo.');
        else if(!browserOk && serverOk) setVerdict('warn', 'El servidor (CAPI) jaló pero el navegador no (probable bloqueador). Prueba en incógnito o sin ad-blocker.');
        else if(!browserOk && !CFG.hasServer) setVerdict('err', 'El navegador no pudo enviar el evento (probable bloqueador). El servidor (CAPI) quedó omitido.');
        else setVerdict('err', 'No jaló por ninguno de los dos lados. Revisa el detalle de abajo.');
      }
      function markBrowser(ok, text){ if(browserDone) return; browserDone = true; browserOk = ok; setRow('browserRow', ok ? 'ok' : 'err', text); recompute(); }

      try {
        if (window.fbq) {
          window.fbq(CFG.method, CFG.eventName, CFG.customData, { eventID: eventId });
        }
      } catch (e) {}

      // Señal fiable de que fbevents.js cargó de verdad: la librería real define
      // fbq.callMethod (el stub NO). fbq.loaded lo pone el stub al instante, así
      // que no sirve. Si nunca aparece, es un bloqueador de anuncios.
      var browserTries = 0;
      var browserPoll = setInterval(function(){
        browserTries++;
        if (window.fbq && typeof window.fbq.callMethod === 'function') {
          clearInterval(browserPoll);
          markBrowser(true, 'Pixel ' + CFG.pixelId + ' cargado y evento "' + CFG.eventName + '" enviado a Meta desde el navegador.');
        } else if (browserTries >= 16) {
          clearInterval(browserPoll);
          markBrowser(false, 'El script del pixel no cargó (lo bloqueó el navegador o una extensión). Prueba en incógnito o sin ad-blocker.');
        }
      }, 400);

      if (!CFG.hasServer) {
        serverDone = true; serverOk = false;
        setRow('serverRow', 'skip', 'Omitido: agrega el System User Token y el código de Test Events para probar el servidor.');
        recompute();
      } else {
        fetch('/api/meta/pixel-test/event?t=' + encodeURIComponent(CFG.token), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: eventId })
        }).then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { ok: r.ok, j: j }; }); })
        .then(function(res){
          serverDone = true;
          if (res.ok && res.j && res.j.success) {
            serverOk = true;
            var recv = (res.j.eventsReceived != null) ? res.j.eventsReceived : ((res.j.responsePayload && res.j.responsePayload.events_received) != null ? res.j.responsePayload.events_received : 1);
            var trace = res.j.fbtraceId || (res.j.responsePayload && res.j.responsePayload.fbtrace_id) || '';
            setRow('serverRow', 'ok', 'Meta recibió el evento (events_received: ' + recv + ')' + (trace ? ' · fbtrace_id: ' + trace : ''));
          } else {
            serverOk = false;
            setRow('serverRow', 'err', (res.j && res.j.error) ? res.j.error : 'El servidor no pudo enviar el evento a Meta.');
          }
          recompute();
        }).catch(function(){
          serverDone = true; serverOk = false;
          setRow('serverRow', 'err', 'Error de red al contactar el servidor de Ristak.');
          recompute();
        });
      }
    })();
  </script>
</body>
</html>`;
}

/**
 * Revela el access token completo (desencriptado) para uso interno del frontend
 * Solo se usa cuando el frontend necesita hacer llamadas a Meta API
 */
export const revealMetaToken = async (req, res) => {
  try {
    const metaConfig = await getMetaConfig();

    if (!metaConfig) {
      return res.status(404).json({
        success: false,
        error: 'No hay configuración de Meta guardada'
      });
    }

    if (['oauth_bisu', 'oauth_user'].includes(cleanString(metaConfig.connection_mode))) {
      return res.status(409).json({
        success: false,
        error: 'El token OAuth de Meta está protegido y no se puede revelar. Usa los endpoints server-side de activos.'
      });
    }

    res.json({
      success: true,
      accessToken: metaConfig.access_token // Ya viene desencriptado de getMetaConfig()
    });

  } catch (error) {
    logger.error(`Error en revealMetaToken: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al revelar el token de Meta'
    });
  }
};

export const getMetaWebhookInfo = async (req, res) => {
  try {
    const baseUrl = getPublicBaseUrl(req);
    const verifyToken = await getMetaWebhookVerifyToken();

    res.json({
      success: true,
      data: {
        webhookUrl: `${baseUrl}/webhook/meta`,
        verifyToken,
        fields: META_PAGE_SUBSCRIBED_FIELDS
      }
    });
  } catch (error) {
    logger.error(`Error en getMetaWebhookInfo: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener datos del webhook de Meta'
    });
  }
};

/**
 * Suscribe la Página de Facebook al webhook de mensajería de la app.
 * Este es el "avisarle al cartero": activar el toggle en Ristak sólo prende la
 * bandera local; sin esta suscripción Meta nunca entrega los mensajes al webhook.
 * Es idempotente. Devuelve 200 aun si falla la suscripción (con subscribed:false
 * + motivo), porque el toggle ya se guardó por su cuenta y el usuario necesita el
 * motivo exacto para completar la configuración en el panel de Meta.
 */
export const subscribeMetaSocialMessaging = async (req, res) => {
  try {
    const result = await ensureMetaPageMessagingSubscription();
    logger.info(`[Meta social] Página suscrita al webhook por el usuario: ${result.pageId}`);
    res.json({ success: true, subscribed: true, ...result });
  } catch (error) {
    logger.warn(`No se pudo suscribir la Página al webhook de Meta: ${error.message}`);
    res.status(200).json({
      success: false,
      subscribed: false,
      error: error.message || 'No se pudo suscribir la Página al webhook de Meta'
    });
  }
};

/**
 * Lee el estado real de la suscripción de la Página (para diagnóstico/UI).
 */
export const getMetaSocialMessagingSubscription = async (req, res) => {
  try {
    const status = await getMetaPageMessagingSubscription();
    res.json({ success: true, ...status });
  } catch (error) {
    logger.warn(`No se pudo leer la suscripción de la Página: ${error.message}`);
    res.status(200).json({ success: false, subscribed: false, error: error.message });
  }
};

/**
 * Devuelve el enlace de Developers correcto para la app/portafolio conectados,
 * sin mandar IDs ni tokens sensibles al frontend fuera de los IDs públicos.
 */
export const getMetaSocialMessagingSetup = async (req, res) => {
  try {
    const setup = await getMetaDeveloperSetup();
    res.json({ success: true, ...setup });
  } catch (error) {
    logger.warn(`No se pudo preparar la configuración de Messenger en Meta Developers: ${error.message}`);
    res.status(200).json({
      success: false,
      configured: false,
      appId: '',
      businessId: '',
      messengerUrl: '',
      instagramUrl: '',
      messengerUserTokenConfigured: false,
      error: error.message || 'No se pudo preparar la configuración de Messenger'
    });
  }
};

/**
 * Guarda y verifica el User Token humano que Messenger requiere para hablar
 * con personas externas a la app. Antes de persistirlo comprobamos que pueda
 * derivar un Page Token para la Página seleccionada.
 */
export const saveMetaMessengerUserToken = async (req, res) => {
  try {
    const userToken = cleanString(req.body?.userToken);
    if (userToken.length < 40) {
      return res.status(400).json({
        success: false,
        error: 'Pega el User Token completo de Messenger.'
      });
    }

    const config = await getMetaSocialConfig();
    if (!config?.page_id) {
      return res.status(409).json({
        success: false,
        error: 'Selecciona primero una Facebook Page en el wizard de Meta.'
      });
    }

    const tokenStatus = await verifyMetaToken(userToken);
    if (!tokenStatus.valid) {
      return res.status(400).json({
        success: false,
        error: tokenStatus.error || 'El User Token de Messenger no es válido.'
      });
    }

    // No guardamos un token que Meta no pueda convertir al Page Token que usa
    // realmente el endpoint de Messenger.
    await resolveMetaPageAccessToken({
      config: { ...config, messenger_user_token: userToken },
      forceRefresh: true,
      platform: 'messenger'
    });

    await persistMetaMessengerUserToken(userToken);
    const socialChannels = await enableMetaSocialChannelsForConnectedProfiles(config);
    const subscription = await ensureMetaPageMessagingSubscription();
    const setup = await getMetaDeveloperSetup();

    res.json({
      success: true,
      configured: true,
      socialChannels,
      subscription,
      setup
    });
  } catch (error) {
    logger.warn(`No se pudo guardar el User Token de Messenger: ${error.message}`);
    res.status(400).json({
      success: false,
      error: error.message || 'No se pudo guardar el User Token de Messenger.'
    });
  }
};

/**
 * Elimina la configuración local de Meta Ads
 */
export const deleteMetaConfig = async (req, res) => {
  try {
    const existingConfig = await getLegacyMetaConfig().catch(() => null);
    if (existingConfig && ['oauth_bisu', 'oauth_user'].includes(cleanString(existingConfig.connection_mode))) {
      const result = await disconnectMetaOAuthConnection();
      return res.json({
        success: true,
        message: 'Conexión OAuth de Meta eliminada exitosamente',
        data: result
      });
    }

    const splitConnections = await db.get(
      `SELECT COUNT(*) AS total FROM meta_oauth_integrations WHERE status = 'active'`
    ).catch(() => ({ total: 0 }));
    if (Number(splitConnections?.total || 0) > 0) {
      // El botón legacy elimina únicamente su fallback. Las conexiones OAuth
      // separadas conservan tokens, toggles sociales y estado de relay.
      await db.run('DELETE FROM meta_config');
    } else {
      await clearMetaIntegrationCredentials();
    }
    await setAppConfig('meta_config_disconnected', '1');
    await syncRegisteredIntegrationCronsForProvider('meta', { reason: 'meta-disconnected' });
    await syncRegisteredIntegrationCronsForProvider('meta-ads', { reason: 'meta-legacy-disconnected' });
    await syncRegisteredIntegrationCronsForProvider('meta-social', { reason: 'meta-legacy-disconnected' });

    logger.info('Configuración de Meta eliminada');

    res.json({
      success: true,
      message: 'Configuración de Meta eliminada exitosamente'
    });
  } catch (error) {
    logger.error(`Error en deleteMetaConfig: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al eliminar la configuración de Meta'
    });
  }
};

/**
 * Sincroniza anuncios de Meta desde una fecha específica
 */
export const syncAds = async (req, res) => {
  try {
    const { startDate } = req.body;

    if (!startDate) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere startDate (formato: YYYY-MM-DD)'
      });
    }

    logger.info(`Iniciando sincronización de Meta Ads desde: ${startDate}`);

    // Iniciar sincronización (no esperar a que termine)
    syncMetaAds(startDate).catch(error => {
      logger.error(`Error en syncMetaAds: ${error.message}`);
    });

    res.json({
      success: true,
      message: 'Sincronización de Meta Ads iniciada. Usa getSyncProgress para ver el progreso.'
    });

  } catch (error) {
    logger.error(`Error en syncAds: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al iniciar la sincronización de Meta Ads'
    });
  }
};

/**
 * Obtiene el progreso actual de la sincronización de Meta
 */
export const getSyncProgressEndpoint = async (req, res) => {
  try {
    const progress = getMetaSyncProgress();

    res.json({
      success: true,
      progress
    });

  } catch (error) {
    logger.error(`Error en getSyncProgress: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener el progreso de sincronización'
    });
  }
};

const META_PREVIEW_FORMATS = [
  'DESKTOP_FEED_STANDARD',
  'MOBILE_FEED_STANDARD',
  'INSTAGRAM_STANDARD',
  'INSTAGRAM_REELS',
  'INSTAGRAM_STORY',
  'FACEBOOK_REELS_MOBILE',
  'FACEBOOK_STORY_MOBILE'
];

/**
 * Obtiene el preview renderizado por Meta para un creative.
 * El HTML de Meta suele venir como iframe/snippet y puede expirar, por eso se pide bajo demanda.
 */
export const getCreativePreview = async (req, res) => {
  try {
    const creativeId = String(req.params.creativeId || '').trim();
    const requestedFormat = String(req.query.adFormat || META_PREVIEW_FORMATS[0]).trim().toUpperCase();

    if (!/^[0-9]+$/.test(creativeId)) {
      return res.status(400).json({
        success: false,
        error: 'creativeId inválido'
      });
    }

    const metaConfig = await getMetaConfig();
    if (!metaConfig?.access_token) {
      return res.status(404).json({
        success: false,
        error: 'No hay configuración de Meta guardada'
      });
    }

    const formatsToTry = [
      META_PREVIEW_FORMATS.includes(requestedFormat) ? requestedFormat : META_PREVIEW_FORMATS[0],
      ...META_PREVIEW_FORMATS
    ].filter((format, index, formats) => formats.indexOf(format) === index);

    const errors = [];

    for (const adFormat of formatsToTry) {
      try {
        const params = new URLSearchParams({
          fields: 'body',
          ad_format: adFormat,
          access_token: metaConfig.access_token
        });
        if (metaConfig.oauth_appsecret_proof) params.set('appsecret_proof', metaConfig.oauth_appsecret_proof);
        const response = await fetch(`${API_URLS.META_GRAPH}/${encodeURIComponent(creativeId)}/previews?${params.toString()}`);
        const data = await response.json();

        if (data.error) {
          errors.push(`${adFormat}: ${data.error.message}`);
          continue;
        }

        const preview = Array.isArray(data?.data) ? data.data.find(item => item?.body) : null;
        if (preview?.body) {
          return res.json({
            success: true,
            creativeId,
            adFormat,
            body: preview.body
          });
        }
      } catch (error) {
        errors.push(`${adFormat}: ${error.message}`);
      }
    }

    logger.warn(`Meta no regresó preview para creative ${creativeId}: ${errors.join(' | ')}`);
    return res.status(404).json({
      success: false,
      error: 'Meta no regresó preview para este creative'
    });
  } catch (error) {
    logger.error(`Error en getCreativePreview: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener preview del creative'
    });
  }
};

/**
 * Busca media de un anuncio por ad_id directamente en Meta.
 * Sirve como fallback cuando la DB todavía no tiene creative_* poblado.
 */
export const getAdCreativeMedia = async (req, res) => {
  try {
    const adId = String(req.params.adId || '').trim();

    if (!/^[0-9]+$/.test(adId)) {
      return res.status(400).json({
        success: false,
        error: 'adId inválido'
      });
    }

    const metaConfig = await getMetaConfig();
    if (!metaConfig?.access_token || !metaConfig?.ad_account_id) {
      return res.status(404).json({
        success: false,
        error: 'No hay configuración de Meta guardada'
      });
    }

    const media = await fetchMetaCreativeMediaForAd(
      adId,
      metaConfig.access_token,
      metaConfig.ad_account_id,
      metaConfig.oauth_appsecret_proof || ''
    );

    if (!media?.creative_id) {
      return res.status(404).json({
        success: false,
        error: 'Meta no regresó creative para este anuncio'
      });
    }

    await cacheCreativeMedia(adId, metaConfig.ad_account_id, media);

    res.json({
      success: true,
      adId,
      creative: toCreativeResponse(media)
    });
  } catch (error) {
    logger.error(`Error en getAdCreativeMedia: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener media del anuncio'
    });
  }
};

/**
 * Inicia sincronización manual de Meta Ads desde hace 35 meses (como HighLevel)
 */
export const updateRecent = async (req, res) => {
  try {
    logger.info('Iniciando actualización manual inmediata de Meta Ads (últimos 7 días)');

    const recentResult = await updateRecentAds();

    if (!recentResult.success) {
      const statusCode = recentResult.message === 'Sync completo en progreso' ? 409 : 400;

      return res.status(statusCode).json({
        success: false,
        message: recentResult.message || 'No se pudo actualizar Meta Ads',
        error: recentResult.error || recentResult.message || 'Error al actualizar Meta Ads'
      });
    }

    const startDateStr = buildMetaAdsHistoricalSyncStartDate();

    logger.info(`Actualización reciente completada. Iniciando sincronización histórica de Meta Ads (35 meses) desde: ${startDateStr}`);

    // Iniciar el histórico en background; los datos recientes ya quedaron actualizados.
    syncMetaAds(startDateStr).catch(error => {
      logger.error(`Error en sincronización manual de Meta Ads (35 meses): ${error.message}`);
    });

    res.json({
      success: true,
      count: recentResult.count || 0,
      message: `Meta Ads actualizado: ${recentResult.count || 0} filas recientes guardadas. Histórico de 35 meses iniciado en segundo plano.`
    });

  } catch (error) {
    logger.error(`Error en updateRecent: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al iniciar la sincronización de Meta Ads'
    });
  }
};

/**
 * Obtiene campañas con sus adsets y ads en estructura jerárquica
 */
export const getCampaigns = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren startDate y endDate'
      });
    }

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });

    if (!range.startZoned || !range.endZoned) {
      return res.status(400).json({
        success: false,
        error: 'Rango de fechas inválido'
      });
    }

    const adsStart = range.startZoned.toISODate();
    const adsEnd = range.endZoned.toISODate();

    logger.info(`Obteniendo campañas Meta - rango: ${adsStart} -> ${adsEnd}`);

    // Primero obtener interesados, ventas, citas y asistencias por ad_id
    // IMPORTANTE: La columna "citas" cuenta contactos con AL MENOS 1 cita (no el total de citas)
    // Se basa en la FECHA DE CREACIÓN DEL CONTACTO para medir atribución de marketing correctamente:
    // - Si un contacto se creó el 1-enero y agendó cita el 15-febrero, se atribuye al 1-enero
    // - Esto mide el impacto real de las campañas en generar citas (atribución correcta)
    // - Un contacto con 1000 citas cuenta como 1 solo contacto (métrica binaria: tiene o no tiene cita)

    // PASO 1: Obtener configuración de HighLevel y cargar TODOS los eventos (híbrido DB + API)
    const config = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1');
    const attributionCalendarIds = await getAttributionCalendarIds();
    // META-007: caché en memoria (TTL corto) del recálculo de atribución DB+API HL.
    // Mismo resultado (Sets de contact_id) que las llamadas directas; sólo evita repetir el
    // trabajo costoso dentro del TTL. No cambia el shape de la respuesta de getCampaigns.
    const { contactsWithAppointments, contactsWithAttendances } = await getAttributionSetsCached(
      config?.location_id,
      config?.api_token,
      attributionCalendarIds
    );

    logger.info(`📊 ${contactsWithAppointments.size} contactos con citas (híbrido DB + API - Campaigns)`);
    logger.info(`📊 ${contactsWithAttendances.size} contactos con asistencia (híbrido DB + API - Campaigns)`);

    // PASO 2: Obtener métricas básicas de contactos CON validación de match en meta_ads
    // IMPORTANTE: Solo contar contactos cuyo attribution_ad_id tenga registro en meta_ads en la misma fecha
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false);
    const contactMetaSameDay = metaSameLocalDayCondition('ma.date', 'c.created_at', range.appliedTimezone);

    const contactsQuery = `
      SELECT
        c.attribution_ad_id as ad_id,
        c.id as contact_id,
        c.email,
        c.phone,
        c.purchases_count,
        c.total_paid
      FROM contacts c
      WHERE c.attribution_ad_id IS NOT NULL
      AND c.created_at >= ?
      AND c.created_at <= ?
      AND EXISTS (
        SELECT 1 FROM meta_ads ma
        WHERE ma.ad_id = c.attribution_ad_id
          AND ${contactMetaSameDay}
      )
      ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
    `;

    const contactsRaw = await db.all(contactsQuery, [
      range.startUtc,
      range.endUtc
    ]);

    // PASO 3: Agrupar métricas por ad_id
    const metricsMap = {};
    contactsRaw.forEach(c => {
      if (!metricsMap[c.ad_id]) {
        metricsMap[c.ad_id] = createContactMetricAccumulator();
      }

      addContactToMetrics(metricsMap[c.ad_id], c, {
        sale: Number(c.purchases_count || 0) > 0,
        appointment: contactsWithAppointments.has(c.contact_id),
        attendance: contactsWithAttendances.has(c.contact_id)
      });
    });

    const financialsByContactId = new Map();
    const contactIdsForFinancials = [...new Set(contactsRaw.map(contact => contact.contact_id).filter(Boolean))];

    contactsRaw.forEach(contact => {
      financialsByContactId.set(contact.contact_id, {
        totalPaid: Number(contact.total_paid || 0),
        paymentTotal: 0
      });
    });

    if (contactIdsForFinancials.length > 0) {
      const paymentPlaceholders = contactIdsForFinancials.map(() => '?').join(',');
      const paymentRows = await db.all(`
        SELECT contact_id, amount, status, payment_mode
        FROM payments
        WHERE contact_id IN (${paymentPlaceholders})
      `, contactIdsForFinancials);

      paymentRows.forEach(payment => {
        const contactId = payment.contact_id;
        const financials = financialsByContactId.get(contactId) || { totalPaid: 0, paymentTotal: 0 };
        const status = String(payment.status || '').toLowerCase();
        const amount = Number(payment.amount || 0);
        const paymentMode = String(payment.payment_mode || 'live').toLowerCase();

        if (paymentMode === 'test') {
          financialsByContactId.set(contactId, financials);
          return;
        }

        if (SUCCESS_PAYMENT_STATUSES.has(status)) {
          financials.paymentTotal += amount;
        } else if (REFUND_PAYMENT_STATUSES.has(status)) {
          financials.paymentTotal -= amount;
        }

        financialsByContactId.set(contactId, financials);
      });
    }

    // Convertir a formato esperado
    const contactsData = Object.keys(metricsMap).map(ad_id => ({
      ad_id,
      ...materializeContactMetrics(metricsMap[ad_id], financialsByContactId)
    }));

    // Obtener todos los ad_ids que tienen contactos en el período
    const adIdsWithContacts = contactsData.map(row => row.ad_id).filter(Boolean);

    // Query para obtener datos agregados por campaña, adset y ad
    // SOLO incluir gasto del período (sin OR que incluya fechas fuera del rango)
    const aggregationQuery = `
      SELECT DISTINCT
        m.campaign_id, m.campaign_name,
        m.adset_id, m.adset_name,
        m.ad_id, m.ad_name,
        MAX(m.creative_id) as creative_id,
        MAX(m.creative_type) as creative_type,
        MAX(m.creative_thumbnail_url) as creative_thumbnail_url,
        MAX(m.creative_image_url) as creative_image_url,
        MAX(m.creative_video_id) as creative_video_id,
        MAX(m.creative_video_url) as creative_video_url,
        MAX(m.creative_preview_url) as creative_preview_url,
        COALESCE(SUM(m.spend), 0) as spend,
        COALESCE(SUM(m.reach), 0) as reach,
        COALESCE(SUM(m.clicks), 0) as clicks,
        AVG(m.cpc) as cpc,
        AVG(m.cpm) as cpm
      FROM meta_ads m
      WHERE m.date BETWEEN ? AND ?
      GROUP BY m.campaign_id, m.campaign_name, m.adset_id, m.adset_name, m.ad_id, m.ad_name
      ORDER BY m.campaign_id, m.adset_id, m.ad_id
    `;

    // Parámetros: solo el rango para el WHERE
    const aggregationParams = [
      adsStart, adsEnd
    ];

    const rows = await db.all(aggregationQuery, aggregationParams);
    await hydrateMissingCreativeMedia(rows);

    // Crear un mapa de ad_id -> métricas deduplicadas de contactos
    const contactsMap = {};
    contactsData.forEach(row => {
      contactsMap[row.ad_id] = {
        leads: parseInt(row.leads) || 0,
        sales: parseInt(row.sales) || 0,
        appointments: parseInt(row.appointments) || 0,
        attendances: parseInt(row.attendances) || 0,
        revenue: parseFloat(row.revenue) || 0
      };
    });

    // Agrupar por campañas -> adsets -> ads
    const campaigns = {};

    rows.forEach(row => {
      // Crear campaña si no existe
      if (!campaigns[row.campaign_id]) {
        campaigns[row.campaign_id] = {
          id: row.campaign_id,
          name: row.campaign_name,
          spend: 0,
          reach: 0,
          clicks: 0,
          cpc: 0,
          cpm: 0,
          impressions: 0,
          revenue: 0,
          roas: 0,
          sales: 0,
          leads: 0,
          appointments: 0,
          attendances: 0,
          visitors: 0,
          adsets: {},
          _contactMetrics: createContactMetricAccumulator()
        };
      }

      const campaign = campaigns[row.campaign_id];

      // Crear adset si no existe
      if (!campaign.adsets[row.adset_id]) {
        campaign.adsets[row.adset_id] = {
          id: row.adset_id,
          name: row.adset_name,
          spend: 0,
          reach: 0,
          clicks: 0,
          cpc: 0,
          cpm: 0,
          impressions: 0,
          revenue: 0,
          roas: 0,
          sales: 0,
          leads: 0,
          appointments: 0,
          attendances: 0,
          visitors: 0,
          ads: [],
          _contactMetrics: createContactMetricAccumulator()
        };
      }

      const adset = campaign.adsets[row.adset_id];

      // Obtener datos de contactos para este ad
      const adMetrics = metricsMap[row.ad_id] || createContactMetricAccumulator();
      const contactData = contactsMap[row.ad_id] || { leads: 0, sales: 0, appointments: 0, attendances: 0, revenue: 0 };

      // Agregar ad
      adset.ads.push({
        id: row.ad_id,
        name: row.ad_name,
        creativeId: row.creative_id || null,
        creativeType: row.creative_type || null,
        creativeThumbnailUrl: row.creative_thumbnail_url || null,
        creativeImageUrl: row.creative_image_url || null,
        creativeVideoId: row.creative_video_id || null,
        creativeVideoUrl: row.creative_video_url || null,
        creativePreviewUrl: row.creative_preview_url || null,
        spend: parseFloat(row.spend) || 0,
        reach: parseInt(row.reach) || 0,
        clicks: parseInt(row.clicks) || 0,
        cpc: parseFloat(row.cpc) || 0,
        cpm: parseFloat(row.cpm) || 0,
        impressions: 0,
        revenue: contactData.revenue,
        roas: parseFloat(row.spend) > 0 ? contactData.revenue / parseFloat(row.spend) : 0,
        sales: contactData.sales,
        leads: contactData.leads,
        appointments: contactData.appointments,
        attendances: contactData.attendances
      });

      // Sumar a adset
      adset.spend += parseFloat(row.spend) || 0;
      adset.reach += parseInt(row.reach) || 0;
      adset.clicks += parseInt(row.clicks) || 0;
      mergeContactMetrics(adset._contactMetrics, adMetrics);

      // Sumar a campaña
      campaign.spend += parseFloat(row.spend) || 0;
      campaign.reach += parseInt(row.reach) || 0;
      campaign.clicks += parseInt(row.clicks) || 0;
      mergeContactMetrics(campaign._contactMetrics, adMetrics);
    });

    // Convertir objetos a arrays y calcular promedios
    const campaignsArray = Object.values(campaigns).map(campaign => {
      const adsets = Object.values(campaign.adsets);

      const campaignContactData = materializeContactMetrics(campaign._contactMetrics, financialsByContactId);
      campaign.revenue = campaignContactData.revenue;
      campaign.sales = campaignContactData.sales;
      campaign.leads = campaignContactData.leads;
      campaign.appointments = campaignContactData.appointments;
      campaign.attendances = campaignContactData.attendances;

      // Calcular CPC/CPM promedio para la campaña
      if (adsets.length > 0) {
        const totalAds = adsets.reduce((sum, adset) => sum + adset.ads.length, 0);
        if (totalAds > 0) {
          campaign.cpc = adsets.reduce((sum, adset) =>
            sum + adset.ads.reduce((s, ad) => s + (ad.cpc || 0), 0), 0) / totalAds;
          campaign.cpm = adsets.reduce((sum, adset) =>
            sum + adset.ads.reduce((s, ad) => s + (ad.cpm || 0), 0), 0) / totalAds;
        }
      }

      // Calcular ROAS para la campaña
      campaign.roas = campaign.spend > 0 ? campaign.revenue / campaign.spend : 0;

      // Calcular CPC/CPM/ROAS promedio para cada adset
      adsets.forEach(adset => {
        const adsetContactData = materializeContactMetrics(adset._contactMetrics, financialsByContactId);
        adset.revenue = adsetContactData.revenue;
        adset.sales = adsetContactData.sales;
        adset.leads = adsetContactData.leads;
        adset.appointments = adsetContactData.appointments;
        adset.attendances = adsetContactData.attendances;

        if (adset.ads.length > 0) {
          adset.cpc = adset.ads.reduce((sum, ad) => sum + (ad.cpc || 0), 0) / adset.ads.length;
          adset.cpm = adset.ads.reduce((sum, ad) => sum + (ad.cpm || 0), 0) / adset.ads.length;
        }
        // Calcular ROAS para el adset
        adset.roas = adset.spend > 0 ? adset.revenue / adset.spend : 0;
        delete adset._contactMetrics;
      });
      delete campaign._contactMetrics;

      return {
        ...campaign,
        adsets
      };
    });

    res.json({
      success: true,
      data: campaignsArray
    });

  } catch (error) {
    logger.error(`Error en getCampaigns: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener campañas'
    });
  }
};

/**
 * Obtiene gastos agrupados por período (para gráficas)
 */
export const getSpendOverTime = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren startDate y endDate'
      });
    }

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });

    if (!range.startZoned || !range.endZoned) {
      return res.status(400).json({
        success: false,
        error: 'Rango de fechas inválido'
      });
    }

    const start = range.startZoned.toISODate();
    const end = range.endZoned.toISODate();

    logger.info(`Obteniendo gastos e ingresos desde ${start} hasta ${end}`);

    // Query de gastos (compatible con PostgreSQL y SQLite)
    const spendQuery = `
      SELECT
        ${metaDayExpression('date')} as day,
        SUM(spend) as spend
      FROM meta_ads
      WHERE ${dateWindowCondition(metaDateExpression('date'))}
      GROUP BY day
      ORDER BY day ASC
    `;
    const spendParams = [start, end];

    // Query de ingresos ATRIBUIDOS basado en fecha de CREACIÓN del contacto y su LTV total
    // Usamos la fecha cuando el contacto llegó (created_at) y sumamos su valor total acumulado (total_paid)
    // VALIDACIÓN: Solo cuenta si el anuncio EXISTIÓ en Meta ese mismo día
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false);
    const contactCreatedDate = timestampDateExpression('c.created_at', range.appliedTimezone);
    const contactCreatedDay = timestampDayExpression('c.created_at', range.appliedTimezone);
    const contactMetaSameDay = metaSameLocalDayCondition('ma.date', 'c.created_at', range.appliedTimezone);

    const revenueQuery = `
      SELECT
        ${contactCreatedDay} as day,
        SUM(c.total_paid) as revenue
      FROM contacts c
      WHERE c.attribution_ad_id IS NOT NULL
        AND c.attribution_ad_id != ''
        AND ${dateWindowCondition(contactCreatedDate)}
        AND EXISTS (
          SELECT 1 FROM meta_ads ma
          WHERE ma.ad_id = c.attribution_ad_id
            AND ${contactMetaSameDay}
        )
        ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
      GROUP BY day
      ORDER BY day ASC
    `;
    const revenueParams = [start, end];

    const [spendData, revenueData] = await Promise.all([
      db.all(spendQuery, spendParams),
      db.all(revenueQuery, revenueParams)
    ]);

    logger.info(`Gastos encontrados: ${spendData.length} días con datos`);
    logger.info(`Contactos atribuidos con LTV encontrados: ${revenueData.length} días con nuevos contactos que han generado ingresos`);

    // Si no hay datos de ningún tipo, retornar vacío
    if (spendData.length === 0 && revenueData.length === 0) {
      logger.info('No hay datos de publicidad ni ingresos atribuidos para el período solicitado');
      return res.json({
        success: true,
        data: []
      });
    }

    // Crear un mapa de ingresos por fecha
    const revenueMap = new Map();
    revenueData.forEach(row => {
      revenueMap.set(row.day, parseFloat(row.revenue || 0));
    });

    // Crear un mapa de gastos por fecha
    const spendMap = new Map();
    spendData.forEach(row => {
      spendMap.set(row.day, parseFloat(row.spend || 0));
    });

    // Combinar todas las fechas únicas
    const allDates = new Set([...revenueMap.keys(), ...spendMap.keys()]);
    const sortedDates = Array.from(allDates).sort();

    // Mapear al formato esperado por frontend: { label, value, value2 }
    const mappedData = sortedDates.map(date => ({
      label: date,
      value: revenueMap.get(date) || 0, // Ingresos
      value2: spendMap.get(date) || 0     // Gastos
    }));

    res.json({
      success: true,
      data: mappedData
    });

  } catch (error) {
    logger.error(`Error en getSpendOverTime: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener gastos por período'
    });
  }
};

/**
 * Obtiene el estado actual de sincronización de Meta
 */
export const getSyncStatus = async (req, res) => {
  try {
    const progress = getMetaSyncProgress();

    // Mapear el status interno al formato esperado por el frontend
    let status = 'idle';
    if (progress.status === 'syncing') {
      status = 'syncing';
    } else if (progress.status === 'completed') {
      status = 'completed';
    } else if (progress.status === 'error') {
      status = 'error';
    }

    // Calcular el porcentaje de progreso
    let progressPercent = 0;
    if (progress.monthsTotal > 0) {
      progressPercent = Math.round((progress.monthsCurrent / progress.monthsTotal) * 100);
    }

    res.json({
      success: true,
      status,
      progress: progressPercent,
      details: {
        step: progress.step,
        message: progress.message,
        monthsCurrent: progress.monthsCurrent,
        monthsTotal: progress.monthsTotal
      }
    });

  } catch (error) {
    logger.error(`Error en getSyncStatus: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener el estado de sincronización'
    });
  }
};

/**
 * Obtiene contactos por tipo (interesados o ventas) filtrados por campaign/adset/ad
 */
export const getContactsByType = async (req, res) => {
  try {
    const { type, startDate, endDate, campaign_id, adset_id, ad_id } = req.query;

    if (!type || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren type, startDate y endDate'
      });
    }

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });

    if (!range.startZoned || !range.endZoned) {
      return res.status(400).json({
        success: false,
        error: 'Rango de fechas inválido'
      });
    }

    const adsStart = range.startZoned.toISODate();
    const adsEnd = range.endZoned.toISODate();

    let adIdsList = [];

    // Obtener los ad_ids relevantes basándose en el filtro
    // IMPORTANTE: Filtrar por rango de fechas para que coincida con los números de la tabla
    if (ad_id) {
      // Si se especifica un ad_id directamente, usarlo
      adIdsList = [ad_id];
    } else if (adset_id) {
      // Obtener ads del adset que tienen actividad en el rango de fechas
      const adIdsQuery = `
        SELECT DISTINCT ad_id
        FROM meta_ads
        WHERE adset_id = ?
        AND date >= ?
        AND date <= ?
      `;
      const adIds = await db.all(adIdsQuery, [adset_id, adsStart, adsEnd]);
      adIdsList = adIds.map(row => row.ad_id);
    } else if (campaign_id) {
      // Obtener ads de la campaña que tienen actividad en el rango de fechas
      const adIdsQuery = `
        SELECT DISTINCT ad_id
        FROM meta_ads
        WHERE campaign_id = ?
        AND date >= ?
        AND date <= ?
      `;
      const adIds = await db.all(adIdsQuery, [campaign_id, adsStart, adsEnd]);
      adIdsList = adIds.map(row => row.ad_id);
    } else {
      return res.status(400).json({
        success: false,
        error: 'Se requiere al menos campaign_id, adset_id o ad_id'
      });
    }

    if (adIdsList.length === 0) {
      return res.json({
        success: true,
        data: []
      });
    }

    // Construir query de contactos (sin JOIN de appointments, ahora usamos método optimizado)
    // IMPORTANTE: Validar que attribution_ad_id exista en meta_ads con fecha coincidente
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false);
    const contactMetaSameDay = metaSameLocalDayCondition('ma.date', 'c.created_at', range.appliedTimezone);
    const contactMetaSameDayForExists = metaSameLocalDayCondition('ma2.date', 'c.created_at', range.appliedTimezone);

    const placeholders = adIdsList.map(() => '?').join(',');
    let contactsQuery = `
      SELECT
        c.id,
        c.full_name,
        c.email,
        c.phone,
        c.attribution_ad_id,
        c.attribution_ad_name,
        c.total_paid,
        c.purchases_count,
        c.custom_fields,
        c.created_at,
        MAX(ma.campaign_name) as campaign_name,
        MAX(ma.adset_name) as adset_name,
        MAX(ma.ad_name) as ad_name
      FROM contacts c
      LEFT JOIN meta_ads ma ON ma.ad_id = c.attribution_ad_id AND ${contactMetaSameDay}
      WHERE c.attribution_ad_id IN (${placeholders})
      AND c.created_at >= ?
      AND c.created_at <= ?
      AND EXISTS (
        SELECT 1 FROM meta_ads ma2
        WHERE ma2.ad_id = c.attribution_ad_id
          AND ${contactMetaSameDayForExists}
      )
      ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
    `;

    if (type === 'sales') {
      contactsQuery += ' AND purchases_count > 0';
    }

    contactsQuery += `
      GROUP BY c.id,
               c.full_name,
               c.email,
               c.phone,
               c.attribution_ad_id,
               c.attribution_ad_name,
               c.total_paid,
               c.purchases_count,
               c.custom_fields,
               c.created_at
      ORDER BY ${timestampSortExpression('c.created_at')} DESC, c.id DESC
    `;

    const contactsParams = [...adIdsList, range.startUtc, range.endUtc];
    let contacts = await db.all(contactsQuery, contactsParams);

    // Si type === 'appointments' o 'attendances', filtrar usando híbrido DB + API
    if (type === 'appointments' || type === 'attendances') {
      const config = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1');
      const attributionCalendarIds = await getAttributionCalendarIds();
      const contactIdsWithMetric = type === 'attendances'
        ? await getContactsWithShowedAppointmentsHybrid(config?.location_id, config?.api_token, attributionCalendarIds)
        : await getContactsWithAppointmentsHybrid(config?.location_id, config?.api_token, attributionCalendarIds);

      logger.info(`📊 Filtrando ${contacts.length} contactos por ${type} (${contactIdsWithMetric.size} encontrados - híbrido DB + API)`);

      contacts = contacts.filter(c => contactIdsWithMetric.has(c.id));
    }

    // (MET-CONSIST) Colapsar por PERSONA (email>teléfono>id) para igualar el número de la
    // celda, que cuenta por buildContactKey (getCampaigns). Sin esto, dos registros de la
    // misma persona (mismo email/teléfono) salían como 2 filas mientras la celda mostraba 1.
    // El ORDER BY (created_at DESC, id DESC) del query ya define el representante más reciente.
    const seenContactKeys = new Set();
    contacts = contacts.filter(contact => {
      const key = buildContactKey({ email: contact.email, phone: contact.phone, contact_id: contact.id })
        ?? `id::${contact.id}`;
      if (seenContactKeys.has(key)) return false;
      seenContactKeys.add(key);
      return true;
    });

    const contactIds = contacts.map(contact => contact.id).filter(Boolean);

    let paymentsMap = new Map();
    let appointmentsMap = new Map();
    let firstSessionMap = new Map();
    let contactsWithAttendances = new Set();

    if (contactIds.length > 0) {
      const placeholders = contactIds.map(() => '?').join(',');
      const attendanceConfig = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1');
      const attributionCalendarIds = await getAttributionCalendarIds();
      contactsWithAttendances = await getContactsWithShowedAppointmentsHybrid(
        attendanceConfig?.location_id,
        attendanceConfig?.api_token,
        attributionCalendarIds
      );

      // IMPORTANTE: NO filtrar pagos por rango de fechas
      // El modal debe mostrar TODOS los pagos del cliente, independientemente del rango seleccionado
      // El filtro de fechas solo aplica para determinar QUÉ contactos mostrar, no sus pagos completos
      const paymentsQuery = `
        SELECT
          id,
          contact_id,
          amount,
          status,
          payment_mode,
          date
        FROM payments
        WHERE contact_id IN (${placeholders})
        ORDER BY ${timestampSortExpression('date')} DESC, ${timestampSortExpression('created_at')} DESC, id DESC
      `;

      const paymentRows = await db.all(paymentsQuery, contactIds);

      paymentsMap = paymentRows.reduce((map, payment) => {
        const list = map.get(payment.contact_id) || [];
        list.push({
          id: payment.id,
          amount: Number(payment.amount || 0),
          status: payment.status,
          payment_mode: payment.payment_mode || 'live',
          date: payment.date
        });
        map.set(payment.contact_id, list);
        return map;
      }, new Map());

      // Obtener TODAS las citas de estos contactos (sin filtrar por rango de fechas)
      const appointmentsQuery = `
        SELECT
          id,
          contact_id,
          title,
          start_time,
          end_time,
          status,
          appointment_status
        FROM appointments
        WHERE contact_id IN (${placeholders})
        ORDER BY ${timestampSortExpression('start_time')} DESC, id DESC
      `;

      const appointmentRows = await db.all(appointmentsQuery, contactIds);

      appointmentsMap = appointmentRows.reduce((map, appointment) => {
        const list = map.get(appointment.contact_id) || [];
        list.push({
          id: appointment.id,
          title: appointment.title,
          start_time: appointment.start_time,
          end_time: appointment.end_time,
          status: appointment.appointment_status || appointment.status
        });
        map.set(appointment.contact_id, list);
        return map;
      }, new Map());

      // Obtener primera sesión (primera atribución) de cada contacto
      const firstSessionsQuery = `
        SELECT
          s1.contact_id,
          s1.started_at,
          s1.page_url,
          s1.referrer_url,
          s1.utm_source,
          s1.utm_medium,
          s1.utm_campaign,
          s1.utm_content,
          s1.utm_term,
          s1.source_platform,
          s1.site_source_name,
          s1.campaign_name,
          s1.ad_name,
          s1.ad_id,
          s1.device_type,
          s1.browser,
          s1.geo_city,
          s1.geo_region,
          s1.geo_country
        FROM sessions s1
        INNER JOIN (
          SELECT contact_id, MIN(started_at) as first_started_at
          FROM sessions
          WHERE contact_id IN (${placeholders})
          GROUP BY contact_id
        ) s2 ON s1.contact_id = s2.contact_id AND s1.started_at = s2.first_started_at
      `;

      const firstSessionRows = await db.all(firstSessionsQuery, contactIds);

      firstSessionMap = firstSessionRows.reduce((map, session) => {
        map.set(session.contact_id, {
          started_at: session.started_at,
          page_url: session.page_url,
          referrer_url: session.referrer_url,
          utm_source: session.utm_source,
          utm_medium: session.utm_medium,
          utm_campaign: session.utm_campaign,
          utm_content: session.utm_content,
          utm_term: session.utm_term,
          source_platform: session.source_platform,
          site_source_name: session.site_source_name,
          campaign_name: session.campaign_name,
          ad_name: session.ad_name,
          ad_id: session.ad_id,
          device_type: session.device_type,
          browser: session.browser,
          geo_city: session.geo_city,
          geo_region: session.geo_region,
          geo_country: session.geo_country
        });
        return map;
      }, new Map());
    }

    const mappedContacts = contacts.map(contact => {
      const payments = paymentsMap.get(contact.id) || [];
      const appointments = appointmentsMap.get(contact.id) || [];
      const firstSession = firstSessionMap.get(contact.id) || null;
      // CRÍTICO: Solo sumar pagos exitosos, NO incluir refunded/cancelled
      const validStatuses = ['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success'];
      const totalFromPayments = payments
        .filter(payment => validStatuses.includes(payment.status?.toLowerCase()) && payment.payment_mode !== 'test')
        .reduce((sum, payment) => sum + payment.amount, 0);
      const totalPaid = contact.total_paid ? Number(contact.total_paid) : totalFromPayments;

      return {
        id: contact.id,
        name: contact.full_name || '',
        email: contact.email || '',
        phone: contact.phone || '',
        created_at: contact.created_at,
        ltv: totalPaid,
        ad_id: contact.attribution_ad_id,
        ad_name: contact.ad_name || contact.attribution_ad_name,
        campaign_name: contact.campaign_name,
        adset_name: contact.adset_name,
        is_sale: contact.purchases_count > 0,
        hasShowedAppointment: contactsWithAttendances.has(contact.id),
        hasAttendedAppointment: contactsWithAttendances.has(contact.id),
        payments: payments,
        appointments: appointments,
        firstSession: firstSession,
        customFields: parseContactCustomFields(contact.custom_fields)
      };
    });

    res.json({
      success: true,
      data: mappedContacts
    });

  } catch (error) {
    logger.error(`Error en getContactsByType: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener contactos'
    });
  }
};

/**
 * Verifica el estado del token de Meta (validez, expiración, scopes)
 */
export const verifyToken = async (req, res) => {
  try {
    const config = await getMetaConfig();

    if (!config || !config.access_token) {
      return res.json({
        success: true,
        configured: false,
        tokenStatus: {
          valid: false,
          message: 'No hay token configurado'
        }
      });
    }

    logger.info('Verificando validez del token de Meta...');

    const validation = await verifyMetaToken(config.access_token, config.oauth_appsecret_proof || '');

    let message = '';
    let daysUntilExpiry = null;

    if (!validation.valid) {
      message = validation.error || 'Token inválido o expirado';
    } else if (validation.expiresAt) {
      daysUntilExpiry = Math.ceil((validation.expiresAt - new Date()) / (1000 * 60 * 60 * 24));

      if (daysUntilExpiry <= 0) {
        message = 'Token expirado';
      } else if (daysUntilExpiry <= 7) {
        message = `Token válido pero expira en ${daysUntilExpiry} días. Considera renovarlo.`;
      } else {
        message = `Token válido (expira en ${daysUntilExpiry} días)`;
      }
    } else {
      message = 'Token válido (sin fecha de expiración)';
    }

    res.json({
      success: true,
      configured: true,
      tokenStatus: {
        valid: validation.valid,
        message,
        expiresAt: validation.expiresAt,
        daysUntilExpiry,
        scopes: validation.scopes || []
      }
    });

  } catch (error) {
    logger.error(`Error en verifyToken: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al verificar el token de Meta'
    });
  }
};

/**
 * Obtiene leads vs citas agrupados por fecha de creación
 */
export const getLeadsOverTime = async (req, res) => {
  try {
    const { start, end, viewType = 'day' } = req.query;

    // Parse dates properly, removing time if present
    const startDate = start ? start.split(' ')[0].split('+')[0] : null;
    const endDate = end ? end.split(' ')[0].split('+')[0] : null;

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });
    const startUtc = range.startZoned.toISODate();
    const endUtc = range.endZoned.toISODate();

    // Aplicar filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false);
    const hiddenConditionC = buildHiddenContactsCondition(hiddenFilters, 'c', false);
    const dedupExprContacts = buildDedupExpression('contacts');
    const dedupExprC = buildDedupExpression('c');
    const contactsCreatedDate = timestampDateExpression('contacts.created_at', range.appliedTimezone);
    const contactsCreatedDay = timestampDayExpression('contacts.created_at', range.appliedTimezone);
    const cCreatedDate = timestampDateExpression('c.created_at', range.appliedTimezone);
    const cCreatedDay = timestampDayExpression('c.created_at', range.appliedTimezone);

    // Query para obtener leads (contactos únicos) por fecha de creación
    const leadsQuery = `SELECT
        ${contactsCreatedDay} as day,
        COUNT(DISTINCT ${dedupExprContacts}) as leads
       FROM contacts
       WHERE attribution_ad_id IS NOT NULL
         AND attribution_ad_id != ''
         AND ${dateWindowCondition(contactsCreatedDate)}
         ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
       GROUP BY day
       ORDER BY day`;

    // Query para obtener contactos únicos con citas por fecha de creación
    // Filtrar por calendarios de atribución configurados
    const attributionCalendarIds = await getAttributionCalendarIds();
    let appointmentsQuery;
    let appointmentsParams = [startUtc, endUtc];

    if (attributionCalendarIds && attributionCalendarIds.length > 0) {
      const calendarPlaceholders = attributionCalendarIds.map(() => '?').join(',');
      appointmentsQuery = `SELECT
          ${cCreatedDay} as day,
          COUNT(DISTINCT ${dedupExprC}) as appointments
         FROM contacts c
         INNER JOIN appointments a ON c.id = a.contact_id
         WHERE c.attribution_ad_id IS NOT NULL
           AND c.attribution_ad_id != ''
           AND ${dateWindowCondition(cCreatedDate)}
           AND a.calendar_id IN (${calendarPlaceholders})
           ${hiddenConditionC ? `AND ${hiddenConditionC}` : ''}
         GROUP BY day
         ORDER BY day`;
      appointmentsParams = [...appointmentsParams, ...attributionCalendarIds];
    } else {
      // Sin filtro de calendario
      appointmentsQuery = `SELECT
          ${cCreatedDay} as day,
          COUNT(DISTINCT ${dedupExprC}) as appointments
         FROM contacts c
         INNER JOIN appointments a ON c.id = a.contact_id
         WHERE c.attribution_ad_id IS NOT NULL
           AND c.attribution_ad_id != ''
           AND ${dateWindowCondition(cCreatedDate)}
           ${hiddenConditionC ? `AND ${hiddenConditionC}` : ''}
         GROUP BY day
         ORDER BY day`;
    }

    const params = [startUtc, endUtc];
    const [leadsData, appointmentsData] = await Promise.all([
      db.all(leadsQuery, params),
      db.all(appointmentsQuery, appointmentsParams)
    ]);

    // Crear mapas para combinar los datos
    const leadsMap = new Map();
    leadsData.forEach(row => {
      leadsMap.set(row.day, parseInt(row.leads || 0));
    });

    const appointmentsMap = new Map();
    appointmentsData.forEach(row => {
      appointmentsMap.set(row.day, parseInt(row.appointments || 0));
    });

    // Combinar todas las fechas únicas
    const allDates = new Set([...leadsMap.keys(), ...appointmentsMap.keys()]);
    const sortedDates = Array.from(allDates).sort();

    // Mapear al formato esperado por frontend
    const mappedData = sortedDates.map(date => ({
      label: date,
      value: leadsMap.get(date) || 0,       // Leads
      value2: appointmentsMap.get(date) || 0 // Citas
    }));

    res.json({
      success: true,
      data: mappedData
    });

  } catch (error) {
    logger.error(`Error en getLeadsOverTime: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener leads vs citas por período'
    });
  }
};

/**
 * Obtiene citas vs ventas agrupadas por fecha de creación
 */
export const getAppointmentsOverTime = async (req, res) => {
  try {
    const { start, end, viewType = 'day' } = req.query;

    // Parse dates properly, removing time if present
    const startDate = start ? start.split(' ')[0].split('+')[0] : null;
    const endDate = end ? end.split(' ')[0].split('+')[0] : null;

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });
    const startUtc = range.startZoned.toISODate();
    const endUtc = range.endZoned.toISODate();

    // Aplicar filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenConditionC = buildHiddenContactsCondition(hiddenFilters, 'c', false);
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false);
    const dedupExprC = buildDedupExpression('c');
    const dedupExprContacts = buildDedupExpression('contacts');
    const cCreatedDate = timestampDateExpression('c.created_at', range.appliedTimezone);
    const cCreatedDay = timestampDayExpression('c.created_at', range.appliedTimezone);
    const contactsCreatedDate = timestampDateExpression('contacts.created_at', range.appliedTimezone);
    const contactsCreatedDay = timestampDayExpression('contacts.created_at', range.appliedTimezone);

    // Query para obtener contactos únicos con citas por fecha de creación
    // Filtrar por calendarios de atribución configurados
    const attributionCalendarIds = await getAttributionCalendarIds();
    let appointmentsQuery;
    let appointmentsParams = [startUtc, endUtc];

    if (attributionCalendarIds && attributionCalendarIds.length > 0) {
      const calendarPlaceholders = attributionCalendarIds.map(() => '?').join(',');
      appointmentsQuery = `SELECT
          ${cCreatedDay} as day,
          COUNT(DISTINCT ${dedupExprC}) as appointments
         FROM contacts c
         INNER JOIN appointments a ON c.id = a.contact_id
         WHERE c.attribution_ad_id IS NOT NULL
           AND c.attribution_ad_id != ''
           AND ${dateWindowCondition(cCreatedDate)}
           AND a.calendar_id IN (${calendarPlaceholders})
           ${hiddenConditionC ? `AND ${hiddenConditionC}` : ''}
         GROUP BY day
         ORDER BY day`;
      appointmentsParams = [...appointmentsParams, ...attributionCalendarIds];
    } else {
      // Sin filtro de calendario
      appointmentsQuery = `SELECT
          ${cCreatedDay} as day,
          COUNT(DISTINCT ${dedupExprC}) as appointments
         FROM contacts c
         INNER JOIN appointments a ON c.id = a.contact_id
         WHERE c.attribution_ad_id IS NOT NULL
           AND c.attribution_ad_id != ''
           AND ${dateWindowCondition(cCreatedDate)}
           ${hiddenConditionC ? `AND ${hiddenConditionC}` : ''}
         GROUP BY day
         ORDER BY day`;
    }

    // Query para obtener ventas (contactos con purchases_count > 0) por fecha de creación
    const salesQuery = `SELECT
        ${contactsCreatedDay} as day,
        COUNT(DISTINCT ${dedupExprContacts}) as sales
       FROM contacts
       WHERE attribution_ad_id IS NOT NULL
         AND attribution_ad_id != ''
         AND purchases_count > 0
         AND ${dateWindowCondition(contactsCreatedDate)}
         ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
       GROUP BY day
       ORDER BY day`;

    const params = [startUtc, endUtc];
    const [appointmentsData, salesData] = await Promise.all([
      db.all(appointmentsQuery, appointmentsParams),
      db.all(salesQuery, params)
    ]);

    // Crear mapas para combinar los datos
    const appointmentsMap = new Map();
    appointmentsData.forEach(row => {
      appointmentsMap.set(row.day, parseInt(row.appointments || 0));
    });

    const salesMap = new Map();
    salesData.forEach(row => {
      salesMap.set(row.day, parseInt(row.sales || 0));
    });

    // Combinar todas las fechas únicas
    const allDates = new Set([...appointmentsMap.keys(), ...salesMap.keys()]);
    const sortedDates = Array.from(allDates).sort();

    // Mapear al formato esperado por frontend
    const mappedData = sortedDates.map(date => ({
      label: date,
      value: appointmentsMap.get(date) || 0,  // Citas
      value2: salesMap.get(date) || 0         // Ventas
    }));

    res.json({
      success: true,
      data: mappedData
    });

  } catch (error) {
    logger.error(`Error en getAppointmentsOverTime: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener citas vs ventas por período'
    });
  }
};

/**
 * Obtiene visitantes vs leads agrupados por fecha
 */
export const getVisitorsOverTime = async (req, res) => {
  try {
    const { start, end, viewType = 'day' } = req.query;

    // Parse dates properly, removing time if present
    const startDate = start ? start.split(' ')[0].split('+')[0] : null;
    const endDate = end ? end.split(' ')[0].split('+')[0] : null;

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });
    const startUtc = range.startZoned.toISODate();
    const endUtc = range.endZoned.toISODate();

    // Aplicar filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false);
    const dedupExprContacts = buildDedupExpression('contacts');
    const startedDate = timestampDateExpression('started_at', range.appliedTimezone);
    const startedDay = timestampDayExpression('started_at', range.appliedTimezone);
    const contactsCreatedDate = timestampDateExpression('contacts.created_at', range.appliedTimezone);
    const contactsCreatedDay = timestampDayExpression('contacts.created_at', range.appliedTimezone);

    // Query para obtener visitantes únicos por fecha desde sessions
    const visitorsQuery = `SELECT
        ${startedDay} as day,
        COUNT(DISTINCT ${getVisitorIdentityExpression()}) as visitors
       FROM sessions
       WHERE ad_id IS NOT NULL
         AND ad_id != ''
         AND ${dateWindowCondition(startedDate)}
       GROUP BY day
       ORDER BY day`;

    // Query para obtener leads (contactos únicos) por fecha de creación
    const leadsQuery = `SELECT
        ${contactsCreatedDay} as day,
        COUNT(DISTINCT ${dedupExprContacts}) as leads
       FROM contacts
       WHERE attribution_ad_id IS NOT NULL
         AND attribution_ad_id != ''
         AND ${dateWindowCondition(contactsCreatedDate)}
         ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
       GROUP BY day
       ORDER BY day`;

    const params = [startUtc, endUtc];
    const [visitorsData, leadsData] = await Promise.all([
      db.all(visitorsQuery, params),
      db.all(leadsQuery, params)
    ]);

    // Crear mapas para combinar los datos
    const visitorsMap = new Map();
    visitorsData.forEach(row => {
      visitorsMap.set(row.day, parseInt(row.visitors || 0));
    });

    const leadsMap = new Map();
    leadsData.forEach(row => {
      leadsMap.set(row.day, parseInt(row.leads || 0));
    });

    // Combinar todas las fechas únicas
    const allDates = new Set([...visitorsMap.keys(), ...leadsMap.keys()]);
    const sortedDates = Array.from(allDates).sort();

    // Mapear al formato esperado por frontend
    const mappedData = sortedDates.map(date => ({
      label: date,
      value: visitorsMap.get(date) || 0,   // Visitantes
      value2: leadsMap.get(date) || 0      // Leads
    }));

    res.json({
      success: true,
      data: mappedData
    });

  } catch (error) {
    logger.error(`Error en getVisitorsOverTime: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener visitantes vs leads por período'
    });
  }
};

/**
 * Obtiene todas las métricas del funnel agrupadas por fecha
 */
export const getFunnelMetrics = async (req, res) => {
  try {
    const { start, end, viewType = 'day' } = req.query;

    // Parse dates properly, removing time if present
    const startDate = start ? start.split(' ')[0].split('+')[0] : null;
    const endDate = end ? end.split(' ')[0].split('+')[0] : null;

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate });
    const startUtc = range.startZoned.toISODate();
    const endUtc = range.endZoned.toISODate();

    // Aplicar filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters();
    const hiddenConditionC = buildHiddenContactsCondition(hiddenFilters, 'c', false);
    const dedupExprC = buildDedupExpression('c');
    const startedDate = timestampDateExpression('started_at', range.appliedTimezone);
    const startedDay = timestampDayExpression('started_at', range.appliedTimezone);
    const cCreatedDate = timestampDateExpression('c.created_at', range.appliedTimezone);
    const cCreatedDay = timestampDayExpression('c.created_at', range.appliedTimezone);
    const cMetaSameDay = metaSameLocalDayCondition('ma.date', 'c.created_at', range.appliedTimezone);

    // Query para visitantes únicos CON ad_id (columna correcta en sessions)
    const visitorsQuery = `SELECT
        ${startedDay} as day,
        COUNT(DISTINCT ${getVisitorIdentityExpression()}) as visitors
       FROM sessions
       WHERE ad_id IS NOT NULL
         AND ad_id != ''
         AND ${dateWindowCondition(startedDate)}
       GROUP BY day`;

    // Query para leads CON attribution_ad_id validando que el anuncio existiera ese día en Meta
    const leadsQuery = `SELECT
        ${cCreatedDay} as day,
        COUNT(DISTINCT ${dedupExprC}) as leads
       FROM contacts c
       WHERE c.attribution_ad_id IS NOT NULL
         AND c.attribution_ad_id != ''
         AND ${dateWindowCondition(cCreatedDate)}
         AND EXISTS (
           SELECT 1 FROM meta_ads ma
           WHERE ma.ad_id = c.attribution_ad_id
             AND ${cMetaSameDay}
         )
         ${hiddenConditionC ? `AND ${hiddenConditionC}` : ''}
       GROUP BY day`;

    // Query para contactos con citas CON attribution_ad_id validando que el anuncio existiera ese día
    // Filtrar por calendarios de atribución configurados
    const attributionCalendarIds = await getAttributionCalendarIds();
    let appointmentsQuery;
    let appointmentsParams = [startUtc, endUtc];

    if (attributionCalendarIds && attributionCalendarIds.length > 0) {
      const calendarPlaceholders = attributionCalendarIds.map(() => '?').join(',');
      appointmentsQuery = `SELECT
          ${cCreatedDay} as day,
          COUNT(DISTINCT ${dedupExprC}) as appointments
         FROM contacts c
         INNER JOIN appointments a ON c.id = a.contact_id
         WHERE c.attribution_ad_id IS NOT NULL
           AND c.attribution_ad_id != ''
           AND ${dateWindowCondition(cCreatedDate)}
           AND a.calendar_id IN (${calendarPlaceholders})
           AND EXISTS (
             SELECT 1 FROM meta_ads ma
             WHERE ma.ad_id = c.attribution_ad_id
               AND ${cMetaSameDay}
           )
           ${hiddenConditionC ? `AND ${hiddenConditionC}` : ''}
         GROUP BY day`;
      appointmentsParams = [...appointmentsParams, ...attributionCalendarIds];
    } else {
      // Sin filtro de calendario
      appointmentsQuery = `SELECT
          ${cCreatedDay} as day,
          COUNT(DISTINCT ${dedupExprC}) as appointments
         FROM contacts c
         INNER JOIN appointments a ON c.id = a.contact_id
         WHERE c.attribution_ad_id IS NOT NULL
           AND c.attribution_ad_id != ''
           AND ${dateWindowCondition(cCreatedDate)}
           AND EXISTS (
             SELECT 1 FROM meta_ads ma
             WHERE ma.ad_id = c.attribution_ad_id
               AND ${cMetaSameDay}
           )
           ${hiddenConditionC ? `AND ${hiddenConditionC}` : ''}
         GROUP BY day`;
    }

    // Query para ventas CON attribution_ad_id validando que el anuncio existiera ese día
    const salesQuery = `SELECT
        ${cCreatedDay} as day,
        COUNT(DISTINCT ${dedupExprC}) as sales
       FROM contacts c
       WHERE c.attribution_ad_id IS NOT NULL
         AND c.attribution_ad_id != ''
         AND c.purchases_count > 0
         AND ${dateWindowCondition(cCreatedDate)}
         AND EXISTS (
           SELECT 1 FROM meta_ads ma
           WHERE ma.ad_id = c.attribution_ad_id
             AND ${cMetaSameDay}
         )
         ${hiddenConditionC ? `AND ${hiddenConditionC}` : ''}
       GROUP BY day`;

    const params = [startUtc, endUtc];
    const [visitorsData, leadsData, appointmentsData, salesData] = await Promise.all([
      db.all(visitorsQuery, params),
      db.all(leadsQuery, params),
      db.all(appointmentsQuery, appointmentsParams),
      db.all(salesQuery, params)
    ]);

    // Crear mapas para cada métrica
    const visitorsMap = new Map();
    visitorsData.forEach(row => {
      visitorsMap.set(row.day, parseInt(row.visitors || 0));
    });

    const leadsMap = new Map();
    leadsData.forEach(row => {
      leadsMap.set(row.day, parseInt(row.leads || 0));
    });

    const appointmentsMap = new Map();
    appointmentsData.forEach(row => {
      appointmentsMap.set(row.day, parseInt(row.appointments || 0));
    });

    const salesMap = new Map();
    salesData.forEach(row => {
      salesMap.set(row.day, parseInt(row.sales || 0));
    });

    // Generar TODAS las fechas del rango (incluso las que no tienen datos)
    const allDates = [];
    let currentDate = new Date(startUtc);
    const endDateObj = new Date(endUtc);
    currentDate.setUTCHours(0, 0, 0, 0);
    endDateObj.setUTCHours(0, 0, 0, 0);

    while (currentDate <= endDateObj) {
      const dateStr = formatDate(currentDate);
      allDates.push(dateStr);
      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    // Mapear al formato esperado con todas las métricas
    const mappedData = allDates.map(date => ({
      label: date,
      visitors: visitorsMap.get(date) || 0,
      leads: leadsMap.get(date) || 0,
      appointments: appointmentsMap.get(date) || 0,
      sales: salesMap.get(date) || 0
    }));

    res.json({
      success: true,
      data: mappedData
    });

  } catch (error) {
    logger.error(`Error en getFunnelMetrics: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener métricas del funnel'
    });
  }
};

/**
 * Obtiene los Custom Values de Meta desde HighLevel
 */
export const getMetaCustomValues = async (req, res) => {
  try {
    logger.info('Obteniendo configuración de Meta desde HighLevel o DB local...');

    const hlConfig = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1');
    const [localMetaConfig, localSocialConfig, localLegacyConfig] = await Promise.all([
      getMetaConfig().catch(error => {
        logger.warn(`No se pudo leer Meta Ads local: ${error.message}`);
        return null;
      }),
      getMetaSocialConfig().catch(error => {
        logger.warn(`No se pudo leer Meta Social local: ${error.message}`);
        return null;
      }),
      getLegacyMetaConfig().catch(error => {
        logger.warn(`No se pudo leer el método heredado de Meta: ${error.message}`);
        return null;
      })
    ]);
    const metaDisconnected = cleanString(await getAppConfig('meta_config_disconnected')) === '1';

    if (metaDisconnected && !hasUsableLocalMetaConfig(localMetaConfig) && !hasUsableLocalMetaConfig(localSocialConfig)) {
      return res.json({
        success: true,
        data: null,
        source: 'disconnected',
        reconciliation: {
          success: true,
          action: 'disconnected',
          message: 'Meta fue desconectado localmente; no se rehidrata desde HighLevel automáticamente'
        }
      });
    }

    if (hlConfig?.location_id && hlConfig?.api_token) {
      const reconciliation = await reconcileMetaBusinessWithHighLevel(
        hlConfig.location_id,
        hlConfig.api_token,
        { prefer: 'local' }
      );

      logger.info(`Reconciliación Meta/HighLevel al cargar Settings: ${reconciliation.action} - ${reconciliation.message}`);

      const metaCustomValues = await fetchAndSaveMetaConfig(hlConfig.location_id, hlConfig.api_token);
      const [refreshedLocalConfig, refreshedSocialConfig, refreshedLegacyConfig] = await Promise.all([
        getMetaConfig().catch(() => null),
        getMetaSocialConfig().catch(() => null),
        getLegacyMetaConfig().catch(() => null)
      ]);

      // PRIORIDAD: si ya existe configuración de Meta en Ristak, usarla siempre.
      // Los custom values de HighLevel solo se usan cuando no hay config local.
      if (hasUsableLocalMetaConfig(refreshedLocalConfig) || hasUsableLocalMetaConfig(refreshedSocialConfig)) {
        const whatsappBusinessAccountId = await db.get(
          'SELECT config_value FROM app_config WHERE config_key = ?',
          ['meta_whatsapp_business_account_id']
        );

        return res.json({
          success: true,
          data: toMaskedMetaCredentials(
            refreshedLegacyConfig || {},
            whatsappBusinessAccountId?.config_value,
            refreshedLegacyConfig
          ),
          source: 'local',
          reconciliation
        });
      }

      if (metaCustomValues && (
        metaCustomValues.adAccountId ||
        metaCustomValues.accessToken ||
        metaCustomValues.pixelId ||
        metaCustomValues.pageId ||
        metaCustomValues.instagramAccountId ||
        metaCustomValues.whatsappBusinessAccountId
      )) {
        return res.json({
          success: true,
          data: metaCustomValues,
          source: 'highlevel',
          reconciliation
        });
      }
    }

    if (hasUsableLocalMetaConfig(localMetaConfig) || hasUsableLocalMetaConfig(localSocialConfig)) {
      const whatsappBusinessAccountId = await db.get(
        'SELECT config_value FROM app_config WHERE config_key = ?',
        ['meta_whatsapp_business_account_id']
      );

      return res.json({
        success: true,
        data: toMaskedMetaCredentials(
          localLegacyConfig || {},
          whatsappBusinessAccountId?.config_value,
          localLegacyConfig
        ),
        source: 'local',
        reconciliation: {
          success: true,
          action: 'local_only',
          message: 'Usando Meta local; HighLevel queda como integración opcional'
        }
      });
    }

    res.json({
      success: true,
      data: {
        adAccountId: '',
        accessToken: '',
        pixelId: '',
        pageId: '',
        instagramAccountId: '',
        whatsappBusinessAccountId: ''
      },
      source: 'empty'
    });

  } catch (error) {
    logger.error(`Error en getMetaCustomValues: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener custom values de Meta desde HighLevel'
    });
  }
};

/**
 * Guarda credenciales de Meta localmente y las sincroniza con HighLevel si existe
 * USA System User Token (no requiere App ID ni App Secret)
 */
export const saveAndSyncMeta = async (req, res) => {
  try {
    const { adAccountId, accessToken, pixelId, pageId, instagramAccountId, whatsappBusinessAccountId } = req.body;

    logger.info('Guardando credenciales de Meta Business...');

    // 1. Validar que al menos tengamos ad_account_id y access_token
    if (!adAccountId || !accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren al menos Ad Account ID y Access Token'
      });
    }

    const existingMetaConfig = await getLegacyMetaConfig().catch(error => {
      logger.warn(`No se pudo leer configuración previa de Meta: ${error.message}`);
      return null;
    });
    const replacingOAuthWithManual = ['oauth_bisu', 'oauth_user'].includes(
      cleanString(existingMetaConfig?.connection_mode)
    );

    if (replacingOAuthWithManual && isMaskedSecret(accessToken)) {
      return res.status(400).json({
        success: false,
        error: 'Para volver al modo manual pega un System User Token nuevo; el token OAuth no se puede reutilizar ni exportar.'
      });
    }

    const effectiveAccessToken = isMaskedSecret(accessToken)
      ? existingMetaConfig?.access_token
      : accessToken;

    if (!effectiveAccessToken) {
      return res.status(400).json({
        success: false,
        error: 'El Access Token está enmascarado y no existe un token local para reutilizar. Pega el token completo.'
      });
    }

    // 2. Validar que las credenciales funcionen antes de persistir
    logger.info('Validando credenciales de Meta...');
    const validation = await verifyMetaToken(effectiveAccessToken);

    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: `Credenciales de Meta inválidas: ${validation.error || 'Token inválido o expirado'}`
      });
    }

    logger.info('Credenciales de Meta validadas exitosamente');

    const normalizedAdAccountId = normalizeMetaAdAccountId(adAccountId);
    const normalizedPixelId = cleanString(pixelId);
    const normalizedPageId = cleanString(pageId);
    const normalizedInstagramAccountId = cleanString(instagramAccountId);
    const normalizedWhatsappBusinessAccountId = cleanString(whatsappBusinessAccountId);

    // 2.b Auto-asociar el Meta Pixel de la cuenta de anuncios cuando el usuario
    // no eligió uno manualmente. La mayoría de las cuentas ya traen su
    // pixel/dataset asociado, así que lo tomamos automáticamente para que
    // reportes, CAPI y el snippet de Web Tracking ya lo tengan sin un paso extra.
    let effectivePixelId = normalizedPixelId;
    if (!effectivePixelId) {
      try {
        const accountForPixels = normalizedAdAccountId.startsWith('act_')
          ? normalizedAdAccountId
          : `act_${normalizedAdAccountId}`;
        const pixelsUrl = `${API_URLS.META_GRAPH}/${accountForPixels}/adspixels?fields=id,name&limit=1&access_token=${effectiveAccessToken}`;
        const pixelsResp = await fetch(pixelsUrl);
        const pixelsData = await pixelsResp.json();
        const firstPixel = Array.isArray(pixelsData?.data) ? pixelsData.data[0] : null;
        if (firstPixel?.id) {
          effectivePixelId = cleanString(firstPixel.id);
          logger.info(`Pixel auto-asociado desde la cuenta ${accountForPixels}: ${effectivePixelId} (${firstPixel.name || 'sin nombre'})`);
        } else {
          logger.info(`La cuenta ${accountForPixels} no reporta pixeles; se guarda sin pixel`);
        }
      } catch (pixelError) {
        logger.warn(`No se pudo auto-asociar el pixel de la cuenta: ${safeMetaGraphTransportError(pixelError)}`);
      }
    }

    // 3. Guardar en meta_config local (encriptado)
    const persistManualConfig = () => saveMetaConfig(
      normalizedAdAccountId,
      effectiveAccessToken,
      effectivePixelId || null,
      normalizedPageId || null,
      normalizedInstagramAccountId || null,
      { connectionMode: 'manual_system_user', allowOAuthToManual: true }
    );
    if (replacingOAuthWithManual) {
      await replaceMetaOAuthWithManualConnection(persistManualConfig);
    } else {
      await persistManualConfig();
    }
    await setAppConfig('meta_config_disconnected', '0');
    await syncRegisteredIntegrationCronsForProvider('meta', { reason: 'meta-connected' });
    await syncRegisteredIntegrationCronsForProvider('meta-ads', { reason: 'meta-connected' });
    await syncRegisteredIntegrationCronsForProvider('meta-social', { reason: 'meta-connected' });

    if (normalizedWhatsappBusinessAccountId) {
      await setAppConfig('meta_whatsapp_business_account_id', normalizedWhatsappBusinessAccountId);
    }

    logger.info('Credenciales guardadas en base de datos local');

    // 4. Si HighLevel ya existe, empujar Meta hacia sus Custom Values. Si no, no bloquear.
    const hlConfig = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1');
    let highLevelSyncResult = {
      success: false,
      skipped: true,
      message: 'Meta quedó guardado localmente; HighLevel queda como integración opcional'
    };

    if (hlConfig?.location_id && hlConfig?.api_token) {
      try {
        highLevelSyncResult = await saveMetaCustomValues(hlConfig.location_id, hlConfig.api_token, {
          adAccountId: normalizedAdAccountId,
          accessToken: effectiveAccessToken,
          pixelId: effectivePixelId || '',
          pageId: normalizedPageId || '',
          instagramAccountId: normalizedInstagramAccountId || '',
          whatsappBusinessAccountId: normalizedWhatsappBusinessAccountId || ''
        });

        logger.info(`Credenciales de Meta sincronizadas hacia HighLevel: ${highLevelSyncResult.message}`);
      } catch (highLevelError) {
        highLevelSyncResult = {
          success: false,
          skipped: false,
          error: highLevelError.message,
          message: 'Meta se guardó localmente, pero no se pudo actualizar HighLevel'
        };
        logger.warn(`Meta local guardado, pero falló sync a HighLevel: ${highLevelError.message}`);
      }
    } else {
      logger.info('Sin integración opcional de HighLevel; Meta se guardó en Ristak.');
    }

    // 5. Iniciar sincronización automática de anuncios sin bloquear el wizard.
    const adsSync = startMetaAdsSyncAfterConnection('wizard-complete');
    const socialHistoryBackfill = startMetaSocialHistoryBackfillAfterConnection('wizard-complete');

    // 8. Sincronizar el snippet de Web Tracking con el Meta Pixel automáticamente.
    // El snippet se inyecta en el SITIO del cliente (su dominio de rastreo), no en
    // el dominio donde corre Ristak; por eso NO se condiciona a onrender.com. El
    // generador del snippet resuelve el dominio de rastreo correcto por su cuenta.
    if (req.headers.host && effectivePixelId) {
      // Leer preferencia del usuario: ¿quiere incluir Meta Pixel en el snippet?
      // Default: true (ON por default)
      const { getAppConfig } = await import('../config/database.js')
      const includeMetaPixelPref = await getAppConfig('include_meta_pixel')
      const includeMetaPixel = includeMetaPixelPref === null || includeMetaPixelPref === undefined
        ? true // Default: ON
        : (includeMetaPixelPref === '1' || includeMetaPixelPref === 1 || includeMetaPixelPref === true || includeMetaPixelPref === 'true')

      if (includeMetaPixel) {
        logger.info(`Sincronizando snippet de Web Tracking con Meta Pixel ${effectivePixelId}...`)

        // Importar la función de configuración de tracking
        const { configureTracking } = await import('./trackingController.js')

        // Crear un objeto de respuesta temporal (no queremos esperar ni que falle si hay error)
        const tempRes = {
          json: (data) => {
            if (data.success) {
              logger.info('✅ Snippet sincronizado automáticamente con Meta Pixel incluido')
            } else {
              logger.warn(`⚠️ No se pudo sincronizar snippet: ${data.error || 'unknown'}`)
            }
          },
          status: (code) => {
            if (code !== 200) {
              logger.warn(`⚠️ Sincronización de snippet retornó status ${code}`)
            }
            return tempRes
          }
        }

        // Ejecutar en background (no bloquear la respuesta)
        configureTracking(req, tempRes).catch(err => {
          logger.warn(`⚠️ Error sincronizando snippet automáticamente: ${err.message}`)
        })
      } else {
        logger.info(`Meta Pixel (${effectivePixelId}) disponible pero la inclusión en snippet está DESACTIVADA (include_meta_pixel = false)`)
        logger.info('NO se auto-sincronizará el snippet. El usuario puede activar el switch en Settings → Meta Ads')
      }
    } else if (!effectivePixelId) {
      logger.info('No hay Pixel ID (ni auto-asociado), snippet NO incluirá Meta Pixel')
    }

    res.json({
      success: true,
      message: 'Credenciales guardadas y sincronización iniciada exitosamente',
      data: {
        savedInHighLevel: highLevelSyncResult.success === true,
        highLevelSync: highLevelSyncResult,
        adAccountId: normalizedAdAccountId,
        pixelId: effectivePixelId,
        instagramAccountId: normalizedInstagramAccountId,
        tokenValid: validation.valid,
        syncStarted: adsSync.syncStarted,
        adsSync,
        socialHistoryBackfill
      }
    });

  } catch (error) {
    logger.error(`Error en saveAndSyncMeta: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al guardar y sincronizar credenciales de Meta'
    });
  }
};

/**
 * Sincroniza configuración de Meta desde HighLevel custom values
 * Busca los custom values de Meta en HighLevel, los guarda en meta_config,
 * valida que funcionen y luego inicia sincronización de anuncios
 */
export const syncFromHighLevel = async (req, res) => {
  try {
    logger.info('Iniciando sincronización de Meta desde HighLevel custom values...');

    // 1. Obtener configuración de HighLevel
    const hlConfig = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1');

    if (!hlConfig || !hlConfig.location_id || !hlConfig.api_token) {
      return res.status(400).json({
        success: false,
        error: 'La sincronización opcional desde HighLevel no está configurada. Meta puede operar con su configuración local en Ristak.'
      });
    }

    const currentMetaConfig = await getMetaConfig().catch(() => null);
    if (['oauth_bisu', 'oauth_user'].includes(cleanString(currentMetaConfig?.connection_mode))) {
      return res.json({
        success: true,
        skipped: true,
        source: 'oauth_isolated',
        message: 'Meta OAuth está aislado de HighLevel y no se reemplazó.',
        data: { connectionMode: 'oauth_bisu', adAccountId: currentMetaConfig.ad_account_id }
      });
    }

    // 2. Buscar custom values de Meta en HighLevel
    logger.info('Buscando custom values de Meta en HighLevel...');
    const metaCustomValues = await fetchAndSaveMetaConfig(hlConfig.location_id, hlConfig.api_token);

    if (!metaCustomValues || !metaCustomValues.adAccountId || !metaCustomValues.accessToken.startsWith('***')) {
      return res.status(404).json({
        success: false,
        error: 'No se encontraron custom values de Meta en HighLevel. Verifica que hayas creado los custom values con los nombres exactos.'
      });
    }

    const reconciliation = await reconcileMetaBusinessWithHighLevel(
      hlConfig.location_id,
      hlConfig.api_token,
      { prefer: 'highlevel' }
    );

    if (!reconciliation.success) {
      return res.status(500).json({
        success: false,
        error: `No se pudo sincronizar Meta desde HighLevel: ${reconciliation.message}`
      });
    }

    // 4. Verificar si se guardaron las credenciales
    const metaConfig = await getMetaConfig();

    if (!metaConfig || !metaConfig.access_token || !metaConfig.ad_account_id) {
      return res.status(404).json({
        success: false,
        error: 'No se encontraron custom values de Meta en HighLevel. Verifica que hayas creado los 4 custom values con los nombres exactos.'
      });
    }

    logger.info('Credenciales de Meta encontradas y guardadas exitosamente');

    // 4. Validar que las credenciales funcionen
    logger.info('Validando credenciales de Meta...');
    const validation = await verifyMetaToken(metaConfig.access_token, metaConfig.oauth_appsecret_proof || '');

    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: `Credenciales de Meta inválidas: ${validation.error || 'Token inválido o expirado'}`
      });
    }

    logger.info('Credenciales de Meta validadas exitosamente');

    // 5. Iniciar sincronización automática de anuncios sin bloquear la respuesta.
    const adsSync = startMetaAdsSyncAfterConnection('highlevel-import');
    const socialHistoryBackfill = startMetaSocialHistoryBackfillAfterConnection('highlevel-import');

    res.json({
      success: true,
      message: 'Configuración de Meta sincronizada exitosamente. Sincronización de anuncios iniciada.',
      data: {
        adAccountId: metaConfig.ad_account_id,
        tokenValid: validation.valid,
        syncStarted: adsSync.syncStarted,
        adsSync,
        socialHistoryBackfill,
        reconciliation
      }
    });

  } catch (error) {
    logger.error(`Error en syncFromHighLevel: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Error al sincronizar configuración de Meta desde HighLevel'
    });
  }
};

/**
 * (META-005) Extrae el access token de Meta desde los headers de la petición
 * en lugar del query string, para no filtrarlo en logs/historial del navegador.
 * Acepta `Authorization: Bearer <token>` o el header custom `X-Meta-Access-Token`.
 */
function extractMetaAccessToken(req) {
  const customHeader = req.headers['x-meta-access-token'];
  if (typeof customHeader === 'string' && customHeader.trim()) {
    return customHeader.trim();
  }

  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1].trim()) {
      return match[1].trim();
    }
  }

  return null;
}

function extractExplicitMetaAccessToken(req) {
  const customHeader = req.headers['x-meta-access-token'];
  if (typeof customHeader === 'string' && customHeader.trim()) {
    return customHeader.trim();
  }

  return cleanString(req.query?.accessToken);
}

async function resolveMetaRequestCredentials(req, integrationKind = 'ads') {
  const explicitAccessToken = extractMetaAccessToken(req);
  if (explicitAccessToken) return { accessToken: explicitAccessToken, appSecretProof: '', oauthUserId: '', isOAuth: false, source: 'explicit' };

  const config = integrationKind === 'social'
    ? await getMetaSocialConfig().catch(() => null)
    : await getMetaConfig().catch(() => null);
  return {
    accessToken: cleanString(config?.access_token),
    appSecretProof: ['oauth_bisu', 'oauth_user'].includes(cleanString(config?.connection_mode))
      ? cleanString(config?.oauth_appsecret_proof)
      : '',
    oauthUserId: cleanString(config?.oauth_user_id),
    isOAuth: ['oauth_bisu', 'oauth_user'].includes(cleanString(config?.connection_mode)),
    source: config?.access_token ? 'stored' : 'none'
  };
}

/**
 * Obtiene las cuentas de anuncios del usuario de Meta
 * GET /api/meta/ad-accounts (token en header X-Meta-Access-Token / Authorization)
 */
export const getAdAccounts = async (req, res) => {
  try {
    // (META-005) El access token llega por header (Authorization: Bearer o X-Meta-Access-Token),
    // ya no por query string, para no exponerlo en logs/historial frontend->backend.
    const { accessToken, appSecretProof, oauthUserId, isOAuth } = await resolveMetaRequestCredentials(req);

    if (!accessToken) {
      logger.error('❌ No se proporcionó accessToken');
      return res.status(400).json({
        success: false,
        error: 'Se requiere accessToken'
      });
    }

    logger.info('Obteniendo cuentas de Meta Ads');

    // PASO 1: Verificar token y obtener user_id
    let userId = oauthUserId;
    if (isOAuth && !userId) {
      const meParams = new URLSearchParams({ fields: 'id', access_token: accessToken, appsecret_proof: appSecretProof });
      const meResponse = await fetch(`${API_URLS.META_GRAPH}/me?${meParams.toString()}`);
      const meData = await meResponse.json();
      userId = meData?.id;
      if (!meResponse.ok || meData?.error) {
        return res.status(400).json({ success: false, error: meData?.error?.message || 'Token OAuth inválido' });
      }
    } else if (!isOAuth) {
      const debugParams = new URLSearchParams({ input_token: accessToken, access_token: accessToken });
      const debugUrl = `${API_URLS.META_TOKEN_DEBUG}?${debugParams.toString()}`;
      const debugResponse = await fetch(debugUrl);
      const debugData = await debugResponse.json();
      if (debugData.error) {
        return res.status(400).json({ success: false, error: debugData.error.message || 'Token inválido' });
      }
      userId = debugData.data?.user_id;
    }

    if (!userId) {
      logger.error('No se pudo extraer user_id del token');
      return res.status(400).json({
        success: false,
        error: 'No se pudo obtener user_id del token'
      });
    }

    // PASO 2: Obtener ad accounts DIRECTAMENTE del System User (sin businesses)
    const adAccountParams = new URLSearchParams({
      fields: 'id,account_id,name,currency,timezone_name,account_status',
      limit: '100',
      access_token: accessToken
    });
    if (appSecretProof) adAccountParams.set('appsecret_proof', appSecretProof);
    const adAccountsUrl = `${API_URLS.META_GRAPH}/${encodeURIComponent(userId)}/adaccounts?${adAccountParams.toString()}`;
    const uniqueAccounts = await fetchMetaConnection(adAccountsUrl);
    logger.info(`Encontradas ${uniqueAccounts.length} cuenta(s) de anuncios`);

    res.json({
      success: true,
      data: {
        adAccounts: uniqueAccounts
      }
    });

  } catch (error) {
    logger.error(`Error en getAdAccounts: ${safeMetaGraphTransportError(error)}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener cuentas de anuncios'
    });
  }
};

/**
 * Obtiene los pixeles de Meta de una cuenta de anuncios
 * GET /api/meta/pixels?adAccountId=act_123  (token vía header X-Meta-Access-Token, ver META-005)
 */
export const getPixels = async (req, res) => {
  try {
    const { adAccountId } = req.query;
    // (META-005) Token desde header en vez de query string.
    const { accessToken, appSecretProof } = await resolveMetaRequestCredentials(req);

    if (!adAccountId || !accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren adAccountId y accessToken'
      });
    }

    logger.info(`Obteniendo pixeles para cuenta: ${adAccountId}`);

    // Llamar a Meta Graph API para obtener pixels
    const pixelParams = new URLSearchParams({
      fields: 'id,name,code,creation_time,last_fired_time',
      limit: '100',
      access_token: accessToken
    });
    if (appSecretProof) pixelParams.set('appsecret_proof', appSecretProof);
    const url = `${API_URLS.META_GRAPH}/${encodeURIComponent(adAccountId)}/adspixels?${pixelParams.toString()}`;
    const pixels = await fetchMetaConnection(url);
    logger.info(`✅ Encontrados ${pixels.length} pixeles`);

    res.json({
      success: true,
      data: {
        pixels: pixels
      }
    });

  } catch (error) {
    logger.error(`Error en getPixels: ${safeMetaGraphTransportError(error)}`);
    res.status(500).json({
      success: false,
      error: 'Error al obtener pixeles'
    });
  }
};

function normalizeMetaPage(page = {}) {
  return {
    id: cleanString(page.id),
    name: cleanString(page.name),
    category: cleanString(page.category) || null,
    pictureUrl: page.picture?.data?.url || page.picture?.url || null
  };
}

async function fetchMetaConnection(initialUrl) {
  const records = [];
  let nextUrl = initialUrl;
  let pageCount = 0;

  while (nextUrl && pageCount < 10) {
    const response = await fetch(nextUrl);
    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message || 'Error de Meta API');
    }

    if (Array.isArray(data.data)) {
      records.push(...data.data);
    }

    const candidate = data.paging?.next || null;
    if (candidate) {
      const parsed = new URL(candidate);
      const configuredOrigin = new URL(API_URLS.META_GRAPH).origin;
      const isMetaHost = /(^|\.)facebook\.com$/i.test(parsed.hostname);
      if (parsed.protocol !== 'https:' && parsed.origin !== configuredOrigin) {
        throw new Error('Meta devolvió una URL de paginación insegura');
      }
      if (!isMetaHost && parsed.origin !== configuredOrigin) {
        throw new Error('Meta devolvió una URL de paginación fuera de Graph');
      }
      nextUrl = parsed.toString();
    } else {
      nextUrl = null;
    }
    pageCount += 1;
  }

  return records;
}

/**
 * Obtiene las páginas disponibles para el token de Meta
 * GET /api/meta/pages  (token vía header X-Meta-Access-Token, ver META-005)
 */
export const getPages = async (req, res) => {
  try {
    // (META-005) Token desde header en vez de query string.
    const { accessToken, appSecretProof, oauthUserId, isOAuth } = await resolveMetaRequestCredentials(req, 'social');

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere accessToken'
      });
    }

    logger.info('Obteniendo páginas de Meta asignadas al token');

    const pageFields = 'id,name,category,picture{url}';
    const params = new URLSearchParams({
      fields: pageFields,
      limit: '100',
      access_token: accessToken
    });
    if (appSecretProof) params.set('appsecret_proof', appSecretProof);

    let rawPages = await fetchMetaConnection(`${API_URLS.META_GRAPH}/me/accounts?${params.toString()}`);

    if (rawPages.length === 0) {
      let userId = oauthUserId;
      if (isOAuth && !userId) {
        const meParams = new URLSearchParams({ fields: 'id', access_token: accessToken, appsecret_proof: appSecretProof });
        const meResponse = await fetch(`${API_URLS.META_GRAPH}/me?${meParams.toString()}`);
        const meData = await meResponse.json();
        userId = meData?.id;
      } else if (!isOAuth) {
        const debugParams = new URLSearchParams({ input_token: accessToken, access_token: accessToken });
        const debugResponse = await fetch(`${API_URLS.META_TOKEN_DEBUG}?${debugParams.toString()}`);
        const debugData = await debugResponse.json();
        userId = debugData?.data?.user_id;
      }

      if (userId) {
        const fallbackEdges = ['accounts', 'assigned_pages'];

        for (const edge of fallbackEdges) {
          try {
            const fallbackPages = await fetchMetaConnection(`${API_URLS.META_GRAPH}/${encodeURIComponent(userId)}/${edge}?${params.toString()}`);
            rawPages.push(...fallbackPages);
          } catch (fallbackError) {
            logger.warn(`No se pudieron leer páginas desde ${edge}: ${safeMetaGraphTransportError(fallbackError)}`);
          }
        }
      }
    }

    const pagesById = new Map();
    rawPages
      .map(normalizeMetaPage)
      .filter(page => page.id && page.name)
      .forEach(page => pagesById.set(page.id, page));

    const pages = [...pagesById.values()];
    logger.info(`Encontradas ${pages.length} página(s) de Meta`);

    res.json({
      success: true,
      data: {
        pages
      }
    });
  } catch (error) {
    logger.error(`Error en getPages: ${safeMetaGraphTransportError(error)}`);
    res.status(400).json({
      success: false,
      error: 'Error al obtener páginas'
    });
  }
};

/**
 * Obtiene perfiles sociales disponibles desde la conexión Meta guardada.
 * GET /api/meta/social-profiles
 */
export const getSocialProfiles = async (req, res) => {
  try {
    const accessToken = extractExplicitMetaAccessToken(req);
    const result = await getConnectedMetaSocialProfiles({
      ...(accessToken ? { accessToken } : {}),
      pageId: req.query?.pageId,
      instagramAccountId: req.query?.instagramAccountId
    });
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error(`Error en getSocialProfiles: ${error.message}`);
    res.status(400).json({
      success: false,
      error: error.message || 'Error al obtener perfiles sociales conectados'
    });
  }
};
