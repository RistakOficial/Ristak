import { DateTime } from 'luxon'

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
import { getContactListProjectionStatus } from './crmListProjectionService.js'
import { invalidateTrackingAnalyticsCache } from './trackingAnalyticsCache.js'
import { getTrackingAnalyticsProjectionStatus } from './trackingAnalyticsProjectionService.js'

export const TRACKING_CONVERSION_PROJECTION_VERSION = 1

const PROJECTION_STATE_ID = 1
const BACKFILL_JOB_KEY = 'tracking-conversion-projection'
const POSTGRES_BATCH_SIZE = 500
const SQLITE_BATCH_SIZE = 150
const QUEUE_BATCH_SIZE = 500
const MAX_BACKFILL_BATCHES_PER_RUN = 4
const MAX_QUEUE_BATCHES_PER_RUN = 10
const DEFAULT_YIELD_MS = 25
const BACKFILL_PAUSE_MS = 100
const CONTINUOUS_POLL_MS = 2_000
const ERROR_RETRY_MS = 30_000
const SQLITE_PARAMETER_BUDGET = 900
const POSTGRES_PARAMETER_BUDGET = 20_000
const SUPPORTED_GROUPS = new Set(['day', 'month', 'year'])
const IGNORED_MESSAGE_FILTERS = new Set(['message_channel', 'message_source', 'status'])
const VIEW_FILTER_FIELDS = new Map([
  ['landing_url', 'page_value'],
  ['page_url', 'page_value'],
  ['utm_campaign', 'utm_campaign'],
  ['utm_medium', 'utm_medium'],
  ['utm_content', 'utm_content'],
  ['utm_source', 'traffic_source'],
  ['device_type', 'device_type'],
  ['browser', 'browser'],
  ['os', 'os'],
  ['placement', 'placement'],
  ['ad_platform', 'ad_platform'],
  ['campaign_id', 'campaign_id'],
  ['adset_id', 'adset_id'],
  ['ad_id', 'ad_id'],
  ['tracking_source', 'tracking_source'],
  ['channel', 'channel'],
  ['site_type', 'site_type'],
  ['site_id', 'site_id'],
  ['form_site_id', 'form_site_id'],
  ['native_conversion_source', 'native_conversion_source']
])
const FACT_COLUMNS = Object.freeze([
  'contact_id',
  'projection_version',
  'contact_created_at',
  'business_date',
  'stage',
  'registrations',
  'prospects',
  'appointments',
  'attendances',
  'customers',
  'purchases'
])
const METRIC_COLUMNS = Object.freeze([
  'registrations',
  'prospects',
  'appointments',
  'attendances',
  'customers',
  'purchases'
])

let workerPromise = null
let workerScheduled = false
let workerEligibleAt = 0
let workerResumeTimer = null

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))

function textValue(value, maxLength = 2_000) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function integerValue(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0
}

function boundedInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function parameterBudget() {
  return databaseDialect === 'postgres' ? POSTGRES_PARAMETER_BUDGET : SQLITE_PARAMETER_BUDGET
}

function chunks(rows, size) {
  const result = []
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size))
  return result
}

function hasFilterValues(values) {
  return (Array.isArray(values) ? values : [values])
    .some(value => textValue(value) !== '')
}

/**
 * La proyección de contactos no duplica dimensiones web. Campaña, dispositivo,
 * página, etc. se resuelven cruzando los facts 113 y 116; el core sale del
 * rollup diario. Ningún filtro soportado vuelve a contacts/sessions crudos.
 */
export function supportsTrackingConversionProjectionFilters(filters = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return true
  return Object.entries(filters).every(([field, values]) => (
    !hasFilterValues(values)
    || field === 'conversion_stage'
    || IGNORED_MESSAGE_FILTERS.has(field)
    || VIEW_FILTER_FIELDS.has(field)
  ))
}

function hasProjectedWebFilters(filters = {}) {
  return Object.entries(filters).some(([field, values]) => (
    VIEW_FILTER_FIELDS.has(field) && hasFilterValues(values)
  ))
}

function addWebFilterConditions(filters, params, alias = 'd') {
  const conditions = []
  for (const [field, rawValues] of Object.entries(filters || {})) {
    if (!VIEW_FILTER_FIELDS.has(field) || !hasFilterValues(rawValues)) continue
    const values = (Array.isArray(rawValues) ? rawValues : [rawValues]).map(value => textValue(value).toLowerCase())
    const column = VIEW_FILTER_FIELDS.get(field)
    const expression = field === 'site_type'
      ? `LOWER(COALESCE(NULLIF(${alias}.site_type, ''), 'unknown'))`
      : `LOWER(${alias}.${column})`
    params.push(...values)
    conditions.push(`${expression} IN (${values.map(() => '?').join(', ')})`)
  }
  return conditions
}

