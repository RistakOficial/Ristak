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
 * Crea un nuevo registro de tracking (cada visita)
 */
export async function createSession(sessionData) {
  const {
    session_id,
    visitor_id,
    contact_id,
    full_name,
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
        contact_id,
        full_name,
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
        geo_city
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?
      )
    `, [
      session_id,
      visitor_id,
      contact_id || null,
      full_name || null,
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
      geoInfo.geo_city
    ])

    logger.info(`Evento registrado: ${event_name} - visitor: ${visitor_id}`)
    return { success: true }
  } catch (error) {
    logger.error('Error creando registro de tracking:', error)
    throw error
  }
}

/**
 * Vincula un visitor_id con un contact_id
 * Actualiza TODOS los registros históricos de sessions y también la tabla contacts
 */
export async function linkVisitorToContact(visitor_id, contact_id, full_name) {
  try {
    // 1. Actualizar TODOS los registros de sessions que tienen este visitor_id
    // para agregarles el contact_id y full_name
    const result = await db.run(`
      UPDATE sessions
      SET contact_id = ?, full_name = ?
      WHERE visitor_id = ? AND contact_id IS NULL
    `, [contact_id, full_name, visitor_id])

    logger.info(`Vinculados ${result.changes} registros históricos de visitor ${visitor_id} a contact ${contact_id}`)

    // 2. Actualizar la tabla contacts para guardar el visitor_id
    await db.run(`
      UPDATE contacts
      SET visitor_id = ?
      WHERE id = ? AND visitor_id IS NULL
    `, [visitor_id, contact_id])

    logger.info(`Guardado visitor_id ${visitor_id} en contacto ${contact_id}`)

    return { success: true, updated: result.changes }
  } catch (error) {
    logger.error('Error vinculando visitor a contact:', error)
    throw error
  }
}

/**
 * Obtiene registros de tracking recientes
 */
export async function getRecentSessions(limit = 50) {
  try {
    const sessions = await db.all(`
      SELECT
        session_id,
        visitor_id,
        contact_id,
        full_name,
        event_name,
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
        started_at,
        last_event_at
      FROM sessions
      ORDER BY started_at DESC
      LIMIT ?
    `, [limit])

    return sessions
  } catch (error) {
    logger.error('Error obteniendo sesiones:', error)
    throw error
  }
}

/**
 * Obtiene sesiones filtradas por rango de fechas
 * Para la página de Analytics
 */
export async function getSessionsByDateRange(startDate, endDate) {
  try {
    const sessions = await db.all(`
      SELECT
        session_id,
        visitor_id,
        contact_id,
        full_name,
        event_name,
        started_at as created_at,
        landing_url,
        referrer_url,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content,
        utm_term,
        gclid,
        fbclid,
        fbc,
        fbp,
        wbraid,
        gbraid,
        msclkid,
        ttclid,
        placement,
        source_platform,
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
        events_count,
        is_bounce,
        ip,
        user_agent
      FROM sessions
      WHERE DATE(started_at) >= DATE(?)
        AND DATE(started_at) <= DATE(?)
      ORDER BY started_at DESC
    `, [startDate, endDate])

    return sessions
  } catch (error) {
    logger.error('Error obteniendo sesiones por rango:', error)
    throw error
  }
}
