import { db } from '../config/database.js'

const SOCIAL_CHANNELS = new Set(['instagram', 'messenger'])
const COMMENT_CHANNELS = new Set(['facebook_comment', 'instagram_comment'])
const SMS_TRANSPORTS = ['ghl_sms', 'sms', 'sms_qr', 'mms']
const WEBCHAT_TRANSPORTS = ['ghl_webchat', 'webchat', 'web_chat', 'chat_web', 'website_chat', 'site_chat']
const NON_SUBSTANTIVE_TYPES = ['reaction', 'sticker']

function normalizeAuthorityChannel(value = 'whatsapp') {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  const aliases = {
    wa: 'whatsapp',
    whatsapp_api: 'whatsapp',
    api: 'whatsapp',
    ghl_whatsapp: 'whatsapp',
    fb: 'messenger',
    facebook: 'messenger',
    facebook_messenger: 'messenger',
    ig: 'instagram',
    instagram_dm: 'instagram',
    sms_qr: 'sms',
    ghl_sms: 'sms',
    mms: 'sms',
    ghl_webchat: 'webchat',
    web_chat: 'webchat',
    chat_web: 'webchat',
    website_chat: 'webchat',
    site_chat: 'webchat',
    correo: 'email',
    mail: 'email',
    e_mail: 'email'
  }
  const normalized = aliases[raw] || raw || 'whatsapp'
  return [
    'whatsapp', 'instagram', 'messenger', 'sms', 'webchat',
    'facebook_comment', 'instagram_comment', 'email'
  ].includes(normalized)
    ? normalized
    : 'whatsapp'
}

function sqlStringList(values = []) {
  return values.map((value) => `'${String(value).replaceAll("'", "''")}'`).join(', ')
}

function phoneTransportFilter(channel) {
  if (channel === 'sms') {
    return `AND LOWER(COALESCE(transport, '')) IN (${sqlStringList(SMS_TRANSPORTS)})`
  }
  if (channel === 'webchat') {
    return `AND LOWER(COALESCE(transport, '')) IN (${sqlStringList(WEBCHAT_TRANSPORTS)})`
  }
  return `AND LOWER(COALESCE(transport, '')) NOT IN (${sqlStringList([...SMS_TRANSPORTS, ...WEBCHAT_TRANSPORTS])})`
}

function authorityClaimChannel(channel) {
  if (channel === 'instagram_comment') return 'instagram'
  if (channel === 'facebook_comment') return 'messenger'
  if (SOCIAL_CHANNELS.has(channel) || channel === 'email') return channel
  // SMS/webchat/WhatsApp comparten `whatsapp_api_messages`; el claim durable de
  // esa tabla se registra hoy bajo el canal físico `whatsapp`.
  return 'whatsapp'
}

function parseAuthorityInstant(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime()
    return Number.isFinite(timestamp) ? timestamp : null
  }
  const raw = String(value || '').trim()
  if (!raw) return null
  // SQLite CURRENT_TIMESTAMP es UTC aunque no incluya sufijo. Date.parse lo
  // interpreta como hora local en hosts fuera de UTC y puede invertir el orden
  // frente a un ISO con Z. Normalizamos sólo ese formato SQL sin zona.
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw
  const timestamp = Date.parse(normalized)
  return Number.isFinite(timestamp) ? timestamp : null
}

function authorityEnvelopeTokens(row = {}) {
  const fields = [
    'provider_message_id',
    'ycloud_message_id',
    'meta_message_id',
    'wamid',
    'protocol_message_key_id',
    'smtp_message_id',
    'comment_id'
  ]
  const tokens = new Set()
  for (const field of fields) {
    const value = String(row?.[field] || '').trim()
    if (value) tokens.add(value)
  }
  return tokens
}

function sharesInboundAuthorityEnvelope(candidate, handled) {
  const handledTokens = authorityEnvelopeTokens(handled)
  if (!handledTokens.size) return false
  for (const token of authorityEnvelopeTokens(candidate)) {
    if (handledTokens.has(token)) return true
  }
  return false
}

