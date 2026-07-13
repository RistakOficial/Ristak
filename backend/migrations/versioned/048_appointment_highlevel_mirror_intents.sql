CREATE TABLE IF NOT EXISTS appointment_highlevel_mirror_intents (
  appointment_id TEXT PRIMARY KEY,
  appointment_date_updated TIMESTAMPTZ,
  local_calendar_id TEXT NOT NULL,
  remote_calendar_id TEXT NOT NULL,
  local_contact_id TEXT,
  remote_contact_id TEXT,
  location_id TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  normalized_title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'prepared',
  remote_appointment_id TEXT,
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_appointment_ghl_mirror_intent_match
  ON appointment_highlevel_mirror_intents(
    status,
    remote_calendar_id,
    remote_contact_id,
    start_time,
    end_time,
    expires_at
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_ghl_mirror_intent_remote
  ON appointment_highlevel_mirror_intents(remote_appointment_id)
  WHERE remote_appointment_id IS NOT NULL AND remote_appointment_id != '';
