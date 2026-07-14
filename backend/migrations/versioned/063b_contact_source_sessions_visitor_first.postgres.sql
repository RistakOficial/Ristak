CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_source_sessions_visitor_first
  ON sessions(visitor_id, started_at, created_at, id);
