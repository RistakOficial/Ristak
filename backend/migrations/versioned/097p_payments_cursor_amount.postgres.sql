CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_list_activity_amount
  ON payment_list_activity(amount_sort, created_sort, payment_id);
