import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { db } from '../src/config/database.js'
import {
  clearTrackingAnalyticsSummaryCache,
  getTrackingAnalyticsFacet,
  getTrackingAnalyticsSummary,
  TRACKING_ANALYTICS_FACET_LIMITS
} from '../src/services/trackingAnalyticsService.js'
import { invalidateTrackingAnalyticsCache } from '../src/services/trackingAnalyticsCache.js'

const serviceSource = readFileSync(
  new URL('../src/services/trackingAnalyticsService.js', import.meta.url),
  'utf8'
)
const controllerSource = readFileSync(
  new URL('../src/controllers/trackingController.js', import.meta.url),
  'utf8'
)
const routesSource = readFileSync(
  new URL('../src/routes/tracking.routes.js', import.meta.url),
  'utf8'
)

function sourceBetween(startMarker, endMarker) {
  const start = serviceSource.indexOf(startMarker)
  const end = serviceSource.indexOf(endMarker, start)
  assert.ok(start >= 0, `No se encontró ${startMarker}`)
  assert.ok(end > start, `No se encontró el cierre de ${startMarker}`)
  return serviceSource.slice(start, end)
}

function uniqueFilter(label) {
  return { utm_campaign: [`${label}-${process.pid}-${Date.now()}-${Math.random()}`] }
}

test('el core puede omitir facetas sin cambiar métricas ni series', { concurrency: false }, async () => {
  clearTrackingAnalyticsSummaryCache()
  const originals = { all: db.all, get: db.get }
  const capturedSql = []
  const input = {
    start: '2097-07-01',
    end: '2097-07-01',
    groupBy: 'day',
    filters: uniqueFilter('lazy-core')
  }

  for (const method of ['all', 'get']) {
    db[method] = async function captureReads(...args) {
      capturedSql.push(String(args[0] || ''))
      return originals[method].apply(this, args)
    }
  }

  try {
    const core = await getTrackingAnalyticsSummary({ ...input, includeFacets: false })
    const coreSql = capturedSql.join('\n')
    assert.doesNotMatch(coreSql, /hierarchy_base|dimension_values|dimension_counts/i)
    assert.deepEqual(core.distributions, {})
    assert.deepEqual(Object.keys(core.facets), ['conversions'])

    capturedSql.length = 0
    const complete = await getTrackingAnalyticsSummary({ ...input, includeFacets: true })
    assert.deepEqual(core.metrics, complete.metrics)
    assert.deepEqual(core.trafficSeries, complete.trafficSeries)
    assert.deepEqual(core.conversionSeries, complete.conversionSeries)
    assert.match(capturedSql.join('\n'), /hierarchy_base|dimension_values|dimension_counts/i)

    capturedSql.length = 0
    await getTrackingAnalyticsSummary({ ...input, includeFacets: false })
    assert.equal(capturedSql.length, 0, 'includeFacets forma parte de la llave y conserva su snapshot propio')
  } finally {
    db.all = originals.all
    db.get = originals.get
    clearTrackingAnalyticsSummaryCache()
  }
})

test('una faceta plana ejecuta una sola rama SQL, sin UNION de dimensiones', { concurrency: false }, async () => {
  clearTrackingAnalyticsSummaryCache()
  const originalAll = db.all
  const facetSql = []
  db.all = async function captureFacetSql(...args) {
    const sql = String(args[0] || '')
    if (/GROUP BY (?:fs|s)\.device_type/i.test(sql)) facetSql.push(sql)
    return originalAll.apply(this, args)
  }

  try {
    const result = await getTrackingAnalyticsFacet({
      start: '2097-07-02',
      end: '2097-07-02',
      filters: uniqueFilter('single-device'),
      dimension: 'devices'
    })

    assert.equal(result.facet.dimension, 'devices')
    assert.ok(Array.isArray(result.facet.items))
    assert.equal(facetSql.length, 1)
    assert.doesNotMatch(facetSql[0], /UNION\s+ALL/i)
    assert.match(facetSql[0], /LIMIT 25/i)
    await assert.rejects(
      getTrackingAnalyticsFacet({
        start: '2097-07-02',
        end: '2097-07-02',
        dimension: 'todas'
      }),
      error => error?.status === 400
    )
  } finally {
    db.all = originalAll
    clearTrackingAnalyticsSummaryCache()
  }
})

