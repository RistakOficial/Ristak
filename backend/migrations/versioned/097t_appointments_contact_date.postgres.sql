CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_appointment_items_contact_date
  ON contact_appointment_activity_items(contact_id, appointment_sort DESC, appointment_id DESC);
