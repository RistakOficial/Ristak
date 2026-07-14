CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_contact_created_at_id
  ON sessions(contact_id, created_at DESC, id DESC);
