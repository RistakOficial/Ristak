import assert from 'node:assert/strict'
import test from 'node:test'

import { db } from '../src/config/database.js'
import { replaceSiteVideo } from '../src/services/siteVideoReplacementService.js'
import { transitionSiteVideoPlacement } from '../src/services/siteVideoPlacementService.js'
import { listSitesVideoAssets } from '../src/services/sitesService.js'
import {
  getVideoPlaybackViewers,
  recordVideoPlaybackEvent
} from '../src/services/videoTrackingService.js'

function uniqueSuffix() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`
}

async function insertVideoAsset(id, url, filename) {
  await db.run(`
    INSERT INTO media_assets (
      id, business_id, original_filename, stored_filename, bunny_path, public_url,
      mime_type, media_type, extension, size_original, size_processed, quota_size,
      duration, status, storage_provider, module, is_public, metadata_json
    ) VALUES (?, 'default', ?, ?, ?, ?, 'video/mp4', 'video', 'mp4',
      100, 100, 100, 60, 'ready', 'bunny', 'sites', 1, '{}')
  `, [id, filename, filename, `accounts/default/sites/${filename}`, url])
}

async function recordPlay({ playbackId, assetId, siteId, blockId, timestamp }) {
  await recordVideoPlaybackEvent({
    visitor_id: `visitor_${playbackId}`,
    session_id: `session_${playbackId}`,
    event_name: 'video_play',
    ts: timestamp,
    data: {
      event_id: `${playbackId}:play`,
      event_sequence: 1,
      ingestion_version: 2,
      playback_id: playbackId,
      media_asset_id: assetId,
      site_id: siteId,
      block_id: blockId,
      duration_seconds: 60
    }
  })
}

async function makeFixture() {
  const suffix = uniqueSuffix()
  const siteId = `site_video_replacement_${suffix}`
  const blockId = `block_video_replacement_${suffix}`
  const oldAssetId = `asset_video_old_${suffix}`
  const newAssetId = `asset_video_new_${suffix}`
  const oldUrl = `https://media.example.test/${oldAssetId}.mp4`
  const newUrl = `https://media.example.test/${newAssetId}.mp4`

  await db.run(`
    INSERT INTO public_sites (id, name, slug, site_type, status, theme_json)
    VALUES (?, 'Site para reemplazo', ?, 'landing_page', 'published', '{}')
  `, [siteId, `${siteId}-slug`])
  await insertVideoAsset(oldAssetId, oldUrl, `${oldAssetId}.mp4`)
  await insertVideoAsset(newAssetId, newUrl, `${newAssetId}.mp4`)
  await db.run(`
    INSERT INTO public_site_blocks (
      id, site_id, block_type, label, content, settings_json, sort_order
    ) VALUES (?, ?, 'video', 'Video principal', '', ?, 0)
  `, [blockId, siteId, JSON.stringify({ mediaUrl: oldUrl, mediaAssetId: oldAssetId })])
  const initialBlock = await db.get(
    'SELECT * FROM public_site_blocks WHERE id = ? AND site_id = ?',
    [blockId, siteId]
  )
  await transitionSiteVideoPlacement({ siteId, nextBlock: initialBlock })

  return { siteId, blockId, oldAssetId, newAssetId, oldUrl, newUrl }
}

async function cleanupFixture(fixture, playbackIds) {
  for (const playbackId of playbackIds) {
    await db.run('DELETE FROM video_playback_events WHERE playback_id = ?', [playbackId]).catch(() => undefined)
    await db.run('DELETE FROM video_playback_sessions WHERE playback_id = ?', [playbackId]).catch(() => undefined)
  }
  await db.run('DELETE FROM site_video_replacements WHERE site_id = ?', [fixture.siteId]).catch(() => undefined)
  await db.run('DELETE FROM site_video_metric_lineage WHERE site_id = ?', [fixture.siteId]).catch(() => undefined)
  await db.run('DELETE FROM site_video_placements WHERE site_id = ?', [fixture.siteId]).catch(() => undefined)
  await db.run('DELETE FROM public_site_blocks WHERE id = ?', [fixture.blockId]).catch(() => undefined)
  await db.run('DELETE FROM media_assets WHERE id IN (?, ?)', [fixture.oldAssetId, fixture.newAssetId]).catch(() => undefined)
  await db.run('DELETE FROM public_sites WHERE id = ?', [fixture.siteId]).catch(() => undefined)
}

