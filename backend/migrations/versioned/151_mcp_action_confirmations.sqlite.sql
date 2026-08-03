-- Aprobaciones humanas de acciones MCP de alto impacto.
CREATE TABLE mcp_action_confirmations (
  confirmation_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  oauth_grant_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_hash TEXT NOT NULL,
  arguments_redacted_json TEXT NOT NULL,
  risk_level TEXT NOT NULL
    CHECK (risk_level IN ('write', 'execute', 'destructive')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'consumed', 'expired')),
  execution_key_hash TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  decided_at DATETIME,
  consumed_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  FOREIGN KEY (oauth_grant_id) REFERENCES oauth_grants(grant_id) ON DELETE CASCADE
);

CREATE INDEX idx_mcp_action_confirmations_actor_status
  ON mcp_action_confirmations(user_id, client_id, status, created_at);
CREATE INDEX idx_mcp_action_confirmations_expiry
  ON mcp_action_confirmations(expires_at, status);
