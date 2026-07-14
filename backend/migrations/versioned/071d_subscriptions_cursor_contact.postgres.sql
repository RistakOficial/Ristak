CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_cursor_contact
  ON subscriptions((CASE WHEN contact_name IS NULL THEN 1 ELSE 0 END), contact_name, (COALESCE(updated_at, created_at)), id)
  WHERE COALESCE(status, '') <> 'deleted';