test('consumidores equivalentes comparten inflight y el caché sin cancelar al sobreviviente', { concurrency: false }, async () => {
  clearTrackingAnalyticsSummaryCache()
  const originalAll = db.all
  let facetCalls = 0
  let databaseSignal = null
  let releaseQuery
  let markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  const gate = new Promise(resolve => { releaseQuery = resolve })
  db.all = async function coalescedFacetRead(...args) {
    const sql = String(args[0] || '')
    if (/GROUP BY (?:fs|s)\.device_type/i.test(sql)) {
      facetCalls += 1
      databaseSignal = args[2]?.signal
      markStarted()
      await gate
      return [{ value: 'mobile', label: 'mobile', item_count: 2 }]
    }
    return originalAll.apply(this, args)
  }

  const input = {
    start: '2097-07-03',
    end: '2097-07-03',
    filters: uniqueFilter('facet-inflight'),
    dimension: 'devices'
  }
  try {
    const cancelledConsumer = new AbortController()
    const first = getTrackingAnalyticsFacet({ ...input, signal: cancelledConsumer.signal })
    await started
    const second = getTrackingAnalyticsFacet(input)
    // Permite que la segunda solicitud termine de resolver la zona horaria y
    // se suscriba al registro inflight antes de simular que la primera vista se
    // desmonta.
    await new Promise(resolve => setImmediate(resolve))
    cancelledConsumer.abort()
    await assert.rejects(first, error => error?.name === 'AbortError')
    assert.equal(databaseSignal?.aborted, false, 'el segundo consumidor conserva viva la lectura compartida')
    releaseQuery()

    const result = await second
    assert.deepEqual(result.facet.items, [{ value: 'mobile', label: 'mobile', count: 2 }])
    assert.equal(facetCalls, 1)
    const warm = await getTrackingAnalyticsFacet(input)
    assert.deepEqual(warm.facet.items, result.facet.items)
    assert.equal(facetCalls, 1, 'el snapshot caliente no vuelve a consultar')
  } finally {
    releaseQuery()
    db.all = originalAll
    clearTrackingAnalyticsSummaryCache()
  }
})

