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

const SNAPSHOT_REFRESH_INTERVAL_MS = 30_000
const SNAPSHOT_ACCESS_TOUCH_INTERVAL_MS = 30_000
const SNAPSHOT_STALE_MAX_AGE_MS = 5 * 60_000
const SNAPSHOT_MAX_ENTRIES_PER_SHARED_SCOPE = 48
const SNAPSHOT_MAX_ENTRIES_PER_ACCOUNT = 192
const SNAPSHOT_MAX_CONCURRENT_BUILDS = 2
const SNAPSHOT_MAX_QUEUED_BUILDS = 8
const SNAPSHOT_BUILD_DEADLINE_MS = 18_000
const VALID_GROUPS = new Set(['day', 'month', 'year'])
const VALID_SCOPES = new Set(['all', 'attribution', 'campaigns'])
// El endpoint ya pasó requireAuth + requireModuleAccess('reports') y el
// agregado sólo consume configuración y datos de cuenta. No contiene filtros,
// campos ni preferencias del usuario autenticado, así que el read-model es
// compartido por todos los principals autorizados de la misma cuenta.
const REPORTS_SHARED_PRINCIPAL_SCOPE = 'authorized-reports-read-v1'
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

function reportsSnapshotDeadlineError() {
  const error = new Error('El snapshot de Reportes tardó demasiado y fue cancelado. Intenta nuevamente.')
  error.status = 503
  error.code = 'reports_snapshot_deadline'
  error.retryable = true
  return error
}

function reportsSnapshotBusyError() {
  const error = new Error('Reportes ya está procesando otras consultas. Intenta nuevamente en unos segundos.')
  error.status = 503
  error.code = 'reports_snapshot_busy'
  error.retryable = true
  return error
}

