CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_whatsapp_messages_inbound_effective_time
  ON whatsapp_api_messages(
    LOWER(COALESCE(direction, 'inbound')),
    COALESCE(message_timestamp, created_at)
  );
