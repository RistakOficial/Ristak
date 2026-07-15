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
import { buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js'
import { logger } from '../utils/logger.js'
import { loadResolvedContactSources } from './contactSourceService.js'
import { scheduleCrmListProjectionBackfill } from './crmListProjectionService.js'

export const CONTACT_ORIGIN_PROJECTION_VERSION = 1

const STATE_ID = 1
const BACKFILL_JOB_KEY = 'contact-origin-projection'
const RANGE_ORIGIN = '0001-01-01'
const CONTACT_BATCH_SIZE = databaseDialect === 'postgres' ? 500 : 150
const APPOINTMENT_BATCH_SIZE = databaseDialect === 'postgres' ? 750 : 200
const QUEUE_BATCH_SIZE = databaseDialect === 'postgres' ? 500 : 150
const BULK_WRITE_SIZE = databaseDialect === 'postgres' ? 250 : 75
const GC_BATCH_SIZE = 1_000
const MAX_QUEUE_BATCHES = 6
const MAX_BACKFILL_BATCHES = 2
const QUERY_DEADLINE_MS = 8_000
const MAX_HIDDEN_CONTACT_IDS = 10_000
const HIDDEN_QUERY_BATCH_SIZE = databaseDialect === 'postgres' ? 5_000 : 750
const CONTINUOUS_POLL_MS = 2_000
const BACKFILL_PAUSE_MS = 100
const ERROR_RETRY_MS = 30_000
const GC_POLL_MS = 30_000

export const CONTACT_ORIGIN_PROJECTION_LIMITS = Object.freeze({
  contactBatchSize: CONTACT_BATCH_SIZE,
  appointmentBatchSize: APPOINTMENT_BATCH_SIZE,
  queueBatchSize: QUEUE_BATCH_SIZE,
  maxHiddenContactIds: MAX_HIDDEN_CONTACT_IDS,
  queryDeadlineMs: QUERY_DEADLINE_MS
})

let workerPromise = null
let workerScheduled = false
let workerEligibleAt = 0
let resumeTimer = null
let lastGcAttemptAt = 0

function text(value) {
  return String(value ?? '').trim()
}

function booleanValue(value) {
  return value === true || Number(value) === 1 || String(value).toLowerCase() === 'true'
}

function dbBoolean(value) {
  return databaseDialect === 'postgres' ? Boolean(value) : (value ? 1 : 0)
}

function boundedInteger(value, fallback, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(max, Math.trunc(parsed)))
}

function placeholders(values) {
  return values.map(() => '?').join(', ')
}

