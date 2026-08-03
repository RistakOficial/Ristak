import crypto from 'node:crypto'
import { db } from '../config/database.js'
import {
  signPublicContextClaims,
  verifyPublicContextToken
} from './publicContextTokenService.js'

const TOKEN_PURPOSE = 'mcp.action_confirmation'
const CONFIRMATION_TTL_SECONDS = 15 * 60
const MAX_ARGUMENTS_JSON_LENGTH = 24000
const CONTROL_KEYS = new Set(['approvalTicket', 'confirm', 'idempotencyKey'])
const SECRET_KEY_PATTERN = /(token|secret|password|authorization|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|database[_-]?url|encrypted|hash|cookie|idempotency|file[_-]?base64|data[_-]?url|bytes[_-]?base64)/i

function makeError(message, code, status = 400) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

function cleanString(value, maxLength = 500) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  )
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function sanitizeArguments(value, key = '', depth = 0) {
  if (SECRET_KEY_PATTERN.test(key)) return '[oculto por seguridad]'
  if (depth > 10) return '[truncado]'
  if (typeof value === 'string') {
    return value.length > 2000
      ? `${value.slice(0, 2000)}… [se ocultaron ${value.length - 2000} caracteres]`
      : value
  }
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeArguments(entry, '', depth + 1))
  return Object.fromEntries(
    Object.entries(value).slice(0, 200).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeArguments(entryValue, entryKey, depth + 1)
    ])
  )
}

function serializeArguments(value) {
  const serialized = JSON.stringify(sanitizeArguments(value))
  if (serialized.length <= MAX_ARGUMENTS_JSON_LENGTH) return serialized
  return JSON.stringify({
    truncated: true,
    resumen: 'El resumen seguro superó el límite de pantalla. El pase sigue ligado a todos los argumentos.',
    caracteresSerializados: serialized.length,
    campos: Object.keys(value || {}).slice(0, 100)
  })
}

function actorContext(context = {}) {
  const userId = context.user?.id || context.user?.userId
  const clientId = cleanString(context.mcpUser?.clientId || context.clientId, 300)
  const grantId = cleanString(
    context.mcpUser?.grantId || context.grant?.id || context.grant?.grantId,
    300
  )
  if (!userId || !clientId || !grantId) {
    throw makeError('La conexión MCP no tiene una identidad OAuth completa.', 'mcp_identity_incomplete', 401)
  }
  return { userId, clientId, grantId }
}

