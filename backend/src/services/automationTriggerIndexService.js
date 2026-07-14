import { databaseDialect, db } from '../config/database.js'
import { logger } from '../utils/logger.js'

export const AUTOMATION_WEBHOOK_SAMPLE_EVENT_TYPE = '__webhook-sample__'
export const AUTOMATION_STOP_ON_RESPONSE_EVENT_TYPE = '__contact-response-stop__'

const AUTOMATION_TRIGGER_INDEX_STATE_ID = 1
export const AUTOMATION_TRIGGER_INDEX_VERSION = 1
const AUTOMATION_TRIGGER_INDEX_LOCK = 'automation-trigger-index-bootstrap-v1'
const DEFAULT_BOOTSTRAP_BATCH_SIZE = 100
const MAX_BOOTSTRAP_BATCH_SIZE = 250
const BOOTSTRAP_RETRY_THROTTLE_MS = 5_000
const INSERT_BATCH_SIZE = 100

const TRIGGER_EVENT_TYPES = new Map([
  ['trigger-whatsapp-message', ['message-received']],
  ['trigger-click-to-whatsapp', ['message-received']],
  ['trigger-instagram-message', ['message-received']],
  ['trigger-messenger-message', ['message-received']],
  ['trigger-email-message', ['message-received']],
  ['trigger-customer-replied', ['message-received']],
  ['trigger-facebook-comment', ['comment-received']],
  ['trigger-instagram-comment', ['comment-received']],
  ['trigger-contact-created', ['contact-created']],
  [
    'trigger-contact-updated',
    [
      'contact-updated',
      'tag-changed',
      'appointment-booked',
      'appointment-status',
      'payment-received',
      'refund'
    ]
  ],
  ['trigger-contact-tag', ['tag-changed']],
  ['trigger-form-submitted', ['form-submitted']],
  ['trigger-scheduler', ['scheduler']],
  ['trigger-appointment-booked', ['appointment-booked']],
  ['trigger-appointment-status', ['appointment-status']],
  ['trigger-payment-received', ['payment-received', 'refund']],
  ['trigger-refund', ['refund']],
  ['trigger-incoming-webhook', ['webhook-received']],
  ['trigger-activation-link', ['trigger-link-clicked']],
  ['trigger-link-clicked', ['trigger-link-clicked']]
])

let bootstrapPromise = null
let lastBootstrapAttemptAt = 0

function cleanString(value) {
  return String(value || '').trim()
}

function parseFlow(rawFlow) {
  if (!rawFlow) return { nodes: [], edges: [], settings: {} }
  if (typeof rawFlow === 'object') return rawFlow
  try {
    return JSON.parse(rawFlow)
  } catch {
    return { nodes: [], edges: [], settings: {} }
  }
}

function startNodeTriggers(flow = {}) {
  const startNode = (Array.isArray(flow.nodes) ? flow.nodes : [])
    .find((node) => node?.type === 'start')
  return Array.isArray(startNode?.config?.triggers) ? startNode.config.triggers : []
}

function addEntry(entries, eventType, endpointId = '') {
  const cleanEventType = cleanString(eventType)
  if (!cleanEventType) return
  const cleanEndpointId = cleanString(endpointId)
  entries.set(`${cleanEventType}\u0000${cleanEndpointId}`, {
    eventType: cleanEventType,
    endpointId: cleanEndpointId
  })
}

export function eventTypesForAutomationTrigger(triggerType) {
  return [...(TRIGGER_EVENT_TYPES.get(cleanString(triggerType)) || [])]
}

function addFlowTriggerEntries(entries, flow) {
  for (const trigger of startNodeTriggers(flow)) {
    const triggerType = cleanString(trigger?.type)
    const eventTypes = eventTypesForAutomationTrigger(triggerType)
    if (eventTypes.length === 0) continue

    if (triggerType === 'trigger-incoming-webhook') {
      // Los webhooks productivos son exactos. Un endpoint vacío jamás debe
      // convertirse en comodín y ejecutar cualquier flujo publicado.
      const endpointId = cleanString(trigger?.config?.endpointId)
      if (endpointId) addEntry(entries, 'webhook-received', endpointId)
      continue
    }

    for (const eventType of eventTypes) addEntry(entries, eventType)
  }

  if (flow?.settings?.stopOnContactResponse === true) {
    addEntry(entries, AUTOMATION_STOP_ON_RESPONSE_EVENT_TYPE)
  }
}

