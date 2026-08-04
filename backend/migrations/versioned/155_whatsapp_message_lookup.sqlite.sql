CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_provider_message_id
  ON whatsapp_api_messages(provider_message_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_ycloud_message_id
  ON whatsapp_api_messages(ycloud_message_id);
