import { createHash } from 'node:crypto'

import { databaseDialect, db } from '../config/database.js'
import { BACKFILL_JOB_PRIORITY } from '../jobs/backfillJobCoordinator.js'
import { scheduleProjectionBackfillJob } from '../jobs/projectionBackfillScheduler.js'
import {
  getAccountTimezone,
  normalizeDateOnlyInTimezone,
  normalizeToUtcIso,
  resolveTimezone
} from '../utils/dateUtils.js'
import { isDeployShutdownStarted } from '../utils/deployDrainTracker.js'
import { logger } from '../utils/logger.js'
import { normalizeTrafficSource } from '../utils/trafficSourceNormalizer.js'
import { invalidateTrackingAnalyticsCache } from './trackingAnalyticsCache.js'
import {
  applyTrackingAnalyticsDailyMutation,
  applyTrackingAnalyticsRangeMutation,
  repairTrackingAnalyticsReturningVisitors,
  runTrackingAnalyticsRangeCompilationBatch
} from './trackingAnalyticsRangeRollupService.js'

export const TRACKING_ANALYTICS_PROJECTION_VERSION = 3

const PROJECTION_STATE_ID = 1
const BACKFILL_JOB_KEY = 'tracking-analytics-projection'
const POSTGRES_BATCH_SIZE = 250
const SQLITE_BATCH_SIZE = 100
const QUEUE_BATCH_SIZE = 250
const MAX_BACKFILL_BATCHES_PER_RUN = 4
const MAX_QUEUE_BATCHES_PER_RUN = 10
const MAX_RANGE_BATCHES_PER_RUN = 4
const MAX_RETURNING_REPAIR_BATCHES_PER_RUN = 10
const DEFAULT_YIELD_MS = 25
const BACKFILL_PAUSE_MS = 100
const CONTINUOUS_POLL_MS = 2_000
const ERROR_RETRY_MS = 30_000
const SQLITE_PARAMETER_BUDGET = 900
const POSTGRES_PARAMETER_BUDGET = 20_000
const MAX_TEXT_LENGTH = 2_000
const MAX_LABEL_LENGTH = 500
const MAX_INDEXED_DIMENSION_BYTES = 300
const DIMENSION_GC_BATCH_SIZE = 250
const DIMENSION_GC_MAX_PER_RUN = 2_500
const VIEW_EVENTS = new Set(['session_start', 'page_view', 'native_site_view'])

const SESSION_PROJECTION_COLUMNS = Object.freeze([
  'id',
  'session_id',
  'visitor_id',
  'contact_id',
  'event_name',
  'started_at',
  'page_url',
  'referrer_url',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'channel',
  'source_platform',
  'campaign_id',
  'adset_id',
  'ad_group_id',
  'ad_id',
  'campaign_name',
  'adset_name',
  'ad_group_name',
  'ad_name',
  'placement',
  'site_source_name',
  'device_type',
  'os',
  'browser',
  'tracking_source',
  'site_id',
  'site_slug',
  'site_name',
  'site_type',
  'form_site_id',
  'form_site_name'
])

const DIMENSION_COLUMNS = Object.freeze([
  'dimension_key',
  'page_value',
  'traffic_source',
  'utm_campaign',
  'utm_medium',
  'utm_content',
  'device_type',
  'browser',
  'os',
  'placement',
  'ad_platform',
  'campaign_id',
  'campaign_label',
  'adset_id',
  'adset_label',
  'ad_id',
  'ad_label',
  'tracking_source',
  'channel',
  'site_type',
  'site_id',
  'site_label',
  'form_site_id',
  'form_label',
  'native_conversion_source',
  'native_conversion_label'
])

const DIMENSION_KEY_COLUMNS = Object.freeze(DIMENSION_COLUMNS.filter(column => (
  column !== 'dimension_key' && !column.endsWith('_label')
)))

const FACT_COLUMNS = Object.freeze([
  'session_row_id',
  'projection_version',
  'business_date',
  'dimension_key',
  'visitor_key',
  'session_key',
  'contact_key',
  'event_count',
  'view_count',
  'started_at'
])

const PRESENCE_KEY_COLUMNS = Object.freeze([
  'business_date',
  'dimension_key',
  'visitor_key',
  'session_key',
  'contact_key'
])

let workerPromise = null
let workerScheduled = false
let workerEligibleAt = 0
let workerResumeTimer = null

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))

function textValue(value, maxLength = MAX_TEXT_LENGTH) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function truncateUtf8(value, maxBytes = MAX_INDEXED_DIMENSION_BYTES) {
  const normalized = textValue(value)
  if (Buffer.byteLength(normalized, 'utf8') <= maxBytes) return normalized
  let result = ''
  let bytes = 0
  // Iterar code points evita cortar un surrogate y guardar U+FFFD.
  for (const character of normalized) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maxBytes) break
    result += character
    bytes += characterBytes
  }
  return result
}

function dimensionValue(value) {
  return truncateUtf8(value, MAX_INDEXED_DIMENSION_BYTES)
}

function firstText(...values) {
  for (const value of values) {
    const normalized = textValue(value)
    if (normalized) return normalized
  }
  return ''
}

function pageValue(value) {
  return dimensionValue(textValue(value).split('?', 1)[0])
}

function trafficSource(row) {
  return dimensionValue(normalizeTrafficSource(row))
}

function normalizedChannel(value) {
  const channel = textValue(value).toLowerCase()
  if (!channel) return 'direct'
  if (channel.includes('organic')) return 'organic'
  if (channel.includes('social')) return 'social'
  if (channel.includes('email') || channel.includes('correo')) return 'email'
  if (channel.includes('referral')) return 'referral'
  if (channel.includes('direct')) return 'direct'
  if (
    channel.includes('paid') ||
    channel.includes('cpc') ||
    channel.includes('ppc') ||
    channel.includes('sem') ||
    channel.includes('ads') ||
    channel === 'ad'
  ) return 'paid'
  return dimensionValue(channel)
}

