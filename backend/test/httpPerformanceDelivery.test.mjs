import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..')

const [serverSource, serviceWorkerSource, backendPackageSource, backendLockSource] = await Promise.all([
  readFile(join(repoRoot, 'backend/src/server.js'), 'utf8'),
  readFile(join(repoRoot, 'frontend/public/sw.js'), 'utf8'),
  readFile(join(repoRoot, 'backend/package.json'), 'utf8'),
  readFile(join(repoRoot, 'backend/package-lock.json'), 'utf8')
])

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.ok(start >= 0, `No se encontró ${startMarker}`)
  assert.ok(end > start, `No se encontró ${endMarker} después de ${startMarker}`)
  return source.slice(start, end)
}

test('backend instala compresión y la monta antes de los parsers globales', () => {
  const backendPackage = JSON.parse(backendPackageSource)
  const backendLock = JSON.parse(backendLockSource)

  assert.match(backendPackage.dependencies.compression, /^\^1\./)
  assert.ok(backendLock.packages?.['node_modules/compression'])
  assert.match(serverSource, /import compression from 'compression'/)
  assert.ok(
    serverSource.indexOf('app.use(compression({') < serverSource.indexOf('app.use(express.json({'),
    'La compresión debe envolver respuestas antes de montar las rutas y parsers globales'
  )
})

test('compresión queda limitada a JSON, JavaScript, CSS y SVG sin tocar SSE ni payloads ya comprimidos', () => {
  const filterSource = sourceBetween(
    serverSource,
    'function isHttpCompressibleContentType',
    '// Comprime únicamente respuestas de texto estructurado.'
  )

  assert.match(filterSource, /application\/json/)
  assert.match(filterSource, /endsWith\('\+json'\)/)
  assert.match(filterSource, /application\/javascript/)
  assert.match(filterSource, /text\/css/)
  assert.match(filterSource, /image\/svg\+xml/)
  assert.match(filterSource, /Content-Encoding/)
  assert.match(filterSource, /contentEncoding && contentEncoding !== 'identity'/)
  assert.match(filterSource, /text\/event-stream/)
  assert.match(serverSource, /threshold: HTTP_COMPRESSION_MIN_BYTES/)
})

test('producción entrega bundles Vite inmutables y revalida index, service worker y manifests', () => {
  const staticSource = sourceBetween(
    serverSource,
    "if (process.env.NODE_ENV === 'production') {",
    '// Manejo de errores global'
  )

  assert.match(staticSource, /const viteHashedAssetPathPattern = /)
  assert.match(staticSource, /viteHashedAssetPathPattern\.test\(relativePath\)/)
  assert.match(staticSource, /public, max-age=31536000, immutable/)
  assert.match(staticSource, /new Set\(\['index\.html', 'sw\.js'\]\)/)
  assert.match(staticSource, /manifest\(\?:\\\.\[\^\/\]\+\)\?\\\.webmanifest/)
  assert.match(staticSource, /no-cache, must-revalidate/)
  assert.match(staticSource, /app\.get\('\/assets\/\*'[\s\S]*Cache-Control', 'no-store'/)
})

test('service worker usa cache-first solo para assets con hash y network-first para navegación', () => {
  assert.match(serviceWorkerSource, /const CACHE_NAME = 'ristak-branding-v31'/)
  assert.match(serviceWorkerSource, /const HASHED_ASSET_PATH_PATTERN = /)
  assert.match(serviceWorkerSource, /if \(isHashedAppAsset\) \{\s*respondWithoutBlockingOnCache\(event, request, cacheFirstHashedAsset\(request\)\)/)
  assert.match(serviceWorkerSource, /respondWithoutBlockingOnCache\([\s\S]*networkFirstRequest\(request, \{ isAppAsset, isNavigationRequest \}\)/)
  assert.match(serviceWorkerSource, /event\.respondWith\(responseTask\.then\(result => result\.response\)\)/)
  assert.match(serviceWorkerSource, /event\.waitUntil\([\s\S]*cacheResponse\(request, result\.response\)/)

  const cacheFirstSource = sourceBetween(
    serviceWorkerSource,
    'async function cacheFirstHashedAsset',
    'async function networkFirstRequest'
  )
  assert.ok(
    cacheFirstSource.indexOf('matchCachedResponse(request)') < cacheFirstSource.indexOf('fetch(request)'),
    'Un asset versionado debe consultar cache antes que red'
  )

  const networkFirstSource = sourceBetween(
    serviceWorkerSource,
    'async function networkFirstRequest',
    "self.addEventListener('fetch'"
  )
  assert.ok(
    networkFirstSource.indexOf('fetch(request)') < networkFirstSource.indexOf('matchCachedResponse(request)'),
    'La navegación debe consultar red antes de usar su respaldo offline'
  )
  assert.doesNotMatch(cacheFirstSource, /await cacheResponse/)
  assert.doesNotMatch(networkFirstSource, /await cacheResponse/)
  assert.match(serviceWorkerSource, /response\.status !== 200 \|\| new URL\(request\.url\)\.origin !== self\.location\.origin/)
  assert.match(serviceWorkerSource, /async function matchCachedResponse[\s\S]*catch \{\s*return undefined/)
})
