import { databaseDialect, db } from '../config/database.js'

const CAMPAIGN_CACHE_MAX_ENTRIES_PER_ACCOUNT = 48
const CAMPAIGN_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const CAMPAIGN_CACHE_INSERT_BATCH_SIZE = 25

const CACHE_SORT_COLUMNS = Object.freeze({
  name: 'name',
  spend: 'spend',
  reach: 'reach',
  clicks: 'clicks',
  cpc: 'cpc',
  cpm: 'cpm',
  lastActiveDate: 'last_active_date',
  revenue: 'revenue',
  roas: 'roas',
  sales: 'sales',
  leads: 'leads',
  appointments: 'appointments',
  attendances: 'attendances',
  visitors: 'visitors'
})

function cleanString(value, maxLength = 500) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function numeric(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function revisionValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  return cleanString(value, 120)
}

export async function getCampaignPerformanceAccountScope({ signal } = {}) {
  const row = await db.get(
    'SELECT location_id FROM highlevel_config ORDER BY created_at DESC, id DESC LIMIT 1',
    [],
    signal ? { signal } : undefined
  )
    .catch((error) => {
      if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error
      return null
    })
  return `account:${cleanString(row?.location_id, 240) || 'local-database'}`
}

export async function getCampaignPerformanceSourceRevision({ includeVisitors = false, signal } = {}) {
  const revision = await db.get(
    'SELECT core_revision, visitor_revision FROM campaign_performance_revision WHERE id = 1',
    [],
    signal ? { signal } : undefined
  )
  const coreRevision = Number(revision?.core_revision || 0)
  if (!includeVisitors) return `core:${coreRevision}`

  if (databaseDialect === 'postgres') {
    const visitorSequence = await db.get(
      'SELECT last_value, is_called FROM campaign_performance_visitor_revision_seq',
      [],
      signal ? { signal } : undefined
    )
    const visitorRevision = visitorSequence?.is_called
      ? Number(visitorSequence.last_value || 0)
      : 0
    return `core:${coreRevision}|visitor:${visitorRevision}`
  }

  return [
    `core:${coreRevision}`,
    `visitor:${Number(revision?.visitor_revision || 0)}`
  ].join('|')
}

function buildCachedFilter({ search = '', onlyWithResults = false } = {}) {
  const conditions = []
  const params = []
  const normalizedSearch = cleanString(search, 160).toLowerCase()
  if (normalizedSearch) {
    const escaped = normalizedSearch.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_')
    conditions.push("(LOWER(COALESCE(name, '')) LIKE ? ESCAPE '!' OR LOWER(entity_id) LIKE ? ESCAPE '!')")
    params.push(`%${escaped}%`, `%${escaped}%`)
  }
  if (onlyWithResults) {
    conditions.push('(revenue > 0 OR sales > 0 OR appointments > 0 OR attendances > 0 OR leads > 0)')
  }
  return {
    sql: conditions.length ? `AND ${conditions.join(' AND ')}` : '',
    params
  }
}

export async function readCampaignPerformanceMaterializedPage({
  accountScope,
  cacheKey,
  sourceRevision,
  search,
  onlyWithResults,
  sortBy,
  sortOrder,
  pageSize,
  offset
}) {
  const entry = await db.get(`
    SELECT total_items, built_at
    FROM campaign_performance_cache_entries
    WHERE account_scope = ? AND cache_key = ? AND source_revision = ?
    LIMIT 1
  `, [accountScope, cacheKey, sourceRevision])
  if (!entry) return null

  const filter = buildCachedFilter({ search, onlyWithResults })
  const orderColumn = CACHE_SORT_COLUMNS[sortBy] || CACHE_SORT_COLUMNS.revenue
  const direction = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
  const baseParams = [accountScope, cacheKey, sourceRevision, ...filter.params]
  const [countRow, rows] = await Promise.all([
    db.get(`
      SELECT COUNT(*) AS total
      FROM campaign_performance_cache_rows
      WHERE account_scope = ? AND cache_key = ? AND source_revision = ?
      ${filter.sql}
    `, baseParams),
    db.all(`
      SELECT payload_json
      FROM campaign_performance_cache_rows
      WHERE account_scope = ? AND cache_key = ? AND source_revision = ?
      ${filter.sql}
      ORDER BY ${orderColumn} ${direction}, entity_id ${direction}
      LIMIT ? OFFSET ?
    `, [...baseParams, pageSize, offset])
  ])

  void db.run(`
    UPDATE campaign_performance_cache_entries
    SET last_accessed_at = CURRENT_TIMESTAMP
    WHERE account_scope = ? AND cache_key = ? AND source_revision = ?
  `, [accountScope, cacheKey, sourceRevision]).catch(() => undefined)

  return {
    items: rows.map(row => JSON.parse(row.payload_json)),
    totalItems: Number(countRow?.total || 0),
    builtAt: revisionValue(entry.built_at),
    sourceRevision
  }
}

export async function readLatestCampaignPerformanceMaterializedPage({
  accountScope,
  cacheKey,
  search,
  onlyWithResults,
  sortBy,
  sortOrder,
  pageSize,
  offset
}) {
  const latest = await db.get(`
    SELECT source_revision, built_at
    FROM campaign_performance_cache_entries
    WHERE account_scope = ? AND cache_key = ?
    ORDER BY built_at DESC, source_revision DESC
    LIMIT 1
  `, [accountScope, cacheKey])
  if (!latest) return null
  const builtAtMs = Date.parse(String(latest.built_at || ''))
  if (!Number.isFinite(builtAtMs) || Date.now() - builtAtMs > CAMPAIGN_CACHE_TTL_MS) return null

  return readCampaignPerformanceMaterializedPage({
    accountScope,
    cacheKey,
    sourceRevision: String(latest.source_revision),
    search,
    onlyWithResults,
    sortBy,
    sortOrder,
    pageSize,
    offset
  })
}

