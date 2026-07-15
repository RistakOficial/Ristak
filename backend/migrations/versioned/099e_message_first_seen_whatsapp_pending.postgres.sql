CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_whatsapp_messages_first_seen_pending
  ON whatsapp_api_messages(id)
  WHERE first_seen_projection_version < 1;