function chunks(values, size = BULK_WRITE_SIZE) {
  const result = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

function uniqueIds(values) {
  return [...new Set((values || []).map(text).filter(Boolean))]
}

function dateOnlyValue(value) {
  if (value instanceof Date) {
    return normalizeDateOnlyInTimezone(normalizeToUtcIso(value, 'UTC'), 'UTC')
  }
  return text(value).slice(0, 10)
}

function safeBusinessDate(value, timezone) {
  if (value === null || value === undefined || value === '') return null
  const normalizedUtc = normalizeToUtcIso(value, 'UTC')
  if (!normalizedUtc || !Number.isFinite(Date.parse(normalizedUtc))) return null
  return normalizeDateOnlyInTimezone(normalizedUtc, timezone)
}

function nextBusinessDate(value) {
  return DateTime.fromISO(dateOnlyValue(value), { zone: 'UTC' }).plus({ days: 1 }).toISODate()
}

function isMissingProjectionSchema(error) {
  const code = text(error?.code).toUpperCase()
  if (['42P01', '42703', '42883'].includes(code)) return true
  return code === 'SQLITE_ERROR' && /no such (?:table|column):\s*contact_origin_/i.test(text(error?.message))
}

function projectionWarmingError(status) {
  const error = new Error('La distribución de origen sigue preparando su read model incremental.')
  error.code = 'contact_origin_projection_warming'
  error.status = 422
  error.retryable = true
  error.projectionStatus = status?.status || 'warming'
  return error
}

function projectionTimeoutError(cause) {
  const error = new Error('La consulta proyectada de origen excedió su límite de ejecución.')
  error.code = 'contact_origin_projection_timeout'
  error.status = 503
  error.retryable = true
  error.cause = cause
  return error
}

async function withQueryDeadline(signal, operation) {
  const timeoutSignal = AbortSignal.timeout(QUERY_DEADLINE_MS)
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  try {
    return await operation(combinedSignal)
  } catch (error) {
    if (timeoutSignal.aborted && !signal?.aborted) throw projectionTimeoutError(error)
    throw error
  }
}

async function lockState(database) {
  return database.get(`
    SELECT *
    FROM contact_origin_projection_state
    WHERE singleton_id = ?
    ${databaseDialect === 'postgres' ? 'FOR UPDATE' : ''}
  `, [STATE_ID])
}

export async function readContactOriginProjectionState(database = db, { signal } = {}) {
  try {
    return await database.get(`
      SELECT * FROM contact_origin_projection_state WHERE singleton_id = ?
    `, [STATE_ID], { signal })
  } catch (error) {
    if (isMissingProjectionSchema(error)) return null
    throw error
  }
}

async function readStatusFromDatabase(database, desiredTimezone, {
  signal,
  schedule = false,
  lock = false
} = {}) {
  let state
  try {
    state = await database.get(`
      SELECT *
      FROM contact_origin_projection_state
      WHERE singleton_id = ?
      ${lock && databaseDialect === 'postgres' ? 'FOR SHARE' : ''}
    `, [STATE_ID], { signal })
  } catch (error) {
    if (isMissingProjectionSchema(error)) state = null
    else throw error
  }
  if (!state) {
    return {
      schemaAvailable: false,
      available: false,
      ready: false,
      status: 'unavailable',
      activeGeneration: null,
      timezone: desiredTimezone
    }
  }

  const activeGeneration = Number(state.active_generation || 0) || null
  const activeMatches = Boolean(activeGeneration) &&
    Number(state.active_version) === CONTACT_ORIGIN_PROJECTION_VERSION &&
    text(state.active_timezone) === desiredTimezone
  const marker = activeMatches
    ? await database.get(`
        SELECT status FROM contact_origin_range_generation WHERE generation = ?
      `, [activeGeneration], { signal })
    : null
  const rangeReady = text(marker?.status).toLowerCase() === 'ready'
  const available = activeMatches && rangeReady
  const queues = available
    ? await database.get(`
        SELECT
          EXISTS(SELECT 1 FROM contact_origin_contact_queue LIMIT 1) AS contact_pending,
          EXISTS(SELECT 1 FROM contact_origin_identity_queue LIMIT 1) AS identity_pending,
          EXISTS(SELECT 1 FROM contact_origin_appointment_queue LIMIT 1) AS appointment_pending
      `, [], { signal })
    : null
  const pending = booleanValue(queues?.contact_pending) ||
    booleanValue(queues?.identity_pending) ||
    booleanValue(queues?.appointment_pending)
  const sourceStatus = text(state.status).toLowerCase() || 'backfilling'
  const ready = available && !pending && sourceStatus !== 'failed'
  if (schedule && (!ready || state.building_generation)) {
    scheduleContactOriginProjectionBackfill()
  }
  return {
    schemaAvailable: true,
    available,
    ready,
    status: ready
      ? (state.building_generation ? 'rebuilding' : 'ready')
      : (sourceStatus === 'failed' ? 'unavailable' : (available ? 'catching_up' : 'warming')),
    sourceStatus,
    activeGeneration,
    activeTimezone: state.active_timezone || null,
    buildingGeneration: Number(state.building_generation || 0) || null,
    rangeReady,
    pending,
    timezone: desiredTimezone,
    lastError: state.last_error || null
  }
}

export async function getContactOriginProjectionStatus({ range = null, signal, schedule = false } = {}) {
  const timezone = resolveTimezone(range?.appliedTimezone || await getAccountTimezone({ signal }))
  return readStatusFromDatabase(db, timezone, { signal, schedule })
}

async function withPinnedGeneration(range, signal, operation) {
  const timezone = resolveTimezone(range?.appliedTimezone || await getAccountTimezone({ signal }))
  if (databaseDialect !== 'postgres') {
    const status = await readStatusFromDatabase(db, timezone, { signal, schedule: true })
    return operation(db, status)
  }
  return db.transaction(async transaction => {
    await transaction.run('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await transaction.run(`SET LOCAL statement_timeout = '${QUERY_DEADLINE_MS}ms'`)
    const status = await readStatusFromDatabase(transaction, timezone, {
      signal,
      schedule: true,
      lock: true
    })
    return operation(transaction, status)
  })
}

async function areContactDependenciesReady(database) {
  try {
    const rows = await database.all(`
      SELECT projection_key, status
      FROM crm_list_projection_state
      WHERE projection_key IN ('contact_rows', 'contact_payments')
    `)
    const states = new Map(rows.map(row => [text(row.projection_key), text(row.status).toLowerCase()]))
    const ready = states.get('contact_rows') === 'ready' && states.get('contact_payments') === 'ready'
    if (!ready) scheduleCrmListProjectionBackfill()
    return ready
  } catch (error) {
    if (['42P01', '42703'].includes(text(error?.code).toUpperCase()) ||
      (text(error?.code).toUpperCase() === 'SQLITE_ERROR' && /no such table:\s*crm_list_projection_state/i.test(text(error?.message)))) {
      return false
    }
    throw error
  }
}

async function enqueueGenerationGc(database, generation, { immediate = false } = {}) {
  if (!generation) return
  const eligibleExpression = immediate
    ? 'CURRENT_TIMESTAMP'
    : (databaseDialect === 'postgres'
        ? `CURRENT_TIMESTAMP + INTERVAL '5 minutes'`
        : `DATETIME(CURRENT_TIMESTAMP, '+300 seconds')`)
  await database.run(`
    INSERT INTO contact_origin_generation_gc(generation, eligible_at, enqueued_at)
    VALUES (?, ${eligibleExpression}, CURRENT_TIMESTAMP)
    ON CONFLICT(generation) DO UPDATE SET
      eligible_at = CASE
        WHEN excluded.eligible_at < contact_origin_generation_gc.eligible_at
          THEN excluded.eligible_at
        ELSE contact_origin_generation_gc.eligible_at
      END
  `, [generation])
}

async function nextGeneration(database, state) {
  if (databaseDialect === 'postgres') {
    const row = await database.get(`SELECT nextval('contact_origin_generation_seq') AS generation`)
    return Number(row?.generation)
  }
  return Math.max(
    Number(state?.active_generation || 0),
    Number(state?.building_generation || 0)
  ) + 1
}

async function ensureBuildingGeneration(database, timezone) {
  const current = await readContactOriginProjectionState(database)
  const activeCurrent = Number(current?.active_generation || 0) > 0 &&
    Number(current?.active_version) === CONTACT_ORIGIN_PROJECTION_VERSION &&
    text(current?.active_timezone) === timezone
  if (activeCurrent && !current?.building_generation) return current

  return database.transaction(async transaction => {
    const state = await lockState(transaction)
    if (!state) return null
    const activeCurrentLocked = Number(state.active_generation || 0) > 0 &&
      Number(state.active_version) === CONTACT_ORIGIN_PROJECTION_VERSION &&
      text(state.active_timezone) === timezone
    if (activeCurrentLocked && !state.building_generation) return state
    const buildingCurrent = Number(state.building_generation || 0) > 0 &&
      Number(state.building_version) === CONTACT_ORIGIN_PROJECTION_VERSION &&
      text(state.building_timezone) === timezone
    if (buildingCurrent) return state

    if (Number(state.building_generation || 0)) {
      await enqueueGenerationGc(transaction, Number(state.building_generation), { immediate: true })
    }
    const generation = await nextGeneration(transaction, state)
    await transaction.run(`
      INSERT INTO contact_origin_range_generation(generation, status, built_at, updated_at)
      VALUES (?, 'building', NULL, CURRENT_TIMESTAMP)
      ON CONFLICT(generation) DO UPDATE SET
        status = 'building', built_at = NULL, updated_at = CURRENT_TIMESTAMP
    `, [generation])
    await transaction.run(`
      UPDATE contact_origin_projection_state
      SET projection_version = ?, status = 'backfilling',
          building_generation = ?, building_version = ?, building_timezone = ?,
          contact_cursor = '', appointment_cursor = '',
          contacts_complete = ?, appointments_complete = ?, range_compiled = ?,
          processed_contacts = 0, processed_appointments = 0,
          last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = ?
    `, [
      CONTACT_ORIGIN_PROJECTION_VERSION,
      generation,
      CONTACT_ORIGIN_PROJECTION_VERSION,
      timezone,
      dbBoolean(false), dbBoolean(false), dbBoolean(false),
      STATE_ID
    ])
    return {
      ...state,
      status: 'backfilling',
      building_generation: generation,
      building_version: CONTACT_ORIGIN_PROJECTION_VERSION,
      building_timezone: timezone,
      contact_cursor: '',
      appointment_cursor: '',
      contacts_complete: dbBoolean(false),
      appointments_complete: dbBoolean(false),
      range_compiled: dbBoolean(false)
    }
  })
}

function targetGenerations(state) {
  const targets = []
  const active = Number(state?.active_generation || 0)
  if (active && Number(state.active_version) === CONTACT_ORIGIN_PROJECTION_VERSION) {
    targets.push({ generation: active, timezone: resolveTimezone(state.active_timezone) })
  }
  const building = Number(state?.building_generation || 0)
  if (building && Number(state.building_version) === CONTACT_ORIGIN_PROJECTION_VERSION) {
    targets.push({ generation: building, timezone: resolveTimezone(state.building_timezone) })
  }
  return targets
}

async function loadCurrentContacts(database, ids) {
  if (!ids.length) return new Map()
  const resolved = await loadResolvedContactSources(ids, { database })
  const activity = await database.all(`
    SELECT contact_id, first_payment_date
    FROM contact_list_activity
    WHERE contact_id IN (${placeholders(ids)})
  `, ids)
  const paymentByContact = new Map(activity.map(row => [text(row.contact_id), row.first_payment_date]))
  return new Map([...resolved.entries()].map(([id, entry]) => [text(id), {
    ...entry,
    firstPaymentDate: paymentByContact.get(text(id)) || null
  }]))
}

function normalizeContactFact(entry, generation, timezone) {
  if (!entry?.contact) return null
  return {
    generation,
    contact_id: text(entry.contact.id),
    projection_version: CONTACT_ORIGIN_PROJECTION_VERSION,
    resolved_source: text(entry.source) || 'Desconocido',
    lead_business_date: safeBusinessDate(entry.contact.created_at, timezone) || RANGE_ORIGIN,
    first_payment_business_date: safeBusinessDate(entry.firstPaymentDate, timezone)
  }
}

function normalizeStoredContactFact(row) {
  if (!row) return null
  return {
    generation: Number(row.generation),
    contact_id: text(row.contact_id),
    projection_version: Number(row.projection_version),
    resolved_source: text(row.resolved_source),
    lead_business_date: dateOnlyValue(row.lead_business_date),
    first_payment_business_date: row.first_payment_business_date
      ? dateOnlyValue(row.first_payment_business_date)
      : null
  }
}

function contactFactsEqual(left, right) {
  if (!left || !right) return false
  return ['generation', 'contact_id', 'projection_version', 'resolved_source',
    'lead_business_date', 'first_payment_business_date']
    .every(column => String(left[column] ?? '') === String(right[column] ?? ''))
}

function addDailyDelta(target, fact, direction) {
  if (!fact || !direction) return
  const add = (metricKind, businessDate) => {
    if (!businessDate || businessDate === RANGE_ORIGIN) return
    const key = [fact.generation, metricKind, businessDate, fact.resolved_source].join('\u0000')
    const current = target.get(key) || {
      generation: fact.generation,
      metric_kind: metricKind,
      business_date: businessDate,
      resolved_source: fact.resolved_source,
      delta: 0
    }
    current.delta += direction
    target.set(key, current)
  }
  add('leads', fact.lead_business_date)
  add('conversions', fact.first_payment_business_date)
}

async function applyDailyDeltas(database, deltaMap) {
  for (const row of deltaMap.values()) {
    if (!row.delta) continue
    const params = [row.generation, row.metric_kind, row.business_date, row.resolved_source]
    if (row.delta < 0) {
      const result = await database.run(`
        UPDATE contact_origin_daily_rollup
        SET contact_count = contact_count + ?, updated_at = CURRENT_TIMESTAMP
        WHERE generation = ? AND metric_kind = ? AND business_date = ? AND resolved_source = ?
          AND contact_count >= ?
      `, [row.delta, ...params, Math.abs(row.delta)])
      if (Number(result?.changes || 0) !== 1) {
        throw Object.assign(new Error('El rollup diario de origen perdió una contribución existente.'), {
          code: 'CONTACT_ORIGIN_DAILY_INVARIANT'
        })
      }
      await database.run(`
        DELETE FROM contact_origin_daily_rollup
        WHERE generation = ? AND metric_kind = ? AND business_date = ? AND resolved_source = ?
          AND contact_count = 0
      `, params)
      continue
    }
    await database.run(`
      INSERT INTO contact_origin_daily_rollup(
        generation, metric_kind, business_date, resolved_source, contact_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(generation, metric_kind, business_date, resolved_source) DO UPDATE SET
        contact_count = contact_origin_daily_rollup.contact_count + excluded.contact_count,
        updated_at = CURRENT_TIMESTAMP
    `, [...params, row.delta])
  }
}

async function writeContactFacts(database, facts) {
  for (const batch of chunks(facts)) {
    const valuesSql = batch.map(() => '(?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').join(', ')
    await database.run(`
      INSERT INTO contact_origin_contact_fact(
        generation, contact_id, projection_version, resolved_source,
        lead_business_date, first_payment_business_date, updated_at
      ) VALUES ${valuesSql}
      ON CONFLICT(generation, contact_id) DO UPDATE SET
        projection_version = excluded.projection_version,
        resolved_source = excluded.resolved_source,
        lead_business_date = excluded.lead_business_date,
        first_payment_business_date = excluded.first_payment_business_date,
        updated_at = CURRENT_TIMESTAMP
    `, batch.flatMap(row => [
      row.generation, row.contact_id, row.projection_version, row.resolved_source,
      row.lead_business_date, row.first_payment_business_date
    ]))
  }
}

async function deleteContactFacts(database, generation, ids) {
  for (const batch of chunks(ids)) {
    await database.run(`
      DELETE FROM contact_origin_contact_fact
      WHERE generation = ? AND contact_id IN (${placeholders(batch)})
    `, [generation, ...batch])
  }
}

async function isRangeGenerationReady(database, generation) {
  if (!generation) return false
  const row = await database.get(`
    SELECT status FROM contact_origin_range_generation WHERE generation = ?
  `, [generation])
  return text(row?.status).toLowerCase() === 'ready'
}

function rangePointKey(row) {
  return [row.generation, row.contact_id, row.resolved_source,
    dateOnlyValue(row.start_boundary), dateOnlyValue(row.occurrence_date)].join('\u0000')
}

function aggregateRangeKey(row) {
  return [row.generation, row.resolved_source,
    dateOnlyValue(row.start_boundary), dateOnlyValue(row.occurrence_date)].join('\u0000')
}

function buildContactRangePoints(generation, rows) {
  const grouped = new Map()
  for (const row of rows || []) {
    const contactId = text(row.contact_id)
    const source = text(row.resolved_source) || 'Desconocido'
    const businessDate = dateOnlyValue(row.business_date)
    if (!contactId || !businessDate) continue
    const key = `${contactId}\u0000${source}`
    if (!grouped.has(key)) grouped.set(key, { contactId, source, dates: [] })
    const dates = grouped.get(key).dates
    if (dates.at(-1) !== businessDate) dates.push(businessDate)
  }
  const points = new Map()
  for (const { contactId, source, dates } of grouped.values()) {
    let previousDate = null
    for (const occurrenceDate of dates) {
      const startBoundary = previousDate ? nextBusinessDate(previousDate) : RANGE_ORIGIN
      const add = {
        generation,
        contact_id: contactId,
        resolved_source: source,
        start_boundary: startBoundary,
        occurrence_date: occurrenceDate,
        range_delta: 1
      }
      const remove = {
        ...add,
        start_boundary: nextBusinessDate(occurrenceDate),
        range_delta: -1
      }
      points.set(rangePointKey(add), add)
      points.set(rangePointKey(remove), remove)
      previousDate = occurrenceDate
    }
  }
  return points
}

function addAggregateRangeDelta(target, row, direction) {
  const key = aggregateRangeKey(row)
  const current = target.get(key) || {
    generation: Number(row.generation),
    resolved_source: text(row.resolved_source),
    start_boundary: dateOnlyValue(row.start_boundary),
    occurrence_date: dateOnlyValue(row.occurrence_date),
    delta: 0
  }
  current.delta += direction * Number(row.range_delta || 0)
  target.set(key, current)
}

async function applyAggregateRangeDeltas(database, deltaMap) {
  for (const row of deltaMap.values()) {
    if (!row.delta) continue
    const keyParams = [row.generation, row.resolved_source, row.start_boundary, row.occurrence_date]
    // A diferencia del conteo diario, un punto de rango puede ser negativo de
    // forma legítima: representa el cierre de una presencia. Por eso un delta
    // negativo nuevo se inserta, no se interpreta como corrupción.
    await database.run(`
      INSERT INTO contact_origin_appointment_range_delta(
        generation, resolved_source, start_boundary, occurrence_date, range_delta, updated_at
      ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(generation, resolved_source, start_boundary, occurrence_date) DO UPDATE SET
        range_delta = contact_origin_appointment_range_delta.range_delta + excluded.range_delta,
        updated_at = CURRENT_TIMESTAMP
    `, [...keyParams, row.delta])
    await database.run(`
      DELETE FROM contact_origin_appointment_range_delta
      WHERE generation = ? AND resolved_source = ?
        AND start_boundary = ? AND occurrence_date = ? AND range_delta = 0
    `, keyParams)
  }
}

async function rebuildContactRangePoints(database, generation, contactIds) {
  const ids = uniqueIds(contactIds)
  if (!generation || !ids.length || !await isRangeGenerationReady(database, generation)) return 0
  const oldRows = await database.all(`
    SELECT generation, contact_id, resolved_source, start_boundary, occurrence_date, range_delta
    FROM contact_origin_appointment_range_point
    WHERE generation = ? AND contact_id IN (${placeholders(ids)})
  `, [generation, ...ids])
  const occurrenceRows = await database.all(`
    SELECT appointments.contact_id, contacts.resolved_source, appointments.business_date
    FROM contact_origin_appointment_fact appointments
    INNER JOIN contact_origin_contact_fact contacts
      ON contacts.generation = appointments.generation
     AND contacts.contact_id = appointments.contact_id
    WHERE appointments.generation = ?
      AND appointments.contact_id IN (${placeholders(ids)})
    GROUP BY appointments.contact_id, contacts.resolved_source, appointments.business_date
    ORDER BY appointments.contact_id ASC, appointments.business_date ASC
  `, [generation, ...ids])
  const nextPoints = buildContactRangePoints(generation, occurrenceRows)
  const deltas = new Map()
  for (const oldRow of oldRows) addAggregateRangeDelta(deltas, oldRow, -1)
  for (const nextRow of nextPoints.values()) addAggregateRangeDelta(deltas, nextRow, 1)

  for (const batch of chunks(ids)) {
    await database.run(`
      DELETE FROM contact_origin_appointment_range_point
      WHERE generation = ? AND contact_id IN (${placeholders(batch)})
    `, [generation, ...batch])
  }
  for (const batch of chunks([...nextPoints.values()])) {
    const valuesSql = batch.map(() => '(?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').join(', ')
    await database.run(`
      INSERT INTO contact_origin_appointment_range_point(
        generation, contact_id, resolved_source, start_boundary,
        occurrence_date, range_delta, updated_at
      ) VALUES ${valuesSql}
    `, batch.flatMap(row => [
      row.generation, row.contact_id, row.resolved_source,
      row.start_boundary, row.occurrence_date, row.range_delta
    ]))
  }
  await applyAggregateRangeDeltas(database, deltas)
  return ids.length
}

async function projectContactsForGeneration(database, target, ids, currentContacts) {
  const generation = Number(target.generation)
  if (!generation || !ids.length) return { projected: 0, changed: 0 }
  const oldRows = await database.all(`
    SELECT generation, contact_id, projection_version, resolved_source,
      lead_business_date, first_payment_business_date
    FROM contact_origin_contact_fact
    WHERE generation = ? AND contact_id IN (${placeholders(ids)})
  `, [generation, ...ids])
  const oldById = new Map(oldRows.map(row => [text(row.contact_id), normalizeStoredContactFact(row)]))
  const changes = []
  for (const id of ids) {
    const oldFact = oldById.get(id) || null
    const nextFact = currentContacts.has(id)
      ? normalizeContactFact(currentContacts.get(id), generation, target.timezone)
      : null
    if (contactFactsEqual(oldFact, nextFact)) continue
    changes.push({ id, oldFact, nextFact })
  }
  if (!changes.length) return { projected: ids.length, changed: 0 }

  const dailyDeltas = new Map()
  for (const change of changes) {
    addDailyDelta(dailyDeltas, change.oldFact, -1)
    addDailyDelta(dailyDeltas, change.nextFact, 1)
  }
  await writeContactFacts(database, changes.map(change => change.nextFact).filter(Boolean))
  await deleteContactFacts(database, generation, changes
    .filter(change => change.oldFact && !change.nextFact)
    .map(change => change.id))
  await applyDailyDeltas(database, dailyDeltas)
  await rebuildContactRangePoints(database, generation, changes.map(change => change.id))
  return { projected: ids.length, changed: changes.length }
}

async function projectContactIds(database, state, contactIds) {
  const ids = uniqueIds(contactIds)
  if (!ids.length) return { projected: 0, changed: 0 }
  const currentContacts = await loadCurrentContacts(database, ids)
  let changed = 0
  for (const target of targetGenerations(state)) {
    const result = await projectContactsForGeneration(database, target, ids, currentContacts)
    changed += result.changed
  }
  return { projected: ids.length, changed }
}

function normalizeAppointmentFact(row, generation, timezone) {
  const appointmentId = text(row?.id)
  const contactId = text(row?.contact_id)
  const businessDate = safeBusinessDate(row?.date_added, timezone)
  if (!appointmentId || !contactId || !businessDate) return null
  return {
    generation,
    appointment_id: appointmentId,
    contact_id: contactId,
    business_date: businessDate,
    calendar_id: text(row.calendar_id)
  }
}

function normalizeStoredAppointmentFact(row) {
  if (!row) return null
  return {
    generation: Number(row.generation),
    appointment_id: text(row.appointment_id),
    contact_id: text(row.contact_id),
    business_date: dateOnlyValue(row.business_date),
    calendar_id: text(row.calendar_id)
  }
}

function appointmentFactsEqual(left, right) {
  if (!left || !right) return false
  return ['generation', 'appointment_id', 'contact_id', 'business_date', 'calendar_id']
    .every(column => String(left[column] ?? '') === String(right[column] ?? ''))
}

async function writeAppointmentFacts(database, facts) {
  for (const batch of chunks(facts)) {
    const valuesSql = batch.map(() => '(?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').join(', ')
    await database.run(`
      INSERT INTO contact_origin_appointment_fact(
        generation, appointment_id, contact_id, business_date, calendar_id, updated_at
      ) VALUES ${valuesSql}
      ON CONFLICT(generation, appointment_id) DO UPDATE SET
        contact_id = excluded.contact_id,
        business_date = excluded.business_date,
        calendar_id = excluded.calendar_id,
        updated_at = CURRENT_TIMESTAMP
    `, batch.flatMap(row => [
      row.generation, row.appointment_id, row.contact_id, row.business_date, row.calendar_id
    ]))
  }
}

async function deleteAppointmentFacts(database, generation, ids) {
  for (const batch of chunks(ids)) {
    await database.run(`
      DELETE FROM contact_origin_appointment_fact
      WHERE generation = ? AND appointment_id IN (${placeholders(batch)})
    `, [generation, ...batch])
  }
}

async function projectAppointmentsForGeneration(database, target, ids, currentById) {
  const generation = Number(target.generation)
  if (!generation || !ids.length) return { projected: 0, changed: 0 }
  const oldRows = await database.all(`
    SELECT generation, appointment_id, contact_id, business_date, calendar_id
    FROM contact_origin_appointment_fact
    WHERE generation = ? AND appointment_id IN (${placeholders(ids)})
  `, [generation, ...ids])
  const oldById = new Map(oldRows.map(row => [text(row.appointment_id), normalizeStoredAppointmentFact(row)]))
  const changes = []
  for (const id of ids) {
    const oldFact = oldById.get(id) || null
    const nextFact = currentById.has(id)
      ? normalizeAppointmentFact(currentById.get(id), generation, target.timezone)
      : null
    if (appointmentFactsEqual(oldFact, nextFact)) continue
    changes.push({ id, oldFact, nextFact })
  }
  if (!changes.length) return { projected: ids.length, changed: 0 }

  await writeAppointmentFacts(database, changes.map(change => change.nextFact).filter(Boolean))
  await deleteAppointmentFacts(database, generation, changes
    .filter(change => change.oldFact && !change.nextFact)
    .map(change => change.id))
  await rebuildContactRangePoints(database, generation, changes.flatMap(change => [
    change.oldFact?.contact_id,
    change.nextFact?.contact_id
  ]))
  return { projected: ids.length, changed: changes.length }
}

async function projectAppointmentIds(database, state, appointmentIds) {
  const ids = uniqueIds(appointmentIds)
  if (!ids.length) return { projected: 0, changed: 0 }
  const rows = await database.all(`
    SELECT id, contact_id, date_added, calendar_id
    FROM appointments
    WHERE id IN (${placeholders(ids)})
  `, ids)
  const currentById = new Map(rows.map(row => [text(row.id), row]))
  let changed = 0
  for (const target of targetGenerations(state)) {
    const result = await projectAppointmentsForGeneration(database, target, ids, currentById)
    changed += result.changed
  }
  return { projected: ids.length, changed }
}

async function processContactQueueBatch(database, batchSize = QUEUE_BATCH_SIZE) {
  return database.transaction(async transaction => {
    const rows = await transaction.all(`
      SELECT contact_id, revision
      FROM contact_origin_contact_queue
      ORDER BY enqueued_at ASC, contact_id ASC
      LIMIT ?
    `, [batchSize])
    if (!rows.length) return { processed: 0, empty: true }
    const state = await readContactOriginProjectionState(transaction)
    await projectContactIds(transaction, state, rows.map(row => row.contact_id))
    const conditions = rows.map(() => '(contact_id = ? AND revision = ?)').join(' OR ')
    await transaction.run(`DELETE FROM contact_origin_contact_queue WHERE ${conditions}`,
      rows.flatMap(row => [row.contact_id, row.revision]))
    return { processed: rows.length, empty: false }
  })
}

async function contactsForIdentityRows(database, rows) {
  const ids = uniqueIds(rows.filter(row => row.identity_kind === 'contact').map(row => row.identity_value))
  const visitors = uniqueIds(rows.filter(row => row.identity_kind === 'visitor').map(row => row.identity_value))
  const emails = uniqueIds(rows.filter(row => row.identity_kind === 'email').map(row => text(row.identity_value).toLowerCase()))
  const contactIds = new Set(ids)
  if (visitors.length) {
    const matches = await database.all(`
      SELECT id FROM contacts WHERE visitor_id IN (${placeholders(visitors)})
    `, visitors)
    matches.forEach(row => contactIds.add(text(row.id)))
  }
  if (emails.length) {
    const matches = await database.all(`
      SELECT id FROM contacts WHERE LOWER(email) IN (${placeholders(emails)})
    `, emails)
    matches.forEach(row => contactIds.add(text(row.id)))
  }
  return [...contactIds].filter(Boolean)
}

async function processIdentityQueueBatch(database, batchSize = QUEUE_BATCH_SIZE) {
  return database.transaction(async transaction => {
    const rows = await transaction.all(`
      SELECT identity_kind, identity_value, revision
      FROM contact_origin_identity_queue
      ORDER BY enqueued_at ASC, identity_kind ASC, identity_value ASC
      LIMIT ?
    `, [batchSize])
    if (!rows.length) return { processed: 0, empty: true }
    const state = await readContactOriginProjectionState(transaction)
    const contactIds = await contactsForIdentityRows(transaction, rows)
    await projectContactIds(transaction, state, contactIds)
    const conditions = rows
      .map(() => '(identity_kind = ? AND identity_value = ? AND revision = ?)')
      .join(' OR ')
    await transaction.run(`DELETE FROM contact_origin_identity_queue WHERE ${conditions}`,
      rows.flatMap(row => [row.identity_kind, row.identity_value, row.revision]))
    return { processed: rows.length, contacts: contactIds.length, empty: false }
  })
}

async function processAppointmentQueueBatch(database, batchSize = QUEUE_BATCH_SIZE) {
  return database.transaction(async transaction => {
    const rows = await transaction.all(`
      SELECT appointment_id, revision
      FROM contact_origin_appointment_queue
      ORDER BY enqueued_at ASC, appointment_id ASC
      LIMIT ?
    `, [batchSize])
    if (!rows.length) return { processed: 0, empty: true }
    const state = await readContactOriginProjectionState(transaction)
    await projectAppointmentIds(transaction, state, rows.map(row => row.appointment_id))
    const conditions = rows.map(() => '(appointment_id = ? AND revision = ?)').join(' OR ')
    await transaction.run(`DELETE FROM contact_origin_appointment_queue WHERE ${conditions}`,
      rows.flatMap(row => [row.appointment_id, row.revision]))
    return { processed: rows.length, empty: false }
  })
}

async function processQueueWave(database, maxBatches, options = {}) {
  let contacts = 0
  let identities = 0
  let appointments = 0
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const contactResult = await processContactQueueBatch(database, options.queueBatchSize)
    contacts += contactResult.processed
    const identityResult = await processIdentityQueueBatch(database, options.queueBatchSize)
    identities += identityResult.processed
    const appointmentResult = await processAppointmentQueueBatch(database, options.queueBatchSize)
    appointments += appointmentResult.processed
    if (contactResult.empty && identityResult.empty && appointmentResult.empty) break
  }
  return { contacts, identities, appointments, total: contacts + identities + appointments }
}

async function processContactBackfillBatch(database, batchSize) {
  return database.transaction(async transaction => {
    const state = await lockState(transaction)
    const generation = Number(state?.building_generation || 0)
    if (!generation || booleanValue(state.contacts_complete)) return { processed: 0, complete: true }
    const rows = await transaction.all(`
      SELECT id
      FROM contacts
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `, [state.contact_cursor || '', batchSize])
    if (rows.length) {
      const ids = rows.map(row => text(row.id))
      const current = await loadCurrentContacts(transaction, ids)
      await projectContactsForGeneration(transaction, {
        generation,
        timezone: resolveTimezone(state.building_timezone)
      }, ids, current)
    }
    const complete = rows.length < batchSize
    await transaction.run(`
      UPDATE contact_origin_projection_state
      SET contact_cursor = ?, contacts_complete = ?,
          processed_contacts = processed_contacts + ?, updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = ? AND building_generation = ?
    `, [
      rows.at(-1)?.id || state.contact_cursor || '',
      dbBoolean(complete), rows.length, STATE_ID, generation
    ])
    return { processed: rows.length, complete }
  })
}

async function processAppointmentBackfillBatch(database, batchSize) {
  return database.transaction(async transaction => {
    const state = await lockState(transaction)
    const generation = Number(state?.building_generation || 0)
    if (!generation || booleanValue(state.appointments_complete)) return { processed: 0, complete: true }
    const rows = await transaction.all(`
      SELECT id, contact_id, date_added, calendar_id
      FROM appointments
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `, [state.appointment_cursor || '', batchSize])
    if (rows.length) {
      const ids = rows.map(row => text(row.id))
      const current = new Map(rows.map(row => [text(row.id), row]))
      await projectAppointmentsForGeneration(transaction, {
        generation,
        timezone: resolveTimezone(state.building_timezone)
      }, ids, current)
    }
    const complete = rows.length < batchSize
    await transaction.run(`
      UPDATE contact_origin_projection_state
      SET appointment_cursor = ?, appointments_complete = ?,
          processed_appointments = processed_appointments + ?, updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = ? AND building_generation = ?
    `, [
      rows.at(-1)?.id || state.appointment_cursor || '',
      dbBoolean(complete), rows.length, STATE_ID, generation
    ])
    return { processed: rows.length, complete }
  })
}

async function queuesPending(database) {
  const row = await database.get(`
    SELECT
      EXISTS(SELECT 1 FROM contact_origin_contact_queue LIMIT 1) AS contact_pending,
      EXISTS(SELECT 1 FROM contact_origin_identity_queue LIMIT 1) AS identity_pending,
      EXISTS(SELECT 1 FROM contact_origin_appointment_queue LIMIT 1) AS appointment_pending
  `)
  return booleanValue(row?.contact_pending) || booleanValue(row?.identity_pending) ||
    booleanValue(row?.appointment_pending)
}

export async function compileContactOriginRangeRollup(database, generation) {
  if (!generation) return { ready: false, generation: null }
  return database.transaction(async transaction => {
    const marker = await transaction.get(`
      SELECT status FROM contact_origin_range_generation WHERE generation = ?
    `, [generation])
    if (text(marker?.status).toLowerCase() === 'ready') {
      return { ready: true, rebuilt: false, generation }
    }

    await transaction.run('DELETE FROM contact_origin_daily_rollup WHERE generation = ?', [generation])
    await transaction.run(`
      INSERT INTO contact_origin_daily_rollup(
        generation, metric_kind, business_date, resolved_source, contact_count, updated_at
      )
      SELECT generation, 'leads', lead_business_date, resolved_source, COUNT(*), CURRENT_TIMESTAMP
      FROM contact_origin_contact_fact
      WHERE generation = ? AND lead_business_date != ?
      GROUP BY generation, lead_business_date, resolved_source
    `, [generation, RANGE_ORIGIN])
    await transaction.run(`
      INSERT INTO contact_origin_daily_rollup(
        generation, metric_kind, business_date, resolved_source, contact_count, updated_at
      )
      SELECT generation, 'conversions', first_payment_business_date, resolved_source,
             COUNT(*), CURRENT_TIMESTAMP
      FROM contact_origin_contact_fact
      WHERE generation = ? AND first_payment_business_date IS NOT NULL
      GROUP BY generation, first_payment_business_date, resolved_source
    `, [generation])

    await transaction.run('DELETE FROM contact_origin_appointment_range_point WHERE generation = ?', [generation])
    await transaction.run('DELETE FROM contact_origin_appointment_range_delta WHERE generation = ?', [generation])
    const nextPrevious = databaseDialect === 'postgres'
      ? 'previous_date + 1'
      : `DATE(previous_date, '+1 day')`
    const nextOccurrence = databaseDialect === 'postgres'
      ? 'business_date + 1'
      : `DATE(business_date, '+1 day')`
    const rangeOrigin = databaseDialect === 'postgres' ? `DATE '${RANGE_ORIGIN}'` : `'${RANGE_ORIGIN}'`
    await transaction.run(`
      WITH occurrences AS (
        SELECT appointments.contact_id, contacts.resolved_source, appointments.business_date
        FROM contact_origin_appointment_fact appointments
        INNER JOIN contact_origin_contact_fact contacts
          ON contacts.generation = appointments.generation
         AND contacts.contact_id = appointments.contact_id
        WHERE appointments.generation = ?
        GROUP BY appointments.contact_id, contacts.resolved_source, appointments.business_date
      ), ordered AS (
        SELECT contact_id, resolved_source, business_date,
          LAG(business_date) OVER (
            PARTITION BY contact_id ORDER BY business_date ASC
          ) AS previous_date
        FROM occurrences
      ), points AS (
        SELECT contact_id, resolved_source,
          COALESCE(${nextPrevious}, ${rangeOrigin}) AS start_boundary,
          business_date AS occurrence_date, 1 AS point_delta
        FROM ordered
        UNION ALL
        SELECT contact_id, resolved_source,
          ${nextOccurrence} AS start_boundary,
          business_date AS occurrence_date, -1 AS point_delta
        FROM ordered
      )
      INSERT INTO contact_origin_appointment_range_point(
        generation, contact_id, resolved_source, start_boundary,
        occurrence_date, range_delta, updated_at
      )
      SELECT ?, contact_id, resolved_source, start_boundary,
        occurrence_date, point_delta, CURRENT_TIMESTAMP
      FROM points
    `, [generation, generation])
    await transaction.run(`
      INSERT INTO contact_origin_appointment_range_delta(
        generation, resolved_source, start_boundary, occurrence_date, range_delta, updated_at
      )
      SELECT generation, resolved_source, start_boundary, occurrence_date,
        SUM(range_delta), CURRENT_TIMESTAMP
      FROM contact_origin_appointment_range_point
      WHERE generation = ?
      GROUP BY generation, resolved_source, start_boundary, occurrence_date
      HAVING SUM(range_delta) != 0
    `, [generation])
    await transaction.run(`
      INSERT INTO contact_origin_range_generation(generation, status, built_at, updated_at)
      VALUES (?, 'ready', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(generation) DO UPDATE SET
        status = 'ready', built_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    `, [generation])
    await transaction.run(`
      UPDATE contact_origin_projection_state
      SET range_compiled = ?, updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = ? AND building_generation = ?
    `, [dbBoolean(true), STATE_ID, generation])
    return { ready: true, rebuilt: true, generation }
  })
}

async function trySwapGeneration(database) {
  return database.transaction(async transaction => {
    const state = await lockState(transaction)
    const generation = Number(state?.building_generation || 0)
    if (!generation) return { swapped: false, ready: true }
    if (!booleanValue(state.contacts_complete) || !booleanValue(state.appointments_complete) ||
      !booleanValue(state.range_compiled) || !await isRangeGenerationReady(transaction, generation)) {
      return { swapped: false, ready: false }
    }
    if (databaseDialect === 'postgres') {
      await transaction.run('LOCK TABLE contact_origin_contact_queue IN SHARE ROW EXCLUSIVE MODE')
      await transaction.run('LOCK TABLE contact_origin_identity_queue IN SHARE ROW EXCLUSIVE MODE')
      await transaction.run('LOCK TABLE contact_origin_appointment_queue IN SHARE ROW EXCLUSIVE MODE')
    }
    if (await queuesPending(transaction)) return { swapped: false, ready: false, catchingUp: true }

    const oldGeneration = Number(state.active_generation || 0) || null
    if (oldGeneration && oldGeneration !== generation) await enqueueGenerationGc(transaction, oldGeneration)
    await transaction.run(`
      UPDATE contact_origin_projection_state
      SET status = 'ready',
          active_generation = building_generation,
          active_version = building_version,
          active_timezone = building_timezone,
          building_generation = NULL, building_version = NULL, building_timezone = NULL,
          contact_cursor = '', appointment_cursor = '',
          contacts_complete = ?, appointments_complete = ?, range_compiled = ?,
          last_applied_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = ?
    `, [dbBoolean(false), dbBoolean(false), dbBoolean(false), STATE_ID])
    return { swapped: true, ready: true, oldGeneration, activeGeneration: generation }
  })
}

async function markReadyIfCaughtUp(database) {
  const pending = await queuesPending(database)
  if (pending) {
    await database.run(`
      UPDATE contact_origin_projection_state
      SET status = 'replaying', updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = ? AND active_generation IS NOT NULL AND building_generation IS NULL
    `, [STATE_ID])
    return false
  }
  await database.run(`
    UPDATE contact_origin_projection_state
    SET status = 'ready', last_error = NULL, last_applied_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE singleton_id = ? AND active_generation IS NOT NULL AND building_generation IS NULL
  `, [STATE_ID])
  return true
}

async function cleanupRetiredGenerationBatch(database, batchSize = GC_BATCH_SIZE) {
  return database.transaction(async transaction => {
    const state = await lockState(transaction)
    if (state?.building_generation || await queuesPending(transaction)) {
      return { cleaned: 0, complete: false, busy: true }
    }
    const due = await transaction.get(`
      SELECT generation
      FROM contact_origin_generation_gc
      WHERE eligible_at <= CURRENT_TIMESTAMP
      ORDER BY eligible_at ASC, generation ASC
      LIMIT 1
      ${databaseDialect === 'postgres' ? 'FOR UPDATE SKIP LOCKED' : ''}
    `)
    const generation = Number(due?.generation || 0)
    if (!generation) return { cleaned: 0, complete: true }
    if ([Number(state?.active_generation || 0), Number(state?.building_generation || 0)].includes(generation)) {
      return { cleaned: 0, complete: false, protected: true }
    }
    const physicalId = databaseDialect === 'postgres' ? 'ctid' : 'rowid'
    const tables = [
      'contact_origin_appointment_range_point',
      'contact_origin_appointment_range_delta',
      'contact_origin_appointment_fact',
      'contact_origin_daily_rollup',
      'contact_origin_contact_fact'
    ]
    let cleaned = 0
    for (const table of tables) {
      const result = await transaction.run(`
        DELETE FROM ${table}
        WHERE ${physicalId} IN (
          SELECT ${physicalId} FROM ${table} WHERE generation = ? LIMIT ?
        )
      `, [generation, batchSize])
      cleaned += Number(result?.changes || 0)
    }
    const pending = await transaction.get(`
      SELECT
        EXISTS(SELECT 1 FROM contact_origin_appointment_range_point WHERE generation = ? LIMIT 1) AS point_pending,
        EXISTS(SELECT 1 FROM contact_origin_appointment_range_delta WHERE generation = ? LIMIT 1) AS delta_pending,
        EXISTS(SELECT 1 FROM contact_origin_appointment_fact WHERE generation = ? LIMIT 1) AS appointment_pending,
        EXISTS(SELECT 1 FROM contact_origin_daily_rollup WHERE generation = ? LIMIT 1) AS rollup_pending,
        EXISTS(SELECT 1 FROM contact_origin_contact_fact WHERE generation = ? LIMIT 1) AS contact_pending
    `, [generation, generation, generation, generation, generation])
    const remains = Object.values(pending || {}).some(booleanValue)
    if (!remains) {
      await transaction.run('DELETE FROM contact_origin_range_generation WHERE generation = ?', [generation])
      await transaction.run('DELETE FROM contact_origin_generation_gc WHERE generation = ?', [generation])
    }
    return { cleaned, complete: !remains, generation }
  })
}

async function runProjectionCycle(database, timezone, options = {}) {
  if (!await areContactDependenciesReady(database)) {
    return { ready: false, paused: true, dependencyPending: true }
  }
  const contactBatchSize = boundedInteger(options.contactBatchSize, CONTACT_BATCH_SIZE, CONTACT_BATCH_SIZE)
  const appointmentBatchSize = boundedInteger(
    options.appointmentBatchSize,
    APPOINTMENT_BATCH_SIZE,
    APPOINTMENT_BATCH_SIZE
  )
  const maxQueueBatches = boundedInteger(options.maxQueueBatches, MAX_QUEUE_BATCHES, 100)
  const maxBackfillBatches = boundedInteger(options.maxBackfillBatches, MAX_BACKFILL_BATCHES, 100)
  const state = await ensureBuildingGeneration(database, timezone)
  if (!state) return { ready: false, unavailable: true }

  let replayed = 0
  let backfilledContacts = 0
  let backfilledAppointments = 0
  const initialReplay = await processQueueWave(database, maxQueueBatches, options)
  replayed += initialReplay.total

  for (let batch = 0; batch < maxBackfillBatches; batch += 1) {
    const current = await readContactOriginProjectionState(database)
    if (!current?.building_generation) break
    if (!booleanValue(current.contacts_complete)) {
      const result = await processContactBackfillBatch(database, contactBatchSize)
      backfilledContacts += result.processed
      continue
    }
    if (!booleanValue(current.appointments_complete)) {
      const result = await processAppointmentBackfillBatch(database, appointmentBatchSize)
      backfilledAppointments += result.processed
      continue
    }
    break
  }

  let current = await readContactOriginProjectionState(database)
  const backfillComplete = Boolean(current?.building_generation) &&
    booleanValue(current.contacts_complete) && booleanValue(current.appointments_complete)
  if (backfillComplete) {
    const replay = await processQueueWave(database, maxQueueBatches, options)
    replayed += replay.total
    if (!await queuesPending(database)) {
      await compileContactOriginRangeRollup(database, Number(current.building_generation))
      const afterCompileReplay = await processQueueWave(database, maxQueueBatches, options)
      replayed += afterCompileReplay.total
    }
  }

  const swap = await trySwapGeneration(database)
  current = await readContactOriginProjectionState(database)
  const pending = await queuesPending(database)
  const ready = Number(current?.active_generation || 0) > 0 && !current?.building_generation && !pending
  if (ready) await markReadyIfCaughtUp(database)
  let gc = { cleaned: 0 }
  if (ready && Date.now() - lastGcAttemptAt >= GC_POLL_MS) {
    lastGcAttemptAt = Date.now()
    gc = await cleanupRetiredGenerationBatch(database)
  }
  return {
    available: Number(current?.active_generation || 0) > 0,
    ready,
    paused: !ready || replayed > 0 || backfilledContacts > 0 || backfilledAppointments > 0,
    replayed,
    backfilledContacts,
    backfilledAppointments,
    swapped: swap.swapped,
    catchingUp: pending,
    cleaned: gc.cleaned,
    generation: Number(current?.active_generation || 0) || null,
    timezone
  }
}

async function persistFailure(error) {
  await db.run(`
    UPDATE contact_origin_projection_state
    SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP
    WHERE singleton_id = ?
  `, [text(error?.message || error).slice(0, 2_000), STATE_ID]).catch(() => undefined)
}

export async function runContactOriginProjectionBackfill(options = {}) {
  const timezone = resolveTimezone(await getAccountTimezone({ throwOnError: true }))
  try {
    if (databaseDialect === 'postgres' && typeof db.withAdvisoryLock === 'function') {
      return await db.withAdvisoryLock(
        BACKFILL_JOB_KEY,
        lockedDb => runProjectionCycle(lockedDb || db, timezone, options)
      )
    }
    return await runProjectionCycle(db, timezone, options)
  } catch (error) {
    if (error?.code === 'DATABASE_ADVISORY_LOCK_BUSY') return { ready: false, busy: true, paused: true }
    if (isMissingProjectionSchema(error)) return { ready: false, unavailable: true }
    await persistFailure(error)
    throw error
  }
}

function clearResumeTimer() {
  if (resumeTimer) clearTimeout(resumeTimer)
  resumeTimer = null
}

function scheduleResume(delayMs) {
  if (resumeTimer || isDeployShutdownStarted()) return
  resumeTimer = setTimeout(() => {
    resumeTimer = null
    scheduleContactOriginProjectionBackfill()
  }, Math.max(1, Number(delayMs) || 1))
  resumeTimer.unref?.()
}

export function scheduleContactOriginProjectionBackfill() {
  if (isDeployShutdownStarted() || workerPromise || workerScheduled) return { scheduled: false }
  const retryAfterMs = Math.max(0, workerEligibleAt - Date.now())
  if (retryAfterMs > 0) {
    scheduleResume(retryAfterMs)
    return { scheduled: false, paused: true, retryAfterMs }
  }
  clearResumeTimer()
  const queued = scheduleProjectionBackfillJob({
    key: BACKFILL_JOB_KEY,
    priority: BACKFILL_JOB_PRIORITY.NORMAL,
    onError: error => {
      workerScheduled = false
      workerEligibleAt = Date.now() + ERROR_RETRY_MS
      scheduleResume(ERROR_RETRY_MS)
      logger.warn(`[Origen] No se pudo iniciar el read model: ${error?.message || error}`)
    },
    run: () => {
      workerScheduled = false
      workerPromise = runContactOriginProjectionBackfill()
        .then(result => {
          const delay = result?.unavailable
            ? ERROR_RETRY_MS
            : (result?.paused ? BACKFILL_PAUSE_MS : CONTINUOUS_POLL_MS)
          workerEligibleAt = Date.now() + delay
          scheduleResume(delay)
          return result
        })
        .catch(async error => {
          await persistFailure(error)
          workerEligibleAt = Date.now() + ERROR_RETRY_MS
          scheduleResume(ERROR_RETRY_MS)
          logger.warn(`[Origen] Falló el read model incremental: ${error.message}`)
          return { ready: false, error: error.message }
        })
        .finally(() => { workerPromise = null })
      return workerPromise
    }
  })
  workerScheduled = Boolean(queued?.scheduled)
  return { scheduled: workerScheduled }
}

function rankedRows(rows) {
  return (rows || []).map(row => ({
    name: text(row.name) || 'Desconocido',
    value: Number(row.value || 0)
  }))
}

async function queryDailyMetric(database, generation, metricKind, startDate, endDate, signal) {
  return rankedRows(await database.all(`
    SELECT resolved_source AS name, SUM(contact_count) AS value
    FROM contact_origin_daily_rollup
    WHERE generation = ? AND metric_kind = ?
      AND business_date >= ? AND business_date <= ?
    GROUP BY resolved_source
    HAVING SUM(contact_count) > 0
    ORDER BY value DESC, name ASC
  `, [generation, metricKind, startDate, endDate], { signal }))
}

async function queryAppointmentRange(database, generation, startDate, endDate, signal) {
  return rankedRows(await database.all(`
    SELECT resolved_source AS name, SUM(range_delta) AS value
    FROM contact_origin_appointment_range_delta
    WHERE generation = ? AND start_boundary <= ? AND occurrence_date <= ?
    GROUP BY resolved_source
    HAVING SUM(range_delta) > 0
    ORDER BY value DESC, name ASC
  `, [generation, startDate, endDate], { signal }))
}

function finalizeBreakdown(baseRows, excludedRows = []) {
  const totals = new Map()
  for (const row of baseRows || []) {
    const name = text(row.name) || 'Desconocido'
    totals.set(name, (totals.get(name) || 0) + Number(row.value || 0))
  }
  for (const row of excludedRows || []) {
    const name = text(row.name) || 'Desconocido'
    totals.set(name, (totals.get(name) || 0) - Number(row.value || 0))
  }
  return [...totals.entries()]
    .map(([name, value]) => ({ name, value }))
    .filter(row => row.value > 0)
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name))
    .slice(0, 10)
}

