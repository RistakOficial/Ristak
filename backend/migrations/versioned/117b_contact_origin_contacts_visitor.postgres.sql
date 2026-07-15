-- Aislado porque el runner exige un solo DDL concurrente por archivo. Esta
-- llave evita barrer contacts cuando cambia una sesión visitor-only.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_origin_contacts_visitor_lookup
  ON contacts(visitor_id)
  WHERE visitor_id IS NOT NULL AND visitor_id != '';
