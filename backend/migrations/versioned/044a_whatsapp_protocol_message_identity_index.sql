CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_protocol_key
  ON whatsapp_api_messages (protocol_message_key_id, direction);
