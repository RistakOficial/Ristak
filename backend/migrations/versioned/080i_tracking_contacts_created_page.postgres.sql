CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_created_at_id
  ON contacts(created_at DESC, id DESC);
