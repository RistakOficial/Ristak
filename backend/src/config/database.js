import crypto from 'crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DateTime } from 'luxon'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { logger } from '../utils/logger.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { createRistakId } from '../utils/idGenerator.js'
import { timestampSortExpression } from '../utils/sqlTimestampSort.js'
import { detectWhatsAppAttributionFields } from '../utils/whatsappAttribution.js'
import {
  extractWhatsAppProfileName,
  shouldReplaceWhatsAppApiContactName
} from '../utils/whatsappContactProfile.js'
import { DEFAULT_OPENAI_MODEL } from './openAIModels.js'
import {
  isConversationalAgentSafetyReferenceTable,
  mergeConversationalAgentSafetyContactReferences
} from '../utils/conversationalAgentSafetyMerge.js'
import {
  acquireAbortablePostgresClient,
  createDatabaseAbortError,
  runCancelablePostgresQuery,
  waitForDatabaseRetry
} from '../utils/postgresCancelableQuery.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DATABASE_URL = process.env.DATABASE_URL
const usePostgres = !!DATABASE_URL
export const databaseDialect = usePostgres ? 'postgres' : 'sqlite'

let db
const databaseTransactionContext = new AsyncLocalStorage()
const databaseConnectionContext = new AsyncLocalStorage()

const DEFAULT_REPORT_TABLE_COLUMN_CONFIG = [
  ['date', true],
  ['profit', true],
  ['revenue', true],
  ['fixedBusinessExpenses', true],
  ['businessExpenses', true],
  ['spend', true],
  ['roas', true],
  ['new_customers', true],
  ['cac', true],
  ['appointments', true],
  ['leads', true],
  ['attendances', false],
  ['transactions', false],
  ['clicks', false],
  ['reach', false],
  ['cpc', false],
  ['cpl', false],
  ['cpa', false],
  ['cpaAttendance', false],
  ['visitors', false],
  ['cpv', false],
  ['webToInteresadosRate', false],
  ['interesadosToApptsRate', false],
  ['apptsToAttendanceRate', false],
  ['attendanceToSalesRate', false],
  ['attendanceToCustomersRate', false],
  ['apptsToSalesRate', false]
].map(([id, visible], order) => ({ id, visible, order }))

const DEFAULT_REPORT_TABLE_CONFIG_VALUE = JSON.stringify(DEFAULT_REPORT_TABLE_COLUMN_CONFIG)
const DEFAULT_REPORT_TABLE_CONFIG_KEYS = ['cashflow', 'attribution', 'campaigns']
  .flatMap(reportType => ['day', 'month', 'year'].map(viewType => `table_reports_metrics_${reportType}_${viewType}`))
const DEFAULT_OPENAI_MODEL_COLUMN = `TEXT DEFAULT '${DEFAULT_OPENAI_MODEL}'`
const DEFAULT_BUSINESS_TIMEZONE = 'America/Mexico_City'
const ACCOUNT_TIMEZONE_CONFIG_KEY = 'account_timezone'
const WHATSAPP_API_FIRST_AD_BACKFILL_CONFIG_KEY = 'whatsapp_api_first_ad_attribution_backfill_version'
const WHATSAPP_API_FIRST_AD_BACKFILL_VERSION = '2026-07-08-first-ad-attribution-v2'
const CORE_SCHEMA_BOOTSTRAP_CONFIG_KEY = 'core_schema_bootstrap_version'
const CORE_SCHEMA_BOOTSTRAP_VERSION = '2026-07-12-v1'
const STARTUP_DATA_MAINTENANCE_CONFIG_KEY = 'startup_data_maintenance_version'
const STARTUP_DATA_MAINTENANCE_VERSION = '2026-07-12-v1'
const CONTACT_REENGAGEMENT_REPAIR_CONFIG_KEY = 'contact_reengagement_repair_version'
const CONTACT_REENGAGEMENT_REPAIR_VERSION = '2026-07-15-v2'
const STARTUP_DATA_BATCH_SIZE = 250
const STARTUP_SCHEMA_LOCK_NAME = 'startup-schema-bootstrap'
const STARTUP_SCHEMA_LOCK_WAIT_MS = 120_000

const POSTGRES_CONNECT_RETRY_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  '08001',
  '08006',
  '53300',
  '57P03'
])

const POSTGRES_TRANSIENT_CONNECTION_MESSAGES = [
  'connection terminated unexpectedly',
  'connection terminated',
  'connection ended unexpectedly',
  'connection closed unexpectedly',
  'client has encountered a connection error',
  'connection is not queryable',
  'terminating connection'
]

const POSTGRES_CLIENT_ERROR_LISTENER = Symbol('ristakPostgresClientErrorListener')
const POSTGRES_CLIENT_CONNECTION_ERROR = Symbol('ristakPostgresClientConnectionError')

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function throwIfDatabaseOperationAborted(options) {
  if (options?.signal?.aborted) throw createDatabaseAbortError()
}

async function updateRowsInBatches({ table, setSql, whereSql, label, batchSize = STARTUP_DATA_BATCH_SIZE }) {
  let lastId = ''
  let updated = 0

  while (true) {
    const rows = await db.all(`
      SELECT id
      FROM ${table}
      WHERE id > ?
        AND (${whereSql})
      ORDER BY id
      LIMIT ?
    `, [lastId, batchSize])
    if (!rows.length) break

    const ids = rows.map(row => String(row.id || '')).filter(Boolean)
    if (!ids.length) break
    const placeholders = ids.map(() => '?').join(', ')
    const result = await db.run(
      `UPDATE ${table} SET ${setSql} WHERE id IN (${placeholders})`,
      ids
    )
    updated += Number(result?.changes || 0)
    lastId = ids[ids.length - 1]

    // Cede el event loop y la conexión entre lotes. El usuario puede entrar y
    // consultar sus datos mientras la normalización histórica converge.
    await sleep(25)
  }

  if (updated > 0) logger.info(`[Arranque] ${label}: ${updated} fila(s) normalizada(s) en lotes.`)
  return updated
}

// PostgreSQL OID 1114 (`timestamp without time zone`) representa en este
// proyecto un instante UTC guardado como hora de pared. node-postgres lo
// interpreta por defecto en la zona horaria del proceso de Node, aunque la
// sesion SQL este en UTC. En una cuenta UTC-6 eso convierte silenciosamente
// `16:00` en un Date de `22:00Z` al leerlo.
//
// La base ya normaliza todos los instantes a UTC antes de persistirlos; por eso
// la lectura simetrica correcta es agregar UTC de forma explicita. Se conserva
// Date como tipo de retorno para no romper consumidores del adaptador, pero el
// Date ahora representa el instante almacenado, no la zona de la computadora.
export function parsePostgresTimestampWithoutTimezoneAsUtc(value) {
  if (value === null || value === undefined || value === '') return value
  const text = String(value).trim()
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
  const normalized = hasExplicitZone
    ? text
    : `${text.includes('T') ? text : text.replace(' ', 'T')}Z`
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? value : parsed
}

function databaseAdvisoryLockBusyError(lockName) {
  const error = new Error(`El candado distribuido ${String(lockName || '').slice(0, 160)} está ocupado.`)
  error.code = 'DATABASE_ADVISORY_LOCK_BUSY'
  return error
}

function postgresAdvisoryLockKey(lockName) {
  // PostgreSQL recibe un bigint firmado. SHA-256 mantiene estable la llave entre
  // procesos/hosts sin depender del hash aleatorio del runtime de Node.
  return crypto
    .createHash('sha256')
    .update(`ristak:${String(lockName || '')}`)
    .digest()
    .readBigInt64BE(0)
    .toString()
}

export function isTransientPostgresConnectionError(error) {
  const code = String(error?.code || '').trim()
  if (POSTGRES_CONNECT_RETRY_CODES.has(code)) return true

  const message = String(error?.message || '').toLowerCase()
  return POSTGRES_TRANSIENT_CONNECTION_MESSAGES.some(pattern => message.includes(pattern))
}

export function describePostgresConnectionError(error) {
  const code = String(error?.code || '').trim()
  const message = String(error?.message || 'Error desconocido').trim()
  return code ? `${code}: ${message}` : message
}

const WHATSAPP_API_SYSTEM_CUSTOM_FIELD_KEYS = new Set([
  'whatsapp_api_provider',
  'whatsapp_api_first_message',
  'whatsapp_api_source_id',
  'whatsapp_api_ctwa_clid',
  'whatsapp_api_source_url'
])

const normalizeCustomFieldKey = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')

function parseCustomFieldsPayload(value) {
  if (value === null || value === undefined || value === '') return []
  if (Array.isArray(value) || (typeof value === 'object' && value)) return value

  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function isWhatsAppApiSystemCustomField(field = {}, fallbackKey = '') {
  const tokens = [
    fallbackKey,
    field?.id,
    field?.key,
    field?.fieldKey,
    field?.field_key,
    field?.name,
    field?.label
  ].map(normalizeCustomFieldKey).filter(Boolean)

  return tokens.some(token => WHATSAPP_API_SYSTEM_CUSTOM_FIELD_KEYS.has(token))
}

function removeWhatsAppApiSystemCustomFieldsFromPayload(value) {
  const parsed = parseCustomFieldsPayload(value)

  if (Array.isArray(parsed)) {
    const next = parsed.filter(field => !isWhatsAppApiSystemCustomField(field))
    return {
      changed: next.length !== parsed.length,
      value: next
    }
  }

  if (parsed && typeof parsed === 'object') {
    const next = {}
    let changed = false
    for (const [key, fieldValue] of Object.entries(parsed)) {
      const field = fieldValue && typeof fieldValue === 'object' ? fieldValue : { value: fieldValue }
      if (isWhatsAppApiSystemCustomField(field, key)) {
        changed = true
        continue
      }
      next[key] = fieldValue
    }
    return { changed, value: next }
  }

  return { changed: false, value: parsed }
}

function normalizeAuthEmail(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .toLowerCase()
}

function isValidAuthEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeAuthEmail(value))
}

function maskAuthEmail(value) {
  const email = normalizeAuthEmail(value)
  const [local, domain] = email.split('@')
  if (!local || !domain) return email ? '[correo-invalido]' : '[sin-correo]'
  return `${local.slice(0, 2)}***@${domain}`
}

export async function backfillUserEmailsFromLegacyUsernames({ source = 'manual' } = {}) {
  const rows = await db.all(`
    SELECT id, username, email
    FROM users
    WHERE email IS NULL OR TRIM(email) = ''
  `)

  const stats = {
    source,
    scanned: rows.length,
    updated: 0,
    skippedInvalidUsername: 0,
    skippedConflict: 0,
    skippedRace: 0
  }

  for (const row of rows) {
    const candidate = normalizeAuthEmail(row.username)
    if (!isValidAuthEmail(candidate)) {
      stats.skippedInvalidUsername += 1
      continue
    }

    const conflict = await db.get(
      'SELECT id FROM users WHERE id != ? AND LOWER(TRIM(email)) = LOWER(?) LIMIT 1',
      [row.id, candidate]
    )
    if (conflict) {
      stats.skippedConflict += 1
      logger.warn(`Backfill users.email omitido por conflicto: ${maskAuthEmail(candidate)}`)
      continue
    }

    const result = await db.run(
      `UPDATE users
       SET email = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND (email IS NULL OR TRIM(email) = '')`,
      [candidate, row.id]
    )

    if (Number(result?.changes || 0) > 0) {
      stats.updated += 1
    } else {
      stats.skippedRace += 1
    }
  }

  if (stats.updated || stats.skippedConflict || stats.skippedInvalidUsername) {
    logger.info(
      `Backfill users.email (${source}): ${stats.updated} actualizado(s), ` +
      `${stats.skippedConflict} conflicto(s), ${stats.skippedInvalidUsername} username(s) sin formato correo.`
    )
  }

  return stats
}

async function cleanupWhatsAppApiSystemCustomFields() {
  const definitionRows = await db.all(`
    SELECT id
    FROM contact_custom_field_definitions
    WHERE LOWER(field_key) IN (${Array.from(WHATSAPP_API_SYSTEM_CUSTOM_FIELD_KEYS).map(() => '?').join(', ')})
  `, Array.from(WHATSAPP_API_SYSTEM_CUSTOM_FIELD_KEYS))

  for (const row of definitionRows) {
    await db.run('DELETE FROM contact_custom_field_definition_sources WHERE definition_id = ?', [row.id])
    await db.run('DELETE FROM contact_custom_field_definitions WHERE id = ?', [row.id])
  }

  const contactRows = await db.all(`
    SELECT id, custom_fields
    FROM contacts
    WHERE custom_fields IS NOT NULL
  `)
  let cleanedContacts = 0

  for (const row of contactRows) {
    const cleaned = removeWhatsAppApiSystemCustomFieldsFromPayload(row.custom_fields)
    if (!cleaned.changed) continue

    await db.run(
      `UPDATE contacts SET custom_fields = ${usePostgres ? '?::jsonb' : '?'} WHERE id = ?`,
      [JSON.stringify(cleaned.value), row.id]
    )
    cleanedContacts += 1
  }

  if (definitionRows.length || cleanedContacts) {
    logger.info(`Limpieza WhatsApp API: ${definitionRows.length} definiciones y ${cleanedContacts} contactos sin campos personalizados internos.`)
  }
}

