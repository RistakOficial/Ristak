import { databaseDialect, db } from '../config/database.js'
import { BACKFILL_JOB_PRIORITY } from '../jobs/backfillJobCoordinator.js'
import { scheduleProjectionBackfillJob } from '../jobs/projectionBackfillScheduler.js'
import { buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js'
import { logger } from '../utils/logger.js'

export const MESSAGE_FIRST_SEEN_PROJECTION_VERSION = 1

const BATCH_SIZE = databaseDialect === 'postgres' ? 1_000 : 180
const MAX_BATCHES_PER_RUN = 10_000
const WORKER_YIELD_MS = 10
const SOURCE_KINDS = new Set(['whatsapp', 'meta', 'email'])
const BACKFILL_JOB_KEY = 'message-first-seen-projection'

let workerPromise = null
let workerScheduled = false

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))

function placeholders(values) {
  return values.map(() => '?').join(', ')
}

const sourceConfigs = [
  {
    table: 'whatsapp_api_messages',
    sourceKind: 'whatsapp',
    projectionView: 'ristak_message_first_seen_whatsapp_source'
  },
  {
    table: 'meta_social_messages',
    sourceKind: 'meta',
    projectionView: 'ristak_message_first_seen_meta_source'
  },
  {
    table: 'email_messages',
    sourceKind: 'email',
    projectionView: 'ristak_message_first_seen_email_source'
  }
]

async function hasPendingRows(database = db) {
  for (const config of sourceConfigs) {
    const row = await database.get(`
      SELECT id
      FROM ${config.table}
      WHERE first_seen_projection_version < ?
      LIMIT 1
    `, [MESSAGE_FIRST_SEEN_PROJECTION_VERSION])
    if (row) return true
  }
  return false
}

export async function readMessageFirstSeenProjectionState(database = db) {
  return database.get(`
    SELECT singleton_id, projection_version, status, last_error
    FROM message_first_seen_projection_state
    WHERE singleton_id = 1
  `).catch(() => null)
}

function messageFirstSeenProjectionStateIsReady(state) {
  return Number(state?.projection_version) === MESSAGE_FIRST_SEEN_PROJECTION_VERSION &&
    String(state?.status || '').toLowerCase() === 'ready'
}

async function isMessageFirstSeenProjectionDurablyReady(database = db) {
  return messageFirstSeenProjectionStateIsReady(
    await readMessageFirstSeenProjectionState(database)
  )
}

/**
 * El fast path falla cerrado sobre el singleton durable. Los triggers mantienen
 * cada escritura nueva en version actual; el worker es quien certifica ready al
 * terminar el historico, asi que los GET no vuelven a sondear esas fuentes.
 */
export async function isMessageFirstSeenProjectionReady() {
  try {
    return await isMessageFirstSeenProjectionDurablyReady(db)
  } catch {
    return false
  }
}

export async function getMessageFirstSeenProjectionStatus() {
  const state = await readMessageFirstSeenProjectionState()
  if (!state || Number(state.projection_version) !== MESSAGE_FIRST_SEEN_PROJECTION_VERSION) {
    return { available: false, ready: false, status: 'unavailable' }
  }
  if (String(state.status || '').toLowerCase() !== 'ready') {
    return {
      available: true,
      ready: false,
      status: 'warming',
      sourceStatus: String(state.status || 'backfilling')
    }
  }
  return {
    available: true,
    ready: true,
    status: 'ready',
    sourceStatus: 'ready'
  }
}

/**
 * El GET nunca reconstruye first-seen desde las tablas de mensajes. Mientras
 * converge, sirve el snapshot parcial ya materializado y declara warming. Si
 * el esquema aun no existe devuelve cero/unavailable, sin bloquear la vista.
 */
export async function getProjectedMessageFirstSeenCount(range, {
  sourceKind = null,
  hiddenFilters = [],
  signal,
  withStatus = false
} = {}) {
  let projectionStatus = await getMessageFirstSeenProjectionStatus()

  const result = (count) => withStatus
    ? {
        count: Number(count || 0),
        projectionReady: projectionStatus.ready,
        projectionStatus: projectionStatus.status
      }
    : Number(count || 0)

  const normalizedSource = sourceKind == null
    ? null
    : String(sourceKind || '').trim().toLowerCase()
  if (normalizedSource && !SOURCE_KINDS.has(normalizedSource)) {
    throw new Error(`Fuente de first-seen no soportada: ${normalizedSource}`)
  }

  const table = normalizedSource
    ? 'message_identity_first_seen_source'
    : 'message_identity_first_seen_global'
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
  const contactsJoin = hiddenCondition
    ? 'LEFT JOIN contacts c ON c.id = first_seen.contact_id'
    : ''
  const conditions = [
    'first_seen.first_seen_at >= ?',
    'first_seen.first_seen_at <= ?'
  ]
  const params = [range.startUtc, range.endUtc]

  if (normalizedSource) {
    conditions.unshift('first_seen.source_kind = ?')
    params.unshift(normalizedSource)
  }
  // Replica literalmente el contrato legacy: solo NULL es anonimo. Un
  // contact_id vacio/huerfano sigue pasando por la expresion de ocultos.
  if (hiddenCondition) {
    conditions.push(`(first_seen.contact_id IS NULL OR ${hiddenCondition})`)
  }

  try {
    const row = await db.get(`
      SELECT COUNT(*) AS total
      FROM ${table} first_seen
      ${contactsJoin}
      WHERE ${conditions.join(' AND ')}
    `, params, { signal })
    return result(row?.total)
  } catch (error) {
    if (/message_(?:first_seen|identity_first_seen)|first_seen_projection_version/i.test(String(error?.message || ''))) {
      projectionStatus = { available: false, ready: false, status: 'unavailable' }
      return result(0)
    }
    throw error
  }
}

