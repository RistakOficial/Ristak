import { databaseDialect, db } from '../config/database.js'
import { BACKFILL_JOB_PRIORITY } from '../jobs/backfillJobCoordinator.js'
import { scheduleProjectionBackfillJob } from '../jobs/projectionBackfillScheduler.js'
import { buildPhoneMatchCandidates, normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { logger } from '../utils/logger.js'

export const CHAT_ACTIVITY_PROJECTION_VERSION = 1
const BATCH_SIZE = databaseDialect === 'postgres' ? 1_000 : 180
const IDENTITY_ROWS_PER_TRANSACTION = 2
const MAX_BATCHES_PER_RUN = 10_000
const WORKER_YIELD_MS = 10
const BACKFILL_JOB_KEY = 'chat-activity-projection'

let workerPromise = null
let workerScheduled = false

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))

function placeholders(values) {
  return values.map(() => '?').join(', ')
}

export async function readChatActivityProjectionState(database = db, options = {}) {
  return database.get(`
    SELECT singleton_id, projection_version, status, revision, last_error
    FROM chat_activity_projection_state
    WHERE singleton_id = 1
  `, [], options?.signal ? { signal: options.signal } : undefined).catch(error => {
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error
    return null
  })
}

function chatActivityProjectionStateIsReady(state) {
  return Number(state?.projection_version) === CHAT_ACTIVITY_PROJECTION_VERSION &&
    String(state?.status || '').toLowerCase() === 'ready'
}

async function isChatActivityProjectionDurablyReady(database = db) {
  return chatActivityProjectionStateIsReady(
    await readChatActivityProjectionState(database)
  )
}

async function hasPendingRows(database = db) {
  const queue = await database.get('SELECT id FROM chat_activity_identity_queue LIMIT 1')
  if (queue) return true
  for (const table of ['whatsapp_api_messages', 'meta_social_messages', 'email_messages']) {
    const row = await database.get(`
      SELECT id FROM ${table}
      WHERE chat_projection_version < ?
      LIMIT 1
    `, [CHAT_ACTIVITY_PROJECTION_VERSION])
    if (row) return true
  }
  return false
}

/**
 * Readiness siempre se consulta en el singleton durable. Los triggers proyectan
 * escrituras nuevas en linea y marcan ese singleton dirty cuando una identidad
 * necesita reprocesamiento; por eso no hace falta sondear el historico en cada
 * GET ni en cada reinicio.
 */
export async function isChatActivityProjectionReady() {
  try {
    return await isChatActivityProjectionDurablyReady(db)
  } catch {
    return false
  }
}

