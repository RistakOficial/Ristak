import { tool } from '@openai/agents'
import { z } from 'zod'
import { db } from '../../config/database.js'

const MAX_QUERY_ROWS = 200
const MAX_CATALOG_TABLES = 120
const MAX_COLUMNS_PER_TABLE = 80
const isPostgres = Boolean(process.env.DATABASE_URL)

const SENSITIVE_TABLE_PATTERN = /^(highlevel_config|meta_config|meta_campaign_templates|meta_campaign_drafts|meta_campaign_execution_logs|ai_agent_config|ai_agent_user_preferences|agent_runs|agent_steps|agent_pending_actions|agent_tool_idempotency|app_config|oauth_clients|oauth_authorization_codes|oauth_refresh_tokens|users|payment_methods)$/i
const SENSITIVE_TABLE_TOKEN_PATTERN = /\b(highlevel_config|meta_config|ai_agent_config|ai_agent_user_preferences|agent_runs|agent_steps|agent_pending_actions|agent_tool_idempotency|app_config|oauth_clients|oauth_authorization_codes|oauth_refresh_tokens|users|payment_methods)\b/i
const SENSITIVE_COLUMN_PATTERN = /\b(api_token|access_token|refresh_token|client_secret|password|secret|authorization|openai_api_key_encrypted|encrypted|subscription_json)\b/i
const BLOCKED_SQL_PATTERN = /\b(insert|update|delete|drop|alter|truncate|create|replace|merge|grant|revoke|copy|call|do|execute|vacuum|set|reset)\b/i
const UNRESOLVED_PARAM_PATTERN = /\b(start_date|end_date|start_ts|end_ts|from_date|to_date|fecha_inicio|fecha_fin|date_from|date_to)\b/i

function normalizeIdentifier(value) {
  return String(value || '').replace(/^"|"$/g, '').trim()
}

function quoteIdentifier(value) {
  const identifier = normalizeIdentifier(value)
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error('Identificador de tabla no válido')
  }
  return `"${identifier.replace(/"/g, '""')}"`
}

function isSensitiveTableName(tableName) {
  return SENSITIVE_TABLE_PATTERN.test(normalizeIdentifier(tableName))
}

function isSensitiveColumnName(columnName) {
  return SENSITIVE_COLUMN_PATTERN.test(normalizeIdentifier(columnName))
}

function stripTrailingSemicolon(sql) {
  return String(sql || '').trim().replace(/;\s*$/, '').trim()
}

export function validateReadOnlyBusinessSql(sql, params = []) {
  const normalizedSql = stripTrailingSemicolon(sql)

  if (!normalizedSql) {
    throw new Error('SQL vacío')
  }

  if (!/^(select|with)\b/i.test(normalizedSql)) {
    throw new Error('Sólo se permiten consultas SELECT o WITH ... SELECT')
  }

  if (/;/.test(normalizedSql)) {
    throw new Error('Sólo se permite una consulta por ejecución')
  }

  if (/--|\/\*/.test(normalizedSql)) {
    throw new Error('No se permiten comentarios SQL')
  }

  if (BLOCKED_SQL_PATTERN.test(normalizedSql)) {
    throw new Error('La consulta contiene una operación no permitida')
  }

  if (SENSITIVE_TABLE_TOKEN_PATTERN.test(normalizedSql)) {
    throw new Error('Esa tabla no está disponible para el agente')
  }

  if (SENSITIVE_COLUMN_PATTERN.test(normalizedSql)) {
    throw new Error('Esa columna no está disponible para el agente')
  }

  if (!Array.isArray(params)) {
    throw new Error('params debe ser un arreglo')
  }

  if (params.length > 25) {
    throw new Error('Demasiados parámetros en la consulta')
  }

  for (const param of params) {
    const type = typeof param
    if (param !== null && !['string', 'number', 'boolean'].includes(type)) {
      throw new Error('Los parámetros sólo pueden ser string, number, boolean o null')
    }

    if (type === 'string' && UNRESOLVED_PARAM_PATTERN.test(param.trim())) {
      throw new Error('La consulta dejó un placeholder de fecha sin resolver')
    }
  }

  return normalizedSql
}

export function withAgentRowLimit(sql, limit = MAX_QUERY_ROWS) {
  const safeLimit = Math.min(Math.max(Number(limit) || MAX_QUERY_ROWS, 1), MAX_QUERY_ROWS)
  if (/\blimit\s+\d+\b/i.test(sql) || /\bfetch\s+first\s+\d+\s+rows\b/i.test(sql)) {
    return sql
  }
  return `${sql} LIMIT ${safeLimit}`
}