function normalizedConversionStages(filters) {
  const raw = filters && typeof filters === 'object' && !Array.isArray(filters)
    ? filters.conversion_stage
    : []
  return [...new Set((Array.isArray(raw) ? raw : [raw])
    .map(value => textValue(value))
    .filter(value => [
      'prospect',
      'appointment_scheduled',
      'appointment_attended',
      'customer'
    ].includes(value)))]
}

function isBackfillComplete(value) {
  return value === true || Number(value) === 1 || String(value).toLowerCase() === 'true'
}

function isMissingProjectionSchema(error) {
  const code = String(error?.code || '').toUpperCase()
  if (code === '42P01' || code === '42703' || code === '42883') return true
  if (code !== 'SQLITE_ERROR') return false
  return /no such (?:table|column):\s*tracking_conversion_/i.test(String(error?.message || ''))
}

function projectionWarmingError(status = {}) {
  const error = new Error('Las conversiones de Analíticas se están preparando en segundo plano. Reintenta en unos segundos.')
  error.status = 503
  error.code = 'tracking_conversion_projection_warming'
  error.retryAfter = 2
  error.projection = status
  return error
}

async function bulkInsert(transaction, table, columns, rows, conflictSql) {
  if (!rows.length) return
  const chunkSize = Math.max(1, Math.floor(parameterBudget() / columns.length))
  for (const batch of chunks(rows, chunkSize)) {
    const placeholders = batch.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ')
    await transaction.run(`
      INSERT INTO ${table} (${columns.join(', ')})
      VALUES ${placeholders}
      ${conflictSql}
    `, batch.flatMap(row => columns.map(column => row[column])))
  }
}

function sourceStage(row) {
  if (integerValue(row.purchases_count) > 0) return 'customer'
  if (integerValue(row.has_attendance) > 0) return 'appointment_attended'
  if (integerValue(row.has_appointment) > 0) return 'appointment_scheduled'
  return 'prospect'
}

function normalizeSourceFact(row, timezone) {
  if (!row || integerValue(row.eligible) !== 1) return null
  const createdAt = normalizeToUtcIso(row.created_at, 'UTC')
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) return null
  const stage = sourceStage(row)
  const purchases = integerValue(row.purchases_count)
  return {
    contact_id: textValue(row.contact_id),
    projection_version: TRACKING_CONVERSION_PROJECTION_VERSION,
    contact_created_at: createdAt,
    business_date: normalizeDateOnlyInTimezone(createdAt, timezone),
    stage,
    registrations: 1,
    prospects: stage === 'prospect' ? 1 : 0,
    appointments: integerValue(row.has_appointment) > 0 ? 1 : 0,
    attendances: integerValue(row.has_attendance) > 0 ? 1 : 0,
    customers: purchases > 0 ? 1 : 0,
    purchases
  }
}

function normalizeDatabaseFact(row) {
  if (!row) return null
  const businessDate = row.business_date instanceof Date
    ? normalizeDateOnlyInTimezone(normalizeToUtcIso(row.business_date, 'UTC'), 'UTC')
    : textValue(row.business_date, 10)
  return {
    ...Object.fromEntries(FACT_COLUMNS.map(column => [column, row[column]])),
    contact_id: textValue(row.contact_id),
    projection_version: Number(row.projection_version || 0),
    contact_created_at: normalizeToUtcIso(row.contact_created_at, 'UTC'),
    business_date: businessDate,
    stage: textValue(row.stage),
    ...Object.fromEntries(METRIC_COLUMNS.map(column => [column, integerValue(row[column])]))
  }
}

function factsEqual(left, right) {
  if (!left || !right) return false
  return FACT_COLUMNS.every(column => String(left[column] ?? '') === String(right[column] ?? ''))
}

function dailyDeltaKey(fact) {
  return `${fact.business_date}\u0000${fact.stage}`
}

function addDailyDelta(deltas, fact, multiplier) {
  if (!fact) return
  const key = dailyDeltaKey(fact)
  const row = deltas.get(key) || {
    business_date: fact.business_date,
    stage: fact.stage,
    ...Object.fromEntries(METRIC_COLUMNS.map(column => [column, 0]))
  }
  for (const column of METRIC_COLUMNS) row[column] += Number(fact[column] || 0) * multiplier
  deltas.set(key, row)
}

