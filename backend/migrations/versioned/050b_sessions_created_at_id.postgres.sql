CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_created_at_id
  ON sessions(created_at DESC, id DESC);
