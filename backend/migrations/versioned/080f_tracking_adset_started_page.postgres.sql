CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_adset_started_page
  ON sessions(adset_id, started_at DESC, id DESC);
