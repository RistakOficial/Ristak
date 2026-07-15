CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_list_activity_total
  ON contact_list_activity(total_paid, contact_id);
