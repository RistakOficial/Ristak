import {
  databaseDialect,
  db,
  isTransientPostgresConnectionError
} from '../config/database.js'
import { logger } from '../utils/logger.js'

export const CONVERSATIONAL_RERUN_GARBAGE_CLEANUP_VERSION = '2026-08-14-v2'
const CLEANUP_CONFIG_KEY = 'conversational_rerun_garbage_cleanup'
const COMPACTION_CONFIG_KEY = 'conversational_rerun_garbage_compaction'
const CLEANUP_PLAN_CONFIG_KEY = 'conversational_rerun_garbage_cleanup_plan'
const CLEANUP_LOCK_KEY = 'conversational-rerun-garbage-cleanup'
const CLEANUP_RETRY_INITIAL_DELAY_MS = 15_000
const CLEANUP_RETRY_MAX_DELAY_MS = 60_000
const CLEANUP_RETRYABLE_POSTGRES_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  '57014' // query_canceled / statement_timeout
])
const CLEANUP_PAGE_SIZE = databaseDialect === 'postgres' ? 2_000 : 250
const FULL_COMPACTION_MIN_DELETED_ROWS = 10_000
const EVENT_METRIC_TOTAL_COLUMNS = Object.freeze([
  'total_events',
  'success_events',
  'error_events',
  'assigned_events',
  'reply_events',
  'appointment_events',
  'payment_link_events',
  'goal_completion_events',
  'follow_up_sent_events',
  'follow_up_suppressed_events',
  'human_handoff_events',
  'tool_failure_events'
])
const CLEANUP_EVENT_TYPES = Object.freeze([
  // Los errores legacy no traían messageId. Primero recorremos los retry y
  // conservamos sus instantes en memoria; así podemos relacionarlos después sin
  // un subquery por fila y aunque los retry duplicados ya hayan sido eliminados.
  'mandatory_handoff_gate_retry_queued',
  'error',
  'agent_not_matched',
  'run_suppressed_highlevel_phone_channel',
  'preventive_measure_load_retry_queued'
])

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))

function safeJsonParse(value, fallback = null) {
  if (value && typeof value === 'object') return value
  try {
    return JSON.parse(String(value || ''))
  } catch {
    return fallback
  }
}

function normalizeChannel(value = 'whatsapp') {
  const channel = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  return channel || 'whatsapp'
}

function cleanupVersionMatches(value) {
  const parsed = safeJsonParse(value, {})
  return parsed?.version === CONVERSATIONAL_RERUN_GARBAGE_CLEANUP_VERSION ||
    String(value || '') === CONVERSATIONAL_RERUN_GARBAGE_CLEANUP_VERSION
}

async function readConfig(database, key) {
  const row = await database.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    [key]
  ).catch(() => null)
  return row?.config_value || ''
}

async function writeConfig(database, key, value) {
  await database.run(`
    INSERT INTO app_config (config_key, config_value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(config_key) DO UPDATE SET
      config_value = excluded.config_value,
      updated_at = CURRENT_TIMESTAMP
  `, [key, JSON.stringify(value)])
}

function uniqueCleanupSeeds(rows = []) {
  const seeds = new Map()
  for (const row of rows) {
    const payload = safeJsonParse(row?.payload ?? row?.detail_json, {}) || {}
    const contactId = String(payload.contactId || row?.contactId || row?.contact_id || '').trim()
    const messageId = String(payload.messageId || row?.messageId || '').trim()
    const channel = normalizeChannel(payload.channel || row?.channel)
    if (!contactId || !messageId) continue
    const key = `${contactId}\u0000${channel}\u0000${messageId}`
    if (!seeds.has(key)) {
      seeds.set(key, { contactId, messageId, channel })
    }
  }
  return [...seeds.values()]
}

