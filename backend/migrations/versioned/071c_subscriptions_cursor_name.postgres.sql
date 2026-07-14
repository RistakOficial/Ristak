CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_cursor_name
  ON subscriptions((CASE WHEN name IS NULL THEN 1 ELSE 0 END), name, (COALESCE(updated_at, created_at)), id)
  WHERE COALESCE(status, '') <> 'deleted';
