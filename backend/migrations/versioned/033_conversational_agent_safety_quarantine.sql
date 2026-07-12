CREATE TABLE IF NOT EXISTS conversational_agent_safety_cases (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  block_mode TEXT NOT NULL,
  blocked_until DATETIME,
  policy_json TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  opened_at DATETIME NOT NULL,
  latest_event_id TEXT,
  latest_agent_id TEXT,
  latest_source_message_id TEXT,
  latest_reason TEXT,
  resolved_at DATETIME,
  resolved_by TEXT,
  resolution_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_safety_case_identity
  ON conversational_agent_safety_cases(contact_id, channel);

CREATE INDEX IF NOT EXISTS idx_conv_agent_safety_case_active
  ON conversational_agent_safety_cases(status, blocked_until, updated_at);

CREATE TABLE IF NOT EXISTS conversational_agent_safety_events (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  block_mode TEXT NOT NULL,
  blocked_until DATETIME,
  notification_status TEXT NOT NULL DEFAULT 'pending',
  notification_attempts INTEGER NOT NULL DEFAULT 0,
  notification_claim_token TEXT,
  notification_lease_until DATETIME,
  notification_next_retry_at DATETIME,
  notification_last_error TEXT,
  notification_receipt_json TEXT,
  notification_sent_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (case_id) REFERENCES conversational_agent_safety_cases(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_safety_event_identity
  ON conversational_agent_safety_events(agent_id, contact_id, channel, source_message_id);

CREATE INDEX IF NOT EXISTS idx_conv_agent_safety_event_case
  ON conversational_agent_safety_events(case_id, created_at);

CREATE INDEX IF NOT EXISTS idx_conv_agent_safety_event_notification
  ON conversational_agent_safety_events(
    notification_status,
    notification_next_retry_at,
    notification_lease_until,
    updated_at
  );

CREATE TABLE IF NOT EXISTS conversational_agent_safety_audit (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  event_id TEXT,
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  detail_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (case_id) REFERENCES conversational_agent_safety_cases(id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id) REFERENCES conversational_agent_safety_events(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_conv_agent_safety_audit_case
  ON conversational_agent_safety_audit(case_id, created_at);

CREATE INDEX IF NOT EXISTS idx_conv_agent_safety_audit_event
  ON conversational_agent_safety_audit(event_id, created_at);