function hiddenScopeTooLargeError() {
  const error = new Error(
    `Los filtros de contactos ocultos exceden el máximo seguro de ${MAX_HIDDEN_CONTACT_IDS} contactos.`
  )
  error.code = 'contact_origin_hidden_scope_too_large'
  error.status = 503
  error.retryable = false
  return error
}

async function loadBoundedHiddenContactIds(database, hiddenFilters, signal) {
  const visibleCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false)
  if (!visibleCondition) return []
  const rows = await database.all(`
    SELECT contacts.id
    FROM contacts
    WHERE NOT (${visibleCondition})
    ORDER BY contacts.id ASC
    LIMIT ${MAX_HIDDEN_CONTACT_IDS + 1}
  `, [], { signal })
  if (rows.length > MAX_HIDDEN_CONTACT_IDS) throw hiddenScopeTooLargeError()
  return uniqueIds(rows.map(row => row.id))
}

function mergeBreakdownRows(target, rows) {
  for (const row of rows || []) {
    const name = text(row.name) || 'Desconocido'
    target.set(name, (target.get(name) || 0) + Number(row.value || 0))
  }
}

async function queryContactFactMetricForIds(
  database,
  generation,
  metricKind,
  startDate,
  endDate,
  contactIds,
  signal
) {
  if (!contactIds.length) return []
  const dateColumn = metricKind === 'leads' ? 'facts.lead_business_date' : 'facts.first_payment_business_date'
  const totals = new Map()
  for (const batch of chunks(contactIds, HIDDEN_QUERY_BATCH_SIZE)) {
    const rows = await database.all(`
      SELECT facts.resolved_source AS name, COUNT(*) AS value
      FROM contact_origin_contact_fact facts
      WHERE facts.generation = ? AND ${dateColumn} >= ? AND ${dateColumn} <= ?
        AND facts.contact_id IN (${placeholders(batch)})
      GROUP BY facts.resolved_source
    `, [generation, startDate, endDate, ...batch], { signal })
    mergeBreakdownRows(totals, rows)
  }
  return [...totals.entries()].map(([name, value]) => ({ name, value }))
}

