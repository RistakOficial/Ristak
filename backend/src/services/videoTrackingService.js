import crypto from 'crypto'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { resolveDateRangeWithGHLTimezone } from '../utils/dateUtils.js'

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

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clampNumber(value, min, max) {
  const number = numberOrNull(value)
  if (number === null) return null
  return Math.min(max, Math.max(min, number))
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
    position,
    duration,
    progressPercent,
    watchedDelta: clampNumber(data.watched_delta_seconds ?? data.watchedDeltaSeconds, 0, 30) || 0,
    payloadJson: parseJsonPayload(data)
  }
}

async function resolveContactForPlayback(tx, contactId, visitorId) {
  const directContactId = cleanString(contactId, 160)
  if (directContactId) {
    const contact = await tx.get('SELECT id, full_name, email FROM contacts WHERE id = ?', [directContactId])
    if (contact) {
      return {
        id: contact.id,
        fullName: contact.full_name || null,
        email: contact.email || null,
        matchMethod: 'direct_contact_id'
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
        matchMethod: 'visitor_id_contact'
      }
    }
  }

  return { id: null, fullName: null, email: null, matchMethod: 'anonymous' }
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
        first_event_at,
        started_at,
        last_event_at,
        ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    matchMethod
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
    const contact = await resolveContactForPlayback(tx, body.contactId, body.visitorId)
    const summary = await upsertPlaybackSession(tx, body, video, contact, requestInfo, eventAt)
    await insertPlaybackEvent(tx, body, video, contact, eventAt)
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
    dateTo: range.endUtc
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

export async function getVideoPlaybackViewers(input = {}) {
  const dateFilters = await resolvePlaybackDateFilters(input)
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
      COUNT(DISTINCT contact_id) as identified_contacts,
      COUNT(DISTINCT CASE WHEN contact_id IS NULL OR contact_id = '' THEN visitor_id ELSE NULL END) as anonymous_visitors,
      COALESCE(SUM(play_count), 0) as plays,
      COALESCE(SUM(watched_seconds), 0) as watched_seconds,
      COALESCE(AVG(max_progress_percent), 0) as avg_progress_percent,
      COALESCE(SUM(CASE WHEN ended = 1 OR max_progress_percent >= 99 THEN 1 ELSE 0 END), 0) as completions
    FROM video_playback_sessions vps
    ${where}
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

  return {
    summary: {
      playbackSessions: Number(summary?.playback_sessions || 0),
      identifiedContacts: Number(summary?.identified_contacts || 0),
      anonymousVisitors: Number(summary?.anonymous_visitors || 0),
      plays: Number(summary?.plays || 0),
      watchedSeconds: Number(summary?.watched_seconds || 0),
      avgProgressPercent: Number(summary?.avg_progress_percent || 0),
      completions: Number(summary?.completions || 0)
    },
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