export async function buildConversationalRerunGarbageCleanupPlan({
  database = db
} = {}) {
  const [cleanupStatus, compactionStatus, savedPlanStatus] = await Promise.all([
    readConfig(database, CLEANUP_CONFIG_KEY),
    readConfig(database, COMPACTION_CONFIG_KEY),
    readConfig(database, CLEANUP_PLAN_CONFIG_KEY)
  ])
  const cleanupApplied = cleanupVersionMatches(cleanupStatus)
  const compactionApplied = cleanupVersionMatches(compactionStatus)
  const parsedCleanupStatus = safeJsonParse(cleanupStatus, {}) || {}
  if (cleanupApplied) {
    return {
      version: CONVERSATIONAL_RERUN_GARBAGE_CLEANUP_VERSION,
      cleanupApplied,
      compactionApplied,
      previouslyDeletedRows: Math.max(0, Number(parsedCleanupStatus.deletedRows) || 0),
      seeds: []
    }
  }

  const parsedSavedPlan = safeJsonParse(savedPlanStatus, {}) || {}
  const savedDeletedRows = parsedSavedPlan.version === CONVERSATIONAL_RERUN_GARBAGE_CLEANUP_VERSION
    ? Math.max(0, Number(parsedSavedPlan.deletedRows) || 0)
    : 0
  const savedSeeds = parsedSavedPlan.version === CONVERSATIONAL_RERUN_GARBAGE_CLEANUP_VERSION
    ? uniqueCleanupSeeds(parsedSavedPlan.seeds)
    : []
  const eventTypePlaceholders = CLEANUP_EVENT_TYPES.map(() => '?').join(', ')
  const [pendingRows, deterministicAuditRows] = await Promise.all([
    database.all(`
      SELECT run_key, contact_id, channel, payload
      FROM ai_agent_pending_reruns
      ORDER BY run_key ASC
    `),
    // Si un despliegue anterior alcanzó a consumir el pending pero no terminó
    // la limpieza, sus IDs deterministas permiten recuperar la semilla exacta.
    database.all(`
      SELECT contact_id, detail_json
      FROM conversational_agent_events
      WHERE id >= 'cae_audit_'
        AND id < 'cae_audit_g'
        AND event_type IN (${eventTypePlaceholders})
      ORDER BY id ASC
    `, CLEANUP_EVENT_TYPES)
  ])
  const seeds = uniqueCleanupSeeds([
    ...savedSeeds,
    ...pendingRows,
    ...deterministicAuditRows
  ])
  const capturedAt = parsedSavedPlan.version === CONVERSATIONAL_RERUN_GARBAGE_CLEANUP_VERSION
    ? parsedSavedPlan.capturedAt
    : new Date().toISOString()

  // Ésta es la primera escritura del boot y ocurre antes del recovery. Nunca
  // dependemos sólo de memoria: otro deploy puede interrumpir la limpieza y el
  // siguiente proceso retoma exactamente los mismos contacto/canal/mensaje.
  await writeConfig(database, CLEANUP_PLAN_CONFIG_KEY, {
    version: CONVERSATIONAL_RERUN_GARBAGE_CLEANUP_VERSION,
    capturedAt,
    updatedAt: new Date().toISOString(),
    seedCount: seeds.length,
    deletedRows: savedDeletedRows,
    seeds
  })

  return {
    version: CONVERSATIONAL_RERUN_GARBAGE_CLEANUP_VERSION,
    cleanupApplied,
    compactionApplied,
    previouslyDeletedRows: Math.max(
      0,
      Number(parsedCleanupStatus.deletedRows) || 0,
      savedDeletedRows
    ),
    capturedAt,
    seeds
  }
}

function eventSignature(eventType, detail = {}) {
  if (eventType === 'agent_not_matched') return 'terminal:no-agent'
  if (eventType === 'run_suppressed_highlevel_phone_channel') {
    return [
      detail.phase || '',
      detail.reason || '',
      detail.replyChannel || '',
      detail.winningMessageId || ''
    ].join(':')
  }

  const attemptCount = Math.max(0, Number(
    detail.attemptCount ?? detail.retryAttemptCount
  ) || 0)
  const maxAttempts = Math.max(1, Number(detail.maxAttempts) || 3)
  const attemptBucket = attemptCount > maxAttempts
    ? 'escalation'
    : `attempt:${attemptCount}`
  if (eventType === 'error') {
    return [
      attemptBucket,
      detail.retryStage || detail.stage || '',
      detail.errorCode || '',
      detail.message || '',
      detail.retryQueued === true ? 'queued' : 'not-queued'
    ].join(':')
  }
  return [
    attemptBucket,
    detail.stage || detail.retryStage || '',
    detail.errorCode || ''
  ].join(':')
}

