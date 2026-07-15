import { databaseDialect, db } from '../config/database.js'
import { BACKFILL_JOB_PRIORITY } from '../jobs/backfillJobCoordinator.js'
import { scheduleProjectionBackfillJob } from '../jobs/projectionBackfillScheduler.js'
import { logger } from '../utils/logger.js'
import { isDeployShutdownStarted } from '../utils/deployDrainTracker.js'

export const TRACKING_VISITOR_PROJECTION_VERSION = 3
const POSTGRES_BATCH_SIZE = 200
// Cuatro ramas de scope comparten el mismo statement. 200 mantiene 800 IDs por
// debajo del límite SQLite legacy de 999 bind parameters.
const SQLITE_BATCH_SIZE = 200
const MAX_BATCHES_PER_RUN = 10
const DEFAULT_YIELD_MS = 25
const BACKFILL_PAUSE_MS = 1_000
const BACKFILL_ERROR_RETRY_MS = 30_000
const BACKFILL_JOB_KEY = 'tracking-visitor-projection'
const PROJECTION_STATE_ID = 1

let projectionReady = false
let workerPromise = null
let workerScheduled = false
let workerEligibleAt = 0
let workerResumeTimer = null

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

function clearTrackingVisitorProjectionResume() {
  if (workerResumeTimer) clearTimeout(workerResumeTimer)
  workerResumeTimer = null
}

function scheduleTrackingVisitorProjectionResume(delayMs) {
  if (projectionReady || workerResumeTimer) return false
  workerResumeTimer = setTimeout(() => {
    workerResumeTimer = null
    if (isDeployShutdownStarted()) return
    scheduleTrackingVisitorProjectionBackfill()
  }, Math.max(1, Number(delayMs) || 1))
  workerResumeTimer.unref?.()
  return true
}

function isMissingTrackingVisitorProjectionSchema(error) {
  const code = String(error?.code || '').toUpperCase()
  if (code === '42P01' || code === '42703') return true
  if (code !== 'SQLITE_ERROR') return false
  const message = String(error?.message || '')
  return /no such table:\s*tracking_visitor_projection_state/i.test(message) ||
    /no such column:\s*(?:tracking_visitor_projection_state\.)?(?:singleton_id|projection_version|status|last_error|updated_at)/i.test(message)
}

export async function readTrackingVisitorProjectionState(database = db, { signal } = {}) {
  try {
    return await database.get(`
      SELECT singleton_id, projection_version, status, last_error, updated_at
      FROM tracking_visitor_projection_state
      WHERE singleton_id = ?
    `, [PROJECTION_STATE_ID], { signal })
  } catch (error) {
    if (isMissingTrackingVisitorProjectionSchema(error)) return null
    throw error
  }
}

async function updateTrackingVisitorProjectionState(status, error = null, database = db) {
  return database.run(`
    UPDATE tracking_visitor_projection_state
    SET projection_version = ?,
        status = ?,
        last_error = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE singleton_id = ?
  `, [
    TRACKING_VISITOR_PROJECTION_VERSION,
    status,
    error ? String(error).slice(0, 2_000) : null,
    PROJECTION_STATE_ID
  ])
}

/**
 * Estado O(1) del read model. Un GET nunca inspecciona `sessions` para decidir
 * si puede responder. La proyección sólo es publicable cuando su cobertura está
 * completa; durante backfill no expone filas parciales como si fueran válidas.
 */
export async function getTrackingVisitorProjectionStatus({ schedule = false, signal } = {}) {
  const state = await readTrackingVisitorProjectionState(db, { signal })
  if (!state || Number(state.projection_version) !== TRACKING_VISITOR_PROJECTION_VERSION) {
    if (schedule) scheduleTrackingVisitorProjectionBackfill()
    return {
      available: false,
      ready: false,
      status: 'unavailable',
      sourceStatus: state?.status || 'missing',
      version: TRACKING_VISITOR_PROJECTION_VERSION
    }
  }

  const ready = String(state.status || '').toLowerCase() === 'ready'
  if (!ready && schedule) scheduleTrackingVisitorProjectionBackfill()
  return {
    available: ready,
    ready,
    status: ready ? 'ready' : 'warming',
    sourceStatus: String(state.status || 'backfilling'),
    version: TRACKING_VISITOR_PROJECTION_VERSION,
    updatedAt: state.updated_at || null,
    lastError: state.last_error || null
  }
}

