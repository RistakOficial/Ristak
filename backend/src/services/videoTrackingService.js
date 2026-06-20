import crypto from 'crypto'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { resolveDateRangeWithGHLTimezone } from '../utils/dateUtils.js'
import {
  buildTrackingIdentitySignals,
  recordTrackingIdentityMatch,
  resolveTrackingIdentity
} from './trackingIdentityService.js'

const isPostgresRuntime = Boolean(process.env.DATABASE_URL)
const MAX_PLAYBACK_CHART_POINTS = 400

const VIDEO_EVENTS = new Set([
  'video_ready',
  'video_play',
  'video_pause',
  'video_timeupdate',
  'video_progress',
  'video_seeked',
  'video_ended',
  'video_error'
])

function cleanString(value, maxLength = 500) {
  const cleaned = String(value || '').trim()
  return cleaned ? cleaned.slice(0, maxLength) : null
}

function visitorIdentityExpression(alias = '') {
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

function anonymousVisitorIdentityExpression(alias = '') {
  const prefix = alias ? `${alias}.` : ''
  return `
    CASE
      WHEN ${prefix}contact_id IS NULL OR ${prefix}contact_id = '' THEN ${visitorIdentityExpression(alias)}
      ELSE NULL
    END
  `
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clampNumber(value, min, max) {
  const number = numberOrNull(value)
  if (number === null) return null
  return Math.min(max, Math.max(min, number))
}

function boolValue(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

function parseEventDate(value) {
  const rawNumber = Number(value)
  const date = Number.isFinite(rawNumber)
    ? new Date(rawNumber)
    : new Date(String(value || ''))
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString()
}

function normalizeVideoEventName(value) {
  const raw = cleanString(value, 80)
  if (!raw) return ''
  const normalized = raw.toLowerCase().replace(/[^a-z0-9_]+/g, '_')
  const withPrefix = normalized.startsWith('video_') ? normalized : `video_${normalized}`
  return VIDEO_EVENTS.has(withPrefix) ? withPrefix : ''
}

function parseJsonPayload(value) {
  try {
    const raw = JSON.stringify(value || {})
    return raw.length > 8000 ? raw.slice(0, 8000) : raw
  } catch {
    return '{}'
  }
}

function readVideoData(body = {}) {
  const data = body.data && typeof body.data === 'object' ? body.data : {}
  const eventName = normalizeVideoEventName(body.event_name || data.event_name || data.video_event_name)
  const duration = clampNumber(data.duration_seconds ?? data.duration ?? data.video_duration, 0, 24 * 60 * 60) || 0
  const position = clampNumber(data.position_seconds ?? data.seconds ?? data.current_time ?? data.currentTime, 0, 24 * 60 * 60) || 0
  const computedPercent = duration > 0 ? (position / duration) * 100 : 0
  const progressPercent = clampNumber(data.progress_percent ?? data.percent_watched ?? data.percent ?? computedPercent, 0, 100) || 0

  return {
    eventName,
    eventId: cleanString(data.event_id || data.eventId, 220),
    playbackId: cleanString(data.playback_id || data.playbackId, 160),
    mediaAssetId: cleanString(data.media_asset_id || data.mediaAssetId, 160),
    streamLibraryId: cleanString(data.stream_library_id || data.streamLibraryId || data.library_id || data.libraryId, 160),
    streamVideoId: cleanString(data.stream_video_id || data.streamVideoId || data.video_id || data.videoId, 160),
    videoProvider: cleanString(data.video_provider || data.videoProvider || (data.stream_video_id || data.streamVideoId ? 'bunny_stream' : 'html5_video'), 80) || 'bunny_stream',
    videoTitle: cleanString(data.video_title || data.videoTitle || data.title, 260),
    trackingSource: cleanString(data.tracking_source || data.trackingSource || 'native_site_video', 80) || 'native_site_video',
    siteId: cleanString(data.site_id || data.siteId, 120),
    siteSlug: cleanString(data.site_slug || data.siteSlug, 220),
    siteName: cleanString(data.site_name || data.siteName, 260),
    siteType: cleanString(data.site_type || data.siteType, 80),
    formSiteId: cleanString(data.form_site_id || data.formSiteId, 160),
    formSiteName: cleanString(data.form_site_name || data.formSiteName, 260),
    publicPageId: cleanString(data.public_page_id || data.publicPageId || data.page_id || data.pageId, 160),
    publicPageTitle: cleanString(data.public_page_title || data.publicPageTitle || data.page_title || data.pageTitle, 260),
    blockId: cleanString(data.block_id || data.blockId, 160),
    blockLabel: cleanString(data.block_label || data.blockLabel, 260),
    pageUrl: cleanString(data.url || data.page_url || data.pageUrl, 2000),
    referrerUrl: cleanString(data.referrer || data.referrer_url || data.referrerUrl, 2000),
    deviceType: cleanString(data.device_type || data.deviceType, 80),
    os: cleanString(data.os, 120),
    browser: cleanString(data.browser, 120),
    browserVersion: cleanString(data.browser_version || data.browserVersion, 80),
    language: cleanString(data.language, 80),
    timezone: cleanString(data.timezone, 120),
    screenWidth: numberOrNull(data.screen_width || data.screenWidth),
    screenHeight: numberOrNull(data.screen_height || data.screenHeight),
    viewportWidth: numberOrNull(data.viewport_width || data.viewportWidth),
    viewportHeight: numberOrNull(data.viewport_height || data.viewportHeight),
    colorDepth: numberOrNull(data.color_depth || data.colorDepth),
    devicePixelRatio: numberOrNull(data.device_pixel_ratio || data.devicePixelRatio),
    hardwareConcurrency: numberOrNull(data.hardware_concurrency || data.hardwareConcurrency),
    deviceMemory: numberOrNull(data.device_memory || data.deviceMemory),
    maxTouchPoints: numberOrNull(data.max_touch_points || data.maxTouchPoints),
    platform: cleanString(data.platform, 120),
    vendor: cleanString(data.vendor, 120),
    position,
    duration,
    progressPercent,
    watchedDelta: clampNumber(data.watched_delta_seconds ?? data.watchedDeltaSeconds, 0, 30) || 0,
    payloadJson: parseJsonPayload(data)
  }
}

function videoIdentityData(video = {}) {
  return {
    tracking_source: video.trackingSource,
    site_id: video.siteId,
    site_slug: video.siteSlug,
    site_name: video.siteName,
    site_type: video.siteType,
    form_site_id: video.formSiteId,
    form_site_name: video.formSiteName,
    public_page_id: video.publicPageId,
    public_page_title: video.publicPageTitle,
    url: video.pageUrl,
    referrer: video.referrerUrl,
    device_type: video.deviceType,
    os: video.os,
    browser: video.browser,
    browser_version: video.browserVersion,
    language: video.language,
    timezone: video.timezone,
    screen_width: video.screenWidth,
    screen_height: video.screenHeight,
    viewport_width: video.viewportWidth,
    viewport_height: video.viewportHeight,
    color_depth: video.colorDepth,
    device_pixel_ratio: video.devicePixelRatio,
    hardware_concurrency: video.hardwareConcurrency,
    device_memory: video.deviceMemory,
    max_touch_points: video.maxTouchPoints,
    platform: video.platform,
    vendor: video.vendor
  }
}

async function resolveContactForPlayback(tx, contactId, visitorId, video, requestInfo, eventAt) {
  const directContactId = cleanString(contactId, 160)
  if (directContactId) {
    const contact = await tx.get('SELECT id, full_name, email FROM contacts WHERE id = ?', [directContactId])
    if (contact) {
      return {
        id: contact.id,
        fullName: contact.full_name || null,
        email: contact.email || null,
        matchMethod: 'direct_contact_id',
        matchConfidence: 100
      }
    }
  }

  const cleanVisitorId = cleanString(visitorId, 160)
  if (cleanVisitorId) {
    const contact = await tx.get(`
      SELECT id, full_name, email
      FROM contacts
      WHERE visitor_id = ?
      ORDER BY created_at ASC
      LIMIT 1
    `, [cleanVisitorId])

    if (contact) {
      return {
        id: contact.id,
        fullName: contact.full_name || null,
        email: contact.email || null,
        matchMethod: 'visitor_id_contact',
        matchConfidence: 98
      }
    }
  }

  const identity = await resolveTrackingIdentity({
    visitorId,
    contactId: null,
    data: videoIdentityData(video),
    ip: requestInfo.ip,
    userAgent: requestInfo.userAgent,
    now: new Date(eventAt)
  })

  if (identity.accepted && identity.contactId) {
    return {
      id: identity.contactId,
      fullName: identity.fullName,
      email: identity.email,
      matchMethod: identity.matchMethod,
      matchConfidence: identity.matchConfidence,
      identity
    }
  }

  return {
    id: null,
    fullName: null,
    email: null,
    matchMethod: identity.matchMethod || 'anonymous',
    matchConfidence: identity.matchConfidence || 0,
    identity
  }
}

function computeWatchedDelta(existing, video) {
  if (video.watchedDelta > 0) return video.watchedDelta
  if (!existing) return 0
  const previous = numberOrNull(existing.last_position_seconds) || 0
  const delta = video.position - previous
  if (delta <= 0 || delta > 10) return 0
  return delta
}

function isCompletionEvent(eventName, progressPercent) {
  return eventName === 'video_ended' || progressPercent >= 99
}

async function insertPlaybackEvent(tx, body, video, contact, eventAt) {
  try {
    await tx.run(`
      INSERT INTO video_playback_events (
        id,
        event_id,
        playback_id,
        visitor_id,
        session_id,
        contact_id,
        event_name,
        media_asset_id,
        stream_library_id,
        stream_video_id,
        video_provider,
        site_id,
        public_page_id,
        block_id,
        page_url,
        position_seconds,
        duration_seconds,
        progress_percent,
        watched_delta_seconds,
        payload_json,
        event_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `, [
      crypto.randomUUID(),
      video.eventId,
      video.playbackId,
      body.visitorId,
      body.sessionId,
      contact.id,
      video.eventName,
      video.mediaAssetId,
      video.streamLibraryId,
      video.streamVideoId,
      video.videoProvider,
      video.siteId,
      video.publicPageId,
      video.blockId,
      video.pageUrl,
      video.position,
      video.duration,
      video.progressPercent,
      video.watchedDelta,
      video.payloadJson,
      eventAt
    ])
  } catch (error) {
    if (!String(error.message || '').toLowerCase().includes('unique')) {
      throw error
    }
  }
}

async function upsertPlaybackSession(tx, body, video, contact, requestInfo, eventAt) {
  const existing = await tx.get(
    'SELECT * FROM video_playback_sessions WHERE playback_id = ?',
    [video.playbackId]
  )
  const watchedDelta = computeWatchedDelta(existing, video)
  const previousWatched = existing ? (numberOrNull(existing.watched_seconds) || 0) : 0
  const watchedSeconds = previousWatched + watchedDelta
  const maxPosition = Math.max(numberOrNull(existing?.max_position_seconds) || 0, video.position)
  const duration = video.duration || numberOrNull(existing?.duration_seconds) || 0
  const progressPercent = duration > 0
    ? Math.min(100, Math.max(numberOrNull(existing?.max_progress_percent) || 0, (maxPosition / duration) * 100, video.progressPercent))
    : Math.max(numberOrNull(existing?.max_progress_percent) || 0, video.progressPercent)
  const ended = existing?.ended || isCompletionEvent(video.eventName, progressPercent) ? 1 : 0
  const endedAt = ended && !existing?.ended_at ? eventAt : existing?.ended_at || null
  const playCount = (numberOrNull(existing?.play_count) || 0) + (video.eventName === 'video_play' ? 1 : 0)
  const pauseCount = (numberOrNull(existing?.pause_count) || 0) + (video.eventName === 'video_pause' ? 1 : 0)
  const seekCount = (numberOrNull(existing?.seek_count) || 0) + (video.eventName === 'video_seeked' ? 1 : 0)
  const contactId = contact.id || existing?.contact_id || null
  const fullName = contact.fullName || existing?.full_name || null
  const email = contact.email || existing?.email || null
  const matchMethod = contact.id ? contact.matchMethod : (existing?.match_method || 'anonymous')
  const matchConfidence = contact.id
    ? Number(contact.matchConfidence || 100)
    : Number(existing?.match_confidence || contact.matchConfidence || 0)
  const identity = contact.identity || {
    signals: buildTrackingIdentitySignals({
      data: videoIdentityData(video),
      ip: requestInfo.ip,
      userAgent: requestInfo.userAgent
    }),
    evidenceJson: null
  }
  const identityEvidenceJson = contact.identity?.evidenceJson || existing?.identity_evidence_json || null

  if (!existing) {
    await tx.run(`
      INSERT INTO video_playback_sessions (
        id,
        playback_id,
        visitor_id,
        session_id,
        contact_id,
        full_name,
        email,
        media_asset_id,
        stream_library_id,
        stream_video_id,
        video_provider,
        video_title,
        tracking_source,
        site_id,
        site_slug,
        site_name,
        site_type,
        form_site_id,
        form_site_name,
        public_page_id,
        public_page_title,
        block_id,
        block_label,
        page_url,
        referrer_url,
        ip,
        user_agent,
        device_type,
        os,
        browser,
        browser_version,
        language,
        timezone,
        duration_seconds,
        max_position_seconds,
        last_position_seconds,
        watched_seconds,
        max_progress_percent,
        play_count,
        pause_count,
        seek_count,
        ended,
        match_method,
        match_confidence,
        identity_hash,
        device_signature,
        network_signature,
        identity_evidence_json,
        first_event_at,
        started_at,
        last_event_at,
        ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      crypto.randomUUID(),
      video.playbackId,
      body.visitorId,
      body.sessionId,
      contactId,
      fullName,
      email,
      video.mediaAssetId,
      video.streamLibraryId,
      video.streamVideoId,
      video.videoProvider,
      video.videoTitle,
      video.trackingSource,
      video.siteId,
      video.siteSlug,
      video.siteName,
      video.siteType,
      video.formSiteId,
      video.formSiteName,
      video.publicPageId,
      video.publicPageTitle,
      video.blockId,
      video.blockLabel,
      video.pageUrl,
      video.referrerUrl,
      requestInfo.ip,
      requestInfo.userAgent,
      video.deviceType,
      video.os,
      video.browser,
      video.browserVersion,
      video.language,
      video.timezone,
      duration,
      maxPosition,
      video.position,
      watchedSeconds,
      progressPercent,
      playCount,
      pauseCount,
      seekCount,
      ended,
      matchMethod,
      matchConfidence,
      identity.signals.identityHash,
      identity.signals.deviceSignature,
      identity.signals.networkSignature,
      identityEvidenceJson,
      eventAt,
      eventAt,
      eventAt,
      endedAt
    ])
  } else {
    await tx.run(`
      UPDATE video_playback_sessions
      SET
        contact_id = ?,
        full_name = ?,
        email = ?,
        media_asset_id = COALESCE(?, media_asset_id),
        stream_library_id = COALESCE(?, stream_library_id),
        stream_video_id = COALESCE(?, stream_video_id),
        video_provider = COALESCE(?, video_provider),
        video_title = COALESCE(?, video_title),
        tracking_source = COALESCE(?, tracking_source),
        site_id = COALESCE(?, site_id),
        site_slug = COALESCE(?, site_slug),
        site_name = COALESCE(?, site_name),
        site_type = COALESCE(?, site_type),
        form_site_id = COALESCE(?, form_site_id),
        form_site_name = COALESCE(?, form_site_name),
        public_page_id = COALESCE(?, public_page_id),
        public_page_title = COALESCE(?, public_page_title),
        block_id = COALESCE(?, block_id),
        block_label = COALESCE(?, block_label),
        page_url = COALESCE(?, page_url),
        referrer_url = COALESCE(?, referrer_url),
        ip = COALESCE(?, ip),
        user_agent = COALESCE(?, user_agent),
        device_type = COALESCE(?, device_type),
        os = COALESCE(?, os),
        browser = COALESCE(?, browser),
        browser_version = COALESCE(?, browser_version),
        language = COALESCE(?, language),
        timezone = COALESCE(?, timezone),
        duration_seconds = ?,
        max_position_seconds = ?,
        last_position_seconds = ?,
        watched_seconds = ?,
        max_progress_percent = ?,
        play_count = ?,
        pause_count = ?,
        seek_count = ?,
        ended = ?,
        match_method = ?,
        match_confidence = ?,
        identity_hash = COALESCE(?, identity_hash),
        device_signature = COALESCE(?, device_signature),
        network_signature = COALESCE(?, network_signature),
        identity_evidence_json = COALESCE(?, identity_evidence_json),
        last_event_at = ?,
        ended_at = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE playback_id = ?
    `, [
      contactId,
      fullName,
      email,
      video.mediaAssetId,
      video.streamLibraryId,
      video.streamVideoId,
      video.videoProvider,
      video.videoTitle,
      video.trackingSource,
      video.siteId,
      video.siteSlug,
      video.siteName,
      video.siteType,
      video.formSiteId,
      video.formSiteName,
      video.publicPageId,
      video.publicPageTitle,
      video.blockId,
      video.blockLabel,
      video.pageUrl,
      video.referrerUrl,
      requestInfo.ip,
      requestInfo.userAgent,
      video.deviceType,
      video.os,
      video.browser,
      video.browserVersion,
      video.language,
      video.timezone,
      duration,
      maxPosition,
      video.position,
      watchedSeconds,
      progressPercent,
      playCount,
      pauseCount,
      seekCount,
      ended,
      matchMethod,
      matchConfidence,
      identity.signals.identityHash,
      identity.signals.deviceSignature,
      identity.signals.networkSignature,
      identityEvidenceJson,
      eventAt,
      endedAt,
      video.playbackId
    ])
  }

  return {
    playbackId: video.playbackId,
    contactId,
    visitorId: body.visitorId,
    streamVideoId: video.streamVideoId,
    progressPercent,
    watchedSeconds,
    ended: Boolean(ended),
    matchMethod,
    matchConfidence
  }
}

export async function recordVideoPlaybackEvent(input = {}) {
  const body = {
    visitorId: cleanString(input.visitor_id || input.visitorId, 160),
    sessionId: cleanString(input.session_id || input.sessionId, 160),
    contactId: cleanString(input.contact_id || input.contactId, 160)
  }
  const video = readVideoData(input)
  const eventAt = parseEventDate(input.ts || input.timestamp || Date.now())

  if (!body.visitorId || !body.sessionId || !video.eventName || !video.playbackId) {
    const error = new Error('Missing required video tracking fields')
    error.status = 400
    throw error
  }

  const requestInfo = {
    ip: cleanString(input.ip, 80),
    userAgent: cleanString(input.user_agent || input.userAgent, 1000)
  }

  return db.transaction(async (tx) => {
    const contact = await resolveContactForPlayback(tx, body.contactId, body.visitorId, video, requestInfo, eventAt)
    const summary = await upsertPlaybackSession(tx, body, video, contact, requestInfo, eventAt)
    await insertPlaybackEvent(tx, body, video, contact, eventAt)
    await recordTrackingIdentityMatch({
      subjectKind: 'video_playback',
      subjectId: video.playbackId,
      visitorId: body.visitorId,
      sessionId: body.sessionId,
      contactId: summary.contactId,
      matchMethod: summary.matchMethod,
      matchConfidence: summary.matchConfidence,
      accepted: Boolean(summary.contactId && summary.matchConfidence >= 90),
      signals: contact.identity?.signals || buildTrackingIdentitySignals({
        data: videoIdentityData(video),
        ip: requestInfo.ip,
        userAgent: requestInfo.userAgent
      }),
      evidenceJson: contact.identity?.evidenceJson || null
    })
    return summary
  })
}

export async function linkVideoVisitorToContact(visitorId, contactId, fullName = '') {
  const cleanVisitorId = cleanString(visitorId, 160)
  const cleanContactId = cleanString(contactId, 160)
  if (!cleanVisitorId || !cleanContactId) return { sessionsUpdated: 0, eventsUpdated: 0 }

  const contact = await db.get('SELECT full_name, email FROM contacts WHERE id = ?', [cleanContactId])
  const resolvedName = cleanString(fullName, 260) || contact?.full_name || null
  const email = contact?.email || null

  const sessionsResult = await db.run(`
    UPDATE video_playback_sessions
    SET
      contact_id = ?,
      full_name = COALESCE(full_name, ?),
      email = COALESCE(email, ?),
      match_method = CASE WHEN match_method = 'anonymous' THEN 'visitor_linked_later' ELSE match_method END,
      match_confidence = CASE WHEN COALESCE(match_confidence, 0) < 98 THEN 98 ELSE match_confidence END,
      updated_at = CURRENT_TIMESTAMP
    WHERE visitor_id = ?
      AND (contact_id IS NULL OR contact_id = '')
  `, [cleanContactId, resolvedName, email, cleanVisitorId])

  const eventsResult = await db.run(`
    UPDATE video_playback_events
    SET contact_id = ?
    WHERE visitor_id = ?
      AND (contact_id IS NULL OR contact_id = '')
  `, [cleanContactId, cleanVisitorId])

  return {
    sessionsUpdated: sessionsResult.changes || 0,
    eventsUpdated: eventsResult.changes || 0
  }
}

export async function unifyVideoPlaybackVisitorIds(contactId, canonicalVisitorId) {
  const cleanContactId = cleanString(contactId, 160)
  const cleanVisitorId = cleanString(canonicalVisitorId, 160)
  if (!cleanContactId || !cleanVisitorId) return { sessionsUpdated: 0, eventsUpdated: 0 }

  const sessionsResult = await db.run(`
    UPDATE video_playback_sessions
    SET visitor_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE contact_id = ?
      AND visitor_id != ?
  `, [cleanVisitorId, cleanContactId, cleanVisitorId])

  const eventsResult = await db.run(`
    UPDATE video_playback_events
    SET visitor_id = ?
    WHERE contact_id = ?
      AND visitor_id != ?
  `, [cleanVisitorId, cleanContactId, cleanVisitorId])

  return {
    sessionsUpdated: sessionsResult.changes || 0,
    eventsUpdated: eventsResult.changes || 0
  }
}

function buildPlaybackWhere(filters = {}, params = []) {
  const conditions = []

  if (filters.assetId) {
    conditions.push('vps.media_asset_id = ?')
    params.push(filters.assetId)
  }

  if (filters.streamVideoId) {
    conditions.push('vps.stream_video_id = ?')
    params.push(filters.streamVideoId)
  }

  if (filters.siteId) {
    conditions.push('vps.site_id = ?')
    params.push(filters.siteId)
  }

  if (filters.dateFrom && filters.dateTo) {
    conditions.push('vps.last_event_at >= ? AND vps.last_event_at <= ?')
    params.push(filters.dateFrom, filters.dateTo)
  }

  return conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
}

async function resolvePlaybackDateFilters(input = {}) {
  if (!input.dateFrom && !input.dateTo) return {}
  const range = await resolveDateRangeWithGHLTimezone({
    startDate: input.dateFrom || input.dateTo,
    endDate: input.dateTo || input.dateFrom
  })
  return {
    dateFrom: range.startUtc,
    dateTo: range.endUtc,
    appliedTimezone: range.appliedTimezone
  }
}

function mergeViewer(acc, row) {
  acc.playbackCount += 1
  acc.playCount += Number(row.play_count || 0)
  acc.watchedSeconds += Number(row.watched_seconds || 0)
  acc.maxProgressPercent = Math.max(acc.maxProgressPercent, Number(row.max_progress_percent || 0))
  acc.maxPositionSeconds = Math.max(acc.maxPositionSeconds, Number(row.max_position_seconds || 0))
  acc.durationSeconds = Math.max(acc.durationSeconds, Number(row.duration_seconds || 0))
  acc.completed = acc.completed || Boolean(row.ended) || Number(row.max_progress_percent || 0) >= 99
  acc.lastEventAt = !acc.lastEventAt || String(row.last_event_at || '') > String(acc.lastEventAt)
    ? row.last_event_at
    : acc.lastEventAt
  acc.firstEventAt = !acc.firstEventAt || String(row.first_event_at || '') < String(acc.firstEventAt)
    ? row.first_event_at
    : acc.firstEventAt
  if (!acc.pageUrl && row.page_url) acc.pageUrl = row.page_url
  if (!acc.publicPageTitle && row.public_page_title) acc.publicPageTitle = row.public_page_title
  if (!acc.blockLabel && row.block_label) acc.blockLabel = row.block_label
}

function isPlayedPlayback(row = {}) {
  return (
    Number(row.play_count || 0) > 0 ||
    Number(row.watched_seconds || 0) > 0 ||
    Number(row.max_progress_percent || 0) > 0 ||
    Number(row.ended || 0) === 1
  )
}

function clampPercent(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(100, Math.max(0, number))
}

function roundMetric(value, decimals = 1) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  const factor = 10 ** decimals
  return Math.round(number * factor) / factor
}

function buildPlaybackPeriodExpression(hourly = false, timezone = 'UTC') {
  if (!isPostgresRuntime) {
    const format = hourly ? '%Y-%m-%dT%H:00:00' : '%Y-%m-%d'
    return `strftime('${format}', datetime(vps.last_event_at, '-6 hours'))`
  }

  const safeTimezone = String(timezone || 'UTC').replace(/'/g, "''")
  const format = hourly ? 'YYYY-MM-DD"T"HH24:00:00' : 'YYYY-MM-DD'
  return `TO_CHAR((vps.last_event_at)::timestamptz AT TIME ZONE '${safeTimezone}', '${format}')`
}

function normalizePlaybackPeriodKey(value, hourly = false) {
  const raw = cleanString(value, 40)
  if (!raw) return ''

  if (!hourly) {
    const match = raw.match(/^\d{4}-\d{2}-\d{2}/)
    return match ? match[0] : ''
  }

  const match = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2})/)
  if (match) return `${match[1]}T${match[2]}:00:00`

  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 13) + ':00:00'
}

function addPlaybackPeriod(date, hourly = false, amount = 1) {
  if (hourly) {
    date.setUTCHours(date.getUTCHours() + amount, 0, 0, 0)
  } else {
    date.setUTCDate(date.getUTCDate() + amount)
    date.setUTCHours(0, 0, 0, 0)
  }
}

function playbackPeriodKeyFromDate(date, hourly = false) {
  return hourly
    ? date.toISOString().slice(0, 13) + ':00:00'
    : date.toISOString().slice(0, 10)
}

function buildPlaybackPeriodKeys(input = {}, hourly = false) {
  const rawStart = normalizePlaybackPeriodKey(input.rawDateFrom || input.dateFrom, hourly)
  const rawEnd = normalizePlaybackPeriodKey(input.rawDateTo || input.dateTo, hourly)
  if (!rawStart || !rawEnd) return []

  const start = new Date(hourly ? rawStart : `${rawStart}T00:00:00Z`)
  const end = new Date(hourly ? rawEnd : `${rawEnd}T00:00:00Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return []

  if (!hourly) {
    start.setUTCHours(0, 0, 0, 0)
    end.setUTCHours(0, 0, 0, 0)
  }

  const keys = []
  const cursor = new Date(start)
  while (cursor <= end && keys.length < MAX_PLAYBACK_CHART_POINTS) {
    keys.push(playbackPeriodKeyFromDate(cursor, hourly))
    addPlaybackPeriod(cursor, hourly)
  }
  return keys
}

function buildEmptyPlaybackChartBucket(periodKey) {
  return {
    label: periodKey,
    periodKey,
    periodStart: periodKey,
    periodEnd: periodKey,
    views: 0,
    watchTime: 0
  }
}

function buildPlaybackPeriodCharts(rows = [], options = {}) {
  const hourly = boolValue(options.hourly)
  const buckets = new Map()

  for (const periodKey of buildPlaybackPeriodKeys(options, hourly)) {
    buckets.set(periodKey, buildEmptyPlaybackChartBucket(periodKey))
  }

  for (const row of rows) {
    const periodKey = normalizePlaybackPeriodKey(row.period_key, hourly)
    if (!periodKey) continue
    if (!buckets.has(periodKey)) {
      buckets.set(periodKey, buildEmptyPlaybackChartBucket(periodKey))
    }
    const bucket = buckets.get(periodKey)
    bucket.views += Number(row.plays || 0)
    bucket.watchTime += Number(row.watched_seconds || 0)
  }

  const sorted = [...buckets.values()].sort((a, b) => a.periodKey.localeCompare(b.periodKey))

  return {
    viewsChart: sorted.map(point => ({
      label: point.label,
      value: point.views,
      periodKey: point.periodKey,
      periodStart: point.periodStart,
      periodEnd: point.periodEnd
    })),
    watchTimeChart: sorted.map(point => ({
      label: point.label,
      value: point.watchTime,
      periodKey: point.periodKey,
      periodStart: point.periodStart,
      periodEnd: point.periodEnd
    }))
  }
}

function buildRetentionSegments(rows = [], segmentCount = 24) {
  const playedRows = rows.filter(isPlayedPlayback)
  const denominator = playedRows.length || rows.length
  const durationSeconds = Math.max(
    0,
    ...rows.map(row => Number(row.duration_seconds || 0)),
    ...rows.map(row => Number(row.max_position_seconds || 0))
  )

  if (!denominator || segmentCount <= 0) return []

  return Array.from({ length: segmentCount }, (_, index) => {
    const startPercent = (index / segmentCount) * 100
    const endPercent = ((index + 1) / segmentCount) * 100
    const retainedSessions = playedRows.filter(row => (
      Number(row.ended || 0) === 1 ||
      clampPercent(row.max_progress_percent) >= startPercent ||
      (index === 0 && isPlayedPlayback(row))
    )).length
    const replayedSessions = playedRows.filter(row => (
      Number(row.play_count || 0) > 1 &&
      (Number(row.ended || 0) === 1 || clampPercent(row.max_progress_percent) >= startPercent)
    )).length
    const retentionPercent = denominator > 0 ? (retainedSessions / denominator) * 100 : 0
    const replayRatePercent = denominator > 0 ? (replayedSessions / denominator) * 100 : 0
    const startSeconds = durationSeconds > 0 ? (durationSeconds * startPercent) / 100 : 0
    const endSeconds = durationSeconds > 0 ? (durationSeconds * endPercent) / 100 : 0

    return {
      segment: index,
      startPercent: roundMetric(startPercent),
      endPercent: roundMetric(endPercent),
      startSeconds: roundMetric(startSeconds),
      endSeconds: roundMetric(endSeconds),
      label: `${Math.round(startPercent)}-${Math.round(endPercent)}%`,
      retainedSessions,
      skippedSessions: Math.max(0, denominator - retainedSessions),
      replayedSessions,
      retentionPercent: roundMetric(retentionPercent),
      replayRatePercent: roundMetric(replayRatePercent),
      intensity: roundMetric(retentionPercent)
    }
  })
}

function buildPlaybackBreakdown(rows = [], getKey, mapLabel) {
  const grouped = new Map()

  rows.forEach(row => {
    const key = getKey(row)
    if (!key) return
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        label: mapLabel(row) || key,
        playbackSessions: 0,
        plays: 0,
        watchedSeconds: 0,
        maxProgressTotal: 0
      })
    }
    const item = grouped.get(key)
    item.playbackSessions += 1
    item.plays += Number(row.play_count || 0)
    item.watchedSeconds += Number(row.watched_seconds || 0)
    item.maxProgressTotal += Number(row.max_progress_percent || 0)
  })

  return [...grouped.values()]
    .map(item => ({
      ...item,
      avgProgressPercent: item.playbackSessions > 0
        ? roundMetric(item.maxProgressTotal / item.playbackSessions)
        : 0
    }))
    .sort((a, b) => b.plays - a.plays || b.playbackSessions - a.playbackSessions || b.watchedSeconds - a.watchedSeconds)
    .slice(0, 8)
}

function normalizePlaybackIdList(values = [], maxItems = 1000) {
  if (!Array.isArray(values)) return []
  const seen = new Set()
  const ids = []

  for (const value of values) {
    const id = cleanString(value, 160)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= maxItems) break
  }

  return ids
}

function emptyPlaybackSummary(extra = {}) {
  return {
    ...extra,
    playbackSessions: 0,
    playedSessions: 0,
    identifiedContacts: 0,
    anonymousVisitors: 0,
    totalViewers: 0,
    plays: 0,
    watchedSeconds: 0,
    avgProgressPercent: 0,
    averageWatchSeconds: 0,
    playRatePercent: 0,
    completions: 0,
    completionRatePercent: 0,
    dropOffPercent: 0
  }
}

function playbackSummaryFromRow(row = {}, extra = {}) {
  const playbackSessions = Number(row.playback_sessions || 0)
  const playedSessions = Number(row.played_sessions || 0)
  const identifiedContacts = Number(row.identified_contacts || 0)
  const anonymousVisitors = Number(row.anonymous_visitors || 0)
  const plays = Number(row.plays || 0)
  const watchedSeconds = Number(row.watched_seconds || 0)
  const avgProgressPercent = Number(row.avg_progress_percent || 0)
  const completions = Number(row.completions || 0)
  const completionBase = playedSessions || playbackSessions

  return {
    ...extra,
    playbackSessions,
    playedSessions,
    identifiedContacts,
    anonymousVisitors,
    totalViewers: identifiedContacts + anonymousVisitors,
    plays,
    watchedSeconds,
    avgProgressPercent: roundMetric(avgProgressPercent),
    averageWatchSeconds: playedSessions > 0 ? roundMetric(watchedSeconds / playedSessions) : 0,
    playRatePercent: playbackSessions > 0 ? roundMetric((playedSessions / playbackSessions) * 100) : 0,
    completions,
    completionRatePercent: completionBase > 0 ? roundMetric((completions / completionBase) * 100) : 0,
    dropOffPercent: roundMetric(100 - clampPercent(avgProgressPercent))
  }
}

function buildAggregatePlaybackWhere(assetIds, dateFilters = {}) {
  const params = []
  const placeholders = assetIds.map(() => '?').join(',')
  const conditions = [`vps.media_asset_id IN (${placeholders})`]
  params.push(...assetIds)

  if (dateFilters.dateFrom && dateFilters.dateTo) {
    conditions.push('vps.last_event_at >= ? AND vps.last_event_at <= ?')
    params.push(dateFilters.dateFrom, dateFilters.dateTo)
  }

  return {
    where: `WHERE ${conditions.join(' AND ')}`,
    params
  }
}

function playbackAggregateSelect() {
  return `
    COUNT(*) as playback_sessions,
    COALESCE(SUM(CASE WHEN play_count > 0 OR watched_seconds > 0 OR max_progress_percent > 0 OR ended = 1 THEN 1 ELSE 0 END), 0) as played_sessions,
    COUNT(DISTINCT CASE WHEN contact_id IS NOT NULL AND contact_id != '' THEN contact_id ELSE NULL END) as identified_contacts,
    COUNT(DISTINCT ${anonymousVisitorIdentityExpression()}) as anonymous_visitors,
    COALESCE(SUM(play_count), 0) as plays,
    COALESCE(SUM(watched_seconds), 0) as watched_seconds,
    COALESCE(AVG(max_progress_percent), 0) as avg_progress_percent,
    COALESCE(SUM(CASE WHEN ended = 1 OR max_progress_percent >= 99 THEN 1 ELSE 0 END), 0) as completions
  `
}

export async function getVideoPlaybackAggregate(input = {}) {
  const assetIds = normalizePlaybackIdList(input.assetIds || input.mediaAssetIds)
  const dateFilters = await resolvePlaybackDateFilters(input)
  const hourly = boolValue(input.hourly)
  const emptyPeriodCharts = () => buildPlaybackPeriodCharts([], {
    hourly,
    rawDateFrom: input.dateFrom || input.date_from,
    rawDateTo: input.dateTo || input.date_to,
    dateFrom: dateFilters.dateFrom,
    dateTo: dateFilters.dateTo
  })
  const byAssetId = Object.fromEntries(assetIds.map(assetId => [
    assetId,
    emptyPlaybackSummary({ assetId })
  ]))

  if (!assetIds.length) {
    return {
      dateFrom: dateFilters.dateFrom || '',
      dateTo: dateFilters.dateTo || '',
      summary: emptyPlaybackSummary(),
      byAssetId,
      bySiteId: {},
      ...emptyPeriodCharts()
    }
  }

  const { where, params } = buildAggregatePlaybackWhere(assetIds, dateFilters)
  const summary = await db.get(`
    SELECT ${playbackAggregateSelect()}
    FROM video_playback_sessions vps
    ${where}
  `, params)

  const assetRows = await db.all(`
    SELECT
      vps.media_asset_id as asset_id,
      ${playbackAggregateSelect()}
    FROM video_playback_sessions vps
    ${where}
    GROUP BY vps.media_asset_id
  `, params)

  const siteRows = await db.all(`
    SELECT
      COALESCE(NULLIF(vps.site_id, ''), 'unknown') as site_id,
      ${playbackAggregateSelect()}
    FROM video_playback_sessions vps
    ${where}
    GROUP BY COALESCE(NULLIF(vps.site_id, ''), 'unknown')
  `, params)

  const periodExpression = buildPlaybackPeriodExpression(hourly, dateFilters.appliedTimezone)
  const chartRows = await db.all(`
    SELECT
      ${periodExpression} as period_key,
      COALESCE(SUM(play_count), 0) as plays,
      COALESCE(SUM(watched_seconds), 0) as watched_seconds
    FROM video_playback_sessions vps
    ${where}
    GROUP BY ${periodExpression}
    ORDER BY period_key ASC
  `, params)

  for (const row of assetRows) {
    const assetId = cleanString(row.asset_id, 160)
    if (!assetId) continue
    byAssetId[assetId] = playbackSummaryFromRow(row, { assetId })
  }

  const bySiteId = Object.fromEntries(siteRows
    .map(row => {
      const siteId = cleanString(row.site_id, 160) || 'unknown'
      return [siteId, playbackSummaryFromRow(row, { siteId })]
    }))

  return {
    dateFrom: dateFilters.dateFrom || '',
    dateTo: dateFilters.dateTo || '',
    summary: playbackSummaryFromRow(summary),
    byAssetId,
    bySiteId,
    ...buildPlaybackPeriodCharts(chartRows, {
      hourly,
      rawDateFrom: input.dateFrom || input.date_from,
      rawDateTo: input.dateTo || input.date_to,
      dateFrom: dateFilters.dateFrom,
      dateTo: dateFilters.dateTo
    })
  }
}

export async function getVideoPlaybackViewers(input = {}) {
  const dateFilters = await resolvePlaybackDateFilters(input)
  const hourly = boolValue(input.hourly)
  const filters = {
    assetId: cleanString(input.assetId || input.mediaAssetId, 160),
    streamVideoId: cleanString(input.streamVideoId, 160),
    siteId: cleanString(input.siteId, 120),
    ...dateFilters
  }
  const limit = Math.min(250, Math.max(1, Number(input.limit || 100)))
  const offset = Math.max(0, Number(input.offset || 0))
  const params = []
  const where = buildPlaybackWhere(filters, params)

  const summary = await db.get(`
    SELECT
      COUNT(*) as playback_sessions,
      COALESCE(SUM(CASE WHEN play_count > 0 OR watched_seconds > 0 OR max_progress_percent > 0 OR ended = 1 THEN 1 ELSE 0 END), 0) as played_sessions,
      COUNT(DISTINCT CASE WHEN contact_id IS NOT NULL AND contact_id != '' THEN contact_id ELSE NULL END) as identified_contacts,
      COUNT(DISTINCT ${anonymousVisitorIdentityExpression()}) as anonymous_visitors,
      COALESCE(SUM(play_count), 0) as plays,
      COALESCE(SUM(watched_seconds), 0) as watched_seconds,
      COALESCE(AVG(max_progress_percent), 0) as avg_progress_percent,
      COALESCE(SUM(CASE WHEN ended = 1 OR max_progress_percent >= 99 THEN 1 ELSE 0 END), 0) as completions
    FROM video_playback_sessions vps
    ${where}
  `, params)

  const analyticsRows = await db.all(`
    SELECT *
    FROM video_playback_sessions vps
    ${where}
    ORDER BY vps.last_event_at DESC
    LIMIT 5000
  `, params)

  const periodExpression = buildPlaybackPeriodExpression(hourly, dateFilters.appliedTimezone)
  const chartRows = await db.all(`
    SELECT
      ${periodExpression} as period_key,
      COALESCE(SUM(play_count), 0) as plays,
      COALESCE(SUM(watched_seconds), 0) as watched_seconds
    FROM video_playback_sessions vps
    ${where}
    GROUP BY ${periodExpression}
    ORDER BY period_key ASC
  `, params)

  const rows = await db.all(`
    SELECT
      vps.*,
      c.full_name as contact_full_name,
      c.email as contact_email,
      c.phone as contact_phone
    FROM video_playback_sessions vps
    LEFT JOIN contacts c ON c.id = vps.contact_id
    ${where}
    ORDER BY vps.last_event_at DESC
    LIMIT ? OFFSET ?
  `, [...params, Math.min(2000, limit * 8), offset])

  const grouped = new Map()
  for (const row of rows) {
    const key = row.contact_id ? `contact:${row.contact_id}` : `visitor:${row.visitor_id}`
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        contactId: row.contact_id || null,
        visitorId: row.visitor_id || null,
        contactName: row.contact_full_name || row.full_name || null,
        contactEmail: row.contact_email || row.email || null,
        contactPhone: row.contact_phone || null,
        matchMethod: row.match_method || 'anonymous',
        playbackCount: 0,
        playCount: 0,
        watchedSeconds: 0,
        maxProgressPercent: 0,
        maxPositionSeconds: 0,
        durationSeconds: 0,
        completed: false,
        firstEventAt: null,
        lastEventAt: null,
        pageUrl: null,
        publicPageTitle: null,
        blockLabel: null
      })
    }
    mergeViewer(grouped.get(key), row)
  }

  const playbackSessions = Number(summary?.playback_sessions || 0)
  const playedSessions = Number(summary?.played_sessions || 0)
  const plays = Number(summary?.plays || 0)
  const watchedSeconds = Number(summary?.watched_seconds || 0)
  const avgProgressPercent = Number(summary?.avg_progress_percent || 0)
  const completions = Number(summary?.completions || 0)
  const totalViewers = Number(summary?.identified_contacts || 0) + Number(summary?.anonymous_visitors || 0)
  const completionBase = playedSessions || playbackSessions

  return {
    summary: {
      playbackSessions,
      playedSessions,
      identifiedContacts: Number(summary?.identified_contacts || 0),
      anonymousVisitors: Number(summary?.anonymous_visitors || 0),
      totalViewers,
      plays,
      watchedSeconds,
      avgProgressPercent: roundMetric(avgProgressPercent),
      averageWatchSeconds: playedSessions > 0 ? roundMetric(watchedSeconds / playedSessions) : 0,
      playRatePercent: playbackSessions > 0 ? roundMetric((playedSessions / playbackSessions) * 100) : 0,
      completions,
      completionRatePercent: completionBase > 0 ? roundMetric((completions / completionBase) * 100) : 0,
      dropOffPercent: roundMetric(100 - clampPercent(avgProgressPercent))
    },
    ...buildPlaybackPeriodCharts(chartRows, {
      hourly,
      rawDateFrom: input.dateFrom || input.date_from,
      rawDateTo: input.dateTo || input.date_to,
      dateFrom: dateFilters.dateFrom,
      dateTo: dateFilters.dateTo
    }),
    retentionSegments: buildRetentionSegments(analyticsRows),
    pages: buildPlaybackBreakdown(
      analyticsRows,
      row => cleanString(row.public_page_id || row.page_url, 500),
      row => cleanString(row.public_page_title || row.page_url, 500)
    ),
    blocks: buildPlaybackBreakdown(
      analyticsRows,
      row => cleanString(row.block_id || row.block_label, 260),
      row => cleanString(row.block_label || row.block_id, 260)
    ),
    viewers: [...grouped.values()]
      .sort((a, b) => String(b.lastEventAt || '').localeCompare(String(a.lastEventAt || '')))
      .slice(0, limit),
    limit,
    offset
  }
}

export async function logVideoTrackingInstallHealth() {
  try {
    await db.get('SELECT 1 FROM video_playback_sessions LIMIT 1')
    return true
  } catch (error) {
    logger.warn(`Video tracking no esta disponible: ${error.message}`)
    return false
  }
}
