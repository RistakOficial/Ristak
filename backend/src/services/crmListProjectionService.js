import { databaseDialect, db } from '../config/database.js'
import { BACKFILL_JOB_PRIORITY } from '../jobs/backfillJobCoordinator.js'
import { scheduleProjectionBackfillJob } from '../jobs/projectionBackfillScheduler.js'
import { logger } from '../utils/logger.js'

const POSTGRES_BATCH_SIZE = 2_000
const SQLITE_BATCH_SIZE = 200
const DEFAULT_YIELD_MS = 20
const CONTACT_COVERAGE_KEY = 'contact_rows'
const CONTACT_PROJECTION_KEYS = [
  CONTACT_COVERAGE_KEY,
  'contact_payments',
  'contact_appointments',
  'contact_attendance'
]
const BACKFILL_JOB_KEY = 'crm-list-projections'
export const CRM_LIST_PROJECTION_VERSION = 1

const PROJECTIONS = Object.freeze([
  {
    key: CONTACT_COVERAGE_KEY,
    sourceTable: 'contacts',
    sourceAlias: 'source_contact',
    sourceId: 'id',
    targetTable: 'contact_list_activity',
    targetId: 'contact_id',
    sourceView: 'contacts',
    viewId: 'id',
    eligibility: '1 = 1',
    insertColumns: '(contact_id)',
    selectExpression: 'source.id',
    appendUpdatedAt: false
  },
  {
    key: 'contact_payments',
    sourceTable: 'payments',
    sourceAlias: 'source_payment',
    sourceId: 'id',
    targetTable: 'contact_payment_activity_items',
    targetId: 'payment_id',
    sourceView: 'contact_payment_activity_source',
    viewId: 'payment_id',
    eligibility: 'EXISTS (SELECT 1 FROM contacts eligible_contact WHERE eligible_contact.id = source_payment.contact_id)',
    appendUpdatedAt: false
  },
  {
    key: 'contact_appointments',
    sourceTable: 'appointments',
    sourceAlias: 'source_appointment',
    sourceId: 'id',
    targetTable: 'contact_appointment_activity_items',
    targetId: 'appointment_id',
    sourceView: 'contact_appointment_activity_source',
    viewId: 'appointment_id',
    eligibility: 'EXISTS (SELECT 1 FROM contacts eligible_contact WHERE eligible_contact.id = source_appointment.contact_id)',
    appendUpdatedAt: false
  },
  {
    key: 'contact_attendance',
    sourceTable: 'appointment_attendance_signals',
    sourceAlias: 'source_signal',
    sourceId: 'id',
    targetTable: 'contact_attendance_activity_items',
    targetId: 'signal_id',
    sourceView: 'contact_attendance_activity_source',
    viewId: 'signal_id',
    eligibility: 'EXISTS (SELECT 1 FROM contacts eligible_contact WHERE eligible_contact.id = source_signal.contact_id)',
    appendUpdatedAt: false
  },
  {
    key: 'payment_list',
    sourceTable: 'payments',
    sourceAlias: 'source_payment',
    sourceId: 'id',
    targetTable: 'payment_list_activity',
    targetId: 'payment_id',
    sourceView: 'payment_list_activity_source',
    viewId: 'payment_id',
    eligibility: '1 = 1',
    appendUpdatedAt: true
  }
])

let workerPromise = null
let workerScheduled = false
let contactProjectionReady = false
let paymentListProjectionReady = false

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)))

function isProjectionSchemaUnavailable(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || '')
  return code === '42P01' || code === '42703' || (
    code === 'SQLITE_ERROR' && /no such (?:table|column):\s*(?:crm_list_projection_state|contact_.*activity|payment_list_activity)/i.test(message)
  )
}

async function projectionState(key, database = db) {
  return database.get(`
    SELECT status, generation, processed_count
    FROM crm_list_projection_state
    WHERE projection_key = ?
    LIMIT 1
  `, [key])
}

async function hasMissingRows(projection, database = db) {
  const row = await database.get(`
    SELECT 1 AS missing
    FROM ${projection.sourceTable} ${projection.sourceAlias}
    LEFT JOIN ${projection.targetTable} projected
      ON projected.${projection.targetId} = ${projection.sourceAlias}.${projection.sourceId}
    WHERE projected.${projection.targetId} IS NULL
      AND ${projection.eligibility}
    LIMIT 1
  `)
  return Boolean(row)
}