function normalizedTrackingSource(row) {
  if (textValue(row.tracking_source).toLowerCase() === 'native_site' || textValue(row.site_id)) {
    return 'native_site'
  }
  return 'external_pixel'
}

function visitorKey(row) {
  const contactId = textValue(row.contact_id)
  if (contactId) return `contact:${contactId}`
  const visitorId = textValue(row.visitor_id)
  if (visitorId) return `visitor:${visitorId}`
  const sessionId = textValue(row.session_id)
  return sessionId ? `session:${sessionId}` : ''
}

function nativeFormId(row) {
  const explicit = textValue(row.form_site_id)
  if (explicit) return dimensionValue(explicit)
  return ['standard_form', 'interactive_form'].includes(textValue(row.site_type))
    ? dimensionValue(row.site_id)
    : ''
}

function buildDimension(row) {
  const formSiteId = nativeFormId(row)
  const siteId = dimensionValue(row.site_id)
  const nativeConversion = textValue(row.event_name).toLowerCase() === 'native_site_conversion'
  const nativeConversionSource = nativeConversion
    ? (formSiteId ? `form:${formSiteId}` : `site:${siteId}`)
    : ''
  const siteLabel = firstText(row.site_name, row.site_slug, siteId).slice(0, MAX_LABEL_LENGTH)
  const formLabel = firstText(row.form_site_name, row.site_name, formSiteId).slice(0, MAX_LABEL_LENGTH)

  const dimension = {
    page_value: pageValue(row.page_url),
    traffic_source: dimensionValue(trafficSource(row)),
    utm_campaign: dimensionValue(row.utm_campaign),
    utm_medium: dimensionValue(row.utm_medium),
    utm_content: dimensionValue(row.utm_content),
    device_type: dimensionValue(row.device_type),
    browser: dimensionValue(row.browser),
    os: dimensionValue(row.os),
    placement: dimensionValue(row.placement),
    ad_platform: dimensionValue(row.source_platform),
    campaign_id: dimensionValue(row.campaign_id),
    campaign_label: firstText(row.campaign_name, row.campaign_id).slice(0, MAX_LABEL_LENGTH),
    adset_id: dimensionValue(firstText(row.adset_id, row.ad_group_id, row.utm_medium)),
    adset_label: firstText(
      row.adset_name,
      row.ad_group_name,
      row.adset_id,
      row.ad_group_id,
      row.utm_medium
    ).slice(0, MAX_LABEL_LENGTH),
    ad_id: dimensionValue(row.ad_id),
    ad_label: firstText(row.ad_name, row.ad_id).slice(0, MAX_LABEL_LENGTH),
    tracking_source: dimensionValue(normalizedTrackingSource(row)),
    channel: dimensionValue(normalizedChannel(row.channel)),
    site_type: dimensionValue(row.site_type),
    site_id: siteId,
    site_label: siteLabel,
    form_site_id: formSiteId,
    form_label: formLabel,
    native_conversion_source: dimensionValue(nativeConversionSource),
    native_conversion_label: nativeConversion
      ? `${formSiteId ? 'Formulario' : 'Landing'}: ${formSiteId ? formLabel : siteLabel}`.slice(0, MAX_LABEL_LENGTH)
      : ''
  }
  dimension.dimension_key = createHash('sha256')
    .update(JSON.stringify(DIMENSION_KEY_COLUMNS.map(column => dimension[column] || '')))
    .digest('hex')
  return dimension
}

function normalizeSourceFact(row, timezone) {
  const identity = visitorKey(row)
  const startedAt = normalizeToUtcIso(row.started_at, 'UTC')
  if (!identity || !startedAt || !Number.isFinite(Date.parse(startedAt))) return null

  const dimension = buildDimension(row)
  return {
    dimension,
    fact: {
      session_row_id: textValue(row.id),
      projection_version: TRACKING_ANALYTICS_PROJECTION_VERSION,
      business_date: normalizeDateOnlyInTimezone(startedAt, timezone),
      dimension_key: dimension.dimension_key,
      visitor_key: identity,
      session_key: textValue(row.session_id),
      contact_key: textValue(row.contact_id),
      event_count: 1,
      view_count: VIEW_EVENTS.has(textValue(row.event_name).toLowerCase()) ? 1 : 0,
      started_at: startedAt
    }
  }
}

function normalizeDatabaseFact(row) {
  if (!row) return null
  return {
    session_row_id: textValue(row.session_row_id),
    projection_version: Number(row.projection_version || 0),
    business_date: row.business_date instanceof Date
      ? normalizeDateOnlyInTimezone(normalizeToUtcIso(row.business_date, 'UTC'), 'UTC')
      : textValue(row.business_date, 10),
    dimension_key: textValue(row.dimension_key),
    visitor_key: textValue(row.visitor_key),
    session_key: textValue(row.session_key),
    contact_key: textValue(row.contact_key),
    event_count: Number(row.event_count || 0),
    view_count: Number(row.view_count || 0),
    started_at: normalizeToUtcIso(row.started_at, 'UTC')
  }
}

function factsEqual(left, right) {
  if (!left || !right) return false
  return FACT_COLUMNS.every(column => String(left[column] ?? '') === String(right[column] ?? ''))
}

function presenceKey(fact) {
  return JSON.stringify(PRESENCE_KEY_COLUMNS.map(column => fact[column] || ''))
}

function addPresenceDelta(deltas, fact, multiplier) {
  const key = presenceKey(fact)
  const existing = deltas.get(key) || {
    ...Object.fromEntries(PRESENCE_KEY_COLUMNS.map(column => [column, fact[column] || ''])),
    event_count: 0,
    view_count: 0
  }
  existing.event_count += Number(fact.event_count || 0) * multiplier
  existing.view_count += Number(fact.view_count || 0) * multiplier
  deltas.set(key, existing)
}

function boundedInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function chunks(rows, size) {
  const result = []
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size))
  return result
}

function parameterBudget() {
  return databaseDialect === 'postgres' ? POSTGRES_PARAMETER_BUDGET : SQLITE_PARAMETER_BUDGET
}

async function bulkInsert(transaction, table, columns, rows, conflictSql) {
  if (!rows.length) return
  const chunkSize = Math.max(1, Math.floor(parameterBudget() / columns.length))
  for (const batch of chunks(rows, chunkSize)) {
    const placeholders = batch
      .map(() => `(${columns.map(() => '?').join(', ')})`)
      .join(', ')
    const params = batch.flatMap(row => columns.map(column => row[column]))
    await transaction.run(`
      INSERT INTO ${table} (${columns.join(', ')})
      VALUES ${placeholders}
      ${conflictSql}
    `, params)
  }
}

function sessionIdPlaceholders(count) {
  return Array.from({ length: count }, () => databaseDialect === 'postgres' ? '?::uuid' : '?').join(', ')
}

async function readSourceRowsByIds(transaction, ids) {
  const rows = []
  const maxIds = Math.max(1, Math.floor(parameterBudget()))
  for (const batch of chunks(ids, maxIds)) {
    rows.push(...await transaction.all(`
      SELECT ${SESSION_PROJECTION_COLUMNS.join(', ')}
      FROM sessions
      WHERE id IN (${sessionIdPlaceholders(batch.length)})
    `, batch))
  }
  return rows
}

async function readFactsByIds(transaction, ids) {
  const rows = []
  const maxIds = Math.max(1, Math.floor(parameterBudget()))
  for (const batch of chunks(ids, maxIds)) {
    rows.push(...await transaction.all(`
      SELECT ${FACT_COLUMNS.join(', ')}
      FROM tracking_analytics_event_fact
      WHERE session_row_id IN (${batch.map(() => '?').join(', ')})
    `, batch))
  }
  return rows
}

async function deleteFactsByIds(transaction, ids) {
  for (const batch of chunks(ids, parameterBudget())) {
    await transaction.run(`
      DELETE FROM tracking_analytics_event_fact
      WHERE session_row_id IN (${batch.map(() => '?').join(', ')})
    `, batch)
  }
}

async function deleteEmptyPresenceRows(transaction, rows) {
  const conditionsPerBatch = Math.max(1, Math.floor(parameterBudget() / PRESENCE_KEY_COLUMNS.length))
  for (const batch of chunks(rows, conditionsPerBatch)) {
    const keyConditions = batch.map(() => `(
      business_date = ? AND dimension_key = ? AND visitor_key = ?
      AND session_key = ? AND contact_key = ?
    )`).join(' OR ')
    await transaction.run(`
      DELETE FROM tracking_analytics_presence
      WHERE event_count = 0 AND view_count = 0
        AND (${keyConditions})
    `, batch.flatMap(row => PRESENCE_KEY_COLUMNS.map(column => row[column])))
  }
}

async function applyPresenceDeltas(transaction, rows) {
  const additiveRows = rows.filter(row => row.event_count > 0 && row.view_count >= 0)
  const existingOnlyRows = rows.filter(row => !(row.event_count > 0 && row.view_count >= 0))

  // Inserts/backfill son positivos y se agrupan en una sola escritura. Los
  // decrementos no pueden viajar como INSERT negativo: SQLite/PostgreSQL
  // validan CHECK antes de resolver ON CONFLICT. Esos cambios son menos
  // frecuentes y actualizan exactamente la presencia certificada por el fact.
  await bulkInsert(
    transaction,
    'tracking_analytics_presence',
    [...PRESENCE_KEY_COLUMNS, 'event_count', 'view_count'],
    additiveRows,
    `ON CONFLICT(visitor_key, business_date, dimension_key, session_key, contact_key) DO UPDATE SET
      event_count = tracking_analytics_presence.event_count + excluded.event_count,
      view_count = tracking_analytics_presence.view_count + excluded.view_count,
      updated_at = CURRENT_TIMESTAMP`
  )

  for (const row of existingOnlyRows) {
    const result = await transaction.run(`
      UPDATE tracking_analytics_presence
      SET event_count = event_count + ?,
          view_count = view_count + ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE business_date = ?
        AND dimension_key = ?
        AND visitor_key = ?
        AND session_key = ?
        AND contact_key = ?
    `, [
      row.event_count,
      row.view_count,
      ...PRESENCE_KEY_COLUMNS.map(column => row[column])
    ])
    if (Number(result?.changes || 0) !== 1) {
      throw Object.assign(
        new Error(`El ledger de Analíticas no encontró la presencia previa de ${row.visitor_key}`),
        { code: 'TRACKING_ANALYTICS_PRESENCE_MISSING' }
      )
    }
  }
}

