CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_source_whatsapp_api_first
  ON whatsapp_api_messages(
    contact_id,
    LOWER(COALESCE(direction, '')),
    COALESCE(message_timestamp, created_at),
    id
  );
