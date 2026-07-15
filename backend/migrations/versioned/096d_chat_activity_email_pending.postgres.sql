CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_messages_chat_projection_pending
  ON email_messages(id)
  WHERE chat_projection_version < 1;
