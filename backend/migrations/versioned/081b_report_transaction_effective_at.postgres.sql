CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_report_transactions_effective_at_id
  ON payments((COALESCE(date, created_at)) DESC, id DESC)
  WHERE COALESCE(payment_mode, 'live') != 'test';