function cursorPredicate(cursor, tableAlias = '') {
  if (!cursor?.createdAt || !cursor?.id) return { sql: '', params: [] }
  const prefix = tableAlias ? `${tableAlias}.` : ''
  return {
    sql: `AND (${prefix}created_at > ? OR (${prefix}created_at = ? AND ${prefix}id > ?))`,
    params: [cursor.createdAt, cursor.createdAt, cursor.id]
  }
}

function cleanupSeedKey({ contactId, channel, messageId } = {}) {
  return `${String(contactId || '').trim()}\u0000${normalizeChannel(channel)}\u0000${String(messageId || '').trim()}`
}

function cleanupContactChannelKey(contactId, channel) {
  return `${String(contactId || '').trim()}\u0000${normalizeChannel(channel)}`
}

function eventTimeMs(value) {
  if (value instanceof Date) return value.getTime()
  const text = String(value || '').trim()
  if (!text) return Number.NaN
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
    ? text
    : `${text.includes('T') ? text : text.replace(' ', 'T')}Z`
  return new Date(normalized).getTime()
}

function nearbyRetrySeedKey(sortedRetryTimes, eventTime, windowMs = 5_000) {
  if (!sortedRetryTimes.length || !Number.isFinite(eventTime)) return ''
  let low = 0
  let high = sortedRetryTimes.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (sortedRetryTimes[middle].time < eventTime) low = middle + 1
    else high = middle
  }
  const candidates = []
  for (let index = low; index < sortedRetryTimes.length; index += 1) {
    const distance = Math.abs(sortedRetryTimes[index].time - eventTime)
    if (distance > windowMs) break
    candidates.push({ ...sortedRetryTimes[index], distance })
  }
  for (let index = low - 1; index >= 0; index -= 1) {
    const distance = Math.abs(sortedRetryTimes[index].time - eventTime)
    if (distance > windowMs) break
    candidates.push({ ...sortedRetryTimes[index], distance })
  }
  if (!candidates.length) return ''

  const minimumDistance = Math.min(...candidates.map(candidate => candidate.distance))
  const nearestSeeds = new Set(
    candidates
      .filter(candidate => candidate.distance === minimumDistance)
      .map(candidate => candidate.seedKey)
  )
  return nearestSeeds.size === 1 ? [...nearestSeeds][0] : ''
}

