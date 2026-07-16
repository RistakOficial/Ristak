import { databaseDialect, db } from '../config/database.js'
import { BACKFILL_JOB_PRIORITY } from '../jobs/backfillJobCoordinator.js'
import { scheduleProjectionBackfillJob } from '../jobs/projectionBackfillScheduler.js'
import { logger } from '../utils/logger.js'

export const CONTACT_PERSON_IDENTITY_PROJECTION_VERSION = 1

const BATCH_SIZE = databaseDialect === 'postgres' ? 2_000 : 200
const WORKER_YIELD_MS = 15
const BACKFILL_JOB_KEY = 'contact-person-identity-projection'

let workerPromise = null
let workerScheduled = false
let projectionReady = false

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)))

function isSchemaUnavailable(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || '')
  return code === '42P01' || code === '42703' || (
    code === 'SQLITE_ERROR' && /no such (?:table|column):\s*(?:contact_person_identity|contact_person_identity_projection_state)/i.test(message)
  )
}

export async function readContactPersonIdentityProjectionState(database = db, { signal } = {}) {
  try {
    return await database.get(`
      SELECT singleton_id, projection_version, status, generation,
             processed_count, last_error, updated_at
      FROM contact_person_identity_projection_state
      WHERE singleton_id = 1
    `, [], { signal })
  } catch (error) {
    if (isSchemaUnavailable(error)) return null
    throw error
  }
}

async function hasMissingRows(database = db) {
  const row = await database.get(`
    SELECT 1 AS missing
    FROM contacts source_contact
    LEFT JOIN contact_person_identity identity_projection
      ON identity_projection.contact_id = source_contact.id
      AND identity_projection.projection_version = ?
    WHERE identity_projection.contact_id IS NULL
    LIMIT 1
  `, [CONTACT_PERSON_IDENTITY_PROJECTION_VERSION])
  return Boolean(row)
}

async function backfillSqliteBatch(batchSize) {
  return db.transaction(async transaction => {
    const rows = await transaction.all(`
      SELECT source_contact.id
      FROM contacts source_contact
      LEFT JOIN contact_person_identity identity_projection
        ON identity_projection.contact_id = source_contact.id
        AND identity_projection.projection_version = ?
      WHERE identity_projection.contact_id IS NULL
      ORDER BY source_contact.id
      LIMIT ?
    `, [CONTACT_PERSON_IDENTITY_PROJECTION_VERSION, batchSize])
    if (!rows.length) return 0

    const ids = rows.map(row => String(row.id || '')).filter(Boolean)
    if (!ids.length) return 0
    const placeholders = ids.map(() => '?').join(', ')
    await transaction.run(`
      INSERT INTO contact_person_identity (
        contact_id, campaign_person_key, report_person_key, projection_version, updated_at
      )
      SELECT contact_id, campaign_person_key, report_person_key, ?, CURRENT_TIMESTAMP
      FROM ristak_contact_person_identity_source
      WHERE contact_id IN (${placeholders})
      ON CONFLICT(contact_id) DO UPDATE SET
        campaign_person_key = excluded.campaign_person_key,
        report_person_key = excluded.report_person_key,
        projection_version = excluded.projection_version,
        updated_at = CURRENT_TIMESTAMP
    `, [CONTACT_PERSON_IDENTITY_PROJECTION_VERSION, ...ids])
    await transaction.run(`
      UPDATE contact_person_identity_projection_state
      SET status = 'backfilling',
          projection_version = ?,
          processed_count = processed_count + ?,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = 1
    `, [CONTACT_PERSON_IDENTITY_PROJECTION_VERSION, ids.length])
    return ids.length
  })
}

async function backfillPostgresBatch(batchSize) {
  const row = await db.get(`
    WITH projection_batch AS MATERIALIZED (
      SELECT source_contact.id
      FROM contacts source_contact
      LEFT JOIN contact_person_identity identity_projection
        ON identity_projection.contact_id = source_contact.id
        AND identity_projection.projection_version = ?
      WHERE identity_projection.contact_id IS NULL
      ORDER BY source_contact.id
      LIMIT ?
      FOR UPDATE OF source_contact SKIP LOCKED
    ), inserted AS (
      INSERT INTO contact_person_identity (
        contact_id, campaign_person_key, report_person_key, projection_version, updated_at
      )
      SELECT source.contact_id, source.campaign_person_key, source.report_person_key,
             ?, CURRENT_TIMESTAMP
      FROM ristak_contact_person_identity_source source
      JOIN projection_batch batch ON batch.id = source.contact_id
      ON CONFLICT (contact_id) DO UPDATE SET
        campaign_person_key = EXCLUDED.campaign_person_key,
        report_person_key = EXCLUDED.report_person_key,
        projection_version = EXCLUDED.projection_version,
        updated_at = CURRENT_TIMESTAMP
      RETURNING 1
    )
    SELECT COUNT(*) AS changes FROM projection_batch
  `, [
    CONTACT_PERSON_IDENTITY_PROJECTION_VERSION,
    batchSize,
    CONTACT_PERSON_IDENTITY_PROJECTION_VERSION
  ])
  const changes = Number(row?.changes || 0)
  if (changes > 0) {
    await db.run(`
      UPDATE contact_person_identity_projection_state
      SET status = 'backfilling',
          projection_version = ?,
          processed_count = processed_count + ?,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = 1
    `, [CONTACT_PERSON_IDENTITY_PROJECTION_VERSION, changes])
  }
  return changes
}

