import { logger } from '../utils/logger.js'
import { createSession, updateSession, getRecentSessions, getSessionById } from '../services/trackingService.js'
import { getHighLevelConfig } from '../config/database.js'
import fetch from 'node-fetch'

/**
 * Genera el código JavaScript del pixel de tracking
 * GET /snip.js
 */
export async function servePixel(req, res) {
  try {
    const protocol = req.protocol
    const host = req.headers.host
    const BASE = `${protocol}://${host}`
    const ENDPOINT = `${BASE}/collect`

    // Generar el código del pixel dinámicamente
    const pixelCode = `
(function() {
  'use strict';

  var ENDPOINT = '${ENDPOINT}';

  // Obtener o crear visitor_id (persistente entre sesiones)
  function getVisitorId() {
    try {
      var visitorId = localStorage.getItem('_visitor_id');
      if (!visitorId) {
        visitorId = generateUUID();
        localStorage.setItem('_visitor_id', visitorId);
      }
      return visitorId;
    } catch (e) {
      return 'visitor_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }
  }

  // Obtener o crear session_id (temporal, solo esta sesión)
  function getSessionId() {
    try {
      var sessionId = sessionStorage.getItem('_session_id');
      if (!sessionId) {
        sessionId = generateUUID();
        sessionStorage.setItem('_session_id', sessionId);
        sessionStorage.setItem('_session_start', Date.now().toString());
      }
      return sessionId;
    } catch (e) {
      return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }
  }

  // Verificar si es la primera vez en esta sesión
  function isFirstPageView() {
    try {
      var flag = sessionStorage.getItem('_first_pv');
      if (!flag) {
        sessionStorage.setItem('_first_pv', '1');
        return true;
      }
      return false;
    } catch (e) {
      return true;
    }
  }

  // Generar UUID simple
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

  // Extraer parámetros UTM de la URL
  function extractUtmParams() {
    var params = {};
    var search = window.location.search.substring(1);
    if (!search) return params;

    var pairs = search.split('&');
    for (var i = 0; i < pairs.length; i++) {
      var pair = pairs[i].split('=');
      var key = decodeURIComponent(pair[0]);
      var value = pair[1] ? decodeURIComponent(pair[1]) : '';

      if (key.indexOf('utm_') === 0 || key === 'gclid' || key === 'fbclid' ||
          key === 'msclkid' || key === 'ttclid' || key === 'wbraid' || key === 'gbraid') {
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

  // Enviar evento al servidor
  function sendEvent(eventName, additionalData) {
    var visitorId = getVisitorId();
    var sessionId = getSessionId();
    var utmParams = extractUtmParams();
    var fbCookies = getFacebookCookies();

    var data = {
      url: window.location.href,
      referrer: document.referrer || null,
      title: document.title || null,
      device_type: getDeviceType(),
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

  // Enviar page_view al cargar
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(function() {
      var eventName = isFirstPageView() ? 'session_start' : 'page_view';
      sendEvent(eventName);
    }, 0);
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      var eventName = isFirstPageView() ? 'session_start' : 'page_view';
      sendEvent(eventName);
    });
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
    res.setHeader('Cache-Control', 'public, max-age=3600')
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

    const { visitor_id, session_id, event_name, ts, data } = req.body

    // Validaciones básicas
    if (!visitor_id || !session_id || !event_name || !ts) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    // Extraer IP y User-Agent del request
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || null
    const user_agent = req.headers['user-agent'] || null

    const sessionData = {
      session_id,
      visitor_id,
      event_name,
      ts,
      data: data || {},
      ip,
      user_agent
    }

    // Verificar si la sesión ya existe
    const { getSessionById } = await import('../services/trackingService.js')
    const existingSession = await getSessionById(session_id)

    if (!existingSession) {
      // Crear nueva sesión
      await createSession(sessionData)
    } else {
      // Actualizar sesión existente
      await updateSession(sessionData)
    }

    // Responder rápido
    res.json({ ok: true })
  } catch (error) {
    logger.error('Error en /collect:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * Obtiene sesiones recientes para el dashboard
 * GET /api/tracking/sessions?limit=50
 */
export async function getSessionsHandler(req, res) {
  try {
    const limit = parseInt(req.query.limit, 10) || 50

    if (limit > 1000) {
      return res.status(400).json({ error: 'Limit too high (max 1000)' })
    }

    const sessions = await getRecentSessions(limit)
    res.json({ sessions })
  } catch (error) {
    logger.error('Error obteniendo sesiones:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * Obtiene una sesión específica
 * GET /api/tracking/sessions/:id
 */
export async function getSessionHandler(req, res) {
  try {
    const { id } = req.params
    const session = await getSessionById(id)

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
 * Detecta automáticamente el dominio de tracking
 * GET /api/tracking/config
 */
export async function getTrackingConfig(req, res) {
  try {
    // Detectar dominio automáticamente
    let trackingDomain = null

    // PRIORIDAD 1: Variable de entorno custom (si el usuario lo configuró manualmente)
    if (process.env.TRACKING_DOMAIN) {
      trackingDomain = process.env.TRACKING_DOMAIN
    }
    // PRIORIDAD 2: Host del request (captura custom domains como collect.midominio.com)
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

    res.json({
      trackingDomain,
      isConfigured,
      hasHighLevel: !!(ghlConfig && ghlConfig.location_id && ghlConfig.api_token)
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

    // PRIORIDAD 1: Variable de entorno custom (si el usuario lo configuró manualmente)
    if (process.env.TRACKING_DOMAIN) {
      trackingDomain = process.env.TRACKING_DOMAIN
    }
    // PRIORIDAD 2: Host del request (captura custom domains como collect.midominio.com)
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

    // Generar el snippet
    const snippet = `<!-- Pixel de Tracking Ristak -->
<script async src="https://${trackingDomain}/snip.js"></script>`

    logger.info(`Configurando tracking en HighLevel para dominio: ${trackingDomain}`)

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
