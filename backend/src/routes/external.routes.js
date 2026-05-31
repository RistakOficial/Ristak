import express from 'express'
import crypto from 'crypto'
import { db } from '../config/database.js'
import {
  getFunnelData,
  getMetrics as getDashboardMetrics,
  getTrafficSources
} from '../controllers/dashboardController.js'
import {
  getCampaignsReport,
  getContactsList,
  getContactsReport,
  getMetrics as getReportMetrics,
  getPaymentsReport,
  getSummary as getReportsSummary,
  getTransactionsList
} from '../controllers/reportsController.js'
import {
  getContactById,
  getContactJourney,
  getContacts,
  searchContacts
} from '../controllers/contactsController.js'
import {
  getTransactionById,
  getTransactionStats,
  getTransactionSummary,
  getTransactions
} from '../controllers/transactionsController.js'
import { requireApiToken } from '../middleware/apiTokenMiddleware.js'
import { getExternalApiAppId } from '../utils/apiTokens.js'
import { getGHLClient } from '../services/ghlClient.js'

const router = express.Router()
const SECRET_KEY_PATTERN = /(token|secret|password|authorization|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|database[_-]?url|encrypted|hash)/i
const SENSITIVE_TABLE_PATTERN = /^(highlevel_config|meta_config|ai_agent_config|app_config|oauth_clients|oauth_authorization_codes|oauth_refresh_tokens)$/i
const WRITE_BLOCKED_TABLE_PATTERN = /^(users|payment_methods)$/i
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function getRequestOrigin(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https'
  const host = req.get('x-forwarded-host') || req.get('host')
  return host ? `${proto}://${host}` : ''
}

function sanitizeForExternal(value, key = '') {
  if (SECRET_KEY_PATTERN.test(String(key || ''))) return '[redacted]'
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => sanitizeForExternal(item))

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeForExternal(entryValue, entryKey)
    ])
  )
}

function isSafeIdentifier(value) {
  return SAFE_IDENTIFIER_PATTERN.test(String(value || ''))
}

function quoteIdentifier(value) {
  if (!isSafeIdentifier(value)) throw new Error(`Identificador inválido: ${value}`)
  return `"${value.replace(/"/g, '""')}"`
}

function isSensitiveTable(name) {
  return SENSITIVE_TABLE_PATTERN.test(String(name || ''))
}

function isWriteBlockedTable(name) {
  return WRITE_BLOCKED_TABLE_PATTERN.test(String(name || ''))
}

function isSecretColumn(name) {
  return SECRET_KEY_PATTERN.test(String(name || ''))
}

