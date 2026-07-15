CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_list_activity_failed
  ON contact_list_activity(failed_payments_count, contact_id);
