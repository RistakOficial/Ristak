CREATE TABLE IF NOT EXISTS payment_plan_creation_requests (
  provider TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  flow_id TEXT,
  response_json TEXT,
  error_status INTEGER,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_payment_plan_creation_request_hash
  ON payment_plan_creation_requests(provider, request_hash, created_at);

CREATE TABLE IF NOT EXISTS payment_plan_creation_hash_guards (
  provider TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, request_hash)
);

CREATE INDEX IF NOT EXISTS idx_payment_plan_creation_hash_guard_expiry
  ON payment_plan_creation_hash_guards(expires_at);
