CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_list_activity_title
  ON payment_list_activity(title_sort, created_sort, payment_id);
