CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_whatsapp_api_messages_chat_unresolved_to_phone
  ON whatsapp_api_messages(to_phone, id)
  WHERE NULLIF(BTRIM(COALESCE(contact_id, '')), '') IS NULL
    AND to_phone IS NOT NULL;
