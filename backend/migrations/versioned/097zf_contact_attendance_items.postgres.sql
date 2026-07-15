CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_attendance_items_contact
  ON contact_attendance_activity_items(contact_id, signal_id);
