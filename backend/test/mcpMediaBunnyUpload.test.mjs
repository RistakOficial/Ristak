import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before } from 'node:test'
import express from 'express'

import { databaseReady, db } from '../src/config/database.js'
import {
  MCP_MEDIA_UPLOAD_TICKET_HEADER,
  createMcpBunnyUploadPreparation,
  authorizeMcpMediaUploadTicket,
  validateMcpMediaUploadFile
} from '../src/controllers/mediaController.js'
import mediaRoutes from '../src/routes/media.routes.js'
import { resetCentralStorageConfigCache } from '../src/services/mediaStorageService.js'

const fixture = {
  userId: null,
  tempDir: '',
  filePath: '',
  bytes: Buffer.from('archivo MCP que debe llegar íntegro a Bunny.net\n', 'utf8')
}

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    }
  }
}

before(async () => {
  await databaseReady
  const username = `mcp_bunny_${randomUUID()}@example.test`
  const inserted = await db.run(
    `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
     VALUES (?, ?, 'not-used', 'MCP Bunny Test', 'admin', 1)`,
    [username, username]
  )
  fixture.userId = inserted.lastID
  fixture.tempDir = await mkdtemp(join(tmpdir(), 'ristak-mcp-bunny-test-'))
  fixture.filePath = join(fixture.tempDir, 'archivo.txt')
  await writeFile(fixture.filePath, fixture.bytes)
})

after(async () => {
  if (fixture.userId) await db.run('DELETE FROM users WHERE id = ?', [fixture.userId]).catch(() => undefined)
  if (fixture.tempDir) await rm(fixture.tempDir, { recursive: true, force: true })
})

test('el pase firmado ata usuario, metadatos, destino y bytes sin incluir el archivo en MCP', async () => {
  const sha256 = createHash('sha256').update(fixture.bytes).digest('hex')
  const prepared = createMcpBunnyUploadPreparation({
    origin: 'https://ristak.example.test/sobra/ruta',
    businessId: 'default',
    userId: fixture.userId,
    clientId: 'codex-client',
    idempotencyKey: 'mcp-bunny-file-001',
    filename: '/Users/raul/Desktop/archivo.txt',
    mimeType: 'text/plain; charset=utf-8',
    sizeBytes: fixture.bytes.length,
    sha256,
    folderPath: 'Documentos/Pruebas',
    isPublic: false
  })

  assert.equal(prepared.uploadUrl, 'https://ristak.example.test/api/media/mcp-upload')
  assert.equal(prepared.method, 'POST')
  assert.equal(prepared.fileField, 'file')
  assert.equal(prepared.expected.filename, 'archivo.txt')
  assert.equal(prepared.expected.mimeType, 'text/plain')
  assert.equal(prepared.expected.sizeBytes, fixture.bytes.length)
  assert.equal(prepared.expected.sha256, sha256)
  assert.ok(prepared.headers['X-Ristak-Media-Upload-Ticket'])
  assert.equal(JSON.stringify(prepared).includes(fixture.bytes.toString('base64')), false)

  const req = {
    headers: { [MCP_MEDIA_UPLOAD_TICKET_HEADER]: prepared.headers['X-Ristak-Media-Upload-Ticket'] },
    query: { module: 'sites', businessId: 'inventado' },
    get(name) {
      return this.headers[String(name).toLowerCase()]
    }
  }
  const res = responseRecorder()
  let authorized = false
  await authorizeMcpMediaUploadTicket(req, res, () => { authorized = true })

  assert.equal(authorized, true)
  assert.equal(res.payload, null)
  assert.equal(String(req.user.id), String(fixture.userId))
  assert.equal(req.mediaUploadModule, 'media')
  assert.equal(req.query.module, 'media')
  assert.equal(req.mcpMediaUpload.folderPath, 'Documentos/Pruebas')
  assert.equal(req.mcpMediaUpload.isPublic, false)

  const validated = await validateMcpMediaUploadFile(req.mcpMediaUpload, {
    path: fixture.filePath,
    size: fixture.bytes.length,
    originalname: 'nombre-no-confiable.bin',
    mimetype: 'application/octet-stream'
  })
  assert.equal(validated.originalname, 'archivo.txt')
  assert.equal(validated.mimetype, 'text/plain')
})

test('rechaza pases inválidos y archivos cuyo tamaño, MIME o checksum no coinciden', async () => {
  const invalidReq = {
    headers: { [MCP_MEDIA_UPLOAD_TICKET_HEADER]: 'pase-invalido' },
    get(name) {
      return this.headers[String(name).toLowerCase()]
    }
  }
  const invalidRes = responseRecorder()
  let called = false
  await authorizeMcpMediaUploadTicket(invalidReq, invalidRes, () => { called = true })
  assert.equal(called, false)
  assert.equal(invalidRes.statusCode, 401)
  assert.equal(invalidRes.payload.code, 'invalid_mcp_upload_ticket')

  const base = {
    version: 1,
    businessId: 'default',
    userId: String(fixture.userId),
    clientUploadId: `mcp_${'a'.repeat(64)}`,
    filename: 'archivo.txt',
    mimeType: 'text/plain',
    sizeBytes: fixture.bytes.length,
    sha256: createHash('sha256').update(fixture.bytes).digest('hex'),
    folderPath: '',
    isPublic: true
  }
  const file = {
    path: fixture.filePath,
    size: fixture.bytes.length,
    originalname: 'archivo.txt',
    mimetype: 'text/plain'
  }

  await assert.rejects(
    () => validateMcpMediaUploadFile({ ...base, sizeBytes: fixture.bytes.length + 1 }, file),
    error => error?.code === 'mcp_upload_size_mismatch'
  )
  await assert.rejects(
    () => validateMcpMediaUploadFile({ ...base, mimeType: 'application/pdf' }, file),
    error => error?.code === 'mcp_upload_mime_mismatch'
  )
  await assert.rejects(
    () => validateMcpMediaUploadFile({ ...base, sha256: 'b'.repeat(64) }, file),
    error => error?.code === 'mcp_upload_checksum_mismatch'
  )
})