async function deleteEventIds(database, ids) {
  if (!ids.length) return 0
  const placeholders = ids.map(() => '?').join(', ')

  if (databaseDialect === 'postgres') {
    await database.transaction(async (transactionDb) => {
      // El trigger normal actualiza el resumen una vez por evento. En una
      // reparación millonaria eso convierte 64 shards pequeños en millones de
      // escrituras aleatorias. Calculamos el mismo delta por shard, marcamos el
      // ledger como ya descontado y dejamos que el trigger sólo retire su fila.
      const metricDeltas = await transactionDb.all(`
        SELECT
          summary_shard,
          ${EVENT_METRIC_TOTAL_COLUMNS.map(column => `SUM(${column}) AS ${column}`).join(',\n          ')}
        FROM conversational_agent_event_metric_rows
        WHERE included = 1
          AND event_id IN (${placeholders})
        GROUP BY summary_shard
        ORDER BY summary_shard ASC
      `, ids)

      await transactionDb.run(`
        UPDATE conversational_agent_event_metric_rows
        SET included = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE included = 1
          AND event_id IN (${placeholders})
      `, ids)

      if (metricDeltas.length > 0) {
        const deltaRows = metricDeltas.map(() => `(
          CAST(? AS INTEGER),
          ${EVENT_METRIC_TOTAL_COLUMNS.map(() => 'CAST(? AS BIGINT)').join(', ')}
        )`).join(', ')
        const deltaParams = metricDeltas.flatMap(row => [
          row.summary_shard,
          ...EVENT_METRIC_TOTAL_COLUMNS.map(column => row[column] || 0)
        ])
        await transactionDb.run(`
          UPDATE conversational_agent_event_metric_summary AS summary
          SET
            ${EVENT_METRIC_TOTAL_COLUMNS.map(column => (
              `${column} = summary.${column} - delta.${column}`
            )).join(',\n            ')},
            updated_at = CURRENT_TIMESTAMP
          FROM (VALUES ${deltaRows}) AS delta(
            summary_shard,
            ${EVENT_METRIC_TOTAL_COLUMNS.join(', ')}
          )
          WHERE summary.summary_shard = delta.summary_shard
        `, deltaParams)
        await transactionDb.run(`
          DELETE FROM conversational_agent_event_metric_summary
          WHERE total_events <= 0
        `)
      }

      // Retiramos el ledger en bloque antes de borrar el historial padre. La
      // función del trigger padre reconoce este flag local y evita repetir un
      // DELETE indexado por cada evento. El flag vive sólo en esta transacción:
      // las inserciones/actualizaciones normales de otras conexiones conservan
      // su proyección de métricas sin interrupciones.
      await transactionDb.run(`
        DELETE FROM conversational_agent_event_metric_rows
        WHERE event_id IN (${placeholders})
      `, ids)
      await transactionDb.exec(
        "SELECT set_config('ristak.skip_conversational_event_metrics_reproject', 'on', true)"
      )
      await transactionDb.run(
        `DELETE FROM conversational_agent_events WHERE id IN (${placeholders})`,
        ids
      )
    })
    return ids.length
  }

  await database.run(
    `DELETE FROM conversational_agent_events WHERE id IN (${placeholders})`,
    ids
  )
  return ids.length
}

async function cleanupEventTypeAcrossSeeds(database, seedByKey, eventType, {
  pageSize = CLEANUP_PAGE_SIZE,
  onDeleted = null,
  retryTimesByContactChannel = new Map()
} = {}) {
  const seenSignaturesBySeed = new Map()
  let cursor = null
  let scanned = 0
  let deleted = 0

  while (true) {
    const cursorFilter = cursorPredicate(cursor, 'event_row')
    const rows = await database.all(`
      SELECT event_row.id, event_row.contact_id, event_row.detail_json, event_row.created_at
      FROM conversational_agent_events AS event_row
      WHERE event_row.event_type = ?
        ${cursorFilter.sql}
      ORDER BY event_row.created_at ASC, event_row.id ASC
      LIMIT ?
    `, [
      eventType,
      ...cursorFilter.params,
      pageSize
    ])
    if (!rows.length) break

    const duplicateIds = []
    for (const row of rows) {
      const detail = safeJsonParse(row.detail_json, {}) || {}
      const contactId = String(row.contact_id || '').trim()
      const rawChannel = String(detail.channel || '').trim()
      const messageId = String(detail.messageId || '').trim()
      if (!contactId || !rawChannel) continue

      const channel = normalizeChannel(rawChannel)
      let seedKey = messageId
        ? cleanupSeedKey({ contactId, channel, messageId })
        : ''

      if (eventType === 'error' && !messageId) {
        const contactChannelKey = cleanupContactChannelKey(contactId, channel)
        seedKey = nearbyRetrySeedKey(
          retryTimesByContactChannel.get(contactChannelKey) || [],
          eventTimeMs(row.created_at)
        )
      }
      if (!seedByKey.has(seedKey)) continue

      if (eventType === 'mandatory_handoff_gate_retry_queued') {
        const timestamp = eventTimeMs(row.created_at)
        if (Number.isFinite(timestamp)) {
          const contactChannelKey = cleanupContactChannelKey(contactId, channel)
          const retryTimes = retryTimesByContactChannel.get(contactChannelKey) || []
          retryTimes.push({ time: timestamp, seedKey })
          retryTimesByContactChannel.set(contactChannelKey, retryTimes)
        }
      }

      const seenSignatures = seenSignaturesBySeed.get(seedKey) || new Set()
      const signature = eventSignature(eventType, detail)
      if (seenSignatures.has(signature)) duplicateIds.push(row.id)
      else seenSignatures.add(signature)
      seenSignaturesBySeed.set(seedKey, seenSignatures)
    }
    const pageDeleted = await deleteEventIds(database, duplicateIds)
    deleted += pageDeleted
    if (pageDeleted > 0 && typeof onDeleted === 'function') {
      await onDeleted(pageDeleted)
    }
    scanned += rows.length
    const last = rows[rows.length - 1]
    cursor = { createdAt: last.created_at, id: last.id }
    if (rows.length < pageSize) break
    await sleep(25)
  }

  return {
    scanned,
    deleted,
    retained: [...seenSignaturesBySeed.values()]
      .reduce((total, signatures) => total + signatures.size, 0)
  }
}

