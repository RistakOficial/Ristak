import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'

const ENV_KEYS = [
  'DATABASE_URL',
  'MEDIA_STORAGE_PROVIDER',
  'MEDIA_STORAGE_REQUIRE_BUNNY',
  'BUNNY_STORAGE_ZONE',
  'BUNNY_STORAGE_REGION',
  'BUNNY_STORAGE_ENDPOINT',
  'BUNNY_STORAGE_API_KEY',
  'BUNNY_CDN_BASE_URL'
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

async function pathExists(path) {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

async function withLocalMediaTest(run) {
  const previousEnv = snapshotEnv()
  const businessId = `media-rename-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const assetIds = []
  let db = null
  let mediaStorageService = null

  try {
    delete process.env.DATABASE_URL
    delete process.env.MEDIA_STORAGE_REQUIRE_BUNNY
    delete process.env.BUNNY_STORAGE_ZONE
    delete process.env.BUNNY_STORAGE_REGION
    delete process.env.BUNNY_STORAGE_ENDPOINT
    delete process.env.BUNNY_STORAGE_API_KEY
    delete process.env.BUNNY_CDN_BASE_URL
    process.env.MEDIA_STORAGE_PROVIDER = 'local'

    const [loadedMediaStorageService, database] = await Promise.all([
      import('../src/services/mediaStorageService.js'),
      import('../src/config/database.js')
    ])
    mediaStorageService = loadedMediaStorageService
    db = database.db
    if (database.databaseDialect === 'sqlite') {
      const folderCounters = await fs.readFile(
        new URL('../migrations/versioned/067f_media_folder_counters.sqlite.sql', import.meta.url),
        'utf8'
      )
      await db.exec(folderCounters)
    }
    mediaStorageService.resetCentralStorageConfigCache()

    await run({
      businessId,
      db,
      mediaStorageService,
      trackAsset: (asset) => {
        assetIds.push(asset.id)
        return asset
      }
    })
  } finally {
    if (mediaStorageService) {
      for (const assetId of assetIds) {
        await mediaStorageService.softDeleteMediaAsset(assetId).catch(() => undefined)
      }
    }
    if (db) {
      if (assetIds.length) {
        await db.run(
          `DELETE FROM media_assets WHERE id IN (${assetIds.map(() => '?').join(', ')})`,
          assetIds
        ).catch(() => undefined)
      }
      await db.run('DELETE FROM media_folders WHERE business_id = ?', [businessId]).catch(() => undefined)
      await db.run('DELETE FROM storage_quotas WHERE business_id = ?', [businessId]).catch(() => undefined)
    }
    mediaStorageService?.resetCentralStorageConfigCache()
    restoreEnv(previousEnv)
  }
}

test('renameMediaAsset cambia sólo el nombre visible y conserva el archivo físico y su URL', async () => {
  await withLocalMediaTest(async ({ businessId, mediaStorageService, trackAsset }) => {
    const asset = trackAsset(await mediaStorageService.uploadMediaAsset({
      buffer: Buffer.from('reporte original'),
      filename: 'reporte.pdf',
      mimeType: 'application/pdf',
      module: 'media',
      folderPath: 'Clientes',
      businessId,
      skipCompression: true
    }))
    const duplicate = trackAsset(await mediaStorageService.uploadMediaAsset({
      buffer: Buffer.from('otro reporte'),
      filename: 'otro.pdf',
      mimeType: 'application/pdf',
      module: 'media',
      folderPath: 'Clientes',
      businessId,
      skipCompression: true
    }))

    const renamed = await mediaStorageService.renameMediaAsset({
      assetId: asset.id,
      businessId,
      name: 'Reporte final'
    })

    assert.equal(renamed.originalFilename, 'Reporte final.pdf')
    assert.equal(renamed.bunnyPath, asset.bunnyPath)
    assert.equal(renamed.publicUrl, asset.publicUrl)
    assert.equal(renamed.metadata.localPath, asset.metadata.localPath)
    assert.equal(await pathExists(renamed.metadata.localPath), true)

    const readable = await mediaStorageService.getMediaAssetReadStream(asset.id)
    assert.equal(readable.filename, 'Reporte final.pdf')
    readable.stream.destroy?.()

    await assert.rejects(
      mediaStorageService.renameMediaAsset({
        assetId: duplicate.id,
        businessId,
        name: 'Reporte final.pdf'
      }),
      (error) => error?.code === 'media_asset_name_exists'
    )
    await assert.rejects(
      mediaStorageService.renameMediaAsset({
        assetId: duplicate.id,
        businessId,
        name: 'archivo.txt'
      }),
      (error) => error?.code === 'media_asset_extension_mismatch'
    )
    await assert.rejects(
      mediaStorageService.renameMediaAsset({
        assetId: duplicate.id,
        businessId,
        name: '../otro.pdf'
      }),
      (error) => error?.code === 'invalid_media_asset_name'
    )
    await assert.rejects(
      mediaStorageService.renameMediaAsset({
        assetId: duplicate.id,
        businessId: `${businessId}-ajena`,
        name: 'No permitido.pdf'
      }),
      (error) => error?.code === 'media_not_found'
    )
  })
})

test('renameMediaFolder cambia el nombre visible sin mover archivos, rutas ni URLs', async () => {
  await withLocalMediaTest(async ({ businessId, db, mediaStorageService, trackAsset }) => {
    const asset = trackAsset(await mediaStorageService.uploadMediaAsset({
      buffer: Buffer.from('archivo dentro de subcarpeta'),
      filename: 'brief.txt',
      mimeType: 'text/plain',
      module: 'media',
      folderPath: 'Clientes/Original/Subcarpeta',
      businessId,
      skipCompression: true
    }))
    await mediaStorageService.createMediaFolder({
      businessId,
      parentPath: 'Clientes/Original',
      name: 'Vacía'
    })
    await mediaStorageService.createMediaFolder({
      businessId,
      parentPath: 'Clientes',
      name: 'Existente'
    })

    await assert.rejects(
      mediaStorageService.renameMediaFolder({
        businessId,
        folderPath: 'Clientes/Original',
        name: 'Existente'
      }),
      (error) => error?.code === 'media_folder_exists'
    )

    const beforeLocalPath = asset.metadata.localPath
    await db.run(
      `UPDATE media_assets
       SET storage_provider = 'bunny', quota_size = ?
       WHERE id = ?`,
      [65 * 1024 * 1024, asset.id]
    )

    let result
    try {
      result = await mediaStorageService.renameMediaFolder({
        businessId,
        folderPath: 'Clientes/Original',
        name: 'Proyecto iPhone VIP'
      })
    } finally {
      await db.run(
        `UPDATE media_assets
         SET storage_provider = 'local', quota_size = size_processed
         WHERE id = ?`,
        [asset.id]
      )
    }
    const renamedAsset = await mediaStorageService.getMediaAsset(asset.id)

    assert.equal(result.folder.previousPath, 'Clientes/Original')
    assert.equal(result.folder.path, 'Clientes/Original')
    assert.equal(result.folder.name, 'Proyecto iPhone VIP')
    assert.equal(result.foldersAffected, 1)
    assert.equal(renamedAsset.folderPath, 'Clientes/Original/Subcarpeta')
    assert.equal(renamedAsset.bunnyPath, asset.bunnyPath)
    assert.equal(renamedAsset.publicUrl, asset.publicUrl)
    assert.equal(renamedAsset.metadata.localPath, beforeLocalPath)
    assert.equal(await pathExists(beforeLocalPath), true)

    const folderRows = await db.all(
      `SELECT path, name FROM media_folders
       WHERE business_id = ? AND (path = ? OR path LIKE ?)`,
      [businessId, 'Clientes/Original', 'Clientes/Original/%']
    )
    assert.deepEqual(
      folderRows.sort((left, right) => left.path.localeCompare(right.path)),
      [
        { path: 'Clientes/Original', name: 'Proyecto iPhone VIP' },
        { path: 'Clientes/Original/Subcarpeta', name: 'Subcarpeta' },
        { path: 'Clientes/Original/Vacía', name: 'Vacía' }
      ]
    )

    const parentFolders = await mediaStorageService.listMediaFolders({
      businessId,
      parentPath: 'Clientes'
    })
    assert.deepEqual(
      parentFolders.items.find((folder) => folder.path === 'Clientes/Original'),
      {
        path: 'Clientes/Original',
        name: 'Proyecto iPhone VIP',
        filesCount: 1,
        sizeBytes: asset.quotaSize
      }
    )
    assert.equal(
      (await mediaStorageService.listMediaFolders({
        businessId,
        parentPath: 'Clientes',
        mediaType: 'document'
      })).items.find((folder) => folder.path === 'Clientes/Original')?.name,
      'Proyecto iPhone VIP'
    )

    const childFolders = await mediaStorageService.listMediaFolders({
      businessId,
      parentPath: 'Clientes/Original'
    })
    assert.deepEqual(childFolders.breadcrumbs, [
      { path: 'Clientes', name: 'Clientes' },
      { path: 'Clientes/Original', name: 'Proyecto iPhone VIP' }
    ])

    trackAsset(await mediaStorageService.uploadMediaAsset({
      buffer: Buffer.from('archivo agregado después del cambio de nombre'),
      filename: 'nuevo.txt',
      mimeType: 'text/plain',
      module: 'media',
      folderPath: 'Clientes/Original',
      businessId,
      skipCompression: true
    }))
    const folderAfterUpload = (await mediaStorageService.listMediaFolders({
      businessId,
      parentPath: 'Clientes'
    })).items.find((folder) => folder.path === 'Clientes/Original')
    assert.equal(folderAfterUpload?.name, 'Proyecto iPhone VIP')

    await assert.rejects(
      mediaStorageService.createMediaFolder({
        businessId,
        parentPath: 'Clientes',
        name: 'proyecto iphone vip'
      }),
      (error) => error?.code === 'media_folder_exists'
    )

    const moved = await mediaStorageService.moveMediaSelection({
      businessId,
      folderPaths: ['Clientes/Original'],
      targetFolderPath: 'Archivo'
    })
    assert.equal(moved.affected, 2)
    assert.equal(
      (await mediaStorageService.listMediaFolders({
        businessId,
        parentPath: 'Archivo'
      })).items.find((folder) => folder.path === 'Archivo/Original')?.name,
      'Proyecto iPhone VIP'
    )
    assert.deepEqual(
      (await mediaStorageService.listMediaFolders({
        businessId,
        parentPath: 'Archivo/Original'
      })).breadcrumbs,
      [
        { path: 'Archivo', name: 'Archivo' },
        { path: 'Archivo/Original', name: 'Proyecto iPhone VIP' }
      ]
    )
  })
})