async function getDatabaseTableNames() {
  try {
    const rows = await db.all(`
      SELECT table_name AS name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `)

    if (Array.isArray(rows)) return rows.map(row => row.name).filter(Boolean)
  } catch (error) {
    // SQLite fallback below.
  }

  const rows = await db.all(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `)

  return rows.map(row => row.name).filter(Boolean)
}

async function getDatabaseColumns(table) {
  if (!isSafeIdentifier(table)) throw new Error('Tabla inválida')

  try {
    const rows = await db.all(
      `SELECT column_name AS name, data_type AS type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ?
       ORDER BY ordinal_position`,
      [table]
    )

    if (Array.isArray(rows)) {
      return rows.map(row => ({
        name: row.name,
        type: row.type || null,
        redacted: isSecretColumn(row.name)
      }))
    }
  } catch (error) {
    // SQLite fallback below.
  }

  const rows = await db.all(`PRAGMA table_info(${quoteIdentifier(table)})`)
  return rows.map(row => ({
    name: row.name,
    type: row.type || null,
    redacted: isSecretColumn(row.name)
  }))
}

async function getAccessibleDatabaseSchema() {
  const tableNames = await getDatabaseTableNames()
  const tables = []

  for (const tableName of tableNames) {
    if (!isSafeIdentifier(tableName) || isSensitiveTable(tableName)) continue
    const columns = await getDatabaseColumns(tableName)
    if (!columns.length) continue

    tables.push({
      name: tableName,
      columns,
      queryableColumns: columns.map(column => column.name),
      writableColumns: columns
        .filter(column => !column.redacted && column.name !== 'created_at' && column.name !== 'updated_at')
        .map(column => column.name),
      redactedColumns: columns.filter(column => column.redacted).map(column => column.name),
      canWrite: !isWriteBlockedTable(tableName)
    })
  }

  return tables
}

async function resolveAccessibleTable(table, { write = false } = {}) {
  const tableName = String(table || '').trim()
  if (!isSafeIdentifier(tableName) || isSensitiveTable(tableName)) {
    throw new Error('Tabla no permitida')
  }
  if (write && isWriteBlockedTable(tableName)) {
    throw new Error('Tabla bloqueada para escritura')
  }

  const schema = await getAccessibleDatabaseSchema()
  const config = schema.find(item => item.name === tableName)
  if (!config) throw new Error('Tabla no encontrada o no permitida')
  if (write && !config.canWrite) throw new Error('Tabla bloqueada para escritura')
  return config
}

function clampLimit(value, max = 500, fallback = 50) {
  return Math.min(Math.max(Number(value) || fallback, 1), max)
}

function writablePayload(body = {}, writableColumns = []) {
  const row = body?.data && typeof body.data === 'object' && !Array.isArray(body.data)
    ? body.data
    : body && typeof body === 'object' && !Array.isArray(body)
      ? body
      : {}

  return Object.fromEntries(
    Object.entries(row).filter(([key, value]) => writableColumns.includes(key) && value !== undefined)
  )
}

function splitName(value = '') {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean)
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' ')
  }
}

function normalizeContactPayload(body = {}) {
  const data = body?.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : body
  const fullName = data.full_name || data.name || [data.first_name, data.last_name].filter(Boolean).join(' ')
  const nameParts = splitName(fullName)

  return {
    id: data.id,
    full_name: fullName || '',
    first_name: data.first_name || nameParts.firstName,
    last_name: data.last_name || nameParts.lastName,
    email: data.email || '',
    phone: data.phone || '',
    source: data.source || 'external_api',
    attribution_ad_name: data.attribution_ad_name,
    attribution_ad_id: data.attribution_ad_id
  }
}

async function upsertLocalContact(contact = {}) {
  const id = contact.id || contact._id
  if (!id) throw new Error('No se pudo resolver el id del contacto')

  const firstName = contact.firstName || contact.first_name || splitName(contact.name || contact.full_name).firstName
  const lastName = contact.lastName || contact.last_name || splitName(contact.name || contact.full_name).lastName
  const fullName = contact.full_name || contact.name || [firstName, lastName].filter(Boolean).join(' ')

  await db.run(
    `INSERT INTO contacts (
       id, phone, email, full_name, first_name, last_name, source,
       attribution_ad_name, attribution_ad_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
     ON CONFLICT (id) DO UPDATE SET
       phone = excluded.phone,
       email = excluded.email,
       full_name = excluded.full_name,
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       source = excluded.source,
       attribution_ad_name = COALESCE(excluded.attribution_ad_name, contacts.attribution_ad_name),
       attribution_ad_id = COALESCE(excluded.attribution_ad_id, contacts.attribution_ad_id),
       updated_at = CURRENT_TIMESTAMP`,
    [
      id,
      contact.phone || null,
      contact.email || null,
      fullName || null,
      firstName || null,
      lastName || null,
      contact.source || 'external_api',
      contact.attribution_ad_name || null,
      contact.attribution_ad_id || null,
      contact.createdAt || contact.dateAdded || contact.created_at || null
    ]
  )

  return db.get('SELECT * FROM contacts WHERE id = ?', [id])
}

function normalizeGhlApiPath(path) {
  const normalizedPath = String(path || '').trim()
  if (!normalizedPath.startsWith('/') || normalizedPath.startsWith('//') || normalizedPath.includes('..') || /^https?:\/\//i.test(normalizedPath)) {
    throw new Error('Path de GoHighLevel inválido')
  }
  return normalizedPath
}

async function getOpenApiSpec(req, res) {
  try {
    const origin = getRequestOrigin(req)
    const appId = await getExternalApiAppId()

    res.json({
    openapi: '3.1.0',
    info: {
      title: 'Ristak External API',
      version: '1.0.0',
      description: 'API autenticada para consultar y modificar datos de Ristak desde sistemas externos autorizados, con sincronización hacia GoHighLevel cuando el recurso tiene espejo.'
    },
    'x-ristak-app-id': appId,
    servers: origin ? [{ url: origin }] : undefined,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'Ristak API token'
        }
      },
      schemas: {
        ApiEnvelope: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: ['object', 'array', 'null'] },
            error: { type: 'string' }
          }
        }
      }
    },
    security: [{ bearerAuth: [] }],
    paths: {
      '/api/external/me': {
        get: {
          operationId: 'getAuthenticatedRistakUser',
          summary: 'Obtiene el usuario ligado al API token',
          responses: {
            200: { description: 'Usuario autenticado' },
            401: { description: 'API token inválido' }
          }
        }
      },
      '/api/external/data/tables': {
        get: {
          operationId: 'listRistakDataTables',
          summary: 'Lista tablas y columnas disponibles para integración externa',
          responses: { 200: { description: 'Tablas disponibles' } }
        }
      },
      '/api/external/data/{table}': {
        get: {
          operationId: 'queryRistakDataTable',
          summary: 'Consulta filas de una tabla de Ristak con filtros y paginación',
          parameters: [
            { name: 'table', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
            { name: 'search', in: 'query', schema: { type: 'string' } },
            { name: 'orderBy', in: 'query', schema: { type: 'string' } },
            { name: 'orderDirection', in: 'query', schema: { type: 'string', enum: ['ASC', 'DESC'] } }
          ],
          responses: { 200: { description: 'Filas de la tabla' } }
        },
        post: {
          operationId: 'createRistakDataRow',
          summary: 'Crea una fila. En contacts sincroniza primero con GoHighLevel y guarda el espejo local',
          parameters: [
            { name: 'table', in: 'path', required: true, schema: { type: 'string' } }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', additionalProperties: true }
              }
            }
          },
          responses: { 201: { description: 'Fila creada' } }
        }
      },
      '/api/external/data/{table}/{id}': {
        get: {
          operationId: 'getRistakDataRow',
          summary: 'Obtiene una fila por id o keyColumn',
          parameters: [
            { name: 'table', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'keyColumn', in: 'query', schema: { type: 'string', default: 'id' } }
          ],
          responses: { 200: { description: 'Fila encontrada' }, 404: { description: 'Fila no encontrada' } }
        },
        put: {
          operationId: 'replaceRistakDataRow',
          summary: 'Actualiza una fila. En contacts sincroniza con GoHighLevel antes de guardar local',
          parameters: [
            { name: 'table', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'keyColumn', in: 'query', schema: { type: 'string', default: 'id' } }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', additionalProperties: true }
              }
            }
          },
          responses: { 200: { description: 'Fila actualizada' } }
        },
        patch: {
          operationId: 'patchRistakDataRow',
          summary: 'Actualiza parcialmente una fila. En contacts sincroniza con GoHighLevel antes de guardar local',
          parameters: [
            { name: 'table', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'keyColumn', in: 'query', schema: { type: 'string', default: 'id' } }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', additionalProperties: true }
              }
            }
          },
          responses: { 200: { description: 'Fila actualizada' } }
        },
        delete: {
          operationId: 'deleteRistakDataRow',
          summary: 'Elimina una fila. En contacts elimina primero en GoHighLevel y después el espejo local',
          parameters: [
            { name: 'table', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'keyColumn', in: 'query', schema: { type: 'string', default: 'id' } }
          ],
          responses: { 200: { description: 'Fila eliminada' } }
        }
      },
      '/api/external/highlevel/request': {
        post: {
          operationId: 'proxyGoHighLevelApiRequest',
          summary: 'Ejecuta una petición arbitraria a la API de GoHighLevel usando Ristak como intermediario',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['path'],
                  properties: {
                    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
                    path: { type: 'string', description: 'Ruta bajo services.leadconnectorhq.com, por ejemplo /contacts/search' },
                    params: { type: 'object', additionalProperties: true },
                    body: { type: 'object', additionalProperties: true },
                    version: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: { 200: { description: 'Respuesta de GoHighLevel' } }
        }
      },
      '/api/external/dashboard/metrics': {
        get: {
          operationId: 'getRistakDashboardMetrics',
          summary: 'Consulta métricas generales del dashboard',
          parameters: [
            { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } }
          ],
          responses: { 200: { description: 'Métricas del dashboard' } }
        }
      },
      '/api/external/dashboard/funnel': {
        get: {
          operationId: 'getRistakDashboardFunnel',
          summary: 'Consulta el embudo de conversión',
          parameters: [
            { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } }
          ],
          responses: { 200: { description: 'Datos del embudo' } }
        }
      },
      '/api/external/dashboard/traffic-sources': {
        get: {
          operationId: 'getRistakTrafficSources',
          summary: 'Consulta fuentes de tráfico',
          parameters: [
            { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } }
          ],
          responses: { 200: { description: 'Fuentes de tráfico' } }
        }
      },
      '/api/external/reports/summary': {
        get: {
          operationId: 'getRistakReportsSummary',
          summary: 'Consulta resumen consolidado de contactos, pagos y campañas',
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'scope', in: 'query', schema: { type: 'string', enum: ['all', 'paid', 'organic'] } }
          ],
          responses: { 200: { description: 'Resumen consolidado' } }
        }
      },
      '/api/external/reports/metrics': {
        get: {
          operationId: 'getRistakReportMetrics',
          summary: 'Consulta métricas por periodo',
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'groupBy', in: 'query', schema: { type: 'string', enum: ['day', 'week', 'month'] } }
          ],
          responses: { 200: { description: 'Métricas por periodo' } }
        }
      },
      '/api/external/reports/contacts': {
        get: {
          operationId: 'getRistakContactsReport',
          summary: 'Consulta reporte de contactos',
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'groupBy', in: 'query', schema: { type: 'string', enum: ['day', 'week', 'month'] } }
          ],
          responses: { 200: { description: 'Reporte de contactos' } }
        }
      },
      '/api/external/reports/payments': {
        get: {
          operationId: 'getRistakPaymentsReport',
          summary: 'Consulta reporte de pagos',
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }
          ],
          responses: { 200: { description: 'Reporte de pagos' } }
        }
      },
      '/api/external/reports/campaigns': {
        get: {
          operationId: 'getRistakCampaignsReport',
          summary: 'Consulta reporte de campañas',
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }
          ],
          responses: { 200: { description: 'Reporte de campañas' } }
        }
      },
      '/api/external/reports/contacts/list': {
        get: {
          operationId: 'getRistakContactsListReport',
          summary: 'Consulta lista filtrada de contactos para reportes',
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'type', in: 'query', schema: { type: 'string' } }
          ],
          responses: { 200: { description: 'Lista de contactos' } }
        }
      },
      '/api/external/reports/transactions': {
        get: {
          operationId: 'getRistakTransactionsListReport',
          summary: 'Consulta lista de transacciones exitosas para reportes',
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }
          ],
          responses: { 200: { description: 'Lista de transacciones' } }
        }
      },
      '/api/external/contacts': {
        get: {
          operationId: 'listRistakContacts',
          summary: 'Lista contactos con paginación y filtros',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
            { name: 'search', in: 'query', schema: { type: 'string' } },
            { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } }
          ],
          responses: { 200: { description: 'Contactos' } }
        },
        post: {
          operationId: 'createRistakContact',
          summary: 'Crea un contacto en GoHighLevel y guarda el espejo local en Ristak',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    full_name: { type: 'string' },
                    email: { type: 'string' },
                    phone: { type: 'string' },
                    source: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: { 201: { description: 'Contacto creado y sincronizado' } }
        }
      },
      '/api/external/contacts/search': {
        get: {
          operationId: 'searchRistakContacts',
          summary: 'Busca contactos por nombre, email o teléfono',
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' } }
          ],
          responses: { 200: { description: 'Resultados de búsqueda' } }
        }
      },
      '/api/external/contacts/{id}': {
        get: {
          operationId: 'getRistakContactById',
          summary: 'Obtiene detalle de un contacto',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
          ],
          responses: { 200: { description: 'Contacto' }, 404: { description: 'Contacto no encontrado' } }
        },
        put: {
          operationId: 'updateRistakContact',
          summary: 'Actualiza un contacto en GoHighLevel y en Ristak',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', additionalProperties: true }
              }
            }
          },
          responses: { 200: { description: 'Contacto actualizado' }, 404: { description: 'Contacto no encontrado' } }
        },
        patch: {
          operationId: 'patchRistakContact',
          summary: 'Actualiza parcialmente un contacto en GoHighLevel y en Ristak',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', additionalProperties: true }
              }
            }
          },
          responses: { 200: { description: 'Contacto actualizado' }, 404: { description: 'Contacto no encontrado' } }
        },
        delete: {
          operationId: 'deleteRistakContact',
          summary: 'Elimina un contacto en GoHighLevel y en Ristak',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
          ],
          responses: { 200: { description: 'Contacto eliminado' }, 404: { description: 'Contacto no encontrado' } }
        }
      },
      '/api/external/contacts/{id}/journey': {
        get: {
          operationId: 'getRistakContactJourney',
          summary: 'Obtiene el journey de un contacto',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
          ],
          responses: { 200: { description: 'Journey del contacto' } }
        }
      },
      '/api/external/transactions': {
        get: {
          operationId: 'listRistakTransactions',
          summary: 'Lista transacciones con paginación y filtros',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 5000 } },
            { name: 'status', in: 'query', schema: { type: 'string' } },
            { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } }
          ],
          responses: { 200: { description: 'Transacciones' } }
        }
      },
      '/api/external/transactions/stats': {
        get: {
          operationId: 'getRistakTransactionStats',
          summary: 'Consulta estadísticas de transacciones',
          parameters: [
            { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } }
          ],
          responses: { 200: { description: 'Estadísticas de transacciones' } }
        }
      },
      '/api/external/transactions/summary': {
        get: {
          operationId: 'getRistakTransactionSummary',
          summary: 'Consulta resumen financiero de transacciones',
          parameters: [
            { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' } }
          ],
          responses: { 200: { description: 'Resumen de transacciones' } }
        }
      },
      '/api/external/transactions/{id}': {
        get: {
          operationId: 'getRistakTransactionById',
          summary: 'Obtiene detalle de una transacción',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
          ],
          responses: { 200: { description: 'Transacción' }, 404: { description: 'Transacción no encontrada' } }
        }
      }
    }
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'No se pudo generar el schema OpenAPI'
    })
  }
}

router.get('/openapi.json', getOpenApiSpec)

router.use(requireApiToken)

async function listDataTables(req, res) {
  try {
    const tables = await getAccessibleDatabaseSchema()
    res.json({
      success: true,
      data: tables.map(table => ({
        name: table.name,
        columns: table.columns,
        writableColumns: table.writableColumns,
        redactedColumns: table.redactedColumns,
        canWrite: table.canWrite,
        sync: table.name === 'contacts'
          ? { provider: 'highlevel', mode: 'write-through' }
          : { provider: 'local', mode: 'local-only' }
      }))
    })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
}

async function queryDataTable(req, res) {
  try {
    const config = await resolveAccessibleTable(req.params.table)
    const limit = clampLimit(req.query.limit, 500, 50)
    const offset = Math.max(Number(req.query.offset) || 0, 0)
    const params = []
    const conditions = []
    const exposedColumns = config.queryableColumns.filter(column => !config.redactedColumns.includes(column))
    const reserved = new Set(['limit', 'offset', 'search', 'orderBy', 'orderDirection', 'keyColumn'])

    for (const [key, value] of Object.entries(req.query)) {
      if (reserved.has(key) || !exposedColumns.includes(key)) continue
      conditions.push(`${quoteIdentifier(key)} = ?`)
      params.push(value)
    }

    const search = String(req.query.search || '').trim()
    if (search && exposedColumns.length) {
      conditions.push(`(${exposedColumns.map(column => `CAST(${quoteIdentifier(column)} AS TEXT) LIKE ?`).join(' OR ')})`)
      params.push(...exposedColumns.map(() => `%${search}%`))
    }

    const sortableColumns = exposedColumns.length ? exposedColumns : config.queryableColumns
    const fallbackOrder = sortableColumns.includes('created_at')
      ? 'created_at'
      : sortableColumns.includes('updated_at')
        ? 'updated_at'
        : sortableColumns[0]
    const orderBy = sortableColumns.includes(req.query.orderBy) ? req.query.orderBy : fallbackOrder
    const orderDirection = String(req.query.orderDirection || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const [rows, countRow] = await Promise.all([
      db.all(
        `SELECT ${config.queryableColumns.map(quoteIdentifier).join(', ')}
         FROM ${quoteIdentifier(config.name)}
         ${whereClause}
         ORDER BY ${quoteIdentifier(orderBy)} ${orderDirection}
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      ),
      db.get(
        `SELECT COUNT(*) AS total
         FROM ${quoteIdentifier(config.name)}
         ${whereClause}`,
        params
      )
    ])

    res.json({
      success: true,
      data: sanitizeForExternal(rows),
      meta: {
        table: config.name,
        columns: config.queryableColumns,
        redactedColumns: config.redactedColumns,
        pagination: {
          limit,
          offset,
          total: Number(countRow?.total || 0)
        }
      }
    })
  } catch (error) {
    res.status(400).json({ success: false, error: error.message })
  }
}

