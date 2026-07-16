import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..')
const repoFile = path => readFile(join(repoRoot, path), 'utf8')

test('Analíticas pinta el snapshot fresco y difiere una sola revalidación stale', async () => {
  const source = await repoFile('frontend/src/pages/Analytics/Analytics.tsx')
  const cachedApplyIndex = source.indexOf('if (cachedSummary) {')
  const fetchIndex = source.indexOf('const fetchAnalytics = async () =>', cachedApplyIndex)
  const initialSummaryRequest = source.slice(
    source.indexOf('const summaryPromise', fetchIndex),
    source.indexOf('const fallbackConversionsPromise', fetchIndex)
  )

  assert.ok(cachedApplyIndex >= 0)
  assert.ok(fetchIndex > cachedApplyIndex)
  assert.match(source.slice(cachedApplyIndex, fetchIndex), /applyTrackingSummary\(cachedSummary(?:,\s*null)?\)/)
  assert.doesNotMatch(initialSummaryRequest, /forceRefresh/)
  assert.doesNotMatch(initialSummaryRequest, /waitForFresh/)
  assert.match(source, /scheduleTrackingAnalyticsStaleRevalidation\(summary\.snapshot/)
  assert.equal((source.match(/waitForFresh: true/g) || []).length, 1)
})

test('Dashboard cancela y descarta datasets extendidos de una ventana anterior', async () => {
  const [page, service] = await Promise.all([
    repoFile('frontend/src/pages/Dashboard/Dashboard.tsx'),
    repoFile('frontend/src/services/dashboardService.ts')
  ])

  assert.match(page, /const extendedChartRequestRef = React\.useRef\(0\)/)
  assert.match(page, /extendedChartAbortRef\.current\?\.abort\(\)/)
  assert.match(page, /extendedChartRequestRef\.current === requestId/)
  assert.match(page, /signal: controller\.signal/)
  assert.match(page, /if \(!isCurrentRequest\(\)\) return/)
  assert.match(service, /signal\?: AbortSignal/)
  assert.match(service, /async function fetchDashboardSeries\([\s\S]{0,500}scheduleDashboardHeavyRead\(\{[\s\S]{0,220}signal,/)
  assert.match(service, /function scheduleDashboardHeavyRead<[\s\S]{0,500}\(\) => withRequestTimeout\(\{/)
  assert.ok((service.match(/fetchDashboardSeries\([^\n]+params\.signal/g) || []).length >= 5)
})

test('Reportes cancela y descarta snapshots unificados atrasados al cambiar el rango', async () => {
  const [page, service] = await Promise.all([
    repoFile('frontend/src/pages/Reports/Reports.tsx'),
    repoFile('frontend/src/services/reportsService.ts')
  ])

  assert.match(page, /const snapshotRequestRef = React\.useRef\(0\)/)
  assert.match(page, /const controller = new AbortController\(\)/)
  assert.match(page, /snapshotRequestRef\.current === requestId/)
  assert.match(page, /reportsService\.getSnapshot\([\s\S]{0,180}controller\.signal/)
  assert.match(page, /result\.cache\.stale/)
  assert.match(page, /waitForFresh: true/)
  assert.match(page, /controller\.abort\(\)/)
  assert.match(service, /async getSnapshot\([\s\S]{0,380}signal\?: AbortSignal/)
  assert.match(service, /withRequestTimeout\(\{/)
  assert.match(service, /request:\s*requestSignal\s*=>\s*apiClient\.get<ReportsSnapshot>\('\/reports\/snapshot',[\s\S]{0,120}signal:\s*requestSignal/)
})

test('los drilldowns de Publicidad no mezclan hijos de otro rango o página', async () => {
  const source = await repoFile('frontend/src/pages/Campaigns/Campaigns.tsx')

  assert.match(source, /const entityContextKey = \[/)
  assert.match(source, /const campaignChildrenRequestRef = React\.useRef\(new Map<string, number>\(\)\)/)
  assert.match(source, /const adSetChildrenRequestRef = React\.useRef\(new Map<string, number>\(\)\)/)
  assert.ok((source.match(/entityRequestRef\.current === entityRequestVersion/g) || []).length >= 2)
  assert.ok((source.match(/entityContextRef\.current === requestContextKey/g) || []).length >= 2)
  assert.ok((source.match(/if \(!isCurrentRequest\(\)\) return response/g) || []).length >= 2)
  assert.match(source, /loadCampaignAdSetsPage\(cleanCampaignId, 1\)\.catch\(\(\) => undefined\)/)
  assert.match(source, /loadAdSetAdsPage\(cleanAdSetId, String\(campaignId\), 1\)\.catch\(\(\) => undefined\)/)
})

test('el cache persistente del chat está aislado por principal y purga llaves legacy', async () => {
  const [desktop, phone, dailyCache, scopedStorage] = await Promise.all([
    repoFile('frontend/src/pages/DesktopChat/DesktopChat.tsx'),
    repoFile('frontend/src/pages/PhoneChat/PhoneChat.tsx'),
    repoFile('frontend/src/services/phoneDailyCache.ts'),
    repoFile('frontend/src/services/authScopedLocalStorage.ts')
  ])

  assert.match(scopedStorage, /getAuthScopedCachePrincipalFingerprint/)
  assert.match(scopedStorage, /const AUTH_SCOPED_STORAGE_VERSION = 'p2'/)
  assert.match(scopedStorage, /registerAuthScopedCacheInvalidator\(clear\)/)
  assert.match(scopedStorage, /if \(!ownedPrefixes\.includes\(prefix\)\)/)
  assert.match(scopedStorage, /key === candidate \|\| key\.startsWith\(`\$\{candidate\}:`\)/)
  assert.match(scopedStorage, /key !== scopedRoot && !key\.startsWith\(`\$\{scopedRoot\}:`\)/)
  assert.match(desktop, /createAuthScopedLocalStorageNamespace\(CHAT_PERSISTENT_CACHE_PREFIXES\)/)
  assert.match(desktop, /getScopedChatStorageKey\(CHAT_CACHE_KEY\)/)
  assert.match(desktop, /getScopedChatStorageKey\(CHAT_CONVERSATION_CACHE_KEY_PREFIX\)/)
  assert.doesNotMatch(desktop, /localStorage\.getItem\(CHAT_CACHE_KEY\)/)
  assert.doesNotMatch(desktop, /localStorage\.setItem\(CHAT_CACHE_KEY/)
  assert.match(phone, /createAuthScopedLocalStorageNamespace\(PHONE_CHAT_PERSISTENT_CACHE_PREFIXES\)/)
  assert.match(phone, /getScopedPhoneChatStorageKey\(CHAT_FAST_START_INBOX_KEY\)/)
  assert.match(phone, /getScopedPhoneChatStorageKey\(AI_AGENT_MESSAGES_KEY\)/)
  assert.doesNotMatch(phone, /localStorage\.getItem\((?:CHAT_[A-Z_]+|AI_AGENT_MESSAGES_KEY)/)
  assert.match(dailyCache, /createAuthScopedLocalStorageNamespace\(\[CACHE_STORAGE_PREFIX\]\)/)
  assert.match(dailyCache, /phoneDailyStorage\.getKey\(CACHE_STORAGE_PREFIX\)/)
})

test('la primera observación del principal conserva snapshots válidos y un cambio real invalida', async () => {
  const [principalCache, integrations] = await Promise.all([
    repoFile('frontend/src/services/authPrincipalCache.ts'),
    repoFile('frontend/src/services/integrationsService.ts')
  ])

  const firstObservation = principalCache.match(
    /if \(currentAuthPrincipal === AUTH_PRINCIPAL_UNINITIALIZED\) \{([\s\S]*?)\n  \}/
  )?.[1] || ''
  assert.match(firstObservation, /currentAuthPrincipal = token/)
  assert.match(firstObservation, /return false/)
  assert.doesNotMatch(firstObservation, /authScopedCacheRevision|invalidate/)
  assert.match(principalCache, /authScopedCacheRevision \+= 1[\s\S]*authScopedCacheInvalidators\.forEach/)
  assert.match(integrations, /return getAuthScopedCachePrincipalFingerprint\(\)/)
})

test('el contrato del principal ejecuta la primera observación sin borrar y rota después', async () => {
  const source = await repoFile('frontend/src/services/authPrincipalCache.ts')
  const executableSource = source
    .replace(/^type AuthScopedCacheInvalidator = .*$/m, '')
    .replace('new Set<AuthScopedCacheInvalidator>()', 'new Set()')
    .replace(
      /let currentAuthPrincipal: string \| null \| typeof AUTH_PRINCIPAL_UNINITIALIZED =/,
      'let currentAuthPrincipal ='
    )
    .replace(
      /export function registerAuthScopedCacheInvalidator\(invalidator: AuthScopedCacheInvalidator\)/,
      'export function registerAuthScopedCacheInvalidator(invalidator)'
    )
    .replace(
      /export function getAuthScopedCachePrincipalFingerprint\(token: string \| null =/,
      'export function getAuthScopedCachePrincipalFingerprint(token ='
    )
    .replace(
      /export function syncAuthScopedCachePrincipal\(token: string \| null =/,
      'export function syncAuthScopedCachePrincipal(token ='
    )

  const previousWindow = globalThis.window
  const storage = new Map([['auth_token', 'principal-alpha-secret']])
  globalThis.window = {
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    }
  }

  try {
    const encoded = Buffer.from(executableSource, 'utf8').toString('base64')
    const module = await import(`data:text/javascript;base64,${encoded}#${Date.now()}`)
    let invalidations = 0
    module.registerAuthScopedCacheInvalidator(() => { invalidations += 1 })

    assert.equal(module.syncAuthScopedCachePrincipal('principal-alpha-secret'), false)
    assert.equal(module.getAuthScopedCacheRevision(), 0)
    assert.equal(invalidations, 0)
    const fingerprint = module.getAuthScopedCachePrincipalFingerprint('principal-alpha-secret')
    assert.equal(fingerprint.includes('principal-alpha-secret'), false)

    assert.equal(module.syncAuthScopedCachePrincipal('principal-beta-secret'), true)
    assert.equal(module.getAuthScopedCacheRevision(), 1)
    assert.equal(invalidations, 1)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('el namespace persistente purga legacy y jamás reutiliza el snapshot de otro principal', async () => {
  const source = await repoFile('frontend/src/services/authScopedLocalStorage.ts')
  const executableSource = `${`
    let testFingerprint = '10:principal-a'
    const testInvalidators = new Set()
    function getAuthScopedCachePrincipalFingerprint() { return testFingerprint }
    function registerAuthScopedCacheInvalidator(invalidator) { testInvalidators.add(invalidator) }
    export function __setTestFingerprint(value) { testFingerprint = value }
    export function __invalidateTestPrincipal() { testInvalidators.forEach(invalidator => invalidator()) }
  `}${source
    .replace(/import \{[\s\S]*?\} from '\.\/authPrincipalCache'\n/, '')
    .replace(/function getStorageKeys\(storage: Storage\)/, 'function getStorageKeys(storage)')
    .replace(/\.filter\(\(key\): key is string =>/, '.filter((key) =>')
    .replace(
      /export function createAuthScopedLocalStorageNamespace\(prefixes: readonly string\[\]\)/,
      'export function createAuthScopedLocalStorageNamespace(prefixes)'
    )}`
    .replace(/let preparedPrincipal: string \| null =/, 'let preparedPrincipal =')
    .replace(/const ownsKey = \(key: string\)/, 'const ownsKey = (key)')
    .replace(/const getKey = \(prefix: string\)/, 'const getKey = (prefix)')

  const values = new Map([
    ['ristak_test_chat_cache', 'legacy-without-owner'],
    ['ristak_test_chat_cache:p2:12:old-principal', 'other-account']
  ])
  const localStorage = {
    get length() { return values.size },
    key(index) { return [...values.keys()][index] || null },
    getItem(key) { return values.get(key) || null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) }
  }
  const previousWindow = globalThis.window
  globalThis.window = { localStorage }

  try {
    const encoded = Buffer.from(executableSource, 'utf8').toString('base64')
    const module = await import(`data:text/javascript;base64,${encoded}#${Date.now()}`)
    const namespace = module.createAuthScopedLocalStorageNamespace(['ristak_test_chat_cache'])
    const accountAKey = namespace.getKey('ristak_test_chat_cache')
    assert.equal(accountAKey, 'ristak_test_chat_cache:p2:10:principal-a')
    assert.equal(values.has('ristak_test_chat_cache'), false)
    assert.equal(values.has('ristak_test_chat_cache:p2:12:old-principal'), false)
    values.set(accountAKey, 'account-a-snapshot')

    module.__setTestFingerprint('10:principal-b')
    const accountBKey = namespace.getKey('ristak_test_chat_cache')
    assert.equal(accountBKey, 'ristak_test_chat_cache:p2:10:principal-b')
    assert.equal(values.has(accountAKey), false)
    assert.equal(values.get(accountBKey), undefined)

    values.set(accountBKey, 'account-b-snapshot')
    module.__invalidateTestPrincipal()
    assert.equal(values.has(accountBKey), false)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})
