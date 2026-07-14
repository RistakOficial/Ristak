import { databaseDialect, db } from '../config/database.js'
import { logger } from '../utils/logger.js'

export const TRACKING_VISITOR_PROJECTION_VERSION = 3
const POSTGRES_BATCH_SIZE = 2_000
// Cuatro ramas de scope comparten el mismo statement. 200 mantiene 800 IDs por
// debajo del límite SQLite legacy de 999 bind parameters.
const SQLITE_BATCH_SIZE = 200
const DEFAULT_YIELD_MS = 25

let projectionReady = false
let workerPromise = null
let workerScheduled = false

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

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
        RETURNING target.*
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
  yieldMs = DEFAULT_YIELD_MS
} = {}) {
  let updated = 0
  const normalizedBatchSize = Math.max(1, Math.min(Number(batchSize) || 1, 10_000))

  while (true) {
    const changes = Number(await backfillBatch(normalizedBatchSize) || 0)
    updated += changes

    if (changes === 0) {
      // Otra instancia puede tener el último lote bloqueado. Sólo publicar ready
      // cuando la tabla confirma que ya no queda ninguna versión vieja.
      if (!(await hasPendingProjectionRows())) {
        projectionReady = true
        break
      }
    }

    await sleep(yieldMs)
  }

  if (updated > 0) {
    logger.info(`[Tracking] Proyección de visitantes actualizada en ${updated} sesión(es).`)
  }
  return { ready: true, updated, version: TRACKING_VISITOR_PROJECTION_VERSION }
}

/** Programa el backfill y regresa de inmediato; nunca bloquea readiness/deploy. */
export function scheduleTrackingVisitorProjectionBackfill() {
  if (projectionReady || workerPromise || workerScheduled) {
    return { scheduled: false, ready: projectionReady }
  }

  workerScheduled = true
  setTimeout(() => {
    workerScheduled = false
    if (projectionReady || workerPromise) return
    workerPromise = runTrackingVisitorProjectionBackfill()
      .catch((error) => {
        logger.warn(`[Tracking] No se pudo completar la proyección de visitantes: ${error.message}`)
        return { ready: false, error: error.message }
      })
      .finally(() => {
        workerPromise = null
      })
  }, 0)

  return { scheduled: true, ready: false }
}

/**
 * Compuerta exacta: mientras exista una fila histórica sin proyectar, la ruta
 * usa el SQL legacy correcto y el worker sigue convergiendo en background.
 */
export async function isTrackingVisitorProjectionReady({
  schedule = true,
  startUtc,
  endExclusiveUtc,
  scopeType,
  scopeId
} = {}) {
  if (projectionReady) return true

  try {
    const scopedCheck = Boolean(startUtc && endExclusiveUtc)
    const ready = !(await hasPendingProjectionRows({ startUtc, endExclusiveUtc, scopeType, scopeId }))
    if (!scopedCheck) projectionReady = ready
    if (ready) return true
  } catch {
    // Rolling deploy/test sin migración: no usar columnas que aún no existen.
    return false
  }

  if (schedule) scheduleTrackingVisitorProjectionBackfill()
  return false
}

export const TRACKING_VISITOR_PROJECTION_LIMITS = Object.freeze({
  postgresBatchSize: POSTGRES_BATCH_SIZE,
  sqliteBatchSize: SQLITE_BATCH_SIZE,
  yieldMs: DEFAULT_YIELD_MS
})
