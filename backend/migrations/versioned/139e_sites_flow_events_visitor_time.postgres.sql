CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_site_flow_events_visitor_time
  ON site_flow_events(visitor_id, event_at, attempt_id);
