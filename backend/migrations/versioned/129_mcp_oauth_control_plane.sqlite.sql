-- Control plane OAuth/MCP: grants revocables, idempotencia y auditoría.
ALTER TABLE oauth_clients ADD COLUMN client_uri TEXT;
ALTER TABLE oauth_clients ADD COLUMN software_id TEXT;
ALTER TABLE oauth_clients ADD COLUMN software_version TEXT;
ALTER TABLE oauth_clients ADD COLUMN updated_at DATETIME;
ALTER TABLE oauth_clients ADD COLUMN revoked_at DATETIME;

ALTER TABLE oauth_authorization_codes ADD COLUMN grant_id TEXT;

ALTER TABLE oauth_refresh_tokens ADD COLUMN grant_id TEXT;
ALTER TABLE oauth_refresh_tokens ADD COLUMN used_at DATETIME;
ALTER TABLE oauth_refresh_tokens ADD COLUMN rotated_to_hash TEXT;
ALTER TABLE oauth_refresh_tokens ADD COLUMN updated_at DATETIME;

CREATE TABLE oauth_grants (
  grant_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME,
  revoked_at DATETIME,
  revoked_by_user_id INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  FOREIGN KEY (revoked_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (user_id, client_id, resource)
);

CREATE INDEX idx_oauth_grants_user_active
  ON oauth_grants(user_id, revoked_at, updated_at);
CREATE INDEX idx_oauth_grants_client_active
  ON oauth_grants(client_id, revoked_at);

CREATE TABLE mcp_idempotency_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed')),
  result_json TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  UNIQUE (user_id, client_id, tool_name, key_hash)
);

CREATE INDEX idx_mcp_idempotency_expiry
  ON mcp_idempotency_keys(expires_at);
CREATE INDEX idx_mcp_idempotency_actor
  ON mcp_idempotency_keys(user_id, created_at);

CREATE TABLE mcp_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  client_id TEXT,
  oauth_grant_id TEXT,
  tool_name TEXT NOT NULL,
  risk_level TEXT NOT NULL
    CHECK (risk_level IN ('read', 'write', 'execute', 'destructive')),
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  input_redacted_json TEXT,
  result_summary_json TEXT,
  error_code TEXT,
  error_message TEXT,
  ip_address TEXT,
  user_agent TEXT,
  started_at DATETIME NOT NULL,
  completed_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (oauth_grant_id) REFERENCES oauth_grants(grant_id) ON DELETE SET NULL
);

CREATE INDEX idx_mcp_audit_actor_created
  ON mcp_audit_log(actor_user_id, created_at);
CREATE INDEX idx_mcp_audit_client_tool_created
  ON mcp_audit_log(client_id, tool_name, created_at);
