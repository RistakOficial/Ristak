CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_list_activity_status
  ON payment_list_activity(status_sort, created_sort, payment_id);
