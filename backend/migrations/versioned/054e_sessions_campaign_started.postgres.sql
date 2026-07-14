CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_campaign_started
  ON sessions(campaign_id, started_at);
