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
  'BUNNY_STREAM_ENABLED',
  'BUNNY_STREAM_LIBRARY_ID',
  'BUNNY_STREAM_API_KEY',
  'BUNNY_STREAM_COLLECTION_ID',
  'BUNNY_STREAM_COLLECTION_NAME',
  'BUNNY_STREAM_ENDPOINT',
  'BUNNY_STREAM_TIMEOUT_MS',
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

async function createBunnyMockServer() {
  const requests = []
  let baseUrl = ''

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
          collectionId: body.collectionId
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
          title: 'Hero video (sites) site_1',
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
          collectionId: 'collection-sites-forms',
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
  delete process.env.BUNNY_STREAM_COLLECTION_ID
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
      isPublic: true,
      skipCompression: true
    })
    mediaAssetId = created.id

    assert.equal(created.mediaType, 'video')
    assert.equal(created.storageProvider, 'bunny')
    assert.equal(created.metadata.stream.syncStatus, 'uploaded')
    assert.equal(created.metadata.stream.provider, 'bunny_stream')
    assert.equal(created.metadata.stream.libraryId, '123')
    assert.equal(created.metadata.stream.collectionId, 'collection-sites-forms')
    assert.equal(created.metadata.stream.collectionName, 'Ristak Sites & Forms')
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

    assert.ok(bunny.requests.some(request => request.kind === 'stream-list-collections'))
    assert.ok(bunny.requests.some(request => request.kind === 'stream-create-collection'))
    assert.ok(bunny.requests.some(request => request.kind === 'stream-create-video'))
    assert.ok(bunny.requests.some(request => request.kind === 'stream-upload-video'))
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
