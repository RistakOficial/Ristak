import { databaseDialect, db } from '../config/database.js'
import { BACKFILL_JOB_PRIORITY } from '../jobs/backfillJobCoordinator.js'
import { scheduleProjectionBackfillJob } from '../jobs/projectionBackfillScheduler.js'
import { logger } from '../utils/logger.js'

const WHATSAPP_STATUS_PROJECTION_VERSION = 1

const EMPTY_STATS = Object.freeze({
  phoneNumbers: 0,
  contacts: 0,
  messages: 0,
  inboundMessages: 0,
  outboundMessages: 0,
  attributedMessages: 0,
  webhookEvents: 0,
  templates: 0,
  approvedTemplates: 0,
  activeAlerts: 0,
  criticalAlerts: 0,
  templateSends: 0
})

const METRIC_FIELDS = Object.freeze({
  phone_numbers: 'phoneNumbers',
  contacts: 'contacts',
  messages: 'messages',
  inbound_messages: 'inboundMessages',
  outbound_messages: 'outboundMessages',
  attributed_messages: 'attributedMessages',
  webhook_events: 'webhookEvents',
  templates: 'templates',
  approved_templates: 'approvedTemplates',
  active_alerts: 'activeAlerts',
  critical_alerts: 'criticalAlerts',
  template_sends: 'templateSends'
})

const WHATSAPP_STATUS_BACKFILL_KEY = 'whatsapp-status-projection'
const METRIC_DELTA_BATCH_SIZE = 5_000
const ROUTING_DELTA_BATCH_SIZE = 500
const MAX_DELTA_BATCHES_PER_RUN = 20
const PROJECTION_MONITOR_MS = 15_000

let projectionMonitor = null
let projectionRetryTimer = null

function asCount(value) {
  const count = Number(value || 0)
  return Number.isFinite(count) ? Math.max(0, count) : 0
}

function mapProjectionRows(rows = []) {
  const stats = { ...EMPTY_STATS }
  const pendingRestoreCounts = new Map()
  let metricCount = 0
  let projectionStatus = 'backfilling'

  for (const row of rows) {
    if (row.projection_status) projectionStatus = String(row.projection_status)
    if (row.kind === 'stat') {
      const field = METRIC_FIELDS[String(row.key || '')]
      if (!field) continue
      stats[field] = asCount(row.value)
      metricCount += 1
      continue
    }

    if (row.kind === 'restore') {
      const phoneNumberId = String(row.key || '').trim()
      const count = asCount(row.value)
      if (phoneNumberId && count > 0) pendingRestoreCounts.set(phoneNumberId, count)
    }
  }

  if (metricCount !== Object.keys(METRIC_FIELDS).length) return null
  const ready = projectionStatus === 'ready'
  return {
    stats,
    pendingRestoreCounts,
    source: ready ? 'projection' : 'warming',
    ready,
    projectionStatus
  }
}

async function readProjectionSnapshot() {
  const rows = await db.all(`
    SELECT 'stat' AS kind, counters.metric AS key,
           SUM(counters.counter_value) AS value,
           MAX(state.status) AS projection_status
    FROM whatsapp_status_metric_counters counters
    JOIN whatsapp_status_projection_state state
      ON state.singleton_id = 1
     AND state.projection_version = ?
     AND state.status IN ('backfilling', 'replaying', 'ready')
    GROUP BY counters.metric

    UNION ALL

    SELECT 'restore' AS kind, restores.previous_phone_number_id AS key,
           restores.contact_count AS value,
           MAX(state.status) AS projection_status
    FROM whatsapp_contingency_restore_counts restores
    JOIN whatsapp_status_projection_state state
      ON state.singleton_id = 1
     AND state.projection_version = ?
     AND state.status IN ('backfilling', 'replaying', 'ready')
    WHERE restores.contact_count > 0
    GROUP BY restores.previous_phone_number_id, restores.contact_count
  `, [WHATSAPP_STATUS_PROJECTION_VERSION, WHATSAPP_STATUS_PROJECTION_VERSION])

  return mapProjectionRows(rows)
}

async function readProjectionState(database = db, { lock = false, dialect = databaseDialect } = {}) {
  const rowLock = lock && dialect === 'postgres' ? ' FOR UPDATE' : ''
  return database.get(`
    SELECT projection_version, status
    FROM whatsapp_status_projection_state
    WHERE singleton_id = 1${rowLock}
  `).catch(() => null)
}

