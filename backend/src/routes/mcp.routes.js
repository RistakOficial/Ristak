import express from 'express'
import { db } from '../config/database.js'
import {
  buildCampaignSummary,
  buildContactStats,
  buildTransactionSummary
} from '../services/analyticsService.js'
import * as calendarService from '../services/highlevelCalendarService.js'
import {
  createInstallmentPaymentFlow,
  createOfflineContactPayment,
  createSinglePaymentLink
} from '../services/paymentFlowService.js'
import { getGHLClient } from '../services/ghlClient.js'
import { getHighLevelConfig } from '../config/database.js'
import { verifyOAuthAccessToken } from '../utils/oauthTokens.js'
import { buildContactSearchClause, buildContactSearchRank } from '../utils/searchText.js'
import { nonTestPaymentCondition } from '../utils/paymentMode.js'
import { logger } from '../utils/logger.js'

const router = express.Router()
const HIGHLEVEL_MCP_SERVER_URL = process.env.GHL_MCP_SERVER_URL || 'https://services.leadconnectorhq.com/mcp/'
const GHL_MCP_TOOL_PREFIX = 'ghl_mcp__'
const MCP_PROTOCOL_VERSION = '2025-06-18'
const HIGHLEVEL_MCP_TIMEOUT_MS = 15000
const SECRET_KEY_PATTERN = /(token|secret|password|authorization|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|database[_-]?url|encrypted|hash)/i
const SENSITIVE_TABLE_PATTERN = /^(highlevel_config|meta_config|meta_campaign_templates|meta_campaign_drafts|meta_campaign_execution_logs|ai_agent_config|agent_runs|agent_steps|agent_pending_actions|agent_tool_idempotency|app_config|oauth_clients|oauth_authorization_codes|oauth_refresh_tokens)$/i
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function originFor(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https'
  const host = req.get('x-forwarded-host') || req.get('host')
  return host ? `${proto}://${host}` : ''
}

function resourceFor(req) {
  return `${originFor(req)}/api/mcp`
}

function metadataUrlFor(req) {
  return `${originFor(req)}/.well-known/oauth-protected-resource`
}

function requireMcpAuth(req, res, next) {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  const payload = verifyOAuthAccessToken(token, resourceFor(req))

  if (!payload) {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${metadataUrlFor(req)}"`)
    return res.status(401).json({
      error: 'unauthorized',
      error_description: 'OAuth access token requerido'
    })
  }

  req.mcpUser = {
    id: payload.userId,
    clientId: payload.clientId,
    scope: payload.scope
  }
  next()
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function sanitizeForExternal(value, key = '') {
  if (SECRET_KEY_PATTERN.test(String(key || ''))) {
    return '[redacted]'
  }

  if (!value || typeof value !== 'object') return value

  if (Array.isArray(value)) {
    return value.map(item => sanitizeForExternal(item))
  }

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeForExternal(entryValue, entryKey)
    ])
  )
}

function textResult(payload) {
  const sanitizedPayload = sanitizeForExternal(payload)

  return {
    structuredContent: sanitizedPayload,
    content: [
      {
        type: 'text',
        text: JSON.stringify(sanitizedPayload)
      }
    ]
  }
}