test('la cola singular es cancelable y la última baja aborta la consulta de base', { concurrency: false }, async () => {
  clearTrackingAnalyticsSummaryCache()
  const originalAll = db.all
  let active = 0
  let maxActive = 0
  let deviceRelease
  let deviceStarted
  let browserCalls = 0
  let browserSignal = null
  const firstStarted = new Promise(resolve => { deviceStarted = resolve })
  const deviceGate = new Promise(resolve => { deviceRelease = resolve })

  db.all = async function singularFacetRead(...args) {
    const sql = String(args[0] || '')
    const isDevice = /GROUP BY (?:fs|s)\.device_type/i.test(sql)
    const isBrowser = /GROUP BY (?:fs|s)\.browser/i.test(sql)
    if (!isDevice && !isBrowser) return originalAll.apply(this, args)

    active += 1
    maxActive = Math.max(maxActive, active)
    try {
      if (isDevice) {
        deviceStarted()
        await deviceGate
        return []
      }
      browserCalls += 1
      browserSignal = args[2]?.signal
      return await new Promise((resolve, reject) => {
        const onAbort = () => reject(browserSignal?.reason || Object.assign(new Error('aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR'
        }))
        browserSignal?.addEventListener('abort', onAbort, { once: true })
      })
    } finally {
      active -= 1
    }
  }

  try {
    const first = getTrackingAnalyticsFacet({
      start: '2097-07-04',
      end: '2097-07-04',
      filters: uniqueFilter('facet-queue-device'),
      dimension: 'devices'
    })
    await firstStarted
    const queuedController = new AbortController()
    const queued = getTrackingAnalyticsFacet({
      start: '2097-07-04',
      end: '2097-07-04',
      filters: uniqueFilter('facet-queue-browser'),
      dimension: 'browsers',
      signal: queuedController.signal
    })
    queuedController.abort()
    await assert.rejects(queued, error => error?.name === 'AbortError')
    assert.equal(browserCalls, 0, 'una intención descartada sale de la cola antes de tocar la base')
    deviceRelease()
    await first

    const lastController = new AbortController()
    const last = getTrackingAnalyticsFacet({
      start: '2097-07-05',
      end: '2097-07-05',
      filters: uniqueFilter('facet-last-consumer'),
      dimension: 'browsers',
      signal: lastController.signal
    })
    while (browserCalls === 0) await new Promise(resolve => setImmediate(resolve))
    lastController.abort()
    await assert.rejects(last, error => error?.name === 'AbortError')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(browserSignal?.aborted, true)
    assert.equal(maxActive, TRACKING_ANALYTICS_FACET_LIMITS.maxConcurrentBuilds)
  } finally {
    deviceRelease()
    db.all = originalAll
    clearTrackingAnalyticsSummaryCache()
  }
})

test('una revisión durante la faceta conserva semántica moving-window y coalesce', { concurrency: false }, async () => {
  clearTrackingAnalyticsSummaryCache()
  const originalAll = db.all
  const realDateNow = Date.now
  let now = realDateNow()
  let calls = 0
  let mutate = true
  Date.now = () => now
  db.all = async function revisionAwareFacet(...args) {
    const sql = String(args[0] || '')
    if (/GROUP BY (?:fs|s)\.os/i.test(sql)) {
      calls += 1
      if (mutate) {
        mutate = false
        invalidateTrackingAnalyticsCache()
      }
      return [{ value: 'iOS', label: 'iOS', item_count: 1 }]
    }
    return originalAll.apply(this, args)
  }

  const input = {
    start: '2097-07-06',
    end: '2097-07-06',
    filters: uniqueFilter('facet-revision'),
    dimension: 'os'
  }
  try {
    const moving = await getTrackingAnalyticsFacet(input)
    assert.equal(moving.snapshot.stale, true)
    assert.equal(moving.snapshot.consistency, 'moving-window')
    const coalesced = await getTrackingAnalyticsFacet(input)
    assert.equal(coalesced.snapshot.stale, true)
    assert.equal(calls, 1)

    now += TRACKING_ANALYTICS_FACET_LIMITS.coalesceWindowMs + 1
    const exact = await getTrackingAnalyticsFacet(input)
    assert.equal(exact.snapshot.stale, false)
    assert.equal(exact.snapshot.consistency, 'exact')
    assert.equal(calls, 2)
  } finally {
    Date.now = realDateNow
    db.all = originalAll
    clearTrackingAnalyticsSummaryCache()
  }
})

