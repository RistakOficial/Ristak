CREATE TABLE IF NOT EXISTS automation_trigger_index (
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  endpoint_id TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (automation_id, event_type, endpoint_id)
);

CREATE INDEX IF NOT EXISTS idx_automation_trigger_event_endpoint_automation
  ON automation_trigger_index (event_type, endpoint_id, automation_id);

CREATE TABLE IF NOT EXISTS automation_trigger_index_state (
  id SMALLINT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  index_version INTEGER NOT NULL DEFAULT 1,
  cursor_automation_id TEXT,
  indexed_automations BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO automation_trigger_index_state (
  id,
  status,
  index_version,
  cursor_automation_id,
  indexed_automations,
  updated_at
) VALUES (1, 'pending', 1, NULL, 0, CURRENT_TIMESTAMP)
ON CONFLICT(id) DO NOTHING;
