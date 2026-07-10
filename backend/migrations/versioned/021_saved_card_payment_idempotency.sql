CREATE TABLE IF NOT EXISTS saved_card_payment_requests (
  provider TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  payment_id TEXT,
  response_json TEXT,
  error_status INTEGER,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_saved_card_payment_request_payment
  ON saved_card_payment_requests(payment_id);
