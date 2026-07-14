-- SQLite local: la base no soporta CREATE INDEX CONCURRENTLY. Estos índices se
-- crean sólo aquí; PostgreSQL usa las migraciones 051a-051d sin bloquear
-- escrituras durante un deploy.
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_inbound_effective_time
  ON whatsapp_api_messages(
    LOWER(COALESCE(direction, 'inbound')),
    COALESCE(message_timestamp, created_at)
  );

CREATE INDEX IF NOT EXISTS idx_meta_messages_inbound_effective_time
  ON meta_social_messages(
    LOWER(COALESCE(direction, 'inbound')),
    COALESCE(message_timestamp, created_at)
  );

CREATE INDEX IF NOT EXISTS idx_email_messages_inbound_effective_time
  ON email_messages(
    LOWER(COALESCE(direction, 'outbound')),
    COALESCE(message_timestamp, created_at)
  );

CREATE INDEX IF NOT EXISTS idx_whatsapp_attribution_message
  ON whatsapp_api_attribution(whatsapp_api_message_id);
