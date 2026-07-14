CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_cursor_status
  ON subscriptions((CASE WHEN status IS NULL THEN 1 ELSE 0 END), status, (COALESCE(updated_at, created_at)), id)
  WHERE COALESCE(status, '') <> 'deleted';
