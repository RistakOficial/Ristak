CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_ad_started
  ON sessions(ad_id, started_at);
