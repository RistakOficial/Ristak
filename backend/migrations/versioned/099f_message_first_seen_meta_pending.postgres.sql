CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_messages_first_seen_pending
  ON meta_social_messages(id)
  WHERE first_seen_projection_version < 1;
