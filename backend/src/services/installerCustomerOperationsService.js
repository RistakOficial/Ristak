import crypto from 'node:crypto'
import { db } from '../config/database.js'
import { invokeController } from '../mcp/controllerInvoker.js'
import {
  callRegisteredMcpTool,
  listMcpToolDefinitions,
  sanitizeMcpResult
} from '../mcp/toolRegistry.js'
import { getLicenseState, isLicenseEnforced } from './licenseService.js'
import { MCP_SCOPE_VALUES } from '../utils/oauthTokens.js'
import { resolveOAuthOrigin } from '../utils/oauthOrigin.js'

const STANDARD_SCOPES = Object.freeze(['ristak.read', 'ristak.write', 'ristak.execute'])
const INSTALLER_CLIENT_ID = 'client_ristak_installer_customer_operations'
const INSTALLER_CLIENT_NAME = 'Ristak Installer · Operaciones de clientes'
const MAX_OPERATOR_TEXT = 300

function makeError(code, message, statusCode = 400, extra = {}) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  Object.assign(error, extra)
  return error
}

function cleanText(value, maxLength = MAX_OPERATOR_TEXT) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeDelegatedScopes(value) {
  const requested = (Array.isArray(value) ? value : String(value || '').split(/\s+/))
    .map(scope => cleanText(scope, 100))
    .filter(Boolean)
  if (!requested.length) return [...STANDARD_SCOPES]
  const unknown = requested.filter(scope => !MCP_SCOPE_VALUES.includes(scope))
  if (unknown.length) {
    throw makeError('installer_customer_operations_scope_invalid', 'La delegación solicitó un scope MCP no permitido.', 403)
  }
  const requestedSet = new Set(requested)
  return MCP_SCOPE_VALUES.filter(scope => requestedSet.has(scope))
}

function normalizeOperator(value = {}) {
  const id = cleanText(value?.id)
  const email = cleanText(value?.email).toLowerCase()
  if (!id || !email || !email.includes('@')) {
    throw makeError(
      'installer_customer_operations_operator_invalid',
      'La delegación no identifica al administrador del Installer.',
      400
    )
  }
  return { id, email }
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code,
      message,
      ...(data ? { data } : {})
    }
  }
}

function textResult(payload) {
  const safe = sanitizeMcpResult(payload)
  return {
    structuredContent: safe,
    content: [{ type: 'text', text: JSON.stringify(safe) }]
  }
}

function toolErrorResult(error) {
  const payload = sanitizeMcpResult({
    error: error?.message || 'No se pudo ejecutar la herramienta',
    code: error?.code || 'mcp_tool_failed',
    ...(error?.details ? { details: error.details } : {})
  })
  return {
    isError: true,
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }]
  }
}

async function localAdminActor() {
  const user = await db.get(
    `SELECT id, username, email, full_name, role, access_config
     FROM users
     WHERE is_active = 1 AND role = 'admin'
     ORDER BY id ASC
     LIMIT 1`
  )
  if (!user) {
    throw makeError(
      'installer_customer_operations_admin_missing',
      'La instalación no tiene un administrador local activo para ejecutar la operación.',
      409
    )
  }
  return {
    ...user,
    userId: user.id,
    fullName: user.full_name
  }
}

function supportGrantId(installationId, userId) {
  const digest = crypto
    .createHash('sha256')
    .update(`${installationId}:${userId}:${INSTALLER_CLIENT_ID}`)
    .digest('hex')
  return `grant_installer_support_${digest.slice(0, 32)}`
}