test('el endpoint transmite el multipart validado al flujo canónico y Bunny recibe los bytes exactos', async () => {
  const envKeys = [
    'APP_URL',
    'MEDIA_STORAGE_PROVIDER',
    'MEDIA_STORAGE_REQUIRE_BUNNY',
    'MEDIA_COMPRESSION_ENABLED',
    'BUNNY_STORAGE_ZONE',
    'BUNNY_STORAGE_ENDPOINT',
    'BUNNY_STORAGE_API_KEY',
    'BUNNY_CDN_BASE_URL',
    'BUNNY_STREAM_ENABLED'
  ]
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  const bunnyRequests = []
  const bunnyServer = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    bunnyRequests.push({
      method: req.method,
      path: decodeURIComponent(req.url || ''),
      accessKey: req.headers.accesskey,
      body: Buffer.concat(chunks)
    })
    res.statusCode = req.method === 'PUT' ? 201 : 200
    res.end('ok')
  })
  await new Promise((resolve, reject) => {
    bunnyServer.once('error', reject)
    bunnyServer.listen(0, '127.0.0.1', resolve)
  })
  const bunnyOrigin = `http://127.0.0.1:${bunnyServer.address().port}`

  const app = express()
  app.use('/api/media', mediaRoutes)
  const appServer = http.createServer(app)
  await new Promise((resolve, reject) => {
    appServer.once('error', reject)
    appServer.listen(0, '127.0.0.1', resolve)
  })
  const appOrigin = `http://127.0.0.1:${appServer.address().port}`

  Object.assign(process.env, {
    APP_URL: appOrigin,
    MEDIA_STORAGE_PROVIDER: 'bunny',
    MEDIA_STORAGE_REQUIRE_BUNNY: 'true',
    MEDIA_COMPRESSION_ENABLED: 'false',
    BUNNY_STORAGE_ZONE: 'mcp-test-zone',
    BUNNY_STORAGE_ENDPOINT: `${bunnyOrigin}/storage`,
    BUNNY_STORAGE_API_KEY: 'mcp-test-storage-key',
    BUNNY_CDN_BASE_URL: `${bunnyOrigin}/cdn`,
    BUNNY_STREAM_ENABLED: 'false'
  })
  resetCentralStorageConfigCache()

  let assetId = ''
  let clientUploadId = ''
  try {
    const sha256 = createHash('sha256').update(fixture.bytes).digest('hex')
    const prepared = createMcpBunnyUploadPreparation({
      origin: appOrigin,
      businessId: 'default',
      userId: fixture.userId,
      clientId: 'codex-e2e',
      idempotencyKey: 'mcp-bunny-e2e-001',
      filename: 'archivo-e2e.txt',
      mimeType: 'text/plain',
      sizeBytes: fixture.bytes.length,
      sha256,
      folderPath: 'MCP/Pruebas',
      isPublic: true
    })
    clientUploadId = prepared.uploadId
    const form = new FormData()
    form.append('file', new Blob([fixture.bytes], { type: 'text/plain' }), 'nombre-multipart-ignorado.txt')
    const response = await fetch(prepared.uploadUrl, {
      method: prepared.method,
      headers: prepared.headers,
      body: form
    })
    const payload = await response.json()

    assert.equal(response.status, 201, JSON.stringify(payload))
    assert.equal(payload.success, true)
    assert.equal(payload.data.storageProvider, 'bunny')
    assert.equal(payload.data.originalFilename, 'archivo-e2e.txt')
    assert.equal(payload.data.folderPath, 'MCP/Pruebas')
    assert.equal(payload.data.module, 'media')
    assetId = payload.data.id

    const uploaded = bunnyRequests.find(entry => entry.method === 'PUT' && entry.body.equals(fixture.bytes))
    assert.ok(uploaded, 'Bunny no recibió los bytes exactos del archivo')
    assert.equal(uploaded.accessKey, 'mcp-test-storage-key')
    assert.match(uploaded.path, /\/storage\/mcp-test-zone\/accounts\/default\/MCP\/Pruebas\//)

    const row = await db.get(
      'SELECT storage_provider, folder_path, module FROM media_assets WHERE id = ?',
      [assetId]
    )
    assert.deepEqual(row, {
      storage_provider: 'bunny',
      folder_path: 'MCP/Pruebas',
      module: 'media'
    })
  } finally {
    if (clientUploadId) {
      await db.run(
        'DELETE FROM media_upload_requests WHERE business_id = ? AND client_upload_id = ?',
        ['default', clientUploadId]
      ).catch(() => undefined)
    }
    if (assetId) await db.run('DELETE FROM media_assets WHERE id = ?', [assetId]).catch(() => undefined)
    appServer.closeAllConnections?.()
    bunnyServer.closeAllConnections?.()
    await Promise.all([
      new Promise(resolve => appServer.close(resolve)),
      new Promise(resolve => bunnyServer.close(resolve))
    ])
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    resetCentralStorageConfigCache()
  }
})
