CREATE TABLE IF NOT EXISTS whatsapp_qr_inbound_backups (
  phone_number_id TEXT NOT NULL,
  protocol_message_key_id TEXT NOT NULL,
  business_phone TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  content_json TEXT NOT NULL,
  received_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  business_effects_claimed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (phone_number_id, protocol_message_key_id, contact_phone),
  FOREIGN KEY (phone_number_id) REFERENCES whatsapp_api_phone_numbers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_qr_inbound_backups_retention
  ON whatsapp_qr_inbound_backups(phone_number_id, received_at_ms DESC, protocol_message_key_id DESC, contact_phone DESC);
