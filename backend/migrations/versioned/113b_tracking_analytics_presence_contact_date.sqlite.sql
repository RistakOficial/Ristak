CREATE INDEX IF NOT EXISTS idx_tracking_analytics_presence_contact_date
  ON tracking_analytics_presence(contact_key, business_date)
  WHERE contact_key != '' AND event_count > 0;
