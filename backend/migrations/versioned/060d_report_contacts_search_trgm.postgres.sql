CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_report_contacts_search_trgm
  ON contacts USING GIN ((
    LOWER(
      COALESCE(full_name, '') || ' ' ||
      COALESCE(email, '') || ' ' ||
      COALESCE(phone, '') || ' ' ||
      id
    )
  ) gin_trgm_ops)
  WHERE deleted_at IS NULL;
