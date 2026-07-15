CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_cursor_effective_created_at_id
  ON contacts(
    (COALESCE(created_at, '1970-01-01 00:00:00+00')) DESC,
    id DESC
  );