test('el deadline interno cancela la lectura real y responde como error reintentable', { concurrency: false }, async (context) => {
  clearTrackingAnalyticsSummaryCache()
  const originalAll = db.all
  let querySignal = null
  let markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  db.all = async function deadlineFacetRead(...args) {
    const sql = String(args[0] || '')
    if (!/GROUP BY (?:fs|s)\.placement/i.test(sql)) return originalAll.apply(this, args)
    querySignal = args[2]?.signal
    markStarted()
    return await new Promise((resolve, reject) => {
      const onAbort = () => reject(querySignal?.reason || Object.assign(new Error('aborted'), {
        name: 'AbortError',
        code: 'ABORT_ERR'
      }))
      querySignal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  try {
    context.mock.timers.enable(['setTimeout'])
    const request = getTrackingAnalyticsFacet({
      start: '2097-07-07',
      end: '2097-07-07',
      filters: uniqueFilter('facet-deadline'),
      dimension: 'placements'
    })
    await started
    context.mock.timers.tick(TRACKING_ANALYTICS_FACET_LIMITS.queryDeadlineMs)
    await assert.rejects(request, error => (
      error?.status === 503 && error?.code === 'tracking_analytics_facet_deadline'
    ))
    assert.equal(querySignal?.aborted, true)
  } finally {
    context.mock.timers.reset()
    db.all = originalAll
    clearTrackingAnalyticsSummaryCache()
  }
})

test('endpoint, allowlist, deadline y arquitectura singular quedan cerrados por contrato', () => {
  const coreSource = sourceBetween(
    'async function computeTrackingAnalyticsSummary',
    '\nfunction stableFilterCacheKey'
  )
  const singularPostgresSource = sourceBetween(
    'async function queryPostgresSingleSessionFacetWithoutConversionFilter',
    '\nfunction hierarchyNodeKey'
  )
  const singularFallbackSource = sourceBetween(
    'async function querySingleFlatSessionFacet',
    '\nasync function queryTrackingAnalyticsFacet'
  )

  assert.match(coreSource, /if \(includeFacets\)/)
  assert.match(coreSource, /distributions: includeFacets/)
  assert.doesNotMatch(singularPostgresSource, /UNION\s+ALL/i)
  assert.doesNotMatch(singularFallbackSource, /UNION\s+ALL/i)
  assert.match(serviceSource, /const FACET_QUERY_DEADLINE_MS = 18_000/)
  assert.match(serviceSource, /withTrackingFacetBuildSlot/)
  assert.match(serviceSource, /return await withTrackingSummaryQuerySlot\(signal, callback\)/)
  assert.match(controllerSource, /export async function getTrackingAnalyticsFacetHandler/)
  assert.match(controllerSource, /timeoutMs: TRACKING_AUXILIARY_QUERY_DEADLINE_MS/)
  assert.match(controllerSource, /includeFacets: body\.includeFacets !== false/)
  assert.match(controllerSource, /function trackingRequestDeadlineError\(\)/)
  assert.doesNotMatch(controllerSource, /trackingSummaryDeadlineError\(\)/)
  for (const handler of [
    'getTrackingAnalyticsSummaryHandler',
    'getTrackingAnalyticsFacetHandler',
    'searchTrackingSessionsHandler'
  ]) {
    const start = controllerSource.indexOf(`export async function ${handler}`)
    const end = controllerSource.indexOf('\n}', start)
    const source = controllerSource.slice(start, end)
    assert.ok(start >= 0 && end > start, `No se encontró ${handler}`)
    assert.ok(
      source.indexOf('if (requestScope.timedOut)') < source.indexOf('if (requestScope.signal.aborted'),
      `${handler} debe responder el deadline antes de tratarlo como aborto silencioso`
    )
  }
  assert.match(routesSource, /router\.post\('\/analytics\/facets', requireWebAnalyticsFeature, getTrackingAnalyticsFacetHandler\)/)

  for (const dimension of [
    'sources', 'devices', 'browsers', 'os', 'placements', 'trafficChannels',
    'trackingSources', 'pages', 'siteTypes', 'nativeSites', 'nativeForms',
    'nativeConversions', 'topVisitors', 'adsHierarchy'
  ]) {
    assert.ok(TRACKING_ANALYTICS_FACET_LIMITS.dimensions.includes(dimension), dimension)
  }
  assert.equal(TRACKING_ANALYTICS_FACET_LIMITS.maxConcurrentBuilds, 1)
  assert.equal(TRACKING_ANALYTICS_FACET_LIMITS.queryDeadlineMs, 18_000)
})
