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

test('config agrupa JSON pequeño por llave con cache acotado por cuenta', async () => {
  const [authFetch, configService, configHook, themeContext] = await Promise.all([
    repoFile('frontend/src/services/authFetch.ts'),
    repoFile('frontend/src/services/appConfigService.ts'),
    repoFile('frontend/src/hooks/useAppConfig.ts'),
    repoFile('frontend/src/contexts/ThemeContext.tsx')
  ])

  assert.match(configService, /APP_CONFIG_CACHE_TTL_MS = 60_000/)
  assert.match(configService, /APP_CONFIG_CACHE_MAX_ENTRIES = 128/)
  assert.match(configService, /APP_CONFIG_REQUEST_TIMEOUT_MS = 20_000/)
  assert.match(configService, /getOrCreateSharedRequest\(\{/)
  assert.match(configService, /queueMicrotask\(\(\) =>/)
  assert.match(configService, /appConfigKeyInflight/)
  assert.match(configService, /keysToEnqueue/)
  assert.match(configService, /createRequest: sharedSignal => withRequestTimeout\(\{/)
  assert.match(configService, /registerAuthScopedCacheInvalidator\(clearAppConfigReadCache\)/)
  assert.match(configService, /pathPrefixes: \['\/api\/config'\]/)
  assert.match(configService, /batch\.authRevision === getAuthScopedCacheRevision\(\)/)
  assert.match(configService, /batch\.cacheRevision === appConfigCacheRevision/)
  assert.doesNotMatch(configService, /Response\.clone|response\.clone|arrayBuffer/)
  assert.match(configHook, /getAppConfigValues\(\[key\]\)/)
  assert.match(themeContext, /getAppConfigValues\(\[\s*THEME_COLOR_CONFIG_KEY,\s*THEME_DIR_CONFIG_KEY\s*\]\)/)
  assert.doesNotMatch(
    themeContext,
    /fetch\(apiUrl\(`\/api\/config\?keys=\$\{THEME_COLOR_CONFIG_KEY\},\$\{THEME_DIR_CONFIG_KEY\}`\)\)/
  )
  assert.match(
    configHook,
    /if \(!response\.ok\)[\s\S]*?throw new Error\('Failed to save config'\)[\s\S]*?clearAppConfigReadCache\(\)[\s\S]*?dispatchEvent/,
    'sólo una mutación confirmada invalida el snapshot antes de publicar el valor nuevo'
  )
  assert.doesNotMatch(configHook, /fetch\(buildConfigUrl\(params\)/)
  assert.doesNotMatch(authFetch, /apiReadResponseCache|apiReadInFlight/)
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
