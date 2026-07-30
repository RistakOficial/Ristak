CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_site_flow_events_attempt_order
  ON site_flow_events(attempt_id, event_sequence, event_at, id);
