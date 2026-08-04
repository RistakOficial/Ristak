CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_whatsapp_api_messages_ycloud_message_id
  ON whatsapp_api_messages(ycloud_message_id);
