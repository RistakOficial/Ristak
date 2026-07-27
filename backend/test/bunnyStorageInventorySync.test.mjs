import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile } from 'node:fs/promises'

const ENV_KEYS = [
  'DATABASE_URL',
  'MEDIA_STORAGE_PROVIDER',
  'MEDIA_STORAGE_REQUIRE_BUNNY',
  'BUNNY_STORAGE_ZONE',
  'BUNNY_STORAGE_REGION',
  'BUNNY_STORAGE_ENDPOINT',
  'BUNNY_STORAGE_API_KEY',
  'BUNNY_CDN_BASE_URL',
  'BUNNY_STREAM_ENABLED'
]

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key]
    else process.env[key] = snapshot[key]
  }
}

async function createBunnyDirectoryMock({ accountRoot }) {
  const requests = []
  const rootPath = `/storage/inventory-zone/${accountRoot}/`
  const manualPath = `/storage/inventory-zone/${accountRoot}/Manual/`
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent(req.url || '')
    requests.push({ method: req.method, path })
    res.setHeader('Content-Type', 'application/json')

    if (req.method === 'GET' && path === rootPath) {
      res.end(JSON.stringify([
        {
          ObjectName: 'Manual',
          IsDirectory: true,
          Length: 0,
          Guid: 'folder-manual'
        },
        {
          ObjectName: '../escape',
          IsDirectory: true,
          Length: 0,
          Guid: 'folder-invalid'
        },
        {
          ObjectName: '_LEEME.txt',
          IsDirectory: false,
          Length: 80,
          Guid: 'technical-readme'
        },
        {
          ObjectName: 'nota manual.txt',
          IsDirectory: false,
          Length: 42,
          Guid: 'root-note',
          DateCreated: '2026-07-27T08:00:00Z',
          LastChanged: '2026-07-27T08:01:00Z'
        }
      ]))
      return
    }

    if (req.method === 'GET' && path === manualPath) {
      res.end(JSON.stringify([
        {
          ObjectName: 'Subcarpeta',
          IsDirectory: true,
          Length: 0,
          Guid: 'folder-nested'
        },
        {
          ObjectName: 'video manual.mp4',
          IsDirectory: false,
          Length: 1_000,
          Guid: 'manual-video'
        },
        {
          ObjectName: 'imagen manual.png',
          IsDirectory: false,
          Length: 2_000,
          Guid: 'manual-image'
        },
        {
          ObjectName: 'documento manual.pdf',
          IsDirectory: false,
          Length: 3_000,
          Guid: 'manual-document'
        },
        {
          ObjectName: 'rstk_media_existing-photo.webp',
          IsDirectory: false,
          Length: 222,
          Guid: 'existing-primary'
        },
        {
          ObjectName: 'rstk_media_existing-photo-thumb.webp',
          IsDirectory: false,
          Length: 22,
          Guid: 'existing-thumbnail'
        }
      ]))
      return
    }

    res.statusCode = 404
    res.end(JSON.stringify({ message: 'not found' }))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

test('sincroniza carpetas y archivos manuales de Bunny sólo dentro de la cuenta autorizada', async () => {
  const previousEnv = snapshotEnv()
  const marker = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const businessId = `bunny_inventory_${marker}`
  const clientAccountId = `cuenta_${marker}`
  const accountRoot = `accounts/${clientAccountId}`
  const existingAssetId = `existing_inventory_${marker}`
  const mock = await createBunnyDirectoryMock({ accountRoot })
  let db = null
  let media = null

  try {
    delete process.env.DATABASE_URL
    process.env.MEDIA_STORAGE_PROVIDER = 'bunny'
    process.env.MEDIA_STORAGE_REQUIRE_BUNNY = 'true'
    process.env.BUNNY_STORAGE_ZONE = 'inventory-zone'
    process.env.BUNNY_STORAGE_REGION = ''
    process.env.BUNNY_STORAGE_ENDPOINT = `${mock.baseUrl}/storage`
    process.env.BUNNY_STORAGE_API_KEY = 'inventory-test-secret'
    process.env.BUNNY_CDN_BASE_URL = `${mock.baseUrl}/cdn`
    process.env.BUNNY_STREAM_ENABLED = 'false'

    const [database, mediaStorageService] = await Promise.all([
      import('../src/config/database.js'),
      import('../src/services/mediaStorageService.js')
    ])
    db = database.db
    media = mediaStorageService
    media.resetCentralStorageConfigCache()
    media.resetAccountSlugCache()
    if (database.databaseDialect === 'sqlite') {
      const usageCounters = await readFile(
        new URL('../migrations/versioned/067c_media_usage_counters.sqlite.sql', import.meta.url),
        'utf8'
      )
      const folderCounters = await readFile(
        new URL('../migrations/versioned/067f_media_folder_counters.sqlite.sql', import.meta.url),
        'utf8'
      )
      await db.exec(usageCounters)
      await db.exec(folderCounters)
    }

    const existingPath = `${accountRoot}/Manual/rstk_media_existing-photo.webp`
    const thumbnailPath = `${accountRoot}/Manual/rstk_media_existing-photo-thumb.webp`
    await db.run(
      `INSERT INTO media_assets (
         id, business_id, original_filename, stored_filename,
         bunny_path, folder_path, public_url, mime_type, media_type, extension,
         size_original, size_processed, quota_size, status, storage_provider,
         storage_zone, cdn_base_url, module, is_public, metadata_json
       ) VALUES (
         ?, ?, 'existing-photo.webp', 'rstk_media_existing-photo.webp',
         ?, 'Manual', ?, 'image/webp', 'image', 'webp',
         100, 100, 100, 'ready', 'bunny',
         'inventory-zone', ?, 'media', 1, ?
       )`,
      [
        existingAssetId,
        businessId,
        existingPath,
        `${mock.baseUrl}/cdn/${existingPath}`,
        `${mock.baseUrl}/cdn`,
        JSON.stringify({
          variants: {
            thumbnail: {
              path: thumbnailPath,
              publicUrl: `${mock.baseUrl}/cdn/${thumbnailPath}`
            }
          }
        })
      ]
    )

    const [rootSyncA, rootSyncB] = await Promise.all([
      media.syncBunnyStorageFolder({ businessId, clientAccountId, folderPath: '' }),
      media.syncBunnyStorageFolder({ businessId, clientAccountId, folderPath: '' })
    ])
    assert.deepEqual(rootSyncA, rootSyncB)
    assert.equal(rootSyncA.status, 'ready')
    assert.equal(rootSyncA.accountRoot, accountRoot)
    assert.equal(rootSyncA.foldersDiscovered, 1)
    assert.equal(rootSyncA.assetsImported, 1)
    assert.equal(
      mock.requests.filter((request) => request.method === 'GET' && request.path.endsWith(`${accountRoot}/`)).length,
      1,
      'dos refresh simultáneos deben compartir la misma lectura de Bunny'
    )
    assert.equal(
      mock.requests.every((request) => request.path.includes(`/${accountRoot}/`)),
      true,
      'la sincronización nunca debe salir de accounts/<cuenta>'
    )

    const manualSync = await media.syncBunnyStorageFolder({
      businessId,
      clientAccountId,
      folderPath: 'Manual'
    })
    assert.equal(manualSync.foldersDiscovered, 1)
    assert.equal(manualSync.assetsImported, 3)
    assert.equal(manualSync.assetsUpdated, 1)
    assert.equal(manualSync.itemsSkipped, 1)

    const folders = await media.listMediaFolders({ businessId, parentPath: '' })
    assert.deepEqual(folders.items.map((folder) => folder.path), ['Manual'])
    const nestedFolders = await media.listMediaFolders({ businessId, parentPath: 'Manual' })
    assert.deepEqual(nestedFolders.items.map((folder) => folder.path), ['Manual/Subcarpeta'])

    const manualAssets = await media.listMediaAssets({
      businessId,
      folderPath: 'Manual',
      limit: 20
    })
    assert.equal(manualAssets.items.length, 4)
    assert.equal(
      manualAssets.items.some((asset) => asset.originalFilename.includes('-thumb.')),
      false,
      'un derivado técnico no debe aparecer como archivo independiente'
    )
    assert.equal(
      manualAssets.items.find((asset) => asset.originalFilename === 'video manual.mp4')?.mediaType,
      'video'
    )
    assert.equal(
      manualAssets.items.find((asset) => asset.originalFilename === 'imagen manual.png')?.mediaType,
      'image'
    )
    assert.equal(
      manualAssets.items.find((asset) => asset.originalFilename === 'documento manual.pdf')?.mediaType,
      'document'
    )
    assert.equal(
      manualAssets.items.find((asset) => asset.id === existingAssetId)?.quotaSize,
      222,
      'un asset ya registrado debe actualizarse, no duplicarse'
    )

    const secondManualSync = await media.syncBunnyStorageFolder({
      businessId,
      clientAccountId,
      folderPath: 'Manual'
    })
    assert.equal(secondManualSync.assetsImported, 0)
    assert.equal(secondManualSync.assetsUpdated, 4)
    const duplicateCheck = await db.get(
      `SELECT COUNT(*) AS total
       FROM media_assets
       WHERE business_id = ? AND bunny_path = ?`,
      [businessId, existingPath]
    )
    assert.equal(Number(duplicateCheck.total), 1)
  } finally {
    if (db) {
      await db.run('DELETE FROM media_assets WHERE business_id = ?', [businessId]).catch(() => undefined)
      await db.run('DELETE FROM media_folders WHERE business_id = ?', [businessId]).catch(() => undefined)
      await db.run('DELETE FROM storage_quotas WHERE business_id = ?', [businessId]).catch(() => undefined)
    }
    media?.resetCentralStorageConfigCache()
    media?.resetAccountSlugCache()
    await mock.close()
    restoreEnv(previousEnv)
  }
})

test('Sites y Configuración > Media piden refresco de proveedor sin cambiar el markup visual', async () => {
  const [routesSource, controllerSource, frontendServiceSource, sitesSource, mediaSettingsSource] = await Promise.all([
    readFile(new URL('../src/routes/media.routes.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/controllers/mediaController.js', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/services/mediaService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/pages/Sites/Sites.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/pages/Settings/MediaSettings.tsx', import.meta.url), 'utf8')
  ])

  assert.match(routesSource, /router\.post\('\/folders\/sync'[^]*syncBunnyStorageFolderHandler\)/)
  assert.match(controllerSource, /syncBunnyStorageFolder\(\{[^]*folderPath:/)
  assert.match(frontendServiceSource, /syncProvider\?: boolean/)
  assert.match(frontendServiceSource, /apiClient\.post<MediaProviderFolderSync>\('\/media\/folders\/sync'/)
  assert.match(sitesSource, /syncProvider: !debouncedQuery/)
  assert.match(sitesSource, /syncProvider: true/)
  assert.match(mediaSettingsSource, /syncProvider: requestedFolderPath !== null/)
})
