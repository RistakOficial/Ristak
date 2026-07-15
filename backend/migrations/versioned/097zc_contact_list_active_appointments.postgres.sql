CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_list_activity_active_appointments
  ON contact_list_activity(active_appointments_count, contact_id);
