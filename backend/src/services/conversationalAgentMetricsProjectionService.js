import { databaseDialect, db } from '../config/database.js'
import { BACKFILL_JOB_PRIORITY } from '../jobs/backfillJobCoordinator.js'
import { scheduleProjectionBackfillJob } from '../jobs/projectionBackfillScheduler.js'
import { logger } from '../utils/logger.js'

export const CONVERSATIONAL_AGENT_METRICS_PROJECTION_VERSION = 1

const BATCH_SIZE = databaseDialect === 'postgres' ? 1_000 : 180
const MAX_BATCHES_PER_RUN = 10_000
const WORKER_YIELD_MS = 10
const BACKFILL_JOB_KEY = 'conversational-agent-metrics-projection'

let workerPromise = null
let workerScheduled = false

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))

function placeholders(values) {
  return values.map(() => '?').join(', ')
}

function projectionUnavailable(error) {
  return /(?:no such table|no such column|does not exist|undefined table|undefined column).*?(?:conversational_agent_(?:state|event)_metric|conversational_agent_metrics_projection|agent_metrics_projection_version)|(?:conversational_agent_(?:state|event)_metric|conversational_agent_metrics_projection|agent_metrics_projection_version).*?(?:no such|does not exist)/i
    .test(String(error?.message || ''))
}

export async function readConversationalAgentMetricsProjectionState(database = db) {
  return database.get(`
    SELECT singleton_id, projection_version, status, last_error
    FROM conversational_agent_metrics_projection_state
    WHERE singleton_id = 1
  `).catch(() => null)
}

function conversationalAgentMetricsProjectionStateIsReady(state) {
  return Number(state?.projection_version) === CONVERSATIONAL_AGENT_METRICS_PROJECTION_VERSION &&
    String(state?.status || '').toLowerCase() === 'ready'
}

async function isConversationalAgentMetricsProjectionDurablyReady(database = db) {
  return conversationalAgentMetricsProjectionStateIsReady(
    await readConversationalAgentMetricsProjectionState(database)
  )
}

async function hasPendingRows(database = db) {
  const stateRow = await database.get(`
    SELECT id
    FROM conversational_agent_state
    WHERE agent_metrics_projection_version < ?
    LIMIT 1
  `, [CONVERSATIONAL_AGENT_METRICS_PROJECTION_VERSION])
  if (stateRow) return true

  const eventRow = await database.get(`
    SELECT id
    FROM conversational_agent_events
    WHERE agent_metrics_projection_version < ?
    LIMIT 1
  `, [CONVERSATIONAL_AGENT_METRICS_PROJECTION_VERSION])
  return Boolean(eventRow)
}

/**
 * Readiness vive en el singleton de la base. Los triggers mantienen las
 * escrituras nuevas proyectadas y el worker certifica el cierre del historico;
 * ninguna lectura interactiva necesita volver a tocar las tablas raw.
 */
export async function isConversationalAgentMetricsProjectionReady() {
  try {
    return await isConversationalAgentMetricsProjectionDurablyReady(db)
  } catch {
    return false
  }
}

