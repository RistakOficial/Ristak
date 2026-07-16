-- Cursor exacto del contrato publico de /contacts/:id/conversation.
-- message_sort acota por instante y la identidad prefijada evita perder o
-- duplicar mensajes empatados entre WhatsApp, Meta y email.
CREATE INDEX IF NOT EXISTS idx_chat_message_activity_conversation_cursor
  ON chat_message_activity(
    contact_id,
    message_sort DESC,
    (CASE source_kind
      WHEN 'whatsapp' THEN 'whatsapp_api:' || CAST(source_message_id AS TEXT)
      WHEN 'meta' THEN 'meta_social:' || CAST(source_message_id AS TEXT)
      WHEN 'email' THEN 'email:' || CAST(source_message_id AS TEXT)
      ELSE source_kind || ':' || CAST(source_message_id AS TEXT)
    END) COLLATE BINARY DESC
  )
  WHERE included = 1;
