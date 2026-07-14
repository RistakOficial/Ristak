CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_campaign_started_page
  ON sessions(campaign_id, started_at DESC, id DESC);
