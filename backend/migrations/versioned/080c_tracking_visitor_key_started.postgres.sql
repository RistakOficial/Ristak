CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_visitor_key_started_page
  ON sessions(visitor_key, started_at DESC, id DESC);