async function cleanupCapturedSeeds(database, seeds = [], { onDeleted = null } = {}) {
  const totals = { seeds: seeds.length, scanned: 0, deleted: 0, retained: 0 }
  const seedByKey = new Map(seeds.map(seed => [cleanupSeedKey(seed), seed]))
  const retryTimesByContactChannel = new Map()
  for (const eventType of CLEANUP_EVENT_TYPES) {
    const result = await cleanupEventTypeAcrossSeeds(database, seedByKey, eventType, {
      onDeleted,
      retryTimesByContactChannel
    })
    totals.scanned += result.scanned
    totals.deleted += result.deleted
    totals.retained += result.retained
    if (eventType === 'mandatory_handoff_gate_retry_queued') {
      for (const retryTimes of retryTimesByContactChannel.values()) {
        retryTimes.sort((left, right) => left.time - right.time)
      }
    }
  }
  return totals
}

async function compactGarbageTables(database, deletedRows) {
  if (deletedRows <= 0) return { skipped: true, reason: 'nothing-deleted' }

  if (databaseDialect !== 'postgres') {
    await database.exec('VACUUM')
    return { compacted: true, mode: 'vacuum' }
  }

  await database.exec("SET lock_timeout = '10s'")
  await database.exec("SET statement_timeout = '30min'")
  try {
    if (deletedRows >= FULL_COMPACTION_MIN_DELETED_ROWS) {
      // Primero compactamos el ledger derivado y después el historial padre.
      // VACUUM FULL se limita estrictamente a estas dos tablas y sólo corre
      // cuando el borrado fue material; devuelve almacenamiento real al plan.
      await database.exec('VACUUM (FULL, ANALYZE) conversational_agent_event_metric_rows')
      await database.exec('VACUUM (FULL, ANALYZE) conversational_agent_events')
      return { compacted: true, mode: 'vacuum-full' }
    }
    await database.exec('VACUUM (ANALYZE) conversational_agent_event_metric_rows')
    await database.exec('VACUUM (ANALYZE) conversational_agent_events')
    return { compacted: true, mode: 'vacuum' }
  } finally {
    await database.exec('RESET statement_timeout').catch(() => {})
    await database.exec('RESET lock_timeout').catch(() => {})
  }
}

