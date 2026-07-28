import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { db } from '../src/config/database.js'
import { businessTodayDateOnly, DEFAULT_TIMEZONE } from '../src/utils/dateUtils.js'
import {
  getVideoPlaybackAggregate,
  getVideoPlaybackViewers,
  linkVideoVisitorToContact,
  recordVideoPlaybackEvent
} from '../src/services/videoTrackingService.js'

test('video detail uses normalized PostgreSQL-compatible block grouping', async () => {
  const source = await readFile(
    new URL('../src/services/videoTrackingService.js', import.meta.url),
    'utf8'
  )
  assert.match(
    source,
    /GROUP BY\s+COALESCE\(NULLIF\(playbacks\.block_id, ''\), 'unknown'\),\s+COALESCE\(NULLIF\(playbacks\.block_id, ''\), 'Bloque desconocido'\)/
  )
})

test('video detail merges null and blank block ids into one unknown breakdown', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const assetId = `asset_video_unknown_block_${suffix}`
  const playbackIds = [
    `playback_video_unknown_block_null_${suffix}`,
    `playback_video_unknown_block_blank_${suffix}`
  ]
  const baseTs = Date.now() - 30_000

  try {
    for (const [index, playbackId] of playbackIds.entries()) {
      const blockId = index === 0 ? undefined : `temporary_block_${suffix}`
      await recordVideoPlaybackEvent({
        visitor_id: `visitor_${playbackId}`,
        session_id: `session_${playbackId}`,
        event_name: 'video_play',
        ts: baseTs + index * 1000,
        data: {
          event_id: `${playbackId}:play`,
          event_sequence: 1,
          ingestion_version: 2,
          playback_id: playbackId,
          media_asset_id: assetId,
          stream_video_id: `stream_${assetId}`,
          block_id: blockId,
          position_seconds: 0,
          duration_seconds: 60
        }
      })
    }
    await db.run(
      "UPDATE video_playback_events SET block_id = '' WHERE playback_id = ?",
      [playbackIds[1]]
    )

    const detail = await getVideoPlaybackViewers({ assetId, limit: 10 })

    assert.equal(detail.blocks.length, 1)
    assert.equal(detail.blocks[0].key, 'unknown')
    assert.equal(detail.blocks[0].label, 'Bloque desconocido')
    assert.equal(detail.blocks[0].playbackSessions, 2)
    assert.equal(detail.blocks[0].plays, 2)
  } finally {
    for (const playbackId of playbackIds) {
      await db.run('DELETE FROM video_playback_events WHERE playback_id = ?', [playbackId]).catch(() => undefined)
      await db.run('DELETE FROM video_playback_sessions WHERE playback_id = ?', [playbackId]).catch(() => undefined)
    }
  }
})

