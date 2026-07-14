CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_visitor_projection_recent
  ON sessions(started_at DESC, id DESC)
  WHERE visitor_projection_version < 3;
