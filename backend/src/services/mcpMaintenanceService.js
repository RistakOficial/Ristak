import { db } from '../config/database.js'

const DAY_MS = 24 * 60 * 60 * 1000
export const MCP_RETENTION_DAYS = Object.freeze({
  events: 30,
  confirmations: 90,
  invitations: 90,
  audit: 180
})

function cutoffIso(now, days) {
  return new Date(now.getTime() - days * DAY_MS).toISOString()
}

function affected(result) {
  return Number(result?.changes ?? result?.rowCount) || 0
}

export async function runMcpDataMaintenance({ now = new Date() } = {}) {
  const nowIso = now.toISOString()
  const result = {}

  result.confirmationsExpired = affected(await db.run(
    `UPDATE mcp_action_confirmations
     SET status = 'expired', updated_at = CURRENT_TIMESTAMP
     WHERE status IN ('pending', 'approved') AND expires_at <= ?`,
    [nowIso]
  ))
  result.invitationsExpired = affected(await db.run(
    `UPDATE user_invitations
     SET status = 'expired', updated_at = CURRENT_TIMESTAMP
     WHERE status = 'pending' AND expires_at <= ?`,
    [nowIso]
  ))
  result.idempotencyDeleted = affected(await db.run(
    'DELETE FROM mcp_idempotency_keys WHERE expires_at <= ?',
    [nowIso]
  ))
  result.eventsDeleted = affected(await db.run(
    'DELETE FROM mcp_business_events WHERE expires_at <= ?',
    [nowIso]
  ))
  result.confirmationsDeleted = affected(await db.run(
    `DELETE FROM mcp_action_confirmations
     WHERE status IN ('rejected', 'consumed', 'expired') AND updated_at < ?`,
    [cutoffIso(now, MCP_RETENTION_DAYS.confirmations)]
  ))
  result.invitationsDeleted = affected(await db.run(
    `DELETE FROM user_invitations
     WHERE status IN ('accepted', 'revoked', 'expired') AND updated_at < ?`,
    [cutoffIso(now, MCP_RETENTION_DAYS.invitations)]
  ))
  result.auditDeleted = affected(await db.run(
    'DELETE FROM mcp_audit_log WHERE created_at < ?',
    [cutoffIso(now, MCP_RETENTION_DAYS.audit)]
  ))

  return result
}

export const __mcpMaintenanceTestHooks = { cutoffIso }
