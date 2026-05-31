import express from 'express'
import { db } from '../config/database.js'
import {
  buildCampaignSummary,
  buildContactStats,
  buildTransactionSummary
} from '../services/analyticsService.js'
import { verifyOAuthAccessToken } from '../utils/oauthTokens.js'
import { buildContactSearchClause } from '../utils/searchText.js'
import { nonTestPaymentCondition } from '../utils/paymentMode.js'
import { logger } from '../utils/logger.js'

const router = express.Router()

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

function textResult(payload) {
  return {
    structuredContent: payload,
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload)
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
     ORDER BY c.created_at DESC
     LIMIT ?`,
    [...searchClause.params, limit]
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

async function callTool(name, args) {
  if (name === 'get_summary') return textResult(await getSummary(args))
  if (name === 'search_contacts') return textResult(await searchContacts(args))
  if (name === 'get_contact') return textResult(await getContact(args))
  if (name === 'list_transactions') return textResult(await listTransactions(args))
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
      protocolVersion: '2025-06-18',
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
      tools: toolDefinitions
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

router.get('/', requireMcpAuth, (req, res) => {
  res.json({
    name: 'ristak',
    protocolVersion: '2025-06-18',
    tools: toolDefinitions.map(tool => tool.name)
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
