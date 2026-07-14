import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..')
const repoFile = (path) => readFile(join(repoRoot, path), 'utf8')

test('Analíticas consume agregados y deja las filas crudas a la búsqueda paginada', async () => {
  const [page, analyticsService] = await Promise.all([
    repoFile('frontend/src/pages/Analytics/Analytics.tsx'),
    repoFile('frontend/src/services/analyticsService.ts')
  ])

  assert.doesNotMatch(page, /getSessionsByDateRange/)
  assert.doesNotMatch(page, /setAllSessions|setSessions\(/)
  assert.match(page, /getTrackingAnalyticsSummary\(analyticsSummaryInput, \{[\s\S]*signal: controller\.signal,[\s\S]*forceRefresh: Boolean\(cachedSummary\)/)
  assert.match(page, /const controller = new AbortController\(\)/)
  assert.match(page, /analyticsRequestIdRef\.current === requestId/)
  assert.match(page, /<SessionsTable[\s\S]*range=\{\{ start: apiRange\.from, end: apiRange\.to \}\}[\s\S]*filters=\{webSummaryFilters\}/)

  assert.match(analyticsService, /'\/tracking\/analytics\/summary'/)
  assert.match(analyticsService, /const TRACKING_ANALYTICS_CACHE_TTL_MS = 30_000/)
  assert.match(analyticsService, /const TRACKING_ANALYTICS_CACHE_MAX_ENTRIES = 24/)
  assert.match(analyticsService, /export function invalidateTrackingAnalyticsSummaryCache\(\)/)
  assert.match(analyticsService, /registerAuthScopedCacheInvalidator\(invalidateTrackingAnalyticsSummaryCache\)/)
  assert.match(analyticsService, /registerRistakApiReadCacheInvalidator\(invalidateTrackingAnalyticsSummaryCache\)/)
  assert.match(analyticsService, /syncAuthScopedCachePrincipal\(\)/)
  assert.match(analyticsService, /requestPrincipalRevision === getAuthScopedCacheRevision\(\)/)
  assert.match(page, /onSessionsChanged=\{handleTrackingSessionsChanged\}/)
})

test('editar o borrar tracking invalida el snapshot agregado del navegador', async () => {
  const trackingService = await repoFile('frontend/src/services/trackingService.ts')

  assert.match(trackingService, /import \{ invalidateTrackingAnalyticsSummaryCache \} from '\.\/analyticsService'/)
  assert.equal((trackingService.match(/invalidateTrackingAnalyticsSummaryCache\(\)/g) || []).length, 2)
})

test('la vista inicial conserva estructura y usa esqueletos locales en vez de loader de página', async () => {
  const page = await repoFile('frontend/src/pages/Analytics/Analytics.tsx')

  assert.doesNotMatch(page, /return <Loading message="Cargando analíticas/)
  assert.match(page, /const analyticsRefreshing = loading \|\| !hasLoadedAnalytics/)
  assert.match(page, /loading=\{section\.loading\}/)
  assert.match(page, /El resumen web no respondió/)
  assert.match(page, /setAnalyticsRetryKey\(current => current \+ 1\)/)
})

test('el resumen de mensajes carga por separado y no bloquea el resumen web', async () => {
  const page = await repoFile('frontend/src/pages/Analytics/Analytics.tsx')
  const webBatch = page.match(/const \[summary, fallbackConversions, trackingConfig\] = await Promise\.all\(\[[\s\S]*?\n\s*\]\)/)?.[0]

  assert.match(page, /Mensajes se resuelve en paralelo y nunca frena las métricas web/)
  assert.ok(webBatch, 'debe existir el lote acotado del resumen web')
  assert.doesNotMatch(webBatch, /getMessageAnalyticsSummary/)
  assert.match(page, /const messageAnalyticsRefreshing = messageLoading \|\| !hasLoadedMessageAnalytics/)
  assert.match(page, /setHasWebAnalyticsSnapshot\(true\)/)
})
