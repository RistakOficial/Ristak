CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_visitor_key_created_page
  ON sessions(visitor_key, created_at DESC, id DESC);
