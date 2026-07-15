import { createHash } from 'node:crypto'

import { databaseDialect, db } from '../config/database.js'
import {
  getCampaignPerformanceAccountScope,
  getCampaignPerformanceSourceRevision
} from './campaignPerformanceMaterializationService.js'
import {
  buildAggregatedReportMetrics,
  buildReportComparisonTotals
} from './reportMetricsAggregationService.js'
import { createDatabaseAbortError } from '../utils/postgresCancelableQuery.js'

const SNAPSHOT_STALE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const SNAPSHOT_MAX_ENTRIES_PER_PRINCIPAL = 48
const SNAPSHOT_MAX_ENTRIES_PER_ACCOUNT = 192
const SNAPSHOT_MAX_CONCURRENT_BUILDS = 2
const VALID_GROUPS = new Set(['day', 'month', 'year'])
const VALID_SCOPES = new Set(['all', 'attribution', 'campaigns'])
const builds = new Map()
const buildWaiters = []
let activeBuilds = 0

function clean(value, maxLength = 300) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function isSnapshotSchemaUnavailable(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || '')
  return code === '42P01' || (
    code === 'SQLITE_ERROR' && /no such table:\s*(?:reports_snapshot_cache|reports_snapshot_revision|campaign_performance_revision)/i.test(message)
  )
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createDatabaseAbortError()
}

function signalOptions(signal) {
  return signal ? { signal } : undefined
}

async function withBuildSlot(callback) {
  if (activeBuilds >= SNAPSHOT_MAX_CONCURRENT_BUILDS) {
    await new Promise(resolve => buildWaiters.push(resolve))
  } else {
    activeBuilds += 1
  }
  try {
    return await callback()
  } finally {
    const next = buildWaiters.shift()
    if (next) next()
    else activeBuilds -= 1
  }
}

function normalizeQuery({ startDate, endDate, groupBy, scope } = {}) {
  const normalizedGroup = VALID_GROUPS.has(groupBy) ? groupBy : 'day'
  const normalizedScope = VALID_SCOPES.has(scope) ? scope : 'all'
  return {
    startDate: clean(startDate, 40),
    endDate: clean(endDate, 40),
    groupBy: normalizedGroup,
    scope: normalizedScope
  }
}

function buildSnapshotCacheKey(query) {
  return sha256(JSON.stringify({ version: 1, ...query }))
}

function normalizePrincipalScope(principal) {
  return `principal:${sha256(clean(principal, 500) || 'authenticated-user')}`
}

async function getSnapshotSourceRevision(signal) {
  throwIfAborted(signal)
  const visitorRevisionPromise = getCampaignPerformanceSourceRevision({ includeVisitors: true, signal })
  if (databaseDialect === 'postgres') {
    const [row, visitorRevision] = await Promise.all([
      db.get(
        'SELECT last_value, is_called FROM reports_snapshot_revision_seq',
        [],
        signalOptions(signal)
      ),
      visitorRevisionPromise
    ])
    const coreRevision = row?.is_called ? Number(row.last_value || 0) : 0
    return `reports:${coreRevision}|${visitorRevision}`
  }

  const [row, visitorRevision] = await Promise.all([
    db.get(
      'SELECT revision FROM reports_snapshot_revision WHERE singleton = 1',
      [],
      signalOptions(signal)
    ),
    visitorRevisionPromise
  ])
  return `reports:${Number(row?.revision || 0)}|${visitorRevision}`
}

async function readSnapshot({ accountScope, principalScope, cacheKey, sourceRevision, signal }) {
  const row = await db.get(`
    SELECT source_revision, payload_json, built_at
    FROM reports_snapshot_cache
    WHERE account_scope = ?
      AND principal_scope = ?
      AND cache_key = ?
    LIMIT 1
  `, [accountScope, principalScope, cacheKey], signalOptions(signal))

  if (!row) return null
  const exact = String(row.source_revision || '') === sourceRevision
  if (!exact && Date.now() - timestampMs(row.built_at) > SNAPSHOT_STALE_MAX_AGE_MS) return null
  let payload
  try {
    payload = JSON.parse(row.payload_json)
  } catch {
    return null
  }

  void db.run(`
    UPDATE reports_snapshot_cache
    SET last_accessed_at = CURRENT_TIMESTAMP
    WHERE account_scope = ? AND principal_scope = ? AND cache_key = ?
  `, [accountScope, principalScope, cacheKey]).catch(() => undefined)

  return {
    payload,
    builtAt: String(row.built_at || ''),
    builtSourceRevision: String(row.source_revision || ''),
    exact
  }
}