export async function runConversationalRerunGarbageCleanup(plan = null, {
  database = db
} = {}) {
  if (!plan) await buildConversationalRerunGarbageCleanupPlan({ database })
  try {
    return await database.withAdvisoryLock(CLEANUP_LOCK_KEY, async (lockedDatabase) => {
      const maintenanceDb = lockedDatabase || database
      const latestPlan = await buildConversationalRerunGarbageCleanupPlan({
        database: maintenanceDb
      })
      let deletedRows = latestPlan.previouslyDeletedRows
      let cleanup = {
        seeds: 0,
        scanned: 0,
        deleted: 0,
        retained: 0,
        skipped: true
      }

      if (!latestPlan.cleanupApplied) {
        const capturedSeeds = latestPlan.seeds
        let persistedDeletedRows = deletedRows
        cleanup = await cleanupCapturedSeeds(maintenanceDb, capturedSeeds, {
          onDeleted: async (pageDeleted) => {
            persistedDeletedRows += pageDeleted
            await writeConfig(maintenanceDb, CLEANUP_PLAN_CONFIG_KEY, {
              version: CONVERSATIONAL_RERUN_GARBAGE_CLEANUP_VERSION,
              capturedAt: latestPlan.capturedAt,
              updatedAt: new Date().toISOString(),
              seedCount: capturedSeeds.length,
              deletedRows: persistedDeletedRows,
              seeds: capturedSeeds
            })
          }
        })
        deletedRows = persistedDeletedRows
        await writeConfig(maintenanceDb, CLEANUP_CONFIG_KEY, {
          version: CONVERSATIONAL_RERUN_GARBAGE_CLEANUP_VERSION,
          deletedRows,
          scannedRows: cleanup.scanned,
          seedCount: cleanup.seeds,
          completedAt: new Date().toISOString()
        })
        if (cleanup.deleted > 0) {
          logger.info(
            `[Agente conversacional] Limpieza de reruns: ${cleanup.deleted} evento(s) duplicado(s) eliminado(s); ` +
            `${cleanup.retained} evidencia(s) única(s) conservada(s).`
          )
        }
      }

      let compaction = { skipped: true, reason: 'already-applied' }
      if (!latestPlan.compactionApplied) {
        compaction = await compactGarbageTables(maintenanceDb, deletedRows)
        await writeConfig(maintenanceDb, COMPACTION_CONFIG_KEY, {
          version: CONVERSATIONAL_RERUN_GARBAGE_CLEANUP_VERSION,
          deletedRows,
          mode: compaction.mode || compaction.reason || 'skipped',
          completedAt: new Date().toISOString()
        })
        if (compaction.compacted) {
          logger.info(
            `[Agente conversacional] Compactación de auditoría completada (${compaction.mode}).`
          )
        }
      }

      return {
        version: CONVERSATIONAL_RERUN_GARBAGE_CLEANUP_VERSION,
        cleanup,
        compaction
      }
    })
  } catch (error) {
    if (error?.code === 'DATABASE_ADVISORY_LOCK_BUSY') {
      logger.info('[Agente conversacional] Otra instancia ya limpia los reruns duplicados.')
      return { skipped: true, reason: 'already-running' }
    }
    throw error
  }
}

export async function runConversationalRerunGarbageCleanupUntilComplete(plan = null, {
  database = db,
  retryInitialDelayMs = CLEANUP_RETRY_INITIAL_DELAY_MS,
  retryMaxDelayMs = CLEANUP_RETRY_MAX_DELAY_MS,
  sleepFn = sleep,
  runCleanup = runConversationalRerunGarbageCleanup
} = {}) {
  let nextPlan = plan
  let retryDelayMs = Math.max(0, Number(retryInitialDelayMs) || 0)
  const maxRetryDelayMs = Math.max(retryDelayMs, Number(retryMaxDelayMs) || 0)

  while (true) {
    try {
      const result = await runCleanup(nextPlan, { database })
      if (result?.reason !== 'already-running') return result
      logger.info(
        `[Agente conversacional] La limpieza histórica sigue en otra instancia; ` +
        `se reintentará en ${retryDelayMs}ms.`
      )
    } catch (error) {
      if (
        !isTransientPostgresConnectionError(error) &&
        !CLEANUP_RETRYABLE_POSTGRES_CODES.has(String(error?.code || '').trim())
      ) throw error
      logger.warn(
        `[Agente conversacional] PostgreSQL pausó la limpieza histórica; ` +
        `se reintentará en ${retryDelayMs}ms: ${error.message}`
      )
    }

    await sleepFn(retryDelayMs)
    nextPlan = null
    retryDelayMs = Math.min(
      maxRetryDelayMs,
      Math.max(retryDelayMs + 1, retryDelayMs * 2)
    )
  }
}
