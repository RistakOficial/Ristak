CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_report_appointments_contact_added
  ON appointments(contact_id, date_added DESC, calendar_id);
