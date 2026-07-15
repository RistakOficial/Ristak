CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_visitor_first
  ON sessions(visitor_id, started_at, created_at, id)
  WHERE visitor_id IS NOT NULL AND visitor_id != '';