async function projectRows(
  transaction,
  sourceRows,
  requestedIds,
  timezone,
  { maintainRanges = true } = {}
) {
  const sourceById = new Map(sourceRows.map(row => [textValue(row.id), row]))
  const oldFacts = (await readFactsByIds(transaction, requestedIds)).map(normalizeDatabaseFact)
  const oldById = new Map(oldFacts.map(fact => [fact.session_row_id, fact]))
  const dimensions = new Map()
  const changedFacts = []
  const deletedFactIds = []
  const deltas = new Map()

  for (const sessionRowId of requestedIds.map(id => textValue(id))) {
    const oldFact = oldById.get(sessionRowId) || null
    const sourceRow = sourceById.get(sessionRowId) || null
    const normalized = sourceRow ? normalizeSourceFact(sourceRow, timezone) : null
    const nextFact = normalized?.fact || null
    if (normalized?.dimension) dimensions.set(normalized.dimension.dimension_key, normalized.dimension)

    if (oldFact && factsEqual(oldFact, nextFact)) continue
    if (oldFact) addPresenceDelta(deltas, oldFact, -1)
    if (nextFact) {
      addPresenceDelta(deltas, nextFact, 1)
      changedFacts.push(nextFact)
    } else if (oldFact) {
      deletedFactIds.push(sessionRowId)
    }
  }

  await bulkInsert(
    transaction,
    'tracking_analytics_dimensions',
    DIMENSION_COLUMNS,
    [...dimensions.values()],
    `ON CONFLICT(dimension_key) DO UPDATE SET
      campaign_label = CASE WHEN excluded.campaign_label != '' THEN excluded.campaign_label ELSE tracking_analytics_dimensions.campaign_label END,
      adset_label = CASE WHEN excluded.adset_label != '' THEN excluded.adset_label ELSE tracking_analytics_dimensions.adset_label END,
      ad_label = CASE WHEN excluded.ad_label != '' THEN excluded.ad_label ELSE tracking_analytics_dimensions.ad_label END,
      site_label = CASE WHEN excluded.site_label != '' THEN excluded.site_label ELSE tracking_analytics_dimensions.site_label END,
      form_label = CASE WHEN excluded.form_label != '' THEN excluded.form_label ELSE tracking_analytics_dimensions.form_label END,
      native_conversion_label = CASE WHEN excluded.native_conversion_label != '' THEN excluded.native_conversion_label ELSE tracking_analytics_dimensions.native_conversion_label END`
  )

  const presenceRows = [...deltas.values()].filter(row => row.event_count !== 0 || row.view_count !== 0)
  await applyPresenceDeltas(transaction, presenceRows)
  await deleteEmptyPresenceRows(transaction, presenceRows)
  if (maintainRanges) await applyTrackingAnalyticsRangeMutation(transaction, presenceRows)
  else await applyTrackingAnalyticsDailyMutation(transaction, presenceRows)

  await bulkInsert(
    transaction,
    'tracking_analytics_event_fact',
    FACT_COLUMNS,
    changedFacts,
    `ON CONFLICT(session_row_id) DO UPDATE SET
      projection_version = excluded.projection_version,
      business_date = excluded.business_date,
      dimension_key = excluded.dimension_key,
      visitor_key = excluded.visitor_key,
      session_key = excluded.session_key,
      contact_key = excluded.contact_key,
      event_count = excluded.event_count,
      view_count = excluded.view_count,
      started_at = excluded.started_at,
      updated_at = CURRENT_TIMESTAMP`
  )
  await deleteFactsByIds(transaction, deletedFactIds)

  return {
    requested: requestedIds.length,
    changed: changedFacts.length + deletedFactIds.length,
    dimensions: dimensions.size,
    presenceChanges: presenceRows.length
  }
}

function isMissingProjectionSchema(error) {
  const code = String(error?.code || '').toUpperCase()
  if (code === '42P01' || code === '42703' || code === '42883') return true
  if (code !== 'SQLITE_ERROR') return false
  return /no such (?:table|column):\s*(?:tracking_analytics_|range_)/i.test(String(error?.message || ''))
}

export async function readTrackingAnalyticsProjectionState(database = db, { signal } = {}) {
  try {
    return await database.get(`
      SELECT
        singleton_id,
        projection_version,
        account_timezone,
        status,
        backfill_cursor,
        backfill_complete,
        range_status,
        range_compile_cursor,
        range_backfill_complete,
        last_applied_at,
        last_error,
        updated_at
      FROM tracking_analytics_projection_state
      WHERE singleton_id = ?
    `, [PROJECTION_STATE_ID], { signal })
  } catch (error) {
    if (isMissingProjectionSchema(error)) return null
    throw error
  }
}

function isBackfillComplete(value) {
  return value === true || Number(value) === 1 || String(value).toLowerCase() === 'true'
}

async function hasPendingChanges(database = db, { signal } = {}) {
  const sourceRow = await database.get(`
    SELECT session_row_id
    FROM tracking_analytics_change_queue
    LIMIT 1
  `, [], { signal })
  if (sourceRow) return true
  const returningRow = await database.get(`
    SELECT visitor_key
    FROM tracking_analytics_returning_dirty_queue
    LIMIT 1
  `, [], { signal })
  return Boolean(returningRow)
}

export async function getTrackingAnalyticsProjectionStatus({ schedule = false, signal } = {}) {
  const state = await readTrackingAnalyticsProjectionState(db, { signal })
  if (!state) {
    if (schedule) scheduleTrackingAnalyticsProjectionBackfill()
    return {
      available: false,
      ready: false,
      status: 'unavailable',
      sourceStatus: 'missing',
      version: TRACKING_ANALYTICS_PROJECTION_VERSION,
      timezone: null,
      pending: false,
      updatedAt: null,
      lastAppliedAt: null,
      lastError: null
    }
  }

  const timezone = resolveTimezone(await getAccountTimezone({ signal }))
  const versionMatches = Number(state.projection_version) === TRACKING_ANALYTICS_PROJECTION_VERSION
  const timezoneMatches = textValue(state.account_timezone) === timezone
  const complete = isBackfillComplete(state.backfill_complete)
  const rangesComplete = isBackfillComplete(state.range_backfill_complete) &&
    textValue(state.range_status).toLowerCase() === 'ready'
  const sourceStatus = textValue(state.status).toLowerCase() || 'backfilling'
  const available = versionMatches && timezoneMatches && complete && rangesComplete && sourceStatus !== 'failed'
  const pending = available ? await hasPendingChanges(db, { signal }) : false
  const ready = available && !pending && sourceStatus === 'ready'

  if (schedule && !ready) scheduleTrackingAnalyticsProjectionBackfill()
  return {
    available,
    ready,
    status: !versionMatches || !timezoneMatches || !complete || !rangesComplete
      ? 'warming'
      : (pending || sourceStatus === 'replaying' ? 'catching_up' : (ready ? 'ready' : 'unavailable')),
    sourceStatus,
    version: TRACKING_ANALYTICS_PROJECTION_VERSION,
    timezone,
    pending,
    rangeStatus: textValue(state.range_status).toLowerCase() || 'pending',
    rangeCompileCursor: state.range_compile_cursor || null,
    rangesComplete,
    updatedAt: state.updated_at || null,
    lastAppliedAt: state.last_applied_at || null,
    lastError: state.last_error || null
  }
}

