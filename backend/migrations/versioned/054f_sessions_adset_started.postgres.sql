CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_adset_started
  ON sessions(adset_id, started_at);
