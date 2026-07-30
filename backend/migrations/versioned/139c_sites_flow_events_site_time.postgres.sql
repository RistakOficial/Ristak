CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_site_flow_events_site_time
  ON site_flow_events(site_id, event_at, event_name, attempt_id);
