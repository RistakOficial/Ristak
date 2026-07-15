import { databaseDialect, db } from '../config/database.js'
import { normalizeTrafficSource, normalizeWhatsAppAttributionPlatform } from '../utils/trafficSourceNormalizer.js'

// Fuentes "genéricas" que no aportan información de plataforma real.
const GENERIC_SOURCES = new Set(['Directo', 'Desconocido', 'Otro'])

function sqlSignal(expression) {
  return `LOWER(TRIM(CAST(COALESCE(${expression}, '') AS TEXT)))`
}

/**
 * Equivalente SQL acotado del normalizador de fuentes. Devuelve NULL cuando la
 * señal no identifica una plataforma para que la siguiente señal conserve la
 * misma prioridad que normalizeTrafficSource().
 */
function platformFromSignalSql(expression) {
  const signal = sqlSignal(expression)
  return `CASE
    WHEN ${signal} = '' THEN NULL
    WHEN ${signal} LIKE '%instagram%' OR ${signal} = 'ig' OR ${signal} LIKE 'ig_%' OR ${signal} LIKE 'ig-%' OR ${signal} LIKE 'ig %' OR ${signal} LIKE '%ig.com%' THEN 'Instagram'
    WHEN ${signal} LIKE '%facebook%' OR ${signal} = 'fb' OR ${signal} = 'meta' OR ${signal} LIKE 'fb_%' OR ${signal} LIKE 'fb-%' OR ${signal} LIKE 'fb %' OR ${signal} LIKE 'meta_%' OR ${signal} LIKE 'meta-%' OR ${signal} LIKE 'meta %' OR ${signal} LIKE '%fb.com%' OR ${signal} LIKE '%m.me%' OR ${signal} LIKE '%messenger%' THEN 'Facebook'
    WHEN ${signal} LIKE '%tiktok%' OR ${signal} = 'tt' OR ${signal} LIKE 'tt_%' OR ${signal} LIKE 'tt-%' OR ${signal} LIKE '%ttclid%' THEN 'TikTok'
    WHEN ${signal} LIKE '%youtube%' OR ${signal} LIKE '%youtu.be%' OR ${signal} = 'yt' OR ${signal} LIKE 'yt_%' OR ${signal} LIKE 'yt-%' THEN 'YouTube'
    WHEN ${signal} LIKE '%google%' OR ${signal} LIKE '%adwords%' OR ${signal} LIKE '%gclid%' OR ${signal} LIKE '%gbraid%' OR ${signal} LIKE '%wbraid%' OR ${signal} IN ('ggl', 'cpc', 'ppc', 'sem') THEN 'Google'
    WHEN ${signal} LIKE '%bing%' OR ${signal} LIKE '%microsoft%' OR ${signal} LIKE '%msclkid%' OR ${signal} = 'msn' THEN 'Bing'
    WHEN ${signal} LIKE '%linkedin%' OR ${signal} LIKE '%lnkd%' OR ${signal} = 'li' OR ${signal} LIKE 'li_%' OR ${signal} LIKE 'li-%' THEN 'LinkedIn'
    WHEN ${signal} LIKE '%snapchat%' OR ${signal} LIKE 'snap_%' OR ${signal} LIKE 'snap-%' OR ${signal} LIKE 'snap %' OR ${signal} = 'snap' OR ${signal} = 'sc' OR ${signal} LIKE 'sc_%' THEN 'Snapchat'
    WHEN ${signal} LIKE '%pinterest%' OR ${signal} LIKE '%pin.it%' OR ${signal} = 'pin' OR ${signal} LIKE 'pin_%' THEN 'Pinterest'
    WHEN ${signal} LIKE '%reddit%' OR ${signal} LIKE '%redd.it%' THEN 'Reddit'
    WHEN ${signal} LIKE '%twitter%' OR ${signal} LIKE '%x.com%' OR ${signal} LIKE '%twclid%' OR ${signal} = 'x' THEN 'Twitter'
    WHEN ${signal} LIKE '%whatsapp%' OR ${signal} LIKE '%wa.me%' OR ${signal} LIKE '%waapi%' OR ${signal} LIKE '%ycloud%' OR ${signal} LIKE '%click_to_whatsapp%' OR ${signal} IN ('wa', 'ctwa') THEN 'WhatsApp'
    WHEN ${signal} LIKE '%telegram%' OR ${signal} LIKE '%t.me%' OR ${signal} = 'tg' THEN 'Telegram'
    WHEN ${signal} LIKE '%email%' OR ${signal} LIKE '%newsletter%' OR ${signal} IN ('mail', 'campaign') THEN 'Email'
    WHEN ${signal} LIKE '%yahoo%' THEN 'Yahoo'
    WHEN ${signal} LIKE '%duckduckgo%' OR ${signal} = 'ddg' THEN 'DuckDuckGo'
    WHEN ${signal} LIKE '%baidu%' THEN 'Baidu'
    WHEN ${signal} LIKE '%yandex%' THEN 'Yandex'
    WHEN ${signal} = 'ask' OR ${signal} LIKE '%ask.com%' THEN 'Ask'
    WHEN ${signal} IN ('organic', 'seo') THEN 'Orgánico'
    WHEN ${signal} IN ('referral', 'ref') THEN 'Referencia'
    WHEN ${signal} IN ('direct', 'none', '(direct)', '(none)') THEN 'Directo'
    ELSE NULL
  END`
}