async function backfillSqliteBatch(projection, batchSize) {
  return db.transaction(async transaction => {
    const rows = await transaction.all(`
      SELECT ${projection.sourceAlias}.${projection.sourceId} AS source_id
      FROM ${projection.sourceTable} ${projection.sourceAlias}
      LEFT JOIN ${projection.targetTable} projected
        ON projected.${projection.targetId} = ${projection.sourceAlias}.${projection.sourceId}
      WHERE projected.${projection.targetId} IS NULL
        AND ${projection.eligibility}
      ORDER BY ${projection.sourceAlias}.${projection.sourceId}
      LIMIT ?
    `, [batchSize])
    if (!rows.length) return 0

    const ids = rows.map(row => row.source_id)
    const placeholders = ids.map(() => '?').join(', ')
    await transaction.run(`
      INSERT INTO ${projection.targetTable}${projection.insertColumns ? ` ${projection.insertColumns}` : ''}
      SELECT ${projection.selectExpression || 'source.*'}${projection.appendUpdatedAt ? ', CURRENT_TIMESTAMP' : ''}
      FROM ${projection.sourceView} source
      WHERE source.${projection.viewId} IN (${placeholders})
      ON CONFLICT(${projection.targetId}) DO NOTHING
    `, ids)
    await transaction.run(`
      UPDATE crm_list_projection_state
      SET status = 'backfilling',
          processed_count = processed_count + ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE projection_key = ?
    `, [ids.length, projection.key])
    return ids.length
  })
}

async function backfillPostgresBatch(projection, batchSize) {
  const row = await db.get(`
    WITH projection_batch AS MATERIALIZED (
      SELECT ${projection.sourceAlias}.${projection.sourceId} AS source_id
      FROM ${projection.sourceTable} ${projection.sourceAlias}
      LEFT JOIN ${projection.targetTable} projected
        ON projected.${projection.targetId} = ${projection.sourceAlias}.${projection.sourceId}
      WHERE projected.${projection.targetId} IS NULL
        AND ${projection.eligibility}
      ORDER BY ${projection.sourceAlias}.${projection.sourceId}
      LIMIT ?
      FOR UPDATE OF ${projection.sourceAlias} SKIP LOCKED
    ), inserted AS (
      INSERT INTO ${projection.targetTable}${projection.insertColumns ? ` ${projection.insertColumns}` : ''}
      SELECT ${projection.selectExpression || 'source.*'}${projection.appendUpdatedAt ? ', CURRENT_TIMESTAMP' : ''}
      FROM ${projection.sourceView} source
      JOIN projection_batch batch ON batch.source_id = source.${projection.viewId}
      ON CONFLICT (${projection.targetId}) DO NOTHING
      RETURNING 1
    )
    SELECT COUNT(*) AS changes FROM projection_batch
  `, [batchSize])
  const changes = Number(row?.changes || 0)
  if (changes > 0) {
    await db.run(`
      UPDATE crm_list_projection_state
      SET status = 'backfilling',
          processed_count = processed_count + ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE projection_key = ?
    `, [changes, projection.key])
  }
  return changes
}

async function markProjectionReadyIfStable(projection) {
  const before = await projectionState(projection.key)
  if (!before || await hasMissingRows(projection)) return false

  const result = await db.run(`
    UPDATE crm_list_projection_state
    SET status = 'ready', updated_at = CURRENT_TIMESTAMP
    WHERE projection_key = ? AND generation = ?
  `, [projection.key, Number(before.generation || 0)])
  if (Number(result?.changes || 0) <= 0) return false
  return !(await hasMissingRows(projection))
}

async function runProjectionBackfill(projection, { batchSize, yieldMs }) {
  let processed = 0
  while (true) {
    const changes = databaseDialect === 'postgres'
      ? await backfillPostgresBatch(projection, batchSize)
      : await backfillSqliteBatch(projection, batchSize)
    processed += Number(changes || 0)

    if (changes === 0 && await markProjectionReadyIfStable(projection)) break
    await sleep(yieldMs)
  }
  return processed
}

