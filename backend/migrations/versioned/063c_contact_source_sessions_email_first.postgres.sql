CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_source_sessions_email_first
  ON sessions(LOWER(email), started_at, created_at, id);