async function readSourceRowsByIds(transaction, ids) {
  const rows = []
  for (const batch of chunks(ids, parameterBudget())) {
    rows.push(...await transaction.all(`
      SELECT
        c.id AS contact_id,
        c.created_at,
        COALESCE(cla.purchases_count, 0) AS purchases_count,
        CASE WHEN (
          (c.visitor_id IS NOT NULL AND c.visitor_id != '')
          OR LOWER(COALESCE(c.source, '')) LIKE '%whatsapp%'
          OR EXISTS (SELECT 1 FROM whatsapp_api_messages wam WHERE wam.contact_id = c.id)
          OR EXISTS (SELECT 1 FROM whatsapp_api_attribution waa WHERE waa.contact_id = c.id)
          OR EXISTS (SELECT 1 FROM whatsapp_attribution wa WHERE wa.contact_id = c.id)
        ) THEN 1 ELSE 0 END AS eligible,
        CASE
          WHEN c.appointment_date IS NOT NULL THEN 1
          WHEN COALESCE(cla.active_appointments_count, 0) <= 0 THEN 0
          -- El ledger CRM histórico omitió únicamente el literal no-show
          -- de su lista inactiva. Se corrige sólo para contactos con actividad;
          -- los contactos sin cita no pagan ningún probe a appointments.
          WHEN COALESCE(cla.active_appointments_count, 0) > (
            SELECT COUNT(*)
            FROM appointments exceptional_no_show
            WHERE exceptional_no_show.contact_id = c.id
              AND LOWER(COALESCE(
                exceptional_no_show.appointment_status,
                exceptional_no_show.status,
                ''
              )) = 'no-show'
          ) THEN 1
          ELSE 0
        END AS has_appointment,
        CASE WHEN COALESCE(cla.attendance_signals_count, 0) > 0
          OR COALESCE(cla.attended_appointments_count, 0) > 0
          THEN 1 ELSE 0 END AS has_attendance
      FROM contacts c
      LEFT JOIN contact_list_activity cla ON cla.contact_id = c.id
      WHERE c.id IN (${batch.map(() => '?').join(', ')})
    `, batch))
  }
  return rows
}

async function readFactsByIds(transaction, ids) {
  const rows = []
  for (const batch of chunks(ids, parameterBudget())) {
    rows.push(...await transaction.all(`
      SELECT ${FACT_COLUMNS.join(', ')}
      FROM tracking_conversion_contact_fact
      WHERE contact_id IN (${batch.map(() => '?').join(', ')})
    `, batch))
  }
  return rows.map(normalizeDatabaseFact)
}

async function readQueueSnapshotsByIds(transaction, ids) {
  const rows = []
  for (const batch of chunks(ids, parameterBudget())) {
    rows.push(...await transaction.all(`
      SELECT contact_id, revision
      FROM tracking_conversion_change_queue
      WHERE contact_id IN (${batch.map(() => '?').join(', ')})
    `, batch))
  }
  return rows.map(row => ({ contact_id: textValue(row.contact_id), revision: Number(row.revision || 0) }))
}

async function deleteFactsByIds(transaction, ids) {
  for (const batch of chunks(ids, parameterBudget())) {
    await transaction.run(`
      DELETE FROM tracking_conversion_contact_fact
      WHERE contact_id IN (${batch.map(() => '?').join(', ')})
    `, batch)
  }
}

async function deleteAppliedQueueSnapshots(transaction, rows) {
  if (!rows.length) return
  const batchSize = Math.max(1, Math.floor(parameterBudget() / 2))
  for (const batch of chunks(rows, batchSize)) {
    await transaction.run(`
      DELETE FROM tracking_conversion_change_queue
      WHERE ${batch.map(() => '(contact_id = ? AND revision = ?)').join(' OR ')}
    `, batch.flatMap(row => [row.contact_id, row.revision]))
  }
}

function hasMetricDelta(row) {
  return METRIC_COLUMNS.some(column => Number(row[column] || 0) !== 0)
}

async function applyDailyDeltas(transaction, deltaRows) {
  const rows = deltaRows.filter(hasMetricDelta)
  const updateOnly = rows.filter(row => Number(row.registrations || 0) <= 0)
  const insertable = rows.filter(row => Number(row.registrations || 0) > 0)

  // Un delta con registrations <= 0 siempre parte de una fila certificada por
  // el fact anterior. UPDATE evita intentar insertar contribuciones negativas,
  // que los CHECK correctamente rechazarían antes del ON CONFLICT.
  for (const row of updateOnly) {
    const result = await transaction.run(`
      UPDATE tracking_conversion_daily_rollup
      SET registrations = registrations + ?,
          prospects = prospects + ?,
          appointments = appointments + ?,
          attendances = attendances + ?,
          customers = customers + ?,
          purchases = purchases + ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE business_date = ? AND stage = ?
    `, [
      ...METRIC_COLUMNS.map(column => row[column]),
      row.business_date,
      row.stage
    ])
    if (Number(result?.changes || 0) !== 1) {
      throw Object.assign(
        new Error(`No existe el rollup anterior de conversiones ${row.business_date}/${row.stage}`),
        { code: 'TRACKING_CONVERSION_ROLLUP_MISSING' }
      )
    }
  }

  await bulkInsert(
    transaction,
    'tracking_conversion_daily_rollup',
    ['business_date', 'stage', ...METRIC_COLUMNS],
    insertable,
    `ON CONFLICT(business_date, stage) DO UPDATE SET
      registrations = tracking_conversion_daily_rollup.registrations + excluded.registrations,
      prospects = tracking_conversion_daily_rollup.prospects + excluded.prospects,
      appointments = tracking_conversion_daily_rollup.appointments + excluded.appointments,
      attendances = tracking_conversion_daily_rollup.attendances + excluded.attendances,
      customers = tracking_conversion_daily_rollup.customers + excluded.customers,
      purchases = tracking_conversion_daily_rollup.purchases + excluded.purchases,
      updated_at = CURRENT_TIMESTAMP`
  )

  for (const batch of chunks(rows, Math.max(1, Math.floor(parameterBudget() / 2)))) {
    await transaction.run(`
      DELETE FROM tracking_conversion_daily_rollup
      WHERE registrations = 0
        AND (${batch.map(() => '(business_date = ? AND stage = ?)').join(' OR ')})
    `, batch.flatMap(row => [row.business_date, row.stage]))
  }
}

