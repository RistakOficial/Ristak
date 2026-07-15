CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_list_activity_purchases
  ON contact_list_activity(purchases_count, contact_id);
