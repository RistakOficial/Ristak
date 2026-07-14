CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_automations_updated_page
  ON automations((COALESCE(updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00')) DESC, id DESC);
