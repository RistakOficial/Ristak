import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import fetch from 'node-fetch'

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
 * Obtiene información geográfica basada en la IP usando ip-api.com
 * API gratuita sin necesidad de registro
 * Límite: 45 requests/minuto (suficiente para tracking normal)
 */
async function getGeoInfoFromIP(ip) {
  // Validar IP
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    logger.info('IP localhost o privada detectada, saltando geolocalización')
    return {
      geo_country: null,
      geo_region: null,
      geo_city: null
    }
  }

  try {
    // Llamar a ip-api.com (gratis, sin API key)
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city`)

    if (!response.ok) {
      logger.warn(`Error en API de geolocalización: ${response.status}`)
      return {
        geo_country: null,
        geo_region: null,
        geo_city: null
      }
    }

    const data = await response.json()

    if (data.status === 'success') {
      logger.info(`✅ Geolocalización obtenida para IP ${ip}: ${data.city}, ${data.regionName}, ${data.country}`)
      return {
        geo_country: data.country || null,
        geo_region: data.regionName || null,
        geo_city: data.city || null
      }
    } else {
      logger.warn(`Geolocalización falló para IP ${ip}: ${data.message || 'unknown error'}`)
      return {
        geo_country: null,
        geo_region: null,
        geo_city: null
      }
    }
  } catch (error) {
    logger.error(`Error obteniendo geolocalización para IP ${ip}:`, error.message)
    return {
      geo_country: null,
      geo_region: null,
      geo_city: null
    }
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
 * Extrae parámetros de ads (Facebook, Google, etc.)
 */
function extractAdsParams(data) {
  // Facebook Ads - parámetros directos de URL
  const campaign_id = data.campaign_id || null
  const adset_id = data.adset_id || null
  const ad_id = data.ad_id || null
  const campaign_name = data.campaign_name || data.utm_campaign || null
  const adset_name = data.adset_name || null
  const ad_name = data.ad_name || data.utm_content || null
  const placement = data.placement || data.site_source_name || null

  // Google Ads - parámetros con diferentes nombres
  const ad_group_id = data.adgroupid || null
  const ad_group_name = data.ad_group_name || null
  const creative_id = data.creative || null
  const keyword = data.keyword || data.utm_term || null
  const match_type = data.matchtype || null
  const network = data.network || null
  const search_query = data.search_query || null
  const ad_position = data.ad_position || null
  const site_source_name = data.site_source_name || null

  return {
    campaign_id,
    adset_id,
    ad_group_id,
    ad_id,
    campaign_name,
    adset_name,
    ad_group_name,
    ad_name,
    placement,
    site_source_name,
    network,
    match_type,
    keyword,
    search_query,
    creative_id,
    ad_position
  }
}

/**
 * Deriva source_platform y channel basado en los datos disponibles
 */
function deriveSourceInfo(data, utms, clickIds) {
  let source_platform = null
  let channel = null

  // Determinar platform
  if (clickIds.fbclid || clickIds.fbc || clickIds.fbp || data.campaign_id || data.adset_id) {
    source_platform = 'facebook'
  } else if (clickIds.gclid || clickIds.wbraid || clickIds.gbraid) {
    source_platform = 'google'
  } else if (clickIds.msclkid) {
    source_platform = 'microsoft'
  } else if (clickIds.ttclid) {
    source_platform = 'tiktok'
  } else if (utms.utm_source) {
    source_platform = utms.utm_source.toLowerCase()
  }

  // Determinar channel
  if (clickIds.fbclid || clickIds.gclid || clickIds.msclkid || clickIds.ttclid) {
    channel = 'paid'
  } else if (utms.utm_medium) {
    const medium = utms.utm_medium.toLowerCase()
    if (medium.includes('cpc') || medium.includes('ppc') || medium.includes('paid')) {
      channel = 'paid'
    } else if (medium.includes('organic') || medium === 'organic') {
      channel = 'organic'
    } else if (medium.includes('social')) {
      channel = 'social'
    } else if (medium.includes('email')) {
      channel = 'email'
    } else if (medium.includes('referral')) {
      channel = 'referral'
    } else {
      channel = medium
    }
  } else if (data.referrer && data.referrer !== '') {
    channel = 'referral'
  } else {
    channel = 'direct'
  }

  return {
    source_platform,
    channel
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
  const adsParams = extractAdsParams(data)
  const sourceInfo = deriveSourceInfo(data, utms, clickIds)

  // Obtener geolocalización desde la IP del request (en vez de confiar en el cliente)
  const geoInfo = await getGeoInfoFromIP(ip)

  const startedAt = new Date(ts).toISOString()

  // Validar si el contact_id existe en la DB antes de insertarlo
  let validContactId = null
  let validFullName = null
  let validEmail = null

  if (contact_id) {
    try {
      const contact = await db.get(
        'SELECT id, full_name, email FROM contacts WHERE id = ?',
        [contact_id]
      )
      if (contact) {
        validContactId = contact.id
        validFullName = contact.full_name || full_name
        validEmail = contact.email || null
      } else {
        logger.warn(`Contact ID ${contact_id} del localStorage no existe en DB - se guardará sin contact_id`)
      }
    } catch (err) {
      logger.warn(`Error validando contact_id: ${err.message}`)
    }
  }

  try {
    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        contact_id,
        full_name,
        email,
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
        channel,
        source_platform,
        campaign_id,
        adset_id,
        ad_group_id,
        ad_id,
        campaign_name,
        adset_name,
        ad_group_name,
        ad_name,
        placement,
        site_source_name,
        network,
        match_type,
        keyword,
        search_query,
        creative_id,
        ad_position,
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
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?
      )
      ON CONFLICT (session_id) DO UPDATE SET
        last_event_at = EXCLUDED.last_event_at,
        contact_id = COALESCE(EXCLUDED.contact_id, sessions.contact_id),
        full_name = COALESCE(EXCLUDED.full_name, sessions.full_name),
        email = COALESCE(EXCLUDED.email, sessions.email)
    `, [
      session_id,
      visitor_id,
      validContactId,
      validFullName,
      validEmail,
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
      sourceInfo.channel,
      sourceInfo.source_platform,
      adsParams.campaign_id,
      adsParams.adset_id,
      adsParams.ad_group_id,
      adsParams.ad_id,
      adsParams.campaign_name,
      adsParams.adset_name,
      adsParams.ad_group_name,
      adsParams.ad_name,
      adsParams.placement,
      adsParams.site_source_name,
      adsParams.network,
      adsParams.match_type,
      adsParams.keyword,
      adsParams.search_query,
      adsParams.creative_id,
      adsParams.ad_position,
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

    const logMsg = validContactId
      ? `Evento registrado: ${event_name} - visitor: ${visitor_id} - contact: ${validContactId}`
      : `Evento registrado: ${event_name} - visitor: ${visitor_id} (sin contact_id)`
    logger.info(logMsg)
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
    // Obtener email del contacto
    const contact = await db.get('SELECT email FROM contacts WHERE id = ?', [contact_id])
    const email = contact?.email || null

    // 1. Actualizar TODOS los registros de sessions que tienen este visitor_id
    // para agregarles el contact_id, full_name y email
    const result = await db.run(`
      UPDATE sessions
      SET contact_id = ?, full_name = ?, email = ?
      WHERE visitor_id = ? AND contact_id IS NULL
    `, [contact_id, full_name, email, visitor_id])

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
        started_at,
        last_event_at,
        created_at,
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
        channel,
        source_platform,
        campaign_id,
        adset_id,
        ad_group_id,
        ad_id,
        campaign_name,
        adset_name,
        ad_group_name,
        ad_name,
        placement,
        site_source_name,
        network,
        match_type,
        keyword,
        search_query,
        creative_id,
        ad_position,
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
    logger.info(`🔍 getSessionsByDateRange: ${startDate} to ${endDate}`)
    const usePostgres = Boolean(process.env.DATABASE_URL)
    logger.info(`📊 Using database: ${usePostgres ? 'PostgreSQL' : 'SQLite'}`)

    let query, params

    if (usePostgres) {
      // PostgreSQL query con LEFT JOIN para traer created_at del contacto
      query = `
        SELECT
          s.session_id,
          s.visitor_id,
          s.contact_id,
          s.full_name,
          s.event_name,
          s.started_at,
          s.landing_url,
          s.referrer_url,
          s.utm_source,
          s.utm_medium,
          s.utm_campaign,
          s.utm_content,
          s.utm_term,
          s.gclid,
          s.fbclid,
          s.fbc,
          s.fbp,
          s.wbraid,
          s.gbraid,
          s.msclkid,
          s.ttclid,
          s.channel,
          s.source_platform,
          s.campaign_id,
          s.adset_id,
          s.ad_group_id,
          s.ad_id,
          s.campaign_name,
          s.adset_name,
          s.ad_group_name,
          s.ad_name,
          s.placement,
          s.site_source_name,
          s.network,
          s.match_type,
          s.keyword,
          s.search_query,
          s.creative_id,
          s.ad_position,
          s.device_type,
          s.os,
          s.browser,
          s.browser_version,
          s.language,
          s.timezone,
          s.geo_country,
          s.geo_region,
          s.geo_city,
          s.ip,
          s.user_agent,
          c.created_at as contact_created_at
        FROM sessions s
        LEFT JOIN contacts c ON s.contact_id = c.id
        WHERE s.started_at::timestamp >= $1::timestamp
          AND s.started_at::timestamp < ($2::timestamp + INTERVAL '1 day')
        ORDER BY s.started_at DESC
      `
      params = [startDate, endDate]
    } else {
      // SQLite query con LEFT JOIN para traer created_at del contacto
      query = `
        SELECT
          s.session_id,
          s.visitor_id,
          s.contact_id,
          s.full_name,
          s.event_name,
          s.started_at,
          s.landing_url,
          s.referrer_url,
          s.utm_source,
          s.utm_medium,
          s.utm_campaign,
          s.utm_content,
          s.utm_term,
          s.gclid,
          s.fbclid,
          s.fbc,
          s.fbp,
          s.wbraid,
          s.gbraid,
          s.msclkid,
          s.ttclid,
          s.channel,
          s.source_platform,
          s.campaign_id,
          s.adset_id,
          s.ad_group_id,
          s.ad_id,
          s.campaign_name,
          s.adset_name,
          s.ad_group_name,
          s.ad_name,
          s.placement,
          s.site_source_name,
          s.network,
          s.match_type,
          s.keyword,
          s.search_query,
          s.creative_id,
          s.ad_position,
          s.device_type,
          s.os,
          s.browser,
          s.browser_version,
          s.language,
          s.timezone,
          s.geo_country,
          s.geo_region,
          s.geo_city,
          s.ip,
          s.user_agent,
          c.created_at as contact_created_at
        FROM sessions s
        LEFT JOIN contacts c ON s.contact_id = c.id
        WHERE DATE(s.started_at) >= DATE(?)
          AND DATE(s.started_at) <= DATE(?)
        ORDER BY s.started_at DESC
      `
      params = [startDate, endDate]
    }

    logger.info(`🔄 Ejecutando query con params: ${JSON.stringify(params)}`)
    const sessions = await db.all(query, params)
    logger.info(`✅ Query exitoso, encontradas ${sessions.length} sesiones`)
    return sessions
  } catch (error) {
    logger.error('❌ Error obteniendo sesiones por rango:', error)
    logger.error('Query:', query?.substring(0, 200))
    logger.error('Params:', params)
    logger.error('Stack:', error.stack)
    throw error
  }
}