async function queryAppointmentFacts(database, generation, startDate, endDate, {
  calendarIds,
  contactIds = [],
  signal
}) {
  const calendarCondition = calendarIds.length
    ? `AND appointments.calendar_id IN (${placeholders(calendarIds)})`
    : ''
  const contactCondition = contactIds.length
    ? `AND appointments.contact_id IN (${placeholders(contactIds)})`
    : ''
  return rankedRows(await database.all(`
    SELECT facts.resolved_source AS name, COUNT(DISTINCT appointments.contact_id) AS value
    FROM contact_origin_appointment_fact appointments
    INNER JOIN contact_origin_contact_fact facts
      ON facts.generation = appointments.generation
     AND facts.contact_id = appointments.contact_id
    WHERE appointments.generation = ?
      AND appointments.business_date >= ? AND appointments.business_date <= ?
      ${calendarCondition}
      ${contactCondition}
    GROUP BY facts.resolved_source
    ORDER BY value DESC, name ASC
  `, [generation, startDate, endDate, ...calendarIds, ...contactIds], { signal }))
}

async function queryAppointmentFactsForIds(
  database,
  generation,
  startDate,
  endDate,
  calendarIds,
  contactIds,
  signal
) {
  if (!contactIds.length) return []
  const totals = new Map()
  for (const batch of chunks(contactIds, HIDDEN_QUERY_BATCH_SIZE)) {
    mergeBreakdownRows(totals, await queryAppointmentFacts(
      database,
      generation,
      startDate,
      endDate,
      { calendarIds, contactIds: batch, signal }
    ))
  }
  return [...totals.entries()].map(([name, value]) => ({ name, value }))
}

