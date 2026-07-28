import { databaseDialect, db } from '../config/database.js'
import { normalizeTrafficSource, normalizeWhatsAppAttributionPlatform } from '../utils/trafficSourceNormalizer.js'

// Fuentes "genéricas" que no aportan información de plataforma real.
const GENERIC_SOURCES = new Set(['Directo', 'Desconocido', 'Otro'])
const CONTACT_ACQUISITION_CAUSAL_TOLERANCE_MINUTES = 5
const CONTACT_ACQUISITION_CAUSAL_TOLERANCE_MS =
  CONTACT_ACQUISITION_CAUSAL_TOLERANCE_MINUTES * 60 * 1000

export const CONTACT_ACQUISITION_SURFACES = Object.freeze([
  'website',
  'whatsapp',
  'messenger',
  'instagram',
  'email',
  'manual',
  'import',
  'api',
  'other',
  'unknown'
])

export const CONTACT_ACQUISITION_KINDS = Object.freeze(['paid_ad', 'unattributed'])

function normalizedToken(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
}

function hasAnyToken(value, tokens) {
  const normalized = normalizedToken(value)
  return Boolean(normalized) && tokens.some(token => normalized.includes(token))
}

function explicitAcquisitionSurface(source) {
  const normalized = normalizedToken(source)
  if (!normalized || ['directo', 'direct', 'desconocido', 'unknown'].includes(normalized)) return null
  if (hasAnyToken(normalized, [
    'ristak_site', 'ristak_form', 'formulario', 'native_site', 'native site',
    'sitio web', 'website', 'web form', 'webform', 'landing', 'ristak_calendar'
  ]) || normalized === 'site' || normalized === 'web' || normalized === 'form') {
    return 'website'
  }
  if (hasAnyToken(normalized, [
    'whatsapp_api', 'whatsapp api', 'whatsapp', 'waapi', 'ycloud',
    'click_to_whatsapp', 'click-to-whatsapp', 'ctwa', 'wa.me'
  ])) return 'whatsapp'
  if (hasAnyToken(normalized, ['messenger', 'facebook messenger', 'm.me'])) return 'messenger'
  if (hasAnyToken(normalized, ['instagram', 'instagram dm']) || normalized === 'ig') return 'instagram'
  if (hasAnyToken(normalized, ['email', 'correo', 'newsletter']) || normalized === 'mail') return 'email'
  if (hasAnyToken(normalized, ['manual', 'creado manualmente', 'created manually'])) return 'manual'
  if (hasAnyToken(normalized, ['import', 'csv', 'archivo'])) return 'import'
  if (hasAnyToken(normalized, ['webhook', 'integration api', 'integracion api']) ||
    normalized === 'api') return 'api'
  if (['otro', 'other'].includes(normalized)) return 'other'
  return null
}

function timestampMs(value) {
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : null
}

function isCausalEvidence(contact, evidence) {
  if (!evidence) return false
  const contactCreatedAt = timestampMs(contact?.created_at)
  const evidenceAt = timestampMs(evidence.started_at || evidence.created_at)
  if (contactCreatedAt === null || evidenceAt === null) return true
  return evidenceAt <= contactCreatedAt + CONTACT_ACQUISITION_CAUSAL_TOLERANCE_MS
}

function sessionViewCount(session) {
  if (!session) return 0
  if (session.view_count !== null && session.view_count !== undefined) {
    return Math.max(0, Number(session.view_count) || 0)
  }
  if (session.event_name !== null && session.event_name !== undefined) {
    return normalizedToken(session.event_name) === 'page_view' ? 1 : 0
  }
  // Compatibilidad para consumidores históricos de resolveContactSource().
  // El loader del read model siempre manda view_count explícito.
  return 1
}

function verifiedWebSession(contact, session) {
  return sessionViewCount(session) > 0 && isCausalEvidence(contact, session)
}