async function buildPostgresBaseline(database = db, { dialect = databaseDialect } = {}) {
  return database.transaction(async (transaction) => {
    await transaction.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    const state = await readProjectionState(transaction, { lock: true, dialect })
    if (!state || Number(state.projection_version) !== WHATSAPP_STATUS_PROJECTION_VERSION) {
      return { skipped: true, reason: 'state-unavailable' }
    }
    if (state.status === 'ready' || state.status === 'replaying') {
      return { skipped: true, reason: state.status }
    }

    const [metricDelta, routingDelta] = await Promise.all([
      transaction.get('SELECT COALESCE(MAX(id), 0) AS max_id FROM whatsapp_status_metric_deltas'),
      transaction.get('SELECT COALESCE(MAX(id), 0) AS max_id FROM whatsapp_status_routing_deltas')
    ])
    const metricDeltaMax = Number(metricDelta?.max_id || 0)
    const routingDeltaMax = Number(routingDelta?.max_id || 0)

    await transaction.run('DELETE FROM whatsapp_status_metric_counters')
    await transaction.run(`
      INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
      SELECT 'phone_numbers', 0, COUNT(*) FROM whatsapp_api_phone_numbers
      UNION ALL SELECT 'contacts', 0, COUNT(*) FROM whatsapp_api_contacts
      UNION ALL SELECT 'messages', 0, COUNT(*) FROM whatsapp_api_messages
      UNION ALL SELECT 'inbound_messages', 0, COUNT(*) FROM whatsapp_api_messages WHERE direction = 'inbound'
      UNION ALL SELECT 'outbound_messages', 0, COUNT(*) FROM whatsapp_api_messages WHERE direction IN ('outbound', 'business_echo')
      UNION ALL SELECT 'attributed_messages', 0, COUNT(*) FROM whatsapp_api_attribution
      UNION ALL SELECT 'webhook_events', 0, COUNT(*) FROM whatsapp_api_webhook_events
      UNION ALL SELECT 'templates', 0, COUNT(*) FROM whatsapp_api_templates
      UNION ALL SELECT 'approved_templates', 0, COUNT(*) FROM whatsapp_api_templates WHERE status = 'APPROVED'
      UNION ALL SELECT 'active_alerts', 0, COUNT(*) FROM whatsapp_api_alerts WHERE status = 'active'
      UNION ALL SELECT 'critical_alerts', 0, COUNT(*) FROM whatsapp_api_alerts WHERE status = 'active' AND severity = 'critical'
      UNION ALL SELECT 'template_sends', 0, COUNT(*) FROM whatsapp_api_template_sends
    `)

    await transaction.run(`
      INSERT INTO whatsapp_routing_latest_projection (
        contact_id, latest_event_id, previous_phone_number_id,
        new_phone_number_id, source, event_created_at, updated_at
      )
      SELECT DISTINCT ON (event.contact_id)
        event.contact_id, event.id, event.previous_phone_number_id,
        event.new_phone_number_id, COALESCE(event.source, ''), event.created_at,
        CURRENT_TIMESTAMP
      FROM whatsapp_routing_events event
      ORDER BY event.contact_id, event.created_at DESC, event.id DESC
      ON CONFLICT(contact_id) DO UPDATE SET
        latest_event_id = EXCLUDED.latest_event_id,
        previous_phone_number_id = EXCLUDED.previous_phone_number_id,
        new_phone_number_id = EXCLUDED.new_phone_number_id,
        source = EXCLUDED.source,
        event_created_at = EXCLUDED.event_created_at,
        updated_at = CURRENT_TIMESTAMP
      WHERE (
        EXCLUDED.event_created_at,
        EXCLUDED.latest_event_id
      ) > (
        whatsapp_routing_latest_projection.event_created_at,
        whatsapp_routing_latest_projection.latest_event_id
      )
    `)

    if (metricDeltaMax > 0) {
      await transaction.run(
        'UPDATE whatsapp_status_metric_deltas SET applied = TRUE WHERE id <= ?',
        [metricDeltaMax]
      )
    }
    if (routingDeltaMax > 0) {
      await transaction.run(
        'UPDATE whatsapp_status_routing_deltas SET applied = TRUE WHERE id <= ?',
        [routingDeltaMax]
      )
    }
    await transaction.run(`
      UPDATE whatsapp_status_projection_state
      SET status = 'replaying', updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = 1 AND projection_version = ?
    `, [WHATSAPP_STATUS_PROJECTION_VERSION])
    return { skipped: false, metricDeltaMax, routingDeltaMax }
  })
}