async function lockProjectionState(transaction) {
  return transaction.get(`
    SELECT
      singleton_id,
      projection_version,
      account_timezone,
      status,
      backfill_cursor,
      backfill_complete,
      range_status,
      range_compile_cursor,
      range_backfill_complete,
      last_applied_at,
      last_error,
      updated_at
    FROM tracking_analytics_projection_state
    WHERE singleton_id = ?
    ${databaseDialect === 'postgres' ? 'FOR UPDATE' : ''}
  `, [PROJECTION_STATE_ID])
}

async function ensureProjectionTimezone(timezone) {
  return db.transaction(async transaction => {
    const state = await lockProjectionState(transaction)
    if (!state) return null
    const matches = Number(state.projection_version) === TRACKING_ANALYTICS_PROJECTION_VERSION &&
      textValue(state.account_timezone) === timezone
    if (matches) return state

    await transaction.run('DELETE FROM tracking_analytics_returning_dirty_queue')
    await transaction.run('DELETE FROM tracking_analytics_returning_point')
    await transaction.run('DELETE FROM tracking_analytics_visitor_session_day')
    await transaction.run('DELETE FROM tracking_analytics_facet_identity_day')
    await transaction.run('DELETE FROM tracking_analytics_identity_day')
    await transaction.run('DELETE FROM tracking_analytics_facet_range_delta')
    await transaction.run('DELETE FROM tracking_analytics_facet_values')
    await transaction.run('DELETE FROM tracking_analytics_range_delta')
    await transaction.run('DELETE FROM tracking_analytics_daily_rollup')
    await transaction.run('DELETE FROM tracking_analytics_presence')
    await transaction.run('DELETE FROM tracking_analytics_event_fact')
    await transaction.run('DELETE FROM tracking_analytics_dimensions')
    await transaction.run(`
      UPDATE tracking_analytics_projection_state
      SET projection_version = ?,
          account_timezone = ?,
          status = 'backfilling',
          backfill_cursor = NULL,
          backfill_complete = ?,
          range_status = 'pending',
          range_compile_cursor = NULL,
          range_backfill_complete = ?,
          last_applied_at = NULL,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = ?
    `, [
      TRACKING_ANALYTICS_PROJECTION_VERSION,
      timezone,
      databaseDialect === 'postgres' ? false : 0,
      databaseDialect === 'postgres' ? false : 0,
      PROJECTION_STATE_ID
    ])
    return {
      ...state,
      projection_version: TRACKING_ANALYTICS_PROJECTION_VERSION,
      account_timezone: timezone,
      status: 'backfilling',
      backfill_cursor: null,
      backfill_complete: databaseDialect === 'postgres' ? false : 0,
      range_status: 'pending',
      range_compile_cursor: null,
      range_backfill_complete: databaseDialect === 'postgres' ? false : 0,
      last_error: null
    }
  })
}

async function runBackfillBatch(batchSize, timezone) {
  return db.transaction(async transaction => {
    const state = await lockProjectionState(transaction)
    if (!state) return { unavailable: true, processed: 0, complete: false }
    if (isBackfillComplete(state.backfill_complete)) return { processed: 0, complete: true }

    const cursor = textValue(state.backfill_cursor)
    const rows = await transaction.all(`
      SELECT ${SESSION_PROJECTION_COLUMNS.join(', ')}
      FROM sessions
      ${cursor ? `WHERE id > ${databaseDialect === 'postgres' ? '?::uuid' : '?'}` : ''}
      ORDER BY id ASC
      LIMIT ?
    `, cursor ? [cursor, batchSize] : [batchSize])

    if (!rows.length) {
      await transaction.run(`
        UPDATE tracking_analytics_projection_state
        SET status = 'backfilling',
            backfill_complete = ?,
            last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE singleton_id = ?
      `, [databaseDialect === 'postgres' ? true : 1, PROJECTION_STATE_ID])
      return { processed: 0, complete: true }
    }

    const ids = rows.map(row => textValue(row.id))
    const projected = await projectRows(transaction, rows, ids, timezone, { maintainRanges: false })
    const complete = rows.length < batchSize
    await transaction.run(`
      UPDATE tracking_analytics_projection_state
      SET status = ?,
          backfill_cursor = ?,
          backfill_complete = ?,
          last_applied_at = CURRENT_TIMESTAMP,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = ?
    `, [
      'backfilling',
      ids.at(-1),
      databaseDialect === 'postgres' ? complete : (complete ? 1 : 0),
      PROJECTION_STATE_ID
    ])
    return { ...projected, processed: rows.length, complete }
  })
}

