-- Mantiene rápida la bandeja de chats en cuentas con historiales grandes.
-- La gran mayoría de mensajes ya tiene contact_id; sólo las filas heredadas sin
-- identidad directa deben pasar por la resolución más costosa por teléfono.

CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_unresolved_profile
  ON whatsapp_api_messages (whatsapp_api_contact_id)
  WHERE contact_id IS NULL AND whatsapp_api_contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_unresolved_phone
  ON whatsapp_api_messages (phone)
  WHERE contact_id IS NULL AND phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_unresolved_from_phone
  ON whatsapp_api_messages (from_phone)
  WHERE contact_id IS NULL AND from_phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_unresolved_to_phone
  ON whatsapp_api_messages (to_phone)
  WHERE contact_id IS NULL AND to_phone IS NOT NULL;
