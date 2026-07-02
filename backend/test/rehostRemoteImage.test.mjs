import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// PNG real de 1x1 (para que sharp/file-type lo reconozcan como imagen).
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

async function waitFor(fn, timeoutMs = 1000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return fn()
}

async function createMock() {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url })
    if (req.method === 'GET' && req.url.startsWith('/remote/avatar.png')) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'image/png')
      res.end(PNG_1x1)
      return
    }
    if (req.method === 'GET' && req.url.startsWith('/remote/notimage')) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html')
      res.end('<html>error page</html>')
      return
    }
    if (req.method === 'GET' && req.url.startsWith('/remote/missing')) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    if (req.method === 'PUT' && req.url.includes('/storage/central-zone/')) {
      req.on('data', () => {})
      req.on('end', () => { res.statusCode = 201; res.end('{}') })
      return
    }
    res.statusCode = 404
    res.end('unhandled')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}`, requests, close: () => server.close() }
}

function configureEnv(baseUrl) {
  delete process.env.DATABASE_URL
  for (const k of ['BUNNY_API_KEY', 'BUNNY_ACCOUNT_API_KEY', 'BUNNY_API_TOKEN', 'BUNNY_ACCESS_KEY', 'RISTAK_CLIENT_ACCOUNT_ID', 'CLIENT_ACCOUNT_ID', 'GHL_LOCATION_ID', 'HIGHLEVEL_LOCATION_ID', 'RENDER_EXTERNAL_URL', 'PUBLIC_URL']) {
    delete process.env[k]
  }
  process.env.MEDIA_STORAGE_PROVIDER = 'bunny'
  process.env.MEDIA_STORAGE_REQUIRE_BUNNY = 'true'
  process.env.MEDIA_COMPRESSION_ENABLED = 'false'
  process.env.BUNNY_STORAGE_ZONE = 'central-zone'
  process.env.BUNNY_STORAGE_REGION = ''
  process.env.BUNNY_STORAGE_ENDPOINT = `${baseUrl}/storage`
  process.env.BUNNY_STORAGE_API_KEY = 'storage-secret'
  process.env.BUNNY_CDN_BASE_URL = `${baseUrl}/cdn`
  process.env.BUNNY_STREAM_ENABLED = 'false'
}

const mock = await createMock()
configureEnv(mock.baseUrl)

const [{ db }, media] = await Promise.all([
  import('../src/config/database.js'),
  import('../src/services/mediaStorageService.js')
])
media.resetCentralStorageConfigCache()
media.resetAccountSlugCache()
media.resetAccountReadmeCache()
await db.run('DELETE FROM users').catch(() => {})
await db.run('UPDATE storage_settings SET account_slug = NULL, account_label = NULL WHERE id = 1').catch(() => {})

test('rehospeda un avatar remoto a Bunny bajo la carpeta del canal', async () => {
  const result = await media.rehostRemoteImageToBunny({
    url: `${mock.baseUrl}/remote/avatar.png`,
    module: 'avatars',
    subFolder: 'whatsapp',
    clientAccountId: 'loc_test',
    filename: 'contacto-avatar.png'
  })
  assert.ok(result, 'debe devolver un resultado')
  assert.equal(result.reused, false)
  assert.match(result.publicUrl, /\/cdn\/accounts\/loc_test\/avatars\/whatsapp\//)
  // La subida real (PUT) llegó a Bunny Storage.
  assert.ok(mock.requests.some((r) => r.method === 'PUT' && r.url.includes('/avatars/whatsapp/')))
})

test('dedup: una URL que ya es de nuestro Bunny NO se re-descarga ni re-sube', async () => {
  const dedupUrl = `${mock.baseUrl}/cdn/accounts/loc_test/avatars/whatsapp/ya-existe.png`
  const before = mock.requests.length
  const result = await media.rehostRemoteImageToBunny({
    url: dedupUrl,
    module: 'avatars',
    subFolder: 'whatsapp',
    clientAccountId: 'loc_test'
  })
  assert.ok(result)
  assert.equal(result.reused, true)
  assert.equal(result.publicUrl, dedupUrl)
  const newRequests = mock.requests.slice(before)
  assert.equal(newRequests.length, 0, 'no debió tocar la red')
})

test('best-effort: URL rota / no-imagen / inválida devuelven null (se conserva la cruda)', async () => {
  assert.equal(await media.rehostRemoteImageToBunny({ url: `${mock.baseUrl}/remote/missing`, clientAccountId: 'loc_test' }), null)
  assert.equal(await media.rehostRemoteImageToBunny({ url: `${mock.baseUrl}/remote/notimage`, clientAccountId: 'loc_test' }), null)
  assert.equal(await media.rehostRemoteImageToBunny({ url: 'no-es-url', clientAccountId: 'loc_test' }), null)
  assert.equal(await media.rehostRemoteImageToBunny({ url: '', clientAccountId: 'loc_test' }), null)
})

test('resolveAvatarForPersist: contacto nuevo rehospeda la URL cruda', async () => {
  const res = await media.resolveAvatarForPersist({
    incomingUrl: `${mock.baseUrl}/remote/avatar.png`,
    currentUrl: '',
    channel: 'whatsapp',
    clientAccountId: 'loc_test'
  })
  assert.equal(res.rehosted, true)
  assert.match(res.url, /\/cdn\/accounts\/loc_test\/avatars\/whatsapp\//)
})

test('resolveAvatarForPersist: si ya hay foto en Bunny NO la pisa ni re-descarga', async () => {
  const bunnyCurrent = `${mock.baseUrl}/cdn/accounts/loc_test/avatars/whatsapp/ya.png`
  const before = mock.requests.length
  const res = await media.resolveAvatarForPersist({
    incomingUrl: `${mock.baseUrl}/remote/avatar.png`, // llega una cruda nueva...
    currentUrl: bunnyCurrent, // ...pero ya tenemos la permanente
    channel: 'whatsapp',
    clientAccountId: 'loc_test'
  })
  assert.equal(res.kept, true)
  assert.equal(res.rehosted, false)
  assert.equal(res.url, bunnyCurrent)
  assert.equal(mock.requests.length, before, 'no debió tocar la red')
})

test('resolveAvatarForPersist: sin URL nueva conserva la actual', async () => {
  const res = await media.resolveAvatarForPersist({ incomingUrl: '', currentUrl: 'https://x/y.jpg', channel: 'whatsapp' })
  assert.equal(res.url, 'https://x/y.jpg')
  assert.equal(res.kept, true)
})

test('resolveAvatarForPersist: si el rehospedado falla, devuelve la URL cruda (fallback)', async () => {
  const res = await media.resolveAvatarForPersist({
    incomingUrl: `${mock.baseUrl}/remote/missing`, // 404 → no se puede rehospedar
    currentUrl: '',
    channel: 'instagram',
    clientAccountId: 'loc_test'
  })
  assert.equal(res.rehosted, false)
  assert.equal(res.url, `${mock.baseUrl}/remote/missing`)
})

test('refresco: avatar en Bunny RECIENTE se conserva (no re-descarga)', async () => {
  const bunnyCurrent = `${mock.baseUrl}/cdn/accounts/loc_test/avatars/whatsapp/2020/01/01/old.png`
  const before = mock.requests.length
  const res = await media.resolveAvatarForPersist({
    incomingUrl: `${mock.baseUrl}/remote/avatar.png`,
    currentUrl: bunnyCurrent,
    channel: 'whatsapp',
    clientAccountId: 'loc_test',
    refreshAfterMs: Number.MAX_SAFE_INTEGER // nunca se considera vieja
  })
  assert.equal(res.kept, true)
  assert.equal(res.url, bunnyCurrent)
  assert.equal(mock.requests.length, before, 'no debió tocar la red')
})

test('refresco: avatar en Bunny VIEJO se re-baja y borra la copia vieja', async () => {
  const bunnyCurrent = `${mock.baseUrl}/cdn/accounts/loc_test/avatars/whatsapp/2020/01/01/old.png`
  const before = mock.requests.length
  const res = await media.resolveAvatarForPersist({
    incomingUrl: `${mock.baseUrl}/remote/avatar.png`, // foto actual (cruda)
    currentUrl: bunnyCurrent, // copia de 2020 → vieja con la ventana default (7 días)
    channel: 'whatsapp',
    clientAccountId: 'loc_test'
  })
  assert.equal(res.refreshed, true)
  assert.equal(res.rehosted, true)
  assert.match(res.url, /\/accounts\/loc_test\/avatars\/whatsapp\//)
  assert.notEqual(res.url, bunnyCurrent) // es una copia nueva
  // El borrado de la vieja es best-effort (fire-and-forget); esperamos a que llegue.
  const sawDelete = await waitFor(() =>
    mock.requests.slice(before).some((r) => r.method === 'DELETE' && r.url.includes('/2020/01/01/old.png')))
  assert.ok(sawDelete, 'debió borrar la vieja')
})

after(async () => {
  mock.close()
  await db.run("DELETE FROM media_assets WHERE module = 'avatars'").catch(() => {})
  await db.run('DELETE FROM users').catch(() => {})
  await db.run('UPDATE storage_settings SET account_slug = NULL, account_label = NULL WHERE id = 1').catch(() => {})
})
