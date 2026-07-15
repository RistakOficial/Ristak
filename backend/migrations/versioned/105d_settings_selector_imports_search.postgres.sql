CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_public_site_imports_form_catalog_search
  ON public_site_imports USING GIN ((
    LOWER(
      COALESCE(id, '') || ' ' ||
      COALESCE(site_id, '') || ' ' ||
      COALESCE(form_mappings_json, '')
    )
  ) gin_trgm_ops);