export async function getConversationalAgentMetricsProjectionStatus() {
  const state = await readConversationalAgentMetricsProjectionState()
  if (!state || Number(state.projection_version) !== CONVERSATIONAL_AGENT_METRICS_PROJECTION_VERSION) {
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

const stateMetricColumns = `
  agent_id,
  total_conversations,
  assigned_conversations,
  completed_conversations,
  paused_conversations,
  human_takeovers,
  skipped_conversations,
  discarded_conversations,
  answered_conversations,
  last_activity_at
`

const eventMetricSums = `
  COALESCE(SUM(total_events), 0) AS total_events,
  COALESCE(SUM(success_events), 0) AS success_events,
  COALESCE(SUM(error_events), 0) AS error_events,
  COALESCE(SUM(assigned_events), 0) AS assigned_events,
  COALESCE(SUM(reply_events), 0) AS reply_events,
  COALESCE(SUM(appointment_events), 0) AS appointment_events,
  COALESCE(SUM(payment_link_events), 0) AS payment_link_events,
  COALESCE(SUM(goal_completion_events), 0) AS goal_completion_events,
  COALESCE(SUM(follow_up_sent_events), 0) AS follow_up_sent_events,
  COALESCE(SUM(follow_up_suppressed_events), 0) AS follow_up_suppressed_events,
  COALESCE(SUM(human_handoff_events), 0) AS human_handoff_events,
  COALESCE(SUM(tool_failure_events), 0) AS tool_failure_events
`

async function loadProjectionSnapshot(database = db, projectionStatus = 'ready') {
  const [stateSummaryRows, eventSummary] = await Promise.all([
    database.all(`
      SELECT ${stateMetricColumns}
      FROM conversational_agent_state_metric_summary
      ORDER BY agent_id ASC
    `),
    database.get(`
      SELECT ${eventMetricSums}
      FROM conversational_agent_event_metric_summary
    `)
  ])
  return {
    stateSummaryRows,
    eventSummary: eventSummary || {},
    projectionReady: projectionStatus === 'ready',
    projectionStatus
  }
}

/**
 * Las lecturas interactivas consumen exclusivamente el snapshot materializado.
 * Durante el backfill puede ser parcial, pero su costo no crece con el
 * historico y projectionStatus deja claro que aun esta convergiendo.
 */
export async function loadConversationalAgentMetricAggregates() {
  const status = await getConversationalAgentMetricsProjectionStatus()
  if (!status.available) {
    return {
      stateSummaryRows: [],
      eventSummary: {},
      projectionReady: false,
      projectionStatus: 'unavailable'
    }
  }
  try {
    return await loadProjectionSnapshot(db, status.status)
  } catch (error) {
    if (!projectionUnavailable(error)) throw error
    return {
      stateSummaryRows: [],
      eventSummary: {},
      projectionReady: false,
      projectionStatus: 'unavailable'
    }
  }
}

async function backfillSourceBatch(database, { table, updateColumn }) {
  const rows = await database.all(`
    SELECT id
    FROM ${table}
    WHERE agent_metrics_projection_version < ?
    ORDER BY id
    LIMIT ?
  `, [CONVERSATIONAL_AGENT_METRICS_PROJECTION_VERSION, BATCH_SIZE])
  if (!rows.length) return 0

  const ids = rows.map(row => String(row.id || '')).filter(Boolean)
  if (!ids.length) return 0
  const result = await database.run(`
    UPDATE ${table}
    SET ${updateColumn} = ${updateColumn}
    WHERE id IN (${placeholders(ids)})
  `, ids)
  return Number(result?.changes ?? result?.rowCount ?? ids.length)
}

async function tryMarkReady(database) {
  const result = await database.run(`
    UPDATE conversational_agent_metrics_projection_state
    SET status = 'ready', last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE singleton_id = 1
      AND projection_version = ?
      AND NOT EXISTS (
        SELECT 1
        FROM conversational_agent_state
        WHERE agent_metrics_projection_version < ?
        LIMIT 1
      )
      AND NOT EXISTS (
        SELECT 1
        FROM conversational_agent_events
        WHERE agent_metrics_projection_version < ?
        LIMIT 1
      )
  `, [
    CONVERSATIONAL_AGENT_METRICS_PROJECTION_VERSION,
    CONVERSATIONAL_AGENT_METRICS_PROJECTION_VERSION,
    CONVERSATIONAL_AGENT_METRICS_PROJECTION_VERSION
  ])
  return Number(result?.changes ?? result?.rowCount ?? 0) > 0
}

async function runUnlockedBackfill(database = db) {
  // Un proceso nuevo confia en la certificacion durable de la instancia que ya
  // convergio. Esto mantiene cada restart en O(1), incluso con millones de rows.
  if (await isConversationalAgentMetricsProjectionDurablyReady(database)) {
    return { ready: true, skipped: true, passes: 0 }
  }

  await database.run(`
    UPDATE conversational_agent_metrics_projection_state
    SET status = CASE WHEN status = 'ready' THEN status ELSE 'backfilling' END,
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE singleton_id = 1
  `)

  for (let pass = 0; pass < MAX_BATCHES_PER_RUN; pass += 1) {
    let changed = 0
    changed += await backfillSourceBatch(database, {
      table: 'conversational_agent_state',
      updateColumn: 'agent_id'
    })
    changed += await backfillSourceBatch(database, {
      table: 'conversational_agent_events',
      updateColumn: 'event_type'
    })

    if (!changed) {
      if (await tryMarkReady(database)) return { ready: true, passes: pass + 1 }
      if (!(await hasPendingRows(database))) {
        return {
          ready: await isConversationalAgentMetricsProjectionDurablyReady(database),
          passes: pass + 1
        }
      }
    }
    if (pass % 10 === 9) await sleep(WORKER_YIELD_MS)
  }
  return { ready: false, exhausted: true }
}

export async function runConversationalAgentMetricsProjectionBackfill() {
  if (workerPromise) return workerPromise
  workerPromise = (async () => {
    try {
      if (typeof db.withAdvisoryLock === 'function') {
        return await db.withAdvisoryLock(
          'conversational-agent-metrics-projection',
          lockedDb => runUnlockedBackfill(lockedDb || db)
        )
      }
      return await runUnlockedBackfill(db)
    } catch (error) {
      if (error?.code === 'DATABASE_ADVISORY_LOCK_BUSY') {
        setTimeout(() => scheduleConversationalAgentMetricsProjectionBackfill(), 250)
        return { ready: false, busy: true }
      }
      if (projectionUnavailable(error)) return { ready: false, unavailable: true }

      await db.run(`
        UPDATE conversational_agent_metrics_projection_state
        SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE singleton_id = 1 AND status = 'backfilling'
      `, [String(error?.message || error).slice(0, 1200)]).catch(() => undefined)
      logger.error(`No se pudo converger la proyeccion de metricas del Agente IA: ${error.message}`)
      throw error
    } finally {
      workerPromise = null
    }
  })()
  return workerPromise
}

export function scheduleConversationalAgentMetricsProjectionBackfill() {
  if (workerPromise || workerScheduled) return { scheduled: false }
  const queued = scheduleProjectionBackfillJob({
    key: BACKFILL_JOB_KEY,
    priority: BACKFILL_JOB_PRIORITY.LOW,
    run: async () => {
      workerScheduled = false
      const result = await runConversationalAgentMetricsProjectionBackfill()
      if (result?.exhausted) {
        setTimeout(() => scheduleConversationalAgentMetricsProjectionBackfill(), 100)
      }
      return result
    }
  })
  workerScheduled = queued.scheduled
  return { scheduled: queued.scheduled }
}
