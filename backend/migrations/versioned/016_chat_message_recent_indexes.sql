CREATE INDEX IF NOT EXISTS idx_wam_contact_recent
  ON whatsapp_api_messages (contact_id, message_timestamp, created_at);

CREATE INDEX IF NOT EXISTS idx_wam_phone_recent
  ON whatsapp_api_messages (phone, message_timestamp, created_at);

CREATE INDEX IF NOT EXISTS idx_wam_from_phone_recent
  ON whatsapp_api_messages (from_phone, message_timestamp, created_at);

CREATE INDEX IF NOT EXISTS idx_wam_to_phone_recent
  ON whatsapp_api_messages (to_phone, message_timestamp, created_at);

CREATE INDEX IF NOT EXISTS idx_meta_social_contact_recent
  ON meta_social_messages (contact_id, message_timestamp, created_at);

CREATE INDEX IF NOT EXISTS idx_email_messages_contact_recent
  ON email_messages (contact_id, message_timestamp, created_at);

CREATE INDEX IF NOT EXISTS idx_whatsapp_attr_contact_recent
  ON whatsapp_attribution (contact_id, created_at);