function visitorKeySql(alias = 'sessions') {
  return `CASE
    WHEN ${alias}.contact_id IS NOT NULL AND ${alias}.contact_id != '' THEN 'contact:' || ${alias}.contact_id
    WHEN ${alias}.visitor_id IS NOT NULL AND ${alias}.visitor_id != '' THEN 'visitor:' || ${alias}.visitor_id
    WHEN ${alias}.session_id IS NOT NULL AND ${alias}.session_id != '' THEN 'session:' || ${alias}.session_id
    ELSE NULL
  END`
}

function sqliteTimestampSql(valueSql) {
  return `CASE
    WHEN typeof(${valueSql}) IN ('integer', 'real')
      AND ABS(CAST(${valueSql} AS REAL)) >= 100000000000
      THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(${valueSql} AS REAL) / 1000.0, 'unixepoch')
    WHEN typeof(${valueSql}) IN ('integer', 'real')
      THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(${valueSql} AS REAL), 'unixepoch')
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ${valueSql})
  END`
}

async function hasPendingProjectionRows({ startUtc, endExclusiveUtc, scopeType, scopeId } = {}) {
  const conditions = ['visitor_projection_version < ?']
  const params = [TRACKING_VISITOR_PROJECTION_VERSION]
  if (startUtc && endExclusiveUtc) {
    const startedAtSql = databaseDialect === 'postgres'
      ? 'started_at'
      : sqliteTimestampSql('started_at')
    conditions.push(`${startedAtSql} >= ?`, `${startedAtSql} < ?`)
    params.push(startUtc, endExclusiveUtc)
  }
  if (scopeType === 'campaign') {
    conditions.push('campaign_id = ?')
    params.push(scopeId)
  } else if (scopeType === 'adset') {
    conditions.push('adset_id = ?')
    params.push(scopeId)
  } else if (scopeType === 'ad') {
    conditions.push('ad_id = ?')
    params.push(scopeId)
  }

  const row = await db.get(`
    SELECT id
    FROM sessions
    WHERE ${conditions.join(' AND ')}
    LIMIT 1
  `, params)
  return Boolean(row)
}

