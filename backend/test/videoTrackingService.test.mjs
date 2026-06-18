import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import {
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
    assert.equal(viewers.summary.identifiedContacts, 1)
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
