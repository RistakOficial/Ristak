CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_list_activity_method
  ON payment_list_activity(method_sort, created_sort, payment_id);
