import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

const ENV_KEYS = [
  'DATABASE_URL',
  'MEDIA_STORAGE_PROVIDER',
  'MEDIA_STORAGE_REQUIRE_BUNNY',
  'MEDIA_COMPRESSION_ENABLED',
  'BUNNY_STORAGE_ZONE',
  'BUNNY_STORAGE_REGION',
  'BUNNY_STORAGE_ENDPOINT',
  'BUNNY_STORAGE_API_KEY',
  'BUNNY_CDN_BASE_URL',
  'BUNNY_API_KEY',
  'BUNNY_ACCOUNT_API_KEY',
  'BUNNY_API_TOKEN',
  'BUNNY_ACCESS_KEY',
  'BUNNY_CORE_ENDPOINT',
  'BUNNY_API_ENDPOINT',
  'BUNNY_STREAM_ENABLED',
  'BUNNY_STREAM_LIBRARY_ID',
  'BUNNY_STREAM_LIBRARY_NAME',
  'BUNNY_STREAM_API_KEY',
  'BUNNY_STREAM_COLLECTION_ID',
  'BUNNY_STREAM_COLLECTION_NAME',
  'BUNNY_STREAM_ENDPOINT',
  'BUNNY_STREAM_TIMEOUT_MS',
  'RISTAK_CLIENT_ACCOUNT_ID',
  'CLIENT_ACCOUNT_ID',
  'GHL_LOCATION_ID',
  'HIGHLEVEL_LOCATION_ID',
  'RENDER_EXTERNAL_URL',
  'PUBLIC_URL'
]

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = snapshot[key]
    }
  }
}

