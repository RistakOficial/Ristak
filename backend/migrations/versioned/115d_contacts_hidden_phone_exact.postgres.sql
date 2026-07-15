CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_hidden_phone_exact
  ON contacts(LOWER(COALESCE(phone, ''))) INCLUDE (id);
