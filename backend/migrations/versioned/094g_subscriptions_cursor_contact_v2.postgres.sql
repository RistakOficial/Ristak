CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_cursor_contact_v2
  ON subscriptions(
    (CASE WHEN contact_name IS NULL THEN 1 ELSE 0 END),
    contact_name,
    (COALESCE(updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00')),
    id
  )
  WHERE COALESCE(status, '') <> 'deleted';
