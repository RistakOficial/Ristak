CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_email_first
  ON sessions(LOWER(email), started_at, created_at, id)
  WHERE email IS NOT NULL AND email != '';
