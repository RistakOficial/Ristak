CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_site_page_flow_started
  ON sessions(site_id, page_flow_revision, started_at);
