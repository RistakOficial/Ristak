CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_cursor_updated
  ON contacts(updated_at, id)
  WHERE deleted_at IS NULL;
