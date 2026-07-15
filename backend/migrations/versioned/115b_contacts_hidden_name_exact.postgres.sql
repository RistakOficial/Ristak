CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_hidden_full_name_exact
  ON contacts(LOWER(COALESCE(full_name, ''))) INCLUDE (id);
