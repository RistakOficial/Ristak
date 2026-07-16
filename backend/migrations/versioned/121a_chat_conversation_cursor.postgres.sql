-- Fuera de transaccion: el runner de migraciones ejecuta los indices
-- CONCURRENTLY de forma aislada para no bloquear la ingesta productiva.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_message_activity_conversation_cursor
  ON chat_message_activity(
    contact_id,
    message_sort DESC,
    ((CASE source_kind
      WHEN 'whatsapp' THEN 'whatsapp_api:' || source_message_id
      WHEN 'meta' THEN 'meta_social:' || source_message_id
      WHEN 'email' THEN 'email:' || source_message_id
      ELSE source_kind || ':' || source_message_id
    END) COLLATE "C") DESC
  )
  WHERE included = 1;