async function persistSnapshot({ accountScope, principalScope, cacheKey, sourceRevision, payload, signal }) {
  throwIfAborted(signal)
  const builtAt = new Date().toISOString()
  await db.run(`
    INSERT INTO reports_snapshot_cache (
      account_scope, principal_scope, cache_key, source_revision,
      payload_json, built_at, last_accessed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_scope, principal_scope, cache_key) DO UPDATE SET
      source_revision = excluded.source_revision,
      payload_json = excluded.payload_json,
      built_at = excluded.built_at,
      last_accessed_at = excluded.last_accessed_at
  `, [
    accountScope,
    principalScope,
    cacheKey,
    sourceRevision,
    JSON.stringify(payload),
    builtAt,
    builtAt
  ], signalOptions(signal))

  return builtAt
}

async function pruneSnapshotCache({ accountScope, principalScope }) {
  await db.run(`
    DELETE FROM reports_snapshot_cache
    WHERE account_scope = ?
      AND principal_scope = ?
      AND cache_key NOT IN (
        SELECT cache_key
        FROM reports_snapshot_cache
        WHERE account_scope = ? AND principal_scope = ?
        ORDER BY last_accessed_at DESC, built_at DESC, cache_key DESC
        LIMIT ?
      )
  `, [
    accountScope,
    principalScope,
    accountScope,
    principalScope,
    SNAPSHOT_MAX_ENTRIES_PER_PRINCIPAL
  ])

  await db.run(`
    DELETE FROM reports_snapshot_cache
    WHERE account_scope = ?
      AND (principal_scope, cache_key) NOT IN (
        SELECT principal_scope, cache_key
        FROM reports_snapshot_cache
        WHERE account_scope = ?
        ORDER BY last_accessed_at DESC, built_at DESC, principal_scope DESC, cache_key DESC
        LIMIT ?
      )
  `, [
    accountScope,
    accountScope,
    SNAPSHOT_MAX_ENTRIES_PER_ACCOUNT
  ])
}