if (usePostgres) {
  // PostgreSQL (Producción en Render)
  logger.info('Usando PostgreSQL')

  const pg = await import('pg')
  const postgresTypes = new pg.default.TypeOverrides()
  postgresTypes.setTypeParser(1114, parsePostgresTimestampWithoutTimezoneAsUtc)
  const postgresPoolConfig = {
    connectionString: DATABASE_URL,
    options: '-c timezone=UTC',
    types: postgresTypes,
    keepAlive: true,
    connectionTimeoutMillis: 5000,
    ssl: {
      rejectUnauthorized: false
    }
  }
  const pool = new pg.default.Pool(postgresPoolConfig)
  // Canal reservado: si las diez conexiones de trabajo estan ocupadas en
  // scans abandonados, la orden de cancelacion nunca debe esperar una de ellas.
  const cancellationPool = new pg.default.Pool({
    ...postgresPoolConfig,
    max: 2,
    idleTimeoutMillis: 1_000,
    connectionTimeoutMillis: 5_000,
    query_timeout: 1_500
  })

  pool.on('error', (error) => {
    logger.warn(`PostgreSQL cerró una conexión idle del pool: ${describePostgresConnectionError(error)}. Se descartará y se abrirá otra cuando haga falta.`)
  })
  cancellationPool.on('error', (error) => {
    logger.warn(`PostgreSQL cerró una conexión idle del canal de cancelación: ${describePostgresConnectionError(error)}.`)
  })

  function attachPostgresClientErrorHandler(client) {
    client[POSTGRES_CLIENT_CONNECTION_ERROR] = null

    if (client[POSTGRES_CLIENT_ERROR_LISTENER]) {
      return client
    }

    const handleClientError = (error) => {
      client[POSTGRES_CLIENT_CONNECTION_ERROR] = error
      const message = describePostgresConnectionError(error)

      if (isTransientPostgresConnectionError(error)) {
        logger.warn(`PostgreSQL cerró una conexión activa del pool: ${message}. Se descartará al liberarla.`)
        return
      }

      logger.error(`PostgreSQL reportó un error en una conexión activa: ${message}`)
    }

    client.on('error', handleClientError)
    client[POSTGRES_CLIENT_ERROR_LISTENER] = handleClientError
    return client
  }

  function getPostgresClientConnectionError(client) {
    return client?.[POSTGRES_CLIENT_CONNECTION_ERROR] || null
  }

  async function connectWithRetry({ signal } = {}) {
    const maxAttempts = 6
    let delayMs = 500

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      throwIfDatabaseOperationAborted({ signal })
      try {
        const client = await acquireAbortablePostgresClient({
          pool,
          signal,
          onLateReleaseError: error => logger.warn(
            `No se pudo liberar una conexión PostgreSQL obtenida después de cancelar: ${describePostgresConnectionError(error)}`
          )
        })
        return attachPostgresClientErrorHandler(client)
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) throw createDatabaseAbortError()
        const canRetry = isTransientPostgresConnectionError(error)
        if (!canRetry || attempt === maxAttempts) {
          throw error
        }

        logger.warn(`PostgreSQL no aceptó conexión (${describePostgresConnectionError(error)}). Reintentando ${attempt}/${maxAttempts}...`)
        await waitForDatabaseRetry(delayMs, signal)
        delayMs = Math.min(Math.round(delayMs * 1.8), 5000)
      }
    }
  }

  // Helper para convertir placeholders SQLite (?) a PostgreSQL ($1, $2, etc.)
  // No toca los ? que van dentro de literales de texto '...' (p. ej. filtros LIKE)
  const convertPlaceholders = (sql) => {
    let index = 1
    return sql.replace(/'(?:[^']|'')*'|\?/g, (match) => (match === '?' ? `$${index++}` : match))
  }

  const normalizePostgresSql = (sql) => (
    sql
      .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY')
      .replace(/AUTOINCREMENT/g, 'GENERATED ALWAYS AS IDENTITY')
      .replace(/DATETIME/g, 'TIMESTAMP')
  )

  // Postgres (a diferencia de SQLite) NO coacciona booleanos hacia las columnas
  // INTEGER que usamos para TODOS los flags (required, *_enabled, *_verified, ...):
  // el driver pg envía `true`/`false` como texto y Postgres lanza
  // "invalid input syntax for type integer: true". El esquema no tiene columnas
  // BOOLEAN reales, así que normalizamos aquí, en un solo lugar, cualquier bind
  // booleano a 1/0 — mismo comportamiento que SQLite y misma data en ambos motores.
  const toPostgresParams = (params) => (
    Array.isArray(params)
      ? params.map((value) => (value === true ? 1 : value === false ? 0 : value))
      : params
  )

  const queryPostgres = async (client, sql, params = [], options = {}) => {
    throwIfDatabaseOperationAborted(options)
    return runCancelablePostgresQuery({
      client,
      sql,
      params: toPostgresParams(params),
      signal: options?.signal,
      cancelBackend: async (processId) => {
        const cancellationResult = await cancellationPool.query(
          'SELECT pg_cancel_backend($1) AS cancelled',
          [processId]
        )
        if (cancellationResult.rows[0]?.cancelled !== true) {
          throw Object.assign(new Error('PostgreSQL no confirmó la cancelación del backend activo'), {
            code: 'PG_CANCEL_NOT_CONFIRMED'
          })
        }
      },
      onCancelError: (error) => logger.warn(
        `No se pudo cancelar una consulta PostgreSQL desconectada: ${describePostgresConnectionError(error)}`
      ),
      destroyClient: (cancelError) => {
        const connectionError = Object.assign(
          new Error('Se cerró la conexión PostgreSQL porque su consulta no pudo cancelarse'),
          { code: 'CONNECTION_TERMINATED', cause: cancelError }
        )
        client[POSTGRES_CLIENT_CONNECTION_ERROR] = connectionError
        const stream = client?.connection?.stream
        if (!stream || typeof stream.destroy !== 'function') {
          throw connectionError
        }
        stream.destroy(connectionError)
      }
    })
  }

  const createPostgresAdapter = (client) => ({
    run: async (sql, params = [], options = {}) => {
      sql = normalizePostgresSql(sql)
      sql = convertPlaceholders(sql)

      const result = await queryPostgres(client, sql, params, options)
      return {
        lastID: result.rows[0]?.id || null,
        changes: result.rowCount
      }
    },

    get: async (sql, params = [], options = {}) => {
      sql = sql.replace(/DATETIME/g, 'TIMESTAMP')
      sql = convertPlaceholders(sql)

      const result = await queryPostgres(client, sql, params, options)
      return result.rows[0] || null
    },

    all: async (sql, params = [], options = {}) => {
      sql = sql.replace(/DATETIME/g, 'TIMESTAMP')
      sql = convertPlaceholders(sql)

      const result = await queryPostgres(client, sql, params, options)
      return result.rows
    },

    exec: async (sql) => {
      sql = normalizePostgresSql(sql)
      await client.query(sql)
    },

    // Las migraciones DDL largas usan la misma sesion que sostiene el advisory
    // lock. Configurar aqui (y no mediante una conexion suelta del pool) hace
    // efectivos lock_timeout/statement_timeout tambien para INDEX CONCURRENTLY.
    configureVersionedMigrationSession: async ({ lockTimeoutMs, statementTimeoutMs }) => {
      await client.query(`
        SELECT
          set_config('lock_timeout', $1, false),
          set_config('statement_timeout', $2, false)
      `, [`${lockTimeoutMs}ms`, `${statementTimeoutMs}ms`])
    },

    resetVersionedMigrationSession: async () => {
      await client.query('RESET lock_timeout; RESET statement_timeout')
    },

    // El adapter fijado por un advisory lock tambien necesita transacciones.
    // Asi un archivo DDL no concurrente y su fila de schema_migrations hacen
    // commit juntos en exactamente la misma sesion.
    transaction: async (callback) => {
      const activeTransaction = databaseTransactionContext.getStore()
      if (activeTransaction) return callback(activeTransaction)
      const transactionDb = createPostgresAdapter(client)
      await client.query('BEGIN')
      try {
        const result = await databaseTransactionContext.run(
          transactionDb,
          () => callback(transactionDb)
        )
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      }
    }
  })

  async function withPostgresClient(operation, {
    retryTransientRead = false,
    label = 'consulta',
    signal
  } = {}) {
    const maxAttempts = retryTransientRead ? 2 : 1
    let delayMs = 150

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      throwIfDatabaseOperationAborted({ signal })
      const client = await connectWithRetry({ signal })
      let result
      let operationError = null
      let releaseError = null
      try {
        result = await operation(createPostgresAdapter(client))
      } catch (error) {
        operationError = error
      }

      releaseError = isTransientPostgresConnectionError(operationError)
        ? operationError
        : getPostgresClientConnectionError(client)

      try {
        client.release(releaseError || undefined)
      } catch (releaseFailure) {
        logger.warn(`No se pudo liberar conexión PostgreSQL después de ${label}: ${describePostgresConnectionError(releaseFailure)}`)
      }

      if (!operationError) {
        return result
      }

      if (retryTransientRead && releaseError && attempt < maxAttempts) {
        logger.warn(`PostgreSQL cortó ${label} (${describePostgresConnectionError(operationError)}). Reintentando ${attempt + 1}/${maxAttempts}...`)
        await waitForDatabaseRetry(delayMs, signal)
        delayMs = Math.min(Math.round(delayMs * 2), 1000)
        continue
      }

      throw operationError
    }
  }

  async function withPostgresAdvisoryLock(lockName, callback, options = {}) {
    if (typeof callback !== 'function') {
      throw Object.assign(new Error('El candado distribuido necesita una operación.'), {
        code: 'DATABASE_ADVISORY_LOCK_CALLBACK_REQUIRED'
      })
    }
    if (databaseTransactionContext.getStore() || databaseConnectionContext.getStore()) {
      throw Object.assign(new Error('No se puede abrir un candado distribuido dentro de otra transacción.'), {
        code: 'DATABASE_ADVISORY_LOCK_NESTED'
      })
    }

    // Los advisory locks de PostgreSQL pertenecen a la sesión. Esta conexión
    // queda dedicada hasta que callback termina; jamás se devuelve al pool con
    // el candado puesto ni se depende de una fila con lease que pueda caducar.
    const client = await connectWithRetry({ signal: options?.signal })
    const clientDb = createPostgresAdapter(client)
    const lockKey = postgresAdvisoryLockKey(lockName)
    let acquired = false
    let result
    let operationError = null
    let unlockError = null
    let releaseError = null

    try {
      const lockResult = await client.query(
        'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
        [lockKey]
      )
      acquired = lockResult.rows[0]?.acquired === true
      if (!acquired) throw databaseAdvisoryLockBusyError(lockName)

      // Algunos fences de dominio (p. ej. seguridad conversacional) deben
      // abarcar servicios que ya toman sus propios advisory locks. En ese caso
      // el candado externo conserva esta sesión dedicada, pero no enruta todas
      // las consultas del callback por ella para permitir candados internos en
      // conexiones independientes.
      result = options?.pinConnection === false
        ? await callback(clientDb)
        : await databaseConnectionContext.run({ client, db: clientDb }, () => callback(clientDb))
    } catch (error) {
      operationError = error
    }

    if (acquired) {
      try {
        const unlockResult = await client.query(
          'SELECT pg_advisory_unlock($1::bigint) AS released',
          [lockKey]
        )
        if (unlockResult.rows[0]?.released !== true) {
          throw Object.assign(new Error(`PostgreSQL perdió el candado distribuido ${String(lockName).slice(0, 160)}.`), {
            code: 'DATABASE_ADVISORY_LOCK_LOST'
          })
        }
      } catch (error) {
        unlockError = error
      }
    }

    releaseError = getPostgresClientConnectionError(client)
    try {
      client.release(releaseError || unlockError || undefined)
    } catch (error) {
      releaseError = releaseError || error
    }

    if (operationError) {
      if (unlockError || releaseError) {
        operationError.lockReleaseError = unlockError || releaseError
      }
      throw operationError
    }
    if (unlockError) throw unlockError
    if (releaseError) throw releaseError
    return result
  }

  db = {
    run: async (sql, params = [], options = {}) => {
      const activeTransaction = databaseTransactionContext.getStore()
      if (activeTransaction) return activeTransaction.run(sql, params, options)
      const pinnedConnection = databaseConnectionContext.getStore()
      if (pinnedConnection) return pinnedConnection.db.run(sql, params, options)
      return withPostgresClient((clientDb) => clientDb.run(sql, params, options), {
        label: 'escritura',
        signal: options?.signal
      })
    },

    get: async (sql, params = [], options = {}) => {
      const activeTransaction = databaseTransactionContext.getStore()
      if (activeTransaction) return activeTransaction.get(sql, params, options)
      const pinnedConnection = databaseConnectionContext.getStore()
      if (pinnedConnection) return pinnedConnection.db.get(sql, params, options)
      return withPostgresClient((clientDb) => clientDb.get(sql, params, options), {
        retryTransientRead: true,
        label: 'lectura get',
        signal: options?.signal
      })
    },

    all: async (sql, params = [], options = {}) => {
      const activeTransaction = databaseTransactionContext.getStore()
      if (activeTransaction) return activeTransaction.all(sql, params, options)
      const pinnedConnection = databaseConnectionContext.getStore()
      if (pinnedConnection) return pinnedConnection.db.all(sql, params, options)
      return withPostgresClient((clientDb) => clientDb.all(sql, params, options), {
        retryTransientRead: true,
        label: 'lectura all',
        signal: options?.signal
      })
    },

    exec: async (sql) => {
      const activeTransaction = databaseTransactionContext.getStore()
      if (activeTransaction) return activeTransaction.exec(sql)
      const pinnedConnection = databaseConnectionContext.getStore()
      if (pinnedConnection) return pinnedConnection.db.exec(sql)
      return withPostgresClient((clientDb) => clientDb.exec(sql), {
        label: 'exec'
      })
    },

    transaction: async (callback) => {
      const activeTransaction = databaseTransactionContext.getStore()
      if (activeTransaction) return callback(activeTransaction)
      const pinnedConnection = databaseConnectionContext.getStore()
      const client = pinnedConnection?.client || await connectWithRetry()
      const txDb = pinnedConnection?.db || createPostgresAdapter(client)
      const ownsConnection = !pinnedConnection
      let releaseError = null
      try {
        await client.query('BEGIN')
        const result = await databaseTransactionContext.run(txDb, () => callback(txDb))
        await client.query('COMMIT')
        return result
      } catch (error) {
        releaseError = isTransientPostgresConnectionError(error) ? error : null
        try {
          await client.query('ROLLBACK')
        } catch (rollbackError) {
          logger.warn(`No se pudo revertir transacción PostgreSQL después de un error: ${describePostgresConnectionError(rollbackError)}`)
          releaseError = releaseError || (isTransientPostgresConnectionError(rollbackError) ? rollbackError : null)
        }
        throw error
      } finally {
        releaseError = releaseError || getPostgresClientConnectionError(client)
        if (ownsConnection) client.release(releaseError || undefined)
      }
    },

    withAdvisoryLock: withPostgresAdvisoryLock
  }

  logger.success('Conectado a PostgreSQL')
} else {
  // SQLite (Desarrollo local)
  logger.info('Usando SQLite')

  const sqlite3Module = await import('sqlite3')
  const sqlite3 = sqlite3Module.default

  const configuredSqlitePath = String(process.env.RISTAK_SQLITE_PATH || '').trim()
  const automaticTestSqlitePath = process.env.NODE_TEST_CONTEXT
    ? join(tmpdir(), `ristak-test-${process.pid}-${crypto.randomUUID()}.db`)
    : ''
  const dbPath = configuredSqlitePath || automaticTestSqlitePath || join(__dirname, '../../../ristak.db')

  if (automaticTestSqlitePath && !configuredSqlitePath) {
    process.once('exit', () => {
      for (const suffix of ['', '-shm', '-wal', '-journal']) {
        rmSync(`${automaticTestSqlitePath}${suffix}`, { force: true })
      }
    })
  }

  const sqliteDb = new sqlite3.Database(dbPath)
  sqliteDb.configure('busyTimeout', 10_000)
  logger.success('Conectado a SQLite:', dbPath)

  const createSqliteAdapter = (connection) => ({
    run: (sql, params = [], options = {}) => {
      throwIfDatabaseOperationAborted(options)
      return new Promise((resolve, reject) => {
        connection.run(sql, params, function(err) {
          if (err) reject(err)
          else if (options?.signal?.aborted) reject(createDatabaseAbortError())
          else resolve({ lastID: this.lastID, changes: this.changes })
        })
      })
    },

    get: (sql, params = [], options = {}) => {
      throwIfDatabaseOperationAborted(options)
      return new Promise((resolve, reject) => {
        connection.get(sql, params, (err, row) => {
          if (err) reject(err)
          else if (options?.signal?.aborted) reject(createDatabaseAbortError())
          else resolve(row || null)
        })
      })
    },

    all: (sql, params = [], options = {}) => {
      throwIfDatabaseOperationAborted(options)
      return new Promise((resolve, reject) => {
        connection.all(sql, params, (err, rows) => {
          if (err) reject(err)
          else if (options?.signal?.aborted) reject(createDatabaseAbortError())
          else resolve(rows)
        })
      })
    },

    exec: (sql) => {
      return new Promise((resolve, reject) => {
        connection.exec(sql, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
  })

  const sqliteAdapter = createSqliteAdapter(sqliteDb)
  const sqliteAdvisoryLockDir = join(
    tmpdir(),
    `ristak-sqlite-advisory-${crypto.createHash('sha256').update(dbPath).digest('hex').slice(0, 20)}`
  )
  mkdirSync(sqliteAdvisoryLockDir, { recursive: true })
  // SQLite trae las FK apagadas por conexión. Las migraciones y el esquema base
  // usan RESTRICT/CASCADE/SET NULL como parte del contrato de integridad, así que
  // no puede depender de que una migración legacy haya encendido este PRAGMA.
  await sqliteAdapter.run('PRAGMA foreign_keys = ON')
  const routeSqliteOperation = (method) => (...args) => {
    const activeTransaction = databaseTransactionContext.getStore()
    return (activeTransaction || sqliteAdapter)[method](...args)
  }

  async function withSqliteAdvisoryLock(lockName, callback) {
    if (typeof callback !== 'function') {
      throw Object.assign(new Error('El candado local necesita una operación.'), {
        code: 'DATABASE_ADVISORY_LOCK_CALLBACK_REQUIRED'
      })
    }
    const activeTransaction = databaseTransactionContext.getStore()
    // Todas las transacciones SQLite del adaptador empiezan con BEGIN IMMEDIATE;
    // si ya estamos dentro de una, la exclusión física global ya está vigente.
    if (activeTransaction) return callback(activeTransaction)

    // SQLite no tiene advisory locks por llave. Cada llave obtiene un archivo
    // SQLite mínimo propio y conserva BEGIN IMMEDIATE durante todo el callback.
    // Así dos procesos chocan para el mismo agente, agentes distintos no se
    // bloquean entre sí y el SO libera el file lock al morir el proceso.
    const lockFileName = `${crypto.createHash('sha256').update(String(lockName)).digest('hex')}.sqlite`
    const lockConnection = new sqlite3.Database(join(sqliteAdvisoryLockDir, lockFileName))
    lockConnection.configure('busyTimeout', 0)
    const lockDb = createSqliteAdapter(lockConnection)
    let began = false
    let result
    let operationError = null
    let cleanupError = null

    try {
      try {
        await lockDb.run('BEGIN IMMEDIATE')
        began = true
      } catch (error) {
        if (error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED') {
          throw databaseAdvisoryLockBusyError(lockName)
        }
        throw error
      }
      // El archivo auxiliar sólo sostiene la exclusión. Las operaciones del
      // callback siguen usando la base principal y conservan sus transacciones.
      result = await callback()
      await lockDb.run('COMMIT')
      began = false
    } catch (error) {
      operationError = error
      if (began) {
        try {
          await lockDb.run('ROLLBACK')
          began = false
        } catch (rollbackError) {
          cleanupError = rollbackError
        }
      }
    }

    await new Promise((resolve) => {
      lockConnection.close((error) => {
        cleanupError = cleanupError || error || null
        resolve()
      })
    })

    if (operationError) {
      if (cleanupError) operationError.lockReleaseError = cleanupError
      throw operationError
    }
    if (cleanupError) throw cleanupError
    return result
  }

  db = {
    run: routeSqliteOperation('run'),
    get: routeSqliteOperation('get'),
    all: routeSqliteOperation('all'),
    exec: routeSqliteOperation('exec'),

    transaction: async (callback) => {
      const activeTransaction = databaseTransactionContext.getStore()
      if (activeTransaction) return callback(activeTransaction)
      // Una conexión dedicada evita que dos transacciones concurrentes se
      // aniden en la conexión global o que escrituras ajenas queden incluidas
      // accidentalmente entre BEGIN y COMMIT.
      const transactionConnection = new sqlite3.Database(dbPath)
      transactionConnection.configure('busyTimeout', 10_000)
      const txDb = createSqliteAdapter(transactionConnection)
      try {
        // El PRAGMA es por conexión y debe ejecutarse antes de BEGIN. Sin esto,
        // las transacciones dedicadas se comportan distinto a Postgres y dejan
        // huérfanos aunque la conexión SQLite principal sí tenga FK activas.
        await txDb.run('PRAGMA foreign_keys = ON')
        await txDb.run('BEGIN IMMEDIATE')
        const result = await databaseTransactionContext.run(txDb, () => callback(txDb))
        await txDb.run('COMMIT')
        return result
      } catch (error) {
        await txDb.run('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        await new Promise((resolve) => {
          transactionConnection.close((error) => {
            if (error) logger.warn(`No se pudo cerrar una conexión SQLite transaccional: ${error.message}`)
            resolve()
          })
        })
      }
    },

    withAdvisoryLock: withSqliteAdvisoryLock
  }
}

const CONTACT_PHONE_REFERENCE_TABLES = [
  { table: 'payments', column: 'contact_id' },
  { table: 'payment_plans', column: 'contact_id' },
  { table: 'appointments', column: 'contact_id' },
  { table: 'appointment_attendance_signals', column: 'contact_id', deleteOnConflict: true },
  { table: 'meta_conversion_event_logs', column: 'contact_id' },
  { table: 'whatsapp_attribution', column: 'contact_id' },
  { table: 'whatsapp_api_contacts', column: 'contact_id' },
  { table: 'whatsapp_api_messages', column: 'contact_id' },
  { table: 'whatsapp_api_attribution', column: 'contact_id' },
  { table: 'scheduled_chat_messages', column: 'contact_id' },
  { table: 'payment_flows', column: 'contact_id' },
  { table: 'sessions', column: 'contact_id' },
  { table: 'video_playback_sessions', column: 'contact_id' },
  { table: 'video_playback_events', column: 'contact_id' },
  { table: 'conversational_agent_safety_cases', column: 'contact_id', mergeStrategy: 'conversational_agent_safety' },
  { table: 'conversational_agent_safety_events', column: 'contact_id', mergeStrategy: 'conversational_agent_safety' }
]

// Tablas que NO referencian contacts.id aunque tengan columna contact_id propia
// (hoy no existe ninguna; las columnas tipo whatsapp_api_contact_id ya quedan
// fuera porque la búsqueda es por nombre exacto de columna).
let contactReferenceTablesCache = null

// Descubre dinámicamente todas las tablas con columna contact_id (FK lógica a
// contacts.id). Evita que merges/migraciones dejen referencias huérfanas cuando
// se agregan tablas nuevas y nadie actualiza las listas estáticas.
export async function getContactReferenceTables() {
  if (contactReferenceTablesCache) return contactReferenceTablesCache

  const names = []
  try {
    if (usePostgres) {
      const rows = await db.all(`
        SELECT c.table_name AS name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE c.column_name = 'contact_id'
          AND c.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
      `)
      for (const row of rows) names.push(row.name)
    } else {
      const tables = await db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      for (const table of tables) {
        const columns = await db.all(`PRAGMA table_info("${table.name}")`)
        if (columns.some(column => column.name === 'contact_id')) names.push(table.name)
      }
    }
  } catch (err) {
    logger.warn(`No se pudieron descubrir tablas con contact_id, usando lista estática: ${err.message}`)
    return CONTACT_PHONE_REFERENCE_TABLES.map(reference => ({
      table: reference.table,
      deleteOnConflict: Boolean(reference.deleteOnConflict),
      mergeStrategy: reference.mergeStrategy || null
    }))
  }

  contactReferenceTablesCache = names
    .filter(name => name !== 'contacts')
    .map(name => ({
      table: name,
      deleteOnConflict: name === 'appointment_attendance_signals',
      mergeStrategy: isConversationalAgentSafetyReferenceTable(name) ? 'conversational_agent_safety' : null
    }))

  return contactReferenceTablesCache
}

export function isWhatsAppAutoCreatedContact(contact = {}) {
  const id = String(contact.id || '')
  const source = String(contact.source || '').toLowerCase()
  return id.startsWith('waapi_contact_') || source === 'whatsapp_api'
}

function getContactPhoneScore(contact = {}, canonicalPhone = '') {
  let score = 0
  const source = String(contact.source || '').toLowerCase()

  if (!isWhatsAppAutoCreatedContact(contact)) score += 1000
  if (Number(contact.total_paid || 0) > 0) score += 500
  if (Number(contact.purchases_count || 0) > 0) score += 250
  if (source.includes('gohighlevel') || source.includes('highlevel')) score += 150
  if (contact.phone === canonicalPhone) score += 50

  return score
}

function pickContactPhoneWinner(contacts = [], canonicalPhone = '') {
  return [...contacts].sort((a, b) => {
    const scoreDiff = getContactPhoneScore(b, canonicalPhone) - getContactPhoneScore(a, canonicalPhone)
    if (scoreDiff !== 0) return scoreDiff
    return String(a.created_at || '').localeCompare(String(b.created_at || ''))
  })[0]
}

async function updateContactReferences(fromId, toId) {
  const references = await getContactReferenceTables()
  await mergeConversationalAgentSafetyContactReferences({
    connection: db,
    fromContactId: fromId,
    toContactId: toId,
    usePostgres
  })

  for (const reference of references) {
    if (reference.mergeStrategy === 'conversational_agent_safety') continue
    try {
      await db.run(
        `UPDATE ${reference.table} SET contact_id = ? WHERE contact_id = ?`,
        [toId, fromId]
      )
    } catch (err) {
      if (reference.deleteOnConflict) {
        await db.run(`DELETE FROM ${reference.table} WHERE contact_id = ?`, [fromId])
        continue
      }

      logger.warn(`Advertencia al fusionar referencias ${reference.table}.contact_id: ${err.message}`)
    }
  }
}

async function syncContactPhoneColumns(contactId, canonicalPhone) {
  const updates = [
    ['whatsapp_attribution', 'phone'],
    ['whatsapp_api_contacts', 'phone'],
    ['whatsapp_api_messages', 'phone'],
    ['whatsapp_api_attribution', 'phone'],
    ['payment_flows', 'contact_phone']
  ]

  for (const [table, column] of updates) {
    try {
      await db.run(`UPDATE ${table} SET ${column} = ? WHERE contact_id = ?`, [canonicalPhone, contactId])
    } catch (err) {
      logger.warn(`Advertencia al normalizar ${table}.${column}: ${err.message}`)
    }
  }
}

async function reconcileCanonicalContactPhones() {
  const rows = await db.all(`
    SELECT id, phone, email, full_name, first_name, last_name, source, visitor_id,
      attribution_url, attribution_session_source, attribution_medium, attribution_ctwa_clid,
      attribution_ad_name, attribution_ad_id, total_paid, purchases_count, created_at
    FROM contacts
    WHERE phone IS NOT NULL AND phone != ''
  `)

  const groups = new Map()
  for (const row of rows) {
    const canonicalPhone = normalizePhoneForStorage(row.phone)
    if (!canonicalPhone) continue
    if (!groups.has(canonicalPhone)) groups.set(canonicalPhone, [])
    groups.get(canonicalPhone).push(row)
  }

  let changed = 0

  for (const [canonicalPhone, contacts] of groups.entries()) {
    if (contacts.length === 1) {
      const [contact] = contacts
      if (contact.phone !== canonicalPhone) {
        await db.run(
          'UPDATE contacts SET phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [canonicalPhone, contact.id]
        )
        await syncContactPhoneColumns(contact.id, canonicalPhone)
        changed += 1
      }
      continue
    }

    const winner = pickContactPhoneWinner(contacts, canonicalPhone)
    const losers = contacts.filter(contact => contact.id !== winner.id)
    const merged = { ...winner }

    for (const loser of losers) {
      for (const field of [
        'full_name',
        'email',
        'first_name',
        'last_name',
        'source',
        'visitor_id',
        'attribution_url',
        'attribution_session_source',
        'attribution_medium',
        'attribution_ctwa_clid',
        'attribution_ad_name',
        'attribution_ad_id'
      ]) {
        if (!merged[field] && loser[field]) merged[field] = loser[field]
      }

      // (DB-007) Al fusionar contactos duplicados se SUMAN los acumulados, no se toma el MAX:
      // cada registro acumuló su propio total_paid/purchases_count de sus propios pagos, y
      // updateContactReferences() repunta los pagos del loser al winner. Con MAX se perdía
      // dinero (un cliente que pagó 100 en un registro y 50 en otro quedaba con 100). SUM es
      // consistente con el otro camino de fusión (contactIdentityService.mergeContactIds).
      merged.total_paid = Number(merged.total_paid || 0) + Number(loser.total_paid || 0)
      merged.purchases_count = Number(merged.purchases_count || 0) + Number(loser.purchases_count || 0)

      await db.run('UPDATE contacts SET phone = NULL, email = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [loser.id])
      await updateContactReferences(loser.id, winner.id)
      await db.run('DELETE FROM contacts WHERE id = ?', [loser.id])
      changed += 1
    }

    await db.run(`
      UPDATE contacts SET
        phone = ?,
        email = ?,
        full_name = ?,
        first_name = ?,
        last_name = ?,
        source = ?,
        visitor_id = ?,
        attribution_url = ?,
        attribution_session_source = ?,
        attribution_medium = ?,
        attribution_ctwa_clid = ?,
        attribution_ad_name = ?,
        attribution_ad_id = ?,
        total_paid = ?,
        purchases_count = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      canonicalPhone,
      merged.email || null,
      merged.full_name || null,
      merged.first_name || null,
      merged.last_name || null,
      merged.source || null,
      merged.visitor_id || null,
      merged.attribution_url || null,
      merged.attribution_session_source || null,
      merged.attribution_medium || null,
      merged.attribution_ctwa_clid || null,
      merged.attribution_ad_name || null,
      merged.attribution_ad_id || null,
      Number(merged.total_paid || 0),
      Number(merged.purchases_count || 0),
      winner.id
    ])
    await syncContactPhoneColumns(winner.id, canonicalPhone)
  }

  if (changed > 0) {
    logger.success(`✅ Migración: ${changed} contactos normalizados/fusionados por teléfono`)
  }
}

// Prefijos de IDs generados por Ristak. Cualquier contacto cuyo id NO tenga uno
// de estos prefijos se asume keyed por el ID de HighLevel (comportamiento legacy:
// el sync usaba el ID de GHL como primary key local).
const RISTAK_CONTACT_ID_PREFIXES = ['rstk_', 'waapi_', 'manual_contact_', 'meta_social_contact_', 'site_contact_']

// Copia el ID de GHL (que era la primary key) a la columna ghl_contact_id para
// que el vínculo con HighLevel sea explícito y deje de depender de la PK.
async function backfillGhlContactIds() {
  const exclusions = RISTAK_CONTACT_ID_PREFIXES.map(prefix => `id NOT LIKE '${prefix}%'`).join(' AND ')
  return updateRowsInBatches({
    table: 'contacts',
    setSql: 'ghl_contact_id = id',
    whereSql: `(ghl_contact_id IS NULL OR ghl_contact_id = '') AND ${exclusions}`,
    label: 'Contactos HighLevel ligados por ghl_contact_id'
  })
}

async function seedPrimaryContactPhoneNumbersInBatches({ batchSize = STARTUP_DATA_BATCH_SIZE } = {}) {
  let lastId = ''
  let seeded = 0

  while (true) {
    const rows = await db.all(`
      SELECT c.id, c.phone
      FROM contacts c
      WHERE c.id > ?
        AND c.phone IS NOT NULL
        AND c.phone != ''
        AND NOT EXISTS (
          SELECT 1
          FROM contact_phone_numbers cpn
          WHERE cpn.contact_id = c.id
            AND cpn.is_primary = 1
        )
      ORDER BY c.id
      LIMIT ?
    `, [lastId, batchSize])
    if (!rows.length) break

    for (const row of rows) {
      const phone = normalizePhoneForStorage(row.phone) || String(row.phone || '').trim()
      if (!phone) continue

      const result = await db.run(`
        INSERT INTO contact_phone_numbers (
          id, contact_id, phone, label, is_primary, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(phone) DO UPDATE SET
          is_primary = CASE
            WHEN contact_phone_numbers.contact_id = excluded.contact_id THEN 1
            ELSE contact_phone_numbers.is_primary
          END,
          updated_at = CASE
            WHEN contact_phone_numbers.contact_id = excluded.contact_id THEN CURRENT_TIMESTAMP
            ELSE contact_phone_numbers.updated_at
          END
      `, [
        createRistakId('contact_phone'),
        row.id,
        phone,
        'Principal',
        'legacy'
      ])
      seeded += Number(result?.changes || 0)
    }

    lastId = String(rows[rows.length - 1].id || lastId)
    await sleep(25)
  }

  if (seeded > 0) logger.info(`[Arranque] Teléfonos principales: ${seeded} fila(s) preparadas en lotes.`)
  return seeded
}

async function backfillWhatsAppProviderContractInBatches() {
  const jobs = [
    {
      table: 'whatsapp_message_templates',
      label: 'Plantillas WhatsApp legacy',
      setSql: `
        template_provider = COALESCE(NULLIF(template_provider, ''), 'ycloud'),
        provider_template_name = COALESCE(provider_template_name, ycloud_template_name),
        provider_template_id = COALESCE(provider_template_id, ycloud_template_id),
        provider_status = COALESCE(provider_status, ycloud_status),
        provider_reason = COALESCE(provider_reason, ycloud_reason),
        provider_status_update_event = COALESCE(provider_status_update_event, ycloud_status_update_event),
        provider_quality_rating = COALESCE(provider_quality_rating, ycloud_quality_rating),
        provider_raw_payload_json = COALESCE(provider_raw_payload_json, ycloud_raw_payload_json),
        provider_submitted_at = COALESCE(provider_submitted_at, ycloud_submitted_at),
        provider_synced_at = COALESCE(provider_synced_at, ycloud_synced_at)
      `,
      whereSql: `
        COALESCE(ycloud_template_id, ycloud_template_name, ycloud_status) IS NOT NULL
        AND (
          COALESCE(template_provider, '') = ''
          OR provider_template_name IS NULL
          OR provider_template_id IS NULL
          OR provider_status IS NULL
        )
      `
    },
    {
      table: 'whatsapp_api_templates',
      label: 'Plantillas API oficiales',
      setSql: `
        provider = COALESCE(NULLIF(provider, ''), 'ycloud'),
        source_adapter = COALESCE(NULLIF(source_adapter, ''), 'ycloud'),
        provider_template_id = COALESCE(provider_template_id, official_template_id, id),
        provider_create_time = COALESCE(provider_create_time, ycloud_create_time),
        provider_update_time = COALESCE(provider_update_time, ycloud_update_time)
      `,
      whereSql: `
        COALESCE(provider, '') = ''
        OR COALESCE(source_adapter, '') = ''
        OR provider_template_id IS NULL
        OR (provider_create_time IS NULL AND ycloud_create_time IS NOT NULL)
        OR (provider_update_time IS NULL AND ycloud_update_time IS NOT NULL)
      `
    },
    {
      table: 'whatsapp_api_messages',
      label: 'IDs Meta Directo',
      setSql: 'meta_message_id = ycloud_message_id, ycloud_message_id = NULL',
      whereSql: `
        LOWER(COALESCE(provider, '')) = 'meta_direct'
        AND COALESCE(meta_message_id, '') = ''
        AND COALESCE(ycloud_message_id, '') != ''
      `
    },
    {
      table: 'whatsapp_api_messages',
      label: 'IDs neutrales de mensajes',
      setSql: `provider_message_id = COALESCE(NULLIF(meta_message_id, ''), NULLIF(ycloud_message_id, ''), NULLIF(wamid, ''))`,
      whereSql: `
        COALESCE(provider_message_id, '') = ''
        AND COALESCE(NULLIF(meta_message_id, ''), NULLIF(ycloud_message_id, ''), NULLIF(wamid, '')) IS NOT NULL
      `
    },
    {
      table: 'whatsapp_api_messages',
      label: 'Adaptadores de mensajes',
      setSql: `source_adapter = CASE
        WHEN LOWER(COALESCE(transport, '')) = 'qr' OR LOWER(COALESCE(provider, '')) = 'qr' THEN 'baileys'
        WHEN LOWER(COALESCE(provider, '')) = 'meta_direct' THEN 'meta_direct'
        ELSE 'ycloud'
      END`,
      whereSql: `COALESCE(source_adapter, '') != CASE
        WHEN LOWER(COALESCE(transport, '')) = 'qr' OR LOWER(COALESCE(provider, '')) = 'qr' THEN 'baileys'
        WHEN LOWER(COALESCE(provider, '')) = 'meta_direct' THEN 'meta_direct'
        ELSE 'ycloud'
      END`
    },
    {
      table: 'whatsapp_api_webhook_events',
      label: 'Proveedor de webhooks',
      setSql: `provider = CASE
        WHEN LOWER(COALESCE(event_type, '')) LIKE 'meta.%'
          OR LOWER(COALESCE(webhook_endpoint_id, '')) = 'installer_relay' THEN 'meta_direct'
        ELSE 'ycloud'
      END`,
      whereSql: `COALESCE(provider, '') != CASE
        WHEN LOWER(COALESCE(event_type, '')) LIKE 'meta.%'
          OR LOWER(COALESCE(webhook_endpoint_id, '')) = 'installer_relay' THEN 'meta_direct'
        ELSE 'ycloud'
      END`
    },
    {
      table: 'whatsapp_api_template_sends',
      label: 'Envíos de plantillas',
      setSql: `
        provider_message_id = COALESCE(NULLIF(ycloud_message_id, ''), NULLIF(wamid, '')),
        provider = COALESCE(NULLIF(provider, ''), 'ycloud'),
        source_adapter = COALESCE(NULLIF(source_adapter, ''), 'ycloud')
      `,
      whereSql: `
        COALESCE(provider_message_id, '') = ''
        AND COALESCE(NULLIF(ycloud_message_id, ''), NULLIF(wamid, '')) IS NOT NULL
      `
    }
  ]

  let updated = 0
  for (const job of jobs) {
    updated += await updateRowsInBatches(job)
  }
  return updated
}

// Re-identifica los contactos creados por WhatsApp (waapi_contact_<hash>) con el
// ID propio de Ristak (rstk_contact_<alfanumérico>), re-apuntando todas las tablas que
// los referencian. El orden insertar-copia → mover referencias → borrar original
// es seguro tanto en SQLite como en PostgreSQL con FKs activas.
async function migrateWhatsAppContactIdsToRistak() {
  const legacyRows = await db.all(`SELECT id FROM contacts WHERE id LIKE 'waapi_contact_%'`)
  if (!legacyRows.length) return

  const referenceTables = await getContactReferenceTables()
  let migrated = 0

  for (const legacy of legacyRows) {
    const contact = await db.get('SELECT * FROM contacts WHERE id = ?', [legacy.id])
    if (!contact) continue

    const newId = createRistakId('contact')
    const columns = Object.keys(contact)
    const values = columns.map(column => {
      if (column === 'id') return newId
      // phone/email se insertan NULL y se restauran al final para no chocar con
      // sus constraints UNIQUE mientras conviven la copia y el original.
      if (column === 'phone' || column === 'email') return null
      const value = contact[column]
      if (value instanceof Date) return value
      if (value && typeof value === 'object') {
        try { return JSON.stringify(value) } catch { return null }
      }
      return value
    })

    try {
      await db.run(
        `INSERT INTO contacts (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        values
      )

      await mergeConversationalAgentSafetyContactReferences({
        connection: db,
        fromContactId: legacy.id,
        toContactId: newId,
        usePostgres
      })

      for (const reference of referenceTables) {
        if (reference.mergeStrategy === 'conversational_agent_safety') continue
        try {
          await db.run(`UPDATE ${reference.table} SET contact_id = ? WHERE contact_id = ?`, [newId, legacy.id])
        } catch (err) {
          if (reference.deleteOnConflict) {
            await db.run(`DELETE FROM ${reference.table} WHERE contact_id = ?`, [legacy.id])
            continue
          }
          logger.warn(`No se pudo reasignar ${reference.table}.contact_id de ${legacy.id} a ${newId}: ${err.message}`)
        }
      }

      await db.run('DELETE FROM contacts WHERE id = ?', [legacy.id])
      await db.run(
        'UPDATE contacts SET phone = ?, email = ? WHERE id = ?',
        [contact.phone || null, contact.email || null, newId]
      )
      migrated += 1
    } catch (err) {
      logger.warn(`No se pudo migrar el contacto ${legacy.id} a ID Ristak: ${err.message}`)
    }
  }

  if (migrated > 0) {
    logger.success(`✅ Migración: ${migrated} contactos WhatsApp ahora usan ID propio rstk_contact_*`)
  }
}

// chat_read_states tiene PK (user_id, contact_id): al fusionar many->one hay que
// resolver la colisión manualmente (la fila del destino gana) antes del repunte
// genérico, que no maneja este UNIQUE.
async function mergeChatReadStatesForContact(fromContact, toContact) {
  let rows = []
  try {
    rows = await db.all('SELECT user_id FROM chat_read_states WHERE contact_id = ?', [fromContact])
  } catch {
    return
  }
  for (const r of rows) {
    try {
      const existing = await db.get(
        'SELECT 1 FROM chat_read_states WHERE user_id = ? AND contact_id = ?',
        [r.user_id, toContact]
      )
      if (existing) {
        await db.run('DELETE FROM chat_read_states WHERE user_id = ? AND contact_id = ?', [r.user_id, fromContact])
      } else {
        await db.run('UPDATE chat_read_states SET contact_id = ? WHERE user_id = ? AND contact_id = ?', [toContact, r.user_id, fromContact])
      }
    } catch (err) {
      logger.warn(`Fusión social: chat_read_states user ${r.user_id}: ${err.message}`)
    }
  }
}

// MIGRACIÓN idempotente: fusiona los contactos-comentario ya partidos (senderId
// con prefijo 'fb_comment:'/'ig_comment:') con el contacto DM de la MISMA persona
// (mismo platform + id crudo). Modelo nuevo: cada persona = un contacto por red;
// comentario vs DM vive en message_type. IG vs Facebook se quedan separados (no
// comparten id). Sin transacción (updateContactReferences usa el db global y prod
// es Postgres con pool): secuencial + ordenado (repuntar refs, borrar al final);
// re-ejecutable — una vez fusionado no quedan filas con el prefijo.
async function mergeSplitSocialCommentContacts() {
  let commentRows = []
  try {
    commentRows = await db.all(
      `SELECT id, platform, sender_id, meta_user_id, contact_id, profile_name, username
         FROM meta_social_contacts
        WHERE sender_id LIKE '%comment:%'`
    )
  } catch {
    return
  }
  if (!commentRows.length) return

  const referenceTables = await getContactReferenceTables()
  let mergedIntoDm = 0
  let convertedInPlace = 0

  for (const row of commentRows) {
    const rawId = String(row.sender_id || '').replace(/^(fb|ig)_comment:/, '')
    if (!rawId || rawId === String(row.sender_id || '')) continue
    const platform = row.platform

    try {
      // ¿Existe el registro DM (mismo platform, id crudo, sin prefijo)?
      const dm = await db.get(
        `SELECT id, contact_id FROM meta_social_contacts
          WHERE platform = ? AND sender_id = ? AND COALESCE(sender_id, '') NOT LIKE '%comment:%'
          LIMIT 1`,
        [platform, rawId]
      )

      if (dm && dm.contact_id && row.contact_id) {
        // CASO A: la persona ya tiene contacto DM → fusionar el comentario ahí.
        const fromContact = row.contact_id
        const toContact = dm.contact_id

        // Reapuntar los mensajes al perfil social del DM.
        await db.run(
          'UPDATE meta_social_messages SET meta_social_contact_id = ? WHERE meta_social_contact_id = ?',
          [dm.id, row.id]
        )

        if (fromContact !== toContact) {
          // chat_read_states primero (colisión de PK), luego el repunte genérico.
          await mergeChatReadStatesForContact(fromContact, toContact)
          await mergeConversationalAgentSafetyContactReferences({
            connection: db,
            fromContactId: fromContact,
            toContactId: toContact,
            usePostgres
          })
          for (const reference of referenceTables) {
            if (reference.mergeStrategy === 'conversational_agent_safety') continue
            try {
              await db.run(`UPDATE ${reference.table} SET contact_id = ? WHERE contact_id = ?`, [toContact, fromContact])
            } catch (err) {
              if (reference.deleteOnConflict) {
                await db.run(`DELETE FROM ${reference.table} WHERE contact_id = ?`, [fromContact])
                continue
              }
              logger.warn(`Fusión social: no se pudo repuntar ${reference.table}.contact_id: ${err.message}`)
            }
          }
          await db.run('DELETE FROM contacts WHERE id = ?', [fromContact])
          mergedIntoDm += 1
        }
        // Quitar el meta_social_contacts prefijado (redundante) al final.
        await db.run('DELETE FROM meta_social_contacts WHERE id = ?', [row.id])
      } else if (!dm) {
        // CASO B: no hay DM → convertir el registro-comentario en el contacto persona
        // reescribiendo el senderId al id crudo (si no choca con un DM existente).
        const clash = await db.get(
          `SELECT id FROM meta_social_contacts WHERE platform = ? AND sender_id = ? AND id <> ? LIMIT 1`,
          [platform, rawId, row.id]
        )
        if (clash) continue
        await db.run(
          `UPDATE meta_social_contacts
              SET sender_id = ?, meta_user_id = COALESCE(NULLIF(meta_user_id, ''), ?), updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
          [rawId, rawId, row.id]
        )
        // Nombre: si el full_name es sintético (@usuario o vacío), poner el real.
        const realName = String(row.profile_name || '').trim()
        if (row.contact_id && realName) {
          const c = await db.get('SELECT full_name FROM contacts WHERE id = ?', [row.contact_id])
          const stored = String(c?.full_name || '').trim()
          const uname = String(row.username || '').trim().toLowerCase()
          const looksSynthetic = !stored || stored.startsWith('@') || (uname && stored.toLowerCase() === `@${uname}`)
          if (looksSynthetic) {
            await db.run('UPDATE contacts SET full_name = ? WHERE id = ?', [realName, row.contact_id])
          }
        }
        convertedInPlace += 1
      }
      // dm existe pero mismo contact_id (ya fusionado) → nada que hacer.
    } catch (err) {
      logger.warn(`Fusión social: no se pudo procesar ${row.id}: ${err.message}`)
    }
  }

  if (mergedIntoDm || convertedInPlace) {
    logger.success(`✅ Fusión de contactos sociales: ${mergedIntoDm} comentario→DM, ${convertedInPlace} convertidos en su lugar.`)
  }
}

function parseStoredDate(value) {
  if (!value) return ''
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
}

function isDateEarlier(candidate, current) {
  const candidateDate = parseStoredDate(candidate)
  if (!candidateDate) return false
  const currentDate = parseStoredDate(current)
  if (!currentDate) return true
  return new Date(candidateDate).getTime() < new Date(currentDate).getTime()
}

function parseJsonMaybe(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function isWhatsAppApiSource(value = '') {
  return String(value || '').trim().toLowerCase() === 'whatsapp_api'
}

function cleanRepairText(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function isValidRepairTimezone(timezone) {
  if (!timezone || typeof timezone !== 'string') return false
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

function resolveRepairTimezone(timezone, fallback = DEFAULT_BUSINESS_TIMEZONE) {
  return isValidRepairTimezone(timezone)
    ? timezone
    : (isValidRepairTimezone(fallback) ? fallback : DEFAULT_BUSINESS_TIMEZONE)
}

async function getWhatsAppApiRepairTimezone() {
  const override = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    [ACCOUNT_TIMEZONE_CONFIG_KEY]
  ).catch(() => null)

  if (override?.config_value && isValidRepairTimezone(override.config_value)) {
    return override.config_value
  }

  const config = await db.get('SELECT location_data FROM highlevel_config LIMIT 1').catch(() => null)
  if (config?.location_data) {
    try {
      const locationData = JSON.parse(config.location_data)
      if (locationData?.timezone && isValidRepairTimezone(locationData.timezone)) {
        return locationData.timezone
      }
    } catch {
      // Si la config historica viene rota, caemos al default seguro.
    }
  }

  return DEFAULT_BUSINESS_TIMEZONE
}

function normalizeRepairDateOnlyInTimezone(value, timezone = DEFAULT_BUSINESS_TIMEZONE, fallbackDate = '') {
  const zone = resolveRepairTimezone(timezone)
  const fallback = fallbackDate
    ? DateTime.fromISO(String(fallbackDate), { zone })
    : DateTime.now().setZone(zone)

  if (value === null || value === undefined || value === '') {
    return (fallback.isValid ? fallback : DateTime.now().setZone(zone)).toISODate()
  }

  const text = String(value).trim()
  const dateOnly = text.match(/^(\d{4}-\d{2}-\d{2})$/)
  if (dateOnly) return dateOnly[1]

  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
  let parsed = hasExplicitZone
    ? DateTime.fromISO(text, { setZone: true }).setZone(zone)
    : DateTime.fromISO(text, { zone })

  if (!parsed.isValid) parsed = DateTime.fromSQL(text, { zone })
  if (!parsed.isValid) {
    const fallbackJs = new Date(text)
    if (!Number.isNaN(fallbackJs.getTime())) {
      parsed = DateTime.fromJSDate(fallbackJs).setZone(zone)
    }
  }

  return parsed.isValid
    ? parsed.toISODate()
    : (fallback.isValid ? fallback : DateTime.now().setZone(zone)).toISODate()
}

function sourceTypeLooksLikeAd(value = '') {
  const normalized = cleanRepairText(value).toLowerCase().replace(/[\s-]+/g, '_')
  return ['ad', 'ads', 'advertisement', 'click_to_whatsapp', 'ctwa'].includes(normalized)
}

function normalizeWhatsAppApiAdAttributionCandidate(message = {}) {
  const rawPayload = parseJsonMaybe(message.raw_payload_json, null)
  const referral = parseJsonMaybe(message.referral_json, null)
  const detected = detectWhatsAppAttributionFields({
    message: rawPayload,
    referral,
    row: message
  }, [message.message_text || ''])

  const persistedSourceId = cleanRepairText(message.detected_source_id)
  const ristakAdId = cleanRepairText(detected.ristakAdId)
  const officialSourceId = cleanRepairText(
    detected.officialSourceId ||
    (persistedSourceId && persistedSourceId !== ristakAdId ? persistedSourceId : '')
  )
  const sourceId = cleanRepairText(persistedSourceId || detected.sourceId || officialSourceId || ristakAdId)
  if (!sourceId) return null

  const ctwaClid = cleanRepairText(message.detected_ctwa_clid || detected.ctwaClid)
  const sourceType = cleanRepairText(message.detected_source_type || detected.sourceType)
  const sourceUrl = cleanRepairText(message.detected_source_url || detected.sourceUrl)
  const headline = cleanRepairText(message.detected_headline || detected.headline)

  if (!ctwaClid && !sourceTypeLooksLikeAd(sourceType) && !sourceUrl && !headline) return null

  return {
    messageId: cleanRepairText(message.message_id),
    attributionId: cleanRepairText(message.attribution_id),
    sourceId,
    persistedSourceId,
    officialSourceId,
    ristakAdId,
    ctwaClid,
    sourceUrl,
    sourceType,
    sourceApp: cleanRepairText(message.detected_source_app || detected.sourceApp),
    entryPoint: cleanRepairText(message.detected_entry_point || detected.entryPoint),
    headline,
    body: cleanRepairText(message.detected_body || detected.body),
    at: parseStoredDate(message.message_timestamp || message.attribution_created_at || message.created_at)
  }
}

async function isKnownMetaAdIdOnBusinessDay(adId = '', at = '', timezone = DEFAULT_BUSINESS_TIMEZONE) {
  const cleanAdId = cleanRepairText(adId)
  if (!cleanAdId) return false
  if (!at) return isKnownMetaAdId(cleanAdId)

  const businessDate = normalizeRepairDateOnlyInTimezone(at, timezone)
  const row = await db.get(
    'SELECT 1 AS found FROM meta_ads WHERE ad_id = ? AND date = ? LIMIT 1',
    [cleanAdId, businessDate]
  ).catch(() => null)
  return Boolean(row?.found)
}

async function resolveWhatsAppApiAdAttributionCandidate(candidate = {}, timezone = DEFAULT_BUSINESS_TIMEZONE) {
  const officialSourceId = cleanRepairText(candidate.officialSourceId)
  const ristakAdId = cleanRepairText(candidate.ristakAdId)
  const defaultSourceId = cleanRepairText(candidate.sourceId || officialSourceId || ristakAdId)
  if (!defaultSourceId) return null

  if (!officialSourceId || !ristakAdId || officialSourceId === ristakAdId) {
    return {
      ...candidate,
      sourceId: defaultSourceId,
      sourceType: defaultSourceId === ristakAdId && !candidate.sourceType ? 'ad' : candidate.sourceType
    }
  }

  const [officialMatchedMetaAds, ristakMatchedMetaAds] = await Promise.all([
    isKnownMetaAdIdOnBusinessDay(officialSourceId, candidate.at, timezone),
    isKnownMetaAdIdOnBusinessDay(ristakAdId, candidate.at, timezone)
  ])

  if (!officialMatchedMetaAds && ristakMatchedMetaAds) {
    return {
      ...candidate,
      sourceId: ristakAdId,
      sourceType: candidate.sourceType || 'ad',
      sourceIdResolution: 'rstkad_live_ad_wins'
    }
  }

  return {
    ...candidate,
    sourceId: officialSourceId || defaultSourceId,
    sourceIdResolution: officialMatchedMetaAds && ristakMatchedMetaAds
      ? 'both_matched_official_wins'
      : (officialMatchedMetaAds ? 'official_live_ad_wins' : 'official_default')
  }
}

async function collectWhatsAppApiAdAttributions(messages = []) {
  const timezone = await getWhatsAppApiRepairTimezone()
  const candidates = []
  for (const message of messages) {
    const candidate = normalizeWhatsAppApiAdAttributionCandidate(message)
    const resolvedCandidate = candidate
      ? await resolveWhatsAppApiAdAttributionCandidate(candidate, timezone)
      : null
    if (resolvedCandidate) candidates.push(resolvedCandidate)
  }

  return candidates
}

async function pickWhatsAppApiAdAttribution(messages = []) {
  return (await collectWhatsAppApiAdAttributions(messages))[0] || null
}

async function repairWhatsAppApiResolvedAdTouches(candidates = []) {
  let repaired = 0
  const seen = new Set()

  for (const candidate of candidates) {
    const sourceId = cleanRepairText(candidate.sourceId)
    const persistedSourceId = cleanRepairText(candidate.persistedSourceId)
    if (!sourceId || persistedSourceId === sourceId) continue

    const key = `${candidate.messageId || ''}|${candidate.attributionId || ''}|${sourceId}`
    if (seen.has(key)) continue
    seen.add(key)

    let touched = false
    if (candidate.messageId) {
      await db.run(
        'UPDATE whatsapp_api_messages SET detected_source_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [sourceId, candidate.messageId]
      ).catch(() => undefined)
      touched = true
    }
    if (candidate.attributionId) {
      await db.run(
        'UPDATE whatsapp_api_attribution SET detected_source_id = ? WHERE id = ?',
        [sourceId, candidate.attributionId]
      ).catch(() => undefined)
      touched = true
    }

    if (touched) repaired += 1
  }

  return repaired
}

async function isKnownMetaAdId(adId = '') {
  const cleanAdId = cleanRepairText(adId)
  if (!cleanAdId) return false
  const row = await db.get('SELECT 1 AS found FROM meta_ads WHERE ad_id = ? LIMIT 1', [cleanAdId]).catch(() => null)
  return Boolean(row?.found)
}

async function shouldReplaceWhatsAppApiAdAttribution(row = {}, candidate = null, candidates = []) {
  if (!candidate?.sourceId) return false

  const currentAdId = cleanRepairText(row.attribution_ad_id)
  if (!currentAdId) return true
  if (currentAdId === candidate.sourceId) return false

  const currentIsLaterWhatsappTouch = candidates
    .slice(1)
    .some(item => cleanRepairText(item.sourceId) === currentAdId)
  if (currentIsLaterWhatsappTouch) return true

  const rawProfile = parseJsonMaybe(row.raw_profile_json, null)
  const ycloudContactSourceId = cleanRepairText(rawProfile?.sourceId || rawProfile?.source_id)
  if (ycloudContactSourceId && currentAdId === ycloudContactSourceId) return true

  if (!isWhatsAppApiSource(row.source)) return false
  const timezone = await getWhatsAppApiRepairTimezone()
  return !(await isKnownMetaAdIdOnBusinessDay(currentAdId, row.created_at || candidate.at, timezone))
}

function comparableRepairName(value = '') {
  return cleanRepairText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function shouldClearNameOnlyWhatsAppApiAdAttribution(row = {}, profileName = '') {
  const adId = cleanRepairText(row.attribution_ad_id)
  const adName = cleanRepairText(row.attribution_ad_name)
  if (adId || !adName) return false

  const rawProfile = parseJsonMaybe(row.raw_profile_json, null)
  const rawProfileName = extractWhatsAppProfileName(rawProfile, row.phone)
  const adNameKey = comparableRepairName(adName)
  if (!adNameKey) return false

  return [
    row.full_name,
    row.first_name,
    row.profile_name,
    profileName,
    rawProfileName
  ].some(value => comparableRepairName(value) === adNameKey)
}

export async function repairWhatsAppApiContactIdentityFromMessages({ limit = 5000 } = {}) {
  const normalizedLimit = Number(limit)
  const rowLimit = Number.isFinite(normalizedLimit) && normalizedLimit > 0
    ? Math.max(Math.floor(normalizedLimit), 1)
    : null
  const limitClause = rowLimit ? 'LIMIT ?' : ''
  const limitParams = rowLimit ? [rowLimit] : []
  const rows = await db.all(`
    SELECT
      c.id,
      c.phone,
      c.full_name,
      c.first_name,
      c.source,
      c.attribution_ad_id,
      c.attribution_ad_name,
      c.attribution_ctwa_clid,
      c.attribution_url,
      c.attribution_session_source,
      c.attribution_medium,
      c.created_at,
      wac.id AS api_contact_id,
      wac.profile_name,
      wac.raw_profile_json,
      wac.first_seen_at
    FROM contacts c
    LEFT JOIN whatsapp_api_contacts wac
      ON wac.contact_id = c.id
      OR (
        c.phone IS NOT NULL AND c.phone != ''
        AND wac.phone IS NOT NULL AND wac.phone != ''
        AND wac.phone = c.phone
      )
    WHERE LOWER(COALESCE(c.source, '')) = 'whatsapp_api'
      OR wac.id IS NOT NULL
    ORDER BY
      CASE
        WHEN wac.first_seen_at IS NOT NULL
          AND c.created_at IS NOT NULL
          AND wac.first_seen_at < c.created_at THEN 0
        WHEN LOWER(COALESCE(c.full_name, '')) IN ('contacto whatsapp api', 'contacto whatsapp_api') THEN 0
        WHEN LOWER(COALESCE(c.first_name, '')) IN ('contacto whatsapp api', 'contacto whatsapp_api') THEN 0
        WHEN LOWER(COALESCE(wac.profile_name, '')) IN ('contacto whatsapp api', 'contacto whatsapp_api') THEN 0
        WHEN c.attribution_ad_id IS NULL
          AND c.attribution_ad_name IS NOT NULL
          AND c.attribution_ad_name != '' THEN 0
        ELSE 1
      END,
      COALESCE(c.updated_at, c.created_at, wac.updated_at, wac.first_seen_at) DESC
    ${limitClause}
  `, limitParams).catch(() => [])

  let repairedContacts = 0
  let repairedApiContacts = 0
  let restoredFirstAdAttributions = 0
  let repairedAdTouches = 0

  for (const row of rows) {
    const phone = normalizePhoneForStorage(row.phone) || String(row.phone || '').trim()
    const messages = await db.all(`
      SELECT
        msg.id AS message_id,
        attr.id AS attribution_id,
        msg.message_timestamp,
        msg.created_at,
        msg.message_text,
        msg.raw_payload_json,
        msg.referral_json,
        attr.created_at AS attribution_created_at,
        COALESCE(attr.detected_ctwa_clid, msg.detected_ctwa_clid) AS detected_ctwa_clid,
        COALESCE(attr.detected_source_id, msg.detected_source_id) AS detected_source_id,
        COALESCE(attr.detected_source_url, msg.detected_source_url) AS detected_source_url,
        COALESCE(attr.detected_source_type, msg.detected_source_type) AS detected_source_type,
        COALESCE(attr.detected_source_app, msg.detected_source_app) AS detected_source_app,
        COALESCE(attr.detected_entry_point, msg.detected_entry_point) AS detected_entry_point,
        COALESCE(attr.detected_headline, msg.detected_headline) AS detected_headline,
        COALESCE(attr.detected_body, msg.detected_body) AS detected_body
      FROM whatsapp_api_messages msg
      LEFT JOIN whatsapp_api_attribution attr ON attr.whatsapp_api_message_id = msg.id
      WHERE msg.contact_id = ?
        OR attr.contact_id = ?
        OR (? != '' AND msg.phone = ?)
        OR (? != '' AND attr.phone = ?)
      ORDER BY COALESCE(msg.message_timestamp, attr.created_at, msg.created_at) ASC, msg.created_at ASC
      LIMIT 500
    `, [row.id, row.id, phone || '', phone || '', phone || '', phone || '']).catch(() => [])
    const adMessages = await db.all(`
      SELECT
        msg.id AS message_id,
        attr.id AS attribution_id,
        msg.message_timestamp,
        msg.created_at,
        msg.message_text,
        msg.raw_payload_json,
        msg.referral_json,
        attr.created_at AS attribution_created_at,
        COALESCE(attr.detected_ctwa_clid, msg.detected_ctwa_clid) AS detected_ctwa_clid,
        COALESCE(attr.detected_source_id, msg.detected_source_id) AS detected_source_id,
        COALESCE(attr.detected_source_url, msg.detected_source_url) AS detected_source_url,
        COALESCE(attr.detected_source_type, msg.detected_source_type) AS detected_source_type,
        COALESCE(attr.detected_source_app, msg.detected_source_app) AS detected_source_app,
        COALESCE(attr.detected_entry_point, msg.detected_entry_point) AS detected_entry_point,
        COALESCE(attr.detected_headline, msg.detected_headline) AS detected_headline,
        COALESCE(attr.detected_body, msg.detected_body) AS detected_body
      FROM whatsapp_api_messages msg
      LEFT JOIN whatsapp_api_attribution attr ON attr.whatsapp_api_message_id = msg.id
      WHERE (msg.contact_id = ? OR attr.contact_id = ?
        OR (? != '' AND msg.phone = ?)
        OR (? != '' AND attr.phone = ?))
        AND LOWER(COALESCE(msg.direction, 'inbound')) NOT IN ('outbound', 'business_echo')
        AND (
          COALESCE(attr.detected_ctwa_clid, msg.detected_ctwa_clid, '') != ''
          OR COALESCE(attr.detected_source_id, msg.detected_source_id, '') != ''
          OR COALESCE(attr.detected_source_url, msg.detected_source_url, '') != ''
          OR COALESCE(attr.detected_source_type, msg.detected_source_type, '') != ''
          OR COALESCE(attr.detected_headline, msg.detected_headline, '') != ''
          OR COALESCE(msg.referral_json, '') != ''
          OR LOWER(COALESCE(msg.message_text, '')) LIKE '%rstkad_id=%!%'
          OR LOWER(COALESCE(msg.raw_payload_json, '')) LIKE '%rstkad_id%'
          OR LOWER(COALESCE(msg.raw_payload_json, '')) LIKE '%source_id%'
          OR LOWER(COALESCE(msg.raw_payload_json, '')) LIKE '%sourceid%'
          OR LOWER(COALESCE(msg.raw_payload_json, '')) LIKE '%ad_id%'
        )
      ORDER BY COALESCE(msg.message_timestamp, attr.created_at, msg.created_at) ASC, msg.created_at ASC
      LIMIT 2000
    `, [row.id, row.id, phone || '', phone || '', phone || '', phone || '']).catch(() => [])
    const firstMessage = messages.find(message => message.message_timestamp || message.created_at)
    const firstMessageAt = parseStoredDate(
      firstMessage?.message_timestamp ||
      firstMessage?.attribution_created_at ||
      firstMessage?.created_at ||
      row.first_seen_at
    )

    let profileName = extractWhatsAppProfileName(row.raw_profile_json, phone)
    if (!profileName) {
      for (const message of messages) {
        profileName = extractWhatsAppProfileName(parseJsonMaybe(message.raw_payload_json), phone)
        if (profileName) break
      }
    }

    const contactUpdates = []
    const contactParams = []
    const primaryAdAttributionCandidates = await collectWhatsAppApiAdAttributions(adMessages.length ? adMessages : messages)
    const fallbackAdAttributionCandidates = primaryAdAttributionCandidates.length
      ? []
      : await collectWhatsAppApiAdAttributions(messages)
    const adAttributionCandidates = primaryAdAttributionCandidates.length
      ? primaryAdAttributionCandidates
      : fallbackAdAttributionCandidates
    const adAttribution = adAttributionCandidates[0] || await pickWhatsAppApiAdAttribution(messages)
    repairedAdTouches += await repairWhatsAppApiResolvedAdTouches(adAttributionCandidates)
    const shouldReplaceAdAttribution = await shouldReplaceWhatsAppApiAdAttribution(row, adAttribution, adAttributionCandidates)
    const currentAdId = cleanRepairText(row.attribution_ad_id)
    const isReplacingDifferentAdId = shouldReplaceAdAttribution && currentAdId && currentAdId !== adAttribution?.sourceId

    if (!shouldReplaceAdAttribution && shouldClearNameOnlyWhatsAppApiAdAttribution(row, profileName)) {
      contactUpdates.push('attribution_ad_name = NULL')
    }

    if (profileName && shouldReplaceWhatsAppApiContactName(row.full_name, phone)) {
      contactUpdates.push('full_name = ?')
      contactParams.push(profileName)
      contactUpdates.push('first_name = ?')
      contactParams.push(profileName)
    }

    if (isWhatsAppApiSource(row.source) && firstMessageAt && isDateEarlier(firstMessageAt, row.created_at)) {
      contactUpdates.push('created_at = ?')
      contactParams.push(firstMessageAt)
    }

    if (shouldReplaceAdAttribution) {
      contactUpdates.push('attribution_ad_id = ?')
      contactParams.push(adAttribution.sourceId)
      if (adAttribution.ctwaClid || isReplacingDifferentAdId) {
        contactUpdates.push('attribution_ctwa_clid = ?')
        contactParams.push(adAttribution.ctwaClid || null)
      }
      if (adAttribution.headline || isReplacingDifferentAdId) {
        contactUpdates.push('attribution_ad_name = ?')
        contactParams.push(adAttribution.headline || adAttribution.sourceId)
      }
      if (adAttribution.sourceUrl) {
        contactUpdates.push(isReplacingDifferentAdId
          ? 'attribution_url = ?'
          : 'attribution_url = COALESCE(NULLIF(attribution_url, \'\'), ?)')
        contactParams.push(adAttribution.sourceUrl)
      }
      if (adAttribution.sourceApp || adAttribution.entryPoint) {
        contactUpdates.push(isReplacingDifferentAdId
          ? 'attribution_session_source = ?'
          : 'attribution_session_source = COALESCE(NULLIF(attribution_session_source, \'\'), ?)')
        contactParams.push(adAttribution.sourceApp || adAttribution.entryPoint)
      }
      if (adAttribution.sourceType) {
        contactUpdates.push(isReplacingDifferentAdId
          ? 'attribution_medium = ?'
          : 'attribution_medium = COALESCE(NULLIF(attribution_medium, \'\'), ?)')
        contactParams.push(adAttribution.sourceType)
      }
      if (isReplacingDifferentAdId) restoredFirstAdAttributions += 1
    }

    if (contactUpdates.length) {
      contactUpdates.push('updated_at = CURRENT_TIMESTAMP')
      contactParams.push(row.id)
      await db.run(`UPDATE contacts SET ${contactUpdates.join(', ')} WHERE id = ?`, contactParams)
      repairedContacts += 1
    }

    if (row.api_contact_id) {
      const apiUpdates = []
      const apiParams = []

      if (profileName && shouldReplaceWhatsAppApiContactName(row.profile_name, phone)) {
        apiUpdates.push('profile_name = ?')
        apiParams.push(profileName)
      }

      if (firstMessageAt && isDateEarlier(firstMessageAt, row.first_seen_at)) {
        apiUpdates.push('first_seen_at = ?')
        apiParams.push(firstMessageAt)
      }

      if (apiUpdates.length) {
        apiUpdates.push('updated_at = CURRENT_TIMESTAMP')
        apiParams.push(row.api_contact_id)
        await db.run(`UPDATE whatsapp_api_contacts SET ${apiUpdates.join(', ')} WHERE id = ?`, apiParams)
        repairedApiContacts += 1
      }
    }
  }

  if (repairedContacts > 0 || repairedApiContacts > 0 || repairedAdTouches > 0) {
    const firstAdText = restoredFirstAdAttributions
      ? `; ${restoredFirstAdAttributions} atribuciones de primer anuncio restauradas`
      : ''
    const touchText = repairedAdTouches
      ? `; ${repairedAdTouches} touches de anuncio corregidos`
      : ''
    logger.success(`✅ Reparación WhatsApp API: ${repairedContacts} contactos y ${repairedApiContacts} perfiles ajustados con historial real${firstAdText}${touchText}`)
  }

  return { contacts: repairedContacts, apiContacts: repairedApiContacts, restoredFirstAdAttributions, repairedAdTouches }
}

const SUBSCRIPTION_MERCADOPAGO_COLUMNS = [
  ['mercadopago_preapproval_id', 'TEXT'],
  ['mercadopago_preapproval_plan_id', 'TEXT'],
  ['mercadopago_init_point', 'TEXT'],
  ['mercadopago_sandbox_init_point', 'TEXT'],
  ['mercadopago_payer_id', 'TEXT'],
  ['mercadopago_card_id', 'TEXT'],
  ['mercadopago_payment_method_id', 'TEXT'],
  ['mercadopago_next_payment_date', 'DATETIME']
]

const SUBSCRIPTION_CONEKTA_COLUMNS = [
  ['conekta_customer_id', 'TEXT'],
  ['conekta_plan_id', 'TEXT'],
  ['conekta_subscription_id', 'TEXT'],
  ['conekta_payment_source_id', 'TEXT'],
  ['conekta_next_billing_at', 'DATETIME']
]

const SUBSCRIPTION_REBILL_COLUMNS = [
  ['rebill_subscription_id', 'TEXT'],
  ['rebill_plan_id', 'TEXT'],
  ['rebill_payment_link_id', 'TEXT'],
  ['rebill_payment_link_url', 'TEXT'],
  ['rebill_customer_id', 'TEXT'],
  ['rebill_card_id', 'TEXT'],
  ['rebill_next_charge_at', 'DATETIME'],
  ['rebill_last_charge_at', 'DATETIME']
]

const PAYMENT_CLIP_COLUMNS = [
  ['clip_payment_id', 'TEXT'],
  ['clip_receipt_no', 'TEXT']
]

const PAYMENT_REBILL_COLUMNS = [
  ['rebill_payment_id', 'TEXT'],
  ['rebill_subscription_id', 'TEXT'],
  ['rebill_customer_id', 'TEXT'],
  ['rebill_card_id', 'TEXT']
]

function isExistingColumnError(err) {
  const message = String(err?.message || '')
  return message.includes('duplicate column') || message.includes('already exists')
}

async function ensureTableColumns(tableName, columns) {
  for (const [column, type] of columns) {
    try {
      await db.run(`ALTER TABLE ${tableName} ADD COLUMN ${column} ${type}`)
    } catch (err) {
      if (!isExistingColumnError(err)) {
        throw err
      }
    }
  }
}

async function removeObsoleteMetaCapiColumn() {
  if (usePostgres) {
    await db.run('ALTER TABLE meta_config DROP COLUMN IF EXISTS pixel_api_token')
    return
  }

  const columns = await db.all('PRAGMA table_info(meta_config)').catch(() => [])
  const hasColumn = columns.some(column => column.name === 'pixel_api_token')
  if (!hasColumn) return

  await db.run('PRAGMA foreign_keys=off')
  try {
    await db.exec(`
      DROP TABLE IF EXISTS meta_config_capi_cleanup;
      CREATE TABLE meta_config_capi_cleanup (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ad_account_id TEXT UNIQUE,
        access_token TEXT NOT NULL,
        app_id TEXT,
        app_secret TEXT,
        messenger_user_token TEXT,
        meta_business_id TEXT,
        token_expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        timezone_id INTEGER,
        timezone_name TEXT,
        timezone_offset_hours_utc INTEGER,
        pixel_id TEXT,
        page_id TEXT,
        instagram_account_id TEXT
      );
      INSERT INTO meta_config_capi_cleanup (
        id, ad_account_id, access_token, app_id, app_secret, messenger_user_token,
        meta_business_id, token_expires_at,
        created_at, updated_at, timezone_id, timezone_name, timezone_offset_hours_utc,
        pixel_id, page_id, instagram_account_id
      )
      SELECT
        id, ad_account_id, access_token, app_id, app_secret, messenger_user_token,
        meta_business_id, token_expires_at,
        created_at, updated_at, timezone_id, timezone_name, timezone_offset_hours_utc,
        pixel_id, page_id, instagram_account_id
      FROM meta_config;
      DROP TABLE meta_config;
      ALTER TABLE meta_config_capi_cleanup RENAME TO meta_config;
    `)
  } finally {
    await db.run('PRAGMA foreign_keys=on')
  }
}

const CONVERSATIONAL_AGENT_STATE_COLUMNS = [
  'id',
  'contact_id',
  'status',
  'signal',
  'signal_reason',
  'signal_summary',
  'signal_at',
  'last_inbound_message_id',
  'last_answered_inbound_message_id',
  'last_reply_at',
  'channel',
  'inbound_processing_message_id',
  'inbound_processing_status',
  'inbound_processing_claim_token',
  'inbound_processing_lease_until_at',
  'inbound_processing_started_at',
  'inbound_processing_attempt_count',
  'inbound_processing_last_error',
  'follow_up_base_message_id',
  'follow_up_sent_count',
  'follow_up_last_sent_at',
  'paused_until_at',
  'activated_at',
  'activation_source',
  'activated_by',
  'assignment_source',
  'assigned_at',
  'assigned_by',
  'updated_by',
  'agent_id',
  'created_at',
  'updated_at'
]

async function ensureConversationalAgentStateIdentity() {
  if (usePostgres) {
    await db.run('ALTER TABLE conversational_agent_state ADD COLUMN IF NOT EXISTS id TEXT').catch(() => undefined)
    await db.run(`
      UPDATE conversational_agent_state
      SET id = 'cas_' || md5(COALESCE(contact_id, '') || COALESCE(agent_id, '') || random()::text || clock_timestamp()::text)
      WHERE id IS NULL OR id = ''
    `).catch(() => undefined)
    await db.run('ALTER TABLE conversational_agent_state ALTER COLUMN id SET NOT NULL').catch(() => undefined)
    await db.exec(`
      DO $$
      DECLARE pk_name text;
      DECLARE pk_columns text;
      BEGIN
        SELECT tc.constraint_name, string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position)
          INTO pk_name, pk_columns
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'conversational_agent_state'
          AND tc.constraint_type = 'PRIMARY KEY'
        GROUP BY tc.constraint_name;

        IF pk_name IS NOT NULL AND pk_columns <> 'id' THEN
          EXECUTE format('ALTER TABLE conversational_agent_state DROP CONSTRAINT %I', pk_name);
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE table_schema = 'public'
            AND table_name = 'conversational_agent_state'
            AND constraint_type = 'PRIMARY KEY'
        ) THEN
          ALTER TABLE conversational_agent_state ADD CONSTRAINT conversational_agent_state_pkey PRIMARY KEY (id);
        END IF;
      END $$;
    `).catch((err) => {
      logger.warn(`No se pudo migrar la llave primaria del estado conversacional: ${err.message}`)
    })
  } else {
    const columns = await db.all('PRAGMA table_info(conversational_agent_state)').catch(() => [])
    const idColumn = columns.find((column) => column.name === 'id')
    const primaryColumns = columns
      .filter((column) => Number(column.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((column) => column.name)

    if (!idColumn || primaryColumns.join(',') !== 'id') {
      const selectedColumns = CONVERSATIONAL_AGENT_STATE_COLUMNS
        .filter((column) => column !== 'id')
        .map((column) => (columns.some((item) => item.name === column) ? column : 'NULL'))
        .join(', ')

      await db.transaction(async (tx) => {
        await tx.run(`
          CREATE TABLE IF NOT EXISTS conversational_agent_state_next (
            id ${usePostgres ? "TEXT PRIMARY KEY DEFAULT ('cas_' || md5(random()::text || clock_timestamp()::text))" : "TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))"},
            contact_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            signal TEXT,
            signal_reason TEXT,
            signal_summary TEXT,
            signal_at DATETIME,
            last_inbound_message_id TEXT,
            last_answered_inbound_message_id TEXT,
            last_reply_at DATETIME,
            channel TEXT DEFAULT 'whatsapp',
            inbound_processing_message_id TEXT,
            inbound_processing_status TEXT,
            inbound_processing_claim_token TEXT,
            inbound_processing_lease_until_at DATETIME,
            inbound_processing_started_at DATETIME,
            inbound_processing_attempt_count INTEGER DEFAULT 0,
            inbound_processing_last_error TEXT,
            follow_up_base_message_id TEXT,
            follow_up_sent_count INTEGER DEFAULT 0,
            follow_up_last_sent_at DATETIME,
            paused_until_at DATETIME,
            activated_at DATETIME,
            activation_source TEXT,
            activated_by TEXT,
            assignment_source TEXT,
            assigned_at DATETIME,
            assigned_by TEXT,
            updated_by TEXT,
            agent_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
          )
        `)
        await tx.run(`
          INSERT INTO conversational_agent_state_next (${CONVERSATIONAL_AGENT_STATE_COLUMNS.join(', ')})
          SELECT 'cas_' || lower(hex(randomblob(16))), ${selectedColumns}
          FROM conversational_agent_state
        `)
        await tx.run('DROP TABLE conversational_agent_state')
        await tx.run('ALTER TABLE conversational_agent_state_next RENAME TO conversational_agent_state')
      })
      logger.info('[Agente conversacional] Estado migrado a llave independiente por agente')
    }
  }

  // La identidad del runtime es contacto + agente + canal. El índice anterior
  // (contacto + agente) hacía que WhatsApp, Instagram y correo compartieran
  // silencios, claims y cierres aunque fueran conversaciones independientes.
  await db.run('DROP INDEX IF EXISTS idx_conv_agent_state_contact_agent_unique').catch(() => undefined)
  await db.run(`
    UPDATE conversational_agent_state
    SET channel = 'whatsapp'
    WHERE channel IS NULL OR TRIM(channel) = ''
  `).catch(() => undefined)
  await db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_state_contact_agent_channel_unique
    ON conversational_agent_state(contact_id, agent_id, channel)
    WHERE agent_id IS NOT NULL
  `).catch((err) => {
    logger.warn(`No se pudo crear la identidad por canal del estado conversacional: ${err.message}`)
  })
}

// Inicializar tablas
async function initTablesUnlocked() {
  try {
    // Tabla de configuración de HighLevel
    await db.run(`
      CREATE TABLE IF NOT EXISTS highlevel_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        location_id TEXT UNIQUE,
        api_token TEXT,
        location_data TEXT,
        custom_labels TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Tabla de configuración global de la app (independiente de HighLevel)
    await db.run(`
      CREATE TABLE IF NOT EXISTS app_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        config_key TEXT UNIQUE NOT NULL,
        config_value TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    try {
      if (usePostgres) {
        await db.run(`
          DELETE FROM app_config a
          USING app_config b
          WHERE a.config_key = b.config_key
            AND a.id < b.id
        `)
      } else {
        await db.run(`
          DELETE FROM app_config
          WHERE id NOT IN (
            SELECT MAX(id)
            FROM app_config
            GROUP BY config_key
          )
        `)
      }

      await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_app_config_config_key ON app_config(config_key)')
    } catch (err) {
      logger.warn('Advertencia al asegurar unicidad de app_config.config_key:', err.message)
    }

    const schemaBootstrap = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ? LIMIT 1',
      [CORE_SCHEMA_BOOTSTRAP_CONFIG_KEY]
    ).catch(() => null)
    if (schemaBootstrap?.config_value === CORE_SCHEMA_BOOTSTRAP_VERSION) {
      logger.info(`[Esquema] Bootstrap ${CORE_SCHEMA_BOOTSTRAP_VERSION} ya aplicado; se omite el replay legacy.`)
      return { skipped: true, version: CORE_SCHEMA_BOOTSTRAP_VERSION }
    }

    // (MOB-006) Configuración por-usuario (espejo de app_config). Cuando un usuario
    // no tiene fila para una clave, hereda el valor global de app_config (fallback en
    // getUserAppConfig). user_id es INTEGER porque users.id es INTEGER.
    await db.run(`
      CREATE TABLE IF NOT EXISTS user_app_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        config_key TEXT NOT NULL,
        config_value TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_app_config_user_key ON user_app_config(user_id, config_key)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        endpoint TEXT UNIQUE NOT NULL,
        subscription_json TEXT NOT NULL,
        calendar_ids_json TEXT,
        enabled INTEGER DEFAULT 1,
        user_agent TEXT,
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS mobile_push_devices (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        platform TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        client_type TEXT,
        app_package TEXT,
        calendar_ids_json TEXT,
        enabled INTEGER DEFAULT 1,
        app_version TEXT,
        app_build TEXT,
        device_model TEXT,
        os_version TEXT,
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS internal_notifications (
        id TEXT PRIMARY KEY,
        recipient_user_id TEXT,
        source TEXT DEFAULT 'Ristak',
        severity TEXT DEFAULT 'info',
        title TEXT NOT NULL,
        message TEXT,
        action_url TEXT,
        action_label TEXT,
        category TEXT DEFAULT 'internal',
        contact_id TEXT,
        automation_id TEXT,
        automation_node_id TEXT,
        enrollment_id TEXT,
        metadata_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    try {
      await db.run('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_enabled ON push_subscriptions(enabled)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_enabled_user ON push_subscriptions(enabled, user_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_mobile_push_devices_enabled ON mobile_push_devices(enabled)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_mobile_push_devices_user ON mobile_push_devices(user_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_mobile_push_devices_enabled_user ON mobile_push_devices(enabled, user_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_mobile_push_devices_platform ON mobile_push_devices(platform)')
      await ensureTableColumns('mobile_push_devices', [
        ['client_type', 'TEXT'],
        ['app_package', 'TEXT']
      ])
      await db.run('CREATE INDEX IF NOT EXISTS idx_internal_notifications_recipient ON internal_notifications(recipient_user_id, updated_at)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_internal_notifications_contact ON internal_notifications(contact_id, updated_at)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_internal_notifications_automation ON internal_notifications(automation_id, updated_at)')
    } catch (err) {
      logger.warn('Advertencia al crear índices de avisos push:', err.message)
    }

    // Sites públicos/formularios. El dashboard administra la estructura, pero
    // el render público se decide estrictamente por dominio verificado.
    await db.run(`
      CREATE TABLE IF NOT EXISTS public_sites (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        site_type TEXT DEFAULT 'standard_form',
        status TEXT DEFAULT 'draft',
        domain TEXT UNIQUE,
        title TEXT,
        description TEXT,
        theme_json TEXT,
        anti_tracking_enabled INTEGER DEFAULT 1,
        meta_capi_enabled INTEGER DEFAULT 0,
        meta_event_name TEXT DEFAULT 'Lead',
        render_domain_verified INTEGER DEFAULT 0,
        render_domain_checked_at DATETIME,
        render_domain_error TEXT,
        published_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS public_site_blocks (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        block_type TEXT NOT NULL,
        label TEXT,
        content TEXT,
        placeholder TEXT,
        required INTEGER DEFAULT 0,
        options_json TEXT,
        settings_json TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (site_id) REFERENCES public_sites(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS public_site_domains (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL UNIQUE,
        render_domain_verified INTEGER DEFAULT 0,
        render_domain_checked_at DATETIME,
        render_domain_error TEXT,
        default_route_site_id TEXT,
        default_route_page_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS public_site_submissions (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        form_site_id TEXT,
        contact_id TEXT,
        domain TEXT,
        response_json TEXT NOT NULL,
        raw_fields_json TEXT,
        mapped_fields_json TEXT,
        derived_fields_json TEXT,
        meta_json TEXT,
        status TEXT DEFAULT 'received',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (site_id) REFERENCES public_sites(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS public_site_imports (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL UNIQUE,
        original_filename TEXT,
        import_type TEXT DEFAULT 'html',
        html_original TEXT,
        html_sanitized TEXT NOT NULL,
        detected_forms_json TEXT,
        form_mappings_json TEXT,
        security_report_json TEXT,
        status TEXT DEFAULT 'mapping_pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (site_id) REFERENCES public_sites(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS public_site_import_assets (
        id TEXT PRIMARY KEY,
        import_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        asset_path TEXT NOT NULL,
        content_type TEXT NOT NULL,
        content_base64 TEXT NOT NULL,
        media_asset_id TEXT,
        public_url TEXT,
        storage_provider TEXT,
        size_bytes INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (import_id) REFERENCES public_site_imports(id) ON DELETE CASCADE,
        FOREIGN KEY (site_id) REFERENCES public_sites(id) ON DELETE CASCADE
      )
    `)

    // Alias estables de contenido para páginas HTML. El HTML guarda asset_key;
    // media_asset_id puede cambiar cuando el usuario reemplaza el archivo.
    await db.run(`
      CREATE TABLE IF NOT EXISTS public_site_content_assets (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        asset_key TEXT NOT NULL,
        label TEXT,
        kind TEXT DEFAULT 'other',
        media_asset_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (site_id) REFERENCES public_sites(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS public_site_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        section TEXT DEFAULT 'forms',
        sort_order INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    for (const [columnName, columnType] of [
      ['domain', 'TEXT UNIQUE'],
      ['title', 'TEXT'],
      ['description', 'TEXT'],
      ['theme_json', 'TEXT'],
      ['anti_tracking_enabled', 'INTEGER DEFAULT 1'],
      ['meta_capi_enabled', 'INTEGER DEFAULT 0'],
      ['meta_event_name', "TEXT DEFAULT 'Lead'"],
      ['render_domain_verified', 'INTEGER DEFAULT 0'],
      ['render_domain_checked_at', 'DATETIME'],
      ['render_domain_error', 'TEXT'],
      ['published_at', 'DATETIME']
    ]) {
      try {
        await db.run(`ALTER TABLE public_sites ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          logger.warn(`Advertencia al migrar public_sites.${columnName}: ${err.message}`)
        }
      }
    }

    for (const [columnName, columnType] of [
      ['form_site_id', 'TEXT'],
      ['raw_fields_json', 'TEXT'],
      ['mapped_fields_json', 'TEXT'],
      ['derived_fields_json', 'TEXT']
    ]) {
      try {
        await db.run(`ALTER TABLE public_site_submissions ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          logger.warn(`Advertencia al migrar public_site_submissions.${columnName}: ${err.message}`)
        }
      }
    }

    for (const [columnName, columnType] of [
      ['media_asset_id', 'TEXT'],
      ['public_url', 'TEXT'],
      ['storage_provider', 'TEXT']
    ]) {
      try {
        await db.run(`ALTER TABLE public_site_import_assets ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          logger.warn(`Advertencia al migrar public_site_import_assets.${columnName}: ${err.message}`)
        }
      }
    }

    try {
      await db.run('CREATE INDEX IF NOT EXISTS idx_public_sites_status ON public_sites(status)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_public_site_blocks_site_order ON public_site_blocks(site_id, sort_order)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_public_site_submissions_site ON public_site_submissions(site_id, created_at)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_public_site_submissions_form_site ON public_site_submissions(form_site_id, created_at)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_public_site_submissions_contact ON public_site_submissions(contact_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_public_site_imports_site ON public_site_imports(site_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_public_site_import_assets_import ON public_site_import_assets(import_id)')
      await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_public_site_import_assets_site_path ON public_site_import_assets(site_id, asset_path)')
      await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_public_site_content_assets_site_key ON public_site_content_assets(site_id, asset_key)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_public_site_content_assets_media ON public_site_content_assets(media_asset_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_public_site_folders_section_order ON public_site_folders(section, archived, sort_order, name)')
      await db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_public_sites_domain_lower ON public_sites(LOWER(domain)) WHERE domain IS NOT NULL AND domain != ''")
      await db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_public_site_domains_domain_lower ON public_site_domains(LOWER(domain)) WHERE domain IS NOT NULL AND domain != ''")
      await db.run('CREATE INDEX IF NOT EXISTS idx_public_site_domains_created ON public_site_domains(created_at)')
    } catch (err) {
      logger.warn('Advertencia al crear índices de public sites:', err.message)
    }

    // Tabla de configuración del agente AI
    await db.run(`
      CREATE TABLE IF NOT EXISTS ai_agent_config (
        id ${usePostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
        openai_api_key_encrypted TEXT,
        model ${DEFAULT_OPENAI_MODEL_COLUMN},
        business_context TEXT,
        market_context TEXT,
        ideal_customer TEXT,
        location_context TEXT,
        competitors_context TEXT,
        brand_voice TEXT,
        research_domains TEXT,
        response_style TEXT DEFAULT 'advisor',
        recommendation_mode TEXT DEFAULT 'when_useful',
        web_search_enabled INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    const aiAgentColumns = [
      ['business_context', 'TEXT'],
      ['market_context', 'TEXT'],
      ['ideal_customer', 'TEXT'],
      ['location_context', 'TEXT'],
      ['competitors_context', 'TEXT'],
      ['brand_voice', 'TEXT'],
      ['research_domains', 'TEXT'],
      ['response_style', "TEXT DEFAULT 'advisor'"],
      ['recommendation_mode', "TEXT DEFAULT 'when_useful'"],
      ['web_search_enabled', 'INTEGER DEFAULT 0']
    ]

    for (const [columnName, columnType] of aiAgentColumns) {
      try {
        await db.run(`ALTER TABLE ai_agent_config ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Ignore if the column already exists.
      }
    }

    await db.run(`
      CREATE TABLE IF NOT EXISTS ai_business_profile (
        id ${usePostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
        source_context TEXT,
        source_hash TEXT,
        profile_json TEXT,
        prompt_parameters_json TEXT,
        profile_summary TEXT,
        business_name TEXT,
        industry TEXT,
        business_type TEXT,
        offerings_summary TEXT,
        pricing_summary TEXT,
        location_summary TEXT,
        payment_summary TEXT,
        contact_summary TEXT,
        extraction_status TEXT DEFAULT 'empty',
        extraction_error TEXT,
        extracted_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    const aiBusinessProfileColumns = [
      ['source_context', 'TEXT'],
      ['source_hash', 'TEXT'],
      ['profile_json', 'TEXT'],
      ['prompt_parameters_json', 'TEXT'],
      ['profile_summary', 'TEXT'],
      ['business_name', 'TEXT'],
      ['industry', 'TEXT'],
      ['business_type', 'TEXT'],
      ['offerings_summary', 'TEXT'],
      ['pricing_summary', 'TEXT'],
      ['location_summary', 'TEXT'],
      ['payment_summary', 'TEXT'],
      ['contact_summary', 'TEXT'],
      ['extraction_status', "TEXT DEFAULT 'empty'"],
      ['extraction_error', 'TEXT'],
      ['extracted_at', 'DATETIME']
    ]

    for (const [columnName, columnType] of aiBusinessProfileColumns) {
      try {
        await db.run(`ALTER TABLE ai_business_profile ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Ignore if the column already exists.
      }
    }

    try {
      await db.run('CREATE INDEX IF NOT EXISTS idx_ai_business_profile_source_hash ON ai_business_profile(source_hash)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_ai_business_profile_status ON ai_business_profile(extraction_status)')
    } catch (err) {
      logger.warn('Advertencia al crear índices de ai_business_profile:', err.message)
    }

    // Insertar configuración por defecto de Analytics (visible por defecto)
    // Usar INSERT con ON CONFLICT para compatibilidad SQLite/PostgreSQL
    try {
      await db.run(`
        INSERT INTO app_config (config_key, config_value)
        VALUES ('show_analytics', '1')
        ON CONFLICT (config_key) DO NOTHING
      `)
    } catch (err) {
      // Ignore si ya existe
    }

    try {
      await db.run(`
        INSERT INTO app_config (config_key, config_value)
        VALUES ('dashboard_show_funnel_visitors', '1')
        ON CONFLICT (config_key) DO NOTHING
      `)
    } catch (err) {
      // Ignore si ya existe
    }

    try {
      await db.run(`
        INSERT INTO app_config (config_key, config_value)
        VALUES ('report_manual_business_expenses_enabled', '1')
        ON CONFLICT (config_key) DO NOTHING
      `)
    } catch (err) {
      // Ignore si ya existe
    }

    for (const configKey of DEFAULT_REPORT_TABLE_CONFIG_KEYS) {
      try {
        await db.run(`
          INSERT INTO app_config (config_key, config_value)
          VALUES (?, ?)
          ON CONFLICT (config_key) DO NOTHING
        `, [configKey, DEFAULT_REPORT_TABLE_CONFIG_VALUE])
      } catch (err) {
        // Ignore si ya existe
      }
    }

    // Almacenamiento multimedia centralizado. Estas tablas son seguras para
    // instalaciones nuevas y existentes: solo agregan metadata, cuotas y
    // configuración no sensible. Las llaves de Bunny viven en variables de entorno.
    await db.run(`
      CREATE TABLE IF NOT EXISTS media_assets (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL DEFAULT 'default',
        user_id TEXT,
        original_filename TEXT,
        stored_filename TEXT,
        bunny_path TEXT,
        folder_path TEXT NOT NULL DEFAULT '',
        public_url TEXT,
        private_url TEXT,
        mime_type TEXT,
        media_type TEXT,
        extension TEXT,
        size_original BIGINT DEFAULT 0,
        size_processed BIGINT DEFAULT 0,
        quota_size BIGINT DEFAULT 0,
        width INTEGER,
        height INTEGER,
        duration REAL,
        status TEXT DEFAULT 'ready',
        storage_provider TEXT DEFAULT 'bunny',
        storage_zone TEXT,
        cdn_base_url TEXT,
        module TEXT DEFAULT 'other',
        module_entity_id TEXT,
        is_public INTEGER DEFAULT 0,
        metadata_json TEXT,
        stream_video_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        deleted_at DATETIME
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS storage_quotas (
        business_id TEXT PRIMARY KEY,
        quota_gb REAL DEFAULT 5,
        quota_bytes BIGINT DEFAULT 5368709120,
        used_bytes BIGINT DEFAULT 0,
        extra_quota_gb REAL DEFAULT 0,
        storage_enabled INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Carpetas creadas por el usuario en Configuración > Media. Los archivos
    // siguen siendo la fuente de uso/cuota; esta tabla conserva también las
    // carpetas vacías como lo haría un explorador de archivos normal.
    await db.run(`
      CREATE TABLE IF NOT EXISTS media_folders (
        business_id TEXT NOT NULL,
        path TEXT NOT NULL,
        parent_path TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        created_by TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (business_id, path)
      )
    `)

    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_media_folders_parent
      ON media_folders(business_id, parent_path, name)
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS storage_settings (
        id INTEGER PRIMARY KEY,
        storage_provider TEXT DEFAULT 'bunny',
        storage_enabled INTEGER DEFAULT 1,
        default_storage_quota_gb REAL DEFAULT 5,
        compression_enabled INTEGER DEFAULT 1,
        image_optimization_enabled INTEGER DEFAULT 1,
        video_compression_enabled INTEGER DEFAULT 1,
        audio_compression_enabled INTEGER DEFAULT 1,
        bunny_storage_zone TEXT,
        bunny_storage_region TEXT,
        bunny_cdn_base_url TEXT,
        bunny_stream_enabled INTEGER DEFAULT 1,
        bunny_stream_library_id TEXT,
        bunny_stream_library_name TEXT,
        bunny_stream_collection_id TEXT,
        bunny_stream_collection_name TEXT,
        max_image_size_mb INTEGER DEFAULT 25,
        max_video_size_mb INTEGER DEFAULT 512,
        max_audio_size_mb INTEGER DEFAULT 100,
        max_document_size_mb INTEGER DEFAULT 50,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    for (const [columnName, columnType] of [
      ['business_id', "TEXT NOT NULL DEFAULT 'default'"],
      ['user_id', 'TEXT'],
      ['original_filename', 'TEXT'],
      ['stored_filename', 'TEXT'],
      ['bunny_path', 'TEXT'],
      ['folder_path', "TEXT NOT NULL DEFAULT ''"],
      ['public_url', 'TEXT'],
      ['private_url', 'TEXT'],
      ['mime_type', 'TEXT'],
      ['media_type', 'TEXT'],
      ['extension', 'TEXT'],
      ['size_original', 'BIGINT DEFAULT 0'],
      ['size_processed', 'BIGINT DEFAULT 0'],
      ['quota_size', 'BIGINT DEFAULT 0'],
      ['width', 'INTEGER'],
      ['height', 'INTEGER'],
      ['duration', 'REAL'],
      ['status', "TEXT DEFAULT 'ready'"],
      ['storage_provider', "TEXT DEFAULT 'bunny'"],
      ['storage_zone', 'TEXT'],
      ['cdn_base_url', 'TEXT'],
      ['module', "TEXT DEFAULT 'other'"],
      ['module_entity_id', 'TEXT'],
      ['is_public', 'INTEGER DEFAULT 0'],
      ['metadata_json', 'TEXT'],
      ['deleted_at', 'DATETIME']
    ]) {
      try {
        if (usePostgres) {
          await db.run(`ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS ${columnName} ${columnType}`)
        } else {
          await db.run(`ALTER TABLE media_assets ADD COLUMN ${columnName} ${columnType}`)
        }
      } catch (err) {
        // La columna ya existe.
      }
    }

    for (const [columnName, columnType] of [
      ['bunny_stream_enabled', 'INTEGER DEFAULT 1'],
      ['bunny_stream_library_name', 'TEXT'],
      ['bunny_stream_collection_id', 'TEXT'],
      ['bunny_stream_collection_name', 'TEXT'],
      // Slug legible y estable de la cuenta para las carpetas del Bunny central.
      // account_slug = nombre de la carpeta raíz del cliente (p.ej. "alexis-fitness-a1b2c3").
      // account_label = nombre bonito del negocio para documentar los _LEEME.txt.
      ['account_slug', 'TEXT'],
      ['account_label', 'TEXT'],
      // Marca de cuándo esta instalación ya corrió la auto-migración de taxonomía
      // (re-enraizado de lo viejo a accounts/<slug>). Se corre una sola vez.
      ['taxonomy_migrated_at', 'DATETIME'],
      ['taxonomy_migration_note', 'TEXT']
    ]) {
      try {
        if (usePostgres) {
          await db.run(`ALTER TABLE storage_settings ADD COLUMN IF NOT EXISTS ${columnName} ${columnType}`)
        } else {
          await db.run(`ALTER TABLE storage_settings ADD COLUMN ${columnName} ${columnType}`)
        }
      } catch (err) {
        // La columna ya existe.
      }
    }

    for (const [columnName, columnType] of [
      ['quota_gb', 'REAL DEFAULT 5'],
      ['quota_bytes', 'BIGINT DEFAULT 5368709120'],
      ['used_bytes', 'BIGINT DEFAULT 0'],
      ['extra_quota_gb', 'REAL DEFAULT 0'],
      ['storage_enabled', 'INTEGER DEFAULT 1']
    ]) {
      try {
        if (usePostgres) {
          await db.run(`ALTER TABLE storage_quotas ADD COLUMN IF NOT EXISTS ${columnName} ${columnType}`)
        } else {
          await db.run(`ALTER TABLE storage_quotas ADD COLUMN ${columnName} ${columnType}`)
        }
      } catch (err) {
        // La columna ya existe.
      }
    }

    try {
      if (usePostgres) {
        await db.run('ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS stream_video_id TEXT')
      } else {
        await db.run('ALTER TABLE media_assets ADD COLUMN stream_video_id TEXT')
      }
    } catch (err) {
      // La columna ya existe; la migración versionada hace el backfill seguro.
    }

    try {
      await db.run('CREATE INDEX IF NOT EXISTS idx_media_assets_business_status ON media_assets(business_id, status)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_media_assets_module ON media_assets(module, module_entity_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_media_assets_type ON media_assets(media_type)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_media_assets_deleted ON media_assets(deleted_at)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_media_assets_provider_path ON media_assets(storage_provider, bunny_path)')
    } catch (err) {
      logger.warn('Advertencia al crear índices de media_assets:', err.message)
    }

    try {
      await db.run(`
        INSERT INTO storage_settings (
          id,
          storage_provider,
          storage_enabled,
          default_storage_quota_gb,
          compression_enabled,
          image_optimization_enabled,
          video_compression_enabled,
          audio_compression_enabled,
          bunny_storage_zone,
          bunny_storage_region,
          bunny_cdn_base_url,
          bunny_stream_enabled,
          bunny_stream_library_id,
          bunny_stream_library_name,
          bunny_stream_collection_id,
          bunny_stream_collection_name,
          max_image_size_mb,
          max_video_size_mb,
          max_audio_size_mb,
          max_document_size_mb
        )
        VALUES (?, ?, 1, ?, 1, 1, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, 25, 512, 100, 50)
        ON CONFLICT (id) DO NOTHING
      `, [
        1,
        process.env.MEDIA_STORAGE_PROVIDER || 'bunny',
        Number(process.env.DEFAULT_STORAGE_QUOTA_GB || 5) || 5,
        process.env.BUNNY_STORAGE_ZONE || null,
        process.env.BUNNY_STORAGE_REGION || null,
        process.env.BUNNY_CDN_BASE_URL || null,
        process.env.BUNNY_STREAM_ENABLED === undefined ? 1 : /^(1|true|yes|si|on)$/i.test(String(process.env.BUNNY_STREAM_ENABLED).trim()) ? 1 : 0,
        process.env.BUNNY_STREAM_LIBRARY_ID || null,
        process.env.BUNNY_STREAM_LIBRARY_NAME || null,
        process.env.BUNNY_STREAM_COLLECTION_ID || null,
        process.env.BUNNY_STREAM_COLLECTION_NAME || null
      ])
    } catch (err) {
      logger.warn('Advertencia al crear configuración default de almacenamiento:', err.message)
    }

    try {
      const quotaGb = Number(process.env.DEFAULT_STORAGE_QUOTA_GB || 5) || 5
      await db.run(`
        INSERT INTO storage_quotas (business_id, quota_gb, quota_bytes, used_bytes, extra_quota_gb, storage_enabled)
        VALUES ('default', ?, ?, 0, 0, 1)
        ON CONFLICT (business_id) DO NOTHING
      `, [quotaGb, Math.round(quotaGb * 1024 * 1024 * 1024)])
    } catch (err) {
      logger.warn('Advertencia al crear cuota default de almacenamiento:', err.message)
    }

    // Plantillas internas de WhatsApp. Son locales a Ristak y usan campos
    // neutrales para YCloud o Meta directo; ycloud_* queda solo por compatibilidad.
    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_template_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (parent_id) REFERENCES whatsapp_template_folders(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_template_custom_fields (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        field_key TEXT UNIQUE NOT NULL,
        merge_field TEXT UNIQUE NOT NULL,
        example TEXT,
        data_type TEXT DEFAULT 'text',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_message_templates (
        id TEXT PRIMARY KEY,
        folder_id TEXT,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        category TEXT DEFAULT 'utility',
        language TEXT DEFAULT 'es_MX',
        status TEXT DEFAULT 'draft',
        header_enabled INTEGER DEFAULT 0,
        header_type TEXT DEFAULT 'none',
        header_text TEXT,
        header_media_url TEXT,
        meta_header_handle TEXT,
        header_location_json TEXT,
        body_text TEXT NOT NULL,
        footer_text TEXT,
        buttons_json TEXT,
        variables_json TEXT,
        variable_examples_json TEXT,
        variable_bindings_json TEXT,
        template_provider TEXT DEFAULT 'ycloud',
        provider_template_name TEXT,
        provider_template_id TEXT,
        provider_status TEXT,
        provider_reason TEXT,
        provider_status_update_event TEXT,
        provider_quality_rating TEXT,
        provider_raw_payload_json TEXT,
        provider_submitted_at DATETIME,
        provider_synced_at DATETIME,
        ycloud_template_name TEXT,
        ycloud_template_id TEXT,
        ycloud_status TEXT,
        ycloud_reason TEXT,
        ycloud_status_update_event TEXT,
        ycloud_quality_rating TEXT,
        ycloud_raw_payload_json TEXT,
        ycloud_submitted_at DATETIME,
        ycloud_synced_at DATETIME,
        ycloud_review_retry_count INTEGER DEFAULT 0,
        ycloud_review_retry_last_at DATETIME,
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (folder_id) REFERENCES whatsapp_template_folders(id) ON DELETE SET NULL
      )
    `)

    for (const [columnName, columnType] of [
      ['variable_bindings_json', 'TEXT'],
      ['meta_header_handle', 'TEXT'],
      ['template_provider', "TEXT DEFAULT 'ycloud'"],
      ['provider_template_name', 'TEXT'],
      ['provider_template_id', 'TEXT'],
      ['provider_status', 'TEXT'],
      ['provider_reason', 'TEXT'],
      ['provider_status_update_event', 'TEXT'],
      ['provider_quality_rating', 'TEXT'],
      ['provider_raw_payload_json', 'TEXT'],
      ['provider_submitted_at', 'DATETIME'],
      ['provider_synced_at', 'DATETIME'],
      ['ycloud_template_name', 'TEXT'],
      ['ycloud_reason', 'TEXT'],
      ['ycloud_status_update_event', 'TEXT'],
      ['ycloud_quality_rating', 'TEXT'],
      ['ycloud_raw_payload_json', 'TEXT'],
      ['ycloud_submitted_at', 'DATETIME'],
      ['ycloud_synced_at', 'DATETIME'],
      ['ycloud_review_retry_count', 'INTEGER DEFAULT 0'],
      ['ycloud_review_retry_last_at', 'DATETIME'],
      ['last_error', 'TEXT']
    ]) {
      try {
        await db.run(`ALTER TABLE whatsapp_message_templates ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Columna ya existe, ignorar.
      }
    }

    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_template_folders_parent ON whatsapp_template_folders(parent_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_message_templates_folder ON whatsapp_message_templates(folder_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_message_templates_status ON whatsapp_message_templates(status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_message_templates_ycloud ON whatsapp_message_templates(ycloud_status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_message_templates_provider ON whatsapp_message_templates(template_provider, provider_status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_message_templates_provider_id ON whatsapp_message_templates(template_provider, provider_template_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_template_custom_fields_key ON whatsapp_template_custom_fields(field_key)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS contact_custom_field_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        sort_order INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS contact_custom_field_definitions (
        id TEXT PRIMARY KEY,
        owner_user_id INTEGER,
        field_key TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT,
        data_type TEXT DEFAULT 'text',
        folder_id TEXT,
        field_group TEXT DEFAULT 'general',
        options_json TEXT,
        sync_target TEXT DEFAULT 'local',
        source_type TEXT DEFAULT 'manual',
        source_id TEXT,
        source_site_id TEXT,
        source_page_id TEXT,
        source_form_id TEXT,
        source_form_name TEXT,
        source_field_id TEXT,
        source_field_name TEXT,
        source_label TEXT,
        source_context_json TEXT,
        archived INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (folder_id) REFERENCES contact_custom_field_folders(id) ON DELETE SET NULL
      )
    `)

    try {
      await db.run('ALTER TABLE contact_custom_field_definitions ADD COLUMN folder_id TEXT')
    } catch (err) {
      // Columna ya existe, ignorar.
    }

    await db.run('CREATE INDEX IF NOT EXISTS idx_contact_custom_field_folders_archived ON contact_custom_field_folders(archived)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contact_custom_field_folders_sort ON contact_custom_field_folders(sort_order, name)')
    await db.run('DROP INDEX IF EXISTS idx_contact_custom_field_definitions_owner_key')
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_custom_field_definitions_owner_key ON contact_custom_field_definitions(COALESCE(owner_user_id, 0), LOWER(field_key)) WHERE archived = 0')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contact_custom_field_definitions_folder ON contact_custom_field_definitions(folder_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contact_custom_field_definitions_source_site ON contact_custom_field_definitions(source_site_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contact_custom_field_definitions_archived ON contact_custom_field_definitions(archived)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS contact_custom_field_definition_sources (
        id TEXT PRIMARY KEY,
        definition_id TEXT NOT NULL,
        source_type TEXT DEFAULT 'manual',
        source_id TEXT,
        source_site_id TEXT,
        source_page_id TEXT,
        source_form_id TEXT,
        source_form_name TEXT,
        source_field_id TEXT,
        source_field_name TEXT,
        source_label TEXT,
        source_context_json TEXT,
        occurrence_count INTEGER DEFAULT 1,
        first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (definition_id) REFERENCES contact_custom_field_definitions(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_custom_field_definition_sources_unique
      ON contact_custom_field_definition_sources(
        definition_id,
        source_type,
        COALESCE(source_id, ''),
        COALESCE(source_site_id, ''),
        COALESCE(source_page_id, ''),
        COALESCE(source_form_id, ''),
        COALESCE(source_field_id, ''),
        LOWER(COALESCE(source_field_name, ''))
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_contact_custom_field_definition_sources_definition ON contact_custom_field_definition_sources(definition_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contact_custom_field_definition_sources_site ON contact_custom_field_definition_sources(source_site_id)')

    // Campos variables: parámetros de cuenta/negocio que no dependen de un contacto.
    await db.run(`
      CREATE TABLE IF NOT EXISTS variable_fields (
        id TEXT PRIMARY KEY,
        field_key TEXT NOT NULL,
        label TEXT NOT NULL,
        value_text TEXT,
        description TEXT,
        archived INTEGER DEFAULT 0,
        created_by_user_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_variable_fields_key ON variable_fields(LOWER(field_key)) WHERE archived = 0')
    await db.run('CREATE INDEX IF NOT EXISTS idx_variable_fields_archived ON variable_fields(archived, updated_at)')

    // Tabla de contactos
    await db.run(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        phone TEXT UNIQUE,
        email TEXT UNIQUE,
        full_name TEXT,
        first_name TEXT,
        last_name TEXT,
        source TEXT,
        visitor_id TEXT,
        attribution_url TEXT,
        attribution_session_source TEXT,
        attribution_medium TEXT,
        attribution_ctwa_clid TEXT,
        attribution_ad_name TEXT,
        attribution_ad_id TEXT,
        total_paid REAL DEFAULT 0,
        purchases_count INTEGER DEFAULT 0,
        last_purchase_date DATETIME,
        appointment_date DATETIME,
        meta_schedule_event_sent INTEGER DEFAULT 0,
        meta_schedule_event_sent_at DATETIME,
        meta_schedule_event_id TEXT,
        meta_purchase_event_sent INTEGER DEFAULT 0,
        meta_purchase_event_sent_at DATETIME,
        meta_purchase_event_id TEXT,
        preferred_whatsapp_phone_number_id TEXT,
        ghl_contact_id TEXT,
        stripe_customer_id TEXT,
        conekta_customer_id TEXT,
        assigned_user_id TEXT,
        assignment_test_effect_id TEXT,
        custom_fields ${usePostgres ? "JSONB DEFAULT '[]'::jsonb" : "TEXT DEFAULT '[]'"},
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        deleted_at DATETIME
      )
    `)

    // Asignación de contacto a un usuario (para ruteo de notificaciones de chat).
    try {
      await db.run('ALTER TABLE contacts ADD COLUMN assigned_user_id TEXT')
    } catch (err) {
      if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
        throw err
      }
    }

    // Marca CAS de una asignación temporal hecha por el tester. Cualquier
    // asignación real la borra antes de que el barrido intente restaurar.
    try {
      await db.run('ALTER TABLE contacts ADD COLUMN assignment_test_effect_id TEXT')
    } catch (err) {
      if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
        throw err
      }
    }
    await db.run("CREATE INDEX IF NOT EXISTS idx_contacts_assignment_test_effect ON contacts(assignment_test_effect_id) WHERE assignment_test_effect_id IS NOT NULL AND assignment_test_effect_id != ''")

    try {
      await db.run('ALTER TABLE contacts ADD COLUMN preferred_whatsapp_phone_number_id TEXT')
    } catch (err) {
      // Columna ya existe, ignorar.
    }

    try {
      await db.run('ALTER TABLE contacts ADD COLUMN ghl_contact_id TEXT')
    } catch (err) {
      // Columna ya existe, ignorar.
    }

    try {
      await db.run('ALTER TABLE contacts ADD COLUMN stripe_customer_id TEXT')
    } catch (err) {
      if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
        throw err
      }
    }

    try {
      await db.run('ALTER TABLE contacts ADD COLUMN conekta_customer_id TEXT')
    } catch (err) {
      if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
        throw err
      }
    }

    try {
      await db.run('ALTER TABLE contacts ADD COLUMN deleted_at DATETIME')
    } catch (err) {
      if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
        throw err
      }
    }

    // Índices para contacts
    await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_ghl_contact_id ON contacts(ghl_contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_stripe_customer ON contacts(stripe_customer_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_conekta_customer ON contacts(conekta_customer_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_created_at ON contacts(created_at)')
    await db.run(`
      CREATE TABLE IF NOT EXISTS contact_conversational_channel_preferences (
        contact_id TEXT PRIMARY KEY,
        channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'sms')),
        selected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        selected_by_user_id TEXT,
        selection_source TEXT NOT NULL DEFAULT 'manual',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      )
    `)
    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_contact_conv_channel_preference_selected
      ON contact_conversational_channel_preferences(channel, selected_at)
    `)
    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_contacts_cursor_effective_created_at_id
      ON contacts(
        COALESCE(created_at, '1970-01-01 00:00:00') DESC,
        id DESC
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_ad_id ON contacts(attribution_ad_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_preferred_whatsapp_phone ON contacts(preferred_whatsapp_phone_number_id)')
    try {
      await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_meta_schedule_sent ON contacts(meta_schedule_event_sent)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_meta_purchase_sent ON contacts(meta_purchase_event_sent)')
    } catch (err) {
      if (!err.message.includes('no such column') && !err.message.includes('does not exist')) {
        throw err
      }
    }

    await db.run(`
      CREATE TABLE IF NOT EXISTS contact_phone_numbers (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        phone TEXT NOT NULL UNIQUE,
        label TEXT,
        is_primary INTEGER DEFAULT 0,
        source TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_contact_phone_numbers_contact ON contact_phone_numbers(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contact_phone_numbers_primary ON contact_phone_numbers(contact_id, is_primary)')

    // Enlaces de disparo: URL publica con ID propio que registra cada visita
    // antes de redirigir al destino final.
    await db.run(`
      CREATE TABLE IF NOT EXISTS trigger_links (
        id TEXT PRIMARY KEY,
        public_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        destination_url TEXT NOT NULL,
        description TEXT,
        active INTEGER DEFAULT 1,
        archived INTEGER DEFAULT 0,
        click_count INTEGER DEFAULT 0,
        last_clicked_at DATETIME,
        created_by_user_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS trigger_link_events (
        id TEXT PRIMARY KEY,
        trigger_link_id TEXT NOT NULL,
        public_id TEXT NOT NULL,
        contact_id TEXT,
        visitor_id TEXT,
        ip_address TEXT,
        user_agent TEXT,
        referrer TEXT,
        query_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (trigger_link_id) REFERENCES trigger_links(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_links_public_id ON trigger_links(public_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_trigger_links_active ON trigger_links(active, archived)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_trigger_links_updated ON trigger_links(updated_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_trigger_link_events_link ON trigger_link_events(trigger_link_id, created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_trigger_link_events_contact ON trigger_link_events(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_trigger_link_events_public ON trigger_link_events(public_id, created_at)')

    // Catálogo local de productos/precios.
    // Ristak puede operar sin HighLevel; cuando GHL se conecta, estos registros
    // se emparejan por IDs remotos o firma exacta antes de crear nada remoto.
    await db.run(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        ghl_product_id TEXT UNIQUE,
        location_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        product_type TEXT DEFAULT 'DIGITAL',
        image TEXT,
        available_in_store INTEGER DEFAULT 0,
        currency TEXT DEFAULT 'MXN',
        gigstack_product_key TEXT,
        gigstack_unit_key TEXT,
        gigstack_unit_name TEXT,
        post_webhooks TEXT,
        is_active INTEGER DEFAULT 1,
        source TEXT DEFAULT 'ristak',
        sync_status TEXT DEFAULT 'pending',
        sync_origin TEXT DEFAULT 'ristak',
        sync_error TEXT,
        raw_json TEXT,
        last_synced_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS product_prices (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        ghl_price_id TEXT UNIQUE,
        ghl_product_id TEXT,
        location_id TEXT,
        name TEXT NOT NULL,
        type TEXT DEFAULT 'one_time',
        currency TEXT DEFAULT 'MXN',
        amount REAL NOT NULL,
        description TEXT,
        interval TEXT,
        interval_count INTEGER,
        trial_period INTEGER,
        total_cycles INTEGER,
        setup_fee REAL,
        compare_at_price REAL,
        sku TEXT,
        track_inventory INTEGER DEFAULT 0,
        available_quantity REAL,
        allow_out_of_stock_purchases INTEGER DEFAULT 0,
        is_digital_product INTEGER DEFAULT 1,
        variant_option_ids TEXT,
        shipping_options TEXT,
        metadata TEXT,
        source TEXT DEFAULT 'ristak',
        sync_status TEXT DEFAULT 'pending',
        sync_origin TEXT DEFAULT 'ristak',
        sync_error TEXT,
        raw_json TEXT,
        last_synced_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_products_ghl_product ON products(ghl_product_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_products_name ON products(name)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_products_sync_status ON products(sync_status)')
    for (const [columnName, columnType] of [
      ['gigstack_product_key', 'TEXT'],
      ['gigstack_unit_key', 'TEXT'],
      ['gigstack_unit_name', 'TEXT'],
      ['post_webhooks', 'TEXT']
    ]) {
      try {
        await db.run(`ALTER TABLE products ADD COLUMN ${columnName} ${columnType}`)
      } catch {
        // Columna ya existe, ignorar.
      }
    }
    await db.run('CREATE INDEX IF NOT EXISTS idx_product_prices_product ON product_prices(product_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_product_prices_ghl_price ON product_prices(ghl_price_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_product_prices_sync_status ON product_prices(sync_status)')

    // Tabla de pagos
    await db.run(`
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        contact_id TEXT,
        amount ${usePostgres ? 'NUMERIC(20, 6)' : 'REAL'},
        currency TEXT DEFAULT 'MXN',
        status TEXT,
        payment_method TEXT,
        payment_mode TEXT DEFAULT 'live',
        payment_provider TEXT DEFAULT 'manual',
        reference TEXT,
        title TEXT,
        description TEXT,
        public_payment_id TEXT,
        payment_url TEXT,
        payment_link_request_key TEXT,
        conversational_test_effect_id TEXT,
        stripe_payment_intent_id TEXT,
        stripe_charge_id TEXT,
        mercadopago_payment_id TEXT,
        mercadopago_preference_id TEXT,
        conekta_order_id TEXT,
        conekta_charge_id TEXT,
        conekta_payment_source_id TEXT,
        clip_payment_id TEXT,
        clip_receipt_no TEXT,
        rebill_payment_id TEXT,
        rebill_subscription_id TEXT,
        rebill_customer_id TEXT,
        rebill_card_id TEXT,
        paid_at DATETIME,
        metadata_json TEXT,
        date DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_payments_contact ON payments(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(date)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)')
    await db.run('ALTER TABLE payments ADD COLUMN payment_link_request_key TEXT').catch(() => {})
    await db.run('ALTER TABLE payments ADD COLUMN conversational_test_effect_id TEXT').catch(() => {})
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_payment_link_request_key ON payments(payment_link_request_key)')
    await db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_conversational_test_effect
      ON payments(conversational_test_effect_id)
      WHERE conversational_test_effect_id IS NOT NULL AND conversational_test_effect_id != ''
    `)

    // Reserva durable de links creados por el agente conversacional v2. La fila
    // nace antes de llamar al proveedor para cerrar reintentos y carreras sin
    // depender de memoria local ni de que el proveedor soporte idempotencia.
    await db.run(`
      CREATE TABLE IF NOT EXISTS conversational_payment_link_requests (
        idempotency_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        request_json TEXT,
        contact_id TEXT,
        invoice_id TEXT,
        status TEXT NOT NULL,
        response_json TEXT,
        binding_event_id TEXT,
        binding_status TEXT DEFAULT 'pending',
        binding_error TEXT,
        bound_at DATETIME,
        error_status INTEGER,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await db.run('ALTER TABLE conversational_payment_link_requests ADD COLUMN request_json TEXT').catch(() => {})
    await db.run('ALTER TABLE conversational_payment_link_requests ADD COLUMN contact_id TEXT').catch(() => {})
    await db.run('ALTER TABLE conversational_payment_link_requests ADD COLUMN invoice_id TEXT').catch(() => {})
    await db.run('ALTER TABLE conversational_payment_link_requests ADD COLUMN binding_event_id TEXT').catch(() => {})
    await db.run("ALTER TABLE conversational_payment_link_requests ADD COLUMN binding_status TEXT DEFAULT 'pending'").catch(() => {})
    await db.run('ALTER TABLE conversational_payment_link_requests ADD COLUMN binding_error TEXT').catch(() => {})
    await db.run('ALTER TABLE conversational_payment_link_requests ADD COLUMN bound_at DATETIME').catch(() => {})
    await db.run('CREATE INDEX IF NOT EXISTS idx_conversational_payment_link_requests_status ON conversational_payment_link_requests(status, updated_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conversational_payment_link_requests_target ON conversational_payment_link_requests(contact_id, invoice_id, status)')

    // Reserva semántica entre mensajes distintos: una identidad financiera sólo
    // puede tener un creador activo aunque cada inbound use otra idempotency key.
    await db.run(`
      CREATE TABLE IF NOT EXISTS conversational_payment_semantic_claims (
        semantic_key TEXT PRIMARY KEY,
        identity_hash TEXT NOT NULL,
        owner_request_key TEXT NOT NULL,
        canonical_request_key TEXT,
        status TEXT NOT NULL DEFAULT 'processing',
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_conversational_payment_semantic_claim_owner
      ON conversational_payment_semantic_claims(owner_request_key, status)
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS payment_automation_dispatches (
        id TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL,
        automation_type TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'whatsapp',
        status TEXT NOT NULL DEFAULT 'pending',
        template_id TEXT,
        template_name TEXT,
        error_message TEXT,
        raw_response_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(payment_id, automation_type, channel),
        FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_automation_dispatches_payment ON payment_automation_dispatches(payment_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_automation_dispatches_status ON payment_automation_dispatches(status, updated_at)')

    // Outbox fiscal durable. El ambiente se copia del pago y nunca se infiere
    // desde la configuración global para impedir que una prueba llegue a Live.
    await db.run(`
      CREATE TABLE IF NOT EXISTS gigstack_invoice_jobs (
        payment_id TEXT PRIMARY KEY,
        payment_mode TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms BIGINT NOT NULL DEFAULT 0,
        claim_token TEXT,
        lease_until_at_ms BIGINT,
        last_error TEXT,
        remote_payment_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE
      )
    `)
    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_gigstack_invoice_jobs_due
      ON gigstack_invoice_jobs(status, next_attempt_at_ms)
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS stripe_payment_methods (
        id TEXT PRIMARY KEY,
        contact_id TEXT,
        stripe_customer_id TEXT NOT NULL,
        stripe_payment_method_id TEXT NOT NULL UNIQUE,
        brand TEXT,
        last4 TEXT,
        exp_month INTEGER,
        exp_year INTEGER,
        funding TEXT,
        country TEXT,
        mode TEXT DEFAULT 'test',
        is_default INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_stripe_payment_methods_contact ON stripe_payment_methods(contact_id, mode)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_stripe_payment_methods_customer ON stripe_payment_methods(stripe_customer_id)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS conekta_payment_sources (
        id TEXT PRIMARY KEY,
        contact_id TEXT,
        conekta_customer_id TEXT NOT NULL,
        conekta_payment_source_id TEXT NOT NULL UNIQUE,
        brand TEXT,
        last4 TEXT,
        exp_month INTEGER,
        exp_year INTEGER,
        name TEXT,
        mode TEXT DEFAULT 'test',
        is_default INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_conekta_payment_sources_contact ON conekta_payment_sources(contact_id, mode)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conekta_payment_sources_customer ON conekta_payment_sources(conekta_customer_id)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS rebill_payment_sources (
        id TEXT PRIMARY KEY,
        contact_id TEXT,
        rebill_customer_id TEXT NOT NULL,
        rebill_card_id TEXT NOT NULL UNIQUE,
        brand TEXT,
        last4 TEXT,
        name TEXT,
        mode TEXT DEFAULT 'test',
        is_default INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_rebill_payment_sources_contact ON rebill_payment_sources(contact_id, mode)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_rebill_payment_sources_customer ON rebill_payment_sources(rebill_customer_id)')

    // Tabla local de planes de pago de Ristak.
    // Las integraciones opcionales pueden sincronizar espejos remotos, pero la
    // lectura y reportes no dependen de GoHighLevel.
    await db.run(`
      CREATE TABLE IF NOT EXISTS payment_plans (
        id TEXT PRIMARY KEY,
        ghl_schedule_id TEXT UNIQUE,
        contact_id TEXT,
        contact_name TEXT,
        email TEXT,
        phone TEXT,
        name TEXT,
        title TEXT,
        status TEXT,
        total REAL DEFAULT 0,
        currency TEXT,
        description TEXT,
        recurrence_label TEXT,
        start_date DATETIME,
        next_run_at DATETIME,
        end_date DATETIME,
        live_mode INTEGER,
        item_count INTEGER DEFAULT 0,
        schedule_json TEXT,
        raw_json TEXT,
        source TEXT DEFAULT 'ghl',
        last_synced_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_plans_contact ON payment_plans(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_plans_status ON payment_plans(status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_plans_next_run ON payment_plans(next_run_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_plans_updated ON payment_plans(updated_at)')

    // Suscripciones recurrentes administradas desde Ristak.
    // Esta tabla no depende de HighLevel: guarda el estado local y los IDs de Stripe
    // necesarios para enlazar cobros recurrentes/saved cards cuando la pasarela esté activa.
    await db.run(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        contact_id TEXT,
        contact_name TEXT,
        contact_email TEXT,
        contact_phone TEXT,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'active',
        amount REAL DEFAULT 0,
        currency TEXT DEFAULT 'MXN',
        interval_type TEXT DEFAULT 'monthly',
        interval_count INTEGER DEFAULT 1,
        start_date DATETIME,
        next_run_at DATETIME,
        current_period_start DATETIME,
        current_period_end DATETIME,
        cancel_at DATETIME,
        cancelled_at DATETIME,
        payment_method TEXT DEFAULT 'stripe_saved_card',
        payment_provider TEXT DEFAULT 'stripe',
        payment_mode TEXT DEFAULT 'test',
        source TEXT DEFAULT 'ristak',
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT UNIQUE,
        stripe_product_id TEXT,
        stripe_price_id TEXT,
        stripe_payment_method_id TEXT,
        mercadopago_preapproval_id TEXT UNIQUE,
        mercadopago_preapproval_plan_id TEXT,
        mercadopago_init_point TEXT,
        mercadopago_sandbox_init_point TEXT,
        mercadopago_payer_id TEXT,
        mercadopago_card_id TEXT,
        mercadopago_payment_method_id TEXT,
        mercadopago_next_payment_date DATETIME,
        conekta_customer_id TEXT,
        conekta_plan_id TEXT,
        conekta_subscription_id TEXT UNIQUE,
        conekta_payment_source_id TEXT,
        conekta_next_billing_at DATETIME,
        rebill_subscription_id TEXT UNIQUE,
        rebill_plan_id TEXT,
        rebill_payment_link_id TEXT,
        rebill_payment_link_url TEXT,
        rebill_customer_id TEXT,
        rebill_card_id TEXT,
        rebill_next_charge_at DATETIME,
        rebill_last_charge_at DATETIME,
        metadata_json TEXT,
        raw_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_subscriptions_contact ON subscriptions(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_subscriptions_next_run ON subscriptions(next_run_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer ON subscriptions(stripe_customer_id)')
    await ensureTableColumns('subscriptions', SUBSCRIPTION_MERCADOPAGO_COLUMNS)
    await ensureTableColumns('subscriptions', SUBSCRIPTION_CONEKTA_COLUMNS)
    await ensureTableColumns('subscriptions', SUBSCRIPTION_REBILL_COLUMNS)
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_mercadopago_preapproval ON subscriptions(mercadopago_preapproval_id)')
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_conekta_subscription ON subscriptions(conekta_subscription_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_subscriptions_conekta_customer ON subscriptions(conekta_customer_id)')
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_rebill_subscription ON subscriptions(rebill_subscription_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_subscriptions_rebill_plan ON subscriptions(rebill_plan_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_subscriptions_rebill_customer ON subscriptions(rebill_customer_id)')

    // Tabla de citas
    await db.run(`
      CREATE TABLE IF NOT EXISTS appointments (
        id TEXT PRIMARY KEY,
        calendar_id TEXT,
        contact_id TEXT,
        location_id TEXT,
        title TEXT,
        status TEXT,
        appointment_status TEXT,
        assigned_user_id TEXT,
        notes TEXT,
        address TEXT,
        start_time DATETIME,
        end_time DATETIME,
        booking_channel TEXT,
        is_test INTEGER NOT NULL DEFAULT 0,
        test_run_id TEXT,
        test_effect_id TEXT,
        test_expires_at DATETIME,
        confirmation_badge_until DATETIME,
        date_added DATETIME,
        date_updated DATETIME,
        google_event_id TEXT UNIQUE,
        google_provider_calendar_id TEXT,
        google_mirror_generation INTEGER NOT NULL DEFAULT 0,
        google_sync_status TEXT,
        google_sync_error TEXT,
        google_synced_at DATETIME,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_appointments_contact ON appointments(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_appointments_start_time ON appointments(start_time)')
    await db.run(`
      CREATE TABLE IF NOT EXISTS appointment_participants (
        id TEXT PRIMARY KEY,
        appointment_id TEXT NOT NULL,
        role TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        contact_id TEXT,
        name_snapshot TEXT,
        phone_snapshot TEXT,
        email_snapshot TEXT,
        relation_snapshot TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
        UNIQUE(appointment_id, role, position)
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_appointment_participants_appointment ON appointment_participants(appointment_id, role, position)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_appointment_participants_contact ON appointment_participants(contact_id)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS appointment_creation_requests (
        client_request_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        processing_token TEXT,
        appointment_id TEXT,
        response_json TEXT,
        error_status INTEGER,
        error_retryable INTEGER NOT NULL DEFAULT 0,
        failure_kind TEXT,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await db.run('ALTER TABLE appointment_creation_requests ADD COLUMN processing_token TEXT').catch(() => {})
    await db.run('ALTER TABLE appointment_creation_requests ADD COLUMN error_retryable INTEGER NOT NULL DEFAULT 0').catch(() => {})
    await db.run('ALTER TABLE appointment_creation_requests ADD COLUMN failure_kind TEXT').catch(() => {})
    await db.run('CREATE INDEX IF NOT EXISTS idx_appointment_creation_request_appointment ON appointment_creation_requests(appointment_id)')

    // Calendarios locales de Ristak. Si un calendario viene de HighLevel,
    // ghl_calendar_id guarda el ID remoto; si nace en Ristak, se llena al sincronizar.
    await db.run(`
      CREATE TABLE IF NOT EXISTS calendars (
        id TEXT PRIMARY KEY,
        ghl_calendar_id TEXT UNIQUE,
        location_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        slug TEXT,
        widget_slug TEXT,
        calendar_type TEXT DEFAULT 'event',
        widget_type TEXT,
        event_title TEXT,
        event_color TEXT DEFAULT '#3b82f6',
        is_active INTEGER DEFAULT 1,
        team_members TEXT,
        location_configurations TEXT,
        slot_duration INTEGER DEFAULT 60,
        slot_duration_unit TEXT DEFAULT 'mins',
        slot_interval INTEGER DEFAULT 60,
        slot_interval_unit TEXT DEFAULT 'mins',
        slot_buffer INTEGER DEFAULT 0,
        slot_buffer_unit TEXT DEFAULT 'mins',
        pre_buffer INTEGER DEFAULT 0,
        pre_buffer_unit TEXT DEFAULT 'mins',
        appoinment_per_slot INTEGER DEFAULT 1,
        allow_overlaps INTEGER NOT NULL DEFAULT 0,
        appoinment_per_day INTEGER DEFAULT 0,
        allow_booking_after INTEGER DEFAULT 0,
        allow_booking_after_unit TEXT DEFAULT 'hours',
        allow_booking_for INTEGER DEFAULT 30,
        allow_booking_for_unit TEXT DEFAULT 'days',
        open_hours TEXT,
        availability_schedule_configured INTEGER NOT NULL DEFAULT 0,
        auto_confirm INTEGER DEFAULT 1,
        allow_reschedule INTEGER DEFAULT 1,
        allow_cancellation INTEGER DEFAULT 1,
        notes TEXT,
        availability_type INTEGER DEFAULT 0,
        anti_tracking_enabled INTEGER DEFAULT 1,
        source TEXT DEFAULT 'ristak',
        sync_status TEXT DEFAULT 'pending',
        sync_error TEXT,
        last_synced_at DATETIME,
        raw_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_calendars_ghl ON calendars(ghl_calendar_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_calendars_source ON calendars(source)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_calendars_active ON calendars(is_active)')
    try {
      await db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_calendars_ghl_unique ON calendars(ghl_calendar_id) WHERE ghl_calendar_id IS NOT NULL AND ghl_calendar_id != ''")
    } catch (err) {
      logger.warn('Advertencia al crear índice único de calendars.ghl_calendar_id:', err.message)
    }

    // Intención durable del espejo HighLevel. Se prepara antes del POST remoto
    // para que un webhook adelantado pueda reconocer la cita canónica de Ristak.
    await db.run(`
      CREATE TABLE IF NOT EXISTS appointment_highlevel_mirror_intents (
        appointment_id TEXT PRIMARY KEY,
        appointment_date_updated DATETIME,
        local_calendar_id TEXT NOT NULL,
        remote_calendar_id TEXT NOT NULL,
        local_contact_id TEXT,
        remote_contact_id TEXT,
        location_id TEXT,
        start_time DATETIME NOT NULL,
        end_time DATETIME NOT NULL,
        normalized_title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'prepared',
        remote_appointment_id TEXT,
        prepared_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_appointment_ghl_mirror_intent_match ON appointment_highlevel_mirror_intents(status, remote_calendar_id, remote_contact_id, start_time, end_time, expires_at)')
    await db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_ghl_mirror_intent_remote ON appointment_highlevel_mirror_intents(remote_appointment_id) WHERE remote_appointment_id IS NOT NULL AND remote_appointment_id != ''")

    await db.run(`
      CREATE TABLE IF NOT EXISTS blocked_slots (
        id TEXT PRIMARY KEY,
        calendar_id TEXT,
        start_time DATETIME NOT NULL,
        end_time DATETIME NOT NULL,
        title TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (calendar_id) REFERENCES calendars(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_blocked_slots_calendar ON blocked_slots(calendar_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_blocked_slots_start_time ON blocked_slots(start_time)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_blocked_slots_end_time ON blocked_slots(end_time)')

    for (const [columnName, columnType] of [
      ['ghl_appointment_id', 'TEXT'],
      ['source', "TEXT DEFAULT 'ghl'"],
      ['sync_status', "TEXT DEFAULT 'synced'"],
      ['sync_error', 'TEXT'],
      ['synced_at', 'DATETIME'],
      ['deleted_at', 'DATETIME'],
      ['google_event_id', 'TEXT'],
      ['google_provider_calendar_id', 'TEXT'],
      ['google_mirror_generation', 'INTEGER NOT NULL DEFAULT 0'],
      ['google_sync_status', 'TEXT'],
      ['google_sync_error', 'TEXT'],
      ['google_synced_at', 'DATETIME'],
      ['booking_channel', 'TEXT'],
      ['is_test', 'INTEGER NOT NULL DEFAULT 0'],
      ['test_run_id', 'TEXT'],
      ['test_effect_id', 'TEXT'],
      ['test_expires_at', 'DATETIME']
    ]) {
      try {
        await db.run(`ALTER TABLE appointments ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Columna ya existe, ignorar.
      }
    }

    try {
      await db.run('CREATE INDEX IF NOT EXISTS idx_appointments_ghl ON appointments(ghl_appointment_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_appointments_sync_status ON appointments(sync_status)')
      await db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_ghl_unique ON appointments(ghl_appointment_id) WHERE ghl_appointment_id IS NOT NULL AND ghl_appointment_id != ''")
      await db.run('CREATE INDEX IF NOT EXISTS idx_appointments_google ON appointments(google_event_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_appointments_google_sync_status ON appointments(google_sync_status)')
      await db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_google_unique ON appointments(google_event_id) WHERE google_event_id IS NOT NULL AND google_event_id != ''")
      await db.run('CREATE INDEX IF NOT EXISTS idx_appointments_test_cleanup ON appointments(test_expires_at) WHERE is_test = 1')
      await db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_test_effect_unique ON appointments(test_effect_id) WHERE test_effect_id IS NOT NULL AND test_effect_id != ''")
    } catch (err) {
      logger.warn('Advertencia al crear índices de sync de appointments:', err.message)
    }

    for (const [columnName, columnType] of [
      ['ghl_calendar_id', 'TEXT'],
      ['location_id', 'TEXT'],
      ['description', 'TEXT'],
      ['slug', 'TEXT'],
      ['widget_slug', 'TEXT'],
      ['calendar_type', "TEXT DEFAULT 'event'"],
      ['widget_type', 'TEXT'],
      ['event_title', 'TEXT'],
      ['event_color', "TEXT DEFAULT '#3b82f6'"],
      ['is_active', 'INTEGER DEFAULT 1'],
      ['team_members', 'TEXT'],
      ['location_configurations', 'TEXT'],
      ['slot_duration', 'INTEGER DEFAULT 60'],
      ['slot_duration_unit', "TEXT DEFAULT 'mins'"],
      ['slot_interval', 'INTEGER DEFAULT 60'],
      ['slot_interval_unit', "TEXT DEFAULT 'mins'"],
      ['slot_buffer', 'INTEGER DEFAULT 0'],
      ['slot_buffer_unit', "TEXT DEFAULT 'mins'"],
      ['pre_buffer', 'INTEGER DEFAULT 0'],
      ['pre_buffer_unit', "TEXT DEFAULT 'mins'"],
      ['appoinment_per_slot', 'INTEGER DEFAULT 1'],
      ['allow_overlaps', 'INTEGER NOT NULL DEFAULT 0'],
      ['appoinment_per_day', 'INTEGER DEFAULT 0'],
      ['allow_booking_after', 'INTEGER DEFAULT 0'],
      ['allow_booking_after_unit', "TEXT DEFAULT 'hours'"],
      ['allow_booking_for', 'INTEGER DEFAULT 30'],
      ['allow_booking_for_unit', "TEXT DEFAULT 'days'"],
      ['open_hours', 'TEXT'],
      ['availability_schedule_configured', 'INTEGER NOT NULL DEFAULT 0'],
      ['auto_confirm', 'INTEGER DEFAULT 1'],
      ['allow_reschedule', 'INTEGER DEFAULT 1'],
      ['allow_cancellation', 'INTEGER DEFAULT 1'],
      ['notes', 'TEXT'],
      ['availability_type', 'INTEGER DEFAULT 0'],
      ['anti_tracking_enabled', 'INTEGER DEFAULT 1'],
      ['source', "TEXT DEFAULT 'ristak'"],
      ['sync_status', "TEXT DEFAULT 'pending'"],
      ['sync_error', 'TEXT'],
      ['last_synced_at', 'DATETIME'],
      ['raw_json', 'TEXT'],
      ['created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP'],
      ['updated_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP']
    ]) {
      try {
        await db.run(`ALTER TABLE calendars ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Columna ya existe, ignorar.
      }
    }

    // Antes del editor semanal, `open_hours` vacío significaba implícitamente
    // Lun–Vie 09:00–17:00 en algunas superficies y "sin horario" en otras.
    // Congelamos ese comportamiento legacy como configuración explícita una sola
    // vez. Después, flag=1 + [] sí representa intencionalmente cero disponibilidad.
    const defaultCalendarOpenHours = JSON.stringify([
      {
        daysOfTheWeek: [1, 2, 3, 4, 5],
        hours: [{ openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0 }]
      }
    ])
    await db.run(`
      UPDATE calendars
      SET availability_schedule_configured = 1
      WHERE COALESCE(availability_schedule_configured, 0) = 0
        AND open_hours IS NOT NULL
        AND TRIM(open_hours) NOT IN ('', '[]')
    `)
    await db.run(`
      UPDATE calendars
      SET open_hours = ?, availability_schedule_configured = 1
      WHERE COALESCE(availability_schedule_configured, 0) = 0
        AND (open_hours IS NULL OR TRIM(open_hours) IN ('', '[]'))
    `, [defaultCalendarOpenHours])

    // Señales irreversibles para atribución de asistencia.
    // No alteran el estado operativo del calendario.
    await db.run(`
      CREATE TABLE IF NOT EXISTS appointment_attendance_signals (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        appointment_id TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'webhook_showed',
        first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_attendance_signals_appointment ON appointment_attendance_signals(appointment_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_attendance_signals_contact ON appointment_attendance_signals(contact_id)')

    // Tabla de configuración de Meta
    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ad_account_id TEXT UNIQUE,
        access_token TEXT NOT NULL,
        connection_mode TEXT DEFAULT 'manual_system_user',
        app_id TEXT,
        app_secret TEXT,
        messenger_user_token TEXT,
        meta_business_id TEXT,
        instagram_account_id TEXT,
        token_expires_at DATETIME,
        oauth_connection_id TEXT,
        oauth_user_id TEXT,
        oauth_user_name TEXT,
        oauth_app_id TEXT,
        oauth_business_id TEXT,
        oauth_config_id TEXT,
        oauth_appsecret_proof TEXT,
        oauth_page_access_token TEXT,
        oauth_page_appsecret_proof TEXT,
        oauth_granted_scopes_json TEXT,
        oauth_missing_scopes_json TEXT,
        oauth_granular_scopes_json TEXT,
        oauth_data_access_expires_at DATETIME,
        oauth_connected INTEGER DEFAULT 0,
        oauth_validated INTEGER DEFAULT 0,
        oauth_connected_at DATETIME,
        oauth_validated_at DATETIME,
        oauth_relay_status TEXT,
        oauth_relay_registered_at DATETIME,
        oauth_relay_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // El token OAuth/BISU no toca meta_config hasta que el usuario confirma los
    // activos. La sesión cifrada es temporal y de un solo uso para que cerrar el
    // popup o abandonar el wizard nunca destruya la conexión manual vigente.
    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_oauth_pending_sessions (
        id TEXT PRIMARY KEY,
        payload_encrypted TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        expires_at DATETIME NOT NULL,
        consumed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_oauth_pending_expiry ON meta_oauth_pending_sessions(status, expires_at)')
    // No purgar ni resetear aquí: una sesión puede estar compensando un
    // subscribed_apps remoto. metaOAuthService descifra el stage y sólo elimina
    // el secreto después del DELETE idempotente o al vencer su TTL máximo.

    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_oauth_connection_backups (
        id TEXT PRIMARY KEY,
        payload_encrypted TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Inventario autorizado por Meta y credenciales Page-scoped cifradas. Esto
    // permite cambiar la selección operativa dentro de Ristak sin volver a
    // abrir OAuth; nunca se expone al frontend ni se guarda en texto plano.
    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_oauth_authorized_assets (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        payload_encrypted TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_oauth_authorized_assets_connection ON meta_oauth_authorized_assets(connection_id)')

    // OAuth de Meta se conecta por capacidad. Ads y Social no comparten
    // selección, credenciales activas ni ciclo de desconexión. La tabla legacy
    // meta_config se conserva intacta como respaldo durante la migración.
    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_oauth_integrations (
        id TEXT PRIMARY KEY,
        integration_kind TEXT NOT NULL CHECK (integration_kind IN ('social', 'ads')),
        status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'active', 'replaced')),
        connection_id TEXT NOT NULL,
        access_token TEXT NOT NULL,
        appsecret_proof TEXT,
        page_access_token TEXT,
        page_appsecret_proof TEXT,
        app_id TEXT,
        config_id TEXT,
        user_id TEXT,
        user_name TEXT,
        business_id TEXT,
        ad_account_id TEXT,
        dataset_id TEXT,
        page_id TEXT,
        instagram_account_id TEXT,
        granted_scopes_json TEXT,
        missing_scopes_json TEXT,
        granular_scopes_json TEXT,
        token_expires_at DATETIME,
        data_access_expires_at DATETIME,
        validated INTEGER DEFAULT 0,
        relay_status TEXT,
        relay_registered_at DATETIME,
        relay_error TEXT,
        connected_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(integration_kind, connection_id)
      )
    `)
    await db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_oauth_integrations_active_kind
      ON meta_oauth_integrations(integration_kind)
      WHERE status = 'active'
    `)
    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_meta_oauth_integrations_connection
      ON meta_oauth_integrations(connection_id, integration_kind)
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_oauth_integration_sessions (
        id TEXT PRIMARY KEY,
        integration_kind TEXT NOT NULL CHECK (integration_kind IN ('social', 'ads')),
        payload_encrypted TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consuming', 'central_committed', 'consumed')),
        expires_at DATETIME NOT NULL,
        consumed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_meta_oauth_integration_sessions_expiry
      ON meta_oauth_integration_sessions(integration_kind, status, expires_at)
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_installer_relay_deliveries (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'processing',
        error_message TEXT,
        received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_social_contacts (
        id TEXT PRIMARY KEY,
        contact_id TEXT,
        platform TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        recipient_id TEXT,
        page_id TEXT,
        instagram_account_id TEXT,
        profile_name TEXT,
        username TEXT,
        profile_picture_url TEXT,
        raw_profile_json TEXT,
        meta_user_id TEXT,
        first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        message_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(platform, sender_id),
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    // meta_user_id = id "crudo" del usuario (PSID/IGSID) SIN el prefijo sintético
    // de comentario. Enlaza el contacto-DM y el contacto-comentario de la misma
    // persona (mismo platform + meta_user_id) sin fusionarlos.
    try {
      await db.run('ALTER TABLE meta_social_contacts ADD COLUMN meta_user_id TEXT')
    } catch (err) {
      if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) throw err
    }
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_social_contacts_meta_user ON meta_social_contacts (platform, meta_user_id)').catch(() => undefined)

    // Caché del contenido de la publicación/media comentada (para mostrar "de qué
    // publicación comentó" dentro del globo, sin re-pedirlo a Meta cada vez).
    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_social_posts (
        id TEXT PRIMARY KEY,
        platform TEXT,
        post_type TEXT,
        message TEXT,
        image_url TEXT,
        permalink TEXT,
        posted_at DATETIME,
        raw_json TEXT,
        fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_social_messages (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        meta_message_id TEXT,
        meta_social_contact_id TEXT,
        contact_id TEXT,
        sender_id TEXT,
        recipient_id TEXT,
        page_id TEXT,
        instagram_account_id TEXT,
        direction TEXT,
        status TEXT,
        message_type TEXT,
        message_text TEXT,
        media_url TEXT,
        media_mime_type TEXT,
        postback_payload TEXT,
        message_timestamp DATETIME,
        raw_payload_json TEXT,
        referral_json TEXT,
        comment_id TEXT,
        post_id TEXT,
        parent_comment_id TEXT,
        media_id TEXT,
        permalink TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (meta_social_contact_id) REFERENCES meta_social_contacts(id) ON DELETE SET NULL,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_social_webhook_events (
        id TEXT PRIMARY KEY,
        platform TEXT,
        object_type TEXT,
        event_type TEXT,
        signature_valid INTEGER,
        processed_status TEXT DEFAULT 'received',
        processed_error TEXT,
        raw_payload_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_conversion_event_logs (
        id ${usePostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
        contact_id TEXT,
        event_type TEXT NOT NULL,
        meta_event_name TEXT NOT NULL,
        event_id TEXT NOT NULL,
        status TEXT NOT NULL,
        request_payload TEXT,
        response_payload TEXT,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_conversion_logs_contact ON meta_conversion_event_logs(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_conversion_logs_event ON meta_conversion_event_logs(event_type, event_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_conversion_logs_created ON meta_conversion_event_logs(created_at)')

    // Tabla de ads de Meta
    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_ads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        ad_account_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        campaign_name TEXT,
        adset_id TEXT NOT NULL,
        adset_name TEXT,
        ad_id TEXT NOT NULL,
        ad_name TEXT,
        creative_id TEXT,
        creative_type TEXT,
        creative_thumbnail_url TEXT,
        creative_image_url TEXT,
        creative_video_id TEXT,
        creative_video_url TEXT,
        creative_preview_url TEXT,
        spend REAL DEFAULT 0,
        reach INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        cpc REAL DEFAULT 0,
        cpm REAL DEFAULT 0,
        ctr REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(date, campaign_id, adset_id, ad_id)
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_ads_date ON meta_ads(date)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_ads_campaign ON meta_ads(campaign_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_ads_ad ON meta_ads(ad_id)')
    // Esta expresión y su INDEXED BY pertenecen exclusivamente al paginador
    // legacy de SQLite. PostgreSQL usa los índices de cursor nativos de sus
    // migraciones versionadas; intentar crear éste allí rompe un bootstrap
    // limpio porque julianday() no existe en PostgreSQL.
    if (!usePostgres) {
      await db.run(`
        CREATE INDEX IF NOT EXISTS idx_campaign_contacts_cursor_created_at_id
        ON contacts(
          COALESCE(
            NULLIF(
              COALESCE(
                COALESCE(
                  julianday(created_at),
                  julianday(REPLACE(REPLACE(created_at, 'T', ' '), 'Z', ''))
                ),
                0
              ),
              0
            ),
            julianday('1970-01-01 00:00:00')
          ) DESC,
          id DESC
        )
      `)
    }

    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_campaign_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        category TEXT,
        mode TEXT,
        template_version INTEGER DEFAULT 1,
        template_json TEXT NOT NULL,
        is_system INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_campaign_templates_category ON meta_campaign_templates(category)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_campaign_templates_active ON meta_campaign_templates(is_active)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_campaign_drafts (
        id TEXT PRIMARY KEY,
        template_id TEXT,
        status TEXT DEFAULT 'draft',
        trace_id TEXT UNIQUE,
        name TEXT,
        user_id INTEGER,
        source_content_json TEXT,
        config_snapshot_json TEXT,
        template_snapshot_json TEXT,
        payload_json TEXT,
        validation_json TEXT,
        preview_json TEXT,
        execution_status TEXT DEFAULT 'not_executed',
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        executed_at DATETIME
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_campaign_drafts_template ON meta_campaign_drafts(template_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_campaign_drafts_status ON meta_campaign_drafts(status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_campaign_drafts_trace ON meta_campaign_drafts(trace_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_campaign_drafts_created ON meta_campaign_drafts(created_at)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_campaign_execution_logs (
        id TEXT PRIMARY KEY,
        draft_id TEXT,
        trace_id TEXT,
        step TEXT NOT NULL,
        status TEXT,
        mcp_server_url TEXT,
        request_payload_json TEXT,
        response_payload_json TEXT,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_campaign_logs_draft ON meta_campaign_execution_logs(draft_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_campaign_logs_trace ON meta_campaign_execution_logs(trace_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_meta_campaign_logs_created ON meta_campaign_execution_logs(created_at)')

    // Tabla de atribución de WhatsApp
    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_attribution (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id TEXT,
        phone TEXT,
        referral_source_url TEXT,
        referral_source_type TEXT,
        referral_source_id TEXT,
        referral_headline TEXT,
        referral_body TEXT,
        referral_image_url TEXT,
        referral_video_url TEXT,
        referral_thumbnail_url TEXT,
        referral_ctwa_clid TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      )
    `)

    // Agregar columnas nuevas si no existen (para migración) - PRIMERO
    try {
      await db.run(`ALTER TABLE whatsapp_attribution ADD COLUMN message_content TEXT`)
    } catch (err) {
      // Columna ya existe, ignorar
    }

    try {
      await db.run(`ALTER TABLE whatsapp_attribution ADD COLUMN ad_id_thru_message TEXT`)
    } catch (err) {
      // Columna ya existe, ignorar
    }

    // Eliminar columna extracted_ad_id si existe (renombrada a ad_id_thru_message)
    try {
      await db.run(`ALTER TABLE whatsapp_attribution DROP COLUMN extracted_ad_id`)
    } catch (err) {
      // Columna no existe o DB no soporta DROP, ignorar
    }

    // Crear índices DESPUÉS de asegurar que las columnas existen
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_contact ON whatsapp_attribution(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_ad_id ON whatsapp_attribution(ad_id_thru_message)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_attribution_phone ON whatsapp_attribution(phone)')

    const oldWhatsAppPrefix = ['whatsapp', 'web'].join('_')
    for (const suffix of [
      'logs',
      'attribution',
      'messages',
      'chats',
      'contacts',
      'auth_state',
      'sessions'
    ]) {
      const tableName = `${oldWhatsAppPrefix}_${suffix}`
      try {
        await db.run(`DROP TABLE IF EXISTS ${tableName}`)
      } catch (err) {
        logger.warn(`No se pudo eliminar ${tableName}: ${err.message}`)
      }
    }

    // Tablas de WhatsApp_API oficial via YCloud.
    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_api_phone_numbers (
        id TEXT PRIMARY KEY,
        provider TEXT DEFAULT 'ycloud',
        waba_id TEXT,
        phone_number TEXT,
        display_phone_number TEXT,
        verified_name TEXT,
        profile_picture_url TEXT,
        business_profile_json TEXT,
        quality_rating TEXT,
        messaging_limit TEXT,
        status TEXT,
        raw_payload_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    for (const [columnName, columnType] of [
      ['provider', "TEXT DEFAULT 'ycloud'"],
      ['profile_picture_url', 'TEXT'],
      ['business_profile_json', 'TEXT'],
      ['label', 'TEXT'],
      ['is_default_sender', 'INTEGER DEFAULT 0'],
      ['api_send_enabled', 'INTEGER DEFAULT 1'],
      ['qr_send_enabled', 'INTEGER DEFAULT 0'],
      ['qr_consent_accepted_at', 'DATETIME'],
      ['qr_consent_accepted_by', 'TEXT'],
      ['qr_status', 'TEXT'],
      ['qr_connected_phone', 'TEXT'],
      ['qr_last_connected_at', 'DATETIME'],
      ['qr_last_disconnected_at', 'DATETIME'],
      ['qr_last_error', 'TEXT']
    ]) {
      try {
        await db.run(`ALTER TABLE whatsapp_api_phone_numbers ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Columna ya existe, ignorar.
      }
    }

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_api_contacts (
        id TEXT PRIMARY KEY,
        contact_id TEXT,
        phone TEXT UNIQUE,
        whatsapp_user_id TEXT,
        parent_whatsapp_user_id TEXT,
        username TEXT,
        profile_name TEXT,
        profile_picture_url TEXT,
        profile_picture_source TEXT,
        profile_picture_updated_at DATETIME,
        profile_picture_error TEXT,
        raw_profile_json TEXT,
        first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        message_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    for (const [columnName, columnType] of [
      ['profile_picture_url', 'TEXT'],
      ['profile_picture_source', 'TEXT'],
      ['profile_picture_updated_at', 'DATETIME'],
      ['profile_picture_error', 'TEXT'],
      ['whatsapp_user_id', 'TEXT'],
      ['parent_whatsapp_user_id', 'TEXT'],
      ['username', 'TEXT']
    ]) {
      try {
        await db.run(`ALTER TABLE whatsapp_api_contacts ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Columna ya existe, ignorar.
      }
    }

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_api_messages (
        id TEXT PRIMARY KEY,
        provider TEXT DEFAULT 'ycloud',
        source_adapter TEXT DEFAULT 'ycloud',
        origin TEXT,
        provider_message_id TEXT,
        ycloud_message_id TEXT,
        meta_message_id TEXT,
        wamid TEXT,
        protocol_message_key_id TEXT,
        waba_id TEXT,
        business_phone_number_id TEXT,
        whatsapp_api_contact_id TEXT,
        contact_id TEXT,
        phone TEXT,
        from_phone TEXT,
        to_phone TEXT,
        business_phone TEXT,
        transport TEXT DEFAULT 'api',
        routing_reason TEXT,
        direction TEXT,
        message_type TEXT,
        message_text TEXT,
        media_url TEXT,
        media_mime_type TEXT,
        media_filename TEXT,
        media_duration_ms INTEGER,
        status TEXT,
        business_echo INTEGER DEFAULT 0,
        relay_event_id TEXT,
        error_code TEXT,
        error_message TEXT,
        message_timestamp DATETIME,
        raw_payload_json TEXT,
        context_json TEXT,
        referral_json TEXT,
        detected_ctwa_clid TEXT,
        detected_source_id TEXT,
        detected_source_url TEXT,
        detected_source_type TEXT,
        detected_source_app TEXT,
        detected_entry_point TEXT,
        detected_headline TEXT,
        detected_body TEXT,
        detected_conversion_data TEXT,
        detected_ctwa_payload TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (whatsapp_api_contact_id) REFERENCES whatsapp_api_contacts(id) ON DELETE SET NULL,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS email_messages (
        id TEXT PRIMARY KEY,
        contact_id TEXT,
        direction TEXT DEFAULT 'outbound',
        status TEXT,
        to_email TEXT,
        from_email TEXT,
        reply_to TEXT,
        subject TEXT,
        message_text TEXT,
        html_body TEXT,
        smtp_message_id TEXT,
        error_message TEXT,
        message_timestamp DATETIME,
        raw_payload_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS chat_read_states (
        user_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        unread_count INTEGER DEFAULT 0,
        last_read_at DATETIME,
        last_unread_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, contact_id)
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_chat_read_states_contact ON chat_read_states (contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_chat_read_states_user_unread ON chat_read_states (user_id, unread_count)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS chat_inbound_message_claims (
        channel TEXT NOT NULL,
        message_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        message_timestamp DATETIME,
        claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (channel, message_id)
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_chat_inbound_message_claims_contact ON chat_inbound_message_claims (contact_id)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS chat_delivery_outbox (
        id TEXT PRIMARY KEY,
        job_kind TEXT NOT NULL CHECK (job_kind IN ('push', 'meta_enrichment')),
        message_id TEXT NOT NULL,
        contact_id TEXT,
        provider TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        failed_at TEXT,
        UNIQUE (job_kind, message_id)
      )
    `)
    await ensureTableColumns('chat_delivery_outbox', [
      ['failed_at', 'TEXT']
    ])
    await db.run('CREATE INDEX IF NOT EXISTS idx_chat_delivery_outbox_ready ON chat_delivery_outbox (status, available_at, created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_chat_delivery_outbox_lease ON chat_delivery_outbox (status, lease_expires_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_chat_delivery_outbox_completed ON chat_delivery_outbox (status, completed_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_chat_delivery_outbox_failed ON chat_delivery_outbox (status, failed_at)')

    for (const [columnName, columnType] of [
      ['provider', "TEXT DEFAULT 'ycloud'"],
      ['source_adapter', "TEXT DEFAULT 'ycloud'"],
      ['origin', 'TEXT'],
      ['provider_message_id', 'TEXT'],
      ['meta_message_id', 'TEXT'],
      ['protocol_message_key_id', 'TEXT'],
      ['business_phone_number_id', 'TEXT'],
      ['transport', "TEXT DEFAULT 'api'"],
      ['routing_reason', 'TEXT'],
      ['media_url', 'TEXT'],
      ['media_mime_type', 'TEXT'],
      ['media_filename', 'TEXT'],
      ['media_duration_ms', 'INTEGER'],
      ['business_echo', 'INTEGER DEFAULT 0'],
      ['relay_event_id', 'TEXT']
    ]) {
      try {
        await db.run(`ALTER TABLE whatsapp_api_messages ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Columna ya existe, ignorar.
      }
    }

    await db.run(`
      CREATE TABLE IF NOT EXISTS scheduled_chat_messages (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        channel TEXT,
        transport TEXT,
        message_type TEXT DEFAULT 'text',
        message_text TEXT NOT NULL,
        template_id TEXT,
        template_name TEXT,
        template_language TEXT,
        template_components_json TEXT,
        template_variables_json TEXT,
        to_phone TEXT,
        from_phone TEXT,
        business_phone_number_id TEXT,
        scheduled_at DATETIME NOT NULL,
        status TEXT DEFAULT 'scheduled',
        external_id TEXT,
        sent_message_id TEXT,
        attempts INTEGER DEFAULT 0,
        error_message TEXT,
        raw_payload_json TEXT,
        last_attempt_at DATETIME,
        sent_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      )
    `)

    for (const [columnName, columnType] of [
      ['provider', 'TEXT'],
      ['channel', 'TEXT'],
      ['transport', 'TEXT'],
      ['message_type', "TEXT DEFAULT 'text'"],
      ['message_text', 'TEXT'],
      ['template_id', 'TEXT'],
      ['template_name', 'TEXT'],
      ['template_language', 'TEXT'],
      ['template_components_json', 'TEXT'],
      ['template_variables_json', 'TEXT'],
      ['to_phone', 'TEXT'],
      ['from_phone', 'TEXT'],
      ['business_phone_number_id', 'TEXT'],
      ['scheduled_at', 'DATETIME'],
      ['status', "TEXT DEFAULT 'scheduled'"],
      ['external_id', 'TEXT'],
      ['sent_message_id', 'TEXT'],
      ['attempts', 'INTEGER DEFAULT 0'],
      ['error_message', 'TEXT'],
      ['raw_payload_json', 'TEXT'],
      ['last_attempt_at', 'DATETIME'],
      ['sent_at', 'DATETIME']
    ]) {
      try {
        await db.run(`ALTER TABLE scheduled_chat_messages ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Columna ya existe, ignorar.
      }
    }

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_api_attribution (
        id TEXT PRIMARY KEY,
        whatsapp_api_message_id TEXT,
        whatsapp_api_contact_id TEXT,
        contact_id TEXT,
        phone TEXT,
        ycloud_message_id TEXT,
        wamid TEXT,
        detected_ctwa_clid TEXT,
        detected_source_id TEXT,
        detected_source_url TEXT,
        detected_source_type TEXT,
        detected_source_app TEXT,
        detected_entry_point TEXT,
        detected_headline TEXT,
        detected_body TEXT,
        detected_conversion_data TEXT,
        detected_ctwa_payload TEXT,
        referral_json TEXT,
        raw_payload_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (whatsapp_api_message_id) REFERENCES whatsapp_api_messages(id) ON DELETE CASCADE,
        FOREIGN KEY (whatsapp_api_contact_id) REFERENCES whatsapp_api_contacts(id) ON DELETE SET NULL,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_api_webhook_events (
        id TEXT PRIMARY KEY,
        provider TEXT DEFAULT 'ycloud',
        event_id TEXT UNIQUE,
        event_type TEXT,
        api_version TEXT,
        webhook_endpoint_id TEXT,
        signature_valid INTEGER,
        processed_status TEXT DEFAULT 'received',
        processed_error TEXT,
        raw_payload_json TEXT,
        ycloud_create_time DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    for (const [columnName, columnType] of [
      ['provider', "TEXT DEFAULT 'ycloud'"]
    ]) {
      try {
        await db.run(`ALTER TABLE whatsapp_api_webhook_events ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Columna ya existe, ignorar.
      }
    }

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_api_balance (
        id TEXT PRIMARY KEY,
        amount REAL DEFAULT 0,
        currency TEXT,
        raw_payload_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_api_templates (
        id TEXT PRIMARY KEY,
        official_template_id TEXT,
        provider_template_id TEXT,
        provider TEXT DEFAULT 'ycloud',
        source_adapter TEXT DEFAULT 'ycloud',
        waba_id TEXT NOT NULL,
        name TEXT NOT NULL,
        language TEXT NOT NULL,
        category TEXT,
        sub_category TEXT,
        previous_category TEXT,
        message_send_ttl_seconds INTEGER,
        status TEXT,
        quality_rating TEXT,
        reason TEXT,
        status_update_event TEXT,
        disable_date DATETIME,
        components_json TEXT,
        raw_payload_json TEXT,
        provider_create_time DATETIME,
        provider_update_time DATETIME,
        ycloud_create_time DATETIME,
        ycloud_update_time DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(waba_id, name, language)
      )
    `)

    for (const [columnName, columnType] of [
      ['provider_template_id', 'TEXT'],
      ['provider', "TEXT DEFAULT 'ycloud'"],
      ['source_adapter', "TEXT DEFAULT 'ycloud'"],
      ['provider_create_time', 'DATETIME'],
      ['provider_update_time', 'DATETIME']
    ]) {
      try {
        await db.run(`ALTER TABLE whatsapp_api_templates ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Columna ya existe, ignorar.
      }
    }

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_api_alerts (
        id TEXT PRIMARY KEY,
        severity TEXT DEFAULT 'info',
        alert_type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT,
        source_event_id TEXT,
        entity_type TEXT,
        entity_id TEXT,
        status TEXT DEFAULT 'active',
        raw_payload_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (source_event_id) REFERENCES whatsapp_api_webhook_events(id) ON DELETE SET NULL
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_api_template_sends (
        id TEXT PRIMARY KEY,
        provider TEXT DEFAULT 'ycloud',
        source_adapter TEXT DEFAULT 'ycloud',
        provider_message_id TEXT,
        template_id TEXT,
        template_name TEXT,
        language TEXT,
        to_phone TEXT,
        from_phone TEXT,
        ycloud_message_id TEXT,
        wamid TEXT,
        status TEXT,
        variables_json TEXT,
        raw_payload_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (template_id) REFERENCES whatsapp_api_templates(id) ON DELETE SET NULL
      )
    `)

    for (const [columnName, columnType] of [
      ['provider', "TEXT DEFAULT 'ycloud'"],
      ['source_adapter', "TEXT DEFAULT 'ycloud'"],
      ['provider_message_id', 'TEXT']
    ]) {
      try {
        await db.run(`ALTER TABLE whatsapp_api_template_sends ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        // Columna ya existe, ignorar.
      }
    }

    await db.run(`
      CREATE TABLE IF NOT EXISTS distributed_locks (
        name TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        locked_until DATETIME NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS subscription_creation_requests (
        idempotency_key TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        subscription_id TEXT,
        response_json TEXT,
        error_status INTEGER,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_subscription_creation_request_subscription ON subscription_creation_requests(subscription_id)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS payment_plan_creation_requests (
        provider TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        flow_id TEXT,
        response_json TEXT,
        error_status INTEGER,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider, idempotency_key)
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_plan_creation_request_hash ON payment_plan_creation_requests(provider, request_hash, created_at)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS payment_plan_creation_hash_guards (
        provider TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider, request_hash)
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_plan_creation_hash_guard_expiry ON payment_plan_creation_hash_guards(expires_at)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS saved_card_payment_requests (
        provider TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        payment_id TEXT,
        response_json TEXT,
        error_status INTEGER,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider, idempotency_key)
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_saved_card_payment_request_payment ON saved_card_payment_requests(payment_id)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS media_upload_requests (
        business_id TEXT NOT NULL,
        client_upload_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        owner_token TEXT,
        asset_id TEXT,
        response_json TEXT,
        error_status INTEGER,
        error_message TEXT,
        lease_expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (business_id, client_upload_id)
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_media_upload_requests_asset ON media_upload_requests(asset_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_media_upload_requests_status ON media_upload_requests(status, lease_expires_at)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_qr_sessions (
        id TEXT PRIMARY KEY,
        phone_number_id TEXT NOT NULL,
        expected_phone TEXT NOT NULL,
        connected_phone TEXT,
        status TEXT DEFAULT 'disconnected',
        qr_code TEXT,
        qr_code_data_url TEXT,
        consent_accepted INTEGER DEFAULT 0,
        consent_text TEXT,
        consent_accepted_at DATETIME,
        consent_accepted_by TEXT,
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_connected_at DATETIME,
        last_disconnected_at DATETIME,
        FOREIGN KEY (phone_number_id) REFERENCES whatsapp_api_phone_numbers(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_meta_direct_nonces (
        nonce TEXT PRIMARY KEY,
        purpose TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_qr_auth_state (
        phone_number_id TEXT NOT NULL,
        auth_key TEXT NOT NULL,
        value_json TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (phone_number_id, auth_key),
        FOREIGN KEY (phone_number_id) REFERENCES whatsapp_api_phone_numbers(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_qr_labels (
        phone_number_id TEXT NOT NULL,
        label_id TEXT NOT NULL,
        name TEXT,
        color INTEGER,
        predefined_id TEXT,
        deleted INTEGER DEFAULT 0,
        raw_payload_json TEXT,
        first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (phone_number_id, label_id),
        FOREIGN KEY (phone_number_id) REFERENCES whatsapp_api_phone_numbers(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_routing_events (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        previous_phone_number_id TEXT,
        new_phone_number_id TEXT,
        reason TEXT,
        source TEXT DEFAULT 'manual',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_phone_numbers_phone ON whatsapp_api_phone_numbers(phone_number)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_phone_numbers_provider ON whatsapp_api_phone_numbers(provider)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_phone_numbers_default ON whatsapp_api_phone_numbers(is_default_sender)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_contacts_phone ON whatsapp_api_contacts(phone)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_contacts_contact ON whatsapp_api_contacts(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_contacts_user_id ON whatsapp_api_contacts(whatsapp_user_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_contact ON whatsapp_api_messages(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_contact_date ON whatsapp_api_messages(contact_id, message_timestamp, created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_date_contact ON whatsapp_api_messages(message_timestamp, created_at, contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_phone ON whatsapp_api_messages(phone)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_business_phone ON whatsapp_api_messages(business_phone)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_business_phone_id ON whatsapp_api_messages(business_phone_number_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_business_phone_date ON whatsapp_api_messages(business_phone, message_timestamp, created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_business_phone_id_date ON whatsapp_api_messages(business_phone_number_id, message_timestamp, created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_created ON whatsapp_api_messages(created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_wamid ON whatsapp_api_messages(wamid)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_meta_message ON whatsapp_api_messages(meta_message_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_provider_message ON whatsapp_api_messages(provider, provider_message_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_source_adapter ON whatsapp_api_messages(source_adapter)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_provider_origin ON whatsapp_api_messages(provider, origin)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_meta_direct_nonces_created ON whatsapp_meta_direct_nonces(created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_scheduled_chat_messages_contact ON scheduled_chat_messages(contact_id, status, scheduled_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_scheduled_chat_messages_due ON scheduled_chat_messages(status, scheduled_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_attr_contact ON whatsapp_api_attribution(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_attribution_message ON whatsapp_api_attribution(whatsapp_api_message_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_attr_source ON whatsapp_api_attribution(detected_source_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_attr_ctwa ON whatsapp_api_attribution(detected_ctwa_clid)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_events_type_created ON whatsapp_api_webhook_events(event_type, created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_events_provider_type ON whatsapp_api_webhook_events(provider, event_type, created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_balance_updated ON whatsapp_api_balance(updated_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_templates_status ON whatsapp_api_templates(status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_templates_waba ON whatsapp_api_templates(waba_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_templates_provider ON whatsapp_api_templates(provider, status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_templates_provider_id ON whatsapp_api_templates(provider, provider_template_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_alerts_status_severity ON whatsapp_api_alerts(status, severity, updated_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_alerts_entity ON whatsapp_api_alerts(entity_type, entity_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_template_sends_created ON whatsapp_api_template_sends(created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_api_template_sends_status ON whatsapp_api_template_sends(status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_distributed_locks_until ON distributed_locks(locked_until)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_qr_sessions_phone ON whatsapp_qr_sessions(phone_number_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_qr_sessions_status ON whatsapp_qr_sessions(status, updated_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_qr_auth_state_phone ON whatsapp_qr_auth_state(phone_number_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_qr_labels_predefined ON whatsapp_qr_labels(phone_number_id, predefined_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_qr_labels_name ON whatsapp_qr_labels(phone_number_id, name)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_routing_events_contact ON whatsapp_routing_events(contact_id, created_at)')

    // Tabla de versiones de Meta API (para auto-actualización)
    await db.run(`
      CREATE TABLE IF NOT EXISTS meta_api_version (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Tabla de flujos de pago por parcialidades.
    // Guarda el estado de autorización/tarjeta sin contaminar la tabla de pagos reales.
    // El default highlevel conserva flujos legacy; Stripe, Conekta y Mercado Pago
    // escriben payment_provider explicito cuando son los dueños del plan.
    await db.run(`
      CREATE TABLE IF NOT EXISTS payment_flows (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        contact_name TEXT,
        contact_email TEXT,
        contact_phone TEXT,
        total_amount REAL NOT NULL,
        currency TEXT DEFAULT 'MXN',
        concept TEXT,
        payment_type TEXT DEFAULT 'partial',
        first_payment_amount REAL DEFAULT 0,
        first_payment_type TEXT,
        first_payment_value REAL,
        first_payment_date DATETIME,
        first_payment_method TEXT,
        first_payment_status TEXT,
        first_payment_invoice_id TEXT,
        remaining_automatic INTEGER DEFAULT 0,
        card_setup_required INTEGER DEFAULT 0,
        card_setup_amount REAL DEFAULT 25,
        card_setup_status TEXT,
        card_setup_invoice_id TEXT,
        card_setup_payment_link TEXT,
        ghl_customer_id TEXT,
        ghl_payment_method_id TEXT,
        ghl_payment_method_type TEXT,
        ghl_card_brand TEXT,
        ghl_card_last4 TEXT,
        ghl_card_authorization_invoice_id TEXT,
        ghl_payment_provider_type TEXT,
        ghl_payment_provider_account TEXT,
        ghl_payment_live_mode INTEGER,
        payment_provider TEXT DEFAULT 'highlevel',
        stripe_customer_id TEXT,
        stripe_payment_method_id TEXT,
        stripe_payment_method_label TEXT,
        conekta_customer_id TEXT,
        conekta_payment_source_id TEXT,
        conekta_payment_source_label TEXT,
        rebill_customer_id TEXT,
        rebill_card_id TEXT,
        rebill_card_label TEXT,
        mercadopago_user_id TEXT,
        mercadopago_preapproval_id TEXT,
        current_state TEXT NOT NULL,
        state_history TEXT,
        card_authorized_at DATETIME,
        installment_plan_created_at DATETIME,
        installment_plan_active_at DATETIME,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_flows_contact ON payment_flows(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_flows_state ON payment_flows(current_state)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_flows_first_invoice ON payment_flows(first_payment_invoice_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_payment_flows_card_setup_invoice ON payment_flows(card_setup_invoice_id)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS installment_payments (
        id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        amount REAL NOT NULL,
        percentage REAL,
        due_date DATETIME,
        frequency TEXT DEFAULT 'custom',
        payment_method TEXT,
        automatic INTEGER DEFAULT 0,
        status TEXT NOT NULL,
        payment_id TEXT,
        ghl_invoice_id TEXT,
        ghl_schedule_id TEXT,
        ghl_schedule_status TEXT,
        stripe_payment_intent_id TEXT,
        mercadopago_payment_id TEXT,
        mercadopago_preference_id TEXT,
        conekta_order_id TEXT,
        conekta_charge_id TEXT,
        clip_payment_id TEXT,
        rebill_payment_id TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (flow_id) REFERENCES payment_flows(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_installment_payments_flow ON installment_payments(flow_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_installment_payments_status ON installment_payments(status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_installment_payments_due_date ON installment_payments(due_date)')

    // Agregar columnas que puedan faltar en tablas existentes
    try {
      // Agregar ghl_invoice_id a payments. SQLite no permite ADD COLUMN con UNIQUE
      // en tablas existentes; el índice se crea después si la columna existe.
      try {
        await db.run('ALTER TABLE payments ADD COLUMN ghl_invoice_id TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar invoice_number para mostrar en UI
      try {
        await db.run('ALTER TABLE payments ADD COLUMN invoice_number TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar due_date para pagos pendientes
      try {
        await db.run('ALTER TABLE payments ADD COLUMN due_date DATETIME')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar sent_at para saber cuándo se envió
      try {
        await db.run('ALTER TABLE payments ADD COLUMN sent_at DATETIME')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar updated_at para soportar edición de pagos
      try {
        await db.run('ALTER TABLE payments ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar payment_mode para separar pagos reales de modo prueba/test
      try {
        await db.run('ALTER TABLE payments ADD COLUMN payment_mode TEXT DEFAULT \'live\'')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE payments ADD COLUMN title TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      const paymentProviderColumns = [
        ['payment_provider', "TEXT DEFAULT 'manual'"],
        ['public_payment_id', 'TEXT'],
        ['payment_url', 'TEXT'],
        ['stripe_payment_intent_id', 'TEXT'],
        ['stripe_charge_id', 'TEXT'],
        ['mercadopago_payment_id', 'TEXT'],
        ['mercadopago_preference_id', 'TEXT'],
        ['conekta_order_id', 'TEXT'],
        ['conekta_charge_id', 'TEXT'],
        ['conekta_payment_source_id', 'TEXT'],
        ...PAYMENT_CLIP_COLUMNS,
        ...PAYMENT_REBILL_COLUMNS,
        ['paid_at', 'DATETIME'],
        ['metadata_json', 'TEXT']
      ]

      for (const [column, type] of paymentProviderColumns) {
        try {
          await db.run(`ALTER TABLE payments ADD COLUMN ${column} ${type}`)
        } catch (err) {
          if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
            throw err
          }
        }
      }

      // Snapshot de atribución por conversión (último paid touch + superficie
      // real). Lo escribe conversionAttributionService al registrar la compra.
      const conversionAttributionColumns = [
        ['attribution_channel', 'TEXT'],
        ['attribution_source', 'TEXT'],
        ['attribution_touch_type', 'TEXT'],
        ['attribution_touch_at', 'DATETIME'],
        ['attribution_campaign_id', 'TEXT'],
        ['attribution_adset_id', 'TEXT'],
        ['attribution_ad_id', 'TEXT'],
        ['attribution_ad_name', 'TEXT'],
        ['attribution_ids_json', 'TEXT'],
        ['conversion_surface', 'TEXT']
      ]

      for (const table of ['payments', 'appointments']) {
        for (const [column, type] of conversionAttributionColumns) {
          try {
            await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
          } catch (err) {
            if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
              throw err
            }
          }
        }
      }

      try {
        await db.run('CREATE INDEX IF NOT EXISTS idx_payments_payment_mode ON payments(payment_mode)')
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('no such column')) {
          throw err
        }
      }

      try {
        await db.run('CREATE INDEX IF NOT EXISTS idx_payments_provider ON payments(payment_provider)')
        await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_public_payment ON payments(public_payment_id)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_payments_stripe_intent ON payments(stripe_payment_intent_id)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_payments_mercadopago_payment ON payments(mercadopago_payment_id)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_payments_mercadopago_preference ON payments(mercadopago_preference_id)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_payments_conekta_order ON payments(conekta_order_id)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_payments_conekta_charge ON payments(conekta_charge_id)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_payments_clip_payment ON payments(clip_payment_id)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_payments_rebill_payment ON payments(rebill_payment_id)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_payments_rebill_subscription ON payments(rebill_subscription_id)')
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('no such column')) {
          throw err
        }
      }

      // Agregar location_data a highlevel_config si no existe
      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN location_data TEXT')
      } catch (err) {
        // Si falla es porque la columna ya existe, está bien
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar custom_labels a highlevel_config si no existe
      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN custom_labels TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar updated_at a contacts si no existe
      try {
        await db.run('ALTER TABLE contacts ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      const contactMetaEventColumns = [
        ['conekta_customer_id', 'TEXT'],
        ['meta_schedule_event_sent', 'INTEGER DEFAULT 0'],
        ['meta_schedule_event_sent_at', 'DATETIME'],
        ['meta_schedule_event_id', 'TEXT'],
        ['meta_purchase_event_sent', 'INTEGER DEFAULT 0'],
        ['meta_purchase_event_sent_at', 'DATETIME'],
        ['meta_purchase_event_id', 'TEXT']
      ]

      for (const [columnName, columnType] of contactMetaEventColumns) {
        try {
          await db.run(`ALTER TABLE contacts ADD COLUMN ${columnName} ${columnType}`)
        } catch (err) {
          if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
            throw err
          }
        }
      }

      try {
        await db.run(`ALTER TABLE contacts ADD COLUMN custom_fields ${usePostgres ? "JSONB DEFAULT '[]'::jsonb" : "TEXT DEFAULT '[]'"}`)
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_meta_schedule_sent ON contacts(meta_schedule_event_sent)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_meta_purchase_sent ON contacts(meta_purchase_event_sent)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_stripe_customer ON contacts(stripe_customer_id)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_contacts_conekta_customer ON contacts(conekta_customer_id)')
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('no such column') && !err.message.includes('does not exist')) {
          throw err
        }
      }

      // Agregar columnas de timezone a meta_config
      try {
        await db.run('ALTER TABLE meta_config ADD COLUMN timezone_id INTEGER')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE meta_config ADD COLUMN timezone_name TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE meta_config ADD COLUMN timezone_offset_hours_utc INTEGER')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar columna pixel_id a meta_config
      try {
        await db.run('ALTER TABLE meta_config ADD COLUMN pixel_id TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar columna page_id a meta_config
      try {
        await db.run('ALTER TABLE meta_config ADD COLUMN page_id TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE meta_config ADD COLUMN instagram_account_id TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column name') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        if (usePostgres) {
          await db.run('ALTER TABLE meta_config ALTER COLUMN ad_account_id DROP NOT NULL')
        } else {
          const columns = await db.all('PRAGMA table_info(meta_config)')
          const adAccountColumn = columns.find(column => column.name === 'ad_account_id')

          if (adAccountColumn?.notnull) {
            await db.exec(`
              PRAGMA foreign_keys=off;
              DROP TABLE IF EXISTS meta_config_shared_token_migration;
              CREATE TABLE meta_config_shared_token_migration (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ad_account_id TEXT UNIQUE,
                access_token TEXT NOT NULL,
                app_id TEXT,
                app_secret TEXT,
                token_expires_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                timezone_id INTEGER,
                timezone_name TEXT,
                timezone_offset_hours_utc INTEGER,
                pixel_id TEXT,
                page_id TEXT,
                instagram_account_id TEXT
              );
              INSERT INTO meta_config_shared_token_migration (
                id, ad_account_id, access_token, app_id, app_secret, token_expires_at,
                created_at, updated_at, timezone_id, timezone_name, timezone_offset_hours_utc,
                pixel_id, page_id, instagram_account_id
              )
              SELECT
                id, ad_account_id, access_token, app_id, app_secret, token_expires_at,
                created_at, updated_at, timezone_id, timezone_name, timezone_offset_hours_utc,
                pixel_id, page_id, instagram_account_id
              FROM meta_config;
              DROP TABLE meta_config;
              ALTER TABLE meta_config_shared_token_migration RENAME TO meta_config;
              PRAGMA foreign_keys=on;
            `)
          }
        }
      } catch (err) {
        if (!err.message.includes('already exists')) {
          logger.warn('Advertencia al permitir token Meta compartido sin cuenta de anuncios:', err.message)
        }
      }

      await ensureTableColumns('meta_config', [
        ['messenger_user_token', 'TEXT'],
        ['meta_business_id', 'TEXT'],
        ['connection_mode', "TEXT DEFAULT 'manual_system_user'"],
        ['oauth_connection_id', 'TEXT'],
        ['oauth_user_id', 'TEXT'],
        ['oauth_user_name', 'TEXT'],
        ['oauth_app_id', 'TEXT'],
        ['oauth_business_id', 'TEXT'],
        ['oauth_config_id', 'TEXT'],
        ['oauth_appsecret_proof', 'TEXT'],
        ['oauth_page_access_token', 'TEXT'],
        ['oauth_page_appsecret_proof', 'TEXT'],
        ['oauth_granted_scopes_json', 'TEXT'],
        ['oauth_missing_scopes_json', 'TEXT'],
        ['oauth_granular_scopes_json', 'TEXT'],
        ['oauth_data_access_expires_at', 'DATETIME'],
        ['oauth_connected', 'INTEGER DEFAULT 0'],
        ['oauth_validated', 'INTEGER DEFAULT 0'],
        ['oauth_connected_at', 'DATETIME'],
        ['oauth_validated_at', 'DATETIME'],
        ['oauth_relay_status', 'TEXT'],
        ['oauth_relay_registered_at', 'DATETIME'],
        ['oauth_relay_error', 'TEXT']
      ])

      try {
        await removeObsoleteMetaCapiColumn()
      } catch (err) {
        logger.warn('Advertencia al eliminar columna obsoleta de Meta CAPI:', err.message)
      }

      // Estas columnas también deben existir en instalaciones actualizadas, no
      // sólo en bases creadas desde cero. Se agregan después de todas las
      // reconstrucciones SQLite legacy de meta_config para que ninguna las tire.
      await ensureTableColumns('meta_config', [
        ['messenger_user_token', 'TEXT'],
        ['meta_business_id', 'TEXT'],
        ['connection_mode', "TEXT DEFAULT 'manual_system_user'"],
        ['oauth_connection_id', 'TEXT'],
        ['oauth_user_id', 'TEXT'],
        ['oauth_user_name', 'TEXT'],
        ['oauth_app_id', 'TEXT'],
        ['oauth_business_id', 'TEXT'],
        ['oauth_config_id', 'TEXT'],
        ['oauth_appsecret_proof', 'TEXT'],
        ['oauth_page_access_token', 'TEXT'],
        ['oauth_page_appsecret_proof', 'TEXT'],
        ['oauth_granted_scopes_json', 'TEXT'],
        ['oauth_missing_scopes_json', 'TEXT'],
        ['oauth_granular_scopes_json', 'TEXT'],
        ['oauth_data_access_expires_at', 'DATETIME'],
        ['oauth_connected', 'INTEGER DEFAULT 0'],
        ['oauth_validated', 'INTEGER DEFAULT 0'],
        ['oauth_connected_at', 'DATETIME'],
        ['oauth_validated_at', 'DATETIME'],
        ['oauth_relay_status', 'TEXT'],
        ['oauth_relay_registered_at', 'DATETIME'],
        ['oauth_relay_error', 'TEXT']
      ])

      // Agregar columnas de creative a meta_ads para previsualizar anuncios
      const metaAdsCreativeColumns = [
        ['creative_id', 'TEXT'],
        ['creative_type', 'TEXT'],
        ['creative_thumbnail_url', 'TEXT'],
        ['creative_image_url', 'TEXT'],
        ['creative_video_id', 'TEXT'],
        ['creative_video_url', 'TEXT'],
        ['creative_preview_url', 'TEXT']
      ]

      for (const [columnName, columnType] of metaAdsCreativeColumns) {
        try {
          await db.run(`ALTER TABLE meta_ads ADD COLUMN ${columnName} ${columnType}`)
        } catch (err) {
          if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
            throw err
          }
        }
      }

      await db.run('CREATE INDEX IF NOT EXISTS idx_meta_social_contacts_contact ON meta_social_contacts(contact_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_meta_social_contacts_sender ON meta_social_contacts(platform, sender_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_meta_social_messages_contact ON meta_social_messages(contact_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_meta_social_messages_contact_date ON meta_social_messages(contact_id, message_timestamp, created_at)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_meta_social_messages_date_contact ON meta_social_messages(message_timestamp, created_at, contact_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_meta_social_messages_sender ON meta_social_messages(platform, sender_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_meta_social_messages_created ON meta_social_messages(created_at)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_meta_social_messages_meta_id ON meta_social_messages(meta_message_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_meta_social_messages_social_contact ON meta_social_messages(meta_social_contact_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_meta_social_events_status ON meta_social_webhook_events(processed_status, created_at)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_email_messages_contact ON email_messages(contact_id)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_email_messages_contact_date ON email_messages(contact_id, message_timestamp, created_at)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_email_messages_created ON email_messages(created_at)')
      await db.run('CREATE INDEX IF NOT EXISTS idx_email_messages_status ON email_messages(status, created_at)')

      try {
        await db.run('ALTER TABLE meta_social_messages ADD COLUMN status TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Columnas de comentarios (FB/IG) en meta_social_messages (idempotente).
      for (const col of ['comment_id', 'post_id', 'parent_comment_id', 'media_id', 'permalink']) {
        try {
          await db.run(`ALTER TABLE meta_social_messages ADD COLUMN ${col} TEXT`)
        } catch (err) {
          if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
            throw err
          }
        }
      }

      // Fecha de publicación (created_time FB / timestamp IG) para ordenar el
      // selector de publicaciones por más reciente. Idempotente.
      try {
        await db.run('ALTER TABLE meta_social_posts ADD COLUMN posted_at DATETIME')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      // Agregar columnas de configuración de invoices/pagos
      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN invoice_title TEXT DEFAULT \'PAGO\'')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN invoice_number_prefix TEXT DEFAULT \'INV-\'')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN invoice_terms_notes TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN invoice_due_days INTEGER DEFAULT 7')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN transfer_info_url TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN card_setup_amount REAL DEFAULT 25')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE highlevel_config ADD COLUMN ghl_invoice_mode TEXT DEFAULT \'live\'')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      const paymentFlowColumns = [
        ['ghl_customer_id', 'TEXT'],
        ['ghl_payment_method_id', 'TEXT'],
        ['ghl_payment_method_type', 'TEXT'],
        ['ghl_card_brand', 'TEXT'],
        ['ghl_card_last4', 'TEXT'],
        ['ghl_card_authorization_invoice_id', 'TEXT'],
        ['ghl_payment_provider_type', 'TEXT'],
        ['ghl_payment_provider_account', 'TEXT'],
        ['ghl_payment_live_mode', 'INTEGER'],
        ['payment_provider', 'TEXT DEFAULT \'highlevel\''],
        ['stripe_customer_id', 'TEXT'],
        ['stripe_payment_method_id', 'TEXT'],
        ['stripe_payment_method_label', 'TEXT'],
        ['conekta_customer_id', 'TEXT'],
        ['conekta_payment_source_id', 'TEXT'],
        ['conekta_payment_source_label', 'TEXT'],
        ['rebill_customer_id', 'TEXT'],
        ['rebill_card_id', 'TEXT'],
        ['rebill_card_label', 'TEXT'],
        ['mercadopago_user_id', 'TEXT'],
        ['mercadopago_preapproval_id', 'TEXT']
      ]

      for (const [column, type] of paymentFlowColumns) {
        try {
          await db.run(`ALTER TABLE payment_flows ADD COLUMN ${column} ${type}`)
        } catch (err) {
          if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
            throw err
          }
        }
      }

      await ensureTableColumns('subscriptions', SUBSCRIPTION_MERCADOPAGO_COLUMNS)
      await ensureTableColumns('subscriptions', SUBSCRIPTION_CONEKTA_COLUMNS)
      await ensureTableColumns('subscriptions', SUBSCRIPTION_REBILL_COLUMNS)

      try {
        await db.run(`
          CREATE TABLE IF NOT EXISTS rebill_payment_sources (
            id TEXT PRIMARY KEY,
            contact_id TEXT,
            rebill_customer_id TEXT NOT NULL,
            rebill_card_id TEXT NOT NULL UNIQUE,
            brand TEXT,
            last4 TEXT,
            name TEXT,
            mode TEXT DEFAULT 'test',
            is_default INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
          )
        `)
        await db.run('CREATE INDEX IF NOT EXISTS idx_rebill_payment_sources_contact ON rebill_payment_sources(contact_id, mode)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_rebill_payment_sources_customer ON rebill_payment_sources(rebill_customer_id)')
      } catch (err) {
        if (!err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_mercadopago_preapproval ON subscriptions(mercadopago_preapproval_id)')
        await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_conekta_subscription ON subscriptions(conekta_subscription_id)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_subscriptions_conekta_customer ON subscriptions(conekta_customer_id)')
        await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_rebill_subscription ON subscriptions(rebill_subscription_id)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_subscriptions_rebill_plan ON subscriptions(rebill_plan_id)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_subscriptions_rebill_customer ON subscriptions(rebill_customer_id)')
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('no such column') && !err.message.includes('does not exist')) {
          throw err
        }
      }

      try {
        await db.run('CREATE INDEX IF NOT EXISTS idx_payment_flows_ghl_payment_method ON payment_flows(ghl_payment_method_id)')
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('no such column') && !err.message.includes('does not exist')) {
          throw err
        }
      }

      try {
        await db.run('CREATE INDEX IF NOT EXISTS idx_payment_flows_ghl_authorization_invoice ON payment_flows(ghl_card_authorization_invoice_id)')
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('no such column') && !err.message.includes('does not exist')) {
          throw err
        }
      }

      try {
        await db.run('CREATE INDEX IF NOT EXISTS idx_payment_flows_provider_state ON payment_flows(payment_provider, current_state)')
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('no such column') && !err.message.includes('does not exist')) {
          throw err
        }
      }

      try {
        await db.run('CREATE INDEX IF NOT EXISTS idx_payment_flows_stripe_method ON payment_flows(stripe_payment_method_id)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_payment_flows_conekta_source ON payment_flows(conekta_payment_source_id)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_payment_flows_mercadopago_user ON payment_flows(mercadopago_user_id)')
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('no such column') && !err.message.includes('does not exist')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE installment_payments ADD COLUMN payment_id TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE installment_payments ADD COLUMN ghl_schedule_id TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE installment_payments ADD COLUMN ghl_schedule_status TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE installment_payments ADD COLUMN stripe_payment_intent_id TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE installment_payments ADD COLUMN mercadopago_payment_id TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE installment_payments ADD COLUMN mercadopago_preference_id TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE installment_payments ADD COLUMN conekta_order_id TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE installment_payments ADD COLUMN conekta_charge_id TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE installment_payments ADD COLUMN clip_payment_id TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE installment_payments ADD COLUMN rebill_payment_id TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('ALTER TABLE installment_payments ADD COLUMN notes TEXT')
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err
        }
      }

      try {
        await db.run('CREATE INDEX IF NOT EXISTS idx_installment_payments_payment ON installment_payments(payment_id)')
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('no such column') && !err.message.includes('does not exist')) {
          throw err
        }
      }

      try {
        await db.run('CREATE INDEX IF NOT EXISTS idx_installment_payments_stripe_intent ON installment_payments(stripe_payment_intent_id)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_installment_payments_mercadopago_payment ON installment_payments(mercadopago_payment_id)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_installment_payments_mercadopago_preference ON installment_payments(mercadopago_preference_id)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_installment_payments_conekta_order ON installment_payments(conekta_order_id)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_installment_payments_clip_payment ON installment_payments(clip_payment_id)')
        await db.run('CREATE INDEX IF NOT EXISTS idx_installment_payments_rebill_payment ON installment_payments(rebill_payment_id)')
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('no such column') && !err.message.includes('does not exist')) {
          throw err
        }
      }

      try {
        await db.run('CREATE INDEX IF NOT EXISTS idx_installment_payments_schedule ON installment_payments(ghl_schedule_id)')
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('no such column') && !err.message.includes('does not exist')) {
          throw err
        }
      }

      // Crear índice para ghl_invoice_id DESPUÉS de agregar la columna
      try {
        await db.run('CREATE INDEX IF NOT EXISTS idx_payments_ghl_invoice ON payments(ghl_invoice_id)')
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('no such column')) {
          throw err
        }
      }

      try {
        await db.run(`
          DELETE FROM payments
          WHERE (ghl_invoice_id IS NULL OR ghl_invoice_id = '')
            AND status IN ('paid', 'succeeded', 'completed')
            AND LOWER(COALESCE(description, '')) LIKE '%primer pago%'
            AND EXISTS (
              SELECT 1
              FROM payments invoice_payment
              WHERE invoice_payment.id != payments.id
                AND invoice_payment.ghl_invoice_id IS NOT NULL
                AND invoice_payment.contact_id = payments.contact_id
                AND ABS(COALESCE(invoice_payment.amount, 0) - COALESCE(payments.amount, 0)) < 0.01
                AND LOWER(COALESCE(invoice_payment.description, '')) = LOWER(COALESCE(payments.description, ''))
                AND invoice_payment.status IN ('paid', 'succeeded', 'completed')
            )
        `)
      } catch (err) {
        logger.warn('No se pudo limpiar duplicados históricos de primer pago:', err.message)
      }
    } catch (error) {
      logger.warn('Error agregando columnas opcionales:', error.message)
    }

    // Tabla de sesiones de tracking (pixel /snip.js)
    // Cada page_view = 1 registro (captura navegación completa)
    await db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id ${usePostgres ? 'UUID PRIMARY KEY DEFAULT gen_random_uuid()' : 'TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))'},
        session_id TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        contact_id TEXT,
        full_name TEXT,
        email TEXT,
        event_name TEXT NOT NULL DEFAULT 'page_view',
        started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

        page_url TEXT,
        referrer_url TEXT,

        utm_source TEXT,
        utm_medium TEXT,
        utm_campaign TEXT,
        utm_term TEXT,
        utm_content TEXT,
        gclid TEXT,
        fbclid TEXT,
        fbc TEXT,
        fbp TEXT,
        wbraid TEXT,
        gbraid TEXT,
        msclkid TEXT,
        ttclid TEXT,

        channel TEXT,
        source_platform TEXT,
        campaign_id TEXT,
        adset_id TEXT,
        ad_group_id TEXT,
        ad_id TEXT,
        campaign_name TEXT,
        adset_name TEXT,
        ad_group_name TEXT,
        ad_name TEXT,
        placement TEXT,
        site_source_name TEXT,
        network TEXT,
        match_type TEXT,
        keyword TEXT,
        search_query TEXT,
        creative_id TEXT,
        ad_position TEXT,

        ip TEXT,
        user_agent TEXT,
        device_type TEXT,
        os TEXT,
        browser TEXT,
        browser_version TEXT,
        language TEXT,
        timezone TEXT,

        geo_country TEXT,
        geo_region TEXT,
        geo_city TEXT,

        tracking_source TEXT DEFAULT 'external_pixel',
        site_id TEXT,
        site_slug TEXT,
        site_name TEXT,
        site_type TEXT,
        form_site_id TEXT,
        form_site_name TEXT,
        public_page_id TEXT,
        public_page_title TEXT,
        conversion_type TEXT,
        submission_id TEXT,
        identity_hash TEXT,
        device_signature TEXT,
        network_signature TEXT,
        match_method TEXT DEFAULT 'anonymous',
        match_confidence INTEGER DEFAULT 0,
        identity_evidence_json TEXT,

        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    for (const [columnName, columnType] of [
      ['tracking_source', "TEXT DEFAULT 'external_pixel'"],
      ['site_id', 'TEXT'],
      ['site_slug', 'TEXT'],
      ['site_name', 'TEXT'],
      ['site_type', 'TEXT'],
      ['form_site_id', 'TEXT'],
      ['form_site_name', 'TEXT'],
      ['public_page_id', 'TEXT'],
      ['public_page_title', 'TEXT'],
      ['conversion_type', 'TEXT'],
      ['submission_id', 'TEXT'],
      ['identity_hash', 'TEXT'],
      ['device_signature', 'TEXT'],
      ['network_signature', 'TEXT'],
      ['match_method', "TEXT DEFAULT 'anonymous'"],
      ['match_confidence', 'INTEGER DEFAULT 0'],
      ['identity_evidence_json', 'TEXT']
    ]) {
      try {
        await db.run(`ALTER TABLE sessions ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          logger.warn(`Advertencia al migrar sessions.${columnName}: ${err.message}`)
        }
      }
    }

    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_visitor ON sessions(visitor_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_utm ON sessions(utm_source, utm_medium, utm_campaign)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_ids ON sessions(gclid, fbclid, msclkid, ttclid)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_campaign ON sessions(campaign_id, adset_id, ad_group_id, ad_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_geo ON sessions(geo_country, geo_region, geo_city)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_contact ON sessions(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_tracking_source ON sessions(tracking_source)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_site ON sessions(site_id, site_type)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_form_site ON sessions(form_site_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_identity_hash ON sessions(identity_hash)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_device_network ON sessions(device_signature, network_signature)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_match_method ON sessions(match_method, match_confidence)')
    // Lookup por email en atribución de conversiones (OR con LOWER(email)).
    try {
      await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_email_lower ON sessions(LOWER(email))')
    } catch (err) {
      logger.warn('Advertencia al crear índice idx_sessions_email_lower:', err.message)
    }

    // Tracking granular de reproducciones de video.
    // video_playback_sessions es el resumen por reproducción; video_playback_events
    // guarda los hitos relevantes para auditoría sin depender de Bunny para identidad.
    await db.run(`
      CREATE TABLE IF NOT EXISTS video_playback_sessions (
        id ${usePostgres ? 'UUID PRIMARY KEY DEFAULT gen_random_uuid()' : 'TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))'},
        playback_id TEXT NOT NULL UNIQUE,
        visitor_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        contact_id TEXT,
        full_name TEXT,
        email TEXT,

        media_asset_id TEXT,
        stream_library_id TEXT,
        stream_video_id TEXT,
        video_provider TEXT DEFAULT 'bunny_stream',
        video_title TEXT,

        tracking_source TEXT DEFAULT 'native_site_video',
        site_id TEXT,
        site_slug TEXT,
        site_name TEXT,
        site_type TEXT,
        form_site_id TEXT,
        form_site_name TEXT,
        public_page_id TEXT,
        public_page_title TEXT,
        block_id TEXT,
        block_label TEXT,
        page_url TEXT,
        referrer_url TEXT,

        ip TEXT,
        user_agent TEXT,
        device_type TEXT,
        os TEXT,
        browser TEXT,
        browser_version TEXT,
        language TEXT,
        timezone TEXT,

        duration_seconds REAL DEFAULT 0,
        max_position_seconds REAL DEFAULT 0,
        last_position_seconds REAL DEFAULT 0,
        watched_seconds REAL DEFAULT 0,
        max_progress_percent REAL DEFAULT 0,
        play_count INTEGER DEFAULT 0,
        pause_count INTEGER DEFAULT 0,
        seek_count INTEGER DEFAULT 0,
        ended INTEGER DEFAULT 0,

        match_method TEXT DEFAULT 'anonymous',
        match_confidence INTEGER DEFAULT 0,
        identity_hash TEXT,
        device_signature TEXT,
        network_signature TEXT,
        identity_evidence_json TEXT,
        first_event_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_event_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    for (const [columnName, columnType] of [
      ['match_confidence', 'INTEGER DEFAULT 0'],
      ['identity_hash', 'TEXT'],
      ['device_signature', 'TEXT'],
      ['network_signature', 'TEXT'],
      ['identity_evidence_json', 'TEXT']
    ]) {
      try {
        await db.run(`ALTER TABLE video_playback_sessions ADD COLUMN ${columnName} ${columnType}`)
      } catch (err) {
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          logger.warn(`Advertencia al migrar video_playback_sessions.${columnName}: ${err.message}`)
        }
      }
    }

    await db.run(`
      CREATE TABLE IF NOT EXISTS video_playback_events (
        id ${usePostgres ? 'UUID PRIMARY KEY DEFAULT gen_random_uuid()' : 'TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))'},
        event_id TEXT UNIQUE,
        playback_id TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        contact_id TEXT,
        event_name TEXT NOT NULL,

        media_asset_id TEXT,
        stream_library_id TEXT,
        stream_video_id TEXT,
        video_provider TEXT DEFAULT 'bunny_stream',
        site_id TEXT,
        public_page_id TEXT,
        block_id TEXT,
        page_url TEXT,

        position_seconds REAL DEFAULT 0,
        duration_seconds REAL DEFAULT 0,
        progress_percent REAL DEFAULT 0,
        watched_delta_seconds REAL DEFAULT 0,
        payload_json TEXT,
        event_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_video_sessions_playback ON video_playback_sessions(playback_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_video_sessions_contact ON video_playback_sessions(contact_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_video_sessions_visitor ON video_playback_sessions(visitor_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_video_sessions_session ON video_playback_sessions(session_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_video_sessions_asset ON video_playback_sessions(media_asset_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_video_sessions_stream_video ON video_playback_sessions(stream_video_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_video_sessions_site ON video_playback_sessions(site_id, public_page_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_video_sessions_last_event ON video_playback_sessions(last_event_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_video_sessions_identity_hash ON video_playback_sessions(identity_hash)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_video_sessions_device_network ON video_playback_sessions(device_signature, network_signature)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_video_sessions_match_method ON video_playback_sessions(match_method, match_confidence)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_video_events_playback ON video_playback_events(playback_id, event_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_video_events_contact ON video_playback_events(contact_id, event_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_video_events_stream_video ON video_playback_events(stream_video_id, event_at)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS tracking_identity_matches (
        id TEXT PRIMARY KEY,
        subject_kind TEXT NOT NULL,
        subject_id TEXT,
        visitor_id TEXT,
        session_id TEXT,
        contact_id TEXT,
        identity_hash TEXT,
        device_signature TEXT,
        network_signature TEXT,
        match_method TEXT NOT NULL DEFAULT 'anonymous',
        match_confidence INTEGER DEFAULT 0,
        accepted INTEGER DEFAULT 0,
        evidence_json TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_tracking_identity_matches_subject ON tracking_identity_matches(subject_kind, subject_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_tracking_identity_matches_contact ON tracking_identity_matches(contact_id, match_confidence)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_tracking_identity_matches_identity ON tracking_identity_matches(identity_hash, accepted)')

    // Tabla de usuarios (para autenticación)
    await db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE,
        password_hash TEXT NOT NULL,
        full_name TEXT,
        role TEXT DEFAULT 'admin',
        is_active INTEGER DEFAULT 1,
        last_login DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)')
    await backfillUserEmailsFromLegacyUsernames({ source: 'initTables' })

    await db.run(`
      CREATE TABLE IF NOT EXISTS ai_agent_user_preferences (
        id ${usePostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
        user_id INTEGER NOT NULL UNIQUE,
        action_customizations TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_ai_agent_user_preferences_user_id ON ai_agent_user_preferences(user_id)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL UNIQUE,
        user_id INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        domain TEXT,
        action TEXT,
        source_of_truth TEXT,
        input_summary TEXT,
        output_summary TEXT,
        view_context_json TEXT,
        route_json TEXT,
        model TEXT,
        usage_json TEXT,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS agent_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        step_type TEXT NOT NULL,
        tool_name TEXT,
        status TEXT NOT NULL DEFAULT 'completed',
        input_json TEXT,
        output_json TEXT,
        error_message TEXT,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS agent_pending_actions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        domain TEXT,
        action_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        payload_json TEXT,
        confirmation_token TEXT,
        expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS agent_tool_idempotency (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        provider_ref TEXT,
        status TEXT NOT NULL DEFAULT 'created',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_agent_runs_trace ON agent_runs(trace_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_agent_runs_user_created ON agent_runs(user_id, created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_agent_steps_run_index ON agent_steps(run_id, step_index)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_agent_steps_type ON agent_steps(step_type, tool_name)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_agent_pending_actions_run ON agent_pending_actions(run_id, status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_agent_tool_idempotency_run ON agent_tool_idempotency(run_id, tool_name)')

    // Memoria persistente de los agentes IA por especialidad (citas, pagos, etc.)
    await db.run(`
      CREATE TABLE IF NOT EXISTS ai_agent_memories (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_ai_agent_memories_category ON ai_agent_memories(category, updated_at)')

    // Agentes conversacionales nativos: cada agente guarda su prompt editable,
    // capacidades blindadas y filtros factuales de entrada.
    await db.run(`
      CREATE TABLE IF NOT EXISTS conversational_agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        ai_provider TEXT DEFAULT 'openai',
        model ${DEFAULT_OPENAI_MODEL_COLUMN},
        runtime_mode TEXT NOT NULL DEFAULT 'tool_calling_v2',
        prompt_config TEXT,
        capabilities_config TEXT,
        identity_mode TEXT DEFAULT 'business',
        identity_user_id TEXT,
        identity_user_name TEXT,
        identity_custom_name TEXT,
        position INTEGER DEFAULT 0,
        objective TEXT DEFAULT 'citas',
        custom_objective TEXT,
        success_action TEXT DEFAULT 'ready_for_human',
        success_extras TEXT,
        required_data TEXT,
        handoff_rules TEXT,
        extra_instructions TEXT,
        allow_emojis INTEGER DEFAULT 0,
        hide_attended INTEGER DEFAULT 0,
        hide_attended_notifications INTEGER DEFAULT 0,
        default_calendar_id TEXT,
        closing_strategy_mode TEXT DEFAULT 'system',
        closing_strategy_custom TEXT,
        persuasion_level TEXT DEFAULT 'medium',
        language_level TEXT DEFAULT 'intermediate',
        contact_scope TEXT DEFAULT 'all',
        contact_scope_cutoff_at DATETIME,
        response_delay_config TEXT,
        reply_delivery_config TEXT,
        follow_up_config TEXT,
        goal_workflow_config TEXT,
        entry_filters TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    for (const [columnName, columnType] of [
      ['ai_provider', "TEXT DEFAULT 'openai'"],
      ['model', DEFAULT_OPENAI_MODEL_COLUMN],
      ['runtime_mode', "TEXT NOT NULL DEFAULT 'tool_calling_v2'"],
      ['prompt_config', 'TEXT'],
      ['capabilities_config', 'TEXT'],
      ['identity_mode', "TEXT DEFAULT 'business'"],
      ['identity_user_id', 'TEXT'],
      ['identity_user_name', 'TEXT'],
      ['identity_custom_name', 'TEXT'],
      ['hide_attended', 'INTEGER DEFAULT 0'],
      ['hide_attended_notifications', 'INTEGER DEFAULT 0'],
      ['response_delay_config', 'TEXT'],
      ['reply_delivery_config', 'TEXT'],
      ['follow_up_config', 'TEXT'],
      ['goal_workflow_config', 'TEXT'],
      ['persuasion_level', "TEXT DEFAULT 'medium'"],
      ['language_level', "TEXT DEFAULT 'intermediate'"],
      ['contact_scope', "TEXT DEFAULT 'all'"],
      ['contact_scope_cutoff_at', 'DATETIME']
    ]) {
      try {
        if (usePostgres) {
          await db.run(`ALTER TABLE conversational_agents ADD COLUMN IF NOT EXISTS ${columnName} ${columnType}`)
        } else {
          await db.run(`ALTER TABLE conversational_agents ADD COLUMN ${columnName} ${columnType}`)
        }
      } catch (err) {
        // La columna ya existe.
      }
    }
    await db.run(`
      UPDATE conversational_agents
      SET runtime_mode = 'tool_calling_v2'
      WHERE runtime_mode IS NULL OR runtime_mode <> 'tool_calling_v2'
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_conversational_agents_enabled ON conversational_agents(enabled, position)')

	    await db.run(`
	      CREATE TABLE IF NOT EXISTS conversational_agent_state (
	        id ${usePostgres ? "TEXT PRIMARY KEY DEFAULT ('cas_' || md5(random()::text || clock_timestamp()::text))" : "TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))"},
	        contact_id TEXT NOT NULL,
	        status TEXT NOT NULL DEFAULT 'active',
	        signal TEXT,
	        signal_reason TEXT,
        signal_summary TEXT,
        signal_at DATETIME,
        last_inbound_message_id TEXT,
        last_answered_inbound_message_id TEXT,
        last_reply_at DATETIME,
        channel TEXT DEFAULT 'whatsapp',
        inbound_processing_message_id TEXT,
        inbound_processing_status TEXT,
        inbound_processing_claim_token TEXT,
        inbound_processing_lease_until_at DATETIME,
        inbound_processing_started_at DATETIME,
        inbound_processing_attempt_count INTEGER DEFAULT 0,
        inbound_processing_last_error TEXT,
        follow_up_base_message_id TEXT,
        follow_up_sent_count INTEGER DEFAULT 0,
        follow_up_last_sent_at DATETIME,
        paused_until_at DATETIME,
        activated_at DATETIME,
        activation_source TEXT,
        activated_by TEXT,
        assignment_source TEXT,
        assigned_at DATETIME,
        assigned_by TEXT,
        updated_by TEXT,
        agent_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_state_signal ON conversational_agent_state(signal, signal_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_state_status ON conversational_agent_state(status, updated_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_state_agent_status ON conversational_agent_state(agent_id, status, updated_at)')

	    // La asignacion manual pertenece al contacto completo. Los estados de
	    // ejecucion siguen separados por canal para no compartir claims, pausas o
	    // cierres entre WhatsApp, Messenger, Instagram, SMS, webchat y correo.
	    await db.run(`
	      CREATE TABLE IF NOT EXISTS conversational_agent_manual_assignments (
	        contact_id TEXT PRIMARY KEY,
	        agent_id TEXT NOT NULL,
	        status TEXT NOT NULL DEFAULT 'active',
	        paused_until_at DATETIME,
	        assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	        assigned_by TEXT,
	        updated_by TEXT,
	        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
	        FOREIGN KEY (agent_id) REFERENCES conversational_agents(id) ON DELETE CASCADE
	      )
	    `)
	    await db.run(`
	      CREATE INDEX IF NOT EXISTS idx_conv_agent_manual_assignment_agent_status
	      ON conversational_agent_manual_assignments(agent_id, status, updated_at)
	    `)

    // Columnas agregadas al evolucionar el agente conversacional.
	    for (const [columnName, columnType] of [
	      ['id', 'TEXT'],
	      ['agent_id', 'TEXT'],
	      ['channel', "TEXT DEFAULT 'whatsapp'"],
	      ['last_answered_inbound_message_id', 'TEXT'],
      ['inbound_processing_message_id', 'TEXT'],
      ['inbound_processing_status', 'TEXT'],
      ['inbound_processing_claim_token', 'TEXT'],
      ['inbound_processing_lease_until_at', 'DATETIME'],
      ['inbound_processing_started_at', 'DATETIME'],
      ['inbound_processing_attempt_count', 'INTEGER DEFAULT 0'],
      ['inbound_processing_last_error', 'TEXT'],
      ['follow_up_base_message_id', 'TEXT'],
      ['follow_up_sent_count', 'INTEGER DEFAULT 0'],
      ['follow_up_last_sent_at', 'DATETIME'],
      ['paused_until_at', 'DATETIME'],
      ['activated_at', 'DATETIME'],
      ['activation_source', 'TEXT'],
      ['activated_by', 'TEXT'],
      ['assignment_source', 'TEXT'],
      ['assigned_at', 'DATETIME'],
      ['assigned_by', 'TEXT']
    ]) {
      try {
        if (usePostgres) {
          await db.run(`ALTER TABLE conversational_agent_state ADD COLUMN IF NOT EXISTS ${columnName} ${columnType}`)
        } else {
          await db.run(`ALTER TABLE conversational_agent_state ADD COLUMN ${columnName} ${columnType}`)
        }
      } catch (err) {
	        // La columna ya existe.
	      }
	    }
	    await ensureConversationalAgentStateIdentity()
	    await db.run(`
	      UPDATE conversational_agent_state
	      SET assignment_source = CASE
	            WHEN activation_source = 'manual' OR updated_by IN ('user', 'human', 'manual') THEN 'manual'
	            ELSE 'legacy'
	          END,
	          assigned_at = COALESCE(assigned_at, activated_at, created_at, updated_at, CURRENT_TIMESTAMP),
	          assigned_by = COALESCE(assigned_by, updated_by, 'system')
	      WHERE agent_id IS NOT NULL
	        AND (assignment_source IS NULL OR TRIM(assignment_source) = '')
	    `).catch(() => undefined)
	    await db.run(`
	      UPDATE conversational_agent_state
      SET activated_at = COALESCE(activated_at, created_at, updated_at, CURRENT_TIMESTAMP),
          activation_source = COALESCE(
            activation_source,
            CASE
              WHEN updated_by IN ('user', 'human', 'manual') THEN 'manual'
              ELSE 'automatic'
            END
          ),
          activated_by = COALESCE(activated_by, updated_by, 'system')
      WHERE activated_at IS NULL
        AND (
          agent_id IS NOT NULL
          OR signal IS NOT NULL
          OR last_reply_at IS NOT NULL
          OR last_answered_inbound_message_id IS NOT NULL
          OR status IN ('paused', 'skipped', 'human', 'completed', 'discarded')
        )
    `).catch(() => undefined)
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_state_activated ON conversational_agent_state(activated_at, status, updated_at)').catch(() => undefined)

    await db.run(`
      CREATE TABLE IF NOT EXISTS conversational_agent_events (
        id TEXT PRIMARY KEY,
        contact_id TEXT,
        agent_id TEXT,
        event_type TEXT NOT NULL,
        detail_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await ensureTableColumns('conversational_agent_events', [
      ['agent_id', 'TEXT']
    ])
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_events_contact ON conversational_agent_events(contact_id, created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_events_type ON conversational_agent_events(event_type, created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_events_agent ON conversational_agent_events(agent_id, created_at)')

    // El tester puede ejecutar efectos aislados sin contaminar citas, pagos,
    // métricas ni automatizaciones reales. La corrida queda ligada al usuario
    // que la inició y cada efecto usa una identidad durable por mensaje.
    await db.run(`
      CREATE TABLE IF NOT EXISTS conversational_agent_test_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        requested_by_user_id TEXT NOT NULL,
        contact_id TEXT,
        effects_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        cleaned_at DATETIME
      )
    `)
    await db.run(`
      CREATE TABLE IF NOT EXISTS conversational_agent_test_effects (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        effect_type TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'recorded',
        entity_id TEXT,
        payload_json TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        claim_token TEXT,
        lease_until_at DATETIME,
        last_error TEXT,
        error_code TEXT,
        error_retryable INTEGER,
        notification_status TEXT NOT NULL DEFAULT 'pending',
        notification_error TEXT,
        notification_sent_at DATETIME,
        completion_notification_status TEXT,
        completion_notification_error TEXT,
        completion_notification_sent_at DATETIME,
        cleanup_status TEXT,
        cleanup_error TEXT,
        cleaned_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (run_id) REFERENCES conversational_agent_test_runs(id) ON DELETE CASCADE
      )
    `)
    // El efecto externo ya tenía identidad durable, pero el turno completo no.
    // Esta bitácora evita que un retry HTTP vuelva a ejecutar la IA y pise la
    // respuesta final después de que una cita ya fue materializada.
    await db.run(`
      CREATE TABLE IF NOT EXISTS conversational_agent_test_turns (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        client_request_hash TEXT,
        status TEXT NOT NULL DEFAULT 'processing',
        preview_result_json TEXT,
        response_json TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        claim_token TEXT,
        lease_until_at DATETIME,
        error_code TEXT,
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY (run_id) REFERENCES conversational_agent_test_runs(id) ON DELETE CASCADE
      )
    `)
    await ensureTableColumns('conversational_agent_test_runs', [
      ['expires_at', 'DATETIME'],
      ['cleaned_at', 'DATETIME']
    ])
    await ensureTableColumns('conversational_agent_test_effects', [
      ['attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['claim_token', 'TEXT'],
      ['lease_until_at', 'DATETIME'],
      ['last_error', 'TEXT'],
      ['error_code', 'TEXT'],
      ['error_retryable', 'INTEGER'],
      ['notification_status', "TEXT NOT NULL DEFAULT 'pending'"],
      ['notification_error', 'TEXT'],
      ['notification_sent_at', 'DATETIME'],
      ['completion_notification_status', 'TEXT'],
      ['completion_notification_error', 'TEXT'],
      ['completion_notification_sent_at', 'DATETIME'],
      ['cleanup_status', 'TEXT'],
      ['cleanup_error', 'TEXT'],
      ['cleaned_at', 'DATETIME']
    ])
    await ensureTableColumns('conversational_agent_test_turns', [
      ['client_request_hash', 'TEXT'],
      ['preview_result_json', 'TEXT'],
      ['response_json', 'TEXT'],
      ['attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['claim_token', 'TEXT'],
      ['lease_until_at', 'DATETIME'],
      ['error_code', 'TEXT'],
      ['last_error', 'TEXT'],
      ['completed_at', 'DATETIME']
    ])
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_test_runs_user ON conversational_agent_test_runs(requested_by_user_id, updated_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_test_runs_agent ON conversational_agent_test_runs(agent_id, updated_at)')
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_test_effect_identity ON conversational_agent_test_effects(run_id, message_id, effect_type)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_test_effect_run ON conversational_agent_test_effects(run_id, created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_test_effect_entity ON conversational_agent_test_effects(effect_type, entity_id)')
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_test_effect_run_identity ON conversational_agent_test_effects(id, run_id)')
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_test_turn_identity ON conversational_agent_test_turns(run_id, message_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_test_turn_run ON conversational_agent_test_turns(run_id, created_at)')

    // Recibos durables de los eventos externos creados por una cita de prueba.
    // Se escriben inmediatamente después de que el proveedor devuelve su ID, de
    // modo que la limpieza no dependa de que el upsert posterior de la cita logre
    // guardar google_event_id/ghl_appointment_id.
    await db.run(`
      CREATE TABLE IF NOT EXISTS conversational_appointment_test_provider_receipts (
        id TEXT PRIMARY KEY,
        test_effect_id TEXT NOT NULL,
        test_run_id TEXT NOT NULL,
        appointment_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        command_key TEXT,
        idempotency_marker TEXT,
        command_json TEXT,
        remote_status TEXT NOT NULL DEFAULT 'created',
        remote_error TEXT,
        remote_attempt_count INTEGER NOT NULL DEFAULT 0,
        remote_reconciled_at DATETIME,
        calendar_id TEXT,
        cleanup_due_at DATETIME NOT NULL,
        cleanup_status TEXT NOT NULL DEFAULT 'pending',
        cleanup_error TEXT,
        cleanup_attempt_count INTEGER NOT NULL DEFAULT 0,
        cleaned_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (test_effect_id, test_run_id) REFERENCES conversational_agent_test_effects(id, run_id) ON DELETE RESTRICT,
        FOREIGN KEY (test_run_id) REFERENCES conversational_agent_test_runs(id) ON DELETE RESTRICT
      )
    `)
    await ensureTableColumns('conversational_appointment_test_provider_receipts', [
      ['command_key', 'TEXT'],
      ['idempotency_marker', 'TEXT'],
      ['command_json', 'TEXT'],
      ['remote_status', "TEXT NOT NULL DEFAULT 'created'"],
      ['remote_error', 'TEXT'],
      ['remote_attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['remote_reconciled_at', 'DATETIME']
    ])
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_appt_test_receipt_external ON conversational_appointment_test_provider_receipts(provider, external_id)')
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_appt_test_receipt_effect_provider ON conversational_appointment_test_provider_receipts(test_effect_id, provider)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_appt_test_receipt_cleanup ON conversational_appointment_test_provider_receipts(cleanup_status, cleanup_due_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_appt_test_receipt_appointment ON conversational_appointment_test_provider_receipts(appointment_id, provider)')

    // Bitácora idempotente de automatizaciones y recordatorios evaluados por una
    // cita de Modo test. Sólo webhooks y avisos internos se ejecutan de verdad;
    // las mutaciones no reversibles se registran como simuladas.
    await db.run(`
      CREATE TABLE IF NOT EXISTS conversational_appointment_test_automation_receipts (
        id TEXT PRIMARY KEY,
        test_effect_id TEXT NOT NULL,
        test_run_id TEXT NOT NULL,
        appointment_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        automation_id TEXT,
        automation_name TEXT,
        node_id TEXT,
        node_type TEXT,
        action_type TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        execution_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        request_json TEXT,
        response_json TEXT,
        cleanup_due_at DATETIME,
        completed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (test_effect_id, test_run_id) REFERENCES conversational_agent_test_effects(id, run_id) ON DELETE RESTRICT,
        FOREIGN KEY (test_run_id) REFERENCES conversational_agent_test_runs(id) ON DELETE RESTRICT
      )
    `)
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_appt_test_automation_receipt_key ON conversational_appointment_test_automation_receipts(idempotency_key)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_appt_test_automation_receipt_effect ON conversational_appointment_test_automation_receipts(test_effect_id, created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_appt_test_automation_receipt_appointment ON conversational_appointment_test_automation_receipts(appointment_id, created_at)')

    // Asignaciones reales pero temporales del Modo test. La tabla conserva a
    // quién estaba asignado el contacto para restaurarlo sin pisar cambios
    // humanos posteriores.
    await db.run(`
      CREATE TABLE IF NOT EXISTS conversational_agent_test_assignments (
        effect_id TEXT PRIMARY KEY,
        test_run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        requested_by_user_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        target_user_id TEXT NOT NULL,
        previous_user_id TEXT,
        status TEXT NOT NULL DEFAULT 'assigning',
        cleanup_due_at DATETIME NOT NULL,
        assigned_at DATETIME,
        notification_status TEXT NOT NULL DEFAULT 'pending',
        notification_error TEXT,
        notification_sent_at DATETIME,
        claim_token TEXT,
        lease_until_at DATETIME,
        cleanup_attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        cleaned_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (effect_id, test_run_id) REFERENCES conversational_agent_test_effects(id, run_id) ON DELETE RESTRICT,
        FOREIGN KEY (test_run_id) REFERENCES conversational_agent_test_runs(id) ON DELETE RESTRICT
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_test_assignment_cleanup ON conversational_agent_test_assignments(status, cleanup_due_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_test_assignment_run ON conversational_agent_test_assignments(test_run_id, updated_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_test_assignment_contact ON conversational_agent_test_assignments(contact_id, updated_at)')

    // Cuarentena reversible para riesgos detectados por el agente. El caso es
    // global por contacto+canal; los eventos y la auditoría son inmutables. No
    // se elimina ni modifica el contacto y tampoco se bloquea en el proveedor.
    await db.run(`
      CREATE TABLE IF NOT EXISTS conversational_agent_safety_cases (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        block_mode TEXT NOT NULL,
        blocked_until DATETIME,
        policy_json TEXT NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0,
        opened_at DATETIME NOT NULL,
        latest_event_id TEXT,
        latest_agent_id TEXT,
        latest_source_message_id TEXT,
        latest_reason TEXT,
        resolved_at DATETIME,
        resolved_by TEXT,
        resolution_reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await db.run(`
      CREATE TABLE IF NOT EXISTS conversational_agent_safety_events (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        block_mode TEXT NOT NULL,
        blocked_until DATETIME,
        notification_status TEXT NOT NULL DEFAULT 'pending',
        notification_attempts INTEGER NOT NULL DEFAULT 0,
        notification_claim_token TEXT,
        notification_lease_until DATETIME,
        notification_next_retry_at DATETIME,
        notification_last_error TEXT,
        notification_receipt_json TEXT,
        notification_sent_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (case_id) REFERENCES conversational_agent_safety_cases(id) ON DELETE RESTRICT
      )
    `)
    await db.run(`
      CREATE TABLE IF NOT EXISTS conversational_agent_safety_audit (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        event_id TEXT,
        action TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        detail_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (case_id) REFERENCES conversational_agent_safety_cases(id) ON DELETE RESTRICT,
        FOREIGN KEY (event_id) REFERENCES conversational_agent_safety_events(id) ON DELETE RESTRICT
      )
    `)
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_safety_case_identity ON conversational_agent_safety_cases(contact_id, channel)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_safety_case_active ON conversational_agent_safety_cases(status, blocked_until, updated_at)')
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_safety_event_identity ON conversational_agent_safety_events(agent_id, contact_id, channel, source_message_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_safety_event_case ON conversational_agent_safety_events(case_id, created_at)')
    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_conv_agent_safety_event_notification
      ON conversational_agent_safety_events(
        notification_status,
        notification_next_retry_at,
        notification_lease_until,
        updated_at
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_safety_audit_case ON conversational_agent_safety_audit(case_id, created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_safety_audit_event ON conversational_agent_safety_audit(event_id, created_at)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS conversational_agent_goal_links (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        agent_id TEXT,
        objective TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        target_url TEXT NOT NULL,
        sent_url TEXT NOT NULL,
        tracking_param TEXT NOT NULL DEFAULT 'ristak_goal_id',
        confirmation_token_hash TEXT,
        confirmation_expires_at DATETIME,
        confirmation_used_at DATETIME,
        idempotency_key TEXT,
        completion_auth_method TEXT,
        completion_actor_id TEXT,
        completion_request_id TEXT,
        completion_effects_status TEXT,
        completion_effects_attempts INTEGER NOT NULL DEFAULT 0,
        completion_effects_last_error TEXT,
        completion_effects_updated_at DATETIME,
        completion_effects_next_retry_at DATETIME,
        completion_effects_claim_token TEXT,
        completion_effects_lease_until_at DATETIME,
        completion_signal_applied_at DATETIME,
        completion_action_applied_at DATETIME,
        completion_extras_applied_at DATETIME,
        completion_notification_claimed_at DATETIME,
        completion_notification_sent_at DATETIME,
        completion_notification_status TEXT,
        completion_notification_claim_token TEXT,
        completion_notification_last_error TEXT,
        completion_event_recorded_at DATETIME,
        external_source TEXT,
        external_evidence_key TEXT,
        external_object_id TEXT,
        external_status TEXT,
        metadata_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
        FOREIGN KEY (agent_id) REFERENCES conversational_agents(id) ON DELETE SET NULL
      )
    `)
    await ensureTableColumns('conversational_agent_goal_links', [
      ['confirmation_token_hash', 'TEXT'],
      ['confirmation_expires_at', 'DATETIME'],
      ['confirmation_used_at', 'DATETIME'],
      ['idempotency_key', 'TEXT'],
      ['completion_auth_method', 'TEXT'],
      ['completion_actor_id', 'TEXT'],
      ['completion_request_id', 'TEXT'],
      ['completion_effects_status', 'TEXT'],
      ['completion_effects_attempts', 'INTEGER NOT NULL DEFAULT 0'],
      ['completion_effects_last_error', 'TEXT'],
      ['completion_effects_updated_at', 'DATETIME'],
      ['completion_effects_next_retry_at', 'DATETIME'],
      ['completion_effects_claim_token', 'TEXT'],
      ['completion_effects_lease_until_at', 'DATETIME'],
      ['completion_signal_applied_at', 'DATETIME'],
      ['completion_action_applied_at', 'DATETIME'],
      ['completion_extras_applied_at', 'DATETIME'],
      ['completion_notification_claimed_at', 'DATETIME'],
      ['completion_notification_sent_at', 'DATETIME'],
      ['completion_notification_status', 'TEXT'],
      ['completion_notification_claim_token', 'TEXT'],
      ['completion_notification_last_error', 'TEXT'],
      ['completion_event_recorded_at', 'DATETIME'],
      ['external_source', 'TEXT'],
      ['external_evidence_key', 'TEXT']
    ])
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_goal_links_contact ON conversational_agent_goal_links(contact_id, created_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_goal_links_status ON conversational_agent_goal_links(status, created_at)')
    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_conv_agent_goal_links_effects_recovery
      ON conversational_agent_goal_links(
        completion_effects_status,
        completion_effects_next_retry_at,
        completion_effects_lease_until_at,
        completion_effects_updated_at
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_conv_agent_goal_links_external ON conversational_agent_goal_links(external_object_id)')
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_goal_links_external_evidence ON conversational_agent_goal_links(external_evidence_key)')
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_goal_links_token_hash ON conversational_agent_goal_links(confirmation_token_hash)')
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_goal_links_idempotency ON conversational_agent_goal_links(idempotency_key)')
    await db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_goal_links_completion_request
      ON conversational_agent_goal_links(completion_auth_method, completion_actor_id, completion_request_id)
    `)

    // Tombstone independiente: conserva para siempre la propiedad de una
    // evidencia y de su Idempotency-Key aunque el contacto o la meta se borren.
    // Tabla, backfill y guard de rolling deploy se publican atómicamente: una
    // instancia vieja no puede completar metas sin crear primero el claim.
    await db.transaction(async (tx) => {
      if (usePostgres) {
        // Toma el lock antes del snapshot del backfill. Sin esto, una instancia
        // vieja podría commitear pending→completed entre el SELECT y el trigger.
        await tx.run('LOCK TABLE conversational_agent_goal_links IN SHARE ROW EXCLUSIVE MODE')
      }
      await tx.run(`
        CREATE TABLE IF NOT EXISTS conversational_agent_goal_evidence_claims (
          external_evidence_key TEXT PRIMARY KEY,
          external_source TEXT NOT NULL,
          confirmation_fingerprint TEXT NOT NULL,
          goal_id TEXT NOT NULL,
          completion_auth_method TEXT NOT NULL,
          completion_actor_id TEXT NOT NULL DEFAULT '',
          completion_request_id TEXT NOT NULL,
          legacy_external_object_id TEXT,
          claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `)
      if (usePostgres) {
        await tx.run(`
          ALTER TABLE conversational_agent_goal_evidence_claims
          ADD COLUMN IF NOT EXISTS legacy_external_object_id TEXT
        `)
      } else {
        const columns = await tx.all('PRAGMA table_info(conversational_agent_goal_evidence_claims)')
        if (!columns.some((column) => column.name === 'legacy_external_object_id')) {
          await tx.run('ALTER TABLE conversational_agent_goal_evidence_claims ADD COLUMN legacy_external_object_id TEXT')
        }
      }
      await tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_goal_evidence_claims_goal
        ON conversational_agent_goal_evidence_claims(goal_id)
      `)
      await tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_goal_evidence_claims_request
        ON conversational_agent_goal_evidence_claims(
          completion_auth_method,
          completion_actor_id,
          completion_request_id
        )
      `)
      await tx.run(`
        CREATE INDEX IF NOT EXISTS idx_conv_agent_goal_evidence_claims_legacy_object
        ON conversational_agent_goal_evidence_claims(legacy_external_object_id)
      `)

      await tx.run(`
        INSERT INTO conversational_agent_goal_evidence_claims (
          external_evidence_key, external_source, confirmation_fingerprint,
          goal_id, completion_auth_method, completion_actor_id,
          completion_request_id, claimed_at
        )
        SELECT
          external_evidence_key,
          COALESCE(NULLIF(external_source, ''), 'legacy:unknown'),
          external_evidence_key,
          id,
          COALESCE(NULLIF(completion_auth_method, ''), 'legacy_unknown'),
          COALESCE(completion_actor_id, ''),
          COALESCE(NULLIF(completion_request_id, ''), 'legacy:' || id),
          COALESCE(completed_at, updated_at, created_at, CURRENT_TIMESTAMP)
        FROM conversational_agent_goal_links
        WHERE status = 'completed'
          AND external_evidence_key IS NOT NULL
          AND external_evidence_key != ''
        ON CONFLICT DO NOTHING
      `)
      // Una completion creada por el binario anterior no conoce source ni key.
      // Se conserva como wildcard por object ID para que jamás pueda reusarse
      // durante el overlap, aun si eso exige ser conservadores entre proveedores.
      await tx.run(`
        INSERT INTO conversational_agent_goal_evidence_claims (
          external_evidence_key, external_source, confirmation_fingerprint,
          goal_id, completion_auth_method, completion_actor_id,
          completion_request_id, legacy_external_object_id, claimed_at
        )
        SELECT
          'legacy_untrusted:' || id,
          'legacy:wildcard',
          'legacy_untrusted:' || id,
          id,
          'legacy_untrusted',
          '',
          'legacy:' || id,
          external_object_id,
          COALESCE(completed_at, updated_at, created_at, CURRENT_TIMESTAMP)
        FROM conversational_agent_goal_links
        WHERE status = 'completed'
          AND (external_evidence_key IS NULL OR external_evidence_key = '')
          AND external_object_id IS NOT NULL
          AND external_object_id != ''
        ON CONFLICT DO NOTHING
      `)

      if (usePostgres) {
        await tx.exec(`
          CREATE OR REPLACE FUNCTION enforce_conversational_goal_evidence_claim()
          RETURNS trigger AS $$
          BEGIN
            IF NEW.status = 'completed'
              AND COALESCE(OLD.status, '') <> 'completed'
              AND NOT EXISTS (
                SELECT 1 FROM conversational_agent_goal_evidence_claims claim
                WHERE claim.goal_id = NEW.id
              )
            THEN
              RAISE EXCEPTION 'CONVERSATIONAL_GOAL_EVIDENCE_CLAIM_REQUIRED';
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;

          DROP TRIGGER IF EXISTS trg_conversational_goal_evidence_claim
          ON conversational_agent_goal_links;
          CREATE TRIGGER trg_conversational_goal_evidence_claim
          BEFORE UPDATE OF status ON conversational_agent_goal_links
          FOR EACH ROW EXECUTE FUNCTION enforce_conversational_goal_evidence_claim();
        `)
      } else {
        await tx.exec(`
          DROP TRIGGER IF EXISTS trg_conversational_goal_evidence_claim;
          CREATE TRIGGER trg_conversational_goal_evidence_claim
          BEFORE UPDATE OF status ON conversational_agent_goal_links
          FOR EACH ROW
          WHEN NEW.status = 'completed'
            AND COALESCE(OLD.status, '') <> 'completed'
            AND NOT EXISTS (
              SELECT 1 FROM conversational_agent_goal_evidence_claims claim
              WHERE claim.goal_id = NEW.id
            )
          BEGIN
            SELECT RAISE(ABORT, 'CONVERSATIONAL_GOAL_EVIDENCE_CLAIM_REQUIRED');
          END;
        `)
      }
    })

    const userOptionalColumns = [
      ['first_name', 'TEXT'],
      ['last_name', 'TEXT'],
      ['phone', 'TEXT'],
      ['business_name', 'TEXT'],
      ['last_login', 'DATETIME'],
      ['created_at', 'DATETIME'],
      ['updated_at', 'DATETIME'],
      ['access_config', 'TEXT'],
      ['token_version', 'INTEGER DEFAULT 0'],
      ['api_token_hash', 'TEXT'],
      ['api_token_prefix', 'TEXT'],
      ['api_token_last_four', 'TEXT'],
      ['api_token_created_at', 'DATETIME'],
      ['api_token_last_used_at', 'DATETIME'],
      ['api_token_revoked_at', 'DATETIME']
    ]

    for (const [columnName, columnType] of userOptionalColumns) {
      try {
        if (usePostgres) {
          await db.run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${columnName} ${columnType}`)
        } else {
          await db.run(`ALTER TABLE users ADD COLUMN ${columnName} ${columnType}`)
        }
      } catch (err) {
        // Ignore if the column already exists.
      }
    }

    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_token_hash ON users(api_token_hash)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_name TEXT,
        redirect_uris TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
        code_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scope TEXT,
        resource TEXT,
        expires_at DATETIME NOT NULL,
        used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `)

    await db.run(`
      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        scope TEXT,
        resource TEXT,
        expires_at DATETIME NOT NULL,
        revoked_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_oauth_codes_client ON oauth_authorization_codes(client_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user ON oauth_refresh_tokens(user_id)')

    // Tabla para filtros de contactos ocultos
    await db.run(`
      CREATE TABLE IF NOT EXISTS hidden_contact_filters (
        id ${usePostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
        filter_text VARCHAR(255) NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_hidden_filters_text ON hidden_contact_filters(filter_text)')

    // Migración: Agregar columna match_type a hidden_contact_filters
    try {
      if (usePostgres) {
        await db.run(`
          ALTER TABLE hidden_contact_filters
          ADD COLUMN IF NOT EXISTS match_type VARCHAR(20) DEFAULT 'contains'
        `)
      } else {
        // SQLite no soporta IF NOT EXISTS en ALTER TABLE, intentar y capturar error
        await db.run(`
          ALTER TABLE hidden_contact_filters
          ADD COLUMN match_type VARCHAR(20) DEFAULT 'contains'
        `)
      }
      logger.success('✅ Migración: Columna match_type agregada a hidden_contact_filters')
    } catch (err) {
      if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
        logger.warn('Advertencia al agregar match_type a hidden_contact_filters:', err.message)
      }
    }

    // MIGRACIONES PARA POSTGRESQL
    if (usePostgres) {
      // Migración 1: Agregar columna contact_id a appointments si no existe
      try {
        await db.run('ALTER TABLE appointments ADD COLUMN contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE')
        logger.success('✅ Migración: Columna contact_id agregada a appointments')
      } catch (err) {
        if (err.code !== '42701' && !err.message.includes('already exists')) {
          logger.warn('Advertencia al agregar contact_id a appointments:', err.message)
        }
      }

      // Crear índice para contact_id en appointments
      try {
        await db.run('CREATE INDEX IF NOT EXISTS idx_appointments_contact ON appointments(contact_id)')
      } catch (err) {
        // Ignorar si ya existe
      }
    }

    // Tabla de costos (impuestos, comisiones, gastos fijos, etc.)
    await db.run(`
      CREATE TABLE IF NOT EXISTS costs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        calculation_type TEXT NOT NULL,
        value REAL NOT NULL,
        applies_to TEXT,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_costs_type ON costs(type)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_costs_active ON costs(is_active)')

    await db.run(`
      CREATE TABLE IF NOT EXISTS report_manual_business_expenses (
        period_type TEXT NOT NULL,
        period_start TEXT NOT NULL,
        amount REAL NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (period_type, period_start)
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_report_manual_business_expenses_period ON report_manual_business_expenses(period_type, period_start)')

    // Carpetas de automatizaciones (organización del listado)
    await db.run(`
      CREATE TABLE IF NOT EXISTS automation_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT,
        position INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Automatizaciones: el flujo (nodos, conexiones y viewport) se guarda como
    // JSON flexible para poder agregar nuevos tipos de nodos sin migraciones.
    await db.run(`
      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        folder_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'draft',
        flow ${usePostgres ? "JSONB DEFAULT '{}'::jsonb" : "TEXT DEFAULT '{}'"},
        published_flow ${usePostgres ? 'JSONB' : 'TEXT'},
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        published_at DATETIME
      )
    `)

    try {
      await db.run(`ALTER TABLE automations ADD COLUMN published_flow ${usePostgres ? 'JSONB' : 'TEXT'}`)
    } catch (err) {
      if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
        logger.warn(`Advertencia al migrar automations.published_flow: ${err.message}`)
      }
    }
    await db
      .run("UPDATE automations SET published_flow = flow WHERE status = 'published' AND published_flow IS NULL")
      .catch((err) => logger.warn(`Advertencia al poblar automations.published_flow: ${err.message}`))

    await db.run('CREATE INDEX IF NOT EXISTS idx_automations_folder ON automations(folder_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_automations_status ON automations(status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_automation_folders_position ON automation_folders(position)')

    // Inscripciones de contactos en automatizaciones (historial y posición
    // actual en el flujo; las llena el motor de ejecución)
    await db.run(`
      CREATE TABLE IF NOT EXISTS automation_enrollments (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        contact_id TEXT,
        contact_name TEXT,
        status TEXT DEFAULT 'active',
        current_node_id TEXT,
        log ${usePostgres ? "JSONB DEFAULT '[]'::jsonb" : "TEXT DEFAULT '[]'"},
        execution_outcome TEXT DEFAULT 'pending',
        last_error TEXT,
        entered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_automation_enrollments_auto ON automation_enrollments(automation_id, status)')
    // Columnas de espera del motor (tablas creadas antes de este cambio)
    for (const column of [
      'resume_at DATETIME',
      'wait_kind TEXT',
      "context TEXT DEFAULT '{}'",
      "execution_outcome TEXT DEFAULT 'pending'",
      'last_error TEXT',
      'dedupe_contact_id TEXT'
    ]) {
      await db.run(`ALTER TABLE automation_enrollments ADD COLUMN ${column}`).catch(() => {})
    }

    // Goteo: turno persistente de cada inscripción al pasar por un nodo de lote.
    // La posición única por automatización+nodo permite calcular lotes estables.
    await db.run(`
      CREATE TABLE IF NOT EXISTS automation_drip_entries (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        enrollment_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        batch_index INTEGER NOT NULL,
        scheduled_for DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (automation_id, node_id, enrollment_id),
        UNIQUE (automation_id, node_id, position)
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_automation_drip_entries_node ON automation_drip_entries(automation_id, node_id, position)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_automation_drip_entries_enrollment ON automation_drip_entries(enrollment_id)')

    // Ejecuciones ya tomadas por el disparador programado. La llave única evita
    // que el tick del motor dispare varias veces el mismo horario.
    await db.run(`
      CREATE TABLE IF NOT EXISTS automation_schedule_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        trigger_id TEXT NOT NULL,
        run_key TEXT NOT NULL,
        scheduled_for DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (automation_id, trigger_id, run_key)
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_automation_schedule_runs_auto ON automation_schedule_runs(automation_id, created_at)')

    // Contactos agregados manualmente a una automatización desde su ficha.
    // Permite mandarlos al flujo en ese momento o dejarlos programados para
    // que el tick del motor los inscriba después.
    await db.run(`
      CREATE TABLE IF NOT EXISTS automation_contact_enrollment_jobs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        contact_name TEXT,
        scheduled_at DATETIME NOT NULL,
        status TEXT DEFAULT 'scheduled',
        enrollment_id TEXT,
        error TEXT,
        log TEXT DEFAULT '[]',
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        executed_at DATETIME
      )
    `)
    await db.run("ALTER TABLE automation_contact_enrollment_jobs ADD COLUMN log TEXT DEFAULT '[]'").catch(() => {})
    await db.run('CREATE INDEX IF NOT EXISTS idx_automation_contact_jobs_contact ON automation_contact_enrollment_jobs(contact_id, status, scheduled_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_automation_contact_jobs_due ON automation_contact_enrollment_jobs(status, scheduled_at)')

    // Acciones masivas disparadas desde la tabla de contactos. Guardan el lote
    // y cada contacto para poder consultar avance, detener, reprogramar o borrar
    // el trabajo sin perder visibilidad.
    await db.run(`
      CREATE TABLE IF NOT EXISTS contact_bulk_actions (
        id TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        title TEXT,
        status TEXT DEFAULT 'scheduled',
        total_count INTEGER DEFAULT 0,
        processed_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        scheduled_at DATETIME,
        drip_enabled INTEGER DEFAULT 0,
        drip_interval_minutes INTEGER DEFAULT 0,
        config_json TEXT DEFAULT '{}',
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        completed_at DATETIME,
        paused_at DATETIME,
        cancelled_at DATETIME
      )
    `)
    await db.run(`
      CREATE TABLE IF NOT EXISTS contact_bulk_action_items (
        id TEXT PRIMARY KEY,
        bulk_action_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        contact_name TEXT,
        scheduled_at DATETIME NOT NULL,
        status TEXT DEFAULT 'scheduled',
        result_json TEXT,
        error TEXT,
        external_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed_at DATETIME,
        FOREIGN KEY (bulk_action_id) REFERENCES contact_bulk_actions(id) ON DELETE CASCADE
      )
    `)
    await db.run('CREATE INDEX IF NOT EXISTS idx_contact_bulk_actions_status ON contact_bulk_actions(status, scheduled_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contact_bulk_items_action ON contact_bulk_action_items(bulk_action_id, status, scheduled_at)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_contact_bulk_items_due ON contact_bulk_action_items(status, scheduled_at)')

    // Etiquetas locales de contactos (array JSON), usadas por automatizaciones
    await db.run(`ALTER TABLE contacts ADD COLUMN tags TEXT DEFAULT '[]'`).catch(() => {})

    // Catálogo de etiquetas de contactos: contacts.tags guarda los IDs, así el
    // usuario puede renombrar una etiqueta sin romper filtros ni automatizaciones.
    // Las etiquetas internas (Cliente, Cita agendada, Prospecto) no viven aquí:
    // se calculan en contactTagsService según la actividad del contacto.
    await db.run(`
      CREATE TABLE IF NOT EXISTS contact_tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    // Carpetas para organizar etiquetas (mismo patrón que campos personalizados)
    await db.run(`
      CREATE TABLE IF NOT EXISTS contact_tag_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await db.run(`ALTER TABLE contact_tags ADD COLUMN folder_id TEXT`).catch(() => {})

    // Archivos adjuntos de automatizaciones (imágenes, videos, audios, docs)
    await db.run(`
      CREATE TABLE IF NOT EXISTS automation_assets (
        id TEXT PRIMARY KEY,
        filename TEXT,
        content_type TEXT NOT NULL,
        content_base64 TEXT NOT NULL,
        size_bytes INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Mensajes automáticos de citas (recordatorios y confirmaciones).
    // Cada fila es una "cajita" configurable desde la página de Calendarios.
    await db.run(`
      CREATE TABLE IF NOT EXISTS appointment_reminders (
        id TEXT PRIMARY KEY,
        system_key TEXT,
        schedule_key TEXT,
        name TEXT,
        enabled INTEGER DEFAULT 1,
        message_type TEXT DEFAULT 'reminder',
        ai_enabled INTEGER DEFAULT 1,
        channel TEXT DEFAULT 'whatsapp',
        sender_mode TEXT DEFAULT 'contact',
        sender_phone_number_id TEXT,
        template_id TEXT,
        template_name TEXT,
        template_language TEXT DEFAULT 'es_MX',
        content_mode TEXT DEFAULT 'template',
        qr_fallback_enabled INTEGER DEFAULT 0,
        timing_anchor TEXT DEFAULT 'before_appointment',
        offset_value INTEGER DEFAULT 1,
        offset_unit TEXT DEFAULT 'days',
        message_text TEXT,
        smart_enabled INTEGER DEFAULT 1,
        smart_start TEXT DEFAULT '09:00',
        smart_end TEXT DEFAULT '21:00',
        smart_overflow TEXT DEFAULT 'before',
        no_confirm_action TEXT DEFAULT 'no_action',
        confirmation_success_action TEXT DEFAULT 'chat_card',
        bypass_automations INTEGER DEFAULT 0,
        position INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Registro de envíos por (recordatorio, cita) para no duplicar mensajes y
    // para que la IA pueda confirmar la cita cuando el contacto responde.
    await db.run(`
      CREATE TABLE IF NOT EXISTS appointment_reminder_sends (
        id TEXT PRIMARY KEY,
        reminder_id TEXT NOT NULL,
        appointment_id TEXT NOT NULL,
        contact_id TEXT,
        status TEXT DEFAULT 'sent',
        message_type TEXT,
        ai_enabled INTEGER DEFAULT 0,
        sent_message_id TEXT,
        error_message TEXT,
        send_at DATETIME,
        sent_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(reminder_id, appointment_id)
      )
    `)

    await db.run('CREATE INDEX IF NOT EXISTS idx_appointment_reminder_sends_appointment ON appointment_reminder_sends(appointment_id)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_appointment_reminder_sends_contact ON appointment_reminder_sends(contact_id, status)')

    try {
      await db.run("ALTER TABLE appointment_reminders ADD COLUMN no_confirm_action TEXT DEFAULT 'no_action'")
    } catch (_) { /* columna ya existe */ }

    try {
      await db.run("ALTER TABLE appointment_reminders ADD COLUMN confirmation_success_action TEXT DEFAULT 'chat_card'")
    } catch (_) { /* columna ya existe */ }

    try {
      await db.run("ALTER TABLE appointment_reminders ADD COLUMN bypass_automations INTEGER DEFAULT 0")
    } catch (_) { /* columna ya existe */ }

    try {
      await db.run('ALTER TABLE appointment_reminders ADD COLUMN template_id TEXT')
    } catch (_) { /* columna ya existe */ }

    try {
      await db.run('ALTER TABLE appointment_reminders ADD COLUMN template_name TEXT')
    } catch (_) { /* columna ya existe */ }

    try {
      await db.run("ALTER TABLE appointment_reminders ADD COLUMN template_language TEXT DEFAULT 'es_MX'")
    } catch (_) { /* columna ya existe */ }

    try {
      await db.run("ALTER TABLE appointment_reminders ADD COLUMN content_mode TEXT DEFAULT 'template'")
    } catch (_) { /* columna ya existe */ }

    try {
      await db.run('ALTER TABLE appointment_reminders ADD COLUMN qr_fallback_enabled INTEGER DEFAULT 0')
    } catch (_) { /* columna ya existe */ }

    try {
      await db.run('ALTER TABLE appointment_reminders ADD COLUMN system_key TEXT')
    } catch (_) { /* columna ya existe */ }

    await db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_reminders_system_key
      ON appointment_reminders(system_key)
      WHERE system_key IS NOT NULL
    `)

    try {
      await db.run("ALTER TABLE appointment_reminders ADD COLUMN timing_anchor TEXT DEFAULT 'before_appointment'")
    } catch (_) { /* columna ya existe */ }

    try {
      await db.run('ALTER TABLE appointment_reminders ADD COLUMN schedule_key TEXT')
    } catch (_) { /* columna ya existe */ }

    // Conserva configuraciones históricas sin borrar nada: cuando ya había
    // duplicados, sólo la primera fila ocupa el horario canónico. Las demás
    // quedan visibles y deberán corregirse antes de poder volver a guardarse.
    await db.run(`
      WITH reminder_schedule_candidates AS (
        SELECT
          id,
          COALESCE(timing_anchor, 'before_appointment') || ':' || CAST(
            CASE
              WHEN COALESCE(timing_anchor, 'before_appointment') = 'after_booking' THEN
                CASE COALESCE(offset_unit, 'minutes')
                  WHEN 'seconds' THEN COALESCE(offset_value, 0) * 1000
                  WHEN 'hours' THEN COALESCE(offset_value, 0) * 3600000
                  ELSE COALESCE(offset_value, 0) * 60000
                END
              ELSE
                CASE COALESCE(offset_unit, 'days')
                  WHEN 'minutes' THEN COALESCE(offset_value, 1) * 60000
                  WHEN 'hours' THEN COALESCE(offset_value, 1) * 3600000
                  ELSE COALESCE(offset_value, 1) * 86400000
                END
            END AS TEXT
          ) AS candidate_key,
          created_at
        FROM appointment_reminders
      ), ranked_reminder_schedules AS (
        SELECT
          id,
          candidate_key,
          ROW_NUMBER() OVER (
            PARTITION BY candidate_key
            ORDER BY created_at ASC, id ASC
          ) AS schedule_rank
        FROM reminder_schedule_candidates
      )
      UPDATE appointment_reminders
      SET schedule_key = (
        SELECT candidate_key
        FROM ranked_reminder_schedules
        WHERE ranked_reminder_schedules.id = appointment_reminders.id
      )
      WHERE schedule_key IS NULL
        AND id IN (
          SELECT id
          FROM ranked_reminder_schedules
          WHERE schedule_rank = 1
        )
        AND NOT EXISTS (
          SELECT 1
          FROM appointment_reminders occupied_schedule
          WHERE occupied_schedule.schedule_key = (
            SELECT candidate_key
            FROM ranked_reminder_schedules
            WHERE ranked_reminder_schedules.id = appointment_reminders.id
          )
        )
    `)

    await db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_reminders_schedule_key
      ON appointment_reminders(schedule_key)
      WHERE schedule_key IS NOT NULL
    `)

    try {
      await db.run('ALTER TABLE appointments ADD COLUMN confirmation_badge_until DATETIME')
    } catch (_) { /* columna ya existe */ }

    // Ventanas de confirmación con IA: acumula mensajes durante 2 min antes de clasificar.
    await db.run(`
      CREATE TABLE IF NOT EXISTS appointment_confirmation_windows (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        appointment_id TEXT NOT NULL,
        reminder_send_id TEXT NOT NULL,
        status TEXT DEFAULT 'waiting',
        accumulated_messages TEXT DEFAULT '[]',
        bypass_automations INTEGER DEFAULT 0,
        confirmation_success_action TEXT DEFAULT 'chat_card',
        last_message_at DATETIME NOT NULL,
        result TEXT,
        result_detail TEXT,
        processed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(contact_id, appointment_id)
      )
    `)
    try {
      await db.run("ALTER TABLE appointment_confirmation_windows ADD COLUMN confirmation_success_action TEXT DEFAULT 'chat_card'")
    } catch (_) { /* columna ya existe */ }
    await db.run('CREATE INDEX IF NOT EXISTS idx_conf_windows_contact ON appointment_confirmation_windows(contact_id, status)')
    await db.run('CREATE INDEX IF NOT EXISTS idx_conf_windows_last_msg ON appointment_confirmation_windows(last_message_at, status)')

    await db.run(`
      INSERT INTO app_config (config_key, config_value, created_at, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(config_key) DO UPDATE SET
        config_value = excluded.config_value,
        updated_at = CURRENT_TIMESTAMP
    `, [CORE_SCHEMA_BOOTSTRAP_CONFIG_KEY, CORE_SCHEMA_BOOTSTRAP_VERSION])

    logger.success(`Todas las tablas inicializadas correctamente (bootstrap ${CORE_SCHEMA_BOOTSTRAP_VERSION})`)
    return { skipped: false, version: CORE_SCHEMA_BOOTSTRAP_VERSION }
  } catch (error) {
    logger.error('Error inicializando tablas:', error)
    throw error
  }
}

/**
 * Migración única: contacts.tags guardaba nombres sueltos; ahora guarda IDs del
 * catálogo contact_tags. Crea las etiquetas que falten y reescribe los arrays.
 * Idempotente: cuando todo ya son IDs del catálogo no toca nada.
 * Vive aquí (y no en contactTagsService) para no crear un ciclo de imports
 * durante el top-level await de initTables().
 */

// IDs/nombres de las etiquetas internas calculadas (viven en contactTagsService;
// se duplican aquí para no crear un ciclo de imports durante initTables).
const SYSTEM_TAG_ALIASES = {
  client: 'client',
  customer: 'client',
  cliente: 'client',
  booked: 'booked',
  appointment: 'booked',
  cita: 'booked',
  cita_agendada: 'booked',
  lead: 'lead',
  prospecto: 'lead',
  tag_sys_customer: 'client',
  tag_sys_appointment: 'booked',
  tag_sys_lead: 'lead'
}
const SYSTEM_TAG_SLUG_IDS = new Set(Object.keys(SYSTEM_TAG_ALIASES))
const SYSTEM_TAG_NAMES = new Set(['cliente', 'cita agendada', 'prospecto'])

function normalizeSystemTagValue(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

function isReservedSystemTagValue(value) {
  const normalized = normalizeSystemTagValue(value)
  return SYSTEM_TAG_SLUG_IDS.has(normalized) || SYSTEM_TAG_NAMES.has(normalized)
}

/** Slug legible para el ID de una etiqueta: "Carromagic" → carromagic */
function tagSlug(name) {
  const slug = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
  return slug || 'etiqueta'
}

/** Slug único: agrega sufijo numérico si ya está ocupado o es una interna */
function uniqueTagSlug(name, takenIds) {
  const base = tagSlug(name)
  let candidate = base
  for (let n = 2; takenIds.has(candidate) || SYSTEM_TAG_SLUG_IDS.has(candidate); n += 1) {
    candidate = `${base}_${n}`
  }
  return candidate
}

async function migrateLegacyContactTagsToCatalog() {
  const normalizeName = (value) => String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()

  const rows = await db.all(
    `SELECT id, tags FROM contacts WHERE tags IS NOT NULL AND tags != '[]' AND tags != ''`
  ).catch(() => [])
  if (!rows.length) return

  const catalogRows = await db.all('SELECT id, name FROM contact_tags').catch(() => [])
  const idsInCatalog = new Set(catalogRows.map((row) => row.id))
  const idByName = new Map(catalogRows.map((row) => [normalizeName(row.name), row.id]))

  let migrated = 0
  for (const row of rows) {
    let tags
    try {
      tags = JSON.parse(row.tags)
    } catch {
      continue
    }
    if (!Array.isArray(tags) || tags.length === 0) continue
    if (tags.every((value) => idsInCatalog.has(String(value)) || isReservedSystemTagValue(value))) continue

    const next = []
    for (const value of tags) {
      const raw = String(value || '').trim()
      if (!raw) continue
      if (isReservedSystemTagValue(raw)) {
        continue
      }
      if (idsInCatalog.has(raw)) {
        next.push(raw)
        continue
      }
      const existingId = idByName.get(normalizeName(raw))
      if (existingId) {
        next.push(existingId)
        continue
      }
      const newId = uniqueTagSlug(normalizeName(raw), idsInCatalog)
      await db.run('INSERT INTO contact_tags (id, name) VALUES (?, ?)', [newId, raw.slice(0, 60)])
      idsInCatalog.add(newId)
      idByName.set(normalizeName(raw), newId)
      next.push(newId)
    }

    await db.run('UPDATE contacts SET tags = ? WHERE id = ?', [JSON.stringify([...new Set(next)]), row.id])
    migrated += 1
  }
  if (migrated > 0) {
    logger.info(`Etiquetas de contactos migradas a IDs de catálogo en ${migrated} contactos`)
  }
}

async function cleanupReservedSystemContactTags() {
  const catalogRows = await db.all('SELECT id, name FROM contact_tags').catch(() => [])
  const reservedRows = catalogRows.filter((row) => (
    isReservedSystemTagValue(row.id) || isReservedSystemTagValue(row.name)
  ))
  const reservedIds = new Set(reservedRows.map((row) => String(row.id)))

  for (const row of reservedRows) {
    await db.run('DELETE FROM contact_tags WHERE id = ?', [row.id])
  }

  const contactRows = await db.all(
    `SELECT id, tags FROM contacts WHERE tags IS NOT NULL AND tags != '[]' AND tags != ''`
  ).catch(() => [])
  let cleanedContacts = 0
  for (const row of contactRows) {
    let tags
    try {
      tags = JSON.parse(row.tags)
    } catch {
      continue
    }
    if (!Array.isArray(tags)) continue
    const next = tags.filter((value) => {
      const raw = String(value || '').trim()
      return raw && !reservedIds.has(raw) && !isReservedSystemTagValue(raw)
    })
    if (next.length === tags.length) continue
    await db.run('UPDATE contacts SET tags = ? WHERE id = ?', [JSON.stringify([...new Set(next)]), row.id])
    cleanedContacts += 1
  }

  if (reservedRows.length > 0 || cleanedContacts > 0) {
    logger.info(`Etiquetas internas retiradas del catálogo editable: ${reservedRows.length}; contactos limpiados: ${cleanedContacts}`)
  }
}

/**
 * Migración única: los IDs de etiquetas pasaron de tag_<uuid> a slugs legibles
 * derivados del nombre ("Carromagic" → carromagic). Reescribe el catálogo,
 * los arrays de contacts.tags y las referencias guardadas en automatizaciones
 * y agentes conversacionales. Idempotente: sin IDs con formato uuid no hace nada.
 */
async function migrateTagIdsToSlugs() {
  const UUID_TAG_ID = /^tag_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  const rows = await db.all('SELECT id, name FROM contact_tags').catch(() => [])
  const legacyRows = rows.filter((row) => UUID_TAG_ID.test(String(row.id)))
  if (!legacyRows.length) return

  const taken = new Set(rows.map((row) => row.id))
  const renames = []
  for (const row of legacyRows) {
    const newId = uniqueTagSlug(row.name, taken)
    taken.delete(row.id)
    taken.add(newId)
    renames.push({ oldId: row.id, newId })
  }

  for (const { oldId, newId } of renames) {
    await db.run('UPDATE contact_tags SET id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [newId, oldId])
  }

  // contacts.tags: reemplazar ID viejo → slug en cada array
  for (const { oldId, newId } of renames) {
    const contacts = await db.all('SELECT id, tags FROM contacts WHERE tags LIKE ?', [`%${oldId}%`]).catch(() => [])
    for (const contact of contacts) {
      let tags
      try {
        tags = JSON.parse(contact.tags)
      } catch {
        continue
      }
      if (!Array.isArray(tags)) continue
      const next = [...new Set(tags.map((value) => (value === oldId ? newId : value)))]
      await db.run('UPDATE contacts SET tags = ? WHERE id = ?', [JSON.stringify(next), contact.id])
    }
  }

  // Referencias guardadas en JSON: flujos de automatizaciones y reglas de los
  // agentes conversacionales (los uuid son únicos: el replace textual es seguro)
  const jsonTargets = [
    { table: 'automations', key: 'id', columns: ['flow'] },
    { table: 'conversational_agents', key: 'id', columns: ['entry_filters', 'success_extras', 'handoff_rules', 'required_data'] }
  ]
  for (const target of jsonTargets) {
    const tableRows = await db.all(`SELECT * FROM ${target.table}`).catch(() => [])
    for (const row of tableRows) {
      const updates = []
      const params = []
      for (const column of target.columns) {
        const raw = row[column]
        if (typeof raw !== 'string' || !raw) continue
        let next = raw
        for (const { oldId, newId } of renames) {
          if (next.includes(oldId)) next = next.split(oldId).join(newId)
        }
        if (next !== raw) {
          updates.push(`${column} = ?`)
          params.push(next)
        }
      }
      if (updates.length > 0) {
        params.push(row[target.key])
        await db.run(`UPDATE ${target.table} SET ${updates.join(', ')} WHERE ${target.key} = ?`, params)
      }
    }
  }

  logger.info(`IDs de etiquetas migrados a slugs legibles: ${renames.length} etiqueta${renames.length === 1 ? '' : 's'}`)
}

export async function runCoreSchemaBootstrap() {
  const startedAt = Date.now()
  let waitLogged = false

  while (true) {
    try {
      return await db.withAdvisoryLock(STARTUP_SCHEMA_LOCK_NAME, async (schemaDb) => {
        if (usePostgres) {
          await schemaDb.exec(`
            SET statement_timeout = '180s';
            SET lock_timeout = '60s';
          `)
        }

        try {
          return await initTablesUnlocked()
        } finally {
          if (usePostgres) {
            await schemaDb.exec('RESET statement_timeout; RESET lock_timeout;').catch((error) => {
              logger.warn(`[Esquema] No se pudieron restaurar los timeouts de sesión: ${error.message}`)
            })
          }
        }
      })
    } catch (error) {
      if (error?.code !== 'DATABASE_ADVISORY_LOCK_BUSY') throw error
      const elapsed = Date.now() - startedAt
      if (elapsed >= STARTUP_SCHEMA_LOCK_WAIT_MS) {
        throw Object.assign(new Error('Otra instancia no liberó a tiempo el candado de preparación del esquema.'), {
          code: 'STARTUP_SCHEMA_LOCK_TIMEOUT'
        })
      }
      if (!waitLogged) {
        waitLogged = true
        logger.info('[Esquema] Otra instancia está preparando la base; este arranque esperará sin duplicar trabajo.')
      }
      await sleep(500)
    }
  }
}

/**
 * Repara el hueco histórico donde un contacto en papelera podía recibir un
 * mensaje nuevo y reaparecer en Chats sin volver a estar disponible en su ficha.
 * Sólo reactiva cuando el inbound es posterior al deleted_at; un backfill viejo
 * jamás deshace una eliminación intencional.
 */
export async function repairSoftDeletedContactsWithNewInboundActivity() {
  const whatsappInboundSort = timestampSortExpression('COALESCE(message_timestamp, created_at)')
  const metaInboundSort = timestampSortExpression('COALESCE(message_timestamp, created_at)')
  const emailInboundSort = timestampSortExpression('COALESCE(message_timestamp, created_at)')
  const deletedAtSort = timestampSortExpression('c.deleted_at')
  const rows = await db.all(`
    SELECT
      c.id,
      c.deleted_at,
      CAST(c.deleted_at AS TEXT) AS deleted_at_token,
      MAX(activity.last_inbound_sort) AS last_inbound_sort
    FROM contacts c
    JOIN (
      SELECT contact_id, MAX(${whatsappInboundSort}) AS last_inbound_sort
      FROM whatsapp_api_messages
      WHERE contact_id IS NOT NULL AND LOWER(COALESCE(direction, '')) = 'inbound'
      GROUP BY contact_id
      UNION ALL
      SELECT contact_id, MAX(${metaInboundSort}) AS last_inbound_sort
      FROM meta_social_messages
      WHERE contact_id IS NOT NULL AND LOWER(COALESCE(direction, '')) = 'inbound'
      GROUP BY contact_id
      UNION ALL
      SELECT contact_id, MAX(${emailInboundSort}) AS last_inbound_sort
      FROM email_messages
      WHERE contact_id IS NOT NULL AND LOWER(COALESCE(direction, '')) = 'inbound'
      GROUP BY contact_id
    ) activity ON activity.contact_id = c.id
    WHERE c.deleted_at IS NOT NULL
    GROUP BY c.id, c.deleted_at
    HAVING ${deletedAtSort} > 0
       AND MAX(activity.last_inbound_sort) > ${deletedAtSort}
  `)

  let restored = 0
  for (const row of rows) {
    const result = await db.run(`
      UPDATE contacts
      SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND deleted_at IS NOT NULL
        AND CAST(deleted_at AS TEXT) = ?
    `, [row.id, row.deleted_at_token])
    if (Number(result?.changes || 0) > 0) restored += 1
  }

  if (restored > 0) {
    logger.success(`[Contactos] ${restored} contacto${restored === 1 ? '' : 's'} reactivado${restored === 1 ? '' : 's'} por mensajes posteriores a la papelera.`)
  }
  return { restored }
}

export async function runStartupDataMaintenance() {
  try {
    return await db.withAdvisoryLock('startup-data-maintenance', async () => {
      const reengagementRepairVersion = await getAppConfig(CONTACT_REENGAGEMENT_REPAIR_CONFIG_KEY).catch(() => '')
      if (reengagementRepairVersion !== CONTACT_REENGAGEMENT_REPAIR_VERSION) {
        logger.info('[Arranque] Reparando contactos que volvieron a escribir después de la papelera...')
        await repairSoftDeletedContactsWithNewInboundActivity()
        await setAppConfig(CONTACT_REENGAGEMENT_REPAIR_CONFIG_KEY, CONTACT_REENGAGEMENT_REPAIR_VERSION)
      }

      const appliedVersion = await getAppConfig(STARTUP_DATA_MAINTENANCE_CONFIG_KEY).catch(() => '')
      if (appliedVersion === STARTUP_DATA_MAINTENANCE_VERSION) {
        logger.info(`[Arranque] Mantenimiento histórico ${STARTUP_DATA_MAINTENANCE_VERSION} ya aplicado.`)
        return { skipped: true, version: STARTUP_DATA_MAINTENANCE_VERSION }
      }

      const tasks = [
        ['teléfonos principales', seedPrimaryContactPhoneNumbersInBatches],
        ['contrato neutral de WhatsApp', backfillWhatsAppProviderContractInBatches],
        ['campos internos de WhatsApp', cleanupWhatsAppApiSystemCustomFields],
        ['teléfonos canónicos', reconcileCanonicalContactPhones],
        ['IDs de HighLevel', backfillGhlContactIds],
        ['IDs históricos de WhatsApp', migrateWhatsAppContactIdsToRistak],
        ['contactos sociales divididos', mergeSplitSocialCommentContacts],
        ['etiquetas legacy', migrateLegacyContactTagsToCatalog],
        ['IDs legibles de etiquetas', migrateTagIdsToSlugs],
        ['etiquetas internas reservadas', cleanupReservedSystemContactTags]
      ]

      for (const [label, task] of tasks) {
        logger.info(`[Arranque] Mantenimiento en segundo plano: ${label}...`)
        await task()
        await sleep(50)
      }

      const firstAdBackfillVersion = await getAppConfig(WHATSAPP_API_FIRST_AD_BACKFILL_CONFIG_KEY).catch(() => '')
      if (firstAdBackfillVersion !== WHATSAPP_API_FIRST_AD_BACKFILL_VERSION) {
        logger.info('[Arranque] Reparando identidad y primera atribución de WhatsApp en segundo plano...')
        await repairWhatsAppApiContactIdentityFromMessages({ limit: 0 })
        await setAppConfig(WHATSAPP_API_FIRST_AD_BACKFILL_CONFIG_KEY, WHATSAPP_API_FIRST_AD_BACKFILL_VERSION)
      }

      await setAppConfig(STARTUP_DATA_MAINTENANCE_CONFIG_KEY, STARTUP_DATA_MAINTENANCE_VERSION)
      logger.success(`[Arranque] Mantenimiento histórico ${STARTUP_DATA_MAINTENANCE_VERSION} completado.`)
      return { skipped: false, version: STARTUP_DATA_MAINTENANCE_VERSION }
    }, { pinConnection: false })
  } catch (error) {
    if (error?.code === 'DATABASE_ADVISORY_LOCK_BUSY') {
      logger.info('[Arranque] Otra instancia ya ejecuta el mantenimiento histórico; se omite el duplicado.')
      return { skipped: true, reason: 'already-running' }
    }
    throw error
  }
}

// En produccion no bloqueamos el import completo con las migraciones:
// Render necesita que el proceso abra puerto rapido para no marcar el deploy
// como "no open ports detected". El servidor espera esta promesa antes de
// habilitar las rutas reales.
export const databaseReady = runCoreSchemaBootstrap()

if (process.env.NODE_ENV === 'production') {
  databaseReady.catch(() => {})
} else {
  await databaseReady
}

/**
 * Obtiene la configuración de HighLevel desde la base de datos
 */
export async function getHighLevelConfig() {
  return await db.get('SELECT * FROM highlevel_config LIMIT 1')
}

/**
 * Obtiene un valor de configuración global de la app
 */
export async function getAppConfig(key) {
  const row = await db.get('SELECT config_value FROM app_config WHERE config_key = ?', [key])
  return row ? row.config_value : null
}

/**
 * Guarda un valor de configuración global de la app
 */
export async function setAppConfig(key, value) {
  const normalizedValue = value === null || value === undefined
    ? null
    : typeof value === 'string'
      ? value
      : JSON.stringify(value)

  await db.run(`
    INSERT INTO app_config (config_key, config_value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(config_key) DO UPDATE SET
      config_value = excluded.config_value,
      updated_at = CURRENT_TIMESTAMP
  `, [key, normalizedValue])
}

// (MOB-006) Normaliza un valor de config igual que setAppConfig: string tal cual,
// resto a JSON; null/undefined -> null.
function normalizeAppConfigValue(value) {
  return value === null || value === undefined
    ? null
    : typeof value === 'string'
      ? value
      : JSON.stringify(value)
}

/**
 * (MOB-006) Obtiene el valor por-usuario de una clave. Si el usuario no tiene fila
 * propia, hace FALLBACK al valor global de app_config (así nadie pierde lo que ya
 * tenía: quien no ha personalizado hereda el default del tenant).
 */
export async function getUserAppConfig(userId, key) {
  const numericUserId = Number(userId)
  if (Number.isFinite(numericUserId)) {
    const row = await db.get(
      'SELECT config_value FROM user_app_config WHERE user_id = ? AND config_key = ?',
      [numericUserId, key]
    )
    if (row && row.config_value !== null && row.config_value !== undefined) {
      return row.config_value
    }
  }
  return getAppConfig(key)
}

/**
 * (MOB-006) Guarda (upsert) el valor por-usuario de una clave. Normaliza igual que
 * setAppConfig. El índice único (user_id, config_key) habilita el ON CONFLICT en
 * ambos motores.
 */
export async function setUserAppConfig(userId, key, value) {
  const numericUserId = Number(userId)
  const normalizedValue = normalizeAppConfigValue(value)

  await db.run(`
    INSERT INTO user_app_config (user_id, config_key, config_value, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, config_key) DO UPDATE SET
      config_value = excluded.config_value,
      updated_at = CURRENT_TIMESTAMP
  `, [numericUserId, key, normalizedValue])
}

/**
 * (MOB-006) Borra el override por-usuario de una clave para que el usuario vuelva a
 * heredar el valor global de app_config.
 */
export async function deleteUserAppConfig(userId, key) {
  const numericUserId = Number(userId)
  if (!Number.isFinite(numericUserId)) return
  await db.run(
    'DELETE FROM user_app_config WHERE user_id = ? AND config_key = ?',
    [numericUserId, key]
  )
}

/**
 * (MOB-006) Resuelve varias claves por-usuario de una sola pasada, con el mismo
 * fallback al global (para el GET batch del frontend).
 */
export async function getUserAppConfigMany(userId, keys = []) {
  const config = {}
  for (const key of keys) {
    config[key] = await getUserAppConfig(userId, key)
  }
  return config
}

/**
 * (MOB-006) Indica si el usuario tiene override propio (fila) para cada clave dada.
 * Sirve a la vista admin para diferenciar "Personal" vs "Heredado".
 */
export async function getUserAppConfigOverrideFlags(userId, keys = []) {
  const numericUserId = Number(userId)
  const flags = {}
  for (const key of keys) flags[key] = false
  if (!Number.isFinite(numericUserId) || keys.length === 0) return flags

  const placeholders = keys.map(() => '?').join(', ')
  const rows = await db.all(
    `SELECT config_key FROM user_app_config WHERE user_id = ? AND config_key IN (${placeholders})`,
    [numericUserId, ...keys]
  )
  for (const row of rows) flags[row.config_key] = true
  return flags
}

export { db }