export async function getChatActivityProjectionStatus(options = {}) {
  const state = await readChatActivityProjectionState(db, options)
  if (!state || Number(state.projection_version) !== CHAT_ACTIVITY_PROJECTION_VERSION) {
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

export function buildChatActivityScopeKeys({ phoneIds = [], catalogPhoneIds = [], phoneCandidates = [] } = {}) {
  const scopes = new Set()
  for (const id of phoneIds) {
    const clean = String(id || '').trim()
    if (clean) scopes.add(`id:${clean}`)
  }
  // Cuando existe catalogo, el trigger/worker ya convergio phone-only al ID
  // canonico. Mezclar tambien aliases phone haria mas ramas y podria contar un
  // historico stale; esos scopes solo son fuente de verdad sin IDs conocidos.
  if (!catalogPhoneIds.length) {
    for (const candidate of phoneCandidates) {
      const canonical = normalizePhoneForStorage(candidate)
      if (canonical) scopes.add(`phone:${canonical}`)
    }
  }
  return [...scopes]
}

async function reprojectMessageIds(database, ids) {
  if (!ids.length) return 0
  const params = [...new Set(ids.map(value => String(value || '').trim()).filter(Boolean))]
  if (!params.length) return 0
  const result = await database.run(`
    UPDATE whatsapp_api_messages
    SET contact_id = contact_id
    WHERE id IN (${placeholders(params)})
  `, params)
  return Number(result?.changes || result?.rowCount || params.length)
}

async function idsForIdentityQueue(database, row) {
  const kind = String(row.identity_kind || '')
  const value = String(row.identity_value || '').trim()
  const cursor = String(row.cursor_message_id || '')
  if (!value) return []

  if (kind === 'profile') {
    return (await database.all(`
      SELECT id FROM whatsapp_api_messages
      WHERE whatsapp_api_contact_id = ? AND id > ?
      ORDER BY id
      LIMIT ?
    `, [value, cursor, BATCH_SIZE])).map(item => item.id)
  }

  if (kind === 'business_alias') {
    return (await database.all(`
      SELECT source_message_id AS id
      FROM chat_message_activity
      WHERE source_kind = 'whatsapp' AND scope_key = ? AND source_message_id > ?
      ORDER BY source_message_id
      LIMIT ?
    `, [`id:${value}`, cursor, BATCH_SIZE])).map(item => item.id)
  }

  if (kind === 'business_alias_phone') {
    const canonical = normalizePhoneForStorage(value)
    if (!canonical) return []
    return (await database.all(`
      SELECT source_message_id AS id
      FROM chat_message_activity
      WHERE source_kind = 'whatsapp' AND scope_key = ? AND source_message_id > ?
      ORDER BY source_message_id
      LIMIT ?
    `, [`phone:${canonical}`, cursor, BATCH_SIZE])).map(item => item.id)
  }

  if (kind === 'phone') {
    const candidates = [...new Set(buildPhoneMatchCandidates(value).filter(Boolean))]
    if (!candidates.length) return []
    const inSql = placeholders(candidates)
    const branchParams = () => [...candidates, cursor, BATCH_SIZE]
    return (await database.all(`
      SELECT id
      FROM (
        SELECT id FROM (
          SELECT msg.id
          FROM whatsapp_api_messages msg
          WHERE NULLIF(TRIM(COALESCE(msg.contact_id, '')), '') IS NULL
            AND msg.phone IN (${inSql})
            AND msg.id > ?
          ORDER BY msg.id
          LIMIT ?
        ) AS phone_matches
        UNION ALL
        SELECT id FROM (
          SELECT msg.id
          FROM whatsapp_api_messages msg
          WHERE NULLIF(TRIM(COALESCE(msg.contact_id, '')), '') IS NULL
            AND msg.from_phone IN (${inSql})
            AND msg.id > ?
          ORDER BY msg.id
          LIMIT ?
        ) AS from_phone_matches
        UNION ALL
        SELECT id FROM (
          SELECT msg.id
          FROM whatsapp_api_messages msg
          WHERE NULLIF(TRIM(COALESCE(msg.contact_id, '')), '') IS NULL
            AND msg.to_phone IN (${inSql})
            AND msg.id > ?
          ORDER BY msg.id
          LIMIT ?
        ) AS to_phone_matches
        UNION ALL
        SELECT id FROM (
          SELECT msg.id
          FROM whatsapp_api_contacts profile
          JOIN whatsapp_api_messages msg
            ON msg.whatsapp_api_contact_id = profile.id
          WHERE NULLIF(TRIM(COALESCE(msg.contact_id, '')), '') IS NULL
            AND NULLIF(TRIM(COALESCE(profile.contact_id, '')), '') IS NULL
            AND profile.phone IN (${inSql})
            AND msg.id > ?
          ORDER BY msg.id
          LIMIT ?
        ) AS profile_phone_matches
      ) AS identity_matches
      GROUP BY id
      ORDER BY id
      LIMIT ?
    `, [
      ...branchParams(),
      ...branchParams(),
      ...branchParams(),
      ...branchParams(),
      BATCH_SIZE
    ])).map(item => item.id)
  }

  return []
}

async function processIdentityQueueBatch(database) {
  const rows = await database.all(`
    SELECT id, identity_kind, identity_value, generation, cursor_message_id
    FROM chat_activity_identity_queue
    ORDER BY id
    LIMIT ?
  `, [IDENTITY_ROWS_PER_TRANSACTION])
  if (!rows.length) return 0

  await database.transaction(async tx => {
    for (const row of rows) {
      const ids = await idsForIdentityQueue(tx, row)
      await reprojectMessageIds(tx, ids)

      if (ids.length >= BATCH_SIZE) {
        await tx.run(`
          UPDATE chat_activity_identity_queue
          SET cursor_message_id = ?
          WHERE id = ? AND generation = ?
        `, [ids.at(-1), row.id, row.generation])
        continue
      }

      await tx.run(`
        DELETE FROM chat_activity_identity_queue
        WHERE id = ? AND generation = ?
      `, [row.id, row.generation])
    }
  })
  return rows.length
}

const sourceConfigs = [
  { table: 'whatsapp_api_messages', updateColumn: 'contact_id' },
  { table: 'meta_social_messages', updateColumn: 'contact_id' },
  { table: 'email_messages', updateColumn: 'contact_id' }
]

async function backfillSourceBatch(database, config) {
  const rows = await database.all(`
    SELECT id
    FROM ${config.table}
    WHERE chat_projection_version < ?
    ORDER BY id
    LIMIT ?
  `, [CHAT_ACTIVITY_PROJECTION_VERSION, BATCH_SIZE])
  if (!rows.length) return 0
  const ids = rows.map(row => row.id)
  await database.run(`
    UPDATE ${config.table}
    SET ${config.updateColumn} = ${config.updateColumn}
    WHERE id IN (${placeholders(ids)})
  `, ids)
  return ids.length
}

async function tryMarkReady(database) {
  const state = await readChatActivityProjectionState(database)
  if (!state) return false
  const expectedRevision = Number(state.revision || 0)

  // El UPDATE toma el lock del singleton y hace la comprobacion final en la
  // misma escritura. Si un trigger gano antes, revision/queue impiden pisar
  // dirty; si gana despues, deja status=dirty al liberar el lock.
  const result = await database.run(`
    UPDATE chat_activity_projection_state
    SET status = 'ready', last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE singleton_id = 1
      AND revision = ?
      AND NOT EXISTS (SELECT 1 FROM chat_activity_identity_queue)
      AND NOT EXISTS (
        SELECT 1 FROM whatsapp_api_messages WHERE chat_projection_version < ? LIMIT 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM meta_social_messages WHERE chat_projection_version < ? LIMIT 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM email_messages WHERE chat_projection_version < ? LIMIT 1
      )
  `, [
    expectedRevision,
    CHAT_ACTIVITY_PROJECTION_VERSION,
    CHAT_ACTIVITY_PROJECTION_VERSION,
    CHAT_ACTIVITY_PROJECTION_VERSION
  ])
  return Number(result?.changes || result?.rowCount || 0) > 0
}

async function runUnlockedBackfill(database = db) {
  // Reinicio caliente: una sola lectura O(1). El singleton es la autoridad
  // durable y evita volver a abrir las tablas historicas cuando ya convergio.
  if (await isChatActivityProjectionDurablyReady(database)) {
    return { ready: true, skipped: true, passes: 0 }
  }

  await database.run(`
    UPDATE chat_activity_projection_state
    SET status = CASE WHEN status = 'ready' THEN status ELSE 'backfilling' END,
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE singleton_id = 1
  `)

  for (let pass = 0; pass < MAX_BATCHES_PER_RUN; pass += 1) {
    let changed = await processIdentityQueueBatch(database)
    for (const config of sourceConfigs) changed += await backfillSourceBatch(database, config)
    if (!changed) {
      if (await tryMarkReady(database)) return { ready: true, passes: pass + 1 }
      if (!(await hasPendingRows(database))) {
        return {
          ready: await isChatActivityProjectionDurablyReady(database),
          passes: pass + 1
        }
      }
    }
    if (pass % 10 === 9) await sleep(WORKER_YIELD_MS)
  }
  return { ready: false, exhausted: true }
}

export async function runChatActivityProjectionBackfill() {
  if (workerPromise) return workerPromise
  workerPromise = (async () => {
    try {
      if (databaseDialect === 'postgres' && typeof db.withAdvisoryLock === 'function') {
        return await db.withAdvisoryLock('chat-activity-projection', lockedDb => runUnlockedBackfill(lockedDb || db))
      }
      return await runUnlockedBackfill(db)
    } catch (error) {
      if (error?.code === 'DATABASE_ADVISORY_LOCK_BUSY') {
        // Rolling deploy normal: otra instancia ya es la dueña. No tocar state;
        // el ganador conserva la autoridad de ready/dirty y esta instancia
        // volvera a comprobarlo desde BD en la siguiente lectura.
        setTimeout(() => scheduleChatActivityProjectionBackfill(), 250)
        return { ready: false, busy: true }
      }
      if (/no such table:\s*chat_activity_|relation ["']?chat_activity_|chat_projection_version.*(?:does not exist|no such column)/i.test(String(error?.message || ''))) {
        // Durante un rolling deploy el binario puede vivir unos segundos antes
        // que su migracion en otra instancia; fail-closed conserva legacy sin
        // convertir esa coexistencia normal en ruido ni en state=failed.
        return { ready: false, unavailable: true }
      }
      await db.run(`
        UPDATE chat_activity_projection_state
        SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE singleton_id = 1 AND status = 'backfilling'
      `, [String(error?.message || error)]).catch(() => undefined)
      logger.error(`No se pudo converger la proyeccion de Chats: ${error.message}`)
      throw error
    } finally {
      workerPromise = null
    }
  })()
  return workerPromise
}

export function scheduleChatActivityProjectionBackfill() {
  if (workerPromise || workerScheduled) return { scheduled: false }
  const queued = scheduleProjectionBackfillJob({
    key: BACKFILL_JOB_KEY,
    priority: BACKFILL_JOB_PRIORITY.CRITICAL,
    run: async () => {
      workerScheduled = false
      const result = await runChatActivityProjectionBackfill()
      if (result?.exhausted) {
        setTimeout(() => scheduleChatActivityProjectionBackfill(), 100)
      }
      return result
    }
  })
  workerScheduled = queued.scheduled
  return { scheduled: queued.scheduled }
}
