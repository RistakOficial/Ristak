import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { db } from '../src/config/database.js'
import {
  getSitesVideoAssetsHandler
} from '../src/controllers/sitesController.js'
import {
  getVideoPlaybackAggregate,
  recordVideoPlaybackEvent
} from '../src/services/videoTrackingService.js'
import { getSitesVideoInventorySummary } from '../src/services/sitesService.js'

const sitesControllerSourceUrl = new URL('../src/controllers/sitesController.js', import.meta.url)
const sitesFrontendSourceUrl = new URL('../../frontend/src/pages/Sites/Sites.tsx', import.meta.url)
const sitesFrontendServiceSourceUrl = new URL('../../frontend/src/services/sitesService.ts', import.meta.url)

function uniqueMarker(label) {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function handlerResponse() {
  let statusCode = 200
  let payload = null
  const res = {
    status(code) {
      statusCode = Number(code)
      return res
    },
    json(value) {
      payload = value
      return res
    }
  }
  return {
    res,
    read: () => ({ statusCode, payload })
  }
}

async function insertSitesVideoAsset({ id, businessId, siteId, streamVideoId, createdAt }) {
  const metadata = {
    stream: {
      provider: 'bunny_stream',
      videoId: streamVideoId,
      source: { module: 'sites' }
    }
  }
  await db.run(
    `INSERT INTO media_assets (
       id, business_id, original_filename, stored_filename, bunny_path, folder_path,
       public_url, mime_type, media_type, extension,
       size_original, size_processed, quota_size, status, storage_provider,
       module, module_entity_id, stream_video_id, is_public, metadata_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'sites/2099/07/14', ?, 'video/mp4', 'video', 'mp4',
       100, 80, 80, 'ready', 'bunny_stream', 'sites', ?, ?, 1, ?, ?, ?)`,
    [
      id,
      businessId,
      `${id}.mp4`,
      `${id}.mp4`,
      `accounts/${businessId}/sites/2099/07/14/${id}.mp4`,
      `https://media.example.test/${id}.mp4`,
      siteId,
      streamVideoId,
      JSON.stringify(metadata),
      createdAt,
      createdAt
    ]
  )
}

async function insertSharedStorageVideoAsset({ id, businessId, createdAt }) {
  await db.run(
    `INSERT INTO media_assets (
       id, business_id, original_filename, stored_filename, bunny_path, folder_path,
       public_url, mime_type, media_type, extension,
       size_original, size_processed, quota_size, status, storage_provider,
       module, module_entity_id, is_public, metadata_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'media/videos', ?, 'video/mp4', 'video', 'mp4',
       100, 80, 80, 'ready', 'bunny', 'media', NULL, 1, '{}', ?, ?)`,
    [
      id,
      businessId,
      `${id}.mp4`,
      `${id}.mp4`,
      `accounts/${businessId}/media/videos/${id}.mp4`,
      `https://media.example.test/${id}.mp4`,
      createdAt,
      createdAt
    ]
  )
}

test('el inventario reconoce bindings HTML, bloques por URL y videos compartidos entre sitios', async () => {
  const marker = uniqueMarker('sites_video_current_relations')
  const businessId = marker
  const siteA = `${marker}_site_a`
  const siteB = `${marker}_site_b`
  const boundAssetId = `${marker}_asset_bound`
  const blockAssetId = `${marker}_asset_block`
  const createdAt = '2099-07-14T12:00:00.000Z'

  try {
    await db.run(
      `INSERT INTO public_sites (id, name, slug, site_type, status, theme_json)
       VALUES (?, 'HTML principal', ?, 'landing_page', 'published', ?),
              (?, 'HTML secundario', ?, 'landing_page', 'published', ?)`,
      [
        siteA,
        `${marker}-a`,
        JSON.stringify({ pageMode: 'website', librarySource: 'html' }),
        siteB,
        `${marker}-b`,
        JSON.stringify({ pageMode: 'website', librarySource: 'html' })
      ]
    )
    await insertSharedStorageVideoAsset({ id: boundAssetId, businessId, createdAt })
    await insertSharedStorageVideoAsset({ id: blockAssetId, businessId, createdAt })
    await db.run(
      `INSERT INTO public_site_content_assets (id, site_id, asset_key, label, kind, media_asset_id)
       VALUES (?, ?, 'hero-video', 'Video principal', 'video', ?),
              (?, ?, 'shared-video', 'Video compartido', 'video', ?)`,
      [`${marker}_binding_a`, siteA, boundAssetId, `${marker}_binding_b`, siteB, boundAssetId]
    )
    await db.run(
      `INSERT INTO public_site_blocks (id, site_id, block_type, label, content, settings_json, sort_order)
       VALUES (?, ?, 'video', 'Video por URL', '', ?, 0)`,
      [
        `${marker}_block`,
        siteA,
        JSON.stringify({ mediaUrl: `https://media.example.test/${blockAssetId}.mp4` })
      ]
    )

    const response = handlerResponse()
    await getSitesVideoAssetsHandler({
      query: { businessId, siteType: 'sites', landingMode: 'website', limit: '10' }
    }, response.res)
    const result = response.read()
    assert.equal(result.statusCode, 200)
    assert.deepEqual(
      result.payload.data.items.map(asset => asset.id).sort(),
      [blockAssetId, boundAssetId].sort()
    )
    const sharedAsset = result.payload.data.items.find(asset => asset.id === boundAssetId)
    assert.deepEqual(
      sharedAsset.metadata.analyticsSourceSites.map(site => site.id).sort(),
      [siteA, siteB].sort()
    )
    assert.equal(sharedAsset.metadata.analyticsSourceSite.id, siteA)

    const exactResponse = handlerResponse()
    await getSitesVideoAssetsHandler({
      query: {
        businessId,
        assetId: boundAssetId,
        analyticsScope: '1',
        siteType: 'sites',
        landingMode: 'website',
        siteId: siteB
      }
    }, exactResponse.res)
    assert.equal(exactResponse.read().payload?.data?.metadata?.analyticsSourceSite?.id, siteB)

    const inventory = await getSitesVideoInventorySummary({
      businessId,
      siteType: 'sites',
      landingMode: 'website'
    })
    assert.deepEqual(inventory, {
      total: 2,
      streamReady: 0,
      storageOnly: 2,
      originsTotal: 2
    })
  } finally {
    await db.run('DELETE FROM public_site_content_assets WHERE site_id IN (?, ?)', [siteA, siteB]).catch(() => undefined)
    await db.run('DELETE FROM public_site_blocks WHERE site_id IN (?, ?)', [siteA, siteB]).catch(() => undefined)
    await db.run('DELETE FROM media_assets WHERE business_id = ?', [businessId]).catch(() => undefined)
    await db.run('DELETE FROM public_sites WHERE id IN (?, ?)', [siteA, siteB]).catch(() => undefined)
  }
})

test('/sites/video-assets pagina una sola ventana y resuelve streamVideoId aunque quede fuera de la primera página', async () => {
  const marker = uniqueMarker('sites_video_page')
  const businessId = marker
  const totalAssets = 105
  const targetIndex = totalAssets - 1
  const targetStreamVideoId = `${marker}_stream_${targetIndex}`
  const siteId = `${marker}_site`

  try {
    await db.run(
      `INSERT INTO public_sites (id, name, slug, site_type, status, theme_json)
       VALUES (?, 'Sitio de escala', ?, 'landing_page', 'published', ?)`,
      [siteId, `${marker}-site`, JSON.stringify({ pageMode: 'website' })]
    )
    for (let index = 0; index < totalAssets; index += 1) {
      const createdAt = new Date(Date.UTC(2099, 6, 14, 12, 0, 0) - index * 1_000).toISOString()
      await insertSitesVideoAsset({
        id: `${marker}_asset_${String(index).padStart(3, '0')}`,
        businessId,
        siteId,
        streamVideoId: `${marker}_stream_${index}`,
        createdAt
      })
    }

    // Contamos la consulta de ventana real. Con 105 filas, el viejo `while`
    // necesita dos lecturas aunque el cliente sólo haya pedido tres elementos.
    const originalAll = db.all
    let pageReads = 0
    db.all = async function countedAll(sql, params) {
      const normalizedSql = String(sql || '')
      if (normalizedSql.includes('cursor_created_at') && normalizedSql.includes('FROM media_assets')) {
        pageReads += 1
      }
      return originalAll.call(db, sql, params)
    }

    let firstResult
    try {
      const response = handlerResponse()
      await getSitesVideoAssetsHandler({
        query: { businessId, limit: '3' }
      }, response.res)
      firstResult = response.read()
    } finally {
      db.all = originalAll
    }

    assert.equal(firstResult.statusCode, 200)
    assert.equal(firstResult.payload?.success, true)
    assert.equal(pageReads, 1, 'una petición paginada jamás debe recorrer todas las páginas de Media')
    assert.equal(firstResult.payload?.data?.items?.length, 3)
    assert.deepEqual(firstResult.payload?.data?.items?.[0]?.metadata?.analyticsSourceSite, {
      id: siteId,
      name: 'Sitio de escala',
      siteType: 'landing_page',
      pageMode: 'website'
    })
    assert.equal(firstResult.payload?.data?.pageInfo?.limit, 3)
    assert.equal(firstResult.payload?.data?.pageInfo?.hasMore, true)
    assert.ok(firstResult.payload?.data?.pageInfo?.nextCursor)

    const firstIds = firstResult.payload.data.items.map(asset => asset.id)
    const secondResponse = handlerResponse()
    await getSitesVideoAssetsHandler({
      query: {
        businessId,
        limit: '3',
        cursor: firstResult.payload.data.pageInfo.nextCursor
      }
    }, secondResponse.res)
    const secondResult = secondResponse.read()
    assert.equal(secondResult.statusCode, 200)
    assert.equal(secondResult.payload?.data?.items?.length, 3)
    assert.equal(
      secondResult.payload.data.items.some(asset => firstIds.includes(asset.id)),
      false,
      'el cursor debe avanzar, no repetir la primera ventana'
    )

    const decodedVideoCursor = JSON.parse(
      Buffer.from(firstResult.payload.data.pageInfo.nextCursor, 'base64url').toString('utf8')
    )
    assert.equal(decodedVideoCursor.v, 2)
    assert.equal(typeof decodedVideoCursor.scope, 'string')
    const mismatchedCursorResponse = handlerResponse()
    await getSitesVideoAssetsHandler({
      query: {
        businessId,
        siteType: 'forms',
        limit: '3',
        cursor: firstResult.payload.data.pageInfo.nextCursor
      }
    }, mismatchedCursorResponse.res)
    const mismatchedCursorResult = mismatchedCursorResponse.read()
    assert.equal(mismatchedCursorResult.statusCode, 400)
    assert.match(mismatchedCursorResult.payload?.error || '', /Cursor de Sites inválido/)

    // El lookup exacto también alimenta el preview autenticado del editor. Un
    // sitio en borrador no aparece en Analíticas, pero su video sí debe abrir.
    await db.run("UPDATE public_sites SET status = 'draft' WHERE id = ?", [siteId])
    const exactResponse = handlerResponse()
    await getSitesVideoAssetsHandler({
      query: {
        businessId,
        limit: '3',
        streamVideoId: targetStreamVideoId
      }
    }, exactResponse.res)
    const exactResult = exactResponse.read()
    assert.equal(exactResult.statusCode, 200)
    assert.equal(
      exactResult.payload?.data?.id,
      `${marker}_asset_${String(targetIndex).padStart(3, '0')}`
    )
    assert.equal(
      exactResult.payload?.data?.metadata?.stream?.videoId,
      targetStreamVideoId
    )
    assert.deepEqual(exactResult.payload?.data?.metadata?.analyticsSourceSite, {
      id: siteId,
      name: 'Sitio de escala',
      siteType: 'landing_page',
      pageMode: 'website'
    })

    const hiddenDraftResponse = handlerResponse()
    await getSitesVideoAssetsHandler({
      query: {
        businessId,
        assetId: exactResult.payload.data.id,
        analyticsScope: '1',
        siteType: 'sites',
        landingMode: 'website',
        siteId
      }
    }, hiddenDraftResponse.res)
    assert.equal(hiddenDraftResponse.read().statusCode, 404)

    await db.run("UPDATE public_sites SET status = 'published' WHERE id = ?", [siteId])
    const scopedResponse = handlerResponse()
    await getSitesVideoAssetsHandler({
      query: {
        businessId,
        assetId: exactResult.payload.data.id,
        analyticsScope: '1',
        siteType: 'sites',
        landingMode: 'website',
        siteId
      }
    }, scopedResponse.res)
    assert.equal(scopedResponse.read().statusCode, 200)

    const wrongTypeResponse = handlerResponse()
    await getSitesVideoAssetsHandler({
      query: {
        businessId,
        assetId: exactResult.payload.data.id,
        analyticsScope: '1',
        siteType: 'forms',
        siteId
      }
    }, wrongTypeResponse.res)
    assert.equal(wrongTypeResponse.read().statusCode, 404)

    const wrongListTypeResponse = handlerResponse()
    await getSitesVideoAssetsHandler({
      query: {
        businessId,
        siteId,
        siteType: 'forms',
        limit: '3'
      }
    }, wrongListTypeResponse.res)
    assert.deepEqual(wrongListTypeResponse.read().payload?.data?.items, [])

    const wrongListModeResponse = handlerResponse()
    await getSitesVideoAssetsHandler({
      query: {
        businessId,
        siteId,
        siteType: 'sites',
        landingMode: 'funnel',
        limit: '3'
      }
    }, wrongListModeResponse.res)
    assert.deepEqual(wrongListModeResponse.read().payload?.data?.items, [])

    const matchingListScopeResponse = handlerResponse()
    await getSitesVideoAssetsHandler({
      query: {
        businessId,
        siteId,
        siteType: 'sites',
        landingMode: 'website',
        limit: '3'
      }
    }, matchingListScopeResponse.res)
    assert.equal(matchingListScopeResponse.read().payload?.data?.items?.length, 3)
  } finally {
    await db.run('DELETE FROM media_assets WHERE business_id = ?', [businessId]).catch(() => undefined)
    await db.run('DELETE FROM public_sites WHERE id = ?', [siteId]).catch(() => undefined)
  }
})

test('el agregado de reproducciones acepta siteIds sin enumerar los assetIds del sitio', async () => {
  const marker = uniqueMarker('sites_video_aggregate')
  const selectedSiteId = `${marker}_site_selected`
  const otherSiteId = `${marker}_site_other`
  const selectedAssets = [`${marker}_asset_a`, `${marker}_asset_b`]

  try {
    const rows = [
      {
        suffix: 'a',
        siteId: selectedSiteId,
        assetId: selectedAssets[0],
        plays: 1,
        watchedSeconds: 10,
        progress: 50,
        ended: 0
      },
      {
        suffix: 'b',
        siteId: selectedSiteId,
        assetId: selectedAssets[1],
        plays: 2,
        watchedSeconds: 20,
        progress: 100,
        ended: 1
      },
      {
        suffix: 'outside',
        siteId: otherSiteId,
        assetId: `${marker}_asset_outside`,
        plays: 9,
        watchedSeconds: 90,
        progress: 100,
        ended: 1
      }
    ]

    for (const row of rows) {
      const timestamp = '2099-07-14T12:00:00.000Z'
      const playbackId = `${marker}_playback_${row.suffix}`
      const base = {
        visitor_id: `${marker}_visitor_${row.suffix}`,
        session_id: `${marker}_session_${row.suffix}`
      }
      const record = (eventName, sequence, data = {}) => recordVideoPlaybackEvent({
        ...base,
        event_name: eventName,
        ts: Date.parse(timestamp) + sequence * 1000,
        data: {
          event_id: `${playbackId}:${sequence}`,
          event_sequence: sequence,
          ingestion_version: 2,
          playback_id: playbackId,
          media_asset_id: row.assetId,
          stream_video_id: `${marker}_stream_${row.suffix}`,
          site_id: row.siteId,
          page_id: 'page_scale',
          block_id: `block_${row.suffix}`,
          duration_seconds: 100,
          ...data
        }
      })
      let sequence = 1
      await record('video_ready', sequence++)
      for (let playIndex = 0; playIndex < row.plays; playIndex += 1) {
        await record('video_play', sequence++)
      }
      await record('video_progress', sequence++, {
        position_seconds: row.progress,
        watched_delta_seconds: row.watchedSeconds,
        watch_from_seconds: Math.max(0, row.progress - row.watchedSeconds),
        watch_to_seconds: row.progress
      })
      if (row.ended) {
        await record('video_ended', sequence++, { position_seconds: 100 })
      }
    }

    const aggregate = await getVideoPlaybackAggregate({
      siteIds: [selectedSiteId],
      breakdownAssetIds: selectedAssets,
      includeSiteBreakdown: true
    })

    assert.equal(aggregate.summary.playbackSessions, 2)
    assert.equal(aggregate.summary.plays, 2)
    assert.equal(aggregate.summary.playActions, 3)
    assert.equal(aggregate.summary.watchedSeconds, 30)
    assert.deepEqual(Object.keys(aggregate.byAssetId).sort(), selectedAssets.sort())
    assert.equal(aggregate.bySiteId[selectedSiteId]?.playbackSessions, 2)
    assert.equal(aggregate.bySiteId[otherSiteId], undefined)

    await db.run(
      `INSERT INTO public_sites (id, name, slug, site_type, status, theme_json)
       VALUES (?, 'Sitio', ?, 'landing_page', 'published', ?),
              (?, 'Formulario', ?, 'standard_form', 'published', '{}')`,
      [selectedSiteId, `${marker}-site`, JSON.stringify({ pageMode: 'website' }), otherSiteId, `${marker}-form`]
    )
    const scopedAggregate = await getVideoPlaybackAggregate({
      siteScope: { siteType: 'sites', landingMode: 'website' },
      breakdownAssetIds: selectedAssets
    })
    assert.equal(scopedAggregate.summary.playbackSessions, 2)
    assert.equal(scopedAggregate.summary.plays, 2)
    assert.equal(scopedAggregate.summary.playActions, 3)
    assert.deepEqual(Object.keys(scopedAggregate.byAssetId).sort(), selectedAssets.sort())
    assert.deepEqual(scopedAggregate.bySiteId, {})

    const explicitScopedAggregate = await getVideoPlaybackAggregate({
      siteIds: [selectedSiteId, otherSiteId],
      siteScope: { siteType: 'sites', landingMode: 'website' },
      breakdownAssetIds: [...selectedAssets, `${marker}_asset_outside`]
    })
    assert.equal(explicitScopedAggregate.summary.playbackSessions, 2)
    assert.equal(explicitScopedAggregate.summary.plays, 2)
    assert.equal(explicitScopedAggregate.summary.playActions, 3)
    assert.equal(explicitScopedAggregate.byAssetId[`${marker}_asset_outside`].plays, 0)

    await db.run("UPDATE public_sites SET status = 'draft' WHERE id = ?", [selectedSiteId])
    const draftScopedAggregate = await getVideoPlaybackAggregate({
      siteIds: [selectedSiteId],
      siteScope: { siteType: 'sites', landingMode: 'website' }
    })
    assert.equal(draftScopedAggregate.summary.playbackSessions, 0)

    await db.run(
      "UPDATE public_sites SET status = 'published', theme_json = ? WHERE id = ?",
      [JSON.stringify({ pageMode: 'funnel' }), selectedSiteId]
    )
    const wrongModeAggregate = await getVideoPlaybackAggregate({
      siteIds: [selectedSiteId],
      siteScope: { siteType: 'sites', landingMode: 'website' }
    })
    assert.equal(wrongModeAggregate.summary.playbackSessions, 0)
  } finally {
    await db.run('DELETE FROM video_playback_events WHERE playback_id LIKE ?', [`${marker}_playback_%`]).catch(() => undefined)
    await db.run('DELETE FROM video_playback_sessions WHERE playback_id LIKE ?', [`${marker}_playback_%`]).catch(() => undefined)
    await db.run('DELETE FROM public_sites WHERE id IN (?, ?)', [selectedSiteId, otherSiteId]).catch(() => undefined)
  }
})

test('el frontend pide previews por streamVideoId y resume Sites por scope sin enumerar toda la biblioteca o videoteca', async () => {
  const [controllerSource, frontendSource, frontendServiceSource] = await Promise.all([
    readFile(sitesControllerSourceUrl, 'utf8'),
    readFile(sitesFrontendSourceUrl, 'utf8'),
    readFile(sitesFrontendServiceSourceUrl, 'utf8')
  ])

  const handlerStart = controllerSource.indexOf('export async function getSitesVideoAssetsHandler')
  const handlerEnd = controllerSource.indexOf('\nexport async function ', handlerStart + 1)
  const handlerSource = controllerSource.slice(handlerStart, handlerEnd)
  assert.doesNotMatch(handlerSource, /while\s*\(/)
  assert.match(handlerSource, /limit:\s*req\.query\.limit/)
  assert.match(handlerSource, /cursor:\s*req\.query\.cursor/)
  assert.match(handlerSource, /streamVideoId|stream_video_id/)
  assert.match(handlerSource, /analyticsScope:\s*req\.query\.analyticsScope/)

  assert.match(controllerSource, /getSitesVideoAssetsHandler/)
  const backendSitesSource = await readFile(new URL('../src/services/sitesService.js', import.meta.url), 'utf8')
  assert.match(backendSitesSource, /cursorTimestampExpression = databaseDialect === 'postgres'/)
  assert.match(backendSitesSource, /\(\$\{timestampExpression\}\)::text/)
  assert.match(backendSitesSource, /\$\{cursorTimestampExpression\} AS cursor_created_at/)
  assert.match(backendSitesSource, /event_sequence:\s*Math\.max\(1,\s*Math\.floor\(num\(meta\.eventSequence\)\)\)/)
  assert.match(backendSitesSource, /const postBody = \(\) => fetch\(ENDPOINT/)
  assert.match(backendSitesSource, /postBody\(\)\.catch\(\(\) => \{\s*postBody\(\)\.catch/s)
  assert.match(backendSitesSource, /player\.on\('seeked', timing => emit\('video_seeked', timing \|\| \{\}, true, false, false\)\)/)
  assert.match(backendSitesSource, /window\.addEventListener\('pagehide', \(\) => \{\s*emit\('video_progress', \{\s*seconds: state\.positionSeconds,[\s\S]*?\}, true, true, false\)/)
  assert.match(backendSitesSource, /video\.addEventListener\('seeking', \(\) => \{[\s\S]*?emit\('video_progress', true, false, false, true\)/)
  assert.match(backendSitesSource, /now - state\.lastSentAt >= 10000/)
  assert.match(backendSitesSource, /const ensurePlaybackStarted = \(\) =>/)
  assert.match(backendSitesSource, /video\.dataset\.rstkVideoRealPlayed !== 'true'/)
  assert.match(backendSitesSource, /video\.addEventListener\('timeupdate', \(\) => \{\s*const startedNow = ensurePlaybackStarted\(\)/)

  const analyticsHandlerStart = controllerSource.indexOf('export async function getSitesAnalyticsSummaryHandler')
  const analyticsHandlerEnd = controllerSource.indexOf('\nexport async function ', analyticsHandlerStart + 1)
  const analyticsHandlerSource = controllerSource.slice(analyticsHandlerStart, analyticsHandlerEnd)
  const videoAggregateCall = analyticsHandlerSource.match(/getVideoPlaybackAggregate\(\{[\s\S]*?\}\)/)?.[0] || ''
  assert.match(videoAggregateCall, /siteIds:\s*body\.videoSiteIds/)
  assert.match(videoAggregateCall, /siteScope:\s*(?:body\.videoScope|videoScope)/)
  assert.match(videoAggregateCall, /breakdownAssetIds:\s*body\.videoBreakdownAssetIds/)
  assert.match(videoAggregateCall, /includeSiteBreakdown:\s*false/)

  const videoDetailHandlerStart = controllerSource.indexOf('export async function getSitesVideoAnalyticsHandler')
  const videoDetailHandlerEnd = controllerSource.indexOf('\nexport async function ', videoDetailHandlerStart + 1)
  const videoDetailHandlerSource = controllerSource.slice(videoDetailHandlerStart, videoDetailHandlerEnd)
  assert.match(videoDetailHandlerSource, /siteId:\s*req\.query\.siteId\s*\|\|\s*req\.query\.site_id/)

  assert.doesNotMatch(frontendSource, /siteVideoAssetsPreviewPromise/)
  assert.doesNotMatch(frontendSource, /loadSiteVideoAssetsForPreview/)
  assert.doesNotMatch(frontendSource, /analyticsSiteIds\.has\(sourceSiteId\)/)
  assert.match(frontendSource, /analyticsSourceSite/)
  assert.match(frontendSource, /analyticsSourceSites/)
  assert.match(frontendSource, /getMediaSourceSiteIds/)
  assert.match(frontendSource, /getMediaSourceSiteName/)
  assert.match(frontendSource, /analyticsVideoOriginOptions/)

  const previewStart = frontendSource.indexOf('const BunnyStreamStoragePreview')
  const previewEnd = frontendSource.indexOf('\nconst ', previewStart + 10)
  const previewSource = frontendSource.slice(previewStart, previewEnd)
  assert.match(
    previewSource,
    /(?:sitesService\.[A-Za-z0-9_]+\([\s\S]{0,180}streamVideoId|loadSiteVideoAssetForPreview\(\s*streamVideoId)/,
    'cada preview debe resolver sólo el streamVideoId que necesita'
  )

  const listVideoAssetsStart = frontendServiceSource.indexOf('listVideoAssets(')
  const listVideoAssetsEnd = frontendServiceSource.indexOf('\n  getAnalyticsSummary(', listVideoAssetsStart)
  const listVideoAssetsSource = frontendServiceSource.slice(listVideoAssetsStart, listVideoAssetsEnd)
  assert.match(listVideoAssetsSource, /limit/)
  assert.match(listVideoAssetsSource, /cursor/)
  assert.match(listVideoAssetsSource, /siteType/)
  assert.match(listVideoAssetsSource, /siteId/)
  assert.match(listVideoAssetsSource, /streamVideoId/)
  assert.match(listVideoAssetsSource, /params/)
  assert.doesNotMatch(listVideoAssetsSource, /apiClient\.get<MediaAsset\[]>/)

  const exactVideoStart = frontendServiceSource.indexOf('getVideoAssetById(assetId: string, options?:')
  const exactVideoEnd = frontendServiceSource.indexOf('\n  getAnalyticsSummary(', exactVideoStart)
  const exactVideoSource = frontendServiceSource.slice(exactVideoStart, exactVideoEnd)
  assert.ok(exactVideoStart >= 0 && exactVideoEnd > exactVideoStart)
  assert.match(exactVideoSource, /analyticsScope/)
  assert.match(exactVideoSource, /siteType/)
  assert.match(exactVideoSource, /landingMode/)
  assert.match(exactVideoSource, /siteId/)

  const summaryCallStart = frontendSource.indexOf('sitesService.getAnalyticsSummary({')
  const summaryCallEnd = frontendSource.indexOf('}, { signal: controller.signal })', summaryCallStart)
  const summaryCall = frontendSource.slice(summaryCallStart, summaryCallEnd)
  assert.match(summaryCall, /siteScope:/)
  assert.match(summaryCall, /breakdownSiteIds:\s*sitesAnalyticsSiteId\s*\?/)
  assert.doesNotMatch(summaryCall, /siteIds:/)
  assert.match(summaryCall, /videoSiteIds:/)
  assert.match(summaryCall, /videoScope:/)
  assert.match(summaryCall, /videoBreakdownAssetIds:/)
  assert.match(summaryCall, /videoAssetIds:\s*sitesAnalyticsVideoId\s*\?/)

  const videoDetailCallStart = frontendSource.indexOf('sitesService.getVideoAnalytics(sitesAnalyticsVideoId, {')
  const videoDetailCallEnd = frontendSource.indexOf('})\n      .then', videoDetailCallStart)
  const videoDetailCall = frontendSource.slice(videoDetailCallStart, videoDetailCallEnd)
  assert.match(videoDetailCall, /siteId:\s*sitesAnalyticsSiteId\s*\|\|\s*undefined/)
  assert.doesNotMatch(videoDetailCall, /includeProviderAnalytics/)
  assert.doesNotMatch(frontendSource, /Bunny Stream · comparación del proveedor/)
  assert.match(frontendSource, /Retención real/)
  assert.match(frontendSource, /Medición de Ristak/)

  const videoDetailServiceStart = frontendServiceSource.indexOf('getVideoAnalytics(assetId: string')
  const videoDetailServiceEnd = frontendServiceSource.indexOf('\n  verifyDomain(', videoDetailServiceStart)
  const videoDetailServiceSource = frontendServiceSource.slice(videoDetailServiceStart, videoDetailServiceEnd)
  assert.match(videoDetailServiceSource, /if \(input\.siteId\) params\.siteId = input\.siteId/)
  assert.match(videoDetailServiceSource, /params\.includeProviderAnalytics/)
})
