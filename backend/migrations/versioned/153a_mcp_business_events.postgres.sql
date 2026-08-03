-- Bandeja durable de eventos para conexiones MCP. Cada grant conserva su propio acuse.
CREATE TABLE IF NOT EXISTS mcp_business_events (
  event_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  event_type TEXT NOT NULL,
  entity_id TEXT,
  payload_json TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mcp_business_events_timeline
  ON mcp_business_events(occurred_at, event_id);
CREATE INDEX IF NOT EXISTS idx_mcp_business_events_domain_type
  ON mcp_business_events(domain, event_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_mcp_business_events_expiry
  ON mcp_business_events(expires_at);

CREATE TABLE IF NOT EXISTS mcp_event_acknowledgements (
  oauth_grant_id TEXT NOT NULL REFERENCES oauth_grants(grant_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES mcp_business_events(event_id) ON DELETE CASCADE,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (oauth_grant_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_mcp_event_acknowledgements_event
  ON mcp_event_acknowledgements(event_id);
