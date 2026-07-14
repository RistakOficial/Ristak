CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_automations_search_document_trgm
  ON automations USING GIN ((
    LOWER(
      COALESCE(id, '') || ' ' ||
      COALESCE(name, '') || ' ' ||
      COALESCE(description, '')
    )
  ) gin_trgm_ops);
