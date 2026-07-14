CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_event_started_at_id
  ON sessions(event_name, started_at DESC, id DESC);
