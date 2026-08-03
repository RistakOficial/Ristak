-- Aprobaciones humanas de acciones MCP de alto impacto.
CREATE TABLE IF NOT EXISTS mcp_action_confirmations (
  confirmation_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  oauth_grant_id TEXT NOT NULL REFERENCES oauth_grants(grant_id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  arguments_hash TEXT NOT NULL,
  arguments_redacted_json TEXT NOT NULL,
  risk_level TEXT NOT NULL
    CHECK (risk_level IN ('write', 'execute', 'destructive')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'consumed', 'expired')),
  execution_key_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mcp_action_confirmations_actor_status
  ON mcp_action_confirmations(user_id, client_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_mcp_action_confirmations_expiry
  ON mcp_action_confirmations(expires_at, status);