export function buildNormalizedTrafficSourceSql(expressions = []) {
  const sourceExpressions = expressions.filter(Boolean)
  if (!sourceExpressions.length) return "'Directo'"
  const hasSignal = sourceExpressions
    .map(expression => `${sqlSignal(expression)} != ''`)
    .join(' OR ')
  return `CASE
    WHEN NOT (${hasSignal}) THEN 'Directo'
    ELSE COALESCE(
      ${sourceExpressions.map(platformFromSignalSql).join(',\n      ')},
      'Otro'
    )
  END`
}

/**
 * Devuelve el primer valor de texto "real" (no vacío, no null/undefined literal).
 */
export const firstText = (...values) => {
  for (const value of values) {
    if (value === null || value === undefined) continue
    const text = String(value).trim()
    if (text && text !== 'null' && text !== 'undefined') return value
  }
  return null
}

/**
 * Carga la PRIMERA atribución de WhatsApp de cada contacto (oficial + API).
 * Devuelve un Map<contact_id, row>.
 */
export async function loadFirstWhatsAppAttributions(contactIds = []) {
  const ids = Array.from(new Set(contactIds.filter(Boolean)))
  const byContact = new Map()
  if (!ids.length) return byContact

  const placeholders = ids.map(() => '?').join(', ')

  const officialRows = await db.all(`
    SELECT
      contact_id,
      referral_source_url,
      referral_source_type,
      referral_source_id,
      referral_headline,
      referral_body,
      referral_ctwa_clid,
      ad_id_thru_message,
      NULL as referral_source_app,
      NULL as referral_entry_point,
      created_at,
      'whatsapp_attribution' as attribution_source
    FROM whatsapp_attribution
    WHERE contact_id IN (${placeholders})
    ORDER BY created_at ASC, id ASC
  `, ids)

  officialRows.forEach(row => {
    if (row.contact_id && !byContact.has(row.contact_id)) {
      byContact.set(row.contact_id, row)
    }
  })

  const apiRows = await db.all(`
    SELECT
      msg.contact_id,
      COALESCE(attr.detected_source_url, msg.detected_source_url) as referral_source_url,
      COALESCE(attr.detected_source_type, msg.detected_source_type) as referral_source_type,
      COALESCE(attr.detected_source_id, msg.detected_source_id) as referral_source_id,
      COALESCE(attr.detected_headline, msg.detected_headline) as referral_headline,
      COALESCE(attr.detected_body, msg.detected_body) as referral_body,
      COALESCE(attr.detected_ctwa_clid, msg.detected_ctwa_clid) as referral_ctwa_clid,
      COALESCE(attr.detected_source_id, msg.detected_source_id) as ad_id_thru_message,
      COALESCE(attr.detected_source_app, msg.detected_source_app) as referral_source_app,
      COALESCE(attr.detected_entry_point, msg.detected_entry_point) as referral_entry_point,
      COALESCE(msg.message_timestamp, msg.created_at) as created_at,
      'whatsapp_api' as attribution_source
    FROM whatsapp_api_messages msg
    LEFT JOIN whatsapp_api_attribution attr ON attr.whatsapp_api_message_id = msg.id
    WHERE msg.contact_id IN (${placeholders})
      AND msg.direction = 'inbound'
      AND (
        attr.id IS NOT NULL
        OR msg.detected_ctwa_clid IS NOT NULL
        OR msg.detected_source_id IS NOT NULL
        OR msg.detected_source_url IS NOT NULL
        OR msg.detected_headline IS NOT NULL
      )
    ORDER BY COALESCE(msg.message_timestamp, msg.created_at) ASC, msg.id ASC
  `, ids)

  apiRows.forEach(row => {
    if (row.contact_id && !byContact.has(row.contact_id)) {
      byContact.set(row.contact_id, row)
    }
  })

  return byContact
}

