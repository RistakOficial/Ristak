import crypto from 'crypto'
import { DateTime } from 'luxon'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import {
  resolveDateRangeWithGHLTimezone,
  sqliteTimezoneModifierExpression
} from '../utils/dateUtils.js'
import {
  buildTrackingIdentitySignals,
  recordTrackingIdentityMatch,
  resolveTrackingIdentity
} from './trackingIdentityService.js'

const isPostgresRuntime = Boolean(process.env.DATABASE_URL)
const MAX_PLAYBACK_CHART_POINTS = 400
const MAX_CLIENT_EVENT_CLOCK_SKEW_MS = 5 * 60 * 1000
const CALENDAR_DEFAULT_FORM_SITE_ID = 'system-calendar-booking-form'

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

function parseEventDate(value, { strict = false, receivedAt = new Date() } = {}) {
  const rawNumber = Number(value)
  const date = Number.isFinite(rawNumber)
    ? new Date(rawNumber)
    : new Date(String(value || ''))
  if (!Number.isFinite(date.getTime())) {
    if (strict) {
      const error = new Error('Invalid video event timestamp')
      error.status = 400
      throw error
    }
    return {
      clientEventAt: null,
      eventAt: receivedAt.toISOString(),
      quality: 'server_fallback'
    }
  }
  const clientEventAt = date.toISOString()
  if (Math.abs(date.getTime() - receivedAt.getTime()) > MAX_CLIENT_EVENT_CLOCK_SKEW_MS) {
    return {
      clientEventAt,
      eventAt: receivedAt.toISOString(),
      quality: 'client_adjusted'
    }
  }
  return {
    clientEventAt,
    eventAt: clientEventAt,
    quality: 'client_verified'
  }
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
    eventSequence: numberOrNull(data.event_sequence ?? data.eventSequence),
    ingestionVersion: Math.max(1, Math.floor(numberOrNull(data.ingestion_version ?? data.ingestionVersion) || 1)),
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
    watchFrom: clampNumber(data.watch_from_seconds ?? data.watchFromSeconds, 0, 24 * 60 * 60),
    watchTo: clampNumber(data.watch_to_seconds ?? data.watchToSeconds, 0, 24 * 60 * 60),
    watchedDelta: clampNumber(data.watched_delta_seconds ?? data.watchedDeltaSeconds, 0, 30) || 0,
    payloadJson: parseJsonPayload(data)
  }
}