async function backfillBatch(batchSize) {
  if (databaseDialect === 'postgres') {
    const row = await db.get(`
      WITH projection_batch AS MATERIALIZED (
        SELECT id
        FROM sessions
        WHERE visitor_projection_version < ?
        ORDER BY started_at DESC, id DESC
        LIMIT ?
        FOR UPDATE SKIP LOCKED
      ), updated_sessions AS (
        UPDATE sessions AS target
        SET visitor_key = ${visitorKeySql('target')},
            visitor_projection_version = ?
        FROM projection_batch
        WHERE target.id = projection_batch.id
        RETURNING
          target.id,
          target.visitor_key,
          target.campaign_id,
          target.adset_id,
          target.ad_id,
          target.started_at
      ), scoped_sessions AS (
        SELECT
          scopes.scope_type,
          scopes.scope_id,
          buckets.bucket_kind,
          buckets.bucket_start,
          updated.visitor_key,
          updated.id AS session_row_id,
          updated.started_at AS latest_at
        FROM updated_sessions updated
        CROSS JOIN LATERAL (
          VALUES
            ('all'::text, ''::text),
            ('campaign'::text, updated.campaign_id),
            ('adset'::text, updated.adset_id),
            ('ad'::text, updated.ad_id)
        ) scopes(scope_type, scope_id)
        CROSS JOIN LATERAL (
          VALUES
            (
              'day'::text,
              date_trunc('day', updated.started_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
            ),
            (
              'quarter'::text,
              (
                date_trunc('hour', updated.started_at AT TIME ZONE 'UTC')
                  + ((EXTRACT(MINUTE FROM updated.started_at AT TIME ZONE 'UTC')::INTEGER / 15) * INTERVAL '15 minutes')
              ) AT TIME ZONE 'UTC'
            )
        ) buckets(bucket_kind, bucket_start)
        WHERE updated.visitor_key IS NOT NULL
          AND updated.started_at IS NOT NULL
          AND (scopes.scope_type = 'all' OR COALESCE(scopes.scope_id, '') != '')
      ), deduped_scoped_sessions AS (
        SELECT DISTINCT ON (
          scope_type,
          scope_id,
          bucket_kind,
          bucket_start,
          visitor_key
        )
          scope_type,
          scope_id,
          bucket_kind,
          bucket_start,
          visitor_key,
          session_row_id,
          latest_at
        FROM scoped_sessions
        ORDER BY
          scope_type,
          scope_id,
          bucket_kind,
          bucket_start,
          visitor_key,
          latest_at DESC,
          session_row_id DESC
      ), projected AS (
        INSERT INTO tracking_visitor_latest (
          scope_type,
          scope_id,
          bucket_kind,
          bucket_start,
          visitor_key,
          session_row_id,
          latest_at,
          updated_at
        )
        SELECT
          scope_type,
          scope_id,
          bucket_kind,
          bucket_start,
          visitor_key,
          session_row_id,
          latest_at,
          CURRENT_TIMESTAMP
        FROM deduped_scoped_sessions
        ON CONFLICT (scope_type, scope_id, bucket_kind, bucket_start, visitor_key) DO UPDATE SET
          session_row_id = EXCLUDED.session_row_id,
          latest_at = EXCLUDED.latest_at,
          updated_at = CURRENT_TIMESTAMP
        WHERE (EXCLUDED.latest_at, EXCLUDED.session_row_id) >
              (tracking_visitor_latest.latest_at, tracking_visitor_latest.session_row_id)
        RETURNING 1
      )
      SELECT COUNT(*) AS changes
      FROM updated_sessions
    `, [TRACKING_VISITOR_PROJECTION_VERSION, batchSize, TRACKING_VISITOR_PROJECTION_VERSION])
    return Number(row?.changes || 0)
  }

  return db.transaction(async (transaction) => {
    const normalizedSourceStartedAt = sqliteTimestampSql('source.started_at')
    const rows = await transaction.all(`
      SELECT id
      FROM sessions
      WHERE visitor_projection_version < ?
      ORDER BY started_at DESC, id DESC
      LIMIT ?
    `, [TRACKING_VISITOR_PROJECTION_VERSION, batchSize])
    if (!rows.length) return 0

    const ids = rows.map(row => row.id)
    const placeholders = ids.map(() => '?').join(', ')
    await transaction.run(`
      INSERT INTO tracking_visitor_latest (
        scope_type,
        scope_id,
        bucket_kind,
        bucket_start,
        visitor_key,
        session_row_id,
        latest_at,
        updated_at
      )
      SELECT
        scopes.scope_type,
        scopes.scope_id,
        buckets.bucket_kind,
        CASE buckets.bucket_kind
          WHEN 'day' THEN strftime('%Y-%m-%dT00:00:00.000Z', ${normalizedSourceStartedAt})
          ELSE strftime('%Y-%m-%dT%H:', ${normalizedSourceStartedAt})
            || printf('%02d:00.000Z',
              (CAST(strftime('%M', ${normalizedSourceStartedAt}) AS INTEGER) / 15) * 15
            )
        END,
        ${visitorKeySql('source')},
        source.id,
        strftime('%Y-%m-%dT%H:%M:%fZ', ${normalizedSourceStartedAt}),
        CURRENT_TIMESTAMP
      FROM sessions source
      INNER JOIN (
        SELECT 'all' AS scope_type, '' AS scope_id, id FROM sessions WHERE id IN (${placeholders})
        UNION ALL SELECT 'campaign', campaign_id, id FROM sessions
          WHERE id IN (${placeholders}) AND campaign_id IS NOT NULL AND campaign_id != ''
        UNION ALL SELECT 'adset', adset_id, id FROM sessions
          WHERE id IN (${placeholders}) AND adset_id IS NOT NULL AND adset_id != ''
        UNION ALL SELECT 'ad', ad_id, id FROM sessions
          WHERE id IN (${placeholders}) AND ad_id IS NOT NULL AND ad_id != ''
      ) scopes ON scopes.id = source.id
      CROSS JOIN (SELECT 'day' AS bucket_kind UNION ALL SELECT 'quarter') buckets
      WHERE source.started_at IS NOT NULL
        AND ${normalizedSourceStartedAt} IS NOT NULL
        AND ${visitorKeySql('source')} IS NOT NULL
      ON CONFLICT(scope_type, scope_id, bucket_kind, bucket_start, visitor_key) DO UPDATE SET
        session_row_id = excluded.session_row_id,
        latest_at = excluded.latest_at,
        updated_at = CURRENT_TIMESTAMP
      WHERE excluded.latest_at > tracking_visitor_latest.latest_at
         OR (
           excluded.latest_at = tracking_visitor_latest.latest_at
           AND excluded.session_row_id > tracking_visitor_latest.session_row_id
         )
    `, [...ids, ...ids, ...ids, ...ids])

    const result = await transaction.run(`
      UPDATE sessions
      SET visitor_key = ${visitorKeySql('sessions')},
          visitor_projection_version = ?
      WHERE id IN (${placeholders})
    `, [TRACKING_VISITOR_PROJECTION_VERSION, ...ids])
    return Number(result?.changes || rows.length)
  })
}

