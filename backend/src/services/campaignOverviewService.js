import { createHash } from 'node:crypto'
import { DateTime } from 'luxon'
import { databaseDialect, db } from '../config/database.js'
import {
  resolveDateRangeWithGHLTimezone,
  sqliteTimezoneModifierExpression
} from '../utils/dateUtils.js'
import { buildDedupExpression } from './analyticsService.js'
import {
  buildHiddenContactsCondition,
  getHiddenContactFilters
} from '../utils/hiddenContactsFilter.js'
import { getVisitorIdentityExpression } from './trackingService.js'
import {
  getCampaignPerformanceAccountScope,
  getCampaignPerformanceSourceRevision
} from './campaignPerformanceMaterializationService.js'

const isPostgres = databaseDialect === 'postgres'
const overviewBuilds = new Map()
const OVERVIEW_FRESH_TTL_MS = 30_000
const OVERVIEW_STALE_TTL_MS = 24 * 60 * 60 * 1000
const OVERVIEW_MAX_ENTRIES_PER_ACCOUNT = 48
const OVERVIEW_MAX_CONCURRENT_BUILDS = 2
const overviewBuildWaiters = []
let activeOverviewBuilds = 0

function createAbortError() {
  return Object.assign(new Error('La consulta de publicidad fue cancelada'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
    status: 499
  })
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError()
}

async function withOverviewBuildSlot(signal, callback) {
  throwIfAborted(signal)
  if (activeOverviewBuilds >= OVERVIEW_MAX_CONCURRENT_BUILDS) {
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null }
      waiter.onAbort = () => {
        const index = overviewBuildWaiters.indexOf(waiter)
        if (index >= 0) overviewBuildWaiters.splice(index, 1)
        reject(createAbortError())
      }
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      overviewBuildWaiters.push(waiter)
    })
  } else {
    activeOverviewBuilds += 1
  }

  try {
    throwIfAborted(signal)
    return await callback()
  } finally {
    let next = overviewBuildWaiters.shift()
    while (next?.signal?.aborted) next = overviewBuildWaiters.shift()
    if (next) {
      next.signal?.removeEventListener('abort', next.onAbort)
      next.resolve()
    } else {
      activeOverviewBuilds = Math.max(0, activeOverviewBuilds - 1)
    }
  }
}

function waitForOverviewBuild(record, signal) {
  if (signal?.aborted) {
    if (!record.keepAlive && record.waiters === 0) record.controller.abort()
    throw createAbortError()
  }
  record.waiters += 1

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      record.waiters = Math.max(0, record.waiters - 1)
      callback(value)
    }
    const onAbort = () => {
      finish(reject, createAbortError())
      if (!record.keepAlive && record.waiters === 0) record.controller.abort()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    record.promise.then(
      result => finish(resolve, result),
      error => finish(reject, error)
    )
  })
}

