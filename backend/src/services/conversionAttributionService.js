// Atribución de conversiones (compras y citas).
//
// Este servicio separa dos conceptos que antes estaban mezclados:
//
// 1. ATRIBUCIÓN INTERNA — a qué anuncio/canal le damos crédito por la
//    conversión. La decide el ÚLTIMO paid/ad touch válido del contacto
//    (web con click-id/campaña, WhatsApp con ctwa, DM de Messenger/IG que
//    llegó desde un anuncio). Un touch orgánico nunca roba crédito.
//
// 2. SUPERFICIE REAL DE CONVERSIÓN — dónde ocurrió la conversión de verdad
//    (website, whatsapp, messenger, instagram). Decide el action_source y el
//    formato del payload de Meta CAPI. Nunca se falsifica: si la compra fue
//    por WhatsApp, el evento va como business_messaging/whatsapp aunque la
//    atribución interna sea de un anuncio web.
//
// La frase clave: la atribución la decide el último anuncio válido; el
// payload de Meta lo decide la superficie real donde ocurrió la conversión.

import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { buildPhoneMatchCandidates } from '../utils/phoneUtils.js'

export const CONVERSION_SURFACES = new Set(['website', 'whatsapp', 'messenger', 'instagram'])

// Tolerancia para comparar timestamps entre silos (webhooks, pixel y BD
// escriben con relojes/formatos distintos).
const TOUCH_TIME_TOLERANCE_MS = 5 * 60 * 1000
const TOUCH_SCAN_LIMIT = 40

// utm_medium que consideramos tráfico pagado. fbp solo NO cuenta como paid:
// el pixel se lo pone a cualquier visitante (orgánico incluido); usarlo como
// señal paid haría que casi todo el tráfico web "robara" crédito.
const PAID_UTM_MEDIUM_VALUES = ['cpc', 'ppc', 'paid', 'paid_social', 'paidsocial', 'paid-social', 'pagado']

// fbc también es una cookie persistente (~90 días) que el pixel re-manda en
// CADA pageview posterior al click. Un fbc "viejo" no convierte en pagada a la
// sesión actual: solo cuenta si la cookie nació cerca del inicio de la sesión
// (mismo click). El formato es fb.<idx>.<creationTimeMs>.<fbclid>.
const FBC_FRESHNESS_TOLERANCE_MS = 6 * 60 * 60 * 1000

function fbcMatchesSession(fbcValue, sessionStartMs) {
  const raw = cleanString(fbcValue)
  if (!raw) return false
  const parts = raw.split('.')
  const creationMs = Number(parts[2])
  if (!Number.isFinite(creationMs) || creationMs <= 0) return false
  if (!sessionStartMs) return false
  return Math.abs(sessionStartMs - creationMs) <= FBC_FRESHNESS_TOLERANCE_MS
}

function cleanString(value) {
  return String(value || '').trim()
}

