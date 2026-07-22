-- Control plane OAuth/MCP: grants revocables, idempotencia y auditoría.
ALTER TABLE oauth_clients
  ADD COLUMN IF NOT EXISTS client_uri TEXT,
  ADD COLUMN IF NOT EXISTS software_id TEXT,
  ADD COLUMN IF NOT EXISTS software_version TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS grant_id TEXT;

ALTER TABLE oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS grant_id TEXT,
  ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rotated_to_hash TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS oauth_grants (
  grant_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (user_id, client_id, resource)
);

CREATE INDEX IF NOT EXISTS idx_oauth_grants_user_active
  ON oauth_grants(user_id, revoked_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_client_active
  ON oauth_grants(client_id, revoked_at);

CREATE TABLE IF NOT EXISTS mcp_idempotency_keys (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed')),
  result_json TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, client_id, tool_name, key_hash)
);

CREATE INDEX IF NOT EXISTS idx_mcp_idempotency_expiry
  ON mcp_idempotency_keys(expires_at);
CREATE INDEX IF NOT EXISTS idx_mcp_idempotency_actor
  ON mcp_idempotency_keys(user_id, created_at);

CREATE TABLE IF NOT EXISTS mcp_audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  client_id TEXT,
  oauth_grant_id TEXT REFERENCES oauth_grants(grant_id) ON DELETE SET NULL,
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
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mcp_audit_actor_created
  ON mcp_audit_log(actor_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_client_tool_created
  ON mcp_audit_log(client_id, tool_name, created_at);
