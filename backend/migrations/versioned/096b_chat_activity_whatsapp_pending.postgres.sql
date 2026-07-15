CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_whatsapp_api_messages_chat_projection_pending
  ON whatsapp_api_messages(id)
  WHERE chat_projection_version < 1;
