CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_list_activity_appointments
  ON contact_list_activity(appointments_count, contact_id);
