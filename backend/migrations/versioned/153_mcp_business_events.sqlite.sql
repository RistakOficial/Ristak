-- Bandeja durable de eventos para conexiones MCP. Cada grant conserva su propio acuse.
CREATE TABLE mcp_business_events (
  event_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  event_type TEXT NOT NULL,
  entity_id TEXT,
  payload_json TEXT NOT NULL,
  occurred_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_mcp_business_events_timeline
  ON mcp_business_events(occurred_at, event_id);
CREATE INDEX idx_mcp_business_events_domain_type
  ON mcp_business_events(domain, event_type, occurred_at);
CREATE INDEX idx_mcp_business_events_expiry
  ON mcp_business_events(expires_at);

CREATE TABLE mcp_event_acknowledgements (
  oauth_grant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  acknowledged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (oauth_grant_id, event_id),
  FOREIGN KEY (oauth_grant_id) REFERENCES oauth_grants(grant_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES mcp_business_events(event_id) ON DELETE CASCADE
);

CREATE INDEX idx_mcp_event_acknowledgements_event
  ON mcp_event_acknowledgements(event_id);