async function readRequestBuffer(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

async function waitForValue(fn, { timeoutMs = 2000, intervalMs = 25, label = 'condition' } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await fn()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  assert.fail(`Timed out waiting for ${label}`)
}

async function createBunnyMockServer() {
  const requests = []
  let baseUrl = ''
  let streamVideoTitle = 'Hero video (sites) site_1'
  let streamVideoCollectionId = ''

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', baseUrl || 'http://127.0.0.1')
      const path = decodeURIComponent(url.pathname)

      if (path.startsWith('/storage/central-zone/')) {
        if (req.method === 'PUT') {
          const body = await readRequestBuffer(req)
          requests.push({ kind: 'storage-upload', path, bytes: body.length, accessKey: req.headers.accesskey })
          res.statusCode = 201
          res.end('ok')
          return
        }
        if (req.method === 'GET') {
          requests.push({ kind: 'storage-get', path, accessKey: req.headers.accesskey })
          res.statusCode = 200
          res.setHeader('Content-Type', 'video/mp4')
          res.end('fake mp4 bytes from bunny storage')
          return
        }
        if (req.method === 'DELETE') {
          requests.push({ kind: 'storage-delete', path, accessKey: req.headers.accesskey })
          res.statusCode = 200
          res.end('deleted')
          return
        }
      }

      if (path === '/core/videolibrary' && req.method === 'GET') {
        requests.push({
          kind: 'core-list-video-libraries',
          page: url.searchParams.get('page'),
          perPage: url.searchParams.get('perPage'),
          accessKey: req.headers.accesskey
        })
        sendJson(res, 200, {
          totalItems: 0,
          currentPage: 1,
          itemsPerPage: 1000,
          items: []
        })
        return
      }

      if (path === '/core/videolibrary' && req.method === 'POST') {
        const body = JSON.parse((await readRequestBuffer(req)).toString('utf8') || '{}')
        requests.push({ kind: 'core-create-video-library', body, accessKey: req.headers.accesskey })
        sendJson(res, 201, {
          Id: 123,
          Name: body.Name,
          ApiKey: 'stream-secret',
          ReadOnlyApiKey: 'stream-readonly-secret'
        })
        return
      }

      if (path === '/core/videolibrary/123' && req.method === 'GET') {
        requests.push({ kind: 'core-get-video-library', accessKey: req.headers.accesskey })
        sendJson(res, 200, {
          Id: 123,
          Name: 'Ristak Sites & Forms',
          ApiKey: 'stream-secret',
          ReadOnlyApiKey: 'stream-readonly-secret'
        })
        return
      }

      if (path === '/stream/library/123/collections' && req.method === 'GET') {
        requests.push({ kind: 'stream-list-collections', search: url.searchParams.get('search'), accessKey: req.headers.accesskey })
        sendJson(res, 200, {
          totalItems: 0,
          currentPage: 1,
          itemsPerPage: 100,
          items: []
        })
        return
      }

      if (path === '/stream/library/123/collections' && req.method === 'POST') {
        const body = JSON.parse((await readRequestBuffer(req)).toString('utf8') || '{}')
        requests.push({ kind: 'stream-create-collection', body, accessKey: req.headers.accesskey })
        sendJson(res, 200, {
          videoLibraryId: 123,
          guid: 'collection-sites-forms',
          name: body.name,
          videoCount: 0,
          totalSize: 0
        })
        return
      }

      if (path === '/stream/library/123/videos' && req.method === 'POST') {
        const body = JSON.parse((await readRequestBuffer(req)).toString('utf8') || '{}')
        requests.push({ kind: 'stream-create-video', body, accessKey: req.headers.accesskey })
        streamVideoTitle = body.title || streamVideoTitle
        streamVideoCollectionId = body.collectionId || ''
        sendJson(res, 200, {
          videoLibraryId: 123,
          guid: 'stream-video-1',
          title: body.title,
          dateUploaded: '2026-06-18T00:00:00Z',
          views: 0,
          isPublic: true,
          length: 0,
          status: 0,
          framerate: 0,
          width: 0,
          height: 0,
          outputCodecs: '',
          thumbnailCount: 0,
          encodeProgress: 0,
          storageSize: 0,
          hasMP4Fallback: false,
          averageWatchTime: 0,
          totalWatchTime: 0,
          collectionId: streamVideoCollectionId
        })
        return
      }

      if (path === '/stream/library/123/videos/stream-video-1' && req.method === 'POST') {
        const body = JSON.parse((await readRequestBuffer(req)).toString('utf8') || '{}')
        requests.push({ kind: 'stream-update-video', body, accessKey: req.headers.accesskey })
        streamVideoTitle = body.title || streamVideoTitle
        streamVideoCollectionId = body.collectionId || ''
        sendJson(res, 200, {
          videoLibraryId: 123,
          guid: 'stream-video-1',
          title: streamVideoTitle,
          collectionId: streamVideoCollectionId
        })
        return
      }

      if (path === '/stream/library/123/videos/stream-video-1' && req.method === 'PUT') {
        const body = await readRequestBuffer(req)
        requests.push({
          kind: 'stream-upload-video',
          bytes: body.length,
          accessKey: req.headers.accesskey,
          contentType: req.headers['content-type']
        })
        sendJson(res, 200, { success: true, message: 'uploaded', statusCode: 200 })
        return
      }

      if (path === '/stream/library/123/videos/stream-video-1' && req.method === 'GET') {
        requests.push({ kind: 'stream-get-video', accessKey: req.headers.accesskey })
        sendJson(res, 200, {
          videoLibraryId: 123,
          guid: 'stream-video-1',
          title: streamVideoTitle,
          dateUploaded: '2026-06-18T00:00:00Z',
          views: 7,
          isPublic: true,
          length: 17,
          status: 4,
          framerate: 29.97,
          width: 1280,
          height: 720,
          outputCodecs: 'x264',
          thumbnailCount: 3,
          encodeProgress: 100,
          storageSize: 123456,
          hasMP4Fallback: true,
          averageWatchTime: 5,
          totalWatchTime: 35,
          availableResolutions: '360p,720p',
          collectionId: streamVideoCollectionId,
          chapters: [{ title: 'Inicio', start: 0, end: 17 }],
          moments: [{ label: 'CTA', timestamp: 10 }],
          metaTags: [{ property: 'ristak:asset', value: 'site_1' }],
          transcodingMessages: [],
          smartGenerateStatus: 0,
          smartGenerateFeaturesStatus: { title: 0, description: 0, chapters: 0, moments: 0 },
          hasOriginal: true,
          originalHash: 'hash_1',
          hasHighQualityPreview: true
        })
        return
      }

      if (path === '/stream/library/123/statistics' && req.method === 'GET') {
        requests.push({
          kind: 'stream-statistics',
          videoGuid: url.searchParams.get('videoGuid'),
          dateFrom: url.searchParams.get('dateFrom'),
          dateTo: url.searchParams.get('dateTo'),
          hourly: url.searchParams.get('hourly'),
          accessKey: req.headers.accesskey
        })
        sendJson(res, 200, {
          viewsChart: {
            '2026-06-16T00:00:00Z': 2,
            '2026-06-17T00:00:00Z': 5
          },
          watchTimeChart: {
            '2026-06-16T00:00:00Z': 20,
            '2026-06-17T00:00:00Z': 45
          },
          countryViewCounts: {
            MX: 5,
            US: 2
          },
          countryWatchTime: {
            MX: 50,
            US: 15
          },
          engagementScore: 82
        })
        return
      }

      if (path === '/stream/library/123/videos/stream-video-1/heatmap' && req.method === 'GET') {
        requests.push({ kind: 'stream-heatmap', accessKey: req.headers.accesskey })
        sendJson(res, 200, {
          heatmap: {
            0: 10,
            1: 80,
            2: 45
          }
        })
        return
      }

      if (path === '/stream/library/123/videos/stream-video-1' && req.method === 'DELETE') {
        requests.push({ kind: 'stream-delete-video', accessKey: req.headers.accesskey })
        sendJson(res, 200, { success: true, message: 'deleted', statusCode: 200 })
        return
      }

      res.statusCode = 404
      res.end('not found')
    } catch (error) {
      res.statusCode = 500
      res.end(error.message)
    }
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`

  return {
    baseUrl,
    requests,
    close: () => {
      server.closeAllConnections?.()
      server.close()
    }
  }
}

function configureBunnyEnv(baseUrl) {
  delete process.env.DATABASE_URL
  delete process.env.BUNNY_API_KEY
  delete process.env.BUNNY_ACCOUNT_API_KEY
  delete process.env.BUNNY_API_TOKEN
  delete process.env.BUNNY_ACCESS_KEY
  delete process.env.BUNNY_CORE_ENDPOINT
  delete process.env.BUNNY_API_ENDPOINT
  delete process.env.BUNNY_STREAM_COLLECTION_ID
  delete process.env.RISTAK_CLIENT_ACCOUNT_ID
  delete process.env.CLIENT_ACCOUNT_ID
  delete process.env.GHL_LOCATION_ID
  delete process.env.HIGHLEVEL_LOCATION_ID
  delete process.env.RENDER_EXTERNAL_URL
  delete process.env.PUBLIC_URL
  process.env.MEDIA_STORAGE_PROVIDER = 'bunny'
  process.env.MEDIA_STORAGE_REQUIRE_BUNNY = 'true'
  process.env.MEDIA_COMPRESSION_ENABLED = 'false'
  process.env.BUNNY_STORAGE_ZONE = 'central-zone'
  process.env.BUNNY_STORAGE_REGION = ''
  process.env.BUNNY_STORAGE_ENDPOINT = `${baseUrl}/storage`
  process.env.BUNNY_STORAGE_API_KEY = 'storage-secret'
  process.env.BUNNY_CDN_BASE_URL = `${baseUrl}/cdn`
  process.env.BUNNY_STREAM_ENABLED = 'true'
  process.env.BUNNY_STREAM_LIBRARY_ID = '123'
  process.env.BUNNY_STREAM_API_KEY = 'stream-secret'
  process.env.BUNNY_STREAM_COLLECTION_NAME = 'Ristak Sites & Forms'
  process.env.BUNNY_STREAM_ENDPOINT = `${baseUrl}/stream`
  process.env.BUNNY_STREAM_TIMEOUT_MS = '5000'
}

function configureBunnyAccountOnlyEnv(baseUrl) {
  delete process.env.DATABASE_URL
  delete process.env.BUNNY_ACCOUNT_API_KEY
  delete process.env.BUNNY_API_TOKEN
  delete process.env.BUNNY_ACCESS_KEY
  delete process.env.BUNNY_API_ENDPOINT
  delete process.env.BUNNY_STREAM_LIBRARY_ID
  delete process.env.BUNNY_STREAM_API_KEY
  delete process.env.BUNNY_STREAM_COLLECTION_ID
  delete process.env.RISTAK_CLIENT_ACCOUNT_ID
  delete process.env.CLIENT_ACCOUNT_ID
  delete process.env.GHL_LOCATION_ID
  delete process.env.HIGHLEVEL_LOCATION_ID
  delete process.env.RENDER_EXTERNAL_URL
  delete process.env.PUBLIC_URL
  process.env.MEDIA_STORAGE_PROVIDER = 'bunny'
  process.env.MEDIA_STORAGE_REQUIRE_BUNNY = 'true'
  process.env.MEDIA_COMPRESSION_ENABLED = 'false'
  process.env.BUNNY_STORAGE_ZONE = 'central-zone'
  process.env.BUNNY_STORAGE_REGION = ''
  process.env.BUNNY_STORAGE_ENDPOINT = `${baseUrl}/storage`
  process.env.BUNNY_STORAGE_API_KEY = 'storage-secret'
  process.env.BUNNY_CDN_BASE_URL = `${baseUrl}/cdn`
  process.env.BUNNY_API_KEY = 'account-secret'
  process.env.BUNNY_CORE_ENDPOINT = `${baseUrl}/core`
  process.env.BUNNY_STREAM_ENABLED = 'true'
  process.env.BUNNY_STREAM_LIBRARY_NAME = 'Ristak Sites & Forms'
  process.env.BUNNY_STREAM_COLLECTION_NAME = 'Ristak Sites & Forms'
  process.env.BUNNY_STREAM_ENDPOINT = `${baseUrl}/stream`
  process.env.BUNNY_STREAM_TIMEOUT_MS = '5000'
}

test('Bunny Stream se prepara automaticamente al arrancar con API key de cuenta', async () => {
  const previousEnv = snapshotEnv()
  const bunny = await createBunnyMockServer()
  let db = null
  let mediaAssetId = ''

  try {
    configureBunnyAccountOnlyEnv(bunny.baseUrl)

    const [mediaStorageService, database] = await Promise.all([
      import('../src/services/mediaStorageService.js'),
      import('../src/config/database.js')
    ])
    mediaStorageService.resetCentralStorageConfigCache()
    db = database.db

    await db.run(`
      UPDATE storage_settings
      SET bunny_stream_enabled = 1,
          bunny_stream_library_id = NULL,
          bunny_stream_library_name = NULL,
          bunny_stream_collection_id = NULL,
          bunny_stream_collection_name = NULL
      WHERE id = 1
    `)

    const config = await mediaStorageService.ensureBunnyStreamRuntimeConfigured()
    assert.equal(config.bunnyStreamConfigured, true)
    assert.equal(config.bunnyStreamLibraryId, '123')
    assert.equal(config.bunnyStreamLibraryName, 'Ristak Sites & Forms')
    assert.equal(config.bunnyStreamApiKey, 'stream-secret')
    assert.equal(process.env.BUNNY_STREAM_LIBRARY_ID, '123')
    assert.equal(process.env.BUNNY_STREAM_API_KEY, 'stream-secret')

    const storageSettings = await db.get(`
      SELECT bunny_stream_enabled, bunny_stream_library_id, bunny_stream_library_name, bunny_stream_collection_name
      FROM storage_settings
      WHERE id = 1
    `)
    assert.equal(Number(storageSettings.bunny_stream_enabled), 1)
    assert.equal(storageSettings.bunny_stream_library_id, '123')
    assert.equal(storageSettings.bunny_stream_library_name, 'Ristak Sites & Forms')
    assert.equal(storageSettings.bunny_stream_collection_name, 'Ristak Sites & Forms')

    assert.ok(bunny.requests.some(request => request.kind === 'core-list-video-libraries'))
    assert.ok(bunny.requests.some(request => request.kind === 'core-create-video-library'))
    assert.ok(bunny.requests.some(request => request.kind === 'core-create-video-library' && request.accessKey === 'account-secret'))

    const created = await mediaStorageService.uploadMediaAsset({
      buffer: Buffer.from('fake mp4 bytes for auto-created bunny stream library'),
      filename: 'auto-stream-video.mp4',
      mimeType: 'video/mp4',
      module: 'forms',
      moduleEntityId: 'form_1',
      businessId: 'default',
      isPublic: true,
      skipCompression: true
    })
    mediaAssetId = created.id

    assert.equal(created.mediaType, 'video')
    assert.equal(created.metadata.stream.syncStatus, 'uploaded')
    assert.equal(created.metadata.stream.provider, 'bunny_stream')
    assert.equal(created.metadata.stream.libraryId, '123')
    assert.equal(created.metadata.stream.collectionId, 'collection-sites-forms')
    assert.equal(created.metadata.stream.videoId, 'stream-video-1')
    assert.ok(bunny.requests.some(request => request.kind === 'stream-create-video' && request.accessKey === 'stream-secret'))
    assert.ok(bunny.requests.some(request => request.kind === 'stream-upload-video' && request.accessKey === 'stream-secret'))
    assert.ok(bunny.requests.every(request => !request.accessKey || ['account-secret', 'stream-secret', 'storage-secret'].includes(request.accessKey)))
  } finally {
    if (mediaAssetId) {
      const { softDeleteMediaAsset } = await import('../src/services/mediaStorageService.js')
      await softDeleteMediaAsset(mediaAssetId).catch(() => undefined)
    }
    if (db && mediaAssetId) {
      await db.run('DELETE FROM media_assets WHERE id = ?', [mediaAssetId]).catch(() => undefined)
    }
    bunny.close()
    restoreEnv(previousEnv)
    const mediaStorageService = await import('../src/services/mediaStorageService.js')
    mediaStorageService.resetCentralStorageConfigCache()
  }
})

test('videos de Sites se copian a Bunny Stream y guardan metadata del video', async () => {
  const previousEnv = snapshotEnv()
  const bunny = await createBunnyMockServer()
  let db = null
  let mediaAssetId = ''

  try {
    configureBunnyEnv(bunny.baseUrl)

    const [mediaStorageService, database] = await Promise.all([
      import('../src/services/mediaStorageService.js'),
      import('../src/config/database.js')
    ])
    mediaStorageService.resetCentralStorageConfigCache()
    db = database.db

    const created = await mediaStorageService.uploadMediaAsset({
      buffer: Buffer.from('fake mp4 bytes for bunny stream'),
      filename: 'hero-video.mp4',
      mimeType: 'video/mp4',
      module: 'sites',
      moduleEntityId: 'site_1',
      businessId: 'default',
      clientAccountId: 'loc_mexico',
      isPublic: true,
      skipCompression: true
    })
    mediaAssetId = created.id

    assert.equal(created.mediaType, 'video')
    assert.equal(created.storageProvider, 'bunny')
    assert.match(created.bunnyPath, /^accounts\/loc_mexico\/sites\//)
    assert.equal(created.metadata.clientAccount.id, 'loc_mexico')
    assert.equal(created.metadata.clientAccount.rootPath, 'accounts/loc_mexico')
    assert.equal(created.metadata.stream.syncStatus, 'uploaded')
    assert.equal(created.metadata.stream.provider, 'bunny_stream')
    assert.equal(created.metadata.stream.libraryId, '123')
    assert.equal(created.metadata.stream.collectionId, 'collection-sites-forms')
    assert.equal(created.metadata.stream.collectionName, 'Ristak Sites & Forms / loc_mexico')
    assert.equal(created.metadata.stream.clientAccount.id, 'loc_mexico')
    assert.equal(created.metadata.stream.source.clientAccountId, 'loc_mexico')
    assert.equal(created.metadata.stream.source.accountRootPath, 'accounts/loc_mexico')
    assert.equal(created.metadata.stream.videoId, 'stream-video-1')
    assert.equal(created.metadata.stream.video.statusLabel, 'finished')
    assert.equal(created.metadata.stream.video.length, 17)
    assert.equal(created.metadata.stream.video.width, 1280)
    assert.equal(created.metadata.stream.video.height, 720)
    assert.equal(created.duration, 17)
    assert.equal(created.width, 1280)
    assert.equal(created.height, 720)

    const synced = await mediaStorageService.syncMediaAssetBunnyStream(created.id)
    assert.equal(synced.metadata.stream.syncStatus, 'synced')
    assert.equal(synced.metadata.stream.video.views, 7)
    assert.equal(synced.metadata.stream.video.chapters[0].title, 'Inicio')

    const analytics = await mediaStorageService.getMediaAssetBunnyStreamAnalytics(created.id, {
      dateFrom: '2026-06-16',
      dateTo: '2026-06-17',
      hourly: true
    })
    assert.equal(analytics.status, 'ready')
    assert.equal(analytics.summary.views, 7)
    assert.equal(analytics.summary.watchTime, 35)
    assert.equal(analytics.summary.engagementScore, 82)
    assert.equal(analytics.summary.topCountry, 'MX')
    assert.equal(analytics.viewsChart.length, 2)
    assert.equal(analytics.watchTimeChart[1].value, 45)
    assert.equal(analytics.countries[0].country, 'MX')
    assert.equal(analytics.heatmap[1].intensity, 80)

    const storageUploadRequest = bunny.requests.find(request => request.kind === 'storage-upload')
    assert.match(storageUploadRequest.path, /^\/storage\/central-zone\/accounts\/loc_mexico\/sites\//)
    const collectionRequest = bunny.requests.find(request => request.kind === 'stream-create-collection')
    assert.equal(collectionRequest.body.name, 'Ristak Sites & Forms / loc_mexico')
    const statisticsRequest = bunny.requests.find(request => request.kind === 'stream-statistics')
    assert.equal(statisticsRequest.videoGuid, 'stream-video-1')
    assert.equal(statisticsRequest.dateFrom, '2026-06-16')
    assert.equal(statisticsRequest.dateTo, '2026-06-17')
    assert.equal(statisticsRequest.hourly, 'true')
    assert.ok(bunny.requests.some(request => request.kind === 'stream-list-collections'))
    assert.ok(bunny.requests.some(request => request.kind === 'stream-create-collection'))
    assert.ok(bunny.requests.some(request => request.kind === 'stream-create-video'))
    assert.ok(bunny.requests.some(request => request.kind === 'stream-upload-video'))
    assert.ok(bunny.requests.some(request => request.kind === 'stream-heatmap'))
    assert.ok(bunny.requests.filter(request => request.kind === 'stream-get-video').length >= 2)
    assert.ok(bunny.requests.every(request => !request.accessKey || request.accessKey === 'stream-secret' || request.accessKey === 'storage-secret'))
  } finally {
    if (mediaAssetId) {
      const { softDeleteMediaAsset } = await import('../src/services/mediaStorageService.js')
      await softDeleteMediaAsset(mediaAssetId).catch(() => undefined)
    }
    if (db && mediaAssetId) {
      await db.run('DELETE FROM media_assets WHERE id = ?', [mediaAssetId]).catch(() => undefined)
    }
    bunny.close()
    restoreEnv(previousEnv)
  }
})

test('resync mueve videos existentes de Sites a la colección de la cuenta', async () => {
  const previousEnv = snapshotEnv()
  const bunny = await createBunnyMockServer()
  let db = null
  let mediaAssetId = ''

  try {
    configureBunnyEnv(bunny.baseUrl)

    const [mediaStorageService, database] = await Promise.all([
      import('../src/services/mediaStorageService.js'),
      import('../src/config/database.js')
    ])
    mediaStorageService.resetCentralStorageConfigCache()
    db = database.db

    const created = await mediaStorageService.uploadMediaAsset({
      buffer: Buffer.from('fake mp4 bytes uploaded before stream collections'),
      filename: 'legacy-video.mp4',
      mimeType: 'video/mp4',
      module: 'chat',
      moduleEntityId: 'conversation_legacy',
      businessId: 'default',
      clientAccountId: 'loc_repair',
      isPublic: true,
      skipCompression: true
    })
    mediaAssetId = created.id

    assert.equal(created.module, 'chat')
    assert.equal(created.metadata.stream, undefined)
    assert.equal(bunny.requests.some(request => request.kind === 'stream-create-video'), false)

    const legacyMetadata = {
      ...created.metadata,
      stream: {
        provider: 'bunny_stream',
        enabled: true,
        providerReady: true,
        syncStatus: 'uploaded',
        libraryId: '123',
        collectionId: '',
        collectionName: '',
        videoId: 'stream-video-1',
        title: 'Legacy video without collection',
        clientAccount: created.metadata.clientAccount,
        source: {
          mediaAssetId: created.id,
          businessId: created.businessId,
          clientAccountId: 'loc_repair',
          accountRootPath: 'accounts/loc_repair',
          module: 'sites',
          moduleEntityId: 'site_repair',
          storagePath: created.bunnyPath,
          storagePublicUrl: created.publicUrl,
          mimeType: created.mimeType
        }
      }
    }
    await db.run('UPDATE media_assets SET metadata_json = ? WHERE id = ?', [
      JSON.stringify(legacyMetadata),
      created.id
    ])

    const synced = await mediaStorageService.syncMediaAssetBunnyStream(created.id, {
      module: 'sites',
      moduleEntityId: 'site_repair'
    })

    assert.equal(synced.metadata.stream.syncStatus, 'synced')
    assert.equal(synced.metadata.stream.collectionId, 'collection-sites-forms')
    assert.equal(synced.metadata.stream.collectionName, 'Ristak Sites & Forms / loc_repair')
    assert.equal(synced.metadata.stream.clientAccount.id, 'loc_repair')
    assert.equal(synced.metadata.stream.source.clientAccountId, 'loc_repair')
    assert.equal(synced.metadata.stream.source.accountRootPath, 'accounts/loc_repair')
    assert.equal(synced.metadata.stream.video.collectionId, 'collection-sites-forms')

    const collectionRequest = bunny.requests.find(request => request.kind === 'stream-create-collection')
    assert.equal(collectionRequest.body.name, 'Ristak Sites & Forms / loc_repair')
    const updateRequest = bunny.requests.find(request => request.kind === 'stream-update-video')
    assert.equal(updateRequest.body.collectionId, 'collection-sites-forms')
    assert.equal(updateRequest.body.title, 'Legacy video without collection')
    assert.equal(bunny.requests.some(request => request.kind === 'stream-create-video'), false)
    assert.equal(bunny.requests.some(request => request.kind === 'stream-upload-video'), false)
  } finally {
    if (mediaAssetId) {
      const { softDeleteMediaAsset } = await import('../src/services/mediaStorageService.js')
      await softDeleteMediaAsset(mediaAssetId).catch(() => undefined)
    }
    if (db && mediaAssetId) {
      await db.run('DELETE FROM media_assets WHERE id = ?', [mediaAssetId]).catch(() => undefined)
    }
    bunny.close()
    restoreEnv(previousEnv)
  }
})

test('videos de Sites pueden diferir Bunny Stream sin bloquear la subida', async () => {
  const previousEnv = snapshotEnv()
  const bunny = await createBunnyMockServer()
  let db = null
  let mediaAssetId = ''

  try {
    configureBunnyEnv(bunny.baseUrl)

    const [mediaStorageService, database] = await Promise.all([
      import('../src/services/mediaStorageService.js'),
      import('../src/config/database.js')
    ])
    mediaStorageService.resetCentralStorageConfigCache()
    db = database.db

    const created = await mediaStorageService.uploadMediaAsset({
      buffer: Buffer.from('fake mp4 bytes for deferred bunny stream'),
      filename: 'deferred-video.mp4',
      mimeType: 'video/mp4',
      module: 'sites',
      moduleEntityId: 'site_deferred',
      businessId: 'default',
      clientAccountId: 'loc_deferred',
      isPublic: true,
      skipCompression: true,
      deferStreamSync: true
    })
    mediaAssetId = created.id

    assert.equal(created.mediaType, 'video')
    assert.equal(created.storageProvider, 'bunny')
    assert.equal(created.metadata.stream.syncStatus, 'pending')
    assert.equal(created.metadata.stream.provider, 'bunny_stream')
    assert.equal(created.metadata.stream.source.mediaAssetId, created.id)
    assert.equal(created.metadata.stream.source.clientAccountId, 'loc_deferred')
    assert.equal(created.metadata.stream.videoId, undefined)
    assert.equal(bunny.requests.some(request => request.kind === 'stream-upload-video'), false)

    const synced = await waitForValue(async () => {
      const asset = await mediaStorageService.getMediaAsset(created.id)
      return asset.metadata?.stream?.syncStatus === 'uploaded' ? asset : null
    }, { label: 'deferred Bunny Stream sync' })

    assert.equal(synced.metadata.stream.videoId, 'stream-video-1')
    assert.equal(synced.metadata.stream.clientAccount.id, 'loc_deferred')
    assert.ok(bunny.requests.some(request => request.kind === 'stream-create-video'))
    assert.ok(bunny.requests.some(request => request.kind === 'stream-upload-video'))
  } finally {
    if (mediaAssetId) {
      const { softDeleteMediaAsset } = await import('../src/services/mediaStorageService.js')
      await softDeleteMediaAsset(mediaAssetId).catch(() => undefined)
    }
    if (db && mediaAssetId) {
      await db.run('DELETE FROM media_assets WHERE id = ?', [mediaAssetId]).catch(() => undefined)
    }
    bunny.close()
    restoreEnv(previousEnv)
  }
})

test('videos fuera de Sites o Forms no se mandan a Bunny Stream', async () => {
  const previousEnv = snapshotEnv()
  const bunny = await createBunnyMockServer()
  let db = null
  let mediaAssetId = ''

  try {
    configureBunnyEnv(bunny.baseUrl)

    const [mediaStorageService, database] = await Promise.all([
      import('../src/services/mediaStorageService.js'),
      import('../src/config/database.js')
    ])
    mediaStorageService.resetCentralStorageConfigCache()
    db = database.db

    const created = await mediaStorageService.uploadMediaAsset({
      buffer: Buffer.from('fake mp4 bytes for chat'),
      filename: 'chat-video.mp4',
      mimeType: 'video/mp4',
      module: 'chat',
      moduleEntityId: 'conversation_1',
      businessId: 'default',
      isPublic: true,
      skipCompression: true
    })
    mediaAssetId = created.id

    assert.equal(created.mediaType, 'video')
    assert.equal(created.module, 'chat')
    assert.equal(created.metadata.stream, undefined)
    assert.equal(bunny.requests.some(request => request.kind.startsWith('stream-')), false)
  } finally {
    if (mediaAssetId) {
      const { softDeleteMediaAsset } = await import('../src/services/mediaStorageService.js')
      await softDeleteMediaAsset(mediaAssetId).catch(() => undefined)
    }
    if (db && mediaAssetId) {
      await db.run('DELETE FROM media_assets WHERE id = ?', [mediaAssetId]).catch(() => undefined)
    }
    bunny.close()
    restoreEnv(previousEnv)
  }
})

test('videos existentes en Bunny Storage se sincronizan a Bunny Stream al agregarlos a Sites', async () => {
  const previousEnv = snapshotEnv()
  const bunny = await createBunnyMockServer()
  let db = null
  let mediaAssetId = ''

  try {
    configureBunnyEnv(bunny.baseUrl)

    const [mediaStorageService, database] = await Promise.all([
      import('../src/services/mediaStorageService.js'),
      import('../src/config/database.js')
    ])
    mediaStorageService.resetCentralStorageConfigCache()
    db = database.db

    const created = await mediaStorageService.uploadMediaAsset({
      buffer: Buffer.from('fake mp4 bytes for existing media'),
      filename: 'existing-video.mp4',
      mimeType: 'video/mp4',
      module: 'chat',
      moduleEntityId: 'conversation_2',
      businessId: 'default',
      isPublic: true,
      skipCompression: true
    })
    mediaAssetId = created.id

    assert.equal(created.storageProvider, 'bunny')
    assert.equal(created.module, 'chat')
    assert.equal(created.metadata.stream, undefined)
    assert.equal(bunny.requests.some(request => request.kind.startsWith('stream-')), false)

    const synced = await mediaStorageService.syncMediaAssetBunnyStream(created.id, {
      module: 'sites',
      moduleEntityId: 'site_existing'
    })

    assert.equal(synced.module, 'chat')
    assert.equal(synced.metadata.stream.syncStatus, 'uploaded')
    assert.equal(synced.metadata.stream.provider, 'bunny_stream')
    assert.equal(synced.metadata.stream.source.mediaAssetId, created.id)
    assert.equal(synced.metadata.stream.source.module, 'sites')
    assert.equal(synced.metadata.stream.source.moduleEntityId, 'site_existing')
    assert.equal(synced.metadata.stream.videoId, 'stream-video-1')
    assert.ok(bunny.requests.some(request => request.kind === 'storage-get'))
    assert.ok(bunny.requests.some(request => request.kind === 'stream-create-video'))
    assert.ok(bunny.requests.some(request => request.kind === 'stream-upload-video'))
  } finally {
    if (mediaAssetId) {
      const { softDeleteMediaAsset } = await import('../src/services/mediaStorageService.js')
      await softDeleteMediaAsset(mediaAssetId).catch(() => undefined)
    }
    if (db && mediaAssetId) {
      await db.run('DELETE FROM media_assets WHERE id = ?', [mediaAssetId]).catch(() => undefined)
    }
    bunny.close()
    restoreEnv(previousEnv)
  }
})