test('video playback tracking links anonymous playback to contact after registration', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const visitorId = `visitor_video_${suffix}`
  const sessionId = `session_video_${suffix}`
  const playbackId = `playback_video_${suffix}`
  const contactId = `contact_video_${suffix}`
  const assetId = `asset_video_${suffix}`
  const streamVideoId = `stream_video_${suffix}`
  const baseTs = Date.now()

  try {
    await recordVideoPlaybackEvent({
      visitor_id: visitorId,
      session_id: sessionId,
      event_name: 'video_ready',
      ts: baseTs,
      data: {
        event_id: `${playbackId}:ready`,
        event_sequence: 1,
        ingestion_version: 2,
        playback_id: playbackId,
        media_asset_id: assetId,
        stream_library_id: '123456',
        stream_video_id: streamVideoId,
        video_provider: 'bunny_stream',
        video_title: 'Oferta principal',
        site_id: 'site_video_tracking',
        page_id: 'page_1',
        block_id: 'video_block',
        position_seconds: 0,
        duration_seconds: 100
      }
    })

    await recordVideoPlaybackEvent({
      visitor_id: visitorId,
      session_id: sessionId,
      event_name: 'video_play',
      ts: baseTs + 1000,
      data: {
        event_id: `${playbackId}:play`,
        event_sequence: 2,
        ingestion_version: 2,
        playback_id: playbackId,
        media_asset_id: assetId,
        stream_library_id: '123456',
        stream_video_id: streamVideoId,
        video_provider: 'bunny_stream',
        video_title: 'Oferta principal',
        site_id: 'site_video_tracking',
        page_id: 'page_1',
        block_id: 'video_block',
        position_seconds: 0,
        duration_seconds: 100
      }
    })

    await recordVideoPlaybackEvent({
      visitor_id: visitorId,
      session_id: sessionId,
      event_name: 'video_progress',
      ts: baseTs + 5000,
      data: {
        event_id: `${playbackId}:progress:40`,
        event_sequence: 3,
        ingestion_version: 2,
        playback_id: playbackId,
        media_asset_id: assetId,
        stream_library_id: '123456',
        stream_video_id: streamVideoId,
        site_id: 'site_video_tracking',
        page_id: 'page_1',
        block_id: 'video_block',
        watch_from_seconds: 34,
        watch_to_seconds: 42,
        position_seconds: 42,
        duration_seconds: 100,
        watched_delta_seconds: 8
      }
    })

    let playback = await db.get('SELECT * FROM video_playback_sessions WHERE playback_id = ?', [playbackId])
    assert.equal(playback.contact_id, null)
    assert.equal(playback.visitor_id, visitorId)
    assert.equal(Math.round(Number(playback.max_progress_percent)), 42)
    assert.equal(Number(playback.watched_seconds), 8)

    await db.run(
      'INSERT INTO contacts (id, email, full_name, source) VALUES (?, ?, ?, ?)',
      [contactId, `${contactId}@example.com`, 'Juan Video', 'site_form']
    )

    const linkResult = await linkVideoVisitorToContact(visitorId, contactId, 'Juan Video')
    assert.equal(linkResult.sessionsUpdated, 1)

    playback = await db.get('SELECT * FROM video_playback_sessions WHERE playback_id = ?', [playbackId])
    assert.equal(playback.contact_id, contactId)
    assert.equal(playback.full_name, 'Juan Video')
    assert.equal(playback.match_method, 'visitor_linked_later')

    const viewers = await getVideoPlaybackViewers({ assetId, limit: 10 })
    assert.equal(viewers.summary.playbackSessions, 1)
    assert.equal(viewers.summary.playedSessions, 1)
    assert.equal(viewers.summary.identifiedContacts, 1)
    assert.equal(viewers.summary.totalViewers, 1)
    assert.equal(viewers.summary.playRatePercent, 100)
    assert.equal(Math.round(viewers.summary.avgProgressPercent), 42)
    assert.equal(viewers.summary.dropOffPercent, null)
    assert.equal(viewers.summary.incompleteRatePercent, 100)
    assert.equal(viewers.viewsChart.reduce((total, point) => total + Number(point.value || 0), 0), 1)
    assert.equal(viewers.watchTimeChart.reduce((total, point) => total + Number(point.value || 0), 0), 8)
    assert.ok(Array.isArray(viewers.retentionSegments))
    assert.equal(viewers.retentionSegments.length, 0)
    assert.equal(viewers.heatmap, null)
    assert.equal(viewers.timelineReachCurve.length, 20)
    assert.equal(viewers.quality.status, 'verified')
    assert.equal(viewers.pages[0].label, 'page_1')
    assert.equal(viewers.blocks[0].label, 'video_block')
    assert.equal(viewers.viewers.length, 1)
    assert.equal(viewers.viewers[0].contactId, contactId)
    assert.equal(viewers.viewers[0].contactName, 'Juan Video')
    assert.equal(Math.round(viewers.viewers[0].maxProgressPercent), 42)
  } finally {
    await db.run('DELETE FROM video_playback_events WHERE playback_id = ?', [playbackId]).catch(() => undefined)
    await db.run('DELETE FROM video_playback_sessions WHERE playback_id = ?', [playbackId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('video playback aggregate sums selected assets from first-party tracking', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const visitorId = `visitor_video_aggregate_${suffix}`
  const sessionId = `session_video_aggregate_${suffix}`
  const playbackA = `playback_video_aggregate_a_${suffix}`
  const playbackB = `playback_video_aggregate_b_${suffix}`
  const assetA = `asset_video_aggregate_a_${suffix}`
  const assetB = `asset_video_aggregate_b_${suffix}`
  const siteId = `site_video_aggregate_${suffix}`
  const baseTs = Date.now() - 60_000
  const businessDate = businessTodayDateOnly(DEFAULT_TIMEZONE, new Date(baseTs))

  async function recordPlayback({ playbackId, assetId, position, watchedDelta, offsetMs }) {
    await recordVideoPlaybackEvent({
      visitor_id: visitorId,
      session_id: `${sessionId}_${playbackId}`,
      event_name: 'video_ready',
      ts: baseTs + offsetMs,
      data: {
        event_id: `${playbackId}:ready`,
        event_sequence: 1,
        ingestion_version: 2,
        playback_id: playbackId,
        media_asset_id: assetId,
        stream_video_id: `stream_${assetId}`,
        site_id: siteId,
        page_id: 'page_aggregate',
        block_id: `block_${assetId}`,
        position_seconds: 0,
        duration_seconds: 100
      }
    })

    await recordVideoPlaybackEvent({
      visitor_id: visitorId,
      session_id: `${sessionId}_${playbackId}`,
      event_name: 'video_play',
      ts: baseTs + offsetMs + 1000,
      data: {
        event_id: `${playbackId}:play`,
        event_sequence: 2,
        ingestion_version: 2,
        playback_id: playbackId,
        media_asset_id: assetId,
        stream_video_id: `stream_${assetId}`,
        site_id: siteId,
        page_id: 'page_aggregate',
        block_id: `block_${assetId}`,
        position_seconds: 0,
        duration_seconds: 100
      }
    })

    await recordVideoPlaybackEvent({
      visitor_id: visitorId,
      session_id: `${sessionId}_${playbackId}`,
      event_name: 'video_progress',
      ts: baseTs + offsetMs + 5000,
      data: {
        event_id: `${playbackId}:progress`,
        event_sequence: 3,
        ingestion_version: 2,
        playback_id: playbackId,
        media_asset_id: assetId,
        stream_video_id: `stream_${assetId}`,
        site_id: siteId,
        page_id: 'page_aggregate',
        block_id: `block_${assetId}`,
        watch_from_seconds: Math.max(0, position - watchedDelta),
        watch_to_seconds: position,
        position_seconds: position,
        duration_seconds: 100,
        watched_delta_seconds: watchedDelta
      }
    })
  }

  try {
    await recordPlayback({ playbackId: playbackA, assetId: assetA, position: 25, watchedDelta: 10, offsetMs: 0 })
    await recordPlayback({ playbackId: playbackB, assetId: assetB, position: 50, watchedDelta: 20, offsetMs: 10000 })

    const aggregate = await getVideoPlaybackAggregate({
      assetIds: [assetA, assetB],
      includeSiteBreakdown: true,
      dateFrom: businessDate,
      dateTo: businessDate
    })

    assert.equal(aggregate.summary.playbackSessions, 2)
    assert.equal(aggregate.summary.playedSessions, 2)
    assert.equal(aggregate.summary.totalViewers, 1)
    assert.equal(aggregate.summary.plays, 2)
    assert.equal(aggregate.summary.watchedSeconds, 30)
    assert.equal(aggregate.summary.averageWatchSeconds, 15)
    assert.equal(Math.round(aggregate.summary.avgProgressPercent), 38)
    assert.equal(aggregate.quality.status, 'verified')
    assert.equal(aggregate.byAssetId[assetA].plays, 1)
    assert.equal(aggregate.byAssetId[assetA].watchedSeconds, 10)
    assert.equal(aggregate.byAssetId[assetB].plays, 1)
    assert.equal(aggregate.byAssetId[assetB].watchedSeconds, 20)
    assert.equal(aggregate.bySiteId[siteId].plays, 2)
    assert.deepEqual(aggregate.viewsChart.map(point => point.periodKey), [businessDate])
    assert.equal(aggregate.viewsChart[0].value, 2)
    assert.equal(aggregate.watchTimeChart[0].value, 30)

    const viewers = await getVideoPlaybackViewers({
      assetId: assetA,
      dateFrom: businessDate,
      dateTo: businessDate,
      limit: 10
    })
    assert.deepEqual(viewers.viewsChart.map(point => point.periodKey), [businessDate])
    assert.equal(viewers.viewsChart[0].value, 1)
    assert.equal(viewers.watchTimeChart[0].value, 10)

    const filtered = await getVideoPlaybackAggregate({
      assetIds: [assetA],
      dateFrom: businessDate,
      dateTo: businessDate
    })
    assert.equal(filtered.summary.playbackSessions, 1)
    assert.equal(filtered.summary.watchedSeconds, 10)
    assert.equal(filtered.byAssetId[assetB], undefined)
  } finally {
    await db.run('DELETE FROM video_playback_events WHERE playback_id IN (?, ?)', [playbackA, playbackB]).catch(() => undefined)
    await db.run('DELETE FROM video_playback_sessions WHERE playback_id IN (?, ?)', [playbackA, playbackB]).catch(() => undefined)
  }
})

test('video v2 deduplicates an identical retry before mutating the playback projection', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const playbackId = `playback_video_retry_${suffix}`
  const visitorId = `visitor_video_retry_${suffix}`
  const sessionId = `session_video_retry_${suffix}`
  const assetId = `asset_video_retry_${suffix}`
  const timestamp = Date.UTC(2026, 2, 10, 18, 0, 0)
  const event = {
    visitor_id: visitorId,
    session_id: sessionId,
    event_name: 'video_play',
    ts: timestamp,
    data: {
      event_id: `${playbackId}:event:1`,
      event_sequence: 1,
      ingestion_version: 2,
      playback_id: playbackId,
      media_asset_id: assetId,
      site_id: `site_${suffix}`,
      page_id: 'page_retry',
      block_id: 'block_retry',
      position_seconds: 0,
      duration_seconds: 120
    }
  }

  try {
    const first = await recordVideoPlaybackEvent(event)
    const retry = await recordVideoPlaybackEvent(event)
    assert.equal(first.deduplicated, false)
    assert.equal(retry.deduplicated, true)

    const eventCount = await db.get(
      'SELECT COUNT(*) AS total FROM video_playback_events WHERE playback_id = ?',
      [playbackId]
    )
    const projection = await db.get(
      'SELECT play_count, watched_seconds FROM video_playback_sessions WHERE playback_id = ?',
      [playbackId]
    )
    assert.equal(Number(eventCount.total), 1)
    assert.equal(Number(projection.play_count), 1)
    assert.equal(Number(projection.watched_seconds), 0)

    await assert.rejects(
      recordVideoPlaybackEvent({
        ...event,
        data: {
          ...event.data,
          position_seconds: 12
        }
      }),
      error => error?.status === 409 && error?.code === 'VIDEO_EVENT_CONFLICT'
    )
  } finally {
    await db.run('DELETE FROM video_playback_events WHERE playback_id = ?', [playbackId]).catch(() => undefined)
    await db.run('DELETE FROM video_playback_sessions WHERE playback_id = ?', [playbackId]).catch(() => undefined)
  }
})

test('video ledger counts one start across resume, ended-only completion, and exact accepted watch deltas', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const playbackId = `playback_video_resume_${suffix}`
  const visitorId = `visitor_video_resume_${suffix}`
  const sessionId = `session_video_resume_${suffix}`
  const assetId = `asset_video_resume_${suffix}`
  const siteId = `site_video_resume_${suffix}`
  const baseTs = Date.now() - 60_000
  const businessDate = businessTodayDateOnly(DEFAULT_TIMEZONE, new Date(baseTs))
  const definitions = [
    ['video_ready', 0, 0, null, null],
    ['video_play', 0, 0, null, null],
    ['video_progress', 5, 5, 0, 5],
    ['video_pause', 8, 3, 5, 8],
    ['video_play', 8, 0, null, null],
    ['video_progress', 15, 7, 8, 15],
    ['video_ended', 100, 0, null, null]
  ]

  try {
    for (let index = 0; index < definitions.length; index += 1) {
      const [eventName, position, watchedDelta, watchFrom, watchTo] = definitions[index]
      await recordVideoPlaybackEvent({
        visitor_id: visitorId,
        session_id: sessionId,
        event_name: eventName,
        ts: baseTs + index * 1000,
        data: {
          event_id: `${playbackId}:event:${index + 1}`,
          event_sequence: index + 1,
          ingestion_version: 2,
          playback_id: playbackId,
          media_asset_id: assetId,
          site_id: siteId,
          page_id: 'page_resume',
          block_id: 'block_resume',
          position_seconds: position,
          duration_seconds: 100,
          watched_delta_seconds: watchedDelta,
          watch_from_seconds: watchFrom,
          watch_to_seconds: watchTo
        }
      })
    }

    const aggregate = await getVideoPlaybackAggregate({
      assetIds: [assetId],
      dateFrom: businessDate,
      dateTo: businessDate
    })
    assert.equal(aggregate.summary.playerLoads, 1)
    assert.equal(aggregate.summary.playbackStarts, 1)
    assert.equal(aggregate.summary.playActions, 2)
    assert.equal(aggregate.summary.watchedSeconds, 15)
    assert.equal(aggregate.summary.completedPlaybacks, 1)
    assert.equal(aggregate.summary.completionRatePercent, 100)
    assert.equal(aggregate.summary.incompletePlaybacks, 0)
    assert.equal(aggregate.summary.averageTimelineReachPercent, 100)
    assert.equal(aggregate.quality.status, 'verified')

    const detail = await getVideoPlaybackViewers({
      assetId,
      dateFrom: businessDate,
      dateTo: businessDate,
      limit: 10
    })
    assert.equal(detail.viewers.length, 1)
    assert.equal(detail.viewers[0].playCount, 2)
    assert.equal(detail.viewers[0].watchedSeconds, 15)
    assert.equal(detail.viewers[0].completed, true)
    assert.equal(detail.timelineReachCurve.at(-1).reachPercent, 100)
    assert.deepEqual(detail.retentionSegments, [])
    assert.equal(detail.heatmap, null)
  } finally {
    await db.run('DELETE FROM video_playback_events WHERE playback_id = ?', [playbackId]).catch(() => undefined)
    await db.run('DELETE FROM video_playback_sessions WHERE playback_id = ?', [playbackId]).catch(() => undefined)
  }
})

test('video v2 clamps clock skew, preserves client_event_at, and rejects an invalid timestamp', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const playbackId = `playback_video_clock_${suffix}`
  const futureTimestamp = Date.now() + 24 * 60 * 60 * 1000
  const event = {
    visitor_id: `visitor_video_clock_${suffix}`,
    session_id: `session_video_clock_${suffix}`,
    event_name: 'video_play',
    ts: futureTimestamp,
    data: {
      event_id: `${playbackId}:event:1`,
      event_sequence: 1,
      ingestion_version: 2,
      playback_id: playbackId,
      media_asset_id: `asset_video_clock_${suffix}`,
      site_id: `site_video_clock_${suffix}`,
      page_id: 'page_clock',
      block_id: 'block_clock',
      duration_seconds: 60
    }
  }

  try {
    const before = Date.now()
    const first = await recordVideoPlaybackEvent(event)
    const retry = await recordVideoPlaybackEvent(event)
    const after = Date.now()
    assert.equal(first.deduplicated, false)
    assert.equal(retry.deduplicated, true)

    const stored = await db.get(`
      SELECT client_event_at, event_at, event_time_quality
      FROM video_playback_events
      WHERE playback_id = ?
    `, [playbackId])
    assert.equal(new Date(stored.client_event_at).toISOString(), new Date(futureTimestamp).toISOString())
    assert.ok(new Date(stored.event_at).getTime() >= before)
    assert.ok(new Date(stored.event_at).getTime() <= after)
    assert.equal(stored.event_time_quality, 'client_adjusted')

    await assert.rejects(
      recordVideoPlaybackEvent({
        ...event,
        ts: 'definitivamente-no-es-fecha',
        data: {
          ...event.data,
          event_id: `${playbackId}:event:2`,
          event_sequence: 2
        }
      }),
      error => error?.status === 400 && /timestamp/i.test(error.message)
    )
  } finally {
    await db.run('DELETE FROM video_playback_events WHERE playback_id = ?', [playbackId]).catch(() => undefined)
    await db.run('DELETE FROM video_playback_sessions WHERE playback_id = ?', [playbackId]).catch(() => undefined)
  }
})

