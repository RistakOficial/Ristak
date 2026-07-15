CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_list_activity_date
  ON payment_list_activity(date_sort, created_sort, payment_id);
