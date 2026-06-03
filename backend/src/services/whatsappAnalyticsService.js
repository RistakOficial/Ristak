import { db } from '../config/database.js'
import { resolveDateRangeWithGHLTimezone } from '../utils/dateUtils.js'
import { normalizeWhatsAppAttributionPlatform } from '../utils/trafficSourceNormalizer.js'

const isPostgres = Boolean(process.env.DATABASE_URL)
const DEFAULT_SESSION_ID = 'default'

const SOURCE_COLORS = {
  Facebook: '#1877f2',
  Instagram: '#c32aa3',
  'Meta Ads': '#0084ff',
  WhatsApp: '#25d366',
  'WhatsApp directo': '#25d366',
  Google: '#4285f4',
  TikTok: '#ee1d52',
  LinkedIn: '#0a66c2',
  YouTube: '#ff0000',
  Directo: '#6b7280',
  Orgánico: '#10b981',
  Referencia: '#8b5cf6',
  Otro: '#94a3b8',
  Desconocido: '#64748b'
}

const messageTimestampExpr = (alias = 'm') => `COALESCE(${alias}.message_timestamp, ${alias}.created_at)`
const contactKeyExpr = (alias = 'm') => `COALESCE(NULLIF(${alias}.contact_id, ''), NULLIF(${alias}.phone, ''), NULLIF(${alias}.remote_jid, ''), ${alias}.id)`

