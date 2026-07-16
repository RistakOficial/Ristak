import assert from 'node:assert/strict'
import test from 'node:test'

import { db, setAppConfig } from '../src/config/database.js'
import { getTrackingAnalyticsSummaryHandler } from '../src/controllers/trackingController.js'
import { runCrmListProjectionBackfill } from '../src/services/crmListProjectionService.js'
import {
  clearTrackingAnalyticsSummaryCache,
  getTrackingAnalyticsSummary
} from '../src/services/trackingAnalyticsService.js'
import { invalidateTrackingAnalyticsCache } from '../src/services/trackingAnalyticsCache.js'
import { runTrackingAnalyticsProjectionBackfill } from '../src/services/trackingAnalyticsProjectionService.js'
import { runTrackingConversionProjectionBackfill } from '../src/services/trackingConversionProjectionService.js'
import { runVersionedMigrations } from '../src/startup/runMigrations.js'
import {
  ACCOUNT_TIMEZONE_CONFIG_KEY,
  invalidateTimezoneCache
} from '../src/utils/dateUtils.js'

async function convergeTrackingReadModels(timezone = 'UTC') {
  await runVersionedMigrations()
  await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, timezone)
  invalidateTimezoneCache()
  await runCrmListProjectionBackfill({ batchSize: 500, yieldMs: 0 })

  let trackingResult = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    trackingResult = await runTrackingAnalyticsProjectionBackfill({
      batchSize: 100,
      queueBatchSize: 100,
      maxBatches: 4,
      maxQueueBatches: 10,
      yieldMs: 0
    })
    if (trackingResult.ready) break
  }
  assert.equal(trackingResult?.ready, true, 'read model 113 no convergió')

  let conversionResult = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    conversionResult = await runTrackingConversionProjectionBackfill({
      batchSize: 100,
      queueBatchSize: 100,
      maxBatches: 4,
      maxQueueBatches: 10,
      yieldMs: 0
    })
    if (conversionResult.ready) break
  }
  assert.equal(conversionResult?.ready, true, 'read model 116 no convergió')
}

function captureDatabaseReads() {
  const originals = { all: db.all, get: db.get }
  const sql = []
  for (const method of ['all', 'get']) {
    db[method] = async function capturedRead(...args) {
      sql.push(String(args[0] || ''))
      return originals[method].apply(this, args)
    }
  }
  return {
    sql,
    restore() {
      db.all = originals.all
      db.get = originals.get
    }
  }
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value)
    },
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return payload
    }
  }
}

test.before(async () => {
  await convergeTrackingReadModels('UTC')
})

test.afterEach(() => {
  clearTrackingAnalyticsSummaryCache()
})

test('includeFacets:false usa sólo 113+116 y el cache caliente no reagrega negocio', {
  concurrency: false
}, async () => {
  const captured = captureDatabaseReads()
  const input = {
    start: '2098-04-01',
    end: '2098-04-30',
    groupBy: 'day',
    filters: {},
    includeFacets: false,
    allowStale: false
  }

  try {
    const first = await getTrackingAnalyticsSummary(input)
    assert.equal(first.performance.sessionReadModel, 'tracking_analytics_range_delta_v2')
    assert.equal(first.performance.conversionReadModel, 'tracking_conversion_daily_rollup')
    assert.deepEqual(first.distributions, {})
    assert.deepEqual(Object.keys(first.facets), ['conversions'])
    assert.deepEqual(first.trafficSeries, [], 'un rango vacío conserva la serie legacy dispersa')

    const coldSql = captured.sql.join('\n')
    assert.match(coldSql, /tracking_analytics_range_delta/i)
    assert.match(coldSql, /tracking_conversion_daily_rollup/i)
    assert.doesNotMatch(coldSql, /\bFROM\s+(?:sessions|contacts|payments|appointments)\b/i)

    captured.sql.length = 0
    const cached = await getTrackingAnalyticsSummary(input)
    assert.deepEqual(cached.metrics, first.metrics)
    const cacheProbeSql = captured.sql.join('\n')
    assert.match(cacheProbeSql, /tracking_analytics_projection_state/i)
    assert.match(cacheProbeSql, /tracking_conversion_projection_state/i)
    assert.doesNotMatch(
      cacheProbeSql,
      /tracking_analytics_(?:range_delta|presence)|tracking_conversion_(?:daily_rollup|contact_fact)/i
    )
  } finally {
    captured.restore()
  }
})

