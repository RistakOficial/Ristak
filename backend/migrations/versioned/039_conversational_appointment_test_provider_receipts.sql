CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_test_effect_run_identity
  ON conversational_agent_test_effects(id, run_id);

CREATE TABLE IF NOT EXISTS conversational_appointment_test_provider_receipts (
  id TEXT PRIMARY KEY,
  test_effect_id TEXT NOT NULL,
  test_run_id TEXT NOT NULL,
  appointment_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  command_key TEXT,
  idempotency_marker TEXT,
  command_json TEXT,
  remote_status TEXT NOT NULL DEFAULT 'created',
  remote_error TEXT,
  remote_attempt_count INTEGER NOT NULL DEFAULT 0,
  remote_reconciled_at DATETIME,
  calendar_id TEXT,
  cleanup_due_at DATETIME NOT NULL,
  cleanup_status TEXT NOT NULL DEFAULT 'pending',
  cleanup_error TEXT,
  cleanup_attempt_count INTEGER NOT NULL DEFAULT 0,
  cleaned_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (test_effect_id, test_run_id) REFERENCES conversational_agent_test_effects(id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (test_run_id) REFERENCES conversational_agent_test_runs(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_appt_test_receipt_external
  ON conversational_appointment_test_provider_receipts(provider, external_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_appt_test_receipt_effect_provider
  ON conversational_appointment_test_provider_receipts(test_effect_id, provider);

CREATE INDEX IF NOT EXISTS idx_conv_appt_test_receipt_cleanup
  ON conversational_appointment_test_provider_receipts(cleanup_status, cleanup_due_at);

CREATE INDEX IF NOT EXISTS idx_conv_appt_test_receipt_appointment
  ON conversational_appointment_test_provider_receipts(appointment_id, provider);
