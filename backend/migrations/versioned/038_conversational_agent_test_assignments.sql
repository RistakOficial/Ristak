CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_test_effect_run_identity
  ON conversational_agent_test_effects(id, run_id);

CREATE TABLE IF NOT EXISTS conversational_agent_test_assignments (
  effect_id TEXT PRIMARY KEY,
  test_run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  previous_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'assigning',
  cleanup_due_at DATETIME NOT NULL,
  assigned_at DATETIME,
  notification_status TEXT NOT NULL DEFAULT 'pending',
  notification_error TEXT,
  notification_sent_at DATETIME,
  claim_token TEXT,
  lease_until_at DATETIME,
  cleanup_attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  cleaned_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (effect_id, test_run_id)
    REFERENCES conversational_agent_test_effects(id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (test_run_id) REFERENCES conversational_agent_test_runs(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_conv_agent_test_assignment_cleanup
  ON conversational_agent_test_assignments(status, cleanup_due_at);
CREATE INDEX IF NOT EXISTS idx_conv_agent_test_assignment_run
  ON conversational_agent_test_assignments(test_run_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_conv_agent_test_assignment_contact
  ON conversational_agent_test_assignments(contact_id, updated_at);