/**
 * Combina campos de atribución del contacto + atribución de WhatsApp en los
 * campos normalizados que consume el frontend, e infiere la plataforma
 * (cubre "Meta Ads" cuando hay ad_id/ctwa_clid).
 */
export function buildContactAttributionFields(contact = {}, whatsappAttribution = null) {
  const attributionData = {
    source: contact.source,
    referral_source_url: firstText(contact.attribution_url, whatsappAttribution?.referral_source_url),
    referral_source_type: firstText(contact.attribution_medium, whatsappAttribution?.referral_source_type),
    referral_source_id: firstText(contact.attribution_ad_id, whatsappAttribution?.referral_source_id),
    referral_ctwa_clid: firstText(contact.attribution_ctwa_clid, whatsappAttribution?.referral_ctwa_clid),
    referral_source_app: firstText(contact.attribution_session_source, whatsappAttribution?.referral_source_app),
    referral_entry_point: whatsappAttribution?.referral_entry_point || null
  }
  const platform = normalizeWhatsAppAttributionPlatform(attributionData)
  const hasPlatform = platform && !['Directo', 'Desconocido', 'Otro'].includes(platform)

  return {
    attribution_url: attributionData.referral_source_url || null,
    attribution_session_source: firstText(
      contact.attribution_session_source,
      whatsappAttribution?.referral_source_app,
      whatsappAttribution?.referral_entry_point,
      whatsappAttribution?.referral_source_type
    ),
    attribution_medium: attributionData.referral_source_type || null,
    attribution_ctwa_clid: attributionData.referral_ctwa_clid || null,
    whatsappAttributionPlatform: hasPlatform ? platform : null
  }
}

/**
 * Resuelve la fuente de tráfico normalizada de UN contacto combinando, por prioridad:
 *  1. Señal de la primera sesión web (referrer/utm/site_source/source_platform).
 *  2. Plataforma de atribución de WhatsApp / Meta Ads (ad_id/ctwa_clid).
 *  3. Campos de atribución guardados en el propio contacto.
 * @returns {string} nombre de fuente (Facebook, Instagram, WhatsApp, Meta Ads, Directo, ...)
 */
export function resolveContactSource(contact = {}, firstSession = null, whatsappAttribution = null) {
  if (firstSession) {
    const webSource = normalizeTrafficSource({
      referrer_url: firstSession.referrer_url,
      site_source_name: firstSession.site_source_name,
      utm_source: firstSession.utm_source,
      source_platform: firstSession.source_platform
    })
    if (!GENERIC_SOURCES.has(webSource)) return webSource
  }

  const { whatsappAttributionPlatform } = buildContactAttributionFields(contact, whatsappAttribution)
  if (whatsappAttributionPlatform) return whatsappAttributionPlatform

  return normalizeTrafficSource({
    referrer_url: contact.attribution_url,
    site_source_name: contact.attribution_session_source,
    utm_source: contact.attribution_medium,
    source: contact.source
  })
}

const CONTACT_SOURCE_SELECTION_COLUMNS = `
  c.id,
  c.source,
  c.visitor_id,
  c.email,
  c.attribution_url,
  c.attribution_session_source,
  c.attribution_medium,
  c.attribution_ctwa_clid,
  c.attribution_ad_id
`

function normalizeBreakdownLimit(value) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 10
  return Math.min(parsed, 100)
}

/**
 * Agrega fuentes directamente en SQL para un conjunto definido por una
 * subconsulta interna. La respuesta queda acotada al top solicitado y nunca
 * transporta IDs/sesiones/mensajes a Node.
 *
 * selectionSql debe devolver las columnas de CONTACT_SOURCE_SELECTION_COLUMNS.
 */