function timestampDateExpression(column, timezone = 'UTC') {
  if (!isPostgres) return `DATE(${column})`

  const safeTimezone = String(timezone || 'UTC').replace(/'/g, "''")
  return `((${column})::timestamptz AT TIME ZONE '${safeTimezone}')::date`
}

function bucketExpression(column, groupBy, timezone = 'UTC') {
  if (!isPostgres) {
    if (groupBy === 'year') return `strftime('%Y', ${column})`
    if (groupBy === 'month') return `strftime('%Y-%m', ${column})`
    return `DATE(${column})`
  }

  const safeTimezone = String(timezone || 'UTC').replace(/'/g, "''")
  if (groupBy === 'year') return `TO_CHAR(((${column})::timestamptz AT TIME ZONE '${safeTimezone}'), 'YYYY')`
  if (groupBy === 'month') return `TO_CHAR(((${column})::timestamptz AT TIME ZONE '${safeTimezone}'), 'YYYY-MM')`
  return `TO_CHAR(((${column})::timestamptz AT TIME ZONE '${safeTimezone}'), 'YYYY-MM-DD')`
}

function attributionPredicate(alias = 'm') {
  return `(
    NULLIF(${alias}.detected_source_id, '') IS NOT NULL
    OR NULLIF(${alias}.detected_source_url, '') IS NOT NULL
    OR NULLIF(${alias}.detected_ctwa_clid, '') IS NOT NULL
    OR NULLIF(${alias}.detected_source_app, '') IS NOT NULL
    OR NULLIF(${alias}.detected_entry_point, '') IS NOT NULL
  )`
}

function normalizeSource(row = {}) {
  const platform = normalizeWhatsAppAttributionPlatform({
    referral_source_url: row.detected_source_url,
    source_url: row.detected_source_url,
    attribution_url: row.detected_source_url,
    referral_source_app: row.detected_source_app,
    source_app: row.detected_source_app,
    referral_source_type: row.detected_source_type,
    source_type: row.detected_source_type,
    referral_entry_point: row.detected_entry_point,
    entry_point: row.detected_entry_point,
    referral_source_id: row.detected_source_id,
    source_id: row.detected_source_id,
    referral_ctwa_clid: row.detected_ctwa_clid,
    ctwa_clid: row.detected_ctwa_clid,
    source: 'WhatsApp'
  })

  // Un mensaje sin origen de anuncio/enlace es una conversación directa de WhatsApp
  return platform === 'WhatsApp' ? 'WhatsApp directo' : platform
}

function colorForSource(name) {
  return SOURCE_COLORS[name] || SOURCE_COLORS.Otro
}

export async function getWhatsAppTrafficSourcesForRange({
  startDate,
  endDate,
  sessionId = DEFAULT_SESSION_ID,
  limit = 10
}) {
  const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
  const contactKey = contactKeyExpr('m')
  const messageTime = messageTimestampExpr('m')

  const rows = await db.all(`
    SELECT
      detected_source_id,
      detected_source_url,
      detected_ctwa_clid,
      detected_source_app,
      detected_source_type,
      detected_entry_point
    FROM (
      SELECT
        m.detected_source_id,
        m.detected_source_url,
        m.detected_ctwa_clid,
        m.detected_source_app,
        m.detected_source_type,
        m.detected_entry_point,
        ROW_NUMBER() OVER (
          PARTITION BY ${contactKey}
          ORDER BY ${messageTime} ASC, m.created_at ASC, m.id ASC
        ) as source_rank
      FROM whatsapp_web_messages m
      WHERE m.session_id = ?
        AND ${messageTime} >= ?
        AND ${messageTime} <= ?
        AND LOWER(COALESCE(m.direction, 'inbound')) = 'inbound'
    ) ranked
    WHERE source_rank = 1
  `, [sessionId, range.startUtc, range.endUtc])

  const sourceMap = new Map()
  rows.forEach(row => {
    const sourceName = normalizeSource(row)
    sourceMap.set(sourceName, (sourceMap.get(sourceName) || 0) + 1)
  })

  return Array.from(sourceMap.entries())
    .map(([name, value]) => ({
      name,
      value,
      color: colorForSource(name)
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
}

export async function getWhatsAppWebAnalytics({
  startDate,
  endDate,
  groupBy = 'day',
  sessionId = DEFAULT_SESSION_ID
}) {
  const safeGroupBy = ['day', 'month', 'year'].includes(groupBy) ? groupBy : 'day'
  const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
  const messageTime = messageTimestampExpr('m')
  const contactKey = contactKeyExpr('m')
  const bucket = bucketExpression(messageTime, safeGroupBy, range.appliedTimezone)
  const dateExpr = timestampDateExpression(messageTime, range.appliedTimezone)
  const dateFilter = isPostgres
    ? `${dateExpr} >= ?::date AND ${dateExpr} <= ?::date`
    : `${dateExpr} >= DATE(?) AND ${dateExpr} <= DATE(?)`

  const session = await db.get('SELECT id, status, label, phone, jid, push_name FROM whatsapp_web_sessions WHERE id = ?', [sessionId])

  const [metrics, trendRows, topContacts, sources] = await Promise.all([
    db.get(`
      SELECT
        COUNT(*) as total_messages,
        SUM(CASE WHEN LOWER(COALESCE(m.direction, 'inbound')) = 'inbound' THEN 1 ELSE 0 END) as inbound_messages,
        SUM(CASE WHEN LOWER(COALESCE(m.direction, '')) = 'outbound' THEN 1 ELSE 0 END) as outbound_messages,
        COUNT(DISTINCT ${contactKey}) as conversations,
        COUNT(DISTINCT CASE WHEN m.contact_id IS NOT NULL AND m.contact_id != '' THEN m.contact_id END) as contacts,
        SUM(CASE WHEN ${attributionPredicate('m')} THEN 1 ELSE 0 END) as attributed_messages
      FROM whatsapp_web_messages m
      WHERE m.session_id = ?
        AND ${dateFilter}
    `, [sessionId, startDate, endDate]),
    db.all(`
      SELECT
        ${bucket} as label,
        COUNT(*) as messages,
        COUNT(DISTINCT ${contactKey}) as conversations,
        COUNT(DISTINCT CASE WHEN m.contact_id IS NOT NULL AND m.contact_id != '' THEN m.contact_id END) as contacts,
        SUM(CASE WHEN ${attributionPredicate('m')} THEN 1 ELSE 0 END) as attributed
      FROM whatsapp_web_messages m
      WHERE m.session_id = ?
        AND ${dateFilter}
        AND LOWER(COALESCE(m.direction, 'inbound')) = 'inbound'
      GROUP BY label
      ORDER BY label ASC
    `, [sessionId, startDate, endDate]),
    db.all(`
      SELECT
        ${contactKey} as id,
        MAX(NULLIF(m.push_name, '')) as name,
        MAX(NULLIF(m.phone, '')) as phone,
        COUNT(*) as messages
      FROM whatsapp_web_messages m
      WHERE m.session_id = ?
        AND ${dateFilter}
        AND LOWER(COALESCE(m.direction, 'inbound')) = 'inbound'
      GROUP BY ${contactKey}
      ORDER BY messages DESC
      LIMIT 8
    `, [sessionId, startDate, endDate]),
    getWhatsAppTrafficSourcesForRange({ startDate, endDate, sessionId, limit: 10 })
  ])

  const inboundMessages = Number(metrics?.inbound_messages || 0)
  const attributedMessages = Number(metrics?.attributed_messages || 0)

  return {
    status: {
      connected: session?.status === 'connected',
      configured: Boolean(session),
      status: session?.status || null,
      hasData: Number(metrics?.total_messages || 0) > 0
    },
    metrics: {
      inboundMessages,
      outboundMessages: Number(metrics?.outbound_messages || 0),
      conversations: Number(metrics?.conversations || 0),
      contacts: Number(metrics?.contacts || 0),
      attributedMessages,
      attributionRate: inboundMessages > 0 ? (attributedMessages / inboundMessages) * 100 : 0
    },
    trend: trendRows.map(row => ({
      label: row.label,
      messages: Number(row.messages || 0),
      conversations: Number(row.conversations || 0),
      contacts: Number(row.contacts || 0),
      attributed: Number(row.attributed || 0)
    })),
    sources,
    topContacts: topContacts.map(row => ({
      id: row.id,
      name: row.name || null,
      phone: row.phone || null,
      messages: Number(row.messages || 0)
    }))
  }
}