async function projectContactIds(transaction, ids, timezone, suppliedQueueRows = null) {
  const normalizedIds = [...new Set(ids.map(id => textValue(id)).filter(Boolean))]
  if (!normalizedIds.length) return { requested: 0, changed: 0 }

  // Snapshot de revisión ANTES de leer fuentes. Una mutación posterior sube la
  // revisión y el CAS no la borra; una mutación anterior ya será visible para
  // el SELECT fuente que sigue bajo READ COMMITTED.
  const queueRows = suppliedQueueRows || await readQueueSnapshotsByIds(transaction, normalizedIds)
  const [sourceRows, oldFacts] = await Promise.all([
    readSourceRowsByIds(transaction, normalizedIds),
    readFactsByIds(transaction, normalizedIds)
  ])
  const sourceById = new Map(sourceRows.map(row => [textValue(row.contact_id), row]))
  const oldById = new Map(oldFacts.map(fact => [fact.contact_id, fact]))
  const changedFacts = []
  const deletedFactIds = []
  const deltas = new Map()

  for (const contactId of normalizedIds) {
    const oldFact = oldById.get(contactId) || null
    const nextFact = normalizeSourceFact(sourceById.get(contactId), timezone)
    if (factsEqual(oldFact, nextFact)) continue
    addDailyDelta(deltas, oldFact, -1)
    addDailyDelta(deltas, nextFact, 1)
    if (nextFact) changedFacts.push(nextFact)
    else if (oldFact) deletedFactIds.push(contactId)
  }

  await applyDailyDeltas(transaction, [...deltas.values()])
  await bulkInsert(
    transaction,
    'tracking_conversion_contact_fact',
    FACT_COLUMNS,
    changedFacts,
    `ON CONFLICT(contact_id) DO UPDATE SET
      projection_version = excluded.projection_version,
      contact_created_at = excluded.contact_created_at,
      business_date = excluded.business_date,
      stage = excluded.stage,
      registrations = excluded.registrations,
      prospects = excluded.prospects,
      appointments = excluded.appointments,
      attendances = excluded.attendances,
      customers = excluded.customers,
      purchases = excluded.purchases,
      updated_at = CURRENT_TIMESTAMP`
  )
  await deleteFactsByIds(transaction, deletedFactIds)
  await deleteAppliedQueueSnapshots(transaction, queueRows)
  return { requested: normalizedIds.length, changed: changedFacts.length + deletedFactIds.length }
}

export async function readTrackingConversionProjectionState(database = db, { signal } = {}) {
  try {
    return await database.get(`
      SELECT singleton_id, projection_version, account_timezone, status,
        backfill_cursor, backfill_complete, processed_count, last_applied_at,
        last_error, updated_at
      FROM tracking_conversion_projection_state
      WHERE singleton_id = ?
    `, [PROJECTION_STATE_ID], { signal })
  } catch (error) {
    if (isMissingProjectionSchema(error)) return null
    throw error
  }
}

async function hasPendingChanges(database = db, { signal } = {}) {
  const row = await database.get('SELECT contact_id FROM tracking_conversion_change_queue LIMIT 1', [], { signal })
  return Boolean(row)
}

export async function getTrackingConversionProjectionStatus({ schedule = false, signal } = {}) {
  const state = await readTrackingConversionProjectionState(db, { signal })
  if (!state) {
    if (schedule) scheduleTrackingConversionProjectionBackfill()
    return {
      available: false,
      ready: false,
      status: 'unavailable',
      sourceStatus: 'missing',
      version: TRACKING_CONVERSION_PROJECTION_VERSION,
      timezone: null,
      pending: false,
      lastError: null
    }
  }

  const timezone = resolveTimezone(await getAccountTimezone({ signal }))
  const versionMatches = Number(state.projection_version) === TRACKING_CONVERSION_PROJECTION_VERSION
  const timezoneMatches = textValue(state.account_timezone) === timezone
  const complete = isBackfillComplete(state.backfill_complete)
  const sourceStatus = textValue(state.status).toLowerCase() || 'backfilling'
  const available = versionMatches && timezoneMatches && complete && sourceStatus !== 'failed'
  const pending = available ? await hasPendingChanges(db, { signal }) : false
  const ready = available && !pending && sourceStatus === 'ready'
  if (schedule && !ready) scheduleTrackingConversionProjectionBackfill()

  return {
    available,
    ready,
    status: !versionMatches || !timezoneMatches || !complete
      ? 'warming'
      : (pending || sourceStatus === 'replaying' ? 'catching_up' : (ready ? 'ready' : 'unavailable')),
    sourceStatus,
    version: TRACKING_CONVERSION_PROJECTION_VERSION,
    timezone,
    pending,
    processedCount: integerValue(state.processed_count),
    updatedAt: state.updated_at || null,
    lastAppliedAt: state.last_applied_at || null,
    lastError: state.last_error || null
  }
}