test('video ledger distinguishes legacy-only data from a mixed migration window', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const assetId = `asset_video_legacy_${suffix}`
  const legacyPlaybackId = `playback_video_legacy_${suffix}`
  const verifiedPlaybackId = `playback_video_verified_${suffix}`
  const baseTs = Date.now() - 10_000

  try {
    await recordVideoPlaybackEvent({
      visitor_id: `visitor_video_legacy_${suffix}`,
      session_id: `session_video_legacy_${suffix}`,
      event_name: 'video_play',
      ts: baseTs,
      data: {
        playback_id: legacyPlaybackId,
        media_asset_id: assetId,
        position_seconds: 0,
        duration_seconds: 60
      }
    })

    const legacyOnly = await getVideoPlaybackAggregate({ assetIds: [assetId] })
    assert.equal(legacyOnly.quality.status, 'legacy_only')
    assert.equal(legacyOnly.quality.totalEvents, 1)
    assert.equal(legacyOnly.quality.legacyEvents, 1)
    assert.equal(legacyOnly.quality.verifiedEvents, 0)

    await recordVideoPlaybackEvent({
      visitor_id: `visitor_video_verified_${suffix}`,
      session_id: `session_video_verified_${suffix}`,
      event_name: 'video_play',
      ts: baseTs + 1000,
      data: {
        event_id: `${verifiedPlaybackId}:1`,
        event_sequence: 1,
        ingestion_version: 2,
        playback_id: verifiedPlaybackId,
        media_asset_id: assetId,
        position_seconds: 0,
        duration_seconds: 60
      }
    })

    const mixed = await getVideoPlaybackAggregate({ assetIds: [assetId] })
    assert.equal(mixed.quality.status, 'mixed_legacy')
    assert.equal(mixed.quality.totalEvents, 2)
    assert.equal(mixed.quality.legacyEvents, 1)
    assert.equal(mixed.quality.verifiedEvents, 1)
  } finally {
    await db.run(
      'DELETE FROM video_playback_events WHERE playback_id IN (?, ?)',
      [legacyPlaybackId, verifiedPlaybackId]
    ).catch(() => undefined)
    await db.run(
      'DELETE FROM video_playback_sessions WHERE playback_id IN (?, ?)',
      [legacyPlaybackId, verifiedPlaybackId]
    ).catch(() => undefined)
  }
})