/**
 * Backfill reanudable. Cada lote libera conexión/candados antes del siguiente;
 * varias instancias PostgreSQL cooperan mediante SKIP LOCKED.
 */
export async function runTrackingVisitorProjectionBackfill({
  batchSize = databaseDialect === 'postgres' ? POSTGRES_BATCH_SIZE : SQLITE_BATCH_SIZE,
  yieldMs = DEFAULT_YIELD_MS,
  maxBatches = MAX_BATCHES_PER_RUN
} = {}) {
  let updated = 0
  let batches = 0
  const batchSizeLimit = databaseDialect === 'postgres'
    ? POSTGRES_BATCH_SIZE
    : SQLITE_BATCH_SIZE
  const normalizedBatchSize = Math.max(1, Math.min(Number(batchSize) || 1, batchSizeLimit))
  const normalizedMaxBatches = Math.max(1, Math.min(Number(maxBatches) || 1, 100))

  const state = await readTrackingVisitorProjectionState()
  if (!state) {
    projectionReady = false
    return {
      ready: false,
      updated: 0,
      version: TRACKING_VISITOR_PROJECTION_VERSION,
      unavailable: true
    }
  }
  if (
    Number(state?.projection_version) === TRACKING_VISITOR_PROJECTION_VERSION &&
    String(state?.status || '').toLowerCase() === 'ready'
  ) {
    projectionReady = true
    return {
      ready: true,
      updated: 0,
      version: TRACKING_VISITOR_PROJECTION_VERSION,
      alreadyReady: true
    }
  }
  if (state && String(state.status || '').toLowerCase() !== 'ready') {
    await updateTrackingVisitorProjectionState('backfilling')
  }
  projectionReady = false

  for (let batch = 0; batch < normalizedMaxBatches; batch += 1) {
    const changes = Number(await backfillBatch(normalizedBatchSize) || 0)
    batches += 1
    updated += changes
    if (changes === 0) break
    if (batch + 1 < normalizedMaxBatches) await sleep(yieldMs)
  }

  // Otra instancia puede tener el último lote bloqueado. Sólo publicar ready
  // cuando la tabla confirma que ya no queda ninguna versión vieja.
  const pending = await hasPendingProjectionRows()
  if (!pending) {
    await updateTrackingVisitorProjectionState('ready')
    projectionReady = true
  }
  if (updated > 0) {
    logger.info(`[Tracking] Proyección de visitantes actualizada en ${updated} sesión(es).`)
  }
  return {
    ready: !pending,
    updated,
    batches,
    paused: pending,
    version: TRACKING_VISITOR_PROJECTION_VERSION
  }
}

