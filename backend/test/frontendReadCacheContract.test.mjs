import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..')
const repoFile = (path) => readFile(join(repoRoot, path), 'utf8')

test('las lecturas autenticadas comparten petición y snapshot corto con límites de memoria', async () => {
  const source = await repoFile('frontend/src/services/authFetch.ts')

  assert.match(source, /const API_READ_CACHE_DEFAULT_TTL_MS = 15_000/)
  assert.match(source, /const API_READ_CACHE_MAX_ENTRIES = 120/)
  assert.match(source, /const API_READ_CACHE_MAX_RESPONSE_BYTES = 1_000_000/)
  assert.match(source, /const API_READ_CACHE_MAX_TOTAL_BYTES = 12_000_000/)
  assert.match(source, /apiReadInFlight\.get\(readPolicy\.key\)/)
  assert.match(source, /apiReadInFlight\.set\(readPolicy\.key, sharedRequest\)/)
  assert.match(source, /response\.clone\(\)\.arrayBuffer\(\)/)
  assert.match(source, /payload\.byteLength > API_READ_CACHE_MAX_RESPONSE_BYTES/)
  assert.match(source, /apiReadResponseCache\.size >= API_READ_CACHE_MAX_ENTRIES[\s\S]*apiReadCacheTotalBytes \+ payload\.byteLength > API_READ_CACHE_MAX_TOTAL_BYTES/)
  assert.match(source, /no-store\|no-cache/)
  assert.match(source, /response\.headers\.get\('vary'\)/)
  assert.match(source, /requestHeadersFingerprint\(input, init\)/)
  assert.match(source, /X-Meta-Access-Token/)
  assert.match(source, /function requestsStreamingResponse\(url: URL\)/)
  assert.match(source, /'\/api\/automations\/assets'/)
  assert.match(source, /if \(requestsOversizedPage\) return null/)
  assert.match(source, /if \(requestsStreamingResponse\(url\)\) return null/)
  assert.match(source, /\(\?:download\|export\)\$/)
  assert.match(source, /\(\?:file\|thumbnail\|voice\\\.ogg\)\$/)
})

test('mutaciones invalidan globalmente y eventos vivos solo enfrían sus modulos', async () => {
  const [authFetch, paymentsLive, chatLive] = await Promise.all([
    repoFile('frontend/src/services/authFetch.ts'),
    repoFile('frontend/src/services/paymentLiveEventsService.ts'),
    repoFile('frontend/src/services/chatLiveEventsService.ts')
  ])

  assert.match(authFetch, /const API_READ_ONLY_POST_PATHS = new Set/)
  assert.match(authFetch, /'\/api\/tracking\/analytics\/summary'/)
  assert.match(authFetch, /'\/api\/tracking\/sessions\/search'/)
  assert.match(authFetch, /shouldInvalidateApiReadCache\(method, requestUrl\.pathname\)/)
  assert.match(authFetch, /pathPrefixes\?: string\[\]/)
  assert.match(authFetch, /cacheKeyMatchesPathPrefixes/)
  assert.match(authFetch, /apiReadInFlight\.delete\(key\)/)
  assert.match(paymentsLive, /PAYMENT_LIVE_CACHE_PATHS[\s\S]*invalidateRistakApiReadCache\(\{ pathPrefixes: PAYMENT_LIVE_CACHE_PATHS \}\)[\s\S]*options\.onEvent/)
  assert.match(chatLive, /CHAT_LIVE_CACHE_PATHS[\s\S]*invalidateRistakApiReadCache\(\{ pathPrefixes: CHAT_LIVE_CACHE_PATHS \}\)[\s\S]*options\.onMessage/)
  assert.match(chatLive, /CHAT_APPOINTMENT_CACHE_PATHS[\s\S]*parsed\.event === 'chat_data_changed'[\s\S]*payload\.domains\.includes\('appointments'\)[\s\S]*invalidateRistakApiReadCache\(\{ pathPrefixes: CHAT_APPOINTMENT_CACHE_PATHS \}\)/)
  assert.match(chatLive, /CHAT_APPOINTMENT_CACHE_PATHS = \[[\s\S]*?'\/api\/calendars'/)
  assert.doesNotMatch(paymentsLive, /PAYMENT_LIVE_CACHE_PATHS = \[[\s\S]*?'\/api\/sites'/)
  assert.doesNotMatch(chatLive, /CHAT_LIVE_CACHE_PATHS = \[[\s\S]*?'\/api\/sites'/)
})

test('el GET compartido sigue registrado hasta terminar de materializar su snapshot', async () => {
  const source = await repoFile('frontend/src/services/authFetch.ts')

  assert.match(source, /const cacheLifecycle = sharedRequest\.then\(async response/)
  assert.match(source, /await cacheApiResponse\(/)
  assert.match(source, /cacheLifecycle[\s\S]*\.finally\(\(\) => \{[\s\S]*apiReadInFlight\.delete/)
})
