import crypto from 'crypto'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { isTrustedTrackingVisitorId } from '../utils/trackingVisitorIdentity.js'

const AUTO_LINK_CONFIDENCE = 90
const CANDIDATE_CONFIDENCE = 70
const IDENTITY_LOOKBACK_DAYS = 7

const CLICK_ID_FIELDS = [
  ['gclid', 96],
  ['wbraid', 94],
  ['gbraid', 94],
  ['msclkid', 94],
  ['ttclid', 94],
  ['fbclid', 93],
  ['fbc', 93],
  ['fbp', 88]
]

const SOURCE_FIELDS = [
  'gclid',
  'wbraid',
  'gbraid',
  'msclkid',
  'ttclid',
  'fbclid',
  'fbc',
  'campaign_id',
  'adset_id',
  'ad_id',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'site_id',
  'public_page_id',
  'form_site_id'
]

const STRONG_SOURCE_FIELDS = [
  'gclid',
  'wbraid',
  'gbraid',
  'msclkid',
  'ttclid',
  'fbclid',
  'fbc',
  'campaign_id',
  'adset_id',
  'ad_id',
  'utm_campaign',
  'site_id',
  'form_site_id'
]

function cleanString(value, maxLength = 500) {
  const cleaned = String(value || '').trim()
  return cleaned ? cleaned.slice(0, maxLength) : null
}

function cleanLower(value, maxLength = 500) {
  return cleanString(value, maxLength)?.toLowerCase() || null
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function hashParts(parts = []) {
  const cleanParts = parts
    .map(part => cleanString(part, 300))
    .filter(Boolean)

  if (!cleanParts.length) return null
  return crypto.createHash('sha256').update(cleanParts.join('|')).digest('hex')
}

function normalizeIp(value) {
  let ip = cleanString(value, 120)
  if (!ip) return null
  if (ip.startsWith('::ffff:')) ip = ip.substring(7)
  return ip
}

function networkPrefix(ip) {
  const normalized = normalizeIp(ip)
  if (!normalized) return null

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) {
    return normalized.split('.').slice(0, 3).join('.')
  }

  if (normalized.includes(':')) {
    return normalized.split(':').slice(0, 4).join(':').toLowerCase()
  }

  return normalized
}

function osFamily(value) {
  const raw = cleanLower(value, 120)
  if (!raw) return null
  if (raw.includes('android')) {
    const major = raw.match(/android\s+(\d+)/)?.[1]
    return major ? `android:${major}` : 'android'
  }
  if (raw.includes('ios') || raw.includes('iphone') || raw.includes('ipad')) {
    const major = raw.match(/(?:ios|os)\s+(\d+)/)?.[1]
    return major ? `ios:${major}` : 'ios'
  }
  if (raw.includes('mac')) return 'macos'
  if (raw.includes('windows')) return 'windows'
  if (raw.includes('linux')) return 'linux'
  return raw.replace(/\s+\d+(?:[._]\d+)*/g, '')
}

function languageFamily(value) {
  return cleanLower(value, 80)?.split('-')[0] || null
}

function roundedNumber(value, step = 1) {
  const number = numberOrNull(value)
  if (number === null) return null
  return String(Math.round(number / step) * step)
}

function screenPair(width, height) {
  const w = numberOrNull(width)
  const h = numberOrNull(height)
  if (!w || !h) return null
  const small = Math.min(w, h)
  const large = Math.max(w, h)
  return `${Math.round(small)}x${Math.round(large)}`
}

function sourceContextFromData(data = {}) {
  const source = {}
  for (const field of SOURCE_FIELDS) {
    const value = cleanLower(data[field], 500)
    if (value) source[field] = value
  }
  if (!source.public_page_id && data.page_id) source.public_page_id = cleanLower(data.page_id, 160)
  if (!source.site_id && data.siteId) source.site_id = cleanLower(data.siteId, 160)
  return source
}

function countSourceMatches(current = {}, candidate = {}) {
  let matches = 0
  for (const field of SOURCE_FIELDS) {
    if (current[field] && candidate[field] && current[field] === candidate[field]) {
      matches += 1
    }
  }
  return matches
}

function countStrongSourceMatches(current = {}, candidate = {}) {
  let matches = 0
  for (const field of STRONG_SOURCE_FIELDS) {
    if (current[field] && candidate[field] && current[field] === candidate[field]) {
      matches += 1
    }
  }
  return matches
}