function parseJson(value, fallback = null) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function parseTimeMs(value) {
  if (!value) return null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  const raw = cleanString(value)
  if (!raw) return null
  // SQLite guarda 'YYYY-MM-DD HH:MM:SS' (UTC implícito); Date.parse lo trata
  // como hora local. Normalizamos a ISO-UTC para comparar entre silos.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

// Devuelve { row, inWindow }: el mejor candidato dentro de la ventana
// (<= conversión + tolerancia) o, como fallback, el más reciente en general.
// El flag inWindow permite que la comparación ENTRE silos prefiera touches
// dentro de la ventana antes que fallbacks fuera de ella.
function pickLatestRow(rows = [], getTime, beforeMs = null) {
  const sorted = rows
    .map(row => ({ row, at: getTime(row) }))
    .sort((a, b) => (b.at || 0) - (a.at || 0))
  if (!sorted.length) return null
  if (beforeMs) {
    const inWindow = sorted.find(entry => entry.at && entry.at <= beforeMs + TOUCH_TIME_TOLERANCE_MS)
    if (inWindow) return { row: inWindow.row, inWindow: true }
    // Sin candidatos dentro de la ventana (o timestamps no comparables por
    // formato/skew): fallback al más reciente para no perder la atribución.
    return { row: sorted[0].row, inWindow: false }
  }
  return { row: sorted[0].row, inWindow: true }
}

async function getContactForAttribution(contactId) {
  if (!contactId) return null
  return db.get(
    `SELECT id, phone, email, visitor_id, source,
            attribution_url, attribution_session_source, attribution_medium,
            attribution_ctwa_clid, attribution_ad_id, attribution_ad_name
     FROM contacts
     WHERE id = ?`,
    [contactId]
  ).catch(() => null)
}

function buildContactMatchClause(contact, { column = 'contact_id', visitorColumn = 'visitor_id', emailColumn = 'email' } = {}) {
  const conditions = []
  const params = []
  if (contact?.id) {
    conditions.push(`${column} = ?`)
    params.push(contact.id)
  }
  if (contact?.visitor_id && visitorColumn) {
    conditions.push(`${visitorColumn} = ?`)
    params.push(contact.visitor_id)
  }
  if (contact?.email && emailColumn) {
    conditions.push(`LOWER(${emailColumn}) = ?`)
    params.push(String(contact.email).toLowerCase())
  }
  return { clause: conditions.join(' OR '), params }
}

// ── Touches pagados por silo ────────────────────────────────────────────────

function sessionIsPaid(session = {}) {
  if (
    cleanString(session.fbclid) ||
    cleanString(session.gclid) ||
    cleanString(session.msclkid) ||
    cleanString(session.ttclid) ||
    cleanString(session.wbraid) ||
    cleanString(session.gbraid)
  ) return true
  // fbc solo cuenta si la cookie nació con esta sesión (mismo click). Una
  // cookie _fbc vieja re-enviada en una visita orgánica no roba crédito.
  if (fbcMatchesSession(session.fbc, parseTimeMs(session.started_at || session.created_at))) return true
  if (cleanString(session.campaign_id) || cleanString(session.adset_id) || cleanString(session.ad_id)) return true
  if (cleanString(session.channel).toLowerCase() === 'paid') return true
  const medium = cleanString(session.utm_medium).toLowerCase()
  return PAID_UTM_MEDIUM_VALUES.some(value => medium === value || medium.includes('cpc') || medium.includes('ppc'))
}

// Prefiltro SQL del predicado paid: aplica ANTES del LIMIT para que un
// contacto con muchos pageviews orgánicos no entierre su touch pagado fuera
// de la ventana de escaneo. Las filas con solo fbc son candidatas y se
// validan en JS con fbcMatchesSession.
const PAID_SESSION_SQL_FILTER = `(
  COALESCE(fbclid, '') != ''
  OR COALESCE(gclid, '') != ''
  OR COALESCE(msclkid, '') != ''
  OR COALESCE(ttclid, '') != ''
  OR COALESCE(wbraid, '') != ''
  OR COALESCE(gbraid, '') != ''
  OR COALESCE(fbc, '') != ''
  OR COALESCE(campaign_id, '') != ''
  OR COALESCE(adset_id, '') != ''
  OR COALESCE(ad_id, '') != ''
  OR LOWER(COALESCE(channel, '')) = 'paid'
  OR LOWER(COALESCE(utm_medium, '')) IN (${PAID_UTM_MEDIUM_VALUES.map(value => `'${value}'`).join(', ')})
)`

async function findLastPaidWebTouch(contact, beforeMs = null) {
  const { clause, params } = buildContactMatchClause(contact)
  if (!clause) return null

  const rows = await db.all(
    `SELECT id, session_id, started_at, created_at, page_url, referrer_url,
            utm_source, utm_medium, utm_campaign,
            fbclid, fbc, fbp, gclid, msclkid, ttclid, wbraid, gbraid,
            channel, source_platform,
            campaign_id, adset_id, ad_id, campaign_name, adset_name, ad_name
     FROM sessions
     WHERE (${clause})
       AND ${PAID_SESSION_SQL_FILTER}
     ORDER BY started_at DESC, created_at DESC
     LIMIT ${TOUCH_SCAN_LIMIT}`,
    params
  ).catch(() => [])

  const paidRows = rows.filter(sessionIsPaid)
  const picked = pickLatestRow(paidRows, row => parseTimeMs(row.started_at || row.created_at), beforeMs)
  if (!picked) return null
  const session = picked.row

  return {
    inWindow: picked.inWindow,
    type: 'web',
    channel: 'website',
    at: session.started_at || session.created_at || null,
    atMs: parseTimeMs(session.started_at || session.created_at),
    campaignId: cleanString(session.campaign_id),
    adsetId: cleanString(session.adset_id),
    adId: cleanString(session.ad_id),
    campaignName: cleanString(session.campaign_name),
    adsetName: cleanString(session.adset_name),
    adName: cleanString(session.ad_name),
    ids: {
      sessionId: cleanString(session.session_id) || cleanString(session.id),
      fbclid: cleanString(session.fbclid),
      fbc: cleanString(session.fbc),
      fbp: cleanString(session.fbp),
      gclid: cleanString(session.gclid),
      pageUrl: cleanString(session.page_url)
    },
    utm: {
      source: cleanString(session.utm_source),
      medium: cleanString(session.utm_medium),
      campaign: cleanString(session.utm_campaign)
    }
  }
}

async function findLastPaidWhatsappTouch(contact, beforeMs = null) {
  if (!contact?.id) return null
  const phoneCandidates = buildPhoneMatchCandidates(contact.phone)
  const phoneFilter = phoneCandidates.length
    ? ` OR phone IN (${phoneCandidates.map(() => '?').join(', ')})`
    : ''

  const legacyRows = await db.all(
    `SELECT referral_ctwa_clid, referral_source_id, referral_source_type,
            referral_source_url, referral_headline, ad_id_thru_message, created_at
     FROM whatsapp_attribution
     WHERE (contact_id = ?${phoneFilter})
       AND (
         COALESCE(referral_ctwa_clid, '') != ''
         OR COALESCE(referral_source_id, '') != ''
         OR COALESCE(referral_source_url, '') != ''
         OR COALESCE(referral_headline, '') != ''
         OR COALESCE(ad_id_thru_message, '') != ''
       )
     ORDER BY created_at DESC
     LIMIT ${TOUCH_SCAN_LIMIT}`,
    [contact.id, ...phoneCandidates]
  ).catch(() => [])

  const apiPhoneFilter = phoneCandidates.length
    ? ` OR msg.phone IN (${phoneCandidates.map(() => '?').join(', ')})
        OR attr.phone IN (${phoneCandidates.map(() => '?').join(', ')})`
    : ''

  const apiRows = await db.all(
    `SELECT
       COALESCE(attr.detected_ctwa_clid, msg.detected_ctwa_clid) as referral_ctwa_clid,
       COALESCE(attr.detected_source_id, msg.detected_source_id) as referral_source_id,
       COALESCE(attr.detected_source_type, msg.detected_source_type) as referral_source_type,
       COALESCE(attr.detected_source_url, msg.detected_source_url) as referral_source_url,
       COALESCE(attr.detected_headline, msg.detected_headline) as referral_headline,
       COALESCE(attr.detected_source_id, msg.detected_source_id) as ad_id_thru_message,
       COALESCE(msg.message_timestamp, attr.created_at, msg.created_at) as created_at
     FROM whatsapp_api_messages msg
     LEFT JOIN whatsapp_api_attribution attr ON attr.whatsapp_api_message_id = msg.id
     WHERE (msg.contact_id = ? OR attr.contact_id = ?${apiPhoneFilter})
       AND msg.direction = 'inbound'
       AND (
         COALESCE(attr.detected_ctwa_clid, msg.detected_ctwa_clid, '') != ''
         OR COALESCE(attr.detected_source_id, msg.detected_source_id, '') != ''
         OR COALESCE(attr.detected_source_url, msg.detected_source_url, '') != ''
         OR COALESCE(attr.detected_headline, msg.detected_headline, '') != ''
       )
     ORDER BY created_at DESC
     LIMIT ${TOUCH_SCAN_LIMIT}`,
    [contact.id, contact.id, ...phoneCandidates, ...phoneCandidates]
  ).catch(() => [])

  const picked = pickLatestRow([...legacyRows, ...apiRows], entry => parseTimeMs(entry.created_at), beforeMs)
  if (!picked) return null
  const row = picked.row

  return {
    inWindow: picked.inWindow,
    type: 'whatsapp_ad',
    channel: 'whatsapp',
    at: row.created_at || null,
    atMs: parseTimeMs(row.created_at),
    campaignId: '',
    adsetId: '',
    adId: cleanString(row.referral_source_id || row.ad_id_thru_message),
    campaignName: '',
    adsetName: '',
    adName: cleanString(row.referral_headline),
    ids: {
      ctwaClid: cleanString(row.referral_ctwa_clid),
      sourceUrl: cleanString(row.referral_source_url),
      sourceType: cleanString(row.referral_source_type)
    }
  }
}

function socialReferralIsAd(referral = {}) {
  if (!referral || typeof referral !== 'object') return false
  if (cleanString(referral.ad_id)) return true
  if (cleanString(referral.source).toUpperCase() === 'ADS') return true
  if (referral.ads_context_data && typeof referral.ads_context_data === 'object') return true
  return false
}

async function findLastPaidSocialTouch(contact, beforeMs = null) {
  if (!contact?.id) return null

  const rows = await db.all(
    `SELECT platform, sender_id, page_id, instagram_account_id, referral_json,
            message_timestamp, created_at
     FROM meta_social_messages
     WHERE (
         contact_id = ?
         OR meta_social_contact_id IN (SELECT id FROM meta_social_contacts WHERE contact_id = ?)
       )
       AND direction = 'inbound'
       AND COALESCE(referral_json, '') != ''
       AND COALESCE(comment_id, '') = ''
     ORDER BY COALESCE(message_timestamp, created_at) DESC
     LIMIT ${TOUCH_SCAN_LIMIT}`,
    [contact.id, contact.id]
  ).catch(() => [])

  const adRows = rows
    .map(row => ({ ...row, referral: parseJson(row.referral_json, {}) }))
    .filter(row => socialReferralIsAd(row.referral))

  const picked = pickLatestRow(adRows, entry => parseTimeMs(entry.message_timestamp || entry.created_at), beforeMs)
  if (!picked) return null
  const row = picked.row

  const channel = cleanString(row.platform).toLowerCase() === 'instagram' ? 'instagram' : 'messenger'
  return {
    inWindow: picked.inWindow,
    type: 'social_ad',
    channel,
    at: row.message_timestamp || row.created_at || null,
    atMs: parseTimeMs(row.message_timestamp || row.created_at),
    campaignId: '',
    adsetId: '',
    adId: cleanString(row.referral?.ad_id),
    campaignName: '',
    adsetName: '',
    adName: cleanString(row.referral?.ads_context_data?.ad_title || row.referral?.ref),
    ids: {
      senderId: cleanString(row.sender_id),
      pageId: cleanString(row.page_id),
      igAccountId: cleanString(row.instagram_account_id),
      sourceUrl: cleanString(row.referral?.ads_context_data?.ad_url)
    }
  }
}

function detectChannelFromText(value = '') {
  const normalized = cleanString(value).toLowerCase()
  if (!normalized) return ''
  if (normalized.includes('instagram') || normalized.includes('ig_dm')) return 'instagram'
  if (normalized.includes('messenger') || normalized.includes('m.me')) return 'messenger'
  if (normalized.includes('whatsapp') || normalized.includes('wa.me')) return 'whatsapp'
  return ''
}

// Fallback legacy: contactos viejos sin touches con timestamp pero con
// atribución de anuncio guardada a nivel contacto (first-touch histórico).
function buildLegacyContactPaidTouch(contact = {}) {
  const ctwaClid = cleanString(contact.attribution_ctwa_clid)
  const adId = cleanString(contact.attribution_ad_id)
  if (!ctwaClid && !adId) return null

  // Solo mapeamos a un canal de DM cuando el origen fue claramente un DM
  // (los contactos de Messenger/IG DM se crean con attribution_medium='dm').
  // Un anuncio de IG/FB que aterrizó en el sitio web trae utm_source
  // 'instagram'/'facebook' pero su canal real es website.
  const isDmContact = cleanString(contact.attribution_medium).toLowerCase() === 'dm'
  const dmChannel = isDmContact
    ? detectChannelFromText(contact.attribution_session_source) || 'messenger'
    : ''
  const channel = ctwaClid ? 'whatsapp' : (dmChannel || 'website')

  return {
    type: 'contact_legacy',
    channel,
    at: null,
    atMs: null,
    campaignId: '',
    adsetId: '',
    adId,
    campaignName: '',
    adsetName: '',
    adName: cleanString(contact.attribution_ad_name),
    ids: { ctwaClid }
  }
}

/**
 * Último paid/ad touch válido del contacto antes de `conversionTime`.
 * Devuelve null si el contacto no tiene ningún touch pagado (100% orgánico).
 */
export async function findLastPaidTouch({ contactId, contact = null, conversionTime = null } = {}) {
  const resolvedContact = contact || await getContactForAttribution(contactId)
  if (!resolvedContact) return null

  const beforeMs = parseTimeMs(conversionTime)
  const [webTouch, whatsappTouch, socialTouch] = await Promise.all([
    findLastPaidWebTouch(resolvedContact, beforeMs),
    findLastPaidWhatsappTouch(resolvedContact, beforeMs),
    findLastPaidSocialTouch(resolvedContact, beforeMs)
  ])

  const timestamped = [webTouch, whatsappTouch, socialTouch]
    .filter(touch => touch && touch.atMs)
    .sort((a, b) => b.atMs - a.atMs)

  // Un touch dentro de la ventana (anterior a la conversión) de cualquier silo
  // le gana a un fallback fuera de ventana de otro silo.
  const inWindowTouches = timestamped.filter(touch => touch.inWindow)
  if (inWindowTouches.length) return inWindowTouches[0]
  if (timestamped.length) return timestamped[0]

  // Touches pagados sin timestamp comparable: cualquiera es mejor que nada.
  const untimestamped = [whatsappTouch, socialTouch, webTouch].find(Boolean)
  if (untimestamped) return untimestamped

  return buildLegacyContactPaidTouch(resolvedContact)
}

// ── Superficie real de conversión ───────────────────────────────────────────

async function getLastMessagingActivity(contact) {
  if (!contact?.id) return []
  const phoneCandidates = buildPhoneMatchCandidates(contact.phone)
  const phoneFilter = phoneCandidates.length
    ? ` OR phone IN (${phoneCandidates.map(() => '?').join(', ')})`
    : ''

  const [whatsappRow, socialRow] = await Promise.all([
    db.get(
      `SELECT COALESCE(message_timestamp, created_at) as at
       FROM whatsapp_api_messages
       WHERE (contact_id = ?${phoneFilter})
       ORDER BY COALESCE(message_timestamp, created_at) DESC
       LIMIT 1`,
      [contact.id, ...phoneCandidates]
    ).catch(() => null),
    db.get(
      `SELECT platform, COALESCE(message_timestamp, created_at) as at
       FROM meta_social_messages
       WHERE (
           contact_id = ?
           OR meta_social_contact_id IN (SELECT id FROM meta_social_contacts WHERE contact_id = ?)
         )
         AND COALESCE(comment_id, '') = ''
       ORDER BY COALESCE(message_timestamp, created_at) DESC
       LIMIT 1`,
      [contact.id, contact.id]
    ).catch(() => null)
  ])

  const activity = []
  if (whatsappRow?.at) {
    activity.push({ surface: 'whatsapp', atMs: parseTimeMs(whatsappRow.at) })
  }
  if (socialRow?.at) {
    activity.push({
      surface: cleanString(socialRow.platform).toLowerCase() === 'instagram' ? 'instagram' : 'messenger',
      atMs: parseTimeMs(socialRow.at)
    })
  }
  return activity.filter(entry => entry.atMs)
}

/**
 * Detecta la superficie donde ocurrió la conversión.
 *
 * - `explicitSurface` gana siempre (el call site sabe la verdad: un checkout
 *   público o un booking en el widget web SON website).
 * - Un pago con URL de checkout es website.
 * - Si no, la conversión "vive" en la conversación más reciente del contacto
 *   (WhatsApp / Messenger / Instagram) antes del evento.
 * - Sin actividad de mensajería → website (fallback; el sender de sitio ya
 *   degrada honestamente a phone_call/physical_store/system_generated).
 */
export async function detectConversionSurface({
  contactId,
  contact = null,
  explicitSurface = '',
  conversionTime = null,
  payment = null
} = {}) {
  const normalizedExplicit = cleanString(explicitSurface).toLowerCase()
  if (CONVERSION_SURFACES.has(normalizedExplicit)) return normalizedExplicit

  if (payment) {
    const checkoutUrl = cleanString(
      payment.event_source_url || payment.eventSourceUrl ||
      payment.payment_url || payment.paymentUrl ||
      payment.checkout_url || payment.checkoutUrl
    )
    if (checkoutUrl || cleanString(payment.public_payment_id || payment.publicPaymentId)) {
      return 'website'
    }
  }

  const resolvedContact = contact || await getContactForAttribution(contactId)
  if (!resolvedContact) return 'website'

  const beforeMs = parseTimeMs(conversionTime)
  const activity = (await getLastMessagingActivity(resolvedContact))
    .sort((a, b) => b.atMs - a.atMs)

  if (!activity.length) return 'website'

  if (beforeMs) {
    const inWindow = activity.find(entry => entry.atMs <= beforeMs + TOUCH_TIME_TOLERANCE_MS)
    if (inWindow) return inWindow.surface
  }
  return activity[0].surface
}

// Última sesión web del contacto (pagada o no): aporta fbp/fbc/URL para
// eventos server-side con superficie website.
export async function getLatestContactWebSession(contactOrId) {
  const contact = typeof contactOrId === 'object' && contactOrId !== null
    ? contactOrId
    : await getContactForAttribution(contactOrId)
  if (!contact) return null
  const { clause, params } = buildContactMatchClause(contact)
  if (!clause) return null

  return db.get(
    `SELECT id, session_id, started_at, created_at, page_url, fbclid, fbc, fbp
     FROM sessions
     WHERE (${clause})
     ORDER BY started_at DESC, created_at DESC
     LIMIT 1`,
    params
  ).catch(() => null)
}

// ── Resolución completa ─────────────────────────────────────────────────────

/**
 * Resuelve la atribución interna (último paid touch) y la superficie real de
 * conversión para una compra o cita.
 *
 * @returns {{
 *   attributionChannel: string,      // canal del último anuncio válido (o superficie si orgánico)
 *   attributionSource: 'paid_ad'|'organic',
 *   attributionTouchType: string|null,
 *   attributionTouchAt: string|null,
 *   attributionCampaignId: string, attributionAdsetId: string,
 *   attributionAdId: string, attributionAdName: string,
 *   attributionIds: object,
 *   conversionSurface: string,       // website|whatsapp|messenger|instagram
 *   metaActionSource: string,        // website | business_messaging
 *   metaMessagingChannel: string|null,
 *   touch: object|null
 * }}
 */
export async function resolveConversionAttribution({
  contactId,
  contact = null,
  conversionType = 'purchase',
  conversionSurface = '',
  conversionTime = null,
  payment = null
} = {}) {
  const resolvedContact = contact || await getContactForAttribution(contactId)

  const surface = await detectConversionSurface({
    contactId,
    contact: resolvedContact,
    explicitSurface: conversionSurface,
    conversionTime,
    payment
  })

  const touch = await findLastPaidTouch({
    contactId,
    contact: resolvedContact,
    conversionTime
  })

  return {
    conversionType,
    attributionChannel: touch?.channel || surface,
    attributionSource: touch ? 'paid_ad' : 'organic',
    attributionTouchType: touch?.type || null,
    attributionTouchAt: touch?.at || null,
    attributionCampaignId: touch?.campaignId || '',
    attributionAdsetId: touch?.adsetId || '',
    attributionAdId: touch?.adId || '',
    attributionAdName: touch?.adName || '',
    attributionIds: touch?.ids || {},
    conversionSurface: surface,
    metaActionSource: surface === 'website' ? 'website' : 'business_messaging',
    metaMessagingChannel: surface === 'website' ? null : surface,
    touch: touch || null
  }
}

// ── Persistencia del snapshot ───────────────────────────────────────────────

function buildSnapshotParams(resolution = {}) {
  return [
    resolution.attributionChannel || null,
    resolution.attributionSource || null,
    resolution.attributionTouchType || null,
    resolution.attributionTouchAt || null,
    resolution.attributionCampaignId || null,
    resolution.attributionAdsetId || null,
    resolution.attributionAdId || null,
    resolution.attributionAdName || null,
    resolution.attributionIds && Object.keys(resolution.attributionIds).length
      ? JSON.stringify(resolution.attributionIds)
      : null,
    resolution.conversionSurface || null
  ]
}

async function persistConversionAttribution(table, id, resolution) {
  const cleanId = cleanString(id)
  if (!cleanId || !resolution) return false
  try {
    // Write-once: el snapshot es un registro del momento de la conversión.
    // Los re-disparos (echos de webhooks, reintentos, resincronizaciones) NO
    // deben recalcular ni sobreescribir la atribución original.
    await db.run(
      `UPDATE ${table}
       SET attribution_channel = ?,
           attribution_source = ?,
           attribution_touch_type = ?,
           attribution_touch_at = ?,
           attribution_campaign_id = ?,
           attribution_adset_id = ?,
           attribution_ad_id = ?,
           attribution_ad_name = ?,
           attribution_ids_json = ?,
           conversion_surface = ?
       WHERE id = ? AND attribution_channel IS NULL`,
      [...buildSnapshotParams(resolution), cleanId]
    )
    return true
  } catch (error) {
    logger.warn(`No se pudo guardar snapshot de atribución en ${table} ${cleanId}: ${error.message}`)
    return false
  }
}

export async function persistPaymentConversionAttribution(paymentId, resolution) {
  return persistConversionAttribution('payments', paymentId, resolution)
}

export async function persistAppointmentConversionAttribution(appointmentId, resolution) {
  return persistConversionAttribution('appointments', appointmentId, resolution)
}
