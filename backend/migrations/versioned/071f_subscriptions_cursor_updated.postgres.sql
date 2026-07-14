CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_cursor_updated
  ON subscriptions((CASE WHEN updated_at IS NULL THEN 1 ELSE 0 END), updated_at, (COALESCE(updated_at, created_at)), id)
  WHERE COALESCE(status, '') <> 'deleted';
