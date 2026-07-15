CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_whatsapp_routing_events_contact_latest_v2
  ON whatsapp_routing_events(contact_id, created_at DESC, id DESC);
