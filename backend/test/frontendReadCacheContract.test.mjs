import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..')
const repoFile = (path) => readFile(join(repoRoot, path), 'utf8')

test('authFetch no clona, materializa ni cachea globalmente las respuestas GET', async () => {
  const source = await repoFile('frontend/src/services/authFetch.ts')

  assert.doesNotMatch(source, /apiReadResponseCache|apiReadInFlight|cacheApiResponse/)
  assert.doesNotMatch(source, /response\.clone\(\)\.arrayBuffer\(\)/)
  assert.match(source, /return originalFetch\(input, nextInit\)/)
  assert.match(source, /registerRistakApiReadCacheInvalidator/)
  assert.match(source, /pathPrefixesOverlap/)
})

test('mutaciones y eventos vivos invalidan sólo los módulos que realmente dependen del cambio', async () => {
  const [authFetch, paymentsLive, chatLive] = await Promise.all([
    repoFile('frontend/src/services/authFetch.ts'),
    repoFile('frontend/src/services/paymentLiveEventsService.ts'),
    repoFile('frontend/src/services/chatLiveEventsService.ts')
  ])

  assert.match(authFetch, /const API_READ_ONLY_POST_PATHS = new Set/)
  assert.match(authFetch, /'\/api\/tracking\/analytics\/facets'/)
  assert.match(authFetch, /'\/api\/tracking\/analytics\/summary'/)
  assert.match(authFetch, /'\/api\/tracking\/sessions\/search'/)
  assert.match(authFetch, /shouldNotifyMutation\(method, requestUrl\.pathname\)/)
  assert.match(authFetch, /pathPrefixes\?: string\[\]/)
  assert.match(authFetch, /registerRistakApiReadCacheInvalidator\([\s\S]{0,180}pathPrefixes/)
  assert.match(authFetch, /getMutationInvalidationPrefixes/)
  assert.doesNotMatch(authFetch, /apiReadInFlight|apiReadResponseCache/)
  assert.match(paymentsLive, /PAYMENT_LIVE_CACHE_PATHS[\s\S]*invalidateRistakApiReadCache\(\{\s*pathPrefixes: PAYMENT_LIVE_CACHE_PATHS,\s*abortInflight: false\s*\}\)[\s\S]*options\.onEvent/)
  assert.match(chatLive, /CHAT_LIVE_CACHE_PATHS[\s\S]*invalidateRistakApiReadCache\(\{\s*pathPrefixes: CHAT_LIVE_CACHE_PATHS,\s*abortInflight: false\s*\}\)[\s\S]*options\.onMessage/)
  assert.match(chatLive, /CHAT_APPOINTMENT_CACHE_PATHS[\s\S]*parsed\.event === 'chat_data_changed'[\s\S]*payload\.domains\.includes\('appointments'\)[\s\S]*invalidateRistakApiReadCache\(\{\s*pathPrefixes: CHAT_APPOINTMENT_CACHE_PATHS,\s*abortInflight: false\s*\}\)/)
  assert.match(chatLive, /CHAT_APPOINTMENT_CACHE_PATHS = \[[\s\S]*?'\/api\/calendars'/)
  assert.doesNotMatch(paymentsLive, /PAYMENT_LIVE_CACHE_PATHS = \[[\s\S]*?'\/api\/sites'/)
  assert.doesNotMatch(chatLive, /CHAT_LIVE_CACHE_PATHS = \[[\s\S]*?'\/api\/sites'/)
})

test('los snapshots especializados comparten requests cancelables sin depender de authFetch', async () => {
  const [analytics, shared] = await Promise.all([
    repoFile('frontend/src/services/analyticsService.ts'),
    repoFile('frontend/src/services/sharedRequest.ts')
  ])

  assert.match(analytics, /getOrCreateSharedRequest\(\{/)
  assert.match(analytics, /abortWhenUnused: true/)
  assert.match(analytics, /withRequestTimeout\(\{/)
  assert.match(shared, /if \(lifecycle\.consumers === 0 && !lifecycle\.settled\)/)
  assert.match(shared, /lifecycle\.controller\.abort\(/)
})
