CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tracking_analytics_range_query
  ON tracking_analytics_range_delta(start_boundary, occurrence_date, entity_type)
  INCLUDE (range_delta);
