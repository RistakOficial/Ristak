CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_list_activity_provider
  ON payment_list_activity(provider_sort, created_sort, payment_id);