test('consumidores equivalentes coalescen y la última baja cancela la consulta proyectada', {
  concurrency: false
}, async () => {
  const originalAll = db.all
  const originalGet = db.get
  let projectedCalls = 0
  let conversionStatusReads = 0
  let databaseSignal = null
  let markStarted
  const started = new Promise(resolve => { markStarted = resolve })

  db.all = async function cancellableProjectionRead(...args) {
    const sql = String(args[0] || '')
    if (!/WITH requested_periods/i.test(sql)) return originalAll.apply(this, args)
    projectedCalls += 1
    if (projectedCalls !== 1) return originalAll.apply(this, args)
    databaseSignal = args[2]?.signal
    markStarted()
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(databaseSignal?.reason || Object.assign(new Error('aborted'), {
        name: 'AbortError',
        code: 'ABORT_ERR'
      }))
      databaseSignal?.addEventListener('abort', onAbort, { once: true })
    })
  }
  db.get = async function observedStatusRead(...args) {
    if (/SELECT contact_id FROM tracking_conversion_change_queue LIMIT 1/i.test(String(args[0] || ''))) {
      conversionStatusReads += 1
    }
    return originalGet.apply(this, args)
  }

  const input = {
    start: '2098-05-01',
    end: '2098-05-02',
    groupBy: 'day',
    filters: {},
    includeFacets: false
  }
  try {
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = getTrackingAnalyticsSummary({ ...input, signal: firstController.signal })
    await started
    const statusReadsBeforeSecond = conversionStatusReads
    const second = getTrackingAnalyticsSummary({ ...input, signal: secondController.signal })
    for (let attempt = 0; attempt < 20 && conversionStatusReads <= statusReadsBeforeSecond; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }
    // Los probes O(1) de estado ocurren antes de suscribirse al inflight. Darles
    // una ventana acotada evita que esta prueba confunda ese preflight con una
    // cancelación del build compartido.
    await new Promise(resolve => setTimeout(resolve, 25))

    firstController.abort()
    await assert.rejects(first, error => error?.name === 'AbortError')
    assert.equal(databaseSignal?.aborted, false, 'el segundo consumidor conserva el build compartido')

    secondController.abort()
    await assert.rejects(second, error => error?.name === 'AbortError')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(databaseSignal?.aborted, true, 'la última baja cancela la lectura 113 real')
    assert.equal(projectedCalls, 1, 'ambos consumidores deben compartir un solo build')
  } finally {
    db.all = originalAll
    db.get = originalGet
  }
})

test('allowStale:false reconstruye de inmediato un snapshot que cruzó revisión', {
  concurrency: false
}, async () => {
  const originalAll = db.all
  let projectedCalls = 0
  let mutateOnce = true
  db.all = async function revisionAwareProjectionRead(...args) {
    const sql = String(args[0] || '')
    if (/WITH requested_periods/i.test(sql)) {
      projectedCalls += 1
      if (mutateOnce) {
        mutateOnce = false
        invalidateTrackingAnalyticsCache()
      }
    }
    return originalAll.apply(this, args)
  }

  const input = {
    start: '2098-06-01',
    end: '2098-06-02',
    groupBy: 'day',
    filters: {},
    includeFacets: false
  }
  try {
    const moving = await getTrackingAnalyticsSummary(input)
    assert.equal(moving.snapshot.stale, true)
    const afterMoving = projectedCalls

    const staleAllowed = await getTrackingAnalyticsSummary({ ...input, allowStale: true })
    assert.equal(staleAllowed.snapshot.stale, true)
    assert.equal(projectedCalls, afterMoving)

    const exact = await getTrackingAnalyticsSummary({ ...input, allowStale: false })
    assert.equal(exact.snapshot.stale, false)
    assert.ok(projectedCalls > afterMoving, 'waitForFresh debe reconstruir sin esperar el TTL')
  } finally {
    db.all = originalAll
  }
})

test('una generación 113 anterior falla warming sin tocar raw ni arrancar el rebuild desde HTTP', {
  concurrency: false
}, async () => {
  const state = await db.get(`
    SELECT projection_version, status, backfill_cursor, backfill_complete,
      range_status, range_compile_cursor, range_backfill_complete
    FROM tracking_analytics_projection_state_v4 WHERE singleton_id = 1
  `)
  const captured = captureDatabaseReads()
  try {
    await db.run(`
      UPDATE tracking_analytics_projection_state_v4
      SET projection_version = 3, status = 'backfilling'
      WHERE singleton_id = 1
    `)
    await assert.rejects(
      getTrackingAnalyticsSummary({
        start: '2098-07-01',
        end: '2098-07-01',
        groupBy: 'day',
        includeFacets: false,
        allowStale: false
      }),
      error => error?.code === 'tracking_analytics_projection_warming'
        && error?.status === 503
    )

    const response = createResponse()
    await getTrackingAnalyticsSummaryHandler({
      body: {
        start: '2098-07-01',
        end: '2098-07-01',
        groupBy: 'day',
        includeFacets: false,
        waitForFresh: true
      }
    }, response)
    assert.equal(response.statusCode, 503)
    assert.equal(response.body?.code, 'tracking_analytics_projection_warming')
    assert.equal(response.body?.retryable, true)
    assert.equal(response.headers['retry-after'], '2')
    const afterRead = await db.get(`
      SELECT projection_version, status, backfill_cursor
      FROM tracking_analytics_projection_state_v4 WHERE singleton_id = 1
    `)
    assert.equal(Number(afterRead.projection_version), 3)
    assert.equal(afterRead.status, 'backfilling')
    assert.equal(afterRead.backfill_cursor, state.backfill_cursor)
    assert.doesNotMatch(
      captured.sql.join('\n'),
      /\bFROM\s+(?:sessions|contacts|payments|appointments)\b/i
    )
  } finally {
    captured.restore()
    await db.run(`
      UPDATE tracking_analytics_projection_state_v4
      SET projection_version = ?, status = ?, backfill_cursor = ?, backfill_complete = ?,
        range_status = ?, range_compile_cursor = ?, range_backfill_complete = ?
      WHERE singleton_id = 1
    `, [
      state.projection_version,
      state.status,
      state.backfill_cursor,
      state.backfill_complete,
      state.range_status,
      state.range_compile_cursor,
      state.range_backfill_complete
    ])
  }
})
