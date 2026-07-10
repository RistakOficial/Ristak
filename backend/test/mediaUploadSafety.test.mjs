import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { db } from '../src/config/database.js'
import {
  createMediaUploadRequestHash,
  runIdempotentMediaUpload
} from '../src/services/mediaUploadSafetyService.js'

function uniqueUploadId(label) {
  return `${label}_${randomUUID()}`
}

async function cleanup(clientUploadId) {
  await db.run(
    'DELETE FROM media_upload_requests WHERE business_id = ? AND client_upload_id = ?',
    ['default', clientUploadId]
  ).catch(() => undefined)
}

async function findFilesNamed(root, needle) {
  const matches = []
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) matches.push(...await findFilesNamed(path, needle))
    else if (entry.name.includes(needle)) matches.push(path)
  }
  return matches
}

test('dos subidas concurrentes ejecutan storage una vez y reproducen el mismo asset', async () => {
  const clientUploadId = uniqueUploadId('media_concurrent')
  const requestHash = await createMediaUploadRequestHash({
    descriptor: { module: 'chat', kind: 'document' },
    buffer: Buffer.from('contenido concurrente')
  })
  let executions = 0

  try {
    const args = {
      businessId: 'default',
      clientUploadId,
      requestHash,
      create: async () => {
        executions += 1
        await new Promise(resolve => setTimeout(resolve, 45))
        return { id: 'media_concurrent_asset', publicUrl: 'https://cdn.example/media.pdf' }
      }
    }
    const [first, second] = await Promise.all([
      runIdempotentMediaUpload(args),
      runIdempotentMediaUpload(args)
    ])

    assert.equal(executions, 1)
    assert.deepEqual(second, first)
    const row = await db.get(
      `SELECT status, asset_id, request_hash
       FROM media_upload_requests
       WHERE business_id = ? AND client_upload_id = ?`,
      ['default', clientUploadId]
    )
    assert.equal(row.status, 'completed')
    assert.equal(row.asset_id, 'media_concurrent_asset')
    assert.equal(row.request_hash, requestHash)
  } finally {
    await cleanup(clientUploadId)
  }
})

test('la misma llave con bytes distintos se rechaza sin ejecutar otra subida', async () => {
  const clientUploadId = uniqueUploadId('media_payload_conflict')
  const firstHash = await createMediaUploadRequestHash({
    descriptor: { module: 'chat' },
    buffer: Buffer.from('archivo uno')
  })
  const secondHash = await createMediaUploadRequestHash({
    descriptor: { module: 'chat' },
    buffer: Buffer.from('archivo dos')
  })
  let executions = 0

  try {
    await runIdempotentMediaUpload({
      businessId: 'default',
      clientUploadId,
      requestHash: firstHash,
      create: async () => ({ id: `asset_${++executions}` })
    })
    await assert.rejects(
      () => runIdempotentMediaUpload({
        businessId: 'default',
        clientUploadId,
        requestHash: secondHash,
        create: async () => ({ id: `asset_${++executions}` })
      }),
      error => error?.status === 409 && error?.code === 'media_upload_id_conflict'
    )
    assert.equal(executions, 1)
  } finally {
    await cleanup(clientUploadId)
  }
})

test('la huella lee el archivo original sin cargarlo por medio del contrato de buffer', async () => {
  const folder = await fs.mkdtemp(join(tmpdir(), 'ristak-media-hash-'))
  const filePath = join(folder, 'archivo.bin')
  const bytes = Buffer.from('huella estable desde disco')
  await fs.writeFile(filePath, bytes)
  try {
    const fromFile = await createMediaUploadRequestHash({ descriptor: { a: 1 }, filePath })
    const fromBuffer = await createMediaUploadRequestHash({ descriptor: { a: 1 }, buffer: bytes })
    assert.equal(fromFile, fromBuffer)
  } finally {
    await fs.rm(folder, { recursive: true, force: true })
  }
})

test('un INSERT fallido limpia el archivo local antes de dejarlo huérfano', async () => {
  const previousProvider = process.env.MEDIA_STORAGE_PROVIDER
  const previousRequireBunny = process.env.MEDIA_STORAGE_REQUIRE_BUNNY
  const marker = `cleanup-${randomUUID()}`
  const storageRoot = new URL('../uploads/media-storage/', import.meta.url).pathname
  const originalRun = db.run.bind(db)

  process.env.MEDIA_STORAGE_PROVIDER = 'local'
  delete process.env.MEDIA_STORAGE_REQUIRE_BUNNY
  const mediaStorage = await import('../src/services/mediaStorageService.js')
  mediaStorage.resetCentralStorageConfigCache()
  mock.method(db, 'run', async (sql, params = []) => {
    if (/INSERT\s+INTO\s+media_assets/i.test(String(sql))) {
      throw new Error('insert_media_asset_forced_failure')
    }
    return originalRun(sql, params)
  })

  try {
    await assert.rejects(
      () => mediaStorage.uploadMediaAsset({
        buffer: Buffer.from('contenido que debe limpiarse'),
        filename: `${marker}.txt`,
        mimeType: 'text/plain',
        module: 'chat',
        businessId: 'default',
        isPublic: true,
        skipCompression: true
      }),
      /insert_media_asset_forced_failure/
    )
    assert.deepEqual(await findFilesNamed(storageRoot, marker), [])
  } finally {
    mock.restoreAll()
    if (previousProvider === undefined) delete process.env.MEDIA_STORAGE_PROVIDER
    else process.env.MEDIA_STORAGE_PROVIDER = previousProvider
    if (previousRequireBunny === undefined) delete process.env.MEDIA_STORAGE_REQUIRE_BUNNY
    else process.env.MEDIA_STORAGE_REQUIRE_BUNNY = previousRequireBunny
    mediaStorage.resetCentralStorageConfigCache()
  }
})