async function runQueueBatch(batchSize, timezone) {
  return db.transaction(async transaction => {
    const state = await lockProjectionState(transaction)
    if (!state) return { unavailable: true, processed: 0, empty: true }
    if (!isBackfillComplete(state.backfill_complete)) return { processed: 0, empty: true, backfilling: true }
    if (!isBackfillComplete(state.range_backfill_complete) || state.range_status !== 'ready') {
      return { processed: 0, empty: true, compilingRanges: true }
    }

    // El lock singleton del estado ya serializa workers. No bloquear filas de
    // cola: el trigger debe poder incrementar revision mientras calculamos.
    // El DELETE compare-and-swap de abajo sólo confirma la revisión observada;
    // si cambió, queda durable para el siguiente lote.
    const queuedRows = await transaction.all(`
      SELECT session_row_id, revision
      FROM tracking_analytics_change_queue
      ORDER BY enqueued_at ASC, session_row_id ASC
      LIMIT ?
    `, [batchSize])

    if (!queuedRows.length) {
      return { processed: 0, empty: true }
    }

    const ids = queuedRows.map(row => textValue(row.session_row_id))
    const sourceRows = await readSourceRowsByIds(transaction, ids)
    const projected = await projectRows(transaction, sourceRows, ids, timezone)
    const revisionConditions = queuedRows.map(() => '(session_row_id = ? AND revision = ?)').join(' OR ')
    await transaction.run(`
      DELETE FROM tracking_analytics_change_queue
      WHERE ${revisionConditions}
    `, queuedRows.flatMap(row => [textValue(row.session_row_id), Number(row.revision)]))
    await transaction.run(`
      UPDATE tracking_analytics_projection_state
      SET status = 'replaying',
          last_applied_at = CURRENT_TIMESTAMP,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = ?
    `, [PROJECTION_STATE_ID])
    return { ...projected, processed: queuedRows.length, empty: false }
  })
}

async function runRangeCompilationBatch() {
  return db.transaction(async transaction => {
    const state = await lockProjectionState(transaction)
    if (!state) return { unavailable: true, complete: false, processedVisitors: 0 }
    if (!isBackfillComplete(state.backfill_complete)) {
      return { complete: false, processedVisitors: 0, backfilling: true }
    }
    return runTrackingAnalyticsRangeCompilationBatch(transaction)
  })
}

async function runReturningRepairBatch() {
  return db.transaction(async transaction => {
    const state = await lockProjectionState(transaction)
    if (!state) return { unavailable: true, processed: 0, empty: true }
    if (!isBackfillComplete(state.range_backfill_complete) || state.range_status !== 'ready') {
      return { processed: 0, empty: true, compilingRanges: true }
    }
    const sourcePending = await transaction.get('SELECT session_row_id FROM tracking_analytics_change_queue LIMIT 1')
    if (sourcePending) return { processed: 0, empty: false, sourcePending: true }
    return repairTrackingAnalyticsReturningVisitors(transaction)
  })
}

async function settleProjectionState() {
  return db.transaction(async transaction => {
    const state = await lockProjectionState(transaction)
    if (!state) return { unavailable: true, ready: false }
    const [sourcePending, returningPending] = await Promise.all([
      transaction.get('SELECT session_row_id FROM tracking_analytics_change_queue LIMIT 1'),
      transaction.get('SELECT visitor_key FROM tracking_analytics_returning_dirty_queue LIMIT 1')
    ])
    const rangesComplete = isBackfillComplete(state.range_backfill_complete) && state.range_status === 'ready'
    const ready = isBackfillComplete(state.backfill_complete) && rangesComplete && !sourcePending && !returningPending
    const nextStatus = ready ? 'ready' : (rangesComplete ? 'replaying' : 'backfilling')
    if (textValue(state.status).toLowerCase() !== nextStatus || state.last_error) {
      await transaction.run(`
        UPDATE tracking_analytics_projection_state
        SET status = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE singleton_id = ?
      `, [nextStatus, PROJECTION_STATE_ID])
    }
    return {
      ready,
      sourcePending: Boolean(sourcePending),
      returningPending: Boolean(returningPending)
    }
  })
}

async function persistProjectionFailure(error) {
  try {
    await db.run(`
      UPDATE tracking_analytics_projection_state
      SET status = 'failed',
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = ?
    `, [String(error?.message || error).slice(0, 2_000), PROJECTION_STATE_ID])
  } catch (stateError) {
    if (isMissingProjectionSchema(stateError)) return
    throw new AggregateError([error, stateError], 'Falló la proyección de Analíticas y su estado durable')
  }
}

async function garbageCollectOrphanDimensions(limit = DIMENSION_GC_BATCH_SIZE) {
  const boundedLimit = boundedInteger(limit, DIMENSION_GC_BATCH_SIZE, { max: DIMENSION_GC_MAX_PER_RUN })
  const result = databaseDialect === 'postgres'
    ? await db.run(`
        WITH garbage AS (
          SELECT dimensions.dimension_key
          FROM tracking_analytics_dimensions dimensions
          WHERE NOT EXISTS (
            SELECT 1
            FROM tracking_analytics_event_fact facts
            WHERE facts.dimension_key = dimensions.dimension_key
          )
            AND NOT EXISTS (
              SELECT 1
              FROM tracking_analytics_presence presence
              WHERE presence.dimension_key = dimensions.dimension_key
            )
          ORDER BY dimensions.dimension_key
          LIMIT ?
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM tracking_analytics_dimensions dimensions
        USING garbage
        WHERE dimensions.dimension_key = garbage.dimension_key
      `, [boundedLimit])
    : await db.run(`
        DELETE FROM tracking_analytics_dimensions
        WHERE dimension_key IN (
          SELECT dimensions.dimension_key
          FROM tracking_analytics_dimensions dimensions
          WHERE NOT EXISTS (
            SELECT 1
            FROM tracking_analytics_event_fact facts
            WHERE facts.dimension_key = dimensions.dimension_key
          )
            AND NOT EXISTS (
              SELECT 1
              FROM tracking_analytics_presence presence
              WHERE presence.dimension_key = dimensions.dimension_key
            )
          ORDER BY dimensions.dimension_key
          LIMIT ?
        )
      `, [boundedLimit])
  return Number(result?.changes || 0)
}

