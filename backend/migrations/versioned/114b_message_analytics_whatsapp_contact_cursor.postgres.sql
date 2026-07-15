CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_message_analytics_whatsapp_contact_cursor
  ON whatsapp_api_messages(contact_id, id);
