CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_site_flow_events_form_revision_time
  ON site_flow_events(form_site_id, flow_revision, event_name, event_at, attempt_id);
