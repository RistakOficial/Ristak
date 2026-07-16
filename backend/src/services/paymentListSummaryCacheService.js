import { db } from '../config/database.js'

const PAYMENT_SUMMARY_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const PAYMENT_SUMMARY_MAX_CONCURRENT_BUILDS = 2
const PAYMENT_SUMMARY_BACKGROUND_BUILD_LIMIT = 1
const PAYMENT_SUMMARY_BUILD_DEADLINE_MS = 16_000
const PAYMENT_SUMMARY_CACHE_ENTRIES_PER_ACCOUNT = 96
const VALID_SCOPES = new Set(['subscriptions', 'payment_plans', 'transactions'])
const summaryBuilds = new Map()
let activeSummaryBuilds = 0
let activeBackgroundSummaryBuilds = 0

function abortReason(signal) {
  if (signal?.reason !== undefined) return signal.reason
  const error = new Error('La consulta fue cancelada')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal)
}

function isAbortError(error, signal) {
  return Boolean(signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR')
}

function summaryUnavailable(code, message) {
  const error = new Error(message)
  error.status = 503
  error.code = code
  error.retryable = true
  error.retriable = true
  error.retryAfter = 1
  return error
}

function createSummaryBuild(key, run, { background = false } = {}) {
  if (
    activeSummaryBuilds >= PAYMENT_SUMMARY_MAX_CONCURRENT_BUILDS ||
    (background && (
      activeBackgroundSummaryBuilds >= PAYMENT_SUMMARY_BACKGROUND_BUILD_LIMIT ||
      activeSummaryBuilds >= PAYMENT_SUMMARY_MAX_CONCURRENT_BUILDS - 1
    ))
  ) return null

  activeSummaryBuilds += 1
  if (background) activeBackgroundSummaryBuilds += 1

  const controller = new AbortController()
  const entry = {
    controller,
    keepAlive: false,
    background,
    waiters: 0,
    settled: false,
    timedOut: false,
    promise: null
  }
  const timer = setTimeout(() => {
    entry.timedOut = true
    controller.abort(summaryUnavailable(
      'payment_summary_deadline',
      'El resumen de pagos tardó demasiado y fue cancelado.'
    ))
  }, PAYMENT_SUMMARY_BUILD_DEADLINE_MS)
  timer.unref?.()

  entry.promise = Promise.resolve()
    .then(() => run(controller.signal))
    .then((value) => {
      throwIfAborted(controller.signal)
      return value
    })
    .catch((error) => {
      if (entry.timedOut) {
        throw summaryUnavailable(
          'payment_summary_deadline',
          'El resumen de pagos tardó demasiado y fue cancelado.'
        )
      }
      throw error
    })
    .finally(() => {
      entry.settled = true
      activeSummaryBuilds = Math.max(0, activeSummaryBuilds - 1)
      if (entry.background) {
        activeBackgroundSummaryBuilds = Math.max(0, activeBackgroundSummaryBuilds - 1)
      }
      clearTimeout(timer)
      if (summaryBuilds.get(key) === entry) summaryBuilds.delete(key)
    })

  summaryBuilds.set(key, entry)
  void entry.promise.catch(() => undefined)
  return entry
}

function releaseSummaryWaiter(key, entry) {
  entry.waiters = Math.max(0, entry.waiters - 1)
  if (entry.waiters === 0 && !entry.keepAlive && !entry.settled) {
    entry.controller.abort(abortReason(entry.controller.signal))
    if (summaryBuilds.get(key) === entry) summaryBuilds.delete(key)
  }
}

function waitForSummaryBuild(key, entry, signal) {
  throwIfAborted(signal)
  entry.waiters += 1
  if (!signal) return entry.promise.finally(() => releaseSummaryWaiter(key, entry))

  return new Promise((resolve, reject) => {
    let finished = false
    const finish = (callback) => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', onAbort)
      releaseSummaryWaiter(key, entry)
      callback()
    }
    const onAbort = () => finish(() => reject(abortReason(signal)))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    entry.promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error))
    )
  })
}