function waitForSnapshotFenceRetry(ms, signal) {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    let onAbort = null
    const timer = setTimeout(() => {
      if (onAbort) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    if (!signal) return
    onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(createDatabaseAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function persistSnapshotIfCurrent({
  accountScope,
  principalScope,
  cacheKey,
  sourceRevision,
  payload,
  signal
}) {
  const lockName = `reports-snapshot-commit:${sha256(`${accountScope}:${principalScope}:${cacheKey}`)}`

  for (let attempt = 0; attempt < 20; attempt += 1) {
    throwIfAborted(signal)
    try {
      const result = await db.withAdvisoryLock(lockName, async () => {
        // El fence se evalúa bajo un candado compartido por todas las instancias.
        // Así un build viejo jamás puede terminar después y pisar uno nuevo.
        const completedRevision = await getSnapshotSourceRevision(signal)
        if (completedRevision !== sourceRevision) {
          return { persisted: false, builtAt: '', completedRevision }
        }
        const builtAt = await persistSnapshot({
          accountScope,
          principalScope,
          cacheKey,
          sourceRevision,
          payload,
          signal
        })
        return { persisted: true, builtAt, completedRevision }
      })

      if (result.persisted) {
        void pruneSnapshotCache({ accountScope, principalScope }).catch(() => undefined)
      }
      return result
    } catch (error) {
      if (error?.code !== 'DATABASE_ADVISORY_LOCK_BUSY' || attempt === 19) throw error
      await waitForSnapshotFenceRetry(Math.min(10 + attempt * 5, 100), signal)
    }
  }

  throw new Error('No se pudo adquirir el fence de snapshot de Reportes')
}

function sumMetrics(metrics) {
  return metrics.reduce((totals, row) => ({
    revenue: totals.revenue + Number(row?.revenue || 0),
    sales: totals.sales + Number(row?.sales || 0),
    spend: totals.spend + Number(row?.spend || 0),
    clicks: totals.clicks + Number(row?.clicks || 0),
    reach: totals.reach + Number(row?.reach || 0)
  }), { revenue: 0, sales: 0, spend: 0, clicks: 0, reach: 0 })
}

function comparisonRange(range) {
  if (!range?.startZoned || !range?.endZoned || !range?.providedStart) return null
  const spanDays = Math.max(Math.round(range.endZoned.diff(range.startZoned, 'days').days) + 1, 1)
  const end = range.startZoned.minus({ days: 1 }).endOf('day')
  const start = end.minus({ days: spanDays - 1 }).startOf('day')
  return {
    startDate: start.toISODate(),
    endDate: end.toISODate()
  }
}

function publicRange(range) {
  return {
    start: range.startUtc,
    end: range.endUtc,
    timezone: range.appliedTimezone,
    filtered: range.isFiltered
  }
}

async function buildSnapshot(query, signal) {
  // La tabla principal es la unica lectura del periodo actual. Los KPIs se
  // derivan de sus buckets; solo el periodo anterior necesita dos agregados
  // adicionales (pagos + anuncios), nunca otro scan actual.
  throwIfAborted(signal)
  const current = await buildAggregatedReportMetrics({ ...query, signal })
  const currentTotals = sumMetrics(current.metrics)
  const previousInput = comparisonRange(current.range)
  const previousTotals = previousInput
    ? await buildReportComparisonTotals({ ...previousInput, scope: query.scope, signal })
    : { revenue: 0, sales: 0, spend: 0, clicks: 0, reach: 0 }
  throwIfAborted(signal)

  const currentAverage = currentTotals.sales > 0 ? currentTotals.revenue / currentTotals.sales : 0
  const previousAverage = previousTotals.sales > 0 ? previousTotals.revenue / previousTotals.sales : 0
  return {
    metrics: current.metrics,
    range: publicRange(current.range),
    summary: {
      payments: {
        totalRevenue: currentTotals.revenue,
        totalRevenuePrev: previousTotals.revenue,
        completedPayments: currentTotals.sales,
        completedPaymentsPrev: previousTotals.sales,
        averageTicket: currentAverage,
        averageTicketPrev: previousAverage
      },
      campaigns: {
        spend: currentTotals.spend,
        spendPrev: previousTotals.spend,
        clicks: currentTotals.clicks,
        clicksPrev: previousTotals.clicks,
        reach: currentTotals.reach,
        reachPrev: previousTotals.reach,
        roas: currentTotals.spend > 0 ? currentTotals.revenue / currentTotals.spend : 0,
        roasPrev: previousTotals.spend > 0 ? previousTotals.revenue / previousTotals.spend : 0
      }
    }
  }
}

function withCacheMetadata(payload, {
  stale,
  builtAt,
  builtSourceRevision,
  currentSourceRevision
}) {
  return {
    ...payload,
    cache: {
      stale: Boolean(stale),
      exactAtBuiltAt: true,
      builtAt: String(builtAt || ''),
      builtSourceRevision: String(builtSourceRevision || ''),
      currentSourceRevision: String(currentSourceRevision || '')
    }
  }
}

function getOrStartSharedBuild({
  buildKey,
  query,
  accountScope,
  principalScope,
  cacheKey,
  sourceRevision,
  keepAlive = false
}) {
  const active = builds.get(buildKey)
  if (active && !active.controller.signal.aborted) {
    if (keepAlive) active.keepAlive = true
    return active
  }

  const controller = new AbortController()
  const entry = {
    controller,
    keepAlive: Boolean(keepAlive),
    waiters: 0,
    settled: false,
    promise: null
  }

  entry.promise = (async () => {
    try {
      return await withBuildSlot(async () => {
        throwIfAborted(controller.signal)
        const payload = await buildSnapshot(query, controller.signal)
        throwIfAborted(controller.signal)
        const committed = await persistSnapshotIfCurrent({
          accountScope,
          principalScope,
          cacheKey,
          sourceRevision,
          payload,
          signal: controller.signal
        })
        return {
          payload,
          builtAt: committed.builtAt,
          builtSourceRevision: sourceRevision,
          completedRevision: committed.completedRevision,
          persisted: committed.persisted
        }
      })
    } finally {
      entry.settled = true
      if (builds.get(buildKey) === entry) builds.delete(buildKey)
    }
  })()
  builds.set(buildKey, entry)
  if (keepAlive) void entry.promise.catch(() => undefined)
  return entry
}

async function waitForSharedBuild(entry, signal) {
  if (signal?.aborted) {
    if (!entry.settled && entry.waiters === 0 && !entry.keepAlive) {
      entry.controller.abort()
    }
    throw createDatabaseAbortError()
  }
  entry.waiters += 1
  let onAbort
  const aborted = signal
    ? new Promise((_, reject) => {
        onAbort = () => reject(createDatabaseAbortError())
        signal.addEventListener('abort', onAbort, { once: true })
      })
    : null

  try {
    return aborted
      ? await Promise.race([entry.promise, aborted])
      : await entry.promise
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
    entry.waiters = Math.max(0, entry.waiters - 1)
    if (!entry.settled && entry.waiters === 0 && !entry.keepAlive) {
      entry.controller.abort()
    }
  }
}

/**
 * Read-model unificado de Reportes, persistente y stale-while-revalidate.
 * La revision durable cambia con contactos, telefonos canonicos, pagos, citas,
 * asistencia, anuncios, sesiones, configuracion, zona y filtros ocultos.
 */
export async function getReportsSnapshot({
  principal,
  startDate,
  endDate,
  groupBy,
  scope,
  waitForFresh = false,
  signal
} = {}) {
  throwIfAborted(signal)
  const query = normalizeQuery({ startDate, endDate, groupBy, scope })
  const principalScope = normalizePrincipalScope(principal)
  const cacheKey = buildSnapshotCacheKey(query)

  let accountScope
  let sourceRevision
  let cached
  try {
    ;[accountScope, sourceRevision] = await Promise.all([
      getCampaignPerformanceAccountScope({ signal }),
      getSnapshotSourceRevision(signal)
    ])
    throwIfAborted(signal)
    cached = await readSnapshot({
      accountScope,
      principalScope,
      cacheKey,
      sourceRevision,
      signal
    })
  } catch (error) {
    if (!isSnapshotSchemaUnavailable(error)) throw error
    const payload = await buildSnapshot(query, signal)
    return withCacheMetadata(payload, {
      stale: false,
      builtAt: '',
      builtSourceRevision: '',
      currentSourceRevision: ''
    })
  }

  if (cached?.exact) {
    throwIfAborted(signal)
    return withCacheMetadata(cached.payload, {
      stale: false,
      builtAt: cached.builtAt,
      builtSourceRevision: cached.builtSourceRevision,
      currentSourceRevision: sourceRevision
    })
  }

  // Una sola reconstruccion por principal+rango. La revision no forma parte de
  // esta llave para impedir que dos builds de revisiones consecutivas terminen
  // fuera de orden y el mas viejo sobrescriba al nuevo.
  const buildKey = `${accountScope}:${principalScope}:${cacheKey}`
  const build = getOrStartSharedBuild({
    buildKey,
    query,
    accountScope,
    principalScope,
    cacheKey,
    sourceRevision,
    keepAlive: Boolean(cached && !waitForFresh)
  })

  if (cached && !waitForFresh) {
    build.keepAlive = true
    void build.promise.catch(() => undefined)
    throwIfAborted(signal)
    return withCacheMetadata(cached.payload, {
      stale: true,
      builtAt: cached.builtAt,
      builtSourceRevision: cached.builtSourceRevision,
      currentSourceRevision: sourceRevision
    })
  }

  const built = await waitForSharedBuild(build, signal)
  throwIfAborted(signal)
  return withCacheMetadata(built.payload, {
    stale: built.completedRevision !== built.builtSourceRevision,
    builtAt: built.builtAt,
    builtSourceRevision: built.builtSourceRevision,
    currentSourceRevision: built.completedRevision
  })
}

export const REPORTS_SNAPSHOT_CACHE_LIMITS = Object.freeze({
  entriesPerPrincipal: SNAPSHOT_MAX_ENTRIES_PER_PRINCIPAL,
  entriesPerAccount: SNAPSHOT_MAX_ENTRIES_PER_ACCOUNT,
  maxConcurrentBuilds: SNAPSHOT_MAX_CONCURRENT_BUILDS,
  staleMaxAgeMs: SNAPSHOT_STALE_MAX_AGE_MS
})