async function finalizeProjectionChanges(
  backfilled,
  replayed,
  { published = false, returningRepaired = 0 } = {}
) {
  // El histórico todavía no es visible y no debe tumbar el cache legacy por
  // cada lote. La revisión avanza una vez al publicar el grid o al aplicar una
  // mutación que sí puede cambiar una respuesta visible.
  if (published || replayed > 0 || returningRepaired > 0) invalidateTrackingAnalyticsCache()
  if (backfilled > 0 || replayed > 0 || returningRepaired > 0) {
    logger.info(
      `[Tracking] Read model de Analíticas: ${backfilled} histórico(s), ` +
      `${replayed} cambio(s), ${returningRepaired} identidad(es) reparada(s).`
    )
  }
  if (replayed <= 0) return 0
  try {
    // Una mutación puede dejar como máximo una dimensión vieja por fact. El
    // límite sigue siendo fijo, pero normalmente alcanza todo el lote replayed
    // y deja 250 lugares para basura de una corrida interrumpida anterior.
    return await garbageCollectOrphanDimensions(
      Math.min(DIMENSION_GC_MAX_PER_RUN, Math.max(DIMENSION_GC_BATCH_SIZE, replayed + DIMENSION_GC_BATCH_SIZE))
    )
  } catch (error) {
    // La recolección es mantenimiento acotado, no parte de la exactitud del
    // lote ya confirmado. Nunca convertirla en loader/fallback de requests.
    logger.warn(`[Tracking] No se pudieron limpiar dimensiones huérfanas: ${error.message}`)
    return 0
  }
}

export async function runTrackingAnalyticsProjectionBackfill({
  batchSize = databaseDialect === 'postgres' ? POSTGRES_BATCH_SIZE : SQLITE_BATCH_SIZE,
  queueBatchSize = QUEUE_BATCH_SIZE,
  maxBatches = MAX_BACKFILL_BATCHES_PER_RUN,
  maxQueueBatches = MAX_QUEUE_BATCHES_PER_RUN,
  maxRangeBatches = MAX_RANGE_BATCHES_PER_RUN,
  maxReturningRepairBatches = MAX_RETURNING_REPAIR_BATCHES_PER_RUN,
  yieldMs = DEFAULT_YIELD_MS
} = {}) {
  const normalizedBatchSize = boundedInteger(
    batchSize,
    databaseDialect === 'postgres' ? POSTGRES_BATCH_SIZE : SQLITE_BATCH_SIZE,
    { max: databaseDialect === 'postgres' ? POSTGRES_BATCH_SIZE : SQLITE_BATCH_SIZE }
  )
  const normalizedQueueBatchSize = boundedInteger(queueBatchSize, QUEUE_BATCH_SIZE, { max: QUEUE_BATCH_SIZE })
  const normalizedMaxBatches = boundedInteger(maxBatches, MAX_BACKFILL_BATCHES_PER_RUN, { max: 100 })
  const normalizedMaxQueueBatches = boundedInteger(maxQueueBatches, MAX_QUEUE_BATCHES_PER_RUN, { max: 100 })
  const normalizedMaxRangeBatches = boundedInteger(maxRangeBatches, MAX_RANGE_BATCHES_PER_RUN, { max: 100 })
  const normalizedMaxReturningRepairBatches = boundedInteger(
    maxReturningRepairBatches,
    MAX_RETURNING_REPAIR_BATCHES_PER_RUN,
    { max: 100 }
  )
  const timezone = resolveTimezone(await getAccountTimezone({ throwOnError: true }))
  const initializedState = await ensureProjectionTimezone(timezone)
  if (!initializedState) {
    return {
      available: false,
      ready: false,
      unavailable: true,
      version: TRACKING_ANALYTICS_PROJECTION_VERSION,
      timezone
    }
  }

  let backfilled = 0
  let replayed = 0
  let rangeCompiledVisitors = 0
  let returningRepaired = 0
  let published = false
  let backfillComplete = isBackfillComplete(initializedState.backfill_complete)
  for (let batch = 0; !backfillComplete && batch < normalizedMaxBatches; batch += 1) {
    const result = await runBackfillBatch(normalizedBatchSize, timezone)
    if (result.unavailable) {
      const garbageCollected = await finalizeProjectionChanges(backfilled, replayed)
      return { available: false, ready: false, unavailable: true, garbageCollected, version: TRACKING_ANALYTICS_PROJECTION_VERSION, timezone }
    }
    backfilled += Number(result.processed || 0)
    backfillComplete = Boolean(result.complete)
    if (!backfillComplete && batch + 1 < normalizedMaxBatches) await sleep(yieldMs)
  }

  if (!backfillComplete) {
    const garbageCollected = await finalizeProjectionChanges(backfilled, replayed)
    return {
      available: false,
      ready: false,
      paused: true,
      backfilled,
      replayed,
      garbageCollected,
      version: TRACKING_ANALYTICS_PROJECTION_VERSION,
      timezone
    }
  }

  let rangesComplete = isBackfillComplete(initializedState.range_backfill_complete) &&
    initializedState.range_status === 'ready'
  for (let batch = 0; !rangesComplete && batch < normalizedMaxRangeBatches; batch += 1) {
    const result = await runRangeCompilationBatch()
    if (result.unavailable) {
      const garbageCollected = await finalizeProjectionChanges(backfilled, replayed, { published })
      return { available: false, ready: false, unavailable: true, garbageCollected, version: TRACKING_ANALYTICS_PROJECTION_VERSION, timezone }
    }
    rangeCompiledVisitors += Number(result.processedVisitors || 0)
    rangesComplete = Boolean(result.complete)
    published = published || Boolean(result.published)
    if (!rangesComplete && batch + 1 < normalizedMaxRangeBatches) await sleep(yieldMs)
  }

  if (!rangesComplete) {
    const garbageCollected = await finalizeProjectionChanges(backfilled, replayed, { published })
    return {
      available: false,
      ready: false,
      paused: true,
      compilingRanges: true,
      backfilled,
      replayed,
      rangeCompiledVisitors,
      garbageCollected,
      version: TRACKING_ANALYTICS_PROJECTION_VERSION,
      timezone
    }
  }

  let queueEmpty = false
  for (let batch = 0; batch < normalizedMaxQueueBatches; batch += 1) {
    const result = await runQueueBatch(normalizedQueueBatchSize, timezone)
    if (result.unavailable) {
      const garbageCollected = await finalizeProjectionChanges(backfilled, replayed)
      return { available: false, ready: false, unavailable: true, garbageCollected, version: TRACKING_ANALYTICS_PROJECTION_VERSION, timezone }
    }
    replayed += Number(result.processed || 0)
    queueEmpty = Boolean(result.empty)
    if (queueEmpty) break
    if (batch + 1 < normalizedMaxQueueBatches) await sleep(yieldMs)
  }

  let returningEmpty = false
  if (queueEmpty) {
    for (let batch = 0; batch < normalizedMaxReturningRepairBatches; batch += 1) {
      const result = await runReturningRepairBatch()
      if (result.unavailable) {
        const garbageCollected = await finalizeProjectionChanges(backfilled, replayed, {
          published,
          returningRepaired
        })
        return { available: false, ready: false, unavailable: true, garbageCollected, version: TRACKING_ANALYTICS_PROJECTION_VERSION, timezone }
      }
      returningRepaired += Number(result.processed || 0)
      returningEmpty = Boolean(result.empty)
      if (returningEmpty) break
      if (batch + 1 < normalizedMaxReturningRepairBatches) await sleep(yieldMs)
    }
  }

  const settled = await settleProjectionState()
  const garbageCollected = await finalizeProjectionChanges(backfilled, replayed, {
    published,
    returningRepaired
  })
  return {
    available: true,
    ready: Boolean(settled.ready),
    paused: !settled.ready,
    backfilled,
    replayed,
    rangeCompiledVisitors,
    returningRepaired,
    sourcePending: Boolean(settled.sourcePending),
    returningPending: Boolean(settled.returningPending),
    garbageCollected,
    version: TRACKING_ANALYTICS_PROJECTION_VERSION,
    timezone
  }
}