async function deleteCacheEntries(transaction, entries) {
  for (const entry of entries) {
    const params = [entry.account_scope, entry.cache_key, entry.source_revision]
    await transaction.run(`
      DELETE FROM campaign_performance_cache_rows
      WHERE account_scope = ? AND cache_key = ? AND source_revision = ?
    `, params)
    await transaction.run(`
      DELETE FROM campaign_performance_cache_entries
      WHERE account_scope = ? AND cache_key = ? AND source_revision = ?
    `, params)
  }
}

export async function pruneCampaignPerformanceMaterializedCache(accountScope) {
  const cutoff = new Date(Date.now() - CAMPAIGN_CACHE_TTL_MS).toISOString()
  await db.transaction(async transaction => {
    const expired = await transaction.all(`
      SELECT account_scope, cache_key, source_revision
      FROM campaign_performance_cache_entries
      WHERE account_scope = ? AND last_accessed_at < ?
    `, [accountScope, cutoff])
    await deleteCacheEntries(transaction, expired)

    const entries = await transaction.all(`
      SELECT account_scope, cache_key, source_revision
      FROM campaign_performance_cache_entries
      WHERE account_scope = ?
      ORDER BY last_accessed_at DESC, cache_key ASC
    `, [accountScope])
    await deleteCacheEntries(transaction, entries.slice(CAMPAIGN_CACHE_MAX_ENTRIES_PER_ACCOUNT))
  })
}

export async function replaceCampaignPerformanceMaterializedRows({
  accountScope,
  cacheKey,
  sourceRevision,
  level,
  items
}) {
  const builtAt = new Date().toISOString()
  await db.transaction(async transaction => {
    await transaction.run(`
      DELETE FROM campaign_performance_cache_rows
      WHERE account_scope = ? AND cache_key = ? AND source_revision = ?
    `, [accountScope, cacheKey, sourceRevision])
    await transaction.run(`
      DELETE FROM campaign_performance_cache_entries
      WHERE account_scope = ? AND cache_key = ? AND source_revision = ?
    `, [accountScope, cacheKey, sourceRevision])

    for (let start = 0; start < items.length; start += CAMPAIGN_CACHE_INSERT_BATCH_SIZE) {
      const batch = items.slice(start, start + CAMPAIGN_CACHE_INSERT_BATCH_SIZE)
      const columnsPerRow = 21
      const placeholders = batch.map(() => `(${Array.from({ length: columnsPerRow }, () => '?').join(', ')})`).join(', ')
      const params = []
      for (const item of batch) {
        params.push(
          accountScope,
          cacheKey,
          sourceRevision,
          cleanString(item.id, 300),
          cleanString(item.name, 500),
          numeric(item.spend),
          numeric(item.reach),
          numeric(item.clicks),
          numeric(item.cpc),
          numeric(item.cpm),
          numeric(item.revenue),
          numeric(item.roas),
          numeric(item.sales),
          numeric(item.leads),
          numeric(item.appointments),
          numeric(item.attendances),
          numeric(item.visitors),
          item.lastActiveDate || null,
          JSON.stringify(item),
          builtAt,
          builtAt
        )
      }
      await transaction.run(`
        INSERT INTO campaign_performance_cache_rows (
          account_scope, cache_key, source_revision, entity_id, name,
          spend, reach, clicks, cpc, cpm, revenue, roas, sales, leads,
          appointments, attendances, visitors, last_active_date, payload_json,
          created_at, updated_at
        ) VALUES ${placeholders}
        ON CONFLICT(account_scope, cache_key, source_revision, entity_id) DO UPDATE SET
          name = excluded.name,
          spend = excluded.spend,
          reach = excluded.reach,
          clicks = excluded.clicks,
          cpc = excluded.cpc,
          cpm = excluded.cpm,
          revenue = excluded.revenue,
          roas = excluded.roas,
          sales = excluded.sales,
          leads = excluded.leads,
          appointments = excluded.appointments,
          attendances = excluded.attendances,
          visitors = excluded.visitors,
          last_active_date = excluded.last_active_date,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `, params)
    }

    await transaction.run(`
      INSERT INTO campaign_performance_cache_entries (
        account_scope, cache_key, source_revision, level, total_items, built_at, last_accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_scope, cache_key, source_revision) DO UPDATE SET
        level = excluded.level,
        total_items = excluded.total_items,
        built_at = excluded.built_at,
        last_accessed_at = excluded.last_accessed_at
    `, [accountScope, cacheKey, sourceRevision, level, items.length, builtAt, builtAt])
  })

  await pruneCampaignPerformanceMaterializedCache(accountScope)
  return builtAt
}

export const CAMPAIGN_PERFORMANCE_MATERIALIZED_LIMITS = Object.freeze({
  maxEntriesPerAccount: CAMPAIGN_CACHE_MAX_ENTRIES_PER_ACCOUNT,
  ttlMs: CAMPAIGN_CACHE_TTL_MS
})
