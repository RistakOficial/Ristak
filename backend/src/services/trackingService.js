import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'

/**
 * Extrae parámetros UTM de un objeto de datos
 */
function extractUtmParams(data) {
  return {
    utm_source: data.utm_source || null,
    utm_medium: data.utm_medium || null,
    utm_campaign: data.utm_campaign || null,
    utm_term: data.utm_term || null,
    utm_content: data.utm_content || null
  }
}

/**
 * Extrae click IDs de plataformas publicitarias
 */
function extractClickIds(data) {
  return {
    gclid: data.gclid || null,
    fbclid: data.fbclid || null,
    fbc: data.fbc || null,
    fbp: data.fbp || null,
    wbraid: data.wbraid || null,
    gbraid: data.gbraid || null,
    msclkid: data.msclkid || null,
    ttclid: data.ttclid || null
  }
}

/**
 * Extrae información del dispositivo
 */
function extractDeviceInfo(data) {
  return {
    device_type: data.device_type || null,
    os: data.os || null,
    browser: data.browser || null,
    browser_version: data.browser_version || null,
    language: data.language || null,
    timezone: data.timezone || null
  }
}

/**
 * Extrae información geográfica (si viene del cliente)
 */
function extractGeoInfo(data) {
  return {
    geo_country: data.geo_country || null,
    geo_region: data.geo_region || null,
    geo_city: data.geo_city || null
  }
}

/**
 * Crea una nueva sesión de tracking
 */