export async function getContactSourceBreakdownForSelection({
  selectionSql,
  params = [],
  limit = 10,
  signal
} = {}) {
  if (!selectionSql || typeof selectionSql !== 'string') return []

  const safeLimit = normalizeBreakdownLimit(limit)
  const sessionSource = buildNormalizedTrafficSourceSql([
    'fs.referrer_url',
    'fs.site_source_name',
    'fs.utm_source',
    'fs.source_platform'
  ])
  const contactSource = buildNormalizedTrafficSourceSql([
    'sc.attribution_url',
    'sc.attribution_session_source',
    'sc.attribution_medium',
    'sc.source'
  ])
  const whatsappBaseSource = buildNormalizedTrafficSourceSql([
    "COALESCE(NULLIF(sc.attribution_url, ''), NULLIF(wa.referral_source_url, ''))",
    "COALESCE(NULLIF(sc.attribution_session_source, ''), NULLIF(wa.referral_source_app, ''), NULLIF(wa.referral_entry_point, ''))",
    "COALESCE(NULLIF(sc.attribution_medium, ''), NULLIF(wa.referral_source_type, ''))",
    'sc.source'
  ])
  const attributedId = `COALESCE(
    NULLIF(sc.attribution_ad_id, ''),
    NULLIF(wa.referral_source_id, ''),
    NULLIF(sc.attribution_ctwa_clid, ''),
    NULLIF(wa.referral_ctwa_clid, '')
  )`
  const whatsappSource = `CASE
    WHEN ${whatsappBaseSource} IN ('Directo', 'Desconocido', 'Otro', 'WhatsApp')
      AND ${attributedId} IS NOT NULL THEN 'Meta Ads'
    ELSE ${whatsappBaseSource}
  END`

  const rows = await db.all(`
    WITH
    selected_contacts AS (
      SELECT DISTINCT *
      FROM (${selectionSql}) selected_contact_rows
    ),
    session_matches AS (
      SELECT
        sc.id AS selected_contact_id,
        s.id,
        s.referrer_url,
        s.site_source_name,
        s.utm_source,
        s.source_platform,
        s.started_at,
        s.created_at,
        1 AS match_priority
      FROM selected_contacts sc
      INNER JOIN sessions s ON s.contact_id = sc.id

      UNION ALL

      SELECT
        sc.id AS selected_contact_id,
        s.id,
        s.referrer_url,
        s.site_source_name,
        s.utm_source,
        s.source_platform,
        s.started_at,
        s.created_at,
        2 AS match_priority
      FROM selected_contacts sc
      INNER JOIN sessions s
        ON sc.visitor_id IS NOT NULL
       AND sc.visitor_id != ''
       AND s.visitor_id = sc.visitor_id

      UNION ALL

      SELECT
        sc.id AS selected_contact_id,
        s.id,
        s.referrer_url,
        s.site_source_name,
        s.utm_source,
        s.source_platform,
        s.started_at,
        s.created_at,
        3 AS match_priority
      FROM selected_contacts sc
      INNER JOIN sessions s
        ON sc.email IS NOT NULL
       AND sc.email != ''
       AND LOWER(s.email) = LOWER(sc.email)
    ),
    ranked_sessions AS (
      SELECT
        session_matches.*,
        ROW_NUMBER() OVER (
          PARTITION BY selected_contact_id
          ORDER BY match_priority ASC, started_at ASC, created_at ASC, id ASC
        ) AS source_rank
      FROM session_matches
    ),
    first_sessions AS (
      SELECT * FROM ranked_sessions WHERE source_rank = 1
    ),
    ranked_official_attributions AS (
      SELECT
        sc.id AS selected_contact_id,
        wat.referral_source_url,
        wat.referral_source_type,
        wat.referral_source_id,
        wat.referral_ctwa_clid,
        NULL AS referral_source_app,
        NULL AS referral_entry_point,
        ROW_NUMBER() OVER (
          PARTITION BY sc.id
          ORDER BY wat.created_at ASC, wat.id ASC
        ) AS attribution_rank
      FROM selected_contacts sc
      INNER JOIN whatsapp_attribution wat ON wat.contact_id = sc.id
    ),
    first_official_attributions AS (
      SELECT * FROM ranked_official_attributions WHERE attribution_rank = 1
    ),
    ranked_api_attributions AS (
      SELECT
        sc.id AS selected_contact_id,
        COALESCE(attr.detected_source_url, msg.detected_source_url) AS referral_source_url,
        COALESCE(attr.detected_source_type, msg.detected_source_type) AS referral_source_type,
        COALESCE(attr.detected_source_id, msg.detected_source_id) AS referral_source_id,
        COALESCE(attr.detected_ctwa_clid, msg.detected_ctwa_clid) AS referral_ctwa_clid,
        COALESCE(attr.detected_source_app, msg.detected_source_app) AS referral_source_app,
        COALESCE(attr.detected_entry_point, msg.detected_entry_point) AS referral_entry_point,
        ROW_NUMBER() OVER (
          PARTITION BY sc.id
          ORDER BY COALESCE(msg.message_timestamp, msg.created_at) ASC, msg.id ASC
        ) AS attribution_rank
      FROM selected_contacts sc
      INNER JOIN whatsapp_api_messages msg ON msg.contact_id = sc.id
      LEFT JOIN whatsapp_api_attribution attr ON attr.whatsapp_api_message_id = msg.id
      WHERE LOWER(COALESCE(msg.direction, '')) = 'inbound'
        AND (
          attr.id IS NOT NULL
          OR msg.detected_ctwa_clid IS NOT NULL
          OR msg.detected_source_id IS NOT NULL
          OR msg.detected_source_url IS NOT NULL
          OR msg.detected_headline IS NOT NULL
        )
    ),
    first_api_attributions AS (
      SELECT * FROM ranked_api_attributions WHERE attribution_rank = 1
    ),
    whatsapp_attributions AS (
      SELECT
        sc.id AS selected_contact_id,
        CASE WHEN official.selected_contact_id IS NOT NULL THEN official.referral_source_url ELSE api.referral_source_url END AS referral_source_url,
        CASE WHEN official.selected_contact_id IS NOT NULL THEN official.referral_source_type ELSE api.referral_source_type END AS referral_source_type,
        CASE WHEN official.selected_contact_id IS NOT NULL THEN official.referral_source_id ELSE api.referral_source_id END AS referral_source_id,
        CASE WHEN official.selected_contact_id IS NOT NULL THEN official.referral_ctwa_clid ELSE api.referral_ctwa_clid END AS referral_ctwa_clid,
        CASE WHEN official.selected_contact_id IS NOT NULL THEN official.referral_source_app ELSE api.referral_source_app END AS referral_source_app,
        CASE WHEN official.selected_contact_id IS NOT NULL THEN official.referral_entry_point ELSE api.referral_entry_point END AS referral_entry_point
      FROM selected_contacts sc
      LEFT JOIN first_official_attributions official ON official.selected_contact_id = sc.id
      LEFT JOIN first_api_attributions api ON api.selected_contact_id = sc.id
    ),
    source_candidates AS (
      SELECT
        sc.id,
        ${sessionSource} AS session_source,
        ${whatsappSource} AS whatsapp_source,
        ${contactSource} AS contact_source
      FROM selected_contacts sc
      LEFT JOIN first_sessions fs ON fs.selected_contact_id = sc.id
      LEFT JOIN whatsapp_attributions wa ON wa.selected_contact_id = sc.id
    ),
    resolved_sources AS (
      SELECT CASE
        WHEN session_source NOT IN ('Directo', 'Desconocido', 'Otro') THEN session_source
        WHEN whatsapp_source NOT IN ('Directo', 'Desconocido', 'Otro') THEN whatsapp_source
        ELSE contact_source
      END AS source_name
      FROM source_candidates
    ),
    source_counts AS (
      SELECT source_name, COUNT(*) AS source_count
      FROM resolved_sources
      GROUP BY source_name
    ),
    ranked_sources AS (
      SELECT
        source_name,
        source_count,
        ROW_NUMBER() OVER (ORDER BY source_count DESC, source_name ASC) AS source_rank
      FROM source_counts
    )
    SELECT source_name AS name, source_count AS value
    FROM ranked_sources
    WHERE source_rank <= ?
    ORDER BY source_rank ASC
  `, [...params, safeLimit], { signal })

  return rows.map(row => ({ name: row.name || 'Directo', value: Number(row.value || 0) }))
}

/**
 * Compatibilidad para consumidores que ya tienen IDs. Usa un solo parámetro
 * JSON en vez de construir un IN con un placeholder por contacto.
 */
export async function getContactSourceBreakdown(contactIds = [], { limit = 10 } = {}) {
  const ids = Array.from(new Set((contactIds || []).filter(Boolean).map(String)))
  if (!ids.length) return []

  const idRows = databaseDialect === 'postgres'
    ? 'SELECT value AS id FROM jsonb_array_elements_text(CAST(? AS jsonb)) ids(value)'
    : 'SELECT CAST(value AS TEXT) AS id FROM json_each(?)'

  return getContactSourceBreakdownForSelection({
    selectionSql: `
      SELECT ${CONTACT_SOURCE_SELECTION_COLUMNS}
      FROM contacts c
      INNER JOIN (${idRows}) requested_ids ON requested_ids.id = c.id
    `,
    params: [JSON.stringify(ids)],
    limit
  })
}

export { CONTACT_SOURCE_SELECTION_COLUMNS }
