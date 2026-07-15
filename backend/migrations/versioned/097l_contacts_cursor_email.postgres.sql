CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_cursor_email
  ON contacts(LOWER(COALESCE(email, '')), id)
  WHERE deleted_at IS NULL;
