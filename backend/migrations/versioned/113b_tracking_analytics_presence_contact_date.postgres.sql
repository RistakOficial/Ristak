CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tracking_analytics_presence_contact_date
  ON tracking_analytics_presence(contact_key, business_date)
  INCLUDE (visitor_key, session_key, dimension_key, event_count, view_count)
  WHERE contact_key <> '' AND event_count > 0;