function hashSnapshotScope(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function timestampDateExpression(column, timezone, range) {
  if (isPostgres) {
    const safeTimezone = String(timezone || 'UTC').replace(/'/g, "''")
    return `((${column})::timestamptz AT TIME ZONE '${safeTimezone}')::date`
  }

  const modifier = sqliteTimezoneModifierExpression(column, timezone, {
    startUtc: range.startUtc,
    endUtc: range.endUtc
  })
  return `DATE(${column}, ${modifier})`
}

function dayExpression(column, timezone, range) {
  const dateExpression = timestampDateExpression(column, timezone, range)
  return isPostgres ? `TO_CHAR(${dateExpression}, 'YYYY-MM-DD')` : dateExpression
}

function attributionMatchCondition(alias, range) {
  const contactDay = timestampDateExpression(`${alias}.created_at`, range.appliedTimezone, range)
  const sameCalendarDay = isPostgres
    ? `matched_ad.date = (${contactDay})::text`
    : `matched_ad.date = ${contactDay}`
  return `${alias}.attribution_ad_id IS NOT NULL
    AND ${alias}.attribution_ad_id != ''
    AND EXISTS (
      SELECT 1
      FROM meta_ads matched_ad
      WHERE matched_ad.ad_id = ${alias}.attribution_ad_id
        AND ${sameCalendarDay}
    )`
}

async function getAttributionCalendarIds() {
  const row = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    ['attribution_calendar_ids']
  ).catch(() => null)
  if (!row?.config_value) return null

  try {
    const values = JSON.parse(row.config_value)
    return Array.isArray(values) && values.length
      ? [...new Set(values.map(value => String(value).trim()).filter(Boolean))].sort()
      : null
  } catch {
    return null
  }
}

function getPreviousRange(range) {
  const spanDays = Math.max(Math.round(range.endZoned.diff(range.startZoned, 'days').days) + 1, 1)
  const endZoned = range.startZoned.minus({ days: 1 }).endOf('day')
  const startZoned = endZoned.minus({ days: spanDays - 1 }).startOf('day')
  return {
    startZoned,
    endZoned,
    startUtc: startZoned.toUTC().toISO({ suppressMilliseconds: false }),
    endUtc: endZoned.toUTC().toISO({ suppressMilliseconds: false })
  }
}

function numeric(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function sumRows(rows, dateFrom, dateTo) {
  return rows.filter(row => row.day >= dateFrom && row.day <= dateTo).reduce((totals, row) => ({
    spend: totals.spend + numeric(row.spend),
    clicks: totals.clicks + numeric(row.clicks),
    reach: totals.reach + numeric(row.reach),
    leads: totals.leads + numeric(row.leads),
    sales: totals.sales + numeric(row.sales),
    revenue: totals.revenue + numeric(row.revenue)
  }), { spend: 0, clicks: 0, reach: 0, leads: 0, sales: 0, revenue: 0 })
}

function indexRows(rows) {
  return new Map(rows.map(row => [String(row.day), row]))
}

function enumerateDateOnly(startZoned, endZoned) {
  const dates = []
  let cursor = startZoned.startOf('day')
  const end = endZoned.startOf('day')
  while (cursor <= end) {
    dates.push(cursor.toISODate())
    cursor = cursor.plus({ days: 1 })
  }
  return dates
}

async function buildCampaignOverview({ range, hiddenFilters, calendarIds, includeVisitors, signal }) {
  throwIfAborted(signal)
  const previous = getPreviousRange(range)
  const currentStart = range.startZoned.toISODate()
  const currentEnd = range.endZoned.toISODate()
  const previousStart = previous.startZoned.toISODate()
  const previousEnd = previous.endZoned.toISODate()
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
  const dedupExpression = buildDedupExpression('c')
  const contactsDay = dayExpression('c.created_at', range.appliedTimezone, {
    ...range,
    startUtc: previous.startUtc
  })
  const sessionsDay = dayExpression('s.started_at', range.appliedTimezone, range)
  const calendarCondition = calendarIds?.length
    ? `AND a.calendar_id IN (${calendarIds.map(() => '?').join(', ')})`
    : ''
  const queryOptions = signal ? { signal } : undefined

  // Cuatro scans acotados sustituyen once agregados solapados del contrato
  // histórico: Meta y contactos se recorren una vez para periodo actual+previo;
  // citas y visitantes se recorren una vez sólo para el gráfico actual.
  const [adsRows, contactRows, appointmentRows, visitorRows] = await Promise.all([
    db.all(`
      SELECT
        m.date AS day,
        COALESCE(SUM(m.spend), 0) AS spend,
        COALESCE(SUM(m.clicks), 0) AS clicks,
        COALESCE(SUM(m.reach), 0) AS reach
      FROM meta_ads m
      WHERE m.date >= ?
        AND m.date <= ?
      GROUP BY m.date
      ORDER BY m.date
    `, [previousStart, currentEnd], queryOptions),
    db.all(`
      SELECT
        ${contactsDay} AS day,
        COUNT(DISTINCT ${dedupExpression}) AS leads,
        COUNT(DISTINCT CASE WHEN COALESCE(c.purchases_count, 0) > 0 THEN ${dedupExpression} END) AS sales,
        COALESCE(SUM(c.total_paid), 0) AS revenue
      FROM contacts c
      WHERE c.created_at >= ?
        AND c.created_at <= ?
        AND ${attributionMatchCondition('c', { ...range, startUtc: previous.startUtc })}
        ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
      GROUP BY day
      ORDER BY day
    `, [previous.startUtc, range.endUtc], queryOptions),
    db.all(`
      SELECT
        ${dayExpression('c.created_at', range.appliedTimezone, range)} AS day,
        COUNT(DISTINCT ${dedupExpression}) AS appointments
      FROM contacts c
      INNER JOIN appointments a ON a.contact_id = c.id
      WHERE c.created_at >= ?
        AND c.created_at <= ?
        AND ${attributionMatchCondition('c', range)}
        ${calendarCondition}
        ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
      GROUP BY day
      ORDER BY day
    `, [range.startUtc, range.endUtc, ...(calendarIds || [])], queryOptions),
    includeVisitors
      ? db.all(`
          SELECT
            ${sessionsDay} AS day,
            COUNT(DISTINCT ${getVisitorIdentityExpression('s')}) AS visitors
          FROM sessions s
          WHERE s.ad_id IS NOT NULL
            AND s.ad_id != ''
            AND s.started_at >= ?
            AND s.started_at <= ?
          GROUP BY day
          ORDER BY day
        `, [range.startUtc, range.endUtc], queryOptions)
      : Promise.resolve([])
  ])
  throwIfAborted(signal)

  const currentAds = sumRows(adsRows, currentStart, currentEnd)
  const previousAds = sumRows(adsRows, previousStart, previousEnd)
  const currentContacts = sumRows(contactRows, currentStart, currentEnd)
  const previousContacts = sumRows(contactRows, previousStart, previousEnd)
  const spend = currentAds.spend
  const spendPrev = previousAds.spend
  const revenue = currentContacts.revenue
  const revenuePrev = previousContacts.revenue
  const dates = enumerateDateOnly(range.startZoned, range.endZoned)
  const adsByDay = indexRows(adsRows)
  const contactsByDay = indexRows(contactRows)
  const appointmentsByDay = indexRows(appointmentRows)
  const visitorsByDay = indexRows(visitorRows)

  return {
    range: {
      start: range.startUtc,
      end: range.endUtc,
      timezone: range.appliedTimezone,
      filtered: range.isFiltered
    },
    summary: {
      spend,
      spendPrev,
      clicks: currentAds.clicks,
      clicksPrev: previousAds.clicks,
      reach: currentAds.reach,
      reachPrev: previousAds.reach,
      leads: currentContacts.leads,
      leadsPrev: previousContacts.leads,
      sales: currentContacts.sales,
      salesPrev: previousContacts.sales,
      revenue,
      revenuePrev,
      roas: spend > 0 ? revenue / spend : 0,
      roasPrev: spendPrev > 0 ? revenuePrev / spendPrev : 0
    },
    spendOverTime: dates.map(day => ({
      label: day,
      value: numeric(contactsByDay.get(day)?.revenue),
      value2: numeric(adsByDay.get(day)?.spend)
    })),
    funnelMetrics: dates.map(day => ({
      label: day,
      visitors: includeVisitors ? numeric(visitorsByDay.get(day)?.visitors) : 0,
      leads: numeric(contactsByDay.get(day)?.leads),
      appointments: numeric(appointmentsByDay.get(day)?.appointments),
      sales: numeric(contactsByDay.get(day)?.sales)
    }))
  }
}

async function readCachedOverview(accountScope, cacheKey) {
  const row = await db.get(`
    SELECT source_revision, payload_json, built_at
    FROM campaign_overview_snapshots
    WHERE account_scope = ? AND cache_key = ?
    LIMIT 1
  `, [accountScope, cacheKey])
  if (!row) return null

  try {
    const builtAt = row.built_at instanceof Date ? row.built_at.toISOString() : String(row.built_at)
    const payload = JSON.parse(row.payload_json)
    void db.run(`
      UPDATE campaign_overview_snapshots
      SET last_accessed_at = CURRENT_TIMESTAMP
      WHERE account_scope = ? AND cache_key = ?
    `, [accountScope, cacheKey]).catch(() => undefined)
    return {
      payload,
      sourceRevision: String(row.source_revision || ''),
      builtAt,
      ageMs: Math.max(0, Date.now() - Date.parse(builtAt))
    }
  } catch {
    void db.run(
      'DELETE FROM campaign_overview_snapshots WHERE account_scope = ? AND cache_key = ?',
      [accountScope, cacheKey]
    ).catch(() => undefined)
    return null
  }
}

async function writeCachedOverview({ accountScope, cacheKey, sourceRevision, payload }) {
  const builtAt = new Date().toISOString()
  await db.run(`
    INSERT INTO campaign_overview_snapshots (
      account_scope, cache_key, source_revision, payload_json, built_at, last_accessed_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_scope, cache_key) DO UPDATE SET
      source_revision = excluded.source_revision,
      payload_json = excluded.payload_json,
      built_at = excluded.built_at,
      last_accessed_at = excluded.last_accessed_at
  `, [accountScope, cacheKey, sourceRevision, JSON.stringify(payload), builtAt, builtAt])
  return builtAt
}

async function pruneOverviewCache(accountScope) {
  const cutoff = new Date(Date.now() - OVERVIEW_STALE_TTL_MS).toISOString()
  await db.run(
    'DELETE FROM campaign_overview_snapshots WHERE account_scope = ? AND last_accessed_at < ?',
    [accountScope, cutoff]
  )
  const extra = await db.all(`
    SELECT cache_key
    FROM campaign_overview_snapshots
    WHERE account_scope = ?
    ORDER BY last_accessed_at DESC, cache_key ASC
    LIMIT 1000 OFFSET ?
  `, [accountScope, OVERVIEW_MAX_ENTRIES_PER_ACCOUNT])
  for (const row of extra) {
    await db.run(
      'DELETE FROM campaign_overview_snapshots WHERE account_scope = ? AND cache_key = ?',
      [accountScope, row.cache_key]
    )
  }
}

function attachCacheMetadata(payload, { stale, builtAt, sourceRevision }) {
  return {
    ...payload,
    cache: {
      stale: Boolean(stale),
      builtAt: builtAt || null,
      sourceRevision: sourceRevision || null
    }
  }
}

export async function getCampaignOverviewSnapshot({
  startDate,
  endDate,
  includeVisitors = true,
  waitForFresh = false,
  signal
} = {}) {
  const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
  if (!range.startZoned || !range.endZoned || !range.startUtc || !range.endUtc) {
    const error = new Error('Se requieren startDate y endDate válidas')
    error.status = 400
    throw error
  }
  throwIfAborted(signal)

  const [hiddenFilters, calendarIds, accountScope, sourceRevision] = await Promise.all([
    getHiddenContactFilters(),
    getAttributionCalendarIds(),
    getCampaignPerformanceAccountScope(),
    getCampaignPerformanceSourceRevision({ includeVisitors })
  ])
  throwIfAborted(signal)

  const cacheKey = hashSnapshotScope({
    startUtc: range.startUtc,
    endUtc: range.endUtc,
    timezone: range.appliedTimezone,
    includeVisitors: Boolean(includeVisitors),
    hiddenFilters,
    calendarIds: calendarIds || []
  })
  const buildKey = `${accountScope}:${cacheKey}`
  const cached = await readCachedOverview(accountScope, cacheKey)
  const cacheIsFresh = cached && (
    cached.sourceRevision === sourceRevision || cached.ageMs <= OVERVIEW_FRESH_TTL_MS
  )
  if (cacheIsFresh) {
    return attachCacheMetadata(cached.payload, {
      stale: false,
      builtAt: cached.builtAt,
      sourceRevision: cached.sourceRevision
    })
  }

  const startBuild = ({ keepAlive = false } = {}) => {
    const active = overviewBuilds.get(buildKey)
    if (active) {
      if (keepAlive) active.keepAlive = true
      return active
    }

    const record = {
      controller: new AbortController(),
      keepAlive,
      waiters: 0,
      promise: null
    }
    record.promise = withOverviewBuildSlot(record.controller.signal, async () => {
      const buildStartedRevision = await getCampaignPerformanceSourceRevision({ includeVisitors })
      const payload = await buildCampaignOverview({
        range,
        hiddenFilters,
        calendarIds,
        includeVisitors,
        signal: record.controller.signal
      })
      const completedRevision = await getCampaignPerformanceSourceRevision({ includeVisitors })
      // Si hubo escrituras durante los cuatro scans, no mentimos diciendo que
      // el resultado representa la revision final: queda stale y se recompone.
      const builtAt = await writeCachedOverview({
        accountScope,
        cacheKey,
        sourceRevision: buildStartedRevision,
        payload
      })
      void pruneOverviewCache(accountScope).catch(() => undefined)
      return {
        payload,
        builtAt,
        sourceRevision: buildStartedRevision,
        completedRevision
      }
    }).finally(() => {
      if (overviewBuilds.get(buildKey) === record) overviewBuilds.delete(buildKey)
    })
    overviewBuilds.set(buildKey, record)
    return record
  }

  if (cached && !waitForFresh && cached.ageMs <= OVERVIEW_STALE_TTL_MS) {
    const backgroundBuild = startBuild({ keepAlive: true })
    void backgroundBuild.promise.catch(() => undefined)
    return attachCacheMetadata(cached.payload, {
      stale: true,
      builtAt: cached.builtAt,
      sourceRevision: cached.sourceRevision
    })
  }

  const record = startBuild()
  const result = await waitForOverviewBuild(record, signal)
  throwIfAborted(signal)
  return attachCacheMetadata(result.payload, {
    stale: result.completedRevision !== result.sourceRevision,
    builtAt: result.builtAt,
    sourceRevision: result.sourceRevision
  })
}

export const campaignOverviewCachePolicy = Object.freeze({
  freshTtlMs: OVERVIEW_FRESH_TTL_MS,
  staleTtlMs: OVERVIEW_STALE_TTL_MS,
  maxConcurrentBuilds: OVERVIEW_MAX_CONCURRENT_BUILDS
})