async function getDataRow(req, res) {
  try {
    const config = await resolveAccessibleTable(req.params.table)
    const keyColumn = String(req.query.keyColumn || 'id')
    if (!config.queryableColumns.includes(keyColumn) || config.redactedColumns.includes(keyColumn)) {
      return res.status(400).json({ success: false, error: 'keyColumn no permitido' })
    }

    const row = await db.get(
      `SELECT ${config.queryableColumns.map(quoteIdentifier).join(', ')}
       FROM ${quoteIdentifier(config.name)}
       WHERE ${quoteIdentifier(keyColumn)} = ?`,
      [req.params.id]
    )

    if (!row) return res.status(404).json({ success: false, error: 'Fila no encontrada' })
    res.json({ success: true, data: sanitizeForExternal(row) })
  } catch (error) {
    res.status(400).json({ success: false, error: error.message })
  }
}

async function createExternalContact(req, res) {
  try {
    const payload = normalizeContactPayload(req.body)
    if (!payload.full_name && !payload.email && !payload.phone) {
      return res.status(400).json({ success: false, error: 'full_name, email o phone requerido' })
    }

    const ghlClient = await getGHLClient()
    const ghlResult = await ghlClient.createContact({
      name: payload.full_name || payload.email || payload.phone,
      email: payload.email,
      phone: payload.phone
    })
    const ghlContact = ghlResult.contact || ghlResult
    const localContact = await upsertLocalContact({
      ...payload,
      ...ghlContact,
      id: ghlContact.id || payload.id
    })

    res.status(201).json({
      success: true,
      data: sanitizeForExternal(localContact),
      sync: {
        provider: 'highlevel',
        status: 'synced',
        id: ghlContact.id || payload.id
      }
    })
  } catch (error) {
    res.status(502).json({ success: false, error: `No se pudo sincronizar con GoHighLevel: ${error.message}` })
  }
}

