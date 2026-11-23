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
//    (website, whatsapp, messenger, instagram o cobro automático). Decide el action_source y el
//    formato del payload de Meta CAPI. Nunca se falsifica: WhatsApp con ctwa
//    usa business_messaging/whatsapp; un chat orgánico sin ese click id usa
//    action_source=chat y conserva WhatsApp en custom_data, aunque la
//    atribución interna sea de un anuncio web.
//
// La frase clave: la atribución la decide el último anuncio válido; el
// payload de Meta lo decide la superficie real donde ocurrió la conversión.

import { databaseDialect, db } from '../config/database.js'
import { parseStoredUtcDateTime } from '../utils/dateUtils.js'
import { logger } from '../utils/logger.js'
import { buildPhoneMatchCandidates } from '../utils/phoneUtils.js'

export const CONVERSION_SURFACES = new Set(['website', 'whatsapp', 'messenger', 'instagram', 'system_generated'])

// utm_medium que consideramos tráfico pagado. fbp solo NO cuenta como paid:
// el pixel se lo pone a cualquier visitante (orgánico incluido); usarlo como
// señal paid haría que casi todo el tráfico web "robara" crédito.
const PAID_UTM_MEDIUM_VALUES = ['cpc', 'ppc', 'paid', 'paid_social', 'paidsocial', 'paid-social', 'pagado']

// fbc también es una cookie persistente (~90 días) que el pixel re-manda en
// CADA pageview posterior al click. Un fbc "viejo" no convierte en pagada a la
// sesión actual: solo cuenta si la cookie nació cerca del inicio de la sesión
// (mismo click). El formato es fb.<idx>.<creationTimeMs>.<fbclid>.
const FBC_FRESHNESS_TOLERANCE_MS = 6 * 60 * 60 * 1000

function parseMetaClickCookie(value) {
  const match = /^fb\.\d+\.(\d+)\.(\S+)$/.exec(cleanString(value))
  if (!match) return null
  const atMs = Number(match[1])
  return Number.isSafeInteger(atMs) && atMs > 0 ? { id: match[2], atMs, fbc: match[0] } : null
}

function cleanString(value) {
  return String(value || '').trim()
}

function parseJson(value, fallback = null) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value) ?? fallback
  } catch {
    return fallback
  }
}

function parseTimeMs(value) {
  return parseStoredUtcDateTime(value)?.toMillis() ?? null
}

// El límite entra en cada consulta antes del ORDER BY/LIMIT. Así las visitas
// posteriores al pago no desplazan su evidencia cuando llega otro webhook.
function beforeConversion(expression, beforeMs, params) {
  if (beforeMs == null) return ''
  params.push(new Date(beforeMs).toISOString())
  return databaseDialect === 'postgres'
    ? ` AND ${expression} <= ?::timestamp`
    : ` AND julianday(${expression}) <= julianday(?)`
}

function latestRow(rows, getTime) {
  let latest = null
  let latestTime = -Infinity
  for (const row of rows) {
    const time = getTime(row)
    if (time != null && time > latestTime) {
      latest = row
      latestTime = time
    }
  }
  return latest
}

function urlClickId(value) {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) ? cleanString(url.searchParams.get('fbclid')) : ''
  } catch {
    return ''
  }
}

