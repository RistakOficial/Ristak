import { databaseDialect, db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { nonTestPaymentCondition, SUCCESS_PAYMENT_STATUSES } from '../utils/paymentMode.js'
import { linkVideoVisitorToContact, unifyVideoPlaybackVisitorIds } from './videoTrackingService.js'
import {
  linkRelatedTrackingToContact,
  recordTrackingIdentityMatch,
  resolveTrackingIdentity
} from './trackingIdentityService.js'
import {
  buildFallbackVisitorIdFromSession,
  isTrustedTrackingVisitorId
} from '../utils/trackingVisitorIdentity.js'
import { invalidateTrackingAnalyticsCache } from './trackingAnalyticsCache.js'
import fetch from 'node-fetch'

const SUCCESS_PAYMENT_STATUS_SQL = SUCCESS_PAYMENT_STATUSES
  .map(status => `'${String(status).replace(/'/g, "''")}'`)
  .join(', ')
const INACTIVE_APPOINTMENT_STATUS_SQL = [
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
].map(status => `'${status}'`).join(', ')
const ATTENDED_APPOINTMENT_STATUS_SQL = [
  'show',
  'showed',
  'completed',
  'complete',
  'attended'
].map(status => `'${status}'`).join(', ')
const TRACKING_HISTORY_LINK_BATCH_SIZE = 200

const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve))

async function linkSessionHistoryInBatches({ visitorId, contactId, fullName, email }) {
  let updated = 0
  let batches = 0

  while (true) {
    // Cada statement tiene su propio commit. Esto evita encadenar decenas de
    // miles de versiones sobre las mismas cabezas day/quarter de la proyección.
    const result = await db.run(`
      UPDATE sessions
      SET contact_id = ?, full_name = ?, email = ?
      WHERE id IN (
        SELECT id
        FROM sessions
        WHERE visitor_id = ?
          AND contact_id IS NULL
        ORDER BY started_at DESC, id DESC
        LIMIT ?
      )
        AND visitor_id = ?
        AND contact_id IS NULL
    `, [
      contactId,
      fullName,
      email,
      visitorId,
      TRACKING_HISTORY_LINK_BATCH_SIZE,
      visitorId
    ])
    const changes = Number(result?.changes || 0)
    if (changes === 0) break

    updated += changes
    batches += 1
    if (changes < TRACKING_HISTORY_LINK_BATCH_SIZE) break
    await yieldToEventLoop()
  }

  return { updated, batches }
}

async function linkPostgresSessionHistoryAtomically({ visitorId, contactId, fullName, email }) {
  const oldVisitorKey = `visitor:${visitorId}`
  const newVisitorKey = `contact:${contactId}`

  return db.transaction(async transaction => {
    // Flag local a esta transacción/conexión: el BEFORE trigger sigue calculando
    // visitor_key; sólo evitamos miles de reparaciones AFTER row-by-row.
    await transaction.get(`
      SELECT set_config('ristak.skip_tracking_visitor_projection', 'on', true) AS projection_mode
    `)

    const result = await transaction.run(`
      UPDATE sessions
      SET contact_id = ?, full_name = ?, email = ?
      WHERE visitor_id = ? AND contact_id IS NULL
    `, [contactId, fullName, email, visitorId])
    const updated = Number(result?.changes || 0)
    if (updated === 0) return { updated: 0, batches: 0 }

    // Rehacer sólo las identidades afectadas dentro del mismo commit. Ante
    // cualquier error, sesiones y proyección regresan juntas.
    await transaction.run(`
      DELETE FROM tracking_visitor_latest
      WHERE visitor_key IN (?, ?)
    `, [oldVisitorKey, newVisitorKey])

    await transaction.run(`
      WITH scoped_sessions AS (
        SELECT
          scopes.scope_type,
          scopes.scope_id,
          buckets.bucket_kind,
          buckets.bucket_start,
          source.visitor_key,
          source.id AS session_row_id,
          source.started_at AS latest_at
        FROM sessions source
        CROSS JOIN LATERAL (
          VALUES
            ('all'::text, ''::text),
            ('campaign'::text, source.campaign_id),
            ('adset'::text, source.adset_id),
            ('ad'::text, source.ad_id)
        ) scopes(scope_type, scope_id)
        CROSS JOIN LATERAL (
          VALUES
            (
              'day'::text,
              date_trunc('day', source.started_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
            ),
            (
              'quarter'::text,
              (
                date_trunc('hour', source.started_at AT TIME ZONE 'UTC')
                  + ((EXTRACT(MINUTE FROM source.started_at AT TIME ZONE 'UTC')::INTEGER / 15) * INTERVAL '15 minutes')
              ) AT TIME ZONE 'UTC'
            )
        ) buckets(bucket_kind, bucket_start)
        WHERE source.visitor_key IN (?, ?)
          AND source.started_at IS NOT NULL
          AND (scopes.scope_type = 'all' OR COALESCE(scopes.scope_id, '') != '')
      ), latest_scoped_sessions AS (
        SELECT DISTINCT ON (
          scope_type,
          scope_id,
          bucket_kind,
          bucket_start,
          visitor_key
        )
          scope_type,
          scope_id,
          bucket_kind,
          bucket_start,
          visitor_key,
          session_row_id,
          latest_at
        FROM scoped_sessions
        ORDER BY
          scope_type,
          scope_id,
          bucket_kind,
          bucket_start,
          visitor_key,
          latest_at DESC,
          session_row_id DESC
      )
      INSERT INTO tracking_visitor_latest (
        scope_type,
        scope_id,
        bucket_kind,
        bucket_start,
        visitor_key,
        session_row_id,
        latest_at,
        updated_at
      )
      SELECT
        scope_type,
        scope_id,
        bucket_kind,
        bucket_start,
        visitor_key,
        session_row_id,
        latest_at,
        CURRENT_TIMESTAMP
      FROM latest_scoped_sessions
      ON CONFLICT (scope_type, scope_id, bucket_kind, bucket_start, visitor_key) DO UPDATE SET
        session_row_id = EXCLUDED.session_row_id,
        latest_at = EXCLUDED.latest_at,
        updated_at = CURRENT_TIMESTAMP
      WHERE (EXCLUDED.latest_at, EXCLUDED.session_row_id) >
            (tracking_visitor_latest.latest_at, tracking_visitor_latest.session_row_id)
    `, [oldVisitorKey, newVisitorKey])

    return { updated, batches: 1 }
  })
}