function normalizeScope(scope) {
  const normalized = String(scope || '').trim()
  if (!VALID_SCOPES.has(normalized)) throw new Error(`Scope de resumen inválido: ${normalized}`)
  return normalized
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function isPaymentSummaryCacheSchemaUnavailable(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || '')
  return code === 'PAYMENT_SUMMARY_REVISION_UNAVAILABLE' || code === '42P01' || (
    code === 'SQLITE_ERROR' &&
    /no such table:\s*payment_list_(?:revisions|summary_cache)/i.test(message)
  )
}

async function getAccountScope(signal) {
  const row = await db.get(
    'SELECT location_id FROM highlevel_config ORDER BY created_at DESC, id DESC LIMIT 1',
    [],
    { signal }
  ).catch((error) => {
    if (isAbortError(error, signal)) throw error
    return null
  })
  return `account:${String(row?.location_id || '').trim() || 'local-database'}`
}

export async function getPaymentListRevision(scope, signal) {
  const normalized = normalizeScope(scope)
  const row = await db.get(
    'SELECT revision FROM payment_list_revisions WHERE scope = ?',
    [normalized],
    { signal }
  )
  if (!row) {
    throw Object.assign(
      new Error(`No existe la revisión materializada para ${normalized}`),
      { code: 'PAYMENT_SUMMARY_REVISION_UNAVAILABLE' }
    )
  }
  return Number(row?.revision || 0)
}

async function readCachedSummary(accountScope, scope, revision, signal) {
  const row = await db.get(`
    SELECT payload_json, built_at
    FROM payment_list_summary_cache
    WHERE account_scope = ? AND scope = ? AND source_revision = ?
    LIMIT 1
  `, [accountScope, scope, revision], { signal })
  if (!row || Date.now() - timestampMs(row.built_at) > PAYMENT_SUMMARY_CACHE_TTL_MS) return null
  return {
    value: JSON.parse(row.payload_json),
    builtAt: String(row.built_at || '')
  }
}

async function readLatestSummary(accountScope, scope, signal) {
  const row = await db.get(`
    SELECT source_revision, payload_json, built_at
    FROM payment_list_summary_cache
    WHERE account_scope = ? AND scope = ?
    ORDER BY source_revision DESC, built_at DESC
    LIMIT 1
  `, [accountScope, scope], { signal })
  if (!row || Date.now() - timestampMs(row.built_at) > PAYMENT_SUMMARY_CACHE_TTL_MS) return null
  return {
    value: JSON.parse(row.payload_json),
    builtAt: String(row.built_at || ''),
    sourceRevision: Number(row.source_revision || 0)
  }
}

async function persistSummary(accountScope, scope, revision, summary, signal) {
  const now = new Date().toISOString()
  await db.run(`
    INSERT INTO payment_list_summary_cache (
      account_scope, scope, source_revision, payload_json, built_at, last_accessed_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_scope, scope) DO UPDATE SET
      source_revision = excluded.source_revision,
      payload_json = excluded.payload_json,
      built_at = excluded.built_at,
      last_accessed_at = excluded.last_accessed_at
    WHERE payment_list_summary_cache.source_revision <= excluded.source_revision
  `, [accountScope, scope, revision, JSON.stringify(summary), now, now], { signal })
  await db.run(`
    DELETE FROM payment_list_summary_cache
    WHERE account_scope = ?
      AND scope NOT IN (
        SELECT scope
        FROM payment_list_summary_cache
        WHERE account_scope = ?
        ORDER BY last_accessed_at DESC, built_at DESC, scope DESC
        LIMIT ?
      )
  `, [accountScope, accountScope, PAYMENT_SUMMARY_CACHE_ENTRIES_PER_ACCOUNT], { signal })
  return now
}

function withCacheMetadata(value, { stale, builtAt, sourceRevision }) {
  return {
    ...value,
    cache: {
      stale: Boolean(stale),
      exactAtBuiltAt: true,
      builtAt,
      sourceRevision
    }
  }
}