async function getContactForAttribution(contactId) {
  if (!contactId) return null
  return db.get(
    `SELECT id, phone, email, visitor_id, source, created_at, updated_at,
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
  const anonymous = []
  if (contact?.visitor_id && visitorColumn) {
    anonymous.push(`${visitorColumn} = ?`)
    params.push(contact.visitor_id)
  }
  if (contact?.email && emailColumn) {
    anonymous.push(`LOWER(${emailColumn}) = ?`)
    params.push(String(contact.email).toLowerCase())
  }
  if (anonymous.length) {
    conditions.push(`(COALESCE(${column}, '') = '' AND (${anonymous.join(' OR ')}))`)
  }
  return { clause: conditions.join(' OR '), params }
}

// ── Touches pagados por silo ────────────────────────────────────────────────

function sessionIsPaid(session, click) {
  if (
    session.explicitClickId ||
    cleanString(session.gclid) ||
    cleanString(session.msclkid) ||
    cleanString(session.ttclid) ||
    cleanString(session.wbraid) ||
    cleanString(session.gbraid)
  ) return true
  // fbc solo cuenta si la cookie nació con esta sesión (mismo click). Una
  // cookie _fbc vieja re-enviada en una visita orgánica no roba crédito.
  if (click && Math.abs(Math.min(click.atMs, click.firstSeen) - session.seenAt) <= FBC_FRESHNESS_TOLERANCE_MS) return true
  if (cleanString(session.campaign_id) || cleanString(session.adset_id) || cleanString(session.ad_id)) return true
  if (cleanString(session.channel).toLowerCase() === 'paid') return true
  const medium = cleanString(session.utm_medium).toLowerCase()
  return PAID_UTM_MEDIUM_VALUES.some(value => medium === value || medium.includes('cpc') || medium.includes('ppc'))
}

// Consultamos únicamente eventos vinculados al contacto con señales publicitarias.
const PAID_SESSION_SQL_FILTER = `(
  COALESCE(fbclid, '') != ''
  OR page_url LIKE '%fbclid=%'
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

function savedPaidTouch(contact, payment, beforeMs) {
  if (!payment || payment.contact_id !== contact.id || payment.attribution_source !== 'paid_ad') return null
  const atMs = parseTimeMs(payment.attribution_touch_at)
  if (!atMs || beforeMs == null || atMs > beforeMs) return null
  return {
    type: payment.attribution_touch_type, channel: payment.attribution_channel,
    at: payment.attribution_touch_at, atMs, ids: parseJson(payment.attribution_ids_json, {}),
    adId: payment.attribution_ad_id, adName: payment.attribution_ad_name,
    adsetId: payment.attribution_adset_id, campaignId: payment.attribution_campaign_id
  }
}

function savedPaymentWebSession(saved) {
  if (saved?.type !== 'web' || saved.channel !== 'website') return null
  const ids = saved.ids
  return {
    started_at: saved.at, session_id: ids.sessionId,
    page_url: ids.pageUrl, fbclid: ids.fbclid, fbc: ids.fbc, fbp: ids.fbp, gclid: ids.gclid,
    campaign_id: saved.campaignId, adset_id: saved.adsetId,
    ad_id: saved.adId, ad_name: saved.adName
  }
}

async function getPaidWebEvidence(contact, beforeMs, snapshot) {
  const { clause, params } = buildContactMatchClause(contact)
  if (!clause) return {}

  const rows = await db.all(
    `SELECT id, session_id, started_at, created_at, page_url, referrer_url,
            utm_source, utm_medium, utm_campaign,
            fbclid, fbc, fbp, gclid, msclkid, ttclid, wbraid, gbraid,
            channel, source_platform,
            campaign_id, adset_id, ad_id, campaign_name, adset_name, ad_name
     FROM sessions
     WHERE (${clause})
       AND ${PAID_SESSION_SQL_FILTER}
       ${beforeConversion('started_at', beforeMs, params)}
     ORDER BY started_at DESC, created_at DESC, id DESC`,
    params
  ).catch(() => [])

  // Una instalación puede limpiar las sesiones después de guardar la evidencia en el cobro.
  const saved = savedPaymentWebSession(snapshot)
  if (saved) rows.push(saved)

  const clicks = new Map()
  for (const row of rows) {
    row.seenAt = parseTimeMs(row.started_at)
    row.explicitClickId = urlClickId(row.page_url) || cleanString(row.fbclid)
    const cookie = parseMetaClickCookie(row.fbc)
    const validCookie = cookie && cookie.atMs <= (beforeMs ?? row.seenAt)
      && (!row.explicitClickId || row.explicitClickId === cookie.id)
    const id = row.explicitClickId || (validCookie ? cookie.id : '')
    if (!id || !row.seenAt || /\s/.test(id)) continue
    row.clickId = id
    const previous = clicks.get(id)
    // La cookie guarda la hora del clic. Sin ella, la primera observación
    // del fbclid evita rejuvenecerlo en cada visita de la misma persona.
    const atMs = validCookie ? cookie.atMs : row.seenAt
    const firstSeen = Math.min(row.seenAt, previous?.firstSeen ?? row.seenAt)
    if (!previous || (validCookie && !previous.hasCookie) ||
        (Boolean(validCookie) === previous.hasCookie && atMs < previous.atMs)) {
      clicks.set(id, { atMs, firstSeen, hasCookie: Boolean(validCookie), fbc: validCookie ? cookie.fbc : `fb.1.${atMs}.${id}` })
    } else {
      previous.firstSeen = firstSeen
    }
  }
  const fbc = latestRow(clicks.values(), click => Math.min(click.firstSeen, click.atMs))?.fbc || ''
  // Los UTMs y los otros proveedores conservan el tiempo de su sesión. Para
  // un clic web repetido, el crédito no se mueve al reenviarse el mismo id.
  let session = null
  let touchAt = 0
  for (const row of rows) {
    const click = clicks.get(row.clickId)
    if (!sessionIsPaid(row, click)) continue
    const clickAt = click && Math.min(click.firstSeen, click.atMs)
    const cookieFromThisVisit = clickAt && Math.abs(row.seenAt - clickAt) <= FBC_FRESHNESS_TOLERANCE_MS
    const observedAt = (row.explicitClickId ? click?.firstSeen : cookieFromThisVisit && clickAt) || row.seenAt
    if (!session || observedAt > touchAt || (observedAt === touchAt && row.seenAt < session.seenAt)) {
      session = row
      touchAt = observedAt
    }
  }
  if (!session) return { fbc }
  const touch = {
    type: 'web',
    channel: 'website',
    at: new Date(touchAt).toISOString(),
    atMs: touchAt,
    campaignId: cleanString(session.campaign_id),
    adsetId: cleanString(session.adset_id),
    adId: cleanString(session.ad_id),
    campaignName: cleanString(session.campaign_name),
    adsetName: cleanString(session.adset_name),
    adName: cleanString(session.ad_name),
    ids: {
      sessionId: cleanString(session.session_id) || cleanString(session.id),
      fbclid: session.clickId || '',
      fbc: clicks.get(session.clickId)?.fbc || '',
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
  return { touch, fbc }
}

async function findLastPaidWhatsappTouch(contact, beforeMs = null) {
  if (!contact?.id) return null
  const phoneCandidates = buildPhoneMatchCandidates(contact.phone)
  const phoneFilter = phoneCandidates.length
    ? ` OR (COALESCE(contact_id, '') = '' AND phone IN (${phoneCandidates.map(() => '?').join(', ')}))`
    : ''

  const legacyParams = [contact.id, ...phoneCandidates]
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
       ${beforeConversion('created_at', beforeMs, legacyParams)}
     ORDER BY created_at DESC
     LIMIT 1`,
    legacyParams
  ).catch(() => [])

  const apiPhoneFilter = phoneCandidates.length
    ? ` OR (COALESCE(msg.contact_id, attr.contact_id, '') = '' AND
      (msg.phone IN (${phoneCandidates.map(() => '?').join(', ')}) OR attr.phone IN (${phoneCandidates.map(() => '?').join(', ')})))`
    : ''

  const apiParams = [contact.id, ...phoneCandidates, ...phoneCandidates]
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
     WHERE (COALESCE(NULLIF(msg.contact_id, ''), attr.contact_id) = ?${apiPhoneFilter})
       AND msg.direction = 'inbound'
       AND (
         COALESCE(attr.detected_ctwa_clid, msg.detected_ctwa_clid, '') != ''
         OR COALESCE(attr.detected_source_id, msg.detected_source_id, '') != ''
         OR COALESCE(attr.detected_source_url, msg.detected_source_url, '') != ''
         OR COALESCE(attr.detected_headline, msg.detected_headline, '') != ''
       )
       ${beforeConversion('COALESCE(msg.message_timestamp, attr.created_at, msg.created_at)', beforeMs, apiParams)}
     ORDER BY COALESCE(msg.message_timestamp, attr.created_at, msg.created_at) DESC, msg.id DESC
     LIMIT 1`,
    apiParams
  ).catch(() => [])

  const row = latestRow([...legacyRows, ...apiRows], entry => parseTimeMs(entry.created_at))
  if (!row) return null

  return {
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

  const params = [contact.id, contact.id]
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
       ${beforeConversion('COALESCE(message_timestamp, created_at)', beforeMs, params)}
     ORDER BY COALESCE(message_timestamp, created_at) DESC`,
    params
  ).catch(() => [])

  const adRows = rows
    .map(row => ({ ...row, referral: parseJson(row.referral_json, {}) }))
    .filter(row => socialReferralIsAd(row.referral))

  const row = latestRow(adRows, entry => parseTimeMs(entry.message_timestamp || entry.created_at))
  if (!row) return null

  const channel = cleanString(row.platform).toLowerCase() === 'instagram' ? 'instagram' : 'messenger'
  return {
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

  return (await getPaidEvidence(resolvedContact, conversionTime)).touch
}

async function getPaidEvidence(contact, conversionTime, payment = null) {
  if (!contact) return {}
  const beforeMs = parseTimeMs(conversionTime)
  const snapshot = savedPaidTouch(contact, payment, beforeMs)
  const savedWhatsapp = snapshot?.channel === 'whatsapp' && snapshot.type === 'whatsapp_ad' && cleanString(snapshot.ids.ctwaClid) ? snapshot : null
  const [web, whatsapp, social] = await Promise.all([
    getPaidWebEvidence(contact, beforeMs, snapshot),
    findLastPaidWhatsappTouch(contact, beforeMs),
    findLastPaidSocialTouch(contact, beforeMs)
  ])
  const latest = latestRow([web.touch, whatsapp, social, savedWhatsapp].filter(Boolean), entry => entry.atMs)
  // Una ficha legacy no lleva la fecha de adquisición de cada campo. Si la
  // ficha cambió después del pago, esos campos no prueban un clic anterior.
  const contactAt = parseTimeMs(contact.updated_at || contact.created_at)
  const allowLegacy = beforeMs == null || (contactAt != null && contactAt <= beforeMs)
  return { touch: latest || (allowLegacy ? buildLegacyContactPaidTouch(contact) : null), metaWebFbc: web.fbc || '' }
}

// ── Superficie real de conversión ───────────────────────────────────────────

async function getLastMessagingActivity(contact, beforeMs) {
  if (!contact?.id) return []
  const phoneCandidates = buildPhoneMatchCandidates(contact.phone)
  const phoneFilter = phoneCandidates.length
    ? ` OR (COALESCE(contact_id, '') = '' AND phone IN (${phoneCandidates.map(() => '?').join(', ')}))`
    : ''

  const whatsappParams = [contact.id, ...phoneCandidates]
  const socialParams = [contact.id, contact.id]
  const [whatsappRow, socialRow] = await Promise.all([
    db.get(
      `SELECT COALESCE(message_timestamp, created_at) as at
       FROM whatsapp_api_messages
       WHERE (contact_id = ?${phoneFilter})
         ${beforeConversion('COALESCE(message_timestamp, created_at)', beforeMs, whatsappParams)}
       ORDER BY COALESCE(message_timestamp, created_at) DESC
       LIMIT 1`,
      whatsappParams
    ).catch(() => null),
    db.get(
      `SELECT platform, COALESCE(message_timestamp, created_at) as at
       FROM meta_social_messages
       WHERE (
           contact_id = ?
           OR meta_social_contact_id IN (SELECT id FROM meta_social_contacts WHERE contact_id = ?)
         )
         AND COALESCE(comment_id, '') = ''
         ${beforeConversion('COALESCE(message_timestamp, created_at)', beforeMs, socialParams)}
       ORDER BY COALESCE(message_timestamp, created_at) DESC
       LIMIT 1`,
      socialParams
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

// El link público de estos pagos da acceso al recibo o al recordatorio.
// No demuestra que la persona haya pagado en un navegador.
export function paymentHasOfflineReceipt(payment = {}) {
  const provider = cleanString(payment.payment_provider || payment.provider).toLowerCase()
  const method = cleanString(payment.payment_method || payment.paymentMethod).toLowerCase()
  const metadata = parseJson(payment.metadata_json || payment.metadataJson || payment.metadata, {})
  return provider === 'offline'
    || (provider === 'manual' && ['cash', 'bank_transfer', 'transfer', 'deposit'].includes(method))
    || metadata.paymentPlan?.trigger === 'first_payment_offline'
    || metadata.source === 'offline_payment_plan_first_payment'
}

export async function isAutomaticPayment(payment, conversionTime) {
  const method = cleanString(payment.payment_method || payment.paymentMethod).toLowerCase()
  const metadata = parseJson(payment.metadata_json || payment.metadataJson || payment.metadata, {})
  // Algunos planes programan un enlace que el cliente abre. Sólo el débito
  // con tarjeta guardada acredita un cargo sin interacción de navegador.
  if (metadata.paymentPlan?.trigger === 'scheduled_installment' &&
      /^(stripe|conekta|rebill)_(scheduled|saved)_card$/.test(method)) return true

  if (method === 'stripe_subscription') {
    return metadata.stripeBillingReason === 'subscription_cycle' && metadata.stripeCollectionMethod === 'charge_automatically'
  }
  const renewalSource = {
    conekta_subscription: 'conekta_subscription_webhook',
    mercadopago_subscription: 'mercadopago_subscription_authorized_payment',
    rebill_subscription: 'rebill_subscription_webhook'
  }[method]
  if (!renewalSource || metadata.source !== renewalSource || !metadata.ristakSubscriptionId || !payment.contact_id) return false

  const subscription = await db.get('SELECT metadata_json FROM subscriptions WHERE id = ? AND contact_id = ?', [metadata.ristakSubscriptionId, payment.contact_id])
  const subscriptionMeta = parseJson(subscription?.metadata_json, {})
  const startId = subscriptionMeta.subscriptionStartPayment?.paymentId || subscriptionMeta.publicPaymentLink?.paymentId
  if (!startId || startId === payment.id) return false
  const start = await db.get("SELECT paid_at, date FROM payments WHERE id = ? AND contact_id = ? AND status = 'paid' AND amount > 0 AND payment_mode = ?",
    [startId, payment.contact_id, payment.payment_mode])
  const firstPaidAt = parseTimeMs(start?.paid_at || start?.date)
  return firstPaidAt != null && firstPaidAt < parseTimeMs(conversionTime)
}

/**
 * Detecta la superficie donde ocurrió la conversión.
 *
 * - Para conversiones interactivas el caller puede especificar la superficie,
 *   por ejemplo en un checkout público o un booking en el widget web.
 * - Un cobro automático acreditado por la pasarela o el plan es system_generated.
 * - Una página de checkout es website; una URL de recibo no acredita navegación.
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
  if (payment && await isAutomaticPayment(payment, conversionTime)) return 'system_generated'
  if (CONVERSION_SURFACES.has(normalizedExplicit)) return normalizedExplicit

  if (payment && !paymentHasOfflineReceipt(payment)) {
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
  const activity = (await getLastMessagingActivity(resolvedContact, beforeMs))
    .sort((a, b) => b.atMs - a.atMs)

  return activity[0]?.surface || 'website'
}

// Última sesión web del contacto (pagada o no): aporta fbp/fbc/URL para
// eventos server-side con superficie website.
export async function getLatestContactWebSession(contactOrId, conversionTime = null, checkoutUrl = '') {
  const contact = typeof contactOrId === 'object' && contactOrId !== null
    ? contactOrId
    : await getContactForAttribution(contactOrId)
  if (!contact) return null
  const { clause, params } = buildContactMatchClause(contact)
  if (!clause) return null

  const cutoff = beforeConversion('started_at', parseTimeMs(conversionTime), params)
  const preferCheckout = checkoutUrl ? 'CASE WHEN page_url = ? THEN 0 ELSE 1 END,' : ''
  if (checkoutUrl) params.push(checkoutUrl)
  return db.get(
    `SELECT id, session_id, started_at, created_at, page_url, fbclid, fbc, fbp, user_agent
     FROM sessions
     WHERE (${clause})
       ${cutoff}
     ORDER BY ${preferCheckout} started_at DESC, created_at DESC, id DESC
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
 *   conversionSurface: string,       // website|whatsapp|messenger|instagram|system_generated
 *   metaActionSource: string,        // website | business_messaging | system_generated
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

  const { touch, metaWebFbc } = await getPaidEvidence(resolvedContact, conversionTime, payment)

  return {
    metaWebFbc,
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
    metaActionSource: ['website', 'system_generated'].includes(surface) ? surface : 'business_messaging',
    metaMessagingChannel: ['website', 'system_generated'].includes(surface) ? null : surface,
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