const toolDefinitions = [
  {
    name: 'get_summary',
    title: 'Get Ristak summary',
    description: 'Returns consolidated contact, payment, and campaign metrics for a date range.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date in YYYY-MM-DD format.' },
        to: { type: 'string', description: 'End date in YYYY-MM-DD format.' },
        scope: { type: 'string', enum: ['all', 'paid', 'organic'], default: 'all' }
      }
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
  },
  {
    name: 'search_contacts',
    title: 'Search Ristak contacts',
    description: 'Searches Ristak contacts by name, email, or phone.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 }
      },
      required: ['query']
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
  },
  {
    name: 'get_contact',
    title: 'Get Ristak contact',
    description: 'Returns one contact with recent payments and appointments.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }
      },
      required: ['id']
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
  },
  {
    name: 'list_transactions',
    title: 'List Ristak transactions',
    description: 'Returns recent payment transactions with optional date/status filters.',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format.' },
        endDate: { type: 'string', description: 'End date in YYYY-MM-DD format.' },
        status: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }
      }
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
  },
  {
    name: 'list_data_tables',
    title: 'List Ristak data tables',
    description: 'Lists every Ristak database table and column exposed to external systems. Secret/config tables are blocked and secret-like columns are redacted.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
  },
  {
    name: 'query_data_table',
    title: 'Query Ristak data table',
    description: 'Reads individual rows from any exposed Ristak database table with pagination, filtering, search, and ordering. Secret/config tables are blocked and secret-like columns are redacted.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        offset: { type: 'integer', minimum: 0, default: 0 },
        search: { type: 'string' },
        filters: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } },
        orderBy: { type: 'string' },
        orderDirection: { type: 'string', enum: ['ASC', 'DESC'], default: 'DESC' }
      },
      required: ['table']
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
  },
  {
    name: 'get_meta_ads_summary',
    title: 'Get Meta Ads summary',
    description: 'Returns Meta Ads spend, reach, clicks, CPC, CPM and CTR grouped by campaign, adset, ad, or day.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        groupBy: { type: 'string', enum: ['day', 'campaign', 'adset', 'ad'], default: 'campaign' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 }
      }
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
  },
  {
    name: 'ghl_search_contacts',
    title: 'Search GoHighLevel contacts',
    description: 'Searches contacts directly in GoHighLevel through Ristak.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 }
      }
    },
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false }
  },
  {
    name: 'ghl_create_contact',
    title: 'Create GoHighLevel contact',
    description: 'Creates a GoHighLevel contact through Ristak. Requires confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        confirm: { type: 'boolean' }
      },
      required: ['name', 'confirm']
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false }
  },
  {
    name: 'ghl_list_calendars',
    title: 'List GoHighLevel calendars',
    description: 'Lists GoHighLevel calendars configured for this Ristak instance.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false }
  },
  {
    name: 'ghl_get_free_slots',
    title: 'Get GoHighLevel free slots',
    description: 'Gets available appointment slots for a calendar.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string' },
        startDate: { type: 'string' },
        endDate: { type: 'string' },
        timezone: { type: 'string', default: 'America/Mexico_City' }
      },
      required: ['calendarId', 'startDate', 'endDate']
    },
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false }
  },
  {
    name: 'ghl_create_appointment',
    title: 'Create GoHighLevel appointment',
    description: 'Creates an appointment in GoHighLevel through Ristak. Requires confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string' },
        contactId: { type: 'string' },
        startTime: { type: 'string' },
        endTime: { type: 'string' },
        title: { type: 'string' },
        appointmentStatus: { type: 'string', enum: ['confirmed', 'cancelled', 'showed', 'noshow', 'pending'] },
        assignedUserId: { type: 'string' },
        address: { type: 'string' },
        notes: { type: 'string' },
        confirm: { type: 'boolean' }
      },
      required: ['calendarId', 'contactId', 'startTime', 'endTime', 'confirm']
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false }
  },
  {
    name: 'ghl_create_payment_link',
    title: 'Create GoHighLevel payment link',
    description: 'Creates and sends a GoHighLevel invoice/payment link through Ristak. Requires confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string', default: 'MXN' },
        concept: { type: 'string' },
        dueDate: { type: 'string' },
        channels: { type: 'object' },
        confirm: { type: 'boolean' }
      },
      required: ['contactId', 'amount', 'confirm']
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false }
  },
  {
    name: 'ghl_record_offline_payment',
    title: 'Record GoHighLevel offline payment',
    description: 'Creates an invoice and records an offline payment in GoHighLevel through Ristak. Requires confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string', default: 'MXN' },
        concept: { type: 'string' },
        paymentMethod: { type: 'string', enum: ['cash', 'bank_transfer', 'transfer', 'deposit', 'check', 'manual', 'other'] },
        paymentDate: { type: 'string' },
        reference: { type: 'string' },
        notes: { type: 'string' },
        confirm: { type: 'boolean' }
      },
      required: ['contactId', 'amount', 'confirm']
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false }
  },
  {
    name: 'ghl_create_installment_plan',
    title: 'Create GoHighLevel installment plan',
    description: 'Creates a Ristak/GoHighLevel installment payment flow. Requires confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        totalAmount: { type: 'number' },
        currency: { type: 'string', default: 'MXN' },
        concept: { type: 'string' },
        remainingPayments: { type: 'array', items: { type: 'object' } },
        firstPayment: { type: 'object' },
        firstPaymentEnabled: { type: 'boolean' },
        firstPaymentAmount: { type: 'number' },
        firstPaymentMethod: { type: 'string' },
        remainingAutomatic: { type: 'boolean' },
        confirm: { type: 'boolean' }
      },
      required: ['contactId', 'totalAmount', 'remainingPayments', 'confirm']
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false }
  },
  {
    name: 'ghl_api_request',
    title: 'GoHighLevel API request',
    description: 'Fallback request to any GoHighLevel API path through Ristak. Mutating methods require confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
        path: { type: 'string', description: 'Path under services.leadconnectorhq.com, for example /contacts/search.' },
        params: { type: 'object' },
        body: { type: 'object' },
        version: { type: 'string' },
        confirm: { type: 'boolean' }
      },
      required: ['path']
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true }
  },
  {
    name: 'ghl_mcp_call_tool',
    title: 'Call GoHighLevel MCP tool',
    description: 'Calls any tool exposed by the official GoHighLevel MCP through Ristak. Use tools/list to discover prefixed GoHighLevel tools when available.',
    inputSchema: {
      type: 'object',
      properties: {
        toolName: { type: 'string', description: 'Original GoHighLevel MCP tool name, without the ghl_mcp__ prefix.' },
        arguments: { type: 'object', additionalProperties: true, default: {} }
      },
      required: ['toolName']
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true }
  }
]

