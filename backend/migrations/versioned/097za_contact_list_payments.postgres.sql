CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_list_activity_payments
  ON contact_list_activity(payments_count, contact_id);
