CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_cursor_amount
  ON subscriptions((CASE WHEN amount IS NULL THEN 1 ELSE 0 END), amount, (COALESCE(updated_at, created_at)), id)
  WHERE COALESCE(status, '') <> 'deleted';
