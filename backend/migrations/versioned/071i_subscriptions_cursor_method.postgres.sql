CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_cursor_method
  ON subscriptions((CASE WHEN payment_method IS NULL THEN 1 ELSE 0 END), payment_method, (COALESCE(updated_at, created_at)), id)
  WHERE COALESCE(status, '') <> 'deleted';