function buildVideoEventPayloadHash(body, video, clientEventAt) {
  const canonical = {
    eventId: video.eventId,
    eventSequence: video.eventSequence,
    ingestionVersion: video.ingestionVersion,
    playbackId: video.playbackId,
    visitorId: body.visitorId,
    sessionId: body.sessionId,
    eventName: video.eventName,
    mediaAssetId: video.mediaAssetId,
    streamLibraryId: video.streamLibraryId,
    streamVideoId: video.streamVideoId,
    videoProvider: video.videoProvider,
    trackingSource: video.trackingSource,
    siteId: video.siteId,
    publicPageId: video.publicPageId,
    blockId: video.blockId,
    pageUrl: video.pageUrl,
    position: video.position,
    duration: video.duration,
    progressPercent: video.progressPercent,
    watchFrom: video.watchFrom,
    watchTo: video.watchTo,
    watchedDelta: video.watchedDelta,
    clientEventAt
  }
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function videoTrackingConflict(message) {
  const error = new Error(message)
  error.status = 409
  error.code = 'VIDEO_EVENT_CONFLICT'
  return error
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
  return eventName === 'video_ended'
}

async function assertStablePlaybackContext(tx, video) {
  if (video.ingestionVersion < 2) return
  const existing = await tx.get(`
    SELECT media_asset_id, site_id, public_page_id, block_id
    FROM video_playback_events
    WHERE playback_id = ?
    ORDER BY event_at ASC, id ASC
    LIMIT 1
  `, [video.playbackId])
  if (!existing) return

  for (const [field, incoming] of [
    ['media_asset_id', video.mediaAssetId],
    ['site_id', video.siteId],
    ['public_page_id', video.publicPageId],
    ['block_id', video.blockId]
  ]) {
    const persisted = cleanString(existing[field], 200)
    if (persisted && incoming && persisted !== incoming) {
      throw videoTrackingConflict(`Playback context changed for ${field}`)
    }
  }
}

async function insertPlaybackEvent(
  tx,
  body,
  video,
  contact,
  eventAt,
  clientEventAt,
  eventTimeQuality
) {
  const payloadHash = buildVideoEventPayloadHash(body, video, clientEventAt)
  const result = await tx.run(`
    INSERT INTO video_playback_events (
      id,
      event_id,
      event_sequence,
      ingestion_version,
      payload_hash,
      playback_id,
      visitor_id,
      session_id,
      contact_id,
      event_name,
      media_asset_id,
      stream_library_id,
      stream_video_id,
      video_provider,
      tracking_source,
      context_verified,
      event_time_quality,
      site_id,
      public_page_id,
      block_id,
      page_url,
      watch_from_seconds,
      watch_to_seconds,
      position_seconds,
      duration_seconds,
      progress_percent,
      watched_delta_seconds,
      payload_json,
      client_event_at,
      event_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `, [
    crypto.randomUUID(),
    video.eventId,
    video.eventSequence,
    video.ingestionVersion,
    payloadHash,
    video.playbackId,
    body.visitorId,
    body.sessionId,
    contact.id,
    video.eventName,
    video.mediaAssetId,
    video.streamLibraryId,
    video.streamVideoId,
    video.videoProvider,
    video.trackingSource,
    video.ingestionVersion >= 2 ? 1 : 0,
    eventTimeQuality,
    video.siteId,
    video.publicPageId,
    video.blockId,
    video.pageUrl,
    video.watchFrom,
    video.watchTo,
    video.position,
    video.duration,
    video.progressPercent,
    video.watchedDelta,
    video.payloadJson,
    clientEventAt,
    eventAt
  ])

  if (Number(result.changes || 0) === 1) {
    return { inserted: true, deduplicated: false, payloadHash }
  }

  const existing = video.eventSequence === null
    ? await tx.get(`
        SELECT event_id, event_sequence, payload_hash
        FROM video_playback_events
        WHERE event_id = ?
        LIMIT 1
      `, [video.eventId])
    : await tx.get(`
        SELECT event_id, event_sequence, payload_hash
        FROM video_playback_events
        WHERE event_id = ?
           OR (playback_id = ? AND event_sequence = ?)
        ORDER BY CASE WHEN event_id = ? THEN 0 ELSE 1 END
        LIMIT 1
      `, [video.eventId, video.playbackId, video.eventSequence, video.eventId])

  if (
    existing &&
    existing.event_id === video.eventId &&
    existing.payload_hash === payloadHash &&
    Number(existing.event_sequence) === Number(video.eventSequence)
  ) {
    return { inserted: false, deduplicated: true, payloadHash }
  }

  throw videoTrackingConflict('Video event id or sequence was already used with a different payload')
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
  const parsedEventDate = parseEventDate(input.ts || input.timestamp || Date.now(), {
    strict: video.ingestionVersion >= 2,
    receivedAt: new Date()
  })
  const eventAt = parsedEventDate.eventAt

  if (!body.visitorId || !body.sessionId || !video.eventName || !video.playbackId) {
    const error = new Error('Missing required video tracking fields')
    error.status = 400
    throw error
  }
  if (video.ingestionVersion >= 2) {
    if (!video.eventId || !Number.isInteger(video.eventSequence) || video.eventSequence < 1) {
      const error = new Error('Video v2 requires event_id and a positive integer event_sequence')
      error.status = 400
      throw error
    }
  }
  if (video.watchFrom !== null && video.watchTo !== null && video.watchTo < video.watchFrom) {
    const error = new Error('Invalid video watch interval')
    error.status = 400
    throw error
  }

  const requestInfo = {
    ip: cleanString(input.ip, 80),
    userAgent: cleanString(input.user_agent || input.userAgent, 1000)
  }

  return db.transaction(async (tx) => {
    await assertStablePlaybackContext(tx, video)
    const contact = await resolveContactForPlayback(tx, body.contactId, body.visitorId, video, requestInfo, eventAt)
    const ledger = await insertPlaybackEvent(
      tx,
      body,
      video,
      contact,
      eventAt,
      parsedEventDate.clientEventAt,
      parsedEventDate.quality
    )
    if (!ledger.inserted) {
      const existing = await tx.get(
        'SELECT * FROM video_playback_sessions WHERE playback_id = ?',
        [video.playbackId]
      )
      return {
        playbackId: video.playbackId,
        contactId: existing?.contact_id || contact.id || null,
        visitorId: existing?.visitor_id || body.visitorId,
        streamVideoId: existing?.stream_video_id || video.streamVideoId,
        progressPercent: Number(existing?.max_progress_percent || 0),
        watchedSeconds: Number(existing?.watched_seconds || 0),
        ended: Boolean(existing?.ended),
        matchMethod: existing?.match_method || contact.matchMethod || 'anonymous',
        matchConfidence: Number(existing?.match_confidence || contact.matchConfidence || 0),
        accepted: true,
        deduplicated: true,
        ingestionVersion: video.ingestionVersion
      }
    }

    const summary = await upsertPlaybackSession(tx, body, video, contact, requestInfo, eventAt)
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
    return {
      ...summary,
      accepted: true,
      deduplicated: false,
      ingestionVersion: video.ingestionVersion
    }
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
  const dateFrom = input.dateFrom || input.date_from
  const dateTo = input.dateTo || input.date_to
  if (!dateFrom && !dateTo) return {}
  if (!dateFrom || !dateTo) {
    const error = new Error('Selecciona dateFrom y dateTo para consultar analíticas de video.')
    error.status = 400
    throw error
  }

  const normalizedDateFrom = String(dateFrom).trim()
  const normalizedDateTo = String(dateTo).trim()
  const parseCalendarDate = (value, fieldName) => {
    const parsed = DateTime.fromFormat(value, 'yyyy-MM-dd', {
      zone: 'UTC',
      locale: 'en',
      setZone: true
    })
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !parsed.isValid ||
      parsed.toFormat('yyyy-MM-dd') !== value
    ) {
      const error = new Error(`${fieldName} debe ser una fecha calendario válida en formato YYYY-MM-DD.`)
      error.status = 400
      throw error
    }
    return parsed
  }
  const parsedDateFrom = parseCalendarDate(normalizedDateFrom, 'dateFrom')
  const parsedDateTo = parseCalendarDate(normalizedDateTo, 'dateTo')
  if (parsedDateFrom.toMillis() > parsedDateTo.toMillis()) {
    const error = new Error('dateFrom no puede ser posterior a dateTo.')
    error.status = 400
    throw error
  }

  const range = await resolveDateRangeWithGHLTimezone({
    startDate: normalizedDateFrom,
    endDate: normalizedDateTo
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
    return `strftime('${format}', datetime(vps.last_event_at, ${sqliteTimezoneOffsetClause(timezone)}))`
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
    : [
      date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0')
    ].join('-')
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
    playerLoads: 0,
    playbackStarts: 0,
    playActions: 0,
    uniqueViewers: 0,
    completedPlaybacks: 0,
    incompletePlaybacks: 0,
    incompleteRatePercent: 0,
    averageTimelineReachPercent: 0,
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
    dropOffPercent: null
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

function normalizePlaybackSiteScope(value = {}) {
  const requestedType = cleanString(value?.siteType || value?.site_type || value?.type, 40)
  const siteType = ['sites', 'forms', 'videos'].includes(requestedType) ? requestedType : ''
  const requestedLandingMode = cleanString(value?.landingMode || value?.landing_mode, 40)
  const landingMode = ['website', 'funnel'].includes(requestedLandingMode) ? requestedLandingMode : ''
  const siteId = cleanString(value?.siteId || value?.site_id, 180)
  return siteType || siteId ? { siteType, landingMode, siteId } : null
}

function playbackSiteLibrarySourceExpression(alias = 'ps') {
  if (isPostgresRuntime) {
    return `COALESCE(ristak_safe_jsonb(${alias}.theme_json) ->> 'librarySource', '')`
  }
  return `CASE
    WHEN json_valid(${alias}.theme_json)
    THEN COALESCE(json_extract(${alias}.theme_json, '$.librarySource'), '')
    ELSE ''
  END`
}

function buildAggregatePlaybackWhere(assetIds, siteIds, siteScope, dateFilters = {}) {
  const params = []
  const conditions = []

  if (assetIds.length) {
    conditions.push(`vps.media_asset_id IN (${assetIds.map(() => '?').join(',')})`)
    params.push(...assetIds)
  }
  if (siteIds.length) {
    conditions.push(`vps.site_id IN (${siteIds.map(() => '?').join(',')})`)
    params.push(...siteIds)
  }
  if (siteScope) {
    const siteConditions = [
      "ps.status = 'published'",
      `ps.id != '${CALENDAR_DEFAULT_FORM_SITE_ID}'`,
      `${playbackSiteLibrarySourceExpression('ps')} != 'calendar'`
    ]
    if (siteScope.siteType === 'forms') {
      siteConditions.push("ps.site_type IN ('standard_form', 'interactive_form')")
    } else if (siteScope.siteType === 'sites') {
      siteConditions.push("ps.site_type = 'landing_page'")
      if (siteScope.landingMode) {
        const pageModeExpression = isPostgresRuntime
          ? "COALESCE(ristak_safe_jsonb(ps.theme_json) ->> 'pageMode', 'funnel')"
          : "CASE WHEN json_valid(ps.theme_json) THEN COALESCE(json_extract(ps.theme_json, '$.pageMode'), 'funnel') ELSE 'funnel' END"
        siteConditions.push(`${pageModeExpression} = ?`)
        params.push(siteScope.landingMode)
      }
    }
    if (siteScope.siteId) {
      siteConditions.push('ps.id = ?')
      params.push(siteScope.siteId)
    }
    conditions.push(`vps.site_id IN (
      SELECT ps.id
      FROM public_sites ps
      WHERE ${siteConditions.join(' AND ')}
    )`)
  }

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

function buildVideoEventScope({
  assetIds = [],
  siteIds = [],
  siteScope = null,
  streamVideoId = null
} = {}, alias = 'e') {
  const conditions = [
    `(${alias}.tracking_source IS NULL OR ${alias}.tracking_source = '' OR ${alias}.tracking_source = 'native_site_video')`
  ]
  const params = []

  if (assetIds.length) {
    conditions.push(`${alias}.media_asset_id IN (${assetIds.map(() => '?').join(',')})`)
    params.push(...assetIds)
  }
  if (streamVideoId) {
    conditions.push(`${alias}.stream_video_id = ?`)
    params.push(streamVideoId)
  }
  if (siteIds.length) {
    conditions.push(`${alias}.site_id IN (${siteIds.map(() => '?').join(',')})`)
    params.push(...siteIds)
  }
  if (siteScope) {
    const siteConditions = [
      "ps.status = 'published'",
      `ps.id != '${CALENDAR_DEFAULT_FORM_SITE_ID}'`,
      `${playbackSiteLibrarySourceExpression('ps')} != 'calendar'`
    ]
    if (siteScope.siteType === 'forms') {
      siteConditions.push("ps.site_type IN ('standard_form', 'interactive_form')")
    } else if (siteScope.siteType === 'sites') {
      siteConditions.push("ps.site_type = 'landing_page'")
      if (siteScope.landingMode) {
        const pageModeExpression = isPostgresRuntime
          ? "COALESCE(ristak_safe_jsonb(ps.theme_json) ->> 'pageMode', 'funnel')"
          : "CASE WHEN json_valid(ps.theme_json) THEN COALESCE(json_extract(ps.theme_json, '$.pageMode'), 'funnel') ELSE 'funnel' END"
        siteConditions.push(`${pageModeExpression} = ?`)
        params.push(siteScope.landingMode)
      }
    }
    if (siteScope.siteId) {
      siteConditions.push('ps.id = ?')
      params.push(siteScope.siteId)
    }
    conditions.push(`${alias}.site_id IN (
      SELECT ps.id
      FROM public_sites ps
      WHERE ${siteConditions.join(' AND ')}
    )`)
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  }
}

function buildLedgerRangeFlag(dateFilters = {}, alias = 'e') {
  if (!dateFilters.dateFrom || !dateFilters.dateTo) {
    return { sql: '1', params: [] }
  }
  return {
    sql: `CASE WHEN ${alias}.event_at >= ? AND ${alias}.event_at <= ? THEN 1 ELSE 0 END`,
    params: [dateFilters.dateFrom, dateFilters.dateTo]
  }
}

function buildLedgerTimestampCondition(column, dateFilters = {}, params = []) {
  if (!dateFilters.dateFrom || !dateFilters.dateTo) return '1 = 1'
  params.push(dateFilters.dateFrom, dateFilters.dateTo)
  return `${column} >= ? AND ${column} <= ?`
}

function buildVideoLedgerCte(scope, dateFilters = {}) {
  const rangeFlag = buildLedgerRangeFlag(dateFilters)
  const readyRangeParams = []
  const playRangeParams = []
  const readyInRange = buildLedgerTimestampCondition('first_ready_at', dateFilters, readyRangeParams)
  const playInRange = buildLedgerTimestampCondition('first_play_at', dateFilters, playRangeParams)
  return {
    params: [
      ...rangeFlag.params,
      ...scope.params,
      ...readyRangeParams,
      ...playRangeParams
    ],
    sql: `
      WITH scoped_events AS (
        SELECT
          e.*,
          ROW_NUMBER() OVER (
            PARTITION BY e.playback_id
            ORDER BY e.event_at DESC, COALESCE(e.event_sequence, 0) DESC, e.id DESC
          ) AS playback_event_rank,
          ${rangeFlag.sql} AS in_range,
          CASE
            WHEN COALESCE(e.watched_delta_seconds, 0) >= 0
             AND COALESCE(e.watched_delta_seconds, 0) <= 30
            THEN COALESCE(e.watched_delta_seconds, 0)
            ELSE 0
          END AS accepted_delta
        FROM video_playback_events e
        ${scope.where}
      ),
      playback_facts AS (
        SELECT
          playback_id,
          MAX(media_asset_id) AS asset_id,
          MAX(stream_video_id) AS stream_video_id,
          MAX(site_id) AS site_id,
          MAX(CASE WHEN playback_event_rank = 1 THEN public_page_id ELSE NULL END) AS public_page_id,
          MAX(CASE WHEN playback_event_rank = 1 THEN block_id ELSE NULL END) AS block_id,
          MAX(CASE WHEN playback_event_rank = 1 THEN page_url ELSE NULL END) AS page_url,
          MAX(contact_id) AS contact_id,
          MAX(visitor_id) AS visitor_id,
          MAX(session_id) AS session_id,
          MIN(event_at) AS first_event_at,
          MAX(CASE WHEN in_range = 1 THEN event_at ELSE NULL END) AS last_event_at,
          MIN(CASE WHEN event_name = 'video_ready' THEN event_at ELSE NULL END) AS first_ready_at,
          MIN(CASE WHEN event_name = 'video_play' THEN event_at ELSE NULL END) AS first_play_at,
          MIN(CASE WHEN event_name = 'video_ended' AND in_range = 1 THEN event_at ELSE NULL END) AS first_ended_in_range_at,
          COALESCE(SUM(CASE WHEN in_range = 1 AND event_name = 'video_play' THEN 1 ELSE 0 END), 0) AS range_play_actions,
          COALESCE(SUM(CASE WHEN in_range = 1 THEN accepted_delta ELSE 0 END), 0) AS range_watched_seconds,
          COALESCE(MAX(CASE
            WHEN in_range = 1 AND event_name = 'video_ended' THEN 100
            WHEN in_range = 1 THEN progress_percent
            ELSE NULL
          END), 0) AS range_max_reach_percent,
          COALESCE(MAX(CASE WHEN in_range = 1 THEN position_seconds ELSE NULL END), 0) AS range_max_position_seconds,
          COALESCE(MAX(CASE WHEN in_range = 1 THEN duration_seconds ELSE NULL END), 0) AS range_duration_seconds,
          COALESCE(SUM(CASE WHEN in_range = 1 THEN 1 ELSE 0 END), 0) AS range_event_count,
          COALESCE(SUM(CASE
            WHEN in_range = 1
             AND COALESCE(ingestion_version, 1) >= 2
             AND event_id IS NOT NULL AND event_id != ''
             AND event_sequence IS NOT NULL
             AND payload_hash IS NOT NULL AND payload_hash != ''
            THEN 1 ELSE 0
          END), 0) AS verified_event_count,
          COALESCE(SUM(CASE
            WHEN in_range = 1 AND (
              COALESCE(ingestion_version, 1) < 2
              OR event_id IS NULL OR event_id = ''
              OR event_sequence IS NULL
              OR payload_hash IS NULL OR payload_hash = ''
            )
            THEN 1 ELSE 0
          END), 0) AS legacy_event_count,
          COALESCE(SUM(CASE
            WHEN in_range = 1
             AND event_time_quality IN ('client_adjusted', 'server_fallback')
            THEN 1 ELSE 0
          END), 0) AS adjusted_time_event_count,
          COUNT(DISTINCT media_asset_id) AS asset_context_count,
          COUNT(DISTINCT site_id) AS site_context_count
        FROM scoped_events
        GROUP BY playback_id
      ),
      playbacks AS (
        SELECT
          playback_facts.*,
          CASE
            WHEN contact_id IS NOT NULL AND contact_id != '' THEN 'contact:' || contact_id
            WHEN visitor_id IS NOT NULL AND visitor_id != '' THEN 'visitor:' || visitor_id
            WHEN session_id IS NOT NULL AND session_id != '' THEN 'session:' || session_id
            ELSE NULL
          END AS identity_key,
          CASE WHEN ${readyInRange} THEN 1 ELSE 0 END AS ready_in_range,
          CASE WHEN ${playInRange} THEN 1 ELSE 0 END AS play_in_range
        FROM playback_facts
      )
    `
  }
}

function buildLedgerAggregateSelect() {
  return `
    COALESCE(SUM(CASE WHEN ready_in_range = 1 THEN 1 ELSE 0 END), 0) AS player_loads,
    COALESCE(SUM(CASE WHEN play_in_range = 1 THEN 1 ELSE 0 END), 0) AS playback_starts,
    COALESCE(SUM(CASE WHEN ready_in_range = 1 AND play_in_range = 1 THEN 1 ELSE 0 END), 0) AS started_player_loads,
    COALESCE(SUM(range_play_actions), 0) AS play_actions,
    COUNT(DISTINCT CASE WHEN play_in_range = 1 THEN identity_key ELSE NULL END) AS unique_viewers,
    COUNT(DISTINCT CASE
      WHEN play_in_range = 1 AND contact_id IS NOT NULL AND contact_id != '' THEN contact_id
      ELSE NULL
    END) AS identified_contacts,
    COUNT(DISTINCT CASE
      WHEN play_in_range = 1 AND (contact_id IS NULL OR contact_id = '') THEN identity_key
      ELSE NULL
    END) AS anonymous_visitors,
    COALESCE(SUM(range_watched_seconds), 0) AS watched_seconds,
    COALESCE(SUM(CASE WHEN play_in_range = 1 THEN range_watched_seconds ELSE 0 END), 0) AS cohort_watched_seconds,
    COALESCE(AVG(CASE WHEN play_in_range = 1 THEN range_max_reach_percent ELSE NULL END), 0) AS average_timeline_reach_percent,
    COALESCE(SUM(CASE
      WHEN play_in_range = 1
       AND first_ended_in_range_at IS NOT NULL
       AND first_ended_in_range_at >= first_play_at
      THEN 1 ELSE 0
    END), 0) AS completed_playbacks,
    COALESCE(SUM(range_event_count), 0) AS total_events,
    COALESCE(SUM(verified_event_count), 0) AS verified_events,
    COALESCE(SUM(legacy_event_count), 0) AS legacy_events,
    COALESCE(SUM(adjusted_time_event_count), 0) AS adjusted_time_events,
    COALESCE(SUM(CASE WHEN asset_context_count > 1 OR site_context_count > 1 THEN 1 ELSE 0 END), 0) AS context_conflicts
  `
}

function playbackSummaryFromLedgerRow(row = {}, extra = {}) {
  const playerLoads = Number(row.player_loads || 0)
  const playbackStarts = Number(row.playback_starts || 0)
  const playActions = Number(row.play_actions || 0)
  const uniqueViewers = Number(row.unique_viewers || 0)
  const identifiedContacts = Number(row.identified_contacts || 0)
  const anonymousVisitors = Number(row.anonymous_visitors || 0)
  const watchedSeconds = Number(row.watched_seconds || 0)
  const cohortWatchedSeconds = Number(row.cohort_watched_seconds || 0)
  const completedPlaybacks = Number(row.completed_playbacks || 0)
  const incompletePlaybacks = Math.max(0, playbackStarts - completedPlaybacks)
  const averageTimelineReachPercent = roundMetric(row.average_timeline_reach_percent || 0)

  return {
    ...extra,
    playerLoads,
    playbackStarts,
    playActions,
    uniqueViewers,
    completedPlaybacks,
    incompletePlaybacks,
    incompleteRatePercent: playbackStarts > 0
      ? roundMetric((incompletePlaybacks / playbackStarts) * 100)
      : 0,
    averageTimelineReachPercent,
    playbackSessions: playerLoads,
    playedSessions: playbackStarts,
    identifiedContacts,
    anonymousVisitors,
    totalViewers: uniqueViewers,
    plays: playbackStarts,
    watchedSeconds,
    avgProgressPercent: averageTimelineReachPercent,
    averageWatchSeconds: playbackStarts > 0
      ? roundMetric(cohortWatchedSeconds / playbackStarts)
      : 0,
    playRatePercent: playerLoads > 0
      ? roundMetric((Number(row.started_player_loads || 0) / playerLoads) * 100)
      : 0,
    completions: completedPlaybacks,
    completionRatePercent: playbackStarts > 0
      ? roundMetric((completedPlaybacks / playbackStarts) * 100)
      : 0,
    dropOffPercent: null
  }
}

function videoLedgerQualityFromRow(row = {}) {
  const totalEvents = Number(row.total_events || 0)
  const verifiedEvents = Number(row.verified_events || 0)
  const legacyEvents = Number(row.legacy_events || 0)
  const adjustedTimeEvents = Number(row.adjusted_time_events || 0)
  const contextConflicts = Number(row.context_conflicts || 0)
  const status = totalEvents === 0
    ? 'empty'
    : legacyEvents === totalEvents
      ? 'legacy_only'
      : legacyEvents > 0 || contextConflicts > 0
      ? 'mixed_legacy'
      : 'verified'
  return {
    source: 'first_party',
    status,
    totalEvents,
    verifiedEvents,
    legacyEvents,
    adjustedTimeEvents,
    contextConflicts,
    warnings: [
      ...(legacyEvents > 0
        ? [`${legacyEvents} evento(s) legacy no garantizan idempotencia ni tiempo visto completo.`]
        : []),
      ...(contextConflicts > 0
        ? [`${contextConflicts} reproducción(es) históricas cambiaron de sitio o video.`]
        : []),
      ...(adjustedTimeEvents > 0
        ? [`${adjustedTimeEvents} evento(s) usaron hora de recepción por timestamp inválido o fuera de tolerancia.`]
        : [])
    ]
  }
}

function buildLedgerPeriodExpression(column, hourly = false, timezone = 'UTC', dateFilters = {}) {
  if (!isPostgresRuntime) {
    const format = hourly ? '%Y-%m-%dT%H:00:00' : '%Y-%m-%d'
    const modifier = sqliteTimezoneModifierExpression(column, timezone, {
      startUtc: dateFilters.dateFrom,
      endUtc: dateFilters.dateTo
    })
    return `strftime('${format}', datetime(${column}, ${modifier}))`
  }
  const safeTimezone = String(timezone || 'UTC').replace(/'/g, "''")
  const format = hourly ? 'YYYY-MM-DD"T"HH24:00:00' : 'YYYY-MM-DD'
  return `TO_CHAR((${column})::timestamptz AT TIME ZONE '${safeTimezone}', '${format}')`
}

export async function getVideoPlaybackAggregate(input = {}) {
  const assetIds = normalizePlaybackIdList(input.assetIds || input.mediaAssetIds)
  const breakdownAssetIds = normalizePlaybackIdList(input.breakdownAssetIds || input.breakdownMediaAssetIds)
  const siteIds = normalizePlaybackIdList(input.siteIds || input.publicSiteIds, 500)
  const siteScope = normalizePlaybackSiteScope(input.siteScope || input.scope)
  const includeSiteBreakdown = boolValue(input.includeSiteBreakdown)
  const dateFilters = await resolvePlaybackDateFilters(input)
  const hourly = boolValue(input.hourly)
  const emptyPeriodCharts = () => buildPlaybackPeriodCharts([], {
    hourly,
    rawDateFrom: input.dateFrom || input.date_from,
    rawDateTo: input.dateTo || input.date_to,
    dateFrom: dateFilters.dateFrom,
    dateTo: dateFilters.dateTo
  })
  const requestedBreakdownAssetIds = breakdownAssetIds.length ? breakdownAssetIds : assetIds
  const byAssetId = Object.fromEntries(requestedBreakdownAssetIds.map(assetId => [
    assetId,
    emptyPlaybackSummary({ assetId })
  ]))

  if (!assetIds.length && !siteIds.length && !siteScope) {
    const emptySummary = emptyPlaybackSummary()
    const emptyQuality = videoLedgerQualityFromRow()
    const emptyCharts = emptyPeriodCharts()
    return {
      schemaVersion: 2,
      dateFrom: dateFilters.dateFrom || '',
      dateTo: dateFilters.dateTo || '',
      meta: {
        source: 'first_party',
        status: 'empty',
        timezone: dateFilters.appliedTimezone || '',
        warnings: [],
        quality: emptyQuality
      },
      quality: emptyQuality,
      summary: emptySummary,
      byAssetId,
      bySiteId: {},
      topAssetsByStarts: [],
      topAssetsByWatch: [],
      timelineReachCurve: [],
      heatmap: null,
      retentionSegments: [],
      series: {
        playbackStarts: emptyCharts.viewsChart,
        watchedSeconds: emptyCharts.watchTimeChart
      },
      ...emptyCharts
    }
  }

  const scope = buildVideoEventScope({ assetIds, siteIds, siteScope })
  const ledger = buildVideoLedgerCte(scope, dateFilters)
  const aggregateSelect = buildLedgerAggregateSelect()
  const startPeriodExpression = buildLedgerPeriodExpression(
    'first_play_at',
    hourly,
    dateFilters.appliedTimezone,
    dateFilters
  )
  const watchPeriodExpression = buildLedgerPeriodExpression(
    'event_at',
    hourly,
    dateFilters.appliedTimezone,
    dateFilters
  )
  const assetIdentitySelect = `
    playbacks.asset_id,
    MAX(playbacks.stream_video_id) AS stream_video_id,
    MAX(media_assets.original_filename) AS asset_name
  `
  const selectedAssetRowsPromise = requestedBreakdownAssetIds.length
    ? db.all(`
        ${ledger.sql}
        SELECT ${assetIdentitySelect}, ${aggregateSelect}
        FROM playbacks
        LEFT JOIN media_assets ON media_assets.id = playbacks.asset_id
        WHERE playbacks.asset_id IN (${requestedBreakdownAssetIds.map(() => '?').join(',')})
        GROUP BY playbacks.asset_id
      `, [...ledger.params, ...requestedBreakdownAssetIds])
    : Promise.resolve([])
  const [
    summaryRow,
    selectedAssetRows,
    topAssetStartRows,
    topAssetWatchRows,
    startChartRows,
    watchChartRows
  ] = await Promise.all([
    db.get(`
      ${ledger.sql}
      SELECT ${aggregateSelect}
      FROM playbacks
    `, ledger.params),
    selectedAssetRowsPromise,
    db.all(`
      ${ledger.sql}
      SELECT ${assetIdentitySelect}, ${aggregateSelect}
      FROM playbacks
      LEFT JOIN media_assets ON media_assets.id = playbacks.asset_id
      WHERE playbacks.asset_id IS NOT NULL AND playbacks.asset_id != ''
      GROUP BY playbacks.asset_id
      ORDER BY playback_starts DESC, watched_seconds DESC, playbacks.asset_id ASC
      LIMIT 10
    `, ledger.params),
    db.all(`
      ${ledger.sql}
      SELECT ${assetIdentitySelect}, ${aggregateSelect}
      FROM playbacks
      LEFT JOIN media_assets ON media_assets.id = playbacks.asset_id
      WHERE playbacks.asset_id IS NOT NULL AND playbacks.asset_id != ''
      GROUP BY playbacks.asset_id
      ORDER BY watched_seconds DESC, playback_starts DESC, playbacks.asset_id ASC
      LIMIT 10
    `, ledger.params),
    db.all(`
      ${ledger.sql}
      SELECT
        ${startPeriodExpression} AS period_key,
        COUNT(*) AS plays
      FROM playbacks
      WHERE play_in_range = 1
      GROUP BY ${startPeriodExpression}
      ORDER BY period_key ASC
    `, ledger.params),
    db.all(`
      ${ledger.sql}
      SELECT
        ${watchPeriodExpression} AS period_key,
        COALESCE(SUM(accepted_delta), 0) AS watched_seconds
      FROM scoped_events
      WHERE in_range = 1
      GROUP BY ${watchPeriodExpression}
      ORDER BY period_key ASC
    `, ledger.params)
  ])

  const siteRows = includeSiteBreakdown
    ? await db.all(`
        ${ledger.sql}
        SELECT
          COALESCE(NULLIF(site_id, ''), 'unknown') AS site_id,
          ${aggregateSelect}
        FROM playbacks
        GROUP BY COALESCE(NULLIF(site_id, ''), 'unknown')
      `, ledger.params)
    : []

  const chartByPeriod = new Map()
  for (const row of startChartRows) {
    chartByPeriod.set(row.period_key, {
      period_key: row.period_key,
      plays: Number(row.plays || 0),
      watched_seconds: 0
    })
  }
  for (const row of watchChartRows) {
    const current = chartByPeriod.get(row.period_key) || {
      period_key: row.period_key,
      plays: 0,
      watched_seconds: 0
    }
    current.watched_seconds = Number(row.watched_seconds || 0)
    chartByPeriod.set(row.period_key, current)
  }
  const chartRows = [...chartByPeriod.values()]

  for (const row of selectedAssetRows) {
    const assetId = cleanString(row.asset_id, 160)
    if (!assetId) continue
    const assetName = cleanString(row.asset_name, 260)
    const assetTitle = assetName || cleanString(row.stream_video_id, 160) || assetId
    byAssetId[assetId] = playbackSummaryFromLedgerRow(row, {
      assetId,
      assetName: assetName || null,
      assetTitle,
      streamVideoId: cleanString(row.stream_video_id, 160) || null
    })
  }

  const bySiteId = Object.fromEntries(siteRows
    .map(row => {
      const siteId = cleanString(row.site_id, 160) || 'unknown'
      return [siteId, playbackSummaryFromLedgerRow(row, { siteId })]
    }))
  const summary = playbackSummaryFromLedgerRow(summaryRow)
  const quality = videoLedgerQualityFromRow(summaryRow)
  const periodCharts = buildPlaybackPeriodCharts(chartRows, {
    hourly,
    rawDateFrom: input.dateFrom || input.date_from,
    rawDateTo: input.dateTo || input.date_to,
    dateFrom: dateFilters.dateFrom,
    dateTo: dateFilters.dateTo
  })
  const assetSummaryFromRow = row => {
    const assetId = cleanString(row.asset_id, 160)
    const assetName = cleanString(row.asset_name, 260)
    return playbackSummaryFromLedgerRow(row, {
      assetId,
      assetName: assetName || null,
      assetTitle: assetName || cleanString(row.stream_video_id, 160) || assetId,
      streamVideoId: cleanString(row.stream_video_id, 160) || null
    })
  }

  return {
    schemaVersion: 2,
    dateFrom: dateFilters.dateFrom || '',
    dateTo: dateFilters.dateTo || '',
    meta: {
      source: 'first_party',
      status: quality.status,
      timezone: dateFilters.appliedTimezone || '',
      startUtc: dateFilters.dateFrom || '',
      endUtc: dateFilters.dateTo || '',
      asOf: new Date().toISOString(),
      warnings: quality.warnings,
      quality
    },
    quality,
    summary,
    byAssetId,
    bySiteId,
    topAssetsByStarts: topAssetStartRows.map(assetSummaryFromRow),
    topAssetsByWatch: topAssetWatchRows.map(assetSummaryFromRow),
    timelineReachCurve: [],
    heatmap: null,
    retentionSegments: [],
    series: {
      playbackStarts: periodCharts.viewsChart,
      watchedSeconds: periodCharts.watchTimeChart
    },
    deprecatedAliases: {
      playbackSessions: 'playerLoads',
      playedSessions: 'playbackStarts',
      plays: 'playbackStarts',
      avgProgressPercent: 'averageTimelineReachPercent',
      completions: 'completedPlaybacks'
    },
    ...periodCharts
  }
}

export async function getVideoPlaybackViewers(input = {}) {
  const dateFilters = await resolvePlaybackDateFilters(input)
  const hourly = boolValue(input.hourly)
  const assetId = cleanString(input.assetId || input.mediaAssetId, 160)
  const streamVideoId = cleanString(input.streamVideoId, 160)
  const siteId = cleanString(input.siteId, 120)
  const limit = Math.min(250, Math.max(1, Number(input.limit || 100)))
  const offset = Math.max(0, Number(input.offset || 0))
  const scope = buildVideoEventScope({
    assetIds: assetId ? [assetId] : [],
    siteIds: siteId ? [siteId] : [],
    streamVideoId
  })
  const ledger = buildVideoLedgerCte(scope, dateFilters)
  const aggregateSelect = buildLedgerAggregateSelect()
  const startPeriodExpression = buildLedgerPeriodExpression(
    'first_play_at',
    hourly,
    dateFilters.appliedTimezone,
    dateFilters
  )
  const watchPeriodExpression = buildLedgerPeriodExpression(
    'event_at',
    hourly,
    dateFilters.appliedTimezone,
    dateFilters
  )
  const thresholdValues = Array.from({ length: 20 }, (_, index) => (
    `(${index}, ${index * 5}, ${(index + 1) * 5})`
  )).join(', ')

  const [
    summaryRow,
    startChartRows,
    watchChartRows,
    viewerRows,
    pageRows,
    blockRows,
    reachRows
  ] = await Promise.all([
    db.get(`
      ${ledger.sql}
      SELECT ${aggregateSelect}
      FROM playbacks
    `, ledger.params),
    db.all(`
      ${ledger.sql}
      SELECT ${startPeriodExpression} AS period_key, COUNT(*) AS plays
      FROM playbacks
      WHERE play_in_range = 1
      GROUP BY ${startPeriodExpression}
      ORDER BY period_key ASC
    `, ledger.params),
    db.all(`
      ${ledger.sql}
      SELECT ${watchPeriodExpression} AS period_key,
             COALESCE(SUM(accepted_delta), 0) AS watched_seconds
      FROM scoped_events
      WHERE in_range = 1
      GROUP BY ${watchPeriodExpression}
      ORDER BY period_key ASC
    `, ledger.params),
    db.all(`
      ${ledger.sql},
      viewer_playbacks AS (
        SELECT
          playbacks.*,
          ROW_NUMBER() OVER (
            PARTITION BY identity_key
            ORDER BY last_event_at DESC, playback_id DESC
          ) AS viewer_context_rank
        FROM playbacks
        WHERE play_in_range = 1
          AND identity_key IS NOT NULL
      ),
      viewer_rollup AS (
        SELECT
          identity_key,
          MAX(contact_id) AS contact_id,
          MAX(visitor_id) AS visitor_id,
          COUNT(*) AS playback_count,
          COALESCE(SUM(range_play_actions), 0) AS play_count,
          COALESCE(SUM(range_watched_seconds), 0) AS watched_seconds,
          COALESCE(MAX(range_max_reach_percent), 0) AS max_progress_percent,
          COALESCE(MAX(range_max_position_seconds), 0) AS max_position_seconds,
          COALESCE(MAX(range_duration_seconds), 0) AS duration_seconds,
          COALESCE(MAX(CASE
            WHEN first_ended_in_range_at IS NOT NULL
             AND first_ended_in_range_at >= first_play_at
            THEN 1 ELSE 0
          END), 0) AS completed,
          MIN(first_play_at) AS first_event_at,
          MAX(last_event_at) AS last_event_at,
          MAX(CASE WHEN viewer_context_rank = 1 THEN page_url ELSE NULL END) AS page_url,
          MAX(CASE WHEN viewer_context_rank = 1 THEN public_page_id ELSE NULL END) AS public_page_id,
          MAX(CASE WHEN viewer_context_rank = 1 THEN block_id ELSE NULL END) AS block_id
        FROM viewer_playbacks
        GROUP BY identity_key
      )
      SELECT
        viewer_rollup.*,
        c.full_name AS contact_full_name,
        c.email AS contact_email,
        c.phone AS contact_phone
      FROM viewer_rollup
      LEFT JOIN contacts c ON c.id = viewer_rollup.contact_id
      ORDER BY viewer_rollup.last_event_at DESC, viewer_rollup.identity_key ASC
      LIMIT ? OFFSET ?
    `, [...ledger.params, limit, offset]),
    db.all(`
      ${ledger.sql}
      SELECT
        COALESCE(NULLIF(public_page_id, ''), NULLIF(page_url, ''), 'unknown') AS key,
        COALESCE(NULLIF(page_url, ''), NULLIF(public_page_id, ''), 'Página desconocida') AS label,
        COUNT(*) AS playback_sessions,
        COALESCE(SUM(range_play_actions), 0) AS plays,
        COALESCE(SUM(range_watched_seconds), 0) AS watched_seconds,
        COALESCE(AVG(range_max_reach_percent), 0) AS avg_progress_percent
      FROM playbacks
      WHERE play_in_range = 1
      GROUP BY
        COALESCE(NULLIF(public_page_id, ''), NULLIF(page_url, ''), 'unknown'),
        COALESCE(NULLIF(page_url, ''), NULLIF(public_page_id, ''), 'Página desconocida')
    `, ledger.params),
    db.all(`
      ${ledger.sql}
      SELECT
        COALESCE(NULLIF(playbacks.block_id, ''), 'unknown') AS key,
        COALESCE(NULLIF(playbacks.block_id, ''), 'Bloque desconocido') AS label,
        COUNT(*) AS playback_sessions,
        COALESCE(SUM(range_play_actions), 0) AS plays,
        COALESCE(SUM(range_watched_seconds), 0) AS watched_seconds,
        COALESCE(AVG(range_max_reach_percent), 0) AS avg_progress_percent
      FROM playbacks
      WHERE play_in_range = 1
      GROUP BY
        COALESCE(NULLIF(playbacks.block_id, ''), 'unknown'),
        COALESCE(NULLIF(playbacks.block_id, ''), 'Bloque desconocido')
    `, ledger.params),
    db.all(`
      ${ledger.sql},
      thresholds(segment, start_percent, end_percent) AS (
        VALUES ${thresholdValues}
      )
      SELECT
        thresholds.segment,
        thresholds.start_percent,
        thresholds.end_percent,
        COUNT(playbacks.playback_id) AS eligible_playbacks,
        COALESCE(SUM(CASE
          WHEN playbacks.range_max_reach_percent >= thresholds.start_percent THEN 1
          ELSE 0
        END), 0) AS reached_playbacks,
        COALESCE(MAX(playbacks.range_duration_seconds), 0) AS duration_seconds
      FROM thresholds
      LEFT JOIN playbacks ON playbacks.play_in_range = 1
      GROUP BY thresholds.segment, thresholds.start_percent, thresholds.end_percent
      ORDER BY thresholds.segment ASC
    `, ledger.params)
  ])

  const chartByPeriod = new Map()
  for (const row of startChartRows) {
    chartByPeriod.set(row.period_key, {
      period_key: row.period_key,
      plays: Number(row.plays || 0),
      watched_seconds: 0
    })
  }
  for (const row of watchChartRows) {
    const current = chartByPeriod.get(row.period_key) || {
      period_key: row.period_key,
      plays: 0,
      watched_seconds: 0
    }
    current.watched_seconds = Number(row.watched_seconds || 0)
    chartByPeriod.set(row.period_key, current)
  }
  const periodCharts = buildPlaybackPeriodCharts([...chartByPeriod.values()], {
    hourly,
    rawDateFrom: input.dateFrom || input.date_from,
    rawDateTo: input.dateTo || input.date_to,
    dateFrom: dateFilters.dateFrom,
    dateTo: dateFilters.dateTo
  })

  const summary = playbackSummaryFromLedgerRow(summaryRow)
  const quality = videoLedgerQualityFromRow(summaryRow)
  const breakdownFromRows = rows => rows
    .map(row => ({
      key: cleanString(row.key, 500) || 'unknown',
      label: cleanString(row.label, 500) || 'Desconocido',
      playbackSessions: Number(row.playback_sessions || 0),
      plays: Number(row.plays || 0),
      watchedSeconds: Number(row.watched_seconds || 0),
      avgProgressPercent: roundMetric(row.avg_progress_percent || 0)
    }))
    .sort((left, right) => (
      right.plays - left.plays ||
      right.playbackSessions - left.playbackSessions ||
      right.watchedSeconds - left.watchedSeconds ||
      left.key.localeCompare(right.key)
    ))
    .slice(0, 8)
  const timelineReachCurve = reachRows.map(row => {
    const eligiblePlaybacks = Number(row.eligible_playbacks || 0)
    const reachedPlaybacks = Number(row.reached_playbacks || 0)
    const durationSeconds = Number(row.duration_seconds || 0)
    const startPercent = Number(row.start_percent || 0)
    const endPercent = Number(row.end_percent || 0)
    return {
      kind: 'timeline_reach',
      segment: Number(row.segment || 0),
      startPercent,
      endPercent,
      startSeconds: roundMetric((durationSeconds * startPercent) / 100),
      endSeconds: roundMetric((durationSeconds * endPercent) / 100),
      label: `${Math.round(startPercent)}-${Math.round(endPercent)}%`,
      eligiblePlaybacks,
      reachedPlaybacks,
      reachPercent: eligiblePlaybacks > 0
        ? roundMetric((reachedPlaybacks / eligiblePlaybacks) * 100)
        : 0
    }
  })

  return {
    schemaVersion: 2,
    meta: {
      source: 'first_party',
      status: quality.status,
      timezone: dateFilters.appliedTimezone || '',
      startUtc: dateFilters.dateFrom || '',
      endUtc: dateFilters.dateTo || '',
      asOf: new Date().toISOString(),
      warnings: quality.warnings,
      quality
    },
    quality,
    summary,
    series: {
      playbackStarts: periodCharts.viewsChart,
      watchedSeconds: periodCharts.watchTimeChart
    },
    ...periodCharts,
    timelineReachCurve,
    heatmap: null,
    retentionSegments: [],
    pages: breakdownFromRows(pageRows),
    blocks: breakdownFromRows(blockRows),
    viewers: viewerRows.map(row => ({
      key: row.identity_key,
      contactId: row.contact_id || null,
      visitorId: row.visitor_id || null,
      contactName: row.contact_full_name || null,
      contactEmail: row.contact_email || null,
      contactPhone: row.contact_phone || null,
      matchMethod: row.contact_id ? 'contact' : 'anonymous',
      playbackCount: Number(row.playback_count || 0),
      playCount: Number(row.play_count || 0),
      watchedSeconds: Number(row.watched_seconds || 0),
      maxProgressPercent: roundMetric(row.max_progress_percent || 0),
      maxPositionSeconds: Number(row.max_position_seconds || 0),
      durationSeconds: Number(row.duration_seconds || 0),
      completed: Number(row.completed || 0) === 1,
      firstEventAt: row.first_event_at || null,
      lastEventAt: row.last_event_at || null,
      pageUrl: row.page_url || null,
      publicPageTitle: row.public_page_id || null,
      blockLabel: row.block_id || null
    })),
    deprecatedAliases: {
      playbackSessions: 'playerLoads',
      playedSessions: 'playbackStarts',
      plays: 'playbackStarts',
      avgProgressPercent: 'averageTimelineReachPercent',
      completions: 'completedPlaybacks'
    },
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
