CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_whatsapp_attribution_message
  ON whatsapp_api_attribution(whatsapp_api_message_id);
