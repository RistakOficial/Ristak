CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_list_status_next
  ON subscriptions(status, next_run_at, updated_at DESC, id DESC);
