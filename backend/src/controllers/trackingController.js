import { logger } from '../utils/logger.js'
import { createSession, getRecentSessions, linkVisitorToContact, getSessionsByDateRange } from '../services/trackingService.js'
import { getHighLevelConfig, getAppConfig, setAppConfig, db } from '../config/database.js'
import { getHiddenContactFilters, buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js'
import { resolveDateRangeWithGHLTimezone } from '../utils/dateUtils.js'
import { getContactsWithShowedAppointmentsHybrid } from '../services/appointmentsMerge.js'
import { getGroupExpression } from '../services/analyticsService.js'
import fetch from 'node-fetch'

const isPostgres = Boolean(process.env.DATABASE_URL)
const TRACKING_SNIPPET_VERSION = '9' // Incrementar cuando cambies el código del snippet

function timestampLocalExpression(column, timezone = 'UTC') {
  if (!isPostgres) {
    return `datetime(${column}, '-6 hours')`
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

const formatUtcDateKey = (date) => date.toISOString().slice(0, 10)

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

    // Generar el código del pixel dinámicamente
    const pixelCode = `
(function() {
  'use strict';

  var ENDPOINT = '${ENDPOINT}';
  var lastTrackedUrl = window.location.href;
  var pageViewTimer = null;

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

  // Obtener o crear visitor_id (persistente entre sesiones)
  function getVisitorId() {
    try {
      var localData = getLocalData();
      if (!localData.visitor_id) {
        localData.visitor_id = generateId(); // ID corto tipo HighLevel
        localData.first_visit = new Date().toISOString();
        setLocalData(localData);
      }
      return localData.visitor_id;
    } catch (e) {
      return generateId(); // Fallback también usa ID corto
    }
  }

  // Obtener o crear session_id (temporal, solo esta sesión)
  function getSessionId() {
    try {
      var sessionData = getSessionData();
      if (!sessionData.session_id) {
        sessionData.session_id = generateUUID();
        sessionData.session_start = Date.now();
        sessionData.first_pv = true;
        setSessionData(sessionData);
      }
      return sessionData.session_id;
    } catch (e) {
      return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
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

  // Inyectar visitor_id en URL si no está presente
  function injectVisitorIdToURL() {
    try {
      var currentURL = new URL(window.location.href);
      var params = currentURL.searchParams;

      // Solo agregar si no existe ya
      if (!params.has('rkvi_id')) {
        var visitorId = getVisitorId();
        params.set('rkvi_id', visitorId);

        // Actualizar URL sin recargar la página
        var newURL = currentURL.pathname + '?' + params.toString() + currentURL.hash;
        window.history.replaceState({}, '', newURL);
      }
    } catch (e) {
      // Ignore errors (navegadores viejos sin URL API)
    }
  }

  // Inyectar visitor_id en URL al cargar
  injectVisitorIdToURL();
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

    // Extraer full_name si viene en data.contact_name
    let full_name = null
    if (contact_id && data && data.contact_name) {
      full_name = data.contact_name
    }

    const sessionData = {
      session_id,
      visitor_id,
      contact_id: contact_id || null,
      full_name,
      event_name,
      ts,
      data: data || {},
      ip,
      user_agent
    }

    // SIEMPRE crear un nuevo registro (cada visita es única)
    await createSession(sessionData)

    // Si hay contact_id, vincular visitor_id histórico con este contacto y unificar
    if (contact_id && visitor_id) {
      // Si no viene full_name, buscarlo en la tabla contacts
      if (!full_name) {
        try {
          const contact = await db.get('SELECT full_name FROM contacts WHERE id = $1', [contact_id])
          full_name = contact?.full_name || 'Sin nombre'
        } catch (err) {
          logger.warn(`No se pudo obtener full_name para contacto ${contact_id}: ${err.message}`)
          full_name = 'Sin nombre'
        }
      }

      // Importar funciones de tracking
      const { unifyVisitorIds } = await import('../services/trackingService.js')

      // No esperamos a que termine (async sin await) para responder rápido
      linkVisitorToContact(visitor_id, contact_id, full_name)
        .then(() => {
          // Después de vincular, unificar todos los visitor_ids al más viejo
          return unifyVisitorIds(contact_id)
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
      logger.warn('No hay configuración de HighLevel para sincronizar visitor_id')
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
 * GET /api/tracking/sessions?start=YYYY-MM-DD&end=YYYY-MM-DD (sin paginación)
 */
export async function getSessionsHandler(req, res) {
  try {
    const limit = parseInt(req.query.limit, 10) || 50
    const offset = parseInt(req.query.offset, 10) || 0
    const { start, end } = req.query

    logger.info(`📊 GET /api/tracking/sessions - start: ${start}, end: ${end}, limit: ${limit}, offset: ${offset}`)

    if (limit > 1000) {
      logger.warn(`⚠️ Limit demasiado alto: ${limit}`)
      return res.status(400).json({ error: 'Limit too high (max 1000)' })
    }

    // Si hay fechas, usar filtro de rango (sin paginación, para Analytics)
    if (start && end) {
      logger.info(`🔍 Buscando sesiones entre ${start} y ${end}`)
      const sessions = await getSessionsByDateRange(start, end)
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
    // Detectar dominio automáticamente
    let trackingDomain = null

    // PRIORIDAD 0: Si el frontend envía su dominio, usar ese
    if (req.query.frontendDomain && req.query.frontendDomain !== 'localhost') {
      trackingDomain = req.query.frontendDomain
    }
    // PRIORIDAD 1: Variable de entorno TRACKING_DOMAIN (dominio personalizado configurado)
    else if (process.env.TRACKING_DOMAIN) {
      trackingDomain = process.env.TRACKING_DOMAIN
    }
    // PRIORIDAD 2: Host del request (captura custom domains como ristak.midominio.com)
    // Esto SIEMPRE refleja el dominio real desde el cual el usuario accede
    else if (req.headers.host) {
      trackingDomain = req.headers.host
    }
    // PRIORIDAD 3: RENDER_EXTERNAL_URL como último recurso
    else if (process.env.RENDER_EXTERNAL_URL) {
      trackingDomain = process.env.RENDER_EXTERNAL_URL.replace(/^https?:\/\//, '')
    }

    // Verificar si ya está configurado en HighLevel
    const ghlConfig = await getHighLevelConfig()
    let isConfigured = false

    if (ghlConfig && ghlConfig.location_id && ghlConfig.api_token) {
      try {
        // Consultar custom values de HighLevel
        const response = await fetch(
          `https://services.leadconnectorhq.com/locations/${ghlConfig.location_id}/customValues`,
          {
            headers: {
              'Authorization': `Bearer ${ghlConfig.api_token}`,
              'Version': '2021-07-28'
            }
          }
        )

        if (response.ok) {
          const data = await response.json()
          const trackingValue = data.customValues?.find(cv => cv.name === 'rstktrack')
          isConfigured = !!trackingValue && trackingValue.value && trackingValue.value.includes('<script')
        }
      } catch (error) {
        logger.warn('Error verificando custom values:', error.message)
      }
    }

    // Leer preferencia de Analytics desde app_config (independiente de HighLevel)
    const showAnalyticsValue = await getAppConfig('show_analytics')
    const showAnalytics = showAnalyticsValue === '1' || showAnalyticsValue === 1 || showAnalyticsValue === true

    // Leer preferencia de fuente de visitantes
    const visitorSource = await getAppConfig('visitor_source') || 'platform'

    // Verificar si hay Meta Pixel configurado
    const metaConfig = await db.get('SELECT pixel_id FROM meta_config LIMIT 1')
    const hasMetaPixel = !!(metaConfig && metaConfig.pixel_id)
    const includeMetaPixelPref = await getAppConfig('include_meta_pixel')
    const includeMetaPixel = includeMetaPixelPref === null || includeMetaPixelPref === undefined
      ? true
      : (includeMetaPixelPref === '1' || includeMetaPixelPref === 1 || includeMetaPixelPref === true || includeMetaPixelPref === 'true')
    const trackingSnippet = trackingDomain
      ? buildTrackingSnippet({
        trackingDomain,
        metaPixelId: hasMetaPixel ? metaConfig.pixel_id : null,
        includeMetaPixel
      })
      : null

    res.json({
      trackingDomain,
      isConfigured,
      hasHighLevel: !!(ghlConfig && ghlConfig.location_id && ghlConfig.api_token),
      showAnalytics,
      visitorSource,
      hasMetaPixel,
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
 * Configura automáticamente el tracking en HighLevel
 * POST /api/tracking/configure
 */
export async function configureTracking(req, res) {
  try {
    // Obtener configuración de HighLevel
    const ghlConfig = await getHighLevelConfig()

    if (!ghlConfig || !ghlConfig.location_id || !ghlConfig.api_token) {
      return res.status(400).json({
        error: 'HighLevel no está configurado. Por favor configura tu cuenta de HighLevel primero.'
      })
    }

    // Detectar dominio automáticamente (misma lógica que getTrackingConfig)
    let trackingDomain = null

    // PRIORIDAD 0: Si el frontend envía su dominio, usar ese
    if (req.body.frontendDomain && req.body.frontendDomain !== 'localhost') {
      trackingDomain = req.body.frontendDomain
    }
    // PRIORIDAD 1: Variable de entorno TRACKING_DOMAIN (dominio personalizado configurado)
    else if (process.env.TRACKING_DOMAIN) {
      trackingDomain = process.env.TRACKING_DOMAIN
    }
    // PRIORIDAD 2: Host del request (captura custom domains como ristak.midominio.com)
    // Esto SIEMPRE refleja el dominio real desde el cual el usuario accede
    else if (req.headers.host) {
      trackingDomain = req.headers.host
    }
    // PRIORIDAD 3: RENDER_EXTERNAL_URL como fallback
    else if (process.env.RENDER_EXTERNAL_URL) {
      trackingDomain = process.env.RENDER_EXTERNAL_URL.replace(/^https?:\/\//, '')
    }

    if (!trackingDomain) {
      return res.status(400).json({
        error: 'No se pudo detectar el dominio de tracking automáticamente'
      })
    }

    // Obtener configuración de Meta para incluir Pixel si está configurado
    const metaConfig = await db.get('SELECT pixel_id FROM meta_config LIMIT 1')
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
        COUNT(DISTINCT visitor_id) as unique_visitors,
        COUNT(*) as total_pageviews
      FROM sessions
      WHERE ad_id IS NOT NULL
        AND started_at >= $1
        AND started_at <= $2
      GROUP BY ad_id
    `

    const visitors = await db.all(query, [range.startUtc, range.endUtc])

    logger.info(`Visitantes por ad obtenidos: ${visitors.length} ads con visitas`)

    // Crear un mapa de ad_id -> visitantes
    const visitorsByAd = {}
    visitors.forEach(row => {
      visitorsByAd[row.ad_id] = {
        uniqueVisitors: parseInt(row.unique_visitors) || 0,
        totalPageviews: parseInt(row.total_pageviews) || 0
      }
    })

    res.json({ success: true, data: visitorsByAd })
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
        return `strftime('%Y-W%W', datetime(${column}, '-6 hours'))`
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
          COUNT(DISTINCT s.visitor_id) as unique_visitors
        FROM sessions s
        INNER JOIN contacts c ON c.id = s.contact_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY period
        ORDER BY period ASC
      `
      : `
        SELECT
          ${groupExpression} as period,
          COUNT(DISTINCT s.visitor_id) as unique_visitors
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
  try {
    const { startDate, endDate, ad_id, campaign_id, adset_id, scope } = req.query

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate y endDate son requeridos' })
    }

    // Usar timezone de HighLevel para consistencia con Dashboard
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })

    logger.info(`Obteniendo lista de visitantes - rango: ${range.startUtc} -> ${range.endUtc}, scope: ${scope}, ad_id: ${ad_id}, campaign_id: ${campaign_id}, adset_id: ${adset_id}`)

    // Determinar lógica de atribución (MISMA LÓGICA QUE buildReportMetrics)
    const useContactAttribution = scope === 'campaigns' || scope === 'attributed' || scope === 'attribution'
    const isAttributed = scope === 'campaigns' || scope === 'attributed'

    // Obtener filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters()
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)

    // Construir WHERE clause
    let conditions, params, paramCount

    if (useContactAttribution) {
      // Vista "Último toque" / "Último toque desde anuncio": Filtrar por fecha de creación del contacto
      // Solo visitantes que SE CONVIRTIERON en contacto (tienen contact_id)
      conditions = ['c.created_at >= $1', 'c.created_at <= $2', 's.contact_id IS NOT NULL']
      params = [range.startUtc, range.endUtc]
      paramCount = 2

      // Filtrar contactos ocultos
      if (hiddenCondition) {
        conditions.push(hiddenCondition)
      }

      // Si es "campaigns", filtrar por ad_id (último toque desde anuncio)
      if (isAttributed) {
        conditions.push('c.attribution_ad_id IS NOT NULL')
        conditions.push(`EXISTS (
          SELECT 1 FROM meta_ads ma
          WHERE ma.ad_id = c.attribution_ad_id
            AND ${metaAdsSameLocalDayCondition('ma.date', 'c.created_at', range.appliedTimezone)}
        )`)
      }
    } else {
      // Vista "Todos": Filtrar por fecha de la sesión (started_at)
      conditions = ['s.started_at >= $1', 's.started_at <= $2']
      params = [range.startUtc, range.endUtc]
      paramCount = 2
    }

    // Filtros opcionales por campaña/adset/ad (solo para vista "Todos")
    if (!useContactAttribution) {
      if (ad_id) {
        paramCount++
        conditions.push(`s.ad_id = $${paramCount}`)
        params.push(ad_id)
      } else if (adset_id) {
        paramCount++
        conditions.push(`s.adset_id = $${paramCount}`)
        params.push(adset_id)
      } else if (campaign_id) {
        paramCount++
        conditions.push(`s.campaign_id = $${paramCount}`)
        params.push(campaign_id)
      }
    }

    // Query PostgreSQL: obtener visitantes únicos con sus datos de sesión
    const query = `
      SELECT DISTINCT ON (s.visitor_id)
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
        c.full_name as contact_name,
        c.email as contact_email,
        c.phone as contact_phone,
        c.total_paid as contact_ltv,
        c.purchases_count as contact_purchases,
        CASE WHEN a.contact_id IS NOT NULL THEN 1 ELSE 0 END as has_appointment_db
      FROM sessions s
      LEFT JOIN contacts c ON s.contact_id = c.id
      LEFT JOIN (
        SELECT DISTINCT contact_id
        FROM appointments
        WHERE contact_id IS NOT NULL
      ) a ON a.contact_id = c.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY s.visitor_id, s.created_at DESC
    `

    const visitors = await db.all(query, params)

    // Verificar citas usando lógica híbrida (DB + API) para contactos sin citas en DB
    const config = await db.get('SELECT location_id, api_token FROM highlevel_config LIMIT 1')
    const contactsWithAppointments = new Set()
    const contactsWithAttendances = await getContactsWithShowedAppointmentsHybrid(
      config?.location_id,
      config?.api_token
    )

    // Agregar contactos que ya tienen citas en DB
    visitors.forEach(v => {
      if (v.contact_id && v.has_appointment_db === 1) {
        contactsWithAppointments.add(v.contact_id)
      }
    })

    // Verificar contactos sin citas en DB usando API de HighLevel
    const contactsToCheck = visitors
      .filter(v => v.contact_id && v.has_appointment_db === 0)
      .map(v => ({ id: v.contact_id }))
      // Remover duplicados
      .filter((contact, index, self) =>
        index === self.findIndex(c => c.id === contact.id)
      )

    if (config && config.api_token && contactsToCheck.length > 0) {
      logger.info(`[VISITANTES MODAL] Verificando ${contactsToCheck.length} contactos sin citas en DB...`)

      // Batch de 50 contactos simultáneos
      const batchSize = 50

      for (let i = 0; i < contactsToCheck.length; i += batchSize) {
        const batch = contactsToCheck.slice(i, i + batchSize)

        const appointmentChecks = await Promise.all(
          batch.map(async (contact) => {
            try {
              const response = await fetch(
                `https://services.leadconnectorhq.com/contacts/${contact.id}/appointments`,
                {
                  headers: {
                    'Authorization': `Bearer ${config.api_token}`,
                    'Version': '2021-07-28'
                  }
                }
              )

              if (response.ok) {
                const data = await response.json()
                if (data.events && data.events.length > 0) {
                  logger.info(`[VISITANTES MODAL] Contacto ${contact.id} tiene ${data.events.length} citas en HighLevel`)

                  // Guardar en DB para cache futuro
                  for (const event of data.events) {
                    await db.run(`
                      INSERT INTO appointments (id, contact_id, calendar_id, location_id, title, status, start_time, end_time)
                      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                      ON CONFLICT(id) DO UPDATE SET
                        status = excluded.status,
                        start_time = excluded.start_time,
                        end_time = excluded.end_time
                    `, [
                      event.id,
                      contact.id,
                      event.calendarId || '',
                      event.locationId || config.location_id,
                      event.title || '',
                      event.status || 'scheduled',
                      event.startTime || '',
                      event.endTime || ''
                    ]).catch(err => {
                      logger.error(`Error guardando cita ${event.id}:`, err)
                    })
                  }

                  return { contactId: contact.id, hasAppointments: true }
                }
              }
              return { contactId: contact.id, hasAppointments: false }
            } catch (error) {
              logger.error(`Error verificando citas para contacto ${contact.id}:`, error)
              return { contactId: contact.id, hasAppointments: false }
            }
          })
        )

        // Actualizar el set con los contactos que tienen citas
        appointmentChecks.forEach(result => {
          if (result.hasAppointments) {
            contactsWithAppointments.add(result.contactId)
          }
        })
      }
    }

    logger.info(`Visitantes obtenidos: ${visitors.length} visitantes únicos`)

    // Función helper para capitalizar nombres
    const capitalizeName = (name) => {
      if (!name) return name
      return name
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ')
    }

    // Formatear datos
    const formattedVisitors = visitors.map(v => {
      const hasAttendedAppointment = v.contact_id ? contactsWithAttendances.has(v.contact_id) : false

      return {
        visitorId: v.visitor_id,
        sessionId: v.session_id,
        contactId: v.contact_id,
        createdAt: v.created_at,
        firstVisit: v.created_at, // Alias para compatibilidad con el frontend
        pageUrl: v.page_url,
        referrerUrl: v.referrer_url,
        utmSource: v.utm_source,
        utmMedium: v.utm_medium,
        utmCampaign: v.utm_campaign,
        utmTerm: v.utm_term,
        utmContent: v.utm_content,
        gclid: v.gclid,
        fbclid: v.fbclid,
        deviceType: v.device_type,
        browser: v.browser,
        os: v.os,
        language: v.language,
        adId: v.ad_id,
        adName: v.ad_name,
        // Datos del contacto (si está identificado)
        contact: v.contact_id ? {
          id: v.contact_id,
          name: capitalizeName(v.contact_name),
          email: v.contact_email,
          phone: v.contact_phone,
          ltv: parseFloat(v.contact_ltv) || 0,
          purchases: parseInt(v.contact_purchases) || 0,
          hasAttendedAppointment,
          appointments: contactsWithAppointments.has(v.contact_id)
            ? [{ dummy: true, status: hasAttendedAppointment ? 'showed' : undefined }]
            : []
        } : null
      }
    })

    res.json({ success: true, data: formattedVisitors })
  } catch (error) {
    logger.error('Error obteniendo lista de visitantes:', error)
    res.status(500).json({ error: 'Internal server error' })
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

    const customerCondition = '(COALESCE(c.purchases_count, 0) > 0 OR COALESCE(c.total_paid, 0) > 0)'
    const appointmentCondition = `(
      c.appointment_date IS NOT NULL OR EXISTS (
        SELECT 1
        FROM appointments a
        WHERE a.contact_id = c.id
      )
    )`
    const attendanceCondition = `(
      EXISTS (
        SELECT 1
        FROM appointment_attendance_signals aas
        WHERE aas.contact_id = c.id
      ) OR EXISTS (
        SELECT 1
        FROM appointments aa
        WHERE aa.contact_id = c.id
          AND LOWER(COALESCE(aa.appointment_status, aa.status, '')) IN ('showed', 'completed', 'attended')
      )
    )`

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
