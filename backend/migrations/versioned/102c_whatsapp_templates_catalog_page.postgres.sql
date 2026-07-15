CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_whatsapp_api_templates_catalog_page
  ON whatsapp_api_templates(status, updated_at DESC, id DESC);
