CREATE TABLE IF NOT EXISTS conversational_agent_test_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL,
  contact_id TEXT,
  effects_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  cleaned_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_conv_agent_test_runs_user
  ON conversational_agent_test_runs(requested_by_user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_conv_agent_test_runs_agent
  ON conversational_agent_test_runs(agent_id, updated_at);

CREATE TABLE IF NOT EXISTS conversational_agent_test_effects (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'recorded',
  entity_id TEXT,
  payload_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  lease_until_at DATETIME,
  last_error TEXT,
  notification_status TEXT NOT NULL DEFAULT 'pending',
  notification_error TEXT,
  notification_sent_at DATETIME,
  completion_notification_status TEXT,
  completion_notification_error TEXT,
  completion_notification_sent_at DATETIME,
  cleanup_status TEXT,
  cleanup_error TEXT,
  cleaned_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES conversational_agent_test_runs(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_test_effect_identity
  ON conversational_agent_test_effects(run_id, message_id, effect_type);
CREATE INDEX IF NOT EXISTS idx_conv_agent_test_effect_run
  ON conversational_agent_test_effects(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conv_agent_test_effect_entity
  ON conversational_agent_test_effects(effect_type, entity_id);