function aggregateMetricDeltas(rows = []) {
  const aggregates = new Map()
  for (const row of rows) {
    const key = `${row.metric}\n${row.shard}`
    const current = aggregates.get(key) || {
      metric: row.metric,
      shard: Number(row.shard || 0),
      delta: 0
    }
    current.delta += Number(row.delta || 0)
    aggregates.set(key, current)
  }
  return [...aggregates.values()]
}

async function drainPostgresDeltaBatch(database = db, { dialect = databaseDialect } = {}) {
  return database.transaction(async (transaction) => {
    const state = await readProjectionState(transaction, { lock: true, dialect })
    if (!state || Number(state.projection_version) !== WHATSAPP_STATUS_PROJECTION_VERSION) {
      return { ready: false, processed: 0, reason: 'state-unavailable' }
    }

    const [metricRows, routingRows] = await Promise.all([
      transaction.all(`
        SELECT id, metric, shard, delta
        FROM whatsapp_status_metric_deltas
        WHERE applied = FALSE
        ORDER BY id ASC
        LIMIT ?
      `, [METRIC_DELTA_BATCH_SIZE]),
      transaction.all(`
        SELECT id, contact_id
        FROM whatsapp_status_routing_deltas
        WHERE applied = FALSE
        ORDER BY id ASC
        LIMIT ?
      `, [ROUTING_DELTA_BATCH_SIZE])
    ])

    for (const aggregate of aggregateMetricDeltas(metricRows)) {
      await transaction.run(`
        INSERT INTO whatsapp_status_metric_counters (
          metric, shard, counter_value, updated_at
        ) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(metric, shard) DO UPDATE SET
          counter_value = whatsapp_status_metric_counters.counter_value + EXCLUDED.counter_value,
          updated_at = CURRENT_TIMESTAMP
      `, [aggregate.metric, aggregate.shard, aggregate.delta])
    }
    if (metricRows.length) {
      await transaction.run(
        `UPDATE whatsapp_status_metric_deltas
         SET applied = TRUE
         WHERE id IN (${metricRows.map(() => '?').join(', ')})`,
        metricRows.map(row => row.id)
      )
    }

    if (routingRows.length) {
      await transaction.all(`
        SELECT ristak_recompute_whatsapp_routing_projection(pending.contact_id, FALSE)
        FROM (
          SELECT DISTINCT contact_id
          FROM whatsapp_status_routing_deltas
          WHERE id IN (${routingRows.map(() => '?').join(', ')})
        ) pending
      `, routingRows.map(row => row.id))
      await transaction.run(
        `UPDATE whatsapp_status_routing_deltas
         SET applied = TRUE
         WHERE id IN (${routingRows.map(() => '?').join(', ')})`,
        routingRows.map(row => row.id)
      )
    }

    const pending = await transaction.get(`
      SELECT
        EXISTS(SELECT 1 FROM whatsapp_status_metric_deltas WHERE applied = FALSE LIMIT 1) AS metric_pending,
        EXISTS(SELECT 1 FROM whatsapp_status_routing_deltas WHERE applied = FALSE LIMIT 1) AS routing_pending
    `)
    const hasPending = pending?.metric_pending === true || pending?.routing_pending === true ||
      Number(pending?.metric_pending || 0) === 1 || Number(pending?.routing_pending || 0) === 1

    if (!hasPending) {
      await transaction.run('DELETE FROM whatsapp_contingency_restore_counts')
      await transaction.run(`
        INSERT INTO whatsapp_contingency_restore_counts (
          previous_phone_number_id, contact_count, updated_at
        )
        SELECT previous_phone_number_id, COUNT(*), CURRENT_TIMESTAMP
        FROM whatsapp_routing_latest_projection
        WHERE source = 'contingency'
          AND previous_phone_number_id IS NOT NULL
        GROUP BY previous_phone_number_id
      `)
      await transaction.run(`
        UPDATE whatsapp_status_projection_state
        SET status = 'ready', updated_at = CURRENT_TIMESTAMP
        WHERE singleton_id = 1 AND projection_version = ?
      `, [WHATSAPP_STATUS_PROJECTION_VERSION])
    }

    await transaction.run(`
      DELETE FROM whatsapp_status_metric_deltas
      WHERE id IN (
        SELECT id FROM whatsapp_status_metric_deltas
        WHERE applied = TRUE ORDER BY id ASC LIMIT 10000
      )
    `)
    await transaction.run(`
      DELETE FROM whatsapp_status_routing_deltas
      WHERE id IN (
        SELECT id FROM whatsapp_status_routing_deltas
        WHERE applied = TRUE ORDER BY id ASC LIMIT 10000
      )
    `)
    return {
      ready: !hasPending,
      processed: metricRows.length + routingRows.length,
      metricDeltas: metricRows.length,
      routingDeltas: routingRows.length
    }
  })
}

