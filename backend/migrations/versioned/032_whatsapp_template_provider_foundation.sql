ALTER TABLE whatsapp_message_templates ADD COLUMN template_provider TEXT DEFAULT 'ycloud';
ALTER TABLE whatsapp_message_templates ADD COLUMN provider_template_name TEXT;
ALTER TABLE whatsapp_message_templates ADD COLUMN provider_template_id TEXT;
ALTER TABLE whatsapp_message_templates ADD COLUMN provider_status TEXT;
ALTER TABLE whatsapp_message_templates ADD COLUMN provider_reason TEXT;
ALTER TABLE whatsapp_message_templates ADD COLUMN provider_status_update_event TEXT;
ALTER TABLE whatsapp_message_templates ADD COLUMN provider_quality_rating TEXT;
ALTER TABLE whatsapp_message_templates ADD COLUMN provider_raw_payload_json TEXT;
ALTER TABLE whatsapp_message_templates ADD COLUMN provider_submitted_at TIMESTAMP;
ALTER TABLE whatsapp_message_templates ADD COLUMN provider_synced_at TIMESTAMP;
ALTER TABLE whatsapp_message_templates ADD COLUMN meta_header_handle TEXT;

ALTER TABLE whatsapp_api_templates ADD COLUMN provider_template_id TEXT;
ALTER TABLE whatsapp_api_templates ADD COLUMN provider TEXT DEFAULT 'ycloud';
ALTER TABLE whatsapp_api_templates ADD COLUMN source_adapter TEXT DEFAULT 'ycloud';
ALTER TABLE whatsapp_api_templates ADD COLUMN provider_create_time TIMESTAMP;
ALTER TABLE whatsapp_api_templates ADD COLUMN provider_update_time TIMESTAMP;

UPDATE whatsapp_message_templates
SET template_provider = COALESCE(NULLIF(template_provider, ''), 'ycloud'),
    provider_template_name = COALESCE(provider_template_name, ycloud_template_name),
    provider_template_id = COALESCE(provider_template_id, ycloud_template_id),
    provider_status = COALESCE(provider_status, ycloud_status),
    provider_reason = COALESCE(provider_reason, ycloud_reason),
    provider_status_update_event = COALESCE(provider_status_update_event, ycloud_status_update_event),
    provider_quality_rating = COALESCE(provider_quality_rating, ycloud_quality_rating),
    provider_raw_payload_json = COALESCE(provider_raw_payload_json, ycloud_raw_payload_json),
    provider_submitted_at = COALESCE(provider_submitted_at, ycloud_submitted_at),
    provider_synced_at = COALESCE(provider_synced_at, ycloud_synced_at)
WHERE COALESCE(ycloud_template_id, ycloud_template_name, ycloud_status) IS NOT NULL;

UPDATE whatsapp_api_templates
SET provider = COALESCE(NULLIF(provider, ''), 'ycloud'),
    source_adapter = COALESCE(NULLIF(source_adapter, ''), 'ycloud'),
    provider_template_id = COALESCE(provider_template_id, official_template_id, id),
    provider_create_time = COALESCE(provider_create_time, ycloud_create_time),
    provider_update_time = COALESCE(provider_update_time, ycloud_update_time);

CREATE INDEX IF NOT EXISTS idx_whatsapp_message_templates_provider ON whatsapp_message_templates(template_provider, provider_status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_message_templates_provider_id ON whatsapp_message_templates(template_provider, provider_template_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_api_templates_provider ON whatsapp_api_templates(provider, status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_api_templates_provider_id ON whatsapp_api_templates(provider, provider_template_id);
