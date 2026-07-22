import { logger } from '../utils/logger.js'
import {
  MCP_SCOPE_VALUES,
  countOAuthConnectionsForUser,
  listOAuthConnectionsForUser,
  revokeOAuthGrantForUser
} from '../utils/oauthTokens.js'
import { resolveOAuthOrigin } from '../utils/oauthOrigin.js'
import { db } from '../config/database.js'
import { listMcpToolDefinitions } from '../mcp/toolRegistry.js'

export async function getMcpAccessStatus(req, res) {
  try {
    const origin = resolveOAuthOrigin(req)
    const activeConnections = await countOAuthConnectionsForUser(req.user.userId)
    const visibleTools = await listMcpToolDefinitions({
      user: req.user,
      license: req.license || null,
      scopes: MCP_SCOPE_VALUES
    })
    const domains = Array.from(new Set(
      visibleTools.map(tool => tool?._meta?.['ristak/domain']).filter(Boolean)
    )).sort()
    const toolsByDomain = Object.fromEntries(domains.map(domain => [
      domain,
      visibleTools.filter(tool => tool?._meta?.['ristak/domain'] === domain).length
    ]))
    const mcp = {
      enabled: true,
      ready: true,
      serverUrl: `${origin}/api/mcp`,
      protocolVersion: '2025-06-18',
      transport: 'streamable-http',
      auth: 'oauth_2_1',
      scopes: MCP_SCOPE_VALUES,
      activeConnections,
      toolCount: visibleTools.length,
      domains,
      toolsByDomain,
      auditUrl: '/api/api-access/mcp/audit',
      metadata: {
        protectedResourceUrl: `${origin}/.well-known/oauth-protected-resource`,
        authorizationServerUrl: `${origin}/.well-known/oauth-authorization-server`
      },
      protections: {
        pkce: true,
        refreshRotation: true,
        refreshReplayRevocation: true,
        immediateRevocation: true,
        userAndGrantValidationPerRequest: true
      }
    }

    res.json({ success: true, mcp })
  } catch (error) {
    logger.error('Error obteniendo estado MCP:', error)
    res.status(500).json({
      success: false,
      error: 'No se pudo obtener el estado de MCP.'
    })
  }
}

export async function listMcpAudit(req, res) {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100)
    const beforeId = Number(req.query.beforeId) || null
    const params = [req.user.userId]
    const beforeClause = beforeId ? 'AND audit.id < ?' : ''
    if (beforeId) params.push(beforeId)
    params.push(limit + 1)

    const rows = await db.all(
      `SELECT
         audit.id,
         audit.client_id,
         clients.client_name,
         audit.tool_name,
         audit.risk_level,
         audit.success,
         audit.result_summary_json,
         audit.error_code,
         audit.error_message,
         audit.started_at,
         audit.completed_at,
         audit.created_at
       FROM mcp_audit_log audit
       LEFT JOIN oauth_clients clients ON clients.client_id = audit.client_id
       WHERE audit.actor_user_id = ?
       ${beforeClause}
       ORDER BY audit.id DESC
       LIMIT ?`,
      params
    )
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const entries = pageRows.map(row => ({
      id: row.id,
      clientId: row.client_id || null,
      clientName: row.client_name || 'Cliente MCP',
      toolName: row.tool_name,
      risk: row.risk_level,
      success: Number(row.success) === 1,
      resultSummary: (() => {
        try { return row.result_summary_json ? JSON.parse(row.result_summary_json) : null } catch { return null }
      })(),
      errorCode: row.error_code || null,
      errorMessage: row.error_message || null,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdAt: row.created_at
    }))

    res.json({
      success: true,
      entries,
      pageInfo: {
        hasMore,
        nextBeforeId: hasMore ? entries[entries.length - 1]?.id || null : null
      }
    })
  } catch (error) {
    logger.error('Error listando auditoría MCP:', error)
    res.status(500).json({ success: false, error: 'No se pudo cargar la actividad MCP.' })
  }
}

export async function listMcpConnections(req, res) {
  try {
    const connections = await listOAuthConnectionsForUser(req.user.userId)
    res.json({ success: true, connections })
  } catch (error) {
    logger.error('Error listando conexiones MCP:', error)
    res.status(500).json({
      success: false,
      error: 'No se pudieron cargar las conexiones MCP.'
    })
  }
}

export async function revokeMcpConnection(req, res) {
  try {
    const grantId = String(req.params.id || '').trim()
    if (!/^grant_[A-Za-z0-9_-]{20,}$/.test(grantId)) {
      return res.status(404).json({ success: false, error: 'Conexión no encontrada.' })
    }

    const revoked = await revokeOAuthGrantForUser({
      grantId,
      userId: req.user.userId
    })
    if (!revoked) {
      return res.status(404).json({ success: false, error: 'Conexión no encontrada.' })
    }

    logger.info(`Conexión MCP revocada por usuario ${req.user.userId}: ${grantId}`)
    res.json({ success: true, id: grantId })
  } catch (error) {
    logger.error('Error revocando conexión MCP:', error)
    res.status(500).json({
      success: false,
      error: 'No se pudo revocar la conexión MCP.'
    })
  }
}