test('video scopes honor the exact site, exclude calendar forms, label assets, and show the latest viewer context', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const assetId = `asset_video_scope_${suffix}`
  const visitorId = `visitor_video_scope_${suffix}`
  const webSiteA = `site_video_web_a_${suffix}`
  const webSiteB = `site_video_web_b_${suffix}`
  const formSite = `site_video_form_${suffix}`
  const calendarFormSite = `site_video_calendar_form_${suffix}`
  const siteRows = [
    [webSiteA, 'Web A', `${webSiteA}-slug`, 'landing_page', JSON.stringify({ pageMode: 'website' })],
    [webSiteB, 'Web B', `${webSiteB}-slug`, 'landing_page', JSON.stringify({ pageMode: 'website' })],
    [formSite, 'Formulario', `${formSite}-slug`, 'standard_form', '{}'],
    [calendarFormSite, 'Formulario de calendario', `${calendarFormSite}-slug`, 'standard_form', JSON.stringify({ librarySource: 'calendar' })]
  ]
  const playbackIds = []
  const baseTs = Date.now() - 30_000

  async function recordPlayback({ suffix: playbackSuffix, siteId, pageUrl, visitor, timestamp }) {
    const playbackId = `playback_video_scope_${playbackSuffix}_${suffix}`
    playbackIds.push(playbackId)
    for (const [index, eventName] of ['video_ready', 'video_play'].entries()) {
      await recordVideoPlaybackEvent({
        visitor_id: visitor,
        session_id: `session_${playbackId}`,
        event_name: eventName,
        ts: timestamp + index * 1000,
        data: {
          event_id: `${playbackId}:${index + 1}`,
          event_sequence: index + 1,
          ingestion_version: 2,
          playback_id: playbackId,
          media_asset_id: assetId,
          stream_video_id: `stream_${assetId}`,
          site_id: siteId,
          public_page_id: `page_${playbackSuffix}`,
          block_id: `block_${playbackSuffix}`,
          url: pageUrl,
          position_seconds: 0,
          duration_seconds: 60
        }
      })
    }
  }

  try {
    for (const row of siteRows) {
      await db.run(
        `INSERT INTO public_sites (id, name, slug, site_type, status, theme_json)
         VALUES (?, ?, ?, ?, 'published', ?)`,
        row
      )
    }
    await db.run(
      `INSERT INTO media_assets (
        id, business_id, original_filename, media_type, status, stream_video_id
      ) VALUES (?, 'default', 'Oferta premium.mp4', 'video', 'ready', ?)`,
      [assetId, `stream_${assetId}`]
    )

    await recordPlayback({
      suffix: 'old',
      siteId: webSiteA,
      pageUrl: 'https://example.test/z-old',
      visitor: visitorId,
      timestamp: baseTs
    })
    await recordPlayback({
      suffix: 'new',
      siteId: webSiteB,
      pageUrl: 'https://example.test/a-new',
      visitor: visitorId,
      timestamp: baseTs + 10_000
    })
    await recordPlayback({
      suffix: 'form',
      siteId: formSite,
      pageUrl: 'https://example.test/form',
      visitor: `visitor_form_${suffix}`,
      timestamp: baseTs + 15_000
    })
    await recordPlayback({
      suffix: 'calendar',
      siteId: calendarFormSite,
      pageUrl: 'https://example.test/calendar',
      visitor: `visitor_calendar_${suffix}`,
      timestamp: baseTs + 20_000
    })

    const allWebsites = await getVideoPlaybackAggregate({
      siteScope: { siteType: 'sites', landingMode: 'website' },
      breakdownAssetIds: [assetId]
    })
    assert.equal(allWebsites.summary.playbackStarts, 2)
    assert.equal(allWebsites.topAssetsByStarts[0].assetName, 'Oferta premium.mp4')
    assert.equal(allWebsites.topAssetsByStarts[0].assetTitle, 'Oferta premium.mp4')

    const exactWebsite = await getVideoPlaybackAggregate({
      siteScope: {
        siteType: 'sites',
        landingMode: 'website',
        siteId: webSiteA
      },
      breakdownAssetIds: [assetId]
    })
    assert.equal(exactWebsite.summary.playbackStarts, 1)

    const forms = await getVideoPlaybackAggregate({
      siteScope: { siteType: 'forms' },
      breakdownAssetIds: [assetId]
    })
    assert.equal(forms.summary.playbackStarts, 1)

    const allPublishedVideos = await getVideoPlaybackAggregate({
      siteScope: { siteType: 'videos' },
      breakdownAssetIds: [assetId]
    })
    assert.equal(allPublishedVideos.summary.playbackStarts, 3)

    const details = await getVideoPlaybackViewers({ assetId, limit: 20 })
    const websiteViewer = details.viewers.find(viewer => viewer.visitorId === visitorId)
    assert.equal(websiteViewer?.pageUrl, 'https://example.test/a-new')
    assert.equal(websiteViewer?.blockLabel, 'block_new')

    const exactWebsiteDetails = await getVideoPlaybackViewers({
      assetId,
      siteId: webSiteA,
      limit: 20
    })
    assert.equal(exactWebsiteDetails.summary.playbackStarts, 1)
    assert.equal(exactWebsiteDetails.viewers.length, 1)
    assert.equal(exactWebsiteDetails.viewers[0]?.pageUrl, 'https://example.test/z-old')
    assert.equal(exactWebsiteDetails.viewers[0]?.blockLabel, 'block_old')
  } finally {
    const placeholders = playbackIds.map(() => '?').join(',')
    if (playbackIds.length) {
      await db.run(
        `DELETE FROM video_playback_events WHERE playback_id IN (${placeholders})`,
        playbackIds
      ).catch(() => undefined)
      await db.run(
        `DELETE FROM video_playback_sessions WHERE playback_id IN (${placeholders})`,
        playbackIds
      ).catch(() => undefined)
    }
    await db.run('DELETE FROM media_assets WHERE id = ?', [assetId]).catch(() => undefined)
    await db.run(
      'DELETE FROM public_sites WHERE id IN (?, ?, ?, ?)',
      [webSiteA, webSiteB, formSite, calendarFormSite]
    ).catch(() => undefined)
  }
})

test('video analytics rejects incomplete, invalid, and reversed calendar ranges', async () => {
  for (const range of [
    { dateFrom: '2026-02-30', dateTo: '2026-03-01' },
    { dateFrom: '2026-03-20T00:00:00Z', dateTo: '2026-03-20' },
    { dateFrom: '2026-03-21', dateTo: '2026-03-20' },
    { dateFrom: '2026-03-20' }
  ]) {
    await assert.rejects(
      () => getVideoPlaybackAggregate(range),
      error => error?.status === 400 && /fecha|dateFrom/i.test(error.message)
    )
  }

  await assert.rejects(
    () => getVideoPlaybackViewers({
      assetId: 'asset_missing',
      dateTo: '2026-03-20'
    }),
    error => error?.status === 400 && /dateFrom y dateTo/i.test(error.message)
  )
})
