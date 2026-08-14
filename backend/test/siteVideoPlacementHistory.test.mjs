import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  createBlock,
  deleteBlock,
  getSitesVideoInventorySummary,
  listSitesVideoAssets,
  restoreBlocks
} from '../src/services/sitesService.js'
import {
  getVideoPlaybackViewers,
  recordVideoPlaybackEvent
} from '../src/services/videoTrackingService.js'

function marker(label) {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

test('quitar un video del Site conserva su página, estado y métricas en Analíticas', async () => {
  const seed = marker('site_video_history')
  const businessId = seed
  const siteId = `${seed}_site`
  const blockId = `rstk_site_block_${Date.now()}${Math.random().toString(36).slice(2, 8)}`
  const assetId = `${seed}_asset`
  const playbackId = `${seed}_playback`
  const publicUrl = `https://media.example.test/${assetId}.mp4`
  let savedBlock = null

  try {
    await db.run(`
      INSERT INTO public_sites (id, name, slug, site_type, status, theme_json)
      VALUES (?, 'Site histórico', ?, 'landing_page', 'published', ?)
    `, [
      siteId,
      `${seed}-site`,
      JSON.stringify({
        pageMode: 'website',
        pages: [
          { id: 'home', title: 'Inicio', slug: 'inicio', sortOrder: 0 },
          { id: 'offer', title: 'Oferta Premium', slug: 'oferta', sortOrder: 1 }
        ]
      })
    ])
    await db.run(`
      INSERT INTO media_assets (
        id, business_id, original_filename, stored_filename, bunny_path, folder_path,
        public_url, mime_type, media_type, extension,
        size_original, size_processed, quota_size, status, storage_provider,
        module, module_entity_id, is_public, metadata_json, created_at, updated_at
      ) VALUES (
        ?, ?, 'vsl-historica.mp4', 'vsl-historica.mp4', ?, 'sites/videos', ?,
        'video/mp4', 'video', 'mp4', 100, 90, 90, 'ready', 'bunny',
        'sites', ?, 1, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `, [assetId, businessId, `accounts/${businessId}/sites/videos/${assetId}.mp4`, publicUrl, siteId])

    const createdSite = await createBlock(siteId, {
      id: blockId,
      blockType: 'video',
      label: 'VSL histórica',
      settings: { mediaAssetId: assetId, mediaUrl: publicUrl, pageId: 'offer' }
    })
    savedBlock = createdSite.blocks.find(block => block.id === blockId)
    assert.ok(savedBlock)

    const eventBase = {
      visitor_id: `${seed}_visitor`,
      session_id: `${seed}_session`
    }
    const record = (eventName, sequence, data = {}) => recordVideoPlaybackEvent({
      ...eventBase,
      event_name: eventName,
      ts: Date.now() + sequence,
      data: {
        event_id: `${playbackId}:${sequence}`,
        event_sequence: sequence,
        ingestion_version: 2,
        playback_id: playbackId,
        media_asset_id: assetId,
        site_id: siteId,
        page_id: 'offer',
        block_id: blockId,
        page_url: `https://example.test/${seed}/oferta`,
        duration_seconds: 60,
        ...data
      }
    })
    await record('video_ready', 1)
    await record('video_play', 2)
    await record('video_progress', 3, {
      position_seconds: 12,
      watched_delta_seconds: 12,
      watch_from_seconds: 0,
      watch_to_seconds: 12
    })

    const activeCatalog = await listSitesVideoAssets({
      businessId,
      siteType: 'sites',
      landingMode: 'website',
      siteId
    })
    assert.equal(activeCatalog.items.length, 1)
    assert.equal(activeCatalog.items[0].metadata.analyticsLifecycleStatus, 'active')
    assert.equal(activeCatalog.items[0].metadata.analyticsPrimaryPlacement.pageTitle, 'Oferta Premium')

    // Simula una fila precargada por la migración: al retirarla, el servicio
    // debe completar y congelar el snapshot de página antes de cerrarla.
    await db.run(`
      UPDATE site_video_placements
      SET page_title = NULL, page_path = NULL
      WHERE site_id = ? AND block_id = ? AND deactivated_at IS NULL
    `, [siteId, blockId])

    const eventsBeforeDelete = await db.get(
      'SELECT COUNT(*) AS total FROM video_playback_events WHERE playback_id = ?',
      [playbackId]
    )
    await deleteBlock(siteId, blockId)
    const eventsAfterDelete = await db.get(
      'SELECT COUNT(*) AS total FROM video_playback_events WHERE playback_id = ?',
      [playbackId]
    )
    assert.equal(Number(eventsAfterDelete.total), Number(eventsBeforeDelete.total))

    const historicalCatalog = await listSitesVideoAssets({
      businessId,
      siteType: 'sites',
      landingMode: 'website',
      siteId
    })
    assert.equal(historicalCatalog.items.length, 1)
    const historicalAsset = historicalCatalog.items[0]
    assert.equal(historicalAsset.id, assetId)
    assert.equal(historicalAsset.metadata.analyticsLifecycleStatus, 'inactive')
    assert.equal(historicalAsset.metadata.analyticsPrimaryPlacement.pageId, 'offer')
    assert.equal(historicalAsset.metadata.analyticsPrimaryPlacement.pageTitle, 'Oferta Premium')
    assert.equal(historicalAsset.metadata.analyticsPrimaryPlacement.status, 'inactive')
    const closedPlacement = await db.get(`
      SELECT page_title, page_path
      FROM site_video_placements
      WHERE site_id = ? AND block_id = ? AND deactivated_at IS NOT NULL
      ORDER BY deactivated_at DESC
      LIMIT 1
    `, [siteId, blockId])
    assert.equal(closedPlacement.page_title, 'Oferta Premium')
    assert.equal(closedPlacement.page_path, '/oferta')

    const inventory = await getSitesVideoInventorySummary({
      businessId,
      siteType: 'sites',
      landingMode: 'website',
      siteId
    })
    assert.deepEqual(inventory, {
      total: 1,
      active: 0,
      inactive: 1,
      streamReady: 0,
      storageOnly: 1,
      originsTotal: 1
    })

    const analytics = await getVideoPlaybackViewers({ assetId, siteId })
    assert.equal(analytics.summary.playbackStarts, 1)
    assert.equal(analytics.summary.watchedSeconds, 12)

    await restoreBlocks(siteId, [savedBlock])
    const restoredCatalog = await listSitesVideoAssets({
      businessId,
      siteType: 'sites',
      landingMode: 'website',
      siteId
    })
    assert.equal(restoredCatalog.items[0].metadata.analyticsLifecycleStatus, 'active')
    assert.ok(restoredCatalog.items[0].metadata.analyticsPlacements.some(placement => placement.status === 'inactive'))
    assert.ok(restoredCatalog.items[0].metadata.analyticsPlacements.some(placement => placement.status === 'active'))
  } finally {
    await db.run('DELETE FROM video_playback_events WHERE playback_id = ?', [playbackId]).catch(() => undefined)
    await db.run('DELETE FROM video_playback_sessions WHERE playback_id = ?', [playbackId]).catch(() => undefined)
    await db.run('DELETE FROM site_video_placements WHERE site_id = ?', [siteId]).catch(() => undefined)
    await db.run('DELETE FROM site_video_metric_lineage WHERE site_id = ?', [siteId]).catch(() => undefined)
    await db.run('DELETE FROM site_video_replacements WHERE site_id = ?', [siteId]).catch(() => undefined)
    await db.run('DELETE FROM public_site_blocks WHERE site_id = ?', [siteId]).catch(() => undefined)
    await db.run('DELETE FROM media_assets WHERE id = ?', [assetId]).catch(() => undefined)
    await db.run('DELETE FROM public_sites WHERE id = ?', [siteId]).catch(() => undefined)
  }
})
