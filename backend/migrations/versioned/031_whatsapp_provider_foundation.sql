ALTER TABLE whatsapp_api_contacts ADD COLUMN whatsapp_user_id TEXT;
ALTER TABLE whatsapp_api_contacts ADD COLUMN parent_whatsapp_user_id TEXT;
ALTER TABLE whatsapp_api_contacts ADD COLUMN username TEXT;

ALTER TABLE whatsapp_api_messages ADD COLUMN source_adapter TEXT DEFAULT 'ycloud';
ALTER TABLE whatsapp_api_messages ADD COLUMN provider_message_id TEXT;

ALTER TABLE whatsapp_api_webhook_events ADD COLUMN provider TEXT DEFAULT 'ycloud';

ALTER TABLE whatsapp_api_template_sends ADD COLUMN provider TEXT DEFAULT 'ycloud';
ALTER TABLE whatsapp_api_template_sends ADD COLUMN source_adapter TEXT DEFAULT 'ycloud';
ALTER TABLE whatsapp_api_template_sends ADD COLUMN provider_message_id TEXT;

UPDATE whatsapp_api_messages
SET meta_message_id = ycloud_message_id,
    ycloud_message_id = NULL
WHERE LOWER(COALESCE(provider, '')) = 'meta_direct'
  AND COALESCE(meta_message_id, '') = ''
  AND COALESCE(ycloud_message_id, '') != '';

UPDATE whatsapp_api_messages
SET provider_message_id = COALESCE(NULLIF(meta_message_id, ''), NULLIF(ycloud_message_id, ''), NULLIF(wamid, ''))
WHERE COALESCE(provider_message_id, '') = '';

UPDATE whatsapp_api_messages
SET source_adapter = CASE
  WHEN LOWER(COALESCE(transport, '')) = 'qr' OR LOWER(COALESCE(provider, '')) = 'qr' THEN 'baileys'
  WHEN LOWER(COALESCE(provider, '')) = 'meta_direct' THEN 'meta_direct'
  ELSE 'ycloud'
END
WHERE COALESCE(source_adapter, '') = '' OR source_adapter = 'ycloud';

UPDATE whatsapp_api_webhook_events
SET provider = CASE
  WHEN LOWER(COALESCE(event_type, '')) LIKE 'meta.%'
    OR LOWER(COALESCE(webhook_endpoint_id, '')) = 'installer_relay' THEN 'meta_direct'
  ELSE 'ycloud'
END
WHERE COALESCE(provider, '') = '' OR provider = 'ycloud';

UPDATE whatsapp_api_template_sends
SET provider_message_id = COALESCE(NULLIF(ycloud_message_id, ''), NULLIF(wamid, '')),
    provider = COALESCE(NULLIF(provider, ''), 'ycloud'),
    source_adapter = COALESCE(NULLIF(source_adapter, ''), 'ycloud')
WHERE COALESCE(provider_message_id, '') = '';

CREATE INDEX IF NOT EXISTS idx_whatsapp_api_contacts_user_id ON whatsapp_api_contacts(whatsapp_user_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_provider_message ON whatsapp_api_messages(provider, provider_message_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_source_adapter ON whatsapp_api_messages(source_adapter);
CREATE INDEX IF NOT EXISTS idx_whatsapp_api_events_provider_type ON whatsapp_api_webhook_events(provider, event_type, created_at);
