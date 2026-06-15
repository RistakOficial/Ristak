import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import fetch from 'node-fetch'

/**
 * Decodifica un valor UTM (convierte + a espacios y decodifica URL encoding)
 */
function decodeUtmValue(value) {
  if (!value || value === 'null' || value === 'undefined') {
    return null
  }
  try {
    // Reemplazar + por espacios, luego decodificar URL encoding
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch (err) {
    // Si falla la decodificación, retornar el valor original
    return value
  }
}

/**
 * Extrae parámetros UTM de un objeto de datos y los decodifica
 */
function extractUtmParams(data) {
  return {
    utm_source: decodeUtmValue(data.utm_source),
    utm_medium: decodeUtmValue(data.utm_medium),
    utm_campaign: decodeUtmValue(data.utm_campaign),
    utm_term: decodeUtmValue(data.utm_term),
    utm_content: decodeUtmValue(data.utm_content)
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
 * Extrae parámetros de ads (Facebook, Google, etc.) y decodifica nombres
 */
function extractAdsParams(data) {
  // Facebook Ads - parámetros directos de URL
  const campaign_id = data.campaign_id || null
  const adset_id = data.adset_id || null
  const ad_id = data.ad_id || null
  const campaign_name = decodeUtmValue(data.campaign_name || data.utm_campaign)
  const adset_name = decodeUtmValue(data.adset_name)
  const ad_name = decodeUtmValue(data.ad_name || data.utm_content)
  const placement = decodeUtmValue(data.placement || data.site_source_name)

  // Google Ads - parámetros con diferentes nombres
  const ad_group_id = data.adgroupid || null
  const ad_group_name = decodeUtmValue(data.ad_group_name)
  const creative_id = data.creative || null
  const keyword = decodeUtmValue(data.keyword || data.utm_term)
  const match_type = data.matchtype || null
  const network = data.network || null
  const search_query = decodeUtmValue(data.search_query)
  const ad_position = data.ad_position || null
  const site_source_name = decodeUtmValue(data.site_source_name)

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

function cleanTrackingString(value, maxLength = 500) {
  const cleaned = String(value || '').trim()
  return cleaned ? cleaned.slice(0, maxLength) : null
}

function extractNativeSiteInfo(data = {}) {
  const explicitSource = cleanTrackingString(data.tracking_source, 80)
  const hasSiteContext = Boolean(data.site_id || data.siteId || data.public_site_id)
  const trackingSource = explicitSource || (hasSiteContext ? 'native_site' : 'external_pixel')

  return {
    tracking_source: trackingSource,
    site_id: cleanTrackingString(data.site_id || data.siteId || data.public_site_id, 120),
    site_slug: cleanTrackingString(data.site_slug || data.siteSlug, 220),
    site_name: cleanTrackingString(data.site_name || data.siteName, 260),
    site_type: cleanTrackingString(data.site_type || data.siteType, 80),
    form_site_id: cleanTrackingString(data.form_site_id || data.formSiteId, 160),
    form_site_name: cleanTrackingString(data.form_site_name || data.formSiteName, 260),
    public_page_id: cleanTrackingString(data.public_page_id || data.publicPageId || data.page_id || data.pageId, 160),
    public_page_title: cleanTrackingString(data.public_page_title || data.publicPageTitle || data.page_title || data.pageTitle, 260),
    conversion_type: cleanTrackingString(data.conversion_type || data.conversionType, 120),
    submission_id: cleanTrackingString(data.submission_id || data.submissionId, 160)
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
  const nativeSiteInfo = extractNativeSiteInfo(data)

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
    // CADA page_view crea un registro NUEVO (el id se genera automáticamente)
    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        contact_id,
        full_name,
        email,
        event_name,
        started_at,
        page_url,
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
        geo_city,
        tracking_source,
        site_id,
        site_slug,
        site_name,
        site_type,
        form_site_id,
        form_site_name,
        public_page_id,
        public_page_title,
        conversion_type,
        submission_id
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `, [
      session_id,
      visitor_id,
      validContactId,
      validFullName,
      validEmail,
      event_name,
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
      geoInfo.geo_city,
      nativeSiteInfo.tracking_source,
      nativeSiteInfo.site_id,
      nativeSiteInfo.site_slug,
      nativeSiteInfo.site_name,
      nativeSiteInfo.site_type,
      nativeSiteInfo.form_site_id,
      nativeSiteInfo.form_site_name,
      nativeSiteInfo.public_page_id,
      nativeSiteInfo.public_page_title,
      nativeSiteInfo.conversion_type,
      nativeSiteInfo.submission_id
    ])

    const pageUrl = data.url || 'unknown'
    const logMsg = validContactId
      ? `Page view: ${pageUrl} - visitor: ${visitor_id} - contact: ${validContactId}`
      : `Page view: ${pageUrl} - visitor: ${visitor_id} (anónimo)`
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
        created_at,
        page_url,
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
        geo_city,
        COALESCE(tracking_source, 'external_pixel') as tracking_source,
        site_id,
        site_slug,
        site_name,
        site_type,
        form_site_id,
        form_site_name,
        public_page_id,
        public_page_title,
        conversion_type,
        submission_id
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
export async function getSessionMetricsByDateRange(startDate, endDate) {
  try {
    logger.info(`🔍 getSessionMetricsByDateRange: ${startDate} to ${endDate}`)

    const { resolveDateRangeWithGHLTimezone } = await import('../utils/dateUtils.js')
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })

    const query = `
      WITH view_sessions AS (
        SELECT visitor_id, session_id
        FROM sessions
        WHERE started_at >= ?
          AND started_at <= ?
          AND COALESCE(event_name, 'page_view') IN ('session_start', 'page_view', 'native_site_view')
      )
      SELECT
        (SELECT COUNT(*) FROM view_sessions) as page_views,
        (SELECT COUNT(DISTINCT visitor_id) FROM view_sessions) as unique_visitors,
        (SELECT COUNT(DISTINCT session_id) FROM view_sessions) as unique_sessions,
        (
          SELECT COUNT(*)
          FROM (
            SELECT visitor_id
            FROM view_sessions
            WHERE visitor_id IS NOT NULL AND visitor_id != ''
            GROUP BY visitor_id
            HAVING COUNT(DISTINCT session_id) > 1
          ) returning_visitors
        ) as returning_users
    `
    const params = [range.startUtc, range.endUtc]
    const row = await db.get(query, params)

    return {
      pageViews: Number(row?.page_views || 0),
      uniqueVisitors: Number(row?.unique_visitors || 0),
      uniqueSessions: Number(row?.unique_sessions || 0),
      returningUsers: Number(row?.returning_users || 0)
    }
  } catch (error) {
    logger.error('❌ Error obteniendo métricas de sesiones por rango:', error)
    throw error
  }
}

export async function getSessionsByDateRange(startDate, endDate, options = {}) {
  let query = ''
  let params = []

  try {
    logger.info(`🔍 getSessionsByDateRange: ${startDate} to ${endDate}`)

    // Usar timezone de HighLevel para consistencia con Dashboard
    const { resolveDateRangeWithGHLTimezone } = await import('../utils/dateUtils.js')
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })

    logger.info(`🕐 Timezone range: ${range.startUtc} → ${range.endUtc}`)

    const compactForAnalytics = options.payload === 'analytics'
    const selectColumns = compactForAnalytics
      ? `
        s.id,
        s.session_id,
        s.visitor_id,
        s.contact_id,
        s.full_name,
        s.email,
        s.event_name,
        s.started_at,
        s.created_at,
        s.page_url,
        s.referrer_url,
        s.utm_source,
        s.utm_medium,
        s.utm_campaign,
        s.utm_term,
        s.utm_content,
        s.source_platform,
        s.campaign_id,
        s.adset_id,
        s.ad_group_id,
        s.ad_id,
        s.placement,
        s.site_source_name,
        s.device_type,
        s.os,
        s.browser,
        s.geo_country,
        s.geo_city,
        COALESCE(s.tracking_source, 'external_pixel') as tracking_source,
        s.site_id,
        s.site_slug,
        s.site_name,
        s.site_type,
        s.form_site_id,
        s.form_site_name,
        s.submission_id,
        c.created_at as contact_created_at,
        c.purchases_count as contact_purchases_count,
        c.total_paid as contact_total_paid,
        c.appointment_date as contact_appointment_date`
      : `
        s.id,
        s.session_id,
        s.visitor_id,
        s.contact_id,
        s.full_name,
        s.email,
        s.event_name,
        s.started_at,
        s.created_at,
        s.page_url,
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
        COALESCE(s.tracking_source, 'external_pixel') as tracking_source,
        s.site_id,
        s.site_slug,
        s.site_name,
        s.site_type,
        s.form_site_id,
        s.form_site_name,
        s.public_page_id,
        s.public_page_title,
        s.conversion_type,
        s.submission_id,
        c.created_at as contact_created_at,
        c.purchases_count as contact_purchases_count,
        c.total_paid as contact_total_paid,
        c.appointment_date as contact_appointment_date`

    query = `
      SELECT
        ${selectColumns},
        CASE
          WHEN c.id IS NOT NULL AND (
            c.appointment_date IS NOT NULL OR EXISTS (
              SELECT 1
              FROM appointments a
              WHERE a.contact_id = c.id
            )
          ) THEN 1 ELSE 0
        END as contact_has_appointment,
        CASE
          WHEN c.id IS NOT NULL AND (
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
          ) THEN 1 ELSE 0
        END as contact_has_attended_appointment
      FROM sessions s
      LEFT JOIN contacts c ON s.contact_id = c.id
      WHERE s.started_at >= ? AND s.started_at <= ?
      ORDER BY s.started_at DESC
    `
    params = [range.startUtc, range.endUtc]

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

/**
 * Unifica todos los visitor_ids de un contacto al más viejo (primera visita)
 *
 * Esto resuelve el problema de múltiples visitor_ids por dispositivo/navegador:
 * - Usuario entra desde desktop → visitor_id_1
 * - Usuario regresa desde mobile → visitor_id_2
 * - Usuario se registra → contact_id vinculado a ambos visitor_ids
 *
 * Esta función:
 * 1. Obtiene el visitor_id MÁS VIEJO (primera visita)
 * 2. Actualiza TODAS las sesiones para usar ese visitor_id
 * 3. Guarda ese visitor_id en contacts como el identificador oficial
 *
 * @param {string} contactId - ID del contacto en HighLevel
 * @returns {Promise<{success: boolean, canonicalVisitorId: string, sessionsUpdated: number}>}
 */
export async function unifyVisitorIds(contactId) {
  try {
    // PASO 1: Obtener el visitor_id MÁS VIEJO (primera visita)
    const oldestSession = await db.get(`
      SELECT visitor_id, created_at
      FROM sessions
      WHERE contact_id = ?
      ORDER BY created_at ASC
      LIMIT 1
    `, [contactId])

    if (!oldestSession) {
      logger.warn(`No se encontraron sesiones para contacto ${contactId}`)
      return { success: false, canonicalVisitorId: null, sessionsUpdated: 0 }
    }

    const canonicalVisitorId = oldestSession.visitor_id

    // PASO 2: Obtener todos los visitor_ids diferentes de este contacto
    const allVisitorIds = await db.all(`
      SELECT DISTINCT visitor_id
      FROM sessions
      WHERE contact_id = ?
        AND visitor_id != ?
    `, [contactId, canonicalVisitorId])

    if (allVisitorIds.length === 0) {
      logger.info(`✅ Contacto ${contactId} ya tiene visitor_id unificado: ${canonicalVisitorId}`)

      // Asegurarse de que la tabla contacts tenga el visitor_id guardado
      await db.run(`
        UPDATE contacts
        SET visitor_id = ?
        WHERE id = ?
      `, [canonicalVisitorId, contactId])

      return { success: true, canonicalVisitorId, sessionsUpdated: 0 }
    }

    logger.info(`🔄 Unificando ${allVisitorIds.length} visitor_ids diferentes para contacto ${contactId}:`)
    logger.info(`   → Canonical (más viejo): ${canonicalVisitorId}`)
    logger.info(`   → A reemplazar: ${allVisitorIds.map(v => v.visitor_id).join(', ')}`)

    // PASO 3: Actualizar TODAS las sesiones para usar el visitor_id canónico
    const result = await db.run(`
      UPDATE sessions
      SET visitor_id = ?
      WHERE contact_id = ?
        AND visitor_id != ?
    `, [canonicalVisitorId, contactId, canonicalVisitorId])

    logger.info(`✅ Actualizadas ${result.changes} sesiones con visitor_id unificado`)

    // PASO 4: Guardar visitor_id canónico en tabla contacts
    await db.run(`
      UPDATE contacts
      SET visitor_id = ?
      WHERE id = ?
    `, [canonicalVisitorId, contactId])

    logger.info(`✅ Contacto ${contactId} → visitor_id unificado: ${canonicalVisitorId}`)

    return {
      success: true,
      canonicalVisitorId,
      sessionsUpdated: result.changes
    }
  } catch (error) {
    logger.error(`Error unificando visitor_ids para contacto ${contactId}:`, error)
    throw error
  }
}
