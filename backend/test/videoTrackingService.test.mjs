import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import {
  getVideoPlaybackAggregate,
  getVideoPlaybackViewers,
  linkVideoVisitorToContact,
  recordVideoPlaybackEvent
} from '../src/services/videoTrackingService.js'

test('video playback tracking links anonymous playback to contact after registration', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const visitorId = `visitor_video_${suffix}`
  const sessionId = `session_video_${suffix}`
  const playbackId = `playback_video_${suffix}`
  const contactId = `contact_video_${suffix}`
  const assetId = `asset_video_${suffix}`
  const streamVideoId = `stream_video_${suffix}`

  try {
    await recordVideoPlaybackEvent({
      visitor_id: visitorId,
      session_id: sessionId,
      event_name: 'video_play',
      ts: Date.now(),
      data: {
        event_id: `${playbackId}:play`,
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
      ts: Date.now() + 5000,
      data: {
        event_id: `${playbackId}:progress:40`,
        playback_id: playbackId,
        media_asset_id: assetId,
        stream_library_id: '123456',
        stream_video_id: streamVideoId,
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
    assert.equal(Math.round(viewers.summary.dropOffPercent), 58)
    assert.equal(viewers.viewsChart.reduce((total, point) => total + Number(point.value || 0), 0), 1)
    assert.equal(viewers.watchTimeChart.reduce((total, point) => total + Number(point.value || 0), 0), 8)
    assert.ok(Array.isArray(viewers.retentionSegments))
    assert.equal(viewers.retentionSegments.length, 24)
    assert.equal(viewers.retentionSegments[0].retainedSessions, 1)
    assert.ok(viewers.retentionSegments.some(segment => segment.retentionPercent === 0))
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
  const baseTs = Date.UTC(2026, 0, 15, 18, 0, 0)

  async function recordPlayback({ playbackId, assetId, position, watchedDelta, offsetMs }) {
    await recordVideoPlaybackEvent({
      visitor_id: visitorId,
      session_id: `${sessionId}_${playbackId}`,
      event_name: 'video_play',
      ts: baseTs + offsetMs,
      data: {
        event_id: `${playbackId}:play`,
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
        playback_id: playbackId,
        media_asset_id: assetId,
        stream_video_id: `stream_${assetId}`,
        site_id: siteId,
        page_id: 'page_aggregate',
        block_id: `block_${assetId}`,
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
      dateFrom: '2026-01-15',
      dateTo: '2026-01-15'
    })

    assert.equal(aggregate.summary.playbackSessions, 2)
    assert.equal(aggregate.summary.playedSessions, 2)
    assert.equal(aggregate.summary.totalViewers, 1)
    assert.equal(aggregate.summary.plays, 2)
    assert.equal(aggregate.summary.watchedSeconds, 30)
    assert.equal(aggregate.summary.averageWatchSeconds, 15)
    assert.equal(Math.round(aggregate.summary.avgProgressPercent), 38)
    assert.equal(aggregate.byAssetId[assetA].plays, 1)
    assert.equal(aggregate.byAssetId[assetA].watchedSeconds, 10)
    assert.equal(aggregate.byAssetId[assetB].plays, 1)
    assert.equal(aggregate.byAssetId[assetB].watchedSeconds, 20)
    assert.equal(aggregate.bySiteId[siteId].plays, 2)

    const viewers = await getVideoPlaybackViewers({
      assetId: assetA,
      dateFrom: '2026-01-15',
      dateTo: '2026-01-16',
      limit: 10
    })
    assert.deepEqual(viewers.viewsChart.map(point => point.periodKey), ['2026-01-15', '2026-01-16'])
    assert.equal(viewers.viewsChart[0].value, 1)
    assert.equal(viewers.viewsChart[1].value, 0)
    assert.equal(viewers.watchTimeChart[0].value, 10)
    assert.equal(viewers.watchTimeChart[1].value, 0)

    const filtered = await getVideoPlaybackAggregate({
      assetIds: [assetA],
      dateFrom: '2026-01-15',
      dateTo: '2026-01-15'
    })
    assert.equal(filtered.summary.playbackSessions, 1)
    assert.equal(filtered.summary.watchedSeconds, 10)
    assert.equal(filtered.byAssetId[assetB], undefined)
  } finally {
    await db.run('DELETE FROM video_playback_events WHERE playback_id IN (?, ?)', [playbackA, playbackB]).catch(() => undefined)
    await db.run('DELETE FROM video_playback_sessions WHERE playback_id IN (?, ?)', [playbackA, playbackB]).catch(() => undefined)
  }
})
