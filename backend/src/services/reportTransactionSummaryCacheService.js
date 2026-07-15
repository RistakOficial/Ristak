import { createHash } from 'node:crypto'

import { databaseDialect, db } from '../config/database.js'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_CACHE_ENTRIES_PER_ACCOUNT = 64
const MAX_ACTIVE_BUILDS = 2
const BUILD_DEADLINE_MS = 16_000
const builds = new Map()
let activeBuilds = 0

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function isAbortError(error, signal) {
  return Boolean(signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR')
}

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

function summaryUnavailable(code, message) {
  const error = new Error(message)
  error.status = 503
  error.code = code
  error.retryable = true
  error.retriable = true
  error.retryAfter = 1
  return error
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

async function getSourceRevision(signal) {
  if (databaseDialect === 'postgres') {
    const row = await db.get(
      'SELECT last_value, is_called FROM report_transaction_revision_seq',
      [],
      { signal }
    )
    return row?.is_called ? Number(row.last_value || 0) : 0
  }

  const row = await db.get(
    'SELECT revision FROM report_transaction_revision WHERE singleton = 1',
    [],
    { signal }
  )
  return Number(row?.revision || 0)
}

function normalizeSummary(row = {}) {
  return {
    count: Number(row.count_value ?? row.count ?? 0),
    totalAmount: Number(row.total_amount ?? row.totalAmount ?? 0)
  }
}

async function readSummary(accountScope, cacheKey, revision = null, signal) {
  const conditions = ['account_scope = ?', 'cache_key = ?']
  const params = [accountScope, cacheKey]
  if (revision !== null) {
    conditions.push('source_revision = ?')
    params.push(revision)
  }

  const row = await db.get(`
    SELECT source_revision, count_value, total_amount, built_at
    FROM report_transaction_summary_cache
    WHERE ${conditions.join(' AND ')}
    LIMIT 1
  `, params, { signal })
  if (!row || Date.now() - timestampMs(row.built_at) > CACHE_TTL_MS) return null

  void db.run(`
    UPDATE report_transaction_summary_cache
    SET last_accessed_at = CURRENT_TIMESTAMP
    WHERE account_scope = ? AND cache_key = ?
  `, [accountScope, cacheKey], { signal }).catch(() => undefined)

  return {
    ...normalizeSummary(row),
    sourceRevision: Number(row.source_revision || 0),
    builtAt: String(row.built_at || '')
  }
}

async function pruneCache(accountScope, signal) {
  await db.run(`
    DELETE FROM report_transaction_summary_cache
    WHERE account_scope = ?
      AND cache_key NOT IN (
        SELECT cache_key
        FROM report_transaction_summary_cache
        WHERE account_scope = ?
        ORDER BY last_accessed_at DESC, built_at DESC, cache_key DESC
        LIMIT ?
      )
  `, [accountScope, accountScope, MAX_CACHE_ENTRIES_PER_ACCOUNT], { signal })
}

async function persistSummary(accountScope, cacheKey, revision, summary, signal) {
  const normalized = normalizeSummary(summary)
  const now = new Date().toISOString()
  await db.run(`
    INSERT INTO report_transaction_summary_cache (
      account_scope, cache_key, source_revision, count_value, total_amount,
      built_at, last_accessed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_scope, cache_key) DO UPDATE SET
      source_revision = excluded.source_revision,
      count_value = excluded.count_value,
      total_amount = excluded.total_amount,
      built_at = excluded.built_at,
      last_accessed_at = excluded.last_accessed_at
    WHERE report_transaction_summary_cache.source_revision <= excluded.source_revision
  `, [
    accountScope,
    cacheKey,
    revision,
    normalized.count,
    normalized.totalAmount,
    now,
    now
  ], { signal })
  await pruneCache(accountScope, signal)
  return { ...normalized, builtAt: now }
}

function withCacheMetadata(summary, { stale, sourceRevision, builtAt }) {
  return {
    count: Number(summary.count || 0),
    totalAmount: Number(summary.totalAmount || 0),
    cache: {
      stale: Boolean(stale),
      exactAtBuiltAt: true,
      sourceRevision: Number(sourceRevision || 0),
      builtAt: String(builtAt || '')
    }
  }
}

function createBuildEntry(buildKey, build) {
  // `builds` puede soltar una llave en cuanto se va el último consumidor para
  // permitir un retry limpio, pero PostgreSQL todavía puede tardar un instante
  // en confirmar la cancelación. El contador conserva ese trabajo dentro del
  // límite hasta que la promesa real termina.
  if (activeBuilds >= MAX_ACTIVE_BUILDS) return null
  activeBuilds += 1

  const controller = new AbortController()
  const entry = {
    controller,
    keepAlive: false,
    waiters: 0,
    settled: false,
    timedOut: false,
    promise: null
  }
  const timer = setTimeout(() => {
    entry.timedOut = true
    controller.abort(summaryUnavailable(
      'report_transaction_summary_deadline',
      'El resumen de transacciones tardó demasiado y fue cancelado.'
    ))
  }, BUILD_DEADLINE_MS)
  timer.unref?.()

  // Registrar antes de invocar el builder cierra la carrera entre dos misses
  // fríos del mismo rango. Promise.resolve difiere la ejecución un microtask.
  entry.promise = Promise.resolve()
    .then(() => build(controller.signal))
    .then((value) => {
      throwIfAborted(controller.signal)
      return value
    })
    .catch((error) => {
      if (entry.timedOut) {
        throw summaryUnavailable(
          'report_transaction_summary_deadline',
          'El resumen de transacciones tardó demasiado y fue cancelado.'
        )
      }
      throw error
    })
    .finally(() => {
      entry.settled = true
      activeBuilds = Math.max(0, activeBuilds - 1)
      clearTimeout(timer)
      if (builds.get(buildKey) === entry) builds.delete(buildKey)
    })
  builds.set(buildKey, entry)
  // El handler existe incluso si el primer consumidor se cancela en el mismo
  // tick; cada caller sigue recibiendo el rechazo de la promesa original.
  void entry.promise.catch(() => undefined)
  return entry
}

function releaseBuildWaiter(buildKey, entry) {
  entry.waiters = Math.max(0, entry.waiters - 1)
  if (entry.waiters === 0 && !entry.keepAlive && !entry.settled) {
    entry.controller.abort(abortReason(entry.controller.signal))
    if (builds.get(buildKey) === entry) builds.delete(buildKey)
  }
}

function waitForBuild(buildKey, entry, signal) {
  throwIfAborted(signal)
  entry.waiters += 1

  if (!signal) {
    return entry.promise.finally(() => releaseBuildWaiter(buildKey, entry))
  }

  return new Promise((resolve, reject) => {
    let finished = false
    const finish = (callback) => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', onAbort)
      releaseBuildWaiter(buildKey, entry)
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

export function buildReportTransactionSummaryCacheKey({ startUtc, endUtc, hiddenFilters = [] } = {}) {
  return createHash('sha256')
    .update(JSON.stringify({
      version: 1,
      startUtc: String(startUtc || ''),
      endUtc: String(endUtc || ''),
      hiddenFilters: Array.isArray(hiddenFilters)
        ? hiddenFilters.map((filter) => ({
            text: String(filter?.text || ''),
            type: String(filter?.type || 'contains')
          }))
        : []
    }))
    .digest('hex')
}

/**
 * Summary durable con stale-while-revalidate y máximo global de dos builds.
 * Un consumidor puede cancelar su espera; el trabajo real sólo continúa si
 * existe otro waiter o si se trata de una revalidación stale controlada.
 */
export async function getReportTransactionSummary({ cacheKey, buildSummary, signal }) {
  if (!cacheKey || typeof buildSummary !== 'function') {
    throw new Error('Resumen de transacciones inválido')
  }
  throwIfAborted(signal)

  const accountScope = await getAccountScope(signal)
  const revision = await getSourceRevision(signal)
  const exact = await readSummary(accountScope, cacheKey, revision, signal)
  if (exact) {
    return withCacheMetadata(exact, {
      stale: false,
      sourceRevision: revision,
      builtAt: exact.builtAt
    })
  }

  const stale = await readSummary(accountScope, cacheKey, null, signal)
  const buildKey = `${accountScope}:${cacheKey}:${revision}`
  let entry = builds.get(buildKey)
  if (!entry) {
    entry = createBuildEntry(buildKey, async (buildSignal) => {
      const summary = await buildSummary(buildSignal)
      throwIfAborted(buildSignal)
      const persisted = await persistSummary(accountScope, cacheKey, revision, summary, buildSignal)
      throwIfAborted(buildSignal)
      const currentRevision = await getSourceRevision(buildSignal)
      return { ...persisted, exact: currentRevision === revision }
    })
  }

  if (stale) {
    if (entry) {
      entry.keepAlive = true
      void entry.promise.catch(() => undefined)
    }
    return withCacheMetadata(stale, {
      stale: true,
      sourceRevision: stale.sourceRevision,
      builtAt: stale.builtAt
    })
  }

  if (!entry) {
    throw summaryUnavailable(
      'report_transaction_summary_busy',
      'Hay demasiados resúmenes de transacciones en proceso. Intenta nuevamente.'
    )
  }
  const built = await waitForBuild(buildKey, entry, signal)
  return withCacheMetadata(built, {
    stale: !built.exact,
    sourceRevision: revision,
    builtAt: built.builtAt
  })
}

export const REPORT_TRANSACTION_SUMMARY_CACHE_LIMITS = Object.freeze({
  activeBuilds: MAX_ACTIVE_BUILDS,
  buildDeadlineMs: BUILD_DEADLINE_MS,
  entriesPerAccount: MAX_CACHE_ENTRIES_PER_ACCOUNT,
  ttlMs: CACHE_TTL_MS
})
