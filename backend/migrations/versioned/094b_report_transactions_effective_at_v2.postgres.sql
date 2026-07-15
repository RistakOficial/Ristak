CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_report_transactions_effective_at_id_v2
  ON payments(
    (COALESCE(date, created_at, '1970-01-01 00:00:00+00')) DESC,
    id DESC
  )
  WHERE COALESCE(payment_mode, 'live') != 'test';