/**
 * Convierte los contratos guardados de una automatización en llaves de lookup.
 *
 * - Los eventos productivos salen exclusivamente de published_flow y sólo si el
 *   estado es published.
 * - La captura de muestra usa el flow editable, incluso antes de publicar.
 * - Se deduplica por evento/endpoint porque el motor vuelve a evaluar todos los
 *   disparadores del flujo candidato antes de ejecutar.
 */
export function deriveAutomationTriggerIndexEntries(row = {}) {
  const entries = new Map()
  const draftFlow = parseFlow(row.flow)

  for (const trigger of startNodeTriggers(draftFlow)) {
    if (cleanString(trigger?.type) !== 'trigger-incoming-webhook') continue
    const endpointId = cleanString(trigger?.config?.endpointId)
    if (endpointId) addEntry(entries, AUTOMATION_WEBHOOK_SAMPLE_EVENT_TYPE, endpointId)
  }

  if (cleanString(row.status) === 'published') {
    addFlowTriggerEntries(entries, parseFlow(row.published_flow || row.flow))
  }

  return [...entries.values()]
}

function triggerIndexUnavailable(error) {
  const message = String(error?.message || '')
  return (
    /no such table:\s*automation_trigger_index/i.test(message)
    || /relation ["']?automation_trigger_index/i.test(message) && /does not exist/i.test(message)
    || /no such table:\s*automation_trigger_index_state/i.test(message)
    || /relation ["']?automation_trigger_index_state/i.test(message) && /does not exist/i.test(message)
  )
}

async function insertIndexEntries(database, automationId, entries) {
  for (let offset = 0; offset < entries.length; offset += INSERT_BATCH_SIZE) {
    const batch = entries.slice(offset, offset + INSERT_BATCH_SIZE)
    const valuesSql = batch.map(() => '(?, ?, ?, CURRENT_TIMESTAMP)').join(', ')
    const params = batch.flatMap((entry) => [automationId, entry.eventType, entry.endpointId])
    await database.run(
      `INSERT INTO automation_trigger_index (
         automation_id, event_type, endpoint_id, updated_at
       ) VALUES ${valuesSql}
       ON CONFLICT (automation_id, event_type, endpoint_id) DO UPDATE SET
         updated_at = CURRENT_TIMESTAMP`,
      params
    )
  }
}

async function replaceAutomationTriggerIndexInternal(database, row) {
  const automationId = cleanString(row?.id)
  if (!automationId) return { indexed: 0 }

  const entries = deriveAutomationTriggerIndexEntries(row)
  await database.run('DELETE FROM automation_trigger_index WHERE automation_id = ?', [automationId])
  if (entries.length > 0) await insertIndexEntries(database, automationId, entries)
  return { indexed: entries.length }
}

/** Reemplaza el índice de una automatización usando la misma transacción del caller. */
export async function replaceAutomationTriggerIndex(database, row) {
  try {
    return await replaceAutomationTriggerIndexInternal(database, row)
  } catch (error) {
    // Compatibilidad con tests, instalaciones viejas y el breve intervalo antes
    // de que la migración versionada haya creado las tablas.
    if (triggerIndexUnavailable(error)) return { skipped: true, reason: 'schema-unavailable' }
    throw error
  }
}

export async function removeAutomationTriggerIndex(database, automationId) {
  try {
    await database.run('DELETE FROM automation_trigger_index WHERE automation_id = ?', [cleanString(automationId)])
    return { removed: true }
  } catch (error) {
    if (triggerIndexUnavailable(error)) return { skipped: true, reason: 'schema-unavailable' }
    throw error
  }
}

async function readIndexState(database) {
  try {
    return await database.get(
      `SELECT status, index_version, cursor_automation_id, indexed_automations, updated_at
       FROM automation_trigger_index_state
       WHERE id = ?`,
      [AUTOMATION_TRIGGER_INDEX_STATE_ID]
    )
  } catch (error) {
    if (triggerIndexUnavailable(error)) return null
    throw error
  }
}

export async function getAutomationTriggerIndexState({ database = db } = {}) {
  const state = await readIndexState(database)
  return state
    ? {
        status: cleanString(state.status) || 'pending',
        indexVersion: Number(state.index_version || 0),
        cursorAutomationId: cleanString(state.cursor_automation_id) || null,
        indexedAutomations: Number(state.indexed_automations || 0),
        updatedAt: state.updated_at || null
      }
    : {
        status: 'unavailable',
        indexVersion: 0,
        cursorAutomationId: null,
        indexedAutomations: 0,
        updatedAt: null
      }
}

async function listAllPublishedAutomationRows(database) {
  return database.all(
    `SELECT id, name, status, flow, published_flow
     FROM automations
     WHERE status = 'published'
     ORDER BY id`
  )
}

export async function listPublishedAutomationRowsForEvent(eventType, {
  endpointId = '',
  database = db
} = {}) {
  const cleanEventType = cleanString(eventType)
  const cleanEndpointId = cleanEventType === 'webhook-received' ? cleanString(endpointId) : ''
  const state = await readIndexState(database)

  if (
    cleanString(state?.status) === 'ready'
    && Number(state?.index_version || 0) === AUTOMATION_TRIGGER_INDEX_VERSION
  ) {
    try {
      const rows = await database.all(
        `SELECT a.id, a.name, a.status, a.flow, a.published_flow
         FROM automation_trigger_index ati
         INNER JOIN automations a ON a.id = ati.automation_id
         WHERE ati.event_type = ?
           AND ati.endpoint_id = ?
           AND a.status = 'published'
         ORDER BY a.id`,
        [cleanEventType, cleanEndpointId]
      )
      return { rows, indexed: true }
    } catch (error) {
      if (!triggerIndexUnavailable(error)) throw error
    }
  }

  scheduleAutomationTriggerIndexBootstrap().catch(() => undefined)
  return { rows: await listAllPublishedAutomationRows(database), indexed: false }
}

export async function listPublishedAutomationRowsByIds(automationIds, { database = db } = {}) {
  const ids = [...new Set((Array.isArray(automationIds) ? automationIds : [])
    .map(cleanString)
    .filter(Boolean))]
  if (ids.length === 0) return []

  const rows = []
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100)
    rows.push(...await database.all(
      `SELECT id, name, status, flow, published_flow
       FROM automations
       WHERE status = 'published'
         AND id IN (${batch.map(() => '?').join(', ')})`,
      batch
    ))
  }
  return rows
}

