import { db } from '../config/database.js'
import { normalizeTrafficSource, normalizeWhatsAppAttributionPlatform } from '../utils/trafficSourceNormalizer.js'

// Fuentes "genéricas" que no aportan información de plataforma real.
const GENERIC_SOURCES = new Set(['Directo', 'Desconocido', 'Otro'])

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

/**
 * Dado un conjunto de contactos, devuelve el desglose por fuente de origen,
 * usando la misma resolución que la lista de contactos (sesión web + WhatsApp/Meta).
 * @param {string[]} contactIds
 * @param {{ limit?: number }} options
 * @returns {Promise<Array<{ name: string, value: number }>>} ordenado desc, top `limit`
 */
export async function getContactSourceBreakdown(contactIds = [], { limit = 10 } = {}) {
  const ids = Array.from(new Set((contactIds || []).filter(Boolean)))
  if (!ids.length) return []

  const placeholders = ids.map(() => '?').join(', ')

  const contacts = await db.all(`
    SELECT id, source, visitor_id, email,
           attribution_url, attribution_session_source, attribution_medium,
           attribution_ctwa_clid, attribution_ad_id
    FROM contacts
    WHERE id IN (${placeholders})
  `, ids)

  if (!contacts.length) return []

  // Primeras sesiones: por contact_id, visitor_id o email (misma lógica que la lista de contactos).
  const visitorIds = Array.from(new Set(contacts.map(c => c.visitor_id).filter(Boolean)))
  const emails = Array.from(new Set(
    contacts.map(c => c.email).filter(Boolean).map(email => String(email).toLowerCase())
  ))

  const sessionConditions = []
  const sessionParams = []
  const addInCondition = (field, values) => {
    if (!values.length) return
    sessionConditions.push(`${field} IN (${values.map(() => '?').join(', ')})`)
    sessionParams.push(...values)
  }
  addInCondition('contact_id', ids)
  addInCondition('visitor_id', visitorIds)
  addInCondition('LOWER(email)', emails)

  const firstSessionsByContact = new Map()
  const firstSessionsByVisitor = new Map()
  const firstSessionsByEmail = new Map()

  if (sessionConditions.length) {
    const sessions = await db.all(`
      SELECT contact_id, visitor_id, email, referrer_url, site_source_name, utm_source, source_platform
      FROM sessions
      WHERE ${sessionConditions.join(' OR ')}
      ORDER BY started_at ASC, created_at ASC, id ASC
    `, sessionParams)

    sessions.forEach(session => {
      if (session.contact_id && !firstSessionsByContact.has(session.contact_id)) {
        firstSessionsByContact.set(session.contact_id, session)
      }
      if (session.visitor_id && !firstSessionsByVisitor.has(session.visitor_id)) {
        firstSessionsByVisitor.set(session.visitor_id, session)
      }
      if (session.email) {
        const emailKey = String(session.email).toLowerCase()
        if (!firstSessionsByEmail.has(emailKey)) {
          firstSessionsByEmail.set(emailKey, session)
        }
      }
    })
  }

  const getFirstSessionForContact = (contact) =>
    firstSessionsByContact.get(contact.id) ||
    (contact.visitor_id ? firstSessionsByVisitor.get(contact.visitor_id) : null) ||
    (contact.email ? firstSessionsByEmail.get(String(contact.email).toLowerCase()) : null) ||
    null

  const whatsappByContact = await loadFirstWhatsAppAttributions(ids)

  const counts = new Map()
  contacts.forEach(contact => {
    const source = resolveContactSource(
      contact,
      getFirstSessionForContact(contact),
      whatsappByContact.get(contact.id)
    )
    counts.set(source, (counts.get(source) || 0) + 1)
  })

  return Array.from(counts.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
}
