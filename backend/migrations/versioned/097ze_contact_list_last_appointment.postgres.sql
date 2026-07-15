CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_list_activity_last_appointment
  ON contact_list_activity(last_appointment_sort, contact_id);
