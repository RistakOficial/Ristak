CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_cursor_created
  ON contacts(created_at, id)
  WHERE deleted_at IS NULL;
