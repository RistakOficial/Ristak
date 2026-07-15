CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_contact_first
  ON sessions(contact_id, started_at, created_at, id)
  WHERE contact_id IS NOT NULL AND contact_id != '';
