import { createHash } from 'node:crypto'
import { logger } from '../utils/logger.js'
import { createSession, getRecentSessions, getVisitorIdentityExpression, linkVisitorToContact, getSessionsByDateRange, getSessionMetricsByDateRange } from '../services/trackingService.js'
import { recordVideoPlaybackEvent } from '../services/videoTrackingService.js'
import { databaseDialect, getHighLevelConfig, getAppConfig, setAppConfig, db } from '../config/database.js'
import { getMetaConfig } from '../services/metaAdsService.js'
import { getHiddenContactFilters, buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js'
import { resolveDateRangeWithGHLTimezone, sqliteTimezoneOffsetClause } from '../utils/dateUtils.js'
import { getGroupExpression } from '../services/analyticsService.js'
import { getMessageAnalyticsSummary, getWhatsAppApiAnalyticsSummary } from '../services/originDistributionService.js'
import {
  buildTrackingSearchDocumentExpression,
  getTrackingAnalyticsFacet,
  getTrackingAnalyticsSummary,
  searchTrackingSessions
} from '../services/trackingAnalyticsService.js'
import { invalidateTrackingAnalyticsCache } from '../services/trackingAnalyticsCache.js'
import { getTrackingVisitorProjectionStatus } from '../services/trackingVisitorProjectionService.js'
import { nonTestPaymentCondition, SUCCESS_PAYMENT_STATUSES } from '../utils/paymentMode.js'
import { getNoTrackReason } from '../utils/noTracking.js'
import {
  normalizePublicHost,
  resolvePublicServiceBaseUrl
} from '../utils/publicUrl.js'
import {
  getTrackingDomainConfig,
  verifyAndSaveTrackingDomain
} from '../services/trackingDomainService.js'
import {
  collectMetaParameterSignals,
  getMetaParameterBuilderClientBundle,
  setMetaParameterCookies
} from '../services/metaParameterManagerService.js'
import fetch from 'node-fetch'

const isPostgres = databaseDialect === 'postgres'
function createTrackingRequestAbortScope(res, { timeoutMs = 0 } = {}) {
  const controller = new AbortController()
  let timedOut = false
  const onClose = () => {
    if (!res?.writableEnded && !res?.finished) controller.abort()
  }
  const observable = typeof res?.once === 'function'
  if (observable) res.once('close', onClose)
  const deadlineTimer = timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
    : null
  deadlineTimer?.unref?.()
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut
    },
    cleanup() {
      if (observable && typeof res?.off === 'function') res.off('close', onClose)
      if (deadlineTimer) clearTimeout(deadlineTimer)
    }
  }
}

function isTrackingRequestAbort(error, signal) {
  return Boolean(signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR')
}

function trackingRequestDeadlineError() {
  const error = new Error('La consulta de tracking excedió el presupuesto de ejecución')
  error.status = 503
  error.code = 'tracking_request_deadline'
  return error
}
const TRACKING_SNIPPET_VERSION = '13' // Incrementar cuando cambies el código del snippet
const TRACKING_GHL_SYNC_STATE_CONFIG_KEY = 'tracking_ghl_sync_state'
const SUCCESS_PAYMENT_STATUS_SQL = SUCCESS_PAYMENT_STATUSES
  .map(status => `'${String(status).replace(/'/g, "''")}'`)
  .join(', ')
const INACTIVE_APPOINTMENT_STATUSES = [
  'cancelled',
  'canceled',
  'no_show',
  'no-show',
  'noshow',
  'invalid',
  'failed',
  'missed',
  'deleted',
  'void',
  'voided'
]
const INACTIVE_APPOINTMENT_STATUS_SQL = INACTIVE_APPOINTMENT_STATUSES
  .map(status => `'${status}'`)
  .join(', ')
const ATTENDED_APPOINTMENT_STATUSES = [
  'show',
  'showed',
  'completed',
  'complete',
  'attended'
]
const ATTENDED_APPOINTMENT_STATUS_SQL = ATTENDED_APPOINTMENT_STATUSES
  .map(status => `'${status}'`)
  .join(', ')
const CONTACT_CONVERSION_LIST_TYPES = new Set([
  'registrations',
  'prospects',
  'appointments',
  'attendances',
  'customers'
])
const TRACKING_DRILLDOWN_DEFAULT_LIMIT = 50
const TRACKING_DRILLDOWN_MAX_LIMIT = 100
const TRACKING_DRILLDOWN_MAX_SEARCH_LENGTH = 160
const TRACKING_VISITOR_SEARCH_CANDIDATE_LIMIT = 500
const TRACKING_VISITOR_QUERY_DEADLINE_MS = 14_000
const TRACKING_AUXILIARY_QUERY_DEADLINE_MS = 18_000
const LEGACY_TRACKING_SESSIONS_MAX_LIMIT = 200
const LEGACY_TRACKING_SESSIONS_MAX_OFFSET = 5_000

function trackingDrilldownRequestError(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

function trackingProjectionWarmingError(coverage) {
  const error = new Error('La vista de visitantes se está preparando. Intenta nuevamente en unos segundos.')
  error.status = 503
  error.code = 'tracking_visitor_projection_warming'
  error.coverage = coverage
  return error
}

function normalizeTrackingDrilldownLimit(value) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return TRACKING_DRILLDOWN_DEFAULT_LIMIT
  return Math.min(parsed, TRACKING_DRILLDOWN_MAX_LIMIT)
}

function normalizeTrackingDrilldownSearch(value) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, TRACKING_DRILLDOWN_MAX_SEARCH_LENGTH)
}

function trackingDrilldownCursorValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  return String(value || '').trim()
}

function trackingDrilldownCursorScope(kind, context) {
  return createHash('sha256').update(JSON.stringify({ kind, ...context })).digest('base64url')
}

function encodeTrackingDrilldownCursor(kind, row, scope) {
  const createdAt = trackingDrilldownCursorValue(
    row?.cursor_serialized_at ?? row?.cursor_at ?? row?.created_at
  )
  const id = String(row?.cursor_row_id || row?.session_row_id || row?.id || '').trim()
  if (!createdAt || !id) return null
  const mode = String(row?.cursor_mode || '').trim()

  return Buffer.from(JSON.stringify({
    v: 3,
    kind,
    scope,
    createdAt,
    id,
    ...(mode ? { mode } : {})
  }), 'utf8').toString('base64url')
}

function decodeTrackingDrilldownCursor(value, expectedKind, expectedScope) {
  const clean = String(value || '').trim()
  if (!clean) return null
  if (clean.length > 2048) throw trackingDrilldownRequestError('Cursor inválido')

  try {
    const parsed = JSON.parse(Buffer.from(clean, 'base64url').toString('utf8'))
    const createdAt = String(parsed?.createdAt || '').trim()
    const id = String(parsed?.id || '').trim()
    if (![1, 2, 3].includes(parsed?.v) || parsed?.kind !== expectedKind || !createdAt || !id) {
      throw new Error('invalid cursor payload')
    }
    if (parsed.v === 3 && parsed.scope !== expectedScope) {
      throw trackingDrilldownRequestError('El cursor ya no corresponde a esta vista; vuelve a la primera página')
    }
    if (createdAt.length > 100 || id.length > 300) throw new Error('cursor fields too long')
    if (!Number.isFinite(Date.parse(createdAt))) throw new Error('invalid cursor timestamp')
    const mode = parsed?.v === 1 ? 'legacy-created' : String(parsed?.mode || '').trim()
    if (mode && !['legacy-created', 'legacy-started', 'projection-started', 'projection-created', 'contact-created'].includes(mode)) {
      throw new Error('invalid cursor mode')
    }
    if (expectedKind === 'tracking-visitors' && isPostgres && mode !== 'contact-created' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error('invalid visitor cursor id')
    }
    return { createdAt, id, mode }
  } catch (error) {
    if (error?.status === 400) throw error
    throw trackingDrilldownRequestError('Cursor inválido')
  }
}

function trackingTimestampSortExpression(valueExpression) {
  if (isPostgres) return valueExpression

  const normalized = `CASE
    WHEN typeof(${valueExpression}) IN ('integer', 'real')
      AND ABS(CAST(${valueExpression} AS REAL)) >= 100000000000
      THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(${valueExpression} AS REAL) / 1000.0, 'unixepoch')
    WHEN typeof(${valueExpression}) IN ('integer', 'real')
      THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(${valueExpression} AS REAL), 'unixepoch')
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ${valueExpression})
  END`
  return normalized
}

function trackingCursorTimestampProjection(sortExpression) {
  return isPostgres ? `(${sortExpression})::text` : sortExpression
}

function appendTrackingDrilldownSearch(conditions, params, search, expressions) {
  if (!search) return
  const pattern = trackingDrilldownSearchPattern(search)
  conditions.push(`(${expressions.map(expression => `LOWER(COALESCE(CAST(${expression} AS TEXT), '')) LIKE ? ESCAPE '!'`).join(' OR ')})`)
  params.push(...expressions.map(() => pattern))
}

function trackingDrilldownSearchPattern(search) {
  const escapedSearch = String(search || '')
    .toLocaleLowerCase('es-MX')
    .replace(/!/g, '!!')
    .replace(/%/g, '!%')
    .replace(/_/g, '!_')
  return `%${escapedSearch}%`
}

function trackingContactSearchDocumentExpression(alias = 'c') {
  return `LOWER(
    COALESCE(${alias}.full_name, '') || ' ' ||
    COALESCE(${alias}.email, '') || ' ' ||
    COALESCE(${alias}.phone, '') || ' ' ||
    ${alias}.id
  )`
}

function trackingVisitorProjectionCoverage(projectionStatus, {
  rangeQuarterAligned,
  search = '',
  candidatesScanned = 0,
  candidateLimit = 0,
  searchExhausted = true
} = {}) {
  const reasons = []
  if (!projectionStatus?.available) reasons.push('projection_unavailable')
  else if (!projectionStatus.ready) reasons.push('projection_warming')
  if (!rangeQuarterAligned) reasons.push('range_not_quarter_aligned')
  if (search) reasons.push('bounded_latest_session_search')

  const exact = Boolean(
    projectionStatus?.available &&
    projectionStatus.ready &&
    rangeQuarterAligned &&
    !search
  )

  return {
    source: 'tracking_visitor_latest',
    projectionVersion: Number(projectionStatus?.version || 0) || null,
    available: Boolean(projectionStatus?.available),
    status: projectionStatus?.status || 'unavailable',
    sourceStatus: projectionStatus?.sourceStatus || null,
    updatedAt: projectionStatus?.updatedAt || null,
    exact,
    complete: exact,
    partial: !exact,
    reason: reasons[0] || null,
    reasons,
    rangeQuarterAligned: Boolean(rangeQuarterAligned),
    search: search
      ? {
          mode: 'bounded_latest_projection',
          historicalSessionsIncluded: false,
          candidatesScanned,
          candidateLimit,
          exhausted: Boolean(searchExhausted)
        }
      : { mode: 'none' }
  }
}

function trackingSessionTimestampExpression(alias = 's') {
  return trackingTimestampSortExpression(`${alias}.started_at`)
}

function trackingContactCursorSortExpression(alias = 'c') {
  // Los dos drill-downs acotan created_at por rango antes de paginar; ese
  // predicado excluye NULL y nos deja conservar el índice (created_at, id).
  return `${alias}.created_at`
}

function validPaymentPredicate(alias = 'p') {
  const prefix = alias ? `${alias}.` : ''
  return `
    COALESCE(${prefix}amount, 0) > 0
    AND LOWER(COALESCE(${prefix}status, '')) IN (${SUCCESS_PAYMENT_STATUS_SQL})
    AND ${nonTestPaymentCondition(alias)}
  `
}

function validPaymentExistsCondition(contactAlias = 'c') {
  const prefix = contactAlias ? `${contactAlias}.` : ''
  return `EXISTS (
    SELECT 1
    FROM payments p
    WHERE p.contact_id = ${prefix}id
      AND ${validPaymentPredicate('p')}
  )`
}

function activeAppointmentCondition(contactAlias = 'c') {
  const prefix = contactAlias ? `${contactAlias}.` : ''
  return `(
    ${prefix}appointment_date IS NOT NULL OR EXISTS (
      SELECT 1
      FROM appointments a
      WHERE a.contact_id = ${prefix}id
        AND LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN (${INACTIVE_APPOINTMENT_STATUS_SQL})
    )
  )`
}

function attendedAppointmentCondition(contactAlias = 'c') {
  const prefix = contactAlias ? `${contactAlias}.` : ''
  return `(
    EXISTS (
      SELECT 1
      FROM appointment_attendance_signals aas
      WHERE aas.contact_id = ${prefix}id
    ) OR EXISTS (
      SELECT 1
      FROM appointments aa
      WHERE aa.contact_id = ${prefix}id
        AND LOWER(COALESCE(aa.appointment_status, aa.status, '')) IN (${ATTENDED_APPOINTMENT_STATUS_SQL})
    )
  )`
}

function getContactConversionListCondition(type) {
  const customerCondition = validPaymentExistsCondition('c')
  const appointmentCondition = activeAppointmentCondition('c')
  const attendanceCondition = attendedAppointmentCondition('c')

  switch (type) {
    case 'customers':
      return customerCondition
    case 'prospects':
      return `NOT ${customerCondition} AND NOT ${appointmentCondition} AND NOT ${attendanceCondition}`
    case 'appointments':
      return appointmentCondition
    case 'attendances':
      return attendanceCondition
    case 'registrations':
    default:
      return ''
  }
}

async function fetchBoundedAppointmentsForContacts(contactIds, limitPerContact = 5, { signal } = {}) {
  if (!contactIds.length) return new Map()

  const placeholders = contactIds.map(() => '?').join(', ')
  const rows = await db.all(`
    WITH ranked_appointments AS (
      SELECT
        a.id,
        a.contact_id,
        a.title,
        COALESCE(a.appointment_status, a.status) as status,
        a.start_time,
        ROW_NUMBER() OVER (
          PARTITION BY a.contact_id
          ORDER BY a.start_time DESC, a.id DESC
        ) as appointment_rank,
        COUNT(*) OVER (PARTITION BY a.contact_id) as appointment_total,
        MAX(CASE
          WHEN LOWER(COALESCE(a.appointment_status, a.status, '')) IN (${ATTENDED_APPOINTMENT_STATUS_SQL}) THEN 1
          ELSE 0
        END) OVER (PARTITION BY a.contact_id) as has_attended_appointment
      FROM appointments a
      WHERE a.contact_id IN (${placeholders})
    )
    SELECT *
    FROM ranked_appointments
    WHERE appointment_rank <= ?
    ORDER BY contact_id, start_time DESC, id DESC
  `, [...contactIds, limitPerContact], { signal })

  const result = new Map()
  for (const contactId of contactIds) {
    result.set(String(contactId), {
      appointments: [],
      total: 0,
      hasAttendedAppointment: false
    })
  }

  for (const row of rows) {
    const key = String(row.contact_id)
    const current = result.get(key) || {
      appointments: [],
      total: 0,
      hasAttendedAppointment: false
    }
    current.appointments.push({
      id: row.id,
      title: row.title,
      status: row.status,
      start_time: row.start_time
    })
    current.total = Number(row.appointment_total || 0)
    current.hasAttendedAppointment = Boolean(Number(row.has_attended_appointment || 0))
    result.set(key, current)
  }

  return result
}