export async function listDraftAutomationRowsForWebhookEndpoint(endpointId, { database = db } = {}) {
  const cleanEndpointId = cleanString(endpointId)
  if (!cleanEndpointId) return { rows: [], indexed: true }
  const state = await readIndexState(database)

  if (
    cleanString(state?.status) === 'ready'
    && Number(state?.index_version || 0) === AUTOMATION_TRIGGER_INDEX_VERSION
  ) {
    try {
      const rows = await database.all(
        `SELECT a.id, a.flow, a.updated_at
         FROM automation_trigger_index ati
         INNER JOIN automations a ON a.id = ati.automation_id
         WHERE ati.event_type = ?
           AND ati.endpoint_id = ?
         ORDER BY a.updated_at DESC, a.id DESC`,
        [AUTOMATION_WEBHOOK_SAMPLE_EVENT_TYPE, cleanEndpointId]
      )
      return { rows, indexed: true }
    } catch (error) {
      if (!triggerIndexUnavailable(error)) throw error
    }
  }

  scheduleAutomationTriggerIndexBootstrap().catch(() => undefined)
  return {
    rows: await database.all('SELECT id, flow, updated_at FROM automations ORDER BY updated_at DESC, id DESC'),
    indexed: false
  }
}

function normalizeBootstrapBatchSize(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_BOOTSTRAP_BATCH_SIZE
  return Math.max(1, Math.min(MAX_BOOTSTRAP_BATCH_SIZE, parsed))
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

async function runBootstrapWithLock(database, {
  batchSize,
  force,
  yieldBetweenBatches
}) {
  const existingState = await readIndexState(database)
  if (!existingState) return { skipped: true, reason: 'schema-unavailable' }
  const versionMismatch = Number(existingState.index_version || 0) !== AUTOMATION_TRIGGER_INDEX_VERSION
  if (cleanString(existingState.status) === 'ready' && !force && !versionMismatch) {
    return { skipped: true, reason: 'already-ready', indexedAutomations: Number(existingState.indexed_automations || 0) }
  }

  if (force || versionMismatch) {
    await database.transaction(async (tx) => {
      await tx.run('DELETE FROM automation_trigger_index')
      await tx.run(
        `UPDATE automation_trigger_index_state
         SET status = 'pending', index_version = ?, cursor_automation_id = NULL,
             indexed_automations = 0, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [AUTOMATION_TRIGGER_INDEX_VERSION, AUTOMATION_TRIGGER_INDEX_STATE_ID]
      )
    })
  }

  const state = force || versionMismatch ? null : existingState
  let cursor = cleanString(state?.cursor_automation_id)
  let indexedAutomations = Number(state?.indexed_automations || 0)
  await database.run(
    `UPDATE automation_trigger_index_state
     SET status = 'running', index_version = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [AUTOMATION_TRIGGER_INDEX_VERSION, AUTOMATION_TRIGGER_INDEX_STATE_ID]
  )

  while (true) {
    const ids = await database.all(
      `SELECT id
       FROM automations
       WHERE id > ?
       ORDER BY id
       LIMIT ?`,
      [cursor, batchSize]
    )
    if (ids.length === 0) break

    const batchIds = ids.map((row) => cleanString(row.id)).filter(Boolean)
    const nextCursor = cleanString(ids[ids.length - 1]?.id) || cursor
    await database.transaction(async (tx) => {
      const lockSuffix = databaseDialect === 'postgres' ? ' FOR UPDATE' : ''
      const rows = batchIds.length > 0
        ? await tx.all(
            `SELECT id, status, flow, published_flow
             FROM automations
             WHERE id IN (${batchIds.map(() => '?').join(', ')})
             ORDER BY id${lockSuffix}`,
            batchIds
          )
        : []

      for (const row of rows) {
        await replaceAutomationTriggerIndexInternal(tx, row)
      }

      indexedAutomations += rows.length
      await tx.run(
        `UPDATE automation_trigger_index_state
         SET cursor_automation_id = ?, indexed_automations = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [nextCursor, indexedAutomations, AUTOMATION_TRIGGER_INDEX_STATE_ID]
      )
    })

    cursor = nextCursor
    if (yieldBetweenBatches) await yieldToEventLoop()
  }

  await database.transaction(async (tx) => {
    await tx.run(
      `DELETE FROM automation_trigger_index
       WHERE NOT EXISTS (
         SELECT 1 FROM automations a WHERE a.id = automation_trigger_index.automation_id
       )`
    )
    await tx.run(
      `UPDATE automation_trigger_index_state
       SET status = 'ready', index_version = ?, cursor_automation_id = NULL,
           indexed_automations = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [AUTOMATION_TRIGGER_INDEX_VERSION, indexedAutomations, AUTOMATION_TRIGGER_INDEX_STATE_ID]
    )
  })

  return { completed: true, indexedAutomations }
}

export async function runAutomationTriggerIndexBootstrap({
  database = db,
  batchSize = DEFAULT_BOOTSTRAP_BATCH_SIZE,
  force = false,
  yieldBetweenBatches = true
} = {}) {
  const options = {
    batchSize: normalizeBootstrapBatchSize(batchSize),
    force: force === true,
    yieldBetweenBatches: yieldBetweenBatches !== false
  }

  try {
    if (typeof database.withAdvisoryLock === 'function') {
      return await database.withAdvisoryLock(
        AUTOMATION_TRIGGER_INDEX_LOCK,
        () => runBootstrapWithLock(database, options)
      )
    }
    return await runBootstrapWithLock(database, options)
  } catch (error) {
    if (triggerIndexUnavailable(error)) return { skipped: true, reason: 'schema-unavailable' }
    if (error?.code === 'DATABASE_ADVISORY_LOCK_BUSY') {
      return { skipped: true, reason: 'another-instance-running' }
    }
    throw error
  }
}

/** Agenda el backfill durable sin convertirlo en compuerta del arranque HTTP. */
export function scheduleAutomationTriggerIndexBootstrap({ force = false } = {}) {
  const now = Date.now()
  if (bootstrapPromise) return bootstrapPromise
  if (!force && now - lastBootstrapAttemptAt < BOOTSTRAP_RETRY_THROTTLE_MS) {
    return Promise.resolve({ skipped: true, reason: 'throttled' })
  }

  lastBootstrapAttemptAt = now
  bootstrapPromise = runAutomationTriggerIndexBootstrap({ force })
    .then((result) => {
      if (result?.completed) {
        logger.info(`[Automatizaciones] Índice de disparadores listo: ${result.indexedAutomations} automatización(es) revisadas.`)
      }
      return result
    })
    .finally(() => {
      bootstrapPromise = null
    })
  return bootstrapPromise
}
