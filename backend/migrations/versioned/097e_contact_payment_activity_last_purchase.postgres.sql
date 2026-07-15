CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_list_activity_last_purchase
  ON contact_list_activity(last_purchase_sort, contact_id);