function compareInboundAuthorityOrder(candidate, handled) {
  let comparable = false
  // Un claim representa recepción local y created_at representa persistencia;
  // mezclarlos inventa un reloj. Sólo se compara la misma fuente temporal en
  // ambos mensajes, de mayor a menor autoridad.
  for (const field of ['message_timestamp', 'authority_claimed_at', 'created_at']) {
    const candidateAt = parseAuthorityInstant(candidate?.[field])
    const handledAt = parseAuthorityInstant(handled?.[field])
    if (candidateAt === null || handledAt === null) continue
    comparable = true
    if (candidateAt !== handledAt) {
      return { order: candidateAt > handledAt ? 1 : -1, comparable: true }
    }
  }
  return { order: 0, comparable }
}

async function loadInboundAuthorityRows({ contactId, channel, messageId = '', limit = 16 } = {}) {
  const normalizedChannel = normalizeAuthorityChannel(channel)
  const claimChannel = authorityClaimChannel(normalizedChannel)
  const exactMessageFilter = messageId ? 'AND m.id = ?' : ''
  const substantiveFilter = messageId
    ? ''
    : `AND LOWER(COALESCE(m.message_type, '')) NOT IN (${sqlStringList(NON_SUBSTANTIVE_TYPES)})`
  const limitSql = messageId ? 'LIMIT 1' : 'LIMIT ?'
  const boundedLimit = Math.max(1, Math.min(64, Math.trunc(Number(limit) || 16)))

  if (COMMENT_CHANNELS.has(normalizedChannel)) {
    const platform = normalizedChannel === 'instagram_comment' ? 'instagram' : 'messenger'
    return db.all(`
      SELECT m.id, m.message_type, m.message_timestamp, m.created_at,
             m.meta_message_id, m.comment_id,
             authority_claim.claimed_at AS authority_claimed_at
      FROM meta_social_messages m
      LEFT JOIN chat_inbound_message_claims authority_claim
        ON authority_claim.channel = ?
       AND authority_claim.message_id = m.id
       AND authority_claim.contact_id = m.contact_id
      WHERE m.contact_id = ? AND m.platform = ?
        AND m.message_type IN ('comment', 'comment_reply_public', 'comment_reply_private')
        AND LOWER(COALESCE(m.direction, 'inbound')) = 'inbound'
        ${exactMessageFilter}
        ${substantiveFilter}
      ORDER BY COALESCE(m.message_timestamp, m.created_at) DESC,
               COALESCE(authority_claim.claimed_at, m.created_at) DESC,
               m.created_at DESC, m.id DESC
      ${limitSql}
    `, [claimChannel, contactId, platform, ...(messageId ? [messageId] : [boundedLimit])])
  }

  if (SOCIAL_CHANNELS.has(normalizedChannel)) {
    return db.all(`
      SELECT m.id, m.message_type, m.message_timestamp, m.created_at,
             m.meta_message_id, m.comment_id,
             authority_claim.claimed_at AS authority_claimed_at
      FROM meta_social_messages m
      LEFT JOIN chat_inbound_message_claims authority_claim
        ON authority_claim.channel = ?
       AND authority_claim.message_id = m.id
       AND authority_claim.contact_id = m.contact_id
      WHERE m.contact_id = ? AND m.platform = ?
        AND m.message_type NOT IN ('comment', 'comment_reply_public', 'comment_reply_private')
        AND LOWER(COALESCE(m.direction, 'inbound')) = 'inbound'
        ${exactMessageFilter}
        ${substantiveFilter}
      ORDER BY COALESCE(m.message_timestamp, m.created_at) DESC,
               COALESCE(authority_claim.claimed_at, m.created_at) DESC,
               m.created_at DESC, m.id DESC
      ${limitSql}
    `, [claimChannel, contactId, normalizedChannel, ...(messageId ? [messageId] : [boundedLimit])])
  }

  if (normalizedChannel === 'email') {
    return db.all(`
      SELECT m.id, 'email' AS message_type, m.message_timestamp, m.created_at,
             m.smtp_message_id,
             authority_claim.claimed_at AS authority_claimed_at
      FROM email_messages m
      LEFT JOIN chat_inbound_message_claims authority_claim
        ON authority_claim.channel = ?
       AND authority_claim.message_id = m.id
       AND authority_claim.contact_id = m.contact_id
      WHERE m.contact_id = ?
        AND LOWER(COALESCE(m.direction, 'inbound')) = 'inbound'
        ${exactMessageFilter}
      ORDER BY COALESCE(m.message_timestamp, m.created_at) DESC,
               COALESCE(authority_claim.claimed_at, m.created_at) DESC,
               m.created_at DESC, m.id DESC
      ${limitSql}
    `, [claimChannel, contactId, ...(messageId ? [messageId] : [boundedLimit])])
  }

  return db.all(`
    SELECT m.id, m.message_type, m.message_timestamp, m.created_at,
           m.provider_message_id, m.ycloud_message_id, m.meta_message_id,
           m.wamid, m.protocol_message_key_id,
           authority_claim.claimed_at AS authority_claimed_at
    FROM whatsapp_api_messages m
    LEFT JOIN chat_inbound_message_claims authority_claim
      ON authority_claim.channel = ?
     AND authority_claim.message_id = m.id
     AND authority_claim.contact_id = m.contact_id
    WHERE m.contact_id = ?
      AND LOWER(COALESCE(m.direction, 'inbound')) = 'inbound'
      ${phoneTransportFilter(normalizedChannel)}
      ${exactMessageFilter}
      ${substantiveFilter}
    ORDER BY COALESCE(m.message_timestamp, m.created_at) DESC,
             COALESCE(authority_claim.claimed_at, m.created_at) DESC,
             m.created_at DESC, m.id DESC
    ${limitSql}
  `, [claimChannel, contactId, ...(messageId ? [messageId] : [boundedLimit])])
}