async function fetchPaymentSummariesForContacts(contactIds, { signal } = {}) {
  if (!contactIds.length) return new Map()

  const placeholders = contactIds.map(() => '?').join(', ')
  const rows = await db.all(`
    SELECT
      p.contact_id,
      COALESCE(SUM(p.amount), 0) as ltv,
      COUNT(*) as purchases
    FROM payments p
    WHERE p.contact_id IN (${placeholders})
      AND ${validPaymentPredicate('p')}
    GROUP BY p.contact_id
  `, contactIds, { signal })

  return new Map(rows.map(row => [String(row.contact_id), {
    ltv: Number(row.ltv || 0),
    purchases: Number(row.purchases || 0)
  }]))
}

function timestampLocalExpression(column, timezone = 'UTC') {
  if (!isPostgres) {
    // TRK-008: usa el offset real de la zona en vez del -6h hardcodeado.
    return `datetime(${column}, ${sqliteTimezoneOffsetClause(timezone)})`
  }

  const safeTimezone = String(timezone || 'UTC').replace(/'/g, "''")
  return `((${column})::timestamptz AT TIME ZONE '${safeTimezone}')`
}

function timestampDateExpression(column, timezone = 'UTC') {
  if (!isPostgres) {
    return `DATE(${column})`
  }

  return `${timestampLocalExpression(column, timezone)}::date`
}

function metaAdsSameLocalDayCondition(metaDateColumn, timestampColumn, timezone = 'UTC') {
  const metaDateExpr = isPostgres ? `(${metaDateColumn})::date` : `DATE(${metaDateColumn})`
  return `${metaDateExpr} = ${timestampDateExpression(timestampColumn, timezone)}`
}

const parseIsoDateToUtc = (value) => {
  const [year, month, day] = String(value || '').split('-').map(Number)
  if (!year || !month || !day) return null
  return new Date(Date.UTC(year, month - 1, day))
}

const formatUtcDateKey = (date) => [
  date.getUTCFullYear(),
  String(date.getUTCMonth() + 1).padStart(2, '0'),
  String(date.getUTCDate()).padStart(2, '0')
].join('-')

function contactAnalyticsSourceCondition(alias = 'c') {
  const prefix = alias ? `${alias}.` : ''

  return `(
    (${prefix}visitor_id IS NOT NULL AND ${prefix}visitor_id != '')
    OR LOWER(COALESCE(${prefix}source, '')) LIKE '%whatsapp%'
    OR EXISTS (
      SELECT 1
      FROM whatsapp_api_messages wam
      WHERE wam.contact_id = ${prefix}id
    )
    OR EXISTS (
      SELECT 1
      FROM whatsapp_api_attribution waa
      WHERE waa.contact_id = ${prefix}id
    )
    OR EXISTS (
      SELECT 1
      FROM whatsapp_attribution wa
      WHERE wa.contact_id = ${prefix}id
    )
  )`
}

function getRequestIp(req) {
  let ip = null
  const xForwardedFor = req.headers['x-forwarded-for']
  if (typeof xForwardedFor === 'string' && xForwardedFor.length > 0) {
    ip = xForwardedFor.split(',')[0].trim()
  } else if (Array.isArray(xForwardedFor) && xForwardedFor.length > 0) {
    ip = xForwardedFor[0].trim()
  } else if (typeof req.headers['cf-connecting-ip'] === 'string') {
    ip = req.headers['cf-connecting-ip']
  }

  if (!ip) {
    ip =
      req.ip ||
      req.socket?.remoteAddress ||
      req.connection?.remoteAddress ||
      null
  }

  return ip && ip.startsWith('::ffff:') ? ip.substring(7) : ip
}

function buildTrackingSnippet({ trackingDomain, metaPixelId = null, includeMetaPixel = false }) {
  let snippet = `<!-- Pixel de Tracking Ristak -->
<script async src="https://${trackingDomain}/snip.js?v=${TRACKING_SNIPPET_VERSION}"></script>`

  if (metaPixelId && includeMetaPixel) {
    snippet += `

<!-- Meta Pixel Code -->
<script>
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${metaPixelId}');
fbq('track', 'PageView');
</script>
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id=${metaPixelId}&ev=PageView&noscript=1"
/></noscript>
<!-- End Meta Pixel Code -->`
  }

  return snippet
}

function getTrackingPublicFallbacks() {
  return [
    process.env.RENDER_EXTERNAL_URL,
    process.env.PUBLIC_URL,
    process.env.APP_URL
  ]
}

/**
 * Genera el código JavaScript del pixel de tracking
 * GET /snip.js
 */
export async function servePixel(req, res) {
  try {
    // SIEMPRE usar HTTPS (excepto en localhost para desarrollo)
    const host = req.headers.host
    const protocol = host.includes('localhost') ? 'http' : 'https'
    const BASE = `${protocol}://${host}`
    const ENDPOINT = `${BASE}/collect`
    const PARAM_BUILDER_URL = `${BASE}/meta-param-builder.js`
    const PARAM_BUILDER_IP_URL = `${BASE}/meta-param-builder-ip`

    // Generar el código del pixel dinámicamente
    const pixelCode = `
(function() {
  'use strict';

  var ENDPOINT = '${ENDPOINT}';
  var PARAM_BUILDER_URL = '${PARAM_BUILDER_URL}';
  var PARAM_BUILDER_IP_URL = '${PARAM_BUILDER_IP_URL}';
  var lastTrackedUrl = window.location.href;
  var pageViewTimer = null;
  var VISITOR_COOKIE_NAME = 'ristak_vid';
  var SESSION_COOKIE_NAME = 'ristak_sid';
  var VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
  var metaParamBuilderPromise = null;

  function valueMeansNoTrack(value, trackingParam) {
    if (value === null || typeof value === 'undefined') return false;
    var normalized = String(value).trim().toLowerCase();
    if (normalized === 'live' || normalized === 'public' || normalized === 'track' || normalized === 'tracked') return false;
    if (trackingParam && (normalized === '0' || normalized === 'false' || normalized === 'no')) return true;
    return normalized === '' || normalized === '1' || normalized === 'true' || normalized === 'yes' ||
      normalized === 'preview' || normalized === 'editor' || normalized === 'test' ||
      normalized === 'no_track' || normalized === 'notrack' || normalized === 'disabled' ||
      normalized === 'disable' || normalized === 'off';
  }

  function isNoTrackMode() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      var keys = ['no_track', 'noTrack', 'notrack', 'rstk_no_track', 'rstkNoTrack', 'rstk_preview', 'rstkPreview', 'preview', 'editor', 'editor_preview', 'editorPreview'];
      for (var i = 0; i < keys.length; i++) {
        if (params.has(keys[i]) && valueMeansNoTrack(params.get(keys[i]), false)) return true;
      }
      if (params.has('tracking') && valueMeansNoTrack(params.get('tracking'), true)) return true;
      if (window.ristakNoTrack === true || window.ristakPreviewMode === true) return true;
    } catch (e) {
      // Ignore URL parsing errors
    }
    return false;
  }

  if (isNoTrackMode()) return;

  // Obtener datos de localStorage
  function getLocalData() {
    try {
      var data = localStorage.getItem('ristak');
      return data ? JSON.parse(data) : {};
    } catch (e) {
      return {};
    }
  }

  // Guardar datos en localStorage
  function setLocalData(data) {
    try {
      localStorage.setItem('ristak', JSON.stringify(data));
    } catch (e) {
      // Ignore storage errors
    }
  }

  // Obtener datos de sessionStorage
  function getSessionData() {
    try {
      var data = sessionStorage.getItem('ristak');
      return data ? JSON.parse(data) : {};
    } catch (e) {
      return {};
    }
  }

  // Guardar datos en sessionStorage
  function setSessionData(data) {
    try {
      sessionStorage.setItem('ristak', JSON.stringify(data));
    } catch (e) {
      // Ignore storage errors
    }
  }

  function normalizeIdentityValue(value) {
    var cleaned = String(value || '').trim();
    if (!/^[A-Za-z0-9_-]{8,120}$/.test(cleaned)) return '';
    if (/^\d{12,}$/.test(cleaned)) return '';
    return cleaned;
  }

  function readCookie(name) {
    try {
      var pairs = document.cookie ? document.cookie.split(';') : [];
      for (var i = 0; i < pairs.length; i++) {
        var pair = pairs[i].trim();
        var separator = pair.indexOf('=');
        var key = separator >= 0 ? pair.slice(0, separator) : pair;
        if (key === name) {
          return decodeURIComponent(separator >= 0 ? pair.slice(separator + 1) : '');
        }
      }
    } catch (e) {
      // Ignore cookie errors
    }
    return '';
  }

  function writeCookie(name, value, maxAgeSeconds) {
    try {
      if (!value) return;
      var attrs = '; path=/; SameSite=Lax';
      if (maxAgeSeconds) attrs += '; max-age=' + maxAgeSeconds;
      if (window.location && window.location.protocol === 'https:') attrs += '; Secure';
      document.cookie = name + '=' + encodeURIComponent(value) + attrs;
    } catch (e) {
      // Ignore cookie errors
    }
  }

  function getUrlVisitorId() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      return normalizeIdentityValue(params.get('rkvi_id') || params.get('ristak_vid') || params.get('rstk_vid'));
    } catch (e) {
      return '';
    }
  }

  // Obtener o crear visitor_id (persistente entre sesiones)
  function getVisitorId() {
    try {
      var localData = getLocalData();
      var storedVisitorId = normalizeIdentityValue(localData.visitor_id);
      var cookieVisitorId = normalizeIdentityValue(readCookie(VISITOR_COOKIE_NAME));
      var urlVisitorId = getUrlVisitorId();
      var visitorId = storedVisitorId || cookieVisitorId || urlVisitorId || generateId(); // ID corto tipo HighLevel

      if (localData.visitor_id !== visitorId) {
        localData.visitor_id = visitorId;
      }
      if (!localData.first_visit) {
        localData.first_visit = new Date().toISOString();
      }
      setLocalData(localData);
      writeCookie(VISITOR_COOKIE_NAME, visitorId, VISITOR_COOKIE_MAX_AGE);
      return visitorId;
    } catch (e) {
      var fallbackVisitorId = normalizeIdentityValue(readCookie(VISITOR_COOKIE_NAME)) || getUrlVisitorId() || generateId();
      writeCookie(VISITOR_COOKIE_NAME, fallbackVisitorId, VISITOR_COOKIE_MAX_AGE);
      return fallbackVisitorId; // Fallback también usa ID corto
    }
  }

  // Obtener o crear session_id (temporal, solo esta sesión)
  function getSessionId() {
    try {
      var sessionData = getSessionData();
      var storedSessionId = normalizeIdentityValue(sessionData.session_id);
      var cookieSessionId = normalizeIdentityValue(readCookie(SESSION_COOKIE_NAME));
      if (!storedSessionId) {
        sessionData.session_id = cookieSessionId || generateUUID();
        sessionData.session_start = Date.now();
        sessionData.first_pv = !cookieSessionId;
      }
      setSessionData(sessionData);
      writeCookie(SESSION_COOKIE_NAME, sessionData.session_id);
      return sessionData.session_id;
    } catch (e) {
      var fallbackSessionId = normalizeIdentityValue(readCookie(SESSION_COOKIE_NAME)) || 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      writeCookie(SESSION_COOKIE_NAME, fallbackSessionId);
      return fallbackSessionId;
    }
  }

  // Verificar si es la primera vez en esta sesión
  function isFirstPageView() {
    try {
      var sessionData = getSessionData();
      if (sessionData.first_pv) {
        sessionData.first_pv = false;
        setSessionData(sessionData);
        return true;
      }
      return false;
    } catch (e) {
      return true;
    }
  }

  // Generar ID al estilo HighLevel (20 caracteres alfanuméricos)
  function generateId() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var id = '';
    for (var i = 0; i < 20; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
  }

  // Generar UUID simple (para session_id)
  function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // Extraer parámetros UTM y de plataformas de ads
  function extractUtmParams() {
    var params = {};
    var search = window.location.search.substring(1);
    if (!search) return params;

    var pairs = search.split('&');
    for (var i = 0; i < pairs.length; i++) {
      var pair = pairs[i].split('=');
      var key = decodeURIComponent(pair[0]);
      var value = pair[1] ? decodeURIComponent(pair[1]) : '';

      // UTMs básicos
      if (key.indexOf('utm_') === 0) {
        params[key] = value;
      }
      // Click IDs
      else if (key === 'gclid' || key === 'fbclid' || key === 'msclkid' ||
               key === 'ttclid' || key === 'wbraid' || key === 'gbraid') {
        params[key] = value;
      }
      // Facebook Ads params
      else if (key === 'campaign_id' || key === 'adset_id' || key === 'ad_id' ||
               key === 'campaign_name' || key === 'adset_name' || key === 'ad_name' ||
               key === 'placement' || key === 'site_source_name') {
        params[key] = value;
      }
      // Google Ads params
      else if (key === 'campaignid' || key === 'adgroupid' || key === 'creative' ||
               key === 'keyword' || key === 'matchtype' || key === 'network' ||
               key === 'device' || key === 'placement' || key === 'target') {
        params[key] = value;
      }
    }
    return params;
  }

  // Detectar tipo de dispositivo básico
  function getDeviceType() {
    var ua = navigator.userAgent;
    if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) {
      return 'tablet';
    }
    if (/Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/.test(ua)) {
      return 'mobile';
    }
    return 'desktop';
  }

  // Detectar browser y versión
  function getBrowserInfo() {
    var ua = navigator.userAgent;
    var browser = 'Unknown';
    var version = '';
    var match;

    // Edge
    if (ua.indexOf('Edg/') > -1) {
      browser = 'Edge';
      match = ua.match(/Edg\\/([\\\d.]+)/);
      version = match ? match[1] : '';
    }
    // Chrome
    else if (ua.indexOf('Chrome/') > -1 && ua.indexOf('Edg/') === -1) {
      browser = 'Chrome';
      match = ua.match(/Chrome\\/([\\\d.]+)/);
      version = match ? match[1] : '';
    }
    // Safari
    else if (ua.indexOf('Safari/') > -1 && ua.indexOf('Chrome') === -1) {
      browser = 'Safari';
      match = ua.match(/Version\\/([\\\d.]+)/);
      version = match ? match[1] : '';
    }
    // Firefox
    else if (ua.indexOf('Firefox/') > -1) {
      browser = 'Firefox';
      match = ua.match(/Firefox\\/([\\\d.]+)/);
      version = match ? match[1] : '';
    }
    // Opera
    else if (ua.indexOf('OPR/') > -1 || ua.indexOf('Opera/') > -1) {
      browser = 'Opera';
      match = ua.match(/(?:OPR|Opera)\\/([\\\d.]+)/);
      version = match ? match[1] : '';
    }
    // IE
    else if (ua.indexOf('MSIE') > -1 || ua.indexOf('Trident/') > -1) {
      browser = 'IE';
      match = ua.match(/(?:MSIE |rv:)([\\\d.]+)/);
      version = match ? match[1] : '';
    }

    return { browser: browser, browser_version: version };
  }

  // Detectar sistema operativo
  function getOS() {
    var ua = navigator.userAgent;
    var os = 'Unknown';

    if (ua.indexOf('Windows NT 10.0') > -1) os = 'Windows 10';
    else if (ua.indexOf('Windows NT 6.3') > -1) os = 'Windows 8.1';
    else if (ua.indexOf('Windows NT 6.2') > -1) os = 'Windows 8';
    else if (ua.indexOf('Windows NT 6.1') > -1) os = 'Windows 7';
    else if (ua.indexOf('Windows NT 6.0') > -1) os = 'Windows Vista';
    else if (ua.indexOf('Windows NT 5.1') > -1) os = 'Windows XP';
    else if (ua.indexOf('Windows') > -1) os = 'Windows';
    else if (ua.indexOf('Mac OS X') > -1) {
      var match = ua.match(/Mac OS X ([\d_]+)/);
      os = match ? 'macOS ' + match[1].replace(/_/g, '.') : 'macOS';
    }
    else if (ua.indexOf('Android') > -1) {
      var match = ua.match(/Android ([\d.]+)/);
      os = match ? 'Android ' + match[1] : 'Android';
    }
    else if (ua.indexOf('iPhone') > -1 || ua.indexOf('iPad') > -1) {
      var match = ua.match(/OS ([\d_]+)/);
      os = match ? 'iOS ' + match[1].replace(/_/g, '.') : 'iOS';
    }
    else if (ua.indexOf('Linux') > -1) os = 'Linux';
    else if (ua.indexOf('CrOS') > -1) os = 'Chrome OS';

    return os;
  }

  function getClientIdentitySignals() {
    var screenInfo = window.screen || {};
    var doc = document.documentElement || {};
    return {
      screen_width: screenInfo.width || null,
      screen_height: screenInfo.height || null,
      viewport_width: window.innerWidth || doc.clientWidth || null,
      viewport_height: window.innerHeight || doc.clientHeight || null,
      color_depth: screenInfo.colorDepth || null,
      device_pixel_ratio: window.devicePixelRatio || 1,
      hardware_concurrency: navigator.hardwareConcurrency || null,
      device_memory: navigator.deviceMemory || null,
      max_touch_points: navigator.maxTouchPoints || 0,
      platform: navigator.platform || null,
      vendor: navigator.vendor || null,
      cookies_enabled: navigator.cookieEnabled === true,
      do_not_track: navigator.doNotTrack || window.doNotTrack || null
    };
  }

  // Extraer cookies de Facebook si existen
  function getFacebookCookies() {
    var cookies = {};
    try {
      var cookieStr = document.cookie;
      var pairs = cookieStr.split(';');
      for (var i = 0; i < pairs.length; i++) {
        var pair = pairs[i].trim().split('=');
        var name = pair[0];
        var value = pair[1];
        if (name === '_fbc' || name === '_fbp') {
          cookies[name.substring(1)] = value; // Remove leading underscore
        }
      }
    } catch (e) {
      // Ignore cookie errors
    }
    return cookies;
  }

  function initMetaParamBuilder() {
    if (metaParamBuilderPromise) return metaParamBuilderPromise;
    metaParamBuilderPromise = new Promise(function(resolve) {
      try {
        if (window.clientParamBuilder && window.clientParamBuilder.processAndCollectAllParams) {
          resolve(window.clientParamBuilder);
          return;
        }
        var script = document.createElement('script');
        script.async = true;
        script.src = PARAM_BUILDER_URL;
        script.onload = function() { resolve(window.clientParamBuilder || null); };
        script.onerror = function() { resolve(null); };
        (document.head || document.documentElement).appendChild(script);
      } catch (error) {
        resolve(null);
      }
    }).then(function(builder) {
      if (!builder || !builder.processAndCollectAllParams) return null;
      var getIpFn = function() {
        return fetch(PARAM_BUILDER_IP_URL, { credentials: 'same-origin' })
          .then(function(response) { return response.ok ? response.json() : {}; })
          .then(function(payload) { return payload.client_ip_address || ''; })
          .catch(function() { return ''; });
      };
      return builder.processAndCollectAllParams(window.location.href, getIpFn).catch(function() { return null; });
    });
    return metaParamBuilderPromise;
  }

  // Detectar y guardar contact_id de HighLevel desde _ud
  function syncHighLevelContact() {
    try {
      var udData = localStorage.getItem('_ud');
      if (!udData) return null;

      var userData = JSON.parse(udData);
      var contactId = userData.customer_id || userData.id;
      var udVisitorId = userData.rkvi_id || null;

      if (contactId) {
        // Guardar en nuestra estructura ristak
        var localData = getLocalData();

        // Solo actualizar si cambió o es nuevo
        if (localData.contact_id !== contactId) {
          localData.contact_id = contactId;
          localData.contact_email = userData.email || null;
          localData.contact_name = userData.full_name || userData.name || null;
          localData.contact_synced_at = new Date().toISOString();
          setLocalData(localData);

          // Enviar visitor_id actual a HighLevel como custom field
          sendVisitorIdToHighLevel(localData.visitor_id, contactId);
        }

        // Si el _ud tiene un rkvi_id diferente al visitor_id actual,
        // significa que ese visitante se convirtió en contacto
        // Notificar al backend para vincular el historial
        if (udVisitorId && udVisitorId !== localData.visitor_id) {
          linkHistoricalVisitor(udVisitorId, contactId, userData.full_name || userData.name || 'Sin nombre');
        }

        return contactId;
      }
    } catch (e) {
      // Ignore errors
    }
    return null;
  }

  // Enviar visitor_id a HighLevel como custom field (rkvi_id)
  function sendVisitorIdToHighLevel(visitorId, contactId) {
    if (!visitorId || !contactId) return;

    // Enviar al backend para que actualice el contacto en HighLevel
    fetch(ENDPOINT.replace('/collect', '/sync-visitor'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: visitorId, contact_id: contactId }),
      keepalive: true
    }).catch(function(err) {
      // Silently fail
    });
  }

  // Vincular historial de un visitor_id previo al contacto actual
  function linkHistoricalVisitor(historicalVisitorId, contactId, fullName) {
    if (!historicalVisitorId || !contactId) return;

    // Enviar al backend para vincular TODAS las sesiones históricas
    fetch(ENDPOINT.replace('/collect', '/link-visitor'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitor_id: historicalVisitorId,
        contact_id: contactId,
        full_name: fullName
      }),
      keepalive: true
    }).catch(function(err) {
      // Silently fail
    });
  }

  // Obtener contact_id guardado
  function getContactId() {
    try {
      var localData = getLocalData();
      return localData.contact_id || null;
    } catch (e) {
      return null;
    }
  }

  // Enviar evento al servidor
  function sendEvent(eventName, additionalData) {
    var visitorId = getVisitorId();
    var sessionId = getSessionId();
    var utmParams = extractUtmParams();
    var fbCookies = getFacebookCookies();
    var browserInfo = getBrowserInfo();

    // Sincronizar contact_id de HighLevel (_ud)
    var contactId = syncHighLevelContact();
    if (!contactId) {
      contactId = getContactId(); // Usar el guardado si no hay _ud
    }

    var data = {
      url: window.location.href,
      referrer: document.referrer || null,
      title: document.title || null,
      device_type: getDeviceType(),
      browser: browserInfo.browser,
      browser_version: browserInfo.browser_version,
      os: getOS(),
      language: navigator.language || navigator.userLanguage || null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
      user_agent: navigator.userAgent
    };

    Object.assign(data, getClientIdentitySignals());

    // Agregar UTMs y click IDs
    Object.assign(data, utmParams);

    // Agregar cookies de Facebook
    if (fbCookies.fbc) data.fbc = fbCookies.fbc;
    if (fbCookies.fbp) data.fbp = fbCookies.fbp;

    // Agregar datos adicionales
    if (additionalData) {
      Object.assign(data, additionalData);
    }

    var payload = {
      visitor_id: visitorId,
      session_id: sessionId,
      contact_id: contactId, // Agregar contact_id de HighLevel
      event_name: eventName,
      ts: Date.now(),
      data: data
    };

    // Enviar con fetch
    fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(function(err) {
      // Silently fail
    });
  }

  function schedulePageView() {
    if (pageViewTimer) {
      clearTimeout(pageViewTimer);
    }
    pageViewTimer = setTimeout(trackPageView, 100);
  }

  function trackPageView() {
    pageViewTimer = null;
    var currentUrl = window.location.href;
    if (currentUrl === lastTrackedUrl) return;
    var previousUrl = lastTrackedUrl;
    lastTrackedUrl = currentUrl;
    var extraData = previousUrl ? { referrer: previousUrl } : undefined;
    sendEvent('page_view', extraData);
  }

  function setupSpaNavigationTracking() {
    var methods = ['pushState', 'replaceState'];
    for (var i = 0; i < methods.length; i++) {
      var method = methods[i];
      var original = history[method];
      if (typeof original === 'function') {
        history[method] = (function(fn) {
          return function() {
            var result = fn.apply(this, arguments);
            schedulePageView();
            return result;
          };
        })(original);
      }
    }

    window.addEventListener('popstate', schedulePageView);
    window.addEventListener('hashchange', schedulePageView);
  }

  // TRK-009: Ya NO inyectamos el visitor_id (rkvi_id) en la URL del navegador.
  // Escribirlo en la query string lo filtraba en referrers y links compartidos.
  // El visitor_id se persiste en localStorage y cookie (ver getVisitorId) y /collect
  // lo lee del body, no de la URL. Mantenemos la lectura de rkvi_id desde la URL como
  // fallback (getUrlVisitorId) para visitantes que ya lo traen en un link guardado,
  // pero NO volvemos a escribirlo en window.location.

  // TRK-009: persistir el visitor_id en cliente al cargar (sin tocar la URL).
  initMetaParamBuilder();
  getVisitorId();
  lastTrackedUrl = window.location.href;
  setupSpaNavigationTracking();

  function emitInitialEvent() {
    var eventName = isFirstPageView() ? 'session_start' : 'page_view';
    sendEvent(eventName);
    lastTrackedUrl = window.location.href;
  }

  // Enviar page_view al cargar
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(emitInitialEvent, 0);
  } else {
    document.addEventListener('DOMContentLoaded', emitInitialEvent);
  }

  // Heartbeat cada 15 segundos (opcional, comentado por defecto)
  // setInterval(function() {
  //   sendEvent('heartbeat');
  // }, 15000);

  // Enviar session_end antes de salir
  window.addEventListener('beforeunload', function() {
    sendEvent('session_end');
  });

  // Exponer función global para enviar eventos personalizados
  window.ristakTrack = function(eventName, data) {
    sendEvent(eventName, data);
  };

})();
`.trim()

    res.setHeader('Content-Type', 'application/javascript')
    res.setHeader('Cache-Control', 'public, max-age=3600') // Cache de 1 hora
    res.send(pixelCode)
  } catch (error) {
    logger.error('Error sirviendo pixel:', error)
    res.status(500).json({ error: 'Error generando pixel' })
  }
}

export async function serveMetaParamBuilderClient(req, res) {
  try {
    const bundle = await getMetaParameterBuilderClientBundle()
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable')
    res.send(bundle)
  } catch (error) {
    logger.error('Error sirviendo Meta parameter builder:', error)
    res.status(500).type('application/javascript').send('')
  }
}

export function serveMetaParamBuilderClientIp(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  res.json({ client_ip_address: getRequestIp(req) || '' })
}

/**
 * Recibe eventos del pixel
 * POST /collect
 */
export async function collectEvent(req, res) {
  try {
    const MAX_SIZE = 50 * 1024 // 50 KB

    // Verificar tamaño del body
    const contentLength = parseInt(req.headers['content-length'] || '0', 10)
    if (contentLength > MAX_SIZE) {
      return res.status(413).json({ error: 'Payload too large' })
    }

    const { visitor_id, session_id, contact_id, event_name, ts, data } = req.body

    // Validaciones básicas
    if (!visitor_id || !session_id || !event_name || !ts) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const noTrackReason = getNoTrackReason({ req, body: req.body, data })
    if (noTrackReason) {
      return res.json({ ok: true, skipped: true, reason: noTrackReason })
    }

    // Extraer IP y User-Agent del request
    let ip = null
    const xForwardedFor = req.headers['x-forwarded-for']
    if (typeof xForwardedFor === 'string' && xForwardedFor.length > 0) {
      ip = xForwardedFor.split(',')[0].trim()
    } else if (Array.isArray(xForwardedFor) && xForwardedFor.length > 0) {
      ip = xForwardedFor[0].trim()
    } else if (typeof req.headers['cf-connecting-ip'] === 'string') {
      ip = req.headers['cf-connecting-ip']
    }

    if (!ip) {
      ip =
        req.ip ||
        req.socket?.remoteAddress ||
        req.connection?.remoteAddress ||
        null
    }

    // Limpiar prefijo IPv6 (::ffff:) de IPs mapeadas
    if (ip && ip.startsWith('::ffff:')) {
      ip = ip.substring(7) // Remover "::ffff:"
    }

    const user_agent = req.headers['user-agent'] || null
    const metaSignals = collectMetaParameterSignals({
      req,
      requestMeta: {
        ip,
        userAgent: user_agent,
        meta: {
          ...(data || {}),
          pageUrl: data?.url,
          params: data || {},
          fbc: data?.fbc,
          fbp: data?.fbp
        }
      },
      sourceUrl: data?.url
    })
    setMetaParameterCookies(res, metaSignals.cookiesToSet, req)

    const enrichedData = {
      ...(data || {}),
      ...(metaSignals.fbc && !data?.fbc ? { fbc: metaSignals.fbc } : {}),
      ...(metaSignals.fbp && !data?.fbp ? { fbp: metaSignals.fbp } : {}),
      ...(metaSignals.clientIpAddress && !data?.client_ip_address ? { client_ip_address: metaSignals.clientIpAddress } : {})
    }

    // (TRK-001) /collect es público: el contact_id del body es atacante-controlado.
    // Verificar que el contacto EXISTE antes de aceptarlo. Si no existe (o es inválido),
    // ignorarlo: no se persiste en la sesión ni dispara reasignación de identidad.
    // Esto evita inyectar atribución falsa y bloquea el hijack de visitor_id vía
    // linkVisitorToContact/unifyVisitorIds desde un endpoint sin auth.
    let verifiedContactId = null
    let verifiedContactName = null
    if (contact_id) {
      try {
        const contact = await db.get('SELECT id, full_name FROM contacts WHERE id = $1', [contact_id])
        if (contact?.id) {
          verifiedContactId = contact.id
          verifiedContactName = contact.full_name || null
        } else {
          logger.warn(`/collect: contact_id inexistente ignorado: ${contact_id}`)
        }
      } catch (err) {
        // contact_id malformado (p.ej. no-UUID) hace fallar el query; ignorarlo
        logger.warn(`/collect: contact_id inválido ignorado (${contact_id}): ${err.message}`)
      }
    }

    // Extraer full_name si viene en data.contact_name (solo si el contacto fue verificado)
    let full_name = null
    if (verifiedContactId && enrichedData && enrichedData.contact_name) {
      full_name = enrichedData.contact_name
    }

    const sessionData = {
      session_id,
      visitor_id,
      contact_id: verifiedContactId,
      full_name,
      event_name,
      ts,
      data: enrichedData,
      ip,
      user_agent
    }

    // SIEMPRE crear un nuevo registro (cada visita es única)
    await createSession(sessionData)

    // (TRK-001) Solo vincular/unificar cuando el contact_id fue verificado contra la BD.
    // Si hay contact_id verificado, vincular visitor_id histórico con este contacto y unificar
    if (verifiedContactId && visitor_id) {
      // Si no viene full_name, usar el de la tabla contacts ya consultado
      if (!full_name) {
        full_name = verifiedContactName || 'Sin nombre'
      }

      // Importar funciones de tracking
      const { unifyVisitorIds } = await import('../services/trackingService.js')

      // No esperamos a que termine (async sin await) para responder rápido
      linkVisitorToContact(visitor_id, verifiedContactId, full_name)
        .then(() => {
          // Después de vincular, unificar todos los visitor_ids al más viejo
          return unifyVisitorIds(verifiedContactId)
        })
        .catch(err => {
          logger.error('Error vinculando/unificando visitor a contact:', err)
        })
    }

    // Responder rápido
    res.json({ ok: true })
  } catch (error) {
    logger.error('Error en /collect:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * Recibe eventos de reproducción de video desde Sites públicos
 * POST /video-event
 */
export async function collectVideoEvent(req, res) {
  try {
    const MAX_SIZE = 50 * 1024
    const contentLength = parseInt(req.headers['content-length'] || '0', 10)
    if (contentLength > MAX_SIZE) {
      return res.status(413).json({ error: 'Payload too large' })
    }

    const { visitor_id, session_id, event_name, ts, data } = req.body || {}
    const noTrackReason = getNoTrackReason({ req, body: req.body, data })
    if (noTrackReason) {
      return res.json({ ok: true, skipped: true, reason: noTrackReason })
    }

    if (!visitor_id || !session_id || !event_name || !ts || !data?.playback_id) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const summary = await recordVideoPlaybackEvent({
      ...req.body,
      ip: getRequestIp(req),
      user_agent: req.headers['user-agent'] || null
    })

    res.json({ ok: true, data: summary })
  } catch (error) {
    const status = error.status || 500
    logger.error('Error en /video-event:', error)
    res.status(status).json({
      error: status === 500 ? 'Internal server error' : error.message
    })
  }
}

/**
 * Sincroniza visitor_id con contacto de HighLevel
 * POST /sync-visitor
 */
export async function syncVisitorToHighLevel(req, res) {
  try {
    const { visitor_id, contact_id } = req.body

    if (!visitor_id || !contact_id) {
      return res.status(400).json({ error: 'Missing visitor_id or contact_id' })
    }

    // Obtener configuración de HighLevel
    const config = await getHighLevelConfig()

    if (!config || !config.location_id || !config.api_token) {
      logger.warn('Sin integración opcional de HighLevel; visitor_id queda guardado en Ristak')
      return res.json({ ok: false, message: 'No HighLevel config' })
    }

    // Actualizar custom field rkvi_id en HighLevel
    const response = await fetch(
      `https://services.leadconnectorhq.com/contacts/${contact_id}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${config.api_token}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28'
        },
        body: JSON.stringify({
          customFields: [
            {
              key: 'rkvi_id',
              field_value: visitor_id
            }
          ]
        })
      }
    )

    if (!response.ok) {
      const errorText = await response.text()
      logger.error(`Error actualizando rkvi_id en HighLevel: ${response.status} - ${errorText}`)
      return res.json({ ok: false, message: 'HighLevel API error' })
    }

    logger.info(`✅ visitor_id ${visitor_id} sincronizado a contacto ${contact_id} en HighLevel`)
    res.json({ ok: true })

  } catch (error) {
    logger.error('Error en /sync-visitor:', error)
    res.json({ ok: false, message: error.message })
  }
}

/**
 * Vincula un visitor_id histórico a un contacto
 * POST /link-visitor
 */
export async function linkVisitorToContactHandler(req, res) {
  try {
    const { visitor_id, contact_id, full_name } = req.body

    if (!visitor_id || !contact_id) {
      return res.status(400).json({ error: 'Missing visitor_id or contact_id' })
    }

    // Importar función de vinculación
    const { linkVisitorToContact: linkFunction } = await import('../services/trackingService.js')

    // Ejecutar vinculación
    const result = await linkFunction(visitor_id, contact_id, full_name || 'Sin nombre')

    logger.info(`✅ Vinculado visitor ${visitor_id} a contact ${contact_id} (${result.updated} registros actualizados)`)
    res.json({ ok: true, updated: result.updated })

  } catch (error) {
    logger.error('Error en /link-visitor:', error)
    res.json({ ok: false, message: error.message })
  }
}

/**
 * Obtiene sesiones con soporte para paginación infinita
 * GET /api/tracking/sessions?offset=0&limit=50
 * GET /api/tracking/sessions?start=YYYY-MM-DD&end=YYYY-MM-DD&limit=50&offset=0
 * GET /api/tracking/sessions?start=YYYY-MM-DD&end=YYYY-MM-DD&summary=1
 */
export async function getSessionsHandler(req, res) {
  try {
    const requestedLimit = Number.parseInt(req.query.limit, 10)
    const requestedOffset = Number.parseInt(req.query.offset, 10)
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 50
    const offset = Number.isFinite(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0
    const { start, end, payload, summary } = req.query

    logger.info(`📊 GET /api/tracking/sessions - start: ${start}, end: ${end}, limit: ${limit}, offset: ${offset}`)

    if (limit > LEGACY_TRACKING_SESSIONS_MAX_LIMIT) {
      logger.warn(`⚠️ Limit demasiado alto: ${limit}`)
      return res.status(400).json({ error: `Limit too high (max ${LEGACY_TRACKING_SESSIONS_MAX_LIMIT})` })
    }

    if (offset > LEGACY_TRACKING_SESSIONS_MAX_OFFSET) {
      logger.warn(`⚠️ Offset legacy demasiado profundo: ${offset}`)
      return res.status(400).json({
        error: `Offset too high (max ${LEGACY_TRACKING_SESSIONS_MAX_OFFSET}); use /api/tracking/sessions/search with cursor`
      })
    }

    // El resumen es agregado; el detalle legacy por rango también queda acotado.
    // La tabla moderna usa /sessions/search con cursor, pero ningún consumidor
    // antiguo debe poder materializar cientos de miles de eventos por accidente.
    if (start && end) {
      if (summary === '1' || summary === 'true') {
        const metrics = await getSessionMetricsByDateRange(start, end)
        return res.json(metrics)
      }

      logger.info(`🔍 Buscando sesiones entre ${start} y ${end}`)
      const sessions = await getSessionsByDateRange(start, end, { payload, limit, offset })
      logger.info(`✅ Encontradas ${sessions.length} sesiones`)
      return res.json(sessions)
    }

    // Sin fechas, usar paginación infinita
    logger.info(`🔍 Obteniendo sesiones con offset ${offset} y limit ${limit}`)

    // Query para obtener sesiones con paginación (PostgreSQL)
    const query = `
      SELECT *
      FROM sessions
      ORDER BY created_at DESC
      LIMIT $1
      OFFSET $2
    `

    const sessions = await db.all(query, [limit, offset])

    // Obtener total de sesiones para saber si hay más
    const countQuery = 'SELECT COUNT(*) as total FROM sessions'
    const countResult = await db.get(countQuery)
    const total = countResult.total || 0
    const hasMore = (offset + limit) < total

    logger.info(`✅ Encontradas ${sessions.length} sesiones (total: ${total}, hasMore: ${hasMore})`)

    res.json({
      sessions,
      total,
      offset,
      limit,
      hasMore
    })
  } catch (error) {
    logger.error('❌ Error obteniendo sesiones:', error)
    logger.error('Stack trace:', error.stack)
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    })
  }
}

/**
 * Devuelve únicamente agregados acotados para la pantalla de Analíticas.
 * POST /api/tracking/analytics/summary
 */
export async function getTrackingAnalyticsSummaryHandler(req, res) {
  // El presupuesto cubre también la adquisición de conexión y la resolución de
  // zona horaria; antes el deadline empezaba después de ambos pasos y un pool
  // saturado podía dejar el loader esperando decenas de segundos.
  const requestScope = createTrackingRequestAbortScope(res, {
    timeoutMs: TRACKING_AUXILIARY_QUERY_DEADLINE_MS
  })
  try {
    const body = req.body || {}
    const data = await getTrackingAnalyticsSummary({
      start: body.start,
      end: body.end,
      groupBy: body.groupBy,
      filters: body.filters,
      includeFacets: body.includeFacets !== false,
      allowStale: body.waitForFresh !== true,
      signal: requestScope.signal
    })

    if (requestScope.timedOut) throw trackingRequestDeadlineError()
    if (requestScope.signal.aborted || res.writableEnded || res.finished) return
    res.json({ success: true, data })
  } catch (error) {
    if (requestScope.timedOut) {
      if (res.writableEnded || res.finished) return
      res.setHeader?.('Retry-After', '1')
      return res.status(503).json({
        error: 'El resumen tardó demasiado y fue cancelado para proteger la estabilidad del CRM. Intenta nuevamente.',
        code: 'tracking_analytics_deadline',
        retryable: true
      })
    }
    if (isTrackingRequestAbort(error, requestScope.signal)) return
    const status = Number(error?.status) || 500
    logger.error(`Error obteniendo resumen acotado de tracking: ${error.message}`)
    res.status(status).json({
      error: ['tracking_analytics_deadline', 'tracking_analytics_busy'].includes(error?.code)
        ? error.message
        : status < 500
          ? error.message
          : 'Internal server error',
      ...(error?.code ? { code: error.code } : {}),
      ...(['tracking_analytics_deadline', 'tracking_analytics_busy'].includes(error?.code) ? { retryable: true } : {})
    })
  } finally {
    requestScope.cleanup()
  }
}

/**
 * Devuelve una sola faceta acotada y bajo demanda. Nunca reconstruye el juego
 * completo de dimensiones ni bloquea el resumen principal de Analíticas.
 * POST /api/tracking/analytics/facets
 */
export async function getTrackingAnalyticsFacetHandler(req, res) {
  const requestScope = createTrackingRequestAbortScope(res, {
    timeoutMs: TRACKING_AUXILIARY_QUERY_DEADLINE_MS
  })
  try {
    const body = req.body || {}
    const data = await getTrackingAnalyticsFacet({
      start: body.start,
      end: body.end,
      filters: body.filters,
      dimension: body.dimension,
      allowStale: body.waitForFresh !== true,
      signal: requestScope.signal
    })

    if (requestScope.timedOut) throw trackingRequestDeadlineError()
    if (requestScope.signal.aborted || res.writableEnded || res.finished) return
    res.json({ success: true, data })
  } catch (error) {
    if (requestScope.timedOut) {
      if (res.writableEnded || res.finished) return
      res.setHeader?.('Retry-After', '1')
      return res.status(503).json({
        error: 'La faceta tardó demasiado y fue cancelada para proteger la estabilidad del CRM. Intenta nuevamente.',
        code: 'tracking_analytics_facet_deadline',
        retryable: true
      })
    }
    if (isTrackingRequestAbort(error, requestScope.signal)) return
    const status = Number(error?.status) || 500
    const retryableCodes = ['tracking_analytics_facet_deadline', 'tracking_analytics_facet_busy']
    logger.error(`Error obteniendo faceta acotada de tracking: ${error.message}`)
    res.status(status).json({
      error: retryableCodes.includes(error?.code)
        ? error.message
        : status < 500
          ? error.message
          : 'Internal server error',
      ...(error?.code ? { code: error.code } : {}),
      ...(retryableCodes.includes(error?.code) ? { retryable: true } : {})
    })
  } finally {
    requestScope.cleanup()
  }
}

/**
 * Busca sesiones con paginación keyset; nunca calcula COUNT(*) ni devuelve el
 * histórico completo al navegador.
 * POST /api/tracking/sessions/search
 */
export async function searchTrackingSessionsHandler(req, res) {
  const requestScope = createTrackingRequestAbortScope(res, {
    timeoutMs: TRACKING_VISITOR_QUERY_DEADLINE_MS
  })
  try {
    const body = req.body || {}
    const data = await searchTrackingSessions({
      start: body.start,
      end: body.end,
      filters: body.filters,
      q: body.q,
      column: body.column,
      cursor: body.cursor,
      limit: body.limit,
      signal: requestScope.signal
    })

    if (requestScope.timedOut) throw trackingRequestDeadlineError()
    if (requestScope.signal.aborted || res.writableEnded || res.finished) return
    res.json({ success: true, data })
  } catch (error) {
    if (requestScope.timedOut) {
      if (res.writableEnded || res.finished) return
      res.setHeader?.('Retry-After', '1')
      return res.status(503).json({
        error: 'La tabla de tracking tardó demasiado y fue cancelada. Intenta nuevamente.',
        code: 'tracking_sessions_deadline',
        retryable: true
      })
    }
    if (isTrackingRequestAbort(error, requestScope.signal)) return
    const status = Number(error?.status) || 500
    logger.error(`Error buscando sesiones de tracking: ${error.message}`)
    res.status(status).json({
      error: status < 500 ? error.message : 'Internal server error'
    })
  } finally {
    requestScope.cleanup()
  }
}

/**
 * Obtiene una sesión específica
 * GET /api/tracking/sessions/:id
 */
export async function getSessionHandler(req, res) {
  try {
    const { id } = req.params

    const query = 'SELECT * FROM sessions WHERE id = $1 LIMIT 1'
    const session = await db.get(query, [id])

    if (!session) {
      return res.status(404).json({ error: 'Session not found' })
    }

    res.json({ session })
  } catch (error) {
    logger.error('Error obteniendo sesión:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * Actualiza una sesión
 * PUT /api/tracking/sessions/:id
 */
export async function updateSessionHandler(req, res) {
  try {
    const { id } = req.params
    const updates = req.body

    // Verificar que la sesión existe
    const existingSession = await db.get('SELECT * FROM sessions WHERE id = $1 LIMIT 1', [id])

    if (!existingSession) {
      return res.status(404).json({ error: 'Session not found' })
    }

    // Campos permitidos para actualizar (sin incluir id, created_at)
    const allowedFields = [
      'visitor_id', 'session_id', 'contact_id', 'full_name', 'email',
      'page_url', 'referrer_url', 'event_name', 'started_at',
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'gclid', 'fbclid', 'fbc', 'fbp', 'wbraid', 'gbraid', 'msclkid', 'ttclid',
      'channel', 'source_platform',
      'campaign_id', 'adset_id', 'ad_group_id', 'ad_id',
      'campaign_name', 'adset_name', 'ad_group_name', 'ad_name',
      'placement', 'site_source_name', 'network', 'match_type', 'keyword', 'search_query',
      'creative_id', 'ad_position',
      'ip', 'user_agent', 'device_type', 'os', 'browser', 'browser_version',
      'language', 'timezone',
      'geo_country', 'geo_region', 'geo_city', 'geo_postal_code', 'geo_lat', 'geo_lon'
    ]

    // Construir query de actualización solo con campos permitidos
    const updateFields = []
    const updateValues = []
    let paramIndex = 1

    Object.keys(updates).forEach(key => {
      if (allowedFields.includes(key)) {
        updateFields.push(`${key} = $${paramIndex}`)
        updateValues.push(updates[key])
        paramIndex++
      }
    })

    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' })
    }

    // Agregar el ID al final de los valores
    updateValues.push(id)

    const updateQuery = `
      UPDATE sessions
      SET ${updateFields.join(', ')}
      WHERE id = $${paramIndex}
    `

    await db.run(updateQuery, updateValues)
    invalidateTrackingAnalyticsCache()

    // Obtener sesión actualizada
    const updatedSession = await db.get('SELECT * FROM sessions WHERE id = $1 LIMIT 1', [id])

    logger.info(`✅ Sesión ${id} actualizada exitosamente`)

    res.json({
      success: true,
      message: 'Session updated successfully',
      session: updatedSession
    })
  } catch (error) {
    logger.error('Error actualizando sesión:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * Elimina una o múltiples sesiones
 * DELETE /api/tracking/sessions
 * Body: { ids: [id1, id2, ...] }
 */
export async function deleteSessionsHandler(req, res) {
  try {
    const { ids } = req.body

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' })
    }

    if (ids.length > 100) {
      return res.status(400).json({ error: 'Cannot delete more than 100 sessions at once' })
    }

    // Construir placeholders para PostgreSQL ($1, $2, $3...)
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',')

    const deleteQuery = `DELETE FROM sessions WHERE id IN (${placeholders})`

    const result = await db.run(deleteQuery, ids)

    // En PostgreSQL, result.changes no está disponible, usar rowCount
    const deletedCount = result.changes || result.rowCount || 0
    if (deletedCount > 0) invalidateTrackingAnalyticsCache()

    logger.info(`✅ ${deletedCount} sesiones eliminadas exitosamente`)

    res.json({
      success: true,
      message: `${deletedCount} session(s) deleted successfully`,
      deletedCount
    })
  } catch (error) {
    logger.error('Error eliminando sesiones:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * Detecta automáticamente el dominio de tracking
 * GET /api/tracking/config
 */
export async function getTrackingConfig(req, res) {
  try {
    // Esta ruta vive en AppShell, Dashboard y Analiticas. Tiene que ser una
    // lectura local: consultar HighLevel aqui hacia que el primer paint de todo
    // el CRM dependiera de la latencia/disponibilidad de un proveedor externo.
    const [
      domainConfig,
      ghlConfig,
      showAnalyticsValue,
      visitorSourceValue,
      metaConfig,
      includeMetaPixelPref,
      publicSitesRow,
      storedSyncState
    ] = await Promise.all([
      getTrackingDomainConfig(),
      getHighLevelConfig(),
      getAppConfig('show_analytics'),
      getAppConfig('visitor_source'),
      getMetaConfig().catch(() => null),
      getAppConfig('include_meta_pixel'),
      db.get("SELECT COUNT(*) as total FROM public_sites WHERE status = 'published'")
        .catch(() => ({ total: 0 })),
      getAppConfig(TRACKING_GHL_SYNC_STATE_CONFIG_KEY)
    ])
    const { trackingDomain, trackingDomainVerified } = domainConfig
    const serviceBaseUrl = resolvePublicServiceBaseUrl(req, getTrackingPublicFallbacks())
    const serviceDomain = normalizePublicHost(serviceBaseUrl)

    // Leer preferencia de Analytics desde app_config (independiente de HighLevel)
    const showAnalytics = showAnalyticsValue === '1' || showAnalyticsValue === 1 || showAnalyticsValue === true

    // Leer preferencia de fuente de visitantes
    const visitorSource = visitorSourceValue || 'platform'

    // Verificar si hay Meta Pixel configurado
    const hasMetaPixel = !!(metaConfig && metaConfig.pixel_id)
    const includeMetaPixel = includeMetaPixelPref === null || includeMetaPixelPref === undefined
      ? true
      : (includeMetaPixelPref === '1' || includeMetaPixelPref === 1 || includeMetaPixelPref === true || includeMetaPixelPref === 'true')
    const hasPublicSites = Number(publicSitesRow?.total || 0) > 0
    const trackingSnippet = trackingDomainVerified && trackingDomain
      ? buildTrackingSnippet({
        trackingDomain,
        metaPixelId: hasMetaPixel ? metaConfig.pixel_id : null,
        includeMetaPixel
      })
      : null
    let syncState = null
    try {
      syncState = typeof storedSyncState === 'string'
        ? JSON.parse(storedSyncState)
        : storedSyncState
    } catch {
      syncState = null
    }
    const snippetHash = trackingSnippet
      ? createHash('sha256').update(trackingSnippet).digest('hex')
      : ''
    const isConfigured = Boolean(
      trackingSnippet &&
      ghlConfig?.location_id &&
      syncState?.locationId === String(ghlConfig.location_id) &&
      syncState?.domain === trackingDomain &&
      syncState?.snippetHash === snippetHash
    )

    res.json({
      trackingDomain,
      trackingDomainVerified,
      trackingDomainCheckedAt: domainConfig.trackingDomainCheckedAt,
      trackingDomainError: domainConfig.trackingDomainError,
      serviceDomain,
      serviceBaseUrl,
      isConfigured,
      hasHighLevel: !!(ghlConfig && ghlConfig.location_id && ghlConfig.api_token),
      showAnalytics,
      visitorSource,
      hasMetaPixel,
      hasPublicSites,
      metaPixelId: hasMetaPixel ? metaConfig.pixel_id : null,
      includeMetaPixel,
      trackingSnippet
    })
  } catch (error) {
    logger.error('Error obteniendo configuración de tracking:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * Valida y guarda el dominio que servirá el pixel de tracking.
 * POST /api/tracking/domain/verify
 */
export async function verifyTrackingDomainHandler(req, res) {
  try {
    const result = await verifyAndSaveTrackingDomain(req.body?.domain)
    res.json(result)
  } catch (error) {
    logger.error('Error verificando dominio de tracking:', error)
    res.status(500).json({ error: 'No se pudo verificar el dominio de tracking' })
  }
}

/**
 * Configura automáticamente el tracking en HighLevel
 * POST /api/tracking/configure
 */
export async function configureTracking(req, res) {
  try {
    // Obtener configuración de HighLevel
    const ghlConfig = await getHighLevelConfig()

    if (!ghlConfig || !ghlConfig.location_id || !ghlConfig.api_token) {
      return res.status(400).json({
        error: 'La sincronización opcional con HighLevel no está configurada. El tracking de Ristak puede operar con su configuración local.'
      })
    }

    const domainConfig = await getTrackingDomainConfig()
    const trackingDomain = domainConfig.trackingDomainVerified
      ? domainConfig.trackingDomain
      : ''

    if (!trackingDomain) {
      return res.status(400).json({
        error: 'Valida un dominio de rastreo antes de sincronizar el pixel'
      })
    }

    // Obtener configuración de Meta para incluir Pixel si está configurado
    const metaConfig = await getMetaConfig().catch(() => null)
    const hasMetaPixel = metaConfig && metaConfig.pixel_id

    // Leer preferencia del usuario: ¿quiere incluir Meta Pixel en el snippet?
    // Default: true (ON por default)
    const includeMetaPixelPref = await getAppConfig('include_meta_pixel')
    const includeMetaPixel = includeMetaPixelPref === null || includeMetaPixelPref === undefined
      ? true // Default: ON
      : (includeMetaPixelPref === '1' || includeMetaPixelPref === 1 || includeMetaPixelPref === true || includeMetaPixelPref === 'true')

    // Generar el snippet con versión para evitar cache.
    // Si hay Meta Pixel configurado Y el usuario quiere incluirlo, agregar el código del pixel.
    const snippet = buildTrackingSnippet({
      trackingDomain,
      metaPixelId: hasMetaPixel ? metaConfig.pixel_id : null,
      includeMetaPixel
    })

    if (hasMetaPixel && includeMetaPixel) {
      logger.info(`Agregando Meta Pixel (${metaConfig.pixel_id}) al snippet`)
    }

    // Log informativo
    let logMsg = `Configurando tracking en HighLevel para dominio: ${trackingDomain}`
    if (hasMetaPixel && includeMetaPixel) {
      logMsg += ` (con Meta Pixel ${metaConfig.pixel_id})`
    } else if (hasMetaPixel && !includeMetaPixel) {
      logMsg += ` (Meta Pixel disponible pero DESACTIVADO por preferencia del usuario)`
    } else {
      logMsg += ` (sin Meta Pixel configurado)`
    }
    logger.info(logMsg)

    // Primero verificar si el custom value ya existe
    try {
      // Obtener custom values existentes
      const getResponse = await fetch(
        `https://services.leadconnectorhq.com/locations/${ghlConfig.location_id}/customValues`,
        {
          headers: {
            'Authorization': `Bearer ${ghlConfig.api_token}`,
            'Version': '2021-07-28'
          }
        }
      )

      let existingCustomValue = null
      if (getResponse.ok) {
        const data = await getResponse.json()
        existingCustomValue = data.customValues?.find(cv => cv.name === 'rstktrack')
      }

      let response
      if (existingCustomValue) {
        // Ya existe - hacer PUT (actualizar)
        logger.info(`Custom value 'rstktrack' ya existe (ID: ${existingCustomValue.id}), actualizando...`)
        response = await fetch(
          `https://services.leadconnectorhq.com/locations/${ghlConfig.location_id}/customValues/${existingCustomValue.id}`,
          {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${ghlConfig.api_token}`,
              'Content-Type': 'application/json',
              'Version': '2021-07-28'
            },
            body: JSON.stringify({
              name: 'rstktrack',
              value: snippet
            })
          }
        )
      } else {
        // No existe - hacer POST (crear)
        logger.info(`Custom value 'rstktrack' no existe, creando...`)
        response = await fetch(
          `https://services.leadconnectorhq.com/locations/${ghlConfig.location_id}/customValues`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${ghlConfig.api_token}`,
              'Content-Type': 'application/json',
              'Version': '2021-07-28'
            },
            body: JSON.stringify({
              name: 'rstktrack',
              value: snippet
            })
          }
        )
      }

      if (!response.ok) {
        const errorData = await response.json()
        logger.error('Error creando/actualizando custom value en HighLevel:', errorData)
        return res.status(500).json({
          error: 'No se pudo configurar el tracking en HighLevel',
          details: errorData
        })
      }

      logger.success(`Custom value 'rstktrack' ${existingCustomValue ? 'actualizado' : 'creado'} en HighLevel`)

      // Persistimos la evidencia local solo despues de que el proveedor acepta
      // el PUT/POST. Las lecturas normales comparan dominio, location y hash del
      // snippet sin volver a sacar la app a internet.
      await setAppConfig(TRACKING_GHL_SYNC_STATE_CONFIG_KEY, JSON.stringify({
        locationId: String(ghlConfig.location_id),
        domain: trackingDomain,
        snippetHash: createHash('sha256').update(snippet).digest('hex'),
        syncedAt: new Date().toISOString()
      }))

      res.json({
        success: true,
        message: 'Tracking configurado correctamente en HighLevel',
        snippet,
        instructions: 'Ahora agrega {{ custom_values.rstktrack }} en el <head> de tu sitio web en HighLevel'
      })
    } catch (error) {
      logger.error('Error llamando API de HighLevel:', error)
      return res.status(500).json({
        error: 'Error comunicándose con HighLevel',
        details: error.message
      })
    }
  } catch (error) {
    logger.error('Error configurando tracking:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * Guardar preferencia de mostrar/ocultar Analytics
 * POST /api/tracking/analytics-preference
 */
export async function setAnalyticsPreference(req, res) {
  try {
    const { showAnalytics } = req.body

    if (typeof showAnalytics !== 'boolean') {
      return res.status(400).json({ error: 'showAnalytics debe ser un booleano' })
    }

    // Guardar en app_config (independiente de HighLevel)
    await setAppConfig('show_analytics', showAnalytics ? '1' : '0')

    logger.info(`Preferencia de Analytics actualizada a: ${showAnalytics}`)

    res.json({ success: true, showAnalytics })
  } catch (error) {
    logger.error('Error guardando preferencia de Analytics:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * Guardar preferencia de fuente de visitantes
 * POST /api/tracking/visitor-source-preference
 */
export async function setVisitorSourcePreference(req, res) {
  try {
    const { visitorSource } = req.body

    if (!['platform', 'tracking'].includes(visitorSource)) {
      return res.status(400).json({ error: 'visitorSource debe ser "platform" o "tracking"' })
    }

    // Guardar en app_config
    await setAppConfig('visitor_source', visitorSource)

    logger.info(`Preferencia de fuente de visitantes actualizada a: ${visitorSource}`)

    res.json({ success: true, visitorSource })
  } catch (error) {
    logger.error('Error guardando preferencia de visitor source:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * Obtener visitantes únicos por ad_id desde sessions
 * GET /api/tracking/visitors-by-ad?startDate=&endDate=
 */
export async function getVisitorsByAd(req, res) {
  try {
    const { startDate, endDate } = req.query

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate y endDate son requeridos' })
    }

    // Usar timezone de HighLevel para consistencia con Dashboard
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })

    logger.info(`Obteniendo visitantes por ad - rango: ${range.startUtc} -> ${range.endUtc}`)

    // Query PostgreSQL
    const query = `
      SELECT
        ad_id,
        COUNT(DISTINCT ${getVisitorIdentityExpression()}) as unique_visitors,
        COUNT(*) as total_pageviews
      FROM sessions
      WHERE ad_id IS NOT NULL
        AND started_at >= $1
        AND started_at <= $2
      GROUP BY ad_id
    `

    // (MET-CONSIST) Los badges de ADSET y CAMPAÑA NO pueden ser la suma de los
    // únicos-por-ad: un visitante que tocó 2+ anuncios del mismo adset/campaña se
    // contaría varias veces. El modal (getVisitorsList) hace COUNT(DISTINCT) sobre
    // todo el grupo, así que aquí calculamos el mismo DISTINCT agrupado por adset_id
    // y campaign_id (mismo WHERE started_at en rango). Además esto incluye sesiones
    // con adset_id/campaign_id pero ad_id NULL, que el modal ya listaba y el badge
    // basado en suma-por-ad nunca contaba.
    const adsetQuery = `
      SELECT
        adset_id,
        COUNT(DISTINCT ${getVisitorIdentityExpression()}) as unique_visitors
      FROM sessions
      WHERE adset_id IS NOT NULL
        AND started_at >= $1
        AND started_at <= $2
      GROUP BY adset_id
    `

    const campaignQuery = `
      SELECT
        campaign_id,
        COUNT(DISTINCT ${getVisitorIdentityExpression()}) as unique_visitors
      FROM sessions
      WHERE campaign_id IS NOT NULL
        AND started_at >= $1
        AND started_at <= $2
      GROUP BY campaign_id
    `

    const [visitors, adsetRows, campaignRows] = await Promise.all([
      db.all(query, [range.startUtc, range.endUtc]),
      db.all(adsetQuery, [range.startUtc, range.endUtc]),
      db.all(campaignQuery, [range.startUtc, range.endUtc])
    ])

    logger.info(`Visitantes por ad obtenidos: ${visitors.length} ads, ${adsetRows.length} adsets, ${campaignRows.length} campañas con visitas`)

    // Crear un mapa de ad_id -> visitantes
    const visitorsByAd = {}
    visitors.forEach(row => {
      visitorsByAd[row.ad_id] = {
        uniqueVisitors: parseInt(row.unique_visitors) || 0,
        totalPageviews: parseInt(row.total_pageviews) || 0
      }
    })

    // Mapas de únicos deduplicados a nivel adset y campaña (para los badges).
    const byAdset = {}
    adsetRows.forEach(row => {
      byAdset[row.adset_id] = parseInt(row.unique_visitors) || 0
    })

    const byCampaign = {}
    campaignRows.forEach(row => {
      byCampaign[row.campaign_id] = parseInt(row.unique_visitors) || 0
    })

    res.json({ success: true, data: visitorsByAd, byAdset, byCampaign })
  } catch (error) {
    logger.error('Error obteniendo visitantes por ad:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

// Obtener visitantes agrupados por período
export async function getVisitorsByPeriod(req, res) {
  try {
    const { startDate, endDate, groupBy = 'day', scope = 'all' } = req.query

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' })
    }

    // Usar timezone de HighLevel para consistencia con Dashboard
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })

    logger.info(`Obteniendo visitantes por período - rango: ${range.startUtc} -> ${range.endUtc}, groupBy: ${groupBy}, scope: ${scope}`)

    // Determinar lógica de atribución (MISMA LÓGICA QUE buildReportMetrics)
    const useContactAttribution = scope === 'campaigns' || scope === 'attributed' || scope === 'attribution'
    const isAttributed = scope === 'campaigns' || scope === 'attributed'

    // Obtener filtro de contactos ocultos (solo necesario para vistas con atribución)
    const hiddenFilters = await getHiddenContactFilters()
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)

    if (!['day', 'week', 'month', 'year'].includes(groupBy)) {
      return res.status(400).json({ error: 'Invalid groupBy value' })
    }

    const buildWeekExpression = (column) => {
      if (!isPostgres) {
        // TRK-008: usa el offset real de la zona aplicada en vez del -6h hardcodeado.
        return `strftime('%Y-W%W', datetime(${column}, ${sqliteTimezoneOffsetClause(range.appliedTimezone)}))`
      }
      const columnExpr = timestampLocalExpression(column, range.appliedTimezone)
      return `TO_CHAR(${columnExpr}, 'YYYY-"W"IW')`
    }

    const groupExpression = groupBy === 'week'
      ? buildWeekExpression(useContactAttribution ? 'c.created_at' : 's.started_at')
      : getGroupExpression(useContactAttribution ? 'c.created_at' : 's.started_at', groupBy, range.appliedTimezone)

    const params = [range.startUtc, range.endUtc]
    const conditions = useContactAttribution
      ? ['c.created_at >= ?', 'c.created_at <= ?']
      : ['s.started_at >= ?', 's.started_at <= ?']

    if (useContactAttribution && hiddenCondition) {
      conditions.push(hiddenCondition)
    }

    if (useContactAttribution && isAttributed) {
      conditions.push('c.attribution_ad_id IS NOT NULL')
      conditions.push(`EXISTS (
        SELECT 1 FROM meta_ads ma
        WHERE ma.ad_id = c.attribution_ad_id
          AND ${metaAdsSameLocalDayCondition('ma.date', 'c.created_at', range.appliedTimezone)}
      )`)
    }

    const query = useContactAttribution
      ? `
        SELECT
          ${groupExpression} as period,
          COUNT(DISTINCT ${getVisitorIdentityExpression('s')}) as unique_visitors
        FROM sessions s
        INNER JOIN contacts c ON c.id = s.contact_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY period
        ORDER BY period ASC
      `
      : `
        SELECT
          ${groupExpression} as period,
          COUNT(DISTINCT ${getVisitorIdentityExpression('s')}) as unique_visitors
        FROM sessions s
        WHERE ${conditions.join(' AND ')}
        GROUP BY period
        ORDER BY period ASC
      `

    const rows = await db.all(query, params)

    logger.info(`Visitantes por período obtenidos: ${rows.length} períodos con visitas (scope: ${scope})`)

    // Convertir a objeto con período como clave
    const visitorsByPeriod = {}
    rows.forEach(row => {
      visitorsByPeriod[row.period] = parseInt(row.unique_visitors) || 0
    })

    res.json({ success: true, data: visitorsByPeriod })
  } catch (error) {
    logger.error('Error obteniendo visitantes por período:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * Obtener lista detallada de visitantes por ad/campaign/adset
 * GET /api/tracking/visitors?startDate=&endDate=&ad_id=&campaign_id=&adset_id=&scope=
 */
export async function getVisitorsList(req, res) {
  const requestScope = createTrackingRequestAbortScope(res, {
    timeoutMs: TRACKING_VISITOR_QUERY_DEADLINE_MS
  })
  try {
    const {
      startDate,
      endDate,
      ad_id,
      campaign_id,
      adset_id,
      scope,
      cursor,
      limit,
      search,
      q
    } = req.query || {}

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate y endDate son requeridos' })
    }

    const pageLimit = normalizeTrackingDrilldownLimit(limit)
    const normalizedSearch = normalizeTrackingDrilldownSearch(search ?? q)
    if (normalizedSearch && normalizedSearch.length < 3) {
      return res.json({
        success: true,
        data: [],
        pagination: {
          limit: pageLimit,
          hasNext: false,
          hasMore: false,
          nextCursor: null,
          searchMinLength: 3
        }
      })
    }
    const range = await resolveDateRangeWithGHLTimezone({
      startDate,
      endDate,
      signal: requestScope.signal
    })

    logger.info(`Obteniendo página de visitantes - rango: ${range.startUtc} -> ${range.endUtc}, scope: ${scope}, limit: ${pageLimit}`)

    const rangeStartUtcDateTime = range.startZoned?.toUTC()
    const rangeEndExclusiveUtcDateTime = range.endZoned?.plus({ milliseconds: 1 }).toUTC()
    const endExclusiveUtc = rangeEndExclusiveUtcDateTime
      ? rangeEndExclusiveUtcDateTime.toISO({ suppressMilliseconds: false })
      : range.endUtc
    const projectionQuarterAligned = Boolean(
      rangeStartUtcDateTime &&
      rangeEndExclusiveUtcDateTime &&
      rangeStartUtcDateTime.minute % 15 === 0 &&
      rangeEndExclusiveUtcDateTime.minute % 15 === 0 &&
      rangeStartUtcDateTime.second === 0 &&
      rangeEndExclusiveUtcDateTime.second === 0 &&
      rangeStartUtcDateTime.millisecond === 0 &&
      rangeEndExclusiveUtcDateTime.millisecond === 0
    )
    const startUtcDay = rangeStartUtcDateTime?.startOf('day')
    const firstFullUtcDay = startUtcDay && rangeStartUtcDateTime.toMillis() === startUtcDay.toMillis()
      ? startUtcDay
      : startUtcDay?.plus({ days: 1 })
    const fullUtcDaysEnd = rangeEndExclusiveUtcDateTime?.startOf('day')
    const rangeStartUtcMillis = rangeStartUtcDateTime?.toMillis() ?? Date.parse(range.startUtc)
    const rangeEndExclusiveUtcMillis = rangeEndExclusiveUtcDateTime?.toMillis() ?? Date.parse(endExclusiveUtc)
    const firstFullUtcDayMillis = firstFullUtcDay?.toMillis() ?? rangeEndExclusiveUtcMillis
    const fullUtcDaysEndMillis = fullUtcDaysEnd?.toMillis() ?? rangeStartUtcMillis
    const fullDayWindowStartMillis = Math.min(
      rangeEndExclusiveUtcMillis,
      Math.max(rangeStartUtcMillis, firstFullUtcDayMillis)
    )
    const fullDayWindowEndMillis = Math.min(
      rangeEndExclusiveUtcMillis,
      Math.max(rangeStartUtcMillis, fullUtcDaysEndMillis)
    )
    const hasFullUtcDayWindow = fullDayWindowStartMillis < fullDayWindowEndMillis
    const fullDayWindowStartIso = new Date(fullDayWindowStartMillis).toISOString()
    const fullDayWindowEndIso = new Date(fullDayWindowEndMillis).toISOString()
    const quarterBucketRanges = hasFullUtcDayWindow
      ? [
          ...(rangeStartUtcMillis < fullDayWindowStartMillis
            ? [{ start: range.startUtc, end: fullDayWindowStartIso }]
            : []),
          ...(fullDayWindowEndMillis < rangeEndExclusiveUtcMillis
            ? [{ start: fullDayWindowEndIso, end: endExclusiveUtc }]
            : [])
        ]
      : [{ start: range.startUtc, end: endExclusiveUtc }]
    const useContactAttribution = scope === 'campaigns' || scope === 'attributed' || scope === 'attribution'
    const isAttributed = scope === 'campaigns' || scope === 'attributed'
    const hiddenFilters = await getHiddenContactFilters({ signal: requestScope.signal })
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
    const visitorAttributionMode = isAttributed
      ? 'attributed'
      : useContactAttribution
        ? 'attribution'
        : 'all'
    const visitorScopeType = !useContactAttribution && ad_id
      ? 'ad'
      : !useContactAttribution && adset_id
        ? 'adset'
        : !useContactAttribution && campaign_id
          ? 'campaign'
          : 'all'
    const visitorScopeId = visitorScopeType === 'ad'
      ? String(ad_id)
      : visitorScopeType === 'adset'
        ? String(adset_id)
        : visitorScopeType === 'campaign'
          ? String(campaign_id)
          : ''
    const cursorScope = trackingDrilldownCursorScope('tracking-visitors', {
      startUtc: range.startUtc,
      endExclusiveUtc,
      timezone: range.appliedTimezone,
      attributionMode: visitorAttributionMode,
      filterType: visitorScopeType,
      filterId: visitorScopeId,
      search: normalizedSearch.toLocaleLowerCase('es-MX'),
      hiddenCondition: useContactAttribution ? String(hiddenCondition || '') : ''
    })
    const decodedCursor = decodeTrackingDrilldownCursor(cursor, 'tracking-visitors', cursorScope)
    const visitorIdentityExpression = getVisitorIdentityExpression('s')
    const visitorSelect = `
      s.visitor_id,
      s.session_id,
      s.contact_id,
      s.created_at,
      s.page_url,
      s.referrer_url,
      s.utm_source,
      s.utm_medium,
      s.utm_campaign,
      s.utm_term,
      s.utm_content,
      s.gclid,
      s.fbclid,
      s.device_type,
      s.browser,
      s.os,
      s.language,
      s.ad_id,
      s.ad_name,
      s.adset_id,
      s.adset_name,
      s.campaign_id,
      s.campaign_name,
      s.msclkid,
      s.ttclid,
      s.timezone,
      s.geo_country,
      s.geo_region,
      s.geo_city,
      c.full_name as contact_name,
      c.email as contact_email,
      c.phone as contact_phone,
      c.total_paid as contact_ltv,
      c.purchases_count as contact_purchases
    `
    let query
    let pageParams
    let visitorCoverage = null
    let boundedProjectionSearch = false
    let projectionSearchCandidateLimit = 0

    if (useContactAttribution) {
      if (decodedCursor && decodedCursor.mode !== 'contact-created') {
        throw trackingDrilldownRequestError('El cursor ya no corresponde a esta vista; vuelve a la primera página')
      }

      const contactCursorSortExpression = trackingContactCursorSortExpression('c')
      const contactConditions = ['c.created_at >= ?', 'c.created_at < ?']
      const contactParams = [range.startUtc, endExclusiveUtc]
      if (hiddenCondition) contactConditions.push(hiddenCondition)
      if (isAttributed) {
        contactConditions.push('c.attribution_ad_id IS NOT NULL')
        contactConditions.push(`EXISTS (
          SELECT 1 FROM meta_ads ma
          WHERE ma.ad_id = c.attribution_ad_id
            AND ${metaAdsSameLocalDayCondition('ma.date', 'c.created_at', range.appliedTimezone)}
        )`)
      }

      const cursorCondition = decodedCursor
        ? `AND (${contactCursorSortExpression}, c.id) < (?, ?)`
        : ''
      const cursorParams = decodedCursor ? [decodedCursor.createdAt, decodedCursor.id] : []
      if (normalizedSearch) {
        const pattern = trackingDrilldownSearchPattern(normalizedSearch)
        // Cada fuente de búsqueda recorre como máximo una ventana ordenada. El
        // cursor continúa desde el último contacto y permite seguir buscando
        // sin materializar todos los contactos/sesiones que coincidan.
        const attributedSearchCandidateLimit = TRACKING_VISITOR_SEARCH_CANDIDATE_LIMIT + 1
        const sessionSearchHits = isPostgres
          ? `
            session_search_deduplicated AS MATERIALIZED (
              SELECT DISTINCT ON (s.contact_id)
                s.contact_id,
                ${contactCursorSortExpression} AS contact_created_at,
                s.id AS session_row_id
              FROM sessions s
              INNER JOIN contacts c ON c.id = s.contact_id
              WHERE s.contact_id IS NOT NULL
                AND ${buildTrackingSearchDocumentExpression('s')} LIKE ? ESCAPE '!'
                AND ${contactConditions.join(' AND ')}
                ${cursorCondition}
              ORDER BY s.contact_id, s.created_at DESC, s.id DESC
            ),
            session_search_hits AS MATERIALIZED (
              SELECT contact_id, contact_created_at, session_row_id
              FROM session_search_deduplicated
              ORDER BY contact_created_at DESC, contact_id DESC
              LIMIT ?
            )
          `
          : `
            session_search_candidates AS (
              SELECT
                s.contact_id,
                ${contactCursorSortExpression} AS contact_created_at,
                s.id AS session_row_id,
                ROW_NUMBER() OVER (
                  PARTITION BY s.contact_id
                  ORDER BY s.created_at DESC, s.id DESC
                ) AS contact_session_rank
              FROM sessions s
              INNER JOIN contacts c ON c.id = s.contact_id
              WHERE s.contact_id IS NOT NULL
                AND ${buildTrackingSearchDocumentExpression('s')} LIKE ? ESCAPE '!'
                AND ${contactConditions.join(' AND ')}
                ${cursorCondition}
            ),
            session_search_hits AS (
              SELECT contact_id, contact_created_at, session_row_id
              FROM session_search_candidates
              WHERE contact_session_rank = 1
              ORDER BY contact_created_at DESC, contact_id DESC
              LIMIT ?
            )
          `

        query = `
          WITH contact_search_hits AS MATERIALIZED (
            SELECT c.id, ${contactCursorSortExpression} AS contact_created_at
            FROM contacts c
            WHERE ${trackingContactSearchDocumentExpression('c')} LIKE ? ESCAPE '!'
              AND ${contactConditions.join(' AND ')}
              ${cursorCondition}
            ORDER BY ${contactCursorSortExpression} DESC, c.id DESC
            LIMIT ?
          ),
          contact_search_candidates AS (
            SELECT
              contact_hit.id AS contact_id,
              contact_hit.contact_created_at,
              (
                SELECT candidate.id
                FROM sessions candidate
                WHERE candidate.contact_id = contact_hit.id
                ORDER BY candidate.created_at DESC, candidate.id DESC
                LIMIT 1
              ) AS session_row_id
            FROM contact_search_hits contact_hit
          ),
          ${sessionSearchHits},
          search_candidates AS (
            SELECT contact_id, contact_created_at, session_row_id
            FROM contact_search_candidates
            WHERE session_row_id IS NOT NULL
            UNION ALL
            SELECT
              session_hit.contact_id,
              session_hit.contact_created_at,
              session_hit.session_row_id
            FROM session_search_hits session_hit
            WHERE NOT EXISTS (
              SELECT 1
              FROM contact_search_hits contact_hit
              WHERE contact_hit.id = session_hit.contact_id
            )
          ),
          paged_contacts AS (
            SELECT contact_id, contact_created_at, session_row_id
            FROM search_candidates
            ORDER BY contact_created_at DESC, contact_id DESC
            LIMIT ?
          )
          SELECT
            ${visitorIdentityExpression} as visitor_key,
            s.id as session_row_id,
            c.id as cursor_row_id,
            page.contact_created_at as cursor_at,
            ${trackingCursorTimestampProjection('page.contact_created_at')} as cursor_serialized_at,
            'contact-created' as cursor_mode,
            ${visitorSelect}
          FROM paged_contacts page
          INNER JOIN contacts c ON c.id = page.contact_id
          INNER JOIN sessions s ON s.id = page.session_row_id
          ORDER BY page.contact_created_at DESC, page.contact_id DESC
        `
        pageParams = [
          pattern,
          ...contactParams,
          ...cursorParams,
          attributedSearchCandidateLimit,
          pattern,
          ...contactParams,
          ...cursorParams,
          attributedSearchCandidateLimit,
          pageLimit + 1
        ]
      } else {
        query = `
          SELECT
            ${visitorIdentityExpression} as visitor_key,
            s.id as session_row_id,
            c.id as cursor_row_id,
            ${contactCursorSortExpression} as cursor_at,
            ${trackingCursorTimestampProjection(contactCursorSortExpression)} as cursor_serialized_at,
            'contact-created' as cursor_mode,
            ${visitorSelect}
          FROM contacts c
          INNER JOIN sessions s ON s.id = (
            SELECT candidate.id
            FROM sessions candidate
            WHERE candidate.contact_id = c.id
            ORDER BY candidate.created_at DESC, candidate.id DESC
            LIMIT 1
          )
          WHERE ${contactConditions.join(' AND ')}
            ${cursorCondition}
          ORDER BY ${contactCursorSortExpression} DESC, c.id DESC
          LIMIT ?
        `
        pageParams = [...contactParams, ...cursorParams, pageLimit + 1]
      }
    } else {
      if (decodedCursor && decodedCursor.mode !== 'projection-started') {
        throw trackingDrilldownRequestError('El cursor ya no corresponde a esta vista; vuelve a la primera página')
      }

      const projectionStatus = await getTrackingVisitorProjectionStatus({
        schedule: true,
        signal: requestScope.signal
      })
      visitorCoverage = trackingVisitorProjectionCoverage(projectionStatus, {
        rangeQuarterAligned: projectionQuarterAligned,
        search: normalizedSearch
      })
      if (!projectionStatus.available) {
        // No responder con cobertura parcial ni volver al ROW_NUMBER() sobre
        // todo sessions. Ese fallback convertía una simple página en un sort
        // histórico sin límite y podía tumbar PostgreSQL durante el rollout.
        // sessions/search sigue disponible con keyset; esta vista de identidades
        // reintenta cuando el read model exacto haya terminado de calentarse.
        throw trackingProjectionWarmingError(visitorCoverage)
      } else {
        const projectionScopeType = visitorScopeType
        const projectionScopeId = visitorScopeId
        boundedProjectionSearch = Boolean(normalizedSearch)
        projectionSearchCandidateLimit = boundedProjectionSearch
          ? TRACKING_VISITOR_SEARCH_CANDIDATE_LIMIT
          : pageLimit

        const buildProjectionBranch = ({ bucketKind, bucketStart, bucketEnd }) => {
          const cursorAtMillis = decodedCursor ? Date.parse(decodedCursor.createdAt) : null
          const branchEndMillis = Date.parse(bucketEnd)
          const conditions = [
            'current.scope_type = ?',
            'current.scope_id = ?',
            'current.bucket_kind = ?',
            'current.latest_at >= ?',
            'current.latest_at < ?',
            'current.bucket_start >= ?',
            'current.bucket_start < ?'
          ]
          const params = [
            projectionScopeType,
            projectionScopeId,
            bucketKind,
            bucketStart,
            bucketEnd,
            bucketStart,
            bucketEnd
          ]

          // Si el cursor está después de todo este bucket-range, la rama
          // completa ya pertenece a la página siguiente. Incluir una tupla de
          // cursor redundante hace que PostgreSQL arranque el índice desde el
          // cursor global y atraviese todos los buckets interiores antes de
          // llegar al borde. Sólo se aplica dentro de la rama que realmente lo
          // contiene.
          if (decodedCursor && cursorAtMillis < branchEndMillis) {
            conditions.push('(current.latest_at, current.session_row_id) < (?, ?)')
            params.push(decodedCursor.createdAt, decodedCursor.id)
          }
          if (hasFullUtcDayWindow) {
            conditions.push(`NOT EXISTS (
              SELECT 1
              FROM tracking_visitor_latest newer_day
              WHERE newer_day.scope_type = current.scope_type
                AND newer_day.scope_id = current.scope_id
                AND newer_day.bucket_kind = 'day'
                AND newer_day.visitor_key = current.visitor_key
                AND newer_day.latest_at >= ?
                AND newer_day.latest_at < ?
                AND newer_day.bucket_start >= ?
                AND newer_day.bucket_start < ?
                AND (newer_day.latest_at, newer_day.session_row_id) >
                    (current.latest_at, current.session_row_id)
            )`)
            params.push(
              range.startUtc,
              endExclusiveUtc,
              fullDayWindowStartIso,
              fullDayWindowEndIso
            )
          }
          if (quarterBucketRanges.length > 0) {
            const newerQuarterBucketCondition = quarterBucketRanges
              .map(() => '(newer_quarter.bucket_start >= ? AND newer_quarter.bucket_start < ?)')
              .join(' OR ')
            conditions.push(`NOT EXISTS (
              SELECT 1
              FROM tracking_visitor_latest newer_quarter
              WHERE newer_quarter.scope_type = current.scope_type
                AND newer_quarter.scope_id = current.scope_id
                AND newer_quarter.bucket_kind = 'quarter'
                AND newer_quarter.visitor_key = current.visitor_key
                AND newer_quarter.latest_at >= ?
                AND newer_quarter.latest_at < ?
                AND (${newerQuarterBucketCondition})
                AND (newer_quarter.latest_at, newer_quarter.session_row_id) >
                    (current.latest_at, current.session_row_id)
            )`)
            params.push(range.startUtc, endExclusiveUtc)
            for (const rangeBounds of quarterBucketRanges) {
              params.push(rangeBounds.start, rangeBounds.end)
            }
          }
          params.push(projectionSearchCandidateLimit + 1)

          return {
            sql: `
              SELECT current.visitor_key, current.session_row_id, current.latest_at
              FROM tracking_visitor_latest current
              WHERE ${conditions.join(' AND ')}
              ORDER BY current.latest_at DESC, current.session_row_id DESC
              LIMIT ?
            `,
            params
          }
        }

        const cursorAtMillis = decodedCursor ? Date.parse(decodedCursor.createdAt) : null
        const branchDefinitions = [
          ...(hasFullUtcDayWindow
            ? [{
                name: 'day_page',
                bucketKind: 'day',
                bucketStart: fullDayWindowStartIso,
                bucketEnd: fullDayWindowEndIso
              }]
            : []),
          ...quarterBucketRanges.map((rangeBounds, index) => ({
            name: `quarter_page_${index + 1}`,
            bucketKind: 'quarter',
            bucketStart: rangeBounds.start,
            bucketEnd: rangeBounds.end
          }))
        ]
        const projectionBranches = branchDefinitions
          .filter(branch => !decodedCursor || cursorAtMillis >= Date.parse(branch.bucketStart))
          .map(branch => ({
            name: branch.name,
            ...buildProjectionBranch(branch)
          }))
        if (projectionBranches.length === 0) {
          projectionBranches.push({
            name: 'empty_page',
            sql: `
              SELECT current.visitor_key, current.session_row_id, current.latest_at
              FROM tracking_visitor_latest current
              WHERE 1 = 0
            `,
            params: []
          })
        }
        const searchPattern = boundedProjectionSearch
          ? trackingDrilldownSearchPattern(normalizedSearch)
          : null
        const boundedSearchProjection = boundedProjectionSearch
          ? `CASE WHEN (
              ${buildTrackingSearchDocumentExpression('s')} LIKE ? ESCAPE '!'
              OR ${trackingContactSearchDocumentExpression('c')} LIKE ? ESCAPE '!'
            ) THEN 1 ELSE 0 END AS bounded_search_match,`
          : ''
        query = `
          WITH ${projectionBranches.map(branch => `${branch.name} AS (
            ${branch.sql}
          )`).join(', ')}, projected_page AS (
            ${projectionBranches.map(branch => `SELECT * FROM ${branch.name}`).join('\n            UNION\n            ')}
          )
          SELECT
            page.visitor_key,
            page.session_row_id,
            page.latest_at as cursor_at,
            ${trackingCursorTimestampProjection('page.latest_at')} as cursor_serialized_at,
            'projection-started' as cursor_mode,
            ${boundedSearchProjection}
            ${visitorSelect}
          FROM projected_page page
          INNER JOIN sessions s ON s.id = page.session_row_id
          LEFT JOIN contacts c ON s.contact_id = c.id
          ORDER BY page.latest_at DESC, page.session_row_id DESC
          LIMIT ?
        `
        pageParams = [
          ...projectionBranches.flatMap(branch => branch.params),
          ...(boundedProjectionSearch ? [searchPattern, searchPattern] : []),
          projectionSearchCandidateLimit + 1
        ]
      }
    }

    const rawCandidateVisitors = await db.all(query, pageParams, { signal: requestScope.signal })
    let hasNext
    let visitors
    let nextCursorRow
    if (boundedProjectionSearch) {
      const projectionHasNext = rawCandidateVisitors.length > projectionSearchCandidateLimit
      const scannedCandidates = projectionHasNext
        ? rawCandidateVisitors.slice(0, projectionSearchCandidateLimit)
        : rawCandidateVisitors
      const matchingCandidates = scannedCandidates.filter(candidate => Number(candidate.bounded_search_match || 0) === 1)
      const matchingWindowHasNext = matchingCandidates.length > pageLimit
      visitors = matchingWindowHasNext ? matchingCandidates.slice(0, pageLimit) : matchingCandidates
      hasNext = matchingWindowHasNext || projectionHasNext
      nextCursorRow = matchingWindowHasNext
        ? visitors[visitors.length - 1]
        : projectionHasNext
          ? scannedCandidates[scannedCandidates.length - 1]
          : null
      visitorCoverage = trackingVisitorProjectionCoverage({
        available: true,
        ready: visitorCoverage?.status === 'ready',
        status: visitorCoverage?.status,
        sourceStatus: visitorCoverage?.sourceStatus,
        version: visitorCoverage?.projectionVersion,
        updatedAt: visitorCoverage?.updatedAt
      }, {
        rangeQuarterAligned: projectionQuarterAligned,
        search: normalizedSearch,
        candidatesScanned: scannedCandidates.length,
        candidateLimit: projectionSearchCandidateLimit,
        searchExhausted: !projectionHasNext
      })
    } else {
      hasNext = rawCandidateVisitors.length > pageLimit
      visitors = hasNext ? rawCandidateVisitors.slice(0, pageLimit) : rawCandidateVisitors
      nextCursorRow = hasNext ? visitors[visitors.length - 1] : null
    }
    const contactIds = [...new Set(visitors.map(visitor => visitor.contact_id).filter(Boolean).map(String))]
    const attendancePlaceholders = contactIds.map(() => '?').join(', ')
    const [appointmentsMap, attendanceRows] = await Promise.all([
      fetchBoundedAppointmentsForContacts(contactIds, 5, { signal: requestScope.signal }),
      contactIds.length > 0
        ? db.all(`
            SELECT DISTINCT contact_id
            FROM appointment_attendance_signals
            WHERE contact_id IN (${attendancePlaceholders})
          `, contactIds, { signal: requestScope.signal })
        : []
    ])
    const contactsWithAttendanceSignals = new Set(attendanceRows.map(row => String(row.contact_id)))

    const capitalizeName = (name) => {
      if (!name) return name
      return name
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ')
    }

    const formattedVisitors = visitors.map(v => {
      const appointmentSummary = v.contact_id
        ? appointmentsMap.get(String(v.contact_id)) || { appointments: [], total: 0, hasAttendedAppointment: false }
        : { appointments: [], total: 0, hasAttendedAppointment: false }
      const appointments = appointmentSummary.appointments
      const hasAttendedAppointment = Boolean(v.contact_id) && (
        contactsWithAttendanceSignals.has(String(v.contact_id)) ||
        appointmentSummary.hasAttendedAppointment
      )

      return {
        visitorId: v.visitor_id,
        sessionId: v.session_id,
        contactId: v.contact_id,
        createdAt: v.created_at,
        firstVisit: v.created_at, // Alias para compatibilidad con el frontend
        pageUrl: v.page_url,
        landingUrl: v.page_url,
        referrerUrl: v.referrer_url,
        utmSource: v.utm_source,
        utmMedium: v.utm_medium,
        utmCampaign: v.utm_campaign,
        utmTerm: v.utm_term,
        utmContent: v.utm_content,
        gclid: v.gclid,
        fbclid: v.fbclid,
        msclkid: v.msclkid,
        ttclid: v.ttclid,
        deviceType: v.device_type,
        browser: v.browser,
        os: v.os,
        language: v.language,
        timezone: v.timezone,
        country: v.geo_country,
        region: v.geo_region,
        city: v.geo_city,
        adId: v.ad_id,
        adName: v.ad_name,
        adsetId: v.adset_id,
        adsetName: v.adset_name,
        campaignId: v.campaign_id,
        campaignName: v.campaign_name,
        contact: v.contact_id ? {
          id: v.contact_id,
          name: capitalizeName(v.contact_name),
          email: v.contact_email,
          phone: v.contact_phone,
          ltv: parseFloat(v.contact_ltv) || 0,
          purchases: parseInt(v.contact_purchases) || 0,
          hasAttendedAppointment,
          appointments,
          appointmentsTotal: appointmentSummary.total,
          appointmentsTruncated: appointmentSummary.total > appointments.length
        } : null
      }
    })

    logger.info(`Página de visitantes obtenida: ${formattedVisitors.length} visitantes; hasNext=${hasNext}`)

    if (requestScope.timedOut) {
      const deadlineError = new Error('La consulta de visitantes excedió el presupuesto de ejecución')
      deadlineError.code = 'tracking_visitors_deadline'
      throw deadlineError
    }
    if (requestScope.signal.aborted || res.writableEnded || res.finished) return

    res.json({
      success: true,
      data: formattedVisitors,
      ...(visitorCoverage ? { coverage: visitorCoverage } : {}),
      pagination: {
        limit: pageLimit,
        hasNext,
        hasMore: hasNext,
        nextCursor: hasNext
          ? encodeTrackingDrilldownCursor('tracking-visitors', nextCursorRow, cursorScope)
          : null
      }
    })
  } catch (error) {
    if (requestScope.timedOut) {
      if (res.writableEnded || res.finished) return
      return res.status(503).json({
        error: 'La tabla de visitantes tardó demasiado y fue cancelada. Intenta nuevamente.',
        code: 'tracking_visitors_deadline',
        retryable: true
      })
    }
    if (isTrackingRequestAbort(error, requestScope.signal)) return
    const status = Number(error?.status) || 500
    if (status < 500 || error?.code === 'tracking_visitor_projection_warming') {
      logger.warn(`Solicitud de visitantes rechazada: ${error.message}`)
    }
    else logger.error('Error obteniendo lista de visitantes:', error)
    if (error?.code === 'tracking_visitor_projection_warming') {
      res.setHeader?.('Retry-After', '1')
      return res.status(status).json({
        error: error.message,
        code: error.code,
        retryable: true,
        coverage: error.coverage
      })
    }
    res.status(status).json({ error: status < 500 ? error.message : 'Internal server error' })
  } finally {
    requestScope.cleanup()
  }
}

/**
 * Obtiene conteo de contactos con visitor_id por fecha de creación
 * GET /api/tracking/contacts-by-date
 * Query params: start (YYYY-MM-DD), end (YYYY-MM-DD)
 */
export async function getContactsByDate(req, res) {
  try {
    const { start, end } = req.query

    if (!start || !end) {
      return res.status(400).json({ error: 'Se requieren parámetros start y end' })
    }

    logger.info(`Obteniendo registros por fecha: ${start} a ${end}`)

    const range = await resolveDateRangeWithGHLTimezone({ startDate: start, endDate: end })
    const contactCreatedDate = timestampDateExpression('c.created_at', range.appliedTimezone)
    const dateExpr = isPostgres
      ? `TO_CHAR(${contactCreatedDate}, 'YYYY-MM-DD')`
      : contactCreatedDate
    const dateFilter = isPostgres
      ? `${contactCreatedDate} >= ?::date AND ${contactCreatedDate} <= ?::date`
      : `${contactCreatedDate} >= DATE(?) AND ${contactCreatedDate} <= DATE(?)`

    const query = `
      SELECT
        ${dateExpr} as date,
        COUNT(DISTINCT c.id) as count
      FROM contacts c
      WHERE
        ${dateFilter}
        AND ${contactAnalyticsSourceCondition('c')}
      GROUP BY date
      ORDER BY date ASC
    `
    const params = [start, end]

    const contactsByDate = await db.all(query, params)

    // Crear un mapa con los resultados
    const dataMap = {}
    contactsByDate.forEach(row => {
      dataMap[row.date] = parseInt(row.count) || 0
    })

    // Generar todas las fechas del rango (rellenar con 0 los días sin contactos)
    const result = []
    const startDate = parseIsoDateToUtc(start)
    const endDate = parseIsoDateToUtc(end)

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Formato de fecha inválido' })
    }

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = formatUtcDateKey(d)
      result.push({
        date: dateStr,
        count: dataMap[dateStr] || 0
      })
    }

    res.json({ success: true, data: result })
  } catch (error) {
    logger.error('Error obteniendo contactos por fecha:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * Obtiene conversiones por fecha de creación del contacto.
 * GET /api/tracking/contact-conversions-by-date
 * Query params: start (YYYY-MM-DD), end (YYYY-MM-DD)
 */
export async function getContactConversionsByDate(req, res) {
  try {
    const { start, end } = req.query

    if (!start || !end) {
      return res.status(400).json({ error: 'Se requieren parámetros start y end' })
    }

    logger.info(`Obteniendo conversiones por fecha de creación: ${start} a ${end}`)

    const range = await resolveDateRangeWithGHLTimezone({ startDate: start, endDate: end })
    const contactCreatedDate = timestampDateExpression('c.created_at', range.appliedTimezone)
    const dateExpr = isPostgres
      ? `TO_CHAR(${contactCreatedDate}, 'YYYY-MM-DD')`
      : contactCreatedDate
    const dateFilter = isPostgres
      ? `${contactCreatedDate} >= ?::date AND ${contactCreatedDate} <= ?::date`
      : `${contactCreatedDate} >= DATE(?) AND ${contactCreatedDate} <= DATE(?)`

    const customerCondition = validPaymentExistsCondition('c')
    const appointmentCondition = activeAppointmentCondition('c')
    const attendanceCondition = attendedAppointmentCondition('c')

    const query = `
      WITH contact_flags AS (
        SELECT
          c.id,
          ${dateExpr} as date,
          CASE WHEN ${customerCondition} THEN 1 ELSE 0 END as is_customer,
          CASE WHEN ${appointmentCondition} THEN 1 ELSE 0 END as has_appointment,
          CASE WHEN ${attendanceCondition} THEN 1 ELSE 0 END as has_attendance
        FROM contacts c
        WHERE
          ${dateFilter}
          AND ${contactAnalyticsSourceCondition('c')}
      )
      SELECT
        date,
        COUNT(DISTINCT id) as registrations,
        COUNT(DISTINCT CASE WHEN is_customer = 0 AND has_appointment = 0 AND has_attendance = 0 THEN id END) as prospects,
        COUNT(DISTINCT CASE WHEN has_appointment = 1 THEN id END) as appointments,
        COUNT(DISTINCT CASE WHEN has_attendance = 1 THEN id END) as attendances,
        COUNT(DISTINCT CASE WHEN is_customer = 1 THEN id END) as customers
      FROM contact_flags
      GROUP BY date
      ORDER BY date ASC
    `

    const rows = await db.all(query, [start, end])
    const dataMap = {}

    rows.forEach(row => {
      dataMap[row.date] = {
        registrations: parseInt(row.registrations, 10) || 0,
        prospects: parseInt(row.prospects, 10) || 0,
        appointments: parseInt(row.appointments, 10) || 0,
        attendances: parseInt(row.attendances, 10) || 0,
        customers: parseInt(row.customers, 10) || 0
      }
    })

    const result = []
    const startDate = parseIsoDateToUtc(start)
    const endDate = parseIsoDateToUtc(end)

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Formato de fecha inválido' })
    }

    for (let d = new Date(startDate); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
      const dateStr = formatUtcDateKey(d)
      result.push({
        date: dateStr,
        registrations: dataMap[dateStr]?.registrations || 0,
        prospects: dataMap[dateStr]?.prospects || 0,
        appointments: dataMap[dateStr]?.appointments || 0,
        attendances: dataMap[dateStr]?.attendances || 0,
        customers: dataMap[dateStr]?.customers || 0
      })
    }

    res.json({ success: true, data: result })
  } catch (error) {
    logger.error('Error obteniendo conversiones por fecha de creación:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * GET /api/tracking/whatsapp-summary
 * Resumen de mensajes entrantes de WhatsApp por rango para Analíticas.
 */
export async function getWhatsAppSummary(req, res) {
  try {
    const { start, end, groupBy = 'day' } = req.query

    if (!start || !end) {
      return res.status(400).json({ error: 'Se requieren parámetros start y end' })
    }

    const range = await resolveDateRangeWithGHLTimezone({ startDate: start, endDate: end })
    const data = await getWhatsAppApiAnalyticsSummary(range, { groupBy })

    res.json({ success: true, data })
  } catch (error) {
    logger.error('Error obteniendo resumen de WhatsApp para analíticas:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * GET /api/tracking/messages-summary
 * Resumen de mensajes entrantes por canal para Analíticas.
 */
export async function getMessagesSummary(req, res) {
  const requestScope = createTrackingRequestAbortScope(res, {
    timeoutMs: TRACKING_AUXILIARY_QUERY_DEADLINE_MS
  })
  try {
    const { start, end, groupBy = 'day', channels = '', sources = '' } = req.query

    if (!start || !end) {
      return res.status(400).json({ error: 'Se requieren parámetros start y end' })
    }

    const range = await resolveDateRangeWithGHLTimezone({
      startDate: start,
      endDate: end,
      signal: requestScope.signal
    })
    const data = await getMessageAnalyticsSummary(range, {
      groupBy,
      filters: { channels, sources },
      signal: requestScope.signal
    })

    if (requestScope.timedOut) throw new Error('tracking_messages_deadline')
    if (requestScope.signal.aborted || res.writableEnded || res.finished) return
    res.json({ success: true, data })
  } catch (error) {
    if (requestScope.timedOut) {
      if (res.writableEnded || res.finished) return
      return res.status(503).json({
        error: 'El resumen de mensajes tardó demasiado y fue cancelado. Intenta nuevamente.',
        code: 'tracking_messages_deadline',
        retryable: true
      })
    }
    if (isTrackingRequestAbort(error, requestScope.signal)) return
    logger.error('Error obteniendo resumen de mensajes para analíticas:', error)
    res.status(500).json({ error: 'Internal server error' })
  } finally {
    requestScope.cleanup()
  }
}

/**
 * Obtiene contactos que componen una bolita del gráfico de conversiones.
 * GET /api/tracking/contact-conversions-list
 * Query params: start (YYYY-MM-DD), end (YYYY-MM-DD), type
 */
export async function getContactConversionsList(req, res) {
  const requestScope = createTrackingRequestAbortScope(res, {
    timeoutMs: TRACKING_AUXILIARY_QUERY_DEADLINE_MS
  })
  try {
    const {
      start,
      end,
      type = 'registrations',
      cursor,
      limit,
      search,
      q
    } = req.query || {}
    const normalizedType = String(type || 'registrations')

    if (!start || !end) {
      return res.status(400).json({ error: 'Se requieren parámetros start y end' })
    }

    if (!CONTACT_CONVERSION_LIST_TYPES.has(normalizedType)) {
      return res.status(400).json({ error: 'type inválido' })
    }

    const pageLimit = normalizeTrackingDrilldownLimit(limit)
    const normalizedSearch = normalizeTrackingDrilldownSearch(search ?? q)

    const startDate = parseIsoDateToUtc(start)
    const endDate = parseIsoDateToUtc(end)

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Formato de fecha inválido' })
    }

    logger.info(`Obteniendo página de conversiones (${normalizedType}): ${start} a ${end}; limit=${pageLimit}`)

    const range = await resolveDateRangeWithGHLTimezone({
      startDate: start,
      endDate: end,
      signal: requestScope.signal
    })
    const cursorScope = trackingDrilldownCursorScope('contact-conversions', {
      start,
      end,
      startUtc: range.startUtc,
      endUtc: range.endUtc,
      timezone: range.appliedTimezone,
      type: normalizedType,
      search: normalizedSearch.toLocaleLowerCase('es-MX')
    })
    const decodedCursor = decodeTrackingDrilldownCursor(cursor, 'contact-conversions', cursorScope)
    const contactCursorSortExpression = trackingContactCursorSortExpression('c')
    const contactCreatedDate = timestampDateExpression('c.created_at', range.appliedTimezone)
    const dateFilter = isPostgres
      ? `${contactCreatedDate} >= ?::date AND ${contactCreatedDate} <= ?::date`
      : `${contactCreatedDate} >= DATE(?) AND ${contactCreatedDate} <= DATE(?)`
    const customerCondition = validPaymentExistsCondition('c')
    const appointmentCondition = activeAppointmentCondition('c')
    const attendanceCondition = attendedAppointmentCondition('c')
    const typeCondition = getContactConversionListCondition(normalizedType)

    const conditions = [
      dateFilter,
      contactAnalyticsSourceCondition('c')
    ]

    if (typeCondition) {
      conditions.push(typeCondition)
    }

    const params = [start, end]
    appendTrackingDrilldownSearch(conditions, params, normalizedSearch, [
      'c.id',
      'c.full_name',
      'c.email',
      'c.phone',
      'c.source',
      'c.attribution_ad_id',
      'c.attribution_ad_name'
    ])
    if (decodedCursor) {
      conditions.push(`(${contactCursorSortExpression}, c.id) < (?, ?)`)
      params.push(decodedCursor.createdAt, decodedCursor.id)
    }
    params.push(pageLimit + 1)

    const query = `
      SELECT
        c.id,
        c.full_name,
        c.email,
        c.phone,
        c.created_at,
        ${contactCursorSortExpression} as cursor_at,
        ${trackingCursorTimestampProjection(contactCursorSortExpression)} as cursor_serialized_at,
        c.attribution_ad_id,
        c.attribution_ad_name,
        c.source,
        CASE WHEN ${customerCondition} THEN 1 ELSE 0 END as is_customer,
        CASE WHEN ${appointmentCondition} THEN 1 ELSE 0 END as has_appointment,
        CASE WHEN ${attendanceCondition} THEN 1 ELSE 0 END as has_attendance
      FROM contacts c
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${contactCursorSortExpression} DESC, c.id DESC
      LIMIT ?
    `

    const candidateRows = await db.all(query, params, { signal: requestScope.signal })
    const hasNext = candidateRows.length > pageLimit
    const rows = hasNext ? candidateRows.slice(0, pageLimit) : candidateRows
    const contactIds = rows.map(row => row.id).filter(Boolean)
    const contactPlaceholders = contactIds.map(() => '?').join(', ')
    const [paymentSummaries, appointmentSummaries, metaRows] = await Promise.all([
      fetchPaymentSummariesForContacts(contactIds, { signal: requestScope.signal }),
      fetchBoundedAppointmentsForContacts(contactIds, 5, { signal: requestScope.signal }),
      contactIds.length > 0
        ? db.all(`
            SELECT
              c.id as contact_id,
              MAX(meta_ads.campaign_id) as campaign_id,
              MAX(meta_ads.campaign_name) as campaign_name,
              MAX(meta_ads.adset_id) as adset_id,
              MAX(meta_ads.adset_name) as adset_name,
              MAX(meta_ads.ad_name) as meta_ad_name
            FROM contacts c
            LEFT JOIN meta_ads ON meta_ads.ad_id = c.attribution_ad_id
            WHERE c.id IN (${contactPlaceholders})
            GROUP BY c.id
          `, contactIds, { signal: requestScope.signal })
        : []
    ])
    const metaByContactId = new Map(metaRows.map(row => [String(row.contact_id), row]))

    const contacts = rows.map(row => {
      const paymentSummary = paymentSummaries.get(String(row.id)) || { ltv: 0, purchases: 0 }
      const appointmentSummary = appointmentSummaries.get(String(row.id)) || {
        appointments: [],
        total: 0,
        hasAttendedAppointment: false
      }
      const ltv = paymentSummary.ltv
      const purchases = paymentSummary.purchases
      const meta = metaByContactId.get(String(row.id)) || {}

      return {
        id: row.id,
        name: row.full_name || '',
        email: row.email || '',
        phone: row.phone || '',
        created_at: row.created_at,
        ltv,
        purchases,
        attributed: Boolean(row.attribution_ad_id),
        payments: [],
        appointments: appointmentSummary.appointments,
        appointmentsTotal: appointmentSummary.total,
        appointmentsTruncated: appointmentSummary.total > appointmentSummary.appointments.length,
        source: row.source || null,
        ad_name: meta.meta_ad_name || row.attribution_ad_name || null,
        ad_id: row.attribution_ad_id || null,
        campaign_id: meta.campaign_id || null,
        campaign_name: meta.campaign_name || null,
        adset_id: meta.adset_id || null,
        adset_name: meta.adset_name || null,
        metaAttribution: row.attribution_ad_id && (meta.meta_ad_name || meta.campaign_name || meta.adset_name)
          ? {
              source: 'meta_ads',
              matchType: 'ad_id',
              campaignId: meta.campaign_id || null,
              campaignName: meta.campaign_name || null,
              adsetId: meta.adset_id || null,
              adsetName: meta.adset_name || null,
              adId: row.attribution_ad_id || null,
              adName: meta.meta_ad_name || row.attribution_ad_name || null
            }
          : null,
        lifetimeLtv: ltv,
        lifetimePurchases: purchases,
        isCustomer: Boolean(Number(row.is_customer || 0)),
        hasAppointments: Boolean(Number(row.has_appointment || 0)),
        hasShowedAppointment: Boolean(Number(row.has_attendance || 0)),
        hasAttendedAppointment: Boolean(Number(row.has_attendance || 0))
      }
    })

    if (requestScope.timedOut) throw new Error('tracking_contact_conversions_deadline')
    if (requestScope.signal.aborted || res.writableEnded || res.finished) return
    res.json({
      success: true,
      data: {
        contacts,
        range: { start, end },
        pagination: {
          limit: pageLimit,
          hasNext,
          hasMore: hasNext,
          nextCursor: hasNext
            ? encodeTrackingDrilldownCursor('contact-conversions', rows[rows.length - 1], cursorScope)
            : null
        }
      }
    })
  } catch (error) {
    if (requestScope.timedOut) {
      if (res.writableEnded || res.finished) return
      return res.status(503).json({
        error: 'La lista de conversiones tardó demasiado y fue cancelada. Intenta nuevamente.',
        code: 'tracking_contact_conversions_deadline',
        retryable: true
      })
    }
    if (isTrackingRequestAbort(error, requestScope.signal)) return
    const status = Number(error?.status) || 500
    if (status < 500) logger.warn(`Solicitud de conversiones rechazada: ${error.message}`)
    else logger.error('Error obteniendo lista de conversiones por contacto:', error)
    if (!res.writableEnded && !res.finished) {
      res.status(status).json({ error: status < 500 ? error.message : 'Internal server error' })
    }
  } finally {
    requestScope.cleanup()
  }
}