async function markReadyIfStable() {
  const before = await readContactPersonIdentityProjectionState()
  if (!before || await hasMissingRows()) return false

  const result = await db.run(`
    UPDATE contact_person_identity_projection_state
    SET projection_version = ?, status = 'ready', last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE singleton_id = 1 AND generation = ?
  `, [CONTACT_PERSON_IDENTITY_PROJECTION_VERSION, Number(before.generation || 0)])
  if (Number(result?.changes || 0) <= 0) return false

  if (await hasMissingRows()) {
    await db.run(`
      UPDATE contact_person_identity_projection_state
      SET status = 'backfilling', updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = 1
    `)
    return false
  }
  projectionReady = true
  return true
}

export async function runContactPersonIdentityProjectionBackfill({
  batchSize = BATCH_SIZE,
  yieldMs = WORKER_YIELD_MS
} = {}) {
  const safeBatchSize = Math.max(1, Math.min(Number(batchSize) || 1, 10_000))
  let processed = 0
  await db.run(`
    UPDATE contact_person_identity_projection_state
    SET projection_version = ?, status = 'backfilling', last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE singleton_id = 1
  `, [CONTACT_PERSON_IDENTITY_PROJECTION_VERSION])

  try {
    while (true) {
      const changes = databaseDialect === 'postgres'
        ? await backfillPostgresBatch(safeBatchSize)
        : await backfillSqliteBatch(safeBatchSize)
      processed += Number(changes || 0)
      if (changes === 0 && await markReadyIfStable()) break
      await sleep(yieldMs)
    }
  } catch (error) {
    projectionReady = false
    await db.run(`
      UPDATE contact_person_identity_projection_state
      SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = 1
    `, [String(error?.message || error).slice(0, 1_000)]).catch(() => undefined)
    throw error
  }

  if (processed > 0) {
    logger.info(`[Contactos] Proyección de identidad actualizada en ${processed} fila(s).`)
  }
  return { ready: true, processed }
}

export function scheduleContactPersonIdentityProjectionBackfill() {
  if (workerScheduled || workerPromise || projectionReady) {
    return { scheduled: false, ready: projectionReady }
  }

  const queued = scheduleProjectionBackfillJob({
    key: BACKFILL_JOB_KEY,
    priority: BACKFILL_JOB_PRIORITY.CRITICAL,
    run: () => {
      workerScheduled = false
      if (workerPromise) return workerPromise
      workerPromise = runContactPersonIdentityProjectionBackfill()
        .catch(error => {
          logger.warn(`[Contactos] El backfill de identidad se reintentará: ${error.message}`)
          return { ready: false, error: error.message }
        })
        .finally(() => {
          workerPromise = null
        })
      return workerPromise
    }
  })
  workerScheduled = queued.scheduled
  return { scheduled: queued.scheduled, ready: false }
}

export async function getContactPersonIdentityProjectionStatus({ schedule = false, signal } = {}) {
  if (projectionReady) return { available: true, ready: true, status: 'ready' }
  const state = await readContactPersonIdentityProjectionState(db, { signal })
  if (!state) return { available: false, ready: false, status: 'unavailable' }
  const ready = Number(state.projection_version) === CONTACT_PERSON_IDENTITY_PROJECTION_VERSION &&
    String(state.status || '').toLowerCase() === 'ready'
  projectionReady = ready
  if (!ready && schedule) scheduleContactPersonIdentityProjectionBackfill()
  return {
    available: true,
    ready,
    status: ready ? 'ready' : 'warming',
    sourceStatus: String(state.status || 'backfilling')
  }
}

export function createContactPersonIdentityWarmingError() {
  const error = new Error('La proyección de identidad de contactos se está preparando')
  error.status = 503
  error.code = 'CONTACT_PERSON_IDENTITY_WARMING'
  error.retryAfter = 2
  error.retriable = true
  error.projection = 'contact_person_identity'
  error.projectionStatus = 'warming'
  return error
}
