CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tracking_contacts_search_document_trgm
  ON contacts USING GIN ((
    LOWER(
      COALESCE(full_name, '') || ' ' ||
      COALESCE(email, '') || ' ' ||
      COALESCE(phone, '') || ' ' ||
      id
    )
  ) gin_trgm_ops);