/** Programa el backfill y regresa de inmediato; nunca bloquea readiness/deploy. */
export function scheduleTrackingVisitorProjectionBackfill() {
  if (isDeployShutdownStarted()) {
    return { scheduled: false, ready: false, reason: 'shutting-down' }
  }
  if (projectionReady || workerPromise || workerScheduled) {
    return { scheduled: false, ready: projectionReady }
  }
  const retryAfterMs = Math.max(0, workerEligibleAt - Date.now())
  if (retryAfterMs > 0) {
    scheduleTrackingVisitorProjectionResume(retryAfterMs)
    return { scheduled: false, ready: false, paused: true, retryAfterMs }
  }

  const queued = scheduleProjectionBackfillJob({
    key: BACKFILL_JOB_KEY,
    priority: BACKFILL_JOB_PRIORITY.NORMAL,
    onError: (error) => {
      // El fence distribuido puede fallar antes de invocar `run` (por ejemplo,
      // al adquirir conexión). En ese caso nadie había limpiado esta bandera y
      // la proyección quedaba warming para siempre.
      workerScheduled = false
      workerEligibleAt = Date.now() + BACKFILL_ERROR_RETRY_MS
      scheduleTrackingVisitorProjectionResume(BACKFILL_ERROR_RETRY_MS)
      logger.warn(`[Tracking] No se pudo iniciar la proyección de visitantes; se reintentará: ${error?.message || error}`)
    },
    run: () => {
      workerScheduled = false
      if (projectionReady || workerPromise) return workerPromise
      workerPromise = runTrackingVisitorProjectionBackfill()
        .then((result) => {
          const retryDelayMs = result?.unavailable
            ? BACKFILL_ERROR_RETRY_MS
            : BACKFILL_PAUSE_MS
          workerEligibleAt = result?.ready ? 0 : Date.now() + retryDelayMs
          if (result?.ready) clearTrackingVisitorProjectionResume()
          else scheduleTrackingVisitorProjectionResume(retryDelayMs)
          return result
        })
        .catch(async (error) => {
          workerEligibleAt = Date.now() + BACKFILL_ERROR_RETRY_MS
          scheduleTrackingVisitorProjectionResume(BACKFILL_ERROR_RETRY_MS)
          try {
            await updateTrackingVisitorProjectionState('failed', error?.message || error)
          } catch (stateError) {
            logger.warn(`[Tracking] Falló el backfill y tampoco se pudo persistir su estado: ${stateError.message}`)
            throw new AggregateError(
              [error, stateError],
              'Falló la proyección de visitantes y no se pudo guardar su estado'
            )
          }
          logger.warn(`[Tracking] No se pudo completar la proyección de visitantes: ${error.message}`)
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

/** Compatibilidad para callers existentes; la comprobación ya no toca sessions. */
export async function isTrackingVisitorProjectionReady({
  schedule = true
} = {}) {
  return (await getTrackingVisitorProjectionStatus({ schedule })).ready
}

export const TRACKING_VISITOR_PROJECTION_LIMITS = Object.freeze({
  postgresBatchSize: POSTGRES_BATCH_SIZE,
  sqliteBatchSize: SQLITE_BATCH_SIZE,
  maxBatchesPerRun: MAX_BATCHES_PER_RUN,
  pauseMs: BACKFILL_PAUSE_MS,
  resumesWithoutTraffic: true,
  yieldMs: DEFAULT_YIELD_MS
})
