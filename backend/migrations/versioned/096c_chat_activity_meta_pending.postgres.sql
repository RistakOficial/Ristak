CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_social_messages_chat_projection_pending
  ON meta_social_messages(id)
  WHERE chat_projection_version < 1;
