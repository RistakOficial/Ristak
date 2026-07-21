CREATE TABLE IF NOT EXISTS gigstack_invoice_jobs (
  payment_id TEXT PRIMARY KEY,
  payment_mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms BIGINT NOT NULL DEFAULT 0,
  claim_token TEXT,
  lease_until_at_ms BIGINT,
  last_error TEXT,
  remote_payment_id TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_gigstack_invoice_jobs_due
  ON gigstack_invoice_jobs(status, next_attempt_at_ms);
