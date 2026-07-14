CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tracking_visitor_latest_visitor
  ON tracking_visitor_latest(visitor_key);
