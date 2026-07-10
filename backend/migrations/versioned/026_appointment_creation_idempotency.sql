CREATE TABLE IF NOT EXISTS appointment_creation_requests (
  client_request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  appointment_id TEXT,
  response_json TEXT,
  error_status INTEGER,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_appointment_creation_request_appointment
  ON appointment_creation_requests(appointment_id);
