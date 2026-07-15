CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_cursor_next_v2
  ON subscriptions(
    (CASE WHEN next_run_at IS NULL THEN 1 ELSE 0 END),
    next_run_at,
    (COALESCE(updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00')),
    id
  )
  WHERE COALESCE(status, '') <> 'deleted';