async function getCachedPaymentValue({ revisionScope, cacheScope, buildValue, signal }) {
  const normalized = normalizeScope(revisionScope)
  const normalizedCacheScope = String(cacheScope || normalized).trim()
  if (!normalizedCacheScope || normalizedCacheScope.length > 240 || typeof buildValue !== 'function') {
    throw new Error('Consulta cacheada de pagos inválida')
  }
  throwIfAborted(signal)
  const accountScope = await getAccountScope(signal)
  let revision
  try {
    revision = await getPaymentListRevision(normalized, signal)
  } catch (error) {
    if (isAbortError(error, signal)) throw error
    if (!isPaymentSummaryCacheSchemaUnavailable(error)) throw error

    // Los consumidores unitarios importan controladores sin arrancar server.js,
    // por lo que no recorren la compuerta runVersionedMigrations() que instala
    // 071. También protege un bootstrap incompleto: sin tabla/fila de revisión
    // no existe invalidación confiable, así que jamás se guarda un snapshot.
    // Sólo se tolera esa ausencia conocida; cualquier otro error SQL se propaga.
    const summary = await buildValue(signal)
    throwIfAborted(signal)
    return withCacheMetadata(summary, {
      stale: false,
      builtAt: '',
      sourceRevision: 0
    })
  }
  const cached = await readCachedSummary(accountScope, normalizedCacheScope, revision, signal)
  if (cached) {
    return withCacheMetadata(cached.value, {
      stale: false,
      builtAt: cached.builtAt,
      sourceRevision: revision
    })
  }

  const stale = await readLatestSummary(accountScope, normalizedCacheScope, signal)
  const buildKey = `${accountScope}:${normalizedCacheScope}:${revision}`
  let entry = summaryBuilds.get(buildKey)
  if (!entry) {
    entry = createSummaryBuild(buildKey, async (buildSignal) => {
      const summary = await buildValue(buildSignal)
      throwIfAborted(buildSignal)
      const builtAt = await persistSummary(
        accountScope,
        normalizedCacheScope,
        revision,
        summary,
        buildSignal
      )
      throwIfAborted(buildSignal)
      const currentRevision = await getPaymentListRevision(normalized, buildSignal)
      return { summary, builtAt, exact: currentRevision === revision }
    }, { background: Boolean(stale) })
  }

  if (stale) {
    if (entry) {
      entry.keepAlive = true
      void entry.promise.catch(() => undefined)
    }
    return withCacheMetadata(stale.value, {
      stale: true,
      builtAt: stale.builtAt,
      sourceRevision: stale.sourceRevision
    })
  }

  if (!entry) {
    throw summaryUnavailable(
      'payment_summary_busy',
      'Hay demasiados resúmenes de pagos en proceso. Intenta nuevamente.'
    )
  }
  const built = await waitForSummaryBuild(buildKey, entry, signal)
  return withCacheMetadata(built.summary, {
    stale: !built.exact,
    builtAt: built.builtAt,
    sourceRevision: revision
  })
}

export async function getCachedPaymentListSummary(scope, buildSummary, { signal } = {}) {
  return getCachedPaymentValue({
    revisionScope: scope,
    cacheScope: normalizeScope(scope),
    buildValue: buildSummary,
    signal
  })
}

/** Cache SWR por hash de consulta, invalidado por la revisión durable de pagos. */
export async function getCachedTransactionQuery(cacheKey, buildValue, { signal } = {}) {
  const normalizedKey = String(cacheKey || '').trim()
  if (!/^[a-z0-9:_-]{1,200}$/i.test(normalizedKey)) {
    throw new Error('Llave de consulta de transacciones inválida')
  }
  return getCachedPaymentValue({
    revisionScope: 'transactions',
    cacheScope: `transactions:${normalizedKey}`,
    buildValue,
    signal
  })
}

export const PAYMENT_LIST_SUMMARY_CACHE_LIMITS = Object.freeze({
  scopesPerAccount: VALID_SCOPES.size,
  entriesPerAccount: PAYMENT_SUMMARY_CACHE_ENTRIES_PER_ACCOUNT,
  ttlMs: PAYMENT_SUMMARY_CACHE_TTL_MS,
  maxConcurrentBuilds: PAYMENT_SUMMARY_MAX_CONCURRENT_BUILDS,
  maxBackgroundBuilds: PAYMENT_SUMMARY_BACKGROUND_BUILD_LIMIT,
  buildDeadlineMs: PAYMENT_SUMMARY_BUILD_DEADLINE_MS,
  queuedBuilds: 0
})
