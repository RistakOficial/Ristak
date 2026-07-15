import { db } from '../config/database.js'

const PAYMENT_SUMMARY_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const PAYMENT_SUMMARY_BACKGROUND_BUILD_LIMIT = 2
const PAYMENT_SUMMARY_CACHE_ENTRIES_PER_ACCOUNT = 96
const VALID_SCOPES = new Set(['subscriptions', 'payment_plans', 'transactions'])
const summaryBuilds = new Map()
const summaryBuildQueue = []
let activeSummaryBuilds = 0

function drainSummaryBuildQueue() {
  while (
    activeSummaryBuilds < PAYMENT_SUMMARY_BACKGROUND_BUILD_LIMIT &&
    summaryBuildQueue.length > 0
  ) {
    const job = summaryBuildQueue.shift()
    activeSummaryBuilds += 1
    Promise.resolve()
      .then(job.run)
      .then(job.resolve, job.reject)
      .finally(() => {
        activeSummaryBuilds -= 1
        if (summaryBuilds.get(job.key) === job.promise) summaryBuilds.delete(job.key)
        drainSummaryBuildQueue()
      })
  }
}

function enqueueSummaryBuild(key, run) {
  const existing = summaryBuilds.get(key)
  if (existing) return existing

  let resolveBuild
  let rejectBuild
  const build = new Promise((resolve, reject) => {
    resolveBuild = resolve
    rejectBuild = reject
  })
  const job = {
    key,
    run,
    resolve: resolveBuild,
    reject: rejectBuild,
    promise: build
  }
  summaryBuilds.set(key, build)
  summaryBuildQueue.push(job)
  drainSummaryBuildQueue()
  return build
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

async function getAccountScope() {
  const row = await db.get('SELECT location_id FROM highlevel_config ORDER BY created_at DESC, id DESC LIMIT 1')
    .catch(() => null)
  return `account:${String(row?.location_id || '').trim() || 'local-database'}`
}

export async function getPaymentListRevision(scope) {
  const normalized = normalizeScope(scope)
  const row = await db.get('SELECT revision FROM payment_list_revisions WHERE scope = ?', [normalized])
  if (!row) {
    throw Object.assign(
      new Error(`No existe la revisión materializada para ${normalized}`),
      { code: 'PAYMENT_SUMMARY_REVISION_UNAVAILABLE' }
    )
  }
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
  void db.run(`
    DELETE FROM payment_list_summary_cache
    WHERE account_scope = ?
      AND scope NOT IN (
        SELECT scope
        FROM payment_list_summary_cache
        WHERE account_scope = ?
        ORDER BY last_accessed_at DESC, built_at DESC, scope DESC
        LIMIT ?
      )
  `, [accountScope, accountScope, PAYMENT_SUMMARY_CACHE_ENTRIES_PER_ACCOUNT]).catch(() => undefined)
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

async function getCachedPaymentValue({ revisionScope, cacheScope, buildValue }) {
  const normalized = normalizeScope(revisionScope)
  const normalizedCacheScope = String(cacheScope || normalized).trim()
  if (!normalizedCacheScope || normalizedCacheScope.length > 240 || typeof buildValue !== 'function') {
    throw new Error('Consulta cacheada de pagos inválida')
  }
  const accountScope = await getAccountScope()
  let revision
  try {
    revision = await getPaymentListRevision(normalized)
  } catch (error) {
    if (!isPaymentSummaryCacheSchemaUnavailable(error)) throw error

    // Los consumidores unitarios importan controladores sin arrancar server.js,
    // por lo que no recorren la compuerta runVersionedMigrations() que instala
    // 071. También protege un bootstrap incompleto: sin tabla/fila de revisión
    // no existe invalidación confiable, así que jamás se guarda un snapshot.
    // Sólo se tolera esa ausencia conocida; cualquier otro error SQL se propaga.
    const summary = await buildValue()
    return withCacheMetadata(summary, {
      stale: false,
      builtAt: '',
      sourceRevision: 0
    })
  }
  const cached = await readCachedSummary(accountScope, normalizedCacheScope, revision)
  if (cached) {
    return withCacheMetadata(cached.value, {
      stale: false,
      builtAt: cached.builtAt,
      sourceRevision: revision
    })
  }

  const stale = await readLatestSummary(accountScope, normalizedCacheScope)
  const buildKey = `${accountScope}:${normalizedCacheScope}:${revision}`
  let build = summaryBuilds.get(buildKey)
  if (!build) {
    build = enqueueSummaryBuild(buildKey, async () => {
      const summary = await buildValue()
      const builtAt = await persistSummary(accountScope, normalizedCacheScope, revision, summary)
      const currentRevision = await getPaymentListRevision(normalized)
      return { summary, builtAt, exact: currentRevision === revision }
    })
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

export async function getCachedPaymentListSummary(scope, buildSummary) {
  return getCachedPaymentValue({
    revisionScope: scope,
    cacheScope: normalizeScope(scope),
    buildValue: buildSummary
  })
}

/** Cache SWR por hash de consulta, invalidado por la revisión durable de pagos. */
export async function getCachedTransactionQuery(cacheKey, buildValue) {
  const normalizedKey = String(cacheKey || '').trim()
  if (!/^[a-z0-9:_-]{1,200}$/i.test(normalizedKey)) {
    throw new Error('Llave de consulta de transacciones inválida')
  }
  return getCachedPaymentValue({
    revisionScope: 'transactions',
    cacheScope: `transactions:${normalizedKey}`,
    buildValue
  })
}

export const PAYMENT_LIST_SUMMARY_CACHE_LIMITS = Object.freeze({
  scopesPerAccount: VALID_SCOPES.size,
  entriesPerAccount: PAYMENT_SUMMARY_CACHE_ENTRIES_PER_ACCOUNT,
  ttlMs: PAYMENT_SUMMARY_CACHE_TTL_MS,
  maxConcurrentBuilds: PAYMENT_SUMMARY_BACKGROUND_BUILD_LIMIT
})