function parseStoredArguments(value) {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function normalizeRow(row = {}) {
  return {
    confirmationId: row.confirmation_id,
    toolName: row.tool_name,
    toolTitle: row.tool_title || row.tool_name,
    toolDescription: row.tool_description || null,
    clientName: row.client_name || row.client_id,
    riskLevel: row.risk_level,
    status: row.status,
    arguments: parseStoredArguments(row.arguments_redacted_json),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at || null,
    consumedAt: row.consumed_at || null
  }
}

function isExpired(row, nowMs = Date.now()) {
  const expiresAt = new Date(row?.expires_at).getTime()
  return !Number.isFinite(expiresAt) || expiresAt <= nowMs
}

async function markExpired(row) {
  if (!row || row.status !== 'pending' || !isExpired(row)) return row
  const updated = await db.run(
    `UPDATE mcp_action_confirmations
     SET status = 'expired', updated_at = CURRENT_TIMESTAMP
     WHERE confirmation_id = ? AND status = 'pending'`,
    [row.confirmation_id]
  )
  if (Number(updated?.changes ?? updated?.rowCount) === 1) row.status = 'expired'
  return row
}

async function verifiedClaims(token) {
  try {
    return (await verifyPublicContextToken(token, { purpose: TOKEN_PURPOSE })).claims
  } catch (error) {
    if (error?.code === 'public_context_token_expired') {
      throw makeError('La solicitud de aprobación expiró.', 'confirmation_expired', 410)
    }
    throw makeError('La solicitud de aprobación no es válida.', 'confirmation_invalid', 400)
  }
}

async function findConfirmation(token) {
  const claims = await verifiedClaims(token)
  const confirmationId = cleanString(claims.confirmationId, 120)
  if (!confirmationId) throw makeError('La solicitud de aprobación no es válida.', 'confirmation_invalid', 400)
  const row = await db.get(
    `SELECT confirmations.*, clients.client_name
     FROM mcp_action_confirmations confirmations
     JOIN oauth_clients clients ON clients.client_id = confirmations.client_id
     WHERE confirmations.confirmation_id = ?`,
    [confirmationId]
  )
  if (!row) throw makeError('La solicitud de aprobación ya no existe.', 'confirmation_not_found', 404)
  await markExpired(row)
  return { claims, row }
}

function assertClaimBinding(claims, row) {
  if (
    String(claims.userId) !== String(row.user_id) ||
    claims.clientId !== row.client_id ||
    claims.grantId !== row.oauth_grant_id ||
    claims.toolName !== row.tool_name ||
    claims.argumentsHash !== row.arguments_hash
  ) {
    throw makeError('La aprobación no coincide con la acción solicitada.', 'confirmation_binding_mismatch', 409)
  }
}

export function stripMcpActionControls(args = {}) {
  return Object.fromEntries(
    Object.entries(args || {}).filter(([key]) => !CONTROL_KEYS.has(key))
  )
}

export function hashMcpActionArguments(args = {}) {
  return sha256(JSON.stringify(stableValue(stripMcpActionControls(args))))
}

export async function createMcpActionConfirmation(context, spec, args = {}) {
  const actor = actorContext(context)
  const confirmationId = crypto.randomUUID()
  const businessArguments = stripMcpActionControls(args)
  const argumentsHash = hashMcpActionArguments(businessArguments)
  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_SECONDS * 1000).toISOString()
  const riskLevel = spec.scope === 'ristak.destructive'
    ? 'destructive'
    : spec.scope === 'ristak.execute' ? 'execute' : 'write'

  await db.run(
    `INSERT INTO mcp_action_confirmations (
       confirmation_id, user_id, client_id, oauth_grant_id, tool_name,
       arguments_hash, arguments_redacted_json, risk_level, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      confirmationId,
      actor.userId,
      actor.clientId,
      actor.grantId,
      spec.name,
      argumentsHash,
      serializeArguments(businessArguments),
      riskLevel,
      expiresAt
    ]
  )

  const approvalTicket = await signPublicContextClaims({
    purpose: TOKEN_PURPOSE,
    ttlSeconds: CONFIRMATION_TTL_SECONDS,
    claims: {
      confirmationId,
      userId: String(actor.userId),
      clientId: actor.clientId,
      grantId: actor.grantId,
      toolName: spec.name,
      argumentsHash
    }
  })
  const approvalUrl = new URL('/mcp/actions/confirm', context.baseUrl)
  approvalUrl.hash = new URLSearchParams({ ticket: approvalTicket }).toString()

  return {
    success: true,
    confirmation: {
      approvalTicket,
      status: 'pending',
      toolName: spec.name,
      toolTitle: spec.title || spec.name.replaceAll('_', ' '),
      riskLevel,
      expiresAt,
      approvalUrl: approvalUrl.toString(),
      instruction: 'Abre approvalUrl para que la persona autenticada apruebe o rechace la acción. Después consulta mcp_action_confirmation_status.'
    }
  }
}

export async function getMcpActionConfirmationStatus(context, token) {
  const actor = actorContext(context)
  const { claims, row } = await findConfirmation(token)
  assertClaimBinding(claims, row)
  if (
    String(actor.userId) !== String(row.user_id) ||
    actor.clientId !== row.client_id ||
    actor.grantId !== row.oauth_grant_id
  ) {
    throw makeError('Esta aprobación pertenece a otra conexión MCP.', 'confirmation_actor_mismatch', 403)
  }
  return {
    success: true,
    confirmation: {
      status: row.status,
      toolName: row.tool_name,
      riskLevel: row.risk_level,
      expiresAt: row.expires_at,
      readyToExecute: row.status === 'approved'
    }
  }
}

export async function getMcpActionConfirmationForUser(userId, token, toolMetadata = {}) {
  const { claims, row } = await findConfirmation(token)
  assertClaimBinding(claims, row)
  if (String(userId) !== String(row.user_id)) {
    throw makeError('Esta aprobación pertenece a otro usuario.', 'confirmation_actor_mismatch', 403)
  }
  row.tool_title = toolMetadata.title
  row.tool_description = toolMetadata.description
  return normalizeRow(row)
}

export async function decideMcpActionConfirmation(userId, token, decision, toolMetadata = {}) {
  const { claims, row } = await findConfirmation(token)
  assertClaimBinding(claims, row)
  if (String(userId) !== String(row.user_id)) {
    throw makeError('Esta aprobación pertenece a otro usuario.', 'confirmation_actor_mismatch', 403)
  }
  if (!['approve', 'reject'].includes(decision)) {
    throw makeError('La decisión no es válida.', 'invalid_confirmation_decision', 400)
  }
  if (row.status !== 'pending') {
    row.tool_title = toolMetadata.title
    row.tool_description = toolMetadata.description
    return normalizeRow(row)
  }
  if (isExpired(row)) {
    await markExpired(row)
    throw makeError('La solicitud de aprobación expiró.', 'confirmation_expired', 410)
  }

  const nextStatus = decision === 'approve' ? 'approved' : 'rejected'
  const updated = await db.run(
    `UPDATE mcp_action_confirmations
     SET status = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE confirmation_id = ? AND status = 'pending'`,
    [nextStatus, row.confirmation_id]
  )
  if (Number(updated?.changes ?? updated?.rowCount) !== 1) {
    throw makeError('La solicitud cambió mientras se procesaba.', 'confirmation_state_conflict', 409)
  }
  row.status = nextStatus
  row.decided_at = new Date().toISOString()
  row.tool_title = toolMetadata.title
  row.tool_description = toolMetadata.description
  return normalizeRow(row)
}

export async function consumeMcpActionConfirmation(context, spec, args = {}) {
  const actor = actorContext(context)
  const ticket = cleanString(args.approvalTicket, 4096)
  if (!ticket) {
    throw makeError(
      'Esta acción necesita una aprobación humana. Usa mcp_prepare_action_confirmation.',
      'human_confirmation_required',
      400
    )
  }
  const { claims, row } = await findConfirmation(ticket)
  assertClaimBinding(claims, row)
  if (
    String(actor.userId) !== String(row.user_id) ||
    actor.clientId !== row.client_id ||
    actor.grantId !== row.oauth_grant_id ||
    spec.name !== row.tool_name ||
    hashMcpActionArguments(args) !== row.arguments_hash
  ) {
    throw makeError('La aprobación no corresponde exactamente a esta acción.', 'confirmation_binding_mismatch', 409)
  }
  if (row.status !== 'approved') {
    const messages = {
      pending: 'La acción todavía espera aprobación humana.',
      rejected: 'La persona rechazó esta acción.',
      consumed: 'Esta aprobación ya fue utilizada.',
      expired: 'La aprobación expiró.'
    }
    throw makeError(messages[row.status] || 'La aprobación no está disponible.', `confirmation_${row.status}`, 409)
  }

  const executionKeyHash = sha256(args.idempotencyKey)
  const updated = await db.run(
    `UPDATE mcp_action_confirmations
     SET status = 'consumed', execution_key_hash = ?, consumed_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE confirmation_id = ? AND status = 'approved'`,
    [executionKeyHash, row.confirmation_id]
  )
  if (Number(updated?.changes ?? updated?.rowCount) !== 1) {
    throw makeError('La aprobación ya fue usada por otra ejecución.', 'confirmation_already_consumed', 409)
  }
}
