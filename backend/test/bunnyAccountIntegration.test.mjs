import assert from 'node:assert/strict'
import http from 'node:http'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { db } from '../src/config/database.js'
import { initializeMasterKey } from '../src/utils/encryption.js'
import {
  bunnyAccountIntegrationConfigKey,
  bunnyIntegrationRuntimeConfig,
  clearBunnyAccountIntegration,
  getBunnyAccountIntegrationStatus,
  provisionBunnyAccount,
  readBunnyAccountIntegration,
  resetBunnyAccountIntegrationCache
} from '../src/services/bunnyAccountIntegrationService.js'
import {
  migrateMediaAssetToBunnyStorage,
  retryMediaAssetSourceCleanup,
  retryMediaAssetStreamSourceCleanup
} from '../src/services/mediaStorageService.js'

const ACCOUNT_API_KEY = 'test-account-api-key-abcdefghijklmnopqrstuvwxyz'
const ROTATED_ACCOUNT_API_KEY = 'test-account-api-key-rotated-abcdefghijklmnopqrstuvwxyz'
const STORAGE_KEY = 'test-storage-zone-password'
const STREAM_KEY = 'test-stream-library-password'

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function startBunnyFixture() {
  const fixture = {
    storageZones: [],
    pullZones: [],
    libraries: [],
    requests: []
  }
  const server = http.createServer((req, res) => {
    let rawBody = ''
    req.on('data', (chunk) => { rawBody += chunk })
    req.on('end', () => {
      const body = rawBody ? JSON.parse(rawBody) : null
      fixture.requests.push({ method: req.method, url: req.url, accessKey: req.headers.accesskey, body })

      if (req.method === 'GET' && req.url === '/storagezone') return json(res, 200, fixture.storageZones)
      if (req.method === 'POST' && req.url === '/storagezone') {
        const zone = {
          Id: 321,
          Name: body.Name,
          Password: STORAGE_KEY,
          Region: body.Region,
          PullZones: []
        }
        fixture.storageZones.push(zone)
        return json(res, 201, zone)
      }
      if (req.method === 'GET' && req.url === '/pullzone') return json(res, 200, fixture.pullZones)
      if (req.method === 'POST' && req.url === '/pullzone') {
        const pullZone = {
          Id: 654,
          Name: body.Name,
          StorageZoneId: body.StorageZoneId,
          Hostnames: [{ Value: 'ristak-test.b-cdn.net', IsSystemHostname: true }]
        }
        fixture.pullZones.push(pullZone)
        return json(res, 201, pullZone)
      }
      if (req.method === 'GET' && req.url === '/videolibrary?page=1&perPage=1000') {
        return json(res, 200, { Items: fixture.libraries })
      }
      if (req.method === 'POST' && req.url === '/videolibrary') {
        const library = { Id: 987, Name: body.Name, ApiKey: STREAM_KEY }
        fixture.libraries.push(library)
        return json(res, 201, library)
      }
      if (req.method === 'GET' && req.url === '/videolibrary/987') {
        return json(res, 200, fixture.libraries[0])
      }
      return json(res, 404, { Message: 'Not found' })
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    fixture,
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function snapshotConfig() {
  return db.get('SELECT config_value FROM app_config WHERE config_key = ?', [bunnyAccountIntegrationConfigKey])
}

async function restoreConfig(snapshot) {
  await db.run('DELETE FROM app_config WHERE config_key = ?', [bunnyAccountIntegrationConfigKey])
  if (snapshot?.config_value) {
    await db.run(
      `INSERT INTO app_config (config_key, config_value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)`,
      [bunnyAccountIntegrationConfigKey, snapshot.config_value]
    )
  }
  resetBunnyAccountIntegrationCache()
}

test('Bunny.net se aprovisiona con una sola Account API Key y persiste todos los secretos cifrados', async () => {
  await initializeMasterKey()
  const snapshot = await snapshotConfig()
  const server = await startBunnyFixture()

  try {
    await clearBunnyAccountIntegration()
    const currentConfig = {
      bunnyStorageZone: 'installer-managed-zone',
      bunnyStreamLibraryId: 'installer-managed-library'
    }
    const integration = await provisionBunnyAccount(ACCOUNT_API_KEY, currentConfig, {
      coreEndpoint: server.endpoint
    })

    assert.equal(integration.storageZoneId, '321')
    assert.equal(integration.storageApiKey, STORAGE_KEY)
    assert.equal(integration.streamLibraryId, '987')
    assert.equal(integration.streamApiKey, STREAM_KEY)
    assert.equal(integration.cdnBaseUrl, 'https://ristak-test.b-cdn.net')
    assert.equal(integration.sameStorageAsManaged, false)
    assert.equal(integration.sameStreamAsManaged, false)

    const methods = server.fixture.requests.map((request) => `${request.method} ${request.url}`)
    assert.ok(methods.includes('POST /storagezone'))
    assert.ok(methods.includes('POST /pullzone'))
    assert.ok(methods.includes('POST /videolibrary'))
    assert.ok(server.fixture.requests.every((request) => request.accessKey === ACCOUNT_API_KEY))

    const persisted = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      [bunnyAccountIntegrationConfigKey]
    )
    assert.ok(persisted?.config_value)
    assert.equal(persisted.config_value.includes(ACCOUNT_API_KEY), false)
    assert.equal(persisted.config_value.includes(STORAGE_KEY), false)
    assert.equal(persisted.config_value.includes(STREAM_KEY), false)

    const reopened = await readBunnyAccountIntegration()
    assert.equal(reopened.accountApiKey, ACCOUNT_API_KEY)
    assert.equal(reopened.storageApiKey, STORAGE_KEY)
    assert.equal(reopened.streamApiKey, STREAM_KEY)

    const status = await getBunnyAccountIntegrationStatus()
    assert.equal(status.connected, true)
    assert.equal(status.apiKeyPreview, `••••${ACCOUNT_API_KEY.slice(-4)}`)
    assert.equal(JSON.stringify(status).includes(ACCOUNT_API_KEY), false)

    const runtime = bunnyIntegrationRuntimeConfig(reopened)
    assert.equal(runtime.customerOwnedStorage, true)
    assert.equal(runtime.bunnyConfigured, true)
    assert.equal(runtime.bunnyStreamConfigured, true)

    server.fixture.requests.length = 0
    await provisionBunnyAccount(ROTATED_ACCOUNT_API_KEY, currentConfig, {
      coreEndpoint: server.endpoint
    })
    assert.equal(server.fixture.requests.some((request) => request.method === 'POST'), false)
    assert.equal((await readBunnyAccountIntegration()).accountApiKey, ROTATED_ACCOUNT_API_KEY)

    server.fixture.storageZones = []
    await assert.rejects(
      provisionBunnyAccount('test-other-account-api-key-abcdefghijklmnopqrstuvwxyz', currentConfig, {
        coreEndpoint: server.endpoint
      }),
      (error) => error?.status === 409 && error?.code === 'bunny_account_change_requires_disconnect'
    )
  } finally {
    await server.close()
    await restoreConfig(snapshot)
  }
})

test('Bunny.net reutiliza los recursos administrados cuando la cuenta es la misma', async () => {
  await initializeMasterKey()
  const snapshot = await snapshotConfig()
  const server = await startBunnyFixture()

  try {
    await clearBunnyAccountIntegration()
    server.fixture.storageZones = [{
      Id: 721,
      Name: 'installer-zone',
      Password: STORAGE_KEY,
      Region: 'NY',
      PullZones: [{
        Id: 722,
        Name: 'installer-cdn',
        StorageZoneId: 721,
        Hostnames: [{ Value: 'installer.b-cdn.net', IsSystemHostname: true }]
      }]
    }]
    server.fixture.libraries = [{ Id: 723, Name: 'Installer Stream', ApiKey: STREAM_KEY }]

    const integration = await provisionBunnyAccount(ACCOUNT_API_KEY, {
      bunnyStorageZone: 'installer-zone',
      bunnyStreamLibraryId: '723'
    }, { coreEndpoint: server.endpoint })

    assert.equal(integration.sameStorageAsManaged, true)
    assert.equal(integration.sameStreamAsManaged, true)
    assert.equal(integration.migration.status, 'completed')
    assert.equal(server.fixture.requests.some((request) => request.method === 'POST'), false)
  } finally {
    await server.close()
    await restoreConfig(snapshot)
  }
})

test('la migración copia, verifica y sólo después elimina el archivo local', async () => {
  const localDirectory = await mkdtemp(join(tmpdir(), 'ristak-bunny-migration-'))
  const localPath = join(localDirectory, 'original.txt')
  const body = Buffer.from('archivo local para migracion segura')
  const assetId = `bunny_migration_${Date.now()}`
  const objectPath = `accounts/test/document/2026/08/${assetId}.txt`
  const storedObjects = new Map()
  let endpoint = ''
  const storageServer = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url || '/', endpoint).pathname)
    if (req.method === 'PUT') {
      const chunks = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      storedObjects.set(pathname, Buffer.concat(chunks))
      res.statusCode = 201
      res.end('ok')
      return
    }
    if (req.method === 'HEAD') {
      const stored = storedObjects.get(pathname)
      if (!stored) {
        res.statusCode = 404
        res.end()
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Length', String(stored.length))
      res.end()
      return
    }
    res.statusCode = 404
    res.end()
  })

  await writeFile(localPath, body)
  await new Promise((resolve) => storageServer.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${storageServer.address().port}`

  try {
    await db.run(
      `INSERT INTO media_assets (
         id, business_id, original_filename, stored_filename, bunny_path, folder_path,
         public_url, private_url, mime_type, media_type, extension,
         size_original, size_processed, quota_size, status, storage_provider,
         module, is_public, metadata_json, created_at, updated_at
       ) VALUES (?, 'default', ?, ?, ?, 'Documentos', ?, ?, 'text/plain', 'document', 'txt',
         ?, ?, ?, 'ready', 'local', 'media', 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        assetId,
        'original.txt',
        `${assetId}.txt`,
        objectPath,
        `/api/media/assets/${assetId}/file`,
        `/api/media/assets/${assetId}/file`,
        body.length,
        body.length,
        body.length,
        JSON.stringify({ localPath, localFallback: true, variants: {} })
      ]
    )

    const result = await migrateMediaAssetToBunnyStorage(assetId, {
      targetConfig: {
        bunnyConfigured: true,
        bunnyStorageZone: 'customer-zone',
        bunnyStorageRegion: 'DE',
        bunnyStorageEndpoint: `${endpoint}/storage`,
        bunnyStorageApiKey: 'limited-storage-key',
        bunnyCdnBaseUrl: 'https://customer-zone.b-cdn.net'
      }
    })

    assert.equal(result.migrated, true)
    assert.equal(result.sourceDeleted, true)
    assert.deepEqual(
      storedObjects.get(`/storage/customer-zone/${objectPath}`),
      body
    )
    await assert.rejects(access(localPath))

    const row = await db.get(
      'SELECT storage_provider, storage_zone, cdn_base_url, public_url, metadata_json FROM media_assets WHERE id = ?',
      [assetId]
    )
    assert.equal(row.storage_provider, 'bunny')
    assert.equal(row.storage_zone, 'customer-zone')
    assert.equal(row.cdn_base_url, 'https://customer-zone.b-cdn.net')
    assert.equal(row.public_url, `https://customer-zone.b-cdn.net/${objectPath}`)
    assert.equal(JSON.parse(row.metadata_json).storageMigration.sourceDeleted, true)
  } finally {
    await db.run('DELETE FROM media_assets WHERE id = ?', [assetId]).catch(() => undefined)
    await rm(localDirectory, { recursive: true, force: true })
    await new Promise((resolve) => storageServer.close(() => resolve()))
  }
})

