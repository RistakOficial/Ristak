import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

async function createMock() {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: decodeURIComponent(req.url || '') })
    if (req.method === 'PUT' || req.method === 'DELETE') {
      req.on('data', () => {})
      req.on('end', () => { res.statusCode = req.method === 'PUT' ? 201 : 200; res.end('{}') })
      return
    }
    // GET a cualquier objeto de storage → existe (bytes de imagen).
    if (req.url.includes('/storage/central-zone/')) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'image/png')
      res.end(PNG)
      return
    }
    res.statusCode = 404
    res.end('nope')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}`, requests, close: () => server.close() }
}

const mock = await createMock()
delete process.env.DATABASE_URL
for (const k of ['RENDER_EXTERNAL_URL', 'PUBLIC_URL', 'APP_URL']) delete process.env[k]
process.env.MEDIA_STORAGE_PROVIDER = 'bunny'
process.env.MEDIA_STORAGE_REQUIRE_BUNNY = 'true'
process.env.BUNNY_STORAGE_ZONE = 'central-zone'
process.env.BUNNY_STORAGE_REGION = ''
process.env.BUNNY_STORAGE_ENDPOINT = `${mock.baseUrl}/storage`
process.env.BUNNY_STORAGE_API_KEY = 'storage-secret'
process.env.BUNNY_CDN_BASE_URL = `${mock.baseUrl}/cdn`
process.env.BUNNY_STREAM_ENABLED = 'false'
process.env.RISTAK_ACCOUNT_SLUG = 'clientenuevo' // → targetRoot = accounts/clientenuevo

const [{ db }, media, migration] = await Promise.all([
  import('../src/config/database.js'),
  import('../src/services/mediaStorageService.js'),
  import('../src/services/storageTaxonomyMigration.js')
])
media.resetCentralStorageConfigCache()
media.resetAccountSlugCache()

async function seedOldAsset(id, bunnyPath) {
  await db.run('DELETE FROM media_assets WHERE id = ?', [id]).catch(() => {})
  await db.run(
    `INSERT INTO media_assets (id, business_id, bunny_path, public_url, storage_provider, module, metadata_json)
     VALUES (?, 'default', ?, ?, 'bunny', 'sites', '{}')`,
    [id, bunnyPath, `${mock.baseUrl}/cdn/${bunnyPath}`]
  )
}

test('migración sin-borrado: copia + re-apunta pero NO borra lo viejo (respaldo intacto)', async () => {
  await seedOldAsset('mig_run_1', 'accounts/loc_old/sites/2026/06/01/media_x-video.mp4')
  const before = mock.requests.length

  const res = await migration.runStorageTaxonomyMigration({ dryRun: false, deleteOld: false, log: () => {} })

  assert.equal(res.migrated, 1)
  assert.equal(res.failed, 0)
  const newRequests = mock.requests.slice(before)
  assert.ok(newRequests.some((r) => r.method === 'PUT' && r.url.includes('/accounts/clientenuevo/sites/')), 'debió subir a la ruta nueva')
  assert.ok(!newRequests.some((r) => r.method === 'DELETE'), 'NO debió borrar nada (sin-borrado)')

  const row = await db.get('SELECT bunny_path, public_url FROM media_assets WHERE id = ?', ['mig_run_1'])
  assert.match(row.bunny_path, /^accounts\/clientenuevo\/sites\//)
  assert.match(row.public_url, /\/accounts\/clientenuevo\/sites\//)
})

test('idempotencia: una segunda corrida ya no encuentra nada que migrar', async () => {
  const res = await migration.runStorageTaxonomyMigration({ dryRun: false, deleteOld: false, log: () => {} })
  // el asset ya quedó bajo accounts/clientenuevo → 0 planificados
  assert.equal(res.planned, 0)
})

test('con --delete sí borra lo viejo tras verificar', async () => {
  await seedOldAsset('mig_run_2', 'accounts/loc_old/sites/2026/06/02/media_y-foto.webp')
  const before = mock.requests.length
  const res = await migration.runStorageTaxonomyMigration({ dryRun: false, deleteOld: true, log: () => {} })
  assert.equal(res.migrated, 1)
  const newRequests = mock.requests.slice(before)
  assert.ok(newRequests.some((r) => r.method === 'DELETE' && r.url.includes('/accounts/loc_old/')), 'debió borrar el viejo')
})

after(async () => {
  mock.close()
  for (const id of ['mig_run_1', 'mig_run_2']) {
    await db.run('DELETE FROM media_assets WHERE id = ?', [id]).catch(() => {})
  }
})
