CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_plans_status_page
  ON payment_plans(
    (CASE
      WHEN LOWER(COALESCE(status, 'active')) IN ('complete', 'completed', 'paid', 'finished', 'finalized', 'finalizado') THEN 'completed'
      WHEN LOWER(COALESCE(status, 'active')) IN ('canceled', 'cancelled') THEN 'cancelled'
      ELSE LOWER(COALESCE(status, 'active'))
    END) ASC,
    (COALESCE(next_run_at, updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00')) ASC,
    id ASC
  );