/**
 * Comprueba la autoridad temporal de un inbound justo antes de un efecto
 * terminal. `checked=false` significa que el caller no viene de una fila
 * canónica (preview, recovery sintético o prueba directa) y no autoriza por sí
 * solo a bloquear el efecto. Si la fila sí existe, cualquier inbound
 * sustantivo posterior invalida el borrador anterior.
 */
export async function findNewerSubstantiveConversationalInbound({
  contactId,
  handledMessageId,
  channel = 'whatsapp',
  limit = 16
} = {}) {
  const cleanContactId = String(contactId || '').trim()
  const cleanHandledMessageId = String(handledMessageId || '').trim()
  if (!cleanContactId || !cleanHandledMessageId || cleanHandledMessageId.startsWith('payment-resume:')) {
    return { checked: false, newerMessage: null, reason: 'non_canonical_execution' }
  }

  const [handledRows, latestRows] = await Promise.all([
    loadInboundAuthorityRows({
      contactId: cleanContactId,
      channel,
      messageId: cleanHandledMessageId
    }),
    loadInboundAuthorityRows({ contactId: cleanContactId, channel, limit })
  ])
  const handled = handledRows[0] || null
  if (!handled) {
    return { checked: false, newerMessage: null, reason: 'handled_message_not_found' }
  }

  let ambiguousMessage = null
  const newerMessage = latestRows.find((row) => {
    if (String(row?.id || '') === cleanHandledMessageId) return false
    // HighLevel y algunos providers materializan un solo mensaje remoto en
    // varias filas renderizables (texto/adjuntos). Esas filas hermanas no son
    // una instrucción posterior y comparten una identidad durable del provider.
    if (sharesInboundAuthorityEnvelope(row, handled)) return false
    const comparison = compareInboundAuthorityOrder(row, handled)
    if (comparison.order > 0) return true
    if (comparison.order === 0 && comparison.comparable && !ambiguousMessage) {
      // Si dos inbounds distintos empatan en toda la evidencia temporal, no hay
      // una base portable para declarar vigente al borrador anterior. Fallamos
      // cerrado sin convertir el hash/ID en un reloj inventado.
      ambiguousMessage = row
    }
    return false
  }) || ambiguousMessage
  return {
    checked: true,
    newerMessage,
    reason: newerMessage
      ? (newerMessage === ambiguousMessage ? 'ambiguous_substantive_inbound_order' : 'newer_substantive_inbound')
      : 'current'
  }
}
