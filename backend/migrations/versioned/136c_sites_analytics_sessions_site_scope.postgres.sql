CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_site_tracking_started
  ON sessions(site_id, tracking_source, event_name, started_at);