test('reemplazar conservando métricas une el historial bajo el video nuevo', async () => {
  const fixture = await makeFixture()
  const oldPlaybackId = `playback_old_${uniqueSuffix()}`
  const newPlaybackId = `playback_new_${uniqueSuffix()}`

  try {
    await recordPlay({
      playbackId: oldPlaybackId,
      assetId: fixture.oldAssetId,
      siteId: fixture.siteId,
      blockId: fixture.blockId,
      timestamp: Date.now() - 10_000
    })

    const result = await replaceSiteVideo({
      siteId: fixture.siteId,
      blockId: fixture.blockId,
      replacementMediaAssetId: fixture.newAssetId,
      metricsMode: 'preserve',
      requestedByUserId: 'user_test'
    })
    assert.equal(result.historicalMetricsPreserved, true)
    assert.equal(result.canonicalMediaAssetId, fixture.newAssetId)

    await recordPlay({
      playbackId: newPlaybackId,
      assetId: fixture.newAssetId,
      siteId: fixture.siteId,
      blockId: fixture.blockId,
      timestamp: Date.now()
    })

    const detail = await getVideoPlaybackViewers({ assetId: fixture.newAssetId, limit: 10 })
    assert.equal(detail.summary.playbackStarts, 2)
    assert.equal(detail.viewers.length, 2)

    const block = await db.get('SELECT settings_json FROM public_site_blocks WHERE id = ?', [fixture.blockId])
    const settings = JSON.parse(block.settings_json)
    assert.equal(settings.mediaUrl, fixture.newUrl)
    assert.equal(settings.mediaAssetId, fixture.newAssetId)

    const lineage = await db.get(
      `SELECT canonical_asset_id FROM site_video_metric_lineage
       WHERE site_id = ? AND block_id = ? AND asset_id = ?`,
      [fixture.siteId, fixture.blockId, fixture.oldAssetId]
    )
    assert.equal(lineage.canonical_asset_id, fixture.newAssetId)
    const catalog = await listSitesVideoAssets({
      businessId: 'default',
      siteType: 'sites',
      siteId: fixture.siteId
    })
    assert.deepEqual(catalog.items.map(asset => asset.id), [fixture.newAssetId])
    assert.equal(catalog.items[0].metadata.analyticsLifecycleStatus, 'active')
    assert.ok(catalog.items[0].metadata.analyticsPlacements.some(placement => (
      placement.sourceMediaAssetId === fixture.oldAssetId && placement.status === 'inactive'
    )))
    const audit = await db.get('SELECT * FROM site_video_replacements WHERE site_id = ?', [fixture.siteId])
    assert.equal(audit.metrics_mode, 'preserve')
    assert.equal(audit.requested_by_user_id, 'user_test')
  } finally {
    await cleanupFixture(fixture, [oldPlaybackId, newPlaybackId])
  }
})

test('reemplazar desde cero mantiene separadas las métricas nuevas y anteriores', async () => {
  const fixture = await makeFixture()
  const oldPlaybackId = `playback_reset_old_${uniqueSuffix()}`
  const newPlaybackId = `playback_reset_new_${uniqueSuffix()}`

  try {
    await recordPlay({
      playbackId: oldPlaybackId,
      assetId: fixture.oldAssetId,
      siteId: fixture.siteId,
      blockId: fixture.blockId,
      timestamp: Date.now() - 10_000
    })
    const result = await replaceSiteVideo({
      siteId: fixture.siteId,
      blockId: fixture.blockId,
      replacementMediaAssetId: fixture.newAssetId,
      metricsMode: 'reset'
    })
    assert.equal(result.historicalMetricsPreserved, false)

    await recordPlay({
      playbackId: newPlaybackId,
      assetId: fixture.newAssetId,
      siteId: fixture.siteId,
      blockId: fixture.blockId,
      timestamp: Date.now()
    })

    const newDetail = await getVideoPlaybackViewers({ assetId: fixture.newAssetId, limit: 10 })
    const oldDetail = await getVideoPlaybackViewers({ assetId: fixture.oldAssetId, limit: 10 })
    assert.equal(newDetail.summary.playbackStarts, 1)
    assert.equal(oldDetail.summary.playbackStarts, 1)
  } finally {
    await cleanupFixture(fixture, [oldPlaybackId, newPlaybackId])
  }
})