function validPaymentPredicate(alias = 'p') {
  const prefix = alias ? `${alias}.` : ''
  return `
    COALESCE(${prefix}amount, 0) > 0
    AND LOWER(COALESCE(${prefix}status, '')) IN (${SUCCESS_PAYMENT_STATUS_SQL})
    AND ${nonTestPaymentCondition(alias)}
  `
}

export function getVisitorIdentityExpression(alias = '') {
  const prefix = alias ? `${alias}.` : ''
  return `
    CASE
      WHEN ${prefix}contact_id IS NOT NULL AND ${prefix}contact_id != '' THEN 'contact:' || ${prefix}contact_id
      WHEN ${prefix}visitor_id IS NOT NULL AND ${prefix}visitor_id != '' THEN 'visitor:' || ${prefix}visitor_id
      WHEN ${prefix}session_id IS NOT NULL AND ${prefix}session_id != '' THEN 'session:' || ${prefix}session_id
      ELSE NULL
    END
  `
}

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
    // (TRK-003) timeout duro para que un tercero lento nunca cuelgue /collect
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2500)
    let response
    try {
      // Llamar a ip-api.com (gratis, sin API key)
      response = await fetch(
        `http://ip-api.com/json/${ip}?fields=status,country,regionName,city`,
        { signal: controller.signal }
      )
    } finally {
      clearTimeout(timeout)
    }

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

  const trustedVisitorId = isTrustedTrackingVisitorId(visitor_id) ? visitor_id : null
  const storedVisitorId = trustedVisitorId || buildFallbackVisitorIdFromSession(session_id)
  const utms = extractUtmParams(data)
  const clickIds = extractClickIds(data)
  const deviceInfo = extractDeviceInfo(data)
  const adsParams = extractAdsParams(data)
  const sourceInfo = deriveSourceInfo(data, utms, clickIds)
  const nativeSiteInfo = extractNativeSiteInfo(data)
  const identity = await resolveTrackingIdentity({
    visitorId: trustedVisitorId,
    contactId: contact_id,
    data: {
      ...data,
      ...utms,
      ...clickIds,
      ...adsParams,
      ...nativeSiteInfo
    },
    ip,
    userAgent: user_agent,
    now: new Date(ts)
  })

  // (TRK-003) NO resolver geolocalización de forma síncrona aquí: bloqueaba /collect
  // contra un tercero (ip-api.com) en el camino caliente y degradaba el endpoint en
  // tráfico alto. Se inserta la sesión sin geo y se resuelve en segundo plano más abajo.
  const geoInfo = { geo_country: null, geo_region: null, geo_city: null }

  const startedAt = new Date(ts).toISOString()

  // Validar si el contact_id existe en la DB antes de insertarlo
  let validContactId = null
  let validFullName = null
  let validEmail = null

  const candidateContactId = identity.accepted && identity.contactId
    ? identity.contactId
    : contact_id

  if (candidateContactId) {
    try {
      const contact = await db.get(
        'SELECT id, full_name, email FROM contacts WHERE id = ?',
        [candidateContactId]
      )
      if (contact) {
        validContactId = contact.id
        validFullName = contact.full_name || full_name || identity.fullName
        validEmail = contact.email || null
      } else {
        logger.warn(`Contact ID ${candidateContactId} del tracking no existe en DB - se guardará sin contact_id`)
      }
    } catch (err) {
      logger.warn(`Error validando contact_id: ${err.message}`)
    }
  }

  try {
    // (TRK-002) Dedup de sesiones: el pixel reenvía el mismo evento de sesión
    // (p. ej. session_end o reintentos de envío) e infla page_views / unique_sessions.
    // Antes de insertar, se descarta un evento idéntico ya registrado usando una clave
    // estable formada por columnas existentes: session_id + event_name + started_at.
    // (Mismo session_id, mismo tipo de evento y mismo timestamp de origen = duplicado.)
    // No se cambia el schema; solo se evita el doble conteo del mismo evento de sesión.
    if (session_id) {
      try {
        const existing = await db.get(`
          SELECT id FROM sessions
          WHERE session_id = ?
            AND COALESCE(event_name, '') = COALESCE(?, '')
            AND started_at = ?
          LIMIT 1
        `, [session_id, event_name, startedAt])

        if (existing) {
          logger.info(`(TRK-002) Evento de sesión duplicado ignorado: session=${session_id} event=${event_name || 'page_view'} started_at=${startedAt}`)
          return { success: true, deduped: true }
        }
      } catch (dedupErr) {
        // Si la verificación de dedup falla, no bloquear el tracking: se continúa e inserta.
        logger.warn(`(TRK-002) Falló verificación de dedup de sesión: ${dedupErr.message}`)
      }
    }

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
        submission_id,
        identity_hash,
        device_signature,
        network_signature,
        match_method,
        match_confidence,
        identity_evidence_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
    `, [
      session_id,
      storedVisitorId,
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
      nativeSiteInfo.submission_id,
      identity.signals.identityHash,
      identity.signals.deviceSignature,
      identity.signals.networkSignature,
      identity.matchMethod,
      identity.matchConfidence,
      identity.evidenceJson
    ])

    await recordTrackingIdentityMatch({
      subjectKind: 'session',
      subjectId: session_id,
      visitorId: trustedVisitorId || storedVisitorId,
      sessionId: session_id,
      contactId: validContactId,
      matchMethod: identity.matchMethod,
      matchConfidence: identity.matchConfidence,
      accepted: Boolean(validContactId && identity.accepted),
      signals: identity.signals,
      evidenceJson: identity.evidenceJson
    })

    if (validContactId) {
      await linkRelatedTrackingToContact({
        contactId: validContactId,
        visitorId: trustedVisitorId,
        fullName: validFullName,
        email: validEmail,
        signals: identity.signals,
        data: {
          ...data,
          ...utms,
          ...clickIds,
          ...adsParams,
          ...nativeSiteInfo
        }
      })
    }

    const pageUrl = data.url || 'unknown'
    const logMsg = validContactId
      ? `Page view: ${pageUrl} - visitor: ${storedVisitorId} - contact: ${validContactId}`
      : `Page view: ${pageUrl} - visitor: ${storedVisitorId} (anónimo)`
    logger.info(logMsg)

    // (TRK-003) Resolver geolocalización en segundo plano (fire-and-forget) para no
    // bloquear la respuesta de /collect. El id de sessions es un UUID/TEXT autogenerado
    // (no un autoincrement), así que lastID no es fiable; se ubica el registro recién
    // insertado por session_id + started_at (su geo aún es NULL). Cualquier fallo del
    // tercero queda contenido en este bloque.
    resolveSessionGeoInBackground({ sessionId: session_id, startedAt, ip })

    invalidateTrackingAnalyticsCache()

    return { success: true }
  } catch (error) {
    logger.error('Error creando registro de tracking:', error)
    throw error
  }
}

/**
 * (TRK-003) Resuelve la geolocalización fuera del camino caliente de /collect y
 * actualiza la sesión ya insertada. Es fire-and-forget: nunca propaga errores ni
 * bloquea al llamador.
 */
function resolveSessionGeoInBackground({ sessionId, startedAt, ip }) {
  Promise.resolve()
    .then(async () => {
      const geoInfo = await getGeoInfoFromIP(ip)
      if (!geoInfo.geo_country && !geoInfo.geo_region && !geoInfo.geo_city) {
        return
      }

      // Ubicar la fila recién insertada de esta sesión (su geo aún es NULL).
      await db.run(`
        UPDATE sessions
        SET geo_country = ?, geo_region = ?, geo_city = ?
        WHERE id = (
          SELECT id FROM sessions
          WHERE session_id = ?
            AND started_at = ?
            AND geo_country IS NULL
            AND geo_region IS NULL
            AND geo_city IS NULL
          ORDER BY created_at DESC
          LIMIT 1
        )
      `, [geoInfo.geo_country, geoInfo.geo_region, geoInfo.geo_city, sessionId, startedAt])
    })
    .catch((error) => {
      logger.warn(`Geolocalización en segundo plano falló para IP ${ip}: ${error.message}`)
    })
}

/**
 * Vincula un visitor_id con un contact_id
 * Actualiza TODOS los registros históricos de sessions y también la tabla contacts
 */
export async function linkVisitorToContact(visitor_id, contact_id, full_name) {
  try {
    if (!isTrustedTrackingVisitorId(visitor_id)) {
      logger.warn(`Visitor_id no confiable ignorado al vincular contacto ${contact_id}: ${visitor_id || '(vacío)'}`)
      return {
        success: false,
        skipped: true,
        reason: 'untrusted_visitor_id',
        updated: 0,
        videoUpdated: 0
      }
    }

    // Obtener email del contacto
    const contact = await db.get('SELECT email FROM contacts WHERE id = ?', [contact_id])
    const email = contact?.email || null

    // 1. PostgreSQL reconstruye la proyección una sola vez y atómicamente;
    // SQLite usa commits acotados que dejan respirar otras solicitudes.
    const historyResult = databaseDialect === 'postgres'
      ? await linkPostgresSessionHistoryAtomically({
          visitorId: visitor_id,
          contactId: contact_id,
          fullName: full_name,
          email
        })
      : await linkSessionHistoryInBatches({
          visitorId: visitor_id,
          contactId: contact_id,
          fullName: full_name,
          email
        })

    logger.info(`Vinculados ${historyResult.updated} registros históricos de visitor ${visitor_id} a contact ${contact_id} en ${historyResult.batches} lote(s)`)

    // 2. Actualizar la tabla contacts para guardar el visitor_id
    await db.run(`
      UPDATE contacts
      SET visitor_id = ?
      WHERE id = ? AND visitor_id IS NULL
    `, [visitor_id, contact_id])

    logger.info(`Guardado visitor_id ${visitor_id} en contacto ${contact_id}`)

    const videoResult = await linkVideoVisitorToContact(visitor_id, contact_id, full_name)
    if (videoResult.sessionsUpdated > 0 || videoResult.eventsUpdated > 0) {
      logger.info(`Vinculadas ${videoResult.sessionsUpdated} reproducciones de video de visitor ${visitor_id} a contact ${contact_id}`)
    }

    if (historyResult.updated > 0) invalidateTrackingAnalyticsCache()

    return {
      success: true,
      updated: historyResult.updated,
      batches: historyResult.batches,
      videoUpdated: videoResult.sessionsUpdated
    }
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
        SELECT
          ${getVisitorIdentityExpression()} AS visitor_key,
          session_id
        FROM sessions
        WHERE started_at >= ?
          AND started_at <= ?
          AND COALESCE(event_name, 'page_view') IN ('session_start', 'page_view', 'native_site_view')
      )
      SELECT
        (SELECT COUNT(*) FROM view_sessions) as page_views,
        (SELECT COUNT(DISTINCT visitor_key) FROM view_sessions) as unique_visitors,
        (SELECT COUNT(DISTINCT session_id) FROM view_sessions) as unique_sessions,
        (
          SELECT COUNT(*)
          FROM (
            SELECT visitor_key
            FROM view_sessions
            WHERE visitor_key IS NOT NULL AND visitor_key != ''
            GROUP BY visitor_key
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
    const requestedLimit = Number.parseInt(String(options.limit || ''), 10)
    const requestedOffset = Number.parseInt(String(options.offset || ''), 10)
    const pageLimit = Math.min(200, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 50))
    const pageOffset = Math.max(0, Number.isFinite(requestedOffset) ? requestedOffset : 0)
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
        COALESCE((
          SELECT COUNT(*)
          FROM payments p
          WHERE p.contact_id = c.id
            AND ${validPaymentPredicate('p')}
        ), 0) as contact_purchases_count,
        COALESCE((
          SELECT SUM(p.amount)
          FROM payments p
          WHERE p.contact_id = c.id
            AND ${validPaymentPredicate('p')}
        ), 0) as contact_total_paid,
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
        COALESCE((
          SELECT COUNT(*)
          FROM payments p
          WHERE p.contact_id = c.id
            AND ${validPaymentPredicate('p')}
        ), 0) as contact_purchases_count,
        COALESCE((
          SELECT SUM(p.amount)
          FROM payments p
          WHERE p.contact_id = c.id
            AND ${validPaymentPredicate('p')}
        ), 0) as contact_total_paid,
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
                AND LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN (${INACTIVE_APPOINTMENT_STATUS_SQL})
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
                AND LOWER(COALESCE(aa.appointment_status, aa.status, '')) IN (${ATTENDED_APPOINTMENT_STATUS_SQL})
            )
          ) THEN 1 ELSE 0
        END as contact_has_attended_appointment
      FROM sessions s
      LEFT JOIN contacts c ON s.contact_id = c.id
      WHERE s.started_at >= ? AND s.started_at <= ?
      ORDER BY s.started_at DESC, s.id DESC
      LIMIT ? OFFSET ?
    `
    params = [range.startUtc, range.endUtc, pageLimit, pageOffset]

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
    const visitorRows = await db.all(`
      SELECT visitor_id, MIN(created_at) as created_at
      FROM sessions
      WHERE contact_id = ?
        AND visitor_id IS NOT NULL
        AND visitor_id != ''
      GROUP BY visitor_id
      ORDER BY MIN(created_at) ASC
    `, [contactId])

    if (!visitorRows.length) {
      logger.warn(`No se encontraron sesiones para contacto ${contactId}`)
      return { success: false, canonicalVisitorId: null, sessionsUpdated: 0 }
    }

    const trustedVisitorRows = visitorRows.filter(row => isTrustedTrackingVisitorId(row.visitor_id))
    if (!trustedVisitorRows.length) {
      logger.warn(`No se encontró visitor_id confiable para unificar contacto ${contactId}`)
      return {
        success: false,
        canonicalVisitorId: null,
        sessionsUpdated: 0,
        skipped: true,
        reason: 'no_trusted_visitor_id'
      }
    }

    const oldestSession = trustedVisitorRows[0]
    const canonicalVisitorId = oldestSession.visitor_id

    // PASO 2: Obtener todos los visitor_ids diferentes de este contacto
    const allVisitorIds = trustedVisitorRows
      .filter(row => row.visitor_id !== canonicalVisitorId)
      .map(row => row.visitor_id)

    if (allVisitorIds.length === 0) {
      logger.info(`✅ Contacto ${contactId} ya tiene visitor_id unificado: ${canonicalVisitorId}`)

      // Asegurarse de que la tabla contacts tenga el visitor_id guardado
      await db.run(`
        UPDATE contacts
        SET visitor_id = ?
        WHERE id = ?
      `, [canonicalVisitorId, contactId])

      await unifyVideoPlaybackVisitorIds(contactId, canonicalVisitorId)

      return { success: true, canonicalVisitorId, sessionsUpdated: 0 }
    }

    logger.info(`🔄 Unificando ${allVisitorIds.length} visitor_ids diferentes para contacto ${contactId}:`)
    logger.info(`   → Canonical (más viejo): ${canonicalVisitorId}`)
    logger.info(`   → A reemplazar: ${allVisitorIds.join(', ')}`)

    // PASO 3: Actualizar TODAS las sesiones para usar el visitor_id canónico
    const visitorPlaceholders = allVisitorIds.map(() => '?').join(', ')
    const result = await db.run(`
      UPDATE sessions
      SET visitor_id = ?
      WHERE contact_id = ?
        AND visitor_id IN (${visitorPlaceholders})
    `, [canonicalVisitorId, contactId, ...allVisitorIds])

    logger.info(`✅ Actualizadas ${result.changes} sesiones con visitor_id unificado`)

    const videoResult = await unifyVideoPlaybackVisitorIds(contactId, canonicalVisitorId)
    if (videoResult.sessionsUpdated > 0 || videoResult.eventsUpdated > 0) {
      logger.info(`✅ Actualizadas ${videoResult.sessionsUpdated} reproducciones de video con visitor_id unificado`)
    }

    // PASO 4: Guardar visitor_id canónico en tabla contacts
    await db.run(`
      UPDATE contacts
      SET visitor_id = ?
      WHERE id = ?
    `, [canonicalVisitorId, contactId])

    if (Number(result.changes || 0) > 0) invalidateTrackingAnalyticsCache()

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
