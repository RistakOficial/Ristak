import { createHash } from 'node:crypto'

import { databaseDialect, db } from '../config/database.js'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_CACHE_ENTRIES_PER_ACCOUNT = 64
const MAX_BACKGROUND_BUILDS = 2
const builds = new Map()

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

async function getAccountScope() {
  const row = await db.get('SELECT location_id FROM highlevel_config ORDER BY created_at DESC, id DESC LIMIT 1')
    .catch(() => null)
  return `account:${String(row?.location_id || '').trim() || 'local-database'}`
}

async function getSourceRevision() {
  if (databaseDialect === 'postgres') {
    const row = await db.get('SELECT last_value, is_called FROM report_transaction_revision_seq')
    return row?.is_called ? Number(row.last_value || 0) : 0
  }

  const row = await db.get('SELECT revision FROM report_transaction_revision WHERE singleton = 1')
  return Number(row?.revision || 0)
}

function normalizeSummary(row = {}) {
  return {
    count: Number(row.count_value ?? row.count ?? 0),
    totalAmount: Number(row.total_amount ?? row.totalAmount ?? 0)
  }
}

async function readSummary(accountScope, cacheKey, revision = null) {
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
  `, params)
  if (!row || Date.now() - timestampMs(row.built_at) > CACHE_TTL_MS) return null

  void db.run(`
    UPDATE report_transaction_summary_cache
    SET last_accessed_at = CURRENT_TIMESTAMP
    WHERE account_scope = ? AND cache_key = ?
  `, [accountScope, cacheKey]).catch(() => undefined)

  return {
    ...normalizeSummary(row),
    sourceRevision: Number(row.source_revision || 0),
    builtAt: String(row.built_at || '')
  }
}

async function pruneCache(accountScope) {
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
  `, [accountScope, accountScope, MAX_CACHE_ENTRIES_PER_ACCOUNT])
}

async function persistSummary(accountScope, cacheKey, revision, summary) {
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
  ])
  void pruneCache(accountScope).catch(() => undefined)
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
 * Summary durable con stale-while-revalidate. Una página posterior sólo hace
 * dos lookups por PK; el COUNT/SUM grande se reconstruye una vez por revisión.
 */
export async function getReportTransactionSummary({ cacheKey, buildSummary }) {
  if (!cacheKey || typeof buildSummary !== 'function') {
    throw new Error('Resumen de transacciones inválido')
  }

  const [accountScope, revision] = await Promise.all([getAccountScope(), getSourceRevision()])
  const exact = await readSummary(accountScope, cacheKey, revision)
  if (exact) {
    return withCacheMetadata(exact, {
      stale: false,
      sourceRevision: revision,
      builtAt: exact.builtAt
    })
  }

  const stale = await readSummary(accountScope, cacheKey)
  const buildKey = `${accountScope}:${cacheKey}:${revision}`
  let build = builds.get(buildKey)
  if (!build && (!stale || builds.size < MAX_BACKGROUND_BUILDS)) {
    build = (async () => {
      const summary = await buildSummary()
      const persisted = await persistSummary(accountScope, cacheKey, revision, summary)
      const currentRevision = await getSourceRevision()
      return { ...persisted, exact: currentRevision === revision }
    })().finally(() => builds.delete(buildKey))
    builds.set(buildKey, build)
  }

  if (stale) {
    if (build) void build.catch(() => undefined)
    return withCacheMetadata(stale, {
      stale: true,
      sourceRevision: stale.sourceRevision,
      builtAt: stale.builtAt
    })
  }

  if (!build) throw new Error('No se pudo iniciar el resumen de transacciones')
  const built = await build
  return withCacheMetadata(built, {
    stale: !built.exact,
    sourceRevision: revision,
    builtAt: built.builtAt
  })
}

export const REPORT_TRANSACTION_SUMMARY_CACHE_LIMITS = Object.freeze({
  entriesPerAccount: MAX_CACHE_ENTRIES_PER_ACCOUNT,
  ttlMs: CACHE_TTL_MS
})
