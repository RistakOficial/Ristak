CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_started_at_id
  ON sessions(started_at DESC, id DESC);