function clearWorkerResume() {
  if (workerResumeTimer) clearTimeout(workerResumeTimer)
  workerResumeTimer = null
}

function scheduleWorkerResume(delayMs) {
  if (workerResumeTimer || isDeployShutdownStarted()) return false
  workerResumeTimer = setTimeout(() => {
    workerResumeTimer = null
    if (!isDeployShutdownStarted()) scheduleTrackingAnalyticsProjectionBackfill()
  }, Math.max(1, Number(delayMs) || 1))
  workerResumeTimer.unref?.()
  return true
}

/**
 * Agenda trabajo O(1) y devuelve de inmediato. El timer corto mantiene la cola
 * incremental al día sin meter agregaciones ni backfill dentro de /collect o
 * del request de Analíticas.
 */
export function scheduleTrackingAnalyticsProjectionBackfill() {
  if (isDeployShutdownStarted()) return { scheduled: false, ready: false, reason: 'shutting-down' }
  if (workerPromise || workerScheduled) return { scheduled: false, ready: false }

  const retryAfterMs = Math.max(0, workerEligibleAt - Date.now())
  if (retryAfterMs > 0) {
    scheduleWorkerResume(retryAfterMs)
    return { scheduled: false, ready: false, paused: true, retryAfterMs }
  }

  clearWorkerResume()
  const queued = scheduleProjectionBackfillJob({
    key: BACKFILL_JOB_KEY,
    priority: BACKFILL_JOB_PRIORITY.NORMAL,
    onError: error => {
      workerScheduled = false
      workerEligibleAt = Date.now() + ERROR_RETRY_MS
      scheduleWorkerResume(ERROR_RETRY_MS)
      logger.warn(`[Tracking] No se pudo iniciar el read model de Analíticas; se reintentará: ${error?.message || error}`)
    },
    run: () => {
      workerScheduled = false
      if (workerPromise) return workerPromise
      workerPromise = runTrackingAnalyticsProjectionBackfill()
        .then(result => {
          const delayMs = result?.unavailable
            ? ERROR_RETRY_MS
            : (result?.paused ? BACKFILL_PAUSE_MS : CONTINUOUS_POLL_MS)
          workerEligibleAt = Date.now() + delayMs
          scheduleWorkerResume(delayMs)
          return result
        })
        .catch(async error => {
          workerEligibleAt = Date.now() + ERROR_RETRY_MS
          scheduleWorkerResume(ERROR_RETRY_MS)
          await persistProjectionFailure(error)
          logger.warn(`[Tracking] Falló el read model incremental de Analíticas: ${error.message}`)
          return { available: false, ready: false, error: error.message }
        })
        .finally(() => {
          workerPromise = null
        })
      return workerPromise
    }
  })
  workerScheduled = Boolean(queued.scheduled)
  return { scheduled: Boolean(queued.scheduled), ready: false }
}

export function scheduleTrackingAnalyticsProjectionRefresh() {
  return scheduleTrackingAnalyticsProjectionBackfill()
}

export const TRACKING_ANALYTICS_PROJECTION_LIMITS = Object.freeze({
  postgresBatchSize: POSTGRES_BATCH_SIZE,
  sqliteBatchSize: SQLITE_BATCH_SIZE,
  queueBatchSize: QUEUE_BATCH_SIZE,
  maxBackfillBatchesPerRun: MAX_BACKFILL_BATCHES_PER_RUN,
  maxQueueBatchesPerRun: MAX_QUEUE_BATCHES_PER_RUN,
  maxRangeBatchesPerRun: MAX_RANGE_BATCHES_PER_RUN,
  maxReturningRepairBatchesPerRun: MAX_RETURNING_REPAIR_BATCHES_PER_RUN,
  continuousPollMs: CONTINUOUS_POLL_MS,
  pauseMs: BACKFILL_PAUSE_MS,
  maxIndexedDimensionBytes: MAX_INDEXED_DIMENSION_BYTES,
  dimensionGcBatchSize: DIMENSION_GC_BATCH_SIZE,
  dimensionGcMaxPerRun: DIMENSION_GC_MAX_PER_RUN,
  triggerWritesOnlyQueue: true,
  resumesWithoutTraffic: true
})