test('la limpieza pendiente de Storage y Stream es reintentable sin perder la copia nueva', async () => {
  const storageAssetId = `bunny_storage_cleanup_${Date.now()}`
  const streamAssetId = `bunny_stream_cleanup_${Date.now()}`
  const objectPath = `accounts/test/document/2026/08/${storageAssetId}.txt`
  const deleteAttempts = new Map()
  let endpoint = ''
  const cleanupServer = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url || '/', endpoint).pathname)
    const attempts = (deleteAttempts.get(pathname) || 0) + 1
    deleteAttempts.set(pathname, attempts)
    res.statusCode = attempts === 1 ? 500 : 200
    res.end(attempts === 1 ? 'temporary failure' : 'deleted')
  })

  await new Promise((resolve) => cleanupServer.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${cleanupServer.address().port}`

  try {
    await db.run(
      `INSERT INTO media_assets (
         id, business_id, original_filename, stored_filename, bunny_path, folder_path,
         public_url, mime_type, media_type, extension, size_original, size_processed,
         quota_size, status, storage_provider, storage_zone, cdn_base_url, module,
         is_public, metadata_json, created_at, updated_at
       ) VALUES (?, 'default', 'storage-cleanup.txt', 'storage-cleanup.txt', ?, 'Documentos',
         ?, 'text/plain', 'document', 'txt', 12, 12, 12, 'ready', 'bunny',
         'customer-zone', 'https://customer-zone.b-cdn.net', 'media', 1, ?,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        storageAssetId,
        objectPath,
        `https://customer-zone.b-cdn.net/${objectPath}`,
        JSON.stringify({
          storageMigration: {
            source: {
              provider: 'bunny',
              storageZone: 'managed-zone',
              objectPath
            },
            target: {
              provider: 'bunny',
              storageZone: 'customer-zone',
              objectPath
            },
            sourceDeleted: false
          }
        })
      ]
    )
    await db.run(
      `INSERT INTO media_assets (
         id, business_id, original_filename, stored_filename, bunny_path, folder_path,
         public_url, mime_type, media_type, extension, size_original, size_processed,
         quota_size, status, storage_provider, storage_zone, cdn_base_url, module,
         is_public, metadata_json, stream_video_id, created_at, updated_at
       ) VALUES (?, 'default', 'stream-cleanup.mp4', 'stream-cleanup.mp4', ?, 'Videos',
         ?, 'video/mp4', 'video', 'mp4', 20, 20, 20, 'ready', 'bunny',
         'customer-zone', 'https://customer-zone.b-cdn.net', 'media', 1, ?, ?,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        streamAssetId,
        `accounts/test/video/2026/08/${streamAssetId}.mp4`,
        `https://customer-zone.b-cdn.net/accounts/test/video/2026/08/${streamAssetId}.mp4`,
        JSON.stringify({
          stream: {
            libraryId: 'new-library',
            videoId: 'new-video',
            migrationSource: {
              libraryId: 'old-library',
              videoId: 'old-video',
              sourceDeleted: false
            }
          }
        }),
        'new-video'
      ]
    )

    const storageSourceConfig = {
      bunnyConfigured: true,
      bunnyStorageZone: 'managed-zone',
      bunnyStorageEndpoint: `${endpoint}/storage`,
      bunnyStorageApiKey: 'managed-storage-key'
    }
    await assert.rejects(
      retryMediaAssetSourceCleanup(storageAssetId, { sourceConfig: storageSourceConfig }),
      (error) => error?.code === 'bunny_delete_failed'
    )
    assert.equal(
      JSON.parse((await db.get('SELECT metadata_json FROM media_assets WHERE id = ?', [storageAssetId])).metadata_json)
        .storageMigration.sourceDeleted,
      false
    )
    assert.equal(
      (await retryMediaAssetSourceCleanup(storageAssetId, { sourceConfig: storageSourceConfig })).cleaned,
      true
    )

    const streamSourceConfig = {
      bunnyStreamConfigured: true,
      bunnyStreamLibraryId: 'old-library',
      bunnyStreamApiKey: 'old-stream-key',
      bunnyStreamEndpoint: endpoint
    }
    await assert.rejects(
      retryMediaAssetStreamSourceCleanup(streamAssetId, { sourceConfig: streamSourceConfig }),
      (error) => error?.code === 'bunny_stream_request_failed'
    )
    assert.equal(
      (await retryMediaAssetStreamSourceCleanup(streamAssetId, { sourceConfig: streamSourceConfig })).cleaned,
      true
    )

    const streamMetadata = JSON.parse(
      (await db.get('SELECT metadata_json FROM media_assets WHERE id = ?', [streamAssetId])).metadata_json
    )
    assert.equal(streamMetadata.stream.videoId, 'new-video')
    assert.equal(streamMetadata.stream.migrationSource.sourceDeleted, true)
    assert.equal(deleteAttempts.get(`/library/old-library/videos/old-video`), 2)
  } finally {
    await db.run('DELETE FROM media_assets WHERE id IN (?, ?)', [storageAssetId, streamAssetId]).catch(() => undefined)
    await new Promise((resolve) => cleanupServer.close(() => resolve()))
  }
})
