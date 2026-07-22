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
  'BUNNY_CDN_BASE_URL',
  'RISTAK_CLIENT_ACCOUNT_ID',
  'CLIENT_ACCOUNT_ID'
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

async function exists(path) {
  if (!path) return false
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

test('moveMediaAssets reubica archivos locales y conserva lectura por metadata', async () => {
  const previousEnv = snapshotEnv()
  let db = null
  let mediaStorageService = null
  let mediaAssetId = ''
  let previousStorageSettings = null

  try {
    delete process.env.DATABASE_URL
    delete process.env.MEDIA_STORAGE_REQUIRE_BUNNY
    delete process.env.BUNNY_STORAGE_ZONE
    delete process.env.BUNNY_STORAGE_REGION
    delete process.env.BUNNY_STORAGE_ENDPOINT
    delete process.env.BUNNY_STORAGE_API_KEY
    delete process.env.BUNNY_CDN_BASE_URL
    delete process.env.RISTAK_CLIENT_ACCOUNT_ID
    delete process.env.CLIENT_ACCOUNT_ID
    process.env.MEDIA_STORAGE_PROVIDER = 'local'

    const [loadedMediaStorageService, database] = await Promise.all([
      import('../src/services/mediaStorageService.js'),
      import('../src/config/database.js')
    ])
    mediaStorageService = loadedMediaStorageService
    db = database.db
    previousStorageSettings = await db.get(
      'SELECT account_slug, account_label FROM storage_settings WHERE id = 1'
    )
    process.env.RISTAK_CLIENT_ACCOUNT_ID = 'cuenta_principal'
    await db.run(
      `UPDATE storage_settings
       SET account_slug = 'tenant-principal', account_label = 'Tenant principal'
       WHERE id = 1`
    )
    mediaStorageService.resetAccountSlugCache()
    mediaStorageService.resetCentralStorageConfigCache()

    const created = await mediaStorageService.uploadMediaAsset({
      buffer: Buffer.from('contenido para mover'),
      filename: 'contrato.txt',
      mimeType: 'text/plain',
      module: 'documents',
      businessId: 'default',
      clientAccountId: 'cuenta_local',
      skipCompression: true
    })
    mediaAssetId = created.id
    const beforeLocalPath = created.metadata.localPath
    assert.ok(await exists(beforeLocalPath), 'el archivo local inicial debe existir')

    const [moved] = await mediaStorageService.moveMediaAssets({
      businessId: 'default',
      assetIds: [created.id],
      targetFolderPath: 'media/clientes'
    })

    assert.match(created.bunnyPath, /^accounts\/cuenta_local\/documents\//)
    assert.match(moved.bunnyPath, /^accounts\/cuenta_local\/media\/clientes\//)
    assert.notEqual(moved.bunnyPath, created.bunnyPath)
    assert.ok(moved.metadata.localPath)
    assert.notEqual(moved.metadata.localPath, beforeLocalPath)
    assert.equal(await exists(beforeLocalPath), false, 'la ruta vieja no debe seguir como archivo activo')
    assert.ok(await exists(moved.metadata.localPath), 'la ruta nueva debe existir')

    const readable = await mediaStorageService.getMediaAssetBuffer(created.id)
    assert.equal(readable.buffer.toString('utf8'), 'contenido para mover')
  } finally {
    if (mediaAssetId) {
      const { softDeleteMediaAsset } = await import('../src/services/mediaStorageService.js')
      await softDeleteMediaAsset(mediaAssetId).catch(() => undefined)
    }
    if (db && mediaAssetId) {
      await db.run('DELETE FROM media_assets WHERE id = ?', [mediaAssetId]).catch(() => undefined)
    }
    if (db && previousStorageSettings) {
      await db.run(
        `UPDATE storage_settings
         SET account_slug = ?, account_label = ?
         WHERE id = 1`,
        [previousStorageSettings.account_slug, previousStorageSettings.account_label]
      ).catch(() => undefined)
    }
    mediaStorageService?.resetAccountSlugCache()
    mediaStorageService?.resetCentralStorageConfigCache()
    restoreEnv(previousEnv)
  }
})

test('la subida administrativa respeta la carpeta elegida sin salir de la raíz de la cuenta', async () => {
  const previousEnv = snapshotEnv()
  const businessId = `media-folder-upload-${Date.now()}`
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
    mediaStorageService.resetCentralStorageConfigCache()

    const selectedDestination = await mediaStorageService.uploadMediaAsset({
      buffer: Buffer.from('video administrativo de prueba'),
      filename: 'presentacion.txt',
      mimeType: 'text/plain',
      module: 'media',
      folderPath: 'Clientes/ACME',
      businessId,
      clientAccountId: 'cuenta_destino',
      skipCompression: true
    })
    assetIds.push(selectedDestination.id)

    assert.equal(selectedDestination.module, 'media')
    assert.equal(selectedDestination.folderPath, 'Clientes/ACME')
    assert.match(
      selectedDestination.bunnyPath,
      /^accounts\/cuenta_destino\/Clientes\/ACME\/rstk_media_[^/]+-presentacion\.txt$/
    )

    const traversalAttempt = await mediaStorageService.uploadMediaAsset({
      buffer: Buffer.from('contenido aislado'),
      filename: 'aislado.txt',
      mimeType: 'text/plain',
      module: 'media',
      folderPath: '../../accounts/cuenta_ajena/Videos',
      businessId,
      clientAccountId: 'cuenta_destino',
      skipCompression: true
    })
    assetIds.push(traversalAttempt.id)

    assert.equal(traversalAttempt.folderPath, 'accounts/cuenta_ajena/Videos')
    assert.match(
      traversalAttempt.bunnyPath,
      /^accounts\/cuenta_destino\/accounts\/cuenta_ajena\/Videos\//
    )
    assert.doesNotMatch(traversalAttempt.bunnyPath, /^accounts\/cuenta_ajena\//)
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
    restoreEnv(previousEnv)
  }
})

test('uploadMediaAsset reutiliza el asset existente cuando se repite el clientUploadId', async () => {
  const previousEnv = snapshotEnv()
  let db = null
  let mediaAssetId = ''
  const clientUploadId = `media-upload-retry-${Date.now()}`

  try {
    delete process.env.DATABASE_URL
    delete process.env.MEDIA_STORAGE_REQUIRE_BUNNY
    delete process.env.BUNNY_STORAGE_ZONE
    delete process.env.BUNNY_STORAGE_REGION
    delete process.env.BUNNY_STORAGE_ENDPOINT
    delete process.env.BUNNY_STORAGE_API_KEY
    delete process.env.BUNNY_CDN_BASE_URL
    delete process.env.RISTAK_CLIENT_ACCOUNT_ID
    delete process.env.CLIENT_ACCOUNT_ID
    process.env.MEDIA_STORAGE_PROVIDER = 'local'

    const [mediaStorageService, database] = await Promise.all([
      import('../src/services/mediaStorageService.js'),
      import('../src/config/database.js')
    ])
    db = database.db
    mediaStorageService.resetCentralStorageConfigCache()

    const first = await mediaStorageService.uploadMediaAsset({
      buffer: Buffer.from('contenido idempotente'),
      filename: 'retry.txt',
      mimeType: 'text/plain',
      module: 'documents',
      businessId: 'default',
      clientAccountId: 'cuenta_local',
      clientUploadId,
      skipCompression: true
    })
    mediaAssetId = first.id

    const second = await mediaStorageService.uploadMediaAsset({
      buffer: Buffer.from('contenido idempotente'),
      filename: 'retry.txt',
      mimeType: 'text/plain',
      module: 'documents',
      businessId: 'default',
      clientAccountId: 'cuenta_local',
      clientUploadId,
      skipCompression: true
    })

    assert.equal(second.id, first.id)
    assert.equal(second.metadata.clientUploadId, clientUploadId)

    const rows = await db.all('SELECT id FROM media_assets WHERE metadata_json LIKE ?', [`%"clientUploadId":"${clientUploadId}"%`])
    assert.equal(rows.length, 1)
  } finally {
    if (mediaAssetId) {
      const { softDeleteMediaAsset } = await import('../src/services/mediaStorageService.js')
      await softDeleteMediaAsset(mediaAssetId).catch(() => undefined)
    }
    if (db) {
      await db.run('DELETE FROM media_assets WHERE metadata_json LIKE ?', [`%"clientUploadId":"${clientUploadId}"%`]).catch(() => undefined)
    }
    restoreEnv(previousEnv)
  }
})

test('un clientUploadId legacy no reutiliza assets de otra cuenta', async () => {
  const previousEnv = snapshotEnv()
  const clientUploadId = `media-upload-account-scope-${Date.now()}`
  const assetIds = []
  let db = null

  try {
    delete process.env.DATABASE_URL
    delete process.env.MEDIA_STORAGE_REQUIRE_BUNNY
    delete process.env.BUNNY_STORAGE_ZONE
    delete process.env.BUNNY_STORAGE_REGION
    delete process.env.BUNNY_STORAGE_ENDPOINT
    delete process.env.BUNNY_STORAGE_API_KEY
    delete process.env.BUNNY_CDN_BASE_URL
    delete process.env.RISTAK_CLIENT_ACCOUNT_ID
    delete process.env.CLIENT_ACCOUNT_ID
    process.env.MEDIA_STORAGE_PROVIDER = 'local'

    const [mediaStorageService, database] = await Promise.all([
      import('../src/services/mediaStorageService.js'),
      import('../src/config/database.js')
    ])
    db = database.db
    mediaStorageService.resetAccountSlugCache()
    mediaStorageService.resetCentralStorageConfigCache()

    const first = await mediaStorageService.uploadMediaAsset({
      buffer: Buffer.from('contenido cuenta a'),
      filename: 'cuenta-a.txt',
      mimeType: 'text/plain',
      module: 'documents',
      businessId: 'default',
      clientAccountId: 'cuenta_a',
      clientUploadId,
      skipCompression: true
    })
    assetIds.push(first.id)

    const second = await mediaStorageService.uploadMediaAsset({
      buffer: Buffer.from('contenido cuenta b'),
      filename: 'cuenta-b.txt',
      mimeType: 'text/plain',
      module: 'documents',
      businessId: 'default',
      clientAccountId: 'cuenta_b',
      clientUploadId,
      skipCompression: true
    })
    assetIds.push(second.id)

    assert.notEqual(second.id, first.id)
    assert.equal(first.metadata.clientAccount.id, 'cuenta_a')
    assert.equal(second.metadata.clientAccount.id, 'cuenta_b')
    assert.match(first.bunnyPath, /^accounts\/cuenta_a\/documents\//)
    assert.match(second.bunnyPath, /^accounts\/cuenta_b\/documents\//)
  } finally {
    if (db) {
      const { softDeleteMediaAsset } = await import('../src/services/mediaStorageService.js')
      for (const assetId of assetIds) {
        await softDeleteMediaAsset(assetId).catch(() => undefined)
      }
      await db.run(
        'DELETE FROM media_assets WHERE metadata_json LIKE ?',
        [`%"clientUploadId":"${clientUploadId}"%`]
      ).catch(() => undefined)
    }
    restoreEnv(previousEnv)
  }
})

test('replaceMediaAsset conserva el slug y root históricos aunque cambie la cuenta configurada', async () => {
  const previousEnv = snapshotEnv()
  const assetIds = []
  let db = null
  let previousStorageSettings = null
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
    process.env.RISTAK_CLIENT_ACCOUNT_ID = 'loc_original'

    const [loadedMediaStorageService, database] = await Promise.all([
      import('../src/services/mediaStorageService.js'),
      import('../src/config/database.js')
    ])
    mediaStorageService = loadedMediaStorageService
    db = database.db
    previousStorageSettings = await db.get(
      'SELECT account_slug, account_label FROM storage_settings WHERE id = 1'
    )
    await db.run(
      `UPDATE storage_settings
       SET account_slug = 'legacy-readable-root', account_label = 'Legacy readable root'
       WHERE id = 1`
    )
    mediaStorageService.resetAccountSlugCache()
    mediaStorageService.resetCentralStorageConfigCache()

    const current = await mediaStorageService.uploadMediaAsset({
      buffer: Buffer.from('contenido original con root legacy'),
      filename: 'original.txt',
      mimeType: 'text/plain',
      module: 'documents',
      businessId: 'default',
      skipCompression: true
    })
    assetIds.push(current.id)
    assert.equal(current.metadata.clientAccount.id, 'loc_original')
    assert.equal(current.metadata.clientAccount.rootPath, 'accounts/legacy-readable-root')

    process.env.RISTAK_CLIENT_ACCOUNT_ID = 'loc_nueva_configurada'
    mediaStorageService.resetAccountSlugCache()
    const replaced = await mediaStorageService.replaceMediaAsset(current.id, {
      buffer: Buffer.from('contenido reemplazado'),
      filename: 'reemplazo.txt',
      mimeType: 'text/plain',
      skipCompression: true,
      metadata: { replacementRegression: true }
    })
    assetIds.push(replaced.asset.id)

    assert.equal(replaced.asset.metadata.clientAccount.id, 'loc_original')
    assert.equal(replaced.asset.metadata.clientAccount.slug, 'legacy-readable-root')
    assert.equal(replaced.asset.metadata.clientAccount.rootPath, 'accounts/legacy-readable-root')
    assert.match(replaced.asset.bunnyPath, /^accounts\/legacy-readable-root\/documents\//)
  } finally {
    if (mediaStorageService) {
      for (const assetId of assetIds) {
        await mediaStorageService.softDeleteMediaAsset(assetId).catch(() => undefined)
      }
    }
    if (db && assetIds.length) {
      await db.run(
        `DELETE FROM media_assets
         WHERE id IN (${assetIds.map(() => '?').join(', ')})`,
        assetIds
      ).catch(() => undefined)
    }
    if (db && previousStorageSettings) {
      await db.run(
        `UPDATE storage_settings
         SET account_slug = ?, account_label = ?
         WHERE id = 1`,
        [previousStorageSettings.account_slug, previousStorageSettings.account_label]
      ).catch(() => undefined)
    }
    mediaStorageService?.resetAccountSlugCache()
    mediaStorageService?.resetCentralStorageConfigCache()
    restoreEnv(previousEnv)
  }
})
