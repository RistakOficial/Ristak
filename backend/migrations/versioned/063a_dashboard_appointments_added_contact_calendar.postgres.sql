CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dashboard_appointments_added_contact_calendar
  ON appointments(date_added, contact_id, calendar_id);
