CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_whatsapp_api_messages_chat_unresolved_from_phone
  ON whatsapp_api_messages(from_phone, id)
  WHERE NULLIF(BTRIM(COALESCE(contact_id, '')), '') IS NULL
    AND from_phone IS NOT NULL;
