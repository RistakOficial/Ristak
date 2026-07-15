CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_hidden_id_exact
  ON contacts(LOWER(id)) INCLUDE (id);
