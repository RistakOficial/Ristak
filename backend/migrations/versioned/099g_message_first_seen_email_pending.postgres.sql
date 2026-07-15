CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_messages_first_seen_pending
  ON email_messages(id)
  WHERE first_seen_projection_version < 1;
