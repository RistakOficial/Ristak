CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_cursor_phone
  ON contacts(COALESCE(phone, ''), id)
  WHERE deleted_at IS NULL;