async function getSummary(args = {}) {
  const { from, to, scope = 'all' } = args
  const [contactsResult, paymentsResult, campaignsResult] = await Promise.all([
    buildContactStats({ startDate: from, endDate: to, scope }),
    buildTransactionSummary({ startDate: from, endDate: to, scope }),
    buildCampaignSummary({ startDate: from, endDate: to })
  ])

  return {
    range: {
      start: contactsResult.range.startUtc,
      end: contactsResult.range.endUtc,
      timezone: contactsResult.range.appliedTimezone,
      filtered: contactsResult.range.isFiltered
    },
    contacts: contactsResult.metrics,
    payments: paymentsResult.summary,
    campaigns: campaignsResult.summary
  }
}

async function searchContacts(args = {}) {
  const query = String(args.query || '').trim()
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25)

  if (!query) {
    return { contacts: [] }
  }

  const searchClause = buildContactSearchClause('c', query)
  const searchRank = buildContactSearchRank('c', query)
  const rows = await db.all(
    `SELECT
       c.id,
       c.full_name,
       c.email,
       c.phone,
       c.source,
       c.total_paid,
       c.purchases_count,
       c.created_at
     FROM contacts c
     WHERE ${searchClause.condition}
     ORDER BY ${searchRank.expression} DESC, c.created_at DESC
     LIMIT ?`,
    [...searchClause.params, ...searchRank.params, limit]
  )

  return {
    contacts: rows.map(row => ({
      id: row.id,
      name: row.full_name || '',
      email: row.email || '',
      phone: row.phone || '',
      source: row.source || '',
      totalPaid: Number(row.total_paid || 0),
      purchases: Number(row.purchases_count || 0),
      createdAt: row.created_at
    }))
  }
}

async function getContact(args = {}) {
  const id = String(args.id || '').trim()
  if (!id) throw new Error('id requerido')

  const contact = await db.get(
    `SELECT id, full_name, email, phone, source, total_paid, purchases_count, created_at
     FROM contacts
     WHERE id = ?`,
    [id]
  )

  if (!contact) {
    return { contact: null }
  }

  const [payments, appointments] = await Promise.all([
    db.all(
      `SELECT id, amount, currency, status, payment_method, description, date
       FROM payments
       WHERE contact_id = ?
       ORDER BY date DESC
       LIMIT 10`,
      [id]
    ),
    db.all(
      `SELECT id, title, status, appointment_status, start_time, end_time
       FROM appointments
       WHERE contact_id = ?
       ORDER BY start_time DESC
       LIMIT 10`,
      [id]
    )
  ])

  return {
    contact: {
      id: contact.id,
      name: contact.full_name || '',
      email: contact.email || '',
      phone: contact.phone || '',
      source: contact.source || '',
      totalPaid: Number(contact.total_paid || 0),
      purchases: Number(contact.purchases_count || 0),
      createdAt: contact.created_at,
      payments,
      appointments
    }
  }
}

async function listTransactions(args = {}) {
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50)
  const params = []
  const filters = [nonTestPaymentCondition('p')]

  if (args.status) {
    filters.push('LOWER(p.status) = LOWER(?)')
    params.push(String(args.status))
  }

  if (args.startDate) {
    filters.push('p.date >= ?')
    params.push(String(args.startDate))
  }

  if (args.endDate) {
    filters.push('p.date <= ?')
    params.push(String(args.endDate))
  }

  const rows = await db.all(
    `SELECT
       p.id,
       p.contact_id,
       c.full_name as contact_name,
       p.amount,
       p.currency,
       p.status,
       p.payment_method,
       p.description,
       p.date
     FROM payments p
     LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE ${filters.join(' AND ')}
     ORDER BY p.date DESC
     LIMIT ?`,
    [...params, limit]
  )

  return { transactions: rows }
}

