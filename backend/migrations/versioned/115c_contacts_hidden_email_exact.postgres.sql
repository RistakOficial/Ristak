CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_hidden_email_exact
  ON contacts(LOWER(COALESCE(email, ''))) INCLUDE (id);
