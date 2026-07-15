CREATE TABLE IF NOT EXISTS conversational_agent_test_turns (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  client_request_hash TEXT,
  status TEXT NOT NULL DEFAULT 'processing',
  preview_result_json TEXT,
  response_json TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  lease_until_at DATETIME,
  error_code TEXT,
  last_error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  FOREIGN KEY (run_id) REFERENCES conversational_agent_test_runs(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_test_turn_identity
  ON conversational_agent_test_turns(run_id, message_id);
CREATE INDEX IF NOT EXISTS idx_conv_agent_test_turn_run
  ON conversational_agent_test_turns(run_id, created_at);