async function lockProjectionState(transaction) {
  return transaction.get(`
    SELECT singleton_id, projection_version, account_timezone, status,
      backfill_cursor, backfill_complete, processed_count, last_applied_at,
      last_error, updated_at
    FROM tracking_conversion_projection_state
    WHERE singleton_id = ?
    ${databaseDialect === 'postgres' ? 'FOR UPDATE' : ''}
  `, [PROJECTION_STATE_ID])
}

async function ensureProjectionTimezone(timezone) {
  return db.transaction(async transaction => {
    const state = await lockProjectionState(transaction)
    if (!state) return null
    const matches = Number(state.projection_version) === TRACKING_CONVERSION_PROJECTION_VERSION &&
      textValue(state.account_timezone) === timezone
    if (matches) return state

    await transaction.run('DELETE FROM tracking_conversion_daily_rollup')
    await transaction.run('DELETE FROM tracking_conversion_contact_fact')
    await transaction.run(`
      UPDATE tracking_conversion_projection_state
      SET projection_version = ?, account_timezone = ?, status = 'backfilling',
          backfill_cursor = NULL, backfill_complete = ?, processed_count = 0,
          last_applied_at = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = ?
    `, [
      TRACKING_CONVERSION_PROJECTION_VERSION,
      timezone,
      databaseDialect === 'postgres' ? false : 0,
      PROJECTION_STATE_ID
    ])
    return {
      ...state,
      projection_version: TRACKING_CONVERSION_PROJECTION_VERSION,
      account_timezone: timezone,
      status: 'backfilling',
      backfill_cursor: null,
      backfill_complete: databaseDialect === 'postgres' ? false : 0,
      processed_count: 0,
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
      SELECT id
      FROM contacts
      ${cursor ? 'WHERE id > ?' : ''}
      ORDER BY id ASC
      LIMIT ?
    `, cursor ? [cursor, batchSize] : [batchSize])

    if (!rows.length) {
      await transaction.run(`
        UPDATE tracking_conversion_projection_state
        SET status = 'replaying', backfill_complete = ?, last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE singleton_id = ?
      `, [databaseDialect === 'postgres' ? true : 1, PROJECTION_STATE_ID])
      return { processed: 0, complete: true }
    }

    const ids = rows.map(row => textValue(row.id))
    const projected = await projectContactIds(transaction, ids, timezone)
    const complete = rows.length < batchSize
    await transaction.run(`
      UPDATE tracking_conversion_projection_state
      SET status = ?, backfill_cursor = ?, backfill_complete = ?,
          processed_count = processed_count + ?, last_applied_at = CURRENT_TIMESTAMP,
          last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = ?
    `, [
      complete ? 'replaying' : 'backfilling',
      ids.at(-1),
      databaseDialect === 'postgres' ? complete : (complete ? 1 : 0),
      rows.length,
      PROJECTION_STATE_ID
    ])
    return { ...projected, processed: rows.length, complete }
  })
}

async function runQueueBatch(batchSize, timezone) {
  return db.transaction(async transaction => {
    const state = await lockProjectionState(transaction)
    if (!state) return { unavailable: true, processed: 0, empty: true }
    if (!isBackfillComplete(state.backfill_complete)) {
      return { processed: 0, empty: true, backfilling: true }
    }

    const queuedRows = (await transaction.all(`
      SELECT contact_id, revision
      FROM tracking_conversion_change_queue
      ORDER BY enqueued_at ASC, contact_id ASC
      LIMIT ?
    `, [batchSize])).map(row => ({
      contact_id: textValue(row.contact_id),
      revision: Number(row.revision || 0)
    }))

    if (!queuedRows.length) {
      if (textValue(state.status).toLowerCase() !== 'ready' || state.last_error) {
        await transaction.run(`
          UPDATE tracking_conversion_projection_state
          SET status = 'ready', last_error = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE singleton_id = ?
        `, [PROJECTION_STATE_ID])
      }
      return { processed: 0, empty: true, ready: true }
    }

    const projected = await projectContactIds(
      transaction,
      queuedRows.map(row => row.contact_id),
      timezone,
      queuedRows
    )
    await transaction.run(`
      UPDATE tracking_conversion_projection_state
      SET status = 'replaying', last_applied_at = CURRENT_TIMESTAMP,
          last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = ?
    `, [PROJECTION_STATE_ID])
    return { ...projected, processed: queuedRows.length, empty: false }
  })
}

async function persistProjectionFailure(error) {
  try {
    await db.run(`
      UPDATE tracking_conversion_projection_state
      SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = ?
    `, [String(error?.message || error).slice(0, 2_000), PROJECTION_STATE_ID])
  } catch (stateError) {
    if (isMissingProjectionSchema(stateError)) return
    throw new AggregateError([error, stateError], 'Falló la proyección incremental de conversiones')
  }
}

function finalizeProjectionChanges(backfilled, replayed, { published = false } = {}) {
  if (backfilled <= 0 && replayed <= 0 && !published) return
  // El builder del primer rollout corre mientras la ruta legacy sigue viva.
  // Invalidar su cache por cada lote histórico la obligaría a recalcular el SQL
  // pesado una y otra vez. Sólo una mutación ya publicada o el corte final
  // cambia lo que un reader puede observar.
  if (replayed > 0 || published) invalidateTrackingAnalyticsCache()
  logger.info(`[Tracking] Conversiones proyectadas: ${backfilled} histórico(s), ${replayed} cambio(s) incremental(es).`)
}

export async function runTrackingConversionProjectionBackfill({
  batchSize = databaseDialect === 'postgres' ? POSTGRES_BATCH_SIZE : SQLITE_BATCH_SIZE,
  queueBatchSize = QUEUE_BATCH_SIZE,
  maxBatches = MAX_BACKFILL_BATCHES_PER_RUN,
  maxQueueBatches = MAX_QUEUE_BATCHES_PER_RUN,
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
  const timezone = resolveTimezone(await getAccountTimezone({ throwOnError: true }))
  const state = await ensureProjectionTimezone(timezone)
  if (!state) return { available: false, ready: false, unavailable: true, timezone }

  // El fact de conversiones consume la fila angosta CRM. Esperar su garantía
  // durable no recorre contactos y evita publicar un backfill sobre actividad
  // parcial. Su propio scheduler ya quedó solicitado por este status.
  const contactProjection = await getContactListProjectionStatus({ schedule: true })
  if (!contactProjection.ready) {
    return {
      available: false,
      ready: false,
      paused: true,
      dependency: 'contact_list_activity',
      timezone
    }
  }

  let backfilled = 0
  let replayed = 0
  const startedWithCompleteBackfill = isBackfillComplete(state.backfill_complete)
  let backfillComplete = startedWithCompleteBackfill
  for (let batch = 0; !backfillComplete && batch < normalizedMaxBatches; batch += 1) {
    const result = await runBackfillBatch(normalizedBatchSize, timezone)
    if (result.unavailable) return { available: false, ready: false, unavailable: true, timezone }
    backfilled += Number(result.processed || 0)
    backfillComplete = Boolean(result.complete)
    if (!backfillComplete && batch + 1 < normalizedMaxBatches) await sleep(yieldMs)
  }

  if (!backfillComplete) {
    finalizeProjectionChanges(backfilled, replayed)
    return { available: false, ready: false, paused: true, backfilled, replayed, timezone }
  }

  let queueEmpty = false
  for (let batch = 0; batch < normalizedMaxQueueBatches; batch += 1) {
    const result = await runQueueBatch(normalizedQueueBatchSize, timezone)
    if (result.unavailable) return { available: false, ready: false, unavailable: true, timezone }
    replayed += Number(result.processed || 0)
    queueEmpty = Boolean(result.empty)
    if (queueEmpty) break
    if (batch + 1 < normalizedMaxQueueBatches) await sleep(yieldMs)
  }

  finalizeProjectionChanges(backfilled, replayed, {
    published: !startedWithCompleteBackfill && backfillComplete && queueEmpty
  })
  return {
    available: true,
    ready: queueEmpty,
    paused: !queueEmpty,
    backfilled,
    replayed,
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
    if (!isDeployShutdownStarted()) scheduleTrackingConversionProjectionBackfill()
  }, Math.max(1, Number(delayMs) || 1))
  workerResumeTimer.unref?.()
  return true
}

export function scheduleTrackingConversionProjectionBackfill() {
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
      logger.warn(`[Tracking] No se pudo iniciar la proyección de conversiones: ${error?.message || error}`)
    },
    run: () => {
      workerScheduled = false
      if (workerPromise) return workerPromise
      workerPromise = runTrackingConversionProjectionBackfill()
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
          logger.warn(`[Tracking] Falló la proyección incremental de conversiones: ${error.message}`)
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

export function scheduleTrackingConversionProjectionRefresh() {
  return scheduleTrackingConversionProjectionBackfill()
}

function assertRange(range, label) {
  if (!range?.startUtc || !range?.endExclusiveUtc || !(range.timezone || range.appliedTimezone)) {
    throw new TypeError(`${label} debe incluir startUtc, endExclusiveUtc y timezone`)
  }
}

function rangeDateBounds(range) {
  const timezone = resolveTimezone(range.timezone || range.appliedTimezone)
  const startDate = range.startDate || normalizeDateOnlyInTimezone(range.startUtc, timezone)
  const exclusive = DateTime.fromISO(String(range.endExclusiveUtc), { zone: 'utc' }).setZone(timezone)
  const endDate = range.endDate || (exclusive.isValid
    ? exclusive.minus({ milliseconds: 1 }).toISODate()
    : normalizeDateOnlyInTimezone(range.endExclusiveUtc, timezone))
  return { startDate, endDate, timezone }
}

function emptyMetrics() {
  return { registrations: 0, prospects: 0, appointments: 0, attendances: 0, customers: 0, purchases: 0 }
}

function emptyStageCounts() {
  return { appointmentScheduled: 0, appointmentAttended: 0 }
}

function seriesPeriod(date, groupBy) {
  if (groupBy === 'year') return date.slice(0, 4)
  if (groupBy === 'month') return date.slice(0, 7)
  return date
}

function parseScope(rows, scope, groupBy, { includeSeries }) {
  const scopedRows = rows.filter(row => row.period_scope === scope)
  const metrics = emptyMetrics()
  const stageCounts = emptyStageCounts()
  const seriesByPeriod = new Map()

  for (const row of scopedRows) {
    for (const column of METRIC_COLUMNS) metrics[column] += integerValue(row[column])
    if (row.stage === 'appointment_scheduled') stageCounts.appointmentScheduled += integerValue(row.registrations)
    if (row.stage === 'appointment_attended') stageCounts.appointmentAttended += integerValue(row.registrations)
    if (!includeSeries) continue
    const period = seriesPeriod(textValue(row.business_date, 10), groupBy)
    const seriesRow = seriesByPeriod.get(period) || { period, ...emptyMetrics() }
    for (const column of METRIC_COLUMNS) seriesRow[column] += integerValue(row[column])
    seriesByPeriod.set(period, seriesRow)
  }

  return {
    metrics,
    series: includeSeries
      ? [...seriesByPeriod.values()].sort((left, right) => left.period.localeCompare(right.period))
      : [],
    stageCounts
  }
}

function unsupportedFilterError(filters) {
  const error = new Error(`La proyección de conversiones no reconoce estos filtros: ${Object.keys(filters || {}).join(', ')}`)
  error.status = 400
  error.code = 'tracking_conversion_projection_filter_unsupported'
  return error
}

async function queryDailyRollupRows(current, previous, stages, { signal }) {
  const datePlaceholder = databaseDialect === 'postgres' ? '?::date' : '?'
  const stageCondition = stages.length
    ? `AND stage IN (${stages.map(() => '?').join(', ')})`
    : ''
  return db.all(`
    SELECT 'current' AS period_scope, CAST(business_date AS TEXT) AS business_date,
      stage, registrations, prospects, appointments, attendances, customers, purchases
    FROM tracking_conversion_daily_rollup
    WHERE business_date >= ${datePlaceholder} AND business_date <= ${datePlaceholder}
      ${stageCondition}
    UNION ALL
    SELECT 'previous' AS period_scope, CAST(business_date AS TEXT) AS business_date,
      stage, registrations, prospects, appointments, attendances, customers, purchases
    FROM tracking_conversion_daily_rollup
    WHERE business_date >= ${datePlaceholder} AND business_date <= ${datePlaceholder}
      ${stageCondition}
    ORDER BY period_scope ASC, business_date ASC, stage ASC
  `, [
    current.startDate,
    current.endDate,
    ...stages,
    previous.startDate,
    previous.endDate,
    ...stages
  ], { signal })
}

async function queryFilteredFactRows(current, previous, filters, stages, { signal }) {
  const datePlaceholder = databaseDialect === 'postgres' ? '?::date' : '?'
  const materialized = databaseDialect === 'postgres' ? 'AS MATERIALIZED' : 'AS'
  const currentFilterParams = []
  const previousFilterParams = []
  const currentConditions = addWebFilterConditions(filters, currentFilterParams)
  const previousConditions = addWebFilterConditions(filters, previousFilterParams)
  const stageCondition = stages.length
    ? `AND cf.stage IN (${stages.map(() => '?').join(', ')})`
    : ''

  // `event_fact` es el read model exacto de sessions y conserva started_at. La
  // comparación con contact_created_at mantiene la semántica legacy incluso
  // cuando el contacto nació a media jornada; presence por fecha sola no puede.
  return db.all(`
    WITH
    current_candidates ${materialized} (
      SELECT DISTINCT event_fact.contact_key
      FROM tracking_analytics_event_fact event_fact
      INNER JOIN tracking_analytics_dimensions d
        ON d.dimension_key = event_fact.dimension_key
      INNER JOIN tracking_conversion_contact_fact candidate_fact
        ON candidate_fact.contact_id = event_fact.contact_key
      WHERE event_fact.business_date >= ${datePlaceholder}
        AND event_fact.business_date <= ${datePlaceholder}
        AND event_fact.contact_key != ''
        AND event_fact.event_count > 0
        AND event_fact.started_at >= candidate_fact.contact_created_at
        ${currentConditions.length ? `AND ${currentConditions.join(' AND ')}` : ''}
    ),
    previous_candidates ${materialized} (
      SELECT DISTINCT event_fact.contact_key
      FROM tracking_analytics_event_fact event_fact
      INNER JOIN tracking_analytics_dimensions d
        ON d.dimension_key = event_fact.dimension_key
      INNER JOIN tracking_conversion_contact_fact candidate_fact
        ON candidate_fact.contact_id = event_fact.contact_key
      WHERE event_fact.business_date >= ${datePlaceholder}
        AND event_fact.business_date <= ${datePlaceholder}
        AND event_fact.contact_key != ''
        AND event_fact.event_count > 0
        AND event_fact.started_at >= candidate_fact.contact_created_at
        ${previousConditions.length ? `AND ${previousConditions.join(' AND ')}` : ''}
    )
    SELECT 'current' AS period_scope, CAST(cf.business_date AS TEXT) AS business_date,
      cf.stage, cf.registrations, cf.prospects, cf.appointments, cf.attendances,
      cf.customers, cf.purchases
    FROM tracking_conversion_contact_fact cf
    INNER JOIN current_candidates candidates ON candidates.contact_key = cf.contact_id
    WHERE cf.business_date >= ${datePlaceholder} AND cf.business_date <= ${datePlaceholder}
      ${stageCondition}
    UNION ALL
    SELECT 'previous' AS period_scope, CAST(cf.business_date AS TEXT) AS business_date,
      cf.stage, cf.registrations, cf.prospects, cf.appointments, cf.attendances,
      cf.customers, cf.purchases
    FROM tracking_conversion_contact_fact cf
    INNER JOIN previous_candidates candidates ON candidates.contact_key = cf.contact_id
    WHERE cf.business_date >= ${datePlaceholder} AND cf.business_date <= ${datePlaceholder}
      ${stageCondition}
    ORDER BY period_scope ASC, business_date ASC, stage ASC
  `, [
    current.startDate,
    current.endDate,
    ...currentFilterParams,
    previous.startDate,
    previous.endDate,
    ...previousFilterParams,
    current.startDate,
    current.endDate,
    ...stages,
    previous.startDate,
    previous.endDate,
    ...stages
  ], { signal })
}

/**
 * Current + previous + serie salen de una tabla de máximo cuatro filas por día.
 * Los filtros web salen de los facts 113+116; missing/warming o un filtro no
 * representado fallan explícitamente y nunca reactivan el CTE O(contacts).
 */
export async function queryTrackingConversionProjection({
  currentRange,
  previousRange,
  filters = {},
  groupBy = 'day',
  signal
} = {}) {
  signal?.throwIfAborted?.()
  assertRange(currentRange, 'currentRange')
  assertRange(previousRange, 'previousRange')
  if (!supportsTrackingConversionProjectionFilters(filters)) throw unsupportedFilterError(filters)

  const status = await getTrackingConversionProjectionStatus({ schedule: true, signal })
  signal?.throwIfAborted?.()
  if (!status.available) throw projectionWarmingError(status)

  const current = rangeDateBounds(currentRange)
  const previous = rangeDateBounds(previousRange)
  const stages = normalizedConversionStages(filters)
  const filtered = hasProjectedWebFilters(filters)
  if (filtered) {
    const sessionProjection = await getTrackingAnalyticsProjectionStatus({ schedule: true, signal })
    if (!sessionProjection.available) throw projectionWarmingError({ conversion: status, sessions: sessionProjection })
  }
  const rows = filtered
    ? await queryFilteredFactRows(current, previous, filters, stages, { signal })
    : await queryDailyRollupRows(current, previous, stages, { signal })

  const appliedGroupBy = SUPPORTED_GROUPS.has(groupBy) ? groupBy : 'day'
  return {
    current: parseScope(rows, 'current', appliedGroupBy, { includeSeries: true }),
    previous: parseScope(rows, 'previous', appliedGroupBy, { includeSeries: false }),
    readPath: filtered
      ? 'tracking_conversion_contact_fact_filtered'
      : 'tracking_conversion_daily_rollup',
    projection: status
  }
}

export const TRACKING_CONVERSION_PROJECTION_LIMITS = Object.freeze({
  postgresBatchSize: POSTGRES_BATCH_SIZE,
  sqliteBatchSize: SQLITE_BATCH_SIZE,
  queueBatchSize: QUEUE_BATCH_SIZE,
  maxBackfillBatchesPerRun: MAX_BACKFILL_BATCHES_PER_RUN,
  maxQueueBatchesPerRun: MAX_QUEUE_BATCHES_PER_RUN,
  continuousPollMs: CONTINUOUS_POLL_MS,
  triggerWritesOnlyQueue: true,
  coreQueryReadsDailyRollupOnly: true,
  filteredQueryReadsProjectionFactsOnly: true,
  resumesWithoutTraffic: true
})
