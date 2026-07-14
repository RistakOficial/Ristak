CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_automations_status_updated_page
  ON automations(status, (COALESCE(updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00')) DESC, id DESC);
