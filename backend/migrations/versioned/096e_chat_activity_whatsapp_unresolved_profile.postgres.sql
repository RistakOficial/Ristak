CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_whatsapp_api_messages_chat_unresolved_profile
  ON whatsapp_api_messages(whatsapp_api_contact_id, id)
  WHERE NULLIF(BTRIM(COALESCE(contact_id, '')), '') IS NULL
    AND whatsapp_api_contact_id IS NOT NULL;