function hasStrongSourceConflict(current = {}, candidate = {}) {
  return STRONG_SOURCE_FIELDS.some(field => (
    current[field] &&
    candidate[field] &&
    current[field] !== candidate[field]
  ))
}

function hasStrongSourceContext(source = {}) {
  return Boolean(
    source.gclid ||
    source.wbraid ||
    source.gbraid ||
    source.msclkid ||
    source.ttclid ||
    source.fbclid ||
    source.fbc ||
    source.ad_id ||
    source.campaign_id ||
    source.utm_campaign ||
    source.site_id
  )
}

function extractClickIds(data = {}) {
  return CLICK_ID_FIELDS
    .map(([field, score]) => ({
      field,
      value: cleanString(data[field], 500),
      score
    }))
    .filter(item => item.value)
}

export function buildTrackingIdentitySignals({ data = {}, ip = null, userAgent = null } = {}) {
  const screen = screenPair(data.screen_width || data.screenWidth, data.screen_height || data.screenHeight)
  const viewport = screenPair(data.viewport_width || data.viewportWidth, data.viewport_height || data.viewportHeight)
  const platform = cleanLower(data.platform, 120)
  const vendor = cleanLower(data.vendor, 120)
  const deviceParts = [
    cleanLower(data.device_type || data.deviceType, 80),
    osFamily(data.os),
    languageFamily(data.language),
    cleanLower(data.timezone, 120),
    screen,
    viewport,
    roundedNumber(data.device_pixel_ratio || data.devicePixelRatio, 0.25),
    roundedNumber(data.color_depth || data.colorDepth),
    roundedNumber(data.hardware_concurrency || data.hardwareConcurrency),
    roundedNumber(data.device_memory || data.deviceMemory, 0.5),
    roundedNumber(data.max_touch_points || data.maxTouchPoints),
    platform,
    vendor
  ]

  const network = networkPrefix(ip)
  const browserParts = [
    cleanLower(data.browser, 80),
    cleanLower(data.browser_version || data.browserVersion, 40)?.split('.')[0] || null,
    cleanString(userAgent || data.user_agent || data.userAgent, 1000)
  ]

  const deviceSignature = hashParts(deviceParts)
  const networkSignature = hashParts([network])
  const browserSignature = hashParts(browserParts)
  const identityHash = deviceSignature && networkSignature
    ? hashParts([deviceSignature, networkSignature])
    : null

  return {
    identityHash,
    deviceSignature,
    networkSignature,
    browserSignature,
    sourceContext: sourceContextFromData(data),
    clickIds: extractClickIds(data),
    evidence: {
      deviceSignals: deviceParts.filter(Boolean).length,
      hasNetwork: Boolean(networkSignature),
      hasBrowser: Boolean(browserSignature),
      sourceKeys: Object.keys(sourceContextFromData(data)),
      clickIdKeys: extractClickIds(data).map(item => item.field)
    }
  }
}

function identityEvidenceJson(signals, extra = {}) {
  try {
    return JSON.stringify({
      ...signals?.evidence,
      ...extra
    }).slice(0, 8000)
  } catch {
    return '{}'
  }
}

async function getContactRow(contactId) {
  const id = cleanString(contactId, 180)
  if (!id) return null
  return db.get('SELECT id, full_name, email FROM contacts WHERE id = ? LIMIT 1', [id])
}

async function findContactByVisitorId(visitorId) {
  const cleanVisitorId = cleanString(visitorId, 180)
  if (!cleanVisitorId || !isTrustedTrackingVisitorId(cleanVisitorId)) return null

  const contact = await db.get(`
    SELECT id, full_name, email
    FROM contacts
    WHERE visitor_id = ?
    LIMIT 1
  `, [cleanVisitorId])
  if (contact?.id) return contact

  return db.get(`
    SELECT c.id, c.full_name, c.email
    FROM sessions s
    JOIN contacts c ON c.id = s.contact_id
    WHERE s.visitor_id = ?
      AND s.contact_id IS NOT NULL
      AND s.contact_id != ''
    ORDER BY s.started_at ASC
    LIMIT 1
  `, [cleanVisitorId])
}

async function findContactByClickId(clickId) {
  if (!clickId?.field || !clickId?.value) return null

  return db.get(`
    SELECT c.id, c.full_name, c.email, s.started_at
    FROM sessions s
    JOIN contacts c ON c.id = s.contact_id
    WHERE s.${clickId.field} = ?
      AND s.contact_id IS NOT NULL
      AND s.contact_id != ''
    ORDER BY s.started_at DESC
    LIMIT 1
  `, [clickId.value])
}