async function createDataRow(req, res) {
  if (req.params.table === 'contacts') return createExternalContact(req, res)

  try {
    const config = await resolveAccessibleTable(req.params.table, { write: true })
    const payload = writablePayload(req.body, config.writableColumns)

    if (config.writableColumns.includes('id') && !payload.id) {
      payload.id = crypto.randomUUID()
    }

    const columns = Object.keys(payload)
    if (!columns.length) {
      return res.status(400).json({ success: false, error: 'No hay campos permitidos para crear' })
    }

    await db.run(
      `INSERT INTO ${quoteIdentifier(config.name)} (${columns.map(quoteIdentifier).join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map(column => payload[column])
    )

    const keyColumn = config.queryableColumns.includes('id') ? 'id' : columns[0]
    const row = await db.get(
      `SELECT ${config.queryableColumns.map(quoteIdentifier).join(', ')}
       FROM ${quoteIdentifier(config.name)}
       WHERE ${quoteIdentifier(keyColumn)} = ?`,
      [payload[keyColumn]]
    )

    res.status(201).json({
      success: true,
      data: sanitizeForExternal(row || payload),
      sync: { provider: 'local', status: 'local-only' }
    })
  } catch (error) {
    res.status(400).json({ success: false, error: error.message })
  }
}

async function updateExternalContact(req, res) {
  try {
    const { id } = req.params
    const existing = await db.get('SELECT * FROM contacts WHERE id = ?', [id])
    if (!existing) return res.status(404).json({ success: false, error: 'Contacto no encontrado' })

    const source = req.body?.data && typeof req.body.data === 'object' ? req.body.data : req.body
    const payload = normalizeContactPayload({ ...existing, ...source, id })
    const ghlUpdateData = {}

    if (source.full_name !== undefined || source.name !== undefined || source.first_name !== undefined || source.last_name !== undefined) {
      ghlUpdateData.name = payload.full_name
    }
    if (source.email !== undefined) ghlUpdateData.email = payload.email
    if (source.phone !== undefined) ghlUpdateData.phone = payload.phone
    if (source.source !== undefined) ghlUpdateData.source = payload.source
    if (source.tags !== undefined) ghlUpdateData.tags = source.tags
    if (source.customFields !== undefined) ghlUpdateData.customFields = source.customFields
    if (source.dnd !== undefined) {
      ghlUpdateData.dnd = source.dnd
      if (source.dndSettings !== undefined) ghlUpdateData.dndSettings = source.dndSettings
    }

    if (!Object.keys(ghlUpdateData).length) {
      return res.status(400).json({ success: false, error: 'No hay campos permitidos para actualizar' })
    }

    const ghlClient = await getGHLClient()
    const ghlResult = await ghlClient.updateContact(id, ghlUpdateData)
    const ghlContact = ghlResult.contact || ghlResult
    const localContact = await upsertLocalContact({
      ...existing,
      ...payload,
      ...ghlContact,
      id
    })

    res.json({
      success: true,
      data: sanitizeForExternal(localContact),
      sync: { provider: 'highlevel', status: 'synced', id }
    })
  } catch (error) {
    res.status(502).json({ success: false, error: `No se pudo sincronizar con GoHighLevel: ${error.message}` })
  }
}

async function updateDataRow(req, res) {
  if (req.params.table === 'contacts') return updateExternalContact(req, res)

  try {
    const config = await resolveAccessibleTable(req.params.table, { write: true })
    const keyColumn = String(req.query.keyColumn || 'id')
    if (!config.queryableColumns.includes(keyColumn) || config.redactedColumns.includes(keyColumn)) {
      return res.status(400).json({ success: false, error: 'keyColumn no permitido' })
    }

    const payload = writablePayload(req.body, config.writableColumns)
    delete payload[keyColumn]
    const columns = Object.keys(payload)

    if (!columns.length) {
      return res.status(400).json({ success: false, error: 'No hay campos permitidos para actualizar' })
    }

    const updates = columns.map(column => `${quoteIdentifier(column)} = ?`)
    if (config.queryableColumns.includes('updated_at')) updates.push('updated_at = CURRENT_TIMESTAMP')

    const result = await db.run(
      `UPDATE ${quoteIdentifier(config.name)}
       SET ${updates.join(', ')}
       WHERE ${quoteIdentifier(keyColumn)} = ?`,
      [...columns.map(column => payload[column]), req.params.id]
    )

    if (!result.changes) return res.status(404).json({ success: false, error: 'Fila no encontrada' })

    const row = await db.get(
      `SELECT ${config.queryableColumns.map(quoteIdentifier).join(', ')}
       FROM ${quoteIdentifier(config.name)}
       WHERE ${quoteIdentifier(keyColumn)} = ?`,
      [req.params.id]
    )

    res.json({
      success: true,
      data: sanitizeForExternal(row),
      sync: { provider: 'local', status: 'local-only' }
    })
  } catch (error) {
    res.status(400).json({ success: false, error: error.message })
  }
}

async function deleteExternalContact(req, res) {
  try {
    const { id } = req.params
    const existing = await db.get('SELECT id, full_name FROM contacts WHERE id = ?', [id])
    if (!existing) return res.status(404).json({ success: false, error: 'Contacto no encontrado' })

    const ghlClient = await getGHLClient()
    await ghlClient.deleteContact(id)
    await db.run('DELETE FROM contacts WHERE id = ?', [id])

    res.json({
      success: true,
      data: sanitizeForExternal(existing),
      sync: { provider: 'highlevel', status: 'synced', id }
    })
  } catch (error) {
    res.status(502).json({ success: false, error: `No se pudo sincronizar con GoHighLevel: ${error.message}` })
  }
}

async function deleteDataRow(req, res) {
  if (req.params.table === 'contacts') return deleteExternalContact(req, res)

  try {
    const config = await resolveAccessibleTable(req.params.table, { write: true })
    const keyColumn = String(req.query.keyColumn || 'id')
    if (!config.queryableColumns.includes(keyColumn) || config.redactedColumns.includes(keyColumn)) {
      return res.status(400).json({ success: false, error: 'keyColumn no permitido' })
    }

    const existing = await db.get(
      `SELECT ${config.queryableColumns.map(quoteIdentifier).join(', ')}
       FROM ${quoteIdentifier(config.name)}
       WHERE ${quoteIdentifier(keyColumn)} = ?`,
      [req.params.id]
    )
    if (!existing) return res.status(404).json({ success: false, error: 'Fila no encontrada' })

    await db.run(
      `DELETE FROM ${quoteIdentifier(config.name)}
       WHERE ${quoteIdentifier(keyColumn)} = ?`,
      [req.params.id]
    )

    res.json({
      success: true,
      data: sanitizeForExternal(existing),
      sync: { provider: 'local', status: 'local-only' }
    })
  } catch (error) {
    res.status(400).json({ success: false, error: error.message })
  }
}

async function proxyHighLevelRequest(req, res) {
  try {
    const method = String(req.body.method || 'GET').toUpperCase()
    const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
    if (!allowedMethods.has(method)) {
      return res.status(400).json({ success: false, error: 'Método no permitido' })
    }

    const path = normalizeGhlApiPath(req.body.path)
    const ghlClient = await getGHLClient()
    const data = await ghlClient.request(path, {
      method,
      params: req.body.params || undefined,
      body: req.body.body || undefined,
      version: req.body.version || undefined
    })

    res.json({
      success: true,
      data: sanitizeForExternal(data),
      sync: {
        provider: 'highlevel',
        status: 'proxied',
        note: 'La petición se ejecutó directo contra GoHighLevel. El espejo local se actualizará por webhooks/sync cuando aplique.'
      }
    })
  } catch (error) {
    res.status(502).json({ success: false, error: `No se pudo ejecutar en GoHighLevel: ${error.message}` })
  }
}

router.get('/me', async (req, res) => {
  try {
    res.json({
      success: true,
      appId: await getExternalApiAppId(),
      user: req.apiUser
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'No se pudo obtener el usuario autenticado'
    })
  }
})

router.get('/data/tables', listDataTables)
router.get('/data/:table', queryDataTable)
router.post('/data/:table', createDataRow)
router.get('/data/:table/:id', getDataRow)
router.put('/data/:table/:id', updateDataRow)
router.patch('/data/:table/:id', updateDataRow)
router.delete('/data/:table/:id', deleteDataRow)

router.post('/highlevel/request', proxyHighLevelRequest)

router.get('/dashboard/metrics', getDashboardMetrics)
router.get('/dashboard/funnel', getFunnelData)
router.get('/dashboard/traffic-sources', getTrafficSources)

router.get('/reports/summary', getReportsSummary)
router.get('/reports/metrics', getReportMetrics)
router.get('/reports/contacts', getContactsReport)
router.get('/reports/payments', getPaymentsReport)
router.get('/reports/campaigns', getCampaignsReport)
router.get('/reports/contacts/list', getContactsList)
router.get('/reports/transactions', getTransactionsList)

router.get('/contacts/search', searchContacts)
router.post('/contacts', createExternalContact)
router.put('/contacts/:id', updateExternalContact)
router.patch('/contacts/:id', updateExternalContact)
router.delete('/contacts/:id', deleteExternalContact)
router.get('/contacts/:id/journey', getContactJourney)
router.get('/contacts/:id', getContactById)
router.get('/contacts', getContacts)

router.get('/transactions/stats', getTransactionStats)
router.get('/transactions/summary', getTransactionSummary)
router.get('/transactions/:id', getTransactionById)
router.get('/transactions', getTransactions)

export default router
