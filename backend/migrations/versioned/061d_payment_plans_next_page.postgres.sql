CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_plans_next_page
  ON payment_plans(
    (COALESCE(next_run_at, TIMESTAMP '1970-01-01 00:00:00')) DESC,
    (COALESCE(next_run_at, updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00')) DESC,
    id DESC
  );