function retryWhatsAppStatusProjection(delayMs = 1_000) {
  if (projectionRetryTimer) return
  projectionRetryTimer = setTimeout(() => {
    projectionRetryTimer = null
    scheduleWhatsAppStatusProjectionBackfill()
  }, delayMs)
  projectionRetryTimer.unref?.()
}

export async function rebuildWhatsAppStatusProjection({
  database = db,
  dialect = databaseDialect
} = {}) {
  if (dialect !== 'postgres') return { ready: true, skipped: true, reason: 'sqlite-eager' }
  const state = await readProjectionState(database, { dialect })
  if (!state) return { ready: false, skipped: true, reason: 'state-unavailable' }

  if (state.status === 'backfilling' || state.status === 'failed') {
    await buildPostgresBaseline(database, { dialect })
  }

  let result = { ready: false, processed: 0 }
  for (let batch = 0; batch < MAX_DELTA_BATCHES_PER_RUN; batch += 1) {
    const current = await drainPostgresDeltaBatch(database, { dialect })
    result = {
      ...current,
      processed: Number(result.processed || 0) + Number(current.processed || 0),
      batches: batch + 1
    }
    if (current.ready || current.processed === 0) break
  }
  if (database === db) {
    if (!result.ready) retryWhatsAppStatusProjection()
    else retryWhatsAppStatusProjection(2_000)
  }
  return result
}

export function scheduleWhatsAppStatusProjectionBackfill() {
  return scheduleProjectionBackfillJob({
    key: WHATSAPP_STATUS_BACKFILL_KEY,
    priority: BACKFILL_JOB_PRIORITY.HIGH,
    run: rebuildWhatsAppStatusProjection,
    onError: (error) => {
      logger.warn(`[WhatsApp] No se pudo converger status local: ${error.message}`)
      retryWhatsAppStatusProjection()
    }
  })
}

export function startWhatsAppStatusProjectionScheduler() {
  if (projectionMonitor || databaseDialect !== 'postgres') return
  scheduleWhatsAppStatusProjectionBackfill()
  projectionMonitor = setInterval(
    scheduleWhatsAppStatusProjectionBackfill,
    PROJECTION_MONITOR_MS
  )
  projectionMonitor.unref?.()
}

export function stopWhatsAppStatusProjectionScheduler() {
  if (projectionMonitor) clearInterval(projectionMonitor)
  if (projectionRetryTimer) clearTimeout(projectionRetryTimer)
  projectionMonitor = null
  projectionRetryTimer = null
}

/**
 * Snapshot local usado por Chats, Contactos y Configuración.
 *
 * Sólo toca tablas acotadas (12 métricas x 64 shards como máximo y una fila por
 * número con restauraciones). Durante el primer rollout devuelve el snapshot
 * parcial con `source=warming`; jamás ejecuta COUNT/GROUP BY histórico desde GET.
 */
export async function getWhatsAppStatusProjectionSnapshot() {
  try {
    const projected = await readProjectionSnapshot()
    if (projected) return projected
  } catch {
    // Rolling deploy anterior a 102*: respuesta acotada en vez de full scan.
  }
  return {
    stats: { ...EMPTY_STATS },
    pendingRestoreCounts: new Map(),
    source: 'warming',
    ready: false,
    projectionStatus: 'unavailable'
  }
}

export function __resetWhatsAppStatusProjectionForTest() {
  if (projectionRetryTimer) clearTimeout(projectionRetryTimer)
  projectionRetryTimer = null
}