async function withBuildSlot(callback, signal) {
  throwIfAborted(signal)
  if (activeBuilds >= SNAPSHOT_MAX_CONCURRENT_BUILDS) {
    if (buildWaiters.length >= SNAPSHOT_MAX_QUEUED_BUILDS) throw reportsSnapshotBusyError()
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null }
      waiter.onAbort = () => {
        const index = buildWaiters.indexOf(waiter)
        if (index >= 0) buildWaiters.splice(index, 1)
        reject(createDatabaseAbortError())
      }
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      buildWaiters.push(waiter)
      if (signal?.aborted) waiter.onAbort()
    })
  } else {
    activeBuilds += 1
  }
  try {
    throwIfAborted(signal)
    return await callback()
  } finally {
    let next = null
    while ((next = buildWaiters.shift() || null)) {
      next.signal?.removeEventListener('abort', next.onAbort)
      if (next.signal?.aborted) {
        next.reject(createDatabaseAbortError())
        continue
      }
      next.resolve()
      break
    }
    if (!next) activeBuilds -= 1
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

function normalizePrincipalScope() {
  return REPORTS_SHARED_PRINCIPAL_SCOPE
}

function encodeMovingRevision(sourceRevision, completedRevision) {
  return `moving:${JSON.stringify({ sourceRevision, completedRevision })}`
}

function decodeStoredRevision(storedRevision) {
  const normalized = String(storedRevision || '')
  if (!normalized.startsWith('moving:')) {
    return {
      exactAtBuiltAt: true,
      builtSourceRevision: normalized,
      completedRevision: normalized
    }
  }
  try {
    const parsed = JSON.parse(normalized.slice('moving:'.length))
    return {
      exactAtBuiltAt: false,
      builtSourceRevision: String(parsed?.sourceRevision || ''),
      completedRevision: String(parsed?.completedRevision || '')
    }
  } catch {
    return {
      exactAtBuiltAt: false,
      builtSourceRevision: '',
      completedRevision: ''
    }
  }
}

async function getSnapshotSourceRevision(signal) {
  throwIfAborted(signal)
  if (databaseDialect === 'postgres') {
    const row = await db.get(`
      SELECT
        COALESCE((
          SELECT CASE WHEN is_called THEN last_value ELSE 0 END
          FROM reports_snapshot_revision_seq
        ), 0) AS reports_revision,
        COALESCE((
          SELECT core_revision
          FROM campaign_performance_revision
          WHERE id = 1
        ), 0) AS campaign_core_revision,
        COALESCE((
          SELECT CASE WHEN is_called THEN last_value ELSE 0 END
          FROM campaign_performance_visitor_revision_seq
        ), 0) AS visitor_revision
    `, [], signalOptions(signal))
    return [
      `reports:${Number(row?.reports_revision || 0)}`,
      `core:${Number(row?.campaign_core_revision || 0)}`,
      `visitor:${Number(row?.visitor_revision || 0)}`
    ].join('|')
  }

  const visitorRevisionPromise = getCampaignPerformanceSourceRevision({ includeVisitors: true, signal })
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

function decodeSnapshotRow({ row, accountScope, principalScope, cacheKey, sourceRevision }) {
  if (!row) return null
  const storedRevision = decodeStoredRevision(row.source_revision)
  const exact = storedRevision.exactAtBuiltAt && storedRevision.builtSourceRevision === sourceRevision
  const ageMs = Math.max(0, Date.now() - timestampMs(row.built_at))
  if (!exact && ageMs > SNAPSHOT_STALE_MAX_AGE_MS) return null
  let payload
  try {
    payload = JSON.parse(row.payload_json)
  } catch {
    return null
  }

  const lastAccessedMs = timestampMs(row.last_accessed_at)
  if (lastAccessedMs === 0 || Date.now() - lastAccessedMs >= SNAPSHOT_ACCESS_TOUCH_INTERVAL_MS) {
    // El LRU no necesita una escritura por cada cache hit. Acotar el touch evita
    // WAL y locks repetidos sobre la misma fila durante ráfagas de navegación.
    void db.run(`
      UPDATE reports_snapshot_cache
      SET last_accessed_at = CURRENT_TIMESTAMP
      WHERE account_scope = ? AND principal_scope = ? AND cache_key = ?
    `, [accountScope, principalScope, cacheKey]).catch(() => undefined)
  }

  return {
    payload,
    builtAt: String(row.built_at || ''),
    builtSourceRevision: storedRevision.builtSourceRevision,
    completedRevision: storedRevision.completedRevision,
    exactAtBuiltAt: storedRevision.exactAtBuiltAt,
    exact,
    ageMs,
    refreshDue: storedRevision.exactAtBuiltAt
      ? !exact
      : ageMs >= SNAPSHOT_REFRESH_INTERVAL_MS
  }
}

async function readPostgresSnapshotContext({ principalScope, cacheKey, signal }) {
  // PostgreSQL evalúa las cuatro fuentes dentro de un solo statement. Además
  // de ahorrar adquisiciones del pool, esto cierra las ventanas entre
  // roundtrips; el fence posterior al build sigue siendo quien certifica que
  // una reconstrucción no cruzó escrituras concurrentes.
  const row = await db.get(`
    WITH account_context AS MATERIALIZED (
      SELECT
        'account:' || COALESCE(
          NULLIF(LEFT(BTRIM(COALESCE((
            SELECT location_id::text
            FROM highlevel_config
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          ), '')), 240), ''),
          'local-database'
        ) AS account_scope
    ), revision_context AS MATERIALIZED (
      SELECT
        COALESCE((
          SELECT CASE WHEN is_called THEN last_value ELSE 0 END
          FROM reports_snapshot_revision_seq
        ), 0) AS reports_revision,
        COALESCE((
          SELECT core_revision
          FROM campaign_performance_revision
          WHERE id = 1
        ), 0) AS campaign_core_revision,
        COALESCE((
          SELECT CASE WHEN is_called THEN last_value ELSE 0 END
          FROM campaign_performance_visitor_revision_seq
        ), 0) AS visitor_revision
    )
    SELECT
      account_context.account_scope,
      revision_context.reports_revision,
      revision_context.campaign_core_revision,
      revision_context.visitor_revision,
      snapshot.source_revision,
      snapshot.payload_json,
      snapshot.built_at,
      snapshot.last_accessed_at
    FROM account_context
    CROSS JOIN revision_context
    LEFT JOIN LATERAL (
      SELECT source_revision, payload_json, built_at, last_accessed_at
      FROM reports_snapshot_cache
      WHERE account_scope = account_context.account_scope
        AND principal_scope = ?
        AND cache_key = ?
      LIMIT 1
    ) snapshot ON TRUE
  `, [principalScope, cacheKey], signalOptions(signal))

  const accountScope = String(row?.account_scope || 'account:local-database')
  const sourceRevision = [
    `reports:${Number(row?.reports_revision || 0)}`,
    `core:${Number(row?.campaign_core_revision || 0)}`,
    `visitor:${Number(row?.visitor_revision || 0)}`
  ].join('|')
  const cached = decodeSnapshotRow({
    row: row?.source_revision === null || row?.source_revision === undefined ? null : row,
    accountScope,
    principalScope,
    cacheKey,
    sourceRevision
  })
  return { accountScope, sourceRevision, cached }
}

async function readSnapshot({ accountScope, principalScope, cacheKey, sourceRevision, signal }) {
  const row = await db.get(`
    SELECT source_revision, payload_json, built_at, last_accessed_at
    FROM reports_snapshot_cache
    WHERE account_scope = ?
      AND principal_scope = ?
      AND cache_key = ?
    LIMIT 1
  `, [accountScope, principalScope, cacheKey], signalOptions(signal))

  return decodeSnapshotRow({ row, accountScope, principalScope, cacheKey, sourceRevision })
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
    SNAPSHOT_MAX_ENTRIES_PER_SHARED_SCOPE
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

async function persistCompletedSnapshot({
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
        // La clasificación exact/moving y la escritura ocurren bajo el mismo
        // candado para que ninguna instancia publique exactitud con una
        // revisión leída antes de adquirirlo.
        const completedRevision = await getSnapshotSourceRevision(signal)
        const exactAtBuiltAt = completedRevision === sourceRevision
        const storedRevision = exactAtBuiltAt
          ? sourceRevision
          : encodeMovingRevision(sourceRevision, completedRevision)
        const builtAt = await persistSnapshot({
          accountScope,
          principalScope,
          cacheKey,
          sourceRevision: storedRevision,
          payload,
          signal
        })
        return { persisted: true, builtAt, completedRevision, exactAtBuiltAt }
      }, { signal })

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
  exactAtBuiltAt,
  builtAt,
  builtSourceRevision,
  currentSourceRevision
}) {
  const builtAtMs = timestampMs(builtAt)
  const ageMs = builtAtMs > 0 ? Math.max(0, Date.now() - builtAtMs) : 0
  const revalidateAfter = builtAtMs > 0
    ? new Date(exactAtBuiltAt && stale
        ? Math.min(builtAtMs, Date.now())
        : builtAtMs + SNAPSHOT_REFRESH_INTERVAL_MS).toISOString()
    : ''
  return {
    ...payload,
    cache: {
      stale: Boolean(stale),
      consistency: exactAtBuiltAt ? 'exact' : 'moving-window',
      exactAtBuiltAt: Boolean(exactAtBuiltAt),
      builtAt: String(builtAt || ''),
      builtSourceRevision: String(builtSourceRevision || ''),
      currentSourceRevision: String(currentSourceRevision || ''),
      ageMs,
      revalidateAfter,
      maxStaleAgeMs: SNAPSHOT_STALE_MAX_AGE_MS
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
    timedOut: false,
    promise: null
  }
  const deadlineTimer = setTimeout(() => {
    entry.timedOut = true
    controller.abort(reportsSnapshotDeadlineError())
  }, SNAPSHOT_BUILD_DEADLINE_MS)
  deadlineTimer.unref?.()

  entry.promise = (async () => {
    try {
      return await withBuildSlot(async () => {
        throwIfAborted(controller.signal)
        const payload = await buildSnapshot(query, controller.signal)
        throwIfAborted(controller.signal)
        const committed = await persistCompletedSnapshot({
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
          persisted: committed.persisted,
          exactAtBuiltAt: committed.exactAtBuiltAt
        }
      }, controller.signal)
    } catch (error) {
      if (entry.timedOut) throw reportsSnapshotDeadlineError()
      throw error
    } finally {
      clearTimeout(deadlineTimer)
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
        if (signal.aborted) onAbort()
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
  startDate,
  endDate,
  groupBy,
  scope,
  waitForFresh = false,
  signal
} = {}) {
  throwIfAborted(signal)
  const query = normalizeQuery({ startDate, endDate, groupBy, scope })
  const principalScope = normalizePrincipalScope()
  const cacheKey = buildSnapshotCacheKey(query)

  let accountScope
  let sourceRevision
  let cached
  try {
    if (databaseDialect === 'postgres') {
      ;({ accountScope, sourceRevision, cached } = await readPostgresSnapshotContext({
        principalScope,
        cacheKey,
        signal
      }))
    } else {
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
    }
    throwIfAborted(signal)
  } catch (error) {
    if (!isSnapshotSchemaUnavailable(error)) throw error
    const payload = await buildSnapshot(query, signal)
    return withCacheMetadata(payload, {
      stale: false,
      exactAtBuiltAt: true,
      builtAt: '',
      builtSourceRevision: '',
      currentSourceRevision: ''
    })
  }

  if (cached?.exact) {
    throwIfAborted(signal)
    return withCacheMetadata(cached.payload, {
      stale: false,
      exactAtBuiltAt: cached.exactAtBuiltAt,
      builtAt: cached.builtAt,
      builtSourceRevision: cached.builtSourceRevision,
      currentSourceRevision: sourceRevision
    })
  }

  // Una sola reconstruccion por cuenta+rango para todos los principals que ya
  // pasaron el permiso de Reportes. La revision no forma parte de
  // esta llave para impedir que dos builds de revisiones consecutivas terminen
  // fuera de orden y el mas viejo sobrescriba al nuevo.
  const buildKey = `${accountScope}:${principalScope}:${cacheKey}`
  const activeForKey = builds.get(buildKey)
  if (
    cached &&
    !waitForFresh &&
    cached.refreshDue &&
    (!activeForKey || activeForKey.controller.signal.aborted) &&
    (activeBuilds >= SNAPSHOT_MAX_CONCURRENT_BUILDS || buildWaiters.length > 0)
  ) {
    // Una revalidación SWR jamás debe formarse detrás de trabajo frío. Se pinta
    // el snapshot conocido y la siguiente lectura volverá a intentar cuando
    // haya capacidad, sin acumular rangos huérfanos en memoria.
    return withCacheMetadata(cached.payload, {
      stale: true,
      exactAtBuiltAt: cached.exactAtBuiltAt,
      builtAt: cached.builtAt,
      builtSourceRevision: cached.builtSourceRevision,
      currentSourceRevision: sourceRevision
    })
  }

  // Un build que cruzó escrituras queda marcado moving-window y se persiste,
  // pero no se vuelve a reconstruir en cada waitForFresh. El siguiente intento
  // se habilita tras la ventana de coalescing o antes si había un snapshot
  // exacto cuya revisión ya cambió.
  if (cached && !cached.refreshDue) {
    return withCacheMetadata(cached.payload, {
      stale: true,
      exactAtBuiltAt: cached.exactAtBuiltAt,
      builtAt: cached.builtAt,
      builtSourceRevision: cached.builtSourceRevision,
      currentSourceRevision: sourceRevision
    })
  }
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
      exactAtBuiltAt: cached.exactAtBuiltAt,
      builtAt: cached.builtAt,
      builtSourceRevision: cached.builtSourceRevision,
      currentSourceRevision: sourceRevision
    })
  }

  const built = await waitForSharedBuild(build, signal)
  throwIfAborted(signal)
  return withCacheMetadata(built.payload, {
    stale: !built.exactAtBuiltAt,
    exactAtBuiltAt: built.exactAtBuiltAt,
    builtAt: built.builtAt,
    builtSourceRevision: built.builtSourceRevision,
    currentSourceRevision: built.completedRevision
  })
}

export const REPORTS_SNAPSHOT_CACHE_LIMITS = Object.freeze({
  entriesPerSharedScope: SNAPSHOT_MAX_ENTRIES_PER_SHARED_SCOPE,
  entriesPerAccount: SNAPSHOT_MAX_ENTRIES_PER_ACCOUNT,
  maxConcurrentBuilds: SNAPSHOT_MAX_CONCURRENT_BUILDS,
  maxQueuedBuilds: SNAPSHOT_MAX_QUEUED_BUILDS,
  buildDeadlineMs: SNAPSHOT_BUILD_DEADLINE_MS,
  refreshIntervalMs: SNAPSHOT_REFRESH_INTERVAL_MS,
  staleMaxAgeMs: SNAPSHOT_STALE_MAX_AGE_MS
})
