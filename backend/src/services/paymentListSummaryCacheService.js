import { db } from '../config/database.js'

const PAYMENT_SUMMARY_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const PAYMENT_SUMMARY_BACKGROUND_BUILD_LIMIT = 2
const VALID_SCOPES = new Set(['subscriptions', 'payment_plans'])
const summaryBuilds = new Map()

function normalizeScope(scope) {
  const normalized = String(scope || '').trim()
  if (!VALID_SCOPES.has(normalized)) throw new Error(`Scope de resumen inválido: ${normalized}`)
  return normalized
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

async function getAccountScope() {
  const row = await db.get('SELECT location_id FROM highlevel_config ORDER BY created_at DESC, id DESC LIMIT 1')
    .catch(() => null)
  return `account:${String(row?.location_id || '').trim() || 'local-database'}`
}

export async function getPaymentListRevision(scope) {
  const normalized = normalizeScope(scope)
  const row = await db.get('SELECT revision FROM payment_list_revisions WHERE scope = ?', [normalized])
  return Number(row?.revision || 0)
}

async function readCachedSummary(accountScope, scope, revision) {
  const row = await db.get(`
    SELECT payload_json, built_at
    FROM payment_list_summary_cache
    WHERE account_scope = ? AND scope = ? AND source_revision = ?
    LIMIT 1
  `, [accountScope, scope, revision])
  if (!row || Date.now() - timestampMs(row.built_at) > PAYMENT_SUMMARY_CACHE_TTL_MS) return null

  void db.run(`
    UPDATE payment_list_summary_cache
    SET last_accessed_at = CURRENT_TIMESTAMP
    WHERE account_scope = ? AND scope = ? AND source_revision = ?
  `, [accountScope, scope, revision]).catch(() => undefined)
  return {
    value: JSON.parse(row.payload_json),
    builtAt: String(row.built_at || '')
  }
}

async function readLatestSummary(accountScope, scope) {
  const row = await db.get(`
    SELECT source_revision, payload_json, built_at
    FROM payment_list_summary_cache
    WHERE account_scope = ? AND scope = ?
    LIMIT 1
  `, [accountScope, scope])
  if (!row || Date.now() - timestampMs(row.built_at) > PAYMENT_SUMMARY_CACHE_TTL_MS) return null
  return {
    value: JSON.parse(row.payload_json),
    builtAt: String(row.built_at || ''),
    sourceRevision: Number(row.source_revision || 0)
  }
}

async function persistSummary(accountScope, scope, revision, summary) {
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
  `, [accountScope, scope, revision, JSON.stringify(summary), now, now])
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

export async function getCachedPaymentListSummary(scope, buildSummary) {
  const normalized = normalizeScope(scope)
  const accountScope = await getAccountScope()
  const revision = await getPaymentListRevision(normalized)
  const cached = await readCachedSummary(accountScope, normalized, revision)
  if (cached) {
    return withCacheMetadata(cached.value, {
      stale: false,
      builtAt: cached.builtAt,
      sourceRevision: revision
    })
  }

  const stale = await readLatestSummary(accountScope, normalized)
  const buildKey = `${accountScope}:${normalized}:${revision}`
  let build = summaryBuilds.get(buildKey)
  if (!build && (!stale || summaryBuilds.size < PAYMENT_SUMMARY_BACKGROUND_BUILD_LIMIT)) {
    build = (async () => {
      const summary = await buildSummary()
      const builtAt = await persistSummary(accountScope, normalized, revision, summary)
      const currentRevision = await getPaymentListRevision(normalized)
      return { summary, builtAt, exact: currentRevision === revision }
    })().finally(() => {
      summaryBuilds.delete(buildKey)
    })
    summaryBuilds.set(buildKey, build)
  }

  if (stale) {
    if (build) void build.catch(() => undefined)
    return withCacheMetadata(stale.value, {
      stale: true,
      builtAt: stale.builtAt,
      sourceRevision: stale.sourceRevision
    })
  }

  if (!build) throw new Error('No se pudo iniciar el resumen de pagos')
  const built = await build
  return withCacheMetadata(built.summary, {
    stale: !built.exact,
    builtAt: built.builtAt,
    sourceRevision: revision
  })
}

export const PAYMENT_LIST_SUMMARY_CACHE_LIMITS = Object.freeze({
  scopesPerAccount: VALID_SCOPES.size,
  ttlMs: PAYMENT_SUMMARY_CACHE_TTL_MS
})