function assertConfirmed(args = {}, action) {
  if (args.confirm !== true) {
    throw new Error(`${action} requiere confirm=true para ejecutarse`)
  }
}

function clampLimit(value, max = 100, fallback = 25) {
  return Math.min(Math.max(Number(value) || fallback, 1), max)
}

function isSafeIdentifier(value) {
  return SAFE_IDENTIFIER_PATTERN.test(String(value || ''))
}

function quoteIdentifier(value) {
  if (!isSafeIdentifier(value)) {
    throw new Error(`Identificador inválido: ${value}`)
  }

  return `"${value.replace(/"/g, '""')}"`
}

function isSensitiveTable(name) {
  return SENSITIVE_TABLE_PATTERN.test(String(name || ''))
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

    if (Array.isArray(rows)) {
      return rows.map(row => row.name).filter(Boolean)
    }
  } catch (error) {
    // SQLite does not have information_schema; fall back below.
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
  if (!isSafeIdentifier(table)) {
    throw new Error('Tabla inválida')
  }

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
    // SQLite does not have information_schema; fall back below.
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
      exposedColumns: columns.filter(column => !column.redacted).map(column => column.name),
      redactedColumns: columns.filter(column => column.redacted).map(column => column.name)
    })
  }

  return tables
}

async function resolveAccessibleTable(table) {
  const tableName = String(table || '').trim()

  if (!isSafeIdentifier(tableName) || isSensitiveTable(tableName)) {
    throw new Error('Tabla no permitida')
  }

  const schema = await getAccessibleDatabaseSchema()
  const config = schema.find(item => item.name === tableName)

  if (!config) {
    throw new Error('Tabla no encontrada o no permitida')
  }

  return config
}

async function listDataTables() {
  const tables = await getAccessibleDatabaseSchema()

  return {
    tables: tables.map(table => ({
      name: table.name,
      columns: table.columns,
      queryableColumns: table.queryableColumns,
      redactedColumns: table.redactedColumns
    })),
    blockedTables: ['highlevel_config', 'meta_config', 'meta_campaign_templates', 'meta_campaign_drafts', 'meta_campaign_execution_logs', 'ai_agent_config', 'agent_runs', 'agent_steps', 'agent_pending_actions', 'agent_tool_idempotency', 'app_config', 'oauth_clients', 'oauth_authorization_codes', 'oauth_refresh_tokens'],
    note: 'Se exponen todas las tablas de datos detectadas; las tablas de configuración sensible se bloquean y las columnas tipo token/password/secret/hash se redactan.'
  }
}

