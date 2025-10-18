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
  const geoInfo = extractGeoInfo(data)
  const adsParams = extractAdsParams(data)
  const sourceInfo = deriveSourceInfo(data, utms, clickIds)

  const startedAt = new Date(ts).toISOString()

  // Validar si el contact_id existe en la DB antes de insertarlo
  let validContactId = null
  let validFullName = null

  if (contact_id) {
    try {
      const contact = await db.get(
        'SELECT id, name FROM contacts WHERE id = ?',
        [contact_id]
      )
      if (contact) {
        validContactId = contact.id
        validFullName = contact.name || full_name
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
        ?, ?, ?
      )
      ON CONFLICT (session_id) DO UPDATE SET
        last_event_at = EXCLUDED.last_event_at,
        contact_id = COALESCE(EXCLUDED.contact_id, sessions.contact_id),
        full_name = COALESCE(EXCLUDED.full_name, sessions.full_name)
    `, [
      session_id,
      visitor_id,
      validContactId,
      validFullName,
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
    const sessions = await db.all(`
      SELECT
        session_id,
        visitor_id,
        contact_id,
        full_name,
        event_name,
        started_at,
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
        device_type,
        os,
        browser,
        browser_version,
        language,
        timezone,
        geo_country,
        geo_region,
        geo_city,
        ip,
        user_agent,
        pageviews_count,
        events_count,
        is_bounce
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
