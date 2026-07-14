CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_cursor_interval
  ON subscriptions((CASE WHEN interval_type IS NULL THEN 1 ELSE 0 END), interval_type, (COALESCE(updated_at, created_at)), id)
  WHERE COALESCE(status, '') <> 'deleted';
