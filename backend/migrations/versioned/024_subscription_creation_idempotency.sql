CREATE TABLE IF NOT EXISTS subscription_creation_requests (
  idempotency_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  subscription_id TEXT,
  response_json TEXT,
  error_status INTEGER,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subscription_creation_request_subscription
  ON subscription_creation_requests(subscription_id);
