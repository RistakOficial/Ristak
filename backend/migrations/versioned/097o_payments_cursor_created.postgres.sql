CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_list_activity_created
  ON payment_list_activity(created_sort, payment_id);
