CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_whatsapp_api_messages_chat_unresolved_phone
  ON whatsapp_api_messages(phone, id)
  WHERE NULLIF(BTRIM(COALESCE(contact_id, '')), '') IS NULL
    AND phone IS NOT NULL;
