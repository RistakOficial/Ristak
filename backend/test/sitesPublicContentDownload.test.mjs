import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import express from 'express'

import { databaseReady, db } from '../src/config/database.js'
import { publicSiteHostMiddleware } from '../src/controllers/sitesController.js'
import sitesRoutes from '../src/routes/sites.routes.js'

const fixture = {
  server: null,
  port: 0,
  directory: '',
  localPath: '',
  body: Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'utf8'),
  siteId: '',
  assetId: '',
  bindingId: '',
  assetKey: 'guia-estable',
  publicUrl: 'https://cdn.example.test/legacy/guia-estable.pdf?version=1',
  originalFilename: '../../guía "\r\nX-Evil: sí".pdf'
}

function requestServer(path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: fixture.port,
      path,
      method,
      headers
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }))
    })
    request.once('error', reject)
    request.end()
  })
}

function publicAssetPath(query = '') {
  return `/api/sites/public/content-assets/${encodeURIComponent(fixture.siteId)}/${encodeURIComponent(fixture.assetKey)}${query}`
}

before(async () => {
  await databaseReady

  const suffix = randomUUID()
  fixture.siteId = `site_public_download_${suffix}`
  fixture.assetId = `media_public_download_${suffix}`
  fixture.bindingId = `content_public_download_${suffix}`
  fixture.directory = await mkdtemp(join(tmpdir(), 'ristak-site-public-download-'))
  fixture.localPath = join(fixture.directory, 'stable-download.pdf')
  await writeFile(fixture.localPath, fixture.body)

  await db.run(`
    INSERT INTO public_sites (
      id, name, slug, site_type, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'landing_page', 'published', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [fixture.siteId, 'Descarga pública estable', `descarga-${suffix}`])

  await db.run(`
    INSERT INTO media_assets (
      id, business_id, original_filename, stored_filename, public_url,
      mime_type, media_type, size_original, size_processed, status,
      storage_provider, module, module_entity_id, is_public, metadata_json,
      created_at, updated_at
    ) VALUES (
      ?, 'default', ?, 'stable-download.pdf', ?,
      'application/pdf', 'document', ?, ?, 'ready',
      'local', 'sites', ?, 1, ?,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `, [
    fixture.assetId,
    fixture.originalFilename,
    fixture.publicUrl,
    fixture.body.length,
    fixture.body.length,
    fixture.siteId,
    JSON.stringify({ localPath: fixture.localPath })
  ])

  await db.run(`
    INSERT INTO public_site_content_assets (
      id, site_id, asset_key, label, kind, media_asset_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'Guía estable', 'document', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [fixture.bindingId, fixture.siteId, fixture.assetKey, fixture.assetId])

  const app = express()
  app.use(publicSiteHostMiddleware)
  app.use('/api/sites', sitesRoutes)
  fixture.server = http.createServer(app)
  await new Promise((resolve, reject) => {
    fixture.server.once('error', reject)
    fixture.server.listen(0, '127.0.0.1', resolve)
  })
  fixture.port = fixture.server.address().port
})

after(async () => {
  if (fixture.server) {
    fixture.server.closeAllConnections?.()
    await new Promise((resolve) => fixture.server.close(resolve))
  }
  await db.run('DELETE FROM public_site_content_assets WHERE id = ?', [fixture.bindingId]).catch(() => undefined)
  await db.run('DELETE FROM public_sites WHERE id = ?', [fixture.siteId]).catch(() => undefined)
  await db.run('DELETE FROM media_assets WHERE id = ?', [fixture.assetId]).catch(() => undefined)
  if (fixture.directory) await rm(fixture.directory, { recursive: true, force: true })
})

test('descarga local completa por HTTP con headers de archivo estables', async () => {
  const response = await requestServer(publicAssetPath('?download=1'))

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body, fixture.body)
  assert.equal(response.headers['content-type'], 'application/pdf')
  assert.equal(response.headers['content-length'], String(fixture.body.length))
  assert.equal(response.headers['accept-ranges'], 'bytes')
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.headers['x-content-type-options'], 'nosniff')
})

test('descarga local responde un Range simple con 206 y el segmento exacto', async () => {
  const response = await requestServer(publicAssetPath('?download=true'), {
    headers: { Range: 'bytes=5-11' }
  })

  assert.equal(response.statusCode, 206)
  assert.deepEqual(response.body, fixture.body.subarray(5, 12))
  assert.equal(response.headers['content-range'], `bytes 5-11/${fixture.body.length}`)
  assert.equal(response.headers['content-length'], '7')
  assert.equal(response.headers['accept-ranges'], 'bytes')
})

test('descarga local rechaza rangos inválidos y múltiples con 416', async (t) => {
  const cases = [
    ['invertido', 'bytes=12-5'],
    ['fuera del archivo', `bytes=${fixture.body.length + 10}-${fixture.body.length + 20}`],
    ['múltiple no soportado', 'bytes=0-2,5-7']
  ]

  for (const [label, range] of cases) {
    await t.test(label, async () => {
      const response = await requestServer(publicAssetPath('?download=1'), {
        headers: { Range: range }
      })

      assert.equal(response.statusCode, 416)
      assert.equal(response.headers['content-range'], `bytes */${fixture.body.length}`)
      assert.equal(response.headers['accept-ranges'], 'bytes')
    })
  }
})

test('HEAD de descarga local conserva metadata sin transmitir el cuerpo', async () => {
  const response = await requestServer(publicAssetPath('?download=1'), { method: 'HEAD' })

  assert.equal(response.statusCode, 200)
  assert.equal(response.body.length, 0)
  assert.equal(response.headers['content-type'], 'application/pdf')
  assert.equal(response.headers['content-length'], String(fixture.body.length))
  assert.equal(response.headers['accept-ranges'], 'bytes')
  assert.match(response.headers['content-disposition'] || '', /^attachment;/)
})

test('sin download conserva el redirect 302 legacy hacia la URL pública del asset', async () => {
  const response = await requestServer(publicAssetPath())

  assert.equal(response.statusCode, 302)
  assert.equal(response.headers.location, fixture.publicUrl)
})

test('Content-Disposition neutraliza rutas, comillas, saltos y Unicode sin inyectar headers', async () => {
  const response = await requestServer(publicAssetPath('?download=1'))

  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['x-evil'], undefined)
  assert.equal(
    response.headers['content-disposition'],
    'attachment; filename="gu_a X-Evil: s_.pdf"; filename*=UTF-8\'\'gu%C3%ADa%20X-Evil%3A%20s%C3%AD.pdf'
  )
})

test('el middleware de host personalizado deja pasar la ruta pública estable', async () => {
  const response = await requestServer(publicAssetPath(), {
    headers: { Host: 'descargas.cliente.example' }
  })

  assert.equal(response.statusCode, 302)
  assert.equal(response.headers.location, fixture.publicUrl)
})
