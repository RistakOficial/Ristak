CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_source_whatsapp_first
  ON whatsapp_attribution(contact_id, created_at, id);