async function findContactByIdentityHash(signals, now = new Date()) {
  if (!signals?.identityHash) return null

  const cutoff = new Date(now.getTime() - IDENTITY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const rows = await db.all(`
    SELECT
      s.contact_id,
      s.visitor_id,
      s.started_at,
      s.gclid,
      s.wbraid,
      s.gbraid,
      s.msclkid,
      s.ttclid,
      s.fbclid,
      s.fbc,
      s.campaign_id,
      s.adset_id,
      s.ad_id,
      s.utm_source,
      s.utm_medium,
      s.utm_campaign,
      s.site_id,
      s.public_page_id,
      s.form_site_id,
      c.full_name,
      c.email
    FROM sessions s
    JOIN contacts c ON c.id = s.contact_id
    WHERE s.identity_hash = ?
      AND s.contact_id IS NOT NULL
      AND s.contact_id != ''
      AND s.started_at >= ?
    ORDER BY s.started_at DESC
    LIMIT 30
  `, [signals.identityHash, cutoff])

  const byContact = new Map()
  for (const row of rows) {
    if (!row.contact_id) continue
    const candidateSource = sourceContextFromData(row)
    const sourceMatches = countSourceMatches(signals.sourceContext, candidateSource)
    const strongSourceMatches = countStrongSourceMatches(signals.sourceContext, candidateSource)
    const strongSourceConflict = hasStrongSourceConflict(signals.sourceContext, candidateSource)
    const current = byContact.get(row.contact_id) || {
      id: row.contact_id,
      full_name: row.full_name,
      email: row.email,
      sourceMatches: 0,
      strongSourceMatches: 0,
      strongSourceConflict: false,
      rows: 0,
      lastSeenAt: row.started_at
    }
    current.sourceMatches = Math.max(current.sourceMatches, sourceMatches)
    current.strongSourceMatches = Math.max(current.strongSourceMatches, strongSourceMatches)
    current.strongSourceConflict = current.strongSourceConflict || strongSourceConflict
    current.rows += 1
    if (String(row.started_at || '') > String(current.lastSeenAt || '')) {
      current.lastSeenAt = row.started_at
    }
    byContact.set(row.contact_id, current)
  }

  const candidates = Array.from(byContact.values())
  if (candidates.length !== 1) {
    return candidates.length > 1
      ? { ambiguous: true, candidates: candidates.map(item => item.id) }
      : null
  }

  const [candidate] = candidates
  const strongSource = hasStrongSourceContext(signals.sourceContext)
  if (candidate.strongSourceConflict || candidate.strongSourceMatches < 1) {
    return {
      ...candidate,
      confidence: 82,
      method: 'probabilistic_device_network_candidate',
      evidence: {
        sourceMatches: candidate.sourceMatches,
        strongSourceMatches: candidate.strongSourceMatches,
        strongSourceConflict: candidate.strongSourceConflict,
        candidateRows: candidate.rows
      }
    }
  }
  const sourceBonus = candidate.sourceMatches >= 2 ? 8 : candidate.sourceMatches >= 1 ? 5 : 0
  const confidence = Math.min(91, 82 + sourceBonus + (strongSource ? 3 : 0))

  return {
    ...candidate,
    confidence,
    method: 'probabilistic_device_network',
    evidence: {
      sourceMatches: candidate.sourceMatches,
      strongSourceMatches: candidate.strongSourceMatches,
      candidateRows: candidate.rows
    }
  }
}

export async function resolveTrackingIdentity({ visitorId, contactId, data = {}, ip = null, userAgent = null, now = new Date() } = {}) {
  const signals = buildTrackingIdentitySignals({ data, ip, userAgent })
  const explicitContact = await getContactRow(contactId)
  if (explicitContact?.id) {
    return {
      contactId: explicitContact.id,
      fullName: explicitContact.full_name || null,
      email: explicitContact.email || null,
      matchMethod: 'direct_contact_id',
      matchConfidence: 100,
      accepted: true,
      signals,
      evidenceJson: identityEvidenceJson(signals, { directContact: true })
    }
  }

  const visitorContact = await findContactByVisitorId(visitorId)
  if (visitorContact?.id) {
    return {
      contactId: visitorContact.id,
      fullName: visitorContact.full_name || null,
      email: visitorContact.email || null,
      matchMethod: 'visitor_id',
      matchConfidence: 98,
      accepted: true,
      signals,
      evidenceJson: identityEvidenceJson(signals, { visitorId: true })
    }
  }

  for (const clickId of signals.clickIds) {
    const clickContact = await findContactByClickId(clickId)
    if (clickContact?.id) {
      const confidence = clickId.score
      return {
        contactId: clickContact.id,
        fullName: clickContact.full_name || null,
        email: clickContact.email || null,
        matchMethod: `exact_${clickId.field}`,
        matchConfidence: confidence,
        accepted: confidence >= AUTO_LINK_CONFIDENCE,
        signals,
        evidenceJson: identityEvidenceJson(signals, { clickId: clickId.field })
      }
    }
  }

  const identityContact = await findContactByIdentityHash(signals, now)
  if (identityContact?.id) {
    return {
      contactId: identityContact.id,
      fullName: identityContact.full_name || null,
      email: identityContact.email || null,
      matchMethod: identityContact.method,
      matchConfidence: identityContact.confidence,
      accepted: identityContact.confidence >= AUTO_LINK_CONFIDENCE,
      signals,
      evidenceJson: identityEvidenceJson(signals, identityContact.evidence)
    }
  }

  return {
    contactId: null,
    fullName: null,
    email: null,
    matchMethod: identityContact?.ambiguous ? 'ambiguous_identity_hash' : 'anonymous',
    matchConfidence: 0,
    accepted: false,
    signals,
    evidenceJson: identityEvidenceJson(signals, identityContact?.ambiguous ? { ambiguousCandidates: identityContact.candidates } : {})
  }
}

export async function recordTrackingIdentityMatch({
  subjectKind,
  subjectId = null,
  visitorId = null,
  sessionId = null,
  contactId = null,
  matchMethod = 'anonymous',
  matchConfidence = 0,
  accepted = false,
  signals = null,
  evidenceJson = null
} = {}) {
  if (!subjectKind || (!subjectId && !visitorId && !sessionId)) return
  if (Number(matchConfidence || 0) < CANDIDATE_CONFIDENCE && !contactId) return

  try {
    await db.run(`
      INSERT INTO tracking_identity_matches (
        id,
        subject_kind,
        subject_id,
        visitor_id,
        session_id,
        contact_id,
        identity_hash,
        device_signature,
        network_signature,
        match_method,
        match_confidence,
        accepted,
        evidence_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [
      crypto.randomUUID(),
      subjectKind,
      cleanString(subjectId, 220),
      cleanString(visitorId, 180),
      cleanString(sessionId, 180),
      cleanString(contactId, 180),
      signals?.identityHash || null,
      signals?.deviceSignature || null,
      signals?.networkSignature || null,
      cleanString(matchMethod, 120) || 'anonymous',
      Math.round(Number(matchConfidence || 0)),
      accepted ? 1 : 0,
      evidenceJson || identityEvidenceJson(signals)
    ])
  } catch (error) {
    logger.warn(`No se pudo guardar evidencia de identidad: ${error.message}`)
  }
}

function buildRelatedSourceWhere(data = {}, params = [], options = {}) {
  const allowedFields = options.allowedFields ? new Set(options.allowedFields) : null
  const conditions = []

  for (const [field] of CLICK_ID_FIELDS) {
    if (allowedFields && !allowedFields.has(field)) continue
    const value = cleanString(data[field], 500)
    if (!value) continue
    conditions.push(`${field} = ?`)
    params.push(value)
  }

  for (const field of ['ad_id', 'campaign_id', 'utm_campaign', 'site_id', 'public_page_id', 'form_site_id']) {
    if (allowedFields && !allowedFields.has(field)) continue
    const value = cleanString(data[field], 500)
    if (!value) continue
    conditions.push(`${field} = ?`)
    params.push(value)
  }

  return conditions.length ? `(${conditions.join(' OR ')})` : ''
}

export async function linkRelatedTrackingToContact({
  contactId,
  visitorId = null,
  fullName = null,
  email = null,
  signals = null,
  data = {}
} = {}) {
  const cleanContactId = cleanString(contactId, 180)
  if (!cleanContactId) return { sessionsUpdated: 0, videoSessionsUpdated: 0, videoEventsUpdated: 0 }

  const contact = await getContactRow(cleanContactId)
  const resolvedName = cleanString(fullName, 260) || contact?.full_name || null
  const resolvedEmail = cleanString(email, 260) || contact?.email || null
  let sessionsUpdated = 0
  let videoSessionsUpdated = 0
  let videoEventsUpdated = 0

  const cleanVisitorId = cleanString(visitorId, 180)
  if (isTrustedTrackingVisitorId(cleanVisitorId)) {
    const sessionsResult = await db.run(`
      UPDATE sessions
      SET
        contact_id = ?,
        full_name = COALESCE(full_name, ?),
        email = COALESCE(email, ?),
        match_method = CASE WHEN COALESCE(match_method, '') IN ('', 'anonymous') THEN 'visitor_id_linked' ELSE match_method END,
        match_confidence = CASE WHEN COALESCE(match_confidence, 0) < 98 THEN 98 ELSE match_confidence END
      WHERE visitor_id = ?
        AND (contact_id IS NULL OR contact_id = '')
    `, [cleanContactId, resolvedName, resolvedEmail, cleanVisitorId])
    sessionsUpdated += sessionsResult.changes || 0

    const videoSessionsResult = await db.run(`
      UPDATE video_playback_sessions
      SET
        contact_id = ?,
        full_name = COALESCE(full_name, ?),
        email = COALESCE(email, ?),
        match_method = CASE WHEN COALESCE(match_method, '') IN ('', 'anonymous') THEN 'visitor_id_linked' ELSE match_method END,
        match_confidence = CASE WHEN COALESCE(match_confidence, 0) < 98 THEN 98 ELSE match_confidence END,
        updated_at = CURRENT_TIMESTAMP
      WHERE visitor_id = ?
        AND (contact_id IS NULL OR contact_id = '')
    `, [cleanContactId, resolvedName, resolvedEmail, cleanVisitorId])
    videoSessionsUpdated += videoSessionsResult.changes || 0

    const videoEventsResult = await db.run(`
      UPDATE video_playback_events
      SET contact_id = ?
      WHERE visitor_id = ?
        AND (contact_id IS NULL OR contact_id = '')
    `, [cleanContactId, cleanVisitorId])
    videoEventsUpdated += videoEventsResult.changes || 0
  }

  const relatedParams = []
  const relatedWhere = buildRelatedSourceWhere(data, relatedParams)
  if (signals?.identityHash && relatedWhere) {
    const cutoff = new Date(Date.now() - IDENTITY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const sessionsResult = await db.run(`
      UPDATE sessions
      SET
        contact_id = ?,
        full_name = COALESCE(full_name, ?),
        email = COALESCE(email, ?),
        match_method = CASE WHEN COALESCE(match_method, '') IN ('', 'anonymous') THEN 'related_identity_source' ELSE match_method END,
        match_confidence = CASE WHEN COALESCE(match_confidence, 0) < 90 THEN 90 ELSE match_confidence END
      WHERE identity_hash = ?
        AND started_at >= ?
        AND (contact_id IS NULL OR contact_id = '')
        AND ${relatedWhere}
    `, [cleanContactId, resolvedName, resolvedEmail, signals.identityHash, cutoff, ...relatedParams])
    sessionsUpdated += sessionsResult.changes || 0

    const videoParams = []
    const videoWhere = buildRelatedSourceWhere(data, videoParams, {
      allowedFields: ['site_id', 'public_page_id', 'form_site_id']
    })
    if (videoWhere) {
      const videoSessionsResult = await db.run(`
        UPDATE video_playback_sessions
        SET
          contact_id = ?,
          full_name = COALESCE(full_name, ?),
          email = COALESCE(email, ?),
          match_method = CASE WHEN COALESCE(match_method, '') IN ('', 'anonymous') THEN 'related_identity_source' ELSE match_method END,
          match_confidence = CASE WHEN COALESCE(match_confidence, 0) < 90 THEN 90 ELSE match_confidence END,
          updated_at = CURRENT_TIMESTAMP
        WHERE identity_hash = ?
          AND started_at >= ?
          AND (contact_id IS NULL OR contact_id = '')
          AND ${videoWhere}
      `, [cleanContactId, resolvedName, resolvedEmail, signals.identityHash, cutoff, ...videoParams])
      videoSessionsUpdated += videoSessionsResult.changes || 0
    }
  }

  return { sessionsUpdated, videoSessionsUpdated, videoEventsUpdated }
}