test('conservar métricas no roba reproducciones del mismo asset usado en otro Site', async () => {
  const fixture = await makeFixture()
  const suffix = uniqueSuffix()
  const otherSiteId = `site_video_shared_${suffix}`
  const otherBlockId = `block_video_shared_${suffix}`
  const currentPlaybackId = `playback_current_site_${suffix}`
  const otherPlaybackId = `playback_other_site_${suffix}`

  try {
    await db.run(`
      INSERT INTO public_sites (id, name, slug, site_type, status, theme_json)
      VALUES (?, 'Otro Site', ?, 'landing_page', 'published', '{}')
    `, [otherSiteId, `${otherSiteId}-slug`])
    await db.run(`
      INSERT INTO public_site_blocks (
        id, site_id, block_type, label, content, settings_json, sort_order
      ) VALUES (?, ?, 'video', 'Video compartido', '', ?, 0)
    `, [
      otherBlockId,
      otherSiteId,
      JSON.stringify({ mediaUrl: fixture.oldUrl, mediaAssetId: fixture.oldAssetId })
    ])
    await recordPlay({
      playbackId: currentPlaybackId,
      assetId: fixture.oldAssetId,
      siteId: fixture.siteId,
      blockId: fixture.blockId,
      timestamp: Date.now() - 10_000
    })
    await recordPlay({
      playbackId: otherPlaybackId,
      assetId: fixture.oldAssetId,
      siteId: otherSiteId,
      blockId: otherBlockId,
      timestamp: Date.now() - 5_000
    })

    await replaceSiteVideo({
      siteId: fixture.siteId,
      blockId: fixture.blockId,
      replacementMediaAssetId: fixture.newAssetId,
      metricsMode: 'preserve'
    })

    const replacedDetail = await getVideoPlaybackViewers({
      assetId: fixture.newAssetId,
      siteId: fixture.siteId,
      limit: 10
    })
    const untouchedDetail = await getVideoPlaybackViewers({
      assetId: fixture.oldAssetId,
      siteId: otherSiteId,
      limit: 10
    })
    assert.equal(replacedDetail.summary.playbackStarts, 1)
    assert.equal(untouchedDetail.summary.playbackStarts, 1)
  } finally {
    await db.run('DELETE FROM video_playback_events WHERE playback_id = ?', [otherPlaybackId]).catch(() => undefined)
    await db.run('DELETE FROM video_playback_sessions WHERE playback_id = ?', [otherPlaybackId]).catch(() => undefined)
    await db.run('DELETE FROM site_video_metric_lineage WHERE site_id = ?', [otherSiteId]).catch(() => undefined)
    await db.run('DELETE FROM public_site_blocks WHERE id = ?', [otherBlockId]).catch(() => undefined)
    await db.run('DELETE FROM public_sites WHERE id = ?', [otherSiteId]).catch(() => undefined)
    await cleanupFixture(fixture, [currentPlaybackId])
  }
})

test('conservar métricas falla cerrado si el video actual no tiene asset resoluble', async () => {
  const fixture = await makeFixture()
  try {
    await db.run(
      'UPDATE public_site_blocks SET settings_json = ? WHERE id = ?',
      [JSON.stringify({ mediaUrl: 'https://externo.example.test/video.mp4' }), fixture.blockId]
    )

    await assert.rejects(
      replaceSiteVideo({
        siteId: fixture.siteId,
        blockId: fixture.blockId,
        replacementMediaAssetId: fixture.newAssetId,
        metricsMode: 'preserve'
      }),
      error => error?.code === 'site_video_current_asset_unresolved' && error?.status === 409
    )
  } finally {
    await cleanupFixture(fixture, [])
  }
})
