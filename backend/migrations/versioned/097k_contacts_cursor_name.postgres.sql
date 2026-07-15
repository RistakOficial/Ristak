CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_cursor_name
  ON contacts(LOWER(COALESCE(full_name, '')), id)
  WHERE deleted_at IS NULL;
