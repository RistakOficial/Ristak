CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_plans_total_cursor
  ON payment_plans(
    (CASE WHEN total IS NULL THEN 1 ELSE 0 END),
    total,
    (COALESCE(next_run_at, updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00')),
    id
  );
