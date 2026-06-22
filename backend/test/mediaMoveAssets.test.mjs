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
  let mediaAssetId = ''

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