async function queryDataTable(args = {}) {
  const table = String(args.table || '').trim()
  const config = await resolveAccessibleTable(table)
  const exposedColumns = config.exposedColumns

  const limit = clampLimit(args.limit, 100, 25)
  const offset = Math.max(Number(args.offset) || 0, 0)
  const params = []
  const conditions = []
  const filters = args.filters && typeof args.filters === 'object' && !Array.isArray(args.filters)
    ? args.filters
    : {}

  for (const [key, value] of Object.entries(filters)) {
    if (!exposedColumns.includes(key)) continue
    if (value === null) {
      conditions.push(`${quoteIdentifier(key)} IS NULL`)
    } else {
      conditions.push(`${quoteIdentifier(key)} = ?`)
      params.push(value)
    }
  }

  const search = String(args.search || '').trim()
  const searchColumns = exposedColumns
  if (search && searchColumns.length) {
    conditions.push(`(${searchColumns.map(column => `CAST(${quoteIdentifier(column)} AS TEXT) LIKE ?`).join(' OR ')})`)
    params.push(...searchColumns.map(() => `%${search}%`))
  }

  const sortableColumns = exposedColumns.length ? exposedColumns : config.queryableColumns
  const fallbackOrder = sortableColumns.includes('created_at')
    ? 'created_at'
    : sortableColumns.includes('updated_at')
      ? 'updated_at'
      : sortableColumns[0]
  const orderBy = sortableColumns.includes(args.orderBy) ? args.orderBy : fallbackOrder
  const orderDirection = String(args.orderDirection || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const selectedColumns = config.queryableColumns

  const [rows, countRow] = await Promise.all([
    db.all(
      `SELECT ${selectedColumns.map(quoteIdentifier).join(', ')}
       FROM ${quoteIdentifier(table)}
       ${whereClause}
       ORDER BY ${quoteIdentifier(orderBy)} ${orderDirection}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    ),
    db.get(
      `SELECT COUNT(*) AS total
       FROM ${quoteIdentifier(table)}
       ${whereClause}`,
      params
    )
  ])

  return {
    table,
    columns: selectedColumns,
    redactedColumns: config.redactedColumns,
    rows,
    pagination: {
      limit,
      offset,
      total: Number(countRow?.total || 0)
    }
  }
}

async function getMetaAdsSummary(args = {}) {
  const groupBy = ['day', 'campaign', 'adset', 'ad'].includes(args.groupBy) ? args.groupBy : 'campaign'
  const limit = clampLimit(args.limit, 100, 25)
  const params = []
  const conditions = []

  if (args.from) {
    conditions.push('date >= ?')
    params.push(String(args.from))
  }

  if (args.to) {
    conditions.push('date <= ?')
    params.push(String(args.to))
  }

  const groupMap = {
    day: ['date AS key', 'date AS label'],
    campaign: ['campaign_id AS key', 'campaign_name AS label'],
    adset: ['adset_id AS key', 'adset_name AS label'],
    ad: ['ad_id AS key', 'ad_name AS label']
  }
  const [keyExpression, labelExpression] = groupMap[groupBy]
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = await db.all(
    `SELECT
       ${keyExpression},
       ${labelExpression},
       SUM(spend) AS spend,
       SUM(reach) AS reach,
       SUM(clicks) AS clicks,
       CASE WHEN SUM(clicks) > 0 THEN SUM(spend) / SUM(clicks) ELSE 0 END AS cpc,
       CASE WHEN SUM(reach) > 0 THEN (SUM(spend) / SUM(reach)) * 1000 ELSE 0 END AS cpm,
       CASE WHEN SUM(reach) > 0 THEN (CAST(SUM(clicks) AS REAL) / SUM(reach)) * 100 ELSE 0 END AS ctr
     FROM meta_ads
     ${whereClause}
     GROUP BY key, label
     ORDER BY spend DESC
     LIMIT ?`,
    [...params, limit]
  )

  return { groupBy, rows }
}

async function getGhlContext() {
  const config = await getHighLevelConfig()

  if (!config?.api_token || !config?.location_id) {
    throw new Error('HighLevel no está configurado en Ristak')
  }

  return {
    config,
    client: await getGHLClient()
  }
}

async function resolveContact(contactId) {
  const id = String(contactId || '').trim()
  if (!id) throw new Error('contactId requerido')

  const contact = await db.get(
    `SELECT id, full_name, first_name, last_name, email, phone
     FROM contacts
     WHERE id = ?`,
    [id]
  )

  if (contact) {
    return {
      id: contact.id,
      name: contact.full_name || `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || contact.email || contact.phone || contact.id,
      email: contact.email || '',
      phone: contact.phone || ''
    }
  }

  const { client } = await getGhlContext()
  const response = await client.getContact(id)
  const ghlContact = response.contact || response

  return {
    id,
    name: ghlContact.name || `${ghlContact.firstName || ''} ${ghlContact.lastName || ''}`.trim() || ghlContact.email || ghlContact.phone || id,
    email: ghlContact.email || '',
    phone: ghlContact.phone || ''
  }
}

async function ghlSearchContacts(args = {}) {
  const { client } = await getGhlContext()
  const result = await client.searchContacts({
    query: args.query,
    email: args.email,
    phone: args.phone,
    limit: clampLimit(args.limit, 25, 10)
  })

  return {
    contacts: (result.contacts || []).map(contact => ({
      id: contact.id,
      name: contact.name || `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
      email: contact.email || '',
      phone: contact.phone || '',
      source: contact.source || '',
      dateAdded: contact.dateAdded || contact.createdAt || null
    }))
  }
}

async function ghlCreateContact(args = {}) {
  assertConfirmed(args, 'Crear contacto en GoHighLevel')
  const { client } = await getGhlContext()

  if (!args.name && !args.email && !args.phone) {
    throw new Error('name, email o phone requerido')
  }

  return client.createContact({
    name: args.name || args.email || args.phone,
    email: args.email || '',
    phone: args.phone || ''
  })
}

async function ghlListCalendars() {
  const { config } = await getGhlContext()
  const calendars = await calendarService.getCalendars(config.location_id, config.api_token)
  return { calendars }
}

async function ghlGetFreeSlots(args = {}) {
  const { config } = await getGhlContext()
  const slots = await calendarService.getFreeSlots(
    args.calendarId,
    args.startDate,
    args.endDate,
    config.api_token,
    args.timezone || 'America/Mexico_City'
  )
  return { slots }
}

async function saveLocalAppointment(appointment = {}, fallback = {}) {
  const data = appointment.appointment || appointment
  const id = data.id || data._id || data.eventId
  if (!id) return null

  await db.run(
    `INSERT INTO appointments (
       id, calendar_id, contact_id, location_id, title, status,
       appointment_status, assigned_user_id, notes, address,
       start_time, end_time, date_added, date_updated
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       calendar_id = excluded.calendar_id,
       contact_id = excluded.contact_id,
       location_id = excluded.location_id,
       title = excluded.title,
       status = excluded.status,
       appointment_status = excluded.appointment_status,
       assigned_user_id = excluded.assigned_user_id,
       notes = excluded.notes,
       address = excluded.address,
       start_time = excluded.start_time,
       end_time = excluded.end_time,
       date_updated = excluded.date_updated`,
    [
      id,
      data.calendarId || fallback.calendarId || null,
      data.contactId || fallback.contactId || null,
      data.locationId || fallback.locationId || null,
      data.title || fallback.title || 'Cita',
      data.status || fallback.status || null,
      data.appointmentStatus || fallback.appointmentStatus || null,
      data.assignedUserId || fallback.assignedUserId || null,
      data.notes || data.description || fallback.notes || null,
      data.address || fallback.address || null,
      data.startTime || fallback.startTime || null,
      data.endTime || fallback.endTime || data.startTime || fallback.startTime || null,
      data.dateAdded || new Date().toISOString(),
      data.dateUpdated || new Date().toISOString()
    ]
  )

  return id
}

async function ghlCreateAppointment(args = {}) {
  assertConfirmed(args, 'Crear cita en GoHighLevel')
  const { config } = await getGhlContext()
  const appointment = await calendarService.createAppointment(
    {
      calendarId: args.calendarId,
      contactId: args.contactId,
      startTime: args.startTime,
      endTime: args.endTime,
      title: args.title || 'Cita',
      appointmentStatus: args.appointmentStatus || 'confirmed',
      assignedUserId: args.assignedUserId,
      address: args.address,
      notes: args.notes
    },
    config.location_id,
    config.api_token
  )

  await saveLocalAppointment(appointment, {
    calendarId: args.calendarId,
    contactId: args.contactId,
    locationId: config.location_id,
    title: args.title || 'Cita',
    appointmentStatus: args.appointmentStatus || 'confirmed',
    assignedUserId: args.assignedUserId,
    address: args.address,
    notes: args.notes,
    startTime: args.startTime,
    endTime: args.endTime
  })

  return { appointment }
}

async function ghlCreatePaymentLink(args = {}) {
  assertConfirmed(args, 'Crear link de pago en GoHighLevel')
  const contact = await resolveContact(args.contactId)

  return createSinglePaymentLink({
    contact,
    amount: args.amount,
    currency: args.currency || 'MXN',
    concept: args.concept,
    description: args.concept,
    dueDate: args.dueDate,
    channels: args.channels || {},
    source: 'mcp'
  })
}

async function ghlRecordOfflinePayment(args = {}) {
  assertConfirmed(args, 'Registrar pago offline en GoHighLevel')
  const contact = await resolveContact(args.contactId)

  return createOfflineContactPayment({
    contact,
    amount: args.amount,
    currency: args.currency || 'MXN',
    concept: args.concept,
    description: args.concept,
    paymentMethod: args.paymentMethod || 'cash',
    paymentDate: args.paymentDate,
    reference: args.reference,
    notes: args.notes,
    source: 'mcp'
  })
}

async function ghlCreateInstallmentPlan(args = {}) {
  assertConfirmed(args, 'Crear plan de parcialidades en GoHighLevel')
  const contact = await resolveContact(args.contactId)

  return createInstallmentPaymentFlow({
    ...args,
    contact,
    source: 'mcp'
  })
}

function normalizeGhlApiPath(path) {
  const normalizedPath = String(path || '').trim()

  if (!normalizedPath.startsWith('/') || normalizedPath.startsWith('//') || normalizedPath.includes('..') || /^https?:\/\//i.test(normalizedPath)) {
    throw new Error('Path de GoHighLevel inválido')
  }

  return normalizedPath
}

async function ghlApiRequest(args = {}) {
  const method = String(args.method || 'GET').toUpperCase()
  const path = normalizeGhlApiPath(args.path)

  if (method !== 'GET') {
    assertConfirmed(args, `Ejecutar ${method} ${path} en GoHighLevel`)
  }

  const { client } = await getGhlContext()
  return client.request(path, {
    method,
    params: args.params || undefined,
    body: args.body || undefined,
    version: args.version || undefined
  })
}

function parseMcpResponseText(text, targetId) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return null

  try {
    return JSON.parse(trimmed)
  } catch (error) {
    // Streamable HTTP MCP servers may answer with text/event-stream.
  }

  const messages = []
  let eventLines = []

  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      eventLines.push(line.slice(5).trimStart())
      continue
    }

    if (line.trim() === '' && eventLines.length) {
      const data = eventLines.join('\n').trim()
      eventLines = []

      if (data && data !== '[DONE]') {
        try {
          messages.push(JSON.parse(data))
        } catch (error) {
          messages.push({ raw: data })
        }
      }
    }
  }

  if (eventLines.length) {
    const data = eventLines.join('\n').trim()
    if (data && data !== '[DONE]') {
      try {
        messages.push(JSON.parse(data))
      } catch (error) {
        messages.push({ raw: data })
      }
    }
  }

  return messages.find(message => message?.id === targetId) || messages.at(-1) || null
}

function mcpErrorMessage(response) {
  if (!response?.error) return ''
  const error = response.error
  return error.message || JSON.stringify(error)
}

async function postHighLevelMcpMessage(config, message, sessionId = null) {
  if (!config?.api_token) {
    throw new Error('HighLevel no está configurado en Ristak')
  }

  const response = await fetch(HIGHLEVEL_MCP_SERVER_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(HIGHLEVEL_MCP_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${config.api_token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      ...(sessionId ? { 'MCP-Session-Id': sessionId } : {})
    },
    body: JSON.stringify(message)
  })

  const text = await response.text()
  const parsed = parseMcpResponseText(text, message?.id)
  const nextSessionId = response.headers.get('mcp-session-id') || response.headers.get('Mcp-Session-Id') || sessionId

  if (!response.ok) {
    const details = parsed?.error ? mcpErrorMessage(parsed) : text.slice(0, 500)
    throw new Error(`HighLevel MCP Error (${response.status}): ${details || response.statusText}`)
  }

  return {
    message: parsed,
    sessionId: nextSessionId
  }
}

async function initializeHighLevelMcp(config) {
  const id = `hl-init-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const initialized = await postHighLevelMcpMessage(config, {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'ristak-mcp-proxy',
        version: '1.0.0'
      }
    }
  })

  if (initialized.message?.error) {
    throw new Error(`HighLevel MCP initialize falló: ${mcpErrorMessage(initialized.message)}`)
  }

  if (initialized.sessionId) {
    try {
      await postHighLevelMcpMessage(config, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {}
      }, initialized.sessionId)
    } catch (error) {
      logger.warn('HighLevel MCP initialized notification falló:', error.message)
    }
  }

  return initialized.sessionId || null
}

async function requestHighLevelMcp(method, params = {}) {
  const config = await getHighLevelConfig()
  if (!config?.api_token) {
    throw new Error('HighLevel no está configurado en Ristak')
  }

  let sessionId = null

  try {
    sessionId = await initializeHighLevelMcp(config)
  } catch (error) {
    logger.warn('No se pudo inicializar HighLevel MCP; se intentará request directo:', error.message)
  }

  const id = `hl-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const response = await postHighLevelMcpMessage(config, {
    jsonrpc: '2.0',
    id,
    method,
    params
  }, sessionId)

  if (response.message?.error) {
    throw new Error(`HighLevel MCP ${method} falló: ${mcpErrorMessage(response.message)}`)
  }

  return response.message?.result || {}
}

function toProxiedHighLevelTool(tool) {
  const originalName = String(tool?.name || '').trim()
  if (!originalName) return null

  return {
    ...sanitizeForExternal(tool),
    name: `${GHL_MCP_TOOL_PREFIX}${originalName}`,
    title: tool.title ? `GoHighLevel: ${tool.title}` : `GoHighLevel: ${originalName}`,
    description: [
      `Proxied official GoHighLevel MCP tool. Original tool: ${originalName}.`,
      tool.description || ''
    ].filter(Boolean).join(' '),
    annotations: {
      ...(tool.annotations || {}),
      openWorldHint: true
    }
  }
}

async function listHighLevelMcpTools() {
  try {
    const config = await getHighLevelConfig()
    if (!config?.api_token) return []

    const result = await requestHighLevelMcp('tools/list', {})
    return (Array.isArray(result.tools) ? result.tools : [])
      .map(toProxiedHighLevelTool)
      .filter(Boolean)
  } catch (error) {
    logger.warn('No se pudieron listar tools del MCP oficial de HighLevel:', error.message)
    return []
  }
}

function normalizeToolResult(result) {
  const sanitized = sanitizeForExternal(result)

  if (sanitized && typeof sanitized === 'object' && (Array.isArray(sanitized.content) || sanitized.structuredContent)) {
    return sanitized
  }

  return textResult(sanitized || {})
}

async function callHighLevelMcpTool(toolName, args = {}) {
  const originalName = String(toolName || '').replace(new RegExp(`^${GHL_MCP_TOOL_PREFIX}`), '').trim()
  if (!originalName) throw new Error('toolName requerido')

  const result = await requestHighLevelMcp('tools/call', {
    name: originalName,
    arguments: args && typeof args === 'object' ? args : {}
  })

  return normalizeToolResult(result)
}

async function getCombinedToolDefinitions() {
  const highLevelTools = await listHighLevelMcpTools()
  return [...toolDefinitions, ...highLevelTools]
}

async function callTool(name, args) {
  if (String(name || '').startsWith(GHL_MCP_TOOL_PREFIX)) {
    return callHighLevelMcpTool(name, args)
  }

  if (name === 'get_summary') return textResult(await getSummary(args))
  if (name === 'search_contacts') return textResult(await searchContacts(args))
  if (name === 'get_contact') return textResult(await getContact(args))
  if (name === 'list_transactions') return textResult(await listTransactions(args))
  if (name === 'list_data_tables') return textResult(await listDataTables())
  if (name === 'query_data_table') return textResult(await queryDataTable(args))
  if (name === 'get_meta_ads_summary') return textResult(await getMetaAdsSummary(args))
  if (name === 'ghl_search_contacts') return textResult(await ghlSearchContacts(args))
  if (name === 'ghl_create_contact') return textResult(await ghlCreateContact(args))
  if (name === 'ghl_list_calendars') return textResult(await ghlListCalendars(args))
  if (name === 'ghl_get_free_slots') return textResult(await ghlGetFreeSlots(args))
  if (name === 'ghl_create_appointment') return textResult(await ghlCreateAppointment(args))
  if (name === 'ghl_create_payment_link') return textResult(await ghlCreatePaymentLink(args))
  if (name === 'ghl_record_offline_payment') return textResult(await ghlRecordOfflinePayment(args))
  if (name === 'ghl_create_installment_plan') return textResult(await ghlCreateInstallmentPlan(args))
  if (name === 'ghl_api_request') return textResult(await ghlApiRequest(args))
  if (name === 'ghl_mcp_call_tool') return callHighLevelMcpTool(args?.toolName, args?.arguments || {})
  throw new Error(`Tool no soportada: ${name}`)
}

async function handleMessage(message) {
  const { id, method, params = {} } = message || {}

  if (!method) {
    return jsonRpcError(id, -32600, 'Solicitud inválida')
  }

  if (method === 'notifications/initialized') {
    return null
  }

  if (method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: 'ristak',
        title: 'Ristak',
        version: '1.0.0'
      }
    })
  }

  if (method === 'tools/list') {
    return jsonRpcResult(id, {
      tools: await getCombinedToolDefinitions()
    })
  }

  if (method === 'tools/call') {
    try {
      return jsonRpcResult(id, await callTool(params.name, params.arguments || {}))
    } catch (error) {
      return jsonRpcError(id, -32000, error.message)
    }
  }

  return jsonRpcError(id, -32601, `Método no soportado: ${method}`)
}

router.get('/', requireMcpAuth, async (req, res) => {
  const tools = await getCombinedToolDefinitions()

  res.json({
    name: 'ristak',
    protocolVersion: MCP_PROTOCOL_VERSION,
    tools: tools.map(tool => tool.name)
  })
})

router.post('/', requireMcpAuth, async (req, res) => {
  try {
    const payload = req.body

    if (Array.isArray(payload)) {
      const responses = (await Promise.all(payload.map(handleMessage))).filter(Boolean)
      if (!responses.length) return res.status(202).end()
      return res.json(responses)
    }

    const response = await handleMessage(payload)
    if (!response) return res.status(202).end()
    res.json(response)
  } catch (error) {
    logger.error('Error en MCP:', error)
    res.status(500).json(jsonRpcError(null, -32603, 'Error interno MCP'))
  }
})

export default router
