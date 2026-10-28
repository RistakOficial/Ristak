-- Intentionally independent of contacts: deleting/restoring a CRM row must not
-- remove an identity's block. No fuzzy names, suffixes or automatic aliases.
CREATE TABLE IF NOT EXISTS contact_blocks (
  id TEXT PRIMARY KEY,
  identity_type TEXT NOT NULL CHECK (identity_type IN ('contact', 'email', 'phone')),
  identity_value TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (identity_type, identity_value)
);