function redactSensitiveColumns(row = {}) {
  const next = {}
  for (const [key, value] of Object.entries(row || {})) {
    if (isSensitiveColumnName(key)) continue
    next[key] = value
  }
  return next
}

async function listPostgresTableNames() {
  const tables = await db.all(`
    SELECT table_name AS name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `)

  return tables.map((row) => row.name)
}

async function listSqliteTableNames() {
  const tables = await db.all(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `)

  return tables.map((row) => row.name)
}

async function getPostgresColumns(tableNames) {
  if (!tableNames.length) return []

  return db.all(`
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY(?::text[])
    ORDER BY table_name, ordinal_position
  `, [tableNames])
}

async function getSqliteColumns(tableNames) {
  const columns = []
  for (const tableName of tableNames) {
    const rows = await db.all(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
    for (const row of rows) {
      columns.push({
        table_name: tableName,
        column_name: row.name,
        data_type: row.type || 'unknown',
        is_nullable: row.notnull ? 'NO' : 'YES'
      })
    }
  }
  return columns
}

async function countTableRows(tableName) {
  try {
    const row = await db.get(`SELECT COUNT(*) AS total FROM ${quoteIdentifier(tableName)}`)
    return Number(row?.total || 0)
  } catch {
    return null
  }
}

export async function getDatabaseCatalog({ tableName = null } = {}) {
  const discoveredTables = isPostgres ? await listPostgresTableNames() : await listSqliteTableNames()
  const allTables = discoveredTables.filter((name) => !isSensitiveTableName(name))
  const normalizedTableName = normalizeIdentifier(tableName)
  const tableNames = normalizedTableName
    ? allTables.filter((name) => name === normalizedTableName)
    : allTables.slice(0, MAX_CATALOG_TABLES)
  const columns = isPostgres ? await getPostgresColumns(tableNames) : await getSqliteColumns(tableNames)
  const columnsByTable = new Map()

  for (const column of columns) {
    if (isSensitiveColumnName(column.column_name)) continue
    const list = columnsByTable.get(column.table_name) || []
    if (list.length < MAX_COLUMNS_PER_TABLE) {
      list.push({
        name: column.column_name,
        type: column.data_type,
        nullable: column.is_nullable !== 'NO'
      })
    }
    columnsByTable.set(column.table_name, list)
  }

  const tables = []
  for (const name of tableNames) {
    tables.push({
      name,
      rowCount: await countTableRows(name),
      columns: columnsByTable.get(name) || []
    })
  }

  return {
    ok: true,
    database: isPostgres ? 'postgres' : 'sqlite',
    tableCount: allTables.length,
    hiddenSensitiveTables: discoveredTables.length - allTables.length,
    tables
  }
}

export const inspectDatabaseCatalogTool = tool({
  name: 'inspect_database_catalog',
  description: 'Muestra las tablas y columnas disponibles en la base de datos de Ristak. Úsala cuando no sepas qué tablas consultar o antes de comparar datos entre áreas. No expone tablas ni columnas sensibles.',
  parameters: z.object({
    tableName: z.string().nullable().describe('Tabla específica a inspeccionar; null para ver el catálogo general permitido.')
  }),
  execute: async ({ tableName }) => getDatabaseCatalog({ tableName })
})

export const runDatabaseQueryTool = tool({
  name: 'run_database_query',
  description: 'Ejecuta una consulta SQL de sólo lectura contra la DB real de Ristak para sumar, contar, comparar tablas, revisar columnas permitidas y responder con datos reales. Usa placeholders ? en params. No sirve para modificar datos.',
  parameters: z.object({
    name: z.string().nullable().describe('Nombre corto de la consulta para explicar qué investigaste.'),
    sql: z.string().describe('Consulta SELECT o WITH ... SELECT de sólo lectura. Usa placeholders ? para valores.'),
    params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).nullable().describe('Parámetros para los placeholders ? en el mismo orden.'),
    limit: z.number().int().min(1).max(MAX_QUERY_ROWS).nullable().describe('Límite de filas si el SQL no trae LIMIT. Máximo 200.')
  }),
  execute: async ({ name, sql, params, limit }) => {
    const safeParams = Array.isArray(params) ? params : []
    const safeSql = withAgentRowLimit(validateReadOnlyBusinessSql(sql, safeParams), limit || MAX_QUERY_ROWS)
    const rows = await db.all(safeSql, safeParams)

    return {
      ok: true,
      name: String(name || 'consulta_db').slice(0, 80),
      sql: safeSql,
      params: safeParams,
      rowCount: rows.length,
      rows: rows.slice(0, MAX_QUERY_ROWS).map(redactSensitiveColumns)
    }
  }
})

export const databaseReadTools = [inspectDatabaseCatalogTool, runDatabaseQueryTool]