export async function runCrmListProjectionBackfill({
  batchSize = databaseDialect === 'postgres' ? POSTGRES_BATCH_SIZE : SQLITE_BATCH_SIZE,
  yieldMs = DEFAULT_YIELD_MS
} = {}) {
  // El estado ready es durable porque los triggers mantienen cada mutacion en
  // la misma transaccion. En un restart no se deben repetir anti-joins contra
  // contacts/payments/appointments solo para volver a demostrarlo.
  const durableReady = await areProjectionKeysReady([
    ...CONTACT_PROJECTION_KEYS,
    'payment_list'
  ])
  if (durableReady) {
    contactProjectionReady = true
    paymentListProjectionReady = true
    return { ready: true, processed: 0, cached: true }
  }

  const safeBatchSize = Math.max(1, Math.min(Number(batchSize) || 1, 10_000))
  let processed = 0

  for (const projection of PROJECTIONS) {
    processed += await runProjectionBackfill(projection, { batchSize: safeBatchSize, yieldMs })
  }

  contactProjectionReady = true
  paymentListProjectionReady = true
  if (processed > 0) logger.info(`[CRM] Proyecciones de listas actualizadas en ${processed} fila(s).`)
  return { ready: true, processed }
}

export function scheduleCrmListProjectionBackfill() {
  if (workerScheduled || workerPromise || (contactProjectionReady && paymentListProjectionReady)) {
    return { scheduled: false, ready: contactProjectionReady && paymentListProjectionReady }
  }

  const queued = scheduleProjectionBackfillJob({
    key: BACKFILL_JOB_KEY,
    priority: BACKFILL_JOB_PRIORITY.HIGH,
    run: () => {
      workerScheduled = false
      if (workerPromise) return workerPromise
      workerPromise = runCrmListProjectionBackfill()
        .catch(error => {
          logger.warn(`[CRM] No se completó el backfill de listas: ${error.message}`)
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

async function areProjectionKeysReady(keys) {
  try {
    const placeholders = keys.map(() => '?').join(', ')
    const rows = await db.all(`
      SELECT projection_key, status
      FROM crm_list_projection_state
      WHERE projection_key IN (${placeholders})
    `, keys)
    // `ready` es una garantía durable: el worker la publica con CAS después
    // del barrido y los triggers mantienen cada mutación en la misma
    // transacción. Repetir anti-joins contra tablas millonarias en cada primer
    // GET tras un restart destruiría precisamente el hot path que protegemos.
    return rows.length === keys.length && rows.every(row => row.status === 'ready')
  } catch (error) {
    if (isProjectionSchemaUnavailable(error)) return null
    throw error
  }
}

/**
 * Snapshot O(1) para el watchdog global. Los GET nunca usan este helper para
 * arrancar trabajo; el scheduler es el unico dueño de reintentar un backfill
 * que no alcanzó a terminar durante startup.
 */
export async function readCrmListProjectionState(database = db) {
  try {
    const keys = PROJECTIONS.map(projection => projection.key)
    const placeholders = keys.map(() => '?').join(', ')
    const rows = await database.all(`
      SELECT projection_key, status
      FROM crm_list_projection_state
      WHERE projection_key IN (${placeholders})
    `, keys)
    const ready = rows.length === keys.length && rows.every(row => row.status === 'ready')
    return {
      projection_version: CRM_LIST_PROJECTION_VERSION,
      status: ready ? 'ready' : 'backfilling'
    }
  } catch (error) {
    if (isProjectionSchemaUnavailable(error)) return null
    throw error
  }
}

/**
 * Distingue tres estados que un booleano no puede representar durante un
 * despliegue: esquema ausente, proyeccion calentando y proyeccion exacta. Los
 * GET pueden leer el modelo acotado desde el primer lote sin volver a barrer
 * tablas historicas; `coverageReady` habilita el INNER JOIN/index scan una vez
 * que existe exactamente una fila liviana por contacto.
 */
export async function getContactListProjectionStatus({ schedule = false } = {}) {
  try {
    const placeholders = CONTACT_PROJECTION_KEYS.map(() => '?').join(', ')
    const rows = await db.all(`
      SELECT projection_key, status
      FROM crm_list_projection_state
      WHERE projection_key IN (${placeholders})
    `, CONTACT_PROJECTION_KEYS)
    const states = new Map(rows.map(row => [String(row.projection_key), String(row.status)]))
    const available = CONTACT_PROJECTION_KEYS.every(key => states.has(key))
    const coverageReady = available && states.get(CONTACT_COVERAGE_KEY) === 'ready'
    const ready = available && CONTACT_PROJECTION_KEYS.every(key => states.get(key) === 'ready')
    contactProjectionReady = ready
    if (available && !ready && schedule) scheduleCrmListProjectionBackfill()
    return { available, coverageReady, ready }
  } catch (error) {
    if (isProjectionSchemaUnavailable(error)) {
      return { available: false, coverageReady: false, ready: false }
    }
    throw error
  }
}

export async function isContactListProjectionReady({ schedule = false } = {}) {
  if (contactProjectionReady) return true
  const status = await getContactListProjectionStatus({ schedule })
  return status.ready
}

export async function isContactListProjectionAvailable({ schedule = false } = {}) {
  const status = await getContactListProjectionStatus({ schedule })
  return status.available
}

export async function isPaymentListProjectionReady({ schedule = false } = {}) {
  if (paymentListProjectionReady) return true
  const ready = await areProjectionKeysReady(['payment_list'])
  if (ready === null) return false
  paymentListProjectionReady = ready
  if (!ready && schedule) scheduleCrmListProjectionBackfill()
  return ready
}

const FIRST_SESSION_SELECT = `
  session.id,
  session.contact_id,
  session.visitor_id,
  session.email,
  session.started_at,
  session.created_at,
  session.page_url,
  session.referrer_url,
  session.utm_source,
  session.utm_medium,
  session.utm_campaign,
  session.utm_content,
  session.utm_term,
  session.source_platform,
  session.site_source_name,
  session.campaign_name,
  session.adset_name,
  session.ad_name,
  session.ad_id,
  session.device_type,
  session.browser,
  session.os,
  session.placement,
  session.geo_city,
  session.geo_region,
  session.geo_country
`

/**
 * Una sola ronda a DB por lote. Cada scalar subquery es un probe indexado con
 * LIMIT 1 y conserva la prioridad histórica contact_id > visitor_id > email.
 */
export async function loadFirstSessionsForContactPage(contacts = [], { chunkSize = 150 } = {}) {
  const normalized = (Array.isArray(contacts) ? contacts : [])
    .map(contact => ({
      contactId: String(contact?.id || '').trim(),
      visitorId: String(contact?.visitor_id || '').trim() || null,
      email: String(contact?.email || '').trim().toLowerCase() || null
    }))
    .filter(contact => contact.contactId)
  const result = new Map()
  const safeChunkSize = Math.max(1, Math.min(Number(chunkSize) || 1, 200))

  for (let offset = 0; offset < normalized.length; offset += safeChunkSize) {
    const chunk = normalized.slice(offset, offset + safeChunkSize)
    const values = chunk.map(() => '(?, ?, ?)').join(', ')
    const params = chunk.flatMap(contact => [contact.contactId, contact.visitorId, contact.email])
    const rows = await db.all(`
      WITH selected(contact_id, visitor_id, email) AS (VALUES ${values}),
      picked AS (
        SELECT
          selected.contact_id AS selected_contact_id,
          COALESCE(
            (SELECT direct.id FROM sessions direct
             WHERE direct.contact_id = selected.contact_id
             ORDER BY direct.started_at ASC, direct.created_at ASC, direct.id ASC LIMIT 1),
            (SELECT visitor.id FROM sessions visitor
             WHERE selected.visitor_id IS NOT NULL AND visitor.visitor_id = selected.visitor_id
             ORDER BY visitor.started_at ASC, visitor.created_at ASC, visitor.id ASC LIMIT 1),
            (SELECT email_match.id FROM sessions email_match
             WHERE selected.email IS NOT NULL AND LOWER(email_match.email) = selected.email
             ORDER BY email_match.started_at ASC, email_match.created_at ASC, email_match.id ASC LIMIT 1)
          ) AS session_id
        FROM selected
      )
      SELECT picked.selected_contact_id, ${FIRST_SESSION_SELECT}
      FROM picked
      JOIN sessions session ON session.id = picked.session_id
    `, params)
    rows.forEach(row => result.set(String(row.selected_contact_id), row))
  }
  return result
}

export const CRM_LIST_PROJECTION_LIMITS = Object.freeze({
  postgresBatchSize: POSTGRES_BATCH_SIZE,
  sqliteBatchSize: SQLITE_BATCH_SIZE,
  firstSessionChunkSize: 150
})
