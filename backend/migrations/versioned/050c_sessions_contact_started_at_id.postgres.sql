CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_contact_started_at_id
  ON sessions(contact_id, started_at DESC, id DESC);
