CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_plans_total_page
  ON payment_plans(
    total DESC,
    (COALESCE(next_run_at, updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00')) DESC,
    id DESC
  );
