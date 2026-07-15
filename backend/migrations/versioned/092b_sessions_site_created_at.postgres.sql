CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_site_created_at
  ON sessions(site_id, created_at)
  WHERE site_id IS NOT NULL AND site_id != '';
