CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_cursor_created
  ON subscriptions((CASE WHEN created_at IS NULL THEN 1 ELSE 0 END), created_at, (COALESCE(updated_at, created_at)), id)
  WHERE COALESCE(status, '') <> 'deleted';