async function backfillSourceBatch(database, config) {
  return database.transaction(async tx => {
    const rows = await tx.all(`
      SELECT id
      FROM ${config.table}
      WHERE first_seen_projection_version < ?
      ORDER BY id
      LIMIT ?
      ${databaseDialect === 'postgres' ? 'FOR UPDATE SKIP LOCKED' : ''}
    `, [MESSAGE_FIRST_SEEN_PROJECTION_VERSION, BATCH_SIZE])
    if (!rows.length) return 0

    const ids = rows.map(row => String(row.id || '')).filter(Boolean)
    if (!ids.length) return 0
    const idsSql = placeholders(ids)

    // No hacemos UPDATE contact_id=contact_id: eso despertaria proyecciones de
    // Chat y otras capas por cada millon de filas. El lote toma lock del source,
    // reemplaza solo su sentinel y marca version en la misma transaccion.
    await tx.run(`
      DELETE FROM message_first_seen_ledger
      WHERE source_kind = ?
        AND source_message_id IN (${idsSql})
    `, [config.sourceKind, ...ids])
    await tx.run(`
      INSERT INTO message_first_seen_ledger (
        source_kind, source_message_id, projection_version, included,
        identity_key, contact_id, first_seen_at, updated_at
      )
      SELECT source_kind, source_message_id, projection_version, included,
             identity_key, contact_id, first_seen_at, CURRENT_TIMESTAMP
      FROM ${config.projectionView}
      WHERE source_message_id IN (${idsSql})
    `, ids)
    await tx.run(`
      UPDATE ${config.table}
      SET first_seen_projection_version = ?
      WHERE id IN (${idsSql})
    `, [MESSAGE_FIRST_SEEN_PROJECTION_VERSION, ...ids])
    return ids.length
  })
}

async function tryMarkReady(database) {
  const result = await database.run(`
    UPDATE message_first_seen_projection_state
    SET status = 'ready', last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE singleton_id = 1
      AND projection_version = ?
      AND NOT EXISTS (
        SELECT 1 FROM whatsapp_api_messages
        WHERE first_seen_projection_version < ? LIMIT 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM meta_social_messages
        WHERE first_seen_projection_version < ? LIMIT 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM email_messages
        WHERE first_seen_projection_version < ? LIMIT 1
      )
  `, [
    MESSAGE_FIRST_SEEN_PROJECTION_VERSION,
    MESSAGE_FIRST_SEEN_PROJECTION_VERSION,
    MESSAGE_FIRST_SEEN_PROJECTION_VERSION,
    MESSAGE_FIRST_SEEN_PROJECTION_VERSION
  ])
  return Number(result?.changes || result?.rowCount || 0) > 0
}

async function runUnlockedBackfill(database = db) {
  // Reinicio caliente: no hay UPDATE ni acceso a fuentes si la certificacion
  // durable ya esta vigente.
  if (await isMessageFirstSeenProjectionDurablyReady(database)) {
    return { ready: true, skipped: true, passes: 0 }
  }

  await database.run(`
    UPDATE message_first_seen_projection_state
    SET status = CASE WHEN status = 'ready' THEN status ELSE 'backfilling' END,
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE singleton_id = 1
  `)

  for (let pass = 0; pass < MAX_BATCHES_PER_RUN; pass += 1) {
    let changed = 0
    for (const config of sourceConfigs) {
      changed += await backfillSourceBatch(database, config)
    }

    if (!changed) {
      if (await tryMarkReady(database)) return { ready: true, passes: pass + 1 }
      if (!(await hasPendingRows(database))) {
        return {
          ready: await isMessageFirstSeenProjectionDurablyReady(database),
          passes: pass + 1
        }
      }
    }
    if (pass % 10 === 9) await sleep(WORKER_YIELD_MS)
  }

  return { ready: false, exhausted: true }
}

export async function runMessageFirstSeenProjectionBackfill() {
  if (workerPromise) return workerPromise

  workerPromise = (async () => {
    try {
      if (databaseDialect === 'postgres' && typeof db.withAdvisoryLock === 'function') {
        return await db.withAdvisoryLock(
          'message-first-seen-projection',
          lockedDb => runUnlockedBackfill(lockedDb || db)
        )
      }
      return await runUnlockedBackfill(db)
    } catch (error) {
      if (error?.code === 'DATABASE_ADVISORY_LOCK_BUSY') {
        setTimeout(() => scheduleMessageFirstSeenProjectionBackfill(), 250)
        return { ready: false, busy: true }
      }
      if (/message_(?:first_seen|identity_first_seen)|first_seen_projection_version/i.test(String(error?.message || ''))) {
        return { ready: false, unavailable: true }
      }
      await db.run(`
        UPDATE message_first_seen_projection_state
        SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE singleton_id = 1 AND status = 'backfilling'
      `, [String(error?.message || error)]).catch(() => undefined)
      logger.error(`No se pudo converger la proyeccion de primer mensaje: ${error.message}`)
      throw error
    } finally {
      workerPromise = null
    }
  })()

  return workerPromise
}

export function scheduleMessageFirstSeenProjectionBackfill() {
  if (workerPromise || workerScheduled) return { scheduled: false }
  const queued = scheduleProjectionBackfillJob({
    key: BACKFILL_JOB_KEY,
    priority: BACKFILL_JOB_PRIORITY.NORMAL,
    run: async () => {
      workerScheduled = false
      const result = await runMessageFirstSeenProjectionBackfill()
      if (result?.exhausted) {
        setTimeout(() => scheduleMessageFirstSeenProjectionBackfill(), 100)
      }
      return result
    }
  })
  workerScheduled = queued.scheduled
  return { scheduled: queued.scheduled }
}