/**
 * Devuelve los tres embudos de origen desde una sola generación consistente.
 * El camino común usa rollups diarios + delta de rangos; filtros dinámicos usan
 * hechos indexados y COUNT DISTINCT exacto (incluido multi-calendario).
 */
export async function queryContactOriginBreakdowns(range, {
  hiddenFilters = [],
  attributionCalendarIds = [],
  signal
} = {}) {
  return withQueryDeadline(signal, async deadlineSignal => (
    withPinnedGeneration(range, deadlineSignal, async (database, status) => {
      // Una generación publicada sigue siendo consistente mientras las colas
      // convergen. Pending se reporta como metadata; nunca convierte cada
      // ráfaga de writes en un 503 de navegación.
      if (!status.available) throw projectionWarmingError(status)
      const generation = Number(status.activeGeneration)
      const timezone = resolveTimezone(range?.appliedTimezone || status.timezone)
      const startDate = safeBusinessDate(range?.startUtc, timezone)
      const endDate = safeBusinessDate(range?.endUtc, timezone)
      if (!startDate || !endDate || startDate > endDate) {
        throw Object.assign(new Error('El rango de origen no es válido.'), { code: 'INVALID_DATE_RANGE', status: 400 })
      }
      const calendars = uniqueIds(attributionCalendarIds)
      const hasHiddenFilters = Array.isArray(hiddenFilters) && hiddenFilters.length > 0
      const hiddenContactIds = hasHiddenFilters
        ? await loadBoundedHiddenContactIds(database, hiddenFilters, deadlineSignal)
        : []

      const leadBase = await queryDailyMetric(
        database,
        generation,
        'leads',
        startDate,
        endDate,
        deadlineSignal
      )
      const hiddenLeads = await queryContactFactMetricForIds(
        database,
        generation,
        'leads',
        startDate,
        endDate,
        hiddenContactIds,
        deadlineSignal
      )
      const appointmentBase = calendars.length
        ? await queryAppointmentFacts(database, generation, startDate, endDate, {
            calendarIds: calendars,
            signal: deadlineSignal
          })
        : await queryAppointmentRange(database, generation, startDate, endDate, deadlineSignal)
      const hiddenAppointments = await queryAppointmentFactsForIds(
        database,
        generation,
        startDate,
        endDate,
        calendars,
        hiddenContactIds,
        deadlineSignal
      )
      const conversionBase = await queryDailyMetric(
        database,
        generation,
        'conversions',
        startDate,
        endDate,
        deadlineSignal
      )
      const hiddenConversions = await queryContactFactMetricForIds(
        database,
        generation,
        'conversions',
        startDate,
        endDate,
        hiddenContactIds,
        deadlineSignal
      )
      return {
        leads: finalizeBreakdown(leadBase, hiddenLeads),
        appointments: finalizeBreakdown(appointmentBase, hiddenAppointments),
        conversions: finalizeBreakdown(conversionBase, hiddenConversions),
        readPath: {
          leads: hasHiddenFilters ? 'daily_rollup_minus_hidden' : 'daily_rollup',
          appointments: calendars.length
            ? (hasHiddenFilters ? 'appointment_presence_minus_hidden' : 'appointment_presence')
            : (hasHiddenFilters ? 'appointment_range_delta_minus_hidden' : 'appointment_range_delta'),
          conversions: hasHiddenFilters ? 'daily_rollup_minus_hidden' : 'daily_rollup'
        },
        generation,
        projection: {
          status: status.status,
          pending: Boolean(status.pending),
          ready: Boolean(status.ready)
        }
      }
    })
  ))
}
