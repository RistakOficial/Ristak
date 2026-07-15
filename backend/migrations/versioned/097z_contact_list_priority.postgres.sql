CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_list_activity_priority
  ON contact_list_activity(priority, contact_id);
