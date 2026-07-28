CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_form_tracking_started
  ON sessions(form_site_id, tracking_source, event_name, started_at);
