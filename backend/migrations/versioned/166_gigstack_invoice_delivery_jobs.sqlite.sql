CREATE TABLE IF NOT EXISTS gigstack_invoice_delivery_jobs (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  payment_mode TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  invoice_uuid TEXT,
  channel TEXT NOT NULL,
  document_format TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms BIGINT NOT NULL DEFAULT 0,
  claim_token TEXT,
  lease_until_at_ms BIGINT,
  last_error TEXT,
  provider_message_id TEXT,
  result_json TEXT,
  sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(payment_id, invoice_id, channel, document_format),
  FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_gigstack_invoice_delivery_jobs_due
  ON gigstack_invoice_delivery_jobs(status, next_attempt_at_ms);
