CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_site_flow_events_created_at
  ON site_flow_events(created_at, event_at, id);
