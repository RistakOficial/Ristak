CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_ad_started_page
  ON sessions(ad_id, started_at DESC, id DESC);
