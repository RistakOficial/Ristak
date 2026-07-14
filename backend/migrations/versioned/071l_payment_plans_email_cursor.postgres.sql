CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_plans_email_cursor
  ON payment_plans(
    (LOWER(COALESCE(email, ''))),
    (COALESCE(next_run_at, updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00')),
    id
  );
