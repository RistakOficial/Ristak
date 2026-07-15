CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_list_activity_attended_appointments
  ON contact_list_activity(attended_appointments_count, contact_id);
