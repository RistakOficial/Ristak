CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_event_id_unique
  ON sessions(event_id)
  WHERE event_id IS NOT NULL AND event_id != '';
