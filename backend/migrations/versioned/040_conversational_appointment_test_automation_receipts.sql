CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_test_effect_run_identity
  ON conversational_agent_test_effects(id, run_id);

CREATE TABLE IF NOT EXISTS conversational_appointment_test_automation_receipts (
  id TEXT PRIMARY KEY,
  test_effect_id TEXT NOT NULL,
  test_run_id TEXT NOT NULL,
  appointment_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  automation_id TEXT,
  automation_name TEXT,
  node_id TEXT,
  node_type TEXT,
  action_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  execution_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  request_json TEXT,
  response_json TEXT,
  cleanup_due_at DATETIME,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (test_effect_id, test_run_id) REFERENCES conversational_agent_test_effects(id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (test_run_id) REFERENCES conversational_agent_test_runs(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_appt_test_automation_receipt_key
  ON conversational_appointment_test_automation_receipts(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_conv_appt_test_automation_receipt_effect
  ON conversational_appointment_test_automation_receipts(test_effect_id, created_at);

CREATE INDEX IF NOT EXISTS idx_conv_appt_test_automation_receipt_appointment
  ON conversational_appointment_test_automation_receipts(appointment_id, created_at);
