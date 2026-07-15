-- Aislado porque el runner exige un solo DDL concurrente por archivo. Conserva
-- la semántica case-insensitive de atribución sin bloquear writes en deploy.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_origin_contacts_email_lookup
  ON contacts(LOWER(email))
  WHERE email IS NOT NULL AND email != '';