function hasPaidWebEvidence(contact, session) {
  const signals = [
    contact?.attribution_ad_id,
    session?.gclid,
    session?.fbclid,
    session?.wbraid,
    session?.gbraid,
    session?.msclkid,
    session?.ttclid,
    session?.campaign_id,
    session?.ad_id
  ]
  if (signals.some(value => firstText(value) !== null)) return true
  return hasAnyToken(firstText(session?.utm_medium, contact?.attribution_medium), [
    'cpc', 'ppc', 'paid', 'display', 'social_ad', 'social ad', 'retarget'
  ]) || hasAnyToken(session?.channel, ['paid', 'advertising', 'ads'])
}

function paidMessagingSignal(value) {
  const normalized = normalizedToken(value).replaceAll('-', '_').replaceAll(' ', '_')
  return [
    'ad',
    'ads',
    'paid',
    'paid_ad',
    'click_to_whatsapp',
    'click_to_message',
    'ctwa'
  ].includes(normalized)
}

function hasPaidMessagingEvidence(contact, attribution) {
  const contactPaidSignal = firstText(contact?.attribution_ad_id, contact?.attribution_ctwa_clid)
  if (contactPaidSignal !== null) return true
  if (!isCausalEvidence(contact, attribution)) return false
  if (firstText(
    attribution?.referral_ctwa_clid,
    attribution?.ad_id_thru_message
  ) !== null) return true
  if (paidMessagingSignal(attribution?.referral_source_type)) return true
  return paidMessagingSignal(attribution?.referral_entry_point) &&
    firstText(attribution?.referral_source_id) !== null
}

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
  const keepEarliest = row => {
    if (!row?.contact_id) return
    const current = byContact.get(row.contact_id)
    if (!current) {
      byContact.set(row.contact_id, row)
      return
    }
    const currentTime = timestampMs(current.created_at) ?? Number.POSITIVE_INFINITY
    const nextTime = timestampMs(row.created_at) ?? Number.POSITIVE_INFINITY
    if (nextTime < currentTime) byContact.set(row.contact_id, row)
  }

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

  officialRows.forEach(keepEarliest)

  const apiRows = await db.all(`
    SELECT
      msg.contact_id,
      COALESCE(attr.detected_source_url, msg.detected_source_url) as referral_source_url,
      COALESCE(attr.detected_source_type, msg.detected_source_type) as referral_source_type,
      COALESCE(attr.detected_source_id, msg.detected_source_id) as referral_source_id,
      COALESCE(attr.detected_headline, msg.detected_headline) as referral_headline,
      COALESCE(attr.detected_body, msg.detected_body) as referral_body,
      COALESCE(attr.detected_ctwa_clid, msg.detected_ctwa_clid) as referral_ctwa_clid,
      NULL as ad_id_thru_message,
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

  apiRows.forEach(keepEarliest)

  return byContact
}

async function loadFirstWhatsAppAttributionsForProjection(contactIds = [], {
  database = db,
  signal
} = {}) {
  const ids = Array.from(new Set(contactIds.filter(Boolean)))
  const byContact = new Map()
  if (!ids.length) return byContact
  const keepEarliest = row => {
    if (!row?.contact_id) return
    const key = String(row.contact_id)
    const current = byContact.get(key)
    if (!current) {
      byContact.set(key, row)
      return
    }
    const currentTime = timestampMs(current.created_at) ?? Number.POSITIVE_INFINITY
    const nextTime = timestampMs(row.created_at) ?? Number.POSITIVE_INFINITY
    if (nextTime < currentTime) byContact.set(key, row)
  }

  const placeholders = ids.map(() => '?').join(', ')

  const officialRows = databaseDialect === 'postgres'
    ? await database.all(`
      SELECT DISTINCT ON (contact_id)
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
      ORDER BY contact_id, created_at ASC, id ASC
    `, ids, { signal })
    : await database.all(`
      WITH ranked AS (
        SELECT
          contact_id,
          referral_source_url,
          referral_source_type,
          referral_source_id,
          referral_headline,
          referral_body,
          referral_ctwa_clid,
          ad_id_thru_message,
          created_at,
          ROW_NUMBER() OVER (
            PARTITION BY contact_id
            ORDER BY created_at ASC, id ASC
          ) AS source_rank
        FROM whatsapp_attribution
        WHERE contact_id IN (${placeholders})
      )
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
      FROM ranked
      WHERE source_rank = 1
    `, ids, { signal })

  officialRows.forEach(keepEarliest)

  const apiRows = databaseDialect === 'postgres'
    ? await database.all(`
      SELECT DISTINCT ON (msg.contact_id)
        msg.contact_id,
        COALESCE(attr.detected_source_url, msg.detected_source_url) as referral_source_url,
        COALESCE(attr.detected_source_type, msg.detected_source_type) as referral_source_type,
        COALESCE(attr.detected_source_id, msg.detected_source_id) as referral_source_id,
        COALESCE(attr.detected_headline, msg.detected_headline) as referral_headline,
        COALESCE(attr.detected_body, msg.detected_body) as referral_body,
        COALESCE(attr.detected_ctwa_clid, msg.detected_ctwa_clid) as referral_ctwa_clid,
        NULL as ad_id_thru_message,
        COALESCE(attr.detected_source_app, msg.detected_source_app) as referral_source_app,
        COALESCE(attr.detected_entry_point, msg.detected_entry_point) as referral_entry_point,
        COALESCE(msg.message_timestamp, msg.created_at) as created_at,
        'whatsapp_api' as attribution_source
      FROM whatsapp_api_messages msg
      LEFT JOIN whatsapp_api_attribution attr ON attr.whatsapp_api_message_id = msg.id
      WHERE msg.contact_id IN (${placeholders})
        AND LOWER(COALESCE(msg.direction, '')) = 'inbound'
        AND (
          attr.id IS NOT NULL
          OR NULLIF(TRIM(COALESCE(msg.detected_ctwa_clid, '')), '') IS NOT NULL
          OR NULLIF(TRIM(COALESCE(msg.detected_source_id, '')), '') IS NOT NULL
          OR NULLIF(TRIM(COALESCE(msg.detected_source_url, '')), '') IS NOT NULL
          OR NULLIF(TRIM(COALESCE(msg.detected_source_type, '')), '') IS NOT NULL
          OR NULLIF(TRIM(COALESCE(msg.detected_source_app, '')), '') IS NOT NULL
          OR NULLIF(TRIM(COALESCE(msg.detected_entry_point, '')), '') IS NOT NULL
          OR NULLIF(TRIM(COALESCE(msg.detected_headline, '')), '') IS NOT NULL
        )
      ORDER BY msg.contact_id, COALESCE(msg.message_timestamp, msg.created_at) ASC,
        msg.id ASC, attr.created_at ASC, attr.id ASC
    `, ids, { signal })
    : await database.all(`
      WITH ranked AS (
        SELECT
          msg.contact_id,
          COALESCE(attr.detected_source_url, msg.detected_source_url) as referral_source_url,
          COALESCE(attr.detected_source_type, msg.detected_source_type) as referral_source_type,
          COALESCE(attr.detected_source_id, msg.detected_source_id) as referral_source_id,
          COALESCE(attr.detected_headline, msg.detected_headline) as referral_headline,
          COALESCE(attr.detected_body, msg.detected_body) as referral_body,
          COALESCE(attr.detected_ctwa_clid, msg.detected_ctwa_clid) as referral_ctwa_clid,
          NULL as ad_id_thru_message,
          COALESCE(attr.detected_source_app, msg.detected_source_app) as referral_source_app,
          COALESCE(attr.detected_entry_point, msg.detected_entry_point) as referral_entry_point,
          COALESCE(msg.message_timestamp, msg.created_at) as created_at,
          ROW_NUMBER() OVER (
            PARTITION BY msg.contact_id
            ORDER BY COALESCE(msg.message_timestamp, msg.created_at) ASC,
              msg.id ASC, attr.created_at ASC, attr.id ASC
          ) AS source_rank
        FROM whatsapp_api_messages msg
        LEFT JOIN whatsapp_api_attribution attr ON attr.whatsapp_api_message_id = msg.id
        WHERE msg.contact_id IN (${placeholders})
          AND LOWER(COALESCE(msg.direction, '')) = 'inbound'
          AND (
            attr.id IS NOT NULL
            OR NULLIF(TRIM(COALESCE(msg.detected_ctwa_clid, '')), '') IS NOT NULL
            OR NULLIF(TRIM(COALESCE(msg.detected_source_id, '')), '') IS NOT NULL
            OR NULLIF(TRIM(COALESCE(msg.detected_source_url, '')), '') IS NOT NULL
            OR NULLIF(TRIM(COALESCE(msg.detected_source_type, '')), '') IS NOT NULL
            OR NULLIF(TRIM(COALESCE(msg.detected_source_app, '')), '') IS NOT NULL
            OR NULLIF(TRIM(COALESCE(msg.detected_entry_point, '')), '') IS NOT NULL
            OR NULLIF(TRIM(COALESCE(msg.detected_headline, '')), '') IS NOT NULL
          )
      )
      SELECT
        contact_id,
        referral_source_url,
        referral_source_type,
        referral_source_id,
        referral_headline,
        referral_body,
        referral_ctwa_clid,
        ad_id_thru_message,
        referral_source_app,
        referral_entry_point,
        created_at,
        'whatsapp_api' as attribution_source
      FROM ranked
      WHERE source_rank = 1
    `, ids, { signal })

  apiRows.forEach(keepEarliest)

  return byContact
}

/**
 * Resuelve la fuente canónica de un lote pequeño de contactos sin transportar
 * historiales completos. Esta variante existe para read models: hace los mismos
 * probes acotados que el desglose SQL, pero devuelve una fila por contacto para
 * poder materializarla una sola vez fuera del request path.
 */
export async function loadResolvedContactSources(contactIds = [], {
  database = db,
  signal
} = {}) {
  const ids = Array.from(new Set(contactIds.filter(Boolean).map(String)))
  if (!ids.length) return new Map()

  const placeholders = ids.map(() => '?').join(', ')
  const contacts = await database.all(`
    SELECT ${CONTACT_SOURCE_SELECTION_COLUMNS}, c.created_at
    FROM contacts c
    WHERE c.id IN (${placeholders})
  `, ids, { signal })
  if (!contacts.length) return new Map()

  const firstSessions = databaseDialect === 'postgres'
    ? await database.all(`
      SELECT
        sc.id AS selected_contact_id,
        matched.referrer_url,
        matched.site_source_name,
        matched.utm_source,
        matched.utm_medium,
        matched.source_platform,
        matched.channel,
        matched.gclid,
        matched.fbclid,
        matched.wbraid,
        matched.gbraid,
        matched.msclkid,
        matched.ttclid,
        matched.campaign_id,
        matched.ad_id,
        matched.started_at,
        matched.created_at,
        matched.event_name,
        matched.view_count
      FROM contacts sc
      LEFT JOIN LATERAL (
        SELECT candidates.*
        FROM (
          SELECT by_contact.*
          FROM (
            SELECT
              s.id, s.referrer_url, s.site_source_name, s.utm_source, s.utm_medium,
              s.source_platform, s.channel, s.gclid, s.fbclid, s.wbraid, s.gbraid,
              s.msclkid, s.ttclid, s.campaign_id, s.ad_id, s.started_at, s.created_at,
              s.event_name, 1 AS view_count, 1 AS match_priority
            FROM sessions s
            WHERE s.contact_id = sc.id
              AND LOWER(COALESCE(s.event_name, 'page_view')) = 'page_view'
              AND COALESCE(s.started_at, s.created_at)
                <= sc.created_at + INTERVAL '${CONTACT_ACQUISITION_CAUSAL_TOLERANCE_MINUTES} minutes'
            ORDER BY s.started_at ASC, s.created_at ASC, s.id ASC
            LIMIT 1
          ) by_contact

          UNION ALL

          SELECT by_visitor.*
          FROM (
            SELECT
              s.id, s.referrer_url, s.site_source_name, s.utm_source, s.utm_medium,
              s.source_platform, s.channel, s.gclid, s.fbclid, s.wbraid, s.gbraid,
              s.msclkid, s.ttclid, s.campaign_id, s.ad_id, s.started_at, s.created_at,
              s.event_name, 1 AS view_count, 2 AS match_priority
            FROM sessions s
            WHERE sc.visitor_id IS NOT NULL
              AND sc.visitor_id != ''
              AND s.visitor_id = sc.visitor_id
              AND LOWER(COALESCE(s.event_name, 'page_view')) = 'page_view'
              AND COALESCE(s.started_at, s.created_at)
                <= sc.created_at + INTERVAL '${CONTACT_ACQUISITION_CAUSAL_TOLERANCE_MINUTES} minutes'
            ORDER BY s.started_at ASC, s.created_at ASC, s.id ASC
            LIMIT 1
          ) by_visitor

          UNION ALL

          SELECT by_email.*
          FROM (
            SELECT
              s.id, s.referrer_url, s.site_source_name, s.utm_source, s.utm_medium,
              s.source_platform, s.channel, s.gclid, s.fbclid, s.wbraid, s.gbraid,
              s.msclkid, s.ttclid, s.campaign_id, s.ad_id, s.started_at, s.created_at,
              s.event_name, 1 AS view_count, 3 AS match_priority
            FROM sessions s
            WHERE sc.email IS NOT NULL
              AND sc.email != ''
              AND LOWER(s.email) = LOWER(sc.email)
              AND LOWER(COALESCE(s.event_name, 'page_view')) = 'page_view'
              AND COALESCE(s.started_at, s.created_at)
                <= sc.created_at + INTERVAL '${CONTACT_ACQUISITION_CAUSAL_TOLERANCE_MINUTES} minutes'
            ORDER BY s.started_at ASC, s.created_at ASC, s.id ASC
            LIMIT 1
          ) by_email
        ) candidates
        ORDER BY match_priority ASC, started_at ASC, created_at ASC, id ASC
        LIMIT 1
      ) matched ON TRUE
      WHERE sc.id IN (${placeholders})
    `, ids, { signal })
    : await database.all(`
      WITH selected_contacts AS (
        SELECT id, visitor_id, email, created_at
        FROM contacts
        WHERE id IN (${placeholders})
      ), session_matches AS (
        SELECT
          sc.id AS selected_contact_id,
          s.id,
          s.referrer_url,
          s.site_source_name,
          s.utm_source,
          s.utm_medium,
          s.source_platform,
          s.channel,
          s.gclid,
          s.fbclid,
          s.wbraid,
          s.gbraid,
          s.msclkid,
          s.ttclid,
          s.campaign_id,
          s.ad_id,
          s.started_at,
          s.created_at,
          s.event_name,
          1 AS view_count,
          1 AS match_priority
        FROM selected_contacts sc
        INNER JOIN sessions s
          ON s.contact_id = sc.id
         AND LOWER(COALESCE(s.event_name, 'page_view')) = 'page_view'
         AND julianday(COALESCE(s.started_at, s.created_at))
           <= julianday(sc.created_at) + (${CONTACT_ACQUISITION_CAUSAL_TOLERANCE_MINUTES}.0 / 1440.0)

        UNION ALL

        SELECT
          sc.id AS selected_contact_id,
          s.id,
          s.referrer_url,
          s.site_source_name,
          s.utm_source,
          s.utm_medium,
          s.source_platform,
          s.channel,
          s.gclid,
          s.fbclid,
          s.wbraid,
          s.gbraid,
          s.msclkid,
          s.ttclid,
          s.campaign_id,
          s.ad_id,
          s.started_at,
          s.created_at,
          s.event_name,
          1 AS view_count,
          2 AS match_priority
        FROM selected_contacts sc
        INNER JOIN sessions s
          ON sc.visitor_id IS NOT NULL
         AND sc.visitor_id != ''
         AND s.visitor_id = sc.visitor_id
         AND LOWER(COALESCE(s.event_name, 'page_view')) = 'page_view'
         AND julianday(COALESCE(s.started_at, s.created_at))
           <= julianday(sc.created_at) + (${CONTACT_ACQUISITION_CAUSAL_TOLERANCE_MINUTES}.0 / 1440.0)

        UNION ALL

        SELECT
          sc.id AS selected_contact_id,
          s.id,
          s.referrer_url,
          s.site_source_name,
          s.utm_source,
          s.utm_medium,
          s.source_platform,
          s.channel,
          s.gclid,
          s.fbclid,
          s.wbraid,
          s.gbraid,
          s.msclkid,
          s.ttclid,
          s.campaign_id,
          s.ad_id,
          s.started_at,
          s.created_at,
          s.event_name,
          1 AS view_count,
          3 AS match_priority
        FROM selected_contacts sc
        INNER JOIN sessions s
          ON sc.email IS NOT NULL
         AND sc.email != ''
         AND LOWER(s.email) = LOWER(sc.email)
         AND LOWER(COALESCE(s.event_name, 'page_view')) = 'page_view'
         AND julianday(COALESCE(s.started_at, s.created_at))
           <= julianday(sc.created_at) + (${CONTACT_ACQUISITION_CAUSAL_TOLERANCE_MINUTES}.0 / 1440.0)
      ), ranked AS (
        SELECT
          session_matches.*,
          ROW_NUMBER() OVER (
            PARTITION BY selected_contact_id
            ORDER BY match_priority ASC, started_at ASC, created_at ASC, id ASC
          ) AS source_rank
        FROM session_matches
      )
      SELECT selected_contact_id, referrer_url, site_source_name, utm_source, utm_medium,
        source_platform, channel, gclid, fbclid, wbraid, gbraid, msclkid, ttclid,
        campaign_id, ad_id, started_at, created_at, event_name, view_count
      FROM ranked
      WHERE source_rank = 1
    `, ids, { signal })

  const sessionsByContact = new Map(firstSessions.map(row => [String(row.selected_contact_id), row]))
  const whatsappByContact = await loadFirstWhatsAppAttributionsForProjection(ids, { database, signal })
  return new Map(contacts.map(contact => [
    String(contact.id),
    (() => {
      const acquisition = resolveContactAcquisition(
        contact,
        sessionsByContact.get(String(contact.id)) || null,
        whatsappByContact.get(String(contact.id)) || null
      )
      return {
        contact,
        source: acquisition.source,
        acquisitionSurface: acquisition.surface,
        acquisitionKind: acquisition.kind,
        evidenceType: acquisition.evidenceType
      }
    })()
  ]))
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
 * Clasifica una sola vez las tres dimensiones que suelen confundirse:
 * - surface: por dónde nació el contacto.
 * - kind: si existe evidencia comprobable de anuncio.
 * - source: plataforma de marketing normalizada.
 *
 * La fuente explícita del contacto manda sobre evidencia secundaria. En
 * particular, una visita posterior nunca puede convertir WhatsApp en website.
 */
export function resolveContactAcquisition(
  contact = {},
  firstSession = null,
  whatsappAttribution = null
) {
  const explicitSurface = explicitAcquisitionSurface(contact.source)
  const webIsCausal = verifiedWebSession(contact, firstSession)
  const whatsappIsCausal = isCausalEvidence(contact, whatsappAttribution)
  const ownMessagingEvidence = firstText(
    contact.attribution_ctwa_clid,
    hasAnyToken(contact.attribution_session_source, ['whatsapp', 'waapi', 'ycloud', 'ctwa'])
      ? contact.attribution_session_source
      : null
  ) !== null

  let surface = explicitSurface
  let evidenceType = explicitSurface ? 'explicit_source' : 'no_verified_evidence'
  if (!surface) {
    const candidates = []
    if (webIsCausal) {
      candidates.push({
        surface: 'website',
        evidenceType: hasPaidWebEvidence(contact, firstSession) ? 'web_paid_touch' : 'web_session'
      })
    }
    if (whatsappIsCausal || ownMessagingEvidence) {
      candidates.push({
        surface: 'whatsapp',
        evidenceType: hasPaidMessagingEvidence(contact, whatsappAttribution)
          ? 'whatsapp_paid_touch'
          : 'whatsapp_attribution'
      })
    }
    if (candidates.length === 1) {
      surface = candidates[0].surface
      evidenceType = candidates[0].evidenceType
    } else if (candidates.length > 1) {
      surface = 'unknown'
      evidenceType = 'conflicting_causal_evidence'
    }
  }
  if (!surface) {
    const normalizedSource = normalizedToken(contact.source)
    const genericSource = !normalizedSource ||
      ['directo', 'direct', 'desconocido', 'unknown'].includes(normalizedSource)
    surface = genericSource ? 'unknown' : 'other'
    evidenceType = genericSource ? 'no_verified_evidence' : 'unclassified_source'
  }

  const paidEvidence = surface === 'website'
    ? (webIsCausal && hasPaidWebEvidence(contact, firstSession)) ||
      firstText(contact.attribution_ad_id) !== null
    : ['whatsapp', 'messenger', 'instagram'].includes(surface)
      ? hasPaidMessagingEvidence(contact, whatsappAttribution)
      : false
  const kind = paidEvidence ? 'paid_ad' : 'unattributed'
  if (paidEvidence && evidenceType === 'explicit_source') {
    evidenceType = surface === 'website' ? 'web_paid_touch' : 'whatsapp_paid_touch'
  }

  let source = null
  if (surface === 'website' && webIsCausal) {
    const webSource = normalizeTrafficSource({
      referrer_url: firstSession.referrer_url,
      site_source_name: firstSession.site_source_name,
      utm_source: firstSession.utm_source,
      source_platform: firstSession.source_platform
    })
    if (!GENERIC_SOURCES.has(webSource)) source = webSource
  }
  if (!source && ['whatsapp', 'messenger', 'instagram'].includes(surface)) {
    const causalAttribution = whatsappIsCausal ? whatsappAttribution : null
    const { whatsappAttributionPlatform } = buildContactAttributionFields(contact, causalAttribution)
    // Un source_id genérico puede ser un post, perfil o cualquier referral de
    // WhatsApp. Sólo permitimos la etiqueta "Meta Ads" si otra señal demuestra
    // que realmente fue un anuncio.
    if (whatsappAttributionPlatform &&
      (whatsappAttributionPlatform !== 'Meta Ads' || paidEvidence)) {
      source = whatsappAttributionPlatform
    }
  }
  if (!source) {
    source = normalizeTrafficSource({
      referrer_url: contact.attribution_url,
      site_source_name: contact.attribution_session_source,
      utm_source: contact.attribution_medium,
      source: contact.source
    })
  }

  return {
    source: source || 'Desconocido',
    surface: CONTACT_ACQUISITION_SURFACES.includes(surface) ? surface : 'unknown',
    kind: CONTACT_ACQUISITION_KINDS.includes(kind) ? kind : 'unattributed',
    evidenceType
  }
}

/**
 * Compatibilidad para consumidores anteriores que sólo necesitan la plataforma.
 */
export function resolveContactSource(contact = {}, firstSession = null, whatsappAttribution = null) {
  return resolveContactAcquisition(contact, firstSession, whatsappAttribution).source
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

  // PostgreSQL puede resolver la primera señal de cada contacto con probes
  // contra los índices existentes. La versión anterior unía y ordenaba todas
  // las sesiones/mensajes de todos los contactos seleccionados; al ejecutarse
  // tres veces en paralelo desde Dashboard/Analíticas llegó a ser el proceso
  // que el kernel mató en producción. SQLite conserva el plan por ventanas,
  // que es más portable y se usa para instalaciones/pruebas locales pequeñas.
  const firstMatchCtes = databaseDialect === 'postgres'
    ? `
    first_sessions AS (
      SELECT
        sc.id AS selected_contact_id,
        matched.id,
        matched.referrer_url,
        matched.site_source_name,
        matched.utm_source,
        matched.source_platform,
        matched.started_at,
        matched.created_at,
        matched.match_priority
      FROM selected_contacts sc
      JOIN LATERAL (
        SELECT candidates.*
        FROM (
          SELECT by_contact.*
          FROM (
            SELECT
              s.id, s.referrer_url, s.site_source_name, s.utm_source,
              s.source_platform, s.started_at, s.created_at, 1 AS match_priority
            FROM sessions s
            WHERE s.contact_id = sc.id
            ORDER BY s.started_at ASC, s.created_at ASC, s.id ASC
            LIMIT 1
          ) by_contact

          UNION ALL

          SELECT by_visitor.*
          FROM (
            SELECT
              s.id, s.referrer_url, s.site_source_name, s.utm_source,
              s.source_platform, s.started_at, s.created_at, 2 AS match_priority
            FROM sessions s
            WHERE sc.visitor_id IS NOT NULL
              AND sc.visitor_id != ''
              AND s.visitor_id = sc.visitor_id
            ORDER BY s.started_at ASC, s.created_at ASC, s.id ASC
            LIMIT 1
          ) by_visitor

          UNION ALL

          SELECT by_email.*
          FROM (
            SELECT
              s.id, s.referrer_url, s.site_source_name, s.utm_source,
              s.source_platform, s.started_at, s.created_at, 3 AS match_priority
            FROM sessions s
            WHERE sc.email IS NOT NULL
              AND sc.email != ''
              AND LOWER(s.email) = LOWER(sc.email)
            ORDER BY s.started_at ASC, s.created_at ASC, s.id ASC
            LIMIT 1
          ) by_email
        ) candidates
        ORDER BY match_priority ASC, started_at ASC, created_at ASC, id ASC
        LIMIT 1
      ) matched ON TRUE
    ),
    first_official_attributions AS (
      SELECT
        sc.id AS selected_contact_id,
        official.referral_source_url,
        official.referral_source_type,
        official.referral_source_id,
        official.referral_ctwa_clid,
        NULL AS referral_source_app,
        NULL AS referral_entry_point
      FROM selected_contacts sc
      JOIN LATERAL (
        SELECT
          wat.referral_source_url,
          wat.referral_source_type,
          wat.referral_source_id,
          wat.referral_ctwa_clid
        FROM whatsapp_attribution wat
        WHERE wat.contact_id = sc.id
        ORDER BY wat.created_at ASC, wat.id ASC
        LIMIT 1
      ) official ON TRUE
    ),
    first_api_attributions AS (
      SELECT
        sc.id AS selected_contact_id,
        api.referral_source_url,
        api.referral_source_type,
        api.referral_source_id,
        api.referral_ctwa_clid,
        api.referral_source_app,
        api.referral_entry_point
      FROM selected_contacts sc
      JOIN LATERAL (
        SELECT
          COALESCE(attr.detected_source_url, msg.detected_source_url) AS referral_source_url,
          COALESCE(attr.detected_source_type, msg.detected_source_type) AS referral_source_type,
          COALESCE(attr.detected_source_id, msg.detected_source_id) AS referral_source_id,
          COALESCE(attr.detected_ctwa_clid, msg.detected_ctwa_clid) AS referral_ctwa_clid,
          COALESCE(attr.detected_source_app, msg.detected_source_app) AS referral_source_app,
          COALESCE(attr.detected_entry_point, msg.detected_entry_point) AS referral_entry_point
        FROM whatsapp_api_messages msg
        LEFT JOIN whatsapp_api_attribution attr ON attr.whatsapp_api_message_id = msg.id
        WHERE msg.contact_id = sc.id
          AND LOWER(COALESCE(msg.direction, '')) = 'inbound'
          AND (
            attr.id IS NOT NULL
            OR msg.detected_ctwa_clid IS NOT NULL
            OR msg.detected_source_id IS NOT NULL
            OR msg.detected_source_url IS NOT NULL
            OR msg.detected_headline IS NOT NULL
          )
        ORDER BY COALESCE(msg.message_timestamp, msg.created_at) ASC, msg.id ASC
        LIMIT 1
      ) api ON TRUE
    )`
    : `
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
    )`

  const rows = await db.all(`
    WITH
    selected_contacts AS (
      SELECT DISTINCT *
      FROM (${selectionSql}) selected_contact_rows
    ),
    ${firstMatchCtes},
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