async function ensureSupportMcpIdentity({ installationId, userId, scopes, resource }) {
  const grantId = supportGrantId(installationId, userId)
  await db.run(
    `INSERT INTO oauth_clients (
       client_id, client_name, redirect_uris, client_uri, software_id,
       software_version, created_at, updated_at, revoked_at
     ) VALUES (?, ?, ?, NULL, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
     ON CONFLICT(client_id) DO UPDATE SET
       client_name = excluded.client_name,
       software_id = excluded.software_id,
       software_version = excluded.software_version,
       updated_at = CURRENT_TIMESTAMP,
       revoked_at = NULL`,
    [
      INSTALLER_CLIENT_ID,
      INSTALLER_CLIENT_NAME,
      JSON.stringify(['http://127.0.0.1/ristak-installer/customer-operations']),
      'ristak-installer-customer-operations',
      '1.0.0'
    ]
  )
  await db.run(
    `INSERT INTO oauth_grants (
       grant_id, user_id, client_id, scope, resource, version,
       created_at, updated_at, last_used_at, revoked_at
     ) VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
     ON CONFLICT(grant_id) DO UPDATE SET
       user_id = excluded.user_id,
       client_id = excluded.client_id,
       scope = excluded.scope,
       resource = excluded.resource,
       updated_at = CURRENT_TIMESTAMP,
       last_used_at = CURRENT_TIMESTAMP,
       revoked_at = NULL`,
    [grantId, userId, INSTALLER_CLIENT_ID, scopes.join(' '), resource]
  )
  return {
    id: grantId,
    grantId,
    clientId: INSTALLER_CLIENT_ID,
    clientName: INSTALLER_CLIENT_NAME,
    scopes,
    resource,
    version: 1
  }
}

async function delegatedContext(req, { installationId, operator, scopes }) {
  const user = await localAdminActor()
  const license = isLicenseEnforced()
    ? await getLicenseState({ email: user.email || user.username })
    : null
  if (license && !license.allowed) {
    throw makeError(
      'installer_customer_operations_license_blocked',
      license.message || 'La licencia de esta instalación no está activa.',
      403
    )
  }

  const baseUrl = resolveOAuthOrigin(req)
  const resource = `${baseUrl}/api/internal/customer-operations/mcp`
  const grant = await ensureSupportMcpIdentity({
    installationId,
    userId: user.id,
    scopes,
    resource
  })
  const mcpUser = {
    id: user.id,
    clientId: grant.clientId,
    grantId: grant.id,
    scope: scopes
  }
  const userAgent = [
    'Ristak Installer customer-operations',
    `operator=${operator.email}`,
    cleanText(req.get?.('user-agent'), 200)
  ].filter(Boolean).join('; ')
  const context = {
    user,
    license,
    grant,
    scopes,
    clientId: grant.clientId,
    mcpUser,
    baseUrl,
    ip: req.ip,
    userAgent,
    app: req.app,
    supportDelegation: { operator }
  }
  context.invoke = (handler, request) => invokeController(handler, context, request)
  return context
}

export async function handleInstallerCustomerOperationsMessage(req, payload = {}) {
  const message = payload?.message
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return jsonRpcError(null, -32600, 'Solicitud MCP inválida')
  }
  const operator = normalizeOperator(payload.operator)
  const scopes = normalizeDelegatedScopes(payload.scopes)
  const installationId = cleanText(req.installerCustomerOperations?.installationId, 200)
  if (!installationId) {
    throw makeError('installer_customer_operations_identity_missing', 'No se pudo verificar la instalación.', 401)
  }
  const context = await delegatedContext(req, { installationId, operator, scopes })
  const { id, method, params = {} } = message

  if (method === 'ping') return jsonRpcResult(id, {})
  if (method === 'tools/list') {
    return jsonRpcResult(id, { tools: await listMcpToolDefinitions(context) })
  }
  if (method === 'tools/call') {
    try {
      const result = await callRegisteredMcpTool(
        context,
        cleanText(params?.name, 200),
        params?.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? params.arguments
          : {}
      )
      return jsonRpcResult(id, textResult(result))
    } catch (error) {
      return jsonRpcResult(id, toolErrorResult(error))
    }
  }
  return jsonRpcError(id, -32601, `Método no soportado: ${cleanText(method, 100)}`)
}

export const __installerCustomerOperationsTestHooks = {
  normalizeDelegatedScopes,
  normalizeOperator,
  supportGrantId
}