export async function createSession(sessionData) {
  const {
    session_id,
    visitor_id,
    event_name,
    ts,
    data,
    ip,
    user_agent
  } = sessionData

  const utms = extractUtmParams(data)
  const clickIds = extractClickIds(data)
  const deviceInfo = extractDeviceInfo(data)
  const geoInfo = extractGeoInfo(data)

  const startedAt = new Date(ts).toISOString()

  try {
    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        event_name,
        started_at,
        last_event_at,
        landing_url,
        referrer_url,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_term,
        utm_content,
        gclid,
        fbclid,
        fbc,
        fbp,
        wbraid,
        gbraid,
        msclkid,
        ttclid,
        ip,
        user_agent,
        device_type,
        os,
        browser,
        browser_version,
        language,
        timezone,
        geo_country,
        geo_region,
        geo_city,
        pageviews_count,
        events_count
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `, [
      session_id,
      visitor_id,
      event_name,
      startedAt,
      startedAt,
      data.url || null,
      data.referrer || null,
      utms.utm_source,
      utms.utm_medium,
      utms.utm_campaign,
      utms.utm_term,
      utms.utm_content,
      clickIds.gclid,
      clickIds.fbclid,
      clickIds.fbc,
      clickIds.fbp,
      clickIds.wbraid,
      clickIds.gbraid,
      clickIds.msclkid,
      clickIds.ttclid,
      ip,
      user_agent,
      deviceInfo.device_type,
      deviceInfo.os,
      deviceInfo.browser,
      deviceInfo.browser_version,
      deviceInfo.language,
      deviceInfo.timezone,
      geoInfo.geo_country,
      geoInfo.geo_region,
      geoInfo.geo_city,
      event_name === 'page_view' ? 1 : 0,
      1
    ])

    logger.info(`Nueva sesión creada: ${session_id}`)
    return { success: true }
  } catch (error) {
    logger.error('Error creando sesión:', error)
    throw error
  }
}

/**
 * Actualiza una sesión existente
 */
export async function updateSession(sessionData) {
  const {
    session_id,
    event_name,
    ts,
    data
  } = sessionData

  const lastEventAt = new Date(ts).toISOString()

  try {
    // Obtener la sesión actual para incrementar contadores
    const session = await db.get('SELECT pageviews_count, events_count FROM sessions WHERE session_id = ?', [session_id])

    if (!session) {
      logger.warn(`Sesión no encontrada: ${session_id}`)
      return { success: false, error: 'Session not found' }
    }

    const newPageviewsCount = event_name === 'page_view' ? session.pageviews_count + 1 : session.pageviews_count
    const newEventsCount = session.events_count + 1

    // Actualizar campos básicos
    const updates = []
    const params = []

    updates.push('last_event_at = ?')
    params.push(lastEventAt)

    updates.push('pageviews_count = ?')
    params.push(newPageviewsCount)

    updates.push('events_count = ?')
    params.push(newEventsCount)

    // Actualizar UTMs solo si no estaban seteados y ahora llegan
    const utms = extractUtmParams(data)
    if (utms.utm_source) {
      updates.push('utm_source = COALESCE(utm_source, ?)')
      params.push(utms.utm_source)
    }
    if (utms.utm_medium) {
      updates.push('utm_medium = COALESCE(utm_medium, ?)')
      params.push(utms.utm_medium)
    }
    if (utms.utm_campaign) {
      updates.push('utm_campaign = COALESCE(utm_campaign, ?)')
      params.push(utms.utm_campaign)
    }
    if (utms.utm_term) {
      updates.push('utm_term = COALESCE(utm_term, ?)')
      params.push(utms.utm_term)
    }
    if (utms.utm_content) {
      updates.push('utm_content = COALESCE(utm_content, ?)')
      params.push(utms.utm_content)
    }

    // Actualizar click IDs solo si no estaban seteados
    const clickIds = extractClickIds(data)
    if (clickIds.gclid) {
      updates.push('gclid = COALESCE(gclid, ?)')
      params.push(clickIds.gclid)
    }
    if (clickIds.fbclid) {
      updates.push('fbclid = COALESCE(fbclid, ?)')
      params.push(clickIds.fbclid)
    }
    if (clickIds.fbc) {
      updates.push('fbc = COALESCE(fbc, ?)')
      params.push(clickIds.fbc)
    }
    if (clickIds.fbp) {
      updates.push('fbp = COALESCE(fbp, ?)')
      params.push(clickIds.fbp)
    }
    if (clickIds.wbraid) {
      updates.push('wbraid = COALESCE(wbraid, ?)')
      params.push(clickIds.wbraid)
    }
    if (clickIds.gbraid) {
      updates.push('gbraid = COALESCE(gbraid, ?)')
      params.push(clickIds.gbraid)
    }
    if (clickIds.msclkid) {
      updates.push('msclkid = COALESCE(msclkid, ?)')
      params.push(clickIds.msclkid)
    }
    if (clickIds.ttclid) {
      updates.push('ttclid = COALESCE(ttclid, ?)')
      params.push(clickIds.ttclid)
    }

    // Calcular is_bounce si es session_end
    if (event_name === 'session_end') {
      const duration = ts - new Date(session.started_at).getTime()
      const isBounce = newPageviewsCount === 1 && duration < 30000 ? 1 : 0
      updates.push('is_bounce = ?')
      params.push(isBounce)
    }

    params.push(session_id)

    await db.run(`
      UPDATE sessions
      SET ${updates.join(', ')}
      WHERE session_id = ?
    `, params)

    logger.info(`Sesión actualizada: ${session_id} (${event_name})`)
    return { success: true }
  } catch (error) {
    logger.error('Error actualizando sesión:', error)
    throw error
  }
}

/**
 * Obtiene sesiones recientes
 */
export async function getRecentSessions(limit = 50) {
  try {
    const sessions = await db.all(`
      SELECT
        session_id,
        visitor_id,
        contact_id,
        landing_url,
        referrer_url,
        utm_source,
        utm_medium,
        utm_campaign,
        gclid,
        fbclid,
        msclkid,
        ttclid,
        device_type,
        pageviews_count,
        events_count,
        is_bounce,
        started_at,
        last_event_at
      FROM sessions
      ORDER BY last_event_at DESC
      LIMIT ?
    `, [limit])

    return sessions
  } catch (error) {
    logger.error('Error obteniendo sesiones:', error)
    throw error
  }
}

/**
 * Obtiene una sesión específica por ID
 */
export async function getSessionById(sessionId) {
  try {
    const session = await db.get('SELECT * FROM sessions WHERE session_id = ?', [sessionId])
    return session
  } catch (error) {
    logger.error('Error obteniendo sesión:', error)
    throw error
  }
}
