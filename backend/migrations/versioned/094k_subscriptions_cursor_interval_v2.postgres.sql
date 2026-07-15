CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_cursor_interval_v2
  ON subscriptions(
    (CASE WHEN interval_type IS NULL THEN 1 ELSE 0 END),
    interval_type,
    (COALESCE(updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00')),
    id
  )
  WHERE COALESCE(status, '') <> 'deleted';
